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
  buildAgentNameIndex,
  buildAgentProgressMap,
  buildAgentStatusMap,
  buildAgentVerificationMap,
  deriveRunStatus,
  formatRelativeTime,
  resolveAgentSlug,
  resolveAgentVerification,
  workPackageJoinId,
  type MissionPayload,
  type MissionTaskRow,
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
import {
  buildGatewayMissionGraph,
  dedupeLatestVerdictRows,
  NO_INTEGRATION_GATE,
  parseDoctorHealth,
  readIntegrationGateSignal,
  toGatewayArtifact,
  toGatewayGate,
  toGatewayProof,
} from './graph-and-proof';
import {
  useGatewayActiveRuns,
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

/**
 * WP-CCD (item 3): resolves every raw, free-text `agent` field inside a mission payload to its
 * real registry slug via `resolveAgentKey` (built from THIS project's own real agent rows — see
 * `buildAgentNameIndex`'s own doc comment) — applied ONCE, here, rather than threading a resolver
 * through every downstream consumer (`buildAgentStatusMap`, `toGatewayTask`, the mission graph
 * lane grouping, `Run.agentIds`, …). An unmatched raw value (an unregistered agent like "codex" or
 * "orchestrator" — real values this fleet's own events log) passes through UNCHANGED: `??` only
 * ever narrows toward a real slug, never invents one. `null` stays `null`.
 */
function resolveMissionAgentKeys(mission: MissionPayload | null, resolveAgentKey: (raw: string) => string): MissionPayload | null {
  if (mission === null) return null;
  const resolveTask = (t: MissionTaskRow): MissionTaskRow => (t.agent === null ? t : { ...t, agent: resolveAgentKey(t.agent) });
  return {
    ...mission,
    tasks: mission.tasks.map(resolveTask),
    orphanCompletions: mission.orphanCompletions.map(resolveTask),
    verdicts: mission.verdicts.map((v) => (v.agent === null ? v : { ...v, agent: resolveAgentKey(v.agent) })),
  };
}

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
  defaultProjectId: null,
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
  const { rows: projectRows, defaultProjectId } = useGatewayProjectRows();
  const { rows: runRows, currentRunId: reportedCurrentRunId } = useGatewayProjectRuns(activeProjectId);
  const agentRows = useGatewayProjectAgents(activeProjectId);
  const conversations = useGatewayConversations(activeConversationId);
  const profile = useGatewayProjectProfile(activeProjectId);

  // WP-CCD (item 1): prefer the gateway's OWN honest "current run" pick (`current_run`, a sibling
  // field on `/api/runs` — see `parseCurrentRunId`'s own doc comment) over the plain "newest row"
  // heuristic, and never let a synthetic/example run (`RunRow.synthetic`) stand in as "current" —
  // falls back to the first NON-synthetic row, and only to the literal first row (the exact
  // pre-existing "the gateway already sorts runs newest-first" behaviour) when every row this
  // project has is synthetic, or this gateway build reports neither field at all.
  const nonSyntheticRunRows = runRows.filter((r) => !r.synthetic);
  const reportedCurrentRun =
    reportedCurrentRunId !== null ? (nonSyntheticRunRows.find((r) => r.runId === reportedCurrentRunId) ?? null) : null;
  const currentRun = reportedCurrentRun ?? nonSyntheticRunRows[0] ?? runRows[0] ?? null;
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
  // WP-CCD (item 8, review fix): the SAME cross-project "is this project's run genuinely live right
  // now" signal `HomeView.tsx`'s own "Active missions" panel reads (item 7) — reused here so EVERY
  // project row (not only the active one, which already gets a precise mission-derived status) can
  // show its own real live state instead of a hardcoded `STATUS_WHEN_UNKNOWN`. `available: false`
  // (the route absent, or a fetch failure) changes nothing: no project gets marked live from this
  // signal, exactly today's pre-existing behaviour.
  const activeRunsAcrossWorkspace = useGatewayActiveRuns();

  return useMemo<PrototypeDataset>(() => {
    if (projectRows.length === 0) return EMPTY_DATASET;

    const conversationCounts = new Map<string, number>();
    for (const c of conversations) conversationCounts.set(c.projectId, (conversationCounts.get(c.projectId) ?? 0) + 1);

    const doctorHealth = parseDoctorHealth(proofPayload);
    const activeDetail: ActiveProjectDetail = {
      taskCount: mission !== null ? mission.tasks.length : 0,
      tests: { passed: doctorHealth.passed, failed: doctorHealth.failed, skipped: doctorHealth.skipped },
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

    // WP-CCD (item 3): a normalized-name -> canonical registry slug index built from THIS
    // project's real agent rows, and the resolver every raw mission `agent` field is passed
    // through exactly once (`resolveMissionAgentKeys`, this file's own header) before anything
    // downstream uses it as a map key or a `Task.agentId`/graph lane identity. This alone (no
    // gateway `display_name`/`aliases` field required) already resolves "Build Boss" (the real
    // display text this fleet's own events log) to the registry slug "build-boss" `Agent.id`
    // actually uses — see `buildAgentNameIndex`'s own doc comment for why.
    const agentNameIndex = buildAgentNameIndex(agentRows);
    const resolveAgentKey = (raw: string): string => resolveAgentSlug(raw, agentRows, agentNameIndex) ?? raw;
    const resolvedMission = resolveMissionAgentKeys(mission, resolveAgentKey);

    // WP-CCD (item 8, review fix): every project this cross-project signal reports as genuinely live
    // right now — never trusted when the route itself is unavailable (`available: false` yields an
    // empty set here, so every project keeps its pre-existing status exactly as before this fix).
    const liveProjectNames = new Set<string>(activeRunsAcrossWorkspace.available ? activeRunsAcrossWorkspace.rows.map((r) => r.project) : []);

    const projects = projectRows.map((row) => {
      const isActive = row.name === activeProjectId;
      // WP-CCD (item 8): the active project keeps its precise, mission-derived status unchanged; any
      // OTHER project this workspace's own cross-project signal marks live gets an honest 'running'
      // instead of the neutral placeholder — a real fact about THAT project, not a guess. A project
      // neither active nor reported live keeps the honest `STATUS_WHEN_UNKNOWN` exactly as before.
      const status =
        isActive && currentRun !== null
          ? deriveRunStatus(currentRun, resolvedMission)
          : liveProjectNames.has(row.name)
            ? 'running'
            : STATUS_WHEN_UNKNOWN;
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

    const agentStatusMap = buildAgentStatusMap(resolvedMission);
    const agentVerificationMap = buildAgentVerificationMap(resolvedMission);
    const agentProgressMap = buildAgentProgressMap(resolvedMission);
    const latestTaskByAgent = new Map<string, string | null>();
    if (resolvedMission !== null) {
      for (const t of resolvedMission.tasks) {
        if (t.agent !== null && t.status === 'running') latestTaskByAgent.set(t.agent, t.task);
      }
    }
    const agents = agentRows.map((row) => {
      // WP-CCD (item 3, review fix): `GET /api/agents`'s own direct `is_running` signal (the SAME
      // run-log dispatch data the "Live now" strip reads — see `AgentRow.isRunning`'s own doc
      // comment) wins whenever true — a more authoritative, name-matching-free "is this agent
      // working right now" than inferring it from this one mission's own task list alone. `false`/
      // absent changes nothing: the pre-existing mission-derived status/task are used unchanged.
      const missionStatus = agentStatusMap.get(row.slug) ?? STATUS_WHEN_UNKNOWN;
      const status = row.isRunning === true ? 'running' : missionStatus;
      const currentTask = latestTaskByAgent.get(row.slug) ?? (row.isRunning === true ? (row.runningTask ?? null) : null);
      return toGatewayAgent(row, status, currentTask, resolveAgentVerification(agentVerificationMap, row.slug), agentProgressMap.get(row.slug) ?? 0);
    });
    // WP-CCD (item 3): slug -> the SAME display text `Agent.name` itself resolved to for that
    // slug (`displayName ?? name`) — used by the mission graph below so a lane's own label and
    // `MissionControlView.tsx`'s `progressByAgent` (keyed by `agent.name`, unchanged) always agree.
    const agentDisplayBySlug = new Map(agents.map((a) => [a.id, a.name]));
    const resolveAgentDisplay = (raw: string): string => agentDisplayBySlug.get(raw) ?? raw;

    const agentIdsInRun =
      resolvedMission !== null ? [...new Set(resolvedMission.tasks.map((t) => t.agent).filter((a): a is string => a !== null))] : [];
    // The run's own goal lives on the real `run_started` event (not a mission
    // "task" — that event predates any subagent dispatch), so it is read
    // straight off the raw event stream rather than guessed from a task.
    const runStartedEvent = rawEvents.events.find((e) => pickString(e, ['event_type']) === 'run_started');
    const runGoal = runStartedEvent !== undefined ? (pickString(runStartedEvent, ['task']) ?? pickString(runStartedEvent, ['note'])) : null;
    const runs = buildGatewayRuns(runRows, activeProjectId, currentRunId, resolvedMission, agentIdsInRun, runGoal);

    const tasks = resolvedMission !== null ? resolvedMission.tasks.map(toGatewayTask) : [];
    const taskIdsByWp = new Map<string, string[]>();
    if (resolvedMission !== null) {
      resolvedMission.tasks.forEach((t, i) => {
        // WP-CCD (item 2): the SAME preference `toGatewayTask` itself uses for `workPackageId`
        // (`wpId` first, `wpGuess` as the pre-existing fallback) — grouping tasks under a DIFFERENT
        // key than the one each `Task.workPackageId` actually carries is exactly what left every
        // real work package showing 0 of its real tasks while the board itself had 38 of 46 done.
        const wp = t.wpId ?? t.wpGuess ?? '';
        if (wp === '') return;
        const id = t.dispatchId ?? `task-${i}`;
        taskIdsByWp.set(wp, [...(taskIdsByWp.get(wp) ?? []), id]);
      });
    }
    // WP-CCD (item 2, review fix): looked up by `workPackageJoinId(wp)` — the SAME identifier
    // `taskIdsByWp` above was grouped by (`t.wpId ?? t.wpGuess`) — not the bare `wp.id` this used to
    // read, which silently missed every modern work package (see `workPackageJoinId`'s own doc
    // comment in `rows.ts`).
    const workPackages =
      resolvedMission !== null ? resolvedMission.wps.map((wp, i) => toGatewayWorkPackage(wp, i, taskIdsByWp.get(workPackageJoinId(wp)) ?? [])) : [];

    // feat-chatruns-tabs: real chat-run todos/file-edits appended alongside the Forge mission's own
    // tasks/artifacts below — additive only, never replacing what mission/proofAll already provide.
    const chatRunTasks = chatRunRows.flatMap(toGatewayChatRunTasks);
    const chatRunArtifacts = chatRunRows.flatMap(toGatewayChatRunArtifacts);

    const events = currentRunId !== null ? rawEvents.events.map((row, i) => toGatewayActivityEvent(row, currentRunId, i)) : [];

    // WP-CCD (item 4): a real `integration_gate_passed`/`integration_gate_failed` event, read
    // straight off this run's own raw event stream — see `readIntegrationGateSignal`'s own doc
    // comment for why this is resilient to `missions.mjs` never classifying it as a verdict.
    const integrationGate = currentRunId !== null ? readIntegrationGateSignal(rawEvents.events) : NO_INTEGRATION_GATE;
    const graph =
      currentRunId !== null
        ? buildGatewayMissionGraph(currentRunId, resolvedMission, currentRun?.hasFinalReport ?? false, integrationGate, resolveAgentDisplay)
        : EMPTY_GRAPH;

    const verdictRows = proofPayload !== null ? pickArray(proofPayload, ['verdicts']) : [];
    // WP-CCD (item 4/6/7): `proof` stays the FULL historical ledger (every real claim, resolved or
    // not — a ledger's whole point); `gates` is the LATEST result per real check identity, never
    // "any check_failed ever = red" — see `dedupeLatestVerdictRows`'s own doc comment. This is what
    // fixes Home's "Failures and blockers" (it reads `gates`) and the Dock's Tests panel for free.
    const proof = verdictRows.map(toGatewayProof);
    const gates = dedupeLatestVerdictRows(verdictRows).map(toGatewayGate);
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
      defaultProjectId, // WP-P1 — see PrototypeProvider.tsx's reconciliation effect for how this is used
    };
  }, [
    projectRows,
    runRows,
    agentRows,
    conversations,
    currentRun,
    currentRunId,
    mission,
    proofPayload,
    proofAllPayload,
    rawEvents,
    chatRunRows,
    activeProjectId,
    filesTree,
    profile,
    defaultProjectId,
    activeRunsAcrossWorkspace,
  ]);
}
