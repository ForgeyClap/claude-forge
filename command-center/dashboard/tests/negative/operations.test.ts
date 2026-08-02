/**
 * Negative suite — operations (mission section F).
 *
 * Every case here asks a real bridge module to do something it must refuse, and
 * proves that the refusal is a TYPED error with the RIGHT code — never a crash,
 * never a silent success, never a plausible-looking green result.
 *
 * The modules are the real ones: the New Project flow (`projects/create.ts`),
 * the canonical index (`projects/registry.ts`), the path guard
 * (`security/paths.ts`), the attachment boundary (`attachments/pipeline.ts`),
 * the conversation and run services (`operations/conversations.ts`,
 * `operations/runs.ts`), the operation router (`router.ts`) and owner approvals
 * (`operations/approvals.ts`). Nothing is spawned: the run service is driven with
 * an injected `locate`/`adapterFactory`, and every rejection under test happens
 * before any child process would exist.
 *
 * Isolation is the same discipline the chaos suite uses: every workspace and
 * every projects root is an `mkdtemp` under the OS temp directory, passed
 * explicitly, so neither the repository's `.forge-workspace` nor any user
 * project is ever touched. A guard asserts it before anything runs.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { ForgeStore } from '../../src/bridge/storage/store.ts';
import { ProjectRegistry } from '../../src/bridge/projects/registry.ts';
import { createProject } from '../../src/bridge/projects/create.ts';
import {
  MAX_DISPLAY_NAME_LENGTH,
  PathGuardError,
  assertInsideRoot,
  detectCollision,
  ensureProjectsRoot,
  inspectSlug,
  isPathGuardError,
  sanitizeSlug,
} from '../../src/bridge/security/paths.ts';
import { checkAttachmentsReferencable } from '../../src/bridge/attachments/pipeline.ts';
import { createConversationService } from '../../src/bridge/operations/conversations.ts';
import type { ConversationService, EventPublisher } from '../../src/bridge/operations/conversations.ts';
import { createRunService } from '../../src/bridge/operations/runs.ts';
import { OperationFailure, Router } from '../../src/bridge/router.ts';
import type { BridgeRuntimeFacts } from '../../src/bridge/router.ts';
import {
  MIN_APPROVAL_TTL_MS,
  checkApproval,
  readApproval,
  requestApproval,
  resolveApproval,
} from '../../src/bridge/operations/approvals.ts';
import { Transport, createStoreSink } from '../../src/bridge/transport.ts';
import { loadConfig } from '../../src/bridge/config.ts';
import { INVARIANT_DECLARATIONS, PROTOCOL_SCHEMA_VERSION } from '../../src/shared/protocol.ts';
import { BRIDGE_PROJECT_ID } from '../../src/bridge/storage/store.ts';
import type {
  AttachmentRecord,
  AttachmentState,
  ConversationRecord,
  OperationErrorCode,
  ProjectRecord,
} from '../../src/shared/protocol.ts';
import type { AdapterOptions, ClaudeAdapter } from '../../src/bridge/claude/adapter.ts';
import type { LocateResult, LocatedClaude } from '../../src/bridge/claude/locate.ts';

/* ------------------------------------------------------------------ fixtures */

let scratchDirs: string[] = [];
let openStores: ForgeStore[] = [];
let transports: Transport[] = [];

function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `forge-neg-${label}-`));
  if (!resolve(dir).startsWith(resolve(tmpdir()))) {
    throw new Error(`refusing to run: the scratch dir ${dir} is not under the OS temp directory`);
  }
  scratchDirs.push(dir);
  return dir;
}

function openStore(dataDir: string, bridgeInstanceId = 'neg-bridge'): ForgeStore {
  const store = ForgeStore.open({ dataDir, bridgeInstanceId });
  openStores.push(store);
  return store;
}

afterEach(() => {
  for (const transport of transports) {
    try {
      transport.stop();
    } catch {
      /* not started, or already stopped */
    }
  }
  transports = [];
  for (const store of openStores) {
    try {
      store.close();
    } catch {
      /* closing twice is documented as safe */
    }
  }
  openStores = [];
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
  scratchDirs = [];
});

/* ------------------------------------------------------------------- helpers */

const nowIso = (): string => new Date().toISOString();

/** A publisher over the real store — enough for the two services under test. */
function publisherFor(store: ForgeStore): EventPublisher {
  return { publish: (input) => store.appendEvent(input) };
}

