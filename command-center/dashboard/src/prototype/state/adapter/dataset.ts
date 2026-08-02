/**
 * Forge Command Center — gateway adapter, top-level dataset hook slice (WP refactor-adapter-split).
 *
 * Split out of the single `gateway-adapter.ts` (was ~2400 lines) into its already-marked "9. The
 * top-level dataset hook" section, verbatim — see that file's own header for the full
 * architecture/history/honesty rules this slice still follows. This is the orchestrator: it
 * imports the row parsers, status derivation, view mappers, mission graph, proof/gates/artifacts,
 * per-resource polling hooks, and chat-runs slices from their own sibling modules and composes them
 * into the exact `PrototypeDataset` shape every view already reads.
 */

import { useMemo } from 'react';

import type { PrototypeDataset } from '@/prototype/state/prototype-store';
import type { FileNode, Run } from '@/prototype/types/prototype-types';

import { pickArray, pickString } from '@/prototype/state/gateway-client';
import { useGatewayConversations } from '@/prototype/state/gateway-chat';

import { EMPTY_GRAPH, STATUS_WHEN_UNKNOWN } from './shared';
import {
  buildAgentProgressMap,
  buildAgentStatusMap,
  buildAgentVerificationMap,
  deriveRunStatus,
  formatRelativeTime,
  resolveAgentVerification,
  type MissionPayload,
  type RunRow,
} from './rows';
import {
  classifyProjectType,
  toGatewayActivityEvent,
  toGatewayAgent,
  toGatewayProject,
  toGatewayRun,
  toGatewayTask,
  toGatewayWorkPackage,
  EMPTY_ACTIVE_PROJECT_DETAIL,
  type ActiveProjectDetail,
} from './mappers';
import { buildGatewayMissionGraph, parseDoctorHealth, toGatewayArtifact, toGatewayGate, toGatewayProof } from './graph-and-proof';
import {
  useGatewayEvents,
  useGatewayMission,
  useGatewayProjectAgents,
  useGatewayProjectProfile,
  useGatewayProjectRows,
  useGatewayProjectRuns,
  useGatewayProof,
  useGatewayProofAll,
} from './polling-hooks';
import { toGatewayChatRunArtifacts, toGatewayChatRunTasks, useGatewayChatRuns } from './chat-runs';

/* ========================================================================== */
/*  9. The top-level dataset hook                                             */
/* ========================================================================== */

const EMPTY_DATASET: PrototypeDataset = {
  projects: [],
  conversations: [],
  agents: [],
  tasks: [],
  workPackages: [],
  runs: [],
  events: [],
  artifacts: [],
  gates: [],
  proof: [],
  files: [],
  graph: EMPTY_GRAPH,
};

/**
 * cc-fix-adapter fix: ALL real runs are mapped, not just the newest one (audit `:1185` — this used
 * to be `runRows[0]` only, breaking Home's mission list, Mission Control, and Activity's
 * group-by-run for every project with more than one run). The newest/`currentRunId` run keeps
 * getting full mission-derived detail (goal/workPackageIds/agentIds); every other row gets an
 * honest partial `Run` — status from its own real `hasFinalReport` (via `deriveRunStatus` with
 * `mission: null`), empty goal/workPackageIds/agentIds — never fabricated, matching this file's
 * own existing "real only for the selected entity" precedent. A future run-picker (out of this
 * file's scope — see header) would select which run drives that full-detail slot.
 */
export function buildGatewayRuns(
  runRows: readonly RunRow[],
  projectId: string,
  currentRunId: string | null,
  mission: MissionPayload | null,
  agentIdsInRun: readonly string[],
  runGoal: string | null,
): readonly Run[] {
  return runRows.map((row) =>
    toGatewayRun(
      row,
      projectId,
      row.runId === currentRunId ? mission : null,
      row.runId === currentRunId ? agentIdsInRun : [],
      row.runId === currentRunId ? runGoal : null,
    ),
  );
}

