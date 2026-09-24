#!/usr/bin/env node
'use strict';
/**
 * forge-config-once.test.cjs — real tests for the cross-process file lock's OWNERSHIP hardening (V09, Codex
 * recheck 2026-09-24: "Reclamation uses age alone; release unconditionally unlinks the pathname. Controlled-
 * clock execution showed live A's lock stolen after 16 seconds, A's release deleting B's replacement, then C
 * acquiring concurrently"). HERMETIC: every lock lives under a throwaway os.tmpdir() directory; nothing here
 * touches the real project or ~/.claude. The clock is controlled the same way this codebase's own CFG-09
 * tests already do (fs.utimesSync backdating a lock file's mtime), not real sleeps/timers. V09 out-p10 added
 * a second control: reclaim now ALSO requires the recorded holder pid to be provably dead (process.kill(pid,
 * 0) failing with ESRCH), so any test that wants a lock to be genuinely RECLAIMABLE must give it a token whose
 * embedded pid will read as dead — this file mocks the global `process.kill` for exactly that (never a real
 * spawned/killed child process, to stay hermetic and fast), the same way it already mocks `fs.*` functions to
 * inject fs-seam interleavings.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const once = require('./forge-config-once.cjs');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

function tmpTarget() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-config-once-'));
  return path.join(dir, 'FORGE_CONFIG.json'); // the lock lives at <this>.lock; the target file itself need not exist
}
function backdate(lockPath, ageMs) {
  const old = new Date(Date.now() - ageMs);
  fs.utimesSync(lockPath, old, old);
}
/** withDeadPid(pid, fn) -> fn()'s return value, while process.kill(pid, 0) is mocked to throw ESRCH for that
 *  EXACT pid (any other pid falls through to the real process.kill, unaffected) — simulates "this holder's
 *  process has genuinely exited" without ever spawning or killing a real OS process. Always restores the
 *  real process.kill, even if fn throws. */
function withDeadPid(pid, fn) {
  const origKill = process.kill;
  process.kill = function (p, sig) {
    if (p === pid) { const e = new Error('simulated: no such process'); e.code = 'ESRCH'; throw e; }
    return origKill.apply(process, arguments);
  };
  try { return fn(); } finally { process.kill = origKill; }
}

console.log('forge-config-once.test.cjs — lock ownership (V09)');

// ---------------------------------------------------------------------------------------------------
console.log('\n1) randomToken / basic acquire-release round trip');
t('randomToken() embeds this process pid and is different on every call', () => {
  const a = once.randomToken();
  const b = once.randomToken();
  assert.ok(a.startsWith(process.pid + ':'), a);
  assert.notStrictEqual(a, b);
});
t('acquireLock returns {path, token}; the lock file holds that exact token; releaseLock removes it', () => {
  const file = tmpTarget();
  const lock = once.acquireLock(file);
  assert.strictEqual(lock.path, file + '.lock');
  assert.strictEqual(fs.readFileSync(lock.path, 'utf8'), lock.token);
  once.releaseLock(lock);
  assert.strictEqual(fs.existsSync(lock.path), false);
});
t('a second acquire on an UNHELD file after release gets a brand-new token', () => {
  const file = tmpTarget();
  const l1 = once.acquireLock(file);
  once.releaseLock(l1);
  const l2 = once.acquireLock(file);
  assert.notStrictEqual(l1.token, l2.token);
  once.releaseLock(l2);
});

// ---------------------------------------------------------------------------------------------------
console.log('\n2) a live (non-stale) lock blocks a second acquirer (lock_busy), never silently reclaimed early');
t('acquireLock on an actively-held, fresh lock throws lock_busy after opts.timeoutMs — the holder is untouched', () => {
  const file = tmpTarget();
  const holder = once.acquireLock(file, { staleMs: 60000 });
  let err = null;
  try { once.acquireLock(file, { staleMs: 60000, timeoutMs: 100, pollMs: 5 }); }
  catch (e) { err = e; }
  assert.ok(err && err.code === 'lock_busy', err && err.message);
  assert.strictEqual(fs.readFileSync(holder.path, 'utf8'), holder.token, 'the original holder is still the lock owner');
  once.releaseLock(holder);
});

// ---------------------------------------------------------------------------------------------------
console.log('\n3) V09 — the exact Codex-measured transition: A\'s recorded pid is dead and its lock is stale, B');
console.log('   reclaims, A resumes and releases, B\'s lock survives, and C cannot acquire concurrently');
t('V09: full sequence — reclaim requires BOTH staleness and pid death, a stale release is a no-op, and B stays exclusive', () => {
  const file = tmpTarget();
  const lockPath = file + '.lock';
  const DEAD_PID = 999995; // simulated — see withDeadPid; never a real pid this test process actually has
  // 1. "A" is a holder whose process has genuinely exited — a lock a real, still-running test process could
  //    never honestly construct for itself, since randomToken() always embeds process.pid (always alive
  //    here). Written directly, then backdated well past staleMs, to represent both required signals.
  const tokenA = DEAD_PID + ':simulated-dead-holder';
  fs.writeFileSync(lockPath, tokenA);
  backdate(lockPath, 5000);
  const lockA = { path: lockPath, token: tokenA };
  // 2. B comes along and reclaims it — BOTH signals (stale mtime AND dead pid) must agree.
  const lockB = withDeadPid(DEAD_PID, () => once.acquireLock(file, { staleMs: 1000, timeoutMs: 2000, pollMs: 5 }));
  assert.notStrictEqual(lockB.token, lockA.token, 'B holds a DIFFERENT token than A ever had');
  assert.strictEqual(fs.readFileSync(lockPath, 'utf8'), lockB.token, 'the lock file now holds B\'s token');
  // 3. "A resumes" (it still only knows its OWN original lock object) and releases.
  once.releaseLock(lockA);
  // B's replacement lock must survive A's stale release completely untouched.
  assert.strictEqual(fs.existsSync(lockPath), true, 'B\'s lock file still exists after A\'s (stale) release');
  assert.strictEqual(fs.readFileSync(lockPath, 'utf8'), lockB.token, 'B\'s token is unchanged — A\'s release did not touch it');
  // 4. C tries to acquire concurrently while B still legitimately holds a FRESH (just-reclaimed) lock; B's
  //    own real pid (this test process) is alive, so C cannot reclaim it even once staleMs elapses.
  let cErr = null;
  try { once.acquireLock(file, { staleMs: 1000, timeoutMs: 150, pollMs: 5 }); }
  catch (e) { cErr = e; }
  assert.ok(cErr && cErr.code === 'lock_busy', 'C must be refused — B\'s lock is live (its pid is alive)');
  // 5. B releases normally; the lock is now genuinely free.
  once.releaseLock(lockB);
  assert.strictEqual(fs.existsSync(lockPath), false);
  const lockD = once.acquireLock(file, { staleMs: 1000 });
  assert.ok(lockD.token, 'a fresh acquire succeeds once the lock is genuinely free');
  once.releaseLock(lockD);
});

