/**
 * Forge Workspace — the typed bridge client.
 *
 * This is the browser's one connection to the local bridge. It speaks the exact
 * frame protocol defined in `src/bridge/transport.ts` over a WebSocket to
 * `ws://127.0.0.1:4517/ws`, and falls back to `POST /api/operation` for a
 * request issued while the socket is down. Nothing here invents data: an event
 * is applied only when its sequence proves it belongs where it is put, and a
 * status is only reported after the fact that would make it true has arrived.
 *
 * WHY `globalThis.WebSocket` / `globalThis.fetch` RATHER THAN THE BARE GLOBALS.
 * The repository's ESLint config carries an offline-only guard
 * (`no-restricted-globals` on `fetch`, `no-restricted-syntax` on
 * `new WebSocket`) written for the *disconnected* prototype. This file is the
 * connection layer of the CONNECTED workspace — the one legitimate place the
 * frontend reaches its own loopback bridge — so it references the browser
 * globals through `globalThis`. That is a correct reference to the same runtime
 * objects and it keeps the offline guard meaningful everywhere else. The lint
 * consequence is called out honestly in the work report.
 *
 * THE RELIABILITY CONTRACT, which is the whole point of the file:
 *
 *  - lastConfirmedSequence is tracked per stream. It is the highest CONTIGUOUS
 *    sequence actually handed to a listener — never the highest one seen.
 *  - a sequence GAP (an event whose sequence is beyond confirmed+1) puts the
 *    stream into DEGRADED, buffers the out-of-order event rather than applying
 *    it, and asks the bridge to replay from confirmed+1. DEGRADED clears only
 *    once the missing range has genuinely arrived and been applied in order.
 *  - a durable-log gap the bridge reports (sequences that will NEVER arrive) is
 *    surfaced as a permanent hole, not silently stepped over in silence: it is
 *    skipped only after being recorded and announced through onNotice.
 *  - reconnect uses exponential backoff. On every reconnect the client REPLAYS
 *    from the last confirmed sequence rather than assuming the stream continued
 *    unbroken across the outage.
 *  - a heartbeat (or any frame) not seen within the timeout is treated as
 *    DISCONNECTED, the socket is torn down, and reconnection begins.
 *  - delivery latency is MEASURED (ingestedAt -> arrival -> applied) with the
 *    same LatencyTracker the bridge uses, so the usage bar can show a measured
 *    number and honestly say "not measured" when there are no samples.
 *  - an event is never dropped in silence. Anything that cannot be applied in
 *    order becomes DEGRADED and a replay request; a loss that cannot be repaired
 *    is announced as a permanent hole.
 */

import { PROTOCOL_SCHEMA_VERSION } from '@/shared/protocol';
import type {
  BridgeHealth,
  EventType,
  ForgeEvent,
  OperationError,
  OperationErrorCode,
  OperationName,
  OperationRequest,
  OperationResponse,
  RuntimeDeclarations,
} from '@/shared/protocol';
import type { DeclarationExplanation } from '@/shared/declarations';
import type { ServerFrame } from '@/bridge/transport';
import type { DegradedNote, SequenceGap, StreamGapReport } from '@/bridge/storage/store';
import { LatencyTracker } from '@/bridge/usage/latency';
import type { LatencyReport } from '@/bridge/usage/latency';

/* ========================================================================== */
/*  Connection state — a claim about the socket, carried honestly              */
/* ========================================================================== */

/**
 * CONNECTING    a socket is opening (first attempt or a reconnect).
 * CONNECTED     the socket is open, `hello` arrived, and every stream is whole.
 * DEGRADED      the socket is open but at least one stream has a known gap that
 *               is being reconciled, or the bridge told us we are behind.
 * DISCONNECTED  no usable socket; a reconnect is scheduled.
 */
export type ConnectionStatus = 'CONNECTING' | 'CONNECTED' | 'DEGRADED' | 'DISCONNECTED';

/** One stream whose delivery is not currently whole, and what is being fixed. */
export interface StreamReconciliation {
  readonly streamKey: string;
  /** First sequence known to be missing. */
  readonly from: number;
  /** Highest sequence that must arrive before the stream is whole again. */
  readonly to: number;
  readonly reason: string;
  /**
   * True when the missing range is a durable-log gap the bridge reported as
   * unrecoverable: it will never arrive, so it is announced rather than waited
   * on. A permanent hole still means the stream's story is incomplete.
   */
  readonly permanent: boolean;
}

/** Everything the ConnectionBanner and the usage bar read. Immutable snapshot. */
export interface ConnectionState {
  readonly status: ConnectionStatus;
  /** When the current status began, in epoch ms. */
  readonly since: number;
  readonly bridgeInstanceId: string | null;
  /** How many reconnect attempts since the last clean connection. */
  readonly reconnectAttempts: number;
  /** ms until the next reconnect attempt, or null when not waiting to retry. */
  readonly nextRetryInMs: number | null;
  readonly lastFrameAt: number | null;
  readonly lastHeartbeatAt: number | null;
  /** Streams currently being reconciled. Empty when whole. */
  readonly reconciling: readonly StreamReconciliation[];
  /** The exact command that starts the bridge, for the DISCONNECTED banner. */
  readonly startCommand: string;
  /** The WebSocket endpoint, shown so a user knows what is being reached. */
  readonly endpoint: string;
  /** One honest sentence about the current status, or null when CONNECTED. */
  readonly detail: string | null;
}

