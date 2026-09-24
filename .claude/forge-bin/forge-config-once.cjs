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
 *
 *   V09 THIRD fix (Codex recheck 2026-09-24, out-p9 — "a stale holder releases after B has acquired; its
 *   rename temporarily removes B's live lock; injecting C's acquisition at that point succeeds; restoration
 *   encounters C's lock and discards B's captured lock; B and C can now run concurrently. A short writeSync
 *   return also counts as success: a three-byte token was accepted and left an unreleasable lock."):
 *     - RELEASE no longer renames first and verifies second. It now reads the lock's CURRENT holder IN
 *       PLACE (readLockInPlace: one open, one fstat, one read, on the SAME fd — never a rename) and compares
 *       that token to its own BEFORE touching the file at all. A mismatch means this call is no longer the
 *       owner (already reclaimed by someone else) and returns immediately — the file is never renamed, so
 *       a live, different holder's lock is never vacated even for an instant. Only when the in-place read
 *       confirms real ownership does release perform the steal-verify-restore-if-wrong sequence, and only to
 *       close the now-tiny remaining gap between that read and the rename (a genuine reclaimer landing in a
 *       single-syscall window) — not as its primary ownership check.
 *     - RESTORATION FAILURE no longer discards the captured lock. If `fs.linkSync` fails because a THIRD
 *       lock has already taken the name back, the old code still unconditionally deleted the private copy —
 *       silently destroying a still-live lock nobody else could reach. The captured copy is now left on disk
 *       exactly as stolen, and the caller is told the restoration failed, so the current operation fails
 *       honestly instead of quietly discarding someone else's lock.
 *     - TOKEN WRITES must return their FULL byte length. `fs.writeSync` can legitimately write fewer bytes
 *       than asked without throwing; the old code treated any non-throwing call as success. A short write is
 *       now treated exactly like a thrown write error: acquisition fails and the half-written file is removed.
 *
 *   V09 FOURTH fix (out-p10 — "A reads its own stale lock; B reclaims immediately after that read; A then
 *   captures B's fresh lock; C acquires during the vacancy. B's bytes survive only under the private
 *   `.release.*` name, while C owns the shared pathname. Both B and C acquired successfully."): out-p9 still
 *   let RELEASE rename (steal) whatever currently sat at the lock's name whenever its own prior in-place read
 *   happened to match — but that read and the later rename were still two separate steps, so a genuine
 *   reclaimer landing in between them got its brand-new, live lock vacated for the instant between release's
 *   rename and its restore-if-wrong. A CAPTURE-BY-RENAME OF A LOCK THIS CALL DOES NOT ALREADY KNOW, IN PLACE,
 *   TO BE ITS OWN IS REMOVED ENTIRELY — not narrowed, removed:
 *     - RELEASE no longer renames at all. It performs exactly one filesystem inspection
 *       (`readLockInPlace` — open+fstat+read on one fd) and, ONLY when that read's token already matches this
 *       call's own token, removes the file with a plain `fs.unlinkSync`. A mismatch returns immediately —
 *       nothing is ever renamed, so a live, different holder's lock can never be vacated even for an instant.
 *     - RECLAIM no longer treats a caller-supplied, possibly-already-outdated snapshot as license to steal.
 *       `tryReclaimStaleLock(lockPath, staleMs, newToken)` takes a fresh, IN-PLACE look at `lockPath` itself,
 *       immediately before touching anything: it reads the CURRENT token+mtime (never a snapshot handed in by
 *       a caller from an earlier poll) and requires BOTH signals to agree the recorded holder is genuinely
 *       gone — the heartbeat/mtime is older than `staleMs` AND `process.kill(pid, 0)` on the token's own
 *       recorded pid fails with ESRCH (EPERM, or any other unexpected error, still counts as "alive" — fail
 *       closed, never treat an unproven death as a green light). Only when BOTH agree does it rename that
 *       specific lock to a private name — and even then, the private copy's token+mtime are re-verified
 *       against what was just confirmed reclaimable a moment ago; a mismatch (something changed in the
 *       instant between the check and the rename) restores it untouched and this call simply loses the
 *       reclaim. Age alone (the out-p9 design) let a caller whose OWN remembered snapshot was already stale
 *       drive a rename against whatever a legitimate reclaimer had *already* replaced it with; requiring the
 *       recorded pid to be provably dead means a live holder's lock — however old its heartbeat looks — is
 *       simply never eligible for reclaim in the first place, so the capture-worthy rename is never even
 *       attempted against it.
 *     - RESIDUAL (documented, not fixed by this or any rename-based design, and not claimed otherwise): the
 *       in-place read and the later act (unlink in release; rename in reclaim) are still two separate
 *       syscalls, so a true OS-level TOCTOU instant remains between them. This design closes it as far as a
 *       pid-based liveness signal can: a lock cannot be reclaimed while its recorded holder pid is real and
 *       running, so a merely-slow-but-alive holder is now safe from ever being captured (unlike out-p9's
 *       time-only staleness test). The one case this cannot close is pid REUSE: if a holder's process exits
 *       and the OS immediately hands that exact pid number to a brand-new, unrelated process before this lock
 *       is reclaimed, `isPidAlive` cannot tell that new process apart from the original holder still running —
 *       a known, textbook limit of any liveness check keyed on a bare numeric pid rather than a kernel-tracked
 *       process handle/incarnation. This module has no analogous "fence" a transaction can re-check
 *       immediately before its own write (the way a stateful in-memory guard elsewhere in this codebase does)
 *       — `withLock`'s callers only re-read `file` itself after acquiring, they never re-verify the LOCK is
 *       still theirs mid-transaction. Closing either gap fully needs real OS-level locking (e.g. an advisory
 *       byte-range lock the kernel itself revokes on process exit), which this cross-platform,
 *       dependency-free, rename-based file lock intentionally does not depend on.
 *
 *   V09 FIFTH fix (Codex recheck 2026-09-24, out-p11 + Security Boss addendum — "checks the lock in place
 *   and then renames WHATEVER sits at lockPath at that moment; a competing reclaimer that finishes in that
 *   gap has its live lock captured; the restore ignores its return value; a third acquirer takes the vacant
 *   path and two holders run... two actual consumeOnce() calls return success for one approval"):
 *     - RECLAIM NO LONGER RENAMES AWAY FROM lockPath AT ALL — the steal-verify-restore-if-wrong sequence
 *       (the THIRD fix's own mechanism, `stealLockFile`/`restoreStolenLock`) is REMOVED ENTIRELY, not
 *       narrowed. `tryReclaimStaleLock` now mirrors this codebase's own already-reviewed
 *       usage-guard-state.cjs pattern: after the SAME in-place staleness+liveness check as before, a
 *       brand-new token is written to a PRIVATE temp file first, then `fs.renameSync(<private>, lockPath)` —
 *       a rename ONTO an EXISTING destination, which both POSIX `rename(2)` and Windows (`MoveFileExW` +
 *       `MOVEFILE_REPLACE_EXISTING`, what Node's `renameSync` uses) perform as ONE atomic directory-entry
 *       replace. `lockPath` is NEVER, even momentarily, absent from the directory during a reclaim — there
 *       is no window left for a concurrent `openSync(lockPath, 'wx')` (a brand-new acquirer) to walk into,
 *       which is what eliminates the "third acquirer takes the vacant path" half of the finding. A plain
 *       replace-rename carries no EEXIST-style "did I actually win" signal the way an exclusive create does,
 *       so a mandatory READBACK immediately afterward is the real "did I win" check: if a second, concurrent
 *       reclaimer's own replace happened to land after this one, the readback shows THEIR token, and this
 *       call honestly reports it lost — it never assumes success from a rename call that merely did not throw.
 *     - HONEST, NOT-FULLY-CLOSED RESIDUAL (measured, not assumed — see forge-config-once.test.cjs's own
 *       "two-reclaimer interleaving through the reclaim path" test): the in-place check, the replace, and the
 *       readback are three separate syscalls with no compare-and-swap between them. Two reclaimers racing the
 *       EXACT SAME already-provably-dead lock can EACH independently pass eligibility, EACH perform their own
 *       replace, and EACH read back THEIR OWN token immediately afterward — if reclaimer B's replace lands,
 *       THEN reclaimer C's replace lands (overwriting B's), B's own readback (already completed before C
 *       acted) still reported `true`. A plain replace+readback is NOT a true compare-and-swap: it proves "my
 *       write was the most recent one AT THE INSTANT I CHECKED", never "my write is still the one anybody
 *       else will see afterward". THIS IS EXACTLY WHY `withLock`'s fence exists (the next change below) and
 *       why every real transaction MUST re-check it immediately before its own publish, not only trust
 *       tryReclaimStaleLock/acquireLock's own return value: a caller who believed it won a reclaim, like B
 *       above, has its OWN later fence() check correctly report `false` once C's replace has actually landed,
 *       so B's real write is refused (EFENCED) even though its EARLIER reclaim looked successful. This
 *       residual is the SAME class this project's own usage-guard-state.cjs already accepted for its
 *       identical fourth-recheck fix (mitigated there, as here, by its own fence-at-publish discipline);
 *       closing it fully needs real OS-level locking, which this dependency-free design intentionally does
 *       not depend on. CRITICALLY, THIS RESIDUAL NEVER DETERMINES THE SECURITY PROPERTY OUT-P11 ACTUALLY
 *       CARES ABOUT — consumeOnce()'s at-most-once authorization guarantee (the third change below; see
 *       forge-config-once-store.cjs's own header for why "exactly-once" over-promises this and is not used
 *       to describe it) does not depend on this lock's acquisition being race-free at all.
 *     - A REAL FENCE: `withLock(file, fn, opts)` now calls `fn(fence)`, where `fence()` re-reads `lockPath`
 *       IN PLACE and reports whether it still holds this exact token, right now. Every write forge-config.cjs
 *       performs inside a `withLock` callback re-checks `fence()` as the LAST synchronous step before the one
 *       mutation that actually publishes it (the rename onto the target file) and refuses with a real
 *       `EFENCED` error, writing nothing, on a mismatch — the same fence-at-publish pattern this codebase's
 *       usage-guard.cjs::writeStateTo already uses for usage-guard-state.cjs's own lock. This makes the
 *       CHANGELOG's "the config lock's fence refuses a stale write" claim true; before this fix no such fence
 *       existed anywhere in this file or forge-config.cjs.
 *     - THE REAL FIX FOR "two actual consumeOnce() calls return success for one approval" IS STRUCTURAL, NOT
 *       A TIGHTER LOCK: an armed `--once` grant now ALSO lives in its own file (see the sibling
 *       forge-config-once-store.cjs), and consuming it is exactly one `fs.renameSync(pendingPath,
 *       consumedPath)` — an OS-level atomic claim of a shared source name that holds regardless of ANY
 *       interleaving two callers experience around this lock (a reclaim race, a release race, or this lock
 *       being bypassed entirely). forge-config.cjs::consumeOnce() calls that store's consumeOnceGrant() as an
 *       ADDITIONAL, independent gate before ever honouring what its own (still lock-guarded, display-only)
 *       FORGE_CONFIG.json mirror check believed was a valid, unconsumed grant.
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

/** readLockInPlace(lockPath) -> { mtimeMs, token } (the CURRENT holder's identity) | null (does not exist or
 *  unreadable) — inspects `lockPath` WITHOUT renaming or removing anything: one `open`, one `fstat`, one
 *  `read`, all against the SAME file descriptor (never two separate opens, which would itself leave a gap
 *  between them). This is the ownership/staleness check every caller MUST perform before ever attempting to
 *  rename/unlink a lock (V09 out-p9): renaming first and verifying second can vacate a lock that turns out to
 *  belong to a live, different holder, wide enough for a concurrent acquirer to walk in during that instant. */
function readLockInPlace(lockPath) {
  let fd;
  try { fd = fs.openSync(lockPath, 'r'); }
  catch { return null; } // gone, or unreadable — nothing to inspect, never guess
  try {
    const st = fs.fstatSync(fd);
    const buf = Buffer.alloc(st.size);
    fs.readSync(fd, buf, 0, st.size, 0);
    return { mtimeMs: st.mtimeMs, token: buf.toString('utf8') };
  } catch { return null; }
  finally { try { fs.closeSync(fd); } catch { /* already closed, or a platform quirk */ } }
}

/** parseTokenPid(token) -> a positive integer pid, or NaN when `token` is not a string, has no ':' separator,
 *  or the part before it is not a positive integer. Every token this module ever WRITES is
 *  `process.pid + ':' + <random hex>` (see randomToken below), so this only ever fails to parse a token this
 *  module did not itself create (hand-edited, corrupted, or from some future format). */
function parseTokenPid(token) {
  if (typeof token !== 'string') return NaN;
  const idx = token.indexOf(':');
  if (idx <= 0) return NaN;
  const pid = Number(token.slice(0, idx));
  return Number.isInteger(pid) && pid > 0 ? pid : NaN;
}

/** isPidAlive(pid) -> boolean, FAIL CLOSED (V09 out-p10): true means "never treat this as a provably dead
 *  holder" and is returned for an unparseable/invalid pid, a successful `process.kill(pid, 0)` (the process
 *  exists and we may signal it), and EPERM (the process exists — just owned by someone else, or by us without
 *  permission to signal it — still running either way). Only ESRCH (no such process) returns false: the one
 *  signal this module trusts as genuine proof the recorded holder is gone. Signal 0 sends nothing; it only
 *  probes existence, so this never disturbs the pid it inspects. */
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true; // cannot verify — never treated as provably dead
  try { process.kill(pid, 0); return true; }
  catch (e) { return !(e && e.code === 'ESRCH'); } // ESRCH = definitively gone; anything else fails closed
}

/** reclaimEligibility(lockPath, staleMs) -> null (vanished/unreadable — nothing here to reclaim) | { token,
 *  mtimeMs, eligible } — a FRESH `readLockInPlace` of `lockPath`'s CURRENT content, taken immediately before
 *  any attempt to touch the file (V09 out-p10: never a snapshot a caller observed on an earlier poll, which
 *  can already be outdated by the time a reclaim is actually attempted). `eligible` requires BOTH signals to
 *  agree the recorded holder is genuinely gone: the heartbeat/mtime is older than `staleMs` AND the token's
 *  own recorded pid fails isPidAlive. Read-only — never renames or removes anything. */
function reclaimEligibility(lockPath, staleMs) {
  const seen = readLockInPlace(lockPath);
  if (!seen) return null;
  const ageMs = Date.now() - seen.mtimeMs;
  return { token: seen.token, mtimeMs: seen.mtimeMs, eligible: ageMs > staleMs && !isPidAlive(parseTokenPid(seen.token)) };
}

/** createOwnedLock(lockPath, token) -> true (freshly created and durably holds exactly `token`) | false
 *  (EEXIST — genuine contention, `lockPath` is untouched). Any OTHER failure — including the token WRITE
 *  itself failing after the exclusive 'wx' create already succeeded (V09 out-p8: "injected token-write EIO
 *  was swallowed... left a lock its release could not identify"), OR the write returning FEWER bytes than
 *  `token` without throwing at all (V09 out-p9: "a short writeSync return also counts as success: a
 *  three-byte token was accepted and subsequently left an unreleasable lock" — nobody else's token compare
 *  could ever match a partial token again) — is never swallowed: the half-written file is removed on a
 *  best-effort basis and the error is re-thrown, so acquisition FAILS outright rather than the caller
 *  entering its critical section believing it holds a lock nobody can actually identify. */
function createOwnedLock(lockPath, token) {
  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx'); // atomic create-if-absent; this step alone never leaves an ambiguous file
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e; // a failed exclusive create for any other reason must fail acquisition, never retry silently
  }
  let wrote = false;
  try {
    const expectedLen = Buffer.byteLength(token, 'utf8');
    wrote = fs.writeSync(fd, token) === expectedLen; // the FULL token, not merely a non-throwing call
  } catch { /* handled below — never silently treated as a successful acquisition */ }
  try { fs.closeSync(fd); } catch { /* already closed by the runtime on a prior error, or platform quirk */ }
  if (!wrote) {
    try { fs.unlinkSync(lockPath); } catch { /* best effort — a future stale sweep still clears an orphan */ }
    const err = new Error('forge-config: failed to record lock ownership for ' + lockPath);
    err.code = 'lock_write_failed';
    throw err;
  }
  return true;
}