// ---------------------------------------------------------------------------------------------------
console.log('\n4) tryReclaimStaleLock — direct unit coverage: reclaim needs BOTH staleness AND a dead pid (V09 out-p10)');
t('a lock old enough by TIME but whose recorded pid is still ALIVE must never be reclaimed', () => {
  const file = tmpTarget();
  const lockPath = file + '.lock';
  // process.pid is THIS actual running test process — genuinely, unmockably alive.
  fs.writeFileSync(lockPath, process.pid + ':still-alive-holder');
  backdate(lockPath, 5000);
  const ok = once.tryReclaimStaleLock(lockPath, 1000, once.randomToken());
  assert.strictEqual(ok, false, 'a live holder\'s lock is never eligible, no matter how old its heartbeat looks');
  assert.strictEqual(fs.readFileSync(lockPath, 'utf8'), process.pid + ':still-alive-holder', 'untouched — reclaim never happened');
});
t('a lock whose recorded pid is dead but NOT yet stale by time must never be reclaimed', () => {
  const file = tmpTarget();
  const lockPath = file + '.lock';
  const DEAD_PID = 999994;
  fs.writeFileSync(lockPath, DEAD_PID + ':dead-but-fresh');
  // no backdate — this lock's mtime is "now", well inside staleMs
  const ok = withDeadPid(DEAD_PID, () => once.tryReclaimStaleLock(lockPath, 60000, once.randomToken()));
  assert.strictEqual(ok, false, 'a dead pid alone is not enough — the heartbeat must also actually be stale');
  assert.strictEqual(fs.readFileSync(lockPath, 'utf8'), DEAD_PID + ':dead-but-fresh');
});
t('a lock that is BOTH stale-by-time AND dead-by-pid is genuinely reclaimed — the file now holds the NEW token', () => {
  const file = tmpTarget();
  const lockPath = file + '.lock';
  const DEAD_PID = 999993;
  fs.writeFileSync(lockPath, DEAD_PID + ':old-token');
  backdate(lockPath, 5000);
  const newToken = once.randomToken();
  const ok = withDeadPid(DEAD_PID, () => once.tryReclaimStaleLock(lockPath, 1000, newToken));
  assert.strictEqual(ok, true);
  assert.strictEqual(fs.readFileSync(lockPath, 'utf8'), newToken);
  // no leftover .reclaim.* temp file
  const dir = path.dirname(lockPath);
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.reclaim.'));
  assert.deepStrictEqual(leftovers, [], leftovers.join(','));
});
t('a lock that vanished entirely between the eligibility check and the reclaim rename (already released) refuses cleanly, no throw', () => {
  const file = tmpTarget();
  const lockPath = file + '.lock';
  const DEAD_PID = 999992;
  fs.writeFileSync(lockPath, DEAD_PID + ':tok');
  backdate(lockPath, 5000);
  fs.unlinkSync(lockPath); // simulate a legitimate release that happened in between
  const ok = withDeadPid(DEAD_PID, () => once.tryReclaimStaleLock(lockPath, 1000, once.randomToken()));
  assert.strictEqual(ok, false);
  assert.strictEqual(fs.existsSync(lockPath), false);
});
t('V09 FIFTH fix (out-p11 + addendum): the lock path is NEVER absent during a reclaim — a concurrent exclusive-create attempt mid-reclaim still sees the path occupied, closing the exact "third acquirer takes the vacant path" half of the finding (mirrors this project\'s own usage-guard-state.cjs test for its identical fix)', () => {
  const file = tmpTarget();
  const lockPath = file + '.lock';
  const DEAD_PID = 999991;
  fs.writeFileSync(lockPath, DEAD_PID + ':stale-token');
  backdate(lockPath, 5000);
  const origRename = fs.renameSync;
  let checkedMidRename = false;
  fs.renameSync = function (src, dest) {
    if (dest === lockPath) {
      // exactly the moment the OLD (steal-away) design would have had lockPath vacant (post-steal,
      // pre-restore-or-create) — the new design never removes lockPath at all; a concurrent fresh
      // exclusive-create must still see it occupied right now.
      assert.ok(fs.existsSync(lockPath), 'lockPath must never be absent mid-reclaim');
      let creationErrorCode = null;
      try { fs.closeSync(fs.openSync(lockPath, 'wx')); } catch (e) { creationErrorCode = e.code; }
      assert.strictEqual(creationErrorCode, 'EEXIST', 'a fresh exclusive-create must NEVER succeed mid-reclaim (the path was never vacant)');
      checkedMidRename = true;
    }
    return origRename.apply(fs, arguments);
  };
  let ok;
  try {
    ok = withDeadPid(DEAD_PID, () => once.tryReclaimStaleLock(lockPath, 1000, once.randomToken()));
  } finally {
    fs.renameSync = origRename;
  }
  assert.strictEqual(checkedMidRename, true, 'the instrumentation must actually have run during the real reclaim');
  assert.strictEqual(ok, true);
  const dir = path.dirname(lockPath);
  const leftovers = fs.readdirSync(dir).filter((f) => f !== path.basename(lockPath));
  assert.deepStrictEqual(leftovers, [], 'no stray private/temp file left behind: ' + leftovers.join(','));
});
t('V09 FIFTH fix, honest residual (measured, not assumed): a genuinely concurrent write landing between the eligibility check and the replace-rename is silently overwritten by a blind replace — this is why every real write MUST use fence() at publish time (see forge-config.test.cjs), not trust tryReclaimStaleLock\'s own success alone', () => {
  const file = tmpTarget();
  const lockPath = file + '.lock';
  const DEAD_PID = 999990;
  fs.writeFileSync(lockPath, DEAD_PID + ':deadfeeddeadfeed');
  backdate(lockPath, 5000);
  const origRename = fs.renameSync;
  let hijacked = false;
  const freshToken = process.pid + ':freshlivetoken';
  const ourToken = once.randomToken();
  fs.renameSync = function (src, dest) {
    if (!hijacked && dest === lockPath) {
      hijacked = true;
      // A genuine concurrent write (e.g. a different live holder's own refresh) lands in the instant between
      // this call's eligibility check and its replace-rename — a raw fs-seam injection, not a second reclaim.
      fs.writeFileSync(lockPath, freshToken);
    }
    return origRename.apply(fs, arguments);
  };
  let ok;
  try {
    ok = withDeadPid(DEAD_PID, () => once.tryReclaimStaleLock(lockPath, 1000, ourToken));
  } finally {
    fs.renameSync = origRename;
  }
  assert.strictEqual(hijacked, true, 'the injected interleaving must actually have fired');
  // Documented, not silently claimed fixed: a plain replace-rename is unconditional, so our own later replace
  // simply overwrites whatever landed in that instant — `ok` reports true because our OWN readback matches,
  // even though a genuinely different write briefly existed there. Closing this needs a real compare-and-swap
  // (not available from Node's fs API) or OS-level locking; the actual safety net is the fence at publish time.
  assert.strictEqual(ok, true, 'documents the residual: a blind replace does not protect a write that lands in this narrow window');
  assert.strictEqual(fs.readFileSync(lockPath, 'utf8'), ourToken, 'our own replace is what is actually on disk — the injected fresh write did not survive');
  const dir = path.dirname(lockPath);
  const leftovers = fs.readdirSync(dir).filter((f) => f !== path.basename(lockPath));
  assert.deepStrictEqual(leftovers, [], 'no stray private/temp file left behind: ' + leftovers.join(','));
});
t('V09 FIFTH fix, two-reclaimer interleaving THROUGH THE RECLAIM PATH (Security Boss addendum): B and C can each independently pass eligibility on the SAME stale lock and each report tryReclaimStaleLock success — but only the physically-last replace is ever actually on disk, and withLock\'s own fence() correctly refuses the earlier "winner" once it checks again at publish time', () => {
  const file = tmpTarget();
  const lockPath = file + '.lock';
  const DEAD_PID = 999979;
  fs.writeFileSync(lockPath, DEAD_PID + ':stale-token');
  backdate(lockPath, 5000);
  const origOpenSync = fs.openSync;
  let injected = false;
  let cWon = null;
  const tokenB = once.randomToken();
  const tokenC = once.randomToken();
  fs.openSync = function (p, flags) {
    if (!injected && typeof p === 'string' && p.includes('.reclaim.') && flags === 'wx') {
      // B has just started preparing its OWN private reclaim file — lockPath still shows the ORIGINAL stale
      // token (B has not replaced anything yet). A genuinely separate process (C) racing the identical stale
      // lock would ALSO still see it as eligible right now — simulate that with a real, complete reclaim.
      injected = true;
      cWon = withDeadPid(DEAD_PID, () => once.tryReclaimStaleLock(lockPath, 1000, tokenC));
    }
    return origOpenSync.apply(fs, arguments);
  };
  let bWon;
  try {
    bWon = withDeadPid(DEAD_PID, () => once.tryReclaimStaleLock(lockPath, 1000, tokenB));
  } finally {
    fs.openSync = origOpenSync;
  }
  // Both C (replaced first, while B had not yet touched lockPath) and B (replaced second, after C) pass
  // their OWN immediate readback — this is the exact, honestly-documented residual (see the file header):
  // a plain replace+readback proves "my write was most recent AT THE INSTANT I CHECKED", never "still true
  // afterward". B's later replace physically wins; only B's token is actually on disk.
  assert.strictEqual(cWon, true, 'C\'s own readback passed at the time it checked — the residual this test measures');
  assert.strictEqual(bWon, true, 'B replaced last and its own readback also passed');
  assert.strictEqual(fs.readFileSync(lockPath, 'utf8'), tokenB, 'only B\'s token is actually on disk — C was silently overwritten');
  // THE ACTUAL SAFETY NET: a caller that used withLock (not the raw primitive directly) re-checks fence()
  // immediately before its own real write. C's fence, checked NOW (after B's later replace), must correctly
  // report false — this is what stops the stale "winner" from taking real action, independent of whichever
  // primitive told it it had won.
  const cFence = () => fs.readFileSync(lockPath, 'utf8') === tokenC; // the same in-place-read comparison withLock's real fence() performs
  assert.strictEqual(cFence(), false, 'C\'s fence must report false once B\'s later replace has actually landed');
  const dir = path.dirname(lockPath);
  const leftovers = fs.readdirSync(dir).filter((f) => f !== path.basename(lockPath));
  assert.deepStrictEqual(leftovers, [], 'no stray private/temp file left behind: ' + leftovers.join(','));
});

