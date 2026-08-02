/**
 * Load & performance — EVENT THROUGHPUT (mission section I).
 *
 * SYNTHETIC. Every event pushed through here is fabricated in this file and
 * labelled so in the test names and the report. None of it is evidence that a
 * real Claude Code run happened. It measures how the real store and the real
 * transport client behave as the event count grows.
 *
 * TWO REAL PATHS ARE EXERCISED.
 *
 *  STORE (src/bridge/storage/store.ts) — the durable JSONL log.
 *    · append latency (ingestion): every `appendEvent` is timed, including the
 *      per-line fsync that makes it durable. That fsync is why 100k live appends
 *      do NOT stay under a few seconds, so 100k append is measured only when a
 *      calibration from the 10k run projects it under budget, and otherwise
 *      recorded as skipped with the projected cost — never faked.
 *    · gap-detection cost: `detectGaps` over the whole stream.
 *    · replay cost: `readEvents` page reads, paginated to the stream's end.
 *    · ASSERTED: sequences are monotonic 1..N with zero loss and no gaps, both
 *      on the append path and on the replay path. The 100k stream used for
 *      replay/gap timing is SEEDED with one batched write (the same technique the
 *      chaos suite uses) so those two costs can be measured without 100k fsyncs;
 *      the read itself is the real store operation.
 *
 *  TRANSPORT (src/prototype/state/bridge-client.ts) — the sequencing client.
 *    · delivery latency: driven through the real `onEventFrame` path with a fake
 *      in-memory socket, reading the client's own measured `delivery` channel
 *      (arrival − ingestedAt, labelled cross-process by the tracker).
 *    · ASSERTED: events are handed to the listener strictly in order, 1..N, with
 *      zero loss under a burst; an injected gap is buffered, replayed, and
 *      reconciled with no loss and no out-of-order delivery.
 *
 * Mission targets (ingestion p95 < 25ms, delivery p95 < 50ms) are MEASURED and
 * reported, never asserted as pass/fail — a target is a goal, not a result.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { arch, platform, version as nodeVersion } from 'node:process';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { ForgeStore } from '../../src/bridge/storage/store.ts';
import { EVENT_SCHEMA_VERSION } from '../../src/bridge/storage/schema.ts';
import type { ForgeEvent } from '../../src/shared/protocol.ts';

import { PROTOCOL_SCHEMA_VERSION } from '@/shared/protocol';
import { BridgeClient } from '@/prototype/state/bridge-client';
import type { BridgeNotice } from '@/prototype/state/bridge-client';

/* ------------------------------------------------------------------ output */

const OUT_DIR = join(tmpdir(), 'forge-perf-suite');
const OUT_FILE = join(OUT_DIR, 'event-throughput.json');
const BANNER = 'SYNTHETIC — throughput only, not execution proof';

/** Above this projected cost, 100k live appends are not attempted (fsync-bound). */
const APPEND_BUDGET_MS = 8_000;

/* --------------------------------------------------------------- statistics */

interface Summary {
  readonly sampleCount: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly meanMs: number;
}

function round(value: number, places = 5): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

function percentile(sortedAsc: readonly number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return NaN;
  let index = Math.ceil((p / 100) * n) - 1;
  if (index < 0) index = 0;
  if (index > n - 1) index = n - 1;
  return sortedAsc[index];
}

function summarize(samplesMs: readonly number[]): Summary {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    sampleCount: n,
    p50Ms: round(percentile(sorted, 50)),
    p95Ms: round(percentile(sorted, 95)),
    p99Ms: round(percentile(sorted, 99)),
    minMs: round(sorted[0] ?? NaN),
    maxMs: round(sorted[n - 1] ?? NaN),
    meanMs: round(n > 0 ? sum / n : NaN),
  };
}

/** [1, 2, … N] with nothing repeated and nothing skipped. */
function isMonotonicContiguous(sequences: readonly number[], expectedCount: number): boolean {
  if (sequences.length !== expectedCount) return false;
  for (let i = 0; i < sequences.length; i += 1) {
    if (sequences[i] !== i + 1) return false;
  }
  return true;
}

/* --------------------------------------------------- scratch store lifecycle */

let scratchDirs: string[] = [];
let openStores: ForgeStore[] = [];

function workspace(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `forge-load-${label}-`));
  // A guard, not decoration: if this ever resolved somewhere real the whole
  // suite would be appending thousands of events into a live workspace.
  if (!resolve(dir).startsWith(resolve(tmpdir()))) {
    throw new Error(`refusing to run: the scratch workspace ${dir} is not under the OS temp directory`);
  }
  scratchDirs.push(dir);
  return dir;
}

