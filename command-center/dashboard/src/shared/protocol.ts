/**
 * Forge Workspace — the bridge protocol.
 *
 * This file is the contract between the browser and the local bridge. It is
 * imported by BOTH sides, so a change here is a change to both at once — which
 * is the point: the two can never drift.
 *
 * Three rules shape everything below.
 *
 * 1. THE BROWSER NEVER NAMES A COMMAND. Every operation is a typed, allowlisted
 *    verb with a validated payload. There is deliberately no `exec`, no `run`,
 *    no `command: string`. If a capability is not in `OperationName`, the bridge
 *    cannot be asked to do it.
 *
 * 2. A STATUS IS A CLAIM ABOUT REALITY. Statuses are not decoration. Each one
 *    carries the evidence that justifies it (see `StatusEvidence`), and the
 *    state machines refuse transitions that would let a status appear without
 *    that evidence. A screen may only render what the bridge could prove.
 *
 * 3. USAGE IS LABELLED BY ORIGIN. Every number the usage bar shows knows where
 *    it came from and how much it can be trusted (`Accuracy`). A value we
 *    estimated locally is never displayed as though Claude Code reported it.
 */

/* ========================================================================== */
/*  Runtime declarations — mechanically verified, not asserted in prose        */
/* ========================================================================== */

/*
 * A declaration is a claim about reality, so it obeys the same rule as a status:
 * it may not be true without evidence. That splits the declarations in two, and
 * the split is the entire design.
 *
 * INVARIANT — properties of the BUILD. They cannot vary while the process runs
 *   because nothing at runtime can change them: there is no code path that reads
 *   an API key, no vendor transport, no environment variable that moves the bind
 *   address. Those are provable by reading the source, so they stay constants —
 *   and every one of them names the test that proves it, in
 *   `INVARIANT_DECLARATION_PROOFS`. A constant with no proof is just an opinion.
 *
 * DERIVED — claims about the LIVE system: whether Claude Code answered a probe,
 *   whether the registry is loaded, whether any real process has run. None of
 *   those can be known by reading the source, so none of them is written down
 *   here. They are COMPUTED, every time health is assembled, by
 *   `deriveDeclarations` in `src/shared/declarations.ts`, and each one carries
 *   the evidence that justified it and the moment it was checked.
 *
 * WHAT WAS HERE BEFORE, AND WHY IT IS GONE. This block used to export a flat
 * object containing `CONNECTED_TO_CLAUDE_CODE: true` and `USES_REAL_AGENTS:
 * true` as hardcoded constants. The bridge published them on /api/health while
 * the same response said `claudeCode.available: false` and "no Claude Code probe
 * is registered; its status is UNVERIFIED". That is precisely the fake status
 * this system exists to prevent, sitting in the contract file itself. A claim
 * about a running system cannot be a compile-time constant.
 */

/**
 * Properties of this build. Provable by static scan; each is proven by the test
 * named in `INVARIANT_DECLARATION_PROOFS`.
 */
export const INVARIANT_DECLARATIONS = {
  USES_ANTHROPIC_API: false,
  REQUIRES_ANTHROPIC_API_KEY: false,
  USES_LOCAL_CLAUDE_CODE: true,
  PRODUCTION_MOCK_DATA_ALLOWED: false,
  LAN_MODE: false,
  REMOTE_ACCESS: false,
  BIND_ADDRESS: '127.0.0.1',
} as const;

export type InvariantDeclarations = typeof INVARIANT_DECLARATIONS;
export type InvariantDeclarationName = keyof InvariantDeclarations;

/**
 * The test that proves each invariant, named precisely enough to run.
 *
 * `Record<InvariantDeclarationName, string>` is load-bearing: adding an
 * invariant without naming its proof stops the build. An unproven invariant is
 * indistinguishable from a wish.
 */
