// WP-CC1 (item 4): default_project_id, when FORGE_CC_DEFAULT_PROJECT is unset, now falls back to
// the discovered project with the most recent REAL work event (runs.mjs's mostRecentWorkSignalMs)
// instead of staying null forever — the supervisor path (every real production launch) never sets
// that env var, so before this fix a dashboard never had a sensible default project on a normal
// launch. This fixture is nested under COMMAND_CENTER_DATA_DIR (not plain os.tmpdir(), unlike this
// suite's sibling projects-installed-and-template.test.mjs) because runs.mjs's own
// mostRecentWorkSignalMs() independently re-checks anyContainmentOk(SYNC_SCAN_ROOTS, projectPath)
// against paths.mjs's REAL, live SYNC_SCAN_ROOTS — never projects.mjs's _setScanRootsForTests
// override, which only fools THAT module's own discovery step (same reasoning as active-
// runs.test.mjs's own header comment).
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
  _setDefaultProjectPathForTests,
  _resetDefaultProjectPathForTests,
} from '../src/projects.mjs';
import { _setInstalledProjectsFileForTests, _resetInstalledProjectsFileForTests } from '../src/installed-projects.mjs';
import { PROJECT_ROOT, COMMAND_CENTER_DATA_DIR } from '../src/paths.mjs';
import { writeEventsFile } from '../test-support/helpers.mjs';

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
  : 'no real .claude/forge-bin/forge-sync.cjs found by walking up from PROJECT_ROOT.';
const GUARANTEED_ABSENT_INSTALLED_PROJECTS_FILE = path.join(os.tmpdir(), 'cc-default-recent-work-test-installed-projects-never-created.json');

const FIXTURE_PARENT = path.join(COMMAND_CENTER_DATA_DIR, 'gateway-test-tmp-default-recent-work');
let scanRoot;
function makeProjectDir(name) {
  const dir = path.join(scanRoot, name);
  fs.mkdirSync(path.join(dir, '.claude', 'forge-dashboard'), { recursive: true });
  return dir;
}

beforeEach(() => {
  fs.mkdirSync(FIXTURE_PARENT, { recursive: true });
  scanRoot = fs.mkdtempSync(path.join(FIXTURE_PARENT, 'fixture-'));
  _resetProjectsCacheForTests();
  if (REAL_FORGE_SYNC_CJS) _setForgeSyncCjsForTests(REAL_FORGE_SYNC_CJS);
  _setScanRootsForTests([scanRoot]);
  _setInstalledProjectsFileForTests(GUARANTEED_ABSENT_INSTALLED_PROJECTS_FILE);
  _setDefaultProjectPathForTests('');
});

after(() => {
  _resetForgeSyncCjsForTests();
  _resetScanRootsForTests();
  _resetInstalledProjectsFileForTests();
  _resetDefaultProjectPathForTests();
  _resetProjectsCacheForTests();
  fs.rmSync(FIXTURE_PARENT, { recursive: true, force: true });
});

test('the project with the most recent real work event wins the default when the env var is unset', { skip: SKIP_REASON }, async () => {
  const quietProj = makeProjectDir('proj-quiet');
  void quietProj; // no runs at all — must never win
  const olderProj = makeProjectDir('proj-older-work');
  writeEventsFile(olderProj, 'forge-older-run', [
    { event_type: 'run_started', timestamp: '2026-01-01T00:00:00.000Z' },
    { event_type: 'check_passed', timestamp: '2026-01-01T00:05:00.000Z' },
  ]);
  const newerProj = makeProjectDir('proj-newer-work');
  writeEventsFile(newerProj, 'forge-newer-run', [
    { event_type: 'run_started', timestamp: '2026-06-01T00:00:00.000Z' },
    { event_type: 'check_passed', timestamp: '2026-06-01T00:05:00.000Z' },
  ]);

  const result = await listProjects();
  assert.equal(result.ok, true);
  assert.equal(result.default_project_id, 'proj-newer-work');
});

test('a reserved/synthetic-only run never wins the default fallback', { skip: SKIP_REASON }, async () => {
  const realProj = makeProjectDir('proj-real-quiet-but-real');
  writeEventsFile(realProj, 'forge-real-run', [
    { event_type: 'run_started', timestamp: '2026-01-01T00:00:00.000Z' },
    { event_type: 'check_passed', timestamp: '2026-01-01T00:05:00.000Z' },
  ]);
  const fakeProj = makeProjectDir('proj-only-fake-runs');
  writeEventsFile(fakeProj, 'bench-fake-1', [
    { event_type: 'run_started', timestamp: '2026-09-01T00:00:00.000Z' },
    { event_type: 'check_passed', timestamp: '2026-09-01T00:05:00.000Z' },
  ]);

  const result = await listProjects();
  assert.equal(result.ok, true);
  assert.equal(result.default_project_id, 'proj-real-quiet-but-real', 'the reserved-name-only project must never win, even with a much newer timestamp');
});

test('no discovered project has any qualifying run -> default_project_id stays honestly null', { skip: SKIP_REASON }, async () => {
  makeProjectDir('proj-totally-quiet');
  const result = await listProjects();
  assert.equal(result.ok, true);
  assert.equal(result.default_project_id, null);
});
