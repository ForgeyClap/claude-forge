/**
 * Forge Workspace — storage schema, runtime validation and migrations.
 *
 * `src/shared/protocol.ts` is the contract. This file is the part of it that
 * has to survive a restart: the on-disk envelope, the runtime validators that
 * refuse to persist a record the contract does not describe, and a migration
 * runner that is safe to run on every boot because running it twice changes
 * nothing.
 *
 * WHY RUNTIME VALIDATORS AT ALL. TypeScript types vanish at run time. A record
 * that arrives from a JSON file has been through no compiler, and a record the
 * bridge writes can be read back by a build compiled from different source. So
 * every record is checked structurally on the way in and on the way out, and an
 * event whose `type` is not in `EVENT_TYPES` is rejected outright — an unknown
 * event name is the cheapest way for a lie to enter a log that later gets
 * replayed as though it were history.
 *
 * WHY AN ENVELOPE. Contract records are stored untouched inside a wrapper that
 * carries `kind`, `id`, `schemaVersion` and `storedAt`. Migrations need a place
 * to record what version a file is at; that place must not be a field bolted
 * onto a contract type, or the contract and the disk format start to drift.
 *
 * The relative `.ts` import below is deliberate: Node 24 runs TypeScript
 * directly and requires the explicit extension, and bridge code is permitted
 * relative imports. The type-only import is erased before Node ever sees it.
 */

import { EVENT_TYPES, PROTOCOL_SCHEMA_VERSION, isSelfApproval } from '../../shared/protocol.ts';
import type {
  ApprovalRequest,
  AttachmentRecord,
  AttachmentState,
  ConversationRecord,
  EventSource,
  EvidenceRef,
  OperationalStatus,
  ProjectHealthState,
  ProjectRecord,
  ProofEntry,
  RiskLevel,
  SecurityVerdict,
  TestExecution,
  VerificationRecord,
  VerifyVerdict,
} from '../../shared/protocol.ts';
import type { ReadResult } from './atomic.ts';

/* ========================================================================== */
/*  Runtime enumerations, kept exhaustive by the compiler                      */
/* ========================================================================== */

/*
 * Each coverage object is typed `Record<Union, true>`, so adding a member to
 * the union in protocol.ts and forgetting it here is a build error rather than
 * a validator that silently stops recognising a legitimate value.
 */

const OPERATIONAL_STATUS_COVERAGE: Readonly<Record<OperationalStatus, true>> = {
  CREATED: true,
  QUEUED: true,
  STARTING: true,
  RUNNING: true,
  STREAMING: true,
  WAITING: true,
  WAITING_FOR_PERMISSION: true,
  VERIFYING: true,
  REVIEWING: true,
  REPAIRING: true,
  RETRYING: true,
  STOPPING: true,
  COMPLETED: true,
  FAILED: true,
  BLOCKED: true,
  CANCELLED: true,
  INTERRUPTED: true,
  DISCONNECTED: true,
  RECOVERING: true,
  RESUMABLE: true,
  ORPHANED: true,
  FAILED_RECOVERY: true,
  DEGRADED: true,
};

const EVENT_SOURCE_COVERAGE: Readonly<Record<EventSource, true>> = {
  forge: true,
  'claude-code': true,
  bridge: true,
  test: true,
  user: true,
};

const ATTACHMENT_STATE_COVERAGE: Readonly<Record<AttachmentState, true>> = {
  SELECTED: true,
  VALIDATING: true,
  HASHING: true,
  STAGING: true,
  INDEXING: true,
  READY: true,
  REJECTED: true,
  QUARANTINED: true,
  FAILED: true,
  REMOVED: true,
};

const SECURITY_VERDICT_COVERAGE: Readonly<Record<SecurityVerdict, true>> = {
  CLEAN: true,
  WARN: true,
  QUARANTINE: true,
  REJECT: true,
};

const RISK_LEVEL_COVERAGE: Readonly<Record<RiskLevel, true>> = {
  LOW: true,
  MEDIUM: true,
  HIGH: true,
  CRITICAL: true,
};

const VERIFY_VERDICT_COVERAGE: Readonly<Record<VerifyVerdict, true>> = {
  VERIFIED_PASS: true,
  VERIFIED_PASS_WITH_LIMITATIONS: true,
  REJECTED: true,
  BLOCKED: true,
  INSUFFICIENT_EVIDENCE: true,
  UNVERIFIED: true,
};

const PROJECT_HEALTH_COVERAGE: Readonly<Record<ProjectHealthState, true>> = {
  HEALTHY: true,
  DEGRADED: true,
  UNKNOWN: true,
  MISSING: true,
  ERROR: true,
};

const EVIDENCE_KIND_COVERAGE: Readonly<Record<EvidenceRef['kind'], true>> = {
  file: true,
  artifact: true,
  stdout: true,
  stderr: true,
  'exit-code': true,
  event: true,
  verdict: true,
};

export const OPERATIONAL_STATUSES = Object.keys(OPERATIONAL_STATUS_COVERAGE) as readonly OperationalStatus[];
export const EVENT_SOURCES = Object.keys(EVENT_SOURCE_COVERAGE) as readonly EventSource[];
export const ATTACHMENT_STATES = Object.keys(ATTACHMENT_STATE_COVERAGE) as readonly AttachmentState[];
export const SECURITY_VERDICTS = Object.keys(SECURITY_VERDICT_COVERAGE) as readonly SecurityVerdict[];
export const RISK_LEVELS = Object.keys(RISK_LEVEL_COVERAGE) as readonly RiskLevel[];
export const VERIFY_VERDICTS = Object.keys(VERIFY_VERDICT_COVERAGE) as readonly VerifyVerdict[];
export const PROJECT_HEALTH_STATES = Object.keys(PROJECT_HEALTH_COVERAGE) as readonly ProjectHealthState[];
export const EVIDENCE_KINDS = Object.keys(EVIDENCE_KIND_COVERAGE) as readonly EvidenceRef['kind'][];

