/**
 * Forge Workspace — startup reconciliation and recovery drills.
 *
 * `store.reconcileOnStartup()` already does the hard, security-critical half of
 * recovery: for every run persisted in a live status it decides INTERRUPTED
 * (its process is provably gone) or ORPHANED (no pid, or a pid it cannot claim),
 * NEVER COMPLETED; it detects sequence gaps; and `readJsonlSafe` drops only a
 * truncated final event-log line while keeping every fsynced line before it and
 * recording a degraded note for exactly the file and line that was dropped.
 *
 * This module is the workspace-level wrapper around that. It runs the store
 * reconciliation ONCE, then adds the two recovery facts the store cannot know
 * because it does not own them:
 *
 *   1. A project whose folder MOVED or VANISHED. The store indexes event
 *      streams and records; it does not stat every project directory. So here,
 *      each registered project's recorded path is checked against the disk, and
 *      one whose directory is gone has its health set to MISSING — a claim that
 *      something was observed to be wrong, backed by the path that was not there.
 *
 *   2. A run that can be RESUMED. `reconcileOnStartup` is deliberately
 *      conservative: an interrupted process becomes INTERRUPTED. But Claude Code
 *      2.1.217 really can resume a captured session (`--resume <session-id>`), so
 *      an INTERRUPTED run that carries a session id is not merely interrupted —
 *      it is RESUMABLE, which is the truthful and more useful state. The run
 *      state machine permits exactly this transition (INTERRUPTED -> RESUMABLE),
 *      and it is asserted before the record is rewritten.
 *
 * The recovery states this module may write to a run — INTERRUPTED, RECOVERING,
 * RESUMABLE, ORPHANED, FAILED_RECOVERY — are all contract statuses. It never
 * invents one, never writes COMPLETED, and never moves a run into a state the
 * run machine does not allow from where it is.
 *
 * `reconcileWorkspace` returns a structured report and performs no logging of its
 * own; the caller (main.ts) decides what to print. The relative `.ts` imports
 * are deliberate: Node 24 executes this file directly.
 */

import type {
  EvidenceRef,
  OperationalStatus,
  ProjectHealthState,
  ProjectRecord,
} from '../shared/protocol.ts';
import { canRunTransition } from '../shared/state-machines.ts';

import type { ProjectRegistry } from './projects/registry.ts';
import type { RunRecord } from './storage/schema.ts';
import type {
  DegradedNote,
  ForgeStore,
  ReconciliationReport,
  RunReconciliation,
} from './storage/store.ts';

/* ========================================================================== */
/*  Report shapes                                                              */
/* ========================================================================== */

/** The truthful states a run may be moved into during recovery. Never COMPLETED. */
export type RunRecoveryState = Extract<
  OperationalStatus,
  'INTERRUPTED' | 'RECOVERING' | 'RESUMABLE' | 'ORPHANED' | 'FAILED_RECOVERY'
>;

/** One run this module reclassified beyond what the store reconciliation did. */
export interface RunRecoveryOutcome {
  readonly runId: string;
  readonly projectId: string;
  readonly from: OperationalStatus;
  readonly to: RunRecoveryState;
  readonly reason: string;
  readonly sessionId: string | null;
  /** Whether the record was actually rewritten (false when the write failed). */
  readonly applied: boolean;
}

/** A project whose folder was not on disk at its recorded path. */
export interface ProjectRecoveryFinding {
  readonly id: string;
  readonly displayName: string;
  readonly canonicalPath: string;
  readonly from: ProjectHealthState;
  readonly to: 'MISSING';
  readonly detail: string;
  /** True when health MISSING was written; false carries the reason in `note`. */
  readonly healthRecorded: boolean;
  readonly note: string | null;
}