function registerProject(registry: ProjectRegistry, projectsRoot: string, displayName: string, slug: string): ProjectRecord {
  const result = registry.register({ displayName, slug, canonicalPath: join(projectsRoot, slug), origin: 'created' });
  if (!result.ok) throw new Error(`could not seed project "${displayName}": ${result.error.code} ${result.error.message}`);
  return result.value;
}

function conversationRecord(
  id: string,
  projectId: string,
  extra: Partial<ConversationRecord> = {},
): ConversationRecord {
  const ts = nowIso();
  return {
    id,
    projectId,
    title: 'A conversation',
    claudeSessionId: null,
    createdAt: ts,
    updatedAt: ts,
    messageCount: 0,
    attachmentIds: [],
    activeRunId: null,
    archived: false,
    lastConfirmedSequence: 0,
    ...extra,
  };
}

function attachmentRecord(
  id: string,
  projectId: string,
  conversationId: string,
  state: AttachmentState,
): AttachmentRecord {
  const ready = state === 'READY';
  return {
    id,
    projectId,
    conversationId,
    originalFilename: 'notes.txt',
    storedFilename: `${id}.txt`,
    // Not read by any code path exercised here — every rejection fires before the
    // path guard would open it — but the contract requires a non-empty string.
    canonicalPath: join('C:', 'unused', `${id}.txt`),
    declaredMediaType: 'text/plain',
    detectedMediaType: 'text/plain',
    size: 12,
    hash: null,
    createdAt: nowIso(),
    uploaderSource: 'picker',
    previewAvailable: false,
    state,
    security: 'CLEAN',
    securityNotes: [],
    claudeAccessible: ready,
    deleted: false,
  };
}

/** A probed runtime that never runs. `--resume` is present so the session guard,
 *  which is checked BEFORE the flag support check, is the thing that fires. */
function fakeLocated(): LocatedClaude {
  return {
    executablePath: join('C:', 'fake', 'claude.exe'),
    source: 'path-entry',
    version: '2.1.217',
    versionRaw: '2.1.217 (Claude Code)',
    flags: new Set<string>(['--print', '--output-format', '--resume', '--add-dir']),
    choices: new Map(),
    descriptions: new Map(),
    probedAt: nowIso(),
    candidatesConsidered: [],
    notes: [],
  };
}

/** An adapter that throws the instant anything tries to spawn — a spawn in this
 *  suite is itself the defect the suite is guarding against. */
function throwingAdapterFactory(_options: AdapterOptions): ClaudeAdapter {
  return {
    start() {
      throw new Error('adapter.start() must never be reached in the negative suite');
    },
    stop() {
      return Promise.resolve({ ok: false as const, reason: 'UNKNOWN_RUN' as const, detail: 'fake', forced: false });
    },
    activeRunIds() {
      return [];
    },
    liveRuns() {
      return [];
    },
    stopAll() {
      return Promise.resolve([]);
    },
  } as unknown as ClaudeAdapter;
}

interface RunHarness {
  readonly store: ForgeStore;
  readonly registry: ProjectRegistry;
  readonly conversations: ConversationService;
  readonly run: ReturnType<typeof createRunService>;
  readonly projectsRoot: string;
}

function runHarness(label: string): RunHarness {
  const dataDir = tempDir(`${label}-data`);
  const projectsRoot = tempDir(`${label}-proj`);
  const store = openStore(dataDir, `bridge-${label}`);
  const registry = new ProjectRegistry(store, { projectsRoot });
  const conversations = createConversationService({ store, events: publisherFor(store), registry });
  const run = createRunService({
    conversations,
    trustedRoot: projectsRoot,
    evidenceDir: join(store.dataDir, 'runs'),
    bridgeInstanceId: `bridge-${label}`,
    // Succeeds so `requireAdapter` (which precedes the session guard) does not
    // itself reject; the adapter it hands back throws if anyone tries to spawn.
    locate: (): Promise<LocateResult> => Promise.resolve({ ok: true, located: fakeLocated() }),
    adapterFactory: throwingAdapterFactory,
  });
  return { store, registry, conversations, run, projectsRoot };
}

/** Catch a thrown `OperationFailure` and hand back its contract error code. */
async function rejectionCode(action: () => Promise<unknown> | unknown): Promise<OperationErrorCode> {
  try {
    await action();
  } catch (error) {
    if (error instanceof OperationFailure) return error.error.code;
    throw error;
  }
  throw new Error('expected a typed OperationFailure, but the call resolved');
}

