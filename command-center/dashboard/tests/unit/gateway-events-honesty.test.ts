/**
 * cc-fix-events-honesty (forge-2026-07-29-cc-finish, WP fix-events-honesty) — pure-function tests
 * for the five honesty gaps this WP closes in `gateway-adapter.ts`: P1-1 (truncated/malformed_lines
 * carried through, not discarded), P1-3 (the real `after`/`next_after` incremental protocol
 * actually used, not silently re-downloaded in full every poll), P1-6 (`duration_source` qualifies
 * an estimate instead of being parsed and thrown away), P2-9 (a raw ISO timestamp formatted into a
 * short relative label instead of landing verbatim in a box built for one), P3-13 (a real per-task
 * `failed` verdict wins over `hasFinalReport`, not the other way round).
 *
 * No network, no React, no timers — mirrors `gateway-adapter-antifabrication.test.ts`'s and
 * `coalesced-runner.test.ts`'s own precedent for this seam: exported pure functions get direct
 * hermetic tests.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  buildGatewayRuns,
  createEventsAccumulator,
  foldGatewayEventsResponse,
  formatDurationWithSource,
  formatRelativeTime,
  type GatewayEventsState,
  type MissionPayload,
} from '@/prototype/state/gateway-adapter';
// `parseMissionPayload` is the parsing boundary itself and is not part of `gateway-adapter.ts`'s
// re-export façade (its only production caller, `polling-hooks.ts`, also imports it from here), so
// the Z1 passthrough tests at the bottom of this file address it directly rather than widening that
// façade for a test.
import { parseMissionPayload } from '@/prototype/state/adapter/rows';

/* ============================================================== P1-1 / P1-3 */

const EMPTY: GatewayEventsState = { events: [], truncated: false, malformedLines: 0 };

describe('foldGatewayEventsResponse — P1-1 (truncated/malformed carried, not discarded) + P1-3 (accumulate, not replace)', () => {
  it('a full read REPLACES the accumulated events', () => {
    const previous: GatewayEventsState = { events: [{ id: 'e0' }], truncated: false, malformedLines: 0 };
    const next = foldGatewayEventsResponse(previous, { events: [{ id: 'e1' }, { id: 'e2' }] }, true);
    expect(next.events).toEqual([{ id: 'e1' }, { id: 'e2' }]);
  });

  it('an incremental read APPENDS onto the accumulated events', () => {
    const previous: GatewayEventsState = { events: [{ id: 'e1' }], truncated: false, malformedLines: 0 };
    const next = foldGatewayEventsResponse(previous, { events: [{ id: 'e2' }] }, false);
    expect(next.events).toEqual([{ id: 'e1' }, { id: 'e2' }]);
  });

  it('truncated is sticky-OR\'d — once true, a later untruncated response cannot clear it', () => {
    const truncatedOnce = foldGatewayEventsResponse(EMPTY, { events: [], truncated: true }, true);
    expect(truncatedOnce.truncated).toBe(true);
    const stillTruncated = foldGatewayEventsResponse(truncatedOnce, { events: [], truncated: false }, false);
    expect(stillTruncated.truncated).toBe(true);
  });

  it('malformed_lines ACCUMULATES across reads — each response only reports its own slice', () => {
    const first = foldGatewayEventsResponse(EMPTY, { events: [], malformed_lines: 2 }, true);
    expect(first.malformedLines).toBe(2);
    const second = foldGatewayEventsResponse(first, { events: [], malformed_lines: 1 }, false);
    expect(second.malformedLines).toBe(3);
  });

  it('a missing events array on the response is honestly empty, never a fabricated row', () => {
    const result = foldGatewayEventsResponse(EMPTY, {}, true);
    expect(result.events).toEqual([]);
    expect(result.malformedLines).toBe(0);
    expect(result.truncated).toBe(false);
  });
});

