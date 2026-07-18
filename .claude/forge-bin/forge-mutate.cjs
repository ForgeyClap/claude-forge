#!/usr/bin/env node
'use strict';
/**
 * forge-mutate.cjs — zero-dependency MUTATION TESTING tool for Forge (WP3 Spoor A, 2026-07-14).
 *
 * WHY: a green test suite proves nothing about whether the tests actually PIN the logic down — this
 * project has already seen a 1185-green-tests suite hide an untested critical file, and a real fix get
 * silently gutted while every test stayed green. Mutation testing measures this directly: mutate the
 * source in small, meaningful ways and count how many mutants the EXISTING suite actually kills.
 *
 * HOW IT WORKS
 *   1. Read the target module's source as text. Generate MUTANTS: one-at-a-time small source changes
 *      (see OPERATORS below). Each mutant = the original source with exactly ONE change.
 *   2. For each mutant: copy the mutant into an ISOLATED os.tmpdir() working copy (never the real
 *      file), run `node --check` on it first (a mutant that doesn't parse is SKIPPED, not scored), then
 *      run the paired test suite via spawnSync against the copy. KILLED = suite fails / exit != 0 (or
 *      times out). SURVIVED = suite stays green.
 *   3. Report total/killed/survived/score + every SURVIVOR's exact line + mutation (a survivor is
 *      untested logic).
 *
 * MUTATION OPERATORS (deterministic, text/regex-based — NOT a full AST mutator; documented limitation):
 *   comparators (=== <-> !==, == <-> !=, < <-> <=, > <-> >=, < <-> >), boolean logic (&& <-> ||, negate
 *   an `if` guard's condition), return values (true <-> false, `return ident;` -> `return true;`),
 *   integer literals (0 -> 1, 1 -> 0, N -> N+1), guard-killing (`if (cond)` forced to `true`/`false`),
 *   and a `.replace(x, 'text')` call's replacement-text argument emptied. A lightweight string/comment
 *   MASK (built by a small state-machine scanner, not a real parser) keeps every operator OUT of
 *   comments and string/template literal bodies EXCEPT the `.replace()` operator, which deliberately
 *   targets a string-literal argument — it only skips when the `.replace(` call ITSELF sits inside a
 *   comment/string. KNOWN LIMITATION: `${...}` interpolations inside a template literal are treated as
 *   inert text (masked), and division vs. regex-literal ambiguity is not resolved — an operator could in
 *   rare cases fire inside a regex literal. Every chosen operator swaps a token for another
 *   syntactically-equivalent-shape token inside an already-valid grammar slot, so in practice this
 *   operator set essentially never produces a non-parsing mutant by construction — the `node --check`
 *   skip gate is still always run (a real, required safety net), and its skip/count-exclusion behavior
 *   is proven in the test file via an explicit, documented `opts.mutantsOverride` test-only seam (see
 *   forge-mutate.test.cjs) rather than relying on the generator to spontaneously produce one.
 *
 * HARD SAFETY GUARANTEES
 *   - NEVER overwrites the real target file or any real project file. All mutant writes happen inside a
 *     dedicated `os.mkdtempSync(os.tmpdir()/forge-mutate-*)` directory, deleted when the run finishes.
 *   - If the baseline suite (unmodified source) is not green, the tool REFUSES to run any mutants and
 *     reports an honest error — it never reports a red baseline's mutants as "killed".
 *   - `--seed` makes `--sample N` a reproducible, deterministic subset (no `Math.random`).
 *   - A mutant that times out is KILLED (the suite hung = the mutant was detected), labeled separately
 *     as `killedByTimeout` so it is never confused with a normal assertion failure.
 *
 * CLI:
 *   node forge-mutate.cjs <targetModule.cjs> [--test <suite.test.cjs>] [--json] [--sample N] [--seed S]
 *     [--timeout <ms>] [--baseline-timeout <ms>]
 *     --test              test suite to run per mutant (default: <target> with .cjs -> .test.cjs)
 *     --json              print the full JSON report
 *     --sample            reproducible sample of N mutants instead of the full set
 *     --seed              seed string for --sample (default: a fixed built-in seed — always reproducible)
 *     --timeout <ms>      raise BOTH the baseline and the per-mutant test-suite timeout (default: 20000ms
 *                         each). Needed for a genuinely slow-but-healthy suite (e.g. one that legitimately
 *                         takes ~27s) that would otherwise be misreported as "baseline is not green" purely
 *                         because it didn't finish inside the default 20s window — a TIMEOUT is not the
 *                         same thing as a real red baseline (see runSuite()'s timedOut classification).
 *     --baseline-timeout <ms>  raise ONLY the baseline timeout (e.g. when the baseline run alone needs more
 *                         room but each individual mutant run should still fail fast on a genuine break).
 *                         Overrides --timeout's value for the baseline specifically when both are given.
 *   Exit code: 0 on a completed (honest) run regardless of score; 1 on a real failure (bad args, missing
 *   files, a red baseline, or — should it ever happen — the real target file changing during the run).
 *   A red baseline caused by a genuine assertion failure is STILL refused regardless of --timeout/
 *   --baseline-timeout — these flags only ever raise the ceiling before a slow-but-healthy run is killed;
 *   they can never turn a real failure into a pass (see runMutationLoop: `if (!baseline.ok) return
 *   {ok:false, ...}` fires on ANY non-green baseline, timeout or not).
 *
 * Module API: { buildMask, lineOf, generateMutants, sampleMutants, applyMutant, commonAncestorDir,
 *   findClaudeAncestor, prepareWorkdir, checkParses, runSuite, runMutationTesting, printSummary, parseArgs,
 *   resolveTimeouts, OPERATORS }
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const NODE = process.execPath;

// ---- string/comment mask (small state-machine scanner, not a real parser) ----
function buildMask(source) {
  const n = source.length;
  const mask = new Uint8Array(n);
  const S = { CODE: 0, LINE: 1, BLOCK: 2, SQ: 3, DQ: 4, TL: 5 };
  let state = S.CODE;
  let i = 0;
  while (i < n) {
    const c = source[i];
    if (state === S.CODE) {
      if (c === '/' && source[i + 1] === '/') { mask[i] = 1; mask[i + 1] = 1; state = S.LINE; i += 2; continue; }
      if (c === '/' && source[i + 1] === '*') { mask[i] = 1; mask[i + 1] = 1; state = S.BLOCK; i += 2; continue; }
      if (c === "'") { mask[i] = 1; state = S.SQ; i++; continue; }
      if (c === '"') { mask[i] = 1; state = S.DQ; i++; continue; }
      if (c === '`') { mask[i] = 1; state = S.TL; i++; continue; }
      i++; continue;
    }
    if (state === S.LINE) { mask[i] = 1; if (c === '\n') state = S.CODE; i++; continue; }
    if (state === S.BLOCK) { mask[i] = 1; if (c === '*' && source[i + 1] === '/') { mask[i + 1] = 1; i += 2; state = S.CODE; continue; } i++; continue; }
    // string / template literal body
    mask[i] = 1;
    if (c === '\\') { if (i + 1 < n) mask[i + 1] = 1; i += 2; continue; }
    const closer = state === S.SQ ? "'" : state === S.DQ ? '"' : '`';
    if (c === closer) state = S.CODE;
    i++;
  }
  return mask;
}

function lineOf(source, index) {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) if (source[i] === '\n') line++;
  return line;
}

// ---- regex-based operators: each finds a token and computes a same-shape replacement ----
const IDENT_EXCLUDE = new Set(['true', 'false', 'null', 'undefined', 'this', 'super']);
const OPERATORS = [
  { id: 'eqStrict', desc: 'strict equality === -> !==', regex: /===(?!=)/g, replace: () => '!==' },
  { id: 'neqStrict', desc: 'strict inequality !== -> ===', regex: /!==/g, replace: () => '===' },
  { id: 'eqLoose', desc: 'loose equality == -> !=', regex: /(?<![!=])==(?!=)/g, replace: () => '!=' },
  { id: 'neqLoose', desc: 'loose inequality != -> ==', regex: /!=(?!=)/g, replace: () => '==' },
  { id: 'ltToLte', desc: 'comparator < -> <=', regex: /<(?![=<])/g, replace: () => '<=' },
  { id: 'lteToLt', desc: 'comparator <= -> <', regex: /<=/g, replace: () => '<' },
  { id: 'gtToGte', desc: 'comparator > -> >=', regex: /(?<!=)>(?![=>])/g, replace: () => '>=' },
  { id: 'gteToGt', desc: 'comparator >= -> >', regex: /(?<!=)>=/g, replace: () => '>' },
  { id: 'ltToGt', desc: 'comparator < -> >', regex: /<(?![=<])/g, replace: () => '>' },
  { id: 'gtToLt', desc: 'comparator > -> <', regex: /(?<!=)>(?![=>])/g, replace: () => '<' },
  { id: 'andToOr', desc: 'boolean && -> ||', regex: /&&/g, replace: () => '||' },
  { id: 'orToAnd', desc: 'boolean || -> &&', regex: /\|\|/g, replace: () => '&&' },
  { id: 'returnTrueToFalse', desc: 'return true -> return false', regex: /\breturn(\s+)true\b/g, replace: (m) => 'return' + m[1] + 'false' },
  { id: 'returnFalseToTrue', desc: 'return false -> return true', regex: /\breturn(\s+)false\b/g, replace: (m) => 'return' + m[1] + 'true' },
  {
    id: 'returnIdentToTrue', desc: 'return <identifier>; -> return true;',
    regex: /\breturn(\s+)([A-Za-z_$][A-Za-z0-9_$]*)\s*;/g,
    replace: (m) => 'return' + m[1] + 'true;',
    filter: (m) => !IDENT_EXCLUDE.has(m[2]),
  },
  { id: 'zeroToOne', desc: 'numeric literal 0 -> 1', regex: /(?<![\w.$])0(?![\w.])/g, replace: () => '1' },
  { id: 'oneToZero', desc: 'numeric literal 1 -> 0', regex: /(?<![\w.$])1(?![\w.])/g, replace: () => '0' },
  { id: 'numPlusOne', desc: 'integer literal N -> N+1', regex: /(?<![\w.$])([2-9]|[1-9]\d+)(?![\w.])/g, replace: (m) => String(Number(m[0]) + 1) },
  {
    id: 'emptyReplaceArg', desc: '.replace(x, \'text\') replacement text -> empty string',
    regex: /\.replace\(([^,()]+),\s*(['"])((?:\\.|(?!\2)[^\\])+)\2\)/g,
    replace: (m) => '.replace(' + m[1] + ', ' + m[2] + m[2] + ')',
  },
];

function scanOperator(source, mask, op) {
  const out = [];
  const re = new RegExp(op.regex.source, op.regex.flags);
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(source))) {
    const idx = m.index;
    const advance = () => { if (re.lastIndex === idx) re.lastIndex = idx + 1; };
    if (mask[idx]) { advance(); continue; }
    if (op.filter && !op.filter(m)) { advance(); continue; }
    const replacement = op.replace(m);
    if (replacement === m[0]) { advance(); continue; }
    out.push({ id: op.id, description: op.desc, line: lineOf(source, idx), index: idx, length: m[0].length, original: m[0], replacement });
    advance();
  }
  return out;
}

// guard-killing + negation operators need paren matching, not a single regex
function matchParen(source, openIdx, mask) {
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    if (mask[i]) continue;
    if (source[i] === '(') depth++;
    else if (source[i] === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}
function findIfMutants(source, mask) {
  const out = [];
  const re = /\bif\s*\(/g;
  let m;
  while ((m = re.exec(source))) {
    const idx = m.index;
    if (mask[idx]) continue;
    const openIdx = idx + m[0].length - 1;
    const closeIdx = matchParen(source, openIdx, mask);
    if (closeIdx === -1) continue;
    const condStart = openIdx + 1, condEnd = closeIdx;
    const cond = source.slice(condStart, condEnd);
    const condTrim = cond.trim();
    if (!condTrim) continue;
    const line = lineOf(source, idx);
    if (condTrim !== 'true') out.push({ id: 'forceIfTrue', description: 'force if-guard condition to `true`', line, index: condStart, length: condEnd - condStart, original: cond, replacement: 'true' });
    if (condTrim !== 'false') out.push({ id: 'forceIfFalse', description: 'force if-guard condition to `false`', line, index: condStart, length: condEnd - condStart, original: cond, replacement: 'false' });
    out.push({ id: 'negateCondition', description: 'negate if-guard condition (wrap in !(...))', line, index: condStart, length: condEnd - condStart, original: cond, replacement: '!(' + cond + ')' });
  }
  return out;
}

function generateMutants(source) {
  const mask = buildMask(source);
  let all = [];
  for (const op of OPERATORS) all = all.concat(scanOperator(source, mask, op));
  all = all.concat(findIfMutants(source, mask));
  all.sort((a, b) => a.index - b.index || a.id.localeCompare(b.id));
  return all;
}

function applyMutant(source, mut) {
  return source.slice(0, mut.index) + mut.replacement + source.slice(mut.index + mut.length);
}

// ---- deterministic seeded sampling (no Math.random) ----
function seedToUint32(seed) {
  const h = crypto.createHash('sha256').update(String(seed == null ? 'forge-mutate-default-seed' : seed)).digest();
  return h.readUInt32BE(0);
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function sampleMutants(mutants, n, seed) {
  const rng = mulberry32(seedToUint32(seed));
  const arr = mutants.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
  }
  return arr.slice(0, n).sort((a, b) => a.index - b.index);
}

// ---- isolated temp-dir copy (relative sibling requires must keep working) ----
const SKIP_DIRS = new Set(['node_modules', '.git', 'forge-runs', 'dist', 'build', '.next', 'coverage', '.cache']);
const MAX_COPY_FILES = 20000;
const MAX_COPY_DEPTH = 12;

function commonAncestorDir(a, b) {
  const pa = path.resolve(a).split(path.sep), pb = path.resolve(b).split(path.sep);
  const out = [];
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) { if (pa[i] === pb[i]) out.push(pa[i]); else break; }
  if (out.length === 0) throw new Error('target and test files share no common ancestor directory');
  return out.join(path.sep) || path.sep;
}
// Find the nearest ancestor directory literally named ".claude" (Forge's project-local config root),
// walking up from startDir. Bounded to 40 levels so it can never loop forever on a pathological
// filesystem. Returns null (never escapes further) when no ".claude" ancestor exists at all — this
// keeps the widening below bounded to "this project's .claude/ folder", never any parent beyond it.
function findClaudeAncestor(startDir) {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 40; i++) {
    if (path.basename(dir) === '.claude') return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // hit filesystem root without finding one
    dir = parent;
  }
  return null;
}
function copyTree(src, dst, depth, counter) {
  if (depth > MAX_COPY_DEPTH) throw new Error('directory tree too deep to safely mirror for isolation (depth > ' + MAX_COPY_DEPTH + ')');
  fs.mkdirSync(dst, { recursive: true });
  let entries;
  try { entries = fs.readdirSync(src, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) copyTree(path.join(src, e.name), path.join(dst, e.name), depth + 1, counter); continue; }
    if (!e.isFile()) continue;
    counter.n++;
    if (counter.n > MAX_COPY_FILES) throw new Error('too many files to safely mirror for isolation (> ' + MAX_COPY_FILES + ') — keep target+test files in the same directory');
    fs.copyFileSync(path.join(src, e.name), path.join(dst, e.name));
  }
}
// NEVER writes anywhere except a fresh os.tmpdir() mkdtemp directory.
function prepareWorkdir(targetPath, testPath) {
  const targetAbs = path.resolve(targetPath), testAbs = path.resolve(testPath);
  const targetDir = path.dirname(targetAbs), testDir = path.dirname(testAbs);
  let sharedRoot = targetDir === testDir ? targetDir : commonAncestorDir(targetDir, testDir);
  // Widen sharedRoot to the nearest ".claude" ancestor when BOTH target+test live under one, so a test
  // that reaches into a SIBLING directory via `path.join(__dirname, '..', 'other-dir', ...)` (e.g. a
  // forge-bin test requiring `../forge-dashboard/log-event.cjs`) finds it in the isolated copy too —
  // otherwise only sharedRoot itself (often just the target's own directory, e.g. forge-bin/) would be
  // mirrored and that sibling require would crash before the suite ever prints its tally, producing a
  // false "baseline is not green" refusal. Bounded to the ".claude/" folder itself (never further up,
  // never outside the project) by findClaudeAncestor(); copyTree()'s own SKIP_DIRS/MAX_COPY_FILES/
  // MAX_COPY_DEPTH guards still apply on top of this.
  const claudeRoot = findClaudeAncestor(targetDir);
  if (claudeRoot) {
    const withinClaude = (d) => d === claudeRoot || d.startsWith(claudeRoot + path.sep);
    if (withinClaude(targetDir) && withinClaude(testDir)) sharedRoot = claudeRoot;
  }
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mutate-'));
  if (!path.resolve(tempRoot).startsWith(path.resolve(os.tmpdir()))) throw new Error('refusing: mkdtemp did not land under os.tmpdir()');
  copyTree(sharedRoot, tempRoot, 0, { n: 0 });
  return {
    tempRoot,
    copiedTargetPath: path.join(tempRoot, path.relative(sharedRoot, targetAbs)),
    copiedTestPath: path.join(tempRoot, path.relative(sharedRoot, testAbs)),
  };
}

function checkParses(filePath) {
  const r = spawnSync(NODE, ['--check', filePath], { encoding: 'utf8' });
  return r.status === 0;
}
function runSuite(testPath, opts) {
  const timeoutMs = (opts && Number.isFinite(opts.timeoutMs)) ? opts.timeoutMs : 20000;
  const r = spawnSync(NODE, [testPath], { encoding: 'utf8', timeout: timeoutMs, cwd: path.dirname(testPath) });
  const timedOut = r.status === null && !!r.signal; // same portable classification as forge-doctor.cjs's runTests()
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/(\d+)\s+passed,\s+(\d+)\s+failed/);
  return { ok: !timedOut && r.status === 0, timedOut, status: r.status, signal: r.signal || null, tally: m ? { passed: Number(m[1]), failed: Number(m[2]) } : null };
}

function runMutationLoop(originalSource, work, opts) {
  // recorded on EVERY return path (including the baseline-refusal below) so a "baseline is not green"
  // report is self-explaining about which timeout ceiling was actually in effect — this is exactly the
  // evidence that was missing when the default 20000ms baseline timeout silently misreported a genuinely
  // slow-but-healthy suite (e.g. one that legitimately takes ~27s) as a red baseline.
  const timeouts = {
    baselineTimeoutMs: Number.isFinite(opts.baselineTimeoutMs) ? opts.baselineTimeoutMs : 20000,
    mutantTimeoutMs: Number.isFinite(opts.mutantTimeoutMs) ? opts.mutantTimeoutMs : 20000,
  };
  const baseline = runSuite(work.copiedTestPath, { timeoutMs: opts.baselineTimeoutMs });
  if (!baseline.ok) return { ok: false, error: 'baseline is not green — refusing to run mutation testing (fix the suite first)', baseline, timeouts };
  // TEST-ONLY seam: opts.mutantsOverride lets a test supply a hand-built mutants list instead of the
  // regex generator, to prove the node --check skip path deterministically (this operator set's
  // token-for-token substitutions cannot themselves produce invalid syntax by construction — see header).
  const mutants0 = Array.isArray(opts.mutantsOverride) ? opts.mutantsOverride : generateMutants(originalSource);
  const fullTotal = mutants0.length;
  const mutants = (opts.sample && Number.isFinite(opts.sample) && opts.sample > 0 && opts.sample < mutants0.length)
    ? sampleMutants(mutants0, opts.sample, opts.seed) : mutants0;
  let killed = 0, survived = 0, skipped = 0, killedByTimeout = 0;
  const survivors = [], skippedList = [];
  for (const mut of mutants) {
    fs.writeFileSync(work.copiedTargetPath, applyMutant(originalSource, mut), 'utf8');
    if (!checkParses(work.copiedTargetPath)) { skipped++; skippedList.push({ id: mut.id, line: mut.line, description: mut.description }); continue; }
    const res = runSuite(work.copiedTestPath, { timeoutMs: opts.mutantTimeoutMs });
    if (res.timedOut) { killed++; killedByTimeout++; }
    else if (!res.ok) killed++;
    else { survived++; survivors.push({ id: mut.id, description: mut.description, line: mut.line, original: mut.original, replacement: mut.replacement }); }
  }
  const scored = killed + survived;
  return {
    ok: true, baseline: { ok: baseline.ok, tally: baseline.tally }, fullTotal, total: mutants.length,
    killed, survived, skipped, killedByTimeout, score: scored > 0 ? killed / scored : null,
    survivors, skippedList, sample: (opts.sample && opts.sample < fullTotal) ? opts.sample : null, seed: opts.seed || null,
    timeouts,
  };
}

// Orchestrates one full run. NEVER touches targetPath/testPath themselves — only reads them, then
// works entirely inside an os.tmpdir() copy, deleted in `finally` regardless of outcome.
function runMutationTesting(targetPath, testPath, opts) {
  opts = opts || {};
  const targetAbs = path.resolve(targetPath), testAbs = path.resolve(testPath);
  if (!fs.existsSync(targetAbs)) return { ok: false, error: 'target module not found: ' + targetAbs };
  if (!fs.existsSync(testAbs)) return { ok: false, error: 'test suite not found: ' + testAbs };
  const originalSource = fs.readFileSync(targetAbs, 'utf8');
  const beforeHash = crypto.createHash('sha256').update(fs.readFileSync(targetAbs)).digest('hex');
  const work = prepareWorkdir(targetAbs, testAbs);
  const workdirUnderTmp = path.resolve(work.tempRoot).startsWith(path.resolve(os.tmpdir()));
  let result;
  try { result = runMutationLoop(originalSource, work, opts); }
  finally { try { fs.rmSync(work.tempRoot, { recursive: true, force: true }); } catch { /* best-effort cleanup */ } }
  const afterHash = crypto.createHash('sha256').update(fs.readFileSync(targetAbs)).digest('hex');
  result.targetUnchanged = afterHash === beforeHash;
  result.workdirUnderTmp = workdirUnderTmp;
  result.target = path.relative(process.cwd(), targetAbs);
  result.test = path.relative(process.cwd(), testAbs);
  return result;
}

