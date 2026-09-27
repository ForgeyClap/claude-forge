// POST /api/config?project=<name> (WP-A, v2.9.0): the dashboard's own real Forge-settings write
// route — "we also want to be able to change the config in the dashboard" (owner, Dutch). Body:
// { action: 'set'|'unset', key, value? }. Validated by server.mjs's own body.mjs allowlist first
// (unknown fields / missing action|key -> 400 before this module ever runs), then EVERY semantic
// check lives here — same "server.mjs stays thin, the module owns its own domain validation" split
// as agents-write.mjs's patchAgentModel.
//
// SETTINGS, NEVER CODE (same rule as config.mjs's read path): this always spawns the CENTRAL
// forge-config.cjs (forgeConfigCjsPath(), config.mjs — one override seam covers both the read probe
// and this write, so a test's _setForgeConfigCjsForTests() redirects both at once), never the
// selected project's own copy, with FORGE_PROJECT_ROOT pointed at the selection. The real
// set()/unset() in forge-config.cjs — atomic write, its own file lock, its own schema/value
// validation — does the actual write; this module never touches .claude/FORGE_CONFIG.json itself
// (the D2 write boundary in paths.mjs stays true: the gateway's OWN writes stay under
// command-center/.data/, here just the audit line below).
//
// GATE-HOOK, NEVER FROM HERE: the exec token (security.mjs) is readable by any local process on
// this machine, so it cannot be the thing standing between "the dashboard" and "an agent turning
// off its own safety net". A `set gate-hook <anything that is not a recognised ON word>` is refused
// BEFORE anything is ever spawned — see isGateHookTrueValue()'s own comment for why this is an
// ALLOWLIST, not a list of known-off spellings. `set gate-hook on/aan/true/...` is allowed through
// unchanged.
//
// Codex finding K3-1: `unset gate-hook` used to be allowed straight through on the theory that
// "unset restores the default, which is ON". That is only true when NO layer below the removed one
// already carries an explicit `off` — forge-config.cjs resolves project-then-global-then-default,
// so a project-level `on` merely MASKING a machine-wide (global) `off` means `unset` (which only
// ever removes the PROJECT-level entry) reveals that hidden `off`, handing the dashboard the exact
// bypass the `set` refusal above exists to prevent. There is no cheap way to prove "no lower layer
// is off" from here without re-implementing forge-config.cjs's own resolution order, so `unset` on
// this one key is refused outright, unconditionally, every time — same plain, bilingual message
// shape as the `set` refusal, pointing the owner at the one place this can still be done for real.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { redact, redactDeep } from './redact.mjs';
import { filteredEnv } from './exec-cli.mjs';
import { PROJECT_ROOT, COMMAND_CENTER_DATA_DIR } from './paths.mjs';
import { forgeConfigCjsPath, invalidateForgeConfigCache, buildForgeConfig } from './config.mjs';

const execFileAsync = promisify(execFile);
const WRITE_TIMEOUT_MS = 5000;
const MAX_BUFFER_BYTES = 1 * 1024 * 1024;
const AUDIT_LOG_FILE = path.join(COMMAND_CENTER_DATA_DIR, 'config-edits.jsonl');

// Test-only override seam (mirrors agents-write.mjs's _setAuditLogFileForTests convention) — a test
// exercising a real successful write must never append to this gateway's own real
// .data/config-edits.jsonl.
let auditLogFileOverride = null;
export function _setConfigAuditLogFileForTests(filePath) { auditLogFileOverride = filePath; }
export function _resetConfigAuditLogFileForTests() { auditLogFileOverride = null; }
function activeAuditLogFile() { return auditLogFileOverride || AUDIT_LOG_FILE; }

const GATE_HOOK_KEY = 'gate-hook';
// Mirrors this project's own schema value_synonyms.true (config/orchestration/FORGE_CONFIG_SCHEMA.json,
// the single source of truth forge-config.cjs's real parseValue() reads) — kept as a literal copy
// here rather than a require() of that CJS schema, since this is only a pre-flight REFUSAL filter,
// never a second implementation of resolution/validation (forge-config.cjs itself still validates
// the value for real once spawned). An ALLOWLIST, not a denylist of known-off spellings (lesson
// wp-r2 F6: a reject-list falls through to the strongest verdict on anything it did not anticipate)
// — every value NOT in this list is refused for gate-hook specifically, which also closes the gap a
// denylist of just "off/false/0/no/uit/nee" would leave open ("disabled"/"disable" are ALSO real
// false-synonyms forge-config.cjs itself accepts).
const GATE_HOOK_TRUE_WORDS = new Set(['on', 'aan', 'true', 'yes', 'ja', '1', 'enabled', 'enable']);

