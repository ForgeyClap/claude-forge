#!/usr/bin/env node
'use strict';
/**
 * forge-evals.cjs — deterministic binary-assertion scorer for the bounded skill-refine loop (WP4).
 *
 * PATTERN (verified via a watched tutorial + adversarial cross-check — "Karpathy autoresearch on
 * skills"): per skill, an `evals.json` holds BINARY assertions (word counts, forbidden/required
 * patterns, structure checks). An agent produces an output for a test prompt. A DETERMINISTIC checker
 * (this file) scores it. The agent makes ONE change to the skill text. Score improves -> git keep;
 * score drops -> git revert. This file is ONLY the scorer. The refine loop itself (max-N-iterations,
 * git checkpoint per iteration, usage-guard respected) is an owner-invoked Lead procedure governed by
 * forge-core — it does NOT live here, and this file never calls an LLM or the network to judge output.
 *
 * DETERMINISM (why no LLM lives here): the same evals.json + the same output text ALWAYS produces the
 * same score. That is what makes the refine loop's keep/revert decision trustworthy — an LLM-judged
 * score would be non-reproducible and could not safely gate a git revert.
 *
 * evals.json SCHEMA (validated strictly — unknown assertion types are a hard validation error):
 *   {
 *     "skill": "<name>",
 *     "tests": [
 *       { "id": "t1", "prompt": "<what to ask>", "expected": "<human description>",
 *         "assertions": [
 *           {"id":"a1","type":"max_words","n":300},
 *           {"type":"min_words","n":50},
 *           {"type":"required_pattern","regex":"...","flags":"i"},
 *           {"type":"forbidden_pattern","regex":"..."},
 *           {"type":"contains","text":"..."},
 *           {"type":"not_contains","text":"..."},
 *           {"type":"last_line_not_pattern","regex":"\\?\\s*$"},
 *           {"type":"first_line_max_words","n":15},
 *           {"type":"line_count_max","n":40},
 *           {"type":"json_parses"}
 *         ] }
 *     ]
 *   }
 *   Test ids and assertion ids are optional (auto `t1..tN` / `a1..aN` from array position). Every
 *   regex is compiled with try/catch — an invalid regex is a validation error, never a crash. A test
 *   with zero assertions, or an evals file with zero tests, is a validation error (an empty eval suite
 *   must never look like a pass).
 *   `first_line_max_words` / `last_line_not_pattern` use the first/last NON-EMPTY line (Windows \r\n
 *   line endings are normalized before splitting). `line_count_max` counts all lines (blank lines
 *   included), trailing-newline-only line not counted.
 *
 * CLI:
 *   node forge-evals.cjs validate <evalsFile> [--json]
 *     Schema check only. Exit 0 valid / 1 invalid.
 *   node forge-evals.cjs check <evalsFile> --test <testId> --output <outputFile> [--json]
 *     Evaluate ONE test's assertions against the output file's text. Prints per-assertion PASS/FAIL +
 *     score. Exit 0 all pass / 1 any fail.
 *   node forge-evals.cjs score <evalsFile> --outputs-dir <dir> [--json] [--run <run_id>]
 *     For each test, reads `<dir>/<testId>.txt` (falling back to `<dir>/<testId>.md`). A missing output
 *     file counts every one of that test's assertions as FAIL and is reported honestly as missing —
 *     never silently skipped. Writes nothing but stdout UNLESS --run is given, in which case ONE
 *     `gate_evaluated` event is appended via `../forge-dashboard/log-event.cjs` (agent: orchestrator,
 *     role: lead, note: "forge-evals <skill>: X/Y (Z%)", evidence: <evalsFile>). A logging failure is
 *     reported to stderr but never changes the scoring exit code. Exit 0 all pass / 1 any fail.
 *   node forge-evals.cjs compare <evalsFile> --with <dir> --without <dir> [--min-samples N] [--json] [--run <run_id>]
 *     A/B baseline gate (Anthropic skill-creator pattern): scores the SAME evalsFile against TWO output
 *     arms with the SAME scoreSuite engine — `--with` holds outputs produced WITH the skill active,
 *     `--without` holds the no-skill baseline for the identical prompts. CAVEAT: the `--without` arm MUST
 *     be dispatched without the skill text ever entering that run's context — a baseline that leaked the
 *     skill is contaminated and this file has no way to detect that; it trusts the dirs it is given.
 *     Each arm may hold multiple numbered samples per test (`<testId>.txt` or `<testId>.1.txt`,
 *     `<testId>.2.txt`, ...); `--min-samples` (default 8) sets the floor — if EITHER arm's weakest-sampled
 *     test falls short, the result is `promotable:false` / INCONCLUSIVE, because a decision made on too
 *     little data must never look authoritative. NOTE (owner-visible behavior change, 2026-07-13): the
 *     default was 3; it is now 8. A two-sided exact test at alpha=0.05 almost never reaches significance
 *     at n=3, so keeping the old default would make every real comparison INCONCLUSIVE under the new gate
 *     below — the min-samples floor and the significance gate are coupled by design, not independently
 *     tunable without thinking about both.
 *
 *     STATISTICALLY-HONEST VERDICT (2026-07-13 fix — replaces the old "pooled deltaPp > 0" promote rule,
 *     which promoted pure noise, e.g. 4/9 vs 3/9, at n=3): per test, the WITH arm's passed/total is
 *     compared against the WITHOUT arm's observed rate using a DETERMINISTIC, zero-dependency, log-space
 *     exact two-sided binomial test (`twoSidedExactBinomialTest` — chosen over a Fisher exact 2x2 test
 *     because the WITHOUT rate is a natural per-test null hypothesis probability and log-space avoids
 *     factorial overflow for larger n; see `logGamma`/`logChoose` below, Lanczos approximation, NEVER raw
 *     factorials). alpha = 0.05. Each test is classified `significant_regression` (WITH significantly
 *     WORSE), `significant_gain` (WITH significantly BETTER), or `no_sig_change`. ZERO-BASELINE FLOOR: when
 *     the WITHOUT arm's rate on a test is exactly 0%, a raw binomial test against null p=0 is trivially
 *     "significant" for even a single fluke pass, so a gain is only counted when the WITH rate on that
 *     test is ALSO >= 50% (a practical-significance floor on top of the statistical one). Symmetric
 *     CEILING FLOOR (same reasoning, mirrored — not spec-mandated in exactly these words but required to
 *     avoid the identical degenerate-p trap in the opposite direction): when WITHOUT is exactly 100%, a
 *     regression is only counted when WITH is <= 50%. ASYMMETRIC GATE: if ANY test shows a
 *     `significant_regression`, the verdict is REJECT regardless of the aggregate delta's sign (a real
 *     regression on one task is never washed out by gains elsewhere) — else if >= 1 test shows a
 *     `significant_gain`, KEEP/PROMOTE — else NO SIGNIFICANT DIFFERENCE (a non-actionable outcome; the
 *     comparison did not produce evidence either way). `deltaPp` remains in the result as INFORMATIONAL
 *     context only — it no longer drives the verdict.
 *
 * Exit codes: 0 = all assertions passed (or `validate` schema OK, or `compare` reached a CONCLUSIVE verdict
 * — PROMOTE or REJECT with `promotable:true`) · 1 = validation/data error, any assertion failed, `compare`
 * was non-promotable (INCONCLUSIVE, below `--min-samples`), or `compare` found NO SIGNIFICANT DIFFERENCE
 * (a non-actionable outcome) · 2 = usage error (missing/invalid CLI arguments).
 *
 * FORGE_PROJECT_ROOT overrides the project root used for gate-event logging (same convention as
 * forge-distill.cjs / forge-memory.cjs) — every path is built with path.join, Windows-safe. Zero npm
 * dependencies: fs/path/child_process only. NO network calls, NO LLM calls.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PROJECT_ROOT = process.env.FORGE_PROJECT_ROOT ? path.resolve(process.env.FORGE_PROJECT_ROOT) : path.resolve(__dirname, '..', '..');

const ASSERTION_TYPES = new Set([
  'max_words', 'min_words', 'required_pattern', 'forbidden_pattern', 'contains', 'not_contains',
  'last_line_not_pattern', 'first_line_max_words', 'line_count_max', 'json_parses',
]);

// ---- pure text helpers (no I/O, deterministic) ----
function wordCount(text) { const s = String(text == null ? '' : text).trim(); return s.length ? s.split(/\s+/).length : 0; }
/** All lines of `text`, \r\n / \r normalized to \n. Empty string -> []. A single trailing newline does
 *  not add a phantom empty final line; blank lines in the middle of the text are preserved. */
