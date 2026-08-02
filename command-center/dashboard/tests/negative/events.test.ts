/**
 * Negative suite — events and streams (mission section F).
 *
 * Each case drives a real module — the durable store (`storage/store.ts`), the
 * shared state machines (`shared/state-machines.ts`) and the usage aggregator
 * (`usage/aggregator.ts`) — into a failure it must handle honestly, and asserts
 * the SPECIFIC failure mode, not merely that something went wrong.
 *
 * The six failures under test:
 *
 *   duplicate event        stored once; the second write changes nothing.
 *   out-of-order sequence  replays in sequence order; the next append continues
 *                          from the HIGHEST sequence, and the hole below it is
 *                          reported as a gap rather than numbered around.
 *   a missing sequence     detected as a gap AND recorded as a `bridge.degraded`
 *                          event carrying status DEGRADED.
 *   a malformed event      an unknown type is refused with a field-named reason
 *                          and the stream still works; a bad line already on disk
 *                          is skipped, recorded, and LEFT there as evidence.
 *   an illegal transition  the state machine throws a typed error naming what was
 *                          refused — a terminal state, or a move not in the table.
 *   a stale usage event    a usage event from the wrong session is rejected with
 *                          SESSION_MISMATCH and never merged into the bound scope.
 *
 * Isolation: every workspace is an `mkdtemp` under the OS temp directory, passed
 * explicitly as `dataDir`, so nothing real is ever written.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { ForgeStore, StoreValidationError } from '../../src/bridge/storage/store.ts';
import { EVENT_SCHEMA_VERSION } from '../../src/bridge/storage/schema.ts';
import {
  StateTransitionError,
  assertAttachmentTransition,
  assertPermissionTransition,
  assertRunTransition,
  canRunTransition,
  explainRunTransition,
} from '../../src/shared/state-machines.ts';
import { UsageAggregator } from '../../src/bridge/usage/aggregator.ts';
import type { EventType, ForgeEvent } from '../../src/shared/protocol.ts';

/* ------------------------------------------------------------------ fixtures */

let scratchDirs: string[] = [];
let openStores: ForgeStore[] = [];

function workspace(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `forge-neg-ev-${label}-`));
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

afterEach(() => {
  for (const store of openStores) {
    try {
      store.close();
    } catch {
      /* closing twice is documented as safe */
    }
  }
  openStores = [];
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
  scratchDirs = [];
});

/* ------------------------------------------------------------------- helpers */

const ISO = (offsetMs = 0): string => new Date(Date.UTC(2026, 6, 24, 12, 0, 0) + offsetMs).toISOString();

function streamPath(dir: string, streamKey: string): string {
  return join(dir, 'events', `${streamKey}.jsonl`);
}

function streamLines(dir: string, streamKey: string): string[] {
  return readFileSync(streamPath(dir, streamKey), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0);
}

/** A raw JSONL line written behind the store's back, to simulate a damaged log. */
function rawLine(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    eventId: `raw-${String(overrides.sequence ?? overrides.eventId ?? 0)}`,
    schemaVersion: EVENT_SCHEMA_VERSION,
    sequence: 1,
    timestamp: ISO(),
    projectId: 'projx',
    runId: 'runx',
    sessionId: null,
    conversationId: null,
    taskId: null,
    agentId: null,
    source: 'bridge',
    type: 'run.state',
    payload: {},
    evidenceRefs: [],
    ...overrides,
  });
}

function seedLayout(dir: string): void {
  const seed = ForgeStore.open({ dataDir: dir, bridgeInstanceId: 'layout-seed' });
  seed.close();
}

function degradedReasons(store: ForgeStore): string[] {
  return store
    .readEvents({ projectId: '__bridge__', runId: null, types: ['bridge.degraded'], limit: 500 })
    .events.map((event) => (event.payload as { reason: string }).reason);
}

