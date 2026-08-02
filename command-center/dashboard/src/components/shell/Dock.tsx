/**
 * Dock — the collapsible bottom panel.
 *
 * Six panels over the same example dataset: Activity, Terminal, Tests, Events,
 * Proof, Notices. Collapsed it is a rail (--forge-layout-dock-collapsed); open
 * it is --forge-layout-dock tall and its body scrolls inside itself.
 *
 * The Terminal panel is a recorded transcript, not a terminal. It carries an
 * <ExampleTag/> in its own header and its prompt line is visibly inert: there
 * is no input, nothing is parsed and nothing is executed. That is the whole
 * point of the panel — it shows what recorded output would look like.
 */

import { useState } from 'react';
import {
  Eyebrow,
  ExampleTag,
  Icon,
  IconButton,
  Machine,
  Spacer,
  StatusBadge,
  StatusDot,
  TabPanel,
  Tabs,
  statusPresentation,
} from '@/components/primitives';
import { isProductionMode } from '@/config/mode';
// fix-cert-fixtures (forge-2026-07-29-cc-finish): imported directly from the
// small presentation-copy module, NOT from '@/prototype/data' (the gate) —
// that barrel's own top-level import of the full fixture dataset would
// otherwise reach this unconditionally-rendered component. See
// `prototype/data/claude-code.ts`'s header and `tests/unit/fixture-import-
// graph.test.ts`.
import { CLAUDE_CODE_LINK_BY_STATE } from '@/prototype/data/claude-code';
import { usePrototype } from '@/prototype/state/prototype-store';
import type { DockTab, PrototypeState } from '@/prototype/state/prototype-store';
// WP7b: the real gateway connection, not the intentionally-unused bridge one —
// see `gateway-adapter.ts`'s header. Same `ConnectionState` shape.
import { useGatewayConnection as useConnection } from '@/prototype/state/gateway-adapter';
import type { ConnectionState } from '@/prototype/state/bridge-client';
import type { ActivityEvent, ProofEntry, QualityGate, StatusKey } from '@/prototype/types/prototype-types';
import './dock.css';

const TAB_VALUES: readonly DockTab[] = ['activity', 'terminal', 'tests', 'events', 'proof', 'notices'];

const VERDICT_STATUS: Readonly<Record<ProofEntry['verdict'], StatusKey>> = {
  accepted: 'completed',
  rejected: 'failed',
  pending: 'verify',
};

const DOCK_EXAMPLE_NOTE =
  'Everything in the dock is local example data. No log was read, no command was run and no run was observed.';

function toDockTab(value: string): DockTab {
  return TAB_VALUES.includes(value as DockTab) ? (value as DockTab) : 'activity';
}

/** "2026-07-24 15:47:12" -> "15:47:12". Falls back to the whole string. */
function clockOf(timestamp: string): string {
  const parts = timestamp.split(' ');
  return parts.length > 1 ? parts[1] : timestamp;
}

/* --------------------------------------------------------------- activity */

