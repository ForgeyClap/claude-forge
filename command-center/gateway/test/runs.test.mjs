// FU1/FU2 tests (WP6 follow-up fixes) — listRuns() unit tests against a fully-isolated temp
// project tree. Unlike other gateway modules, listRuns() ALSO defense-in-depth checks that the
// project path sits under SYNC_SCAN_ROOT (the Documents folder this whole Forge fleet lives
// under) — an os.tmpdir()-based fixture (test-support/helpers.mjs's usual makeTempProjectRoot())
// would genuinely fail that check and never reach the FU1/FU2 code path at all. So this file uses
// its OWN fixture root nested under this project's own command-center/.data/ (already
// .gitignore'd, and still a real descendant of SYNC_SCAN_ROOT since PROJECT_ROOT itself is) —
// staying inside this project's write scope, never writing anywhere outside it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { listRuns } from '../src/runs.mjs';
import { COMMAND_CENTER_DATA_DIR } from '../src/paths.mjs';

const FIXTURE_PARENT = path.join(COMMAND_CENTER_DATA_DIR, 'gateway-test-tmp-runs');
const tempRoots = [];

function freshTempRoot() {
  fs.mkdirSync(FIXTURE_PARENT, { recursive: true });
  const root = fs.mkdtempSync(path.join(FIXTURE_PARENT, 'fixture-'));
  tempRoots.push(root);
  return root;
}

function writeEventsFile(projectRoot, runId, lines) {
  const runDir = path.join(projectRoot, '.claude', 'forge-runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  const eventsPath = path.join(runDir, 'events.jsonl');
  const body = lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : '');
  fs.writeFileSync(eventsPath, body, 'utf8');
  return eventsPath;
}

after(() => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(FIXTURE_PARENT, { recursive: true, force: true });
});

test('FU2: a directory with no events.jsonl and no run.json is NOT counted as a run (e.g. .hotspot-locks)', () => {
  const root = freshTempRoot();
  writeEventsFile(root, 'forge-2026-01-01-real-run', [{ event_type: 'agent_started' }]);
  // A real non-run operational directory this project genuinely has, with unrelated file content.
  const lockDir = path.join(root, '.claude', 'forge-runs', '.hotspot-locks');
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, 'some-lock-file.json'), '{"locked":true}', 'utf8');

  const result = listRuns(root);
  assert.equal(result.ok, true);
  assert.equal(result.runs.length, 1);
  assert.equal(result.runs[0].run_id, 'forge-2026-01-01-real-run');
  assert.ok(!result.runs.some((r) => r.run_id === '.hotspot-locks'));
});

test('FU2: a directory with ONLY a run.json (no events.jsonl yet) still counts as a real run', () => {
  const root = freshTempRoot();
  const runDir = path.join(root, '.claude', 'forge-runs', 'forge-2026-01-02-run-json-only');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'run.json'), '{"run_id":"forge-2026-01-02-run-json-only"}', 'utf8');

  const result = listRuns(root);
  assert.equal(result.ok, true);
  assert.equal(result.runs.length, 1);
  assert.equal(result.runs[0].run_id, 'forge-2026-01-02-run-json-only');
  assert.equal(result.runs[0].has_run_json, true);
  assert.equal(result.runs[0].event_count, 0);
});

test('FU1: runs are sorted by real mtime descending, NOT by run_id string order', () => {
  const root = freshTempRoot();
  // Deliberately non-date-prefixed id that would sort AHEAD lexically ('d' > 'f') but is
  // actually the OLDEST by real mtime — this is exactly the live bug this project's own WP5
  // self-review found (a "demo" run outranking a 3h-old real run).
  const oldPath = writeEventsFile(root, 'demo-lexically-first-but-oldest', [{ event_type: 'agent_started' }]);
  const midPath = writeEventsFile(root, 'forge-2026-01-01-middle', [{ event_type: 'agent_started' }]);
  const newPath = writeEventsFile(root, 'forge-2026-01-02-newest', [{ event_type: 'agent_started' }]);

  const now = Date.now();
  fs.utimesSync(path.dirname(oldPath), new Date(now - 100_000), new Date(now - 100_000));
  fs.utimesSync(path.dirname(midPath), new Date(now - 50_000), new Date(now - 50_000));
  fs.utimesSync(path.dirname(newPath), new Date(now - 1_000), new Date(now - 1_000));

  const result = listRuns(root);
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.runs.map((r) => r.run_id),
    ['forge-2026-01-02-newest', 'forge-2026-01-01-middle', 'demo-lexically-first-but-oldest'],
  );
});

