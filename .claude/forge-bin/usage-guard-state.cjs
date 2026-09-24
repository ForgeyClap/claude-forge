#!/usr/bin/env node
'use strict';
/**
 * usage-guard-state.cjs — the exclusive state-lock primitive split out of usage-guard.cjs (2026-09-24,
 * Codex recheck wp-f4 V15: GUARD-STATE-RACE fail-closed fix; HARDENED on the second Codex recheck 2026-09-24
 * V15: ownership-safe reclamation with liveness + fencing). Zero dependency beyond core Node modules; this
 * file never reads or writes the guard's own state/pause/override content — it only ever opens, waits for,
 * and releases a LOCK FILE PATH the caller names.
 *
 * WHY THIS EXISTS: usage-guard.cjs is ~1900 lines (this project's own file-size guidance names ~500 as the
 * per-file target). The exclusive-open/retry/stale-reclaim shape here is fully generic.
 *
 * withStateLock(lockPath, fn, opts) -> Promise<{ ok: true, value } | { ok: false, reason }>.
 * `fn` is now called as `fn(fence)` — see FENCING below.
 *
 * FAIL-CLOSED (V15, first fix 2026-09-24): a lock that cannot be acquired within `opts.timeoutMs` (default
 * 2000ms, or FORGE_USAGE_GUARD_STATE_LOCK_WAIT_MS) never invokes `fn()` at all and returns
 * `{ok:false, reason:'lock-timeout'}` — never runs the transaction unlocked.
 *
 * OWNERSHIP, LIVENESS AND FENCING (V15, SECOND Codex recheck, 2026-09-24): the first fix closed "runs
 * unlocked after a timeout" but Codex proved the reclaim/release pair was still unsafe under real
 * concurrency:
 *   1. RECLAMATION WAS AGE-ONLY: a lock older than `opts.staleMs` was reclaimed by blindly `unlinkSync`-ing
 *      it and looping back to `openSync(lockPath, 'wx')` — with NO check that the holder was still alive.
 *      This project's `override-on` genuinely holds this lock across sequential network round trips (a
 *      resume-all-agents loop), so a minute-long HELD-AND-ACTIVE transaction is plausible, not a crash.
 *      Reclaiming it out from under a live holder let two transactions run "concurrently" (B starts while A
 *      is still mid-flight) and let A's later, stale write silently RESTORE a value B had already cleared
 *      (Codex's exact reproduction: an override B cleared came back the moment A's slow transaction finally
 *      wrote its pre-clear snapshot).
 *   2. RELEASE WAS UNCONDITIONAL: `finally { unlinkSync(lockPath) }` deleted "whatever is at that path now"
 *      — if A had ALREADY been reclaimed by B (a crash-recovery case, or the liveness gap above), A's own
 *      release then deleted B's brand-new lock, and a THIRD writer C could then acquire concurrently with B.
 *   3. FAILED STALE-LOCK DELETION LOOPED TIGHT: the old code's catch-and-continue after a failed
 *      unlinkSync (silently swallowing the error as "another waiter already reclaimed it") skipped straight
 *      back to the top of the loop — an injected EACCES on the delete (a lock file the OS genuinely won't let this process remove)
 *      caused REPEATED IMMEDIATE reclamation attempts that never even reached the `deadline` check below,
 *      an unbounded busy-loop rather than the same bounded backoff every OTHER contention path gets.
 *
 *   THE FIX (mirrors this project's own forge-config-once.cjs V09 lock — same shape, a different physical
 *   file): every lock file's content is now an opaque per-HOLDER TOKEN, not an empty marker.
 *     - ACQUIRE: `openSync(lockPath, 'wx')` (atomic create-if-absent) then write this holder's token.
 *     - LIVENESS: while `fn()` is in flight, a heartbeat re-touches the lock file's mtime (ONLY while our
 *       token is still the one on disk) at an interval well under `staleMs`, so a genuinely live holder's
 *       lock never crosses the stale threshold no matter how long its transaction legitimately runs.
 *     - RECLAIM: a waiter that finds the lock older than `staleMs` re-verifies, immediately before acting,
 *       that the EXACT stale entry it inspected (same mtime AND same token) is still there, then atomically
 *       replaces it via a rename-from-a-private-temp-file and reads the result back to confirm ITS OWN
 *       token actually won — never assumes ownership it cannot prove. A FAILED reclaim attempt (lost the
 *       race, or an EACCES/EPERM on the write/rename) falls through to the SAME bounded deadline+backoff
 *       every other contention path uses — never a tight retry loop (closes gap 3 above).
 *     - FENCING: `fn` is called as `fn(fence)`, where `fence()` synchronously reports whether THIS holder's
 *       token is still the one on disk RIGHT NOW. A caller whose transaction includes a write MUST call
 *       `fence()` immediately before that write and skip it on `false` — a reclaimed holder's late write is
 *       then rejected by the caller itself rather than silently landing after a new holder has already
 *       started its own transaction (usage-guard.cjs's `withLockedState` and every direct `withStateLock`
 *       caller now do exactly this).
 *     - RELEASE: unlinks the lock file ONLY when its current content still matches the exact token this
 *       holder wrote when it acquired (closes gap 2 above) — a lock this holder no longer actually owns is
 *       left completely alone, so the new holder's lock survives untouched.
 *
 * OWNERSHIP TRANSFER IS NOW ONE ATOMIC MUTATION, NOT VERIFY-THEN-ACT (V15, THIRD Codex recheck, 2026-09-24):
 * the second recheck's fix above still had a verify-then-write gap in `tryReclaimStaleLock` — it re-checked
 * the stale entry's token/mtime, then performed TWO SEPARATE later syscalls (write a temp file, rename it
 * over the lock) to actually claim it. Codex proved this remains exploitable: a reclaimer that "passes its
 * stale check and pauses" (a real OS scheduling gap, or a slow synchronous transform) can still complete its
 * write-then-rename AFTER a second, legitimate holder has already taken over and published a real state
 * change — silently resurrecting whatever that legitimate holder had just cleared (Codex's exact
 * reproduction: an owner-cleared override came back the moment the stale holder's delayed write finally
 * landed). The fix (mirrors this project's own forge-config-once.cjs V09 lock's proven "capture, then act on
 * what you actually captured" shape — see `captureLock`/`restoreCapturedLock` below): the ONE mutation that
 * decides who owns the lock is now `fs.renameSync(lockPath, <private capture path>)` — an atomic OS-level
 * rename that only ONE caller can ever win for the same source path at the same instant. Everything after
 * that (comparing the captured content to what was expected, claiming the now-vacant slot with an exclusive
 * `wx` create, or giving mismatched content back via `fs.linkSync`) operates on content this caller has
 * SOLE, already-confirmed possession of — there is no longer a window between "verify" and "act" for another
 * caller to exploit, because the verify step no longer exists as a separate operation from the claim.
 * RELEASE uses the exact same capture primitive (never a bare "read-then-unlink", which has an identical
 * verify-then-act gap): a lock captured with THIS holder's own token is left vacant (the intended outcome of
 * a release); a lock captured with anyone else's content is restored via `fs.linkSync`, never silently
 * dropped, and never put back with a plain `renameSync` (which could clobber a third lock that appeared at
 * the path in the meantime).
 *
 * A FAILED token write during ACQUISITION (the temp-free `fs.writeSync(fd, myToken)` right after `openSync`)
 * now REFUSES the whole acquisition outright (`{ok:false, reason:'lock-write-failed'}`) instead of silently
 * proceeding into `fn()` with a fence that can only ever report `false` and leaving an empty, ownerless lock
 * file behind for the next waiter to trip over.
 */
