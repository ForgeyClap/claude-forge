/**
 * Forge Workspace — the persistent store.
 *
 * An append-only JSONL event log plus JSON record files under
 * `.forge-workspace/` at the repository root. No database, no daemon, no
 * network: everything here is local files, opened synchronously, so the
 * sequence assigner has no await point between reading the head of a stream and
 * appending to it.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE. A status is a claim about reality.
 * That has three concrete consequences in the code below:
 *
 *  - `appendEvent` refuses an event whose `type` is not in the protocol's
 *    `EVENT_TYPES`, and refuses a record the contract does not describe. A log
 *    that will later be replayed as history may not contain invented vocabulary.
 *
 *  - `detectGaps` is a first-class operation, not a diagnostic. If sequences
 *    are missing, the client is told; it does not get to render a story with
 *    holes in it and call it complete. That is what drives DEGRADED.
 *
 *  - `reconcileOnStartup` may move a run that claims RUNNING to INTERRUPTED or
 *    ORPHANED. It may never move it to COMPLETED, and it may never leave it
 *    claiming RUNNING. A process we cannot prove is alive is not running, and a
 *    process we cannot prove finished did not finish.
 *
 * Corruption is expected, not exceptional. A hard crash truncates the final
 * JSONL line; that line is dropped, a `bridge.degraded` event records exactly
 * which file and which line, and the rest of the log — already fsynced, already
 * good — is kept.
 *
 * The relative `.ts` imports are deliberate: Node 24 executes TypeScript
 * directly and requires the explicit extension, and bridge code is permitted
 * relative imports.
 */

import { statSync, unlinkSync } from 'node:fs';
import { join, relative, resolve, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import process from 'node:process';

import type { EventType, EvidenceRef, ForgeEvent, OperationalStatus } from '../../shared/protocol.ts';

import {
  acquireLock,
  appendLineDurable,
  containedPath,
  DEFAULT_LOCK_STALE_MS,
  directoryExists,
  ensureDir,
  fileExists,
  isPidAlive,
  readDirSafe,
  readJsonSafe,
  readJsonlSafe,
  releaseLock,
  renewLock,
  sha256,
  sha256File,
  writeJsonAtomic,
} from './atomic.ts';
import type { LockFileContents, LockHandle, ReadResult } from './atomic.ts';

import {
  EVENT_SCHEMA_VERSION,
  RECORD_KINDS,
  RECORD_SCHEMA_VERSIONS,
  WORKSPACE_LAYOUT_VERSION,
  describeIssues,
  isLiveRunStatus,
  migrateEnvelope,
  runMigrations,
  validateEvent,
  validateRecord,
} from './schema.ts';
import type {
  CheckpointRecord,
  CheckpointRecordRef,
  CheckpointScope,
  CheckpointStreamHead,
  MigrationIo,
  MigrationRunReport,
  MigrationState,
  RecordEnvelope,
  RecordKind,
  RecordOf,
  RunRecord,
  ValidationIssue,
} from './schema.ts';

/* ========================================================================== */
/*  Constants and small types                                                  */
/* ========================================================================== */

export const WORKSPACE_DIR_NAME = '.forge-workspace';

/** Project id used for events that belong to the bridge itself, not a project. */
export const BRIDGE_PROJECT_ID = '__bridge__';

/** Placeholder in a stream key for "no run". Not a legal id, so unambiguous. */
export const NO_RUN_TOKEN = '_';

/** Separator in a stream key. Outside the legal id charset, so parsing is exact. */
export const STREAM_KEY_SEPARATOR = '~';

const DEFAULT_EVENT_LIMIT = 1_000;
const MAX_EVENT_LIMIT = 50_000;

const SAFE_ID = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export interface SequenceGap {
  readonly from: number;
  readonly to: number;
  readonly count: number;
}

export interface StreamGapReport {
  readonly streamKey: string;
  readonly gaps: readonly SequenceGap[];
  readonly maxSequence: number;
  readonly eventCount: number;
}

/** A recorded loss of fidelity. Every one of these becomes a bridge.degraded event. */
export interface DegradedNote {
  /** Short stable code, e.g. `jsonl.truncated-tail`. Safe to switch on. */
  readonly reason: string;
  readonly detail: string;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export class StorePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorePathError';
  }
}

export class StoreValidationError extends Error {
  readonly issues: readonly ValidationIssue[];
  constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = 'StoreValidationError';
    this.issues = issues;
  }
}

export class StoreLockError extends Error {
  readonly heldBy: LockFileContents | null;
  constructor(message: string, heldBy: LockFileContents | null) {
    super(message);
    this.name = 'StoreLockError';
    this.heldBy = heldBy;
  }
}

/* ========================================================================== */
/*  Public result shapes                                                       */
/* ========================================================================== */

export interface AppendEventInput<P = unknown> {
  /** Supply one to make the append idempotent across retries. */
  readonly eventId?: string;
  readonly timestamp?: string;
  readonly projectId: string;
  readonly runId?: string | null;
  readonly sessionId?: string | null;
  readonly conversationId?: string | null;
  readonly taskId?: string | null;
  readonly agentId?: string | null;
  readonly source: ForgeEvent['source'];
  readonly type: EventType;
  readonly status?: OperationalStatus;
  readonly payload: P;
  readonly evidenceRefs?: readonly EvidenceRef[];
}

export interface AppendEventResult {
  /** The stored event — the newly written one, or the one already on disk. */
  readonly event: ForgeEvent;
  /** True when this eventId was already present and nothing new was written. */
  readonly deduplicated: boolean;
  readonly streamKey: string;
}

export interface EventQuery {
  readonly projectId?: string;
  /** Omit for every run in the project; pass `null` for the project stream. */
  readonly runId?: string | null;
  /** Overrides projectId/runId when given. */
  readonly streamKey?: string;
  /** Inclusive lower bound on sequence. Defaults to 1. */
  readonly fromSequence?: number;
  readonly limit?: number;
  readonly types?: readonly EventType[];
}

export interface EventPage {
  readonly events: readonly ForgeEvent[];
  readonly streams: readonly string[];
  /**
   * Cursor for the next call, for a single-stream read. Null when the query
   * merged several streams — a merged view has no single monotonic cursor and
   * pretending otherwise would hand the client a false anchor.
   */
  readonly nextSequence: number | null;
  readonly hasMore: boolean;
  readonly gaps: readonly StreamGapReport[];
  readonly issues: readonly DegradedNote[];
}

export type RecordReadFailure =
  | 'MISSING'
  | 'UNREADABLE'
  | 'CORRUPT'
  | 'INVALID'
  | 'KIND_MISMATCH'
  | 'MIGRATION_FAILED';

