#!/usr/bin/env node
'use strict';
// forge-reinforce.test.cjs — real tests for the outcome-gated lesson utility scorer (WAVE E / E2,
// 2026-07-18). Every fixture (store + runs directory) lives under a fresh os.tmpdir() directory — this
// file NEVER touches this repo's real .claude/agent-memory/ or .claude/forge-runs/.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const reinforce = require('./forge-reinforce.cjs');
const consolidate = require('./forge-consolidate.cjs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

function freshDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); }
function writeStore(file, records) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''), 'utf8'); }
function readStore(file) { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); }

function lesson(overrides) {
  return Object.assign({
    id: 'L' + Math.random().toString(36).slice(2, 8),
    type: 'semantic', tags: [],
    text: 'A real canonical quote from a logged event.',
    evidence: JSON.stringify({ run_id: 'forge-origin-run', ts: '2026-06-01T00:00:00.000Z', event_type: 'check_passed' }),
    ts: '2026-06-01T00:00:00.000Z',
    utility: 0, uses: 0, reinforced_by: [],
  }, overrides || {});
}

// ---- run fixture builders ------------------------------------------------------------------------
// A "good" run: an event with no `agent` field is skipped entirely by forge-verify's verifyRun (never
// counted as an agent task) -> agents:[] -> mismatches:0 -> outcome.ok === true. Trivial, honest fixture.
function writeGoodRun(runsDir, runId, startedAt) {
  const dir = path.join(runsDir, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ run_id: runId, started_at: startedAt }), 'utf8');
  const events = [{ event_type: 'run_started', note: 'no agent field — not attributable to any task', timestamp: startedAt }];
  fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  return dir;
}
// A "bad" run: an agent opens a non-BACKBONE task (check_started) and then claims agent_completed
// without the task ever reaching a done status -> a real, honest mismatch -> outcome.ok === false.
function writeBadRun(runsDir, runId, startedAt) {
  const dir = path.join(runsDir, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ run_id: runId, started_at: startedAt }), 'utf8');
  const t1 = new Date(Date.parse(startedAt) + 1000).toISOString();
  const t2 = new Date(Date.parse(startedAt) + 2000).toISOString();
  const events = [
    { agent: 'Build Boss', event_type: 'check_started', timestamp: t1 },
    { agent: 'Build Boss', event_type: 'agent_completed', timestamp: t2 },
  ];
  fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  return dir;
}

