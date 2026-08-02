/**
 * Z1 pairing ambiguity — the LAST hop.
 *
 * The gateway refuses to pair a completion when more than one still-open start shares its exact
 * (agent, role), and records that refusal as four real fields: `pairing_ambiguous`,
 * `pairing_ambiguity_reason`, `declined_completions` and (on an orphaned completion)
 * `unmatched_reason`. `parseMissionPayload` already carried them onto `MissionTaskRow`
 * (pinned by `gateway-events-honesty.test.ts`), but `toGatewayTask` — the final mapper, whose
 * output `Task` is the object every component actually renders — dropped them on the floor.
 *
 * Measured before the fix, through the real chain:
 *   HOP 1 MissionTaskRow: pairingAmbiguous:true, pairingAmbiguityReason:"...", declinedCompletions:1
 *   HOP 2 Task keys:      [id, title, agentId, workPackageId, phase, column, status, progress, ...]
 *                         — the four fields were NOT in that list.
 *
 * So no consumer could ever see the warning: the truth existed and was unreachable, which is
 * exactly the failure mode this project calls a silent under-report.
 *
 * These tests drive the WHOLE chain at runtime — raw gateway JSON -> parseMissionPayload ->
 * MissionTaskRow -> toGatewayTask -> Task — rather than only type-checking it, because a type
 * alone cannot prove a field survived a mapper that builds its result key by key.
 *
 * This is a DATA passthrough only. No component, no style, no visible text and no status
 * derivation is involved, and the tests below pin that too.
 */

import { describe, expect, it } from 'vitest';

import { parseMissionPayload } from '@/prototype/state/adapter/rows';
import { toGatewayTask } from '@/prototype/state/gateway-adapter';

/** A raw `/api/missions/:run` task row, exactly as the gateway serialises it (snake_case). */
const rawTask = (extra: Record<string, unknown> = {}) => ({
  role: 'builder',
  agent: 'Build Boss',
  dispatch_id: 'd1',
  wp_guess: 'wp3',
  wp_guess_confidence: 'inferred',
  task: 'Ship the fix',
  started_at: '2026-07-29T09:00:00.000Z',
  completed_at: null,
  status: 'running',
  notes: [],
  ...extra,
});

/** The real chain, end to end: gateway JSON -> row -> Task. */
function chain(raw: Record<string, unknown>) {
  const payload = parseMissionPayload('run-1', { tasks: [raw] });
  const row = payload.tasks[0];
  return { row, task: toGatewayTask(row, 0) };
}

describe('Z1 last hop — the pairing-ambiguity signal survives toGatewayTask onto Task', () => {
  it('carries all four fields through the whole chain, values intact', () => {
    const reason = '2 open starts share (agent, role) "Build Boss builder"';
    const { row, task } = chain(
      rawTask({
        pairing_ambiguous: true,
        pairing_ambiguity_reason: reason,
        declined_completions: 1,
      }),
    );

    // HOP 1 — the parsing boundary (already green before this fix).
    expect(row.pairingAmbiguous).toBe(true);
    expect(row.pairingAmbiguityReason).toBe(reason);
    expect(row.declinedCompletions).toBe(1);

    // HOP 2 — the mapper the witness proved was dropping them.
    expect(task.pairingAmbiguous).toBe(true);
    expect(task.pairingAmbiguityReason).toBe(reason);
    expect(task.declinedCompletions).toBe(1);
  });

  it('the four names are really present on the emitted Task object, not merely typed', () => {
    const { task } = chain(
      rawTask({
        pairing_ambiguous: true,
        pairing_ambiguity_reason: 'ambiguous',
        declined_completions: 2,
        unmatched_reason: null,
      }),
    );
    // The exact defect the witness measured: these keys were absent from Object.keys(task).
    const keys = Object.keys(task);
    expect(keys).toContain('pairingAmbiguous');
    expect(keys).toContain('pairingAmbiguityReason');
    expect(keys).toContain('declinedCompletions');
    expect(keys).toContain('unmatchedReason');
  });

  it('an unambiguous task reports an honest false/null — never an invented warning', () => {
    const { task } = chain(rawTask({ pairing_ambiguous: false, status: 'completed' }));
    expect(task.pairingAmbiguous).toBe(false);
    expect(task.pairingAmbiguityReason).toBeNull();
    expect(task.declinedCompletions).toBeNull();
    expect(task.unmatchedReason).toBeNull();
  });

  it('a gateway build that predates the fields still maps to a not-ambiguous Task', () => {
    const { task } = chain(rawTask());
    expect(task.pairingAmbiguous).toBe(false);
    expect(task.pairingAmbiguityReason).toBeNull();
    // `declinedCompletions` stays null, never coerced to 0 — 0 would read as a measured "none".
    expect(task.declinedCompletions).toBeNull();
  });

  it('an orphaned completion keeps its unmatched_reason all the way onto Task', () => {
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
    const task = toGatewayTask(payload.orphanCompletions[0], 0);
    expect(task.pairingAmbiguous).toBe(true);
    expect(task.unmatchedReason).toMatch(/ambiguous/i);
  });

  it('passthrough only — the ambiguity flag changes no status, column, phase or progress', () => {
    const plain = chain(rawTask({ status: 'running' })).task;
    const flagged = chain(
      rawTask({ status: 'running', pairing_ambiguous: true, declined_completions: 3 }),
    ).task;
    expect(flagged.status).toBe(plain.status);
    expect(flagged.column).toBe(plain.column);
    expect(flagged.phase).toBe(plain.phase);
    expect(flagged.progress).toBe(plain.progress);
    // And a completed task is still 100 — the pre-existing signal is untouched.
    expect(chain(rawTask({ status: 'completed', pairing_ambiguous: true })).task.progress).toBe(100);
  });
});
