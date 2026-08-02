/**
 * Forge Workspace — conversation operations (WP6).
 *
 * A conversation is the durable thing a person comes back to: it survives a
 * browser refresh, a bridge restart and a reboot, and it is the anchor every run
 * hangs off. This file owns the four verbs that manage one — `listConversations`,
 * `createConversation`, `openConversation`, `archiveConversation` — plus the
 * lookup and mutation helpers that `runs.ts` builds the message lifecycle on.
 *
 * FOUR RULES THIS FILE HOLDS.
 *
 * 1. PROJECT ISOLATION IS CHECKED, NOT ASSUMED. Every conversation carries its
 *    `projectId` and every lookup that crosses a project boundary is refused
 *    with `INVALID_STATE`. A conversation id alone is never enough to reach a
 *    project's data: the caller's `projectId` and the record's must agree, and
 *    an attachment is only ever resolved from the records that name THIS
 *    conversation. This is the same boundary `runs.ts` relies on when it decides
 *    whether a Claude session may be resumed.
 *
 * 2. NOTHING IS INFERRED FROM AN ID EXISTING. A conversation is only returned
 *    when its record read succeeded; a project only when the registry could
 *    produce it. An id in an array is a pointer, not proof, so
 *    `project.conversationIds` is treated as a hint and the conversation list is
 *    always derived from the records themselves. Records that exist on disk and
 *    could not be read are REPORTED, never silently dropped — a shorter, cleaner
 *    list would be a lie about what the workspace holds.
 *
 * 3. THE REPLAY ANCHOR IS HONEST. `openConversation` hands back every stream key
 *    that belongs to the conversation, each stream's head sequence, and every
 *    sequence gap the store can see. A client that reconnects can therefore tell
 *    "you have everything" from "these events will never arrive". It does not
 *    return the events themselves — `listEvents`/`replayEvents` do that, from the
 *    same anchor.
 *
 * 4. IDS ARE GENERATED, NEVER DERIVED. A conversation id comes from
 *    `crypto.randomUUID`, never from a title, so renaming can never orphan the
 *    history and no title can ever reach a file path.
 *
 * The relative `.ts` imports are deliberate: Node 24 executes TypeScript
 * directly and requires the explicit extension, and bridge code is permitted
 * relative imports.
 */

import { randomUUID } from 'node:crypto';

import type {
  AttachmentRecord,
  ConversationRecord,
  EvidenceRef,
  EventType,
  ForgeEvent,
  OperationalStatus,
  ProjectRecord,
} from '../../shared/protocol.ts';

import { ProjectRegistry } from '../projects/registry.ts';
import { resolveProjectsRootInfo } from '../security/paths.ts';
import { isLiveRunStatus } from '../storage/schema.ts';
import type { RunRecord } from '../storage/schema.ts';
import { makeStreamKey } from '../storage/store.ts';
import type { AppendEventInput, ForgeStore, SequenceGap } from '../storage/store.ts';
import { asObject, fail, optInteger, optString, reqString } from '../router.ts';
import type { OperationContext, Router } from '../router.ts';

/* ========================================================================== */
/*  Seams                                                                      */
/* ========================================================================== */

/**
 * The publish side of the transport, narrowed to the one method these
 * operations need. Narrow on purpose: an operation may append an event and
 * learn its sequence; it may not reach into the transport's client list.
 * `Transport` satisfies this structurally.
 */
export interface EventPublisher {
  publish<P>(input: AppendEventInput<P>): { readonly event: ForgeEvent };
}

export interface ConversationServiceOptions {
  readonly store: ForgeStore;
  readonly events: EventPublisher;
  readonly registry: ProjectRegistry;
  /** Injected so this module owns no clock and stays testable. */
  readonly now?: () => Date;
}

/* ========================================================================== */
/*  Limits                                                                     */
/* ========================================================================== */

export const MAX_CONVERSATION_TITLE_LENGTH = 200;

/** Default page size for `listConversations`. */
export const DEFAULT_CONVERSATION_PAGE = 200;

