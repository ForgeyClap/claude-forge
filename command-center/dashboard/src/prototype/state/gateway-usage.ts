/**
 * gateway-usage.ts — real, honest data for the Claude usage strip (`UsageBar`).
 *
 * WP cc-wire-usage. `UsageBar.tsx` used to read `getSharedLiveStore().call('getUsageState', …)`
 * — the bridge's own 39-op WebSocket protocol on `127.0.0.1:4517`, which `live-store.ts`'s own
 * header already documents as constructed but NEVER connected. So `pickScope()` there always saw
 * an empty `LiveState` (`state.runs`/`state.events` permanently `[]`) and the bar was permanently
 * stuck on "No active run — usage is UNAVAILABLE". This file is the real seam that replaces it,
 * built the same way `gateway-adapter.ts`/`gateway-chat.ts` already replaced the rest of the
 * bridge: real gateway sources where they exist, an explicit, typed absence everywhere else.
 *
 * WHAT IS ACTUALLY REAL HERE (ground truth from `gateway/src/usage.mjs` and
 * `gateway/src/conversations.mjs` / `exec-bridge.mjs`, read before writing this file):
 *
 *   - Account-wide usage-pressure (guard level / week / NVIDIA-shift + pause thresholds / freshness)
 *     — `GET /api/usage`, already parsed by `useGatewayAccountUsage()` (`gateway-adapter.ts`).
 *   - Connection — `useGatewayConnection()` (`gateway-adapter.ts`), already real.
 *   - Latency — a real client-measured p95 round trip on the gateway's own `/api/health` poll,
 *     `useGatewayLatency()` (`gateway-adapter.ts`, added this WP).
 *   - The current run — the ACTIVE CONVERSATION's real send/execution state,
 *     `useChatSend().run` (`gateway-chat.ts`'s `useGatewayChatSendController`, unedited — this file
 *     only READS its public `ChatRunView` contract).
 *
 * WHAT IS REAL, PER CONVERSATION (fix-crossproject P1-5, forge-2026-07-29-cc-finish): `costUsd` and
 * `elapsedMs` are genuinely measured and stored — `exec-bridge.mjs` writes real `cost_usd`/`duration_ms`
 * on every completed assistant turn, `conversations.mjs` serves the full turn records back unredacted
 * (verified live against the running gateway, not assumed), and `gateway-chat.ts`'s `toGatewayMessage`
 * carries both straight through instead of dropping them. `sumConversationUsage` below sums them over
 * the conversation's real assistant turns; a turn the gateway recorded no value for contributes nothing,
 * never a fabricated `0`.
 *
 * fix-usage-capture (checkup MEDIUM-upgrade, this run): the claude CLI's own real stream-json
 * `result` line ALSO carries a full `usage` block (`input_tokens`/`output_tokens`/
 * `cache_creation_input_tokens`/`cache_read_input_tokens`) and a `modelUsage` object naming the
 * model actually used — verified live against 9 real (non-mock) `result` events already stored in
 * this project's own `.data/conversations/*.jsonl` (see this WP's forge-report for the exact
 * captured JSON). `exec-bridge.mjs` now reads these off the same `resultPayload` it was already
 * parsing and writes them onto the turn (`input_tokens`/`output_tokens`/
 * `cache_creation_input_tokens`/`cache_read_input_tokens`/`model`); `gateway-chat.ts`'s
 * `toGatewayMessage` carries all five through exactly like `costUsd`/`durationMs`. `sumConversationUsage`
 * sums the four token counts the same way it already summed cost/duration; `model` is the most
 * recent real value any assistant turn in the conversation reported (not summed — a running
 * conversation can genuinely switch models across turns). Every one of these becomes a `DERIVED`
 * `UsageField` when the conversation's own real turns supplied a value, and stays the same honest
 * `UNAVAILABLE` absence when they did not (mock mode, a spawn error, a still-in-flight turn, or a
 * turn recorded before this fix existed) — never a fabricated `0`/`''`.
 *
 * fix-unavailable (forge-2026-07-30-cc-finish, checkup — closes the owner's "we zien ook veel
 * unavailable" complaint): three MORE fields turned out to have a real, on-disk source after all,
 * the same way `costUsd`/`elapsedMs`/tokens/`model` did above — this WP's header comment about
 * "the conversation turn stores nothing about context-window occupancy, session id, or per-turn
 * agent dispatch" was itself factually wrong by the time it was checked against the CLI's real
 * stream-json output (verified against this project's own `.data/conversations/*.jsonl` — see this
 * WP's forge-report for the exact grep evidence):
 *   - SESSION: the CLI reports its own real session id on almost every stream-json line it emits
 *     (not only the final `result` line) — `exec-lifecycle.mjs` captures it live and writes it onto
 *     the completed assistant turn's own `session_id` key.
 *   - CONTEXT WINDOW / OCCUPANCY: `result.modelUsage[model].contextWindow` sits on the exact SAME
 *     object `model`/`canonicalModel` already come from — `exec-lifecycle.mjs` now reads it too.
 *     **HARD RULE:** context occupancy is a point-in-time fact, not a running total — the SAME
 *     honest reasoning `model` already uses ("most recent report, never summed") applies here even
 *     more strongly, since summing every turn's own reported figure would only ever grow and would
 *     misrepresent what the model's context ACTUALLY holds right now. `latestContextOccupancy`
 *     below reads ONLY the most recent assistant turn that reported one.
 *   - AGENT: a real `Agent` tool_use block's `input.subagent_type` (verified: 102 occurrences in one
 *     real conversation, e.g. `"Explore"`/`"Plan"`) — `exec-lifecycle.mjs` captures the most recently
 *     dispatched one per turn and writes it onto the completed turn's own `agent_type` key.
 * Every one of these becomes a real `DERIVED` value when a completed assistant turn reported it, and
 * stays the same honest absence when none did (mock mode, a spawn error, a still-in-flight turn with
 * no closed turn yet, or a turn recorded before these fields existed) — never a fabricated value.
 *
 * SKILL genuinely stays UNAVAILABLE — unlike the three above, no skill dispatch has ever been
 * observed anywhere in this project's own stored conversations (a "never observed", not a proven
 * absence — see `SKILL_LABEL_UNAVAILABLE`'s own doc comment).
 *
 * WHAT STAYS HONESTLY UNAVAILABLE, and why: a per-conversation turn/tool-call/agent-or-skill-use
 * COUNT, an error/retry/compaction count, and an ingestion-latency figure are not tracked anywhere
 * in this gateway at all — genuinely unmeasured, not merely unfetched. `buildEmptyConversationSnapshot`
 * below builds the one honest `UsageSnapshot` this backend can produce: every field this gateway
 * genuinely records real when a turn supplied it, every OTHER measured `UsageField` explicitly
 * `UNAVAILABLE`, never a plausible-looking number standing in for one that was never recorded.
 *
 * BRIDGE-DEPENDENCY DECISION: this file, `UsageBar.tsx` and `UsageDetails.tsx` import nothing —
 * neither types nor runtime calls — from `@/bridge/**` or `live-store.ts`'s `useLatency()`/
 * `getSharedLiveStore()`. All 35 `src/bridge/**` files stay on disk untouched (owner rule: nothing
 * is deleted); this is purely about what the usage strip DEPENDS ON to render.
 */

