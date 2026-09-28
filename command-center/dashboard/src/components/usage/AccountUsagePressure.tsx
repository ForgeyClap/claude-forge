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

import { guardLabel, guardStateAttr, isGuardWatcherDown } from '@/prototype/state/guard-label';

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

/** WP-CCD (item 10): a real reset timestamp, formatted as a plain relative-future label — "in 5d",
 *  never "X ago" (this is a FUTURE reset, unlike every other timestamp this strip already shows).
 *  A genuinely unparsable/absent value reads as `null` (omitted), never a fabricated date. */
function formatResetIn(iso: string | null): string | null {
  if (iso === null) return null;
  const thenMs = Date.parse(iso);
  if (!Number.isFinite(thenMs)) return null;
  const diffMs = thenMs - Date.now();
  if (diffMs <= 0) return 'due now';
  const diffMinutes = diffMs / 60000;
  if (diffMinutes < 60) return `in ${Math.round(diffMinutes)}m`;
  const diffHours = diffMinutes / 60;
  if (diffHours < 24) return `in ${Math.round(diffHours)}h`;
  const diffDays = diffHours / 24;
  return `in ${Math.round(diffDays)}d`;
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

  const guardText = guardLabel(guard);
  const watcherDown = isGuardWatcherDown(guard);

  // WP-CCD (item 10): the guard's own LIVE session/week percentages beat the top-level pressure
  // file's `week` (a slower-cadence, less-live reading) whenever the guard reports one — falls
  // back to `usage.week` exactly as before when it does not.
  const sessionPercent = guard.sessionPercent;
  const weekPercent = guard.weekPercent ?? usage.week;
  const sessionResetIn = useMemo(() => formatResetIn(guard.sessionResetAt), [guard.sessionResetAt]);
  const weekResetIn = useMemo(() => formatResetIn(guard.weekResetAt), [guard.weekResetAt]);

  const title = notConfigured
    ? 'No account-wide usage-pressure file found for this machine yet — the owner’s usage-guard tool has not run.'
    : unverified
      ? (usage.note ?? 'The usage-pressure file is present but could not be parsed.')
      : [
          sessionPercent !== null ? `Session usage ${sessionPercent}%${sessionResetIn !== null ? ` (resets ${sessionResetIn})` : ''}` : null,
          `Week usage ${weekPercent !== null ? `${weekPercent}%` : 'n/a'}${weekResetIn !== null ? ` (resets ${weekResetIn})` : ''}`,
          `pressure ${levelLabel(usage.level)}`,
          `guard ${guardText}${guard.pauseAt !== null ? ` (pause at ${guard.pauseAt}%)` : ''}`,
          watcherDown
            ? 'the usage guard is not checking usage right now, so nothing pauses work when usage gets high; Forge starts it again at the start of its next task'
            : null,
          guard.pendingCheckup ? 'a pending checkup is waiting — verify the paused agents actually resumed' : null,
          guard.lastError !== null ? `guard's last error: ${guard.lastError}` : null,
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
          {/* WP-CCD (item 10): the guard's own real, live session percentage — omitted entirely
              (never a fabricated "n/a") on a gateway build that has not forwarded it yet. */}
          {sessionPercent !== null ? (
            <span className="fw-acct-usage__pair">
              <span className="fw-acct-usage__k">Session</span>
              <span className="fw-acct-usage__v">{sessionPercent}%</span>
            </span>
          ) : null}

          <span className="fw-acct-usage__pair">
            <span className="fw-acct-usage__k">Week</span>
            <span className="fw-acct-usage__v">{reported && weekPercent !== null ? `${weekPercent}%` : 'n/a'}</span>
          </span>

          <span className="fw-acct-usage__pair">
            <span className="fw-acct-usage__level-dot" data-level={usage.level ?? 'unknown'} aria-hidden="true" />
            <span className="fw-acct-usage__v">{levelLabel(usage.level)}</span>
          </span>

          <span className="fw-acct-usage__pair">
            <span className="fw-acct-usage__k">Guard</span>
            <span className="fw-acct-usage__v" data-guard={guardStateAttr(guard)}>
              {guardText}
            </span>
            {/* WP-CCD (item 10): the guard's own "resumed — go verify the agents actually came
                back" flag, and its own last real fetch error (e.g. an HTTP 429) — both real,
                on-disk fields; the full sentence is in this pill's own `title` above. */}
            {guard.pendingCheckup ? <Icon name="ClipboardCheck" size="xs" className="fw-acct-usage__flag" /> : null}
            {guard.lastError !== null ? <Icon name="CircleAlert" size="xs" className="fw-acct-usage__flag" /> : null}
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
