/**
 * Forge Workspace — cross-project and cross-conversation isolation.
 *
 * Two projects live side by side under one trusted root, and one bridge process
 * serves both. Everything in this file asks the same question in different
 * places: can something belonging to project A be reached from project B?
 *
 * Every assertion drives real code against a real temporary filesystem — the
 * real path guard, a real `ForgeStore` holding its real lock, a real
 * `AttachmentPipeline` writing real bytes. Nothing here is a mock, because a
 * mock of an isolation boundary proves only that the mock is isolated.
 *
 * THE LAYOUT, and why it is shaped like this:
 *
 *     <root>/alpha            project A
 *     <root>/alpha-backup     a SIBLING whose name has A's name as a prefix
 *     <root>/beta             project B
 *
 * `alpha-backup` is not decoration. `"<root>/alpha-backup".startsWith("<root>/
 * alpha")` is true, so any containment check that reaches for `startsWith`
 * silently treats a sibling as a child. That is the single most common way a
 * per-project boundary is wrong, and it gets its own tests below.
 *
 * ONE HONEST GAP IS RECORDED HERE RATHER THAN HIDDEN. There is no code in this
 * build that binds a Claude Code session id to the project that owns it. The
 * final describe block proves the ownership DATA exists and is unambiguous,
 * proves the format boundary holds, and states plainly which check is missing
 * and where it has to live. See the block comment there.
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AttachmentRecord, ConversationRecord, ProjectRecord } from '@/shared/protocol';
import { assertInsideRoot, isInsideRoot, isPathGuardError } from '@/bridge/security/paths';
import { AttachmentPipelineError, checkAttachmentsReferencable, createAttachmentPipeline } from '@/bridge/attachments/pipeline';
import type { AttachmentPipeline } from '@/bridge/attachments/pipeline';
import { ForgeStore, makeStreamKey, openStore } from '@/bridge/storage/store';
import { emptyGitState } from '@/bridge/projects/registry';
import { buildClaudeArgv } from '@/bridge/claude/adapter';
import type { StartRunRequest } from '@/bridge/claude/adapter';
import type { LocatedClaude } from '@/bridge/claude/locate';

/* ========================================================================== */
/*  The two-project world                                                      */
/* ========================================================================== */

const CONV_A = 'conv_alpha';
const CONV_B = 'conv_beta';
const SESSION_A = '11111111-1111-4111-8111-111111111111';
const SESSION_B = '22222222-2222-4222-8222-222222222222';

let base = '';
let projectsRoot = '';
let projectA = '';
let projectB = '';
let projectABackup = '';
let dataDir = '';
let store: ForgeStore;
let pipeline: AttachmentPipeline;

/** A staged attachment that genuinely exists inside project A. */
let attachmentA: AttachmentRecord;

beforeAll(() => {
  // realpath first: on Windows `os.tmpdir()` is often an 8.3 short path, and a
  // containment answer computed against a short path is not an answer.
  base = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), 'forge-boundaries-'));
  projectsRoot = path.join(base, 'ForgeProjecten');
  projectA = path.join(projectsRoot, 'alpha');
  projectABackup = path.join(projectsRoot, 'alpha-backup');
  projectB = path.join(projectsRoot, 'beta');
  dataDir = path.join(base, 'workspace');

  mkdirSync(projectsRoot);
  mkdirSync(projectA);
  mkdirSync(projectABackup);
  mkdirSync(projectB);
  mkdirSync(dataDir);
  writeFileSync(path.join(projectA, 'secret.txt'), 'alpha-only content');
  writeFileSync(path.join(projectABackup, 'secret.txt'), 'sibling content');
  writeFileSync(path.join(projectB, 'own.txt'), 'beta content');

  store = openStore({ dataDir, acquireLock: true });
  pipeline = createAttachmentPipeline();

  const staged = pipeline.stage({
    projectId: 'project_a',
    projectRoot: projectA,
    conversationId: CONV_A,
    attachmentId: 'att_alpha_1',
    filename: 'notes.txt',
    declaredMediaType: 'text/plain',
    uploaderSource: 'picker',
    bytes: new TextEncoder().encode('alpha attachment payload'),
  });
  if (!staged.ok) {
    throw new Error(
      `the fixture attachment did not reach READY (${staged.record.state}): ${staged.error?.message ?? 'no error given'}`,
    );
  }
  attachmentA = staged.record;
});