export type RecordReadResult<T> =
  | {
      readonly ok: true;
      readonly record: T;
      readonly schemaVersion: number;
      readonly storedAt: string;
      readonly migrationsApplied: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason: RecordReadFailure;
      readonly detail: string;
      readonly issues: readonly ValidationIssue[];
    };

export interface RecordListResult<T> {
  readonly records: readonly T[];
  /** Ids that exist on disk but could not be produced, and why. Never hidden. */
  readonly unreadable: readonly { readonly id: string; readonly reason: RecordReadFailure; readonly detail: string }[];
}

export type CheckpointRefState = 'PRESENT' | 'MISSING' | 'HASH_MISMATCH' | 'UNREADABLE';

export interface CheckpointRefStatus {
  readonly ref: CheckpointRecordRef;
  readonly state: CheckpointRefState;
  readonly currentHash: string | null;
}

export interface CheckpointStreamStatus {
  readonly head: CheckpointStreamHead;
  readonly currentSequence: number;
  readonly reachable: boolean;
  readonly detail: string;
}

export interface CheckpointReadResult {
  readonly ok: boolean;
  readonly checkpoint: CheckpointRecord | null;
  readonly refs: readonly CheckpointRefStatus[];
  readonly streams: readonly CheckpointStreamStatus[];
  /**
   * True only when every referenced record is present with a matching hash and
   * every stream can still be replayed to the checkpointed head. Anything less
   * is not a restore, it is a guess.
   */
  readonly restorable: boolean;
  readonly issues: readonly string[];
}

export interface RunReconciliation {
  readonly runId: string;
  readonly projectId: string;
  readonly from: OperationalStatus;
  readonly to: OperationalStatus;
  readonly reason: string;
  readonly pid: number | null;
  /** null means "could not be determined" — never silently read as false. */
  readonly pidAlive: boolean | null;
  readonly previousOwner: string | null;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface ReconciliationReport {
  readonly bridgeInstanceId: string;
  readonly dataDir: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly lockHeld: boolean;
  readonly migrations: MigrationRunReport;
  readonly runsInspected: number;
  readonly runsUnreadable: readonly { readonly id: string; readonly detail: string }[];
  readonly reconciled: readonly RunReconciliation[];
  readonly streamsScanned: number;
  readonly eventsIndexed: number;
  readonly gaps: readonly StreamGapReport[];
  readonly corruption: readonly DegradedNote[];
  readonly degradedEventsRecorded: number;
  readonly notes: readonly string[];
}

export interface StoreStats {
  readonly dataDir: string;
  readonly bridgeInstanceId: string;
  readonly layoutVersion: number;
  readonly streams: number;
  readonly eventsPersisted: number;
  readonly lastEventAt: string | null;
  readonly lockHeld: boolean;
  readonly degradedNotes: number;
}

export interface StoreOptions {
  /** Absolute path to the workspace data directory. Defaults under the repo. */
  readonly dataDir?: string;
  readonly repoRoot?: string;
  readonly bridgeInstanceId?: string;
  /** Default true. Pass false only for read-only inspection or tests. */
  readonly acquireLock?: boolean;
  readonly lockStaleMs?: number;
  readonly now?: () => Date;
}

/* ========================================================================== */
/*  Internals                                                                  */
/* ========================================================================== */

interface StreamState {
  readonly streamKey: string;
  readonly path: string;
  maxSequence: number;
  eventCount: number;
  readonly sequences: Set<number>;
  readonly eventIds: Set<string>;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Reject anything that could escape a directory or collide with a device name. */
export function assertSafeId(id: string, what: string): string {
  if (typeof id !== 'string' || !SAFE_ID.test(id)) {
    throw new StorePathError(
      `${what} must match ${SAFE_ID.source} (got ${JSON.stringify(id)?.slice(0, 80) ?? typeof id})`,
    );
  }
  if (id.includes('..')) throw new StorePathError(`${what} may not contain '..' (got ${id})`);
  if (WINDOWS_RESERVED.test(id)) throw new StorePathError(`${what} is a reserved device name on Windows (got ${id})`);
  return id;
}

export function makeStreamKey(projectId: string, runId: string | null): string {
  assertSafeId(projectId, 'projectId');
  if (runId !== null) assertSafeId(runId, 'runId');
  return `${projectId}${STREAM_KEY_SEPARATOR}${runId ?? NO_RUN_TOKEN}`;
}

export function parseStreamKey(streamKey: string): { readonly projectId: string; readonly runId: string | null } | null {
  const index = streamKey.indexOf(STREAM_KEY_SEPARATOR);
  if (index <= 0) return null;
  const projectId = streamKey.slice(0, index);
  const runPart = streamKey.slice(index + 1);
  if (!SAFE_ID.test(projectId)) return null;
  if (runPart === NO_RUN_TOKEN) return { projectId, runId: null };
  if (!SAFE_ID.test(runPart)) return null;
  return { projectId, runId: runPart };
}

/** `<repoRoot>/src/bridge/storage/store.ts` → `<repoRoot>`. */
function defaultRepoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

/**
 * Resolve the data directory at run time and prove it is usable.
 *
 * Nothing about the path is hardcoded: an explicit option wins, then
 * `FORGE_WORKSPACE_DIR`, then `<repoRoot>/.forge-workspace`. The result must be
 * absolute and must not be a filesystem root, because a store rooted at `C:\`
 * would be free to walk the whole disk.
 */
export function resolveDataDir(options: StoreOptions = {}): string {
  const fromEnv = process.env.FORGE_WORKSPACE_DIR;
  const repoRoot = options.repoRoot ? resolve(options.repoRoot) : defaultRepoRoot();
  const raw = options.dataDir ?? (fromEnv && fromEnv.trim().length > 0 ? fromEnv : join(repoRoot, WORKSPACE_DIR_NAME));
  const dataDir = resolve(raw);
  if (!isAbsolute(dataDir)) {
    throw new StorePathError(`workspace data directory must be absolute (got ${raw})`);
  }
  if (dirname(dataDir) === dataDir) {
    throw new StorePathError(`workspace data directory may not be a filesystem root (got ${dataDir})`);
  }
  return dataDir;
}

/* ========================================================================== */
/*  The store                                                                  */
/* ========================================================================== */

export class ForgeStore {
  readonly dataDir: string;
  readonly bridgeInstanceId: string;

  private readonly now: () => Date;
  private readonly streams = new Map<string, StreamState>();
  private readonly pendingDegraded: DegradedNote[] = [];
  private readonly recordedDegraded: DegradedNote[] = [];
  private lock: LockHandle | null = null;
  private lastEventAt: string | null = null;
  private closed = false;

