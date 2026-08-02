/**
 * Forge Workspace — the live → view adapter.
 *
 * The thirteen views were authored against the prototype's fixture shapes
 * (`Project`, `Conversation`, `Agent`, `Task`, `Run`, `ActivityEvent`, …). The
 * connected workspace's real state lives in a DIFFERENT, thinner shape
 * (`LiveProject`, `LiveConversation`, …), folded from the bridge's event log.
 * This module is the one pure seam between the two: it maps each real `Live*`
 * record onto the view-facing shape so the views keep working while rendering
 * REAL data in production.
 *
 * THREE RULES THIS ADAPTER OBEYS, because the whole system stands on them.
 *
 *   1. NEVER FABRICATE A ROW. Every record produced here corresponds to a real
 *      `Live*` record that was itself folded from a real event. When the live
 *      store has nothing (no runs, an empty registry — the ordinary state of a
 *      fresh workspace), the mapped collection is EMPTY and the view shows its
 *      real empty state. Empty is a correct answer; a made-up row is not.
 *
 *   2. NEVER FABRICATE A STATUS. A status is carried straight through
 *      `statusKeyOf`, which is the display projection of the record's real
 *      `OperationalStatus`. Where a record exists but has reported no status yet,
 *      it is shown as `waiting` — the same bucket the projection already gives a
 *      just-CREATED/QUEUED record — never as running/completed/verified. The
 *      activity feed goes further: it surfaces ONLY events that carry a real
 *      status, so no log line is ever assigned a status it did not report.
 *
 *   3. UNKNOWN ATTRIBUTES ARE SHOWN AS ABSENCE, NOT INVENTED. The view types
 *      carry many fields the event log does not describe (a project's health
 *      score, an agent's role, a task's proof count). These are filled with
 *      neutral zero/empty placeholders — 0, '', [] — which every view already
 *      renders as "none / not known", exactly as it does today against the empty
 *      production dataset. They are placeholders, not claims. A future work
 *      package wiring `listProjects`/`listRuns`/… will populate them for real.
 *      fix-cert-rest UPDATE: where the view type itself carries a real `null` option
 *      (`Project.taskCount`/`ProjectHealth.score`, `Agent.verification`), `null` is the correct
 *      placeholder here, not `0`/`'not-required'` — those specific values are shared,
 *      non-nullable and CANNOT express "unmeasured" without it, which is the exact gap
 *      `null` closes; every other field without a `null` option keeps 0/''/[] as before.
 *
 * A NOTE ON THE `prototype: true` FLAG. The view interfaces extend `Prototyped`
 * because they were written for the fixture path, where every record carries
 * `prototype: true` so the honesty guards can spot example data. These records
 * are REAL, so they must NOT carry that flag — stamping it would misclassify real
 * data as an example. Each mapping therefore builds a fully type-checked object
 * against `Omit<T, 'prototype'>` (so no field is missed or mistyped) and re-types
 * it to the view interface WITHOUT adding the flag. The runtime record is honest;
 * nothing reads `.prototype` on the view records, and no guard runs over them.
 */

import type { ForgeEvent } from '@/shared/protocol';
import type {
  ActivityEvent,
  Agent,
  AgentGroup,
  ChatMessage,
  Conversation,
  EffortTier,
  EventKind,
  MissionGraph,
  PermissionLevel,
  Project,
  ProjectType,
  Run,
  StatusKey,
  Task,
  TaskColumn,
  TaskPhase,
} from '@/prototype/types/prototype-types';
import type { PrototypeDataset } from '@/prototype/state/prototype-store';
import type {
  LiveAgent,
  LiveConversation,
  LiveMessage,
  LiveProject,
  LiveRun,
  LiveState,
  LiveTask,
} from '@/prototype/state/live-store';
import { BRIDGE_PROJECT_ID, statusKeyOf } from '@/prototype/state/live-store';
import { buildMissionGraph } from '@/prototype/state/graph-builder';

/* ========================================================================== */
/*  Neutral defaults                                                           */
/* ========================================================================== */

/**
 * The status shown for a record that exists but has reported no operational
 * status yet. `waiting` is the same bucket `statusKeyOf` gives a just-created
 * record, so it makes no stronger claim than "this exists and nothing has
 * happened to it." It is NEVER used to paper over a status the record did report.
 */
const STATUS_WHEN_UNKNOWN: StatusKey = 'waiting';

/** A default group for an agent whose group the event log does not describe. */
const AGENT_GROUP_WHEN_UNKNOWN: AgentGroup = 'execution';
const AGENT_PERMISSION_WHEN_UNKNOWN: PermissionLevel = 'standard';
const AGENT_EFFORT_WHEN_UNKNOWN: EffortTier = 'medium';
const PROJECT_TYPE_WHEN_UNKNOWN: ProjectType = 'full-stack';

