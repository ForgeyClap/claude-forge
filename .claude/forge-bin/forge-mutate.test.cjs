#!/usr/bin/env node
'use strict';
/**
 * forge-mutate.test.cjs — hermetic, offline tests for forge-mutate.cjs. EVERY fixture lives under
 * os.tmpdir() (fs.mkdtempSync) — this file NEVER writes to the real project. The real forge-mutate.cjs
 * source file is never mutated; only a byte-identical hash-before/after check plus a copied-tmp-dir
 * hermetic run prove that. Exit 0 = all pass.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const M = require('./forge-mutate.cjs');

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };

const ALL_TMP_ROOTS = []; // every dir created directly by THIS test file (section K proves these)
function freshDir(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); ALL_TMP_ROOTS.push(d); return d; }

console.log('forge-mutate offline tests (hermetic — os.tmpdir() fixtures ONLY, never the real project)');

// ---- Section A: buildMask + generateMutants pure-function correctness ----
{
  const src = [
    "'use strict';",
    "// this === that should not be mutated (comment)",
    "const s = 'x === y is not code either';",
    "const tpl = `also === not code`;",
    "const arrow = (a, b) => a > b;",
    "function f(a) { if (a === 1) { return true; } return false; }",
  ].join('\n');
  const ms = M.generateMutants(src);
  const eqStrictHits = ms.filter((m) => m.id === 'eqStrict');
  t('A1: exactly one real eqStrict mutant found (comment+string+template look-alikes excluded)', eqStrictHits.length === 1);
  t('A2: the one real eqStrict mutant is on the `if (a === 1)` line', eqStrictHits[0] && eqStrictHits[0].line === 6);
  t('A3: arrow function `=>` is never mistaken for a `>` comparator', !ms.some((m) => (m.id === 'gtToGte' || m.id === 'gtToLt') && src.slice(m.index - 1, m.index) === '='));
  t('A4: returnTrueToFalse mutant found', ms.some((m) => m.id === 'returnTrueToFalse'));
  t('A5: returnFalseToTrue mutant found', ms.some((m) => m.id === 'returnFalseToTrue'));
  t('A6: forceIfTrue/forceIfFalse/negateCondition all found for the one real if-guard', ['forceIfTrue', 'forceIfFalse', 'negateCondition'].every((id) => ms.some((m) => m.id === id)));
  t('A7: oneToZero mutant found for the numeric literal `1`', ms.some((m) => m.id === 'oneToZero'));
  t('A8: applyMutant() reproduces the expected mutated text', M.applyMutant(src, eqStrictHits[0]) === src.slice(0, eqStrictHits[0].index) + '!==' + src.slice(eqStrictHits[0].index + 3));
}
{
  const src2 = [
    "const out = str.replace(re, 'REDACTED');",
    "const n = arr.length;",
    "const ok = x >= 5 && x <= 10 || x === 0;",
  ].join('\n');
  const ms2 = M.generateMutants(src2);
  t('A9: emptyReplaceArg mutant empties the replacement text', ms2.some((m) => m.id === 'emptyReplaceArg' && m.replacement === ".replace(re, '')"));
  t('A10: andToOr and orToAnd both found', ms2.some((m) => m.id === 'andToOr') && ms2.some((m) => m.id === 'orToAnd'));
  t('A11: gteToGt and lteToLt found (>= and <= present)', ms2.some((m) => m.id === 'gteToGt') && ms2.some((m) => m.id === 'lteToLt'));
  t('A12: numPlusOne mutates 5->6 and 10->11', ms2.some((m) => m.id === 'numPlusOne' && m.replacement === '6') && ms2.some((m) => m.id === 'numPlusOne' && m.replacement === '11'));
  t('A13: `.length` is never mistaken for a numeric literal', !ms2.some((m) => (m.id === 'zeroToOne' || m.id === 'oneToZero' || m.id === 'numPlusOne') && src2.slice(Math.max(0, m.index - 4), m.index).includes('length')));
}

// ---- Section B: deterministic seeded sampling (no Math.random) ----
{
  const src = fs.readFileSync(path.join(__dirname, 'forge-mutate.cjs'), 'utf8');
  const ms = M.generateMutants(src);
  t('B1: sample size is honored', M.sampleMutants(ms, 5, 'seedA').length === 5);
  const a1 = M.sampleMutants(ms, 5, 'seedA');
  const a2 = M.sampleMutants(ms, 5, 'seedA');
  const b1 = M.sampleMutants(ms, 5, 'seedB');
  t('B2: same seed -> identical sample (reproducible)', JSON.stringify(a1) === JSON.stringify(a2));
  t('B3: different seed -> a different sample (not hardcoded/no-op)', JSON.stringify(a1) !== JSON.stringify(b1));
  t('B4: sampled mutants are returned in source order (index ascending)', a1.every((m, i) => i === 0 || a1[i - 1].index <= m.index));
}

// ---- Section C: prepareWorkdir / commonAncestorDir isolation (os.tmpdir()-only) ----
{
  const srcDir = freshDir('fm-c-src');
  const guardCjs = "'use strict';\nfunction isPositive(n) { return n > 0; }\nmodule.exports = { isPositive };\n";
  const guardTest = "const { isPositive } = require('./guard.cjs');\nlet pass=0, fail=0;\nconst t=(n,c)=>{ if(c){pass++;} else {fail++;} };\nt('p5', isPositive(5)===true);\nt('pm1', isPositive(-1)===false);\nconsole.log(pass+' passed, '+fail+' failed');\nprocess.exitCode = fail?1:0;\n";
  fs.writeFileSync(path.join(srcDir, 'guard.cjs'), guardCjs, 'utf8');
  fs.writeFileSync(path.join(srcDir, 'guard.test.cjs'), guardTest, 'utf8');

  const commonRoot = M.commonAncestorDir(path.join(srcDir, 'a', 'f1.txt'), path.join(srcDir, 'b', 'f2.txt'));
  t('C1: commonAncestorDir finds the real shared parent directory', path.resolve(commonRoot) === path.resolve(srcDir));

  const work = M.prepareWorkdir(path.join(srcDir, 'guard.cjs'), path.join(srcDir, 'guard.test.cjs'));
  ALL_TMP_ROOTS.push(work.tempRoot);
  t('C2: prepareWorkdir tempRoot is rooted under os.tmpdir()', path.resolve(work.tempRoot).startsWith(path.resolve(os.tmpdir())));
  t('C3: copied target + test files exist in the workdir', fs.existsSync(work.copiedTargetPath) && fs.existsSync(work.copiedTestPath));
  t('C4: copied target file content matches the original byte-for-byte', fs.readFileSync(work.copiedTargetPath, 'utf8') === guardCjs);
  t('C5: the REAL source file in srcDir is completely untouched', fs.readFileSync(path.join(srcDir, 'guard.cjs'), 'utf8') === guardCjs);
  try { fs.rmSync(work.tempRoot, { recursive: true, force: true }); } catch { /* best-effort tidy-up */ }
}

