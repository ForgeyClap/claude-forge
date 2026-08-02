/**
 * UsageBar — the live Claude usage strip above the chat thread.
 *
 * cc-wire-usage UPDATE — this bar now reads REAL gateway telemetry instead of
 * the bridge's dead `getUsageState` (a WebSocket on `127.0.0.1:4517` that
 * `live-store.ts`'s own header documents as constructed but never connected,
 * which is why this bar used to be permanently stuck on "No active run"):
 *
 *   - Connection, latency, the account-wide guard level/week/thresholds and
 *     their freshness (`age_ms`) all come from the real gateway
 *     (`gateway-adapter.ts`'s `useGatewayConnection`/`useGatewayLatency`/
 *     `useGatewayAccountUsage`). Guard level/week/thresholds surface as a
 *     `title` tooltip on the existing connection indicator — this bar's
 *     design is frozen, so no new visible text or DOM was added.
 *   - The current run is the ACTIVE CONVERSATION's real send/execution state
 *     (`useChatSend().run` — a real pending-turn id plus a real follow-up
 *     record, per `gateway-chat.ts`'s own honesty rules).
 *   - Model / context tokens+window / session id / AGENT are real when a
 *     completed assistant turn reported them — `gateway/src/exec-lifecycle.mjs`
 *     writes a real `session_id` (captured off almost every stream-json line),
 *     `context_window` (off the same `result.modelUsage[model]` entry `model`
 *     already comes from), and `agent_type` (the most recently dispatched real
 *     `Agent` tool_use's own `subagent_type`) onto the turn record (see
 *     `gateway-usage.ts`'s header for the full ground-truth trace and the HARD
 *     RULE that context occupancy reads only the MOST RECENT turn, never a
 *     running sum). SKILL genuinely stays UNAVAILABLE — no skill dispatch has
 *     ever been observed in this project's own stored conversations. Every one
 *     of these fields is still a `UsageField`/`GatewayDerivedLabel` that
 *     carries its accuracy label, and this bar still shows that label — a
 *     small DERIVED / ESTIMATED / UNAVAILABLE chip, or its absence for an
 *     EXACT fact — so a number is never dressed as a certainty it is not.
 *   - The "guard stale" pill sits next to the connection indicator (fix-
 *     unavailable: it is about the account-wide Forge usage-pressure guard
 *     snapshot's own age, never the WebSocket/gateway connection itself — the
 *     old placement next to Context invited exactly that confusion) and is
 *     driven by the REAL account-usage-pressure `age_ms`, not a per-conversation
 *     concept that does not exist.
 *   - Gateway down still says so honestly: the bar's existing "usage
 *     unavailable, here is why" branch (previously always the dead bridge's
 *     "no handler registered") now fires on a real DISCONNECTED connection
 *     state instead of freezing on stale numbers.
 *
 * What it refuses to invent, unchanged:
 *   - plan usage. The 2.1.217 runtime exposes no quota, so where a
 *     remaining-percentage would go, it prints the one honest sentence.
 *   - a status. RUNNING and friends come from the real run the chat send
 *     controller folded from evidence; when there is no run, it says so.
 *   - a forecast. The context alerts at 70/85/95% state the measured occupancy
 *     and suggest safe, non-destructive next steps. They never say when anything
 *     will run out, and nothing they suggest discards conversation state.
 */

import { useCallback, useMemo, useState } from 'react';

import { Icon, IconButton, Machine, StatusBadge } from '@/components/primitives';
import { statusKeyOf } from '@/prototype/state/live-store';
import { useGatewayAccountUsage, useGatewayConnection as useConnection, useGatewayLatency } from '@/prototype/state/gateway-adapter';
import { useChatSend } from '@/prototype/state/chat-send';
import { selectConversation, usePrototype } from '@/prototype/state/prototype-store';
import {
  NOT_MEASURED_SUMMARY,
  SKILL_LABEL_UNAVAILABLE,
  buildAgentLabel,
  buildGatewayUsageState,
  computeStale,
  formatGuardTooltip,
  resolveGatewayProblem,
  sumConversationUsage,
  toGatewayUsageRun,
} from '@/prototype/state/gateway-usage';
import type { GatewayUsageState } from '@/prototype/state/gateway-usage';
import { PLAN_USAGE_UNAVAILABLE_MESSAGE } from '@/shared/protocol';
import type { Accuracy, UsageField, UsageSnapshot } from '@/shared/protocol';

