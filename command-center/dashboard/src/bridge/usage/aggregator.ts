/**
 * Forge Workspace — usage telemetry aggregator.
 *
 * This is the layer that stands between "Claude Code said something" and "the
 * usage bar shows a number". Its entire job is to make sure the second one is
 * still true after the first one has been through five kinds of arithmetic.
 *
 * ── WHAT A NUMBER IS ALLOWED TO CLAIM ─────────────────────────────────────
 *
 * Every scalar leaves here as a `UsageField` carrying an `Accuracy`:
 *
 *   EXACT        lifted straight out of the CLI result envelope — input_tokens,
 *                output_tokens, cache_read_input_tokens,
 *                cache_creation_input_tokens, total_cost_usd, num_turns,
 *                modelUsage[model].contextWindow.
 *   DERIVED      arithmetic over EXACT values and nothing else.
 *   ESTIMATED    we approximated it here, and `source` names the estimator.
 *   UNAVAILABLE  2.1.217 does not expose it, or we never observed it. The value
 *                is null. `planUsage` is ALWAYS this.
 *
 * Accuracy only ever goes downhill. `weakestAccuracy()` is the one place that
 * combines classes, and a DERIVED value computed from anything ESTIMATED comes
 * out ESTIMATED. There is no path in this file that upgrades a class, and
 * `usageField()` forces UNAVAILABLE whenever the value is null — so an "EXACT
 * null" cannot be constructed even by mistake.
 *
 * ── WHY DELTAS ───────────────────────────────────────────────────────────
 *
 * A `claude -p` result envelope reports the totals for its own call. Two
 * envelopes from the same run are therefore two readings of one odometer, not
 * two trips. Adding them would double-count. So each envelope is converted to a
 * DELTA against the last reading for that same run, once, at ingest — and the
 * delta is what every scope accumulates. For a run scope the deltas telescope
 * back to the envelope's own figure, which is why a run may claim EXACT while a
 * conversation total claims DERIVED. If a reading ever goes backwards the delta
 * is clamped at zero, the regression is recorded as an anomaly, and that scope
 * permanently drops from EXACT to DERIVED — because after a clamp the total is
 * no longer identical to anything Claude Code said.
 *
 * ── WHY SCOPES DO NOT BLEED ──────────────────────────────────────────────
 *
 * run, conversation and session are SINGLE-SESSION scopes: the first session id
 * they see binds them, and an event carrying a different one is rejected and
 * recorded — never merged. project and day are MULTI-SESSION by nature; they
 * keep the set of sessions that contributed, and their `sessionId` is null the
 * moment more than one did, because naming one session for a total built from
 * several would be a lie. An event with no session id at all cannot be
 * attributed to anything and is rejected too.
 *
 * A project total is a sum over the sessions this bridge observed. It is not an
 * account balance, a plan quota, or a claim about usage elsewhere.
 *
 * ── WHY A ZERO IS NOT ALWAYS HONEST ──────────────────────────────────────
 *
 * `toolCalls: 0` is only true if tool events actually reach this aggregator. If
 * the bridge never routes `claude.tool.start` here, the truthful answer is
 * UNAVAILABLE, not zero. So each derived counter is gated on having observed at
 * least one event of its source type; before that it reports UNAVAILABLE and
 * says why.
 *
 * ── WHAT ALERTS MAY SAY ──────────────────────────────────────────────────
 *
 * An alert states a condition that was measured. It never says when anything
 * will run out — that would be a forecast dressed as telemetry, and the context
 * cost of the next turn is not knowable from here. `containsPredictiveLanguage()`
 * enforces this at construction: an alert whose message reads like a prediction
 * throws instead of being emitted. Every suggested action is drawn from a fixed
 * table, is a real `OperationName` from the contract, and is marked
 * non-destructive; nothing here ever discards conversation state.
 */

import type {
  Accuracy,
  ForgeEvent,
  OperationName,
  UsageField,
  UsageSnapshot,
} from '../../shared/protocol.ts';
import { PLAN_USAGE_UNAVAILABLE_MESSAGE } from '../../shared/protocol.ts';
import type { LatencyStat } from './latency.ts';
import { LatencyTracker } from './latency.ts';

/* ========================================================================== */
/*  Vocabulary                                                                 */
/* ========================================================================== */

export type UsageScope = UsageSnapshot['scope'];

export const USAGE_SCOPES: readonly UsageScope[] = ['run', 'conversation', 'project', 'day', 'session'];

/**
 * single-session  bound to one session id; a foreign event is rejected.
 * multi-session   spans sessions by definition; contributors are tracked and
 *                 the snapshot refuses to name one of them as "the" session.
 */
export type ScopeBindingPolicy = 'single-session' | 'multi-session';

export const SCOPE_BINDING: Readonly<Record<UsageScope, ScopeBindingPolicy>> = {
  run: 'single-session',
  conversation: 'single-session',
  session: 'single-session',
  project: 'multi-session',
  day: 'multi-session',
};

export interface ScopeRef {
  readonly scope: UsageScope;
  readonly scopeId: string;
}

export type RejectionReason =
  | 'MISSING_SESSION_ID'
  | 'SESSION_MISMATCH'
  | 'DUPLICATE_EVENT'
  | 'UNPARSEABLE_PAYLOAD'
  | 'NO_USABLE_FIELDS'
  | 'SCHEMA_VERSION_MISMATCH'
  | 'BAD_TIMESTAMP'
  | 'SCOPE_LIMIT_REACHED';

export interface UsageRejection {
  readonly at: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly reason: RejectionReason;
  readonly detail: string;
  readonly scope: UsageScope | null;
  readonly scopeId: string | null;
  readonly eventSessionId: string | null;
  readonly scopeSessionId: string | null;
}

export type UsageAnomalyKind =
  | 'CUMULATIVE_REGRESSION'
  | 'CONTEXT_OVER_WINDOW'
  | 'NEGATIVE_VALUE'
  | 'CONTEXT_DROP';

export interface UsageAnomaly {
  readonly at: string;
  readonly kind: UsageAnomalyKind;
  readonly eventId: string;
  readonly detail: string;
  readonly scope: UsageScope | null;
  readonly scopeId: string | null;
}

/* ========================================================================== */
/*  Accuracy algebra                                                           */
/* ========================================================================== */

const ACCURACY_RANK: Readonly<Record<Accuracy, number>> = {
  EXACT: 0,
  DERIVED: 1,
  ESTIMATED: 2,
  UNAVAILABLE: 3,
};

/**
 * The only way accuracy classes are ever combined. Returns the weakest input,
 * which is what makes "a DERIVED value computed from anything ESTIMATED is
 * ESTIMATED" a property of the code rather than a promise in a comment.
 */
export function weakestAccuracy(...accuracies: readonly Accuracy[]): Accuracy {
  let worst: Accuracy = 'EXACT';
  for (const accuracy of accuracies) {
    if (ACCURACY_RANK[accuracy] > ACCURACY_RANK[worst]) worst = accuracy;
  }
  return worst;
}

/**
 * Builds a field. A null value is UNAVAILABLE no matter what the caller asked
 * for: a number we do not have cannot be exact.
 */
export function usageField<T>(
  name: string,
  value: T | null,
  unit: UsageField['unit'],
  source: string,
  accuracy: Accuracy,
  updatedAt: string,
): UsageField<T> {
  return {
    name,
    value: value === null || value === undefined ? null : value,
    unit,
    source,
    accuracy: value === null || value === undefined ? 'UNAVAILABLE' : accuracy,
    updatedAt,
  };
}

/** A field we genuinely do not have. `source` must say why, not just that. */
export function unavailableField<T>(
  name: string,
  unit: UsageField['unit'],
  reason: string,
  updatedAt: string,
): UsageField<T> {
  return { name, value: null, unit, source: reason, accuracy: 'UNAVAILABLE', updatedAt };
}

/* ========================================================================== */
/*  Provenance strings — auditable, not decorative                             */
/* ========================================================================== */

const SRC = {
  envelope: (field: string) => `claude-code:result-envelope.${field}`,
  envelopeSum: (fields: readonly string[]) =>
    `derived:sum-of-per-run-deltas(claude-code:result-envelope.${fields.join('+')})`,
  contextFormula:
    'derived:input_tokens+cache_read_input_tokens+cache_creation_input_tokens+output_tokens ' +
    'of the most recent result envelope in scope',
  contextWindow: 'claude-code:result-envelope.modelUsage[model].contextWindow',
  contextPercent: 'derived:contextTokensUsed / contextWindow * 100',
  cost:
    'claude-code:result-envelope.total_cost_usd — model-priced equivalent; on a subscription ' +
    'plan this is not an amount billed',
  effort: 'bridge:spawn-argv[--effort] recorded at process start',
  counter: (eventType: string) => `derived:count of observed ${eventType} events`,
  distinct: (eventType: string, field: string) => `derived:distinct ${field} across observed ${eventType} events`,
  elapsed: 'derived:last observed event timestamp − first observed event timestamp',
  planUsage: 'claude-code:2.1.217 exposes no plan/quota field',
  compactionExplicit: 'derived:count of compaction flags reported on claude.usage payloads',
  compactionHeuristic: (ratio: number) =>
    `estimated:context-drop heuristic — contextTokensUsed fell below ${ratio}x the previous reading ` +
    'while turns increased; the runtime does not report compaction directly',
  notObserved: (eventType: string) =>
    `unavailable:no ${eventType} event has been routed to the aggregator, so a count would be a guess`,
  perSessionOnly:
    'unavailable:context occupancy is a per-session property; this scope spans multiple sessions',
  latency: (stat: LatencyStat) =>
    `derived:p95 (${stat.method}) over ${stat.sampleCount} ingestion sample(s), clockBasis=${stat.clockBasis}`,
} as const;

/* ========================================================================== */
/*  The CLI result envelope                                                    */
/* ========================================================================== */

/**
 * How a usage number relates to the previous one from the same run.
 *
 * cumulative   a fresh reading of a running total (what `claude -p` returns).
 * incremental  already a delta; added as-is.
 */
export type UsageReporting = 'cumulative' | 'incremental';

/**
 * The payload a `claude.usage` event may carry. Three shapes are accepted,
 * because being strict about the wrapper would throw away real telemetry:
 *
 *   1. `{ snapshot, final }` — what `ClaudeStreamParser` actually emits and what
 *      the adapter persists. `snapshot` is a fully-built `UsageSnapshot` whose
 *      scalars are labelled `UsageField`s; the read path renders this same shape.
 *      This is the shape the aggregator now lifts EXACT scalars out of, so one
 *      shape flows from the CLI stream to both the screen and the totals.
 *   2. `{ envelope: <raw CLI result envelope> }` — the raw result line wrapped.
 *   3. the raw CLI result envelope inlined at the top level.
 */