// ---- Section D: checkParses ----
{
  const d = freshDir('fm-d-parse');
  fs.writeFileSync(path.join(d, 'valid.cjs'), 'module.exports = 1;\n', 'utf8');
  fs.writeFileSync(path.join(d, 'invalid.cjs'), ')))this is not valid js(((\n', 'utf8');
  t('D1: checkParses(valid file) === true', M.checkParses(path.join(d, 'valid.cjs')) === true);
  t('D2: checkParses(syntactically-broken file) === false', M.checkParses(path.join(d, 'invalid.cjs')) === false);
}

// ---- Section E: runSuite classification (green / red / REAL timeout) ----
{
  const d = freshDir('fm-e-suite');
  fs.writeFileSync(path.join(d, 'green.test.cjs'), "console.log('1 passed, 0 failed');\nprocess.exitCode = 0;\n", 'utf8');
  fs.writeFileSync(path.join(d, 'red.test.cjs'), "console.log('0 passed, 1 failed');\nprocess.exitCode = 1;\n", 'utf8');
  fs.writeFileSync(path.join(d, 'busyloop.test.cjs'), 'for (;;) {}\n', 'utf8');
  const rGreen = M.runSuite(path.join(d, 'green.test.cjs'), {});
  const rRed = M.runSuite(path.join(d, 'red.test.cjs'), {});
  const rTimeout = M.runSuite(path.join(d, 'busyloop.test.cjs'), { timeoutMs: 500 });
  t('E1: a green suite is classified ok=true', rGreen.ok === true && rGreen.tally && rGreen.tally.passed === 1 && rGreen.tally.failed === 0);
  t('E2: a red (exit!=0) suite is classified ok=false, not timed out', rRed.ok === false && rRed.timedOut === false);
  t('E3: a REAL spawnSync timeout is classified timedOut=true (not a plain failure)', rTimeout.timedOut === true && rTimeout.ok === false);
  t('E4: the timed-out suite carries the SIGTERM kill signal', rTimeout.signal === 'SIGTERM');
}