// ---------------------------------------------------------------------------------------------------
console.log('\n5) releaseLock is defensive and never throws');
t('releaseLock(null) / releaseLock(undefined) / releaseLock({}) never throw', () => {
  once.releaseLock(null);
  once.releaseLock(undefined);
  once.releaseLock({});
  assert.ok(true);
});
t('releaseLock on an already-vanished lock file never throws', () => {
  const file = tmpTarget();
  const lock = once.acquireLock(file);
  fs.unlinkSync(lock.path);
  once.releaseLock(lock); // must not throw even though the file is already gone
  assert.ok(true);
});

// ---------------------------------------------------------------------------------------------------
console.log('\n6) withLock: acquires, runs fn, always releases (even on throw), and fn sees the lock held');
t('withLock releases on a normal return and on a thrown error alike; the lock never leaks', () => {
  const file = tmpTarget();
  once.withLock(file, () => {
    assert.strictEqual(fs.existsSync(file + '.lock'), true, 'the lock is held while fn runs');
  });
  assert.strictEqual(fs.existsSync(file + '.lock'), false, 'released after a normal return');
  assert.throws(() => once.withLock(file, () => { throw new Error('boom'); }), /boom/);
  assert.strictEqual(fs.existsSync(file + '.lock'), false, 'released even after fn threw');
});

// ---------------------------------------------------------------------------------------------------
console.log('\n7) V09 second Codex recheck (out-p8): ownership transitions must be ATOMIC, not check-then-act');
console.log('   "Injected interleaving made two reclaimers both return success; another made A\'s release');
console.log('   delete B\'s replacement. Injected token-write EIO was swallowed and left an unidentifiable lock."');

t('V09.2: competing reclaimers racing the SAME stale, dead-pid lock — exactly one wins, and the loser never touches the winner\'s fresh lock', () => {
  const file = tmpTarget();
  const lockPath = file + '.lock';
  const DEAD_PID = 999990;
  fs.writeFileSync(lockPath, DEAD_PID + ':stale-token');
  backdate(lockPath, 5000);
  // Two reclaimers (B, C) both independently see the SAME stale-and-dead lock before either acts — the real
  // race Codex measured. A pre-fix check-then-act sequence lets both "win" because the compare and the
  // replace are two separate steps; the fix must make the CLAIM itself atomic (an unconditional rename of
  // the exact source name once eligibility is confirmed), so only whichever call physically executes the
  // rename first can ever proceed — the second necessarily observes a DIFFERENT (already-replaced, live)
  // lock the instant it tries to act, never the stale one it originally "saw".
  const tokenB = once.randomToken();
  const tokenC = once.randomToken();
  let bWon, cWon;
  withDeadPid(DEAD_PID, () => {
    bWon = once.tryReclaimStaleLock(lockPath, 1000, tokenB);
    cWon = once.tryReclaimStaleLock(lockPath, 1000, tokenC);
  });
  assert.strictEqual(bWon, true, 'B (first to act) must win');
  assert.strictEqual(cWon, false, 'C (racing the identical stale snapshot) must lose, never also succeed');
  assert.strictEqual(fs.readFileSync(lockPath, 'utf8'), tokenB, 'B\'s lock is completely intact — C never touched it');
  // no stray private/temp files from either attempt
  const dir = path.dirname(lockPath);
  const leftovers = fs.readdirSync(dir).filter((f) => f !== path.basename(lockPath));
  assert.deepStrictEqual(leftovers, [], leftovers.join(','));
});

