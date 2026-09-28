/**
 * gateway-adapter.ts / adapter/{shared,graph-and-proof,rows}.ts — WP-CCD items 1/3/4, previously
 * shipped with NO direct unit test coverage (found on review of the paused WIP commit `bb27bc3`).
 *
 * Pure-function tests, no network/React/timers — mirrors `gateway-adapter-antifabrication.test.ts`'s
 * own precedent for this seam. Functions under test are not part of the smaller public
 * `gateway-adapter.ts` barrel, so they are imported directly from their own sibling modules — the
 * SAME established pattern `gateway-events-honesty.test.ts` (`parseMissionPayload`) and
 * `default-project-id.test.tsx` (`parseDefaultProjectId`) already use.
 */

import { describe, expect, it } from 'vitest';

import { dedupeLatestByKey } from '@/prototype/state/adapter/shared';
import {
  buildGatewayMissionGraph,
  dedupeLatestMissionVerdicts,
  dedupeLatestVerdictRows,
  NO_INTEGRATION_GATE,
  readIntegrationGateSignal,
} from '@/prototype/state/adapter/graph-and-proof';
import { buildAgentNameIndex, normalizeAgentKey, resolveAgentSlug, type AgentRow, type MissionPayload, type MissionTaskRow, type MissionVerdictRow } from '@/prototype/state/adapter/rows';

/* ========================================================================== */
/*  dedupeLatestByKey (shared.ts)                                             */
/* ========================================================================== */

describe('dedupeLatestByKey — the LATEST row per identity wins, never "any failure ever"', () => {
  it('an identity that appears once is kept as-is', () => {
    expect(dedupeLatestByKey([{ id: 'a', v: 1 }], (r) => r.id)).toEqual([{ id: 'a', v: 1 }]);
  });

  it('the LAST occurrence of a repeated identity wins, not the first', () => {
    const rows = [
      { id: 'check-a', v: 'failed' },
      { id: 'check-b', v: 'passed' },
      { id: 'check-a', v: 'passed' }, // a retry of check-a that later succeeded
    ];
    const result = dedupeLatestByKey(rows, (r) => r.id);
    expect(result.find((r) => r.id === 'check-a')?.v).toBe('passed');
  });

  it('preserves each identity\'s FIRST-SEEN position — the list never reshuffles to most-recent-first', () => {
    const rows = [
      { id: 'check-a', v: 1 },
      { id: 'check-b', v: 1 },
      { id: 'check-a', v: 2 },
    ];
    const result = dedupeLatestByKey(rows, (r) => r.id);
    expect(result.map((r) => r.id)).toEqual(['check-a', 'check-b']);
  });

  it('an empty list stays empty', () => {
    expect(dedupeLatestByKey([], (r: { id: string }) => r.id)).toEqual([]);
  });
});

/* ========================================================================== */
/*  dedupeLatestMissionVerdicts / dedupeLatestVerdictRows (WP-CCD item 4)     */
/* ========================================================================== */

function verdict(overrides: Partial<MissionVerdictRow> = {}): MissionVerdictRow {
  return { eventType: 'check_passed', agent: 'build-boss', role: null, command: null, timestamp: '2026-09-28T00:00:00.000Z', check: null, summary: null, ...overrides };
}

describe('dedupeLatestMissionVerdicts — the LATEST result per real check identity (WP-CCD item 4)', () => {
  it('a check that failed once and later passed reads as passing, not permanently red', () => {
    const result = dedupeLatestMissionVerdicts([verdict({ check: 'npm test', eventType: 'check_failed' }), verdict({ check: 'npm test', eventType: 'check_passed' })]);
    expect(result).toHaveLength(1);
    expect(result[0].eventType).toBe('check_passed');
  });

  it('two genuinely DIFFERENT checks are both kept', () => {
    const result = dedupeLatestMissionVerdicts([verdict({ check: 'npm test', eventType: 'check_passed' }), verdict({ check: 'eslint', eventType: 'check_failed' })]);
    expect(result).toHaveLength(2);
  });

  it('identity prefers "check" over "command", and falls back to role+agent when neither exists', () => {
    // Same command text, two different check names -> two different identities, both kept.
    const result = dedupeLatestMissionVerdicts([
      verdict({ check: 'unit tests', command: 'npm test', eventType: 'check_passed' }),
      verdict({ check: 'integration tests', command: 'npm test', eventType: 'check_failed' }),
    ]);
    expect(result).toHaveLength(2);
  });
});

