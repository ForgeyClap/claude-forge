/**
 * Forge Workspace — the attachment staging pipeline.
 *
 * This is the only road a user-supplied file may travel into a project, and it
 * runs the contract's machine exactly as written:
 *
 *   SELECTED -> VALIDATING -> HASHING -> STAGING -> INDEXING -> READY
 *
 * with REJECTED, QUARANTINED, FAILED and REMOVED as the alternatives. Every
 * step is asserted against `ATTACHMENT_MACHINE` in `src/shared/state-machines.ts`,
 * so a state can never be written because a caller felt like it.
 *
 * READY IS A CLAIM ABOUT REALITY, and it is the claim that matters here, because
 * READY is what permits a message to reference the file and what permits Claude
 * Code to be pointed at it. So READY is only written when all of this is true and
 * was OBSERVED, not assumed:
 *
 *   1. the bytes were identified from their own content (`detect.ts`);
 *   2. the policy accepted them (`policy.ts`);
 *   3. the payload was written inside the attachment's own directory, through
 *      the path guard, and then RE-READ and RE-HASHED to the same digest;
 *   4. the metadata index was written and read back.
 *
 * If any of those cannot be established the state is REJECTED, QUARANTINED or
 * FAILED — never READY, and never "probably fine".
 *
 * STORAGE LAYOUT
 *   <project-root>/.forge/attachments/<conversationId>/<attachmentId>/
 *       <storedFilename>   the payload — only ever for an accepted file
 *       metadata.json      the AttachmentRecord as staged
 *       preview.json       the sanitised preview, pre-computed at INDEXING
 *
 * Every path is built segment by segment from validated ids and passed through
 * `assertInsideRoot` before use, and the CANONICAL path it returns is what gets
 * opened — never the string that went in.
 *
 * WHAT THIS MODULE NEVER DOES: spawn anything, open a shell, extract an archive,
 * render a document, follow a link out of the project, or write a byte outside
 * the attachment's own directory.
 */

import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import type { Dirent } from 'node:fs';

import type {
  AttachmentRecord,
  AttachmentState,
  EvidenceRef,
  EventType,
  OperationError,
  OperationErrorCode,
  SecurityVerdict,
} from '../../shared/protocol.ts';
import { assertAttachmentTransition, canAttachmentTransition } from '../../shared/state-machines.ts';
import { assertInsideRoot, isPathGuardError } from '../security/paths.ts';
import { ensureDir, fileExists, writeAtomic, writeJsonAtomic, readJsonSafe } from '../storage/atomic.ts';

import { detectFromBytes } from './detect.ts';
import type { DetectionResult } from './detect.ts';
import { evaluateAttachmentPolicy, sanitiseForDisplay } from './policy.ts';
import type { AttachmentLimits, PolicyDecision, PreviewPlan, SecurityFinding } from './policy.ts';

/* ========================================================================== */
/*  Layout                                                                     */
/* ========================================================================== */

/** The workspace-owned directory inside a project. Nothing else is touched. */
export const PROJECT_FORGE_DIR = '.forge';
export const ATTACHMENTS_DIR = 'attachments';
export const METADATA_FILENAME = 'metadata.json';
export const PREVIEW_FILENAME = 'preview.json';

/** Ids that may become a path segment. Deliberately narrower than a filename. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function assertSafeSegment(value: unknown, what: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value) || value.includes('..')) {
    throw new AttachmentPipelineError(
      'BAD_REQUEST',
      `${what} is not usable as a directory name.`,
      `${what} must match ${String(SAFE_ID)} and contain no dot-dot sequence.`,
    );
  }
  return value;
}

/* ========================================================================== */
/*  Errors                                                                     */
/* ========================================================================== */

/** Carries a protocol error code, so the bridge never invents one. */
export class AttachmentPipelineError extends Error {
  readonly code: OperationErrorCode;
  readonly detail: string | undefined;

  constructor(code: OperationErrorCode, message: string, detail?: string) {
    super(message);
    this.name = 'AttachmentPipelineError';
    this.code = code;
    this.detail = detail;
    Object.setPrototypeOf(this, AttachmentPipelineError.prototype);
  }

  toOperationError(): OperationError {
    return this.detail === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, detail: this.detail };
  }
}

