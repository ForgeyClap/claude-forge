// WP-P1 (Forge v2.9.0, "the Command Center works after a fresh install") — end-to-end coverage,
// through the real listProjects()/computeProjectsAsync(), of the three things this WP adds to
// project discovery:
//   1. the installer's own recorded list (~/.claude/forge/projects.json) is merged in as an
//      ADDITIONAL source, alongside forge-sync.cjs's own scan-root results, deduplicated the same
//      way as any other source;
//   2. the central template install's own host folder can never appear as a project, from EITHER
//      source, and can never be chosen as the default project either;
//   3. FORGE_CC_DEFAULT_PROJECT, when it resolves to a real discovered project, is surfaced as
//      `default_project_id` on the GET-shaped result.
//
// Same isolation shape as projects-multiroot.test.mjs (real forge-sync.cjs, found by walking up
// from PROJECT_ROOT; every test skips honestly if that tool cannot be found rather than assuming
// a wrong path) — see that file's own header for the full rationale.
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
  _setTemplateDirForTests,
  _resetTemplateDirForTests,
  _setDefaultProjectPathForTests,
  _resetDefaultProjectPathForTests,
} from '../src/projects.mjs';
import { _setInstalledProjectsFileForTests, _resetInstalledProjectsFileForTests } from '../src/installed-projects.mjs';
import { PROJECT_ROOT } from '../src/paths.mjs';

function findRealForgeSyncCjs() {
  let dir = PROJECT_ROOT;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, '.claude', 'forge-bin', 'forge-sync.cjs');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const REAL_FORGE_SYNC_CJS = findRealForgeSyncCjs();
const SKIP_REASON = REAL_FORGE_SYNC_CJS
  ? false
  : 'no real .claude/forge-bin/forge-sync.cjs found by walking up from PROJECT_ROOT — this suite needs the real, already-reviewed tool to spawn against isolated fixtures.';

let tempRoots = [];
let installedProjectsFile;

function makeRealProjectDir(baseDir, name) {
  const dir = path.join(baseDir, name);
  fs.mkdirSync(path.join(dir, '.claude', 'forge-dashboard'), { recursive: true });
  return dir;
}

function makeEmptyScanRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-installer-merge-test-root-'));
  tempRoots.push(root);
  return root;
}

function writeInstalledProjectsFile(projects) {
  fs.writeFileSync(installedProjectsFile, JSON.stringify({ schema: 1, projects }), 'utf8');
}

beforeEach(() => {
  tempRoots = [];
  _resetProjectsCacheForTests();
  if (REAL_FORGE_SYNC_CJS) _setForgeSyncCjsForTests(REAL_FORGE_SYNC_CJS);
  // An empty (but real, existing) scan root by default — most tests below care about the
  // installer-list/template-dir/default-project logic, not the scan side, and a genuinely empty
  // root is honestly "0 found there" (per forge-sync.cjs's own contract), never a scan failure.
  _setScanRootsForTests([makeEmptyScanRoot()]);
  const installerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-installer-merge-test-installer-'));
  tempRoots.push(installerDir);
  installedProjectsFile = path.join(installerDir, 'projects.json');
  _setInstalledProjectsFileForTests(installedProjectsFile); // file does not exist yet by default
  _setDefaultProjectPathForTests('');
});

after(() => {
  _resetForgeSyncCjsForTests();
  _resetScanRootsForTests();
  _resetInstalledProjectsFileForTests();
  _resetTemplateDirForTests();
  _resetDefaultProjectPathForTests();
  _resetProjectsCacheForTests();
});