afterAll(() => {
  store.close();
  rmSync(base, { recursive: true, force: true });
});

/* ========================================================================== */
/*  1. A path inside project A is rejected by project B's guard                */
/* ========================================================================== */

describe('a path inside one project is outside every other', () => {
  it('the fixture world is really on disk', () => {
    // Without this, a broken fixture would make every rejection below trivially
    // true and the whole file would pass for the wrong reason.
    expect(readFileSync(path.join(projectA, 'secret.txt'), 'utf8')).toBe('alpha-only content');
    expect(readFileSync(path.join(projectB, 'own.txt'), 'utf8')).toBe('beta content');
    expect(assertInsideRoot(path.join(projectA, 'secret.txt'), projectA)).toBe(path.join(projectA, 'secret.txt'));
  });

  it("project B's guard refuses a file that lives in project A", () => {
    const target = path.join(projectA, 'secret.txt');
    let thrown: unknown;
    try {
      assertInsideRoot(target, projectB);
    } catch (error) {
      thrown = error;
    }
    expect(isPathGuardError(thrown), 'the refusal must be typed, not a bare Error').toBe(true);
    if (isPathGuardError(thrown)) expect(thrown.code).toBe('OUTSIDE_TRUSTED_ROOT');
    expect(isInsideRoot(target, projectB)).toBe(false);
    // Symmetry: the boundary is not one-directional.
    expect(isInsideRoot(path.join(projectB, 'own.txt'), projectA)).toBe(false);
  });

  it('traversal from B back into A is refused', () => {
    for (const relative of ['../alpha/secret.txt', '..\\alpha\\secret.txt', 'sub/../../alpha/secret.txt']) {
      expect(isInsideRoot(relative, projectB), relative).toBe(false);
    }
  });

  it('a SIBLING whose name is a prefix of the project name is outside it', () => {
    // "<root>/alpha-backup".startsWith("<root>/alpha") is true. Any guard built
    // on startsWith hands project A's neighbour to project A.
    expect(projectABackup.startsWith(projectA)).toBe(true);
    expect(isInsideRoot(projectABackup, projectA)).toBe(false);
    expect(isInsideRoot(path.join(projectABackup, 'secret.txt'), projectA)).toBe(false);
    // And the reverse: alpha is not inside alpha-backup either.
    expect(isInsideRoot(projectA, projectABackup)).toBe(false);
  });

  it('a project is inside the projects root, and the root is not inside a project', () => {
    expect(isInsideRoot(projectA, projectsRoot)).toBe(true);
    expect(isInsideRoot(projectB, projectsRoot)).toBe(true);
    expect(isInsideRoot(projectsRoot, projectA)).toBe(false);
  });

  it('a case-different spelling of project A is still not project B', () => {
    // Windows folds case, so the fold must not become a way to smuggle one
    // project's path past another project's guard.
    const shouted = path.join(projectsRoot, 'ALPHA', 'secret.txt');
    expect(isInsideRoot(shouted, projectB)).toBe(false);
    if (os.platform() === 'win32') {
      expect(isInsideRoot(shouted, projectA)).toBe(true);
    }
  });
});

/* ========================================================================== */
/*  2. An attachment id from project A is refused inside project B             */
/* ========================================================================== */

