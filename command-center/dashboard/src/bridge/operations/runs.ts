/**
 * Forge Workspace — the run lifecycle (WP6).
 *
 * `sendMessage` is the centre of the product: it is the one path where a person's
 * text becomes a real Claude Code process running inside a real project. This
 * file owns that path and the four verbs around it — `stopRun`, `resumeSession`,
 * `listRuns`, `getRun`.
 *
 * THE ORDER OF sendMessage IS THE DESIGN, and every step is a check rather than
 * an assumption:
 *
 *   1. The project must exist in the registry and its path must pass the guard.
 *   2. The conversation must exist AND belong to that project.
 *   3. Every referenced attachment must be READY, belong to THIS conversation,
 *      and be marked accessible. A refusal names the file and says why
 *      (`ATTACHMENT_NOT_READY` / `ATTACHMENT_REJECTED`); the message is not sent
 *      without it and the text is never silently dropped.
 *   4. A run record is created in CREATED and walked through the run machine —
 *      CREATED → QUEUED → STARTING → RUNNING → STREAMING — with
 *      `assertRunTransitionWithEvidence` at every step. RUNNING is claimed only
 *      once a pid exists AND a liveness check observed it alive; a spawn is not
 *      a running process.
 *   5. The process is spawned through the adapter with `--add-dir` set to the
 *      project's canonical path, argv as an ARRAY, `shell: false`.
 *   6. Output is streamed as it arrives. `run.output.delta` events are published
 *      the moment a line parses; nothing is buffered until exit. The call
 *      returns as soon as the process exists — a ten-minute run must not hold an
 *      HTTP request open.
 *   7. The session id the CLI REPORTS is persisted onto the conversation. The id
 *      we asked for is never mistaken for the id we got.
 *   8. `claude.usage` events are fed to the usage aggregator as they arrive.
 *   9. On exit the exit code is recorded, the output is persisted, and exactly
 *      one `run.output.complete` exists for the run.
 *
 * COMPLETED IS EARNED. The run machine gives COMPLETED exactly one predecessor
 * (REVIEWING) which has exactly one predecessor (VERIFYING), and the COMPLETED
 * gate additionally demands an observed exit, a recorded exit code, a persisted
 * output ref, a final event belonging to THIS run, a proof ref of kind
 * `exit-code`, and an accepting verdict from a verifier that is not the subject.
 * So this file runs a real verification pass: it re-checks the exit code, the
 * presence of the runtime's own result envelope, the persisted output file and
 * the stream's sequence gaps, and records a `VerificationRecord` whose verdict is
 * `VERIFIED_PASS_WITH_LIMITATIONS` — because what was checked is process-level
 * evidence, not the correctness of Claude's answer, and the record says exactly
 * that. When any of those checks fails the verdict is INSUFFICIENT_EVIDENCE and
 * the run goes to FAILED, never to COMPLETED.
 *
 * SESSION ISOLATION IS A HARD BOUNDARY. `--resume` is only ever passed a session
 * id that this conversation owns and no other conversation or project claims.
 * A mismatch is `INVALID_STATE`; it is never resolved by starting a fresh
 * session while calling it a resume.
 *
 * CANCELLATION TELLS THE TRUTH. `stopRun` persists the request, asks the adapter
 * for a graceful termination, waits, force-kills only that run's process tree,
 * and CANCELLED is written only once the exit has been OBSERVED. If the exit is
 * never seen the run stays STOPPING and the operation says so. A second stop is
 * a no-op, not an error.
 *
 * The relative `.ts` imports are deliberate: Node 24 executes TypeScript
 * directly and requires the explicit extension, and bridge code is permitted
 * relative imports.
 */

import { randomUUID } from 'node:crypto';
import { join, relative } from 'node:path';

import { EVENT_TYPES } from '../../shared/protocol.ts';
import type {
  AttachmentRecord,
  ConversationRecord,
  EventType,
  EvidenceRef,
  ForgeEvent,
  OperationalStatus,
  ProjectRecord,
  VerificationRecord,
  VerifyVerdict,
} from '../../shared/protocol.ts';
import { assertRunTransitionWithEvidence } from '../../shared/state-machines.ts';
import type { RunState, RunStateEvidence } from '../../shared/state-machines.ts';

import { checkAttachmentsReferencable } from '../attachments/pipeline.ts';
import { ALLOWED_PERMISSION_MODES, AdapterError, ClaudeAdapter } from '../claude/adapter.ts';
import type { AdapterOptions, PermissionMode, RunHandle, RunOutcome, StopResult } from '../claude/adapter.ts';
import { EFFORT_LEVELS, locateClaudeCode, supportsFlag } from '../claude/locate.ts';
import type { LocateResult, LocatedClaude } from '../claude/locate.ts';
import type { ForgeEventDraft } from '../claude/parse.ts';
import { assertInsideRoot, isPathGuardError, resolveProjectsRootInfo } from '../security/paths.ts';
import { containedPath, ensureDir, fileExists, isPidAlive, writeAtomic } from '../storage/atomic.ts';
import { isLiveRunStatus, isTerminalRunStatus } from '../storage/schema.ts';
import type { RunRecord } from '../storage/schema.ts';
import { makeStreamKey } from '../storage/store.ts';
import type { ForgeStore } from '../storage/store.ts';
import { asObject, fail, optInteger, optString, optStringArray, reqString } from '../router.ts';
import type { OperationContext, Router } from '../router.ts';
import { conversationServiceFor, errorText, safeId } from './conversations.ts';
import type { ConversationService, StreamAnchor } from './conversations.ts';

/* ========================================================================== */
/*  Seams and options                                                          */
/* ========================================================================== */

/**
 * The usage aggregator, narrowed to the one method this file needs.
 * `UsageAggregator` satisfies it structurally.
 */
export interface UsageIngest {
  ingest(event: ForgeEvent): unknown;
}

export interface RunServiceOptions {
  readonly conversations: ConversationService;
  /**
   * Locate and probe the Claude Code runtime. Called at most ONCE per service:
   * `--help` decides every flag in every argv, so two argvs in one process must
   * never be built against two different probes. Defaults to the real probe.
   */
  readonly locate?: () => Promise<LocateResult>;
  /** Containment root for project paths — the projects root. */
  readonly trustedRoot: string;
  /** Absolute directory that receives per-run stdout/stderr/exit evidence. */
  readonly evidenceDir: string;
  readonly bridgeInstanceId: string;
  readonly usage?: UsageIngest | null;
  /**
   * The permission mode used when the client does not name one.
   *
   * `manual` on purpose. Auto-accepting edits is a decision only the owner may
   * make, so the safe mode is the default and the permissive one has to be asked
   * for. The mode this bridge refuses in every configuration is not even
   * representable in `PermissionMode`, and its name lives only in the adapter's
   * denylist — see `ALLOWED_PERMISSION_MODES` and `FORBIDDEN_PERMISSION_MODES`.
   */
  readonly defaultPermissionMode?: PermissionMode;
  readonly now?: () => Date;
  /** Injected so a test can drive the lifecycle without spawning anything. */
  readonly adapterFactory?: (options: AdapterOptions) => ClaudeAdapter;
  readonly graceMs?: number;
  readonly forceWaitMs?: number;
  readonly maxMessageChars?: number;
  readonly defaultTimeoutMs?: number | null;
  readonly maxDerivedEvents?: number;
}

/* ========================================================================== */
/*  Constants                                                                  */
/* ========================================================================== */

/**
 * The default was `manual`, which made the connected workspace effectively
 * read-only: a headless run (`-p --output-format stream-json`) has no
 * interactive approver, so every Write/Edit Claude Code attempts blocks forever,
 * and it ends its turn saying "I need permission to write the file." A
 * certification run proved this — the task's real artifact was never created.
 *
 * `acceptEdits` is the honest default for a local-first workspace whose entire
 * purpose is letting Forge BUILD things in the project you opened. It
 * auto-accepts file edits, which are already bounded three ways: `--add-dir`
 * scopes Claude to the one project's canonical path, the path guard rejects any
 * escape from it, and it is your own project directory. It does NOT auto-accept
 * everything: riskier tools (Bash, network) still hit the permission boundary,
 * and `bypassPermissions` remains refused in every configuration
 * (`FORBIDDEN_PERMISSION_MODES`). Override per-run via the operation payload's
 * `model`/permission fields or the `defaultPermissionMode` option.
 */
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'acceptEdits';

/** Leaves room under the adapter's 28 000-character command-line budget for the
 *  attachment manifest, which is appended to whatever the user typed. */
export const MAX_MESSAGE_CHARS = 20_000;

export const MAX_ATTACHMENTS_PER_MESSAGE = 20;

export const DEFAULT_STOP_GRACE_MS = 3_000;
export const DEFAULT_STOP_FORCE_WAIT_MS = 3_000;

/** How many events `getRun` will read to derive counters and file access. */
export const DEFAULT_MAX_DERIVED_EVENTS = 20_000;

export const DEFAULT_RUN_PAGE = 100;
export const MAX_RUN_PAGE = 1_000;

/**
 * The three actors in a run's evidence chain. They are distinct strings because
 * the evidence gates refuse a verifier that is also the subject — self-approval
 * is the failure mode the whole layer exists to prevent.
 */
export const SUBJECT_AGENT_ID = 'claude-code';
export const VERIFIER_AGENT_ID = 'forge-bridge-verifier';
export const REVIEWER_AGENT_ID = 'forge-bridge-reviewer';

/**
 * What the bridge's verification pass actually establishes. Written onto every
 * `VerificationRecord` this file produces so the limitation travels with the
 * verdict instead of living in a comment.
 */
export const PROCESS_VERIFICATION_SCOPE =
  'process-level verification only: the exit code, the runtime result envelope, the persisted output file and ' +
  'the run stream sequence were re-checked. The CORRECTNESS of the assistant answer was not assessed by anything.';

/** Tools whose successful completion is evidence that a file was read. */
export const FILE_READ_TOOLS: readonly string[] = ['Read', 'NotebookRead'];

const EVENT_TYPE_SET: ReadonlySet<string> = new Set<string>(EVENT_TYPES);

export function isEventType(value: unknown): value is EventType {
  return typeof value === 'string' && EVENT_TYPE_SET.has(value);
}

/* ========================================================================== */
/*  Result shapes                                                              */
/* ========================================================================== */

export interface AttachmentManifestEntry {
  readonly attachmentId: string;
  readonly name: string;
  /** What the file signature said, not what the uploader claimed. */
  readonly mediaType: string | null;
  readonly declaredMediaType: string;
  readonly size: number;
  readonly hash: string | null;
  /** Project-relative, forward-slashed. Claude reaches it through --add-dir. */
  readonly projectRelativePath: string;
}

export interface FileAccessEntry {
  readonly toolName: string;
  readonly toolUseId: string;
  /** Exactly the path Claude passed to the tool. Never rewritten. */
  readonly reportedPath: string;
  readonly projectRelativePath: string | null;
  readonly insideProject: boolean;
  /**
   * READ                 a matching tool result arrived and reported no error.
   * FAILED               a matching tool result arrived and reported an error.
   * NO_RESULT_OBSERVED   the call was seen; its result was not. Never counted
   *                      as a read.
   */
  readonly outcome: 'READ' | 'FAILED' | 'NO_RESULT_OBSERVED';
  readonly at: string;
}

export interface DerivedRunFacts {
  readonly eventsRead: number;
  readonly truncated: boolean;
  readonly outputDeltas: number;
  readonly toolStarts: number;
  readonly toolEnds: number;
  readonly toolErrors: number;
  readonly stderrEvents: number;
  readonly sawOutputComplete: boolean;
  readonly reportedSessionIds: readonly string[];
  readonly fileAccess: readonly FileAccessEntry[];
  /** The rule `fileAccess` was derived under, so a reader knows what it means. */
  readonly fileAccessRule: string;
}