/** replaceLockFile(tmp, lockPath) -> boolean — `fs.renameSync(tmp, lockPath)` with a short, bounded retry on
 *  Windows's own EPERM/EBUSY/EACCES (confirmed live on this machine: a rename ONTO a destination another
 *  caller currently has open for a brief, plain read — exactly what readLockInPlace's own open+fstat+read+
 *  close does, elsewhere, for release or for another reclaimer's eligibility check — can transiently fail on
 *  Windows even though the destination genuinely exists and the rename is otherwise valid; POSIX rename(2)
 *  has no such restriction). This is the SAME transient condition and the SAME retry shape
 *  forge-config.cjs's own `renameWithRetry` already uses for its atomic config writes — never a silent
 *  swallow of a real, non-transient failure. */
function replaceLockFile(tmp, lockPath) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, lockPath); return true; }
    catch (e) {
      if (i >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) return false;
      sleepMs(10 * (i + 1));
    }
  }
}

/** tryReclaimStaleLock(lockPath, staleMs, newToken) -> boolean (true = this call now holds the lock, at
 *  `lockPath`, with `newToken`). V09 FIFTH fix (out-p11 + addendum): NO RENAME-AWAY FROM lockPath, EVER —
 *  mirrors this codebase's own usage-guard-state.cjs pattern (see the file header). Takes its OWN fresh
 *  in-place look (reclaimEligibility — never a caller-supplied snapshot from an earlier poll, which can
 *  already be outdated) and only proceeds when BOTH the heartbeat/mtime is older than `staleMs` AND the
 *  recorded holder pid is not alive — a live holder's lock, however old its heartbeat, is simply never
 *  eligible, so lockPath itself is never even approached. Once eligible, `newToken` is written to a PRIVATE
 *  temp file FIRST (reusing createOwnedLock's own full-write-or-throw discipline — a failed write here never
 *  touches lockPath at all, so a failed attempt leaves the original, still-genuinely-stale lock completely
 *  intact for an immediate retry), then replaceLockFile REPLACES whatever currently sits at lockPath in ONE
 *  atomic step — the path is never absent, not even for an instant, closing the exact vacancy a concurrent
 *  fresh `wx`-create could otherwise walk into. A plain replace-rename has no EEXIST-style success signal, so
 *  a mandatory READBACK is the only real "did I win" check: only when lockPath now reads back as EXACTLY
 *  `newToken` does this call report success — never assumed from a rename call that merely did not throw. */
