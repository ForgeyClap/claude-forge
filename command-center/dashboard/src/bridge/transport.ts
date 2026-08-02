/**
 * Forge Workspace — the real-time transport.
 *
 * This module answers one question for every connected client: HAS THIS CLIENT
 * SEEN EVERY EVENT ON THE STREAMS IT SUBSCRIBES TO? A UI that renders an
 * incomplete timeline as though it were complete is a UI that lies, and it does
 * so silently, which is the worst kind.
 *
 * The mechanics that make the answer provable:
 *
 *  SEQUENCE. Every event carries a per-stream monotonic `sequence`, assigned by
 *  the durable store at append time and by nothing else. The transport never
 *  invents one. That is what makes "1, 2, 4" detectable as a hole rather than
 *  three events that happened to arrive.
 *
 *  ACK. A client confirms the highest sequence it has actually processed. The
 *  transport treats the ack, and only the ack, as evidence of delivery. A frame
 *  handed to a socket is not evidence: the socket buffer may still be holding
 *  it when the process dies.
 *
 *  BACKPRESSURE. When a client's socket buffer grows past a threshold the
 *  transport STOPS PUSHING to it. It does not queue in the bridge's heap — an
 *  unbounded per-client queue turns one slow tab into an out-of-memory kill for
 *  the whole workspace. The client is marked degraded, told so, and closes its
 *  own gap with an explicit replay when it can keep up again.
 *
 *  DEGRADED / RECONCILED. `bridge.degraded` is emitted the moment a gap is
 *  known to exist. `bridge.reconciled` is emitted ONLY after the client has
 *  acked a sequence at or beyond the head that was missing. If the client never
 *  acks, the stream stays degraded forever, which is the truthful outcome.
 *
 *  INGESTED-AT. The store stamps `ingestedAt` on every event and every outbound
 *  frame carries `sentAt`, so end-to-end latency is measurable from real
 *  timestamps rather than estimated.
 *
 * The transport does not know what a WebSocket is. It talks to a `TransportSocket`
 * interface, which `server.ts` implements over `ws`. That keeps this file
 * testable without a network and keeps the fan-out logic free of protocol noise.
 */

// node:timers rather than the ambient globals: this project's tsconfig loads the
// DOM lib as well as @types/node, and the two declare different return types for
// setInterval. Importing the Node ones makes `unref()` type-check for certain.
import { clearInterval, setImmediate, setInterval } from 'node:timers';

import type {
  EventType,
  ForgeEvent,
  OperationError,
  OperationRequest,
  OperationResponse,
  InvariantDeclarations,
} from '../shared/protocol.ts';
import type { AppendEventInput, ForgeStore, SequenceGap } from './storage/store.ts';

/* ========================================================================== */
/*  Limits                                                                     */
/* ========================================================================== */

export const TRANSPORT_LIMITS = {
  /** Socket buffer above this and the client is cut off from the live push. */
  HIGH_WATER_BYTES: 1_048_576,
  /** It must drain below this before pushing resumes. Hysteresis, not a knife edge. */
  LOW_WATER_BYTES: 262_144,
  /** Events per replay frame. Bounded so one replay cannot be one huge frame. */
  REPLAY_CHUNK: 250,
  /** Ceiling on a single replay request. Beyond this the client must paginate. */
  MAX_REPLAY_EVENTS: 5_000,
  /** A client may not subscribe to more streams than this. */
  MAX_SUBSCRIPTIONS: 512,
  /** Minimum gap between two degraded notices for the same client and stream. */
  DEGRADED_COOLDOWN_MS: 5_000,
  /** Stream heads carried in a heartbeat frame. Keeps the frame small. */
  MAX_HEADS_IN_HEARTBEAT: 64,
  /** Pending control events (degraded/reconciled) held before dropping. */
  MAX_CONTROL_QUEUE: 200,
  /** Latency samples retained for the p95 in `stats()`. */
  LATENCY_SAMPLES: 256,
  /** How often paused clients are checked for a drained buffer. */
  DRAIN_CHECK_MS: 250,
} as const;

/** Subscribe to this pseudo-stream to follow every stream in the workspace. */
export const ALL_STREAMS = '*';

/* ========================================================================== */
/*  The socket seam                                                            */
/* ========================================================================== */

/**
 * Everything the transport needs from a connection. Implemented over `ws` in
 * server.ts and over a plain array in tests.
 *
 * `bufferedBytes` is the whole point of the interface: it is the only honest
 * signal that a client is not keeping up. Without it the transport would have
 * to guess, and guessing here means either dropping events that would have been
 * delivered or buffering until the process dies.
 */
export interface TransportSocket {
  readonly id: string;
  /** A label safe to log: an address and port, never a credential or a header. */
  readonly remoteLabel: string;
  /** Throws if the socket is gone; the transport treats a throw as a disconnect. */
  send(payload: string): void;
  bufferedBytes(): number;
  close(code: number, reason: string): void;
}

/* ========================================================================== */
/*  Frames                                                                     */
/* ========================================================================== */

export interface StreamHead {
  readonly streamKey: string;
  readonly sequence: number;
}

