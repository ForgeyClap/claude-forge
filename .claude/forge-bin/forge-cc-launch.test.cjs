#!/usr/bin/env node
'use strict';
/**
 * forge-cc-launch.test.cjs — hermetic unit tests for forge-cc-launch.cjs (WP-P2, v2.9.0).
 *
 * SCOPE. These tests cover the pure/seam-based decision functions (resolvePort, isAlreadyRunning,
 * findCommandCenter, installerHint, ensureBuilt, pickEntry) against real temp directories and a real
 * ephemeral HTTP server (never a mocked fetch — isAlreadyRunning is exercised against genuine sockets so
 * the AbortSignal.timeout/fetch wiring itself is proven, not just the surrounding logic). npm is NEVER
 * actually invoked here — ensureBuilt's npmAvailableFn/runNpmFn seams are always overridden with fakes,
 * so this file stays fast, offline, and safe to run in any environment regardless of whether npm/network
 * access is available.
 *
 * WHAT THIS DOES NOT COVER (by design — see the work package's own live self-check instead): main()'s
 * full end-to-end flow (real os.homedir(), a real spawned gateway/supervisor process, this project's own
 * real PROJECT_ROOT) is an integration concern exercised by actually running forge.ps1/forge.cmd/forge.sh
 * `dashboard` against a real temp HOME with a real (copied) Command Center — not re-created here with
 * heavier mocking, which would prove far less than the real run does.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const {
  resolvePort, isAlreadyRunning, looksLikeCommandCenterHealth, findCommandCenter, installerHint, ensureBuilt, pickEntry,
} = require('./forge-cc-launch.cjs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}
async function tAsync(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

const TMP_DIRS_CREATED = [];
function mkTmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
  TMP_DIRS_CREATED.push(dir);
  return dir;
}
function cleanupTmpDirs() {
  for (const dir of TMP_DIRS_CREATED) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup only */ } }
}