function openAt(dir: string, bridgeInstanceId: string): ForgeStore {
  const store = ForgeStore.open({ dataDir: dir, bridgeInstanceId });
  openStores.push(store);
  return store;
}

function seedLayout(dir: string): void {
  const seed = ForgeStore.open({ dataDir: dir, bridgeInstanceId: 'layout-seed' });
  seed.close();
}

afterEach(() => {
  for (const store of openStores) {
    try {
      store.close();
    } catch {
      /* already closed by the test; closing twice is documented as safe */
    }
  }
  openStores = [];
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
  scratchDirs = [];
});

/* ------------------------------------------------------ synthetic event data */

const ISO = (offsetMs = 0): string => new Date(Date.UTC(2026, 6, 24, 12, 0, 0) + offsetMs).toISOString();

/** One fabricated, contract-valid event line for a seeded stream. */
function seedLine(sequence: number, projectId: string, runId: string): string {
  const event: ForgeEvent<{ readonly i: number }> = {
    eventId: `seed-${runId}-${sequence}`,
    schemaVersion: EVENT_SCHEMA_VERSION,
    sequence,
    timestamp: ISO(sequence),
    projectId,
    runId,
    sessionId: null,
    conversationId: null,
    taskId: null,
    agentId: null,
    source: 'bridge',
    type: 'run.output.delta',
    payload: { i: sequence },
    evidenceRefs: [],
    ingestedAt: Date.UTC(2026, 6, 24, 12, 0, 0) + sequence,
  };
  return JSON.stringify(event);
}

function streamPath(dir: string, streamKey: string): string {
  return join(dir, 'events', `${streamKey}.jsonl`);
}

/* ------------------------------------------------------------ result record */

const results: Record<string, unknown> = {
  suite: 'event-throughput',
  synthetic: true,
  banner: BANNER,
  generatedAt: new Date().toISOString(),
  env: { node: nodeVersion, platform, arch },
  targets: { ingestionP95Ms: 25, deliveryP95Ms: 50 },
  store: { append: [] as unknown[], gapDetection: [] as unknown[], replay: [] as unknown[] },
  transport: { delivery: [] as unknown[], gapReconciliation: {} as Record<string, unknown> },
  assessment: {} as Record<string, unknown>,
};

function storeSection(): { append: unknown[]; gapDetection: unknown[]; replay: unknown[] } {
  return results.store as { append: unknown[]; gapDetection: unknown[]; replay: unknown[] };
}
function transportSection(): { delivery: unknown[]; gapReconciliation: Record<string, unknown> } {
  return results.transport as { delivery: unknown[]; gapReconciliation: Record<string, unknown> };
}

afterAll(() => {
  // Honest, measured assessment against the mission targets — derived from the
  // numbers that were actually recorded, or null when a size was not measured.
  const append = storeSection().append as Array<Record<string, unknown>>;
  const delivery = transportSection().delivery as Array<Record<string, unknown>>;

  const append10k = append.find((r) => r.events === 10_000);
  const ingestionP95 =
    append10k && append10k.appendMs ? (append10k.appendMs as Summary).p95Ms : null;
  const largestDelivery = delivery.length > 0 ? delivery[delivery.length - 1] : null;
  const deliveryStat = largestDelivery ? (largestDelivery.deliveryLatency as Record<string, unknown> | undefined) : undefined;
  const deliveryP95 = deliveryStat && typeof deliveryStat.p95Ms === 'number' ? (deliveryStat.p95Ms as number) : null;

  results.assessment = {
    ingestion: {
      basis: 'store durable appendEvent p95 at 10k events',
      p95Ms: ingestionP95,
      targetP95Ms: 25,
      meetsP95Target: ingestionP95 === null ? null : ingestionP95 < 25,
    },
    delivery: {
      basis: 'transport client measured delivery channel p95 at the largest burst',
      p95Ms: deliveryP95,
      targetP95Ms: 50,
      meetsP95Target: deliveryP95 === null ? null : deliveryP95 < 50,
      note: 'delivery is arrival − ingestedAt, labelled cross-process by the tracker — an approximation, not an exact duration',
    },
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(results, null, 2), 'utf8');
});

/* ========================================================================== */
/*  Store — durable append latency (ingestion)                                 */
/* ========================================================================== */

interface AppendMeasurement {
  readonly assigned: number[];
  readonly samples: number[];
  readonly totalMs: number;
  readonly gaps: number;
}

