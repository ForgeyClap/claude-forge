// Forge Command Center gateway — Discord bot supervisor (WP-D1 feat-discord-gateway).
//
// The gateway is this project's single spawn-root (root CLAUDE.md, "Dashboard + event logs"): the
// imported bot (`command-center/discord/src/main.js`, source-only import — see
// command-center/discord/README.md for its own history) is supervised here exactly like any other
// real child process. Its own `src/bot-manager.js` mini-dashboard (MANAGER_PORT) becomes REDUNDANT
// once this module owns start/stop/status — it is never run.
//
// CONFLICT SAFETY: before ever spawning, this module probes the bot's OWN health endpoint
// (http://127.0.0.1:<BOT_HTTP_PORT>/api/health) — the exact same pre-flight check
// command-center/discord/src/main.js already runs against itself before connecting. If anything
// already answers there (e.g. the owner's separately-run LIVE instance), start() REFUSES with an
// honest 409 naming the port — this gateway never starts a second bot on the same real Discord
// token. Same "fast-stop rather than fight over a resource" shape as supervisor.mjs's own
// EADDRINUSE handling.
//
// KILL DISCIPLINE: stop() kills ONLY the exact child PID this module itself spawned and tracked —
// same taskkill(win32)/process-group(POSIX) tree-kill shape as exec-lifecycle.mjs's own
// killChildTree(), never a name/pattern-based kill (root CLAUDE.md HARD MUST).
import { spawn, execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DISCORD_DIR, DISCORD_MAIN_JS, DISCORD_ENV_FILE, DISCORD_ENV_EXAMPLE_FILE,
  DISCORD_STATE_DIR, DISCORD_LOG_FILE,
  isNetworkOrDevicePath, hasControlChars, safeRealpathSync,
} from './paths.mjs';
import { redact, redactDeep, createStreamRedactor, DISCORD_BOT_TOKEN_CORE_SOURCE } from './redact.mjs';

const DEFAULT_BOT_HTTP_PORT = 3979;
const HEALTH_PROBE_TIMEOUT_MS = 1500;
const SHUTDOWN_HTTP_TIMEOUT_MS = 2000;
const GRACEFUL_SHUTDOWN_WAIT_MS = 500;

// WP-v290-B (beginner onboarding, B1): a real Discord bot token is three dot-separated
// base64url-ish parts — this is a FORMAT check only (never contacts Discord; that only happens
// once the bot itself tries to log in), so an honest 400 can be returned before anything is ever
// written to disk. Bounded length so a pathological paste can never build an absurd .env line.
//
// Codex finding K3-4: built from the SAME source string redact.mjs's own DISCORD_BOT_TOKEN pattern
// uses (anchored here to validate one whole, standalone value; unanchored-except-for-a-leading-\b
// there, to scan free text) — the two used to be two independently maintained regexes that had
// already drifted apart (this one accepted 10/3/10-char segments, the redactor required 20/4/20),
// which meant a token this validator happily accepted on the way in was not always recognised by
// the redactor on the way out.
const BOT_TOKEN_RE = new RegExp('^' + DISCORD_BOT_TOKEN_CORE_SOURCE + '$');

export function isValidBotTokenFormat(token) {
  return typeof token === 'string' && token.length > 0 && token.length <= 200 && BOT_TOKEN_RE.test(token);
}

// Discord snowflake IDs (guilds/users/channels) are ASCII digits only, bounded length.
const SNOWFLAKE_RE = /^\d{5,25}$/;

export function isValidSnowflake(id) {
  return typeof id === 'string' && SNOWFLAKE_RE.test(id);
}

// Codex run B F-03 (2026-09-28): a value written via the JSON-quoted form below (needsEnvQuoting/
// encodeEnvValue) round-trips back to its EXACT original text — including one that contains a
// literal newline — instead of that newline being read as the start of a brand-new `KEY=...` line.
// A value that does NOT start-and-end with `"` (every value ever written before this fix, and
// every ordinary value written after it — see encodeEnvValue's own comment) is returned exactly as
// before: unmodified, bare text. A value that merely LOOKS quoted but is not valid JSON (e.g. a
// human hand-typed `"C:\Users\me\My Projects"`, which uses single backslashes, not JSON's `\\`)
// falls back to the literal raw text, quotes included — identical to this parser's behaviour
// before this fix, never a new failure mode for an existing hand-edited .env.
function decodeEnvValue(raw) {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'string') return parsed;
    } catch {
      // Not valid JSON after all -- fall through and treat it as a literal bare value.
    }
  }
  return raw;
}

// Minimal, read-only .env parser — mirrors command-center/discord/src/config.js's own
// parseEnvFile() shape (KEY=VALUE, '#'-comments, blank lines skipped) closely enough to read the
// same file correctly. Deliberately NOT importing the bot's own module graph into the gateway —
// the two stay black-box supervised, never entangled beyond spawn/health/kill.
function parseEnvFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return {};
  }
  const out = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    out[key] = decodeEnvValue(value);
  }
  return out;
}

// Codex run B F-03 (2026-09-28): a value written BARE (unquoted) into a line-based `KEY=VALUE`
// file can smuggle in an entirely new line -- e.g. a projects-dir value of
// `C:\evil\nRUNNER=claude` (a real newline, not the two characters "\" "n") turns into TWO lines
// on disk, and the bot's own parser (discord/src/config.js) then reads `RUNNER=claude` as if it
// were a second, independent setting. The PRIMARY defence is refusing such a value outright before
// it ever reaches this function (see setProjectsDirSetting's own hasControlChars check) -- this is
// the DEFENCE IN DEPTH layer: even a value that somehow arrives here already containing a
// newline/CR/NUL/quote is never written as raw bytes that could start a new line. `needsEnvQuoting`
// is deliberately narrow (CR, LF, NUL, other control chars, a literal `"`, or leading/trailing
// whitespace) so every value ever written by this codebase today (a bot token, a snowflake id, an
// ordinary Windows/POSIX folder path -- none of which contain any of those) is written EXACTLY as
// before: bare, unquoted, byte-for-byte identical to the pre-fix output.
function needsEnvQuoting(value) {
  return /[\r\n\u0000-\u001f\u007f"]/.test(value) || value !== value.trim();
}

// JSON string syntax already escapes every character that would otherwise corrupt a line-based
// format (a real newline becomes the two-character sequence `\n`, a `"` becomes `\"`, ...) and
// JSON.parse reverses it exactly -- reused here rather than hand-rolling a second escaping scheme.
function encodeEnvValue(value) {
  return needsEnvQuoting(value) ? JSON.stringify(value) : value;
}

// WP-v290-B (beginner onboarding, B1): a small, gateway-local merge-writer for discord/.env —
// deliberately a SEPARATE small copy from discord/src/env-store.js's own writeEnvValues(), not a
// shared import (this gateway never imports the bot's own module graph — see this file's header).
// Same merge semantics: an existing `KEY=...` line is replaced in place (everything else —
// comments, blanks, unrelated keys — untouched); a brand-new key is appended at the end. Never
// logs `updates` or the merged result anywhere — this is exactly where a real Discord bot token is
// written, and it must never appear in a log line.
function mergeEnvText(raw, updates) {
  const lines = raw.length > 0 ? raw.replace(/\r\n/g, '\n').split('\n') : [];
  const seen = new Set();
  const merged = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const eq = trimmed.indexOf('=');
    if (eq === -1) return line;
    const key = trimmed.slice(0, eq).trim();
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      seen.add(key);
      return `${key}=${encodeEnvValue(String(updates[key]))}`;
    }
    return line;
  });
  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) merged.push(`${key}=${encodeEnvValue(String(value))}`);
  }
  while (merged.length > 0 && merged[merged.length - 1] === '') merged.pop();
  return merged.length > 0 ? merged.join('\n') + '\n' : '';
}

// Test-only seam (same `_set*ForTests` / `_xForTests` convention as every other test hook in this
// file) — lets a test exercise the encode/merge shape directly (including a defence-in-depth
// injection attempt) without needing to race the full writeEnvUpdates()/setProjectsDirSetting()
// path, which already refuses such a value before it would ever reach here.
export function _mergeEnvTextForTests(raw, updates) {
  return mergeEnvText(raw, updates);
}

// Codex finding K3-5: writeFileSync(envFilePath, ...) truncates the REAL file first, then writes —
// a crash/kill between those two steps (this SAME .env is where a beginner's freshly-pasted real
// Discord bot token lives) leaves a truncated or empty file behind, not the old content and not the
// new content. A same-directory temp file + atomic rename means the real .env is only ever replaced
// in one indivisible filesystem step: either the OLD complete content is still there, or the NEW
// complete content is — never a half-written file in between. `discord/src/env-store.js` has its
// own separate (deliberately unshared — see this file's own header) copy of this exact shape, since
// the bot process and this gateway process are supposed to stay black-box supervised.
const ENV_LOCK_STALE_MS = 5000;
const ENV_LOCK_RETRY_MS = 25;
const ENV_LOCK_TIMEOUT_MS = 2000;

