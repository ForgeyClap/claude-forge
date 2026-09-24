#!/usr/bin/env node
'use strict';
/**
 * forge-config-once.cjs — the one-off (`--once`) approval state machine and the cross-process file lock,
 * split out of forge-config.cjs (Codex recheck 2026-09-24, CFG-07/S06/CFG-09/CFG-10) so that file stays a
 * readable size. WHY together: both pieces exist for the SAME reason — forge-config.cjs's writes must be
 * safe under concurrency and its one-off exception must be a real single-use approval, not an extensible
 * window. Zero-dependency (fs/path/crypto only, all Node built-ins). Not a CLI — required only by
 * forge-config.cjs.
 *
 * ONE-OFF STATE MACHINE (CFG-07/S06):
 *   A ONCE_KEYS entry on disk looks like:
 *     { value:false, set_at, set_by, once_quote, expires_at, consumed_at:null, consumed_command_sha256:null }
 *   onceState(ent, nowMs) -> null (not once-shaped) | {expired:true} | {expired:false, expires_at, minutesLeft}.
 *   Fails CLOSED (expired) on every one of: a consumed entry (consumed_at set — CFG-07: the effective value
 *   is back to normal THE INSTANT it is consumed, not after the timer), an unparseable set_at/expires_at, a
 *   stored expires_at LATER than set_at + ONCE_MS (a hand-edited file can never extend the 10-minute window
 *   beyond what setOnce() itself would ever write), nowMs before set_at (a clock rollback or a bogus future
 *   set_at is never trusted), or expires_at at/before nowMs. KNOWN RESIDUAL GAP (documented, not silently
 *   claimed fixed): a clock rolled BACKWARD to a moment still inside the original [set_at, expires_at]
 *   window after real time already passed expires_at can still read as "not expired" — closing that fully
 *   needs a persisted monotonic high-water mark, which this stateless, read-only function does not keep.
 *   forge-config.cjs's consumeOnce() is the real defense in that window: it is a single atomic use, so an
 *   already-consumed entry stays refused regardless of what the wall clock says.
 *
 * FILE LOCK (CFG-09/CFG-10, ownership hardened for V09 — Codex recheck 2026-09-24, then hardened AGAIN for
 * V09's second-recheck findings, out-p8):
 *   withLock(file, fn, opts) serializes the ENTIRE read-validate-modify-write transaction any caller runs
 *   against one physical file (project/global FORGE_CONFIG.json, FORGE_SESSION_STATE.json, ...) using a
 *   `<file>.lock` marker created with the exclusive 'wx' flag (atomic create-if-absent on every platform
 *   Node supports, including Windows). A second writer blocks (short poll, opts.pollMs, default 15 ms)
 *   until the lock is free or opts.timeoutMs (default 4000 ms) is exceeded — then throws a plain Error with
 *   code 'lock_busy' rather than silently reading a stale snapshot and clobbering the first writer's change.
 *   A lock older than opts.staleMs (default 15000 ms) is presumed to belong to a crashed process and may be
 *   reclaimed. Because `fn` re-reads the file from disk AFTER the lock is acquired (every forge-config.cjs
 *   writer follows this rule), two callers can never lose each other's update — the second one always
 *   starts from the first one's committed bytes.
 *
 *   V09 first fix (Codex recheck 2026-09-24): age alone used to decide BOTH reclamation (unlink whatever
 *   sits at `<file>.lock` once it looks old) and release (unconditionally unlink the pathname) — a holder
 *   suspended past staleMs could have its lock reclaimed by another process, then unwittingly delete THAT
 *   process's fresh replacement lock on its own (now-meaningless) release. Every lock file's content became
 *   an opaque per-holder TOKEN, and both reclaim and release started re-verifying the token before acting.
 *
 *   V09 SECOND fix (out-p8 — "token/mtime checks precede independent rename/unlink operations; an injected
 *   interleaving made two reclaimers both return success; another made A's release delete B's replacement;
 *   injected token-write EIO was swallowed and left a lock its release could not identify"): a CHECK
 *   followed by a SEPARATE act (stat+read, THEN write-a-tmp-file, THEN rename it on top) is still a
 *   check-then-act race — two readers can observe the identical "still stale" snapshot before either one's
 *   write lands, and BOTH then successfully overwrite `<file>.lock` in turn, so both read back their own
 *   just-written token and both report success. The fix removes the gap entirely by making the CLAIM ITSELF
 *   the first and only filesystem mutation, with verification performed on what that claim actually
 *   captured — never on a separate prior read:
 *     - Reclaiming a stale lock now starts with `fs.renameSync(lockPath, <private>)` — an atomic OS-level
 *       rename of the lock's OWN CURRENT NAME. Only ONE caller can ever win this rename for a given source
 *       name (a second, concurrent rename of the same already-moved name fails with ENOENT); there is no
 *       window in which two callers can both successfully claim the same name. AFTER winning the rename,
 *       the private copy's token+mtime are checked against what was inspected a moment ago — a match proves
 *       this really was the stale lock (so a fresh lock of our own is created at the now-empty name); a
 *       MISMATCH means the rename accidentally stole a DIFFERENT (very likely fresher, legitimate) lock
 *       that appeared in the interim, which is immediately restored via `fs.linkSync` (an atomic
 *       create-if-absent at the shared name — it fails harmlessly with EEXIST if yet another lock has since
 *       taken that name, in which case the stolen copy is simply discarded) so a wrong steal is never
 *       destructive.
 *     - Releasing now uses the exact same steal-verify-restore-if-wrong sequence: `fs.renameSync(lock.path,
 *       <private>)` atomically claims WHATEVER currently sits at the lock's name, the private copy's content
 *       is checked against this holder's OWN token, a match is discarded (a normal, correct release) and a
 *       mismatch is restored via `fs.linkSync` — so a release racing a legitimate reclaimer can never delete
 *       the reclaimer's fresh replacement, even when the release's own belief ("I still hold this") was
 *       formed before the reclaim happened.
 *     - Acquiring a brand-new lock (no contention) now fails the WHOLE acquisition — never returns a
 *       success the caller could mistake for real ownership — if the token write fails for any reason after
 *       the exclusive create already succeeded; the half-written file is removed on a best-effort basis so
 *       it is never left behind as a lock nobody can identify by token.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---- one-off approvals (`gate-hook` only, project file only, 10 minutes) ----
const ONCE_KEYS = ['gate-hook'];
const ONCE_MS = 10 * 60 * 1000;
const ONCE_QUOTE_MAX = 200;

/** sanitizeQuote(raw) -> the owner's --once words, control characters folded to spaces, whitespace
 *  collapsed, trimmed, capped at ONCE_QUOTE_MAX. Never throws; a non-string input becomes ''. */
