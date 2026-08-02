/**
 * `gateway-usage.ts` — real per-conversation `costUsd`/`elapsedMs`
 * (P1-5, fix-crossproject, forge-2026-07-29-cc-finish).
 *
 * BUG THIS CLOSES: `gateway-usage.ts` used to label `costUsd`/`elapsedMs`
 * `NO_CONVERSATION_TELEMETRY` — "genuinely unmeasured, not merely unfetched"
 * — even though `gateway/src/exec-bridge.mjs` writes real `cost_usd`/
 * `duration_ms` on every completed assistant turn and
 * `gateway/src/conversations.mjs` serves the full turn records back
 * unredacted (verified live against the running gateway on :4100 while
 * building this fix — see this WP's forge-report for the exact curl output).
 * `gateway-chat.ts`'s `toGatewayMessage` used to drop both fields while
 * mapping a turn to a `ChatMessage`.
 *
 * THE FIX: `toGatewayMessage` now carries `cost_usd`/`duration_ms` through as
 * extra runtime fields; `sumConversationUsage` sums them over a
 * conversation's real assistant turns; `buildEmptyConversationSnapshot`/
 * `buildGatewayUsageState` build two real `DERIVED` fields when given real
 * totals — an optional 3rd parameter, so the pre-existing 2-argument call in
 * `UsageBar.tsx` (out of this WP's write scope) is completely unaffected and
 * keeps behaving exactly as before. Every OTHER field stays `UNAVAILABLE`,
 * unchanged — this gateway genuinely records nothing else per turn.
 *
 * Fixtures are real `GET /api/conversations/:id` turn shapes run through the
 * ACTUAL production mapping (`toGatewayMessage`, exported for this test),
 * never a hand-rolled `ChatMessage` stand-in — mirrors `gateway-usage.test.ts`'s
 * own pure-function precedent for this seam. This file does not edit that
 * pre-existing test file, to stay clear of the parallel Test Boss's scope on
 * it this run.
 */

import { describe, expect, it } from 'vitest';

import { toGatewayMessage } from '@/prototype/state/gateway-chat';
import {
  EMPTY_CONVERSATION_USAGE_TOTALS,
  buildEmptyConversationSnapshot,
  buildGatewayUsageState,
  sumConversationUsage,
} from '@/prototype/state/gateway-usage';

/** A real `GET /api/conversations/:id` assistant turn shape — the exact
 *  fields `exec-bridge.mjs`/`conversations.mjs` actually produce, live-verified
 *  against the running gateway before writing this fixture. */
function assistantTurn(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    type: 'turn',
    turn_id: 't-1',
    request_id: 'req-1',
    role: 'assistant',
    created_at: '2026-07-29T00:00:00.000Z',
    text: 'ok',
    cost_usd: 0.712107,
    duration_ms: 2349,
    stop_reason: 'end_turn',
    exit_code: 0,
    error: null,
    ...overrides,
  };
}

function userTurn(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    type: 'turn',
    turn_id: 't-0',
    request_id: 'req-1',
    role: 'user',
    created_at: '2026-07-28T23:59:59.000Z',
    text: 'hello',
    ...overrides,
  };
}

describe('sumConversationUsage — real per-conversation totals, never a fabricated 0', () => {
  it('a fixture of two real assistant turns sums cost_usd/duration_ms exactly', () => {
    const turns = [
      userTurn(),
      assistantTurn({ turn_id: 't-1', cost_usd: 0.0002, duration_ms: 5 }),
      userTurn({ turn_id: 't-2' }),
      assistantTurn({ turn_id: 't-3', cost_usd: 1.1127310000000001, duration_ms: 50060 }),
    ];
    const messages = turns.map((turn, i) => toGatewayMessage(turn, i));

    const totals = sumConversationUsage(messages);

    expect(totals.costUsd).toBeCloseTo(0.0002 + 1.1127310000000001, 10);
    expect(totals.elapsedMs).toBe(5 + 50060);
  });

  it('a turn where the gateway recorded cost_usd:null (e.g. a spawn error) contributes NOTHING — never coerced to 0', () => {
    const turns = [
      assistantTurn({ turn_id: 't-1', cost_usd: null, duration_ms: null, error: 'the model reported is_error:true' }),
      assistantTurn({ turn_id: 't-2', cost_usd: 0.5, duration_ms: 1000 }),
    ];
    const messages = turns.map((turn, i) => toGatewayMessage(turn, i));

    const totals = sumConversationUsage(messages);

    // The real measured turn's own value, not 0.5 diluted by a fabricated 0
    // for the null turn, and not NaN either.
    expect(totals.costUsd).toBe(0.5);
    expect(totals.elapsedMs).toBe(1000);
  });

  // fix-usage-capture: sumConversationUsage's return shape grew four token fields plus `model`;
  // the two tests below (`toEqual({ costUsd, elapsedMs })`) predate that and now correctly compare
  // against the FULL shape, matching `EMPTY_CONVERSATION_USAGE_TOTALS`'s own honest all-null
  // default for every field these fixtures never populate.

  it('NOT ONE assistant turn reporting the field yields null, never a fabricated 0 — an all-null conversation stays an honest absence', () => {
    const turns = [assistantTurn({ turn_id: 't-1', cost_usd: null, duration_ms: null })];
    const messages = turns.map((turn, i) => toGatewayMessage(turn, i));

    const totals = sumConversationUsage(messages);

    expect(totals.costUsd).toBeNull();
    expect(totals.elapsedMs).toBeNull();
  });

  it('no turns at all (empty conversation) yields the same honest absence as before this fix', () => {
    expect(sumConversationUsage([])).toEqual(EMPTY_CONVERSATION_USAGE_TOTALS);
  });

  it('a user turn never contributes, even though it is the only turn present', () => {
    const messages = [toGatewayMessage(userTurn(), 0)];
    expect(sumConversationUsage(messages)).toEqual(EMPTY_CONVERSATION_USAGE_TOTALS);
  });

  it('a fixture/example ChatMessage (no gateway-carried cost_usd/duration_ms field at all) is read as an honest absence, never a crash', () => {
    const fixtureMessage = {
      prototype: true as const,
      id: 'm-1',
      author: 'forge' as const,
      body: 'example reply',
      timestamp: 'just now',
    };
    expect(sumConversationUsage([fixtureMessage])).toEqual(EMPTY_CONVERSATION_USAGE_TOTALS);
  });
});

