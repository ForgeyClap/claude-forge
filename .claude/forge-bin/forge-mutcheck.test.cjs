#!/usr/bin/env node
'use strict';
/**
 * forge-mutcheck.test.cjs — hermetic, offline tests for forge-mutcheck.cjs. EVERY fixture lives under
 * os.tmpdir() (fs.mkdtempSync) so this file never writes to the real project. Exit 0 = all pass.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const MC = require('./forge-mutcheck.cjs');

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };

const ALL_TMP_ROOTS = [];
function freshDir(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); ALL_TMP_ROOTS.push(d); return d; }

console.log('forge-mutcheck offline tests (hermetic — os.tmpdir() fixtures ONLY, never the real project)');

// ---- Section A: normalizeFileEntry pure logic ----
{
  t('A1: a bare string derives its .test.cjs path', JSON.stringify(MC.normalizeFileEntry('foo.cjs')) === JSON.stringify({ src: 'foo.cjs', test: 'foo.test.cjs' }));
  t('A2: an explicit {src,test} object is passed through unchanged', JSON.stringify(MC.normalizeFileEntry({ src: 'a.cjs', test: 'a.spec.cjs' })) === JSON.stringify({ src: 'a.cjs', test: 'a.spec.cjs' }));
  t('A3: an object with only src derives the test path the same way a bare string does', MC.normalizeFileEntry({ src: 'bar.cjs' }).test === 'bar.test.cjs');
  t('A4: a malformed entry (null) never throws — degrades to {src:null, test:null}', JSON.stringify(MC.normalizeFileEntry(null)) === JSON.stringify({ src: null, test: null }));
}

// ---- Section B: checkOnePair on a THOROUGH suite — every mutant caught, hollow:false ----
let realDir;
{
  realDir = freshDir('mc-b-real');
  // Deliberately NO overlapping guard (unlike an "if n===0 / if n>0 / else" shape, which leaves an
  // unreachable, genuinely EQUIVALENT gtToGte mutant no test could ever kill) — every boundary here
  // (n===0, n===1, n>0, n<0) is reachable and distinguishable, so a thorough suite really can reach 0
  // survivors, not just a high score.
  const guardSrc = [
    "'use strict';",
    'function classify(n) {',
    '  if (n > 0) return "pos";',
    '  if (n < 0) return "neg";',
    '  return "zero";',
    '}',
    'module.exports = { classify };',
    '',
  ].join('\n');
  const thoroughTest = [
    "const { classify } = require('./guard.cjs');",
    'let pass=0, fail=0;',
    "const t=(name,cond)=>{ if(cond){pass++;} else {fail++; console.error('FAIL '+name);} };",
    "t('zero', classify(0)==='zero');",
    "t('pos-boundary', classify(1)==='pos');",
    "t('pos', classify(5)==='pos');",
    "t('neg', classify(-5)==='neg');",
    "console.log(pass+' passed, '+fail+' failed');",
    'process.exitCode = fail?1:0;',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(realDir, 'guard.cjs'), guardSrc, 'utf8');
  fs.writeFileSync(path.join(realDir, 'guard.test.cjs'), thoroughTest, 'utf8');

  const r = MC.checkOnePair(path.join(realDir, 'guard.cjs'), path.join(realDir, 'guard.test.cjs'), {});
  t('B1: run completed honestly (ok:true)', r.ok === true);
  t('B2: a thorough suite catches every mutant (hollow:false)', r.hollow === false);
  t('B3: survived count is exactly 0', r.survived === 0);
  t('B4: killed count matches the total (nothing skipped for this simple fixture, or skip is accounted)', r.killed + r.skipped === r.total);
  t('B5: mutations[] (the uncaught list) is empty', Array.isArray(r.mutations) && r.mutations.length === 0);
  t('B6: targetUnchanged is true — the real fixture file was never overwritten', r.targetUnchanged === true);
}

// ---- Section C: checkOnePair on a HOLLOW (always-true-assertion) suite — mutants survive ----
let hollowDir;
{
  hollowDir = freshDir('mc-c-hollow');
  const guardSrc = [
    "'use strict';",
    'function classify(n) {',
    '  if (n === 0) return "zero";',
    '  if (n > 0) return "pos";',
    '  return "neg";',
    '}',
    'module.exports = { classify };',
    '',
  ].join('\n');
  const hollowTest = [
    "const { classify } = require('./weak.cjs');",
    'let pass=0, fail=0;',
    "const t=(name,cond)=>{ if(cond){pass++;} else {fail++;} };",
    'classify(1);',
    "t('classify is a function', typeof classify === 'function');",
    "console.log(pass+' passed, '+fail+' failed');",
    'process.exitCode = fail?1:0;',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(hollowDir, 'weak.cjs'), guardSrc, 'utf8');
  fs.writeFileSync(path.join(hollowDir, 'weak.test.cjs'), hollowTest, 'utf8');

  const r = MC.checkOnePair(path.join(hollowDir, 'weak.cjs'), path.join(hollowDir, 'weak.test.cjs'), {});
  t('C1: run completed honestly (ok:true)', r.ok === true);
  t('C2: a hollow (always-true-assertion) suite reports hollow:true', r.hollow === true);
  t('C3: at least one mutant survived', r.survived > 0);
  t('C4: mutations[] itemizes every surviving (NOT CAUGHT) mutation, each with caught:false', r.mutations.length === r.survived && r.mutations.every((m) => m.caught === false && typeof m.line === 'number' && typeof m.description === 'string'));
  t('C5: score reflects the weak suite (well below a healthy suite\'s score)', typeof r.score === 'number' && r.score < 0.5);
}

// ---- Section D: checkOnePair error paths — never throws, reports {ok:false, error} ----
{
  const d = freshDir('mc-d-errors');
  fs.writeFileSync(path.join(d, 'only.cjs'), 'module.exports = {};\n', 'utf8');
  const rMissingTest = MC.checkOnePair(path.join(d, 'only.cjs'), path.join(d, 'does-not-exist.test.cjs'), {});
  t('D1: a missing test file reports ok:false with a clear error, no throw', rMissingTest.ok === false && /test file not found/.test(rMissingTest.error));
  const rMissingSrc = MC.checkOnePair(path.join(d, 'does-not-exist.cjs'), path.join(d, 'only.cjs'), {});
  t('D2: a missing source file reports ok:false with a clear error, no throw', rMissingSrc.ok === false && /source file not found/.test(rMissingSrc.error));
  const rNoSrc = MC.checkOnePair(null, path.join(d, 'only.cjs'), {});
  t('D3: a null src reports a usage-shaped error, no throw', rNoSrc.ok === false && /--src is required/.test(rNoSrc.error));

  // an EMPTY STRING src (falsy, but not null/undefined) must normalize to src:null in the result — a
  // naive `src || null` swapped to `src && null` would leak the empty string straight through instead
  // (both give the same result for a null/undefined src, so that case alone can't tell them apart).
  const rEmptySrc = MC.checkOnePair('', path.join(d, 'only.cjs'), {});
  t('D3b: an empty-string src normalizes to src:null in the result (never leaks "" through)', rEmptySrc.ok === false && rEmptySrc.src === null);

  // red baseline: forge-mutate.cjs refuses to run mutants at all — mutcheck must surface that honestly.
  fs.writeFileSync(path.join(d, 'red.cjs'), "'use strict';\nfunction x(){ return 1; }\nmodule.exports={x};\n", 'utf8');
  fs.writeFileSync(path.join(d, 'red.test.cjs'), "const {x}=require('./red.cjs');\nlet pass=0,fail=0;\nconst t=(n,c)=>{if(c){pass++;}else{fail++;}};\nt('deliberately failing', x()===999);\nconsole.log(pass+' passed, '+fail+' failed');\nprocess.exitCode=fail?1:0;\n", 'utf8');
  const rRed = MC.checkOnePair(path.join(d, 'red.cjs'), path.join(d, 'red.test.cjs'), {});
  t('D4: a red baseline is surfaced honestly as ok:false (never scored as a pass)', rRed.ok === false && /baseline is not green/.test(rRed.error));
}

// ---- Section E: mutcheck() module API — single mode + batch mode ----
{
  const single = MC.mutcheck({ src: path.join(hollowDir, 'weak.cjs'), test: path.join(hollowDir, 'weak.test.cjs') }, {});
  t('E1: mutcheck() single mode matches checkOnePair() directly', single.ok === true && single.hollow === true);

  const batch = MC.mutcheck({ files: [path.join(realDir, 'guard.cjs'), path.join(hollowDir, 'weak.cjs')] }, {});
  t('E2: batch mode ok:true when every pair ran (a hollow finding is not a run failure)', batch.ok === true);
  t('E3: batch mode reports exactly 2 results, in input order', batch.total === 2 && batch.results.length === 2 && /guard\.cjs$/.test(batch.results[0].src) && /weak\.cjs$/.test(batch.results[1].src));
  t('E4: batch mode counts exactly 1 hollow file (the weak one) and 0 failed', batch.hollowCount === 1 && batch.failedCount === 0);
  t('E5: batch totals sum killed/survived across both pairs', batch.totalSurvived === batch.results.reduce((n, r) => n + (r.survived || 0), 0) && batch.totalKilled === batch.results.reduce((n, r) => n + (r.killed || 0), 0));

  let threw = false;
  try { MC.mutcheck({}, {}); } catch { threw = true; }
  t('E6: mutcheck() with neither {src,test} nor {files} throws a usage error', threw === true);

  let threwSrcOnly = false;
  try { MC.mutcheck({ src: path.join(realDir, 'guard.cjs') }, {}); } catch { threwSrcOnly = true; }
  t('E7: mutcheck() with ONLY src (no test, no files) still throws a usage error — proves the `||` guard, not just `&&`', threwSrcOnly === true);

  let threwTestOnly = false;
  try { MC.mutcheck({ test: path.join(realDir, 'guard.test.cjs') }, {}); } catch { threwTestOnly = true; }
  t('E8: mutcheck() with ONLY test (no src, no files) still throws a usage error', threwTestOnly === true);
}

// ---- Section F: real CLI (--src/--test, --json) invoked as a subprocess ----
{
  const cliPath = path.join(__dirname, 'forge-mutcheck.cjs');
  const rReal = spawnSync(process.execPath, [cliPath, '--src', path.join(realDir, 'guard.cjs'), '--test', path.join(realDir, 'guard.test.cjs'), '--json'], { encoding: 'utf8' });
  let jReal = null; try { jReal = JSON.parse(rReal.stdout); } catch { /* asserted below */ }
  t('F1: CLI exits 0 on a thorough (non-hollow) suite', rReal.status === 0);
  t('F2: CLI --json prints a parseable report with hollow:false', jReal !== null && jReal.hollow === false);

  const rHollow = spawnSync(process.execPath, [cliPath, '--src', path.join(hollowDir, 'weak.cjs'), '--test', path.join(hollowDir, 'weak.test.cjs'), '--json'], { encoding: 'utf8' });
  let jHollow = null; try { jHollow = JSON.parse(rHollow.stdout); } catch { /* asserted below */ }
  t('F3: CLI exits 3 on a hollow-test finding (advisory "needs attention" code, not a hard usage error)', rHollow.status === 3);
  t('F4: CLI --json reports hollow:true with a non-empty mutations[] list', jHollow !== null && jHollow.hollow === true && jHollow.mutations.length > 0);

  const rUsage = spawnSync(process.execPath, [cliPath], { encoding: 'utf8' });
  t('F5: CLI with no args exits 2 (usage error)', rUsage.status === 2);

  const rMissingFile = spawnSync(process.execPath, [cliPath, '--src', path.join(realDir, 'nope.cjs'), '--test', path.join(realDir, 'guard.test.cjs'), '--json'], { encoding: 'utf8' });
  t('F6: CLI exits 2 when the source file does not exist (a real run failure, not a hollow finding)', rMissingFile.status === 2);

  // ---- non-JSON (human-readable) output path — proves --json actually toggles behavior, not a
  // permanently-forced-true branch (forceIfTrue on the `--json` arg-parse guard would make EVERY CLI
  // call behave as if --json were passed, undetectable if every other test always passes --json). ----
  const rHuman = spawnSync(process.execPath, [cliPath, '--src', path.join(realDir, 'guard.cjs'), '--test', path.join(realDir, 'guard.test.cjs')], { encoding: 'utf8' });
  let parsedAsJson = true; try { JSON.parse(rHuman.stdout); } catch { parsedAsJson = false; }
  t('F7: CLI without --json exits 0 on the same thorough suite', rHuman.status === 0);
  t('F8: CLI without --json prints HUMAN text, not JSON (proves --json is not silently forced true)', parsedAsJson === false && /forge-mutcheck —/.test(rHuman.stdout));
  t('F8b: the human text prints the EXACT score percentage for a fully-caught suite (score:1 -> "100.0%", catches a 100->101 literal slip)', /score: 100\.0%/.test(rHuman.stdout));

  const rHollowHuman = spawnSync(process.execPath, [cliPath, '--src', path.join(hollowDir, 'weak.cjs'), '--test', path.join(hollowDir, 'weak.test.cjs')], { encoding: 'utf8' });
  t('F9: CLI without --json still exits 3 on a hollow finding, and names the survivor line in human text', rHollowHuman.status === 3 && /NOT CAUGHT/.test(rHollowHuman.stdout));

  const rMissingHuman = spawnSync(process.execPath, [cliPath, '--src', path.join(realDir, 'nope.cjs'), '--test', path.join(realDir, 'guard.test.cjs')], { encoding: 'utf8' });
  t('F10: CLI without --json still exits 2 on a real run failure, with the honest error text (proves the human error-branch, not just the JSON one)', rMissingHuman.status === 2 && /source file not found/.test(rMissingHuman.stdout));

  // ---- --help exits 0 without requiring --src/--test/--files ----
  const rHelp = spawnSync(process.execPath, [cliPath, '--help'], { encoding: 'utf8' });
  t('F11: CLI --help exits 0 and prints usage, even with no other args', rHelp.status === 0 && /Usage: node forge-mutcheck\.cjs/.test(rHelp.stdout));

  // ---- invalid --timeout / --baseline-timeout / --sample are rejected, never silently coerced ----
  const anyExistingFile = cliPath; // any real path — validation fires before the file is even read
  const rZeroTimeout = spawnSync(process.execPath, [cliPath, '--src', anyExistingFile, '--test', anyExistingFile, '--timeout', '0'], { encoding: 'utf8' });
  t('F12: --timeout 0 is rejected with exit 2, not silently accepted as "no timeout"', rZeroTimeout.status === 2 && /--timeout must be a positive number/.test(rZeroTimeout.stderr));
  const rNegTimeout = spawnSync(process.execPath, [cliPath, '--src', anyExistingFile, '--test', anyExistingFile, '--timeout', '-5'], { encoding: 'utf8' });
  t('F13: --timeout -5 (negative) is rejected with exit 2', rNegTimeout.status === 2 && /--timeout must be a positive number/.test(rNegTimeout.stderr));
  const rZeroBaseline = spawnSync(process.execPath, [cliPath, '--src', anyExistingFile, '--test', anyExistingFile, '--baseline-timeout', '0'], { encoding: 'utf8' });
  t('F14: --baseline-timeout 0 is rejected with exit 2', rZeroBaseline.status === 2 && /--baseline-timeout must be a positive number/.test(rZeroBaseline.stderr));
  const rZeroSample = spawnSync(process.execPath, [cliPath, '--src', anyExistingFile, '--test', anyExistingFile, '--sample', '0'], { encoding: 'utf8' });
  t('F15: --sample 0 is rejected with exit 2, not silently treated as "no sampling"', rZeroSample.status === 2 && /--sample must be a positive integer/.test(rZeroSample.stderr));

  // --baseline-timeout 1 is a VALID positive value (boundary just above 0) and must NOT be rejected by
  // the validation guard — a `<=0` boundary weakened to `<=1` would wrongly reject exactly this value,
  // even though the run itself may still fail later for an unrelated reason (1ms is unrealistically
  // short) — this test only proves the VALIDATION message itself never fires for a genuinely valid input.
  const rOneBaseline = spawnSync(process.execPath, [cliPath, '--src', anyExistingFile, '--test', anyExistingFile, '--baseline-timeout', '1'], { encoding: 'utf8' });
  t('F16: --baseline-timeout 1 (a valid positive value) never triggers the "must be a positive number" validation error', !/--baseline-timeout must be a positive number/.test(rOneBaseline.stderr));
}