function allLines(text) {
  const s = String(text == null ? '' : text);
  if (s === '') return [];
  const lines = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
function nonEmptyLines(text) { return allLines(text).filter((l) => l.trim().length > 0); }
function compileRegex(pattern, flags) { return new RegExp(pattern, flags || ''); }

/** runAssertion(assertion, text) -> {id, type, pass, detail}. `assertion` must already be validated
 *  (validateEvals normalizes/checks every field) — this never throws for a well-formed assertion, but
 *  wraps regex use in try/catch as a last-resort guard against ever crashing the scorer. */
function runAssertion(a, text) {
  const s = String(text == null ? '' : text);
  try {
    switch (a.type) {
      case 'max_words': { const wc = wordCount(s); return { id: a.id, type: a.type, pass: wc <= a.n, detail: `word count ${wc} <= ${a.n}` }; }
      case 'min_words': { const wc = wordCount(s); return { id: a.id, type: a.type, pass: wc >= a.n, detail: `word count ${wc} >= ${a.n}` }; }
      case 'required_pattern': { const re = compileRegex(a.regex, a.flags); const pass = re.test(s); return { id: a.id, type: a.type, pass, detail: `/${a.regex}/${a.flags} ${pass ? 'matched' : 'did not match'}` }; }
      case 'forbidden_pattern': { const re = compileRegex(a.regex, a.flags); const matched = re.test(s); return { id: a.id, type: a.type, pass: !matched, detail: `/${a.regex}/${a.flags} ${matched ? 'matched (forbidden)' : 'did not match'}` }; }
      case 'contains': { const pass = s.includes(a.text); return { id: a.id, type: a.type, pass, detail: `text ${pass ? 'found' : 'not found'}: "${a.text}"` }; }
      case 'not_contains': { const found = s.includes(a.text); return { id: a.id, type: a.type, pass: !found, detail: `text ${found ? 'found (forbidden)' : 'not found'}: "${a.text}"` }; }
      case 'last_line_not_pattern': { const lines = nonEmptyLines(s); const last = lines.length ? lines[lines.length - 1] : ''; const re = compileRegex(a.regex, a.flags); const matched = re.test(last); return { id: a.id, type: a.type, pass: !matched, detail: `last line ${matched ? 'matches (forbidden)' : 'does not match'} /${a.regex}/${a.flags}` }; }
      case 'first_line_max_words': { const lines = nonEmptyLines(s); const first = lines.length ? lines[0] : ''; const wc = wordCount(first); return { id: a.id, type: a.type, pass: wc <= a.n, detail: `first line word count ${wc} <= ${a.n}` }; }
      case 'line_count_max': { const n = allLines(s).length; return { id: a.id, type: a.type, pass: n <= a.n, detail: `line count ${n} <= ${a.n}` }; }
      case 'json_parses': { try { JSON.parse(s); return { id: a.id, type: a.type, pass: true, detail: 'output parses as JSON' }; } catch (e) { return { id: a.id, type: a.type, pass: false, detail: `output does not parse as JSON: ${e.message}` }; } }
      default: return { id: a.id, type: a.type, pass: false, detail: `unknown assertion type '${a.type}'` };
    }
  } catch (e) { return { id: a.id, type: a.type, pass: false, detail: `assertion error: ${e.message}` }; }
}

/** validateEvals(obj) -> {valid, errors[], normalized|null}. `normalized` fills auto test/assertion
 *  ids and pre-checks every regex; it is null when invalid. Never throws. */
function validateEvals(obj) {
  const errors = [];
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) return { valid: false, errors: ['evals file must be a JSON object'], normalized: null };
  if (typeof obj.skill !== 'string' || !obj.skill.trim()) errors.push('"skill" must be a non-empty string');
  if (!Array.isArray(obj.tests)) { errors.push('"tests" must be an array'); return { valid: false, errors, normalized: null }; }
  if (obj.tests.length === 0) errors.push('no tests defined');

  const testIds = new Set();
  const normTests = [];
  obj.tests.forEach((test, ti) => {
    const tp = `tests[${ti}]`;
    if (test == null || typeof test !== 'object' || Array.isArray(test)) { errors.push(`${tp} must be an object`); return; }
    let id = test.id;
    if (id != null && typeof id !== 'string') { errors.push(`${tp}.id must be a string if present`); return; }
    id = id && String(id).trim() ? String(id).trim() : `t${ti + 1}`;
    if (testIds.has(id)) { errors.push(`duplicate test id '${id}'`); return; }
    testIds.add(id);
    if (test.prompt != null && typeof test.prompt !== 'string') errors.push(`test '${id}'.prompt must be a string if present`);
    if (test.expected != null && typeof test.expected !== 'string') errors.push(`test '${id}'.expected must be a string if present`);
    if (!Array.isArray(test.assertions) || test.assertions.length === 0) { errors.push(`test '${id}' must have a non-empty "assertions" array`); return; }

    const assertionIds = new Set();
    const normAssertions = [];
    test.assertions.forEach((a, ai) => {
      const ap = `test '${id}' assertions[${ai}]`;
      if (a == null || typeof a !== 'object' || Array.isArray(a)) { errors.push(`${ap} must be an object`); return; }
      let aid = a.id;
      if (aid != null && typeof aid !== 'string') { errors.push(`${ap}.id must be a string if present`); return; }
      aid = aid && String(aid).trim() ? String(aid).trim() : `a${ai + 1}`;
      if (assertionIds.has(aid)) { errors.push(`test '${id}': duplicate assertion id '${aid}'`); return; }
      assertionIds.add(aid);
      if (typeof a.type !== 'string' || !ASSERTION_TYPES.has(a.type)) { errors.push(`${ap}: unknown assertion type '${a.type}' (allowed: ${[...ASSERTION_TYPES].join(', ')})`); return; }
      const na = { id: aid, type: a.type };
      if (a.type === 'max_words' || a.type === 'min_words' || a.type === 'first_line_max_words' || a.type === 'line_count_max') {
        if (typeof a.n !== 'number' || !Number.isFinite(a.n) || a.n < 0) { errors.push(`${ap} (${a.type}) requires a numeric "n" >= 0`); return; }
        na.n = a.n;
      } else if (a.type === 'required_pattern' || a.type === 'forbidden_pattern' || a.type === 'last_line_not_pattern') {
        if (typeof a.regex !== 'string' || !a.regex.length) { errors.push(`${ap} (${a.type}) requires a non-empty string "regex"`); return; }
        if (a.flags != null && typeof a.flags !== 'string') { errors.push(`${ap} (${a.type}) "flags" must be a string if present`); return; }
        try { compileRegex(a.regex, a.flags || ''); } catch (e) { errors.push(`${ap} (${a.type}) invalid regex /${a.regex}/${a.flags || ''}: ${e.message}`); return; }
        na.regex = a.regex; na.flags = a.flags || '';
      } else if (a.type === 'contains' || a.type === 'not_contains') {
        if (typeof a.text !== 'string' || !a.text.length) { errors.push(`${ap} (${a.type}) requires a non-empty string "text"`); return; }
        na.text = a.text;
      }
      normAssertions.push(na);
    });
    normTests.push({ id, prompt: typeof test.prompt === 'string' ? test.prompt : '', expected: typeof test.expected === 'string' ? test.expected : '', assertions: normAssertions });
  });

  const valid = errors.length === 0;
  return { valid, errors, normalized: valid ? { skill: obj.skill, tests: normTests } : null };
}