import type { ConnectionState } from '@/prototype/state/bridge-client';
import type { GatewayAccountUsage, GatewayLatency } from '@/prototype/state/gateway-adapter';
import type { ChatRunView } from '@/prototype/state/chat-send';
import { readChatMessageUsage } from '@/prototype/state/gateway-chat';
import type { ChatMessage } from '@/prototype/types/prototype-types';
import type { OperationalStatus } from '@/shared/protocol';
import { PLAN_USAGE_UNAVAILABLE_MESSAGE } from '@/shared/protocol';
import type { Accuracy, UsageField, UsageSnapshot } from '@/shared/protocol';

/* ========================================================================== */
/*  1. The one honest per-conversation snapshot this gateway can build        */
/* ========================================================================== */

const NO_CONVERSATION_TELEMETRY =
  'This gateway does not track this figure for any conversation at all (gateway/src/conversations.mjs turns carry cost_usd/duration_ms/stop_reason/session_id/context_window/agent_type, plus — since fix-usage-capture — input_tokens/output_tokens/cache_*_tokens/model, whenever the CLI reported them — but a turn count, tool-call count, agent/skill invocation COUNT, error/retry/compaction count, or ingestion-latency figure is not recorded anywhere in this gateway) — this field is genuinely unmeasured, not merely unfetched.';

/** fix-usage-capture: the precise reason a token/model field is UNAVAILABLE for THIS
 *  conversation specifically — unlike `NO_CONVERSATION_TELEMETRY` above, these fields ARE
 *  genuinely recorded by the gateway when the CLI reports them; an absence here means no
 *  assistant turn in this particular conversation reported one yet (mock mode, a spawn error, a
 *  still-in-flight turn, or a turn recorded before this fix existed), not a categorical gap. */
const NO_TURN_USAGE_TELEMETRY =
  "No assistant turn in this conversation reported this value — the claude CLI's own stream-json `result` event carries usage/model data only on a normal completion (mock mode, a spawn error, a still-in-flight turn, or a turn recorded before this field existed will have none).";

const CONVERSATION_COST_SOURCE =
  'Derived by summing the real cost_usd the gateway recorded on every completed assistant turn (gateway/src/exec-bridge.mjs writes it, gateway/src/conversations.mjs serves it back unredacted) — a turn the gateway recorded no value for contributes nothing, never a fabricated 0.';

