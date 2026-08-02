/**
 * AccountUsagePressure — the account-wide Forge usage strip (WP7c).
 *
 * Distinct from `UsageBar` in this same directory (the per-conversation Claude
 * Code telemetry strip mounted in `ChatView` — untouched, 0 diff, per the
 * integration plan's explicit "add-only, remove nothing" rule). This is a
 * SMALLER, always-on, account-wide signal, genuinely new: how close the
 * account is to its weekly usage-pressure threshold, whether the owner's own
 * usage-guard has actually paused anything, and how fresh that reading is.
 * Fed entirely by the already-real, already-tested `GET /api/usage` gateway
 * route (`useGatewayAccountUsage`/`parseAccountUsage`, `gateway-adapter.ts`) —
 * no gateway change was needed to source the pressure fields, and the guard
 * fields were added honestly (see `usage.mjs`'s own header).
 *
 * HONESTY: every value is read straight off the gateway response or shown as
 * an explicit, muted absence — never invented. `provenance` states its own
 * source; a `NOT CONFIGURED` / `UNVERIFIED` file renders as a plain sentence,
 * never a fabricated percentage. `stale` is a clearly-labelled, DERIVED
 * client-side heuristic (see `STALE_AFTER_MS` below) — not a fact the gateway
 * itself reported.
 */

import { useMemo } from 'react';

import { Icon } from '@/components/primitives';
import { useGatewayAccountUsage } from '@/prototype/state/gateway-adapter';
import { usePrototype } from '@/prototype/state/prototype-store';

import './account-usage-pressure.css';

/**
 * A DERIVED staleness heuristic, not a gateway-reported fact: the owner's own
 * `usage-guard.cjs` defaults to a 120s watch cadence (see its own `INTERVAL`
 * constant), so a reading older than 30 minutes — 15x that cadence — most
 * likely means the watcher isn't currently running, rather than that usage
 * genuinely hasn't moved. This is a UI hint, never asserted as fact.
 */
const STALE_AFTER_MS = 30 * 60 * 1000;

function formatAge(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

function levelLabel(level: string | null): string {
  if (level === 'nvidia-preferred') return 'NVIDIA-preferred';
  if (level === 'normal') return 'Normal';
  if (level === 'unknown') return 'Unknown';
  return 'n/a';
}

function guardLabel(mode: string | null, available: boolean): string {
  if (!available) return 'n/a';
  if (mode === 'paused') return 'Paused';
  if (mode === 'ok') return 'Active';
  return mode ?? 'n/a';
}

export function AccountUsagePressure() {
  const usage = useGatewayAccountUsage();
  const guard = usage.guard;
  // The Dock (`Dock.tsx`) is a normal grid-flow region, not an overlay — it can
  // grow to `--forge-layout-dock` (260px) when open. This pill is `position:
  // fixed` (see this file's own CSS header for why), so it does not shift with
  // the grid; reading the SAME `state.dockOpen` flag the Dock/Topbar already
  // share lets it clear the dock's real current height instead of risking an
  // overlap with the dock panel's own content when it is open.
  const { state } = usePrototype();

  const ageLabel = useMemo(() => formatAge(usage.ageMs), [usage.ageMs]);
  const stale = usage.ageMs !== null && usage.ageMs > STALE_AFTER_MS;

  const notConfigured = usage.provenance === 'NOT CONFIGURED';
  const unverified = usage.provenance === 'UNVERIFIED';
  const reported = usage.provenance === 'REPORTED';

  const guardText = guardLabel(guard.mode, guard.available);

  const title = notConfigured
    ? 'No account-wide usage-pressure file found for this machine yet — the owner’s usage-guard tool has not run.'
    : unverified
      ? (usage.note ?? 'The usage-pressure file is present but could not be parsed.')
      : [
          `Week usage ${usage.week !== null ? `${usage.week}%` : 'n/a'}`,
          `pressure ${levelLabel(usage.level)}`,
          `guard ${guardText}${guard.pauseAt !== null ? ` (pause at ${guard.pauseAt}%)` : ''}`,
          ageLabel !== null ? `updated ${ageLabel}` : null,
        ]
          .filter((part): part is string => part !== null)
          .join(' · ');

  return (
    <div
      className="fw-acct-usage"
      data-stale={stale ? 'true' : 'false'}
      data-dock-open={state.dockOpen ? 'true' : 'false'}
      role="status"
      aria-label="Account-wide Forge usage"
      title={title}
    >
      <Icon name="Gauge" size="xs" className="fw-acct-usage__icon" />
      <span className="fw-acct-usage__label">Forge usage</span>

      {notConfigured ? (
        <span className="fw-acct-usage__v fw-acct-usage__v--muted">not configured</span>
      ) : unverified ? (
        <span className="fw-acct-usage__v fw-acct-usage__v--muted">unreadable</span>
      ) : (
        <>
          <span className="fw-acct-usage__pair">
            <span className="fw-acct-usage__k">Week</span>
            <span className="fw-acct-usage__v">{reported && usage.week !== null ? `${usage.week}%` : 'n/a'}</span>
          </span>

          <span className="fw-acct-usage__pair">
            <span className="fw-acct-usage__level-dot" data-level={usage.level ?? 'unknown'} aria-hidden="true" />
            <span className="fw-acct-usage__v">{levelLabel(usage.level)}</span>
          </span>

          <span className="fw-acct-usage__pair">
            <span className="fw-acct-usage__k">Guard</span>
            <span className="fw-acct-usage__v" data-guard={guard.mode ?? 'unknown'}>
              {guardText}
            </span>
          </span>

          {ageLabel !== null ? (
            <span className="fw-acct-usage__age">
              {stale ? <Icon name="Clock" size="xs" /> : null}
              {stale ? 'stale · ' : ''}
              {ageLabel}
            </span>
          ) : null}
        </>
      )}
    </div>
  );
}

export default AccountUsagePressure;
