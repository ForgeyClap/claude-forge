// Codex run B F-06 / F-07 tests for proof.mjs — hostile input refused (a huge/malicious
// forge-artifacts/index.jsonl never gets read in full; unbounded concurrent forge-runcontract.cjs
// child spawns are refused) alongside the ordinary case still working correctly. Isolated
// os.tmpdir() fixtures throughout — buildProof() never calls listRuns() (unlike buildProofAll()), so
// it needs no SYNC_SCAN_ROOTS-real fixture parent (see proof-cc1.test.mjs's own header for why
// buildProofAll() specifically needs one).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildProof,
  buildProofAll,
  _setRunContractCjsForTests,
  _resetRunContractCacheForTests,
  _resetRunContractConcurrencyForTests,
  _getRunContractRunningCountForTests,
  _getRunContractQueueLengthForTests,
  _setMaxRunContractQueueWaitersForTests,
  _resetMaxRunContractQueueWaitersForTests,
  _MAX_INDEX_FILE_READ_BYTES_FOR_TESTS,
  _MAX_INDEX_ENTRIES_FOR_TESTS,
  _MAX_ARTIFACT_DOC_READ_BYTES_FOR_TESTS,
  _setMaxTotalArtifactDocBytesForTests,
  _resetMaxTotalArtifactDocBytesForTests,
  _setMaxDirEntriesListedForTests,
  _resetMaxDirEntriesListedForTests,
} from '../src/proof.mjs';
import { writeEventsFile } from '../test-support/helpers.mjs';
import { COMMAND_CENTER_DATA_DIR } from '../src/paths.mjs';

const tempRoots = [];
function freshRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-proof-bounds-test-'));
  tempRoots.push(root);
  return root;
}
const FIXTURE_PARENT = path.join(COMMAND_CENTER_DATA_DIR, 'gateway-test-tmp-proof-bounds-all');
function freshRootUnderDataDir() {
  fs.mkdirSync(FIXTURE_PARENT, { recursive: true });
  const root = fs.mkdtempSync(path.join(FIXTURE_PARENT, 'fixture-'));
  tempRoots.push(root);
  return root;
}

after(() => {
  _resetRunContractCacheForTests();
  _resetRunContractConcurrencyForTests();
  _resetMaxRunContractQueueWaitersForTests();
  _setRunContractCjsForTests(null);
  for (const r of tempRoots) fs.rmSync(r, { recursive: true, force: true });
  fs.rmSync(FIXTURE_PARENT, { recursive: true, force: true });
});

