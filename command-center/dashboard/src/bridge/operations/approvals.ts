/**
 * Forge Workspace — owner approvals.
 *
 * An approval is the only mechanism in the bridge by which a HIGH or CRITICAL
 * risk action becomes permitted. It exists because of one failure mode: a system
 * that asks for permission, does not wait for the answer, and then reports that
 * permission was granted.
 *
 * FOUR RULES THIS FILE HOLDS.
 *
 * 1. PENDING BLOCKS. `checkApproval` returns PENDING and nothing else happens.
 *    There is no "assume yes after N seconds", no default-allow, and no code
 *    path where the absence of a verdict is read as a verdict.
 *
 * 2. EXPIRED IS NEVER APPROVED. Expiry is evaluated on every read against a
 *    clock passed in, and the PENDING -> EXPIRED move is PERSISTED at that
 *    moment, so the expired state is a fact on disk rather than a calculation a
 *    later reader might forget to redo. `PERMISSION_MACHINE` makes APPROVED
 *    unreachable from EXPIRED, so even a buggy caller cannot walk it back.
 *
 * 3. EVERY OUTCOME IS TERMINAL. A denial is final; asking again means a NEW
 *    request with a NEW id, so the audit trail keeps both. This is enforced by
 *    `assertPermissionTransition`, not by convention.
 *
 * 4. THE REQUEST SAYS WHAT IS AT STAKE. action, requester, project, operation,
 *    affected paths, risk, reason, rollback plan and an expiry — all required by
 *    the contract's `ApprovalRequest`, all filled with something specific. A
 *    yes/no dialog with no content trains an owner to click yes.
 *
 * WHAT IS DELIBERATELY NOT STORED: who resolved the request. `ApprovalRequest`
 * in protocol.ts has no field for it, and bolting one onto a contract record is
 * how a contract and its storage start to drift. The resolver's name goes into
 * the `approval.resolved` event payload, which is the append-only audit trail
 * and is the right home for it.
 *
 * The relative `.ts` imports are deliberate: Node 24 executes TypeScript
 * directly and requires the explicit extension, and bridge code is permitted
 * relative imports. `state-machines.ts` is safe to import here because its only
 * import is `import type`, which is erased before Node ever sees the file.
 */

import { randomUUID } from 'node:crypto';

import type { ApprovalRequest, EvidenceRef, RiskLevel } from '../../shared/protocol.ts';
import { assertPermissionTransition, PERMISSION_MACHINE } from '../../shared/state-machines.ts';

import { asObject, fail, optInteger, optString, optStringArray, reqString } from '../router.ts';
import type { OperationContext, Router } from '../router.ts';
import type { ForgeStore } from '../storage/store.ts';
import type { Transport } from '../transport.ts';

/* ========================================================================== */
/*  Limits and vocabulary                                                      */
/* ========================================================================== */

/** Ids must satisfy the store's `SAFE_ID`; a uuid suffix does. */
export const APPROVAL_ID_PREFIX = 'apr-';

export const DEFAULT_APPROVAL_TTL_MS = 15 * 60_000;
export const MIN_APPROVAL_TTL_MS = 60_000;
export const MAX_APPROVAL_TTL_MS = 24 * 60 * 60_000;

/**
 * The risks that may not proceed without an explicit owner verdict. LOW and
 * MEDIUM actions are still recorded; they are simply not gated.
 */
export const APPROVAL_REQUIRED_RISKS: readonly RiskLevel[] = ['HIGH', 'CRITICAL'];

export function requiresApproval(risk: RiskLevel): boolean {
  return APPROVAL_REQUIRED_RISKS.includes(risk);
}

const MAX_AFFECTS = 64;
const MAX_AFFECT_LENGTH = 512;
const MAX_TEXT_LENGTH = 1_024;
const MAX_LIST_LIMIT = 500;

const APPROVAL_STATES: readonly ApprovalRequest['state'][] = ['PENDING', 'APPROVED', 'DENIED', 'EXPIRED'];

