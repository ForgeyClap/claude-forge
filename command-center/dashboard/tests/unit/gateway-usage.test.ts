/**
 * gateway-usage.ts — pure-function regression gate for the WP that wired
 * `UsageBar`/`UsageDetails` to real gateway data (cc-wire-usage).
 *
 * No network, no React, no timers — mirrors `account-usage.test.ts`'s own
 * precedent for this seam. Proves: every field this bar can truly source
 * reflects the real payload; every field it cannot is an honest, typed
 * absence (never a plausible-looking default); staleness and the
 * gateway-down state are real, evidence-driven booleans.
 */

import { describe, expect, it } from 'vitest';

import {
  AGENT_LABEL_UNAVAILABLE,
  SKILL_LABEL_UNAVAILABLE,
  STALE_AFTER_MS,
  buildEmptyConversationSnapshot,
  buildEmptyGatewayUsageHistory,
  buildGatewayUsageState,
  computeStale,
  formatGuardTooltip,
  resolveGatewayProblem,
  toClientLatencyStat,
  toGatewayUsageRun,
} from '@/prototype/state/gateway-usage';
import type { GatewayAccountUsage, GatewayLatency } from '@/prototype/state/gateway-adapter';
import type { ChatRunView } from '@/prototype/state/chat-send';

/* ========================================================================== */
/*  buildEmptyConversationSnapshot — never a plausible-looking number         */
/* ========================================================================== */

describe('buildEmptyConversationSnapshot — every measured field is an honest, typed absence', () => {
  it('a missing/unknown per-conversation field yields UNAVAILABLE + null, never a default', () => {
    const snapshot = buildEmptyConversationSnapshot('conversation', 'c-1');
    expect(snapshot.scope).toBe('conversation');
    expect(snapshot.scopeId).toBe('c-1');
    for (const field of [
      snapshot.model,
      snapshot.effort,
      snapshot.inputTokens,
      snapshot.outputTokens,
      snapshot.cacheReadTokens,
      snapshot.cacheCreationTokens,
      snapshot.contextTokensUsed,
      snapshot.contextWindow,
      snapshot.contextPercent,
      snapshot.costUsd,
      snapshot.turns,
      snapshot.toolCalls,
      snapshot.agentCount,
      snapshot.skillUses,
      snapshot.errors,
      snapshot.retries,
      snapshot.compactions,
      snapshot.elapsedMs,
      snapshot.eventLatencyP95,
    ]) {
      expect(field.value).toBeNull();
      expect(field.accuracy).toBe('UNAVAILABLE');
    }
    // Not a fabricated 0 or empty string read as "measured zero" — an honest absence.
    expect(snapshot.sessionId).toBeNull();
    expect(snapshot.lastUpdate).toBe('');
    expect(snapshot.stale).toBe(false);
  });

  it('planUsage keeps the one honest sentence — never a remaining-percentage', () => {
    const snapshot = buildEmptyConversationSnapshot('conversation', 'c-1');
    expect(snapshot.planUsage.value).toBeNull();
    expect(snapshot.planUsage.accuracy).toBe('UNAVAILABLE');
    expect(snapshot.planUsage.source).toBe('Plan usage is not exposed by the local Claude Code runtime.');
  });
});

describe('AGENT_LABEL_UNAVAILABLE / SKILL_LABEL_UNAVAILABLE — no per-conversation agent/skill dispatch telemetry', () => {
  it('never invents an agent or skill name', () => {
    expect(AGENT_LABEL_UNAVAILABLE.text).toBe('n/a');
    expect(AGENT_LABEL_UNAVAILABLE.accuracy).toBe('UNAVAILABLE');
    expect(SKILL_LABEL_UNAVAILABLE.text).toBe('n/a');
    expect(SKILL_LABEL_UNAVAILABLE.accuracy).toBe('UNAVAILABLE');
  });
});

/* ========================================================================== */
/*  toGatewayUsageRun — the current run, real from the chat send controller  */
/* ========================================================================== */

describe('toGatewayUsageRun — the one field this WP makes real', () => {
  it('a real active run flows straight through', () => {
    const run: ChatRunView = { runId: 't-123', status: 'RUNNING', active: true };
    expect(toGatewayUsageRun(run)).toEqual({ operationalStatus: 'RUNNING' });
  });

  it('no pending turn yields a real null status, never a guessed "RUNNING"', () => {
    const run: ChatRunView = { runId: null, status: null, active: false };
    expect(toGatewayUsageRun(run)).toEqual({ operationalStatus: null });
  });

  it('no chat controller at all (fixtures) yields null, never a fabricated run', () => {
    expect(toGatewayUsageRun(null)).toBeNull();
  });
});

/* ========================================================================== */
/*  computeStale — real freshness from age_ms, never a guess either way      */
/* ========================================================================== */

describe('computeStale — real age_ms drives STALE, absence never fabricates either answer', () => {
  it('a reading older than the threshold is STALE', () => {
    expect(computeStale(STALE_AFTER_MS + 1, STALE_AFTER_MS)).toBe(true);
  });

  it('a reading within the threshold is not stale', () => {
    expect(computeStale(1000, STALE_AFTER_MS)).toBe(false);
  });

  it('exactly at the threshold is not yet stale (strictly greater-than)', () => {
    expect(computeStale(STALE_AFTER_MS, STALE_AFTER_MS)).toBe(false);
  });

  it('no reading at all (age_ms null) is honestly NOT stale — absence of evidence is not evidence of staleness', () => {
    expect(computeStale(null, STALE_AFTER_MS)).toBe(false);
  });

  it('a non-finite age never crashes and never claims staleness', () => {
    expect(computeStale(Number.NaN, STALE_AFTER_MS)).toBe(false);
  });
});