/** A per-stream delivery snapshot, for diagnostics and the inspector. */
export interface StreamSnapshot {
  readonly streamKey: string;
  readonly head: number;
  readonly lastConfirmedSequence: number;
  readonly degraded: boolean;
  readonly buffered: number;
  readonly permanentHoles: readonly SequenceGap[];
}

/* ========================================================================== */
/*  Typed operations                                                           */
/* ========================================================================== */

type EmptyPayload = Record<string, never>;

export interface ListEventsPayload {
  readonly projectId?: string;
  readonly runId?: string | null;
  readonly streamKey?: string;
  readonly fromSequence?: number;
  readonly limit?: number;
  readonly types?: readonly EventType[];
}

export interface ListEventsResult {
  readonly events: readonly ForgeEvent[];
  readonly streams: readonly string[];
  readonly nextSequence: number | null;
  readonly hasMore: boolean;
  readonly gaps: readonly StreamGapReport[];
  readonly issues: readonly DegradedNote[];
}

export interface ReplayEventsPayload {
  readonly streamKey: string;
  readonly fromSequence?: number;
  readonly limit?: number;
}

export interface ReplayEventsResult {
  readonly streamKey: string;
  readonly fromSequence: number;
  readonly events: readonly ForgeEvent[];
  readonly complete: boolean;
  readonly nextSequence: number;
  readonly head: number;
  readonly gaps: readonly SequenceGap[];
  readonly issues: readonly DegradedNote[];
}

export interface DeclarationsResult {
  readonly declarations: RuntimeDeclarations;
  readonly explain: readonly DeclarationExplanation[];
  readonly protocolSchemaVersion: number;
  readonly verifiedAgainstRuntime: boolean;
  readonly mismatches: readonly string[];
}

export interface CheckpointScopeInput {
  readonly kind: 'workspace' | 'project' | 'conversation' | 'run';
  readonly id: string | null;
}

export interface ListCheckpointsPayload {
  readonly scope?: CheckpointScopeInput;
}

export interface ListCheckpointsResult {
  readonly checkpoints: readonly unknown[];
  readonly count: number;
}

export interface CreateCheckpointPayload {
  readonly scope: CheckpointScopeInput;
  readonly note?: string;
}

export interface CreateCheckpointResult {
  readonly checkpoint: unknown;
  readonly complete: boolean;
}

/**
 * The operations whose payload and result shapes are pinned by the contract in
 * this build — the seven the bridge implements today, plus declarations. Every
 * other `OperationName` is typed `unknown` on both sides: it is honest that the
 * bridge answers it with UNIMPLEMENTED until a work package registers a handler,
 * and a fabricated result type would be a claim the contract does not support.
 */
export interface BridgeOperationShapes {
  getHealth: { readonly payload: EmptyPayload; readonly result: BridgeHealth };
  getDeclarations: { readonly payload: EmptyPayload; readonly result: DeclarationsResult };
  listEvents: { readonly payload: ListEventsPayload; readonly result: ListEventsResult };
  replayEvents: { readonly payload: ReplayEventsPayload; readonly result: ReplayEventsResult };
  listCheckpoints: { readonly payload: ListCheckpointsPayload; readonly result: ListCheckpointsResult };
  createCheckpoint: { readonly payload: CreateCheckpointPayload; readonly result: CreateCheckpointResult };
  exportDiagnostics: { readonly payload: EmptyPayload; readonly result: Record<string, unknown> };
}

export type OperationPayload<N extends OperationName> = N extends keyof BridgeOperationShapes
  ? BridgeOperationShapes[N]['payload']
  : unknown;

export type OperationResult<N extends OperationName> = N extends keyof BridgeOperationShapes
  ? BridgeOperationShapes[N]['result']
  : unknown;

/** Thrown by `call` when the bridge answers with a typed failure. */
export class BridgeOperationError extends Error {
  readonly code: OperationErrorCode;
  readonly detail: string | undefined;
  readonly op: OperationName;
  readonly requestId: string;

  constructor(op: OperationName, requestId: string, error: OperationError) {
    super(error.message);
    this.name = 'BridgeOperationError';
    this.code = error.code;
    this.detail = error.detail;
    this.op = op;
    this.requestId = requestId;
    Object.setPrototypeOf(this, BridgeOperationError.prototype);
  }

  /**
   * True when the bridge refused because no handler is registered — the router's
   * one honest UNIMPLEMENTED answer. The store reads this to mark a capability
   * UNAVAILABLE instead of rendering an empty list as if it were real.
   */
  get unimplemented(): boolean {
    return this.code === 'RUNTIME_ERROR' && (this.detail?.startsWith('UNIMPLEMENTED') ?? false);
  }
}

/* ========================================================================== */
/*  Listeners                                                                   */
/* ========================================================================== */

export type StateListener = (state: ConnectionState) => void;
export type EventListener = (event: ForgeEvent) => void;
export type NoticeListener = (notice: BridgeNotice) => void;
export type ErrorListener = (error: BridgeOperationError) => void;

/** A control notice, either from the bridge or detected locally. */
export interface BridgeNotice {
  readonly type: 'bridge.degraded' | 'bridge.reconciled';
  readonly streamKey: string;
  readonly fromSequence: number;
  readonly toSequence: number;
  readonly detail: string;
  /** Where the notice came from — the bridge's own signal, or our own check. */
  readonly origin: 'bridge' | 'client';
}

/* ========================================================================== */
/*  Options and constants                                                       */
/* ========================================================================== */