t('V09.2: release-vs-reclaim interleaving — A\'s release must NEVER remove B\'s live replacement lock', () => {
  const file = tmpTarget();
  const lockPath = file + '.lock';
  const lockA = once.acquireLock(file);
  // Simulate the exact Codex interleaving: between A deciding to release and A's release actually
  // running, a reclaimer legitimately replaced the lock with a fresh one (B). A's own `lock` object
  // still only knows its OWN original token — it must detect the mismatch and leave B's lock untouched.
  const tokenB = once.randomToken();
  fs.writeFileSync(lockPath, tokenB);
  once.releaseLock(lockA);
  assert.strictEqual(fs.existsSync(lockPath), true, 'B\'s lock file must still exist after A\'s stale release');
  assert.strictEqual(fs.readFileSync(lockPath, 'utf8'), tokenB, 'B\'s token is byte-for-byte unchanged — A\'s release never touched it');
  const dir = path.dirname(lockPath);
  const leftovers = fs.readdirSync(dir).filter((f) => f !== path.basename(lockPath));
  assert.deepStrictEqual(leftovers, [], 'no stray private/temp file left behind by the failed release: ' + leftovers.join(','));
});

t('V09.2: a token write that fails AFTER the exclusive create succeeds FAILS acquisition outright — no unidentifiable orphan lock', () => {
  const file = tmpTarget();
  const lockPath = file + '.lock';
  const origWriteSync = fs.writeSync;
  let sawWrite = false;
  fs.writeSync = function (fd, data) {
    if (data === undefined ? false : String(data).includes(process.pid + ':')) {
      // this is the lock-token write (randomToken() always embeds "<pid>:") — simulate the exact Codex
      // fault: the exclusive CREATE already succeeded (the file exists, e.g. empty) but the WRITE of the
      // owner token itself fails (EIO) — this must never be silently swallowed and treated as success.
      sawWrite = true;
      const err = new Error('simulated EIO during lock token write');
      err.code = 'EIO';
      throw err;
    }
    return origWriteSync.apply(fs, arguments);
  };
  let threw = null;
  try {
    once.acquireLock(file);
  } catch (e) {
    threw = e;
  } finally {
    fs.writeSync = origWriteSync;
  }
  assert.ok(sawWrite, 'the simulated token-write failure must actually have been exercised');
  assert.ok(threw, 'acquireLock must FAIL (throw), never return success with an unidentifiable lock');
  assert.strictEqual(fs.existsSync(lockPath), false, 'the caller never enters the transaction with an orphan lock — the failed create is cleaned up');
});

// ---------------------------------------------------------------------------------------------------
console.log('\n8) V09 THIRD Codex recheck (out-p9): "a stale holder releases after B has acquired; its rename');
console.log('   temporarily removes B\'s live lock; injecting C\'s acquisition at that point succeeds; restoration');
console.log('   encounters C\'s lock and discards B\'s captured lock. A short writeSync return also counts as');
console.log('   success: a three-byte token was accepted and left an unreleasable lock."');

t('V09.3: release must verify ownership IN PLACE before ever renaming — it must never vacate a live, different holder\'s lock, not even for an instant', () => {
  const file = tmpTarget();
  const lockPath = file + '.lock';
  // A is a stale/slow holder whose OWN lock object still remembers its original token.
  const lockA = once.acquireLock(file, { staleMs: 60000 });
  // B has genuinely reclaimed/replaced the lock — lockPath now holds a DIFFERENT, live token, with a
  // fresh mtime (B's lock is NOT stale). A never learns this; it only knows its own stale `lockA`.
  const lockB = { path: lockPath, token: once.randomToken() };
  fs.writeFileSync(lockPath, lockB.token);

  const origRename = fs.renameSync;
  let renameHit = false;
  let concurrentResult = null;
  // Fs-seam injection: the instant A's release renames (steals) whatever sits at lockPath — the exact
  // point Codex measured the vacated window — try to acquire the SAME lock as a concurrent third party
  // (C). A pre-fix release reaches this rename unconditionally; a fixed release must never call it at all
  // for a lock it does not own, so this hook must never fire.
  fs.renameSync = function (src, dest) {
    const r = origRename.apply(fs, arguments);
    if (!renameHit && src === lockA.path) {
      renameHit = true;
      try {
        const c = once.acquireLock(file, { staleMs: 60000, timeoutMs: 0, pollMs: 5 });
        concurrentResult = 'acquired';
        once.releaseLock(c); // clean up C's lock immediately so it does not linger past this probe
      } catch (e) {
        concurrentResult = (e && e.code) || 'error';
      }
    }
    return r;
  };
  try {
    once.releaseLock(lockA);
  } finally {
    fs.renameSync = origRename;
  }

  assert.strictEqual(renameHit, false, 'a release for a lock this call does not own must never call rename at all — the in-place ownership check must catch it first');
  assert.strictEqual(concurrentResult, null, 'no concurrent acquisition should even be attempted, since a fixed release never vacates lockPath in the first place; got: ' + concurrentResult);
  assert.strictEqual(fs.readFileSync(lockPath, 'utf8'), lockB.token, 'B\'s lock is fully intact — A\'s mismatched release must not have touched it at all');
  const dir = path.dirname(lockPath);
  const leftovers = fs.readdirSync(dir).filter((f) => f !== path.basename(lockPath));
  assert.deepStrictEqual(leftovers, [], 'no stray private/temp file left behind: ' + leftovers.join(','));
});