/** The contract's risk vocabulary, as runtime data for payload validation. */
export const RISK_LEVELS: readonly RiskLevel[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

/* ========================================================================== */
/*  The small IO surface these functions need                                  */
/* ========================================================================== */

/**
 * Everything approvals touch, and nothing more. Passed explicitly rather than
 * reached for, so a test can drive the whole lifecycle against a temp store and
 * a frozen clock.
 */
export interface ApprovalIo {
  readonly store: ForgeStore;
  /** Optional: an approval written with no transport still persists correctly. */
  readonly events: Transport | null;
  readonly now: () => Date;
}

export interface ApprovalDeps {
  readonly now?: () => Date;
}

export function ioFromContext(ctx: OperationContext, deps?: ApprovalDeps): ApprovalIo {
  return { store: ctx.store, events: ctx.events, now: deps?.now ?? (() => new Date()) };
}

/* ========================================================================== */
/*  Expiry                                                                     */
/* ========================================================================== */

/**
 * Has this request run out of time?
 *
 * An unparseable `expiresAt` counts as expired. A request whose deadline cannot
 * be read cannot be shown to be still open, and "cannot be shown to be open" is
 * the safe reading for a permission.
 */
export function isExpiredAt(approval: ApprovalRequest, atMs: number): boolean {
  const deadline = Date.parse(approval.expiresAt);
  if (!Number.isFinite(deadline)) return true;
  return deadline <= atMs;
}

function persist(io: ApprovalIo, approval: ApprovalRequest): ApprovalRequest {
  io.store.saveRecord('approval', approval);
  return approval;
}

/**
 * Append an approval event. A logging failure is reported as a note, never as a
 * failure of the decision itself — the record is already on disk by then, and
 * telling the caller "the approval failed" would be false.
 */
function emit(
  io: ApprovalIo,
  type: 'approval.requested' | 'approval.resolved',
  approval: ApprovalRequest,
  extra: Record<string, unknown>,
  evidenceRefs: readonly EvidenceRef[],
): readonly string[] {
  if (io.events === null) return [];
  try {
    io.events.publish({
      projectId: approval.projectId,
      runId: approval.runId,
      source: 'user',
      type,
      status: approval.state === 'PENDING' ? 'WAITING_FOR_PERMISSION' : undefined,
      payload: {
        approvalId: approval.id,
        projectId: approval.projectId,
        runId: approval.runId,
        action: approval.action,
        operation: approval.operation,
        requestedBy: approval.requestedBy,
        affects: approval.affects,
        risk: approval.risk,
        reason: approval.reason,
        rollbackPlan: approval.rollbackPlan,
        requestedAt: approval.requestedAt,
        expiresAt: approval.expiresAt,
        state: approval.state,
        resolvedAt: approval.resolvedAt,
        ...extra,
      },
      evidenceRefs,
    });
    return [];
  } catch (error) {
    return [`the approval record was written, but the ${type} event could not be appended: ${errorText(error)}`];
  }
}

function recordRef(approvalId: string): EvidenceRef {
  return { kind: 'file', ref: `records/approval/${approvalId}.json`, note: 'the approval record as written' };
}

/**
 * Return the request as it is NOW, expiring it first if its deadline has passed.
 *
 * This is the single choke point: nothing else in this file reads an approval
 * without going through it, so there is no path on which a stale PENDING is
 * mistaken for a live one.
 */
export function refreshApproval(io: ApprovalIo, approval: ApprovalRequest): ApprovalRequest {
  if (approval.state !== 'PENDING') return approval;
  const now = io.now();
  if (!isExpiredAt(approval, now.getTime())) return approval;

  assertPermissionTransition('PENDING', 'EXPIRED');
  const expired: ApprovalRequest = { ...approval, state: 'EXPIRED', resolvedAt: now.toISOString() };
  persist(io, expired);
  emit(
    io,
    'approval.resolved',
    expired,
    {
      verdict: 'EXPIRED',
      resolvedBy: null,
      note: `no verdict was given before ${approval.expiresAt}; the request expired unanswered`,
    },
    [recordRef(expired.id), { kind: 'verdict', ref: `approval:${expired.id}`, note: 'EXPIRED — never treated as approved' }],
  );
  return expired;
}

/* ========================================================================== */
/*  Reads                                                                      */
/* ========================================================================== */

export interface ApprovalListResult {
  readonly approvals: readonly ApprovalRequest[];
  readonly unreadable: readonly { readonly id: string; readonly reason: string; readonly detail: string }[];
  /** How many PENDING requests were expired by this read. */
  readonly expiredNow: number;
}

export interface ApprovalFilter {
  readonly projectId?: string;
  readonly runId?: string | null;
  readonly operation?: string;
  readonly action?: string;
  readonly states?: readonly ApprovalRequest['state'][];
}

/** Every approval, refreshed. Unreadable records are named, never dropped. */
export function listApprovalRecords(io: ApprovalIo, filter: ApprovalFilter = {}): ApprovalListResult {
  const listed = io.store.listRecords('approval');
  const approvals: ApprovalRequest[] = [];
  let expiredNow = 0;

  for (const stored of listed.records) {
    const before = stored.state;
    const current = refreshApproval(io, stored);
    if (before === 'PENDING' && current.state === 'EXPIRED') expiredNow += 1;

    if (filter.projectId !== undefined && current.projectId !== filter.projectId) continue;
    if (filter.runId !== undefined && current.runId !== filter.runId) continue;
    if (filter.operation !== undefined && current.operation !== filter.operation) continue;
    if (filter.action !== undefined && current.action !== filter.action) continue;
    if (filter.states !== undefined && !filter.states.includes(current.state)) continue;
    approvals.push(current);
  }

  approvals.sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : a.requestedAt > b.requestedAt ? -1 : 0));
  return {
    approvals,
    unreadable: listed.unreadable.map((u) => ({ id: u.id, reason: u.reason, detail: u.detail })),
    expiredNow,
  };
}

