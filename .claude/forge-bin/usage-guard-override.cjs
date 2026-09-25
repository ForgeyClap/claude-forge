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
 * captured by `override-on` at grant time.
 *
 * FINAL POLICY (2026-09-24, Codex p13 out-p13 finding N10, wave 8 — REPLACES the wave-7 "grace tick"):
 * wave 7's rule was "the SAME new generation observed twice in a row (once unconfirmed, once again
 * unchanged) is promoted to confirmed" — Codex proved this is not evidence of anything: repeating an
 * unauthenticated observation of the SAME metadata never distinguishes a legitimate one-time refresh from a
 * permanently-stale profile parked on the wrong account (`N10_stale_profile_low_then_high`: usage 10% then
 * 100% then 100% produced ZERO pauses from the second tick on). That promotion path is gone. A grant whose
 * stamped `credentialGeneration` no longer matches the CURRENT one is honoured again in exactly two ways,
 * never a third:
 *   (a) MEMORY PROOF — this exact watcher PROCESS already confirmed some earlier generation for this same
 *       account, and `opts.credentialFp` (the bearer credential's own fingerprint — sha256 of the refresh
 *       token, computed by usage-guard.cjs's `fetchUsage()`/`readCredentialFp()` and held ONLY in that
 *       process's memory for this one comparison) is IDENTICAL to the fingerprint this module recorded in
 *       memory at the tick that confirmation happened. This is exactly what an ordinary OAuth access-token
 *       refresh looks like: the credentials FILE is rewritten (new mtime/size = new "generation"), but the
 *       refresh token inside it — and therefore its fingerprint — is unchanged. Proof, not repetition.
 *   (b) FRESH OWNER AUTHORIZATION — the owner reruns `override-on`, which stamps the grant's own
 *       `credentialGeneration` to whatever is CURRENT at that moment. The very next tick then sees
 *       `record.credentialGeneration === opts.credentialGeneration` directly (the trivial-match branch
 *       below) and never even reaches the memory-proof check.
 * The memory-proof baseline (`credentialProofByAccount`, a plain in-process `Map`, module-level, defined
 * below) is established the FIRST time an account's generation is seen to equal the grant's own stamp
 * (either right after a fresh override-on, or — for an already-running watcher — the first ordinary tick
 * after the grant was issued) and is advanced forward on every SUBSEQUENT proof-confirmed generation change.
 * It is NEVER written to disk, NEVER logged, and NEVER returned to a caller — see GUARD-TOKEN-FINGERPRINT
 * above. A WATCHER RESTART starts a brand-new process with an empty Map: no prior confirmation survives a
 * restart, so a generation that has already drifted away from the grant's own stamp by the time the watcher
 * comes back up requires fresh owner authorization again, exactly like a genuine rotation would (this also
 * closes Codex's M5-B note that a persisted "confirmed" flag would let a restart "preserve confirmation
 * rather than establish fresh identity" — there is no persisted flag left to preserve).
 *
 * Two further gaps the wave-7 code left open are also closed here: a CURRENT credential-file stamp that
 * cannot be read at all (`opts.credentialGeneration` absent/falsy — e.g. `.credentials.json` briefly
 * unreadable) used to silently skip the whole check and read as active; it is now an explicit refusal
 * (`rejected:'credential-generation-unavailable'`) — an unverifiable current state must never default to
 * "assume it still matches". A LEGACY grant written before this field existed at all
 * (`record.credentialGeneration` absent) used to be treated as exempt from the check entirely and read as
 * active; it is now also an explicit refusal (`rejected:'credential-generation-missing'`) — a plain,
 * one-time `override-on` re-stamps it and re-arms the grant with the current field.
 *
 * N10 RESIDUAL, WAVE 9 (2026-09-24, Codex p14 out-p14 finding N10 — "PARTLY CLOSED": ISSUANCE BINDING): wave
 * 8's memory-proof baseline (`credentialProofByAccount`) was keyed by account label ALONE — it had no idea
 * WHICH grant it had actually confirmed. Codex's `N10_reissued_grant_stale_watcher` exploited exactly that: a
 * watcher (W1) confirms account A's grant G1 under credential C1 (seeding the baseline with C1's fp); the
 * grant is then REPLACED with G2, bound to a DIFFERENT credential C2, while the profile label stays A (the
 * account-binding check alone cannot see this — it is still, correctly, "account A"); C1 later returns to
 * the credential file with new file metadata; W1's stale baseline — still only "account A" + "fp(C1)" —
 * matched and WRONGLY honoured G2, a grant W1 never actually confirmed. THE FIX: every grant now also carries
 * a random, non-secret `issuanceId` (forge-ownergrant.cjs's own field; `override-on` generates a fresh
 * `crypto.randomUUID()` on every write — never derived from anything credential-related). The in-memory
 * baseline stores it alongside the fp, and the memory-proof branch below now ALSO requires
 * `baseline.issuanceId === record.issuanceId`: a REPLACED grant (a different issuanceId) can never be
 * authorized by a baseline confirmed under an earlier issuance, no matter how the credential file's bytes
 * happen to line up later — the mismatch alone rejects it, with no need to proactively clear the stale Map
 * entry (a later trivial match against the NEW issuance simply overwrites it). A grant with NO issuanceId at
 * all (a pre-wave-9 legacy record, or a hand-written fixture) can likewise never receive memory proof —
 * `record.issuanceId` must itself be truthy for the memory-proof branch to even be considered, so such a
 * grant falls back to the trivial exact-generation-match path only, exactly like the credential-generation-
 * missing case already did for a field that predates ITS OWN introduction.
 *
 * HONEST LIMITATION (documented, not hidden): this is still a non-secret, best-effort signal, not a
 * cryptographic proof of account identity — a credential's own refresh-token fingerprint is a real bearer
 * secret's derivative and is trustworthy evidence that "the same login session is still in control", but it
 * says nothing about whether Anthropic's own token-refresh flow ever ROTATES the refresh token itself on an
 * ordinary refresh (UNKNOWN to this codebase, not verified against live behaviour) — if it does, an entirely
 * ordinary refresh would be indistinguishable from a real account switch and would correctly, if
 * conservatively, require the owner to run `override-on` again more often than strictly necessary. That is
 * the safe direction for this trade-off to fail in.
 */
// credentialProofByAccount (2026-09-24, Codex p13 wave 8; ISSUANCE-BOUND wave 9) — IN-PROCESS-ONLY memory of
// the last credential fingerprint this watcher process itself observed at the tick it confirmed a given
// account's generation, and (wave 9, N10 residual) the specific grant `issuanceId` that confirmation was
// established under. Keyed by the OPAQUE local account label (never a raw fingerprint/uuid), never persisted
// to disk, never logged, never returned from resolveOwnerOverride() to any caller. Lost on every process
// restart BY DESIGN — see the FINAL POLICY note above for why that is the correct, safe behaviour, not a bug.
let credentialProofByAccount = new Map();
/** __resetCredentialProofForTests() -> void. Test-only seam (mirrors this module's sibling
 *  __setOwnerGrantRootForTests convention in usage-guard.cjs): clears the in-memory Map above, simulating a
 *  watcher restart so a test can prove "no prior confirmation survives a restart" deterministically instead
 *  of needing a real second OS process for every such scenario. Production code never calls this. */
function __resetCredentialProofForTests() { credentialProofByAccount = new Map(); }
/** rememberCredentialProof(accountLabel, issuanceId, generation, fp) -> void. Only ever stores a REAL,
 *  non-empty fingerprint — a tick where the credential file could not be read at all (fp null/absent) leaves
 *  whatever baseline already existed untouched rather than overwriting known-good evidence with "nothing".
 *  `issuanceId` (wave 9, N10 residual) is stored VERBATIM alongside the fp — including `null`/`undefined`
 *  when the confirmed record carried none — so a later comparison against a DIFFERENT (or likewise-absent)
 *  issuance can never accidentally match; see resolveOwnerOverride's own doc comment for how this is used.
 *  Pure side effect on the module-level Map only; never throws. */
function rememberCredentialProof(accountLabel, issuanceId, generation, fp) {
  if (typeof fp === 'string' && fp) credentialProofByAccount.set(accountLabel, { issuanceId: issuanceId || null, generation, credentialFp: fp });
}
const guardGrant = require('./forge-ownergrant.cjs');
const guardRedact = require('./usage-guard-redact.cjs');

/** resolveOwnerOverride(opts) -> { active, record, rejected, currentGeneration? }. `active` is the ONLY
 *  value any caller may use to decide whether to suppress pausing — never state.json's own cached
 *  `ownerOverride.active`. `opts.projectRoot` must be the SAME trusted root usage-guard.cjs already anchors
 *  override-on/verifyForcedWatchGrant to (its module-level `TRUSTED_OWNERGRANT_ROOT` — never an
 *  environment-selected root; see that file's own N06 history for why). `opts.accountLabel` (N10,
 *  2026-09-24) is the CURRENT opaque local identity label the caller is deciding for; a grant is honoured
 *  ONLY when this exactly matches the grant's own `accountLabel`. `opts.credentialGeneration` (N10 residual,
 *  2026-09-24) is the current credential FILE's mtime+size stamp; `opts.credentialFp` (wave 8, 2026-09-24 —
 *  see the file header's FINAL POLICY note) is the current bearer credential's own fingerprint, kept ONLY in
 *  the caller's memory and used here SOLELY for the in-process memory-proof comparison — never persisted,
 *  never logged, never present anywhere in this function's return value. `rejected` is `null` when there is
 *  simply no active grant at all (absent/expired/invalid-expiry — the ordinary, unremarkable case), or one of
 *  `'unknown-identity'` | `'label-less-grant'` | `'foreign-account'` | `'credential-generation-missing'` |
 *  `'credential-generation-unavailable'` | `'credential-generation-unconfirmed'` when a real, otherwise-active
 *  grant was refused specifically because it could not be verified against the current account/credential —
 *  callers may use this to log a more specific reason (account labels and generation stamps are non-secret
 *  and safe to log; a fingerprint/uuid/token never is). `currentGeneration` is set only on a
 *  `'credential-generation-unconfirmed'` rejection. Never throws. */
function resolveOwnerOverride(opts) {
  const o = opts || {};
  const record = guardGrant.readOverrideGrant(o);
  if (record.active !== true) return { active: false, record, rejected: null };
  const current = typeof o.accountLabel === 'string' && o.accountLabel ? o.accountLabel : null;
  if (!current) return { active: false, record, rejected: 'unknown-identity' };
  if (typeof record.accountLabel !== 'string' || !record.accountLabel) return { active: false, record, rejected: 'label-less-grant' };
  if (record.accountLabel !== current) return { active: false, record, rejected: 'foreign-account' };
  // N10 residual / wave 8: the profile-derived label matched, but the credential FILE's own generation must
  // ALSO be verifiable and match (directly, or via in-memory proof) — see the file header's FINAL POLICY.
  const grantGen = typeof record.credentialGeneration === 'string' && record.credentialGeneration ? record.credentialGeneration : null;
  if (!grantGen) return { active: false, record, rejected: 'credential-generation-missing' };
  const curGen = typeof o.credentialGeneration === 'string' && o.credentialGeneration ? o.credentialGeneration : null;
  if (!curGen) return { active: false, record, rejected: 'credential-generation-unavailable' };
  const curFp = typeof o.credentialFp === 'string' && o.credentialFp ? o.credentialFp : null;
  if (grantGen === curGen) {
    // trivial match — nothing has changed since the grant was issued/last re-stamped by override-on. This
    // is also the ONLY place a fresh owner authorization (b) ever takes effect: override-on always stamps
    // the CURRENT generation, so its very next tick lands here directly, never through the proof check below.
    // wave 9 (N10 residual): the baseline is bound to THIS record's own issuanceId (verbatim, including
    // null/undefined for a pre-wave-9 legacy grant) — see rememberCredentialProof's own doc comment.
    rememberCredentialProof(current, record.issuanceId, curGen, curFp);
    return { active: true, record };
  }
  // The generation changed since the grant was issued/last confirmed. Honoured again ONLY via memory proof
  // (a) — see the file header. No proof, no baseline at all (first-ever mismatch this process has seen for
  // this account — including right after a restart), OR a baseline confirmed under a DIFFERENT grant
  // issuance than the one currently on file (N10 residual, wave 9 — see the file header's own section for
  // this: a REPLACED grant must never be authorized by a baseline a stale watcher confirmed under an
  // earlier, now-superseded issuance) all fail toward pausing. `record.issuanceId` must itself be truthy for
  // this branch to even be considered — a grant with no issuanceId at all (pre-wave-9) never gets memory
  // proof, exact-match only.
  const baseline = credentialProofByAccount.get(current);
  if (baseline && curFp && record.issuanceId && baseline.issuanceId === record.issuanceId && baseline.credentialFp === curFp) {
    rememberCredentialProof(current, record.issuanceId, curGen, curFp);
    return { active: true, record };
  }
  return { active: false, record, rejected: 'credential-generation-unconfirmed', currentGeneration: curGen };
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
 *  `ctx.until` ('on' only) is echoed in the full-success line. `onLock.value.pending` ('on' only, N17
 *  residual, wave 9, 2026-09-24, Codex p14 out-p14) is the count of agents runOverrideOn's own resume loop
 *  could NOT resume this round (still genuinely paused, never silently dropped) — when non-zero this prints
 *  an explicit "could not be resumed yet ... retries every tick" note and the line counts as `partial:true`
 *  (worth a caller's `console.error`), even though the grant itself is fully active either way. `partial:true`
 *  means the caller should print via `console.error` (an operationally-incomplete note, never a failure of
 *  the security-relevant action itself) and still exit 0 — the grant action itself already succeeded either
 *  way, in EVERY `!onLock.ok` case including `bookkeepingThrew`, and in the pending-resume case too. Pure,
 *  never throws. */
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
    const { resumed, wasPaused, pending } = onLock.value;
    // N17 residual, wave 9: never claim a still-paused agent was resumed — name the exact count and say
    // plainly that the watcher retries every tick, rather than only the generic 'resumed X/Y' count above.
    const pendingNote = pending ? (' · ' + pending + ' agent(s) could not be resumed yet — the watcher retries every tick') : '';
    return {
      line: 'usage-guard OVERRIDE ON — plan-limit guard suppressed' + (wasPaused ? ' · resumed ' + resumed + '/' + wasPaused + ' paused agent(s)' : '') + pendingNote + '; auto re-arm when credits exhausted or after ' + o.until,
      partial: !!pending,
    };
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

module.exports = {
  resolveOwnerOverride, cachedOverrideFrom, resolveGrantUntil, describeOverrideLockOutcome,
  __resetCredentialProofForTests,
};