function ActivityPanel({ events, onSelect }: { events: readonly ActivityEvent[]; onSelect: (id: string) => void }) {
  return (
    <div className="fw-dock__panel">
      <div className="fw-dock__panel-head">
        <Eyebrow>ACTIVITY FEED</Eyebrow>
        <Machine muted>{events.length} events</Machine>
        <Spacer />
        <span className="fw-dock__panel-note">Newest first · select a line to open it in the inspector</span>
      </div>
      <div className="fw-dock__rows fw-scroll">
        {events.map((event) => (
          <button
            key={event.id}
            type="button"
            className="fw-dock__event fw-status"
            data-status={event.status}
            onClick={() => onSelect(event.id)}
          >
            <Machine muted className="fw-dock__time">
              {clockOf(event.timestamp)}
            </Machine>
            <StatusDot status={event.status} />
            <Machine muted className="fw-dock__agent fw-truncate">
              {event.agent ?? 'system'}
            </Machine>
            <span className="fw-dock__message fw-truncate">{event.message}</span>
            <Machine muted className="fw-dock__kind">
              {event.kind}
            </Machine>
          </button>
        ))}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- terminal */

function TerminalPanel({
  gates,
  selectedId,
  onSelectGate,
}: {
  gates: readonly QualityGate[];
  selectedId: string;
  onSelectGate: (id: string) => void;
}) {
  const gate = gates.find((candidate) => candidate.id === selectedId) ?? gates[0];
  const lines = gate ? gate.output.split('\n') : [];

  return (
    <div className="fw-dock__panel fw-dock__terminal">
      <div className="fw-dock__transcripts fw-scroll" aria-label="Recorded transcripts">
        <span className="fw-dock__transcripts-label fg-eyebrow">TRANSCRIPTS</span>
        {gates.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            className={candidate.id === gate?.id ? 'fw-dock__transcript is-selected' : 'fw-dock__transcript'}
            aria-pressed={candidate.id === gate?.id}
            onClick={() => onSelectGate(candidate.id)}
          >
            <StatusBadge status={candidate.status} size="sm" iconOnly />
            <span className="fw-truncate">{candidate.name}</span>
          </button>
        ))}
      </div>

      <div className="fw-dock__terminal-main">
        <div className="fw-dock__panel-head">
          <Eyebrow>RECORDED OUTPUT</Eyebrow>
          {gate ? <Machine muted>{gate.lastRun}</Machine> : null}
          <Spacer />
          <ExampleTag detail="Hand-written example console text. No process was started and no output was captured." />
        </div>

        <pre className="fw-dock__log fw-scroll fg-machine" tabIndex={0}>
          {lines.map((line, index) => (
            <span
              key={`${index}-${line}`}
              className="fw-dock__log-line"
              data-line={line.startsWith('$ ') ? 'command' : undefined}
            >
              {line === '' ? ' ' : line}
              {'\n'}
            </span>
          ))}
        </pre>

        <p className="fw-dock__prompt">
          <span className="fg-machine fw-dock__prompt-mark" aria-hidden="true">
            $
          </span>
          <Icon name="Lock" size="xs" className="fw-dock__prompt-icon" />
          <span className="fw-dock__prompt-text">
            {isProductionMode()
              ? 'No input here. This panel does not run commands — it shows recorded output only when the gateway reports it.'
              : 'No input here. This prototype does not run commands — the text above is a recording.'}
          </span>
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ tests */

function TestsPanel({ gates, onSelect }: { gates: readonly QualityGate[]; onSelect: (id: string) => void }) {
  const green = gates.filter((gate) => gate.status === 'completed').length;
  const open = gates.length - green;
  return (
    <div className="fw-dock__panel">
      <div className="fw-dock__panel-head">
        <Eyebrow>QUALITY GATES</Eyebrow>
        <Machine muted>
          {green} completed · {open} open
        </Machine>
        <Spacer />
        <span className="fw-dock__panel-note">A gate that skipped its suites is not a green gate</span>
      </div>
      <div className="fw-dock__rows fw-scroll">
        {gates.map((gate) => (
          <button
            key={gate.id}
            type="button"
            className="fw-dock__gate fw-status"
            data-status={gate.status}
            onClick={() => onSelect(gate.id)}
          >
            <StatusBadge status={gate.status} size="sm" />
            <span className="fw-dock__gate-name fw-truncate">{gate.name}</span>
            <Machine muted className="fw-dock__gate-duration">
              {gate.duration}
            </Machine>
            <Machine muted className="fw-dock__gate-run">
              {gate.lastRun}
            </Machine>
            <Machine muted className="fw-dock__gate-evidence">
              {gate.evidenceCount} evidence
            </Machine>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- events */

function EventsPanel({ events }: { events: readonly ActivityEvent[] }) {
  return (
    <div className="fw-dock__panel">
      <div className="fw-dock__panel-head">
        <Eyebrow>EVENT STREAM</Eyebrow>
        <Machine muted>{isProductionMode() ? 'events.jsonl' : 'events.jsonl · example'}</Machine>
        <Spacer />
        <span className="fw-dock__panel-note">One line per recorded event, as the ledger would hold it</span>
      </div>
      <div className="fw-dock__stream fw-scroll" tabIndex={0}>
        <div className="fw-dock__stream-inner">
          {events.map((event) => (
            <div key={event.id} className="fw-dock__stream-row fw-status" data-status={event.status}>
              <Machine muted>{event.timestamp}</Machine>
              <Machine>{event.kind}</Machine>
              <Machine muted>{event.agent ?? '—'}</Machine>
              <Machine className="fw-dock__stream-status">{statusPresentation(event.status).label}</Machine>
              <Machine muted className="fw-dock__stream-message">
                {event.message}
              </Machine>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ proof */

function ProofPanel({ entries, onSelect }: { entries: readonly ProofEntry[]; onSelect: (id: string) => void }) {
  const accepted = entries.filter((entry) => entry.verdict === 'accepted').length;
  const rejected = entries.filter((entry) => entry.verdict === 'rejected').length;
  return (
    <div className="fw-dock__panel">
      <div className="fw-dock__panel-head">
        <Eyebrow>PROOF LEDGER</Eyebrow>
        <Machine muted>
          {accepted} accepted · {rejected} rejected
        </Machine>
        <Spacer />
        <span className="fw-dock__panel-note">A claim without evidence is rejected, not rounded up</span>
      </div>
      <div className="fw-dock__rows fw-scroll">
        {entries.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className="fw-dock__proof fw-status"
            data-status={VERDICT_STATUS[entry.verdict]}
            onClick={() => onSelect(entry.id)}
          >
            <StatusBadge status={VERDICT_STATUS[entry.verdict]} size="sm" />
            <span className="fw-dock__proof-claim fw-truncate">{entry.claim}</span>
            <Machine muted className="fw-dock__proof-command fw-truncate">
              {entry.command}
            </Machine>
            <Machine muted className="fw-dock__proof-agent fw-truncate">
              {entry.agent}
            </Machine>
            <Machine muted className="fw-dock__proof-task">
              {entry.taskId}
            </Machine>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- notices */

interface Notice {
  readonly id: string;
  readonly icon: string;
  readonly title: string;
  readonly detail: string;
  readonly example?: boolean;
}

/** The bridge connection projected onto a notice icon/title/detail, in production. */
function connectionNoticeIcon(status: ConnectionState['status']): string {
  switch (status) {
    case 'CONNECTED':
      return 'Cable';
    case 'CONNECTING':
      return 'Loader';
    case 'DEGRADED':
      return 'RefreshCw';
    case 'DISCONNECTED':
      return 'Unplug';
  }
}

function connectionNoticeTitle(status: ConnectionState['status']): string {
  switch (status) {
    case 'CONNECTED':
      return 'Connected';
    case 'CONNECTING':
      return 'Connecting';
    case 'DEGRADED':
      return 'Reconnecting';
    case 'DISCONNECTED':
      return 'Disconnected';
  }
}

function connectionNoticeDetail(connection: ConnectionState): string {
  switch (connection.status) {
    case 'CONNECTED':
      return `Connected to the local Forge gateway at ${connection.endpoint}. Everything in the dock is folded from its live event stream.`;
    case 'DISCONNECTED':
      return `The workspace cannot reach the local gateway. Start it with ${connection.startCommand} and it reconnects on its own.`;
    default:
      return connection.detail ?? `Reaching the local gateway at ${connection.endpoint}.`;
  }
}

/**
 * The standing facts about this session. In PRODUCTION they describe the real
 * bridge link and the real records folded from its event log; in FIXTURES they
 * describe the example dataset, unchanged, so the showcase and tests still read
 * the same copy.
 */
function buildNotices(state: PrototypeState, connection: ConnectionState): readonly Notice[] {
  const production = isProductionMode();
  const openGates = state.data.gates.filter((gate) => gate.status !== 'completed');
  const rejected = state.data.proof.filter((entry) => entry.verdict === 'rejected');
  const blockedTasks = state.data.tasks.filter((task) => task.status === 'blocked');
  const counts = `${state.data.projects.length} projects, ${state.data.agents.length} agents, ${state.data.tasks.length} tasks, ${state.data.events.length} events`;

  const linkNotice: Notice = production
    ? {
        id: 'notice-link',
        icon: connectionNoticeIcon(connection.status),
        title: `Local Forge gateway — ${connectionNoticeTitle(connection.status)}`,
        detail: connectionNoticeDetail(connection),
      }
    : ((): Notice => {
        const link = CLAUDE_CODE_LINK_BY_STATE[state.claudeCodeState];
        return {
          id: 'notice-link',
          icon: 'Unplug',
          title: `Local Claude Code link — ${link.title}`,
          detail: `${link.detail} ${link.hint}`,
        };
      })();

  return [
    linkNotice,
    {
      id: 'notice-data',
      icon: production ? 'Database' : 'FlaskConical',
      title: production ? 'Live records in memory' : 'Example dataset in memory',
      detail: production
        // "gateway", not "bridge": in production these records come from the gateway's event log
        // on 127.0.0.1:4100. The bridge is the never-connected original backend — naming it here
        // pointed the reader at the wrong component for data they are looking at right now.
        ? `${counts} — folded from the local gateway's event log as events arrived.`
        : `${counts}. Assembled locally at import time — nothing was fetched, read from disk or awaited.`,
      example: !production,
    },
    {
      id: 'notice-gates',
      icon: 'ShieldCheck',
      title: `${openGates.length} quality gates are not completed`,
      detail:
        openGates.length === 0
          ? production
            ? 'No quality gates have been reported for this workspace yet.'
            : 'Every example gate reports completed.'
          : `${openGates.map((gate) => gate.name).join(', ')}. Skipped suites and held screenshots stay visible rather than being counted as passes.`,
      example: !production,
    },
    {
      id: 'notice-proof',
      icon: 'CircleAlert',
      title: `${rejected.length} completion claims were rejected`,
      detail:
        rejected.length === 0
          ? production
            ? 'No completion claim has been recorded for this workspace yet.'
            : 'No claim in the example ledger was rejected.'
          : `${rejected.map((entry) => entry.taskId).join(', ')} — evidence did not show the claim on the build the claim referred to.`,
      example: !production,
    },
    {
      id: 'notice-blocked',
      icon: 'Lock',
      title: `${blockedTasks.length} tasks are blocked`,
      detail:
        blockedTasks.length === 0
          ? production
            ? 'Nothing on the board is blocked.'
            : 'Nothing in the example board is blocked.'
          : `${blockedTasks.map((task) => task.id).join(', ')} cannot proceed until an earlier step clears.`,
      example: !production,
    },
  ];
}

function NoticesPanel({ notices }: { notices: readonly Notice[] }) {
  return (
    <div className="fw-dock__panel">
      <div className="fw-dock__panel-head">
        <Eyebrow>NOTICES</Eyebrow>
        <Machine muted>{notices.length} standing</Machine>
        <Spacer />
        <span className="fw-dock__panel-note">Standing facts about this session, not alerts</span>
      </div>
      <div className="fw-dock__notices fw-scroll">
        {notices.map((notice) => (
          <article key={notice.id} className="fw-dock__notice">
            <Icon name={notice.icon} size="sm" className="fw-dock__notice-icon" />
            <div className="fw-dock__notice-text">
              <p className="fw-dock__notice-title">
                {notice.title}
                {notice.example ? <ExampleTag detail={DOCK_EXAMPLE_NOTE} /> : null}
              </p>
              <p className="fw-dock__notice-detail">{notice.detail}</p>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- component */

export function Dock() {
  const { state, dispatch } = usePrototype();
  const connection = useConnection();
  const [transcriptId, setTranscriptId] = useState<string>(() => state.data.gates[0]?.id ?? '');

  const open = state.dockOpen;
  const tab = state.dockTab;

  const items = [
    { value: 'activity', label: 'Activity', count: state.data.events.length },
    { value: 'terminal', label: 'Terminal' },
    { value: 'tests', label: 'Tests', count: state.data.gates.length },
    { value: 'events', label: 'Events', count: state.data.events.length },
    { value: 'proof', label: 'Proof', count: state.data.proof.length },
    { value: 'notices', label: 'Notices' },
  ];

  return (
    <section className="fw-dock" data-open={open ? 'true' : 'false'} aria-label="Workspace dock">
      <div className="fw-dock__rail">
        <div className="fw-dock__rail-tabs">
          <Tabs
            items={items}
            value={tab}
            onChange={(value) => dispatch({ type: 'dock/tab', tab: toDockTab(value) })}
            ariaLabel="Dock panels"
            idPrefix="fw-dock"
            size="sm"
          />
        </div>
        <Spacer />
        <ExampleTag detail={DOCK_EXAMPLE_NOTE} />
        <IconButton
          icon={open ? 'PanelBottomClose' : 'PanelBottomOpen'}
          label={open ? 'Collapse dock' : 'Expand dock'}
          size="sm"
          onClick={() => dispatch({ type: 'dock/toggle' })}
        />
      </div>

      {open ? (
        <TabPanel idPrefix="fw-dock" value={tab} active className="fw-dock__body">
          {tab === 'activity' ? (
            <ActivityPanel
              events={state.data.events}
              onSelect={(id) => dispatch({ type: 'select', selection: { kind: 'event', id } })}
            />
          ) : null}
          {tab === 'terminal' ? (
            <TerminalPanel gates={state.data.gates} selectedId={transcriptId} onSelectGate={setTranscriptId} />
          ) : null}
          {tab === 'tests' ? (
            <TestsPanel
              gates={state.data.gates}
              onSelect={(id) => dispatch({ type: 'select', selection: { kind: 'gate', id } })}
            />
          ) : null}
          {tab === 'events' ? <EventsPanel events={state.data.events} /> : null}
          {tab === 'proof' ? (
            <ProofPanel
              entries={state.data.proof}
              onSelect={(id) => dispatch({ type: 'select', selection: { kind: 'proof', id } })}
            />
          ) : null}
          {tab === 'notices' ? <NoticesPanel notices={buildNotices(state, connection)} /> : null}
        </TabPanel>
      ) : null}
    </section>
  );
}

export default Dock;