/** loadEvals(filePath) -> same shape as validateEvals(); read/parse failures become validation errors,
 *  never a thrown exception. */
function loadEvals(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch (e) { return { valid: false, errors: [`cannot read evals file: ${e.message}`], normalized: null }; }
  let obj;
  try { obj = JSON.parse(raw); } catch (e) { return { valid: false, errors: [`invalid JSON in evals file: ${e.message}`], normalized: null }; }
  return validateEvals(obj);
}

/** checkTest(normalizedEvals, testId, text) -> {testId, results[], passed, total} | {error}. */
function checkTest(normalizedEvals, testId, text) {
  const test = normalizedEvals.tests.find((t) => t.id === testId);
  if (!test) return { error: `test '${testId}' not found in evals (skill '${normalizedEvals.skill}')` };
  const results = test.assertions.map((a) => runAssertion(a, text));
  const passed = results.filter((r) => r.pass).length;
  return { testId: test.id, results, passed, total: results.length };
}

/** Resolves `<dir>/<testId>.txt`, falling back to `<dir>/<testId>.md`. Returns null (never throws) when
 *  neither exists — including when `dir` itself does not exist. */
function resolveOutputPath(dir, testId) {
  const txt = path.join(dir, testId + '.txt');
  if (fs.existsSync(txt)) return txt;
  const md = path.join(dir, testId + '.md');
  if (fs.existsSync(md)) return md;
  return null;
}

