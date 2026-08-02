/**
 * Forge Workspace — latency measurement.
 *
 * This module measures. It does not assert, and it does not aspire.
 *
 * The mission carries three latency targets:
 *
 *   ingestion  p95 < 25ms   (runtime event  ->  bridge accepted it)
 *   delivery   p95 < 50ms   (bridge sent it ->  client acknowledged it)
 *   ui-update  p95 < 100ms  (client received it -> client painted it)
 *
 * A target is a goal someone wrote down. It is not evidence. Nothing in this
 * file will ever report that a target was met unless samples exist that say so,
 * and `meetsP95Target` is `null` — not `true` — when there is nothing to judge.
 * `measured: false` is a first-class, expected, acceptable answer.
 *
 * Three details decide whether the numbers here are honest:
 *
 * 1. TWO CLOCKS. An ingestion sample subtracts a timestamp written by another
 *    process from a timestamp read by this one. Those clocks are not the same
 *    clock. A sample that comes out negative is not a 0ms delivery — it is
 *    proof of skew — so it is REJECTED and counted, never clamped to zero.
 *    Clamping would manufacture a perfect measurement out of a broken one.
 *    Every statistic reports its `clockBasis` so a consumer knows whether it is
 *    reading a single-clock measurement or a two-clock approximation.
 *
 * 2. DELIVERY IS A ROUND TRIP. The bridge cannot observe the moment a client
 *    receives a frame; it can only observe the moment the acknowledgement comes
 *    back. So `delivery` is measured send -> ack, on one clock, and is
 *    documented as an UPPER BOUND on one-way delivery. Calling it one-way
 *    would be a claim about a moment nobody watched.
 *
 * 3. A BOUNDED WINDOW IS NOT ALL OF HISTORY. Percentiles are computed over the
 *    last `windowSize` accepted samples, by nearest-rank, on a sorted copy.
 *    Both the window size and the lifetime sample count are reported, because
 *    "p95 = 4ms" over 6 samples means something very different from the same
 *    number over 512.
 */

import type { ForgeEvent } from '../../shared/protocol.ts';

/* ========================================================================== */
/*  Vocabulary                                                                 */
/* ========================================================================== */

/**
 * The three measurable hops. `ui-update` can only be measured by the client, so
 * the bridge records it from a client report or reports it as not measured.
 */
export type LatencyChannel = 'ingestion' | 'delivery' | 'ui-update';

export const LATENCY_CHANNELS: readonly LatencyChannel[] = ['ingestion', 'delivery', 'ui-update'];

/**
 * Which clocks produced a sample.
 *
 * same-process   both endpoints timestamped by this process. Trustworthy.
 * cross-process  the origin timestamp came from elsewhere. Skew is possible and
 *                unmeasurable from here, so the result is an approximation.
 */
export type ClockBasis = 'same-process' | 'cross-process';

/** What a whole window's worth of samples was built from. */
export type ReportedClockBasis = ClockBasis | 'mixed' | 'none';

/** Why a candidate sample was thrown away instead of being counted. */
export type LatencyRejectionReason =
  | 'not-finite'
  | 'negative-delta'
  | 'implausible-delta'
  | 'unknown-token'
  | 'duplicate-token'
  | 'expired-pending'
  | 'pending-overflow';

export const LATENCY_REJECTION_REASONS: readonly LatencyRejectionReason[] = [
  'not-finite',
  'negative-delta',
  'implausible-delta',
  'unknown-token',
  'duplicate-token',
  'expired-pending',
  'pending-overflow',
];

/**
 * The mission's targets, recorded so the report can print goal beside measured
 * fact. Nothing reads these to decide what to claim.
 */
export const LATENCY_TARGETS: Readonly<Record<LatencyChannel, { readonly p95Ms: number }>> = {
  ingestion: { p95Ms: 25 },
  delivery: { p95Ms: 50 },
  'ui-update': { p95Ms: 100 },
};

/** Default rolling window per channel. */
export const DEFAULT_LATENCY_WINDOW = 512;