function printSummary(rep) {
  if (!rep.ok) {
    // when the refusal is a baseline that never came back green, name the exact timeout ceiling that was
    // in effect — this is the missing evidence that let a genuinely slow-but-healthy suite's timeout get
    // silently confused with a real red baseline; a caller reading this can now tell "raise --timeout" vs
    // "fix the suite" apart at a glance.
    const timeoutNote = rep.baseline && rep.baseline.timedOut && rep.timeouts
      ? (' (baseline TIMED OUT at ' + rep.timeouts.baselineTimeoutMs + 'ms — raise it with --baseline-timeout/--timeout if the suite is just slow, not actually broken)')
      : '';
    return 'forge-mutate: ' + (rep.error || 'failed') + timeoutNote;
  }
  const pct = rep.score == null ? 'n/a' : (rep.score * 100).toFixed(1) + '%';
  const lines = [];
  lines.push('forge-mutate — ' + rep.target + ' vs ' + rep.test);
  lines.push('  mutants generated: ' + rep.fullTotal + (rep.sample ? (' (sampled ' + rep.total + ' with seed=' + rep.seed + ')') : ''));
  lines.push('  killed:   ' + rep.killed + (rep.killedByTimeout ? (' (' + rep.killedByTimeout + ' by timeout)') : ''));
  lines.push('  survived: ' + rep.survived);
  lines.push('  skipped (non-parsing): ' + rep.skipped);
  lines.push('  score: ' + pct);
  if (rep.survivors.length) {
    lines.push('  SURVIVORS (untested logic):');
    for (const s of rep.survivors) lines.push('    line ' + s.line + ' [' + s.id + ']: ' + JSON.stringify(s.original) + ' -> ' + JSON.stringify(s.replacement) + ' — ' + s.description);
  }
  return lines.join('\n');
}

