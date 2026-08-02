// WP12 (cc-wp12-chaos) — real failure-mode / chaos testing of the gateway's read paths.
// Every scenario here is a genuine on-disk failure mode a real Forge project can hit: a
// corrupted write caught mid-append, a file vanishing out from under an open SSE tail, a run
// directory that only has half its expected shape, an empty file, a large burst, a corrupted
// conversation record, and a whole project directory disappearing between two calls. The bar
// for "pass" is NOT "returns 200" — it is "never throws, never fabricates data that is not on
// disk, and reports an honest empty/degraded result instead". This file adds tests only; it does
// not modify any src/*.mjs module.
//
// Every fixture lives under an isolated temp directory this file creates and removes itself —
// never the real .claude/forge-runs and never the real command-center/.data/conversations. Two
// fixture styles are used, matching the two existing conventions in this test directory:
//   - os.tmpdir()-based roots (test-support/helpers.mjs::makeTempProjectRoot()) for readEvents()/
//     attachEventsStream(), which do not check SYNC_SCAN_ROOT containment (see events-incremental
//     .test.mjs / events-stream.test.mjs).
//   - a fixture nested under COMMAND_CENTER_DATA_DIR for listRuns(), which DOES defense-in-depth
//     check that its argument sits under SYNC_SCAN_ROOT (see runs.test.mjs's own header comment
//     for why an os.tmpdir() root would never reach that code path at all).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { readEvents, attachEventsStream, _resetEventsCacheForTests } from '../src/events.mjs';
import { listRuns } from '../src/runs.mjs';
import { COMMAND_CENTER_DATA_DIR } from '../src/paths.mjs';
import {
  createConversation,
  appendUserTurn,
  appendAssistantTurn,
  readConversation,
  listConversations,
  _setConversationsDirForTests,
  _resetConversationsForTests,
} from '../src/conversations.mjs';
import { makeTempProjectRoot, writeEventsFile, appendEventLine } from '../test-support/helpers.mjs';

const FIXTURE_PARENT = path.join(COMMAND_CENTER_DATA_DIR, 'gateway-test-tmp-chaos');
const tempRoots = []; // os.tmpdir()-based roots, removed in `after`
const scanRootFixtures = []; // SYNC_SCAN_ROOT-contained roots (listRuns), removed in `after`

function freshScanRootFixture() {
  fs.mkdirSync(FIXTURE_PARENT, { recursive: true });
  const root = fs.mkdtempSync(path.join(FIXTURE_PARENT, 'fixture-'));
  scanRootFixtures.push(root);
  return root;
}

function freshTempRoot() {
  const root = makeTempProjectRoot();
  tempRoots.push(root);
  return root;
}

after(() => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
  for (const root of scanRootFixtures) fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(FIXTURE_PARENT, { recursive: true, force: true });
  _resetEventsCacheForTests();
});

// Minimal fake req/res pair, mirroring events-stream.test.mjs's own helper exactly (that file's
// helper is not exported, so it is re-declared here rather than reached into private test scope).
function makeFakeRes() {
  const emitter = new EventEmitter();
  const res = {
    chunks: [],
    status: null,
    writableEnded: false,
    writeHead(status) { res.status = status; },
    write(chunk) { if (!res.writableEnded) res.chunks.push(chunk); return true; },
    end(chunk) { if (chunk) res.chunks.push(chunk); res.writableEnded = true; },
    on(evt, cb) { emitter.on(evt, cb); },
    text() { return res.chunks.join(''); },
    _emitClose() { res.writableEnded = true; emitter.emit('close'); },
  };
  return res;
}
function makeFakeReq(headers = {}) {
  const emitter = new EventEmitter();
  return { headers, on(evt, cb) { emitter.on(evt, cb); } };
}

// ── 1. malformed line mid-file, INCLUDING while an SSE tail is actively open ──────────────────
test('CHAOS: a malformed line mid-file is counted honestly and never surfaces as a fabricated event', () => {
  const root = freshTempRoot();
  const eventsPath = writeEventsFile(root, 'run-chaos-a', [{ event_type: 'run_started' }]);
  fs.appendFileSync(eventsPath, 'THIS IS NOT JSON AT ALL {broken\n', 'utf8');
  appendEventLine(eventsPath, { event_type: 'agent_note', note: 'still-alive-after-garbage' });

  const res = readEvents(root, 'run-chaos-a', 0);
  assert.equal(res.ok, true, 'a malformed line must never flip the whole read to ok:false');
  assert.equal(res.total_lines, 3);
  assert.equal(res.events.length, 2, 'exactly the 2 real events, garbage excluded');
  assert.equal(res.malformed_lines, 1);
  assert.equal(res.events[1].note, 'still-alive-after-garbage', 'reading resumes correctly after the bad line');
});