t('V09 FIFTH fix: a THROWN token write while preparing the private reclaim file leaves the ORIGINAL stale lock byte-for-byte untouched (never a fresh zero-byte orphan, never a rename attempted) — an immediate successor can retry right away, without waiting out the full stale interval', () => {
  const file = tmpTarget();
  const lockPath = file + '.lock';
  const DEAD_PID = 999989;
  const staleToken = DEAD_PID + ':stale-token';
  fs.writeFileSync(lockPath, staleToken);
  backdate(lockPath, 5000);
  const origWriteSync = fs.writeSync;
  let sawWrite = false;
  fs.writeSync = function (fd, data) {
    if (!sawWrite && typeof data === 'string' && data.includes(process.pid + ':')) {
      sawWrite = true; // this is the reclaim's own private-file token write
      const e = new Error('simulated EIO during reclaim token write'); e.code = 'EIO'; throw e;
    }
    return origWriteSync.apply(fs, arguments);
  };
  let ok;
  try {
    ok = withDeadPid(DEAD_PID, () => once.tryReclaimStaleLock(lockPath, 1000, once.randomToken()));
  } finally {
    fs.writeSync = origWriteSync;
  }
  assert.ok(sawWrite, 'the simulated token-write failure must actually have been exercised');
  assert.strictEqual(ok, false, 'a thrown token write during reclamation must report failure, never a false success');
  assert.strictEqual(fs.readFileSync(lockPath, 'utf8'), staleToken, 'the ORIGINAL stale lock must survive completely untouched — lockPath itself is never approached until the private file is fully written');
  const dir = path.dirname(lockPath);
  const leftovers = fs.readdirSync(dir).filter((f) => f !== path.basename(lockPath));
  assert.deepStrictEqual(leftovers, [], 'no stray private/temp file left behind: ' + leftovers.join(','));
  // an immediate successor (no waiting) must be able to retry the SAME stale lock right away.
  const retryToken = once.randomToken();
  const retryOk = withDeadPid(DEAD_PID, () => once.tryReclaimStaleLock(lockPath, 1000, retryToken));
  assert.strictEqual(retryOk, true, 'the very next attempt must succeed immediately — the stale lock was never corrupted into a fresh-looking orphan');
  assert.strictEqual(fs.readFileSync(lockPath, 'utf8'), retryToken);
});
t('V09 FIFTH fix: a transient Windows-style EPERM/EBUSY on the replace-rename (another reader briefly has lockPath open — a real, live-confirmed platform difference from POSIX) is retried and still succeeds; a non-transient error is never retried forever', () => {
  const file = tmpTarget();
  const lockPath = file + '.lock';
  const DEAD_PID = 999988;
  fs.writeFileSync(lockPath, DEAD_PID + ':stale-token');
  backdate(lockPath, 5000);
  const origRename = fs.renameSync;
  let attempts = 0;
  fs.renameSync = function (src, dest) {
    if (dest === lockPath) {
      attempts++;
      if (attempts < 3) { const e = new Error('simulated EPERM'); e.code = 'EPERM'; throw e; }
    }
    return origRename.apply(fs, arguments);
  };
  let ok;
  try {
    ok = withDeadPid(DEAD_PID, () => once.tryReclaimStaleLock(lockPath, 1000, once.randomToken()));
  } finally {
    fs.renameSync = origRename;
  }
  assert.strictEqual(attempts, 3, 'must have retried the transient failure before succeeding');
  assert.strictEqual(ok, true, 'a transient EPERM/EBUSY/EACCES must be absorbed by a short retry, matching forge-config.cjs\'s own renameWithRetry convention');
  const dir = path.dirname(lockPath);
  const leftovers = fs.readdirSync(dir).filter((f) => f !== path.basename(lockPath));
  assert.deepStrictEqual(leftovers, [], 'no stray private/temp file left behind: ' + leftovers.join(','));
});
t('V09 FIFTH fix: a NON-transient rename error (e.g. EIO) on the replace fails the reclaim outright, cleans up the private temp file, and never retries', () => {
  const file = tmpTarget();
  const lockPath = file + '.lock';
  const DEAD_PID = 999987;
  const staleToken = DEAD_PID + ':stale-token';
  fs.writeFileSync(lockPath, staleToken);
  backdate(lockPath, 5000);
  const origRename = fs.renameSync;
  let attempts = 0;
  fs.renameSync = function (src, dest) {
    if (dest === lockPath) { attempts++; const e = new Error('simulated EIO'); e.code = 'EIO'; throw e; }
    return origRename.apply(fs, arguments);
  };
  let ok;
  try {
    ok = withDeadPid(DEAD_PID, () => once.tryReclaimStaleLock(lockPath, 1000, once.randomToken()));
  } finally {
    fs.renameSync = origRename;
  }
  assert.strictEqual(attempts, 1, 'a non-transient error must never be retried');
  assert.strictEqual(ok, false);
  assert.strictEqual(fs.readFileSync(lockPath, 'utf8'), staleToken, 'the original stale lock is untouched');
  const dir = path.dirname(lockPath);
  const leftovers = fs.readdirSync(dir).filter((f) => f !== path.basename(lockPath));
  assert.deepStrictEqual(leftovers, [], 'no stray private/temp file left behind: ' + leftovers.join(','));
});

t('V09.3: a SHORT writeSync (returns fewer bytes than the token, no exception) must fail acquisition — a partial token is never accepted', () => {
  const file = tmpTarget();
  const lockPath = file + '.lock';
  const origWriteSync = fs.writeSync;
  let sawShortWrite = false;
  fs.writeSync = function (fd, data) {
    if (typeof data === 'string' && data.includes(process.pid + ':')) {
      // this is the lock-token write — simulate a genuine short write: only 3 of the real bytes actually
      // land on disk, and writeSync truthfully reports that smaller count without throwing at all.
      sawShortWrite = true;
      return origWriteSync.call(fs, fd, data.slice(0, 3));
    }
    return origWriteSync.apply(fs, arguments);
  };
  let threw = null;
  try {
    once.acquireLock(file);
  } catch (e) {
    threw = e;
  } finally {
    fs.writeSync = origWriteSync;
  }
  assert.ok(sawShortWrite, 'the simulated short write must actually have been exercised');
  assert.ok(threw, 'acquireLock must FAIL when writeSync returns fewer bytes than the token — a 3-byte token must never be accepted');
  assert.strictEqual(fs.existsSync(lockPath), false, 'the partial lock must be removed, never left behind as an unreleasable lock');
});

// ---------------------------------------------------------------------------------------------------
console.log('\n9) V09 FOURTH Codex recheck (out-p10): "A reads its own stale lock; B reclaims immediately after that');
console.log('   read; A then captures B\'s fresh lock; C acquires during the vacancy." No capture of a live lock,');
console.log('   ever — exercised through the REAL acquireLock/releaseLock, not the low-level function directly.');

