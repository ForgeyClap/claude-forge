/**
 * Usage telemetry SHAPE — one shape from the CLI stream to the declaration.
 *
 * The bug this suite pins down: the adapter persists `claude.usage` events whose
 * payload is the `ClaudeStreamParser`'s own `{ snapshot, final }` — a fully-built
 * `UsageSnapshot` — while the aggregator's envelope parser was written to read the
 * RAW 2.1.217 result envelope (`usage.input_tokens`, `total_cost_usd`, `num_turns`,
 * `modelUsage[model].contextWindow`). The two never met: the aggregator established
 * no EXACT field, `getUsageState` came back empty, and `USES_REAL_USAGE_TELEMETRY`
 * derived false even straight after a real run.
 *
 * The fix teaches the aggregator to read the snapshot shape the parser emits,
 * lifting only the scalars the parser marked EXACT — the ones it took verbatim
 * from the CLI result envelope — so provenance survives and no number is
 * duplicated. This test drives a REAL result-envelope-shaped line through the
 * parser AND the aggregator and asserts the whole chain, up to the point where
 * `observeUsageSnapshots` would let the declaration derive true.
 */

import { describe, expect, it } from 'vitest';

import {
  UsageAggregator,
  parseUsageEnvelope,
} from '@/bridge/usage/aggregator.ts';
import { ClaudeStreamParser, materialiseEvent } from '@/bridge/claude/parse.ts';
import type { ClaudeUsagePayload, ForgeEventDraft, ParseContext } from '@/bridge/claude/parse.ts';
import { observeUsageSnapshots } from '@/bridge/health.ts';
import { deriveDeclarations, emptyDeclarationInputs } from '@/shared/declarations';
import { PLAN_USAGE_UNAVAILABLE_MESSAGE } from '@/shared/protocol';
import type { ForgeEvent, UsageSnapshot } from '@/shared/protocol';

/* -------------------------------------------------------------------------- */
/*  A real 2.1.217 result envelope                                             */
/* -------------------------------------------------------------------------- */

const PROJECT_ID = 'proj-usage-shape';
const RUN_ID = 'run-usage-shape';
const CONVERSATION_ID = 'conv-usage-shape';
const SESSION_ID = '97c12490-b1f6-47a2-96d4-ab4d05b921ee';
const MODEL = 'claude-opus-4-8';
const T0 = Date.parse('2026-07-24T10:00:00.000Z');

// Real 2.1.217 field names. The numbers are chosen so context occupancy is a
// clean check: 1000 + 200 + 5000 + 800 = 7000 tokens of a 200000 window = 3.5%.
const INPUT = 1000;
const OUTPUT = 200;
const CACHE_READ = 5000;
const CACHE_CREATE = 800;
const COST = 0.0123;
const TURNS = 2;
const CONTEXT_WINDOW = 200_000;
const CONTEXT_TOKENS = INPUT + OUTPUT + CACHE_READ + CACHE_CREATE; // 7000
const CONTEXT_PERCENT = (CONTEXT_TOKENS / CONTEXT_WINDOW) * 100; // 3.5

const SYSTEM_INIT_LINE = JSON.stringify({
  type: 'system',
  subtype: 'init',
  session_id: SESSION_ID,
  model: MODEL,
  permissionMode: 'default',
  apiKeySource: 'none',
  tools: [],
  agents: [],
  skills: [],
});

const RESULT_LINE = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  session_id: SESSION_ID,
  total_cost_usd: COST,
  num_turns: TURNS,
  duration_ms: 4210,
  usage: {
    input_tokens: INPUT,
    output_tokens: OUTPUT,
    cache_read_input_tokens: CACHE_READ,
    cache_creation_input_tokens: CACHE_CREATE,
  },
  modelUsage: {
    [MODEL]: {
      contextWindow: CONTEXT_WINDOW,
      maxOutputTokens: 64_000,
      costUSD: COST,
    },
  },
});

function parseContext(): ParseContext {
  return {
    projectId: PROJECT_ID,
    runId: RUN_ID,
    conversationId: CONVERSATION_ID,
    partialMessagesEnabled: false,
    resumed: false,
    now: () => new Date(T0),
  };
}

/**
 * Run the two lines through the parser and return the final `claude.usage`
 * event, materialised the way the store would materialise it, plus the snapshot
 * the parser itself put on the payload.
 */
