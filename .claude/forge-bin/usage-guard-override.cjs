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
 * decision. Instead, derive it FRESH, every tick, from an independent, single-writer, expiry-aware record
 * (forge-ownergrant.cjs's readOverrideGrant/writeOverrideGrant) that ONLY the `override-on`/`override-off`
 * CLI commands ever write — never the watcher's own tick(). A stale writer that manages to resurrect
 * state.json's cached `ownerOverride.active:true` can no longer suppress pausing on its own: the grant file
 * is checked too, and an absent/expired grant means the override is OFF regardless of what the cache says.
 * The cache is still written (for `status`'s display and for credits-mode bookkeeping), but it is always
 * written FROM the grant's fresh read, never the other way around.
 */
const guardGrant = require('./forge-ownergrant.cjs');

/** resolveOwnerOverride(opts) -> { active, record }. `active` is the ONLY value any caller may use to
 *  decide whether to suppress pausing — never state.json's own cached `ownerOverride.active`.
 *  `opts.projectRoot` must be the SAME trusted root usage-guard.cjs already anchors
 *  override-on/verifyForcedWatchGrant to (its module-level `TRUSTED_OWNERGRANT_ROOT` — never an
 *  environment-selected root; see that file's own N06 history for why). Never throws. */
function resolveOwnerOverride(opts) {
  const record = guardGrant.readOverrideGrant(opts);
  return { active: record.active === true, record };
}

/** cachedOverrideFrom(record) -> the object usage-guard.cjs should write into state.ownerOverride to keep
 *  it informative for `status`'s display and for the `reArmWhenCreditsExhausted` credits-mode convention —
 *  always DERIVED from the fresh grant record, never a pass-through of whatever a stale writer may have
 *  left behind in the cache. Returns `undefined` when inactive, so a caller can `delete`/omit the field
 *  cleanly. Pure, never throws. */
function cachedOverrideFrom(record) {
  if (!record || record.active !== true) return undefined;
  return {
    active: true,
    at: record.at || new Date().toISOString(),
    reason: record.reason || null,
    until: record.until || null,
    reArmWhenCreditsExhausted: true,
  };
}

module.exports = { resolveOwnerOverride, cachedOverrideFrom };