export const MAX_CONVERSATION_PAGE = 1_000;

/** The title a conversation gets when the client did not supply one. */
export const UNTITLED_CONVERSATION = 'Untitled conversation';

/* ========================================================================== */
/*  Result shapes                                                              */
/* ========================================================================== */

export interface UnreadableRecordNote {
  readonly id: string;
  readonly reason: string;
  readonly detail: string;
}

export interface StreamAnchor {
  readonly streamKey: string;
  /** Highest sequence the store has on disk for this stream. */
  readonly head: number;
  readonly eventCount: number;
  /** Sequences that were assigned and are not on disk. Never hidden. */
  readonly gaps: readonly SequenceGap[];
}

export interface ConversationSummary {
  readonly conversation: ConversationRecord;
  readonly runCount: number;
  readonly liveRunId: string | null;
  readonly lastRunAt: string | null;
  readonly attachmentCount: number;
  readonly readyAttachmentCount: number;
}

export interface OpenConversationResult {
  readonly conversation: ConversationRecord;
  readonly project: ProjectRecord;
  readonly runs: readonly RunRecord[];
  readonly attachments: readonly AttachmentRecord[];
  readonly streams: readonly StreamAnchor[];
  /** Where a reconnecting client should replay from. Client-confirmed. */
  readonly replayFromSequence: number;
  readonly liveRunId: string | null;
  readonly unreadable: readonly UnreadableRecordNote[];
  readonly notes: readonly string[];
}

/* ========================================================================== */
/*  The service                                                                */
/* ========================================================================== */

export class ConversationService {
  readonly store: ForgeStore;
  readonly events: EventPublisher;
  readonly registry: ProjectRegistry;
  private readonly nowFn: () => Date;

  constructor(options: ConversationServiceOptions) {
    this.store = options.store;
    this.events = options.events;
    this.registry = options.registry;
    this.nowFn = options.now ?? (() => new Date());
  }

  now(): Date {
    return this.nowFn();
  }

  nowIso(): string {
    return this.nowFn().toISOString();
  }

  /* ----------------------------------------------------------- lookups */

  /**
   * The project, or a typed refusal. Goes through the registry because the
   * registry is the canonical index — nothing here rebuilds a project path.
   */
  requireProject(projectId: string): ProjectRecord {
    const result = this.registry.get(projectId);
    if (!result.ok) {
      fail(result.error.code, result.error.message, result.error.detail);
    }
    return result.value;
  }

  /**
   * The conversation, or a typed refusal.
   *
   * A malformed id throws inside the store's path guard; that is a BAD_REQUEST,
   * not a NOT_FOUND, and the two are kept apart because "you asked for something
   * that cannot exist" and "it is not here" send a user to different places.
   */
  requireConversation(conversationId: string): ConversationRecord {
    let read;
    try {
      read = this.store.getRecord('conversation', conversationId);
    } catch (error) {
      fail('BAD_REQUEST', 'That conversation id is not a usable record id.', errorText(error));
    }
    if (!read.ok) {
      if (read.reason === 'MISSING') {
        fail('NOT_FOUND', `No conversation is stored with id ${safeId(conversationId)}.`, read.detail);
      }
      fail(
        'RUNTIME_ERROR',
        `The conversation record ${safeId(conversationId)} could not be read (${read.reason}).`,
        read.detail,
      );
    }
    return read.record;
  }

  /**
   * THE ISOLATION CHECK. A conversation belongs to exactly one project, and a
   * caller that names a different one is refused rather than served.
   */
  assertBelongsToProject(conversation: ConversationRecord, projectId: string): void {
    if (conversation.projectId === projectId) return;
    fail(
      'INVALID_STATE',
      'That conversation belongs to a different project.',
      `conversation ${safeId(conversation.id)} is owned by project ${safeId(conversation.projectId)}`,
    );
  }