/** Server -> client. Every frame carries `sentAt` so latency is measurable. */
export type ServerFrame =
  | {
      readonly kind: 'hello';
      readonly sentAt: number;
      readonly bridgeInstanceId: string;
      readonly clientId: string;
      readonly protocolSchemaVersion: number;
      readonly heartbeatIntervalMs: number;
      /**
       * The BUILD's invariants only. A derived declaration is a claim about the
       * live system at the moment it was computed, and `hello` is sent whenever
       * a client happens to connect — so shipping one here would hand out a
       * snapshot with no way to tell how old it is. The live half is read from
       * `/api/health` or `getDeclarations`, both of which recompute.
       */
      readonly declarations: InvariantDeclarations;
      readonly limits: typeof TRANSPORT_LIMITS;
    }
  | {
      readonly kind: 'subscribed';
      readonly sentAt: number;
      readonly heads: readonly StreamHead[];
      readonly all: boolean;
      /** Streams asked for that do not exist yet. Not an error — just not there. */
      readonly unknown: readonly string[];
    }
  | { readonly kind: 'event'; readonly sentAt: number; readonly streamKey: string; readonly event: ForgeEvent }
  | {
      readonly kind: 'events';
      readonly sentAt: number;
      readonly streamKey: string;
      readonly reason: 'replay' | 'catch-up';
      readonly fromSequence: number;
      readonly events: readonly ForgeEvent[];
      /** False when more remain — the client must ask again from `nextSequence`. */
      readonly complete: boolean;
      readonly nextSequence: number;
      /** Sequences the durable log itself is missing. These will never arrive. */
      readonly gaps: readonly SequenceGap[];
    }
  | { readonly kind: 'response'; readonly sentAt: number; readonly response: OperationResponse }
  | {
      readonly kind: 'heartbeat';
      readonly sentAt: number;
      readonly uptimeMs: number;
      readonly connectedClients: number;
      /** Current head per subscribed stream: lets a client notice it is behind. */
      readonly heads: readonly StreamHead[];
      readonly degradedStreams: readonly string[];
    }
  | {
      readonly kind: 'notice';
      readonly sentAt: number;
      readonly type: Extract<EventType, 'bridge.degraded' | 'bridge.reconciled'>;
      readonly streamKey: string;
      readonly detail: string;
      readonly fromSequence: number;
      readonly toSequence: number;
    }
  | {
      readonly kind: 'error';
      readonly sentAt: number;
      readonly requestId: string | null;
      readonly error: OperationError;
    };

/** Client -> server. */
export type ClientFrame =
  | { readonly kind: 'subscribe'; readonly streams: readonly string[] }
  | { readonly kind: 'unsubscribe'; readonly streams: readonly string[] }
  | { readonly kind: 'ack'; readonly streamKey: string; readonly sequence: number }
  | { readonly kind: 'replay'; readonly streamKey: string; readonly fromSequence: number; readonly limit?: number }
  | { readonly kind: 'request'; readonly request: OperationRequest }
  | { readonly kind: 'ping' };

/* ========================================================================== */
/*  The sequence sink                                                          */
/* ========================================================================== */

export interface SinkPublishResult {
  readonly event: ForgeEvent;
  readonly streamKey: string;
  readonly deduplicated: boolean;
}

export interface SinkReadResult {
  readonly events: readonly ForgeEvent[];
  readonly hasMore: boolean;
  readonly gaps: readonly SequenceGap[];
  readonly head: number;
}

/**
 * The durable side of the transport, narrowed to four operations.
 *
 * Narrow on purpose: the transport must not be able to reach into records, take
 * checkpoints or touch the lock. It appends, it reads back, it asks where a
 * stream's head is. Anything more would make this file part of the storage
 * layer's blast radius.
 */
export interface SequenceSink {
  publish<P>(input: AppendEventInput<P>): SinkPublishResult;
  read(streamKey: string, fromSequence: number, limit: number): SinkReadResult;
  headOf(streamKey: string): number;
  streams(): readonly string[];
}

/**
 * Wraps the real store.
 *
 * Heads are cached because a heartbeat asks for them every few seconds and the
 * store answers by reading the whole JSONL file. The cache is safe precisely
 * because the store holds an exclusive workspace lock: no other process can
 * append to these logs while this bridge is running, so the only writer is the
 * `publish` path that updates the cache.
 */