export type ApprovalReadFailure = 'NOT_FOUND' | 'UNREADABLE';

export type ApprovalReadResult =
  | { readonly ok: true; readonly approval: ApprovalRequest }
  | { readonly ok: false; readonly failure: ApprovalReadFailure; readonly detail: string };

export function readApproval(io: ApprovalIo, id: string): ApprovalReadResult {
  let read;
  try {
    read = io.store.getRecord('approval', id);
  } catch (error) {
    return { ok: false, failure: 'NOT_FOUND', detail: `not a usable approval id: ${errorText(error)}` };
  }
  if (!read.ok) {
    return read.reason === 'MISSING'
      ? { ok: false, failure: 'NOT_FOUND', detail: read.detail }
      : { ok: false, failure: 'UNREADABLE', detail: `${read.reason}: ${read.detail}` };
  }
  return { ok: true, approval: refreshApproval(io, read.record) };
}

/* ========================================================================== */
/*  Requesting                                                                 */
/* ========================================================================== */

export interface RequestApprovalInput {
  readonly projectId: string;
  readonly runId?: string | null;
  readonly requestedBy: string;
  /** What is being asked for, in the owner's language. */
  readonly action: string;
  /** The contract operation that is blocked on this. */
  readonly operation: string;
  /** Paths (project-relative where possible) the action would touch. */
  readonly affects: readonly string[];
  readonly risk: RiskLevel;
  readonly reason: string;
  readonly rollbackPlan: string;
  readonly ttlMs?: number;
  readonly evidenceRefs?: readonly EvidenceRef[];
}

export interface RequestApprovalResult {
  readonly approval: ApprovalRequest;
  /** False when an identical live request already existed and was reused. */
  readonly created: boolean;
  readonly notes: readonly string[];
}

/**
 * Open a request, or hand back the live one that is already open for exactly
 * this action.
 *
 * Reuse matters: a UI that polls `runApprovedTest` would otherwise mint a new
 * request every few seconds, and an owner facing forty identical cards approves
 * one at random. One live request per (project, run, operation, action).
 */