export interface WorkspaceReconciliationReport {
  readonly bridgeInstanceId: string;
  readonly dataDir: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  /** The store's own reconciliation, unchanged. The authority for run status. */
  readonly store: ReconciliationReport;
  readonly runs: {
    /** Exactly what the store moved out of a live status. */
    readonly reconciled: readonly RunReconciliation[];
    readonly interrupted: readonly string[];
    readonly orphaned: readonly string[];
    /** INTERRUPTED runs this module upgraded to RESUMABLE, with evidence. */
    readonly resumable: readonly RunRecoveryOutcome[];
    /** How many additional recovery states this module wrote to run records. */
    readonly recoveryStatesApplied: number;
  };
  readonly projects: {
    /** True only when a registry was supplied and could be listed. */
    readonly checkedAgainstDisk: boolean;
    readonly inspected: number;
    readonly missing: readonly ProjectRecoveryFinding[];
    readonly unreadable: readonly { readonly id: string; readonly detail: string }[];
    readonly healthUpdated: number;
  };
  /** The subset of degraded notes that are a dropped, truncated final log line. */
  readonly truncatedEventLines: readonly DegradedNote[];
  /** Every loss of fidelity the store observed during this reconciliation. */
  readonly degradedNotes: readonly DegradedNote[];
  readonly notes: readonly string[];
}

export interface ReconcileWorkspaceOptions {
  readonly store: ForgeStore;
  /** Supplied so project folders can be checked; omitted means they are not. */
  readonly registry?: ProjectRegistry | null;
  readonly now?: () => Date;
}

/* ========================================================================== */
/*  Reconciliation                                                            */
/* ========================================================================== */

/**
 * Run every startup recovery drill and return what it found.
 *
 * Requires the workspace lock (through `store.reconcileOnStartup`), because it
 * rewrites run records, appends events and updates project health. Call it once,
 * at startup, before serving a request.
 */