function sanitizeQuote(raw) {
  return Array.from(String(raw == null ? '' : raw))
    .map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, ONCE_QUOTE_MAX);
}

function onceState(ent, nowMs) {
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(ent) || !Object.prototype.hasOwnProperty.call(ent, 'expires_at')) return null;
  if (ent.consumed_at) return { expired: true }; // CFG-07: consumed = back to normal immediately
  const setAtMs = typeof ent.set_at === 'string' ? Date.parse(ent.set_at) : NaN;
  const expMs = typeof ent.expires_at === 'string' ? Date.parse(ent.expires_at) : NaN;
  if (!Number.isFinite(setAtMs) || !Number.isFinite(expMs)) return { expired: true };
  if (nowMs < setAtMs) return { expired: true }; // clock rollback / a future set_at is never trusted
  if (expMs > setAtMs + ONCE_MS) return { expired: true }; // a tampered expiry can never extend the window
  if (expMs <= nowMs) return { expired: true };
  return { expired: false, expires_at: new Date(expMs).toISOString(), minutesLeft: Math.max(1, Math.ceil((expMs - nowMs) / 60000)) };
}

/** onceQuote(ent, oncePrefix) -> the owner's quoted words for a once-shaped entry, or ''. once_quote is
 *  the field forge-gate-hook.cjs reads first; the set_by prefix is a fallback for an older entry shape. */
function onceQuote(ent, oncePrefix) {
  if (ent && typeof ent.once_quote === 'string' && ent.once_quote) return ent.once_quote;
  return ent && typeof ent.set_by === 'string' && oncePrefix && ent.set_by.startsWith(oncePrefix) ? ent.set_by.slice(oncePrefix.length) : '';
}

// ---- cross-process file lock (CFG-09/CFG-10) ----
const LOCK_POLL_MS_DEFAULT = 15;
const LOCK_TIMEOUT_MS_DEFAULT = 4000;
const LOCK_STALE_MS_DEFAULT = 15000;

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function randomToken() {
  return process.pid + ':' + crypto.randomBytes(8).toString('hex');
}

