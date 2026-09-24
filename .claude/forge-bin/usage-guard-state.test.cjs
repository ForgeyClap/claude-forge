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
    // A acquires, then goes silent (no heartbeat call happens here — simulates "A is suspended past staleMs
    // with no live heartbeat", the crash-recovery case reclamation exists for).
    fs.writeFileSync(lockPath, 'A-token');
    const old = new Date(Date.now() - 5000);
    fs.utimesSync(lockPath, old, old);
    // B reclaims it for real via the module's own reclaim path.
    const reclaimed = S.tryReclaimStaleLock(lockPath, 'B-token', 200);
    assert.strictEqual(reclaimed, true, 'B must successfully reclaim the genuinely stale A-held lock');
    assert.strictEqual(S.readLockToken(lockPath), 'B-token');
    // A "wakes up" and releases what it believes is still its own lock — via the REAL release primitive,
    // not a hand-duplicated copy of the rule.
    S.releaseLockIfOwned(lockPath, 'A-token');
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

t5('V15: a failed stale-lock reclaim (injected EACCES on the atomic replace) falls through to the ordinary bounded deadline — never a tight immediate-retry loop', async () => {
  const { dir, lockPath } = tmpLock();
  try {
    fs.writeFileSync(lockPath, 'stale-token');
    const old = new Date(Date.now() - 5000);
    fs.utimesSync(lockPath, old, old);
    // V15 (FOURTH recheck): reclamation's ONE mutation is now `fs.renameSync(<.reclaim. tmp>, lockPath)` —
    // a rename ONTO the existing lock path (never a rename AWAY from it) — inject the failure at that call.
    const origRenameSync = fs.renameSync;
    let reclaimAttempts = 0;
    fs.renameSync = function (src, dest, ...rest) {
      if (typeof src === 'string' && src.includes('.reclaim.')) { reclaimAttempts++; const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; }
      return origRenameSync.call(fs, src, dest, ...rest);
    };
    const started = Date.now();
    let r;
    try { r = await S.withStateLock(lockPath, () => 'unreachable', { staleMs: 50, timeoutMs: 200 }); }
    finally { fs.renameSync = origRenameSync; }
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

// ---- L2 (Security Boss addendum, 2026-09-24): the unconditional unlink on a non-EEXIST create failure
// during ACQUISITION was not ownership-guarded. On Windows an exclusive create can fail with EPERM (a file
// mid-delete by another process) before anything of ours was ever created — the old code treated ANY
// non-EEXIST failure as proof "whatever is at lockPath must be our own broken write", which is false: the
// real content can belong to a DIFFERENT, genuinely live holder. The create and the token write are now two
// explicit steps (open, then write+close) so a failed OPEN (never proven ours) is never deleted, while a
// SUCCESSFUL open (provably ours — `wx` is exclusive) still gets N07's original unconditional cleanup. ----
t5('L2: a non-EEXIST create failure (simulated Windows EPERM while a file is mid-delete) during acquisition must NEVER delete a DIFFERENT, genuinely live holder\'s lock', async () => {
  const { dir, lockPath } = tmpLock();
  try {
    // a different, live holder's lock already sits at lockPath.
    fs.writeFileSync(lockPath, 'OTHER-HOLDER-TOKEN');
    const realOpenSync = fs.openSync;
    let injected = false;
    fs.openSync = function (p, flags, ...rest) {
      if (p === lockPath && flags === 'wx' && !injected) {
        injected = true;
        const e = new Error('EPERM simulated (Windows: file mid-delete by another process)');
        e.code = 'EPERM';
        throw e;
      }
      return realOpenSync.call(fs, p, flags, ...rest);
    };
    let r;
    try { r = await S.withStateLock(lockPath, () => 'unreachable', { staleMs: 60000, timeoutMs: 50 }); }
    finally { fs.openSync = realOpenSync; }
    assert.strictEqual(injected, true, 'the injected EPERM must actually have fired');
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.strictEqual(S.readLockToken(lockPath), 'OTHER-HOLDER-TOKEN', 'the other holder\'s real lock must survive completely untouched — an unconditional unlink here would have deleted it');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

t5('L2 / L2-R (2026-09-24, Codex p12 wave 7 — UPDATED): a successful exclusive open with a subsequent write failure refuses outright; cleanup is ownership-safe (exact-token match only), so the untouched empty stub is left in place rather than deleted on a guess', async () => {
  const { dir, lockPath } = tmpLock();
  try {
    const realWriteSync = fs.writeSync;
    fs.writeSync = function (fd, ...rest) { const e = new Error('EIO simulated'); e.code = 'EIO'; throw e; };
    let r;
    try { r = await S.withStateLock(lockPath, () => 'unreachable', { staleMs: 60000, timeoutMs: 50 }); }
    finally { fs.writeSync = realWriteSync; }
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    // L2-R (Security Boss addendum, 2026-09-24): the write threw before any bytes of this call's own token
    // landed, so lockPath's content is exactly empty — not this call's own token, so ownership-safe cleanup
    // (see usage-guard-state.cjs's own L2-R comment) does not delete it. A leftover empty stub self-heals via
    // the ordinary age-only staleness reclaim once `staleMs` elapses, same as any other stale lock.
    assert.strictEqual(fs.existsSync(lockPath), true, 'an empty stub that is not this call\'s own token must be left in place, not guessed at and deleted');
    assert.strictEqual(S.readLockToken(lockPath), '', 'the stub must be exactly as this call left it — untouched');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- V15, THIRD Codex recheck (2026-09-24, now SUPERSEDED — see the FOURTH recheck below): capture-first
// reclaim/release + fenced publication ----
const G = require('./usage-guard.cjs');

t5('V15 (FOURTH recheck): a stale claimant can never replace a NEWER holder — reclaim verifies staleness FRESHLY, in place, immediately before acting; the newer holder\'s lock survives completely intact', () => {
  const { dir, lockPath } = tmpLock();
  try {
    fs.writeFileSync(lockPath, 'ORIGINAL');
    const old = new Date(Date.now() - 120000);
    fs.utimesSync(lockPath, old, old);
    // B reclaims for real FIRST (wins the race) — this makes the lock's mtime FRESH (just replaced).
    assert.strictEqual(S.tryReclaimStaleLock(lockPath, 'TOKEN_B', 60000), true, 'B must win the stale reclaim');
    // A now tries to reclaim too, immediately after, with the SAME staleMs budget every caller uses — A's
    // own check is a FRESH read (there is no longer any caller-supplied snapshot to act on), so it correctly
    // sees B's lock is no longer stale and refuses. This is Codex's exact "a stale claimant reclaims a lock
    // that has, in the meantime, become live again" schedule, applied directly to the reclaim primitive.
    assert.strictEqual(S.tryReclaimStaleLock(lockPath, 'TOKEN_A', 60000), false, 'A must lose — B is now the newer holder');
    assert.strictEqual(S.readLockToken(lockPath), 'TOKEN_B', 'B\'s lock must be completely intact — A must never have touched it');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

t5('V15 (FOURTH recheck): a lock that WAS stale but has since been heartbeat-refreshed can never be reclaimed — the check is a single FRESH read, never a value assembled from an earlier, separate stat', () => {
  const { dir, lockPath } = tmpLock();
  try {
    fs.writeFileSync(lockPath, 'LIVE_TOKEN');
    const old = new Date(Date.now() - 120000);
    fs.utimesSync(lockPath, old, old); // looked stale a moment ago
    fs.utimesSync(lockPath, new Date(), new Date()); // the live holder's heartbeat just refreshed it
    assert.strictEqual(S.tryReclaimStaleLock(lockPath, 'INTRUDER', 60000), false);
    assert.strictEqual(S.readLockToken(lockPath), 'LIVE_TOKEN', 'the live holder\'s lock must survive completely untouched');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

t5('V15 (FOURTH recheck): the lock path is NEVER absent during a reclaim — a concurrent exclusive-create attempt mid-reclaim still sees the path occupied, closing the exact vacancy the THIRD recheck\'s capture-then-verify design left open', () => {
  const { dir, lockPath } = tmpLock();
  try {
    fs.writeFileSync(lockPath, 'STALE');
    const old = new Date(Date.now() - 120000);
    fs.utimesSync(lockPath, old, old);
    const origRename = fs.renameSync;
    let checkedMidRename = false;
    fs.renameSync = function (src, dest, ...rest) {
      if (dest === lockPath) {
        // exactly the moment the OLD (third-recheck) design would have had lockPath vacant (post-capture,
        // pre-restore-or-claim) — the NEW design never removes lockPath at all; this must still see it
        // occupied right now.
        assert.ok(fs.existsSync(lockPath), 'lockPath must never be absent mid-reclaim');
        let creationErrorCode = null;
        try { fs.closeSync(fs.openSync(lockPath, 'wx')); } catch (e) { creationErrorCode = e.code; }
        assert.strictEqual(creationErrorCode, 'EEXIST', 'a fresh exclusive-create must NEVER succeed mid-reclaim (the path was never vacant) — the only expected refusal reason is EEXIST');
        checkedMidRename = true;
      }
      return origRename.call(fs, src, dest, ...rest);
    };
    let reclaimed;
    try { reclaimed = S.tryReclaimStaleLock(lockPath, 'FRESH_TOKEN', 60000); }
    finally { fs.renameSync = origRename; }
    assert.strictEqual(checkedMidRename, true, 'the instrumentation must actually have run during the real reclaim');
    assert.strictEqual(reclaimed, true);
    assert.strictEqual(S.readLockToken(lockPath), 'FRESH_TOKEN');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

t5('N07 (Codex recheck out-p10, 2026-09-24): a THROWN token write during RECLAMATION leaves the ORIGINAL stale lock byte-for-byte untouched (never a fresh zero-byte orphan) — an immediate successor can retry right away, without waiting out the full stale interval', () => {
  const { dir, lockPath } = tmpLock();
  try {
    fs.writeFileSync(lockPath, 'STALE_TOKEN');
    const old = new Date(Date.now() - 120000);
    fs.utimesSync(lockPath, old, old);
    const realWriteFileSync = fs.writeFileSync;
    fs.writeFileSync = function (p, ...rest) {
      if (typeof p === 'string' && p.includes('.reclaim.')) { const e = new Error('EIO simulated'); e.code = 'EIO'; throw e; }
      return realWriteFileSync.call(fs, p, ...rest);
    };
    let reclaimed;
    try { reclaimed = S.tryReclaimStaleLock(lockPath, 'NEW_TOKEN', 60000); }
    finally { fs.writeFileSync = realWriteFileSync; }
    assert.strictEqual(reclaimed, false, 'a thrown token write during reclamation must report failure, never a false success');
    assert.strictEqual(S.readLockToken(lockPath), 'STALE_TOKEN', 'the ORIGINAL stale lock must survive completely untouched — no zero-byte orphan left behind');
    // an immediate successor (no waiting) must be able to retry the SAME stale lock right away.
    const immediateRetry = S.tryReclaimStaleLock(lockPath, 'NEW_TOKEN_2', 60000);
    assert.strictEqual(immediateRetry, true, 'the very next attempt must succeed immediately — the stale lock was never corrupted into a fresh-looking orphan that would have fooled the next staleness check');
    assert.strictEqual(S.readLockToken(lockPath), 'NEW_TOKEN_2');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

t5('N07 (Codex recheck out-p10, 2026-09-24): a write that reports success but silently writes the WRONG bytes during ACQUISITION is caught by an independent readback — refuses outright, never a fence() that can only ever report false', async () => {
  const { dir, lockPath } = tmpLock();
  try {
    const realWriteSync = fs.writeSync;
    fs.writeSync = function (fd, ...rest) {
      // silently write garbage instead of the real token — only a readback can catch this (the write
      // itself neither throws nor reports a short count).
      const garbage = Buffer.from('WRONG-BYTES-ENTIRELY');
      return realWriteSync.call(fs, fd, garbage, 0, garbage.length, 0);
    };
    let fnCalled = false, r;
    try { r = await S.withStateLock(lockPath, () => { fnCalled = true; return 'unreachable'; }, {}); }
    finally { fs.writeSync = realWriteSync; }
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.strictEqual(r.reason, 'lock-write-failed');
    assert.strictEqual(fnCalled, false, 'fn() must never be invoked after a readback-mismatched token write');
    // L2-R (Security Boss addendum, 2026-09-24, Codex p12 wave 7 — INTENTIONAL TRADE-OFF, supersedes N07's
    // original "always clean up" claim for this exact case): the garbage content is NOT this call's own
    // token, so cleanup is no longer unconditional — it is just as ownership-safe as the normal release path
    // (see usage-guard-state.cjs's own L2-R comment), because in a real adversarial interleaving this exact
    // "readback mismatch" shape is indistinguishable from a genuine LIVE successor's takeover. The garbage
    // stub is left in place rather than risking a successor's real lock; it self-heals via the ordinary
    // age-only staleness reclaim once `staleMs` elapses, same as any other stale lock.
    assert.strictEqual(fs.existsSync(lockPath), true, 'content that is not exactly this call\'s own token must be left untouched, not guessed at and deleted');
    assert.strictEqual(S.readLockToken(lockPath), 'WRONG-BYTES-ENTIRELY', 'ownership-safe cleanup must not have touched content that could belong to a successor');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- L2-R (Security Boss addendum, 2026-09-24, Codex p12 wave 7 finding L2-R) — a DELAYED creator whose own
// readback later mismatches must NEVER unconditionally delete lockPath: by the time the mismatch is noticed,
// an arbitrarily long real-world delay may have let a genuine, LIVE successor's reclaim land on this exact
// path. Reproduced deterministically, single-process (this project's own established backdating technique):
// the successor's reclaim is driven for real (the actual `tryReclaimStaleLock` primitive, a real atomic
// replace-rename), injected right after this call's own `fs.closeSync(fd)` — LIVE-VERIFIED on this Windows
// runtime that renaming onto a still-open destination throws EPERM, so the exploitable gap is specifically
// AFTER close, before the readback, never while the creator's own fd is still open. The reclaim's staleness
// check must not see the creator's own (very much alive) pid embedded in its just-written token, so
// `process.kill` is mocked to report ESRCH for that ONE check only (a real different, dead holder would
// naturally fail the SAME liveness check; there is no other way to simulate "a different holder" within one
// process, since the creator's own token always embeds a live pid — see this project's own wp-j2/wp-j3
// memory on the identical constraint for the `randomToken()` reclaim tests). ----
t5('L2-R: a delayed creator whose own write/readback mismatches must NEVER delete lockPath once it belongs to a different, LIVE successor — cleanup is ownership-safe (exact-token match only), just like the normal release path', async () => {
  const { dir, lockPath } = tmpLock();
  try {
    const successorToken = 'SUCCESSOR-LIVE-TOKEN';
    const realCloseSync = fs.closeSync;
    const realKill = process.kill;
    let patched = false;
    let reclaimResult = null;
    fs.closeSync = function (fd) {
      const result = realCloseSync.call(fs, fd);
      if (!patched) {
        patched = true;
        // this caller's own token was already written and is now sitting at lockPath — back-date it so a
        // reclaim judges it stale by age, and lie about the embedded (very much alive, our own) pid being
        // dead for this ONE staleness check, so the reclaim proceeds exactly as it would against a genuinely
        // different, crashed holder.
        const past = new Date(Date.now() - 10 * 60 * 1000);
        fs.utimesSync(lockPath, past, past);
        process.kill = function (pid, sig) {
          if (sig === 0) { const e = new Error('ESRCH simulated'); e.code = 'ESRCH'; throw e; }
          return realKill.call(process, pid, sig);
        };
        try { reclaimResult = S.tryReclaimStaleLock(lockPath, successorToken, 1000); }
        finally { process.kill = realKill; }
      }
      return result;
    };
    let r;
    try { r = await S.withStateLock(lockPath, () => 'unreachable', { staleMs: 60000, timeoutMs: 50 }); }
    finally { fs.closeSync = realCloseSync; }
    assert.strictEqual(patched, true, 'the injected close-time reclaim must actually have run');
    assert.strictEqual(reclaimResult, true, 'test setup: the simulated successor reclaim must actually have won');
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.strictEqual(S.readLockToken(lockPath), successorToken, 'the successor\'s LIVE lock must survive completely untouched — an unconditional unlink here would have deleted it out from under the successor');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

t5('V15 (third recheck): a token-write failure during acquisition REFUSES outright — fn() is never invoked with an always-false fence, and no empty lock is left behind', async () => {
  const { dir, lockPath } = tmpLock();
  try {
    const realOpenSync = fs.openSync;
    const realWriteSync = fs.writeSync;
    let trackedFd = null;
    fs.openSync = function (p, ...rest) {
      const fd = realOpenSync.call(fs, p, ...rest);
      if (p === lockPath) trackedFd = fd;
      return fd;
    };
    fs.writeSync = function (fd, ...rest) {
      if (fd === trackedFd) { const e = new Error('EIO simulated'); e.code = 'EIO'; throw e; }
      return realWriteSync.call(fs, fd, ...rest);
    };
    let fnCalled = false;
    let r;
    try { r = await S.withStateLock(lockPath, () => { fnCalled = true; return 'should-not-run'; }, {}); }
    finally { fs.openSync = realOpenSync; fs.writeSync = realWriteSync; }
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.strictEqual(r.reason, 'lock-write-failed');
    assert.strictEqual(fnCalled, false, 'fn() must never be invoked after a failed token write');
    // L2-R (Security Boss addendum, 2026-09-24, Codex p12 wave 7 — INTENTIONAL TRADE-OFF): the throw left
    // lockPath's content still exactly empty (never any bytes of myToken landed), which is NOT this call's
    // own token either — ownership-safe cleanup (exact-match-only, same as the normal release path) does not
    // delete it, since an adversarial interleaving could have let a genuine successor's reclaim happen here
    // too. A leftover empty stub self-heals via the ordinary age-only staleness reclaim once `staleMs`
    // elapses — see usage-guard-state.cjs's own L2-R comment.
    assert.strictEqual(fs.existsSync(lockPath), true, 'an empty stub that is not this call\'s own token must be left in place, not guessed at and deleted');
    assert.strictEqual(S.readLockToken(lockPath), '', 'the stub must be exactly as this call left it — untouched');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

t5('V15 (third recheck): a fence() check that passed EARLIER in a callback must not let a write land AFTER the lock changed hands — writeStateTo re-verifies the fence in the SAME critical step as the rename', async () => {
  const { dir, lockPath } = tmpLock();
  const statePath = path.join(dir, 'state.json');
  try {
    fs.writeFileSync(statePath, JSON.stringify({ ownerOverride: { active: true } }));
    const r = await S.withStateLock(lockPath, (fence) => {
      assert.strictEqual(fence(), true, 'sanity: our own token is on disk at the start of the callback');
      // simulate a completed competing reclaim landing AFTER this callback's own (correctly passing)
      // fence() check but BEFORE the actual disk publish — exactly the residual gap Codex's probe exploited.
      fs.writeFileSync(lockPath, 'someone-elses-token');
      let threw = null;
      try { G.writeStateTo(statePath, { ownerOverride: undefined }, fence); } catch (e) { threw = e; }
      return { code: threw && threw.code };
    }, { staleMs: 100000, timeoutMs: 200 });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.value.code, 'EFENCED', 'writeStateTo must refuse to publish once the fence no longer matches, even though the callback\'s OWN earlier fence() check had passed');
    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.strictEqual(persisted.ownerOverride && persisted.ownerOverride.active, true, 'the override must survive — the fenced write must never have landed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

t5('V15 (FOURTH recheck): Codex\'s two-reclaimer schedule through the REAL publication path — a stale holder A can never resurrect an override that a legitimate reclaimer B already cleared', () => {
  const { dir, lockPath } = tmpLock();
  const statePath = path.join(dir, 'state.json');
  try {
    fs.writeFileSync(statePath, JSON.stringify({ ownerOverride: { active: true } }));
    // A's token must name a pid that is genuinely NOT alive — `S.randomToken()` would embed THIS test
    // process's own (very much alive) pid, which the liveness-aware reclaim check (V15, fourth recheck)
    // would then correctly refuse to touch regardless of age. 999999 mirrors this project's own
    // established "definitely-not-a-real-pid" convention (see usage-guard.test.cjs's own awaitChildClaim
    // fixtures).
    const tokenA = '999999:' + S.randomToken().split(':')[1];
    fs.writeFileSync(lockPath, tokenA);
    const past = new Date(Date.now() - 120000);
    fs.utimesSync(lockPath, past, past);
    const fenceA = () => S.readLockToken(lockPath) === tokenA;
    // B reclaims (the real function) and PUBLISHES a real "override cleared" write, exactly like a genuine
    // concurrent override-off/account-switch would.
    const tokenB = S.randomToken();
    const reclaimedByB = S.tryReclaimStaleLock(lockPath, tokenB, 60000);
    assert.strictEqual(reclaimedByB, true, 'B must win the stale reclaim');
    const fenceB = () => S.readLockToken(lockPath) === tokenB;
    G.writeStateTo(statePath, {}, fenceB); // B clears the override (fresh object without it)
    assert.strictEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')).ownerOverride, undefined, 'sanity: B really cleared it');
    // A, unaware it has already been reclaimed, now tries to publish its OWN (stale) pre-clear snapshot —
    // Codex's exact probe: "A resumes and replaces B's live lock and clears the override". A's write must
    // be refused, and A must never have been able to steal B's lock back either.
    let threw = null;
    try { G.writeStateTo(statePath, { ownerOverride: { active: true } }, fenceA); } catch (e) { threw = e; }
    assert.strictEqual(threw && threw.code, 'EFENCED', 'A\'s write must be refused — A no longer holds the lock');
    assert.strictEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')).ownerOverride, undefined, 'B\'s clear must survive — A must never resurrect it');
    assert.strictEqual(S.readLockToken(lockPath), tokenB, 'B\'s lock must still be intact — A never replaced it');
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
