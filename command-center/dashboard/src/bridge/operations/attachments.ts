/**
 * Forge Workspace — attachment operations.
 *
 * `stageAttachment`, `removeAttachment`, `listAttachments`,
 * `getAttachmentPreview`. This module is the wiring between the browser's
 * composer and `../attachments/pipeline.ts`; it owns no security policy of its
 * own and reimplements none of the pipeline's.
 *
 * WHAT THIS FILE IS RESPONSIBLE FOR
 *
 *  - GETTING THE BYTES ACROSS INTACT. An operation payload is bounded by
 *    `config.maxRequestBytes` (1 MiB by default), so a file larger than that
 *    arrives as a sequence of base64 chunks under one `uploadId`. Every chunk is
 *    validated as canonical base64 and its decoded length is checked against
 *    what its own padding declares, so a mangled transfer fails loudly instead
 *    of quietly staging a shorter file. The chunk buffer is bounded in count,
 *    in bytes and in age.
 *
 *  - DRIVING THE REAL MACHINE. Nothing here writes an `AttachmentState`. The
 *    pipeline runs SELECTED -> VALIDATING -> HASHING -> STAGING -> INDEXING ->
 *    READY against `ATTACHMENT_MACHINE`, and this file forwards each transition
 *    it OBSERVES as an `attachment.state` event. There is no code path that
 *    emits a state the pipeline did not produce, so the composer's progress bar
 *    cannot show a step that did not happen.
 *
 *  - NEVER DROPPING A FILE SILENTLY. A rejection, a quarantine and a failure are
 *    OUTCOMES, not exceptions: the record is persisted with the real reason in
 *    `securityNotes`, the operation returns `accepted: false` together with that
 *    record, and `retryable` says whether trying the same file again could
 *    plausibly work. Only a malformed REQUEST — an unknown project, an unusable
 *    id, corrupt base64 — produces an `OperationError`.
 *
 *  - KEEPING REMOVAL TOTAL. `removeAttachment` deletes the staged bytes, writes
 *    the record as REMOVED, and unlinks the id from its conversation record. An
 *    attachment removed in the composer can never remain referenced by a
 *    message, and each of those three steps is reported separately so a partial
 *    removal is visible rather than rounded up to success.
 *
 *  - HANDING BACK ONLY SAFE PREVIEWS. See `getAttachmentPreview`.
 */

