/**
 * Forge Command Center — gateway adapter, chat-runs slice (WP refactor-adapter-split).
 *
 * Split out of the single `gateway-adapter.ts` (was ~2400 lines) into its already-marked "8c.
 * Chat-runs" section, verbatim — see that file's own header for the full architecture/history/
 * honesty rules this slice still follows. Only the GENUINE chat-runs content lives here: the
 * `parseDoctorHealth`/`createCoalescedRunner`/events-accumulator declarations that were textually
 * sitting under the original "8c" header (but are not chat-run concerns) moved to
 * `graph-and-proof.ts`/`polling-hooks.ts` instead — see those files' own headers for why.
 *
 * feat-chatruns-tabs: real dashboard-CHAT "runs" (`gateway/src/chat-runs.mjs`) — one row per real
 * chat EXECUTION for the active project (matched user+assistant turn, or a still-running one), not
 * per whole conversation. This closes an owner-verified gap: Mission Control / Tasks / Artifacts
 * only ever read a Forge MISSION's own `.claude/forge-runs/` event trail, so a project the owner
 * drives entirely through this dashboard's chat (no `/forge` mission at all) produced real,
 * useful activity — file edits, a real TodoWrite task list, a real model/token/stop_reason — that
 * never showed up in any of those tabs. `status` stays the gateway's OWN real vocabulary
 * (`'running'|'completed'|'failed'|'timed_out'`) here — `chatRunStatusToStatusKey`/
 * `mapChatRunTodoStatus` below do the one-way translation into this UI's closed `StatusKey`, the
 * same "gateway reports its own real vocab, the adapter maps it" split this file already uses
 * everywhere else (`classifyProjectType`, `activityStatus`, ...).
 */

import { useEffect, useState } from 'react';

import type { Artifact, StatusKey, Task } from '@/prototype/types/prototype-types';

import { gwGet, pickArray, pickNumber, pickString } from '@/prototype/state/gateway-client';

import { PROJECT_DATA_POLL_MS, STATUS_WHEN_UNKNOWN, type Keyed } from './shared';
import { columnForStatus, phaseForStatus } from './mappers';

export interface ChatRunTodoRow {
  readonly content: string | null;
  readonly status: string | null;
  readonly activeForm: string | null;
}

/**
 * feat-chatrun-diff: the gateway's own honest vocabulary for "is there a diff for this edit".
 *
 * `'present'`        — real before/after text was recorded and is in this payload.
 * `'none'`           — no before/after text was ever recorded for this edit. Overwhelmingly this
 *                      is an OLDER run, stored before the gateway captured diffs at all. It must
 *                      stay distinct from `'present'`: rendering an empty diff would claim "this
 *                      edit changed nothing", which is a different — and false — statement.
 * `'omitted_budget'` — real text exists, but the response's diff budget was already spent (see
 *                      `gateway/src/chat-runs.mjs`'s `CHAT_RUN_DIFF_BUDGET_CHARS`). The edit is
 *                      real; only its text is absent, and the UI says exactly that.
 */
export type ChatRunDiffState = 'present' | 'none' | 'omitted_budget';

export interface ChatRunFileEditRow {
  readonly tool: string | null;
  readonly filePath: string | null;
  /** An Edit's real "before" text, capped by the gateway. `null` for a Write (it has no before). */
  readonly oldString: string | null;
  /** An Edit's real "after" text, capped by the gateway. `null` for a Write. */
  readonly newString: string | null;
  /** A Write's real content, capped by the gateway. `null` for an Edit. */
  readonly content: string | null;
  readonly diffState: ChatRunDiffState;
  /** The real budget number the gateway reported, only ever set on an `'omitted_budget'` edit. */
  readonly diffBudgetChars: number | null;
}

export interface ChatRunRow {
  readonly runId: string;
  readonly title: string | null;
  /** The gateway's own real vocabulary: `'running'|'completed'|'failed'|'timed_out'`, or `null`. */
  readonly status: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly durationMs: number | null;
  readonly stopReason: string | null;
  readonly model: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly todos: readonly ChatRunTodoRow[];
  readonly fileEdits: readonly ChatRunFileEditRow[];
}

