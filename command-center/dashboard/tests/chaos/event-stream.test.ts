/**
 * Chaos — the event stream (mission section H).
 *
 * These run against the REAL store (`src/bridge/storage/store.ts`) writing to a
 * real file system, in a fresh `mkdtemp` directory per test. Nothing here ever
 * touches the repository's own `.forge-workspace` or any user project: every
 * `ForgeStore.open` call is given an explicit `dataDir` under the OS temp dir,
 * and `resolveDataDir` prefers an explicit `dataDir` over `FORGE_WORKSPACE_DIR`
 * and over the repo default, so an environment variable cannot redirect these
 * writes into anything real.
 *
 * What is being attacked, and what "survives" has to mean:
 *
 *   duplicates      the same eventId twice must be stored ONCE and must have no
 *                   second effect — no extra line, no advanced sequence, and the
 *                   payload that comes back is the one already on disk, not the
 *                   retry's.
 *   out of order    lines written to the log in the wrong order must replay in
 *                   sequence order, and the next append must continue from the
 *                   HIGHEST sequence seen, not from the last line in the file.
 *   a missing seq   must be reported as a gap and recorded as a DEGRADED event.
 *                   A hole in the log is not allowed to become a clean timeline.
 *   a burst         several thousand appends must lose nothing and must keep the
 *                   sequence strictly monotonic, on disk and after a reopen.
 *   malformed       must be refused with a reason that names the field, and the
 *                   stream must still work afterwards. Damage already on disk is
 *                   skipped for replay, reported, and LEFT THERE — evidence is
 *                   never deleted to make a reader look healthy.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { ForgeStore, StoreValidationError } from '../../src/bridge/storage/store.ts';
import type { StoreOptions } from '../../src/bridge/storage/store.ts';
import { EVENT_SCHEMA_VERSION } from '../../src/bridge/storage/schema.ts';
import type { EventType, ForgeEvent } from '../../src/shared/protocol.ts';

/* ------------------------------------------------------------------ fixtures */

let scratchDirs: string[] = [];
let openStores: ForgeStore[] = [];

function workspace(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `forge-chaos-${label}-`));
  // A guard, not decoration: if this ever resolved somewhere real the whole
  // suite would be writing into a live workspace.
  if (!resolve(dir).startsWith(resolve(tmpdir()))) {
    throw new Error(`refusing to run: the scratch workspace ${dir} is not under the OS temp directory`);
  }
  scratchDirs.push(dir);
  return dir;
}