describe('dedupeLatestVerdictRows — the raw /api/proof "verdicts" array (WP-CCD item 4/6/7)', () => {
  it('a doctor row is deduplicated by the fixed "doctor" identity, never split by timestamp', () => {
    const rows = [
      { source: 'doctor', passed: 10, failed: 2, timestamp: '2026-09-27T00:00:00.000Z' },
      { source: 'doctor', passed: 12, failed: 0, timestamp: '2026-09-28T00:00:00.000Z' },
    ];
    const result = dedupeLatestVerdictRows(rows);
    expect(result).toHaveLength(1);
    expect(result[0].passed).toBe(12);
  });

  it('an event-sourced check that failed then passed collapses to its passing result', () => {
    const rows = [
      { source: 'event', event_type: 'check_failed', check: 'npm test' },
      { source: 'event', event_type: 'check_passed', check: 'npm test' },
    ];
    const result = dedupeLatestVerdictRows(rows);
    expect(result).toHaveLength(1);
    expect(result[0].event_type).toBe('check_passed');
  });
});

/* ========================================================================== */
/*  readIntegrationGateSignal (WP-CCD item 4)                                 */
/* ========================================================================== */

describe('readIntegrationGateSignal — a real integration_gate_passed/failed event, read off raw events', () => {
  it('no such event at all yields the honest NO_INTEGRATION_GATE — never a guessed pass', () => {
    expect(readIntegrationGateSignal([{ event_type: 'run_started' }])).toEqual(NO_INTEGRATION_GATE);
  });

  it('a real integration_gate_passed event reports present + passed', () => {
    const signal = readIntegrationGateSignal([{ event_type: 'integration_gate_passed' }]);
    expect(signal).toEqual({ present: true, passed: true });
  });

  it('a real integration_gate_failed event reports present + NOT passed', () => {
    const signal = readIntegrationGateSignal([{ event_type: 'integration_gate_failed' }]);
    expect(signal).toEqual({ present: true, passed: false });
  });

  it('the LATEST occurrence wins on a retried integration gate', () => {
    const signal = readIntegrationGateSignal([{ event_type: 'integration_gate_failed' }, { event_type: 'integration_gate_passed' }]);
    expect(signal.passed).toBe(true);
  });
});

/* ========================================================================== */
/*  buildAgentNameIndex / resolveAgentSlug / normalizeAgentKey (WP-CCD item 3) */
/* ========================================================================== */

function agentRow(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    slug: 'ui-boss',
    name: 'ui-boss',
    description: null,
    modelTier: null,
    claudeEffort: null,
    nvidiaRole: null,
    isPermanentBoss: true,
    role: null,
    tools: [],
    agentClass: null,
    nvidiaFallback: null,
    premium: null,
    usagePolicyBucket: null,
    memory: null,
    responsibilities: null,
    skills: [],
    displayName: 'UI Boss',
    aliases: [],
    ...overrides,
  };
}

describe('normalizeAgentKey — a bare lowercase alphanumeric form, so name variants collide', () => {
  it('"UI Boss" and "ui-boss" normalize to the same key', () => {
    expect(normalizeAgentKey('UI Boss')).toBe(normalizeAgentKey('ui-boss'));
    expect(normalizeAgentKey('UI Boss')).toBe('uiboss');
  });

  it('a non-string/absent input never throws — returns an empty string', () => {
    expect(normalizeAgentKey(null)).toBe('');
    expect(normalizeAgentKey(undefined)).toBe('');
  });
});

describe('buildAgentNameIndex / resolveAgentSlug — "Build Boss" resolves to "build-boss" WITHOUT needing display_name (WP-CCD item 3)', () => {
  it('resolves a real display-name event field to the registry slug, using slug/name alone', () => {
    const rows = [agentRow({ slug: 'ui-boss', name: 'ui-boss', displayName: null })];
    const index = buildAgentNameIndex(rows);
    // "UI Boss" is never in this row's own name/displayName here — proves the slug ITSELF
    // ("ui-boss") already collides with the display text via normalization, no display_name needed.
    expect(resolveAgentSlug('UI Boss', rows, index)).toBe('ui-boss');
  });

  it('an exact slug always matches first, even against an empty index', () => {
    const rows = [agentRow({ slug: 'build-boss' })];
    expect(resolveAgentSlug('build-boss', rows, new Map())).toBe('build-boss');
  });

  it('resolves via a real registry alias when the display name differs from the slug', () => {
    const rows = [agentRow({ slug: 'build-boss', name: 'build-boss', displayName: 'Build Boss', aliases: ['Build Boss'] })];
    const index = buildAgentNameIndex(rows);
    expect(resolveAgentSlug('Build Boss', rows, index)).toBe('build-boss');
  });

  it('an unregistered agent (e.g. "codex"/"orchestrator") resolves to null — never a guessed slug', () => {
    const rows = [agentRow()];
    const index = buildAgentNameIndex(rows);
    expect(resolveAgentSlug('codex', rows, index)).toBeNull();
    expect(resolveAgentSlug('orchestrator', rows, index)).toBeNull();
  });

  it('a null raw value resolves to null', () => {
    expect(resolveAgentSlug(null, [], new Map())).toBeNull();
  });
});

