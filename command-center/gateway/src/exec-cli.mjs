// Forge Command Center gateway — exec-bridge CLI resolution + env allowlist
// (refactor-gateway-split, forge-2026-07-30-cc-finish). Split out of the single exec-bridge.mjs (had
// grown to ~754 lines, over this project's own 500-line-per-file guidance) into its own real seam:
// resolving/validating the real `claude` CLI path and the allowlisted env a spawned child actually
// receives. Every name below is re-exported from exec-bridge.mjs under its EXACT original name — see
// that file's own header for the full architecture/history/honesty rules this slice still follows;
// no other file in the codebase needed to change a single import.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

let claudePathResolved = false;
let claudePathCache = null;

// Codex F2 hardening: a resolved `claude` candidate must be an ABSOLUTE path, must survive
// `fs.realpathSync` (resolving symlinks — a symlink pointing back into cwd is caught too), and must
// NOT live under this process's own current working directory. A `where`/`which` lookup can be
// fooled by a same-named file sitting in cwd on some PATH configurations (cwd-relative or
// cwd-adjacent entries are a classic PATH-shadowing trick); such a candidate is never trusted, even
// if it is the only one found. Returns the resolved real path, or null if the candidate fails any of
// these checks (never throws).
function resolveAndValidate(candidate) {
  if (!candidate || !path.isAbsolute(candidate)) return null; // a bare relative path is never trusted
  let real;
  try { real = fs.realpathSync(candidate); }
  catch { return null; } // unreadable/nonexistent — an absent CLI stays a truthful null, never thrown
  let cwdReal;
  try { cwdReal = fs.realpathSync(process.cwd()); }
  catch { cwdReal = process.cwd(); }
  if (real === cwdReal || real.startsWith(cwdReal + path.sep)) return null; // reject anything under cwd
  return real;
}

