#!/usr/bin/env node
'use strict';
/** Offline, hermetic tests for forge-evals.cjs (WP4 — deterministic binary-assertion scorer). Pure
 *  function coverage (runAssertion/validateEvals/allLines) runs in-process; CLI behavior (exit codes,
 *  stdout/stderr shape, --json, and real --run gate_evaluated logging) is exercised via spawnSync
 *  subprocess calls against real fixture files under one os.tmpdir() root — this file never touches the
 *  real project's .claude/forge-runs/. Exit 0 = all pass. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const E = require('./forge-evals.cjs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-evals-test-'));
const REAL_LOG_EVENT = path.join(__dirname, '..', 'forge-dashboard', 'log-event.cjs');
const CLI = path.join(__dirname, 'forge-evals.cjs');

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };

console.log('forge-evals offline tests (hermetic tmp=' + TMP + ')');

// ---- fixture helpers ----
let caseN = 0;
function caseDir() { const d = path.join(TMP, 'case' + (++caseN)); fs.mkdirSync(d, { recursive: true }); return d; }
function writeEvals(dir, obj) { const p = path.join(dir, 'evals.json'); fs.writeFileSync(p, JSON.stringify(obj, null, 2)); return p; }
function outputsDir(dir) { const p = path.join(dir, 'outputs'); fs.mkdirSync(p, { recursive: true }); return p; }
function writeOutput(dir, testId, ext, text) { fs.writeFileSync(path.join(dir, `${testId}.${ext}`), text); }
function runCli(args, envRoot) { return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: envRoot ? Object.assign({}, process.env, { FORGE_PROJECT_ROOT: envRoot }) : process.env }); }
function makeLogFixture(root) { fs.mkdirSync(path.join(root, '.claude', 'forge-dashboard'), { recursive: true }); fs.copyFileSync(REAL_LOG_EVENT, path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs')); }
function eventsOf(root, runId) { return fs.readFileSync(path.join(root, '.claude', 'forge-runs', runId, 'events.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); }

// ===================================================================================
// GROUP A — every assertion type: one passing + one failing case (runAssertion, direct)
// ===================================================================================
{
  const cases = [
    ['max_words', { id: 'a', type: 'max_words', n: 3 }, 'one two three', true, 'one two three four', false],
    ['min_words', { id: 'a', type: 'min_words', n: 3 }, 'one two three', true, 'one two', false],
    ['required_pattern', { id: 'a', type: 'required_pattern', regex: '^Hello', flags: '' }, 'Hello world', true, 'Goodbye world', false],
    ['forbidden_pattern', { id: 'a', type: 'forbidden_pattern', regex: 'TODO', flags: '' }, 'all done', true, 'still has TODO here', false],
    ['contains', { id: 'a', type: 'contains', text: 'foo' }, 'foobar', true, 'barbaz', false],
    ['not_contains', { id: 'a', type: 'not_contains', text: 'foo' }, 'barbaz', true, 'foobar', false],
    ['last_line_not_pattern', { id: 'a', type: 'last_line_not_pattern', regex: '\\?\\s*$', flags: '' }, 'Line1\nLine2.', true, 'Line1\nIs this ok?', false],
    ['first_line_max_words', { id: 'a', type: 'first_line_max_words', n: 3 }, 'one two three\nrest of text here', true, 'one two three four\nrest', false],
    ['line_count_max', { id: 'a', type: 'line_count_max', n: 2 }, 'line1\nline2', true, 'line1\nline2\nline3', false],
    ['json_parses', { id: 'a', type: 'json_parses' }, '{"a":1}', true, '{not json', false],
  ];
  for (const [name, assertion, passText, expectPass, failText, expectFail] of cases) {
    const rp = E.runAssertion(assertion, passText);
    const rf = E.runAssertion(assertion, failText);
    t(`${name}: passing case -> pass===${expectPass}`, rp.pass === expectPass);
    t(`${name}: failing case -> pass===${expectFail}`, rf.pass === expectFail);
    t(`${name}: result carries id/type/detail`, rp.id === 'a' && rp.type === name && typeof rp.detail === 'string' && rp.detail.length > 0);
  }
}

// ===================================================================================
// GROUP B — validateEvals edge cases
// ===================================================================================
{
  // invalid regex -> validation error, never a crash
  let threw = false, result = null;
  try { result = E.validateEvals({ skill: 'x', tests: [{ id: 't1', assertions: [{ type: 'required_pattern', regex: '[unclosed' }] }] }); }
  catch { threw = true; }
  t('invalid regex: validateEvals never throws', !threw);
  t('invalid regex: reported invalid with an error mentioning the regex', !!result && result.valid === false && result.errors.some((e) => /invalid regex/i.test(e)));

  // unknown assertion type -> validation error
  const r2 = E.validateEvals({ skill: 'x', tests: [{ id: 't1', assertions: [{ type: 'nonexistent_type' }] }] });
  t('unknown assertion type: invalid', r2.valid === false);
  t('unknown assertion type: error names the bad type', r2.errors.some((e) => /unknown assertion type 'nonexistent_type'/.test(e)));

  // 0 tests -> invalid, "no tests defined"
  const r3 = E.validateEvals({ skill: 'x', tests: [] });
  t('0 tests: invalid', r3.valid === false);
  t('0 tests: error says "no tests defined"', r3.errors.includes('no tests defined'));

  // test with 0 assertions -> invalid
  const r4 = E.validateEvals({ skill: 'x', tests: [{ id: 't1', assertions: [] }] });
  t('0 assertions in a test: invalid', r4.valid === false);
  t('0 assertions in a test: error mentions the empty assertions array', r4.errors.some((e) => /non-empty "assertions" array/.test(e)));

  // duplicate test id -> invalid
  const r5 = E.validateEvals({ skill: 'x', tests: [{ id: 't1', assertions: [{ type: 'json_parses' }] }, { id: 't1', assertions: [{ type: 'json_parses' }] }] });
  t('duplicate test id: invalid', r5.valid === false);
  t('duplicate test id: error names it', r5.errors.some((e) => /duplicate test id 't1'/.test(e)));

  // auto id assignment when ids are omitted
  const r6 = E.validateEvals({ skill: 'x', tests: [{ assertions: [{ type: 'json_parses' }] }] });
  t('auto test id assigned t1', r6.valid === true && r6.normalized.tests[0].id === 't1');
  t('auto assertion id assigned a1', r6.valid === true && r6.normalized.tests[0].assertions[0].id === 'a1');
}

// ===================================================================================
// GROUP C — CLI validate
// ===================================================================================
{
  const dir = caseDir();
  const evalsFile = writeEvals(dir, { skill: 'demo-skill', tests: [
    { id: 't1', assertions: [{ id: 'a1', type: 'contains', text: 'hi' }] },
    { id: 't2', assertions: [{ id: 'a1', type: 'json_parses' }] },
  ] });
  const ok = runCli(['validate', evalsFile]);
  t('validate (valid file): exit 0', ok.status === 0);
  t('validate (valid file): reports skill + counts', /VALID: demo-skill \(2 tests, 2 assertions\)/.test(ok.stdout));

  const okJson = runCli(['validate', evalsFile, '--json']);
  let parsedOk = null; try { parsedOk = JSON.parse(okJson.stdout); } catch { /* fail below */ }
  t('validate --json (valid): parses and reports valid:true with counts', !!parsedOk && parsedOk.valid === true && parsedOk.skill === 'demo-skill' && parsedOk.tests === 2 && parsedOk.assertions === 2);

  const badEvalsFile = writeEvals(dir, { skill: 'demo-skill', tests: [{ id: 't1', assertions: [{ type: 'bogus_type' }] }] });
  const bad = runCli(['validate', badEvalsFile]);
  t('validate (invalid file): exit 1', bad.status === 1);
  t('validate (invalid file): prints ERROR line naming the bad type', /ERROR:.*bogus_type/.test(bad.stdout));
}

