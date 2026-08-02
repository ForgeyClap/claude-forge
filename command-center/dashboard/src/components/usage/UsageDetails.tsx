/**
 * UsageDetails — the full, labelled breakdown behind the usage bar.
 *
 * cc-wire-usage UPDATE — decoupled from the bridge's dead `getUsageState`/
 * `getUsageHistory` (a WebSocket that never connects — see `UsageBar.tsx`'s
 * header). `usage`/`run`/`clientLatency` are now the real, gateway-shaped
 * types `gateway-usage.ts`/`gateway-adapter.ts` build. History has no gateway
 * endpoint, so it is built synchronously as honestly empty — the sparkline's
 * own existing "no data yet" state, never a spinner for a fetch that would
 * never complete. Every scalar still keeps the accuracy label it arrived with
 * (EXACT / DERIVED / ESTIMATED / UNAVAILABLE) and prints, on its own line, the
 * one-sentence provenance attached to it — so a number is never shown as a
 * fact it cannot back up.
 *
 * `planUsage` is not computed here: the local Claude Code runtime exposes no
 * plan quota, so this panel prints the one honest sentence and never a
 * remaining-percentage. The history graph is drawn ONLY from stored points; with
 * none it renders "no data yet", never a decorative curve through zero.
 */

import { useMemo } from 'react';

import { Icon, Machine, Meter, Modal, StatusBadge } from '@/components/primitives';
import { statusKeyOf } from '@/prototype/state/live-store';
import type { ConnectionState } from '@/prototype/state/bridge-client';
import type { GatewayLatency } from '@/prototype/state/gateway-adapter';
import {
  NOT_MEASURED_SUMMARY,
  buildEmptyGatewayUsageHistory,
  toClientLatencyStat,
} from '@/prototype/state/gateway-usage';
import type {
  GatewayLatencyStat,
  GatewayUsageHistoryPoint,
  GatewayUsageHistoryResult,
  GatewayUsageRun,
  GatewayUsageSeriesDescriptor,
  GatewayUsageState,
} from '@/prototype/state/gateway-usage';
import { PLAN_USAGE_UNAVAILABLE_MESSAGE } from '@/shared/protocol';
import type { Accuracy, UsageField } from '@/shared/protocol';

import './usage-bar.css';

type UsageScope = GatewayUsageState['scope'];
type UsageHistoryField = string;
type NumOrStr = string | number;

/* -------------------------------------------------------------- formatting */

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

function formatClock(iso: string | null): string {
  if (iso === null) return 'UNAVAILABLE';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', { hour12: false });
}

const fmtTokens = (v: NumOrStr): string => Number(v).toLocaleString('en-US');
const fmtPercent = (v: NumOrStr): string => `${Number(v).toFixed(1)}%`;
const fmtMs = (v: NumOrStr): string => `${Math.round(Number(v))} ms`;
const fmtText = (v: NumOrStr): string => String(v);
const fmtDuration = (v: NumOrStr): string => formatDuration(Number(v));

/* ------------------------------------------------------------------- chip */

function AccuracyChip({ accuracy }: { accuracy: Accuracy }) {
  return (
    <span className="fw-usage-chip" data-accuracy={accuracy} title={`Accuracy: ${accuracy}`}>
      {accuracy}
    </span>
  );
}

/* --------------------------------------------------------------- one row */

function DetailRow({
  label,
  field,
  format,
}: {
  label: string;
  field: UsageField<NumOrStr>;
  format: (v: NumOrStr) => string;
}) {
  const has = field.value !== null && field.value !== undefined;
  return (
    <div className="fw-usage-details__row">
      <dt className="fw-usage-details__k">{label}</dt>
      <dd className="fw-usage-details__cell">
        <span className="fw-usage-details__val">
          {has ? (
            <Machine className="fw-usage-details__num">{format(field.value as NumOrStr)}</Machine>
          ) : (
            <span className="fw-usage-details__num fw-usage-details__num--muted">UNAVAILABLE</span>
          )}
          <AccuracyChip accuracy={field.accuracy} />
        </span>
        <span className="fw-usage-details__src">{field.source}</span>
      </dd>
    </div>
  );
}

/** A metadata row that is not a UsageField (scope, session id, timestamps). */
function MetaRow({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="fw-usage-details__row">
      <dt className="fw-usage-details__k">{label}</dt>
      <dd className="fw-usage-details__cell">
        <span className="fw-usage-details__val">
          {mono ? (
            <Machine className="fw-usage-details__num">{value}</Machine>
          ) : (
            <span className="fw-usage-details__num">{value}</span>
          )}
        </span>
      </dd>
    </div>
  );
}

/* ------------------------------------------------------- client latency row */

