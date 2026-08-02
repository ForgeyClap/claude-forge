/**
 * Forge Workspace — the operation router.
 *
 * Everything the browser is allowed to ask for arrives here, and nothing else
 * can. The router's job is to turn an untrusted JSON blob into either a typed
 * result or a typed error, and to leave a record that it happened.
 *
 * Four properties this file holds:
 *
 *  1. ALLOWLIST, NOT PARSER. `op` is checked against `OPERATIONS` from the
 *     contract before anything else happens. A name that is not in that array
 *     gets `UNKNOWN_OPERATION` and never reaches a handler. There is no verb
 *     that takes a command string, and no handler receives raw text that is
 *     later interpreted as one.
 *
 *  2. VALIDATE BEFORE ACTING. Every handler validates its payload shape first
 *     and fails with a typed `OperationError`. Handlers do not throw past the
 *     router; if one does anyway, `dispatch` catches it and converts it, because
 *     a client that gets a dropped socket instead of an error learns nothing.
 *
 *  3. IDEMPOTENT BY `requestId`. A retried request returns the FIRST response,
 *     it does not execute again. A retry that arrives while the original is
 *     still running joins the same promise rather than starting a second run.
 *     Without this, a flaky socket turns one `createProject` into three.
 *
 *  4. AUDITED. Every dispatch appends one line to the audit ledger: when, which
 *     operation, which project, which client, and what the outcome was. Payloads
 *     are NOT written — they carry user prose and could carry a secret. The
 *     ledger answers "what was asked of this bridge", not "what was in it".
 *
 * The router owns only the handful of operations that are genuinely the
 * bridge's own: health, declarations, event reads, checkpoints, diagnostics,
 * and usage — which is read back out of the same persisted event log.
 * Everything else in the contract is registered by the work package that owns
 * it. An operation with no handler returns an honest error saying exactly that
 * — it is never quietly reported as success, and never faked.
 */

import { join } from 'node:path';
import process from 'node:process';

import {
  INVARIANT_DECLARATIONS,
  OPERATIONS,
  PROTOCOL_SCHEMA_VERSION,
  REQUIRED_BIND_ADDRESS,
} from '../shared/protocol.ts';
import type {
  BridgeHealth,
  ClaudeCodeStatus,
  EventType,
  OperationError,
  OperationErrorCode,
  OperationName,
  OperationResponse,
  RuntimeDeclarations,
} from '../shared/protocol.ts';
import { explainDeclarations } from '../shared/declarations.ts';

import { assembleBridgeHealth, computeDeclarations, observeProjectsRoot } from './health.ts';
import type { BridgeRuntimeFacts, DeclarationSources } from './health.ts';
import { registerApprovalOperations } from './operations/approvals.ts';
import { registerArtifactOperations } from './operations/artifacts.ts';
import { registerAttachmentOperations } from './operations/attachments.ts';
import { registerConversationOperations } from './operations/conversations.ts';
import { registerFileOperations } from './operations/files.ts';
import { registerProjectOperations } from './operations/projects.ts';
import { registerRunOperations } from './operations/runs.ts';
import { registerTestOperations } from './operations/tests.ts';
import { UsageOperations } from './operations/usage.ts';
import { appendLineDurable, containedPath, ensureDir } from './storage/atomic.ts';
import { isLiveRunStatus } from './storage/schema.ts';
import type { CheckpointScope, CheckpointScopeKind } from './storage/schema.ts';
import { BRIDGE_PROJECT_ID } from './storage/store.ts';
import type { EventQuery, ForgeStore } from './storage/store.ts';
import type { BridgeConfig } from './config.ts';
import { describeConfig } from './config.ts';
import type { Transport } from './transport.ts';

/* ========================================================================== */
/*  Typed failure                                                              */
/* ========================================================================== */

/**
 * The only exception a handler should raise. It carries a contract error code,
 * so the router can convert it without guessing what went wrong.
 */
export class OperationFailure extends Error {
  readonly error: OperationError;

  constructor(error: OperationError) {
    super(error.message);
    this.name = 'OperationFailure';
    this.error = error;
    Object.setPrototypeOf(this, OperationFailure.prototype);
  }
}

export function fail(code: OperationErrorCode, message: string, detail?: string): never {
  throw new OperationFailure(detail === undefined ? { code, message } : { code, message, detail });
}

/* ========================================================================== */
/*  Payload validation helpers                                                 */
/* ========================================================================== */

/** Caps every string that crosses the boundary. Nothing here is a path. */
const MAX_ID_LENGTH = 128;
const MAX_NOTE_LENGTH = 512;

export function asObject(payload: unknown, what = 'payload'): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    fail('BAD_REQUEST', `${what} must be a JSON object.`);
  }
  return payload as Record<string, unknown>;
}