export function requestApproval(io: ApprovalIo, input: RequestApprovalInput): RequestApprovalResult {
  const now = io.now();
  const runId = input.runId ?? null;

  const existing = listApprovalRecords(io, {
    projectId: input.projectId,
    runId,
    operation: input.operation,
    action: input.action,
    states: ['PENDING'],
  }).approvals[0];
  if (existing !== undefined) {
    return { approval: existing, created: false, notes: ['reused the request that is already open for this action'] };
  }

  const ttl = clampTtl(input.ttlMs);
  const approval: ApprovalRequest = {
    id: `${APPROVAL_ID_PREFIX}${randomUUID()}`,
    projectId: input.projectId,
    runId,
    requestedBy: input.requestedBy,
    action: input.action,
    operation: input.operation,
    affects: input.affects.slice(0, MAX_AFFECTS).map((a) => a.slice(0, MAX_AFFECT_LENGTH)),
    risk: input.risk,
    reason: input.reason.slice(0, MAX_TEXT_LENGTH),
    rollbackPlan: input.rollbackPlan.slice(0, MAX_TEXT_LENGTH),
    requestedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttl).toISOString(),
    state: 'PENDING',
    resolvedAt: null,
  };

  persist(io, approval);
  const notes = emit(io, 'approval.requested', approval, { ttlMs: ttl }, [
    recordRef(approval.id),
    ...(input.evidenceRefs ?? []),
  ]);
  return { approval, created: true, notes };
}

function clampTtl(ttlMs: number | undefined): number {
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs)) return DEFAULT_APPROVAL_TTL_MS;
  return Math.min(MAX_APPROVAL_TTL_MS, Math.max(MIN_APPROVAL_TTL_MS, Math.floor(ttlMs)));
}

/* ========================================================================== */
/*  The gate                                                                   */
/* ========================================================================== */

export type ApprovalGateState = 'APPROVED' | 'PENDING' | 'DENIED' | 'EXPIRED' | 'NONE' | 'MISMATCHED';

export interface ApprovalGateVerdict {
  readonly state: ApprovalGateState;
  readonly approval: ApprovalRequest | null;
  /** A sentence fit to show a person. Never contains a path outside the root. */
  readonly reason: string;
}

export interface CheckApprovalInput {
  readonly projectId: string;
  readonly runId?: string | null;
  readonly operation: string;
  readonly action: string;
  /** When the client names one, only that request may authorise the action. */
  readonly approvalId?: string;
}

/**
 * Is this action permitted right now?
 *
 * `NONE` means nobody has been asked yet. It is NOT a refusal and NOT a
 * permission — the caller is expected to open a request and stop. Every other
 * value is a fact already on disk.
 */
export function checkApproval(io: ApprovalIo, input: CheckApprovalInput): ApprovalGateVerdict {
  const runId = input.runId ?? null;

  if (input.approvalId !== undefined) {
    const read = readApproval(io, input.approvalId);
    if (!read.ok) {
      return {
        state: 'NONE',
        approval: null,
        reason:
          read.failure === 'NOT_FOUND'
            ? `No approval is recorded with id ${input.approvalId}.`
            : `The approval record ${input.approvalId} could not be read (${read.detail}).`,
      };
    }
    const approval = read.approval;
    if (approval.projectId !== input.projectId || approval.operation !== input.operation || approval.action !== input.action) {
      // An approval is permission for ONE thing. Accepting it for another is
      // how "yes, run the linter" becomes "yes, rebuild everything".
      return {
        state: 'MISMATCHED',
        approval,
        reason:
          `Approval ${approval.id} was granted for "${approval.action}" on operation "${approval.operation}" ` +
          `in project ${approval.projectId}; it does not authorise "${input.action}" on "${input.operation}".`,
      };
    }
    return verdictFor(approval);
  }

  const candidates = listApprovalRecords(io, {
    projectId: input.projectId,
    runId,
    operation: input.operation,
    action: input.action,
  }).approvals;

  const approved = candidates.find((a) => a.state === 'APPROVED');
  if (approved !== undefined) return verdictFor(approved);
  const pending = candidates.find((a) => a.state === 'PENDING');
  if (pending !== undefined) return verdictFor(pending);
  const resolved = candidates[0];
  if (resolved !== undefined) return verdictFor(resolved);

  return { state: 'NONE', approval: null, reason: 'No approval has been requested for this action.' };
}