function toChatRunTodoRow(row: Record<string, unknown>): ChatRunTodoRow {
  return {
    content: pickString(row, ['content']),
    status: pickString(row, ['status']),
    activeForm: pickString(row, ['activeForm']),
  };
}

/**
 * Deliberately NOT `pickString`: that helper rejects an empty/whitespace-only string as "absent",
 * which is right for an id or a model name but wrong for captured file text — a Write that really
 * did write an empty file, or an Edit whose "before" really was a blank line, is a REAL recorded
 * value, and reporting it as `null` would turn a recorded fact into an honest-looking absence.
 */
function rawString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' ? value : null;
}

/**
 * feat-chatrun-diff: `diff_state` is read from the gateway, never inferred from the strings — the
 * gateway is the only layer that knows WHY text is missing (never captured vs. dropped for budget).
 * Two honest fallbacks: an unrecognized future state, and an OLDER gateway that does not send the
 * field at all, both read back as `'none'` (the absence of a claim) rather than being upgraded to
 * `'present'` on the strength of a string that may simply not be there.
 */
function toChatRunDiffState(row: Record<string, unknown>): ChatRunDiffState {
  const raw = pickString(row, ['diff_state']);
  if (raw === 'present' || raw === 'none' || raw === 'omitted_budget') return raw;
  return 'none';
}

function toChatRunFileEditRow(row: Record<string, unknown>): ChatRunFileEditRow {
  return {
    tool: pickString(row, ['tool']),
    filePath: pickString(row, ['file_path']),
    oldString: rawString(row, 'old_string'),
    newString: rawString(row, 'new_string'),
    content: rawString(row, 'content'),
    diffState: toChatRunDiffState(row),
    diffBudgetChars: pickNumber(row, ['diff_budget_chars']),
  };
}

function toChatRunRow(row: Record<string, unknown>): ChatRunRow {
  return {
    runId: pickString(row, ['run_id']) ?? '',
    title: pickString(row, ['title']),
    status: pickString(row, ['status']),
    startedAt: pickString(row, ['started_at']),
    endedAt: pickString(row, ['ended_at']),
    durationMs: pickNumber(row, ['duration_ms']),
    stopReason: pickString(row, ['stop_reason']),
    model: pickString(row, ['model']),
    inputTokens: pickNumber(row, ['input_tokens']),
    outputTokens: pickNumber(row, ['output_tokens']),
    todos: pickArray(row, ['todos']).map(toChatRunTodoRow),
    fileEdits: pickArray(row, ['file_edits']).map(toChatRunFileEditRow),
  };
}

export function parseChatRunRows(data: Record<string, unknown>): readonly ChatRunRow[] {
  return pickArray(data, ['chat_runs']).map(toChatRunRow);
}

const EMPTY_CHAT_RUN_ROWS: readonly ChatRunRow[] = [];

/** Same polling cadence/`Keyed` pattern as `useGatewayProjectRuns` — real only for the active
 *  project, an honest empty list for every other/no project. */