const fs = require('fs');
const crypto = require('crypto');

const DEFAULT_WAIT_MS = Number(process.env.FORGE_USAGE_GUARD_STATE_LOCK_WAIT_MS) > 0
  ? Number(process.env.FORGE_USAGE_GUARD_STATE_LOCK_WAIT_MS) : 2000;
const DEFAULT_STALE_MS = 60 * 1000;
const DEFAULT_POLL_MS = 25;
const HEARTBEAT_MIN_MS = 25;
const HEARTBEAT_MAX_MS = 5000;

function randomToken() { return process.pid + ':' + crypto.randomBytes(8).toString('hex'); }

/** readLockToken(lockPath) -> the lock file's current content, or null if unreadable/absent. Never throws. */
function readLockToken(lockPath) {
  try { return fs.readFileSync(lockPath, 'utf8'); } catch { return null; }
}

/** captureLock(lockPath) -> { captured:true, content, mtimeMs, capturePath } | { captured:false }.
 *  THE single atomic ownership-transfer primitive (V15, third Codex recheck, 2026-09-24), shared by both
 *  `tryReclaimStaleLock` and `withStateLock`'s own release step below. An `fs.renameSync` of the lock's OWN
 *  CURRENT name to a private per-caller path is the ONE mutation — the OS guarantees exactly one caller's
 *  rename can ever succeed against the same source path at the same instant, so whatever content this call
 *  reads back afterward is provably content NOBODY ELSE captured too. A caller that decides it was not
 *  entitled to touch that content can always give it back via `restoreCapturedLock`. Never throws. */