export function optString(
  obj: Record<string, unknown>,
  key: string,
  maxLength = MAX_ID_LENGTH,
): string | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') fail('BAD_REQUEST', `${key} must be a string.`);
  if (value.length > maxLength) fail('BAD_REQUEST', `${key} exceeds ${maxLength} characters.`);
  return value;
}

export function reqString(
  obj: Record<string, unknown>,
  key: string,
  maxLength = MAX_ID_LENGTH,
): string {
  const value = optString(obj, key, maxLength);
  if (value === undefined || value.length === 0) fail('BAD_REQUEST', `${key} is required.`);
  return value;
}

export function optInteger(
  obj: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    fail('BAD_REQUEST', `${key} must be a whole number.`);
  }
  if (value < min || value > max) fail('BAD_REQUEST', `${key} must be between ${min} and ${max}.`);
  return value;
}

export function optStringArray(
  obj: Record<string, unknown>,
  key: string,
  maxItems: number,
  maxLength = MAX_ID_LENGTH,
): readonly string[] | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) fail('BAD_REQUEST', `${key} must be an array of strings.`);
  if (value.length > maxItems) fail('BAD_REQUEST', `${key} may hold at most ${maxItems} entries.`);
  for (const entry of value) {
    if (typeof entry !== 'string') fail('BAD_REQUEST', `${key} must contain only strings.`);
    if (entry.length > maxLength) fail('BAD_REQUEST', `${key} contains an over-long entry.`);
  }
  return value as readonly string[];
}

/* ========================================================================== */
/*  Context and handlers                                                       */
/* ========================================================================== */

export type RequestTransport = 'http' | 'websocket' | 'internal';

export interface OperationContext {
  readonly requestId: string;
  readonly op: OperationName;
  readonly clientId: string | null;
  readonly transport: RequestTransport;
  readonly receivedAt: number;
  readonly store: ForgeStore;
  readonly events: Transport;
  readonly config: BridgeConfig;
  readonly bridgeInstanceId: string;
}

export type OperationHandler = (payload: unknown, ctx: OperationContext) => Promise<unknown> | unknown;

/**
 * What the bridge can prove about itself right now. Supplied by the server.
 *
 * Defined in `health.ts` and re-exported here so existing importers keep
 * working: the type is consumed by the health assembler, which is the only
 * thing that interprets it.
 */
export type { BridgeRuntimeFacts } from './health.ts';

export type ClaudeCodeProbe = () => ClaudeCodeStatus | Promise<ClaudeCodeStatus>;

/**
 * What the bridge reports about Claude Code when no adapter has registered a
 * probe. Note what it does NOT say: it does not claim Claude Code is missing.
 * It says the bridge has not checked, which is the only defensible statement.
 */
export function unprobedClaudeStatus(nowIso: string): ClaudeCodeStatus {
  return {
    available: false,
    executablePath: null,
    version: null,
    authenticated: false,
    lastCheckedAt: nowIso,
    supportedFlags: [],
    note:
      'UNVERIFIED — no Claude Code probe is registered with this bridge, so availability, version and ' +
      'authentication have not been checked. This is not a claim that Claude Code is absent.',
  };
}

/* ========================================================================== */
/*  Audit ledger                                                               */
/* ========================================================================== */

export interface AuditEntry {
  readonly ts: string;
  readonly bridgeInstanceId: string;
  readonly requestId: string;
  readonly op: string;
  readonly projectId: string | null;
  readonly clientId: string | null;
  readonly transport: RequestTransport;
  readonly outcome: 'OK' | 'ERROR' | 'REPLAYED' | 'REJECTED';
  readonly errorCode: OperationErrorCode | null;
  readonly durationMs: number;
}

/**
 * Strip control characters and cap length.
 *
 * A ledger line is evidence, and `requestId` is client-supplied. A newline
 * inside it would let a client write its own line into the ledger - a forged
 * audit record - so the value is cleaned before it is ever serialised.
 */
function ledgerSafe(value: unknown, maxLength = 128): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned;
}

/**
 * Append-only operation ledger.
 *
 * A write failure does not fail the operation — a full disk would otherwise
 * brick a local workspace — but it is counted and surfaced in diagnostics and as
 * a `bridge.degraded` event, so "the ledger is complete" is never assumed when
 * it is not true.
 */
export class AuditLedger {
  readonly path: string;
  private writes = 0;
  private failures = 0;
  private lastFailure: string | null = null;

