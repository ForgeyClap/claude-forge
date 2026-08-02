/**
 * Guards the mutation run found unprotected.
 *
 * Stryker showed that several checks in the honesty and evidence machinery could
 * be deleted or have a boundary shifted without a single test noticing. Each test
 * here kills a specific surviving mutant: it passes on the real code AND would
 * fail if the guard it targets were removed. The comment on each block names the
 * exact mutant from docs/mutation-report.md.
 */

import { describe, expect, it } from 'vitest';
import { usageField } from '@/bridge/usage/aggregator';
import {
  checkRunningEvidence,
  explainRunTransition,
  DEFAULT_HEARTBEAT_STALENESS_MS,
} from '@/shared/state-machines';
import type { RunningEvidence } from '@/shared/state-machines';

/* ---------------------------------------------------------- accuracy guard */

describe('usageField forces UNAVAILABLE when the value is absent (aggregator.ts:189)', () => {
  // Kills: `accuracy: value === null || value === undefined ? 'UNAVAILABLE' : accuracy`
  //   -> `... ? false ? 'UNAVAILABLE' : accuracy`, and the ||→&& / half-negation siblings.
  // The point of the guard: a number we do not have cannot be EXACT.
  it('downgrades a null value to UNAVAILABLE even when EXACT was requested', () => {
    const field = usageField('contextTokens', null, 'tokens', 'src', 'EXACT', 't');
    expect(field.accuracy).toBe('UNAVAILABLE');
    expect(field.value).toBeNull();
  });

  it('downgrades an undefined value to UNAVAILABLE even when DERIVED was requested', () => {
    const field = usageField('contextTokens', undefined as unknown as null, 'tokens', 'src', 'DERIVED', 't');
    expect(field.accuracy).toBe('UNAVAILABLE');
  });

  it('preserves the requested accuracy when the value is genuinely present', () => {
    // The other half of the guard: a real value keeps its label, so the downgrade
    // cannot be a blanket "always UNAVAILABLE".
    expect(usageField('x', 42, 'tokens', 'src', 'EXACT', 't').accuracy).toBe('EXACT');
    expect(usageField('x', 0, 'tokens', 'src', 'EXACT', 't').accuracy).toBe('EXACT'); // zero is a value
  });
});

/* -------------------------------------------------- unknown-state rejection */

describe('explainRunTransition flags a genuinely undeclared state (state-machines.ts:272,282)', () => {
  // Kills: `if (!isDeclared(machine, from))` -> `if (false)` and the same for `to`.
  // Without these, an unknown state string falls through to NOT_ALLOWED and the
  // UNKNOWN_* diagnostic silently stops being trustworthy.
  it('reports UNKNOWN_FROM_STATE for an unknown source state, not NOT_ALLOWED', () => {
    const r = explainRunTransition('BOGUS_STATE', 'RUNNING');
    expect(r.ok).toBe(false);
    expect(r.rejection).toBe('UNKNOWN_FROM_STATE');
  });

  it('reports UNKNOWN_TO_STATE for an unknown target state, not NOT_ALLOWED', () => {
    const r = explainRunTransition('RUNNING', 'BOGUS_STATE');
    expect(r.ok).toBe(false);
    expect(r.rejection).toBe('UNKNOWN_TO_STATE');
  });

  it('still distinguishes a declared-but-disallowed transition', () => {
    // Both states are real; the move is just not allowed. This must NOT be
    // reported as UNKNOWN_* — which proves the guards discriminate.
    const r = explainRunTransition('CREATED', 'COMPLETED');
    expect(r.ok).toBe(false);
    expect(r.rejection).not.toBe('UNKNOWN_FROM_STATE');
    expect(r.rejection).not.toBe('UNKNOWN_TO_STATE');
  });
});

/* --------------------------------------------- per-field running-evidence gate */

/** A running-evidence object that passes the gate — the baseline each case breaks. */
function validRunningEvidence(overrides: Partial<RunningEvidence> = {}): RunningEvidence {
  const observedAt = 1_000_000;
  return {
    runId: 'run-1',
    projectId: 'proj-1',
    startedAt: '2026-07-24T20:00:00.000Z',
    pid: 4242,
    pidAlive: true,
    lastHeartbeatAt: new Date(observedAt).toISOString(),
    observedAt,
    ...overrides,
  } as RunningEvidence;
}

describe('checkRunningEvidence names the specific missing field (state-machines.ts:1416-1447)', () => {
  it('accepts complete, fresh evidence', () => {
    expect(checkRunningEvidence(validRunningEvidence()).ok).toBe(true);
  });

  // Kills each `if (!isText(evidence.<field>)) missing.push('<field>')` -> `if (false)`.
  // Dropping ONE field at a time proves the gate reports that exact field, not
  // merely that something was wrong.
  const singleField: [string, Partial<RunningEvidence>, RegExp][] = [
    ['runId', { runId: '' }, /runId/],
    ['projectId', { projectId: '' }, /projectId/],
    ['startedAt', { startedAt: '' }, /startedAt/],
    ['live process handle', { pid: null, pidAlive: false, forgeTaskId: undefined }, /live process handle|liveness/],
    ['lastHeartbeatAt', { lastHeartbeatAt: 'not-a-date' }, /lastHeartbeatAt/],
  ];

  it.each(singleField)('flags %s when only that field is absent', (_label, override, pattern) => {
    const gate = checkRunningEvidence(validRunningEvidence(override));
    expect(gate.ok).toBe(false);
    expect(gate.missing.some((m) => pattern.test(m)), gate.missing.join(' | ')).toBe(true);
  });

  // Kills the staleness boundary mutant: `age > threshold` -> `age >= threshold`.
  // At age EXACTLY equal to the threshold the heartbeat is still fresh (ok); the
  // >= mutant would wrongly call it stale.
  it('treats a heartbeat exactly at the staleness threshold as fresh', () => {
    const observedAt = 5_000_000;
    const evidence = validRunningEvidence({
      observedAt,
      lastHeartbeatAt: new Date(observedAt - DEFAULT_HEARTBEAT_STALENESS_MS).toISOString(),
    });
    expect(checkRunningEvidence(evidence).ok).toBe(true);
  });

  it('rejects a heartbeat one millisecond past the threshold', () => {
    const observedAt = 5_000_000;
    const evidence = validRunningEvidence({
      observedAt,
      lastHeartbeatAt: new Date(observedAt - DEFAULT_HEARTBEAT_STALENESS_MS - 1).toISOString(),
    });
    const gate = checkRunningEvidence(evidence);
    expect(gate.ok).toBe(false);
    expect(gate.missing.some((m) => /fresh heartbeat/.test(m))).toBe(true);
  });

  // Kills the future-heartbeat boundary mutant: `age < 0` -> `age <= 0`.
  // At age EXACTLY 0 the heartbeat is simultaneous, which is credible (ok); the
  // <= mutant would wrongly call it future-dated.
  it('treats a heartbeat dated exactly at observedAt as credible', () => {
    const observedAt = 5_000_000;
    const evidence = validRunningEvidence({
      observedAt,
      lastHeartbeatAt: new Date(observedAt).toISOString(),
    });
    expect(checkRunningEvidence(evidence).ok).toBe(true);
  });
});
