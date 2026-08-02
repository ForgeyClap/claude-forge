#!/usr/bin/env node
'use strict';
// forge-codemodel.test.cjs — real tests for the living codebase model (2026-07-19, piece J4). EVERY
// fixture repo lives under a fresh os.tmpdir() dir (fs.mkdtempSync) — this file never walks or writes the
// real project tree. Exit 0 = all pass.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const CM = require('./forge-codemodel.cjs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

function freshRoot(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); }
function writeFile(root, relPath, content) {
  const abs = path.join(root, ...relPath.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}
/** touchAndRewrite(absPath, content) -> writes new content AND forces a distinct mtime (some filesystems /
 *  CI runners have coarse mtime resolution — bump it explicitly so needsReindex's stat proxy reliably
 *  observes a change within a fast test run, without relying on real wall-clock drift). */
function touchAndRewrite(absPath, content) {
  const before = fs.statSync(absPath);
  fs.writeFileSync(absPath, content, 'utf8');
  const bumped = new Date(before.mtimeMs + 5000);
  fs.utimesSync(absPath, bumped, bumped);
}
function trackReadFileSync() {
  const calls = [];
  const original = fs.readFileSync;
  fs.readFileSync = function (...args) { calls.push(String(args[0])); return original.apply(fs, args); };
  return { calls, restore() { fs.readFileSync = original; } };
}

const CLI = path.join(__dirname, 'forge-codemodel.cjs');
function runCLI(argv, cwd) { return spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8', cwd }); }

console.log('forge-codemodel tests (living codebase model — hermetic os.tmpdir() fixtures only)');

// ---------------------------------------------------------------------------
// 1) build() — indexes symbols + hashes, never indexes secrets
// ---------------------------------------------------------------------------
console.log('\n1) build() — full index: symbols, hashes, secrets excluded');

function buildFixture(prefix) {
  const root = freshRoot(prefix);
  writeFile(root, 'src/index.js', [
    'function greet(name) {',
    '  return "hi " + name;',
    '}',
    '',
    'class Greeter {',
    '  constructor() {}',
    '}',
    '',
    'export const VERSION = "1.0.0";',
  ].join('\n'));
  writeFile(root, 'src/utils.py', [
    'def helper(x):',
    '    return x + 1',
    '',
    'class Helper:',
    '    pass',
  ].join('\n'));
  writeFile(root, 'README.md', '# Fixture repo\n');
  writeFile(root, '.env', 'SECRET_TOKEN=should-never-appear-anywhere\n');
  writeFile(root, 'node_modules/some-pkg/index.js', 'function shouldNeverBeSeen() {}\n');
  return root;
}

let fixtureA = buildFixture('cm-a');
let resultA = CM.build({ root: fixtureA }, {});

t('build(): ok:true', () => assert.strictEqual(resultA.ok, true));
t('build(): file_count matches files map size', () => assert.strictEqual(resultA.file_count, Object.keys(resultA.files).length));
t('build(): version is exactly 1 (a hardcoded literal, not CM.INDEX_VERSION, so this pins the real value)', () => assert.strictEqual(resultA.version, 1));
t('build(): a normal (well-under-cap) fixture never gets an honest-but-wrong "capped" note', () => {
  assert.ok(!resultA.notes.some((n) => n.includes('capped')));
});
t('build(): src/index.js is indexed with function + class + export symbols', () => {
  const rec = resultA.files['src/index.js'];
  assert.ok(rec, 'src/index.js must be present');
  const names = rec.symbols.map((s) => s.name);
  assert.ok(names.includes('greet'), 'greet must be skimmed');
  assert.ok(names.includes('Greeter'), 'Greeter must be skimmed');
  assert.ok(names.includes('VERSION'), 'VERSION must be skimmed');
  assert.strictEqual(typeof rec.hash, 'string');
  assert.ok(rec.hash.length > 0);
});
t('build(): src/utils.py is indexed with def/class symbols', () => {
  const rec = resultA.files['src/utils.py'];
  assert.ok(rec, 'src/utils.py must be present');
  const names = rec.symbols.map((s) => s.name);
  assert.ok(names.includes('helper'));
  assert.ok(names.includes('Helper'));
});
t('build(): seeded .env is NEVER indexed', () => {
  assert.ok(!Object.keys(resultA.files).some((p) => p === '.env' || p.endsWith('/.env')));
});
t('build(): node_modules is never walked', () => {
  assert.ok(!Object.keys(resultA.files).some((p) => p.includes('node_modules')));
});
t('build(): index.json is actually written to disk at the default path', () => {
  const expected = path.join(fixtureA, '.claude', 'forge-codemodel', 'index.json');
  assert.strictEqual(resultA.index_path, expected);
  assert.ok(fs.existsSync(expected));
  const onDisk = JSON.parse(fs.readFileSync(expected, 'utf8'));
  assert.strictEqual(onDisk.file_count, resultA.file_count);
});
t('build(): throws a clear error for a non-existent root', () => {
  assert.throws(() => CM.build({ root: path.join(fixtureA, 'nope-does-not-exist') }, {}), /does not exist/);
});

// ---------------------------------------------------------------------------
// 2) update() — incremental: ONLY a changed file gets re-read (proved via a readFileSync spy)
// ---------------------------------------------------------------------------
console.log('\n2) update() — incremental re-index proved via a real fs.readFileSync spy');

t('update() with NO changes re-reads ZERO source files (every file skipped via stat proxy)', () => {
  const root = buildFixture('cm-update-noop');
  CM.build({ root }, {});
  const spy = trackReadFileSync();
  let r;
  try { r = CM.update({ root }, {}); } finally { spy.restore(); }
  assert.strictEqual(r.added.length, 0);
  assert.strictEqual(r.changed.length, 0);
  assert.strictEqual(r.unchanged_content.length, 0);
  assert.strictEqual(r.removed.length, 0);
  assert.strictEqual(r.reindexed_count, 0);
  assert.ok(r.skipped_count >= 2, 'both src files must have been skipped, not re-read');
  const sourceReads = spy.calls.filter((p) => p.includes('src' + path.sep) || p.endsWith('src/index.js') || p.endsWith('src/utils.py'));
  assert.deepStrictEqual(sourceReads, [], 'no source file content should have been re-read for a no-op update');
  assert.ok(!r.notes.some((n) => n.includes('capped')), 'a well-under-cap update must never get an honest-but-wrong "capped" note');
});

t('update() correctly buckets a "touched but content-identical" file as unchanged_content, never changed', () => {
  const root = buildFixture('cm-update-touch-only');
  CM.build({ root }, {});
  const indexAbs = path.join(root, 'src', 'index.js');
  const sameContent = fs.readFileSync(indexAbs, 'utf8');
  touchAndRewrite(indexAbs, sameContent); // identical bytes, different mtime -> stat proxy fires, hash must still match
  const r = CM.update({ root }, {});
  assert.deepStrictEqual(r.changed, []);
  assert.deepStrictEqual(r.unchanged_content, ['src/index.js']);
});

t('update() after editing ONE file re-reads ONLY that file (not the untouched sibling)', () => {
  const root = buildFixture('cm-update-one');
  CM.build({ root }, {});
  const utilsAbs = path.join(root, 'src', 'utils.py');
  touchAndRewrite(utilsAbs, [
    'def helper(x):',
    '    return x + 2  # changed',
    '',
    'class Helper:',
    '    pass',
    '',
    'def brand_new_function():',
    '    return 42',
  ].join('\n'));

  const spy = trackReadFileSync();
  let r;
  try { r = CM.update({ root }, {}); } finally { spy.restore(); }

  assert.deepStrictEqual(r.added, []);
  assert.deepStrictEqual(r.changed, ['src/utils.py']);
  assert.deepStrictEqual(r.unchanged_content, []);
  assert.strictEqual(r.reindexed_count, 1);

  const indexAbsRead = spy.calls.some((p) => path.resolve(p) === path.resolve(utilsAbs));
  assert.ok(indexAbsRead, 'the changed file MUST have been re-read');
  const indexJsAbs = path.join(root, 'src', 'index.js');
  const untouchedRead = spy.calls.some((p) => path.resolve(p) === path.resolve(indexJsAbs));
  assert.strictEqual(untouchedRead, false, 'the untouched sibling file must NOT have been re-read');

  const newNames = r.files['src/utils.py'].symbols.map((s) => s.name);
  assert.ok(newNames.includes('brand_new_function'), 'the re-indexed file must reflect its new symbols');
});

t('update() detects an ADDED file and a REMOVED file correctly', () => {
  const root = buildFixture('cm-update-addremove');
  CM.build({ root }, {});
  writeFile(root, 'src/new_module.go', 'package main\n\nfunc NewThing() {}\n');
  fs.unlinkSync(path.join(root, 'README.md'));
  const r = CM.update({ root }, {});
  assert.deepStrictEqual(r.added, ['src/new_module.go']);
  assert.deepStrictEqual(r.removed, ['README.md']);
  assert.ok(!('README.md' in r.files));
  assert.ok('src/new_module.go' in r.files);
});

t('update() on a root with no prior build() THROWS (never silently full-builds)', () => {
  const root = buildFixture('cm-update-nobuild');
  assert.throws(() => CM.update({ root }, {}), /no index found/);
});

t('update() never indexes a .env added AFTER the initial build', () => {
  const root = buildFixture('cm-update-secret');
  CM.build({ root }, {});
  writeFile(root, '.env.production', 'API_KEY=should-never-appear\n');
  const r = CM.update({ root }, {});
  assert.ok(!Object.keys(r.files).some((p) => p === '.env.production'));
});

// ---------------------------------------------------------------------------
// 3) query() — symbol / file / text lookups from the index only (no source re-read)
// ---------------------------------------------------------------------------
console.log('\n3) query() — answers from the last index, reports staleness honestly');

t('query({symbol}) finds a known symbol and reports its neighbors', () => {
  const root = buildFixture('cm-query-symbol');
  CM.build({ root }, {});
  const spy = trackReadFileSync();
  let r;
  try { r = CM.query({ root, symbol: 'helper' }, {}); } finally { spy.restore(); }
  assert.strictEqual(r.matches.length, 1);
  assert.strictEqual(r.matches[0].file, 'src/utils.py');
  assert.strictEqual(r.matches[0].kind, 'function');
  assert.ok(r.neighbors['src/utils.py'], 'neighbors entry must exist for the matched file');
  assert.ok(r.neighbors['src/utils.py'].dir_files.includes('src/index.js'), 'index.js is a directory sibling');
  assert.ok(r.neighbors['src/utils.py'].sibling_symbols.includes('Helper'), 'sibling symbols include Helper');
  const sourceReads = spy.calls.filter((p) => p.endsWith('utils.py') || p.endsWith('index.js'));
  assert.deepStrictEqual(sourceReads, [], 'query() must never re-read source file content');
});

t('query({file}) returns the record + neighbors for an exact file', () => {
  const root = buildFixture('cm-query-file');
  CM.build({ root }, {});
  const r = CM.query({ root, file: 'src/index.js' }, {});
  assert.strictEqual(r.matches.length, 1);
  assert.strictEqual(r.matches[0].file, 'src/index.js');
  assert.ok(r.matches[0].symbols.some((s) => s.name === 'greet'));
  assert.ok(r.neighbors['src/index.js'].dir_files.includes('src/utils.py'));
});

t('query({file}) for an unknown file returns an honest empty match (never fabricated)', () => {
  const root = buildFixture('cm-query-file-missing');
  CM.build({ root }, {});
  const r = CM.query({ root, file: 'src/does-not-exist.js' }, {});
  assert.strictEqual(r.matches.length, 0);
});

t('query({text}) substring-matches both file paths and symbol names', () => {
  const root = buildFixture('cm-query-text');
  CM.build({ root }, {});
  const r = CM.query({ root, text: 'help' }, {});
  assert.ok(r.matches.some((m) => m.type === 'symbol' && m.name === 'helper'));
  assert.ok(r.matches.some((m) => m.type === 'symbol' && m.name === 'Helper'));
});

t('query() with none of symbol/file/text throws a usage error', () => {
  const root = buildFixture('cm-query-usage');
  CM.build({ root }, {});
  assert.throws(() => CM.query({ root }, {}), /requires one of/);
});

t('query() honestly reports stale:true after a file changes without update()', () => {
  const root = buildFixture('cm-query-stale');
  CM.build({ root }, {});
  touchAndRewrite(path.join(root, 'src', 'utils.py'), 'def helper(x):\n    return x + 999\n');
  const r = CM.query({ root, symbol: 'helper' }, {});
  assert.strictEqual(r.stale, true);
  assert.ok(r.changed_since_index >= 1);
  assert.ok(r.notes.some((n) => n.includes('STALE')));
});

// ---------------------------------------------------------------------------
// 4) staleness() — cheap read-only stat-proxy report
// ---------------------------------------------------------------------------
console.log('\n4) staleness() — cheap, read-only, honest about the proxy it uses');

t('staleness() is 0/false immediately after build()', () => {
  const root = buildFixture('cm-staleness-fresh');
  CM.build({ root }, {});
  const r = CM.staleness({ root }, {});
  assert.strictEqual(r.total_changed, 0);
  assert.strictEqual(r.is_stale, false);
});

t('staleness() reflects an edited file without reading its content', () => {
  const root = buildFixture('cm-staleness-dirty');
  CM.build({ root }, {});
  touchAndRewrite(path.join(root, 'src', 'index.js'), 'function totallyDifferent() {}\n');
  const spy = trackReadFileSync();
  let r;
  try { r = CM.staleness({ root }, {}); } finally { spy.restore(); }
  assert.strictEqual(r.is_stale, true);
  assert.ok(r.changed.includes('src/index.js'));
  const sourceReads = spy.calls.filter((p) => p.endsWith('index.js'));
  assert.deepStrictEqual(sourceReads, [], 'staleness() must never open source file content');
});

// ---------------------------------------------------------------------------
// 5) mutation-verified core: needsReindex() / computeChanges() pinned + a broken-variant proof
// ---------------------------------------------------------------------------
console.log('\n5) mutation-verified: needsReindex()/computeChanges() — the incremental-update core');

t('needsReindex(): identical (size, mtime_ms) -> false', () => {
  assert.strictEqual(CM.needsReindex({ size: 100, mtime_ms: 5000 }, { size: 100, mtimeMs: 5000 }), false);
});
t('needsReindex(): size differs -> true', () => {
  assert.strictEqual(CM.needsReindex({ size: 100, mtime_ms: 5000 }, { size: 101, mtimeMs: 5000 }), true);
});
t('needsReindex(): mtime differs -> true', () => {
  assert.strictEqual(CM.needsReindex({ size: 100, mtime_ms: 5000 }, { size: 100, mtimeMs: 5001 }), true);
});
t('needsReindex(): no prior record at all -> true (new file)', () => {
  assert.strictEqual(CM.needsReindex(null, { size: 1, mtimeMs: 1 }), true);
});

t('computeChanges(): pins exact added/maybeChanged/unchanged/removed buckets on a crafted diff', () => {
  const oldFiles = {
    'a.js': { size: 10, mtime_ms: 1000 },
    'b.js': { size: 20, mtime_ms: 2000 },
    'c.js': { size: 30, mtime_ms: 3000 }, // will be removed
  };
  const current = [
    { relPath: 'a.js', size: 10, mtimeMs: 1000 },   // unchanged
    { relPath: 'b.js', size: 21, mtimeMs: 2000 },   // size changed -> maybeChanged
    { relPath: 'd.js', size: 5, mtimeMs: 4000 },    // new -> added
  ];
  const changes = CM.computeChanges(oldFiles, current);
  assert.deepStrictEqual(changes.added, ['d.js']);
  assert.deepStrictEqual(changes.maybeChanged, ['b.js']);
  assert.deepStrictEqual(changes.unchanged, ['a.js']);
  assert.deepStrictEqual(changes.removed, ['c.js']);
});

// A broken mutant of needsReindex ("always false" — the classic hash-diff-disabled bug): if update() used
// THIS instead of the real needsReindex, a genuine content change would be silently classified as
// "unchanged" and never re-read — the exact regression this piece exists to prevent. Proving the real
// exported function disagrees with the broken one on the SAME crafted input demonstrates the real
// implementation actually discriminates changed-vs-unchanged, which is precisely what the update() test in
// section 2 depends on to be trustworthy (breaking needsReindex this way would make that section's
// 'changed' assertions fail, i.e. this suite goes red under that mutation).
function brokenNeedsReindexAlwaysFalse() { return false; }
t('MUTATION PROOF: an "always false" needsReindex mutant would wrongly call a real size-change "unchanged" — the real function does not', () => {
  const old = { size: 100, mtime_ms: 5000 };
  const stat = { size: 999, mtimeMs: 5000 };
  assert.strictEqual(brokenNeedsReindexAlwaysFalse(old, stat), false, 'the broken mutant always says unchanged');
  assert.strictEqual(CM.needsReindex(old, stat), true, 'the real function correctly says changed');
});
// A broken mutant of needsReindex ("always true" — the classic "cheap update means nothing" bug): if
// update() used THIS, EVERY file would be re-read on every update(), defeating the entire "cheap" purpose
// of this piece. Section 2's "update() with NO changes re-reads ZERO source files" test directly catches
// this mutation (reindexed_count/skipped_count and the readFileSync spy would all disagree).
function brokenNeedsReindexAlwaysTrue() { return true; }
t('MUTATION PROOF: an "always true" needsReindex mutant would wrongly re-read an untouched file — the real function does not', () => {
  const old = { size: 100, mtime_ms: 5000 };
  const stat = { size: 100, mtimeMs: 5000 };
  assert.strictEqual(brokenNeedsReindexAlwaysTrue(old, stat), true, 'the broken mutant always says changed');
  assert.strictEqual(CM.needsReindex(old, stat), false, 'the real function correctly says unchanged');
});

// ---------------------------------------------------------------------------
// 6) CLI — spawned, real process, real exit codes
// ---------------------------------------------------------------------------
console.log('\n6) CLI — spawned process tests');

t('CLI build --root . writes an index and exits 0', () => {
  const root = buildFixture('cm-cli-build');
  const res = runCLI(['build', '--root', '.', '--json'], root);
  assert.strictEqual(res.status, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  assert.strictEqual(parsed.ok, true);
  assert.ok(fs.existsSync(path.join(root, '.claude', 'forge-codemodel', 'index.json')));
});

t('CLI update --root . after build reports an incremental summary and exits 0', () => {
  const root = buildFixture('cm-cli-update');
  runCLI(['build', '--root', '.'], root);
  const res = runCLI(['update', '--root', '.', '--json'], root);
  assert.strictEqual(res.status, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  assert.strictEqual(parsed.reindexed_count, 0);
});

t('CLI update --root . with NO prior build exits 2 (never silently full-builds)', () => {
  const root = buildFixture('cm-cli-update-nobuild');
  const res = runCLI(['update', '--root', '.'], root);
  assert.strictEqual(res.status, 2);
});

t('CLI query --root . --symbol <name> --json finds the symbol and exits 0', () => {
  const root = buildFixture('cm-cli-query');
  runCLI(['build', '--root', '.'], root);
  const res = runCLI(['query', '--root', '.', '--symbol', 'greet', '--json'], root);
  assert.strictEqual(res.status, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  assert.strictEqual(parsed.matches.length, 1);
  assert.strictEqual(parsed.matches[0].file, 'src/index.js');
});

t('CLI staleness --root . exits 0 when fresh, 3 when stale', () => {
  const root = buildFixture('cm-cli-staleness');
  runCLI(['build', '--root', '.'], root);
  const fresh = runCLI(['staleness', '--root', '.', '--json'], root);
  assert.strictEqual(fresh.status, 0, fresh.stderr);
  touchAndRewrite(path.join(root, 'src', 'index.js'), 'function totallyDifferentCliEdit() {}\n');
  const stale = runCLI(['staleness', '--root', '.', '--json'], root);
  assert.strictEqual(stale.status, 3, stale.stderr);
  const parsed = JSON.parse(stale.stdout);
  assert.strictEqual(parsed.is_stale, true);
});

t('CLI with an unknown subcommand exits 2 with usage', () => {
  const res = runCLI(['bogus-subcommand'], freshRoot('cm-cli-bogus'));
  assert.strictEqual(res.status, 2);
});

t('CLI <subcommand> --help / -h exits 0 and prints usage (--help is a per-subcommand flag, mirroring forge-manifest.cjs\'s cmd-first CLI shape)', () => {
  const cwd = freshRoot('cm-cli-help');
  const r1 = runCLI(['build', '--help'], cwd);
  assert.strictEqual(r1.status, 0);
  assert.ok(r1.stderr.includes('Usage:'));
  const r2 = runCLI(['query', '-h'], cwd);
  assert.strictEqual(r2.status, 0);
});

t('CLI build/update/query/staleness with a flag missing its required value all exit 2', () => {
  const root = buildFixture('cm-cli-missingvalue');
  assert.strictEqual(runCLI(['build', '--index'], root).status, 2);
  runCLI(['build', '--root', '.'], root);
  assert.strictEqual(runCLI(['update', '--index'], root).status, 2);
  assert.strictEqual(runCLI(['query', '--symbol'], root).status, 2);
  assert.strictEqual(runCLI(['query', '--file'], root).status, 2);
  assert.strictEqual(runCLI(['query', '--text'], root).status, 2);
  assert.strictEqual(runCLI(['query'], root).status, 2, 'no symbol/file/text at all must also exit 2');
});

t('CLI rejects a genuinely unknown flag inside a valid subcommand with exit 2', () => {
  const root = buildFixture('cm-cli-unknownflag');
  const res = runCLI(['build', '--root', '.', '--not-a-real-flag'], root);
  assert.strictEqual(res.status, 2);
});

t('CLI build/update/query/staleness WITHOUT --json print human-readable text (not raw JSON)', () => {
  const root = buildFixture('cm-cli-humanreadable');
  const b = runCLI(['build', '--root', '.'], root);
  assert.strictEqual(b.status, 0);
  assert.ok(b.stdout.includes('files indexed:'));
  assert.throws(() => JSON.parse(b.stdout), 'build human output must not itself be raw JSON');

  const u = runCLI(['update', '--root', '.'], root);
  assert.strictEqual(u.status, 0);
  assert.ok(u.stdout.includes('added:'), 'the update-specific line must only print for the update subcommand');

  const q = runCLI(['query', '--root', '.', '--symbol', 'greet'], root);
  assert.strictEqual(q.status, 0);
  assert.ok(q.stdout.includes('matches:'));

  const s = runCLI(['staleness', '--root', '.'], root);
  assert.strictEqual(s.status, 0);
  assert.ok(s.stdout.includes('fresh') || s.stdout.includes('STALE'));
});

// ---------------------------------------------------------------------------
// 7) mutation-hardening: root/index-path resolution, exclusion boundaries, bounds, malformed-index guard
//    (added after a real `forge-mutate.cjs` run against this module found live survivors — see build report)
// ---------------------------------------------------------------------------
console.log('\n7) mutation-hardening — root/index-path resolution + exclusion boundaries + bounds');

t('build()/update()/staleness()/query() all default opts to {} when the 2nd arg is omitted entirely', () => {
  const root = buildFixture('cm-omit-opts');
  assert.doesNotThrow(() => CM.build({ root }));
  assert.doesNotThrow(() => CM.update({ root }));
  assert.doesNotThrow(() => CM.staleness({ root }));
  assert.doesNotThrow(() => CM.query({ root, symbol: 'greet' }));
});

t('resolveRootAbs / build() throws a clear error when root is missing entirely', () => {
  assert.throws(() => CM.build({}, {}), /root is required/);
});
t('build() throws EXACTLY the module\'s own "root is not a directory" message when root points at a FILE', () => {
  const root = buildFixture('cm-root-is-file');
  const filePath = path.join(root, 'README.md');
  assert.throws(() => CM.build({ root: filePath }, {}), /forge-codemodel: root is not a directory: /);
});
t('opts.root takes precedence over input.root (same opts.<path> override convention as forge-repomap)', () => {
  const wrong = freshRoot('cm-wrong-root');
  const right = buildFixture('cm-right-root');
  const r = CM.build({ root: wrong }, { root: right });
  assert.strictEqual(r.root, path.resolve(right));
});

t('opts.indexPath overrides the default index location (default path is NOT created)', () => {
  const root = buildFixture('cm-custom-index');
  const customDir = freshRoot('cm-custom-index-store');
  const customPath = path.join(customDir, 'my-index.json');
  const r = CM.build({ root }, { indexPath: customPath });
  assert.strictEqual(r.index_path, customPath);
  assert.ok(fs.existsSync(customPath));
  assert.ok(!fs.existsSync(path.join(root, '.claude', 'forge-codemodel', 'index.json')), 'the default path must NOT have been written when --index overrides it');
});

t('indexOwnDirRelPath(): the default index dir resolves to ".claude/forge-codemodel"', () => {
  const root = path.resolve(freshRoot('cm-iodr-default'));
  const idxPath = path.join(root, '.claude', 'forge-codemodel', 'index.json');
  assert.strictEqual(CM.indexOwnDirRelPath(root, idxPath), '.claude/forge-codemodel');
});
t('indexOwnDirRelPath(): an index path OUTSIDE root resolves to null (nothing to exclude)', () => {
  const root = path.resolve(freshRoot('cm-iodr-outside'));
  const outside = path.join(freshRoot('cm-iodr-elsewhere'), 'index.json');
  assert.strictEqual(CM.indexOwnDirRelPath(root, outside), null);
});
t('indexOwnDirRelPath(): an index path directly IN root (dir === root itself) resolves to null', () => {
  const root = path.resolve(freshRoot('cm-iodr-inroot'));
  const idxPath = path.join(root, 'index.json');
  assert.strictEqual(CM.indexOwnDirRelPath(root, idxPath), null);
});

t('listCurrentFiles(): HARD_EXCLUDE_RELPATHS excludes ".claude/forge-runs" itself AND anything nested under it, but NOT a differently-named sibling dir', () => {
  const root = buildFixture('cm-hardexclude');
  writeFile(root, '.claude/forge-runs/some-run/events.jsonl', '{}\n');
  writeFile(root, '.claude/forge-runs-similar/kept.js', 'function keptFn() {}\n');
  const r = CM.build({ root }, {});
  assert.ok(!Object.keys(r.files).some((p) => p.startsWith('.claude/forge-runs/')));
  assert.ok(Object.keys(r.files).some((p) => p === '.claude/forge-runs-similar/kept.js'), 'a similarly-named but distinct directory must NOT be swept up by the prefix exclusion');
});

t('listCurrentFiles(): a custom --index storage dir is excluded exactly (and its own name-prefix collision sibling is NOT)', () => {
  const root = buildFixture('cm-excludeRelDir');
  const customIndexDir = path.join(root, 'mystore');
  writeFile(root, 'mystore-similar/kept.js', 'function keptFn2() {}\n');
  const r = CM.build({ root }, { indexPath: path.join(customIndexDir, 'index.json') });
  assert.ok(!Object.keys(r.files).some((p) => p.startsWith('mystore/')));
  assert.ok(Object.keys(r.files).some((p) => p === 'mystore-similar/kept.js'));
});

t('listCurrentFiles(): a .gitignore-excluded directory and file are both honored', () => {
  const root = buildFixture('cm-gitignore');
  writeFile(root, '.gitignore', 'ignored_dir/\nignored_file.txt\n');
  writeFile(root, 'ignored_dir/a.js', 'function shouldBeIgnored() {}\n');
  writeFile(root, 'ignored_file.txt', 'ignore me\n');
  writeFile(root, 'kept_file.txt', 'keep me\n');
  const r = CM.build({ root }, {});
  assert.ok(!Object.keys(r.files).some((p) => p.startsWith('ignored_dir/')));
  assert.ok(!('ignored_file.txt' in r.files));
  assert.ok('kept_file.txt' in r.files);
});

t('listCurrentFiles(): a symlink is never followed (skipped gracefully on platforms without symlink privilege)', () => {
  const root = buildFixture('cm-symlink');
  const targetAbs = writeFile(root, 'real_target.js', 'function realFn() {}\n');
  const linkAbs = path.join(root, 'link_to_target.js');
  let symlinked = false;
  try { fs.symlinkSync(targetAbs, linkAbs, 'file'); symlinked = true; } catch { /* no symlink privilege on this runner — honestly skip, not a failure */ }
  if (!symlinked) { assert.ok(true, 'symlink creation unsupported on this runner — skipped honestly'); return; }
  const r = CM.build({ root }, {});
  assert.ok('real_target.js' in r.files);
  assert.ok(!('link_to_target.js' in r.files), 'a symlink must never be walked/listed');
});

t('listCurrentFiles(): the depth cap excludes a file 1 level beyond MAX_DEPTH but keeps one exactly at the cap', () => {
  const root = buildFixture('cm-depthcap');
  const withinPath = 'd1/d2/d3/d4/d5/d6/within.js'; // depth 6 == MAX_DEPTH -> kept
  const beyondPath = 'd1/d2/d3/d4/d5/d6/d7/beyond.js'; // depth 7 > MAX_DEPTH -> dropped
  writeFile(root, withinPath, 'function withinFn() {}\n');
  writeFile(root, beyondPath, 'function beyondFn() {}\n');
  const r = CM.build({ root }, {});
  assert.ok(withinPath in r.files, 'a file exactly at the depth cap must be indexed');
  assert.ok(!(beyondPath in r.files), 'a file one level past the depth cap must be excluded');
});

t('readAndIndexFile(): the symbol-scan size bound is exact — a file AT the cap is hashed, one byte OVER is not', () => {
  const root = buildFixture('cm-sizecap');
  const cap = require('./forge-repomap.cjs').MAX_SYMBOL_SCAN_BYTES;
  writeFile(root, 'at_cap.js', 'x'.repeat(cap));
  writeFile(root, 'over_cap.js', 'x'.repeat(cap + 1));
  const r = CM.build({ root }, {});
  assert.strictEqual(typeof r.files['at_cap.js'].hash, 'string', 'a file exactly at the size cap must still be hashed');
  assert.strictEqual(r.files['over_cap.js'].hash, null, 'a file one byte over the size cap must NOT be hashed');
  assert.deepStrictEqual(r.files['over_cap.js'].symbols, []);
});

t('loadIndex(): distinguishes ENOENT ("no index found") from a genuine read error ("could not read index")', () => {
  const root = buildFixture('cm-loadindex-eisdir');
  const blockedPath = path.join(root, '.claude', 'forge-codemodel', 'blocked-index.json');
  fs.mkdirSync(blockedPath, { recursive: true }); // a DIRECTORY where a file is expected -> EISDIR, not ENOENT
  assert.throws(() => CM.staleness({ root }, { indexPath: blockedPath }), /could not read index/);
  const missingPath = path.join(root, '.claude', 'forge-codemodel', 'does-not-exist.json');
  assert.throws(() => CM.staleness({ root }, { indexPath: missingPath }), /no index found/);
});

t('loadIndex(): each individual clause of the malformed-index guard is independently exercised', () => {
  const root = buildFixture('cm-loadindex-malformed');
  const dir = path.join(root, '.claude', 'forge-codemodel');
  fs.mkdirSync(dir, { recursive: true });
  const cases = {
    'null.json': 'null',
    'number.json': '42',
    'string.json': '"just a string"',
    'no-files-key.json': '{}',
    'files-is-array.json': '{"files":[1,2,3]}',
    'files-is-string.json': '{"files":"nope"}',
  };
  for (const [name, content] of Object.entries(cases)) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, content, 'utf8');
    assert.throws(() => CM.staleness({ root }, { indexPath: p }), /malformed/, name + ' must be rejected as malformed');
  }
});

t('update()/build() truncation: walk capped at MAX_FILES produces an honest truncated note', () => {
  const root = buildFixture('cm-maxfiles');
  const cap = CM.MAX_FILES;
  fs.mkdirSync(path.join(root, 'many'), { recursive: true });
  for (let i = 0; i < cap + 5; i++) fs.writeFileSync(path.join(root, 'many', 'f' + i + '.txt'), 'x', 'utf8');
  const built = CM.build({ root }, {});
  assert.strictEqual(built.file_count, cap);
  assert.ok(built.notes.some((n) => n.includes('capped')));
  const updated = CM.update({ root }, {});
  assert.ok(updated.notes.some((n) => n.includes('capped')));
});

t('query(): an empty-string symbol/file/text is treated as NOT provided (in isolation, each throws alone)', () => {
  const root = buildFixture('cm-query-emptystring');
  CM.build({ root }, {});
  assert.throws(() => CM.query({ root, symbol: '' }, {}), /requires one of/);
  assert.throws(() => CM.query({ root, file: '' }, {}), /requires one of/);
  assert.throws(() => CM.query({ root, text: '' }, {}), /requires one of/);
});
t('query(): a single-character symbol/file/text query is treated as PROVIDED (never throws)', () => {
  const root = buildFixture('cm-query-onechar');
  CM.build({ root }, {});
  assert.doesNotThrow(() => CM.query({ root, symbol: 'g' }, {}));
  assert.doesNotThrow(() => CM.query({ root, file: 'R' }, {}));
  assert.doesNotThrow(() => CM.query({ root, text: 'g' }, {}));
});
t('query(): echoes null (not an empty string) for a field that was empty while another field carried the query', () => {
  const root = buildFixture('cm-query-echo');
  CM.build({ root }, {});
  const r1 = CM.query({ root, symbol: '', file: 'src/index.js' }, {});
  assert.strictEqual(r1.query.symbol, null);
  assert.strictEqual(r1.query.file, 'src/index.js');
  const r2 = CM.query({ root, file: '', text: 'greet' }, {});
  assert.strictEqual(r2.query.file, null);
  const r3 = CM.query({ root, text: '', symbol: 'greet' }, {});
  assert.strictEqual(r3.query.text, null);
});
t('query({text}): a path-only match (no symbol match) returns exactly one hit, and a symbol-only match (no path match) returns exactly one hit', () => {
  const root = buildFixture('cm-query-text-isolation');
  CM.build({ root }, {});
  const pathOnly = CM.query({ root, text: 'readme' }, {});
  assert.strictEqual(pathOnly.matches.length, 1);
  assert.strictEqual(pathOnly.matches[0].type, 'path');
  assert.strictEqual(pathOnly.matches[0].file, 'README.md');
  const symbolOnly = CM.query({ root, text: 'greet' }, {});
  // 'greet' substring-matches BOTH the 'greet' function and the 'Greeter' class (case-insensitive) —
  // no path contains 'greet', so every hit here must be type:'symbol', never type:'path'.
  assert.strictEqual(symbolOnly.matches.length, 2);
  assert.ok(symbolOnly.matches.every((m) => m.type === 'symbol'));
  assert.ok(symbolOnly.matches.some((m) => m.name === 'greet'));
  assert.ok(symbolOnly.matches.some((m) => m.name === 'Greeter'));
});
t('query(): stale is exactly false (never true) and notes is empty immediately after a fresh build', () => {
  const root = buildFixture('cm-query-fresh-not-stale');
  CM.build({ root }, {});
  const r = CM.query({ root, symbol: 'greet' }, {});
  assert.strictEqual(r.stale, false);
  assert.strictEqual(r.changed_since_index, 0);
  assert.deepStrictEqual(r.notes, []);
});

t('buildNeighbors(): a file never lists itself, and never lists a file from a DIFFERENT directory', () => {
  const root = buildFixture('cm-neighbors-boundary');
  CM.build({ root }, {});
  const r = CM.query({ root, symbol: 'helper' }, {});
  const n = r.neighbors['src/utils.py'];
  assert.ok(!n.dir_files.includes('src/utils.py'), 'a file must never list itself as its own neighbor');
  assert.ok(!n.dir_files.includes('README.md'), 'a file from a DIFFERENT directory must never appear as a neighbor');
});
t('query({symbol}): a symbol name that legitimately matches TWICE in the same file (function + export) still returns both matches with a consistent neighbors entry', () => {
  const root = buildFixture('cm-neighbors-dedupe');
  // a function AND a module.exports assignment sharing the SAME name -> repomap.extractSymbols keeps both
  // as distinct {name, kind} entries (kind differs: 'function' vs 'export') — this is the real-world case
  // that exercises query()'s `if (!neighbors[m.file])` dedup guard (recomputing buildNeighbors for the
  // same file twice would be wasted work but not an observable-output bug, since buildNeighbors is a pure
  // function of (idx, relPath) — this test pins the OUTPUT contract that guard must preserve).
  writeFile(root, 'src/dupe.js', [
    'function dupeName() { return 1; }',
    'module.exports.dupeName = dupeName;',
  ].join('\n'));
  CM.build({ root }, {});
  const r = CM.query({ root, symbol: 'dupeName' }, {});
  assert.strictEqual(r.matches.length, 2, 'the symbol must legitimately match twice in the same file (function + export)');
  assert.ok(r.matches.every((m) => m.file === 'src/dupe.js'));
  assert.ok(r.neighbors['src/dupe.js'], 'a single consistent neighbors entry must exist for the file');
});

t('buildNeighbors(): dir_files is capped at exactly 25 entries', () => {
  const root = buildFixture('cm-neighbors-cap');
  fs.mkdirSync(path.join(root, 'manyfiles'), { recursive: true });
  for (let i = 0; i < 30; i++) writeFile(root, 'manyfiles/f' + String(i).padStart(2, '0') + '.js', 'function f' + i + '() {}\n');
  CM.build({ root }, {});
  const r = CM.query({ root, symbol: 'f0' }, {});
  const anyFile = Object.keys(r.neighbors)[0];
  assert.strictEqual(r.neighbors[anyFile].dir_files.length, 25);
});

// ---------------------------------------------------------------------------
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exitCode = failed > 0 ? 1 : 0;
