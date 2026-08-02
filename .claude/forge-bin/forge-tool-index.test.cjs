#!/usr/bin/env node
'use strict';
// forge-tool-index.test.cjs — real tests for the cross-run event search index + the `rejected_approach`
// event registration (mining-ronde-1 §1, 2026-07-31).
//
// FIXTURE DISCIPLINE: every index test runs under a fresh os.tmpdir() project root — this file NEVER writes
// to this repo's real .claude/forge-index/ and NEVER reads this repo's real forge-runs/. The ONLY exception
// is section 6 (the 3-places event-registration tests), which must use a throwaway run id under the REAL
// .claude/forge-runs/ because log-event.cjs derives its CLAUDE_DIR from its own __dirname and cannot be
// pointed elsewhere; that run dir is removed again in a try/finally.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const idx = require('./forge-tool-index.cjs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

const TOOL = path.join(__dirname, 'forge-tool-index.cjs');
const LOG_EVENT = path.join(__dirname, '..', 'forge-dashboard', 'log-event.cjs');
const REAL_ROOT = path.resolve(__dirname, '..', '..');

// Real, un-faked capability probe: whatever the tool claims about node:sqlite must match what this test
// process can itself observe right now. Never a hardcoded assumption about the host Node build.
let sqliteReallyAvailable = true;
try {
  const { DatabaseSync } = require('node:sqlite');
  const probe = new DatabaseSync(':memory:');
  probe.exec('CREATE VIRTUAL TABLE probe_fts USING fts5(x)');
  probe.close();
} catch { sqliteReallyAvailable = false; }

function freshRoot(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
  fs.mkdirSync(path.join(root, '.claude', 'forge-runs'), { recursive: true });
  return root;
}
function writeEvents(root, runId, events, append) {
  const dir = path.join(root, '.claude', 'forge-runs', runId);
  fs.mkdirSync(dir, { recursive: true });
  const text = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  const file = path.join(dir, 'events.jsonl');
  if (append) fs.appendFileSync(file, text); else fs.writeFileSync(file, text);
  return file;
}
function runCLI(args) {
  return spawnSync(process.execPath, [TOOL].concat(args), { encoding: 'utf8' });
}

console.log('forge-tool-index tests (cross-run event search index + rejected_approach registration)');
console.log('  node:sqlite+FTS5 really available in this test process: ' + sqliteReallyAvailable);

// =======================================================================================================
console.log('\n1) toIndexRecord() — the pure record builder (7 contract fields + 3 derived extras)');
// =======================================================================================================

t('builds exactly the 7 contract fields plus line_no/event_uid/summary_fields, with a POSIX root-relative ref_path', () => {
  const rec = idx.toIndexRecord(
    { event_type: 'check_failed', timestamp: '2026-07-30T10:00:00.000Z', agent: 'build-boss', tool: 'npm', note: 'tests failed' },
    { runId: 'run-a', lineNo: 4, root: 'C:\\anything' }
  );
  assert.ok(rec, 'expected a record, got ' + rec);
  assert.strictEqual(rec.ref_path, '.claude/forge-runs/run-a/events.jsonl#L4');
  assert.strictEqual(rec.line_no, 4);
  assert.strictEqual(rec.ts, '2026-07-30T10:00:00.000Z');
  assert.strictEqual(rec.run_id, 'run-a');
  assert.strictEqual(rec.agent, 'build-boss');
  assert.strictEqual(rec.event_type, 'check_failed');
  assert.strictEqual(rec.tool, 'npm');
  assert.strictEqual(rec.event_uid, 'run-a:4', 'without entry_hash the uid must be <run_id>:<line_no>');
  assert.deepStrictEqual(Object.keys(rec).sort(), ['agent', 'event_type', 'event_uid', 'line_no', 'ref_path', 'run_id', 'summary', 'summary_fields', 'tool', 'ts'].sort());
});

t('event_uid prefers a real entry_hash when the source event carries one', () => {
  const rec = idx.toIndexRecord({ event_type: 'agent_progress', entry_hash: 'abc123', note: 'x' }, { runId: 'run-a', lineNo: 9 });
  assert.strictEqual(rec.event_uid, 'abc123');
});

t('summary is assembled in SUMMARY_FIELDS order and names its own source fields', () => {
  const rec = idx.toIndexRecord(
    { event_type: 'agent_progress', evidence: 'EVIDENCETEXT', task: 'TASKTEXT', note: 'NOTETEXT' },
    { runId: 'run-a', lineNo: 1 }
  );
  assert.strictEqual(rec.summary, 'TASKTEXT · NOTETEXT · EVIDENCETEXT', 'got: ' + rec.summary);
  assert.deepStrictEqual(rec.summary_fields, ['task', 'note', 'evidence']);
});

t('summary is truncated at SUMMARY_MAX_CHARS with an ellipsis marker', () => {
  assert.strictEqual(idx.SUMMARY_MAX_CHARS, 400);
  const long = 'x'.repeat(1000);
  const rec = idx.toIndexRecord({ event_type: 'agent_output', output: long }, { runId: 'r', lineNo: 1 });
  assert.ok(rec.summary.length <= idx.SUMMARY_MAX_CHARS + 1, 'summary length ' + rec.summary.length);
  assert.ok(rec.summary.endsWith('…'), 'expected a truncation marker, got tail: ' + JSON.stringify(rec.summary.slice(-5)));
});

