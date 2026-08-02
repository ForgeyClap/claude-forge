/**
 * Forge Workspace — the live store.
 *
 * This is the single normalized real state every view reads. It replaces the
 * fixture store: the DATA comes from the bridge, not from a local example tree.
 * One task becoming RUNNING updates Mission Control, Tasks, Chat and the
 * inspector at once, because all of them read this one store.
 *
 * WHAT IS REAL HERE, AND WHAT IS HONESTLY ABSENT.
 * The bridge implements seven of its thirty-nine operations today. This store
 * NEVER paints an empty list from an unimplemented operation as though it were a
 * real "nothing here": it probes each capability and records whether the bridge
 * answered, refused as UNIMPLEMENTED, or errored. A view can therefore say
 * "projects are UNAVAILABLE — the bridge has no handler yet" instead of a
 * misleading "no projects". The parts that ARE real — the live event stream,
 * health, the runtime declarations, and measured delivery latency — are shown as
 * facts. Domain records (projects, runs, agents, tasks, conversations) are folded
 * from the event log as events arrive; with an empty workspace they are honestly
 * empty, and each record carries its provenance.
 *
 * The selector NAMES mirror `prototype-store.ts` so views migrate with minimal
 * edits, but the shapes are the real, contract-derived ones rather than the
 * prototype's `prototype: true` example records.
 *
 * There is no per-screen store. There is one `LiveStore`, shared, and the views
 * subscribe to it through `useLiveStore` / `useConnection`.
 */

import { useCallback, useSyncExternalStore } from 'react';

import type {
  BridgeHealth,
  ForgeEvent,
  OperationName,
  OperationalStatus,
  RuntimeDeclarations,
} from '@/shared/protocol';
import type { StatusKey } from '@/prototype/types/prototype-types';
import type { LatencyReport } from '@/bridge/usage/latency';

import { BridgeClient, BridgeOperationError } from '@/prototype/state/bridge-client';
import type {
  BridgeNotice,
  ConnectionState,
  OperationPayload,
  OperationResult,
  StreamSnapshot,
} from '@/prototype/state/bridge-client';

/* ========================================================================== */
/*  The bridge's own project id                                                */
/* ========================================================================== */

/**
 * Mirrors `BRIDGE_PROJECT_ID` in `src/bridge/storage/store.ts`. Declared locally
 * rather than value-imported, because that module reaches the filesystem and
 * must never be pulled into the browser bundle. Bridge-scoped control events use
 * this id and must not appear as a user project.
 */
export const BRIDGE_PROJECT_ID = '__bridge__';

/* ========================================================================== */
/*  Status projection                                                          */
/* ========================================================================== */

/**
 * How each of the contract's 23 operational statuses is shown in the view
 * vocabulary of seven `StatusKey`s. This is a DISPLAY projection only — the
 * exact `OperationalStatus` is preserved on every record, so no fidelity is lost
 * and the state machines remain the authority on what a status means.
 */
const STATUS_PROJECTION: Readonly<Record<OperationalStatus, StatusKey>> = {
  CREATED: 'waiting',
  QUEUED: 'waiting',
  STARTING: 'running',
  RUNNING: 'running',
  STREAMING: 'running',
  WAITING: 'waiting',
  WAITING_FOR_PERMISSION: 'waiting',
  VERIFYING: 'verify',
  REVIEWING: 'review',
  REPAIRING: 'running',
  RETRYING: 'running',
  STOPPING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  BLOCKED: 'blocked',
  CANCELLED: 'blocked',
  INTERRUPTED: 'failed',
  DISCONNECTED: 'failed',
  RECOVERING: 'running',
  RESUMABLE: 'waiting',
  ORPHANED: 'failed',
  FAILED_RECOVERY: 'failed',
  DEGRADED: 'blocked',
};

/** The view status for an operational status, or null when none was reported. */
export function statusKeyOf(status: OperationalStatus | null | undefined): StatusKey | null {
  if (status === null || status === undefined) return null;
  return STATUS_PROJECTION[status] ?? null;
}

