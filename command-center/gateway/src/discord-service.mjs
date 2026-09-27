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
import path from 'node:path';
import {
  DISCORD_DIR, DISCORD_MAIN_JS, DISCORD_ENV_FILE, DISCORD_ENV_EXAMPLE_FILE,
  DISCORD_STATE_DIR, DISCORD_LOG_FILE,
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
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
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
      return `${key}=${updates[key]}`;
    }
    return line;
  });
  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) merged.push(`${key}=${value}`);
  }
  while (merged.length > 0 && merged[merged.length - 1] === '') merged.pop();
  return merged.length > 0 ? merged.join('\n') + '\n' : '';
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

function errorMessage(err) {
  return err && err.message ? err.message : String(err);
}
