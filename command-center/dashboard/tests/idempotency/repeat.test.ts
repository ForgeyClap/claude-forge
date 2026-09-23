/**
 * Forge Workspace — the idempotency suite (mission section N).
 *
 * One question, asked of every part of the bridge that has a side effect:
 * DOES DOING IT TWICE DO IT TWICE? A local-first app retries constantly — a
 * flaky socket resends a request, a refresh re-opens a conversation, a restart
 * re-runs recovery — and every one of those retries must leave the workspace in
 * exactly the state a single call would have. A duplicated project, a doubled
 * artifact row, a second "resumed" session: each is a lie the UI would then
 * render as truth.
 *
 * These tests run against the REAL storage layer, the REAL registry, the REAL
 * attachment pipeline and the REAL router, in throwaway temp directories. Nothing
 * is mocked except the Claude Code locator in the resume test (injected to return
 * "not found" so the test spawns no process) — resumeSession never spawns anyway;
 * the injection only keeps the probe from touching the machine's real runtime.
 *
 * For each scenario the operation is run TWICE (or more) and the observable state
 * after the second run is asserted equal to the state after the first. Where the
 * code is idempotent by de-duplication that is asserted; where it is
 * append-with-identity (proof entries, and the log entries reconcile/resume
 * emit) that is asserted AND called out as such, because "assert whichever the
 * code actually does, and say which" is the honest instruction.
 *
 * The bridge tree uses the `@/` alias exactly as the chaos/security suites do.
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { INVARIANT_DECLARATIONS, PROTOCOL_SCHEMA_VERSION } from '@/shared/protocol';
import type { ConversationRecord, OperationResponse, ProofEntry } from '@/shared/protocol';

import { BRIDGE_PROJECT_ID, ForgeStore, openStore } from '@/bridge/storage/store';
import { runMigrations } from '@/bridge/storage/schema';
import type { Migration, MigrationIo, MigrationState, RecordEnvelope, RunRecord } from '@/bridge/storage/schema';
import { ProjectRegistry } from '@/bridge/projects/registry';
import { discoverProjects } from '@/bridge/projects/discover';
import { createAttachmentPipeline } from '@/bridge/attachments/pipeline';
import { registerArtifactOperations } from '@/bridge/operations/artifacts';
import { ConversationService } from '@/bridge/operations/conversations';
import { createRunService } from '@/bridge/operations/runs';
import type { LocateResult } from '@/bridge/claude/locate';
import { loadConfig } from '@/bridge/config';
import { Router } from '@/bridge/router';
import { createStoreSink, Transport } from '@/bridge/transport';

/* ========================================================================== */
/*  Fixtures — a fresh, isolated, throwaway workspace per test                  */
/* ========================================================================== */

interface Workspace {
  readonly store: ForgeStore;
  readonly dataDir: string;
  readonly projectsRoot: string;
  readonly scratch: string;
}

const cleanups: Array<() => void> = [];

function freshWorkspace(): Workspace {
  const scratch = mkdtempSync(join(tmpdir(), 'forge-idem-'));
  const dataDir = join(scratch, 'workspace');
  const projectsRoot = join(scratch, 'ForgeProjects');
  mkdirSync(projectsRoot, { recursive: true });
  const store = openStore({ dataDir });
  cleanups.push(() => {
    try {
      store.close();
    } catch {
      /* already closed */
    }
    try {
      rmSync(scratch, { recursive: true, force: true });
    } catch {
      /* a locked temp file on Windows; the OS reaps it later */
    }
  });
  return { store, dataDir, projectsRoot, scratch };
}

afterEach(() => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) fn();
  }
});