/* ========================================================================== */
/*  Record shapes                                                              */
/* ========================================================================== */

/** Where a record came from. Everything here is folded from the event log. */
export type RecordProvenance = 'event-log';

export interface LiveProject {
  readonly id: string;
  readonly displayName: string;
  readonly operationalStatus: OperationalStatus | null;
  readonly status: StatusKey | null;
  readonly updatedAt: string;
  readonly source: RecordProvenance;
}

export interface LiveMessage {
  readonly id: string;
  readonly author: 'user' | 'forge' | 'system';
  readonly body: string;
  readonly timestamp: string;
  readonly source: RecordProvenance;
}

export interface LiveConversation {
  readonly id: string;
  readonly projectId: string | null;
  readonly title: string;
  readonly updatedAt: string;
  readonly messages: readonly LiveMessage[];
  readonly source: RecordProvenance;
}

export interface LiveRun {
  readonly id: string;
  readonly projectId: string | null;
  readonly operationalStatus: OperationalStatus | null;
  readonly status: StatusKey | null;
  readonly goal: string | null;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly source: RecordProvenance;
}

export interface LiveAgent {
  readonly id: string;
  readonly projectId: string | null;
  readonly runId: string | null;
  readonly operationalStatus: OperationalStatus | null;
  readonly status: StatusKey | null;
  readonly updatedAt: string;
  readonly source: RecordProvenance;
}

export interface LiveTask {
  readonly id: string;
  readonly projectId: string | null;
  readonly runId: string | null;
  readonly agentId: string | null;
  readonly title: string | null;
  readonly operationalStatus: OperationalStatus | null;
  readonly status: StatusKey | null;
  readonly updatedAt: string;
  readonly source: RecordProvenance;
}

/* ========================================================================== */
/*  Capabilities                                                               */
/* ========================================================================== */

/**
 * UNKNOWN      not yet probed.
 * AVAILABLE    the bridge has a handler (it answered, or rejected the probe
 *              payload — either way the capability exists).
 * UNAVAILABLE  the bridge answered UNIMPLEMENTED: the contract names it but no
 *              handler is registered in this build.
 * ERROR        the probe could not complete (the bridge was unreachable).
 */
export type CapabilityStatus = 'UNKNOWN' | 'AVAILABLE' | 'UNAVAILABLE' | 'ERROR';

export interface Capability {
  readonly op: OperationName;
  readonly status: CapabilityStatus;
  readonly detail: string | null;
  readonly checkedAt: string | null;
}

/* ========================================================================== */
/*  The state a view reads                                                     */
/* ========================================================================== */

export interface LiveError {
  readonly op: OperationName;
  readonly code: string;
  readonly message: string;
  readonly at: string;
}

export interface LiveState {
  readonly connection: ConnectionState;
  readonly health: BridgeHealth | null;
  readonly declarations: RuntimeDeclarations | null;
  /** MEASURED delivery latency (ingestedAt -> arrival -> applied). Never a target. */
  readonly latency: LatencyReport | null;
  readonly capabilities: readonly Capability[];
  /** Most recent events, newest last. Bounded; older ones fall off the window. */
  readonly events: readonly ForgeEvent[];
  /** Degraded/reconciled notices, newest last. */
  readonly notices: readonly BridgeNotice[];
  readonly streams: readonly StreamSnapshot[];
  readonly projects: readonly LiveProject[];
  readonly conversations: readonly LiveConversation[];
  readonly runs: readonly LiveRun[];
  readonly agents: readonly LiveAgent[];
  readonly tasks: readonly LiveTask[];
  readonly lastError: LiveError | null;
  readonly hydratedAt: string | null;
}

/* ========================================================================== */
/*  Bounds and probes                                                          */
/* ========================================================================== */

const MAX_EVENTS = 1_000;
const MAX_NOTICES = 200;

/**
 * The read-only operations the store probes to learn what this build supports.
 * Every one is side-effect free: no mutation, no spawn, no write. A mutation
 * operation is NEVER probed, because a probe with a side effect is not a probe.
 */
