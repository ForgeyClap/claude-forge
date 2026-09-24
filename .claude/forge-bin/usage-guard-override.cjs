#!/usr/bin/env node
'use strict';
/**
 * usage-guard-override.cjs — DEFENSE IN DEPTH for the credits override (V15, FOURTH Codex recheck,
 * 2026-09-24). Split out of usage-guard.cjs (2182 lines before this fix; this project's own file-size
 * guidance names ~500 as the per-file target) to keep that file from growing further — see the sync-pin
 * note in this work package's report to the Lead.
 *
 * WHY THIS EXISTS: even with the FOURTH lock-protocol hardening (usage-guard-state.cjs: reclaim now
 * verifies staleness IN PLACE and never vacates a live lock, closing the SPECIFIC vacancy Codex's third
 * schedule exploited), Codex's own p10 recheck names an honest residual: `verifyLockStaleInPlace()` and the
 * subsequent atomic replace are still two separate syscalls, and `writeStateTo()`'s own fence-check-then-
 * rename (usage-guard.cjs) is likewise two adjacent but separate syscalls — on a real multi-process system
 * a genuinely different OS process can still, in principle, land an action in the gap between them. A
 * holder frozen past the stale interval that then resumes can, in a sufficiently adversarial interleaving,
 * still land its OWN publish after a legitimate clearer's — resurrecting a value in state.json that the
 * owner had already turned off. An event-loop heartbeat can never PROVE a suspended process is truly gone;
 * exclusion alone was never going to be a complete answer to that.
 *
 * THE FIX: stop trusting state.json's own cached `ownerOverride.active` for the actual PAUSE/DON'T-PAUSE
 * decision. Instead, derive it FRESH, every tick, from an independent, expiry-aware record
 * (forge-ownergrant.cjs's readOverrideGrant/writeOverrideGrant) that ONLY the `override-on`/`override-off`
 * CLI commands ever write — never the watcher's own tick() (N12, 2026-09-24, Security Boss addendum: this is
 * now genuinely true — the watcher used to also call writeOverrideGrant on credits exhaustion; it no longer
 * does, see usage-guard.cjs's own N12 history). A stale writer that manages to resurrect state.json's cached
 * `ownerOverride.active:true` can no longer suppress pausing on its own: the grant file is checked too, and
 * an absent/expired/invalid grant means the override is OFF regardless of what the cache says. The cache is
 * still written (for `status`'s display and for credits-mode bookkeeping), but it is always written FROM the
 * grant's fresh read, never the other way around.
 *
 * N10 (2026-09-24, Security Boss addendum reconfirmed) — ACCOUNT BINDING: the FOURTH recheck's grant record
 * was project-wide, with no account identity at all. MEASURED REGRESSION: grant an override for account A,
 * switch to account B, and B inherits A's override at the very next tick — the state-cache reset that
 * clears a foreign `ownerOverride` on an account switch (usage-guard.cjs's `stateForAccount`) never touched
 * this NEW, separate grant file, so it survived the switch untouched. THE FIX: resolveOwnerOverride() now
 * requires the CALLER to supply the account identity it is deciding FOR (`opts.accountLabel` — the SAME
 * opaque local label usage-guard.cjs's `readAccountIdentity()` already derives via
 * usage-guard-redact.cjs's resolveLocalAccountLabel, never a raw fingerprint/uuid/token) and REJECTS the
 * grant — override OFF, exactly like an absent grant — unless the grant's own `accountLabel` matches it
 * exactly. A foreign account, a label-less (legacy) grant, or an UNKNOWN current identity (accountLabel not
 * supplied/unreadable) all refuse: when identity cannot be verified, the SAFE default is "do not suppress
 * pausing" (the normal usage-limit protection stays in effect), never the reverse.
 */
const guardGrant = require('./forge-ownergrant.cjs');
const guardRedact = require('./usage-guard-redact.cjs');

/** resolveOwnerOverride(opts) -> { active, record, rejected }. `active` is the ONLY value any caller may
 *  use to decide whether to suppress pausing — never state.json's own cached `ownerOverride.active`.
 *  `opts.projectRoot` must be the SAME trusted root usage-guard.cjs already anchors
 *  override-on/verifyForcedWatchGrant to (its module-level `TRUSTED_OWNERGRANT_ROOT` — never an
 *  environment-selected root; see that file's own N06 history for why). `opts.accountLabel` (N10,
 *  2026-09-24) is the CURRENT opaque local identity label the caller is deciding for; a grant is honoured
 *  ONLY when this exactly matches the grant's own `accountLabel`. `rejected` is `null` when there is simply
 *  no active grant at all (absent/expired/invalid-expiry — the ordinary, unremarkable case), or one of
 *  `'unknown-identity'` | `'label-less-grant'` | `'foreign-account'` when a real, otherwise-active grant was
 *  refused specifically because it could not be verified against the current account — callers may use this
 *  to log a more specific reason (the account labels themselves are non-secret and safe to log; never a
 *  fingerprint/uuid/token). Never throws. */
function resolveOwnerOverride(opts) {
  const o = opts || {};
  const record = guardGrant.readOverrideGrant(o);
  if (record.active !== true) return { active: false, record, rejected: null };
  const current = typeof o.accountLabel === 'string' && o.accountLabel ? o.accountLabel : null;
  if (!current) return { active: false, record, rejected: 'unknown-identity' };
  if (typeof record.accountLabel !== 'string' || !record.accountLabel) return { active: false, record, rejected: 'label-less-grant' };
  if (record.accountLabel !== current) return { active: false, record, rejected: 'foreign-account' };
  return { active: true, record };
}