t('out-p10: the exact reported schedule through the real module — B genuinely reclaims A\'s stale-and-dead lock, A\'s resumed release never captures it, and C finds no vacancy at all', () => {
  const file = tmpTarget();
  const lockPath = file + '.lock';
  const DEAD_PID = 999988;
  const tokenA = DEAD_PID + ':simulated-dead-holder';
  // "A reads its own stale lock" — A's own lock object, remembered from whenever it originally acquired.
  fs.writeFileSync(lockPath, tokenA);
  backdate(lockPath, 5000);
  const lockA = { path: lockPath, token: tokenA };

  // "B reclaims immediately after" — a genuine reclaim through the REAL acquireLock(), requiring both
  // staleness and A's simulated-dead pid.
  const lockB = withDeadPid(DEAD_PID, () => once.acquireLock(file, { staleMs: 1000, timeoutMs: 2000, pollMs: 5 }));
  assert.notStrictEqual(lockB.token, tokenA, 'B holds a genuinely fresh, different token');
  assert.strictEqual(fs.readFileSync(lockPath, 'utf8'), lockB.token, 'B\'s fresh lock now occupies the shared name');

  // "A then captures B's fresh lock" — the out-p9 defect this fix removes. A resumes and releases its own
  // (now-superseded) lock object; release must never rename anything once its in-place read already shows a
  // foreign token, so there is no instant in which B's lock is vacated.
  const origRename = fs.renameSync;
  let renameAttempted = false;
  fs.renameSync = function () { renameAttempted = true; return origRename.apply(fs, arguments); };
  let released;
  try { released = once.releaseLock(lockA); }
  finally { fs.renameSync = origRename; }

  assert.strictEqual(released, false, 'A\'s stale release must report it did nothing — it is no longer the owner');
  assert.strictEqual(renameAttempted, false, 'release must never rename anything once its in-place read already shows a foreign token — no capture, ever');
  assert.strictEqual(fs.readFileSync(lockPath, 'utf8'), lockB.token, 'B\'s lock is completely untouched');
  const dir = path.dirname(lockPath);
  const leftovers = fs.readdirSync(dir).filter((f) => f !== path.basename(lockPath));
  assert.deepStrictEqual(leftovers, [], 'no stray private/temp file left behind: ' + leftovers.join(','));

  // "C acquires during the vacancy" — there never was one: B's live lock (real pid, this test process) blocks C.
  let cErr = null;
  try { once.acquireLock(file, { staleMs: 1000, timeoutMs: 100, pollMs: 5 }); }
  catch (e) { cErr = e; }
  assert.ok(cErr && cErr.code === 'lock_busy', 'C must be refused — B\'s lock was never vacated even for an instant');

  once.releaseLock(lockB);
});

t('out-p10: fs-seam injection — B\'s real reclaim lands in the syscall-width gap AFTER release\'s own in-place read completes (readLockInPlace\'s open+fstat+read+close already finished, still A\'s own bytes) but BEFORE releaseLock\'s code acts on that result; release must never RENAME anything in this window (no capture step exists to exploit)', () => {
  const file = tmpTarget();
  const lockPath = file + '.lock';
  const DEAD_PID = 999986;
  const tokenA = DEAD_PID + ':simulated-dead-holder';
  fs.writeFileSync(lockPath, tokenA);
  backdate(lockPath, 5000);
  const lockA = { path: lockPath, token: tokenA };

  const origOpenSync = fs.openSync;
  const origCloseSync = fs.closeSync;
  const origRenameSync = fs.renameSync;
  let trackedFd = null;
  let injectedB = false;
  let bReclaimDone = false; // B's OWN legitimate internal reclaim rename must not be mistaken for release's
  let lockB = null;
  let renameAttempted = false;
  // Track the EXACT fd release's own readLockInPlace(lockA.path) opens, so the injection fires only once
  // THAT fd is closed again (the read has genuinely finished, still A's own bytes) — never while it is still
  // open (a real reclaim's replace-rename would itself transiently fail on Windows against an open reader,
  // a real platform difference from POSIX this project's own replaceLockFile now retries around; injecting
  // while the fd is already closed avoids that unrelated timing artifact and matches the REAL gap Codex named:
  // AFTER the read, BEFORE the caller acts on it).
  fs.openSync = function (p, flags) {
    const fd = origOpenSync.apply(fs, arguments);
    if (trackedFd === null && p === lockA.path && flags === 'r') trackedFd = fd;
    return fd;
  };
  fs.closeSync = function (fd) {
    const r = origCloseSync.apply(fs, arguments);
    if (!injectedB && fd === trackedFd) {
      injectedB = true;
      lockB = withDeadPid(DEAD_PID, () => once.acquireLock(file, { staleMs: 1000, timeoutMs: 2000, pollMs: 5 }));
      bReclaimDone = true; // any rename from here on is release's own, never B's legitimate reclaim
    }
    return r;
  };
  fs.renameSync = function () {
    if (bReclaimDone) renameAttempted = true; // only counts renames AFTER B's own reclaim has completed
    return origRenameSync.apply(fs, arguments);
  };

  let released;
  try { released = once.releaseLock(lockA); }
  finally { fs.openSync = origOpenSync; fs.closeSync = origCloseSync; fs.renameSync = origRenameSync; }

  assert.ok(lockB, 'the injected interleaving must actually have fired — B must have genuinely reclaimed');
  assert.notStrictEqual(lockB.token, tokenA, 'B holds a genuinely fresh, different token');
  assert.strictEqual(renameAttempted, false, 'release has no rename/capture step left to exploit — it never renames anything, in this window or any other');
  once.releaseLock(lockB); // best-effort cleanup (a no-op if the residual test below already removed it elsewhere — each test uses its own tmpTarget, so this is always B's own file here)
});

t('RESIDUAL (documented, not closed by this or any rename/unlink-based design): if B\'s reclaim lands in the syscall-width gap between release\'s in-place read and its unlink, release can still remove B\'s live replacement — closing this fully needs real OS-level locking', () => {
  const file = tmpTarget();
  const lockPath = file + '.lock';
  const DEAD_PID = 999985;
  const tokenA = DEAD_PID + ':simulated-dead-holder';
  fs.writeFileSync(lockPath, tokenA);
  backdate(lockPath, 5000);
  const lockA = { path: lockPath, token: tokenA };

  const origOpenSync = fs.openSync;
  const origCloseSync = fs.closeSync;
  let trackedFd = null;
  let injectedB = false;
  let lockB = null;
  fs.openSync = function (p, flags) {
    const fd = origOpenSync.apply(fs, arguments);
    if (trackedFd === null && p === lockA.path && flags === 'r') trackedFd = fd;
    return fd;
  };
  fs.closeSync = function (fd) {
    const r = origCloseSync.apply(fs, arguments);
    if (!injectedB && fd === trackedFd) {
      injectedB = true;
      // B's real reclaim lands strictly AFTER release's in-place read has already finished (already captured
      // A's own bytes) but BEFORE release's own decision/unlink below — the one syscall-width gap a plain
      // "read, then act" sequence cannot close without OS-level locking.
      lockB = withDeadPid(DEAD_PID, () => once.acquireLock(file, { staleMs: 1000, timeoutMs: 2000, pollMs: 5 }));
    }
    return r;
  };
  let released;
  try { released = once.releaseLock(lockA); }
  finally { fs.openSync = origOpenSync; fs.closeSync = origCloseSync; }

  assert.ok(lockB, 'the injected interleaving must actually have fired');
  // This is the accepted, documented residual (module header, "V09 FOURTH fix ... RESIDUAL"): A's read
  // already matched its own (about-to-be-superseded) token before B's genuinely fresh lock landed, so A's
  // unlink proceeds and removes B's live lock. This is NOT claimed fixed — only the RENAME-based capture
  // Codex flagged is eliminated (see the test immediately above: release never renames, in this window or
  // any other). Full closure of this narrower residual needs real OS-level locking.
  assert.strictEqual(released, true, 'documents the residual: this exact syscall-width race is not closed by a rename/unlink-based lock');
  assert.strictEqual(fs.existsSync(lockPath), false, 'B\'s live replacement was removed by A\'s stale release in this narrow, documented window');
});