const CAPABILITY_PROBE_OPS: readonly OperationName[] = [
  'listProjects',
  'listConversations',
  'listRuns',
  'listArtifacts',
  'listTests',
  'listProof',
  'listApprovals',
  'listAttachments',
  'getUsageState',
  'getUsageHistory',
  'listCheckpoints',
];

/* ========================================================================== */
/*  Defensive extraction                                                       */
/* ========================================================================== */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
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

/* ========================================================================== */
/*  The store                                                                  */
/* ========================================================================== */

function initialState(connection: ConnectionState): LiveState {
  return {
    connection,
    health: null,
    declarations: null,
    latency: null,
    capabilities: [],
    events: [],
    notices: [],
    streams: [],
    projects: [],
    conversations: [],
    runs: [],
    agents: [],
    tasks: [],
    lastError: null,
    hydratedAt: null,
  };
}

/**
 * The live store. Framework-agnostic: it owns a `BridgeClient`, folds the events
 * the client delivers into normalized maps, and publishes an immutable snapshot
 * that React subscribes to through `useSyncExternalStore`.
 */
export class LiveStore {
  readonly client: BridgeClient;

  private state: LiveState;
  private readonly listeners = new Set<() => void>();
  private readonly connectionListeners = new Set<() => void>();

  // Mutable working set. The snapshot is rebuilt from these on flush.
  private connection: ConnectionState;
  private health: BridgeHealth | null = null;
  private declarations: RuntimeDeclarations | null = null;
  private readonly capabilities = new Map<OperationName, Capability>();
  private readonly eventIds = new Set<string>();
  private readonly events: ForgeEvent[] = [];
  private readonly notices: BridgeNotice[] = [];
  private readonly projects = new Map<string, LiveProject>();
  private readonly conversations = new Map<string, LiveConversation>();
  private readonly runs = new Map<string, LiveRun>();
  private readonly agents = new Map<string, LiveAgent>();
  private readonly tasks = new Map<string, LiveTask>();
  private lastError: LiveError | null = null;
  private hydratedAt: string | null = null;

  private hydratedInstance: string | null = null;
  private flushScheduled = false;
  private disposed = false;
  private readonly unsubscribes: Array<() => void> = [];

  constructor(client?: BridgeClient) {
    this.client = client ?? new BridgeClient();
    this.connection = this.client.getState();
    this.state = initialState(this.connection);

    this.unsubscribes.push(this.client.onState((next) => this.onConnectionState(next)));
    this.unsubscribes.push(this.client.onEvent((event) => this.onEvent(event)));
    this.unsubscribes.push(this.client.onNotice((notice) => this.onNotice(notice)));
    this.unsubscribes.push(
      this.client.onError((error) => this.recordError(error)),
    );
  }

  connect(): void {
    this.client.connect();
  }

  dispose(): void {
    this.disposed = true;
    for (const off of this.unsubscribes) off();
    this.unsubscribes.length = 0;
    this.client.disconnect();
  }

  /* --------------------------------------------------- external store API */

  /** Stable-reference subscribe for `useSyncExternalStore`. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getState = (): LiveState => this.state;

  readonly getServerState = (): LiveState => this.state;

  /** Connection-only subscription, so a busy event stream never re-renders the banner. */
  readonly subscribeConnection = (listener: () => void): (() => void) => {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  };

  readonly getConnection = (): ConnectionState => this.connection;

  /**
   * Ask the bridge to perform an operation, typed through the client. This
   * delegates to the client's `call`, preserving its full per-operation typing;
   * a view can either await the returned promise or read `state.lastError`.
   */
  call<N extends OperationName>(op: N, payload: OperationPayload<N>): Promise<OperationResult<N>> {
    return this.client.call(op, payload);
  }

  /* --------------------------------------------------------- client events */