function measureAppend(count: number, label: string): AppendMeasurement {
  const dir = workspace(label);
  const store = openAt(dir, `append-${label}`);
  const assigned: number[] = new Array<number>(count);
  const samples: number[] = new Array<number>(count);
  const t0 = performance.now();
  for (let i = 0; i < count; i += 1) {
    const start = performance.now();
    const result = store.appendEvent({
      projectId: 'perf',
      runId: 'append',
      source: 'bridge',
      type: 'run.output.delta',
      payload: { i },
    });
    samples[i] = performance.now() - start;
    assigned[i] = result.event.sequence;
  }
  const totalMs = performance.now() - t0;
  const gaps = store.detectGaps('perf~append').length;
  return { assigned, samples, totalMs, gaps };
}

describe('SYNTHETIC store append — durable ingestion latency, monotonic & lossless', () => {
  it('appends 1k and 10k synthetic events, times each, and proves no loss', () => {
    const sizes = [
      { count: 1_000, label: '1k' },
      { count: 10_000, label: '10k' },
    ];
    let mean10k = NaN;

    for (const size of sizes) {
      const measurement = measureAppend(size.count, size.label);
      const summary = summarize(measurement.samples);

      // The store handed out 1..N with nothing repeated or skipped, and it agrees
      // with itself: detectGaps finds no hole.
      expect(isMonotonicContiguous(measurement.assigned, size.count)).toBe(true);
      expect(new Set(measurement.assigned).size).toBe(size.count);
      expect(measurement.gaps).toBe(0);

      if (size.count === 10_000) mean10k = summary.meanMs;

      storeSection().append.push({
        events: size.count,
        monotonic: true,
        lossless: true,
        gaps: measurement.gaps,
        totalMs: round(measurement.totalMs, 2),
        eventsPerSecond: round((size.count / measurement.totalMs) * 1000, 1),
        appendMs: summary,
      });
    }

    // 100k live appends only if a calibration from 10k projects them under budget.
    const projected100kMs = round(mean10k * 100_000, 1);
    if (Number.isFinite(mean10k) && projected100kMs <= APPEND_BUDGET_MS) {
      const measurement = measureAppend(100_000, '100k');
      const summary = summarize(measurement.samples);
      expect(isMonotonicContiguous(measurement.assigned, 100_000)).toBe(true);
      expect(measurement.gaps).toBe(0);
      storeSection().append.push({
        events: 100_000,
        monotonic: true,
        lossless: true,
        gaps: measurement.gaps,
        totalMs: round(measurement.totalMs, 2),
        eventsPerSecond: round((100_000 / measurement.totalMs) * 1000, 1),
        appendMs: summary,
      });
    } else {
      storeSection().append.push({
        events: 100_000,
        skipped: true,
        reason: `durable fsync-per-append: projected ~${projected100kMs}ms exceeds the ${APPEND_BUDGET_MS}ms budget for "a few seconds"; append latency is characterised at 1k and 10k, and 100k throughput is proved on the transport path and via seeded-stream replay`,
        projectedMs: projected100kMs,
      });
    }
  });
});

/* ========================================================================== */
/*  Store — replay cost and gap-detection cost                                 */
/* ========================================================================== */

describe('SYNTHETIC store replay — replay & gap-detection cost, monotonic & lossless', () => {
  it('seeds 1k / 10k / 100k streams and measures replay + gap detection with no loss', () => {
    const dir = workspace('replay');
    seedLayout(dir);

    const cases = [
      { count: 1_000, runId: 'r1k' },
      { count: 10_000, runId: 'r10k' },
      { count: 100_000, runId: 'r100k' },
    ];

    // Seed each stream with one batched write, avoiding N fsyncs. The READ is the
    // real store operation; only the seeding is batched.
    for (const testCase of cases) {
      const lines: string[] = new Array<string>(testCase.count);
      for (let seq = 1; seq <= testCase.count; seq += 1) lines[seq - 1] = seedLine(seq, 'perf', testCase.runId);
      writeFileSync(streamPath(dir, `perf~${testCase.runId}`), `${lines.join('\n')}\n`, 'utf8');
    }

    const store = openAt(dir, 'replay-reader');

    for (const testCase of cases) {
      const streamKey = `perf~${testCase.runId}`;

      // Gap-detection cost over the whole stream (and it must find none).
      const gapStart = performance.now();
      const gaps = store.detectGaps(streamKey);
      const detectGapsMs = round(performance.now() - gapStart, 4);
      expect(gaps).toHaveLength(0);

      // One max-size page read — the store re-scans and validates the whole file.
      const pageStart = performance.now();
      const firstPage = store.readEvents({ streamKey, fromSequence: 1, limit: 50_000 });
      const replayPageMs = round(performance.now() - pageStart, 4);

      // Full replay, paginated to the end, accumulating every event in order.
      const fullStart = performance.now();
      const collected: number[] = [];
      let cursor = 1;
      let pages = 0;
      for (;;) {
        const page = store.readEvents({ streamKey, fromSequence: cursor, limit: 50_000 });
        pages += 1;
        for (const event of page.events) collected.push(event.sequence);
        if (!page.hasMore || page.nextSequence === null || page.events.length === 0) break;
        cursor = page.nextSequence;
      }
      const replayFullMs = round(performance.now() - fullStart, 4);

      // The replayed stream is monotonic 1..N with zero loss.
      expect(isMonotonicContiguous(collected, testCase.count)).toBe(true);
      expect(firstPage.events.length).toBeGreaterThan(0);

      storeSection().gapDetection.push({ events: testCase.count, detectGapsMs, gaps: gaps.length });
      storeSection().replay.push({
        events: testCase.count,
        pages,
        replayedCount: collected.length,
        monotonic: true,
        lossless: true,
        replayPageMs,
        replayFullMs,
        eventsPerSecondFull: round((testCase.count / replayFullMs) * 1000, 1),
      });
    }
  });
});