// ---- Section F: end-to-end — a thorough suite kills far more mutants than a weak one ----
let strongReport, weakReport;
{
  const d = freshDir('fm-f-e2e');
  const combinedSrc = [
    "'use strict';",
    'function add(a, b) {',
    '  if (a === 0) return b;',
    '  if (b === 0) return a;',
    '  return a + b;',
    '}',
    'function classify(a, b) {',
    "  if (a === 0) return 'zero-a';",
    "  if (b === 0) return 'zero-b';",
    "  if (a > b) return 'a-bigger';",
    "  return 'not-bigger';",
    '}',
    'module.exports = { add, classify };',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(d, 'add.cjs'), combinedSrc, 'utf8');
  const strongTest = [
    "const { add, classify } = require('./add.cjs');",
    'let pass=0, fail=0;',
    "const t=(name,cond)=>{ if(cond){pass++;} else {fail++; console.error('FAIL '+name);} };",
    "t('add(0,5)=5', add(0,5)===5);",
    "t('add(5,0)=5', add(5,0)===5);",
    "t('add(2,3)=5', add(2,3)===5);",
    "t('add(-1,-1)=-2', add(-1,-1)===-2);",
    "t('add(0,0)=0', add(0,0)===0);",
    "t('classify a0', classify(0,5)==='zero-a');",
    "t('classify b0', classify(5,0)==='zero-b');",
    "t('classify agtb', classify(10,3)==='a-bigger');",
    "t('classify altb', classify(3,10)==='not-bigger');",
    "t('classify aeqb', classify(5,5)==='not-bigger');",
    "console.log(pass+' passed, '+fail+' failed');",
    'process.exitCode = fail?1:0;',
    '',
  ].join('\n');
  const weakTest = [
    "const { add, classify } = require('./add.cjs');",
    'let pass=0, fail=0;',
    "const t=(name,cond)=>{ if(cond){pass++;} else {fail++;} };",
    'add(1, 2); classify(1, 2);',
    "t('add is a function', typeof add === 'function');",
    "t('classify is a function', typeof classify === 'function');",
    "console.log(pass+' passed, '+fail+' failed');",
    'process.exitCode = fail?1:0;',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(d, 'add.test.cjs'), strongTest, 'utf8');
  fs.writeFileSync(path.join(d, 'add.weak.test.cjs'), weakTest, 'utf8');

  strongReport = M.runMutationTesting(path.join(d, 'add.cjs'), path.join(d, 'add.test.cjs'), {});
  weakReport = M.runMutationTesting(path.join(d, 'add.cjs'), path.join(d, 'add.weak.test.cjs'), {});

  t('F1: both baselines are green (a healthy suite is a precondition, not a result)', strongReport.baseline.ok === true && weakReport.baseline.ok === true);
  t('F2: same source -> identical mutant count regardless of which suite runs it', strongReport.fullTotal === weakReport.fullTotal && strongReport.fullTotal > 0);
  t('F3: the THOROUGH suite kills the large majority of mutants (high score)', strongReport.score >= 0.7);
  t('F4: the WEAK (always-true-assertion) suite lets every mutant survive (score 0)', weakReport.score === 0);
  t('F5: the thorough suite scores strictly higher than the weak one', strongReport.score > weakReport.score);
  t('F6: survivor entries carry line + description evidence', weakReport.survivors.every((s) => typeof s.line === 'number' && typeof s.description === 'string'));
}