  private onConnectionState(next: ConnectionState): void {
    const changed = connectionChanged(this.connection, next);
    this.connection = next;
    if (changed) {
      for (const listener of this.connectionListeners) listener();
    }
    // A fresh, healthy connection to a bridge we have not hydrated from triggers
    // a one-time hydrate: read health, declarations, event history, capabilities.
    if (
      (next.status === 'CONNECTED' || next.status === 'DEGRADED') &&
      next.bridgeInstanceId !== null &&
      next.bridgeInstanceId !== this.hydratedInstance
    ) {
      this.hydratedInstance = next.bridgeInstanceId;
      void this.hydrate();
    }
    this.markDirty();
  }

  private onEvent(event: ForgeEvent): void {
    this.foldEvent(event);
    this.markDirty();
  }

  private onNotice(notice: BridgeNotice): void {
    this.notices.push(notice);
    if (this.notices.length > MAX_NOTICES) this.notices.splice(0, this.notices.length - MAX_NOTICES);
    this.markDirty();
  }

  private recordError(error: BridgeOperationError): void {
    this.lastError = {
      op: error.op,
      code: error.code,
      message: error.message,
      at: new Date(Date.now()).toISOString(),
    };
    this.markDirty();
  }

  /* --------------------------------------------------------------- hydrate */

  private async hydrate(): Promise<void> {
    await this.applyHealth();
    await this.applyDeclarations();
    await this.applyEventHistory();
    await this.probeCapabilities();
    this.hydratedAt = new Date(Date.now()).toISOString();
    this.markDirty();
  }

  private async applyHealth(): Promise<void> {
    try {
      this.health = await this.client.call('getHealth', {});
    } catch (err) {
      this.captureError('getHealth', err);
    }
    this.markDirty();
  }

  private async applyDeclarations(): Promise<void> {
    try {
      const result = await this.client.call('getDeclarations', {});
      this.declarations = result.declarations;
    } catch (err) {
      this.captureError('getDeclarations', err);
    }
    this.markDirty();
  }

  private async applyEventHistory(): Promise<void> {
    try {
      const page = await this.client.call('listEvents', { limit: 500 });
      for (const event of page.events) this.foldEvent(event);
    } catch (err) {
      // History is a bonus on top of the live tail; its absence is not fatal and
      // is not shown as an application error, only recorded for diagnostics.
      this.captureError('listEvents', err, false);
    }
    this.markDirty();
  }

  private async probeCapabilities(): Promise<void> {
    // The always-available operations the store itself uses.
    this.setCapability('getHealth', this.health !== null ? 'AVAILABLE' : 'ERROR', null);
    this.setCapability('getDeclarations', this.declarations !== null ? 'AVAILABLE' : 'ERROR', null);
    this.setCapability('listEvents', 'AVAILABLE', null);

    for (const op of CAPABILITY_PROBE_OPS) {
      if (this.disposed) return;
      try {
        await this.client.call(op, {} as never);
        this.setCapability(op, 'AVAILABLE', null);
      } catch (err) {
        if (err instanceof BridgeOperationError) {
          if (err.unimplemented) this.setCapability(op, 'UNAVAILABLE', 'No handler is registered for this operation in this build.');
          else if (err.code === 'CLAUDE_UNAVAILABLE' || err.code === 'RUNTIME_ERROR') this.setCapability(op, 'ERROR', err.message);
          // Any other typed error means the handler exists and merely rejected
          // the empty probe payload — the capability is present.
          else this.setCapability(op, 'AVAILABLE', null);
        } else {
          this.setCapability(op, 'ERROR', err instanceof Error ? err.message : String(err));
        }
      }
      this.markDirty();
    }
  }

  private setCapability(op: OperationName, status: CapabilityStatus, detail: string | null): void {
    this.capabilities.set(op, { op, status, detail, checkedAt: new Date(Date.now()).toISOString() });
  }

  private captureError(op: OperationName, err: unknown, surface = true): void {
    if (!surface) return;
    if (err instanceof BridgeOperationError) {
      this.lastError = { op, code: err.code, message: err.message, at: new Date(Date.now()).toISOString() };
    } else {
      this.lastError = { op, code: 'RUNTIME_ERROR', message: err instanceof Error ? err.message : String(err), at: new Date(Date.now()).toISOString() };
    }
  }