/* ========================================================================== */
/*  Transport — the fake socket the real client is driven through              */
/* ========================================================================== */

type WsHandler = ((event?: unknown) => void) | null;

/** A minimal in-memory stand-in for the browser WebSocket the client opens. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  onopen: WsHandler = null;
  onmessage: WsHandler = null;
  onerror: WsHandler = null;
  onclose: WsHandler = null;
  readonly sent: string[] = [];

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.readyState = 3;
  }
}

interface Harness {
  readonly client: BridgeClient;
  readonly sock: FakeWebSocket;
  readonly delivered: number[];
  readonly notices: BridgeNotice[];
  emit(frame: Record<string, unknown>): void;
  restore(): void;
}

function emitTo(sock: FakeWebSocket, frame: Record<string, unknown>): void {
  if (sock.onmessage) sock.onmessage({ data: JSON.stringify(frame) });
}

/** Stand the real client up on a fake socket, subscribed and anchored at head 0. */
function createHarness(streamKey: string): Harness {
  const originalWebSocket = globalThis.WebSocket;
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket as unknown as typeof globalThis.WebSocket;

  const client = new BridgeClient();
  const delivered: number[] = [];
  const notices: BridgeNotice[] = [];
  client.onEvent((event) => delivered.push(event.sequence));
  client.onNotice((notice) => notices.push(notice));
  client.connect();

  const sock = FakeWebSocket.instances[0];
  sock.readyState = 1;
  if (sock.onopen) sock.onopen();

  emitTo(sock, {
    kind: 'hello',
    sentAt: Date.now(),
    bridgeInstanceId: 'perf-bridge',
    clientId: 'perf-client',
    protocolSchemaVersion: PROTOCOL_SCHEMA_VERSION,
    heartbeatIntervalMs: 15_000,
  });
  emitTo(sock, {
    kind: 'subscribed',
    sentAt: Date.now(),
    heads: [{ streamKey, sequence: 0 }],
    all: true,
    unknown: [],
  });

  return {
    client,
    sock,
    delivered,
    notices,
    emit: (frame) => emitTo(sock, frame),
    restore: () => {
      client.disconnect();
      globalThis.WebSocket = originalWebSocket;
    },
  };
}

function synthEvent(streamKey: string, sequence: number): ForgeEvent<{ readonly i: number }> {
  return {
    eventId: `xport-${streamKey}-${sequence}`,
    schemaVersion: EVENT_SCHEMA_VERSION,
    sequence,
    timestamp: new Date().toISOString(),
    projectId: 'perf',
    runId: 'xport',
    sessionId: null,
    conversationId: null,
    taskId: null,
    agentId: null,
    source: 'test',
    type: 'run.output.delta',
    payload: { i: sequence },
    evidenceRefs: [],
    ingestedAt: Date.now(),
  };
}

function eventFrame(streamKey: string, sequence: number): Record<string, unknown> {
  return { kind: 'event', sentAt: Date.now(), streamKey, event: synthEvent(streamKey, sequence) };
}

