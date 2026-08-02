/**
 * Forge Command Center — gateway adapter, mission graph + proof/gates/artifacts slice
 * (WP refactor-adapter-split).
 *
 * Split out of the single `gateway-adapter.ts` (was ~2400 lines) into its already-marked
 * "6. Mission graph" + "7. Proof ledger + quality gates + artifacts" sections, verbatim — see that
 * file's own header for the full architecture/history/honesty rules this slice still follows.
 * `parseDoctorHealth` moved here too: it was textually sitting under the original file's "8c.
 * Chat-runs" section header even though it parses a `/api/proof` payload, not a chat-run — a
 * mislabeling from a header never having been added when it was written, not a real chat-runs
 * concern. It reads naturally alongside `toGatewayProof`/`toGatewayGate`/`toGatewayArtifact` here,
 * which already parse the same `/api/proof` shape. `buildGatewayMissionGraph` and `toGatewayProof`
 * gained an `export` keyword they did not have in the single-file version, purely so `dataset.ts`
 * can call them across a file boundary — `gateway-adapter.ts`'s own public re-export list is
 * unchanged either way, since neither was part of it.
 */

import type { Artifact, GraphEdge, GraphLane, GraphNode, MissionGraph, ProofEntry, QualityGate, StatusKey } from '@/prototype/types/prototype-types';

import { pickArray, pickBool, pickNumber, pickString } from '@/prototype/state/gateway-client';
import { formatFileBytes } from '@/prototype/state/gateway-files';

import { EMPTY_GRAPH, STATUS_WHEN_UNKNOWN } from './shared';
import { toStatusKey, type MissionPayload, type MissionTaskRow } from './rows';

/* ========================================================================== */
/*  6. Mission graph — built from the ALREADY-GROUPED /api/missions payload   */
/* ========================================================================== */

const REQUEST_COL = 0;
const BOSS_COL = 1;
const LANE_START_COL = 2;

export function buildGatewayMissionGraph(runId: string, mission: MissionPayload | null, hasFinalReport: boolean): MissionGraph {
  if (mission === null) return EMPTY_GRAPH;

  const laneAgents: string[] = [];
  const tasksByAgent = new Map<string, MissionTaskRow[]>();
  for (const t of [...mission.tasks].sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''))) {
    const key = t.agent ?? ' unassigned';
    if (!tasksByAgent.has(key)) {
      tasksByAgent.set(key, []);
      laneAgents.push(key);
    }
    tasksByAgent.get(key)!.push(t);
  }

  const anyFailed = mission.verdicts.some((v) => v.eventType === 'check_failed');
  const anyPassed = mission.verdicts.some((v) => v.eventType === 'check_passed');
  const verifyPresent = anyFailed || anyPassed;
  const outputPresent = hasFinalReport;

  const laneCount = laneAgents.length;
  const spineRow = laneCount > 0 ? (laneCount - 1) / 2 : 0;
  const maxTasks = laneAgents.reduce((m, key) => Math.max(m, tasksByAgent.get(key)!.length), 0);
  let tailCol = LANE_START_COL + maxTasks;
  const verifyCol = verifyPresent ? tailCol++ : null;
  const outputCol = outputPresent ? tailCol++ : null;

  const nodes: GraphNode[] = [];
  const lanes: GraphLane[] = [];
  const laneNodeIds = new Map<string, string[]>();

  const makeNode = (n: Omit<GraphNode, 'prototype'>): GraphNode => n as unknown as GraphNode;
  const makeLane = (l: Omit<GraphLane, 'prototype'>): GraphLane => l as unknown as GraphLane;
  const makeEdge = (e: Omit<GraphEdge, 'prototype'>): GraphEdge => e as unknown as GraphEdge;

  const requestId = `${runId}::request`;
  nodes.push(makeNode({ id: requestId, label: 'Request', kind: 'request', status: 'completed', col: REQUEST_COL, row: spineRow, laneId: null }));

  const bossId = `${runId}::boss`;
  const bossStatus: StatusKey = anyFailed ? 'failed' : outputPresent ? 'completed' : mission.tasks.some((t) => t.status === 'running') ? 'running' : STATUS_WHEN_UNKNOWN;
  nodes.push(makeNode({ id: bossId, label: 'Boss', kind: 'boss', status: bossStatus, col: BOSS_COL, row: spineRow, laneId: null }));

  laneAgents.forEach((agentKey, row) => {
    const laneId = `${runId}::lane::${agentKey}`;
    lanes.push(makeLane({ id: laneId, label: agentKey === ' unassigned' ? 'unassigned' : agentKey, group: 'execution' }));
    const ids: string[] = [];
    tasksByAgent.get(agentKey)!.forEach((t, col) => {
      const stepId = `${runId}::task::${t.dispatchId ?? `${agentKey}-${col}`}`;
      nodes.push(
        makeNode({
          id: stepId,
          label: t.task ?? t.role ?? agentKey,
          kind: 'step',
          status: toStatusKey(t.status),
          col: LANE_START_COL + col,
          row,
          laneId,
          ...(agentKey !== ' unassigned' ? { agent: agentKey } : {}),
        }),
      );
      ids.push(stepId);
    });
    laneNodeIds.set(agentKey, ids);
  });

  const verifyId = `${runId}::verify`;
  if (verifyCol !== null) {
    nodes.push(makeNode({ id: verifyId, label: 'Verify', kind: 'verify', status: anyFailed ? 'failed' : 'completed', col: verifyCol, row: spineRow, laneId: null }));
  }
  const outputId = `${runId}::output`;
  if (outputCol !== null) {
    nodes.push(makeNode({ id: outputId, label: 'Output', kind: 'output', status: 'completed', col: outputCol, row: spineRow, laneId: null }));
  }

  const edges: GraphEdge[] = [];
  let edgeIndex = 0;
  const addEdge = (from: string, to: string): void => {
    edges.push(makeEdge({ id: `${runId}::e${edgeIndex++}`, from, to, kind: 'flow' }));
  };
  const tailIds = [verifyCol !== null ? verifyId : null, outputCol !== null ? outputId : null].filter((id): id is string => id !== null);
  const firstTailId = tailIds[0] ?? null;

  addEdge(requestId, bossId);
  if (laneAgents.length > 0) {
    for (const agentKey of laneAgents) {
      const ids = laneNodeIds.get(agentKey) ?? [];
      if (ids.length === 0) continue;
      addEdge(bossId, ids[0]);
      for (let i = 0; i < ids.length - 1; i += 1) addEdge(ids[i], ids[i + 1]);
      if (firstTailId !== null) addEdge(ids[ids.length - 1], firstTailId);
    }
  } else if (firstTailId !== null) {
    addEdge(bossId, firstTailId);
  }
  for (let i = 0; i < tailIds.length - 1; i += 1) addEdge(tailIds[i], tailIds[i + 1]);

  return { id: `${runId}::graph`, runId, lanes, nodes, edges } as unknown as MissionGraph;
}

