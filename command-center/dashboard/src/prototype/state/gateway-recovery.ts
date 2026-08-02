/**
 * Forge Command Center — recovery / checkpoints / approvals.
 *
 * Exposes the 3 real, tested gateway endpoints (`GET /api/recovery`,
 * `GET /api/checkpoints`, `GET /api/approvals`). Mounted (wire-recovery,
 * forge-2026-07-29-cc-finish): `useGatewayApprovals` feeds Mission Control's
 * header (`MissionControlView.tsx`) — a pending/blocked gate evaluation is a
 * run-blocking state, so it belongs on the run graph surface; `useGatewayRecovery`
 * and `useGatewayCheckpoints` feed a new Activity panel (`ActivityView.tsx`)
 * next to the event timeline they are themselves a kind of history for. Not
 * wired into `PrototypeDataset` (`gateway-adapter.ts`) — that file stays out of
 * this WP's write scope, so each view calls its own hook directly, the same
 * established pattern `AccountUsagePressure.tsx`/`ClaudeCodeChip.tsx` already use
 * for gateway data that never joined the shared dataset shape.
 *
 * Same three honesty rules as every other file in this seam: never fabricate
 * a row, never fabricate a status, an unknown field is absence, not an
 * invented default.
 *
 * `recoveryAttempts` stays an untyped passthrough (`Record<string,
 * unknown>[]`) rather than a typed row shape — the gateway's own
 * `recovery.mjs` makes no promise about their internal shape (they are
 * operator-authored JSONL log lines per `GLOBAL_RESEARCH_RECOVERY_POLICY.md`,
 * not a fixed schema) — mirrors `gateway-adapter.ts`'s own `useGatewayEvents`
 * doing the same for raw run events.
 */

import { useEffect, useState } from 'react';

import { gwGet, pickArray, pickBool, pickNumber, pickRecord, pickString, pickStringArray } from '@/prototype/state/gateway-client';

const POLL_MS = 15000;

/* ========================================================================== */
/*  1. Recovery — GET /api/recovery                                          */
/* ========================================================================== */

export interface GatewayDocdriftFinding {
  readonly ruleId: string;
  readonly drifted: boolean;
  readonly lastStatus: string | null;
  readonly lastChecked: string | null;
}

export interface GatewayRecovery {
  readonly ok: boolean;
  readonly recoveryAttempts: readonly Record<string, unknown>[];
  readonly recoveryAttemptsCount: number;
  readonly recoveryProvenance: string | null;
  readonly docdriftLastCheck: string | null;
  readonly docdriftSources: readonly string[];
  readonly docdriftFindings: readonly GatewayDocdriftFinding[];
  readonly docdriftFindingsCount: number;
  readonly docdriftDriftedCount: number;
  readonly docdriftProvenance: string | null;
}

export const EMPTY_GATEWAY_RECOVERY: GatewayRecovery = {
  ok: false,
  recoveryAttempts: [],
  recoveryAttemptsCount: 0,
  recoveryProvenance: null,
  docdriftLastCheck: null,
  docdriftSources: [],
  docdriftFindings: [],
  docdriftFindingsCount: 0,
  docdriftDriftedCount: 0,
  docdriftProvenance: null,
};

function toDocdriftFinding(row: Record<string, unknown>): GatewayDocdriftFinding {
  return {
    ruleId: pickString(row, ['rule_id']) ?? '',
    drifted: pickBool(row, ['drifted']) ?? false,
    lastStatus: pickString(row, ['last_status']),
    lastChecked: pickString(row, ['last_checked']),
  };
}

/** Maps `GET /api/recovery`'s real response 1:1 — every field is real, derived
 *  from a real response, or explicitly absent (never invented). */
export function parseGatewayRecovery(data: Record<string, unknown>): GatewayRecovery {
  const docdrift = pickRecord(data, ['docdrift']);
  return {
    ok: pickBool(data, ['ok']) ?? false,
    recoveryAttempts: pickArray(data, ['recovery_attempts']),
    recoveryAttemptsCount: pickNumber(data, ['recovery_attempts_count']) ?? 0,
    recoveryProvenance: pickString(data, ['recovery_provenance']),
    docdriftLastCheck: docdrift !== null ? pickString(docdrift, ['last_check']) : null,
    docdriftSources: docdrift !== null ? pickStringArray(docdrift, ['sources']) : [],
    docdriftFindings: docdrift !== null ? pickArray(docdrift, ['findings']).map(toDocdriftFinding) : [],
    docdriftFindingsCount: docdrift !== null ? pickNumber(docdrift, ['findings_count']) ?? 0 : 0,
    docdriftDriftedCount: docdrift !== null ? pickNumber(docdrift, ['drifted_count']) ?? 0 : 0,
    docdriftProvenance: docdrift !== null ? pickString(docdrift, ['provenance']) : null,
  };
}