export interface UsageEventPayload {
  /** The parser's built snapshot. Preferred when present (shape 1). */
  readonly snapshot?: unknown;
  /** False for interim snapshots emitted mid-turn from `message_delta`. */
  readonly final?: boolean;
  readonly envelope?: unknown;
  readonly reporting?: UsageReporting;
  /** The literal `--effort` argument the bridge passed at spawn. */
  readonly effort?: string;
  /** Set by the adapter when the runtime reports a context compaction. */
  readonly compaction?: boolean;
}

export interface ParsedEnvelope {
  /** True when at least one usable number was found. */
  readonly ok: boolean;
  readonly sessionId: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheCreationTokens: number | null;
  readonly costUsd: number | null;
  readonly turns: number | null;
  readonly model: string | null;
  readonly models: readonly string[];
  readonly contextWindow: number | null;
  readonly maxOutputTokens: number | null;
  readonly effort: string | null;
  readonly reporting: UsageReporting;
  readonly compaction: boolean;
  /** Envelope fields that were absent or unusable. Never filled with zeros. */
  readonly missing: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Finite, non-negative, or null. A negative token count is not a measurement. */
function nonNegativeNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return value;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Read a `UsageField` scalar, but ONLY when the emitter marked it EXACT.
 *
 * The parser lifts a field straight from the CLI result envelope and labels it
 * EXACT; every other scalar on a snapshot is DERIVED, ESTIMATED or UNAVAILABLE
 * and was NOT taken verbatim from Claude Code. Because a run scope telescopes its
 * per-envelope deltas back to an EXACT total, feeding a DERIVED number in here
 * would launder a computed value into a reported one. So the snapshot path lifts
 * EXACT scalars and treats every other accuracy exactly as the raw path treats an
 * absent field: as null.
 */
function exactFieldNumber(field: unknown): number | null {
  if (!isRecord(field) || field.accuracy !== 'EXACT') return null;
  return nonNegativeNumber(field.value);
}

function exactFieldString(field: unknown): string | null {
  if (!isRecord(field) || field.accuracy !== 'EXACT') return null;
  return nonEmptyString(field.value);
}

/**
 * True when a payload's `snapshot` is a built `UsageSnapshot` rather than a raw
 * envelope: its scalar slots are `UsageField`s carrying an `accuracy` label. A
 * raw result envelope nests its numbers under `usage`, never under a UsageField
 * wrapper, so the two shapes cannot be confused.
 */
function looksLikeUsageSnapshot(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const field = value.inputTokens;
  return isRecord(field) && typeof field.accuracy === 'string';
}

/**
 * Read the `{ snapshot, final }` payload the `ClaudeStreamParser` emits.
 *
 * It lifts the snapshot scalars the parser marked EXACT — the four token counts,
 * cost, turns and the model's context window — which are exactly the fields it
 * took verbatim from the CLI result envelope, so provenance is preserved and the
 * number is read once, not duplicated. Context occupancy is re-derived downstream
 * from those tokens (`contextTokensFrom`), so it is deliberately not lifted here.
 * The `missing` strings mirror the raw path so a downstream rejection reads the
 * same whichever shape arrived.
 */
function parseSnapshotShape(outer: Record<string, unknown>, snapshot: Record<string, unknown>): ParsedEnvelope {
  const missing: string[] = [];

  const inputTokens = exactFieldNumber(snapshot.inputTokens);
  const outputTokens = exactFieldNumber(snapshot.outputTokens);
  const cacheReadTokens = exactFieldNumber(snapshot.cacheReadTokens);
  const cacheCreationTokens = exactFieldNumber(snapshot.cacheCreationTokens);
  if (inputTokens === null) missing.push('usage.input_tokens');
  if (outputTokens === null) missing.push('usage.output_tokens');
  if (cacheReadTokens === null) missing.push('usage.cache_read_input_tokens');
  if (cacheCreationTokens === null) missing.push('usage.cache_creation_input_tokens');

  const costUsd = exactFieldNumber(snapshot.costUsd);
  if (costUsd === null) missing.push('total_cost_usd');

  const turns = exactFieldNumber(snapshot.turns);
  if (turns === null) missing.push('num_turns');

  const sessionId = nonEmptyString(snapshot.sessionId);
  if (sessionId === null) missing.push('session_id');

  const model = exactFieldString(snapshot.model);
  const models: readonly string[] = model !== null ? [model] : [];
  if (model === null) missing.push('model');

  const contextWindow = exactFieldNumber(snapshot.contextWindow);
  if (contextWindow === null) missing.push('modelUsage[model].contextWindow');

  const reportingRaw = nonEmptyString(outer.reporting);
  const reporting: UsageReporting = reportingRaw === 'incremental' ? 'incremental' : 'cumulative';

  // Effort is a spawn-time argument, not a snapshot field the parser fills, so it
  // comes off the wrapper. The EXACT-gated read of snapshot.effort is here only so
  // an emitter that ever reports it exactly is honoured; today it is UNAVAILABLE.
  const effort = nonEmptyString(outer.effort) ?? exactFieldString(snapshot.effort);

  const compaction = outer.compaction === true;

  const ok =
    inputTokens !== null ||
    outputTokens !== null ||
    cacheReadTokens !== null ||
    cacheCreationTokens !== null ||
    costUsd !== null ||
    turns !== null;

  return {
    ok,
    sessionId,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    costUsd,
    turns,
    model,
    models,
    contextWindow,
    maxOutputTokens: null,
    effort,
    reporting,
    compaction,
    missing,
  };
}

/**
 * Pure, total, never throws. Anything missing comes back null — never zero,
 * because zero is a measurement and null is the absence of one.
 */
export function parseUsageEnvelope(raw: unknown): ParsedEnvelope {
  const missing: string[] = [];
  const outer = isRecord(raw) ? raw : null;

  // Shape 1: the parser's built snapshot. This is what the adapter persists and
  // what the read path renders, so the aggregator reads it directly rather than
  // demanding a second wire shape. Everything below is the raw-envelope path.
  if (outer !== null && looksLikeUsageSnapshot(outer.snapshot)) {
    return parseSnapshotShape(outer, outer.snapshot);
  }

  const env = outer !== null && isRecord(outer.envelope) ? outer.envelope : outer;

  if (env === null) {
    return {
      ok: false,
      sessionId: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      costUsd: null,
      turns: null,
      model: null,
      models: [],
      contextWindow: null,
      maxOutputTokens: null,
      effort: null,
      reporting: 'cumulative',
      compaction: false,
      missing: ['<payload was not an object>'],
    };
  }

  const usage = isRecord(env.usage) ? env.usage : null;
  if (usage === null) missing.push('usage');

  const inputTokens = usage ? nonNegativeNumber(usage.input_tokens) : null;
  const outputTokens = usage ? nonNegativeNumber(usage.output_tokens) : null;
  const cacheReadTokens = usage ? nonNegativeNumber(usage.cache_read_input_tokens) : null;
  const cacheCreationTokens = usage ? nonNegativeNumber(usage.cache_creation_input_tokens) : null;
  if (inputTokens === null) missing.push('usage.input_tokens');
  if (outputTokens === null) missing.push('usage.output_tokens');
  if (cacheReadTokens === null) missing.push('usage.cache_read_input_tokens');
  if (cacheCreationTokens === null) missing.push('usage.cache_creation_input_tokens');

  const costUsd = nonNegativeNumber(env.total_cost_usd);
  if (costUsd === null) missing.push('total_cost_usd');

  const turns = nonNegativeNumber(env.num_turns);
  if (turns === null) missing.push('num_turns');

  const sessionId = nonEmptyString(env.session_id);
  if (sessionId === null) missing.push('session_id');

  let model: string | null = null;
  let models: readonly string[] = [];
  let contextWindow: number | null = null;
  let maxOutputTokens: number | null = null;

  const modelUsage = isRecord(env.modelUsage) ? env.modelUsage : null;
  if (modelUsage === null) {
    missing.push('modelUsage');
  } else {
    const names = Object.keys(modelUsage).filter((key) => key.trim().length > 0);
    if (names.length > 0) {
      models = names;
      model = names[0];
      const primary = modelUsage[names[0]];
      if (isRecord(primary)) {
        contextWindow = nonNegativeNumber(primary.contextWindow);
        maxOutputTokens = nonNegativeNumber(primary.maxOutputTokens);
      }
    }
  }
  // Schema tolerance only: a top-level `model` is not the documented shape.
  if (model === null) model = nonEmptyString(env.model);
  if (model === null) missing.push('model');
  if (contextWindow === null) missing.push('modelUsage[model].contextWindow');

  const reportingRaw = outer ? nonEmptyString(outer.reporting) : null;
  const reporting: UsageReporting = reportingRaw === 'incremental' ? 'incremental' : 'cumulative';

  const effort = (outer ? nonEmptyString(outer.effort) : null) ?? nonEmptyString(env.effort);

  const compaction =
    (outer !== null && outer.compaction === true) || env.compaction === true || env.compacted === true;

  const ok =
    inputTokens !== null ||
    outputTokens !== null ||
    cacheReadTokens !== null ||
    cacheCreationTokens !== null ||
    costUsd !== null ||
    turns !== null;

  return {
    ok,
    sessionId,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    costUsd,
    turns,
    model,
    models,
    contextWindow,
    maxOutputTokens,
    effort,
    reporting,
    compaction,
    missing,
  };
}

/* ========================================================================== */
/*  Alerts                                                                     */
/* ========================================================================== */

export type AlertKind =
  | 'CONTEXT_THRESHOLD'
  | 'EVENT_LATENCY_HIGH'
  | 'PROCESS_STALE'
  | 'RETRY_COUNT_HIGH'
  | 'REPEATED_COMPACTION'
  | 'LONG_SESSION'
  | 'UNUSUAL_TOOL_VOLUME'
  | 'BRIDGE_DISCONNECTED';

export const ALERT_KINDS: readonly AlertKind[] = [
  'CONTEXT_THRESHOLD',
  'EVENT_LATENCY_HIGH',
  'PROCESS_STALE',
  'RETRY_COUNT_HIGH',
  'REPEATED_COMPACTION',
  'LONG_SESSION',
  'UNUSUAL_TOOL_VOLUME',
  'BRIDGE_DISCONNECTED',
];

export type AlertSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

/**
 * Which scope each alert is judged at.
 *
 * Context occupancy, compaction, session length and tool rate are properties of
 * a SESSION. A run, its conversation and its session all read the same result
 * envelope, so evaluating those conditions at every scope would raise three
 * alerts for one measured fact and imply three problems where there is one.
 * They are therefore judged once, at session scope; the per-scope counts stay
 * available in each snapshot for anything that wants them. Retries belong to a
 * run. `PROCESS_STALE` is deliberately absent: silence at run scope and silence
 * at session scope are genuinely different observations with different last-
 * telemetry times, and each alert names the scope it measured.
 */
const ALERT_EVALUATION_SCOPE: Readonly<Partial<Record<AlertKind, UsageScope>>> = {
  CONTEXT_THRESHOLD: 'session',
  REPEATED_COMPACTION: 'session',
  LONG_SESSION: 'session',
  UNUSUAL_TOOL_VOLUME: 'session',
  RETRY_COUNT_HIGH: 'run',
};

/** True when this alert kind is the given scope's business. */
function judgedHere(kind: AlertKind, scope: UsageScope): boolean {
  const required = ALERT_EVALUATION_SCOPE[kind];
  return required === undefined || required === scope;
}

/** Alerts can also be about the bridge itself, which is not a usage scope. */
export type AlertScope = UsageScope | 'bridge';

export interface SuggestedAction {
  readonly id: string;
  readonly label: string;
  /** A real contract verb — the compiler checks it against `OperationName`. */
  readonly operation: OperationName;
  /** Always false. Nothing suggested here throws away conversation state. */
  readonly discardsConversationState: false;
}

/**
 * The complete set of actions an alert may suggest. Deliberately small, and
 * deliberately free of anything that deletes, archives or resets.
 */
export const SUGGESTED_ACTIONS = {
  CHECKPOINT: {
    id: 'checkpoint',
    label: 'Create a checkpoint of the current state',
    operation: 'createCheckpoint',
    discardsConversationState: false,
  },
  NEW_CONVERSATION: {
    id: 'new-conversation',
    label: 'Continue in a new conversation — this one stays where it is',
    operation: 'createConversation',
    discardsConversationState: false,
  },
  REVIEW_ATTACHMENTS: {
    id: 'review-attachments',
    label: 'Review the files attached to this conversation',
    operation: 'listAttachments',
    discardsConversationState: false,
  },
  REVIEW_EVENTS: {
    id: 'review-events',
    label: 'Inspect the recent event stream',
    operation: 'listEvents',
    discardsConversationState: false,
  },
  EXPORT_DIAGNOSTICS: {
    id: 'export-diagnostics',
    label: 'Export diagnostics for this session',
    operation: 'exportDiagnostics',
    discardsConversationState: false,
  },
  CHECK_HEALTH: {
    id: 'check-health',
    label: 'Check bridge health',
    operation: 'getHealth',
    discardsConversationState: false,
  },
  REVIEW_RUN: {
    id: 'review-run',
    label: 'Open the run and see what it is waiting on',
    operation: 'getRun',
    discardsConversationState: false,
  },
} as const satisfies Record<string, SuggestedAction>;

/** Verbs that destroy or hide state. No suggested action may use one. */
const DESTRUCTIVE_OPERATIONS: readonly OperationName[] = [
  'archiveConversation',
  'archiveProject',
  'removeAttachment',
  'stopRun',
  'denyAction',
];

/**
 * Proves the table above obeys its own rule. Called by the tests rather than at
 * import time, so a violation surfaces as a failing check with a message.
 */
export function suggestedActionsAreSafe(): { readonly safe: boolean; readonly violations: readonly string[] } {
  const violations: string[] = [];
  for (const [key, action] of Object.entries(SUGGESTED_ACTIONS)) {
    if (action.discardsConversationState !== false) violations.push(`${key} may discard conversation state`);
    if (DESTRUCTIVE_OPERATIONS.includes(action.operation)) violations.push(`${key} uses destructive operation ${action.operation}`);
  }
  return { safe: violations.length === 0, violations };
}

/** The measured fact an alert is about. An alert without one is not an alert. */
export interface AlertCondition {
  readonly metric: string;
  readonly observedValue: number;
  readonly unit: UsageField['unit'];
  readonly threshold: number;
  readonly comparison: '>=' | '>' | '<=' | '<';
  /** How much the observed value itself can be trusted. */
  readonly accuracy: Accuracy;
  /** Where the observed value came from. */
  readonly source: string;
}

export interface UsageAlert {
  readonly id: string;
  readonly kind: AlertKind;
  readonly severity: AlertSeverity;
  readonly scope: AlertScope;
  readonly scopeId: string;
  readonly sessionId: string | null;
  readonly raisedAt: string;
  /** States what was measured. Never states what will happen. */
  readonly message: string;
  readonly condition: AlertCondition;
  readonly suggestedActions: readonly SuggestedAction[];
}

/**
 * Phrases that turn a measurement into a forecast. An alert may say the context
 * is at 85%; it may not say what that means for the future, because the size of
 * the next turn is not knowable from here.
 */
const PREDICTIVE_PATTERNS: readonly RegExp[] = [
  /\bwill\s+(run\s+out|be\s+exhausted|hit|reach|exceed|be\s+full)\b/i,
  /\brun(ning)?\s+out\s+(in|at|by|within)\b/i,
  /\b(minutes|hours|turns|messages|tokens)\s+remaining\b/i,
  /\bestimated\s+time\b/i,
  /\bat\s+(this|the\s+current)\s+rate\b/i,
  /\bETA\b/,
  /\bexpected\s+to\s+(reach|exceed|run|hit)\b/i,
  /\byou\s+(will|'ll)\b/i,
  /\bproject(ed|ion)\b/i,
  /\bforecast/i,
  /\bin\s+about\s+\d/i,
  /\bwithin\s+\d+\s+(more\s+)?(turns|messages|minutes)\b/i,
];

/**
 * Returns the offending pattern's description, or null when the text is a
 * statement about the present.
 */
export function containsPredictiveLanguage(text: string): string | null {
  for (const pattern of PREDICTIVE_PATTERNS) {
    const match = pattern.exec(text);
    if (match !== null) return match[0];
  }
  return null;
}

export class UsageAlertLanguageError extends Error {
  readonly offendingPhrase: string;
  constructor(message: string, offendingPhrase: string) {
    super(message);
    this.name = 'UsageAlertLanguageError';
    this.offendingPhrase = offendingPhrase;
  }
}

/* ========================================================================== */
/*  Configuration                                                              */
/* ========================================================================== */

export const DEFAULT_STALENESS_MS = 30_000;
export const DEFAULT_CONTEXT_THRESHOLDS: readonly number[] = [70, 85, 95];
/** Re-arm margin so a value hovering on a threshold does not chatter. */
export const CONTEXT_THRESHOLD_HYSTERESIS = 2;
export const DEFAULT_LATENCY_ALERT_P95_MS = 250;
export const DEFAULT_RETRY_ALERT_COUNT = 3;
export const DEFAULT_COMPACTION_ALERT_COUNT = 2;
export const DEFAULT_LONG_SESSION_MS = 4 * 60 * 60 * 1000;
export const DEFAULT_TOOL_RATE_ALERT_PER_MIN = 30;
/** A rate needs a real denominator; below this, a per-minute figure is noise. */
export const MIN_ELAPSED_FOR_RATE_MS = 60_000;
/** Context falling below this fraction of the previous reading looks compacted. */
export const COMPACTION_DROP_RATIO = 0.6;
export const DEFAULT_MAX_TRACKED_SCOPES = 2_000;
export const DEFAULT_REJECTION_RING = 500;
export const DEFAULT_ANOMALY_RING = 500;
export const DEFAULT_ALERT_HISTORY = 200;
export const DEFAULT_DEDUP_CAPACITY = 50_000;

export interface AggregatorOptions {
  /** Injectable clock, so staleness can be tested without waiting. */
  readonly now?: () => number;
  readonly stalenessThresholdMs?: number;
  readonly latency?: LatencyTracker;
  /** False when another component already measured ingestion for this event. */
  readonly measureIngestion?: boolean;
  readonly contextThresholdPercents?: readonly number[];
  readonly latencyAlertP95Ms?: number;
  readonly retryAlertCount?: number;
  readonly compactionAlertCount?: number;
  readonly longSessionMs?: number;
  readonly toolCallsPerMinuteAlert?: number;
  /** IANA zone for the `day` scope. Resolved from the host when omitted. */
  readonly timeZone?: string;
  readonly maxTrackedScopes?: number;
  readonly dedupCapacity?: number;
}

/* ========================================================================== */
/*  Internal state                                                             */
/* ========================================================================== */

interface CumulativeReading {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  turns: number;
}

export interface UsageDelta {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly costUsd: number;
  readonly turns: number;
  /** True when a reading went backwards and a delta had to be clamped to 0. */
  readonly clamped: boolean;
}

interface LatestObservation {
  model: string | null;
  models: readonly string[];
  distinctModels: Set<string>;
  contextWindow: number | null;
  contextTokensUsed: number | null;
  effort: string | null;
  atMs: number;
}

interface ScopeAccumulator {
  readonly scope: UsageScope;
  readonly scopeId: string;
  readonly policy: ScopeBindingPolicy;
  boundSessionId: string | null;
  readonly contributingSessionIds: Set<string>;

  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  turns: number;

  sawTokens: boolean;
  sawCost: boolean;
  sawTurns: boolean;
  clampedDeltas: number;

  latest: LatestObservation | null;

  toolCalls: number;
  skillUses: number;
  errors: number;
  retries: number;
  explicitCompactions: number;
  heuristicCompactions: number;
  readonly agentIds: Set<string>;

  usageEventCount: number;
  firstEventAtMs: number | null;
  lastEventAtMs: number | null;
  lastTelemetryAtMs: number | null;
  lastIngestAtMs: number | null;

  rejectedEvents: number;
}

function newAccumulator(scope: UsageScope, scopeId: string): ScopeAccumulator {
  return {
    scope,
    scopeId,
    policy: SCOPE_BINDING[scope],
    boundSessionId: null,
    contributingSessionIds: new Set<string>(),
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    turns: 0,
    sawTokens: false,
    sawCost: false,
    sawTurns: false,
    clampedDeltas: 0,
    latest: null,
    toolCalls: 0,
    skillUses: 0,
    errors: 0,
    retries: 0,
    explicitCompactions: 0,
    heuristicCompactions: 0,
    agentIds: new Set<string>(),
    usageEventCount: 0,
    firstEventAtMs: null,
    lastEventAtMs: null,
    lastTelemetryAtMs: null,
    lastIngestAtMs: null,
    rejectedEvents: 0,
  };
}

export interface IngestResult {
  /** True when at least one scope took the event. */
  readonly accepted: boolean;
  readonly eventId: string;
  readonly scopesUpdated: readonly ScopeRef[];
  readonly rejections: readonly UsageRejection[];
  readonly anomalies: readonly UsageAnomaly[];
  readonly alerts: readonly UsageAlert[];
  readonly delta: UsageDelta | null;
}

export interface AggregatorStats {
  readonly trackedScopes: number;
  readonly usageEventsIngested: number;
  readonly counterEventsIngested: number;
  readonly eventsIgnored: number;
  readonly duplicatesDropped: number;
  readonly rejectionsTotal: number;
  readonly rejectionsByReason: Readonly<Record<RejectionReason, number>>;
  readonly anomaliesTotal: number;
  readonly alertsRaised: number;
  /** True once the dedup set has wrapped — idempotency is bounded past here. */
  readonly dedupWindowExceeded: boolean;
  readonly dedupTracked: number;
  readonly timeZone: string;
  readonly connected: boolean;
  readonly lastRebuildAt: string | null;
  readonly eventsSeenByType: Readonly<Record<string, number>>;
}

/* ========================================================================== */
/*  Event types this aggregator understands                                    */
/* ========================================================================== */

const USAGE_EVENT_TYPE = 'claude.usage';
const TOOL_EVENT_TYPE = 'claude.tool.start';
const SKILL_EVENT_TYPE = 'skill.used';
const AGENT_EVENT_TYPE = 'agent.activated';
const ERROR_EVENT_TYPE = 'run.error';
const RUN_STATE_EVENT_TYPE = 'run.state';

const HANDLED_EVENT_TYPES: readonly string[] = [
  USAGE_EVENT_TYPE,
  TOOL_EVENT_TYPE,
  SKILL_EVENT_TYPE,
  AGENT_EVENT_TYPE,
  ERROR_EVENT_TYPE,
  RUN_STATE_EVENT_TYPE,
];

/* ========================================================================== */
/*  Time zone / day bucketing                                                  */
/* ========================================================================== */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Resolved from the host at runtime. Never hardcoded, never assumed. */
export function resolveTimeZone(explicit?: string): string {
  const given = typeof explicit === 'string' ? explicit.trim() : '';
  if (given.length > 0) return given;
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (typeof zone === 'string' && zone.trim().length > 0) return zone.trim();
  } catch {
    /* Intl is unavailable or misconfigured; fall through to UTC. */
  }
  return 'UTC';
}

/** `YYYY-MM-DD` in the given zone, so a "day" means the operator's day. */
export function dayIdFor(atMs: number, timeZone: string): string {
  try {
    const formatted = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(atMs));
    if (ISO_DATE.test(formatted)) return formatted;
  } catch {
    /* Unknown zone or unusual locale output; fall through to UTC. */
  }
  return new Date(atMs).toISOString().slice(0, 10);
}