/* ========================================================================== */
/*  7. Proof ledger + quality gates + artifacts (`/api/proof`)                */
/* ========================================================================== */

export function toGatewayProof(row: Record<string, unknown>, index: number): ProofEntry {
  const source = pickString(row, ['source']);
  const isEvent = source === 'event';
  const eventType = pickString(row, ['event_type']);
  const verdict: ProofEntry['verdict'] = isEvent ? (eventType === 'check_passed' ? 'accepted' : 'rejected') : (pickBool(row, ['ok']) ? 'accepted' : 'rejected');
  const command = pickString(row, ['command']);
  const exitCode = pickNumber(row, ['exit_code']);
  const record: Omit<ProofEntry, 'prototype'> = {
    id: `proof-${index}`,
    timestamp: pickString(row, ['timestamp']) ?? '',
    claim: isEvent
      ? `${pickString(row, ['role']) ?? pickString(row, ['agent']) ?? 'an agent'} ran ${command ?? 'a check'}`
      : `doctor receipt: ${pickNumber(row, ['passed']) ?? 0} passed / ${pickNumber(row, ['failed']) ?? 0} failed across ${pickNumber(row, ['suites']) ?? 0} suites`,
    agent: pickString(row, ['agent']) ?? '',
    taskId: '',
    command: command ?? (isEvent ? '' : 'forge-doctor'),
    artifact: null,
    verdict,
    reason: exitCode !== null ? `exit code ${exitCode}` : '',
  };
  return record as unknown as ProofEntry;
}

export function toGatewayGate(row: Record<string, unknown>, index: number): QualityGate {
  const source = pickString(row, ['source']);
  const isEvent = source === 'event';
  const eventType = pickString(row, ['event_type']);
  const status: StatusKey = isEvent ? (eventType === 'check_passed' ? 'completed' : 'failed') : (pickBool(row, ['ok']) ? 'completed' : 'failed');
  const record: Omit<QualityGate, 'prototype'> = {
    id: `gate-${index}`,
    name: isEvent ? (pickString(row, ['command']) ?? pickString(row, ['role']) ?? 'check') : 'Doctor receipt',
    status,
    // Still '' — no per-check start/end timestamp pair exists anywhere in this gateway (a named,
    // unimplemented orchestrator-instrumentation gap; see `gateway-adapter.ts`'s own header).
    duration: '',
    lastRun: pickString(row, ['timestamp']) ?? '',
    evidenceCount: isEvent ? (row.evidence !== undefined && row.evidence !== null ? 1 : 0) : (pickNumber(row, ['passed']) ?? 0) + (pickNumber(row, ['failed']) ?? 0),
    // cc-fix-adapter T6b: proof.mjs now forwards the real event `output` field (previously
    // dropped) — falls back to `evidence` only when it is itself a real string, never a fabricated
    // placeholder. The doctor-summary branch was already real text before this fix.
    output: isEvent
      ? (pickString(row, ['output']) ?? pickString(row, ['evidence']) ?? '')
      : `${pickNumber(row, ['passed']) ?? 0} passed / ${pickNumber(row, ['failed']) ?? 0} failed across ${pickNumber(row, ['suites']) ?? 0} suites`,
  };
  return record as unknown as QualityGate;
}