/** A well-formed `claude.usage` event whose envelope reports `inputTokens` tokens. */
function usageEvent(eventId: string, sessionId: string, inputTokens: number): ForgeEvent {
  return {
    eventId,
    schemaVersion: EVENT_SCHEMA_VERSION,
    sequence: 1,
    timestamp: ISO(),
    projectId: 'proj-1',
    runId: 'run-1',
    sessionId,
    conversationId: null,
    taskId: null,
    agentId: null,
    source: 'claude-code',
    type: 'claude.usage',
    payload: {
      envelope: {
        session_id: sessionId,
        usage: {
          input_tokens: inputTokens,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        total_cost_usd: 0.01,
        num_turns: 1,
        modelUsage: { 'claude-x': { contextWindow: 200_000 } },
      },
    },
    evidenceRefs: [],
    ingestedAt: Date.UTC(2026, 6, 24, 12, 0, 0),
  };
}

/* ========================================================================== */
/*  A duplicate event is stored once                                           */
/* ========================================================================== */

describe('a duplicate event', () => {
  it('is stored once and the retry returns the event already on disk', () => {
    const dir = workspace('dup');
    const store = openAt(dir, 'dup-1');

    const first = store.appendEvent({
      eventId: 'evt-dup',
      projectId: 'projd',
      runId: 'rund',
      source: 'bridge',
      type: 'run.created',
      payload: { attempt: 1 },
    });
    const second = store.appendEvent({
      eventId: 'evt-dup',
      projectId: 'projd',
      runId: 'rund',
      source: 'bridge',
      type: 'run.created',
      payload: { attempt: 999 },
    });

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    // The stored event wins; the retry's payload is discarded, and no second line.
    expect(second.event.sequence).toBe(1);
    expect((second.event.payload as { attempt: number }).attempt).toBe(1);
    expect(streamLines(dir, 'projd~rund')).toHaveLength(1);
    expect(store.detectGaps('projd~rund')).toHaveLength(0);
  });
});

/* ========================================================================== */
/*  An out-of-order sequence                                                   */
/* ========================================================================== */

describe('a log written out of sequence order', () => {
  it('replays in sequence order and the next append continues from the highest seen', () => {
    const dir = workspace('order');
    seedLayout(dir);
    writeFileSync(
      streamPath(dir, 'projx~runx'),
      `${[
        rawLine({ sequence: 5, eventId: 'ooo-5' }),
        rawLine({ sequence: 4, eventId: 'ooo-4' }),
      ].join('\n')}\n`,
    );

    const store = openAt(dir, 'order-1');
    const page = store.readEvents({ projectId: 'projx', runId: 'runx' });
    // On disk the last LINE is sequence 4, but replay is by sequence.
    expect(page.events.map((e) => e.sequence)).toEqual([4, 5]);

    const appended = store.appendEvent({
      projectId: 'projx',
      runId: 'runx',
      source: 'bridge',
      type: 'run.state',
      payload: {},
    });
    // The next sequence is 6 — from the highest seen, not from the last line.
    expect(appended.event.sequence).toBe(6);
    // 1..3 were never on disk, so they are a reported gap, not numbered around.
    expect(store.detectGaps('projx~runx')).toEqual([{ from: 1, to: 3, count: 3 }]);
  });
});

/* ========================================================================== */
/*  A missing sequence -> DEGRADED                                             */
/* ========================================================================== */

describe('a missing sequence', () => {
  it('is detected as a gap and recorded as a DEGRADED event that names the range', () => {
    const dir = workspace('gap');
    seedLayout(dir);
    writeFileSync(
      streamPath(dir, 'projx~runx'),
      `${[1, 2, 5].map((sequence) => rawLine({ sequence, eventId: `gd-${sequence}` })).join('\n')}\n`,
    );

    const store = openAt(dir, 'gap-1');

    // The gap itself.
    expect(store.detectGaps('projx~runx')).toEqual([{ from: 3, to: 4, count: 2 }]);

    // Reconciliation reports the stream and records the degraded event.
    const report = store.reconcileOnStartup();
    expect(report.gaps.map((g) => g.streamKey)).toContain('projx~runx');

    const degraded = store.readEvents({
      projectId: '__bridge__',
      runId: null,
      types: ['bridge.degraded'],
      limit: 500,
    }).events;
    const gapEvent = degraded.find((e) => (e.payload as { reason: string }).reason === 'events.sequence-gap');

    expect(gapEvent).toBeDefined();
    // DEGRADED is asserted on the event, never inferred by a reader.
    expect(gapEvent?.status).toBe('DEGRADED');
    expect((gapEvent?.payload as { detail: string }).detail).toContain('3..4');
    expect((gapEvent?.payload as { detail: string }).detail).toContain('incomplete');
  });
});

/* ========================================================================== */
/*  A malformed event is refused and recorded, and the stream survives         */
/* ========================================================================== */

describe('a malformed event', () => {
  it('an unknown event type is refused with a reason that names the field, and the stream survives', () => {
    const dir = workspace('malformed');
    const store = openAt(dir, 'mal-1');

    store.appendEvent({ projectId: 'projm', runId: 'runm', source: 'bridge', type: 'run.created', payload: { i: 1 } });
    const bytesBefore = readFileSync(streamPath(dir, 'projm~runm'), 'utf8');

    let thrown: unknown = null;
    try {
      store.appendEvent({
        projectId: 'projm',
        runId: 'runm',
        source: 'bridge',
        // An invented vocabulary is how a lie enters a log that is replayed as history.
        type: 'run.definitely.succeeded' as EventType,
        payload: {},
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(StoreValidationError);
    const issues = (thrown as StoreValidationError).issues;
    expect(issues.some((issue) => issue.field === 'type')).toBe(true);
    expect(issues.map((issue) => issue.detail).join(' ')).toContain('unknown event type');

    // Nothing reached disk and the sequence did not move; the stream still works.
    expect(readFileSync(streamPath(dir, 'projm~runm'), 'utf8')).toBe(bytesBefore);
    const next = store.appendEvent({ projectId: 'projm', runId: 'runm', source: 'bridge', type: 'run.state', payload: { i: 2 } });
    expect(next.event.sequence).toBe(2);
    expect(streamLines(dir, 'projm~runm')).toHaveLength(2);
  });

  it('a bad line already on disk is skipped, recorded, and left there as evidence', () => {
    const dir = workspace('malformed-line');
    seedLayout(dir);
    writeFileSync(
      streamPath(dir, 'projx~runx'),
      `${rawLine({ sequence: 1, eventId: 'ml-1' })}\n${rawLine({
        sequence: 2,
        eventId: 'ml-2',
        type: 'not.a.real.event',
      })}\n${rawLine({ sequence: 3, eventId: 'ml-3' })}\n`,
    );

    const store = openAt(dir, 'mal-2');
    const page = store.readEvents({ projectId: 'projx', runId: 'runx' });

    // The invalid line is skipped for replay; its sequence shows up as a hole.
    expect(page.events.map((e) => e.sequence)).toEqual([1, 3]);
    expect(store.detectGaps('projx~runx')).toEqual([{ from: 2, to: 2, count: 1 }]);
    expect(store.degradedNotes().map((n) => n.reason)).toContain('events.invalid-line');
    expect(degradedReasons(store)).toContain('events.invalid-line');
    // The damaged bytes are still on disk. The log is evidence, not a cache.
    expect(readFileSync(streamPath(dir, 'projx~runx'), 'utf8')).toContain('not.a.real.event');
  });

  it('refuses an event whose status is not an OperationalStatus', () => {
    const dir = workspace('malformed-status');
    const store = openAt(dir, 'mal-3');
    expect(() =>
      store.appendEvent({
        projectId: 'projm',
        runId: 'runm',
        source: 'bridge',
        type: 'run.state',
        status: 'DEFINITELY_FINE' as never,
        payload: {},
      }),
    ).toThrow(StoreValidationError);
  });
});

/* ========================================================================== */
/*  An illegal state transition throws                                         */
/* ========================================================================== */

describe('an illegal state transition throws a typed error', () => {
  it('a run cannot leave a terminal state (FAILED -> COMPLETED)', () => {
    expect(canRunTransition('FAILED', 'COMPLETED')).toBe(false);

    let thrown: unknown = null;
    try {
      assertRunTransition('FAILED', 'COMPLETED');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(StateTransitionError);
    expect((thrown as StateTransitionError).rejection).toBe('TERMINAL_STATE');
    expect((thrown as StateTransitionError).from).toBe('FAILED');
    expect((thrown as StateTransitionError).to).toBe('COMPLETED');
  });

  it('a run cannot jump straight from RUNNING to COMPLETED (not in the table)', () => {
    const verdict = explainRunTransition('RUNNING', 'COMPLETED');
    expect(verdict.ok).toBe(false);
    expect(verdict.rejection).toBe('NOT_ALLOWED');
    expect(verdict.allowed).not.toContain('COMPLETED');

    expect(() => assertRunTransition('RUNNING', 'COMPLETED')).toThrow(StateTransitionError);
  });

  it('an expired approval can never be walked back to APPROVED', () => {
    let thrown: unknown = null;
    try {
      assertPermissionTransition('EXPIRED', 'APPROVED');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(StateTransitionError);
    expect((thrown as StateTransitionError).rejection).toBe('TERMINAL_STATE');
  });

  it('an attachment cannot shortcut to READY without the pipeline', () => {
    let thrown: unknown = null;
    try {
      assertAttachmentTransition('SELECTED', 'READY');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(StateTransitionError);
    expect((thrown as StateTransitionError).rejection).toBe('NOT_ALLOWED');
  });
});

/* ========================================================================== */
/*  A stale usage event from the wrong session is rejected, not merged         */
/* ========================================================================== */

describe('a usage event from the wrong session', () => {
  it('is rejected with SESSION_MISMATCH and never merged into the bound scope', () => {
    const aggregator = new UsageAggregator({ now: () => Date.UTC(2026, 6, 24, 12, 0, 0) });

    // First event binds run-1 to session A and contributes 100 input tokens.
    const first = aggregator.ingest(usageEvent('u-1', 'sess-A', 100));
    expect(first.accepted).toBe(true);
    expect(first.rejections).toHaveLength(0);
    expect(aggregator.getSnapshot('run', 'run-1')?.inputTokens.value).toBe(100);

    // A second event for the SAME run arrives carrying a DIFFERENT session id.
    const second = aggregator.ingest(usageEvent('u-2', 'sess-B', 5_000));

    const runRejection = second.rejections.find((r) => r.scope === 'run');
    expect(runRejection).toBeDefined();
    expect(runRejection?.reason).toBe('SESSION_MISMATCH');
    expect(runRejection?.scopeSessionId).toBe('sess-A');
    expect(runRejection?.eventSessionId).toBe('sess-B');

    // The run total is untouched: the foreign reading was not merged.
    expect(aggregator.getSnapshot('run', 'run-1')?.inputTokens.value).toBe(100);
    // Session B, a genuinely different session, gets its own scope — not the run's.
    expect(aggregator.getSnapshot('session', 'sess-B')?.inputTokens.value).toBe(5_000);
  });

  it('a usage event with no session id at all is rejected as unattributable', () => {
    const aggregator = new UsageAggregator({ now: () => Date.UTC(2026, 6, 24, 12, 0, 0) });
    const orphan: ForgeEvent = { ...usageEvent('u-orphan', 'sess-A', 10), sessionId: null };
    const result = aggregator.ingest(orphan);
    expect(result.accepted).toBe(false);
    expect(result.rejections[0]?.reason).toBe('MISSING_SESSION_ID');
  });
});