/* ========================================================================== */
/*  Project creation, the registry and the path guard                          */
/* ========================================================================== */

describe('createProject refuses a name that cannot become a safe folder', () => {
  function flowFor(label: string): { registry: ProjectRegistry; store: ForgeStore; projectsRoot: string } {
    const store = openStore(tempDir(`${label}-data`));
    const projectsRoot = tempDir(`${label}-proj`);
    return { registry: new ProjectRegistry(store, { projectsRoot }), store, projectsRoot };
  }

  it('a blank name is PATH_REJECTED, not silently accepted', () => {
    expect(inspectSlug('')).toMatchObject({ ok: false, code: 'PATH_REJECTED' });

    const { registry, store } = flowFor('blank');
    const result = createProject(registry, store, { displayName: '   ', skipGit: true });
    expect(result.outcome).toBe('FAILED');
    expect(result.project).toBeNull();
    expect(result.error?.code).toBe('PATH_REJECTED');
    // The refusal is on the first step; nothing was registered.
    expect(registry.list().records).toHaveLength(0);
  });

  it('an over-long name is PATH_REJECTED', () => {
    const tooLong = 'x'.repeat(MAX_DISPLAY_NAME_LENGTH + 1);
    expect(inspectSlug(tooLong)).toMatchObject({ ok: false, code: 'PATH_REJECTED' });

    const { registry, store } = flowFor('overlong');
    const result = createProject(registry, store, { displayName: tooLong, skipGit: true });
    expect(result.outcome).toBe('FAILED');
    expect(result.error?.code).toBe('PATH_REJECTED');
  });

  it('a name containing a path separator (traversal) is PATH_REJECTED', () => {
    for (const name of ['../etc/passwd', '..\\Windows', 'a/b', 'sub\\dir']) {
      const inspection = inspectSlug(name);
      expect(inspection.ok, `expected "${name}" to be refused`).toBe(false);
      expect(inspection.ok === false && inspection.code).toBe('PATH_REJECTED');
    }
    const { registry, store } = flowFor('traversal');
    const result = createProject(registry, store, { displayName: '../escape', skipGit: true });
    expect(result.outcome).toBe('FAILED');
    expect(result.error?.code).toBe('PATH_REJECTED');
  });

  it('an absolute / drive path is PATH_REJECTED', () => {
    for (const name of ['C:\\Windows', 'C:project', 'D:/data']) {
      const inspection = inspectSlug(name);
      expect(inspection.ok, `expected "${name}" to be refused`).toBe(false);
      expect(inspection.ok === false && inspection.code).toBe('PATH_REJECTED');
    }
    const { registry, store } = flowFor('absolute');
    const result = createProject(registry, store, { displayName: 'C:\\Windows\\System32', skipGit: true });
    expect(result.outcome).toBe('FAILED');
    expect(result.error?.code).toBe('PATH_REJECTED');
  });

  it('a reserved Windows device name (CON) is PATH_REJECTED, even dressed up', () => {
    for (const name of ['CON', 'con', 'CON.txt', 'nul', 'LPT1', 'CON---']) {
      const inspection = inspectSlug(name);
      expect(inspection.ok, `expected "${name}" to be refused`).toBe(false);
      expect(inspection.ok === false && inspection.code).toBe('PATH_REJECTED');
      expect(inspection.ok === false && inspection.reason.toLowerCase()).toContain('reserved device name');
    }
    // The throwing sibling raises the typed guard error, not a bare Error.
    expect(() => sanitizeSlug('CON')).toThrow(PathGuardError);

    const { registry, store } = flowFor('reserved');
    const result = createProject(registry, store, { displayName: 'CON', skipGit: true });
    expect(result.outcome).toBe('FAILED');
    expect(result.error?.code).toBe('PATH_REJECTED');
  });
});

describe('the registry refuses a duplicate project', () => {
  it('a second registration of the same name is CONFLICT', () => {
    const store = openStore(tempDir('dup-data'));
    const projectsRoot = tempDir('dup-proj');
    const registry = new ProjectRegistry(store, { projectsRoot });

    registerProject(registry, projectsRoot, 'Invoice Tool', 'invoice-tool');
    const second = registry.register({
      displayName: 'Invoice Tool',
      slug: 'invoice-tool',
      canonicalPath: join(projectsRoot, 'invoice-tool'),
      origin: 'created',
    });

    expect(second.ok).toBe(false);
    expect(second.ok === false && second.error.code).toBe('CONFLICT');
  });

  it('the New Project flow refuses to create over an existing project (CONFLICT)', () => {
    const store = openStore(tempDir('dup2-data'));
    const projectsRoot = tempDir('dup2-proj');
    const registry = new ProjectRegistry(store, { projectsRoot });

    registerProject(registry, projectsRoot, 'Invoice Tool', 'invoice-tool');
    const result = createProject(registry, store, { displayName: 'Invoice Tool', skipGit: true });

    expect(result.outcome).toBe('FAILED');
    expect(result.error?.code).toBe('CONFLICT');
  });
});