describe('buildEmptyConversationSnapshot — costUsd/elapsedMs real when given real totals, every other field unaffected', () => {
  it('real totals produce two DERIVED fields with a truthful, auditable source sentence', () => {
    const turns = [assistantTurn({ turn_id: 't-1', cost_usd: 0.712107, duration_ms: 2349 })];
    const messages = turns.map((turn, i) => toGatewayMessage(turn, i));
    const totals = sumConversationUsage(messages);

    const snapshot = buildEmptyConversationSnapshot('conversation', 'c-1', totals);

    expect(snapshot.costUsd).toEqual({
      name: 'costUsd',
      value: 0.712107,
      unit: 'usd',
      source: expect.stringContaining('exec-bridge.mjs'),
      accuracy: 'DERIVED',
      updatedAt: '',
    });
    expect(snapshot.elapsedMs.value).toBe(2349);
    expect(snapshot.elapsedMs.accuracy).toBe('DERIVED');
    expect(snapshot.elapsedMs.unit).toBe('ms');
  });

  it('the default (no totals argument) reproduces the exact pre-fix UNAVAILABLE shape — the out-of-scope UsageBar.tsx 2-arg call site is unaffected', () => {
    const snapshot = buildEmptyConversationSnapshot('conversation', 'c-1');

    expect(snapshot.costUsd.value).toBeNull();
    expect(snapshot.costUsd.accuracy).toBe('UNAVAILABLE');
    expect(snapshot.elapsedMs.value).toBeNull();
    expect(snapshot.elapsedMs.accuracy).toBe('UNAVAILABLE');
  });

  it('every OTHER field stays UNAVAILABLE even when real cost/duration totals are supplied — only two fields ever become real', () => {
    const snapshot = buildEmptyConversationSnapshot('conversation', 'c-1', { costUsd: 1, elapsedMs: 100 });

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
      snapshot.turns,
      snapshot.toolCalls,
      snapshot.agentCount,
      snapshot.skillUses,
      snapshot.errors,
      snapshot.retries,
      snapshot.compactions,
      snapshot.eventLatencyP95,
    ]) {
      expect(field.value).toBeNull();
      expect(field.accuracy).toBe('UNAVAILABLE');
    }
    expect(snapshot.planUsage.accuracy).toBe('UNAVAILABLE');
  });
});

describe('buildGatewayUsageState — real totals thread through to the rendered snapshot', () => {
  it('passes real totals all the way to snapshot.costUsd/elapsedMs', () => {
    const state = buildGatewayUsageState('conversation', 'c-1', { costUsd: 2.5, elapsedMs: 4000 });
    expect(state.snapshot.costUsd.value).toBe(2.5);
    expect(state.snapshot.costUsd.accuracy).toBe('DERIVED');
    expect(state.snapshot.elapsedMs.value).toBe(4000);
  });

  it('the default (no 3rd argument) is byte-identical to the pre-fix behaviour', () => {
    const state = buildGatewayUsageState('conversation', 'c-1');
    expect(state.snapshot.costUsd.value).toBeNull();
    expect(state.snapshot.costUsd.accuracy).toBe('UNAVAILABLE');
    expect(state.snapshot.elapsedMs.value).toBeNull();
  });
});