t('no fabrication: an event with no text fields yields summary===event_type, summary_fields===[], tool===null', () => {
  const rec = idx.toIndexRecord({ event_type: 'agent_progress' }, { runId: 'run-a', lineNo: 2 });
  assert.strictEqual(rec.summary, 'agent_progress');
  assert.deepStrictEqual(rec.summary_fields, []);
  assert.strictEqual(rec.tool, null, 'tool must be exactly null (not undefined, not "") when nothing real is known');
  assert.strictEqual(rec.agent, null);
  assert.strictEqual(rec.ts, null, 'ts must stay null — never filled with "now"');
});

t('tool falls back skill -> first token of command, never a guess', () => {
  assert.strictEqual(idx.toIndexRecord({ event_type: 'skill_loaded', skill: 'forge-router' }, { runId: 'r', lineNo: 1 }).tool, 'forge-router');
  assert.strictEqual(idx.toIndexRecord({ event_type: 'command_run', command: 'npm run build -- --x' }, { runId: 'r', lineNo: 1 }).tool, 'npm');
});

t('returns null for a non-object and for an event without event_type', () => {
  assert.strictEqual(idx.toIndexRecord(null, { runId: 'r', lineNo: 1 }), null);
  assert.strictEqual(idx.toIndexRecord('a string', { runId: 'r', lineNo: 1 }), null);
  assert.strictEqual(idx.toIndexRecord({ note: 'no type here' }, { runId: 'r', lineNo: 1 }), null);
});

// =======================================================================================================
console.log('\n2) ingest() — derived artifacts, idempotency, incrementality, self-heal');
// =======================================================================================================

t('writes both derived artifacts and is idempotent (a second ingest adds 0)', () => {
  const root = freshRoot('ti-ingest');
  writeEvents(root, 'run-a', [
    { event_type: 'run_started', timestamp: '2026-07-30T10:00:00.000Z', note: 'alpha' },
    { event_type: 'agent_progress', timestamp: '2026-07-30T10:01:00.000Z', note: 'beta' },
  ]);
  const r1 = idx.ingest({ root });
  assert.strictEqual(r1.ok, true, 'ingest not ok: ' + JSON.stringify(r1.reason || r1));
  assert.strictEqual(r1.added, 2, 'expected 2 added, got ' + r1.added);
  const p = idx.indexPaths(root);
  assert.ok(fs.existsSync(p.jsonlPath), 'tool-index.jsonl was not written');
  assert.ok(fs.existsSync(p.statePath), 'state.json was not written');
  const before = idx.stats({ root }).records;
  const r2 = idx.ingest({ root });
  assert.strictEqual(r2.added, 0, 're-ingest must add nothing, got ' + r2.added);
  assert.strictEqual(idx.stats({ root }).records, before, 'record count changed on a no-op re-ingest');
});

t('is genuinely incremental: appending 2 lines scans exactly 2 (not the whole file again)', () => {
  const root = freshRoot('ti-incr');
  writeEvents(root, 'run-a', [
    { event_type: 'run_started', timestamp: '2026-07-30T10:00:00.000Z', note: 'one' },
    { event_type: 'agent_progress', timestamp: '2026-07-30T10:01:00.000Z', note: 'two' },
    { event_type: 'agent_progress', timestamp: '2026-07-30T10:02:00.000Z', note: 'three' },
  ]);
  idx.ingest({ root });
  writeEvents(root, 'run-a', [
    { event_type: 'agent_progress', timestamp: '2026-07-30T10:03:00.000Z', note: 'four' },
    { event_type: 'run_completed', timestamp: '2026-07-30T10:04:00.000Z', note: 'five' },
  ], true);
  const r = idx.ingest({ root });
  assert.strictEqual(r.added, 2, 'expected 2 added, got ' + r.added);
  assert.strictEqual(r.runs.length, 1);
  assert.strictEqual(r.runs[0].scanned, 2, 'expected to SCAN only the 2 new lines (offset resume), scanned=' + r.runs[0].scanned);
  assert.strictEqual(r.runs[0].rebuilt, false);
  assert.strictEqual(idx.stats({ root }).records, 5);
});

t('self-heals when events.jsonl was truncated/rewritten (stored offset no longer valid)', () => {
  const root = freshRoot('ti-heal');
  writeEvents(root, 'run-a', [
    { event_type: 'run_started', timestamp: '2026-07-30T10:00:00.000Z', note: 'one' },
    { event_type: 'agent_progress', timestamp: '2026-07-30T10:01:00.000Z', note: 'two' },
    { event_type: 'agent_progress', timestamp: '2026-07-30T10:02:00.000Z', note: 'three' },
    { event_type: 'run_completed', timestamp: '2026-07-30T10:03:00.000Z', note: 'four' },
  ]);
  idx.ingest({ root });
  assert.strictEqual(idx.stats({ root }).records, 4);
  // rewrite SHORTER with different content — the stored byte offset is now meaningless
  writeEvents(root, 'run-a', [
    { event_type: 'run_started', timestamp: '2026-07-31T10:00:00.000Z', note: 'rewritten-one' },
    { event_type: 'run_completed', timestamp: '2026-07-31T10:01:00.000Z', note: 'rewritten-two' },
  ]);
  const r = idx.ingest({ root });
  assert.strictEqual(r.runs[0].rebuilt, true, 'expected rebuilt:true for the invalidated run');
  assert.ok(r.runs[0].reason && r.runs[0].reason.length > 0, 'a rebuild must state its real reason');
  const s = idx.stats({ root });
  assert.strictEqual(s.records, 2, 'index must reflect the NEW file only (not old+new), got ' + s.records);
  assert.strictEqual(s.mismatch, false);
});