const CONVERSATION_DURATION_SOURCE =
  "Derived by summing the real duration_ms the gateway recorded on every completed assistant turn (same source as costUsd) — this is per-turn CLI execution time, not the conversation's session-elapsed wall clock.";

const CONVERSATION_TOKENS_SOURCE =
  "Derived by summing the real usage.input_tokens/output_tokens/cache_creation_input_tokens/cache_read_input_tokens the gateway recorded on every completed assistant turn (gateway/src/exec-bridge.mjs reads them off the claude CLI's own stream-json result.usage, gateway/src/conversations.mjs serves them back unredacted) — a turn the gateway recorded no value for contributes nothing, never a fabricated 0.";

const CONVERSATION_MODEL_SOURCE =
  "The real model name from the most recent assistant turn that reported one (gateway/src/exec-bridge.mjs reads result.modelUsage's canonicalModel off the claude CLI's own stream-json result) — a conversation can genuinely switch models across turns, so this is the latest real report, not a conversation-wide constant.";

/** fix-unavailable: shared by contextTokensUsed/contextWindow/contextPercent — all three come from
 *  the SAME most-recent assistant turn's own real report, never a running total (see this file's
 *  header for the full HARD RULE rationale). */
const CONVERSATION_CONTEXT_SOURCE =
  "Read from the MOST RECENT assistant turn that reported a context window (gateway/src/exec-lifecycle.mjs writes contextWindow off the claude CLI's own stream-json result.modelUsage[model].contextWindow — the SAME entry model/canonicalModel come from). contextTokensUsed sums that SAME turn's own input_tokens+cache_creation_input_tokens+cache_read_input_tokens — the actual prompt size sent to the model on that one call. Context occupancy is a point-in-time fact: it is deliberately NEVER summed across turns the way cost/duration are — a running total would only ever grow and would misrepresent the model's real, current context usage.";

function unavailableField<T = number>(name: string, unit: UsageField<T>['unit'], source: string): UsageField<T> {
  return { name, value: null, unit, source, accuracy: 'UNAVAILABLE', updatedAt: '' };
}

/** A real, summed (or, for `model`, most-recently-reported) value becomes a `DERIVED` field
 *  (built from the gateway's own EXACT per-turn values); `null` (no assistant turn measured it)
 *  stays the same honest `UNAVAILABLE` shape as every other field here. `unavailableSource` lets
 *  a conditionally-available field (token counts, model) carry a more precise absence reason than
 *  the default `NO_CONVERSATION_TELEMETRY` — a genuinely-never-recorded field's reason. */
function measuredOrUnavailable<T = number>(
  name: string,
  value: T | null,
  unit: UsageField<T>['unit'],
  measuredSource: string,
  unavailableSource: string = NO_CONVERSATION_TELEMETRY,
): UsageField<T> {
  if (value === null) return unavailableField<T>(name, unit, unavailableSource);
  return { name, value, unit, source: measuredSource, accuracy: 'DERIVED', updatedAt: '' };
}

/* ========================================================================== */
/*  1a. Real per-conversation cost/duration — summed from real assistant turns */
/* ========================================================================== */

export interface ConversationUsageTotals {
  readonly costUsd: number | null;
  readonly elapsedMs: number | null;
  /**
   * fix-usage-capture: summed the same way as `costUsd`/`elapsedMs` — see `sumConversationUsage`.
   * Optional (rather than required) so a pre-existing literal totals object built before this
   * field existed (e.g. `{ costUsd: 1, elapsedMs: 100 }` in an older test) keeps compiling
   * unchanged; `buildEmptyConversationSnapshot` reads it via `usage.inputTokens ?? null`.
   */
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  readonly cacheReadTokens?: number | null;
  readonly cacheCreationTokens?: number | null;
  /** fix-usage-capture: the most recent real model any assistant turn reported — never summed. */
  readonly model?: string | null;
  /**
   * fix-unavailable: the most recent real session id / Agent-dispatch subagent_type any assistant
   * turn reported — same "latest known, never summed" semantics as `model` above.
   */
  readonly sessionId?: string | null;
  readonly agentType?: string | null;
  /**
   * fix-unavailable — HARD RULE: from the SINGLE most recent assistant turn that reported a
   * context window, never summed across turns (see `latestContextOccupancy`). `contextTokensUsed`
   * is that SAME turn's own input+cache-creation+cache-read tokens (its real prompt size).
   */
  readonly contextTokensUsed?: number | null;
  readonly contextWindow?: number | null;
}

/** The honest default: no turns supplied, so every total stays an absence —
 *  identical to this file's behaviour before real totals were wired in. */