import { UsageDetails } from './UsageDetails';

import './usage-bar.css';

type UsageScope = UsageSnapshot['scope'];
type NumOrStr = string | number;

interface ScopeInfo {
  readonly scope: UsageScope;
  readonly scopeId: string;
}

/* ---------------------------------------------------------------- helpers */

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${String(rs).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${String(rm).padStart(2, '0')}m`;
}

function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString('en-US', { hour12: false });
}

const fmtTokens = (v: NumOrStr): string => Number(v).toLocaleString('en-US');
const fmtText = (v: NumOrStr): string => String(v);
const fmtDuration = (v: NumOrStr): string => formatDuration(Number(v));

interface DerivedLabel {
  readonly text: string;
  readonly accuracy: Accuracy;
  readonly title: string;
}

/* ------------------------------------------------------------------ chips */

function AccuracyChip({ accuracy }: { accuracy: Accuracy }) {
  // An EXACT value earns the absence of a chip; anything less carries a visible
  // qualifier, so a number is never read as a fact it cannot support.
  if (accuracy === 'EXACT') return null;
  return (
    <span className="fw-usage-chip" data-accuracy={accuracy} title={`Accuracy: ${accuracy}`}>
      {accuracy}
    </span>
  );
}

function FieldValue({ field, format }: { field: UsageField<NumOrStr> | undefined; format: (v: NumOrStr) => string }) {
  if (field === undefined || field.value === null || field.value === undefined) {
    // fix-ui-clutter (item 1): one short, consistent note instead of this field's own long
    // provenance paragraph (`field.source`) repeated on every unmeasured field's hover — see
    // `NOT_MEASURED_SUMMARY`'s own doc comment.
    return (
      <span className="fw-usage__pair">
        <span className="fw-usage__v fw-usage__v--muted" title={NOT_MEASURED_SUMMARY}>
          n/a
        </span>
        <AccuracyChip accuracy="UNAVAILABLE" />
      </span>
    );
  }
  return (
    <span className="fw-usage__pair">
      <Machine className="fw-usage__v">{format(field.value)}</Machine>
      <AccuracyChip accuracy={field.accuracy} />
    </span>
  );
}

function DerivedValue({ label }: { label: DerivedLabel }) {
  return (
    <span className="fw-usage__pair">
      <span
        className={label.text === 'n/a' || label.text === 'none' ? 'fw-usage__v fw-usage__v--muted' : 'fw-usage__v'}
        title={label.title}
      >
        {label.text === 'none' || label.text === 'n/a' ? label.text : <Machine>{label.text}</Machine>}
      </span>
      <AccuracyChip accuracy={label.accuracy} />
    </span>
  );
}

/* ---------------------------------------------------------- alert actions */

const CONTEXT_ACTIONS: readonly { readonly icon: string; readonly label: string }[] = [
  { icon: 'GitCommitHorizontal', label: 'Create a checkpoint' },
  { icon: 'MessageSquarePlus', label: 'Continue in a new conversation — this one stays' },
  { icon: 'Paperclip', label: 'Review the attached files' },
];

/* ------------------------------------------------------------------- bar */

export function UsageBar() {
  const { state } = usePrototype();
  // The real (third) send path, when mounted — see `gateway-chat.ts`. `null` in
  // fixtures/tests, which is the same signal `ChatView` uses to fall back to
  // the local reveal; this bar falls back to the honest "no active run" state.
  const chat = useChatSend();
  const connection = useConnection();
  const latency = useGatewayLatency();
  const accountUsage = useGatewayAccountUsage();

  const [detailsOpen, setDetailsOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // The real scope this bar reports on: the active conversation, exactly as
  // `ChatView` itself resolves it — a fixture/example conversation counts too,
  // it just never has a real `chat.run` behind it.
  const conversation = selectConversation(state, state.activeConversationId);
  const conversationId = conversation?.id ?? '';
  const scopeInfo: ScopeInfo | null = conversationId !== '' ? { scope: 'conversation', scopeId: conversationId } : null;
  const scope = scopeInfo?.scope ?? null;
  const scopeId = scopeInfo?.scopeId ?? null;

  const openDetails = useCallback(() => setDetailsOpen(true), []);
  const closeDetails = useCallback(() => setDetailsOpen(false), []);
  const toggleExpanded = useCallback(() => setExpanded((v) => !v), []);

  // The one honest per-conversation snapshot this gateway can build, from real
  // scope/scopeId plus the conversation's own stored turns. No fetch: the turns
  // are already in state, so there is no stale-response race to guard.
  //
  // Two of these scalars are now REAL: `exec-bridge.mjs` writes a true
  // `cost_usd` and `duration_ms` onto every assistant turn, so summing the
  // conversation's measured turns is a measurement, not an estimate. An earlier
  // version of this file declared both "genuinely unmeasured" while the gateway
  // was measuring and storing them — a false statement on the one surface whose
  // whole job is to be trustworthy about numbers. Every OTHER scalar (tokens,
  // context window, model, agent, skill) really is absent from the gateway and
  // stays honestly UNAVAILABLE; see gateway-usage.ts's header for the per-field
  // ground-truth trace. A turn whose cost is null contributes nothing and never
  // becomes a zero.
  const conversationUsage = useMemo(
    () => sumConversationUsage(conversation?.messages ?? []),
    [conversation?.messages],
  );
  // fix-unavailable: real evidence for "Observed"/"Start (first event)" — this conversation's
  // own earliest recorded turn, if any. `messages[0]` is genuinely the oldest turn: turns are
  // appended in order and `toGatewayMessage` maps them 1:1 (any live synthetic placeholder is
  // always appended LAST, never first — see `live-activity.ts`).
  // `latestEventAt` is the same evidence from the other end, and it feeds the "Updated"/"Last update"
  // rows that were showing a permanent em dash: `lastUpdate` was hardcoded to '' in the gateway
  // snapshot, so those rows could never display anything — the same always-empty defect the
  // "Rebuilt at" row was removed for. Here there IS a real source, so it gets filled instead.
  const conversationObserved = useMemo(() => {
    const messages = conversation?.messages ?? [];
    return {
      hasAnyTurn: messages.length > 0,
      firstEventAt: messages.length > 0 ? messages[0].timestamp || null : null,
      latestEventAt: messages.length > 0 ? messages[messages.length - 1].timestamp || null : null,
    };
  }, [conversation?.messages]);
  const shownUsage: GatewayUsageState | null = useMemo(
    () =>
      scope !== null && scopeId !== null
        ? buildGatewayUsageState(scope, scopeId, conversationUsage, conversationObserved)
        : null,
    [scope, scopeId, conversationUsage, conversationObserved],
  );
  const snapshot = shownUsage?.snapshot ?? null;

  // The bar's existing "usage unavailable, here is why" branch, repurposed to
  // the real, actionable case: the gateway itself is unreachable.
  const problemMessage = resolveGatewayProblem(connection.status, connection.detail);

  const contextPercent = snapshot?.contextPercent ?? undefined;
  const pctValue = contextPercent?.value ?? null;
  const contextSeverity = pctValue === null ? null : pctValue >= 95 ? 95 : pctValue >= 85 ? 85 : pctValue >= 70 ? 70 : null;
  // Real freshness: the account-wide usage-pressure reading's own age_ms — the
  // only real staleness fact this bar has access to (no per-conversation
  // telemetry exists to be stale about).
  const stale = computeStale(accountUsage.ageMs);

  const run = toGatewayUsageRun(chat?.run ?? null);

  const delivery = latency;
  let latencyText = 'not measured';
  let latencyAccuracy: Accuracy = 'UNAVAILABLE';
  if (delivery.measured && delivery.p95Ms !== null) {
    latencyText = `${Math.round(delivery.p95Ms)}ms p95`;
    latencyAccuracy = delivery.clockBasis === 'same-process' ? 'DERIVED' : 'ESTIMATED';
  }
  const latencyMeasured = latencyAccuracy !== 'UNAVAILABLE';

  const runKey = statusKeyOf(run?.operationalStatus ?? null);
  // fix-unavailable: real when this conversation's most recent completed turn dispatched a
  // sub-agent (see `buildAgentLabel`'s own doc comment); the honest UNAVAILABLE fallback
  // otherwise. SKILL genuinely stays UNAVAILABLE — never observed anywhere in this gateway.
  const agentLabel = scopeInfo !== null ? buildAgentLabel(shownUsage?.agentType ?? null) : null;
  const skillLabel = scopeInfo !== null ? SKILL_LABEL_UNAVAILABLE : null;

  const contextUsed = snapshot?.contextTokensUsed ?? undefined;
  const contextWindow = snapshot?.contextWindow ?? undefined;
  const contextUsedText = contextUsed && contextUsed.value !== null ? fmtTokens(contextUsed.value) : 'n/a';
  const contextWindowValue = contextWindow && contextWindow.value !== null ? contextWindow.value : null;
  const contextWindowText = contextWindowValue !== null ? fmtTokens(contextWindowValue) : 'n/a';

  // Real guard level / week / NVIDIA-shift + pause thresholds, surfaced as a
  // tooltip on the connection indicator below — the design is frozen, so no
  // new visible text or DOM element was added for it.
  const guardTooltip = formatGuardTooltip(accountUsage);

  return (
    <div
      className="fw-usage"
      data-expanded={expanded ? 'true' : 'false'}
      data-context-severity={contextSeverity ?? undefined}
    >
      <div className="fw-usage__inner">
        <button
          type="button"
          className="fw-usage__summary"
          onClick={openDetails}
          aria-label="Open live usage details"
        >
          {/* Primary row — always visible */}
          <span className="fw-usage__row">
            <span className="fw-usage__brand">
              <Icon name="Gauge" size="xs" className="fw-usage__brand-icon" />
              Claude Code
            </span>
            <span className="fw-usage__conn" data-status={connection.status} title={guardTooltip}>
              <span className="fw-usage__conn-dot" aria-hidden="true" />
              {connection.status}
            </span>
            {/* fix-unavailable (item 4): moved next to the connection indicator and relabelled
                "guard stale" — this pill is about the account-wide Forge usage-pressure GUARD
                snapshot's own age (`computeStale(accountUsage.ageMs)`), never the connection/bridge
                state itself, and now renders regardless of conversation scope (a stale guard
                reading is true or false independent of which conversation is open). */}
            {stale ? (
              <span className="fw-usage__stale" title="The account-wide Forge usage-pressure guard reading has not refreshed recently.">
                <Icon name="Clock" size="xs" />
                guard stale
              </span>
            ) : null}

            {scopeInfo === null ? (
              <span className="fw-usage__v fw-usage__v--muted">
                No active run — usage is UNAVAILABLE until Claude Code reports one.
              </span>
            ) : problemMessage !== null ? (
              <span className="fw-usage__v fw-usage__v--muted" title={problemMessage}>
                Usage unavailable — {problemMessage}
              </span>
            ) : (
              <>
                <span className="fw-usage__group">
                  <span className="fw-usage__k">Model</span>
                  <FieldValue field={snapshot?.model as UsageField<NumOrStr> | undefined} format={fmtText} />
                </span>
                <span className="fw-usage__group">
                  <span className="fw-usage__k">Context</span>
                  <span className="fw-usage__ctx">
                    <span className="fw-usage__track" aria-hidden="true">
                      <span
                        className="fw-usage__track-fill"
                        style={{ inlineSize: `${pctValue === null ? 0 : Math.max(0, Math.min(100, pctValue))}%` }}
                      />
                    </span>
                    <Machine className="fw-usage__v">
                      {`${contextUsedText} / ${contextWindowText}`}
                    </Machine>
                    {pctValue !== null ? (
                      <Machine className="fw-usage__v fw-usage__v--strong">{`${pctValue.toFixed(1)}%`}</Machine>
                    ) : null}
                    <AccuracyChip accuracy={contextPercent?.accuracy ?? 'UNAVAILABLE'} />
                  </span>
                </span>
              </>
            )}
            <span className="fw-usage__spacer" />
          </span>

          {/* Secondary rows — collapse on narrow viewports */}
          {scopeInfo !== null ? (
            <>
              <span className="fw-usage__row fw-usage__row--secondary">
                <span className="fw-usage__group">
                  <span className="fw-usage__k">Session</span>
                  <FieldValue field={snapshot?.elapsedMs as UsageField<NumOrStr> | undefined} format={fmtDuration} />
                </span>
                <span className="fw-usage__group">
                  <span className="fw-usage__k">Run</span>
                  {runKey !== null ? <StatusBadge status={runKey} size="sm" /> : null}
                  <Machine className="fw-usage__v">{run?.operationalStatus ?? (scope === 'session' ? 'no run' : 'UNKNOWN')}</Machine>
                </span>
                <span className="fw-usage__group">
                  <span className="fw-usage__k">
                    <Icon name="Bot" size="xs" /> Agent
                  </span>
                  {agentLabel !== null ? <DerivedValue label={agentLabel} /> : null}
                </span>
                <span className="fw-usage__group">
                  <span className="fw-usage__k">
                    <Icon name="Sparkles" size="xs" /> Skill
                  </span>
                  {skillLabel !== null ? <DerivedValue label={skillLabel} /> : null}
                </span>
              </span>

              <span className="fw-usage__row fw-usage__row--secondary">
                <span className="fw-usage__group">
                  <span className="fw-usage__k">
                    <Icon name="Timer" size="xs" /> Latency
                  </span>
                  <span className="fw-usage__pair">
                    <span className={latencyMeasured ? 'fw-usage__v' : 'fw-usage__v fw-usage__v--muted'}>
                      {latencyMeasured ? <Machine>{latencyText}</Machine> : 'not measured'}
                    </span>
                    <AccuracyChip accuracy={latencyAccuracy} />
                  </span>
                </span>
                <span className="fw-usage__group">
                  <span className="fw-usage__k">Updated</span>
                  <Machine className="fw-usage__v fw-usage__v--muted">
                    {snapshot?.lastUpdate ? formatClock(snapshot.lastUpdate) : '—'}
                  </Machine>
                </span>
              </span>
            </>
          ) : null}
        </button>

        {/* The mobile expand toggle sits outside the summary button so no button nests. */}
        {scopeInfo !== null ? (
          <IconButton
            icon={expanded ? 'ChevronsDownUp' : 'ChevronsUpDown'}
            label={expanded ? 'Collapse usage bar' : 'Expand usage bar'}
            size="sm"
            className="fw-usage__expand"
            onClick={toggleExpanded}
          />
        ) : null}

        {/* Context alert — a quiet, measured warning. Never a forecast. */}
        {contextSeverity !== null && pctValue !== null ? (
          <div className="fw-usage__alert" data-severity={contextSeverity} role="status">
            <div className="fw-usage__alert-head">
              <Icon name="TriangleAlert" size="sm" className="fw-usage__alert-icon" />
              <span className="fw-usage__alert-msg">
                Context is at <Machine>{`${pctValue.toFixed(1)}%`}</Machine>
                {contextWindowValue !== null ? (
                  <>
                    {' of the '}
                    <Machine>{contextWindowText}</Machine>
                    {'-token window'}
                  </>
                ) : (
                  ' of the model context window'
                )}
                {` for this ${scope}. Recorded state is kept — nothing here discards the conversation.`}
              </span>
            </div>
            <div className="fw-usage__alert-actions">
              {CONTEXT_ACTIONS.map((action) => (
                <span className="fw-usage__alert-action" key={action.label}>
                  <Icon name={action.icon} size="xs" className="fw-usage__alert-action-icon" />
                  {action.label}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        {/* Plan usage — the one honest sentence, never a remaining-percentage. */}
        <p className="fw-usage__note fw-usage__row--secondary">
          {snapshot?.planUsage.value ?? PLAN_USAGE_UNAVAILABLE_MESSAGE}
        </p>
      </div>

      <UsageDetails
        open={detailsOpen}
        onClose={closeDetails}
        scope={scope}
        scopeId={scopeId}
        usage={shownUsage}
        run={run}
        connection={connection}
        clientLatency={latency}
      />
    </div>
  );
}

export default UsageBar;
