// Unit tests for the R1 fix (incremental byte-offset reads) in events.mjs. Every test uses its
// own isolated temp directory (test-support/helpers.mjs::makeTempProjectRoot()) — NEVER the real
// .claude/forge-runs, per this run's explicit write-scope rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readEvents, _resetEventsCacheForTests, MAX_DELTA_READ_BYTES } from '../src/events.mjs';
import { makeTempProjectRoot, writeEventsFile, appendEventLine } from '../test-support/helpers.mjs';

test('readEvents on a run with no events.jsonl yet is honest, not a crash', () => {
  const root = makeTempProjectRoot();
  try {
    const res = readEvents(root, 'a-run-that-does-not-exist', 0);
    assert.equal(res.ok, true);
    assert.deepEqual(res.events, []);
    assert.equal(res.total_lines, 0);
    assert.match(res.note, /no events\.jsonl yet/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readEvents returns real parsed events and a correct next_after cursor', () => {
  const root = makeTempProjectRoot();
  try {
    const eventsPath = writeEventsFile(root, 'run-a', [
      { event_type: 'run_started', agent: 'orchestrator' },
      { event_type: 'agent_note', agent: 'Build Boss', note: 'one' },
      { event_type: 'agent_note', agent: 'Build Boss', note: 'two' },
    ]);
    assert.ok(fs.existsSync(eventsPath));
    const res = readEvents(root, 'run-a', 0);
    assert.equal(res.ok, true);
    assert.equal(res.events.length, 3);
    assert.equal(res.total_lines, 3);
    assert.equal(res.next_after, 3);
    assert.equal(res.events[2].note, 'two');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readEvents(after) only returns events appended since that cursor', () => {
  const root = makeTempProjectRoot();
  try {
    const eventsPath = writeEventsFile(root, 'run-b', [
      { event_type: 'run_started', agent: 'orchestrator' },
      { event_type: 'agent_note', agent: 'Build Boss', note: 'one' },
    ]);
    const first = readEvents(root, 'run-b', 0);
    assert.equal(first.next_after, 2);
    appendEventLine(eventsPath, { event_type: 'agent_note', agent: 'Build Boss', note: 'three' });
    const second = readEvents(root, 'run-b', first.next_after);
    assert.equal(second.events.length, 1);
    assert.equal(second.events[0].note, 'three');
    assert.equal(second.total_lines, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('R1 proof: a repeat poll only reads the NEW bytes off disk, never re-reads the whole file', () => {
  const root = makeTempProjectRoot();
  const realReadSync = fs.readSync;
  const readLengths = [];
  fs.readSync = function patched(...args) {
    readLengths.push(args[3]); // (fd, buffer, offset, length, position) — args[3] is the byte length requested
    return realReadSync.apply(fs, args);
  };
  try {
    const eventsPath = writeEventsFile(root, 'run-c', [{ event_type: 'run_started', agent: 'orchestrator' }]);
    const first = readEvents(root, 'run-c', 0);
    assert.equal(readLengths.length, 1, 'the first sync does exactly one read (cold cache)');
    const firstReadLen = readLengths[0];

    const newLine = { event_type: 'agent_note', agent: 'Build Boss', note: 'appended-later' };
    appendEventLine(eventsPath, newLine);
    const second = readEvents(root, 'run-c', first.next_after);
    assert.equal(readLengths.length, 2, 'the second sync does exactly one MORE read');
    const secondReadLen = readLengths[readLengths.length - 1];
    const appendedByteLen = Buffer.byteLength(JSON.stringify(newLine) + '\n', 'utf8');
    assert.equal(secondReadLen, appendedByteLen, 'the second read is only the newly appended bytes, not the whole file');
    assert.ok(secondReadLen < firstReadLen + appendedByteLen, 'sanity: the delta read is small, not a full-file reread');
    assert.equal(second.events.length, 1);
    assert.equal(second.events[0].note, 'appended-later');
  } finally {
    fs.readSync = realReadSync;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('malformed JSON lines are counted but never crash the read, and never appear in events[]', () => {
  const root = makeTempProjectRoot();
  try {
    const runDir = path.join(root, '.claude', 'forge-runs', 'run-d');
    fs.mkdirSync(runDir, { recursive: true });
    const eventsPath = path.join(runDir, 'events.jsonl');
    fs.writeFileSync(eventsPath, '{"event_type":"run_started"}\nNOT JSON AT ALL\n{"event_type":"agent_note","note":"ok"}\n', 'utf8');
    const res = readEvents(root, 'run-d', 0);
    assert.equal(res.ok, true);
    assert.equal(res.total_lines, 3);
    assert.equal(res.events.length, 2);
    assert.equal(res.malformed_lines, 1);
    assert.equal(res.next_after, 3, 'the cursor still advances past a malformed line, matching the pre-R1 contract');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a trailing partial line (write caught mid-append) is buffered, not dropped or mis-parsed', () => {
  const root = makeTempProjectRoot();
  try {
    const runDir = path.join(root, '.claude', 'forge-runs', 'run-e');
    fs.mkdirSync(runDir, { recursive: true });
    const eventsPath = path.join(runDir, 'events.jsonl');
    fs.writeFileSync(eventsPath, '{"event_type":"run_started"}\n{"event_type":"agent_note","note":"partial', 'utf8'); // no trailing \n, no closing brace
    const mid = readEvents(root, 'run-e', 0);
    assert.equal(mid.events.length, 1, 'the incomplete trailing line is not surfaced as an event yet');
    assert.equal(mid.total_lines, 1);
    fs.appendFileSync(eventsPath, '-complete"}\n', 'utf8'); // completes the second line
    const after = readEvents(root, 'run-e', 0);
    assert.equal(after.events.length, 2);
    assert.equal(after.events[1].note, 'partial-complete');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CRLF-terminated lines are tolerated like the pre-R1 implementation', () => {
  const root = makeTempProjectRoot();
  try {
    const runDir = path.join(root, '.claude', 'forge-runs', 'run-f');
    fs.mkdirSync(runDir, { recursive: true });
    const eventsPath = path.join(runDir, 'events.jsonl');
    fs.writeFileSync(eventsPath, '{"event_type":"run_started"}\r\n{"event_type":"agent_note","note":"crlf"}\r\n', 'utf8');
    const res = readEvents(root, 'run-f', 0);
    assert.equal(res.events.length, 2);
    assert.equal(res.events[1].note, 'crlf');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a shrunk/replaced events.jsonl (unexpected, defensive) rebuilds the cache instead of trusting stale offsets', () => {
  const root = makeTempProjectRoot();
  try {
    const eventsPath = writeEventsFile(root, 'run-g', [
      { event_type: 'run_started', agent: 'orchestrator' },
      { event_type: 'agent_note', agent: 'Build Boss', note: 'first-generation' },
    ]);
    const before = readEvents(root, 'run-g', 0);
    assert.equal(before.events.length, 2);
    fs.writeFileSync(eventsPath, '{"event_type":"run_started","agent":"orchestrator"}\n', 'utf8'); // replaced with fewer bytes
    const after = readEvents(root, 'run-g', 0);
    assert.equal(after.events.length, 1, 'the cache rebuilt from the new, smaller file rather than serving stale offsets');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// cc-fix-events (WP8-13, Build Boss) — BUG 2 fix (WP12 Finding 2, the fabrication bug): a
// delete+replace whose new size is EQUAL to the previously cached size used to be indistinguishable
// from a normal in-place append (byte-shrink detection only fires on a strict decrease), so the old
// file's already-cached events kept being served as if current. Fixed via a real file-identity
// check (ino+dev from fs.statSync) in addition to the size check.
test('a deleted+recreated events.jsonl with an EQUAL byte size rebuilds via file-identity (ino/dev), never serving the old deleted content', () => {
  const root = makeTempProjectRoot();
  try {
    const eventsPath = writeEventsFile(root, 'run-h-equal', [{ a: 1 }, { a: 2 }]);
    const oldSize = fs.statSync(eventsPath).size;
    const before = readEvents(root, 'run-h-equal', 0); // warms the cache, as a real first poll would
    assert.equal(before.events.length, 2);

    fs.unlinkSync(eventsPath);
    // Pad the replacement to land on EXACTLY the same byte size as the deleted file.
    let replacement = JSON.stringify({ a: 'new-after-equal-replace' }) + '\n';
    const pad = oldSize - Buffer.byteLength(replacement);
    if (pad > 0) replacement = JSON.stringify({ a: 'new-after-equal-replace', pad: 'x'.repeat(Math.max(0, pad - 12)) }) + '\n';
    fs.writeFileSync(eventsPath, replacement, 'utf8');
    assert.equal(fs.statSync(eventsPath).size, Buffer.byteLength(replacement), 'sanity: file really has this exact size');

    const after = readEvents(root, 'run-h-equal', 0);
    assert.equal(after.ok, true);
    assert.ok(after.events.every((e) => e.a !== 1 && e.a !== 2), 'the old (deleted) file content must never be served as current');
    assert.ok(after.events.some((e) => typeof e.a === 'string' && e.a.startsWith('new-after-equal-replace')), 'the real, current file content is what is actually returned');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Same fix, LARGER replacement size (the other side of "not smaller in bytes" that used to bypass
// the pre-fix shrink-only guard).
test('a deleted+recreated events.jsonl with a LARGER byte size rebuilds via file-identity (ino/dev), never serving the old deleted content', () => {
  const root = makeTempProjectRoot();
  try {
    const eventsPath = writeEventsFile(root, 'run-h-larger', [{ a: 1 }, { a: 2 }]);
    const oldSize = fs.statSync(eventsPath).size;
    const before = readEvents(root, 'run-h-larger', 0);
    assert.equal(before.events.length, 2);

    fs.unlinkSync(eventsPath);
    const replacement = JSON.stringify({ a: 'genuinely-new-content-after-replace-padded-longer' }) + '\n';
    assert.ok(Buffer.byteLength(replacement) > oldSize, 'test setup sanity: the replacement really is larger in bytes');
    fs.writeFileSync(eventsPath, replacement, 'utf8');

    const after = readEvents(root, 'run-h-larger', 0);
    assert.equal(after.ok, true);
    assert.ok(after.events.every((e) => e.a !== 1 && e.a !== 2), 'the old (deleted) file content must never be served as current');
    assert.ok(after.events.some((e) => e.a === 'genuinely-new-content-after-replace-padded-longer'), 'the real, current file content is what is actually returned');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// cc-fix-events (WP8-13, Build Boss) — Security Boss AP-6 finding: syncCache()'s
// Buffer.alloc(deltaLen) was unbounded. A single poll that discovers a delta larger than
// MAX_DELTA_READ_BYTES must cap the read, mark the result truncated:true (never silently drop,
// never fabricate completeness), never crash, and keep working normally afterward.
test('an oversize single-poll delta (over the safety cap) truncates instead of crashing, is marked truncated:true, and recovers on the next poll', () => {
  const root = makeTempProjectRoot();
  try {
    const eventsPath = writeEventsFile(root, 'run-h-oversize', [{ event_type: 'run_started' }]);
    const warm = readEvents(root, 'run-h-oversize', 0);
    assert.equal(warm.events.length, 1);
    assert.equal(warm.truncated, false, 'a normal small read is never marked truncated');

    // One single append far larger than the defensive cap, simulating a very chatty run that
    // wrote a lot between two polls.
    const hugeLine = JSON.stringify({ event_type: 'agent_note', note: 'x'.repeat(MAX_DELTA_READ_BYTES + 1024 * 1024) }) + '\n';
    assert.ok(Buffer.byteLength(hugeLine) > MAX_DELTA_READ_BYTES, 'test setup sanity: this single append really exceeds the cap');
    fs.appendFileSync(eventsPath, hugeLine, 'utf8');

    const res = readEvents(root, 'run-h-oversize', warm.next_after);
    assert.equal(res.ok, true, 'an oversize delta must never crash the read or flip ok:false');
    assert.equal(res.truncated, true, 'FIX: a delta read larger than the cap is honestly marked truncated');
    assert.doesNotThrow(() => JSON.stringify(res.events), 'whatever partial/malformed data resulted must still be safely representable, never throw');

    // The gateway must keep working normally on the NEXT poll (not permanently wedged).
    appendEventLine(eventsPath, { event_type: 'agent_note', note: 'after-truncation-still-works' });
    const res2 = readEvents(root, 'run-h-oversize', res.next_after);
    assert.equal(res2.ok, true);
    assert.ok(res2.events.some((e) => e.note === 'after-truncation-still-works'), 'the gateway recovers and continues reading normally after a truncated poll');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('safeIdOk still rejects a traversal-shaped run id at the module boundary', () => {
  const root = makeTempProjectRoot();
  try {
    const res = readEvents(root, '../../etc/passwd', 0);
    assert.equal(res.ok, false);
    assert.match(res.error, /invalid run id/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('_resetEventsCacheForTests clears module state without throwing', () => {
  assert.doesNotThrow(() => _resetEventsCacheForTests());
});
