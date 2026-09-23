#!/usr/bin/env node
'use strict';
/**
 * Hermetic tests for forge-integrate.cjs — the honesty-critical INTEGRATION GATE that turns a
 * "green" build/test claim from ASSERTED into OBSERVED (WP3 Spoor B, run forge-2026-07-14-wp3-mutation).
 *
 * Every fixture below is a REAL, tiny, disposable Node project written under os.tmpdir() with a real
 * package.json + real npm scripts (`node -e "process.exit(N)"`, or a script that prints its own
 * pass/fail tally). forge-integrate.cjs is exercised as a genuine CLI subprocess (spawnSync) against
 * these fixtures only. This file NEVER points the CLI at the real project or any of the 12 tracked
 * projects. Every fixture passes --in-place (the git-worktree hermetic branch is skipped entirely —
 * plain temp dirs are never git repos here anyway, so this keeps every invocation fast and free of
 * any git side effects) plus --no-install wherever the invariant under test has nothing to do with
 * the install step itself.
 *
 * HONEST GAPS (named, not silently skipped):
 *  - GROUP J (2026-08-06, broad Codex audit #26) NOW exercises the hermetic worktree branch with a
 *    real throwaway git repo: the old claim here — that worktree vs in-place "only changes WHERE
 *    commands run, never whether pass/fail is parsed" — was FALSE. A worktree of bare HEAD contains
 *    neither uncommitted changes nor untracked files, so the gate judged the OLD code: a broken
 *    uncommitted change sailed through as pass (J1) and a green uncommitted fix could false-BLOCK
 *    (J2). The worktree now snapshots the real working tree (stash create + untracked copy).
 *  - The --run quality_gate_passed / quality_gate_blocked log-event.cjs mirroring is not exercised
 *    (no log-event.cjs fixture is planted next to these package.json fixtures) — that contract is
 *    already covered by log-event.cjs's own hermetic tests and forge-evals.test.cjs's gate_evaluated
 *    pattern. This suite instead asserts directly on the artifact file the gate itself writes
 *    (integration-gate.json), which is the thing unique to forge-integrate.cjs.
 *  - Install-step invariants are exercised with ONE real, fully offline failure fixture (B4: `npm ci`
 *    against a deliberately out-of-sync package-lock.json, which fails locally with EUSAGE — probed
 *    directly beforehand and confirmed to need zero network and to complete in well under a second).
 *    A realistic `npm install` pulling real third-party dependencies is NOT exercised (would need
 *    real network access to the npm registry, which this suite deliberately avoids).
 *
 * Exit 0 = all pass.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, 'forge-integrate.cjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-integrate-test-'));

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };

console.log('forge-integrate offline tests (hermetic tmp=' + TMP + ')');

let caseN = 0;
function caseDir() { const d = path.join(TMP, 'case' + (++caseN)); fs.mkdirSync(d, { recursive: true }); return d; }
function writePkg(dir, obj) { fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(obj, null, 2)); }
function runCli(args) { return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }); }
function runJson(args) { const r = runCli(args); let j = null; try { j = JSON.parse(r.stdout); } catch { /* left null; asserted below */ } return { r, j }; }

// ===================================================================================
// GROUP A — SKIP invariants: an unsupported/missing project must NEVER be a fake PASS
// ===================================================================================
{
  const missingDir = path.join(TMP, 'does-not-exist-' + Date.now());
  const { r, j } = runJson([missingDir, '--json']);
  t('A1 missing project dir: exit 2 (SKIP), never a pass', r.status === 2);
  t('A1 missing project dir: verdict is skip, not pass', !!j && j.verdict === 'skip');
  t('A1 missing project dir: reason names it honestly', !!j && /project dir not found/.test(j.reason));

  const noPkg = caseDir(); // an otherwise-empty dir: no package.json at all -> unsupported stack
  const { r: r2, j: j2 } = runJson([noPkg, '--json', '--in-place']);
  t('A2 no package.json (unsupported stack): exit 2 (SKIP), never a pass', r2.status === 2);
  t('A2 no package.json: verdict is skip, not pass', !!j2 && j2.verdict === 'skip');
  t('A2 no package.json: reason honestly names the unsupported stack (not a fake pass)', !!j2 && /no package\.json/.test(j2.reason));

  // A3: the SKIP path must never fabricate a gate artifact, even when --run is supplied
  const runId = 'wp3-skip-run';
  runCli([noPkg, '--json', '--in-place', '--run', runId]);
  const artPath = path.join(noPkg, '.claude', 'forge-runs', runId, 'artifacts', 'integration-gate.json');
  t('A3 SKIP path never writes an integration-gate.json artifact', !fs.existsSync(artPath));
}