describe('a unicode-confusable name collides with an existing project', () => {
  it('detectCollision folds the Cyrillic look-alike onto the Latin original', () => {
    // "раypal": Cyrillic er (U+0440) + Cyrillic a (U+0430), the rest Latin.
    const report = detectCollision(['paypal'], '\u0440\u0430ypal');
    expect(report.collides).toBe(true);
    expect(report.matches[0]?.reason).toBe('confusable');
    expect(report.matches[0]?.existing).toBe('paypal');
  });

  it('the registry refuses the look-alike without an explicit override (CONFLICT)', () => {
    const store = openStore(tempDir('confuse-data'));
    const projectsRoot = tempDir('confuse-proj');
    const registry = new ProjectRegistry(store, { projectsRoot });

    registerProject(registry, projectsRoot, 'paypal', 'paypal');
    const lookAlike = '\u0440\u0430ypal';
    const second = registry.register({
      displayName: lookAlike,
      slug: lookAlike.toLowerCase(),
      canonicalPath: join(projectsRoot, lookAlike.toLowerCase()),
      origin: 'created',
    });

    expect(second.ok).toBe(false);
    expect(second.ok === false && second.error.code).toBe('CONFLICT');

    // The creation flow refuses it the same way.
    const result = createProject(registry, store, { displayName: lookAlike, skipGit: true });
    expect(result.outcome).toBe('FAILED');
    expect(result.error?.code).toBe('CONFLICT');
  });
});

describe('paths that escape the trusted root are refused', () => {
  it('assertInsideRoot rejects a candidate above the root with OUTSIDE_TRUSTED_ROOT', () => {
    const root = tempDir('root');
    let thrown: unknown = null;
    try {
      assertInsideRoot('../secret', root);
    } catch (error) {
      thrown = error;
    }
    expect(isPathGuardError(thrown)).toBe(true);
    expect((thrown as PathGuardError).code).toBe('OUTSIDE_TRUSTED_ROOT');
  });

  it('assertInsideRoot rejects a NUL-bearing path with PATH_REJECTED', () => {
    const root = tempDir('root-nul');
    let thrown: unknown = null;
    try {
      assertInsideRoot('safe\u0000/../../etc', root);
    } catch (error) {
      thrown = error;
    }
    expect(isPathGuardError(thrown)).toBe(true);
    expect((thrown as PathGuardError).code).toBe('PATH_REJECTED');
  });
});

describe('a missing folder is reported, never invented', () => {
  it('ensureProjectsRoot refuses when the Documents directory does not exist', () => {
    const missing = join(tempDir('missing'), 'does', 'not', 'exist');
    let thrown: unknown = null;
    try {
      ensureProjectsRoot({ documentsDir: missing });
    } catch (error) {
      thrown = error;
    }
    expect(isPathGuardError(thrown)).toBe(true);
    // A missing parent is a malformed request, not a containment breach.
    expect((thrown as PathGuardError).code).toBe('PATH_REJECTED');
    expect((thrown as PathGuardError).message.toLowerCase()).toContain('no documents directory');
  });
});

/* ========================================================================== */
/*  The attachment reference boundary and sendMessage                          */
/* ========================================================================== */

describe('checkAttachmentsReferencable is the boundary a message cannot cross', () => {
  it('a not-yet-READY attachment is ATTACHMENT_NOT_READY', () => {
    const record = attachmentRecord('att-staging', 'proj', 'conv', 'HASHING');
    const report = checkAttachmentsReferencable([record], ['att-staging']);
    expect(report.ok).toBe(false);
    expect(report.error?.code).toBe('ATTACHMENT_NOT_READY');
  });

  it('an id from another conversation is NOT_FOUND, not ATTACHMENT_NOT_READY', () => {
    // The candidate set only ever contains this conversation's own records.
    const report = checkAttachmentsReferencable([], ['att-from-elsewhere']);
    expect(report.ok).toBe(false);
    expect(report.error?.code).toBe('NOT_FOUND');
    expect(report.checks[0]?.reason).toContain('not known to this conversation');
  });
});

