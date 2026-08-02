/**
 * turn-parsers — gateway-chat's raw conversation/turn shapes and their real-field parsers.
 *
 * refactor-chat-split (forge-2026-07-30-cc-finish): split out of `gateway-chat.ts`, which had grown
 * to 847 lines, well past this project's own 500-line-per-file guidance — see `gateway-chat.ts`'s
 * own header for the full history and honesty rules this split carries forward unchanged. This is
 * the BASE module in the new dependency graph (no sibling imports of its own): the raw
 * `ConversationRow`/`ConversationDetail` shapes, the `execution`/mode/effort/usage/file_edits/
 * shell_commands/todos field parsers, and `toGatewayMessage` itself — the one production mapping
 * every other sibling and the façade both build on. Pure structural move: no behavior changed, no
 * field name changed.
 */

import type { ChatSendEffort, ChatSendMode } from '@/prototype/state/chat-send';
import type { ChatMessage, MessageAuthor, MessageStep, StatusKey } from '@/prototype/types/prototype-types';

import { pickArray, pickBool, pickNumber, pickRecord, pickString } from '@/prototype/state/gateway-client';

/** refactor-chat-split: shared with `conversations.ts`'s own detail poll AND
 *  `send-controller.ts`'s own pending-turn-resolution poll — kept here (the base module both
 *  already depend on) rather than duplicated in either. */
export const CONVERSATION_DETAIL_POLL_MS = 3000;

/* ========================================================================== */
/*  Raw shapes                                                                 */
/* ========================================================================== */

/** refactor-chat-split: new export — not part of the original public export list — new, purely
 *  mechanical glue so `conversations.ts` can build `ConversationRow[]` state. */
export interface ConversationRow {
  readonly id: string;
  readonly title: string | null;
  readonly project: string | null;
  readonly updatedAt: string;
  readonly turnCount: number;
}

/** refactor-chat-split: new export — not part of the original public export list — new, purely
 *  mechanical glue so `live-activity.ts`/`conversations.ts`/`send-controller.ts` can share this
 *  shape across the new file boundary. */
export interface ConversationDetail {
  readonly id: string;
  readonly messages: readonly ChatMessage[];
  /** Raw turn/event records, kept only to detect whether a send is still pending. */
  readonly turns: readonly Record<string, unknown>[];
  readonly events: readonly Record<string, unknown>[];
}

/** The real signal the gateway reports at send time — never a guess. */
export interface ExecutionAvailability {
  readonly available: boolean | null;
  readonly note: string | null;
}

/** Reads the `execution` field `GET /api/conversations` already carries. */
export function parseExecutionAvailability(data: Record<string, unknown>): ExecutionAvailability {
  const execution = pickRecord(data, ['execution']);
  return {
    available: execution !== null ? pickBool(execution, ['available']) : null,
    note: execution !== null ? pickString(execution, ['note']) : null,
  };
}

/** refactor-chat-split: new export — not part of the original public export list — new, purely
 *  mechanical glue so `conversations.ts` can call this from a different file. */
export function parseConversationRows(data: Record<string, unknown>): readonly ConversationRow[] {
  return pickArray(data, ['conversations']).map((row) => ({
    id: pickString(row, ['id']) ?? '',
    title: pickString(row, ['title']),
    project: pickString(row, ['project']),
    updatedAt: pickString(row, ['updated_at']) ?? '',
    turnCount: pickNumber(row, ['turn_count']) ?? 0,
  }));
}

