/**
 * `gateway-usage.ts` — real session id / context occupancy / AGENT label
 * (fix-unavailable, forge-2026-07-30-cc-finish, run forge-2026-07-30-cc-finish).
 *
 * BUG THIS CLOSES: the owner's screenshots showed `SESSION n/a UNAVAILABLE`, `MODEL n/a UN…`, an
 * `AGENT`/`SKILL` label stuck at `n/a`, even though `gateway/src/exec-lifecycle.mjs` now captures a
 * real session id (off nearly every stream-json line), a real context window (off the same
 * `result.modelUsage[model]` entry `model` already comes from), and a real Agent-dispatch
 * subagent_type (off a real `Agent` tool_use block) and writes all three onto the completed
 * assistant turn's own `session_id`/`context_window`/`agent_type` keys.
 *
 * HARD RULE proven here: context occupancy is a point-in-time fact — `latestContextOccupancy`
 * must read ONLY the most recent assistant turn that reported a context window, never sum across
 * turns (a running total would only ever grow and would misrepresent the model's real, current
 * context usage).
 *
 * Fixtures are real `GET /api/conversations/:id` turn shapes run through the ACTUAL production
 * mapping (`toGatewayMessage`), never a hand-rolled `ChatMessage` stand-in — mirrors
 * `gateway-usage-token-model-capture.test.ts`'s own precedent for this exact seam.
 */

import { describe, expect, it } from 'vitest';

import { toGatewayMessage } from '@/prototype/state/gateway-chat';
import {
  AGENT_LABEL_UNAVAILABLE,
  EMPTY_CONVERSATION_USAGE_TOTALS,
  NO_OBSERVED_EVIDENCE,
  buildAgentLabel,
  buildEmptyConversationSnapshot,
  buildGatewayUsageState,
  latestContextOccupancy,
  sumConversationUsage,
} from '@/prototype/state/gateway-usage';

/** A real assistant turn shape — mirrors `gateway-usage-token-model-capture.test.ts`'s own
 *  `assistantTurn` helper, extended with the three fix-unavailable fields. */
function assistantTurn(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    type: 'turn',
    turn_id: 't-1',
    request_id: 'req-1',
    role: 'assistant',
    created_at: '2026-07-30T00:00:00.000Z',
    text: 'ok',
    cost_usd: 0.712107,
    duration_ms: 2349,
    stop_reason: 'end_turn',
    exit_code: 0,
    error: null,
    input_tokens: 2,
    output_tokens: 12,
    cache_creation_input_tokens: 94734,
    cache_read_input_tokens: 0,
    model: 'claude-fable-5',
    session_id: '060c83ff-8ef5-4722-898a-884f5157a1c2',
    context_window: 1000000,
    agent_type: 'Explore',
    ...overrides,
  };
}

function userTurn(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    type: 'turn',
    turn_id: 't-0',
    request_id: 'req-1',
    role: 'user',
    created_at: '2026-07-29T23:59:59.000Z',
    text: 'hello',
    ...overrides,
  };
}

describe('SESSION — the most recent real session id, never invented', () => {
  it('sumConversationUsage reports the real session id an assistant turn recorded', () => {
    const messages = [userTurn(), assistantTurn()].map((turn, i) => toGatewayMessage(turn, i));
    const totals = sumConversationUsage(messages);
    expect(totals.sessionId).toBe('060c83ff-8ef5-4722-898a-884f5157a1c2');
  });

  it('a user turn never contributes a session id, even though it is the only turn present', () => {
    const messages = [toGatewayMessage(userTurn(), 0)];
    expect(sumConversationUsage(messages).sessionId).toBeNull();
  });

  it('buildEmptyConversationSnapshot carries the real session id through as a bare string (not a UsageField)', () => {
    const messages = [assistantTurn()].map((turn, i) => toGatewayMessage(turn, i));
    const totals = sumConversationUsage(messages);
    const snapshot = buildEmptyConversationSnapshot('conversation', 'c-1', totals);
    expect(snapshot.sessionId).toBe('060c83ff-8ef5-4722-898a-884f5157a1c2');
  });

  it('no assistant turn ever having reported a session id stays an honest null, never a fabricated id', () => {
    const messages = [assistantTurn({ session_id: null })].map((turn, i) => toGatewayMessage(turn, i));
    expect(sumConversationUsage(messages).sessionId).toBeNull();
  });
});

