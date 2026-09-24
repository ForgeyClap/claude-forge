#!/usr/bin/env node
'use strict';
/**
 * forge-config-once.cjs — the one-off (`--once`) approval state machine and the cross-process file lock,
 * split out of forge-config.cjs (Codex recheck 2026-09-24, CFG-07/S06/CFG-09/CFG-10) so that file stays a
 * readable size. WHY together: both pieces exist for the SAME reason — forge-config.cjs's writes must be
 * safe under concurrency and its one-off exception must be a real single-use approval, not an extensible
 * window. Zero-dependency (fs/path only). Not a CLI — required only by forge-config.cjs.
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
 * FILE LOCK (CFG-09/CFG-10):
 *   withLock(file, fn, opts) serializes the ENTIRE read-validate-modify-write transaction any caller runs
 *   against one physical file (project/global FORGE_CONFIG.json, FORGE_SESSION_STATE.json, ...) using a
 *   plain `<file>.lock` marker created with the exclusive 'wx' flag (atomic create-if-absent on every
 *   platform Node supports, including Windows). A second writer blocks (short poll, opts.pollMs, default
 *   15 ms) until the lock is free or opts.timeoutMs (default 4000 ms) is exceeded — then throws a plain
 *   Error with code 'lock_busy' rather than silently reading a stale snapshot and clobbering the first
 *   writer's change. A lock older than opts.staleMs (default 15000 ms) is presumed to belong to a crashed
 *   process and is reclaimed. Because `fn` re-reads the file from disk AFTER the lock is acquired (every
 *   forge-config.cjs writer follows this rule), two callers can never lose each other's update — the
 *   second one always starts from the first one's committed bytes.
 */
const fs = require('fs');
const path = require('path');

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

/** acquireLock(file, opts) -> the lock file path, once held. Throws { code:'lock_busy' } after
 *  opts.timeoutMs of contention. opts: pollMs, timeoutMs, staleMs. */
function acquireLock(file, opts) {
  opts = opts || {};
  const lockPath = file + '.lock';
  const pollMs = Number.isFinite(opts.pollMs) && opts.pollMs > 0 ? opts.pollMs : LOCK_POLL_MS_DEFAULT;
  const staleMs = Number.isFinite(opts.staleMs) && opts.staleMs > 0 ? opts.staleMs : LOCK_STALE_MS_DEFAULT;
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs >= 0 ? opts.timeoutMs : LOCK_TIMEOUT_MS_DEFAULT;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try { fs.writeSync(fd, String(process.pid)); } catch { /* best effort — the lock's mere existence is what matters */ }
      fs.closeSync(fd);
      return lockPath;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let st = null;
      try { st = fs.statSync(lockPath); } catch { /* the lock vanished between the failed create and this stat — retry */ }
      if (st && Date.now() - st.mtimeMs > staleMs) {
        try { fs.unlinkSync(lockPath); continue; } catch { /* someone else already reclaimed/renewed it */ }
      }
      if (Date.now() >= deadline) {
        const err = new Error('forge-config: another process is writing ' + file + ' — try again');
        err.code = 'lock_busy';
        throw err;
      }
      sleepMs(pollMs);
    }
  }
}

function releaseLock(lockPath) {
  try { fs.unlinkSync(lockPath); } catch { /* already released or never created */ }
}

/** withLock(file, fn, opts) -> fn()'s return value, run while holding file's lock. Always releases, even
 *  when fn throws. `fn` MUST re-read `file` from disk itself (never reuse a snapshot taken before the
 *  lock) — that is what actually prevents a lost update between two callers. */
function withLock(file, fn, opts) {
  const lockPath = acquireLock(file, opts);
  try { return fn(); }
  finally { releaseLock(lockPath); }
}

module.exports = {
  ONCE_KEYS, ONCE_MS, ONCE_QUOTE_MAX,
  sanitizeQuote, onceState, onceQuote,
  acquireLock, releaseLock, withLock,
};
