#!/usr/bin/env node
'use strict';
/**
 * forge-cc-launch.cjs — WP-P2 (Forge v2.9.0: "forge dashboard works after a fresh install, with no
 * manual steps"). All the decision logic behind the `dashboard` / `start` dispatcher subcommands lives
 * here, exactly like every other non-trivial subcommand already delegates to its own tool
 * (forge-runinfo.cjs, forge-config.cjs, forge-swarm-resume.cjs, ...) — forge.ps1/forge.cmd/forge.sh just
 * resolve node and call this file with no arguments. Putting the logic in ONE Node file instead of three
 * near-duplicated PowerShell/cmd/bash implementations avoids re-deriving the same numeric-port-parsing /
 * HTTP-health-check / npm-detection rules three times in three shell dialects, and sidesteps a documented
 * class of bug in this codebase where Windows PowerShell 5.1 mangles an embedded-quote string argument
 * when it forwards it to a native executable (see forge.ps1's own `log-event` branch comment).
 *
 * Steps, in order:
 *   1. Resolve the port: process.env.CC_PORT when it parses as a number > 0, else 4100 — the EXACT same
 *      rule command-center/gateway/bin.mjs itself uses (see resolvePort), so this tool can never disagree
 *      with what the gateway will actually bind to.
 *   2. Health-check http://127.0.0.1:<port>/api/health with a short timeout (isAlreadyRunning).
 *      LAUNCH-1 fix (Codex adversarial-review finding, LOW, WP-Q2 2026-09-27): a successful HTTP
 *      response alone is NOT enough — ANY server answering on that port (a 404, an unrelated app)
 *      used to count as "already running". The parsed JSON body must also match this gateway's own
 *      real health shape (looksLikeCommandCenterHealth: `ok` + `runtime` + `gateway.version`), healthy
 *      or DEGRADED alike (see bin.mjs's own degradeAndDrain: a draining gateway still holds the port
 *      until its drain window ends). A response that answers but does NOT match is a 'conflict' — some
 *      other process holds the port — reported as such, and nothing is started or claimed "running".
 *      Checked BEFORE looking for a local install, so a project with no command-center/ of its own
 *      still correctly reports "already running" when some other already-started REAL instance covers it.
 *   3. Locate the Command Center (findCommandCenter): (a) <projectRoot>/command-center/gateway/bin.mjs
 *      (a developer checkout of this repo), else (b) <home>/.claude/forge/template/command-center/
 *      gateway/bin.mjs (the installer's shared central copy — WP-P1 wired this up gateway-side in
 *      command-center/gateway/src/paths.mjs's FORGE_TEMPLATE_DIR/FORGE_INSTALLED_PROJECTS_FILE). Neither
 *      present -> one plain line naming the installer for this OS (installerHint), never a stack trace.
 *   4. Build on demand when dashboard/dist/index.html is missing but dashboard/package.json exists
 *      (ensureBuilt): `npm ci` when dashboard/package-lock.json exists, else `npm install`, then
 *      `npm run build` — never asked of the user to type, honestly reported if npm is missing or a step
 *      fails (real npm stdout/stderr is inherited so the user sees genuine progress, not a fake spinner).
 *   5. Start gateway/supervisor.mjs when present (auto-restart on crash), else gateway/bin.mjs directly
 *      (pickEntry), in the FOREGROUND (inherited stdio) with FORGE_CC_DEFAULT_PROJECT set to this
 *      project's own absolute root. The URL is printed HERE, before spawning, because supervisor.mjs
 *      deliberately does not forward the child gateway's own stdout (its "listening on ..." line) to the
 *      console — only the supervisor's OWN meta-log lines reach the terminal — so relying on the child to
 *      announce itself would silently say nothing when the supervisor path is used.
 *
 * Exit codes: 0 = a real dashboard is reachable (already running, or started here and later exited
 * cleanly, e.g. Ctrl+C) ; 1 = the Command Center is not installed anywhere reachable, the on-demand build
 * failed, or the gateway/supervisor process itself failed to spawn — an honest non-zero so a caller can
 * tell "the dashboard did not start" from "the dashboard started".
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

// forge-bin -> .claude -> project root (the same two-levels-up relationship forge.ps1/forge.cmd/forge.sh
// each already use for their own paths, e.g. "$PSScriptRoot\..\forge-dashboard").
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const HEALTH_TIMEOUT_MS = 1500;

/** resolvePort(env) -> number. Same rule as command-center/gateway/bin.mjs's own
 *  `Number(process.env.CC_PORT) > 0 ? Number(...) : 4100` — kept as a one-line mirror rather than a
 *  shared import because bin.mjs is an ES module in a separate repo (command-center/ is its own git
 *  repository, owner decision D1) and this file is a CommonJS tool in THIS repo. */
