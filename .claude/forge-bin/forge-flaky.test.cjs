#!/usr/bin/env node
'use strict';
// forge-flaky.test.cjs — tests the nondeterminism detector (2026-07-24). classify() is pure and covered
// with synthetic outcome maps; runOnce/runSuiteN are exercised against tiny deterministic temp scripts so
// the test stays fast and never recursively re-runs the whole suite set.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const flaky = require('./forge-flaky.cjs');

let passed = 0, failed = 0;
function t(name, fn) { try { fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); } }

console.log('forge-flaky tests');

t('classify flags a suite whose outcomes differ (pass,fail,pass)', () => {
  const r = flaky.classify({ 'a.test.cjs': ['pass', 'fail', 'pass'] });
  assert.strictEqual(r.flaky.length, 1);
  assert.strictEqual(r.flaky[0].file, 'a.test.cjs');
  assert.strictEqual(r.stable.length, 0);
});

t('classify treats identical outcomes as stable (pass,pass,pass and fail,fail)', () => {
  const r = flaky.classify({ 'ok.test.cjs': ['pass', 'pass', 'pass'], 'bad.test.cjs': ['fail', 'fail'] });
  assert.strictEqual(r.flaky.length, 0);
  assert.strictEqual(r.stable.length, 2);
  assert.strictEqual(r.checkedFiles, 2);
});

t('classify separates mixed stable + flaky sets correctly', () => {
  const r = flaky.classify({ 's.test.cjs': ['pass', 'pass'], 'f.test.cjs': ['pass', 'timeout'] });
  assert.strictEqual(r.flaky.length, 1);
  assert.strictEqual(r.flaky[0].file, 'f.test.cjs');
  assert.strictEqual(r.stable[0], 's.test.cjs');
});

const dir = path.join(os.tmpdir(), 'forge-flaky-test-' + process.pid);
fs.mkdirSync(dir, { recursive: true });
const passScript = path.join(dir, 'always-pass.cjs');
const failScript = path.join(dir, 'always-fail.cjs');
fs.writeFileSync(passScript, 'process.exit(0);\n');
fs.writeFileSync(failScript, 'process.exit(1);\n');

t('runOnce returns pass for exit 0 and fail for exit 1', () => {
  assert.strictEqual(flaky.runOnce(passScript, { timeoutMs: 20000 }), 'pass');
  assert.strictEqual(flaky.runOnce(failScript, { timeoutMs: 20000 }), 'fail');
});

t('a deterministic suite is classified stable across N real runs', () => {
  const res = flaky.detect([passScript], 2, { timeoutMs: 20000 });
  assert.strictEqual(res.flaky.length, 0);
  assert.strictEqual(res.stable.length, 1);
});

t('listSuites finds *.test.cjs in a dir (finds this very test in forge-bin)', () => {
  const suites = flaky.listSuites();
  assert.ok(suites.some((s) => s.endsWith('forge-flaky.test.cjs')), 'should list itself');
});

// WP-S4 (v2.8.0 laptop-audit Part VI): `forge-flaky --help` was never recognised by the CLI's argument
// parser, so it fell through to the default behaviour — running EVERY forge-bin/*.test.cjs suite 3x each
// with a 120s timeout per run, observed as an indefinite hang. A real spawned CLI call with a short timeout
// proves --help returns almost immediately instead of falling into that path.
const CLI = path.join(__dirname, 'forge-flaky.cjs');
t('CLI --help returns quickly (exit 0, prints Usage) instead of running the full suite set', () => {
  const r = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8', timeout: 5000 });
  assert.strictEqual(r.status, 0, 'exit ' + r.status + ' (a timeout/null status means it fell through to the hang path again)');
  assert.ok(/^Usage: node forge-flaky\.cjs/.test(r.stdout), 'stdout must open with the usage line: ' + r.stdout.slice(0, 120));
});
t('CLI -h is the same shorthand for --help', () => {
  const r = spawnSync(process.execPath, [CLI, '-h'], { encoding: 'utf8', timeout: 5000 });
  assert.strictEqual(r.status, 0, 'exit ' + r.status);
  assert.ok(/^Usage: node forge-flaky\.cjs/.test(r.stdout));
});

try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