/** A router wired exactly as `startBridge` wires one, minus the socket and timers. */
function buildRouter(store: ForgeStore): Router {
  const loaded = loadConfig({});
  if (!loaded.ok) throw new Error(`config refused: ${loaded.errors.join('; ')}`);
  const transport = new Transport({
    sink: createStoreSink(store),
    bridgeInstanceId: store.bridgeInstanceId,
    heartbeatIntervalMs: loaded.config.heartbeatIntervalMs,
    declarations: INVARIANT_DECLARATIONS,
    protocolSchemaVersion: PROTOCOL_SCHEMA_VERSION,
    bridgeProjectId: BRIDGE_PROJECT_ID,
  });
  // Deliberately NOT started: no heartbeat timer, no drain timer, no sockets.
  return new Router({
    store,
    events: transport,
    config: loaded.config,
    bridgeInstanceId: store.bridgeInstanceId,
    runtimeFacts: () => ({
      boundAddress: null,
      boundPort: null,
      listening: false,
      startedAt: new Date().toISOString(),
      startedAtMs: Date.now(),
    }),
  });
}

function dispatch(
  router: Router,
  op: string,
  payload: Record<string, unknown>,
  requestId: string,
): Promise<OperationResponse> {
  return router.dispatch(
    { requestId, schemaVersion: PROTOCOL_SCHEMA_VERSION, op, payload },
    'internal',
    null,
  );
}

function resultOf(resp: OperationResponse): Record<string, unknown> {
  if (!resp.ok) throw new Error(`operation failed: ${resp.error.code} — ${resp.error.message}`);
  return resp.result as Record<string, unknown>;
}

/* ========================================================================== */
/*  1. Events: the same eventId appended twice is stored once, one effect       */
/* ========================================================================== */

describe('idempotency — event append', () => {
  it('appending the same eventId twice stores one line and keeps the first payload', () => {
    const { store } = freshWorkspace();

    const first = store.appendEvent({
      eventId: 'evt-fixed-1',
      projectId: 'proj_alpha',
      runId: null,
      source: 'test',
      type: 'test.started',
      payload: { attempt: 'first' },
    });
    const second = store.appendEvent({
      eventId: 'evt-fixed-1',
      projectId: 'proj_alpha',
      runId: null,
      source: 'test',
      type: 'test.started',
      payload: { attempt: 'second' },
    });

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    // The returned event on the second call is the one already on disk.
    expect(second.event.eventId).toBe(first.event.eventId);
    expect(second.event.sequence).toBe(first.event.sequence);
    expect((second.event.payload as { attempt: string }).attempt).toBe('first');

    // One physical line on the stream, and one effect (sequence did not advance).
    const page = store.readEvents({ projectId: 'proj_alpha', runId: null });
    expect(page.events.length).toBe(1);
    expect(page.events[0].sequence).toBe(1);
    expect(store.stats().eventsPersisted).toBe(1);
  });
});

/* ========================================================================== */
/*  3. Project registration run twice -> one registry record                    */
/* ========================================================================== */

