#!/usr/bin/env node
'use strict';
/**
 * forge-flaky.cjs — REPEAT-RUN nondeterminism detector (2026-07-24). Zero-dependency (fs/path/child_process
 * only), Windows-safe. Closes the one real remaining gap in Forge's already-strong test tooling: mutation
 * (forge-mutate/forge-mutcheck), fault-injection (forge-chaos) and fixtures (forge-fixtures) are all shipped
 * and wired into test-boss, but NOTHING checks that a suite's pass/fail outcome is STABLE across repeated
 * runs. forge-doctor treats a single green pass as proof; a suite that flips pass<->fail (timing, ordering,
 * shared temp state, a real Date.now()/random dependency) would slip through. This tool runs each suite N
 * times and flags any nonidentical outcome set.
 *
 * COMPLEMENTS, does not duplicate: forge-chaos INJECTS failures to test resilience; forge-flaky changes
 * NOTHING and just observes whether the unmodified suite is deterministic. Side-effect-free w.r.t. the repo
 * (it only spawns `node <testfile>` as a child and reads exit codes; it never writes source).
 *
 * MODEL:
 *   runOnce(file, opts)        -> 'pass' | 'fail' | 'timeout'   (one child `node <file>`; opts.timeoutMs, opts.cwd)
 *   runSuiteN(file, n, opts)   -> ['pass','pass',...]           (n runs)
 *   classify(resultsByFile)    -> { flaky:[{file, outcomes}], stable:[file...], checkedFiles }  (PURE — testable w/o spawning)
 *   detect(files, n, opts)     -> classify(...) after actually running each file n times
 *   listSuites(opts)           -> forge-bin/*.test.cjs paths (opts.dir override)
 *
 * CLI (exit: 0 = all stable · 1 = flaky suite(s) found · 2 = usage/no suites):
 *   node forge-flaky.cjs [--runs N] [--timeout-ms MS] [--exclude <substr>] [file ...] [--json]
 *   Default: N=3, all forge-bin/*.test.cjs. Named files override the default set.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const BIN_DIR = __dirname;
const DEFAULT_RUNS = 3;
const DEFAULT_TIMEOUT_MS = 120000;

function runOnce(file, opts = {}) {
  const r = spawnSync(process.execPath, [file], { cwd: opts.cwd || path.dirname(file), timeout: opts.timeoutMs || DEFAULT_TIMEOUT_MS, encoding: 'utf8' });
  if (r.error && r.error.code === 'ETIMEDOUT') return 'timeout';
  if (r.status === null) return 'timeout';
  return r.status === 0 ? 'pass' : 'fail';
}

function runSuiteN(file, n, opts = {}) {
  const outcomes = [];
  for (let i = 0; i < n; i++) outcomes.push(runOnce(file, opts));
  return outcomes;
}

function classify(resultsByFile) {
  const flaky = [], stable = [];
  for (const file of Object.keys(resultsByFile)) {
    const outs = resultsByFile[file] || [];
    const uniq = new Set(outs);
    if (uniq.size > 1) flaky.push({ file, outcomes: outs });
    else stable.push(file);
  }
  return { flaky, stable, checkedFiles: Object.keys(resultsByFile).length };
}

function detect(files, n, opts = {}) {
  const results = {};
  for (const f of files) results[f] = runSuiteN(f, n, opts);
  return classify(results);
}

function listSuites(opts = {}) {
  const dir = opts.dir || BIN_DIR;
  let files = []; try { files = fs.readdirSync(dir); } catch { return []; }
  return files.filter((f) => f.endsWith('.test.cjs')).map((f) => path.join(dir, f)).sort();
}

module.exports = { runOnce, runSuiteN, classify, detect, listSuites, DEFAULT_RUNS };

if (require.main === module) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const flag = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
  const runs = parseInt(flag('--runs', String(DEFAULT_RUNS)), 10);
  const timeoutMs = parseInt(flag('--timeout-ms', String(DEFAULT_TIMEOUT_MS)), 10);
  const exclude = flag('--exclude', null);
  const named = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--runs' && args[i - 1] !== '--timeout-ms' && args[i - 1] !== '--exclude');
  let files = named.length ? named.map((f) => path.resolve(f)) : listSuites();
  if (exclude) files = files.filter((f) => !f.includes(exclude));
  if (!files.length) { console.error('forge-flaky: no test suites to check'); process.exit(2); }
  if (!json) console.log('forge-flaky · running ' + files.length + ' suite(s) x ' + runs + ' each (stability check)…');
  const res = detect(files, runs, { timeoutMs });
  if (json) { console.log(JSON.stringify(res, null, 2)); }
  else {
    console.log('checked ' + res.checkedFiles + ' · stable ' + res.stable.length + ' · FLAKY ' + res.flaky.length);
    res.flaky.forEach((f) => console.log('  ⚠ FLAKY ' + path.basename(f.file) + ' → [' + f.outcomes.join(', ') + ']'));
    if (!res.flaky.length) console.log('  ✓ all suites deterministic across ' + runs + ' runs');
  }
  process.exit(res.flaky.length ? 1 : 0);
}
