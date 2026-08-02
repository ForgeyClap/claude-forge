/**
 * live-activity — the still-running-turn synthetic message (feat-live-stream).
 *
 * refactor-chat-split (forge-2026-07-30-cc-finish): split out of `gateway-chat.ts` — see that
 * file's own header for the full history. Depends on `turn-parsers.ts` (the base module) for
 * `ConversationDetail` and `toGatewayMessage`; `conversations.ts` and `send-controller.ts` both
 * depend on THIS file's `parseConversationDetail` (the one place a turn/event pair becomes a real
 * `ConversationDetail`, live activity folded in). Pure structural move: no behavior changed.
 */

import type { ChatMessage } from '@/prototype/types/prototype-types';

import { pickArray, pickBool, pickRecord, pickString } from '@/prototype/state/gateway-client';

import type { ConversationDetail } from './turn-parsers';
import { toGatewayMessage } from './turn-parsers';

/**
 * feat-live-stream (item 1): the id of the LAST user turn that has no real follow-up yet — no
 * assistant reply with the same `turn_id`, and no `stopped_by_user`/`spawn_error` event either.
 * Mirrors `pendingTurnResolved` (`send-controller.ts`) exactly (same three real-evidence checks,
 * inverted: "find the one turn that ISN'T resolved" instead of "is THIS specific turn resolved")
 * so both places agree on what "still running" means from the very same real turn/event records.
 * `null` when there is no user turn at all, or the last one already has a real follow-up.
 */
function findPendingTurnId(turns: readonly Record<string, unknown>[], events: readonly Record<string, unknown>[]): string | null {
  const userTurnIds = turns
    .filter((t) => pickString(t, ['role']) === 'user')
    .map((t) => pickString(t, ['turn_id']))
    .filter((turnId): turnId is string => turnId !== null);
  if (userTurnIds.length === 0) return null;
  const lastUserTurnId = userTurnIds[userTurnIds.length - 1];

  const hasAssistantReply = turns.some(
    (t) => pickString(t, ['role']) === 'assistant' && pickString(t, ['turn_id']) === lastUserTurnId,
  );
  if (hasAssistantReply) return null;

  const hasTerminalEvent = events.some((e) => {
    const kind = pickString(e, ['kind']);
    return (kind === 'stopped_by_user' || kind === 'spawn_error') && pickString(e, ['turn_id']) === lastUserTurnId;
  });
  if (hasTerminalEvent) return null;

  return lastUserTurnId;
}

/**
 * feat-live-stream (item 1): folds the real live `event` records `exec-bridge.mjs` now appends
 * DURING a run (kinds `file_edit`/`todo_snapshot`/`shell_command`/`shell_result` — see that
 * file's own `rl.on('line', ...)` handler) into the exact same shapes the FINAL closed turn's own
 * `file_edits`/`todos`/`shell_commands` fields carry, so the one synthetic live message below can
 * be built with `toGatewayMessage` — the same production mapping every other message already goes
 * through, not a second hand-rolled rendering path. Only events tagged with `turnId` are folded in
 * (a conversation's `events` array can carry a PRIOR turn's events too).
 */
function buildLiveActivityFields(
  events: readonly Record<string, unknown>[],
  turnId: string,
): { fileEdits: readonly Record<string, unknown>[]; todos: readonly Record<string, unknown>[] | null; shellCommands: readonly Record<string, unknown>[] } {
  const fileEdits: Record<string, unknown>[] = [];
  let todos: readonly Record<string, unknown>[] | null = null;
  const shellById = new Map<string, Record<string, unknown>>();
  const shellOrder: string[] = [];

  for (const event of events) {
    if (pickString(event, ['turn_id']) !== turnId) continue;
    const kind = pickString(event, ['kind']);
    const data = pickRecord(event, ['data']);
    if (data === null) continue;

    if (kind === 'file_edit') {
      fileEdits.push(data);
    } else if (kind === 'todo_snapshot') {
      todos = pickArray(data, ['todos']);
    } else if (kind === 'shell_command') {
      const shellId = pickString(data, ['id']);
      const key = shellId ?? `idx-${shellOrder.length}`;
      shellOrder.push(key);
      shellById.set(key, data);
    } else if (kind === 'shell_result') {
      const shellId = pickString(data, ['id']);
      const existing = shellId !== null ? shellById.get(shellId) : undefined;
      if (shellId === null || existing === undefined) continue;
      shellById.set(shellId, { ...existing, result: pickString(data, ['result']), is_error: pickBool(data, ['is_error']) });
    }
  }

  const shellCommands = shellOrder.map((key) => shellById.get(key)).filter((v): v is Record<string, unknown> => v !== undefined);
  return { fileEdits, todos, shellCommands };
}

/**
 * feat-live-stream (item 1, the honesty core of this WP): while a turn is genuinely still
 * running, a real ONE synthetic assistant message is appended after every real turn — built with
 * the SAME `toGatewayMessage` mapping from real, already-recorded live events, never fabricated.
 * `text` stays empty (this WP only surfaces tool activity, never a guessed/partial reply body);
 * the message is suppressed entirely when there is genuinely nothing yet to show, so an active
 * run with no tool activity at all renders no extra bubble (honest silence, not an empty shell).
 */
function buildLiveActivityMessage(turns: readonly Record<string, unknown>[], events: readonly Record<string, unknown>[]): ChatMessage | null {
  const pendingTurnId = findPendingTurnId(turns, events);
  if (pendingTurnId === null) return null;
  const activity = buildLiveActivityFields(events, pendingTurnId);
  const hasActivity = activity.fileEdits.length > 0 || activity.todos !== null || activity.shellCommands.length > 0;
  if (!hasActivity) return null;

  const message = toGatewayMessage(
    {
      type: 'turn',
      role: 'assistant',
      // Distinct from the real (still-pending) user turn's own id — never collides with it in a
      // keyed list, and never mistaken for the eventual real assistant turn once it closes.
      turn_id: `${pendingTurnId}-live`,
      created_at: new Date().toISOString(),
      text: '',
      file_edits: activity.fileEdits,
      todos: activity.todos,
      shell_commands: activity.shellCommands,
    },
    turns.length,
  ) as unknown as Record<string, unknown> & { isLiveActivity?: boolean };
  message.isLiveActivity = true;
  return message as unknown as ChatMessage;
}

/** refactor-chat-split: new export — not part of the original public export list — new, purely
 *  mechanical glue so `conversations.ts` and `send-controller.ts` can both call this from a
 *  different file. */
export function parseConversationDetail(id: string, data: Record<string, unknown>): ConversationDetail {
  const turns = pickArray(data, ['turns']);
  const events = pickArray(data, ['events']);
  const liveMessage = buildLiveActivityMessage(turns, events);
  const messages = liveMessage !== null ? [...turns.map(toGatewayMessage), liveMessage] : turns.map(toGatewayMessage);
  return {
    id,
    messages,
    turns,
    events,
  };
}