  constructor(dataDir: string) {
    const dir = join(dataDir, 'audit');
    const safeDir = containedPath(dataDir, dir);
    if (safeDir === null) throw new Error('audit directory resolved outside the workspace data directory');
    ensureDir(safeDir);
    const file = join(safeDir, 'ledger.jsonl');
    const safeFile = containedPath(dataDir, file);
    if (safeFile === null) throw new Error('audit ledger resolved outside the workspace data directory');
    this.path = safeFile;
  }

  append(entry: AuditEntry): boolean {
    try {
      appendLineDurable(this.path, JSON.stringify(entry));
      this.writes += 1;
      return true;
    } catch (err) {
      this.failures += 1;
      this.lastFailure = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
      return false;
    }
  }

  stats(): { readonly path: string; readonly writes: number; readonly failures: number; readonly lastFailure: string | null } {
    return { path: this.path, writes: this.writes, failures: this.failures, lastFailure: this.lastFailure };
  }
}

/* ========================================================================== */
/*  Idempotency cache                                                          */
/* ========================================================================== */

interface CacheEntry {
  readonly op: OperationName;
  readonly at: number;
  readonly promise: Promise<OperationResponse>;
}

/* ========================================================================== */
/*  Router                                                                     */
/* ========================================================================== */

export interface RouterOptions {
  readonly store: ForgeStore;
  readonly events: Transport;
  readonly config: BridgeConfig;
  readonly bridgeInstanceId: string;
  readonly runtimeFacts: () => BridgeRuntimeFacts;
  readonly claudeProbe?: ClaudeCodeProbe;
  /**
   * Where the derived declarations get their evidence. Omitting a source means
   * that thing is NOT OBSERVED, which makes its declaration false and says so —
   * the router never fills a gap on a work package's behalf.
   */
  readonly declarationSources?: DeclarationSources;
  readonly now?: () => number;
}

export interface RouterStats {
  readonly dispatched: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly replayed: number;
  readonly cachedResponses: number;
  readonly registeredOperations: readonly OperationName[];
  readonly unregisteredOperations: readonly OperationName[];
  readonly audit: ReturnType<AuditLedger['stats']>;
}

const OPERATION_SET: ReadonlySet<string> = new Set<string>(OPERATIONS);

export class Router {
  private readonly store: ForgeStore;
  private readonly events: Transport;
  private readonly config: BridgeConfig;
  private readonly bridgeInstanceId: string;
  private readonly runtimeFacts: () => BridgeRuntimeFacts;
  private readonly now: () => number;
  private readonly ledger: AuditLedger;
  private readonly usageOps: UsageOperations;

  private claudeProbe: ClaudeCodeProbe | null;
  private declarationSources: DeclarationSources;
  private readonly handlers = new Map<OperationName, OperationHandler>();
  private readonly cache = new Map<string, CacheEntry>();

  private dispatched = 0;
  private succeeded = 0;
  private failed = 0;
  private replayed = 0;
  private ledgerDegradedAt = 0;

  constructor(options: RouterOptions) {
    this.store = options.store;
    this.events = options.events;
    this.config = options.config;
    this.bridgeInstanceId = options.bridgeInstanceId;
    this.runtimeFacts = options.runtimeFacts;
    this.now = options.now ?? (() => Date.now());
    this.claudeProbe = options.claudeProbe ?? null;
    this.declarationSources = options.declarationSources ?? {};
    this.ledger = new AuditLedger(options.store.dataDir);
    // Constructed once and held, so the declaration observer can read the same
    // rebuild the usage verbs serve rather than standing up a second aggregator
    // that would split the truth. See `usageOperations()`.
    this.usageOps = new UsageOperations({ store: this.store, now: this.now });
    this.registerBuiltins();
  }

  /* -------------------------------------------------------------- registry */

  /**
   * Attach a handler for one contract operation.
   *
   * Refuses a name the contract does not define, and refuses to silently
   * displace an existing handler — two work packages both claiming `sendMessage`
   * is a real conflict, and losing one of them without a word is how a
   * capability disappears between builds.
   */
  register(op: OperationName, handler: OperationHandler, options?: { readonly override?: boolean }): void {
    if (!OPERATION_SET.has(op)) {
      throw new Error(`cannot register a handler for "${op}": it is not in the contract's OPERATIONS`);
    }
    if (this.handlers.has(op) && options?.override !== true) {
      throw new Error(`a handler for "${op}" is already registered; pass { override: true } to replace it`);
    }
    this.handlers.set(op, handler);
  }

  registered(op: OperationName): boolean {
    return this.handlers.has(op);
  }

  setClaudeProbe(probe: ClaudeCodeProbe): void {
    this.claudeProbe = probe;
  }

  /**
   * Attach or replace the evidence sources the derived declarations read.
   *
   * Merged rather than swapped, so a work package can register the one source it
   * owns without knowing what else is already wired. A source that is not
   * supplied stays unobserved, and its declaration stays false.
   */
  setDeclarationSources(sources: DeclarationSources): void {
    this.declarationSources = { ...this.declarationSources, ...sources };
  }