// ===================================================================================
// GROUP B — BLOCKED invariants: a failing project must NEVER be reported PASSED, and the
// gate must not blindly trust a bare process exit code either.
// ===================================================================================
{
  // B1: the test command itself exits non-zero -> BLOCKED
  const d1 = caseDir();
  writePkg(d1, { name: 'b1', version: '1.0.0', scripts: { test: 'node -e "process.exit(1)"' } });
  const { r: r1, j: j1 } = runJson([d1, '--json', '--in-place', '--no-install']);
  t('B1 failing test command: exit 1 (BLOCKED), never passed', r1.status === 1);
  t('B1 failing test command: verdict is blocked', !!j1 && j1.verdict === 'blocked');
  t('B1 failing test command: reason mentions tests failed', !!j1 && /tests failed/.test(j1.reason));
  const testStep1 = j1 && j1.steps.find((s) => s.label === 'test');
  t('B1 the real nonzero exit code is carried in steps[test]', !!testStep1 && testStep1.exit_code === 1);

  // B2: the test PROCESS exits 0, but its own printed tally reports a failure -> the gate must
  // still BLOCK. This proves it parses the real output instead of trusting a bare exit code.
  const d2 = caseDir();
  writePkg(d2, { name: 'b2', version: '1.0.0', scripts: {
    test: 'node -e "console.log(\'3 passed\'); console.log(\'1 failed\'); process.exit(0)"',
  } });
  const { r: r2, j: j2 } = runJson([d2, '--json', '--in-place', '--no-install']);
  t('B2 test process exits 0 but prints a failing tally: overall exit is 1 (BLOCKED)', r2.status === 1);
  t('B2 test process exits 0 but prints a failing tally: verdict is blocked, not pass', !!j2 && j2.verdict === 'blocked');
  t('B2 the parser sees exactly 1 failure and 3 passes from the real printed output', !!j2 && j2.testCounts.parseable === true && j2.testCounts.passed === 3 && j2.testCounts.failed === 1);
  const testStep2 = j2 && j2.steps.find((s) => s.label === 'test');
  t('B2 the underlying process exit code (0) is still recorded honestly even though the gate blocks', !!testStep2 && testStep2.exit_code === 0);

  // B3: build script fails -> BLOCKED regardless of what the test step reports
  const d3 = caseDir();
  writePkg(d3, { name: 'b3', version: '1.0.0', scripts: {
    build: 'node -e "process.exit(7)"',
    test: 'node -e "console.log(\'2 passed\'); console.log(\'0 failed\'); process.exit(0)"',
  } });
  const { r: r3, j: j3 } = runJson([d3, '--json', '--in-place', '--no-install']);
  t('B3 failing build script: exit 1 (BLOCKED) even though the test step reports success', r3.status === 1);
  t('B3 failing build script: verdict is blocked', !!j3 && j3.verdict === 'blocked');
  t('B3 failing build script: reason mentions build failed', !!j3 && /build failed/.test(j3.reason));
  const buildStep3 = j3 && j3.steps.find((s) => s.label === 'build');
  t('B3 the real build exit code (7) is carried, not fabricated', !!buildStep3 && buildStep3.exit_code === 7);

  // B4: a REAL, fully offline install failure. `npm ci` refuses a package-lock.json that is out of
  // sync with package.json — this is a local consistency check (no network fetch attempted before
  // the refusal), probed directly beforehand and confirmed to complete in well under a second.
  const d4 = caseDir();
  writePkg(d4, { name: 'b4', version: '1.0.0', dependencies: { 'left-pad': '^1.0.0' }, scripts: {
    test: 'node -e "process.exit(0)"',
  } });
  fs.writeFileSync(path.join(d4, 'package-lock.json'), JSON.stringify({ name: 'b4', version: '1.0.0', lockfileVersion: 3, requires: true, packages: {} }, null, 2));
  const { r: r4, j: j4 } = runJson([d4, '--json', '--in-place']); // deliberately NOT --no-install
  t('B4 a real offline failing install (npm ci, out-of-sync lockfile): exit 1 (BLOCKED)', r4.status === 1);
  t('B4 real failing install: verdict is blocked', !!j4 && j4.verdict === 'blocked');
  t('B4 real failing install: reason mentions install failed', !!j4 && /install failed/.test(j4.reason));
  const installStep4 = j4 && j4.steps.find((s) => s.label === 'install');
  t('B4 the real npm ci nonzero exit code is carried honestly', !!installStep4 && installStep4.exit_code !== 0);
}