/**
 * The real per-turn measurements `gateway/src/exec-bridge.mjs` writes on
 * every completed assistant turn (`cost_usd`/`duration_ms`, and — since
 * fix-usage-capture — `input_tokens`/`output_tokens`/
 * `cache_creation_input_tokens`/`cache_read_input_tokens`/`model`, read off
 * the claude CLI's own real stream-json `result.usage`/`result.modelUsage`)
 * and `gateway/src/conversations.mjs` serves back unredacted — see
 * `gateway-usage.ts`'s `sumConversationUsage`, the one real consumer, for why
 * these ride along on `ChatMessage` as extra runtime fields rather than a
 * `ChatMessage` type change (kept out of this WP's write scope). `null` when
 * the gateway itself recorded no value for this turn (a user turn never has
 * one; a spawn-error/still-in-flight/mock-mode assistant turn may not either)
 * — never coerced to `0`/`''`.
 *
 * `usageModel` (NOT `model`): `ChatMessage` already declares its own optional
 * `model?: string` — "Example model label shown under a Forge response",
 * read directly by `views/chat/Message.tsx` (out of this WP's scope, and
 * recently landed — untouched on purpose). Reusing that name here would
 * collide it with this file's real, nullable value (a real TS compile error:
 * the intersection type used below cannot reconcile `string | undefined` with
 * `string | null`), AND would silently change `Message.tsx`'s rendered output
 * for every real gateway conversation without touching that file — exactly
 * the kind of out-of-scope side effect this run's LEAN_DISPATCH scoping
 * forbids. `usageModel` stays a distinct extra runtime field, read only by
 * `gateway-usage.ts`'s `sumConversationUsage`.
 *
 * feat-model-picker: `usageModel` is read ONLY off an `assistant` turn (see `toGatewayMessage`
 * below) — now that a `user` turn can ALSO carry its own, differently-meaning `model` key (the
 * REQUESTED model, `readChatMessageRequestedModel`), reading `turn.model` unconditionally would
 * have silently leaked the requested value into `usageModel` for a user-authored message. This
 * file's own `sumConversationUsage` caller already filtered to `author === 'forge'` before this
 * change, so this is a defensive correctness fix at the source, not a behavior change for any
 * existing real caller.
 *
 * fix-unavailable (forge-2026-07-30-cc-finish, checkup): `sessionId`/`contextWindow`/`agentType`
 * mirror `usageModel`'s exact role-gated pattern — `gateway/src/exec-lifecycle.mjs` writes all
 * three onto the completed ASSISTANT turn only (session id captured live off nearly every real
 * stream-json line; contextWindow off the same `result.modelUsage` entry `model` already comes
 * from; agentType off the most recent real `Agent` tool_use dispatch this turn made — see that
 * file's own doc comments for the live-verified evidence). `null` on a user turn, a spawn error, a
 * still-in-flight turn, mock mode, or a turn recorded before these fields existed — never a guess.
 */
export interface ChatMessageUsage {
  readonly costUsd: number | null;
  readonly durationMs: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheCreationTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly usageModel: string | null;
  readonly sessionId: string | null;
  readonly contextWindow: number | null;
  readonly agentType: string | null;
}

/** Reads the extra fields `toGatewayMessage` below attaches onto a real,
 *  gateway-sourced `ChatMessage`. A fixture/example message never carries
 *  them, so every field reads back honestly `null` rather than throwing or
 *  guessing. */
export function readChatMessageUsage(message: ChatMessage): ChatMessageUsage {
  const raw = message as unknown as Partial<ChatMessageUsage>;
  return {
    costUsd: typeof raw.costUsd === 'number' && Number.isFinite(raw.costUsd) ? raw.costUsd : null,
    durationMs: typeof raw.durationMs === 'number' && Number.isFinite(raw.durationMs) ? raw.durationMs : null,
    inputTokens: typeof raw.inputTokens === 'number' && Number.isFinite(raw.inputTokens) ? raw.inputTokens : null,
    outputTokens: typeof raw.outputTokens === 'number' && Number.isFinite(raw.outputTokens) ? raw.outputTokens : null,
    cacheCreationTokens: typeof raw.cacheCreationTokens === 'number' && Number.isFinite(raw.cacheCreationTokens) ? raw.cacheCreationTokens : null,
    cacheReadTokens: typeof raw.cacheReadTokens === 'number' && Number.isFinite(raw.cacheReadTokens) ? raw.cacheReadTokens : null,
    usageModel: typeof raw.usageModel === 'string' && raw.usageModel.length > 0 ? raw.usageModel : null,
    sessionId: typeof raw.sessionId === 'string' && raw.sessionId.length > 0 ? raw.sessionId : null,
    contextWindow: typeof raw.contextWindow === 'number' && Number.isFinite(raw.contextWindow) ? raw.contextWindow : null,
    agentType: typeof raw.agentType === 'string' && raw.agentType.length > 0 ? raw.agentType : null,
  };
}