  /**
   * The bridge's own usage operations.
   *
   * Exposed so the `USES_REAL_USAGE_TELEMETRY` observer wired in main.ts reads
   * this instance's rebuild — the same one `getUsageState`/`getUsageHistory`
   * answer from — instead of constructing a second aggregator whose cache could
   * disagree with the numbers on the screen.
   */
  usageOperations(): UsageOperations {
    return this.usageOps;
  }

  /* -------------------------------------------------------------- dispatch */

  /**
   * The single entry point. `raw` is whatever arrived over HTTP or the socket:
   * assumed hostile, validated field by field.
   */
  async dispatch(raw: unknown, transport: RequestTransport, clientId: string | null): Promise<OperationResponse> {
    const receivedAt = this.now();

    // The requestId is needed to answer at all, so it is extracted before the
    // rest of the envelope is trusted.
    const envelope = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
    const requestIdRaw = envelope?.requestId;
    const requestId =
      typeof requestIdRaw === 'string' && requestIdRaw.length > 0 && requestIdRaw.length <= 128
        ? requestIdRaw
        : null;

    if (envelope === null) {
      return this.reject(requestId ?? 'unknown', 'unknown', transport, clientId, receivedAt, {
        code: 'BAD_REQUEST',
        message: 'Request must be a JSON object.',
      });
    }
    if (requestId === null) {
      return this.reject('unknown', 'unknown', transport, clientId, receivedAt, {
        code: 'BAD_REQUEST',
        message: 'requestId is required and must be a string of 1..128 characters.',
      });
    }

    const opRaw = envelope.op;
    if (typeof opRaw !== 'string' || !OPERATION_SET.has(opRaw)) {
      return this.reject(requestId, typeof opRaw === 'string' ? opRaw : 'unknown', transport, clientId, receivedAt, {
        code: 'UNKNOWN_OPERATION',
        message: 'That operation is not part of the bridge contract.',
        detail: typeof opRaw === 'string' ? opRaw.slice(0, 64) : typeof opRaw,
      });
    }
    const op = opRaw as OperationName;

    const schemaVersion = envelope.schemaVersion;
    if (schemaVersion !== PROTOCOL_SCHEMA_VERSION) {
      return this.reject(requestId, op, transport, clientId, receivedAt, {
        code: 'SCHEMA_MISMATCH',
        message: `This bridge speaks protocol schema version ${PROTOCOL_SCHEMA_VERSION}.`,
        detail: `received ${JSON.stringify(schemaVersion)}`,
      });
    }

    this.pruneCache(receivedAt);

    const cached = this.cache.get(requestId);
    if (cached !== undefined) {
      if (cached.op !== op) {
        // The same id used for two different operations. Returning the cached
        // answer would answer the wrong question; executing would break the
        // idempotency guarantee the id exists to provide.
        return this.reject(requestId, op, transport, clientId, receivedAt, {
          code: 'CONFLICT',
          message: 'That requestId was already used for a different operation.',
          detail: `first seen as ${cached.op}`,
        });
      }
      this.replayed += 1;
      const response = await cached.promise;
      this.writeAudit({
        requestId,
        op,
        projectId: this.projectIdOf(envelope.payload),
        clientId,
        transport,
        outcome: 'REPLAYED',
        errorCode: response.ok ? null : response.error.code,
        durationMs: this.now() - receivedAt,
      });
      return response;
    }

    const promise = this.execute(requestId, op, envelope.payload, transport, clientId, receivedAt);
    this.cache.set(requestId, { op, at: receivedAt, promise });
    return promise;
  }

  private async execute(
    requestId: string,
    op: OperationName,
    payload: unknown,
    transport: RequestTransport,
    clientId: string | null,
    receivedAt: number,
  ): Promise<OperationResponse> {
    this.dispatched += 1;
    const handler = this.handlers.get(op);

    if (handler === undefined) {
      // In the contract, but nothing implements it in this build. Saying so
      // plainly is the whole point: a stub that returned an empty success would
      // make the UI render "no projects" when the truth is "not wired up".
      const error: OperationError = {
        code: 'RUNTIME_ERROR',
        message: `The operation "${op}" is defined by the contract but no handler is registered in this build.`,
        detail: 'UNIMPLEMENTED — the bridge did not attempt it and cannot report a result.',
      };
      this.failed += 1;
      this.writeAudit({
        requestId,
        op,
        projectId: this.projectIdOf(payload),
        clientId,
        transport,
        outcome: 'ERROR',
        errorCode: error.code,
        durationMs: this.now() - receivedAt,
      });
      return { requestId, ok: false, error };
    }

    const ctx: OperationContext = {
      requestId,
      op,
      clientId,
      transport,
      receivedAt,
      store: this.store,
      events: this.events,
      config: this.config,
      bridgeInstanceId: this.bridgeInstanceId,
    };

    let response: OperationResponse;
    try {
      const result = await handler(payload, ctx);
      response = { requestId, ok: true, result };
      this.succeeded += 1;
    } catch (err) {
      response = { requestId, ok: false, error: toOperationError(err) };
      this.failed += 1;
    }

    this.writeAudit({
      requestId,
      op,
      projectId: this.projectIdOf(payload),
      clientId,
      transport,
      outcome: response.ok ? 'OK' : 'ERROR',
      errorCode: response.ok ? null : response.error.code,
      durationMs: this.now() - receivedAt,
    });
    return response;
  }