export function toGatewayArtifact(row: Record<string, unknown>, index: number): Artifact {
  const kindRaw = pickString(row, ['type']);
  const kind = kindRaw === 'screenshot' || kindRaw === 'report' || kindRaw === 'diagram' || kindRaw === 'markdown' || kindRaw === 'log' || kindRaw === 'receipt' || kindRaw === 'proof' ? kindRaw : 'log';
  const sizeBytes = pickNumber(row, ['size_bytes']);
  const record: Omit<Artifact, 'prototype'> = {
    id: pickString(row, ['id']) ?? pickString(row, ['name']) ?? `artifact-${index}`,
    name: pickString(row, ['title']) ?? pickString(row, ['name']) ?? pickString(row, ['id']) ?? `artifact-${index}`,
    kind,
    // cc-fix-artifacts-empty: `Artifact` carries no dedicated run-id field (out of this fix's write
    // scope — `prototype-types.ts` stays frozen), so the real run label rides in this existing
    // free-text field instead: `proof.mjs`'s new `?run=all` aggregate path (`buildProofAll`) stamps
    // each row with its own real `run_id` (or `null` when genuinely unresolvable — see that
    // function's header); a row lacking that field entirely (the ORIGINAL single-run `/api/proof`
    // path, `buildProof`, untouched by this fix) falls through to the prior `source` label exactly
    // as before — zero behavior change for that path. This is what stops "every artifact looks like
    // it belongs to the current run" once artifacts from several real runs are shown together.
    producedBy: pickString(row, ['run_id']) ?? pickString(row, ['source']) ?? '',
    taskId: null,
    createdAt: pickString(row, ['ts']) ?? '',
    // cc-fix-adapter T6b: a real byte count, `stat()`'d server-side (proof.mjs) — '' (never a
    // fabricated "0 B") when the gateway could not stat the underlying file.
    size: sizeBytes !== null ? formatFileBytes(sizeBytes) : '',
    preview: pickString(row, ['summary']) ?? pickString(row, ['path']) ?? '',
  };
  return record as unknown as Artifact;
}

/**
 * cc-fix-adapter fix: the real `doctor.json` health summary `/api/proof` already returns via its
 * 'doctor' verdict entry (`proof.mjs:66-71`) — computed there since this project's earliest
 * gateway work, but never once read by this file until now. `score` is a real derived composite
 * (pass rate), not a fabricated number; it is 0 only when no doctor receipt exists for this
 * project's current run, matching this file's own "0 = not measured" precedent elsewhere.
 */
interface DoctorHealthSummary {
  readonly present: boolean;
  readonly passed: number;
  readonly failed: number;
  /** `null` when no doctor verdict exists — see EMPTY_DOCTOR_HEALTH's own comment. */
  readonly score: number | null;
}

/**
 * recertify follow-up (Lead): `score` is `null`, not `0`, when no doctor verdict exists.
 *
 * The `present: false` flag has always been here — and was never read by the one caller
 * (`:2012` took `.score` straight through). So the ACTIVE project rendered "Health 0%" whenever
 * the proof payload carried no doctor row, which is the ordinary state until a run with a doctor
 * verdict is selected. A 0% is not an empty reading; it is the worst possible score, shown for
 * something that was never measured — the exact defect F3 fixed for every OTHER project, still
 * living on the active-project path. The verify pass flagged it as an observation it could not
 * fully trace read-only; traced here, and it was real.
 *
 * `ProjectHealth.score` is already `number | null`, so absence is representable without widening
 * anything: views render `—`.
 */
const EMPTY_DOCTOR_HEALTH: DoctorHealthSummary = { present: false, passed: 0, failed: 0, score: null };

export function parseDoctorHealth(proofPayload: Record<string, unknown> | null): DoctorHealthSummary {
  if (proofPayload === null) return EMPTY_DOCTOR_HEALTH;
  const verdictRows = pickArray(proofPayload, ['verdicts']);
  const doctorRow = verdictRows.find((row) => pickString(row, ['source']) === 'doctor');
  if (doctorRow === undefined) return EMPTY_DOCTOR_HEALTH;
  const passed = pickNumber(doctorRow, ['passed']) ?? 0;
  const failed = pickNumber(doctorRow, ['failed']) ?? 0;
  const total = passed + failed;
  return { present: true, passed, failed, score: total > 0 ? Math.round((passed / total) * 100) : 0 };
}