export function useGatewayChatRuns(projectName: string): readonly ChatRunRow[] {
  const [state, setState] = useState<Keyed<readonly ChatRunRow[]>>({ key: '', value: EMPTY_CHAT_RUN_ROWS });
  useEffect(() => {
    if (projectName === '') return undefined;
    let cancelled = false;
    async function tick(): Promise<void> {
      const result = await gwGet(`/api/chat-runs?project=${encodeURIComponent(projectName)}`);
      if (cancelled || !result.ok) return;
      setState({ key: projectName, value: parseChatRunRows(result.data) });
    }
    void tick();
    const id = setInterval(() => void tick(), PROJECT_DATA_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [projectName]);
  return state.key === projectName ? state.value : EMPTY_CHAT_RUN_ROWS;
}

/** Mirrors `gateway-chat.ts`'s own local `TODO_STATUS_TO_STATUS_KEY` map — each file keeps its own
 *  tiny copy of this translation rather than sharing one utility module, the existing convention
 *  `gateway-client.ts`'s header already documents for this codebase. */
function mapChatRunTodoStatus(status: string | null): StatusKey {
  if (status === 'in_progress') return 'running';
  if (status === 'completed') return 'completed';
  // fix-status-honesty: a 'pending' todo in a live run IS genuinely queued behind the in-progress
  // step — that is exactly what WAITING means here, so it is mapped explicitly rather than falling
  // into the unknown-bucket (which now honestly renders as the quiet IDLE, not as a fake queue).
  if (status === 'pending') return 'waiting';
  return STATUS_WHEN_UNKNOWN; // any unrecognized string, or null — never fabricated
}

/** A chat-run's OWN overall status has no `StatusKey` slot named "timed out" — `'failed'` is the
 *  most honest existing bucket for it (the run did not complete), and the real distinction survives
 *  in `ChatRunRow.stopReason`/the task/artifact `detail` labels built below, never silently lost.
 *  Exported for `MissionControlView.tsx`'s own direct `useGatewayChatRuns` mount (see this file's
 *  header, "8c" — a chat-run never joins `PrototypeDataset.graph`, so the consuming view maps this
 *  status itself, the same "second hook, mapped where it's consumed" pattern this file already uses
 *  for `useGatewayEventsMeta`/`useGatewayApprovals`). */
export function chatRunStatusToStatusKey(status: string | null): StatusKey {
  if (status === 'running') return 'running';
  if (status === 'completed') return 'completed';
  if (status === 'failed' || status === 'timed_out') return 'failed';
  return STATUS_WHEN_UNKNOWN;
}

/**
 * One real `Task` per TodoWrite item a chat-run's last snapshot recorded — same shape every mission
 * task already uses, so `TasksView.tsx` needs zero edits. Honest chat-origin label: `Task` has no
 * dedicated "source" field and `prototype-types.ts` is out of this WP's write scope, so the real
 * run id + title ride in the existing free-text `detail` field instead (mirrors
 * `fix-artifacts-empty`'s own `producedBy` precedent for the identical reason). `workPackageId`/
 * `agentId` stay '' — a chat execution has neither a real Forge work package nor a named agent.
 */
export function toGatewayChatRunTasks(row: ChatRunRow): readonly Task[] {
  return row.todos.map((todo, index) => {
    const status = mapChatRunTodoStatus(todo.status);
    const record: Omit<Task, 'prototype'> = {
      id: `${row.runId}-todo-${index}`,
      title: todo.activeForm ?? todo.content ?? 'Chat todo',
      agentId: '',
      workPackageId: '',
      phase: phaseForStatus(status),
      column: columnForStatus(status),
      status,
      progress: status === 'completed' ? 100 : 0,
      dependencies: [],
      proofCount: 0,
      createdAt: row.startedAt ?? '',
      updatedAt: row.endedAt ?? row.startedAt ?? '',
      repairAttempts: 0,
      detail: `Chat run ${row.runId}${row.title ? ' — ' + row.title : ''}: ${todo.content ?? todo.activeForm ?? ''}`,
      wpGuessConfidence: null,
    };
    return record as unknown as Task;
  });
}

/**
 * One real `Artifact` per Edit/Write file edit a chat-run recorded — path + tool, honestly labelled.
 * `kind: 'log'` (the same generic bucket `toGatewayArtifact` already falls back to for anything
 * that isn't a screenshot/report/diagram/markdown/receipt/proof) rather than guessing a more
 * specific kind from the file extension. `producedBy` carries the real `chat-<conversationId>-
 * <turnId>` run id — visually distinct from a Forge run id (`forge-...`), so mixing chat artifacts
 * into the aggregate `?run=all` list never reads as Forge-mission evidence. `size` stays '' (no
 * byte count is measured for a chat file edit — an honest absence, never a fabricated 0 B).
 */
/**
 * The artifact KIND of a chat-run file change, from the real file extension.
 *
 * Lead follow-up (2026-07-30): every chat-run file change used to land as `kind: 'log'`, so the
 * Artifacts filter counted a Markdown file the agent had just written under LOG — the filter's own
 * MARKDOWN tab then found nothing, which reads as "there is no markdown here" when there is. The
 * `kind` union is part of the frozen design, so this maps onto the kinds that ALREADY exist rather
 * than inventing a `file` kind; anything without a better match keeps `'log'` (the union's
 * catch-all here), never a guess dressed up as a category.
 */
function chatEditArtifactKind(filePath: string | null): Artifact['kind'] {
  const ext = (filePath ?? '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  if (ext === 'md' || ext === 'mdx' || ext === 'markdown') return 'markdown';
  if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'webp' || ext === 'gif' || ext === 'svg') return 'screenshot';
  return 'log';
}

/**
 * feat-chatrun-diff: what the Inspector needs in order to show a chat-run file change, or to say
 * honestly why it cannot. `text` is non-null ONLY when `state === 'present'`.
 */
export interface ChatRunArtifactDiff {
  readonly state: ChatRunDiffState;
  readonly text: string | null;
  readonly budgetChars: number | null;
}

/**
 * Renders the two real strings the CLI itself reported into the unified-diff-ish text the EXISTING
 * `Diff` component already knows how to colour (`-` removed, `+` added). Mirrors `Message.tsx`'s
 * own `buildEditDiffText` — each consumer keeps its own tiny copy of this translation, the
 * convention `gateway-client.ts`'s header already documents for this codebase — with ONE deliberate
 * difference: a Write is rendered here too, as added lines only. In the chat transcript a Write's
 * body is already visible in context; in the Inspector the artifact IS the file change, so showing
 * nothing for a Write would leave the panel claiming less than the gateway actually recorded.
 *
 * NO line-level diff algorithm is run, here or anywhere else in this product. This is an honest
 * presentation of exactly two recorded strings — what was replaced, and what replaced it — not a
 * computed minimal diff, and never a read from disk.
 */
function buildChatRunDiffText(edit: ChatRunFileEditRow): string | null {
  if (edit.oldString !== null || edit.newString !== null) {
    const removed = edit.oldString === null ? [] : edit.oldString.split('\n').map((line) => `- ${line}`);
    const added = edit.newString === null ? [] : edit.newString.split('\n').map((line) => `+ ${line}`);
    return [...removed, ...added].join('\n');
  }
  if (edit.content !== null) return edit.content.split('\n').map((line) => `+ ${line}`).join('\n');
  return null;
}

/**
 * The extra runtime field `toGatewayChatRunArtifacts` attaches to the `Artifact` records it builds
 * — the same "extra field on a real, gateway-sourced record, read back through a validating
 * reader" pattern `readChatMessageFileEdits`/`readChatMessageUsage` already use, so the frozen
 * `Artifact` type gains no field and every non-chat artifact stays byte-for-byte unchanged.
 * Returns `null` for any artifact that is not a chat-run file change (a Forge-produced artifact,
 * a fixture row) — the panel then renders exactly what it rendered before this feature existed.
 */
export function readChatRunArtifactDiff(artifact: Artifact): ChatRunArtifactDiff | null {
  const raw = artifact as unknown as Partial<{ chatRunDiff: unknown }>;
  const candidate = raw.chatRunDiff;
  if (candidate === null || typeof candidate !== 'object') return null;
  const record = candidate as Partial<ChatRunArtifactDiff>;
  if (record.state !== 'present' && record.state !== 'none' && record.state !== 'omitted_budget') return null;
  return {
    state: record.state,
    text: typeof record.text === 'string' ? record.text : null,
    budgetChars: typeof record.budgetChars === 'number' && Number.isFinite(record.budgetChars) ? record.budgetChars : null,
  };
}

export function toGatewayChatRunArtifacts(row: ChatRunRow): readonly Artifact[] {
  return row.fileEdits.map((edit, index) => {
    const text = edit.diffState === 'present' ? buildChatRunDiffText(edit) : null;
    const record: Omit<Artifact, 'prototype'> & { chatRunDiff: ChatRunArtifactDiff } = {
      id: `${row.runId}-file-${index}`,
      name: edit.filePath ?? 'edited file',
      kind: chatEditArtifactKind(edit.filePath ?? null),
      producedBy: row.runId,
      taskId: null,
      createdAt: row.endedAt ?? row.startedAt ?? '',
      size: '',
      preview: `${edit.tool ?? 'Edit'} · ${edit.filePath ?? 'unknown file'}`,
      // A gateway that says 'present' but carries no text left (a shape this adapter cannot
      // reconstruct) degrades to the honest 'none' rather than to an empty diff on screen.
      chatRunDiff: {
        state: edit.diffState === 'present' && text === null ? 'none' : edit.diffState,
        text,
        budgetChars: edit.diffBudgetChars,
      },
    };
    return record as unknown as Artifact;
  });
}