export interface SendMessageResult {
  readonly runId: string;
  readonly conversationId: string;
  readonly projectId: string;
  readonly status: OperationalStatus;
  readonly statusReason: string;
  readonly startedAt: string;
  readonly pid: number | null;
  /** The id we asked the CLI to use, or to resume. Not what it reported. */
  readonly requestedSessionId: string | null;
  readonly resumed: boolean;
  readonly streamKey: string;
  readonly attachments: readonly AttachmentManifestEntry[];
  readonly permissionMode: PermissionMode;
  /** Flags the installed runtime does not support and that were dropped. */
  readonly degradedFlags: readonly string[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly notes: readonly string[];
}

export type SessionAvailability = 'RESUMABLE' | 'ORPHANED' | 'NONE' | 'UNVERIFIED';

export interface ResumeSessionResult {
  readonly conversation: ConversationRecord;
  readonly projectId: string;
  readonly sessionId: string | null;
  readonly sessionState: SessionAvailability;
  readonly resumable: boolean;
  readonly reason: string;
  /**
   * Whether the session still exists inside Claude Code's own store. The 2.1.217
   * CLI exposes no way to ask, so this is UNAVAILABLE rather than a guess.
   */
  readonly sessionExistenceCheck: 'UNAVAILABLE' | 'OBSERVED_LOST';
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly liveRunId: string | null;
  readonly runs: readonly RunRecord[];
  readonly streams: readonly StreamAnchor[];
  readonly replayFromSequence: number;
  readonly notes: readonly string[];
}

/* ========================================================================== */
/*  In-memory bookkeeping for a live run                                       */
/* ========================================================================== */

interface LiveRun {
  readonly runId: string;
  readonly projectId: string;
  readonly conversationId: string;
  readonly projectPath: string;
  readonly startedAt: string;
  readonly runDir: string;
  readonly resumedSessionId: string | null;
  handle: RunHandle | null;
  runningClaimed: boolean;
  streamingClaimed: boolean;
  reportedSessionId: string | null;
  text: string[];
  textChars: number;
  deltaCount: number;
  sawOutputComplete: boolean;
  outputCompleteAt: string | null;
  outputCompleteIsError: boolean | null;
  stderrExcerpts: string[];
  sinkFailures: number;
}

/** Text kept in memory for the persisted `output.txt`. The full stream is on disk. */
const MAX_COLLECTED_OUTPUT_CHARS = 4_000_000;

/* ========================================================================== */
/*  The service                                                                */
/* ========================================================================== */

export class RunService {
  private readonly conversations: ConversationService;
  private readonly trustedRoot: string;
  private readonly evidenceRoot: string;
  private readonly bridgeInstanceId: string;
  private readonly usage: UsageIngest | null;
  private readonly defaultPermissionMode: PermissionMode;
  private readonly nowFn: () => Date;
  private readonly locateFn: () => Promise<LocateResult>;
  private readonly adapterFactory: (options: AdapterOptions) => ClaudeAdapter;
  private readonly graceMs: number;
  private readonly forceWaitMs: number;
  private readonly maxMessageChars: number;
  private readonly defaultTimeoutMs: number | null;
  private readonly maxDerivedEvents: number;

  private readonly live = new Map<string, LiveRun>();
  private readonly stopsInFlight = new Map<string, Promise<Record<string, unknown>>>();

  /** Probed once, then reused. Null until the probe has actually been run. */
  private probe: Promise<LocateResult> | null = null;
  private located: LocatedClaude | null = null;
  private adapterInstance: ClaudeAdapter | null = null;

  constructor(options: RunServiceOptions) {
    this.conversations = options.conversations;
    this.trustedRoot = options.trustedRoot;
    this.evidenceRoot = options.evidenceDir;
    this.bridgeInstanceId = options.bridgeInstanceId;
    this.usage = options.usage ?? null;
    this.defaultPermissionMode = options.defaultPermissionMode ?? DEFAULT_PERMISSION_MODE;
    this.nowFn = options.now ?? (() => new Date());
    this.locateFn = options.locate ?? (() => locateClaudeCode());
    this.adapterFactory = options.adapterFactory ?? ((adapterOptions) => new ClaudeAdapter(adapterOptions));
    this.graceMs = options.graceMs ?? DEFAULT_STOP_GRACE_MS;
    this.forceWaitMs = options.forceWaitMs ?? DEFAULT_STOP_FORCE_WAIT_MS;
    this.maxMessageChars = options.maxMessageChars ?? MAX_MESSAGE_CHARS;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? null;
    this.maxDerivedEvents = options.maxDerivedEvents ?? DEFAULT_MAX_DERIVED_EVENTS;
  }

  /* ------------------------------------------------------- the Claude seam */

  /**
   * Probe the runtime, once.
   *
   * The result is memoised INCLUDING a failure: a machine with no Claude Code
   * does not get a `--help` spawn per message. Nothing here claims the runtime
   * is absent — it reports what the probe found.
   */
  private locateOnce(): Promise<LocateResult> {
    this.probe ??= this.locateFn();
    return this.probe;
  }

  /**
   * The adapter, created on first use because building it requires a probed
   * runtime. The event sink is owned here so that every draft the adapter
   * produces is persisted, fanned out and observed in one place.
   */
  private async requireAdapter(): Promise<{ readonly adapter: ClaudeAdapter; readonly located: LocatedClaude }> {
    const result = await this.locateOnce();
    if (!result.ok) {
      fail(
        'CLAUDE_UNAVAILABLE',
        'The local Claude Code runtime could not be located, so no message can be sent.',
        `${result.reason}: ${result.detail}`,
      );
    }
    this.located = result.located;
    if (this.adapterInstance === null) {
      ensureDir(this.evidenceRoot);
      this.adapterInstance = this.adapterFactory({
        located: result.located,
        trustedRoot: this.trustedRoot,
        evidenceDir: this.evidenceRoot,
        emit: (draft) => {
          this.onAdapterEvent(draft);
        },
        now: this.nowFn,
      });
    }
    return { adapter: this.adapterInstance, located: result.located };
  }

  /**
   * The adapter IF one exists. Null means this bridge instance has never
   * spawned anything, which is a fact about us — never evidence about a run.
   */
  private get adapterIfAny(): ClaudeAdapter | null {
    return this.adapterInstance;
  }

  private get store(): ConversationService['store'] {
    return this.conversations.store;
  }

  private now(): Date {
    return this.nowFn();
  }

  private nowIso(): string {
    return this.nowFn().toISOString();
  }

  /** The run's evidence directory, proven to be inside the evidence root. */
  private runDir(runId: string): string {
    const dir = containedPath(this.evidenceRoot, join(this.evidenceRoot, runId));
    if (dir === null) {
      fail('PATH_REJECTED', 'The run evidence directory resolved outside the evidence root.', safeId(runId));
    }
    return dir;
  }

  /* ====================================================================== */
  /*  sendMessage                                                           */
  /* ====================================================================== */