/* ========================================================================== */
/*  Bounded collections                                                        */
/* ========================================================================== */

function pushBounded<T>(ring: T[], item: T, max: number): void {
  ring.push(item);
  if (ring.length > max) ring.splice(0, ring.length - max);
}

/* ========================================================================== */
/*  The aggregator                                                             */
/* ========================================================================== */

export class UsageAggregator {
  private readonly scopes = new Map<string, ScopeAccumulator>();
  private readonly cumulativeByRun = new Map<string, CumulativeReading>();
  private readonly seenEventIds = new Set<string>();
  private readonly rejectionRing: UsageRejection[] = [];
  private readonly anomalyRing: UsageAnomaly[] = [];
  private readonly alertHistory: UsageAlert[] = [];
  private readonly activeAlerts = new Map<string, UsageAlert>();
  private readonly firedAlertKeys = new Set<string>();
  private readonly alertListeners = new Set<(alert: UsageAlert) => void>();
  private readonly eventsSeenByType = new Map<string, number>();
  private readonly rejectionCounts: Record<RejectionReason, number> = {
    MISSING_SESSION_ID: 0,
    SESSION_MISMATCH: 0,
    DUPLICATE_EVENT: 0,
    UNPARSEABLE_PAYLOAD: 0,
    NO_USABLE_FIELDS: 0,
    SCHEMA_VERSION_MISMATCH: 0,
    BAD_TIMESTAMP: 0,
    SCOPE_LIMIT_REACHED: 0,
  };

