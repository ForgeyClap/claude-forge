/**
 * Forge Workspace — bridge lifecycle over the real HTTP + WebSocket protocol
 * (mission section D).
 *
 * Every assertion here is against the SHIPPED bridge, started as a child process
 * (`node src/bridge/main.ts`) in a throwaway sandbox and spoken to only over the
 * wire — POST /api/operation, GET /api/health, and the `ws://…/ws` transport.
 * Nothing imports a bridge module, so nothing can accidentally test the code
 * instead of the running program. See `helpers.ts` for how the sandbox isolates
 * the workspace and the projects root away from the real ones.
 *
 * The rule the whole suite serves: a status is a claim about reality. So the
 * tests check for real folders on disk, real receipt steps, a real streamed
 * `run.output.complete`, a real released lock — not merely a 200 with an
 * encouraging shape.
 *
 * THE ONE RUN. Exactly one test drives a real Claude Code run, to respect the
 * subscription. It is guarded: if the bridge's own probe reports Claude Code
 * unavailable or unauthenticated, the test SKIPS with the reason rather than
 * failing the suite on a machine without an authenticated CLI.
 */

import { Buffer } from 'node:buffer';
import { existsSync, statSync } from 'node:fs';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ForgeEvent, ProjectRecord } from '../../src/shared/protocol.ts';

import { delay, startTestBridge } from './helpers.ts';
import type { TestBridge, WsClient } from './helpers.ts';

/** The 39 operations the contract defines. Mirrored here so a drift is visible. */
const EXPECTED_OPERATION_COUNT = 39;
const EXPECTED_DERIVED_DECLARATIONS = [
  'CONNECTED_TO_FORGE',
  'CONNECTED_TO_CLAUDE_CODE',
  'USES_REAL_PROJECTS',
  'USES_REAL_AGENTS',
  'USES_REAL_COMMANDS',
  'USES_MOCK_DATA',
  'USES_REAL_USAGE_TELEMETRY',
  'SUPPORTS_FILE_ATTACHMENTS',
] as const;

interface CreateProjectResponse {
  readonly created: boolean;
  readonly outcome: 'CREATED' | 'INCOMPLETE' | 'FAILED';
  readonly project: ProjectRecord | null;
  readonly receipt: {
    readonly steps: readonly { readonly id: string; readonly title: string; readonly status: string }[];
    readonly stepsSucceeded: number;
    readonly outcome: string;
  };
  readonly receiptPaths: readonly string[];
}

interface ConversationRecordLite {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
}