/** scoreSuite(normalizedEvals, outputsDir) -> {skill, tests:[{id,missing,passed,total,results}], passed,
 *  total, pct}. Deterministic given a fixed filesystem state: same evals + same output files -> same
 *  result object, every time. A missing output file marks every assertion in that test FAIL, reported
 *  explicitly via `missing: true` — never silently skipped. */
function scoreSuite(normalizedEvals, outputsDir) {
  const tests = normalizedEvals.tests.map((test) => {
    const outPath = resolveOutputPath(outputsDir, test.id);
    let results, missing = false;
    if (!outPath) {
      missing = true;
      const expect = `${path.join(outputsDir, test.id + '.txt')} or ${path.join(outputsDir, test.id + '.md')}`;
      results = test.assertions.map((a) => ({ id: a.id, type: a.type, pass: false, detail: `output file missing (expected ${expect})` }));
    } else {
      const text = fs.readFileSync(outPath, 'utf8');
      results = test.assertions.map((a) => runAssertion(a, text));
    }
    const passed = results.filter((r) => r.pass).length;
    return { id: test.id, missing, passed, total: results.length, results };
  });
  const passed = tests.reduce((s, t) => s + t.passed, 0);
  const total = tests.reduce((s, t) => s + t.total, 0);
  const pct = total > 0 ? Math.round((passed / total) * 100) : 0;
  return { skill: normalizedEvals.skill, tests, passed, total, pct };
}

/** listSamples(dir, testId) -> sorted absolute paths of every output SAMPLE file for `testId` in `dir`:
 *  `<testId>.txt`/`.md` (a single sample) and/or `<testId>.<N>.txt`/`.md` (multiple numbered samples,
 *  used by `compare` to build a per-arm sample count). Missing/unreadable `dir` -> []. Never throws. */