// ===================================================================================
// GROUP C — PASSED invariants: a genuinely green project must be reported PASSED, and the
// parsed pass/fail counts must match the real captured output.
// ===================================================================================
{
  // C1: build + test both genuinely succeed; the test output carries a real parseable tally
  const d1 = caseDir();
  writePkg(d1, { name: 'c1', version: '1.0.0', scripts: {
    build: 'node -e "process.exit(0)"',
    test: 'node -e "console.log(\'4 passed\'); console.log(\'0 failed\'); process.exit(0)"',
  } });
  const { r: r1, j: j1 } = runJson([d1, '--json', '--in-place', '--no-install']);
  t('C1 genuinely green build+test: exit 0 (PASSED)', r1.status === 0);
  t('C1 genuinely green build+test: verdict is pass', !!j1 && j1.verdict === 'pass');
  t('C1 the parsed tally matches the real output (4 passes, 0 failures)', !!j1 && j1.testCounts.parseable === true && j1.testCounts.passed === 4 && j1.testCounts.failed === 0);
  const buildStep1 = j1 && j1.steps.find((s) => s.label === 'build');
  const testStep1 = j1 && j1.steps.find((s) => s.label === 'test');
  t('C1 both real step exit codes are 0', !!buildStep1 && buildStep1.exit_code === 0 && !!testStep1 && testStep1.exit_code === 0);

  // C2: no build/test scripts at all. CORRECTED 2026-08-03 (audit sweep): this used to assert
  // `verdict === 'pass'` and `exit 0` — i.e. the test CODIFIED the defect, which is why a gate that
  // executed nothing could report a green integration for years. A gate whose job is to observe cannot
  // pass on an observation it never made; the honest third outcome is `not-verified` (exit 3). See
  // GROUP G below for the full contract.
  // (it must never fabricate a pass/fail count when there was nothing to run)
  const d2 = caseDir();
  writePkg(d2, { name: 'c2', version: '1.0.0', scripts: {} });
  const { r: r2, j: j2 } = runJson([d2, '--json', '--in-place', '--no-install']);
  t('C2 no build/test scripts: exit 3 (NOT-VERIFIED — nothing ran, so nothing is verified)', r2.status === 3);
  t('C2 no build/test scripts: verdict is not-verified, never pass', !!j2 && j2.verdict === 'not-verified');
  t('C2 no build/test scripts: testCounts honestly NOT parseable (no fabricated tally)', !!j2 && j2.testCounts.parseable === false && j2.testCounts.passed === null && j2.testCounts.failed === null);
  const buildStep2 = j2 && j2.steps.find((s) => s.label === 'build');
  const testStep2 = j2 && j2.steps.find((s) => s.label === 'test');
  t('C2 build/test steps are both honestly marked skipped', !!buildStep2 && buildStep2.skipped === true && !!testStep2 && testStep2.skipped === true);
}

// ===================================================================================
// GROUP D — the WRITTEN integration-gate.json artifact must carry the REAL exit_code and
// evidence, never a fabricated "ok" — checked for both a BLOCKED and a PASSED run.
// ===================================================================================
{
  // D1: blocked case
  const runId = 'wp3-gate-run-blocked-' + Date.now();
  const dBlocked = caseDir();
  writePkg(dBlocked, { name: 'gate-blocked', version: '1.0.0', scripts: { test: 'node -e "process.exit(1)"' } });
  const rBlocked = runCli([dBlocked, '--in-place', '--no-install', '--run', runId]);
  t('D1 blocked run: CLI exit code is the real 1', rBlocked.status === 1);
  const artBlockedPath = path.join(dBlocked, '.claude', 'forge-runs', runId, 'artifacts', 'integration-gate.json');
  t('D1 blocked run: integration-gate.json artifact was written', fs.existsSync(artBlockedPath));
  const artBlocked = JSON.parse(fs.readFileSync(artBlockedPath, 'utf8'));
  t('D1 blocked run: the written artifact says blocked, not pass', artBlocked.verdict === 'blocked');
  const artBlockedTest = artBlocked.steps.find((s) => s.label === 'test');
  t('D1 blocked run: the written artifact carries the REAL nonzero exit_code (not a fabricated "ok")', !!artBlockedTest && artBlockedTest.exit_code === 1);

  // D2: passed case (separate run id, separate fixture)
  const runIdPass = 'wp3-gate-run-passed-' + Date.now();
  const dPass = caseDir();
  // a real runner prints a tally; an exit code alone is no longer accepted as proof (broad audit #3)
  writePkg(dPass, { name: 'gate-passed', version: '1.0.0', scripts: { test: 'node -e "console.log(\'3 passed, 0 failed\')"' } });
  const rPass = runCli([dPass, '--in-place', '--no-install', '--run', runIdPass]);
  t('D2 passed run: CLI exit code is the real 0', rPass.status === 0);
  const artPassPath = path.join(dPass, '.claude', 'forge-runs', runIdPass, 'artifacts', 'integration-gate.json');
  t('D2 passed run: integration-gate.json artifact was written', fs.existsSync(artPassPath));
  const artPass = JSON.parse(fs.readFileSync(artPassPath, 'utf8'));
  t('D2 passed run: the written artifact says pass', artPass.verdict === 'pass');
  const artPassTest = artPass.steps.find((s) => s.label === 'test');
  t('D2 passed run: the written artifact carries the REAL exit_code 0', !!artPassTest && artPassTest.exit_code === 0);
}

