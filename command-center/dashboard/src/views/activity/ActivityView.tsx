/**
 * Activity — the run timeline.
 *
 * Reads `state.data.events`, newest first, grouped by run with a sticky run
 * header and tied together by a spine down the left. Each row carries the four
 * things that make a log readable: when, who, what state, and one sentence of
 * what happened. The paragraph behind it opens on demand.
 *
 * Calm on purpose: nothing animates per row, the running badge does not spin
 * here, and filtering is a plain array pass memoised on its inputs. A log is
 * history — it should sit still while it is read.
 *
 * In production this feed is real and SSE-tailed (`/api/events/stream`); in
 * fixtures it is local example data and never updates.
 */

import { useMemo, useState } from 'react';
import {
  Button,
  EmptyState,
  Eyebrow,
  ExampleTag,
  Field,
  Icon,
  IconButton,
  Machine,
  StatusBadge,
  statusPresentation,
  Switch,
  Toolbar,
  ToolbarGroup,
} from '@/components/primitives';
import { usePrototype } from '@/prototype/state/prototype-store';
import { useGatewayEventsMeta, useGatewayRunScanErrors } from '@/prototype/state/gateway-adapter';
import { isProductionMode } from '@/config/mode';
import { STATUS_KEYS } from '@/prototype/types/prototype-types';
import type { ActivityEvent, EventKind, StatusKey } from '@/prototype/types/prototype-types';
import { RecoveryPanel } from './RecoveryPanel';
import './activity.css';

/* ------------------------------------------------------------- event kinds */

interface KindPresentation {
  readonly icon: string;
  readonly label: string;
}

/** The glyph that opens each row. Icon plus an accessible name, never a colour. */
const KIND: Readonly<Record<EventKind, KindPresentation>> = {
  mission: { icon: 'Flag', label: 'MISSION' },
  'work-package': { icon: 'Package', label: 'WORK PACKAGE' },
  agent: { icon: 'Bot', label: 'AGENT' },
  task: { icon: 'ListChecks', label: 'TASK' },
  artifact: { icon: 'FileText', label: 'ARTIFACT' },
  test: { icon: 'FlaskConical', label: 'TEST' },
  verify: { icon: 'ShieldCheck', label: 'VERIFY' },
  review: { icon: 'Gavel', label: 'REVIEW' },
  system: { icon: 'Cpu', label: 'SYSTEM' },
};

const EVENT_KINDS: readonly EventKind[] = [
  'mission',
  'work-package',
  'agent',
  'task',
  'artifact',
  'test',
  'verify',
  'review',
  'system',
];

/** Events with no agent are the runtime talking. Selects need a stable value. */
const NO_AGENT = '__system__';

function agentKey(agent: string | null): string {
  return agent ?? NO_AGENT;
}

function agentLabel(agent: string | null): string {
  return agent ?? 'system';
}

