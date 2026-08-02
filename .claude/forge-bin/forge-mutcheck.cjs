#!/usr/bin/env node
'use strict';
/**
 * forge-mutcheck.cjs — Test Boss mutation-CHECK helper (WAVE E / E3, 2026-07-18). Encodes the manual
 * mutation-verify Test Boss already does by hand into a reusable, scriptable tool with the exact `--src
 * <f> --test <f>` contract the E3 work package specifies, PLUS a diff-scoped batch mode
 * (`opts.files`/`--files`) so a work package with several changed `.cjs` modules can be checked in one
 * call instead of one-by-one — never against the whole repo at once (see
 * `.claude/docs/test-boss-mutation-recipe.md`).
 *
 * WHY THIS IS A THIN WRAPPER, NOT A SECOND MUTATION ENGINE: `forge-mutate.cjs` (already built, already
 * tested — see `forge-mutate.test.cjs` — and already wired into `test-boss.md`) is the real mutation
 * engine: it generates the exact operator set this work package asks for (boolean-return flips
 * `returnTrueToFalse`/`returnFalseToTrue`, comparator weakening `ltToLte`/`gtToGte`/etc, branch no-ops
 * `forceIfTrue`/`forceIfFalse`/`negateCondition`), isolates every mutant in an `os.tmpdir()` copy, refuses
 * to run against a red baseline, and reports killed/survived/skipped/score. Reimplementing that here would
 * be a second, parallel mutation engine drifting against the first — the exact "no parallel pattern"
 * mistake this project's own coding-style rules warn against. `forge-mutcheck.cjs` instead REQUIRES
 * `forge-mutate.cjs` and reshapes its report into the CAUGHT/SURVIVED vocabulary this work package's CLI
 * contract calls for, plus the batch/diff convenience the recipe doc's "one file, not the whole repo"
 * guidance already implies. `forge-mutate.cjs` itself is left completely unmodified.
 *
 * MODEL:
 *   mutcheck({src, test}, opts) -> single-pair result:
 *     { mode:'single', src, test, ok, hollow, killed, survived, skipped, total, fullTotal, score,
 *       mutations:[{id, description, line, original, replacement, caught:false}, ...], error?, baseline?,
 *       timeouts?, targetUnchanged }
 *     `hollow: true` means at least one mutant SURVIVED — the paired test touches that code path but does
 *     not actually assert on the behavior the mutated line encodes (a hollow/weak test, per the work
 *     package's own definition). `mutations[]` lists every UNCAUGHT mutation explicitly (caught:false) —
 *     killed mutants are counted (`killed`) but not itemized one-by-one, mirroring forge-mutate.cjs's own
 *     report shape (it doesn't itemize kills either); this is enough to answer "did the tests catch every
 *     mutation?" without needing a second engine to track per-kill detail forge-mutate never recorded.
 *   mutcheck({files:[...]}, opts) -> batch/diff mode. Each entry in `files` is either a bare source path
 *     (its test path is auto-derived the same way forge-mutate's own CLI does: `.cjs` -> `.test.cjs`) or
 *     an explicit `{src, test}` pair. Returns:
 *     { mode:'batch', ok, results:[<single-pair result>, ...], total, hollowCount, failedCount,
 *       totalKilled, totalSurvived }
 *     `ok` is false when ANY pair failed to run at all (missing file, red baseline) — a hollow finding
 *     (`hollow:true` on an otherwise-ok pair) does NOT set `ok:false`; it is a finding to report, not a
 *     run failure. opts.sample/opts.seed/opts.baselineTimeoutMs/opts.mutantTimeoutMs pass straight through
 *     to forge-mutate.cjs for a large-diff or slow-suite run, unchanged from its own semantics.
 *
 * CLI:
 *   node forge-mutcheck.cjs --src <f> --test <f> [--json] [--sample N] [--seed S] [--timeout <ms>]
 *     [--baseline-timeout <ms>]
 *   node forge-mutcheck.cjs --files <f1.cjs,f2.cjs,...> [--json] [--sample N] [--seed S] [--timeout <ms>]
 *     [--baseline-timeout <ms>]
 *     (batch/diff mode — each file's test path is auto-derived; use the module API directly for explicit
 *     non-default src/test pairs, since a bare CLI list keeps Windows-path-safe comma splitting simple)
 * Exit codes: 0 = ran, every mutant caught (no hollow finding) · 3 = ran honestly but at least one mutant
 * SURVIVED (a hollow-test finding — advisory: strengthen the test, mirrors forge-orchestrate's/
 * forge-actiongate's non-zero "needs attention" convention) · 2 = usage error or a real run failure (bad
 * args, missing file, a red baseline — nothing was honestly scored).
 *
 * Module API: { mutcheck, checkOnePair, normalizeFileEntry }
 */