export const INVARIANT_DECLARATION_PROOFS: Readonly<Record<InvariantDeclarationName, string>> = {
  USES_ANTHROPIC_API:
    'tests/unit/runtime-declarations.test.ts > INVARIANT USES_ANTHROPIC_API=false > no vendor API host or SDK import exists anywhere in src/',
  REQUIRES_ANTHROPIC_API_KEY:
    'tests/unit/runtime-declarations.test.ts > INVARIANT REQUIRES_ANTHROPIC_API_KEY=false > no code path reads a key from the environment, a file or an input',
  USES_LOCAL_CLAUDE_CODE:
    'tests/unit/runtime-declarations.test.ts > INVARIANT USES_LOCAL_CLAUDE_CODE=true > the only runtime the bridge invokes is a local executable started from an argv array with no shell',
  PRODUCTION_MOCK_DATA_ALLOWED:
    'tests/unit/runtime-declarations.test.ts > INVARIANT PRODUCTION_MOCK_DATA_ALLOWED=false > no bridge module imports the prototype fixture tree',
  LAN_MODE:
    'tests/unit/runtime-declarations.test.ts > INVARIANT LAN_MODE=false > LAN mode is a compile-time false with no environment path into it',
  REMOTE_ACCESS:
    'tests/unit/runtime-declarations.test.ts > INVARIANT REMOTE_ACCESS=false > remote access is a compile-time false and no tunnel, proxy or relay client exists',
  BIND_ADDRESS:
    'tests/unit/runtime-declarations.test.ts > INVARIANT BIND_ADDRESS=127.0.0.1 > the listener is pinned to the contract address and no non-loopback bind appears in the tree',
};

/**
 * Claims about the live system. Every one is computed from observations; none
 * has a stored value, and none is true by default.
 */
export const DERIVED_DECLARATIONS = [
  'CONNECTED_TO_FORGE',
  'CONNECTED_TO_CLAUDE_CODE',
  'USES_REAL_PROJECTS',
  'USES_REAL_AGENTS',
  'USES_REAL_COMMANDS',
  'USES_MOCK_DATA',
  'USES_REAL_USAGE_TELEMETRY',
  'SUPPORTS_FILE_ATTACHMENTS',
] as const;

export type DerivedDeclarationName = (typeof DERIVED_DECLARATIONS)[number];

/** Which kind of observation justified a derived value. */
export type DeclarationEvidenceKind =
  | 'PROBE'
  | 'REGISTRY'
  | 'FILESYSTEM'
  | 'EVENT'
  | 'RECORD'
  | 'TELEMETRY'
  | 'PIPELINE'
  /** Nothing was observed. The only kind a `false` with no counter-proof may carry. */
  | 'NONE';

export interface DeclarationEvidence {
  readonly kind: DeclarationEvidenceKind;
  /** One sentence a human can act on. States what was observed, not what is hoped. */
  readonly summary: string;
  /** Re-checkable pointers. A `true` value with none of these is a bug. */
  readonly refs: readonly EvidenceRef[];
  /** Exactly what was absent. Non-empty whenever `value` is not established. */
  readonly missing: readonly string[];
}

/**
 * A derived declaration. Never a bare boolean: a boolean cannot say why it is
 * what it is, and "why not" is the only useful thing to render when a screen has
 * to explain that something is not connected.
 */
export interface DerivedDeclaration {
  readonly name: DerivedDeclarationName;
  readonly value: boolean;
  readonly evidence: DeclarationEvidence;
  readonly checkedAt: string;
}

/**
 * The whole picture: what this build is, and what the running system could
 * prove about itself at `computedAt`.
 */
export interface RuntimeDeclarations {
  readonly invariant: InvariantDeclarations;
  readonly invariantProofs: Readonly<Record<InvariantDeclarationName, string>>;
  readonly derived: Readonly<Record<DerivedDeclarationName, DerivedDeclaration>>;
  readonly computedAt: string;
}

/** The only address the bridge may bind. Asserted at startup and in tests. */
export const REQUIRED_BIND_ADDRESS = '127.0.0.1';

/**
 * Compile-time proof that the invariant and the address the server pins are the
 * same string. If either changes alone, this stops compiling.
 */
export const DECLARED_BIND_ADDRESS_MATCHES: typeof REQUIRED_BIND_ADDRESS =
  INVARIANT_DECLARATIONS.BIND_ADDRESS;