// ---- Section G: a non-parsing mutant is SKIPPED, never counted as killed or survived ----
{
  const d = freshDir('fm-g-skip');
  const guardCjs = "'use strict';\nfunction isPositive(n) { return n > 0; }\nmodule.exports = { isPositive };\n";
  const guardTest = "const { isPositive } = require('./guard.cjs');\nlet pass=0, fail=0;\nconst t=(n,c)=>{ if(c){pass++;} else {fail++;} };\nt('p5', isPositive(5)===true);\nt('pm1', isPositive(-1)===false);\nconsole.log(pass+' passed, '+fail+' failed');\nprocess.exitCode = fail?1:0;\n";
  fs.writeFileSync(path.join(d, 'guard.cjs'), guardCjs, 'utf8');
  fs.writeFileSync(path.join(d, 'guard.test.cjs'), guardTest, 'utf8');
  const realMutants = M.generateMutants(guardCjs).slice(0, 2);
  t('G0: setup sanity — at least 2 real mutants exist to mix in', realMutants.length === 2);
  // TEST-ONLY injected mutant: prepending garbage tokens is deliberately NOT valid JS (proven above in D2's
  // shape) — this exercises the real `node --check` skip gate, not a mocked result.
  const brokenMutant = { id: 'test-injected-break', description: 'test-only: deliberately invalid syntax', line: 1, index: 0, length: 0, original: '', replacement: ')))this is not valid js(((' };
  const rep = M.runMutationTesting(path.join(d, 'guard.cjs'), path.join(d, 'guard.test.cjs'), { mutantsOverride: [brokenMutant, ...realMutants] });
  t('G1: run completed honestly (baseline was green)', rep.ok === true);
  t('G2: total mutants = 3 (1 injected-broken + 2 real)', rep.total === 3);
  t('G3: exactly 1 mutant was skipped (non-parsing)', rep.skipped === 1);
  t('G4: the skipped entry is the injected-broken one', rep.skippedList.length === 1 && rep.skippedList[0].id === 'test-injected-break');
  t('G5: killed + survived + skipped === total (skip never silently dropped OR double-counted)', rep.killed + rep.survived + rep.skipped === rep.total);
  t('G6: the broken mutant never appears in the survivors list', !rep.survivors.some((s) => s.id === 'test-injected-break'));
}

// ---- Section H: an already-red baseline is an HONEST refusal, zero mutants run ----
{
  const d = freshDir('fm-h-redbaseline');
  fs.writeFileSync(path.join(d, 'red.cjs'), "'use strict';\nfunction x() { return 1; }\nmodule.exports = { x };\n", 'utf8');
  fs.writeFileSync(path.join(d, 'red.test.cjs'), "const { x } = require('./red.cjs');\nlet pass=0, fail=0;\nconst t=(n,c)=>{ if(c){pass++;} else {fail++;} };\nt('deliberately failing', x() === 999);\nconsole.log(pass+' passed, '+fail+' failed');\nprocess.exitCode = fail?1:0;\n", 'utf8');
  const rep = M.runMutationTesting(path.join(d, 'red.cjs'), path.join(d, 'red.test.cjs'), {});
  t('H1: an already-red baseline is reported ok=false', rep.ok === false);
  t('H2: the error names the red baseline honestly', /baseline is not green/.test(rep.error));
  t('H3: NO mutant tally exists at all (proves the loop never started)', rep.total === undefined && rep.killed === undefined && rep.survived === undefined);
}