function ClientLatencyRow({ label, stat }: { label: string; stat: GatewayLatencyStat | undefined }) {
  const p95 = stat !== undefined && stat.measured ? stat.p95Ms : null;
  const accuracy: Accuracy = p95 === null ? 'UNAVAILABLE' : stat?.clockBasis === 'same-process' ? 'DERIVED' : 'ESTIMATED';
  return (
    <div className="fw-usage-details__row">
      <dt className="fw-usage-details__k">{label}</dt>
      <dd className="fw-usage-details__cell">
        <span className="fw-usage-details__val">
          {p95 !== null ? (
            <Machine className="fw-usage-details__num">{`${Math.round(p95)} ms p95`}</Machine>
          ) : (
            <span className="fw-usage-details__num fw-usage-details__num--muted">not measured</span>
          )}
          <AccuracyChip accuracy={accuracy} />
        </span>
        <span className="fw-usage-details__src">
          {stat?.note ?? 'no samples have been recorded on this channel in this browser session'}
        </span>
      </dd>
    </div>
  );
}

/* ------------------------------------------------------------- sparkline */

/** The first history field that carries at least one real number. */
function chooseSeries(points: readonly GatewayUsageHistoryPoint[]): UsageHistoryField | null {
  const preferred: UsageHistoryField[] = ['contextTokensUsed', 'inputTokens', 'outputTokens', 'costUsd', 'turns'];
  for (const name of preferred) {
    if (points.some((p) => p.values[name] !== null)) return name;
  }
  return null;
}

function Sparkline({ history }: { history: GatewayUsageHistoryResult }) {
  const points = history.points;
  const series = useMemo(() => chooseSeries(points), [points]);

  if (points.length === 0 || series === null) {
    return <div className="fw-usage-spark__empty">no data yet</div>;
  }

  const values: number[] = [];
  for (const p of points) {
    const v = p.values[series];
    if (v !== null && Number.isFinite(v)) values.push(v);
  }

  if (values.length === 0) {
    return <div className="fw-usage-spark__empty">no data yet</div>;
  }

  const descriptor: GatewayUsageSeriesDescriptor | undefined = history.series.find((s) => s.name === series);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const W = 100;
  const H = 30;
  const n = values.length;

  const coords = values.map((v, i) => {
    const x = n === 1 ? W / 2 : (i / (n - 1)) * W;
    const y = H - ((v - min) / span) * H;
    return { x, y };
  });

  const line = coords.map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x.toFixed(2)} ${c.y.toFixed(2)}`).join(' ');
  const area =
    n >= 2
      ? `M ${coords[0].x.toFixed(2)} ${H} ` +
        coords.map((c) => `L ${c.x.toFixed(2)} ${c.y.toFixed(2)}`).join(' ') +
        ` L ${coords[n - 1].x.toFixed(2)} ${H} Z`
      : null;

  return (
    <div className="fw-usage-spark">
      <svg
        className="fw-usage-spark__svg"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${series} across ${n} recorded telemetry point${n === 1 ? '' : 's'}`}
      >
        {area !== null ? <path className="fw-usage-spark__area" d={area} /> : null}
        {n >= 2 ? <path className="fw-usage-spark__line" d={line} /> : null}
        {n === 1 ? <circle className="fw-usage-spark__dot" cx={coords[0].x} cy={coords[0].y} r={2} /> : null}
      </svg>
      <div className="fw-usage-spark__legend">
        <span className="fw-usage-spark__legend-name">{series}</span>
        <span>
          {n} point{n === 1 ? '' : 's'}
        </span>
        <span>
          range {fmtTokens(min)}–{fmtTokens(max)}
          {descriptor ? ` ${descriptor.unit}` : ''}
        </span>
        {descriptor ? <AccuracyChip accuracy={descriptor.accuracy} /> : null}
      </div>
      {descriptor ? <span className="fw-usage-details__src">{descriptor.source}</span> : null}
    </div>
  );
}

/* ------------------------------------------------------------- the modal */

export interface UsageDetailsProps {
  open: boolean;
  onClose: () => void;
  scope: UsageScope | null;
  scopeId: string | null;
  usage: GatewayUsageState | null;
  run: GatewayUsageRun | null;
  connection: ConnectionState;
  clientLatency: GatewayLatency;
}