export function isAttachmentPipelineError(value: unknown): value is AttachmentPipelineError {
  return value instanceof AttachmentPipelineError;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ========================================================================== */
/*  Transitions                                                                */
/* ========================================================================== */

/** One observed state change, with the evidence that justified it. */
export interface AttachmentTransition {
  readonly attachmentId: string;
  readonly from: AttachmentState | null;
  readonly to: AttachmentState;
  readonly at: string;
  /** Why, in words. Shown to the user and written to the event log. */
  readonly reason: string;
  readonly evidenceRefs: readonly EvidenceRef[];
}

/**
 * What the user's draft should do when staging did not end in READY. The
 * pipeline never sends anything and never edits a draft — it states what must
 * happen, and the composer obeys it. The one outcome that is never produced is
 * "carry on without the file".
 */
export type DraftAction =
  | 'ATTACHMENT_READY'
  /** Keep the text, keep the failed attachment visible, offer a retry. */
  | 'KEEP_DRAFT_ALLOW_RETRY'
  /** Keep the text; the file itself can never be accepted, so drop only it. */
  | 'KEEP_DRAFT_REMOVE_ATTACHMENT';

export interface StageAttachmentResult {
  readonly ok: boolean;
  readonly record: AttachmentRecord;
  readonly transitions: readonly AttachmentTransition[];
  readonly findings: readonly SecurityFinding[];
  readonly decision: PolicyDecision | null;
  readonly detection: DetectionResult | null;
  readonly preview: PreviewPlan | null;
  readonly error: OperationError | null;
  readonly draftAction: DraftAction;
  /** True when trying the same file again could plausibly succeed. */
  readonly retryable: boolean;
}

/* ========================================================================== */
/*  Input                                                                      */
/* ========================================================================== */

export interface StageAttachmentInput {
  readonly projectId: string;
  /** Absolute path of the project on disk. Validated, never trusted. */
  readonly projectRoot: string;
  readonly conversationId: string;
  /** Supply one to make staging idempotent across a retry; generated otherwise. */
  readonly attachmentId?: string;
  readonly filename: string;
  readonly declaredMediaType: string;
  readonly uploaderSource: AttachmentRecord['uploaderSource'];
  /** The bytes themselves. Exactly one of `bytes` / `sourcePath` is required. */
  readonly bytes?: Uint8Array;
  /** An existing file INSIDE the project, for `uploaderSource: 'project-file'`. */
  readonly sourcePath?: string;
  /** Attachments already on this draft message. Used for the per-message caps. */
  readonly siblings?: readonly AttachmentRecord[];
  /** ISO-8601. Passed in so the pipeline owns no clock and stays testable. */
  readonly now?: string;
  readonly limits?: Partial<AttachmentLimits>;
}

export interface AttachmentPipelineOptions {
  readonly limits?: Partial<AttachmentLimits>;
  /** Called for every transition. The bridge maps this to an `attachment.state` event. */
  readonly onTransition?: (transition: AttachmentTransition, record: AttachmentRecord) => void;
  /** Id generator. Injected so tests are deterministic and the module owns no randomness. */
  readonly generateId?: () => string;
  /** Clock. Same reason. */
  readonly now?: () => string;
}

/* ========================================================================== */
/*  Stored preview                                                             */
/* ========================================================================== */

export interface StoredPreview {
  readonly attachmentId: string;
  readonly kind: PreviewPlan['kind'];
  readonly text: string | null;
  readonly truncated: boolean;
  readonly reason: string;
  readonly generatedAt: string;
}

/* ========================================================================== */
/*  The pipeline                                                               */
/* ========================================================================== */

export class AttachmentPipeline {
  private readonly options: AttachmentPipelineOptions;

  constructor(options: AttachmentPipelineOptions = {}) {
    this.options = options;
  }

  private nowIso(explicit?: string): string {
    if (typeof explicit === 'string' && explicit.length > 0) return explicit;
    if (this.options.now) return this.options.now();
    return new Date().toISOString();
  }

  private newId(): string {
    if (this.options.generateId) return this.options.generateId();
    // From the platform CSPRNG, with the hyphens removed: this id becomes a
    // directory name, so the narrowest safe alphabet is the point.
    return `att_${randomUUID().replace(/-/g, '')}`;
  }

  /* ---------------------------------------------------------------- paths */

  /** `<projectRoot>/.forge/attachments`, canonicalised and containment-checked. */
  attachmentsRoot(projectRoot: string): string {
    if (typeof projectRoot !== 'string' || projectRoot.length === 0 || !isAbsolute(projectRoot)) {
      throw new AttachmentPipelineError('BAD_REQUEST', 'The project root must be an absolute path.');
    }
    // Canonicalise the root against itself: this resolves links and rejects the
    // malformed shapes before any child path is built from it.
    const canonicalProject = assertInsideRoot(projectRoot, projectRoot);
    const root = assertInsideRoot(join(canonicalProject, PROJECT_FORGE_DIR, ATTACHMENTS_DIR), canonicalProject);
    return root;
  }

  /** The one directory an attachment may ever write into. */
  attachmentDir(projectRoot: string, conversationId: string, attachmentId: string): string {
    const root = this.attachmentsRoot(projectRoot);
    assertSafeSegment(conversationId, 'conversationId');
    assertSafeSegment(attachmentId, 'attachmentId');
    return assertInsideRoot(join(root, conversationId, attachmentId), root);
  }

  /**
   * A path INSIDE an attachment's own directory. Called for every file the
   * pipeline touches, so a stored filename can never climb out of its folder
   * even if every check above it were wrong.
   */
  private childPath(dir: string, filename: string): string {
    if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
      throw new AttachmentPipelineError('PATH_REJECTED', 'A stored filename may not contain a path separator or a dot-dot sequence.');
    }
    return assertInsideRoot(join(dir, filename), dir);
  }

  /* ----------------------------------------------------------------- stage */

  /**
   * Run one file through the machine.
   *
   * Never throws for a rejected or quarantined file: those are OUTCOMES, and
   * the caller needs the record and the reasons. It throws only when the
   * request itself is malformed (bad ids, a path outside the project), because
   * that is a programming error on the bridge side, not a user outcome.
   */
  stage(input: StageAttachmentInput): StageAttachmentResult {
    const at = this.nowIso(input.now);
    const attachmentId = input.attachmentId ?? this.newId();
    assertSafeSegment(attachmentId, 'attachmentId');
    assertSafeSegment(input.conversationId, 'conversationId');
    if (typeof input.projectId !== 'string' || input.projectId.length === 0) {
      throw new AttachmentPipelineError('BAD_REQUEST', 'projectId is required.');
    }

    const dir = this.attachmentDir(input.projectRoot, input.conversationId, attachmentId);
    const transitions: AttachmentTransition[] = [];

    let record: AttachmentRecord = {
      id: attachmentId,
      projectId: input.projectId,
      conversationId: input.conversationId,
      originalFilename:
        typeof input.filename === 'string' && input.filename.length > 0
          ? sanitiseForDisplay(input.filename).slice(0, 255) || '(unprintable name)'
          : '(unnamed)',
      // Never empty, even on the paths that never write a file: the contract's
      // record requires a non-empty stored name, and a placeholder that says
      // "nothing was stored under this name" is honest where "" is just invalid.
      storedFilename: `${attachmentId}.unstored`,
      canonicalPath: dir,
      declaredMediaType: typeof input.declaredMediaType === 'string' ? input.declaredMediaType : '',
      detectedMediaType: null,
      size: 0,
      hash: null,
      createdAt: at,
      uploaderSource: input.uploaderSource,
      previewAvailable: false,
      state: 'SELECTED',
      security: 'CLEAN',
      securityNotes: [],
      claudeAccessible: false,
      deleted: false,
    };

    /** The only way this function changes state. Asserts the machine every time. */
    const move = (
      to: AttachmentState,
      reason: string,
      patch: Partial<AttachmentRecord>,
      evidenceRefs: readonly EvidenceRef[] = [],
    ): void => {
      assertAttachmentTransition(record.state, to);
      const transition: AttachmentTransition = { attachmentId, from: record.state, to, at: this.nowIso(input.now), reason, evidenceRefs };
      record = Object.freeze({ ...record, ...patch, state: to });
      transitions.push(transition);
      this.options.onTransition?.(transition, record);
    };

    const finish = (
      ok: boolean,
      error: OperationError | null,
      draftAction: DraftAction,
      retryable: boolean,
      decision: PolicyDecision | null,
      detection: DetectionResult | null,
      preview: PreviewPlan | null,
    ): StageAttachmentResult =>
      Object.freeze({
        ok,
        record,
        transitions: Object.freeze([...transitions]),
        findings: decision?.findings ?? [],
        decision,
        detection,
        preview,
        error,
        draftAction,
        retryable,
      });

    /* ------------------------------------------------------- read the bytes */

    let bytes: Uint8Array;
    try {
      bytes = this.readInputBytes(input);
    } catch (error) {
      const code: OperationErrorCode = isPathGuardError(error) ? error.code : 'BAD_REQUEST';
      move('REJECTED', `The file could not be read: ${errorMessage(error)}`, {
        securityNotes: [`[input-unreadable] ${errorMessage(error)}`],
        security: 'REJECT',
      });
      return finish(
        false,
        { code, message: `"${record.originalFilename}" could not be read, so nothing was attached. Your message text is untouched.`, detail: errorMessage(error) },
        'KEEP_DRAFT_ALLOW_RETRY',
        true,
        null,
        null,
        null,
      );
    }

    /* ------------------------------------------------------------ VALIDATING */

    move('VALIDATING', 'Identifying the file from its own bytes and applying the attachment policy.', { size: bytes.length });

    const detection = detectFromBytes(bytes);
    const siblingBytes = (input.siblings ?? [])
      .filter((sibling) => !sibling.deleted && sibling.state !== 'REMOVED' && sibling.state !== 'REJECTED')
      .reduce((total, sibling) => total + sibling.size, 0);
    const siblingCount = (input.siblings ?? []).filter((sibling) => !sibling.deleted && sibling.state !== 'REMOVED' && sibling.state !== 'REJECTED').length;

    let projectBytesSoFar = 0;
    try {
      projectBytesSoFar = this.measureProjectUsage(input.projectRoot);
    } catch {
      // A quota we could not measure is UNKNOWN, and an unknown quota must not
      // silently become "plenty of room". It is recorded as a finding below.
      projectBytesSoFar = Number.NaN;
    }

    const decision = evaluateAttachmentPolicy({
      filename: input.filename,
      declaredMediaType: record.declaredMediaType,
      bytes,
      detection,
      limits: input.limits ?? this.options.limits,
      messageBytesSoFar: siblingBytes,
      messageAttachmentsSoFar: siblingCount,
      projectBytesSoFar: Number.isFinite(projectBytesSoFar) ? projectBytesSoFar : 0,
    });

    const notes = [...decision.notes];
    if (!Number.isFinite(projectBytesSoFar)) {
      notes.push('[project-quota-unmeasured] The project staging area could not be measured, so the project quota was NOT enforced for this file.');
    }

    const detectedMediaType = detection.mediaType;
    const common: Partial<AttachmentRecord> = {
      detectedMediaType,
      size: bytes.length,
      securityNotes: notes,
      security: decision.verdict,
      storedFilename: decision.filename.stored.length > 0 ? decision.filename.stored : record.storedFilename,
      originalFilename: decision.filename.display.length > 0 ? decision.filename.display : record.originalFilename,
    };

    if (decision.verdict === 'REJECT') {
      const reasons = decision.findings.filter((finding) => finding.severity === 'REJECT').map((finding) => finding.message);
      move('REJECTED', reasons[0] ?? 'The attachment policy refused this file.', { ...common, claudeAccessible: false });
      return finish(
        false,
        {
          code: decision.rejectionCode ?? 'ATTACHMENT_REJECTED',
          message: `"${record.originalFilename}" was not attached. ${reasons.join(' ')} Your message text and your other attachments are unchanged.`,
          detail: reasons.join(' | '),
        },
        'KEEP_DRAFT_REMOVE_ATTACHMENT',
        false,
        decision,
        detection,
        decision.preview,
      );
    }

    /* --------------------------------------------------------------- HASHING */

    move('HASHING', 'Computing the SHA-256 of the bytes exactly as they were received.', common);

    let hash: string;
    try {
      hash = createHash('sha256').update(bytes).digest('hex');
    } catch (error) {
      move('FAILED', `Hashing failed: ${errorMessage(error)}`, { securityNotes: [...notes, `[hash-failed] ${errorMessage(error)}`] });
      return finish(
        false,
        { code: 'RUNTIME_ERROR', message: `"${record.originalFilename}" could not be hashed, so it was not staged. Your draft is kept — you can try again.`, detail: errorMessage(error) },
        'KEEP_DRAFT_ALLOW_RETRY',
        true,
        decision,
        detection,
        decision.preview,
      );
    }

    if (decision.verdict === 'QUARANTINE') {
      // The bytes are deliberately NOT written. Metadata only — which is what
      // makes "Forge never executes an attachment" true by construction rather
      // than by promise.
      const reasons = decision.findings.filter((finding) => finding.severity === 'QUARANTINE').map((finding) => finding.message);
      move(
        'QUARANTINED',
        reasons[0] ?? 'The attachment policy quarantined this file.',
        {
          ...common,
          hash,
          claudeAccessible: false,
          previewAvailable: false,
          securityNotes: [
            ...notes,
            '[quarantine-no-payload] The file content was never written to the project. Only this record exists.',
          ],
        },
        [{ kind: 'file', ref: dir, note: 'reserved attachment directory; no payload was written' }],
      );
      return finish(
        false,
        {
          code: 'ATTACHMENT_REJECTED',
          message: `"${record.originalFilename}" is quarantined and cannot be sent. ${reasons.join(' ')}`,
          detail: reasons.join(' | '),
        },
        'KEEP_DRAFT_REMOVE_ATTACHMENT',
        false,
        decision,
        detection,
        decision.preview,
      );
    }

    /* --------------------------------------------------------------- STAGING */

    move('STAGING', 'Writing the payload inside the attachment directory, through the path guard.', { hash });

    let payloadPath: string;
    try {
      ensureDir(dir);
      this.ensureForgeDirIsIgnored(input.projectRoot);
      payloadPath = this.childPath(dir, decision.filename.stored);
      writeAtomic(payloadPath, bytes);
    } catch (error) {
      const code: OperationErrorCode = isPathGuardError(error) ? error.code : 'RUNTIME_ERROR';
      move('FAILED', `Staging failed: ${errorMessage(error)}`, { securityNotes: [...notes, `[staging-failed] ${errorMessage(error)}`] });
      return finish(
        false,
        { code, message: `"${record.originalFilename}" could not be staged. Your draft is kept — you can try again.`, detail: errorMessage(error) },
        'KEEP_DRAFT_ALLOW_RETRY',
        true,
        decision,
        detection,
        decision.preview,
      );
    }

    /* -------------------------------------------------------------- INDEXING */

    move('INDEXING', 'Verifying the staged bytes and writing the on-disk index.', { canonicalPath: payloadPath });

    // The verification that makes READY honest: read back what was actually
    // written and hash it again. Equal digests, or the pipeline fails.
    let staged: Uint8Array;
    try {
      staged = readFileSync(payloadPath);
    } catch (error) {
      move('FAILED', `The staged file could not be read back: ${errorMessage(error)}`, {
        securityNotes: [...notes, `[verify-read-failed] ${errorMessage(error)}`],
      });
      return finish(
        false,
        { code: 'RUNTIME_ERROR', message: `"${record.originalFilename}" was written but could not be read back, so it is not marked ready. Your draft is kept.`, detail: errorMessage(error) },
        'KEEP_DRAFT_ALLOW_RETRY',
        true,
        decision,
        detection,
        decision.preview,
      );
    }

    const stagedHash = createHash('sha256').update(staged).digest('hex');
    if (stagedHash !== hash || staged.length !== bytes.length) {
      this.deletePayloadQuietly(payloadPath);
      move('FAILED', 'The staged file does not match the bytes that were received.', {
        securityNotes: [
          ...notes,
          `[verify-hash-mismatch] The file on disk hashes to a different value than the upload (${staged.length} bytes staged, ${bytes.length} received). The staged copy was removed.`,
        ],
      });
      return finish(
        false,
        {
          code: 'RUNTIME_ERROR',
          message: `"${record.originalFilename}" did not survive being written to disk unchanged, so it is not marked ready. Your draft is kept — you can try again.`,
          detail: 'sha256 of the staged file differs from the sha256 of the received bytes',
        },
        'KEEP_DRAFT_ALLOW_RETRY',
        true,
        decision,
        detection,
        decision.preview,
      );
    }

    const previewPath = this.childPath(dir, PREVIEW_FILENAME);
    const metadataPath = this.childPath(dir, METADATA_FILENAME);
    const previewAvailable = decision.preview.kind !== 'metadata-only';

    try {
      const storedPreview: StoredPreview = {
        attachmentId,
        kind: decision.preview.kind,
        text: decision.preview.text,
        truncated: decision.preview.truncated,
        reason: decision.preview.reason,
        generatedAt: at,
      };
      writeJsonAtomic(previewPath, storedPreview);
    } catch (error) {
      // A missing preview is not a reason to refuse the file; it IS a reason not
      // to claim a preview exists.
      notes.push(`[preview-unavailable] The preview could not be written (${errorMessage(error)}), so none is offered.`);
    }

    const readyRecord: AttachmentRecord = Object.freeze({
      ...record,
      hash,
      canonicalPath: payloadPath,
      previewAvailable: previewAvailable && fileExists(previewPath),
      claudeAccessible: decision.claudeAccessible,
      securityNotes: notes,
      state: 'READY',
    });

    // The index is written with `state: 'READY'` a moment before the machine is
    // asked to make that transition, and that ordering is deliberate: every
    // fact READY rests on (payload written, re-read, re-hashed to the same
    // digest) has already been established at this point, and writing the index
    // is the LAST thing that can fail. If it does, the record goes to FAILED —
    // which INDEXING permits and READY would not.
    try {
      writeJsonAtomic(metadataPath, readyRecord);
      const readBack = readJsonSafe<AttachmentRecord>(metadataPath);
      if (!readBack.ok) throw new Error(`metadata could not be read back: ${readBack.detail}`);
    } catch (error) {
      this.deletePayloadQuietly(payloadPath);
      move('FAILED', `Indexing failed: ${errorMessage(error)}`, { securityNotes: [...notes, `[indexing-failed] ${errorMessage(error)}`] });
      return finish(
        false,
        { code: 'RUNTIME_ERROR', message: `"${record.originalFilename}" could not be indexed, so it is not ready. Your draft is kept — you can try again.`, detail: errorMessage(error) },
        'KEEP_DRAFT_ALLOW_RETRY',
        true,
        decision,
        detection,
        decision.preview,
      );
    }

    /* ------------------------------------------------------------------ READY */

    move(
      'READY',
      'The payload was written, read back and re-hashed to the same digest, and the index was written and read back.',
      {
        hash,
        canonicalPath: payloadPath,
        previewAvailable: readyRecord.previewAvailable,
        claudeAccessible: decision.claudeAccessible,
        securityNotes: notes,
      },
      [
        { kind: 'file', ref: payloadPath, hash, note: 'staged payload, re-read and re-hashed after writing' },
        { kind: 'file', ref: metadataPath, note: 'attachment index, written and read back' },
      ],
    );

    return finish(true, null, 'ATTACHMENT_READY', false, decision, detection, decision.preview);
  }

  /* ---------------------------------------------------------------- remove */

  /**
   * Remove an attachment. The payload is deleted; the record survives as
   * REMOVED, because a message that referenced it needs to keep explaining
   * itself after the file is gone.
   */
  remove(record: AttachmentRecord, projectRoot: string, reason = 'Removed by the user.'): { readonly record: AttachmentRecord; readonly transition: AttachmentTransition | null; readonly payloadDeleted: boolean } {
    const at = this.nowIso();
    if (!canAttachmentTransition(record.state, 'REMOVED')) {
      return { record, transition: null, payloadDeleted: false };
    }

    let payloadDeleted = false;
    try {
      // `attachmentDir` has already proved this path is inside the project's
      // attachment root; the recursive delete acts on the canonical path it
      // returned, never on anything assembled from the record's own strings.
      const dir = this.attachmentDir(projectRoot, record.conversationId, record.id);
      rmSync(dir, { recursive: true, force: true });
      payloadDeleted = true;
    } catch {
      payloadDeleted = false;
    }

    const next: AttachmentRecord = Object.freeze({
      ...record,
      state: 'REMOVED',
      deleted: true,
      claudeAccessible: false,
      previewAvailable: false,
      securityNotes: [
        ...record.securityNotes,
        payloadDeleted
          ? '[removed] The attachment directory and its payload were deleted.'
          : '[removed-payload-uncertain] The record is REMOVED, but the payload could not be confirmed deleted from disk.',
      ],
    });

    const transition: AttachmentTransition = {
      attachmentId: record.id,
      from: record.state,
      to: 'REMOVED',
      at,
      reason,
      evidenceRefs: payloadDeleted ? [{ kind: 'file', ref: record.canonicalPath, note: 'deleted' }] : [],
    };
    this.options.onTransition?.(transition, next);
    return { record: next, transition, payloadDeleted };
  }

  /* --------------------------------------------------------------- rescan */

  /**
   * Re-check a file that is already READY. `READY -> QUARANTINED` exists in the
   * contract precisely so a later scan is allowed to change its mind, and this
   * is the function that uses it.
   */
  rescan(record: AttachmentRecord, projectRoot: string): { readonly record: AttachmentRecord; readonly transition: AttachmentTransition | null; readonly decision: PolicyDecision | null } {
    if (record.state !== 'READY') return { record, transition: null, decision: null };
    let bytes: Uint8Array;
    try {
      const dir = this.attachmentDir(projectRoot, record.conversationId, record.id);
      const payload = this.childPath(dir, record.storedFilename);
      bytes = readFileSync(payload);
    } catch (error) {
      const at = this.nowIso();
      const next: AttachmentRecord = Object.freeze({
        ...record,
        state: 'QUARANTINED',
        claudeAccessible: false,
        previewAvailable: false,
        securityNotes: [...record.securityNotes, `[rescan-unreadable] The staged file could not be re-read (${errorMessage(error)}), so it is no longer treated as ready.`],
      });
      const transition: AttachmentTransition = {
        attachmentId: record.id,
        from: record.state,
        to: 'QUARANTINED',
        at,
        reason: 'The staged file could not be re-read on rescan.',
        evidenceRefs: [],
      };
      this.options.onTransition?.(transition, next);
      return { record: next, transition, decision: null };
    }

    const detection = detectFromBytes(bytes);
    const decision = evaluateAttachmentPolicy({
      filename: record.originalFilename,
      declaredMediaType: record.declaredMediaType,
      bytes,
      detection,
      limits: this.options.limits,
    });

    const currentHash = createHash('sha256').update(bytes).digest('hex');
    const changed = record.hash !== null && record.hash !== currentHash;

    if (!changed && (decision.verdict === 'CLEAN' || decision.verdict === 'WARN')) {
      return { record, transition: null, decision };
    }

    const at = this.nowIso();
    const reason = changed
      ? 'The staged file changed on disk after it was accepted.'
      : `A later scan produced a ${decision.verdict} verdict.`;
    const next: AttachmentRecord = Object.freeze({
      ...record,
      state: 'QUARANTINED',
      security: changed ? 'QUARANTINE' : decision.verdict,
      claudeAccessible: false,
      previewAvailable: false,
      securityNotes: [...record.securityNotes, `[rescan] ${reason}`, ...decision.notes],
    });
    const transition: AttachmentTransition = {
      attachmentId: record.id,
      from: record.state,
      to: 'QUARANTINED',
      at,
      reason,
      evidenceRefs: [{ kind: 'file', ref: record.canonicalPath, hash: currentHash, note: 'hash observed during rescan' }],
    };
    this.options.onTransition?.(transition, next);
    return { record: next, transition, decision };
  }

  /* -------------------------------------------------------------- previews */

  /** Read the sanitised preview written at INDEXING. Never re-reads the payload. */
  readPreview(record: AttachmentRecord, projectRoot: string): StoredPreview | null {
    if (!record.previewAvailable || record.deleted) return null;
    try {
      const dir = this.attachmentDir(projectRoot, record.conversationId, record.id);
      const path = this.childPath(dir, PREVIEW_FILENAME);
      const result = readJsonSafe<StoredPreview>(path);
      return result.ok ? result.value : null;
    } catch {
      return null;
    }
  }

  /* ----------------------------------------------------------------- usage */

  /**
   * Total bytes currently stored under the project's attachment root. Measured
   * from the filesystem rather than from a counter, because a counter drifts and
   * a quota built on a drifting number is not a quota.
   */
  measureProjectUsage(projectRoot: string): number {
    const root = this.attachmentsRoot(projectRoot);
    return measureDirectoryBytes(root, 0);
  }

  /* --------------------------------------------------------------- helpers */

  private readInputBytes(input: StageAttachmentInput): Uint8Array {
    const hasBytes = input.bytes instanceof Uint8Array;
    const hasPath = typeof input.sourcePath === 'string' && input.sourcePath.length > 0;
    if (hasBytes === hasPath) {
      throw new AttachmentPipelineError('BAD_REQUEST', 'Exactly one of `bytes` or `sourcePath` must be supplied.');
    }
    if (hasBytes) return input.bytes as Uint8Array;

    // A project file is read only after the guard proves it is inside the
    // project, and it is read from the CANONICAL path the guard returned.
    const projectRoot = assertInsideRoot(input.projectRoot, input.projectRoot);
    const canonical = assertInsideRoot(input.sourcePath as string, projectRoot);
    const stat = statSync(canonical);
    if (!stat.isFile()) {
      throw new AttachmentPipelineError('BAD_REQUEST', 'The source path is not a regular file.');
    }
    return readFileSync(canonical);
  }

  /**
   * Keep staged attachments out of the user's version control. Writing this once
   * is cheap; a repository that quietly commits an attached credential file is
   * not.
   */
  private ensureForgeDirIsIgnored(projectRoot: string): void {
    try {
      const canonicalProject = assertInsideRoot(projectRoot, projectRoot);
      const forgeDir = assertInsideRoot(join(canonicalProject, PROJECT_FORGE_DIR), canonicalProject);
      ensureDir(forgeDir);
      const ignorePath = assertInsideRoot(join(forgeDir, '.gitignore'), forgeDir);
      if (!fileExists(ignorePath)) {
        writeAtomic(ignorePath, '# Written by Forge. Staged attachments never belong in version control.\n*\n');
      }
    } catch {
      // Best effort only: failing to write an ignore file must never stop a
      // staging operation, and it is never reported as though it succeeded.
    }
  }

  private deletePayloadQuietly(path: string): void {
    try {
      rmSync(path, { force: true });
    } catch {
      /* the caller is already reporting a failure; this is cleanup */
    }
  }
}