t('ingest ignores non-directory entries and run dirs without events.jsonl', () => {
  const root = freshRoot('ti-skipjunk');
  fs.writeFileSync(path.join(root, '.claude', 'forge-runs', 'README.md'), '# not a run\n');
  fs.mkdirSync(path.join(root, '.claude', 'forge-runs', 'empty-run'), { recursive: true });
  writeEvents(root, 'run-a', [{ event_type: 'run_started', timestamp: '2026-07-30T10:00:00.000Z', note: 'only real run' }]);
  const r = idx.ingest({ root });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.runs.length, 1, 'only the one real run may be ingested, got ' + JSON.stringify(r.runs.map((x) => x.run_id)));
  assert.strictEqual(r.runs[0].run_id, 'run-a');
});

// =======================================================================================================
console.log('\n3) search() — ranking, filters, hostile queries (BOTH backends really executed)');
// =======================================================================================================

const BACKENDS = sqliteReallyAvailable ? ['sqlite', 'jsonl'] : ['jsonl'];
if (!sqliteReallyAvailable) console.log('  NOTE: node:sqlite/FTS5 unavailable here — the sqlite backend pass is honestly skipped, not faked.');

for (const backend of BACKENDS) {
  t('[' + backend + '] ranks a better match above a weaker one, descending by score', () => {
    const root = freshRoot('ti-rank-' + backend);
    writeEvents(root, 'run-a', [
      // The STRONGER match is deliberately the OLDER record: compareHits() breaks score ties on ts DESC,
      // so if the scorer ever degrades to a constant the tiebreak would surface the weaker-but-newer row
      // first and this assertion fails. With the timestamps the other way round the tiebreak silently
      // rescued a broken scorer (found by the verifier's sabotage pass, 2026-08-01).
      { event_type: 'agent_progress', timestamp: '2026-07-30T10:01:00.000Z', note: 'we tried a websocket bridge and it worked' },
      { event_type: 'agent_progress', timestamp: '2026-07-30T10:00:00.000Z', note: 'the websocket transport plus the polling bridge both matter here websocket bridge' },
      { event_type: 'agent_progress', timestamp: '2026-07-30T10:02:00.000Z', note: 'totally unrelated text about pancakes' },
    ]);
    const ing = idx.ingest({ root, backend });
    assert.strictEqual(ing.ok, true);
    const r = idx.search('websocket bridge', { root, backend });
    assert.strictEqual(r.ok, true, 'search not ok: ' + r.reason);
    assert.ok(r.total >= 2, 'expected >=2 hits, got ' + r.total);
    assert.ok(r.hits[0].summary.includes('polling bridge'), 'the record containing BOTH query terms most strongly must rank first; got: ' + r.hits[0].summary);
    for (const h of r.hits) assert.ok(Number.isFinite(h.score), 'score must be a finite number, got ' + h.score);
    for (let i = 1; i < r.hits.length; i++) assert.ok(r.hits[i - 1].score >= r.hits[i].score, 'hits are not sorted by descending score');
    assert.ok(!r.hits.some((h) => h.summary.includes('pancakes')), 'a record with 0 matching terms must not be returned');
  });

  t('[' + backend + '] survives an FTS5-hostile query without throwing', () => {
    const root = freshRoot('ti-hostile-' + backend);
    writeEvents(root, 'run-a', [{ event_type: 'agent_progress', timestamp: '2026-07-30T10:00:00.000Z', note: 'we tried the quoted approach' }]);
    idx.ingest({ root, backend });
    for (const q of ['tried AND (', '"quoted"', '*', 'NEAR/', 'tried OR OR', '^ ~ :']) {
      const r = idx.search(q, { root, backend });
      assert.strictEqual(r.ok, true, 'query ' + JSON.stringify(q) + ' did not resolve ok: ' + r.reason);
      assert.ok(Array.isArray(r.hits), 'hits must be an array for query ' + JSON.stringify(q));
    }
    const r2 = idx.search('tried AND (', { root, backend });
    assert.strictEqual(r2.total, 1, 'the escaped terms should still find the one real record, got ' + r2.total);
  });

  t('[' + backend + '] applies the structured filters (run_id / agent / event_type / since / until / limit) for real', () => {
    const root = freshRoot('ti-filters-' + backend);
    writeEvents(root, 'run-a', [{ event_type: 'agent_progress', timestamp: '2026-07-30T10:00:00.000Z', agent: 'build-boss', note: 'shared keyword marker' }]);
    writeEvents(root, 'run-b', [{ event_type: 'check_failed', timestamp: '2026-07-31T10:00:00.000Z', agent: 'test-boss', note: 'shared keyword marker' }]);
    writeEvents(root, 'run-c', [{ event_type: 'agent_progress', timestamp: '2026-07-29T10:00:00.000Z', agent: 'build-boss', note: 'shared keyword marker' }]);
    idx.ingest({ root, backend });
    const o = (extra) => Object.assign({ root, backend }, extra);
    assert.strictEqual(idx.search('shared keyword marker', o()).total, 3, 'unfiltered baseline must see all 3');
    const byRun = idx.search('shared keyword marker', o({ runId: 'run-b' }));
    assert.strictEqual(byRun.total, 1, 'runId filter, got ' + byRun.total);
    assert.strictEqual(byRun.hits[0].run_id, 'run-b');
    assert.strictEqual(idx.search('shared keyword marker', o({ agent: 'test-boss' })).total, 1, 'agent filter');
    assert.strictEqual(idx.search('shared keyword marker', o({ eventType: 'check_failed' })).total, 1, 'eventType filter');
    assert.strictEqual(idx.search('shared keyword marker', o({ since: '2026-07-30T00:00:00.000Z' })).total, 2, 'since filter');
    assert.strictEqual(idx.search('shared keyword marker', o({ until: '2026-07-29T23:59:59.000Z' })).total, 1, 'until filter');
    assert.strictEqual(idx.search('shared keyword marker', o({ limit: 2 })).hits.length, 2, 'limit must cap the hit list');
    assert.strictEqual(idx.search('shared keyword marker', o({ limit: 2 })).total, 3, 'total must report the real match count, not the capped page');
  });
}