export function UsageDetails({
  open,
  onClose,
  scope,
  scopeId,
  usage,
  run,
  connection,
  clientLatency,
}: UsageDetailsProps) {
  // No gateway endpoint records per-conversation history (see this file's own
  // header), so this is built synchronously and honestly empty — the
  // sparkline's own existing "no data yet" state fires immediately, rather
  // than an eternal loading spinner for a fetch that would never complete.
  const matchedHistory = useMemo<GatewayUsageHistoryResult | null>(
    () => (scope !== null && scopeId !== null ? buildEmptyGatewayUsageHistory() : null),
    [scope, scopeId],
  );
  const historyErrorMessage: string | null = null;

  const snapshot = usage && usage.scope === scope && usage.scopeId === scopeId ? usage.snapshot : null;

  /*
   * fix-ui-clutter (items 1 + 2): Cost is dropped from this list outright — an owner-preference
   * decision (item 2: subscription usage, not credits; the owner does not want a cost/token
   * figure at all here), not an honesty gap, and `sumConversationUsage`'s own data layer is
   * untouched — it still computes and is still tested; this panel simply stops rendering it.
   * Every remaining row keeps its real accuracy label; `measuredRows`/the "not measured" summary
   * below decide which ones actually get a row.
   */
  const rows = useMemo(() => {
    if (snapshot === null) return [];
    return [
      { label: 'Model', field: snapshot.model as UsageField<NumOrStr>, format: fmtText },
      { label: 'Mode (effort)', field: snapshot.effort as UsageField<NumOrStr>, format: fmtText },
      { label: 'Input tokens', field: snapshot.inputTokens as UsageField<NumOrStr>, format: fmtTokens },
      { label: 'Output tokens', field: snapshot.outputTokens as UsageField<NumOrStr>, format: fmtTokens },
      { label: 'Cache read tokens', field: snapshot.cacheReadTokens as UsageField<NumOrStr>, format: fmtTokens },
      { label: 'Cache creation tokens', field: snapshot.cacheCreationTokens as UsageField<NumOrStr>, format: fmtTokens },
      { label: 'Context used', field: snapshot.contextTokensUsed as UsageField<NumOrStr>, format: fmtTokens },
      { label: 'Context window', field: snapshot.contextWindow as UsageField<NumOrStr>, format: fmtTokens },
      { label: 'Context %', field: snapshot.contextPercent as UsageField<NumOrStr>, format: fmtPercent },
      { label: 'Turns', field: snapshot.turns as UsageField<NumOrStr>, format: fmtTokens },
      { label: 'Tool calls', field: snapshot.toolCalls as UsageField<NumOrStr>, format: fmtTokens },
      { label: 'Agents', field: snapshot.agentCount as UsageField<NumOrStr>, format: fmtTokens },
      { label: 'Skill uses', field: snapshot.skillUses as UsageField<NumOrStr>, format: fmtTokens },
      { label: 'Errors', field: snapshot.errors as UsageField<NumOrStr>, format: fmtTokens },
      { label: 'Retries', field: snapshot.retries as UsageField<NumOrStr>, format: fmtTokens },
      { label: 'Compactions', field: snapshot.compactions as UsageField<NumOrStr>, format: fmtTokens },
      { label: 'Elapsed (observed)', field: snapshot.elapsedMs as UsageField<NumOrStr>, format: fmtDuration },
      { label: 'Event latency p95 (ingestion)', field: snapshot.eventLatencyP95 as UsageField<NumOrStr>, format: fmtMs },
    ];
  }, [snapshot]);

  // fix-ui-clutter (item 1): only rows with a REAL value get their own line — every unmeasured
  // field collapses into ONE compact note below, instead of a wall of "UNAVAILABLE UNAVAILABLE"
  // rows each repeating the same long provenance paragraph.
  const measuredRows = useMemo(() => rows.filter((r) => r.field.value !== null && r.field.value !== undefined), [rows]);
  const hasUnmeasuredRows = rows.length > measuredRows.length;

  const runKey = statusKeyOf(run?.operationalStatus ?? null);
  // fix-unavailable (item 4): real — this scope's own earliest recorded turn's timestamp (see
  // `UsageBar.tsx`'s `conversationObserved`) — replaces the dead, always-empty sparkline-history
  // read this row used to source from (`buildEmptyGatewayUsageHistory()` never has any points).
  const startAt = usage?.firstEventAt ?? null;
  const ingestion = usage?.latency.channels.ingestion;

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Live usage"
      description="Every number is read from real Claude Code telemetry and keeps the accuracy label it arrived with."
    >
      <div className="fw-usage-details">
        {snapshot === null ? (
          <p className="fw-usage-details__src">
            No usage snapshot is available for this scope yet. It appears once Claude Code reports telemetry for an
            active run or session.
          </p>
        ) : (
          <>
            {/* Session metadata */}
            <section className="fw-usage-details__section">
              <div className="fw-usage-details__section-head">
                <span className="fg-eyebrow">Session</span>
                {snapshot.stale ? <span className="fw-usage__stale">Stale telemetry</span> : null}
              </div>
              <dl className="fw-usage-details__dl">
                <MetaRow label="Scope" value={`${usage?.scope ?? scope ?? '—'} · ${scopeId ?? '—'}`} />
                <MetaRow label="Binding" value={usage?.bindingPolicy ?? '—'} mono={false} />
                <MetaRow label="Session id" value={snapshot.sessionId ?? 'UNAVAILABLE'} />
                <MetaRow label="Observed" value={usage?.observed ? 'yes — this scope has at least one recorded turn' : 'no'} mono={false} />
                <div className="fw-usage-details__row">
                  <dt className="fw-usage-details__k">Run status</dt>
                  <dd className="fw-usage-details__cell">
                    <span className="fw-usage-details__val">
                      {runKey !== null ? <StatusBadge status={runKey} size="sm" /> : null}
                      <Machine className="fw-usage-details__num">{run?.operationalStatus ?? 'no active run'}</Machine>
                    </span>
                  </dd>
                </div>
                {/* The value is the real gateway connection (the usage bar was rewired to it this
                    run); the label still said "Bridge". A label that names a different component
                    than the value it introduces is a small lie in a panel whose whole purpose is
                    to be trusted about numbers. */}
                <MetaRow label="Gateway connection" value={connection.status} />
                <MetaRow label="Start (first event)" value={formatClock(startAt)} />
                <MetaRow label="Last update" value={formatClock(snapshot.lastUpdate)} />
              </dl>
            </section>

            {/* fix-ui-clutter (item 1): real scalars only, each with its provenance; every
                unmeasured field collapses into the one summary line below instead of its own
                "UNAVAILABLE UNAVAILABLE" row. */}
            <section className="fw-usage-details__section">
              <span className="fg-eyebrow">Measured fields</span>
              {measuredRows.length > 0 ? (
                <dl className="fw-usage-details__dl">
                  {measuredRows.map((r) => (
                    <DetailRow key={r.label} label={r.label} field={r.field} format={r.format} />
                  ))}
                </dl>
              ) : null}
              {hasUnmeasuredRows ? <p className="fw-usage-details__src">{NOT_MEASURED_SUMMARY}</p> : null}
            </section>

            {/* Latency, honestly split by who could measure it */}
            <section className="fw-usage-details__section">
              <span className="fg-eyebrow">Latency</span>
              <dl className="fw-usage-details__dl">
                <ClientLatencyRow
                  label="Delivery p95 (this client)"
                  stat={toClientLatencyStat(
                    clientLatency,
                    'Measured as this client’s round trip on the gateway’s own periodic GET /api/health poll — not a per-message delivery acknowledgement.',
                  )}
                />
                {/* No separate UI-paint measurement exists in this architecture — honestly not measured. */}
                <ClientLatencyRow label="UI update p95 (this client)" stat={undefined} />
                {ingestion !== undefined ? (
                  <DetailRow
                    label="Ingestion p95 (from log)"
                    field={ingestion.p95.field as UsageField<NumOrStr>}
                    format={fmtMs}
                  />
                ) : null}
              </dl>
            </section>

            {/* Plan usage — the one honest sentence, never a number */}
            <section className="fw-usage-details__section">
              <span className="fg-eyebrow">Plan usage</span>
              <p className="fw-usage-details__plan">
                {snapshot.planUsage.value ?? PLAN_USAGE_UNAVAILABLE_MESSAGE}
              </p>
              <span className="fw-usage-details__src">{snapshot.planUsage.source}</span>
            </section>

            {/* History — only real stored points */}
            <section className="fw-usage-details__section">
              <span className="fg-eyebrow">Recorded history</span>
              {historyErrorMessage !== null ? (
                <div className="fw-usage-spark__empty">history unavailable — {historyErrorMessage}</div>
              ) : matchedHistory === null ? (
                <div className="fw-usage-spark__empty">
                  <Icon name="Loader" size="sm" spin /> reading the event log…
                </div>
              ) : (
                <Sparkline history={matchedHistory} />
              )}
            </section>

            {/* Coverage caveats — measured reasons a number may be incomplete */}
            {usage !== null && usage.warnings.length > 0 ? (
              <section className="fw-usage-details__section">
                <span className="fg-eyebrow">Data-integrity notes</span>
                <ul className="fw-usage-details__warnings">
                  {usage.warnings.map((w, i) => (
                    <li key={i} className="fw-usage-details__warning">
                      {w}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {/* A context meter, drawn where it cannot be mistaken for a claim */}
            {snapshot.contextPercent.value !== null ? (
              <section className="fw-usage-details__section">
                <span className="fg-eyebrow">Context occupancy</span>
                <Meter value={snapshot.contextPercent.value} showValue />
                <span className="fw-usage-details__src">{snapshot.contextPercent.source}</span>
              </section>
            ) : null}
          </>
        )}
      </div>
    </Modal>
  );
}

export default UsageDetails;