import { readFileSync, statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { AttachmentRecord, ConversationRecord, OperationError } from '../../shared/protocol.ts';

import { detectFromBytes } from '../attachments/detect.ts';
import type { DetectedFormat } from '../attachments/detect.ts';
import {
  createAttachmentPipeline,
  isAttachmentPipelineError,
  PREVIEW_FILENAME,
  toAttachmentStateEvent,
} from '../attachments/pipeline.ts';
import type { AttachmentPipeline, AttachmentTransition, StoredPreview } from '../attachments/pipeline.ts';
import { DEFAULT_ATTACHMENT_LIMITS, sanitiseForDisplay, stripTerminalEscapes } from '../attachments/policy.ts';
import {
  assertInsideRoot,
  describeSensitivePath,
  isPathGuardError,
  RESTRICTED_FILE_MESSAGE,
} from '../security/paths.ts';
import { asObject, fail, optInteger, optString, reqString } from '../router.ts';
import type { OperationContext, Router } from '../router.ts';

import { MAX_RELATIVE_PATH_LENGTH, resolveProjectContext } from './files.ts';
import type { ProjectContext } from './files.ts';

/* ========================================================================== */
/*  Limits                                                                     */
/* ========================================================================== */

/** Hard ceiling on one base64 chunk, whatever the request limit allows. */
export const MAX_CHUNK_BASE64_CHARS = 512 * 1024;

/** Uploads that have begun but not committed. Bounded so a client cannot grow it. */
export const MAX_PENDING_UPLOADS = 8;

/** Total buffered upload bytes across every pending upload. */
export const MAX_PENDING_UPLOAD_BYTES = 128 * 1024 * 1024;

/** A pending upload older than this is discarded and its bytes are dropped. */
export const PENDING_UPLOAD_TTL_MS = 15 * 60_000;

/** Largest image returned as a data URI. Beyond it, metadata only. */
export const MAX_IMAGE_PREVIEW_BYTES = 3 * 1024 * 1024;

/** Characters of preview text returned. */
export const MAX_PREVIEW_TEXT_CHARS = 64 * 1024;

/**
 * Ids that may become a directory name. Narrower than both the pipeline's and
 * the store's own patterns, so an id accepted here is accepted by each of them.
 */
const SAFE_ATTACHMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const UPLOADER_SOURCES: readonly AttachmentRecord['uploaderSource'][] = [
  'picker',
  'drag-drop',
  'clipboard',
  'project-file',
];

/**
 * Formats whose bytes are genuinely a raster image a browser can render.
 * Mirrors the pipeline's own preview set. `avif-or-heif` is deliberately absent:
 * its detection is PROBABLE rather than CERTAIN, and a data URI is a claim that
 * the bytes ARE the type named in it.
 */
const IMAGE_FORMATS: ReadonlySet<DetectedFormat> = new Set<DetectedFormat>([
  'png',
  'jpeg',
  'webp',
  'gif',
  'bmp',
  'ico',
]);

/* ========================================================================== */
/*  Pending chunked uploads                                                    */
/* ========================================================================== */

interface PendingUpload {
  readonly uploadId: string;
  readonly projectId: string;
  readonly conversationId: string;
  readonly attachmentId: string;
  readonly filename: string;
  readonly declaredMediaType: string;
  readonly uploaderSource: AttachmentRecord['uploaderSource'];
  readonly declaredTotalBytes: number;
  readonly createdAt: number;
  chunks: Uint8Array[];
  receivedBytes: number;
  updatedAt: number;
}

/**
 * Buffered uploads live in memory for the life of one bridge process and are
 * never written anywhere until the pipeline decides the file may be staged.
 * A crash therefore loses an in-flight upload — which is the honest outcome,
 * and far better than leaving half a file inside the project.
 */
const pendingUploads = new Map<string, PendingUpload>();

function pendingBytes(): number {
  let total = 0;
  for (const upload of pendingUploads.values()) total += upload.receivedBytes;
  return total;
}

function prunePendingUploads(now: number): number {
  let dropped = 0;
  for (const [uploadId, upload] of pendingUploads) {
    if (now - upload.updatedAt > PENDING_UPLOAD_TTL_MS) {
      pendingUploads.delete(uploadId);
      dropped += 1;
    }
  }
  return dropped;
}

/** Exposed for diagnostics and tests. Reports what is buffered, never the bytes. */
export function pendingUploadStats(): {
  readonly uploads: number;
  readonly bufferedBytes: number;
  readonly maxUploads: number;
  readonly maxBufferedBytes: number;
} {
  return {
    uploads: pendingUploads.size,
    bufferedBytes: pendingBytes(),
    maxUploads: MAX_PENDING_UPLOADS,
    maxBufferedBytes: MAX_PENDING_UPLOAD_BYTES,
  };
}

/* ========================================================================== */
/*  Payload helpers                                                            */
/* ========================================================================== */

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireAttachmentId(raw: string | undefined, key: string): string | undefined {
  if (raw === undefined) return undefined;
  if (!SAFE_ATTACHMENT_ID.test(raw) || raw.includes('..')) {
    fail(
      'BAD_REQUEST',
      `${key} is not usable as an attachment id.`,
      `it must match ${String(SAFE_ATTACHMENT_ID)} and contain no dot-dot sequence`,
    );
  }
  return raw;
}

function requireUploaderSource(raw: string | undefined): AttachmentRecord['uploaderSource'] {
  if (raw === undefined) return 'picker';
  const match = UPLOADER_SOURCES.find((source) => source === raw);
  if (match === undefined) {
    fail('BAD_REQUEST', `uploaderSource must be one of ${UPLOADER_SOURCES.join(', ')}.`);
  }
  return match;
}

/**
 * Decode canonical base64, or refuse.
 *
 * `Buffer.from(x, 'base64')` is deliberately lenient: it skips anything it does
 * not recognise and stops at the first bad group, so a corrupted transfer
 * decodes to a SHORTER file without complaint — and a shorter file that hashes
 * fine is exactly the kind of silent damage this system exists not to produce.
 * The alphabet, the length and the padding are therefore checked first, and the
 * decoded length is compared with what the padding itself declares.
 */
function decodeBase64(raw: unknown, key: string, maxChars: number): Uint8Array {
  if (typeof raw !== 'string') fail('BAD_REQUEST', `${key} must be a base64-encoded string.`);
  if (raw.length === 0) fail('BAD_REQUEST', `${key} is empty; there are no bytes to attach.`);
  if (raw.length > maxChars) {
    fail(
      'BAD_REQUEST',
      `${key} is ${raw.length} characters; this bridge accepts at most ${maxChars} per request. Send the file as chunks.`,
    );
  }
  if (raw.length % 4 !== 0) {
    fail('BAD_REQUEST', `${key} is not canonical base64: its length is not a multiple of four.`);
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    fail(
      'BAD_REQUEST',
      `${key} contains characters that are not base64. Send standard base64 with no whitespace, no newlines and no URL-safe substitutions.`,
    );
  }
  const padding = raw.endsWith('==') ? 2 : raw.endsWith('=') ? 1 : 0;
  const expected = (raw.length / 4) * 3 - padding;
  const decoded = Buffer.from(raw, 'base64');
  if (decoded.length !== expected) {
    fail(
      'BAD_REQUEST',
      `${key} did not decode to the length its own padding declares (${decoded.length} of ${expected} bytes). The upload was damaged in transit and was not attached.`,
    );
  }
  return decoded;
}

/** Largest base64 string this bridge's configured request limit can carry. */
function chunkCapFor(ctx: OperationContext): number {
  // 0.7 leaves room for the JSON envelope, the ids and the field names that
  // travel with the payload. It is a bound, not an estimate of one.
  const fromConfig = Math.floor(ctx.config.maxRequestBytes * 0.7);
  return Math.max(1_024, Math.min(MAX_CHUNK_BASE64_CHARS, fromConfig));
}

/* ========================================================================== */
/*  Store access                                                               */
/* ========================================================================== */

interface AttachmentSet {
  readonly records: readonly AttachmentRecord[];
  readonly unreadable: readonly { readonly id: string; readonly reason: string; readonly detail: string }[];
}

function attachmentsFor(
  ctx: OperationContext,
  projectId: string,
  conversationId: string | null,
): AttachmentSet {
  const listed = ctx.store.listRecords('attachment');
  const records = listed.records.filter(
    (record) =>
      record.projectId === projectId && (conversationId === null || record.conversationId === conversationId),
  );
  return {
    records,
    unreadable: listed.unreadable.map((entry) => ({ id: entry.id, reason: entry.reason, detail: entry.detail })),
  };
}

function loadAttachment(ctx: OperationContext, projectId: string, attachmentId: string): AttachmentRecord {
  let read;
  try {
    read = ctx.store.getRecord('attachment', attachmentId);
  } catch (error) {
    fail('BAD_REQUEST', 'That attachment id is not a usable record id.', errorMessage(error));
  }
  if (!read.ok) {
    if (read.reason === 'MISSING') {
      fail('NOT_FOUND', `No attachment is registered with id ${attachmentId}.`, read.detail);
    }
    fail('RUNTIME_ERROR', `The attachment record ${attachmentId} could not be read (${read.reason}).`, read.detail);
  }
  if (read.record.projectId !== projectId) {
    // Answering across projects would let a caller who knows an id read another
    // project's attachment. NOT_FOUND rather than PERMISSION_DENIED: confirming
    // the id exists elsewhere is itself information.
    fail('NOT_FOUND', `No attachment is registered with id ${attachmentId} in this project.`);
  }
  return read.record;
}

/* ========================================================================== */
/*  Events                                                                     */
/* ========================================================================== */

interface EventTally {
  published: number;
  failed: number;
  lastFailure: string | null;
}

/**
 * Forward one observed transition as an `attachment.state` event.
 *
 * A logging failure never fails the staging operation — the file is already
 * where it is — but it is counted and returned, so "the composer saw every
 * step" is never assumed when it is not true.
 */
function publishTransition(
  ctx: OperationContext,
  tally: EventTally,
  transition: AttachmentTransition,
  record: AttachmentRecord,
): void {
  const draft = toAttachmentStateEvent(transition, record);
  try {
    ctx.events.publish({
      projectId: draft.projectId,
      runId: draft.runId,
      conversationId: draft.conversationId,
      source: draft.source,
      type: draft.type,
      payload: draft.payload,
      evidenceRefs: draft.evidenceRefs,
    });
    tally.published += 1;
  } catch (error) {
    tally.failed += 1;
    tally.lastFailure = errorMessage(error).slice(0, 200);
  }
}

/* ========================================================================== */
/*  Conversation linkage                                                       */
/* ========================================================================== */

interface ConversationLinkResult {
  readonly conversationKnown: boolean;
  readonly changed: boolean;
  /**
   * True when the conversation record now reflects the intended state, INCLUDING
   * the case where there is no such record and therefore nothing referencing the
   * attachment. False means we could not establish it either way — which is what
   * stops `removeAttachment` from reporting a complete removal.
   */
  readonly ok: boolean;
  readonly detail: string;
}

function updateConversationAttachments(
  ctx: OperationContext,
  conversationId: string,
  mutate: (ids: readonly string[]) => readonly string[],
): ConversationLinkResult {
  let read;
  try {
    read = ctx.store.getRecord('conversation', conversationId);
  } catch (error) {
    return { conversationKnown: false, changed: false, ok: false, detail: `conversation id unusable: ${errorMessage(error)}` };
  }
  if (!read.ok) {
    // MISSING is the only unreadable case that is also an answer: there is no
    // record, so nothing references the attachment. Any other failure means we
    // do not know what that record says, and "do not know" is not "fine".
    const missing = read.reason === 'MISSING';
    return {
      conversationKnown: false,
      changed: false,
      ok: missing,
      detail: missing
        ? 'no conversation record exists yet, so there is nothing referencing this attachment to update'
        : `the conversation record could not be read (${read.reason}), so what it references is UNKNOWN`,
    };
  }

  const current = read.record;
  const next = mutate(current.attachmentIds);
  if (next.length === current.attachmentIds.length && next.every((id, i) => id === current.attachmentIds[i])) {
    return { conversationKnown: true, changed: false, ok: true, detail: 'the conversation record already matched' };
  }

  const updated: ConversationRecord = {
    ...current,
    attachmentIds: next,
    updatedAt: new Date().toISOString(),
  };
  try {
    ctx.store.saveRecord('conversation', updated);
    return { conversationKnown: true, changed: true, ok: true, detail: 'the conversation record was rewritten' };
  } catch (error) {
    return {
      conversationKnown: true,
      changed: false,
      ok: false,
      detail: `the conversation record could not be rewritten: ${errorMessage(error)}`,
    };
  }
}

/* ========================================================================== */
/*  stageAttachment                                                            */
/* ========================================================================== */

export interface StageOutcome {
  readonly operation: 'stage';
  /** True ONLY when the pipeline reached READY. Never inferred. */
  readonly accepted: boolean;
  readonly attachmentId: string;
  readonly record: AttachmentRecord;
  readonly state: AttachmentRecord['state'];
  readonly security: AttachmentRecord['security'];
  readonly transitions: readonly {
    readonly from: string | null;
    readonly to: string;
    readonly at: string;
    readonly reason: string;
  }[];
  readonly findings: readonly { readonly rule: string; readonly severity: string; readonly message: string }[];
  readonly preview: { readonly kind: string; readonly available: boolean; readonly reason: string };
  readonly quota: {
    readonly fileBytes: number;
    readonly messageBytes: number;
    readonly messageAttachments: number;
    readonly projectBytes: number | null;
    readonly limits: { readonly maxFileBytes: number; readonly maxMessageTotalBytes: number; readonly maxProjectQuotaBytes: number; readonly maxAttachmentsPerMessage: number };
  };
  /** Null when accepted. Otherwise the REAL reason, with a contract code. */
  readonly error: OperationError | null;
  readonly retryable: boolean;
  readonly draftAction: string;
  readonly recordPersisted: boolean;
  readonly recordPersistError: string | null;
  readonly conversationLink: ConversationLinkResult;
  readonly events: { readonly published: number; readonly failed: number; readonly lastFailure: string | null };
}

export interface UploadProgress {
  readonly operation: 'upload';
  readonly uploadId: string;
  readonly attachmentId: string;
  readonly projectId: string;
  readonly conversationId: string;
  readonly declaredTotalBytes: number;
  readonly receivedBytes: number;
  readonly complete: boolean;
  readonly maxChunkBase64Chars: number;
  readonly expiresAt: string;
  readonly note: string;
}

export interface UploadAborted {
  readonly operation: 'abort';
  readonly uploadId: string;
  readonly aborted: boolean;
  readonly discardedBytes: number;
  readonly note: string;
}

type StageAttachmentResponse = StageOutcome | UploadProgress | UploadAborted;

interface StageBytesInput {
  readonly attachmentId: string;
  readonly filename: string;
  readonly declaredMediaType: string;
  readonly uploaderSource: AttachmentRecord['uploaderSource'];
  readonly bytes?: Uint8Array;
  readonly sourcePath?: string;
}

/**
 * Run one prepared file through the pipeline and persist whatever came out.
 *
 * Every exit from this function returns a record. There is no branch that
 * discards a file the user chose.
 */
function runPipeline(
  ctx: OperationContext,
  context: ProjectContext,
  conversationId: string,
  input: StageBytesInput,
): StageOutcome {
  const tally: EventTally = { published: 0, failed: 0, lastFailure: null };
  const pipeline = createAttachmentPipeline({
    onTransition: (transition, record) => {
      publishTransition(ctx, tally, transition, record);
    },
  });

  const siblings = attachmentsFor(ctx, context.record.id, conversationId).records.filter(
    (record) => record.id !== input.attachmentId,
  );

  let projectBytes: number | null;
  try {
    projectBytes = pipeline.measureProjectUsage(context.root);
  } catch {
    projectBytes = null;
  }

  let result;
  try {
    result = pipeline.stage({
      projectId: context.record.id,
      projectRoot: context.root,
      conversationId,
      attachmentId: input.attachmentId,
      filename: input.filename,
      declaredMediaType: input.declaredMediaType,
      uploaderSource: input.uploaderSource,
      ...(input.bytes !== undefined ? { bytes: input.bytes } : {}),
      ...(input.sourcePath !== undefined ? { sourcePath: input.sourcePath } : {}),
      siblings,
    });
  } catch (error) {
    // The pipeline throws only for a malformed REQUEST (an unusable id, a path
    // outside the project). That is a client error, not a file outcome, so it
    // travels back as a typed OperationError rather than as a record.
    if (isAttachmentPipelineError(error)) fail(error.code, error.message, error.detail);
    if (isPathGuardError(error)) fail(error.code, error.message, error.detail);
    fail('RUNTIME_ERROR', 'The attachment could not be processed.', errorMessage(error));
  }

  let recordPersisted = false;
  let recordPersistError: string | null = null;
  try {
    ctx.store.saveRecord('attachment', result.record);
    recordPersisted = true;
  } catch (error) {
    recordPersistError = errorMessage(error).slice(0, 300);
  }

  // Only a READY attachment is linked to the conversation. A rejected file is
  // kept as a record so the composer can explain and offer a retry, but it is
  // never something a message could reference.
  const conversationLink =
    result.record.state === 'READY' && recordPersisted
      ? updateConversationAttachments(ctx, conversationId, (ids) =>
          ids.includes(result.record.id) ? ids : [...ids, result.record.id],
        )
      : {
          conversationKnown: false,
          changed: false,
          ok: true,
          detail: 'not linked: the attachment did not reach READY, so no message may reference it',
        };

  const siblingBytes = siblings
    .filter((record) => !record.deleted && record.state !== 'REMOVED' && record.state !== 'REJECTED')
    .reduce((total, record) => total + record.size, 0);

  return {
    operation: 'stage',
    accepted: result.ok && result.record.state === 'READY',
    attachmentId: result.record.id,
    record: result.record,
    state: result.record.state,
    security: result.record.security,
    transitions: result.transitions.map((transition) => ({
      from: transition.from,
      to: transition.to,
      at: transition.at,
      reason: transition.reason,
    })),
    findings: result.findings.map((finding) => ({
      rule: finding.rule,
      severity: finding.severity,
      message: finding.message,
    })),
    preview: {
      kind: result.preview?.kind ?? 'metadata-only',
      available: result.record.previewAvailable,
      reason: result.preview?.reason ?? 'No preview was produced.',
    },
    quota: {
      fileBytes: result.record.size,
      messageBytes: siblingBytes + result.record.size,
      messageAttachments: siblings.length + 1,
      projectBytes,
      limits: {
        maxFileBytes: DEFAULT_ATTACHMENT_LIMITS.maxFileBytes,
        maxMessageTotalBytes: DEFAULT_ATTACHMENT_LIMITS.maxMessageTotalBytes,
        maxProjectQuotaBytes: DEFAULT_ATTACHMENT_LIMITS.maxProjectQuotaBytes,
        maxAttachmentsPerMessage: DEFAULT_ATTACHMENT_LIMITS.maxAttachmentsPerMessage,
      },
    },
    error: result.error,
    retryable: result.retryable,
    draftAction: result.draftAction,
    recordPersisted,
    recordPersistError,
    conversationLink,
    events: { published: tally.published, failed: tally.failed, lastFailure: tally.lastFailure },
  };
}

function stageAttachment(payload: unknown, ctx: OperationContext): StageAttachmentResponse {
  const body = asObject(payload);
  const now = Date.now();
  prunePendingUploads(now);

  const projectId = reqString(body, 'projectId');
  const conversationId = reqString(body, 'conversationId');
  const mode = optString(body, 'mode', 32) ?? (body.sourcePath === undefined ? 'single' : 'project-file');
  const chunkCap = chunkCapFor(ctx);

  const context = resolveProjectContext(ctx.store, projectId);

  /* ------------------------------------------------------------- one shot */

  if (mode === 'single') {
    const attachmentId = requireAttachmentId(optString(body, 'attachmentId'), 'attachmentId') ?? newAttachmentId();
    const filename = reqString(body, 'filename', DEFAULT_ATTACHMENT_LIMITS.maxFilenameLength);
    const bytes = decodeBase64(body.dataBase64, 'dataBase64', chunkCap);
    return runPipeline(ctx, context, conversationId, {
      attachmentId,
      filename,
      declaredMediaType: optString(body, 'mediaType', 255) ?? '',
      uploaderSource: requireUploaderSource(optString(body, 'uploaderSource', 32)),
      bytes,
    });
  }

  /* -------------------------------------------------- a file already inside */

  if (mode === 'project-file') {
    const raw = reqString(body, 'sourcePath', MAX_RELATIVE_PATH_LENGTH);
    const attachmentId = requireAttachmentId(optString(body, 'attachmentId'), 'attachmentId') ?? newAttachmentId();
    const sourcePath = resolveProjectFileForStaging(context, raw);
    const filename = optString(body, 'filename', DEFAULT_ATTACHMENT_LIMITS.maxFilenameLength) ?? basenameOf(sourcePath);
    return runPipeline(ctx, context, conversationId, {
      attachmentId,
      filename,
      declaredMediaType: optString(body, 'mediaType', 255) ?? '',
      uploaderSource: 'project-file',
      sourcePath,
    });
  }

  /* --------------------------------------------------------------- chunked */

  if (mode === 'begin') {
    if (pendingUploads.size >= MAX_PENDING_UPLOADS) {
      fail(
        'QUOTA_EXCEEDED',
        `This bridge holds at most ${MAX_PENDING_UPLOADS} uploads in flight at once. Finish or abort one before starting another.`,
      );
    }
    const declaredTotalBytes = optInteger(body, 'totalBytes', 1, DEFAULT_ATTACHMENT_LIMITS.maxFileBytes);
    if (declaredTotalBytes === undefined) {
      fail(
        'BAD_REQUEST',
        `totalBytes is required to begin a chunked upload, and must be between 1 and ${DEFAULT_ATTACHMENT_LIMITS.maxFileBytes}.`,
      );
    }
    if (pendingBytes() + declaredTotalBytes > MAX_PENDING_UPLOAD_BYTES) {
      fail(
        'QUOTA_EXCEEDED',
        `That upload would push the in-flight buffer past ${MAX_PENDING_UPLOAD_BYTES} bytes. Finish or abort an upload first.`,
      );
    }
    const upload: PendingUpload = {
      uploadId: `upl_${randomUUID().replace(/-/g, '')}`,
      projectId: context.record.id,
      conversationId,
      attachmentId: requireAttachmentId(optString(body, 'attachmentId'), 'attachmentId') ?? newAttachmentId(),
      filename: reqString(body, 'filename', DEFAULT_ATTACHMENT_LIMITS.maxFilenameLength),
      declaredMediaType: optString(body, 'mediaType', 255) ?? '',
      uploaderSource: requireUploaderSource(optString(body, 'uploaderSource', 32)),
      declaredTotalBytes,
      createdAt: now,
      chunks: [],
      receivedBytes: 0,
      updatedAt: now,
    };
    pendingUploads.set(upload.uploadId, upload);
    return uploadProgress(upload, chunkCap, 'Send the file as chunks, then commit. Nothing is written to the project until commit runs the staging pipeline.');
  }

  if (mode === 'chunk' || mode === 'commit' || mode === 'abort') {
    const uploadId = reqString(body, 'uploadId');
    const upload = pendingUploads.get(uploadId);
    if (upload === undefined) {
      fail(
        'NOT_FOUND',
        'That upload is not in flight. It was never begun, it was already committed, or it expired and its bytes were discarded.',
        `uploads expire after ${PENDING_UPLOAD_TTL_MS}ms without activity`,
      );
    }
    if (upload.projectId !== context.record.id || upload.conversationId !== conversationId) {
      fail('CONFLICT', 'That upload belongs to a different project or conversation.');
    }

    if (mode === 'abort') {
      const discarded = upload.receivedBytes;
      pendingUploads.delete(uploadId);
      return {
        operation: 'abort',
        uploadId,
        aborted: true,
        discardedBytes: discarded,
        note: 'The buffered bytes were dropped. Nothing had been written to the project.',
      };
    }

    if (mode === 'chunk') {
      const bytes = decodeBase64(body.dataBase64, 'dataBase64', chunkCap);
      const offset = optInteger(body, 'offset', 0, DEFAULT_ATTACHMENT_LIMITS.maxFileBytes);

      if (offset !== undefined && offset !== upload.receivedBytes) {
        // A retried chunk that lands entirely inside what we already hold is the
        // same chunk arriving twice; accepting it again would duplicate bytes.
        if (offset < upload.receivedBytes && offset + bytes.length <= upload.receivedBytes) {
          return uploadProgress(upload, chunkCap, 'This chunk was already received; it was not applied twice.');
        }
        fail(
          'CONFLICT',
          `This chunk claims to start at byte ${offset}, but ${upload.receivedBytes} bytes have been received. Resend from byte ${upload.receivedBytes}.`,
        );
      }

      if (upload.receivedBytes + bytes.length > upload.declaredTotalBytes) {
        fail(
          'BAD_REQUEST',
          `This chunk would bring the upload to ${upload.receivedBytes + bytes.length} bytes, past the ${upload.declaredTotalBytes} it declared. Nothing was stored.`,
        );
      }
      if (pendingBytes() + bytes.length > MAX_PENDING_UPLOAD_BYTES) {
        fail('QUOTA_EXCEEDED', `The in-flight upload buffer is full (${MAX_PENDING_UPLOAD_BYTES} bytes).`);
      }

      upload.chunks.push(bytes);
      upload.receivedBytes += bytes.length;
      upload.updatedAt = now;
      return uploadProgress(upload, chunkCap, 'Chunk received. Nothing is written to the project until commit.');
    }

    // mode === 'commit'
    if (upload.receivedBytes !== upload.declaredTotalBytes) {
      fail(
        'BAD_REQUEST',
        `This upload declared ${upload.declaredTotalBytes} bytes but ${upload.receivedBytes} arrived. It was not committed, and the buffered bytes are still held — resend the missing chunks.`,
      );
    }
    const assembled = Buffer.concat(upload.chunks, upload.receivedBytes);
    pendingUploads.delete(uploadId);
    return runPipeline(ctx, context, conversationId, {
      attachmentId: upload.attachmentId,
      filename: upload.filename,
      declaredMediaType: upload.declaredMediaType,
      uploaderSource: upload.uploaderSource,
      bytes: assembled,
    });
  }

  fail(
    'BAD_REQUEST',
    'mode must be one of single, project-file, begin, chunk, commit, abort.',
    `received ${JSON.stringify(mode).slice(0, 40)}`,
  );
}

function uploadProgress(upload: PendingUpload, chunkCap: number, note: string): UploadProgress {
  return {
    operation: 'upload',
    uploadId: upload.uploadId,
    attachmentId: upload.attachmentId,
    projectId: upload.projectId,
    conversationId: upload.conversationId,
    declaredTotalBytes: upload.declaredTotalBytes,
    receivedBytes: upload.receivedBytes,
    complete: upload.receivedBytes === upload.declaredTotalBytes,
    maxChunkBase64Chars: chunkCap,
    expiresAt: new Date(upload.updatedAt + PENDING_UPLOAD_TTL_MS).toISOString(),
    note,
  };
}

function newAttachmentId(): string {
  return `att_${randomUUID().replace(/-/g, '')}`;
}

function basenameOf(absolute: string): string {
  const parts = absolute.split(/[\\/]+/);
  return parts[parts.length - 1] ?? 'attachment';
}

/**
 * Turn a project-relative path into something the pipeline may read.
 *
 * A file already inside the project still has to pass the restriction check: a
 * `.env` does not become safe to copy into the attachment staging area — and
 * from there into a message to Claude Code — merely because it was already on
 * disk. That is the one route by which a credential file could otherwise walk
 * straight past `readProjectFile`'s refusal.
 */
function resolveProjectFileForStaging(context: ProjectContext, raw: string): string {
  if (/^[A-Za-z]:/.test(raw) || raw.startsWith('/') || raw.startsWith('\\')) {
    fail('PATH_REJECTED', 'sourcePath must be relative to the project.');
  }
  for (const segment of raw.split(/[\\/]+/)) {
    if (segment === '..') fail('PATH_REJECTED', 'sourcePath may not contain a dot-dot segment.');
  }

  let canonical: string;
  try {
    canonical = assertInsideRoot(join(context.root, raw), context.root);
  } catch (error) {
    if (isPathGuardError(error)) fail(error.code, error.message, error.detail);
    fail('PATH_REJECTED', 'sourcePath could not be validated against the project root.', errorMessage(error));
  }

  const relative = canonical.slice(context.root.length).replace(/^[\\/]+/, '').split('\\').join('/');
  const sensitivity = describeSensitivePath(relative.length > 0 ? relative : raw);
  if (sensitivity.sensitive) {
    fail('PERMISSION_REQUIRED', RESTRICTED_FILE_MESSAGE, sensitivity.reasons.join('; '));
  }

  let stat;
  try {
    stat = statSync(canonical);
  } catch (error) {
    fail('NOT_FOUND', 'That file is not present in the project.', errorMessage(error));
  }
  if (!stat.isFile()) fail('BAD_REQUEST', 'sourcePath is not a regular file.');
  return canonical;
}

/* ========================================================================== */
/*  removeAttachment                                                           */
/* ========================================================================== */

export interface RemoveAttachmentResult {
  readonly attachmentId: string;
  readonly state: AttachmentRecord['state'];
  readonly alreadyRemoved: boolean;
  /** True only when the staged directory was observed to be gone. */
  readonly payloadDeleted: boolean;
  readonly recordPersisted: boolean;
  readonly recordPersistError: string | null;
  readonly conversationLink: ConversationLinkResult;
  /** True when every part of the removal is known to have happened. */
  readonly complete: boolean;
  readonly notes: readonly string[];
  readonly events: { readonly published: number; readonly failed: number; readonly lastFailure: string | null };
}

function removeAttachment(payload: unknown, ctx: OperationContext): RemoveAttachmentResult {
  const body = asObject(payload);
  const projectId = reqString(body, 'projectId');
  const attachmentId = reqString(body, 'attachmentId');
  const reason = optString(body, 'reason', 300) ?? 'Removed by the user.';

  const context = resolveProjectContext(ctx.store, projectId);
  const record = loadAttachment(ctx, context.record.id, attachmentId);

  const tally: EventTally = { published: 0, failed: 0, lastFailure: null };
  const pipeline = createAttachmentPipeline({
    onTransition: (transition, next) => {
      publishTransition(ctx, tally, transition, next);
    },
  });

  const notes: string[] = [];

  // The reference has to go whether or not the bytes can be deleted: an
  // attachment the composer removed must not survive inside a message, and a
  // stubborn file on disk is a separate, smaller problem.
  const conversationLink = updateConversationAttachments(ctx, record.conversationId, (ids) =>
    ids.filter((id) => id !== attachmentId),
  );
  if (conversationLink.conversationKnown && !conversationLink.changed) {
    notes.push('The conversation record did not reference this attachment.');
  }

  if (record.state === 'REMOVED' && record.deleted) {
    return {
      attachmentId,
      state: 'REMOVED',
      alreadyRemoved: true,
      payloadDeleted: false,
      recordPersisted: true,
      recordPersistError: null,
      conversationLink,
      complete: conversationLink.ok,
      notes: [...notes, 'This attachment was already REMOVED; nothing further was done to it.'],
      events: { published: 0, failed: 0, lastFailure: null },
    };
  }

  let removal;
  try {
    removal = pipeline.remove(record, context.root, reason);
  } catch (error) {
    if (isAttachmentPipelineError(error)) fail(error.code, error.message, error.detail);
    if (isPathGuardError(error)) fail(error.code, error.message, error.detail);
    fail('RUNTIME_ERROR', 'The attachment could not be removed.', errorMessage(error));
  }

  if (removal.transition === null) {
    // The machine refuses REMOVED from this state. That is a fact about the
    // record, not something to work around by writing the state anyway.
    fail(
      'INVALID_STATE',
      `An attachment in state ${record.state} cannot be moved to REMOVED.`,
      'the attachment state machine has no such transition',
    );
  }

  let recordPersisted = false;
  let recordPersistError: string | null = null;
  try {
    ctx.store.saveRecord('attachment', removal.record);
    recordPersisted = true;
  } catch (error) {
    recordPersistError = errorMessage(error).slice(0, 300);
  }

  if (!removal.payloadDeleted) {
    notes.push(
      'The staged bytes could NOT be confirmed deleted from disk. The record is REMOVED and the message reference is gone, but a copy may still exist in the project.',
    );
  }
  if (!recordPersisted) {
    notes.push('The REMOVED record could not be written, so the removal is not durable across a restart.');
  }
  if (!conversationLink.ok) {
    notes.push(`The conversation reference could not be settled: ${conversationLink.detail}`);
  }

  return {
    attachmentId,
    state: removal.record.state,
    alreadyRemoved: false,
    payloadDeleted: removal.payloadDeleted,
    recordPersisted,
    recordPersistError,
    conversationLink,
    // Every part of the removal, and nothing rounded up. The bytes are gone, the
    // REMOVED record is durable, and no conversation still names this id.
    complete: removal.payloadDeleted && recordPersisted && conversationLink.ok,
    notes,
    events: { published: tally.published, failed: tally.failed, lastFailure: tally.lastFailure },
  };
}

/* ========================================================================== */
/*  listAttachments                                                            */
/* ========================================================================== */

export interface AttachmentListEntry {
  readonly record: AttachmentRecord;
  /** Observed on disk right now, not inferred from the record's own state. */
  readonly payloadPresent: boolean;
  readonly payloadDetail: string;
  readonly referencable: boolean;
  readonly referenceReason: string;
}

export interface ListAttachmentsResult {
  readonly projectId: string;
  readonly conversationId: string | null;
  readonly attachments: readonly AttachmentListEntry[];
  readonly count: number;
  /** Records on disk that could not be produced, and why. Never hidden. */
  readonly unreadable: readonly { readonly id: string; readonly reason: string; readonly detail: string }[];
  readonly projectStagedBytes: number | null;
  readonly projectQuotaBytes: number;
}

function payloadPath(pipeline: AttachmentPipeline, root: string, record: AttachmentRecord): string | null {
  try {
    const dir = pipeline.attachmentDir(root, record.conversationId, record.id);
    if (record.storedFilename.includes('/') || record.storedFilename.includes('\\') || record.storedFilename.includes('..')) {
      return null;
    }
    return assertInsideRoot(join(dir, record.storedFilename), dir);
  } catch {
    return null;
  }
}

function listAttachments(payload: unknown, ctx: OperationContext): ListAttachmentsResult {
  const body = asObject(payload);
  const projectId = reqString(body, 'projectId');
  const conversationId = optString(body, 'conversationId') ?? null;
  const includeRemoved = body.includeRemoved === true;

  const context = resolveProjectContext(ctx.store, projectId);
  const pipeline = createAttachmentPipeline();
  const set = attachmentsFor(ctx, context.record.id, conversationId);

  const attachments: AttachmentListEntry[] = [];
  for (const record of set.records) {
    if (!includeRemoved && (record.deleted || record.state === 'REMOVED')) continue;

    let payloadPresent = false;
    let payloadDetail: string;
    const path = payloadPath(pipeline, context.root, record);
    if (path === null) {
      payloadDetail = 'the recorded stored filename does not resolve inside this attachment’s own directory';
    } else {
      try {
        payloadPresent = statSync(path).isFile();
        payloadDetail = payloadPresent ? 'the staged file is present' : 'the staged path exists but is not a regular file';
      } catch {
        payloadDetail =
          record.state === 'QUARANTINED'
            ? 'no payload exists, which is correct: a quarantined file is never written'
            : 'no staged file is present at the recorded path';
      }
    }

    const referencable = record.state === 'READY' && !record.deleted && record.claudeAccessible && payloadPresent;
    attachments.push({
      record,
      payloadPresent,
      payloadDetail,
      referencable,
      referenceReason: referencable
        ? 'READY, accessible, and the staged bytes were observed on disk'
        : record.state !== 'READY'
          ? `not referencable: the attachment is ${record.state}`
          : !record.claudeAccessible
            ? `not referencable: the security verdict is ${record.security}`
            : 'not referencable: the staged bytes are not on disk',
    });
  }

  let projectStagedBytes: number | null;
  try {
    projectStagedBytes = pipeline.measureProjectUsage(context.root);
  } catch {
    projectStagedBytes = null;
  }

  return {
    projectId: context.record.id,
    conversationId,
    attachments,
    count: attachments.length,
    unreadable: set.unreadable,
    projectStagedBytes,
    projectQuotaBytes: DEFAULT_ATTACHMENT_LIMITS.maxProjectQuotaBytes,
  };
}

/* ========================================================================== */
/*  getAttachmentPreview                                                       */
/* ========================================================================== */

/**
 * Preview kinds this operation can return.
 *
 * Every one of them is a form the pipeline already decided was safe at INDEXING
 * time. Nothing here upgrades a preview: a file whose stored plan says
 * `metadata-only` comes back as metadata, and there is no branch that reads the
 * payload of a QUARANTINED or REJECTED attachment for any reason.
 */
export type AttachmentPreviewKind =
  | 'image'
  | 'sanitised-markdown'
  | 'sanitised-svg'
  | 'escaped-source'
  | 'metadata-only';

export interface AttachmentPreviewResult {
  readonly attachmentId: string;
  readonly state: AttachmentRecord['state'];
  readonly security: AttachmentRecord['security'];
  readonly kind: AttachmentPreviewKind;
  /** Sanitised text, already escaped where the kind says so. Null otherwise. */
  readonly text: string | null;
  /** `data:` URI, and ONLY when the bytes were re-checked as a real image. */
  readonly dataUri: string | null;
  readonly truncated: boolean;
  /** Why this kind and not another. Always populated. */
  readonly reason: string;
  readonly metadata: {
    readonly originalFilename: string;
    readonly declaredMediaType: string;
    readonly detectedMediaType: string | null;
    readonly size: number;
    readonly hash: string | null;
    readonly createdAt: string;
    readonly uploaderSource: string;
    readonly claudeAccessible: boolean;
    readonly securityNotes: readonly string[];
  };
}

function metadataOf(record: AttachmentRecord): AttachmentPreviewResult['metadata'] {
  return {
    originalFilename: record.originalFilename,
    declaredMediaType: record.declaredMediaType,
    detectedMediaType: record.detectedMediaType,
    size: record.size,
    hash: record.hash,
    createdAt: record.createdAt,
    uploaderSource: record.uploaderSource,
    claudeAccessible: record.claudeAccessible,
    securityNotes: record.securityNotes,
  };
}

function getAttachmentPreview(payload: unknown, ctx: OperationContext): AttachmentPreviewResult {
  const body = asObject(payload);
  const projectId = reqString(body, 'projectId');
  const attachmentId = reqString(body, 'attachmentId');
  const maxChars = optInteger(body, 'maxChars', 256, MAX_PREVIEW_TEXT_CHARS) ?? MAX_PREVIEW_TEXT_CHARS;

  const context = resolveProjectContext(ctx.store, projectId);
  const record = loadAttachment(ctx, context.record.id, attachmentId);

  const metadataOnly = (reason: string): AttachmentPreviewResult => ({
    attachmentId,
    state: record.state,
    security: record.security,
    kind: 'metadata-only',
    text: null,
    dataUri: null,
    truncated: false,
    reason,
    metadata: metadataOf(record),
  });

  // Three refusals before anything is opened. A quarantined file's bytes are
  // never written in the first place; this is the second lock, not the first.
  if (record.deleted || record.state === 'REMOVED') {
    return metadataOnly('This attachment was removed. Its bytes were deleted, so there is nothing to show.');
  }
  if (record.state === 'QUARANTINED') {
    return metadataOnly(
      'This attachment is quarantined. Its content was never written to the project and is never rendered — only what is recorded about it is shown.',
    );
  }
  if (record.state === 'REJECTED' || record.state === 'FAILED') {
    return metadataOnly(
      `This attachment is ${record.state}, so no content of it exists to preview. The reasons are in its security notes.`,
    );
  }
  if (record.state !== 'READY') {
    return metadataOnly(`This attachment is still ${record.state}; a preview exists only once staging has finished.`);
  }

  const pipeline = createAttachmentPipeline();
  let stored: StoredPreview | null;
  try {
    stored = pipeline.readPreview(record, context.root);
  } catch {
    stored = null;
  }
  if (stored === null) {
    return metadataOnly(
      record.previewAvailable
        ? `The stored preview (${PREVIEW_FILENAME}) could not be read, so nothing is rendered. Only metadata is shown.`
        : 'No preview was produced for this attachment when it was staged.',
    );
  }

  if (stored.kind === 'metadata-only') return metadataOnly(stored.reason);

  /* ------------------------------------------------------------------ image */

  if (stored.kind === 'image') {
    if (record.size > MAX_IMAGE_PREVIEW_BYTES) {
      return metadataOnly(
        `This image is ${record.size} bytes; previews are capped at ${MAX_IMAGE_PREVIEW_BYTES}. Open the staged file directly instead.`,
      );
    }
    const path = payloadPath(pipeline, context.root, record);
    if (path === null) return metadataOnly('The staged file does not resolve inside this attachment’s own directory.');

    // The cap is re-checked against the file ON DISK, not against the recorded
    // size. A file that grew after staging would otherwise be pulled into
    // memory in full before the hash comparison below ever got to reject it.
    let onDisk: number;
    try {
      onDisk = statSync(path).size;
    } catch {
      return metadataOnly('The staged image is no longer present on disk, so nothing is rendered.');
    }
    if (onDisk > MAX_IMAGE_PREVIEW_BYTES) {
      return metadataOnly(
        `The staged file is now ${onDisk} bytes, past the ${MAX_IMAGE_PREVIEW_BYTES}-byte preview cap, so it is not read.`,
      );
    }

    let bytes: Uint8Array;
    try {
      bytes = readFileSync(path);
    } catch {
      return metadataOnly('The staged image could not be read back from disk, so nothing is rendered.');
    }

    // The bytes are identified AGAIN, here, at preview time. The staging-time
    // verdict is not carried forward on trust: a data URI is a claim that these
    // exact bytes are that exact media type, and it is made from this reading.
    const detection = detectFromBytes(bytes);
    if (!IMAGE_FORMATS.has(detection.format) || detection.mediaType === null) {
      return metadataOnly(
        `The staged file no longer identifies as an image (it reads as ${detection.format}), so it is not rendered. Its bytes are not returned.`,
      );
    }
    if (record.hash !== null) {
      const current = createHash('sha256').update(bytes).digest('hex');
      if (current !== record.hash) {
        return metadataOnly(
          'The staged file no longer hashes to the digest recorded when it was accepted, so it is not rendered. The file changed on disk after staging.',
        );
      }
    }

    return {
      attachmentId,
      state: record.state,
      security: record.security,
      kind: 'image',
      text: null,
      dataUri: `data:${detection.mediaType};base64,${Buffer.from(bytes).toString('base64')}`,
      truncated: false,
      reason: `Rendered as ${detection.format} because the bytes were re-read and re-identified as that format now — not because of the file's name or its media type header.`,
      metadata: metadataOf(record),
    };
  }

  /* ------------------------------------------------------------------- text */

  const source = stored.text ?? '';
  // The stored preview was already sanitised at INDEXING. It is passed through
  // the escape stripper a second time on the way out, because a preview file is
  // an ordinary file on the owner's disk and could have been edited since.
  const cleaned = stored.kind === 'sanitised-svg' ? stripTerminalEscapes(source) : sanitiseForDisplay(source);
  const clipped = cleaned.slice(0, maxChars);
  const truncated = stored.truncated || clipped.length < cleaned.length;

  if (stored.kind === 'sanitised-svg') {
    return {
      attachmentId,
      state: record.state,
      security: record.security,
      kind: 'sanitised-svg',
      text: clipped,
      dataUri: null,
      truncated,
      reason: `${stored.reason} Only an SVG the sanitiser parsed with confidence and found no active content in ever reaches this branch; anything else is quarantined.`,
      metadata: metadataOf(record),
    };
  }

  const kind: AttachmentPreviewKind = stored.kind === 'sanitised-markdown' ? 'sanitised-markdown' : 'escaped-source';
  return {
    attachmentId,
    state: record.state,
    security: record.security,
    kind,
    text: clipped,
    dataUri: null,
    truncated,
    reason: `${stored.reason} The text is HTML-escaped and terminal escape sequences are removed, so it is shown as source and never rendered as markup.`,
    metadata: metadataOf(record),
  };
}

/* ========================================================================== */
/*  Registration                                                               */
/* ========================================================================== */

/** Attach the four attachment operations to a router. Called from `router.ts`. */
export function registerAttachmentOperations(router: Router): void {
  router.register('stageAttachment', (payload, ctx) => stageAttachment(payload, ctx));
  router.register('removeAttachment', (payload, ctx) => removeAttachment(payload, ctx));
  router.register('listAttachments', (payload, ctx) => listAttachments(payload, ctx));
  router.register('getAttachmentPreview', (payload, ctx) => getAttachmentPreview(payload, ctx));
}