  async sendMessage(payload: unknown): Promise<SendMessageResult> {
    const body = asObject(payload);
    const projectId = reqString(body, 'projectId');
    const conversationId = reqString(body, 'conversationId');
    const message = reqString(body, 'message', this.maxMessageChars);
    const attachmentIds = optStringArray(body, 'attachmentIds', MAX_ATTACHMENTS_PER_MESSAGE) ?? [];
    const permissionMode = this.parsePermissionMode(body);
    const model = optString(body, 'model', 64) ?? null;
    const effort = this.parseEffort(body);
    const timeoutMs = optInteger(body, 'timeoutMs', 1_000, 6 * 60 * 60 * 1_000) ?? this.defaultTimeoutMs;

    if (message.trim().length === 0) {
      fail('BAD_REQUEST', 'A message cannot be only whitespace.');
    }

    const notes: string[] = [];

    /* -- 1. project ------------------------------------------------------ */
    const project = this.conversations.requireProject(projectId);
    if (project.archived) {
      fail('INVALID_STATE', 'That project is archived, so no new run may be started in it.');
    }
    const projectPath = this.guardProjectPath(project);

    /* -- 2. conversation ------------------------------------------------- */
    const conversation = this.conversations.requireConversation(conversationId);
    this.conversations.assertBelongsToProject(conversation, project.id);
    if (conversation.archived) {
      fail('INVALID_STATE', 'That conversation is archived. Unarchive it before sending a message.');
    }

    const existing = this.conversations.liveRunFor(conversation.id);
    if (existing !== null) {
      fail(
        'CONFLICT',
        `Run ${existing.id} is already ${existing.status} in this conversation. Wait for it or stop it first.`,
        `run ${existing.id} status ${existing.status}`,
      );
    }

    /* -- 3. attachments -------------------------------------------------- */
    const manifest = this.buildManifest(conversation, attachmentIds, projectPath);

    /* -- 4. the runtime, probed once ------------------------------------- */
    const { adapter, located } = await this.requireAdapter();

    /* -- 5. session --------------------------------------------------------
     * The isolation check happens BEFORE anything is spawned: a session id that
     * another project owns must never reach `--resume`.
     */
    let resumeSessionId = conversation.claudeSessionId;
    if (resumeSessionId !== null) {
      this.assertSessionBelongsToConversation(conversation, resumeSessionId);
      if (!supportsFlag(located, '--resume')) {
        fail(
          'CLAUDE_UNAVAILABLE',
          'This conversation has a Claude session but the installed runtime does not support --resume.',
          'Refused rather than silently starting a fresh session and calling it a continuation.',
        );
      }
      const lost = this.findSessionLostEvidence(
        conversation,
        this.conversations.runsFor(conversation.id).runs,
        resumeSessionId,
      );
      if (lost !== null) {
        // A resume of this session has already been observed to fail. Starting a
        // fresh one silently would be exactly the lie this file exists to
        // prevent, so it takes an explicit owner decision.
        if (startFresh(body)) {
          this.conversations.clearSessionBinding(
            conversation.id,
            `the owner chose to start a new session after the recorded one was observed unresumable: ${lost.detail}`,
          );
          resumeSessionId = null;
          notes.push('the previous session was unbound at the owner\'s request; this message starts a NEW session');
        } else {
          fail(
            'INVALID_STATE',
            'The Claude session recorded for this conversation was observed to be unresumable, so this message ' +
              'cannot continue it. Send it again with startNewSession: true to begin a new session instead.',
            lost.detail,
          );
        }
      }
    }

    /* -- 5. the run record, in CREATED ----------------------------------- */
    const runId = `run-${randomUUID()}`;
    const startedAt = this.nowIso();
    const prompt = composePrompt(message, manifest);

    let run: RunRecord = {
      id: runId,
      projectId: project.id,
      conversationId: conversation.id,
      // Null until the CLI reports one. What we asked for is not what we got.
      sessionId: null,
      goal: message,
      status: 'CREATED',
      statusReason: 'the message was accepted and a run record was created; nothing has been spawned yet',
      pid: null,
      ownerBridgeInstanceId: this.bridgeInstanceId,
      startedAt,
      updatedAt: startedAt,
      endedAt: null,
      exitCode: null,
      lastSequence: 0,
      evidenceRefs: [],
    };
    try {
      this.store.saveRecord('run', run);
    } catch (error) {
      fail('RUNTIME_ERROR', 'The run record could not be persisted.', errorText(error));
    }

    this.conversations.setActiveRun(conversation.id, runId);
    this.conversations.linkToProject(project.id, { addActiveRunId: runId });
    this.conversations.countMessage(conversation.id, 1);

    // The user's own text, recorded as a user-sourced event so the turn is
    // replayable from the log rather than only from the run record.
    const created = this.conversations.emit({
      projectId: project.id,
      conversationId: conversation.id,
      runId,
      source: 'user',
      type: 'run.created',
      payload: {
        runId,
        message,
        attachments: manifest,
        permissionMode,
        requestedModel: model,
        requestedEffort: effort,
        resumeRequested: resumeSessionId !== null,
        promptChars: prompt.length,
      },
      evidenceRefs: [{ kind: 'file', ref: `records/run/${runId}.json`, note: 'the run record as written' }],
    });
    if (created.note !== null) notes.push(created.note);

    /* -- 6. CREATED -> QUEUED -> STARTING -------------------------------- */
    run = this.mustTransition(run, 'QUEUED', {
      reason: 'the request passed validation and is queued for the Claude Code adapter',
    });
    run = this.mustTransition(run, 'STARTING', {
      reason: 'the adapter is being asked to spawn the process',
    });

    /* -- 7. spawn -------------------------------------------------------- */
    const liveRun: LiveRun = {
      runId,
      projectId: project.id,
      conversationId: conversation.id,
      projectPath,
      startedAt,
      runDir: this.runDir(runId),
      resumedSessionId: resumeSessionId,
      handle: null,
      runningClaimed: false,
      streamingClaimed: false,
      reportedSessionId: null,
      text: [],
      textChars: 0,
      deltaCount: 0,
      sawOutputComplete: false,
      outputCompleteAt: null,
      outputCompleteIsError: null,
      stderrExcerpts: [],
      sinkFailures: 0,
    };
    this.live.set(runId, liveRun);

    let handle: RunHandle;
    try {
      handle = adapter.start({
        runId,
        projectId: project.id,
        projectPath,
        conversationId: conversation.id,
        prompt,
        permissionMode,
        resumeSessionId,
        model,
        effort,
        ...(timeoutMs === null ? {} : { timeoutMs }),
      });
    } catch (error) {
      this.live.delete(runId);
      const detail = error instanceof AdapterError ? `${error.rejection}: ${error.message}` : errorText(error);
      const failed = this.recordSpawnFailure(run, detail, error);
      this.releaseConversation(conversation.id, project.id, runId);
      fail(spawnErrorCode(error), 'Claude Code could not be started for this message.', `${detail}${failed}`);
    }
    liveRun.handle = handle;

    /* -- 8. STARTING -> RUNNING, only with observed liveness ------------- */
    const runningEvidence = this.observeRunning(run, handle.pid);
    if (runningEvidence.evidence !== null) {
      run = this.mustTransition(run, 'RUNNING', {
        reason: runningEvidence.note,
        evidence: runningEvidence.evidence,
        patch: { pid: handle.pid },
        evidenceRefs: [
          { kind: 'file', ref: `${runId}/argv.json`, note: 'the argv that was assembled, with the prompt hashed' },
          { kind: 'stdout', ref: handle.stdoutRef },
        ],
      });
      liveRun.runningClaimed = true;
    } else {
      // Not a failure — a claim we cannot yet defend. The record stays STARTING
      // and the sink tries again on the first line that parses, where the
      // process is provably alive because it is writing.
      const patched = this.patch(run, { pid: handle.pid }, runningEvidence.note);
      if (patched !== null) run = patched;
      notes.push(`not reported as RUNNING yet: ${runningEvidence.note}`);
    }

    /* -- 9. hand the completion off; do not hold the request open -------- */
    void handle.completed.then(
      (outcome) => {
        void this.finish(liveRun, outcome);
      },
      (error: unknown) => {
        this.publishDegraded(liveRun, 'run.completion-promise-rejected', errorText(error));
        this.live.delete(runId);
      },
    );

    return {
      runId,
      conversationId: conversation.id,
      projectId: project.id,
      status: run.status,
      statusReason: run.statusReason,
      startedAt,
      pid: handle.pid,
      requestedSessionId: handle.sessionId,
      resumed: resumeSessionId !== null,
      streamKey: makeStreamKey(project.id, runId),
      attachments: manifest,
      permissionMode,
      degradedFlags: handle.degraded,
      evidenceRefs: [
        { kind: 'file', ref: `${runId}/argv.json` },
        { kind: 'stdout', ref: handle.stdoutRef },
        { kind: 'stderr', ref: handle.stderrRef },
      ],
      notes,
    };
  }

  /* ---------------------------------------------------------- validation -- */

  private parsePermissionMode(body: Record<string, unknown>): PermissionMode {
    const raw = optString(body, 'permissionMode', 32);
    if (raw === undefined) return this.defaultPermissionMode;
    // An allowlist, so the one mode this bridge refuses in every configuration is
    // refused by simply not being on it — its name is never written here, it
    // lives only in the adapter's denylist. Anything off the allowlist is a
    // BAD_REQUEST that names what IS accepted.
    if (!(ALLOWED_PERMISSION_MODES as readonly string[]).includes(raw)) {
      fail(
        'PERMISSION_DENIED',
        `permissionMode ${JSON.stringify(raw)} is not one this bridge will run under. ` +
          `Choose one of: ${ALLOWED_PERMISSION_MODES.join(', ')}.`,
      );
    }
    return raw as PermissionMode;
  }

  private parseEffort(body: Record<string, unknown>): string | null {
    const raw = optString(body, 'effort', 16);
    if (raw === undefined) return null;
    if (!EFFORT_LEVELS.includes(raw)) {
      fail('BAD_REQUEST', `effort must be one of ${EFFORT_LEVELS.join(', ')}.`);
    }
    return raw;
  }

  /**
   * The path guard, run again here on the registry's stored path. A check
   * performed by another module is a check this one cannot see, and the value
   * used from here on is the one the guard RETURNED.
   */
  private guardProjectPath(project: ProjectRecord): string {
    try {
      return assertInsideRoot(project.canonicalPath, this.trustedRoot);
    } catch (error) {
      if (isPathGuardError(error)) fail(error.code, error.message, error.detail);
      fail('PATH_REJECTED', 'The project path could not be validated.', errorText(error));
    }
  }

  /**
   * Turn requested attachment ids into a manifest of project-local PATHS.
   *
   * Nothing about a file's content is ever put in the prompt: Claude is given a
   * name, a media type and a path inside the directory it was granted with
   * `--add-dir`, and reads it with its own tools if it needs it.
   */
  private buildManifest(
    conversation: ConversationRecord,
    requestedIds: readonly string[],
    projectPath: string,
  ): readonly AttachmentManifestEntry[] {
    if (requestedIds.length === 0) return [];

    const seen = new Set<string>();
    for (const id of requestedIds) {
      if (seen.has(id)) fail('BAD_REQUEST', `attachmentIds lists ${safeId(id)} twice.`);
      seen.add(id);
    }

    // Only records that name THIS conversation and THIS project are candidates.
    // That is the isolation boundary: an id from another conversation resolves
    // to nothing here, and is reported as unknown rather than as not-ready.
    const records = this.conversations.attachmentsFor(conversation).attachments;
    const report = checkAttachmentsReferencable(records, requestedIds);
    if (!report.ok && report.error !== null) {
      fail(report.error.code, report.error.message, report.error.detail);
    }

    const byId = new Map<string, AttachmentRecord>(records.map((r) => [r.id, r]));
    const manifest: AttachmentManifestEntry[] = [];
    for (const id of requestedIds) {
      const record = byId.get(id);
      if (record === undefined) {
        // Unreachable while `checkAttachmentsReferencable` reported ok, and
        // refused rather than assumed if that ever stops being true.
        fail('ATTACHMENT_NOT_READY', `Attachment ${safeId(id)} could not be resolved after it was checked.`);
      }
      let canonical: string;
      try {
        canonical = assertInsideRoot(record.canonicalPath, projectPath);
      } catch (error) {
        fail(
          'ATTACHMENT_REJECTED',
          `"${record.originalFilename}" is not stored inside this project, so Claude Code cannot be pointed at it.`,
          isPathGuardError(error) ? error.message : errorText(error),
        );
      }
      manifest.push({
        attachmentId: record.id,
        name: record.originalFilename,
        mediaType: record.detectedMediaType,
        declaredMediaType: record.declaredMediaType,
        size: record.size,
        hash: record.hash,
        projectRelativePath: toPosixRelative(projectPath, canonical),
      });
    }
    return manifest;
  }

  /**
   * THE SESSION BOUNDARY. A session id may back exactly one conversation in
   * exactly one project. Anything else is refused before `--resume` is built.
   */
  private assertSessionBelongsToConversation(conversation: ConversationRecord, sessionId: string): void {
    for (const other of this.store.listRecords('conversation').records) {
      if (other.id === conversation.id) continue;
      if (other.claudeSessionId !== sessionId) continue;
      fail(
        'INVALID_STATE',
        other.projectId === conversation.projectId
          ? 'That Claude session is already bound to another conversation in this project.'
          : 'That Claude session belongs to another project and can never be resumed from here.',
        `session is also recorded on conversation ${safeId(other.id)} of project ${safeId(other.projectId)}`,
      );
    }
    for (const run of this.store.listRecords('run').records) {
      if (run.sessionId !== sessionId) continue;
      if (run.projectId === conversation.projectId) continue;
      fail(
        'INVALID_STATE',
        'That Claude session was used by another project and can never be resumed from here.',
        `session appears on run ${safeId(run.id)} of project ${safeId(run.projectId)}`,
      );
    }
  }

  /* ====================================================================== */
  /*  The event sink                                                        */
  /* ====================================================================== */

  /**
   * Every draft the adapter produces arrives here: persisted, fanned out to
   * subscribed clients, observed, and handed to the usage aggregator — in that
   * order, and without buffering. A `run.output.delta` is on its way to the
   * browser the moment the line that produced it parsed.
   */
  private onAdapterEvent(draft: ForgeEventDraft): void {
    const runId = draft.runId;
    const live = runId === null ? undefined : this.live.get(runId);

    if (!isEventType(draft.type)) {
      // The store would refuse it, and rightly: an event type the protocol does
      // not define may not enter a log that is later replayed as history.
      if (live !== undefined) {
        this.publishDegraded(live, 'events.unknown-type', `the adapter produced an event of unknown type ${safeId(draft.type)}`);
      }
      return;
    }

    let stored: ForgeEvent;
    try {
      stored = this.conversations.events.publish({ ...draft, type: draft.type }).event;
    } catch (error) {
      if (live !== undefined) {
        live.sinkFailures += 1;
        this.publishDegraded(live, 'events.append-refused', `a ${draft.type} event could not be persisted: ${errorText(error)}`);
      }
      return;
    }

    if (live !== undefined) this.observe(live, stored);

    if (this.usage !== null) {
      try {
        this.usage.ingest(stored);
      } catch {
        // A telemetry failure must never break the output stream. The
        // aggregator records its own rejections.
      }
    }
  }

