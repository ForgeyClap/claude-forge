/**
 * Forge Command Center — gateway adapter, connection slice (WP refactor-adapter-split).
 *
 * Split out of the single `gateway-adapter.ts` (was ~2400 lines) into its already-marked
 * "1. Connection" + "1b. Account-wide usage pressure" sections, verbatim — see that file's own
 * header for the full architecture/history/honesty rules this slice still follows. The shared
 * polling connection singleton, the real client-measured latency, Claude Code health, and the
 * account-wide usage-pressure poll all live here unchanged; `gateway-adapter.ts` re-exports
 * everything below under its original name — no other file needed to change its import.
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import type { ConnectionState, ConnectionStatus } from '@/prototype/state/bridge-client';
import type { ClaudeCodeStatus } from '@/shared/protocol';

import { gwGet, pickBool, pickNumber, pickRecord, pickString } from '@/prototype/state/gateway-client';
import { GATEWAY_ORIGIN, GATEWAY_START_COMMAND } from '@/prototype/state/gateway-client';
import { parseExecutionAvailability } from '@/prototype/state/gateway-chat';

/* ========================================================================== */
/*  1. Connection — a shared, polling-based singleton                         */
/* ========================================================================== */

// Exported for direct hermetic unit testing of the ref-counting behavior below (Codex F8) — never
// imported by production view code, which only ever goes through useGatewayConnection().
export const HEALTH_POLL_MS = 5000;
const ACCOUNT_USAGE_POLL_MS = 30000;
/** cc-wire-usage: rolling window size for the real client-measured health-poll RTT p95. */
const LATENCY_WINDOW = 20;

interface GatewayConnectionInternal {
  readonly status: ConnectionStatus;
  readonly since: number;
  readonly reconnectAttempts: number;
  readonly lastOkAt: number | null;
  readonly claudeAvailable: boolean | null;
  readonly claudeExecutablePath: string | null;
  readonly claudeNote: string | null;
  /** cc-wire-usage: real p95 over the last `LATENCY_WINDOW` successful `/api/health` round trips. */
  readonly latencyP95Ms: number | null;
  readonly latencySampleCount: number;
}

function initialConnection(): GatewayConnectionInternal {
  return {
    status: 'CONNECTING',
    since: Date.now(),
    reconnectAttempts: 0,
    lastOkAt: null,
    claudeAvailable: null,
    claudeExecutablePath: null,
    claudeNote: null,
    latencyP95Ms: null,
    latencySampleCount: 0,
  };
}

/** Extracts a real executable path out of `executionAvailability()`'s own note text, if present. */
function extractExecutablePath(note: string | null): string | null {
  if (note === null) return null;
  const match = /resolved claude cli at (.+)$/i.exec(note);
  return match ? match[1].trim() : null;
}

/**
 * Codex F8: ref-counted subscribers. `getSharedConnectionStore()` below is a module-level singleton
 * that outlives any single component, so without ref-counting its `setInterval` would poll forever —
 * even after every consumer (Topbar, ConnectionBanner, Dock, Sidebar, ClaudeCodeChip, UsageBar) has
 * unmounted (e.g. mid-test, or a route that never renders any of them again). `subscribe()` now
 * starts polling on the FIRST subscriber and `clearInterval`s on the LAST unsubscribe, resuming
 * cleanly (a fresh immediate poll + a new interval) if a subscriber attaches again later.
 */