  private constructor(dataDir: string, options: StoreOptions) {
    this.dataDir = dataDir;
    this.now = options.now ?? (() => new Date());
    this.bridgeInstanceId = options.bridgeInstanceId ?? randomUUID();
  }

  /**
   * Open the workspace: create the layout, take the advisory lock, index every
   * existing stream and record whatever damage the scan finds.
   *
   * Throws `StoreLockError` when another live bridge instance holds the lock.
   * That is deliberate — two instances interleaving appends into one JSONL log
   * is exactly the corruption this layer is built to prevent.
   */
  static open(options: StoreOptions = {}): ForgeStore {
    const dataDir = resolveDataDir(options);
    const store = new ForgeStore(dataDir, options);
    store.initLayout();
    if (options.acquireLock !== false) {
      store.takeLock(options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS);
    }
    store.indexAllStreams();
    // Without the lock this instance has no right to write: another bridge may
    // be appending to these same logs. Whatever the scan found stays queued and
    // is still reported by `degradedNotes()`, it just does not reach the log.
    if (store.lockHeld) store.flushDegradedNotes();
    return store;
  }

  /* ---------------------------------------------------------------- layout */

  private initLayout(): void {
    ensureDir(this.dataDir);
    ensureDir(join(this.dataDir, 'meta'));
    ensureDir(join(this.dataDir, 'events'));
    for (const kind of RECORD_KINDS) ensureDir(join(this.dataDir, 'records', kind));

    const metaPath = join(this.dataDir, 'meta', 'workspace.json');
    if (!fileExists(metaPath)) {
      writeJsonAtomic(metaPath, {
        layoutVersion: WORKSPACE_LAYOUT_VERSION,
        eventSchemaVersion: EVENT_SCHEMA_VERSION,
        recordSchemaVersions: RECORD_SCHEMA_VERSIONS,
        createdAt: this.now().toISOString(),
      });
    }
  }

  private takeLock(staleMs: number): void {
    const result = acquireLock(join(this.dataDir, 'bridge.lock'), {
      staleMs,
      owner: `forge-bridge:${this.bridgeInstanceId}`,
      now: this.now,
    });
    if (!result.ok) {
      throw new StoreLockError(
        `could not acquire the workspace lock (${result.reason}): ${result.detail}`,
        result.heldBy,
      );
    }
    this.lock = result.handle;
    if (result.handle.tookOverFrom !== null) {
      this.pendingDegraded.push({
        reason: 'lock.stale-takeover',
        detail:
          `took over a stale workspace lock previously held by pid ${result.handle.tookOverFrom.pid} ` +
          `(${result.handle.takeoverReason ?? 'no reason recorded'})`,
        evidenceRefs: [{ kind: 'file', ref: this.relativeToDataDir(result.handle.path), note: 'bridge.lock' }],
      });
    }
  }

  /** Refresh the lock heartbeat. False when the lock is gone or now foreign. */
  renewLockHeartbeat(): boolean {
    if (this.lock === null) return false;
    return renewLock(this.lock, this.now);
  }

  get lockHeld(): boolean {
    return this.lock !== null;
  }

  /** Release the lock. Safe to call twice. Does not delete any data. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.lock !== null) {
      releaseLock(this.lock);
      this.lock = null;
    }
  }

  /* ------------------------------------------------------------------ paths */

  private relativeToDataDir(absolutePath: string): string {
    const rel = relative(this.dataDir, absolutePath);
    return rel.length === 0 ? '.' : rel.split('\\').join('/');
  }

  private contained(path: string, what: string): string {
    const safe = containedPath(this.dataDir, path);
    if (safe === null) {
      throw new StorePathError(`${what} resolved outside the workspace data directory: ${path}`);
    }
    return safe;
  }

  private streamPath(streamKey: string): string {
    const parsed = parseStreamKey(streamKey);
    if (parsed === null) throw new StorePathError(`invalid stream key: ${JSON.stringify(streamKey)}`);
    return this.contained(join(this.dataDir, 'events', `${streamKey}.jsonl`), 'event stream');
  }

  private recordPath(kind: RecordKind, id: string): string {
    assertSafeId(id, `${kind} record id`);
    return this.contained(join(this.dataDir, 'records', kind, `${id}.json`), `${kind} record`);
  }

  /* ----------------------------------------------------------------- events */

  private indexAllStreams(): void {
    const dir = join(this.dataDir, 'events');
    if (!directoryExists(dir)) return;
    for (const file of readDirSafe(dir).files) {
      if (!file.endsWith('.jsonl')) continue;
      const streamKey = file.slice(0, -'.jsonl'.length);
      if (parseStreamKey(streamKey) === null) {
        this.pendingDegraded.push({
          reason: 'events.unparseable-stream-name',
          detail: `file ${file} is in the events directory but its name is not a valid stream key; it was not indexed`,
          evidenceRefs: [{ kind: 'file', ref: `events/${file}` }],
        });
        continue;
      }
      this.loadStream(streamKey);
    }
  }

  private loadStream(streamKey: string): StreamState {
    const existing = this.streams.get(streamKey);
    if (existing) return existing;

    const path = this.streamPath(streamKey);
    const state: StreamState = {
      streamKey,
      path,
      maxSequence: 0,
      eventCount: 0,
      sequences: new Set<number>(),
      eventIds: new Set<string>(),
    };

    const read = readJsonlSafe(path);
    if (read.existed && !read.readable) {
      this.pendingDegraded.push({
        reason: 'events.unreadable',
        detail: `event stream ${streamKey} exists but could not be read: ${read.detail ?? 'no detail'}`,
        evidenceRefs: [{ kind: 'file', ref: this.relativeToDataDir(path) }],
      });
      this.streams.set(streamKey, state);
      return state;
    }

    for (const line of read.lines) {
      const validation = validateEvent(line.value);
      if (!validation.ok) {
        this.pendingDegraded.push({
          reason: 'events.invalid-line',
          detail:
            `event stream ${streamKey} line ${line.lineNumber} does not satisfy the protocol contract ` +
            `and was skipped for replay: ${describeIssues(validation.issues)}`,
          evidenceRefs: [{ kind: 'file', ref: `${this.relativeToDataDir(path)}#L${line.lineNumber}` }],
        });
        continue;
      }
      const event = line.value as unknown as ForgeEvent;
      if (state.sequences.has(event.sequence)) {
        this.pendingDegraded.push({
          reason: 'events.duplicate-sequence',
          detail: `event stream ${streamKey} line ${line.lineNumber} repeats sequence ${event.sequence}; the later line is kept for replay`,
          evidenceRefs: [{ kind: 'file', ref: `${this.relativeToDataDir(path)}#L${line.lineNumber}` }],
        });
      }
      state.sequences.add(event.sequence);
      state.eventIds.add(event.eventId);
      state.eventCount += 1;
      if (event.sequence > state.maxSequence) state.maxSequence = event.sequence;
      if (this.lastEventAt === null || event.timestamp > this.lastEventAt) this.lastEventAt = event.timestamp;
    }

    for (const damage of read.corruption) {
      this.pendingDegraded.push({
        reason: damage.kind === 'TRUNCATED_TAIL' ? 'jsonl.truncated-tail' : 'jsonl.corrupt-line',
        detail:
          `event stream ${streamKey} line ${damage.lineNumber}: ${damage.detail}. ` +
          (damage.kind === 'TRUNCATED_TAIL'
            ? 'Only that line was dropped; every earlier line was kept.'
            : 'The line was left on disk and skipped for replay.'),
        evidenceRefs: [{ kind: 'file', ref: `${this.relativeToDataDir(path)}#L${damage.lineNumber}` }],
      });
    }
    if (read.finalLineUnterminated) {
      this.pendingDegraded.push({
        reason: 'jsonl.unterminated-final-line',
        detail: `event stream ${streamKey} does not end with a newline; the final line parsed and was kept, but the writer did not finish cleanly`,
        evidenceRefs: [{ kind: 'file', ref: this.relativeToDataDir(path) }],
      });
    }

    this.streams.set(streamKey, state);
    return state;
  }

