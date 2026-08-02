/**
 * `gateway-usage.ts` — real per-conversation token counts + model name
 * (fix-usage-capture, checkup MEDIUM-upgrade).
 *
 * BUG THIS CLOSES: `exec-bridge.mjs` already parsed every real stream-json line from
 * `claude -p --output-format stream-json`, including the `result` line's own `usage` block
 * (`input_tokens`/`output_tokens`/`cache_creation_input_tokens`/`cache_read_input_tokens`) and its
 * `modelUsage` object naming the model actually used — verified live against 9 real (non-mock)
 * `result` events already stored in this project's own `.data/conversations/*.jsonl` (see this
 * WP's forge-report for the exact captured JSON). Only `cost_usd`/`duration_ms`/`stop_reason`/
 * `exit_code` were ever kept; every other real field was parsed then thrown away, so the UI showed
 * model/tokens/context as UNAVAILABLE even though the data existed on disk.
 *
 * THE FIX: `exec-bridge.mjs` now reads `input_tokens`/`output_tokens`/
 * `cache_creation_input_tokens`/`cache_read_input_tokens`/`model` off the same `resultPayload` it
 * already parses and writes them onto the turn record; `gateway-chat.ts`'s `toGatewayMessage`
 * carries all five through (mirrors the pre-existing `cost_usd`/`duration_ms` pattern exactly);
 * `sumConversationUsage` sums the four token counts and picks the MOST RECENT real model any
 * assistant turn reported (never summed — a conversation can genuinely switch models across
 * turns); `buildEmptyConversationSnapshot` turns a real value into a `DERIVED` `UsageField`, and
 * keeps the same honest `UNAVAILABLE` shape when no assistant turn measured it — never a
 * fabricated `0`/`''`.
 *
 * Fixtures are real `GET /api/conversations/:id` turn shapes (the `assistantTurn`/`userTurn`
 * helpers mirror `gateway-usage-conversation-cost.test.ts`'s own precedent for this seam) run
 * through the ACTUAL production mapping (`toGatewayMessage`, exported for this test), never a
 * hand-rolled `ChatMessage` stand-in. This is a NEW file (not an edit to the pre-existing
 * `gateway-usage-conversation-cost.test.ts`/`gateway-usage.test.ts`), matching this project's own
 * convention of giving each WP's new capability its own test file.
 */

import { describe, expect, it } from 'vitest';

import { toGatewayMessage } from '@/prototype/state/gateway-chat';
import {
  buildEmptyConversationSnapshot,
  sumConversationUsage,
} from '@/prototype/state/gateway-usage';

/** A real `GET /api/conversations/:id` assistant turn shape — the exact fields
 *  `exec-bridge.mjs`/`conversations.mjs` actually produce since fix-usage-capture, live-verified
 *  against this project's own `.data/conversations/*.jsonl` before writing this fixture (see this
 *  WP's forge-report for the exact captured JSON: `input_tokens: 2`,
 *  `cache_creation_input_tokens: 94734`, `cache_read_input_tokens: 0`, `output_tokens: 12`,
 *  `modelUsage: { "claude-fable-5": { canonicalModel: "claude-fable-5", ... } }`). */
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
    input_tokens: 2,
    output_tokens: 12,
    cache_creation_input_tokens: 94734,
    cache_read_input_tokens: 0,
    model: 'claude-fable-5',
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