/**
 * Above this, a "latency" is a queue that stalled or a clock that disagrees —
 * either way it is not a measurement of this hop, so it is rejected rather than
 * allowed to poison a percentile.
 */
export const MAX_PLAUSIBLE_LATENCY_MS = 300_000;

/** A delivery that is never acknowledged within this window stops waiting. */
export const DEFAULT_PENDING_TTL_MS = 60_000;

/** Hard cap on outstanding deliveries, so a silent client cannot grow memory. */
export const DEFAULT_MAX_PENDING = 10_000;

/* ========================================================================== */
/*  Report shapes                                                              */
/* ========================================================================== */

export interface LatencyStat {
  readonly channel: LatencyChannel;
  /** False when no sample survived validation. Every percentile is then null. */
  readonly measured: boolean;
  /** Samples currently inside the rolling window. */
  readonly sampleCount: number;
  /** Samples accepted over the tracker's whole life. */
  readonly totalObserved: number;
  /** Candidate samples thrown away, by reason. Never silently swallowed. */
  readonly rejectedSamples: number;
  readonly rejectionsByReason: Readonly<Record<LatencyRejectionReason, number>>;
  readonly windowSize: number;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly p99Ms: number | null;
  readonly minMs: number | null;
  readonly maxMs: number | null;
  readonly meanMs: number | null;
  readonly lastSampleAt: string | null;
  readonly clockBasis: ReportedClockBasis;
  /** Exactly how the numbers were produced, so they can be audited later. */
  readonly method: string;
  readonly targetP95Ms: number;
  /** Null means NOT MEASURED — never read it as a pass. */
  readonly meetsP95Target: boolean | null;
  /** Present when something about this statistic needs saying out loud. */
  readonly note: string | null;
}

export interface LatencyReport {
  readonly generatedAt: string;
  readonly windowSize: number;
  readonly channels: Readonly<Record<LatencyChannel, LatencyStat>>;
  readonly pendingDeliveries: number;
  /** Deliveries begun but never acknowledged, and now abandoned. */
  readonly expiredDeliveries: number;
  readonly uptimeMs: number;
  readonly note: string;
}

const PERCENTILE_METHOD =
  'nearest-rank percentile over a sorted copy of the rolling window: index = ceil(p/100 * n) - 1';

const REPORT_NOTE =
  'Targets are goals, not results. A null percentile means the hop was never measured, ' +
  'not that it was fast. Delivery is measured bridge-send to client-ack on one clock and ' +
  'is an upper bound on one-way delivery.';

/* ========================================================================== */
/*  The rolling window                                                         */
/* ========================================================================== */

/**
 * A fixed-capacity ring of samples plus the clock basis of each one, so an
 * evicted sample correctly stops counting towards the window's basis.
 * Allocation-free after construction.
 */
class SampleWindow {
  private readonly values: Float64Array;
  private readonly basis: Uint8Array;
  private readonly capacity: number;
  private next = 0;
  private size = 0;
  private crossProcessCount = 0;

  constructor(capacity: number) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.values = new Float64Array(this.capacity);
    this.basis = new Uint8Array(this.capacity);
  }

  push(valueMs: number, clockBasis: ClockBasis): void {
    const flag = clockBasis === 'cross-process' ? 1 : 0;
    if (this.size === this.capacity && this.basis[this.next] === 1) {
      this.crossProcessCount -= 1;
    }
    this.values[this.next] = valueMs;
    this.basis[this.next] = flag;
    if (flag === 1) this.crossProcessCount += 1;
    this.next = (this.next + 1) % this.capacity;
    if (this.size < this.capacity) this.size += 1;
  }

  get count(): number {
    return this.size;
  }

  get max(): number {
    return this.capacity;
  }

  /** 'none' when empty, otherwise whether the window is single- or two-clock. */
  reportedBasis(): ReportedClockBasis {
    if (this.size === 0) return 'none';
    if (this.crossProcessCount === 0) return 'same-process';
    if (this.crossProcessCount === this.size) return 'cross-process';
    return 'mixed';
  }

  /** Ascending copy of the live samples. */
  sorted(): number[] {
    const out: number[] = new Array<number>(this.size);
    for (let i = 0; i < this.size; i += 1) out[i] = this.values[i];
    out.sort((a, b) => a - b);
    return out;
  }

  sum(): number {
    let total = 0;
    for (let i = 0; i < this.size; i += 1) total += this.values[i];
    return total;
  }

  clear(): void {
    this.next = 0;
    this.size = 0;
    this.crossProcessCount = 0;
  }
}