describe('CONTEXT OCCUPANCY — HARD RULE: the LATEST turn only, never summed across turns', () => {
  it('two assistant turns with DIFFERENT context windows report the SECOND (most recent) one, not a sum of the two', () => {
    const turns = [
      assistantTurn({ turn_id: 't-1', context_window: 1000000, input_tokens: 2, cache_creation_input_tokens: 94734, cache_read_input_tokens: 0 }),
      assistantTurn({ turn_id: 't-2', context_window: 200000, input_tokens: 10, cache_creation_input_tokens: 5000, cache_read_input_tokens: 1000 }),
    ];
    const messages = turns.map((turn, i) => toGatewayMessage(turn, i));

    const occupancy = latestContextOccupancy(messages);

    // The SECOND turn's own real figures — 10 + 5000 + 1000 = 6010 — never 94736 (turn 1) and
    // never the two turns' figures added together (100746).
    expect(occupancy.contextWindow).toBe(200000);
    expect(occupancy.contextTokensUsed).toBe(6010);
  });

  it('a later turn with NO context window does not blank out an earlier real one — it is skipped, not treated as "most recent"', () => {
    const turns = [
      assistantTurn({ turn_id: 't-1', context_window: 1000000 }),
      assistantTurn({ turn_id: 't-2', context_window: null, model: null }),
    ];
    const messages = turns.map((turn, i) => toGatewayMessage(turn, i));

    const occupancy = latestContextOccupancy(messages);

    expect(occupancy.contextWindow).toBe(1000000);
  });

  it('sumConversationUsage/buildEmptyConversationSnapshot compute a real contextPercent from the SAME latest turn, never a running total', () => {
    const turns = [
      assistantTurn({ turn_id: 't-1', context_window: 1000000, input_tokens: 100000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }),
      assistantTurn({ turn_id: 't-2', context_window: 1000000, input_tokens: 2, cache_creation_input_tokens: 94734, cache_read_input_tokens: 0 }),
    ];
    const messages = turns.map((turn, i) => toGatewayMessage(turn, i));
    const totals = sumConversationUsage(messages);

    // If this were ever summed across turns, contextTokensUsed would be 100000 + 94736 = 194736
    // (19.47%). The HARD RULE means only the SECOND turn's own 94736 counts (9.4736%).
    expect(totals.contextTokensUsed).toBe(94736);
    expect(totals.contextWindow).toBe(1000000);

    const snapshot = buildEmptyConversationSnapshot('conversation', 'c-1', totals);
    expect(snapshot.contextTokensUsed.value).toBe(94736);
    expect(snapshot.contextTokensUsed.accuracy).toBe('DERIVED');
    expect(snapshot.contextWindow.value).toBe(1000000);
    expect(snapshot.contextPercent.value).toBeCloseTo(9.4736, 3);
    expect(snapshot.contextPercent.accuracy).toBe('DERIVED');
  });

  it('NOT ONE assistant turn reporting a context window yields a real, honest UNAVAILABLE — never a fabricated 0%', () => {
    const messages = [assistantTurn({ context_window: null })].map((turn, i) => toGatewayMessage(turn, i));
    const totals = sumConversationUsage(messages);
    const snapshot = buildEmptyConversationSnapshot('conversation', 'c-1', totals);

    expect(snapshot.contextTokensUsed.value).toBeNull();
    expect(snapshot.contextTokensUsed.accuracy).toBe('UNAVAILABLE');
    expect(snapshot.contextWindow.value).toBeNull();
    expect(snapshot.contextPercent.value).toBeNull();
    expect(snapshot.contextPercent.accuracy).toBe('UNAVAILABLE');
  });
});