  private reject(
    requestId: string,
    op: string,
    transport: RequestTransport,
    clientId: string | null,
    receivedAt: number,
    error: OperationError,
  ): OperationResponse {
    this.dispatched += 1;
    this.failed += 1;
    this.writeAudit({
      requestId,
      op,
      projectId: null,
      clientId,
      transport,
      outcome: 'REJECTED',
      errorCode: error.code,
      durationMs: this.now() - receivedAt,
    });
    return { requestId, ok: false, error };
  }

  /* ----------------------------------------------------------------- audit */

  private writeAudit(input: {
    requestId: string;
    op: string;
    projectId: string | null;
    clientId: string | null;
    transport: RequestTransport;
    outcome: AuditEntry['outcome'];
    errorCode: OperationErrorCode | null;
    durationMs: number;
  }): void {
    const entry: AuditEntry = {
      ts: new Date(this.now()).toISOString(),
      bridgeInstanceId: this.bridgeInstanceId,
      requestId: ledgerSafe(input.requestId) ?? 'unknown',
      op: ledgerSafe(input.op, 64) ?? 'unknown',
      projectId: ledgerSafe(input.projectId),
      clientId: ledgerSafe(input.clientId),
      transport: input.transport,
      outcome: input.outcome,
      errorCode: input.errorCode,
      durationMs: input.durationMs,
    };
    if (this.ledger.append(entry)) return;

    // The ledger is the evidence that an operation happened. Losing a line is a
    // real loss of fidelity, so it is reported as one — rate limited, because a
    // failing disk fails every line.
    const now = this.now();
    if (now - this.ledgerDegradedAt < 30_000) return;
    this.ledgerDegradedAt = now;
    try {
      this.events.publish({
        projectId: BRIDGE_PROJECT_ID,
        runId: null,
        source: 'bridge',
        type: 'bridge.degraded',
        status: 'DEGRADED',
        payload: {
          scope: 'audit-ledger',
          reason: 'audit.write-failed',
          detail: `an audit ledger line could not be written; the ledger is incomplete from ${entry.ts}`,
          lastFailure: this.ledger.stats().lastFailure,
        },
        evidenceRefs: [{ kind: 'file', ref: 'audit/ledger.jsonl' }],
      });
    } catch {
      // The event log is unwritable too. There is nowhere left to record this
      // honestly; the counters in `stats()` remain the only signal.
    }
  }

  /**
   * Best-effort project id for the ledger. Ids are not secrets; payload contents
   * are, so nothing else is read out of the payload here.
   */
  private projectIdOf(payload: unknown): string | null {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
    const value = (payload as Record<string, unknown>).projectId;
    return typeof value === 'string' ? ledgerSafe(value) : null;
  }

  /* ----------------------------------------------------------------- cache */

  private pruneCache(now: number): void {
    for (const [key, entry] of this.cache) {
      if (now - entry.at > this.config.requestCacheMs) this.cache.delete(key);
    }
    if (this.cache.size <= this.config.requestCacheEntries) return;
    // Insertion order is chronological, so the first keys are the oldest.
    const excess = this.cache.size - this.config.requestCacheEntries;
    let removed = 0;
    for (const key of this.cache.keys()) {
      if (removed >= excess) break;
      this.cache.delete(key);
      removed += 1;
    }
  }

  /* ----------------------------------------------------------------- stats */

  stats(): RouterStats {
    const registered: OperationName[] = [];
    const missing: OperationName[] = [];
    for (const op of OPERATIONS) {
      if (this.handlers.has(op)) registered.push(op);
      else missing.push(op);
    }
    return {
      dispatched: this.dispatched,
      succeeded: this.succeeded,
      failed: this.failed,
      replayed: this.replayed,
      cachedResponses: this.cache.size,
      registeredOperations: registered,
      unregisteredOperations: missing,
      audit: this.ledger.stats(),
    };
  }