/**
 * Nearest-rank percentile. Exported because the method must be checkable, not
 * taken on faith — the report names this function's rule in `method`.
 */
export function percentileOfSorted(sortedAscending: readonly number[], percentile: number): number | null {
  const n = sortedAscending.length;
  if (n === 0) return null;
  const p = Math.min(100, Math.max(0, percentile));
  let index = Math.ceil((p / 100) * n) - 1;
  if (index < 0) index = 0;
  if (index > n - 1) index = n - 1;
  return sortedAscending[index];
}

/* ========================================================================== */
/*  Per-channel state                                                          */
/* ========================================================================== */

function emptyRejectionCounts(): Record<LatencyRejectionReason, number> {
  return {
    'not-finite': 0,
    'negative-delta': 0,
    'implausible-delta': 0,
    'unknown-token': 0,
    'duplicate-token': 0,
    'expired-pending': 0,
    'pending-overflow': 0,
  };
}

interface ChannelState {
  window: SampleWindow;
  totalObserved: number;
  rejected: number;
  rejectionsByReason: Record<LatencyRejectionReason, number>;
  lastSampleAtMs: number | null;
}

function newChannelState(windowSize: number): ChannelState {
  return {
    window: new SampleWindow(windowSize),
    totalObserved: 0,
    rejected: 0,
    rejectionsByReason: emptyRejectionCounts(),
    lastSampleAtMs: null,
  };
}

/* ========================================================================== */
/*  Options and results                                                        */
/* ========================================================================== */

export interface LatencyTrackerOptions {
  readonly windowSize?: number;
  /** Injectable clock. Tests measure real arithmetic instead of sleeping. */
  readonly now?: () => number;
  readonly pendingTtlMs?: number;
  readonly maxPending?: number;
  readonly maxPlausibleMs?: number;
}

export type LatencySampleResult =
  | { readonly accepted: true; readonly channel: LatencyChannel; readonly valueMs: number; readonly clockBasis: ClockBasis }
  | { readonly accepted: false; readonly channel: LatencyChannel; readonly reason: LatencyRejectionReason; readonly detail: string };

/* ========================================================================== */
/*  The tracker                                                                */
/* ========================================================================== */

/**
 * Records what actually happened on each hop. Every public method either
 * produces a sample or explains, in a returned value, why it refused to.
 */
export class LatencyTracker {
  private readonly channels: Record<LatencyChannel, ChannelState>;
  private readonly windowSize: number;
  private readonly nowFn: () => number;
  private readonly pendingTtlMs: number;
  private readonly maxPending: number;
  private readonly maxPlausibleMs: number;
  private readonly pending = new Map<string, number>();
  private readonly startedAtMs: number;
  private expiredDeliveries = 0;

  constructor(options: LatencyTrackerOptions = {}) {
    this.windowSize =
      typeof options.windowSize === 'number' && Number.isFinite(options.windowSize) && options.windowSize > 0
        ? Math.floor(options.windowSize)
        : DEFAULT_LATENCY_WINDOW;
    this.nowFn = typeof options.now === 'function' ? options.now : () => Date.now();
    this.pendingTtlMs =
      typeof options.pendingTtlMs === 'number' && options.pendingTtlMs > 0 ? options.pendingTtlMs : DEFAULT_PENDING_TTL_MS;
    this.maxPending =
      typeof options.maxPending === 'number' && options.maxPending > 0 ? Math.floor(options.maxPending) : DEFAULT_MAX_PENDING;
    this.maxPlausibleMs =
      typeof options.maxPlausibleMs === 'number' && options.maxPlausibleMs > 0
        ? options.maxPlausibleMs
        : MAX_PLAUSIBLE_LATENCY_MS;
    this.channels = {
      ingestion: newChannelState(this.windowSize),
      delivery: newChannelState(this.windowSize),
      'ui-update': newChannelState(this.windowSize),
    };
    this.startedAtMs = this.nowFn();
  }