// ===================================================================================
// GROUP D — CLI check (exit codes: all-pass=0, any-fail=1, usage=2; --json shape)
// ===================================================================================
{
  const dir = caseDir();
  const evalsFile = writeEvals(dir, { skill: 'demo', tests: [
    { id: 't1', assertions: [{ id: 'a1', type: 'contains', text: 'hello' }, { id: 'a2', type: 'max_words', n: 5 }] },
  ] });
  const passOut = path.join(dir, 'pass.txt'); fs.writeFileSync(passOut, 'hello there friend');
  const failOut = path.join(dir, 'fail.txt'); fs.writeFileSync(failOut, 'hello there friend this is far too long now');

  const rPass = runCli(['check', evalsFile, '--test', 't1', '--output', passOut]);
  t('check all-pass: exit 0', rPass.status === 0);
  t('check all-pass: summary line shows 2/2', /t1: 2\/2 passed/.test(rPass.stdout));

  const rFail = runCli(['check', evalsFile, '--test', 't1', '--output', failOut]);
  t('check any-fail: exit 1', rFail.status === 1);
  t('check any-fail: summary line shows 1/2', /t1: 1\/2 passed/.test(rFail.stdout));

  const rJson = runCli(['check', evalsFile, '--test', 't1', '--output', passOut, '--json']);
  let parsedCheck = null; try { parsedCheck = JSON.parse(rJson.stdout); } catch { /* fail below */ }
  t('check --json: parses with testId/passed/total/results[]', !!parsedCheck && parsedCheck.testId === 't1' && parsedCheck.passed === 2 && parsedCheck.total === 2 && Array.isArray(parsedCheck.results) && parsedCheck.results.length === 2);
  t('check --json: each result carries id/type/pass/detail', parsedCheck.results.every((r) => 'id' in r && 'type' in r && 'pass' in r && 'detail' in r));

  t('check usage: no arguments at all -> exit 2', runCli([]).status === 2);
  t('check usage: "check" with no evalsFile -> exit 2', runCli(['check']).status === 2);
  t('check usage: missing --test -> exit 2', runCli(['check', evalsFile, '--output', passOut]).status === 2);
  t('check usage: missing --output -> exit 2', runCli(['check', evalsFile, '--test', 't1']).status === 2);

  const rMissingOutput = runCli(['check', evalsFile, '--test', 't1', '--output', path.join(dir, 'does-not-exist.txt')]);
  t('check: missing output file -> exit 1 (not usage)', rMissingOutput.status === 1);
  t('check: missing output file -> clear error', /cannot read output file/.test(rMissingOutput.stderr));

  const rUnknownTest = runCli(['check', evalsFile, '--test', 'nope', '--output', passOut]);
  t('check: unknown testId -> exit 1', rUnknownTest.status === 1);
  t('check: unknown testId -> clear error', /test 'nope' not found/.test(rUnknownTest.stderr));
}

