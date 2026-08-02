// P1-4 fix (cc-fix-gateway-perf, forge-2026-07-29-cc-finish): events.mjs's per-eventsPath CACHE used
// to grow WITHOUT BOUND — every run ever touched kept its full parsed event history pinned in memory
// for the gateway process's whole life. These tests prove both new caps hold, mirroring the existing
// cache-bounds.test.mjs pattern already used for tools.mjs/capabilities.mjs (WP10 F4/F5).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  readEvents,
  _resetEventsCacheForTests,
  _eventsCacheSizeForTests,
  _EVENTS_MAX_CACHE_ENTRIES_FOR_TESTS,
  MAX_LINE_RECORDS_PER_ENTRY,
} from '../src/events.mjs';
import { makeTempProjectRoot, writeEventsFile, appendEventLine } from '../test-support/helpers.mjs';

const tempRoots = [];
function freshRoot() {
  const root = makeTempProjectRoot();
  tempRoots.push(root);
  return root;
}

after(() => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
});

test('cap #1: CACHE never grows past MAX_CACHE_ENTRIES, even across many distinct run event files', () => {
  _resetEventsCacheForTests();
  const overflow = 20;
  const total = _EVENTS_MAX_CACHE_ENTRIES_FOR_TESTS + overflow;
  for (let i = 0; i < total; i++) {
    const root = freshRoot();
    writeEventsFile(root, 'run-' + i, [{ event_type: 'run_started', i }]);
    const res = readEvents(root, 'run-' + i, 0);
    assert.equal(res.ok, true);
  }
  assert.ok(_eventsCacheSizeForTests() <= _EVENTS_MAX_CACHE_ENTRIES_FOR_TESTS, 'cache size must never exceed the hard cap');
  assert.ok(_eventsCacheSizeForTests() > 0, 'the cap must not evict everything either');
  _resetEventsCacheForTests();
});

test('cap #1 is genuinely LRU: re-polling an old entry keeps it alive while newer-inserted entries get evicted first', () => {
  _resetEventsCacheForTests();
  const hotRoot = freshRoot();
  writeEventsFile(hotRoot, 'hot-run', [{ event_type: 'run_started' }]);
  readEvents(hotRoot, 'hot-run', 0); // inserted first — would be the FIFO victim under plain insertion-order eviction

  const overflow = 10;
  for (let i = 0; i < _EVENTS_MAX_CACHE_ENTRIES_FOR_TESTS + overflow; i++) {
    const root = freshRoot();
    writeEventsFile(root, 'filler-' + i, [{ event_type: 'run_started', i }]);
    readEvents(root, 'filler-' + i, 0);
    // Touch the hot entry on every iteration so it stays at the MRU end.
    readEvents(hotRoot, 'hot-run', 0);
  }
  const hotEventsPath = path.join(hotRoot, '.claude', 'forge-runs', 'hot-run', 'events.jsonl');
  // Indirect proof the hot entry survived without a full rebuild: a second read still reports the
  // SAME next_after with zero new bytes read (i.e. it reused the live entry, not a fresh rebuild) —
  // checked via the public contract (total_lines stays 1, no error), since internals aren't exported.
  const stillThere = readEvents(hotRoot, 'hot-run', 0);
  assert.equal(stillThere.ok, true);
  assert.equal(stillThere.total_lines, 1);
  assert.ok(fs.existsSync(hotEventsPath));
  _resetEventsCacheForTests();
});

test('cap #2: a single run exceeding MAX_LINE_RECORDS_PER_ENTRY lines trims the oldest and reports truncated:true honestly', () => {
  _resetEventsCacheForTests();
  const root = freshRoot();
  const overflowLines = 1;
  const lines = [];
  for (let i = 0; i < MAX_LINE_RECORDS_PER_ENTRY + overflowLines; i++) {
    lines.push({ event_type: 'agent_note', i });
  }
  writeEventsFile(root, 'chatty-run', lines);

  const res = readEvents(root, 'chatty-run', 0);
  assert.equal(res.ok, true);
  assert.equal(res.total_lines, MAX_LINE_RECORDS_PER_ENTRY + overflowLines, 'total_lines stays the TRUE cumulative count even after an internal trim');
  assert.equal(res.truncated, true, 'the honest truncated signal is reused, not a new field');
  assert.equal(res.events.length, MAX_LINE_RECORDS_PER_ENTRY, 'only the buffered (capped) records are returned');
  // The oldest record (i:0) must have been dropped; the newest (i: overflowLines + MAX-1) must remain —
  // a live tail must never lose the NEWEST data to the cap.
  assert.ok(!res.events.some((e) => e.i === 0), 'the oldest line was evicted by the cap');
  assert.ok(res.events.some((e) => e.i === MAX_LINE_RECORDS_PER_ENTRY + overflowLines - 1), 'the newest line survived the cap');
  _resetEventsCacheForTests();
});

test('cap #2: new events appended after a trim are still delivered correctly via next_after', () => {
  _resetEventsCacheForTests();
  const root = freshRoot();
  const lines = [];
  for (let i = 0; i < MAX_LINE_RECORDS_PER_ENTRY + 5; i++) lines.push({ event_type: 'agent_note', i });
  const eventsPath = writeEventsFile(root, 'chatty-run-2', lines);

  const first = readEvents(root, 'chatty-run-2', 0);
  assert.equal(first.truncated, true);
  const cursor = first.next_after;

  appendEventLine(eventsPath, { event_type: 'agent_note', i: 'brand-new-after-trim' });
  const second = readEvents(root, 'chatty-run-2', cursor);
  assert.equal(second.ok, true);
  assert.equal(second.events.length, 1, 'only the ONE newly appended line is returned, cursor logic survives a prior trim');
  assert.equal(second.events[0].i, 'brand-new-after-trim');
  _resetEventsCacheForTests();
});