  /**
   * Append one event.
   *
   * Idempotent by `eventId`: appending the same id twice stores it once and the
   * second call returns the event already on disk with `deduplicated: true`.
   * The sequence is assigned here and only here — a caller cannot choose it,
   * which is what keeps `detectGaps` meaningful.
   *
   * Throws `StoreValidationError` when the event does not satisfy the protocol
   * contract, including an event type the protocol does not define.
   */
  appendEvent<P = unknown>(input: AppendEventInput<P>): AppendEventResult {
    this.assertOpen();
    const runId = input.runId ?? null;
    const streamKey = makeStreamKey(input.projectId, runId);
    const state = this.loadStream(streamKey);
    const eventId = input.eventId ?? randomUUID();

    if (state.eventIds.has(eventId)) {
      const existing = this.findStoredEvent(streamKey, eventId);
      if (existing !== null) return { event: existing, deduplicated: true, streamKey };
      // Indexed but not findable on disk: the in-memory index and the file
      // disagree, which means something wrote to this log without the lock. The
      // event is still written — we hold the lock and dropping it would lose
      // data — but the disagreement is queued as a degraded note rather than
      // appended here, because appending from inside an append is how a
      // recursive write loop starts.
      this.noteDegraded({
        reason: 'events.index-mismatch',
        detail: `eventId ${eventId} is indexed for stream ${streamKey} but no matching line was found on disk`,
        evidenceRefs: [{ kind: 'file', ref: this.relativeToDataDir(state.path) }],
      });
    }

    const nowIso = input.timestamp ?? this.now().toISOString();
    const event: ForgeEvent<P> = {
      eventId,
      schemaVersion: EVENT_SCHEMA_VERSION,
      sequence: state.maxSequence + 1,
      timestamp: nowIso,
      projectId: input.projectId,
      runId,
      sessionId: input.sessionId ?? null,
      conversationId: input.conversationId ?? null,
      taskId: input.taskId ?? null,
      agentId: input.agentId ?? null,
      source: input.source,
      type: input.type,
      ...(input.status !== undefined ? { status: input.status } : {}),
      payload: input.payload,
      evidenceRefs: input.evidenceRefs ?? [],
      ingestedAt: this.now().getTime(),
    };

    const validation = validateEvent(event);
    if (!validation.ok) {
      throw new StoreValidationError(
        `refusing to persist an event that does not satisfy the protocol contract: ${describeIssues(validation.issues)}`,
        validation.issues,
      );
    }

    appendLineDurable(state.path, JSON.stringify(event));
    state.sequences.add(event.sequence);
    state.eventIds.add(event.eventId);
    state.eventCount += 1;
    state.maxSequence = event.sequence;
    if (this.lastEventAt === null || event.timestamp > this.lastEventAt) this.lastEventAt = event.timestamp;

    return { event: event as ForgeEvent, deduplicated: false, streamKey };
  }

  private findStoredEvent(streamKey: string, eventId: string): ForgeEvent | null {
    const read = readJsonlSafe(this.streamPath(streamKey));
    for (let i = read.lines.length - 1; i >= 0; i -= 1) {
      const value = read.lines[i].value;
      if (value.eventId === eventId && validateEvent(value).ok) return value as unknown as ForgeEvent;
    }
    return null;
  }

  /** Every stream key the workspace currently knows about. */
  listStreams(): readonly string[] {
    return [...this.streams.keys()].sort();
  }

  /**
   * Read events for replay.
   *
   * `fromSequence` is inclusive. For a single stream the result carries a
   * `nextSequence` cursor; for a merged multi-stream read it does not, because
   * there is no single sequence that means the same thing in two streams.
   */
  readEvents(query: EventQuery = {}): EventPage {
    this.assertOpen();
    const streamKeys = this.resolveQueryStreams(query);
    const fromSequence = Math.max(1, query.fromSequence ?? 1);
    const limit = Math.min(Math.max(1, query.limit ?? DEFAULT_EVENT_LIMIT), MAX_EVENT_LIMIT);
    const typeFilter = query.types ? new Set<string>(query.types) : null;

    const issues: DegradedNote[] = [];
    const collected: ForgeEvent[] = [];

    for (const streamKey of streamKeys) {
      const path = this.streamPath(streamKey);
      const read = readJsonlSafe(path);
      if (read.existed && !read.readable) {
        issues.push({
          reason: 'events.unreadable',
          detail: `event stream ${streamKey} could not be read: ${read.detail ?? 'no detail'}`,
          evidenceRefs: [{ kind: 'file', ref: this.relativeToDataDir(path) }],
        });
        continue;
      }
      for (const damage of read.corruption) {
        issues.push({
          reason: damage.kind === 'TRUNCATED_TAIL' ? 'jsonl.truncated-tail' : 'jsonl.corrupt-line',
          detail: `event stream ${streamKey} line ${damage.lineNumber}: ${damage.detail}`,
          evidenceRefs: [{ kind: 'file', ref: `${this.relativeToDataDir(path)}#L${damage.lineNumber}` }],
        });
      }
      for (const line of read.lines) {
        if (!validateEvent(line.value).ok) continue;
        const event = line.value as unknown as ForgeEvent;
        if (event.sequence < fromSequence) continue;
        if (typeFilter !== null && !typeFilter.has(event.type)) continue;
        collected.push(event);
      }
    }

    const singleStream = streamKeys.length === 1;
    collected.sort((a, b) => {
      if (singleStream) return a.sequence - b.sequence;
      const at = a.ingestedAt ?? Date.parse(a.timestamp);
      const bt = b.ingestedAt ?? Date.parse(b.timestamp);
      if (at !== bt) return at - bt;
      if (a.projectId !== b.projectId) return a.projectId < b.projectId ? -1 : 1;
      return a.sequence - b.sequence;
    });

    const page = collected.slice(0, limit);
    const hasMore = collected.length > limit;
    const nextSequence =
      singleStream && page.length > 0 ? page[page.length - 1].sequence + 1 : singleStream ? fromSequence : null;

    return {
      events: page,
      streams: streamKeys,
      nextSequence,
      hasMore,
      gaps: streamKeys.map((key) => this.gapReport(key)),
      issues,
    };
  }