function tryReclaimStaleLock(lockPath, staleMs, newToken) {
  const info = reclaimEligibility(lockPath, staleMs);
  if (!info || !info.eligible) return false; // vanished, not yet stale, or its holder pid is still alive
  const tmp = lockPath + '.reclaim.' + process.pid + '.' + crypto.randomBytes(4).toString('hex');
  try { createOwnedLock(tmp, newToken); } // same full-write-or-throw-and-cleanup discipline as a fresh acquire
  catch { try { fs.unlinkSync(tmp); } catch { /* createOwnedLock already cleaned up its own failure */ } return false; }
  if (!replaceLockFile(tmp, lockPath)) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    return false; // lockPath itself was never touched by a failed replace — nothing to clean up there
  }
  const after = readLockInPlace(lockPath);
  return !!after && after.token === newToken; // a concurrent reclaimer's later replace would show THEIR token here
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
    // EEXIST: genuine contention. tryReclaimStaleLock performs its OWN fresh in-place staleness+liveness
    // check immediately before ever touching the file (V09 out-p10) — this call never hands it a snapshot
    // that might already be outdated by the time an attempt actually happens.
    if (tryReclaimStaleLock(lockPath, staleMs, token)) {
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

/** releaseLock(lock) -> boolean (true = this call's own lock was genuinely released; false = nothing of
 *  ours was there — never throws). V09 out-p10: release no longer renames AT ALL. out-p9 still verified
 *  ownership in place FIRST but then performed the same steal-verify-restore-if-wrong rename as reclaim to
 *  close "the now-tiny remaining gap" — and that rename is exactly what let a genuine reclaimer's brand-new,
 *  live lock get vacated for an instant when this call's earlier in-place read happened to still see its own
 *  token (the reclaim landed AFTER that read but BEFORE this rename): "A reads its own stale lock; B reclaims
 *  immediately after that read; A then captures B's fresh lock; C acquires during the vacancy." Release now
 *  performs exactly ONE filesystem inspection — readLockInPlace (one open, one fstat, one read, on the same
 *  fd) — and, ONLY when that read's token already matches this call's own `lock.token`, removes the file
 *  directly with a plain `fs.unlinkSync`. A mismatch returns immediately: nothing is ever renamed, so a live,
 *  different holder's lock can never be vacated even for an instant, and there is no vacancy left for a third
 *  party to walk into. RESIDUAL (documented, not eliminated): the in-place read and the unlink remain two
 *  separate syscalls — a true OS-level instant between them is not closeable without real OS-level locking.
 *  What this design DOES guarantee is that a lock is never reclaimable at all while its recorded holder pid
 *  is genuinely alive (see tryReclaimStaleLock/isPidAlive), so the only way this call's own token can already
 *  be gone by the time it reads is a reclaimer who first proved, independently, that THIS process's pid was
 *  not alive — which cannot happen while this call is the one executing it. */
function releaseLock(lock) {
  if (!lock || !lock.path) return false; // defensive: never throw on release
  const seen = readLockInPlace(lock.path);
  if (!seen || seen.token !== lock.token) return false; // not ours (already gone or reclaimed) — untouched, never renamed
  try { fs.unlinkSync(lock.path); return true; }
  catch { return false; } // vanished or became unremovable between the read and the unlink — never throw
}

/** withLock(file, fn, opts) -> fn(fence)'s return value, run while holding file's lock. Always releases,
 *  even when fn throws. `fn` MUST re-read `file` from disk itself (never reuse a snapshot taken before the
 *  lock) — that is what actually prevents a lost update between two callers. FENCE (V09 FIFTH fix, out-p11 +
 *  addendum): `fence()` re-reads lockPath IN PLACE and reports whether this call still holds EXACTLY this
 *  token, right now. A caller whose transaction publishes a write (a rename onto the real target file) MUST
 *  call `fence()` immediately before that rename and refuse — write nothing — on false: the same
 *  fence-at-publish pattern usage-guard.cjs::writeStateTo already uses for usage-guard-state.cjs's own lock.
 *  Without this, a caller could still believe it holds the lock (an earlier check of its own passed) while a
 *  reclaimer has since genuinely replaced it — `fence()` is what actually makes forge-config.cjs's own write
 *  path refuse a stale write, not merely acquireLock/releaseLock's own internal bookkeeping. */
function withLock(file, fn, opts) {
  const lock = acquireLock(file, opts);
  const fence = () => {
    const seen = readLockInPlace(lock.path);
    return !!seen && seen.token === lock.token;
  };
  try { return fn(fence); }
  finally { releaseLock(lock); }
}

module.exports = {
  ONCE_KEYS, ONCE_MS, ONCE_QUOTE_MAX,
  sanitizeQuote, onceState, onceQuote,
  acquireLock, releaseLock, withLock,
  randomToken, tryReclaimStaleLock, isPidAlive, // exported for direct V09 lock-ownership tests only
};