function runParser(): { event: ForgeEvent<ClaudeUsagePayload>; parserSnapshot: UsageSnapshot } {
  const parser = new ClaudeStreamParser(parseContext());
  parser.pushLine(SYSTEM_INIT_LINE, 1);
  const drafts = parser.pushLine(RESULT_LINE, 2);

  const usageDraft = drafts.find((d) => d.type === 'claude.usage') as
    | ForgeEventDraft<ClaudeUsagePayload>
    | undefined;
  if (usageDraft === undefined) throw new Error('parser did not emit a claude.usage event for the result line');

  const event = materialiseEvent(usageDraft, {
    eventId: 'evt-usage-1',
    sequence: 1,
    schemaVersion: 1,
    ingestedAt: T0 + 4,
  });
  return { event, parserSnapshot: usageDraft.payload.snapshot };
}

/* ========================================================================== */
/*  The parser side                                                            */
/* ========================================================================== */

describe('parser emits a snapshot with EXACT scalars', () => {
  it('lifts the four token counts, cost, turns and context window straight from the envelope', () => {
    const { parserSnapshot: s } = runParser();

    expect(s.inputTokens).toMatchObject({ value: INPUT, accuracy: 'EXACT' });
    expect(s.outputTokens).toMatchObject({ value: OUTPUT, accuracy: 'EXACT' });
    expect(s.cacheReadTokens).toMatchObject({ value: CACHE_READ, accuracy: 'EXACT' });
    expect(s.cacheCreationTokens).toMatchObject({ value: CACHE_CREATE, accuracy: 'EXACT' });
    expect(s.costUsd).toMatchObject({ value: COST, accuracy: 'EXACT' });
    expect(s.turns).toMatchObject({ value: TURNS, accuracy: 'EXACT' });
    expect(s.contextWindow).toMatchObject({ value: CONTEXT_WINDOW, accuracy: 'EXACT' });
    expect(s.model).toMatchObject({ value: MODEL, accuracy: 'EXACT' });

    // Context occupancy is arithmetic over EXACT tokens, hence DERIVED.
    expect(s.contextTokensUsed).toMatchObject({ value: CONTEXT_TOKENS, accuracy: 'DERIVED' });
    expect(s.contextPercent.accuracy).toBe('DERIVED');
    expect(s.contextPercent.value).toBeCloseTo(CONTEXT_PERCENT, 9);

    // The one field the runtime never exposes. The parser leaves the value null
    // and states the reason in `source`; only the aggregator later carries the
    // sentence as the value.
    expect(s.planUsage.accuracy).toBe('UNAVAILABLE');
    expect(s.planUsage.value).toBeNull();
    expect(s.planUsage.source).toBe(PLAN_USAGE_UNAVAILABLE_MESSAGE);
  });
});

/* ========================================================================== */
/*  The seam — parseUsageEnvelope reads the { snapshot, final } shape          */
/* ========================================================================== */