// Pure helper (directly unit-testable, no CLI/subprocess needed): resolves the final
// {baselineTimeoutMs, mutantTimeoutMs} to pass into runMutationTesting() from the parsed CLI opts.
//   --timeout <ms>           sets BOTH baselineTimeoutMs and mutantTimeoutMs to that value.
//   --baseline-timeout <ms>  sets ONLY baselineTimeoutMs — overrides --timeout's value for the baseline
//                            specifically when both are given (mutantTimeoutMs still follows --timeout).
//   neither given            both come back `undefined`, so runSuite() falls through to its own
//                            hardcoded 20000ms default, unchanged.
function resolveTimeouts(opts) {
  opts = opts || {};
  const mutantTimeoutMs = Number.isFinite(opts.timeout) ? opts.timeout : undefined;
  const baselineTimeoutMs = Number.isFinite(opts.baselineTimeout) ? opts.baselineTimeout
    : (Number.isFinite(opts.timeout) ? opts.timeout : undefined);
  return { baselineTimeoutMs, mutantTimeoutMs };
}

module.exports = {
  buildMask, lineOf, OPERATORS, generateMutants, sampleMutants, applyMutant,
  commonAncestorDir, findClaudeAncestor, prepareWorkdir, checkParses, runSuite, runMutationTesting, printSummary,
  resolveTimeouts,
};