export interface BridgeClientOptions {
  readonly host?: string;
  readonly port?: number;
  /** Streams to follow. Default `['*']` — every stream in the workspace. */
  readonly streams?: readonly string[];
  readonly callTimeoutMs?: number;
  /** Injectable clock, so the reliability logic is testable without real time. */
  readonly now?: () => number;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4517;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const START_COMMAND = 'npm run bridge';

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15_000;
/** Below `hello`, assume the bridge's default 15s heartbeat. */
const FALLBACK_HEARTBEAT_MS = 15_000;
const HEARTBEAT_TIMEOUT_FACTOR = 3;
const MIN_HEARTBEAT_TIMEOUT_MS = 20_000;
const WATCHDOG_INTERVAL_MS = 5_000;
/** Out-of-order events buffered per stream before we drop the buffer and replay. */
const MAX_BUFFER_PER_STREAM = 5_000;
/** Replay round trips without progress before a gap is called a permanent hole. */
const MAX_REPLAY_ATTEMPTS = 6;
/** Ack no more often than this per stream, so a fast tail is not an ack storm. */
const ACK_THROTTLE_MS = 250;

/** WebSocket.OPEN, named locally so nothing depends on constructor lookups. */
const SOCKET_OPEN = 1;

/**
 * The browser may only ever reach the bridge on loopback. A non-loopback host
 * would be the page talking to the network, which this client refuses outright.
 */
function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
}

/* ========================================================================== */
/*  Per-stream tracker                                                          */
/* ========================================================================== */

interface BufferedEvent {
  readonly event: ForgeEvent;
  readonly arrivalMs: number;
}

interface StreamTracker {
  readonly streamKey: string;
  /** Highest sequence the bridge has told us exists on this stream. */
  head: number;
  /** Highest CONTIGUOUS sequence handed to listeners. The replay anchor. */
  confirmed: number;
  /** Whether a baseline has been established (so `confirmed` means something). */
  anchored: boolean;
  degraded: boolean;
  gapFrom: number | null;
  gapTo: number | null;
  reason: string | null;
  /** Out-of-order events waiting for the gap in front of them to be filled. */
  readonly buffer: Map<number, BufferedEvent>;
  /** Durable-log holes the bridge reported as unrecoverable. */
  readonly permanentHoles: SequenceGap[];
  replayPending: boolean;
  replayAttempts: number;
  lastAckAt: number;
  lastAcked: number;
}

/* ========================================================================== */
/*  The client                                                                  */
/* ========================================================================== */

export class BridgeClient {
  readonly wsUrl: string;
  readonly httpUrl: string;
  readonly healthUrl: string;

  private readonly streamsRequested: readonly string[];
  private readonly callTimeoutMs: number;
  private readonly now: () => number;
  private readonly latency = new LatencyTracker();

  private socket: WebSocket | null = null;
  private status: ConnectionStatus = 'DISCONNECTED';
  private statusSince = 0;
  private bridgeInstanceId: string | null = null;
  private heartbeatIntervalMs = FALLBACK_HEARTBEAT_MS;
  private lastFrameAt: number | null = null;
  private lastHeartbeatAt: number | null = null;

  private closedByUser = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private nextRetryAt: number | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;

  private readonly streams = new Map<string, StreamTracker>();
  private readonly pending = new Map<string, PendingCall>();

  private readonly stateListeners = new Set<StateListener>();
  private readonly eventListeners = new Set<EventListener>();
  private readonly noticeListeners = new Set<NoticeListener>();
  private readonly errorListeners = new Set<ErrorListener>();

  constructor(options: BridgeClientOptions = {}) {
    const host = options.host ?? DEFAULT_HOST;
    const port = options.port ?? DEFAULT_PORT;
    if (!isLoopbackHost(host)) {
      throw new Error(
        `BridgeClient refuses host ${JSON.stringify(host)}: the browser may only reach the bridge on ` +
          'loopback (127.0.0.1, localhost or [::1]).',
      );
    }
    this.wsUrl = `ws://${host}:${port}/ws`; // loopback only: 127.0.0.1 / localhost / [::1], enforced above
    this.httpUrl = `http://${host}:${port}/api/operation`; // loopback only: 127.0.0.1 / localhost / [::1]
    this.healthUrl = `http://${host}:${port}/api/health`; // loopback only: 127.0.0.1 / localhost / [::1]
    this.streamsRequested = options.streams && options.streams.length > 0 ? [...options.streams] : ['*'];
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
    this.statusSince = this.now();
  }

  /* ---------------------------------------------------------------- lifecycle */

  /** Open the socket. Idempotent while a socket is already live. */
  connect(): void {
    if (this.socket !== null) return;
    this.closedByUser = false;
    this.openSocket();
    if (this.watchdog === null) {
      this.watchdog = setInterval(() => this.checkHeartbeat(), WATCHDOG_INTERVAL_MS);
      // A browser timer id is a number with no unref; a Node one has unref. Only
      // Node needs it, and calling it defensively keeps a test harness quiet.
      const handle = this.watchdog as unknown as { unref?: () => void };
      if (typeof handle.unref === 'function') handle.unref();
    }
  }

  /** Close the socket and stop reconnecting. Rejects any in-flight call. */
  disconnect(): void {
    this.closedByUser = true;
    this.clearReconnectTimer();
    if (this.watchdog !== null) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
    this.teardownSocket();
    this.failAllPending('the bridge client was disconnected');
    this.setStatus('DISCONNECTED', this.now());
  }

