#!/usr/bin/env node
'use strict';
/**
 * usage-guard-state.cjs — the exclusive state-lock primitive split out of usage-guard.cjs (2026-09-24,
 * Codex recheck wp-f4 V15: GUARD-STATE-RACE fail-closed fix; HARDENED across four Codex rechecks). Zero
 * dependency beyond core Node modules; this file never reads or writes the guard's own state/pause/override
 * content — it only ever opens, waits for, and releases a LOCK FILE PATH the caller names.
 *
 * WHY THIS EXISTS: usage-guard.cjs is ~2000+ lines (this project's own file-size guidance names ~500 as the
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
 * concurrency: reclamation was AGE-ONLY (no liveness check), release was UNCONDITIONAL (`unlinkSync`
 * whatever was at the path, even a newer holder's fresh lock), and a failed stale-lock deletion looped
 * tight instead of falling through to the ordinary bounded backoff. The fix introduced an opaque
 * per-HOLDER TOKEN (not an empty marker), a HEARTBEAT that refreshes mtime while `fn()` is genuinely in
 * flight (so a legitimately long-running transaction is never mistaken for abandoned), and FENCING —
 * `fn` is called as `fn(fence)`, and a caller whose transaction includes a write MUST call `fence()`
 * immediately before that write and skip it on `false`.
 *
 * CAPTURE-BASED RECLAIM/RELEASE, LATER REMOVED (V15, THIRD Codex recheck, 2026-09-24 — SUPERSEDED, see the
 * FOURTH recheck below): the second recheck's reclaim still did a separate "verify, then act on what you
 * verified" pair — a stat+read, then two LATER syscalls (write a temp file, rename it over the lock). The
 * third recheck's fix made the ONE mutation that decides ownership `fs.renameSync(lockPath, <private
 * capture path>)` — capture FIRST, compare the captured content against what was expected, restore via
 * `fs.linkSync` on a mismatch. This closed the specific schedule Codex had proven at the time, but a
 * FOURTH recheck (below) proved the capture step itself was the remaining exploit surface: capturing
 * ALWAYS vacates `lockPath` for a brief window, regardless of whether the content turns out to have been
 * live or stale — and a delayed reclaimer's capture could win that vacancy against a lock that had, in the
 * meantime, become live again (a legitimate holder reclaimed it since the delayed reclaimer's own earlier
 * belief was formed), briefly leaving `lockPath` absent for a fresh `wx`-create to slip into. This whole
 * capture-then-compare design (`captureLock`/`restoreCapturedLock`) is REMOVED entirely below.
 *
 * NEVER VACATE A LIVE LOCK, NOT EVEN FOR AN INSTANT (V15, FOURTH Codex recheck, 2026-09-24). Two changes:
 *
 *   1. RECLAIM is now verify-IN-PLACE, then REPLACE-WITHOUT-EVER-VACATING:
 *      `verifyLockStaleInPlace()` does ONE open+fstat+read (never a caller-supplied snapshot from an
 *      earlier, separate stat()/readFileSync() pair — that separation was itself part of the exploit
 *      surface, since real wall-clock time can pass between two independent syscalls even with no `await`
 *      in the caller's own source: a genuinely separate OS process's actions land in the KERNEL-level gap
 *      between any two syscalls, not just at explicit JS suspension points) and judges staleness from BOTH
 *      the mtime age AND — when the token names a pid (`pid:hex`, this file's own token shape) — whether
 *      that pid is still alive (`process.kill(pid, 0)`; an EPERM means the process EXISTS under a
 *      different owner and is treated as ALIVE, never as gone — works on Windows for existence checks
 *      too). If a caller reclaims, `tryReclaimStaleLock()` writes the new token to a PRIVATE temp file
 *      first, then `fs.renameSync(tmp, lockPath)` — a rename ONTO an EXISTING destination, which both
 *      POSIX `rename(2)` and Windows (via libuv's `MoveFileExW` + `MOVEFILE_REPLACE_EXISTING`) perform as
 *      ONE atomic directory-entry replace. `lockPath` is NEVER, even momentarily, absent from the
 *      directory during a reclaim — there is no window left for a concurrent `openSync(lockPath, 'wx')`
 *      to exploit, because the path is occupied throughout. A plain replace-rename carries no EEXIST-style
 *      "did I actually win" signal (unlike an exclusive create), so a mandatory READBACK immediately
 *      afterward is what decides the real outcome: if a second, concurrent reclaimer's own replace landed
 *      after this one, the readback shows THEIR token, and this call honestly reports it did not win —
 *      never assumes success from a rename call that merely did not throw.
 *   2. RELEASE no longer captures anything either: `releaseLockIfOwned()` reads the CURRENT content in
 *      place and unlinks ONLY when it still matches exactly what this holder wrote at acquisition time. A
 *      lock already reclaimed by someone else (this holder went stale for a moment — a GC pause, a slow
 *      synchronous transform) is left completely untouched; there is nothing to restore, because nothing
 *      was ever taken from it in the first place.
 *
 *   HONEST RESIDUAL (named, not silently claimed away): `verifyLockStaleInPlace()` and the subsequent
 *   `renameSync` are still two separate syscalls, and `releaseLockIfOwned()`'s own read-then-unlink is
 *   likewise two separate syscalls — a real OS can, in principle, still schedule another process's action
 *   in the gap between them. What is now STRUCTURALLY IMPOSSIBLE is the specific vacancy Codex's third
 *   schedule exploited (a capture step that unconditionally removes `lockPath`, live or not, and leaves it
 *   absent while it inspects what it grabbed) — usage-guard.cjs's own V15 FOURTH-recheck fix adds a SEPARATE
 *   defense-in-depth layer (deriving `ownerOverride` from an independent, single-writer, expiry-aware grant
 *   record rather than trusting this file's own state cache) specifically because an event-loop heartbeat
 *   can never PROVE a suspended process is truly gone, and exclusion alone was never going to be a complete
 *   answer to that. See usage-guard-override.cjs's own header for that layer.
 *
 * N07 (Codex recheck out-p10, 2026-09-24): a THROWN or SILENTLY-WRONG token write, in BOTH the acquisition
 * and the reclaim path, must fail the whole operation — never invoke a caller's transaction with a
 * `fence()` that can only ever report `false`, and never leave a broken lock behind for the next waiter to
 * trip over.
 *   - ACQUISITION: `fs.writeFileSync(lockPath, myToken, { flag: 'wx' })` — the atomic create-if-absent and
 *     the token write are now ONE call (Node's own `writeFileSync` loops until the buffer is fully written
 *     or throws, closing the exploitable "wrote fewer bytes than expected without throwing" gap the old
 *     manual open/write/close split allowed). An independent READBACK after a successful call is a second,
 *     cheap safety net against silent corruption. On ANY failure here — thrown, or a readback mismatch —
 *     this caller's own just-created file (nothing else could exist there: `wx` guarantees exclusivity, so
 *     a non-EEXIST failure can only ever follow OUR OWN create) is removed before refusing, so the very
 *     next attempt sees a clean, absent path rather than a broken, ownerless lock.
 *   - RECLAIM: the temp-file write happens BEFORE the atomic replace — if it throws, `lockPath` was NEVER
 *     touched (still shows whatever it showed before this attempt, unchanged), so a failed reclaim leaves
 *     the SAME genuinely-stale lock in place for an immediate retry, never a fresh-looking zero-byte
 *     orphan that would otherwise fool the next waiter's own staleness check into waiting out the full
 *     interval.
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

/** isPidAlive(pid) -> boolean. A DIFFERENT, deliberately more conservative direction from
 *  usage-guard.cjs's own `pidAlive()` (which treats ANY probe failure, including EPERM, as "not alive" —
 *  correct for THAT file's "never kill a process I can't prove is mine" safety rule). Here the conservative
 *  direction is the OPPOSITE: when uncertain, assume ALIVE, so a lock is never reclaimed out from under a
 *  holder we merely failed to positively confirm is gone. `process.kill(pid, 0)` throws ESRCH when the pid
 *  genuinely does not exist (-> false) and EPERM when it exists but under a different owner (-> true, still
 *  alive) — this works for existence checks on Windows too. Never throws. */