test('CHAOS: a live SSE tail survives a malformed line appended WHILE it is open, and never forwards it as data', async () => {
  const root = freshTempRoot();
  const eventsPath = writeEventsFile(root, 'run-chaos-b', [{ event_type: 'run_started' }]);
  const req = makeFakeReq();
  const res = makeFakeRes();
  attachEventsStream({ req, res, projectPath: root, runId: 'run-chaos-b', heartbeatMs: 999_999, fallbackPollMs: 30 });
  assert.equal(res.status, 200);

  // Append garbage, then a real event, both while the "connection" is open.
  fs.appendFileSync(eventsPath, 'GARBAGE-MID-STREAM\n', 'utf8');
  appendEventLine(eventsPath, { event_type: 'agent_note', note: 'after-garbage-live' });
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.equal(res.writableEnded, false, 'the stream must still be open — a bad line must never crash/close it');
  const text = res.text();
  assert.match(text, /"note":"after-garbage-live"/, 'the real event after the garbage still arrives');
  assert.doesNotMatch(text, /GARBAGE-MID-STREAM/, 'the malformed line itself is never forwarded as an SSE data frame');
  res._emitClose();
});

// ── 2. events.jsonl deleted while an SSE tail is open, then recreated ─────────────────────────
// WP12 found two DISTINCT real defects here (confirmed by direct, isolated repro against the real
// module, independent of this test file). WP8-13 (Build Boss, cc-fix-events) FIXED both at the
// root in events.mjs: syncCache() now rebuilds on a file-IDENTITY change (real ino+dev from
// fs.statSync, verified to change reliably across unlink+recreate on this Windows/NTFS host even
// for an equal-or-larger replacement size — NOT birthtimeMs, which was probed and found unreliable
// here due to Windows NTFS creation-time "tunneling") in addition to the pre-existing byte-shrink
// check, and every rebuild bumps a `generation` counter that attachEventsStream()'s own
// {generation, index} cursor watches so it can never get stuck comparing against a stale/replaced
// array. These two tests now assert the CORRECTED behavior and remain the regression witness for
// both bugs (previously they asserted the confirmed-buggy behavior; see git history for the
// pre-fix version of this file if the original failure needs to be re-examined).
//
// FIXED A (this test, part 1 — was WP12 Finding 1 / BUG 1): when the file is deleted and
// recreated with a STRICTLY SMALLER byte size, an ALREADY-OPEN SSE tail must keep delivering new
// events instead of silently going stale forever.
test('FIXED (was CHAOS FINDING HIGH): after a real shrink-replace, an already-open SSE tail keeps delivering new events (generation-based cursor)', async () => {
  const root = freshTempRoot();
  const eventsPath = writeEventsFile(root, 'run-chaos-c', [
    { event_type: 'run_started' },
    { event_type: 'agent_note', note: 'before-deletion-padding-to-make-this-genuinely-larger-in-bytes' },
  ]);
  const oldSize = fs.statSync(eventsPath).size;
  const req = makeFakeReq();
  const res = makeFakeRes();
  attachEventsStream({ req, res, projectPath: root, runId: 'run-chaos-c', heartbeatMs: 999_999, fallbackPollMs: 20 });
  try {
    assert.match(res.text(), /"note":"before-deletion/);

    fs.unlinkSync(eventsPath);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(res.writableEnded, false, 'the underlying file vanishing must not close/crash the live stream (this part is solid)');

    const newLine = JSON.stringify({ event_type: 'agent_note', note: 'after-recreate-short' }) + '\n';
    assert.ok(Buffer.byteLength(newLine) < oldSize, 'test setup sanity: the replacement really is smaller in bytes (a genuine shrink)');
    fs.writeFileSync(eventsPath, newLine, 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(res.writableEnded, false, 'still no crash — the process stays healthy');
    // FIXED: the new event now DOES reach the already-open stream (the cursor reset to generation 1).
    assert.match(res.text(), /after-recreate-short/, 'FIX: the live SSE tail delivers the post-shrink event to a client that was already connected');
  } finally {
    // MUST run even if an assertion above throws — otherwise the still-open SSE stream's
    // fallback-poll/heartbeat intervals keep the process event loop alive forever (a real hang,
    // confirmed while proving this test fails pre-fix: node --test never exited until this
    // cleanup was made unconditional).
    res._emitClose();
  }

  const freshPoll = readEvents(root, 'run-chaos-c', 0);
  assert.equal(freshPoll.ok, true);
  assert.equal(freshPoll.events.length, 1);
  assert.equal(freshPoll.events[0].note, 'after-recreate-short');
});

// FIXED B (this test, part 2 — was WP12 Finding 2 / BUG 2, the fabrication bug): when the file is
// deleted and recreated with a byte size that is EQUAL TO OR LARGER than the previous cached size,
// readEvents() must serve the NEW file's real content, never the OLD (deleted) file's events.
test('FIXED (was CHAOS FINDING HIGH — fabrication): a deleted+recreated events.jsonl whose replacement is NOT smaller in bytes now serves the NEW file, never stale data', () => {
  const root = freshTempRoot();
  const eventsPath = writeEventsFile(root, 'run-chaos-fabrication', [{ a: 1 }, { a: 2 }]);
  const oldSize = fs.statSync(eventsPath).size;
  readEvents(root, 'run-chaos-fabrication', 0); // warms the module's shared cache, exactly as a real first poll would

  fs.unlinkSync(eventsPath);
  const replacement = JSON.stringify({ a: 'genuinely-new-content-after-replace-padded-longer' }) + '\n';
  assert.ok(Buffer.byteLength(replacement) >= oldSize, 'test setup sanity: the replacement is NOT smaller in bytes, so byte-shrink detection alone would be bypassed');
  fs.writeFileSync(eventsPath, replacement, 'utf8');

  const claimed = readEvents(root, 'run-chaos-fabrication', 0);
  const realOnDiskNow = fs.readFileSync(eventsPath, 'utf8');

  assert.equal(claimed.ok, true);
  assert.ok(
    claimed.events.every((e) => e.a !== 1 && e.a !== 2),
    'FIX: readEvents() must never serve events from the DELETED file as current data',
  );
  assert.match(
    JSON.stringify(claimed.events),
    /genuinely-new-content-after-replace/,
    'FIX: the real, current content on disk is what the caller receives',
  );
  assert.doesNotMatch(realOnDiskNow, /"a":1/, 'sanity: the real file on disk genuinely no longer contains the old content');
});

// ── 3. a run dir with run.json but no events.jsonl — both endpoints must agree, honestly ──────
test('CHAOS: a run.json-only run dir (no events.jsonl yet) is reported consistently by listRuns() and readEvents()', () => {
  const root = freshScanRootFixture();
  const runDir = path.join(root, '.claude', 'forge-runs', 'forge-chaos-run-json-only');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ run_id: 'forge-chaos-run-json-only' }), 'utf8');

  const runsResult = listRuns(root);
  assert.equal(runsResult.ok, true);
  assert.equal(runsResult.runs.length, 1);
  assert.equal(runsResult.runs[0].has_run_json, true);
  assert.equal(runsResult.runs[0].event_count, 0);

  const eventsResult = readEvents(root, 'forge-chaos-run-json-only', 0);
  assert.equal(eventsResult.ok, true);
  assert.deepEqual(eventsResult.events, []);
  assert.match(eventsResult.note, /no events\.jsonl yet/, 'readEvents is honest, not a crash, for a real run with no events file yet');
});