// ---- CLI ----
function printUsage() {
  console.log([
    'Usage: node forge-mutate.cjs <targetModule.cjs> [--test <suite.test.cjs>] [--json] [--sample N] [--seed S]',
    '                              [--timeout <ms>] [--baseline-timeout <ms>]',
    '  --test <file>            test suite to run per mutant (default: <target>.cjs -> .test.cjs)',
    '  --json                   print the full JSON report',
    '  --sample N               take a reproducible sample of N mutants instead of the full set',
    '  --seed S                 seed for --sample (default: a fixed built-in seed — always reproducible)',
    '  --timeout <ms>           raise BOTH the baseline and per-mutant test timeout (default: 20000ms each)',
    '  --baseline-timeout <ms>  raise ONLY the baseline timeout (overrides --timeout for the baseline)',
  ].join('\n'));
}
function parseArgs(argv) {
  const out = { target: null, test: null, json: false, sample: null, seed: null, help: false, timeout: null, baselineTimeout: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--test') out.test = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--sample') out.sample = Number(argv[++i]);
    else if (a === '--seed') out.seed = argv[++i];
    else if (a === '--timeout') out.timeout = Number(argv[++i]);
    else if (a === '--baseline-timeout') out.baselineTimeout = Number(argv[++i]);
    else if (a === '--help' || a === '-h') out.help = true;
    else rest.push(a);
  }
  out.target = rest[0] || null;
  if (!out.test && out.target) out.test = out.target.replace(/\.cjs$/i, '.test.cjs');
  return out;
}

