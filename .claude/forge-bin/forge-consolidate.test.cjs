#!/usr/bin/env node
'use strict';
// forge-consolidate.test.cjs — real tests for the honesty-safe lesson-store consolidator (WAVE E / E2,
// 2026-07-18). Every fixture lives under a fresh os.tmpdir() directory — this file NEVER touches this
// repo's real .claude/agent-memory/.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const consolidate = require('./forge-consolidate.cjs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

function freshDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); }
function writeJsonl(file, records) { fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''), 'utf8'); }
function readJsonl(file) { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); }

function lesson(overrides) {
  return Object.assign({
    id: 'L' + Math.random().toString(36).slice(2, 8),
    type: 'semantic',
    tags: ['a', 'b'],
    text: 'A real canonical quote from a logged event.',
    evidence: JSON.stringify({ run_id: 'forge-run-a', ts: '2026-06-01T00:00:00.000Z', event_type: 'check_passed' }),
    ts: '2026-06-01T00:00:00.000Z',
    utility: 0, uses: 0, reinforced_by: [],
  }, overrides || {});
}

const CLI = path.join(__dirname, 'forge-consolidate.cjs');
function runCLI(argv) { return spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' }); }

console.log('forge-consolidate tests (honesty-safe lesson-store consolidator)');

// ---------------------------------------------------------------------------
// 1) missing / empty store degrades honestly
// ---------------------------------------------------------------------------
console.log('\n1) missing/empty store');

t('a store path that does not exist yet: before=0, after=0, no throw', () => {
  const dir = freshDir('consolidate-missing');
  const store = path.join(dir, 'lessons.jsonl');
  const r = consolidate.consolidate({ store });
  assert.strictEqual(r.before, 0);
  assert.strictEqual(r.after, 0);
});

t('opts.store is required — throws when omitted', () => {
  assert.throws(() => consolidate.consolidate({}));
});

// ---------------------------------------------------------------------------
// 2) no-synthesis guard — validateCanonical() / rejection of synthesised/quote-less records
// ---------------------------------------------------------------------------
console.log('\n2) no-synthesis guard — a synthesised/quote-less lesson is REJECTED');

t('a record with empty text is rejected (no canonical quote)', () => {
  const dir = freshDir('consolidate-reject');
  const store = path.join(dir, 'lessons.jsonl');
  writeJsonl(store, [lesson({ text: '' })]);
  const r = consolidate.consolidate({ store });
  assert.strictEqual(r.after, 0);
  assert.strictEqual(r.rejected.length, 1);
  assert.ok(r.rejected[0].reason.includes('text'));
});

t('a record whose evidence is not JSON is rejected (quote-less, no real run_id)', () => {
  const dir = freshDir('consolidate-reject');
  const store = path.join(dir, 'lessons.jsonl');
  writeJsonl(store, [lesson({ evidence: 'this is just free text, not evidence' })]);
  const r = consolidate.consolidate({ store });
  assert.strictEqual(r.after, 0);
  assert.strictEqual(r.rejected.length, 1);
  assert.ok(r.rejected[0].reason.includes('run_id'));
});

t('a record whose evidence JSON has no run_id field is rejected', () => {
  const dir = freshDir('consolidate-reject');
  const store = path.join(dir, 'lessons.jsonl');
  writeJsonl(store, [lesson({ evidence: JSON.stringify({ event_type: 'check_passed' }) })]);
  const r = consolidate.consolidate({ store });
  assert.strictEqual(r.after, 0);
  assert.strictEqual(r.rejected.length, 1);
});

t('a record with a missing/invalid ts is rejected', () => {
  const dir = freshDir('consolidate-reject');
  const store = path.join(dir, 'lessons.jsonl');
  writeJsonl(store, [lesson({ ts: 'not-a-real-date' })]);
  const r = consolidate.consolidate({ store });
  assert.strictEqual(r.after, 0);
  assert.strictEqual(r.rejected.length, 1);
  assert.ok(r.rejected[0].reason.includes('timestamp'));
});

t('a fully canonical record (real text + real evidence.run_id + valid ts) survives', () => {
  const dir = freshDir('consolidate-ok');
  const store = path.join(dir, 'lessons.jsonl');
  writeJsonl(store, [lesson({ id: 'keep-me' })]);
  const r = consolidate.consolidate({ store });
  assert.strictEqual(r.after, 1);
  assert.strictEqual(r.rejected.length, 0);
  assert.deepStrictEqual(r.keptIds, ['keep-me']);
});

t('rejected records never end up in the rewritten store file on disk', () => {
  const dir = freshDir('consolidate-reject-disk');
  const store = path.join(dir, 'lessons.jsonl');
  writeJsonl(store, [lesson({ id: 'good-one' }), lesson({ id: 'bad-one', text: '' })]);
  consolidate.consolidate({ store });
  const onDisk = readJsonl(store);
  assert.strictEqual(onDisk.length, 1);
  assert.strictEqual(onDisk[0].id, 'good-one');
});

// ---------------------------------------------------------------------------
// 3) merge — exact-normalized-text duplicates only, text NEVER rewritten
// ---------------------------------------------------------------------------
console.log('\n3) merge duplicates — never blends/rewrites text');

t('two records with the same type + normalized text (whitespace/case differ) merge into one survivor', () => {
  const dir = freshDir('consolidate-merge');
  const store = path.join(dir, 'lessons.jsonl');
  writeJsonl(store, [
    lesson({ id: 'older', text: 'Always run the build before committing.', ts: '2026-06-01T00:00:00.000Z', tags: ['build'] }),
    lesson({ id: 'newer', text: '  always RUN the build   before committing.  ', ts: '2026-06-05T00:00:00.000Z', tags: ['ci'], evidence: JSON.stringify({ run_id: 'forge-run-b', ts: '2026-06-05T00:00:00.000Z', event_type: 'check_passed' }) }),
  ]);
  const r = consolidate.consolidate({ store });
  assert.strictEqual(r.after, 1);
  assert.strictEqual(r.mergedCount, 1);
  const onDisk = readJsonl(store);
  assert.strictEqual(onDisk.length, 1);
  assert.strictEqual(onDisk[0].id, 'older', 'the OLDEST record survives');
  assert.strictEqual(onDisk[0].text, 'Always run the build before committing.', 'text is the OLDER record\'s text, verbatim — never blended');
  assert.deepStrictEqual(onDisk[0].tags.sort(), ['build', 'ci'], 'tags are unioned');
  assert.ok(onDisk[0].merged_ids.includes('newer'), 'the absorbed id is recorded for audit');
});

t('two records with DIFFERENT text (not a normalized-text match) are never merged, even if similar', () => {
  const dir = freshDir('consolidate-no-merge');
  const store = path.join(dir, 'lessons.jsonl');
  writeJsonl(store, [
    lesson({ id: 'a', text: 'Always run the build before committing.' }),
    lesson({ id: 'b', text: 'Always run the tests before committing.', evidence: JSON.stringify({ run_id: 'forge-run-b', ts: '2026-06-01T00:00:00.000Z', event_type: 'check_passed' }) }),
  ]);
  const r = consolidate.consolidate({ store });
  assert.strictEqual(r.after, 2, 'no fuzzy/semantic merge — this module never guesses at "close enough"');
  assert.strictEqual(r.mergedCount, 0);
});

t('merged reinforced_by is a true set union — uses is never double-counted', () => {
  const dir = freshDir('consolidate-merge-union');
  const store = path.join(dir, 'lessons.jsonl');
  writeJsonl(store, [
    lesson({ id: 'older', text: 'same text here', ts: '2026-06-01T00:00:00.000Z', reinforced_by: ['run-x', 'run-y'], uses: 2 }),
    lesson({ id: 'newer', text: 'same text here', ts: '2026-06-05T00:00:00.000Z', reinforced_by: ['run-y', 'run-z'], uses: 2, evidence: JSON.stringify({ run_id: 'forge-run-c', ts: '2026-06-05T00:00:00.000Z', event_type: 'check_passed' }) }),
  ]);
  consolidate.consolidate({ store });
  const onDisk = readJsonl(store);
  assert.strictEqual(onDisk.length, 1);
  assert.deepStrictEqual(onDisk[0].reinforced_by.sort(), ['run-x', 'run-y', 'run-z']);
  assert.strictEqual(onDisk[0].uses, 3, 'uses derives from the UNIONED set (run-y counted once), not 2+2');
});

// ---------------------------------------------------------------------------
// 4) decay — numeric only, respects the age window
// ---------------------------------------------------------------------------
console.log('\n4) decay — stale utility shrinks toward zero, text untouched');

t('a stale record (older than decayAfterDays, non-zero utility) decays by decayFactor exactly', () => {
  const dir = freshDir('consolidate-decay');
  const store = path.join(dir, 'lessons.jsonl');
  const now = Date.parse('2026-08-01T00:00:00.000Z');
  writeJsonl(store, [lesson({ id: 'stale', utility: 2, ts: '2026-06-01T00:00:00.000Z' })]);
  const r = consolidate.consolidate({ store, now, decayAfterDays: 30, decayFactor: 0.5 });
  assert.strictEqual(r.decayedCount, 1);
  const onDisk = readJsonl(store);
  assert.strictEqual(onDisk[0].utility, 1, 'utility halved exactly (2 * 0.5)');
  assert.strictEqual(onDisk[0].text, 'A real canonical quote from a logged event.', 'text untouched by decay');
});

t('a fresh record (within decayAfterDays) is never decayed', () => {
  const dir = freshDir('consolidate-no-decay');
  const store = path.join(dir, 'lessons.jsonl');
  const now = Date.parse('2026-06-05T00:00:00.000Z');
  writeJsonl(store, [lesson({ id: 'fresh', utility: 2, ts: '2026-06-01T00:00:00.000Z' })]);
  const r = consolidate.consolidate({ store, now, decayAfterDays: 30 });
  assert.strictEqual(r.decayedCount, 0);
  assert.strictEqual(readJsonl(store)[0].utility, 2);
});

t('a record with utility 0 is never decayed (nothing to shrink)', () => {
  const dir = freshDir('consolidate-zero-decay');
  const store = path.join(dir, 'lessons.jsonl');
  const now = Date.parse('2026-12-01T00:00:00.000Z');
  writeJsonl(store, [lesson({ id: 'zero', utility: 0, ts: '2026-06-01T00:00:00.000Z' })]);
  const r = consolidate.consolidate({ store, now, decayAfterDays: 30 });
  assert.strictEqual(r.decayedCount, 0);
});

// ---------------------------------------------------------------------------
// 5) prune — only real negative evidence, never a fresh/unused lesson
// ---------------------------------------------------------------------------
console.log('\n5) prune — only net-negative WITH real evidence, never just "new"');

t('a record at/below pruneThreshold with enough real uses is pruned', () => {
  const dir = freshDir('consolidate-prune');
  const store = path.join(dir, 'lessons.jsonl');
  writeJsonl(store, [lesson({ id: 'bad-lesson', utility: -3, uses: 3, reinforced_by: ['r1', 'r2', 'r3'] })]);
  const r = consolidate.consolidate({ store, pruneThreshold: -2, minUsesForPrune: 2 });
  assert.strictEqual(r.prunedCount, 1);
  assert.deepStrictEqual(r.prunedIds, ['bad-lesson']);
  assert.strictEqual(r.after, 0);
});

t('a fresh, never-reinforced record (uses:0) is NEVER pruned, even with a very negative seed utility', () => {
  const dir = freshDir('consolidate-no-prune-fresh');
  const store = path.join(dir, 'lessons.jsonl');
  writeJsonl(store, [lesson({ id: 'fresh-negative', utility: -5, uses: 0, reinforced_by: [] })]);
  const r = consolidate.consolidate({ store, pruneThreshold: -2, minUsesForPrune: 2 });
  assert.strictEqual(r.prunedCount, 0, 'a lesson must accumulate REAL evidence before it can be pruned for being bad');
  assert.strictEqual(r.after, 1);
});

t('a record with real uses but utility above threshold is kept', () => {
  const dir = freshDir('consolidate-no-prune-good');
  const store = path.join(dir, 'lessons.jsonl');
  writeJsonl(store, [lesson({ id: 'still-good', utility: -1, uses: 5, reinforced_by: ['r1', 'r2', 'r3', 'r4', 'r5'] })]);
  const r = consolidate.consolidate({ store, pruneThreshold: -2, minUsesForPrune: 2 });
  assert.strictEqual(r.prunedCount, 0);
});

// ---------------------------------------------------------------------------
// 6) dry-run never writes
// ---------------------------------------------------------------------------
console.log('\n6) dry-run never touches disk');

t('dry-run reports changes but the file on disk is byte-identical to before the call', () => {
  const dir = freshDir('consolidate-dry-run');
  const store = path.join(dir, 'lessons.jsonl');
  writeJsonl(store, [lesson({ id: 'a', text: '' }), lesson({ id: 'b' })]);
  const before = fs.readFileSync(store, 'utf8');
  const r = consolidate.consolidate({ store, dryRun: true });
  assert.strictEqual(r.rejected.length, 1, 'the summary still reflects what WOULD happen');
  const after = fs.readFileSync(store, 'utf8');
  assert.strictEqual(after, before, 'dry-run must never write');
});

// ---------------------------------------------------------------------------
// 7) clampUtility bounds
// ---------------------------------------------------------------------------
console.log('\n7) utility bounds');

t('clampUtility never exceeds UTILITY_MAX/UTILITY_MIN', () => {
  assert.strictEqual(consolidate.clampUtility(999), consolidate.UTILITY_MAX);
  assert.strictEqual(consolidate.clampUtility(-999), consolidate.UTILITY_MIN);
  assert.strictEqual(consolidate.clampUtility(NaN), 0);
});

// ---------------------------------------------------------------------------
// 8) CLI — real subprocess
// ---------------------------------------------------------------------------
console.log('\n8) CLI (real spawned subprocess)');

t('CLI with no --store exits 2', () => {
  const r = runCLI([]);
  assert.strictEqual(r.status, 2);
});

t('CLI --store <file> --json runs consolidate for real and rewrites the file', () => {
  const dir = freshDir('consolidate-cli');
  const store = path.join(dir, 'lessons.jsonl');
  writeJsonl(store, [lesson({ id: 'x' }), lesson({ id: 'y', text: '' })]);
  const r = runCLI(['--store', store, '--json']);
  assert.strictEqual(r.status, 0);
  const parsed = JSON.parse(r.stdout.trim());
  assert.strictEqual(parsed.after, 1);
  const onDisk = readJsonl(store);
  assert.strictEqual(onDisk.length, 1);
  assert.strictEqual(onDisk[0].id, 'x');
});

t('CLI --dry-run leaves the file untouched', () => {
  const dir = freshDir('consolidate-cli-dry');
  const store = path.join(dir, 'lessons.jsonl');
  writeJsonl(store, [lesson({ id: 'z', text: '' })]);
  const before = fs.readFileSync(store, 'utf8');
  const r = runCLI(['--store', store, '--dry-run', '--json']);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(fs.readFileSync(store, 'utf8'), before);
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