/**
 * Statuses that assert a process is doing something right now. These are the
 * only ones `reconcileOnStartup` has to argue with: if the bridge died while a
 * run was in one of them, the claim is no longer supported by anything.
 */
export const LIVE_RUN_STATUSES: readonly OperationalStatus[] = [
  'STARTING',
  'RUNNING',
  'STREAMING',
  'WAITING',
  'WAITING_FOR_PERMISSION',
  'VERIFYING',
  'REVIEWING',
  'REPAIRING',
  'RETRYING',
  'STOPPING',
  'RECOVERING',
];

/** Statuses that mean the run is over. Reconciliation never produces COMPLETED. */
export const TERMINAL_RUN_STATUSES: readonly OperationalStatus[] = [
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'BLOCKED',
  'INTERRUPTED',
  'ORPHANED',
  'FAILED_RECOVERY',
];

export function isLiveRunStatus(status: OperationalStatus): boolean {
  return LIVE_RUN_STATUSES.includes(status);
}

export function isTerminalRunStatus(status: OperationalStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

/* ========================================================================== */
/*  Storage-owned record types                                                 */
/* ========================================================================== */

/*
 * protocol.ts defines ProjectRecord, ConversationRecord, AttachmentRecord,
 * ApprovalRequest, VerificationRecord, TestExecution and ProofEntry. It does
 * NOT define a run, an artifact or a checkpoint record. The three below are
 * therefore owned by the storage layer and marked as such.
 *
 * DRIFT RISK, STATED PLAINLY: if a later work package adds `RunRecord` or an
 * artifact record to protocol.ts, these must be reconciled with it rather than
 * left to diverge. They are built from contract primitives (OperationalStatus,
 * EvidenceRef) precisely so that reconciliation is mechanical.
 */

/**
 * A run as persisted. `pid` and `ownerBridgeInstanceId` exist for one reason:
 * after a crash they are the only evidence that can decide whether a RUNNING
 * claim is still true. A run in a live status with neither cannot be defended
 * and is rejected by the validator.
 */
export interface RunRecord {
  readonly id: string;
  readonly projectId: string;
  readonly conversationId: string | null;
  readonly sessionId: string | null;
  readonly goal: string;
  readonly status: OperationalStatus;
  /** Why the status is what it is. Free text, shown to a human, never parsed. */
  readonly statusReason: string;
  /** OS process id of the Claude Code child, when one was actually spawned. */
  readonly pid: number | null;
  /** Which bridge instance owns this run. Null once no instance claims it. */
  readonly ownerBridgeInstanceId: string | null;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly endedAt: string | null;
  readonly exitCode: number | null;
  /** Highest event sequence written for this run's stream. */
  readonly lastSequence: number;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface ArtifactRecord {
  readonly id: string;
  readonly projectId: string;
  readonly runId: string | null;
  readonly taskId: string | null;
  readonly kind: string;
  readonly name: string;
  readonly relativePath: string;
  readonly canonicalPath: string;
  readonly bytes: number | null;
  readonly hash: string | null;
  readonly mediaType: string | null;
  readonly producedBy: string | null;
  readonly createdAt: string;
  readonly indexedAt: string;
  /** Whether the file was on disk at index time. Re-checked, never assumed. */
  readonly present: boolean;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export type CheckpointScopeKind = 'workspace' | 'project' | 'conversation' | 'run';

export interface CheckpointScope {
  readonly kind: CheckpointScopeKind;
  /** Null only for the workspace scope. */
  readonly id: string | null;
}

export interface CheckpointStreamHead {
  readonly streamKey: string;
  readonly sequence: number;
  readonly eventCount: number;
  /** Gaps already present when the checkpoint was taken. Recorded, not hidden. */
  readonly gaps: readonly { readonly from: number; readonly to: number }[];
}

export interface CheckpointRecordRef {
  readonly kind: RecordKind;
  readonly id: string;
  /** Path relative to the workspace data directory. */
  readonly path: string;
  readonly schemaVersion: number;
  readonly hash: string | null;
  readonly bytes: number | null;
  readonly readable: boolean;
}

/**
 * A checkpoint is a set of references, not a copy. It records where every
 * stream's head was and what every record's bytes hashed to, so a later restore
 * can prove whether the material it is about to use is the same material —
 * instead of restoring silently changed files and calling it a restore.
 */
export interface CheckpointRecord {
  readonly id: string;
  readonly createdAt: string;
  readonly scope: CheckpointScope;
  readonly bridgeInstanceId: string;
  readonly streamHeads: readonly CheckpointStreamHead[];
  readonly recordRefs: readonly CheckpointRecordRef[];
  readonly recordCount: number;
  readonly note: string;
  /** False when any record in scope could not be read at checkpoint time. */
  readonly complete: boolean;
}

/* ========================================================================== */
/*  Record kinds, versions and the on-disk envelope                            */
/* ========================================================================== */

export const RECORD_KINDS = [
  'project',
  'conversation',
  'run',
  'attachment',
  'approval',
  'verification',
  'test',
  'proof',
  'artifact',
  'checkpoint',
] as const;

export type RecordKind = (typeof RECORD_KINDS)[number];

export interface RecordTypeMap {
  readonly project: ProjectRecord;
  readonly conversation: ConversationRecord;
  readonly run: RunRecord;
  readonly attachment: AttachmentRecord;
  readonly approval: ApprovalRequest;
  readonly verification: VerificationRecord;
  readonly test: TestExecution;
  readonly proof: ProofEntry;
  readonly artifact: ArtifactRecord;
  readonly checkpoint: CheckpointRecord;
}

export type RecordOf<K extends RecordKind> = RecordTypeMap[K];

/**
 * Current schema version per record kind. Bump one of these ONLY together with
 * a migration in `MIGRATIONS` that moves records from the old version to the
 * new one, or old files become unreadable with no path forward.
 */
export const RECORD_SCHEMA_VERSIONS: Readonly<Record<RecordKind, number>> = {
  project: 1,
  conversation: 1,
  run: 1,
  attachment: 1,
  approval: 1,
  verification: 1,
  test: 1,
  proof: 1,
  artifact: 1,
  checkpoint: 1,
};

/** Version stamped on every event line. Tracks the protocol's own version. */
export const EVENT_SCHEMA_VERSION = PROTOCOL_SCHEMA_VERSION;

/** Layout version of `.forge-workspace/` itself (directory names, file naming). */
export const WORKSPACE_LAYOUT_VERSION = 1;

/** What a record file actually contains. The contract record is left untouched. */
export interface RecordEnvelope<T = unknown> {
  readonly kind: RecordKind;
  readonly id: string;
  readonly schemaVersion: number;
  readonly storedAt: string;
  readonly record: T;
}

export function isRecordKind(value: unknown): value is RecordKind {
  return typeof value === 'string' && (RECORD_KINDS as readonly string[]).includes(value);
}

/* ========================================================================== */
/*  Validation                                                                 */
/* ========================================================================== */

export interface ValidationIssue {
  /** Dotted path to the offending field, e.g. `git.branch`. */
  readonly field: string;
  readonly expected: string;
  readonly detail: string;
}

export type ValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

type Check = (value: unknown) => boolean;

interface FieldSpec {
  readonly check: Check;
  readonly expected: string;
  /** Absent fields are an error unless this is set. */
  readonly optional?: boolean;
}

type RecordSpec = Readonly<Record<string, FieldSpec>>;

const isString: Check = (v) => typeof v === 'string';
const isNonEmptyString: Check = (v) => typeof v === 'string' && v.trim().length > 0;
const isBoolean: Check = (v) => typeof v === 'boolean';
const isFiniteNumber: Check = (v) => typeof v === 'number' && Number.isFinite(v);
const isInteger: Check = (v) => typeof v === 'number' && Number.isInteger(v);
const isNonNegativeInteger: Check = (v) => isInteger(v) && (v as number) >= 0;

function nullable(check: Check): Check {
  return (v) => v === null || check(v);
}

function isIsoTimestamp(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

function isArrayOf(check: Check): Check {
  return (v) => Array.isArray(v) && v.every((item) => check(item));
}

function oneOf<T extends string>(values: readonly T[]): Check {
  return (v) => typeof v === 'string' && (values as readonly string[]).includes(v);
}

const isEvidenceRef: Check = (v) => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const ref = v as Record<string, unknown>;
  if (!oneOf(EVIDENCE_KINDS)(ref.kind)) return false;
  if (!isNonEmptyString(ref.ref)) return false;
  if (ref.hash !== undefined && typeof ref.hash !== 'string') return false;
  if (ref.note !== undefined && typeof ref.note !== 'string') return false;
  return true;
};

const isEvidenceRefArray = isArrayOf(isEvidenceRef);
const isStringArray = isArrayOf(isString);

const isGitState: Check = (v) => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const g = v as Record<string, unknown>;
  return (
    isBoolean(g.initialized) &&
    nullable(isString)(g.branch) &&
    isNonNegativeInteger(g.dirtyFiles) &&
    nullable(isString)(g.lastCommit) &&
    isBoolean(g.hasRemote)
  );
};

const isTestCounts: Check = (v) => {
  if (v === null) return true;
  if (typeof v !== 'object' || Array.isArray(v)) return false;
  const c = v as Record<string, unknown>;
  return isNonNegativeInteger(c.passed) && isNonNegativeInteger(c.failed) && isNonNegativeInteger(c.skipped);
};

const isCheckpointScope: Check = (v) => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const s = v as Record<string, unknown>;
  if (!oneOf<CheckpointScopeKind>(['workspace', 'project', 'conversation', 'run'])(s.kind)) return false;
  if (s.kind === 'workspace') return s.id === null;
  return isNonEmptyString(s.id);
};

const isStreamHead: Check = (v) => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const h = v as Record<string, unknown>;
  return (
    isNonEmptyString(h.streamKey) &&
    isNonNegativeInteger(h.sequence) &&
    isNonNegativeInteger(h.eventCount) &&
    Array.isArray(h.gaps)
  );
};