export const PROTOCOL_SCHEMA_VERSION = 1;

/* ========================================================================== */
/*  Events                                                                     */
/* ========================================================================== */

export type EventSource = 'forge' | 'claude-code' | 'bridge' | 'test' | 'user';

/**
 * Operational statuses. Every one is a claim that something is true right now,
 * and none may be rendered without the evidence the state machine requires.
 */
export type OperationalStatus =
  | 'CREATED'
  | 'QUEUED'
  | 'STARTING'
  | 'RUNNING'
  | 'STREAMING'
  | 'WAITING'
  | 'WAITING_FOR_PERMISSION'
  | 'VERIFYING'
  | 'REVIEWING'
  | 'REPAIRING'
  | 'RETRYING'
  | 'STOPPING'
  | 'COMPLETED'
  | 'FAILED'
  | 'BLOCKED'
  | 'CANCELLED'
  | 'INTERRUPTED'
  | 'DISCONNECTED'
  | 'RECOVERING'
  | 'RESUMABLE'
  | 'ORPHANED'
  | 'FAILED_RECOVERY'
  | 'DEGRADED';

/**
 * A pointer to something on disk that justifies a claim. Evidence is never the
 * claim itself: a path plus a hash can be re-checked later, a sentence cannot.
 */
export interface EvidenceRef {
  readonly kind: 'file' | 'artifact' | 'stdout' | 'stderr' | 'exit-code' | 'event' | 'verdict';
  /** Project-relative where possible; absolute only inside the trusted root. */
  readonly ref: string;
  readonly hash?: string;
  readonly note?: string;
}

/**
 * The envelope every event carries, from every source. `sequence` is monotonic
 * per stream and is what makes gap detection possible — the client can prove it
 * missed something instead of silently rendering an incomplete story.
 */
export interface ForgeEvent<P = unknown> {
  readonly eventId: string;
  readonly schemaVersion: number;
  readonly sequence: number;
  readonly timestamp: string;
  readonly projectId: string;
  readonly runId: string | null;
  readonly sessionId: string | null;
  readonly conversationId: string | null;
  readonly taskId: string | null;
  readonly agentId: string | null;
  readonly source: EventSource;
  readonly type: string;
  readonly status?: OperationalStatus;
  readonly payload: P;
  readonly evidenceRefs: readonly EvidenceRef[];
  /** Bridge ingestion time in ms since epoch — used for latency measurement. */
  readonly ingestedAt?: number;
}