// Wrapped in a single async function — this is a CommonJS (.cjs) file, where top-level `await` is a
// SyntaxError (that restriction is ES-module-only); everything below needs `await` available for the two
// real-socket isAlreadyRunning checks, so the whole body runs inside `run()` instead.
async function run() {
console.log('forge-cc-launch tests (WP-P2, v2.9.0 — hermetic, no real npm/gateway invocation)');

// --- resolvePort ------------------------------------------------------------------------------------------
t('resolvePort: unset CC_PORT falls back to 4100', () => {
  assert(resolvePort({}) === 4100, 'got ' + resolvePort({}));
});
t('resolvePort: a positive numeric string is used as-is', () => {
  assert(resolvePort({ CC_PORT: '5055' }) === 5055, 'got ' + resolvePort({ CC_PORT: '5055' }));
});
t('resolvePort: "0" falls back to 4100 (not a positive number)', () => {
  assert(resolvePort({ CC_PORT: '0' }) === 4100);
});
t('resolvePort: a negative value falls back to 4100', () => {
  assert(resolvePort({ CC_PORT: '-5' }) === 4100);
});
t('resolvePort: a non-numeric value falls back to 4100', () => {
  assert(resolvePort({ CC_PORT: 'not-a-port' }) === 4100);
});
t('resolvePort: an empty string falls back to 4100', () => {
  assert(resolvePort({ CC_PORT: '' }) === 4100);
});

// --- looksLikeCommandCenterHealth (pure, no sockets) -------------------------------------------------------
// A faithful mirror of command-center/gateway/src/health.mjs's real buildHealth() shape.
const REAL_HEALTH_BODY = {
  ok: true,
  runtime: { state: 'OK' },
  gateway: { version: '0.1.0', uptime_s: 5, project_root: 'C:\\fake\\root' },
  forge: { control_center: { state: 'RETIRED' }, doctor_last: { state: 'NOT CONFIGURED' } },
  execution: { state: 'UNKNOWN' },
  captured_at: new Date().toISOString(),
  age_ms: 0,
  provenance: 'LIVE',
};
t('looksLikeCommandCenterHealth: the real gateway health shape matches', () => {
  assert(looksLikeCommandCenterHealth(REAL_HEALTH_BODY) === true);
});
t('looksLikeCommandCenterHealth: DEGRADED (ok:false) still matches — the shape, not the verdict, is what counts', () => {
  assert(looksLikeCommandCenterHealth(Object.assign({}, REAL_HEALTH_BODY, { ok: false })) === true);
});
t('looksLikeCommandCenterHealth: null/non-object/array bodies never match', () => {
  assert(looksLikeCommandCenterHealth(null) === false);
  assert(looksLikeCommandCenterHealth(undefined) === false);
  assert(looksLikeCommandCenterHealth('a string') === false);
  assert(looksLikeCommandCenterHealth([1, 2, 3]) === false);
});
t('looksLikeCommandCenterHealth: a plausible but different JSON body does not match (missing gateway.version)', () => {
  assert(looksLikeCommandCenterHealth({ ok: true, status: 'healthy', service: 'some-other-app' }) === false);
});
t('looksLikeCommandCenterHealth: missing `runtime` alone is enough to reject', () => {
  const { runtime, ...withoutRuntime } = REAL_HEALTH_BODY;
  assert(looksLikeCommandCenterHealth(withoutRuntime) === false);
});
t('looksLikeCommandCenterHealth: a non-string gateway.version is rejected', () => {
  assert(looksLikeCommandCenterHealth(Object.assign({}, REAL_HEALTH_BODY, { gateway: { version: 123 } })) === false);
});

// --- isAlreadyRunning (real sockets, no mocked fetch) — LAUNCH-1 fix: 'running'/'not-running'/'conflict' ---
await tAsync('isAlreadyRunning: state "running" when the real Command Center health shape answers', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(REAL_HEALTH_BODY));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const result = await isAlreadyRunning(port, 1500);
    assert(result.state === 'running', 'expected state "running", got ' + JSON.stringify(result));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
await tAsync('isAlreadyRunning: state "not-running" when nothing is listening on the port', async () => {
  // Bind to an OS-assigned free port, then release it immediately — a strong (not absolute) signal that
  // nothing else is listening there for the immediately-following check.
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const result = await isAlreadyRunning(port, 500);
  assert(result.state === 'not-running', 'expected state "not-running", got ' + JSON.stringify(result));
});
// LAUNCH-1's exact reported bug: a plain 404 (or any non-matching response) on the port used to count as
// "already running" — must now be reported as a "conflict", never "running", and never started over.
await tAsync('isAlreadyRunning: state "conflict" when a plain 404 answers on the port (the exact LAUNCH-1 bug)', async () => {
  const server = http.createServer((req, res) => { res.writeHead(404); res.end('not found'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const result = await isAlreadyRunning(port, 1500);
    assert(result.state === 'conflict', 'expected state "conflict", got ' + JSON.stringify(result));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
await tAsync('isAlreadyRunning: state "conflict" when a non-Command-Center JSON body answers on the port', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, status: 'healthy', service: 'totally-unrelated-app' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const result = await isAlreadyRunning(port, 1500);
    assert(result.state === 'conflict', 'expected state "conflict", got ' + JSON.stringify(result));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// --- findCommandCenter -------------------------------------------------------------------------------------
t('findCommandCenter: returns null when neither project-local nor central exists', () => {
  const projectRoot = mkTmp('ccl-none-project');
  const homeDir = mkTmp('ccl-none-home');
  assert(findCommandCenter(projectRoot, homeDir) === null);
});
t('findCommandCenter: finds a project-local command-center/gateway/bin.mjs', () => {
  const projectRoot = mkTmp('ccl-local-project');
  const homeDir = mkTmp('ccl-local-home');
  const gwDir = path.join(projectRoot, 'command-center', 'gateway');
  fs.mkdirSync(gwDir, { recursive: true });
  fs.writeFileSync(path.join(gwDir, 'bin.mjs'), '// fixture');
  const found = findCommandCenter(projectRoot, homeDir);
  assert(found && found.origin === 'project-local', JSON.stringify(found));
  assert(found.root === path.join(projectRoot, 'command-center'), found.root);
});
t('findCommandCenter: falls back to the central template copy when there is no project-local one', () => {
  const projectRoot = mkTmp('ccl-central-project');
  const homeDir = mkTmp('ccl-central-home');
  const gwDir = path.join(homeDir, '.claude', 'forge', 'template', 'command-center', 'gateway');
  fs.mkdirSync(gwDir, { recursive: true });
  fs.writeFileSync(path.join(gwDir, 'bin.mjs'), '// fixture');
  const found = findCommandCenter(projectRoot, homeDir);
  assert(found && found.origin === 'central', JSON.stringify(found));
});
t('findCommandCenter: project-local takes priority when BOTH exist', () => {
  const projectRoot = mkTmp('ccl-both-project');
  const homeDir = mkTmp('ccl-both-home');
  const localGw = path.join(projectRoot, 'command-center', 'gateway');
  fs.mkdirSync(localGw, { recursive: true });
  fs.writeFileSync(path.join(localGw, 'bin.mjs'), '// fixture');
  const centralGw = path.join(homeDir, '.claude', 'forge', 'template', 'command-center', 'gateway');
  fs.mkdirSync(centralGw, { recursive: true });
  fs.writeFileSync(path.join(centralGw, 'bin.mjs'), '// fixture');
  const found = findCommandCenter(projectRoot, homeDir);
  assert(found.origin === 'project-local', JSON.stringify(found));
});

// --- installerHint -----------------------------------------------------------------------------------------
t('installerHint: win32 names install.ps1', () => {
  assert(installerHint('win32') === 'install.ps1');
});
t('installerHint: darwin/linux name install.sh', () => {
  assert(installerHint('darwin') === 'install.sh');
  assert(installerHint('linux') === 'install.sh');
});

// --- pickEntry ---------------------------------------------------------------------------------------------
t('pickEntry: prefers gateway/supervisor.mjs when it exists', () => {
  const ccRoot = mkTmp('ccl-entry-sup');
  fs.mkdirSync(path.join(ccRoot, 'gateway'), { recursive: true });
  fs.writeFileSync(path.join(ccRoot, 'gateway', 'supervisor.mjs'), '// fixture');
  fs.writeFileSync(path.join(ccRoot, 'gateway', 'bin.mjs'), '// fixture');
  assert(pickEntry(ccRoot) === path.join(ccRoot, 'gateway', 'supervisor.mjs'));
});
t('pickEntry: falls back to gateway/bin.mjs when there is no supervisor', () => {
  const ccRoot = mkTmp('ccl-entry-bin');
  fs.mkdirSync(path.join(ccRoot, 'gateway'), { recursive: true });
  fs.writeFileSync(path.join(ccRoot, 'gateway', 'bin.mjs'), '// fixture');
  assert(pickEntry(ccRoot) === path.join(ccRoot, 'gateway', 'bin.mjs'));
});

// --- ensureBuilt (npm always faked via injected seams — never a real npm process) ---------------------------
t('ensureBuilt: dist/index.html already present -> ok, built:false, npm never consulted', () => {
  const ccRoot = mkTmp('ccl-build-already');
  const distDir = path.join(ccRoot, 'dashboard', 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, 'index.html'), '<html></html>');
  let calls = 0;
  const res = ensureBuilt(ccRoot, { npmAvailableFn: () => { calls++; return true; } });
  assert(res.ok === true && res.built === false, JSON.stringify(res));
  assert(calls === 0, 'npmAvailableFn should never be called when dist already exists');
});
t('ensureBuilt: no dashboard/package.json at all -> honest failure naming the installer', () => {
  const ccRoot = mkTmp('ccl-build-nopkg');
  fs.mkdirSync(path.join(ccRoot, 'dashboard'), { recursive: true });
  const res = ensureBuilt(ccRoot);
  assert(res.ok === false, JSON.stringify(res));
  assert(/install\.(ps1|sh)/.test(res.reason), 'reason should name an installer: ' + res.reason);
});
t('ensureBuilt: package.json exists but npm is unavailable -> honest failure naming npm', () => {
  const ccRoot = mkTmp('ccl-build-nonpm');
  fs.mkdirSync(path.join(ccRoot, 'dashboard'), { recursive: true });
  fs.writeFileSync(path.join(ccRoot, 'dashboard', 'package.json'), '{}');
  const res = ensureBuilt(ccRoot, { npmAvailableFn: () => false });
  assert(res.ok === false, JSON.stringify(res));
  assert(/npm/i.test(res.reason), res.reason);
});
t('ensureBuilt: uses "npm ci" when package-lock.json exists', () => {
  const ccRoot = mkTmp('ccl-build-ci');
  const dashboardDir = path.join(ccRoot, 'dashboard');
  fs.mkdirSync(dashboardDir, { recursive: true });
  fs.writeFileSync(path.join(dashboardDir, 'package.json'), '{}');
  fs.writeFileSync(path.join(dashboardDir, 'package-lock.json'), '{}');
  const calls = [];
  const res = ensureBuilt(ccRoot, {
    npmAvailableFn: () => true,
    runNpmFn: (args, cwd) => {
      calls.push(args.join(' '));
      if (args[0] === 'run' && args[1] === 'build') {
        fs.mkdirSync(path.join(dashboardDir, 'dist'), { recursive: true });
        fs.writeFileSync(path.join(dashboardDir, 'dist', 'index.html'), '<html></html>');
      }
      return { status: 0, error: null };
    },
  });
  assert(res.ok === true && res.built === true, JSON.stringify(res));
  assert(calls[0] === 'ci', 'expected first npm call to be "ci", got: ' + calls[0]);
  assert(calls[1] === 'run build', 'expected second npm call to be "run build", got: ' + calls[1]);
});
t('ensureBuilt: uses "npm install" when there is no lockfile', () => {
  const ccRoot = mkTmp('ccl-build-install');
  const dashboardDir = path.join(ccRoot, 'dashboard');
  fs.mkdirSync(dashboardDir, { recursive: true });
  fs.writeFileSync(path.join(dashboardDir, 'package.json'), '{}');
  const calls = [];
  ensureBuilt(ccRoot, {
    npmAvailableFn: () => true,
    runNpmFn: (args) => {
      calls.push(args.join(' '));
      if (args[0] === 'run') {
        fs.mkdirSync(path.join(dashboardDir, 'dist'), { recursive: true });
        fs.writeFileSync(path.join(dashboardDir, 'dist', 'index.html'), '<html></html>');
      }
      return { status: 0, error: null };
    },
  });
  assert(calls[0] === 'install', 'expected first npm call to be "install", got: ' + calls[0]);
});
t('ensureBuilt: install failure stops before ever running the build step', () => {
  const ccRoot = mkTmp('ccl-build-installfail');
  const dashboardDir = path.join(ccRoot, 'dashboard');
  fs.mkdirSync(dashboardDir, { recursive: true });
  fs.writeFileSync(path.join(dashboardDir, 'package.json'), '{}');
  const calls = [];
  const res = ensureBuilt(ccRoot, {
    npmAvailableFn: () => true,
    runNpmFn: (args) => { calls.push(args.join(' ')); return { status: 1, error: null }; },
  });
  assert(res.ok === false, JSON.stringify(res));
  assert(/npm install failed/.test(res.reason), res.reason);
  assert(calls.length === 1, 'the build step must not run after a failed install; calls=' + JSON.stringify(calls));
});
t('ensureBuilt: build-step failure is reported honestly', () => {
  const ccRoot = mkTmp('ccl-build-buildfail');
  const dashboardDir = path.join(ccRoot, 'dashboard');
  fs.mkdirSync(dashboardDir, { recursive: true });
  fs.writeFileSync(path.join(dashboardDir, 'package.json'), '{}');
  const res = ensureBuilt(ccRoot, {
    npmAvailableFn: () => true,
    runNpmFn: (args) => (args[0] === 'install' ? { status: 0, error: null } : { status: 1, error: null }),
  });
  assert(res.ok === false, JSON.stringify(res));
  assert(/npm run build failed/.test(res.reason), res.reason);
});
t('ensureBuilt: a "successful" build that never actually produced dist/index.html is still reported as a failure', () => {
  const ccRoot = mkTmp('ccl-build-silentfail');
  const dashboardDir = path.join(ccRoot, 'dashboard');
  fs.mkdirSync(dashboardDir, { recursive: true });
  fs.writeFileSync(path.join(dashboardDir, 'package.json'), '{}');
  const res = ensureBuilt(ccRoot, {
    npmAvailableFn: () => true,
    runNpmFn: () => ({ status: 0, error: null }), // exits 0 but never writes dist/index.html
  });
  assert(res.ok === false, JSON.stringify(res));
  assert(/dist\/index\.html/.test(res.reason), res.reason);
});

cleanupTmpDirs();
console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
}

run().catch((e) => {
  console.error('forge-cc-launch.test.cjs: unexpected error — ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
