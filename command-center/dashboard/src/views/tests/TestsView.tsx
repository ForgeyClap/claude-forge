/**
 * Tests & proof — the quality-gate board and the proof ledger.
 *
 * Two stacked sections over `state.data`, real in production and
 * fixture-labelled example data otherwise:
 *
 *   1. The gate board (state.data.gates). Each row is a disclosure that reveals
 *      its recorded console output.
 *   2. The proof ledger (state.data.proof). One line per completion claim, with
 *      the verify verdict as icon + uppercase label, never colour alone. The
 *      reason is the point of the ledger, so rejected rows open by default.
 */

import { useMemo, useState } from 'react';
import {
  Button,
  EmptyState,
  Eyebrow,
  ExampleTag,
  Field,
  Icon,
  Machine,
  Panel,
  SegmentedControl,
  Spacer,
  StatusBadge,
  Toolbar,
  ToolbarGroup,
} from '@/components/primitives';
import { usePrototype } from '@/prototype/state/prototype-store';
import { isProductionMode } from '@/config/mode';
import type { ProofEntry, QualityGate } from '@/prototype/types/prototype-types';
import './tests.css';

/* ------------------------------------------------------------------ verdict */

type Verdict = ProofEntry['verdict'];
type VerdictFilter = 'all' | Verdict;

interface VerdictPresentation {
  readonly label: string;
  readonly icon: string;
  readonly description: string;
  /** Heading above the reason, phrased for the verdict it belongs to. */
  readonly reasonLabel: string;
}

/*
 * A verdict is a third axis next to status and agent group, so it gets its own
 * presentation map. There is no --forge-verdict-* token trio, so the stylesheet
 * borrows the closest status treatments: completed / failed / waiting.
 */
const VERDICT: Readonly<Record<Verdict, VerdictPresentation>> = {
  accepted: {
    label: 'ACCEPTED',
    icon: 'CircleCheck',
    description: 'Accepted — the attached evidence shows the claim.',
    reasonLabel: 'Why it was accepted',
  },
  rejected: {
    label: 'REJECTED',
    icon: 'CircleX',
    description: 'Rejected — the attached evidence does not show the claim.',
    reasonLabel: 'Why it was rejected',
  },
  pending: {
    label: 'PENDING',
    icon: 'CircleDashed',
    description: 'Pending — the check is still open, so there is no verdict yet.',
    reasonLabel: 'Why it is still open',
  },
};

const VERDICT_FILTERS: readonly VerdictFilter[] = ['all', 'accepted', 'rejected', 'pending'];

function toVerdictFilter(value: string): VerdictFilter {
  return (VERDICT_FILTERS as readonly string[]).includes(value) ? (value as VerdictFilter) : 'all';
}

function VerdictMark({ verdict }: { verdict: Verdict }) {
  const presentation = VERDICT[verdict];
  return (
    <span className="fw-verdict" data-verdict={verdict} title={presentation.description}>
      <Icon name={presentation.icon} size="sm" className="fw-verdict__icon" />
      <span className="fw-verdict__label fg-machine" aria-hidden="true">
        {presentation.label}
      </span>
      <span className="fw-visually-hidden">{presentation.description}</span>
    </span>
  );
}

/* -------------------------------------------------------------------- utils */