describe('sendMessage refuses to send with an attachment that is not READY', () => {
  it('rejects with ATTACHMENT_NOT_READY before any process is spawned', async () => {
    const h = runHarness('att-not-ready');
    const project = registerProject(h.registry, h.projectsRoot, 'Docs', 'docs');
    const conv = conversationRecord('conv-a', project.id);
    h.store.saveRecord('conversation', conv);
    h.store.saveRecord('attachment', attachmentRecord('att-1', project.id, conv.id, 'STAGING'));

    const code = await rejectionCode(() =>
      h.run.sendMessage({
        projectId: project.id,
        conversationId: conv.id,
        message: 'please read the attached file',
        attachmentIds: ['att-1'],
      }),
    );
    expect(code).toBe('ATTACHMENT_NOT_READY');
    // Nothing ran: no run record was created.
    expect(h.store.listRecords('run').records).toHaveLength(0);
  });

  it('rejects a cross-project attachment id with NOT_FOUND', async () => {
    const h = runHarness('att-cross');
    const projectA = registerProject(h.registry, h.projectsRoot, 'Project A', 'project-a');
    const projectB = registerProject(h.registry, h.projectsRoot, 'Project B', 'project-b');
    const convA = conversationRecord('conv-a', projectA.id);
    const convB = conversationRecord('conv-b', projectB.id);
    h.store.saveRecord('conversation', convA);
    h.store.saveRecord('conversation', convB);
    // A perfectly READY attachment — but it belongs to project B / conversation B.
    h.store.saveRecord('attachment', attachmentRecord('att-b', projectB.id, convB.id, 'READY'));

    const code = await rejectionCode(() =>
      h.run.sendMessage({
        projectId: projectA.id,
        conversationId: convA.id,
        message: 'reference a file from the other project',
        attachmentIds: ['att-b'],
      }),
    );
    expect(code).toBe('NOT_FOUND');
    expect(h.store.listRecords('run').records).toHaveLength(0);
  });
});

describe('a Claude session from one project cannot be resumed under another', () => {
  it('rejects with INVALID_STATE and never starts a fresh session in disguise', async () => {
    const h = runHarness('session-iso');
    const projectA = registerProject(h.registry, h.projectsRoot, 'Project A', 'project-a');
    const projectB = registerProject(h.registry, h.projectsRoot, 'Project B', 'project-b');

    // Both conversations carry the SAME reported session id, in different projects.
    h.store.saveRecord('conversation', conversationRecord('conv-a', projectA.id, { claudeSessionId: 'sess-shared' }));
    const convB = conversationRecord('conv-b', projectB.id, { claudeSessionId: 'sess-shared' });
    h.store.saveRecord('conversation', convB);

    const code = await rejectionCode(() =>
      h.run.sendMessage({ projectId: projectB.id, conversationId: convB.id, message: 'continue please' }),
    );
    expect(code).toBe('INVALID_STATE');
    expect(h.store.listRecords('run').records).toHaveLength(0);
  });
});

/* ========================================================================== */
/*  The router: unknown op, schema mismatch, idempotency                        */
/* ========================================================================== */