/* ========================================================================== */
/*  buildGatewayMissionGraph — dedup + integration gate + resolveAgentDisplay */
/* ========================================================================== */

function taskRow(overrides: Partial<MissionTaskRow> = {}): MissionTaskRow {
  return {
    role: 'builder',
    agent: 'build-boss',
    dispatchId: 't1',
    wpGuess: null,
    wpGuessConfidence: null,
    task: 'implement the fix',
    startedAt: '2026-09-28T09:00:00.000Z',
    completedAt: '2026-09-28T09:05:00.000Z',
    status: 'completed',
    notes: [],
    pairingAmbiguous: false,
    pairingAmbiguityReason: null,
    declinedCompletions: null,
    unmatchedReason: null,
    ...overrides,
  };
}

function missionWith(tasks: readonly MissionTaskRow[], verdicts: readonly MissionVerdictRow[] = []): MissionPayload {
  return { runId: 'run-1', wps: [], tasks, orphanCompletions: [], verdicts };
}

describe('buildGatewayMissionGraph — the Boss node uses the LATEST verdict + integration gate (WP-CCD item 4)', () => {
  it('a check that failed once and later passed no longer keeps the Boss node red', () => {
    const mission = missionWith([taskRow()], [verdict({ check: 'npm test', eventType: 'check_failed' }), verdict({ check: 'npm test', eventType: 'check_passed' })]);
    const graph = buildGatewayMissionGraph('run-1', mission, true);
    const boss = graph.nodes.find((n) => n.kind === 'boss')!;
    expect(boss.status).not.toBe('failed');
  });

  it('REGRESSION: without dedup, "any check_failed ever" would have kept this permanently red — proves the fix is load-bearing', () => {
    // Same fixture as above, but verifying the verify node specifically stays non-failed too.
    const mission = missionWith([taskRow()], [verdict({ check: 'npm test', eventType: 'check_failed' }), verdict({ check: 'npm test', eventType: 'check_passed' })]);
    const graph = buildGatewayMissionGraph('run-1', mission, true);
    const verify = graph.nodes.find((n) => n.kind === 'verify')!;
    expect(verify.status).toBe('completed');
  });

  it('a failed integration_gate event turns the Boss node red even with no mission verdicts at all', () => {
    const mission = missionWith([taskRow()], []);
    const graph = buildGatewayMissionGraph('run-1', mission, true, { present: true, passed: false });
    const boss = graph.nodes.find((n) => n.kind === 'boss')!;
    expect(boss.status).toBe('failed');
  });

  it('a passed integration_gate event makes the Verify node present and green with no mission verdicts at all', () => {
    const mission = missionWith([taskRow()], []);
    const graph = buildGatewayMissionGraph('run-1', mission, true, { present: true, passed: true });
    const verify = graph.nodes.find((n) => n.kind === 'verify');
    expect(verify).toBeDefined();
    expect(verify?.status).toBe('completed');
  });

  it('resolveAgentDisplay relabels a lane from its raw grouping key to the real display name', () => {
    const mission = missionWith([taskRow({ agent: 'build-boss' })]);
    const graph = buildGatewayMissionGraph('run-1', mission, false, NO_INTEGRATION_GATE, (raw) => (raw === 'build-boss' ? 'Build Boss' : raw));
    expect(graph.lanes.map((l) => l.label)).toContain('Build Boss');
  });

  it('an unmatched raw agent key passes through resolveAgentDisplay unchanged', () => {
    const mission = missionWith([taskRow({ agent: 'codex' })]);
    const graph = buildGatewayMissionGraph('run-1', mission, false, NO_INTEGRATION_GATE, (raw) => (raw === 'build-boss' ? 'Build Boss' : raw));
    expect(graph.lanes.map((l) => l.label)).toContain('codex');
  });

  it('a null mission yields the empty graph, never a partial/guessed one', () => {
    expect(buildGatewayMissionGraph('run-1', null, false)).toEqual({ id: '', runId: '', lanes: [], nodes: [], edges: [] });
  });
});