function resolvePort(env) {
  const n = Number((env || process.env).CC_PORT);
  return n > 0 ? n : 4100;
}

/** looksLikeCommandCenterHealth(body) -> true only when body is a parsed JSON object matching THIS
 *  gateway's own real GET /api/health response shape (see command-center/gateway/src/health.mjs's
 *  buildHealth()): an `ok` boolean, a `runtime` value, and a `gateway` object carrying its own
 *  `version` string. LAUNCH-1 fix (Codex adversarial-review finding, LOW, WP-Q2 2026-09-27): ANY
 *  successful HTTP response used to count as "the Command Center is already running", including a
 *  plain 404 or any unrelated server's own response on the same port — this is the shape check that
 *  tells the real gateway apart from anything else that merely happens to be listening there. Kept as
 *  its own small predicate (duplicated, not shared, in forge-runinfo.cjs's cmdStatus()) for the same
 *  reason resolvePort() above is a one-line mirror rather than an import: command-center/ is its own
 *  separate git repository this CommonJS tool never imports from. */
function looksLikeCommandCenterHealth(body) {
  return !!(body && typeof body === 'object' && !Array.isArray(body)
    && typeof body.ok === 'boolean'
    && 'runtime' in body
    && body.gateway && typeof body.gateway === 'object'
    && typeof body.gateway.version === 'string');
}

/** isAlreadyRunning(port, timeoutMs) -> Promise<{state:'running'|'not-running'|'conflict', body}>.
 *  LAUNCH-1 fix: this used to return a bare boolean, true for ANY successful HTTP response regardless
 *  of its body — a totally unrelated server (or a plain 404 handler) bound to that port was
 *  indistinguishable from the real Command Center, so a second, real instance was silently never
 *  started while the caller believed one was already up. Now:
 *   - 'not-running': nothing answers before the timeout (refused/errored/timed out) — safe to start.
 *   - 'running': something answers AND its JSON body has this gateway's own real health shape
 *     (looksLikeCommandCenterHealth) — genuinely the Command Center, already up.
 *   - 'conflict': something answers but the body does NOT have that shape — some OTHER process holds
 *     the port; starting a second instance would only fail on EADDRINUSE, and reporting that as
 *     "already running" would be a lie. `body` is the parsed body (or null) for a caller that wants it.
 *
 *  Uses node:http directly (same primitive forge-runinfo.cjs's own checkCommandCenterHealth already
 *  uses for this exact same GET /api/health probe) rather than fetch()/AbortSignal.timeout(): measured
 *  live during this WP's own test-writing that calling fetch() with AbortSignal.timeout() more than
 *  once against distinct ephemeral ports within one short-lived Node process (exactly what
 *  forge-cc-launch.test.cjs now needs to do, to prove BOTH the 'running' and 'conflict' JSON-body
 *  cases end-to-end) reliably crashed the process on exit with a libuv assertion ("UV_HANDLE_CLOSING",
 *  src/win/async.c) on this Node version/OS — every individual test still passed; only the process's
 *  own exit crashed afterward. A manually-cleared AbortController/setTimeout did not help either;
 *  switching the underlying client to node:http (proven crash-free for the same probe, same repeated-
 *  real-socket-calls shape, in forge-runinfo.test.cjs) did. */