t('helpers behave: tokenize/buildMatchExpr/scoreKeyword are real, deterministic functions', () => {
  assert.deepStrictEqual(idx.tokenize('Tried AND (a websocket-bridge!'), ['tried', 'and', 'a', 'websocket', 'bridge']);
  assert.strictEqual(idx.buildMatchExpr('tried AND ('), '"tried" OR "and"');
  assert.strictEqual(idx.buildMatchExpr('*'), '', 'a query with no real tokens must produce an empty (never raw) match expression');
  assert.ok(idx.scoreKeyword(['websocket', 'bridge'], 'websocket bridge websocket') > idx.scoreKeyword(['websocket', 'bridge'], 'websocket only'));
  assert.strictEqual(idx.scoreKeyword(['nothing'], 'unrelated text'), 0);
});

// =======================================================================================================
console.log('\n4) wasRejected() — the "did we already try this?" question');
// =======================================================================================================

t('returns ONLY rejected_approach records, and says tried:false honestly when there is no such record', () => {
  const root = freshRoot('ti-rejected');
  writeEvents(root, 'run-a', [
    // deliberately identical wording on a NON-rejected event — a missing filter is instantly visible
    { event_type: 'check_passed', timestamp: '2026-07-30T10:00:00.000Z', evidence: 'switching to inline sqlite caching', command: 'node x.js' },
    { event_type: 'rejected_approach', timestamp: '2026-07-30T10:01:00.000Z', agent: 'build-boss', approach: 'switching to inline sqlite caching', reason: 'locks the db for parallel runs', evidence: 'deadlock repro in run-a' },
    { event_type: 'agent_progress', timestamp: '2026-07-30T10:02:00.000Z', note: 'a wholly different subject: pancakes' },
  ]);
  idx.ingest({ root });
  const r = idx.wasRejected('inline sqlite caching', { root });
  assert.strictEqual(r.tried, true, 'the rejected_approach record should have been found');
  assert.ok(r.total >= 1);
  assert.ok(r.hits.every((h) => h.event_type === idx.REJECTED_EVENT_TYPE), 'non-rejected event types leaked into the result: ' + r.hits.map((h) => h.event_type).join(','));
  const none = idx.wasRejected('pancakes', { root });
  assert.strictEqual(none.tried, false, 'must not claim "already tried" for a query with no rejected_approach hit');
  assert.strictEqual(none.hits.length, 0);
  assert.strictEqual(none.stale, false, 'a freshly ingested index is not stale');
});

t('search({rejectedOnly}) / search({excludeRejected}) are exact complements', () => {
  const root = freshRoot('ti-rejfilter');
  writeEvents(root, 'run-a', [
    { event_type: 'check_passed', timestamp: '2026-07-30T10:00:00.000Z', evidence: 'marker phrase here', command: 'x' },
    { event_type: 'rejected_approach', timestamp: '2026-07-30T10:01:00.000Z', approach: 'marker phrase here', reason: 'no', evidence: 'proof' },
  ]);
  idx.ingest({ root });
  assert.strictEqual(idx.search('marker phrase here', { root }).total, 2);
  assert.strictEqual(idx.search('marker phrase here', { root, rejectedOnly: true }).total, 1);
  assert.strictEqual(idx.search('marker phrase here', { root, excludeRejected: true }).total, 1);
  assert.strictEqual(idx.search('marker phrase here', { root, rejectedOnly: true }).hits[0].event_type, 'rejected_approach');
  assert.strictEqual(idx.search('marker phrase here', { root, excludeRejected: true }).hits[0].event_type, 'check_passed');
});

t('staleness is reported honestly when events.jsonl moved on after the last ingest', () => {
  const root = freshRoot('ti-stale');
  writeEvents(root, 'run-a', [{ event_type: 'rejected_approach', timestamp: '2026-07-30T10:00:00.000Z', approach: 'alpha route', reason: 'slow', evidence: 'bench' }]);
  idx.ingest({ root });
  assert.strictEqual(idx.wasRejected('alpha route', { root }).stale, false);
  // deliberately shares NO token with the already-indexed record — otherwise an honest partial-term hit
  // (the query is an OR over its terms) would mask what this test is actually about
  writeEvents(root, 'run-a', [{ event_type: 'rejected_approach', timestamp: '2026-07-30T10:05:00.000Z', approach: 'gamma tunnel', reason: 'slow', evidence: 'bench' }], true);
  const after = idx.wasRejected('gamma tunnel', { root });
  assert.strictEqual(after.tried, false, 'not yet ingested, so it is honestly not found...');
  assert.strictEqual(after.stale, true, '...but the caller MUST be told the index is stale so "not found" != "never tried"');
  assert.ok(idx.stats({ root }).stale.includes('run-a'));
});