// ---- Section I: the real target file is byte-identical before/after (never overwritten) ----
{
  const d = freshDir('fm-i-untouched');
  const src = "'use strict';\nfunction isPositive(n) { return n > 0; }\nmodule.exports = { isPositive };\n";
  const testSrc = "const { isPositive } = require('./g.cjs');\nlet pass=0, fail=0;\nconst t=(n,c)=>{ if(c){pass++;} else {fail++;} };\nt('p5', isPositive(5)===true);\nconsole.log(pass+' passed, '+fail+' failed');\nprocess.exitCode = fail?1:0;\n";
  fs.writeFileSync(path.join(d, 'g.cjs'), src, 'utf8');
  fs.writeFileSync(path.join(d, 'g.test.cjs'), testSrc, 'utf8');
  const beforeHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(d, 'g.cjs'))).digest('hex');
  const rep = M.runMutationTesting(path.join(d, 'g.cjs'), path.join(d, 'g.test.cjs'), {});
  const afterHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(d, 'g.cjs'))).digest('hex');
  t('I1: the run reports targetUnchanged=true', rep.targetUnchanged === true);
  t('I2: sha256(target) before === after — real proof, not just the self-reported flag', beforeHash === afterHash);
  t('I3: raw bytes are identical too', fs.readFileSync(path.join(d, 'g.cjs'), 'utf8') === src);
  t('I4: the run also confirms its own workdir was under os.tmpdir()', rep.workdirUnderTmp === true);
}

// ---- Section J: real CLI (--json, --sample, --seed) invoked as a subprocess, reproducibly ----
{
  const d = freshDir('fm-j-cli');
  const combinedSrc = [
    "'use strict';",
    'function add(a, b) {',
    '  if (a === 0) return b;',
    '  if (b === 0) return a;',
    '  return a + b;',
    '}',
    'module.exports = { add };',
    '',
  ].join('\n');
  const testSrc = [
    "const { add } = require('./add.cjs');",
    'let pass=0, fail=0;',
    "const t=(name,cond)=>{ if(cond){pass++;} else {fail++;} };",
    "t('add(2,3)=5', add(2,3)===5);",
    "console.log(pass+' passed, '+fail+' failed');",
    'process.exitCode = fail?1:0;',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(d, 'add.cjs'), combinedSrc, 'utf8');
  fs.writeFileSync(path.join(d, 'add.test.cjs'), testSrc, 'utf8');
  const cliPath = path.join(__dirname, 'forge-mutate.cjs');
  const run = () => spawnSync(process.execPath, [cliPath, path.join(d, 'add.cjs'), '--test', path.join(d, 'add.test.cjs'), '--json', '--sample', '4', '--seed', 'cli-seed-1'], { encoding: 'utf8' });
  const r1 = run();
  const r2 = run();
  let j1 = null, j2 = null;
  try { j1 = JSON.parse(r1.stdout); } catch { /* leave null, assertion below reports it */ }
  try { j2 = JSON.parse(r2.stdout); } catch { /* leave null, assertion below reports it */ }
  t('J1: CLI exits 0 on a completed run', r1.status === 0);
  t('J2: CLI --json prints exactly one parseable JSON report', j1 !== null);
  t('J3: --sample 4 is honored (total<=4, fullTotal is the real unbounded count)', j1 && j1.total <= 4 && j1.fullTotal >= j1.total);
  t('J4: --seed makes two separate CLI invocations produce an IDENTICAL report', JSON.stringify(j1) === JSON.stringify(j2));
  t('J5: CLI usage error (no target) exits non-zero', spawnSync(process.execPath, [cliPath], { encoding: 'utf8' }).status === 1);
}

// ---- Section K: EVERY temp dir this test file created is under os.tmpdir() (no exceptions) ----
{
  const tmpRoot = path.resolve(os.tmpdir());
  t('K1: every one of the ' + ALL_TMP_ROOTS.length + ' fixture/workdir roots created this run is under os.tmpdir()',
    ALL_TMP_ROOTS.length > 0 && ALL_TMP_ROOTS.every((d) => path.resolve(d).startsWith(tmpRoot)));
  t('K2: forge-mutate.cjs itself was never touched by this test file', fs.existsSync(path.join(__dirname, 'forge-mutate.cjs')));
}