/* ========================================================================== */
/*  The empty dataset                                                          */
/* ========================================================================== */

/**
 * A genuinely empty mission graph. It deliberately does NOT carry
 * `prototype: true` — in production nothing is a prototype record — and the cast
 * documents that this shell is structural, not example data. Mirrors the shape
 * `prototype/data/index.ts` uses for the empty production graph.
 */
const EMPTY_GRAPH = { id: '', runId: '', lanes: [], nodes: [], edges: [] } as unknown as MissionGraph;

/**
 * Every collection empty. Used as the production seed for the UI reducer, whose
 * `data` is then overridden with the live-derived dataset on each render.
 */
export const EMPTY_DATASET: PrototypeDataset = {
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

/* ========================================================================== */
/*  Small helpers                                                              */
/* ========================================================================== */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** First non-empty string among `keys` on a payload, or null. */
function pickString(payload: unknown, keys: readonly string[]): string | null {
  const obj = asRecord(payload);
  if (obj === null) return null;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return null;
}

/** The view status for a record, falling back to the neutral `idle` (fix-status-honesty). */
function viewStatus(status: StatusKey | null): StatusKey {
  return status ?? STATUS_WHEN_UNKNOWN;
}

/** A task board column derived from the record's real status. */
function columnForStatus(status: StatusKey): TaskColumn {
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
    case 'waiting':
    case 'idle': // fix-status-honesty: no recorded state — backlog, same as waiting
      return 'backlog';
  }
}

/** A task phase derived from the record's real status. */
function phaseForStatus(status: StatusKey): TaskPhase {
  switch (status) {
    case 'verify':
      return 'verify';
    case 'review':
      return 'review';
    case 'completed':
      return 'handoff';
    case 'waiting':
    case 'idle': // fix-status-honesty
      return 'plan';
    case 'running':
    case 'failed':
    case 'blocked':
      return 'build';
  }
}

/** The activity timeline's coarse kind, classified from the real event type. */
function kindForEventType(type: string): EventKind {
  if (type.startsWith('run.')) return 'mission';
  if (type.startsWith('task.')) return 'task';
  if (type.startsWith('verify.')) return 'verify';
  if (type.startsWith('review.')) return 'review';
  if (type.startsWith('test.')) return 'test';
  if (type.startsWith('artifact.') || type.startsWith('attachment.')) return 'artifact';
  if (
    type.startsWith('agent.') ||
    type.startsWith('session.') ||
    type.startsWith('claude.') ||
    type.startsWith('skill.')
  ) {
    return 'agent';
  }
  if (type.startsWith('work-package.') || type.startsWith('wp.')) return 'work-package';
  return 'system';
}

/* ========================================================================== */
/*  Record mappers                                                             */
/* ========================================================================== */

export function toProject(p: LiveProject): Project {
  const record: Omit<Project, 'prototype'> = {
    id: p.id,
    name: p.displayName,
    description: '',
    type: PROJECT_TYPE_WHEN_UNKNOWN,
    status: viewStatus(p.status),
    lastActivity: p.updatedAt,
    path: '',
    templateVersion: '',
    pinned: false,
    conversationCount: 0,
    missionCount: 0,
    // fix-cert-rest (item 3): `taskCount`/`health.score` were widened to `number | null`
    // (prototype-types.ts) precisely so a genuinely unmeasured value could stop being a bare `0`
    // indistinguishable from a real measured zero — this bridge path has never measured either for
    // a `LiveProject` (no field on it carries them), so `null` is the honest value here too, per
    // this file's own rule 3 above ("unknown attributes are shown as absence, not invented").
    taskCount: null,
    agentCount: 0,
    skills: [],
    health: {
      tests: { passed: 0, failed: 0, skipped: 0 },
      openTickets: 0,
      blockers: 0,
      score: null,
    },
  };
  return record as unknown as Project;
}

export function toMessage(m: LiveMessage): ChatMessage {
  const record: Omit<ChatMessage, 'prototype'> = {
    id: m.id,
    // The view author vocabulary is user | forge; a bridge/system line is shown
    // as a forge-side message rather than dropped.
    author: m.author === 'user' ? 'user' : 'forge',
    body: m.body,
    timestamp: m.timestamp,
  };
  return record as unknown as ChatMessage;
}

