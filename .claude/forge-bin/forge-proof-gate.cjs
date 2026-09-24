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

/**
 * reviewOutcome(e) -> 'done' | 'failed' | null. ONE shared boolean-aware review-outcome contract (V24
 * REGRESSION fix, 2026-09-24 THIRD Codex recheck, out-p8.md).
 *
 * PROBLEM: forge-verify.cjs's own V24 fix (out-p7.md) added `ok` to its outcome-field list and then
 * delegated the actual verdict to forge-runcontract.cjs's `isGoedkeuring()` — but `isGoedkeuring()` is a
 * DIFFERENT, deliberately stricter protocol (the independent-review gate) that requires an explicit textual
 * verdict field (`review_verdict`/`verdict`/`status`/`result`/`outcome`) to be PRESENT at all; a bare
 * `{event_type:'review_completed', ok:true}` has none of those, so `isGoedkeuring()` returned
 * `{ok:false, reden:'geen machineleesbaar review_verdict'}` and forge-verify.cjs's `taskStatus()` regressed
 * a previously-DONE boolean-only positive review to FAILED. app.js's own hand-mirrored `reviewOutcome()` was
 * never changed this way and still correctly returned 'done' for the same event — the two consumers
 * disagreed about the identical event (out-p8.md V24).
 *
 * This is the ONE canonical boolean-aware contract both consumers use:
 *   - a positive TEXTUAL verdict (any of the 5 fields, case-insensitively one of pass/passed/approved/ok/
 *     akkoord/goedgekeurd) with no `ok` field, or with `ok:true` too -> 'done';
 *   - `ok:false` alone (no textual verdict at all) -> 'failed' — the pre-wave-2 baseline this fix restores;
 *   - a negative/empty textual verdict -> 'failed', regardless of `ok`;
 *   - a positive textual verdict CONTRADICTED by `ok:false` -> 'failed' (the contradiction wins, never the
 *     more optimistic of the two signals);
 *   - a disproven claim (log-event.cjs's own content-oracle `_forge_verify.proof_verified:false` stamp) ->
 *     'failed', checked FIRST, before any verdict/ok reading — a refuted claim is not evidence of anything,
 *     whatever verdict string or `ok` value it also carries;
 *   - no outcome signal asserted at all (neither a textual verdict field nor `ok`) -> null, so the caller
 *     falls through to its own ordinary default (a legacy/minimal event is not penalised for a field it
 *     never had).
 *
 * Never throws; never true/'done'/'failed' for a non-object/null input (returns null).
 */
const REVIEW_OUTCOME_FIELDS = ['review_verdict', 'verdict', 'status', 'result', 'outcome'];
const POSITIVE_REVIEW_VERDICTS = new Set(['pass', 'passed', 'approved', 'ok', 'akkoord', 'goedgekeurd']);
function reviewOutcome(e) {
  if (!e || typeof e !== 'object') return null;
  if (isDisprovenEvent(e)) return 'failed';
  const norm = (a) => String(a == null ? '' : a).trim().toLowerCase();
  const present = REVIEW_OUTCOME_FIELDS.filter((f) => e[f] !== undefined).map((f) => norm(e[f]));
  const hasOk = e.ok !== undefined;
  if (!present.length && !hasOk) return null; // no outcome asserted at all — caller uses its own default
  if (present.some((v) => v === '')) return 'failed'; // present but empty is not an approval
  if (present.some((v) => !POSITIVE_REVIEW_VERDICTS.has(v))) return 'failed';
  if (hasOk && e.ok !== true) return 'failed'; // ok:false always wins over a positive textual verdict
  return 'done'; // either a positive textual verdict, or ok:true alone with no textual verdict at all
}

module.exports = { isDisprovenEvent, reviewOutcome, REVIEW_OUTCOME_FIELDS, POSITIVE_REVIEW_VERDICTS };