describe('createEventsAccumulator — the incremental after/next_after cursor `useGatewayEvents` wraps', () => {
  it('the first query is a full read (no ?after=)', () => {
    const acc = createEventsAccumulator();
    expect(acc.nextQuery('project=p&run=r1')).toBe('project=p&run=r1');
  });

  it('two consecutive ingests: the SECOND query carries after=<first next_after>, and the accumulated list equals the full list', () => {
    const acc = createEventsAccumulator();
    const base = 'project=p&run=r1';

    // First refresh — full read.
    expect(acc.nextQuery(base)).toBe(base);
    const afterFirst = acc.ingest({ events: [{ id: 'e1' }, { id: 'e2' }], next_after: 2, malformed_lines: 0, truncated: false });
    expect(afterFirst.events).toEqual([{ id: 'e1' }, { id: 'e2' }]);

    // Second refresh — MUST now request after=2, the exact next_after the first response returned.
    expect(acc.nextQuery(base)).toBe(`${base}&after=2`);
    const afterSecond = acc.ingest({ events: [{ id: 'e3' }], next_after: 3, malformed_lines: 0, truncated: false });

    // The accumulated list is identical to what a single full read of everything would have been.
    expect(afterSecond.events).toEqual([{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }]);
    expect(acc.current()).toEqual(afterSecond);
  });

  it('truncation newly observed on an INCREMENTAL read forces exactly one full-read resync on the next call', () => {
    const acc = createEventsAccumulator();
    const base = 'project=p&run=r1';

    acc.ingest({ events: [{ id: 'e1' }], next_after: 1, truncated: false }); // full read, not truncated
    expect(acc.nextQuery(base)).toBe(`${base}&after=1`); // normal incremental cursor

    // This incremental read is the FIRST to report truncated:true.
    acc.ingest({ events: [{ id: 'e2' }], next_after: 2, truncated: true });

    // The NEXT query must be a full (after-less) resync, not a continued increment.
    expect(acc.nextQuery(base)).toBe(base);

    // Once resynced, truncated stays sticky but the cursor advances normally again.
    acc.ingest({ events: [{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }], next_after: 3, truncated: true });
    expect(acc.nextQuery(base)).toBe(`${base}&after=3`);
  });

  it('truncated already true on the very FIRST (full) read does not force a redundant second full read', () => {
    const acc = createEventsAccumulator();
    const base = 'project=p&run=r1';
    acc.ingest({ events: [{ id: 'e1' }], next_after: 1, truncated: true }); // cold start, already truncated
    // A cold-start truncation is not a "newly observed on an incremental read" transition — the
    // cursor still advances normally so this run's own history stays cheap to keep polling.
    expect(acc.nextQuery(base)).toBe(`${base}&after=1`);
  });
});

/* ========================================================================== P1-6 */

describe('formatDurationWithSource — P1-6: an estimate never renders identically to a real measurement', () => {
  it('null duration stays the honest empty string regardless of source', () => {
    expect(formatDurationWithSource(null, 'derived-from-events')).toBe('');
    expect(formatDurationWithSource(null, null)).toBe('');
  });

  it('a real run-completed-event measurement renders with no qualifier', () => {
    expect(formatDurationWithSource(65000, 'run-completed-event')).toBe('1m 5s');
  });

  it('a derived-from-events estimate is qualified, never presented as a precise measurement', () => {
    expect(formatDurationWithSource(65000, 'derived-from-events')).toBe('1m 5s (from events)');
  });
});

/* ========================================================================== P2-9 */

