/**
 * ApprovalsMeta — real hard-gate evaluations for the active run
 * (`GET /api/approvals`, `gateway-recovery.ts`).
 *
 * A pending/blocked gate is a run-blocking state, so it sits in Mission
 * Control's own header next to RUN/ELAPSED/STARTED — not tucked into a
 * separate screen. Read-only: the gateway has no approve/deny route, so none
 * is offered here. `NOT REQUESTED` (no run selected) and `LIVE`-but-empty
 * (asked, found none) are kept visibly distinct — collapsing them would hide
 * a real signal.
 *
 * DESIGN FROZEN: reuses `MissionControlView.tsx`'s own existing
 * `.fw-mission__meta` / `.fw-mission__meta-item` / `.fw-mission__meta-key`
 * classes (mission.css) — the same pattern the RUN/ELAPSED/STARTED/GRAPH row
 * already uses. No new class, no new CSS file.
 */

import { useMemo } from 'react';
import { Machine, StatusBadge } from '@/components/primitives';
import type { GatewayApprovals, GatewayGateEvaluation } from '@/prototype/state/gateway-recovery';
import type { StatusKey } from '@/prototype/types/prototype-types';

// Module-private on purpose. Both helpers below are pure and have no caller outside this file
// (MissionControlView and the panel test import only the component), and exporting a non-component
// from a component module breaks React Fast Refresh for the whole file — the same reason
// `components/shell/nav-config.ts` exists as its own module. Nothing here needs a second file:
// dropping the unnecessary `export` is the smaller, honest fix.
function approvalStatus(evaluation: GatewayGateEvaluation): StatusKey {
  if (evaluation.ownerConfirmed === true) return 'completed';
  if (evaluation.eventType === 'quality_gate_blocked') return 'blocked';
  if (evaluation.eventType === 'quality_gate_passed') return 'completed';
  return 'waiting';
}

function worstApprovalStatus(evaluations: readonly GatewayGateEvaluation[]): StatusKey {
  if (evaluations.some((evaluation) => approvalStatus(evaluation) === 'blocked')) return 'blocked';
  if (evaluations.some((evaluation) => approvalStatus(evaluation) === 'waiting')) return 'waiting';
  return 'completed';
}

export interface ApprovalsMetaProps {
  readonly approvals: GatewayApprovals;
}

export function ApprovalsMeta({ approvals }: ApprovalsMetaProps) {
  const gateReasonById = useMemo(
    () => new Map(approvals.gates.map((gate) => [gate.id, gate.reason] as const)),
    [approvals.gates],
  );

  return (
    <div className="fw-mission__meta" aria-label="Approvals for this run">
      <span className="fw-mission__meta-item">
        <span className="fw-mission__meta-key">APPROVALS</span>
        {approvals.evaluationsProvenance === null ? (
          <Machine muted>—</Machine>
        ) : approvals.evaluationsProvenance === 'NOT REQUESTED' ? (
          <Machine muted>not requested</Machine>
        ) : approvals.evaluations.length === 0 ? (
          <Machine muted>none recorded</Machine>
        ) : (
          <StatusBadge status={worstApprovalStatus(approvals.evaluations)} size="sm" />
        )}
      </span>
      {approvals.evaluations.map((evaluation, index) => (
        <span
          key={`${evaluation.gateId ?? 'gate'}-${index}`}
          className="fw-mission__meta-item fw-mission__meta-item--wide"
          title={evaluation.gateId ? (gateReasonById.get(evaluation.gateId) ?? undefined) : undefined}
        >
          <span className="fw-mission__meta-key">{evaluation.gateId ?? 'GATE'}</span>
          <StatusBadge status={approvalStatus(evaluation)} size="sm" />
          {/*
            a11y-new: two bare values used to sit here with no key, breaking the one-key-one-value
            pattern this same file uses two lines up. Sighted readers infer "agent, then time" from
            position; a screen reader gets two unlabelled strings — and once either is absent, two
            unexplained dashes. The labels are visually hidden, so the frozen layout is untouched.
          */}
          <span className="fw-visually-hidden">Agent: </span>
          <Machine muted>{evaluation.agent ?? '—'}</Machine>
          <span className="fw-visually-hidden">Recorded at: </span>
          <Machine muted>{evaluation.timestamp ?? '—'}</Machine>
        </span>
      ))}
    </div>
  );
}

export default ApprovalsMeta;