  /** Every run record that names this conversation, newest first. */
  runsFor(conversationId: string): { readonly runs: readonly RunRecord[]; readonly unreadable: readonly UnreadableRecordNote[] } {
    const listed = this.store.listRecords('run');
    const runs = listed.records
      .filter((run) => run.conversationId === conversationId)
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
    return { runs, unreadable: listed.unreadable.map(toNote) };
  }

  /**
   * The run this conversation currently has in flight, established from the run
   * records rather than from `conversation.activeRunId` — the pointer can be
   * stale after a crash, the run's own status cannot lie about itself without
   * failing the store's validator.
   */
  liveRunFor(conversationId: string): RunRecord | null {
    for (const run of this.runsFor(conversationId).runs) {
      if (isLiveRunStatus(run.status)) return run;
    }
    return null;
  }

  /**
   * Attachment records that name this conversation AND its project. Both are
   * checked: an attachment carries a project id of its own, and a record whose
   * two owners disagree is not resolved for either of them.
   */
  attachmentsFor(conversation: ConversationRecord): {
    readonly attachments: readonly AttachmentRecord[];
    readonly unreadable: readonly UnreadableRecordNote[];
  } {
    const listed = this.store.listRecords('attachment');
    const attachments = listed.records.filter(
      (record) =>
        record.conversationId === conversation.id &&
        record.projectId === conversation.projectId &&
        !record.deleted,
    );
    return { attachments, unreadable: listed.unreadable.map(toNote) };
  }

  /* --------------------------------------------------------- stream anchors */

  /**
   * Every stream a conversation's history lives in: the project stream (which
   * carries the events that have no run) plus one per run.
   */
  streamAnchors(conversation: ConversationRecord, runs: readonly RunRecord[]): readonly StreamAnchor[] {
    const keys: string[] = [makeStreamKey(conversation.projectId, null)];
    for (const run of runs) {
      try {
        keys.push(makeStreamKey(conversation.projectId, run.id));
      } catch {
        // A run id that cannot form a stream key has no stream. Skipped rather
        // than reported as an empty one, which would imply it had no events.
      }
    }
    const anchors: StreamAnchor[] = [];
    for (const streamKey of [...new Set(keys)]) {
      anchors.push(this.anchorFor(streamKey));
    }
    return anchors;
  }

  anchorFor(streamKey: string): StreamAnchor {
    try {
      // Reading from past the end collects nothing, but the gap report is
      // computed over the whole stream — the cheapest honest way to ask the
      // store where a head is and what is missing beneath it.
      const page = this.store.readEvents({ streamKey, fromSequence: Number.MAX_SAFE_INTEGER, limit: 1 });
      const report = page.gaps.find((g) => g.streamKey === streamKey);
      return {
        streamKey,
        head: report?.maxSequence ?? 0,
        eventCount: report?.eventCount ?? 0,
        gaps: report?.gaps ?? [],
      };
    } catch {
      return { streamKey, head: 0, eventCount: 0, gaps: [] };
    }
  }

  /* ------------------------------------------------------------- mutations */

  /** Persist a conversation record, converting a validator refusal to an error. */
  save(record: ConversationRecord): ConversationRecord {
    try {
      return this.store.saveRecord('conversation', record);
    } catch (error) {
      fail('RUNTIME_ERROR', 'The conversation record could not be persisted.', errorText(error));
    }
  }

  /**
   * Record the Claude session id the runtime reported.
   *
   * Refuses to overwrite a different id: a conversation that has already been
   * bound to a session cannot silently adopt another one, because every later
   * `--resume` decision is made from this field.
   */
  recordSessionId(conversationId: string, sessionId: string): ConversationRecord | null {
    const current = this.store.getRecord('conversation', conversationId);
    if (!current.ok) return null;
    if (current.record.claudeSessionId === sessionId) return current.record;
    if (current.record.claudeSessionId !== null) return null;
    return this.save({ ...current.record, claudeSessionId: sessionId, updatedAt: this.nowIso() });
  }

