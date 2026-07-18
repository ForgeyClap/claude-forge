#!/usr/bin/env node
'use strict';
/** Offline, hermetic tests for forge-learn.cjs (WP6, 2026-07-13) — opt-in, read-only, cross-project
 *  FEDERATED lesson recall. Every scenario uses its own throwaway temp "project root" (FORGE_PROJECT_ROOT
 *  idiom, same as forge-cost.test.cjs / forge-distill's tests) and/or a throwaway temp "store source"
 *  directory kept STRICTLY separate from any project root — this file never touches this repo's real
 *  .claude/agent-memory or .claude/config. Exit 0 = all pass. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const memory = require('./forge-memory.cjs');
const learn = require('./forge-learn.cjs');

let pass = 0, fail = 0, skip = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };
const skipT = (name, reason) => { skip++; console.log('  SKIP ' + name + ' (' + reason + ')'); };

const CLI = path.join(__dirname, 'forge-learn.cjs');
function freshRoot(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); }
function writeManifest(root, stores) {
  fs.mkdirSync(path.join(root, '.claude', 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'config', 'forge-stores.json'), JSON.stringify({ stores }, null, 2), 'utf8');
}
function writeFederatedLesson(storeSrc, boss, lessonObj) {
  const dir = path.join(storeSrc, boss);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'lessons.jsonl'), JSON.stringify(lessonObj) + '\n', 'utf8');
}
function writeFederatedRawLine(storeSrc, boss, rawLine) {
  const dir = path.join(storeSrc, boss);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'lessons.jsonl'), rawLine + '\n', 'utf8');
}
function runCLI(args, envRoot) { return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: Object.assign({}, process.env, { FORGE_PROJECT_ROOT: envRoot }) }); }

console.log('forge-learn.cjs offline tests (hermetic — opt-in / isolation / read-only)');

// ---- 1) NO manifest -> recall is LOCAL-only, identical to forge-memory.cjs's own recall() ----
console.log('');
console.log('1) opt-in OFF proof (no manifest declared)');
const ROOT1 = freshRoot('forge-learn-nomanifest');
memory.addLesson('build-boss', { type: 'semantic', text: 'Always read the file before Edit.', tags: ['edit', 'read'], ts: '2026-07-01T00:00:00.000Z' }, ROOT1);
memory.addLesson('build-boss', { type: 'episodic', text: 'Do not skip the test suite.', tags: ['test', 'skip'], ts: '2026-07-05T00:00:00.000Z' }, ROOT1);
const localOnly = learn.recall('build-boss', 'edit test', 5, ROOT1);
const memOnly = memory.recall('build-boss', 'edit test', 5, ROOT1);
t('no manifest file exists at all', !fs.existsSync(learn.manifestPath(ROOT1)));
t('forge-learn recall() output is byte-identical to forge-memory recall() (opt-in off)', JSON.stringify(localOnly) === JSON.stringify(memOnly));
t('local-only result is non-empty (sanity check the fixture actually scored)', localOnly.length > 0);
t('no lesson carries a provenance field when opt-in is off', localOnly.every((l) => !('provenance' in l)));

// ---- 2) manifest with a read-only store -> federated lessons appear, tagged + [store:] marker ----
console.log('');
console.log('2) federated store recall (declared, opt-in ON)');
const ROOT2 = freshRoot('forge-learn-fed');
const STORE2 = freshRoot('forge-learn-store-fed');
memory.addLesson('test-boss', { type: 'semantic', text: 'Local lesson about flaky retries.', tags: ['flaky', 'retries'], ts: '2026-07-01T00:00:00.000Z' }, ROOT2);
writeFederatedLesson(STORE2, 'test-boss', { type: 'episodic', text: 'FEDERATED: flaky retries need exponential backoff.', tags: ['flaky', 'retries'], evidence: 'shared-run-1', ts: '2026-07-02T00:00:00.000Z' });
writeManifest(ROOT2, [{ name: 'shared-team', source: STORE2, mode: 'read-only', priority: 0.8 }]);
const fedResults = learn.recall('test-boss', 'flaky retries', 5, ROOT2);
const fedHit = fedResults.find((l) => l.provenance);
t('federated lesson appears in merged recall', !!fedHit);
t('federated lesson carries provenance.store === declared store name', !!fedHit && fedHit.provenance.store === 'shared-team');
t('federated lesson carries provenance.source === resolved store path', !!fedHit && fedHit.provenance.source === path.resolve(STORE2));
const fedPrinted = learn.formatRecall('test-boss', fedResults, false).join('\n');
t('printed ADVISORY block includes a [store:shared-team] marker', fedPrinted.includes('[store:shared-team]'));
t('local lesson in the same recall has NO provenance field', fedResults.some((l) => !l.provenance));

// ---- 3) LOCAL WINS TIES: equal base score -> local ranked before federated ----
console.log('');
console.log('3) local-wins-ties on equal base score');
const ROOT3 = freshRoot('forge-learn-tie');
const STORE3 = freshRoot('forge-learn-store-tie');
const TIE_TS = '2026-07-10T00:00:00.000Z';
const TIE_TEXT = 'Tie test lesson for federated ranking.';
memory.addLesson('tie-boss', { type: 'semantic', text: TIE_TEXT, tags: ['tie', 'test'], ts: TIE_TS }, ROOT3);
writeFederatedLesson(STORE3, 'tie-boss', { type: 'semantic', text: TIE_TEXT, tags: ['tie', 'test'], evidence: 'shared-run-tie', ts: TIE_TS });
writeManifest(ROOT3, [{ name: 'store-tie', source: STORE3, mode: 'read-only', priority: 1 }]); // priority 1 => forced exact tie
const tieResults = learn.recall('tie-boss', 'tie test', 5, ROOT3);
t('tie scenario returns exactly 2 lessons (local + federated)', tieResults.length === 2);
t('tie: LOCAL lesson ranked FIRST', tieResults[0] && !tieResults[0].provenance);
t('tie: federated lesson ranked SECOND', tieResults[1] && !!tieResults[1].provenance);

// ---- 4) ingest hardening: symlink skip / traversal reject / malformed JSON / unknown format-version ----
console.log('');
console.log('4) ingest hardening');
const STORE4 = freshRoot('forge-learn-store-harden');

// 4a) malformed JSON line is skipped and counted, good line kept
writeFederatedRawLine(STORE4, 'boss-malformed', JSON.stringify({ type: 'semantic', text: 'Good federated lesson.', tags: ['ok'], ts: '2026-07-01T00:00:00.000Z' }));
writeFederatedRawLine(STORE4, 'boss-malformed', '{this is not valid json');
const rMalformed = learn.readBossLessonsFromStore(STORE4, 'boss-malformed', undefined);
t('malformed JSON line skipped (not thrown, not included)', rMalformed.lessons.length === 1 && rMalformed.lessons[0].text === 'Good federated lesson.');
t('malformed JSON line counted in stats.malformed', rMalformed.stats.malformed === 1);

// 4b) unknown format-version lesson is ignored (fail closed), v:1 and no-v are both accepted
writeFederatedRawLine(STORE4, 'boss-version', JSON.stringify({ v: 1, type: 'semantic', text: 'Explicit v1 lesson.', tags: [], ts: '2026-07-01T00:00:00.000Z' }));
writeFederatedRawLine(STORE4, 'boss-version', JSON.stringify({ type: 'semantic', text: 'No-version lesson (back-compat).', tags: [], ts: '2026-07-01T00:00:00.000Z' }));
writeFederatedRawLine(STORE4, 'boss-version', JSON.stringify({ v: 2, type: 'semantic', text: 'Future-format lesson, must be ignored.', tags: [], ts: '2026-07-01T00:00:00.000Z' }));
const rVersion = learn.readBossLessonsFromStore(STORE4, 'boss-version', undefined);
t('unknown format-version (v:2) lesson is ignored', !rVersion.lessons.some((l) => l.text.includes('Future-format')));
t('v:1 and no-v lessons are both accepted (2 kept)', rVersion.lessons.length === 2);
t('unknown format-version counted in stats.unknownVersion', rVersion.stats.unknownVersion === 1);

// 4c) traversal rejection — direct proof on the containment primitive itself
t('safeResolve rejects a traversal attempt (../../ escape)', learn.safeResolve(STORE4, '..', '..', 'etc', 'passwd') === null);
t('safeResolve accepts a legitimate path under root', learn.safeResolve(STORE4, 'boss-malformed') === path.join(path.resolve(STORE4), 'boss-malformed'));
t('safeResolve accepts the root itself', learn.safeResolve(STORE4, '.') === path.resolve(STORE4));

// 4d) symlink skip (best-effort: Windows may require Developer Mode/privilege to create symlinks)
const bossCDir = path.join(STORE4, 'boss-symlink');
fs.mkdirSync(bossCDir, { recursive: true });
fs.writeFileSync(path.join(bossCDir, 'lessons.jsonl'), JSON.stringify({ type: 'semantic', text: 'Real file lesson.', tags: [], ts: '2026-07-01T00:00:00.000Z' }) + '\n', 'utf8');
let symlinkErr = null;
try { fs.symlinkSync(path.join(bossCDir, 'lessons.jsonl'), path.join(bossCDir, 'sneaky.jsonl'), 'file'); } catch (e) { symlinkErr = e; }
if (!symlinkErr) {
  const rSymlink = learn.readBossLessonsFromStore(STORE4, 'boss-symlink', undefined);
  t('symlinked .jsonl file is skipped (lstatSync + isSymbolicLink), not read', rSymlink.lessons.length === 1 && rSymlink.lessons[0].text === 'Real file lesson.');
  t('symlink skip counted in stats.skippedSymlink', rSymlink.stats.skippedSymlink === 1);
} else {
  skipT('symlink-skip test', 'no privilege to create a symlink on this host: ' + symlinkErr.message);
}

// ---- 5) READ-ONLY + ISOLATION proof: store dir + an undeclared decoy project are byte-unchanged ----
console.log('');
console.log('5) read-only + isolation proof');
const ROOT5 = freshRoot('forge-learn-readonly');
const STORE5 = freshRoot('forge-learn-store-readonly');
const DECOY = freshRoot('forge-learn-decoy-project'); // a separate "other project" — NEVER declared as a store
writeFederatedLesson(STORE5, 'ro-boss', { type: 'semantic', text: 'Read-only proof lesson.', tags: ['ro'], ts: '2026-07-01T00:00:00.000Z' });
memory.addLesson('ro-boss', { type: 'semantic', text: 'DECOY-SHOULD-NEVER-APPEAR local lesson.', tags: ['decoy'], ts: '2026-07-01T00:00:00.000Z' }, DECOY);
writeManifest(ROOT5, [{ name: 'ro-store', source: STORE5, mode: 'read-only', priority: 0.8 }]);

function snapshot(dir) {
  const out = {};
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out[p] = fs.readFileSync(p, 'utf8'); } };
  walk(dir);
  return out;
}
const store5Before = snapshot(STORE5);
const decoyBefore = snapshot(path.join(DECOY, '.claude'));
learn.recall('ro-boss', 'read only', 5, ROOT5);
learn.recall('ro-boss', 'read only', 5, ROOT5); // call twice to strengthen the "never writes" proof
learn.listStores(ROOT5);
const store5After = snapshot(STORE5);
const decoyAfter = snapshot(path.join(DECOY, '.claude'));
t('declared store files are byte-identical before/after recall + stores', JSON.stringify(store5Before) === JSON.stringify(store5After));
t('undeclared decoy project files are byte-identical (never touched)', JSON.stringify(decoyBefore) === JSON.stringify(decoyAfter));
const isolationResults = learn.recall('ro-boss', 'decoy', 5, ROOT5);
t('decoy project lesson never leaks into an unrelated project recall (isolation-safe)', !isolationResults.some((l) => l.text.includes('DECOY-SHOULD-NEVER-APPEAR')));

// ---- 6) `stores` command: declared stores + honest opt-in-off ----
console.log('');
console.log('6) stores command');
const ROOT6 = freshRoot('forge-learn-stores');
t('listStores with no manifest reports opt-in off', learn.listStores(ROOT6).optInOff === true);
writeManifest(ROOT6, [
  { name: 'good-store', source: STORE2, mode: 'read-only', priority: 0.8 },
  { name: 'missing-store', source: path.join(ROOT6, 'does-not-exist'), mode: 'read-only' },
]);
const stores6 = learn.listStores(ROOT6);
t('listStores with a manifest reports opt-in ON', stores6.optInOff === false);
t('a valid store resolves ok:true with a lesson count', stores6.stores[0].ok === true && stores6.stores[0].lessonCount >= 1);
t('a missing store source resolves ok:false with an honest reason (no crash)', stores6.stores[1].ok === false && /does not exist/.test(stores6.stores[1].reason));

// ---- 7) `lock` command: writes forge-stores.lock (git HEAD or mtime-hash), never modifies the store ----
console.log('');
console.log('7) lock command');
const ROOT7 = freshRoot('forge-learn-lock');
const STORE7 = freshRoot('forge-learn-store-lock');
writeFederatedLesson(STORE7, 'lock-boss', { type: 'semantic', text: 'Lock test lesson.', tags: [], ts: '2026-07-01T00:00:00.000Z' });
writeManifest(ROOT7, [{ name: 'plain-store', source: STORE7, mode: 'read-only' }]);
const store7Before = snapshot(STORE7);
const lock7 = learn.writeLock(ROOT7);
const store7After = snapshot(STORE7);
t('lock resolves a non-git store via mtime-hash', lock7.stores[0].version.kind === 'mtime-hash');
t('mtime-hash commit is a 16-char hex digest', /^[0-9a-f]{16}$/.test(lock7.stores[0].version.commit));
t('lock file was written to .claude/config/forge-stores.lock', fs.existsSync(learn.lockPath(ROOT7)));
t('written lock file is valid JSON matching the returned object', JSON.stringify(JSON.parse(fs.readFileSync(learn.lockPath(ROOT7), 'utf8'))) === JSON.stringify(lock7));
t('lock is deterministic (same store, unmodified, same hash on a second run)', learn.writeLock(ROOT7).stores[0].version.commit === lock7.stores[0].version.commit);
t('lock NEVER modifies the store itself', JSON.stringify(store7Before) === JSON.stringify(store7After));

// 7b) a fabricated git repo resolves via HEAD ref, not mtime-hash
const STORE7G = freshRoot('forge-learn-store-lock-git');
fs.mkdirSync(path.join(STORE7G, '.git', 'refs', 'heads'), { recursive: true });
fs.writeFileSync(path.join(STORE7G, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
const FAKE_SHA = 'deadbeef'.repeat(5); // 40 hex-looking chars
fs.writeFileSync(path.join(STORE7G, '.git', 'refs', 'heads', 'main'), FAKE_SHA + '\n', 'utf8');
const ver7g = learn.resolveStoreVersion(STORE7G);
t('a fabricated git store resolves kind:"git"', ver7g.kind === 'git');
t('git store commit matches the ref file content', ver7g.commit === FAKE_SHA);
t('git store ref recorded', ver7g.ref === 'refs/heads/main');

// ---- 8) CLI usage errors -> exit 2; missing store source -> handled, not a crash ----
console.log('');
console.log('8) CLI exit codes + missing-store handling');
const ROOT8 = freshRoot('forge-learn-cli');
const r8none = runCLI([], ROOT8);
t('no subcommand -> exit 2', r8none.status === 2);
const r8badcmd = runCLI(['bogus'], ROOT8);
t('unknown subcommand -> exit 2', r8badcmd.status === 2);
const r8norecallboss = runCLI(['recall'], ROOT8);
t('recall without a boss-slug -> exit 2', r8norecallboss.status === 2);

writeManifest(ROOT8, [{ name: 'missing', source: path.join(ROOT8, 'nope'), mode: 'read-only' }]);
const r8recall = runCLI(['recall', 'some-boss', '--json'], ROOT8);
t('recall with a missing store source still exits 0 (reported, not a crash)', r8recall.status === 0);
const r8stores = runCLI(['stores', '--json'], ROOT8);
t('stores with a missing store source still exits 0', r8stores.status === 0);
const storesJson8 = JSON.parse(r8stores.stdout || '{}');
t('missing store source reported as ok:false in stores --json output', storesJson8.stores && storesJson8.stores[0] && storesJson8.stores[0].ok === false);
const r8lock = runCLI(['lock', '--json'], ROOT8);
t('lock with a missing store source still exits 0', r8lock.status === 0);

console.log('');
console.log(pass + ' passed, ' + fail + ' failed, ' + skip + ' skipped');
process.exitCode = fail ? 1 : 0;