function sleepSyncMs(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // Atomics.wait is unavailable on the main thread in some embedders — busy-wait as a fallback
    // rather than fail the whole write over a missing sleep primitive.
    const until = Date.now() + ms;
    while (Date.now() < until) { /* deliberate busy-wait, bounded by `ms` */ }
  }
}

// WP-L2 finding 5/N3/N4: the lock used to hold only a bare pid string, and staleness was decided by
// AGE ALONE. Three real bugs followed from that: (1) a lock file that cannot be removed (Codex
// proved this with a DIRECTORY sitting at the lock path — `fs.rmSync(path, {force:true})` throws
// `ERR_FS_EISDIR` for a directory, and the old code's blanket `catch { continue; }` swallowed that
// throw and looped back to the top with NO backoff at all — a genuine, permanent 100%-CPU spin, not
// a bounded wait) meant a write could never complete; (2) a lock older than ENV_LOCK_STALE_MS was
// reclaimed unconditionally even while its original writer was still genuinely alive and mid-write
// (a large .env, a slow disk) — stealing it out from under a live writer; (3) release deleted
// whatever sat at the lock path with no check that it was still the SAME lock this call created,
// so a reclaimed-and-reacquired-by-someone-else lock could be deleted by the wrong owner's release.
//
// The fix: the lock file's content is now `{owner, pid, ts}` (owner = a random id unique to THIS
// acquisition, never reused). A lock is ONLY ever reclaimed once it is BOTH past the staleness
// timeout AND its content proves the original owner is gone — either the content is unreadable (a
// directory, a corrupt/foreign-format file) or `holder.pid` is confirmed dead via
// `process.kill(pid, 0)` throwing `ESRCH` specifically (any other outcome, including a permission
// error that cannot prove the process is gone, is treated as "still alive" — never steal on a
// guess). Release deletes the file ONLY when its content still shows OUR OWN owner id. Every retry
// path (a stat error, a failed removal, an ordinary "still fresh" wait) now funnels through the
// SAME deadline check before backing off with a bounded sleep — no path loops without checking the
// deadline, so a lock that truly cannot be recovered ends in one clear thrown Error, never a hang.
function isEnvLockOwnerPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true; // no error: the process exists and we have permission to signal it
  } catch (err) {
    // ESRCH is the ONLY outcome that proves the process is actually gone. Anything else (most
    // commonly EPERM: it exists but belongs to another user) cannot prove that, so treat it as
    // still alive — a false "alive" only costs an extra wait; a false "dead" would steal a live
    // writer's lock, which is the exact bug this fix closes.
    return !(err && err.code === 'ESRCH');
  }
}

/** Reads and parses the lock file's `{owner, pid, ts}` content. Returns `null` on ANY problem —
 *  missing file, a directory at that path (EISDIR), invalid JSON, or a foreign/older-format
 *  payload that doesn't have the shape this version writes — all treated identically as "cannot
 *  prove who (if anyone) still owns this lock", never thrown. */