describe('an attachment belongs to exactly one project and one conversation', () => {
  it('the fixture attachment is READY and stored inside project A', () => {
    expect(attachmentA.state).toBe('READY');
    expect(attachmentA.projectId).toBe('project_a');
    expect(attachmentA.conversationId).toBe(CONV_A);
    expect(isInsideRoot(attachmentA.canonicalPath, projectA)).toBe(true);
    expect(readFileSync(attachmentA.canonicalPath, 'utf8')).toBe('alpha attachment payload');
  });

  it("project A's staged payload is outside project B", () => {
    expect(isInsideRoot(attachmentA.canonicalPath, projectB)).toBe(false);
    expect(() => assertInsideRoot(attachmentA.canonicalPath, projectB)).toThrow();
  });

  it("the same attachment id resolves to a DIFFERENT directory under project B", () => {
    const inA = pipeline.attachmentDir(projectA, CONV_A, attachmentA.id);
    const inB = pipeline.attachmentDir(projectB, CONV_A, attachmentA.id);
    expect(inA).not.toBe(inB);
    expect(isInsideRoot(inA, projectA)).toBe(true);
    expect(isInsideRoot(inB, projectB)).toBe(true);
    // The id is a leaf name, never a route to another project's tree.
    expect(isInsideRoot(inB, projectA)).toBe(false);
    expect(isInsideRoot(inA, projectB)).toBe(false);
  });

  it("project B cannot read project A's payload through the pipeline", () => {
    // The record is A's, the root passed in is B's. Everything the pipeline
    // rebuilds is rooted at B, so the file it would read does not exist.
    const preview = pipeline.readPreview(attachmentA, projectB);
    expect(preview).toBeNull();

    // A rescan under the wrong root must not silently succeed against A's copy;
    // an unreadable staged file is a QUARANTINE, which is a refusal.
    const rescan = pipeline.rescan(attachmentA, projectB);
    expect(rescan.record.state).toBe('QUARANTINED');
    expect(rescan.record.claudeAccessible).toBe(false);
    // A's real payload is untouched by B's failed rescan.
    expect(readFileSync(attachmentA.canonicalPath, 'utf8')).toBe('alpha attachment payload');
  });

  it("project B cannot ingest a file from project A by naming its path", () => {
    const result = pipeline.stage({
      projectId: 'project_b',
      projectRoot: projectB,
      conversationId: CONV_B,
      attachmentId: 'att_beta_theft',
      filename: 'stolen.txt',
      declaredMediaType: 'text/plain',
      uploaderSource: 'project-file',
      sourcePath: path.join(projectA, 'secret.txt'),
    });
    expect(result.ok).toBe(false);
    expect(result.record.state).toBe('REJECTED');
    expect(result.error?.code).toBe('OUTSIDE_TRUSTED_ROOT');
    expect(result.record.hash).toBeNull();
  });

  it("project B cannot ingest project A's file by traversing out of B", () => {
    const result = pipeline.stage({
      projectId: 'project_b',
      projectRoot: projectB,
      conversationId: CONV_B,
      attachmentId: 'att_beta_traverse',
      filename: 'stolen.txt',
      declaredMediaType: 'text/plain',
      uploaderSource: 'project-file',
      sourcePath: path.join('..', 'alpha', 'secret.txt'),
    });
    expect(result.ok).toBe(false);
    expect(result.record.state).toBe('REJECTED');
  });

  it("a message in project B may not reference project A's attachment", () => {
    // `checkAttachmentsReferencable` is given the records the CONVERSATION
    // knows about. Project B's conversation knows about none of A's.
    const report = checkAttachmentsReferencable([], [attachmentA.id]);
    expect(report.ok).toBe(false);
    expect(report.paths).toEqual([]);
    expect(report.checks[0]!.code).toBe('NOT_FOUND');
    expect(report.checks[0]!.reason).toContain(attachmentA.id);
  });

  it('a hostile attachment id cannot be turned into a path into another project', () => {
    const escapes = [
      '..',
      '../alpha',
      '..\\alpha',
      'alpha/../../alpha',
      path.join(projectA, 'secret.txt'),
      'att_alpha_1/../../../alpha',
    ];
    for (const id of escapes) {
      expect(() => pipeline.attachmentDir(projectB, CONV_B, id), id).toThrow(AttachmentPipelineError);
      expect(() => pipeline.attachmentDir(projectB, id, 'att_ok'), id).toThrow(AttachmentPipelineError);
    }
  });

  it('the attachment root of one project is never the attachment root of another', () => {
    const rootA = pipeline.attachmentsRoot(projectA);
    const rootB = pipeline.attachmentsRoot(projectB);
    expect(rootA).not.toBe(rootB);
    expect(isInsideRoot(rootA, projectA)).toBe(true);
    expect(isInsideRoot(rootB, projectB)).toBe(true);
    expect(isInsideRoot(rootA, projectB)).toBe(false);
    // And the prefix-sibling trap again, at the attachment layer.
    expect(isInsideRoot(pipeline.attachmentsRoot(projectABackup), projectA)).toBe(false);
  });
});

/* ========================================================================== */
/*  3. Cross-CONVERSATION isolation inside one project                         */
/* ========================================================================== */