export const EMPTY_CONVERSATION_USAGE_TOTALS: ConversationUsageTotals = {
  costUsd: null,
  elapsedMs: null,
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheCreationTokens: null,
  model: null,
  sessionId: null,
  agentType: null,
  contextTokensUsed: null,
  contextWindow: null,
};

/** Sums one real numeric field over every assistant (`author: 'forge'`) message that
 *  actually reported it. `null`, never `0`, when NOT ONE assistant message in
 *  this conversation reported the field — an unmeasured/turn-less
 *  conversation stays an honest absence rather than a fabricated zero. */
function sumMeasuredField(messages: readonly ChatMessage[], pick: (usage: ReturnType<typeof readChatMessageUsage>) => number | null): number | null {
  let sum = 0;
  let measured = false;
  for (const message of messages) {
    if (message.author !== 'forge') continue; // only assistant turns carry cost_usd/duration_ms/tokens/model
    const value = pick(readChatMessageUsage(message));
    if (value === null) continue;
    sum += value;
    measured = true;
  }
  return measured ? sum : null;
}

/** fix-usage-capture / fix-unavailable: "most recent real report, never an arithmetic sum" — the
 *  shared shape `model`/`sessionId`/`agentType` all use. A running conversation can genuinely
 *  switch models or dispatch a new sub-agent across turns, so each is a "latest known" read.
 *  `null` when NOT ONE assistant turn in this conversation reported one. */
function latestMeasuredString(
  messages: readonly ChatMessage[],
  pick: (usage: ReturnType<typeof readChatMessageUsage>) => string | null,
): string | null {
  let latest: string | null = null;
  for (const message of messages) {
    if (message.author !== 'forge') continue;
    const value = pick(readChatMessageUsage(message));
    if (value !== null) latest = value;
  }
  return latest;
}

function latestMeasuredModel(messages: readonly ChatMessage[]): string | null {
  return latestMeasuredString(messages, (usage) => usage.usageModel);
}

function latestMeasuredSessionId(messages: readonly ChatMessage[]): string | null {
  return latestMeasuredString(messages, (usage) => usage.sessionId);
}

function latestMeasuredAgentType(messages: readonly ChatMessage[]): string | null {
  return latestMeasuredString(messages, (usage) => usage.agentType);
}

/** fix-unavailable: sums the THREE token counts that make up one turn's own real prompt size
 *  (input + cache-creation + cache-read) — a measured `0` (a real, reported zero) counts;
 *  `null` only when NOT ONE of the three was reported for this specific turn. */
function sumContextTriple(usage: ReturnType<typeof readChatMessageUsage>): number | null {
  let sum = 0;
  let measured = false;
  for (const value of [usage.inputTokens, usage.cacheCreationTokens, usage.cacheReadTokens]) {
    if (value === null) continue;
    sum += value;
    measured = true;
  }
  return measured ? sum : null;
}

/**
 * fix-unavailable — HARD RULE: context occupancy is a point-in-time fact, never summed across
 * turns. Reads ONLY the MOST RECENT assistant turn (working backward from the end of the
 * conversation) that reported a real contextWindow, and pairs it with THAT SAME turn's own
 * contextTokensUsed — never an earlier turn's figure, and never an arithmetic total over several
 * turns (which would only ever grow and would misrepresent what the model's context actually holds
 * right now). `{ contextTokensUsed: null, contextWindow: null }` when NOT ONE assistant turn in
 * this conversation reported a context window yet.
 */
export function latestContextOccupancy(messages: readonly ChatMessage[]): { contextTokensUsed: number | null; contextWindow: number | null } {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.author !== 'forge') continue;
    const usage = readChatMessageUsage(message);
    if (usage.contextWindow === null) continue;
    return { contextTokensUsed: sumContextTriple(usage), contextWindow: usage.contextWindow };
  }
  return { contextTokensUsed: null, contextWindow: null };
}

/** `null` (never NaN/Infinity) unless both a real used figure and a real, positive window exist. */
function computeContextPercent(contextTokensUsed: number | null, contextWindow: number | null): number | null {
  if (contextTokensUsed === null || contextWindow === null || contextWindow <= 0) return null;
  return (contextTokensUsed / contextWindow) * 100;
}

/**
 * The real per-conversation totals — summed (or, for `model`, most-recently-reported) over the
 * conversation's own real assistant turns (`gateway-chat.ts`'s `toGatewayMessage` carries
 * `cost_usd`/`duration_ms`/the fix-usage-capture token/model fields onto each message; see this
 * file's header for the live-verified ground truth). Pass the active conversation's `messages`
 * (e.g. `selectConversation(state, id)?.messages`); an empty/omitted list is the same honest
 * absence this file always reported.
 */