/** Every real `mode` value the gateway may tag a turn with — mirrors `ChatSendMode` exactly. */
const CHAT_SEND_MODES: ReadonlySet<string> = new Set<ChatSendMode>(['execute', 'plan', 'accept-edits', 'bypass']);

/** Every real `effort` value the gateway may tag a turn with — mirrors `ChatSendEffort` exactly. */
const CHAT_SEND_EFFORTS: ReadonlySet<string> = new Set<ChatSendEffort>(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * Reads the extra `mode` field `toGatewayMessage` below attaches onto a real, gateway-sourced
 * `ChatMessage` — mirrors `readChatMessageUsage`'s own extra-runtime-field pattern rather than
 * widening the shared `ChatMessage` type. `null` for a fixture/example message, and for a real
 * turn the gateway did not (yet) tag with a mode — a message renders a mode chip only when this
 * reads back one of the four real values, never guessed. (composer-modes-ui: widened from the
 * original plan-only check to the full `ChatSendMode` set.)
 */
export function readChatMessageMode(message: ChatMessage): ChatSendMode | null {
  const raw = message as unknown as Partial<{ mode: unknown }>;
  return typeof raw.mode === 'string' && CHAT_SEND_MODES.has(raw.mode) ? (raw.mode as ChatSendMode) : null;
}

/**
 * composer-modes-ui: reads the extra `effort` field `toGatewayMessage` below attaches onto a
 * real, gateway-sourced `ChatMessage` — same extra-runtime-field pattern as `readChatMessageMode`
 * / `readChatMessageUsage`. `null` for a fixture/example message, for a turn the gateway recorded
 * no effort for (the field is only ever present when the sender actually chose a non-default
 * level), or for any value outside the current allowlist.
 */
export function readChatMessageEffort(message: ChatMessage): ChatSendEffort | null {
  const raw = message as unknown as Partial<{ effort: unknown }>;
  return typeof raw.effort === 'string' && CHAT_SEND_EFFORTS.has(raw.effort) ? (raw.effort as ChatSendEffort) : null;
}

/**
 * feat-model-picker: reads the extra `requestedModel` field `toGatewayMessage` below attaches onto
 * a real, gateway-sourced `ChatMessage` — the model the USER asked for on THIS turn (written onto
 * the user turn's own record by `conversations.mjs`'s `appendUserTurn`, the exact same turn-meta
 * pattern `mode`/`effort` already use). `null` for a fixture/example message, for an assistant
 * turn (the gateway never writes this field there), or for a user turn where "Default" (omit
 * `--model`) was chosen. Unlike `readChatMessageMode`/`readChatMessageEffort`, this is NOT
 * validated against a fixed enum: the gateway's own allowlist additionally accepts three short
 * aliases ('fable'/'opus'/'sonnet') alongside the four full ids, so any non-empty real string the
 * gateway genuinely stored is shown as-is — never widened into a guess, never narrowed by a
 * client-side allowlist stricter than the server's own.
 *
 * DISTINCT FROM `usageModel` (`ChatMessageUsage`, below): `usageModel` is what the run's own
 * `result.modelUsage` REPORTED actually ran; `requestedModel` is only ever what the user ASKED
 * for. A turn can legitimately carry one without the other (a request for a still-unreleased/
 * unavailable model would be requested but never actually run) — the chip that compares the two
 * (`Message.tsx`) reads both independently and never assumes they match.
 */
export function readChatMessageRequestedModel(message: ChatMessage): string | null {
  const raw = message as unknown as Partial<{ requestedModel: unknown }>;
  return typeof raw.requestedModel === 'string' && raw.requestedModel.length > 0 ? raw.requestedModel : null;
}

/**
 * fix-stream-insights (checkup #6, diff view): the real `file_edits` field `exec-bridge.mjs` now
 * writes onto an assistant turn — one entry per real Edit/Write `tool_use` block the CLI reported
 * for that turn (see `gateway/src/exec-bridge.mjs`'s own `extractFileEditFromToolUseBlock` doc
 * comment for the exact captured shape this mirrors). `Write` never carries `oldString`/
 * `newString` (there is no "before" — it replaces the whole file), only `content`; `Edit` never
 * carries `content`. `MultiEdit` is not produced by the gateway (never observed in this project's
 * own stored conversations) and therefore never appears here either.
 */
export interface ChatFileEdit {
  readonly tool: 'Edit' | 'Write';
  readonly filePath: string;
  readonly oldString: string | null;
  readonly newString: string | null;
  readonly content: string | null;
}

function parseFileEdits(turn: Record<string, unknown>): readonly ChatFileEdit[] {
  const out: ChatFileEdit[] = [];
  for (const edit of pickArray(turn, ['file_edits'])) {
    const tool = pickString(edit, ['tool']);
    const filePath = pickString(edit, ['file_path']);
    if ((tool !== 'Edit' && tool !== 'Write') || filePath === null) continue;
    out.push({
      tool,
      filePath,
      oldString: pickString(edit, ['old_string']),
      newString: pickString(edit, ['new_string']),
      content: pickString(edit, ['content']),
    });
  }
  return out;
}

/** Reads the extra `fileEdits` field `toGatewayMessage` below attaches onto a real,
 *  gateway-sourced `ChatMessage` — same extra-runtime-field pattern as `readChatMessageUsage`. An
 *  empty array for a fixture/example message or a turn that called neither Edit nor Write. */
export function readChatMessageFileEdits(message: ChatMessage): readonly ChatFileEdit[] {
  const raw = message as unknown as Partial<{ fileEdits: readonly ChatFileEdit[] }>;
  return Array.isArray(raw.fileEdits) ? raw.fileEdits : [];
}

/**
 * feat-live-stream (item 3, shell commands): the real `shell_commands` field `exec-bridge.mjs`
 * now writes onto an assistant turn — one entry per real Bash `tool_use` block the CLI reported
 * for that turn, merged with its own real `tool_result` reply when one arrived (see
 * `gateway/src/exec-bridge.mjs`'s own `extractShellCommandFromToolUseBlock`/
 * `extractShellResultFromToolResultBlock` doc comments for the exact captured shape this mirrors).
 * `result`/`isError` are `null` until a matching tool_result arrives — a command that is still
 * running (or whose result the CLI never reported) genuinely has no result yet, never a fabricated
 * empty string. There is no numeric exit code in the real captured shape, only the boolean
 * `is_error` — read here as-is, never invented.
 */
export interface ChatShellCommand {
  readonly id: string | null;
  readonly command: string;
  readonly description: string | null;
  readonly result: string | null;
  readonly isError: boolean | null;
}

function parseShellCommands(turn: Record<string, unknown>): readonly ChatShellCommand[] {
  const out: ChatShellCommand[] = [];
  for (const entry of pickArray(turn, ['shell_commands'])) {
    const command = pickString(entry, ['command']);
    if (command === null) continue;
    out.push({
      id: pickString(entry, ['id']),
      command,
      description: pickString(entry, ['description']),
      result: pickString(entry, ['result']),
      isError: pickBool(entry, ['is_error']),
    });
  }
  return out;
}

/** Reads the extra `shellCommands` field `toGatewayMessage` below attaches onto a real,
 *  gateway-sourced `ChatMessage` — same extra-runtime-field pattern as `readChatMessageFileEdits`.
 *  An empty array for a fixture/example message or a turn that never called Bash. */
export function readChatMessageShellCommands(message: ChatMessage): readonly ChatShellCommand[] {
  const raw = message as unknown as Partial<{ shellCommands: readonly ChatShellCommand[] }>;
  return Array.isArray(raw.shellCommands) ? raw.shellCommands : [];
}

/**
 * feat-live-stream (item 1, live progress): true only for the ONE synthetic, non-persisted
 * message `parseConversationDetail` below appends while a turn is genuinely still running — built
 * from real live `event` records (file_edit/todo_snapshot/shell_command/shell_result), never from
 * a guess. Read by `ChatView`/`Message` to suppress actions that make no sense on a still-running
 * placeholder (Regenerate — there is nothing finished yet to re-send).
 */
export function readChatMessageIsLive(message: ChatMessage): boolean {
  const raw = message as unknown as Partial<{ isLiveActivity: unknown }>;
  return raw.isLiveActivity === true;
}

/**
 * fix-stream-insights (checkup #5, task progress): the real `todos` field `exec-bridge.mjs` now
 * writes onto an assistant turn — the model's own last TodoWrite call for that turn, as
 * `{content, status, activeForm}` (see `gateway/src/exec-bridge.mjs`'s own
 * `extractTodoSnapshotFromToolUseBlock` doc comment for the exact captured shape). Mapped onto
 * `ChatMessage`'s OWN already-existing, already-rendered `steps` field (`Message.tsx` already
 * shows a collapsible "N steps · M completed" progress list for any message carrying it) rather
 * than a new extra runtime field + new UI — this is the SAME feature, real data instead of fixture
 * data, so it reuses the exact existing rendering path with zero new markup.
 *
 * `label`/`detail`: TodoWrite's `activeForm` ("Exploring project context") is the short
 * present-continuous phrase that fits `MessageStep.label`'s existing short-title role in the
 * fixtures (`"Reference sweep"`, `"Rebuild from a clean tree"`); `content` (the fuller imperative
 * instruction, e.g. "Explore project context (files, docs, recent commits)") fits `detail`'s
 * existing longer-sentence role. Neither field is fabricated: an item missing either string reads
 * back the other one, then a plain "Task" placeholder only as the very last resort — never blank.
 */
const TODO_STATUS_TO_STATUS_KEY: Readonly<Record<string, StatusKey>> = {
  pending: 'waiting',
  in_progress: 'running',
  completed: 'completed',
};

/** Any status string the gateway did not send, or one this map does not recognize (TodoWrite's
 *  own status field is free text, not validated against this UI's StatusKey set), falls back to
 *  'waiting' — the same safe default `statusPresentation()` itself already uses for an unknown
 *  StatusKey, never a thrown error or a fabricated 'completed'. */
function mapTodoStatus(status: string | null): StatusKey {
  if (status === null) return 'waiting';
  return TODO_STATUS_TO_STATUS_KEY[status] ?? 'waiting';
}

function parseTurnSteps(turn: Record<string, unknown>, messageId: string): readonly MessageStep[] {
  const out: MessageStep[] = [];
  const todos = pickArray(turn, ['todos']);
  todos.forEach((todo, index) => {
    const content = pickString(todo, ['content']);
    const activeForm = pickString(todo, ['activeForm']);
    out.push({
      id: `${messageId}-todo-${index}`,
      label: activeForm ?? content ?? 'Task',
      status: mapTodoStatus(pickString(todo, ['status'])),
      detail: content ?? activeForm ?? '',
    });
  });
  return out;
}

/** Exported for `gateway-usage.ts`'s own parser test — a real fixture shaped
 *  exactly like a `GET /api/conversations/:id` turn record, straight through
 *  the actual production mapping (never a hand-rolled `ChatMessage` stand-in
 *  that could silently drift from what this file really produces). */
export function toGatewayMessage(turn: Record<string, unknown>, index: number): ChatMessage {
  const role = pickString(turn, ['role']);
  const author: MessageAuthor = role === 'user' ? 'user' : 'forge';
  const id = pickString(turn, ['turn_id']) ?? `turn-${index}`;
  const record: Omit<ChatMessage, 'prototype'> & ChatMessageUsage & {
    readonly mode: string | null;
    readonly effort: string | null;
    readonly requestedModel: string | null;
    readonly fileEdits: readonly ChatFileEdit[];
    readonly shellCommands: readonly ChatShellCommand[];
  } = {
    id,
    author,
    body: pickString(turn, ['text']) ?? '',
    timestamp: pickString(turn, ['created_at']) ?? '',
    // Real, carried straight off the turn record — never dropped, never
    // fabricated when the gateway itself recorded no value (fix-crossproject
    // P1-5, forge-2026-07-29-cc-finish; see this WP's forge-report for the
    // live curl proof both fields are genuinely populated by exec-bridge.mjs).
    costUsd: pickNumber(turn, ['cost_usd']),
    durationMs: pickNumber(turn, ['duration_ms']),
    // fix-usage-capture: the real token/model fields exec-bridge.mjs now reads off the claude
    // CLI's own stream-json `result.usage`/`result.modelUsage` and writes onto the turn record's
    // own `model` key — read here into `usageModel` (NOT the turn/`ChatMessage`'s unrelated
    // `model` field name; see `ChatMessageUsage`'s own doc comment for why). `null` on a user
    // turn, a spawn error, a still-in-flight turn, mock mode, or any pre-existing turn recorded
    // before this field existed. Never a fabricated `0`/`''`.
    inputTokens: pickNumber(turn, ['input_tokens']),
    outputTokens: pickNumber(turn, ['output_tokens']),
    cacheCreationTokens: pickNumber(turn, ['cache_creation_input_tokens']),
    cacheReadTokens: pickNumber(turn, ['cache_read_input_tokens']),
    // feat-model-picker: role-gated (see `ChatMessageUsage`'s own doc comment) — `exec-lifecycle.mjs`
    // writes the ACTUALLY-run model onto the assistant turn's own `model` key only.
    usageModel: role === 'assistant' ? pickString(turn, ['model']) : null,
    // fix-unavailable: role-gated the same way — `exec-lifecycle.mjs` only ever writes
    // session_id/context_window/agent_type onto the completed assistant turn.
    sessionId: role === 'assistant' ? pickString(turn, ['session_id']) : null,
    contextWindow: role === 'assistant' ? pickNumber(turn, ['context_window']) : null,
    agentType: role === 'assistant' ? pickString(turn, ['agent_type']) : null,
    // fix-ui-clutter (item 7): read defensively — `null` until the gateway starts tagging a
    // turn's own record with the mode it ran in, so this compiles and behaves safely before
    // that lands. composer-modes-ui: `effort` mirrors the same defensive read, one field over —
    // `appendUserTurn` (conversations.mjs) writes `effort: effort ?? null` on every turn.
    mode: pickString(turn, ['mode']),
    effort: pickString(turn, ['effort']),
    // feat-model-picker: role-gated the other way from `usageModel` above — `appendUserTurn`
    // writes the REQUESTED model onto the user turn's own `model` key only (`model: model ?? null`),
    // never on the assistant turn (which uses the same JSON key for the opposite meaning).
    requestedModel: role === 'user' ? pickString(turn, ['model']) : null,
    // fix-stream-insights: real per-turn tool activity — an empty array/absent `todos` when the
    // gateway recorded neither (a user turn, a pre-fix turn, mock mode, or a turn that genuinely
    // called neither tool). `steps` is `ChatMessage`'s OWN existing optional field — see
    // `parseTurnSteps`'s own doc comment for why this reuses it rather than adding a new one.
    fileEdits: parseFileEdits(turn),
    // feat-live-stream: real per-turn Bash commands, mirroring fileEdits' own convention exactly.
    shellCommands: parseShellCommands(turn),
    steps: parseTurnSteps(turn, id),
  };
  return record as unknown as ChatMessage;
}
