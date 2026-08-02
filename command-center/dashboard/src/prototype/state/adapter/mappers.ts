/**
 * Forge Command Center — gateway adapter, view mappers + activity timeline slice
 * (WP refactor-adapter-split).
 *
 * Split out of the single `gateway-adapter.ts` (was ~2400 lines) into its already-marked
 * "4. View mappers" + "5. Activity timeline" sections, verbatim — see that file's own header for
 * the full architecture/history/honesty rules this slice still follows. `toPermissionLevel` moved
 * here from the original "3. Status derivation" section (now `rows.ts`): its only caller,
 * `toGatewayAgent`, lives in this file, so it is co-located with its one real use instead of
 * crossing a file boundary for no reason. `toGatewayRun`, `toGatewayWorkPackage`,
 * `toGatewayActivityEvent`, `columnForStatus`, and `phaseForStatus` gained an `export` keyword they
 * did not have in the single-file version, purely so sibling modules that now call them across a
 * file boundary (`dataset.ts`, `chat-runs.ts`) can import them — `gateway-adapter.ts`'s own public
 * re-export list is unchanged either way, since none of those five were part of it.
 */

import type {
  Agent,
  AgentGroup,
  ActivityEvent,
  EffortTier,
  EventKind,
  PermissionLevel,
  Project,
  ProjectType,
  Run,
  StatusKey,
  Task,
  TaskColumn,
  TaskPhase,
  WorkPackage,
} from '@/prototype/types/prototype-types';

import { pickString } from '@/prototype/state/gateway-client';

import { STATUS_WHEN_UNKNOWN } from './shared';
import {
  deriveRunStatus,
  formatDurationWithSource,
  toStatusKey,
  type AgentRow,
  type MissionPayload,
  type MissionTaskRow,
  type MissionWpRow,
  type ProjectRow,
  type RunRow,
} from './rows';

/* ========================================================================== */
/*  4. View mappers — project / run / agent / task / work package             */
/* ========================================================================== */

/**
 * The real, currently-fetched detail this file has for a project — populated ONLY for the ACTIVE
 * project (see `useGatewayDataset`), same "real only for the selected project" precedent this file
 * already applies to `agentCount`/`missionCount`. `openTickets`/`blockers` are always 0: genuinely
 * no data source exists anywhere in this gateway for either (named gap, not silently invented).
 *
 * fix-cert-rest (item 3): `taskCount`/`score` are `number | null` so `EMPTY_ACTIVE_PROJECT_DETAIL`
 * can emit a real, typed `null` for "never measured" instead of a `0` a genuinely-measured empty
 * project could also produce — see `Project.taskCount`/`ProjectHealth.score`'s own doc comments.
 */
export interface ActiveProjectDetail {
  readonly taskCount: number | null;
  readonly tests: { readonly passed: number; readonly failed: number; readonly skipped: number };
  readonly score: number | null;
  readonly description: string;
  readonly templateVersion: string;
  readonly lastActivity: string;
  /** fix-ui-clutter (item 6): real only when a doctor verdict actually exists for this
   *  project's current run (`parseDoctorHealth`'s own `present` flag) — `false` for every
   *  project this workspace has not measured, INCLUDING the active project before its first
   *  doctor run, so a fresh project's genuine zero tests never render as a measured "0 passed
   *  · 0 failed · 0 skipped". */
  readonly testsMeasured: boolean;
}

export const EMPTY_ACTIVE_PROJECT_DETAIL: ActiveProjectDetail = {
  taskCount: null,
  tests: { passed: 0, failed: 0, skipped: 0 },
  score: null,
  description: '',
  templateVersion: '',
  lastActivity: '',
  testsMeasured: false,
};

const KNOWN_PROJECT_TYPES: ReadonlySet<ProjectType> = new Set([
  'website',
  'full-stack',
  'automation',
  'chatbot',
  'scraping',
  'prediction',
  'integration',
  'research',
]);

