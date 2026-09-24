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
 *
 * N10 RESIDUAL (2026-09-24, Codex p12 wave 7, out-p12 finding N10) — STALE PROFILE, ROTATED CREDENTIAL: the
 * account-label check above trusts Claude Code's own profile file (~/.claude.json) to say which account is
 * CURRENTLY active. Codex's `N10_stale_profile_stable_new_credential` proved that file can lag behind an
 * already-rotated `.credentials.json`: the profile keeps reporting account A's label while the credential
 * actually in use already belongs to account B, so a grant genuinely issued for A silently keeps suppressing
 * pausing for B — zero pauses at 100% usage, on a completely different account. Reading the CREDENTIAL
 * file's own content to fix this would violate this project's own hard rule (GUARD-TOKEN-FINGERPRINT: no
 * value derived from a bearer credential is ever persisted or logged) — so this uses NON-secret FILE
 * METADATA instead: `opts.credentialGeneration` is a caller-supplied mtime+size stamp of the credentials
 * file (usage-guard.cjs's `credentialGeneration()`), and `record.credentialGeneration` is the SAME stamp
 * captured by `override-on` at grant time. When the two differ — the credential file has changed since the
 * grant was issued or last confirmed — the grant is NOT honoured (`rejected:'credential-generation-
 * unconfirmed'`, fail toward pausing) unless the caller's `opts.confirmedGeneration` already equals the
 * current stamp, meaning a LATER tick already re-read the profile, found it still matching this grant's
 * account label, and recorded that specific generation as confirmed (usage-guard.cjs's tick() does this
 * bookkeeping in state.json's per-account cache — the grant file itself is never touched by this, keeping
 * "only override-on/override-off ever write the grant" true). HONEST LIMITATION (documented, not hidden):
 * this is a non-secret, best-effort signal, not a cryptographic proof of identity — a profile file that
 * NEVER updates (permanently stale) still gets "confirmed" after exactly one grace tick once the SAME new
 * generation is observed twice in a row while the label still matches, because there is no non-secret signal
 * left to distinguish that from a legitimate one-time confirmation. What this closes is the MEASURED
 * defect — zero pauses forever — not a permanent guarantee against an indefinitely-stale profile.
 */
const guardGrant = require('./forge-ownergrant.cjs');
const guardRedact = require('./usage-guard-redact.cjs');

/** resolveOwnerOverride(opts) -> { active, record, rejected, currentGeneration? }. `active` is the ONLY
 *  value any caller may use to decide whether to suppress pausing — never state.json's own cached
 *  `ownerOverride.active`. `opts.projectRoot` must be the SAME trusted root usage-guard.cjs already anchors
 *  override-on/verifyForcedWatchGrant to (its module-level `TRUSTED_OWNERGRANT_ROOT` — never an
 *  environment-selected root; see that file's own N06 history for why). `opts.accountLabel` (N10,
 *  2026-09-24) is the CURRENT opaque local identity label the caller is deciding for; a grant is honoured
 *  ONLY when this exactly matches the grant's own `accountLabel`. `opts.credentialGeneration` /
 *  `opts.confirmedGeneration` (N10 residual, 2026-09-24 — see the file header) are the current credential
 *  FILE's mtime+size stamp and the last-confirmed one for this account respectively; both are optional and a
 *  missing/non-string value simply skips this extra check (old-style grants written before this field
 *  existed, or a caller that cannot supply one, keep the pre-existing account-binding behaviour). `rejected`
 *  is `null` when there is simply no active grant at all (absent/expired/invalid-expiry — the ordinary,
 *  unremarkable case), or one of `'unknown-identity'` | `'label-less-grant'` | `'foreign-account'` |
 *  `'credential-generation-unconfirmed'` when a real, otherwise-active grant was refused specifically because
 *  it could not be verified against the current account — callers may use this to log a more specific reason
 *  (the account labels and generation stamps themselves are non-secret and safe to log; never a
 *  fingerprint/uuid/token). `currentGeneration` is set only on a `'credential-generation-unconfirmed'`
 *  rejection, so the caller can record it as "seen, pending confirmation" for next tick. Never throws. */
function resolveOwnerOverride(opts) {
  const o = opts || {};
  const record = guardGrant.readOverrideGrant(o);
  if (record.active !== true) return { active: false, record, rejected: null };
  const current = typeof o.accountLabel === 'string' && o.accountLabel ? o.accountLabel : null;
  if (!current) return { active: false, record, rejected: 'unknown-identity' };
  if (typeof record.accountLabel !== 'string' || !record.accountLabel) return { active: false, record, rejected: 'label-less-grant' };
  if (record.accountLabel !== current) return { active: false, record, rejected: 'foreign-account' };
  // N10 residual: the profile-derived label matched, but the credential FILE may have changed since this
  // grant was issued/last confirmed — see the file header for the full rationale and its honest limitation.
  const curGen = typeof o.credentialGeneration === 'string' && o.credentialGeneration ? o.credentialGeneration : null;
  const grantGen = typeof record.credentialGeneration === 'string' && record.credentialGeneration ? record.credentialGeneration : null;
  const confirmedGen = typeof o.confirmedGeneration === 'string' && o.confirmedGeneration ? o.confirmedGeneration : null;
  if (grantGen && curGen && grantGen !== curGen && confirmedGen !== curGen) {
    return { active: false, record, rejected: 'credential-generation-unconfirmed', currentGeneration: curGen };
  }
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

// DEFAULT_GRANT_MAX_MS (N12, 2026-09-24, Security Boss addendum reconfirmed; Finding 5, 2026-09-24, Codex
// p12 wave 7 — RAISED FROM A DEFAULT TO A HARD MAXIMUM): forge-ownergrant.cjs's readOverrideGrant now reads
// a missing/unparseable `until` as an INVALID grant, never "unlimited" (closing a "credit-exhaustion re-arm
// silently stops working -> suppressed forever" gap). 30 days used to be ONLY the backstop `resolveGrantUntil`
// filled in when the owner omitted `--until` — an explicit LATER `--until` was accepted verbatim, which made
// the window effectively unbounded (an agent or a mistaken owner command could grant a suppression window of
// a year, a decade, anything parseable). Finding 5 makes 30 days the ABSOLUTE MAXIMUM any single grant may
// ever cover, default or explicit: the owner renews an about-to-expire override by running override-on again.
// Credit exhaustion stays the PRIMARY, expected re-arm path for ordinary use.
const DEFAULT_GRANT_MAX_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** resolveGrantUntil(rawUntil) -> { until, clamped }. `until` is ALWAYS a valid ISO-8601 string, NEVER
 *  null/empty (N12, 2026-09-24). A well-formed, parseable `rawUntil` that is AT OR BEFORE now+30d is
 *  returned unchanged (`clamped:false`); Finding 5 (2026-09-24): an explicit `rawUntil` LATER than now+30d is
 *  clamped DOWN to now+30d (`clamped:true`) rather than accepted verbatim — 30 days is the maximum window a
 *  single grant may cover, not merely a default. A missing or unparseable `rawUntil` gets the same bounded
 *  value (`clamped:false` — there was nothing explicit to clamp, this is simply the default) — see
 *  forge-ownergrant.cjs's readOverrideGrant for why a grant may never be written with no real expiry at all.
 *  The caller (usage-guard.cjs's runOverrideOn) is responsible for telling the owner when clamping happened.
 *  Pure (uses the current wall clock only), never throws. */
function resolveGrantUntil(rawUntil) {
  const maxMs = Date.now() + DEFAULT_GRANT_MAX_MS;
  const maxUntil = new Date(maxMs).toISOString();
  if (typeof rawUntil === 'string' && rawUntil) {
    const ms = Date.parse(rawUntil);
    if (Number.isFinite(ms)) return ms > maxMs ? { until: maxUntil, clamped: true } : { until: rawUntil, clamped: false };
  }
  return { until: maxUntil, clamped: false };
}

/** describeOverrideLockOutcome(kind, onLock, ctx) -> { line, partial } — the honest CLI status line for
 *  override-on/override-off's BEST-EFFORT cache/resume-bookkeeping lock step, called AFTER the authoritative
 *  grant action (publish for 'on', clear for 'off') has ALREADY succeeded (N11, 2026-09-24, Security Boss
 *  addendum reconfirmed — MEASURED DEFECTS `V15-override-on-lock-failure-status` and
 *  `V15-override-off-unlink-failure-status`: a lock/cache failure here used to be reported as "no change
 *  made" or plain success, both dishonest once the grant itself already took effect). `kind`: 'on' | 'off'.
 *  `onLock`: the `{ok, reason, value:{fenced, ...}}` shape withStateLock()/withLockedState() returns, OR —
 *  U01 (2026-09-24, Codex p12 wave 7) — `{ok:false, reason, bookkeepingThrew:true}` when the lock WAS
 *  acquired but a post-mutation bookkeeping step (a resume call, `writeState`) threw something other than
 *  the expected `EFENCED` reclaim signal; usage-guard.cjs's runOverrideOn()/runOverrideOff() catch that
 *  exception around their whole `withStateLock(...)` call and pass this shape in, rather than letting it
 *  escape uncaught (it used to reject past the point where the authoritative outcome gets reported at all).
 *  `ctx.until` ('on' only) is echoed in the full-success line. `partial:true` means the caller should print
 *  via `console.error` (a lagging-cache note, not a failure of the security-relevant action) and still exit
 *  0 — the grant action itself already succeeded either way, in EVERY `!onLock.ok` case including
 *  `bookkeepingThrew`. Pure, never throws. */
function describeOverrideLockOutcome(kind, onLock, ctx) {
  const o = ctx || {};
  if (kind === 'on') {
    const lag = ' — any previously paused agents may not have been resumed yet, and `status`\'s cached display may lag; the grant itself already took effect';
    if (!onLock.ok) {
      const detail = onLock.bookkeepingThrew
        ? 'override active, cache lagging — a post-mutation bookkeeping step raised an error after the state lock was already acquired (' + onLock.reason + ')'
        : 'the state lock could not be acquired for cache/resume bookkeeping (' + onLock.reason + ')';
      return { line: 'usage-guard OVERRIDE ON — the authoritative grant is ACTIVE (plan-limit guard suppressed) but ' + detail + lag, partial: true };
    }
    if (onLock.value.fenced) return { line: 'usage-guard OVERRIDE ON — the authoritative grant is ACTIVE (plan-limit guard suppressed) but the state lock was reclaimed mid-transaction (fenced) before cache/resume bookkeeping completed' + lag, partial: true };
    const { resumed, wasPaused } = onLock.value;
    return { line: 'usage-guard OVERRIDE ON — plan-limit guard suppressed' + (wasPaused ? ' · resumed ' + resumed + '/' + wasPaused + ' paused agent(s)' : '') + '; auto re-arm when credits exhausted or after ' + o.until, partial: false };
  }
  const lag = ' — `status`\'s cached display may lag';
  if (!onLock.ok) {
    const detail = onLock.bookkeepingThrew
      ? 'protection re-armed, cache lagging — a post-mutation bookkeeping step raised an error after the state lock was already acquired (' + onLock.reason + ')'
      : 'normal plan-limit guard re-armed (the authoritative grant is gone), but the state-lock cache bookkeeping failed (' + onLock.reason + ')';
    return { line: 'usage-guard OVERRIDE CLEARED — ' + detail + lag, partial: true };
  }
  if (onLock.value.fenced) return { line: 'usage-guard OVERRIDE CLEARED — normal plan-limit guard re-armed (the authoritative grant is gone), but the state lock was reclaimed mid-transaction (fenced) before cache bookkeeping completed' + lag, partial: true };
  return { line: 'usage-guard OVERRIDE ' + (onLock.value.had ? 'CLEARED' : 'was not set') + ' — normal plan-limit guard re-armed', partial: false };
}

module.exports = { resolveOwnerOverride, cachedOverrideFrom, resolveGrantUntil, describeOverrideLockOutcome };
