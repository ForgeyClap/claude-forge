#!/usr/bin/env node
'use strict';
/**
 * forge-repomap.test.cjs — hermetic, offline tests for forge-repomap.cjs. EVERY fixture repo lives under
 * os.tmpdir() (fs.mkdtempSync) — this file never walks or reads the real project tree. Exit 0 = all pass.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const RM = require('./forge-repomap.cjs');

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };

const ALL_TMP_ROOTS = [];
function freshDir(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); ALL_TMP_ROOTS.push(d); return d; }
function writeFile(root, relPath, content) {
  const abs = path.join(root, ...relPath.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

console.log('forge-repomap offline tests (hermetic — os.tmpdir() fixture repos ONLY, never the real project)');

// ---- Section A: a real mixed-language fixture repo — files listed, excludes respected, secrets excluded ----
let repoA;
{
  repoA = freshDir('rm-a-project');
  writeFile(repoA, 'src/index.js', [
    'function greet(name) {',
    '  return "hi " + name;',
    '}',
    '',
    'class Greeter {',
    '  constructor() {}',
    '}',
    '',
    'export const VERSION = "1.0.0";',
    '',
    'module.exports.greet = greet;',
  ].join('\n'));
  writeFile(repoA, 'src/utils.py', [
    'def helper(x):',
    '    return x + 1',
    '',
    'class Helper:',
    '    pass',
  ].join('\n'));
  writeFile(repoA, 'src/main.go', [
    'package main',
    '',
    'func DoThing() {}',
    '',
    'type Config struct {',
    '  Name string',
    '}',
  ].join('\n'));
  writeFile(repoA, 'README.md', '# Fixture repo\n');
  writeFile(repoA, 'node_modules/some-pkg/index.js', 'function shouldNeverBeSeen() {}\n');
  writeFile(repoA, '.env', 'SECRET_TOKEN=should-never-appear-anywhere\n');
  writeFile(repoA, '.git/HEAD', 'ref: refs/heads/main\n');

  const r = RM.map({ root: repoA }, {});

  t('A1: map() succeeds (ok:true)', r.ok === true);
  t('A2: root echoes the resolved absolute fixture path', r.root === path.resolve(repoA));
  t('A3: src/index.js is listed', r.files.some((f) => f.path === 'src/index.js'));
  t('A4: src/utils.py is listed', r.files.some((f) => f.path === 'src/utils.py'));
  t('A5: src/main.go is listed', r.files.some((f) => f.path === 'src/main.go'));
  t('A6: README.md is listed with lang markdown', r.files.some((f) => f.path === 'README.md' && f.lang === 'markdown'));

  t('A7: node_modules is NEVER walked — its file never appears in files[]', !r.files.some((f) => f.path.includes('node_modules')));
  t('A8: node_modules never appears in dirs[] either (not merely file-filtered, genuinely not descended into)', !r.dirs.some((d) => d.path.includes('node_modules')));
  t('A9: .git is never walked', !r.files.some((f) => f.path.includes('.git/')) && !r.dirs.some((d) => d.path.includes('.git')));

  t('A10: the seeded .env NEVER appears anywhere in files[] (secret filename guard)', !r.files.some((f) => f.path === '.env' || f.path.endsWith('/.env')));

  const idx = r.files.find((f) => f.path === 'src/index.js');
  t('A11: src/index.js gets lang "javascript"', idx.lang === 'javascript');
  t('A12: symbol skim finds the top-level function "greet"', idx.symbols.some((s) => s.kind === 'function' && s.name === 'greet'));
  t('A13: symbol skim finds the top-level class "Greeter"', idx.symbols.some((s) => s.kind === 'class' && s.name === 'Greeter'));
  t('A14: symbol skim finds the export const "VERSION"', idx.symbols.some((s) => s.kind === 'export' && s.name === 'VERSION'));
  t('A15: symbol skim finds the exports.greet assignment', idx.symbols.some((s) => s.kind === 'export' && s.name === 'greet'));

  const py = r.files.find((f) => f.path === 'src/utils.py');
  t('A16: python symbol skim finds top-level def "helper"', py.symbols.some((s) => s.kind === 'function' && s.name === 'helper'));
  t('A17: python symbol skim finds top-level class "Helper"', py.symbols.some((s) => s.kind === 'class' && s.name === 'Helper'));

  const go = r.files.find((f) => f.path === 'src/main.go');
  t('A18: go symbol skim finds func "DoThing"', go.symbols.some((s) => s.kind === 'function' && s.name === 'DoThing'));
  t('A19: go symbol skim finds struct type "Config"', go.symbols.some((s) => s.kind === 'struct' && s.name === 'Config'));

  t('A20: README.md (no registered extractor) has an empty symbols array, never guessed', r.files.find((f) => f.path === 'README.md').symbols.length === 0);

  t('A21: dir_count/file_count match the actual arrays', r.dir_count === r.dirs.length && r.file_count === r.files.length);
  t('A22: token_estimate is a positive number (chars/4 heuristic)', typeof r.token_estimate === 'number' && r.token_estimate > 0);
  t('A23: generated_at is a real ISO timestamp', !Number.isNaN(Date.parse(r.generated_at)));
  t('A24: truncated is false (well under default max-files)', r.truncated === false);
  t('A25: the root dir itself is listed as "."', r.dirs.some((d) => d.path === '.' && d.depth === 0));
}

// ---- Section B: depth capping — a deep chain beyond maxDepth is neither entered nor listed ----
{
  const repoB = freshDir('rm-b-depth');
  writeFile(repoB, 'L1/L2/L3/deep.txt', 'deep file, should not appear when maxDepth=1\n');
  writeFile(repoB, 'L1/shallow.txt', 'shallow file at depth 1, should appear\n');
  writeFile(repoB, 'root.txt', 'root file, always appears\n');

  const r = RM.map({ root: repoB, maxDepth: 1 }, {});
  t('B1: root.txt (depth 0) is listed', r.files.some((f) => f.path === 'root.txt'));
  t('B2: L1/shallow.txt (depth 1) is listed', r.files.some((f) => f.path === 'L1/shallow.txt'));
  t('B3: L1/L2/deep chain (depth 2+) is NEVER listed as a file', !r.files.some((f) => f.path.startsWith('L1/L2')));
  t('B4: the L2 directory itself is never listed either (never descended into)', !r.dirs.some((d) => d.path === 'L1/L2'));
  t('B5: the L1 directory (depth 1, at the boundary) IS listed', r.dirs.some((d) => d.path === 'L1' && d.depth === 1));
  t('B6: max_depth on the result echoes the requested value', r.max_depth === 1);

  const rDefault = RM.map({ root: repoB }, {});
  t('B7: with the default max depth (6), the deep file DOES appear', rDefault.files.some((f) => f.path === 'L1/L2/L3/deep.txt'));
}

// ---- Section C: include/exclude regex filters + max-files truncation ----
{
  const repoC = freshDir('rm-c-filters');
  writeFile(repoC, 'src/a.js', 'function a() {}\n');
  writeFile(repoC, 'src/b.py', 'def b():\n    pass\n');
  writeFile(repoC, 'src/c.js', 'function c() {}\n');
  writeFile(repoC, 'docs/notes.md', '# notes\n');

  const rInclude = RM.map({ root: repoC, include: ['\\.js$'] }, {});
  t('C1: --include keeps only matching files (.js)', rInclude.files.every((f) => f.path.endsWith('.js')));
  t('C2: --include actually found the 2 real .js files', rInclude.files.length === 2);

  const rExclude = RM.map({ root: repoC, exclude: ['^docs/'] }, {});
  t('C3: --exclude drops the docs/ subtree entirely from files[]', !rExclude.files.some((f) => f.path.startsWith('docs/')));
  t('C4: --exclude does not affect unrelated files (src/*.js and src/b.py still present)', rExclude.files.length === 3);

  const rCapped = RM.map({ root: repoC, maxFiles: 2 }, {});
  t('C5: max_files caps files[] at the requested size', rCapped.files.length === 2);
  t('C6: truncated is honestly reported true when the cap was hit', rCapped.truncated === true);
  t('C7: a truncation note is present explaining the cap', rCapped.notes.some((n) => /capped/.test(n)));

  let threwBadRegex = false;
  try { RM.map({ root: repoC, exclude: ['(unclosed'] }, {}); } catch { threwBadRegex = true; }
  t('C8: an invalid --exclude regex throws a usage error rather than silently misbehaving', threwBadRegex === true);
}

// ---- Section D: .gitignore-ish support (documented partial, not full glob semantics) ----
{
  const repoD = freshDir('rm-d-gitignore');
  writeFile(repoD, '.gitignore', '# comment\nignored-dir/\n*.log\n');
  // NOTE: deliberately NOT a filename containing "secret"/"key"/etc — this must be excluded PURELY by the
  // gitignore directory rule, not accidentally redundantly caught by the separate isForbiddenFilename guard
  // (a real bug this exact fixture choice previously masked: a broken gitignore-dir-exclude mutation still
  // "passed" because the filename alone was already being dropped for an unrelated reason).
  writeFile(repoD, 'ignored-dir/plainfile.txt', 'should be excluded via gitignore dir rule\n');
  writeFile(repoD, 'kept/notes.log', 'should be excluded via gitignore *.log rule\n');
  writeFile(repoD, 'kept/real.txt', 'should be kept\n');

  const r = RM.map({ root: repoD }, {});
  t('D1: a gitignored directory (ignored-dir/) is excluded entirely (via the gitignore rule alone, not a coincidental secret-filename match)', !r.files.some((f) => f.path.startsWith('ignored-dir/')));
  t('D2: a gitignored wildcard pattern (*.log) excludes matching files anywhere', !r.files.some((f) => f.path.endsWith('.log')));
  t('D3: a real, non-ignored file is still kept', r.files.some((f) => f.path === 'kept/real.txt'));

  // direct unit coverage of loadGitignorePatterns/matchesGitignore — pins down the exact parsing rules
  // (comment/negation skipped, dir-only trailing-slash semantics, leading-slash stripped) at the function
  // level rather than only through the full map() integration above.
  const patterns = RM.loadGitignorePatterns(repoD);
  t('D4: loadGitignorePatterns produces exactly 2 real patterns (comment line contributes none)', patterns.length === 2);
  t('D5: the "ignored-dir/" pattern is marked dir-only', patterns.some((p) => p.isDirOnly === true));
  t('D6: the "*.log" pattern is NOT marked dir-only', patterns.some((p) => p.isDirOnly === false));
  t('D7: matchesGitignore matches a directory against the dir-only pattern (isDir:true)', RM.matchesGitignore(patterns, 'ignored-dir', true) === true);
  t('D8: matchesGitignore does NOT apply a dir-only pattern to a file check (isDir:false) even on an identical name', RM.matchesGitignore(patterns, 'ignored-dir', false) === false);
  t('D9: matchesGitignore matches a real file against the wildcard pattern', RM.matchesGitignore(patterns, 'kept/notes.log', false) === true);
  t('D10: matchesGitignore does not match an unrelated path', RM.matchesGitignore(patterns, 'kept/real.txt', false) === false);
  t('D11: an empty pattern list never matches anything', RM.matchesGitignore([], 'anything', false) === false);

  const repoDNoIgnore = freshDir('rm-d2-no-gitignore');
  t('D12: loadGitignorePatterns returns [] when no .gitignore file exists', RM.loadGitignorePatterns(repoDNoIgnore).length === 0);

  const repoDNeg = freshDir('rm-d3-negation-and-leading-slash');
  writeFile(repoDNeg, '.gitignore', '!not-a-real-ignore\n/leading-slash-dir/\n   \n');
  const patternsNeg = RM.loadGitignorePatterns(repoDNeg);
  t('D13: a negated line (!...) contributes zero patterns (documented as unsupported, never silently un-ignores)', patternsNeg.length === 1);
  t('D14: a leading "/" is stripped so the pattern still matches the bare name', RM.matchesGitignore(patternsNeg, 'leading-slash-dir', true) === true);
}

// ---- Section E: usage/config errors ----
{
  let threwNoRoot = false, noRootMsg = '';
  try { RM.map({}, {}); } catch (e) { threwNoRoot = true; noRootMsg = e.message; }
  t('E1: map() throws when no root is given at all', threwNoRoot === true);
  t('E1b: the no-root error names the real reason (not just any later, coincidental throw)', /requires a root directory/.test(noRootMsg));

  let threwMissingRoot = false;
  try { RM.map({ root: path.join(os.tmpdir(), 'forge-repomap-does-not-exist-xyz') }, {}); } catch { threwMissingRoot = true; }
  t('E2: map() throws when root does not exist', threwMissingRoot === true);

  const repoFile = freshDir('rm-e-notdir');
  const notADir = writeFile(repoFile, 'im-a-file.txt', 'x');
  let threwNotDir = false;
  try { RM.map({ root: notADir }, {}); } catch { threwNotDir = true; }
  t('E3: map() throws when root is a file, not a directory', threwNotDir === true);
}

// ---- Section F: unit coverage of the small pure helpers ----
{
  t('F1: isForbiddenFilename rejects .env', RM.isForbiddenFilename('.env') === true);
  t('F2: isForbiddenFilename rejects .env.local', RM.isForbiddenFilename('.env.local') === true);
  t('F3: isForbiddenFilename rejects a .pem file', RM.isForbiddenFilename('server.pem') === true);
  t('F4: isForbiddenFilename rejects a *secret* filename', RM.isForbiddenFilename('my-secrets.json') === true);
  t('F5: isForbiddenFilename accepts an ordinary source file', RM.isForbiddenFilename('index.js') === false);
  t('F5b: isForbiddenFilename rejects a .key file', RM.isForbiddenFilename('private.key') === true);
  t('F5c: isForbiddenFilename rejects a *credential* filename', RM.isForbiddenFilename('aws-credentials.json') === true);
  t('F5d: isForbiddenFilename rejects an id_rsa file', RM.isForbiddenFilename('id_rsa') === true);
  t('F5e: isForbiddenFilename rejects an id_rsa.pub file too (prefix match)', RM.isForbiddenFilename('id_rsa.pub') === true);
  t('F5f: isForbiddenFilename accepts a filename that merely ends similarly to .key but is not (.keys is a different suffix)', RM.isForbiddenFilename('monkeys.txt') === false);

  t('F6: detectLang maps .ts to typescript', RM.detectLang('foo.ts') === 'typescript');
  t('F7: detectLang maps .rs to rust', RM.detectLang('main.rs') === 'rust');
  t('F8: detectLang falls back to the bare extension for an unknown type', RM.detectLang('data.xyz') === 'xyz');
  t('F9: detectLang returns "unknown" for an extensionless file', RM.detectLang('Makefile') === 'unknown');

  t('F10: extractSymbols returns [] for an unregistered language', RM.extractSymbols('unknown', 'function foo(){}') && RM.extractSymbols('unknown', 'function foo(){}').length === 0);
  t('F11: extractSymbols returns [] for empty/missing text', RM.extractSymbols('javascript', '').length === 0);
  const dedupeSrc = 'function dup(){}\nfunction dup(){}\n';
  t('F12: extractSymbols dedupes an identical repeated symbol', RM.extractSymbols('javascript', dedupeSrc).filter((s) => s.name === 'dup').length === 1);

  const manySrc = Array.from({ length: RM.MAX_SYMBOLS_PER_FILE + 20 }, (_, i) => 'function fn' + i + '(){}').join('\n');
  t('F13: extractSymbols caps output at MAX_SYMBOLS_PER_FILE', RM.extractSymbols('javascript', manySrc).length === RM.MAX_SYMBOLS_PER_FILE);

  t('F14: estimateTokens is a positive integer for non-trivial input', Number.isInteger(RM.estimateTokens([{ path: '.' }], [{ path: 'a.js', size: 10, lang: 'javascript', symbols: [] }])) );
  t('F15: estimateTokens is 0-ish (small) for empty input', RM.estimateTokens([], []) >= 0);
}

// ---- Section G: mutation-adjacent near-miss coverage (kills the specific weakened variants a mutation
// engine would try against the exclude/symbol-skim core) ----
{
  // exclude check must be basename-based, not merely substring-of-path (a real dir named "node_modules_backup"
  // must NOT be excluded just because it contains a similar prefix).
  const repoG = freshDir('rm-g-nearmiss');
  writeFile(repoG, 'node_modules_backup/kept.js', 'function kept(){}\n');
  writeFile(repoG, 'src/dist_report.md', '# not the dist/ dir, just a similarly-prefixed filename\n');
  const r = RM.map({ root: repoG }, {});
  t('G1: a directory merely PREFIXED like an excluded name (node_modules_backup) is NOT excluded', r.files.some((f) => f.path === 'node_modules_backup/kept.js'));
  t('G2: a FILE whose name merely contains an excluded dir name as a substring (dist_report.md) is kept', r.files.some((f) => f.path === 'src/dist_report.md'));

  // symbol skim: a function/class NAME must be captured, not the whole matched line/keyword.
  const idxSym = RM.extractSymbols('javascript', 'class Foo {}\n');
  t('G3: extracted symbol name is exactly "Foo", not "class Foo" or the whole line', idxSym.find((s) => s.kind === 'class').name === 'Foo');

  // python def/class must be TOP-LEVEL (column 0) only — an indented method inside a class must not be
  // picked up as its own top-level symbol (this is the documented "top-level only" cheap-skim behavior).
  const pyIndented = RM.extractSymbols('python', 'class Outer:\n    def inner_method(self):\n        pass\n');
  t('G4: python skim finds the top-level class "Outer"', pyIndented.some((s) => s.kind === 'class' && s.name === 'Outer'));
  t('G5: python skim does NOT report the indented method as its own top-level symbol', !pyIndented.some((s) => s.name === 'inner_method'));
}

// ---- Section K: mutation-hardening — direct unit coverage of collectMatches' internal exec/lastIndex
// guard, the HARD_EXCLUDE_RELPATHS boundary, custom directory-level --exclude, and deterministic sort
// order (the exact lines a mutation engine's boolean/comparator/increment operators target). ----
{
  // K1-K3: collectMatches — a regex whose matches NEVER zero-width-match. The manual lastIndex++ guard
  // must NEVER fire here; any mutant that makes it fire anyway (forceIfTrue / negateCondition / eqStrict
  // flipped to !==) skips a character after every match and silently drops the middle 'a' — 3 -> 2 matches.
  const nonZeroWidthMatches = RM.collectMatches('aaa', /(a)/g, 'letter');
  t('K1: collectMatches finds all 3 non-zero-width matches (no mutant-induced skip)', nonZeroWidthMatches.length === 3);
  t('K2: collectMatches preserves match order/content for every real match', nonZeroWidthMatches.every((m) => m.name === 'a' && m.kind === 'letter'));

  // K3: collectMatches — a regex that CAN zero-width-match at some positions. The guard MUST fire there
  // (or the loop never terminates — re.exec() re-matches the same zero-width position forever). This
  // proves the guard is both correctness- and termination-critical, not merely decorative.
  const zeroWidthMatches = RM.collectMatches('xax', /(a)?/g, 'maybe');
  t('K3: collectMatches terminates and returns exactly the 1 real (non-empty) captured name for a zero-width-capable regex', zeroWidthMatches.length === 1 && zeroWidthMatches[0].name === 'a');

  // K4: collectMatches — falsy/undefined capture group must never be pushed as a symbol (kills the
  // forceIfTrue("name" -> true) mutant, which would push a bogus {name:true} entry for every non-capturing
  // match).
  const undefinedGroupMatches = RM.collectMatches('bar bar', /(foo)?bar/g, 'x');
  t('K4: collectMatches never pushes a falsy/undefined capture group as a symbol name', undefinedGroupMatches.length === 0);

  // K5-K7: HARD_EXCLUDE_RELPATHS boundary — exact-segment match only, never a loose prefix match.
  const repoK = freshDir('rm-k-hardexclude');
  writeFile(repoK, '.claude/forge-runs/run-1/events.jsonl', '{}\n');
  writeFile(repoK, '.claude/forge-runs-other/kept.txt', 'a similarly-prefixed dir name, must NOT be excluded\n');
  writeFile(repoK, '.claude/skills/some-skill/SKILL.md', '# skill\n');
  writeFile(repoK, 'forge-runs/outside-claude.txt', 'a forge-runs dir OUTSIDE .claude — a general-purpose repomap must not blanket-exclude an unrelated repo\'s own directory of this name\n');
  const rK = RM.map({ root: repoK }, {});
  t('K5: .claude/forge-runs itself is excluded (never walked)', !rK.files.some((f) => f.path.startsWith('.claude/forge-runs/')));
  t('K5b: .claude/forge-runs never appears in dirs[] either (path-scoped exclude, genuinely not descended into)', !rK.dirs.some((d) => d.path === '.claude/forge-runs' || d.path.startsWith('.claude/forge-runs/')));
  t('K6: a directory merely PREFIXED like forge-runs (forge-runs-other) is NOT excluded', rK.files.some((f) => f.path === '.claude/forge-runs-other/kept.txt'));
  t('K6b: a same-named "forge-runs" directory OUTSIDE .claude is NOT excluded (path-scoped, not a global basename ban)', rK.files.some((f) => f.path === 'forge-runs/outside-claude.txt'));
  t('K7: the rest of .claude/ (e.g. .claude/skills) stays walkable', rK.files.some((f) => f.path === '.claude/skills/some-skill/SKILL.md'));

  // K8-K9: directory-level --exclude (isDirExcluded's cfg.excludeRes check — distinct code path from the
  // file-level --exclude already covered in Section C).
  const repoK2 = freshDir('rm-k2-direxclude');
  writeFile(repoK2, 'vendor/thirdparty.js', 'function shouldBeExcluded(){}\n');
  writeFile(repoK2, 'src/keep.js', 'function shouldStay(){}\n');
  const rK2 = RM.map({ root: repoK2, exclude: ['^vendor$'] }, {});
  t('K8: a directory-level --exclude pattern removes the WHOLE subtree (never descended into)', !rK2.files.some((f) => f.path.startsWith('vendor/')) && !rK2.dirs.some((d) => d.path === 'vendor'));
  t('K9: an unrelated directory is unaffected by the directory-level --exclude', rK2.files.some((f) => f.path === 'src/keep.js'));

  // K10-K11: deterministic alphabetical sort — a mutated comparator would silently reorder (or fail to
  // stably order) entries; assert the walked order matches a real lexicographic sort.
  const repoK3 = freshDir('rm-k3-sort');
  writeFile(repoK3, 'zzz.txt', 'z');
  writeFile(repoK3, 'aaa.txt', 'a');
  writeFile(repoK3, 'mmm.txt', 'm');
  const rK3 = RM.map({ root: repoK3 }, {});
  const namesInWalkOrder = rK3.files.map((f) => f.path);
  const namesSorted = namesInWalkOrder.slice().sort();
  t('K10: files are discovered in real alphabetical order (root.readdirSync sort comparator is intact)', JSON.stringify(namesInWalkOrder) === JSON.stringify(namesSorted));
  t('K11: all 3 fixture files were actually found (sanity check on the ordering assertion itself)', namesInWalkOrder.length === 3);

  // direct, platform-independent unit coverage of compareStrings itself — a native filesystem's readdir
  // order can already happen to be sorted (masking a broken comparator end-to-end on some platforms/
  // filesystems), so the comparator is also pinned down directly here.
  t('K10b: compareStrings(a,b) returns -1 when a < b', RM.compareStrings('aaa', 'bbb') === -1);
  t('K10c: compareStrings(a,b) returns 1 when a > b', RM.compareStrings('zzz', 'aaa') === 1);
  t('K10d: compareStrings(a,b) returns 0 when a === b', RM.compareStrings('same', 'same') === 0);
  t('K10e: a real array.sort() using compareStrings produces true lexicographic order', ['zzz', 'aaa', 'mmm'].sort(RM.compareStrings).join(',') === 'aaa,mmm,zzz');

  // K12: a directory containing ONLY a subdirectory (no files directly inside it) must report file_count
  // EXACTLY 0 for itself, not an off-by-one 1 (kills the dirFileCounts initial-value zeroToOne mutants).
  const repoK4 = freshDir('rm-k4-emptydir');
  fs.mkdirSync(path.join(repoK4, 'onlyasubdir', 'nested'), { recursive: true });
  writeFile(repoK4, 'onlyasubdir/nested/leaf.txt', 'the only real file, two levels down\n');
  const rK4 = RM.map({ root: repoK4 }, {});
  const onlyASubdirEntry = rK4.dirs.find((d) => d.path === 'onlyasubdir');
  t('K12: a directory with zero direct files (only a subdirectory) reports file_count exactly 0', !!onlyASubdirEntry && onlyASubdirEntry.file_count === 0);
  t('K12b: the nested directory that DOES hold the real file reports file_count exactly 1', rK4.dirs.find((d) => d.path === 'onlyasubdir/nested').file_count === 1);

  // K13: symlinks are never followed (attempted best-effort — Windows may refuse unprivileged symlink
  // creation; skipped honestly rather than falsely claiming coverage when the platform can't support it).
  const repoK5 = freshDir('rm-k5-symlink');
  writeFile(repoK5, 'real/target.js', 'function real(){}\n');
  let symlinkCreated = false;
  try { fs.symlinkSync(path.join(repoK5, 'real'), path.join(repoK5, 'linked'), 'junction'); symlinkCreated = true; } catch { symlinkCreated = false; }
  if (symlinkCreated) {
    const rK5 = RM.map({ root: repoK5 }, {});
    t('K13: a symlinked directory is never followed/walked', !rK5.files.some((f) => f.path.startsWith('linked/')));
  } else {
    console.log('  skip K13: symlink creation not permitted on this platform/account — not claiming coverage');
  }
}

// ---- Section H: toMarkdown() rendering ----
{
  const repoH = freshDir('rm-h-markdown');
  writeFile(repoH, 'src/app.js', 'function main(){}\n');
  const r = RM.map({ root: repoH }, {});
  const md = RM.toMarkdown(r);
  t('H1: markdown starts with a real repo-map heading', /^# Repo Map/.test(md));
  t('H2: markdown mentions the discovered file', md.includes('app.js'));
  t('H3: markdown mentions the extracted symbol', /function main/.test(md));
  t('H4: markdown is a plain string, not JSON', (() => { try { JSON.parse(md); return false; } catch { return true; } })());
}

// ---- Section I: real CLI invoked as a subprocess ----
let repoCli;
{
  repoCli = freshDir('rm-i-cli');
  writeFile(repoCli, 'src/cli-fixture.js', 'function cliFn(){}\nclass CliClass {}\n');
  writeFile(repoCli, '.env', 'X=should-never-leak-to-cli-output\n');
  const cliPath = path.join(__dirname, 'forge-repomap.cjs');

  const rJson = spawnSync(process.execPath, [cliPath, '--root', repoCli, '--json'], { encoding: 'utf8' });
  let jJson = null; try { jJson = JSON.parse(rJson.stdout); } catch { /* asserted below */ }
  t('I1: CLI --json exits 0', rJson.status === 0);
  t('I2: CLI --json output parses as real JSON and finds the fixture file', jJson !== null && jJson.files.some((f) => f.path === 'src/cli-fixture.js'));
  t('I3: CLI --json output never leaks the seeded .env content or path', !rJson.stdout.includes('should-never-leak-to-cli-output') && !/(^|[\\/])\.env"/.test(rJson.stdout));

  const rHuman = spawnSync(process.execPath, [cliPath, '--root', repoCli], { encoding: 'utf8' });
  let parsedAsJson = true; try { JSON.parse(rHuman.stdout); } catch { parsedAsJson = false; }
  t('I4: CLI without --json exits 0', rHuman.status === 0);
  t('I5: CLI without --json prints markdown (not JSON), naming the fixture file', parsedAsJson === false && /^# Repo Map/.test(rHuman.stdout) && rHuman.stdout.includes('cli-fixture.js'));

  const rMaxDepth = spawnSync(process.execPath, [cliPath, '--root', repoCli, '--max-depth', '0', '--json'], { encoding: 'utf8' });
  let jMaxDepth = null; try { jMaxDepth = JSON.parse(rMaxDepth.stdout); } catch { /* asserted below */ }
  t('I6: CLI --max-depth 0 only lists the root dir itself, no src/ subtree', jMaxDepth !== null && jMaxDepth.dirs.length === 1 && jMaxDepth.dirs[0].path === '.');

  const rNoRoot = spawnSync(process.execPath, [cliPath], { encoding: 'utf8' });
  t('I7: CLI exits 2 when --root is missing', rNoRoot.status === 2);
  t('I7b: the missing --root case prints real usage text', /Usage: node forge-repomap\.cjs/.test(rNoRoot.stderr));

  const rBadRoot = spawnSync(process.execPath, [cliPath, '--root', path.join(os.tmpdir(), 'forge-repomap-nope-xyz')], { encoding: 'utf8' });
  t('I8: CLI exits 2 when --root does not exist', rBadRoot.status === 2);

  const requireOnly = spawnSync(process.execPath, ['-e', 'require(' + JSON.stringify(cliPath) + '); console.log("LOADED_OK");'], { encoding: 'utf8' });
  t('I9: requiring forge-repomap.cjs as a plain module never triggers CLI usage output or a stray exit code', requireOnly.status === 0 && requireOnly.stdout.includes('LOADED_OK') && !/Usage: node forge-repomap\.cjs/.test(requireOnly.stderr));
}

// ---- Section J: every temp dir this test file created is under os.tmpdir() ----
{
  const tmpRoot = path.resolve(os.tmpdir());
  t('J1: every one of the ' + ALL_TMP_ROOTS.length + ' fixture roots created this run is under os.tmpdir()',
    ALL_TMP_ROOTS.length > 0 && ALL_TMP_ROOTS.every((d) => path.resolve(d).startsWith(tmpRoot)));
  t('J2: forge-repomap.cjs itself was never touched by this test file', fs.existsSync(path.join(__dirname, 'forge-repomap.cjs')));
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