/** Polls the selected project's recovery/docdrift state. Mounted in
 *  `ActivityView.tsx` (see this file's header).
 *
 *  Keyed by `projectName` (fix-crossproject, forge-2026-07-29-cc-finish),
 *  mirroring `useGatewayApprovals` below: a project switch must never keep
 *  showing the PREVIOUS project's rows under the new project's name in the
 *  panel header. Without the key, a plain `setRecovery` would (a) still show
 *  the stale project's rows for up to one `POLL_MS` after the switch, and
 *  (b) show them FOREVER if the new project's own `?project=` request fails,
 *  because the early `!result.ok` return left the old state untouched. Gating
 *  the read on `state.key === projectName` makes a still-in-flight or failed
 *  fetch for the new project read as the honest empty constant instead of
 *  attributing the old project's drift to the new one. */
export function useGatewayRecovery(projectName: string): GatewayRecovery {
  const [state, setState] = useState<{ readonly key: string; readonly value: GatewayRecovery }>({
    key: '',
    value: EMPTY_GATEWAY_RECOVERY,
  });

  useEffect(() => {
    if (projectName === '') return undefined;
    let cancelled = false;
    async function tick(): Promise<void> {
      const result = await gwGet(`/api/recovery?project=${encodeURIComponent(projectName)}`);
      if (cancelled || !result.ok) return;
      setState({ key: projectName, value: parseGatewayRecovery(result.data) });
    }
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [projectName]);

  return state.key === projectName ? state.value : EMPTY_GATEWAY_RECOVERY;
}

/* ========================================================================== */
/*  2. Checkpoints — GET /api/checkpoints                                    */
/* ========================================================================== */

export interface GatewayRunManifest {
  readonly runId: string;
  readonly manifestPresent: boolean;
  readonly manifest: Record<string, unknown> | null;
}

export interface GatewayCheckpoints {
  readonly ok: boolean;
  readonly resumeAvailable: boolean;
  readonly resumeNote: string | null;
  readonly resumeData: Record<string, unknown> | null;
  readonly runsWithManifest: readonly GatewayRunManifest[];
  readonly runsWithManifestCount: number;
  readonly provenance: string | null;
}

export const EMPTY_GATEWAY_CHECKPOINTS: GatewayCheckpoints = {
  ok: false,
  resumeAvailable: false,
  resumeNote: null,
  resumeData: null,
  runsWithManifest: [],
  runsWithManifestCount: 0,
  provenance: null,
};

/** Maps `GET /api/checkpoints`'s real response 1:1. In this fleet today both
 *  `resume_state` and every run's own manifest are honestly absent — verified
 *  live, not assumed (see the WP8 forge-report this WP inherited). */
export function parseGatewayCheckpoints(data: Record<string, unknown>): GatewayCheckpoints {
  const resumeState = pickRecord(data, ['resume_state']);
  return {
    ok: pickBool(data, ['ok']) ?? false,
    resumeAvailable: resumeState !== null ? (pickBool(resumeState, ['available']) ?? false) : false,
    resumeNote: resumeState !== null ? pickString(resumeState, ['note']) : null,
    resumeData: resumeState !== null ? pickRecord(resumeState, ['data']) : null,
    runsWithManifest: pickArray(data, ['runs_with_manifest']).map((row) => ({
      runId: pickString(row, ['run_id']) ?? '',
      manifestPresent: pickBool(row, ['manifest_present']) ?? false,
      manifest: pickRecord(row, ['manifest']),
    })),
    runsWithManifestCount: pickNumber(data, ['runs_with_manifest_count']) ?? 0,
    provenance: pickString(data, ['provenance']),
  };
}

/** Polls the selected project's checkpoint/resume state. Mounted in
 *  `ActivityView.tsx` (see this file's header).
 *
 *  Keyed by `projectName` (fix-crossproject, forge-2026-07-29-cc-finish) —
 *  same rationale as `useGatewayRecovery` above: an ungated `setCheckpoints`
 *  would keep the previous project's resume/manifest rows on screen under the
 *  new project's header, permanently if the new project's request fails. */
export function useGatewayCheckpoints(projectName: string): GatewayCheckpoints {
  const [state, setState] = useState<{ readonly key: string; readonly value: GatewayCheckpoints }>({
    key: '',
    value: EMPTY_GATEWAY_CHECKPOINTS,
  });

  useEffect(() => {
    if (projectName === '') return undefined;
    let cancelled = false;
    async function tick(): Promise<void> {
      const result = await gwGet(`/api/checkpoints?project=${encodeURIComponent(projectName)}`);
      if (cancelled || !result.ok) return;
      setState({ key: projectName, value: parseGatewayCheckpoints(result.data) });
    }
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [projectName]);

  return state.key === projectName ? state.value : EMPTY_GATEWAY_CHECKPOINTS;
}

/* ========================================================================== */
/*  3. Approvals — GET /api/approvals                                        */
/* ========================================================================== */

export interface GatewayHardGate {
  readonly id: string | null;
  readonly class: string | null;
  readonly reason: string | null;
}

export interface GatewayGateEvaluation {
  readonly eventType: string | null;
  readonly gateId: string | null;
  readonly agent: string | null;
  readonly role: string | null;
  readonly ownerConfirmed: boolean | null;
  readonly reason: string | null;
  readonly timestamp: string | null;
}

export interface GatewayApprovals {
  readonly ok: boolean;
  readonly gates: readonly GatewayHardGate[];
  readonly gatesCount: number;
  readonly gatesProvenance: string | null;
  readonly evaluations: readonly GatewayGateEvaluation[];
  readonly evaluationsCount: number;
  /** `'NOT REQUESTED'` when no `?run=` was given — distinct from "asked, found
   *  none" (`'LIVE'` with an empty array). Never conflated. */
  readonly evaluationsProvenance: string | null;
}

export const EMPTY_GATEWAY_APPROVALS: GatewayApprovals = {
  ok: false,
  gates: [],
  gatesCount: 0,
  gatesProvenance: null,
  evaluations: [],
  evaluationsCount: 0,
  evaluationsProvenance: null,
};

/** Maps `GET /api/approvals`'s real response 1:1 — the 10 real hard-gate
 *  definitions plus whatever gate-evaluation events the selected run's own
 *  events.jsonl actually recorded. */
export function parseGatewayApprovals(data: Record<string, unknown>): GatewayApprovals {
  return {
    ok: pickBool(data, ['ok']) ?? false,
    gates: pickArray(data, ['gates']).map((row) => ({
      id: pickString(row, ['id']),
      class: pickString(row, ['class']),
      reason: pickString(row, ['reason']),
    })),
    gatesCount: pickNumber(data, ['gates_count']) ?? 0,
    gatesProvenance: pickString(data, ['gates_provenance']),
    evaluations: pickArray(data, ['evaluations']).map((row) => ({
      eventType: pickString(row, ['event_type']),
      gateId: pickString(row, ['gate_id']),
      agent: pickString(row, ['agent']),
      role: pickString(row, ['role']),
      ownerConfirmed: pickBool(row, ['owner_confirmed']),
      reason: pickString(row, ['reason']),
      timestamp: pickString(row, ['timestamp']),
    })),
    evaluationsCount: pickNumber(data, ['evaluations_count']) ?? 0,
    evaluationsProvenance: pickString(data, ['evaluations_provenance']),
  };
}

function approvalsKey(projectName: string, runId: string | null): string {
  return `${projectName}::${runId ?? ''}`;
}

/** Polls the selected project's (and, once a run is selected, that run's own)
 *  hard-gate definitions + evaluations. Mounted in `MissionControlView.tsx`
 *  (see this file's header). */
export function useGatewayApprovals(projectName: string, runId: string | null): GatewayApprovals {
  const [state, setState] = useState<{ readonly key: string; readonly value: GatewayApprovals }>({
    key: '',
    value: EMPTY_GATEWAY_APPROVALS,
  });

  useEffect(() => {
    if (projectName === '') return undefined;
    const key = approvalsKey(projectName, runId);
    let cancelled = false;
    async function tick(): Promise<void> {
      const query =
        runId !== null
          ? `project=${encodeURIComponent(projectName)}&run=${encodeURIComponent(runId)}`
          : `project=${encodeURIComponent(projectName)}`;
      const result = await gwGet(`/api/approvals?${query}`);
      if (cancelled || !result.ok) return;
      setState({ key, value: parseGatewayApprovals(result.data) });
    }
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [projectName, runId]);

  return state.key === approvalsKey(projectName, runId) ? state.value : EMPTY_GATEWAY_APPROVALS;
}