export function sumConversationUsage(messages: readonly ChatMessage[]): ConversationUsageTotals {
  const context = latestContextOccupancy(messages);
  return {
    costUsd: sumMeasuredField(messages, (usage) => usage.costUsd),
    elapsedMs: sumMeasuredField(messages, (usage) => usage.durationMs),
    inputTokens: sumMeasuredField(messages, (usage) => usage.inputTokens),
    outputTokens: sumMeasuredField(messages, (usage) => usage.outputTokens),
    cacheReadTokens: sumMeasuredField(messages, (usage) => usage.cacheReadTokens),
    cacheCreationTokens: sumMeasuredField(messages, (usage) => usage.cacheCreationTokens),
    model: latestMeasuredModel(messages),
    sessionId: latestMeasuredSessionId(messages),
    agentType: latestMeasuredAgentType(messages),
    contextTokensUsed: context.contextTokensUsed,
    contextWindow: context.contextWindow,
  };
}

/**
 * `costUsd`/`elapsedMs`/`model`/token-count fields real when `usage` carries a real value (see
 * `sumConversationUsage` above); every other measured scalar `UNAVAILABLE`, `scope`/`scopeId`
 * real. This is what lets `UsageBar`'s existing FieldValue/AccuracyChip markup render its honest
 * chips truthfully instead of hanging on a dead bridge call that never resolves.
 */
export function buildEmptyConversationSnapshot(
  scope: UsageSnapshot['scope'],
  scopeId: string,
  usage: ConversationUsageTotals = EMPTY_CONVERSATION_USAGE_TOTALS,
  /** Real timestamp of this scope's most recent turn; '' only when there genuinely is no turn. */
  lastUpdate: string = '',
): UsageSnapshot {
  const contextTokensUsed = usage.contextTokensUsed ?? null;
  const contextWindow = usage.contextWindow ?? null;
  return {
    scope,
    scopeId,
    // fix-unavailable: real, from the most recent assistant turn that reported one (see
    // `latestMeasuredSessionId`) — null only when NOT ONE completed turn in this conversation has
    // reported a session id yet.
    sessionId: usage.sessionId ?? null,
    model: measuredOrUnavailable<string>('model', usage.model ?? null, 'none', CONVERSATION_MODEL_SOURCE, NO_TURN_USAGE_TELEMETRY),
    effort: unavailableField<string>('effort', 'none', NO_CONVERSATION_TELEMETRY),
    inputTokens: measuredOrUnavailable('inputTokens', usage.inputTokens ?? null, 'tokens', CONVERSATION_TOKENS_SOURCE, NO_TURN_USAGE_TELEMETRY),
    outputTokens: measuredOrUnavailable('outputTokens', usage.outputTokens ?? null, 'tokens', CONVERSATION_TOKENS_SOURCE, NO_TURN_USAGE_TELEMETRY),
    cacheReadTokens: measuredOrUnavailable('cacheReadTokens', usage.cacheReadTokens ?? null, 'tokens', CONVERSATION_TOKENS_SOURCE, NO_TURN_USAGE_TELEMETRY),
    cacheCreationTokens: measuredOrUnavailable('cacheCreationTokens', usage.cacheCreationTokens ?? null, 'tokens', CONVERSATION_TOKENS_SOURCE, NO_TURN_USAGE_TELEMETRY),
    // fix-unavailable — HARD RULE: `usage.contextTokensUsed`/`usage.contextWindow` are already the
    // MOST RECENT turn's own figures (see `latestContextOccupancy`), never a sum — this function
    // only wraps them in the honest UsageField shape.
    contextTokensUsed: measuredOrUnavailable('contextTokensUsed', contextTokensUsed, 'tokens', CONVERSATION_CONTEXT_SOURCE, NO_TURN_USAGE_TELEMETRY),
    contextWindow: measuredOrUnavailable('contextWindow', contextWindow, 'tokens', CONVERSATION_CONTEXT_SOURCE, NO_TURN_USAGE_TELEMETRY),
    contextPercent: measuredOrUnavailable('contextPercent', computeContextPercent(contextTokensUsed, contextWindow), 'percent', CONVERSATION_CONTEXT_SOURCE, NO_TURN_USAGE_TELEMETRY),
    costUsd: measuredOrUnavailable('costUsd', usage.costUsd, 'usd', CONVERSATION_COST_SOURCE),
    turns: unavailableField('turns', 'count', NO_CONVERSATION_TELEMETRY),
    toolCalls: unavailableField('toolCalls', 'count', NO_CONVERSATION_TELEMETRY),
    agentCount: unavailableField('agentCount', 'count', NO_CONVERSATION_TELEMETRY),
    skillUses: unavailableField('skillUses', 'count', NO_CONVERSATION_TELEMETRY),
    errors: unavailableField('errors', 'count', NO_CONVERSATION_TELEMETRY),
    retries: unavailableField('retries', 'count', NO_CONVERSATION_TELEMETRY),
    compactions: unavailableField('compactions', 'count', NO_CONVERSATION_TELEMETRY),
    elapsedMs: measuredOrUnavailable('elapsedMs', usage.elapsedMs, 'ms', CONVERSATION_DURATION_SOURCE),
    eventLatencyP95: unavailableField('eventLatencyP95', 'ms', NO_CONVERSATION_TELEMETRY),
    // Real when this scope has a turn (the caller passes the latest turn's own timestamp); '' only
    // when there is genuinely nothing recorded yet — never a permanent em dash on a live scope.
    lastUpdate,
    // This bar's own visible "stale" pill is driven by the REAL account-usage
    // `age_ms` (see `computeStale` below), a different, genuinely-measured
    // concept — this per-conversation field stays honestly false: there is no
    // per-conversation telemetry to be stale about.
    stale: false,
    planUsage: unavailableField<string>('planUsage', 'none', PLAN_USAGE_UNAVAILABLE_MESSAGE),
  };
}