// ===================================================================================
// GROUP E — CLI score (missing-output honesty, --json shape, .md fallback, 0-tests)
// ===================================================================================
{
  const dir = caseDir();
  const evalsFile = writeEvals(dir, { skill: 'score-demo', tests: [
    { id: 't1', assertions: [{ id: 'a1', type: 'contains', text: 'ok' }] },
    { id: 't2', assertions: [{ id: 'a1', type: 'contains', text: 'ok' }] },
  ] });
  const outDir = outputsDir(dir);
  writeOutput(outDir, 't1', 'txt', 'this is ok');
  // t2 output intentionally NOT written -> missing

  const r = runCli(['score', evalsFile, '--outputs-dir', outDir]);
  t('score with one missing output: exit 1 (not all pass)', r.status === 1);
  t('score table: t2 reported PASS/FAIL with missing-output marker', /t2\s+FAIL\s+0\/1\s+\(missing output\)/.test(r.stdout));
  t('score table: overall SCORE line', /SCORE 1\/2 \(50%\)/.test(r.stdout));

  const rJson = runCli(['score', evalsFile, '--outputs-dir', outDir, '--json']);
  let parsed = null; try { parsed = JSON.parse(rJson.stdout); } catch { /* fail below */ }
  t('score --json: parses with skill/tests/passed/total/pct', !!parsed && parsed.skill === 'score-demo' && Array.isArray(parsed.tests) && parsed.passed === 1 && parsed.total === 2 && parsed.pct === 50);
  const t2 = parsed && parsed.tests.find((x) => x.id === 't2');
  t('score --json: missing test explicitly flagged missing:true', !!t2 && t2.missing === true && t2.passed === 0 && t2.total === 1);
  t('score --json: missing test assertion detail explicitly says missing', !!t2 && /missing/i.test(t2.results[0].detail));
  t('score --json: present test (t1) passed normally, missing:false', !!parsed.tests.find((x) => x.id === 't1' && x.missing === false && x.passed === 1));

  // .md fallback
  const dir2 = caseDir();
  const evalsFile2 = writeEvals(dir2, { skill: 'md-fallback', tests: [{ id: 't1', assertions: [{ id: 'a1', type: 'contains', text: 'ok' }] }] });
  const outDir2 = outputsDir(dir2);
  writeOutput(outDir2, 't1', 'md', 'looks ok here');
  const rMd = runCli(['score', evalsFile2, '--outputs-dir', outDir2]);
  t('score: falls back to .md when .txt is absent -> exit 0', rMd.status === 0);
  t('score: falls back to .md -> SCORE 1/1 (100%)', /SCORE 1\/1 \(100%\)/.test(rMd.stdout));

  // 0-tests file -> exit 1
  const dir3 = caseDir();
  const evalsFile3 = writeEvals(dir3, { skill: 'empty', tests: [] });
  const rEmpty = runCli(['score', evalsFile3, '--outputs-dir', outputsDir(dir3)]);
  t('score: 0-tests evals file -> exit 1', rEmpty.status === 1);
  t('score: 0-tests evals file -> "no tests defined" error', /no tests defined/.test(rEmpty.stderr));

  t('score usage: missing --outputs-dir -> exit 2', runCli(['score', evalsFile]).status === 2);
}

// ===================================================================================
// GROUP F — determinism: same inputs scored twice -> identical result objects
// ===================================================================================
{
  const dir = caseDir();
  const loaded = E.validateEvals({ skill: 'det', tests: [
    { id: 't1', assertions: [{ id: 'a1', type: 'contains', text: 'ok' }, { id: 'a2', type: 'max_words', n: 10 }] },
    { id: 't2', assertions: [{ id: 'a1', type: 'json_parses' }] },
  ] });
  const outDir = outputsDir(dir);
  writeOutput(outDir, 't1', 'txt', 'this is ok and short');
  writeOutput(outDir, 't2', 'txt', '{"k":"v"}');
  const result1 = E.scoreSuite(loaded.normalized, outDir);
  const result2 = E.scoreSuite(loaded.normalized, outDir);
  t('determinism: two scoreSuite() calls on identical input produce byte-identical JSON', JSON.stringify(result1) === JSON.stringify(result2));

  // also confirmed at the CLI/subprocess boundary
  const evalsFile = writeEvals(dir, { skill: 'det', tests: loaded.normalized.tests });
  const cli1 = runCli(['score', evalsFile, '--outputs-dir', outDir, '--json']);
  const cli2 = runCli(['score', evalsFile, '--outputs-dir', outDir, '--json']);
  t('determinism: two CLI score --json invocations produce identical stdout', cli1.stdout === cli2.stdout && cli1.status === cli2.status);
}

// ===================================================================================
// GROUP G — multi-line output handling: LAST non-empty line; Windows \r\n tolerated
// ===================================================================================
{
  t('allLines: CRLF text -> 3 lines, no phantom trailing blank', JSON.stringify(E.allLines('a\r\nb\r\nc\r\n')) === JSON.stringify(['a', 'b', 'c']));
  t('allLines: LF text (equivalent) -> same 3 lines', JSON.stringify(E.allLines('a\nb\nc\n')) === JSON.stringify(['a', 'b', 'c']));
  t('nonEmptyLines: blank line in the middle is filtered out', JSON.stringify(E.nonEmptyLines('a\r\n\r\nb\r\n')) === JSON.stringify(['a', 'b']));

  const assertion = { id: 'a', type: 'last_line_not_pattern', regex: '\\?\\s*$', flags: '' };
  const crlfText = 'Line1\r\nIs this ok?\r\n';
  const lfText = 'Line1\nIs this ok?\n';
  const rCrlf = E.runAssertion(assertion, crlfText);
  const rLf = E.runAssertion(assertion, lfText);
  t('last_line_not_pattern: CRLF input fails (last line ends with ?)', rCrlf.pass === false);
  t('last_line_not_pattern: CRLF and LF inputs normalize to an identical result object', JSON.stringify(rCrlf) === JSON.stringify(rLf));

  const lc = { id: 'a', type: 'line_count_max', n: 3 };
  const rCrlfLc = E.runAssertion(lc, 'a\r\nb\r\nc');
  const rLfLc = E.runAssertion(lc, 'a\nb\nc');
  t('line_count_max: CRLF (no trailing newline) and LF equivalents both pass at n=3', rCrlfLc.pass === true && rLfLc.pass === true);
  t('line_count_max: CRLF and LF produce identical detail text', rCrlfLc.detail === rLfLc.detail);
}