/** stealLockFile(lockPath, privatePath) -> boolean — atomically removes whatever CURRENTLY sits at
 *  `lockPath` by renaming it to `privatePath` (a name only this call knows about). Returns false (nothing
 *  to do, never throws) when `lockPath` does not currently exist — already released or already reclaimed by
 *  someone else. `fs.renameSync` on a shared SOURCE name is the one primitive this whole module leans on for
 *  real atomicity: when two callers race to rename the SAME source name, the OS guarantees only one of them
 *  can find and move it — the other gets ENOENT — so there is no window in which both can believe they hold
 *  it (V09 out-p8: this is what actually closes the "two reclaimers both return success" gap; the OLD
 *  design's separate stat+read CHECK followed by a later write/rename ACT is exactly the gap this removes). */
function stealLockFile(lockPath, privatePath) {
  try { fs.renameSync(lockPath, privatePath); return true; }
  catch { return false; }
}

/** restoreStolenLock(privatePath, lockPath) — puts a wrongly-stolen lock back, best-effort, WITHOUT ever
 *  destroying a third lock that may have appeared at `lockPath` in the meantime. `fs.linkSync` is used (not
 *  `fs.renameSync`) because link fails with EEXIST when `lockPath` is already occupied again — an
 *  unconditional rename-back would silently clobber that newer, legitimate lock instead. Always cleans up
 *  the private copy afterward, whichever branch is taken. */
function restoreStolenLock(privatePath, lockPath) {
  try { fs.linkSync(privatePath, lockPath); }
  catch { /* lockPath already holds ANOTHER (newer) lock — our stolen copy is superseded, just discard it */ }
  try { fs.unlinkSync(privatePath); } catch { /* best effort */ }
}

/** createOwnedLock(lockPath, token) -> true (freshly created and durably holds exactly `token`) | false
 *  (EEXIST — genuine contention, `lockPath` is untouched). Any OTHER failure — including the token WRITE
 *  itself failing after the exclusive 'wx' create already succeeded (V09 out-p8: "injected token-write EIO
 *  was swallowed... left a lock its release could not identify") — is never swallowed: the half-written file
 *  is removed on a best-effort basis and the error is re-thrown, so acquisition FAILS outright rather than
 *  the caller entering its critical section believing it holds a lock nobody can actually identify. */
function createOwnedLock(lockPath, token) {
  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx'); // atomic create-if-absent; this step alone never leaves an ambiguous file
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e; // a failed exclusive create for any other reason must fail acquisition, never retry silently
  }
  let wrote = false;
  try { fs.writeSync(fd, token); wrote = true; }
  catch { /* handled below — never silently treated as a successful acquisition */ }
  try { fs.closeSync(fd); } catch { /* already closed by the runtime on a prior error, or platform quirk */ }
  if (!wrote) {
    try { fs.unlinkSync(lockPath); } catch { /* best effort — a future stale sweep still clears an orphan */ }
    const err = new Error('forge-config: failed to record lock ownership for ' + lockPath);
    err.code = 'lock_write_failed';
    throw err;
  }
  return true;
}

/** tryReclaimStaleLock(lockPath, expectedToken, expectedMtimeMs, newToken) -> boolean (true = this call now
 *  holds the lock, at `lockPath`, with `newToken`). V09 out-p8: acts FIRST (steals the lock's current name
 *  atomically) and verifies SECOND — never the reverse — so no window exists between a check and an act for
 *  a second caller to exploit. Steals whatever currently sits at `lockPath`; if that turns out NOT to be the
 *  specific stale entry inspected a moment ago (a concurrent reclaimer, or the original holder, already
 *  replaced it), the stolen copy is restored untouched and this call reports failure — it NEVER proceeds to
 *  create a lock of its own on top of someone else's live entry. Only once the steal is CONFIRMED to be the
 *  expected stale lock does it create a fresh lock of its own at the now-empty name (createOwnedLock, which
 *  may still legitimately lose a race to a third, brand-new acquirer — that is ordinary contention, not a
 *  bug, and is reported the same way: false). */
function tryReclaimStaleLock(lockPath, expectedToken, expectedMtimeMs, newToken) {
  const privatePath = lockPath + '.reclaim.' + process.pid + '.' + crypto.randomBytes(4).toString('hex');
  if (!stealLockFile(lockPath, privatePath)) return false; // gone already — someone else reclaimed/released it first
  let st, tok, readOk = true;
  try { st = fs.statSync(privatePath); tok = fs.readFileSync(privatePath, 'utf8'); }
  catch { readOk = false; } // cannot verify what was stolen — never claim ownership of the unknown, and never
  // leave it un-identifiable either: restore it below exactly like a genuine mismatch would be.
  if (!readOk || st.mtimeMs !== expectedMtimeMs || tok !== expectedToken) {
    restoreStolenLock(privatePath, lockPath); // stole a DIFFERENT (very likely fresher, live) lock — put it back
    return false;
  }
  try { fs.unlinkSync(privatePath); } catch { /* best effort — lockPath (now empty) is what matters from here */ }
  try { return createOwnedLock(lockPath, newToken); }
  catch { return false; } // a third, brand-new acquirer (or a real write failure) took the freed slot first
}