describe('idempotency — project registration', () => {
  it('registering the same project twice yields one record; the second is a CONFLICT', () => {
    const { store, projectsRoot } = freshWorkspace();
    const registry = new ProjectRegistry(store, { projectsRoot });
    const input = {
      displayName: 'Alpha',
      slug: 'alpha',
      canonicalPath: join(projectsRoot, 'alpha'),
      origin: 'created' as const,
    };

    const first = registry.register(input);
    const second = registry.register(input);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('CONFLICT');

    expect(registry.list({ includeArchived: true }).records.length).toBe(1);
    expect(store.listRecordIds('project').length).toBe(1);
  });

  it('re-adopting the same generated id twice is refused, leaving one record for that id', () => {
    const { store, projectsRoot } = freshWorkspace();
    const registry = new ProjectRegistry(store, { projectsRoot });
    const id = randomUUID();

    const first = registry.register({
      displayName: 'Beta One',
      slug: 'beta-one',
      canonicalPath: join(projectsRoot, 'beta-one'),
      id,
      origin: 'imported',
    });
    // Same id, different name and folder: the id is already taken.
    const second = registry.register({
      displayName: 'Beta Two',
      slug: 'beta-two',
      canonicalPath: join(projectsRoot, 'beta-two'),
      id,
      origin: 'imported',
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('CONFLICT');
    expect(store.hasRecord('project', id)).toBe(true);
    expect(store.listRecordIds('project').length).toBe(1);
  });
});

/* ========================================================================== */
/*  4. Project discovery rescanned -> no duplicate records                      */
/* ========================================================================== */

describe('idempotency — project discovery', () => {
  it('rescanning a projects root registers each folder once and reports the rest already known', () => {
    const { store, projectsRoot } = freshWorkspace();
    // A folder is a Forge project when it carries Forge metadata; a .claude
    // directory is enough for `looksLikeForgeProject`.
    mkdirSync(join(projectsRoot, 'beta', '.claude'), { recursive: true });

    const registry = new ProjectRegistry(store, { projectsRoot });

    const scan1 = discoverProjects(registry);
    const scan2 = discoverProjects(registry);
    const scan3 = discoverProjects(registry);

    expect(scan1.registered.length).toBe(1);
    expect(scan1.alreadyKnown.length).toBe(0);

    expect(scan2.registered.length).toBe(0);
    expect(scan2.alreadyKnown.length).toBe(1);

    // The third scan is indistinguishable from the second.
    expect(scan3.registered.length).toBe(0);
    expect(scan3.alreadyKnown.length).toBe(1);

    // One record, stable across every rescan.
    expect(store.listRecordIds('project').length).toBe(1);
  });
});

/* ========================================================================== */
/*  5. Artifact indexing run twice -> one entry per file                        */
/* ========================================================================== */

describe('idempotency — artifact indexing', () => {
  it('re-indexing the same files updates records in place and emits no new indexed events', async () => {
    const { store, projectsRoot } = freshWorkspace();

    // A real project on disk with two artifact files under a scanned root.
    const projectDir = join(projectsRoot, 'artproj');
    mkdirSync(join(projectDir, 'artifacts'), { recursive: true });
    writeFileSync(join(projectDir, 'artifacts', 'report.txt'), 'coverage 100%\n');
    writeFileSync(join(projectDir, 'artifacts', 'data.json'), '{"ok":true}\n');

    const registry = new ProjectRegistry(store, { projectsRoot });
    const reg = registry.register({
      displayName: 'Art Proj',
      slug: 'artproj',
      canonicalPath: projectDir,
      origin: 'created',
    });
    if (!reg.ok) throw new Error(reg.error.message);
    const projectId = reg.value.id;

    const router = buildRouter(store);
    // Re-register the artifact ops pinned to THIS temp root (the default handler
    // resolves the machine's real Documents root, which the test must not touch).
    registerArtifactOperations(router, { projectsRoot }, { override: true });

    const first = resultOf(await dispatch(router, 'listArtifacts', { projectId }, 'idem-art-1'));
    const idsAfterFirst = store.listRecordIds('artifact').slice().sort();
    const eventsFirst = first.events as { indexed: number; missing: number };

    const second = resultOf(await dispatch(router, 'listArtifacts', { projectId }, 'idem-art-2'));
    const idsAfterSecond = store.listRecordIds('artifact').slice().sort();
    const eventsSecond = second.events as { indexed: number; missing: number };

    // One record per file, both runs.
    expect(idsAfterFirst.length).toBe(2);
    expect(idsAfterSecond).toEqual(idsAfterFirst);
    expect((first.artifacts as unknown[]).length).toBe(2);
    expect((second.artifacts as unknown[]).length).toBe(2);

    // The first run indexed both; the second observed no change, so it emitted
    // nothing new — the artifact.indexed events are content-addressed and the
    // records were already current.
    expect(eventsFirst.indexed).toBe(2);
    expect(eventsSecond.indexed).toBe(0);
    expect(eventsSecond.missing).toBe(0);
  });
});

/* ========================================================================== */
/*  6. Attachment hashing repeated -> same hash, one staged copy                */
/* ========================================================================== */

describe('idempotency — attachment staging', () => {
  it('staging the same bytes under the same attachmentId gives the same hash and one copy', () => {
    const { projectsRoot } = freshWorkspace();
    const projectDir = join(projectsRoot, 'attproj');
    mkdirSync(projectDir, { recursive: true });

    const pipeline = createAttachmentPipeline();
    const bytes = new TextEncoder().encode('hello idempotent world');
    const expectedHash = createHash('sha256').update(bytes).digest('hex');

    const input = {
      projectId: 'p',
      projectRoot: projectDir,
      conversationId: 'conv1',
      attachmentId: 'att_fixed',
      filename: 'note.txt',
      declaredMediaType: 'text/plain',
      uploaderSource: 'picker' as const,
      bytes,
    };

    const first = pipeline.stage(input);
    const usageAfterFirst = pipeline.measureProjectUsage(projectDir);
    const second = pipeline.stage(input);
    const usageAfterSecond = pipeline.measureProjectUsage(projectDir);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.record.state).toBe('READY');
    expect(second.record.state).toBe('READY');

    // Same bytes -> same digest, both times, and it is the digest of the input.
    expect(first.record.hash).toBe(expectedHash);
    expect(second.record.hash).toBe(expectedHash);

    // One staged copy: the same attachmentId resolves to the same directory and
    // the payload is overwritten in place, not duplicated.
    const convDir = join(projectDir, '.forge', 'attachments', 'conv1');
    expect(readdirSync(convDir)).toEqual(['att_fixed']);
    expect(first.record.canonicalPath).toBe(second.record.canonicalPath);
    expect(existsSync(second.record.canonicalPath)).toBe(true);
    expect(createHash('sha256').update(readFileSync(second.record.canonicalPath)).digest('hex')).toBe(expectedHash);

    // Total bytes on disk did not grow on the second stage.
    expect(usageAfterSecond).toBe(usageAfterFirst);
  });
});

/* ========================================================================== */
/*  7. Proof entries — the same claim recorded twice                            */
/*                                                                              */
/*  FINDING (append-with-identity, NOT de-duplicated): operations/tests.ts      */
/*  mints a fresh `proof-<uuid>` id on every recordProof call, so recording the */
/*  same claim twice produces two independent, individually-identified entries. */
/*  At the record layer, saving the SAME proof id twice is idempotent —          */
/*  saveRecord overwrites by id and leaves one file — so identity, not the claim */
/*  text, is what de-duplicates. This test asserts both halves of that.          */
/* ========================================================================== */

describe('idempotency — proof entries', () => {
  it('same id twice is one record (idempotent by id); same claim under fresh ids appends', () => {
    const { store } = freshWorkspace();
    const ts = new Date('2026-07-24T00:00:00.000Z').toISOString();

    const entry = (id: string): ProofEntry => ({
      id,
      projectId: 'projx',
      runId: null,
      taskId: null,
      timestamp: ts,
      claim: 'the vitest gate exited 0 with 0 failures',
      agentId: null,
      command: 'vitest run',
      verdict: 'accepted',
      reason: 'exit code 0 and a parsed failure count of 0 agree',
      evidenceRefs: [{ kind: 'exit-code', ref: '0', note: 'gate exit' }],
    });

    // Record-layer idempotency: the same id written twice is one file.
    store.saveRecord('proof', entry('proof-fixed'));
    store.saveRecord('proof', entry('proof-fixed'));
    expect(store.listRecordIds('proof').length).toBe(1);

    // Append-with-identity: the SAME claim under a fresh id is a second entry,
    // exactly as a second recordProof call would produce.
    store.saveRecord('proof', entry('proof-second'));
    expect(store.listRecordIds('proof').length).toBe(2);

    const claims = store.listRecords('proof').records.map((p) => p.claim);
    expect(claims.every((c) => c === 'the vitest gate exited 0 with 0 failures')).toBe(true);
  });
});

/* ========================================================================== */
/*  8. Migrations run twice -> a no-op the second time (schemaVersion stable)    */
/* ========================================================================== */

describe('idempotency — migrations', () => {
  it('a migration applied once is reported alreadyApplied on rerun and writes no record', () => {
    // An in-memory MigrationIo so the runner's real idempotency machine is
    // exercised without a synthetic migration ever having to ship in MIGRATIONS.
    const records = new Map<string, RecordEnvelope>();
    records.set('proof/p-seed', {
      kind: 'proof',
      id: 'p-seed',
      schemaVersion: 1,
      storedAt: new Date().toISOString(),
      record: { id: 'p-seed', claim: 'seed' },
    });
    // A holder object rather than a bare `let`: the runner mutates state only
    // inside closures, and TypeScript's flow analysis would otherwise narrow a
    // bare local back to its `null` initialiser at the assertion site.
    const holder: { current: MigrationState | null } = { current: null };
    const counters = { envelopeWrites: 0, stateWrites: 0 };

    const io: MigrationIo = {
      listRecordIds: (kind) => [...records.values()].filter((e) => e.kind === kind).map((e) => e.id),
      readEnvelope: (kind, id) => {
        const found = records.get(`${kind}/${id}`);
        return found === undefined
          ? { ok: false, reason: 'MISSING', detail: 'absent', bytes: 0 }
          : { ok: true, value: found, bytes: 0 };
      },
      writeEnvelope: (envelope) => {
        records.set(`${envelope.kind}/${envelope.id}`, envelope);
        counters.envelopeWrites += 1;
      },
      readState: () =>
        holder.current === null
          ? { ok: false, reason: 'MISSING', detail: 'no state', bytes: 0 }
          : { ok: true, value: holder.current, bytes: 0 },
      writeState: (next) => {
        holder.current = next;
        counters.stateWrites += 1;
      },
    };

    const migration: Migration = {
      id: 'idem-test-proof-1to2',
      kind: 'proof',
      from: 1,
      to: 2,
      description: 'test-only migration used to prove the runner is a no-op on rerun',
      migrate: (record) => ({ ...record, migrated: true }),
    };

    const first = runMigrations(io, [migration], () => new Date());
    const writesAfterFirst = counters.envelopeWrites;
    const second = runMigrations(io, [migration], () => new Date());

    // First run applies it exactly once.
    expect(first.applied.map((a) => a.id)).toEqual(['idem-test-proof-1to2']);
    expect(first.applied[0].recordsChanged).toBe(1);
    expect(first.alreadyApplied).toEqual([]);
    expect(writesAfterFirst).toBe(1);

    // Second run is a no-op: nothing applied, the id reported alreadyApplied, and
    // NOT ONE record was rewritten.
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual(['idem-test-proof-1to2']);
    expect(counters.envelopeWrites).toBe(1);

    // The recorded schema versions are identical across the two runs, and the
    // applied ledger did not grow.
    expect(second.schemaVersions).toEqual(first.schemaVersions);
    expect(holder.current?.applied.length).toBe(1);
    // The seed record ended at the migration's target version and stayed there.
    expect(records.get('proof/p-seed')?.schemaVersion).toBe(2);
  });

  it('the store\'s own boot migrations (empty at layout v1) are stable across reruns', () => {
    const { store } = freshWorkspace();
    // reconcileOnStartup runs the migration runner each boot. With no migrations
    // registered, the recorded schema versions must be identical run to run.
    const first = store.reconcileOnStartup();
    const second = store.reconcileOnStartup();
    expect(second.migrations.schemaVersions).toEqual(first.migrations.schemaVersions);
    expect(second.migrations.applied).toEqual([]);
  });
});

/* ========================================================================== */
/*  10. reconcileOnStartup run twice -> the second run changes nothing           */
/* ========================================================================== */

describe('idempotency — startup reconciliation', () => {
  it('a run left claiming RUNNING is reconciled once; the second reconcile is inert', () => {
    const { store } = freshWorkspace();
    const seededAt = new Date('2026-07-24T09:00:00.000Z').toISOString();

    const run: RunRecord = {
      id: 'run-recon-1',
      projectId: 'projx',
      conversationId: null,
      sessionId: null,
      goal: 'seeded run that never got to report an exit',
      status: 'RUNNING',
      // A live status needs a pid or an owning instance on the record, or the
      // validator refuses it. This one carries an owner but no pid.
      statusReason: 'seeded live for the reconcile test',
      pid: null,
      ownerBridgeInstanceId: 'ghost-instance',
      startedAt: seededAt,
      updatedAt: seededAt,
      endedAt: null,
      exitCode: null,
      lastSequence: 0,
      evidenceRefs: [],
    };
    store.saveRecord('run', run);

    const first = store.reconcileOnStartup();
    const afterFirst = store.getRecord('run', run.id);
    const second = store.reconcileOnStartup();
    const afterSecond = store.getRecord('run', run.id);

    // First reconcile moves it out of the live status. A pid-less run can never
    // be proven to have been alive, so it becomes ORPHANED — never COMPLETED.
    expect(first.reconciled.length).toBe(1);
    expect(first.reconciled[0].from).toBe('RUNNING');
    expect(first.reconciled[0].to).toBe('ORPHANED');
    expect(afterFirst.ok).toBe(true);
    if (afterFirst.ok) expect(afterFirst.record.status).toBe('ORPHANED');

    // Second reconcile finds nothing live to reconcile, and the run record is
    // byte-for-byte what the first reconcile left. (reconcile still appends its
    // own bridge.reconciled log entry each boot — that is a log line, not a state
    // change to any run.)
    expect(second.reconciled.length).toBe(0);
    expect(second.runsInspected).toBe(first.runsInspected);
    if (afterFirst.ok && afterSecond.ok) {
      expect(afterSecond.record).toEqual(afterFirst.record);
    }
  });
});

/* ========================================================================== */
/*  2. createProject requestId twice -> one project, one folder, cached response */
/*                                                                              */
/*  This one exercises the ROUTER's idempotency cache, which is where the        */
/*  requestId guarantee lives. The createProject flow itself is NOT idempotent   */
/*  by requestId (it mints a fresh project id every run); the router is what     */
/*  turns a retry into a replay. To keep the real Documents folder untouched,    */
/*  the profile home is redirected to a temp directory for the duration.         */
/* ========================================================================== */

describe('idempotency — createProject requestId (router cache)', () => {
  it('the same requestId twice creates one project and one folder, replaying the response', async () => {
    const { store, scratch } = freshWorkspace();

    // resolveProjectsRootInfo (used inside the createProject operation) reads
    // os.homedir(), which is USERPROFILE on Windows / HOME on POSIX. Point it at
    // a temp home with a Documents folder so the flow builds its ForgeProjects
    // root there instead of in the developer's real Documents.
    const home = join(scratch, 'home');
    const documents = join(home, 'Documents');
    mkdirSync(documents, { recursive: true });
    const projectsRoot = join(documents, 'ForgeProjects');

    const savedUserProfile = process.env.USERPROFILE;
    const savedHome = process.env.HOME;
    process.env.USERPROFILE = home;
    process.env.HOME = home;

    try {
      const router = buildRouter(store);
      const payload = { displayName: 'Idem Project', skipGit: true };

      const firstResp = await dispatch(router, 'createProject', payload, 'req-create-fixed');
      const secondResp = await dispatch(router, 'createProject', payload, 'req-create-fixed');

      const first = resultOf(firstResp);
      const firstProject = first.project as { id: string } | null;
      expect(firstProject).not.toBeNull();

      // Exactly one project record, though createProject was dispatched twice.
      expect(store.listRecordIds('project').length).toBe(1);

      // Exactly one folder under the projects root.
      expect(readdirSync(projectsRoot).length).toBe(1);

      // The second dispatch replayed the FIRST response rather than running
      // again — the router returns the same resolved object from its cache.
      expect(secondResp).toBe(firstResp);
      expect(router.stats().replayed).toBe(1);
    } finally {
      if (savedUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = savedUserProfile;
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    }
  });
});

/* ========================================================================== */
/*  9. Session resume issued twice -> one resumed session, not two               */
/*                                                                              */
/*  resumeSession REPORTS whether a conversation can be continued; it starts     */
/*  nothing (the actual --resume happens on the next sendMessage). So the        */
/*  idempotency claim is: no run is created, the conversation keeps its single   */
/*  session id, and the two reports agree. Each call appends one                 */
/*  conversation.resumed log entry (append-with-identity) — a log line, not a    */
/*  second session — which is asserted and called out.                           */
/* ========================================================================== */

describe('idempotency — session resume', () => {
  it('resuming twice creates no run, keeps one session id, and returns the same report', async () => {
    const { store, projectsRoot } = freshWorkspace();
    mkdirSync(join(projectsRoot, 'gamma'), { recursive: true });

    const registry = new ProjectRegistry(store, { projectsRoot });
    const reg = registry.register({
      displayName: 'Gamma',
      slug: 'gamma',
      canonicalPath: join(projectsRoot, 'gamma'),
      origin: 'created',
    });
    if (!reg.ok) throw new Error(reg.error.message);
    const projectId = reg.value.id;

    // A conversation that already carries a Claude session id.
    const now = new Date('2026-07-24T10:00:00.000Z').toISOString();
    const conversation: ConversationRecord = {
      id: `conv-${randomUUID()}`,
      projectId,
      title: 'Continue this',
      claudeSessionId: 'sess-xyz',
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      attachmentIds: [],
      activeRunId: null,
      archived: false,
      lastConfirmedSequence: 0,
    };
    store.saveRecord('conversation', conversation);

    const events = createStoreSink(store);
    const conversations = new ConversationService({ store, events, registry });
    const runService = createRunService({
      conversations,
      trustedRoot: projectsRoot,
      evidenceDir: join(store.dataDir, 'runs'),
      bridgeInstanceId: store.bridgeInstanceId,
      // Injected so the test spawns nothing. resumeSession only consults this to
      // decide whether --resume is supported; a "not found" answer yields the
      // honest UNVERIFIED state without ever touching the machine's real runtime.
      locate: async (): Promise<LocateResult> => ({
        ok: false,
        reason: 'NOT_FOUND',
        detail: 'test: no runtime is located',
        candidatesConsidered: [],
        notes: [],
      }),
    });

    const first = await runService.resumeSession({ conversationId: conversation.id });
    const second = await runService.resumeSession({ conversationId: conversation.id });

    // No session was started, and no run record was created by either call.
    expect(store.listRecordIds('run').length).toBe(0);
    expect(first.runs.length).toBe(0);
    expect(second.runs.length).toBe(0);

    // The conversation still holds exactly one session id, unchanged.
    const reread = store.getRecord('conversation', conversation.id);
    expect(reread.ok).toBe(true);
    if (reread.ok) expect(reread.record.claudeSessionId).toBe('sess-xyz');

    // The two reports agree — resuming twice is resuming once, reported twice.
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.sessionId).toBe('sess-xyz');
    expect(second.sessionState).toBe(first.sessionState);
    expect(second.resumable).toBe(first.resumable);

    // Append-with-identity: each call logged exactly one conversation.resumed
    // event. Two log lines, still one session.
    const resumedEvents = store.readEvents({
      projectId,
      runId: null,
      types: ['conversation.resumed'],
    });
    expect(resumedEvents.events.length).toBe(2);
  });
});