function verdictFor(approval: ApprovalRequest): ApprovalGateVerdict {
  switch (approval.state) {
    case 'APPROVED':
      return { state: 'APPROVED', approval, reason: `Approved at ${approval.resolvedAt ?? 'an unrecorded time'}.` };
    case 'PENDING':
      return {
        state: 'PENDING',
        approval,
        reason: `Waiting for an owner verdict. The request expires at ${approval.expiresAt}.`,
      };
    case 'DENIED':
      return {
        state: 'DENIED',
        approval,
        reason: `Denied at ${approval.resolvedAt ?? 'an unrecorded time'}. A denial is final; a new request is required.`,
      };
    case 'EXPIRED':
      return {
        state: 'EXPIRED',
        approval,
        reason: `The request expired at ${approval.expiresAt} without a verdict. An expired request is never an approval.`,
      };
  }
}

/* ========================================================================== */
/*  Resolving                                                                  */
/* ========================================================================== */

export type ResolveVerdict = 'APPROVED' | 'DENIED';

export interface ResolveApprovalInput {
  readonly approvalId: string;
  readonly verdict: ResolveVerdict;
  /** Who decided. Recorded in the event, which is the audit trail. */
  readonly resolvedBy: string;
  readonly note?: string;
}

export interface ResolveApprovalResult {
  readonly approval: ApprovalRequest;
  readonly notes: readonly string[];
}

/**
 * Record the owner's decision.
 *
 * Everything that can go wrong here goes wrong loudly: an unknown id, an
 * unreadable record, and — the one that matters — a request that is no longer
 * PENDING. `assertPermissionTransition` is what refuses APPROVED after DENIED
 * or after EXPIRED, and it does so from the shared state machine rather than
 * from a condition written out again in this file.
 */
export function resolveApproval(io: ApprovalIo, input: ResolveApprovalInput): ResolveApprovalResult {
  const read = readApproval(io, input.approvalId);
  if (!read.ok) {
    if (read.failure === 'NOT_FOUND') {
      fail('NOT_FOUND', `No approval is recorded with id ${input.approvalId}.`, read.detail);
    }
    fail('RUNTIME_ERROR', `The approval record ${input.approvalId} could not be read.`, read.detail);
  }

  const current = read.approval;
  if (current.state !== 'PENDING') {
    fail(
      'INVALID_STATE',
      `Approval ${current.id} is already ${current.state}; ${
        PERMISSION_MACHINE.terminal.includes(current.state)
          ? 'that outcome is final and cannot be changed. Open a new request.'
          : 'it cannot be resolved again.'
      }`,
      `attempted ${current.state} -> ${input.verdict}`,
    );
  }

  try {
    assertPermissionTransition(current.state, input.verdict);
  } catch (error) {
    fail('INVALID_STATE', `That verdict is not a legal move for approval ${current.id}.`, errorText(error));
  }

  const resolvedAt = io.now().toISOString();
  const resolved: ApprovalRequest = { ...current, state: input.verdict, resolvedAt };
  persist(io, resolved);

  const notes = emit(
    io,
    'approval.resolved',
    resolved,
    {
      verdict: input.verdict,
      resolvedBy: input.resolvedBy,
      note: input.note ?? null,
    },
    [
      recordRef(resolved.id),
      {
        kind: 'verdict',
        ref: `approval:${resolved.id}`,
        note: `${input.verdict} by ${input.resolvedBy} at ${resolvedAt}`,
      },
    ],
  );
  return { approval: resolved, notes };
}

/* ========================================================================== */
/*  Presentation                                                               */
/* ========================================================================== */

/**
 * What the UI renders. `blocksOperation` is stated rather than left to be
 * inferred, because "PENDING" on a card and "the button is disabled" have to be
 * driven by the same fact.
 */