export class GatewayConnectionStore {
  private state: GatewayConnectionInternal = initialConnection();
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  /** cc-wire-usage: newest-last rolling window of real `/api/health` round-trip samples (ms). */
  private readonly latencySamples: number[] = [];

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    this.start(); // ref-count: (re)start polling whenever the subscriber count goes 0 -> 1+
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop(); // last unsubscribe stops the timer — no orphan poll
    };
  };

  readonly getState = (): GatewayConnectionInternal => this.state;

  start(): void {
    if (this.timer !== null) return; // idempotent, mirrors BridgeClient.connect()'s own guard
    void this.poll();
    this.timer = setInterval(() => void this.poll(), HEALTH_POLL_MS);
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private set(patch: Partial<GatewayConnectionInternal>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private async poll(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    // cc-wire-usage: both timestamps are this client's own clock around the SAME
    // health-poll request this store already makes — a real, same-process round
    // trip, not a separate probe and not a guess.
    const startedAt = Date.now();
    try {
      const health = await gwGet('/api/health');
      const rttMs = Date.now() - startedAt;
      const now = Date.now();
      if (!health.ok) {
        this.set({
          status: 'DISCONNECTED',
          since: this.state.status === 'DISCONNECTED' ? this.state.since : now,
          reconnectAttempts: this.state.reconnectAttempts + 1,
        });
        return;
      }
      this.recordLatency(rttMs);
      // cc-fix-dash-latency (forge-2026-07-29-cc-finish, WP fix-dash-latency): this poll used to
      // make a SECOND request here, GET /api/conversations, purely to read its `execution` field —
      // paying conversations.mjs's whole listConversations() cost every HEALTH_POLL_MS just for one
      // small `{available, note}` object unrelated to conversations. `/api/health` now carries the
      // exact same field/shape (cc-fix-gateway-perf's P2-12 fix, `gateway/src/health.mjs` —
      // verified live: `curl http://127.0.0.1:4100/api/health` returned
      // `"execution":{"available":true,"note":"resolved claude CLI at ..."}`, byte-identical shape
      // to /api/conversations's own `execution` field) — `parseExecutionAvailability` is generic
      // over any record carrying an `execution` key, so it reads straight off the health response
      // this poll already made. One fewer HTTP round trip per 5s tick, zero functional change.
      const execution = parseExecutionAvailability(health.data);
      this.set({
        status: 'CONNECTED',
        since: this.state.status === 'CONNECTED' ? this.state.since : now,
        reconnectAttempts: 0,
        lastOkAt: now,
        claudeAvailable: execution.available,
        claudeExecutablePath: extractExecutablePath(execution.note),
        claudeNote: execution.note,
        latencyP95Ms: this.currentLatencyP95(),
        latencySampleCount: this.latencySamples.length,
      });
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * cc-wire-usage: a negative or non-finite delta is proof of clock trouble
   * (e.g. a system clock adjustment mid-request), never a perfect 0ms — it is
   * REJECTED and simply not counted, mirroring `bridge/usage/latency.ts`'s own
   * "reject, never clamp" principle without importing that dead-bridge module.
   */
  private recordLatency(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.latencySamples.push(ms);
    if (this.latencySamples.length > LATENCY_WINDOW) this.latencySamples.shift();
  }

  /** Nearest-rank p95 over the current rolling window, or `null` with zero samples. */
  private currentLatencyP95(): number | null {
    if (this.latencySamples.length === 0) return null;
    const sorted = [...this.latencySamples].sort((a, b) => a - b);
    const rank = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1));
    return sorted[rank];
  }
}

let sharedConnectionStore: GatewayConnectionStore | null = null;

function getSharedConnectionStore(): GatewayConnectionStore {
  if (sharedConnectionStore === null) {
    sharedConnectionStore = new GatewayConnectionStore();
    // No eager .start() here (Codex F8): subscribe() itself ref-counts start/stop, so creating the
    // store (e.g. reading an initial snapshot before any subscriber attaches) never spins up a timer
    // with nothing listening to it.
  }
  return sharedConnectionStore;
}

function useGatewayConnectionInternal(): GatewayConnectionInternal {
  const store = getSharedConnectionStore();
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

function connectionDetail(status: ConnectionStatus): string | null {
  switch (status) {
    case 'CONNECTED':
      return null;
    case 'CONNECTING':
      return 'Connecting to the Forge gateway…';
    case 'DEGRADED':
      return 'Reconciling the Forge gateway connection…';
    case 'DISCONNECTED':
      // "from the project root" is not filler: the command is relative and resolves one directory
      // above `command-center`, so without it a reader inside `command-center` gets
      // "Cannot find module" from the one instruction meant to unblock them.
      return `Not connected to the Forge gateway. Start it from the project root with \`${GATEWAY_START_COMMAND}\` (it listens on ${GATEWAY_ORIGIN}).`;
  }
}

/**
 * The real gateway connection state, shaped exactly like `bridge-client.ts`'s
 * `ConnectionState` so every existing consumer (`Topbar`, `ConnectionBanner`,
 * `Dock`, `Sidebar`, `ClaudeCodeChip`, `UsageBar`) keeps working with only its
 * import swapped — no JSX/markup changes anywhere.
 */
export function useGatewayConnection(): ConnectionState {
  const internal = useGatewayConnectionInternal();
  return useMemo<ConnectionState>(
    () => ({
      status: internal.status,
      since: internal.since,
      bridgeInstanceId: internal.status === 'CONNECTED' ? 'gateway' : null,
      reconnectAttempts: internal.reconnectAttempts,
      nextRetryInMs: internal.status === 'DISCONNECTED' ? HEALTH_POLL_MS : null,
      lastFrameAt: internal.lastOkAt,
      lastHeartbeatAt: internal.lastOkAt,
      // The gateway has no per-stream sequence/gap concept to reconcile (see
      // this file's header, point 1) — there is never anything to list here.
      reconciling: [],
      startCommand: GATEWAY_START_COMMAND,
      endpoint: GATEWAY_ORIGIN,
      detail: connectionDetail(internal.status),
    }),
    [internal],
  );
}

/** cc-wire-usage: a real, client-measured latency reading — never a bridge concept. */
export interface GatewayLatency {
  readonly measured: boolean;
  readonly p95Ms: number | null;
  readonly sampleCount: number;
  /** Always 'same-process': both timestamps are this client's own clock, around one real request. */
  readonly clockBasis: 'same-process';
}

const UNMEASURED_LATENCY: GatewayLatency = { measured: false, p95Ms: null, sampleCount: 0, clockBasis: 'same-process' };

/**
 * A real p95 round-trip time on this store's own `/api/health` poll —
 * piggybacked on the connection poll already running (`GatewayConnectionStore`),
 * so this costs zero extra network traffic. `measured: false` with zero
 * samples is a first-class, honest answer, never approximated.
 */
export function useGatewayLatency(): GatewayLatency {
  const internal = useGatewayConnectionInternal();
  return useMemo<GatewayLatency>(() => {
    if (internal.latencyP95Ms === null) return UNMEASURED_LATENCY;
    return { measured: true, p95Ms: internal.latencyP95Ms, sampleCount: internal.latencySampleCount, clockBasis: 'same-process' };
  }, [internal]);
}

/**
 * Replaces `useLiveStore().health` for the ONE field its consumers actually
 * read (`.claudeCode`). `authenticated` is a documented inference, not a
 * probed fact: this architecture only ever runs against the Claude Code
 * session already signed in on THIS machine (no API key, ever — see
 * `INVARIANT_DECLARATIONS.USES_LOCAL_CLAUDE_CODE`), so a locally resolved CLI
 * is treated as the same authenticated session. `version`/`supportedFlags`
 * are honestly absent — `executionAvailability()` does not report them.
 */
export function useGatewayClaudeCodeHealth(): { readonly claudeCode: ClaudeCodeStatus } | null {
  const internal = useGatewayConnectionInternal();
  return useMemo(() => {
    if (internal.claudeAvailable === null) return null;
    const status: ClaudeCodeStatus = {
      available: internal.claudeAvailable,
      executablePath: internal.claudeExecutablePath,
      version: null,
      authenticated: internal.claudeAvailable,
      lastCheckedAt: internal.lastOkAt !== null ? new Date(internal.lastOkAt).toISOString() : new Date().toISOString(),
      supportedFlags: [],
      note: internal.claudeNote,
    };
    return { claudeCode: status };
  }, [internal]);
}

/* ========================================================================== */
/*  1b. Account-wide usage pressure (WP7c) — GET /api/usage, already real     */
/* ========================================================================== */

/**
 * The usage-guard's own pause/resume state (a SEPARATE gateway field than the
 * pressure numbers below — see `usage.mjs`'s header). `available:false` is the
 * honest "no guard-state file found/parseable on this machine" case, never a
 * guessed 'ok'.
 */
export interface GatewayGuardState {
  readonly available: boolean;
  readonly mode: string | null;
  readonly pauseAt: number | null;
  readonly resumeAt: number | null;
  readonly pausedAgentCount: number | null;
  readonly lastCheckAt: string | null;
  readonly ageMs: number | null;
  readonly note: string | null;
}

/** The account-wide usage-pressure snapshot the new strip renders. Every field mirrors
 * `usage.mjs::buildUsage()`'s real response shape 1:1 — nothing here is computed or guessed. */
export interface GatewayAccountUsage {
  readonly ok: boolean;
  readonly provenance: string | null;
  readonly note: string | null;
  readonly level: string | null;
  readonly week: number | null;
  readonly nvidiaShiftAt: number | null;
  readonly pauseAt: number | null;
  readonly updatedAt: string | null;
  readonly ageMs: number | null;
  readonly capturedAt: string | null;
  readonly guard: GatewayGuardState;
}

const EMPTY_GUARD_STATE: GatewayGuardState = {
  available: false,
  mode: null,
  pauseAt: null,
  resumeAt: null,
  pausedAgentCount: null,
  lastCheckAt: null,
  ageMs: null,
  note: null,
};

const EMPTY_ACCOUNT_USAGE: GatewayAccountUsage = {
  ok: false,
  provenance: null,
  note: null,
  level: null,
  week: null,
  nvidiaShiftAt: null,
  pauseAt: null,
  updatedAt: null,
  ageMs: null,
  capturedAt: null,
  guard: EMPTY_GUARD_STATE,
};

/**
 * Pure parser, exported for a hermetic unit test (no network, no React, no
 * timers) — mirrors this file's own three honesty rules: a field is real,
 * derived from a real gateway response, or explicitly absent. Never invents a
 * number, a mode, or a provenance the response did not carry.
 */
export function parseAccountUsage(data: Record<string, unknown>): GatewayAccountUsage {
  const guardRaw = pickRecord(data, ['guard']);
  const guard: GatewayGuardState =
    guardRaw === null
      ? EMPTY_GUARD_STATE
      : {
          available: pickBool(guardRaw, ['available']) ?? false,
          mode: pickString(guardRaw, ['mode']),
          pauseAt: pickNumber(guardRaw, ['pause_at']),
          resumeAt: pickNumber(guardRaw, ['resume_at']),
          pausedAgentCount: pickNumber(guardRaw, ['paused_agent_count']),
          lastCheckAt: pickString(guardRaw, ['last_check_at']),
          ageMs: pickNumber(guardRaw, ['age_ms']),
          note: pickString(guardRaw, ['note']),
        };

  return {
    ok: pickBool(data, ['ok']) ?? false,
    provenance: pickString(data, ['provenance']),
    note: pickString(data, ['note']),
    level: pickString(data, ['level']),
    week: pickNumber(data, ['week']),
    nvidiaShiftAt: pickNumber(data, ['nvidia_shift_at']),
    pauseAt: pickNumber(data, ['pause_at']),
    updatedAt: pickString(data, ['updated_at']),
    ageMs: pickNumber(data, ['age_ms']),
    capturedAt: pickString(data, ['captured_at']),
    guard,
  };
}

/**
 * The account-wide usage-pressure poll. A single component consumes this
 * today (`AccountUsagePressure`), so a plain per-hook poll is enough — no
 * shared singleton store needed, unlike the connection state above which many
 * components read.
 */
export function useGatewayAccountUsage(): GatewayAccountUsage {
  const [state, setState] = useState<GatewayAccountUsage>(EMPTY_ACCOUNT_USAGE);

  useEffect(() => {
    let cancelled = false;
    async function tick(): Promise<void> {
      const result = await gwGet('/api/usage');
      if (cancelled || !result.ok) return;
      setState(parseAccountUsage(result.data));
    }
    void tick();
    const id = setInterval(() => void tick(), ACCOUNT_USAGE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return state;
}