function isAlreadyRunning(port, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs || HEALTH_TIMEOUT_MS }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(d); } catch { /* non-JSON body -- still answered, just not this gateway */ }
        resolve({ state: looksLikeCommandCenterHealth(body) ? 'running' : 'conflict', body });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ state: 'not-running', body: null }); });
    req.on('error', () => resolve({ state: 'not-running', body: null }));
  });
}

/** findCommandCenter(projectRoot, homeDir) -> {root, origin:'project-local'|'central'} | null. Checks
 *  project-local first, then the installer's central copy — the exact lookup order forge.ps1/forge.cmd/
 *  forge.sh document in their own comments, so this function is the single source of truth for it. */
function findCommandCenter(projectRoot, homeDir) {
  const projectLocalRoot = path.join(projectRoot, 'command-center');
  if (fs.existsSync(path.join(projectLocalRoot, 'gateway', 'bin.mjs'))) {
    return { root: projectLocalRoot, origin: 'project-local' };
  }
  const centralRoot = path.join(homeDir, '.claude', 'forge', 'template', 'command-center');
  if (fs.existsSync(path.join(centralRoot, 'gateway', 'bin.mjs'))) {
    return { root: centralRoot, origin: 'central' };
  }
  return null;
}

/** installerHint(platform) -> the installer script name to name in a "not installed" message. Windows
 *  runs install.ps1 (the fastest option there per the installer's own README); every other platform runs
 *  install.sh. `platform` defaults to process.platform — a parameter only so tests can exercise both
 *  branches without needing to fake process.platform globally. */
function installerHint(platform) {
  return (platform || process.platform) === 'win32' ? 'install.ps1' : 'install.sh';
}

// npm ships as npm.cmd on Windows (a batch file) — verified live: Node's child_process refuses to spawn
// 'npm'/'npm.cmd' directly on win32 without shell:true (ENOENT / EINVAL respectively) so shell:true is
// genuinely required there; on POSIX npm is a real executable found via ordinary PATH search, no shell
// needed. Both npmAvailable/runNpm below share this one rule. On win32 the args are joined into a SINGLE
// command string rather than passed as a separate array alongside shell:true — Node deprecates (DEP0190)
// and rightly warns about that array+shell combination because it does not escape each argument; every
// argument this file ever passes ('--version', 'ci', 'install', 'run', 'build') is a fixed literal with no
// spaces or shell metacharacters, so joining them is safe, and it avoids the warning entirely.
function useShellForNpm(platform) {
  return (platform || process.platform) === 'win32';
}

function npmAvailable() {
  const res = useShellForNpm()
    ? spawnSync(['npm', '--version'].join(' '), { shell: true, stdio: 'ignore' })
    : spawnSync('npm', ['--version'], { stdio: 'ignore' });
  return !res.error && res.status === 0;
}

function runNpm(args, cwd) {
  return useShellForNpm()
    ? spawnSync(['npm', ...args].join(' '), { cwd, shell: true, stdio: 'inherit' })
    : spawnSync('npm', args, { cwd, stdio: 'inherit' });
}

/** ensureBuilt(ccRoot, opts) -> {ok:true, built:boolean} | {ok:false, reason}. opts.npmAvailableFn /
 *  opts.runNpmFn are injectable seams (default to the real npmAvailable/runNpm above) so tests can drive
 *  every branch (npm missing, install fails, build fails, build succeeds) without ever spawning a real
 *  npm process. */
