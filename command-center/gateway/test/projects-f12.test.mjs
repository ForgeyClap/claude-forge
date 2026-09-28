// Codex run B F-12 — "registered project paths have inconsistent containment". Two scenarios:
//   1. a SCAN-discovered candidate that resolves (via a junction) OUTSIDE every real scan root must
//      be rejected, never silently trusted just because it was lexically found inside one;
//   2. the admitted-roots boundary every OTHER per-project route checks is kept in sync with the
//      registry — a project the installer registered outside the scan roots must be usable by
//      those other routes too (getContainmentRoots()), not just listed by GET /api/projects.
// Windows junctions (unlike symlinks) need no admin rights here.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  listProjects,
  _resetProjectsCacheForTests,
  _setForgeSyncCjsForTests,
  _resetForgeSyncCjsForTests,
  _setScanRootsForTests,
  _resetScanRootsForTests,
} from '../src/projects.mjs';
import { _setInstalledProjectsFileForTests, _resetInstalledProjectsFileForTests } from '../src/installed-projects.mjs';
import { getContainmentRoots, _resetAdmittedRegistryRootsForTests } from '../src/admitted-roots.mjs';
import { anyContainmentOk } from '../src/security.mjs';

const tempRoots = [];
function freshDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}
function makeRealProjectDir(baseDir, name) {
  const dir = path.join(baseDir, name);
  fs.mkdirSync(path.join(dir, '.claude', 'forge-dashboard'), { recursive: true });
  return dir;
}
function writeStubForgeSync(reportedPaths) {
  const stubDir = freshDir('cc-f12-stub-');
  const stubPath = path.join(stubDir, 'stub-forge-sync.cjs');
  const lines = ["process.stdout.write('" + reportedPaths.length + " Forge project(s) under X:\\n');"];
  for (const p of reportedPaths) lines.push('process.stdout.write(' + JSON.stringify('  ' + p + '\n') + ');');
  fs.writeFileSync(stubPath, lines.join('\n'), 'utf8');
  return stubPath;
}
const GUARANTEED_ABSENT_INSTALLED_PROJECTS_FILE = path.join(os.tmpdir(), 'cc-f12-test-installed-projects-never-created.json');

beforeEach(() => {
  _resetProjectsCacheForTests();
  _resetAdmittedRegistryRootsForTests();
  _setInstalledProjectsFileForTests(GUARANTEED_ABSENT_INSTALLED_PROJECTS_FILE);
});

after(() => {
  _resetForgeSyncCjsForTests();
  _resetScanRootsForTests();
  _resetInstalledProjectsFileForTests();
  _resetProjectsCacheForTests();
  _resetAdmittedRegistryRootsForTests();
  for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true });
});

test('F-12 hostile: a scan-discovered junction resolving OUTSIDE the scan root is rejected, never listed', async () => {
  const scanRoot = freshDir('cc-f12-scanroot-');
  const outsideDir = freshDir('cc-f12-outside-'); // a sibling temp dir, NOT inside scanRoot
  const realOutsideProject = makeRealProjectDir(outsideDir, 'real-outside-project');
  const junctionInsideScanRoot = path.join(scanRoot, 'looks-local');
  fs.symlinkSync(realOutsideProject, junctionInsideScanRoot, 'junction');

  const stub = writeStubForgeSync([junctionInsideScanRoot]);
  _setForgeSyncCjsForTests(stub);
  _setScanRootsForTests([scanRoot]);
  _resetProjectsCacheForTests();

  const result = await listProjects();
  assert.equal(result.ok, true);
  assert.ok(!result.projects.some((p) => p.name === 'real-outside-project'), 'a junction resolving outside every real scan root must never be admitted');
});

test('F-12 ordinary case: a scan-discovered junction resolving INSIDE a real scan root is admitted, by its real target path', async () => {
  const scanRoot = freshDir('cc-f12-scanroot-ok-');
  const realProjectInsideRoot = makeRealProjectDir(scanRoot, 'real-target-inside');
  const junctionPath = path.join(scanRoot, 'linked-alias');
  fs.symlinkSync(realProjectInsideRoot, junctionPath, 'junction');

  const stub = writeStubForgeSync([junctionPath]);
  _setForgeSyncCjsForTests(stub);
  _setScanRootsForTests([scanRoot]);
  _resetProjectsCacheForTests();

  const result = await listProjects();
  assert.equal(result.ok, true);
  const found = result.projects.find((p) => p.name === 'real-target-inside');
  assert.ok(found, 'a junction whose real target genuinely sits inside a real scan root must still be admitted');
  assert.equal(found.path, fs.realpathSync.native(realProjectInsideRoot));
});

test('F-12: a registry project outside the scan roots becomes an admitted containment root for every OTHER route', async () => {
  const registryProjectDir = freshDir('cc-f12-registry-outside-');
  const realProject = makeRealProjectDir(registryProjectDir, 'registry-only-project');
  const installedProjectsFile = path.join(freshDir('cc-f12-installer-file-'), 'projects.json');
  fs.writeFileSync(installedProjectsFile, JSON.stringify({ schema: 1, projects: [realProject] }), 'utf8');
  _setInstalledProjectsFileForTests(installedProjectsFile);
  // No scan roots contribute anything real.
  _setScanRootsForTests([freshDir('cc-f12-empty-scanroot-')]);
  _setForgeSyncCjsForTests(writeStubForgeSync([]));
  _resetProjectsCacheForTests();

  const result = await listProjects();
  assert.equal(result.ok, true);
  assert.ok(result.projects.some((p) => p.name === 'registry-only-project'), 'sanity check: the project is listed');

  // The REAL point of F-12: getContainmentRoots() (what runs.mjs/server.mjs/etc. all check a
  // per-project route's own resolved path against) must now include this exact real path.
  const realProjectPath = fs.realpathSync.native(realProject);
  assert.ok(
    anyContainmentOk(getContainmentRoots(), realProjectPath),
    'a registry project outside every scan root must be usable by every OTHER per-project route, not just listed here',
  );
});

test('F-12: de-registering a project (it no longer appears in the installer file) removes it as an admitted root on the next recompute', async () => {
  const registryProjectDir = freshDir('cc-f12-deregister-');
  const realProject = makeRealProjectDir(registryProjectDir, 'soon-deregistered');
  const installedProjectsFile = path.join(freshDir('cc-f12-installer-file-2-'), 'projects.json');
  fs.writeFileSync(installedProjectsFile, JSON.stringify({ schema: 1, projects: [realProject] }), 'utf8');
  _setInstalledProjectsFileForTests(installedProjectsFile);
  _setScanRootsForTests([freshDir('cc-f12-empty-scanroot-2-')]);
  _setForgeSyncCjsForTests(writeStubForgeSync([]));
  _resetProjectsCacheForTests();

  await listProjects();
  const realProjectPath = fs.realpathSync.native(realProject);
  assert.ok(anyContainmentOk(getContainmentRoots(), realProjectPath), 'admitted while still registered');

  // The installer removes the entry (de-registers the project) — next recompute must drop it too.
  fs.writeFileSync(installedProjectsFile, JSON.stringify({ schema: 1, projects: [] }), 'utf8');
  _resetProjectsCacheForTests();
  await listProjects();
  assert.ok(!anyContainmentOk(getContainmentRoots(), realProjectPath), 'no longer registered -> no longer an admitted root');
});