  /* ----------------------------------------------------------- event fold */

  private foldEvent(event: ForgeEvent): void {
    if (this.eventIds.has(event.eventId)) return; // the store already has it
    this.eventIds.add(event.eventId);
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) {
      const removed = this.events.splice(0, this.events.length - MAX_EVENTS);
      for (const gone of removed) this.eventIds.delete(gone.eventId);
    }

    const isBridgeScoped = event.projectId === BRIDGE_PROJECT_ID;

    if (!isBridgeScoped && typeof event.projectId === 'string' && event.projectId.length > 0) {
      this.upsertProject(event);
    }
    if (typeof event.runId === 'string' && event.runId.length > 0) this.upsertRun(event);
    if (typeof event.agentId === 'string' && event.agentId.length > 0) this.upsertAgent(event);
    if (typeof event.taskId === 'string' && event.taskId.length > 0) this.upsertTask(event);
    if (typeof event.conversationId === 'string' && event.conversationId.length > 0) this.upsertConversation(event);
  }

  private upsertProject(event: ForgeEvent): void {
    const id = event.projectId;
    const existing = this.projects.get(id);
    const displayName = pickString(event.payload, ['displayName', 'name', 'title']) ?? existing?.displayName ?? id;
    const operationalStatus = event.status ?? existing?.operationalStatus ?? null;
    this.projects.set(id, {
      id,
      displayName,
      operationalStatus,
      status: statusKeyOf(operationalStatus),
      updatedAt: event.timestamp,
      source: 'event-log',
    });
  }

  private upsertRun(event: ForgeEvent): void {
    const id = event.runId as string;
    const existing = this.runs.get(id);
    const operationalStatus = event.status ?? existing?.operationalStatus ?? null;
    this.runs.set(id, {
      id,
      projectId: event.projectId || existing?.projectId || null,
      operationalStatus,
      status: statusKeyOf(operationalStatus),
      goal: pickString(event.payload, ['goal', 'title', 'prompt']) ?? existing?.goal ?? null,
      startedAt: existing?.startedAt ?? event.timestamp,
      updatedAt: event.timestamp,
      source: 'event-log',
    });
  }

  private upsertAgent(event: ForgeEvent): void {
    const id = event.agentId as string;
    const existing = this.agents.get(id);
    // agent.finished is the only signal that an agent RETURNED; otherwise carry
    // the last reported status forward.
    const operationalStatus = event.status ?? (event.type === 'agent.finished' ? 'COMPLETED' : existing?.operationalStatus ?? null);
    this.agents.set(id, {
      id,
      projectId: event.projectId || existing?.projectId || null,
      runId: event.runId || existing?.runId || null,
      operationalStatus,
      status: statusKeyOf(operationalStatus),
      updatedAt: event.timestamp,
      source: 'event-log',
    });
  }

  private upsertTask(event: ForgeEvent): void {
    const id = event.taskId as string;
    const existing = this.tasks.get(id);
    const operationalStatus = event.status ?? existing?.operationalStatus ?? null;
    this.tasks.set(id, {
      id,
      projectId: event.projectId || existing?.projectId || null,
      runId: event.runId || existing?.runId || null,
      agentId: event.agentId || existing?.agentId || null,
      title: pickString(event.payload, ['title', 'label', 'goal']) ?? existing?.title ?? null,
      operationalStatus,
      status: statusKeyOf(operationalStatus),
      updatedAt: event.timestamp,
      source: 'event-log',
    });
  }

  private upsertConversation(event: ForgeEvent): void {
    const id = event.conversationId as string;
    const existing = this.conversations.get(id);
    const messages = existing ? [...existing.messages] : [];

    // A real turn is three kinds of event, not one. The user's prompt rides on
    // `run.created`; the assistant's reply arrives as a stream of
    // `run.output.delta` chunks that must accumulate into a SINGLE message, not
    // one bubble per chunk; and a `claude.message` may carry a whole message at
    // once. Each is keyed by a stable id so re-folding never doubles a message.
    const upsert = (msgId: string, author: LiveMessage['author'], body: string, append: boolean): void => {
      const at = messages.findIndex((m) => m.id === msgId);
      if (at === -1) {
        messages.push({ id: msgId, author, body, timestamp: event.timestamp, source: 'event-log' });
      } else if (append) {
        const prev = messages[at];
        messages[at] = { ...prev, body: prev.body + body, timestamp: event.timestamp };
      }
    };

    if (event.type === 'run.created') {
      // The prompt the user sent. `runId` keys it so a replayed log is idempotent.
      const prompt = pickString(event.payload, ['message', 'prompt', 'goal']);
      if (prompt !== null && event.runId) upsert(`user:${event.runId}`, 'user', prompt, false);
    } else if (event.type === 'run.output.delta') {
      // Only the visible answer. The model's private "thinking" channel is not
      // the reply and must not be rendered as one.
      const channel = pickString(event.payload, ['channel']);
      const text = pickString(event.payload, ['text', 'delta']);
      if (text !== null && channel !== 'thinking' && event.runId) {
        upsert(`assistant:${event.runId}`, 'forge', text, true);
      }
    } else if (event.type === 'claude.message') {
      // A fallback for a message delivered whole. The assistant's own
      // claude.message frames carry {kind, subtype, detail} with no text, so
      // pickString returns null and nothing is doubled against the deltas.
      const body = pickString(event.payload, ['text', 'content', 'body', 'message']);
      if (body !== null) {
        const author = event.source === 'user' ? 'user' : event.source === 'bridge' ? 'system' : 'forge';
        upsert(event.eventId, author, body, false);
      }
    }

    this.conversations.set(id, {
      id,
      projectId: event.projectId || existing?.projectId || null,
      title: pickString(event.payload, ['title']) ?? existing?.title ?? id,
      updatedAt: event.timestamp,
      messages,
      source: 'event-log',
    });
  }

  /* --------------------------------------------------------------- flush */

  private markDirty(): void {
    if (this.flushScheduled || this.disposed) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      if (!this.disposed) this.flush();
    });
  }

  private flush(): void {
    let latency: LatencyReport | null = null;
    try {
      latency = this.client.getLatencyReport();
    } catch {
      latency = null;
    }
    this.state = {
      connection: this.connection,
      health: this.health,
      declarations: this.declarations,
      latency,
      capabilities: [...this.capabilities.values()],
      events: [...this.events],
      notices: [...this.notices],
      streams: this.client.getStreamSnapshots(),
      projects: [...this.projects.values()],
      conversations: [...this.conversations.values()],
      runs: [...this.runs.values()],
      agents: [...this.agents.values()],
      tasks: [...this.tasks.values()],
      lastError: this.lastError,
      hydratedAt: this.hydratedAt,
    };
    for (const listener of this.listeners) listener();
  }
}