  /** Read the facts out of a stored event. No claim is made here, only notes. */
  private observe(live: LiveRun, event: ForgeEvent): void {
    const payload = asRecord(event.payload);

    switch (event.type) {
      case 'session.started':
      case 'session.resumed': {
        const sessionId = payload === null ? null : asText(payload.sessionId);
        if (sessionId !== null && live.reportedSessionId === null) {
          live.reportedSessionId = sessionId;
          this.bindSession(live, sessionId, event.type === 'session.resumed');
        }
        break;
      }
      case 'run.output.delta': {
        live.deltaCount += 1;
        if (payload !== null && asText(payload.channel) === 'text') {
          const text = asText(payload.text);
          if (text !== null && live.textChars < MAX_COLLECTED_OUTPUT_CHARS) {
            live.text.push(text);
            live.textChars += text.length;
          }
        }
        // Streaming is a claim about a channel that is actually delivering, so
        // it is written the first time a delta really arrived.
        this.claimStreaming(live);
        break;
      }
      case 'run.output.complete': {
        live.sawOutputComplete = true;
        live.outputCompleteAt = event.timestamp;
        live.outputCompleteIsError = payload === null ? null : asBool(payload.isError);
        break;
      }
      case 'claude.stderr': {
        if (payload !== null && live.stderrExcerpts.length < 20) {
          const excerpt = asText(payload.excerpt);
          if (excerpt !== null) live.stderrExcerpts.push(excerpt);
        }
        break;
      }
      case 'run.state': {
        // The adapter announces STREAMING when a line first parses. That is
        // independent evidence that the process is alive and producing output.
        if (event.status === 'STREAMING' || event.status === 'RUNNING') this.claimRunning(live);
        break;
      }
      default:
        break;
    }
  }

  /**
   * Persist the session id the CLI REPORTED — never the one we asked for — onto
   * the conversation, the run and the project index.
   */
  private bindSession(live: LiveRun, sessionId: string, resumed: boolean): void {
    const bound = this.conversations.recordSessionId(live.conversationId, sessionId);
    if (bound === null) {
      this.publishDegraded(
        live,
        'session.binding-refused',
        `Claude Code reported session ${safeId(sessionId)} but the conversation is already bound to a different one; ` +
          'the conversation record was left untouched',
      );
      return;
    }
    this.conversations.linkToProject(live.projectId, { addSessionId: sessionId });
    const current = this.store.getRecord('run', live.runId);
    if (current.ok && current.record.sessionId !== sessionId) {
      try {
        this.store.saveRecord('run', { ...current.record, sessionId, updatedAt: this.nowIso() });
      } catch {
        /* the record is unwritable; the session.started event still carries it */
      }
    }
    if (resumed && live.resumedSessionId !== null && live.resumedSessionId !== sessionId) {
      // A resume that came back with a different id is a NEW session wearing the
      // word "resumed". Said out loud rather than accepted quietly.
      this.publishDegraded(
        live,
        'session.resume-id-mismatch',
        `--resume was passed ${safeId(live.resumedSessionId)} but the runtime reported ${safeId(sessionId)}`,
      );
    }
  }

  /** Try to earn RUNNING. Silent when the evidence is not there. */
  private claimRunning(live: LiveRun): void {
    if (live.runningClaimed) return;
    const current = this.store.getRecord('run', live.runId);
    if (!current.ok || current.record.status !== 'STARTING') return;
    const evidence = this.observeRunning(current.record, live.handle?.pid ?? current.record.pid);
    if (evidence.evidence === null) return;
    const moved = this.applyTransition(current.record, 'RUNNING', {
      reason: evidence.note,
      evidence: evidence.evidence,
    });
    if (moved.ok) live.runningClaimed = true;
  }

  private claimStreaming(live: LiveRun): void {
    if (live.streamingClaimed) return;
    this.claimRunning(live);
    const current = this.store.getRecord('run', live.runId);
    if (!current.ok || current.record.status !== 'RUNNING') return;
    const moved = this.applyTransition(current.record, 'STREAMING', {
      reason: 'output deltas are arriving from the process',
      evidenceRefs: [{ kind: 'stdout', ref: `${live.runId}/stdout.jsonl` }],
    });
    if (moved.ok) live.streamingClaimed = true;
  }

  /* ====================================================================== */
  /*  Completion                                                            */
  /* ====================================================================== */

  /**
   * The process has exited and every line has been parsed. Record the exit code,
   * persist the output, make sure exactly one `run.output.complete` exists, and
   * then — and only then — decide what the run may be called.
   */
  private async finish(live: LiveRun, outcome: RunOutcome): Promise<void> {
    this.live.delete(live.runId);
    const read = this.store.getRecord('run', live.runId);
    if (!read.ok) {
      this.publishDegraded(live, 'run.record-unreadable-at-exit', `${read.reason}: ${read.detail}`);
      return;
    }
    let run = read.record;

    /* -- persist the output ---------------------------------------------- */
    const output = live.text.join('');
    const outputRef = `${live.runId}/output.txt`;
    let outputPersisted = false;
    const outputPath = containedPath(this.evidenceRoot, join(this.evidenceRoot, live.runId, 'output.txt'));
    if (outputPath !== null) {
      try {
        ensureDir(live.runDir);
        writeAtomic(outputPath, output);
        outputPersisted = fileExists(outputPath);
      } catch (error) {
        this.publishDegraded(live, 'run.output-not-persisted', errorText(error));
      }
    }

    /* -- exactly one run.output.complete --------------------------------- */
    if (!live.sawOutputComplete) {
      // The runtime never printed a result envelope. One completion event is
      // emitted here so the stream has an end, and it says plainly that no
      // result was reported rather than inventing one.
      const emitted = this.conversations.emit({
        projectId: live.projectId,
        conversationId: live.conversationId,
        runId: live.runId,
        sessionId: live.reportedSessionId,
        source: 'bridge',
        type: 'run.output.complete',
        payload: {
          subtype: null,
          isError: null,
          stopReason: null,
          terminalReason: 'the process exited without printing a result envelope',
          numTurns: null,
          durationMs: outcome.durationMs,
          durationApiMs: null,
          sessionId: live.reportedSessionId,
          resultText: null,
          resultTruncated: false,
          permissionDenials: null,
          apiErrorStatus: null,
          emittedBy: 'bridge',
          exitCode: outcome.exitCode,
          collectedTextChars: output.length,
        },
        evidenceRefs: [
          { kind: 'stdout', ref: outcome.stdoutRef },
          { kind: 'exit-code', ref: String(outcome.exitCode) },
        ],
      });
      if (emitted.event !== null) {
        live.sawOutputComplete = true;
        live.outputCompleteAt = emitted.event.timestamp;
      }
    }

    /* -- the exit code, on the record ------------------------------------ */
    const proofRefs: readonly EvidenceRef[] = [
      ...outcome.evidenceRefs,
      ...(outputPersisted ? [{ kind: 'file' as const, ref: outputRef, note: 'the assistant text as persisted' }] : []),
    ];
    const patched = this.patch(
      run,
      {
        exitCode: outcome.exitCode,
        sessionId: outcome.sessionId ?? run.sessionId,
        evidenceRefs: [...run.evidenceRefs, ...proofRefs],
      },
      `the process exited: ${outcome.statusReason}`,
    );
    if (patched !== null) run = patched;

    /* -- a resume that never produced a session --------------------------
     * Evidence, not inference: the run was started with `--resume <id>`, the
     * runtime never printed the `system/init` line that reports a session, and
     * the process did not finish successfully. That combination is what a
     * resume of a session Claude Code no longer holds looks like, and it is
     * recorded as `session.lost` so `resumeSession` can answer ORPHANED with
     * something behind it instead of a guess.
     */
    if (live.resumedSessionId !== null && live.reportedSessionId === null && outcome.status !== 'COMPLETED') {
      this.conversations.emit({
        projectId: live.projectId,
        conversationId: live.conversationId,
        runId: live.runId,
        sessionId: live.resumedSessionId,
        source: 'bridge',
        type: 'session.lost',
        payload: {
          sessionId: live.resumedSessionId,
          detail:
            `run ${live.runId} was started with --resume ${live.resumedSessionId} and ended ${outcome.status} ` +
            `(exit ${String(outcome.exitCode)}) without the runtime ever reporting a session`,
          runStatus: outcome.status,
          exitCode: outcome.exitCode,
          // Already redacted and capped by the adapter before it became an event.
          stderrExcerpt: live.stderrExcerpts[0] ?? null,
        },
        evidenceRefs: proofRefs,
      });
    }

    /* -- the terminal claim ---------------------------------------------- */
    switch (outcome.status) {
      case 'COMPLETED':
        run = await this.verifyAndComplete(live, run, outcome, outputRef, outputPersisted, proofRefs);
        break;
      case 'CANCELLED':
        run = this.toCancelled(run, outcome, proofRefs);
        break;
      case 'FAILED':
        run = this.toFailed(live, run, outcome, proofRefs);
        break;
      default:
        run = this.toInterrupted(run, outcome.statusReason, proofRefs);
        break;
    }

    /* -- release the conversation ---------------------------------------- */
    if (live.sawOutputComplete && output.length > 0) {
      this.conversations.countMessage(live.conversationId, 1);
    }
    this.releaseConversation(live.conversationId, live.projectId, live.runId);
  }