const isCheckpointRecordRef: Check = (v) => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return (
    isRecordKind(r.kind) &&
    isNonEmptyString(r.id) &&
    isNonEmptyString(r.path) &&
    isNonNegativeInteger(r.schemaVersion) &&
    nullable(isString)(r.hash) &&
    nullable(isNonNegativeInteger)(r.bytes) &&
    isBoolean(r.readable)
  );
};

const PROJECT_SPEC: RecordSpec = {
  id: { check: isNonEmptyString, expected: 'non-empty string' },
  displayName: { check: isNonEmptyString, expected: 'non-empty string' },
  slug: { check: isNonEmptyString, expected: 'non-empty string' },
  canonicalPath: { check: isNonEmptyString, expected: 'non-empty string' },
  relativePath: { check: isString, expected: 'string' },
  type: { check: isString, expected: 'string' },
  description: { check: isString, expected: 'string' },
  createdAt: { check: isIsoTimestamp, expected: 'ISO-8601 timestamp' },
  updatedAt: { check: isIsoTimestamp, expected: 'ISO-8601 timestamp' },
  forgeVersion: { check: nullable(isString), expected: 'string or null' },
  templateVersion: { check: nullable(isString), expected: 'string or null' },
  git: { check: isGitState, expected: 'GitState object' },
  sessionIds: { check: isStringArray, expected: 'string[]' },
  conversationIds: { check: isStringArray, expected: 'string[]' },
  activeRunIds: { check: isStringArray, expected: 'string[]' },
  archived: { check: isBoolean, expected: 'boolean' },
  health: { check: oneOf(PROJECT_HEALTH_STATES), expected: PROJECT_HEALTH_STATES.join(' | ') },
  lastDoctorResult: { check: nullable(isString), expected: 'string or null' },
  metadataSchemaVersion: { check: isNonNegativeInteger, expected: 'non-negative integer' },
};