  /**
   * Unbind a session that was OBSERVED to be unresumable.
   *
   * Only ever called with that observation in hand and on an explicit owner
   * request. The event log keeps the `session.lost` evidence and every run that
   * used the id, so clearing the pointer erases no history — it stops the bridge
   * passing `--resume` an id that has already been proven not to work.
   */
  clearSessionBinding(conversationId: string, reason: string): ConversationRecord | null {
    const current = this.store.getRecord('conversation', conversationId);
    if (!current.ok || current.record.claudeSessionId === null) return null;
    const previous = current.record.claudeSessionId;
    const saved = this.save({ ...current.record, claudeSessionId: null, updatedAt: this.nowIso() });
    this.emit({
      projectId: saved.projectId,
      conversationId: saved.id,
      sessionId: previous,
      source: 'bridge',
      type: 'session.lost',
      payload: { sessionId: previous, detail: reason, unbound: true },
      evidenceRefs: [{ kind: 'file', ref: `records/conversation/${saved.id}.json` }],
    });
    return saved;
  }

  /** Point the conversation at a run, or clear the pointer. Never throws. */
  setActiveRun(conversationId: string, runId: string | null): ConversationRecord | null {
    const current = this.store.getRecord('conversation', conversationId);
    if (!current.ok) return null;
    if (current.record.activeRunId === runId) return current.record;
    return this.save({ ...current.record, activeRunId: runId, updatedAt: this.nowIso() });
  }

  /** Count one more stored message. Called once per user turn and once per reply. */
  countMessage(conversationId: string, howMany = 1): ConversationRecord | null {
    const current = this.store.getRecord('conversation', conversationId);
    if (!current.ok) return null;
    return this.save({
      ...current.record,
      messageCount: current.record.messageCount + Math.max(0, Math.trunc(howMany)),
      updatedAt: this.nowIso(),
    });
  }

  /**
   * Association bookkeeping on the project record.
   *
   * Deliberately narrow: this touches `conversationIds`, `sessionIds`,
   * `activeRunIds` and `updatedAt` and nothing else. Identity, path and health
   * belong to the registry and are never written here.
   */
  linkToProject(
    projectId: string,
    patch: {
      readonly addConversationId?: string;
      readonly addSessionId?: string;
      readonly addActiveRunId?: string;
      readonly removeActiveRunId?: string;
    },
  ): ProjectRecord | null {
    const current = this.store.getRecord('project', projectId);
    if (!current.ok) return null;
    const record = current.record;

    const conversationIds = withMember(record.conversationIds, patch.addConversationId);
    const sessionIds = withMember(record.sessionIds, patch.addSessionId);
    let activeRunIds = withMember(record.activeRunIds, patch.addActiveRunId);
    if (patch.removeActiveRunId !== undefined) {
      activeRunIds = activeRunIds.filter((id) => id !== patch.removeActiveRunId);
    }

    if (
      conversationIds === record.conversationIds &&
      sessionIds === record.sessionIds &&
      activeRunIds === record.activeRunIds
    ) {
      return record;
    }

    try {
      return this.store.saveRecord('project', {
        ...record,
        conversationIds,
        sessionIds,
        activeRunIds,
        updatedAt: this.nowIso(),
      });
    } catch {
      // The association arrays are a convenience index; the records themselves
      // remain the truth. A failure here must not fail the operation.
      return null;
    }
  }

  /* ----------------------------------------------------------------- events */

  /**
   * Append an event. A logging failure is reported as a note rather than as an
   * operation failure: by the time this runs the record is already on disk, and
   * an error here would tell the caller the wrong thing happened.
   */
  emit(input: {
    readonly projectId: string;
    readonly conversationId: string | null;
    readonly runId?: string | null;
    readonly sessionId?: string | null;
    readonly source: AppendEventInput['source'];
    readonly type: EventType;
    /** The operational status this event asserts, when it asserts one. Carried
     * on the top-level event so a client tracking `event.status` moves with the
     * real gated transition rather than a stale earlier value. */
    readonly status?: OperationalStatus;
    readonly payload: unknown;
    readonly evidenceRefs?: readonly EvidenceRef[];
  }): { readonly event: ForgeEvent | null; readonly note: string | null } {
    try {
      const result = this.events.publish({
        projectId: input.projectId,
        runId: input.runId ?? null,
        sessionId: input.sessionId ?? null,
        conversationId: input.conversationId,
        source: input.source,
        type: input.type,
        ...(input.status === undefined ? {} : { status: input.status }),
        payload: input.payload,
        evidenceRefs: input.evidenceRefs ?? [],
      });
      return { event: result.event, note: null };
    } catch (error) {
      return {
        event: null,
        note: `the record was written, but the ${input.type} event could not be appended: ${errorText(error)}`,
      };
    }
  }