  private readonly nowFn: () => number;
  private readonly stalenessThresholdMs: number;
  private readonly latency: LatencyTracker;
  private readonly measureIngestion: boolean;
  private readonly contextThresholds: readonly number[];
  private readonly latencyAlertP95Ms: number;
  private readonly retryAlertCount: number;
  private readonly compactionAlertCount: number;
  private readonly longSessionMs: number;
  private readonly toolRateAlert: number;
  private readonly timeZone: string;
  private readonly maxTrackedScopes: number;
  private readonly dedupCapacity: number;

  private usageEventsIngested = 0;
  private counterEventsIngested = 0;
  private eventsIgnored = 0;
  private duplicatesDropped = 0;
  private anomaliesTotal = 0;
  private alertsRaised = 0;
  private alertSequence = 0;
  private dedupWindowExceeded = false;
  private connected = true;
  private lastRebuildAtMs: number | null = null;

  constructor(options: AggregatorOptions = {}) {
    this.nowFn = typeof options.now === 'function' ? options.now : () => Date.now();
    this.stalenessThresholdMs = positive(options.stalenessThresholdMs, DEFAULT_STALENESS_MS);
    this.latency = options.latency instanceof LatencyTracker ? options.latency : new LatencyTracker({ now: this.nowFn });
    this.measureIngestion = options.measureIngestion !== false;
    this.contextThresholds =
      Array.isArray(options.contextThresholdPercents) && options.contextThresholdPercents.length > 0
        ? [...options.contextThresholdPercents].sort((a, b) => a - b)
        : DEFAULT_CONTEXT_THRESHOLDS;
    this.latencyAlertP95Ms = positive(options.latencyAlertP95Ms, DEFAULT_LATENCY_ALERT_P95_MS);
    this.retryAlertCount = positive(options.retryAlertCount, DEFAULT_RETRY_ALERT_COUNT);
    this.compactionAlertCount = positive(options.compactionAlertCount, DEFAULT_COMPACTION_ALERT_COUNT);
    this.longSessionMs = positive(options.longSessionMs, DEFAULT_LONG_SESSION_MS);
    this.toolRateAlert = positive(options.toolCallsPerMinuteAlert, DEFAULT_TOOL_RATE_ALERT_PER_MIN);
    this.timeZone = resolveTimeZone(options.timeZone);
    this.maxTrackedScopes = positive(options.maxTrackedScopes, DEFAULT_MAX_TRACKED_SCOPES);
    this.dedupCapacity = positive(options.dedupCapacity, DEFAULT_DEDUP_CAPACITY);
  }

  /* ---------------------------------------------------------------------- */
  /*  Ingestion                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Takes one event. Never throws on bad input — a malformed event produces a
   * recorded rejection, because a telemetry layer that crashes on bad telemetry
   * is worse than one that says "I could not use that".
   */
  ingest(event: ForgeEvent): IngestResult {
    const rejections: UsageRejection[] = [];
    const anomalies: UsageAnomaly[] = [];

    if (!isRecord(event) || typeof event.eventId !== 'string' || typeof event.type !== 'string') {
      const rejection = this.recordRejection({
        eventId: typeof (event as { eventId?: unknown })?.eventId === 'string' ? String(event.eventId) : '<unknown>',
        eventType: '<unknown>',
        reason: 'UNPARSEABLE_PAYLOAD',
        detail: 'event was not a well-formed ForgeEvent envelope',
        scope: null,
        scopeId: null,
        eventSessionId: null,
        scopeSessionId: null,
      });
      return this.result(false, '<unknown>', [], [rejection], anomalies, [], null);
    }

    this.eventsSeenByType.set(event.type, (this.eventsSeenByType.get(event.type) ?? 0) + 1);

    if (!HANDLED_EVENT_TYPES.includes(event.type)) {
      // Not a data-integrity failure — simply none of this module's business.
      this.eventsIgnored += 1;
      return this.result(false, event.eventId, [], [], anomalies, [], null);
    }

    if (this.seenEventIds.has(event.eventId)) {
      this.duplicatesDropped += 1;
      const rejection = this.recordRejection({
        eventId: event.eventId,
        eventType: event.type,
        reason: 'DUPLICATE_EVENT',
        detail: 'this eventId has already been counted; re-counting it would inflate every scope',
        scope: null,
        scopeId: null,
        eventSessionId: event.sessionId,
        scopeSessionId: null,
      });
      return this.result(false, event.eventId, [], [rejection], anomalies, [], null);
    }

    const eventAtMs = Date.parse(event.timestamp);
    if (Number.isNaN(eventAtMs)) {
      const rejection = this.recordRejection({
        eventId: event.eventId,
        eventType: event.type,
        reason: 'BAD_TIMESTAMP',
        detail: `unparseable timestamp: ${String(event.timestamp)}`,
        scope: null,
        scopeId: null,
        eventSessionId: event.sessionId,
        scopeSessionId: null,
      });
      return this.result(false, event.eventId, [], [rejection], anomalies, [], null);
    }

    const sessionId = nonEmptyString(event.sessionId);
    if (sessionId === null) {
      // Unattributable. Merging it anywhere would put unknown usage into a
      // named total, which is exactly the failure this layer exists to stop.
      const rejection = this.recordRejection({
        eventId: event.eventId,
        eventType: event.type,
        reason: 'MISSING_SESSION_ID',
        detail: 'event carries no sessionId, so it cannot be attributed to any scope',
        scope: null,
        scopeId: null,
        eventSessionId: null,
        scopeSessionId: null,
      });
      return this.result(false, event.eventId, [], [rejection], anomalies, [], null);
    }

    if (this.measureIngestion) this.latency.recordIngestionFromEvent(event);

    const targets = this.targetScopes(event, sessionId, eventAtMs, rejections);

    let delta: UsageDelta | null = null;
    let parsed: ParsedEnvelope | null = null;

    if (event.type === USAGE_EVENT_TYPE) {
      parsed = parseUsageEnvelope(event.payload);
      if (!parsed.ok) {
        const rejection = this.recordRejection({
          eventId: event.eventId,
          eventType: event.type,
          reason: 'NO_USABLE_FIELDS',
          detail: `no usable usage numbers in payload; missing: ${parsed.missing.join(', ') || 'everything'}`,
          scope: null,
          scopeId: null,
          eventSessionId: sessionId,
          scopeSessionId: null,
        });
        rejections.push(rejection);
        this.rememberEventId(event.eventId);
        return this.result(false, event.eventId, [], rejections, anomalies, [], null);
      }

      // The envelope's own session_id is the authority. If it disagrees with the
      // envelope on the event, say so rather than quietly preferring one.
      if (parsed.sessionId !== null && parsed.sessionId !== sessionId) {
        const rejection = this.recordRejection({
          eventId: event.eventId,
          eventType: event.type,
          reason: 'SESSION_MISMATCH',
          detail: `event sessionId ${sessionId} does not match envelope session_id ${parsed.sessionId}`,
          scope: null,
          scopeId: null,
          eventSessionId: sessionId,
          scopeSessionId: parsed.sessionId,
        });
        rejections.push(rejection);
        this.rememberEventId(event.eventId);
        return this.result(false, event.eventId, [], rejections, anomalies, [], null);
      }

      delta = this.deltaFor(event, sessionId, parsed, anomalies);
      this.usageEventsIngested += 1;
    } else {
      this.counterEventsIngested += 1;
    }

    const updated: ScopeRef[] = [];
    for (const acc of targets) {
      this.applyToScope(acc, event, eventAtMs, parsed, delta, anomalies);
      updated.push({ scope: acc.scope, scopeId: acc.scopeId });
    }

    this.rememberEventId(event.eventId);

    const alerts: UsageAlert[] = [];
    for (const acc of targets) alerts.push(...this.evaluateScope(acc));
    alerts.push(...this.evaluateLatency());

    return this.result(updated.length > 0, event.eventId, updated, rejections, anomalies, alerts, delta);
  }