function ensureBuilt(ccRoot, opts) {
  const o = opts || {};
  const checkNpmAvailable = o.npmAvailableFn || npmAvailable;
  const doRunNpm = o.runNpmFn || runNpm;
  const dashboardDir = path.join(ccRoot, 'dashboard');
  const distIndex = path.join(dashboardDir, 'dist', 'index.html');
  if (fs.existsSync(distIndex)) return { ok: true, built: false };
  const pkgJson = path.join(dashboardDir, 'package.json');
  if (!fs.existsSync(pkgJson)) {
    return {
      ok: false,
      reason: 'Command Center found but its dashboard is not built, and this copy has no dashboard/package.json '
        + 'to build it from — re-run ' + installerHint() + ' (the Forge installer) to get a built copy.',
    };
  }
  if (!checkNpmAvailable()) {
    return { ok: false, reason: 'The Command Center dashboard needs building but npm was not found — install Node.js LTS (which bundles npm), then try again.' };
  }
  console.log('Building the Forge Command Center dashboard for the first time (this can take a minute)...');
  const lockfile = path.join(dashboardDir, 'package-lock.json');
  const installArgs = fs.existsSync(lockfile) ? ['ci'] : ['install'];
  let res = doRunNpm(installArgs, dashboardDir);
  if (res.error || res.status !== 0) {
    return { ok: false, reason: 'npm ' + installArgs[0] + ' failed while preparing the dashboard build (see output above).' };
  }
  res = doRunNpm(['run', 'build'], dashboardDir);
  if (res.error || res.status !== 0) {
    return { ok: false, reason: 'npm run build failed while building the dashboard (see output above).' };
  }
  if (!fs.existsSync(distIndex)) {
    return { ok: false, reason: 'the build finished but dashboard/dist/index.html still does not exist — check the build output above.' };
  }
  return { ok: true, built: true };
}

/** pickEntry(ccRoot) -> absolute path to the script to run: gateway/supervisor.mjs (auto-restart on
 *  crash) when present, else gateway/bin.mjs directly. */
function pickEntry(ccRoot) {
  const supervisor = path.join(ccRoot, 'gateway', 'supervisor.mjs');
  if (fs.existsSync(supervisor)) return supervisor;
  return path.join(ccRoot, 'gateway', 'bin.mjs');
}

async function main() {
  const port = resolvePort(process.env);
  const url = 'http://127.0.0.1:' + port;

  const probe = await isAlreadyRunning(port, HEALTH_TIMEOUT_MS);
  if (probe.state === 'running') {
    console.log('Forge Command Center is already running at ' + url);
    process.exitCode = 0;
    return;
  }
  if (probe.state === 'conflict') {
    // LAUNCH-1 fix: never start a second instance against a port something ELSE already holds, and
    // never call that something else "the Command Center" either — one plain, honest sentence.
    console.log('Port ' + port + ' is already in use by something that is not the Forge Command Center '
      + '(its /api/health response does not match) — what is using it is unknown; free the port, or '
      + 'set CC_PORT to a different port, and try again.');
    process.exitCode = 1;
    return;
  }

  const found = findCommandCenter(PROJECT_ROOT, os.homedir());
  if (!found) {
    console.log('Forge Command Center is not installed on this machine yet — re-run ' + installerHint()
      + ' (the Forge installer) to set it up, then run "forge dashboard" again.');
    process.exitCode = 1;
    return;
  }

  const build = ensureBuilt(found.root);
  if (!build.ok) {
    console.log(build.reason);
    process.exitCode = 1;
    return;
  }

  const entry = pickEntry(found.root);
  console.log('Forge Command Center (' + found.origin + '): ' + url);
  const result = spawnSync(process.execPath, [entry], {
    stdio: 'inherit',
    env: Object.assign({}, process.env, { FORGE_CC_DEFAULT_PROJECT: PROJECT_ROOT }),
  });
  if (result.error) {
    console.error('Forge Command Center failed to start: ' + result.error.message);
    process.exitCode = 1;
    return;
  }
  process.exitCode = typeof result.status === 'number' ? result.status : 0;
}

if (require.main === module) {
  main().catch((e) => {
    console.error('forge-cc-launch: ' + (e && e.message ? e.message : String(e)));
    process.exitCode = 1;
  });
}

module.exports = {
  PROJECT_ROOT, HEALTH_TIMEOUT_MS,
  resolvePort, isAlreadyRunning, looksLikeCommandCenterHealth, findCommandCenter, installerHint, ensureBuilt, pickEntry,
  npmAvailable, runNpm, useShellForNpm,
};