describe('the router turns hostile envelopes into typed errors', () => {
  function buildRouter(label: string): { router: Router; store: ForgeStore } {
    const store = openStore(tempDir(`${label}-data`), `router-${label}`);
    const loaded = loadConfig({});
    if (!loaded.ok) throw new Error(`config refused: ${loaded.errors.join('; ')}`);
    const transport = new Transport({
      sink: createStoreSink(store),
      bridgeInstanceId: store.bridgeInstanceId,
      heartbeatIntervalMs: 15_000,
      declarations: INVARIANT_DECLARATIONS,
      protocolSchemaVersion: PROTOCOL_SCHEMA_VERSION,
      bridgeProjectId: BRIDGE_PROJECT_ID,
    });
    // Deliberately not started: no heartbeat/drain timers in a unit test.
    transports.push(transport);
    const runtimeFacts = (): BridgeRuntimeFacts => ({
      boundAddress: null,
      boundPort: null,
      listening: false,
      startedAt: nowIso(),
      startedAtMs: Date.now(),
    });
    const router = new Router({
      store,
      events: transport,
      config: loaded.config,
      bridgeInstanceId: store.bridgeInstanceId,
      runtimeFacts,
    });
    return { router, store };
  }

  it('an unknown operation name is UNKNOWN_OPERATION', async () => {
    const { router } = buildRouter('unknown-op');
    const response = await router.dispatch(
      { requestId: 'r1', schemaVersion: PROTOCOL_SCHEMA_VERSION, op: 'definitelyNotAnOperation', payload: {} },
      'internal',
      null,
    );
    expect(response.ok).toBe(false);
    expect(response.ok === false && response.error.code).toBe('UNKNOWN_OPERATION');
  });

  it('a wrong protocol schema version is SCHEMA_MISMATCH', async () => {
    const { router } = buildRouter('schema');
    const response = await router.dispatch(
      { requestId: 'r2', schemaVersion: PROTOCOL_SCHEMA_VERSION + 99, op: 'getHealth', payload: {} },
      'internal',
      null,
    );
    expect(response.ok).toBe(false);
    expect(response.ok === false && response.error.code).toBe('SCHEMA_MISMATCH');
  });

  it('a double sendMessage with one requestId runs exactly once and replays the first answer', async () => {
    const { router } = buildRouter('idempotent');
    let executions = 0;
    // Override the real handler with a counting stub — the point under test is the
    // router's requestId idempotency, not the run lifecycle.
    router.register(
      'sendMessage',
      () => {
        executions += 1;
        return { runId: `run-${executions}`, executed: executions };
      },
      { override: true },
    );

    const envelope = {
      requestId: 'send-once',
      schemaVersion: PROTOCOL_SCHEMA_VERSION,
      op: 'sendMessage',
      payload: { projectId: 'p', conversationId: 'c', message: 'hi' },
    };

    const first = await router.dispatch(envelope, 'internal', null);
    const second = await router.dispatch(envelope, 'internal', null);

    expect(executions).toBe(1);
    expect(first.ok && second.ok).toBe(true);
    expect(first.ok && first.result).toEqual({ runId: 'run-1', executed: 1 });
    // The retry gets the FIRST response, byte for byte — it does not run again.
    expect(second).toEqual(first);
    expect(router.stats().replayed).toBe(1);
  });

  it('the same requestId reused for a different operation is a CONFLICT, not a wrong answer', async () => {
    const { router } = buildRouter('idempotent-conflict');
    router.register('sendMessage', () => ({ runId: 'run-x' }), { override: true });

    await router.dispatch(
      { requestId: 'shared-id', schemaVersion: PROTOCOL_SCHEMA_VERSION, op: 'sendMessage', payload: {} },
      'internal',
      null,
    );
    const clash = await router.dispatch(
      { requestId: 'shared-id', schemaVersion: PROTOCOL_SCHEMA_VERSION, op: 'getHealth', payload: {} },
      'internal',
      null,
    );
    expect(clash.ok).toBe(false);
    expect(clash.ok === false && clash.error.code).toBe('CONFLICT');
  });
});

/* ========================================================================== */
/*  Approvals: an expired request is never an approval                          */
/* ========================================================================== */

describe('an expired approval is never treated as approved', () => {
  it('expires on read and refuses a later APPROVED verdict with INVALID_STATE', async () => {
    const store = openStore(tempDir('approval-data'));
    let nowMs = Date.parse('2026-07-24T12:00:00.000Z');
    const io = { store, events: null, now: () => new Date(nowMs) };

    const { approval } = requestApproval(io, {
      projectId: 'proj',
      requestedBy: 'agent',
      action: 'delete a file',
      operation: 'runApprovedTest',
      affects: ['dangerous.txt'],
      risk: 'HIGH',
      reason: 'the agent proposed a destructive action',
      rollbackPlan: 'restore from checkpoint',
      ttlMs: MIN_APPROVAL_TTL_MS,
    });
    expect(approval.state).toBe('PENDING');

    // Time moves past the deadline.
    nowMs += MIN_APPROVAL_TTL_MS + 1_000;

    // A read expires it and records the fact on disk.
    const verdict = checkApproval(io, { projectId: 'proj', operation: 'runApprovedTest', action: 'delete a file' });
    expect(verdict.state).toBe('EXPIRED');

    // Trying to approve the expired request is refused with a typed error.
    const code = await rejectionCode(() =>
      resolveApproval(io, { approvalId: approval.id, verdict: 'APPROVED', resolvedBy: 'owner' }),
    );
    expect(code).toBe('INVALID_STATE');

    // And it is still EXPIRED — never walked back to APPROVED.
    const after = readApproval(io, approval.id);
    expect(after.ok && after.approval.state).toBe('EXPIRED');
  });
});