export function reconcileWorkspace(options: ReconcileWorkspaceOptions): WorkspaceReconciliationReport {
  const store = options.store;
  const registry = options.registry ?? null;
  const now = options.now ?? ((): Date => new Date());
  const startedAtMs = now().getTime();
  const notes: string[] = [];

  // --- 1. the store's own reconciliation -----------------------------------
  //
  // RUNNING -> INTERRUPTED / ORPHANED (never COMPLETED), sequence-gap detection,
  // and the truncated-tail drop, all recorded as degraded notes.
  const storeReport = store.reconcileOnStartup();

  const interrupted: string[] = [];
  const orphaned: string[] = [];
  for (const item of storeReport.reconciled) {
    if (item.to === 'INTERRUPTED') interrupted.push(item.runId);
    else if (item.to === 'ORPHANED') orphaned.push(item.runId);
  }

  // --- 2. INTERRUPTED runs with a resumable session -> RESUMABLE ------------
  const resumable: RunRecoveryOutcome[] = [];
  let recoveryStatesApplied = 0;
  for (const item of storeReport.reconciled) {
    if (item.to !== 'INTERRUPTED') continue;

    const read = store.getRecord('run', item.runId);
    if (!read.ok) {
      notes.push(`run ${item.runId} could not be re-read after reconciliation (${read.reason}); left INTERRUPTED`);
      continue;
    }
    const run = read.record;

    const sessionId = nonEmptyString(run.sessionId);
    if (sessionId === null) continue; // nothing to resume from; INTERRUPTED stands
    // Defensive: only upgrade a record still sitting where the machine allows it.
    if (run.status !== 'INTERRUPTED' || !canRunTransition(run.status, 'RESUMABLE')) continue;

    const reason =
      `the interrupted run carries Claude Code session ${sessionId}, which 2.1.217 can resume ` +
      `with --resume; it is RESUMABLE rather than merely interrupted`;
    const evidenceRefs: readonly EvidenceRef[] = [
      { kind: 'file', ref: `records/run/${run.id}.json`, note: 'run marked RESUMABLE during startup recovery' },
      { kind: 'event', ref: `claude-session:${sessionId}`, note: 'captured session id, resumable via --resume' },
    ];

    const updated: RunRecord = {
      ...run,
      status: 'RESUMABLE',
      statusReason: reason,
      updatedAt: now().toISOString(),
      evidenceRefs: [...run.evidenceRefs, ...evidenceRefs],
    };

    let applied = false;
    try {
      store.saveRecord('run', updated);
      store.appendEvent({
        projectId: run.projectId,
        runId: run.id,
        conversationId: run.conversationId,
        sessionId: run.sessionId,
        source: 'bridge',
        type: 'run.state',
        status: 'RESUMABLE',
        payload: {
          from: 'INTERRUPTED',
          to: 'RESUMABLE',
          reason,
          sessionId,
          recoveredBy: store.bridgeInstanceId,
        },
        evidenceRefs,
      });
      applied = true;
      recoveryStatesApplied += 1;
    } catch (err) {
      notes.push(`run ${run.id} could not be marked RESUMABLE: ${errorText(err)}`);
    }

    resumable.push({
      runId: run.id,
      projectId: run.projectId,
      from: 'INTERRUPTED',
      to: 'RESUMABLE',
      reason,
      sessionId,
      applied,
    });
  }

  // --- 3. project folders that moved or vanished -> health MISSING ----------
  const missing: ProjectRecoveryFinding[] = [];
  const unreadable: { id: string; detail: string }[] = [];
  let inspected = 0;
  let healthUpdated = 0;
  const checkedAgainstDisk = registry !== null;

  if (registry !== null) {
    let records: readonly ProjectRecord[] | null = null;
    try {
      const listed = registry.list({ includeArchived: true });
      records = listed.records;
      for (const entry of listed.unreadable) {
        unreadable.push({ id: entry.id, detail: `${entry.reason}: ${entry.detail}` });
      }
    } catch (err) {
      notes.push(`the project registry could not be listed during recovery: ${errorText(err)}`);
    }

    if (records !== null) {
      for (const record of records) {
        inspected += 1;
        const check = registry.existsOnDisk(record);
        if (check.present) continue;

        if (record.health === 'MISSING') {
          // Already recorded as gone on a previous startup. Reported, not rewritten.
          missing.push({
            id: record.id,
            displayName: record.displayName,
            canonicalPath: record.canonicalPath,
            from: record.health,
            to: 'MISSING',
            detail: check.detail,
            healthRecorded: true,
            note: 'the project was already recorded MISSING; nothing was rewritten',
          });
          continue;
        }

        const result = registry.setHealth(record.id, 'MISSING', {
          summary: `the project folder is not on disk at its recorded path (${check.detail})`,
          evidenceRefs: [{ kind: 'file', ref: record.canonicalPath, note: check.detail }],
        });
        const recorded = result.ok;
        if (recorded) healthUpdated += 1;
        missing.push({
          id: record.id,
          displayName: record.displayName,
          canonicalPath: record.canonicalPath,
          from: record.health,
          to: 'MISSING',
          detail: check.detail,
          healthRecorded: recorded,
          note: recorded ? null : result.error.message,
        });
      }
    }
  } else {
    notes.push('no project registry was supplied, so project folders were not checked against disk');
  }

  // --- 4. truncated final event-log lines ----------------------------------
  const truncatedEventLines = storeReport.corruption.filter((note) => note.reason === 'jsonl.truncated-tail');

  const finishedAtMs = now().getTime();
  return {
    bridgeInstanceId: store.bridgeInstanceId,
    dataDir: store.dataDir,
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: finishedAtMs - startedAtMs,
    store: storeReport,
    runs: {
      reconciled: storeReport.reconciled,
      interrupted,
      orphaned,
      resumable,
      recoveryStatesApplied,
    },
    projects: {
      checkedAgainstDisk,
      inspected,
      missing,
      unreadable,
      healthUpdated,
    },
    truncatedEventLines,
    degradedNotes: storeReport.corruption,
    notes,
  };
}

/* ========================================================================== */
/*  Small helpers                                                             */
/* ========================================================================== */

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
}