/** A field this bar could never source, ready for `DerivedValue`. Never invented. */
export interface GatewayDerivedLabel {
  readonly text: string;
  readonly accuracy: Accuracy;
  readonly title: string;
}

/**
 * fix-unavailable: the honest absence for THIS conversation specifically — a real `Agent`
 * tool_use dispatch (`gateway/src/exec-lifecycle.mjs`'s `agent_type`) genuinely exists as gateway
 * telemetry (see this file's own header), so the old blanket "no telemetry exists in this gateway"
 * claim was false; this now means "no completed turn in this conversation has dispatched a
 * sub-agent yet" — mock mode, a spawn error, a still-in-flight turn, or a conversation that
 * genuinely never called the Agent tool.
 */
export const AGENT_LABEL_UNAVAILABLE: GatewayDerivedLabel = {
  text: 'n/a',
  accuracy: 'UNAVAILABLE',
  title: 'No completed turn in this conversation has dispatched a sub-agent (Agent tool_use) yet.',
};

/**
 * fix-unavailable: unlike AGENT, this stays UNAVAILABLE unconditionally — no skill dispatch has
 * EVER been observed in this project's own stored conversations (a "never observed", not a proven
 * absence: the claude CLI may report one under a shape this gateway does not yet recognize).
 */
export const SKILL_LABEL_UNAVAILABLE: GatewayDerivedLabel = {
  text: 'n/a',
  accuracy: 'UNAVAILABLE',
  title: "No skill dispatch has ever been observed in this gateway's stored conversations — genuinely never observed, not proven absent.",
};

/**
 * fix-unavailable: the real, most-recently-dispatched subagent_type when this conversation's
 * turns reported one (see `latestMeasuredAgentType`); the same honest `AGENT_LABEL_UNAVAILABLE`
 * otherwise. Mirrors `measuredOrUnavailable`'s "real value or honest absence" shape, one level up
 * (a label, not a `UsageField`).
 */
export function buildAgentLabel(agentType: string | null): GatewayDerivedLabel {
  if (agentType === null) return AGENT_LABEL_UNAVAILABLE;
  return {
    text: agentType,
    accuracy: 'DERIVED',
    title:
      "The most recently dispatched sub-agent (Agent tool_use's own subagent_type) in this conversation — gateway/src/exec-lifecycle.mjs captures it live off the claude CLI's real stream-json output, written onto the completed assistant turn's own agent_type field.",
  };
}

/**
 * fix-ui-clutter (item 1): the one honest, compact replacement for a WALL of individually
 * "UNAVAILABLE"-labelled rows/tooltips, each previously repeating its own long provenance
 * sentence (`NO_CONVERSATION_TELEMETRY` above) — a person scanning the usage panel does not
 * need that same paragraph re-explained per field once the pattern is clear from ONE line. Used
 * by `UsageBar.tsx` (as a shortened tooltip, replacing the long per-field `field.source` text)
 * and `UsageDetails.tsx` (as the single summary line standing in for every unmeasured field in
 * "Measured fields"). Hiding an unmeasured field is honest; repeating the same explanation once
 * per field is noise, not honesty.
 */
// fix-unavailable: the old wording named context window/session/agents/skills as always
// unmeasured — no longer true (see this file's header). Kept generic rather than re-itemized: this
// same tooltip fires for ANY unmeasured field (a `costUsd`/`elapsedMs` genuinely absent for a
// conversation with no completed turn yet included), so "for this conversation" is the honest,
// still-compact framing rather than a field-by-field list that would drift stale again the next
// time a field becomes real.
export const NOT_MEASURED_SUMMARY =
  'Not measured by this gateway for this conversation';

/* ========================================================================== */
/*  2. The current run — real, from the active conversation's send controller */
/* ========================================================================== */

/** The one field `UsageBar`/`UsageDetails` actually render — decoupled from `LiveRun`. */
export interface GatewayUsageRun {
  readonly operationalStatus: OperationalStatus | null;
}