  /* ---------------------------------------------------------------------- */
  /*  Raw sample entry                                                        */
  /* ---------------------------------------------------------------------- */

  /**
   * Records one measured duration. A value that cannot be a duration of this
   * hop is rejected with a reason rather than repaired into a plausible one.
   */
  recordSample(channel: LatencyChannel, valueMs: number, clockBasis: ClockBasis): LatencySampleResult {
    const state = this.channels[channel];
    if (typeof valueMs !== 'number' || !Number.isFinite(valueMs)) {
      return this.reject(state, channel, 'not-finite', `value was ${String(valueMs)}`);
    }
    if (valueMs < 0) {
      // Negative means the "later" clock read earlier than the "earlier" one.
      // That is skew, not speed. Recording 0 would invent a perfect sample.
      return this.reject(state, channel, 'negative-delta', `${valueMs}ms — origin clock is ahead of this one`);
    }
    if (valueMs > this.maxPlausibleMs) {
      return this.reject(
        state,
        channel,
        'implausible-delta',
        `${valueMs}ms exceeds the ${this.maxPlausibleMs}ms plausibility ceiling`,
      );
    }
    state.window.push(valueMs, clockBasis);
    state.totalObserved += 1;
    state.lastSampleAtMs = this.nowFn();
    return { accepted: true, channel, valueMs, clockBasis };
  }

  private reject(
    state: ChannelState,
    channel: LatencyChannel,
    reason: LatencyRejectionReason,
    detail: string,
  ): LatencySampleResult {
    state.rejected += 1;
    state.rejectionsByReason[reason] += 1;
    return { accepted: false, channel, reason, detail };
  }

  /* ---------------------------------------------------------------------- */
  /*  Ingestion: runtime -> bridge                                            */
  /* ---------------------------------------------------------------------- */

  /**
   * @param originMs   when the producing side says the event happened
   * @param arrivalMs  when this process accepted it (defaults to now)
   */
  recordIngestion(originMs: number, arrivalMs?: number, clockBasis: ClockBasis = 'cross-process'): LatencySampleResult {
    if (!Number.isFinite(originMs)) {
      return this.reject(this.channels.ingestion, 'ingestion', 'not-finite', `origin timestamp was ${String(originMs)}`);
    }
    const arrival = typeof arrivalMs === 'number' && Number.isFinite(arrivalMs) ? arrivalMs : this.nowFn();
    return this.recordSample('ingestion', arrival - originMs, clockBasis);
  }

  /**
   * Measures a `ForgeEvent`'s trip into the bridge from the fields the contract
   * already carries: `timestamp` (written by the producer) and `ingestedAt`
   * (written here). An event from `bridge` or `test` was stamped by this
   * process, so it is a single-clock sample; anything else is two clocks.
   */
  recordIngestionFromEvent(event: ForgeEvent): LatencySampleResult {
    const originMs = Date.parse(event.timestamp);
    if (Number.isNaN(originMs)) {
      return this.reject(this.channels.ingestion, 'ingestion', 'not-finite', `unparseable event timestamp: ${event.timestamp}`);
    }
    const basis: ClockBasis = event.source === 'bridge' || event.source === 'test' ? 'same-process' : 'cross-process';
    const arrival = typeof event.ingestedAt === 'number' && Number.isFinite(event.ingestedAt) ? event.ingestedAt : this.nowFn();
    return this.recordSample('ingestion', arrival - originMs, basis);
  }