const CONVERSATION_SPEC: RecordSpec = {
  id: { check: isNonEmptyString, expected: 'non-empty string' },
  projectId: { check: isNonEmptyString, expected: 'non-empty string' },
  title: { check: isString, expected: 'string' },
  claudeSessionId: { check: nullable(isString), expected: 'string or null' },
  createdAt: { check: isIsoTimestamp, expected: 'ISO-8601 timestamp' },
  updatedAt: { check: isIsoTimestamp, expected: 'ISO-8601 timestamp' },
  messageCount: { check: isNonNegativeInteger, expected: 'non-negative integer' },
  attachmentIds: { check: isStringArray, expected: 'string[]' },
  activeRunId: { check: nullable(isString), expected: 'string or null' },
  archived: { check: isBoolean, expected: 'boolean' },
  lastConfirmedSequence: { check: isNonNegativeInteger, expected: 'non-negative integer' },
};

const RUN_SPEC: RecordSpec = {
  id: { check: isNonEmptyString, expected: 'non-empty string' },
  projectId: { check: isNonEmptyString, expected: 'non-empty string' },
  conversationId: { check: nullable(isString), expected: 'string or null' },
  sessionId: { check: nullable(isString), expected: 'string or null' },
  goal: { check: isString, expected: 'string' },
  status: { check: oneOf(OPERATIONAL_STATUSES), expected: 'OperationalStatus' },
  statusReason: { check: isString, expected: 'string' },
  pid: { check: nullable(isInteger), expected: 'integer or null' },
  ownerBridgeInstanceId: { check: nullable(isString), expected: 'string or null' },
  startedAt: { check: isIsoTimestamp, expected: 'ISO-8601 timestamp' },
  updatedAt: { check: isIsoTimestamp, expected: 'ISO-8601 timestamp' },
  endedAt: { check: nullable(isIsoTimestamp), expected: 'ISO-8601 timestamp or null' },
  exitCode: { check: nullable(isInteger), expected: 'integer or null' },
  lastSequence: { check: isNonNegativeInteger, expected: 'non-negative integer' },
  evidenceRefs: { check: isEvidenceRefArray, expected: 'EvidenceRef[]' },
};

const ATTACHMENT_SPEC: RecordSpec = {
  id: { check: isNonEmptyString, expected: 'non-empty string' },
  projectId: { check: isNonEmptyString, expected: 'non-empty string' },
  conversationId: { check: isNonEmptyString, expected: 'non-empty string' },
  originalFilename: { check: isNonEmptyString, expected: 'non-empty string' },
  storedFilename: { check: isNonEmptyString, expected: 'non-empty string' },
  canonicalPath: { check: isNonEmptyString, expected: 'non-empty string' },
  declaredMediaType: { check: isString, expected: 'string' },
  detectedMediaType: { check: nullable(isString), expected: 'string or null' },
  size: { check: isNonNegativeInteger, expected: 'non-negative integer' },
  hash: { check: nullable(isString), expected: 'string or null' },
  createdAt: { check: isIsoTimestamp, expected: 'ISO-8601 timestamp' },
  uploaderSource: {
    check: oneOf(['picker', 'drag-drop', 'clipboard', 'project-file']),
    expected: 'picker | drag-drop | clipboard | project-file',
  },
  previewAvailable: { check: isBoolean, expected: 'boolean' },
  state: { check: oneOf(ATTACHMENT_STATES), expected: ATTACHMENT_STATES.join(' | ') },
  security: { check: oneOf(SECURITY_VERDICTS), expected: SECURITY_VERDICTS.join(' | ') },
  securityNotes: { check: isStringArray, expected: 'string[]' },
  claudeAccessible: { check: isBoolean, expected: 'boolean' },
  deleted: { check: isBoolean, expected: 'boolean' },
};