/**
 * cc-wire-usage handoff-fix: `ProjectType` is a closed enum; `project_type_raw`
 * (T6d's real `/api/projects/:name/profile` field) is free text a human wrote,
 * not a controlled vocabulary — most real values will never cleanly match one
 * of the 8. Only an EXACT (trimmed, case-insensitive) match to a known type
 * word counts as a real classification; a compound/mixed description, an
 * absent profile, or anything else is honestly `'unknown'` — never a
 * keyword-guessed default (the exact trap this file's own header already
 * flagged when this field was hardcoded to `'full-stack'`).
 */
export function classifyProjectType(raw: string | null): ProjectType {
  if (raw === null) return 'unknown';
  const normalised = raw.trim().toLowerCase();
  for (const known of KNOWN_PROJECT_TYPES) {
    if (normalised === known) return known;
  }
  return 'unknown';
}

/**
 * `type` defaults to `'unknown'` (never a guess) so the pre-existing
 * `gateway-adapter-antifabrication.test.ts` calls — written before this field
 * was classifiable — keep compiling and passing unmodified; `useGatewayDataset`
 * below always passes the real, computed value.
 */
export function toGatewayProject(row: ProjectRow, status: StatusKey, conversationCount: number, agentCount: number, missionCount: number, detail: ActiveProjectDetail, type: ProjectType = 'unknown'): Project {
  const record: Omit<Project, 'prototype'> = {
    id: row.name,
    name: row.name,
    description: detail.description,
    // cc-wire-usage handoff-fix: real for the active project (`classifyProjectType`
    // on the real profile field), 'unknown' for every other row — same "real only
    // for the selected project" precedent this file already applies to
    // taskCount/health/etc. Never a keyword-guessed default.
    type,
    status,
    lastActivity: detail.lastActivity,
    path: row.path,
    templateVersion: detail.templateVersion,
    pinned: false,
    conversationCount,
    missionCount,
    taskCount: detail.taskCount,
    agentCount,
    skills: [],
    health: { tests: detail.tests, openTickets: 0, blockers: 0, score: detail.score, testsMeasured: detail.testsMeasured },
    dirMtimeMs: row.dirMtimeMs,
  };
  return record as unknown as Project;
}

/**
 * cc-finish fix-cert-fabrication (F3) — UPDATED by fix-cert-rest (item 3): whether a project's
 * `agentCount`/`missionCount` are a REAL measurement, or `useGatewayDataset`'s placeholder `0` for
 * every project that is not the active one.
 *
 * `Project.taskCount` / `ProjectHealth.score` no longer need this helper: they were WIDENED to
 * `number | null` (fix-cert-rest, item 3), so `EMPTY_ACTIVE_PROJECT_DETAIL` now emits a real, typed
 * `null` directly — a consumer checks `=== null`, the honest signal travels with the value itself.
 * `agentCount`/`missionCount` stay a shared, non-nullable `number` (widening them too is real,
 * tracked follow-up work — see this fix round's own handoff notes), so THEY still need this
 * out-of-band boolean: real ONLY for the active project (see `useGatewayDataset`'s own `isActive`
 * check below — the two must never drift apart) and for every fixture/prototype record, which
 * carries a genuine per-field example value for every row regardless of which project happens to
 * be "active" (see `fixtures/projects.ts`).
 *
 * Any consumer that renders or sorts a project's `agentCount`/`missionCount` MUST call this first
 * and treat a `false` result as absent ('—'), never as a measured zero — that exact gap (no such
 * call existed) is what let `ProjectsView.tsx` show a fabricated "0" for every non-active project.
 * `prototype` is read defensively (never asserted present): a real gateway `Project` never carries
 * it — see `toGatewayProject`'s own `Omit<Project, 'prototype'>` cast above.
 */
export function hasMeasuredProjectDetail(
  project: { readonly id: string; readonly prototype?: unknown },
  activeProjectId: string,
): boolean {
  return project.prototype === true || project.id === activeProjectId;
}