// ===================================================================================
// GROUP H (bonus) — real --run gate_evaluated self-logging, and tolerant failure handling
// ===================================================================================
{
  const root = path.join(TMP, 'gate-root');
  fs.mkdirSync(root, { recursive: true });
  makeLogFixture(root);
  const dir = path.join(root, 'work'); fs.mkdirSync(dir, { recursive: true });
  const evalsFile = writeEvals(dir, { skill: 'gate-skill', tests: [{ id: 't1', assertions: [{ id: 'a1', type: 'contains', text: 'ok' }] }] });
  const outDir = outputsDir(dir);
  writeOutput(outDir, 't1', 'txt', 'this is ok');
  const runId = 'run-gate-1';

  const r = runCli(['score', evalsFile, '--outputs-dir', outDir, '--run', runId], root);
  t('gate logging: score CLI with --run exits 0 (all pass)', r.status === 0);
  const gateEvent = eventsOf(root, runId).find((e) => e.event_type === 'gate_evaluated');
  t('gate logging: a real gate_evaluated event was appended', !!gateEvent);
  t('gate logging: note carries "skill: X/Y (Z%)"', !!gateEvent && /gate-skill: 1\/1 \(100%\)/.test(gateEvent.note));
  t('gate logging: evidence is the evals file path', !!gateEvent && gateEvent.evidence === evalsFile);
  t('gate logging: agent is orchestrator/lead', !!gateEvent && gateEvent.agent === 'orchestrator' && gateEvent.role === 'lead');

  // logging-failure tolerance: a root with NO log-event.cjs must not change the scoring exit code
  const brokenRoot = path.join(TMP, 'gate-root-broken');
  fs.mkdirSync(brokenRoot, { recursive: true });
  const r2 = runCli(['score', evalsFile, '--outputs-dir', outDir, '--run', 'run-gate-2'], brokenRoot);
  t('gate logging failure: scoring exit code still reflects pass/fail (0, all-pass), not forced to error', r2.status === 0);
  t('gate logging failure: SCORE line still printed on stdout', /SCORE 1\/1 \(100%\)/.test(r2.stdout));
  t('gate logging failure: a warning is reported on stderr, not swallowed', /gate_evaluated logging failed/.test(r2.stderr));
}

// ===================================================================================
// GROUP I — CLI compare: statistically-honest gate (2026-07-13 fix). Replaces the old "pooled
// deltaPp > 0" promote rule (which promoted pure noise, e.g. 4/9 vs 3/9, at n=3) with a per-test
// exact-binomial significance test + an asymmetric regression gate, and raises the default
// --min-samples from 3 to 8 (a 0.05 two-sided test almost never reaches significance at n=3).
// ===================================================================================
function writeSamples(dir, testId, texts) {
  // texts.length === 1 -> single `<testId>.txt`; texts.length > 1 -> numbered `<testId>.N.txt`.
  if (texts.length === 1) { fs.writeFileSync(path.join(dir, `${testId}.txt`), texts[0]); return; }
  texts.forEach((txt, idx) => fs.writeFileSync(path.join(dir, `${testId}.${idx + 1}.txt`), txt));
}
function okTexts(nOk, nNot) { const arr = []; for (let i = 0; i < nOk; i++) arr.push('this is ok #' + i); for (let i = 0; i < nNot; i++) arr.push('nope #' + i); return arr; }