const APPROVAL_SPEC: RecordSpec = {
  id: { check: isNonEmptyString, expected: 'non-empty string' },
  projectId: { check: isNonEmptyString, expected: 'non-empty string' },
  runId: { check: nullable(isString), expected: 'string or null' },
  requestedBy: { check: isNonEmptyString, expected: 'non-empty string' },
  action: { check: isNonEmptyString, expected: 'non-empty string' },
  operation: { check: isNonEmptyString, expected: 'non-empty string' },
  affects: { check: isStringArray, expected: 'string[]' },
  risk: { check: oneOf(RISK_LEVELS), expected: RISK_LEVELS.join(' | ') },
  reason: { check: isString, expected: 'string' },
  rollbackPlan: { check: isString, expected: 'string' },
  requestedAt: { check: isIsoTimestamp, expected: 'ISO-8601 timestamp' },
  expiresAt: { check: isIsoTimestamp, expected: 'ISO-8601 timestamp' },
  state: { check: oneOf(['PENDING', 'APPROVED', 'DENIED', 'EXPIRED']), expected: 'PENDING | APPROVED | DENIED | EXPIRED' },
  resolvedAt: { check: nullable(isIsoTimestamp), expected: 'ISO-8601 timestamp or null' },
};

const VERIFICATION_SPEC: RecordSpec = {
  id: { check: isNonEmptyString, expected: 'non-empty string' },
  taskId: { check: isNonEmptyString, expected: 'non-empty string' },
  runId: { check: isNonEmptyString, expected: 'non-empty string' },
  verifierAgentId: { check: isNonEmptyString, expected: 'non-empty string' },
  subjectAgentId: { check: isNonEmptyString, expected: 'non-empty string' },
  startedAt: { check: isIsoTimestamp, expected: 'ISO-8601 timestamp' },
  resolvedAt: { check: nullable(isIsoTimestamp), expected: 'ISO-8601 timestamp or null' },
  verdict: { check: oneOf(VERIFY_VERDICTS), expected: VERIFY_VERDICTS.join(' | ') },
  reason: { check: isString, expected: 'string' },
  evidenceRefs: { check: isEvidenceRefArray, expected: 'EvidenceRef[]' },
};

const TEST_SPEC: RecordSpec = {
  id: { check: isNonEmptyString, expected: 'non-empty string' },
  projectId: { check: isNonEmptyString, expected: 'non-empty string' },
  runId: { check: nullable(isString), expected: 'string or null' },
  gate: { check: isNonEmptyString, expected: 'non-empty string' },
  command: { check: isNonEmptyString, expected: 'non-empty string' },
  args: { check: isStringArray, expected: 'string[]' },
  cwd: { check: isNonEmptyString, expected: 'non-empty string' },
  startedAt: { check: isIsoTimestamp, expected: 'ISO-8601 timestamp' },
  endedAt: { check: nullable(isIsoTimestamp), expected: 'ISO-8601 timestamp or null' },
  durationMs: { check: nullable(isFiniteNumber), expected: 'number or null' },
  exitCode: { check: nullable(isInteger), expected: 'integer or null' },
  stdoutRef: { check: nullable(isString), expected: 'string or null' },
  stderrRef: { check: nullable(isString), expected: 'string or null' },
  counts: { check: isTestCounts, expected: '{passed,failed,skipped} or null' },
  status: { check: oneOf(OPERATIONAL_STATUSES), expected: 'OperationalStatus' },
  evidenceRefs: { check: isEvidenceRefArray, expected: 'EvidenceRef[]' },
};

const PROOF_SPEC: RecordSpec = {
  id: { check: isNonEmptyString, expected: 'non-empty string' },
  projectId: { check: isNonEmptyString, expected: 'non-empty string' },
  runId: { check: nullable(isString), expected: 'string or null' },
  taskId: { check: nullable(isString), expected: 'string or null' },
  timestamp: { check: isIsoTimestamp, expected: 'ISO-8601 timestamp' },
  claim: { check: isNonEmptyString, expected: 'non-empty string' },
  agentId: { check: nullable(isString), expected: 'string or null' },
  command: { check: nullable(isString), expected: 'string or null' },
  verdict: { check: oneOf(['accepted', 'rejected', 'pending']), expected: 'accepted | rejected | pending' },
  reason: { check: isString, expected: 'string' },
  evidenceRefs: { check: isEvidenceRefArray, expected: 'EvidenceRef[]' },
};

const ARTIFACT_SPEC: RecordSpec = {
  id: { check: isNonEmptyString, expected: 'non-empty string' },
  projectId: { check: isNonEmptyString, expected: 'non-empty string' },
  runId: { check: nullable(isString), expected: 'string or null' },
  taskId: { check: nullable(isString), expected: 'string or null' },
  kind: { check: isNonEmptyString, expected: 'non-empty string' },
  name: { check: isNonEmptyString, expected: 'non-empty string' },
  relativePath: { check: isNonEmptyString, expected: 'non-empty string' },
  canonicalPath: { check: isNonEmptyString, expected: 'non-empty string' },
  bytes: { check: nullable(isNonNegativeInteger), expected: 'non-negative integer or null' },
  hash: { check: nullable(isString), expected: 'string or null' },
  mediaType: { check: nullable(isString), expected: 'string or null' },
  producedBy: { check: nullable(isString), expected: 'string or null' },
  createdAt: { check: isIsoTimestamp, expected: 'ISO-8601 timestamp' },
  indexedAt: { check: isIsoTimestamp, expected: 'ISO-8601 timestamp' },
  present: { check: isBoolean, expected: 'boolean' },
  evidenceRefs: { check: isEvidenceRefArray, expected: 'EvidenceRef[]' },
};