function listSamples(dir, testId) {
  if (!dir || !fs.existsSync(dir)) return [];
  let files;
  try { files = fs.readdirSync(dir); } catch { return []; }
  const escaped = String(testId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escaped}(?:\\.(\\d+))?\\.(?:txt|md)$`);
  return files
    .map((f) => { const m = re.exec(f); return m ? { f, idx: m[1] ? parseInt(m[1], 10) : 0 } : null; })
    .filter(Boolean)
    .sort((a, b) => a.idx - b.idx || a.f.localeCompare(b.f))
    .map((m) => path.join(dir, m.f));
}

/** scoreArm(normalizedEvals, dir) -> {tests:[{id,samplesCount,passed,total}], samples, passed, total,
 *  rate, bytesProxy}. Pools ALL samples found per test (see listSamples) into one passed/total per test,
 *  then sums across tests for the arm total (`rate` uses the same Math.round convention as scoreSuite).
 *  `samples` is the MIN samplesCount across tests — the weakest-sampled test sets the arm's honest
 *  statistical n; a single well-sampled test must never mask an under-sampled one. A test with zero
 *  samples counts its assertions as failed once, mirroring scoreSuite's "missing output" honesty.
 *  `bytesProxy` sums the raw UTF-8 byte length of every sample file read — a crude proxy only, NEVER
 *  presented as a token count. */
function scoreArm(normalizedEvals, dir) {
  let bytesProxy = 0;
  const tests = normalizedEvals.tests.map((test) => {
    const samplePaths = listSamples(dir, test.id);
    let passed = 0, total = 0;
    for (const sp of samplePaths) {
      const text = fs.readFileSync(sp, 'utf8');
      bytesProxy += Buffer.byteLength(text, 'utf8');
      const results = test.assertions.map((a) => runAssertion(a, text));
      passed += results.filter((r) => r.pass).length;
      total += results.length;
    }
    if (samplePaths.length === 0) { passed = 0; total = test.assertions.length; }
    return { id: test.id, samplesCount: samplePaths.length, passed, total };
  });
  const samples = tests.length ? Math.min(...tests.map((t) => t.samplesCount)) : 0;
  const passed = tests.reduce((s, t) => s + t.passed, 0);
  const total = tests.reduce((s, t) => s + t.total, 0);
  const rate = total > 0 ? Math.round((passed / total) * 100) : 0;
  return { tests, samples, passed, total, rate, bytesProxy };
}

/** readArmMeta(dir) -> {ms?, tokens?} | null. Reads `<dir>/meta.json` best-effort; only numeric `ms` /
 *  `tokens` fields are honored (Lead-recorded values, e.g. real dispatch latency/usage). Missing file,
 *  unreadable JSON, or non-numeric fields -> those fields are simply absent — NEVER fabricated as 0.
 *  Never throws. */
function readArmMeta(dir) {
  const p = path.join(dir, 'meta.json');
  if (!fs.existsSync(p)) return null;
  let obj;
  try { obj = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
  const meta = {};
  if (typeof obj.ms === 'number' && Number.isFinite(obj.ms)) meta.ms = obj.ms;
  if (typeof obj.tokens === 'number' && Number.isFinite(obj.tokens)) meta.tokens = obj.tokens;
  return Object.keys(meta).length ? meta : null;
}

// ---- statistics helpers (zero-dep, deterministic, log-space exact binomial test — NEVER raw
// factorials, which overflow around n=170 in plain floating-point math) ----

/** logGamma(x) -> ln(Gamma(x)), Lanczos approximation (g=7, 9-term coefficients — the standard
 *  double-precision Lanczos series). Only ever called here with x >= 1 (via logChoose on non-negative
 *  integers + 1), but the reflection formula branch is kept for defensiveness / general correctness. */
const LANCZOS_G = 7;
const LANCZOS_COEF = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];
function logGamma(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const xm1 = x - 1;
  let a = LANCZOS_COEF[0];
  const t = xm1 + LANCZOS_G + 0.5;
  for (let i = 1; i < LANCZOS_COEF.length; i++) a += LANCZOS_COEF[i] / (xm1 + i);
  return 0.5 * Math.log(2 * Math.PI) + (xm1 + 0.5) * Math.log(t) - t + Math.log(a);
}
/** logChoose(n,k) -> ln(C(n,k)) via logGamma — never computes n! directly. */
function logChoose(n, k) { return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1); }
/** logBinomPmf(k,n,p) -> ln(P(X=k)) for X ~ Binomial(n,p). p<=0 and p>=1 are handled explicitly (not by
 *  falling through to `k*Math.log(p)`, which produces NaN for the 0*-Infinity case at k=0,p=0 in JS) —
 *  this degrades to a clean, well-defined 0 or -Infinity at the boundary rather than NaN. */
function logBinomPmf(k, n, p) {
  if (p <= 0) return k === 0 ? 0 : -Infinity;
  if (p >= 1) return k === n ? 0 : -Infinity;
  return logChoose(n, k) + k * Math.log(p) + (n - k) * Math.log(1 - p);
}
/** twoSidedExactBinomialTest(k, n, p) -> exact two-sided p-value for observing k successes out of n
 *  trials under the null X ~ Binomial(n,p): the sum of P(X=j) over every j whose probability is <= the
 *  observed outcome's probability (the standard "equal-or-more-extreme" exact binomial method). Computed
 *  entirely in log space (logBinomPmf) so it never overflows/NaNs for large n; degrades correctly to a
 *  clean 0 or 1 at p=0/p=1 (verified: JS's `-Infinity <= -Infinity` and `-Infinity <= <finite>` both
 *  evaluate true, so the boundary sums land on exactly {0,1} with no special-casing needed here). */
const SIGNIFICANCE_ALPHA = 0.05;
function twoSidedExactBinomialTest(k, n, p) {
  if (n === 0) return 1;
  const pClamped = Math.min(1, Math.max(0, p));
  const logPmfs = [];
  for (let j = 0; j <= n; j++) logPmfs.push(logBinomPmf(j, n, pClamped));
  const observed = logPmfs[k];
  const EPS = 1e-7; // additive log-space tolerance ~ observed*(1+1e-7) in linear space
  let total = 0;
  for (let j = 0; j <= n; j++) if (logPmfs[j] <= observed + EPS) total += Math.exp(logPmfs[j]);
  return Math.min(1, total);
}

/** classifyTest(withPass, withTotal, withoutPass, withoutTotal) -> {pValue, classification}. See the
 *  header comment for the zero-baseline / ceiling floors and the asymmetric-gate rationale. */
function classifyTest(withPass, withTotal, withoutPass, withoutTotal) {
  const withRate = withTotal > 0 ? withPass / withTotal : 0;
  const withoutRate = withoutTotal > 0 ? withoutPass / withoutTotal : 0;
  if (withoutRate === 0) {
    const pValue = twoSidedExactBinomialTest(withPass, withTotal, 0);
    return { pValue, classification: pValue < SIGNIFICANCE_ALPHA && withRate >= 0.5 ? 'significant_gain' : 'no_sig_change' };
  }
  if (withoutRate === 1) {
    const pValue = twoSidedExactBinomialTest(withPass, withTotal, 1);
    return { pValue, classification: pValue < SIGNIFICANCE_ALPHA && withRate <= 0.5 ? 'significant_regression' : 'no_sig_change' };
  }
  const pValue = twoSidedExactBinomialTest(withPass, withTotal, withoutRate);
  if (pValue >= SIGNIFICANCE_ALPHA) return { pValue, classification: 'no_sig_change' };
  return { pValue, classification: withRate < withoutRate ? 'significant_regression' : 'significant_gain' };
}

/** compareArms(normalizedEvals, withDir, withoutDir, minSamples) -> the full A/B result object (same
 *  shape printed / emitted as --json). `promotable` requires BOTH arms to reach `minSamples`; when false
 *  the verdict is always INCONCLUSIVE regardless of any test's classification — a decision made on too
 *  little data must never look authoritative. `deltaPp` (withRate - withoutRate, whole percentage points)
 *  is INFORMATIONAL ONLY — see the header comment for the real, per-test significance-driven verdict.
 *  `conclusive` is true only when `promotable` AND the verdict is an actionable PROMOTE or REJECT (false
 *  for INCONCLUSIVE and for NO SIGNIFICANT DIFFERENCE) — the CLI's exit code is driven by this field.
 *  Deterministic given a fixed filesystem state: same evals + same arm dirs -> same result object. */
function compareArms(normalizedEvals, withDir, withoutDir, minSamples) {
  const withArm = scoreArm(normalizedEvals, withDir);
  const withoutArm = scoreArm(normalizedEvals, withoutDir);
  const withMeta = readArmMeta(withDir);
  const withoutMeta = readArmMeta(withoutDir);
  const armView = (arm, meta) => Object.assign(
    { passed: arm.passed, total: arm.total, rate: arm.rate, samples: arm.samples, bytesProxy: arm.bytesProxy, tests: arm.tests },
    meta && meta.ms != null ? { avgMs: meta.ms } : {},
    meta && meta.tokens != null ? { tokens: meta.tokens, tokensSource: 'lead-recorded' } : {},
  );
  const promotable = withArm.samples >= minSamples && withoutArm.samples >= minSamples;
  const deltaPp = withArm.rate - withoutArm.rate;

  const perTest = withArm.tests.map((wt, i) => {
    const ot = withoutArm.tests[i];
    const { pValue, classification } = classifyTest(wt.passed, wt.total, ot.passed, ot.total);
    return { id: wt.id, withPass: wt.passed, withTotal: wt.total, withoutPass: ot.passed, withoutTotal: ot.total, classification, pValue };
  });
  const regressions = perTest.filter((pt) => pt.classification === 'significant_regression');
  const gains = perTest.filter((pt) => pt.classification === 'significant_gain');
  const significance = { gains: gains.length, regressions: regressions.length, alpha: SIGNIFICANCE_ALPHA };

  let verdict, conclusive;
  if (!promotable) { verdict = `INCONCLUSIVE (need >= ${minSamples} samples per arm)`; conclusive = false; }
  else if (regressions.length > 0) { verdict = `REJECT (regressed ${regressions.length} task(s): ${regressions.map((r) => r.id).join(', ')})`; conclusive = true; }
  else if (gains.length > 0) { verdict = `KEEP/PROMOTE (significant gain on ${gains.length} task(s), 0 regressions)`; conclusive = true; }
  else { verdict = `NO SIGNIFICANT DIFFERENCE (delta not significant at alpha=${SIGNIFICANCE_ALPHA})`; conclusive = false; }

  return {
    skill: normalizedEvals.skill, minSamples, with: armView(withArm, withMeta), without: armView(withoutArm, withoutMeta),
    deltaPp, promotable, perTest, significance, verdict, conclusive,
  };
}

/** Best-effort: append ONE real `gate_evaluated` event via log-event.cjs. Never throws — a logging
 *  failure is returned as {ok:false, reason}, never invalidates the score itself (caller decides). */
function logGateEvaluated(runId, root, note, evidence) {
  const logEventPath = path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs');
  const payload = JSON.stringify({ agent: 'orchestrator', role: 'lead', note, evidence });
  const r = spawnSync(process.execPath, [logEventPath, runId, 'gate_evaluated', payload], { encoding: 'utf8' });
  if (r.error) return { ok: false, reason: r.error.message };
  if (r.status !== 0) return { ok: false, reason: (r.stderr || r.stdout || 'log-event.cjs exited ' + r.status).toString().trim() };
  return { ok: true };
}

// ---- CLI formatting ----
function formatValidateResult(loaded) {
  if (!loaded.valid) return loaded.errors.map((e) => 'ERROR: ' + e).join('\n');
  const n = loaded.normalized;
  const totalAssertions = n.tests.reduce((s, t) => s + t.assertions.length, 0);
  return `VALID: ${n.skill} (${n.tests.length} tests, ${totalAssertions} assertions)`;
}
function formatCheckResult(r) {
  const lines = r.results.map((res) => `  ${res.pass ? 'PASS' : 'FAIL'} ${res.id} (${res.type}): ${res.detail}`);
  lines.push(`${r.testId}: ${r.passed}/${r.total} passed`);
  return lines.join('\n');
}
function formatScoreTable(result) {
  const lines = [`SKILL ${result.skill}`];
  for (const t of result.tests) {
    const status = t.passed === t.total ? 'PASS' : 'FAIL';
    lines.push(`${t.id}  ${status}  ${t.passed}/${t.total}${t.missing ? '  (missing output)' : ''}`);
  }
  lines.push(`SCORE ${result.passed}/${result.total} (${result.pct}%)`);
  return lines.join('\n');
}
/** formatCompareResult(result) -> the human-readable `compare` report: per-arm totals (with optional
 *  avgMs / Lead-recorded tokens / labelled bytes proxy), a per-test with-vs-without breakdown, a per-test
 *  SIGNIFICANCE table (classification + p-value), an explicit NON-PROMOTABLE line when applicable, the
 *  (informational) delta, and the verdict. */
function formatCompareResult(r) {
  const armLine = (label, a) => {
    let s = `${label}  ${a.passed}/${a.total} (${a.rate}%)  samples=${a.samples}`;
    if (a.avgMs != null) s += `  avgMs=${a.avgMs}`;
    if (a.tokens != null) s += `  tokens=${a.tokens} (Lead-recorded)`;
    else if (a.bytesProxy != null) s += `  bytesProxy=${a.bytesProxy} (bytes proxy, not tokens)`;
    return s;
  };
  const lines = [`SKILL ${r.skill} — compare (min-samples=${r.minSamples})`, armLine('WITH   ', r.with), armLine('WITHOUT', r.without), '', 'Per-test:'];
  for (const wt of r.with.tests) {
    const ot = r.without.tests.find((x) => x.id === wt.id) || { passed: 0, total: wt.total, samplesCount: 0 };
    lines.push(`  ${wt.id}  with ${wt.passed}/${wt.total} (n=${wt.samplesCount})  vs  without ${ot.passed}/${ot.total} (n=${ot.samplesCount})`);
  }
  lines.push('', `Significance (alpha=${r.significance.alpha}):`);
  for (const pt of r.perTest) {
    lines.push(`  ${pt.id}  ${pt.classification}  (p=${pt.pValue.toFixed(4)})`);
  }
  lines.push('', `gains=${r.significance.gains}  regressions=${r.significance.regressions}`);
  if (!r.promotable) lines.push(`NON-PROMOTABLE (n=${Math.min(r.with.samples, r.without.samples)} < ${r.minSamples})`);
  lines.push(`DELTA ${r.deltaPp}pp (informational only)`);
  lines.push(`VERDICT: ${r.verdict}`);
  return lines.join('\n');
}

function parseArgs(argv) {
  const opts = { cmd: argv[0] || null, evalsFile: null, testId: null, outputFile: null, outputsDir: null, withDir: null, withoutDir: null, minSamples: null, runId: null, json: false };
  let i = 1;
  if (argv[i] != null && !String(argv[i]).startsWith('--')) { opts.evalsFile = argv[i]; i++; }
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--test') opts.testId = argv[++i];
    else if (a === '--output') opts.outputFile = argv[++i];
    else if (a === '--outputs-dir') opts.outputsDir = argv[++i];
    else if (a === '--with') opts.withDir = argv[++i];
    else if (a === '--without') opts.withoutDir = argv[++i];
    else if (a === '--min-samples') opts.minSamples = argv[++i];
    else if (a === '--run') opts.runId = argv[++i];
    else if (a === '--json') opts.json = true;
  }
  return opts;
}
function printUsage() {
  console.error('Usage: node forge-evals.cjs validate <evalsFile> [--json]');
  console.error('       node forge-evals.cjs check <evalsFile> --test <testId> --output <outputFile> [--json]');
  console.error('       node forge-evals.cjs score <evalsFile> --outputs-dir <dir> [--json] [--run <run_id>]');
  console.error('       node forge-evals.cjs compare <evalsFile> --with <dir> --without <dir> [--min-samples N (default 8)] [--json] [--run <run_id>]');
}

module.exports = {
  ASSERTION_TYPES, wordCount, allLines, nonEmptyLines, runAssertion, validateEvals, loadEvals,
  checkTest, resolveOutputPath, scoreSuite, listSamples, scoreArm, readArmMeta, compareArms,
  logGamma, logChoose, logBinomPmf, twoSidedExactBinomialTest, classifyTest, SIGNIFICANCE_ALPHA,
  logGateEvaluated, formatValidateResult, formatCheckResult, formatScoreTable, formatCompareResult,
  parseArgs,
};

// ---- CLI ----
if (require.main === module) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (!opts.cmd || !['validate', 'check', 'score', 'compare'].includes(opts.cmd)) { printUsage(); process.exitCode = 2; }
    else if (!opts.evalsFile) { console.error(`forge-evals: <evalsFile> is required for '${opts.cmd}'`); process.exitCode = 2; }
    else if (opts.cmd === 'validate') {
      const loaded = loadEvals(opts.evalsFile);
      if (opts.json) {
        console.log(JSON.stringify(loaded.valid
          ? { valid: true, errors: [], skill: loaded.normalized.skill, tests: loaded.normalized.tests.length, assertions: loaded.normalized.tests.reduce((s, t) => s + t.assertions.length, 0) }
          : { valid: false, errors: loaded.errors }));
      } else console.log(formatValidateResult(loaded));
      process.exitCode = loaded.valid ? 0 : 1;
    } else if (opts.cmd === 'check') {
      if (!opts.testId) { console.error('forge-evals: check requires --test <testId>'); process.exitCode = 2; }
      else if (!opts.outputFile) { console.error('forge-evals: check requires --output <outputFile>'); process.exitCode = 2; }
      else {
        const loaded = loadEvals(opts.evalsFile);
        if (!loaded.valid) { console.error(loaded.errors.map((e) => 'ERROR: ' + e).join('\n')); process.exitCode = 1; }
        else {
          let text;
          try { text = fs.readFileSync(opts.outputFile, 'utf8'); }
          catch (e) { console.error(`forge-evals: cannot read output file '${opts.outputFile}': ${e.message}`); process.exitCode = 1; }
          if (text !== undefined) {
            const r = checkTest(loaded.normalized, opts.testId, text);
            if (r.error) { console.error('forge-evals: ' + r.error); process.exitCode = 1; }
            else {
              if (opts.json) console.log(JSON.stringify(r)); else console.log(formatCheckResult(r));
              process.exitCode = r.passed === r.total ? 0 : 1;
            }
          }
        }
      }
    } else if (opts.cmd === 'score') {
      if (!opts.outputsDir) { console.error('forge-evals: score requires --outputs-dir <dir>'); process.exitCode = 2; }
      else {
        const loaded = loadEvals(opts.evalsFile);
        if (!loaded.valid) { console.error(loaded.errors.map((e) => 'ERROR: ' + e).join('\n')); process.exitCode = 1; }
        else {
          const result = scoreSuite(loaded.normalized, opts.outputsDir);
          let logged = null;
          if (opts.runId) {
            const note = `forge-evals ${result.skill}: ${result.passed}/${result.total} (${result.pct}%)`;
            logged = logGateEvaluated(opts.runId, PROJECT_ROOT, note, opts.evalsFile);
            if (logged.ok === false) console.error('forge-evals: gate_evaluated logging failed (score result still valid): ' + logged.reason);
          }
          if (opts.json) console.log(JSON.stringify(Object.assign({}, result, { logged })));
          else console.log(formatScoreTable(result));
          process.exitCode = result.passed === result.total ? 0 : 1;
        }
      }
    } else if (opts.cmd === 'compare') {
      if (!opts.withDir) { console.error('forge-evals: compare requires --with <dir>'); process.exitCode = 2; }
      else if (!opts.withoutDir) { console.error('forge-evals: compare requires --without <dir>'); process.exitCode = 2; }
      else if (opts.minSamples != null && (!Number.isFinite(Number(opts.minSamples)) || Number(opts.minSamples) < 0)) {
        console.error('forge-evals: --min-samples must be a non-negative number'); process.exitCode = 2;
      } else {
        const minSamples = opts.minSamples != null ? Number(opts.minSamples) : 8;
        const loaded = loadEvals(opts.evalsFile);
        if (!loaded.valid) { console.error(loaded.errors.map((e) => 'ERROR: ' + e).join('\n')); process.exitCode = 1; }
        else {
          const result = compareArms(loaded.normalized, opts.withDir, opts.withoutDir, minSamples);
          let logged = null;
          if (opts.runId) {
            const note = `forge-evals compare ${result.skill}: with ${result.with.rate}% vs without ${result.without.rate}% (Δ${result.deltaPp}pp, gains=${result.significance.gains}, regressions=${result.significance.regressions}) ${result.verdict}`;
            logged = logGateEvaluated(opts.runId, PROJECT_ROOT, note, opts.evalsFile);
            if (logged.ok === false) console.error('forge-evals: gate_evaluated logging failed (compare result still valid): ' + logged.reason);
          }
          if (opts.json) console.log(JSON.stringify(Object.assign({}, result, { logged })));
          else console.log(formatCompareResult(result));
          process.exitCode = result.conclusive ? 0 : 1;
        }
      }
    }
  } catch (e) { console.error('forge-evals: ' + e.message); process.exitCode = 1; }
}
