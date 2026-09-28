// Codex run B F-05 — unbounded run scans on GET. Two independent bounds:
//   (1) a per-project run-directory ceiling (MAX_RUNS_SCANNED_PER_PROJECT) — the newest runs by a
//       cheap filesystem-metadata signal are fully scanned; anything beyond that is honestly
//       reported via `runs_truncated:true`, never silently dropped with no signal at all.
//   (2) a per-file byte ceiling on events.jsonl (MAX_EVENTS_FILE_READ_BYTES) — an oversized file is
//       TAILED, not read in full; `event_scan_truncated:true` on that row, with event_count/
//       duration_ms honestly null (never a wrong exact number), while liveness fields (workEvents/
//       lastWorkAtMs/openDispatchIds) still come from the real, recent tail content.
// Same isolated-fixture convention as runs-liveness.test.mjs (COMMAND_CENTER_DATA_DIR — runs.mjs's
// own anyContainmentOk() check rejects a plain os.tmpdir() fixture).
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  listRuns,
  _setMaxRunsScannedPerProjectForTests,
  _resetMaxRunsScannedPerProjectForTests,
  _resetRunsScanCacheForTests,
  _setMaxRunDirEntriesForTests,
  _resetMaxRunDirEntriesForTests,
} from '../src/runs.mjs';
import { _resetToolLogCacheForTests } from '../src/toollog.mjs';
import { COMMAND_CENTER_DATA_DIR } from '../src/paths.mjs';

const FIXTURE_PARENT = path.join(COMMAND_CENTER_DATA_DIR, 'gateway-test-tmp-runs-bounds');
const tempRoots = [];

function freshRoot() {
  fs.mkdirSync(FIXTURE_PARENT, { recursive: true });
  const root = fs.mkdtempSync(path.join(FIXTURE_PARENT, 'fixture-'));
  tempRoots.push(root);
  return root;
}