// ===================================================================================
// GROUP E — CLI/JSON shape sanity + --no-install honestly skips the step it claims to
// ===================================================================================
{
  const d = caseDir();
  writePkg(d, { name: 'shape', version: '1.0.0', scripts: { test: 'node -e "console.log(\'2 passed, 0 failed\')"' } }); // a real runner prints a tally (audit #3)
  const { r, j } = runJson([d, '--json', '--in-place', '--no-install']);
  t('E1 --json output names this tool', !!j && j.tool === 'forge-integrate');
  t('E1 project path resolves to the exact fixture dir', !!j && path.resolve(j.project) === path.resolve(d));
  const installStep = j && j.steps.find((s) => s.label === 'install');
  t('E2 --no-install honestly skips the install step (not silently run anyway)', !!installStep && /skipped --no-install/.test(installStep.cmd) && installStep.exit_code === 0);
  t('E3 exit code and JSON verdict agree with each other', r.status === 0 && j.verdict === 'pass');
}

// ===================================================================================
// GROUP F — human-readable (non --json) output path
// ===================================================================================
{
  const d = caseDir();
  writePkg(d, { name: 'human', version: '1.0.0', scripts: { test: 'node -e "console.log(\'5 passed, 0 failed\')"' } }); // a real runner prints a tally (audit #3)
  const r = runCli([d, '--in-place', '--no-install']);
  t('F1 human-readable mode: exit 0 for a genuinely passing project', r.status === 0);
  t('F1 human-readable mode: prints an uppercase PASS verdict line', /forge-integrate: PASS/.test(r.stdout));

  const d2 = caseDir();
  writePkg(d2, { name: 'human-blocked', version: '1.0.0', scripts: { test: 'node -e "process.exit(1)"' } });
  const r2 = runCli([d2, '--in-place', '--no-install']);
  t('F2 human-readable mode: exit 1 for a genuinely failing project', r2.status === 1);
  t('F2 human-readable mode: prints an uppercase BLOCKED verdict line, never PASS', /forge-integrate: BLOCKED/.test(r2.stdout) && !/forge-integrate: PASS/.test(r2.stdout));
}