  /* -------------------------------------------------------------- builtins */

  private registerBuiltins(): void {
    this.register('getHealth', () => this.health());
    this.register('getDeclarations', () => this.declarations());
    this.register('listEvents', (payload) => this.listEvents(payload));
    this.register('replayEvents', (payload) => this.replayEvents(payload));
    this.register('listCheckpoints', (payload) => this.listCheckpoints(payload));
    this.register('createCheckpoint', (payload) => this.createCheckpoint(payload));
    this.register('exportDiagnostics', () => this.diagnostics());

    // Usage is read out of the same persisted event log the operations above
    // serve, and needs nothing from Claude Code or from a project, so it belongs
    // to the bridge rather than to a work package. It holds no telemetry state of
    // its own: every answer is rebuilt from disk, which is what makes a restart
    // lose nothing and invent nothing.
    const usage = this.usageOps;
    this.register('getUsageState', (payload) => usage.getUsageState(payload));
    this.register('getUsageHistory', (payload) => usage.getUsageHistory(payload));

    // Attachments and project files. Both reach the disk, so both resolve a
    // project through the registry and put every path through the guard before
    // touching anything; neither holds state between requests except the
    // bounded, in-memory buffer a chunked upload needs while it is arriving.
    registerAttachmentOperations(this);
    registerFileOperations(this);

    // Projects: the canonical index, the real New Project flow and the doctor.
    // Registered here because every other work package resolves a project by id
    // through the same registry, so the index must exist for any of them to be
    // reachable. `createProject` returns its receipt rather than a boolean, and
    // `archiveProject` deletes nothing — see operations/projects.ts.
    registerProjectOperations(this);

    // Artifacts, quality gates, proof and owner approvals.
    //
    // Approvals go first because the other two gate on them: `inspectArtifact`
    // will not read a restricted file and `runApprovedTest` will not spawn a
    // HIGH-risk gate until a real verdict exists on disk. `runApprovedTest`
    // takes an allowlist KEY and there is no payload shape on this bridge that
    // accepts a command string — see operations/tests.ts.
    registerApprovalOperations(this);
    registerArtifactOperations(this);
    registerTestOperations(this);

    // Conversations, then runs. The order is the dependency: a run resolves its
    // conversation through the same service the conversation verbs use, so the
    // two always agree about which project a conversation belongs to — which is
    // the check that keeps one project's Claude session out of another's.
    //
    // `sendMessage` is the only path in the bridge that starts a process. It
    // locates Claude Code lazily, on the first message, so a workspace with no
    // runtime installed still serves every other operation and says
    // CLAUDE_UNAVAILABLE for exactly the one that needs it — see
    // operations/runs.ts.
    registerConversationOperations(this);
    registerRunOperations(this);
  }

  /** The health snapshot. Every field is measured, not assumed. */
  async health(): Promise<BridgeHealth> {
    const facts = this.runtimeFacts();
    const nowIso = new Date(this.now()).toISOString();

    let claudeCode: ClaudeCodeStatus;
    if (this.claudeProbe === null) {
      claudeCode = unprobedClaudeStatus(nowIso);
    } else {
      try {
        claudeCode = await this.claudeProbe();
      } catch (err) {
        claudeCode = {
          available: false,
          executablePath: null,
          version: null,
          authenticated: false,
          lastCheckedAt: nowIso,
          supportedFlags: [],
          note: `UNVERIFIED — the registered Claude Code probe failed: ${
            err instanceof Error ? err.message.slice(0, 160) : 'unknown error'
          }`,
        };
      }
    }

    // Every one of these is measured on this call. The projects root in
    // particular is re-checked rather than cached: the folder can be created or
    // deleted while the bridge runs, and a stale `true` would be a false claim
    // about the user's disk.
    const runs = this.store.listRecords('run');
    const storeStats = this.store.stats();
    const transportStats = this.events.stats();
    const routerStats = this.stats();

    return assembleBridgeHealth({
      nowMs: this.now(),
      facts,
      claudeCode,
      claudeProbeRegistered: this.claudeProbe !== null,
      declarations: this.declarationReport(),
      projectsRoot: observeProjectsRoot(),
      store: storeStats,
      activeRuns: runs.records.filter((r) => isLiveRunStatus(r.status)).length,
      unreadableRuns: runs.unreadable.length,
      connectedClients: transportStats.connectedClients,
      controlEventsDropped: transportStats.controlEventsDropped,
      unregisteredOperations: routerStats.unregisteredOperations.length,
      auditFailures: routerStats.audit.failures,
    });
  }