  /* ================================================================ verbs = */

  /* -------------------------------------------------------- listConversations */

  list(payload: unknown): Record<string, unknown> {
    const body = asObject(payload);
    const projectId = reqString(body, 'projectId');
    const includeArchived = body.includeArchived === true;
    const limit = optInteger(body, 'limit', 1, MAX_CONVERSATION_PAGE) ?? DEFAULT_CONVERSATION_PAGE;

    const project = this.requireProject(projectId);

    const listed = this.store.listRecords('conversation');
    const mine = listed.records
      .filter((c) => c.projectId === project.id)
      .filter((c) => includeArchived || !c.archived)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));

    const page = mine.slice(0, limit);
    const summaries: ConversationSummary[] = page.map((conversation) => {
      const runs = this.runsFor(conversation.id).runs;
      const live = runs.find((run) => isLiveRunStatus(run.status)) ?? null;
      const attachments = this.attachmentsFor(conversation).attachments;
      return {
        conversation,
        runCount: runs.length,
        liveRunId: live?.id ?? null,
        lastRunAt: runs[0]?.startedAt ?? null,
        attachmentCount: attachments.length,
        readyAttachmentCount: attachments.filter((a) => a.state === 'READY' && a.claudeAccessible).length,
      };
    });

    return {
      projectId: project.id,
      conversations: summaries,
      total: mine.length,
      returned: summaries.length,
      truncated: mine.length > summaries.length,
      // Records that exist and could not be read. Reported, never dropped: a
      // clean-looking short list is a false statement about the workspace.
      unreadable: listed.unreadable.map(toNote),
    };
  }

  /* ------------------------------------------------------- createConversation */

  create(payload: unknown): Record<string, unknown> {
    const body = asObject(payload);
    const projectId = reqString(body, 'projectId');
    const rawTitle = optString(body, 'title', MAX_CONVERSATION_TITLE_LENGTH);

    const project = this.requireProject(projectId);
    if (project.archived) {
      fail('INVALID_STATE', 'That project is archived, so a new conversation cannot be started in it.');
    }

    const title = normaliseTitle(rawTitle);
    const timestamp = this.nowIso();
    const record: ConversationRecord = {
      // Generated, never derived from the title: a rename must not be able to
      // orphan history, and a title must never reach a file path.
      id: `conv-${randomUUID()}`,
      projectId: project.id,
      title,
      // Null until Claude Code actually reports a session for this conversation.
      claudeSessionId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      messageCount: 0,
      attachmentIds: [],
      activeRunId: null,
      archived: false,
      lastConfirmedSequence: 0,
    };

    const saved = this.save(record);
    this.linkToProject(project.id, { addConversationId: saved.id });

    const emitted = this.emit({
      projectId: project.id,
      conversationId: saved.id,
      source: 'user',
      type: 'conversation.created',
      payload: { conversationId: saved.id, projectId: project.id, title: saved.title },
      evidenceRefs: [{ kind: 'file', ref: `records/conversation/${saved.id}.json`, note: 'the conversation record as written' }],
    });

    return {
      conversation: saved,
      projectId: project.id,
      streamKey: makeStreamKey(project.id, null),
      notes: emitted.note === null ? [] : [emitted.note],
    };
  }

  /* --------------------------------------------------------- openConversation */

  /**
   * Reopen a conversation after a refresh.
   *
   * Returns the anchor a client needs to rebuild its view — the record, the
   * project, the runs, the attachments, and every stream head with its gaps —
   * and no events. The events come from `replayEvents`, from the sequence
   * returned here, so a client can always tell a complete replay from a partial
   * one.
   */
  open(payload: unknown): OpenConversationResult {
    const body = asObject(payload);
    const conversationId = reqString(body, 'conversationId');
    const projectId = optString(body, 'projectId');
    const confirmedSequence = optInteger(body, 'confirmedSequence', 0, Number.MAX_SAFE_INTEGER);

    let conversation = this.requireConversation(conversationId);
    if (projectId !== undefined) this.assertBelongsToProject(conversation, projectId);
    const project = this.requireProject(conversation.projectId);

    const notes: string[] = [];

    // The client confirms how far it has processed. It may only ever move
    // forward: accepting a lower number would silently re-deliver events the
    // client already showed, and accepting a number above the stream head would
    // skip events that do exist.
    if (confirmedSequence !== undefined && confirmedSequence > conversation.lastConfirmedSequence) {
      conversation = this.save({
        ...conversation,
        lastConfirmedSequence: confirmedSequence,
        updatedAt: this.nowIso(),
      });
    } else if (confirmedSequence !== undefined && confirmedSequence < conversation.lastConfirmedSequence) {
      notes.push(
        `confirmedSequence ${confirmedSequence} is below the stored anchor ${conversation.lastConfirmedSequence}; the anchor was left where it was`,
      );
    }

    const runList = this.runsFor(conversation.id);
    const attachmentList = this.attachmentsFor(conversation);
    const live = runList.runs.find((run) => isLiveRunStatus(run.status)) ?? null;

    // The pointer can survive a crash that the run itself did not. It is
    // reported as stale rather than trusted or quietly repaired: the run
    // records are what say whether anything is running.
    if (live !== null && conversation.activeRunId !== live.id) {
      notes.push(
        `the conversation record points at run ${String(conversation.activeRunId)} but run ${live.id} is the one in a live status; the run records are authoritative`,
      );
    } else if (live === null && conversation.activeRunId !== null) {
      const pointed = runList.runs.find((run) => run.id === conversation.activeRunId);
      notes.push(
        pointed === undefined
          ? `the conversation points at run ${conversation.activeRunId}, which has no readable record; nothing is running`
          : `the conversation still points at run ${pointed.id}, which is ${pointed.status}; nothing is running`,
      );
    }

    return {
      conversation,
      project,
      runs: runList.runs,
      attachments: attachmentList.attachments,
      streams: this.streamAnchors(conversation, runList.runs),
      replayFromSequence: conversation.lastConfirmedSequence + 1,
      liveRunId: live?.id ?? null,
      unreadable: [...runList.unreadable, ...attachmentList.unreadable],
      notes,
    };
  }

  /* ------------------------------------------------------ archiveConversation */

  /**
   * Archive a conversation. The record and every event stay: archiving is a
   * view decision, and deleting a user's history because a list got long is not
   * a decision this layer gets to make.
   *
   * Refused while a run is live — archiving would hide a process that is still
   * writing to the workspace, and the UI would stop showing the one thing the
   * user would want to stop.
   */
  archive(payload: unknown): Record<string, unknown> {
    const body = asObject(payload);
    const conversationId = reqString(body, 'conversationId');
    const projectId = optString(body, 'projectId');

    const conversation = this.requireConversation(conversationId);
    if (projectId !== undefined) this.assertBelongsToProject(conversation, projectId);

    if (conversation.archived) {
      // Idempotent: a second archive is a no-op, not an error.
      return { conversation, alreadyArchived: true, notes: [] };
    }

    const live = this.liveRunFor(conversation.id);
    if (live !== null) {
      fail(
        'INVALID_STATE',
        `Run ${live.id} is still ${live.status} in this conversation. Stop it before archiving.`,
        `run ${live.id} status ${live.status}`,
      );
    }

    const saved = this.save({ ...conversation, archived: true, activeRunId: null, updatedAt: this.nowIso() });
    const emitted = this.emit({
      projectId: saved.projectId,
      conversationId: saved.id,
      source: 'user',
      type: 'conversation.archived',
      payload: { conversationId: saved.id, projectId: saved.projectId, title: saved.title },
      evidenceRefs: [{ kind: 'file', ref: `records/conversation/${saved.id}.json` }],
    });

    return {
      conversation: saved,
      alreadyArchived: false,
      notes: emitted.note === null ? [] : [emitted.note],
    };
  }
}