// ===================================================================================
// GROUP G — A GATE MAY NOT PASS ON WORK IT NEVER DID (audit sweep, 2026-08-03).
// MEASURED DEFECT: a project with a package.json but NO test script produced
// verdict:"pass" plus a `quality_gate_passed` event with exit_code 0 — the tool whose
// entire purpose is to turn "asserted" into "observed" was emitting an observation of
// nothing. A missing test script is not a pass; it is an honest NOT-VERIFIED.
// ===================================================================================
{
  const noTest = caseDir();
  writePkg(noTest, { name: 'no-test', version: '1.0.0', scripts: { build: 'node -e "process.exit(0)"' } });
  const { r, j } = runJson([noTest, '--json', '--in-place', '--no-install']);
  t('G1 a project with NO test script never reports verdict "pass"', !!j && j.verdict !== 'pass', j && j.verdict);
  t('G1 the verdict is an honest not-verified, and the reason says so', !!j && j.verdict === 'not-verified' && /no test script/i.test(j.reason || ''));
  t('G1 exit code is NOT 0 (a caller checking the exit code is not told "verified")', r.status !== 0);

  const noBuildNoTest = caseDir();
  writePkg(noBuildNoTest, { name: 'bare', version: '1.0.0' });
  const { j: j2 } = runJson([noBuildNoTest, '--json', '--in-place', '--no-install']);
  t('G2 neither build nor test present: still not a pass', !!j2 && j2.verdict !== 'pass');

  // G3: with a REAL passing test script the gate still passes — the fix must not break the happy path
  const withTest = caseDir();
  writePkg(withTest, { name: 'with-test', version: '1.0.0', scripts: { test: 'node -e "console.log(\'1 passed, 0 failed\')"' } });
  const { r: r3, j: j3 } = runJson([withTest, '--json', '--in-place', '--no-install']);
  t('G3 a project with a genuinely passing test script DOES pass (happy path intact)', !!j3 && j3.verdict === 'pass' && r3.status === 0, j3 && (j3.verdict + ' / exit ' + r3.status));

  // G4: the artifact + event must mirror the honest verdict, never a fabricated gate_passed
  const runId = 'g4-not-verified';
  const noTest2 = caseDir();
  writePkg(noTest2, { name: 'no-test-2', version: '1.0.0' });
  runCli([noTest2, '--json', '--in-place', '--no-install', '--run', runId]);
  const artDir = path.join(noTest2, '.claude', 'forge-runs', runId, 'artifacts');
  const artPath = path.join(artDir, 'integration-gate.json');
  if (fs.existsSync(artPath)) {
    const art = JSON.parse(fs.readFileSync(artPath, 'utf8'));
    t('G4 the written artifact carries the not-verified verdict, not a pass', art.verdict !== 'pass');
  } else {
    t('G4 no artifact written for an unverified gate (also acceptable — nothing fabricated)', true);
  }
}

// ===================================================================================
// GROUP H — AN EXIT CODE IS NOT EVIDENCE THAT TESTS RAN (broad Codex audit #3, 2026-08-05).
// GROUP G closed the missing-test-script hole; this closes the one right next to it: a script that
// EXISTS, exits 0 and runs nothing at all. The npm no-op, a runner whose glob matched zero files, or a
// deliberately hollow `node -e "process.exit(0)"` all used to produce verdict:"pass" — an observation of
// nothing, dressed as proof. A positive count of executed tests is now required.
// ===================================================================================
{
  const noop = caseDir();
  writePkg(noop, { name: 'noop-test', version: '1.0.0', scripts: { test: 'node -e "process.exit(0)"' } });
  const { r, j } = runJson([noop, '--json', '--in-place', '--no-install']);
  t('H1 a test script that exits 0 while running NOTHING is not a pass', !!j && j.verdict !== 'pass', j && j.verdict);
  t('H1 it is honestly not-verified, and the reason says an exit code is not evidence', !!j && j.verdict === 'not-verified' && /exit code is not evidence|zero tests/i.test(j.reason || ''), j && j.reason);
  t('H1 the exit code is non-zero so a caller checking it is never told "verified"', r.status !== 0);

  const zero = caseDir();
  writePkg(zero, { name: 'zero-tests', version: '1.0.0', scripts: { test: 'node -e "console.log(\'0 passed, 0 failed\')"' } });
  const { j: jz } = runJson([zero, '--json', '--in-place', '--no-install']);
  t('H2 a runner that honestly reports 0 passed / 0 failed is not a pass either', !!jz && jz.verdict === 'not-verified', jz && (jz.verdict + ' / ' + jz.reason));

  const real = caseDir();
  writePkg(real, { name: 'real-tests', version: '1.0.0', scripts: { test: 'node -e "console.log(\'7 passed, 0 failed\')"' } });
  const { r: rr, j: jr } = runJson([real, '--json', '--in-place', '--no-install']);
  t('H3 a run with a REAL positive test count still passes (happy path intact)', !!jr && jr.verdict === 'pass' && rr.status === 0, jr && (jr.verdict + ' / exit ' + rr.status));
  t('H3 the counted tests are carried in the result, not just asserted', !!jr && jr.testCounts.passed === 7);
}