function readEnvLockHolder(lockPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    return parsed && typeof parsed.owner === 'string' && typeof parsed.pid === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

/** A simple exclusive lock file next to `envFilePath`, with an OWNERSHIP-AWARE stale-lock timeout
 *  (see the block comment above for the full reasoning). Returns `{lockPath, ownerId}` to release;
 *  throws a clear, real Error — never hangs — once `ENV_LOCK_TIMEOUT_MS` has genuinely passed,
 *  whether that is because a live owner is still holding it or because a stale one could not be
 *  removed. */
function acquireEnvLock(envFilePath) {
  const lockPath = envFilePath + '.lock';
  const ownerId = crypto.randomUUID();
  const deadline = Date.now() + ENV_LOCK_TIMEOUT_MS;
  // Every "not acquired yet" path below falls through to this ONE deadline check + bounded sleep —
  // never a bare `continue` that skips it — so no path can spin without ever re-checking the clock.
  const waitOrThrow = (detail) => {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for the lock on ${path.basename(envFilePath)} — another write is in progress` + (detail ? ` (${detail})` : ''));
    }
    sleepSyncMs(ENV_LOCK_RETRY_MS);
  };
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeSync(fd, JSON.stringify({ owner: ownerId, pid: process.pid, ts: Date.now() }));
      } finally {
        fs.closeSync(fd);
      }
      return { lockPath, ownerId };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }

    let st;
    try {
      st = fs.statSync(lockPath);
    } catch (statErr) {
      if (statErr.code === 'ENOENT') continue; // vanished between our failed open() and here — retry now
      waitOrThrow(`could not check the lock: ${statErr.message}`);
      continue;
    }

    if (Date.now() - st.mtimeMs > ENV_LOCK_STALE_MS) {
      const holder = readEnvLockHolder(lockPath);
      const holderAlive = holder !== null && isEnvLockOwnerPidAlive(holder.pid);
      if (!holderAlive) {
        // Past the timeout AND (content unreadable OR the owner pid is confirmed dead) — reclaim it.
        try {
          fs.rmSync(lockPath, { force: true }); // force:true only ever swallows ENOENT; anything else really failed
          continue; // removed (or already gone) — retry the exclusive open immediately
        } catch (rmErr) {
          waitOrThrow(`could not remove the stale lock: ${rmErr.message}`);
          continue;
        }
      }
      // Past the staleness window but the owner process is confirmed still alive (or we could not
      // prove otherwise) — a slow write, not a crash. Never steal it on age alone; fall through to
      // the ordinary wait/backoff below, exactly like a fresh lock.
    }

    waitOrThrow();
  }
}

function releaseEnvLock(lock) {
  try {
    const holder = readEnvLockHolder(lock.lockPath);
    // Only delete a lock file that still proves it is OURS — if it is unreadable (already reclaimed
    // by someone else, e.g. after we lost a race against the stale-lock timeout ourselves) or now
    // shows a DIFFERENT owner id, deleting it would remove another writer's real, live lock.
    if (holder === null || holder.owner !== lock.ownerId) return;
    fs.rmSync(lock.lockPath, { force: true });
  } catch {
    /* best-effort only — a leftover lock older than ENV_LOCK_STALE_MS self-heals on the next write */
  }
}

// Test-only seam (same convention as _setDiscordPathsForTests etc. below): gives a unit test direct,
// precise access to the lock primitives themselves, without needing to race the full
// writeEnvUpdates()/startDiscordService() path to exercise a specific lock-contention scenario.
export function _acquireEnvLockForTests(envFilePath) {
  return acquireEnvLock(envFilePath);
}
export function _releaseEnvLockForTests(lock) {
  return releaseEnvLock(lock);
}

/** Writes `content` to `targetPath` atomically: a same-directory temp file is written and fsynced,
 *  then renamed over the target in one filesystem call. A failure at any point before the rename
 *  (disk full, process killed) leaves the ORIGINAL file completely untouched — never a partial one.
 *  Preserves the original file's mode where the platform supports it (best-effort; Windows does not
 *  have POSIX mode bits, so chmod there is a no-op that never fails the write). */
function atomicWriteFileSync(targetPath, content) {
  const dir = path.dirname(targetPath);
  const tmpPath = path.join(dir, `.${path.basename(targetPath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  let mode;
  try {
    mode = fs.statSync(targetPath).mode;
  } catch {
    mode = undefined; // new file — let the OS default apply, exactly like plain writeFileSync would
  }
  const fd = fs.openSync(tmpPath, 'w', mode);
  try {
    fs.writeSync(fd, content, null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (mode !== undefined) {
    try {
      fs.chmodSync(tmpPath, mode);
    } catch {
      /* best-effort only — never fails the write over a chmod platform quirk */
    }
  }
  try {
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    // A REAL process crash right here would leave the temp file behind regardless — nothing can be
    // done about that case. But when the failure is a catchable JS exception (this process is still
    // alive to run the catch block), clean up the orphan rather than leaving debris behind.
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      /* best-effort cleanup only — the original error below is what matters */
    }
    throw err;
  }
}

function writeEnvUpdates(envFilePath, updates) {
  fs.mkdirSync(path.dirname(envFilePath), { recursive: true });
  const lock = acquireEnvLock(envFilePath);
  try {
    let raw = '';
    try {
      raw = fs.readFileSync(envFilePath, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    atomicWriteFileSync(envFilePath, mergeEnvText(raw, updates));
  } finally {
    releaseEnvLock(lock);
  }
}

// ── Test-only path override seam (mirrors this codebase's `_set*ForTests` convention, e.g.
// conversations.mjs's `_setConversationsDirForTests`) — lets a test point every path this module
// touches at an isolated temp tree, never the real command-center/discord/. ──────────────────────
let pathsOverride = null;
function activePaths() {
  return (
    pathsOverride || {
      discordDir: DISCORD_DIR,
      mainJs: DISCORD_MAIN_JS,
      envFile: DISCORD_ENV_FILE,
      envExampleFile: DISCORD_ENV_EXAMPLE_FILE,
      stateDir: DISCORD_STATE_DIR,
      logFile: DISCORD_LOG_FILE,
    }
  );
}
export function _setDiscordPathsForTests(paths) {
  pathsOverride = paths;
}

/** The bot's state folder, honoring the test seam above. GET /api/discord/activity
 *  (discord-activity.mjs) reads from here, so it always reads the same folder GET /api/discord/status
 *  reports as `state_dir`. */
export function getDiscordStateDir() {
  return activePaths().stateDir;
}

// Test-only seams for spawn/fetch/extra-env, same shape as exec-lifecycle.mjs/supervisor.mjs's own
// injectable-function conventions — never used in production (a real gateway process always uses
// the real `spawn`/global `fetch` and no extra env overrides).
let spawnFnOverride = null;
let fetchFnOverride = null;
let extraEnvOverrides = null;
let killFnOverride = null;
export function _setSpawnFnForTests(fn) {
  spawnFnOverride = fn;
}
export function _setFetchFnForTests(fn) {
  fetchFnOverride = fn;
}
export function _setExtraEnvOverridesForTests(obj) {
  extraEnvOverrides = obj;
}
/** Test-only: replaces the real tree-kill call — lets a test assert exactly WHICH pid stop()
 *  targets without depending on real OS taskkill/process.kill side effects. */
export function _setKillFnForTests(fn) {
  killFnOverride = fn;
}

// Module-level tracked state for the ONE child this gateway process may be supervising right now.
let childProcess = null;
let childPid = null;
let startedAtIso = null;
let logStream = null;

/** Test-only: fully resets every override + tracked-child state. Never leaves a stray real handle
 *  referenced across test files (mirrors exec-lifecycle.mjs's own `_resetExecBridgeForTests`). */
export function _resetDiscordServiceForTests() {
  pathsOverride = null;
  spawnFnOverride = null;
  fetchFnOverride = null;
  extraEnvOverrides = null;
  killFnOverride = null;
  homeDirOverride = null; // WP-S1
  projectCountScanBudgetOverride = null; // Codex run B F-04
  childProcess = null;
  childPid = null;
  startedAtIso = null;
  if (logStream) {
    try {
      logStream.end();
    } catch {
      /* best-effort only */
    }
  }
  logStream = null;
  _resetDiscordDepsInstallStateForTests(); // WP-P1: keep this ONE reset call the full-state reset every test file already relies on
}

function envExampleKeyNames() {
  return Object.keys(parseEnvFile(activePaths().envExampleFile));
}

function resolveBotHttpPort() {
  const env = parseEnvFile(activePaths().envFile);
  const n = Number.parseInt(env.BOT_HTTP_PORT, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BOT_HTTP_PORT;
}

async function probeHealth(port) {
  const doFetch = fetchFnOverride || fetch;
  try {
    const res = await doFetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return { reachable: false, health: null };
    const health = await res.json();
    return { reachable: true, health };
  } catch {
    return { reachable: false, health: null };
  }
}

function isInstalled() {
  return fs.existsSync(activePaths().mainJs);
}

// WP-P1 (Forge v2.9.0, "the Command Center works after a fresh install"): command-center/discord/
// declares discord.js as a real npm dependency (see discord/package.json) but nothing installs it
// on a fresh machine or a freshly-copied central template install — without this, the very first
// "Connect Discord" click (connectDiscordService() -> startDiscordService(), below) would fail
// with a raw "Cannot find module 'discord.js'" the moment the real bot tries to start. This
// installs it ONCE, automatically, the first time it is actually needed.
const NPM_INSTALL_TIMEOUT_MS = 180_000; // a real first-time npm install can genuinely take a while
const NPM_INSTALL_MAX_BUFFER = 10 * 1024 * 1024; // discord.js pulls in enough transitive deps that npm's default 1MB stdout/stderr buffer is not always enough

let npmRunnerOverride = null;
/** Test-only: replaces the real `execFile` call used to run `npm ci`/`npm install` — mirrors this
 *  file's own `_setSpawnFnForTests` convention. Never used in production. */
export function _setNpmInstallRunnerForTests(fn) {
  npmRunnerOverride = fn;
}

// At most ONE real npm install may be in flight for this gateway process: two callers that both
// find deps missing near the same moment (two clicks of "Connect Discord", or the wizard's own
// status poll racing the connect click) share the SAME in-flight promise rather than each
// spawning their own `npm ci` against the same node_modules, which would corrupt one another.
let depsInstallInFlight = null;
// The last known outcome — kept ONLY so GET /api/discord/status can report an honest phase even
// to a caller that did not itself trigger the install. Never holds stdout/stderr/paths/secrets,
// just a short, already-plain-language message.
let lastDepsInstallOutcome = null; // { ok: boolean, message: string } | null

/** Test-only: fully resets this feature's module state — mirrors `_resetDiscordServiceForTests`. */
export function _resetDiscordDepsInstallStateForTests() {
  npmRunnerOverride = null;
  depsInstallInFlight = null;
  lastDepsInstallOutcome = null;
}

function discordDepsInstalled() {
  try {
    return fs.existsSync(path.join(activePaths().discordDir, 'node_modules', 'discord.js', 'package.json'));
  } catch {
    return false;
  }
}

/** `'installed'` | `'installing'` | `'failed'` | `'not-installed'` — GET /api/discord/status's
 *  own honest, human-readable phase (never a raw boolean the wizard would have to interpret). */
function discordDepsInstallPhase() {
  if (depsInstallInFlight) return 'installing';
  if (discordDepsInstalled()) return 'installed';
  if (lastDepsInstallOutcome && !lastDepsInstallOutcome.ok) return 'failed';
  return 'not-installed';
}

function appendInstallLogBestEffort(logFilePath, text) {
  try {
    fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
    fs.appendFileSync(logFilePath, text);
  } catch {
    // A log problem must never take down the gateway (same stance this file's own bot-log
    // stream already applies) — the install itself still succeeds or fails on its own merits.
  }
}

/** Turns a real npm failure into one honest, plain-language sentence — never tells the user to
 *  type a command themselves (this whole feature exists so they never have to).
 *
 *  `timedOut` is checked FIRST and separately from `rawError`'s own text — a timeout is detected
 *  structurally (see `runNpmInstallCommand` below: `err.killed`/`err.signal`, exactly the same
 *  check exec-lifecycle.mjs's own timeout handling already uses), never by pattern-matching
 *  Node's own timeout error message. Passing an already-humanized string back through a second
 *  round of pattern-matching here would be a mistake — a message like "the install did not finish
 *  in time" does not itself contain "ETIMEDOUT", so a naive two-layer humanize would silently fall
 *  through to the generic fallback and lose the specific reason. Kept as one single layer instead:
 *  this is the ONLY place raw npm/exec failures become user-facing text. */
function describeNpmFailure(rawError, { timedOut = false } = {}) {
  if (timedOut) return 'the install did not finish in time — check your internet connection and try again';
  const text = typeof rawError === 'string' ? rawError : '';
  if (/ENOENT/.test(text) || /is not recognized/i.test(text) || /command not found/i.test(text)) {
    return 'npm was not found on this machine — install Node.js (which includes npm) and try again';
  }
  if (/ENOTFOUND|ECONNRESET|EAI_AGAIN|network/i.test(text)) {
    return 'could not reach the npm registry — check your internet connection and try again';
  }
  return 'the automatic install failed — try again in a moment';
}

// Real-machine finding (WP-P1, reproduced standalone before shipping this): `execFile('npm.cmd',
// args, ...)` throws a SYNCHRONOUS `spawn EINVAL` on Windows — a `.cmd` file is a shell script the
// OS cannot CreateProcess directly; Node normally papers over this only when `shell: true` is set,
// which in turn prints a Node DEP0190 deprecation warning for passing args alongside `shell: true`
// (real concern in general — an attacker-influenced arg could break out of the shell's own
// concatenation — but not applicable here since every arg below is a fixed literal, never
// user/request input). The fix that avoids BOTH problems: spawn the genuinely native `cmd.exe`
// directly, with `npm ...` as its OWN argv (Node still does its normal, safe argv-array handling —
// nothing is shell-concatenated) — `/d` skips any AutoRun registry command, `/s` fixes how the
// remaining quoting is stripped, `/c` runs the command and exits. POSIX `npm` is a directly
// executable script/symlink and needs none of this.
function buildNpmSpawnTarget(npmArgs) {
  if (process.platform === 'win32') return { command: 'cmd.exe', args: ['/d', '/s', '/c', 'npm', ...npmArgs] };
  return { command: 'npm', args: npmArgs };
}

/** One real `npm ci --omit=dev` (or `npm install --omit=dev` when there is no lockfile yet) run
 *  in `discordDir`. Never throws — always resolves to `{ ok, error, stdout, stderr }`. Output is
 *  captured for the caller to log; NEVER printed to this process's own console (matches this
 *  file's existing "never let a spawned child's output reach the gateway's own stdout unfiltered"
 *  stance). */
function runNpmInstallCommand(discordDir) {
  const hasLockfile = fs.existsSync(path.join(discordDir, 'package-lock.json'));
  const npmArgs = hasLockfile ? ['ci', '--omit=dev'] : ['install', '--omit=dev'];
  const { command, args } = buildNpmSpawnTarget(npmArgs);
  const runner = npmRunnerOverride || execFile;
  return new Promise((resolve) => {
    let settled = false;
    try {
      runner(
        command,
        args,
        { cwd: discordDir, timeout: NPM_INSTALL_TIMEOUT_MS, windowsHide: true, maxBuffer: NPM_INSTALL_MAX_BUFFER },
        (err, stdout, stderr) => {
          if (settled) return; // execFile's own contract calls back exactly once, but a test double must never be trusted to
          settled = true;
          if (err) {
            resolve({
              ok: false,
              error: errorMessage(err), // raw — describeNpmFailure() is the one place this becomes user-facing text
              timedOut: err.killed === true || err.signal != null, // structural check, same shape exec-lifecycle.mjs already uses for its own timeout detection
              stdout: typeof stdout === 'string' ? stdout : '',
              stderr: typeof stderr === 'string' ? stderr : '',
            });
          } else {
            resolve({ ok: true, error: null, timedOut: false, stdout: typeof stdout === 'string' ? stdout : '', stderr: typeof stderr === 'string' ? stderr : '' });
          }
        },
      );
    } catch (err) {
      // execFile throws synchronously for some spawn errors (e.g. an invalid options object) —
      // treated identically to an async callback failure so the caller has only one shape to
      // handle.
      if (!settled) {
        settled = true;
        resolve({ ok: false, error: errorMessage(err), timedOut: false, stdout: '', stderr: '' });
      }
    }
  });
}

/**
 * Ensures command-center/discord/'s own real npm dependencies (discord.js) are present,
 * installing them ONCE via a real `npm ci`/`npm install` when missing. Never throws; always
 * resolves to `{ ok, message }`. Serialized: a second call while an install is already running
 * returns the SAME in-flight promise rather than starting a second npm process against the same
 * node_modules (two clicks of "Connect Discord" must never race each other).
 */
export function ensureDiscordDepsInstalled() {
  if (discordDepsInstalled()) return Promise.resolve({ ok: true, message: 'already installed' });
  if (depsInstallInFlight) return depsInstallInFlight;

  const paths = activePaths();
  depsInstallInFlight = runNpmInstallCommand(paths.discordDir)
    .then((result) => {
      if (result.stdout.length > 0 || result.stderr.length > 0) {
        appendInstallLogBestEffort(
          paths.logFile,
          '\n--- discord deps install (' + new Date().toISOString() + ') ---\n' + result.stdout + result.stderr + '\n',
        );
      }
      const outcome = result.ok
        ? { ok: true, message: 'installed' }
        : { ok: false, message: describeNpmFailure(result.error, { timedOut: result.timedOut }) };
      lastDepsInstallOutcome = outcome;
      return outcome;
    })
    .catch((err) => {
      const outcome = { ok: false, message: describeNpmFailure(errorMessage(err)) };
      lastDepsInstallOutcome = outcome;
      return outcome;
    })
    .finally(() => {
      depsInstallInFlight = null;
    });
  return depsInstallInFlight;
}

/** For every key NAME declared in .env.example, whether a non-empty value is present in the real
 *  .env — NEVER the value itself (env_keys carries only {name, present} per the WP contract). */
function buildEnvKeys() {
  const realEnv = parseEnvFile(activePaths().envFile);
  return envExampleKeyNames().map((name) => ({
    name,
    present: typeof realEnv[name] === 'string' && realEnv[name].length > 0,
  }));
}

/**
 * GET-side truth: merges (a) gateway-tracked state (installed/running/pid/started_at), (b) the
 * bot's own /api/health passed through verbatim when reachable (never fabricated — `null` when
 * unreachable), and (c) an honest conflict note when something answers that THIS gateway did not
 * start (e.g. the owner's separately-run instance).
 */
export async function getDiscordStatus() {
  const paths = activePaths();
  const installed = isInstalled();
  const port = resolveBotHttpPort();
  const { reachable, health } = await probeHealth(port);
  const running = childProcess !== null && childPid !== null;
  const conflict =
    reachable && !running
      ? `a process is already answering on port ${port} — this gateway did not start it and will refuse to start a second one`
      : null;

  const env = parseEnvFile(paths.envFile);
  const transport = typeof env.TRANSPORT === 'string' && env.TRANSPORT.length > 0 ? env.TRANSPORT : null;

  // WP-v290-B (beginner onboarding, B1): promotes select fields the bot's own /api/health already
  // reports (health-server.js's snapshot()) to named top-level fields, exactly per this WP's
  // contract — never fabricated: absent/unreachable reads back the same honest null/[] the rest of
  // this function already uses, never a guess. `health` itself is still returned verbatim below
  // too (existing contract, unchanged) — these are a convenience projection, not a replacement.
  //
  // Codex finding 3 (WP-L2): `health` used to be passed through completely UNREDACTED here — any
  // string field anywhere inside it (a nested diagnostic/error object, a future health-server.js
  // field) could carry a leaked credential straight to `/api/discord/status` and the dashboard.
  // redactDeep() walks every string in the WHOLE object tree (never drops a key, never changes
  // shape — see its own doc comment in redact.mjs) using the SAME secret patterns this codebase
  // already applies to conversation/event storage. This makes the standalone `loginError` redact()
  // a few lines below purely redundant defense-in-depth (harmless — redacting an already-redacted
  // `[REDACTED:...]` marker is a no-op), never a place that could double-mangle real content.
  const liveHealth = reachable ? redactDeep(health) : null;
  const username = liveHealth && typeof liveHealth.botUsername === 'string' ? liveHealth.botUsername : null;
  const applicationId = liveHealth && typeof liveHealth.applicationId === 'string' ? liveHealth.applicationId : null;
  const guilds = liveHealth && Array.isArray(liveHealth.guilds) ? liveHealth.guilds : [];
  const inviteUrl = liveHealth && typeof liveHealth.inviteUrl === 'string' ? liveHealth.inviteUrl : null;
  const setupState = liveHealth && typeof liveHealth.phase === 'string' ? liveHealth.phase : null;
  // Codex finding K3-3 (defense in depth): the bot's own health-server.js already redacts this
  // value before it is ever written — redacted again here, at the one place it crosses INTO the
  // gateway and out over GET /api/discord/status, so this route never has to trust that every past
  // and future producer on the other side of that HTTP boundary got it right.
  const loginError = liveHealth && typeof liveHealth.loginError === 'string' ? redact(liveHealth.loginError) : null;

  return {
    installed,
    running,
    pid: running ? childPid : null,
    started_at: running ? startedAtIso : null,
    transport,
    ports: { bot: port, manager: null },
    health: liveHealth,
    conflict,
    env_keys: buildEnvKeys(),
    state_dir: paths.stateDir,
    log_file: paths.logFile,
    username,
    application_id: applicationId,
    guilds,
    invite_url: inviteUrl,
    setup_state: setupState,
    login_error: loginError,
    // WP-P1: an honest, plain-language install phase the wizard can show WHILE a connect click's
    // own POST is still in flight (the two are independent — this is the same live module state
    // ensureDiscordDepsInstalled() itself updates, not a value derived from this one request).
    deps_installed: discordDepsInstalled(),
    deps_install_phase: discordDepsInstallPhase(),
    deps_install_error: lastDepsInstallOutcome && !lastDepsInstallOutcome.ok ? lastDepsInstallOutcome.message : null,
  };
}

// Shared tree-kill — same pattern as exec-lifecycle.mjs's own killChildTree(): taskkill /T /F on
// win32 (kills the whole tree, e.g. a RUNNER=claude child's own spawned `claude` grandchildren),
// process-group SIGKILL elsewhere. Kills ONLY the exact PID this module tracked — never by name.
function killChildTree(child) {
  try {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => {
        /* best-effort */
      });
    } else {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }
  } catch {
    /* best-effort kill only */
  }
}

/**
 * Starts the bot as a real, tracked child process. Never throws — every failure path is a typed
 * `{ ok:false, status, error }`. Refuses (without spawning) when: not installed (404), already
 * tracked as running in THIS gateway (409), or a real conflict probe finds something already
 * answering on the bot's health port (409) — the exact scenario that protects the owner's
 * separately-run LIVE instance from ever getting a second process on the same token.
 */
export async function startDiscordService() {
  const paths = activePaths();
  if (!isInstalled()) {
    return {
      ok: false,
      status: 404,
      error: 'command-center/discord/src/main.js not found — the bot has not been imported into this project',
    };
  }
  if (childProcess !== null) {
    return { ok: false, status: 409, error: `already running in this gateway (pid ${childPid})` };
  }

  const port = resolveBotHttpPort();
  const { reachable, health } = await probeHealth(port);
  if (reachable) {
    const otherPid = health && health.pid ? health.pid : 'unknown';
    return {
      ok: false,
      status: 409,
      error:
        `refusing to start: another instance is already answering on port ${port} (pid ${otherPid}) — ` +
        'never start a second bot on the same Discord token',
    };
  }

  // WP-P1: on a fresh machine (or a freshly-copied central template install) discord.js has never
  // been installed — ensure it is, ONCE, before ever attempting the real spawn below. Placed AFTER
  // the cheap already-running/conflict checks above (no reason to spend up to
  // NPM_INSTALL_TIMEOUT_MS on a start that would fail those anyway), but BEFORE any directory
  // prep/spawn — a beginner's first "Connect Discord" click waits through this once, never sees a
  // raw "Cannot find module" crash, and is never told to type a command themselves.
  const depsResult = await ensureDiscordDepsInstalled();
  if (!depsResult.ok) {
    return { ok: false, status: 503, error: 'Discord bot software could not be installed automatically: ' + depsResult.message };
  }

  try {
    fs.mkdirSync(paths.stateDir, { recursive: true });
    fs.mkdirSync(path.dirname(paths.logFile), { recursive: true });
  } catch (err) {
    return { ok: false, status: 500, error: 'could not prepare state/log directories: ' + errorMessage(err) };
  }

  const doSpawn = spawnFnOverride || spawn;
  let child;
  try {
    // A LOG PROBLEM MUST NEVER TAKE DOWN THE GATEWAY (same fix supervisor.mjs already applies to its
    // own log stream): `createWriteStream` opens the file asynchronously — an error here (directory
    // vanished, disk full, permissions) fires as an 'error' event, and an EventEmitter 'error' with
    // no listener is an uncaught exception. Degrade to no file logging rather than crash.
    logStream = fs.createWriteStream(paths.logFile, { flags: 'a' });
    logStream.on('error', () => {
      logStream = null; // best-effort only — the child's own stdout/stderr keep flowing regardless
    });
    // AUDIT G8.2 (2026-08-06) + Codex r4 #14 (2026-08-07): geef het door de gateway GEHARDE claude-CLI-pad
    // door aan de bot — en faal GESLOTEN wanneer de broker niets kan leveren: (1) een geërfd, ongevalideerd
    // CLAUDE_CLI_PATH uit process.env wordt ALTIJD gestript (nooit ongecontroleerd doorgegeven); (2) zonder
    // gebrokerd pad en zonder expliciete fake-runner-override weigert de service te starten — de runner
    // heeft zijn eigen fallbacks niet meer, dus doorstarten zou hoe dan ook stranden, maar dan pas bij de
    // eerste echte prompt in plaats van hier, met een duidelijke fout.
    let brokeredCli = null;
    try { const m = await import('./exec-cli.mjs'); brokeredCli = m.resolveClaudeCliPath(); } catch { /* resolver onbeschikbaar */ }
    // BROKER-ATTEST v2 (Codex r5 #30-rest): pin de FILE-IDENTITEIT van het geresolvede doel, zodat de
    // runner bij ELKE spawn kan verifiëren dat het nog exact dezelfde binary is (swap/omlegging na de
    // servicestart = harde weigering aan de runner-kant). v1 (CLAUDE_CLI_PATH) blijft mee-gaan voor de
    // gefaseerde migratie; het attest wint aan de runner-kant.
    // r6 #31-deel: dezelfde configbronnen als het KIND — overrides > proces-env > het .env-bestand
    // dat config.js in het kind zelf leest. Anders mist de servicecheck een RUNNER=fake uit .env.
    const effectiveRunnerFor = () => (extraEnvOverrides && extraEnvOverrides.RUNNER) || process.env.RUNNER || parseEnvFile(paths.envFile).RUNNER || null;
    let cliAttest = null;
    if (brokeredCli) {
      try {
        const st = fs.statSync(brokeredCli);
        if (st.isFile()) {
          // r6 #5: de CONTENT-digest is de echte identiteit (size+mtime is opvulbaar+terugzetbaar)
          const sha = crypto.createHash('sha256').update(fs.readFileSync(brokeredCli)).digest('hex');
          cliAttest = JSON.stringify({ v: 2, path: brokeredCli, size: st.size, mtime_ms: st.mtimeMs, sha256: sha });
        }
      } catch { /* hieronder fail-closed */ }
      if (!cliAttest && effectiveRunnerFor() !== 'fake') {
        // r6 #6: een resolver die WEL een pad gaf maar geen attest kan bouwen is een fout — een stille
        // v1-downgrade zou de per-spawn pinning uitschakelen zonder dat iemand het ziet.
        try { if (logStream) logStream.end(); } catch { /* best effort */ }
        return { ok: false, status: 503, error: 'claude-CLI-attest kon niet worden opgebouwd voor ' + brokeredCli + ' — Discord-service start NIET (fail-closed, r6 #6); controleer het CLI-doel of start expliciet met RUNNER=fake voor tests' };
      }
    }
    const effectiveRunner = effectiveRunnerFor();
    if (!brokeredCli && effectiveRunner !== 'fake') {
      try { if (logStream) logStream.end(); } catch { /* best effort */ }
      return { ok: false, status: 503, error: 'claude-CLI-broker kon geen gevalideerd absoluut pad leveren — Discord-service start NIET (fail-closed, Codex r4 #14); controleer de claude-installatie of start expliciet met RUNNER=fake voor tests' };
    }
    const parentEnv = { ...process.env };
    delete parentEnv.CLAUDE_CLI_PATH; // nooit een ongevalideerd geërfd pad doorgeven
    delete parentEnv.CLAUDE_CLI_ATTEST; // idem voor een geërfd attest (alleen het eigen, verse attest telt)
    child = doSpawn(process.execPath, [paths.mainJs], {
      cwd: paths.discordDir,
      // Fresh, gateway-owned STATE_DIR — never the imported folder's own default `./state`. Any
      // test-only extra overrides (TRANSPORT/RUNNER/BOT_HTTP_PORT/...) are layered on top; a real
      // gateway process never sets extraEnvOverrides, so production always spawns with the real
      // `.env` file's own values (config.js's own loadConfig() reads that file directly from cwd).
      // r5 #31: de gebrokerde CLI-sleutels zijn BESCHERMD — ze worden NA de test-overrides gespreid
      // zodat geen enkele override ze kan vervangen door een ongevalideerd pad/attest.
      env: { ...parentEnv, STATE_DIR: paths.stateDir, ...(extraEnvOverrides || {}), ...(brokeredCli ? { CLAUDE_CLI_PATH: brokeredCli } : {}), ...(cliAttest ? { CLAUDE_CLI_ATTEST: cliAttest } : {}) },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    return { ok: false, status: 500, error: 'spawn failed: ' + errorMessage(err) };
  }

  // WP-v290-B (beginner onboarding): a beginner now pastes a REAL Discord bot token into this
  // flow far more often than the old owner-manually-edits-.env path ever did — if the child ever
  // echoes it (an uncaught exception message, a library debug line), it must never land readable
  // in discord-bot.log. Redacted here, at the one place every byte of child output already passes
  // through, using the SAME redact() this codebase already applies to conversation/event storage
  // (gateway/src/redact.mjs) — never a second, drifting copy of the secret patterns.
  //
  // Codex finding K3-4: a plain per-chunk `redact(chunk)` never caught a secret whose bytes
  // straddled two separate `data` events — createStreamRedactor() holds back a small tail across
  // calls so a split token gets one more chance to complete and match before it is ever flushed to
  // the log file. One redactor per stream — never a shared carry buffer between them.
  //
  // Codex finding N1 (WP-L2): stdout/stderr are TWO independently-buffered streams, and Node makes
  // no promise about which of their lines lands in the log first when both are active — a stdout
  // line and a stderr line from around the same moment can legitimately interleave out of order.
  // That is harmless (the log is diagnostic, not an ordering-sensitive record). What is NOT
  // negotiable is redaction completeness, which is exactly why each stream keeps its OWN carry
  // buffer instead of sharing one: merging them to force a global order would let one stream's
  // held-back tail bytes get flushed while interleaved with the other's, corrupting the byte
  // sequence a multi-chunk secret match depends on. Per-stream buffering is kept deliberately, even
  // though it costs strict ordering, because redaction correctness wins that trade every time.
  const stream = logStream;
  const stdoutRedactor = createStreamRedactor((text) => {
    try {
      stream.write(text);
    } catch {
      /* best-effort log write only */
    }
  });
  const stderrRedactor = createStreamRedactor((text) => {
    try {
      stream.write(text);
    } catch {
      /* best-effort log write only */
    }
  });
  if (child.stdout) {
    child.stdout.on('data', (chunk) => {
      try {
        stdoutRedactor.write(chunk.toString('utf8'));
      } catch {
        /* best-effort log write only */
      }
    });
  }
  if (child.stderr) {
    child.stderr.on('data', (chunk) => {
      try {
        stderrRedactor.write(chunk.toString('utf8'));
      } catch {
        /* best-effort log write only */
      }
    });
  }

  childProcess = child;
  childPid = child.pid;
  startedAtIso = new Date().toISOString();

  const flushStreamRedactors = () => {
    try {
      stdoutRedactor.end();
    } catch {
      /* best-effort only */
    }
    try {
      stderrRedactor.end();
    } catch {
      /* best-effort only */
    }
  };

  child.on('exit', () => {
    // Only clear tracked state if THIS is still the tracked child (a stale 'exit' listener from an
    // already-superseded child instance must never clobber a newer one's tracked pid).
    if (childProcess === child) {
      childProcess = null;
      childPid = null;
      startedAtIso = null;
    }
  });
  // Codex finding N1 (WP-L2): 'exit' fires once the PROCESS has ended, but stdout/stderr can still
  // deliver buffered `data` events afterwards — flushing the redactors there silently dropped the
  // last up-to-STREAM_REDACT_TAIL_CHARS of held-back tail content. 'close' is the one event Node
  // guarantees fires only once the process has exited AND both stdio streams are fully closed
  // (Node docs: "the 'close' event is emitted when the streams of a child process have been
  // closed" — 'exit' carries no such guarantee), so finalizing here never races the still-arriving
  // stdio data. `.end()` is idempotent (a second call on an already-empty carry buffer is a no-op),
  // so this is safe even in the rare case a spawn-level failure fires both 'close' and 'error'.
  child.on('close', () => {
    flushStreamRedactors();
  });
  child.on('error', () => {
    // A spawn-level failure (e.g. the executable could not be launched at all) may never produce a
    // real 'close' for stdio that never opened — flush here too so that failure path still
    // finalizes its (typically empty) redactor state and never leaves it dangling.
    flushStreamRedactors();
    if (childProcess === child) {
      childProcess = null;
      childPid = null;
      startedAtIso = null;
    }
  });

  return { ok: true, status: 202, pid: child.pid };
}

/**
 * Stops the tracked child: tries the bot's own graceful `POST /api/shutdown` first (best-effort,
 * bounded wait), then force-kills the exact tracked PID tree if it is still running. Idempotent —
 * stopping when nothing is tracked is a truthful `{ ok:true, stopped:false }`, never an error.
 */
export async function stopDiscordService() {
  if (childProcess === null) return { ok: true, stopped: false };
  const port = resolveBotHttpPort();
  const doFetch = fetchFnOverride || fetch;
  try {
    await doFetch(`http://127.0.0.1:${port}/api/shutdown`, {
      method: 'POST',
      signal: AbortSignal.timeout(SHUTDOWN_HTTP_TIMEOUT_MS),
    });
  } catch {
    /* fall through to a hard kill below — the graceful path is best-effort only */
  }
  await new Promise((resolve) => setTimeout(resolve, GRACEFUL_SHUTDOWN_WAIT_MS));
  // r5 #28: tracking pas wissen NA bewezen exit — anders start een supervisor/drain een verse bot naast
  // een nog levende oude. Bounded wait; een overlever wordt eerlijk gerapporteerd.
  const pidToWatch = childPid;
  if (childProcess !== null) {
    (killFnOverride || killChildTree)(childProcess);
  }
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  let survived = false;
  if (pidToWatch) {
    const deadline = Date.now() + 5000;
    while (alive(pidToWatch) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    survived = alive(pidToWatch);
  }
  childProcess = null;
  childPid = null;
  startedAtIso = null;
  return { ok: true, stopped: true, ...(survived ? { survivor_pid: pidToWatch, note: 'kind leefde nog na de kill-deadline — eerlijk gemeld' } : {}) };
}

/**
 * WP-v290-B (beginner onboarding, B1) — `POST /api/discord/connect`: the ONE beginner-facing
 * "log in" action. Validates the token's FORMAT ONLY (never contacts Discord — that only happens
 * once the bot process itself tries to log in via startDiscordService() below), merge-writes it
 * into discord/.env alongside TRANSPORT=discord (and DISCORD_GUILD_ID when the caller already
 * knows it — optional; B2's auto-detect fills it in otherwise), then (re)starts the bot through
 * the exact same startDiscordService() every other start already uses.
 *
 * The token is NEVER echoed back, NEVER logged, and NEVER included in the returned object — every
 * return path here carries only a generic ok/status/pid/error shape, exactly like
 * startDiscordService()'s own existing contract.
 */
export async function connectDiscordService({ token, guildId } = {}) {
  if (!isValidBotTokenFormat(token)) {
    return {
      ok: false,
      status: 400,
      error: 'that does not look like a real Discord bot token (expected three dot-separated parts, no spaces) — nothing was saved',
    };
  }
  const hasGuildId = guildId !== undefined && guildId !== null && String(guildId).length > 0;
  if (hasGuildId && !isValidSnowflake(String(guildId))) {
    return { ok: false, status: 400, error: 'guildId must be a real Discord server ID (digits only) — nothing was saved' };
  }
  const paths = activePaths();
  const updates = { DISCORD_BOT_TOKEN: token, TRANSPORT: 'discord' };
  if (hasGuildId) updates.DISCORD_GUILD_ID = String(guildId);
  try {
    writeEnvUpdates(paths.envFile, updates);
  } catch (err) {
    return { ok: false, status: 500, error: 'could not save the connection: ' + errorMessage(err) };
  }
  // A fresh token means any previously-tracked instance was talking to the OLD config — stop it
  // first (idempotent/best-effort even when nothing was running) so the very next start() reads
  // back the .env we just wrote, never a stale already-running child on the old token.
  await stopDiscordService();
  const result = await startDiscordService();
  if (!result.ok) return result;
  return { ok: true, status: result.status, pid: result.pid };
}

/**
 * WP-v290-B (beginner onboarding, B2) — `POST /api/discord/guild`: the owner's explicit pick when
 * the bot is in several servers and main.js's own auto-detect (guild-autodetect.js) could not
 * choose for them alone. Persists the choice to .env, then restarts the bot so the freshly-booted
 * process reads it back through the normal loadConfig() path — the same "write, then restart"
 * shape connectDiscordService() itself already uses above.
 */
export async function selectDiscordGuild({ guildId } = {}) {
  if (!isValidSnowflake(String(guildId ?? ''))) {
    return { ok: false, status: 400, error: 'guildId must be a real Discord server ID (digits only) — nothing was saved' };
  }
  // Codex finding K3-6: a format-valid snowflake used to be trusted and persisted outright — this
  // route is reachable with ANY 5-25 digit string, whether or not the bot is actually in that
  // server, and resolveGuild() (main.js) then trusts whatever DISCORD_GUILD_ID says without a
  // second check. The id must now match a REAL entry in the bot's own CURRENT, live guild list
  // (the same live health probe getDiscordStatus() already uses) before it is ever written —
  // refusing outright when the bot is not reachable or its guild list is not known, rather than
  // saving an unverified guess and hoping it turns out to be right.
  const { reachable, health } = await probeHealth(resolveBotHttpPort());
  if (!reachable || !health || !Array.isArray(health.guilds)) {
    return {
      ok: false,
      status: 409,
      error: 'the bot is not running (or its list of servers is not known yet) — connect it first, then pick a server',
    };
  }
  const isMember = health.guilds.some((g) => g && String(g.id) === String(guildId));
  if (!isMember) {
    return {
      ok: false,
      status: 400,
      error: 'that is not one of the servers this bot is currently in — pick one from the real, live list',
    };
  }
  const paths = activePaths();
  try {
    writeEnvUpdates(paths.envFile, { DISCORD_GUILD_ID: String(guildId) });
  } catch (err) {
    return { ok: false, status: 500, error: 'could not save the chosen server: ' + errorMessage(err) };
  }
  await stopDiscordService();
  const result = await startDiscordService();
  if (!result.ok) return result;
  return { ok: true, status: result.status, pid: result.pid };
}

/**
 * WP-S1 (owner request 2026-09-27) — "the user must be able to set the project folder too, via
 * the Command Center". Mirrors `command-center/discord/src/config.js`'s own DEFAULT_PROJECTS_DIR
 * computation (`<home>/Documents/ForgeProjects`) — a deliberate duplicate, not an import, per this
 * file's own "never import the bot's own module graph" header rule. `project-sync.js` (the bot's
 * own file-watcher) reads this same env var name at boot; nothing else in the bot reads it.
 */
const PROJECTS_DIR_ENV_KEY = 'FORGE_PROJECTS_DIR';

// Test-only seam (same `_set*ForTests` convention as every other override in this file) — lets a
// test exercise the "create:true only works INSIDE home" rule against an isolated temp directory
// instead of ever writing under the real developer/owner's actual home folder. A real gateway
// process never sets this; `homeDir()` then falls through to the genuine `os.homedir()`.
let homeDirOverride = null;
export function _setHomeDirForTests(dir) {
  homeDirOverride = dir;
}
function homeDir() {
  return homeDirOverride || os.homedir();
}

function defaultProjectsDir() {
  return path.join(homeDir(), 'Documents', 'ForgeProjects');
}

function normalizeForCompare(p) {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

function isDriveRootPath(p) {
  return path.parse(p).root === p;
}

/** Real, on-this-machine Windows system folders, read from the SAME environment variables
 *  Windows itself sets (never a hardcoded, maintainer-specific path — same principle
 *  config.js's own DEFAULT_PROJECTS_DIR comment already documents for this exact reason). An
 *  absent/empty variable is skipped, never guessed at. win32-only: these env vars are simply
 *  absent elsewhere, so this naturally returns [] on every other platform. */
function windowsSystemRoots() {
  const roots = [];
  const add = (raw) => {
    if (typeof raw === 'string' && raw.trim().length > 0) roots.push(path.resolve(raw.trim()));
  };
  add(process.env.WINDIR);
  add(process.env.SystemRoot);
  add(process.env.ProgramFiles);
  add(process.env['ProgramFiles(x86)']);
  add(process.env.ProgramW6432);
  add(process.env.ProgramData);
  return roots;
}

/** Returns a plain-language rejection reason, or `null` when `resolved` is safe to save as the
 *  projects root. Exact-match only (never an ancestry/containment check) — this deliberately
 *  mirrors the WP's own literal instruction ("not a drive root and not a system folder: the
 *  Windows directory, Program Files, the user profile root itself"), not a broader guess at every
 *  possible unwise choice. A real subfolder INSIDE one of these (e.g. a folder a user genuinely
 *  made under Program Files) is not rejected here — that is a deliberately narrower scope than
 *  paths.mjs's own validateExtraScanRoot(), which guards a DIFFERENT, wider trust boundary (which
 *  folders this gateway scans for ANY project), not a single beginner-chosen settings value. */
function validateProjectsDirCandidate(resolved) {
  if (isDriveRootPath(resolved)) {
    return 'that is a whole drive — pick (or make) a specific folder inside it instead';
  }
  const home = path.resolve(homeDir());
  if (normalizeForCompare(resolved) === normalizeForCompare(home)) {
    return 'that is your whole user profile folder — pick (or make) a specific folder inside it instead';
  }
  if (process.platform === 'win32') {
    for (const sysRoot of windowsSystemRoots()) {
      if (normalizeForCompare(resolved) === normalizeForCompare(sysRoot)) {
        return 'that is a Windows system folder — pick (or make) an ordinary folder instead';
      }
    }
  }
  return null;
}

/** True when `resolved` is the user's home folder itself, or a real descendant of it — the ONLY
 *  place a brand-new folder may be auto-created (`create:true`), never anywhere wider. */
function isInsideHome(resolved) {
  const home = path.resolve(homeDir());
  const a = normalizeForCompare(home);
  const b = normalizeForCompare(resolved);
  if (a === b) return true;
  const rel = path.relative(a, b);
  return rel !== '' && !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel);
}

/** Reads `FORGE_PROJECTS_DIR` straight from discord/.env (never the bot's own config.js — this
 *  file never imports the bot's module graph, see its own header) — `'setting'` when a non-empty
 *  value is present, `'default'` (this file's own DEFAULT_PROJECTS_DIR, matching the bot's own
 *  default) otherwise. */
function resolveProjectsDirSetting() {
  const env = parseEnvFile(activePaths().envFile);
  const raw = typeof env[PROJECTS_DIR_ENV_KEY] === 'string' ? env[PROJECTS_DIR_ENV_KEY].trim() : '';
  if (raw.length > 0) return { dir: raw, source: 'setting' };
  return { dir: defaultProjectsDir(), source: 'default' };
}

// Codex run B F-04 (2026-09-28): bounds the raw directory scan this route performs on every
// no-token GET, independent of any result cap — mirrors folder-browse.mjs's own collectSubfolder-
// Names() budget shape (opendirSync/readSync instead of one readdirSync() that reads everything
// before anyone gets to look at it).
const PROJECT_COUNT_SCAN_BUDGET = 5000;

// Test-only override seam (same `_set*ForTests` convention as every other test hook in this file,
// e.g. `_setHomeDirForTests`) — lets a test prove the scan genuinely stops at the budget using a
// handful of fixture folders instead of manufacturing thousands of real ones.
let projectCountScanBudgetOverride = null;
export function _setProjectCountScanBudgetForTests(n) {
  projectCountScanBudgetOverride = n;
}
export function _resetProjectCountScanBudgetForTests() {
  projectCountScanBudgetOverride = null;
}

/** Counts real, non-dot-prefixed subfolders of `dir` with a hard scan budget. Returns
 *  `{ count, truncated }` — `truncated:true` means `count` is a LOWER BOUND (at least this many),
 *  never a silently-wrong exact number, because the scan stopped before finishing the directory. */
function countProjectSubfolders(dir) {
  const budget = typeof projectCountScanBudgetOverride === 'number' ? projectCountScanBudgetOverride : PROJECT_COUNT_SCAN_BUDGET;
  const d = fs.opendirSync(dir);
  let count = 0;
  let scanned = 0;
  let truncated = false;
  try {
    let dirent = d.readSync();
    while (dirent !== null) {
      scanned += 1;
      if (scanned > budget) {
        truncated = true;
        break;
      }
      if (dirent.isDirectory() && !dirent.name.startsWith('.')) count += 1;
      dirent = d.readSync();
    }
  } finally {
    d.closeSync();
  }
  return { count, truncated };
}

/**
 * `GET /api/discord/projects-dir` — the current setting, its source, whether it exists on disk
 * right now, and an honest project-folder count (same "real subfolder, not dot-prefixed" filter
 * `project-sync.js`'s own `listProjectDirs()` uses, so this count matches what the bot itself
 * would actually turn into channels). Never throws — a missing/unreadable folder simply reports
 * `exists:false, projectCount:null`, never a fabricated number.
 */
export function getProjectsDirStatus() {
  const { dir, source } = resolveProjectsDirSetting();
  let exists = false;
  let projectCount = null;
  let projectCountTruncated = false;

  // Codex run B F-01: the PERSISTED setting is checked the same way a fresh request is — a
  // hand-edited `.env` (or one saved by a pre-fix version of this code) could already hold a
  // network or device path, and this route is a no-token GET that fires on every dashboard load.
  if (!isNetworkOrDevicePath(dir) && !hasControlChars(dir)) {
    const safe = safeRealpathSync(dir);
    if (safe.ok) {
      try {
        exists = fs.statSync(safe.real).isDirectory();
      } catch {
        exists = false;
      }
      if (exists) {
        try {
          const scan = countProjectSubfolders(safe.real);
          projectCount = scan.count;
          projectCountTruncated = scan.truncated;
        } catch {
          projectCount = null; // a race (folder removed between the two calls) — honest unknown, not 0
        }
      }
    }
    // safe.ok === false for any other reason (ENOENT, a broken link, ...) leaves exists:false,
    // projectCount:null — the same honest "does not exist / can't be read" shape this route
    // already reported for those cases before this fix.
  }
  return { dir, source, exists, projectCount, projectCountTruncated };
}

/** Walks UP from `p` until it finds a component that already exists, returning that ancestor and
 *  the ordered list of missing path-segment NAMES between it and `p` — Codex run B F-02's first
 *  step ("resolve ... the nearest existing ancestor"). Returns `{ ok:false, error }` only for a
 *  genuine, unexpected fs error (e.g. a permission problem partway up); reaching the filesystem
 *  root without finding anything is not expected in practice (a root always exists) but is still
 *  reported honestly rather than looping forever. */
function nearestExistingAncestor(p) {
  let current = p;
  const missingSegments = [];
  for (;;) {
    let lst;
    try {
      lst = fs.lstatSync(current);
    } catch (err) {
      if (err.code !== 'ENOENT') return { ok: false, error: errorMessage(err) };
      const parent = path.dirname(current);
      if (parent === current) return { ok: false, error: 'no existing ancestor directory could be found' };
      missingSegments.unshift(path.basename(current));
      current = parent;
      continue;
    }
    if (!lst.isDirectory() && !lst.isSymbolicLink()) {
      return { ok: false, error: `"${current}" exists but is not a folder` };
    }
    return { ok: true, existingAncestor: current, missingSegments };
  }
}

/**
 * Codex run B F-02 — creates every missing component of `resolved` ONE LEVEL AT A TIME, starting
 * from the REAL, symlink-resolved location of the nearest already-existing ancestor. Never a
 * single `fs.mkdirSync(resolved, { recursive: true })`: when some ancestor that LEXICALLY looks
 * like it is inside home is actually a symlink/junction pointing elsewhere (e.g. `<home>/link` ->
 * an outside folder), a recursive mkdir silently creates the final folder wherever that link's
 * target really is — outside home, despite the lexical "inside home" check passing. Every newly
 * created component is verified (via fs.lstatSync) to really be an ordinary directory, never a
 * link, immediately after creation; the fully-created result is verified to still resolve inside
 * home before this function reports success.
 */
function createMissingDirInsideHome(resolved) {
  const found = nearestExistingAncestor(resolved);
  if (!found.ok) return { ok: false, status: 500, error: found.error };

  // The nearest EXISTING ancestor is itself resolved hop-by-hop (never trusted lexically) — this
  // is exactly the check the lexical isInsideHome() above cannot make: a component that reads like
  // an ordinary folder name can still BE a link to somewhere else entirely.
  const safeAncestor = safeRealpathSync(found.existingAncestor);
  if (!safeAncestor.ok) {
    const isUnsafe = safeAncestor.code === 'EUNSAFE_LINK' || safeAncestor.code === 'EUNSAFE_CHARS';
    return {
      ok: false,
      status: isUnsafe ? 400 : 500,
      error: 'could not verify the existing part of that folder path: ' + safeAncestor.error,
    };
  }
  if (!isInsideHome(safeAncestor.real)) {
    return { ok: false, status: 400, error: 'a brand-new folder can only be created inside your own user folder' };
  }

  let current = safeAncestor.real;
  for (const segment of found.missingSegments) {
    current = path.join(current, segment);
    try {
      fs.mkdirSync(current);
    } catch (err) {
      if (err.code !== 'EEXIST') return { ok: false, status: 500, error: 'could not create that folder: ' + errorMessage(err) };
      // EEXIST here means a race created it between our ancestor check and this call — fall
      // through to the verification below, which confirms it is a real, link-free, inside-home
      // directory regardless of who created it.
    }
    let lst;
    try {
      lst = fs.lstatSync(current);
    } catch (err) {
      return { ok: false, status: 500, error: 'could not verify the created folder: ' + errorMessage(err) };
    }
    if (lst.isSymbolicLink() || !lst.isDirectory()) {
      return { ok: false, status: 500, error: `"${current}" is not an ordinary directory` };
    }
  }

  const finalSafe = safeRealpathSync(resolved);
  if (!finalSafe.ok || !isInsideHome(finalSafe.real)) {
    return { ok: false, status: 500, error: 'the created folder could not be verified as inside your user folder' };
  }
  return { ok: true };
}

/**
 * `POST /api/discord/projects-dir` — saves a new projects folder via the exact SAME atomic,
 * locked env writer `connectDiscordService()`/`selectDiscordGuild()` already use for the bot
 * token (`writeEnvUpdates`, this file's own atomic-write-plus-lock implementation above), then
 * restarts the bot ONLY when this gateway has it tracked as actually running right now — an owner
 * who has not connected yet simply has the CHOICE stored for whenever they do connect (per this
 * WP's own "before Discord is connected: the choice is stored and used when the bot starts"
 * contract). `create:true` makes a missing folder, but ONLY inside the user's own home directory
 * — never anywhere wider, regardless of what `create` says.
 */
export async function setProjectsDirSetting({ dir, create = false } = {}) {
  if (typeof dir !== 'string' || dir.trim().length === 0) {
    return { ok: false, status: 400, error: 'dir is required' };
  }
  const trimmed = dir.trim();
  // Codex run B F-03: the PRIMARY defence against a `.env` newline-injection attempt — refused
  // outright before any further processing. (See mergeEnvText's own comment for the defence-in-
  // depth layer that also protects the raw write itself, independent of this check.)
  if (hasControlChars(trimmed)) {
    return { ok: false, status: 400, error: 'that path contains characters that are not allowed' };
  }
  if (!path.isAbsolute(trimmed)) {
    return { ok: false, status: 400, error: 'that must be a full, absolute folder path' };
  }
  const resolved = path.resolve(trimmed);
  // Codex run B F-01: reject a literal network/device path BEFORE any filesystem call.
  if (isNetworkOrDevicePath(resolved)) {
    return { ok: false, status: 400, error: 'network and device paths are not allowed' };
  }
  const validationError = validateProjectsDirCandidate(resolved);
  if (validationError) return { ok: false, status: 400, error: validationError };

  // Codex run B F-01: resolved hop-by-hop (paths.mjs's safeRealpathSync), never a direct
  // fs.statSync(resolved) — a local-LOOKING path can still sit under (or itself be) a symlink/
  // junction that targets a network share or a device path, which a bare stat would otherwise
  // silently follow.
  const safe = safeRealpathSync(resolved);
  let stat = null;
  if (safe.ok) {
    try {
      stat = fs.statSync(safe.real);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        return { ok: false, status: 400, error: 'could not check that folder: ' + errorMessage(err) };
      }
    }
  } else if (safe.code === 'EUNSAFE_LINK' || safe.code === 'EUNSAFE_CHARS') {
    return { ok: false, status: 400, error: 'that folder is not allowed: ' + safe.error };
  } else if (safe.code !== 'ENOENT') {
    return { ok: false, status: 400, error: 'could not check that folder: ' + safe.error };
  }
  // safe.code === 'ENOENT' leaves `stat` at its initial `null` — exactly the "does not exist yet"
  // case the create branch below already handles.

  if (stat === null) {
    if (!create) {
      return {
        ok: false,
        status: 404,
        error: 'that folder does not exist yet — pick an existing folder, or ask to create it',
      };
    }
    if (!isInsideHome(resolved)) {
      return {
        ok: false,
        status: 400,
        error: 'a brand-new folder can only be created inside your own user folder',
      };
    }
    const createResult = createMissingDirInsideHome(resolved);
    if (!createResult.ok) {
      return { ok: false, status: createResult.status, error: createResult.error };
    }
  } else if (!stat.isDirectory()) {
    return { ok: false, status: 400, error: 'that path exists but is not a folder' };
  }

  const paths = activePaths();
  try {
    writeEnvUpdates(paths.envFile, { [PROJECTS_DIR_ENV_KEY]: resolved });
  } catch (err) {
    return { ok: false, status: 500, error: 'could not save this setting: ' + errorMessage(err) };
  }

  // Same "is it really running" truth every other route on this module already uses (see
  // getDiscordStatus()'s own `running` field) — never a guess, never the bot's OWN separately-run
  // instance that this gateway does not track.
  const running = childProcess !== null && childPid !== null;
  if (!running) {
    return { ok: true, status: 200, dir: resolved, restarted: false, restartError: null, pid: null };
  }
  await stopDiscordService();
  const startResult = await startDiscordService();
  if (!startResult.ok) {
    return { ok: true, status: 200, dir: resolved, restarted: false, restartError: startResult.error, pid: null };
  }
  return { ok: true, status: 200, dir: resolved, restarted: true, restartError: null, pid: startResult.pid };
}

function errorMessage(err) {
  return err && err.message ? err.message : String(err);
}
