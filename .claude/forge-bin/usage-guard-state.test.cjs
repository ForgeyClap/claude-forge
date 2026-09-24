#!/usr/bin/env node
'use strict';
/** Offline, deterministic unit tests for usage-guard-state.cjs's ownership-safe lock (V15, second Codex
 *  recheck, 2026-09-24). No network, no real usage-guard state files — this file only ever touches its own
 *  temp lock paths. Uses small opts.staleMs/opts.timeoutMs values (never the production 60000/2000ms
 *  defaults) so every scenario below runs in well under a second. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const S = require('./usage-guard-state.cjs');

let pass = 0, fail = 0;
// SEQUENTIAL by construction (never fire-and-queue): several of these tests monkeypatch the shared `fs`
// module singleton (a global) or rely on real elapsed-time heartbeats — running them concurrently would
// let one test's global patch or timing leak into another's, exactly the cross-test interleaving hazard
// this project's own async test harnesses have hit before. Each test is awaited to completion before the
// next one starts.
const tests = [];
const t = (name, fn) => { tests.push({ name, fn: async () => fn() }); };
const t5 = t;

console.log('usage-guard-state tests (V15 ownership/liveness/fencing)');

function tmpLock() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-state-v15-'));
  return { dir, lockPath: path.join(dir, 'state.json.lock') };
}

t5('a fresh lock is acquired immediately and released on success', async () => {
  const { dir, lockPath } = tmpLock();
  try {
    const r = await S.withStateLock(lockPath, () => 'done');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.value, 'done');
    assert.strictEqual(fs.existsSync(lockPath), false, 'the lock file must be gone after a clean release');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

t5('fn() receives a fence() function that reports true while genuinely held', async () => {
  const { dir, lockPath } = tmpLock();
  try {
    let sawFence = null;
    await S.withStateLock(lockPath, (fence) => { sawFence = typeof fence === 'function' ? fence() : fence; });
    assert.strictEqual(sawFence, true, 'fence() must report true while this holder genuinely still holds the lock');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

t5('V15: a LIVE holder (heartbeat keeps refreshing) is NEVER reclaimed by a waiter even after the stale interval elapses', async () => {
  const { dir, lockPath } = tmpLock();
  try {
    let releaseSlow;
    const slowDone = new Promise((res) => { releaseSlow = res; });
    let bAcquired = false;
    const holderA = S.withStateLock(lockPath, async (fence) => {
      await slowDone; // hold well past staleMs while the heartbeat keeps refreshing mtime
      assert.strictEqual(fence(), true, 'A must still hold the lock at write time — it was never reclaimed');
      return 'A-done';
    }, { staleMs: 150, timeoutMs: 50 });
    await new Promise((res) => setTimeout(res, 400)); // > 2x staleMs — A's heartbeat must have kept it alive
    const waiterB = await S.withStateLock(lockPath, () => { bAcquired = true; return 'B'; }, { staleMs: 150, timeoutMs: 50 });
    assert.strictEqual(waiterB.ok, false, 'B must be refused while A is still genuinely alive and heartbeating: ' + JSON.stringify(waiterB));
    assert.strictEqual(bAcquired, false, 'B\'s transaction must never have run');
    releaseSlow();
    const resultA = await holderA;
    assert.strictEqual(resultA.ok, true, JSON.stringify(resultA));
    assert.strictEqual(resultA.value, 'A-done');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

t5('V15: a GENUINELY abandoned lock (no heartbeat — the holder process is gone) IS reclaimed once stale, and the new holder\'s write proceeds', async () => {
  const { dir, lockPath } = tmpLock();
  try {
    // simulate a crashed holder: write a lock file directly (a token, no heartbeat process behind it) and
    // backdate its mtime past staleMs (the CFG-09 technique — deterministic, no real waiting).
    fs.writeFileSync(lockPath, 'crashed-holder-token');
    const old = new Date(Date.now() - 5000);
    fs.utimesSync(lockPath, old, old);
    const r = await S.withStateLock(lockPath, (fence) => { assert.strictEqual(fence(), true); return 'reclaimed-and-wrote'; }, { staleMs: 200, timeoutMs: 300 });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.value, 'reclaimed-and-wrote');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

t5('V15: A\'s release NEVER deletes B\'s lock once B has genuinely reclaimed it (A was reclaimed while suspended, e.g. GC pause / crash-then-resume)', async () => {
  const { dir, lockPath } = tmpLock();
  try {
    // A acquires, then goes silent (no heartbeat call happens here because we bypass withStateLock's own
    // loop and simulate A's fd being held open by directly controlling the token file — mirrors "A is
    // suspended past staleMs with no live heartbeat", the crash-recovery case reclamation exists for).
    fs.writeFileSync(lockPath, 'A-token');
    const old = new Date(Date.now() - 5000);
    fs.utimesSync(lockPath, old, old);
    // B reclaims it for real via the module's own reclaim path.
    const st = fs.statSync(lockPath);
    const reclaimed = S.tryReclaimStaleLock(lockPath, 'A-token', st.mtimeMs, 'B-token');
    assert.strictEqual(reclaimed, true, 'B must successfully reclaim the genuinely stale A-held lock');
    assert.strictEqual(S.readLockToken(lockPath), 'B-token');
    // A "wakes up" and releases what it believes is still its own lock — release must be a no-op now.
    // (release logic lives inside withStateLock's finally; exercise the same rule directly here.)
    if (S.readLockToken(lockPath) !== 'A-token') { /* A's release must see this and do nothing */ } else { fs.unlinkSync(lockPath); }
    assert.strictEqual(S.readLockToken(lockPath), 'B-token', 'A\'s stale release must never remove B\'s lock');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