// ===================================================================================
// GROUP I — A PASS WHOSE PROOF COULD NOT BE RECORDED IS NOT A PASS (Codex audit #27, 2026-08-05).
// The gate wrote its artifact and logged its event inside a try/catch whose failure only set an
// `artifact_error` field — the verdict stayed `pass` and the exit code stayed 0. So the one thing this
// gate exists to produce (durable, checkable proof) could vanish while it still reported success.
// ===================================================================================
{
  const d = caseDir();
  writePkg(d, { name: 'proof-fail', version: '1.0.0', scripts: { test: 'node -e "console.log(\'4 passed, 0 failed\')"' } });
  const runId = 'i1-proof-fail';
  // Make the artifact directory impossible to create: put a FILE where the run directory must be.
  const runsDir = path.join(d, '.claude', 'forge-runs');
  fs.mkdirSync(runsDir, { recursive: true });
  fs.writeFileSync(path.join(runsDir, runId), 'not a directory', 'utf8');

  const { r, j } = runJson([d, '--json', '--in-place', '--no-install', '--run', runId]);
  t('I1 tests passed, but an unwritable proof path demotes the verdict', !!j && j.verdict === 'not-verified', j && (j.verdict + ' / ' + j.reason));
  t('I1 the reason says the proof could not be recorded', !!j && /could not be recorded|not readable back/i.test(j.reason || ''), j && j.reason);
  t('I1 the exit code follows the demoted verdict (a caller is never told "verified")', r.status === 3, 'exit ' + r.status);
  t('I1 the underlying test result is still reported honestly (4 passed)', !!j && j.testCounts && j.testCounts.passed === 4);
}
{
  // control: the SAME project with a writable run dir still passes — the demotion is not blanket
  const d2 = caseDir();
  writePkg(d2, { name: 'proof-ok', version: '1.0.0', scripts: { test: 'node -e "console.log(\'4 passed, 0 failed\')"' } });
  const { r: r2, j: j2 } = runJson([d2, '--json', '--in-place', '--no-install', '--run', 'i2-proof-ok']);
  t('I2 with a writable proof path the same run passes (happy path intact)', !!j2 && j2.verdict === 'pass' && r2.status === 0, j2 && (j2.verdict + ' / exit ' + r2.status));
  t('I2 and the artifact really exists on disk afterwards', !!j2 && !!j2.artifact && fs.existsSync(j2.artifact));
}