function writeArtifactDoc(artifactsStoreDir, id, doc) {
  fs.writeFileSync(path.join(artifactsStoreDir, id + '.json'), JSON.stringify(doc), 'utf8');
}
function appendIndexLine(indexFile, entry) {
  fs.appendFileSync(indexFile, JSON.stringify(entry) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------------------------
// F-06: index.jsonl byte bound
// ---------------------------------------------------------------------------------------------

test('F-06 hostile: an index.jsonl bigger than the byte bound is never read in full, but the real (newest, tail) entry still survives', async () => {
  const root = freshRoot();
  const runId = 'run-f06-bytes';
  writeEventsFile(root, runId, [{ event_type: 'run_started', timestamp: '2026-09-27T00:00:00.000Z' }]);
  const artifactsStoreDir = path.join(root, '.claude', 'forge-artifacts');
  fs.mkdirSync(artifactsStoreDir, { recursive: true });
  const indexFile = path.join(artifactsStoreDir, 'index.jsonl');

  // Filler lines with a large pad, well under MAX_INDEX_ENTRIES individually, but together pushing
  // the file comfortably past the byte bound — isolates the BYTE cause from the ENTRY-count cause.
  const pad = 'x'.repeat(4000);
  const fillerLineBytes = Buffer.byteLength(JSON.stringify({ id: 'filler', store: 'junk', ts: '2000-01-01T00:00:00.000Z', pad }) + '\n', 'utf8');
  const fillerLinesNeeded = Math.ceil((_MAX_INDEX_FILE_READ_BYTES_FOR_TESTS + 200_000) / fillerLineBytes);
  assert.ok(fillerLinesNeeded < _MAX_INDEX_ENTRIES_FOR_TESTS, 'test setup must exceed the BYTE bound without also tripping the ENTRY-count bound, to isolate the cause under test');
  const fd = fs.openSync(indexFile, 'a');
  try {
    for (let i = 0; i < fillerLinesNeeded; i++) {
      fs.writeSync(fd, JSON.stringify({ id: 'filler-' + i, store: 'junk', ts: '2000-01-01T00:00:00.000Z', pad }) + '\n');
    }
  } finally { fs.closeSync(fd); }
  // The one REAL, referencing entry — placed LAST, so it is always inside the tail-read window
  // regardless of how many filler bytes precede it.
  writeArtifactDoc(artifactsStoreDir, 'idx-real-tail', { title: 'real tail artifact', type: 'report', path: 'does-not-matter.md', run_id_ref: runId });
  appendIndexLine(indexFile, { id: 'idx-real-tail', store: 'artifacts', ts: '2026-09-27T00:00:01.000Z' });

  assert.ok(fs.statSync(indexFile).size > _MAX_INDEX_FILE_READ_BYTES_FOR_TESTS, 'test setup sanity: the fixture file must genuinely exceed the byte bound');

  const result = await buildProof(root, runId);
  assert.equal(result.ok, true);
  assert.equal(result.artifacts_truncated, true, 'an over-budget index.jsonl must be reported as truncated, never silently read in full or silently dropped');
  const tailArtifact = result.artifacts.find((a) => a.id === 'idx-real-tail');
  assert.ok(tailArtifact, 'the newest (tail) real entry must still be found — byte-bounding keeps the END of the file, not the start');
  assert.equal(tailArtifact.title, 'real tail artifact');
});

test('F-06 hostile: an index.jsonl with more than MAX_INDEX_ENTRIES small lines is capped to the newest N, reported truncated', async () => {
  const root = freshRoot();
  const runId = 'run-f06-entries';
  writeEventsFile(root, runId, [{ event_type: 'run_started', timestamp: '2026-09-27T00:00:00.000Z' }]);
  const artifactsStoreDir = path.join(root, '.claude', 'forge-artifacts');
  fs.mkdirSync(artifactsStoreDir, { recursive: true });
  const indexFile = path.join(artifactsStoreDir, 'index.jsonl');

  const smallFillerCount = _MAX_INDEX_ENTRIES_FOR_TESTS + 200; // over the ENTRY cap
  const fd = fs.openSync(indexFile, 'a');
  try {
    for (let i = 0; i < smallFillerCount; i++) {
      fs.writeSync(fd, JSON.stringify({ id: 'small-filler-' + i, store: 'junk', ts: '2000-01-01T00:00:00.000Z' }) + '\n');
    }
  } finally { fs.closeSync(fd); }
  const totalBytes = fs.statSync(indexFile).size;
  assert.ok(totalBytes < _MAX_INDEX_FILE_READ_BYTES_FOR_TESTS, 'test setup must stay UNDER the byte bound, to isolate the ENTRY-count cause under test');
  writeArtifactDoc(artifactsStoreDir, 'idx-real-last', { title: 'real last artifact', type: 'report', path: 'does-not-matter.md', run_id_ref: runId });
  appendIndexLine(indexFile, { id: 'idx-real-last', store: 'artifacts', ts: '2026-09-27T00:00:01.000Z' });

  const result = await buildProof(root, runId);
  assert.equal(result.ok, true);
  assert.equal(result.artifacts_truncated, true, 'more entries than MAX_INDEX_ENTRIES must be reported as truncated');
  const lastArtifact = result.artifacts.find((a) => a.id === 'idx-real-last');
  assert.ok(lastArtifact, 'the newest (last-written) entry must survive the newest-N-entries cap');
});

test('F-06 hostile: a single indexed document larger than the per-document cap is skipped, reported truncated, never crashes', async () => {
  const root = freshRoot();
  const runId = 'run-f06-doc-size';
  writeEventsFile(root, runId, [{ event_type: 'run_started', timestamp: '2026-09-27T00:00:00.000Z' }]);
  const artifactsStoreDir = path.join(root, '.claude', 'forge-artifacts');
  fs.mkdirSync(artifactsStoreDir, { recursive: true });
  const indexFile = path.join(artifactsStoreDir, 'index.jsonl');

  // One oversized doc (bigger than the per-document cap)...
  writeArtifactDoc(artifactsStoreDir, 'idx-huge', { title: 'huge', type: 'report', path: 'x.md', blob: 'z'.repeat(_MAX_ARTIFACT_DOC_READ_BYTES_FOR_TESTS + 50_000) });
  appendIndexLine(indexFile, { id: 'idx-huge', store: 'artifacts', ts: '2026-09-27T00:00:00.000Z' });
  // ...alongside one perfectly ordinary doc, proving the cap skips ONLY the oversized one.
  writeArtifactDoc(artifactsStoreDir, 'idx-ok', { title: 'ok', type: 'report', path: 'y.md', run_id_ref: runId });
  appendIndexLine(indexFile, { id: 'idx-ok', store: 'artifacts', ts: '2026-09-27T00:00:01.000Z' });

  const result = await buildProof(root, runId);
  assert.equal(result.ok, true);
  assert.equal(result.artifacts_truncated, true, 'a document over the per-document size cap must be reported as truncated');
  assert.ok(!result.artifacts.some((a) => a.id === 'idx-huge'), 'the oversized document must never be loaded/returned');
  assert.ok(result.artifacts.some((a) => a.id === 'idx-ok' && a.title === 'ok'), 'an ordinary-sized document alongside it must still come through normally');
});

test('F-06 ordinary case: a small index.jsonl well under every bound -> artifacts_truncated:false', async () => {
  const root = freshRoot();
  const runId = 'run-f06-ordinary';
  writeEventsFile(root, runId, [{ event_type: 'run_started', timestamp: '2026-09-27T00:00:00.000Z' }]);
  const artifactsStoreDir = path.join(root, '.claude', 'forge-artifacts');
  fs.mkdirSync(artifactsStoreDir, { recursive: true });
  const indexFile = path.join(artifactsStoreDir, 'index.jsonl');
  writeArtifactDoc(artifactsStoreDir, 'idx-small', { title: 'small', type: 'report', path: 'z.md', run_id_ref: runId });
  appendIndexLine(indexFile, { id: 'idx-small', store: 'artifacts', ts: '2026-09-27T00:00:00.000Z' });

  const result = await buildProof(root, runId);
  assert.equal(result.ok, true);
  assert.equal(result.artifacts_truncated, false);
  assert.ok(result.artifacts.some((a) => a.id === 'idx-small'));
});

test('F-06: buildProofAll() surfaces the SAME artifacts_truncated signal (shared readIndexEntries/readArtifactStoreDoc)', async () => {
  const root = freshRootUnderDataDir();
  writeEventsFile(root, 'run-f06-all', [{ event_type: 'run_started', timestamp: '2026-09-27T00:00:00.000Z' }]);
  const artifactsStoreDir = path.join(root, '.claude', 'forge-artifacts');
  fs.mkdirSync(artifactsStoreDir, { recursive: true });
  const indexFile = path.join(artifactsStoreDir, 'index.jsonl');
  const pad = 'x'.repeat(4000);
  const fillerLineBytes = Buffer.byteLength(JSON.stringify({ id: 'filler', store: 'junk', ts: '2000-01-01T00:00:00.000Z', pad }) + '\n', 'utf8');
  const fillerLinesNeeded = Math.ceil((_MAX_INDEX_FILE_READ_BYTES_FOR_TESTS + 200_000) / fillerLineBytes);
  const fd = fs.openSync(indexFile, 'a');
  try {
    for (let i = 0; i < fillerLinesNeeded; i++) {
      fs.writeSync(fd, JSON.stringify({ id: 'filler-' + i, store: 'junk', ts: '2000-01-01T00:00:00.000Z', pad }) + '\n');
    }
  } finally { fs.closeSync(fd); }

  const result = buildProofAll(root);
  assert.equal(result.ok, true);
  assert.equal(result.artifacts_truncated, true);
});

// ---------------------------------------------------------------------------------------------
// F-07: in-flight dedup + a global concurrency cap on forge-runcontract.cjs child spawns
// ---------------------------------------------------------------------------------------------

// A blocking fixture script: records that it started (unique per run id via a marker file this
// test computes the same way), then busy-waits for a release marker before finally answering —
// gives the test full, deterministic control over exactly when each "child process" finishes,
// without depending on fragile microtask-ordering assumptions.
function writeBlockingFixture(fixturePath, markerDir) {
  fs.writeFileSync(
    fixturePath,
    [
      "const fs = require('fs');",
      "const path = require('path');",
      // real child argv: [0]=node [1]=fixturePath [2]='check' [3]='--run' [4]=runId [5]='--root' [6]=root [7]='--json'
      'const runId = process.argv[4];',
      `const markerDir = ${JSON.stringify(markerDir)};`,
      "const startedMarker = path.join(markerDir, 'started-' + runId + '.marker');",
      "const releaseMarker = path.join(markerDir, 'release-' + runId + '.marker');",
      "const spawnLog = path.join(markerDir, 'spawn-log-' + runId + '.txt');",
      "fs.appendFileSync(spawnLog, String(process.pid) + '\\n');",
      "fs.writeFileSync(startedMarker, 'started');",
      'const deadline = Date.now() + 8000;',
      'while (!fs.existsSync(releaseMarker) && Date.now() < deadline) { /* deliberate busy-wait — test-only fixture */ }',
      "process.stdout.write(JSON.stringify({ ok: true, run_id: runId }));",
    ].join('\n'),
    'utf8',
  );
}
async function waitUntil(predicate, { timeoutMs = 4000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return predicate();
}

test('F-07 hostile: two concurrent requests for the SAME project+run reuse ONE in-flight check, never spawn twice', async () => {
  const root = freshRoot();
  const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-proof-bounds-markers-'));
  tempRoots.push(markerDir);
  const runId = 'run-f07-dedup';
  writeEventsFile(root, runId, [{ event_type: 'run_started', timestamp: '2026-09-27T00:00:00.000Z' }]);
  const fixturePath = path.join(markerDir, 'blocking-fixture.cjs');
  writeBlockingFixture(fixturePath, markerDir);
  _setRunContractCjsForTests(fixturePath);
  _resetRunContractCacheForTests();
  _resetRunContractConcurrencyForTests();

  const startedMarker = path.join(markerDir, 'started-' + runId + '.marker');
  const releaseMarker = path.join(markerDir, 'release-' + runId + '.marker');
  const spawnLog = path.join(markerDir, 'spawn-log-' + runId + '.txt');

  const p1 = buildProof(root, runId);
  const started = await waitUntil(() => fs.existsSync(startedMarker));
  assert.ok(started, 'the first call must actually spawn the fixture');
  // A SECOND call for the exact same project+run while the first is still blocked in its child
  // process — real wall-clock time has already passed (the poll above), so the first call has
  // unquestionably already registered itself as in-flight by now.
  const p2 = buildProof(root, runId);

  fs.writeFileSync(releaseMarker, 'go');
  const [r1, r2] = await Promise.all([p1, p2]);

  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(r1.run_contract.available, true);
  assert.deepEqual(r1.run_contract.result, r2.run_contract.result, 'both callers must receive the SAME real result, not two independently-fabricated ones');
  const spawnCount = fs.readFileSync(spawnLog, 'utf8').trim().split('\n').filter(Boolean).length;
  assert.equal(spawnCount, 1, 'exactly ONE child process must have been spawned for two concurrent requests on the same key');

  _setRunContractCjsForTests(null);
  _resetRunContractCacheForTests();
  _resetRunContractConcurrencyForTests();
});

test('F-07 ordinary case: two DIFFERENT runs are never merged by the in-flight dedup — each gets its own correct result', async () => {
  const root = freshRoot();
  const fixtureScript = path.join(root, 'echo-runcontract.cjs');
  fs.writeFileSync(
    fixtureScript,
    // real child argv: [0]=node [1]=fixtureScript [2]='check' [3]='--run' [4]=runId ...
    "process.stdout.write(JSON.stringify({ ok: true, run_id: process.argv[4] }));\n",
    'utf8',
  );
  writeEventsFile(root, 'run-f07-alpha', [{ event_type: 'run_started', timestamp: '2026-09-27T00:00:00.000Z' }]);
  writeEventsFile(root, 'run-f07-beta', [{ event_type: 'run_started', timestamp: '2026-09-27T00:00:00.000Z' }]);
  _setRunContractCjsForTests(fixtureScript);
  _resetRunContractCacheForTests();
  _resetRunContractConcurrencyForTests();

  const [rAlpha, rBeta] = await Promise.all([buildProof(root, 'run-f07-alpha'), buildProof(root, 'run-f07-beta')]);
  assert.equal(rAlpha.run_contract.result.run_id, 'run-f07-alpha');
  assert.equal(rBeta.run_contract.result.run_id, 'run-f07-beta');

  _setRunContractCjsForTests(null);
  _resetRunContractCacheForTests();
  _resetRunContractConcurrencyForTests();
});

test('F-07 hostile: a 3rd concurrent DIFFERENT-key request waits for a free slot instead of spawning immediately, and is granted one once freed', async () => {
  const root = freshRoot();
  const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-proof-bounds-markers-conc-'));
  tempRoots.push(markerDir);
  const fixturePath = path.join(markerDir, 'blocking-fixture.cjs');
  writeBlockingFixture(fixturePath, markerDir);
  const runIds = ['run-f07-conc-a', 'run-f07-conc-b', 'run-f07-conc-c'];
  for (const id of runIds) writeEventsFile(root, id, [{ event_type: 'run_started', timestamp: '2026-09-27T00:00:00.000Z' }]);
  _setRunContractCjsForTests(fixturePath);
  _resetRunContractCacheForTests();
  _resetRunContractConcurrencyForTests();

  const started = (id) => path.join(markerDir, 'started-' + id + '.marker');
  const release = (id) => path.join(markerDir, 'release-' + id + '.marker');

  const [pA, pB, pC] = runIds.map((id) => buildProof(root, id));

  assert.ok(await waitUntil(() => fs.existsSync(started(runIds[0])) && fs.existsSync(started(runIds[1]))), 'the first TWO (the concurrency cap) must both start');
  // Give the (deliberately not-started) 3rd request a brief, bounded window to prove it does NOT
  // start immediately — it must be queued, not spawned, once the cap of 2 is already occupied.
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(fs.existsSync(started(runIds[2])), false, 'the 3rd request must NOT spawn while both slots are occupied — it must wait for a free slot');
  assert.ok(_getRunContractQueueLengthForTests() >= 1, 'the 3rd request must be recorded as a queued waiter, not silently dropped or spawned anyway');

  // Free ONE slot — the queued 3rd request must be handed that freed slot and start.
  fs.writeFileSync(release(runIds[0]), 'go');
  assert.ok(await waitUntil(() => fs.existsSync(started(runIds[2]))), 'once a slot frees, the queued request must be granted it and actually start');

  fs.writeFileSync(release(runIds[1]), 'go');
  fs.writeFileSync(release(runIds[2]), 'go');
  const [rA, rB, rC] = await Promise.all([pA, pB, pC]);
  assert.equal(rA.run_contract.result.run_id, runIds[0]);
  assert.equal(rB.run_contract.result.run_id, runIds[1]);
  assert.equal(rC.run_contract.result.run_id, runIds[2]);
  assert.equal(_getRunContractRunningCountForTests(), 0, 'every slot must be released once all three checks finish — no leaked concurrency accounting');
  assert.equal(_getRunContractQueueLengthForTests(), 0);

  _setRunContractCjsForTests(null);
  _resetRunContractCacheForTests();
  _resetRunContractConcurrencyForTests();
});

test('F-07 hostile: once the wait queue itself is also full, a further request gets an honest "check pending" result — never grows the queue without bound, never spawns anyway', async () => {
  const root = freshRoot();
  const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-proof-bounds-markers-queuefull-'));
  tempRoots.push(markerDir);
  const fixturePath = path.join(markerDir, 'blocking-fixture.cjs');
  writeBlockingFixture(fixturePath, markerDir);
  const runIds = ['run-f07-qf-a', 'run-f07-qf-b', 'run-f07-qf-c', 'run-f07-qf-d'];
  for (const id of runIds) writeEventsFile(root, id, [{ event_type: 'run_started', timestamp: '2026-09-27T00:00:00.000Z' }]);
  _setRunContractCjsForTests(fixturePath);
  _resetRunContractCacheForTests();
  _resetRunContractConcurrencyForTests();
  _setMaxRunContractQueueWaitersForTests(1); // small on purpose — proving overflow needs only 1 running + 1 queued + 1 more, not 50+2

  const started = (id) => path.join(markerDir, 'started-' + id + '.marker');
  const release = (id) => path.join(markerDir, 'release-' + id + '.marker');

  // a, b fill the 2 concurrency slots; c fills the (test-shrunk) 1-slot queue; d must be refused
  // outright with an honest pending result rather than growing the queue to 2.
  const pA = buildProof(root, runIds[0]);
  const pB = buildProof(root, runIds[1]);
  assert.ok(await waitUntil(() => fs.existsSync(started(runIds[0])) && fs.existsSync(started(runIds[1]))));
  const pC = buildProof(root, runIds[2]);
  await waitUntil(() => _getRunContractQueueLengthForTests() >= 1, { timeoutMs: 2000 });
  assert.equal(_getRunContractQueueLengthForTests(), 1, 'the (test-shrunk) queue must now be exactly full');

  const dResult = await buildProof(root, runIds[3]);
  assert.equal(dResult.ok, true, 'buildProof() itself still answers normally even when the run-contract sub-check is refused');
  assert.equal(dResult.run_contract.available, false);
  assert.equal(dResult.run_contract.pending, true, 'an honest "check pending" — never a fabricated available:true, and never silently queued past the cap');
  assert.equal(fs.existsSync(started(runIds[3])), false, 'the 4th request must never have spawned a child at all');
  assert.equal(_getRunContractQueueLengthForTests(), 1, 'the queue must still be exactly 1 — the refused request must never have been pushed onto it');

  fs.writeFileSync(release(runIds[0]), 'go');
  fs.writeFileSync(release(runIds[1]), 'go');
  fs.writeFileSync(release(runIds[2]), 'go');
  await Promise.all([pA, pB, pC]);
  assert.equal(_getRunContractRunningCountForTests(), 0);
  assert.equal(_getRunContractQueueLengthForTests(), 0);

  _setRunContractCjsForTests(null);
  _resetRunContractCacheForTests();
  _resetRunContractConcurrencyForTests();
  _resetMaxRunContractQueueWaitersForTests();
});

test('F-06 total budget: one request reads at most the total document budget, newest first; the oldest drop, order is kept, truncated is reported', async () => {
  const root = freshRoot();
  const runId = 'run-f06-total';
  writeEventsFile(root, runId, [{ event_type: 'run_started', timestamp: '2026-09-27T00:00:00.000Z' }]);
  const artifactsStoreDir = path.join(root, '.claude', 'forge-artifacts');
  fs.mkdirSync(artifactsStoreDir, { recursive: true });
  const indexFile = path.join(artifactsStoreDir, 'index.jsonl');
  const pad = 'y'.repeat(3000);
  for (const id of ['doc-oldest', 'doc-middle', 'doc-newest']) {
    writeArtifactDoc(artifactsStoreDir, id, { title: id, type: 'report', path: id + '.md', run_id_ref: runId, pad });
    appendIndexLine(indexFile, { id, store: 'artifacts', ts: '2026-09-27T00:00:00.000Z' });
  }
  const oneDoc = fs.statSync(path.join(artifactsStoreDir, 'doc-newest.json')).size;
  _setMaxTotalArtifactDocBytesForTests(oneDoc * 2 + 10); // room for exactly two documents
  try {
    const result = await buildProof(root, runId);
    assert.equal(result.ok, true);
    assert.equal(result.artifacts_truncated, true);
    const ids = result.artifacts.filter((x) => x.source === 'forge-artifacts-index').map((x) => x.id);
    assert.deepEqual(ids, ['doc-middle', 'doc-newest'], 'the two newest fit, in index order; the oldest is the one dropped');
  } finally {
    _resetMaxTotalArtifactDocBytesForTests();
  }
});

test('Codex verification F-06: a run artifact folder longer than the listing budget is listed in part and reported truncated', async () => {
  const root = freshRoot();
  const runId = 'run-f06-listing';
  writeEventsFile(root, runId, [{ event_type: 'run_started', timestamp: '2026-09-27T00:00:00.000Z' }]);
  const artifactsDir = path.join(root, '.claude', 'forge-runs', runId, 'artifacts');
  fs.mkdirSync(artifactsDir, { recursive: true });
  for (const name of ['a.md', 'b.md', 'c.md', 'd.md']) fs.writeFileSync(path.join(artifactsDir, name), 'x');
  _setMaxDirEntriesListedForTests(2);
  try {
    const result = await buildProof(root, runId);
    assert.equal(result.ok, true);
    assert.equal(result.artifacts_truncated, true);
    assert.ok(result.artifacts.filter((a) => a.source === 'run-artifacts-dir').length <= 2);
  } finally {
    _resetMaxDirEntriesListedForTests();
  }
  const full = await buildProof(root, runId);
  assert.equal(full.artifacts.filter((a) => a.source === 'run-artifacts-dir').length, 4);
  assert.equal(full.artifacts_truncated, false);
});