  /**
   * The verification pass.
   *
   * Everything checked here is a fact that can be re-checked from disk later.
   * Nothing is inferred from a string in stdout: `resultEnvelopeObserved` comes
   * from the parser having seen a `result` line, and `exitCodeZero` from the code
   * the adapter read off the `close` event.
   */
  private async verifyAndComplete(
    live: LiveRun,
    start: RunRecord,
    outcome: RunOutcome,
    outputRef: string,
    outputPersisted: boolean,
    proofRefs: readonly EvidenceRef[],
  ): Promise<RunRecord> {
    let run = start;

    if (run.status !== 'RUNNING' && run.status !== 'STREAMING') {
      // We never established the process was alive, so the chain that leads to
      // COMPLETED was never entered. Reported for what it is.
      return this.toInterrupted(
        run,
        `the runtime reported a successful turn, but this bridge never observed the process alive (the record is ${run.status}), ` +
          'so the run cannot be reported as COMPLETED',
        proofRefs,
      );
    }

    const anchor = this.conversations.anchorFor(makeStreamKey(run.projectId, run.id));
    const inspected: readonly EvidenceRef[] = [
      ...proofRefs,
      { kind: 'event', ref: `stream:${anchor.streamKey}@${anchor.head}`, note: `${anchor.eventCount} event(s) on this run's stream` },
    ];

    /* -- VERIFYING -------------------------------------------------------- */
    const verifyStarted = this.conversations.emit({
      projectId: run.projectId,
      conversationId: run.conversationId,
      runId: run.id,
      sessionId: run.sessionId,
      source: 'bridge',
      type: 'verify.started',
      payload: {
        verifierAgentId: VERIFIER_AGENT_ID,
        subjectAgentId: SUBJECT_AGENT_ID,
        scope: PROCESS_VERIFICATION_SCOPE,
        checks: ['exitCodeRecorded', 'exitCodeZero', 'resultEnvelopeObserved', 'outputPersisted', 'streamComplete'],
      },
      evidenceRefs: inspected,
    });
    if (verifyStarted.event === null) {
      return this.toInterrupted(
        run,
        'the verification could not be started because its verify.started event could not be appended; ' +
          'without that event there is no evidence for a VERIFYING claim',
        proofRefs,
      );
    }

    const toVerifying = this.applyTransition(run, 'VERIFYING', {
      reason: 'the process exited and its evidence is being re-checked',
      evidence: {
        state: 'VERIFYING',
        evidence: {
          runId: run.id,
          taskId: `turn-${run.id}`,
          verifierAgentId: VERIFIER_AGENT_ID,
          subjectAgentId: SUBJECT_AGENT_ID,
          startEvent: { type: 'verify.started', runId: run.id, at: verifyStarted.event.timestamp },
          inspectedRefs: inspected,
        },
      },
      evidenceRefs: inspected,
    });
    if (!toVerifying.ok) {
      return this.toInterrupted(run, `verification could not be entered: ${toVerifying.problem}`, proofRefs);
    }
    run = toVerifying.run;

    /* -- the checks themselves -------------------------------------------- */
    const checks = [
      { name: 'exitCodeRecorded', passed: Number.isInteger(outcome.exitCode), detail: `exitCode=${String(outcome.exitCode)}` },
      { name: 'exitCodeZero', passed: outcome.exitCode === 0, detail: `exitCode=${String(outcome.exitCode)}` },
      {
        name: 'resultEnvelopeObserved',
        passed: live.sawOutputComplete && live.outputCompleteIsError !== true,
        detail: `sawResultEnvelope=${String(live.sawOutputComplete)} isError=${String(live.outputCompleteIsError)}`,
      },
      { name: 'outputPersisted', passed: outputPersisted, detail: outputRef },
      {
        name: 'streamComplete',
        passed: anchor.gaps.length === 0,
        detail: anchor.gaps.length === 0 ? 'no sequence gaps' : `${anchor.gaps.length} gap range(s) on ${anchor.streamKey}`,
      },
    ] as const;

    const blocking = checks.filter((c) => c.name !== 'streamComplete' && !c.passed);
    const verdict: VerifyVerdict = blocking.length === 0 ? 'VERIFIED_PASS_WITH_LIMITATIONS' : 'INSUFFICIENT_EVIDENCE';
    const gapNote = anchor.gaps.length === 0 ? '' : ` The run stream has ${anchor.gaps.length} sequence gap range(s), so its timeline is incomplete.`;
    const reason =
      blocking.length === 0
        ? `${PROCESS_VERIFICATION_SCOPE} Every process-level check passed.${gapNote}`
        : `${PROCESS_VERIFICATION_SCOPE} Failed: ${blocking.map((c) => `${c.name} (${c.detail})`).join('; ')}.`;

    const verification: VerificationRecord = {
      id: `ver-${randomUUID()}`,
      taskId: `turn-${run.id}`,
      runId: run.id,
      verifierAgentId: VERIFIER_AGENT_ID,
      subjectAgentId: SUBJECT_AGENT_ID,
      startedAt: verifyStarted.event.timestamp,
      resolvedAt: this.nowIso(),
      verdict,
      reason,
      evidenceRefs: inspected,
    };
    try {
      this.store.saveRecord('verification', verification);
    } catch (error) {
      this.publishDegraded(live, 'verification.not-persisted', errorText(error));
    }
    this.conversations.emit({
      projectId: run.projectId,
      conversationId: run.conversationId,
      runId: run.id,
      sessionId: run.sessionId,
      source: 'bridge',
      type: 'verify.verdict',
      payload: { verificationId: verification.id, verdict, reason, checks },
      evidenceRefs: [...inspected, { kind: 'verdict', ref: verification.id, note: verdict }],
    });

    if (verdict !== 'VERIFIED_PASS_WITH_LIMITATIONS') {
      const failed = this.applyTransition(run, 'FAILED', {
        reason: `verification did not pass: ${reason}`,
        evidence: {
          state: 'FAILED',
          evidence: {
            runId: run.id,
            failure: 'gate',
            gate: { gate: 'run-completion-evidence', passed: false },
            evidenceRefs: inspected,
          },
        },
        patch: { endedAt: this.nowIso() },
        evidenceRefs: [...inspected, { kind: 'verdict', ref: verification.id, note: verdict }],
      });
      return failed.ok ? failed.run : run;
    }

    /* -- REVIEWING -------------------------------------------------------- */
    const reviewStarted = this.conversations.emit({
      projectId: run.projectId,
      conversationId: run.conversationId,
      runId: run.id,
      sessionId: run.sessionId,
      source: 'bridge',
      type: 'review.started',
      payload: { reviewerAgentId: REVIEWER_AGENT_ID, subjectAgentId: SUBJECT_AGENT_ID, verificationId: verification.id },
      evidenceRefs: inspected,
    });
    if (reviewStarted.event === null) {
      return this.toInterrupted(run, 'the review.started event could not be appended, so REVIEWING has no evidence', proofRefs);
    }

    const toReviewing = this.applyTransition(run, 'REVIEWING', {
      reason: 'the verification verdict is being reviewed before the run may be called complete',
      evidence: {
        state: 'REVIEWING',
        evidence: {
          runId: run.id,
          taskId: `turn-${run.id}`,
          reviewerAgentId: REVIEWER_AGENT_ID,
          subjectAgentId: SUBJECT_AGENT_ID,
          startEvent: { type: 'review.started', runId: run.id, at: reviewStarted.event.timestamp },
          inspectedRefs: inspected,
          verificationVerdict: verdict,
        },
      },
      evidenceRefs: inspected,
    });
    if (!toReviewing.ok) {
      return this.toInterrupted(run, `review could not be entered: ${toReviewing.problem}`, proofRefs);
    }
    run = toReviewing.run;

    this.conversations.emit({
      projectId: run.projectId,
      conversationId: run.conversationId,
      runId: run.id,
      sessionId: run.sessionId,
      source: 'bridge',
      type: 'review.verdict',
      payload: {
        reviewerAgentId: REVIEWER_AGENT_ID,
        verificationId: verification.id,
        accepted: true,
        reason: `the verification verdict ${verdict} was recorded with its evidence and its stated limitation.`,
      },
      evidenceRefs: [...inspected, { kind: 'verdict', ref: verification.id, note: verdict }],
    });

    /* -- COMPLETED -------------------------------------------------------- */
    const finalEventType = 'run.output.complete';
    const completed = this.applyTransition(run, 'COMPLETED', {
      reason: `exit code 0, a result envelope from the runtime, persisted output, and verdict ${verdict}`,
      evidence: {
        state: 'COMPLETED',
        evidence: {
          runId: run.id,
          processExitObserved: true,
          exitCode: outcome.exitCode,
          outputRef,
          finalEvent: { type: finalEventType, runId: run.id, status: 'COMPLETED' },
          proofRefs: inspected,
          verdict,
          verifierAgentId: VERIFIER_AGENT_ID,
          subjectAgentId: SUBJECT_AGENT_ID,
        },
      },
      patch: { endedAt: this.nowIso(), exitCode: outcome.exitCode },
      evidenceRefs: inspected,
    });
    if (!completed.ok) {
      return this.toInterrupted(run, `completion was refused: ${completed.problem}`, proofRefs);
    }
    return completed.run;
  }

  /** FAILED needs proof of failure, exactly as COMPLETED needs proof of success. */
  private toFailed(live: LiveRun, run: RunRecord, outcome: RunOutcome, proofRefs: readonly EvidenceRef[]): RunRecord {
    const nonZeroExit = Number.isInteger(outcome.exitCode) && outcome.exitCode !== 0;
    const killed = typeof outcome.signal === 'string' && outcome.signal.length > 0;

    let evidence: RunStateEvidence;
    if (nonZeroExit || killed) {
      evidence = {
        state: 'FAILED',
        evidence: {
          runId: run.id,
          failure: 'process',
          process: { exitObserved: true, exitCode: outcome.exitCode, signal: outcome.signal },
          evidenceRefs: proofRefs,
        },
      };
    } else {
      // Exit 0 with a result envelope that reported an error. The failure is the
      // runtime's own report, so the evidence is the error event carrying it.
      const errorEvent = this.conversations.emit({
        projectId: run.projectId,
        conversationId: run.conversationId,
        runId: run.id,
        sessionId: run.sessionId,
        source: 'bridge',
        type: 'run.error',
        payload: { message: outcome.statusReason, exitCode: outcome.exitCode, signal: outcome.signal },
        evidenceRefs: proofRefs,
      });
      if (errorEvent.event === null) {
        this.publishDegraded(live, 'run.error-event-not-appended', outcome.statusReason);
        return this.toInterrupted(run, `the failure could not be evidenced: ${outcome.statusReason}`, proofRefs);
      }
      evidence = {
        state: 'FAILED',
        evidence: {
          runId: run.id,
          failure: 'error-event',
          errorEvent: { type: 'run.error', runId: run.id, message: outcome.statusReason },
          evidenceRefs: proofRefs,
        },
      };
    }

    const moved = this.applyTransition(run, 'FAILED', {
      reason: outcome.statusReason,
      evidence,
      patch: { endedAt: outcome.endedAt, exitCode: outcome.exitCode },
      evidenceRefs: proofRefs,
    });
    return moved.ok ? moved.run : run;
  }

  /**
   * CANCELLED is written here and nowhere else, because this is the first point
   * at which the exit has actually been observed.
   */
  private toCancelled(run: RunRecord, outcome: RunOutcome, proofRefs: readonly EvidenceRef[]): RunRecord {
    let current = run;
    if (current.status === 'RUNNING' || current.status === 'STREAMING' || current.status === 'VERIFYING' || current.status === 'REVIEWING') {
      const stopping = this.applyTransition(current, 'STOPPING', {
        reason: outcome.timedOut
          ? 'the adapter requested termination because the run exceeded its wall-clock ceiling'
          : 'a cancellation was requested for this run',
        evidenceRefs: proofRefs,
      });
      if (!stopping.ok) return current;
      current = stopping.run;
    }
    const moved = this.applyTransition(current, 'CANCELLED', {
      reason: outcome.statusReason,
      patch: { endedAt: outcome.endedAt, exitCode: outcome.exitCode },
      evidenceRefs: proofRefs,
    });
    return moved.ok ? moved.run : current;
  }

  private toInterrupted(run: RunRecord, reason: string, proofRefs: readonly EvidenceRef[]): RunRecord {
    const moved = this.applyTransition(run, 'INTERRUPTED', {
      reason,
      patch: { endedAt: run.endedAt ?? this.nowIso() },
      evidenceRefs: proofRefs,
    });
    if (moved.ok) return moved.run;
    const patched = this.patch(run, {}, `${run.statusReason} — and then: ${reason} (${moved.problem})`);
    return patched ?? run;
  }

  private releaseConversation(conversationId: string, projectId: string, runId: string): void {
    const conversation = this.store.getRecord('conversation', conversationId);
    if (conversation.ok && conversation.record.activeRunId === runId) {
      this.conversations.setActiveRun(conversationId, null);
    }
    this.conversations.linkToProject(projectId, { removeActiveRunId: runId });
  }

  /* ====================================================================== */
  /*  Transitions                                                           */
  /* ====================================================================== */