/**
 * `useChatSend()`'s `ChatRunView` is already real (a pending turn id plus a real
 * follow-up assistant/stop/error record — see `gateway-chat.ts`'s own honesty
 * rules), so this is a pure reshape, never a guess. `null` when there is no
 * production chat controller mounted (fixtures) — the caller's existing
 * `scopeInfo === null` / fallback text already covers that case.
 */
export function toGatewayUsageRun(run: ChatRunView | null): GatewayUsageRun | null {
  if (run === null) return null;
  return { operationalStatus: run.status };
}

/* ========================================================================== */
/*  3. Freshness — real, from the account-usage pressure reading's age_ms     */
/* ========================================================================== */

/**
 * Mirrors `AccountUsagePressure.tsx`'s own `STALE_AFTER_MS` reasoning: the
 * owner's `usage-guard.cjs` defaults to a 120s watch cadence, so a reading
 * older than 30 minutes (15x that cadence) most likely means the watcher is
 * not currently running, rather than that usage genuinely has not moved. A UI
 * hint, never asserted as fact.
 */
export const STALE_AFTER_MS = 30 * 60 * 1000;

/** `ageMs === null` (no reading at all) is honestly NOT stale — absence of evidence is not evidence of staleness, and this pill's only job is to flag known staleness, never to assert freshness it cannot back up. */
export function computeStale(ageMs: number | null, staleAfterMs: number = STALE_AFTER_MS): boolean {
  return ageMs !== null && Number.isFinite(ageMs) && ageMs > staleAfterMs;
}

/* ========================================================================== */
/*  4. Guard / week / threshold — real, surfaced as tooltip text (no new DOM) */
/* ========================================================================== */