// ---- Section L: mutator isolation mirrors the ".claude/" layout (forge-bin + sibling dirs), so a
// test that reaches a SIBLING directory via `path.join(__dirname, '..', 'other-dir', ...)` (exactly
// the shape of the real forge-report.test.cjs / forge-distill.test.cjs -> ../forge-dashboard/
// log-event.cjs dependency) gets a green baseline instead of a false "baseline is not green" refusal
// (WP3 Spoor C isolation fix, 2026-07-14) ----
{
  const tmpRoot2 = freshDir('fm-l-claude-layout');
  const claudeDir = path.join(tmpRoot2, '.claude');
  const binDir = path.join(claudeDir, 'forge-bin');
  const otherDir = path.join(claudeDir, 'other-dir');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(otherDir, { recursive: true });
  fs.writeFileSync(path.join(otherDir, 'helper.cjs'), "'use strict';\nmodule.exports = { greet: (n) => 'hello ' + n };\n", 'utf8');
  fs.writeFileSync(path.join(binDir, 'mymodule.cjs'), "'use strict';\nfunction isPositive(n) { return n > 0; }\nmodule.exports = { isPositive };\n", 'utf8');
  const testSrc = [
    "const path = require('path');",
    "const { greet } = require(path.join(__dirname, '..', 'other-dir', 'helper.cjs'));", // sibling-dir require: crashes with MODULE_NOT_FOUND if only forge-bin/ is mirrored
    "const { isPositive } = require('./mymodule.cjs');",
    'let pass=0, fail=0;',
    "const t=(n,c)=>{ if(c){pass++;} else {fail++;} };",
    "t('sibling helper reachable', greet('x') === 'hello x');",
    "t('isPositive works', isPositive(5) === true);",
    "console.log(pass+' passed, '+fail+' failed');",
    'process.exitCode = fail?1:0;',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(binDir, 'mymodule.test.cjs'), testSrc, 'utf8');

  t('L1: findClaudeAncestor finds the ".claude" folder from a nested forge-bin dir', M.findClaudeAncestor(binDir) === path.resolve(claudeDir));
  t('L2: findClaudeAncestor returns null when no ".claude" ancestor exists at all', M.findClaudeAncestor(os.tmpdir()) === null);

  const work = M.prepareWorkdir(path.join(binDir, 'mymodule.cjs'), path.join(binDir, 'mymodule.test.cjs'));
  ALL_TMP_ROOTS.push(work.tempRoot);
  t('L3: prepareWorkdir mirrors the sibling "other-dir" alongside forge-bin (not just forge-bin alone)', fs.existsSync(path.join(work.tempRoot, 'other-dir', 'helper.cjs')));
  try { fs.rmSync(work.tempRoot, { recursive: true, force: true }); } catch { /* best-effort tidy-up */ }

  const rep = M.runMutationTesting(path.join(binDir, 'mymodule.cjs'), path.join(binDir, 'mymodule.test.cjs'), {});
  t('L4: mutator baseline is green (the sibling-dir-requiring test does NOT crash with MODULE_NOT_FOUND)', rep.baseline && rep.baseline.ok === true);
  t('L5: run completed honestly, not a false "baseline is not green" refusal', rep.ok === true);
  t('L6: real mutants were generated and scored (not stuck at 0 because of a pre-loop crash)', rep.fullTotal > 0 && typeof rep.score === 'number');
}

// ---- Section M: --timeout / --baseline-timeout CLI flags (FIX2, 2026-07-14) ----
// The bug this fixes: forge-mutate had NO way to raise the (hardcoded 20000ms) baseline/per-mutant
// timeout, so a genuinely slow-but-HEALTHY suite (e.g. forge-chaos.test.cjs, which legitimately takes
// ~27s) got misreported as "baseline is not green" — a TIMEOUT, not a real red baseline, silently made
// the whole mutation score unmeasurable. Proven here with small, fast, deterministic numbers (a real
// ~300ms busy-loop fixture) rather than waiting on the real 20s/27s values — the underlying mechanism is
// identical regardless of scale (see runSuite()'s existing timedOut classification, reused unchanged).
{
  console.log('\nM) --timeout / --baseline-timeout CLI flags (FIX2)');
  t('M1: resolveTimeouts() is exported for direct unit testing', typeof M.resolveTimeouts === 'function');
}

