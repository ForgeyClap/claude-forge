#!/usr/bin/env node
'use strict';
// forge-recall.test.cjs — real tests for utility-ranked lesson recall with a reserved GLOBAL/Lead
// namespace (WAVE E / E2, 2026-07-18). Every fixture lives under a fresh os.tmpdir() FORGE_PROJECT_ROOT —
// this file NEVER touches this repo's real .claude/agent-memory/.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const recall = require('./forge-recall.cjs');
const memory = require('./forge-memory.cjs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

function freshRoot(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); }
function seedLesson(root, namespace, overrides) {
  const rec = Object.assign({ text: 'a lesson', tags: [], type: 'semantic', ts: new Date().toISOString() }, overrides || {});
  return memory.addLesson(namespace, rec, root); // reuses the real write path — same store forge-recall reads
}
function bumpUtility(root, namespace, id, utility) {
  const file = path.join(memory.memDir(namespace, root), 'lessons.jsonl');
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  for (const l of lines) if (l.id === id) l.utility = utility;
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
}

const CLI = path.join(__dirname, 'forge-recall.cjs');
function runCLI(argv, root) { return spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8', env: Object.assign({}, process.env, { FORGE_PROJECT_ROOT: root }) }); }

console.log('forge-recall tests (utility-ranked recall with reserved global namespace)');

// ---------------------------------------------------------------------------
// 1) basic namespace recall
// ---------------------------------------------------------------------------
console.log('\n1) namespace recall — relevance scoring');

t('a namespace-specific lesson matching the query is recalled', () => {
  const root = freshRoot('recall-basic');
  seedLesson(root, 'build-boss', { text: 'always run the build before committing', tags: ['build', 'ci'] });
  const r = recall.recall({ query: 'build ci', namespace: 'build-boss' }, { root });
  assert.ok(r.lessons.some((l) => l.text.includes('always run the build')));
});

t('a namespace-specific lesson with zero relevance to the query is NOT recalled (old enough that recency contributes nothing either)', () => {
  const root = freshRoot('recall-irrelevant');
  const old = new Date(Date.now() - 120 * 86400000).toISOString(); // >60 days old — recency term is 0
  seedLesson(root, 'build-boss', { text: 'completely unrelated topic', tags: ['unrelated'], ts: old });
  const r = recall.recall({ query: 'payments stripe webhook', namespace: 'build-boss' }, { root });
  assert.strictEqual(r.lessons.filter((l) => l.namespace === 'build-boss').length, 0);
});

// ---------------------------------------------------------------------------
// 2) the reserved GLOBAL/Lead namespace is ALWAYS recalled
// ---------------------------------------------------------------------------
console.log('\n2) global/Lead namespace — always recalled, regardless of query match');

t('a global lesson with ZERO keyword relevance to the query STILL appears when recalling any namespace', () => {
  const root = freshRoot('recall-global-always');
  seedLesson(root, 'global', { text: 'never auto-push without explicit approval', tags: ['governance'] });
  seedLesson(root, 'build-boss', { text: 'stripe webhook signature must be verified', tags: ['stripe', 'webhook'] });
  const r = recall.recall({ query: 'stripe webhook signature', namespace: 'build-boss' }, { root });
  const globalHit = r.lessons.find((l) => l.namespace === 'global');
  assert.ok(globalHit, 'the global lesson must be present even though the query never mentions it');
  assert.strictEqual(r.globalIncluded, 1);
});

t('recalling with no namespace at all defaults to the global namespace itself', () => {
  const root = freshRoot('recall-default-global');
  seedLesson(root, 'global', { text: 'honesty core is untouchable', tags: ['honesty'] });
  const r = recall.recall({ query: 'honesty' }, { root });
  assert.strictEqual(r.namespace, 'global');
  assert.ok(r.lessons.some((l) => l.text.includes('honesty core')));
});

t('an empty global namespace degrades honestly — no crash, a note, globalIncluded:0', () => {
  const root = freshRoot('recall-empty-global');
  seedLesson(root, 'build-boss', { text: 'some relevant lesson about tests', tags: ['tests'] });
  const r = recall.recall({ query: 'tests', namespace: 'build-boss' }, { root });
  assert.strictEqual(r.globalIncluded, 0);
  assert.ok(r.notes.some((n) => n.includes('global')));
});

t('with more global lessons than fit half of k, only the BEST-scoring global lessons are kept, never arbitrary ones', () => {
  const root = freshRoot('recall-global-cap');
  for (let i = 0; i < 6; i++) seedLesson(root, 'global', { text: 'global rule number ' + i, tags: ['rule' + i], ts: new Date(Date.now() - i * 86400000).toISOString() });
  const r = recall.recall({ query: '' }, { root, k: 4 });
  assert.ok(r.globalIncluded <= 4);
  assert.ok(r.lessons.every((l) => l.namespace === 'global'));
});

// ---------------------------------------------------------------------------
// 3) utility affects ranking
// ---------------------------------------------------------------------------
console.log('\n3) ranking by utility');

t('among two equally query-relevant namespace lessons, the higher-utility one ranks first', () => {
  const root = freshRoot('recall-utility-rank');
  const low = seedLesson(root, 'build-boss', { text: 'run the tests before merging low', tags: ['tests'] });
  const high = seedLesson(root, 'build-boss', { text: 'run the tests before merging high', tags: ['tests'] });
  bumpUtility(root, 'build-boss', low.id, -1);
  bumpUtility(root, 'build-boss', high.id, 3);
  const r = recall.recall({ query: 'tests merging', namespace: 'build-boss' }, { root });
  const idxLow = r.lessons.findIndex((l) => l.id === low.id);
  const idxHigh = r.lessons.findIndex((l) => l.id === high.id);
  assert.ok(idxHigh !== -1 && idxLow !== -1, 'both must be present');
  assert.ok(idxHigh < idxLow, 'higher utility lesson ranks ahead of an equally-relevant lower one');
});

// ---------------------------------------------------------------------------
// 4) top-K respected
// ---------------------------------------------------------------------------
console.log('\n4) top-K budget');

t('recall never returns more than k lessons total', () => {
  const root = freshRoot('recall-topk');
  for (let i = 0; i < 10; i++) seedLesson(root, 'build-boss', { text: 'lesson about deploy step ' + i, tags: ['deploy'] });
  const r = recall.recall({ query: 'deploy step' }, { root, namespace: 'build-boss', k: 3 });
  assert.ok(r.lessons.length <= 3);
});

// ---------------------------------------------------------------------------
// 5) CLI
// ---------------------------------------------------------------------------
console.log('\n5) CLI (real spawned subprocess)');

t('CLI --json returns a well-shaped result and exits 0', () => {
  const root = freshRoot('recall-cli');
  seedLesson(root, 'global', { text: 'cli global lesson', tags: ['cli'] });
  const r = runCLI(['--query', 'cli global', '--json'], root);
  assert.strictEqual(r.status, 0);
  const parsed = JSON.parse(r.stdout.trim());
  assert.strictEqual(parsed.namespace, 'global');
  assert.ok(parsed.lessons.some((l) => l.text.includes('cli global lesson')));
});

t('CLI --namespace <boss> still includes the global namespace', () => {
  const root = freshRoot('recall-cli-ns');
  seedLesson(root, 'global', { text: 'cli namespace global rule', tags: ['x'] });
  seedLesson(root, 'ui-boss', { text: 'cli namespace-specific rule about buttons', tags: ['buttons'] });
  const r = runCLI(['--query', 'buttons', '--namespace', 'ui-boss', '--json'], root);
  assert.strictEqual(r.status, 0);
  const parsed = JSON.parse(r.stdout.trim());
  assert.ok(parsed.lessons.some((l) => l.namespace === 'global'));
  assert.ok(parsed.lessons.some((l) => l.namespace === 'ui-boss'));
});

t('CLI --help exits 0 without requiring any other flag', () => {
  const r = runCLI(['--help'], freshRoot('recall-cli-help'));
  assert.strictEqual(r.status, 0);
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