  /** Convenience for a batch. Order matters: sequence order, oldest first. */
  ingestAll(events: Iterable<ForgeEvent>): readonly IngestResult[] {
    const results: IngestResult[] = [];
    for (const event of events) results.push(this.ingest(event));
    return results;
  }

  /* ---------------------------------------------------------------------- */
  /*  Scope resolution and session binding                                   */
  /* ---------------------------------------------------------------------- */

  private targetScopes(
    event: ForgeEvent,
    sessionId: string,
    eventAtMs: number,
    rejections: UsageRejection[],
  ): ScopeAccumulator[] {
    const wanted: ScopeRef[] = [{ scope: 'session', scopeId: sessionId }];
    if (nonEmptyString(event.runId) !== null) wanted.push({ scope: 'run', scopeId: String(event.runId) });
    if (nonEmptyString(event.conversationId) !== null) {
      wanted.push({ scope: 'conversation', scopeId: String(event.conversationId) });
    }
    if (nonEmptyString(event.projectId) !== null) wanted.push({ scope: 'project', scopeId: String(event.projectId) });
    wanted.push({ scope: 'day', scopeId: dayIdFor(eventAtMs, this.timeZone) });

    const accepted: ScopeAccumulator[] = [];
    for (const ref of wanted) {
      const acc = this.ensureScope(ref.scope, ref.scopeId, event, sessionId, rejections);
      if (acc === null) continue;

      if (acc.policy === 'single-session') {
        if (acc.boundSessionId === null) {
          acc.boundSessionId = sessionId;
        } else if (acc.boundSessionId !== sessionId) {
          // The whole point of the scope separation rule.
          acc.rejectedEvents += 1;
          rejections.push(
            this.recordRejection({
              eventId: event.eventId,
              eventType: event.type,
              reason: 'SESSION_MISMATCH',
              detail:
                `${ref.scope} ${ref.scopeId} is bound to session ${acc.boundSessionId}; ` +
                `an event from session ${sessionId} was not merged into it`,
              scope: ref.scope,
              scopeId: ref.scopeId,
              eventSessionId: sessionId,
              scopeSessionId: acc.boundSessionId,
            }),
          );
          continue;
        }
      }
      acc.contributingSessionIds.add(sessionId);
      accepted.push(acc);
    }
    return accepted;
  }

  private ensureScope(
    scope: UsageScope,
    scopeId: string,
    event: ForgeEvent,
    sessionId: string,
    rejections: UsageRejection[],
  ): ScopeAccumulator | null {
    const key = `${scope}:${scopeId}`;
    const existing = this.scopes.get(key);
    if (existing !== undefined) return existing;
    if (this.scopes.size >= this.maxTrackedScopes) {
      // Refusing beats evicting: an evicted scope would silently lose totals it
      // had already reported, which looks like a reset that never happened.
      rejections.push(
        this.recordRejection({
          eventId: event.eventId,
          eventType: event.type,
          reason: 'SCOPE_LIMIT_REACHED',
          detail: `refusing to track more than ${this.maxTrackedScopes} scopes; ${scope} ${scopeId} is not being counted`,
          scope,
          scopeId,
          eventSessionId: sessionId,
          scopeSessionId: null,
        }),
      );
      return null;
    }
    const created = newAccumulator(scope, scopeId);
    this.scopes.set(key, created);
    return created;
  }

  /* ---------------------------------------------------------------------- */
  /*  Cumulative -> delta                                                    */
  /* ---------------------------------------------------------------------- */

  /**
   * Converts one envelope reading into the increment it represents, keyed so
   * the same reading cannot be counted twice through two different scopes.
   *
   * The key is ALWAYS prefixed with the session id. A run id is only unique
   * within a session, and keying on the run alone let one session's odometer
   * become another session's baseline — a session-bleed that the scope guards
   * above cannot see, because it happens before any scope is touched.
   */
  private deltaFor(
    event: ForgeEvent,
    sessionId: string,
    parsed: ParsedEnvelope,
    anomalies: UsageAnomaly[],
  ): UsageDelta {
    const reading: CumulativeReading = {
      inputTokens: parsed.inputTokens ?? 0,
      outputTokens: parsed.outputTokens ?? 0,
      cacheReadTokens: parsed.cacheReadTokens ?? 0,
      cacheCreationTokens: parsed.cacheCreationTokens ?? 0,
      costUsd: parsed.costUsd ?? 0,
      turns: parsed.turns ?? 0,
    };

    if (parsed.reporting === 'incremental') {
      return { ...reading, clamped: false };
    }

    const runKey = `${sessionId}::${nonEmptyString(event.runId) ?? nonEmptyString(event.conversationId) ?? '_'}`;
    const previous = this.cumulativeByRun.get(runKey);
    this.cumulativeByRun.set(runKey, reading);

    if (previous === undefined) {
      return { ...reading, clamped: false };
    }

    let clamped = false;
    const sub = (current: number, before: number, field: string): number => {
      const diff = current - before;
      if (diff >= 0) return diff;
      clamped = true;
      const anomaly = this.recordAnomaly({
        kind: 'CUMULATIVE_REGRESSION',
        eventId: event.eventId,
        detail: `${field} went backwards for ${runKey}: ${before} -> ${current}; delta clamped to 0`,
        scope: 'run',
        scopeId: runKey,
      });
      anomalies.push(anomaly);
      return 0;
    };

    return {
      inputTokens: sub(reading.inputTokens, previous.inputTokens, 'input_tokens'),
      outputTokens: sub(reading.outputTokens, previous.outputTokens, 'output_tokens'),
      cacheReadTokens: sub(reading.cacheReadTokens, previous.cacheReadTokens, 'cache_read_input_tokens'),
      cacheCreationTokens: sub(
        reading.cacheCreationTokens,
        previous.cacheCreationTokens,
        'cache_creation_input_tokens',
      ),
      costUsd: sub(reading.costUsd, previous.costUsd, 'total_cost_usd'),
      turns: sub(reading.turns, previous.turns, 'num_turns'),
      clamped,
    };
  }

  /* ---------------------------------------------------------------------- */
  /*  Applying an event to one scope                                         */
  /* ---------------------------------------------------------------------- */

  private applyToScope(
    acc: ScopeAccumulator,
    event: ForgeEvent,
    eventAtMs: number,
    parsed: ParsedEnvelope | null,
    delta: UsageDelta | null,
    anomalies: UsageAnomaly[],
  ): void {
    if (acc.firstEventAtMs === null || eventAtMs < acc.firstEventAtMs) acc.firstEventAtMs = eventAtMs;
    if (acc.lastEventAtMs === null || eventAtMs > acc.lastEventAtMs) acc.lastEventAtMs = eventAtMs;
    acc.lastIngestAtMs = this.nowFn();

    switch (event.type) {
      case TOOL_EVENT_TYPE:
        acc.toolCalls += 1;
        return;
      case SKILL_EVENT_TYPE:
        acc.skillUses += 1;
        return;
      case AGENT_EVENT_TYPE: {
        const agentId = nonEmptyString(event.agentId);
        if (agentId !== null) acc.agentIds.add(agentId);
        return;
      }
      case ERROR_EVENT_TYPE:
        acc.errors += 1;
        return;
      case RUN_STATE_EVENT_TYPE:
        if (event.status === 'RETRYING') acc.retries += 1;
        return;
      default:
        break;
    }

    if (parsed === null || delta === null) return;

    acc.usageEventCount += 1;
    // Staleness is measured against when the telemetry SAYS it happened, so a
    // rebuild from an old log reports an old conversation as stale, correctly.
    acc.lastTelemetryAtMs = eventAtMs;

    acc.inputTokens += delta.inputTokens;
    acc.outputTokens += delta.outputTokens;
    acc.cacheReadTokens += delta.cacheReadTokens;
    acc.cacheCreationTokens += delta.cacheCreationTokens;
    acc.costUsd += delta.costUsd;
    acc.turns += delta.turns;
    if (delta.clamped) acc.clampedDeltas += 1;

    if (parsed.inputTokens !== null || parsed.outputTokens !== null) acc.sawTokens = true;
    if (parsed.costUsd !== null) acc.sawCost = true;
    if (parsed.turns !== null) acc.sawTurns = true;
    if (parsed.compaction) acc.explicitCompactions += 1;

    const contextUsed = contextTokensFrom(parsed);
    const previous = acc.latest;

    if (
      acc.policy === 'single-session' &&
      previous !== null &&
      previous.contextTokensUsed !== null &&
      contextUsed !== null &&
      previous.contextTokensUsed > 0 &&
      contextUsed < previous.contextTokensUsed * COMPACTION_DROP_RATIO &&
      parsed.turns !== null
    ) {
      acc.heuristicCompactions += 1;
      anomalies.push(
        this.recordAnomaly({
          kind: 'CONTEXT_DROP',
          eventId: event.eventId,
          detail:
            `context fell from ${previous.contextTokensUsed} to ${contextUsed} tokens; ` +
            'counted as a probable compaction by heuristic, not reported by the runtime',
          scope: acc.scope,
          scopeId: acc.scopeId,
        }),
      );
    }

    if (contextUsed !== null && parsed.contextWindow !== null && contextUsed > parsed.contextWindow) {
      anomalies.push(
        this.recordAnomaly({
          kind: 'CONTEXT_OVER_WINDOW',
          eventId: event.eventId,
          detail: `derived context ${contextUsed} exceeds the reported window ${parsed.contextWindow}`,
          scope: acc.scope,
          scopeId: acc.scopeId,
        }),
      );
    }

    const distinct = previous?.distinctModels ?? new Set<string>();
    for (const name of parsed.models) distinct.add(name);
    if (parsed.model !== null) distinct.add(parsed.model);

    acc.latest = {
      model: parsed.model ?? previous?.model ?? null,
      models: parsed.models.length > 0 ? parsed.models : (previous?.models ?? []),
      distinctModels: distinct,
      contextWindow: parsed.contextWindow ?? previous?.contextWindow ?? null,
      contextTokensUsed: contextUsed ?? previous?.contextTokensUsed ?? null,
      effort: parsed.effort ?? previous?.effort ?? null,
      atMs: eventAtMs,
    };
  }