function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return !!(e && e.code === 'EPERM'); }
}
// L4 (Security Boss addendum, 2026-09-24 — documented, not fixed by this or any bare-pid liveness check,
// mirrors forge-config-once.cjs's own identical residual for its analogous lock): PID REUSE remains a real
// limitation. If a holder's process exits and the OS hands that EXACT pid number to a brand-new, unrelated
// process before this lock goes stale, `isPidAlive` cannot tell the new process apart from the original
// holder — the lock reads as "still live" and can never be reclaimed until that unrelated process ALSO
// exits (or the token's own pid, coincidentally, becomes unreachable another way). This is a LIVENESS
// (availability) limitation, not an EXCLUSION (safety) one: the worst outcome is an un-reclaimable lock that
// requires manual intervention (delete the lock file), never two holders running the callback at once.
// Closing it fully needs real OS-level process-handle tracking (e.g. a kernel-revoked advisory lock), which
// this cross-platform, dependency-free, token-file design intentionally does not depend on.

/** verifyLockStaleInPlace(lockPath, staleMs) -> { stale, mtimeMs, content } | null. THE fresh, in-place
 *  check (V15, FOURTH Codex recheck, 2026-09-24) — ONE open+fstat+read, never a value a caller assembled
 *  from separate, earlier syscalls (that separation was itself part of the third recheck's exploit
 *  surface). `null` means the lock is already gone (nothing to reclaim, e.g. it was released or reclaimed
 *  by someone else a moment ago). Stale requires BOTH the mtime age exceeding `staleMs` AND — only when the
 *  token names a pid (this file's own `pid:hex` shape) — that pid no longer being alive (see isPidAlive
 *  above); a token in an unrecognised shape falls back to age-only, matching this file's pre-liveness-aware
 *  history for that edge case. Never throws. */