// =======================================================================================================
console.log('\n5) resolve() — the mechanical way back to the full original blob');
// =======================================================================================================

const LONG_NOTE = 'ROOTCAUSE ' + 'detail-'.repeat(90) + ' END-OF-ORIGINAL';

t('resolves a ref_path back to the FULL original event, which is deliberately NOT stored in the index', () => {
  const root = freshRoot('ti-resolve');
  writeEvents(root, 'run-a', [
    { event_type: 'agent_progress', timestamp: '2026-07-30T10:00:00.000Z', note: 'first line filler' },
    { event_type: 'rejected_approach', timestamp: '2026-07-30T10:01:00.000Z', approach: 'blobsplit route', reason: 'x', note: LONG_NOTE, evidence: 'e' },
  ]);
  idx.ingest({ root });
  const hit = idx.search('blobsplit route', { root }).hits[0];
  assert.ok(hit, 'fixture record was not found by search');
  assert.strictEqual(hit.ref_path, '.claude/forge-runs/run-a/events.jsonl#L2');
  assert.ok(!hit.summary.includes('END-OF-ORIGINAL'), 'the full blob must NOT be copied into the index summary');
  const res = idx.resolve(hit.ref_path, { root });
  assert.strictEqual(res.ok, true, 'resolve failed: ' + res.reason);
  assert.strictEqual(res.line_no, 2);
  assert.strictEqual(res.event.note, LONG_NOTE, 'resolve must return the exact original text, not a reconstruction');
  assert.strictEqual(res.event.event_type, 'rejected_approach');
  const res2 = idx.resolve(hit, { root });
  assert.strictEqual(res2.ok, true, 'resolve must also accept a whole IndexRecord: ' + res2.reason);
  assert.strictEqual(res2.event.note, LONG_NOTE);
});

t('refuses honestly when the source line changed or vanished — never a reconstructed event', () => {
  const root = freshRoot('ti-resolve-drift');
  writeEvents(root, 'run-a', [
    { event_type: 'agent_progress', timestamp: '2026-07-30T10:00:00.000Z', note: 'driftmarker one' },
    { event_type: 'agent_progress', timestamp: '2026-07-30T10:01:00.000Z', note: 'driftmarker two' },
    { event_type: 'rejected_approach', timestamp: '2026-07-30T10:02:00.000Z', approach: 'driftmarker three', reason: 'x', evidence: 'e' },
  ]);
  idx.ingest({ root });
  const hit = idx.search('driftmarker three', { root }).hits[0];
  assert.ok(hit);
  // rewrite the source SHORTER without re-ingesting: the old ref now points past the end
  writeEvents(root, 'run-a', [{ event_type: 'agent_progress', timestamp: '2026-07-31T09:00:00.000Z', note: 'only line now' }]);
  const res = idx.resolve(hit.ref_path, { root });
  assert.strictEqual(res.ok, false, 'a vanished line must not resolve ok');
  assert.strictEqual(res.event, null, 'a failed resolve must return event:null, never a guess');
  assert.ok(res.reason && res.reason.length > 0, 'a refusal must state a real reason');
});

t('rejects an unparsable / out-of-project ref_path instead of reading outside the root', () => {
  const root = freshRoot('ti-resolve-escape');
  const bad = idx.resolve('.claude/forge-runs/../../../etc/passwd#L1', { root });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.event, null);
  const bad2 = idx.resolve('not-a-ref-at-all', { root });
  assert.strictEqual(bad2.ok, false);
});

// =======================================================================================================
console.log('\n5b) backend honesty, project isolation, stats');
// =======================================================================================================

t('backendInfo() matches what this test process can itself verify about node:sqlite', () => {
  const info = idx.backendInfo();
  assert.strictEqual(info.sqliteAvailable, sqliteReallyAvailable, 'backendInfo lies about node:sqlite availability');
  assert.ok(['sqlite-fts5', 'jsonl-keyword'].includes(info.backend), 'unexpected backend literal: ' + info.backend);
  if (!info.sqliteAvailable) assert.ok(info.reason && info.reason.length > 0, 'a degraded backend must carry the real reason');
});

t('a forced backend is reported exactly, in both ingest and search results', () => {
  for (const forced of BACKENDS) {
    const expect = forced === 'sqlite' ? 'sqlite-fts5' : 'jsonl-keyword';
    const root = freshRoot('ti-backend-' + forced);
    writeEvents(root, 'run-a', [{ event_type: 'agent_progress', timestamp: '2026-07-30T10:00:00.000Z', note: 'backendmarker' }]);
    const ing = idx.ingest({ root, backend: forced });
    assert.strictEqual(ing.backend, expect, 'ingest backend for ' + forced);
    const s = idx.search('backendmarker', { root, backend: forced });
    assert.strictEqual(s.backend, expect, 'search backend for ' + forced);
    assert.strictEqual(s.total, 1);
  }
});

