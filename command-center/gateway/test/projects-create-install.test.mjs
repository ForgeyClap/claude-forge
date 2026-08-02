// build-fullinstall: `installForgeInto()` — the real Forge installer this project now spawns
// (as a child process) right after scaffolding a new project directory. Every scenario here stubs
// the child-process call via `_setInstallRunnerForTests` (same pattern as `_setProjectsRootForTests`,
// already used by ../test/routes-project-create.test.mjs) — this suite NEVER spawns a real
// `forge-sync.cjs install` and NEVER writes into the real Documents\ForgeProjecten.
//
// installForgeInto()'s containment check is against the REAL, non-overridable FORGE_PROJECTS_ROOT
// (see its own header comment) — a stub-only unit test can therefore reference that real constant as
// a path PREFIX without ever creating anything there: containmentOk() is pure string comparison, and
// the runner is always stubbed here, so nothing ever touches disk under it.
//
// build-async-install adds: `startDetachedInstall()` / the in-memory install-status map it drives.
// Same safe pattern — `startDetachedInstall(name, target)` is called DIRECTLY with a `target` under
// the real FORGE_PROJECTS_ROOT (never actually created on disk: the runner is stubbed, and
// `startDetachedInstall` itself never calls `fs.mkdirSync`), so these tests exercise the real
// installing->installed / installing->failed status transitions with zero real spawns and zero real
// directory writes — mirroring the existing `installForgeInto()` tests' own approach below.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FORGE_PROJECTS_ROOT } from '../src/paths.mjs';
import {
  createProject,
  installForgeInto,
  startDetachedInstall,
  getInstallStatus,
  _resetInstallStatusForTests,
  _awaitInstallForTests,
  _setProjectsRootForTests,
  _resetProjectsRootForTests,
  _setInstallRunnerForTests,
  _resetInstallRunnerForTests,
} from '../src/projects-create.mjs';

afterEach(() => {
  _resetInstallRunnerForTests();
  _resetInstallStatusForTests();
});

test('installForgeInto: a clean exit (no error) reports installed:true with no reason', async () => {
  let calledWith = null;
  _setInstallRunnerForTests(async (targetDir) => {
    calledWith = targetDir;
    return { error: null, stdout: 'probe-project: OK\n', stderr: '' };
  });
  const target = path.join(FORGE_PROJECTS_ROOT, '__cc-gateway-install-test-fixture__', 'Demo Project A');
  const result = await installForgeInto(target);
  assert.equal(result.installed, true);
  assert.equal(result.attempted, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.reason, null);
  assert.equal(calledWith, target);
});

test('installForgeInto: a non-zero exit reports installed:false with a redacted reason (never a fake success)', async () => {
  _setInstallRunnerForTests(async () => ({
    error: { message: 'Command failed', code: 1, killed: false, signal: null },
    stdout: '',
    stderr: 'probe-project: FAILED (forge-doctor found a real regression) leaked key nvapi-ABCDEFGHIJ1234567890',
  }));
  const target = path.join(FORGE_PROJECTS_ROOT, '__cc-gateway-install-test-fixture__', 'Demo Project B');
  const result = await installForgeInto(target);
  assert.equal(result.installed, false);
  assert.equal(result.attempted, true);
  assert.equal(result.timedOut, false);
  assert.match(result.reason, /FAILED/);
  assert.match(result.reason, /exit code 1/);
  assert.match(result.reason, /\[REDACTED:NVIDIA_API_KEY\]/);
  assert.doesNotMatch(result.reason, /nvapi-ABCDEFGHIJ1234567890/);
});

test('installForgeInto: a timed-out child reports installed:false, timedOut:true (never a fake success)', async () => {
  _setInstallRunnerForTests(async () => ({
    error: { message: 'Command failed', code: null, killed: true, signal: 'SIGTERM' },
    stdout: '',
    stderr: '',
  }));
  const target = path.join(FORGE_PROJECTS_ROOT, '__cc-gateway-install-test-fixture__', 'Demo Project C');
  const result = await installForgeInto(target);
  assert.equal(result.installed, false);
  assert.equal(result.attempted, true);
  assert.equal(result.timedOut, true);
  assert.match(result.reason, /timed out/);
});

test('installForgeInto: refuses (never spawns anything) for a target outside the real Forge projects root', async () => {
  let called = false;
  _setInstallRunnerForTests(async () => {
    called = true;
    return { error: null, stdout: '', stderr: '' };
  });
  const outside = path.join(os.tmpdir(), '__cc-gateway-install-test-outside-root__', 'Demo Project');
  const result = await installForgeInto(outside);
  assert.equal(result.installed, false);
  assert.equal(result.attempted, false);
  assert.equal(called, false);
  assert.match(result.reason, /outside the real Forge projects root/);
});