  private resolveQueryStreams(query: EventQuery): readonly string[] {
    if (query.streamKey !== undefined) {
      if (parseStreamKey(query.streamKey) === null) {
        throw new StorePathError(`invalid stream key: ${JSON.stringify(query.streamKey)}`);
      }
      return [query.streamKey];
    }
    if (query.projectId === undefined) return this.listStreams();
    assertSafeId(query.projectId, 'projectId');
    const runGiven = Object.prototype.hasOwnProperty.call(query, 'runId');
    if (runGiven) return [makeStreamKey(query.projectId, query.runId ?? null)];
    const prefix = `${query.projectId}${STREAM_KEY_SEPARATOR}`;
    return this.listStreams().filter((key) => key.startsWith(prefix));
  }

  /**
   * Missing sequence ranges for a stream, between 1 and the highest sequence
   * seen. This is the signal the client uses to decide it is DEGRADED: a gap
   * means events that were assigned a number are not on disk, so any timeline
   * built from this stream is provably incomplete.
   */
  detectGaps(streamKey: string): readonly SequenceGap[] {
    const state = this.streams.get(streamKey) ?? this.loadStream(streamKey);
    const gaps: SequenceGap[] = [];
    let runStart: number | null = null;
    for (let seq = 1; seq <= state.maxSequence; seq += 1) {
      const present = state.sequences.has(seq);
      if (!present && runStart === null) runStart = seq;
      if (present && runStart !== null) {
        gaps.push({ from: runStart, to: seq - 1, count: seq - runStart });
        runStart = null;
      }
    }
    if (runStart !== null) {
      gaps.push({ from: runStart, to: state.maxSequence, count: state.maxSequence - runStart + 1 });
    }
    return gaps;
  }

  private gapReport(streamKey: string): StreamGapReport {
    const state = this.streams.get(streamKey) ?? this.loadStream(streamKey);
    return {
      streamKey,
      gaps: this.detectGaps(streamKey),
      maxSequence: state.maxSequence,
      eventCount: state.eventCount,
    };
  }

  /* ---------------------------------------------------------------- records */

  /**
   * Persist a record. The record is validated against the contract shape for
   * its kind first; an invalid record throws rather than reaching disk, because
   * a malformed record is a bug in the caller, not an expected state.
   */
  saveRecord<K extends RecordKind>(kind: K, record: RecordOf<K>): RecordOf<K> {
    this.assertOpen();
    const validation = validateRecord(kind, record);
    if (!validation.ok) {
      throw new StoreValidationError(
        `refusing to persist an invalid ${kind} record: ${describeIssues(validation.issues)}`,
        validation.issues,
      );
    }
    const id = (record as { id: string }).id;
    const path = this.recordPath(kind, id);
    const envelope: RecordEnvelope<RecordOf<K>> = {
      kind,
      id,
      schemaVersion: RECORD_SCHEMA_VERSIONS[kind],
      storedAt: this.now().toISOString(),
      record,
    };
    writeJsonAtomic(path, envelope);
    return record;
  }

  /**
   * Read a record. Corruption is an expected outcome after a crash, so this
   * returns a typed result and never throws for bad data on disk.
   */
  getRecord<K extends RecordKind>(kind: K, id: string): RecordReadResult<RecordOf<K>> {
    const path = this.recordPath(kind, id);
    const read = readJsonSafe<RecordEnvelope>(path);
    if (!read.ok) {
      const reason: RecordReadFailure =
        read.reason === 'MISSING' ? 'MISSING' : read.reason === 'UNREADABLE' ? 'UNREADABLE' : 'CORRUPT';
      return { ok: false, reason, detail: read.detail, issues: [] };
    }

    const envelope = read.value;
    if (envelope.kind !== kind) {
      return {
        ok: false,
        reason: 'KIND_MISMATCH',
        detail: `file ${this.relativeToDataDir(path)} says kind ${String(envelope.kind)} but was read as ${kind}`,
        issues: [],
      };
    }
    if (typeof envelope.schemaVersion !== 'number' || !Object.prototype.hasOwnProperty.call(envelope, 'record')) {
      return {
        ok: false,
        reason: 'CORRUPT',
        detail: `file ${this.relativeToDataDir(path)} is not a record envelope`,
        issues: [],
      };
    }

    const migrated = migrateEnvelope(envelope, undefined, this.now);
    if (!migrated.ok) {
      return { ok: false, reason: 'MIGRATION_FAILED', detail: migrated.detail, issues: [] };
    }

    const validation = validateRecord(kind, migrated.envelope.record);
    if (!validation.ok) {
      return {
        ok: false,
        reason: 'INVALID',
        detail: `stored ${kind} record ${id} does not satisfy the contract: ${describeIssues(validation.issues)}`,
        issues: validation.issues,
      };
    }

    return {
      ok: true,
      record: migrated.envelope.record as RecordOf<K>,
      schemaVersion: migrated.envelope.schemaVersion,
      storedAt: migrated.envelope.storedAt,
      migrationsApplied: migrated.applied,
    };
  }

  listRecordIds(kind: RecordKind): readonly string[] {
    const dir = this.contained(join(this.dataDir, 'records', kind), `${kind} record directory`);
    return readDirSafe(dir)
      .files.filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .filter((id) => SAFE_ID.test(id));
  }

  /** Every readable record of a kind, plus an explicit list of what was not. */
  listRecords<K extends RecordKind>(kind: K): RecordListResult<RecordOf<K>> {
    const records: RecordOf<K>[] = [];
    const unreadable: { id: string; reason: RecordReadFailure; detail: string }[] = [];
    for (const id of this.listRecordIds(kind)) {
      const result = this.getRecord(kind, id);
      if (result.ok) records.push(result.record);
      else unreadable.push({ id, reason: result.reason, detail: result.detail });
    }
    return { records, unreadable };
  }

