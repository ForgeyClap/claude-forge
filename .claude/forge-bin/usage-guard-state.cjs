#!/usr/bin/env node
'use strict';
/**
 * usage-guard-state.cjs — the exclusive state-lock primitive split out of usage-guard.cjs (2026-09-24,
 * Codex recheck wp-f4 V15: GUARD-STATE-RACE fail-closed fix). Zero dependency beyond core Node modules;
 * this file never reads or writes the guard's own state/pause/override content — it only ever opens,
 * waits for, and releases a LOCK FILE PATH the caller names.
 *
 * WHY THIS EXISTS: usage-guard.cjs is ~1900 lines (this project's own file-size guidance names ~500 as
 * the per-file target). The exclusive-open/retry/stale-reclaim shape here is fully generic — it already
 * mirrors this project's OTHER exclusive-lock users (journalAppend/rotateLogIfNeeded/takeOverStaleSlot,
 * all still in usage-guard.cjs) — so it is the one genuinely separable concern to lift out.
 *
 * withStateLock(lockPath, fn, opts) -> Promise<{ ok: true, value } | { ok: false, reason }>.
 *
 * FAIL-CLOSED (V15, 2026-09-24): usage-guard.cjs's OLD withStateLock ran fn() UNLOCKED after ~2s of lock
 * contention (or any non-EEXIST open error) — the exact "fail-safe narrowing" its own doc comment used to
 * defend. Codex proved this lets a slow/blocked writer overwrite a value a CONCURRENT writer set in the
 * meantime: an owner override cleared via `override-off` while a pause round held the lock past the wait
 * budget was silently restored the moment the stale pause finally wrote. This version REFUSES instead — a
 * lock that cannot be acquired within `opts.timeoutMs` (default 2000ms, or the
 * FORGE_USAGE_GUARD_STATE_LOCK_WAIT_MS env override for deterministic, fast tests) never invokes `fn()`
 * at all and returns `{ok:false, reason:'lock-timeout'}` (or `'lock-error'` for a non-EEXIST open
 * failure). Every caller MUST check `.ok` — a refusal means "no write happened this round, try again
 * later", never "written unlocked". A genuinely abandoned lock (age > `opts.staleMs`, default 60000ms —
 * its holder crashed) is still reclaimed, exactly like the pre-existing lock users in usage-guard.cjs.
 */
const fs = require('fs');

const DEFAULT_WAIT_MS = Number(process.env.FORGE_USAGE_GUARD_STATE_LOCK_WAIT_MS) > 0
  ? Number(process.env.FORGE_USAGE_GUARD_STATE_LOCK_WAIT_MS) : 2000;
const DEFAULT_STALE_MS = 60 * 1000;

/** withStateLock(lockPath, fn, opts) — opts.timeoutMs, opts.staleMs, opts.log(msg) are all optional. */
async function withStateLock(lockPath, fn, opts) {
  const o = opts || {};
  const waitMs = Number.isFinite(o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : DEFAULT_WAIT_MS;
  const staleMs = Number.isFinite(o.staleMs) && o.staleMs > 0 ? o.staleMs : DEFAULT_STALE_MS;
  const log = typeof o.log === 'function' ? o.log : () => {};
  const deadline = Date.now() + waitMs;
  let lfd = null;
  let loggedWaiting = false;
  for (;;) {
    try { lfd = fs.openSync(lockPath, 'wx'); break; }
    catch (e) {
      if (e.code !== 'EEXIST') return { ok: false, reason: 'lock-error: ' + e.message };
      let age = Infinity;
      try { age = Date.now() - fs.statSync(lockPath).mtimeMs; } catch { /* vanished under us mid-check */ }
      if (age > staleMs) { try { fs.unlinkSync(lockPath); } catch { /* another waiter already reclaimed it */ } continue; }
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
      await new Promise((res) => setTimeout(res, 25));
    }
  }
  try { const value = await fn(); return { ok: true, value }; }
  finally { try { fs.closeSync(lfd); } catch { /* already closed */ } try { fs.unlinkSync(lockPath); } catch { /* already gone */ } }
}

module.exports = { withStateLock, DEFAULT_WAIT_MS, DEFAULT_STALE_MS };