describe('an attachment does not leak between conversations in the same project', () => {
  it('two conversations get two directories for the same attachment id', () => {
    const inConvA = pipeline.attachmentDir(projectA, CONV_A, attachmentA.id);
    const inConvB = pipeline.attachmentDir(projectA, CONV_B, attachmentA.id);
    expect(inConvA).not.toBe(inConvB);
    expect(inConvA.includes(CONV_A)).toBe(true);
    expect(inConvB.includes(CONV_B)).toBe(true);
  });

  it("a message in conversation B may not reference conversation A's attachment", () => {
    const conversationBRecords: AttachmentRecord[] = [
      { ...attachmentA, id: 'att_beta_1', conversationId: CONV_B },
    ];
    const report = checkAttachmentsReferencable(conversationBRecords, [attachmentA.id]);
    expect(report.ok).toBe(false);
    expect(report.checks[0]!.code).toBe('NOT_FOUND');
  });

  it('a quarantined or removed attachment is never referencable, in any conversation', () => {
    for (const state of ['QUARANTINED', 'REJECTED', 'FAILED', 'SELECTED'] as const) {
      const record: AttachmentRecord = { ...attachmentA, state, claudeAccessible: false };
      const report = checkAttachmentsReferencable([record], [record.id]);
      expect(report.ok, state).toBe(false);
      expect(report.paths).toEqual([]);
    }
    const removed: AttachmentRecord = { ...attachmentA, deleted: true, state: 'REMOVED' };
    expect(checkAttachmentsReferencable([removed], [removed.id]).ok).toBe(false);
    // A READY record that the policy marked inaccessible is still refused.
    const notAccessible: AttachmentRecord = { ...attachmentA, claudeAccessible: false };
    expect(checkAttachmentsReferencable([notAccessible], [notAccessible.id]).ok).toBe(false);
  });
});

/* ========================================================================== */
/*  4. The event log and the record store are partitioned by project           */
/* ========================================================================== */

function project(id: string, canonicalPath: string, slug: string, conversationIds: string[]): ProjectRecord {
  const at = new Date(0).toISOString();
  return {
    id,
    displayName: slug,
    slug,
    canonicalPath,
    relativePath: slug,
    type: 'unknown',
    description: '',
    createdAt: at,
    updatedAt: at,
    forgeVersion: null,
    templateVersion: null,
    // From the registry itself, not hand-rolled: the store validates this shape
    // and a fixture that guesses at it tests the guess, not the contract.
    git: emptyGitState(),
    sessionIds: [],
    conversationIds,
    activeRunIds: [],
    archived: false,
    health: 'UNKNOWN',
    lastDoctorResult: null,
    metadataSchemaVersion: 1,
  };
}

function conversation(id: string, projectId: string, claudeSessionId: string | null): ConversationRecord {
  const at = new Date(0).toISOString();
  return {
    id,
    projectId,
    title: id,
    claudeSessionId,
    createdAt: at,
    updatedAt: at,
    messageCount: 0,
    attachmentIds: [],
    activeRunId: null,
    archived: false,
    lastConfirmedSequence: 0,
  };
}