describe('AGENT — the real, most-recently-dispatched subagent_type, never invented', () => {
  it('sumConversationUsage reports the real agent_type an assistant turn recorded', () => {
    const messages = [assistantTurn()].map((turn, i) => toGatewayMessage(turn, i));
    expect(sumConversationUsage(messages).agentType).toBe('Explore');
  });

  it('agent type is the MOST RECENT real report, never summed/concatenated — a later dispatch overrides an earlier one', () => {
    const turns = [
      assistantTurn({ turn_id: 't-1', agent_type: 'Explore' }),
      assistantTurn({ turn_id: 't-2', agent_type: 'Plan' }),
    ];
    const messages = turns.map((turn, i) => toGatewayMessage(turn, i));
    expect(sumConversationUsage(messages).agentType).toBe('Plan');
  });

  it('buildAgentLabel returns a real DERIVED label for a real subagent_type', () => {
    const label = buildAgentLabel('Explore');
    expect(label.text).toBe('Explore');
    expect(label.accuracy).toBe('DERIVED');
    expect(label.title).not.toMatch(/no per-conversation agent-dispatch telemetry exists/i);
  });

  it('buildAgentLabel falls back to the honest AGENT_LABEL_UNAVAILABLE constant for null', () => {
    expect(buildAgentLabel(null)).toEqual(AGENT_LABEL_UNAVAILABLE);
  });

  it('a conversation that never dispatched a sub-agent stays honestly UNAVAILABLE, never a guessed agent name', () => {
    const messages = [assistantTurn({ agent_type: null })].map((turn, i) => toGatewayMessage(turn, i));
    expect(sumConversationUsage(messages).agentType).toBeNull();
    expect(buildAgentLabel(sumConversationUsage(messages).agentType ?? null)).toEqual(AGENT_LABEL_UNAVAILABLE);
  });
});

describe('buildGatewayUsageState — observed/firstEventAt/agentType real when given real evidence', () => {
  it('real evidence (hasAnyTurn:true, a real firstEventAt) threads through honestly', () => {
    const totals = sumConversationUsage([assistantTurn()].map((turn, i) => toGatewayMessage(turn, i)));
    const state = buildGatewayUsageState('conversation', 'c-1', totals, {
      hasAnyTurn: true,
      firstEventAt: '2026-07-29T23:59:59.000Z',
      latestEventAt: '2026-07-30T00:15:00.000Z',
    });

    expect(state.observed).toBe(true);
    expect(state.firstEventAt).toBe('2026-07-29T23:59:59.000Z');
    expect(state.agentType).toBe('Explore');
  });

  it('the default (no 4th argument) stays the exact honest absence this file always reported', () => {
    const state = buildGatewayUsageState('conversation', 'c-1');
    expect(state.observed).toBe(false);
    expect(state.firstEventAt).toBeNull();
    expect(state.agentType).toBeNull();
  });
});

/* ---------------------------------------------------------------------------------------------
 * "Updated" / "Last update" was a PERMANENTLY EMPTY row (coordinator finding 2026-07-30).
 * `buildEmptyConversationSnapshot` hardcoded `lastUpdate: ''`, so UsageBar's "Updated" and
 * UsageDetails' "Last update" could only ever render an em dash — the exact always-empty defect the
 * "Rebuilt at" row was removed for in this same round. Unlike that row, this one HAS a real source
 * (the scope's most recent turn), so it is filled instead of removed.
 * ------------------------------------------------------------------------------------------- */
describe('lastUpdate — the "Updated" row must carry the real latest-turn timestamp, never a permanent em dash', () => {
  it('is the real latest-turn timestamp when the evidence supplies one', () => {
    const state = buildGatewayUsageState('conversation', 'c-1', EMPTY_CONVERSATION_USAGE_TOTALS, {
      hasAnyTurn: true,
      firstEventAt: '2026-07-30T10:00:00.000Z',
      latestEventAt: '2026-07-30T11:31:01.582Z',
    });
    expect(state.snapshot.lastUpdate).toBe('2026-07-30T11:31:01.582Z');
    // and it is genuinely the LATEST, not the first — those are different values here on purpose
    expect(state.snapshot.lastUpdate).not.toBe(state.firstEventAt);
  });

  it('stays honestly empty when the scope genuinely has no turn at all', () => {
    const state = buildGatewayUsageState('conversation', 'c-empty', EMPTY_CONVERSATION_USAGE_TOTALS, NO_OBSERVED_EVIDENCE);
    expect(state.snapshot.lastUpdate).toBe('');
    expect(state.observed).toBe(false);
  });
});