function toggleId(current: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(current);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** One line of the "filtering on" summary above the timeline. */
interface ActiveFilter {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly clear: () => void;
}

/* ------------------------------------------------------------------ a row */

interface EventRowProps {
  event: ActivityEvent;
  /** Shown when the list is flat, hidden when the run header already says it. */
  showRun: boolean;
  expanded: boolean;
  selected: boolean;
  onActivate: (id: string) => void;
}

function EventRow({ event, showRun, expanded, selected, onActivate }: EventRowProps) {
  const kind = KIND[event.kind];
  const detailId = `fw-event-detail--${event.id}`;
  const headId = `fw-event-head--${event.id}`;

  return (
    <li
      className="fw-event fw-status"
      data-status={event.status}
      data-selected={selected ? 'true' : undefined}
    >
      <span className="fw-event__node" title={kind.label}>
        <Icon name={kind.icon} size="sm" />
        <span className="fw-visually-hidden">{kind.label}</span>
      </span>

      <button
        type="button"
        id={headId}
        className="fw-event__head"
        aria-expanded={expanded}
        aria-controls={detailId}
        onClick={() => onActivate(event.id)}
      >
        <span className="fw-event__stamp">
          <Machine muted className="fw-event__time">
            {event.timestamp}
          </Machine>
          {showRun ? (
            <Machine muted className="fw-event__run">
              {event.runId}
            </Machine>
          ) : null}
        </span>
        <Machine className="fw-event__agent fw-truncate">{agentLabel(event.agent)}</Machine>
        <span className="fw-event__status">
          <StatusBadge status={event.status} size="sm" />
        </span>
        <span className="fw-event__message">{event.message}</span>
        <Icon name="ChevronDown" size="sm" className="fw-event__chev" />
      </button>

      <div
        className="fw-event__detail"
        id={detailId}
        role="region"
        aria-labelledby={headId}
        hidden={!expanded}
      >
        <p className="fw-event__detail-text">{event.detail}</p>
      </div>
    </li>
  );
}

/* ------------------------------------------------------------------ view */

export default function ActivityView() {
  const { state, dispatch } = usePrototype();
  const events = state.data.events;
  const runs = state.data.runs;

  // cc-fix-events-honesty (P1-1): the same "newest run" convention
  // `useGatewayDataset` itself uses — `state.data.events` is only ever
  // populated for this one run, so its truncated/malformed-line honesty
  // belongs to this run specifically, not to Activity as a whole.
  const currentRunId = runs[0]?.id ?? null;
  const eventsMeta = useGatewayEventsMeta(state.activeProjectId, currentRunId);
  // cc-fix-dash-latency (#3): `runs.mjs`'s honest `event_scan_error` signal, keyed by run — unlike
  // `eventsMeta` above (scoped to the one run `/api/events` is polled for), this covers every run
  // this project has, so a group header can show it regardless of which run is "current".
  const eventScanErrors = useGatewayRunScanErrors(state.activeProjectId);

  const [agentFilter, setAgentFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [kindFilter, setKindFilter] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [groupByRun, setGroupByRun] = useState(true);
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(() => new Set<string>());

  const selectedId = state.selection.kind === 'event' ? state.selection.id : null;

  const agentOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const event of events) seen.set(agentKey(event.agent), agentLabel(event.agent));
    return Array.from(seen, ([value, label]) => ({ value, label })).sort((a, b) =>
      a.label.localeCompare(b.label),
    );
  }, [events]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return events.filter((event) => {
      if (agentFilter !== 'all' && agentKey(event.agent) !== agentFilter) return false;
      if (statusFilter !== 'all' && event.status !== statusFilter) return false;
      if (kindFilter !== 'all' && event.kind !== kindFilter) return false;
      if (needle === '') return true;
      return (
        event.message.toLowerCase().includes(needle) || event.detail.toLowerCase().includes(needle)
      );
    });
  }, [events, agentFilter, statusFilter, kindFilter, query]);

  const groups = useMemo(() => {
    const order: string[] = [];
    const byRun = new Map<string, ActivityEvent[]>();
    for (const event of filtered) {
      const bucket = byRun.get(event.runId);
      if (bucket) {
        bucket.push(event);
      } else {
        byRun.set(event.runId, [event]);
        order.push(event.runId);
      }
    }
    return order.map((runId) => {
      const run = runs.find((candidate) => candidate.id === runId);
      return {
        runId,
        // recertify follow-up (Lead): this fallback fires for an ORPHAN event — one whose runId is
        // not in `runs`. It used to read "This run is not part of the example dataset.", which is
        // both a forbidden word and, in production, simply untrue: the event is real, the run
        // record just isn't loaded. Practically unreachable today (every event carries the current
        // runId and every runRow is mapped), but it sits in production-rendering code where the
        // empty-state render test structurally cannot see it — so it says something true instead of
        // waiting to become a visible lie.
        goal: run?.goal ?? 'No run record is loaded for this event.',
        status: run?.status ?? 'waiting',
        startedAt: run?.startedAt ?? '—',
        duration: run?.duration ?? '—',
        events: byRun.get(runId) ?? [],
      };
    });
  }, [filtered, runs]);

  function activateEvent(id: string) {
    setOpenIds((current) => toggleId(current, id));
    dispatch({ type: 'select', selection: { kind: 'event', id } });
  }

  function clearAll() {
    setAgentFilter('all');
    setStatusFilter('all');
    setKindFilter('all');
    setQuery('');
  }

  const activeFilters: ActiveFilter[] = [];
  if (agentFilter !== 'all') {
    activeFilters.push({
      id: 'agent',
      label: 'Agent',
      value: agentOptions.find((option) => option.value === agentFilter)?.label ?? agentFilter,
      clear: () => setAgentFilter('all'),
    });
  }
  if (statusFilter !== 'all') {
    activeFilters.push({
      id: 'status',
      label: 'Status',
      value: statusPresentation(statusFilter as StatusKey).label,
      clear: () => setStatusFilter('all'),
    });
  }
  if (kindFilter !== 'all') {
    activeFilters.push({
      id: 'kind',
      label: 'Kind',
      value: KIND[kindFilter as EventKind].label,
      clear: () => setKindFilter('all'),
    });
  }
  if (query.trim() !== '') {
    activeFilters.push({
      id: 'query',
      label: 'Search',
      value: query.trim(),
      clear: () => setQuery(''),
    });
  }

  return (
    <div className="fw-activity">
      <header className="fw-activity__header">
        <div className="fw-activity__title">
          <Eyebrow>Timeline</Eyebrow>
          <h1 className="fw-activity__h1">Activity</h1>
          <p className="fw-activity__lede">
            Every step recorded, newest first. Open a row to read what the line means rather than
            what it says.
          </p>
        </div>

        <Toolbar label="Activity view controls" className="fw-activity__toolbar">
          <ToolbarGroup>
            <span className="fw-activity__count">
              <Machine muted>
                {filtered.length}/{events.length}
              </Machine>{' '}
              events
            </span>
          </ToolbarGroup>
          <ToolbarGroup divided>
            <Switch
              checked={groupByRun}
              onChange={setGroupByRun}
              label="Group by run"
              size="sm"
            />
          </ToolbarGroup>
        </Toolbar>
      </header>

      <div className="fw-activity__filters">
        <Field label="Search" htmlFor="fw-activity-search" className="fw-activity__filter fw-activity__filter--search">
          <span className="fw-activity__search">
            <Icon name="Search" size="sm" className="fw-activity__search-icon" />
            <input
              id="fw-activity-search"
              type="search"
              className="fw-activity__input"
              placeholder="Message and detail"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </span>
        </Field>

        <Field label="Agent" htmlFor="fw-activity-agent" className="fw-activity__filter">
          <select
            id="fw-activity-agent"
            className="fw-activity__select fg-machine"
            value={agentFilter}
            onChange={(event) => setAgentFilter(event.target.value)}
          >
            <option value="all">All agents</option>
            {agentOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Status" htmlFor="fw-activity-status" className="fw-activity__filter">
          <select
            id="fw-activity-status"
            className="fw-activity__select fg-machine"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
          >
            <option value="all">All statuses</option>
            {STATUS_KEYS.map((status) => (
              <option key={status} value={status}>
                {statusPresentation(status).label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Kind" htmlFor="fw-activity-kind" className="fw-activity__filter">
          <select
            id="fw-activity-kind"
            className="fw-activity__select fg-machine"
            value={kindFilter}
            onChange={(event) => setKindFilter(event.target.value)}
          >
            <option value="all">All kinds</option>
            {EVENT_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {KIND[kind].label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {activeFilters.length > 0 ? (
        <div className="fw-activity__active" role="status">
          <span className="fw-activity__active-label fg-eyebrow">Filtering on</span>
          <ul className="fw-activity__chips">
            {activeFilters.map((filter) => (
              <li key={filter.id} className="fw-activity__chip">
                <span className="fw-activity__chip-label fg-eyebrow">{filter.label}</span>
                <Machine className="fw-activity__chip-value fw-truncate">{filter.value}</Machine>
                <IconButton
                  icon="X"
                  size="sm"
                  label={`Clear the ${filter.label.toLowerCase()} filter`}
                  onClick={filter.clear}
                />
              </li>
            ))}
          </ul>
          <Button size="sm" variant="quiet" icon="ListX" onClick={clearAll}>
            Clear all
          </Button>
        </div>
      ) : null}

      <div className="fw-activity__body fw-scroll">
        {filtered.length === 0 ? (
          <EmptyState
            icon="SearchX"
            title="No events match these filters"
            detail={
              events.length === 0
                ? 'No events have been recorded yet.'
                : `${events.length} event${events.length === 1 ? '' : 's'} recorded. Widen a filter or clear the search to see them.`
            }
            action={
              <Button size="sm" icon="ListX" onClick={clearAll}>
                Clear all filters
              </Button>
            }
          />
        ) : groupByRun ? (
          groups.map((group) => (
            <section
              key={group.runId}
              className="fw-run"
              aria-labelledby={`fw-run-head--${group.runId}`}
            >
              <header className="fw-run__head">
                <h2 id={`fw-run-head--${group.runId}`} className="fw-run__id">
                  <Machine>{group.runId}</Machine>
                </h2>
                <StatusBadge status={group.status} size="sm" />
                <p className="fw-run__goal fw-truncate">{group.goal}</p>
                <p className="fw-run__meta">
                  <Machine muted>{group.startedAt}</Machine>
                  <span className="fw-run__meta-sep" aria-hidden="true">
                    ·
                  </span>
                  <Machine muted>{group.duration}</Machine>
                  <span className="fw-run__meta-sep" aria-hidden="true">
                    ·
                  </span>
                  <Machine muted>{group.events.length}</Machine>
                  <span className="fw-run__meta-word"> events</span>
                </p>
                {group.runId === currentRunId && (eventsMeta.truncated || eventsMeta.malformedLines > 0) ? (
                  <p className="fw-run__meta">
                    {eventsMeta.truncated ? (
                      <span className="fw-run__meta-word">
                        {/* cc-fix-dash-latency: "earlier events were not loaded" was only accurate
                            for the original byte-cap cause — truncation can now ALSO come from the
                            per-run in-memory line cap (`events.mjs`'s `MAX_LINE_RECORDS_PER_ENTRY`),
                            which drops lines that WERE already loaded once, not lines that were
                            never read. "no longer available" is honest for both causes. */}
                        History truncated — earlier events are no longer available
                      </span>
                    ) : null}
                    {eventsMeta.truncated && eventsMeta.malformedLines > 0 ? (
                      <span className="fw-run__meta-sep" aria-hidden="true">
                        ·
                      </span>
                    ) : null}
                    {eventsMeta.malformedLines > 0 ? (
                      <>
                        <Machine muted>{eventsMeta.malformedLines}</Machine>
                        <span className="fw-run__meta-word">
                          {' '}
                          unreadable line{eventsMeta.malformedLines === 1 ? '' : 's'} skipped
                        </span>
                      </>
                    ) : null}
                  </p>
                ) : null}
                {eventScanErrors.get(group.runId) ? (
                  <p className="fw-run__meta">
                    <span className="fw-run__meta-word" title={eventScanErrors.get(group.runId) ?? undefined}>
                      Event log unreadable — event count may be understated
                    </span>
                  </p>
                ) : null}
              </header>

              <ol className="fw-activity__list">
                {group.events.map((event) => (
                  <EventRow
                    key={event.id}
                    event={event}
                    showRun={false}
                    expanded={openIds.has(event.id)}
                    selected={selectedId === event.id}
                    onActivate={activateEvent}
                  />
                ))}
              </ol>
            </section>
          ))
        ) : (
          <ol className="fw-activity__list fw-activity__list--flat">
            {filtered.map((event) => (
              <EventRow
                key={event.id}
                event={event}
                showRun
                expanded={openIds.has(event.id)}
                selected={selectedId === event.id}
                onActivate={activateEvent}
              />
            ))}
          </ol>
        )}

        <RecoveryPanel projectName={state.activeProjectId} />

        <p className="fw-activity__note">
          {isProductionMode() ? (
            <span>This feed updates live as new events arrive from the gateway.</span>
          ) : (
            <>
              <ExampleTag
                text="EXAMPLE FEED"
                detail="Local example events. Nothing is streaming, no log was read and no agent emitted these lines."
              />
              <span>
                Timestamps and agent names are example records. The feed does not update — there is
                nothing connected to update it.
              </span>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