/** Event type names the bridge emits. Kept as a union so handlers stay total. */
export const EVENT_TYPES = [
  'bridge.ready',
  'bridge.heartbeat',
  'bridge.shutdown',
  'bridge.degraded',
  'bridge.reconciled',
  'project.created',
  'project.discovered',
  'project.updated',
  'project.archived',
  'conversation.created',
  'conversation.resumed',
  'conversation.archived',
  'session.started',
  'session.resumed',
  'session.ended',
  'session.lost',
  'run.created',
  'run.state',
  'run.output.delta',
  'run.output.complete',
  'run.error',
  'run.cancel.requested',
  'run.cancelled',
  'claude.message',
  'claude.tool.start',
  'claude.tool.end',
  'claude.usage',
  'claude.stderr',
  'agent.activated',
  'agent.finished',
  'skill.attached',
  'skill.used',
  'task.created',
  'task.state',
  'verify.started',
  'verify.verdict',
  'review.started',
  'review.verdict',
  'test.started',
  'test.finished',
  'proof.recorded',
  'artifact.indexed',
  'artifact.missing',
  'attachment.state',
  'approval.requested',
  'approval.resolved',
  'checkpoint.created',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/* ========================================================================== */
/*  Usage telemetry                                                            */
/* ========================================================================== */

/**
 * How much a usage number can be trusted.
 *
 * EXACT       Claude Code reported it. Safe to present as fact.
 * DERIVED     Arithmetic over EXACT values only (e.g. a conversation total).
 * ESTIMATED   We approximated it locally. Must be visibly labelled.
 * UNAVAILABLE The installed runtime does not expose it. Show the absence
 *             honestly; never substitute a plausible-looking number.
 */
export type Accuracy = 'EXACT' | 'DERIVED' | 'ESTIMATED' | 'UNAVAILABLE';

export interface UsageField<T = number> {
  readonly name: string;
  readonly value: T | null;
  readonly unit: 'tokens' | 'ms' | 'usd' | 'count' | 'percent' | 'none';
  /** Where the number came from, specific enough to audit later. */
  readonly source: string;
  readonly accuracy: Accuracy;
  readonly updatedAt: string;
}

/**
 * The usage snapshot the bar renders. Every scalar is a `UsageField`, never a
 * bare number, so a value can never lose its provenance on the way to a screen.
 */
export interface UsageSnapshot {
  readonly scope: 'run' | 'conversation' | 'project' | 'day' | 'session';
  readonly scopeId: string;
  /** Null until Claude Code reports a session — never invented. */
  readonly sessionId: string | null;
  readonly model: UsageField<string>;
  readonly effort: UsageField<string>;
  readonly inputTokens: UsageField;
  readonly outputTokens: UsageField;
  readonly cacheReadTokens: UsageField;
  readonly cacheCreationTokens: UsageField;
  readonly contextTokensUsed: UsageField;
  readonly contextWindow: UsageField;
  readonly contextPercent: UsageField;
  readonly costUsd: UsageField;
  readonly turns: UsageField;
  readonly toolCalls: UsageField;
  readonly agentCount: UsageField;
  readonly skillUses: UsageField;
  readonly errors: UsageField;
  readonly retries: UsageField;
  readonly compactions: UsageField;
  readonly elapsedMs: UsageField;
  readonly eventLatencyP95: UsageField;
  readonly lastUpdate: string;
  /** True when no telemetry has arrived recently; the bar must say so. */
  readonly stale: boolean;
  /**
   * Subscription/plan usage. The 2.1.217 CLI does not expose plan quota, so
   * this stays UNAVAILABLE and the UI prints the honest sentence rather than a
   * remaining-percentage that would be pure invention.
   */
  readonly planUsage: UsageField<string>;
}

export const PLAN_USAGE_UNAVAILABLE_MESSAGE =
  'Plan usage is not exposed by the local Claude Code runtime.';

/* ========================================================================== */
/*  Operations — the entire surface the browser may ask for                    */
/* ========================================================================== */

/**
 * The allowlist. There is no generic execute verb, by design: a capability that
 * is not named here cannot be requested, however the payload is shaped.
 */
export const OPERATIONS = [
  'getHealth',
  'getDeclarations',
  'listProjects',
  'createProject',
  'openProject',
  'importProject',
  'archiveProject',
  'getProjectHealth',
  'listConversations',
  'createConversation',
  'openConversation',
  'archiveConversation',
  'sendMessage',
  'stopRun',
  'resumeSession',
  'listRuns',
  'getRun',
  'stageAttachment',
  'removeAttachment',
  'listAttachments',
  'getAttachmentPreview',
  'listProjectFiles',
  'readProjectFile',
  'getFileDiff',
  'listArtifacts',
  'inspectArtifact',
  'listTests',
  'runApprovedTest',
  'listProof',
  'listApprovals',
  'approveAction',
  'denyAction',
  'getUsageState',
  'getUsageHistory',
  'listEvents',
  'replayEvents',
  'createCheckpoint',
  'listCheckpoints',
  'exportDiagnostics',
] as const;

export type OperationName = (typeof OPERATIONS)[number];

/** Request envelope. `requestId` makes every operation idempotent to retry. */
export interface OperationRequest<N extends OperationName = OperationName, P = unknown> {
  readonly requestId: string;
  readonly schemaVersion: number;
  readonly op: N;
  readonly payload: P;
}

export type OperationErrorCode =
  | 'BAD_REQUEST'
  | 'UNKNOWN_OPERATION'
  | 'SCHEMA_MISMATCH'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PATH_REJECTED'
  | 'OUTSIDE_TRUSTED_ROOT'
  | 'PERMISSION_REQUIRED'
  | 'PERMISSION_DENIED'
  | 'INVALID_STATE'
  | 'ATTACHMENT_NOT_READY'
  | 'ATTACHMENT_REJECTED'
  | 'QUOTA_EXCEEDED'
  | 'CLAUDE_UNAVAILABLE'
  | 'CLAUDE_UNAUTHENTICATED'
  | 'RUNTIME_ERROR'
  | 'CANCELLED'
  | 'TIMEOUT';

export interface OperationError {
  readonly code: OperationErrorCode;
  /** Plain, specific, and safe to show a user. Never contains a secret. */
  readonly message: string;
  readonly detail?: string;
}

export type OperationResponse<R = unknown> =
  | { readonly requestId: string; readonly ok: true; readonly result: R }
  | { readonly requestId: string; readonly ok: false; readonly error: OperationError };

/* ========================================================================== */
/*  Projects                                                                   */
/* ========================================================================== */

export type ProjectHealthState = 'HEALTHY' | 'DEGRADED' | 'UNKNOWN' | 'MISSING' | 'ERROR';

export interface GitState {
  readonly initialized: boolean;
  readonly branch: string | null;
  readonly dirtyFiles: number;
  readonly lastCommit: string | null;
  readonly hasRemote: boolean;
}

/**
 * A project record. `id` is generated once and never derived from the name, so
 * renaming a project cannot orphan its history — and no subsystem is ever
 * allowed to rebuild a path by guessing from a display name.
 */
export interface ProjectRecord {
  readonly id: string;
  readonly displayName: string;
  readonly slug: string;
  readonly canonicalPath: string;
  readonly relativePath: string;
  readonly type: string;
  readonly description: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly forgeVersion: string | null;
  readonly templateVersion: string | null;
  readonly git: GitState;
  readonly sessionIds: readonly string[];
  readonly conversationIds: readonly string[];
  readonly activeRunIds: readonly string[];
  readonly archived: boolean;
  readonly health: ProjectHealthState;
  readonly lastDoctorResult: string | null;
  readonly metadataSchemaVersion: number;
}

/* ========================================================================== */
/*  Conversations and sessions                                                 */
/* ========================================================================== */

export interface ConversationRecord {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  /** Claude Code's own session id. Null until a real session reports one. */
  readonly claudeSessionId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messageCount: number;
  readonly attachmentIds: readonly string[];
  readonly activeRunId: string | null;
  readonly archived: boolean;
  /** Highest sequence the client has confirmed; the replay anchor. */
  readonly lastConfirmedSequence: number;
}

/* ========================================================================== */
/*  Attachments                                                                */
/* ========================================================================== */

export type AttachmentState =
  | 'SELECTED'
  | 'VALIDATING'
  | 'HASHING'
  | 'STAGING'
  | 'INDEXING'
  | 'READY'
  | 'REJECTED'
  | 'QUARANTINED'
  | 'FAILED'
  | 'REMOVED';

export type SecurityVerdict = 'CLEAN' | 'WARN' | 'QUARANTINE' | 'REJECT';

export interface AttachmentRecord {
  readonly id: string;
  readonly projectId: string;
  readonly conversationId: string;
  readonly originalFilename: string;
  readonly storedFilename: string;
  readonly canonicalPath: string;
  /** What the client claimed. Never trusted on its own. */
  readonly declaredMediaType: string;
  /** What the file signature actually says. This is what the policy uses. */
  readonly detectedMediaType: string | null;
  readonly size: number;
  readonly hash: string | null;
  readonly createdAt: string;
  readonly uploaderSource: 'picker' | 'drag-drop' | 'clipboard' | 'project-file';
  readonly previewAvailable: boolean;
  readonly state: AttachmentState;
  readonly security: SecurityVerdict;
  readonly securityNotes: readonly string[];
  /** Whether Claude Code may be pointed at this file at all. */
  readonly claudeAccessible: boolean;
  readonly deleted: boolean;
}

/* ========================================================================== */
/*  Approvals                                                                  */
/* ========================================================================== */

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface ApprovalRequest {
  readonly id: string;
  readonly projectId: string;
  readonly runId: string | null;
  readonly requestedBy: string;
  readonly action: string;
  readonly operation: string;
  readonly affects: readonly string[];
  readonly risk: RiskLevel;
  readonly reason: string;
  readonly rollbackPlan: string;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly state: 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED';
  readonly resolvedAt: string | null;
}

/* ========================================================================== */
/*  Verification                                                               */
/* ========================================================================== */

export type VerifyVerdict =
  | 'VERIFIED_PASS'
  | 'VERIFIED_PASS_WITH_LIMITATIONS'
  | 'REJECTED'
  | 'BLOCKED'
  | 'INSUFFICIENT_EVIDENCE'
  | 'UNVERIFIED';

export interface VerificationRecord {
  readonly id: string;
  readonly taskId: string;
  readonly runId: string;
  readonly verifierAgentId: string;
  /** The agent under review. Must differ from `verifierAgentId`. */
  readonly subjectAgentId: string;
  readonly startedAt: string;
  readonly resolvedAt: string | null;
  readonly verdict: VerifyVerdict;
  readonly reason: string;
  readonly evidenceRefs: readonly EvidenceRef[];
}

/**
 * Self-approval is the failure mode this whole layer exists to prevent, so it
 * is checked in one place rather than trusted to every caller.
 */
export function isSelfApproval(record: VerificationRecord): boolean {
  return record.verifierAgentId === record.subjectAgentId;
}

/* ========================================================================== */
/*  Tests and proof                                                            */
/* ========================================================================== */

/**
 * A recorded execution. Note what is required: start, end, exit code and the
 * captured streams. A gate cannot pass on stdout containing an encouraging
 * word — `passed` is derived from the exit code and the parsed counts, and the
 * raw material stays attached so the derivation can be re-checked.
 */
export interface TestExecution {
  readonly id: string;
  readonly projectId: string;
  readonly runId: string | null;
  readonly gate: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly durationMs: number | null;
  readonly exitCode: number | null;
  readonly stdoutRef: string | null;
  readonly stderrRef: string | null;
  readonly counts: { readonly passed: number; readonly failed: number; readonly skipped: number } | null;
  readonly status: OperationalStatus;
  readonly evidenceRefs: readonly EvidenceRef[];
}

export interface ProofEntry {
  readonly id: string;
  readonly projectId: string;
  readonly runId: string | null;
  readonly taskId: string | null;
  readonly timestamp: string;
  readonly claim: string;
  readonly agentId: string | null;
  readonly command: string | null;
  readonly verdict: 'accepted' | 'rejected' | 'pending';
  readonly reason: string;
  readonly evidenceRefs: readonly EvidenceRef[];
}

/**
 * The single gate for "did this pass?". Deliberately strict: an execution with
 * no exit code has not finished, and a zero exit with a non-zero failure count
 * is a wrapper bug, not a pass.
 */
export function testPassed(execution: TestExecution): boolean {
  if (execution.exitCode === null) return false;
  if (execution.exitCode !== 0) return false;
  if (execution.counts && execution.counts.failed > 0) return false;
  return true;
}

/* ========================================================================== */
/*  Health                                                                     */
/* ========================================================================== */

export interface ClaudeCodeStatus {
  readonly available: boolean;
  readonly executablePath: string | null;
  readonly version: string | null;
  readonly authenticated: boolean;
  readonly lastCheckedAt: string;
  /** Flags the installed version actually accepts. Gates the adapter. */
  readonly supportedFlags: readonly string[];
  readonly note: string | null;
}

export interface BridgeHealth {
  readonly ok: boolean;
  readonly bindAddress: string;
  readonly port: number;
  readonly uptimeMs: number;
  readonly startedAt: string;
  readonly claudeCode: ClaudeCodeStatus;
  readonly projectsRoot: string;
  readonly projectsRootExists: boolean;
  readonly activeRuns: number;
  readonly connectedClients: number;
  readonly eventsPersisted: number;
  readonly lastEventAt: string | null;
  readonly declarations: RuntimeDeclarations;
  readonly degraded: readonly string[];
}