{
  // ---- I.1: reproduces the OLD BUG's shape (with narrowly beats without) at n=3 samples/arm — BELOW
  // the new default --min-samples=8. Old code: deltaPp>0 + minSamples default 3 -> promoted this on
  // noise. New code: promotable requires samples>=8, so this is INCONCLUSIVE regardless of the delta
  // or of any per-test significance — proves the fix at the new DEFAULT settings for exactly the n=3
  // configuration where the bug used to fire. ----
  const dirLowN = caseDir();
  const evalsLowN = writeEvals(dirLowN, { skill: 'cmp-noise-lowN', tests: [
    { id: 't1', assertions: [{ id: 'a1', type: 'contains', text: 'ok' }] },
  ] });
  const withLowN = path.join(dirLowN, 'with'); fs.mkdirSync(withLowN, { recursive: true });
  const withoutLowN = path.join(dirLowN, 'without'); fs.mkdirSync(withoutLowN, { recursive: true });
  writeSamples(withLowN, 't1', okTexts(2, 1));     // 2/3 pass
  writeSamples(withoutLowN, 't1', okTexts(1, 2));  // 1/3 pass (deltaPp positive, exactly the old bug's shape)

  const rLowN = runCli(['compare', evalsLowN, '--with', withLowN, '--without', withoutLowN]);
  t('OLD BUG regression, n=3 (below new default 8): exit 1 (not promoted)', rLowN.status === 1);
  t('OLD BUG regression, n=3: VERDICT is INCONCLUSIVE, NOT KEEP/PROMOTE', /VERDICT: INCONCLUSIVE/.test(rLowN.stdout) && !/KEEP\/PROMOTE/.test(rLowN.stdout));
  const rLowNJson = JSON.parse(runCli(['compare', evalsLowN, '--with', withLowN, '--without', withoutLowN, '--json']).stdout);
  t('OLD BUG regression, n=3: promotable false, not conclusive', rLowNJson.promotable === false && rLowNJson.conclusive === false);
  t('OLD BUG regression, n=3: deltaPp is still positive (proves the fix is the GATE, not the delta)', rLowNJson.deltaPp > 0);

  // ---- I.2: adequate n (>=8, meets the new default), but the delta is still just noise — a tiny
  // (4/9 vs 3/9) positive aggregate delta must NOT promote once real per-test significance is required.
  // Hand-verified: two-sided exact binomial p(k=4,n=9,p=1/3) = 0.49276... (see GROUP I unit tests
  // below) — nowhere near alpha=0.05, so this must resolve to NO SIGNIFICANT DIFFERENCE. ----
  const dirAdeqN = caseDir();
  const evalsAdeqN = writeEvals(dirAdeqN, { skill: 'cmp-noise-adequateN', tests: [
    { id: 't1', assertions: [{ id: 'a1', type: 'contains', text: 'ok' }] },
  ] });
  const withAdeqN = path.join(dirAdeqN, 'with'); fs.mkdirSync(withAdeqN, { recursive: true });
  const withoutAdeqN = path.join(dirAdeqN, 'without'); fs.mkdirSync(withoutAdeqN, { recursive: true });
  writeSamples(withAdeqN, 't1', okTexts(4, 5));     // 4/9 pass
  writeSamples(withoutAdeqN, 't1', okTexts(3, 6));  // 3/9 pass

  const rAdeqN = runCli(['compare', evalsAdeqN, '--with', withAdeqN, '--without', withoutAdeqN]);
  t('noise at adequate n=9 (meets new default 8): exit 1 (non-actionable)', rAdeqN.status === 1);
  t('noise at adequate n=9: VERDICT is NO SIGNIFICANT DIFFERENCE, NOT KEEP/PROMOTE', /VERDICT: NO SIGNIFICANT DIFFERENCE/.test(rAdeqN.stdout) && !/KEEP\/PROMOTE/.test(rAdeqN.stdout));
  const rAdeqNJson = JSON.parse(runCli(['compare', evalsAdeqN, '--with', withAdeqN, '--without', withoutAdeqN, '--json']).stdout);
  t('noise at adequate n=9: promotable true (samples meet floor) but conclusive false', rAdeqNJson.promotable === true && rAdeqNJson.conclusive === false);
  t('noise at adequate n=9: perTest classification is no_sig_change', rAdeqNJson.perTest[0].classification === 'no_sig_change');
  t('noise at adequate n=9: perTest pValue matches the hand-computed value within tolerance', Math.abs(rAdeqNJson.perTest[0].pValue - 0.4927602499618978) < 1e-6);
  t('noise at adequate n=9: gains=0 and regressions=0', rAdeqNJson.significance.gains === 0 && rAdeqNJson.significance.regressions === 0);

  // ---- I.3: clear win, both arms at exactly the new default (n=8) -> KEEP/PROMOTE, exit 0 ----
  const dirWin = caseDir();
  const evalsWin = writeEvals(dirWin, { skill: 'cmp-win', tests: [
    { id: 't1', assertions: [{ id: 'a1', type: 'contains', text: 'ok' }] },
  ] });
  const withWin = path.join(dirWin, 'with'); fs.mkdirSync(withWin, { recursive: true });
  const withoutWin = path.join(dirWin, 'without'); fs.mkdirSync(withoutWin, { recursive: true });
  writeSamples(withWin, 't1', okTexts(8, 0));     // 8/8 pass
  writeSamples(withoutWin, 't1', okTexts(0, 8));  // 0/8 pass

  const rWin = runCli(['compare', evalsWin, '--with', withWin, '--without', withoutWin]);
  t('clear win at n=8: exit 0', rWin.status === 0);
  t('clear win at n=8: VERDICT says KEEP/PROMOTE', /VERDICT: KEEP\/PROMOTE/.test(rWin.stdout));
  const rWinJson = JSON.parse(runCli(['compare', evalsWin, '--with', withWin, '--without', withoutWin, '--json']).stdout);
  t('clear win: promotable true, conclusive true, deltaPp > 0', rWinJson.promotable === true && rWinJson.conclusive === true && rWinJson.deltaPp > 0);
  t('clear win: perTest classification is significant_gain', rWinJson.perTest[0].classification === 'significant_gain');
  t('clear win: significance summary gains=1 regressions=0', rWinJson.significance.gains === 1 && rWinJson.significance.regressions === 0);
  t('clear win: verdict text matches', /^KEEP\/PROMOTE/.test(rWinJson.verdict));

  // ---- I.4: ASYMMETRIC GATE — a significant regression on ONE task must REJECT even though the
  // AGGREGATE pooled delta is positive (a gain on another task). tA is "baseline-solved" (without=100%)
  // and with regresses hard (25%); tB is a genuine zero-baseline gain (0% -> 100%). Aggregate: with
  // 10/16=63%, without 8/16=50%, deltaPp=+13 (positive) — must still REJECT because of tA. ----
  const dirReg = caseDir();
  const evalsReg = writeEvals(dirReg, { skill: 'cmp-regression', tests: [
    { id: 'tA', assertions: [{ id: 'a1', type: 'contains', text: 'ok' }] },
    { id: 'tB', assertions: [{ id: 'a1', type: 'contains', text: 'ok' }] },
  ] });
  const withReg = path.join(dirReg, 'with'); fs.mkdirSync(withReg, { recursive: true });
  const withoutReg = path.join(dirReg, 'without'); fs.mkdirSync(withoutReg, { recursive: true });
  writeSamples(withReg, 'tA', okTexts(2, 6));      // 2/8 (25%) — regressed hard
  writeSamples(withoutReg, 'tA', okTexts(8, 0));   // 8/8 (100%) — baseline-solved
  writeSamples(withReg, 'tB', okTexts(8, 0));      // 8/8 (100%) — improved
  writeSamples(withoutReg, 'tB', okTexts(0, 8));   // 0/8 (0%)

  const rReg = runCli(['compare', evalsReg, '--with', withReg, '--without', withoutReg]);
  t('asymmetric gate: exit 0 (a valid REJECT conclusion)', rReg.status === 0);
  t('asymmetric gate: VERDICT says REJECT, names tA', /VERDICT: REJECT/.test(rReg.stdout) && /tA/.test(rReg.stdout));
  const rRegJson = JSON.parse(runCli(['compare', evalsReg, '--with', withReg, '--without', withoutReg, '--json']).stdout);
  t('asymmetric gate: aggregate deltaPp is POSITIVE despite the reject', rRegJson.deltaPp > 0);
  t('asymmetric gate: promotable true, conclusive true', rRegJson.promotable === true && rRegJson.conclusive === true);
  const tAResult = rRegJson.perTest.find((p) => p.id === 'tA');
  const tBResult = rRegJson.perTest.find((p) => p.id === 'tB');
  t('asymmetric gate: tA classified significant_regression', !!tAResult && tAResult.classification === 'significant_regression');
  t('asymmetric gate: tB classified significant_gain (but does not save the verdict)', !!tBResult && tBResult.classification === 'significant_gain');
  t('asymmetric gate: significance summary gains=1 regressions=1', rRegJson.significance.gains === 1 && rRegJson.significance.regressions === 1);
  t('asymmetric gate: verdict text starts with REJECT', /^REJECT/.test(rRegJson.verdict));

  // ---- I.5: ZERO-BASELINE FLOOR — without=0% on a test only counts a with-arm result as a gain when
  // the with-arm rate is ALSO >= 50% (not just "any success", which would trivially be "significant"
  // against a p=0 null). Sub-case A: 3/8 (37.5% < 50%) -> no_sig_change, NOT a gain. Sub-case B: 5/8
  // (62.5% >= 50%) -> significant_gain. ----
  const dirFloorA = caseDir();
  const evalsFloorA = writeEvals(dirFloorA, { skill: 'cmp-zerofloor-a', tests: [{ id: 't1', assertions: [{ id: 'a1', type: 'contains', text: 'ok' }] }] });
  const withFloorA = path.join(dirFloorA, 'with'); fs.mkdirSync(withFloorA, { recursive: true });
  const withoutFloorA = path.join(dirFloorA, 'without'); fs.mkdirSync(withoutFloorA, { recursive: true });
  writeSamples(withFloorA, 't1', okTexts(3, 5));     // 3/8 = 37.5%
  writeSamples(withoutFloorA, 't1', okTexts(0, 8));  // 0/8
  const rFloorAJson = JSON.parse(runCli(['compare', evalsFloorA, '--with', withFloorA, '--without', withoutFloorA, '--json']).stdout);
  t('zero-baseline floor: 37.5% with-rate against a 0% baseline is NOT counted a gain', rFloorAJson.perTest[0].classification === 'no_sig_change');
  t('zero-baseline floor: verdict is NO SIGNIFICANT DIFFERENCE, not KEEP/PROMOTE', /NO SIGNIFICANT DIFFERENCE/.test(rFloorAJson.verdict));

  const dirFloorB = caseDir();
  const evalsFloorB = writeEvals(dirFloorB, { skill: 'cmp-zerofloor-b', tests: [{ id: 't1', assertions: [{ id: 'a1', type: 'contains', text: 'ok' }] }] });
  const withFloorB = path.join(dirFloorB, 'with'); fs.mkdirSync(withFloorB, { recursive: true });
  const withoutFloorB = path.join(dirFloorB, 'without'); fs.mkdirSync(withoutFloorB, { recursive: true });
  writeSamples(withFloorB, 't1', okTexts(5, 3));     // 5/8 = 62.5%
  writeSamples(withoutFloorB, 't1', okTexts(0, 8));  // 0/8
  const rFloorBJson = JSON.parse(runCli(['compare', evalsFloorB, '--with', withFloorB, '--without', withoutFloorB, '--json']).stdout);
  t('zero-baseline floor: 62.5% with-rate against a 0% baseline IS counted a gain', rFloorBJson.perTest[0].classification === 'significant_gain');
  t('zero-baseline floor: verdict is KEEP/PROMOTE', /^KEEP\/PROMOTE/.test(rFloorBJson.verdict));

  // ---- I.6: determinism — same inputs compared twice (module-level AND CLI) -> byte-identical
  // result object, including every perTest pValue ----
  const E1 = E.compareArms(E.loadEvals(evalsWin).normalized, withWin, withoutWin, 8);
  const E2 = E.compareArms(E.loadEvals(evalsWin).normalized, withWin, withoutWin, 8);
  t('compare determinism: two compareArms() calls produce byte-identical JSON (incl. perTest/pValue)', JSON.stringify(E1) === JSON.stringify(E2));
  const cliDet1 = runCli(['compare', evalsWin, '--with', withWin, '--without', withoutWin, '--json']);
  const cliDet2 = runCli(['compare', evalsWin, '--with', withWin, '--without', withoutWin, '--json']);
  t('compare determinism: two CLI --json invocations produce identical stdout', cliDet1.stdout === cliDet2.stdout && cliDet1.status === cliDet2.status);

  // ---- I.7: below the new default --min-samples (8) -> INCONCLUSIVE, promotable false, exit 1;
  // an explicit lower --min-samples override makes the SAME dirs promotable ----
  const dirUnder = caseDir();
  const evalsUnder = writeEvals(dirUnder, { skill: 'cmp-undersampled', tests: [{ id: 't1', assertions: [{ id: 'a1', type: 'contains', text: 'ok' }] }] });
  const withUnder = path.join(dirUnder, 'with'); fs.mkdirSync(withUnder, { recursive: true });
  const withoutUnder = path.join(dirUnder, 'without'); fs.mkdirSync(withoutUnder, { recursive: true });
  writeSamples(withUnder, 't1', okTexts(8, 0));     // 8 samples (meets new default)
  writeSamples(withoutUnder, 't1', okTexts(0, 5));  // only 5 samples (< new default 8)

  const rUnder = runCli(['compare', evalsUnder, '--with', withUnder, '--without', withoutUnder]);
  t('below new default min-samples (8): exit 1', rUnder.status === 1);
  t('below new default min-samples (8): VERDICT is INCONCLUSIVE', /VERDICT: INCONCLUSIVE/.test(rUnder.stdout));
  t('below new default min-samples (8): NON-PROMOTABLE line printed with n=5 < 8', /NON-PROMOTABLE \(n=5 < 8\)/.test(rUnder.stdout));
  const rUnderJson = JSON.parse(runCli(['compare', evalsUnder, '--with', withUnder, '--without', withoutUnder, '--json']).stdout);
  t('below new default min-samples (8): promotable false, conclusive false', rUnderJson.promotable === false && rUnderJson.conclusive === false);
  t('below new default min-samples (8): verdict is INCONCLUSIVE', /^INCONCLUSIVE/.test(rUnderJson.verdict));

  const rUnderOverride = runCli(['compare', evalsUnder, '--with', withUnder, '--without', withoutUnder, '--min-samples', '5']);
  t('explicit --min-samples 5: same dirs now promotable, exit 0 (clear win)', rUnderOverride.status === 0);
  t('explicit --min-samples 5: VERDICT says KEEP/PROMOTE', /VERDICT: KEEP\/PROMOTE/.test(rUnderOverride.stdout));

  // ---- I.8: meta.json with numeric ms -> time reported; absent -> omitted (no fabricated 0) ----
  const dirMeta = caseDir();
  const evalsMeta = writeEvals(dirMeta, { skill: 'cmp-meta', tests: [{ id: 't1', assertions: [{ id: 'a1', type: 'contains', text: 'ok' }] }] });
  const withMeta = path.join(dirMeta, 'with'); fs.mkdirSync(withMeta, { recursive: true });
  const withoutMeta = path.join(dirMeta, 'without'); fs.mkdirSync(withoutMeta, { recursive: true });
  writeSamples(withMeta, 't1', okTexts(8, 0));
  writeSamples(withoutMeta, 't1', okTexts(0, 8));
  fs.writeFileSync(path.join(withMeta, 'meta.json'), JSON.stringify({ ms: 1234 }));
  // withoutMeta has no meta.json at all
  const r8 = runCli(['compare', evalsMeta, '--with', withMeta, '--without', withoutMeta, '--json']);
  const parsed8 = JSON.parse(r8.stdout);
  t('meta.json ms present: with.avgMs reported', parsed8.with.avgMs === 1234);
  t('meta.json absent: without.avgMs is omitted (not fabricated as 0)', !('avgMs' in parsed8.without));
  const r8text = runCli(['compare', evalsMeta, '--with', withMeta, '--without', withoutMeta]);
  t('meta.json ms present: text output shows avgMs=1234 on WITH line', /WITH\s+.*avgMs=1234/.test(r8text.stdout));

  // ---- I.9: tokens NEVER fabricated (no meta -> no token field; proxy if shown is labelled) ----
  const dir9 = caseDir();
  const evalsFile9 = writeEvals(dir9, { skill: 'cmp-tokens', tests: [{ id: 't1', assertions: [{ id: 'a1', type: 'contains', text: 'ok' }] }] });
  const withDir9 = path.join(dir9, 'with'); fs.mkdirSync(withDir9, { recursive: true });
  const withoutDir9 = path.join(dir9, 'without'); fs.mkdirSync(withoutDir9, { recursive: true });
  writeSamples(withDir9, 't1', okTexts(8, 0));
  writeSamples(withoutDir9, 't1', okTexts(0, 8));
  const r9 = runCli(['compare', evalsFile9, '--with', withDir9, '--without', withoutDir9, '--json']);
  const parsed9 = JSON.parse(r9.stdout);
  t('tokens: no meta.json -> no "tokens" field on either arm', !('tokens' in parsed9.with) && !('tokens' in parsed9.without));
  t('tokens: bytesProxy present as a distinctly-named numeric field', typeof parsed9.with.bytesProxy === 'number' && typeof parsed9.without.bytesProxy === 'number');
  // now add a meta.json with tokens on the with-arm only
  fs.writeFileSync(path.join(withDir9, 'meta.json'), JSON.stringify({ tokens: 555 }));
  const r9b = runCli(['compare', evalsFile9, '--with', withDir9, '--without', withoutDir9, '--json']);
  const parsed9b = JSON.parse(r9b.stdout);
  t('tokens: meta.json tokens present -> reported and labelled lead-recorded', parsed9b.with.tokens === 555 && parsed9b.with.tokensSource === 'lead-recorded');
  t('tokens: without-arm still has no fabricated tokens field', !('tokens' in parsed9b.without));
  const r9bText = runCli(['compare', evalsFile9, '--with', withDir9, '--without', withoutDir9]);
  t('tokens: text output labels tokens as Lead-recorded', /tokens=555 \(Lead-recorded\)/.test(r9bText.stdout));
  t('tokens: text output labels the without-arm bytes proxy honestly', /bytesProxy=\d+ \(bytes proxy, not tokens\)/.test(r9bText.stdout));

  // ---- I.10: --json shape carries perTest[] + significance{} on top of with/without/deltaPp/etc ----
  t('compare --json shape: top-level keys present', ['with', 'without', 'deltaPp', 'promotable', 'perTest', 'significance', 'verdict', 'conclusive'].every((k) => k in parsed9));
  t('compare --json shape: with/without carry passed/total/rate/samples', ['passed', 'total', 'rate', 'samples'].every((k) => k in parsed9.with && k in parsed9.without));
  t('compare --json shape: perTest entries carry id/withPass/withTotal/withoutPass/withoutTotal/classification/pValue', parsed9.perTest.every((p) => ['id', 'withPass', 'withTotal', 'withoutPass', 'withoutTotal', 'classification', 'pValue'].every((k) => k in p)));
  t('compare --json shape: significance carries gains/regressions/alpha', ['gains', 'regressions', 'alpha'].every((k) => k in parsed9.significance) && parsed9.significance.alpha === 0.05);

  // ---- I.11: usage error (missing --with/--without/evalsFile/invalid --min-samples) -> exit 2 ----
  t('compare usage: missing --with -> exit 2', runCli(['compare', evalsFile9, '--without', withoutDir9]).status === 2);
  t('compare usage: missing --without -> exit 2', runCli(['compare', evalsFile9, '--with', withDir9]).status === 2);
  t('compare usage: no evalsFile -> exit 2', runCli(['compare']).status === 2);
  t('compare usage: invalid --min-samples -> exit 2', runCli(['compare', evalsFile9, '--with', withDir9, '--without', withoutDir9, '--min-samples', 'abc']).status === 2);

  // ---- I.12: --run gate_evaluated logging for compare — note now carries gains/regressions ----
  const gateRoot = path.join(TMP, 'gate-root-compare');
  fs.mkdirSync(gateRoot, { recursive: true });
  makeLogFixture(gateRoot);
  const gateWork = path.join(gateRoot, 'work'); fs.mkdirSync(gateWork, { recursive: true });
  const gateEvalsFile = writeEvals(gateWork, { skill: 'gate-cmp', tests: [{ id: 't1', assertions: [{ id: 'a1', type: 'contains', text: 'ok' }] }] });
  const gateWith = path.join(gateWork, 'with'); fs.mkdirSync(gateWith, { recursive: true });
  const gateWithout = path.join(gateWork, 'without'); fs.mkdirSync(gateWithout, { recursive: true });
  writeSamples(gateWith, 't1', okTexts(8, 0));
  writeSamples(gateWithout, 't1', okTexts(0, 8));
  const gateRunId = 'run-gate-compare-1';
  const rGate = runCli(['compare', gateEvalsFile, '--with', gateWith, '--without', gateWithout, '--run', gateRunId], gateRoot);
  t('compare gate logging: exit 0 (KEEP/PROMOTE)', rGate.status === 0);
  const gateEvent = eventsOf(gateRoot, gateRunId).find((e) => e.event_type === 'gate_evaluated');
  t('compare gate logging: a real gate_evaluated event was appended', !!gateEvent);
  t('compare gate logging: note carries "compare <skill>: with X% vs without Y% (ΔZpp, gains=.., regressions=..) verdict"', !!gateEvent && /forge-evals compare gate-cmp: with 100% vs without 0% \(Δ100pp, gains=1, regressions=0\) KEEP\/PROMOTE/.test(gateEvent.note));
  t('compare gate logging: evidence is the evals file path', !!gateEvent && gateEvent.evidence === gateEvalsFile);
}