  /* ---------------------------------------------------------------------- */
  /*  Snapshots                                                              */
  /* ---------------------------------------------------------------------- */

  getSnapshot(scope: UsageScope, scopeId: string): UsageSnapshot | null {
    const acc = this.scopes.get(`${scope}:${scopeId}`);
    return acc === undefined ? null : this.project(acc);
  }

  getSnapshots(): readonly UsageSnapshot[] {
    const out: UsageSnapshot[] = [];
    for (const acc of this.scopes.values()) out.push(this.project(acc));
    return out;
  }

  listScopes(): readonly ScopeRef[] {
    const out: ScopeRef[] = [];
    for (const acc of this.scopes.values()) out.push({ scope: acc.scope, scopeId: acc.scopeId });
    return out;
  }

  private project(acc: ScopeAccumulator): UsageSnapshot {
    const nowMs = this.nowFn();
    const at = new Date(nowMs).toISOString();
    const latest = acc.latest;

    // A run's deltas telescope back to the envelope's own totals, so a run may
    // claim EXACT — unless a clamp broke the telescoping.
    const totalAccuracy: Accuracy = acc.scope === 'run' && acc.clampedDeltas === 0 ? 'EXACT' : 'DERIVED';
    const tokenSource =
      acc.scope === 'run' && acc.clampedDeltas === 0
        ? SRC.envelope('usage.*')
        : SRC.envelopeSum(['input_tokens', 'output_tokens', 'cache_*']);

    const sessionId =
      acc.policy === 'single-session'
        ? acc.boundSessionId
        : acc.contributingSessionIds.size === 1
          ? [...acc.contributingSessionIds][0]
          : null;

    const perSession = acc.policy === 'single-session';
    const contextUsed = perSession ? (latest?.contextTokensUsed ?? null) : null;
    const contextWindow = perSession ? (latest?.contextWindow ?? null) : null;
    const contextPercent =
      contextUsed !== null && contextWindow !== null && contextWindow > 0
        ? (contextUsed / contextWindow) * 100
        : null;

    const elapsedMs =
      acc.firstEventAtMs !== null && acc.lastEventAtMs !== null ? acc.lastEventAtMs - acc.firstEventAtMs : null;

    const latencyStat = this.latency.stat('ingestion');
    const latencyAccuracy = accuracyForLatency(latencyStat);

    const compactionTotal = acc.explicitCompactions + acc.heuristicCompactions;
    const compactionKnown = acc.usageEventCount >= 2 || acc.explicitCompactions > 0;
    const compactionAccuracy: Accuracy = acc.heuristicCompactions > 0 ? 'ESTIMATED' : 'DERIVED';

    return {
      scope: acc.scope,
      scopeId: acc.scopeId,
      sessionId,

      model: latest?.model
        ? usageField<string>(
            'model',
            latest.model,
            'none',
            latest.distinctModels.size > 1
              ? `${SRC.envelope('modelUsage')} — most recent of ${latest.distinctModels.size} models seen in scope`
              : SRC.envelope('modelUsage'),
            'EXACT',
            at,
          )
        : unavailableField<string>('model', 'none', SRC.notObserved('claude.usage with modelUsage'), at),

      effort: latest?.effort
        ? usageField<string>('effort', latest.effort, 'none', SRC.effort, 'EXACT', at)
        : unavailableField<string>(
            'effort',
            'none',
            'unavailable:the adapter did not report the --effort argument on any usage event',
            at,
          ),

      inputTokens: acc.sawTokens
        ? usageField('inputTokens', acc.inputTokens, 'tokens', tokenSource, totalAccuracy, at)
        : unavailableField('inputTokens', 'tokens', SRC.notObserved('claude.usage'), at),

      outputTokens: acc.sawTokens
        ? usageField('outputTokens', acc.outputTokens, 'tokens', tokenSource, totalAccuracy, at)
        : unavailableField('outputTokens', 'tokens', SRC.notObserved('claude.usage'), at),

      cacheReadTokens: acc.sawTokens
        ? usageField('cacheReadTokens', acc.cacheReadTokens, 'tokens', tokenSource, totalAccuracy, at)
        : unavailableField('cacheReadTokens', 'tokens', SRC.notObserved('claude.usage'), at),

      cacheCreationTokens: acc.sawTokens
        ? usageField('cacheCreationTokens', acc.cacheCreationTokens, 'tokens', tokenSource, totalAccuracy, at)
        : unavailableField('cacheCreationTokens', 'tokens', SRC.notObserved('claude.usage'), at),

      contextTokensUsed: perSession
        ? usageField('contextTokensUsed', contextUsed, 'tokens', SRC.contextFormula, 'DERIVED', at)
        : unavailableField('contextTokensUsed', 'tokens', SRC.perSessionOnly, at),

      contextWindow: perSession
        ? usageField('contextWindow', contextWindow, 'tokens', SRC.contextWindow, 'EXACT', at)
        : unavailableField('contextWindow', 'tokens', SRC.perSessionOnly, at),

      contextPercent: perSession
        ? usageField(
            'contextPercent',
            contextPercent,
            'percent',
            SRC.contextPercent,
            weakestAccuracy('DERIVED', 'EXACT'),
            at,
          )
        : unavailableField('contextPercent', 'percent', SRC.perSessionOnly, at),

      costUsd: acc.sawCost
        ? usageField('costUsd', acc.costUsd, 'usd', SRC.cost, totalAccuracy, at)
        : unavailableField('costUsd', 'usd', SRC.notObserved('claude.usage with total_cost_usd'), at),

      turns: acc.sawTurns
        ? usageField('turns', acc.turns, 'count', SRC.envelopeSum(['num_turns']), totalAccuracy, at)
        : unavailableField('turns', 'count', SRC.notObserved('claude.usage with num_turns'), at),

      toolCalls: this.hasSeen(TOOL_EVENT_TYPE)
        ? usageField('toolCalls', acc.toolCalls, 'count', SRC.counter(TOOL_EVENT_TYPE), 'DERIVED', at)
        : unavailableField('toolCalls', 'count', SRC.notObserved(TOOL_EVENT_TYPE), at),

      agentCount: this.hasSeen(AGENT_EVENT_TYPE)
        ? usageField('agentCount', acc.agentIds.size, 'count', SRC.distinct(AGENT_EVENT_TYPE, 'agentId'), 'DERIVED', at)
        : unavailableField('agentCount', 'count', SRC.notObserved(AGENT_EVENT_TYPE), at),

      skillUses: this.hasSeen(SKILL_EVENT_TYPE)
        ? usageField('skillUses', acc.skillUses, 'count', SRC.counter(SKILL_EVENT_TYPE), 'DERIVED', at)
        : unavailableField('skillUses', 'count', SRC.notObserved(SKILL_EVENT_TYPE), at),

      errors: this.hasSeen(ERROR_EVENT_TYPE)
        ? usageField('errors', acc.errors, 'count', SRC.counter(ERROR_EVENT_TYPE), 'DERIVED', at)
        : unavailableField('errors', 'count', SRC.notObserved(ERROR_EVENT_TYPE), at),

      retries: this.hasSeen(RUN_STATE_EVENT_TYPE)
        ? usageField(
            'retries',
            acc.retries,
            'count',
            `derived:count of ${RUN_STATE_EVENT_TYPE} events with status RETRYING`,
            'DERIVED',
            at,
          )
        : unavailableField('retries', 'count', SRC.notObserved(RUN_STATE_EVENT_TYPE), at),

      compactions: compactionKnown
        ? usageField(
            'compactions',
            compactionTotal,
            'count',
            acc.heuristicCompactions > 0
              ? `${SRC.compactionExplicit} + ${SRC.compactionHeuristic(COMPACTION_DROP_RATIO)}`
              : SRC.compactionExplicit,
            compactionAccuracy,
            at,
          )
        : unavailableField(
            'compactions',
            'count',
            'unavailable:the runtime does not report compaction and fewer than two usage envelopes have ' +
              'been seen in this scope, so the drop heuristic has had nothing to compare',
            at,
          ),

      elapsedMs:
        elapsedMs === null
          ? unavailableField('elapsedMs', 'ms', 'unavailable:no events observed in this scope yet', at)
          : usageField('elapsedMs', elapsedMs, 'ms', SRC.elapsed, 'DERIVED', at),

      eventLatencyP95: latencyStat.measured
        ? usageField('eventLatencyP95', latencyStat.p95Ms, 'ms', SRC.latency(latencyStat), latencyAccuracy, at)
        : unavailableField(
            'eventLatencyP95',
            'ms',
            'unavailable:no ingestion latency sample has been accepted, so p95 is not measured',
            at,
          ),

      lastUpdate: at,
      stale: this.isStale(acc, nowMs),

      planUsage: {
        name: 'planUsage',
        value: PLAN_USAGE_UNAVAILABLE_MESSAGE,
        unit: 'none',
        source: SRC.planUsage,
        accuracy: 'UNAVAILABLE',
        updatedAt: at,
      },
    };
  }

  private hasSeen(eventType: string): boolean {
    return (this.eventsSeenByType.get(eventType) ?? 0) > 0;
  }

  /**
   * Stale means "no telemetry recently", nothing more. It never zeroes a
   * counter, and a scope that has never had telemetry is stale rather than
   * pretending to be fresh at zero.
   */
  private isStale(acc: ScopeAccumulator, nowMs: number): boolean {
    if (acc.lastTelemetryAtMs === null) return true;
    return nowMs - acc.lastTelemetryAtMs > this.stalenessThresholdMs;
  }