function openAt(dir: string, bridgeInstanceId: string, extra: StoreOptions = {}): ForgeStore {
  const store = ForgeStore.open({ dataDir: dir, bridgeInstanceId, ...extra });
  openStores.push(store);
  return store;
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

function sequencesOnDisk(dir: string, streamKey: string): number[] {
  return streamLines(dir, streamKey).map((line) => (JSON.parse(line) as ForgeEvent).sequence);
}

/** A raw JSONL line, written behind the store's back to simulate a damaged log. */
function rawLine(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    eventId: `raw-${String(overrides.sequence ?? 0)}`,
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

/** Create the workspace layout without leaving a lock behind. */
function seedLayout(dir: string): void {
  const seed = ForgeStore.open({ dataDir: dir, bridgeInstanceId: 'layout-seed' });
  seed.close();
}

function degradedReasons(store: ForgeStore): string[] {
  return store
    .readEvents({ projectId: '__bridge__', runId: null, types: ['bridge.degraded'], limit: 500 })
    .events.map((event) => (event.payload as { reason: string }).reason);
}

/* ========================================================================== */
/*  Isolation                                                                  */
/* ========================================================================== */

describe('isolation', () => {
  it('every workspace under test is a throwaway temp directory, never the real one', () => {
    const dir = workspace('isolation');
    const store = openAt(dir, 'iso-1');
    expect(store.dataDir).toBe(resolve(dir));
    expect(resolve(store.dataDir).startsWith(resolve(tmpdir()))).toBe(true);
    expect(store.dataDir).not.toContain('Forge dashboard');
  });
});

/* ========================================================================== */
/*  Duplicate events                                                           */
/* ========================================================================== */

describe('duplicate events', () => {
  it('stores the same eventId once and returns the event already on disk', () => {
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
    expect(first.event.sequence).toBe(1);
    expect(second.deduplicated).toBe(true);
    expect(second.event.sequence).toBe(1);
    expect(second.event.eventId).toBe(first.event.eventId);
    // The retry's payload is discarded: the stored event wins, not the newer call.
    expect((second.event.payload as { attempt: number }).attempt).toBe(1);

    expect(streamLines(dir, 'projd~rund')).toHaveLength(1);
    expect(store.detectGaps('projd~rund')).toHaveLength(0);
  });

  it('a burst of fifty retries of one event adds one line and never advances the sequence', () => {
    const dir = workspace('dup-burst');
    const store = openAt(dir, 'dup-2');

    const results = [];
    for (let i = 0; i < 50; i += 1) {
      results.push(
        store.appendEvent({
          eventId: 'evt-retried',
          projectId: 'projd',
          runId: 'rund',
          source: 'claude-code',
          type: 'claude.message',
          payload: { retry: i },
        }),
      );
    }

    expect(results.filter((r) => !r.deduplicated)).toHaveLength(1);
    expect(results.filter((r) => r.deduplicated)).toHaveLength(49);
    expect(new Set(results.map((r) => r.event.sequence))).toEqual(new Set([1]));
    expect(streamLines(dir, 'projd~rund')).toHaveLength(1);

    // The stream is still usable after the storm.
    const next = store.appendEvent({
      projectId: 'projd',
      runId: 'rund',
      source: 'bridge',
      type: 'run.state',
      payload: {},
    });
    expect(next.event.sequence).toBe(2);
  });

  it('deduplication survives a restart, because the id index is rebuilt from disk', () => {
    const dir = workspace('dup-restart');
    const first = openAt(dir, 'dup-a');
    first.appendEvent({
      eventId: 'evt-persisted',
      projectId: 'projd',
      runId: 'rund',
      source: 'bridge',
      type: 'run.created',
      payload: { attempt: 1 },
    });
    first.close();

    const second = openAt(dir, 'dup-b');
    const replay = second.appendEvent({
      eventId: 'evt-persisted',
      projectId: 'projd',
      runId: 'rund',
      source: 'bridge',
      type: 'run.created',
      payload: { attempt: 2 },
    });

    expect(replay.deduplicated).toBe(true);
    expect((replay.event.payload as { attempt: number }).attempt).toBe(1);
    expect(streamLines(dir, 'projd~rund')).toHaveLength(1);
  });
});

/* ========================================================================== */
/*  Out-of-order sequences                                                     */
/* ========================================================================== */

describe('out-of-order sequences', () => {
  it('replays a log whose lines were written out of order in sequence order', () => {
    const dir = workspace('order');
    seedLayout(dir);
    writeFileSync(
      streamPath(dir, 'projx~runx'),
      `${[
        rawLine({ sequence: 3, eventId: 'ooo-3' }),
        rawLine({ sequence: 1, eventId: 'ooo-1' }),
        rawLine({ sequence: 2, eventId: 'ooo-2' }),
      ].join('\n')}\n`,
    );

    const store = openAt(dir, 'order-1');
    const page = store.readEvents({ projectId: 'projx', runId: 'runx' });

    expect(sequencesOnDisk(dir, 'projx~runx')).toEqual([3, 1, 2]);
    expect(page.events.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(page.gaps[0].gaps).toHaveLength(0);
    expect(page.gaps[0].maxSequence).toBe(3);
    expect(page.issues).toHaveLength(0);
  });

  it('appends after out-of-order lines continue from the highest sequence, not the last line', () => {
    const dir = workspace('order-append');
    seedLayout(dir);
    writeFileSync(
      streamPath(dir, 'projx~runx'),
      `${[
        rawLine({ sequence: 5, eventId: 'ooo-5' }),
        rawLine({ sequence: 4, eventId: 'ooo-4' }),
      ].join('\n')}\n`,
    );

    const store = openAt(dir, 'order-2');
    const appended = store.appendEvent({
      projectId: 'projx',
      runId: 'runx',
      source: 'bridge',
      type: 'run.state',
      payload: {},
    });

    // The last LINE is sequence 4. The next sequence must still be 6.
    expect(appended.event.sequence).toBe(6);
    // 1..3 were never on disk, so the store must report them as a gap rather
    // than quietly numbering around the hole.
    expect(store.detectGaps('projx~runx')).toEqual([{ from: 1, to: 3, count: 3 }]);
  });

  it('a repeated sequence number is recorded as damage instead of being merged away', () => {
    const dir = workspace('order-dupseq');
    seedLayout(dir);
    writeFileSync(
      streamPath(dir, 'projx~runx'),
      `${[
        rawLine({ sequence: 1, eventId: 'ds-1' }),
        rawLine({ sequence: 2, eventId: 'ds-2' }),
        rawLine({ sequence: 2, eventId: 'ds-2b' }),
      ].join('\n')}\n`,
    );

    const store = openAt(dir, 'order-3');
    expect(store.degradedNotes().map((n) => n.reason)).toContain('events.duplicate-sequence');
    expect(degradedReasons(store)).toContain('events.duplicate-sequence');
    // Neither copy was deleted; both are still readable evidence.
    expect(streamLines(dir, 'projx~runx')).toHaveLength(3);
  });
});

/* ========================================================================== */
/*  A missing sequence                                                         */
/* ========================================================================== */

describe('a missing sequence', () => {
  it('is detected as a gap range and never smoothed over', () => {
    const dir = workspace('gap');
    seedLayout(dir);
    writeFileSync(
      streamPath(dir, 'projx~runx'),
      `${[1, 2, 5, 6, 9]
        .map((sequence) => rawLine({ sequence, eventId: `gap-${sequence}` }))
        .join('\n')}\n`,
    );

    const store = openAt(dir, 'gap-1');
    expect(store.detectGaps('projx~runx')).toEqual([
      { from: 3, to: 4, count: 2 },
      { from: 7, to: 8, count: 2 },
    ]);

    const page = store.readEvents({ projectId: 'projx', runId: 'runx' });
    expect(page.events).toHaveLength(5);
    expect(page.gaps[0].gaps).toHaveLength(2);
    expect(page.gaps[0].eventCount).toBe(5);
    expect(page.gaps[0].maxSequence).toBe(9);
  });

  it('reports DEGRADED for the gap, with the ranges named in the event', () => {
    const dir = workspace('gap-degraded');
    seedLayout(dir);
    writeFileSync(
      streamPath(dir, 'projx~runx'),
      `${[1, 2, 5].map((sequence) => rawLine({ sequence, eventId: `gd-${sequence}` })).join('\n')}\n`,
    );

    const store = openAt(dir, 'gap-2');
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
    // Status is carried explicitly — DEGRADED is asserted, not inferred by a reader.
    expect(gapEvent?.status).toBe('DEGRADED');
    expect((gapEvent?.payload as { detail: string }).detail).toContain('3..4');
    expect((gapEvent?.payload as { detail: string }).detail).toContain('incomplete');
  });

  it('does not multiply the degraded event when the same hole is found again', () => {
    const dir = workspace('gap-idempotent');
    seedLayout(dir);
    writeFileSync(
      streamPath(dir, 'projx~runx'),
      `${[1, 4].map((sequence) => rawLine({ sequence, eventId: `gi-${sequence}` })).join('\n')}\n`,
    );

    const first = openAt(dir, 'gap-3a');
    first.reconcileOnStartup();
    first.close();

    const second = openAt(dir, 'gap-3b');
    second.reconcileOnStartup();

    const gapNotes = degradedReasons(second).filter((reason) => reason === 'events.sequence-gap');
    expect(gapNotes).toHaveLength(1);
  });
});

/* ========================================================================== */
/*  A burst of several thousand events                                         */
/* ========================================================================== */

describe('a burst of several thousand events', () => {
  const BURST = 3_000;

  it(
    'loses nothing and keeps the sequence strictly monotonic, on disk and after a reopen',
    () => {
      const dir = workspace('burst');
      const store = openAt(dir, 'burst-1');

      const assigned: number[] = [];
      for (let i = 0; i < BURST; i += 1) {
        const result = store.appendEvent({
          projectId: 'projb',
          runId: 'runb',
          source: 'claude-code',
          type: 'run.output.delta',
          payload: { i, text: 'chunk' },
        });
        expect(result.deduplicated).toBe(false);
        assigned.push(result.event.sequence);
      }

      // The store handed out 1..BURST with nothing repeated and nothing skipped.
      expect(assigned).toHaveLength(BURST);
      expect(assigned[0]).toBe(1);
      expect(assigned[BURST - 1]).toBe(BURST);
      expect(new Set(assigned).size).toBe(BURST);
      expect(assigned.every((seq, index) => index === 0 || seq === assigned[index - 1] + 1)).toBe(true);

      // The disk agrees, line for line.
      const onDisk = sequencesOnDisk(dir, 'projb~runb');
      expect(onDisk).toHaveLength(BURST);
      expect(onDisk.every((seq, index) => index === 0 || seq > onDisk[index - 1])).toBe(true);
      expect(store.detectGaps('projb~runb')).toHaveLength(0);
      store.close();

      // And a fresh instance rebuilding its index from that file agrees too.
      const reopened = openAt(dir, 'burst-2');
      const page = reopened.readEvents({ projectId: 'projb', runId: 'runb', limit: BURST + 10 });
      expect(page.events).toHaveLength(BURST);
      expect(page.hasMore).toBe(false);
      expect(page.issues).toHaveLength(0);
      expect(page.gaps[0].eventCount).toBe(BURST);
      expect(page.gaps[0].gaps).toHaveLength(0);
      expect(page.events.every((event, index) => event.sequence === index + 1)).toBe(true);
      expect(page.events.every((event) => (event.payload as { text: string }).text === 'chunk')).toBe(true);
      expect(reopened.degradedNotes().filter((n) => n.reason.startsWith('jsonl.'))).toHaveLength(0);
    },
    120_000,
  );

  it('keeps three interleaved streams independent, each with its own monotonic sequence', () => {
    const dir = workspace('burst-multi');
    const store = openAt(dir, 'burst-3');
    const runs = ['runp', 'runq', 'runr'];

    for (let i = 0; i < 300; i += 1) {
      for (const runId of runs) {
        store.appendEvent({
          projectId: 'projb',
          runId,
          source: 'bridge',
          type: 'run.output.delta',
          payload: { i },
        });
      }
    }

    for (const runId of runs) {
      expect(sequencesOnDisk(dir, `projb~${runId}`)).toEqual(Array.from({ length: 300 }, (_, i) => i + 1));
      expect(store.detectGaps(`projb~${runId}`)).toHaveLength(0);
    }
  });
});

/* ========================================================================== */
/*  Malformed events                                                           */
/* ========================================================================== */

describe('a malformed event', () => {
  it('is rejected with a reason that names the offending field, and the stream survives', () => {
    const dir = workspace('malformed');
    const store = openAt(dir, 'mal-1');

    store.appendEvent({
      projectId: 'projm',
      runId: 'runm',
      source: 'bridge',
      type: 'run.created',
      payload: { i: 1 },
    });
    const bytesBefore = readFileSync(streamPath(dir, 'projm~runm'), 'utf8');

    let thrown: unknown = null;
    try {
      store.appendEvent({
        projectId: 'projm',
        runId: 'runm',
        source: 'bridge',
        // Not in EVENT_TYPES. An invented vocabulary is how a lie enters a log.
        type: 'run.definitely.succeeded' as EventType,
        payload: {},
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(StoreValidationError);
    const issues = (thrown as StoreValidationError).issues;
    expect(issues.some((issue) => issue.field === 'type')).toBe(true);
    expect(issues.map((issue) => issue.detail).join(' ')).toContain('unknown event type');

    // Nothing reached disk and the sequence did not move.
    expect(readFileSync(streamPath(dir, 'projm~runm'), 'utf8')).toBe(bytesBefore);
    const next = store.appendEvent({
      projectId: 'projm',
      runId: 'runm',
      source: 'bridge',
      type: 'run.state',
      payload: { i: 2 },
    });
    expect(next.event.sequence).toBe(2);
    expect(streamLines(dir, 'projm~runm')).toHaveLength(2);
  });

  it('refuses an event whose status is not an OperationalStatus', () => {
    const dir = workspace('malformed-status');
    const store = openAt(dir, 'mal-2');

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

  it('skips an unparseable line already on disk, reports it, and leaves it there', () => {
    const dir = workspace('malformed-line');
    seedLayout(dir);
    writeFileSync(
      streamPath(dir, 'projx~runx'),
      `${rawLine({ sequence: 1, eventId: 'ml-1' })}\nNOT JSON AT ALL {\n${rawLine({ sequence: 2, eventId: 'ml-2' })}\n`,
    );

    const store = openAt(dir, 'mal-3');
    const page = store.readEvents({ projectId: 'projx', runId: 'runx' });

    expect(page.events.map((e) => e.sequence)).toEqual([1, 2]);
    expect(page.issues.map((i) => i.reason)).toContain('jsonl.corrupt-line');
    expect(store.degradedNotes().map((n) => n.reason)).toContain('jsonl.corrupt-line');
    expect(degradedReasons(store)).toContain('jsonl.corrupt-line');

    // The damaged bytes are still on disk. The log is evidence, not a cache.
    expect(readFileSync(streamPath(dir, 'projx~runx'), 'utf8')).toContain('NOT JSON AT ALL');

    // The stream still works: the append gets the next sequence AND is readable
    // back off disk. (This log ends with a newline, so the new line lands on its
    // own. See the KNOWN DEFECT in tests/chaos/storage.test.ts for what happens
    // when the log does not end with a newline.)
    expect(
      store.appendEvent({ projectId: 'projx', runId: 'runx', source: 'bridge', type: 'run.state', payload: {} }).event
        .sequence,
    ).toBe(3);
    expect(store.readEvents({ projectId: 'projx', runId: 'runx' }).events.map((e) => e.sequence)).toEqual([1, 2, 3]);
  });

  it('skips a line that parses but does not satisfy the contract, with a recorded reason', () => {
    const dir = workspace('malformed-contract');
    seedLayout(dir);
    writeFileSync(
      streamPath(dir, 'projx~runx'),
      `${rawLine({ sequence: 1, eventId: 'mc-1' })}\n${rawLine({
        sequence: 2,
        eventId: 'mc-2',
        type: 'run.totally.finished',
      })}\n${rawLine({ sequence: 3, eventId: 'mc-3' })}\n`,
    );

    const store = openAt(dir, 'mal-4');
    const notes = store.degradedNotes().filter((n) => n.reason === 'events.invalid-line');

    expect(notes).toHaveLength(1);
    expect(notes[0].detail).toContain('line 2');
    expect(notes[0].detail).toContain('unknown event type');
    expect(notes[0].evidenceRefs[0].ref).toContain('#L2');
    expect(degradedReasons(store)).toContain('events.invalid-line');

    // The invalid line is skipped for replay and its sequence therefore shows up
    // as a hole — the store reports both facts rather than picking the flattering one.
    const page = store.readEvents({ projectId: 'projx', runId: 'runx' });
    expect(page.events.map((e) => e.sequence)).toEqual([1, 3]);
    expect(store.detectGaps('projx~runx')).toEqual([{ from: 2, to: 2, count: 1 }]);
    expect(readFileSync(streamPath(dir, 'projx~runx'), 'utf8')).toContain('run.totally.finished');
  });

  it('survives a mixture of every damage class at once', () => {
    const dir = workspace('malformed-mixed');
    seedLayout(dir);
    writeFileSync(
      streamPath(dir, 'projx~runx'),
      [
        rawLine({ sequence: 1, eventId: 'mx-1' }),
        '[1,2,3]',
        rawLine({ sequence: 2, eventId: 'mx-2', type: 'not.a.real.event' }),
        rawLine({ sequence: 4, eventId: 'mx-4' }),
        '{"eventId":"mx-half","schemaVersion":1,"sequ',
      ].join('\n'),
    );

    const store = openAt(dir, 'mal-5');
    const reasons = new Set(store.degradedNotes().map((n) => n.reason));

    expect(reasons.has('jsonl.corrupt-line')).toBe(true); // the JSON array line
    expect(reasons.has('events.invalid-line')).toBe(true); // the unknown event type
    expect(reasons.has('jsonl.truncated-tail')).toBe(true); // the half-written tail

    const page = store.readEvents({ projectId: 'projx', runId: 'runx' });
    expect(page.events.map((e) => e.sequence)).toEqual([1, 4]);
    expect(store.detectGaps('projx~runx')).toEqual([{ from: 2, to: 3, count: 2 }]);

    // Four damage classes in one file and the reader still produced a usable,
    // honestly-labelled result instead of throwing or claiming the log is fine.
    expect(store.stats().degradedNotes).toBeGreaterThanOrEqual(3);
  });

  it('refuses a projectId that could escape the events directory', () => {
    const dir = workspace('malformed-path');
    const store = openAt(dir, 'mal-6');
    expect(() =>
      store.appendEvent({ projectId: '../escape', source: 'bridge', type: 'bridge.ready', payload: {} }),
    ).toThrow(/projectId/);
  });
});

/* ========================================================================== */
/*  A truncated tail is not the end of the stream                              */
/* ========================================================================== */

describe('the stream after a crash', () => {
  it('still replays every complete event once a half-written line is on disk', () => {
    const dir = workspace('crash-tail');
    const seed = openAt(dir, 'crash-a');
    seed.appendEvent({ projectId: 'projc', runId: 'runc', source: 'bridge', type: 'run.created', payload: { i: 1 } });
    seed.appendEvent({ projectId: 'projc', runId: 'runc', source: 'bridge', type: 'run.state', payload: { i: 2 } });
    seed.close();
    appendFileSync(streamPath(dir, 'projc~runc'), '{"eventId":"half","schemaVersion":1,"sequ');

    const store = openAt(dir, 'crash-b');
    const page = store.readEvents({ projectId: 'projc', runId: 'runc' });

    expect(page.events.map((e) => e.sequence)).toEqual([1, 2]);
    expect(page.events.map((e) => (e.payload as { i: number }).i)).toEqual([1, 2]);
    expect(page.issues.map((i) => i.reason)).toContain('jsonl.truncated-tail');
    expect(store.detectGaps('projc~runc')).toHaveLength(0);
    // Whether the NEXT append survives is a separate question, and the answer is
    // currently "no": see the KNOWN DEFECT case in tests/chaos/storage.test.ts.
  });
});
