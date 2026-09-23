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

const DEFAULT_BOT_HTTP_PORT = 3979;
const HEALTH_PROBE_TIMEOUT_MS = 1500;
const SHUTDOWN_HTTP_TIMEOUT_MS = 2000;
const GRACEFUL_SHUTDOWN_WAIT_MS = 500;

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

  return {
    installed,
    running,
    pid: running ? childPid : null,
    started_at: running ? startedAtIso : null,
    transport,
    ports: { bot: port, manager: null },
    health: reachable ? health : null,
    conflict,
    env_keys: buildEnvKeys(),
    state_dir: paths.stateDir,
    log_file: paths.logFile,
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

  const stream = logStream;
  if (child.stdout) {
    child.stdout.on('data', (chunk) => {
      try {
        stream.write(chunk);
      } catch {
        /* best-effort log write only */
      }
    });
  }
  if (child.stderr) {
    child.stderr.on('data', (chunk) => {
      try {
        stream.write(chunk);
      } catch {
        /* best-effort log write only */
      }
    });
  }

  childProcess = child;
  childPid = child.pid;
  startedAtIso = new Date().toISOString();

  child.on('exit', () => {
    // Only clear tracked state if THIS is still the tracked child (a stale 'exit' listener from an
    // already-superseded child instance must never clobber a newer one's tracked pid).
    if (childProcess === child) {
      childProcess = null;
      childPid = null;
      startedAtIso = null;
    }
  });
  child.on('error', () => {
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

function errorMessage(err) {
  return err && err.message ? err.message : String(err);
}