export function describeApproval(approval: ApprovalRequest, nowMs: number): Record<string, unknown> {
  const deadline = Date.parse(approval.expiresAt);
  const msRemaining =
    approval.state === 'PENDING' && Number.isFinite(deadline) ? Math.max(0, deadline - nowMs) : null;
  return {
    ...approval,
    blocksOperation: approval.state === 'PENDING',
    grantsPermission: approval.state === 'APPROVED',
    terminal: PERMISSION_MACHINE.terminal.includes(approval.state),
    msRemaining,
    expiryReadable: Number.isFinite(deadline),
  };
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

/* ========================================================================== */
/*  Operations                                                                 */
/* ========================================================================== */

function parseStates(body: Record<string, unknown>): readonly ApprovalRequest['state'][] | undefined {
  const raw = optStringArray(body, 'states', 4, 16);
  if (raw === undefined) return undefined;
  const states: ApprovalRequest['state'][] = [];
  for (const value of raw) {
    if (!(APPROVAL_STATES as readonly string[]).includes(value)) {
      fail('BAD_REQUEST', `states may only contain ${APPROVAL_STATES.join(', ')}.`);
    }
    states.push(value as ApprovalRequest['state']);
  }
  return states;
}

function listApprovals(payload: unknown, ctx: OperationContext, deps?: ApprovalDeps): Record<string, unknown> {
  const body = asObject(payload);
  const io = ioFromContext(ctx, deps);

  const filter: {
    projectId?: string;
    runId?: string | null;
    operation?: string;
    action?: string;
    states?: readonly ApprovalRequest['state'][];
  } = {
    projectId: optString(body, 'projectId'),
    operation: optString(body, 'operation', 64),
    action: optString(body, 'action', 256),
    states: parseStates(body),
  };
  if (Object.prototype.hasOwnProperty.call(body, 'runId')) {
    const runId = body.runId;
    if (runId === null) filter.runId = null;
    else if (typeof runId === 'string' && runId.length > 0 && runId.length <= 128) filter.runId = runId;
    else fail('BAD_REQUEST', 'runId must be a string or null.');
  }
  const limit = optInteger(body, 'limit', 1, MAX_LIST_LIMIT) ?? MAX_LIST_LIMIT;

  const result = listApprovalRecords(io, filter);
  const nowMs = io.now().getTime();
  const page = result.approvals.slice(0, limit);

  return {
    approvals: page.map((a) => describeApproval(a, nowMs)),
    count: page.length,
    total: result.approvals.length,
    truncated: result.approvals.length > page.length,
    // Reported, never hidden: a shorter clean list is a wrong list.
    unreadable: result.unreadable,
    expiredOnThisRead: result.expiredNow,
    pending: result.approvals.filter((a) => a.state === 'PENDING').length,
    checkedAt: new Date(nowMs).toISOString(),
    riskLevelsRequiringApproval: APPROVAL_REQUIRED_RISKS,
  };
}

function resolveOperation(
  payload: unknown,
  ctx: OperationContext,
  verdict: ResolveVerdict,
  actorKey: 'approvedBy' | 'deniedBy',
  deps?: ApprovalDeps,
): Record<string, unknown> {
  const body = asObject(payload);
  const approvalId = reqString(body, 'approvalId');
  const resolvedBy = reqString(body, actorKey, 128);
  const note = optString(body, 'note', MAX_TEXT_LENGTH);

  const io = ioFromContext(ctx, deps);
  const result = resolveApproval(io, {
    approvalId,
    verdict,
    resolvedBy,
    ...(note !== undefined ? { note } : {}),
  });

  return {
    approval: describeApproval(result.approval, io.now().getTime()),
    verdict,
    resolvedBy,
    notes: result.notes,
  };
}

/**
 * Attach the approval operations.
 *
 * `requestApproval` is deliberately NOT an operation: the contract has no verb
 * for it, and a browser that could mint its own permission requests for
 * arbitrary actions would be inventing the risk assessment it is supposed to be
 * shown. Requests are opened by the bridge, at the point where a gated action
 * was actually attempted.
 */
export function registerApprovalOperations(
  router: Router,
  deps?: ApprovalDeps,
  options: { readonly override?: boolean } = {},
): void {
  router.register('listApprovals', (payload, ctx) => listApprovals(payload, ctx, deps), options);
  router.register(
    'approveAction',
    (payload, ctx) => resolveOperation(payload, ctx, 'APPROVED', 'approvedBy', deps),
    options,
  );
  router.register(
    'denyAction',
    (payload, ctx) => resolveOperation(payload, ctx, 'DENIED', 'deniedBy', deps),
    options,
  );
}