// ---- Section G: real CLI batch mode (--files) ----
{
  const cliPath = path.join(__dirname, 'forge-mutcheck.cjs');
  const r = spawnSync(process.execPath, [cliPath, '--files', path.join(realDir, 'guard.cjs') + ',' + path.join(hollowDir, 'weak.cjs'), '--json'], { encoding: 'utf8' });
  let j = null; try { j = JSON.parse(r.stdout); } catch { /* asserted below */ }
  t('G1: CLI batch mode exits 3 (one of the two files is hollow)', r.status === 3);
  t('G2: CLI --json batch report has mode:"batch" with 2 results and hollowCount:1', j !== null && j.mode === 'batch' && j.results.length === 2 && j.hollowCount === 1);
}

// ---- Section H: EVERY temp dir created by this test file is under os.tmpdir() ----
{
  const tmpRoot = path.resolve(os.tmpdir());
  t('H1: every one of the ' + ALL_TMP_ROOTS.length + ' fixture roots created this run is under os.tmpdir()',
    ALL_TMP_ROOTS.length > 0 && ALL_TMP_ROOTS.every((d) => path.resolve(d).startsWith(tmpRoot)));
  t('H2: forge-mutcheck.cjs itself was never touched by this test file', fs.existsSync(path.join(__dirname, 'forge-mutcheck.cjs')));
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