  /**
   * The declarations as they stand right now.
   *
   * Derived, not stored. The invariants come from the contract; the eight
   * claims about the live system are recomputed from whatever the registered
   * sources can currently observe, so a caller cannot receive a positive claim
   * that has gone out of date since the process started.
   */
  declarationReport(): RuntimeDeclarations {
    return computeDeclarations(this.declarationSources, this.now());
  }

  /**
   * The declarations, plus a check that the running process actually matches
   * the invariants. A declaration that is never compared to reality is just a
   * comment — and the derived half carries its own evidence, so `explain` is
   * what a screen renders when it has to say why something is not connected.
   */
  declarations(): Record<string, unknown> {
    const facts = this.runtimeFacts();
    const report = this.declarationReport();
    const mismatches: string[] = [];
    if (INVARIANT_DECLARATIONS.BIND_ADDRESS !== this.config.bindAddress) {
      mismatches.push(
        `declared BIND_ADDRESS ${INVARIANT_DECLARATIONS.BIND_ADDRESS} != configured ${this.config.bindAddress}`,
      );
    }
    if (facts.boundAddress !== null && facts.boundAddress !== INVARIANT_DECLARATIONS.BIND_ADDRESS) {
      mismatches.push(
        `declared BIND_ADDRESS ${INVARIANT_DECLARATIONS.BIND_ADDRESS} != actually bound ${facts.boundAddress}`,
      );
    }
    if (INVARIANT_DECLARATIONS.LAN_MODE !== this.config.lanMode) {
      mismatches.push('declared LAN_MODE != configured lanMode');
    }
    if (INVARIANT_DECLARATIONS.REMOTE_ACCESS !== this.config.remoteAccess) {
      mismatches.push('declared REMOTE_ACCESS != configured remoteAccess');
    }
    return {
      declarations: report,
      explain: explainDeclarations(report),
      protocolSchemaVersion: PROTOCOL_SCHEMA_VERSION,
      verifiedAgainstRuntime: mismatches.length === 0,
      mismatches,
    };
  }

  private listEvents(payload: unknown): Record<string, unknown> {
    const body = asObject(payload);
    const query: {
      projectId?: string;
      runId?: string | null;
      streamKey?: string;
      fromSequence?: number;
      limit?: number;
      types?: readonly EventType[];
    } = {};

    const streamKey = optString(body, 'streamKey', 300);
    if (streamKey !== undefined) query.streamKey = streamKey;

    const projectId = optString(body, 'projectId');
    if (projectId !== undefined) query.projectId = projectId;

    if (Object.prototype.hasOwnProperty.call(body, 'runId')) {
      const runId = body.runId;
      if (runId === null) query.runId = null;
      else if (typeof runId === 'string' && runId.length > 0 && runId.length <= MAX_ID_LENGTH) query.runId = runId;
      else fail('BAD_REQUEST', 'runId must be a string or null.');
    }

    const fromSequence = optInteger(body, 'fromSequence', 1, Number.MAX_SAFE_INTEGER);
    if (fromSequence !== undefined) query.fromSequence = fromSequence;

    const limit = optInteger(body, 'limit', 1, 50_000);
    if (limit !== undefined) query.limit = limit;

    const types = optStringArray(body, 'types', 64, 64);
    if (types !== undefined) query.types = types as readonly EventType[];

    try {
      const page = this.store.readEvents(query as EventQuery);
      return {
        events: page.events,
        streams: page.streams,
        nextSequence: page.nextSequence,
        hasMore: page.hasMore,
        gaps: page.gaps,
        issues: page.issues,
      };
    } catch (err) {
      fail('BAD_REQUEST', 'The event query was rejected by the store.', err instanceof Error ? err.message.slice(0, 200) : undefined);
    }
  }

  /**
   * Replay one stream from a sequence.
   *
   * Distinct from `listEvents` in what it promises: it names the stream's head
   * and its gaps, so a reconnecting client can tell the difference between "you
   * have everything" and "these sequences will never arrive".
   */
  private replayEvents(payload: unknown): Record<string, unknown> {
    const body = asObject(payload);
    const streamKey = reqString(body, 'streamKey', 300);
    const fromSequence = optInteger(body, 'fromSequence', 1, Number.MAX_SAFE_INTEGER) ?? 1;
    const limit = optInteger(body, 'limit', 1, 5_000) ?? 1_000;

    try {
      const page = this.store.readEvents({ streamKey, fromSequence, limit });
      const report = page.gaps.find((g) => g.streamKey === streamKey);
      const events = page.events;
      return {
        streamKey,
        fromSequence,
        events,
        complete: !page.hasMore,
        nextSequence: events.length > 0 ? events[events.length - 1].sequence + 1 : fromSequence,
        head: report?.maxSequence ?? 0,
        gaps: report?.gaps ?? [],
        issues: page.issues,
      };
    } catch (err) {
      fail('BAD_REQUEST', 'The replay query was rejected by the store.', err instanceof Error ? err.message.slice(0, 200) : undefined);
    }
  }