function verifyLockStaleInPlace(lockPath, staleMs) {
  let fd;
  try { fd = fs.openSync(lockPath, 'r'); } catch { return null; }
  try {
    const st = fs.fstatSync(fd);
    const buf = Buffer.alloc(st.size);
    if (st.size > 0) fs.readSync(fd, buf, 0, st.size, 0);
    const content = buf.toString('utf8');
    const age = Date.now() - st.mtimeMs;
    if (age <= staleMs) return { stale: false, mtimeMs: st.mtimeMs, content };
    const m = /^(\d+):/.exec(content);
    if (m) {
      const holderPid = Number(m[1]);
      if (holderPid > 0 && isPidAlive(holderPid)) return { stale: false, mtimeMs: st.mtimeMs, content };
    }
    return { stale: true, mtimeMs: st.mtimeMs, content };
  } catch { return null; }
  finally { try { fs.closeSync(fd); } catch { /* best effort */ } }
}

/** tryReclaimStaleLock(lockPath, newToken, staleMs) -> boolean (true = this call now holds the lock).
 *  V15 (FOURTH Codex recheck, 2026-09-24): staleness is verified IN PLACE, immediately before acting (see
 *  verifyLockStaleInPlace above) — THE CAPTURE-THEN-VERIFY PATH IS REMOVED ENTIRELY. This never renames the
 *  lock file AWAY to inspect it (the third recheck's exact exploit surface): a brand-new token is written
 *  to a PRIVATE temp path first, then `fs.renameSync(tmp, lockPath)` — a rename ONTO an EXISTING
 *  destination, atomic on both POSIX and Windows, so `lockPath` is NEVER absent from the directory, not
 *  even for an instant. A mandatory READBACK afterward is the only real "did I win" signal (a plain
 *  replace-rename has no EEXIST-style success/failure split the way an exclusive create does): if a
 *  concurrent reclaimer's own replace landed after this one, the readback shows THEIR token, and this call
 *  honestly reports it did not win. N07: a thrown (or otherwise failed) temp-file write NEVER touches
 *  `lockPath` at all — a failed reclaim leaves the original, still-genuinely-stale lock completely intact
 *  for an immediate retry, never a fresh-looking orphan. */
function tryReclaimStaleLock(lockPath, newToken, staleMs) {
  const check = verifyLockStaleInPlace(lockPath, staleMs);
  if (!check || !check.stale) return false; // gone, or not actually stale (fresh mtime, or a still-live holder pid)
  const tmp = lockPath + '.reclaim.' + process.pid + '.' + crypto.randomBytes(4).toString('hex');
  try {
    fs.writeFileSync(tmp, newToken);
    fs.renameSync(tmp, lockPath); // atomic replace — lockPath is never absent, not even for an instant
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    return false; // lockPath itself was never touched by a failed attempt — nothing to clean up there
  }
  return readLockToken(lockPath) === newToken; // the only real "did I win" signal for a replace-rename
}