export function toGatewayRun(row: RunRow, projectId: string, mission: MissionPayload | null, agentIds: readonly string[], goal: string | null): Run {
  const status = deriveRunStatus(row, mission);
  const record: Omit<Run, 'prototype'> = {
    id: row.runId,
    projectId,
    goal: goal ?? '',
    status,
    startedAt: row.mtime ?? '',
    // cc-fix-adapter T6c: real, derived server-side from this run's own first/last event
    // timestamp — '' (never a fabricated "0s") when fewer than two real timestamps exist.
    // cc-fix-events-honesty P1-6: now qualified via formatDurationWithSource() so a
    // 'derived-from-events' estimate never renders identically to a real measurement.
    duration: formatDurationWithSource(row.durationMs, row.durationSource),
    workPackageIds: mission !== null ? mission.wps.map((w) => w.id ?? '').filter((id) => id.length > 0) : [],
    agentIds,
  };
  return record as unknown as Run;
}

function toEffortTier(raw: string | null): EffortTier {
  return raw === 'low' || raw === 'medium' || raw === 'high' || raw === 'max' ? raw : 'medium';
}

/**
 * cc-fix-adapter fix: the permission chip now derives from the REAL least-privilege `class`
 * (`agent-tool-policy.json`, exactly 4 real values in this fleet) instead of the boolean
 * `is_permanent_boss` this file used before. Named side effect: no real `class` value maps to
 * `'lead'`, so no agent renders that tier any more — `is_permanent_boss` was the only signal that
 * ever produced it, and it measured registry membership, not an actual permission scope. This is
 * reported as a visible handoff item (see `gateway-adapter.ts`'s own header), not silently absorbed.
 */
function toPermissionLevel(agentClass: string | null): PermissionLevel {
  switch (agentClass) {
    case 'read-only-audit':
      return 'read-only';
    case 'full-build':
      return 'elevated';
    case 'write-no-exec':
    case 'exec-reviewer':
      return 'standard';
    default:
      return 'standard';
  }
}

export function toGatewayAgent(row: AgentRow, status: StatusKey, currentTask: string | null, verification: Agent['verification'], progress: number): Agent {
  const group: AgentGroup = row.isPermanentBoss ? 'control' : 'execution';
  const permission: PermissionLevel = toPermissionLevel(row.agentClass);
  const record: Omit<Agent, 'prototype'> = {
    id: row.slug,
    name: row.name,
    role: row.role ?? '',
    group,
    permission,
    status,
    // cc-fix-adapter fix: real completed/total task ratio for this agent in the current run —
    // see buildAgentProgressMap(). 0 for an agent with no tasks in this run (honest, not a guess).
    progress,
    currentTask,
    runtimeModel: row.modelTier ?? '',
    toolModel: row.nvidiaRole ?? '',
    effort: toEffortTier(row.claudeEffort),
    // cc-fix-adapter T6a: the real per-agent CORE skill list from `GET /api/agents`.
    skills: row.skills,
    lastActivity: '',
    // cc-fix-adapter fix: derived from this run's own real check_passed/check_failed verdicts for
    // this agent (see buildAgentVerificationMap()) — fix-cert-rest (item 2): `null` (an honest
    // absence, via resolveAgentVerification()), never 'not-required', when no verdict exists for it.
    verification,
    summary: row.description ?? '',
  };
  return record as unknown as Agent;
}

export function columnForStatus(status: StatusKey): TaskColumn {
  switch (status) {
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'verify':
      return 'verify';
    case 'review':
      return 'review';
    case 'failed':
    case 'blocked':
      return 'blocked';
    // fix-status-honesty: idle (no recorded state) belongs in the backlog column like waiting —
    // it is even less started than queued work.
    case 'waiting':
    case 'idle':
      return 'backlog';
  }
}

export function phaseForStatus(status: StatusKey): TaskPhase {
  switch (status) {
    case 'verify':
      return 'verify';
    case 'review':
      return 'review';
    case 'completed':
      return 'handoff';
    case 'waiting':
    case 'idle': // fix-status-honesty: nothing recorded yet — plan phase, same as waiting
      return 'plan';
    case 'running':
    case 'failed':
    case 'blocked':
      return 'build';
  }
}