  /* ---------------------------------------------------------------------- */
  /*  Connection state — never a reason to reset a count                     */
  /* ---------------------------------------------------------------------- */

  /**
   * Records that the bridge lost its client or its runtime. Totals are left
   * exactly as they are: a dropped socket is not evidence that work undid
   * itself, and zeroing here would be the loudest possible lie.
   */
  markBridgeDisconnected(detail = 'the bridge connection is down'): UsageAlert | null {
    if (!this.connected) return null;
    this.connected = false;
    return this.raise({
      kind: 'BRIDGE_DISCONNECTED',
      severity: 'WARNING',
      scope: 'bridge',
      scopeId: 'bridge',
      sessionId: null,
      message: `Bridge connection reported down: ${detail}. Counts already recorded are kept unchanged.`,
      condition: {
        metric: 'bridgeConnected',
        observedValue: 0,
        unit: 'none',
        threshold: 1,
        comparison: '<',
        accuracy: 'EXACT',
        source: 'bridge:connection state reported by the transport layer',
      },
      actions: [SUGGESTED_ACTIONS.CHECK_HEALTH, SUGGESTED_ACTIONS.EXPORT_DIAGNOSTICS],
    });
  }

  /** Reconnecting clears the alert and touches nothing else. */
  markBridgeConnected(): void {
    if (this.connected) return;
    this.connected = true;
    this.clearAlertsOfKind('BRIDGE_DISCONNECTED');
  }

  isConnected(): boolean {
    return this.connected;
  }

  /* ---------------------------------------------------------------------- */
  /*  Rebuild from the persisted log                                         */
  /* ---------------------------------------------------------------------- */

  /**
   * Rebuilds every scope from durable events. This is how totals survive a
   * refresh: the browser reloading is not evidence that a conversation cost
   * nothing, so state comes back from the log on disk, not from memory that
   * just died. Idempotent — replaying the same log twice gives the same totals.
   */
  rebuildFrom(events: Iterable<ForgeEvent>): {
    readonly ingested: number;
    readonly accepted: number;
    readonly rejected: number;
    readonly scopes: number;
  } {
    this.scopes.clear();
    this.cumulativeByRun.clear();
    this.seenEventIds.clear();
    this.dedupWindowExceeded = false;
    this.activeAlerts.clear();
    this.firedAlertKeys.clear();
    this.usageEventsIngested = 0;
    this.counterEventsIngested = 0;
    this.eventsIgnored = 0;
    this.duplicatesDropped = 0;
    this.eventsSeenByType.clear();

    let ingested = 0;
    let accepted = 0;
    let rejected = 0;
    for (const event of events) {
      ingested += 1;
      const result = this.ingest(event);
      if (result.accepted) accepted += 1;
      if (result.rejections.length > 0) rejected += 1;
    }
    this.lastRebuildAtMs = this.nowFn();
    return { ingested, accepted, rejected, scopes: this.scopes.size };
  }

  /* ---------------------------------------------------------------------- */
  /*  Alerts                                                                 */
  /* ---------------------------------------------------------------------- */

  onAlert(listener: (alert: UsageAlert) => void): () => void {
    this.alertListeners.add(listener);
    return () => {
      this.alertListeners.delete(listener);
    };
  }

  getActiveAlerts(): readonly UsageAlert[] {
    return [...this.activeAlerts.values()];
  }

  getAlertHistory(): readonly UsageAlert[] {
    return [...this.alertHistory];
  }

  clearAlert(id: string): boolean {
    return this.activeAlerts.delete(id);
  }

  private clearAlertsOfKind(kind: AlertKind): void {
    for (const [id, alert] of this.activeAlerts) {
      if (alert.kind === kind) this.activeAlerts.delete(id);
    }
    for (const key of [...this.firedAlertKeys]) {
      if (key.startsWith(`${kind}:`)) this.firedAlertKeys.delete(key);
    }
  }

  /**
   * Time-driven checks. Staleness and session length are not announced by an
   * event arriving — they are announced by one failing to. Call this on a timer.
   */
  tick(): readonly UsageAlert[] {
    const alerts: UsageAlert[] = [];
    for (const acc of this.scopes.values()) alerts.push(...this.evaluateScope(acc));
    alerts.push(...this.evaluateLatency());
    return alerts;
  }

  private evaluateScope(acc: ScopeAccumulator): readonly UsageAlert[] {
    const alerts: UsageAlert[] = [];
    const nowMs = this.nowFn();
    const snapshot = this.project(acc);
    const sessionId = snapshot.sessionId;

    // Context thresholds — highest crossed threshold wins, so 95% does not also
    // shout 70% and 85%.
    const percent = snapshot.contextPercent.value;
    if (judgedHere('CONTEXT_THRESHOLD', acc.scope) && percent !== null && snapshot.contextWindow.value !== null) {
      let crossed: number | null = null;
      for (const threshold of this.contextThresholds) {
        if (percent >= threshold) crossed = threshold;
      }
      for (const threshold of this.contextThresholds) {
        const key = this.alertKey('CONTEXT_THRESHOLD', acc, String(threshold));
        if (percent < threshold - CONTEXT_THRESHOLD_HYSTERESIS) this.firedAlertKeys.delete(key);
      }
      if (crossed !== null) {
        const key = this.alertKey('CONTEXT_THRESHOLD', acc, String(crossed));
        if (!this.firedAlertKeys.has(key)) {
          this.firedAlertKeys.add(key);
          const alert = this.raise({
            kind: 'CONTEXT_THRESHOLD',
            severity: crossed >= 95 ? 'CRITICAL' : crossed >= 85 ? 'WARNING' : 'INFO',
            scope: acc.scope,
            scopeId: acc.scopeId,
            sessionId,
            message:
              `Context is at ${percent.toFixed(1)}% of the ${snapshot.contextWindow.value}-token window ` +
              `for this ${acc.scope} (measured from the most recent Claude Code result envelope).`,
            condition: {
              metric: 'contextPercent',
              observedValue: percent,
              unit: 'percent',
              threshold: crossed,
              comparison: '>=',
              accuracy: snapshot.contextPercent.accuracy,
              source: snapshot.contextPercent.source,
            },
            actions: [
              SUGGESTED_ACTIONS.CHECKPOINT,
              SUGGESTED_ACTIONS.NEW_CONVERSATION,
              SUGGESTED_ACTIONS.REVIEW_ATTACHMENTS,
            ],
          });
          if (alert !== null) alerts.push(alert);
        }
      }
    }

    // Stale process — only meaningful where telemetry was flowing and stopped.
    if ((acc.scope === 'run' || acc.scope === 'session') && acc.usageEventCount > 0 && acc.lastTelemetryAtMs !== null) {
      const silentFor = nowMs - acc.lastTelemetryAtMs;
      const key = this.alertKey('PROCESS_STALE', acc, '');
      if (silentFor > this.stalenessThresholdMs) {
        if (!this.firedAlertKeys.has(key)) {
          this.firedAlertKeys.add(key);
          const alert = this.raise({
            kind: 'PROCESS_STALE',
            severity: 'WARNING',
            scope: acc.scope,
            scopeId: acc.scopeId,
            sessionId,
            message:
              `No usage telemetry has arrived for this ${acc.scope} in ${Math.round(silentFor / 1000)}s ` +
              `(threshold ${Math.round(this.stalenessThresholdMs / 1000)}s). Recorded totals are unchanged.`,
            condition: {
              metric: 'msSinceLastTelemetry',
              observedValue: silentFor,
              unit: 'ms',
              threshold: this.stalenessThresholdMs,
              comparison: '>',
              accuracy: 'DERIVED',
              source: 'derived:bridge clock now − timestamp of the last claude.usage event in scope',
            },
            actions: [SUGGESTED_ACTIONS.REVIEW_RUN, SUGGESTED_ACTIONS.REVIEW_EVENTS, SUGGESTED_ACTIONS.CHECK_HEALTH],
          });
          if (alert !== null) alerts.push(alert);
        }
      } else {
        this.firedAlertKeys.delete(key);
      }
    }

    // Retries
    if (judgedHere('RETRY_COUNT_HIGH', acc.scope) && this.hasSeen(RUN_STATE_EVENT_TYPE) && acc.retries >= this.retryAlertCount) {
      const key = this.alertKey('RETRY_COUNT_HIGH', acc, String(acc.retries));
      if (!this.firedAlertKeys.has(key)) {
        this.firedAlertKeys.add(key);
        const alert = this.raise({
          kind: 'RETRY_COUNT_HIGH',
          severity: 'WARNING',
          scope: acc.scope,
          scopeId: acc.scopeId,
          sessionId,
          message: `${acc.retries} retries have been recorded for this ${acc.scope} (threshold ${this.retryAlertCount}).`,
          condition: {
            metric: 'retries',
            observedValue: acc.retries,
            unit: 'count',
            threshold: this.retryAlertCount,
            comparison: '>=',
            accuracy: 'DERIVED',
            source: `derived:count of ${RUN_STATE_EVENT_TYPE} events with status RETRYING`,
          },
          actions: [SUGGESTED_ACTIONS.REVIEW_EVENTS, SUGGESTED_ACTIONS.REVIEW_RUN, SUGGESTED_ACTIONS.CHECKPOINT],
        });
        if (alert !== null) alerts.push(alert);
      }
    }

    // Repeated compaction
    const compactions = snapshot.compactions.value;
    if (judgedHere('REPEATED_COMPACTION', acc.scope) && compactions !== null && compactions >= this.compactionAlertCount) {
      const key = this.alertKey('REPEATED_COMPACTION', acc, String(compactions));
      if (!this.firedAlertKeys.has(key)) {
        this.firedAlertKeys.add(key);
        const qualifier =
          snapshot.compactions.accuracy === 'ESTIMATED'
            ? ' (detected by a local heuristic — the runtime does not report compaction)'
            : '';
        const alert = this.raise({
          kind: 'REPEATED_COMPACTION',
          severity: 'WARNING',
          scope: acc.scope,
          scopeId: acc.scopeId,
          sessionId,
          message: `${compactions} context compactions recorded for this ${acc.scope}${qualifier}.`,
          condition: {
            metric: 'compactions',
            observedValue: compactions,
            unit: 'count',
            threshold: this.compactionAlertCount,
            comparison: '>=',
            accuracy: snapshot.compactions.accuracy,
            source: snapshot.compactions.source,
          },
          actions: [SUGGESTED_ACTIONS.CHECKPOINT, SUGGESTED_ACTIONS.NEW_CONVERSATION, SUGGESTED_ACTIONS.REVIEW_ATTACHMENTS],
        });
        if (alert !== null) alerts.push(alert);
      }
    }

    // Long session
    const elapsed = snapshot.elapsedMs.value;
    if (judgedHere('LONG_SESSION', acc.scope) && elapsed !== null && elapsed >= this.longSessionMs) {
      const key = this.alertKey('LONG_SESSION', acc, '');
      if (!this.firedAlertKeys.has(key)) {
        this.firedAlertKeys.add(key);
        const alert = this.raise({
          kind: 'LONG_SESSION',
          severity: 'INFO',
          scope: acc.scope,
          scopeId: acc.scopeId,
          sessionId,
          message:
            `This session has spanned ${Math.round(elapsed / 60000)} minutes of observed events ` +
            `(threshold ${Math.round(this.longSessionMs / 60000)} minutes).`,
          condition: {
            metric: 'elapsedMs',
            observedValue: elapsed,
            unit: 'ms',
            threshold: this.longSessionMs,
            comparison: '>=',
            accuracy: snapshot.elapsedMs.accuracy,
            source: snapshot.elapsedMs.source,
          },
          actions: [SUGGESTED_ACTIONS.CHECKPOINT, SUGGESTED_ACTIONS.NEW_CONVERSATION],
        });
        if (alert !== null) alerts.push(alert);
      }
    }

    // Tool volume — a measured rate against a configured threshold. There is no
    // learned baseline here, so the message says rate, not "unusual".
    if (
      judgedHere('UNUSUAL_TOOL_VOLUME', acc.scope) &&
      this.hasSeen(TOOL_EVENT_TYPE) &&
      elapsed !== null &&
      elapsed >= MIN_ELAPSED_FOR_RATE_MS
    ) {
      const perMinute = acc.toolCalls / (elapsed / 60_000);
      const key = this.alertKey('UNUSUAL_TOOL_VOLUME', acc, '');
      if (perMinute >= this.toolRateAlert) {
        if (!this.firedAlertKeys.has(key)) {
          this.firedAlertKeys.add(key);
          const alert = this.raise({
            kind: 'UNUSUAL_TOOL_VOLUME',
            severity: 'INFO',
            scope: acc.scope,
            scopeId: acc.scopeId,
            sessionId,
            message:
              `${acc.toolCalls} tool calls over ${Math.round(elapsed / 60000)} minutes ` +
              `— ${perMinute.toFixed(1)} per minute, above the configured ${this.toolRateAlert} per minute.`,
            condition: {
              metric: 'toolCallsPerMinute',
              observedValue: perMinute,
              unit: 'count',
              threshold: this.toolRateAlert,
              comparison: '>=',
              accuracy: 'DERIVED',
              source: `derived:count of ${TOOL_EVENT_TYPE} events / observed elapsed minutes`,
            },
            actions: [SUGGESTED_ACTIONS.REVIEW_EVENTS, SUGGESTED_ACTIONS.CHECKPOINT],
          });
          if (alert !== null) alerts.push(alert);
        }
      } else {
        this.firedAlertKeys.delete(key);
      }
    }

    return alerts;
  }