const CLI = path.join(__dirname, 'forge-reinforce.cjs');
function runCLI(argv) { return spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' }); }

console.log('forge-reinforce tests (outcome-gated lesson utility scorer)');

// ---------------------------------------------------------------------------
// 1) basic usage errors
// ---------------------------------------------------------------------------
console.log('\n1) usage errors');

t('opts.store required — throws when omitted', () => {
  assert.throws(() => reinforce.reinforce({ runs: '/tmp/whatever' }));
});
t('opts.runs required — throws when omitted', () => {
  assert.throws(() => reinforce.reinforce({ store: '/tmp/whatever.jsonl' }));
});

// ---------------------------------------------------------------------------
// 2) outcome-gating — good/bad runs actually move utility in the right direction
// ---------------------------------------------------------------------------
console.log('\n2) outcome-gating — real forge-verify.cjs outcomes, not a guess');

t('a lesson reinforced by ONE good run afterward gains utility (+step)', () => {
  const dir = freshDir('reinforce-good');
  const store = path.join(dir, 'lessons.jsonl');
  const runsDir = path.join(dir, 'runs');
  writeStore(store, [lesson({ id: 'L1', ts: '2026-06-01T00:00:00.000Z' })]);
  writeGoodRun(runsDir, 'forge-2026-06-10-good', '2026-06-10T00:00:00.000Z');
  const r = reinforce.reinforce({ store, runs: runsDir });
  assert.strictEqual(r.reinforcedGood, 1);
  assert.strictEqual(r.reinforcedBad, 0);
  assert.strictEqual(readStore(store)[0].utility, 1);
});

t('a lesson reinforced by ONE bad run afterward loses utility (-step)', () => {
  const dir = freshDir('reinforce-bad');
  const store = path.join(dir, 'lessons.jsonl');
  const runsDir = path.join(dir, 'runs');
  writeStore(store, [lesson({ id: 'L1', ts: '2026-06-01T00:00:00.000Z' })]);
  writeBadRun(runsDir, 'forge-2026-06-10-bad', '2026-06-10T00:00:00.000Z');
  const r = reinforce.reinforce({ store, runs: runsDir });
  assert.strictEqual(r.reinforcedBad, 1);
  assert.strictEqual(readStore(store)[0].utility, -1);
});

t('mixed good+bad nets to the expected sum, never fabricated', () => {
  const dir = freshDir('reinforce-mixed');
  const store = path.join(dir, 'lessons.jsonl');
  const runsDir = path.join(dir, 'runs');
  writeStore(store, [lesson({ id: 'L1', ts: '2026-06-01T00:00:00.000Z' })]);
  writeGoodRun(runsDir, 'forge-2026-06-05-good', '2026-06-05T00:00:00.000Z');
  writeBadRun(runsDir, 'forge-2026-06-06-bad', '2026-06-06T00:00:00.000Z');
  const r = reinforce.reinforce({ store, runs: runsDir });
  assert.strictEqual(r.reinforcedGood, 1);
  assert.strictEqual(r.reinforcedBad, 1);
  assert.strictEqual(readStore(store)[0].utility, 0);
});

// ---------------------------------------------------------------------------
// 3) anti-gaming guard 1 — no self-reinforcement
// ---------------------------------------------------------------------------
console.log('\n3) anti-gaming — a lesson can NEVER reinforce itself');

t('a run whose id equals the lesson\'s own evidence.run_id is blocked, even though it is a GOOD outcome', () => {
  const dir = freshDir('reinforce-self');
  const store = path.join(dir, 'lessons.jsonl');
  const runsDir = path.join(dir, 'runs');
  const originRunId = 'forge-2026-06-01-origin';
  writeStore(store, [lesson({ id: 'L1', ts: '2026-05-01T00:00:00.000Z', evidence: JSON.stringify({ run_id: originRunId, ts: '2026-05-01T00:00:00.000Z', event_type: 'check_passed' }) })]);
  writeGoodRun(runsDir, originRunId, '2026-06-01T00:00:00.000Z'); // same run_id the lesson was born from
  const r = reinforce.reinforce({ store, runs: runsDir });
  assert.strictEqual(r.selfBlocked, 1, 'the self-reinforcement guard must fire');
  assert.strictEqual(r.reinforcedGood, 0, 'a self-run must never count as reinforcement, good or bad');
  assert.strictEqual(readStore(store)[0].utility, 0, 'utility must stay untouched by its own origin run');
});

// ---------------------------------------------------------------------------
// 4) anti-gaming guard 2 — precedence (a run must have started AFTER the lesson existed)
// ---------------------------------------------------------------------------
console.log('\n4) anti-gaming — precedence (only runs strictly AFTER the lesson counts)');

t('a run that started BEFORE the lesson\'s own ts is never allowed to reinforce it', () => {
  const dir = freshDir('reinforce-precede');
  const store = path.join(dir, 'lessons.jsonl');
  const runsDir = path.join(dir, 'runs');
  writeStore(store, [lesson({ id: 'L1', ts: '2026-07-01T00:00:00.000Z' })]); // lesson born in July
  writeGoodRun(runsDir, 'forge-2026-06-01-earlier', '2026-06-01T00:00:00.000Z'); // run happened in June — BEFORE the lesson
  const r = reinforce.reinforce({ store, runs: runsDir });
  assert.strictEqual(r.notPreceding, 1);
  assert.strictEqual(r.reinforcedGood, 0);
  assert.strictEqual(readStore(store)[0].utility, 0);
});

t('a run strictly AFTER the lesson\'s ts reinforces normally', () => {
  const dir = freshDir('reinforce-precede-ok');
  const store = path.join(dir, 'lessons.jsonl');
  const runsDir = path.join(dir, 'runs');
  writeStore(store, [lesson({ id: 'L1', ts: '2026-06-01T00:00:00.000Z' })]);
  writeGoodRun(runsDir, 'forge-2026-07-01-later', '2026-07-01T00:00:00.000Z');
  const r = reinforce.reinforce({ store, runs: runsDir });
  assert.strictEqual(r.notPreceding, 0);
  assert.strictEqual(r.reinforcedGood, 1);
});

// ---------------------------------------------------------------------------
// 5) anti-gaming guard 3 — bounded + idempotent
// ---------------------------------------------------------------------------
console.log('\n5) anti-gaming — bounded utility + idempotent re-runs');

t('many good runs clamp utility to UTILITY_MAX, never runs away unbounded', () => {
  const dir = freshDir('reinforce-bound');
  const store = path.join(dir, 'lessons.jsonl');
  const runsDir = path.join(dir, 'runs');
  writeStore(store, [lesson({ id: 'L1', ts: '2026-01-01T00:00:00.000Z' })]);
  for (let i = 0; i < 20; i++) writeGoodRun(runsDir, 'forge-2026-02-' + String(i + 1).padStart(2, '0') + '-good', '2026-02-' + String(i + 1).padStart(2, '0') + 'T00:00:00.000Z');
  const r = reinforce.reinforce({ store, runs: runsDir });
  assert.strictEqual(r.reinforcedGood, 20);
  assert.strictEqual(readStore(store)[0].utility, consolidate.UTILITY_MAX, '20 good runs at step 1 must clamp, not equal 20');
});

t('re-running reinforce() over the SAME store + SAME runs is a true no-op (idempotent)', () => {
  const dir = freshDir('reinforce-idempotent');
  const store = path.join(dir, 'lessons.jsonl');
  const runsDir = path.join(dir, 'runs');
  writeStore(store, [lesson({ id: 'L1', ts: '2026-01-01T00:00:00.000Z' })]);
  writeGoodRun(runsDir, 'forge-2026-02-01-good', '2026-02-01T00:00:00.000Z');
  reinforce.reinforce({ store, runs: runsDir });
  const afterFirst = readStore(store)[0].utility;
  const r2 = reinforce.reinforce({ store, runs: runsDir }); // same runs again
  assert.strictEqual(r2.reinforcedGood, 0, 'no NEW reinforcement — the run was already counted');
  assert.strictEqual(r2.alreadyDone, 1);
  assert.strictEqual(readStore(store)[0].utility, afterFirst, 'utility must not move on a repeat pass');
});

t('adding a genuinely NEW run after a first pass still reinforces further (idempotency is per-pair, not global)', () => {
  const dir = freshDir('reinforce-incremental');
  const store = path.join(dir, 'lessons.jsonl');
  const runsDir = path.join(dir, 'runs');
  writeStore(store, [lesson({ id: 'L1', ts: '2026-01-01T00:00:00.000Z' })]);
  writeGoodRun(runsDir, 'forge-2026-02-01-good', '2026-02-01T00:00:00.000Z');
  reinforce.reinforce({ store, runs: runsDir });
  writeGoodRun(runsDir, 'forge-2026-02-02-good', '2026-02-02T00:00:00.000Z'); // a second, new good run
  const r2 = reinforce.reinforce({ store, runs: runsDir });
  assert.strictEqual(r2.reinforcedGood, 1, 'only the NEW run counts this pass');
  assert.strictEqual(readStore(store)[0].utility, 2);
});

// ---------------------------------------------------------------------------
// 6) unreinforceable / undeterminable
// ---------------------------------------------------------------------------
console.log('\n6) unreinforceable / undeterminable — never guessed');

t('a non-canonical lesson (no real evidence.run_id) is unreinforceable, never scored', () => {
  const dir = freshDir('reinforce-noncanon');
  const store = path.join(dir, 'lessons.jsonl');
  const runsDir = path.join(dir, 'runs');
  writeStore(store, [lesson({ id: 'L1', evidence: 'not json at all' })]);
  writeGoodRun(runsDir, 'forge-2026-02-01-good', '2026-02-01T00:00:00.000Z');
  const r = reinforce.reinforce({ store, runs: runsDir });
  assert.strictEqual(r.unreinforceable, 1);
  assert.strictEqual(r.reinforcedGood, 0);
  assert.ok(!Object.prototype.hasOwnProperty.call(r.perLesson, 'L1'));
});

t('a run whose events.jsonl cannot be read (e.g. a directory in its place) is undeterminable, never counted good or bad', () => {
  const dir = freshDir('reinforce-undeterminable');
  const store = path.join(dir, 'lessons.jsonl');
  const runsDir = path.join(dir, 'runs');
  writeStore(store, [lesson({ id: 'L1', ts: '2026-01-01T00:00:00.000Z' })]);
  const badRunDir = path.join(runsDir, 'forge-2026-02-01-broken');
  fs.mkdirSync(path.join(badRunDir, 'events.jsonl'), { recursive: true }); // events.jsonl is a DIRECTORY, not a file
  fs.writeFileSync(path.join(badRunDir, 'run.json'), JSON.stringify({ started_at: '2026-02-01T00:00:00.000Z' }), 'utf8');
  const r = reinforce.reinforce({ store, runs: runsDir });
  assert.strictEqual(r.undeterminable, 1);
  assert.strictEqual(r.reinforcedGood, 0);
  assert.strictEqual(r.reinforcedBad, 0);
  assert.strictEqual(readStore(store)[0].utility, 0);
});

// ---------------------------------------------------------------------------
// 7) dry-run
// ---------------------------------------------------------------------------
console.log('\n7) dry-run never writes');

t('dry-run reports what would happen but leaves the store file untouched', () => {
  const dir = freshDir('reinforce-dry');
  const store = path.join(dir, 'lessons.jsonl');
  const runsDir = path.join(dir, 'runs');
  writeStore(store, [lesson({ id: 'L1', ts: '2026-01-01T00:00:00.000Z' })]);
  writeGoodRun(runsDir, 'forge-2026-02-01-good', '2026-02-01T00:00:00.000Z');
  const before = fs.readFileSync(store, 'utf8');
  const r = reinforce.reinforce({ store, runs: runsDir, dryRun: true });
  assert.strictEqual(r.reinforcedGood, 1);
  assert.strictEqual(fs.readFileSync(store, 'utf8'), before);
});

// ---------------------------------------------------------------------------
// 8) CLI
// ---------------------------------------------------------------------------
console.log('\n8) CLI (real spawned subprocess)');

t('CLI missing --store/--runs exits 2', () => {
  const r = runCLI([]);
  assert.strictEqual(r.status, 2);
});

t('CLI --store --runs --json runs for real and rewrites the store', () => {
  const dir = freshDir('reinforce-cli');
  const store = path.join(dir, 'lessons.jsonl');
  const runsDir = path.join(dir, 'runs');
  writeStore(store, [lesson({ id: 'L1', ts: '2026-01-01T00:00:00.000Z' })]);
  writeGoodRun(runsDir, 'forge-2026-02-01-good', '2026-02-01T00:00:00.000Z');
  const r = runCLI(['--store', store, '--runs', runsDir, '--json']);
  assert.strictEqual(r.status, 0);
  const parsed = JSON.parse(r.stdout.trim());
  assert.strictEqual(parsed.reinforcedGood, 1);
  assert.strictEqual(readStore(store)[0].utility, 1);
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
