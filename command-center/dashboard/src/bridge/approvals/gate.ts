/**
 * Forge Workspace — the owner-approval gate.
 *
 * This is the service the run lifecycle awaits before doing anything the policy
 * says needs the owner's permission. It exists to close one specific failure
 * mode: a system that asks for permission, does not wait for the answer, and then
 * reports that permission was granted.
 *
 * FIVE RULES THIS FILE HOLDS.
 *
 * 1. PENDING BLOCKS. `requestApproval` returns a promise that settles ONLY on a
 *    real resolution — an owner verdict or an expiry. There is no "assume yes
 *    after N seconds"; the absence of a verdict is never read as a verdict.
 *
 * 2. APPROVED PROCEEDS, EVERYTHING ELSE STOPS. The resolution carries a single
 *    `proceed`, true for APPROVED and false for DENIED and EXPIRED. A caller that
 *    honours `proceed` cannot run a denied or expired action, and the gate never
 *    reports a non-approval as a success.
 *
 * 3. EXPIRED IS NEVER APPROVED. Expiry is evaluated against the injected clock,
 *    the PENDING -> EXPIRED move is PERSISTED at that moment, and
 *    `assertPermissionTransition` from the shared state machine makes APPROVED
 *    unreachable from EXPIRED — so even a later, buggy resolve call cannot walk it
 *    back to approved.
 *
 * 4. THE STORE IS THE ONE SOURCE OF TRUTH. The gate persists its request as an
 *    `approval` record and reads verdicts back from the same record. That is how
 *    it interoperates with the existing `approveAction` / `denyAction` operations
 *    WITHOUT importing them: whichever path records the verdict, the gate sees it
 *    on its next `notify` or poll. Neither side has to know the other exists.
 *
 * 5. A LOGGING FAILURE IS NOT A DECISION FAILURE. Events are best-effort; the
 *    record is on disk before the event is attempted, so a failed append is
 *    swallowed rather than turned into a false "the approval failed".
 *
 * The relative `.ts` imports are deliberate: Node 24 executes TypeScript directly
 * and requires the explicit extension, and bridge code is permitted relative
 * imports. `state-machines.ts` is safe to import here because its only import is
 * `import type`, which is erased before Node ever sees the file.
 */

import { randomUUID } from 'node:crypto';
import { clearTimeout, setTimeout } from 'node:timers';

import type { ApprovalRequest, EvidenceRef, RiskLevel } from '../../shared/protocol.ts';
import { assertPermissionTransition } from '../../shared/state-machines.ts';
import type { AppendEventInput, ForgeStore } from '../storage/store.ts';

import { classifyAction } from './policy.ts';
import type { PolicyDecision, ProposedAction } from './policy.ts';

/* ========================================================================== */
/*  Limits and vocabulary                                                      */
/* ========================================================================== */

/** Ids must satisfy the store's `SAFE_ID`; a uuid suffix does. */
export const APPROVAL_ID_PREFIX = 'apr-';

export const DEFAULT_APPROVAL_TTL_MS = 15 * 60_000;
export const MIN_APPROVAL_TTL_MS = 60_000;
export const MAX_APPROVAL_TTL_MS = 24 * 60 * 60_000;

/** How often the gate re-reads the store for a verdict while a request is open. */
export const DEFAULT_POLL_INTERVAL_MS = 500;

const MAX_AFFECTS = 64;
const MAX_AFFECT_LENGTH = 512;
const MAX_TEXT_LENGTH = 1_024;

/* ========================================================================== */
/*  IO seam                                                                    */
/* ========================================================================== */

/**
 * The narrow event surface the gate needs. The bridge's `Transport` satisfies it
 * structurally, so the run lifecycle passes `ctx.events` straight in; a test
 * passes a capturing fake or `null`. Kept narrow on purpose — the gate appends
 * two event types and nothing more.
 */
export interface GateEventSink {
  publish(input: AppendEventInput<Record<string, unknown>>): unknown;
}

/**
 * Everything the gate touches, passed explicitly rather than reached for, so a
 * test can drive the whole lifecycle against a temp store and a frozen clock.
 */
export interface GateIo {
  readonly store: ForgeStore;
  /** Optional: an approval written with no sink still persists correctly. */
  readonly events: GateEventSink | null;
  readonly now: () => Date;
}

/** An opaque timer handle. The default scheduler returns a Node timer; tests inject their own. */
export type GateTimer = unknown;

/**
 * The gate's only source of asynchrony. Injectable so tests can drive time
 * deterministically instead of waiting on real clocks.
 */