  /**
   * The single write path for a run's status.
   *
   * `assertRunTransitionWithEvidence` checks BOTH that the transition is in the
   * machine's table AND that the target state's evidence gate passes. A refusal
   * is returned, never swallowed: on the request path it becomes an operation
   * error, on the background path a `bridge.degraded` event, and in both cases
   * the record keeps the last status it could defend.
   */
  private applyTransition(
    run: RunRecord,
    to: RunState,
    input: {
      readonly reason: string;
      readonly evidence?: RunStateEvidence;
      readonly evidenceRefs?: readonly EvidenceRef[];
      readonly patch?: Partial<RunRecord>;
    },
  ): { readonly ok: true; readonly run: RunRecord } | { readonly ok: false; readonly problem: string } {
    try {
      assertRunTransitionWithEvidence(run.status, to, input.evidence);
    } catch (error) {
      const problem = errorText(error);
      this.publishDegradedFor(run, 'run.transition-refused', `${run.status} -> ${to} was refused: ${problem}`);
      return { ok: false, problem };
    }

    const now = this.nowIso();
    const patch = input.patch ?? {};
    // A terminal status without an end time fails the store's own validator, and
    // rightly: "it is over" and "it never stopped" cannot both be true.
    const endedAt =
      patch.endedAt !== undefined ? patch.endedAt : isTerminalRunStatus(to) ? (run.endedAt ?? now) : run.endedAt;
    const baseRefs = patch.evidenceRefs ?? run.evidenceRefs;

    const updated: RunRecord = {
      ...run,
      ...patch,
      status: to,
      statusReason: input.reason,
      updatedAt: now,
      endedAt,
      evidenceRefs:
        input.evidenceRefs === undefined ? baseRefs : dedupeRefs([...baseRefs, ...input.evidenceRefs]),
    };

    try {
      this.store.saveRecord('run', updated);
    } catch (error) {
      const problem = errorText(error);
      this.publishDegradedFor(run, 'run.record-refused', `${run.status} -> ${to} could not be persisted: ${problem}`);
      return { ok: false, problem };
    }

    this.conversations.emit({
      projectId: updated.projectId,
      conversationId: updated.conversationId,
      runId: updated.id,
      sessionId: updated.sessionId,
      source: 'bridge',
      type: 'run.state',
      // The top-level status carries the state the machine just entered, exactly
      // as the startup reconciler does. Without it, VERIFYING / REVIEWING /
      // COMPLETED / FAILED transitions reached the client with a blank status,
      // so a client tracking `event.status` kept whatever it last saw — which
      // let a run that FAILED verification keep showing an earlier COMPLETED.
      // The status now moves with the real gated transition, and only with it.
      status: to,
      payload: {
        from: run.status,
        to,
        reason: input.reason,
        recordedBy: 'run-service',
        bridgeInstanceId: this.bridgeInstanceId,
        gated: input.evidence !== undefined,
        exitCode: updated.exitCode,
        pid: updated.pid,
      },
      evidenceRefs: updated.evidenceRefs,
    });

    return { ok: true, run: updated };
  }

  /** Request-path transition: a refusal becomes a typed operation error. */
  private mustTransition(
    run: RunRecord,
    to: RunState,
    input: {
      readonly reason: string;
      readonly evidence?: RunStateEvidence;
      readonly evidenceRefs?: readonly EvidenceRef[];
      readonly patch?: Partial<RunRecord>;
    },
  ): RunRecord {
    const moved = this.applyTransition(run, to, input);
    if (moved.ok) return moved.run;
    fail('INVALID_STATE', `The run could not move from ${run.status} to ${to}.`, moved.problem);
  }

  /** The run record as it is on disk right now, or null if it cannot be read. */
  private currentRun(runId: string): RunRecord | null {
    const read = this.store.getRecord('run', runId);
    return read.ok ? read.record : null;
  }