function toggleId(current: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(current);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/* ---------------------------------------------------------------- gate row */

interface GateRowProps {
  gate: QualityGate;
  expanded: boolean;
  selected: boolean;
  /** Toggles the output and selects the gate for the inspector, in one gesture. */
  onActivate: (id: string) => void;
}

function GateRow({ gate, expanded, selected, onActivate }: GateRowProps) {
  const headId = `fw-gate-head--${gate.id}`;
  const outputId = `fw-gate-output--${gate.id}`;

  return (
    <li
      className="fw-gate fw-status"
      data-status={gate.status}
      data-selected={selected ? 'true' : undefined}
    >
      <button
        type="button"
        id={headId}
        className="fw-gate__head"
        aria-expanded={expanded}
        aria-controls={outputId}
        onClick={() => onActivate(gate.id)}
      >
        <span className="fw-gate__badge">
          <StatusBadge status={gate.status} size="sm" />
        </span>
        <span className="fw-gate__name fw-truncate">{gate.name}</span>
        <span className="fw-gate__meta">
          <span className="fw-gate__cell">
            <span className="fw-visually-hidden">Duration </span>
            {/* cc-fix-events-honesty (P2-11): '' is not measured-as-empty here — no per-check
                start/end timestamp pair exists anywhere in this gateway (see this view's own
                module header / gateway-adapter.ts's header). An em dash reads as absence; an
                empty cell reads as a rendering bug. */}
            <Machine muted>{gate.duration.trim() !== '' ? gate.duration : '—'}</Machine>
          </span>
          <span className="fw-gate__cell">
            <span className="fw-visually-hidden">Last run </span>
            <Machine muted>{gate.lastRun}</Machine>
          </span>
          <span className="fw-gate__cell">
            <Icon name="Paperclip" size="xs" className="fw-gate__cell-icon" />
            <Machine muted>{gate.evidenceCount}</Machine>
            <span className="fw-visually-hidden"> evidence items</span>
          </span>
        </span>
        <Icon name="ChevronDown" size="sm" className="fw-gate__chev" />
      </button>

      <div
        className="fw-gate__output"
        id={outputId}
        role="region"
        aria-labelledby={headId}
        hidden={!expanded}
      >
        <div className="fw-gate__output-head">
          <Eyebrow>Console output</Eyebrow>
          <Spacer />
          <ExampleTag
            text="EXAMPLE · NOT CONNECTED"
            detail="Hand-written example output. This prototype never ran a command, drove a browser or measured a duration."
          />
        </div>
        <pre className="fw-gate__pre fg-machine">{gate.output}</pre>
      </div>
    </li>
  );
}

/* --------------------------------------------------------------- proof row */

interface ProofRowProps {
  entry: ProofEntry;
  expanded: boolean;
  selected: boolean;
  onActivate: (id: string) => void;
  onSelect: (id: string) => void;
}

function ProofRow({ entry, expanded, selected, onActivate, onSelect }: ProofRowProps) {
  const detailId = `fw-proof-detail--${entry.id}`;
  const presentation = VERDICT[entry.verdict];

  return (
    <tbody
      className="fw-proof__group"
      data-verdict={entry.verdict}
      data-selected={selected ? 'true' : undefined}
    >
      <tr className="fw-proof__row" onClick={() => onSelect(entry.id)}>
        <td className="fw-proof__cell fw-proof__cell--time" data-label="Timestamp">
          <Machine muted>{entry.timestamp}</Machine>
        </td>
        <td className="fw-proof__cell fw-proof__cell--claim" data-label="Claim">
          <button
            type="button"
            className="fw-proof__claim"
            aria-expanded={expanded}
            aria-controls={detailId}
            onClick={() => onActivate(entry.id)}
          >
            <Icon name="ChevronDown" size="xs" className="fw-proof__chev" />
            <span className="fw-proof__claim-text">{entry.claim}</span>
          </button>
        </td>
        <td className="fw-proof__cell" data-label="Agent">
          <Machine>{entry.agent}</Machine>
        </td>
        <td className="fw-proof__cell" data-label="Task">
          {/* cc-fix-events-honesty (P2-11): no task-id source exists on this proof row yet
              (gateway-adapter.ts's toGatewayProof always sets ''); an em dash reads as absence,
              never indistinguishable from "measured as empty". */}
          <Machine muted>{entry.taskId.trim() !== '' ? entry.taskId : '—'}</Machine>
        </td>
        <td className="fw-proof__cell fw-proof__cell--command" data-label="Command">
          <Machine muted>{entry.command}</Machine>
        </td>
        <td className="fw-proof__cell" data-label="Artifact">
          {entry.artifact ? (
            <Machine muted>{entry.artifact}</Machine>
          ) : (
            <span className="fw-proof__none">
              <span aria-hidden="true">—</span>
              <span className="fw-visually-hidden">no artifact attached</span>
            </span>
          )}
        </td>
        <td className="fw-proof__cell fw-proof__cell--verdict" data-label="Verdict">
          <VerdictMark verdict={entry.verdict} />
        </td>
      </tr>

      <tr className="fw-proof__detail-row" id={detailId} hidden={!expanded}>
        <td className="fw-proof__detail" colSpan={7}>
          <div className="fw-proof__detail-inner">
            <Eyebrow>{presentation.reasonLabel}</Eyebrow>
            <p className="fw-proof__reason">{entry.reason}</p>
            <p className="fw-proof__detail-foot">
              <Machine muted>{entry.command}</Machine>
              <ExampleTag
                text="SIMULATED"
                detail="Example ledger line. No command was executed and no verify agent produced this verdict."
              />
            </p>
          </div>
        </td>
      </tr>
    </tbody>
  );
}

/* ------------------------------------------------------------------- view */

export default function TestsView() {
  const { state, dispatch } = usePrototype();
  const gates = state.data.gates;
  const proof = state.data.proof;

  const [openGates, setOpenGates] = useState<ReadonlySet<string>>(() => new Set<string>());
  // The rejections are the reason this screen exists, so they start open.
  const [openProof, setOpenProof] = useState<ReadonlySet<string>>(
    () => new Set(proof.filter((entry) => entry.verdict === 'rejected').map((entry) => entry.id)),
  );
  const [verdictFilter, setVerdictFilter] = useState<VerdictFilter>('all');
  const [agentFilter, setAgentFilter] = useState<string>('all');

  const selectedGateId = state.selection.kind === 'gate' ? state.selection.id : null;
  const selectedProofId = state.selection.kind === 'proof' ? state.selection.id : null;

  const gateSummary = useMemo(() => {
    let passed = 0;
    let failed = 0;
    let blocked = 0;
    let open = 0;
    let evidence = 0;
    for (const gate of gates) {
      evidence += gate.evidenceCount;
      if (gate.status === 'completed') passed += 1;
      else if (gate.status === 'failed') failed += 1;
      else if (gate.status === 'blocked') blocked += 1;
      else open += 1;
    }
    return { passed, failed, blocked, open, evidence };
  }, [gates]);

  const verdictCounts = useMemo(() => {
    let accepted = 0;
    let rejected = 0;
    let pending = 0;
    for (const entry of proof) {
      if (entry.verdict === 'accepted') accepted += 1;
      else if (entry.verdict === 'rejected') rejected += 1;
      else pending += 1;
    }
    return { accepted, rejected, pending };
  }, [proof]);

  const proofAgents = useMemo(
    () => Array.from(new Set(proof.map((entry) => entry.agent))).sort((a, b) => a.localeCompare(b)),
    [proof],
  );

  // A verdict filter chip only appears when at least one ledger line can match
  // it — a chip that can never match is a dead control, not an honest one.
  const verdictOptions = useMemo(() => {
    const seen = new Set(proof.map((entry) => entry.verdict));
    const options: { value: VerdictFilter; label: string; icon?: string }[] = [
      { value: 'all', label: 'All' },
    ];
    if (seen.has('accepted')) options.push({ value: 'accepted', label: 'Accepted', icon: 'CircleCheck' });
    if (seen.has('rejected')) options.push({ value: 'rejected', label: 'Rejected', icon: 'CircleX' });
    if (seen.has('pending')) options.push({ value: 'pending', label: 'Pending', icon: 'CircleDashed' });
    return options;
  }, [proof]);

  const proofRows = useMemo(
    () =>
      proof.filter(
        (entry) =>
          (verdictFilter === 'all' || entry.verdict === verdictFilter) &&
          (agentFilter === 'all' || entry.agent === agentFilter),
      ),
    [proof, verdictFilter, agentFilter],
  );

  const allGatesOpen = openGates.size === gates.length;

  function activateGate(id: string) {
    setOpenGates((current) => toggleId(current, id));
    dispatch({ type: 'select', selection: { kind: 'gate', id } });
  }

  function activateProof(id: string) {
    setOpenProof((current) => toggleId(current, id));
    dispatch({ type: 'select', selection: { kind: 'proof', id } });
  }

  function selectProof(id: string) {
    dispatch({ type: 'select', selection: { kind: 'proof', id } });
  }

  function clearProofFilters() {
    setVerdictFilter('all');
    setAgentFilter('all');
  }

  const filtersActive = verdictFilter !== 'all' || agentFilter !== 'all';

  return (
    <div className="fw-tests">
      <header className="fw-tests__header">
        <div className="fw-tests__title">
          <Eyebrow>Quality</Eyebrow>
          <h1 className="fw-tests__h1">Tests &amp; proof</h1>
          <p className="fw-tests__lede">
            {gates.length} quality gate{gates.length === 1 ? '' : 's'}{' '}
            {gates.length === 1 ? 'stands' : 'stand'} between a mission and a close, and every
            completion claim lands in the ledger with the evidence it was accepted or rejected on.
          </p>
        </div>

        <Toolbar label="Gate board controls" className="fw-tests__toolbar">
          <ToolbarGroup>
            <Button
              size="sm"
              icon="ChevronsUpDown"
              onClick={() => setOpenGates(new Set(gates.map((gate) => gate.id)))}
              disabled={allGatesOpen}
            >
              Expand output
            </Button>
            <Button
              size="sm"
              icon="ChevronsDownUp"
              onClick={() => setOpenGates(new Set<string>())}
              disabled={openGates.size === 0}
            >
              Collapse all
            </Button>
          </ToolbarGroup>
        </Toolbar>
      </header>

      <div className="fw-tests__body fw-scroll">
        {/* ------------------------------------------------------ gate board */}
        <Panel
          title="Quality gates"
          subtitle="Each gate reveals the console output it recorded. Expand a gate to read it."
          padded={false}
          className="fw-tests__panel"
        >
          <div className="fw-gates">
            {/*
              DOM order is dt then dd, which is what the spec wants. The value
              reads above the label because the row is column-reverse, not
              because the markup is upside down.
            */}
            <dl className="fw-tests__summary">
              <div className="fw-tests__stat">
                <dt className="fw-tests__stat-label fg-eyebrow">Gates</dt>
                <dd className="fw-tests__stat-value fg-machine">{gates.length}</dd>
              </div>
              <div className="fw-tests__stat">
                <dt className="fw-tests__stat-label fg-eyebrow">Passed</dt>
                <dd className="fw-tests__stat-value fg-machine">{gateSummary.passed}</dd>
              </div>
              <div className="fw-tests__stat">
                <dt className="fw-tests__stat-label fg-eyebrow">Failed</dt>
                <dd className="fw-tests__stat-value fg-machine">{gateSummary.failed}</dd>
              </div>
              <div className="fw-tests__stat">
                <dt className="fw-tests__stat-label fg-eyebrow">Blocked</dt>
                <dd className="fw-tests__stat-value fg-machine">{gateSummary.blocked}</dd>
              </div>
              <div className="fw-tests__stat">
                <dt className="fw-tests__stat-label fg-eyebrow">Still open</dt>
                <dd className="fw-tests__stat-value fg-machine">{gateSummary.open}</dd>
              </div>
              <div className="fw-tests__stat fw-tests__stat--quiet">
                <dt className="fw-tests__stat-label fg-eyebrow">Evidence items</dt>
                <dd className="fw-tests__stat-value fg-machine">{gateSummary.evidence}</dd>
              </div>
            </dl>

            <div className="fw-gates__legend" aria-hidden="true">
              <span>
                <Eyebrow>Status</Eyebrow>
              </span>
              <span>
                <Eyebrow>Gate</Eyebrow>
              </span>
              <span className="fw-gate__meta">
                <span>
                  <Eyebrow>Duration</Eyebrow>
                </span>
                <span>
                  <Eyebrow>Last run</Eyebrow>
                </span>
                <span>
                  <Eyebrow>Evidence</Eyebrow>
                </span>
              </span>
              <span />
            </div>

            <ul className="fw-gates__list">
              {gates.map((gate) => (
                <GateRow
                  key={gate.id}
                  gate={gate}
                  expanded={openGates.has(gate.id)}
                  selected={selectedGateId === gate.id}
                  onActivate={activateGate}
                />
              ))}
            </ul>
          </div>
        </Panel>

        {/* ----------------------------------------------------- proof ledger */}
        <Panel
          title="Proof ledger"
          subtitle={`${proof.length} claims — ${verdictCounts.accepted} accepted, ${verdictCounts.rejected} rejected, ${verdictCounts.pending} pending. Open a claim to read the reason.`}
          padded={false}
          className="fw-tests__panel"
        >
          <div className="fw-proof">
            <div className="fw-proof__filters">
              <Field label="Verdict" className="fw-proof__filter">
                <SegmentedControl
                  label="Filter the ledger by verdict"
                  size="sm"
                  value={verdictFilter}
                  onChange={(value) => setVerdictFilter(toVerdictFilter(value))}
                  options={verdictOptions}
                />
              </Field>

              <Field label="Agent" htmlFor="fw-proof-agent" className="fw-proof__filter">
                <select
                  id="fw-proof-agent"
                  className="fw-proof__select fg-machine"
                  value={agentFilter}
                  onChange={(event) => setAgentFilter(event.target.value)}
                >
                  <option value="all">All agents</option>
                  {proofAgents.map((agent) => (
                    <option key={agent} value={agent}>
                      {agent}
                    </option>
                  ))}
                </select>
              </Field>

              <Spacer />

              <p className="fw-proof__count">
                <Machine muted>
                  {proofRows.length}/{proof.length}
                </Machine>{' '}
                shown
                {filtersActive ? (
                  <Button size="sm" variant="quiet" icon="X" onClick={clearProofFilters}>
                    Clear filters
                  </Button>
                ) : null}
              </p>
            </div>

            {proofRows.length === 0 ? (
              <EmptyState
                icon="SearchX"
                title="No ledger lines match these filters"
                detail={
                  proof.length === 0
                    ? 'No claims have been ledgered yet.'
                    : `The ledger holds ${proof.length} claim${proof.length === 1 ? '' : 's'}. Widen the verdict or agent filter to see them.`
                }
                action={
                  <Button size="sm" icon="X" onClick={clearProofFilters}>
                    Clear filters
                  </Button>
                }
              />
            ) : (
              <div className="fw-proof__scroll">
                <table className="fw-proof__table">
                  <caption className="fw-visually-hidden">
                    Proof ledger. Each row is a completion claim with the command and artifact it
                    was checked against.
                  </caption>
                  <thead className="fw-proof__thead">
                    <tr>
                      <th scope="col">Timestamp</th>
                      <th scope="col">Claim</th>
                      <th scope="col">Agent</th>
                      <th scope="col">Task</th>
                      <th scope="col">Command</th>
                      <th scope="col">Artifact</th>
                      <th scope="col">Verdict</th>
                    </tr>
                  </thead>
                  {proofRows.map((entry) => (
                    <ProofRow
                      key={entry.id}
                      entry={entry}
                      expanded={openProof.has(entry.id)}
                      selected={selectedProofId === entry.id}
                      onActivate={activateProof}
                      onSelect={selectProof}
                    />
                  ))}
                </table>
              </div>
            )}

            <p className="fw-proof__note">
              <Icon name="Info" size="xs" className="fw-proof__note-icon" />
              {isProductionMode() ? (
                <span>Each line is a completion claim the verify agent checked against real evidence.</span>
              ) : (
                <span>
                  Ledger lines are local example records. No verify agent produced these verdicts and
                  no artifact exists on disk.
                </span>
              )}
            </p>
          </div>
        </Panel>
      </div>
    </div>
  );
}