// M4: resolveTimeouts() — the pure function that turns parsed CLI opts into {baselineTimeoutMs, mutantTimeoutMs}
{
  const none = M.resolveTimeouts({ timeout: null, baselineTimeout: null });
  t('M4a: neither flag given -> both timeouts undefined (falls through to runSuite()\'s own 20000ms default)', none.baselineTimeoutMs === undefined && none.mutantTimeoutMs === undefined);

  const onlyTimeout = M.resolveTimeouts({ timeout: 5000, baselineTimeout: null });
  t('M4b: --timeout alone raises BOTH baseline and per-mutant timeout to the same value', onlyTimeout.baselineTimeoutMs === 5000 && onlyTimeout.mutantTimeoutMs === 5000);

  const onlyBaseline = M.resolveTimeouts({ timeout: null, baselineTimeout: 9000 });
  t('M4c: --baseline-timeout alone raises ONLY the baseline (per-mutant timeout stays undefined/default)', onlyBaseline.baselineTimeoutMs === 9000 && onlyBaseline.mutantTimeoutMs === undefined);

  const both = M.resolveTimeouts({ timeout: 5000, baselineTimeout: 9000 });
  t('M4d: both given -> --baseline-timeout OVERRIDES --timeout for the baseline specifically', both.baselineTimeoutMs === 9000);
  t('M4e: both given -> --timeout still governs the per-mutant timeout', both.mutantTimeoutMs === 5000);
}

// M5: end-to-end via runMutationTesting() opts — a genuinely slow-but-HEALTHY ~300ms fixture suite is
// misreported as "not green" against a too-short timeout, and gets a real score once the timeout is raised.
let slowFixtureDir;
{
  slowFixtureDir = freshDir('fm-m-slow');
  const cjsSrc = "'use strict';\nfunction isPositive(n) { return n > 0; }\nmodule.exports = { isPositive };\n";
  // a REAL, deterministic ~300ms wall-clock cost via a bounded busy-loop (same proven-reliable shape as
  // Section E's busyloop.test.cjs — a real spawnSync timeout genuinely SIGTERMs a synchronous busy loop).
  const testSrc = [
    "const { isPositive } = require('./slow.cjs');",
    "const start = Date.now(); while (Date.now() - start < 300) { /* deliberate ~300ms busy-wait */ }",
    'let pass=0, fail=0;',
    "const t=(n,c)=>{ if(c){pass++;} else {fail++;} };",
    "t('p5', isPositive(5)===true);",
    "t('pm1', isPositive(-1)===false);",
    "console.log(pass+' passed, '+fail+' failed');",
    'process.exitCode = fail?1:0;',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(slowFixtureDir, 'slow.cjs'), cjsSrc, 'utf8');
  fs.writeFileSync(path.join(slowFixtureDir, 'slow.test.cjs'), testSrc, 'utf8');

  const tooShort = M.runMutationTesting(path.join(slowFixtureDir, 'slow.cjs'), path.join(slowFixtureDir, 'slow.test.cjs'), { baselineTimeoutMs: 100 });
  t('M5a: WITHOUT enough timeout, a genuinely healthy but slow (~300ms) baseline is reported "not green"', tooShort.ok === false && /baseline is not green/.test(tooShort.error));
  t('M5b: the refusal is honestly a TIMEOUT, not a real assertion failure', !!tooShort.baseline && tooShort.baseline.timedOut === true);
  t('M5c: the report names the exact timeout ceiling that was in effect (evidence, not a guess)', !!tooShort.timeouts && tooShort.timeouts.baselineTimeoutMs === 100);
  const summaryTooShort = M.printSummary(tooShort);
  t('M5d: printSummary() surfaces the timeout ceiling + a "raise --baseline-timeout" hint on this exact refusal', /TIMED OUT at 100ms/.test(summaryTooShort) && /--baseline-timeout/.test(summaryTooShort));

  const longEnough = M.runMutationTesting(path.join(slowFixtureDir, 'slow.cjs'), path.join(slowFixtureDir, 'slow.test.cjs'), { baselineTimeoutMs: 5000 });
  t('M5e: WITH a high-enough --baseline-timeout, the SAME slow suite gets a real, honest baseline+score', longEnough.ok === true && longEnough.baseline.ok === true && typeof longEnough.score === 'number');
  t('M5f: the real score run also records which timeout ceiling was actually used', !!longEnough.timeouts && longEnough.timeouts.baselineTimeoutMs === 5000);
}

