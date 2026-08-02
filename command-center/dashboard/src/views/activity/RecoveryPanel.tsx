/**
 * RecoveryPanel — recovery attempts, doc-drift, and checkpoints for the active
 * project (`GET /api/recovery`, `GET /api/checkpoints`, `gateway-recovery.ts`).
 *
 * Sits at the foot of the Activity timeline: a recovery attempt IS run
 * history — the GLOBAL_RESEARCH_RECOVERY_POLICY ledger of what was blocked and
 * which safe alternative won — it just is not carried by the selected run's own
 * `events.jsonl`, so it never reaches `state.data.events`. Checkpoints (resume
 * state + run manifests) are the same family of "was work interrupted, can it
 * pick back up" question.
 *
 * DESIGN FROZEN: every class below (`fw-run`, `fw-run__head`, `fw-run__id`,
 * `fw-run__meta`, `fw-run__meta-sep`, `fw-run__meta-word`, `fw-activity__list`,
 * `fw-event`, `fw-status`, `fw-event__node`, `fw-event__head`, `fw-event__stamp`,
 * `fw-event__time`, `fw-event__agent`, `fw-event__status`, `fw-event__message`,
 * `fw-event__chev`, `fw-event__detail*`, `fw-visually-hidden`) already exists in
 * `activity.css` / the app-wide utility sheet and is already used by
 * `ActivityView.tsx`'s own `EventRow`. No new class, no new CSS file.
 *
 * Recovery-attempt rows are read defensively: they are operator-authored JSONL
 * log lines with NO fixed schema (see `gateway-recovery.ts`'s own header) — an
 * absent field renders as `—`, never a guessed default. `NOT CONFIGURED` (no
 * ledger file at all) and `LIVE`-but-empty (a ledger that exists but currently
 * holds nothing) are kept visibly distinct, the same honesty distinction
 * Mission Control's approvals row keeps for gate evaluations.
 */

import { useId, useState } from 'react';
import { EmptyState, Icon, Machine, StatusBadge } from '@/components/primitives';
import { pickString } from '@/prototype/state/gateway-client';
import { useGatewayCheckpoints, useGatewayRecovery } from '@/prototype/state/gateway-recovery';
import type { GatewayDocdriftFinding, GatewayRunManifest } from '@/prototype/state/gateway-recovery';
import type { StatusKey } from '@/prototype/types/prototype-types';
import './activity.css';

export interface RecoveryPanelProps {
  readonly projectName: string;
}

/* ------------------------------------------------------------ derived status */

function attemptStatus(row: Record<string, unknown>): StatusKey {
  const finalStatus = pickString(row, ['finalStatus', 'final_status']) ?? '';
  if (/BLOCKED/i.test(finalStatus)) return 'blocked';
  if (/^(FOUND|FORGE_NATIVE|SAFE_ALTERNATIVE)/i.test(finalStatus)) return 'completed';
  return 'waiting';
}

function findingStatus(finding: GatewayDocdriftFinding): StatusKey {
  return finding.drifted ? 'blocked' : 'completed';
}