// cc-fix-adapter T6c — real run duration derived from the first/last event timestamp.
test('T6c: duration_ms is derived from the real first/last event timestamps, labelled derived-from-events', () => {
  const root = freshTempRoot();
  const runPath = writeEventsFile(root, 'forge-2026-01-05-duration', [
    { event_type: 'run_started', timestamp: '2026-01-05T10:00:00.000Z' },
    { event_type: 'subagent_started', timestamp: '2026-01-05T10:00:30.000Z' },
    { event_type: 'check_passed', timestamp: '2026-01-05T10:05:00.000Z' },
  ]);
  void runPath;

  const result = listRuns(root);
  assert.equal(result.ok, true);
  const run = result.runs.find((r) => r.run_id === 'forge-2026-01-05-duration');
  assert.ok(run);
  assert.equal(run.duration_ms, 5 * 60 * 1000);
  assert.equal(run.duration_source, 'derived-from-events');
});

test('T6c: a real run_completed as the LAST event is labelled run-completed-event, not the generic fallback', () => {
  const root = freshTempRoot();
  writeEventsFile(root, 'forge-2026-01-06-completed', [
    { event_type: 'run_started', timestamp: '2026-01-06T10:00:00.000Z' },
    { event_type: 'run_completed', timestamp: '2026-01-06T10:01:00.000Z' },
  ]);

  const result = listRuns(root);
  const run = result.runs.find((r) => r.run_id === 'forge-2026-01-06-completed');
  assert.ok(run);
  assert.equal(run.duration_ms, 60_000);
  assert.equal(run.duration_source, 'run-completed-event');
});

test('T6c: a run with only ONE timestamped event has no measurable duration — null, never 0', () => {
  const root = freshTempRoot();
  writeEventsFile(root, 'forge-2026-01-07-single-event', [
    { event_type: 'run_started', timestamp: '2026-01-07T10:00:00.000Z' },
  ]);

  const result = listRuns(root);
  const run = result.runs.find((r) => r.run_id === 'forge-2026-01-07-single-event');
  assert.ok(run);
  assert.equal(run.duration_ms, 0);
  assert.equal(run.duration_source, 'derived-from-events');
});

test('T6c: a run whose events carry no parseable timestamp at all reports null/null honestly', () => {
  const root = freshTempRoot();
  writeEventsFile(root, 'forge-2026-01-08-no-timestamps', [
    { event_type: 'run_started' },
    { event_type: 'check_passed' },
  ]);

  const result = listRuns(root);
  const run = result.runs.find((r) => r.run_id === 'forge-2026-01-08-no-timestamps');
  assert.ok(run);
  assert.equal(run.duration_ms, null);
  assert.equal(run.duration_source, null);
});

test('FU1: two runs with the EXACT same mtime fall back to a stable run_id-descending tiebreak', () => {
  const root = freshTempRoot();
  const aPath = writeEventsFile(root, 'forge-2026-01-04-aaa', [{ event_type: 'agent_started' }]);
  const bPath = writeEventsFile(root, 'forge-2026-01-04-bbb', [{ event_type: 'agent_started' }]);
  const same = new Date();
  fs.utimesSync(path.dirname(aPath), same, same);
  fs.utimesSync(path.dirname(bPath), same, same);

  const result = listRuns(root);
  assert.equal(result.ok, true);
  assert.deepEqual(result.runs.map((r) => r.run_id), ['forge-2026-01-04-bbb', 'forge-2026-01-04-aaa']);
});