describe('sumConversationUsage — real token counts + latest model, never a fabricated 0/blank', () => {
  it('sums real input/output/cache token counts over multiple real assistant turns', () => {
    const turns = [
      userTurn(),
      assistantTurn({ turn_id: 't-1', input_tokens: 2, output_tokens: 12, cache_creation_input_tokens: 94734, cache_read_input_tokens: 0 }),
      userTurn({ turn_id: 't-2' }),
      assistantTurn({ turn_id: 't-3', input_tokens: 10, output_tokens: 3094, cache_creation_input_tokens: 82144, cache_read_input_tokens: 427782 }),
    ];
    const messages = turns.map((turn, i) => toGatewayMessage(turn, i));

    const totals = sumConversationUsage(messages);

    expect(totals.inputTokens).toBe(2 + 10);
    expect(totals.outputTokens).toBe(12 + 3094);
    expect(totals.cacheCreationTokens).toBe(94734 + 82144);
    expect(totals.cacheReadTokens).toBe(0 + 427782);
  });

  it('a turn where the gateway recorded no usage (mock mode / spawn error) contributes NOTHING to the token sums', () => {
    const turns = [
      assistantTurn({ turn_id: 't-1', input_tokens: null, output_tokens: null, cache_creation_input_tokens: null, cache_read_input_tokens: null }),
      assistantTurn({ turn_id: 't-2', input_tokens: 2, output_tokens: 411, cache_creation_input_tokens: 69661, cache_read_input_tokens: 24494 }),
    ];
    const messages = turns.map((turn, i) => toGatewayMessage(turn, i));

    const totals = sumConversationUsage(messages);

    expect(totals.inputTokens).toBe(2);
    expect(totals.outputTokens).toBe(411);
    expect(totals.cacheCreationTokens).toBe(69661);
    expect(totals.cacheReadTokens).toBe(24494);
  });

  it('a real cache_read_input_tokens:0 is a MEASURED zero, not an absence — it must sum as 0, not be dropped', () => {
    const turns = [assistantTurn({ turn_id: 't-1', cache_read_input_tokens: 0 })];
    const messages = turns.map((turn, i) => toGatewayMessage(turn, i));

    const totals = sumConversationUsage(messages);

    expect(totals.cacheReadTokens).toBe(0);
  });

  it('model is the MOST RECENT real report, never summed — a conversation that switched models reflects the latest one', () => {
    const turns = [
      assistantTurn({ turn_id: 't-1', model: 'claude-fable-5' }),
      assistantTurn({ turn_id: 't-2', model: 'claude-opus-5' }),
    ];
    const messages = turns.map((turn, i) => toGatewayMessage(turn, i));

    const totals = sumConversationUsage(messages);

    expect(totals.model).toBe('claude-opus-5');
  });

  it('a later turn with no model does not blank out an earlier real one', () => {
    const turns = [
      assistantTurn({ turn_id: 't-1', model: 'claude-fable-5' }),
      assistantTurn({ turn_id: 't-2', model: null }),
    ];
    const messages = turns.map((turn, i) => toGatewayMessage(turn, i));

    const totals = sumConversationUsage(messages);

    expect(totals.model).toBe('claude-fable-5');
  });

  it('NOT ONE assistant turn reporting any token/model field yields null across the board, never a fabricated value', () => {
    const turns = [
      assistantTurn({
        turn_id: 't-1',
        input_tokens: null,
        output_tokens: null,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        model: null,
      }),
    ];
    const messages = turns.map((turn, i) => toGatewayMessage(turn, i));

    const totals = sumConversationUsage(messages);

    expect(totals.inputTokens).toBeNull();
    expect(totals.outputTokens).toBeNull();
    expect(totals.cacheCreationTokens).toBeNull();
    expect(totals.cacheReadTokens).toBeNull();
    expect(totals.model).toBeNull();
  });

  it('a user turn never contributes a model/token value, even though it is the only turn present', () => {
    const messages = [toGatewayMessage(userTurn(), 0)];

    const totals = sumConversationUsage(messages);

    expect(totals.inputTokens).toBeNull();
    expect(totals.model).toBeNull();
  });
});

describe('buildEmptyConversationSnapshot — model/token fields DERIVED when real, honestly UNAVAILABLE otherwise', () => {
  it('real token totals + a real model produce DERIVED fields with a truthful, auditable source sentence', () => {
    const turns = [assistantTurn({ turn_id: 't-1' })]; // uses the fixture's own real default values
    const messages = turns.map((turn, i) => toGatewayMessage(turn, i));
    const totals = sumConversationUsage(messages);

    const snapshot = buildEmptyConversationSnapshot('conversation', 'c-1', totals);

    expect(snapshot.model).toEqual({
      name: 'model',
      value: 'claude-fable-5',
      unit: 'none',
      source: expect.stringContaining('modelUsage'),
      accuracy: 'DERIVED',
      updatedAt: '',
    });
    expect(snapshot.inputTokens.value).toBe(2);
    expect(snapshot.inputTokens.accuracy).toBe('DERIVED');
    expect(snapshot.inputTokens.unit).toBe('tokens');
    expect(snapshot.outputTokens.value).toBe(12);
    expect(snapshot.outputTokens.accuracy).toBe('DERIVED');
    expect(snapshot.cacheCreationTokens.value).toBe(94734);
    expect(snapshot.cacheCreationTokens.accuracy).toBe('DERIVED');
    expect(snapshot.cacheReadTokens.value).toBe(0);
    expect(snapshot.cacheReadTokens.accuracy).toBe('DERIVED');
  });

  it('the default (no totals argument) keeps model/token fields honestly UNAVAILABLE — the exact pre-fix shape', () => {
    const snapshot = buildEmptyConversationSnapshot('conversation', 'c-1');

    for (const field of [snapshot.model, snapshot.inputTokens, snapshot.outputTokens, snapshot.cacheReadTokens, snapshot.cacheCreationTokens]) {
      expect(field.value).toBeNull();
      expect(field.accuracy).toBe('UNAVAILABLE');
    }
  });

  it('a genuinely measured cacheReadTokens:0 renders as a real 0 with DERIVED accuracy, never collapsed into the UNAVAILABLE branch', () => {
    const snapshot = buildEmptyConversationSnapshot('conversation', 'c-1', { costUsd: null, elapsedMs: null, cacheReadTokens: 0 });

    expect(snapshot.cacheReadTokens.value).toBe(0);
    expect(snapshot.cacheReadTokens.accuracy).toBe('DERIVED');
  });

  it('context window / session / agent / skill fields stay UNAVAILABLE even when model/tokens are real — only the fields this gateway genuinely records become real', () => {
    const turns = [assistantTurn({ turn_id: 't-1' })];
    const messages = turns.map((turn, i) => toGatewayMessage(turn, i));
    const totals = sumConversationUsage(messages);

    const snapshot = buildEmptyConversationSnapshot('conversation', 'c-1', totals);

    for (const field of [snapshot.contextTokensUsed, snapshot.contextWindow, snapshot.contextPercent, snapshot.agentCount, snapshot.skillUses]) {
      expect(field.value).toBeNull();
      expect(field.accuracy).toBe('UNAVAILABLE');
    }
    expect(snapshot.sessionId).toBeNull();
  });
});