// ── 4. a genuinely 0-byte events.jsonl (distinct from "file does not exist") ───────────────────
test('CHAOS: a 0-byte events.jsonl reads as zero real events, never as a parse error', () => {
  const root = freshTempRoot();
  const runDir = path.join(root, '.claude', 'forge-runs', 'run-chaos-zero-byte');
  fs.mkdirSync(runDir, { recursive: true });
  const eventsPath = path.join(runDir, 'events.jsonl');
  fs.writeFileSync(eventsPath, '', 'utf8');
  assert.equal(fs.statSync(eventsPath).size, 0);

  const res = readEvents(root, 'run-chaos-zero-byte', 0);
  assert.equal(res.ok, true);
  assert.deepEqual(res.events, []);
  assert.equal(res.total_lines, 0);
  assert.equal(res.malformed_lines, 0);
});

// ── 5. perf sanity: 5000-line events.jsonl completes well inside a 5s budget ───────────────────
test('CHAOS: reading a 5000-line events.jsonl completes in under 5 seconds and loses nothing', () => {
  const root = freshTempRoot();
  const lines = [];
  for (let i = 0; i < 5000; i += 1) lines.push({ event_type: 'agent_note', seq: i, note: 'perf-line-' + i });
  writeEventsFile(root, 'run-chaos-perf', lines);

  const startedAt = Date.now();
  const res = readEvents(root, 'run-chaos-perf', 0);
  const elapsedMs = Date.now() - startedAt;

  assert.equal(res.ok, true);
  assert.equal(res.total_lines, 5000);
  assert.equal(res.events.length, 5000);
  assert.equal(res.malformed_lines, 0);
  assert.equal(res.events[4999].seq, 4999, 'the last line really made it through, nothing silently truncated');
  assert.ok(elapsedMs < 5000, `expected < 5000ms, got ${elapsedMs}ms`);
});

