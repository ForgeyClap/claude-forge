#!/usr/bin/env node
'use strict';
// forge-bench.test.cjs — verifies the ForgeBench capability scoreboard runs the shipped modules and that
// every capability is healthy in the template (the regression signal). Convention: "<N> passed, <M> failed".
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
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

console.log('');
console.log('N4/Part V-G (2026-09-26) — baseline split: --baseline writes to a project-local user file, never the shipped one');

t('BASELINE and USER_BASELINE are two distinct files', () => {
  assert.notStrictEqual(bench.BASELINE, bench.USER_BASELINE);
});

t('--baseline writes ONLY to USER_BASELINE; the shipped BASELINE is byte-for-byte untouched', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-bench-baseline-'));
  try {
    // Seed a fixture PROJECT_ROOT with its own .claude/config/forge-bench/baseline.json (the "shipped" file
    // this fixture ships with) so the test never touches the real project's real shipped baseline.
    const cfgDir = path.join(tmpRoot, '.claude', 'config', 'forge-bench');
    fs.mkdirSync(cfgDir, { recursive: true });
    const shippedPath = path.join(cfgDir, 'baseline.json');
    const shippedBefore = JSON.stringify({ score: 0, passed: 0, total: 999, cases: [], note: 'fixture shipped baseline' }, null, 2) + '\n';
    fs.writeFileSync(shippedPath, shippedBefore);

    const env = Object.assign({}, process.env, { FORGE_PROJECT_ROOT: tmpRoot });
    const r = spawnSync(process.execPath, [path.join(__dirname, 'forge-bench.cjs'), '--baseline'], { encoding: 'utf8', env });
    assert.strictEqual(r.status, 0, 'stderr: ' + r.stderr);

    assert.strictEqual(fs.readFileSync(shippedPath, 'utf8'), shippedBefore, '--baseline must never rewrite the shipped baseline.json');
    const userPath = path.join(cfgDir, 'baseline.user.json');
    assert.ok(fs.existsSync(userPath), '--baseline must write baseline.user.json');
    const userData = JSON.parse(fs.readFileSync(userPath, 'utf8'));
    assert.ok(Number.isInteger(userData.passed) && Number.isInteger(userData.total));
    assert.ok(r.stdout.includes('baseline.user.json') || r.stdout.includes(userPath), 'stdout should name the actual written path: ' + r.stdout);
  } finally { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {} }
});

t('readBaseline() prefers USER_BASELINE over the shipped BASELINE when both exist', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-bench-readbaseline-'));
  try {
    const cfgDir = path.join(tmpRoot, '.claude', 'config', 'forge-bench');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'baseline.json'), JSON.stringify({ score: 0.1, passed: 1, total: 10 }));
    fs.writeFileSync(path.join(cfgDir, 'baseline.user.json'), JSON.stringify({ score: 0.9, passed: 9, total: 10 }));
    const env = Object.assign({}, process.env, { FORGE_PROJECT_ROOT: tmpRoot });
    const r = spawnSync(process.execPath, ['-e',
      "const b=require(" + JSON.stringify(path.join(__dirname, 'forge-bench.cjs')) + "); console.log(JSON.stringify(b.readBaseline()));"
    ], { encoding: 'utf8', env });
    assert.strictEqual(r.status, 0, 'stderr: ' + r.stderr);
    const base = JSON.parse(r.stdout.trim());
    assert.strictEqual(base.passed, 9, 'readBaseline() must prefer the user baseline when present');
  } finally { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {} }
});

t('readBaseline() falls back to the shipped BASELINE when no user baseline exists yet', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-bench-fallback-'));
  try {
    const cfgDir = path.join(tmpRoot, '.claude', 'config', 'forge-bench');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'baseline.json'), JSON.stringify({ score: 0.5, passed: 5, total: 10 }));
    const env = Object.assign({}, process.env, { FORGE_PROJECT_ROOT: tmpRoot });
    const r = spawnSync(process.execPath, ['-e',
      "const b=require(" + JSON.stringify(path.join(__dirname, 'forge-bench.cjs')) + "); console.log(JSON.stringify(b.readBaseline()));"
    ], { encoding: 'utf8', env });
    assert.strictEqual(r.status, 0, 'stderr: ' + r.stderr);
    const base = JSON.parse(r.stdout.trim());
    assert.strictEqual(base.passed, 5, 'readBaseline() must fall back to the shipped baseline');
  } finally { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {} }
});

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