  private parseScope(body: Record<string, unknown>, required: boolean): CheckpointScope | undefined {
    const raw = body.scope;
    if (raw === undefined || raw === null) {
      if (required) fail('BAD_REQUEST', 'scope is required.');
      return undefined;
    }
    const scope = asObject(raw, 'scope');
    const kind = reqString(scope, 'kind', 32);
    const kinds: readonly string[] = ['workspace', 'project', 'conversation', 'run'];
    if (!kinds.includes(kind)) {
      fail('BAD_REQUEST', `scope.kind must be one of ${kinds.join(', ')}.`);
    }
    const idRaw = scope.id;
    if (kind === 'workspace') {
      if (idRaw !== undefined && idRaw !== null) fail('BAD_REQUEST', 'the workspace scope must have a null id.');
      return { kind: 'workspace', id: null };
    }
    if (typeof idRaw !== 'string' || idRaw.length === 0 || idRaw.length > MAX_ID_LENGTH) {
      fail('BAD_REQUEST', `scope.id is required for the ${kind} scope.`);
    }
    return { kind: kind as CheckpointScopeKind, id: idRaw };
  }

  private listCheckpoints(payload: unknown): Record<string, unknown> {
    const body = asObject(payload);
    const scope = this.parseScope(body, false);
    const checkpoints = scope === undefined ? this.store.listCheckpoints() : this.store.listCheckpoints(scope);
    return { checkpoints, count: checkpoints.length };
  }

  private createCheckpoint(payload: unknown): Record<string, unknown> {
    const body = asObject(payload);
    const scope = this.parseScope(body, true);
    if (scope === undefined) fail('BAD_REQUEST', 'scope is required.');
    const note = optString(body, 'note', MAX_NOTE_LENGTH) ?? '';
    try {
      const checkpoint = this.store.createCheckpoint(scope, note);
      // `complete` is the store's own verdict about whether every in-scope
      // record could be read. It is passed through unchanged: a partial
      // checkpoint must never be presented as a full one.
      return { checkpoint, complete: checkpoint.complete };
    } catch (err) {
      fail(
        'RUNTIME_ERROR',
        'The checkpoint could not be created.',
        err instanceof Error ? err.message.slice(0, 300) : undefined,
      );
    }
  }

  /**
   * A diagnostics bundle.
   *
   * Deliberately absent: `process.env` in any form, any file contents, any
   * payload, any header. What is present is shape and counts — enough to debug
   * a stuck bridge, not enough to leak one.
   */
  private diagnostics(): Record<string, unknown> {
    const facts = this.runtimeFacts();
    const storeStats = this.store.stats();
    return {
      generatedAt: new Date(this.now()).toISOString(),
      bridgeInstanceId: this.bridgeInstanceId,
      runtime: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        pid: process.pid,
        uptimeMs: this.now() - facts.startedAtMs,
      },
      listener: {
        listening: facts.listening,
        boundAddress: facts.boundAddress,
        boundPort: facts.boundPort,
        requiredBindAddress: REQUIRED_BIND_ADDRESS,
        startedAt: facts.startedAt,
      },
      config: describeConfig(this.config),
      declarations: this.declarationReport(),
      store: storeStats,
      degradedNotes: this.store.degradedNotes(),
      transport: this.events.stats(),
      router: this.stats(),
    };
  }
}

/* ========================================================================== */
/*  Error conversion                                                           */
/* ========================================================================== */

/**
 * Turn anything a handler threw into a contract error.
 *
 * Path-guard errors already carry the right code and are passed through.
 * Anything else becomes `RUNTIME_ERROR` with a truncated message — an
 * unfiltered stack could carry an absolute path or, from a wrapped library
 * error, part of an environment value.
 */
export function toOperationError(err: unknown): OperationError {
  if (err instanceof OperationFailure) return err.error;

  if (typeof err === 'object' && err !== null) {
    const candidate = err as { name?: unknown; code?: unknown; message?: unknown; detail?: unknown };
    if (
      candidate.name === 'PathGuardError' &&
      (candidate.code === 'PATH_REJECTED' || candidate.code === 'OUTSIDE_TRUSTED_ROOT')
    ) {
      const base: OperationError = {
        code: candidate.code,
        message: typeof candidate.message === 'string' ? candidate.message.slice(0, 300) : 'Path rejected.',
      };
      return typeof candidate.detail === 'string' ? { ...base, detail: candidate.detail.slice(0, 300) } : base;
    }
  }

  return {
    code: 'RUNTIME_ERROR',
    message: 'The operation failed.',
    detail: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
  };
}