/** acquireLock(file, opts) -> { path: lockPath, token }, once held — pass this SAME object to releaseLock;
 *  never a bare path (V09). Throws { code:'lock_busy' } after opts.timeoutMs of contention; throws a real
 *  error (never returns) when a fresh create's own token write fails (V09 out-p8). opts: pollMs, timeoutMs,
 *  staleMs. */
function acquireLock(file, opts) {
  opts = opts || {};
  const lockPath = file + '.lock';
  const pollMs = Number.isFinite(opts.pollMs) && opts.pollMs > 0 ? opts.pollMs : LOCK_POLL_MS_DEFAULT;
  const staleMs = Number.isFinite(opts.staleMs) && opts.staleMs > 0 ? opts.staleMs : LOCK_STALE_MS_DEFAULT;
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs >= 0 ? opts.timeoutMs : LOCK_TIMEOUT_MS_DEFAULT;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const token = randomToken();
    // createOwnedLock throws (never returns false) for anything other than EEXIST — that failure is meant
    // to propagate straight out of acquireLock and FAIL the whole acquisition, never be retried silently.
    const created = createOwnedLock(lockPath, token);
    if (created) return { path: lockPath, token };
    // EEXIST: genuine contention — inspect for staleness, maybe reclaim.
    let st = null, curToken = null;
    try { st = fs.statSync(lockPath); curToken = fs.readFileSync(lockPath, 'utf8'); }
    catch { /* the lock vanished (or became unreadable) between the failed create and this inspection — retry below */ }
    if (st && Date.now() - st.mtimeMs > staleMs && tryReclaimStaleLock(lockPath, curToken, st.mtimeMs, token)) {
      return { path: lockPath, token };
    }
    if (Date.now() >= deadline) {
      const err = new Error('forge-config: another process is writing ' + file + ' — try again');
      err.code = 'lock_busy';
      throw err;
    }
    sleepMs(pollMs);
  }
}

/** releaseLock(lock) — never throws. V09 out-p8: releasing is the SAME steal-verify-restore-if-wrong
 *  sequence as reclaiming, for the identical reason — a plain "read then unlink" leaves a gap between the
 *  read and the unlink for a concurrent reclaimer's fresh replacement to land in, which an unconditional
 *  unlink would then destroy. Atomically steals whatever currently sits at `lock.path`; a match with this
 *  holder's own token is a normal, correct release (the stolen copy is simply discarded); a mismatch means
 *  this holder had ALREADY been reclaimed out from under it, so the stolen (someone else's live) lock is
 *  restored untouched rather than being dropped on the floor. */
function releaseLock(lock) {
  if (!lock || !lock.path) return; // defensive: never throw on release
  const privatePath = lock.path + '.release.' + process.pid + '.' + crypto.randomBytes(4).toString('hex');
  if (!stealLockFile(lock.path, privatePath)) return; // already gone — nothing safe to do
  let tok = null;
  try { tok = fs.readFileSync(privatePath, 'utf8'); } catch { /* unreadable — treated as "not ours" below */ }
  if (tok === lock.token) {
    try { fs.unlinkSync(privatePath); } catch { /* best effort */ }
    return; // correctly released
  }
  restoreStolenLock(privatePath, lock.path); // someone else's live replacement — never destroy it
}

/** withLock(file, fn, opts) -> fn()'s return value, run while holding file's lock. Always releases, even
 *  when fn throws. `fn` MUST re-read `file` from disk itself (never reuse a snapshot taken before the
 *  lock) — that is what actually prevents a lost update between two callers. */
function withLock(file, fn, opts) {
  const lock = acquireLock(file, opts);
  try { return fn(); }
  finally { releaseLock(lock); }
}

module.exports = {
  ONCE_KEYS, ONCE_MS, ONCE_QUOTE_MAX,
  sanitizeQuote, onceState, onceQuote,
  acquireLock, releaseLock, withLock,
  randomToken, tryReclaimStaleLock, // exported for direct V09 lock-ownership tests only
};