export function createAttachmentPipeline(options: AttachmentPipelineOptions = {}): AttachmentPipeline {
  return new AttachmentPipeline(options);
}

/** Recursive byte count with a depth bound, so a link loop cannot hang it. */
function measureDirectoryBytes(dir: string, depth: number): number {
  if (depth > 6) return 0;
  let total = 0;
  let entries: readonly Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += measureDirectoryBytes(child, depth + 1);
    } else if (entry.isFile()) {
      try {
        total += statSync(child).size;
      } catch {
        /* a file that vanished mid-scan contributes nothing */
      }
    }
    // Symbolic links are counted as nothing: following one would leave the
    // attachment tree, which is the whole thing the guard exists to prevent.
  }
  return total;
}

/* ========================================================================== */
/*  The boundary: only READY attachments may be referenced                     */
/* ========================================================================== */

export interface ReferenceCheck {
  readonly attachmentId: string;
  readonly ok: boolean;
  readonly state: AttachmentState | null;
  readonly filename: string | null;
  readonly security: SecurityVerdict | null;
  /** Empty when ok. Otherwise the exact reason, naming the file. */
  readonly reason: string;
  readonly code: OperationErrorCode | null;
}

export interface ReferenceReport {
  readonly ok: boolean;
  readonly checks: readonly ReferenceCheck[];
  /** The canonical paths Claude Code may be pointed at. Empty unless ok. */
  readonly paths: readonly string[];
  readonly error: OperationError | null;
}