/**
 * The one hook `PrototypeProvider` calls in production: composes every real
 * gateway source into the exact `PrototypeDataset` shape every view already
 * reads. `filesTree` is built by `gateway-files.ts`'s own controller (mounted
 * alongside this hook in `PrototypeProvider`, not inside it — that controller
 * also owns the lazy per-directory `ensureLoaded` action `FilesView.tsx` calls,
 * which a plain data hook has no way to expose). `Approvals`/`Recovery`/
 * `Checkpoints` stay unwired into this dataset — see `gateway-adapter.ts`'s own header.
 */
export function useGatewayDataset(
  activeProjectId: string,
  activeConversationId: string,
  filesTree: readonly FileNode[],
): PrototypeDataset {
  const projectRows = useGatewayProjectRows();
  const runRows = useGatewayProjectRuns(activeProjectId);
  const agentRows = useGatewayProjectAgents(activeProjectId);
  const conversations = useGatewayConversations(activeConversationId);
  const profile = useGatewayProjectProfile(activeProjectId);

  // The gateway already sorts runs newest-first; the first real run is "the
  // current run" for this project, mirroring the same "newest run" convention
  // this mission's own Home view (WP5) already established.
  const currentRun = runRows[0] ?? null;
  const currentRunId = currentRun !== null ? currentRun.runId : null;

  const mission = useGatewayMission(activeProjectId, currentRunId);
  const proofPayload = useGatewayProof(activeProjectId, currentRunId);
  // cc-fix-artifacts-empty: Artifacts' real source is project-wide, not tied to currentRunId —
  // see useGatewayProofAll's own header. `proofPayload` above still drives `proof`/`gates` below,
  // unchanged.
  const proofAllPayload = useGatewayProofAll(activeProjectId);
  const rawEvents = useGatewayEvents(activeProjectId, currentRunId);
  // feat-chatruns-tabs: real dashboard-CHAT activity for the active project, project-wide like
  // `proofAllPayload` above (never tied to `currentRunId` — a chat execution is not a Forge run).
  const chatRunRows = useGatewayChatRuns(activeProjectId);

  return useMemo<PrototypeDataset>(() => {
    if (projectRows.length === 0) return EMPTY_DATASET;

    const conversationCounts = new Map<string, number>();
    for (const c of conversations) conversationCounts.set(c.projectId, (conversationCounts.get(c.projectId) ?? 0) + 1);

    const doctorHealth = parseDoctorHealth(proofPayload);
    const activeDetail: ActiveProjectDetail = {
      taskCount: mission !== null ? mission.tasks.length : 0,
      tests: { passed: doctorHealth.passed, failed: doctorHealth.failed, skipped: 0 },
      score: doctorHealth.score,
      description: profile.projectGoal ?? '',
      templateVersion: profile.forgeVersion ?? '',
      // cc-fix-events-honesty P2-9: relative label, not the raw ISO timestamp — see
      // formatRelativeTime()'s own header for why this is the one place to fix it.
      lastActivity: formatRelativeTime(currentRun?.mtime ?? null),
      // fix-ui-clutter (item 6): real only when a doctor verdict genuinely exists — see
      // `ActiveProjectDetail.testsMeasured`'s own doc comment.
      testsMeasured: doctorHealth.present,
    };

    const projects = projectRows.map((row) => {
      const isActive = row.name === activeProjectId;
      const status = isActive && currentRun !== null ? deriveRunStatus(currentRun, mission) : STATUS_WHEN_UNKNOWN;
      return toGatewayProject(
        row,
        status,
        conversationCounts.get(row.name) ?? 0,
        isActive ? agentRows.length : 0,
        isActive ? runRows.length : 0,
        isActive ? activeDetail : EMPTY_ACTIVE_PROJECT_DETAIL,
        isActive ? classifyProjectType(profile.projectTypeRaw) : 'unknown',
      );
    });

    const agentStatusMap = buildAgentStatusMap(mission);
    const agentVerificationMap = buildAgentVerificationMap(mission);
    const agentProgressMap = buildAgentProgressMap(mission);
    const latestTaskByAgent = new Map<string, string | null>();
    if (mission !== null) {
      for (const t of mission.tasks) {
        if (t.agent !== null && t.status === 'running') latestTaskByAgent.set(t.agent, t.task);
      }
    }
    const agents = agentRows.map((row) =>
      toGatewayAgent(
        row,
        agentStatusMap.get(row.slug) ?? STATUS_WHEN_UNKNOWN,
        latestTaskByAgent.get(row.slug) ?? null,
        resolveAgentVerification(agentVerificationMap, row.slug),
        agentProgressMap.get(row.slug) ?? 0,
      ),
    );

    const agentIdsInRun = mission !== null ? [...new Set(mission.tasks.map((t) => t.agent).filter((a): a is string => a !== null))] : [];
    // The run's own goal lives on the real `run_started` event (not a mission
    // "task" — that event predates any subagent dispatch), so it is read
    // straight off the raw event stream rather than guessed from a task.
    const runStartedEvent = rawEvents.events.find((e) => pickString(e, ['event_type']) === 'run_started');
    const runGoal = runStartedEvent !== undefined ? (pickString(runStartedEvent, ['task']) ?? pickString(runStartedEvent, ['note'])) : null;
    const runs = buildGatewayRuns(runRows, activeProjectId, currentRunId, mission, agentIdsInRun, runGoal);

    const tasks = mission !== null ? mission.tasks.map(toGatewayTask) : [];
    const taskIdsByWp = new Map<string, string[]>();
    if (mission !== null) {
      mission.tasks.forEach((t, i) => {
        const wp = t.wpGuess ?? '';
        if (wp === '') return;
        const id = t.dispatchId ?? `task-${i}`;
        taskIdsByWp.set(wp, [...(taskIdsByWp.get(wp) ?? []), id]);
      });
    }
    const workPackages = mission !== null ? mission.wps.map((wp, i) => toGatewayWorkPackage(wp, i, taskIdsByWp.get(wp.id ?? '') ?? [])) : [];

    // feat-chatruns-tabs: real chat-run todos/file-edits appended alongside the Forge mission's own
    // tasks/artifacts below — additive only, never replacing what mission/proofAll already provide.
    const chatRunTasks = chatRunRows.flatMap(toGatewayChatRunTasks);
    const chatRunArtifacts = chatRunRows.flatMap(toGatewayChatRunArtifacts);

    const events = currentRunId !== null ? rawEvents.events.map((row, i) => toGatewayActivityEvent(row, currentRunId, i)) : [];

    const graph = currentRunId !== null ? buildGatewayMissionGraph(currentRunId, mission, currentRun?.hasFinalReport ?? false) : EMPTY_GRAPH;

    const verdictRows = proofPayload !== null ? pickArray(proofPayload, ['verdicts']) : [];
    const proof = verdictRows.map(toGatewayProof);
    const gates = verdictRows.map(toGatewayGate);
    // cc-fix-artifacts-empty: artifacts now come from the project-wide `?run=all` aggregate, not
    // `proofPayload` (which stays tied to `currentRunId` for `proof`/`gates` above) — see
    // `useGatewayProofAll`'s own header for why this is a separate fetch.
    const artifactRows = proofAllPayload !== null ? pickArray(proofAllPayload, ['artifacts']) : [];
    const artifacts = [...artifactRows.map(toGatewayArtifact), ...chatRunArtifacts];

    return {
      projects,
      conversations,
      agents,
      tasks: [...tasks, ...chatRunTasks],
      workPackages,
      runs,
      events,
      artifacts,
      gates,
      proof,
      files: filesTree, // wired this WP — see gateway-files.ts
      graph,
    };
  }, [projectRows, runRows, agentRows, conversations, currentRun, currentRunId, mission, proofPayload, proofAllPayload, rawEvents, chatRunRows, activeProjectId, filesTree, profile]);
}