/** cachedOverrideFrom(record) -> the object usage-guard.cjs should write into state.ownerOverride to keep
 *  it informative for `status`'s display and for the `reArmWhenCreditsExhausted` credits-mode convention —
 *  always DERIVED from the fresh grant record, never a pass-through of whatever a stale writer may have
 *  left behind in the cache. `reason` is passed through usage-guard-redact.cjs's sanitizeReason() before
 *  ever being persisted (N10/N11/N12 Codex recheck qualification, 2026-09-24: "reasons are stored without
 *  redaction") — control characters are stripped and a long token-shaped run is masked, so an owner/agent
 *  mistake in `--reason` can never inject a fake log line or leak a pasted credential into a
 *  synced/dashboard-visible state file. Returns `undefined` when inactive, so a caller can `delete`/omit the
 *  field cleanly. Pure, never throws. */
function cachedOverrideFrom(record) {
  if (!record || record.active !== true) return undefined;
  return {
    active: true,
    at: record.at || new Date().toISOString(),
    reason: guardRedact.sanitizeReason(record.reason),
    until: record.until || null,
    reArmWhenCreditsExhausted: true,
  };
}

// DEFAULT_GRANT_MAX_MS (N12, 2026-09-24, Security Boss addendum reconfirmed): forge-ownergrant.cjs's
// readOverrideGrant now reads a missing/unparseable `until` as an INVALID grant, never "unlimited" (closing
// a "credit-exhaustion re-arm silently stops working -> suppressed forever" gap). This is the bounded
// backstop `resolveGrantUntil` below fills in for override-on when the owner does not pass `--until` — credit
// exhaustion stays the PRIMARY, expected re-arm path for ordinary use; this only matters if that path itself
// silently misbehaves.
const DEFAULT_GRANT_MAX_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** resolveGrantUntil(rawUntil) -> a valid ISO-8601 string, NEVER null/empty (N12, 2026-09-24). A
 *  well-formed, parseable `rawUntil` is returned unchanged; a missing or unparseable one is replaced by the
 *  bounded default backstop (`DEFAULT_GRANT_MAX_MS` from now) — see forge-ownergrant.cjs's readOverrideGrant
 *  for why a grant may never be written with no real expiry at all. Pure (uses the current wall clock only
 *  when a default is actually needed), never throws. */
function resolveGrantUntil(rawUntil) {
  if (typeof rawUntil === 'string' && rawUntil && Number.isFinite(Date.parse(rawUntil))) return rawUntil;
  return new Date(Date.now() + DEFAULT_GRANT_MAX_MS).toISOString();
}

/** describeOverrideLockOutcome(kind, onLock, ctx) -> { line, partial } — the honest CLI status line for
 *  override-on/override-off's BEST-EFFORT cache/resume-bookkeeping lock step, called AFTER the authoritative
 *  grant action (publish for 'on', clear for 'off') has ALREADY succeeded (N11, 2026-09-24, Security Boss
 *  addendum reconfirmed — MEASURED DEFECTS `V15-override-on-lock-failure-status` and
 *  `V15-override-off-unlink-failure-status`: a lock/cache failure here used to be reported as "no change
 *  made" or plain success, both dishonest once the grant itself already took effect). `kind`: 'on' | 'off'.
 *  `onLock`: the `{ok, reason, value:{fenced, ...}}` shape withStateLock()/withLockedState() returns.
 *  `ctx.until` ('on' only) is echoed in the full-success line. `partial:true` means the caller should print
 *  via `console.error` (a lagging-cache note, not a failure of the security-relevant action) and still exit
 *  0 — the grant action itself already succeeded either way. Pure, never throws. */
function describeOverrideLockOutcome(kind, onLock, ctx) {
  const o = ctx || {};
  if (kind === 'on') {
    const lag = ' — any previously paused agents may not have been resumed yet, and `status`\'s cached display may lag; the grant itself already took effect';
    if (!onLock.ok) return { line: 'usage-guard OVERRIDE ON — the authoritative grant is ACTIVE (plan-limit guard suppressed) but the state lock could not be acquired for cache/resume bookkeeping (' + onLock.reason + ')' + lag, partial: true };
    if (onLock.value.fenced) return { line: 'usage-guard OVERRIDE ON — the authoritative grant is ACTIVE (plan-limit guard suppressed) but the state lock was reclaimed mid-transaction (fenced) before cache/resume bookkeeping completed' + lag, partial: true };
    const { resumed, wasPaused } = onLock.value;
    return { line: 'usage-guard OVERRIDE ON — plan-limit guard suppressed' + (wasPaused ? ' · resumed ' + resumed + '/' + wasPaused + ' paused agent(s)' : '') + '; auto re-arm when credits exhausted or after ' + o.until, partial: false };
  }
  const lag = ' — `status`\'s cached display may lag';
  if (!onLock.ok) return { line: 'usage-guard OVERRIDE CLEARED — normal plan-limit guard re-armed (the authoritative grant is gone), but the state-lock cache bookkeeping failed (' + onLock.reason + ')' + lag, partial: true };
  if (onLock.value.fenced) return { line: 'usage-guard OVERRIDE CLEARED — normal plan-limit guard re-armed (the authoritative grant is gone), but the state lock was reclaimed mid-transaction (fenced) before cache bookkeeping completed' + lag, partial: true };
  return { line: 'usage-guard OVERRIDE ' + (onLock.value.had ? 'CLEARED' : 'was not set') + ' — normal plan-limit guard re-armed', partial: false };
}

module.exports = { resolveOwnerOverride, cachedOverrideFrom, resolveGrantUntil, describeOverrideLockOutcome };