const STATE_EXPLANATIONS: Readonly<Record<AttachmentState, string>> = {
  SELECTED: 'it has not been validated yet',
  VALIDATING: 'it is still being validated',
  HASHING: 'it is still being hashed',
  STAGING: 'it is still being written to the project',
  INDEXING: 'it is still being indexed',
  READY: 'it is ready',
  REJECTED: 'it was refused by the attachment policy and never entered the workspace',
  QUARANTINED: 'it is quarantined — its content was never stored and Claude Code may never be pointed at it',
  FAILED: 'its processing failed before it was ready',
  REMOVED: 'it was removed',
};

/**
 * THE BOUNDARY CHECK. A message may reference an attachment only when that
 * attachment is READY, is not deleted, and is marked accessible.
 *
 * The report names every offending attachment, its state and why — because
 * "attachment not ready" tells the user nothing, and a composer that cannot
 * explain the refusal will be tempted to send without the file, which is the
 * one behaviour this whole pipeline exists to prevent.
 */
export function checkAttachmentsReferencable(
  records: readonly AttachmentRecord[],
  requestedIds: readonly string[],
): ReferenceReport {
  const byId = new Map(records.map((record) => [record.id, record]));
  const checks: ReferenceCheck[] = [];
  const paths: string[] = [];

  for (const id of requestedIds) {
    const record = byId.get(id);
    if (!record) {
      checks.push({
        attachmentId: id,
        ok: false,
        state: null,
        filename: null,
        security: null,
        reason: `Attachment "${id}" is not known to this conversation, so the message cannot reference it.`,
        code: 'NOT_FOUND',
      });
      continue;
    }
    const name = record.originalFilename;
    if (record.deleted || record.state === 'REMOVED') {
      checks.push({
        attachmentId: id,
        ok: false,
        state: record.state,
        filename: name,
        security: record.security,
        reason: `"${name}" was removed and can no longer be sent.`,
        code: 'ATTACHMENT_NOT_READY',
      });
      continue;
    }
    if (record.state !== 'READY') {
      const rejected = record.state === 'REJECTED' || record.state === 'QUARANTINED';
      checks.push({
        attachmentId: id,
        ok: false,
        state: record.state,
        filename: name,
        security: record.security,
        reason: `"${name}" is ${record.state}: ${STATE_EXPLANATIONS[record.state]}.${record.securityNotes.length > 0 ? ` ${record.securityNotes[0]}` : ''}`,
        code: rejected ? 'ATTACHMENT_REJECTED' : 'ATTACHMENT_NOT_READY',
      });
      continue;
    }
    if (!record.claudeAccessible) {
      checks.push({
        attachmentId: id,
        ok: false,
        state: record.state,
        filename: name,
        security: record.security,
        reason: `"${name}" is staged but is not accessible to Claude Code (security verdict ${record.security}), so it cannot be referenced by a message.`,
        code: 'ATTACHMENT_REJECTED',
      });
      continue;
    }
    checks.push({ attachmentId: id, ok: true, state: record.state, filename: name, security: record.security, reason: '', code: null });
    paths.push(record.canonicalPath);
  }

  const failures = checks.filter((check) => !check.ok);
  if (failures.length === 0) {
    return { ok: true, checks, paths, error: null };
  }
  const code = failures.some((failure) => failure.code === 'ATTACHMENT_REJECTED')
    ? 'ATTACHMENT_REJECTED'
    : failures.some((failure) => failure.code === 'NOT_FOUND')
      ? 'NOT_FOUND'
      : 'ATTACHMENT_NOT_READY';

  return {
    ok: false,
    checks,
    paths: [],
    error: {
      code,
      message: `This message cannot be sent yet: ${failures.map((failure) => failure.reason).join(' ')} Your message text is kept — remove the attachment or wait for it to finish.`,
      detail: failures.map((failure) => `${failure.attachmentId}=${failure.state ?? 'UNKNOWN'}`).join(', '),
    },
  };
}