// ===================================================================================
// GROUP J — logGamma / twoSidedExactBinomialTest numeric sanity (pure-function unit tests, no CLI)
// ===================================================================================
{
  t('logGamma(1) === ln(0!) === 0 (within float tolerance)', Math.abs(E.logGamma(1)) < 1e-9);
  t('logGamma(2) === ln(1!) === 0 (within float tolerance)', Math.abs(E.logGamma(2)) < 1e-9);
  t('logGamma(5) === ln(4!) === ln(24) (within float tolerance)', Math.abs(E.logGamma(5) - Math.log(24)) < 1e-9);

  // hand-computed: two-sided exact binomial p(k=4, n=9, p=1/3) = 0.4927602499618978 (worked by hand:
  // P(j) = C(9,j)*2^(9-j)/3^9 for j=0..9, sum every P(j) <= P(4) -> 0.02601+0.11706+0.20485+0.10243+
  // 0.03414+0.00732+0.000915+0.0000508 ~ 0.49276)
  const pKnown = E.twoSidedExactBinomialTest(4, 9, 1 / 3);
  t('twoSidedExactBinomialTest: known small case matches hand-computed p-value within tolerance', Math.abs(pKnown - 0.4927602499618978) < 1e-9);

  // degenerate null p=0 / p=1 must be well-defined (not NaN), and match the analytic answer exactly
  t('twoSidedExactBinomialTest: p=0, k=0 -> pValue=1 (perfectly consistent with null)', E.twoSidedExactBinomialTest(0, 8, 0) === 1);
  t('twoSidedExactBinomialTest: p=0, k=3 -> pValue=0 (any success is extreme under null p=0)', E.twoSidedExactBinomialTest(3, 8, 0) === 0);
  t('twoSidedExactBinomialTest: p=1, k=8(=n) -> pValue=1', E.twoSidedExactBinomialTest(8, 8, 1) === 1);
  t('twoSidedExactBinomialTest: p=1, k=2 -> pValue=0 (any failure is extreme under null p=1)', E.twoSidedExactBinomialTest(2, 8, 1) === 0);

  // large-n sanity: must stay finite and in [0,1], never NaN/Infinity (this is exactly what raw
  // factorials would overflow on — logGamma-based log-space math must not)
  const pLargeExtreme = E.twoSidedExactBinomialTest(600, 1000, 0.5);
  t('twoSidedExactBinomialTest: large n=1000, extreme k -> finite, in [0,1], not NaN', Number.isFinite(pLargeExtreme) && pLargeExtreme >= 0 && pLargeExtreme <= 1);
  t('twoSidedExactBinomialTest: large n=1000 extreme deviation -> small p-value (statistically correct)', pLargeExtreme < 0.001);
  const pLargeCenter = E.twoSidedExactBinomialTest(5000, 10000, 0.5);
  t('twoSidedExactBinomialTest: large n=10000, k at the mean -> finite, close to 1', Number.isFinite(pLargeCenter) && pLargeCenter > 0.9);

  // classifyTest: direct unit coverage of the three classifications + both floors
  t('classifyTest: clear win (8/8 vs 0/8) -> significant_gain', E.classifyTest(8, 8, 0, 8).classification === 'significant_gain');
  t('classifyTest: clear regression (2/8 vs 8/8) -> significant_regression', E.classifyTest(2, 8, 8, 8).classification === 'significant_regression');
  t('classifyTest: zero-baseline floor blocks a 37.5% "win" (3/8 vs 0/8) -> no_sig_change', E.classifyTest(3, 8, 0, 8).classification === 'no_sig_change');
  t('classifyTest: zero-baseline floor allows a 62.5% win (5/8 vs 0/8) -> significant_gain', E.classifyTest(5, 8, 0, 8).classification === 'significant_gain');
  t('classifyTest: noise at adequate n (4/9 vs 3/9) -> no_sig_change', E.classifyTest(4, 9, 3, 9).classification === 'no_sig_change');
  t('classifyTest: identical rates -> no_sig_change', E.classifyTest(4, 8, 4, 8).classification === 'no_sig_change');
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