// build-async-install: `startDetachedInstall()` status-map transitions, exercised DIRECTLY (never
// through createProject()'s own scaffold) so no real directory needs to exist under
// FORGE_PROJECTS_ROOT — the stubbed runner never touches disk, and `startDetachedInstall` itself
// never calls `fs.mkdirSync`.
test('startDetachedInstall: records installing synchronously, then installed once the stubbed runner resolves clean', async () => {
  _setInstallRunnerForTests(async () => ({ error: null, stdout: 'probe-project: OK\n', stderr: '' }));
  const name = '__cc-status-test-installed__';
  const target = path.join(FORGE_PROJECTS_ROOT, '__cc-gateway-install-test-fixture__', name);

  startDetachedInstall(name, target);
  // Recorded synchronously, BEFORE the (stubbed) installer's promise has any chance to settle —
  // this ordering is deterministic (no timer/microtask race): startDetachedInstall writes
  // 'installing' to the map before it ever calls the async installForgeInto().
  const initial = getInstallStatus(name);
  assert.equal(initial.state, 'installing');
  assert.equal(initial.reason, null);
  assert.equal(initial.finished_at, null);
  assert.equal(typeof initial.started_at, 'string');

  await _awaitInstallForTests(name);
  const final = getInstallStatus(name);
  assert.equal(final.state, 'installed');
  assert.equal(final.reason, null);
  assert.equal(typeof final.finished_at, 'string');
  assert.equal(final.started_at, initial.started_at);
});

test('startDetachedInstall: installing -> failed with a redacted reason when the stubbed runner reports a non-zero exit', async () => {
  _setInstallRunnerForTests(async () => ({
    error: { message: 'Command failed', code: 1, killed: false, signal: null },
    stdout: '',
    stderr: 'probe-project: FAILED leaked key nvapi-ABCDEFGHIJ1234567890',
  }));
  const name = '__cc-status-test-failed__';
  const target = path.join(FORGE_PROJECTS_ROOT, '__cc-gateway-install-test-fixture__', name);

  startDetachedInstall(name, target);
  assert.equal(getInstallStatus(name).state, 'installing');

  await _awaitInstallForTests(name);
  const final = getInstallStatus(name);
  assert.equal(final.state, 'failed');
  assert.match(final.reason, /exit code 1/);
  assert.match(final.reason, /\[REDACTED:NVIDIA_API_KEY\]/);
  assert.doesNotMatch(final.reason, /nvapi-ABCDEFGHIJ1234567890/);
});

test('getInstallStatus: returns null for a name nothing was ever recorded for (the GET route reports this as state:"unknown")', () => {
  assert.equal(getInstallStatus('__cc-status-test-never-recorded__'), null);
});

// Wiring + safety check at the createProject() level: a project scaffolded under an isolated test
// root (the SAME `_setProjectsRootForTests` seam ../test/routes-project-create.test.mjs already uses,
// deliberately with NO install-runner stub here) must still come back 201 WITHOUT ever waiting for
// the installer (build-async-install's whole point), and the detached install must still honestly
// settle to a 'failed' status with the containment reason once awaited — proving both that
// createProject() never blocks on it, and that this isolated-root test pattern can never trigger a
// real install by accident (the exact regression a first draft of installForgeInto's containment
// check produced: two real ~60s `forge-sync.cjs install` child processes spawned from
// ../test/routes-project-create.test.mjs before the fix, confirmed live and fixed by checking the
// REAL FORGE_PROJECTS_ROOT constant instead of the test-overridable activeProjectsRoot()).
let tempRoot;

before(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gateway-install-wiring-test-'));
  _setProjectsRootForTests(tempRoot);
});

after(() => {
  _resetProjectsRootForTests();
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

test('createProject(): 201 returns immediately (never awaits the installer); the detached install honestly settles to failed with the containment reason', async () => {
  const name = 'Wired Containment Project';
  const result = await createProject({ name });
  assert.equal(result.status, 201);
  assert.equal(result.body.ok, true);
  assert.equal('forge_installed' in result.body, false);

  await _awaitInstallForTests(name);
  const status = getInstallStatus(name);
  assert.equal(status.state, 'failed');
  assert.match(status.reason, /outside the real Forge projects root/);
});