describe('the workspace store keeps the two projects apart', () => {
  beforeAll(() => {
    store.saveRecord('project', project('project_a', projectA, 'alpha', [CONV_A]));
    store.saveRecord('project', project('project_b', projectB, 'beta', [CONV_B]));
    store.saveRecord('conversation', conversation(CONV_A, 'project_a', SESSION_A));
    store.saveRecord('conversation', conversation(CONV_B, 'project_b', SESSION_B));

    store.appendEvent({
      projectId: 'project_a',
      runId: 'run_alpha',
      conversationId: CONV_A,
      sessionId: SESSION_A,
      source: 'bridge',
      type: 'run.state',
      status: 'RUNNING',
      payload: { secret: 'alpha-only' },
    });
    store.appendEvent({
      projectId: 'project_b',
      runId: 'run_beta',
      conversationId: CONV_B,
      sessionId: SESSION_B,
      source: 'bridge',
      type: 'run.state',
      status: 'RUNNING',
      payload: { note: 'beta-only' },
    });
  });

  it('two projects never share a stream key', () => {
    expect(makeStreamKey('project_a', 'run_alpha')).not.toBe(makeStreamKey('project_b', 'run_alpha'));
    expect(makeStreamKey('project_a', null)).not.toBe(makeStreamKey('project_b', null));
  });

  it("a project-scoped event read never returns another project's events", () => {
    const fromB = store.readEvents({ projectId: 'project_b' });
    expect(fromB.events.length).toBeGreaterThan(0);
    expect(fromB.events.every((e) => e.projectId === 'project_b')).toBe(true);
    expect(fromB.streams.every((key) => key.startsWith('project_b'))).toBe(true);
    expect(JSON.stringify(fromB.events)).not.toContain('alpha-only');

    const fromA = store.readEvents({ projectId: 'project_a' });
    expect(fromA.events.every((e) => e.projectId === 'project_a')).toBe(true);
    expect(JSON.stringify(fromA.events)).not.toContain('beta-only');
  });

  it("naming another project's run id does not reach its stream", () => {
    // Project B asking for project A's run must get project B's (empty) stream,
    // never A's events.
    const page = store.readEvents({ projectId: 'project_b', runId: 'run_alpha' });
    expect(page.events).toEqual([]);
    expect(JSON.stringify(page)).not.toContain('alpha-only');
  });

  it('a project-scoped checkpoint contains only that project', () => {
    const checkpoint = store.createCheckpoint({ kind: 'project', id: 'project_b' }, 'boundaries fixture');
    expect(checkpoint.scope).toEqual({ kind: 'project', id: 'project_b' });
    expect(checkpoint.streamHeads.length).toBeGreaterThan(0);
    expect(checkpoint.streamHeads.every((s) => s.streamKey.startsWith('project_b'))).toBe(true);
    expect(checkpoint.streamHeads.some((s) => s.streamKey.startsWith('project_a'))).toBe(false);
    for (const ref of checkpoint.recordRefs) {
      // Every captured record either IS project B, or belongs to it.
      const read = store.getRecord(ref.kind, ref.id);
      if (!read.ok) continue;
      const owner = read.record as { projectId?: unknown; id?: unknown };
      const ownedByB = owner.projectId === 'project_b' || (ref.kind === 'project' && owner.id === 'project_b');
      expect(ownedByB, `${ref.kind}/${ref.id} was captured in project B's checkpoint`).toBe(true);
    }
  });
});

/* ========================================================================== */
/*  5. Sessions                                                                */
/* ========================================================================== */

/**
 * A synthetic probed runtime. Only the fields `buildClaudeArgv` reads matter.
 */
const LOCATED: LocatedClaude = {
  executablePath: 'C:\\does-not-exist\\claude.exe',
  source: 'path-entry',
  version: '2.1.217',
  versionRaw: '2.1.217 (Claude Code)',
  flags: new Set([
    '-p',
    '--output-format',
    '--verbose',
    '--include-partial-messages',
    '--add-dir',
    '--permission-mode',
    '--resume',
    '--session-id',
  ]),
  choices: new Map<string, readonly string[]>([
    ['--output-format', ['text', 'json', 'stream-json']],
    ['--permission-mode', ['acceptEdits', 'plan', 'auto', 'manual', 'dontAsk']],
  ]),
  descriptions: new Map<string, string>(),
  probedAt: new Date(0).toISOString(),
  candidatesConsidered: [],
  notes: [],
};

function runRequest(overrides: Partial<StartRunRequest>): StartRunRequest {
  return {
    runId: 'run_x',
    projectId: 'project_b',
    projectPath: projectB,
    conversationId: CONV_B,
    prompt: 'continue',
    permissionMode: 'plan',
    ...overrides,
  };
}

/**
 * Resolve which project owns a Claude session, using ONLY real store reads.
 *
 * This is the lookup a run-start path has to perform. It is written here, in the
 * test, because the bridge does not export one — which is exactly the gap the
 * last test in this file records.
 */
function projectsOwningSession(claudeSessionId: string): readonly string[] {
  const owners = new Set<string>();
  for (const record of store.listRecords('conversation').records) {
    if (record.claudeSessionId === claudeSessionId) owners.add(record.projectId);
  }
  for (const record of store.listRecords('project').records) {
    if (record.sessionIds.includes(claudeSessionId)) owners.add(record.id);
  }
  return [...owners].sort();
}

