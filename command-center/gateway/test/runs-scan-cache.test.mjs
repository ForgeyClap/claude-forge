// P1-2 fix (cc-fix-gateway-perf, forge-2026-07-29-cc-finish): listRuns() used to re-read + re-parse
// EVERY run's entire events.jsonl on EVERY call — measured live at ~9ms per call against this
// project's 26 real runs (see the forge-report for this WP). Now cached on real file identity
// (path, mtimeMs, size). These tests prove the cache actually skips re-reading an unchanged file,
// correctly detects a real change, stays bounded, and the second-order silent-error bug is closed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  listRuns,
  _resetRunsScanCacheForTests,
  _runsScanCacheSizeForTests,
  _RUNS_SCAN_MAX_CACHE_ENTRIES_FOR_TESTS,
} from '../src/runs.mjs';
import { COMMAND_CENTER_DATA_DIR } from '../src/paths.mjs';

const FIXTURE_PARENT = path.join(COMMAND_CENTER_DATA_DIR, 'gateway-test-tmp-runs-scan-cache');
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
  _resetRunsScanCacheForTests();
});

test('a repeat listRuns() call on an unchanged events.jsonl reuses the cached scan (no re-read)', () => {
  _resetRunsScanCacheForTests();
  const root = freshTempRoot();
  const eventsPath = writeEventsFile(root, 'forge-cache-a', [
    { event_type: 'run_started', timestamp: '2026-01-01T00:00:00.000Z' },
    { event_type: 'run_completed', timestamp: '2026-01-01T00:01:00.000Z' },
  ]);

  const realReadFileSync = fs.readFileSync;
  let readCount = 0;
  fs.readFileSync = function patched(p, ...rest) {
    if (p === eventsPath) readCount += 1;
    return realReadFileSync.call(fs, p, ...rest);
  };
  try {
    const first = listRuns(root);
    assert.equal(first.ok, true);
    assert.equal(readCount, 1, 'the first call genuinely reads the file once (cold cache)');
    const run1 = first.runs.find((r) => r.run_id === 'forge-cache-a');
    assert.equal(run1.event_count, 2);
    assert.equal(run1.duration_ms, 60_000);

    // Simulate 5 more polls with NOTHING changed on disk (the real-world common case this fix targets).
    for (let i = 0; i < 5; i++) listRuns(root);
    assert.equal(readCount, 1, 'FIX: an unchanged file is never re-read on subsequent polls');
  } finally {
    fs.readFileSync = realReadFileSync;
  }
  _resetRunsScanCacheForTests();
});

test('a genuinely changed events.jsonl (new size/mtime) is correctly re-scanned, never serving stale counts', () => {
  _resetRunsScanCacheForTests();
  const root = freshTempRoot();
  const eventsPath = writeEventsFile(root, 'forge-cache-b', [
    { event_type: 'run_started', timestamp: '2026-01-01T00:00:00.000Z' },
  ]);

  const before = listRuns(root);
  const runBefore = before.runs.find((r) => r.run_id === 'forge-cache-b');
  assert.equal(runBefore.event_count, 1);

  // Force a real, detectable mtime change even on filesystems with coarse mtime resolution.
  const future = new Date(Date.now() + 5000);
  fs.appendFileSync(eventsPath, JSON.stringify({ event_type: 'run_completed', timestamp: '2026-01-01T00:05:00.000Z' }) + '\n', 'utf8');
  fs.utimesSync(eventsPath, future, future);

  const after = listRuns(root);
  const runAfter = after.runs.find((r) => r.run_id === 'forge-cache-b');
  assert.equal(runAfter.event_count, 2, 'the cache correctly detected the real size/mtime change and re-scanned');
  assert.equal(runAfter.duration_ms, 5 * 60 * 1000);
  _resetRunsScanCacheForTests();
});

test('second-order bug fix: a genuine read failure (not ENOENT) is surfaced via event_scan_error, never silently reported as 0 events', () => {
  _resetRunsScanCacheForTests();
  const root = freshTempRoot();
  const eventsPath = writeEventsFile(root, 'forge-cache-c', [{ event_type: 'run_started' }]);

  const realReadFileSync = fs.readFileSync;
  fs.readFileSync = function patched(p, ...rest) {
    if (p === eventsPath) { const e = new Error('simulated unreadable file'); e.code = 'EACCES'; throw e; }
    return realReadFileSync.call(fs, p, ...rest);
  };
  try {
    const result = listRuns(root);
    assert.equal(result.ok, true, 'one unreadable run must not fail the whole listing');
    const run = result.runs.find((r) => r.run_id === 'forge-cache-c');
    assert.ok(run);
    assert.equal(run.event_count, 0);
    assert.match(run.event_scan_error, /simulated unreadable file/, 'FIX: the read failure is surfaced, not silently presented as an honest empty run');
  } finally {
    fs.readFileSync = realReadFileSync;
  }
  _resetRunsScanCacheForTests();
});

test('a run with no events.jsonl yet (ENOENT) is still the honest, error-free empty state', () => {
  _resetRunsScanCacheForTests();
  const root = freshTempRoot();
  const runDir = path.join(root, '.claude', 'forge-runs', 'forge-cache-d');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'run.json'), '{"run_id":"forge-cache-d"}', 'utf8');

  const result = listRuns(root);
  const run = result.runs.find((r) => r.run_id === 'forge-cache-d');
  assert.ok(run);
  assert.equal(run.event_count, 0);
  assert.equal(run.event_scan_error, null, 'ENOENT (file genuinely does not exist yet) is never treated as an error');
  _resetRunsScanCacheForTests();
});

test('the scan cache stays bounded (FIFO-evicted) across more distinct run event files than the hard cap', () => {
  _resetRunsScanCacheForTests();
  const overflow = 25;
  const total = _RUNS_SCAN_MAX_CACHE_ENTRIES_FOR_TESTS + overflow;
  for (let i = 0; i < total; i++) {
    const root = freshTempRoot();
    writeEventsFile(root, 'run-' + i, [{ event_type: 'run_started' }]);
    listRuns(root);
  }
  assert.ok(_runsScanCacheSizeForTests() <= _RUNS_SCAN_MAX_CACHE_ENTRIES_FOR_TESTS, 'cache size must never exceed the hard cap');
  assert.equal(_runsScanCacheSizeForTests(), _RUNS_SCAN_MAX_CACHE_ENTRIES_FOR_TESTS, 'the cap is genuinely reached, not just never-hit by coincidence');
  _resetRunsScanCacheForTests();
});