export function toGatewayTask(row: MissionTaskRow, index: number): Task {
  const status = toStatusKey(row.status);
  const record: Omit<Task, 'prototype'> = {
    id: row.dispatchId ?? `task-${index}`,
    title: row.task ?? row.role ?? 'Task',
    agentId: row.agent ?? '',
    workPackageId: row.wpGuess ?? '',
    phase: phaseForStatus(status),
    column: columnForStatus(status),
    status,
    // cc-fix-adapter fix: no endpoint reports a true fractional completion percentage (still true —
    // see file header), but a real binary signal exists: 100 for a genuinely completed task, 0
    // otherwise. This is a real fact about the task's own status, not an invented number — it no
    // longer reads "0% done" for a task that has, in reality, already finished.
    progress: status === 'completed' ? 100 : 0,
    dependencies: [],
    proofCount: 0,
    createdAt: row.startedAt ?? '',
    updatedAt: row.completedAt ?? row.startedAt ?? '',
    repairAttempts: 0,
    detail: row.notes.join(' '),
    // cc-wire-usage handoff-fix: the real per-task wp-guess confidence, straight
    // through from `MissionTaskRow` — was previously discarded here even though
    // the row shape already carried it. `null` when the gateway did not report
    // one, never a fabricated confidence.
    wpGuessConfidence: row.wpGuessConfidence,
    // Z1 last hop. The gateway records its refusal to pair an ambiguous completion, and
    // `parseMissionPayload` already carried that refusal onto `MissionTaskRow` — but this mapper
    // dropped all four fields, so the warning could never reach `Task`, the object components
    // actually render. Measured before this fix: HOP 1 had pairingAmbiguous:true, HOP 2's key
    // list did not contain the field at all. Straight passthrough of the row's own real values —
    // no default is invented here (the honest `false`/`null` defaults are applied once, at the
    // parsing boundary in `rows.ts`), and no status/column/phase/progress derivation reads them.
    pairingAmbiguous: row.pairingAmbiguous,
    pairingAmbiguityReason: row.pairingAmbiguityReason,
    declinedCompletions: row.declinedCompletions,
    unmatchedReason: row.unmatchedReason,
  };
  return record as unknown as Task;
}

export function toGatewayWorkPackage(row: MissionWpRow, index: number, taskIds: readonly string[]): WorkPackage {
  const record: Omit<WorkPackage, 'prototype'> = {
    id: row.id ?? `wp-${index}`,
    title: row.id ?? 'Work package',
    goal: row.note ?? '',
    status: STATUS_WHEN_UNKNOWN,
    ownerAgentId: row.agent ?? '',
    phase: 'build',
    taskIds,
    acceptance: [],
  };
  return record as unknown as WorkPackage;
}

/* ========================================================================== */
/*  5. Activity timeline — the raw events.jsonl vocabulary, mapped honestly  */
/* ========================================================================== */

const RUN_LIKE = /^run/;
const AGENT_LIKE = /^(subagent|agent)_/;

/** A DISPLAY projection from this project's own real `event_type` vocabulary — mirrors
 * `live-store.ts`'s `STATUS_PROJECTION` in spirit: derived deterministically from a
 * real field, never invented. */
function activityStatus(eventType: string): StatusKey {
  if (eventType === 'run_started' || /_started$/.test(eventType)) return 'running';
  if (eventType === 'check_passed' || /_completed$/.test(eventType)) return 'completed';
  if (eventType === 'check_failed' || /_failed$/.test(eventType)) return 'failed';
  return STATUS_WHEN_UNKNOWN;
}

function activityKind(eventType: string): EventKind {
  if (RUN_LIKE.test(eventType)) return 'mission';
  if (eventType === 'check_passed' || eventType === 'check_failed') return 'verify';
  if (eventType === 'agent_work_package_created') return 'work-package';
  if (AGENT_LIKE.test(eventType)) return 'agent';
  return 'system';
}

export function toGatewayActivityEvent(row: Record<string, unknown>, runId: string, index: number): ActivityEvent {
  const eventType = pickString(row, ['event_type']) ?? 'unknown';
  const record: Omit<ActivityEvent, 'prototype'> = {
    id: pickString(row, ['entry_hash']) ?? `${runId}-${index}`,
    runId,
    timestamp: pickString(row, ['timestamp']) ?? '',
    kind: activityKind(eventType),
    agent: pickString(row, ['agent']),
    status: activityStatus(eventType),
    message: pickString(row, ['note']) ?? pickString(row, ['task']) ?? eventType,
    detail: eventType,
  };
  return record as unknown as ActivityEvent;
}