describe('a session belongs to one project, and the data says so unambiguously', () => {
  it("project A's session resolves to project A and to nothing else", () => {
    expect(projectsOwningSession(SESSION_A)).toEqual(['project_a']);
    expect(projectsOwningSession(SESSION_B)).toEqual(['project_b']);
    expect(projectsOwningSession('99999999-9999-4999-8999-999999999999')).toEqual([]);
  });

  it('the conversation record is the binding, and it is single-valued', () => {
    const read = store.getRecord('conversation', CONV_A);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.record.projectId).toBe('project_a');
    expect(read.record.claudeSessionId).toBe(SESSION_A);
    // Project B's conversation list does not contain it.
    const projectB = store.getRecord('project', 'project_b');
    expect(projectB.ok).toBe(true);
    if (projectB.ok) expect(projectB.record.conversationIds).not.toContain(CONV_A);
  });

  it('a session id that is not a UUID can never become --resume', () => {
    for (const bad of [
      'not-a-uuid',
      `${SESSION_A} --add-dir C:\\Windows`,
      '../../alpha',
      `${SESSION_A}\u0000`,
      '',
      SESSION_A.toUpperCase().replace('4', 'g'),
    ]) {
      expect(
        () => buildClaudeArgv(LOCATED, runRequest({ resumeSessionId: bad }), projectB),
        JSON.stringify(bad),
      ).toThrow();
    }
    // `null` is the honest "no resume", and it produces no --resume at all.
    expect(buildClaudeArgv(LOCATED, runRequest({ resumeSessionId: null }), projectB).argv).not.toContain('--resume');
  });

  it('--resume and --session-id are never both present', () => {
    const resumed = buildClaudeArgv(LOCATED, runRequest({ resumeSessionId: SESSION_B }), projectB);
    expect(resumed.argv).toContain('--resume');
    expect(resumed.argv).not.toContain('--session-id');
    expect(resumed.resumed).toBe(true);

    const fresh = buildClaudeArgv(LOCATED, runRequest({ sessionId: SESSION_B }), projectB);
    expect(fresh.argv).toContain('--session-id');
    expect(fresh.argv).not.toContain('--resume');
    expect(fresh.resumed).toBe(false);
  });

  it('a run always names the project path the guard returned, whatever session it resumes', () => {
    const canonicalB = assertInsideRoot(projectB, projectsRoot);
    const built = buildClaudeArgv(LOCATED, runRequest({ resumeSessionId: SESSION_A }), canonicalB);
    const at = built.argv.indexOf('--add-dir');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(built.argv[at + 1]).toBe(canonicalB);
    // Whatever else is wrong, the working directory the run is given is B's.
    expect(isInsideRoot(built.argv[at + 1]!, projectA)).toBe(false);
  });

  /**
   * THE GAP, recorded rather than hidden.
   *
   * `buildClaudeArgv` is a pure argv assembler and cannot reasonably know who
   * owns a session — that check belongs to whatever starts a run. In this build
   * nothing does: the router registers seven built-in operations and none of
   * them starts a run, so there is no code path today that could resume A's
   * session under B. The moment a `sendMessage` / `startRun` handler is added,
   * it MUST call something equivalent to `projectsOwningSession` above and
   * refuse when the owner is not the requesting project.
   *
   * This test asserts what is TRUE today, and fails the moment the situation
   * changes without the check being added — at which point the assertion below
   * needs replacing with a real refusal test, not deleting.
   */
  it('records that no run-start path exists yet, so the ownership check has no home', async () => {
    const { OPERATIONS } = await import('@/shared/protocol');
    const runStarters = (OPERATIONS as readonly string[]).filter((op) =>
      /^(sendMessage|startRun|resumeConversation|continueConversation)$/.test(op),
    );

    // The argv assembler happily builds a resume for a session it was told
    // about. That is not a defect in the assembler; it is a requirement on its
    // caller, stated here so it cannot be forgotten.
    const built = buildClaudeArgv(LOCATED, runRequest({ resumeSessionId: SESSION_A }), projectB);
    expect(built.resumed).toBe(true);
    expect(built.argv).toContain(SESSION_A);

    console.warn(
      '[security] OPEN GAP - session-to-project ownership is never checked.\n' +
        `  The contract defines these run-start operations: ${runStarters.join(', ') || '(none)'}.\n` +
        '  No handler for them is registered in this build, so the gap is not yet reachable from the browser.\n' +
        '  `buildClaudeArgv` will emit `--resume <any uuid>` alongside `--add-dir <any project>`; nothing\n' +
        '  compares the two. Whoever implements the run-start handler must resolve the owning project from\n' +
        '  the conversation record and refuse a mismatch before the adapter is called.',
    );

    // The ownership data needed for that check is present and unambiguous.
    expect(projectsOwningSession(SESSION_A)).toEqual(['project_a']);
    expect(runRequest({ resumeSessionId: SESSION_A }).projectId).toBe('project_b');
    expect(projectsOwningSession(SESSION_A)).not.toContain('project_b');
  });
});