function captureLock(lockPath) {
  const capturePath = lockPath + '.capture.' + process.pid + '.' + crypto.randomBytes(4).toString('hex');
  try { fs.renameSync(lockPath, capturePath); }
  catch { return { captured: false }; } // gone, or another caller's rename already won the source path
  let content = null, mtimeMs = null;
  try { content = fs.readFileSync(capturePath, 'utf8'); } catch { /* unreadable — treated as a mismatch below */ }
  try { mtimeMs = fs.statSync(capturePath).mtimeMs; } catch { /* leave null — also treated as a mismatch */ }
  return { captured: true, content, mtimeMs, capturePath };
}
/** restoreCapturedLock(capturePath, lockPath) -> best-effort put-back for content a caller captured but
 *  turned out not to be entitled to touch (it was not the exact stale entry expected, or it belonged to a
 *  holder other than the one releasing). Uses `fs.linkSync` — NEVER `fs.renameSync` — so a third lock that
 *  appeared at `lockPath` in the meantime (a genuinely fresh acquirer's own exclusive create) is never
 *  clobbered; on EEXIST the captured content is simply discarded, since whatever is at `lockPath` now is the
 *  legitimate current holder. Always cleans up the private capture file. Never throws. */
function restoreCapturedLock(capturePath, lockPath) {
  try { fs.linkSync(capturePath, lockPath); } catch { /* something newer already lives at lockPath — leave it */ }
  try { fs.unlinkSync(capturePath); } catch { /* best effort */ }
}
/** tryReclaimStaleLock(lockPath, expectedToken, expectedMtimeMs, newToken) -> boolean (true = this call now
 *  holds the lock). V15 (third Codex recheck, 2026-09-24): reclamation is now CAPTURE-FIRST, never
 *  verify-then-write — `captureLock` performs the ONE mutation before anything is inspected, so there is no
 *  window between "confirm this is still the stale entry" and "claim it" for a concurrent writer to exploit.
 *  If the captured content does not EXACTLY match the stale entry this caller inspected a moment ago (a live
 *  holder's heartbeat ticked, or a different reclaimer already won it), the content is restored untouched
 *  and this call reports it does not hold the lock — it never assumes ownership it cannot prove. Only once
 *  the captured content is confirmed to be the precise stale entry does this call claim the now-vacant slot
 *  with an EXCLUSIVE `wx` create (never a blind overwrite), so a genuinely fresh acquirer that slips into the
 *  vacancy first is detected as a lost race, not silently clobbered. A failed capture/claim (e.g. injected
 *  EACCES/EPERM) returns false — the CALLER is responsible for falling through to the ordinary bounded
 *  backoff, never retrying this function in a tight loop. */
function tryReclaimStaleLock(lockPath, expectedToken, expectedMtimeMs, newToken) {
  const cap = captureLock(lockPath);
  if (!cap.captured) return false; // someone else's capture (reclaim or release) already won the source path
  const stillTheExactStaleEntry = cap.content === expectedToken && cap.mtimeMs === expectedMtimeMs;
  if (!stillTheExactStaleEntry) {
    // not the entry we verified a moment ago — give it back rather than deciding based on stale information.
    restoreCapturedLock(cap.capturePath, lockPath);
    return false;
  }
  // it really was the stale entry, and it is now off the shared path where nobody else could have captured
  // the same content too — discard our private copy and claim the now-vacant slot exclusively.
  try { fs.unlinkSync(cap.capturePath); } catch { /* best effort */ }
  try {
    const fd = fs.openSync(lockPath, 'wx');
    try { fs.writeSync(fd, newToken); } finally { fs.closeSync(fd); }
  } catch {
    return false; // a fresh acquirer's own exclusive create won the now-vacant slot first — not an error
  }
  return readLockToken(lockPath) === newToken;
}

/** withStateLock(lockPath, fn, opts) — opts.timeoutMs, opts.staleMs, opts.log(msg) are all optional.
 *  `fn` is invoked as `fn(fence)` — see the FENCING section in the file header. */