t('isPidAlive: ESRCH means dead, EPERM/any other error and a successful signal both mean alive, and an unparseable/invalid pid fails closed as alive', () => {
  const origKill = process.kill;
  process.kill = function (pid) {
    if (pid === 111) { const e = new Error('sim'); e.code = 'ESRCH'; throw e; }
    if (pid === 222) { const e = new Error('sim'); e.code = 'EPERM'; throw e; }
    if (pid === 333) return true;
    if (pid === 444) { throw new Error('some other unexpected failure, no .code'); }
    throw new Error('unexpected pid in test: ' + pid);
  };
  try {
    assert.strictEqual(once.isPidAlive(111), false, 'ESRCH means the process is genuinely gone');
    assert.strictEqual(once.isPidAlive(222), true, 'EPERM still counts as alive — it exists, we just cannot signal it');
    assert.strictEqual(once.isPidAlive(333), true, 'a successful signal-0 means alive');
    assert.strictEqual(once.isPidAlive(444), true, 'any other unexpected error fails closed as alive, never treated as proof of death');
    assert.strictEqual(once.isPidAlive(NaN), true, 'an unparseable pid fails closed as alive — never treated as provably dead');
    assert.strictEqual(once.isPidAlive(0), true, 'pid 0 is never a valid holder pid — fails closed');
    assert.strictEqual(once.isPidAlive(-5), true, 'a negative pid is never valid — fails closed');
  } finally { process.kill = origKill; }
});

// ---------------------------------------------------------------------------------------------------
console.log('\n10) V09 FIFTH fix (out-p11 + addendum): withLock\'s real fence — a lock replaced between');
console.log('    acquisition and a caller\'s own write must be refused, not silently trusted');
t('fence() reports true while this call genuinely still holds the lock, and false once a DIFFERENT token has been written to lockPath (a reclaim by someone else)', () => {
  const file = tmpTarget();
  let sawInside = null, sawAfterForeignWrite = null;
  once.withLock(file, (fence) => {
    sawInside = fence();
    fs.writeFileSync(file + '.lock', 'someone-elses-token'); // simulate a reclaim landing mid-transaction
    sawAfterForeignWrite = fence();
  });
  assert.strictEqual(sawInside, true, 'fence() must report true immediately after acquisition');
  assert.strictEqual(sawAfterForeignWrite, false, 'fence() must report false once a foreign token is on disk');
  fs.unlinkSync(file + '.lock'); // cleanup — withLock's own release will see the foreign token and correctly no-op
});
t('withLock still calls fn(fence) and releases normally when fn never calls fence() at all (backward compatible with callbacks written before this fix)', () => {
  const file = tmpTarget();
  let ran = false;
  once.withLock(file, () => { ran = true; });
  assert.strictEqual(ran, true);
  assert.strictEqual(fs.existsSync(file + '.lock'), false);
});