  private evaluateLatency(): readonly UsageAlert[] {
    const stat = this.latency.stat('ingestion');
    if (!stat.measured || stat.p95Ms === null) return [];
    const key = 'EVENT_LATENCY_HIGH:bridge:ingestion:';
    if (stat.p95Ms < this.latencyAlertP95Ms) {
      this.firedAlertKeys.delete(key);
      return [];
    }
    if (this.firedAlertKeys.has(key)) return [];
    this.firedAlertKeys.add(key);
    const alert = this.raise({
      kind: 'EVENT_LATENCY_HIGH',
      severity: 'WARNING',
      scope: 'bridge',
      scopeId: 'ingestion',
      sessionId: null,
      message:
        `Measured ingestion latency p95 is ${stat.p95Ms.toFixed(1)}ms over ${stat.sampleCount} sample(s), ` +
        `above the ${this.latencyAlertP95Ms}ms alert threshold.`,
      condition: {
        metric: 'ingestionLatencyP95Ms',
        observedValue: stat.p95Ms,
        unit: 'ms',
        threshold: this.latencyAlertP95Ms,
        comparison: '>=',
        accuracy: accuracyForLatency(stat),
        source: SRC.latency(stat),
      },
      actions: [SUGGESTED_ACTIONS.CHECK_HEALTH, SUGGESTED_ACTIONS.EXPORT_DIAGNOSTICS],
    });
    return alert === null ? [] : [alert];
  }

  private alertKey(kind: AlertKind, acc: ScopeAccumulator, discriminator: string): string {
    return `${kind}:${acc.scope}:${acc.scopeId}:${discriminator}`;
  }

  private raise(input: {
    kind: AlertKind;
    severity: AlertSeverity;
    scope: AlertScope;
    scopeId: string;
    sessionId: string | null;
    message: string;
    condition: AlertCondition;
    actions: readonly SuggestedAction[];
  }): UsageAlert | null {
    const offending = containsPredictiveLanguage(input.message);
    if (offending !== null) {
      // Deliberately loud. An alert that predicts the future is a defect in this
      // file, not a runtime condition to be tolerated.
      throw new UsageAlertLanguageError(
        `alert message for ${input.kind} reads as a prediction ("${offending}"); alerts may only state measured conditions`,
        offending,
      );
    }
    this.alertSequence += 1;
    const alert: UsageAlert = {
      id: `alert-${this.alertSequence}-${input.kind.toLowerCase()}`,
      kind: input.kind,
      severity: input.severity,
      scope: input.scope,
      scopeId: input.scopeId,
      sessionId: input.sessionId,
      raisedAt: new Date(this.nowFn()).toISOString(),
      message: input.message,
      condition: input.condition,
      suggestedActions: input.actions,
    };
    this.activeAlerts.set(alert.id, alert);
    pushBounded(this.alertHistory, alert, DEFAULT_ALERT_HISTORY);
    this.alertsRaised += 1;
    for (const listener of this.alertListeners) {
      try {
        listener(alert);
      } catch {
        /* A broken listener must not take the telemetry layer down with it. */
      }
    }
    return alert;
  }

  /* ---------------------------------------------------------------------- */
  /*  Diagnostics                                                            */
  /* ---------------------------------------------------------------------- */

  getRejections(): readonly UsageRejection[] {
    return [...this.rejectionRing];
  }

  getAnomalies(): readonly UsageAnomaly[] {
    return [...this.anomalyRing];
  }

  getLatencyTracker(): LatencyTracker {
    return this.latency;
  }

  getStats(): AggregatorStats {
    const byType: Record<string, number> = {};
    for (const [type, count] of this.eventsSeenByType) byType[type] = count;
    return {
      trackedScopes: this.scopes.size,
      usageEventsIngested: this.usageEventsIngested,
      counterEventsIngested: this.counterEventsIngested,
      eventsIgnored: this.eventsIgnored,
      duplicatesDropped: this.duplicatesDropped,
      rejectionsTotal: Object.values(this.rejectionCounts).reduce((a, b) => a + b, 0),
      rejectionsByReason: { ...this.rejectionCounts },
      anomaliesTotal: this.anomaliesTotal,
      alertsRaised: this.alertsRaised,
      dedupWindowExceeded: this.dedupWindowExceeded,
      dedupTracked: this.seenEventIds.size,
      timeZone: this.timeZone,
      connected: this.connected,
      lastRebuildAt: this.lastRebuildAtMs === null ? null : new Date(this.lastRebuildAtMs).toISOString(),
      eventsSeenByType: byType,
    };
  }

  /* ---------------------------------------------------------------------- */
  /*  Internals                                                             */
  /* ---------------------------------------------------------------------- */

  private rememberEventId(eventId: string): void {
    this.seenEventIds.add(eventId);
    if (this.seenEventIds.size > this.dedupCapacity) {
      // Idempotency past this point is bounded, and `getStats()` says so rather
      // than letting a caller assume perfect replay protection forever.
      this.dedupWindowExceeded = true;
      const oldest = this.seenEventIds.values().next();
      if (!oldest.done) this.seenEventIds.delete(oldest.value);
    }
  }

  private recordRejection(input: Omit<UsageRejection, 'at'>): UsageRejection {
    const rejection: UsageRejection = { at: new Date(this.nowFn()).toISOString(), ...input };
    this.rejectionCounts[rejection.reason] += 1;
    pushBounded(this.rejectionRing, rejection, DEFAULT_REJECTION_RING);
    return rejection;
  }

  private recordAnomaly(input: Omit<UsageAnomaly, 'at'>): UsageAnomaly {
    const anomaly: UsageAnomaly = { at: new Date(this.nowFn()).toISOString(), ...input };
    this.anomaliesTotal += 1;
    pushBounded(this.anomalyRing, anomaly, DEFAULT_ANOMALY_RING);
    return anomaly;
  }

  private result(
    accepted: boolean,
    eventId: string,
    scopesUpdated: readonly ScopeRef[],
    rejections: readonly UsageRejection[],
    anomalies: readonly UsageAnomaly[],
    alerts: readonly UsageAlert[],
    delta: UsageDelta | null,
  ): IngestResult {
    return { accepted, eventId, scopesUpdated, rejections, anomalies, alerts, delta };
  }
}

/* ========================================================================== */
/*  Free helpers                                                               */
/* ========================================================================== */

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Context occupancy is not a field the CLI reports. This is the documented sum
 * that stands in for it — arithmetic over EXACT envelope values, hence DERIVED,
 * with the formula written into `source` so it can be argued with.
 */
export function contextTokensFrom(parsed: ParsedEnvelope): number | null {
  const parts = [parsed.inputTokens, parsed.cacheReadTokens, parsed.cacheCreationTokens, parsed.outputTokens];
  if (parts.every((part) => part === null)) return null;
  return parts.reduce<number>((total, part) => total + (part ?? 0), 0);
}

/**
 * A latency percentile built from two-clock samples is an approximation, so it
 * degrades to ESTIMATED. Single-clock samples are a real measurement of this
 * process, so their percentile is DERIVED.
 */
export function accuracyForLatency(stat: LatencyStat): Accuracy {
  if (!stat.measured || stat.p95Ms === null) return 'UNAVAILABLE';
  return stat.clockBasis === 'same-process' ? 'DERIVED' : 'ESTIMATED';
}

/** Factory, matching the house style of `openStore()`. */
export function createUsageAggregator(options: AggregatorOptions = {}): UsageAggregator {
  return new UsageAggregator(options);
}
