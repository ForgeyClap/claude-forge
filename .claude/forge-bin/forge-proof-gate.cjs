#!/usr/bin/env node
'use strict';
/**
 * forge-proof-gate.cjs — ONE shared "is this claim actually proven" predicate (V23 fix, second Codex
 * recheck 2026-09-24, out-p7.md).
 *
 * PROBLEM: log-event.cjs's own content oracle stamps `_forge_verify.proof_verified: false` on an event
 * whose OWN claim (an exit code, a proof artifact) it could not confirm. forge-runcontract.cjs's generic
 * `hasEvent()` already rejects such a disproven event before it can satisfy an event-present rule — but
 * two OTHER completion paths grew their own independent notion of "did this event's claim hold" and never
 * consulted that same fact: forge-runcontract.cjs's own independent-review protocol (`isGoedkeuring`) only
 * ever asked "is the verdict string positive", never "is this claim itself disproven"; forge-verify.cjs's
 * task-closure path (`taskStatus`, used by both the TASK_PAIRS merge and the closes_event_id RULE 2
 * closure) never checked it at all. REPRODUCED (out-p7.md): a `review_completed` stamped
 * `_forge_verify.proof_verified:false` still validated as an independent review; a disproven `check_passed`
 * still closed its task and returned verifier exit 0.
 *
 * This file is the ONE canonical definition both call sites now consult, so a future third path cannot
 * grow its own third copy that drifts from the other two. `forge-manifest.cjs` and `forge-runcontract.cjs`
 * already carried their own correct, independently-tested `eventIsDisproven` — those are UNCHANGED (low-
 * risk: don't touch working code outside this fix's scope) and behave identically to `isDisprovenEvent`
 * below; new consumers should prefer requiring this file instead of writing a fourth copy.
 *
 * isDisprovenEvent(e) -> boolean. Never throws; never true for a non-object/null input.
 */
function isDisprovenEvent(e) {
  return !!(e && typeof e === 'object' && e._forge_verify && e._forge_verify.proof_verified === false);
}

module.exports = { isDisprovenEvent };