t('project isolation: a traversing run id is refused and indexPaths stays under the root', () => {
  const root = freshRoot('ti-isolation');
  const p = idx.indexPaths(root);
  assert.ok(p.dbPath.startsWith(path.resolve(root)), 'dbPath escaped the root: ' + p.dbPath);
  assert.ok(p.jsonlPath.startsWith(path.resolve(root)));
  assert.ok(p.statePath.startsWith(path.resolve(root)));
  assert.strictEqual(p.dir, path.join(path.resolve(root), '.claude', 'forge-index'));
  let refused = false;
  try {
    const r = idx.ingest({ root, runId: '../../escape' });
    refused = r && r.ok === false && !!r.reason;
  } catch { refused = true; }
  assert.ok(refused, 'a traversing runId must throw or return {ok:false, reason}');
  let refused2 = false;
  try {
    const r = idx.search('x', { root, runId: '../../escape' });
    refused2 = r && r.ok === false && !!r.reason;
  } catch { refused2 = true; }
  assert.ok(refused2, 'search must refuse a traversing runId too');
});

t('stats() counts per run and per event_type, and never silently picks the prettier number', () => {
  const root = freshRoot('ti-stats');
  writeEvents(root, 'run-a', [
    { event_type: 'run_started', timestamp: '2026-07-30T10:00:00.000Z', note: 'a' },
    { event_type: 'agent_progress', timestamp: '2026-07-30T10:01:00.000Z', note: 'b' },
  ]);
  writeEvents(root, 'run-b', [{ event_type: 'run_started', timestamp: '2026-07-30T11:00:00.000Z', note: 'c' }]);
  const ing = idx.ingest({ root });
  const s = idx.stats({ root });
  assert.strictEqual(s.records, ing.total, 'stats records must agree with ingest total');
  assert.strictEqual(s.records, 3);
  assert.strictEqual(s.byRunId['run-a'], 2);
  assert.strictEqual(s.byRunId['run-b'], 1);
  assert.strictEqual(s.byEventType['run_started'], 2);
  assert.strictEqual(s.mismatch, false, 'sqlite and jsonl counts disagree: db=' + s.dbRecords + ' jsonl=' + s.jsonlRecords);
  assert.strictEqual(s.newestTs, '2026-07-30T11:00:00.000Z');
  assert.strictEqual(s.schemaVersion, idx.SCHEMA_VERSION);
});

t('rebuild() removes only the derived files and reproduces the same record count; events.jsonl untouched', () => {
  const root = freshRoot('ti-rebuild');
  const eventsFile = writeEvents(root, 'run-a', [
    { event_type: 'run_started', timestamp: '2026-07-30T10:00:00.000Z', note: 'a' },
    { event_type: 'agent_progress', timestamp: '2026-07-30T10:01:00.000Z', note: 'b' },
  ]);
  const srcBefore = fs.readFileSync(eventsFile, 'utf8');
  const before = idx.ingest({ root }).total;
  const rb = idx.rebuild({ root });
  assert.ok(Array.isArray(rb.removed) && rb.removed.length > 0, 'rebuild must report which derived files it removed');
  assert.strictEqual(rb.total, before, 'rebuild must reproduce the same record count');
  assert.strictEqual(fs.readFileSync(eventsFile, 'utf8'), srcBefore, 'events.jsonl is the single source of truth and must never be touched');
});

// =======================================================================================================
console.log('\n5c) CLI contract (real spawned subprocesses)');
// =======================================================================================================

t('CLI `ingest --json --root <tmp>` exits 0 with parseable JSON', () => {
  const root = freshRoot('ti-cli-ingest');
  writeEvents(root, 'run-a', [{ event_type: 'run_started', timestamp: '2026-07-30T10:00:00.000Z', note: 'cli marker' }]);
  const r = runCLI(['ingest', '--root', root, '--json']);
  assert.strictEqual(r.status, 0, 'exit ' + r.status + ' stderr: ' + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.added, 1);
});

t('CLI exit codes: search 0 on >=1 hit, 3 on 0 hits, 2 on a missing query', () => {
  const root = freshRoot('ti-cli-exit');
  writeEvents(root, 'run-a', [{ event_type: 'agent_progress', timestamp: '2026-07-30T10:00:00.000Z', note: 'exitcodemarker present' }]);
  runCLI(['ingest', '--root', root, '--json']);
  assert.strictEqual(runCLI(['search', 'exitcodemarker', '--root', root, '--json']).status, 0, 'a real hit must exit 0');
  assert.strictEqual(runCLI(['search', 'nothinglikethisatall', '--root', root, '--json']).status, 3, 'no hits must exit 3 (its own code)');
  assert.strictEqual(runCLI(['search', '--root', root, '--json']).status, 2, 'a missing query is a usage error (2)');
  assert.strictEqual(runCLI(['bogus-command', '--root', root]).status, 2, 'an unknown command is a usage error (2)');
});

t('CLI `tried` inverts deliberately: exit 0 means "yes, already tried"', () => {
  const root = freshRoot('ti-cli-tried');
  writeEvents(root, 'run-a', [
    { event_type: 'rejected_approach', timestamp: '2026-07-30T10:00:00.000Z', approach: 'clitried polling loop', reason: 'burns cpu', evidence: 'profiler' },
  ]);
  runCLI(['ingest', '--root', root, '--json']);
  const yes = runCLI(['tried', 'clitried polling loop', '--root', root, '--json']);
  assert.strictEqual(yes.status, 0, 'exit ' + yes.status + ' stderr: ' + yes.stderr);
  assert.strictEqual(JSON.parse(yes.stdout).tried, true);
  const no = runCLI(['tried', 'somethingneverattempted', '--root', root, '--json']);
  assert.strictEqual(no.status, 3);
  assert.strictEqual(JSON.parse(no.stdout).tried, false);
  assert.strictEqual(runCLI(['tried', '--root', root, '--json']).status, 2);
});