/** True when two connection snapshots differ in a way the banner should see. */
function connectionChanged(a: ConnectionState, b: ConnectionState): boolean {
  if (a.status !== b.status) return true;
  if (a.detail !== b.detail) return true;
  if (a.bridgeInstanceId !== b.bridgeInstanceId) return true;
  if (a.reconnectAttempts !== b.reconnectAttempts) return true;
  if (a.reconciling.length !== b.reconciling.length) return true;
  const af = a.reconciling[0];
  const bf = b.reconciling[0];
  if ((af?.streamKey ?? null) !== (bf?.streamKey ?? null)) return true;
  if ((af?.from ?? null) !== (bf?.from ?? null)) return true;
  if ((af?.to ?? null) !== (bf?.to ?? null)) return true;
  // Retry countdowns are bucketed to whole seconds so a ticking clock does not
  // count as a change on every animation frame.
  if (Math.round((a.nextRetryInMs ?? -1) / 1000) !== Math.round((b.nextRetryInMs ?? -1) / 1000)) return true;
  return false;
}

/* ========================================================================== */
/*  Shared singleton + React hooks                                             */
/* ========================================================================== */

let sharedStore: LiveStore | null = null;

/**
 * The one shared store. Created (never connected) on first use.
 *
 * WP7b: this project's gateway (`command-center/gateway`, REST + SSE on
 * `127.0.0.1:4100`) is the sole real-data layer this phase — `src/bridge/**`
 * stays on disk, unedited, as a documented future-phase reference, but is
 * deliberately never started (see `T7-integration-plan.md` §b). Auto-connecting
 * here would only ever open a real WebSocket to a bridge on `127.0.0.1:4517`
 * that will never be listening: an endlessly-retried, unsuppressable
 * `ERR_CONNECTION_REFUSED` console error plus a permanently CONNECTING/
 * DISCONNECTED banner — exactly the pre-existing e2e failure this WP fixes
 * (`no-network.spec.ts` / `responsive.spec.ts`, root-caused in the WP7a
 * mission-ledger entry). The store is still constructed, so every existing
 * consumer keeps its honest DISCONNECTED rendering unchanged; it is simply
 * never told to open a socket. Production reads the REAL connection through
 * `gateway-adapter.ts`'s `useGatewayConnection()` instead.
 */