/** releaseLockIfOwned(lockPath, myToken) -> void. THE release primitive (V15, FOURTH Codex recheck,
 *  2026-09-24) — no capture step (removed entirely, see the file header): reads the CURRENT content in
 *  place and unlinks ONLY when it still matches exactly what this caller wrote at acquisition. A lock
 *  already reclaimed by someone else (this holder went stale for a moment) is left completely untouched —
 *  there is nothing to restore, because nothing was ever taken from it in the first place. Never throws. */
function releaseLockIfOwned(lockPath, myToken) {
  if (readLockToken(lockPath) !== myToken) return; // not ours to touch (already reclaimed, or already gone)
  try { fs.unlinkSync(lockPath); } catch { /* best effort */ }
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
    // L2 (Security Boss addendum, 2026-09-24 — CORRECTS N07's own "wx guarantees exclusivity, so whatever
    // is now at lockPath can only be our own incomplete write" claim, which is FALSE on Windows): the
    // create and the token write are done as two EXPLICIT steps (open, then write+close) rather than one
    // `fs.writeFileSync(..., {flag:'wx'})` call, specifically so a failure can be attributed correctly:
    //   - the OPEN itself failing (anything other than EEXIST, e.g. Windows EPERM/EBUSY while a file is
    //     mid-delete by another process) means we never got a handle — we cannot prove the content sitting
    //     at lockPath is ours, so it is NEVER deleted here (only a later, liveness-checked reclaim may touch
    //     it). This is the exact hazard Security Boss's L2 finding named: an unconditional unlink in this
    //     branch could delete a DIFFERENT, genuinely live holder's real lock.
    //   - the OPEN succeeding (a fresh `wx` create genuinely happened — no other process could have created
    //     this exact path in between, by definition of an exclusive create) means whatever is at lockPath
    //     afterward — even wrong bytes from a failed write, or a readback mismatch — is UNAMBIGUOUSLY ours to
    //     clean up, preserving N07's original guarantee (no ownerless orphan left behind) exactly for the
    //     case it actually applies to.
    let fd = null;
    try {
      fd = fs.openSync(lockPath, 'wx');
    } catch (e) {
      if (e.code !== 'EEXIST') return { ok: false, reason: 'lock-write-failed' }; // open failed — not ours, never delete
      // EEXIST: genuine contention. Reclaim now verifies staleness freshly, IN PLACE, immediately before
      // acting — never against a value read via separate, earlier syscalls (V15, fourth recheck).
      if (tryReclaimStaleLock(lockPath, myToken, staleMs)) break;
      // A FAILED reclaim attempt (lost the race, not actually stale, or an EACCES/EPERM on the write)
      // falls straight through to the SAME bounded deadline+backoff below — never an immediate tight
      // retry loop.
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
      continue; // back to the top — retry the exclusive open
    }
    // our OWN exclusive create just succeeded (no other process could have created this exact path in
    // between) — whatever ends up at lockPath from here is UNAMBIGUOUSLY ours to write to and, on failure,
    // to clean up (N07's original guarantee, preserved exactly for the case it actually proves).
    let wroteOk = false;
    try { fs.writeSync(fd, myToken); wroteOk = true; } catch { /* wroteOk stays false */ }
    try { fs.closeSync(fd); } catch { /* best effort */ }
    if (wroteOk && readLockToken(lockPath) === myToken) break; // acquired, and independently confirmed (N07)
    // N07 (2026-09-24): a write that threw, or that neither threw nor produced the expected content on
    // readback — this must REFUSE outright rather than proceed into fn() with a fence() that can only ever
    // report false. Safe to remove unconditionally: we created this file moments ago via our own exclusive
    // open, so it cannot belong to anyone else.
    try { fs.unlinkSync(lockPath); } catch { /* best effort */ }
    return { ok: false, reason: 'lock-write-failed' };
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
    releaseLockIfOwned(lockPath, myToken);
  }
}

module.exports = {
  withStateLock, DEFAULT_WAIT_MS, DEFAULT_STALE_MS, randomToken, tryReclaimStaleLock, readLockToken,
  releaseLockIfOwned, verifyLockStaleInPlace, isPidAlive,
};