  hasRecord(kind: RecordKind, id: string): boolean {
    return fileExists(this.recordPath(kind, id));
  }

  /** Remove a record file. Returns false when there was nothing to remove. */
  deleteRecord(kind: RecordKind, id: string): boolean {
    this.assertOpen();
    const path = this.recordPath(kind, id);
    if (!fileExists(path)) return false;
    try {
      unlinkSync(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read-modify-write under the process lock. Returns null when the record does
   * not exist or cannot be read; the failure detail is available from
   * `getRecord` if the caller needs to distinguish the two.
   */
  updateRecord<K extends RecordKind>(kind: K, id: string, mutate: (current: RecordOf<K>) => RecordOf<K>): RecordOf<K> | null {
    const current = this.getRecord(kind, id);
    if (!current.ok) return null;
    return this.saveRecord(kind, mutate(current.record));
  }

  /* ------------------------------------------------------------ checkpoints */

  /**
   * Capture the current sequence heads and record snapshot references for a
   * scope. Contents are referenced by hash, not copied: the point is to be able
   * to prove later that the material is unchanged, which a copy cannot do any
   * better and a copy of a large workspace would do far more slowly.
   *
   * `complete` is false when any in-scope record could not be read. A partial
   * checkpoint is recorded as partial rather than presented as a full one.
   */
  createCheckpoint(scope: CheckpointScope, note = ''): CheckpointRecord {
    this.assertOpen();
    if (scope.kind === 'workspace') {
      if (scope.id !== null) throw new StorePathError('the workspace checkpoint scope must have a null id');
    } else {
      assertSafeId(scope.id ?? '', `${scope.kind} checkpoint scope id`);
    }

    const streamHeads: CheckpointStreamHead[] = [];
    for (const streamKey of this.streamsInScope(scope)) {
      const state = this.streams.get(streamKey) ?? this.loadStream(streamKey);
      streamHeads.push({
        streamKey,
        sequence: state.maxSequence,
        eventCount: state.eventCount,
        gaps: this.detectGaps(streamKey).map((g) => ({ from: g.from, to: g.to })),
      });
    }

    const recordRefs: CheckpointRecordRef[] = [];
    let complete = true;
    for (const kind of RECORD_KINDS) {
      if (kind === 'checkpoint') continue; // a checkpoint never references itself
      for (const id of this.listRecordIds(kind)) {
        const result = this.getRecord(kind, id);
        if (!result.ok) {
          if (this.recordMightBeInScope(kind, id, scope)) {
            complete = false;
            recordRefs.push({
              kind,
              id,
              path: this.relativeToDataDir(this.recordPath(kind, id)),
              schemaVersion: RECORD_SCHEMA_VERSIONS[kind],
              hash: null,
              bytes: null,
              readable: false,
            });
          }
          continue;
        }
        if (!this.recordInScope(kind, result.record, scope)) continue;
        const path = this.recordPath(kind, id);
        recordRefs.push({
          kind,
          id,
          path: this.relativeToDataDir(path),
          schemaVersion: result.schemaVersion,
          hash: sha256File(path),
          bytes: this.sizeOf(path),
          readable: true,
        });
      }
    }

    const checkpoint: CheckpointRecord = {
      id: `cp-${this.now().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`,
      createdAt: this.now().toISOString(),
      scope,
      bridgeInstanceId: this.bridgeInstanceId,
      streamHeads,
      recordRefs,
      recordCount: recordRefs.length,
      note,
      complete,
    };

    this.saveRecord('checkpoint', checkpoint);
    this.appendEvent({
      projectId: scope.kind === 'project' ? (scope.id ?? BRIDGE_PROJECT_ID) : BRIDGE_PROJECT_ID,
      runId: scope.kind === 'run' ? scope.id : null,
      source: 'bridge',
      type: 'checkpoint.created',
      payload: {
        checkpointId: checkpoint.id,
        scope,
        streamHeads: checkpoint.streamHeads,
        recordCount: checkpoint.recordCount,
        complete: checkpoint.complete,
      },
      evidenceRefs: [
        { kind: 'file', ref: this.relativeToDataDir(this.recordPath('checkpoint', checkpoint.id)) },
      ],
    });

    return checkpoint;
  }

  listCheckpoints(scope?: CheckpointScope): readonly CheckpointRecord[] {
    const { records } = this.listRecords('checkpoint');
    const filtered = scope
      ? records.filter((cp) => cp.scope.kind === scope.kind && cp.scope.id === scope.id)
      : records;
    return [...filtered].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  }

  /**
   * The read side of a restore: resolve every reference, re-hash every file and
   * check every stream head is still reachable.
   *
   * It deliberately does not write anything. Deciding to overwrite live state
   * is a policy call that belongs to whoever owns the run lifecycle; this layer
   * supplies the evidence that the restore would be faithful, including the
   * cases where it would not.
   */
  readCheckpoint(checkpointId: string): CheckpointReadResult {
    const read = this.getRecord('checkpoint', checkpointId);
    if (!read.ok) {
      return {
        ok: false,
        checkpoint: null,
        refs: [],
        streams: [],
        restorable: false,
        issues: [`checkpoint ${checkpointId} could not be read (${read.reason}): ${read.detail}`],
      };
    }
    const checkpoint = read.record;
    const issues: string[] = [];

    const refs: CheckpointRefStatus[] = checkpoint.recordRefs.map((ref) => {
      if (!ref.readable) {
        issues.push(`${ref.kind}/${ref.id} was already unreadable when the checkpoint was taken`);
        return { ref, state: 'UNREADABLE', currentHash: null };
      }
      const path = join(this.dataDir, ...ref.path.split('/'));
      const safe = containedPath(this.dataDir, path);
      if (safe === null) {
        issues.push(`${ref.kind}/${ref.id} points outside the workspace data directory`);
        return { ref, state: 'UNREADABLE', currentHash: null };
      }
      if (!fileExists(safe)) {
        issues.push(`${ref.kind}/${ref.id} is missing from disk`);
        return { ref, state: 'MISSING', currentHash: null };
      }
      const currentHash = sha256File(safe);
      if (currentHash === null) {
        issues.push(`${ref.kind}/${ref.id} could not be hashed`);
        return { ref, state: 'UNREADABLE', currentHash: null };
      }
      if (ref.hash !== null && currentHash !== ref.hash) {
        issues.push(`${ref.kind}/${ref.id} has changed since the checkpoint was taken`);
        return { ref, state: 'HASH_MISMATCH', currentHash };
      }
      return { ref, state: 'PRESENT', currentHash };
    });

    const streams: CheckpointStreamStatus[] = checkpoint.streamHeads.map((head) => {
      const state = this.streams.get(head.streamKey) ?? this.loadStream(head.streamKey);
      if (state.maxSequence < head.sequence) {
        issues.push(
          `stream ${head.streamKey} is now at sequence ${state.maxSequence}, below the checkpointed head ${head.sequence}`,
        );
        return {
          head,
          currentSequence: state.maxSequence,
          reachable: false,
          detail: 'the log no longer reaches the checkpointed head',
        };
      }
      const recorded = new Set(head.gaps.map((g) => `${g.from}-${g.to}`));
      const newGaps = this.detectGaps(head.streamKey).filter(
        (g) => g.from <= head.sequence && !recorded.has(`${g.from}-${g.to}`),
      );
      if (newGaps.length > 0) {
        issues.push(
          `stream ${head.streamKey} has ${newGaps.length} gap range(s) below the checkpointed head that were not present at checkpoint time`,
        );
        return {
          head,
          currentSequence: state.maxSequence,
          reachable: false,
          detail: `new gaps below the head: ${newGaps.map((g) => `${g.from}..${g.to}`).join(', ')}`,
        };
      }
      return { head, currentSequence: state.maxSequence, reachable: true, detail: 'replayable to the checkpointed head' };
    });

    const restorable = refs.every((r) => r.state === 'PRESENT') && streams.every((s) => s.reachable);
    return { ok: true, checkpoint, refs, streams, restorable, issues };
  }

  private streamsInScope(scope: CheckpointScope): readonly string[] {
    if (scope.kind === 'workspace') return this.listStreams();
    if (scope.kind === 'project') return this.listStreams().filter((key) => parseStreamKey(key)?.projectId === scope.id);
    if (scope.kind === 'run') return this.listStreams().filter((key) => parseStreamKey(key)?.runId === scope.id);
    // conversation: every stream of a run that belongs to it, plus its project stream.
    const runIds = new Set(
      this.listRecords('run').records.filter((r) => r.conversationId === scope.id).map((r) => r.id),
    );
    return this.listStreams().filter((key) => {
      const parsed = parseStreamKey(key);
      return parsed !== null && parsed.runId !== null && runIds.has(parsed.runId);
    });
  }

  private recordInScope(kind: RecordKind, record: unknown, scope: CheckpointScope): boolean {
    if (scope.kind === 'workspace') return true;
    const r = record as Record<string, unknown>;
    if (scope.kind === 'project') return r.projectId === scope.id;
    if (scope.kind === 'run') return r.runId === scope.id || (kind === 'run' && r.id === scope.id);
    return r.conversationId === scope.id || (kind === 'conversation' && r.id === scope.id);
  }

  /**
   * Scope membership for a record we could not read. We cannot know, so the
   * honest answer for a narrowed scope is "possibly" — it is included as an
   * unreadable ref, which is what makes the checkpoint incomplete.
   */
  private recordMightBeInScope(_kind: RecordKind, _id: string, _scope: CheckpointScope): boolean {
    return true;
  }

  private sizeOf(path: string): number | null {
    try {
      return statSync(path).size;
    } catch {
      return null;
    }
  }

  /* -------------------------------------------------------- degraded notes */

  /**
   * Record a loss of fidelity as a `bridge.degraded` event.
   *
   * The event id is derived from the reason and the detail, so the same damage
   * found on ten restarts produces one event, not ten — the append is idempotent
   * by construction rather than by a flag someone has to remember to set.
   */
  recordDegraded(note: DegradedNote): AppendEventResult {
    const eventId = `deg-${sha256(`${note.reason}|${note.detail}`).slice(0, 32)}`;
    const result = this.appendEvent({
      eventId,
      projectId: BRIDGE_PROJECT_ID,
      runId: null,
      source: 'bridge',
      type: 'bridge.degraded',
      status: 'DEGRADED',
      payload: { reason: note.reason, detail: note.detail },
      evidenceRefs: note.evidenceRefs,
    });
    // Recorded whether or not the append deduplicated: dedupe is about the log
    // not growing a second copy of the same event, not about this instance
    // pretending it never saw the damage on a restart.
    this.recordedDegraded.push(note);
    return result;
  }

  /** Queue a note. Written to the log by the next `flushDegradedNotes`. */
  private noteDegraded(note: DegradedNote): void {
    this.pendingDegraded.push(note);
  }

  /**
   * Persist every queued note. Returns how many were new.
   *
   * The iteration is bounded: writing a note can itself discover damage and
   * queue another, so an unbounded loop here would be a livelock waiting for a
   * bad disk. The bound is generous and stopping early leaves the remaining
   * notes queued rather than discarding them.
   */
  flushDegradedNotes(): number {
    let written = 0;
    let guard = 0;
    while (this.pendingDegraded.length > 0 && guard < 500) {
      guard += 1;
      const note = this.pendingDegraded.shift();
      if (note === undefined) break;
      if (!this.recordDegraded(note).deduplicated) written += 1;
    }
    return written;
  }

  /**
   * Every loss of fidelity this instance observed — those already written to
   * the log and those still queued. Empty means this instance found nothing,
   * which is not the same as a guarantee that nothing is wrong.
   */
  degradedNotes(): readonly DegradedNote[] {
    return [...this.recordedDegraded, ...this.pendingDegraded];
  }

  /* --------------------------------------------------------- reconciliation */

  /**
   * Crash recovery. Call this once, at startup, before serving any request.
   *
   * For every run persisted in a live status, exactly one of three things is
   * true, and each has one honest outcome:
   *
   *   no pid recorded            → ORPHANED. Nothing on the record could ever
   *                                prove the run was alive.
   *   pid is provably not alive  → INTERRUPTED. The process it named is gone,
   *                                and we know it did not report an exit.
   *   pid is alive, or liveness  → ORPHANED. A live pid from a previous bridge
   *   cannot be determined          instance is not proof it is the same
   *                                process (pids are reused), and no instance
   *                                owns it now.
   *
   * COMPLETED never appears in that table. A run that was interrupted did not
   * complete, and no amount of convenience makes that claim true.
   */
  reconcileOnStartup(): ReconciliationReport {
    this.assertOpen();
    if (!this.lockHeld) {
      throw new StoreLockError(
        'reconcileOnStartup rewrites run records and appends events, so it requires the workspace lock; ' +
          'this store was opened with acquireLock:false',
        null,
      );
    }
    const startedAt = this.now();
    const notes: string[] = [];

    const migrations = runMigrations(this.migrationIo(), undefined, this.now);
    for (const failure of migrations.failures) {
      this.pendingDegraded.push({
        reason: 'migration.failed',
        detail: `migration ${failure.id} failed: ${failure.detail}`,
        evidenceRefs: [{ kind: 'file', ref: 'meta/migrations.json' }],
      });
    }
    notes.push(...migrations.notes);

    const reconciled: RunReconciliation[] = [];
    const runsUnreadable: { id: string; detail: string }[] = [];
    let runsInspected = 0;

    for (const id of this.listRecordIds('run')) {
      const read = this.getRecord('run', id);
      if (!read.ok) {
        runsUnreadable.push({ id, detail: `${read.reason}: ${read.detail}` });
        this.pendingDegraded.push({
          reason: 'run.unreadable',
          detail: `run record ${id} could not be read during reconciliation (${read.reason}); its true state is UNKNOWN`,
          evidenceRefs: [{ kind: 'file', ref: this.relativeToDataDir(this.recordPath('run', id)) }],
        });
        continue;
      }
      runsInspected += 1;
      const run = read.record;
      if (!isLiveRunStatus(run.status)) continue;

      const pidAlive = run.pid === null ? null : isPidAlive(run.pid);
      let to: OperationalStatus;
      let reason: string;
      if (run.pid === null) {
        to = 'ORPHANED';
        reason = 'no process id was recorded, so the live status could never be verified';
      } else if (pidAlive === false) {
        to = 'INTERRUPTED';
        reason = `process ${run.pid} is not running and no exit was recorded, so the run was interrupted`;
      } else if (pidAlive === true) {
        to = 'ORPHANED';
        reason =
          `process ${run.pid} still exists but no bridge instance owns it ` +
          `(previous owner ${run.ownerBridgeInstanceId ?? 'unknown'}); process ids are reused, so this is not proof the run survived`;
      } else {
        to = 'ORPHANED';
        reason = `liveness of process ${run.pid} could not be determined, so the RUNNING claim cannot be defended`;
      }

      const endedAt = run.endedAt ?? this.now().toISOString();
      const evidenceRefs: readonly EvidenceRef[] = [
        {
          kind: 'file',
          ref: this.relativeToDataDir(this.recordPath('run', run.id)),
          note: `status ${run.status} at bridge start`,
        },
        {
          kind: 'exit-code',
          ref: run.exitCode === null ? 'none-recorded' : String(run.exitCode),
          note:
            run.exitCode === null
              ? 'no exit code was ever captured for this run'
              : 'exit code recorded before the bridge stopped',
        },
      ];

      const updated: RunRecord = {
        ...run,
        status: to,
        statusReason: reason,
        ownerBridgeInstanceId: null,
        endedAt,
        updatedAt: this.now().toISOString(),
        evidenceRefs: [...run.evidenceRefs, ...evidenceRefs],
      };
      this.saveRecord('run', updated);

      const stateEvent = this.appendEvent({
        projectId: run.projectId,
        runId: run.id,
        conversationId: run.conversationId,
        sessionId: run.sessionId,
        source: 'bridge',
        type: 'run.state',
        status: to,
        payload: { from: run.status, to, reason, pid: run.pid, pidAlive, reconciledBy: this.bridgeInstanceId },
        evidenceRefs,
      });

      reconciled.push({
        runId: run.id,
        projectId: run.projectId,
        from: run.status,
        to,
        reason,
        pid: run.pid,
        pidAlive,
        previousOwner: run.ownerBridgeInstanceId,
        evidenceRefs: [...evidenceRefs, { kind: 'event', ref: stateEvent.event.eventId }],
      });
    }

    const gaps: StreamGapReport[] = [];
    let eventsIndexed = 0;
    for (const streamKey of this.listStreams()) {
      const report = this.gapReport(streamKey);
      eventsIndexed += report.eventCount;
      if (report.gaps.length > 0) {
        gaps.push(report);
        this.pendingDegraded.push({
          reason: 'events.sequence-gap',
          detail:
            `event stream ${streamKey} is missing ${report.gaps.reduce((n, g) => n + g.count, 0)} sequence(s) ` +
            `(${report.gaps.map((g) => `${g.from}..${g.to}`).join(', ')}); any timeline built from it is incomplete`,
          evidenceRefs: [{ kind: 'file', ref: `events/${streamKey}.jsonl` }],
        });
      }
    }

    const degradedEventsRecorded = this.flushDegradedNotes();
    const finishedAt = this.now();

    const report: ReconciliationReport = {
      bridgeInstanceId: this.bridgeInstanceId,
      dataDir: this.dataDir,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      lockHeld: this.lockHeld,
      migrations,
      runsInspected,
      runsUnreadable,
      reconciled,
      streamsScanned: this.streams.size,
      eventsIndexed,
      gaps,
      corruption: this.degradedNotes(),
      degradedEventsRecorded,
      notes,
    };

    this.appendEvent({
      projectId: BRIDGE_PROJECT_ID,
      runId: null,
      source: 'bridge',
      type: 'bridge.reconciled',
      payload: report,
      evidenceRefs: reconciled.map((r) => ({
        kind: 'file' as const,
        ref: `records/run/${r.runId}.json`,
        note: `${r.from} -> ${r.to}`,
      })),
    });

    return report;
  }

  /* --------------------------------------------------------------- support */

  private migrationIo(): MigrationIo {
    const statePath = this.contained(join(this.dataDir, 'meta', 'migrations.json'), 'migration state');
    return {
      listRecordIds: (kind) => this.listRecordIds(kind),
      readEnvelope: (kind, id): ReadResult<RecordEnvelope> => readJsonSafe<RecordEnvelope>(this.recordPath(kind, id)),
      writeEnvelope: (envelope) => {
        writeJsonAtomic(this.recordPath(envelope.kind, envelope.id), envelope);
      },
      readState: (): ReadResult<MigrationState> => readJsonSafe<MigrationState>(statePath),
      writeState: (state) => {
        writeJsonAtomic(statePath, state);
      },
    };
  }

  stats(): StoreStats {
    let eventsPersisted = 0;
    for (const state of this.streams.values()) eventsPersisted += state.eventCount;
    return {
      dataDir: this.dataDir,
      bridgeInstanceId: this.bridgeInstanceId,
      layoutVersion: WORKSPACE_LAYOUT_VERSION,
      streams: this.streams.size,
      eventsPersisted,
      lastEventAt: this.lastEventAt,
      lockHeld: this.lockHeld,
      degradedNotes: this.recordedDegraded.length,
    };
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('the store has been closed; open a new one rather than reusing this instance');
  }
}

/** Convenience wrapper around `ForgeStore.open`, for symmetry with the bridge. */
export function openStore(options: StoreOptions = {}): ForgeStore {
  try {
    return ForgeStore.open(options);
  } catch (err) {
    if (err instanceof StoreLockError || err instanceof StorePathError) throw err;
    throw new Error(`could not open the Forge workspace store: ${errMessage(err)}`);
  }
}