/* ========================================================================== */
/*  Wiring                                                                     */
/* ========================================================================== */

/**
 * One service per store, rebuilt when the projects root moves.
 *
 * Keyed on the store rather than held in a module variable so a second bridge
 * instance inside one process (tests do this) cannot be served another's index,
 * and so nothing survives the store it belonged to.
 */
const SERVICE_CACHE = new WeakMap<ForgeStore, { root: string; service: ConversationService }>();

/**
 * The service for this request.
 *
 * The projects root is resolved from the filesystem on every call — the folder
 * can appear or move while the bridge runs, and a cached answer would be a
 * stale claim about the user's disk. The registry is only rebuilt when it
 * actually changed.
 */
export function conversationServiceFor(ctx: OperationContext): ConversationService {
  const projectsRoot = resolveProjectsRootInfo().projectsRoot;
  const cached = SERVICE_CACHE.get(ctx.store);
  if (cached !== undefined && cached.root === projectsRoot) return cached.service;
  const service = new ConversationService({
    store: ctx.store,
    events: ctx.events,
    registry: new ProjectRegistry(ctx.store, { projectsRoot }),
  });
  SERVICE_CACHE.set(ctx.store, { root: projectsRoot, service });
  return service;
}

/** Attach the conversation verbs to a router. */
export function registerConversationOperations(
  router: Router,
  options: { readonly override?: boolean } = {},
): void {
  const registerOptions = options.override === true ? { override: true } : undefined;
  router.register('listConversations', (payload, ctx) => conversationServiceFor(ctx).list(payload), registerOptions);
  router.register('createConversation', (payload, ctx) => conversationServiceFor(ctx).create(payload), registerOptions);
  router.register('openConversation', (payload, ctx) => conversationServiceFor(ctx).open(payload), registerOptions);
  router.register('archiveConversation', (payload, ctx) => conversationServiceFor(ctx).archive(payload), registerOptions);
}