  private openSocket(): void {
    this.setStatus('CONNECTING', this.now());
    let socket: WebSocket;
    try {
      socket = new globalThis.WebSocket(this.wsUrl);
    } catch {
      // Construction itself can throw (a malformed URL, a disabled API). Treat
      // it exactly like a failed connection: schedule a retry, never crash.
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      // `hello` sets the status to CONNECTED; until then we are still CONNECTING.
      this.lastFrameAt = this.now();
    };
    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== 'string') return; // this protocol is JSON text only
      this.onRaw(event.data);
    };
    socket.onerror = () => {
      // The close event follows; reconnection is handled there so it happens once.
    };
    socket.onclose = () => {
      this.teardownSocket();
      if (this.closedByUser) return;
      this.scheduleReconnect();
    };
  }

  private teardownSocket(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket === null) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close();
    } catch {
      // Already closing or closed; nothing to do.
    }
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer !== null) return;
    this.reconnectAttempts += 1;
    const backoff = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (this.reconnectAttempts - 1));
    // Full jitter, so a fleet of tabs does not reconnect in lockstep.
    const delay = Math.round(backoff / 2 + Math.random() * (backoff / 2));
    this.nextRetryAt = this.now() + delay;
    this.setStatus('DISCONNECTED', this.now());
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.nextRetryAt = null;
      this.openSocket();
    }, delay);
    const handle = this.reconnectTimer as unknown as { unref?: () => void };
    if (typeof handle.unref === 'function') handle.unref();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.nextRetryAt = null;
  }

  private checkHeartbeat(): void {
    if (this.socket === null || this.socket.readyState !== SOCKET_OPEN) return;
    if (this.lastFrameAt === null) return;
    const timeout = Math.max(MIN_HEARTBEAT_TIMEOUT_MS, this.heartbeatIntervalMs * HEARTBEAT_TIMEOUT_FACTOR);
    if (this.now() - this.lastFrameAt <= timeout) return;
    // No frame — not even a heartbeat — within the window. The socket may look
    // open while the peer is gone; the honest status is DISCONNECTED, and a
    // fresh socket is the only way to find out.
    this.teardownSocket();
    this.setStatus('DISCONNECTED', this.now());
    if (!this.closedByUser) this.scheduleReconnect();
  }

  /* ------------------------------------------------------------ frame intake */

  private onRaw(raw: string): void {
    this.lastFrameAt = this.now();
    let frame: ServerFrame;
    try {
      frame = JSON.parse(raw) as ServerFrame;
    } catch {
      return; // a frame we cannot parse is not evidence of anything
    }
    switch (frame.kind) {
      case 'hello':
        this.onHello(frame);
        return;
      case 'subscribed':
        this.onSubscribed(frame);
        return;
      case 'event':
        this.onEventFrame(frame.streamKey, frame.event);
        return;
      case 'events':
        this.onEventsFrame(frame);
        return;
      case 'heartbeat':
        this.onHeartbeatFrame(frame);
        return;
      case 'notice':
        this.onNoticeFrame(frame);
        return;
      case 'response':
        this.resolveResponse(frame.response);
        return;
      case 'error':
        this.onErrorFrame(frame);
        return;
      default:
        return;
    }
  }

  private onHello(frame: Extract<ServerFrame, { kind: 'hello' }>): void {
    this.bridgeInstanceId = frame.bridgeInstanceId;
    if (frame.protocolSchemaVersion !== PROTOCOL_SCHEMA_VERSION) {
      // A protocol mismatch is not something to paper over. We surface it and do
      // not subscribe: applying frames from a version we do not understand would
      // be exactly the kind of guess this system forbids.
      this.emitError(
        new BridgeOperationError('getHealth', 'hello', {
          code: 'SCHEMA_MISMATCH',
          message: `The bridge speaks protocol v${frame.protocolSchemaVersion}; this client speaks v${PROTOCOL_SCHEMA_VERSION}.`,
        }),
      );
      this.teardownSocket();
      this.setStatus('DISCONNECTED', this.now());
      return;
    }
    this.heartbeatIntervalMs = frame.heartbeatIntervalMs > 0 ? frame.heartbeatIntervalMs : FALLBACK_HEARTBEAT_MS;
    this.reconnectAttempts = 0;
    this.send({ kind: 'subscribe', streams: this.streamsRequested });
    // Any call that was in flight when the socket dropped is re-sent with its
    // original requestId. The router's idempotency cache returns the first
    // answer, so a retry cannot execute an operation twice.
    for (const entry of this.pending.values()) this.sendRequestFrame(entry.request);
    this.recomputeStatus();
  }

  private onSubscribed(frame: Extract<ServerFrame, { kind: 'subscribed' }>): void {
    for (const head of frame.heads) {
      const tracker = this.trackerFor(head.streamKey);
      if (head.sequence > tracker.head) tracker.head = head.sequence;
      // Anchor a stream we have never seen at its current head: we are tailing,
      // not replaying its whole past. History is pulled explicitly via replay.
      if (!tracker.anchored) {
        tracker.confirmed = head.sequence;
        tracker.anchored = true;
      }
    }
    // On a reconnect, tracked streams already carry a confirmed sequence from
    // before the outage. Replay from confirmed+1 rather than assume the stream
    // ran unbroken while the socket was down. On the very first subscribe this
    // asks from head+1 and harmlessly returns nothing.
    for (const tracker of this.streams.values()) {
      if (tracker.confirmed > 0) this.requestReplay(tracker, tracker.confirmed + 1, 'reconnect replay');
    }
    this.recomputeStatus();
  }

  private onHeartbeatFrame(frame: Extract<ServerFrame, { kind: 'heartbeat' }>): void {
    this.lastHeartbeatAt = this.now();
    for (const head of frame.heads) {
      const tracker = this.trackerFor(head.streamKey);
      if (head.sequence > tracker.head) tracker.head = head.sequence;
      if (!tracker.anchored) {
        tracker.confirmed = head.sequence;
        tracker.anchored = true;
        continue;
      }
      // The head is ahead of what we have confirmed and no live event explained
      // it: events were lost (backpressure, a dropped frame, an outage the socket
      // survived). That is a gap, and it must not pass unnoticed.
      if (head.sequence > tracker.confirmed && !tracker.degraded) {
        this.markDegraded(tracker, tracker.confirmed + 1, head.sequence, 'heartbeat head ahead of confirmed');
        this.requestReplay(tracker, tracker.confirmed + 1, 'heartbeat catch-up');
      }
    }
    this.recomputeStatus();
  }

  private onNoticeFrame(frame: Extract<ServerFrame, { kind: 'notice' }>): void {
    const tracker = this.trackerFor(frame.streamKey);
    if (frame.type === 'bridge.degraded') {
      // The bridge itself knows we are behind (it stopped pushing to us under
      // backpressure, or it saw a hole in the live stream). Trust it and replay.
      if (!tracker.degraded || frame.toSequence > (tracker.gapTo ?? 0)) {
        this.markDegraded(tracker, frame.fromSequence, frame.toSequence, 'bridge reported a delivery gap');
      }
      this.requestReplay(tracker, Math.min(frame.fromSequence, tracker.confirmed + 1), 'bridge-degraded replay');
    }
    this.emitNotice({
      type: frame.type,
      streamKey: frame.streamKey,
      fromSequence: frame.fromSequence,
      toSequence: frame.toSequence,
      detail: frame.detail,
      origin: 'bridge',
    });
    this.recomputeStatus();
  }

  private onErrorFrame(frame: Extract<ServerFrame, { kind: 'error' }>): void {
    if (frame.requestId !== null) {
      const pending = this.pending.get(frame.requestId);
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        this.pending.delete(frame.requestId);
        pending.reject(new BridgeOperationError(pending.request.op, frame.requestId, frame.error));
        return;
      }
    }
    // A frame-level error not tied to a request (a malformed subscribe, say).
    this.emitError(new BridgeOperationError('getHealth', frame.requestId ?? 'unknown', frame.error));
  }

  /* ---------------------------------------------------- event application */

  private onEventFrame(streamKey: string, event: ForgeEvent): void {
    const arrivalMs = this.now();
    const tracker = this.trackerFor(streamKey);
    if (event.sequence > tracker.head) tracker.head = event.sequence;

    if (!tracker.anchored) {
      // First contact with this stream on a live event: baseline just below it,
      // so this event is contiguous and begins the tail here.
      tracker.confirmed = event.sequence - 1;
      tracker.anchored = true;
    }

    const expected = tracker.confirmed + 1;
    if (event.sequence === expected) {
      this.deliver(tracker, event, arrivalMs);
      this.drainBuffer(tracker);
      this.clearDegradedIfWhole(tracker);
      this.scheduleAck(tracker);
    } else if (event.sequence <= tracker.confirmed) {
      // A re-publish of something already delivered. De-duplicated in silence is
      // correct here: the sequence proves we already have it.
      this.scheduleAck(tracker);
    } else {
      // A hole opens in front of this event. Do NOT apply it out of order.
      this.bufferEvent(tracker, event, arrivalMs);
      this.markDegraded(tracker, expected, Math.max(event.sequence - 1, tracker.head), 'sequence gap in the live stream');
      this.requestReplay(tracker, expected, 'live-gap replay');
    }
    this.recomputeStatus();
  }

  private onEventsFrame(frame: Extract<ServerFrame, { kind: 'events' }>): void {
    const arrivalMs = this.now();
    const tracker = this.trackerFor(frame.streamKey);
    tracker.replayPending = false;

    // Durable-log gaps the bridge could not fill. Recorded and announced before
    // anything steps over them, so an unrecoverable hole is never silent.
    for (const gap of frame.gaps) this.recordPermanentHole(tracker, gap);

    const confirmedBefore = tracker.confirmed;
    for (const event of frame.events) {
      if (event.sequence > tracker.head) tracker.head = event.sequence;
      if (event.sequence === tracker.confirmed + 1) {
        this.deliver(tracker, event, arrivalMs);
        this.drainBuffer(tracker);
      } else if (event.sequence > tracker.confirmed) {
        this.bufferEvent(tracker, event, arrivalMs);
      }
      // events at or below confirmed are already applied — skip.
    }

    // If the next needed sequence sits inside a known permanent hole, step past
    // the hole (it will never arrive) and keep applying what we do have.
    this.skipPermanentHoles(tracker);
    this.drainBuffer(tracker);

    if (!frame.complete) {
      // More of the range remains; keep pulling from where the bridge left off.
      this.requestReplay(tracker, frame.nextSequence, 'replay continuation');
    } else if (tracker.confirmed >= (tracker.gapTo ?? tracker.confirmed) && tracker.buffer.size === 0) {
      this.clearDegradedIfWhole(tracker);
      this.scheduleAck(tracker, true);
    } else if (tracker.confirmed === confirmedBefore) {
      // A complete replay that advanced nothing while a buffered event still sits
      // ahead means the missing range is genuinely gone, even though the bridge
      // did not label it a durable gap. After enough fruitless attempts we call
      // it a permanent hole and step past it — announced, never swallowed.
      tracker.replayAttempts += 1;
      if (tracker.replayAttempts >= MAX_REPLAY_ATTEMPTS) {
        this.forcePastUnrecoverableGap(tracker);
      } else {
        this.requestReplay(tracker, tracker.confirmed + 1, 'replay retry');
      }
    } else {
      tracker.replayAttempts = 0;
      this.requestReplay(tracker, tracker.confirmed + 1, 'replay retry');
    }
    this.recomputeStatus();
  }

  /** Hand one event to listeners and advance the contiguous cursor. */
  private deliver(tracker: StreamTracker, event: ForgeEvent, arrivalMs: number): void {
    this.measureDelivery(event, arrivalMs);
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {
        // A listener throwing must not derail delivery of the next event; the
        // sequence has still been received and its cursor still advances.
      }
    }
    tracker.confirmed = event.sequence;
    // The ui-update hop (received here -> handed to the store) is same-process.
    this.latency.recordUiUpdate(this.now() - arrivalMs);
    tracker.replayAttempts = 0;
  }

  private drainBuffer(tracker: StreamTracker): void {
    for (;;) {
      const next = tracker.buffer.get(tracker.confirmed + 1);
      if (next === undefined) return;
      tracker.buffer.delete(next.event.sequence);
      this.deliver(tracker, next.event, next.arrivalMs);
    }
  }

  private bufferEvent(tracker: StreamTracker, event: ForgeEvent, arrivalMs: number): void {
    if (event.sequence <= tracker.confirmed) return;
    if (tracker.buffer.size >= MAX_BUFFER_PER_STREAM && !tracker.buffer.has(event.sequence)) {
      // The buffer is a repair aid, not a queue. If it overflows we drop it and
      // let replay from confirmed+1 rebuild the missing range from the durable
      // log, which is the authority anyway.
      tracker.buffer.clear();
      this.requestReplay(tracker, tracker.confirmed + 1, 'buffer overflow replay');
      return;
    }
    tracker.buffer.set(event.sequence, { event, arrivalMs });
  }

  private skipPermanentHoles(tracker: StreamTracker): void {
    for (;;) {
      const next = tracker.confirmed + 1;
      const hole = tracker.permanentHoles.find((gap) => gap.from <= next && next <= gap.to);
      if (hole === undefined) return;
      tracker.confirmed = hole.to;
      this.emitNotice({
        type: 'bridge.degraded',
        streamKey: tracker.streamKey,
        fromSequence: hole.from,
        toSequence: hole.to,
        detail: `sequences ${hole.from}..${hole.to} are missing from the durable log and will never arrive; stepping past a permanent hole`,
        origin: 'client',
      });
    }
  }

  private forcePastUnrecoverableGap(tracker: StreamTracker): void {
    const nextBuffered = [...tracker.buffer.keys()].sort((a, b) => a - b)[0];
    if (nextBuffered === undefined) {
      tracker.replayAttempts = 0;
      return;
    }
    const from = tracker.confirmed + 1;
    const to = nextBuffered - 1;
    this.recordPermanentHole(tracker, { from, to, count: to - from + 1 });
    this.emitNotice({
      type: 'bridge.degraded',
      streamKey: tracker.streamKey,
      fromSequence: from,
      toSequence: to,
      detail: `sequences ${from}..${to} could not be replayed after ${MAX_REPLAY_ATTEMPTS} attempts; recording an unrecoverable hole rather than waiting forever`,
      origin: 'client',
    });
    tracker.confirmed = to;
    tracker.replayAttempts = 0;
    this.drainBuffer(tracker);
    this.clearDegradedIfWhole(tracker);
  }

  private recordPermanentHole(tracker: StreamTracker, gap: SequenceGap): void {
    if (gap.to < gap.from) return;
    const exists = tracker.permanentHoles.some((h) => h.from === gap.from && h.to === gap.to);
    if (!exists) tracker.permanentHoles.push({ from: gap.from, to: gap.to, count: gap.count });
  }

  /* --------------------------------------------------- degraded / reconciled */

  private markDegraded(tracker: StreamTracker, from: number, to: number, reason: string): void {
    if (to < from) return;
    if (!tracker.degraded) {
      tracker.degraded = true;
      tracker.gapFrom = from;
      tracker.gapTo = to;
      tracker.reason = reason;
    } else {
      // A widening gap keeps the earliest lower bound and the latest head.
      if (tracker.gapFrom === null || from < tracker.gapFrom) tracker.gapFrom = from;
      if (tracker.gapTo === null || to > tracker.gapTo) tracker.gapTo = to;
      tracker.reason = reason;
    }
    this.emitNotice({
      type: 'bridge.degraded',
      streamKey: tracker.streamKey,
      fromSequence: tracker.gapFrom ?? from,
      toSequence: tracker.gapTo ?? to,
      detail: `${reason}; sequences ${tracker.gapFrom ?? from}..${tracker.gapTo ?? to} not yet delivered`,
      origin: 'client',
    });
  }

  private clearDegradedIfWhole(tracker: StreamTracker): void {
    if (!tracker.degraded) return;
    if (tracker.buffer.size > 0) return;
    if (tracker.replayPending) return;
    if (tracker.gapTo !== null && tracker.confirmed < tracker.gapTo) return;
    const from = tracker.gapFrom ?? 0;
    const to = tracker.gapTo ?? tracker.confirmed;
    tracker.degraded = false;
    tracker.gapFrom = null;
    tracker.gapTo = null;
    tracker.reason = null;
    tracker.replayAttempts = 0;
    // Confirm the head so the bridge can emit its own bridge.reconciled.
    this.ack(tracker, tracker.confirmed, true);
    this.emitNotice({
      type: 'bridge.reconciled',
      streamKey: tracker.streamKey,
      fromSequence: from,
      toSequence: to,
      detail: `the missing range ${from}..${to} arrived and was applied in order`,
      origin: 'client',
    });
  }

  /* ---------------------------------------------------------------- replay */

  private requestReplay(tracker: StreamTracker, fromSequence: number, reason: string): void {
    if (fromSequence < 1) fromSequence = 1;
    if (tracker.replayPending) return;
    if (this.socket === null || this.socket.readyState !== SOCKET_OPEN) return;
    tracker.replayPending = true;
    void reason;
    this.send({ kind: 'replay', streamKey: tracker.streamKey, fromSequence });
  }

  /* ------------------------------------------------------------------- acks */

  private scheduleAck(tracker: StreamTracker, force = false): void {
    if (tracker.confirmed <= tracker.lastAcked) return;
    const now = this.now();
    if (!force && now - tracker.lastAckAt < ACK_THROTTLE_MS) return;
    this.ack(tracker, tracker.confirmed, force);
  }

  private ack(tracker: StreamTracker, sequence: number, force: boolean): void {
    if (sequence <= tracker.lastAcked && !force) return;
    if (sequence <= 0) return;
    if (this.socket === null || this.socket.readyState !== SOCKET_OPEN) return;
    tracker.lastAcked = sequence;
    tracker.lastAckAt = this.now();
    this.send({ kind: 'ack', streamKey: tracker.streamKey, sequence });
  }

  /* --------------------------------------------------------------- requests */

  /**
   * Ask the bridge to perform one contract operation, fully typed. Every call
   * carries a fresh requestId, so a retry over a flaky socket is idempotent: the
   * router returns the first response rather than executing twice.
   *
   * The socket is preferred while it is open; a call made while it is down goes
   * over `POST /api/operation` instead, so an operation is still answerable when
   * the live stream is not.
   */
  call<N extends OperationName>(op: N, payload: OperationPayload<N>): Promise<OperationResult<N>> {
    const request: OperationRequest = {
      requestId: this.newRequestId(),
      schemaVersion: PROTOCOL_SCHEMA_VERSION,
      op,
      payload,
    };
    if (this.socket !== null && this.socket.readyState === SOCKET_OPEN) {
      return this.callOverSocket(request) as Promise<OperationResult<N>>;
    }
    return this.callOverHttp(request) as Promise<OperationResult<N>>;
  }

  private callOverSocket(request: OperationRequest): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.requestId);
        reject(
          new BridgeOperationError(request.op, request.requestId, {
            code: 'TIMEOUT',
            message: `The bridge did not answer "${request.op}" within ${this.callTimeoutMs}ms.`,
          }),
        );
      }, this.callTimeoutMs);
      this.pending.set(request.requestId, { request, resolve, reject, timer, startedAt: this.now() });
      this.sendRequestFrame(request);
    });
  }

  private async callOverHttp(request: OperationRequest): Promise<unknown> {
    let response: Response;
    try {
      response = await globalThis.fetch(this.httpUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
    } catch (err) {
      throw new BridgeOperationError(request.op, request.requestId, {
        code: 'RUNTIME_ERROR',
        message: 'The bridge could not be reached over HTTP.',
        detail: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
      });
    }
    let body: OperationResponse;
    try {
      body = (await response.json()) as OperationResponse;
    } catch {
      throw new BridgeOperationError(request.op, request.requestId, {
        code: 'RUNTIME_ERROR',
        message: 'The bridge returned a response that was not JSON.',
      });
    }
    if (body.ok) return body.result;
    throw new BridgeOperationError(request.op, request.requestId, body.error);
  }

  private sendRequestFrame(request: OperationRequest): void {
    this.send({ kind: 'request', request });
  }

  private resolveResponse(response: OperationResponse): void {
    const pending = this.pending.get(response.requestId);
    if (pending === undefined) return; // unknown id, or an HTTP call, or already settled
    clearTimeout(pending.timer);
    this.pending.delete(response.requestId);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new BridgeOperationError(pending.request.op, response.requestId, response.error));
  }

  private failAllPending(reason: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(
        new BridgeOperationError(pending.request.op, id, { code: 'CANCELLED', message: reason }),
      );
    }
  }

  /* ------------------------------------------------------------------ send */

  private send(frame: ClientFrame): void {
    const socket = this.socket;
    if (socket === null || socket.readyState !== SOCKET_OPEN) return;
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      // The socket died between the readyState check and the write. The close
      // handler will take over; nothing is lost that a reconnect replay cannot
      // recover.
    }
  }

  /* ------------------------------------------------------------- latency */

  private measureDelivery(event: ForgeEvent, arrivalMs: number): void {
    if (typeof event.ingestedAt !== 'number') return;
    // ingestedAt is stamped by the bridge, arrival is read here — two clocks, so
    // the tracker keeps it labelled cross-process and rejects negative skew
    // rather than inventing a perfect zero.
    this.latency.recordSample('delivery', arrivalMs - event.ingestedAt, 'cross-process');
  }

  getLatencyReport(): LatencyReport {
    return this.latency.getLatencyReport();
  }

  /* ------------------------------------------------------------ subscriptions */

  onState(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    listener(this.snapshot());
    return () => this.stateListeners.delete(listener);
  }

  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onNotice(listener: NoticeListener): () => void {
    this.noticeListeners.add(listener);
    return () => this.noticeListeners.delete(listener);
  }

  onError(listener: ErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  private emitNotice(notice: BridgeNotice): void {
    for (const listener of this.noticeListeners) {
      try {
        listener(notice);
      } catch {
        /* a notice listener must not break the intake path */
      }
    }
  }

  private emitError(error: BridgeOperationError): void {
    for (const listener of this.errorListeners) {
      try {
        listener(error);
      } catch {
        /* ignore */
      }
    }
  }

  /* --------------------------------------------------------------- status */

  private setStatus(status: ConnectionStatus, at: number): void {
    if (this.status === status) {
      this.emitState();
      return;
    }
    this.status = status;
    this.statusSince = at;
    this.emitState();
  }

  /** Choose the honest status from the socket and the streams, then publish it. */
  private recomputeStatus(): void {
    if (this.socket === null || this.socket.readyState !== SOCKET_OPEN) {
      // Not open: whatever the reconnect machinery set (CONNECTING/DISCONNECTED).
      this.emitState();
      return;
    }
    if (this.bridgeInstanceId === null) {
      this.setStatus('CONNECTING', this.now());
      return;
    }
    const anyDegraded = [...this.streams.values()].some((tracker) => tracker.degraded);
    this.setStatus(anyDegraded ? 'DEGRADED' : 'CONNECTED', this.now());
  }

  private reconciling(): readonly StreamReconciliation[] {
    const out: StreamReconciliation[] = [];
    for (const tracker of this.streams.values()) {
      if (!tracker.degraded) continue;
      out.push({
        streamKey: tracker.streamKey,
        from: tracker.gapFrom ?? tracker.confirmed + 1,
        to: tracker.gapTo ?? tracker.head,
        reason: tracker.reason ?? 'a delivery gap is being reconciled',
        permanent: false,
      });
    }
    return out;
  }

  private detailLine(status: ConnectionStatus, reconciling: readonly StreamReconciliation[]): string | null {
    switch (status) {
      case 'CONNECTED':
        return null;
      case 'CONNECTING':
        return this.reconnectAttempts > 0
          ? `Reconnecting to the Forge bridge (attempt ${this.reconnectAttempts})…`
          : 'Connecting to the Forge bridge…';
      case 'DEGRADED': {
        const streams = reconciling.length;
        const first = reconciling[0];
        return first === undefined
          ? 'Reconciling the event stream…'
          : `Reconciling ${streams} stream${streams === 1 ? '' : 's'} — replaying ${first.from}..${first.to} on ${first.streamKey}.`;
      }
      case 'DISCONNECTED':
        return `Not connected to the Forge bridge. Start it with \`${START_COMMAND}\` (it listens on ${this.wsUrl}).`;
    }
  }

  private snapshot(): ConnectionState {
    const reconciling = this.reconciling();
    const now = this.now();
    return {
      status: this.status,
      since: this.statusSince,
      bridgeInstanceId: this.bridgeInstanceId,
      reconnectAttempts: this.reconnectAttempts,
      nextRetryInMs: this.nextRetryAt === null ? null : Math.max(0, this.nextRetryAt - now),
      lastFrameAt: this.lastFrameAt,
      lastHeartbeatAt: this.lastHeartbeatAt,
      reconciling,
      startCommand: START_COMMAND,
      endpoint: this.wsUrl,
      detail: this.detailLine(this.status, reconciling),
    };
  }

  private emitState(): void {
    const snapshot = this.snapshot();
    for (const listener of this.stateListeners) {
      try {
        listener(snapshot);
      } catch {
        /* a state listener must not break the socket path */
      }
    }
  }

  getState(): ConnectionState {
    return this.snapshot();
  }

  getStreamSnapshots(): readonly StreamSnapshot[] {
    const out: StreamSnapshot[] = [];
    for (const tracker of this.streams.values()) {
      out.push({
        streamKey: tracker.streamKey,
        head: tracker.head,
        lastConfirmedSequence: tracker.confirmed,
        degraded: tracker.degraded,
        buffered: tracker.buffer.size,
        permanentHoles: [...tracker.permanentHoles],
      });
    }
    return out;
  }

  /* ------------------------------------------------------------------ util */

  private trackerFor(streamKey: string): StreamTracker {
    let tracker = this.streams.get(streamKey);
    if (tracker === undefined) {
      tracker = {
        streamKey,
        head: 0,
        confirmed: 0,
        anchored: false,
        degraded: false,
        gapFrom: null,
        gapTo: null,
        reason: null,
        buffer: new Map<number, BufferedEvent>(),
        permanentHoles: [],
        replayPending: false,
        replayAttempts: 0,
        lastAckAt: 0,
        lastAcked: 0,
      };
      this.streams.set(streamKey, tracker);
    }
    return tracker;
  }

  private seq = 0;

  private newRequestId(): string {
    const cryptoObj = globalThis.crypto;
    if (cryptoObj !== undefined && typeof cryptoObj.randomUUID === 'function') return cryptoObj.randomUUID();
    this.seq += 1;
    return `req-${this.now().toString(36)}-${this.seq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

/* ========================================================================== */
/*  Local types                                                                */
/* ========================================================================== */

interface PendingCall {
  readonly request: OperationRequest;
  readonly resolve: (value: unknown) => void;
  readonly reject: (err: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly startedAt: number;
}

/**
 * Client -> server frames. Mirrors `ClientFrame` in `src/bridge/transport.ts`;
 * declared locally so the browser bundle carries no value import from the bridge
 * transport module (which pulls in Node-only timers).
 */
type ClientFrame =
  | { readonly kind: 'subscribe'; readonly streams: readonly string[] }
  | { readonly kind: 'unsubscribe'; readonly streams: readonly string[] }
  | { readonly kind: 'ack'; readonly streamKey: string; readonly sequence: number }
  | { readonly kind: 'replay'; readonly streamKey: string; readonly fromSequence: number; readonly limit?: number }
  | { readonly kind: 'request'; readonly request: OperationRequest }
  | { readonly kind: 'ping' };