function toggleId(current: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(current);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/* --------------------------------------------------------------- one attempt */

interface AttemptRowProps {
  readonly row: Record<string, unknown>;
  readonly index: number;
  readonly expanded: boolean;
  readonly onToggle: (id: string) => void;
}

function AttemptRow({ row, index, expanded, onToggle }: AttemptRowProps) {
  const id = `recovery-attempt-${index}`;
  const detailId = `fw-recovery-detail--${id}`;
  const headId = `fw-recovery-head--${id}`;
  const status = attemptStatus(row);
  const objective = pickString(row, ['objective']) ?? '—';
  const finalStatusText = pickString(row, ['finalStatus', 'final_status']);
  const resultSource = pickString(row, ['resultSource', 'result_source']);
  const itemId = pickString(row, ['itemId', 'item_id']) ?? '—';
  const timestamp = pickString(row, ['timestamp']) ?? '—';

  return (
    <li className="fw-event fw-status" data-status={status}>
      <span className="fw-event__node" title="Recovery attempt">
        <Icon name="RotateCcw" size="sm" />
        <span className="fw-visually-hidden">RECOVERY</span>
      </span>

      <button
        type="button"
        id={headId}
        className="fw-event__head"
        aria-expanded={expanded}
        aria-controls={detailId}
        onClick={() => onToggle(id)}
      >
        <span className="fw-event__stamp">
          <Machine muted className="fw-event__time">
            {timestamp}
          </Machine>
        </span>
        <Machine className="fw-event__agent fw-truncate">{itemId}</Machine>
        <span className="fw-event__status">
          <StatusBadge status={status} size="sm" />
        </span>
        <span className="fw-event__message fw-truncate">{objective}</span>
        <Icon name="ChevronDown" size="sm" className="fw-event__chev" />
      </button>

      <div className="fw-event__detail" id={detailId} role="region" aria-labelledby={headId} hidden={!expanded}>
        <p className="fw-event__detail-text">
          {finalStatusText ?? 'No final status recorded on this attempt.'}
          {resultSource ? <> — <Machine muted>{resultSource}</Machine></> : null}
        </p>
      </div>
    </li>
  );
}

/* ------------------------------------------------------------------ finding */

function FindingRow({ finding }: { finding: GatewayDocdriftFinding }) {
  const status = findingStatus(finding);
  return (
    <li className="fw-event fw-status" data-status={status}>
      <span className="fw-event__node" title="Doc-drift finding">
        <Icon name="SearchCheck" size="sm" />
        <span className="fw-visually-hidden">DOCDRIFT</span>
      </span>
      <div className="fw-event__head">
        <span className="fw-event__stamp">
          <Machine muted className="fw-event__time">
            {finding.lastChecked ?? '—'}
          </Machine>
        </span>
        <Machine className="fw-event__agent fw-truncate">{finding.ruleId || '—'}</Machine>
        <span className="fw-event__status">
          <StatusBadge status={status} size="sm" />
        </span>
        <span className="fw-event__message">{finding.lastStatus ?? '—'}</span>
      </div>
    </li>
  );
}

/* ------------------------------------------------------------------ manifest */

function ManifestRow({ manifest }: { manifest: GatewayRunManifest }) {
  return (
    <li className="fw-event fw-status" data-status="completed">
      <span className="fw-event__node" title="Run manifest">
        <Icon name="ClipboardCheck" size="sm" />
        <span className="fw-visually-hidden">MANIFEST</span>
      </span>
      <div className="fw-event__head">
        <Machine className="fw-event__agent fw-truncate">{manifest.runId || '—'}</Machine>
        <span className="fw-event__status">
          <StatusBadge status="completed" size="sm" />
        </span>
        <span className="fw-event__message">manifest present</span>
      </div>
    </li>
  );
}

/* --------------------------------------------------------------------- view */

export function RecoveryPanel({ projectName }: RecoveryPanelProps) {
  const recovery = useGatewayRecovery(projectName);
  const checkpoints = useGatewayCheckpoints(projectName);
  const headingId = useId();
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(() => new Set<string>());

  function toggle(id: string): void {
    setOpenIds((current) => toggleId(current, id));
  }

  const drifted = recovery.docdriftFindings.filter((finding) => finding.drifted);

  return (
    <section className="fw-run" aria-labelledby={headingId}>
      <header className="fw-run__head">
        <h2 id={headingId} className="fw-run__id">
          <Machine>RECOVERY &amp; CHECKPOINTS</Machine>
        </h2>
        <p className="fw-run__meta">
          <Machine muted>{projectName || '—'}</Machine>
        </p>
      </header>

      {/* ---------------------------------------------------- recovery attempts */}
      {recovery.recoveryProvenance === null ? (
        <EmptyState
          compact
          icon="RotateCcw"
          title="No recovery data yet"
          detail="No project is selected, or the gateway has not answered yet."
        />
      ) : recovery.recoveryProvenance === 'NOT CONFIGURED' ? (
        <EmptyState
          compact
          icon="RotateCcw"
          title="No recovery ledger configured"
          detail="This project has no recovery-attempts.jsonl file under .claude/forge-research."
        />
      ) : recovery.recoveryAttempts.length === 0 ? (
        <EmptyState
          compact
          icon="RotateCcw"
          title="No recovery attempts recorded"
          detail="The recovery ledger exists but currently holds nothing."
        />
      ) : (
        <ol className="fw-activity__list">
          {recovery.recoveryAttempts.map((row, index) => (
            <AttemptRow
              key={`attempt-${index}`}
              row={row}
              index={index}
              expanded={openIds.has(`recovery-attempt-${index}`)}
              onToggle={toggle}
            />
          ))}
        </ol>
      )}

      {/* ------------------------------------------------------------ docdrift */}
      <p className="fw-run__meta">
        <span className="fw-run__meta-word">Docdrift</span>
        <span className="fw-run__meta-sep" aria-hidden="true">
          ·
        </span>
        <Machine muted>
          {recovery.docdriftProvenance === null ? '—' : `${recovery.docdriftFindingsCount} rule(s) checked`}
        </Machine>
        <span className="fw-run__meta-sep" aria-hidden="true">
          ·
        </span>
        <Machine muted>
          {recovery.docdriftProvenance === null ? '—' : `${recovery.docdriftDriftedCount} drifted`}
        </Machine>
        {recovery.docdriftLastCheck ? (
          <>
            <span className="fw-run__meta-sep" aria-hidden="true">
              ·
            </span>
            <Machine muted>{recovery.docdriftLastCheck}</Machine>
          </>
        ) : null}
      </p>
      {drifted.length > 0 ? (
        <ol className="fw-activity__list">
          {drifted.map((finding) => (
            <FindingRow key={finding.ruleId} finding={finding} />
          ))}
        </ol>
      ) : null}

      {/* ---------------------------------------------------------- checkpoints */}
      <p className="fw-run__meta">
        <span className="fw-run__meta-word">Checkpoints</span>
        <span className="fw-run__meta-sep" aria-hidden="true">
          ·
        </span>
        <Machine muted>
          {checkpoints.provenance === null
            ? '—'
            : checkpoints.resumeAvailable
              ? 'resume state available'
              : (checkpoints.resumeNote ?? 'no resume state')}
        </Machine>
      </p>
      {checkpoints.runsWithManifest.length === 0 ? (
        <EmptyState
          compact
          icon="ClipboardCheck"
          title="No run manifests"
          detail="No run under this project has recorded a manifest.json yet."
        />
      ) : (
        <ol className="fw-activity__list">
          {checkpoints.runsWithManifest.map((manifest) => (
            <ManifestRow key={manifest.runId} manifest={manifest} />
          ))}
        </ol>
      )}
    </section>
  );
}

export default RecoveryPanel;