describe('SYNTHETIC transport delivery — monotonic, lossless, measured latency', () => {
  const CASES = [1_000, 10_000, 100_000];

  for (const count of CASES) {
    it(`delivers ${count} synthetic events in order with zero loss`, () => {
      const streamKey = 'perf~xport';
      const harness = createHarness(streamKey);
      try {
        const t0 = performance.now();
        for (let seq = 1; seq <= count; seq += 1) harness.emit(eventFrame(streamKey, seq));
        const pushMs = performance.now() - t0;

        // Every event reached the listener, exactly once, strictly in order.
        expect(isMonotonicContiguous(harness.delivered, count)).toBe(true);

        // The stream tracker confirms the same contiguous head — no buffered hole.
        const snapshot = harness.client.getStreamSnapshots().find((s) => s.streamKey === streamKey);
        expect(snapshot?.lastConfirmedSequence).toBe(count);
        expect(snapshot?.buffered).toBe(0);
        expect(snapshot?.degraded).toBe(false);

        const report = harness.client.getLatencyReport();
        const deliveryStat = report.channels.delivery;
        const uiStat = report.channels['ui-update'];

        transportSection().delivery.push({
          events: count,
          deliveredCount: harness.delivered.length,
          monotonic: true,
          lossless: true,
          pushDurationMs: round(pushMs, 2),
          eventsPerSecond: round((count / pushMs) * 1000, 1),
          deliveryLatency: {
            measured: deliveryStat.measured,
            sampleCount: deliveryStat.sampleCount,
            totalObserved: deliveryStat.totalObserved,
            windowSize: deliveryStat.windowSize,
            p50Ms: deliveryStat.p50Ms,
            p95Ms: deliveryStat.p95Ms,
            p99Ms: deliveryStat.p99Ms,
            minMs: deliveryStat.minMs,
            maxMs: deliveryStat.maxMs,
            meanMs: deliveryStat.meanMs === null ? null : round(deliveryStat.meanMs),
            clockBasis: deliveryStat.clockBasis,
            targetP95Ms: deliveryStat.targetP95Ms,
            meetsP95Target: deliveryStat.meetsP95Target,
            note: deliveryStat.note,
          },
          uiUpdateLatency: {
            measured: uiStat.measured,
            sampleCount: uiStat.sampleCount,
            p50Ms: uiStat.p50Ms,
            p95Ms: uiStat.p95Ms,
            p99Ms: uiStat.p99Ms,
          },
        });
      } finally {
        harness.restore();
      }
    });
  }
});

describe('SYNTHETIC transport gap — an injected hole is buffered, replayed, reconciled', () => {
  it('never delivers out of order and loses nothing when a sequence is missing', () => {
    const streamKey = 'perf~gap';
    const harness = createHarness(streamKey);
    try {
      const start = performance.now();

      // 1, 2, 3 arrive live and are delivered immediately.
      for (const seq of [1, 2, 3]) harness.emit(eventFrame(streamKey, seq));
      // 5 arrives before 4: it must be BUFFERED, not delivered out of order.
      harness.emit(eventFrame(streamKey, 5));
      expect(harness.delivered).toEqual([1, 2, 3]);
      const midSnapshot = harness.client.getStreamSnapshots().find((s) => s.streamKey === streamKey);
      expect(midSnapshot?.degraded).toBe(true);
      expect(midSnapshot?.buffered).toBe(1);

      // The client asked to replay from 4; answer with 4, which unlocks 5.
      harness.emit({
        kind: 'events',
        sentAt: Date.now(),
        streamKey,
        reason: 'replay',
        fromSequence: 4,
        events: [synthEvent(streamKey, 4)],
        complete: true,
        nextSequence: 5,
        gaps: [],
      });
      const reconcileMs = round(performance.now() - start, 4);

      // The final delivered order is the whole run, in order, with no loss.
      expect(harness.delivered).toEqual([1, 2, 3, 4, 5]);
      const endSnapshot = harness.client.getStreamSnapshots().find((s) => s.streamKey === streamKey);
      expect(endSnapshot?.degraded).toBe(false);
      expect(endSnapshot?.buffered).toBe(0);
      expect(endSnapshot?.lastConfirmedSequence).toBe(5);

      const reconciled = harness.notices.some((n) => n.type === 'bridge.reconciled');
      const degraded = harness.notices.some((n) => n.type === 'bridge.degraded');
      expect(degraded).toBe(true);
      expect(reconciled).toBe(true);

      transportSection().gapReconciliation = {
        scenario: 'live sequence 4 missing; 5 arrives first, is buffered; 4 replayed; 5 drained',
        injectedGap: [4, 4],
        outOfOrderDeliveries: 0,
        finalDeliveredOrder: [1, 2, 3, 4, 5],
        finalMonotonic: true,
        lossless: true,
        degradedRaised: degraded,
        reconciled,
        reconcileMs,
      };
    } finally {
      harness.restore();
    }
  });
});