function isGateHookTrueValue(raw) {
  return GATE_HOOK_TRUE_WORDS.has(String(raw ?? '').trim().toLowerCase());
}

function fail(status, error) {
  return { status, body: { ok: false, error } };
}

// With --json the CLI prints `{ ok:false, error:{code,message,suggestion} }` on stdout before a
// non-zero exit — same parsing shape as config.mjs's own failureReason(), kept as its own small
// helper here (the two call sites want different fallback behavior on a parse failure).
function parseCliJson(stdout) {
  try {
    const body = JSON.parse(String(stdout || ''));
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

// Maps a failed spawn to an HTTP status. `lock_busy` (a concurrent writer already holds the target
// file's lock) always wins regardless of the numeric exit code, since forge-config.cjs's own CLI
// reports it as a plain, non-ConfigError exit 2 — see forge-config-once.cjs's acquireLock(). Exit 1
// is "not found" (get/explain only, kept here for completeness since this route only calls
// set/unset). An exit code this route has never documented never defaults to success.
function statusForExit(nodeExitCode, cliErrorCode) {
  if (cliErrorCode === 'lock_busy') return 503;
  if (nodeExitCode === 3) return 409;
  if (nodeExitCode === 1 || nodeExitCode === 2) return 400;
  return 502;
}

/**
 * writeForgeConfig({ projectPath, projectName, action, key, value }) -> { status, body }
 *
 * `action` must be 'set' or 'unset'; `key` a non-empty string; for 'set', `value` a string, number
 * or boolean (never object/array/null — forge-config.cjs's own CLI only ever receives argv strings,
 * so this becomes String(value) on the spawned command line). Every validation failure returns a
 * real { status, body:{ok:false,error} } — nothing is ever spawned on a rejected request.
 */
export async function writeForgeConfig({ projectPath, projectName, action, key, value }) {
  if (action !== 'set' && action !== 'unset') {
    return fail(400, 'action must be "set" or "unset"');
  }
  if (typeof key !== 'string' || key.length === 0) {
    return fail(400, 'key must be a non-empty string');
  }
  if (action === 'set') {
    if (value === undefined) return fail(400, 'value is required when action is "set"');
    if (value === null || !['string', 'number', 'boolean'].includes(typeof value)) {
      return fail(400, 'value must be a string, number or boolean');
    }
  }

  // The one refusal that must happen before ANYTHING is ever spawned — see this module's header.
  if (key === GATE_HOOK_KEY && action === 'set' && !isGateHookTrueValue(value)) {
    return fail(403, 'gate-hook cannot be turned off from the dashboard for your own safety. ' +
      'To turn it off yourself, type: node .claude/forge-bin/forge-config.cjs set gate-hook off ' +
      '(or run that same line with ! in Claude Code).');
  }
  // K3-1: see this module's header — unset could reveal a hidden lower-layer "off" this route can
  // never safely rule out from here, so it is refused unconditionally, not just when a value looks
  // like "off" (there is no value on an unset request to inspect in the first place).
  if (key === GATE_HOOK_KEY && action === 'unset') {
    return fail(403, 'gate-hook cannot be reset from the dashboard for your own safety — a reset ' +
      'can uncover an "off" set somewhere else. / gate-hook kan niet vanuit het dashboard worden ' +
      'teruggezet voor je eigen veiligheid — dat kan een "off" ergens anders zichtbaar maken. ' +
      'To turn it off yourself, type: node .claude/forge-bin/forge-config.cjs set gate-hook off ' +
      '(or run that same line with ! in Claude Code).');
  }

  // K3-2: `.claude` must genuinely be INSIDE this project's own real directory tree — a Windows
  // junction (or a symlink anywhere else) pointed at a DIFFERENT project's `.claude` would pass a
  // plain fs.statSync() check (it only asks "is there a directory here"), then hand that other
  // project's real settings file to forge-config.cjs's write, landing the change in the wrong
  // project entirely. realpathSync.native resolves every symlink/junction in both paths to their
  // real, canonical target before the containment check, so a junction pointed elsewhere is caught
  // here instead of silently followed. Both paths are canonicalized with the SAME function so the
  // comparison is never fooled by case/short-name/8.3 differences on Windows either.
  let claudeDirExists = false;
  let realProjectPath = projectPath;
  try {
    realProjectPath = fs.realpathSync.native(projectPath);
    const realClaudeDir = fs.realpathSync.native(path.join(projectPath, '.claude'));
    const relative = path.relative(realProjectPath, realClaudeDir);
    const isInside = relative === '' ? false : !relative.startsWith('..') && !path.isAbsolute(relative);
    if (!isInside) {
      return fail(400, 'this project\'s .claude/ folder points outside the project itself — refusing ' +
        'to write there for your safety. / de .claude-map van dit project wijst buiten het project ' +
        'zelf — daar wordt voor je veiligheid niet naar geschreven.');
    }
    claudeDirExists = fs.statSync(realClaudeDir).isDirectory();
  } catch {
    claudeDirExists = false;
  }
  if (!claudeDirExists) return fail(400, 'this project has no .claude/ folder — there are no Forge settings to change');

  const scriptPath = forgeConfigCjsPath();
  if (!fs.existsSync(scriptPath)) return fail(502, 'the central forge-config.cjs was not found');

  const args = [scriptPath, action, key];
  if (action === 'set') args.push(String(value));
  args.push('--json', '--lang', 'en');

  let stdout;
  try {
    const r = await execFileAsync(process.execPath, args, {
      cwd: PROJECT_ROOT,
      // K3-2: the CANONICAL root (junction/symlink resolved above), never the raw selection — the
      // child must write inside the real, verified tree, not wherever an unresolved path happens to
      // point.
      env: { ...filteredEnv({ credentialFree: true }), FORGE_PROJECT_ROOT: realProjectPath, FORGE_CONFIG_SET_BY: 'dashboard' },
      timeout: WRITE_TIMEOUT_MS, windowsHide: true, encoding: 'utf8', maxBuffer: MAX_BUFFER_BYTES,
    });
    stdout = r.stdout;
  } catch (err) {
    if (err && err.killed) return fail(504, 'forge-config.cjs ' + action + ' timed out after ' + WRITE_TIMEOUT_MS + 'ms');
    const parsed = parseCliJson(err && err.stdout);
    const cliErrorCode = parsed && parsed.error && typeof parsed.error.code === 'string' ? parsed.error.code : null;
    const nodeExitCode = typeof (err && err.code) === 'number' ? err.code : null;
    const message = parsed && parsed.error && typeof parsed.error.message === 'string'
      ? redact(parsed.error.message)
      : redact(err && err.message ? err.message : String(err));
    return fail(statusForExit(nodeExitCode, cliErrorCode), message);
  }

  const parsed = parseCliJson(stdout);
  if (!parsed) return fail(502, 'forge-config.cjs ' + action + ' returned output that is not JSON');
  const change = redactDeep(parsed);

  // A fresh read replaces the now-stale cache immediately — the response carries the settings the
  // dashboard would see on its very next poll, not the value it merely asked for (never
  // optimistic-only, same rule agents-write.mjs's patchAgentModel follows for its own PATCH route).
  invalidateForgeConfigCache(projectPath);
  const fresh = await buildForgeConfig(projectPath);
  const { _capturedAtMs, ...freshConfig } = fresh;

  // Best-effort audit trail under this gateway's own command-center/.data/ (D2 write boundary —
  // never .claude/). A failure here never undoes or fails the already-successful config change.
  const auditedValue = action === 'set'
    ? (change && change.to !== undefined ? change.to : value)
    : (change && change.entry && change.entry.value !== undefined ? change.entry.value : null);
  let auditLogged = true;
  try {
    const targetAuditFile = activeAuditLogFile();
    fs.mkdirSync(path.dirname(targetAuditFile), { recursive: true });
    const auditLine = {
      event_type: 'config_changed',
      timestamp: new Date().toISOString(),
      project: projectName ?? null,
      action,
      key,
      value: auditedValue,
    };
    fs.appendFileSync(targetAuditFile, JSON.stringify(auditLine) + '\n', 'utf8');
  } catch {
    auditLogged = false;
  }

  return {
    status: 200,
    body: { ok: true, project: projectName ?? null, action, key, change, audit_logged: auditLogged, config: freshConfig },
  };
}