  /* ---------------------------------------------------------------------- */
  /*  Delivery: bridge send -> client ack (one clock, a round trip)           */
  /* ---------------------------------------------------------------------- */

  /** Marks the moment a frame left the bridge. `token` must be unique. */
  beginDelivery(token: string, atMs?: number): LatencySampleResult | null {
    const state = this.channels.delivery;
    if (this.pending.has(token)) {
      return this.reject(state, 'delivery', 'duplicate-token', `delivery token already outstanding: ${token}`);
    }
    if (this.pending.size >= this.maxPending) {
      this.sweepPendingDeliveries();
      if (this.pending.size >= this.maxPending) {
        return this.reject(state, 'delivery', 'pending-overflow', `more than ${this.maxPending} unacknowledged deliveries`);
      }
    }
    this.pending.set(token, typeof atMs === 'number' && Number.isFinite(atMs) ? atMs : this.nowFn());
    return null;
  }

  /** Marks the acknowledgement and produces the sample. */
  completeDelivery(token: string, atMs?: number): LatencySampleResult {
    const state = this.channels.delivery;
    const sentAt = this.pending.get(token);
    if (sentAt === undefined) {
      // Either never begun, or already swept. Both are honest non-measurements.
      return this.reject(state, 'delivery', 'unknown-token', `no outstanding delivery for token: ${token}`);
    }
    this.pending.delete(token);
    const ackAt = typeof atMs === 'number' && Number.isFinite(atMs) ? atMs : this.nowFn();
    return this.recordSample('delivery', ackAt - sentAt, 'same-process');
  }

  /** Abandons a delivery without recording a sample (e.g. the client left). */
  cancelDelivery(token: string): boolean {
    return this.pending.delete(token);
  }

  /** Drops deliveries older than the TTL. Returns how many were abandoned. */
  sweepPendingDeliveries(nowMs?: number): number {
    const now = typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : this.nowFn();
    const state = this.channels.delivery;
    let dropped = 0;
    for (const [token, sentAt] of this.pending) {
      if (now - sentAt > this.pendingTtlMs) {
        this.pending.delete(token);
        state.rejected += 1;
        state.rejectionsByReason['expired-pending'] += 1;
        this.expiredDeliveries += 1;
        dropped += 1;
      }
    }
    return dropped;
  }

  pendingDeliveryCount(): number {
    return this.pending.size;
  }

  /* ---------------------------------------------------------------------- */
  /*  UI update: measured by the client only                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Records a client-reported paint duration. The bridge cannot observe this
   * hop, so with no client reports the channel stays honestly not-measured.
   */
  recordUiUpdate(valueMs: number): LatencySampleResult {
    return this.recordSample('ui-update', valueMs, 'cross-process');
  }

  /* ---------------------------------------------------------------------- */
  /*  Reading the measurements                                                */
  /* ---------------------------------------------------------------------- */

  stat(channel: LatencyChannel): LatencyStat {
    const state = this.channels[channel];
    const n = state.window.count;
    const target = LATENCY_TARGETS[channel].p95Ms;

    if (n === 0) {
      return {
        channel,
        measured: false,
        sampleCount: 0,
        totalObserved: state.totalObserved,
        rejectedSamples: state.rejected,
        rejectionsByReason: { ...state.rejectionsByReason },
        windowSize: state.window.max,
        p50Ms: null,
        p95Ms: null,
        p99Ms: null,
        minMs: null,
        maxMs: null,
        meanMs: null,
        lastSampleAt: null,
        clockBasis: 'none',
        method: PERCENTILE_METHOD,
        targetP95Ms: target,
        meetsP95Target: null,
        note:
          state.rejected > 0
            ? `not measured — ${state.rejected} candidate sample(s) were rejected, none accepted`
            : 'not measured — no samples have been recorded on this channel',
      };
    }

    const sorted = state.window.sorted();
    const p95 = percentileOfSorted(sorted, 95);
    const basis = state.window.reportedBasis();

    return {
      channel,
      measured: true,
      sampleCount: n,
      totalObserved: state.totalObserved,
      rejectedSamples: state.rejected,
      rejectionsByReason: { ...state.rejectionsByReason },
      windowSize: state.window.max,
      p50Ms: percentileOfSorted(sorted, 50),
      p95Ms: p95,
      p99Ms: percentileOfSorted(sorted, 99),
      minMs: sorted[0],
      maxMs: sorted[n - 1],
      meanMs: state.window.sum() / n,
      lastSampleAt: state.lastSampleAtMs === null ? null : new Date(state.lastSampleAtMs).toISOString(),
      clockBasis: basis,
      method: PERCENTILE_METHOD,
      targetP95Ms: target,
      meetsP95Target: p95 === null ? null : p95 < target,
      note: noteForBasis(channel, basis, n),
    };
  }