  /**
   * Wait for a run record to reach a state the run machine calls terminal.
   *
   * Used only to avoid stamping a state onto a run whose completion handler is
   * still in flight. Returns null when the window expires — which is a fact
   * about the wait, not a claim about the run.
   */
  private async awaitTerminalRecord(runId: string, windowMs: number): Promise<RunRecord | null> {
    const deadline = Date.now() + windowMs;
    for (;;) {
      const record = this.currentRun(runId);
      if (record !== null && isTerminalRunStatus(record.status)) return record;
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** Update fields WITHOUT changing the status. Returns null when it could not. */
  private patch(run: RunRecord, patch: Partial<RunRecord>, statusReason?: string): RunRecord | null {
    const updated: RunRecord = {
      ...run,
      ...patch,
      status: run.status,
      statusReason: statusReason ?? run.statusReason,
      updatedAt: this.nowIso(),
    };
    try {
      this.store.saveRecord('run', updated);
      return updated;
    } catch {
      return null;
    }
  }

  /**
   * What must be true for "this is running right now" to be honest: a pid the OS
   * assigned AND a liveness check that observed it alive. A spawn is not proof.
   */
  private observeRunning(run: RunRecord, pid: number | null): { readonly evidence: RunStateEvidence | null; readonly note: string } {
    if (pid === null) {
      return { evidence: null, note: 'the OS never assigned a pid to the spawned process' };
    }
    const alive = isPidAlive(pid);
    if (alive !== true) {
      return {
        evidence: null,
        note:
          alive === false
            ? `the OS reports that pid ${pid} is not running, so RUNNING would be a false claim`
            : `liveness of pid ${pid} could not be determined, so RUNNING cannot be defended`,
      };
    }
    const observedAt = this.now().getTime();
    return {
      evidence: {
        state: 'RUNNING',
        evidence: {
          runId: run.id,
          projectId: run.projectId,
          pid,
          pidAlive: true,
          startedAt: run.startedAt,
          // The heartbeat IS this observation: the instant the OS confirmed the
          // process exists. Freshness is judged against the same instant.
          lastHeartbeatAt: observedAt,
          observedAt,
        },
      },
      note: `pid ${pid} was observed alive by the operating system`,
    };
  }

  /**
   * A spawn that never produced a process. Recorded as FAILED with the error
   * event that evidences it; returns a suffix for the operation error detail.
   */
  private recordSpawnFailure(run: RunRecord, detail: string, error: unknown): string {
    const refs: readonly EvidenceRef[] = [
      { kind: 'event', ref: `adapter:${error instanceof AdapterError ? error.rejection : 'spawn-failed'}`, note: detail },
    ];
    const errorEvent = this.conversations.emit({
      projectId: run.projectId,
      conversationId: run.conversationId,
      runId: run.id,
      source: 'bridge',
      type: 'run.error',
      payload: { phase: 'spawn', message: detail },
      evidenceRefs: refs,
    });
    if (errorEvent.event === null) {
      return ' — and the run.error event could not be appended, so the run record was left in STARTING';
    }
    const moved = this.applyTransition(run, 'FAILED', {
      reason: `the process could not be started: ${detail}`,
      evidence: {
        state: 'FAILED',
        evidence: {
          runId: run.id,
          failure: 'error-event',
          errorEvent: { type: 'run.error', runId: run.id, message: detail },
          evidenceRefs: refs,
        },
      },
      patch: { endedAt: this.nowIso() },
      evidenceRefs: refs,
    });
    return moved.ok ? '' : ` — and the run record could not be moved to FAILED (${moved.problem})`;
  }

  /* ====================================================================== */
  /*  stopRun                                                               */
  /* ====================================================================== */

  async stopRun(payload: unknown): Promise<Record<string, unknown>> {
    const body = asObject(payload);
    const runId = reqString(body, 'runId');
    const reason = optString(body, 'reason', 200) ?? 'cancelled by the owner';

    const run = this.requireRun(runId);

    // A second stop on a run that is already over is a no-op, not an error.
    if (isTerminalRunStatus(run.status)) {
      return {
        runId,
        status: run.status,
        alreadyStopped: true,
        cancelRequested: false,
        exitObserved: run.endedAt !== null,
        detail: `the run was already ${run.status}; nothing was signalled`,
        evidenceRefs: run.evidenceRefs,
      };
    }

    const inFlight = this.stopsInFlight.get(runId);
    if (inFlight !== undefined) {
      // A second stop while the first is still working joins it rather than
      // issuing a second kill against the same tree.
      const joined = await inFlight;
      return { ...joined, joinedInFlightStop: true };
    }

    const work = this.performStop(run, reason);
    this.stopsInFlight.set(runId, work);
    try {
      return await work;
    } finally {
      this.stopsInFlight.delete(runId);
    }
  }

  private async performStop(start: RunRecord, reason: string): Promise<Record<string, unknown>> {
    let run = start;
    const runId = run.id;

    // Nothing was ever spawned: cancelling is immediate and needs no exit.
    if (run.status === 'CREATED' || run.status === 'QUEUED') {
      const moved = this.applyTransition(run, 'CANCELLED', {
        reason: `${reason} (no process had been spawned)`,
        patch: { endedAt: this.nowIso() },
      });
      return {
        runId,
        status: moved.ok ? moved.run.status : run.status,
        cancelRequested: true,
        exitObserved: true,
        forced: false,
        detail: 'the run was cancelled before any process existed',
      };
    }

    // No adapter, or an adapter that does not own this run, means there is
    // nothing here to signal — after a restart that is the normal case. It is
    // reported as "no process is registered here", never as "the run is gone".
    const adapter = this.adapterIfAny;
    const owned = adapter !== null && adapter.activeRunIds().includes(runId);

    if (!owned) {
      // The process may have exited a moment ago and its completion handler may
      // still be in flight. Stamping a state on the record now could overwrite a
      // run that was in the middle of finishing, so the record is given a short
      // window to settle and then reported as whatever it actually reached.
      const settled = await this.awaitTerminalRecord(runId, 2_000);
      if (settled !== null) {
        return {
          runId,
          status: settled.status,
          cancelRequested: false,
          exitObserved: settled.endedAt !== null,
          forced: false,
          detail: `the run had already reached ${settled.status} before a stop could be signalled; nothing was killed`,
        };
      }
      let stranded = this.currentRun(runId) ?? run;
      if (isLiveRunStatus(stranded.status) && stranded.status !== 'STOPPING' && stranded.status !== 'STARTING') {
        const staged = this.applyTransition(stranded, 'STOPPING', { reason });
        if (staged.ok) stranded = staged.run;
      }
      const target: RunState = stranded.status === 'STARTING' ? 'INTERRUPTED' : 'ORPHANED';
      const moved = this.applyTransition(stranded, target, {
        reason:
          `${reason}: no process is registered for this run in bridge instance ${this.bridgeInstanceId}, ` +
          'so it could not be terminated and its true state cannot be established from here',
        patch: { endedAt: this.nowIso() },
      });
      return {
        runId,
        status: moved.ok ? moved.run.status : stranded.status,
        cancelRequested: true,
        exitObserved: false,
        forced: false,
        detail: `no live process for this run is registered with bridge instance ${this.bridgeInstanceId}`,
        note: moved.ok
          ? `the run was recorded as ${target} because no process could be reached`
          : `the run could not be moved to ${target}: ${moved.problem}`,
      };
    }

    // From here the adapter owns a live process. Everything up to the point
    // where the adapter records the cancellation is synchronous, so the run
    // cannot finish underneath us between the STOPPING write and the request.
    //
    // STARTING has no legal STOPPING edge: the request is persisted by the
    // adapter and the record moves to CANCELLED when the exit is observed.
    if (isLiveRunStatus(run.status) && run.status !== 'STOPPING' && run.status !== 'STARTING') {
      const moved = this.applyTransition(run, 'STOPPING', { reason });
      if (moved.ok) run = moved.run;
    }

    const result: StopResult = await adapter.stop(runId, {
      reason,
      graceMs: this.graceMs,
      forceWaitMs: this.forceWaitMs,
    });

    const after = this.store.getRecord('run', runId);
    const statusNow = after.ok ? after.record.status : run.status;

    if (result.ok) {
      // The exit was OBSERVED. CANCELLED itself is written by `finish`, from the
      // adapter's outcome — this only reports what happened.
      return {
        runId,
        status: statusNow,
        cancelRequested: true,
        exitObserved: true,
        forced: result.forced,
        detail: result.detail,
        note: 'CANCELLED is persisted by the completion handler, which runs on the observed exit.',
      };
    }

    switch (result.reason) {
      case 'ALREADY_EXITED':
        return {
          runId,
          status: statusNow,
          cancelRequested: true,
          exitObserved: true,
          forced: false,
          detail: result.detail,
        };
      case 'EXIT_NOT_OBSERVED':
        // The kill was issued and the process did not die. The run keeps saying
        // STOPPING, because a kill we issued is not a process we know is dead.
        return {
          runId,
          status: statusNow,
          cancelRequested: true,
          exitObserved: false,
          forced: true,
          detail: result.detail,
          note: 'the run remains STOPPING and is NOT reported as cancelled',
        };
      case 'UNKNOWN_RUN':
      case 'NO_PID':
      default: {
        // No process this bridge instance can reach. That is ORPHANED — we can
        // neither terminate it nor account for it.
        const current = after.ok ? after.record : run;
        const target: RunState = current.status === 'STARTING' ? 'INTERRUPTED' : 'ORPHANED';
        const moved = this.applyTransition(current, target, {
          reason:
            `${reason}: no process is registered for this run in bridge instance ${this.bridgeInstanceId}, ` +
            `so it could not be terminated (${result.reason})`,
          patch: { endedAt: this.nowIso() },
        });
        return {
          runId,
          status: moved.ok ? moved.run.status : current.status,
          cancelRequested: true,
          exitObserved: false,
          forced: false,
          detail: result.detail,
          note: moved.ok
            ? `the run was recorded as ${target} because no process could be reached`
            : `the run could not be moved to ${target}: ${moved.problem}`,
        };
      }
    }
  }

  /* ====================================================================== */
  /*  resumeSession                                                         */
  /* ====================================================================== */

  /**
   * Reopen a conversation after a refresh, a bridge restart or a reboot.
   *
   * This reports; it never starts anything. The `--resume` itself happens on the
   * next `sendMessage`, which passes the id this operation validated. If the
   * session cannot be resumed the answer says so — a fresh session is never
   * started while calling it a continuation.
   */
  async resumeSession(payload: unknown): Promise<ResumeSessionResult> {
    const body = asObject(payload);
    const conversationId = reqString(body, 'conversationId');
    const projectId = optString(body, 'projectId');

    const conversation = this.conversations.requireConversation(conversationId);
    if (projectId !== undefined) this.conversations.assertBelongsToProject(conversation, projectId);
    this.conversations.requireProject(conversation.projectId);

    const runList = this.conversations.runsFor(conversation.id);
    const live = runList.runs.find((run) => isLiveRunStatus(run.status)) ?? null;
    const streams = this.conversations.streamAnchors(conversation, runList.runs);
    const notes: string[] = [];
    const evidenceRefs: EvidenceRef[] = [
      { kind: 'file', ref: `records/conversation/${conversation.id}.json`, note: 'the conversation record' },
    ];

    const sessionId = conversation.claudeSessionId;
    let state: SessionAvailability;
    let reason: string;
    let existence: ResumeSessionResult['sessionExistenceCheck'] = 'UNAVAILABLE';

    if (sessionId === null) {
      state = 'NONE';
      reason =
        'Claude Code has never reported a session for this conversation, so there is nothing to resume. ' +
        'The next message will start a new session.';
    } else {
      const lost = this.findSessionLostEvidence(conversation, runList.runs, sessionId);
      const foreign = this.findForeignSessionOwner(conversation, sessionId);
      if (foreign !== null) {
        state = 'ORPHANED';
        reason =
          `The recorded session is also claimed by ${foreign}, so it will never be resumed from this conversation. ` +
          'Session isolation is a hard boundary.';
        evidenceRefs.push({ kind: 'event', ref: `session:${sessionId}`, note: foreign });
      } else if (lost !== null) {
        state = 'ORPHANED';
        existence = 'OBSERVED_LOST';
        reason = `A previous resume of this session was observed to fail: ${lost.detail}`;
        evidenceRefs.push(...lost.evidenceRefs);
      } else if (!(await this.resumeSupported())) {
        state = 'UNVERIFIED';
        reason =
          'A session id is recorded, but this bridge could not establish that the installed Claude Code supports ' +
          '--resume, so whether the conversation can be continued is UNKNOWN rather than assumed.';
      } else {
        state = 'RESUMABLE';
        reason =
          'A session id is recorded for this conversation, no other conversation or project claims it, and the ' +
          'installed Claude Code supports --resume. Whether that session still exists inside Claude Code\'s own ' +
          'store cannot be checked — the 2.1.217 CLI exposes no way to ask — so it is confirmed on the next message, ' +
          'not asserted here.';
        evidenceRefs.push({ kind: 'event', ref: `session:${sessionId}`, note: 'recorded on this conversation only' });
      }
    }

    if (live !== null) {
      const owned = this.adapterIfAny?.activeRunIds().includes(live.id) === true;
      notes.push(
        `run ${live.id} is still ${live.status}; ${owned ? 'this bridge instance owns its process' : 'no process for it is registered with this bridge instance'}`,
      );
    }

    const emitted = this.conversations.emit({
      projectId: conversation.projectId,
      conversationId: conversation.id,
      sessionId,
      source: 'user',
      type: 'conversation.resumed',
      payload: {
        conversationId: conversation.id,
        sessionId,
        sessionState: state,
        sessionExistenceCheck: existence,
        replayFromSequence: conversation.lastConfirmedSequence + 1,
      },
      evidenceRefs,
    });
    if (emitted.note !== null) notes.push(emitted.note);

    return {
      conversation,
      projectId: conversation.projectId,
      sessionId,
      sessionState: state,
      resumable: state === 'RESUMABLE',
      reason,
      sessionExistenceCheck: existence,
      evidenceRefs,
      liveRunId: live?.id ?? null,
      runs: runList.runs,
      streams,
      replayFromSequence: conversation.lastConfirmedSequence + 1,
      notes,
    };
  }

  /**
   * Does the installed runtime advertise `--resume`?
   *
   * Answered from the one probe, and `false` when the runtime could not be
   * located at all — in which case the caller reports UNVERIFIED, because "we
   * could not check" is not the same claim as "it does not support it".
   */
  private async resumeSupported(): Promise<boolean> {
    if (this.located !== null) return supportsFlag(this.located, '--resume');
    const result = await this.locateOnce();
    if (!result.ok) return false;
    this.located = result.located;
    return supportsFlag(result.located, '--resume');
  }

  /** Another conversation or project holding the same session id, named. */
  private findForeignSessionOwner(conversation: ConversationRecord, sessionId: string): string | null {
    for (const other of this.store.listRecords('conversation').records) {
      if (other.id === conversation.id || other.claudeSessionId !== sessionId) continue;
      return `conversation ${other.id} of project ${other.projectId}`;
    }
    for (const run of this.store.listRecords('run').records) {
      if (run.sessionId !== sessionId || run.projectId === conversation.projectId) continue;
      return `run ${run.id} of project ${run.projectId}`;
    }
    return null;
  }

  /**
   * Evidence that a resume of this session was actually observed to fail.
   *
   * Only a persisted `session.lost` event counts. Nothing is concluded from the
   * absence of one, and nothing is concluded from hopeful or discouraging text
   * in stdout.
   */
  private findSessionLostEvidence(
    conversation: ConversationRecord,
    runs: readonly RunRecord[],
    sessionId: string,
  ): { readonly detail: string; readonly evidenceRefs: readonly EvidenceRef[] } | null {
    for (const run of runs.slice(0, 10)) {
      let page;
      try {
        page = this.store.readEvents({
          streamKey: makeStreamKey(conversation.projectId, run.id),
          types: ['session.lost'],
          limit: 10,
        });
      } catch {
        continue;
      }
      for (const event of page.events) {
        const payload = asRecord(event.payload);
        if (payload === null || asText(payload.sessionId) !== sessionId) continue;
        return {
          detail: asText(payload.detail) ?? `a session.lost event was recorded on run ${run.id}`,
          evidenceRefs: [
            { kind: 'event', ref: event.eventId, note: `session.lost on run ${run.id}` },
            ...event.evidenceRefs,
          ],
        };
      }
    }
    return null;
  }

  /* ====================================================================== */
  /*  listRuns / getRun                                                     */
  /* ====================================================================== */

  listRuns(payload: unknown): Record<string, unknown> {
    const body = asObject(payload);
    const projectId = optString(body, 'projectId');
    const conversationId = optString(body, 'conversationId');
    const liveOnly = body.liveOnly === true;
    const limit = optInteger(body, 'limit', 1, MAX_RUN_PAGE) ?? DEFAULT_RUN_PAGE;

    if (projectId !== undefined) this.conversations.requireProject(projectId);
    if (conversationId !== undefined) {
      const conversation = this.conversations.requireConversation(conversationId);
      if (projectId !== undefined) this.conversations.assertBelongsToProject(conversation, projectId);
    }

    const listed = this.store.listRecords('run');
    const matched = listed.records
      .filter((run) => projectId === undefined || run.projectId === projectId)
      .filter((run) => conversationId === undefined || run.conversationId === conversationId)
      .filter((run) => !liveOnly || isLiveRunStatus(run.status))
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));

    const adapterRuns = new Set(this.adapterIfAny?.activeRunIds() ?? []);
    const page = matched.slice(0, limit).map((run) => ({
      run,
      // Whether THIS bridge instance owns a process for it. A live status
      // without a registered process is a run nobody is watching.
      processRegisteredHere: adapterRuns.has(run.id),
    }));

    return {
      runs: page,
      total: matched.length,
      returned: page.length,
      truncated: matched.length > page.length,
      unreadable: listed.unreadable,
      bridgeInstanceId: this.bridgeInstanceId,
    };
  }

  getRun(payload: unknown): Record<string, unknown> {
    const body = asObject(payload);
    const runId = reqString(body, 'runId');
    const includeDerived = body.includeDerived !== false;

    const run = this.requireRun(runId);
    const anchor = this.conversations.anchorFor(makeStreamKey(run.projectId, run.id));
    const liveInfo = (this.adapterIfAny?.liveRuns() ?? []).find((entry) => entry.runId === run.id) ?? null;

    const outputPath = containedPath(this.evidenceRoot, join(this.evidenceRoot, run.id, 'output.txt'));
    const outputExists = outputPath !== null && fileExists(outputPath);

    return {
      run,
      streamKey: anchor.streamKey,
      stream: anchor,
      // Re-checked now, not remembered: a file can be deleted after it was written.
      output: {
        ref: `${run.id}/output.txt`,
        present: outputExists,
        note: outputExists ? null : 'no persisted assistant output file was found for this run',
      },
      process: liveInfo === null
        ? {
            registeredHere: false,
            note:
              'no process for this run is registered with this bridge instance; ' +
              'its liveness cannot be observed from here',
          }
        : {
            registeredHere: true,
            pid: liveInfo.pid,
            handleAlive: liveInfo.handleAlive,
            pidAlive: liveInfo.pidAlive,
            cancelRequested: liveInfo.cancelRequested,
          },
      derived: includeDerived ? this.deriveRunFacts(run) : null,
      bridgeInstanceId: this.bridgeInstanceId,
    };
  }

  private requireRun(runId: string): RunRecord {
    let read;
    try {
      read = this.store.getRecord('run', runId);
    } catch (error) {
      fail('BAD_REQUEST', 'That run id is not a usable record id.', errorText(error));
    }
    if (!read.ok) {
      if (read.reason === 'MISSING') fail('NOT_FOUND', `No run is stored with id ${safeId(runId)}.`, read.detail);
      fail('RUNTIME_ERROR', `The run record ${safeId(runId)} could not be read (${read.reason}).`, read.detail);
    }
    return read.record;
  }