describe('formatRelativeTime — P2-9: a raw ISO timestamp into a short relative label, or honest absence', () => {
  it('null/empty renders as the empty string, never a fabricated "just now"', () => {
    expect(formatRelativeTime(null)).toBe('');
    expect(formatRelativeTime('')).toBe('');
    expect(formatRelativeTime('   ')).toBe('');
  });

  it('an unparsable string renders as the empty string', () => {
    expect(formatRelativeTime('not-a-timestamp')).toBe('');
  });

  it('a real ISO timestamp renders as a relative label', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T10:00:00.000Z'));
    try {
      expect(formatRelativeTime('2026-07-29T09:59:30.000Z')).toBe('just now'); // 30s ago
      expect(formatRelativeTime('2026-07-29T09:56:00.000Z')).toBe('4 min ago'); // 4m ago
      expect(formatRelativeTime('2026-07-29T08:00:00.000Z')).toBe('2 hr ago'); // 2h ago
      expect(formatRelativeTime('2026-07-27T10:00:00.000Z')).toBe('2 days ago'); // 2d ago
      expect(formatRelativeTime('2026-07-15T10:00:00.000Z')).toBe('2 weeks ago'); // 14d ago
    } finally {
      vi.useRealTimers();
    }
  });

  it('the output shape stays parseable by ProjectsView.tsx/HomeView.tsx\'s own agoMinutes() fallback (digits, a space, then a unit word) — never breaks their existing "Recent" sort', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T10:00:00.000Z'));
    try {
      const label = formatRelativeTime('2026-07-29T09:56:00.000Z');
      expect(/^\d+\s+[a-z]+/i.test(label)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a future timestamp (clock skew) reads as "just now", never a negative age', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T10:00:00.000Z'));
    try {
      expect(formatRelativeTime('2026-07-29T10:05:00.000Z')).toBe('just now');
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ========================================================================== P3-13 */

function failedTask(): MissionPayload['tasks'][number] {
  return {
    role: 'build-boss',
    agent: 'build-boss',
    dispatchId: 't1',
    wpGuess: null,
    wpGuessConfidence: null,
    task: 'implement the fix',
    startedAt: '2026-07-29T09:00:00.000Z',
    completedAt: '2026-07-29T09:05:00.000Z',
    status: 'failed',
    notes: [],
    pairingAmbiguous: false,
    pairingAmbiguityReason: null,
    declinedCompletions: null,
    unmatchedReason: null,
  };
}

describe('buildGatewayRuns / deriveRunStatus — P3-13: a real failed task wins over hasFinalReport', () => {
  it('a run with BOTH a final report AND a failed task must report failed, not completed', () => {
    const runRows = [
      { runId: 'run-1', hasFinalReport: true, eventCount: 3, mtime: '2026-07-29T09:10:00.000Z', durationMs: null, durationSource: null, eventScanError: null },
    ];
    const mission: MissionPayload = {
      runId: 'run-1',
      wps: [],
      tasks: [failedTask()],
      orphanCompletions: [],
      verdicts: [],
    };
    const runs = buildGatewayRuns(runRows, 'proj-1', 'run-1', mission, ['build-boss'], 'Ship the fix');
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('failed');
  });

  it('a run with a final report and NO failed task still reports completed (unchanged behavior)', () => {
    const runRows = [
      { runId: 'run-1', hasFinalReport: true, eventCount: 3, mtime: '2026-07-29T09:10:00.000Z', durationMs: null, durationSource: null, eventScanError: null },
    ];
    const mission: MissionPayload = {
      runId: 'run-1',
      wps: [],
      tasks: [{ ...failedTask(), status: 'completed' }],
      orphanCompletions: [],
      verdicts: [],
    };
    const runs = buildGatewayRuns(runRows, 'proj-1', 'run-1', mission, ['build-boss'], 'Ship the fix');
    expect(runs[0].status).toBe('completed');
  });

  it('a running task still wins over both a failed task and hasFinalReport (unchanged behavior)', () => {
    const runRows = [
      { runId: 'run-1', hasFinalReport: true, eventCount: 3, mtime: '2026-07-29T09:10:00.000Z', durationMs: null, durationSource: null, eventScanError: null },
    ];
    const mission: MissionPayload = {
      runId: 'run-1',
      wps: [],
      tasks: [{ ...failedTask(), status: 'running' }, { ...failedTask(), dispatchId: 't2', status: 'failed' }],
      orphanCompletions: [],
      verdicts: [],
    };
    const runs = buildGatewayRuns(runRows, 'proj-1', 'run-1', mission, ['build-boss'], 'Ship the fix');
    expect(runs[0].status).toBe('running');
  });
});

/* ========================================================================== liveness statuses */

/**
 * The gateway's mission builder can now close a task that no completion event can be assigned to,
 * using two statuses that are deliberately NOT 'completed': `ended_unknown` (the run logged a
 * terminal event, so the task cannot still be running, but nothing says it succeeded) and
 * `stalled` (its agent has been silent past the stale window). These tests pin the two properties
 * the UI depends on: such a task must stop forcing the run to 'running', and must never on its own
 * make the run look 'completed'. No UI change is involved — `toStatusKey` already folds any
 * unrecognized status into the existing neutral `idle` key.
 */
describe('deriveRunStatus — ended_unknown / stalled tasks', () => {
  const runRow = (hasFinalReport: boolean) => [
    { runId: 'run-1', hasFinalReport, eventCount: 3, mtime: '2026-07-29T09:10:00.000Z', durationMs: null, durationSource: null, eventScanError: null },
  ];
  const missionWith = (status: string): MissionPayload => ({
    runId: 'run-1',
    wps: [],
    tasks: [{ ...failedTask(), status, completedAt: null }],
    orphanCompletions: [],
    verdicts: [],
  });

  it.each(['ended_unknown', 'stalled'])('a %s task no longer pins a dead run to running', (status) => {
    const runs = buildGatewayRuns(runRow(false), 'proj-1', 'run-1', missionWith(status), ['build-boss'], 'Ship the fix');
    expect(runs[0].status).not.toBe('running');
    expect(runs[0].status).toBe('idle');
  });

  it.each(['ended_unknown', 'stalled'])('a %s task never fabricates completion on its own', (status) => {
    const runs = buildGatewayRuns(runRow(false), 'proj-1', 'run-1', missionWith(status), ['build-boss'], 'Ship the fix');
    expect(runs[0].status).not.toBe('completed');
  });

  it('a run with a real final report reports completed once its tasks are no longer running', () => {
    const runs = buildGatewayRuns(runRow(true), 'proj-1', 'run-1', missionWith('ended_unknown'), ['build-boss'], 'Ship the fix');
    expect(runs[0].status).toBe('completed');
  });

  it('LIVE SAFETY: one genuinely running task still wins over every other task status', () => {
    const mission: MissionPayload = {
      runId: 'run-1',
      wps: [],
      tasks: [
        { ...failedTask(), dispatchId: 't1', status: 'stalled', completedAt: null },
        { ...failedTask(), dispatchId: 't2', status: 'ended_unknown', completedAt: null },
        { ...failedTask(), dispatchId: 't3', status: 'running', completedAt: null },
      ],
      orphanCompletions: [],
      verdicts: [],
    };
    const runs = buildGatewayRuns(runRow(true), 'proj-1', 'run-1', mission, ['build-boss'], 'Ship the fix');
    expect(runs[0].status).toBe('running');
  });
});

/* ================================================================== Z1 pairing ambiguity */

/**
 * Z1, second half. The gateway now REFUSES to pair a completion when more than one open start
 * shares its (agent, role), and records that refusal on every candidate (`pairing_ambiguous`,
 * `pairing_ambiguity_reason`, `declined_completions`) plus on the orphaned completion itself
 * (`unmatched_reason`). `toMissionTaskRow` used to drop those fields on the floor, so the warning
 * could not reach any consumer — the truth existed but was unreachable. These tests pin that the
 * parsing boundary carries it through. This is a DATA passthrough only: no UI style or copy is
 * involved, and `toStatusKey` is untouched.
 */
describe('parseMissionPayload — the pairing-ambiguity signal survives the parsing boundary', () => {
  const rawTask = (extra: Record<string, unknown>) => ({
    role: 'builder',
    agent: 'Build Boss',
    dispatch_id: 'd1',
    started_at: '2026-07-29T09:00:00.000Z',
    completed_at: null,
    status: 'running',
    notes: [],
    ...extra,
  });

  it('carries pairing_ambiguous, its reason, and the declined count onto the row', () => {
    const payload = parseMissionPayload('run-1', {
      tasks: [
        rawTask({
          pairing_ambiguous: true,
          pairing_ambiguity_reason: '2 open starts share (agent, role) "Build Boss builder"',
          declined_completions: 2,
        }),
      ],
    });
    expect(payload.tasks[0].pairingAmbiguous).toBe(true);
    expect(payload.tasks[0].pairingAmbiguityReason).toBe('2 open starts share (agent, role) "Build Boss builder"');
    expect(payload.tasks[0].declinedCompletions).toBe(2);
  });

  it('an unambiguous task reports false and honest nulls — never an invented warning', () => {
    const payload = parseMissionPayload('run-1', {
      tasks: [rawTask({ pairing_ambiguous: false, status: 'completed' })],
    });
    expect(payload.tasks[0].pairingAmbiguous).toBe(false);
    expect(payload.tasks[0].pairingAmbiguityReason).toBeNull();
    expect(payload.tasks[0].declinedCompletions).toBeNull();
  });

  it('a gateway payload that predates these fields parses safely as not-ambiguous', () => {
    const payload = parseMissionPayload('run-1', { tasks: [rawTask({})] });
    expect(payload.tasks[0].pairingAmbiguous).toBe(false);
    expect(payload.tasks[0].pairingAmbiguityReason).toBeNull();
  });

  it('a refused completion keeps its unmatched_reason in the orphan list', () => {
    const payload = parseMissionPayload('run-1', {
      orphan_completions: [
        {
          role: 'builder',
          agent: 'Build Boss',
          status: 'completed',
          pairing_ambiguous: true,
          unmatched_reason: 'ambiguous: 2 open starts share (agent, role) "Build Boss builder"',
        },
      ],
    });
    expect(payload.orphanCompletions[0].pairingAmbiguous).toBe(true);
    expect(payload.orphanCompletions[0].unmatchedReason).toMatch(/ambiguous/i);
  });
});