describe('parseUsageEnvelope reads the { snapshot, final } payload', () => {
  it('extracts the EXACT envelope numbers out of the built snapshot', () => {
    const { event } = runParser();
    const parsed = parseUsageEnvelope(event.payload);

    expect(parsed.ok).toBe(true);
    expect(parsed.inputTokens).toBe(INPUT);
    expect(parsed.outputTokens).toBe(OUTPUT);
    expect(parsed.cacheReadTokens).toBe(CACHE_READ);
    expect(parsed.cacheCreationTokens).toBe(CACHE_CREATE);
    expect(parsed.costUsd).toBe(COST);
    expect(parsed.turns).toBe(TURNS);
    expect(parsed.contextWindow).toBe(CONTEXT_WINDOW);
    expect(parsed.model).toBe(MODEL);
    expect(parsed.sessionId).toBe(SESSION_ID);
    // Cumulative running total, so it converts to a delta at ingest.
    expect(parsed.reporting).toBe('cumulative');
    expect(parsed.missing).toHaveLength(0);
  });

  it('still reads the raw wrapped envelope shape (no regression)', () => {
    const parsed = parseUsageEnvelope({
      envelope: {
        session_id: SESSION_ID,
        total_cost_usd: COST,
        num_turns: TURNS,
        usage: {
          input_tokens: INPUT,
          output_tokens: OUTPUT,
          cache_read_input_tokens: CACHE_READ,
          cache_creation_input_tokens: CACHE_CREATE,
        },
        modelUsage: { [MODEL]: { contextWindow: CONTEXT_WINDOW } },
      },
      reporting: 'cumulative',
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.inputTokens).toBe(INPUT);
    expect(parsed.contextWindow).toBe(CONTEXT_WINDOW);
  });
});

/* ========================================================================== */
/*  The aggregator side                                                        */
/* ========================================================================== */

describe('aggregator ingests the parser event and establishes EXACT fields', () => {
  it('accepts the event and produces an EXACT run snapshot', () => {
    const { event } = runParser();
    const agg = new UsageAggregator({ now: () => T0 + 10, timeZone: 'UTC' });
    const result = agg.ingest(event);

    expect(result.accepted).toBe(true);
    expect(result.rejections).toHaveLength(0);

    const run = agg.getSnapshot('run', RUN_ID);
    expect(run).not.toBeNull();
    if (run === null) return;

    // A run's deltas telescope back to the envelope's own totals, so the run
    // scope may claim EXACT — and each value equals the CLI's own number.
    expect(run.inputTokens).toMatchObject({ value: INPUT, accuracy: 'EXACT' });
    expect(run.outputTokens).toMatchObject({ value: OUTPUT, accuracy: 'EXACT' });
    expect(run.cacheReadTokens).toMatchObject({ value: CACHE_READ, accuracy: 'EXACT' });
    expect(run.cacheCreationTokens).toMatchObject({ value: CACHE_CREATE, accuracy: 'EXACT' });
    expect(run.costUsd).toMatchObject({ value: COST, accuracy: 'EXACT' });
    expect(run.turns).toMatchObject({ value: TURNS, accuracy: 'EXACT' });
    expect(run.contextWindow).toMatchObject({ value: CONTEXT_WINDOW, accuracy: 'EXACT' });
    expect(run.model).toMatchObject({ value: MODEL, accuracy: 'EXACT' });
    expect(run.sessionId).toBe(SESSION_ID);

    // Context percent is DERIVED, and planUsage stays UNAVAILABLE.
    expect(run.contextTokensUsed).toMatchObject({ value: CONTEXT_TOKENS, accuracy: 'DERIVED' });
    expect(run.contextPercent.accuracy).toBe('DERIVED');
    expect(run.contextPercent.value).toBeCloseTo(CONTEXT_PERCENT, 9);
    expect(run.planUsage).toMatchObject({ value: PLAN_USAGE_UNAVAILABLE_MESSAGE, accuracy: 'UNAVAILABLE' });
  });
});

/* ========================================================================== */
/*  The whole chain — the declaration derives true                             */
/* ========================================================================== */

describe('USES_REAL_USAGE_TELEMETRY derives true from the observed snapshots', () => {
  it('observeUsageSnapshots reports EXACT fields and the declaration turns true', () => {
    const { event } = runParser();
    const agg = new UsageAggregator({ now: () => T0 + 10, timeZone: 'UTC' });
    agg.ingest(event);

    const observations = observeUsageSnapshots(agg.getSnapshots());

    // At least one snapshot carries EXACT fields Claude Code itself reported.
    const withExact = observations.filter((o) => o.exactFields.length > 0);
    expect(withExact.length).toBeGreaterThan(0);
    const run = observations.find((o) => o.scope === 'run' && o.scopeId === RUN_ID);
    expect(run).toBeDefined();
    expect(run?.exactFields).toEqual(
      expect.arrayContaining(['inputTokens', 'outputTokens', 'contextWindow', 'costUsd', 'turns']),
    );

    const nowMs = T0 + 20;
    const declarations = deriveDeclarations({
      ...emptyDeclarationInputs(nowMs),
      usage: observations,
    });

    const telemetry = declarations.derived.USES_REAL_USAGE_TELEMETRY;
    expect(telemetry.value).toBe(true);
    expect(telemetry.evidence.kind).toBe('TELEMETRY');
    expect(telemetry.evidence.refs.length).toBeGreaterThan(0);
    expect(telemetry.evidence.missing).toHaveLength(0);
  });

  it('with no usage observed the same declaration stays false', () => {
    const declarations = deriveDeclarations(emptyDeclarationInputs(T0 + 20));
    expect(declarations.derived.USES_REAL_USAGE_TELEMETRY.value).toBe(false);
  });
});