// ============================================================================================
// GROEP J — DE POORT TEST DE ECHTE (VUILE) WERKBOOM, NIET HEAD (broad Codex audit #26, 2026-08-06)
// --------------------------------------------------------------------------------------------
// De hermetische tak checkte `HEAD` uit: per definitie zonder ongecommitte wijzigingen en zonder
// untracked bestanden — precies de code die deze poort moet beoordelen. Deze groep draait tegen een
// echte wegwerp-git-repo (1 commit, hermetisch onder os.tmpdir(); geen enkele aanraking van echte
// projecten) en wordt eerlijk overgeslagen als git ontbreekt.
// ============================================================================================
console.log('\nJ) worktree draagt de vuile werkboom (audit #26)');
{
  const gitOk = (() => { try { return spawnSync('git', ['--version'], { encoding: 'utf8', shell: true }).status === 0; } catch { return false; } })();
  if (!gitOk) {
    console.log('  SKIP GROEP J — git is niet beschikbaar op deze machine (eerlijk overgeslagen, niet stil)');
  } else {
    const mkRepo = () => {
      const dir = caseDir();
      const g = (args) => spawnSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8', shell: true });
      g(['init', '-q']);
      return { dir, g };
    };
    const pkgWith = (testCmd) => JSON.stringify({ name: 'j-fixture', version: '1.0.0', scripts: { test: testCmd } }, null, 2);
    const GREEN = 'node -e "console.log(String(2)+\\" passed, 0 failed\\")"';
    const RED = 'node -e "console.log(\\"0 passed, 1 failed\\"); process.exit(1)"';

    // J1 — DE KERN: HEAD groen, werkboom ONgecommit rood -> de poort MOET blokkeren.
    {
      const { dir, g } = mkRepo();
      fs.writeFileSync(path.join(dir, 'package.json'), pkgWith(GREEN));
      g(['add', '-A']); g(['commit', '-qm', 'green-HEAD']);
      fs.writeFileSync(path.join(dir, 'package.json'), pkgWith(RED)); // ongecommit: de echte staat is rood
      const r = runCli([dir, '--no-install', '--json']);
      const j = JSON.parse(r.stdout || '{}');
      t('J1 een ongecommitte rode werkboom komt NIET als pass door de hermetische poort (HEAD was groen)',
        r.status !== 0 && j.verdict !== 'pass');
      t('J1 het resultaat zegt welke boom getest is (werkboom-snapshot, niet kale HEAD)',
        j.hermetic === false || /working-tree snapshot|stash/.test(j.worktreeSource || ''));
    }

    // J2 — SPIEGEL: HEAD rood, werkboom ONgecommit groen -> geen vals BLOCKED.
    {
      const { dir, g } = mkRepo();
      fs.writeFileSync(path.join(dir, 'package.json'), pkgWith(RED));
      g(['add', '-A']); g(['commit', '-qm', 'red-HEAD']);
      fs.writeFileSync(path.join(dir, 'package.json'), pkgWith(GREEN)); // de fix, nog niet gecommit
      const r = runCli([dir, '--no-install', '--json']);
      const j = JSON.parse(r.stdout || '{}');
      t('J2 een ongecommitte groene fix wordt niet vals geblokkeerd op een rode HEAD', r.status === 0 && j.verdict === 'pass');
    }

    // J3 — UNTRACKED: het testscript heeft een nieuw, nog niet ge-add bestand nodig.
    {
      const { dir, g } = mkRepo();
      fs.writeFileSync(path.join(dir, 'package.json'), pkgWith('node -e "require(\\"./helper.js\\")"'));
      g(['add', '-A']); g(['commit', '-qm', 'needs-helper']);
      fs.writeFileSync(path.join(dir, 'helper.js'), 'console.log("3 passed, 0 failed");\n'); // untracked
      const r = runCli([dir, '--no-install', '--json']);
      const j = JSON.parse(r.stdout || '{}');
      t('J3 untracked bestanden reizen mee naar de worktree (geen vals BLOCKED op een missend nieuw bestand)',
        r.status === 0 && j.verdict === 'pass');
    }

    // J4 — REGRESSIEWACHT: schone boom -> hermetische run blijft gewoon werken.
    {
      const { dir, g } = mkRepo();
      fs.writeFileSync(path.join(dir, 'package.json'), pkgWith(GREEN));
      g(['add', '-A']); g(['commit', '-qm', 'clean-green']);
      const r = runCli([dir, '--no-install', '--json']);
      const j = JSON.parse(r.stdout || '{}');
      t('J4 een schone boom blijft een gewone hermetische pass (happy path intact)',
        r.status === 0 && j.verdict === 'pass' && j.hermetic === true && /HEAD \(clean tree\)/.test(j.worktreeSource || ''));
      t('J4 de owner-werkboom is niet gemuteerd (status blijft schoon)',
        spawnSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8', shell: true }).stdout.trim() === '');
    }
  }
}

// ============================================================================================
// GROEP K — CRLF-FIDELITEIT (uitgesteld punt 4, gesloten 2026-08-06): de hermetische worktree moet
// BYTE-GELIJK zijn aan de echte werkboom, ook wanneer .gitattributes/autocrlf de checkout zou
// normaliseren. Echte wegwerp-git-repo; eerlijk overgeslagen zonder git.
// ============================================================================================
console.log('\nK) CRLF-fideliteit van de worktree-snapshot');
{
  const gitOkK = (() => { try { return spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0; } catch { return false; } })();
  if (!gitOkK) {
    console.log('  SKIP GROEP K — git niet beschikbaar (eerlijk overgeslagen)');
  } else {
    const crypto = require('crypto');
    const sha = (p2) => crypto.createHash('sha256').update(fs.readFileSync(p2)).digest('hex');
    const dir = caseDir();
    const g = (args) => spawnSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' });
    g(['init', '-q']);
    g(['config', 'core.autocrlf', 'false']);
    // .gitattributes die *.txt naar LF normaliseert — de klassieke fideliteitsbreker bij checkout
    fs.writeFileSync(path.join(dir, '.gitattributes'), '*.txt text eol=lf\n');
    // het testscript verifieert ZELF de bytes in de boom waarin het draait: CRLF aanwezig = pass,
    // genormaliseerd (LF) = exit 1 — zo bewijst het verdict de fideliteit, ook al is de worktree na
    // afloop alweer opgeruimd (cleanupWorktree draait voor de assert kan kijken).
    const KTEST = 'node -e "const d=require(\\"fs\\").readFileSync(\\"data.txt\\");process.stdout.write(d.includes(13)?\\"1 passed, 0 failed\\":\\"0 passed, 1 failed\\");process.exit(d.includes(13)?0:1)"';
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'k', version: '1.0.0', scripts: { test: KTEST } }, null, 2));
    fs.writeFileSync(path.join(dir, 'data.txt'), 'regel1\nregel2\n');
    g(['add', '-A']); g(['commit', '-qm', 'basis']);
    // dirty tracked change MET CRLF — de echte werkboombytes die de checkout zou normaliseren
    fs.writeFileSync(path.join(dir, 'data.txt'), 'regel1\r\nregel2\r\nregel3-crlf\r\n');
    const r = runCli([dir, '--no-install', '--json']);
    const j = JSON.parse(r.stdout || '{}');
    t('K1 de run slaagt gewoon', r.status === 0 && j.verdict === 'pass', (r.stderr || '').slice(0, 150));
    if (j.hermetic === true) {
      // het testscript draaide IN de worktree en eiste CRLF-bytes: verdict pass = byte-fideliteit bewezen
      t('K1 het dirty tracked bestand is BYTE-GELIJK in de worktree (het in-worktree testscript zag de CRLF-bytes)',
        j.verdict === 'pass' && j.testCounts && j.testCounts.passed === 1);
      t('K1 de bron vermeldt de geverifieerde EOL-fideliteit', /EOL-fideliteit geverifieerd/.test(j.worktreeSource || ''), j.worktreeSource);
    } else {
      // in-place is de EERLIJKE fallback — geen vals hermetic-label
      t('K1 zonder worktree is de reden eerlijk (in-place op de echte boom)', /in place|IN PLACE/i.test(j.reason || ''), j.reason);
    }
  }
}