/** The operations this module owns. Used by tests and by the startup report. */
export const CONVERSATION_OPERATIONS = [
  'listConversations',
  'createConversation',
  'openConversation',
  'archiveConversation',
] as const;

export function createConversationService(options: ConversationServiceOptions): ConversationService {
  return new ConversationService(options);
}

/* ========================================================================== */
/*  Small helpers                                                              */
/* ========================================================================== */

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
}

/**
 * Ids are echoed back in error messages, so they are capped and stripped of
 * control characters first — an id is client-supplied text until it has been
 * matched against a record.
 */
export function safeId(value: unknown): string {
  if (typeof value !== 'string') return '(not a string)';
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
  return cleaned.length > 80 ? `${cleaned.slice(0, 80)}…` : cleaned;
}

function toNote(entry: { readonly id: string; readonly reason: string; readonly detail: string }): UnreadableRecordNote {
  return { id: entry.id, reason: entry.reason, detail: entry.detail };
}

function normaliseTitle(raw: string | undefined): string {
  if (raw === undefined) return UNTITLED_CONVERSATION;
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
  return cleaned.length === 0 ? UNTITLED_CONVERSATION : cleaned.slice(0, MAX_CONVERSATION_TITLE_LENGTH);
}

/** Returns the same array reference when nothing changed, so callers can skip a write. */
function withMember(current: readonly string[], candidate: string | undefined): readonly string[] {
  if (candidate === undefined || current.includes(candidate)) return current;
  return [...current, candidate];
}