const fs = require('fs');
const mutate = require('./forge-mutate.cjs');

/** checkOnePair(src, test, opts) -> single-pair result (see file header MODEL). Never throws — a missing
 *  file or a real forge-mutate.cjs failure (e.g. a red baseline) comes back as {ok:false, error}. */
function checkOnePair(src, test, opts) {
  opts = opts || {};
  if (!src) return { src: src || null, test: test || null, ok: false, error: 'mutcheck: --src is required' };
  if (!test) return { src, test: test || null, ok: false, error: 'mutcheck: --test is required' };
  if (!fs.existsSync(src)) return { src, test, ok: false, error: 'mutcheck: source file not found: ' + src };
  if (!fs.existsSync(test)) return { src, test, ok: false, error: 'mutcheck: test file not found: ' + test };

  const rep = mutate.runMutationTesting(src, test, {
    sample: opts.sample, seed: opts.seed,
    baselineTimeoutMs: opts.baselineTimeoutMs, mutantTimeoutMs: opts.mutantTimeoutMs,
  });

  if (!rep.ok) {
    return {
      src: rep.target || src, test: rep.test || test, ok: false,
      error: rep.error || 'forge-mutate run did not complete', baseline: rep.baseline || null, timeouts: rep.timeouts || null,
    };
  }

  const mutations = rep.survivors.map((s) => ({
    id: s.id, description: s.description, line: s.line, original: s.original, replacement: s.replacement, caught: false,
  }));

  return {
    mode: 'single-pair', src: rep.target, test: rep.test, ok: true,
    hollow: rep.survived > 0,
    total: rep.total, fullTotal: rep.fullTotal,
    killed: rep.killed, survived: rep.survived, skipped: rep.skipped,
    score: rep.score,
    mutations,
    targetUnchanged: rep.targetUnchanged,
  };
}

/** normalizeFileEntry(entry) -> {src, test}. A bare string derives its test path the same way
 *  forge-mutate.cjs's own CLI default does (`.cjs` -> `.test.cjs`); an object supplies both explicitly. */
function normalizeFileEntry(entry) {
  if (typeof entry === 'string') return { src: entry, test: entry.replace(/\.cjs$/i, '.test.cjs') };
  if (entry && typeof entry === 'object') {
    const src = entry.src || null;
    const test = entry.test || (src ? String(src).replace(/\.cjs$/i, '.test.cjs') : null);
    return { src, test };
  }
  return { src: null, test: null };
}

/** mutcheck(input, opts) -> see file header MODEL for both single-pair and batch shapes. Throws only on a
 *  usage error (neither {src,test} nor a non-empty {files} array was supplied) — a real run failure for a
 *  given pair (missing file, red baseline) is reported IN the result, never thrown. */
function mutcheck(input, opts) {
  opts = opts || {};
  input = input || {};

  if (Array.isArray(input.files) && input.files.length) {
    const pairs = input.files.map(normalizeFileEntry);
    const results = pairs.map((p) => checkOnePair(p.src, p.test, opts));
    const okResults = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    const hollow = okResults.filter((r) => r.hollow);
    return {
      mode: 'batch',
      ok: failed.length === 0,
      results,
      total: results.length,
      hollowCount: hollow.length,
      failedCount: failed.length,
      totalKilled: okResults.reduce((n, r) => n + r.killed, 0),
      totalSurvived: okResults.reduce((n, r) => n + r.survived, 0),
    };
  }

  if (!input.src || !input.test) {
    throw new Error('forge-mutcheck: mutcheck requires {src, test} or a non-empty {files:[...]}');
  }
  return checkOnePair(input.src, input.test, opts);
}

module.exports = { mutcheck, checkOnePair, normalizeFileEntry };