const CHECKPOINT_SPEC: RecordSpec = {
  id: { check: isNonEmptyString, expected: 'non-empty string' },
  createdAt: { check: isIsoTimestamp, expected: 'ISO-8601 timestamp' },
  scope: { check: isCheckpointScope, expected: 'CheckpointScope object' },
  bridgeInstanceId: { check: isNonEmptyString, expected: 'non-empty string' },
  streamHeads: { check: isArrayOf(isStreamHead), expected: 'CheckpointStreamHead[]' },
  recordRefs: { check: isArrayOf(isCheckpointRecordRef), expected: 'CheckpointRecordRef[]' },
  recordCount: { check: isNonNegativeInteger, expected: 'non-negative integer' },
  note: { check: isString, expected: 'string' },
  complete: { check: isBoolean, expected: 'boolean' },
};

const RECORD_SPECS: Readonly<Record<RecordKind, RecordSpec>> = {
  project: PROJECT_SPEC,
  conversation: CONVERSATION_SPEC,
  run: RUN_SPEC,
  attachment: ATTACHMENT_SPEC,
  approval: APPROVAL_SPEC,
  verification: VERIFICATION_SPEC,
  test: TEST_SPEC,
  proof: PROOF_SPEC,
  artifact: ARTIFACT_SPEC,
  checkpoint: CHECKPOINT_SPEC,
};

/*
 * Rules that structure alone cannot express. Each one exists because the
 * alternative is a record that is well-formed and dishonest.
 */
type SemanticRule = (record: Record<string, unknown>) => readonly ValidationIssue[];

const SEMANTIC_RULES: Partial<Readonly<Record<RecordKind, SemanticRule>>> = {
  run: (r) => {
    const issues: ValidationIssue[] = [];
    const status = r.status as OperationalStatus;
    if (isLiveRunStatus(status) && r.pid === null && r.ownerBridgeInstanceId === null) {
      issues.push({
        field: 'status',
        expected: 'a live status backed by a pid or an owning bridge instance',
        detail: `status ${status} claims the run is active but nothing on this record could ever prove it`,
      });
    }
    if (isTerminalRunStatus(status) && r.endedAt === null) {
      issues.push({
        field: 'endedAt',
        expected: 'ISO-8601 timestamp when the status is terminal',
        detail: `status ${status} says the run is over but no end time was recorded`,
      });
    }
    if (status === 'COMPLETED' && r.exitCode !== 0) {
      issues.push({
        field: 'exitCode',
        expected: 'exit code 0 for COMPLETED',
        detail: `COMPLETED requires a zero exit code; got ${JSON.stringify(r.exitCode)}`,
      });
    }
    return issues;
  },
  test: (r) => {
    const issues: ValidationIssue[] = [];
    const status = r.status as OperationalStatus;
    if ((status === 'COMPLETED' || status === 'FAILED') && r.exitCode === null) {
      issues.push({
        field: 'exitCode',
        expected: 'an integer exit code once the execution has finished',
        detail: `status ${status} claims the execution finished, but no exit code was captured`,
      });
    }
    if (status === 'COMPLETED' && r.endedAt === null) {
      issues.push({
        field: 'endedAt',
        expected: 'ISO-8601 timestamp for a finished execution',
        detail: 'COMPLETED without an end time is not a finished execution',
      });
    }
    return issues;
  },
  verification: (r) => {
    const record = r as unknown as VerificationRecord;
    if (!isSelfApproval(record)) return [];
    const passing = record.verdict === 'VERIFIED_PASS' || record.verdict === 'VERIFIED_PASS_WITH_LIMITATIONS';
    if (!passing) return [];
    return [
      {
        field: 'verifierAgentId',
        expected: 'a verifier different from the subject',
        detail: `agent ${record.verifierAgentId} passed its own work; self-approval is never a verification`,
      },
    ];
  },
};

/**
 * Validate a record against the contract shape for its kind.
 *
 * Unknown extra properties are allowed (a newer writer may add a field), but
 * every field the contract declares must be present and correctly typed, and
 * the semantic rules above must hold.
 */
export function validateRecord(kind: RecordKind, value: unknown): ValidationResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      ok: false,
      issues: [{ field: '<root>', expected: 'object', detail: `got ${Array.isArray(value) ? 'array' : typeof value}` }],
    };
  }
  const record = value as Record<string, unknown>;
  const spec = RECORD_SPECS[kind];
  const issues: ValidationIssue[] = [];

  for (const [field, fieldSpec] of Object.entries(spec)) {
    const present = Object.prototype.hasOwnProperty.call(record, field);
    if (!present) {
      if (fieldSpec.optional) continue;
      issues.push({ field, expected: fieldSpec.expected, detail: 'field is missing' });
      continue;
    }
    if (!fieldSpec.check(record[field])) {
      issues.push({
        field,
        expected: fieldSpec.expected,
        detail: `got ${JSON.stringify(record[field])?.slice(0, 120) ?? typeof record[field]}`,
      });
    }
  }

  if (issues.length === 0) {
    const rule = SEMANTIC_RULES[kind];
    if (rule) issues.push(...rule(record));
  }

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

/**
 * Validate an event envelope.
 *
 * The `type` check is the honesty gate: an event whose name is not in
 * `EVENT_TYPES` cannot be persisted, so no subsystem can invent a story by
 * inventing a vocabulary for it. `sequence` is checked but assigned by the
 * store, never by a caller.
 */