// Resolves the real `claude` CLI path once (via `where`/`which`, per the work package), caching it
// for the process lifetime. In mock mode (CC_EXEC_MOCK=1, used by every automated test) this
// resolves to the current Node binary instead — no real `claude` invocation ever happens in a
// test run. An explicit, absolute CC_CLAUDE_CLI_PATH override always wins over PATH-based discovery
// (Codex F2) — useful when a sandboxed/CI environment's PATH cannot be trusted, or to pin one
// specific installed CLI. Every discovered/overridden candidate is passed through
// resolveAndValidate() before being trusted.
export function resolveClaudeCliPath() {
  if (claudePathResolved) return claudePathCache;
  claudePathResolved = true;
  if (process.env.CC_EXEC_MOCK === '1') {
    claudePathCache = process.execPath;
    return claudePathCache;
  }
  const override = process.env.CC_CLAUDE_CLI_PATH;
  if (override && override.trim()) {
    claudePathCache = resolveAndValidate(override.trim());
    return claudePathCache;
  }
  try {
    const lookupCmd = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(lookupCmd, ['claude'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const candidates = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    claudePathCache = candidates.map(resolveAndValidate).find((p) => p !== null) ?? null;
  } catch {
    claudePathCache = null; // absent CLI is a truthful, expected outcome — never thrown
  }
  return claudePathCache;
}

// feat-subagent-visibility: the resolved CLI's OWN `--help` text, read at most once per gateway
// process and cached for its lifetime. This is the ONLY honest way to know whether an optional
// stream flag (e.g. `--forward-subagent-text`, `--include-hook-events`) exists on the `claude`
// binary this machine actually has — an older CLI handed an unknown flag exits with a usage error
// instead of running the turn, so the gateway must never assume support it has not verified.
//
// Never throws and never blocks a real turn on a broken lookup: an unresolvable CLI, a spawn
// failure, or a timeout all degrade to `null` ("help unknown"), which every caller must read as
// "do not add the optional flag". Mock mode short-circuits entirely — the mock child is a node
// script, not the CLI, so running `node --help` would be a meaningless (and slow) subprocess in
// every test run.
const HELP_TIMEOUT_MS = 10000;
const HELP_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
let cliHelpResolved = false;
let cliHelpCache = null;
let cliHelpOverrideActive = false;
let cliHelpOverride = null;

export function claudeCliHelpText() {
  if (cliHelpOverrideActive) return cliHelpOverride;
  if (cliHelpResolved) return cliHelpCache;
  cliHelpResolved = true;
  if (process.env.CC_EXEC_MOCK === '1') {
    cliHelpCache = null;
    return cliHelpCache;
  }
  const cli = resolveClaudeCliPath();
  if (!cli) {
    cliHelpCache = null;
    return cliHelpCache;
  }
  try {
    cliHelpCache = execFileSync(cli, ['--help'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: HELP_TIMEOUT_MS,
      maxBuffer: HELP_MAX_BUFFER_BYTES,
    });
  } catch (err) {
    // A CLI that prints its help to stderr and/or exits non-zero still produced REAL help text —
    // use whatever genuinely came back rather than throwing away a usable answer.
    const captured = err && (typeof err.stdout === 'string' ? err.stdout : null);
    const capturedErr = err && (typeof err.stderr === 'string' ? err.stderr : null);
    const text = (captured && captured.length > 0 ? captured : null) || (capturedErr && capturedErr.length > 0 ? capturedErr : null);
    cliHelpCache = text;
  }
  return cliHelpCache;
}

/** True only when the resolved CLI's own `--help` genuinely documents `flag`. Unknown help text
 *  (unresolvable CLI, failed lookup, mock mode) is a truthful `false`, never an optimistic guess. */
export function claudeCliSupportsFlag(flag) {
  const help = claudeCliHelpText();
  if (typeof help !== 'string' || help.length === 0) return false;
  return help.includes(flag);
}

/** Test-only seam (mirrors `_setAskMcpConfigDirForTests`'s own convention in exec-argv.mjs): inject
 *  the exact help text a hypothetical CLI would print — including `null` for "help unreadable" —
 *  so flag detection can be proven for BOTH a supporting and an older CLI without ever invoking a
 *  real `claude` binary in a test run. */
export function _setClaudeCliHelpTextForTests(text) {
  cliHelpOverrideActive = true;
  cliHelpOverride = typeof text === 'string' ? text : null;
}

export function _resetClaudeCliHelpForTests() {
  cliHelpOverrideActive = false;
  cliHelpOverride = null;
  cliHelpResolved = false;
  cliHelpCache = null;
}

// The composer's honest capability state (D2 amendment 3 fallback path): AVAILABLE when a real
// `claude` binary was resolved (or mock mode is on), else the composer ships in observer mode.
export function executionAvailability() {
  if (process.env.CC_EXEC_MOCK === '1') {
    return { available: true, note: 'mock execution mode (CC_EXEC_MOCK=1) — no real claude CLI is invoked' };
  }
  const p = resolveClaudeCliPath();
  if (p) return { available: true, note: 'resolved claude CLI at ' + p };
  return { available: false, note: 'claude CLI not found on PATH — composer ships in observer mode (message stored, not executed)' };
}

// Codex F1 hardening: an ALLOWLIST of the env var NAMES the spawned `claude` child actually needs to
// run correctly, replacing the old `/key|token/i` denylist (a denylist can only ever block names the
// author thought of — e.g. it never covered PASSWORD/DB_URL/*_SECRET/*_DSN/cloud-credential vars,
// every one of which would previously have been forwarded verbatim to the child). Verified against
// this file's own mock-mode E2E test (a real spawned child, real stdout round-trip) — the mock spawn
// still starts and completes correctly with ONLY this allowlisted env, so the stronger allowlist is
// used instead of a merely-widened denylist.
const ALLOWED_ENV_EXACT = new Set([
  'path', 'systemroot', 'temp', 'tmp', 'userprofile', 'appdata', 'localappdata',
  'home', 'comspec', 'pathext', 'number_of_processors', 'os', 'windir',
  'homedrive', 'homepath', 'lang', 'lc_all', 'shell', 'term',
]);
// Prefix matches: PROGRAMFILES/PROGRAMFILES(X86)/PROGRAMW6432, every CLAUDE_* var, and every CC_*
// var — this project's OWN configuration surface for the child (e.g. CC_EXEC_MOCK/
// CC_EXEC_MOCK_DELAY_MS, read by the mock child script in `exec-argv.mjs` and required for the
// concurrency/stop-execution tests in `test/exec-bridge.test.mjs` to behave deterministically).
const ALLOWED_ENV_PREFIXES = ['programfiles', 'claude_', 'cc_'];
// Exported so a direct unit test can assert exactly which names pass through, without needing to
// spawn a real child and inspect its environment indirectly.
export function filteredEnv() {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    const lower = k.toLowerCase();
    const allowed = ALLOWED_ENV_EXACT.has(lower) || ALLOWED_ENV_PREFIXES.some((p) => lower.startsWith(p));
    if (allowed) out[k] = v;
  }
  return out;
}

// Test-only glue (refactor-gateway-split): lets exec-lifecycle.mjs's own _resetExecBridgeForTests
// reset this module's cached CLI-resolution state across test files, without reaching into this
// module's private `claudePathResolved`/`claudePathCache` variables directly. Not part of the
// original exec-bridge.mjs public export list — a new, purely mechanical seam this split requires,
// with no behavior change of its own.
export function _resetClaudeCliResolutionForTests() {
  claudePathResolved = false;
  claudePathCache = null;
  // The cached `--help` text is derived from whichever CLI path was resolved, so it must be
  // invalidated with it — otherwise a test that swaps the CLI would keep the previous binary's
  // capability answer.
  cliHelpResolved = false;
  cliHelpCache = null;
}