function cleanup() {
  for (const r of tempRoots) fs.rmSync(r, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
}

/* ---------------------------------------------------------- 1. installer-list merge */

test('a project known ONLY to the installer file (no scan root finds it) is still discovered', { skip: SKIP_REASON }, async () => {
  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-installer-merge-test-proj-'));
  tempRoots.push(projDir);
  const proj = makeRealProjectDir(projDir, 'installer-only-proj');
  writeInstalledProjectsFile([proj]);
  _resetProjectsCacheForTests();

  const result = await listProjects();
  assert.equal(result.ok, true);
  assert.ok(result.projects.some((p) => p.name === 'installer-only-proj'));
  cleanup();
});

test('the SAME project found by BOTH a scan root and the installer file is returned exactly once', { skip: SKIP_REASON }, async () => {
  const scanRoot = makeEmptyScanRoot();
  _setScanRootsForTests([scanRoot]);
  const proj = makeRealProjectDir(scanRoot, 'both-sources-proj');
  writeInstalledProjectsFile([proj]);
  _resetProjectsCacheForTests();

  const result = await listProjects();
  assert.equal(result.ok, true);
  const matches = result.projects.filter((p) => p.name === 'both-sources-proj');
  assert.equal(matches.length, 1, 'the same real, resolved path from two sources must never be double-counted');
  cleanup();
});

test('every scan root failing does not hide a project the installer file alone still knows about', { skip: SKIP_REASON }, async () => {
  // A stub forge-sync.cjs whose spawn always fails — mirrors projects-multiroot.test.mjs's own
  // "FAIL-THIS-ROOT" stub shape, reused here for the SAME reason: the real tool never fails on an
  // ordinary missing/empty directory, so a deliberate stub is needed to prove this branch.
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-installer-merge-test-stub-'));
  tempRoots.push(stubDir);
  const stubPath = path.join(stubDir, 'stub-forge-sync.cjs');
  fs.writeFileSync(stubPath, "console.error('stub: always fails'); process.exit(1);\n", 'utf8');
  _setForgeSyncCjsForTests(stubPath);
  _setScanRootsForTests([path.join(stubDir, 'some-root')]);

  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-installer-merge-test-proj2-'));
  tempRoots.push(projDir);
  const proj = makeRealProjectDir(projDir, 'installer-survives-total-scan-failure');
  writeInstalledProjectsFile([proj]);
  _resetProjectsCacheForTests();

  const result = await listProjects();
  assert.equal(result.ok, true, 'the installer list alone must be enough for an honest ok:true result');
  assert.ok(result.projects.some((p) => p.name === 'installer-survives-total-scan-failure'));
  cleanup();
});

test('an installer file with nothing valid in it, on top of every scan root failing, is an honest ok:false', { skip: SKIP_REASON }, async () => {
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-installer-merge-test-stub2-'));
  tempRoots.push(stubDir);
  const stubPath = path.join(stubDir, 'stub-forge-sync.cjs');
  fs.writeFileSync(stubPath, "console.error('stub: always fails'); process.exit(1);\n", 'utf8');
  _setForgeSyncCjsForTests(stubPath);
  _setScanRootsForTests([path.join(stubDir, 'some-root')]);
  writeInstalledProjectsFile([]); // present, valid, but empty
  _resetProjectsCacheForTests();

  const result = await listProjects();
  assert.equal(result.ok, false);
  assert.deepEqual(result.projects, []);
  cleanup();
});

/* ---------------------------------------------------------------- 2. template-dir filter */

test('a candidate resolving to the (overridden) template dir is excluded, from a scan root', { skip: SKIP_REASON }, async () => {
  const scanRoot = makeEmptyScanRoot();
  _setScanRootsForTests([scanRoot]);
  const templateLookalike = makeRealProjectDir(scanRoot, 'template');
  _setTemplateDirForTests(templateLookalike);
  _resetProjectsCacheForTests();

  const result = await listProjects();
  assert.equal(result.ok, true);
  assert.ok(!result.projects.some((p) => p.path === path.resolve(templateLookalike)), 'the template host must never appear as a project');
  cleanup();
});

test('a candidate resolving to the (overridden) template dir is excluded, from the installer file too', { skip: SKIP_REASON }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-installer-merge-test-tmpl-'));
  tempRoots.push(dir);
  const templateLookalike = makeRealProjectDir(dir, 'template');
  _setTemplateDirForTests(templateLookalike);
  writeInstalledProjectsFile([templateLookalike]);
  _resetProjectsCacheForTests();

  const result = await listProjects();
  assert.equal(result.ok, true);
  assert.deepEqual(result.projects, [], 'the ONLY candidate was the template host — it must be excluded, leaving no projects');
  cleanup();
});

test('a differently-named/pathed folder is NOT filtered — the exclusion is scoped to the exact template path, not anything generic', { skip: SKIP_REASON }, async () => {
  const scanRoot = makeEmptyScanRoot();
  _setScanRootsForTests([scanRoot]);
  const realProj = makeRealProjectDir(scanRoot, 'genuinely-named-template-but-not-the-real-one');
  const someOtherTemplateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-installer-merge-test-othertmpl-'));
  tempRoots.push(someOtherTemplateDir);
  _setTemplateDirForTests(someOtherTemplateDir); // the exclusion target — NOT realProj's path
  _resetProjectsCacheForTests();

  const result = await listProjects();
  assert.equal(result.ok, true);
  assert.ok(result.projects.some((p) => p.name === 'genuinely-named-template-but-not-the-real-one'));
  cleanup();
});

/* ------------------------------------------------------------------ 3. default_project_id */

test('FORGE_CC_DEFAULT_PROJECT resolving to a real discovered project surfaces its name as default_project_id', { skip: SKIP_REASON }, async () => {
  const scanRoot = makeEmptyScanRoot();
  _setScanRootsForTests([scanRoot]);
  const proj = makeRealProjectDir(scanRoot, 'default-me');
  _setDefaultProjectPathForTests(proj);
  _resetProjectsCacheForTests();

  const result = await listProjects();
  assert.equal(result.ok, true);
  assert.equal(result.default_project_id, 'default-me');
  cleanup();
});

test('FORGE_CC_DEFAULT_PROJECT pointing at an unknown path never invents a default', { skip: SKIP_REASON }, async () => {
  const scanRoot = makeEmptyScanRoot();
  _setScanRootsForTests([scanRoot]);
  makeRealProjectDir(scanRoot, 'some-real-proj');
  _setDefaultProjectPathForTests(path.join(scanRoot, 'not-a-real-discovered-project'));
  _resetProjectsCacheForTests();

  const result = await listProjects();
  assert.equal(result.ok, true);
  assert.equal(result.default_project_id, null);
  cleanup();
});

test('an unset FORGE_CC_DEFAULT_PROJECT reports default_project_id: null, never a guess', { skip: SKIP_REASON }, async () => {
  const scanRoot = makeEmptyScanRoot();
  _setScanRootsForTests([scanRoot]);
  makeRealProjectDir(scanRoot, 'some-real-proj');
  _resetProjectsCacheForTests();

  const result = await listProjects();
  assert.equal(result.ok, true);
  assert.equal(result.default_project_id, null);
  cleanup();
});

test('FORGE_CC_DEFAULT_PROJECT pointing at the template host itself never becomes the default (it was already excluded from projects)', { skip: SKIP_REASON }, async () => {
  const scanRoot = makeEmptyScanRoot();
  _setScanRootsForTests([scanRoot]);
  const templateLookalike = makeRealProjectDir(scanRoot, 'template');
  _setTemplateDirForTests(templateLookalike);
  _setDefaultProjectPathForTests(templateLookalike);
  _resetProjectsCacheForTests();

  const result = await listProjects();
  assert.equal(result.ok, true);
  assert.equal(result.default_project_id, null);
  cleanup();
});