export function validateEvent(value: unknown): ValidationResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      ok: false,
      issues: [{ field: '<root>', expected: 'object', detail: `got ${Array.isArray(value) ? 'array' : typeof value}` }],
    };
  }
  const e = value as Record<string, unknown>;
  const issues: ValidationIssue[] = [];

  const require = (field: string, check: Check, expected: string): void => {
    if (!check(e[field])) {
      issues.push({ field, expected, detail: `got ${JSON.stringify(e[field])?.slice(0, 120) ?? typeof e[field]}` });
    }
  };

  require('eventId', isNonEmptyString, 'non-empty string');
  require('schemaVersion', isNonNegativeInteger, 'non-negative integer');
  require('sequence', isNonNegativeInteger, 'non-negative integer');
  require('timestamp', isIsoTimestamp, 'ISO-8601 timestamp');
  require('projectId', isNonEmptyString, 'non-empty string');
  require('runId', nullable(isString), 'string or null');
  require('sessionId', nullable(isString), 'string or null');
  require('conversationId', nullable(isString), 'string or null');
  require('taskId', nullable(isString), 'string or null');
  require('agentId', nullable(isString), 'string or null');
  require('source', oneOf(EVENT_SOURCES), EVENT_SOURCES.join(' | '));
  require('evidenceRefs', isEvidenceRefArray, 'EvidenceRef[]');

  if (!oneOf(EVENT_TYPES)(e.type)) {
    issues.push({
      field: 'type',
      expected: 'one of EVENT_TYPES in src/shared/protocol.ts',
      detail: `unknown event type ${JSON.stringify(e.type)}; unknown events are rejected, not stored`,
    });
  }

  if (e.status !== undefined && !oneOf(OPERATIONAL_STATUSES)(e.status)) {
    issues.push({ field: 'status', expected: 'OperationalStatus', detail: `got ${JSON.stringify(e.status)}` });
  }
  if (!Object.prototype.hasOwnProperty.call(e, 'payload')) {
    issues.push({ field: 'payload', expected: 'any JSON value (may be null)', detail: 'field is missing' });
  }
  if (e.ingestedAt !== undefined && !isFiniteNumber(e.ingestedAt)) {
    issues.push({ field: 'ingestedAt', expected: 'number or absent', detail: `got ${typeof e.ingestedAt}` });
  }

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

/** One-line rendering of a failed validation, safe to put in an error message. */
export function describeIssues(issues: readonly ValidationIssue[]): string {
  return issues.map((i) => `${i.field}: expected ${i.expected} — ${i.detail}`).join('; ');
}

/* ========================================================================== */
/*  Migrations                                                                 */
/* ========================================================================== */