// ── 6. a conversation JSONL with a corrupt line ────────────────────────────────────────────────
test('CHAOS: a corrupt line in a conversation JSONL is skipped, never crashing the read or losing the valid turns', () => {
  const convTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-chaos-conv-'));
  _setConversationsDirForTests(convTempDir);
  try {
    const conv = createConversation({ project: 'chaos-demo-project', title: 'Chaos thread' });
    appendUserTurn(conv.id, 'first real message');
    const convPath = path.join(convTempDir, conv.id + '.jsonl');
    fs.appendFileSync(convPath, 'NOT VALID JSON {{{\n', 'utf8');
    appendAssistantTurn(conv.id, { text: 'assistant reply after the corrupt line', exit_code: 0 });

    const read = readConversation(conv.id);
    assert.equal(read.ok, true);
    assert.ok(read.meta, 'meta line survives corruption elsewhere in the file');
    assert.equal(read.turns.length, 2, 'both real turns are present; the corrupt line is silently skipped, not counted as a turn');
    assert.equal(read.turns[1].text, 'assistant reply after the corrupt line');

    const list = listConversations();
    const row = list.find((r) => r.id === conv.id);
    assert.ok(row, 'the conversation still appears in the list despite the corrupt line');
    assert.equal(row.turn_count, 2);
  } finally {
    _resetConversationsForTests();
    fs.rmSync(convTempDir, { recursive: true, force: true });
  }
});

// ── 7. the project path disappears mid-request (between two calls to the same read path) ──────
// A real HTTP-level repro would need a fake entry injected into the live project registry, which
// has no test-only override seam (unlike conversations.mjs's _setConversationsDirForTests) and
// this WP forbids adding one to src/*.mjs. So this exercises the exact function each route calls
// (readEvents()/listRuns()) at the same two call sites server.mjs uses, before and after the
// project directory is deleted out from under it — the honest failure mode the route would see.
test('CHAOS: readEvents() on a project root that disappeared between two calls degrades to an honest empty result, never a crash', () => {
  const root = freshTempRoot();
  writeEventsFile(root, 'run-chaos-vanish', [{ event_type: 'run_started' }, { event_type: 'agent_note', note: 'seen-before-vanish' }]);
  const before = readEvents(root, 'run-chaos-vanish', 0);
  assert.equal(before.ok, true);
  assert.equal(before.events.length, 2);

  fs.rmSync(root, { recursive: true, force: true }); // the whole project directory disappears
  tempRoots.splice(tempRoots.indexOf(root), 1); // already gone; don't double-rm in `after`

  const after = readEvents(root, 'run-chaos-vanish', 0);
  assert.equal(after.ok, true, 'a vanished project directory must read as an honest empty run, never ok:false/throw');
  assert.deepEqual(after.events, []);
  assert.equal(after.total_lines, 0);
  assert.match(after.note, /no events\.jsonl yet/);

  // And a stream request against the same now-vanished path is equally honest, not a crash.
  const req = makeFakeReq();
  const res = makeFakeRes();
  attachEventsStream({ req, res, projectPath: root, runId: 'run-chaos-vanish', heartbeatMs: 999_999, fallbackPollMs: 999_999 });
  assert.equal(res.status, 200);
  assert.match(res.text(), /no events\.jsonl yet/);
  res._emitClose();
});

test('CHAOS: listRuns() on a project root that disappeared between two calls degrades to an honest empty result, never a crash', () => {
  const root = freshScanRootFixture();
  const runDir = path.join(root, '.claude', 'forge-runs', 'forge-chaos-vanish-run');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'run.json'), '{}', 'utf8');

  const before = listRuns(root);
  assert.equal(before.ok, true);
  assert.equal(before.runs.length, 1);

  fs.rmSync(root, { recursive: true, force: true });
  scanRootFixtures.splice(scanRootFixtures.indexOf(root), 1); // already gone; don't double-rm in `after`

  const after = listRuns(root);
  assert.equal(after.ok, true, 'a vanished project directory must read as an honest empty run list, never ok:false/throw');
  assert.deepEqual(after.runs, []);
});