// ============================================================================================
// L) Codex r4 #17: CRLF-fideliteit in een MONOREPO-SUBDIR — porcelain-paden zijn reporoot-relatief;
//    de overlay baseerde ze op projectDir, vond de bron niet ("deleted"-tak), liet de checkout-
//    genormaliseerde bytes staan en rapporteerde toch hermetic:true. RED voor de fix: L1 faalde
//    (testscript zag LF i.p.v. CRLF onder een hermetic-label).
// ============================================================================================
console.log('\nL) CRLF-fideliteit in een monorepo-subdir');
{
  const gitOkL = (() => { try { return spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0; } catch { return false; } })();
  if (!gitOkL) {
    console.log('  SKIP GROEP L — git niet beschikbaar (eerlijk overgeslagen)');
    t('L0 skip-voorwaarde is een echt feit: git ontbreekt', true);
  } else {
    const root = caseDir();
    const app = path.join(root, 'packages', 'app');
    fs.mkdirSync(app, { recursive: true });
    const g = (args) => spawnSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' });
    g(['init', '-q']);
    g(['config', 'core.autocrlf', 'false']);
    fs.writeFileSync(path.join(root, '.gitattributes'), '*.txt text eol=lf\n');
    const LTEST = 'node -e "const d=require(\\"fs\\").readFileSync(\\"data.txt\\");process.stdout.write(d.includes(13)?\\"1 passed, 0 failed\\":\\"0 passed, 1 failed\\");process.exit(d.includes(13)?0:1)"';
    fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'l-app', version: '1.0.0', scripts: { test: LTEST } }, null, 2));
    fs.writeFileSync(path.join(app, 'data.txt'), 'regel1\nregel2\n');
    g(['add', '-A']); g(['commit', '-qm', 'basis']);
    // dirty tracked change MET CRLF in de SUBDIR — porcelain meldt 'packages/app/data.txt' (root-relatief)
    fs.writeFileSync(path.join(app, 'data.txt'), 'regel1\r\nregel2\r\nregel3-crlf\r\n');
    const r = runCli([app, '--no-install', '--json']);
    const j = JSON.parse(r.stdout || '{}');
    t('L1 de run slaagt in de monorepo-subdir', r.status === 0 && j.verdict === 'pass', 'status=' + r.status + ' verdict=' + (j.verdict || '?') + ' :: ' + (r.stderr || '').slice(0, 150));
    if (j.hermetic === true) {
      t('L1 het dirty bestand is BYTE-GELIJK in de subdir-worktree (CRLF overleefde de reporoot-relatieve overlay)',
        j.verdict === 'pass' && j.testCounts && j.testCounts.passed === 1, JSON.stringify(j.testCounts || {}));
      t('L1 de bron vermeldt subdir én EOL-fideliteit', /subdir packages\/app/.test(j.worktreeSource || '') && /EOL-fideliteit geverifieerd/.test(j.worktreeSource || ''), j.worktreeSource);
    } else {
      t('L1 zonder worktree is de reden eerlijk (in-place)', /in place|IN PLACE/i.test(j.reason || ''), j.reason);
    }
  }
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