// ---- CLI ----
function parseArgs(argv) {
  const out = { src: null, test: null, files: null, json: false, sample: null, seed: null, timeout: null, baselineTimeout: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--src') out.src = argv[++i];
    else if (a === '--test') out.test = argv[++i];
    else if (a === '--files') out.files = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--sample') out.sample = Number(argv[++i]);
    else if (a === '--seed') out.seed = argv[++i];
    else if (a === '--timeout') out.timeout = Number(argv[++i]);
    else if (a === '--baseline-timeout') out.baselineTimeout = Number(argv[++i]);
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}
function printUsage() {
  console.log([
    'Usage: node forge-mutcheck.cjs --src <f> --test <f> [--json] [--sample N] [--seed S]',
    '                                [--timeout <ms>] [--baseline-timeout <ms>]',
    '       node forge-mutcheck.cjs --files <f1.cjs,f2.cjs,...> [--json] [--sample N] [--seed S]',
    '                                [--timeout <ms>] [--baseline-timeout <ms>]',
  ].join('\n'));
}
function printSinglePair(r) {
  if (!r.ok) return 'forge-mutcheck: ' + r.error;
  const pct = r.score == null ? 'n/a' : (r.score * 100).toFixed(1) + '%';
  const lines = [];
  lines.push('forge-mutcheck — ' + r.src + ' vs ' + r.test + (r.hollow ? '  [HOLLOW TEST — mutants survived]' : '  [ok — every mutant caught]'));
  lines.push('  killed:   ' + r.killed);
  lines.push('  survived: ' + r.survived + (r.skipped ? ('  skipped: ' + r.skipped) : ''));
  lines.push('  score: ' + pct);
  for (const m of r.mutations) lines.push('    line ' + m.line + ' [' + m.id + ']: ' + JSON.stringify(m.original) + ' -> ' + JSON.stringify(m.replacement) + ' NOT CAUGHT — ' + m.description);
  return lines.join('\n');
}
function printBatch(r) {
  const lines = [];
  lines.push('forge-mutcheck batch — ' + r.total + ' file(s), ' + r.hollowCount + ' hollow, ' + r.failedCount + ' failed to run');
  for (const one of r.results) lines.push('- ' + printSinglePair(one).split('\n').join('\n  '));
  return lines.join('\n');
}

if (require.main === module) {
  const main = () => {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) { printUsage(); process.exitCode = 0; return; }
    if (!opts.src && !opts.files) { printUsage(); process.exitCode = 2; return; }
    if (opts.sample !== null && (!Number.isFinite(opts.sample) || opts.sample <= 0 || !Number.isInteger(opts.sample))) {
      console.error('forge-mutcheck: --sample must be a positive integer'); process.exitCode = 2; return;
    }
    if (opts.timeout !== null && (!Number.isFinite(opts.timeout) || opts.timeout <= 0)) {
      console.error('forge-mutcheck: --timeout must be a positive number of milliseconds'); process.exitCode = 2; return;
    }
    if (opts.baselineTimeout !== null && (!Number.isFinite(opts.baselineTimeout) || opts.baselineTimeout <= 0)) {
      console.error('forge-mutcheck: --baseline-timeout must be a positive number of milliseconds'); process.exitCode = 2; return;
    }
    const { baselineTimeoutMs, mutantTimeoutMs } = mutate.resolveTimeouts({ timeout: opts.timeout, baselineTimeout: opts.baselineTimeout });
    const runOpts = { sample: opts.sample, seed: opts.seed, baselineTimeoutMs, mutantTimeoutMs };

    let result;
    try {
      if (opts.files) {
        const files = opts.files.split(',').map((s) => s.trim()).filter(Boolean);
        result = mutcheck({ files }, runOpts);
      } else {
        result = mutcheck({ src: opts.src, test: opts.test }, runOpts);
      }
    } catch (e) {
      console.error('forge-mutcheck: ' + e.message); process.exitCode = 2; return;
    }

    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else console.log(result.mode === 'batch' ? printBatch(result) : printSinglePair(result));

    if (!result.ok) { process.exitCode = 2; return; }
    const anyHollow = result.mode === 'batch' ? result.hollowCount > 0 : result.hollow;
    process.exitCode = anyHollow ? 3 : 0;
  };
  try { main(); } catch (e) { console.error('forge-mutcheck: ' + e.message); process.exitCode = 2; }
}
