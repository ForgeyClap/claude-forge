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
 *  - The "fresh git worktree" hermetic execution path (the isGitRepo()===true branch) is not
 *    exercised here — that would require creating and tearing down a real throwaway git repo per
 *    case, which adds git-process overhead without adding coverage of the honesty invariants this
 *    suite targets (parse / verdict / artifact correctness). --in-place vs worktree only changes
 *    WHERE commands run, never whether pass/fail is parsed and reported honestly.
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

  // C2: no build/test scripts at all -> PASSED, but the gate honestly reports nothing was parsed
  // (it must never fabricate a pass/fail count when there was nothing to run)
  const d2 = caseDir();
  writePkg(d2, { name: 'c2', version: '1.0.0', scripts: {} });
  const { r: r2, j: j2 } = runJson([d2, '--json', '--in-place', '--no-install']);
  t('C2 no build/test scripts: exit 0 (nothing to fail)', r2.status === 0);
  t('C2 no build/test scripts: verdict is pass', !!j2 && j2.verdict === 'pass');
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
  writePkg(dPass, { name: 'gate-passed', version: '1.0.0', scripts: { test: 'node -e "process.exit(0)"' } });
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
  writePkg(d, { name: 'shape', version: '1.0.0', scripts: { test: 'node -e "process.exit(0)"' } });
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
  writePkg(d, { name: 'human', version: '1.0.0', scripts: { test: 'node -e "process.exit(0)"' } });
  const r = runCli([d, '--in-place', '--no-install']);
  t('F1 human-readable mode: exit 0 for a genuinely passing project', r.status === 0);
  t('F1 human-readable mode: prints an uppercase PASS verdict line', /forge-integrate: PASS/.test(r.stdout));

  const d2 = caseDir();
  writePkg(d2, { name: 'human-blocked', version: '1.0.0', scripts: { test: 'node -e "process.exit(1)"' } });
  const r2 = runCli([d2, '--in-place', '--no-install']);
  t('F2 human-readable mode: exit 1 for a genuinely failing project', r2.status === 1);
  t('F2 human-readable mode: prints an uppercase BLOCKED verdict line, never PASS', /forge-integrate: BLOCKED/.test(r2.stdout) && !/forge-integrate: PASS/.test(r2.stdout));
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
