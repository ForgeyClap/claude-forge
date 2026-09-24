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

/** tryReclaimStaleLock(lockPath, expectedToken, expectedMtimeMs, newToken) -> boolean (true = this call now
 *  holds the lock). Re-verifies, immediately before acting, that the lock at `lockPath` is STILL the exact
 *  stale entry inspected a moment ago (same mtime AND same token) — never reclaims based on a snapshot that
 *  might already be gone or replaced. Writes `newToken` to a private temp path and replaces the lock via
 *  `fs.renameSync` (atomic on every platform Node supports), then reads the result back: if a concurrent
 *  reclaimer's write landed instead, this call correctly reports it does not hold the lock. A failed
 *  write/rename (e.g. injected EACCES/EPERM) returns false — the CALLER is responsible for falling through
 *  to the ordinary bounded backoff, never retrying this function in a tight loop. */
function tryReclaimStaleLock(lockPath, expectedToken, expectedMtimeMs, newToken) {
  let freshSt;
  try { freshSt = fs.statSync(lockPath); } catch { return false; } // gone: someone else already reclaimed/released it
  const freshToken = readLockToken(lockPath);
  if (freshSt.mtimeMs !== expectedMtimeMs || freshToken !== expectedToken) return false; // no longer the SAME stale lock
  const tmp = lockPath + '.reclaim.' + process.pid + '.' + crypto.randomBytes(4).toString('hex');
  try {
    fs.writeFileSync(tmp, newToken);
    fs.renameSync(tmp, lockPath); // atomic replace — a concurrent reclaimer's rename may still win the race
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* best effort — the temp file was never created or is already gone */ }
    return false;
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
      try { fs.writeSync(fd, myToken); } catch { /* best effort — the lock's mere existence is what matters most */ }
      fs.closeSync(fd);
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
    // release ONLY when our token still matches (V15, second recheck) — never unlink "whatever is at this
    // path now"; a lock this holder no longer actually owns is left completely alone.
    try { if (readLockToken(lockPath) === myToken) fs.unlinkSync(lockPath); } catch { /* already gone/replaced */ }
  }
}

module.exports = { withStateLock, DEFAULT_WAIT_MS, DEFAULT_STALE_MS, randomToken, tryReclaimStaleLock, readLockToken };