function formatAge(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

/**
 * The bar's design is frozen (no new visible text/DOM), so guard level / week /
 * NVIDIA-shift + pause thresholds surface as a `title` tooltip on the existing
 * connection indicator rather than a new element — real values only, same
 * "never a plausible-looking number" rule as everywhere else in this file.
 */
export function formatGuardTooltip(usage: GatewayAccountUsage): string {
  if (usage.provenance === 'NOT CONFIGURED') return 'Forge usage-pressure: not configured on this machine.';
  if (usage.provenance === 'UNVERIFIED') return usage.note ?? 'Forge usage-pressure file present but unreadable.';
  const ageLabel = formatAge(usage.ageMs);
  const parts = [
    `week usage ${usage.week !== null ? `${usage.week}%` : 'n/a'}`,
    `pressure ${usage.level ?? 'n/a'}`,
    usage.nvidiaShiftAt !== null ? `NVIDIA-shift at ${usage.nvidiaShiftAt}%` : null,
    usage.pauseAt !== null ? `pause at ${usage.pauseAt}%` : null,
    usage.guard.available ? `guard ${usage.guard.mode ?? 'unknown'}` : 'guard n/a',
    ageLabel !== null ? `updated ${ageLabel}` : null,
  ];
  const real = parts.filter((p): p is string => p !== null);
  return `Forge usage: ${real.join(' · ')}`;
}

/* ========================================================================== */
/*  5. Gateway-down — reuses the bar's existing "problem" branch honestly     */
/* ========================================================================== */

/**
 * The bar's existing markup already has a dedicated branch for "usage cannot be
 * shown, here is why" (previously always the dead bridge's "no handler
 * registered"). Repurposed to the real, actionable case: the gateway itself is
 * unreachable, so the bar says so instead of freezing on stale numbers.
 * `CONNECTING`/`DEGRADED` are transient and stay on the normal honest-empty
 * fields rather than flashing an error.
 */
export function resolveGatewayProblem(status: ConnectionState['status'], detail: string | null): string | null {
  return status === 'DISCONNECTED' ? detail : null;
}

/* ========================================================================== */
/*  6. UsageDetails — a full local shape, decoupled from the dead bridge      */
/* ========================================================================== */

/** Replaces `UsageStateResult` for `UsageDetails.tsx` — same field names it already reads, none of the bridge-only concepts (binding policy, event-log coverage, ingestion-channel latency) that have no gateway equivalent. */
export interface GatewayUsageState {
  readonly scope: UsageSnapshot['scope'];
  readonly scopeId: string;
  readonly snapshot: UsageSnapshot;
  /** No gateway equivalent — always null, never invented. */
  readonly bindingPolicy: string | null;
  /**
   * fix-unavailable: real when the caller supplies real evidence (`observedEvidence.hasAnyTurn`) —
   * this conversation genuinely has at least one recorded turn. `false` by default (the honest
   * "no evidence supplied" absence this file always reported before this fix).
   */
  readonly observed: boolean;
  /** No gateway equivalent — always null, never invented. Rendered nowhere (item 4: the
   *  permanently-empty "Rebuilt at" row was removed from UsageDetails.tsx). */
  readonly coverage: { readonly rebuiltAt: string | null };
  /** No gateway equivalent — always empty, so the existing warnings section stays honestly unrendered. */
  readonly warnings: readonly string[];
  readonly latency: {
    readonly channels: {
      readonly ingestion?: { readonly p95: { readonly field: UsageField } };
    };
  };
  /**
   * fix-unavailable: the real timestamp of this conversation's earliest recorded turn (its own
   * `created_at`) when the caller supplies one — `null` when the caller supplies none (an empty
   * conversation). Powers UsageDetails' "Start (first event)" row instead of the dead, always-empty
   * sparkline history it used to read from.
   */
  readonly firstEventAt: string | null;
  /** fix-unavailable: the real, most-recently-dispatched subagent_type (see `buildAgentLabel`) — `null` when none. */
  readonly agentType: string | null;
}

/**
 * fix-unavailable: real evidence for `observed`/`firstEventAt` — the caller (`UsageBar.tsx`) already
 * has the conversation's own `messages`; this keeps that evidence explicit rather than reaching back
 * into `usage` (a summary of MEASURED scalars, not "does this scope have any turn at all").
 */
export interface GatewayUsageObservedEvidence {
  readonly hasAnyTurn: boolean;
  readonly firstEventAt: string | null;
  /**
   * The MOST RECENT recorded turn's timestamp, or null when this scope has no turn at all. Feeds the
   * snapshot's `lastUpdate`, which was hardcoded to '' — so the bar's "Updated" and the details
   * modal's "Last update" could only ever render an em dash, exactly the always-empty defect the
   * "Rebuilt at" row was removed for. This one has a real source, so it is filled rather than removed.
   */
  readonly latestEventAt: string | null;
}

export const NO_OBSERVED_EVIDENCE: GatewayUsageObservedEvidence = {
  hasAnyTurn: false,
  firstEventAt: null,
  latestEventAt: null,
};

export function buildGatewayUsageState(
  scope: UsageSnapshot['scope'],
  scopeId: string,
  usage: ConversationUsageTotals = EMPTY_CONVERSATION_USAGE_TOTALS,
  observedEvidence: GatewayUsageObservedEvidence = NO_OBSERVED_EVIDENCE,
): GatewayUsageState {
  return {
    scope,
    scopeId,
    snapshot: buildEmptyConversationSnapshot(scope, scopeId, usage, observedEvidence.latestEventAt ?? ''),
    bindingPolicy: null,
    observed: observedEvidence.hasAnyTurn,
    coverage: { rebuiltAt: null },
    warnings: [],
    latency: { channels: {} },
    firstEventAt: observedEvidence.firstEventAt,
    agentType: usage.agentType ?? null,
  };
}

/* ========================================================================== */
/*  7. Client latency, reshaped for UsageDetails' two latency rows            */
/* ========================================================================== */

export interface GatewayLatencyStat {
  readonly measured: boolean;
  readonly p95Ms: number | null;
  readonly clockBasis: 'same-process' | 'cross-process';
  readonly note: string | null;
}

/**
 * Only ONE real client-measured channel exists in this architecture (the
 * gateway's own `/api/health` poll round trip) — there is no separate
 * "UI-update paint" measurement, so `UsageDetails` passes `undefined` for that
 * row and it renders its own existing, honest "not measured" state.
 */
export function toClientLatencyStat(latency: GatewayLatency | null, note: string): GatewayLatencyStat | undefined {
  if (latency === null || !latency.measured || latency.p95Ms === null) return undefined;
  return { measured: true, p95Ms: latency.p95Ms, clockBasis: latency.clockBasis, note };
}

/* ========================================================================== */
/*  8. History — honestly empty, no gateway endpoint, no dead bridge call    */
/* ========================================================================== */

export interface GatewayUsageHistoryPoint {
  readonly at: string;
  readonly values: Readonly<Record<string, number | null>>;
}

export interface GatewayUsageSeriesDescriptor {
  readonly name: string;
  readonly unit: UsageField['unit'];
  readonly source: string;
  readonly accuracy: Accuracy;
}

export interface GatewayUsageHistoryResult {
  readonly points: readonly GatewayUsageHistoryPoint[];
  readonly series: readonly GatewayUsageSeriesDescriptor[];
}

/**
 * No gateway endpoint records per-conversation history, and the bridge's own
 * `getUsageHistory` never resolved anyway (dead backend) — rather than an
 * eternal "reading the event log…" spinner for a fetch that will never
 * complete, this is built synchronously so the panel goes straight to its own
 * existing, honest "no data yet" empty state.
 */
export function buildEmptyGatewayUsageHistory(): GatewayUsageHistoryResult {
  return { points: [], series: [] };
}