  /** The whole picture, honestly labelled. */
  getLatencyReport(): LatencyReport {
    this.sweepPendingDeliveries();
    return {
      generatedAt: new Date(this.nowFn()).toISOString(),
      windowSize: this.windowSize,
      channels: {
        ingestion: this.stat('ingestion'),
        delivery: this.stat('delivery'),
        'ui-update': this.stat('ui-update'),
      },
      pendingDeliveries: this.pending.size,
      expiredDeliveries: this.expiredDeliveries,
      uptimeMs: Math.max(0, this.nowFn() - this.startedAtMs),
      note: REPORT_NOTE,
    };
  }

  /** Wipes samples. Used between test cases, never to hide a bad number. */
  reset(): void {
    for (const channel of LATENCY_CHANNELS) {
      const state = this.channels[channel];
      state.window.clear();
      state.totalObserved = 0;
      state.rejected = 0;
      state.rejectionsByReason = emptyRejectionCounts();
      state.lastSampleAtMs = null;
    }
    this.pending.clear();
    this.expiredDeliveries = 0;
  }
}

function noteForBasis(channel: LatencyChannel, basis: ReportedClockBasis, sampleCount: number): string | null {
  const parts: string[] = [];
  if (basis === 'cross-process' || basis === 'mixed') {
    parts.push(
      'contains two-clock samples (origin timestamp written by another process); ' +
        'unmeasurable clock skew makes this an approximation, not an exact duration',
    );
  }
  if (channel === 'delivery') {
    parts.push('measured bridge-send to client-ack — an upper bound on one-way delivery');
  }
  if (channel === 'ui-update') {
    parts.push('reported by the client; the bridge cannot observe this hop itself');
  }
  if (sampleCount < 20) {
    parts.push(`only ${sampleCount} sample(s) in the window — percentiles are coarse at this size`);
  }
  return parts.length === 0 ? null : parts.join('; ');
}

/* ========================================================================== */
/*  Process-wide default                                                       */
/* ========================================================================== */

/** The tracker the bridge uses unless a component is handed its own. */
export const defaultLatencyTracker = new LatencyTracker();

export function recordIngestionLatency(originMs: number, arrivalMs?: number, clockBasis?: ClockBasis): LatencySampleResult {
  return defaultLatencyTracker.recordIngestion(originMs, arrivalMs, clockBasis);
}

export function recordIngestionLatencyFromEvent(event: ForgeEvent): LatencySampleResult {
  return defaultLatencyTracker.recordIngestionFromEvent(event);
}

export function beginDeliveryMeasurement(token: string, atMs?: number): LatencySampleResult | null {
  return defaultLatencyTracker.beginDelivery(token, atMs);
}

export function completeDeliveryMeasurement(token: string, atMs?: number): LatencySampleResult {
  return defaultLatencyTracker.completeDelivery(token, atMs);
}

export function recordUiUpdateLatency(valueMs: number): LatencySampleResult {
  return defaultLatencyTracker.recordUiUpdate(valueMs);
}

/** The export the mission names. Reads the process-wide tracker. */
export function getLatencyReport(): LatencyReport {
  return defaultLatencyTracker.getLatencyReport();
}