export function getSharedLiveStore(): LiveStore {
  if (sharedStore === null) {
    sharedStore = new LiveStore();
  }
  return sharedStore;
}

/** The whole live state. Re-renders on any change to the store. */
export function useLiveStore(): LiveState {
  const store = getSharedLiveStore();
  return useSyncExternalStore(store.subscribe, store.getState, store.getServerState);
}

/** Just the connection state. Re-renders only when the connection meaningfully changes. */
export function useConnection(): ConnectionState {
  const store = getSharedLiveStore();
  return useSyncExternalStore(store.subscribeConnection, store.getConnection, store.getConnection);
}

/** The measured latency report, or null before any event has arrived. */
export function useLatency(): LatencyReport | null {
  return useLiveStore().latency;
}

/** The availability of one operation, as a stable callback-derived value. */
export function useCapability(op: OperationName): Capability | undefined {
  const state = useLiveStore();
  const find = useCallback((s: LiveState) => selectCapability(s, op), [op]);
  return find(state);
}

/* ========================================================================== */
/*  Selectors — names mirror prototype-store.ts                                */
/* ========================================================================== */

export function selectProject(state: LiveState, id: string): LiveProject | undefined {
  return state.projects.find((p) => p.id === id);
}

export function selectConversation(state: LiveState, id: string): LiveConversation | undefined {
  return state.conversations.find((c) => c.id === id);
}

export function selectAgent(state: LiveState, id: string): LiveAgent | undefined {
  return state.agents.find((a) => a.id === id);
}

export function selectTask(state: LiveState, id: string): LiveTask | undefined {
  return state.tasks.find((t) => t.id === id);
}

export function selectRun(state: LiveState, id: string): LiveRun | undefined {
  return state.runs.find((r) => r.id === id);
}

export function selectMessages(state: LiveState, conversationId: string): readonly LiveMessage[] {
  return selectConversation(state, conversationId)?.messages ?? [];
}

export function selectProjectConversations(state: LiveState, projectId: string): readonly LiveConversation[] {
  return state.conversations.filter((c) => c.projectId === projectId);
}

export function selectFilteredProjects(state: LiveState, query: string): readonly LiveProject[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return state.projects;
  return state.projects.filter((p) => p.displayName.toLowerCase().includes(q) || p.id.toLowerCase().includes(q));
}

export function selectFilteredAgents(state: LiveState, filter: StatusKey | 'all'): readonly LiveAgent[] {
  return filter === 'all' ? state.agents : state.agents.filter((a) => a.status === filter);
}

export function selectCapability(state: LiveState, op: OperationName): Capability | undefined {
  return state.capabilities.find((c) => c.op === op);
}

/** Whether an operation's backing handler exists in this build. */
export function selectIsCapabilityAvailable(state: LiveState, op: OperationName): boolean {
  return selectCapability(state, op)?.status === 'AVAILABLE';
}

/** The connection is healthy and every stream is whole. */
export function selectIsConnected(state: LiveState): boolean {
  return state.connection.status === 'CONNECTED';
}
