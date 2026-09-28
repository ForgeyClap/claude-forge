#!/usr/bin/env node
'use strict';
// forge-integrity.test.cjs — regression tests for the 2026-07-11 honesty/security upgrades:
//   • agent-name canonicalization (slug → display name) in log-event.cjs
//   • content-oracle proofs: a *_passed with exit_code!=0 and a blank/0-byte screenshot are REFUSED
//   • tamper-evident hash chain (via forge-doctor chainCheck) — intact verifies, tampered is detected
//   • dashboard DNS-rebinding guard self-test (forge-doctor rebindingGuard)
// Convention: prints "<N> passed, <M> failed" and exits non-zero on any failure (forge-doctor runTests).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const doctor = require('./forge-doctor.cjs');

const NODE = process.execPath;
const LOG = path.join(__dirname, '..', 'forge-dashboard', 'log-event.cjs');
const RUNS = path.join(__dirname, '..', 'forge-runs');
const TEMPLATE_ROOT = path.resolve(__dirname, '..', '..'); // .../forge/template

let passed = 0, failed = 0;
function t(name, fn) { try { fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); } }
function log(rid, type, extra) { return spawnSync(NODE, [LOG, rid, type, JSON.stringify(extra)], { encoding: 'utf8' }); }
function lastEvent(rid) { const raw = fs.readFileSync(path.join(RUNS, rid, 'events.jsonl'), 'utf8').replace(/\n+$/, ''); const lines = raw.split('\n'); return JSON.parse(lines[lines.length - 1]); }
function cleanup(rid) { try { fs.rmSync(path.join(RUNS, rid), { recursive: true, force: true }); } catch { /* best effort */ } }

console.log('forge integrity tests (canonicalization · content-oracle · hash-chain · rebind guard)');
const RID = 'integrity-test-' + process.pid;
cleanup(RID);

// 1) agent-name canonicalization
t('slug agent + to canonicalize to display names', () => {
  log(RID, 'agent_progress', { agent: 'build-boss', to: 'review-boss', note: 'x' });
  const e = lastEvent(RID);
  assert.strictEqual(e.agent, 'Build Boss');
  assert.strictEqual(e.to, 'Review Boss');
});

// 2) content-oracle: exit_code
t('check_passed with exit_code!=0 is REFUSED (exit 2)', () => {
  const r = log(RID, 'check_passed', { agent: 'Build Boss', command: 'npm test', output: 'fail', exit_code: 1 });
  assert.strictEqual(r.status, 2);
});
t('check_passed with exit_code=0 is accepted', () => {
  const r = log(RID, 'check_passed', { agent: 'Build Boss', command: 'npm test', output: 'ok', exit_code: 0 });
  assert.strictEqual(r.status, 0);
});

// 3) content-oracle: screenshot size
const blank = path.join(os.tmpdir(), 'forge-blank-' + process.pid + '.png');
const real = path.join(os.tmpdir(), 'forge-real-' + process.pid + '.png');
fs.writeFileSync(blank, '');
fs.writeFileSync(real, Buffer.alloc(2048, 1));
t('0-byte screenshot proof is REFUSED (exit 2)', () => {
  const r = log(RID, 'browser_screenshot_captured', { agent: 'UI Boss', screenshot_path: blank });
  assert.strictEqual(r.status, 2);
});
t('real-size screenshot proof is accepted', () => {
  const r = log(RID, 'browser_screenshot_captured', { agent: 'UI Boss', screenshot_path: real });
  assert.strictEqual(r.status, 0);
});
fs.rmSync(blank, { force: true }); fs.rmSync(real, { force: true });

// 4) tamper-evident hash chain
t('chainCheck reports OK on an intact chain (>=1 chained run present)', () => {
  const rep = doctor.chainCheck(TEMPLATE_ROOT);
  assert.ok(rep.chained >= 1, 'expected >=1 chained run, got ' + rep.chained);
  assert.ok(rep.ok, 'expected chain ok, broken=' + JSON.stringify(rep.broken));
});
t('chainCheck detects a tampered event', () => {
  const raw = fs.readFileSync(path.join(RUNS, RID, 'events.jsonl'), 'utf8').replace(/\n+$/, '');
  const lines = raw.split('\n');
  const first = JSON.parse(lines[0]); first.note = 'TAMPERED'; lines[0] = JSON.stringify(first);
  const tamperRid = RID + '-tamper';
  fs.mkdirSync(path.join(RUNS, tamperRid), { recursive: true });
  fs.writeFileSync(path.join(RUNS, tamperRid, 'events.jsonl'), lines.join('\n') + '\n');
  const rep = doctor.chainCheck(TEMPLATE_ROOT);
  cleanup(tamperRid);
  assert.ok(!rep.ok && rep.broken.some((b) => b.run === tamperRid), 'expected tamper detected in ' + tamperRid);
});

// 5) rebinding guard self-test — v2.9.0: the guard moved from the retired (now-removed) per-project
// server.cjs to the Command Center gateway (command-center/gateway/src/security.mjs). Whether THIS checkout
// has a command-center/ folder depends on where it runs: an agent worktree or a user project has none, while
// the Forge source tree and the public distribution both carry it. So the real-checkout test asserts the
// right thing for either layout (the first version assumed "none here" and failed in both trees that ship
// the Command Center): with command-center/ present the REAL security.mjs must pass the guard check
// (applicable:true, ok:true); without it the answer is ok:true, applicable:false. forge-doctor.test.cjs's
// dedicated RG_* fixtures cover every branch hermetically (none / missing security.mjs / good / bad guard).
t('rebindingGuard on this real checkout: the real gateway guard passes, or "not applicable" without command-center/', () => {
  const rep = doctor.rebindingGuard(TEMPLATE_ROOT);
  assert.ok(rep.ok, rep.reason);
  const hasCc = fs.existsSync(path.join(TEMPLATE_ROOT, 'command-center'));
  assert.strictEqual(rep.applicable, hasCc, 'expected applicable=' + hasCc + ' for this layout, got: ' + JSON.stringify(rep));
});

cleanup(RID);
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