export function createStoreSink(store: ForgeStore): SequenceSink {
  const heads = new Map<string, number>();

  const readHeadFromDisk = (streamKey: string): number => {
    // `fromSequence` past the end collects nothing, but the gap report is
    // computed over the whole stream, so this is the cheapest honest way to ask
    // the store where the head is.
    const page = store.readEvents({ streamKey, fromSequence: Number.MAX_SAFE_INTEGER, limit: 1 });
    const report = page.gaps.find((g) => g.streamKey === streamKey);
    return report?.maxSequence ?? 0;
  };

  for (const streamKey of store.listStreams()) heads.set(streamKey, readHeadFromDisk(streamKey));

  return {
    publish<P>(input: AppendEventInput<P>): SinkPublishResult {
      const result = store.appendEvent(input);
      const current = heads.get(result.streamKey) ?? 0;
      if (result.event.sequence > current) heads.set(result.streamKey, result.event.sequence);
      return { event: result.event, streamKey: result.streamKey, deduplicated: result.deduplicated };
    },
    read(streamKey: string, fromSequence: number, limit: number): SinkReadResult {
      const page = store.readEvents({ streamKey, fromSequence, limit });
      const report = page.gaps.find((g) => g.streamKey === streamKey);
      const head = report?.maxSequence ?? heads.get(streamKey) ?? 0;
      if (head > (heads.get(streamKey) ?? 0)) heads.set(streamKey, head);
      return { events: page.events, hasMore: page.hasMore, gaps: report?.gaps ?? [], head };
    },
    headOf(streamKey: string): number {
      const cached = heads.get(streamKey);
      if (cached !== undefined) return cached;
      const head = readHeadFromDisk(streamKey);
      heads.set(streamKey, head);
      return head;
    },
    streams(): readonly string[] {
      const known = new Set<string>(store.listStreams());
      for (const key of heads.keys()) known.add(key);
      return [...known].sort();
    },
  };
}

/* ========================================================================== */
/*  Client state                                                               */
/* ========================================================================== */

interface ClientState {
  readonly id: string;
  readonly socket: TransportSocket;
  readonly connectedAt: number;
  readonly subscriptions: Set<string>;
  all: boolean;
  /** Highest sequence handed to the socket, per stream. Not proof of delivery. */
  readonly sent: Map<string, number>;
  /** Highest sequence the CLIENT confirmed. This is the evidence of delivery. */
  readonly acked: Map<string, number>;
  /** Streams currently known to be incomplete for this client. */
  readonly degraded: Map<string, { readonly from: number; to: number }>;
  readonly lastNoticeAt: Map<string, number>;
  paused: boolean;
  pausedSince: number | null;
  droppedWhilePaused: number;
  framesSent: number;
  bytesSent: number;
  lastActivityAt: number;
  alive: boolean;
}

export interface ClientStats {
  readonly id: string;
  readonly remoteLabel: string;
  readonly connectedAt: string;
  readonly subscriptions: number;
  readonly all: boolean;
  readonly paused: boolean;
  readonly pausedMs: number | null;
  readonly droppedWhilePaused: number;
  readonly degradedStreams: readonly string[];
  readonly framesSent: number;
  readonly bytesSent: number;
  readonly bufferedBytes: number;
  readonly lastActivityAt: string;
}

export interface TransportStats {
  readonly connectedClients: number;
  readonly clients: readonly ClientStats[];
  readonly eventsPublished: number;
  readonly eventsFannedOut: number;
  readonly eventsDroppedToBackpressure: number;
  readonly replayFramesSent: number;
  readonly degradedEmitted: number;
  readonly reconciledEmitted: number;
  readonly controlEventsDropped: number;
  readonly heartbeatsSent: number;
  readonly streams: number;
  /**
   * p95 of (frame sentAt - event ingestedAt) in ms over the recent window, or
   * null when fewer than 8 samples exist. Never a made-up number.
   */
  readonly fanoutLatencyP95Ms: number | null;
  readonly latencySamples: number;
  readonly running: boolean;
}

interface ControlEvent {
  readonly type: Extract<EventType, 'bridge.degraded' | 'bridge.reconciled'>;
  readonly projectId: string;
  readonly runId: string | null;
  readonly payload: Record<string, unknown>;
}

export interface TransportOptions {
  readonly sink: SequenceSink;
  readonly bridgeInstanceId: string;
  readonly heartbeatIntervalMs: number;
  readonly declarations: InvariantDeclarations;
  readonly protocolSchemaVersion: number;
  /** Project id used for bridge-scoped control events. */
  readonly bridgeProjectId: string;
  readonly now?: () => number;
  /** Called for a `request` frame. Set by the server, which owns the router. */
  readonly onRequest?: (clientId: string, request: unknown) => Promise<OperationResponse>;
}

/* ========================================================================== */
/*  Transport                                                                  */
/* ========================================================================== */

export class Transport {
  private readonly sink: SequenceSink;
  private readonly bridgeInstanceId: string;
  private readonly heartbeatIntervalMs: number;
  private readonly declarations: InvariantDeclarations;
  private readonly protocolSchemaVersion: number;
  private readonly bridgeProjectId: string;
  private readonly now: () => number;

  private onRequest: ((clientId: string, request: unknown) => Promise<OperationResponse>) | null;

  private readonly clients = new Map<string, ClientState>();
  private readonly controlQueue: ControlEvent[] = [];
  private readonly latencies: number[] = [];

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private drainTimer: ReturnType<typeof setInterval> | null = null;
  private controlScheduled = false;
  private draining = false;
  private running = false;
  private startedAt = 0;
  private clientCounter = 0;

  private eventsPublished = 0;
  private eventsFannedOut = 0;
  private eventsDropped = 0;
  private replayFrames = 0;
  private degradedEmitted = 0;
  private reconciledEmitted = 0;
  private controlDropped = 0;
  private heartbeatsSent = 0;