if (require.main === module) {
  const main = () => {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help || !opts.target) { printUsage(); process.exitCode = opts.help ? 0 : 1; return; }
    if (opts.sample !== null && (!Number.isFinite(opts.sample) || opts.sample <= 0 || !Number.isInteger(opts.sample))) {
      console.error('forge-mutate: --sample must be a positive integer'); process.exitCode = 1; return;
    }
    if (opts.timeout !== null && (!Number.isFinite(opts.timeout) || opts.timeout <= 0)) {
      console.error('forge-mutate: --timeout must be a positive number of milliseconds'); process.exitCode = 1; return;
    }
    if (opts.baselineTimeout !== null && (!Number.isFinite(opts.baselineTimeout) || opts.baselineTimeout <= 0)) {
      console.error('forge-mutate: --baseline-timeout must be a positive number of milliseconds'); process.exitCode = 1; return;
    }
    const { baselineTimeoutMs, mutantTimeoutMs } = resolveTimeouts(opts);
    const rep = runMutationTesting(opts.target, opts.test, { sample: opts.sample, seed: opts.seed, baselineTimeoutMs, mutantTimeoutMs });
    if (opts.json) console.log(JSON.stringify(rep, null, 2));
    else console.log(printSummary(rep));
    if (!rep.ok) { process.exitCode = 1; return; }
    if (!rep.targetUnchanged) { console.error('forge-mutate: FATAL — the real target file changed during the run (should never happen)'); process.exitCode = 1; return; }
    process.exitCode = 0; // score is informational, not a pass/fail gate — the caller decides what to do with it
  };
  try { main(); } catch (e) { console.error('forge-mutate: ' + e.message); process.exitCode = 1; }
}
