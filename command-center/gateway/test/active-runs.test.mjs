// WP-CC1 (item 3) tests for GET /api/active-runs / buildActiveRuns() — same real-forge-sync.cjs +
// isolated-scan-root pattern as projects-multiroot.test.mjs (see that file's own header for why
// this suite needs the real, already-reviewed tool rather than a hand-rolled stub).
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildActiveRuns,
  _resetActiveRunsCacheForTests,
  _setMaxTotalRunsScannedForTests,
  _resetMaxTotalRunsScannedForTests,
} from '../src/active-runs.mjs';
import {
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
  : 'no real .claude/forge-bin/forge-sync.cjs found by walking up from PROJECT_ROOT — this suite needs the real, already-reviewed tool to spawn against isolated fixtures.';
const GUARANTEED_ABSENT_INSTALLED_PROJECTS_FILE = path.join(os.tmpdir(), 'cc-active-runs-test-installed-projects-never-created.json');

// runs.mjs's own listRuns() independently re-checks anyContainmentOk(SYNC_SCAN_ROOTS, projectPath)
// against paths.mjs's REAL, live SYNC_SCAN_ROOTS (never projects.mjs's _setScanRootsForTests
// override, which only fools THAT module's own discovery step) — so this fixture must be a genuine
// descendant of PROJECT_ROOT/SYNC_SCAN_ROOTS, same reasoning as runs.test.mjs's own header comment.
const FIXTURE_PARENT = path.join(COMMAND_CENTER_DATA_DIR, 'gateway-test-tmp-active-runs');
let tempRoots = [];
function makeRootWithProject(projectDirName) {
  fs.mkdirSync(FIXTURE_PARENT, { recursive: true });
  const root = fs.mkdtempSync(path.join(FIXTURE_PARENT, 'fixture-'));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, projectDirName, '.claude', 'forge-dashboard'), { recursive: true });
  return path.join(root, projectDirName);
}

beforeEach(() => {
  tempRoots = [];
  _resetProjectsCacheForTests();
  _resetActiveRunsCacheForTests();
  if (REAL_FORGE_SYNC_CJS) _setForgeSyncCjsForTests(REAL_FORGE_SYNC_CJS);
  _setInstalledProjectsFileForTests(GUARANTEED_ABSENT_INSTALLED_PROJECTS_FILE);
  _setDefaultProjectPathForTests('');
});

after(() => {
  _resetForgeSyncCjsForTests();
  _resetScanRootsForTests();
  _resetInstalledProjectsFileForTests();
  _resetDefaultProjectPathForTests();
  _resetProjectsCacheForTests();
  _resetActiveRunsCacheForTests();
  _resetMaxTotalRunsScannedForTests();
  for (const r of tempRoots) fs.rmSync(r, { recursive: true, force: true });
  fs.rmSync(FIXTURE_PARENT, { recursive: true, force: true });
});

// Codex run B F-05 — the cumulative run-count budget across the WHOLE fleet-wide sweep.
test('F-05: once the cumulative run budget is hit, the scan stops early and reports truncated:true honestly', { skip: SKIP_REASON }, async () => {
  _setMaxTotalRunsScannedForTests(2);
  const projectPath = makeRootWithProject('proj-active-budget');
  _setScanRootsForTests([path.dirname(projectPath)]);
  _resetProjectsCacheForTests();
  const nowIso = new Date().toISOString();
  // 3 real runs in one project — already more than the 2-run test budget.
  for (let i = 0; i < 3; i++) {
    writeEventsFile(projectPath, 'forge-budget-run-' + i, [
      { event_type: 'run_started', timestamp: nowIso },
      { event_type: 'subagent_started', agent: 'Build Boss', dispatch_id: 'd-' + i, timestamp: nowIso },
    ]);
  }

  const result = await buildActiveRuns();
  assert.equal(result.ok, true);
  assert.equal(result.truncated, true, 'more runs exist across the fleet than the cumulative budget allows fully scanning');
});

test('F-05 ordinary case: fewer runs than the budget -> truncated:false', { skip: SKIP_REASON }, async () => {
  _setMaxTotalRunsScannedForTests(500);
  const projectPath = makeRootWithProject('proj-active-no-budget-issue');
  _setScanRootsForTests([path.dirname(projectPath)]);
  _resetProjectsCacheForTests();
  writeEventsFile(projectPath, 'forge-single-run', [
    { event_type: 'run_started', timestamp: new Date().toISOString() },
  ]);

  const result = await buildActiveRuns();
  assert.equal(result.ok, true);
  assert.equal(result.truncated, false);
});

test('a project with a genuinely live run appears in active_runs with its real working agent', { skip: SKIP_REASON }, async () => {
  const projectPath = makeRootWithProject('proj-active-alpha');
  _setScanRootsForTests([path.dirname(projectPath)]);
  _resetProjectsCacheForTests();
  const nowIso = new Date().toISOString();
  writeEventsFile(projectPath, 'forge-live-run', [
    { event_type: 'run_started', timestamp: nowIso, request: 'a live mission' },
    { event_type: 'subagent_started', agent: 'Build Boss', dispatch_id: 'd1', task: 'do it', timestamp: nowIso },
  ]);
  // run.json for the real `title`/`started_at` fields.
  fs.writeFileSync(
    path.join(projectPath, '.claude', 'forge-runs', 'forge-live-run', 'run.json'),
    JSON.stringify({ run_id: 'forge-live-run', status: 'running', started_at: nowIso, request: 'a live mission' }),
    'utf8',
  );

  const result = await buildActiveRuns();
  assert.equal(result.ok, true);
  const row = result.active_runs.find((r) => r.project === 'proj-active-alpha');
  assert.ok(row, 'the live run must appear in active_runs');
  assert.equal(row.run_id, 'forge-live-run');
  assert.equal(row.title, 'a live mission');
  assert.equal(row.started_at, nowIso);
  assert.equal(row.open_dispatches, 1);
  assert.equal(row.working_agents.length, 1);
  assert.equal(row.working_agents[0].agent, 'Build Boss');
});

test('a project with no live run contributes nothing — never a fabricated row', { skip: SKIP_REASON }, async () => {
  const projectPath = makeRootWithProject('proj-active-quiet');
  _setScanRootsForTests([path.dirname(projectPath)]);
  _resetProjectsCacheForTests();
  // A long-finished run only — no open dispatch, no recent work.
  writeEventsFile(projectPath, 'forge-old-run', [
    { event_type: 'run_started', timestamp: '2020-01-01T00:00:00.000Z' },
    { event_type: 'run_completed', timestamp: '2020-01-01T01:00:00.000Z' },
  ]);

  const result = await buildActiveRuns();
  assert.equal(result.ok, true);
  assert.ok(!result.active_runs.some((r) => r.project === 'proj-active-quiet'));
});

test('the result is cached for CACHE_TTL_MS — a second call within the window reuses it (provenance DERIVED, age_ms > 0)', { skip: SKIP_REASON }, async () => {
  const projectPath = makeRootWithProject('proj-active-cache');
  _setScanRootsForTests([path.dirname(projectPath)]);
  _resetProjectsCacheForTests();

  const first = await buildActiveRuns();
  assert.equal(first.provenance, 'DERIVED');
  const second = await buildActiveRuns(Date.now() + 1000);
  assert.equal(second.provenance, 'DERIVED');
  assert.ok(second.age_ms >= 1000);
});