export interface GateScheduler {
  set(fn: () => void, ms: number): GateTimer;
  clear(handle: GateTimer): void;
}

const nodeScheduler: GateScheduler = {
  set(fn, ms) {
    const handle = setTimeout(fn, ms);
    // The gate's timers must never keep the process alive on their own.
    const maybe = handle as { unref?: () => void };
    if (typeof maybe.unref === 'function') maybe.unref();
    return handle;
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export interface GateOptions {
  /** Re-read the store this often while a request is pending (ms). 0 disables polling. */
  readonly pollIntervalMs?: number;
  readonly scheduler?: GateScheduler;
}

/* ========================================================================== */
/*  Public shapes                                                              */
/* ========================================================================== */

export type GateOutcome = 'APPROVED' | 'DENIED' | 'EXPIRED';

export interface GateResolution {
  readonly outcome: GateOutcome;
  readonly approval: ApprovalRequest;
  /** True ONLY for APPROVED. The one field a caller must check before proceeding. */
  readonly proceed: boolean;
  /** A sentence fit to show a person. Never contains a path outside the root. */
  readonly reason: string;
}

export interface GateRequestInput {
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

/**
 * The handle `open` returns. `approval` is the request as it was persisted — its
 * `id` is what the owner approves through the UI — and `settled` is the promise
 * that resolves on a real verdict or expiry.
 */
export interface PendingApproval {
  readonly approval: ApprovalRequest;
  readonly settled: Promise<GateResolution>;
}

export interface GuardActionInput {
  /** The structured intent to classify. */
  readonly action: ProposedAction;
  readonly projectId: string;
  readonly runId?: string | null;
  readonly requestedBy: string;
  readonly operation: string;
  readonly affects: readonly string[];
  readonly rollbackPlan: string;
  /** Owner-facing label; defaults to the policy's summary when omitted. */
  readonly label?: string;
  readonly ttlMs?: number;
  readonly evidenceRefs?: readonly EvidenceRef[];
}

export interface GuardResult {
  /** True for a non-gated action and for an APPROVED gated one; false otherwise. */
  readonly proceed: boolean;
  /** Whether an approval was required at all. */
  readonly gated: boolean;
  readonly decision: PolicyDecision;
  /** Present exactly when `gated` is true. */
  readonly resolution: GateResolution | null;
}

export interface ResolveInput {
  readonly approvalId: string;
  readonly verdict: 'APPROVED' | 'DENIED';
  /** Who decided. Recorded in the `approval.resolved` event, which is the audit trail. */
  readonly resolvedBy: string;
  readonly note?: string;
}

export type GateErrorCode = 'NOT_FOUND' | 'UNREADABLE' | 'NOT_PENDING' | 'ILLEGAL_TRANSITION' | 'DISPOSED';

export class GateError extends Error {
  readonly code: GateErrorCode;
  constructor(code: GateErrorCode, message: string) {
    super(message);
    this.name = 'GateError';
    this.code = code;
    Object.setPrototypeOf(this, GateError.prototype);
  }
}

/* ========================================================================== */
/*  Internal waiter state                                                      */
/* ========================================================================== */

interface Settler {
  readonly resolve: (r: GateResolution) => void;
  readonly reject: (e: Error) => void;
}

interface WaiterGroup {
  readonly approvalId: string;
  readonly settlers: Settler[];
  pollHandle: GateTimer | null;
  ttlHandle: GateTimer | null;
  settled: boolean;
}

/* ========================================================================== */
/*  The gate                                                                   */
/* ========================================================================== */

export class ApprovalGate {
  private readonly io: GateIo;
  private readonly pollIntervalMs: number;
  private readonly scheduler: GateScheduler;
  private readonly groups = new Map<string, WaiterGroup>();
  private disposed = false;

  constructor(io: GateIo, options: GateOptions = {}) {
    this.io = io;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.scheduler = options.scheduler ?? nodeScheduler;
  }

  /* ------------------------------------------------------------ requesting */

  /**
   * Open a request and return a promise that resolves only on a real verdict or
   * expiry. This is the method the run lifecycle awaits.
   */
  requestApproval(input: GateRequestInput): Promise<GateResolution> {
    return this.open(input).settled;
  }

  /**
   * Open a request and hand back BOTH the persisted record (so the caller knows
   * the id the owner will approve) and the settling promise. `requestApproval` is
   * the common case; `open` is for callers that need the id up front.
   */
  open(input: GateRequestInput): PendingApproval {
    this.assertLive();
    const approval = this.persistRequest(input);

    let capturedResolve!: (r: GateResolution) => void;
    let capturedReject!: (e: Error) => void;
    const settled = new Promise<GateResolution>((res, rej) => {
      capturedResolve = res;
      capturedReject = rej;
    });

    this.enroll(approval, { resolve: capturedResolve, reject: capturedReject });
    // If the record is already terminal (a reused request that has since been
    // resolved or expired), settle immediately rather than waiting for a tick.
    this.evaluate(approval.id);
    return { approval, settled };
  }

  /**
   * Classify a structured action and, if the policy requires it, block on an
   * owner verdict. A non-gated action returns `proceed: true` with no request
   * opened — and is NOT reported as "approved", because nobody approved it.
   */
  async guard(input: GuardActionInput): Promise<GuardResult> {
    this.assertLive();
    const decision = classifyAction(input.action);
    if (!decision.requiresApproval) {
      return { proceed: true, gated: false, decision, resolution: null };
    }
    const resolution = await this.requestApproval({
      projectId: input.projectId,
      runId: input.runId ?? null,
      requestedBy: input.requestedBy,
      action: input.label ?? decision.summary,
      operation: input.operation,
      affects: input.affects,
      risk: decision.risk,
      reason: decision.reason,
      rollbackPlan: input.rollbackPlan,
      ttlMs: input.ttlMs,
      evidenceRefs: input.evidenceRefs,
    });
    return { proceed: resolution.proceed, gated: true, decision, resolution };
  }

  /* ------------------------------------------------------------- resolving */

  /**
   * Record the owner's decision and settle any waiter. This is the gate's own
   * resolution path; the existing `approveAction` / `denyAction` operations reach
   * the same outcome by writing the record, which the gate then observes.
   *
   * Refuses loudly when the request is not PENDING — a denial or an expiry is
   * final, and asking again means a NEW request with a NEW id.
   */
  resolve(input: ResolveInput): GateResolution {
    this.assertLive();
    const read = this.readApproval(input.approvalId);
    if (!read.ok) throw read.error;
    const current = read.approval;

    if (current.state !== 'PENDING') {
      throw new GateError(
        'NOT_PENDING',
        `Approval ${current.id} is already ${current.state}; that outcome is final. Open a new request.`,
      );
    }

    try {
      assertPermissionTransition('PENDING', input.verdict);
    } catch (error) {
      throw new GateError('ILLEGAL_TRANSITION', `That verdict is not a legal move for approval ${current.id}: ${errorText(error)}`);
    }

    const resolved: ApprovalRequest = { ...current, state: input.verdict, resolvedAt: this.io.now().toISOString() };
    this.persist(resolved);
    this.emitResolved(resolved, input.resolvedBy, input.note ?? null);

    const resolution = toResolution(resolved);
    const group = this.groups.get(resolved.id);
    if (group !== undefined) this.settleGroup(group, resolution, null);
    return resolution;
  }

  /**
   * Re-check one request against the store now. The integration calls this after
   * an operation records a verdict, to unblock the waiter immediately instead of
   * on the next poll; a test calls it after advancing the clock to force expiry.
   */
  notify(approvalId: string): void {
    if (this.disposed) return;
    this.evaluate(approvalId);
  }

  /** The ids of requests currently blocking a caller. For diagnostics. */
  pending(): readonly string[] {
    return [...this.groups.keys()];
  }

  /**
   * Stop the gate. In-flight waiters are REJECTED — the safe outcome, because a
   * rejected await aborts the action — while their PENDING records stay on disk
   * for the next bridge instance to resolve. Nothing is silently approved.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const group of [...this.groups.values()]) {
      if (group.pollHandle !== null) this.scheduler.clear(group.pollHandle);
      if (group.ttlHandle !== null) this.scheduler.clear(group.ttlHandle);
      if (group.settled) continue;
      group.settled = true;
      const error = new GateError(
        'DISPOSED',
        'the approval gate was disposed before a verdict was recorded; the pending request remains on disk',
      );
      for (const settler of group.settlers) settler.reject(error);
    }
    this.groups.clear();
  }

  /* -------------------------------------------------------------- internals */

  private persistRequest(input: GateRequestInput): ApprovalRequest {
    const runId = input.runId ?? null;

    const existing = this.findLivePending(input.projectId, runId, input.operation, input.action);
    if (existing !== undefined) return existing;

    const now = this.io.now();
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

    this.persist(approval);
    this.emitRequested(approval, ttl, input.evidenceRefs ?? []);
    return approval;
  }

  /**
   * Reuse the one live PENDING request for exactly this action, if it exists.
   * A UI that polls a gated operation would otherwise mint a new request every
   * few seconds, and an owner facing forty identical cards approves one at random.
   */
  private findLivePending(
    projectId: string,
    runId: string | null,
    operation: string,
    action: string,
  ): ApprovalRequest | undefined {
    const listed = this.io.store.listRecords('approval');
    let best: ApprovalRequest | undefined;
    for (const record of listed.records) {
      if (record.state !== 'PENDING') continue;
      if (record.projectId !== projectId) continue;
      if (record.runId !== runId) continue;
      if (record.operation !== operation) continue;
      if (record.action !== action) continue;
      if (this.isExpired(record)) continue;
      if (best === undefined || record.requestedAt > best.requestedAt) best = record;
    }
    return best;
  }

  private enroll(approval: ApprovalRequest, settler: Settler): void {
    let group = this.groups.get(approval.id);
    if (group === undefined) {
      group = { approvalId: approval.id, settlers: [], pollHandle: null, ttlHandle: null, settled: false };
      this.groups.set(approval.id, group);
      this.arm(group, approval);
    }
    group.settlers.push(settler);
  }

  private arm(group: WaiterGroup, approval: ApprovalRequest): void {
    if (this.pollIntervalMs > 0) {
      group.pollHandle = this.scheduler.set(() => this.onPoll(group.approvalId), this.pollIntervalMs);
    }
    const untilExpiry = Math.max(0, this.msUntilExpiry(approval));
    group.ttlHandle = this.scheduler.set(() => this.evaluate(group.approvalId), untilExpiry);
  }

  private onPoll(approvalId: string): void {
    const group = this.groups.get(approvalId);
    if (group === undefined || group.settled) return;
    this.evaluate(approvalId);
    const still = this.groups.get(approvalId);
    if (still !== undefined && !still.settled && this.pollIntervalMs > 0) {
      still.pollHandle = this.scheduler.set(() => this.onPoll(approvalId), this.pollIntervalMs);
    }
  }

  /**
   * The single choke point. Read the record, expire it if its deadline has
   * passed, and settle the waiter once the record is terminal — never before.
   */
  private evaluate(approvalId: string): void {
    const group = this.groups.get(approvalId);
    if (group === undefined || group.settled) return;

    const read = this.readApproval(approvalId);
    if (!read.ok) {
      this.settleGroup(group, null, read.error);
      return;
    }

    let approval = read.approval;
    if (approval.state === 'PENDING') {
      if (!this.isExpired(approval)) return; // still genuinely pending — keep waiting
      approval = this.expire(approval);
    }
    this.settleGroup(group, toResolution(approval), null);
  }

  private expire(approval: ApprovalRequest): ApprovalRequest {
    // PERSIST the move the moment it is known, and lean on the state machine so
    // EXPIRED can never later be walked back to APPROVED.
    assertPermissionTransition('PENDING', 'EXPIRED');
    const expired: ApprovalRequest = { ...approval, state: 'EXPIRED', resolvedAt: this.io.now().toISOString() };
    this.persist(expired);
    this.emitResolved(expired, null, `no verdict was given before ${approval.expiresAt}; the request expired unanswered`);
    return expired;
  }

  private settleGroup(group: WaiterGroup, resolution: GateResolution | null, error: Error | null): void {
    if (group.settled) return;
    group.settled = true;
    if (group.pollHandle !== null) this.scheduler.clear(group.pollHandle);
    if (group.ttlHandle !== null) this.scheduler.clear(group.ttlHandle);
    this.groups.delete(group.approvalId);
    for (const settler of group.settlers) {
      if (resolution !== null) settler.resolve(resolution);
      else settler.reject(error ?? new GateError('UNREADABLE', 'the approval could not be resolved'));
    }
  }

  private readApproval(
    id: string,
  ): { readonly ok: true; readonly approval: ApprovalRequest } | { readonly ok: false; readonly error: GateError } {
    let read;
    try {
      read = this.io.store.getRecord('approval', id);
    } catch (error) {
      return { ok: false, error: new GateError('NOT_FOUND', `not a usable approval id: ${errorText(error)}`) };
    }
    if (!read.ok) {
      return read.reason === 'MISSING'
        ? { ok: false, error: new GateError('NOT_FOUND', `No approval is recorded with id ${id}.`) }
        : { ok: false, error: new GateError('UNREADABLE', `Approval ${id} could not be read (${read.reason}): ${read.detail}`) };
    }
    return { ok: true, approval: read.record };
  }

  private persist(approval: ApprovalRequest): void {
    this.io.store.saveRecord('approval', approval);
  }

  private isExpired(approval: ApprovalRequest): boolean {
    const deadline = Date.parse(approval.expiresAt);
    // An unparseable deadline cannot be shown to be still open, and "cannot be
    // shown to be open" is the safe reading for a permission.
    if (!Number.isFinite(deadline)) return true;
    return deadline <= this.io.now().getTime();
  }

  private msUntilExpiry(approval: ApprovalRequest): number {
    const deadline = Date.parse(approval.expiresAt);
    if (!Number.isFinite(deadline)) return 0;
    return deadline - this.io.now().getTime();
  }

  private assertLive(): void {
    if (this.disposed) throw new GateError('DISPOSED', 'the approval gate has been disposed');
  }

  /* ------------------------------------------------------------------ events */

  private emitRequested(approval: ApprovalRequest, ttlMs: number, evidenceRefs: readonly EvidenceRef[]): void {
    this.emit('approval.requested', approval, { ttlMs }, [recordRef(approval.id), ...evidenceRefs]);
  }

  private emitResolved(approval: ApprovalRequest, resolvedBy: string | null, note: string | null): void {
    this.emit('approval.resolved', approval, { verdict: approval.state, resolvedBy, note }, [
      recordRef(approval.id),
      { kind: 'verdict', ref: `approval:${approval.id}`, note: `${approval.state}${resolvedBy ? ` by ${resolvedBy}` : ''}` },
    ]);
  }

  private emit(
    type: 'approval.requested' | 'approval.resolved',
    approval: ApprovalRequest,
    extra: Record<string, unknown>,
    evidenceRefs: readonly EvidenceRef[],
  ): void {
    const sink = this.io.events;
    if (sink === null) return;
    const base: AppendEventInput<Record<string, unknown>> = {
      projectId: approval.projectId,
      runId: approval.runId,
      source: 'user',
      type,
      payload: { ...approvalPayload(approval), ...extra },
      evidenceRefs,
    };
    const input: AppendEventInput<Record<string, unknown>> =
      approval.state === 'PENDING' ? { ...base, status: 'WAITING_FOR_PERMISSION' } : base;
    try {
      sink.publish(input);
    } catch {
      // The record is already on disk; a failed event append must not be turned
      // into a false "the approval failed".
    }
  }
}

/* ========================================================================== */
/*  Pure helpers                                                               */
/* ========================================================================== */

function toResolution(approval: ApprovalRequest): GateResolution {
  switch (approval.state) {
    case 'APPROVED':
      return { outcome: 'APPROVED', approval, proceed: true, reason: `Approved at ${approval.resolvedAt ?? 'an unrecorded time'}.` };
    case 'DENIED':
      return {
        outcome: 'DENIED',
        approval,
        proceed: false,
        reason: `Denied at ${approval.resolvedAt ?? 'an unrecorded time'}. A denial is final; a new request is required.`,
      };
    case 'EXPIRED':
      return {
        outcome: 'EXPIRED',
        approval,
        proceed: false,
        reason: `The request expired at ${approval.expiresAt} without a verdict. An expired request is never an approval.`,
      };
    case 'PENDING':
      // Not reachable: the gate only builds a resolution from a terminal record.
      throw new GateError('NOT_PENDING', `internal: a resolution was built from PENDING approval ${approval.id}`);
  }
}

function approvalPayload(approval: ApprovalRequest): Record<string, unknown> {
  return {
    approvalId: approval.id,
    projectId: approval.projectId,
    runId: approval.runId,
    requestedBy: approval.requestedBy,
    action: approval.action,
    operation: approval.operation,
    affects: approval.affects,
    risk: approval.risk,
    reason: approval.reason,
    rollbackPlan: approval.rollbackPlan,
    requestedAt: approval.requestedAt,
    expiresAt: approval.expiresAt,
    state: approval.state,
    resolvedAt: approval.resolvedAt,
  };
}

function recordRef(approvalId: string): EvidenceRef {
  return { kind: 'file', ref: `records/approval/${approvalId}.json`, note: 'the approval record as written' };
}

function clampTtl(ttlMs: number | undefined): number {
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs)) return DEFAULT_APPROVAL_TTL_MS;
  return Math.min(MAX_APPROVAL_TTL_MS, Math.max(MIN_APPROVAL_TTL_MS, Math.floor(ttlMs)));
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}