function writeRunDir(root, runId, { events, mtimeOffsetMs } = {}) {
  const runDir = path.join(root, '.claude', 'forge-runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  if (events) {
    const eventsPath = path.join(runDir, 'events.jsonl');
    fs.writeFileSync(eventsPath, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    if (Number.isFinite(mtimeOffsetMs)) {
      const t = new Date(Date.now() + mtimeOffsetMs);
      fs.utimesSync(eventsPath, t, t);
    }
  } else {
    fs.writeFileSync(path.join(runDir, 'run.json'), '{}', 'utf8');
  }
  return runDir;
}

beforeEach(() => {
  _resetToolLogCacheForTests();
  _resetRunsScanCacheForTests();
});

after(() => {
  _resetMaxRunsScannedPerProjectForTests();
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(FIXTURE_PARENT, { recursive: true, force: true });
});

test('F-05 hostile: more run directories than the bound -> runs_truncated:true, and the NEWEST ones are the ones kept', () => {
  _setMaxRunsScannedPerProjectForTests(3);
  const root = freshRoot();
  const now = Date.now();
  // 5 runs, oldest to newest by their own events.jsonl mtime.
  for (let i = 0; i < 5; i++) {
    writeRunDir(root, 'run-' + i, { events: [{ event_type: 'run_started', timestamp: new Date(now).toISOString() }], mtimeOffsetMs: -1 * (5 - i) * 60_000 });
  }
  const result = listRuns(root, now);
  assert.equal(result.ok, true);
  assert.equal(result.runs_truncated, true, 'more real run dirs exist than the bound allows fully scanning');
  assert.equal(result.runs.length, 3, 'only the bound\'s worth of runs are included, never silently more or fewer');
  const keptIds = result.runs.map((r) => r.run_id).sort();
  assert.deepEqual(keptIds, ['run-2', 'run-3', 'run-4'], 'the 3 NEWEST runs (by real events.jsonl mtime) are kept, not an arbitrary directory-order subset');
});

test('F-05 ordinary case: fewer run directories than the bound -> runs_truncated:false, nothing omitted', () => {
  _setMaxRunsScannedPerProjectForTests(500);
  const root = freshRoot();
  writeRunDir(root, 'run-only', { events: [{ event_type: 'run_started', timestamp: new Date().toISOString() }] });
  const result = listRuns(root);
  assert.equal(result.ok, true);
  assert.equal(result.runs_truncated, false);
  assert.equal(result.runs.length, 1);
});

test('F-05 hostile: an oversized events.jsonl is tailed, not read in full — event_count/duration_ms honestly null, liveness still works', () => {
  const root = freshRoot();
  const runDir = path.join(root, '.claude', 'forge-runs', 'run-huge');
  fs.mkdirSync(runDir, { recursive: true });
  const eventsPath = path.join(runDir, 'events.jsonl');
  const now = Date.now();
  const oldIso = new Date(now - 48 * 60 * 60 * 1000).toISOString();
  const recentIso = new Date(now - 1 * 60 * 1000).toISOString();
  // Pad well past the 2MB bound with real, parseable filler lines (an old, implausible-for-"first"
  // event repeated many times), so a naive "read whole file" implementation would see them but the
  // bounded tail-read must not need to.
  const fillerLine = JSON.stringify({ event_type: 'decision_logged', agent: 'orchestrator', timestamp: oldIso, note: 'filler' }) + '\n';
  const paddingBytes = 2 * 1024 * 1024 * 2; // 2x the real 2MB bound
  const repeats = Math.ceil(paddingBytes / Buffer.byteLength(fillerLine));
  const fd = fs.openSync(eventsPath, 'w');
  fs.writeSync(fd, JSON.stringify({ event_type: 'run_started', timestamp: oldIso }) + '\n'); // the REAL first event — outside the tail window
  for (let i = 0; i < repeats; i++) fs.writeSync(fd, fillerLine);
  // A real, recent open dispatch — inside the tail window, must still be found.
  fs.writeSync(fd, JSON.stringify({ event_type: 'subagent_started', agent: 'Build Boss', dispatch_id: 'd-recent', timestamp: recentIso }) + '\n');
  fs.closeSync(fd);

  const result = listRuns(root, now);
  const row = result.runs.find((r) => r.run_id === 'run-huge');
  assert.ok(row, 'the run must still be listed');
  assert.equal(row.event_scan_truncated, true, 'a file this large must be tailed, not read in full');
  assert.equal(row.event_count, null, 'a wrong exact count must never be reported for a truncated read');
  assert.equal(row.duration_ms, null, 'duration needs the true FIRST event, which a tail read does not have');
  assert.equal(row.open_dispatch_count, 1, 'the real, RECENT open dispatch (inside the tail window) must still be found');
  assert.equal(row.status, 'live', 'liveness/status must still work correctly off the tail content alone');
});

test('F-05 ordinary case: a normal-sized events.jsonl is read in full, unaffected by the bound', () => {
  const root = freshRoot();
  const now = Date.now();
  writeRunDir(root, 'run-normal', { events: [
    { event_type: 'run_started', timestamp: new Date(now - 60_000).toISOString() },
    { event_type: 'subagent_started', agent: 'Build Boss', dispatch_id: 'd1', timestamp: new Date(now - 60_000).toISOString() },
  ] });
  const result = listRuns(root, now);
  const row = result.runs.find((r) => r.run_id === 'run-normal');
  assert.ok(row);
  assert.equal(row.event_scan_truncated, false);
  assert.equal(row.event_count, 2);
});

test('Codex verification F-05: the raw run-folder listing itself stops at its budget and says so', () => {
  const root = freshRoot();
  for (const id of ['run-a', 'run-b', 'run-c', 'run-d']) writeRunDir(root, id, { events: [{ event_type: 'run_started', timestamp: new Date().toISOString() }] });
  _setMaxRunDirEntriesForTests(2);
  try {
    const result = listRuns(root);
    assert.equal(result.ok, true);
    assert.equal(result.runs_truncated, true, 'a listing that hit its budget is reported, never silent');
    assert.ok(result.runs.length <= 2);
  } finally {
    _resetMaxRunDirEntriesForTests();
  }
  _resetRunsScanCacheForTests();
  const full = listRuns(root);
  assert.equal(full.runs.length, 4);
  assert.equal(full.runs_truncated, false);
});