t('CLI `stats --json` counts the same as ingest itself (records === ingest.total, mismatch false)', () => {
  const root = freshRoot('ti-cli-stats');
  writeEvents(root, 'run-a', [
    { event_type: 'run_started', timestamp: '2026-07-30T10:00:00.000Z', note: 'a' },
    { event_type: 'agent_progress', timestamp: '2026-07-30T10:01:00.000Z', note: 'b' },
  ]);
  const ing = JSON.parse(runCLI(['ingest', '--root', root, '--json']).stdout);
  const st = runCLI(['stats', '--root', root, '--json']);
  assert.strictEqual(st.status, 0, 'stderr: ' + st.stderr);
  const s = JSON.parse(st.stdout);
  assert.strictEqual(s.records, ing.total);
  assert.strictEqual(s.mismatch, false);
});

t('CLI `resolve` returns the full original event and reports plain-text output without --json', () => {
  const root = freshRoot('ti-cli-resolve');
  writeEvents(root, 'run-a', [{ event_type: 'agent_progress', timestamp: '2026-07-30T10:00:00.000Z', note: 'cliresolvemarker ' + LONG_NOTE }]);
  runCLI(['ingest', '--root', root, '--json']);
  const r = runCLI(['resolve', '.claude/forge-runs/run-a/events.jsonl#L1', '--root', root, '--json']);
  assert.strictEqual(r.status, 0, 'stderr: ' + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.ok, true);
  assert.ok(out.event.note.includes('END-OF-ORIGINAL'), 'the CLI must hand back the complete original blob');
  const plain = runCLI(['search', 'cliresolvemarker', '--root', root]);
  assert.strictEqual(plain.status, 0);
  assert.ok(/run-a/.test(plain.stdout) && /events\.jsonl#L1/.test(plain.stdout), 'plain output must name the run and the ref_path; got: ' + plain.stdout);
});

// =======================================================================================================
console.log('\n6) rejected_approach registration — the 3-places discipline (REAL tools, real sources)');
// =======================================================================================================
// Section 6 uses the REAL .claude/forge-runs/ (log-event.cjs resolves CLAUDE_DIR from its own __dirname and
// cannot be redirected). The throwaway run dir is removed in the finally below.
const RUN_ID = 'tool-index-selftest-' + process.pid;
const RUN_DIR = path.join(REAL_ROOT, '.claude', 'forge-runs', RUN_ID);
try {
  console.log('\n  PLACE 1 — log-event.cjs (KNOWN_EVENT_TYPES + PROOF_EVENTS)');
  t('the REAL log-event.cjs CLI ACCEPTS a rejected_approach carrying proof (exit 0) and the line lands in events.jsonl', () => {
    const payload = JSON.stringify({
      agent: 'build-boss',
      approach: 'selftest: exclusive db lock around the index',
      reason: 'selftest: deadlocks two parallel runs',
      evidence: 'selftest: repro logged in this very run',
    });
    const r = spawnSync(process.execPath, [LOG_EVENT, RUN_ID, 'rejected_approach', payload], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, 'exit ' + r.status + ' — stderr: ' + (r.stderr || '').trim());
    const lines = fs.readFileSync(path.join(RUN_DIR, 'events.jsonl'), 'utf8').trim().split(/\r?\n/);
    const ev = JSON.parse(lines[lines.length - 1]);
    assert.strictEqual(ev.event_type, 'rejected_approach');
    assert.strictEqual(ev.reason, 'selftest: deadlocks two parallel runs');
    assert.notStrictEqual(ev._forge_verify && ev._forge_verify.event_type_unknown, true, 'the type must not be stamped unknown');
    assert.strictEqual(ev._forge_verify.proof_verified, true, 'a rejected_approach with evidence must be stamped proof_verified:true');
  });

  t('a rejected_approach WITHOUT a proof field is refused for the PROOF reason, not the unknown-type reason', () => {
    const payload = JSON.stringify({ agent: 'build-boss', approach: 'selftest: unproven claim', reason: 'selftest: because I said so' });
    const r = spawnSync(process.execPath, [LOG_EVENT, RUN_ID, 'rejected_approach', payload], { encoding: 'utf8' });
    const err = (r.stderr || '').trim();
    assert.strictEqual(r.status, 2, 'expected STRICT refusal exit 2, got ' + r.status + ' — stderr: ' + err);
    assert.ok(/no proof field/.test(err), 'refusal must cite the missing proof, got: ' + err);
    assert.ok(!/unknown event_type/.test(err), 'refusal must NOT be the unknown-type reason (that would mean the type is still unregistered), got: ' + err);
  });

  t('REGRESSION GUARD (green before AND after — proves nothing about the feature): a made-up event_type stays STRICT-refused', () => {
    const r = spawnSync(process.execPath, [LOG_EVENT, RUN_ID, 'zzz_totally_invented_type', '{"agent":"build-boss","note":"x"}'], { encoding: 'utf8' });
    assert.strictEqual(r.status, 2);
    assert.ok(/unknown event_type/.test(r.stderr || ''), 'the honesty gate must still reject invented types');
  });

  console.log('\n  PLACE 2 — forge-verify.cjs classification');
  const verify = require('./forge-verify.cjs');
  t('forge-verify classifies rejected_approach as terminal/done', () => {
    assert.ok(verify.TERMINAL_TYPES.has('rejected_approach'), 'not in TERMINAL_TYPES');
    assert.strictEqual(verify.taskStatus({ event_type: 'rejected_approach' }), 'done');
  });
  t('forge-verify does NOT put rejected_approach in any other bucket (a lazy add-everywhere edit fails here)', () => {
    assert.ok(!verify.FAILED_TYPES.has('rejected_approach'), 'must not be a failure — honest logging is not a defect');
    assert.ok(!verify.BACKBONE.has('rejected_approach'), 'must not be a run-level backbone milestone');
    assert.ok(!verify.RUNNING_TYPES.has('rejected_approach'), 'must not be a running task');
    assert.ok(!verify.PREVIEWING_TYPES.has('rejected_approach'), 'must not be previewing');
    assert.ok(!verify.FINDING_EVENT_TYPES.has('rejected_approach'), 'must not count as a recurring finding in loop convergence');
  });

  console.log('\n  PLACE 3 — forge-dashboard/app.js (static source proof; browser JS, no module boundary)');
  const appSrc = fs.readFileSync(path.join(REAL_ROOT, '.claude', 'forge-dashboard', 'app.js'), 'utf8');
  t('app.js taskStatus() informational done-list contains the rejected_approach literal', () => {
    const m = appSrc.match(/informational\/activity events that represent an action that already happened[\s\S]{0,1600}?return 'done';/);
    assert.ok(m, 'could not locate the informational done-list in app.js');
    assert.ok(/'rejected_approach'/.test(m[0]), 'rejected_approach is not in the informational done-list');
  });
  t('app.js SYNTH fallback map has an entry for rejected_approach', () => {
    assert.ok(/rejected_approach:\s*'[a-z-]+'/.test(appSrc), 'rejected_approach not found in the SYNTH fallback map');
  });

  console.log('\n  CROSS-CHECK — the KNOWN_EVENT_TYPES source really carries the literal');
  // NOTE, reported honestly rather than patched here: forge-doctor.cjs::extractKnownEventTypesFromSource()
  // cannot currently be used as this cross-check. Its literal scanner (/'([^']+)'|"([^"]+)"/g) runs over the
  // RAW Set body including // comment lines, so an apostrophe in comment prose (required-evidence.json's,
  // check_started's, AUDIT-LOOP tool's) is read as a string delimiter and flips quote parity for the rest of
  // the list. Measured at HEAD, BEFORE any edit in this work package: 182 event types are really registered,
  // the extractor sees 171, silently MISSES 19 real ones (e2e_passed, robots_checked, audit_iteration,
  // audit_finding, review_started, … ) and invents 8 junk "types" out of comment prose. That is a
  // pre-existing defect in the doctor's ENFORCED unregistered_event gate, it predates this work package, and
  // its fix belongs in forge-doctor.cjs (strip comment lines before scanning) as its own work package — not
  // silently here. This test therefore asserts the thing this work package actually controls and that is
  // genuinely true: the literal is registered in the KNOWN_EVENT_TYPES ARRAY ITSELF, not merely in a comment.
  t('log-event.cjs KNOWN_EVENT_TYPES really registers rejected_approach (comment-stripped source read)', () => {
    const src = fs.readFileSync(LOG_EVENT, 'utf8');
    const m = src.match(/KNOWN_EVENT_TYPES\s*=\s*new Set\(\s*\[([\s\S]*?)\]\s*\)/);
    assert.ok(m, 'could not locate the KNOWN_EVENT_TYPES literal in log-event.cjs');
    const codeOnly = m[1].split(/\n/).filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.ok(/'rejected_approach'/.test(codeOnly), 'rejected_approach is not in the KNOWN_EVENT_TYPES array itself (a comment mention would not register it)');
  });

  console.log('\n  INTEGRATION — forge-sync.cjs manifest + .gitignore');
  t('forge-sync SYSTEM manifest pins both new files', () => {
    const syncSrc = fs.readFileSync(path.join(__dirname, 'forge-sync.cjs'), 'utf8');
    const m = syncSrc.match(/\nconst SYSTEM = \[([\s\S]*?)\n\];/);
    assert.ok(m, 'could not locate the SYSTEM manifest literal in forge-sync.cjs');
    const codeOnly = m[1].split(/\n/).filter((l) => !l.trim().startsWith('//')).join('\n');
    // NOTE: the design contract predicted a forge-doctor `system_sync_drift` advisory here. No such check
    // exists in this codebase (the doctor's real check keys are node_check, tests, strict_events,
    // dashboard_spa, leak_scan, agents, chain, rebinding_guard, unregistered_event, check_the_checks).
    // Pinning is still required — it is the template-sync manifest forge-sync.cjs actually distributes, and
    // every prior wave pinned its files there — but no doctor gate enforces it, so this test is the gate.
    assert.ok(codeOnly.includes("'forge-bin/forge-tool-index.cjs'"), 'forge-tool-index.cjs is not pinned in the forge-sync SYSTEM manifest');
    assert.ok(codeOnly.includes("'forge-bin/forge-tool-index.test.cjs'"), 'forge-tool-index.test.cjs is not pinned in the SYSTEM manifest');
  });
  t('.gitignore excludes the derived .claude/forge-index/ directory', () => {
    const gi = fs.readFileSync(path.join(REAL_ROOT, '.gitignore'), 'utf8');
    assert.ok(/^\.claude\/forge-index\/\s*$/m.test(gi), 'a derived copy of local-only event text must never become committable');
  });
} finally {
  try { fs.rmSync(RUN_DIR, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
}

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
