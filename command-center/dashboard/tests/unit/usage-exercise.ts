/**
 * Usage aggregator + latency exercise.
 *
 * Runs directly on Node 24 (`node tests/unit/usage-exercise.ts`) — no build, no
 * test runner, no mocking framework. Every check below runs the real modules
 * against real inputs and compares against a value computed by hand, so a pass
 * here is evidence rather than a green tick from a framework that was asked
 * nicely.
 *
 * Clocks are injected, so staleness and long-session checks are exercised by
 * arithmetic instead of by sleeping.
 */

import type { ForgeEvent, OperationalStatus } from '../../src/shared/protocol.ts';
import {
  UsageAggregator,
  containsPredictiveLanguage,
  contextTokensFrom,
  dayIdFor,
  parseUsageEnvelope,
  resolveTimeZone,
  suggestedActionsAreSafe,
  weakestAccuracy,
} from '../../src/bridge/usage/aggregator.ts';
import { LatencyTracker, percentileOfSorted } from '../../src/bridge/usage/latency.ts';

let passed = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(label: string, actual: unknown, expected: unknown): void {
  check(label, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`);
}

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const SESSION_A = '97c12490-b1f6-47a2-96d4-ab4d05b921ee';
const SESSION_B = '11111111-2222-3333-4444-555555555555';
const MODEL = 'claude-opus-4-8';

interface EnvelopeParts {
  readonly sessionId: string;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheCreate: number;
  readonly cost: number;
  readonly turns: number;
  readonly contextWindow?: number;
}

function envelope(parts: EnvelopeParts): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    session_id: parts.sessionId,
    total_cost_usd: parts.cost,
    num_turns: parts.turns,
    usage: {
      input_tokens: parts.input,
      output_tokens: parts.output,
      cache_read_input_tokens: parts.cacheRead,
      cache_creation_input_tokens: parts.cacheCreate,
    },
    modelUsage: {
      [MODEL]: {
        contextWindow: parts.contextWindow ?? 200_000,
        maxOutputTokens: 64_000,
        costUSD: parts.cost,
      },
    },
  };
}

let eventCounter = 0;

interface EventParts {
  readonly type: string;
  readonly sessionId: string | null;
  readonly atMs: number;
  readonly runId?: string | null;
  readonly conversationId?: string | null;
  readonly projectId?: string;
  readonly agentId?: string | null;
  readonly status?: OperationalStatus;
  readonly payload?: unknown;
  readonly eventId?: string;
}

function makeEvent(parts: EventParts): ForgeEvent {
  eventCounter += 1;
  return {
    eventId: parts.eventId ?? `evt-${eventCounter}`,
    schemaVersion: 1,
    sequence: eventCounter,
    timestamp: new Date(parts.atMs).toISOString(),
    projectId: parts.projectId ?? 'proj-1',
    runId: parts.runId === undefined ? 'run-1' : parts.runId,
    sessionId: parts.sessionId,
    conversationId: parts.conversationId === undefined ? 'conv-1' : parts.conversationId,
    taskId: null,
    agentId: parts.agentId ?? null,
    source: 'claude-code',
    type: parts.type,
    status: parts.status,
    payload: parts.payload ?? {},
    evidenceRefs: [],
    ingestedAt: parts.atMs + 4,
  };
}

const T0 = Date.parse('2026-07-24T10:00:00.000Z');

/* ========================================================================== */
/*  1. Envelope parsing                                                        */
/* ========================================================================== */

{
  const parsed = parseUsageEnvelope(
    envelope({ sessionId: SESSION_A, input: 100, output: 50, cacheRead: 1000, cacheCreate: 200, cost: 0.0456, turns: 3 }),
  );
  check('1.1 envelope parses', parsed.ok);
  eq('1.2 input_tokens EXACT', parsed.inputTokens, 100);
  eq('1.3 output_tokens EXACT', parsed.outputTokens, 50);
  eq('1.4 cache_read_input_tokens EXACT', parsed.cacheReadTokens, 1000);
  eq('1.5 cache_creation_input_tokens EXACT', parsed.cacheCreationTokens, 200);
  eq('1.6 total_cost_usd EXACT', parsed.costUsd, 0.0456);
  eq('1.7 num_turns EXACT', parsed.turns, 3);
  eq('1.8 model from modelUsage key', parsed.model, MODEL);
  eq('1.9 contextWindow from modelUsage', parsed.contextWindow, 200_000);
  eq('1.10 session_id from envelope', parsed.sessionId, SESSION_A);
  eq('1.11 context formula = in+cacheRead+cacheCreate+out', contextTokensFrom(parsed), 1350);

  // A missing cost is null, never 0 — 0 would be a claim that it was free.
  const noCost = parseUsageEnvelope({ session_id: SESSION_A, usage: { input_tokens: 500, output_tokens: 100 } });
  eq('1.12 missing total_cost_usd is null, not 0', noCost.costUsd, null);
  eq('1.13 missing num_turns is null, not 0', noCost.turns, null);
  eq('1.14 present tokens still extracted', noCost.inputTokens, 500);
  check('1.15 missing fields are listed', noCost.missing.includes('total_cost_usd'));

  const junk = parseUsageEnvelope('not an object');
  check('1.16 garbage payload does not throw and is not ok', !junk.ok);
  eq('1.17 garbage payload yields null tokens', junk.inputTokens, null);

  // The wrapper form the adapter is expected to send.
  const wrapped = parseUsageEnvelope({
    envelope: envelope({ sessionId: SESSION_A, input: 7, output: 8, cacheRead: 0, cacheCreate: 0, cost: 0.1, turns: 1 }),
    effort: 'high',
    reporting: 'cumulative',
  });
  eq('1.18 nested envelope is unwrapped', wrapped.inputTokens, 7);
  eq('1.19 effort read from payload', wrapped.effort, 'high');
}

/* ========================================================================== */
/*  2. Accuracy algebra never upgrades                                         */
/* ========================================================================== */

{
  eq('2.1 EXACT+EXACT = EXACT', weakestAccuracy('EXACT', 'EXACT'), 'EXACT');
  eq('2.2 EXACT+DERIVED = DERIVED', weakestAccuracy('EXACT', 'DERIVED'), 'DERIVED');
  eq('2.3 DERIVED+ESTIMATED = ESTIMATED', weakestAccuracy('DERIVED', 'ESTIMATED'), 'ESTIMATED');
  eq('2.4 anything+UNAVAILABLE = UNAVAILABLE', weakestAccuracy('EXACT', 'UNAVAILABLE'), 'UNAVAILABLE');
  eq('2.5 ESTIMATED cannot be upgraded by EXACT', weakestAccuracy('ESTIMATED', 'EXACT'), 'ESTIMATED');
}

/* ========================================================================== */
/*  3. Cumulative readings become deltas (no double counting)                  */
/* ========================================================================== */

{
  let nowMs = T0;
  const agg = new UsageAggregator({ now: () => nowMs, timeZone: 'UTC' });

  agg.ingest(
    makeEvent({
      type: 'claude.usage',
      sessionId: SESSION_A,
      atMs: T0,
      payload: {
        envelope: envelope({ sessionId: SESSION_A, input: 100, output: 50, cacheRead: 0, cacheCreate: 0, cost: 0.01, turns: 1 }),
        effort: 'high',
      },
    }),
  );
  nowMs = T0 + 1000;
  agg.ingest(
    makeEvent({
      type: 'claude.usage',
      sessionId: SESSION_A,
      atMs: T0 + 1000,
      payload: {
        envelope: envelope({ sessionId: SESSION_A, input: 300, output: 120, cacheRead: 0, cacheCreate: 0, cost: 0.03, turns: 2 }),
      },
    }),
  );

  const run = agg.getSnapshot('run', 'run-1');
  const conv = agg.getSnapshot('conversation', 'conv-1');
  check('3.0 run and conversation snapshots exist', run !== null && conv !== null);
  if (run !== null && conv !== null) {
    eq('3.1 run inputTokens = latest cumulative (not 100+300)', run.inputTokens.value, 300);
    eq('3.2 run outputTokens = latest cumulative', run.outputTokens.value, 120);
    eq('3.3 run turns = latest cumulative', run.turns.value, 2);
    check('3.4 run cost = latest cumulative', Math.abs((run.costUsd.value ?? 0) - 0.03) < 1e-9);
    eq('3.5 conversation total telescopes to the same figure', conv.inputTokens.value, 300);

    eq('3.6 run tokens labelled EXACT', run.inputTokens.accuracy, 'EXACT');
    eq('3.7 conversation total labelled DERIVED', conv.inputTokens.accuracy, 'DERIVED');
    eq('3.8 contextTokensUsed labelled DERIVED', run.contextTokensUsed.accuracy, 'DERIVED');
    eq('3.9 contextWindow labelled EXACT', run.contextWindow.value, 200_000);
    eq('3.10 contextWindow accuracy EXACT', run.contextWindow.accuracy, 'EXACT');
    eq('3.11 contextPercent labelled DERIVED', run.contextPercent.accuracy, 'DERIVED');
    check(
      '3.12 contextPercent = 420/200000*100',
      Math.abs((run.contextPercent.value ?? 0) - 0.21) < 1e-9,
      `got ${String(run.contextPercent.value)}`,
    );
    eq('3.13 model is EXACT from modelUsage', run.model.value, MODEL);
    eq('3.14 effort carried from the spawn argument', run.effort.value, 'high');

    // planUsage is always unavailable, with the contract's sentence.
    eq('3.15 planUsage accuracy is UNAVAILABLE', run.planUsage.accuracy, 'UNAVAILABLE');
    eq(
      '3.16 planUsage carries the honest message',
      run.planUsage.value,
      'Plan usage is not exposed by the local Claude Code runtime.',
    );
  }

  // A project spans sessions, so per-session context is not a project property.
  const project = agg.getSnapshot('project', 'proj-1');
  if (project !== null) {
    eq('3.17 project contextPercent is UNAVAILABLE', project.contextPercent.accuracy, 'UNAVAILABLE');
    eq('3.18 project contextPercent value is null', project.contextPercent.value, null);
    eq('3.19 project totals are DERIVED', project.inputTokens.accuracy, 'DERIVED');
    eq('3.20 project total still counts the tokens', project.inputTokens.value, 300);
  }

  // Counters that were never routed here must not report a confident zero.
  if (run !== null) {
    eq('3.21 toolCalls UNAVAILABLE before any tool event', run.toolCalls.accuracy, 'UNAVAILABLE');
    eq('3.22 toolCalls value is null, not 0', run.toolCalls.value, null);
  }

  // Duplicate delivery of the same event must not inflate anything.
  const dupe = makeEvent({
    type: 'claude.usage',
    sessionId: SESSION_A,
    atMs: T0 + 2000,
    eventId: 'dupe-1',
    payload: {
      envelope: envelope({ sessionId: SESSION_A, input: 400, output: 150, cacheRead: 0, cacheCreate: 0, cost: 0.04, turns: 3 }),
    },
  });
  agg.ingest(dupe);
  const afterFirst = agg.getSnapshot('run', 'run-1')?.inputTokens.value;
  const second = agg.ingest(dupe);
  const afterSecond = agg.getSnapshot('run', 'run-1')?.inputTokens.value;
  eq('3.23 replaying an eventId is rejected', second.accepted, false);
  eq('3.24 duplicate rejection reason', second.rejections[0]?.reason, 'DUPLICATE_EVENT');
  eq('3.25 duplicate did not change the total', afterSecond, afterFirst);
}

/* ========================================================================== */
/*  4. Scopes do not bleed across sessions                                     */
/* ========================================================================== */

{
  let nowMs = T0;
  const agg = new UsageAggregator({ now: () => nowMs, timeZone: 'UTC' });

  agg.ingest(
    makeEvent({
      type: 'claude.usage',
      sessionId: SESSION_A,
      atMs: T0,
      payload: {
        envelope: envelope({ sessionId: SESSION_A, input: 1000, output: 100, cacheRead: 0, cacheCreate: 0, cost: 0.1, turns: 1 }),
      },
    }),
  );
  const beforeRun = agg.getSnapshot('run', 'run-1')?.inputTokens.value;

  nowMs = T0 + 500;
  // Same runId, different session. This is exactly the merge that must not happen.
  const foreign = agg.ingest(
    makeEvent({
      type: 'claude.usage',
      sessionId: SESSION_B,
      atMs: T0 + 500,
      payload: {
        envelope: envelope({ sessionId: SESSION_B, input: 9000, output: 900, cacheRead: 0, cacheCreate: 0, cost: 9, turns: 9 }),
      },
    }),
  );

  const afterRun = agg.getSnapshot('run', 'run-1')?.inputTokens.value;
  eq('4.1 run total unchanged by a foreign session', afterRun, beforeRun);
  check(
    '4.2 the mismatch was recorded as a rejection',
    foreign.rejections.some((r) => r.reason === 'SESSION_MISMATCH' && r.scope === 'run'),
  );
  check(
    '4.3 the conversation scope rejected it too',
    foreign.rejections.some((r) => r.reason === 'SESSION_MISMATCH' && r.scope === 'conversation'),
  );

  const sessA = agg.getSnapshot('session', SESSION_A);
  const sessB = agg.getSnapshot('session', SESSION_B);
  eq('4.4 session A total is its own', sessA?.inputTokens.value, 1000);
  eq('4.5 session B total is its own', sessB?.inputTokens.value, 9000);
  eq('4.6 session A sessionId is bound', sessA?.sessionId, SESSION_A);

  const project = agg.getSnapshot('project', 'proj-1');
  eq('4.7 project sums both sessions', project?.inputTokens.value, 10_000);
  eq('4.8 project refuses to name one session for a multi-session total', project?.sessionId, null);

  // An event nobody can attribute is not merged anywhere.
  const orphan = agg.ingest(
    makeEvent({
      type: 'claude.usage',
      sessionId: null,
      atMs: T0 + 600,
      payload: {
        envelope: { usage: { input_tokens: 500, output_tokens: 20 }, total_cost_usd: 1, num_turns: 1 },
      },
    }),
  );
  eq('4.9 an event with no sessionId is rejected', orphan.accepted, false);
  eq('4.10 rejection reason is MISSING_SESSION_ID', orphan.rejections[0]?.reason, 'MISSING_SESSION_ID');
  eq('4.11 project total unaffected by the orphan', agg.getSnapshot('project', 'proj-1')?.inputTokens.value, 10_000);

  const stats = agg.getStats();
  check('4.12 rejections are counted, not silently dropped', stats.rejectionsByReason.SESSION_MISMATCH >= 2);
  check('4.13 rejections are retrievable for audit', agg.getRejections().length >= 3);
}

/* ========================================================================== */
/*  5. A regression drops the accuracy class instead of hiding                 */
/* ========================================================================== */

{
  const nowMs = T0;
  const agg = new UsageAggregator({ now: () => nowMs, timeZone: 'UTC' });
  agg.ingest(
    makeEvent({
      type: 'claude.usage',
      sessionId: SESSION_A,
      atMs: T0,
      runId: 'run-reg',
      payload: {
        envelope: envelope({ sessionId: SESSION_A, input: 500, output: 200, cacheRead: 0, cacheCreate: 0, cost: 0.5, turns: 2 }),
      },
    }),
  );
  const result = agg.ingest(
    makeEvent({
      type: 'claude.usage',
      sessionId: SESSION_A,
      atMs: T0 + 10,
      runId: 'run-reg',
      payload: {
        // The odometer went backwards. Impossible, therefore recorded.
        envelope: envelope({ sessionId: SESSION_A, input: 100, output: 10, cacheRead: 0, cacheCreate: 0, cost: 0.1, turns: 1 }),
      },
    }),
  );
  check('5.1 a backwards reading is recorded as an anomaly', result.anomalies.some((a) => a.kind === 'CUMULATIVE_REGRESSION'));
  eq('5.2 the clamped delta added nothing', agg.getSnapshot('run', 'run-reg')?.inputTokens.value, 500);
  eq('5.3 the run drops from EXACT to DERIVED after a clamp', agg.getSnapshot('run', 'run-reg')?.inputTokens.accuracy, 'DERIVED');
  check('5.4 anomalies are retrievable', agg.getAnomalies().length >= 1);
}

/* ========================================================================== */
/*  6. Counters only report once their source event type has been seen         */
/* ========================================================================== */

{
  const nowMs = T0;
  const agg = new UsageAggregator({ now: () => nowMs, timeZone: 'UTC' });
  agg.ingest(
    makeEvent({
      type: 'claude.usage',
      sessionId: SESSION_A,
      atMs: T0,
      payload: { envelope: envelope({ sessionId: SESSION_A, input: 10, output: 5, cacheRead: 0, cacheCreate: 0, cost: 0.01, turns: 1 }) },
    }),
  );
  eq('6.1 skillUses UNAVAILABLE before any skill event', agg.getSnapshot('run', 'run-1')?.skillUses.accuracy, 'UNAVAILABLE');

  agg.ingest(makeEvent({ type: 'claude.tool.start', sessionId: SESSION_A, atMs: T0 + 1 }));
  agg.ingest(makeEvent({ type: 'claude.tool.start', sessionId: SESSION_A, atMs: T0 + 2 }));
  agg.ingest(makeEvent({ type: 'skill.used', sessionId: SESSION_A, atMs: T0 + 3 }));
  agg.ingest(makeEvent({ type: 'agent.activated', sessionId: SESSION_A, atMs: T0 + 4, agentId: 'boss-1' }));
  agg.ingest(makeEvent({ type: 'agent.activated', sessionId: SESSION_A, atMs: T0 + 5, agentId: 'boss-1' }));
  agg.ingest(makeEvent({ type: 'agent.activated', sessionId: SESSION_A, atMs: T0 + 6, agentId: 'boss-2' }));
  agg.ingest(makeEvent({ type: 'run.error', sessionId: SESSION_A, atMs: T0 + 7 }));
  agg.ingest(makeEvent({ type: 'run.state', sessionId: SESSION_A, atMs: T0 + 8, status: 'RETRYING' }));
  agg.ingest(makeEvent({ type: 'run.state', sessionId: SESSION_A, atMs: T0 + 9, status: 'RUNNING' }));

  const snap = agg.getSnapshot('run', 'run-1');
  eq('6.2 toolCalls counted', snap?.toolCalls.value, 2);
  eq('6.3 toolCalls now DERIVED', snap?.toolCalls.accuracy, 'DERIVED');
  eq('6.4 skillUses counted', snap?.skillUses.value, 1);
  eq('6.5 agentCount is distinct agents, not activations', snap?.agentCount.value, 2);
  eq('6.6 errors counted', snap?.errors.value, 1);
  eq('6.7 only RETRYING counts as a retry', snap?.retries.value, 1);

  // An event type this module has no business with is ignored, not rejected.
  const ignored = agg.ingest(makeEvent({ type: 'bridge.heartbeat', sessionId: SESSION_A, atMs: T0 + 10 }));
  eq('6.8 unrelated event types are ignored', ignored.accepted, false);
  eq('6.9 ignoring is not a rejection', ignored.rejections.length, 0);
  check('6.10 ignored events are counted', agg.getStats().eventsIgnored >= 1);
}

/* ========================================================================== */
/*  7. Staleness marks, it never resets                                        */
/* ========================================================================== */

{
  let nowMs = T0;
  const agg = new UsageAggregator({ now: () => nowMs, stalenessThresholdMs: 30_000, timeZone: 'UTC' });
  agg.ingest(
    makeEvent({
      type: 'claude.usage',
      sessionId: SESSION_A,
      atMs: T0,
      payload: { envelope: envelope({ sessionId: SESSION_A, input: 777, output: 88, cacheRead: 0, cacheCreate: 0, cost: 0.7, turns: 4 }) },
    }),
  );
  eq('7.1 fresh telemetry is not stale', agg.getSnapshot('session', SESSION_A)?.stale, false);

  nowMs = T0 + 45_000;
  const stale = agg.getSnapshot('session', SESSION_A);
  eq('7.2 silence past the threshold marks stale', stale?.stale, true);
  eq('7.3 going stale did NOT reset tokens', stale?.inputTokens.value, 777);
  eq('7.4 going stale did NOT reset turns', stale?.turns.value, 4);

  // A reconnect is not a reset either.
  agg.markBridgeDisconnected('socket closed');
  eq('7.5 disconnect is reported', agg.isConnected(), false);
  eq('7.6 totals survive a disconnect', agg.getSnapshot('session', SESSION_A)?.inputTokens.value, 777);
  check('7.7 a disconnect alert is active', agg.getActiveAlerts().some((a) => a.kind === 'BRIDGE_DISCONNECTED'));
  agg.markBridgeConnected();
  eq('7.8 reconnect clears the alert', agg.getActiveAlerts().filter((a) => a.kind === 'BRIDGE_DISCONNECTED').length, 0);
  eq('7.9 totals survive the reconnect', agg.getSnapshot('session', SESSION_A)?.inputTokens.value, 777);
  eq('7.10 a scope with no telemetry at all is stale, not fresh-at-zero', agg.getSnapshot('run', 'nope'), null);
}

/* ========================================================================== */
/*  8. Rebuild from the persisted log                                          */
/* ========================================================================== */

{
  const nowMs = T0;
  const log: ForgeEvent[] = [];
  for (let i = 0; i < 5; i += 1) {
    log.push(
      makeEvent({
        type: 'claude.usage',
        sessionId: SESSION_A,
        atMs: T0 + i * 1000,
        payload: {
          envelope: envelope({
            sessionId: SESSION_A,
            input: 1000 * (i + 1),
            output: 100 * (i + 1),
            cacheRead: 0,
            cacheCreate: 0,
            cost: 0.01 * (i + 1),
            turns: i + 1,
          }),
        },
      }),
    );
  }
  log.push(makeEvent({ type: 'claude.tool.start', sessionId: SESSION_A, atMs: T0 + 6000 }));

  const live = new UsageAggregator({ now: () => nowMs, timeZone: 'UTC' });
  live.ingestAll(log);
  const liveTotal = live.getSnapshot('conversation', 'conv-1')?.inputTokens.value;
  const liveTools = live.getSnapshot('conversation', 'conv-1')?.toolCalls.value;

  // The browser refreshed. Memory is gone; the log is not.
  const rebuilt = new UsageAggregator({ now: () => nowMs, timeZone: 'UTC' });
  const report = rebuilt.rebuildFrom(log);
  const rebuiltTotal = rebuilt.getSnapshot('conversation', 'conv-1')?.inputTokens.value;

  eq('8.1 rebuild ingested every event', report.ingested, log.length);
  eq('8.2 conversation total survives a refresh', rebuiltTotal, liveTotal);
  eq('8.3 the total is the latest cumulative, not the sum of readings', rebuiltTotal, 5000);
  eq('8.4 counters survive a refresh', rebuilt.getSnapshot('conversation', 'conv-1')?.toolCalls.value, liveTools);

  // Rebuilding twice from the same log must not double anything.
  rebuilt.rebuildFrom(log);
  eq('8.5 rebuilding is idempotent', rebuilt.getSnapshot('conversation', 'conv-1')?.inputTokens.value, 5000);

  // Replaying the log into an already-populated aggregator is caught by dedup.
  const replayed = live.ingestAll(log);
  eq('8.6 a full replay is rejected as duplicates', replayed.every((r) => !r.accepted), true);
  eq('8.7 the replay changed nothing', live.getSnapshot('conversation', 'conv-1')?.inputTokens.value, 5000);
}

/* ========================================================================== */
/*  9. Alerts state measured conditions only                                   */
/* ========================================================================== */

{
  let nowMs = T0;
  const agg = new UsageAggregator({ now: () => nowMs, timeZone: 'UTC', stalenessThresholdMs: 30_000 });
  const heard: string[] = [];
  const off = agg.onAlert((alert) => heard.push(alert.kind));

  const contextSteps = [150_000, 175_000, 195_000];
  contextSteps.forEach((input, i) => {
    nowMs = T0 + i * 1000;
    agg.ingest(
      makeEvent({
        type: 'claude.usage',
        sessionId: SESSION_A,
        atMs: nowMs,
        runId: 'run-ctx',
        conversationId: 'conv-ctx',
        payload: {
          envelope: envelope({ sessionId: SESSION_A, input, output: 0, cacheRead: 0, cacheCreate: 0, cost: 0.5, turns: i + 1 }),
        },
      }),
    );
  });

  const contextAlerts = agg.getAlertHistory().filter((a) => a.kind === 'CONTEXT_THRESHOLD');
  const thresholds = contextAlerts.map((a) => a.condition.threshold).sort((a, b) => a - b);
  check('9.1 70/85/95 thresholds each fired once', JSON.stringify(thresholds) === JSON.stringify([70, 85, 95]), JSON.stringify(thresholds));
  check('9.2 each alert carries the measured value', contextAlerts.every((a) => a.condition.observedValue > 0));
  check('9.3 each alert carries its accuracy', contextAlerts.every((a) => a.condition.accuracy === 'DERIVED'));
  check('9.4 severity escalates at 95%', contextAlerts.some((a) => a.condition.threshold === 95 && a.severity === 'CRITICAL'));
  check('9.5 alerts reached the listener', heard.filter((k) => k === 'CONTEXT_THRESHOLD').length >= 3);
  off();

  // No alert may read like a forecast.
  const allAlerts = agg.getAlertHistory();
  const predictive = allAlerts.map((a) => containsPredictiveLanguage(a.message)).filter((m) => m !== null);
  eq('9.6 no alert message contains predictive language', predictive.length, 0);
  check(
    '9.7 every alert offers safe actions',
    allAlerts.every((a) => a.suggestedActions.length > 0 && a.suggestedActions.every((s) => s.discardsConversationState === false)),
  );

  // Stale process.
  nowMs = T0 + 120_000;
  const ticked = agg.tick();
  check('9.8 a stalled process raises PROCESS_STALE', ticked.some((a) => a.kind === 'PROCESS_STALE'));
  const staleAlert = ticked.find((a) => a.kind === 'PROCESS_STALE');
  check('9.9 stale alert states the measured silence', (staleAlert?.condition.observedValue ?? 0) > 30_000);
  eq('9.10 stale alert does not claim exhaustion', containsPredictiveLanguage(staleAlert?.message ?? ''), null);

  // Firing is once-per-condition, not once-per-tick.
  const before = agg.getAlertHistory().length;
  agg.tick();
  eq('9.11 alerts do not re-fire while the condition holds', agg.getAlertHistory().length, before);
}

/* ========================================================================== */
/*  10. Compaction: explicit is DERIVED, heuristic is ESTIMATED                */
/* ========================================================================== */

{
  const nowMs = T0;
  const agg = new UsageAggregator({ now: () => nowMs, timeZone: 'UTC', compactionAlertCount: 1 });
  agg.ingest(
    makeEvent({
      type: 'claude.usage',
      sessionId: SESSION_A,
      atMs: T0,
      runId: 'run-c',
      conversationId: 'conv-c',
      payload: { envelope: envelope({ sessionId: SESSION_A, input: 190_000, output: 0, cacheRead: 0, cacheCreate: 0, cost: 1, turns: 5 }) },
    }),
  );
  agg.ingest(
    makeEvent({
      type: 'claude.usage',
      sessionId: SESSION_A,
      atMs: T0 + 1000,
      runId: 'run-c',
      conversationId: 'conv-c',
      // Context collapsed while turns went up: the signature of a compaction.
      payload: { envelope: envelope({ sessionId: SESSION_A, input: 40_000, output: 0, cacheRead: 0, cacheCreate: 0, cost: 1.1, turns: 6 }) },
    }),
  );
  const snap = agg.getSnapshot('conversation', 'conv-c');
  eq('10.1 the drop was counted as a probable compaction', snap?.compactions.value, 1);
  eq('10.2 a heuristic count is labelled ESTIMATED', snap?.compactions.accuracy, 'ESTIMATED');
  check('10.3 the estimator is named in the source', (snap?.compactions.source ?? '').includes('heuristic'));
  const compactionAlert = agg.getAlertHistory().find((a) => a.kind === 'REPEATED_COMPACTION');
  check('10.4 a compaction alert fired', compactionAlert !== undefined);
  check('10.5 the alert admits it is heuristic', (compactionAlert?.message ?? '').includes('heuristic'));
  eq('10.6 the alert condition inherits ESTIMATED', compactionAlert?.condition.accuracy, 'ESTIMATED');

  // With fewer than two envelopes and no explicit report, we cannot say.
  const fresh = new UsageAggregator({ now: () => nowMs, timeZone: 'UTC' });
  fresh.ingest(
    makeEvent({
      type: 'claude.usage',
      sessionId: SESSION_A,
      atMs: T0,
      runId: 'run-d',
      conversationId: 'conv-d',
      payload: { envelope: envelope({ sessionId: SESSION_A, input: 10, output: 1, cacheRead: 0, cacheCreate: 0, cost: 0.01, turns: 1 }) },
    }),
  );
  eq('10.7 one envelope is not enough to claim zero compactions', fresh.getSnapshot('conversation', 'conv-d')?.compactions.accuracy, 'UNAVAILABLE');
}

/* ========================================================================== */
/*  11. Suggested actions are safe by construction                             */
/* ========================================================================== */

{
  const verdict = suggestedActionsAreSafe();
  check('11.1 no suggested action is destructive', verdict.safe, verdict.violations.join('; '));
  eq('11.2 predictive language detector catches a forecast', containsPredictiveLanguage('Context will run out soon') !== null, true);
  eq('11.3 detector catches "at this rate"', containsPredictiveLanguage('At this rate the window fills') !== null, true);
  eq('11.4 detector allows a plain measurement', containsPredictiveLanguage('Context is at 85.0% of the 200000-token window.'), null);
  eq('11.5 detector does not trip on the word "project"', containsPredictiveLanguage('Totals for this project scope.'), null);
}

/* ========================================================================== */
/*  12. Latency is measured, never asserted                                    */
/* ========================================================================== */

{
  const tracker = new LatencyTracker({ windowSize: 128, now: () => T0 });

  const empty = tracker.getLatencyReport();
  eq('12.1 an unmeasured channel says so', empty.channels.ingestion.measured, false);
  eq('12.2 an unmeasured p95 is null, not 0', empty.channels.ingestion.p95Ms, null);
  eq('12.3 an unmeasured target verdict is null, not true', empty.channels.ingestion.meetsP95Target, null);
  eq('12.4 ui-update is not measured by the bridge', empty.channels['ui-update'].measured, false);
  eq('12.5 targets are recorded as targets', empty.channels.ingestion.targetP95Ms, 25);

  for (let i = 1; i <= 100; i += 1) tracker.recordSample('ingestion', i, 'same-process');
  const stat = tracker.stat('ingestion');
  eq('12.6 sample count is real', stat.sampleCount, 100);
  eq('12.7 nearest-rank p50 over 1..100', stat.p50Ms, 50);
  eq('12.8 nearest-rank p95 over 1..100', stat.p95Ms, 95);
  eq('12.9 nearest-rank p99 over 1..100', stat.p99Ms, 99);
  eq('12.10 min', stat.minMs, 1);
  eq('12.11 max', stat.maxMs, 100);
  eq('12.12 mean', stat.meanMs, 50.5);
  eq('12.13 single-clock samples are labelled same-process', stat.clockBasis, 'same-process');
  eq('12.14 p95 of 95ms does not meet a 25ms target', stat.meetsP95Target, false);

  eq('12.15 percentile helper agrees', percentileOfSorted([1, 2, 3, 4], 50), 2);
  eq('12.16 percentile of nothing is null', percentileOfSorted([], 95), null);

  // Skew must be rejected, not clamped into a perfect zero.
  const skewed = new LatencyTracker({ now: () => T0 });
  const neg = skewed.recordIngestion(T0 + 5_000, T0);
  eq('12.17 a negative delta is rejected', neg.accepted, false);
  check('12.18 rejection reason is skew, not speed', !neg.accepted && neg.reason === 'negative-delta');
  eq('12.19 the rejected sample is not counted as 0ms', skewed.stat('ingestion').measured, false);
  eq('12.20 rejections are visible', skewed.stat('ingestion').rejectionsByReason['negative-delta'], 1);

  const huge = skewed.recordIngestion(T0 - 10 * 60_000, T0);
  check('12.21 an implausible delta is rejected', !huge.accepted && huge.reason === 'implausible-delta');

  // A two-clock measurement is honestly flagged as an approximation.
  const cross = new LatencyTracker({ now: () => T0 });
  cross.recordIngestion(T0 - 12, T0, 'cross-process');
  eq('12.22 cross-process basis is reported', cross.stat('ingestion').clockBasis, 'cross-process');
  check('12.23 the note explains the two clocks', (cross.stat('ingestion').note ?? '').includes('two-clock'));

  // Delivery is a round trip on one clock.
  const del = new LatencyTracker({ now: () => T0 });
  del.beginDelivery('frame-1', 1_000);
  const done = del.completeDelivery('frame-1', 1_030);
  check('12.24 delivery sample recorded', done.accepted && done.valueMs === 30);
  const unknown = del.completeDelivery('never-sent');
  check('12.25 an ack for an unknown frame is rejected', !unknown.accepted && unknown.reason === 'unknown-token');
  check('12.26 delivery is documented as an upper bound', (del.stat('delivery').note ?? '').includes('upper bound'));

  // An event's own fields drive the ingestion measurement.
  const fromEvent = new LatencyTracker({ now: () => T0 });
  fromEvent.recordIngestionFromEvent(makeEvent({ type: 'claude.usage', sessionId: SESSION_A, atMs: T0 }));
  eq('12.27 ingestedAt - timestamp is the sample', fromEvent.stat('ingestion').p50Ms, 4);
  eq('12.28 a claude-code event is two clocks', fromEvent.stat('ingestion').clockBasis, 'cross-process');
}

/* ========================================================================== */
/*  13. Latency accuracy flows into the snapshot                               */
/* ========================================================================== */

{
  const nowMs = T0;
  const tracker = new LatencyTracker({ now: () => nowMs });
  const agg = new UsageAggregator({ now: () => nowMs, latency: tracker, timeZone: 'UTC' });
  agg.ingest(
    makeEvent({
      type: 'claude.usage',
      sessionId: SESSION_A,
      atMs: T0,
      payload: { envelope: envelope({ sessionId: SESSION_A, input: 10, output: 1, cacheRead: 0, cacheCreate: 0, cost: 0.01, turns: 1 }) },
    }),
  );
  const snap = agg.getSnapshot('run', 'run-1');
  eq('13.1 latency p95 is surfaced', snap?.eventLatencyP95.value, 4);
  eq('13.2 a two-clock percentile degrades to ESTIMATED', snap?.eventLatencyP95.accuracy, 'ESTIMATED');

  const clean = new LatencyTracker({ now: () => nowMs });
  clean.recordSample('ingestion', 3, 'same-process');
  const agg2 = new UsageAggregator({ now: () => nowMs, latency: clean, measureIngestion: false, timeZone: 'UTC' });
  agg2.ingest(
    makeEvent({
      type: 'claude.usage',
      sessionId: SESSION_A,
      atMs: T0,
      payload: { envelope: envelope({ sessionId: SESSION_A, input: 10, output: 1, cacheRead: 0, cacheCreate: 0, cost: 0.01, turns: 1 }) },
    }),
  );
  eq('13.3 a single-clock percentile is DERIVED', agg2.getSnapshot('run', 'run-1')?.eventLatencyP95.accuracy, 'DERIVED');

  const noSamples = new UsageAggregator({ now: () => nowMs, latency: new LatencyTracker({ now: () => nowMs }), measureIngestion: false, timeZone: 'UTC' });
  noSamples.ingest(
    makeEvent({
      type: 'claude.usage',
      sessionId: SESSION_A,
      atMs: T0,
      payload: { envelope: envelope({ sessionId: SESSION_A, input: 10, output: 1, cacheRead: 0, cacheCreate: 0, cost: 0.01, turns: 1 }) },
    }),
  );
  eq('13.4 no samples means UNAVAILABLE, not 0ms', noSamples.getSnapshot('run', 'run-1')?.eventLatencyP95.accuracy, 'UNAVAILABLE');
  eq('13.5 and the value is null', noSamples.getSnapshot('run', 'run-1')?.eventLatencyP95.value, null);
}

/* ========================================================================== */
/*  14. Day bucketing resolves the zone at runtime                             */
/* ========================================================================== */

{
  eq('14.1 UTC day id', dayIdFor(Date.parse('2026-07-24T23:30:00.000Z'), 'UTC'), '2026-07-24');
  eq('14.2 a zone east of UTC rolls over', dayIdFor(Date.parse('2026-07-24T23:30:00.000Z'), 'Europe/Amsterdam'), '2026-07-25');
  check('14.3 the host zone is resolved, not hardcoded', resolveTimeZone().length > 0);
  eq('14.4 an explicit zone wins', resolveTimeZone('UTC'), 'UTC');
  eq('14.5 a nonsense zone falls back to UTC rather than throwing', dayIdFor(Date.parse('2026-07-24T23:30:00.000Z'), 'Not/AZone'), '2026-07-24');

  const nowMs = Date.parse('2026-07-24T23:30:00.000Z');
  const agg = new UsageAggregator({ now: () => nowMs, timeZone: 'UTC' });
  agg.ingest(
    makeEvent({
      type: 'claude.usage',
      sessionId: SESSION_A,
      atMs: nowMs,
      payload: { envelope: envelope({ sessionId: SESSION_A, input: 42, output: 1, cacheRead: 0, cacheCreate: 0, cost: 0.01, turns: 1 }) },
    }),
  );
  eq('14.6 the day scope exists under the resolved zone', agg.getSnapshot('day', '2026-07-24')?.inputTokens.value, 42);
  eq('14.7 the day scope reports the zone in stats', agg.getStats().timeZone, 'UTC');
}

/* -------------------------------------------------------------------------- */

if (failures.length === 0) {
  process.stdout.write(`usage-exercise: ${passed}/${passed} checks passed\n`);
} else {
  process.stdout.write(`usage-exercise: ${passed} passed, ${failures.length} FAILED\n`);
  for (const failure of failures) process.stdout.write(`  FAIL ${failure}\n`);
  process.exitCode = 1;
}