export interface Migration {
  /** Stable, unique, never reused. This id is what makes reruns a no-op. */
  readonly id: string;
  readonly kind: RecordKind;
  readonly from: number;
  readonly to: number;
  readonly description: string;
  /** Pure transform of one record body. Must not touch the file system. */
  readonly migrate: (record: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * The migration list. Empty at layout version 1 — there is nothing to move yet.
 * The runner around it is not empty, and is exercised by tests with synthetic
 * migrations, so the first real one does not run untested machinery.
 *
 * Order matters: migrations for a kind are applied in array order, and each
 * one's `from` must equal the previous one's `to`.
 */
export const MIGRATIONS: readonly Migration[] = [];

export interface AppliedMigration {
  readonly id: string;
  readonly kind: RecordKind;
  readonly from: number;
  readonly to: number;
  readonly appliedAt: string;
  readonly recordsChanged: number;
  readonly recordsSkipped: number;
  readonly recordsUnreadable: number;
}

export interface MigrationState {
  readonly stateVersion: number;
  readonly layoutVersion: number;
  /** Current version per kind, as recorded after the last successful run. */
  readonly schemaVersions: Readonly<Record<string, number>>;
  readonly applied: readonly AppliedMigration[];
  readonly updatedAt: string;
}

export interface MigrationRunReport {
  readonly ranAt: string;
  readonly stateWasMissing: boolean;
  /** Ids skipped because they were already recorded. Proof of idempotency. */
  readonly alreadyApplied: readonly string[];
  readonly applied: readonly AppliedMigration[];
  readonly failures: readonly { readonly id: string; readonly detail: string }[];
  readonly schemaVersions: Readonly<Record<string, number>>;
  readonly notes: readonly string[];
}

/** The file-system operations the runner needs. Injected so it stays testable. */
export interface MigrationIo {
  listRecordIds(kind: RecordKind): readonly string[];
  readEnvelope(kind: RecordKind, id: string): ReadResult<RecordEnvelope>;
  writeEnvelope(envelope: RecordEnvelope): void;
  readState(): ReadResult<MigrationState>;
  writeState(state: MigrationState): void;
}

export function emptyMigrationState(now: Date): MigrationState {
  return {
    stateVersion: 1,
    layoutVersion: WORKSPACE_LAYOUT_VERSION,
    schemaVersions: {},
    applied: [],
    updatedAt: now.toISOString(),
  };
}

/**
 * Apply every pending migration, once.
 *
 * IDEMPOTENCE, CONCRETELY: a migration is skipped when its id already appears
 * in the recorded state, and a record is skipped when its stored schemaVersion
 * is not the migration's `from`. So the second run reports every id under
 * `alreadyApplied`, writes no record, and leaves the state's `applied` list
 * exactly as it was.
 *
 * A record that cannot be read is counted and left alone. Migrations do not get
 * to destroy evidence they could not parse.
 */
export function runMigrations(
  io: MigrationIo,
  migrations: readonly Migration[] = MIGRATIONS,
  now: () => Date = () => new Date(),
): MigrationRunReport {
  const ranAt = now();
  const stateRead = io.readState();
  const stateWasMissing = !stateRead.ok;
  const state: MigrationState = stateRead.ok ? stateRead.value : emptyMigrationState(ranAt);

  const notes: string[] = [];
  if (!stateRead.ok && stateRead.reason !== 'MISSING') {
    notes.push(
      `migration state was present but unusable (${stateRead.reason}: ${stateRead.detail}); ` +
        'starting from an empty state and re-checking every record',
    );
  }

  const appliedIds = new Set(state.applied.map((entry) => entry.id));
  const alreadyApplied: string[] = [];
  const newlyApplied: AppliedMigration[] = [];
  const failures: { id: string; detail: string }[] = [];

  for (const migration of migrations) {
    if (appliedIds.has(migration.id)) {
      alreadyApplied.push(migration.id);
      continue;
    }
    let changed = 0;
    let skipped = 0;
    let unreadable = 0;
    let failed = false;

    for (const id of io.listRecordIds(migration.kind)) {
      const envelopeRead = io.readEnvelope(migration.kind, id);
      if (!envelopeRead.ok) {
        unreadable += 1;
        continue;
      }
      const envelope = envelopeRead.value;
      if (envelope.schemaVersion !== migration.from) {
        skipped += 1;
        continue;
      }
      try {
        const migrated = migration.migrate(envelope.record as Record<string, unknown>);
        io.writeEnvelope({
          kind: migration.kind,
          id: envelope.id,
          schemaVersion: migration.to,
          storedAt: now().toISOString(),
          record: migrated,
        });
        changed += 1;
      } catch (err) {
        failed = true;
        failures.push({
          id: migration.id,
          detail: `record ${id}: ${err instanceof Error ? err.message : String(err)}`,
        });
        break;
      }
    }

    if (failed) continue;

    newlyApplied.push({
      id: migration.id,
      kind: migration.kind,
      from: migration.from,
      to: migration.to,
      appliedAt: now().toISOString(),
      recordsChanged: changed,
      recordsSkipped: skipped,
      recordsUnreadable: unreadable,
    });
    appliedIds.add(migration.id);
  }

  const schemaVersions: Record<string, number> = { ...state.schemaVersions };
  // A kind's recorded version only advances when nothing for it failed.
  const failedKinds = new Set(
    failures
      .map((f) => migrations.find((m) => m.id === f.id)?.kind)
      .filter((kind): kind is RecordKind => kind !== undefined),
  );
  for (const kind of RECORD_KINDS) {
    if (failedKinds.has(kind)) continue;
    schemaVersions[kind] = RECORD_SCHEMA_VERSIONS[kind];
  }

  const nextState: MigrationState = {
    stateVersion: 1,
    layoutVersion: WORKSPACE_LAYOUT_VERSION,
    schemaVersions,
    applied: [...state.applied, ...newlyApplied],
    updatedAt: ranAt.toISOString(),
  };
  io.writeState(nextState);

  return {
    ranAt: ranAt.toISOString(),
    stateWasMissing,
    alreadyApplied,
    applied: newlyApplied,
    failures,
    schemaVersions,
    notes,
  };
}

export type EnvelopeMigrationResult =
  | { readonly ok: true; readonly envelope: RecordEnvelope; readonly applied: readonly string[] }
  | { readonly ok: false; readonly detail: string; readonly applied: readonly string[] };

/**
 * Lazily bring a single envelope up to the current version on read.
 *
 * Also idempotent: an envelope already at the current version returns unchanged
 * with an empty `applied` list. An envelope from the FUTURE (a version this
 * build does not know) is refused rather than downgraded — silently reading a
 * newer record with older rules is how data gets quietly mangled.
 */
export function migrateEnvelope(
  envelope: RecordEnvelope,
  migrations: readonly Migration[] = MIGRATIONS,
  now: () => Date = () => new Date(),
): EnvelopeMigrationResult {
  const target = RECORD_SCHEMA_VERSIONS[envelope.kind];
  if (envelope.schemaVersion > target) {
    return {
      ok: false,
      detail: `record ${envelope.kind}/${envelope.id} is at schema version ${envelope.schemaVersion}, newer than this build understands (${target})`,
      applied: [],
    };
  }
  if (envelope.schemaVersion === target) return { ok: true, envelope, applied: [] };

  const applied: string[] = [];
  let current = envelope;
  for (const migration of migrations) {
    if (migration.kind !== envelope.kind) continue;
    if (migration.from !== current.schemaVersion) continue;
    try {
      current = {
        kind: current.kind,
        id: current.id,
        schemaVersion: migration.to,
        storedAt: now().toISOString(),
        record: migration.migrate(current.record as Record<string, unknown>),
      };
      applied.push(migration.id);
    } catch (err) {
      return {
        ok: false,
        detail: `migration ${migration.id} failed on ${envelope.kind}/${envelope.id}: ${err instanceof Error ? err.message : String(err)}`,
        applied,
      };
    }
  }

  if (current.schemaVersion !== target) {
    return {
      ok: false,
      detail: `no migration path from schema version ${envelope.schemaVersion} to ${target} for kind ${envelope.kind}`,
      applied,
    };
  }
  return { ok: true, envelope: current, applied };
}
