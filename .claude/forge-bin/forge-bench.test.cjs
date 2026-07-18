#!/usr/bin/env node
'use strict';
// forge-bench.test.cjs — verifies the ForgeBench capability scoreboard runs the shipped modules and that
// every capability is healthy in the template (the regression signal). Convention: "<N> passed, <M> failed".
const assert = require('assert');
const bench = require('./forge-bench.cjs');

let passed = 0, failed = 0;
function t(name, fn) { try { fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); } }

console.log('forge bench (capability scoreboard) tests');
const rep = bench.run();

t('run() returns {total, passed, score, results}', () => { assert.ok(Number.isInteger(rep.total) && Number.isInteger(rep.passed) && typeof rep.score === 'number' && Array.isArray(rep.results)); });
t('total equals the number of registered cases', () => assert.strictEqual(rep.total, bench.CASES.length));
t('each result has id/cap/pass', () => assert.ok(rep.results.every((r) => r.id && r.cap && typeof r.pass === 'boolean')));
t('ALL capabilities are healthy in the template (no regression)', () => assert.ok(rep.passed === rep.total, 'unhealthy: ' + rep.results.filter((r) => !r.pass).map((r) => r.id).join(', ')));
t('score is passed/total', () => assert.strictEqual(rep.score, Number((rep.passed / rep.total).toFixed(4))));
t('covers honesty + security + interop + durability capabilities', () => { const caps = new Set(bench.CASES.map((c) => c.cap)); ['honesty', 'security', 'interop', 'durability', 'integrity'].forEach((c) => assert.ok(caps.has(c), 'missing cap ' + c)); });

console.log('');
console.log('M9 (WP2 close-out, 2026-07-14) — run()\'s try/catch contract: a throwing case is NEVER pass:true');

t('a case whose fn() throws is caught by run() and counted pass:false, never pass:true, and never aborts the rest of the run', () => {
  // Runs the REAL run() over the REAL CASES array with ONE synthetic throwing case pushed on temporarily —
  // never edited into the persisted CASES literal in forge-bench.cjs (that array stays the real scoreboard).
  const beforeLen = bench.CASES.length;
  bench.CASES.push({ id: 'test.synthetic-throwing-case-m9', cap: 'test', fn: () => { throw new Error('boom (M9 synthetic, test-only)'); } });
  let rep2;
  try {
    rep2 = bench.run();
  } finally {
    bench.CASES.pop(); // restore the array to its exact original state before any assertion runs
  }
  assert.strictEqual(bench.CASES.length, beforeLen, 'CASES array must be restored to its original length immediately after run()');
  assert.strictEqual(rep2.total, beforeLen + 1, 'run() must still process every case including the throwing one, not abort early');
  const synth = rep2.results.find((r) => r.id === 'test.synthetic-throwing-case-m9');
  assert.ok(synth, 'the synthetic throwing case must still appear in results (not silently dropped)');
  assert.strictEqual(synth.pass, false, 'a throwing case must be recorded as pass:false, never pass:true');
});

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