  constructor(options: TransportOptions) {
    this.sink = options.sink;
    this.bridgeInstanceId = options.bridgeInstanceId;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs;
    this.declarations = options.declarations;
    this.protocolSchemaVersion = options.protocolSchemaVersion;
    this.bridgeProjectId = options.bridgeProjectId;
    this.now = options.now ?? (() => Date.now());
    this.onRequest = options.onRequest ?? null;
  }

  /* ------------------------------------------------------------ lifecycle */

  setRequestHandler(handler: (clientId: string, request: unknown) => Promise<OperationResponse>): void {
    this.onRequest = handler;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startedAt = this.now();
    this.heartbeatTimer = setInterval(() => this.sendHeartbeats(), this.heartbeatIntervalMs);
    this.drainTimer = setInterval(() => this.checkDrains(), TRANSPORT_LIMITS.DRAIN_CHECK_MS);
    // Timers must not keep the process alive on their own: shutdown decides when
    // the bridge exits, not the heartbeat.
    this.heartbeatTimer.unref();
    this.drainTimer.unref();
  }

  /** Stop the timers and flush any queued control events. Sockets are not closed. */
  stop(): void {
    this.running = false;
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    if (this.drainTimer !== null) clearInterval(this.drainTimer);
    this.heartbeatTimer = null;
    this.drainTimer = null;
    this.drainControlQueue();
  }

  /* --------------------------------------------------------------- clients */

  attach(socket: TransportSocket): string {
    this.clientCounter += 1;
    const id = socket.id;
    const state: ClientState = {
      id,
      socket,
      connectedAt: this.now(),
      subscriptions: new Set<string>(),
      all: false,
      sent: new Map<string, number>(),
      acked: new Map<string, number>(),
      degraded: new Map<string, { from: number; to: number }>(),
      lastNoticeAt: new Map<string, number>(),
      paused: false,
      pausedSince: null,
      droppedWhilePaused: 0,
      framesSent: 0,
      bytesSent: 0,
      lastActivityAt: this.now(),
      alive: true,
    };
    this.clients.set(id, state);
    this.sendFrame(state, {
      kind: 'hello',
      sentAt: this.now(),
      bridgeInstanceId: this.bridgeInstanceId,
      clientId: id,
      protocolSchemaVersion: this.protocolSchemaVersion,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      declarations: this.declarations,
      limits: TRANSPORT_LIMITS,
    });
    return id;
  }

  detach(clientId: string): void {
    this.clients.delete(clientId);
  }

  get connectedClients(): number {
    return this.clients.size;
  }

  /** Total connections accepted since start — including ones since disconnected. */
  get totalConnections(): number {
    return this.clientCounter;
  }

  /* ------------------------------------------------------------- publishing */

  /**
   * Append an event and push it to every subscribed client.
   *
   * The sequence comes back from the sink; the transport never assigns one. If
   * the store refuses the event (an unknown type, a malformed shape) this
   * throws, and the caller finds out — an event that could not be persisted must
   * not be fanned out, or clients would render history the log cannot support.
   */
  publish<P>(input: AppendEventInput<P>): SinkPublishResult {
    const result = this.sink.publish(input);
    this.eventsPublished += 1;
    this.fanOut(result.streamKey, result.event);
    this.scheduleControlDrain();
    return result;
  }

  private fanOut(streamKey: string, event: ForgeEvent): void {
    for (const state of this.clients.values()) {
      if (!state.alive) continue;
      if (!this.isSubscribed(state, streamKey)) continue;

      const alreadySent = state.sent.get(streamKey) ?? 0;
      if (event.sequence <= alreadySent) continue; // a re-publish of something delivered

      if (state.paused) {
        state.droppedWhilePaused += 1;
        this.eventsDropped += 1;
        this.markDegraded(state, streamKey, alreadySent + 1, event.sequence, 'client is paused for backpressure');
        continue;
      }

      if (alreadySent > 0 && event.sequence !== alreadySent + 1) {
        // A hole in the live push. Real causes: the durable log itself has a gap
        // (events were assigned numbers that never reached disk), or a previous
        // send failed. Either way the client's timeline would be incomplete.
        this.markDegraded(state, streamKey, alreadySent + 1, event.sequence - 1, 'sequence gap in the live stream');
      }

      const ok = this.sendFrame(state, { kind: 'event', sentAt: this.now(), streamKey, event });
      if (!ok) continue;
      state.sent.set(streamKey, event.sequence);
      this.eventsFannedOut += 1;
      this.recordLatency(event);
      this.checkBackpressure(state);
    }
  }

  private isSubscribed(state: ClientState, streamKey: string): boolean {
    return state.all || state.subscriptions.has(streamKey);
  }

  /* ---------------------------------------------------------- client frames */

  /**
   * Handle one raw text frame from a client.
   *
   * Every failure path here returns a typed error frame. A malformed frame
   * never throws out of this method, because a client that can crash the
   * transport by sending `}` is a denial of service with a one-byte payload.
   */
  handleClientMessage(clientId: string, raw: string): void {
    const state = this.clients.get(clientId);
    if (state === undefined || !state.alive) return;
    state.lastActivityAt = this.now();

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.sendError(state, null, { code: 'BAD_REQUEST', message: 'Frame is not valid JSON.' });
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      this.sendError(state, null, { code: 'BAD_REQUEST', message: 'Frame must be a JSON object.' });
      return;
    }
    const frame = parsed as Record<string, unknown>;
    const kind = frame.kind;