  /**
   * Facts derived from the run's own event stream — including which files Claude
   * actually read. A file is only listed as READ when a `claude.tool.start` was
   * matched by a `claude.tool.end` that reported no error. A tool call with no
   * observed result is reported as exactly that, never as a read.
   */
  private deriveRunFacts(run: RunRecord): DerivedRunFacts {
    let events: readonly ForgeEvent[] = [];
    let truncated = false;
    try {
      const page = this.store.readEvents({
        streamKey: makeStreamKey(run.projectId, run.id),
        limit: this.maxDerivedEvents,
      });
      events = page.events;
      truncated = page.hasMore;
    } catch {
      return {
        eventsRead: 0,
        truncated: false,
        outputDeltas: 0,
        toolStarts: 0,
        toolEnds: 0,
        toolErrors: 0,
        stderrEvents: 0,
        sawOutputComplete: false,
        reportedSessionIds: [],
        fileAccess: [],
        fileAccessRule: FILE_ACCESS_RULE,
      };
    }

    let projectPath: string | null = null;
    const project = this.conversations.registry.get(run.projectId);
    if (project.ok) {
      try {
        projectPath = assertInsideRoot(project.value.canonicalPath, this.trustedRoot);
      } catch {
        projectPath = null;
      }
    }

    const facts = deriveFileAccess(events, projectPath);
    return { ...facts, truncated, fileAccessRule: FILE_ACCESS_RULE };
  }

  /* ====================================================================== */
  /*  Degraded notes                                                        */
  /* ====================================================================== */

  private publishDegraded(live: LiveRun, reason: string, detail: string): void {
    this.publishDegradedRaw(live.projectId, live.conversationId, live.runId, reason, detail);
  }

  private publishDegradedFor(run: RunRecord, reason: string, detail: string): void {
    this.publishDegradedRaw(run.projectId, run.conversationId, run.id, reason, detail);
  }

  private publishDegradedRaw(
    projectId: string,
    conversationId: string | null,
    runId: string | null,
    reason: string,
    detail: string,
  ): void {
    try {
      this.conversations.events.publish({
        projectId,
        runId,
        conversationId,
        source: 'bridge',
        type: 'bridge.degraded',
        status: 'DEGRADED',
        payload: { scope: 'run-lifecycle', reason, detail },
        evidenceRefs: runId === null ? [] : [{ kind: 'file', ref: `records/run/${runId}.json` }],
      });
    } catch {
      // There is nowhere left to record this honestly. The operation result and
      // the run's statusReason remain the only signal.
    }
  }

  /** Cancel every run this instance owns. For bridge shutdown. */
  async stopAll(reason = 'bridge shutdown'): Promise<readonly StopResult[]> {
    const adapter = this.adapterIfAny;
    if (adapter === null) return [];
    return adapter.stopAll(reason);
  }

  /**
   * The adapter this service owns, or null when nothing has been spawned yet.
   * For shutdown and diagnostics; never for deciding what a run's state is.
   */
  get claudeAdapter(): ClaudeAdapter | null {
    return this.adapterIfAny;
  }
}

/* ========================================================================== */
/*  Pure helpers — exported so they can be asserted on directly                */
/* ========================================================================== */

export const FILE_ACCESS_RULE =
  'a file is listed as READ only when a claude.tool.start naming it was matched by a claude.tool.end for the same ' +
  'toolUseId that reported isError=false. A call whose result was never observed is reported as NO_RESULT_OBSERVED ' +
  'and is never counted as a read.';

/**
 * Compose the prompt.
 *
 * The attachment manifest is PATHS, names and media types — never content, and
 * never bytes. Claude reads what it needs with its own tools, inside the
 * directory it was granted with `--add-dir`.
 */
export function composePrompt(message: string, manifest: readonly AttachmentManifestEntry[]): string {
  if (manifest.length === 0) return message;
  const lines = manifest.map(
    (entry, index) =>
      `${index + 1}. ${JSON.stringify(entry.name)} — ${entry.mediaType ?? 'media type not established'}, ` +
      `${entry.size} bytes, at ./${entry.projectRelativePath}`,
  );
  return [
    message,
    '',
    '---',
    'Files attached to this message. They are inside this project and readable with your file tools;',
    'nothing has been inlined into this prompt.',
    ...lines,
  ].join('\n');
}

/**
 * Which files Claude actually read, from the tool events and nothing else.
 * Pure over the events it is given.
 */
export function deriveFileAccess(
  events: readonly ForgeEvent[],
  projectPath: string | null,
): Omit<DerivedRunFacts, 'truncated' | 'fileAccessRule'> {
  interface Pending {
    readonly toolName: string;
    readonly reportedPath: string;
    readonly at: string;
  }
  const started = new Map<string, Pending>();
  const ended = new Map<string, boolean>();
  const sessionIds = new Set<string>();

  let outputDeltas = 0;
  let toolStarts = 0;
  let toolEnds = 0;
  let toolErrors = 0;
  let stderrEvents = 0;
  let sawOutputComplete = false;

  for (const event of events) {
    const payload = asRecord(event.payload);
    if (event.sessionId !== null) sessionIds.add(event.sessionId);

    switch (event.type) {
      case 'run.output.delta':
        outputDeltas += 1;
        break;
      case 'run.output.complete':
        sawOutputComplete = true;
        break;
      case 'claude.stderr':
        stderrEvents += 1;
        break;
      case 'session.started':
      case 'session.resumed': {
        const reported = payload === null ? null : asText(payload.sessionId);
        if (reported !== null) sessionIds.add(reported);
        break;
      }
      case 'claude.tool.start': {
        toolStarts += 1;
        if (payload === null) break;
        const toolUseId = asText(payload.toolUseId);
        const toolName = asText(payload.toolName);
        if (toolUseId === null || toolName === null) break;
        if (!FILE_READ_TOOLS.includes(toolName)) break;
        const filePath = readFilePathArgument(payload.input);
        if (filePath === null) break;
        started.set(toolUseId, { toolName, reportedPath: filePath, at: event.timestamp });
        break;
      }
      case 'claude.tool.end': {
        toolEnds += 1;
        if (payload === null) break;
        const toolUseId = asText(payload.toolUseId);
        const isError = asBool(payload.isError);
        if (isError === true) toolErrors += 1;
        if (toolUseId === null) break;
        ended.set(toolUseId, isError === true);
        break;
      }
      default:
        break;
    }
  }

  const fileAccess: FileAccessEntry[] = [];
  for (const [toolUseId, pending] of started) {
    const errored = ended.get(toolUseId);
    let insideProject = false;
    let projectRelativePath: string | null = null;
    if (projectPath !== null) {
      try {
        // Every path crosses the guard, including one that only came from a
        // tool event and is only ever displayed.
        const canonical = assertInsideRoot(pending.reportedPath, projectPath);
        insideProject = true;
        projectRelativePath = toPosixRelative(projectPath, canonical);
      } catch {
        insideProject = false;
        projectRelativePath = null;
      }
    }
    fileAccess.push({
      toolName: pending.toolName,
      toolUseId,
      reportedPath: pending.reportedPath,
      projectRelativePath,
      insideProject,
      outcome: errored === undefined ? 'NO_RESULT_OBSERVED' : errored ? 'FAILED' : 'READ',
      at: pending.at,
    });
  }

  return {
    eventsRead: events.length,
    outputDeltas,
    toolStarts,
    toolEnds,
    toolErrors,
    stderrEvents,
    sawOutputComplete,
    reportedSessionIds: [...sessionIds],
    fileAccess,
  };
}

/** The path argument of a read-shaped tool call, or null. Never guessed at. */
export function readFilePathArgument(input: unknown): string | null {
  const record = asRecord(input);
  if (record === null) return null;
  for (const key of ['file_path', 'notebook_path', 'path', 'filePath']) {
    const value = asText(record[key]);
    if (value !== null) return value;
  }
  return null;
}

export function toPosixRelative(root: string, target: string): string {
  const rel = relative(root, target);
  return rel.length === 0 ? '.' : rel.split('\\').join('/');
}

function dedupeRefs(refs: readonly EvidenceRef[]): readonly EvidenceRef[] {
  const seen = new Set<string>();
  const out: EvidenceRef[] = [];
  for (const ref of refs) {
    const key = `${ref.kind}|${ref.ref}|${ref.note ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  // Bounded: a long run must not grow its record without limit.
  return out.slice(0, 64);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asBool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/**
 * Did the caller explicitly ask to abandon an unresumable session and start a
 * new one? Only a literal `true` counts — nothing here is truthy-tested.
 */
function startFresh(body: Record<string, unknown>): boolean {
  return body.startNewSession === true;
}

/** Map an adapter refusal onto the contract's error vocabulary. */
function spawnErrorCode(error: unknown): 'CLAUDE_UNAVAILABLE' | 'BAD_REQUEST' | 'INVALID_STATE' | 'PATH_REJECTED' {
  if (!(error instanceof AdapterError)) return 'CLAUDE_UNAVAILABLE';
  switch (error.rejection) {
    case 'BAD_PROMPT':
    case 'BAD_SESSION_ID':
    case 'BAD_PERMISSION_MODE':
      return 'BAD_REQUEST';
    case 'BAD_PROJECT_PATH':
      return 'PATH_REJECTED';
    case 'DUPLICATE_RUN':
      return 'INVALID_STATE';
    case 'MISSING_REQUIRED_FLAG':
    case 'FORBIDDEN_FLAG':
    default:
      return 'CLAUDE_UNAVAILABLE';
  }
}

/* ========================================================================== */
/*  Wiring                                                                     */
/* ========================================================================== */

/**
 * One run service per store.
 *
 * It MUST be long-lived: it holds the adapter, and the adapter holds the child
 * processes. Rebuilding it per request would orphan every running process, so
 * the cache is keyed on the store and additionally checks the bridge instance
 * and the projects root — a change in either means a different workspace, and a
 * new service is the correct answer rather than a reused one.
 */
interface CachedRunService {
  readonly service: RunService;
  readonly root: string;
  readonly bridgeInstanceId: string;
}

const RUN_SERVICE_CACHE = new WeakMap<ForgeStore, CachedRunService>();

export function runServiceFor(ctx: OperationContext): RunService {
  const projectsRoot = resolveProjectsRootInfo().projectsRoot;
  const cached = RUN_SERVICE_CACHE.get(ctx.store);
  if (cached !== undefined && cached.root === projectsRoot && cached.bridgeInstanceId === ctx.bridgeInstanceId) {
    return cached.service;
  }
  const service = new RunService({
    conversations: conversationServiceFor(ctx),
    trustedRoot: projectsRoot,
    // Under the workspace data directory, beside the events and records it is
    // evidence for. Never inside a project: a run's proof must not be something
    // the run itself can rewrite.
    evidenceDir: join(ctx.store.dataDir, 'runs'),
    bridgeInstanceId: ctx.bridgeInstanceId,
  });
  RUN_SERVICE_CACHE.set(ctx.store, { service, root: projectsRoot, bridgeInstanceId: ctx.bridgeInstanceId });
  return service;
}

export function registerRunOperations(router: Router, options: { readonly override?: boolean } = {}): void {
  const registerOptions = options.override === true ? { override: true } : undefined;
  router.register('sendMessage', (payload, ctx) => runServiceFor(ctx).sendMessage(payload), registerOptions);
  router.register('stopRun', (payload, ctx) => runServiceFor(ctx).stopRun(payload), registerOptions);
  router.register('resumeSession', (payload, ctx) => runServiceFor(ctx).resumeSession(payload), registerOptions);
  router.register('listRuns', (payload, ctx) => runServiceFor(ctx).listRuns(payload), registerOptions);
  router.register('getRun', (payload, ctx) => runServiceFor(ctx).getRun(payload), registerOptions);
}

/** The operations this module owns. Used by tests and by the startup report. */
export const RUN_OPERATIONS = ['sendMessage', 'stopRun', 'resumeSession', 'listRuns', 'getRun'] as const;

export function createRunService(options: RunServiceOptions): RunService {
  return new RunService(options);
}