/** Throwing form, for the write path. The read path uses the report instead. */
export function assertAttachmentsReferencable(
  records: readonly AttachmentRecord[],
  requestedIds: readonly string[],
): readonly string[] {
  const report = checkAttachmentsReferencable(records, requestedIds);
  if (report.ok) return report.paths;
  const error = report.error as OperationError;
  throw new AttachmentPipelineError(error.code, error.message, error.detail);
}

/* ========================================================================== */
/*  Events                                                                     */
/* ========================================================================== */

/**
 * The shape the bridge appends to the event log for a transition. `type` is
 * pinned to the contract's `attachment.state`, and no `status` is set: an
 * `OperationalStatus` would be a different vocabulary, and attachments have
 * their own.
 */
export interface AttachmentStateEventDraft {
  readonly projectId: string;
  readonly conversationId: string;
  readonly runId: null;
  readonly source: 'bridge';
  readonly type: EventType;
  readonly payload: {
    readonly attachmentId: string;
    readonly from: AttachmentState | null;
    readonly to: AttachmentState;
    readonly reason: string;
    readonly originalFilename: string;
    readonly detectedMediaType: string | null;
    readonly declaredMediaType: string;
    readonly size: number;
    readonly hash: string | null;
    readonly security: SecurityVerdict;
    readonly claudeAccessible: boolean;
  };
  readonly evidenceRefs: readonly EvidenceRef[];
}

export function toAttachmentStateEvent(transition: AttachmentTransition, record: AttachmentRecord): AttachmentStateEventDraft {
  return {
    projectId: record.projectId,
    conversationId: record.conversationId,
    runId: null,
    source: 'bridge',
    type: 'attachment.state',
    payload: {
      attachmentId: transition.attachmentId,
      from: transition.from,
      to: transition.to,
      reason: transition.reason,
      originalFilename: record.originalFilename,
      detectedMediaType: record.detectedMediaType,
      declaredMediaType: record.declaredMediaType,
      size: record.size,
      hash: record.hash,
      security: record.security,
      claudeAccessible: record.claudeAccessible,
    },
    evidenceRefs: transition.evidenceRefs,
  };
}