describe('bridge lifecycle over the real HTTP + WebSocket protocol', () => {
  let bridge: TestBridge;
  let project: ProjectRecord;
  let createResponse: CreateProjectResponse;
  let conversation: ConversationRecordLite;

  beforeAll(async () => {
    bridge = await startTestBridge();

    // One shared project + conversation that several tests read. Created here so
    // each test does not pay a fresh creation, and so the "registry lists it"
    // and "files bounded to it" tests have a stable subject.
    const created = await bridge.op<CreateProjectResponse>('createProject', {
      displayName: 'Alpha Integration Project',
      type: 'website',
      description: 'Created by the integration suite.',
    });
    if (!created.body.ok) {
      throw new Error(`shared project could not be created: ${JSON.stringify(created.body.error)}`);
    }
    createResponse = created.body.result;
    if (createResponse.project === null) {
      throw new Error(`shared project creation did not yield a record: outcome ${createResponse.outcome}`);
    }
    project = createResponse.project;

    const conv = await bridge.op<{ conversation: ConversationRecordLite }>('createConversation', {
      projectId: project.id,
      title: 'Integration conversation',
    });
    if (!conv.body.ok) throw new Error(`shared conversation could not be created: ${JSON.stringify(conv.body.error)}`);
    conversation = conv.body.result.conversation;
  });

  afterAll(async () => {
    if (bridge !== undefined) {
      if (!bridge.hasExited) {
        await bridge.shutdownGraceful().catch(() => bridge.forceKill());
      }
      bridge.cleanup();
    }
  });

  /* ---------------------------------------------------------------- health */

  it('getHealth reports 39/39 operations and the full set of derived declarations', async () => {
    // 39/39 from the machine-readable ready line the bridge printed at startup…
    expect(bridge.ready.registeredOperations).toHaveLength(EXPECTED_OPERATION_COUNT);
    expect(bridge.ready.unregisteredOperations).toEqual([]);

    // …and confirmed live over the operation surface via exportDiagnostics.
    const diag = await bridge.op<{ router: { registeredOperations: string[]; unregisteredOperations: string[] } }>(
      'exportDiagnostics',
      {},
    );
    expect(diag.body.ok).toBe(true);
    if (!diag.body.ok) return;
    expect(diag.body.result.router.registeredOperations).toHaveLength(EXPECTED_OPERATION_COUNT);
    expect(diag.body.result.router.unregisteredOperations).toEqual([]);

    const health = await bridge.getHealth();
    expect(health.status).toBe(200);
    expect(health.health).not.toBeNull();
    const h = health.health!;
    expect(h.ok).toBe(true);
    expect(h.bindAddress).toBe('127.0.0.1');
    // The bridge listens only on loopback — proven, not asserted in prose.
    expect(h.port).toBe(bridge.port);

    // The invariant half of the declarations is a property of the build.
    expect(h.declarations.invariant.USES_LOCAL_CLAUDE_CODE).toBe(true);
    expect(h.declarations.invariant.USES_ANTHROPIC_API).toBe(false);
    expect(h.declarations.invariant.REQUIRES_ANTHROPIC_API_KEY).toBe(false);
    expect(h.declarations.invariant.LAN_MODE).toBe(false);
    expect(h.declarations.invariant.REMOTE_ACCESS).toBe(false);
    expect(h.declarations.invariant.BIND_ADDRESS).toBe('127.0.0.1');

    // The derived half — all eight present, each a well-formed claim carrying its
    // own evidence and the moment it was checked.
    const derived = h.declarations.derived;
    expect(Object.keys(derived).sort()).toEqual([...EXPECTED_DERIVED_DECLARATIONS].sort());
    for (const name of EXPECTED_DERIVED_DECLARATIONS) {
      const claim = derived[name];
      expect(typeof claim.value).toBe('boolean');
      expect(typeof claim.evidence.summary).toBe('string');
      expect(claim.evidence.summary.length).toBeGreaterThan(0);
      expect(typeof claim.checkedAt).toBe('string');
    }
    // In an isolated bridge no fixture source is loaded: the one derived value
    // whose false IS the required answer.
    expect(derived.USES_MOCK_DATA.value).toBe(false);
    // The registry answered a list request during health assembly, so Forge is
    // connected — a claim earned from a real observation, not a constant.
    expect(derived.CONNECTED_TO_FORGE.value).toBe(true);

    // The projects root the bridge reports is inside our throwaway sandbox, never
    // the real Documents/ForgeProjects.
    expect(h.projectsRoot).toBe(bridge.expectedProjectsRoot);
    expect(h.projectsRoot.startsWith(bridge.baseDir)).toBe(true);
  });

  /* -------------------------------------------------------------- projects */

  it('createProject makes a real folder on disk and returns a receipt with real steps', () => {
    expect(createResponse.created).toBe(true);
    expect(createResponse.outcome).toBe('CREATED');
    expect(project.canonicalPath.startsWith(bridge.expectedProjectsRoot)).toBe(true);

    // The folder is really there.
    expect(existsSync(project.canonicalPath)).toBe(true);
    expect(statSync(project.canonicalPath).isDirectory()).toBe(true);

    // The receipt records real, individually-resolved steps — not a boolean.
    expect(createResponse.receipt.outcome).toBe('CREATED');
    expect(createResponse.receipt.steps.length).toBeGreaterThan(0);
    expect(createResponse.receipt.stepsSucceeded).toBeGreaterThan(0);
    expect(createResponse.receipt.stepsSucceeded).toBe(createResponse.receipt.steps.length);
    for (const step of createResponse.receipt.steps) {
      expect(typeof step.id).toBe('string');
      expect(typeof step.title).toBe('string');
      expect(step.status.length).toBeGreaterThan(0);
    }
    // The receipt was persisted somewhere real too.
    expect(createResponse.receiptPaths.length).toBeGreaterThan(0);
  });

  it('the registry lists the created project', async () => {
    const listed = await bridge.op<{
      count: number;
      projects: readonly { project: ProjectRecord; presentOnDisk: boolean }[];
    }>('listProjects', {});
    expect(listed.body.ok).toBe(true);
    if (!listed.body.ok) return;

    const entry = listed.body.result.projects.find((p) => p.project.id === project.id);
    expect(entry).toBeDefined();
    expect(entry!.project.displayName).toBe('Alpha Integration Project');
    expect(entry!.presentOnDisk).toBe(true);
    expect(entry!.project.canonicalPath).toBe(project.canonicalPath);
  });

  it('createProject is idempotent by requestId', async () => {
    const requestId = 'integration-idempotent-create';
    const payload = { displayName: 'Idempotent Project', type: 'automation' };

    const first = await bridge.op<CreateProjectResponse>('createProject', payload, { requestId });
    const second = await bridge.op<CreateProjectResponse>('createProject', payload, { requestId });

    expect(first.body.ok).toBe(true);
    expect(second.body.ok).toBe(true);
    if (!first.body.ok || !second.body.ok) return;

    // The retry returns the FIRST response verbatim — same project id, not a
    // second creation.
    expect(first.body.result.project).not.toBeNull();
    expect(second.body.result.project?.id).toBe(first.body.result.project?.id);

    // And the registry holds exactly one project by that name, proving the second
    // call never ran the flow again.
    const listed = await bridge.op<{ projects: readonly { project: ProjectRecord }[] }>('listProjects', {});
    expect(listed.body.ok).toBe(true);
    if (!listed.body.ok) return;
    const matches = listed.body.result.projects.filter((p) => p.project.displayName === 'Idempotent Project');
    expect(matches).toHaveLength(1);
  });

  /* --------------------------------------------------------- conversations */

  it('openConversation returns the conversation record it was given', async () => {
    const opened = await bridge.op<{
      project: ProjectRecord;
      conversation: ConversationRecordLite;
    }>('openConversation', { conversationId: conversation.id, projectId: project.id });

    expect(opened.body.ok).toBe(true);
    if (!opened.body.ok) return;
    expect(opened.body.result.conversation.id).toBe(conversation.id);
    expect(opened.body.result.conversation.projectId).toBe(project.id);
    expect(opened.body.result.project.id).toBe(project.id);
  });

  /* ------------------------------------------------------------ attachments */

  it('stageAttachment carries a small text file to READY, then removeAttachment removes it', async () => {
    const attachmentId = 'att-integration-note';
    const contents = 'Forge integration attachment — a small, harmless text note.\n';
    const dataBase64 = Buffer.from(contents, 'utf8').toString('base64');

    const staged = await bridge.op<{
      operation: string;
      accepted: boolean;
      attachmentId: string;
      state: string;
      transitions: readonly { readonly to: string }[];
    }>('stageAttachment', {
      projectId: project.id,
      conversationId: conversation.id,
      attachmentId,
      filename: 'note.txt',
      mediaType: 'text/plain',
      dataBase64,
    });

    expect(staged.body.ok).toBe(true);
    if (!staged.body.ok) return;
    const stage = staged.body.result;
    expect(stage.operation).toBe('stage');
    // READY is only reachable by running the real pipeline to the end.
    expect(stage.accepted).toBe(true);
    expect(stage.state).toBe('READY');
    expect(stage.transitions.some((t) => t.to === 'READY')).toBe(true);

    // It shows up in the listing, observed present on disk.
    const listed = await bridge.op<{
      count: number;
      attachments: readonly { record: { id: string; state: string }; payloadPresent: boolean }[];
    }>('listAttachments', { projectId: project.id, conversationId: conversation.id });
    expect(listed.body.ok).toBe(true);
    if (!listed.body.ok) return;
    const present = listed.body.result.attachments.find((a) => a.record.id === attachmentId);
    expect(present).toBeDefined();
    expect(present!.record.state).toBe('READY');
    expect(present!.payloadPresent).toBe(true);

    // Remove it — and prove it is gone from the active listing.
    const removed = await bridge.op<{ state: string; complete: boolean }>('removeAttachment', {
      projectId: project.id,
      attachmentId,
    });
    expect(removed.body.ok).toBe(true);
    if (!removed.body.ok) return;
    expect(removed.body.result.state).toBe('REMOVED');

    const after = await bridge.op<{
      attachments: readonly { record: { id: string } }[];
    }>('listAttachments', { projectId: project.id, conversationId: conversation.id });
    expect(after.body.ok).toBe(true);
    if (!after.body.ok) return;
    expect(after.body.result.attachments.some((a) => a.record.id === attachmentId)).toBe(false);
  });

  /* ------------------------------------------------------------ file access */

  it('listProjectFiles is bounded to the project it names', async () => {
    const listed = await bridge.op<{
      projectId: string;
      root: string;
      entries: readonly { readonly path: string; readonly kind: string }[];
    }>('listProjectFiles', { projectId: project.id, path: '.' });

    expect(listed.body.ok).toBe(true);
    if (!listed.body.ok) return;
    const result = listed.body.result;
    // The listing is rooted at the project's own canonical path and nowhere else.
    expect(result.root).toBe(project.canonicalPath);
    expect(result.projectId).toBe(project.id);
    // Every entry path is project-relative and stays inside the project.
    for (const entry of result.entries) {
      expect(path.isAbsolute(entry.path)).toBe(false);
      expect(entry.path.includes('..')).toBe(false);
    }
    // A freshly created Forge project has real files (CLAUDE.md, .gitignore, …).
    expect(result.entries.length).toBeGreaterThan(0);
  });

  it('a path-traversal payload is refused, not served', async () => {
    // A dot-dot escape in a listing request.
    const traversalList = await bridge.op('listProjectFiles', { projectId: project.id, path: '../..' });
    expect(traversalList.body.ok).toBe(false);
    if (traversalList.body.ok) return;
    expect(['PATH_REJECTED', 'OUTSIDE_TRUSTED_ROOT']).toContain(traversalList.body.error.code);

    // A dot-dot escape in a file read.
    const traversalRead = await bridge.op('readProjectFile', {
      projectId: project.id,
      path: '../../../Windows/win.ini',
    });
    expect(traversalRead.body.ok).toBe(false);
    if (traversalRead.body.ok) return;
    expect(['PATH_REJECTED', 'OUTSIDE_TRUSTED_ROOT']).toContain(traversalRead.body.error.code);

    // An absolute path, which is not relative to the project at all.
    const absoluteRead = await bridge.op('readProjectFile', {
      projectId: project.id,
      path: 'C:\\Windows\\win.ini',
    });
    expect(absoluteRead.body.ok).toBe(false);
    if (absoluteRead.body.ok) return;
    expect(['PATH_REJECTED', 'OUTSIDE_TRUSTED_ROOT']).toContain(absoluteRead.body.error.code);
  });

  /* ------------------------------------------------------------------- runs */

  it('stopRun on a non-existent run is a clean, typed no-op', async () => {
    const stopped = await bridge.op('stopRun', { runId: 'run-does-not-exist-00000000' });
    // The bridge answers with a typed NOT_FOUND at HTTP 200 — it did not crash,
    // spawn, or kill anything. That is the honest "nothing to stop".
    expect(stopped.httpStatus).toBe(200);
    expect(stopped.body.ok).toBe(false);
    if (stopped.body.ok) return;
    expect(stopped.body.error.code).toBe('NOT_FOUND');

    // And the bridge is still perfectly healthy afterwards.
    const health = await bridge.getHealth();
    expect(health.status).toBe(200);
    expect(health.health?.ok).toBe(true);
  });

  it('drives one real Claude Code run to run.output.complete and COMPLETED (skips if unauthenticated)', async (ctx) => {
    // The guard: consult the bridge's OWN probe. If Claude Code is not proven
    // available and authenticated, skip with the reason rather than fail on a
    // machine without an authenticated CLI.
    const credState = `credentialsBridged=${String(bridge.credentialsBridged)}`;
    const status = await bridge.waitForClaudeProbe(130_000);
    if (status === null) {
      ctx.skip(`Claude Code probe did not complete within the window; cannot verify a real run (${credState}).`);
      return;
    }
    if (!status.available || !status.authenticated) {
      ctx.skip(
        `Claude Code is not usable for a real run (available=${String(status.available)}, ` +
          `authenticated=${String(status.authenticated)}, ${credState}). Note: ${status.note ?? 'none'}`,
      );
      return;
    }

    // A dedicated conversation so this run owns its stream cleanly.
    const conv = await bridge.op<{ conversation: ConversationRecordLite }>('createConversation', {
      projectId: project.id,
      title: 'Real run conversation',
    });
    expect(conv.body.ok).toBe(true);
    if (!conv.body.ok) return;
    const runConversationId = conv.body.result.conversation.id;

    // Subscribe to every stream BEFORE sending, so the run's events are captured
    // live from the first one.
    const ws: WsClient = await bridge.connectWs();
    await ws.subscribeAll();

    const sent = await bridge.op<{ runId: string; streamKey: string; status: string }>('sendMessage', {
      projectId: project.id,
      conversationId: runConversationId,
      message: 'Reply with exactly the single word PONG and nothing else. Do not use any tools.',
      timeoutMs: 120_000,
    });
    expect(sent.body.ok).toBe(true);
    if (!sent.body.ok) {
      ws.close();
      throw new Error(`sendMessage failed: ${JSON.stringify(sent.body.error)}`);
    }
    const runId = sent.body.result.runId;

    // The streamed events must include run.output.complete for this run.
    const complete: ForgeEvent = await ws.waitForEvent(
      (event) => event.type === 'run.output.complete' && event.runId === runId,
      150_000,
    );
    expect(complete.type).toBe('run.output.complete');
    expect(complete.runId).toBe(runId);

    // And the run record must actually reach COMPLETED — proven by polling the
    // run, never assumed from the presence of an event.
    let finalStatus = '';
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const got = await bridge.op<{ run: { status: string } }>('getRun', { runId });
      if (got.body.ok) {
        finalStatus = got.body.result.run.status;
        if (finalStatus === 'COMPLETED') break;
      }
      await delay(500);
    }
    ws.close();
    expect(finalStatus).toBe('COMPLETED');
  });

  /* -------------------------------------------------------------- shutdown */

  it('graceful shutdown leaves no lock and no orphan', async () => {
    // A fresh, dedicated bridge so the shared one keeps serving the other tests.
    const disposable = await startTestBridge();
    try {
      // It is up, healthy, and really holds its workspace lock.
      const before = await disposable.getHealth();
      expect(before.status).toBe(200);
      expect(before.health?.ok).toBe(true);
      expect(disposable.lockExists()).toBe(true);

      const result = await disposable.shutdownGraceful(20_000);

      // The process exited on its own, cleanly — no orphan left running.
      expect(disposable.hasExited).toBe(true);
      expect(result.code).toBe(0);
      expect(result.signal).toBeNull();

      // Its own shutdown report says the cleanup was complete and the lock released.
      expect(result.report).not.toBeNull();
      expect(result.report!.clean).toBe(true);
      expect(result.report!.lockReleased).toBe(true);

      // And the lock file is really gone from disk.
      expect(disposable.lockExists()).toBe(false);
    } finally {
      if (!disposable.hasExited) disposable.forceKill();
      disposable.cleanup();
    }
  });
});