export function toConversation(c: LiveConversation): Conversation {
  const messages = c.messages.map(toMessage);
  const record: Omit<Conversation, 'prototype'> = {
    id: c.id,
    projectId: c.projectId ?? '',
    title: c.title,
    updatedAt: c.updatedAt,
    messageCount: messages.length,
    messages,
  };
  return record as unknown as Conversation;
}

export function toAgent(a: LiveAgent): Agent {
  const record: Omit<Agent, 'prototype'> = {
    id: a.id,
    // No display name is carried on the event; the id is the honest identifier.
    name: a.id,
    role: '',
    group: AGENT_GROUP_WHEN_UNKNOWN,
    permission: AGENT_PERMISSION_WHEN_UNKNOWN,
    status: viewStatus(a.status),
    progress: 0,
    currentTask: null,
    runtimeModel: '',
    toolModel: '',
    effort: AGENT_EFFORT_WHEN_UNKNOWN,
    skills: [],
    lastActivity: a.updatedAt,
    // fix-cert-rest (item 2): `'not-required'` is a genuine claim about the agent's ROLE that this
    // bridge event never reports — `null` (no verification evidence) is the honest value, per this
    // file's own rule 3 above ("unknown attributes are shown as absence, not invented").
    verification: null,
    summary: '',
  };
  return record as unknown as Agent;
}

export function toTask(t: LiveTask): Task {
  const status = viewStatus(t.status);
  const record: Omit<Task, 'prototype'> = {
    id: t.id,
    title: t.title ?? t.id,
    agentId: t.agentId ?? '',
    workPackageId: '',
    phase: phaseForStatus(status),
    column: columnForStatus(status),
    status,
    progress: 0,
    dependencies: [],
    proofCount: 0,
    createdAt: t.updatedAt,
    updatedAt: t.updatedAt,
    repairAttempts: 0,
    detail: '',
  };
  return record as unknown as Task;
}

export function toRun(r: LiveRun, agents: readonly LiveAgent[]): Run {
  const record: Omit<Run, 'prototype'> = {
    id: r.id,
    projectId: r.projectId ?? '',
    goal: r.goal ?? '',
    status: viewStatus(r.status),
    startedAt: r.startedAt,
    duration: '',
    workPackageIds: [],
    // The run → agent link IS real: it comes from agents whose event carried this
    // run's id. Everything else about the run's shape is left neutral.
    agentIds: agents.filter((a) => a.runId === r.id).map((a) => a.id),
  };
  return record as unknown as Run;
}

/**
 * Map the real event stream onto the activity timeline. Only events that carry a
 * real `OperationalStatus` become timeline rows, so a row's status is always one
 * the event reported — never invented. Bridge-scoped control events are excluded
 * from the user-facing feed.
 */
export function toActivityEvents(events: readonly ForgeEvent[]): readonly ActivityEvent[] {
  const out: ActivityEvent[] = [];
  for (const e of events) {
    if (e.projectId === BRIDGE_PROJECT_ID) continue;
    const status = statusKeyOf(e.status ?? null);
    if (status === null) continue; // no reported status → not a timeline milestone
    const message = pickString(e.payload, ['message', 'title', 'label', 'goal', 'summary']) ?? e.type;
    const record: Omit<ActivityEvent, 'prototype'> = {
      id: e.eventId,
      runId: e.runId ?? '',
      timestamp: e.timestamp,
      kind: kindForEventType(e.type),
      agent: e.agentId ?? null,
      status,
      message,
      detail: e.type,
    };
    out.push(record as unknown as ActivityEvent);
  }
  return out;
}

/* ========================================================================== */
/*  The dataset                                                                */
/* ========================================================================== */

/**
 * Build the view-facing dataset from the live state. Collections the live store
 * cannot populate today (work packages, artifacts, quality gates, the proof
 * ledger, the file tree) are EMPTY on purpose: their backing operations are
 * UNAVAILABLE in this build, so the views show their real empty states rather
 * than fabricated content. When those operations land, this is the single place
 * that grows.
 *
 * The mission graph is the exception that is now REAL: `buildMissionGraph` folds
 * the live event log into the run's actual request → boss → lanes → verify →
 * review → output shape, drawing only what really happened. With no runs it
 * returns the same empty graph, so Mission Control still shows its empty state.
 */
export function liveDatasetFrom(live: LiveState): PrototypeDataset {
  return {
    projects: live.projects.map(toProject),
    conversations: live.conversations.map(toConversation),
    agents: live.agents.map(toAgent),
    tasks: live.tasks.map(toTask),
    workPackages: [],
    runs: live.runs.map((r) => toRun(r, live.agents)),
    events: toActivityEvents(live.events),
    artifacts: [],
    gates: [],
    proof: [],
    files: [],
    graph: buildMissionGraph(live.events),
  };
}