async function withStateLock(lockPath, fn, opts) {
  const o = opts || {};
  const waitMs = Number.isFinite(o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : DEFAULT_WAIT_MS;
  const staleMs = Number.isFinite(o.staleMs) && o.staleMs > 0 ? o.staleMs : DEFAULT_STALE_MS;
  const log = typeof o.log === 'function' ? o.log : () => {};
  const deadline = Date.now() + waitMs;
  const myToken = randomToken();
  let loggedWaiting = false;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      let tokenWritten = true;
      try { fs.writeSync(fd, myToken); } catch { tokenWritten = false; }
      fs.closeSync(fd);
      if (!tokenWritten) {
        // V15 (third Codex recheck, 2026-09-24): a failed token write must REFUSE this acquisition outright
        // — never invoke fn() with a fence() that can only ever report false, and never leave a broken,
        // ownerless empty lock file behind for the next waiter to trip over (previously: swallowed, then
        // proceeded to hold what looked like a lock nobody could ever prove they own).
        try { fs.unlinkSync(lockPath); } catch { /* best effort */ }
        return { ok: false, reason: 'lock-write-failed' };
      }
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') return { ok: false, reason: 'lock-error: ' + e.message };
      let st = null, curToken = null;
      try { st = fs.statSync(lockPath); curToken = readLockToken(lockPath); }
      catch { /* vanished under us mid-check — retry below */ }
      if (st && (Date.now() - st.mtimeMs) > staleMs) {
        if (tryReclaimStaleLock(lockPath, curToken, st.mtimeMs, myToken)) break;
        // V15 (second recheck): a FAILED reclaim attempt (lost the race, or an EACCES/EPERM on the
        // write/rename) falls straight through to the SAME bounded deadline+backoff below — never an
        // immediate tight retry loop.
      }
      if (Date.now() >= deadline) {
        log('state-lock: kon de lock niet claimen binnen ' + waitMs + 'ms (een andere schrijver houdt hem vast) — '
          + 'deze transactie wordt GEWEIGERD, niet zonder lock uitgevoerd / could not claim the state lock within '
          + waitMs + 'ms (another writer is holding it) — REFUSING this transaction rather than proceeding unlocked');
        return { ok: false, reason: 'lock-timeout' };
      }
      if (!loggedWaiting) {
        log('state-lock: wachten op een andere schrijver (max ' + waitMs + 'ms) / waiting for another writer (max ' + waitMs + 'ms)');
        loggedWaiting = true;
      }
      await new Promise((res) => setTimeout(res, DEFAULT_POLL_MS));
    }
  }
  // LIVENESS (V15, second recheck): refresh this lock's mtime while `fn()` runs, so a genuinely live
  // holder — whose transaction may span a real network round trip well past `staleMs` — is never mistaken
  // for an abandoned one. Stops refreshing the instant our own token is no longer the one on disk (already
  // reclaimed) rather than fighting to reclaim it back; `unref()` so this timer never keeps a process alive.
  const heartbeatMs = Math.max(HEARTBEAT_MIN_MS, Math.min(Math.floor(staleMs / 3), HEARTBEAT_MAX_MS));
  const heartbeat = setInterval(() => {
    try {
      if (readLockToken(lockPath) === myToken) { const now = new Date(); fs.utimesSync(lockPath, now, now); }
    } catch { /* best effort — a failed heartbeat just means the next waiter's stale-check may fire sooner */ }
  }, heartbeatMs);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();
  // FENCING (V15, second recheck): true iff our token is STILL the one on disk right now. The caller MUST
  // call this immediately before its own write and skip the write on false.
  const fence = () => readLockToken(lockPath) === myToken;
  try {
    const value = await fn(fence);
    return { ok: true, value };
  } finally {
    clearInterval(heartbeat);
    // RELEASE (V15, THIRD Codex recheck, 2026-09-24): capture-based, matching tryReclaimStaleLock's own
    // atomicity — never a bare "read token, then unlink" (those are two separate syscalls; a reclaim could
    // land in the gap between them, and an unconditional unlink would then delete the NEW holder's fresh
    // lock instead of "whatever we no longer own"). `captureLock` is the one mutation; what happens next
    // depends only on content this call has sole, already-confirmed possession of.
    const cap = captureLock(lockPath);
    if (cap.captured) {
      if (cap.content === myToken) {
        // genuinely ours — releasing is SUPPOSED to leave this vacant; nothing further to do.
        try { fs.unlinkSync(cap.capturePath); } catch { /* best effort */ }
      } else {
        // already reclaimed by someone else before we got here (e.g. this holder was itself stale for a
        // moment) — give their lock back untouched rather than silently discarding it.
        restoreCapturedLock(cap.capturePath, lockPath);
      }
    }
    // cap.captured === false: already gone/released by someone else — nothing left for us to release.
  }
}

module.exports = {
  withStateLock, DEFAULT_WAIT_MS, DEFAULT_STALE_MS, randomToken, tryReclaimStaleLock, readLockToken,
  captureLock, restoreCapturedLock,
};