/* ========================================================================== */
/*  resolveGatewayProblem — gateway-down says so; transient states don't     */
/* ========================================================================== */

describe('resolveGatewayProblem — the bar says so honestly instead of freezing on old numbers', () => {
  it('DISCONNECTED surfaces the real connection detail', () => {
    expect(resolveGatewayProblem('DISCONNECTED', 'Not connected to the Forge gateway.')).toBe(
      'Not connected to the Forge gateway.',
    );
  });

  it('CONNECTED has no problem to report', () => {
    expect(resolveGatewayProblem('CONNECTED', null)).toBeNull();
  });

  it('CONNECTING/DEGRADED are transient — no error branch, so the honest-empty fields render instead', () => {
    expect(resolveGatewayProblem('CONNECTING', 'Connecting to the Forge gateway…')).toBeNull();
    expect(resolveGatewayProblem('DEGRADED', 'Reconciling the Forge gateway connection…')).toBeNull();
  });
});

/* ========================================================================== */
/*  formatGuardTooltip — real guard level/week/thresholds, honest fallbacks  */
/* ========================================================================== */

function accountUsage(overrides: Partial<GatewayAccountUsage> = {}): GatewayAccountUsage {
  return {
    ok: true,
    provenance: 'REPORTED',
    note: null,
    level: 'nvidia-preferred',
    week: 94,
    nvidiaShiftAt: 80,
    pauseAt: 98,
    updatedAt: '2026-07-26T13:41:16.136Z',
    ageMs: 12345,
    capturedAt: '2026-07-26T13:41:28.481Z',
    guard: {
      available: true,
      mode: 'ok',
      pauseAt: 98,
      resumeAt: 0,
      pausedAgentCount: null,
      lastCheckAt: '2026-07-26T13:41:16.137Z',
      ageMs: 12344,
      note: null,
    },
    ...overrides,
  };
}

describe('formatGuardTooltip — real values only, never a plausible-looking number', () => {
  it('a REPORTED reading renders every real field', () => {
    const text = formatGuardTooltip(accountUsage());
    expect(text).toContain('week usage 94%');
    expect(text).toContain('pressure nvidia-preferred');
    expect(text).toContain('NVIDIA-shift at 80%');
    expect(text).toContain('pause at 98%');
    expect(text).toContain('guard ok');
  });

  it('a paused guard reflects the real mode, never a silent "ok"', () => {
    const text = formatGuardTooltip(accountUsage({ guard: { ...accountUsage().guard, mode: 'paused' } }));
    expect(text).toContain('guard paused');
  });

  it('NOT CONFIGURED renders the one honest sentence, never a fabricated percentage', () => {
    const text = formatGuardTooltip(accountUsage({ provenance: 'NOT CONFIGURED' }));
    expect(text).toBe('Forge usage-pressure: not configured on this machine.');
  });

  it('an absent guard-state file never claims "guard ok" — real n/a instead', () => {
    const text = formatGuardTooltip(
      accountUsage({ guard: { available: false, mode: null, pauseAt: null, resumeAt: null, pausedAgentCount: null, lastCheckAt: null, ageMs: null, note: null } }),
    );
    expect(text).toContain('guard n/a');
  });
});

/* ========================================================================== */
/*  buildGatewayUsageState / buildEmptyGatewayUsageHistory / latency reshape */
/* ========================================================================== */

describe('buildGatewayUsageState — no bridge-only concept is invented', () => {
  it('bindingPolicy/observed/coverage/warnings/ingestion all stay an honest absence', () => {
    const usage = buildGatewayUsageState('conversation', 'c-1');
    expect(usage.bindingPolicy).toBeNull();
    expect(usage.observed).toBe(false);
    expect(usage.coverage.rebuiltAt).toBeNull();
    expect(usage.warnings).toEqual([]);
    expect(usage.latency.channels.ingestion).toBeUndefined();
    expect(usage.snapshot.scope).toBe('conversation');
    expect(usage.snapshot.scopeId).toBe('c-1');
  });
});

describe('buildEmptyGatewayUsageHistory — honestly empty, never a decorative curve through zero', () => {
  it('has zero points and zero series', () => {
    const history = buildEmptyGatewayUsageHistory();
    expect(history.points).toEqual([]);
    expect(history.series).toEqual([]);
  });
});

describe('toClientLatencyStat — a real p95 becomes DERIVED, no measurement becomes an honest absence', () => {
  const measured: GatewayLatency = { measured: true, p95Ms: 42, sampleCount: 5, clockBasis: 'same-process' };
  const unmeasured: GatewayLatency = { measured: false, p95Ms: null, sampleCount: 0, clockBasis: 'same-process' };

  it('a real measurement carries its real p95, clockBasis and note through', () => {
    const stat = toClientLatencyStat(measured, 'a real note');
    expect(stat).toEqual({ measured: true, p95Ms: 42, clockBasis: 'same-process', note: 'a real note' });
  });

  it('zero samples yields undefined, never a fabricated 0ms', () => {
    expect(toClientLatencyStat(unmeasured, 'irrelevant')).toBeUndefined();
    expect(toClientLatencyStat(null, 'irrelevant')).toBeUndefined();
  });
});