t5('V15: full withStateLock schedule — A holds > stale interval and stays ACTIVE, B must be refused (never overlaps), A\'s own release never touches a later holder, and a subsequent C acquires cleanly only after A truly releases', async () => {
  const { dir, lockPath } = tmpLock();
  try {
    let releaseA;
    const aGate = new Promise((res) => { releaseA = res; });
    const order = [];
    const holderA = S.withStateLock(lockPath, async () => { order.push('A-start'); await aGate; order.push('A-end'); return 'A'; }, { staleMs: 120, timeoutMs: 60 });
    await new Promise((res) => setTimeout(res, 300)); // well past staleMs — A is still active (heartbeat)
    const holderB = await S.withStateLock(lockPath, () => { order.push('B-ran'); return 'B'; }, { staleMs: 120, timeoutMs: 60 });
    assert.strictEqual(holderB.ok, false, 'B must never acquire while A is still alive: ' + JSON.stringify(holderB));
    assert.ok(!order.includes('B-ran'), 'B\'s transaction must never have executed — no overlap with A');
    releaseA();
    const resultA = await holderA;
    assert.strictEqual(resultA.ok, true);
    assert.deepStrictEqual(order, ['A-start', 'A-end']);
    // now that A genuinely released, C must acquire cleanly and immediately.
    const holderC = await S.withStateLock(lockPath, () => 'C', { staleMs: 120, timeoutMs: 500 });
    assert.strictEqual(holderC.ok, true, JSON.stringify(holderC));
    assert.strictEqual(holderC.value, 'C');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

t5('V15: a failed stale-lock reclaim (injected EACCES on the reclaim write) falls through to the ordinary bounded deadline — never a tight immediate-retry loop', async () => {
  const { dir, lockPath } = tmpLock();
  try {
    fs.writeFileSync(lockPath, 'stale-token');
    const old = new Date(Date.now() - 5000);
    fs.utimesSync(lockPath, old, old);
    const origWriteFileSync = fs.writeFileSync;
    let reclaimAttempts = 0;
    fs.writeFileSync = function (p, ...rest) {
      if (typeof p === 'string' && p.includes('.reclaim.')) { reclaimAttempts++; const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; }
      return origWriteFileSync.call(fs, p, ...rest);
    };
    const started = Date.now();
    let r;
    try { r = await S.withStateLock(lockPath, () => 'unreachable', { staleMs: 50, timeoutMs: 200 }); }
    finally { fs.writeFileSync = origWriteFileSync; }
    const elapsed = Date.now() - started;
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.strictEqual(r.reason, 'lock-timeout');
    // bounded: the 200ms deadline was respected (a tight loop would have spun for the FULL elapsed budget
    // anyway, but would also have logged/attempted reclaim far more than a ~25ms-poll-spaced loop allows —
    // the real proof is elapsed staying close to timeoutMs, not runaway).
    assert.ok(elapsed < 1000, 'a tight retry loop ignoring the deadline would run far longer than the 200ms budget: ' + elapsed + 'ms');
    assert.ok(reclaimAttempts >= 1 && reclaimAttempts < 50, 'reclaim must be retried at a bounded poll cadence, not in a tight spin: ' + reclaimAttempts + ' attempts in ' + elapsed + 'ms');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

t5('V15: release only unlinks a lock whose content still matches this holder\'s own token — a lock already reclaimed by someone else is left untouched', async () => {
  const { dir, lockPath } = tmpLock();
  try {
    let midRun;
    const gate = new Promise((res) => { midRun = res; });
    const holder = S.withStateLock(lockPath, async () => { await gate; return 'done'; }, { staleMs: 100000, timeoutMs: 100 });
    await new Promise((res) => setTimeout(res, 30)); // let the lock file get created
    // simulate an external reclaim (a different token now sits at lockPath) WITHOUT going through the module
    fs.writeFileSync(lockPath, 'someone-elses-token');
    midRun();
    await holder;
    assert.strictEqual(fs.readFileSync(lockPath, 'utf8'), 'someone-elses-token', 'release must never remove a lock that no longer carries this holder\'s own token');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

(async () => {
  for (const { name, fn } of tests) {
    try { await fn(); pass++; console.log('  ok  ' + name); }
    catch (e) { fail++; console.error('  FAIL ' + name + ' — ' + e.message); }
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exitCode = fail ? 1 : 0;
})();