// M6: the SAME proof again, but through the REAL CLI subprocess with the REAL --timeout/--baseline-timeout
// flags (not just the internal opts) — this is the actual new code path FIX2 adds.
{
  const cliPath = path.join(__dirname, 'forge-mutate.cjs');
  const cjsArg = path.join(slowFixtureDir, 'slow.cjs');
  const testArg = path.join(slowFixtureDir, 'slow.test.cjs');

  const rShort = spawnSync(process.execPath, [cliPath, cjsArg, '--test', testArg, '--json', '--baseline-timeout', '100'], { encoding: 'utf8' });
  let jShort = null; try { jShort = JSON.parse(rShort.stdout); } catch { /* asserted below */ }
  t('M6a: CLI exits 1 when --baseline-timeout is too short for a genuinely slow (but healthy) suite', rShort.status === 1);
  t('M6b: CLI --json still reports WHY: baseline not green due to a timeout, not a real failure', !!jShort && jShort.ok === false && !!jShort.baseline && jShort.baseline.timedOut === true);

  const rLong = spawnSync(process.execPath, [cliPath, cjsArg, '--test', testArg, '--json', '--baseline-timeout', '5000'], { encoding: 'utf8' });
  let jLong = null; try { jLong = JSON.parse(rLong.stdout); } catch { /* asserted below */ }
  t('M6c: CLI exits 0 once --baseline-timeout is raised high enough for the same slow suite', rLong.status === 0);
  t('M6d: CLI --json now reports a REAL score instead of "baseline is not green"', !!jLong && jLong.ok === true && typeof jLong.score === 'number');

  // M6e/M6f: --timeout (not just --baseline-timeout) also covers the baseline, since it raises both.
  const rTimeoutFlag = spawnSync(process.execPath, [cliPath, cjsArg, '--test', testArg, '--json', '--timeout', '5000'], { encoding: 'utf8' });
  let jTimeoutFlag = null; try { jTimeoutFlag = JSON.parse(rTimeoutFlag.stdout); } catch { /* asserted below */ }
  t('M6e: CLI exits 0 with plain --timeout <ms> alone (no --baseline-timeout needed) on the same slow suite', rTimeoutFlag.status === 0);
  t('M6f: --timeout alone produces a real score too (proves it covers the baseline, not just per-mutant)', !!jTimeoutFlag && jTimeoutFlag.ok === true && typeof jTimeoutFlag.score === 'number');
}

// M7: negative/invalid --timeout / --baseline-timeout values are rejected with a clear usage error (exit 1),
// mirroring the existing --sample validation pattern — never silently coerced or ignored.
{
  const cliPath = path.join(__dirname, 'forge-mutate.cjs');
  const anyExistingCjs = path.join(__dirname, 'forge-mutate.cjs'); // any real file path is fine — validation fires before the file is even read
  const rNegTimeout = spawnSync(process.execPath, [cliPath, anyExistingCjs, '--timeout', '-5'], { encoding: 'utf8' });
  t('M7a: --timeout -5 (negative) is rejected with exit 1, not silently accepted', rNegTimeout.status === 1 && /--timeout must be a positive number/.test(rNegTimeout.stderr));
  const rZeroTimeout = spawnSync(process.execPath, [cliPath, anyExistingCjs, '--timeout', '0'], { encoding: 'utf8' });
  t('M7b: --timeout 0 is rejected (must be a positive number, not zero)', rZeroTimeout.status === 1);
  const rNaNBaseline = spawnSync(process.execPath, [cliPath, anyExistingCjs, '--baseline-timeout', 'not-a-number'], { encoding: 'utf8' });
  t('M7c: a non-numeric --baseline-timeout is rejected with exit 1, not coerced to NaN and silently passed through', rNaNBaseline.status === 1 && /--baseline-timeout must be a positive number/.test(rNaNBaseline.stderr));
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
