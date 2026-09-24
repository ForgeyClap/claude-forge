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
t('a lock that changes in the tiny window between the eligibility check and the rename itself is caught by the post-rename re-verify and restored, never falsely reclaimed', () => {
  const file = tmpTarget();
  const lockPath = file + '.lock';
  const DEAD_PID = 999991;
  const staleToken = DEAD_PID + ':deadfeeddeadfeed';
  fs.writeFileSync(lockPath, staleToken);
  backdate(lockPath, 5000);
  const origRename = fs.renameSync;
  let hijacked = false;
  const freshToken = process.pid + ':freshlivetoken';
  fs.renameSync = function (src, dest) {
    if (!hijacked && src === lockPath) {
      hijacked = true;
      // A genuine concurrent replacement lands in the instant between this call's eligibility check and its
      // rename (V09 out-p10's own residual fs-seam interval).
      fs.writeFileSync(lockPath, freshToken);
    }
    return origRename.apply(fs, arguments);
  };
  let ok;
  try {
    ok = withDeadPid(DEAD_PID, () => once.tryReclaimStaleLock(lockPath, 1000, once.randomToken()));
  } finally {
    fs.renameSync = origRename;
  }
  assert.strictEqual(hijacked, true, 'the injected interleaving must actually have fired');
  assert.strictEqual(ok, false, 'the reclaim must fail — what it actually captured was not what it had just confirmed eligible');
  assert.strictEqual(fs.readFileSync(lockPath, 'utf8'), freshToken, 'the fresh replacement lock must be restored, fully intact');
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

t('V09.3/out-p10: a restoration failure (a third lock already occupies the name) preserves the captured lock on disk instead of discarding it, and the reclaim still fails honestly', () => {
  const file = tmpTarget();
  const lockPath = file + '.lock';
  const DEAD_PID = 999989;
  const staleToken = DEAD_PID + ':live-token-that-will-be-wrongly-captured';
  fs.writeFileSync(lockPath, staleToken);
  backdate(lockPath, 5000);
  const origRename = fs.renameSync;
  const origLinkSync = fs.linkSync;
  // A genuine concurrent replacement lands in the instant between the eligibility check and the rename
  // (same fs-seam technique as the direct unit test above), forcing the post-rename re-verify to detect a
  // mismatch and fall into the restoration branch.
  fs.renameSync = function (src, dest) {
    const r = origRename.apply(fs, arguments);
    if (src === lockPath) fs.writeFileSync(dest, 'a-different-token-than-was-checked');
    return r;
  };
  fs.linkSync = function () {
    const err = new Error('simulated EEXIST — a third lock already occupies this name');
    err.code = 'EEXIST';
    throw err;
  };
  let ok;
  try {
    ok = withDeadPid(DEAD_PID, () => once.tryReclaimStaleLock(lockPath, 1000, once.randomToken()));
  } finally {
    fs.renameSync = origRename;
    fs.linkSync = origLinkSync;
  }
  assert.strictEqual(ok, false, 'a mismatched reclaim whose restoration also fails must still report failure honestly, never success');
  assert.strictEqual(fs.existsSync(lockPath), false, 'lockPath itself was genuinely vacated by the steal, and restoration could not put it back (simulated third lock)');
  const dir = path.dirname(lockPath);
  const preserved = fs.readdirSync(dir).filter((f) => f.includes('.reclaim.'));
  assert.strictEqual(preserved.length, 1, 'the captured (stolen) lock content must be PRESERVED on disk, never discarded, when restoration fails: found ' + preserved.join(','));
  assert.strictEqual(fs.readFileSync(path.join(dir, preserved[0]), 'utf8'), 'a-different-token-than-was-checked', 'the preserved file must still hold the exact captured content, untouched');
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

t('out-p10: fs-seam injection — B\'s real reclaim lands in the syscall-width gap between release\'s own in-place read and its action; release must never RENAME anything in this window (no capture step exists to exploit)', () => {
  const file = tmpTarget();
  const lockPath = file + '.lock';
  const DEAD_PID = 999986;
  const tokenA = DEAD_PID + ':simulated-dead-holder';
  fs.writeFileSync(lockPath, tokenA);
  backdate(lockPath, 5000);
  const lockA = { path: lockPath, token: tokenA };

  const origReadSync = fs.readSync;
  const origRenameSync = fs.renameSync;
  let injectedB = false;
  let bReclaimDone = false; // B's OWN legitimate internal reclaim rename must not be mistaken for release's
  let lockB = null;
  let renameAttempted = false;
  // The instant release's OWN readLockInPlace finishes reading A's bytes (still A's own — B has not acted
  // yet) but BEFORE releaseLock's code gets to look at that result and decide what to do, inject B's REAL,
  // complete reclaim through the real acquireLock() entrypoint — this is the exact "read-to-rename interval"
  // Codex located at forge-config-once.cjs:306 (out-p10). The guard prevents recursing into this same hook
  // from B's own internal reads.
  fs.readSync = function () {
    const r = origReadSync.apply(fs, arguments);
    if (!injectedB) {
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
  finally { fs.readSync = origReadSync; fs.renameSync = origRenameSync; }

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

  const origReadSync = fs.readSync;
  let injectedB = false;
  let lockB = null;
  fs.readSync = function () {
    const r = origReadSync.apply(fs, arguments);
    if (!injectedB) {
      injectedB = true;
      // B's real reclaim lands strictly BETWEEN release's in-place read (already captured A's own bytes,
      // above) and release's own decision/unlink below — the one syscall-width gap a plain "read, then act"
      // sequence cannot close without OS-level locking.
      lockB = withDeadPid(DEAD_PID, () => once.acquireLock(file, { staleMs: 1000, timeoutMs: 2000, pollMs: 5 }));
    }
    return r;
  };
  let released;
  try { released = once.releaseLock(lockA); }
  finally { fs.readSync = origReadSync; }

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

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