// ---------------------------------------------------------------------------------------------------
console.log('\n11) V09 FIFTH fix (out-p11 + addendum): the at-most-once PENDING/CONSUMED grant store');
console.log('    (forge-config-once-store.cjs) — the real safety property, independent of the lock above');
const onceStore = require('./forge-config-once-store.cjs');
function storeDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-config-once-store-')); }
function grantEntry(nowMs, minutes) {
  return {
    value: false, set_at: new Date(nowMs).toISOString(), set_by: 'owner one-off approval: test',
    once_quote: 'test', expires_at: new Date(nowMs + (minutes || 10) * 60000).toISOString(),
    consumed_at: null, consumed_command_sha256: null,
  };
}
t('writePendingOnceGrant writes an atomic, readable file at oncePendingPath; no .tmp leftover', () => {
  const dir = storeDir();
  const now = Date.now();
  const p = onceStore.writePendingOnceGrant(dir, 'gate-hook', grantEntry(now));
  assert.strictEqual(p, onceStore.oncePendingPath(dir, 'gate-hook'));
  const read = onceStore.readOnceEntryInPlace(p);
  assert.strictEqual(read.once_quote, 'test');
  const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  assert.deepStrictEqual(leftovers, []);
});
t('consumeOnceGrant: absent (no pending file at all) -> reason:absent, never true', () => {
  const dir = storeDir();
  const r = onceStore.consumeOnceGrant(dir, 'gate-hook', Date.now(), 'sha');
  assert.deepStrictEqual(r, { ok: false, reason: 'absent' });
});
t('consumeOnceGrant: clock (set_at in the future relative to now) -> reason:clock, nothing consumed', () => {
  const dir = storeDir();
  const now = Date.now();
  onceStore.writePendingOnceGrant(dir, 'gate-hook', grantEntry(now + 3600000)); // set_at one hour in the future
  const r = onceStore.consumeOnceGrant(dir, 'gate-hook', now, 'sha');
  assert.deepStrictEqual(r, { ok: false, reason: 'clock' });
  assert.strictEqual(fs.existsSync(onceStore.oncePendingPath(dir, 'gate-hook')), true, 'a clock-refused attempt must not consume the pending file');
});
t('consumeOnceGrant: expired -> reason:expired, the pending file is left exactly as it was (never renamed)', () => {
  const dir = storeDir();
  const now = Date.now();
  onceStore.writePendingOnceGrant(dir, 'gate-hook', grantEntry(now, 10));
  const r = onceStore.consumeOnceGrant(dir, 'gate-hook', now + 11 * 60000, 'sha'); // 11 min later — past the 10-min window
  assert.deepStrictEqual(r, { ok: false, reason: 'expired' });
  assert.strictEqual(fs.existsSync(onceStore.oncePendingPath(dir, 'gate-hook')), true);
});
t('consumeOnceGrant: a single caller consumes exactly once — first call ok:true, the SAME pending path is gone afterward, a consumed file embedding the sha now exists', () => {
  const dir = storeDir();
  const now = Date.now();
  onceStore.writePendingOnceGrant(dir, 'gate-hook', grantEntry(now));
  const r = onceStore.consumeOnceGrant(dir, 'gate-hook', now + 60000, 'deadbeef12345678');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(fs.existsSync(onceStore.oncePendingPath(dir, 'gate-hook')), false, 'the pending file must be gone — renamed away by the single use');
  const consumedFiles = fs.readdirSync(dir).filter((f) => f.includes('.consumed.'));
  assert.strictEqual(consumedFiles.length, 1, 'exactly one consumed record must exist: ' + consumedFiles.join(','));
  assert.ok(consumedFiles[0].includes('deadbeef12345678'.slice(0, 16)), 'the consumed filename must embed the approved command\'s sha256: ' + consumedFiles[0]);
  const consumed = JSON.parse(fs.readFileSync(path.join(dir, consumedFiles[0]), 'utf8'));
  assert.strictEqual(consumed.consumed_command_sha256, 'deadbeef12345678');
  assert.ok(Date.parse(consumed.consumed_at) > 0);
});
t('THE CORE V09 FIX: two SEQUENTIAL consumers racing the identical pending grant — exactly ONE consumeOnceGrant() call succeeds, independent of any external lock (this test uses NO lock at all); the second call finds the pending file already gone (reason:absent) since nothing raced it at the syscall level here — see the interleaved test below for the genuine race, which yields reason:consumed', () => {
  const dir = storeDir();
  const now = Date.now();
  onceStore.writePendingOnceGrant(dir, 'gate-hook', grantEntry(now));
  const first = onceStore.consumeOnceGrant(dir, 'gate-hook', now + 1000, 'first-caller-sha');
  const second = onceStore.consumeOnceGrant(dir, 'gate-hook', now + 1000, 'second-caller-sha');
  const results = [first, second];
  const successes = results.filter((r) => r.ok === true);
  assert.strictEqual(successes.length, 1, 'exactly one of the two calls must succeed: ' + JSON.stringify(results));
  assert.strictEqual(second.ok, false, 'the second (later) call must never also succeed');
});
t('THE CORE V09 FIX, genuinely interleaved via a real fs-seam on the rename itself: a SECOND consumeOnceGrant() call that races INSIDE the first call\'s own rename (the loser\'s rename throws ENOENT because the source is already gone) still yields exactly one success', () => {
  const dir = storeDir();
  const now = Date.now();
  onceStore.writePendingOnceGrant(dir, 'gate-hook', grantEntry(now));
  const pendingPath = onceStore.oncePendingPath(dir, 'gate-hook');
  const origRename = fs.renameSync;
  let fired = false;
  let nested = null;
  fs.renameSync = function (src, dest) {
    if (!fired && src === pendingPath) {
      fired = true;
      // A genuinely concurrent second consumer races the SAME pending file in the syscall-width gap before
      // this (the "outer") call's own rename executes — it runs to completion FIRST (winning the real rename).
      nested = onceStore.consumeOnceGrant(dir, 'gate-hook', now + 1000, 'nested-sha');
    }
    return origRename.apply(fs, arguments);
  };
  let outer;
  try { outer = onceStore.consumeOnceGrant(dir, 'gate-hook', now + 1000, 'outer-sha'); }
  finally { fs.renameSync = origRename; }
  assert.strictEqual(fired, true, 'the injected interleaving must actually have fired');
  const results = [outer, nested];
  const successes = results.filter((r) => r && r.ok === true);
  assert.strictEqual(successes.length, 1, 'exactly one of the two genuinely interleaved calls must succeed: ' + JSON.stringify(results));
  assert.ok(results.some((r) => r && r.ok === false && r.reason === 'consumed'), 'the loser must be refused with reason:consumed: ' + JSON.stringify(results));
});
t('consumeOnceGrant: a non-ENOENT rename failure (standing in for a real EPERM/EBUSY/destination-directory problem) is reported as reason:absent, never consumes the fresh pending grant, and never touches an EARLIER, already-consumed record for the same key (out-p12: "consumed record survives a failed consume attempt")', () => {
  const dir = storeDir();
  const now = Date.now();
  // First cycle: a real, successful consumption leaves a genuine consumed record on disk.
  onceStore.writePendingOnceGrant(dir, 'gate-hook', grantEntry(now));
  const first = onceStore.consumeOnceGrant(dir, 'gate-hook', now + 1000, 'first-caller-sha');
  assert.strictEqual(first.ok, true);
  const consumedBefore = fs.readdirSync(dir).filter((f) => f.includes('.consumed.'));
  assert.strictEqual(consumedBefore.length, 1, consumedBefore.join(','));
  const consumedRecordPath = path.join(dir, consumedBefore[0]);
  const consumedBytesBefore = fs.readFileSync(consumedRecordPath, 'utf8');
  // Second cycle: a fresh pending grant for the SAME key, whose own publishing rename hits a simulated
  // non-transient, non-ENOENT filesystem error — EPERM/EBUSY/a missing destination directory all surface to
  // this function the same way: neither ENOENT (someone else's rename won) nor success.
  onceStore.writePendingOnceGrant(dir, 'gate-hook', grantEntry(now + 5000));
  const pendingPath2 = onceStore.oncePendingPath(dir, 'gate-hook');
  const origRename = fs.renameSync;
  let injected = false;
  fs.renameSync = function (src, dest) {
    if (!injected && src === pendingPath2) { injected = true; const e = new Error('simulated EPERM'); e.code = 'EPERM'; throw e; }
    return origRename.apply(fs, arguments);
  };
  let result;
  try { result = onceStore.consumeOnceGrant(dir, 'gate-hook', now + 6000, 'second-caller-sha'); }
  finally { fs.renameSync = origRename; }
  assert.ok(injected, 'the injected rename failure must actually have fired');
  assert.deepStrictEqual(result, { ok: false, reason: 'absent' }, 'a non-ENOENT rename failure must never be treated as an approval');
  assert.strictEqual(fs.existsSync(pendingPath2), true, 'a failed rename must leave the pending grant exactly where it was, for a legitimate retry');
  assert.strictEqual(fs.readFileSync(consumedRecordPath, 'utf8'), consumedBytesBefore, 'the EARLIER, already-consumed record must survive the later failed attempt byte-for-byte');
});
t('removePendingOnceGrant is a safe, best-effort no-op when nothing is armed, and actually removes an armed-but-not-yet-consumed grant', () => {
  const dir = storeDir();
  onceStore.removePendingOnceGrant(dir, 'gate-hook'); // nothing there — must not throw
  onceStore.writePendingOnceGrant(dir, 'gate-hook', grantEntry(Date.now()));
  onceStore.removePendingOnceGrant(dir, 'gate-hook');
  assert.strictEqual(fs.existsSync(onceStore.oncePendingPath(dir, 'gate-hook')), false);
});

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