    switch (kind) {
      case 'subscribe':
        this.handleSubscribe(state, frame.streams);
        return;
      case 'unsubscribe':
        this.handleUnsubscribe(state, frame.streams);
        return;
      case 'ack':
        this.handleAck(state, frame.streamKey, frame.sequence);
        return;
      case 'replay':
        this.handleReplayRequest(state, frame.streamKey, frame.fromSequence, frame.limit);
        return;
      case 'ping':
        this.sendFrame(state, {
          kind: 'heartbeat',
          sentAt: this.now(),
          uptimeMs: this.now() - this.startedAt,
          connectedClients: this.clients.size,
          heads: this.headsFor(state),
          degradedStreams: [...state.degraded.keys()],
        });
        return;
      case 'request':
        void this.handleRequest(state, frame.request);
        return;
      default:
        this.sendError(state, null, {
          code: 'BAD_REQUEST',
          message: 'Unknown frame kind.',
          detail: typeof kind === 'string' ? kind.slice(0, 40) : typeof kind,
        });
    }
  }

  private handleSubscribe(state: ClientState, rawStreams: unknown): void {
    if (!Array.isArray(rawStreams) || rawStreams.length === 0) {
      this.sendError(state, null, { code: 'BAD_REQUEST', message: 'subscribe.streams must be a non-empty array.' });
      return;
    }
    if (rawStreams.length > TRANSPORT_LIMITS.MAX_SUBSCRIPTIONS) {
      this.sendError(state, null, {
        code: 'BAD_REQUEST',
        message: `A client may subscribe to at most ${TRANSPORT_LIMITS.MAX_SUBSCRIPTIONS} streams.`,
      });
      return;
    }
    const known = new Set<string>(this.sink.streams());
    const unknown: string[] = [];
    for (const entry of rawStreams) {
      if (typeof entry !== 'string' || entry.length === 0 || entry.length > 300) {
        this.sendError(state, null, { code: 'BAD_REQUEST', message: 'Each stream key must be a short string.' });
        return;
      }
      if (entry === ALL_STREAMS) {
        state.all = true;
        continue;
      }
      if (state.subscriptions.size >= TRANSPORT_LIMITS.MAX_SUBSCRIPTIONS) break;
      state.subscriptions.add(entry);
      if (!known.has(entry)) unknown.push(entry);
    }

    // Anchor at the current head. Without this the client would look, on its
    // first live event, as though it had missed the entire history — and would
    // be told it was degraded when it simply had not asked for the past yet.
    const heads = this.headsFor(state);
    for (const head of heads) {
      if (!state.sent.has(head.streamKey)) state.sent.set(head.streamKey, head.sequence);
    }
    this.sendFrame(state, { kind: 'subscribed', sentAt: this.now(), heads, all: state.all, unknown });
  }

  private handleUnsubscribe(state: ClientState, rawStreams: unknown): void {
    if (!Array.isArray(rawStreams)) {
      this.sendError(state, null, { code: 'BAD_REQUEST', message: 'unsubscribe.streams must be an array.' });
      return;
    }
    for (const entry of rawStreams) {
      if (typeof entry !== 'string') continue;
      if (entry === ALL_STREAMS) {
        state.all = false;
        continue;
      }
      state.subscriptions.delete(entry);
      state.sent.delete(entry);
      state.acked.delete(entry);
      state.degraded.delete(entry);
    }
    this.sendFrame(state, {
      kind: 'subscribed',
      sentAt: this.now(),
      heads: this.headsFor(state),
      all: state.all,
      unknown: [],
    });
  }

  /**
   * A client confirms it has processed everything up to `sequence`.
   *
   * This is the ONLY place a degraded stream can become reconciled, and it is
   * the reason `bridge.reconciled` means something. The transport does not
   * decide that a gap is closed because it sent some frames; the client says so.
   */
  private handleAck(state: ClientState, rawStream: unknown, rawSequence: unknown): void {
    if (typeof rawStream !== 'string' || rawStream.length === 0 || rawStream.length > 300) {
      this.sendError(state, null, { code: 'BAD_REQUEST', message: 'ack.streamKey must be a string.' });
      return;
    }
    if (typeof rawSequence !== 'number' || !Number.isSafeInteger(rawSequence) || rawSequence < 0) {
      this.sendError(state, null, { code: 'BAD_REQUEST', message: 'ack.sequence must be a non-negative integer.' });
      return;
    }
    const head = this.sink.headOf(rawStream);
    if (rawSequence > head) {
      // The client claims to have seen something that was never written. Do not
      // record it: a false ack would let a genuinely missing range be marked
      // reconciled.
      this.sendError(state, null, {
        code: 'BAD_REQUEST',
        message: 'Acknowledged sequence is beyond the head of that stream.',
        detail: `ack ${rawSequence} > head ${head}`,
      });
      return;
    }
    const previous = state.acked.get(rawStream) ?? 0;
    if (rawSequence <= previous) return;
    state.acked.set(rawStream, rawSequence);

    const gap = state.degraded.get(rawStream);
    if (gap !== undefined && rawSequence >= gap.to) {
      state.degraded.delete(rawStream);
      this.reconciledEmitted += 1;
      this.sendFrame(state, {
        kind: 'notice',
        sentAt: this.now(),
        type: 'bridge.reconciled',
        streamKey: rawStream,
        detail: `client acknowledged sequence ${rawSequence}, which covers the missing range ${gap.from}..${gap.to}`,
        fromSequence: gap.from,
        toSequence: gap.to,
      });
      this.enqueueControl({
        type: 'bridge.reconciled',
        projectId: this.bridgeProjectId,
        runId: null,
        payload: {
          scope: 'client-delivery',
          clientId: state.id,
          streamKey: rawStream,
          from: gap.from,
          to: gap.to,
          acknowledgedSequence: rawSequence,
          evidence: 'client ack covering the previously missing range',
        },
      });
    }
  }

  private handleReplayRequest(
    state: ClientState,
    rawStream: unknown,
    rawFrom: unknown,
    rawLimit: unknown,
  ): void {
    if (typeof rawStream !== 'string' || rawStream.length === 0 || rawStream.length > 300) {
      this.sendError(state, null, { code: 'BAD_REQUEST', message: 'replay.streamKey must be a string.' });
      return;
    }
    if (typeof rawFrom !== 'number' || !Number.isSafeInteger(rawFrom) || rawFrom < 1) {
      this.sendError(state, null, {
        code: 'BAD_REQUEST',
        message: 'replay.fromSequence must be an integer of at least 1.',
      });
      return;
    }
    // Widened to `number` deliberately: TRANSPORT_LIMITS is `as const`, so the
    // inferred type would be the literal 5000 and the clamp below would not
    // assign.
    let limit: number = TRANSPORT_LIMITS.MAX_REPLAY_EVENTS;
    if (rawLimit !== undefined) {
      if (typeof rawLimit !== 'number' || !Number.isSafeInteger(rawLimit) || rawLimit < 1) {
        this.sendError(state, null, { code: 'BAD_REQUEST', message: 'replay.limit must be a positive integer.' });
        return;
      }
      limit = Math.min(rawLimit, TRANSPORT_LIMITS.MAX_REPLAY_EVENTS);
    }
    this.replay(state, rawStream, rawFrom, limit, 'replay');
  }

  private async handleRequest(state: ClientState, rawRequest: unknown): Promise<void> {
    const requestId =
      typeof rawRequest === 'object' && rawRequest !== null && typeof (rawRequest as { requestId?: unknown }).requestId === 'string'
        ? ((rawRequest as { requestId: string }).requestId).slice(0, 128)
        : null;

    if (this.onRequest === null) {
      this.sendError(state, requestId, {
        code: 'RUNTIME_ERROR',
        message: 'No operation router is attached to this transport, so the request cannot be dispatched.',
      });
      return;
    }
    try {
      const response = await this.onRequest(state.id, rawRequest);
      this.sendFrame(state, { kind: 'response', sentAt: this.now(), response });
    } catch (err) {
      // The router is meant to return typed errors rather than throw. If one
      // escapes anyway, the client still gets a typed answer instead of silence.
      this.sendError(state, requestId, {
        code: 'RUNTIME_ERROR',
        message: 'The operation router threw before producing a response.',
        detail: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
      });
    }
  }

  /* ----------------------------------------------------------------- replay */

  /**
   * Send a range of a stream to one client, in bounded chunks.
   *
   * Stops early — and says so with `complete: false` — when the socket buffer
   * fills. A replay that keeps pushing into a full socket is how a catch-up
   * turns into the out-of-memory condition it was supposed to avoid.
   */
  private replay(
    state: ClientState,
    streamKey: string,
    fromSequence: number,
    limit: number,
    reason: 'replay' | 'catch-up',
  ): void {
    let cursor = fromSequence;
    let remaining = limit;
    let complete = true;

    while (remaining > 0) {
      const chunkSize = Math.min(TRANSPORT_LIMITS.REPLAY_CHUNK, remaining);
      const page = this.sink.read(streamKey, cursor, chunkSize);
      const last = page.events.length > 0 ? page.events[page.events.length - 1].sequence : cursor - 1;
      const next = last + 1;

      const more = page.hasMore || (page.events.length === chunkSize && next <= page.head);
      const sent = this.sendFrame(state, {
        kind: 'events',
        sentAt: this.now(),
        streamKey,
        reason,
        fromSequence: cursor,
        events: page.events,
        complete: !more,
        nextSequence: next,
        gaps: page.gaps,
      });
      this.replayFrames += 1;
      if (!sent) return;

      for (const event of page.events) this.recordLatency(event);
      const highest = state.sent.get(streamKey) ?? 0;
      if (last > highest) state.sent.set(streamKey, last);

      remaining -= page.events.length;
      cursor = next;

      if (page.events.length === 0 || !more) break;

      if (this.checkBackpressure(state)) {
        complete = false;
        break;
      }
    }

    if (!complete) {
      this.markDegraded(
        state,
        streamKey,
        cursor,
        this.sink.headOf(streamKey),
        'replay stopped early because the client socket buffer filled',
      );
    }
  }

  /* ---------------------------------------------------------- backpressure */

  /** True when the client is (now) paused. */
  private checkBackpressure(state: ClientState): boolean {
    if (state.paused) return true;
    let buffered: number;
    try {
      buffered = state.socket.bufferedBytes();
    } catch {
      this.killClient(state, 'socket buffer could not be read');
      return true;
    }
    if (buffered < TRANSPORT_LIMITS.HIGH_WATER_BYTES) return false;

    state.paused = true;
    state.pausedSince = this.now();
    const streams = state.all ? this.sink.streams() : [...state.subscriptions];
    for (const streamKey of streams) {
      const sent = state.sent.get(streamKey) ?? 0;
      const head = this.sink.headOf(streamKey);
      if (head > sent) {
        this.markDegraded(state, streamKey, sent + 1, head, `socket buffer reached ${buffered} bytes`);
      }
    }
    return true;
  }

  /**
   * Paused clients whose buffers have drained are caught up from the last
   * sequence they ACKED — not from the last one we sent. If the client never
   * acked, the safe assumption is that it did not receive, and re-sending is
   * harmless because events carry their own sequence and the client can
   * de-duplicate.
   */
  private checkDrains(): void {
    for (const state of this.clients.values()) {
      if (!state.alive || !state.paused) continue;
      let buffered: number;
      try {
        buffered = state.socket.bufferedBytes();
      } catch {
        this.killClient(state, 'socket buffer could not be read');
        continue;
      }
      if (buffered > TRANSPORT_LIMITS.LOW_WATER_BYTES) continue;

      state.paused = false;
      state.pausedSince = null;
      const streams = state.all ? this.sink.streams() : [...state.subscriptions];
      for (const streamKey of streams) {
        const anchor = state.acked.get(streamKey) ?? state.sent.get(streamKey) ?? 0;
        const head = this.sink.headOf(streamKey);
        if (head <= anchor) continue;
        this.replay(state, streamKey, anchor + 1, TRANSPORT_LIMITS.MAX_REPLAY_EVENTS, 'catch-up');
        if (state.paused) break; // filled up again; try on the next tick
      }
    }
    this.drainControlQueue();
  }

  /* -------------------------------------------------- degraded / reconciled */

  /**
   * Record that a client's view of a stream is incomplete.
   *
   * The window only ever widens while it is open: a second gap discovered before
   * the first was closed extends `to`, so reconciliation requires an ack past
   * everything that was missed, not just the most recent hole.
   */
  private markDegraded(
    state: ClientState,
    streamKey: string,
    from: number,
    to: number,
    detail: string,
  ): void {
    if (to < from) return;
    const existing = state.degraded.get(streamKey);
    if (existing === undefined) {
      state.degraded.set(streamKey, { from, to });
    } else {
      if (to > existing.to) existing.to = to;
      // The lower bound of the very first hole is what must be replayed from, so
      // it is never raised.
    }

    const last = state.lastNoticeAt.get(streamKey) ?? 0;
    const now = this.now();
    if (now - last < TRANSPORT_LIMITS.DEGRADED_COOLDOWN_MS) return;
    state.lastNoticeAt.set(streamKey, now);

    const window = state.degraded.get(streamKey);
    if (window === undefined) return;
    this.degradedEmitted += 1;
    this.sendFrame(state, {
      kind: 'notice',
      sentAt: now,
      type: 'bridge.degraded',
      streamKey,
      detail: `${detail}; sequences ${window.from}..${window.to} have not been delivered`,
      fromSequence: window.from,
      toSequence: window.to,
    });
    this.enqueueControl({
      type: 'bridge.degraded',
      projectId: this.bridgeProjectId,
      runId: null,
      payload: {
        scope: 'client-delivery',
        clientId: state.id,
        remote: state.socket.remoteLabel,
        streamKey,
        from: window.from,
        to: window.to,
        reason: detail,
      },
    });
  }

  /**
   * Control events are queued rather than published inline.
   *
   * Publishing from inside a fan-out would re-enter the fan-out — a degraded
   * notice about a slow client is itself an event that must be delivered to
   * clients, one of which is slow. The queue plus a drain on the next tick makes
   * that impossible, and the cap makes a pathological case bounded instead of
   * fatal.
   */
  private enqueueControl(event: ControlEvent): void {
    if (this.controlQueue.length >= TRANSPORT_LIMITS.MAX_CONTROL_QUEUE) {
      this.controlDropped += 1;
      return;
    }
    this.controlQueue.push(event);
    this.scheduleControlDrain();
  }

  private scheduleControlDrain(): void {
    if (this.controlScheduled || this.controlQueue.length === 0) return;
    this.controlScheduled = true;
    setImmediate(() => {
      this.controlScheduled = false;
      this.drainControlQueue();
    });
  }

  private drainControlQueue(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      let guard = 0;
      while (this.controlQueue.length > 0 && guard < TRANSPORT_LIMITS.MAX_CONTROL_QUEUE) {
        guard += 1;
        const event = this.controlQueue.shift();
        if (event === undefined) break;
        try {
          const result = this.sink.publish({
            projectId: event.projectId,
            runId: event.runId,
            source: 'bridge',
            type: event.type,
            ...(event.type === 'bridge.degraded' ? { status: 'DEGRADED' as const } : {}),
            payload: event.payload,
          });
          this.eventsPublished += 1;
          this.fanOut(result.streamKey, result.event);
        } catch {
          // The log rejected or could not take it. Counted, not hidden, and not
          // retried forever — a failing disk must not become a spin loop.
          this.controlDropped += 1;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /* -------------------------------------------------------------- heartbeat */

  private sendHeartbeats(): void {
    const sentAt = this.now();
    const uptimeMs = sentAt - this.startedAt;
    for (const state of this.clients.values()) {
      if (!state.alive) continue;
      this.sendFrame(state, {
        kind: 'heartbeat',
        sentAt,
        uptimeMs,
        connectedClients: this.clients.size,
        heads: this.headsFor(state),
        degradedStreams: [...state.degraded.keys()],
      });
      this.heartbeatsSent += 1;
    }
  }

  private headsFor(state: ClientState): readonly StreamHead[] {
    const keys = state.all ? this.sink.streams() : [...state.subscriptions];
    const heads: StreamHead[] = [];
    for (const streamKey of keys.slice(0, TRANSPORT_LIMITS.MAX_HEADS_IN_HEARTBEAT)) {
      heads.push({ streamKey, sequence: this.sink.headOf(streamKey) });
    }
    return heads;
  }

  /* ------------------------------------------------------------------ send */

  private sendFrame(state: ClientState, frame: ServerFrame): boolean {
    if (!state.alive) return false;
    let payload: string;
    try {
      payload = JSON.stringify(frame);
    } catch {
      // A payload that cannot be serialised (a cycle, a BigInt) is a bug in a
      // producer. Dropping the frame is better than tearing down the socket.
      return false;
    }
    try {
      state.socket.send(payload);
    } catch {
      this.killClient(state, 'send failed');
      return false;
    }
    state.framesSent += 1;
    state.bytesSent += payload.length;
    return true;
  }

  private sendError(state: ClientState, requestId: string | null, error: OperationError): void {
    this.sendFrame(state, { kind: 'error', sentAt: this.now(), requestId, error });
  }

  private killClient(state: ClientState, reason: string): void {
    if (!state.alive) return;
    state.alive = false;
    this.clients.delete(state.id);
    try {
      state.socket.close(1011, reason.slice(0, 100));
    } catch {
      // Already gone. Nothing to do and nothing worth logging.
    }
  }

  /** Close every socket with a reason. Used by graceful shutdown. */
  closeAll(code: number, reason: string): number {
    let closed = 0;
    for (const state of [...this.clients.values()]) {
      state.alive = false;
      try {
        state.socket.close(code, reason.slice(0, 100));
        closed += 1;
      } catch {
        // Socket was already torn down by the peer.
      }
    }
    this.clients.clear();
    return closed;
  }

  /* ----------------------------------------------------------------- stats */

  private recordLatency(event: ForgeEvent): void {
    if (typeof event.ingestedAt !== 'number') return;
    const delta = this.now() - event.ingestedAt;
    if (delta < 0 || delta > 3_600_000) return; // a clock step, not a latency
    this.latencies.push(delta);
    if (this.latencies.length > TRANSPORT_LIMITS.LATENCY_SAMPLES) this.latencies.shift();
  }

  private latencyP95(): number | null {
    if (this.latencies.length < 8) return null; // too few samples to call it a p95
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
    return sorted[index];
  }

  stats(): TransportStats {
    const clients: ClientStats[] = [];
    for (const state of this.clients.values()) {
      let buffered = -1;
      try {
        buffered = state.socket.bufferedBytes();
      } catch {
        buffered = -1; // unknown, and reported as unknown rather than as zero
      }
      clients.push({
        id: state.id,
        remoteLabel: state.socket.remoteLabel,
        connectedAt: new Date(state.connectedAt).toISOString(),
        subscriptions: state.subscriptions.size,
        all: state.all,
        paused: state.paused,
        pausedMs: state.pausedSince === null ? null : this.now() - state.pausedSince,
        droppedWhilePaused: state.droppedWhilePaused,
        degradedStreams: [...state.degraded.keys()],
        framesSent: state.framesSent,
        bytesSent: state.bytesSent,
        bufferedBytes: buffered,
        lastActivityAt: new Date(state.lastActivityAt).toISOString(),
      });
    }
    return {
      connectedClients: this.clients.size,
      clients,
      eventsPublished: this.eventsPublished,
      eventsFannedOut: this.eventsFannedOut,
      eventsDroppedToBackpressure: this.eventsDropped,
      replayFramesSent: this.replayFrames,
      degradedEmitted: this.degradedEmitted,
      reconciledEmitted: this.reconciledEmitted,
      controlEventsDropped: this.controlDropped,
      heartbeatsSent: this.heartbeatsSent,
      streams: this.sink.streams().length,
      fanoutLatencyP95Ms: this.latencyP95(),
      latencySamples: this.latencies.length,
      running: this.running,
    };
  }
}
