/**
 * message-queue — pure helpers for the composer's "keep typing/sending while a run is active"
 * queue (feat-composer-power, forge-2026-07-29-cc-finish).
 *
 * WHY A QUEUE AT ALL: the gateway allows exactly one active run per conversation
 * (`gateway/src/server.mjs`'s busy check answers a second concurrent send with a real 409) — and
 * this WP is explicit that the fix belongs on the CLIENT, never by weakening that server rule. A
 * message typed while a run is active can therefore not be sent yet; it is held here and actually
 * sent, through the exact same `onSend` path as every other message, the moment the active run
 * finishes.
 *
 * HONESTY RULES:
 *   1. A queued item is NOT a sent turn. It only becomes one once the real `onSend` call this
 *      queue eventually makes is genuinely accepted (a real 202/`ok:true` from the gateway) — see
 *      `Composer.tsx`'s flush effect, which is the only place `onSend` is actually invoked for a
 *      queued item.
 *   2. A failed flush attempt is never silently retried. `selectNextQueuedMessage` only ever
 *      offers an item with `error === null` — once a real attempt fails, the item keeps its real
 *      error message and sits there until the user removes it (or a later item, unaffected,
 *      still flushes normally). Auto-retrying a failed send would risk repeating whatever made it
 *      fail (e.g. a still-active run) in a tight loop.
 *   3. Every item is tagged with the conversation it was queued for. A flush only ever targets the
 *      conversation that is CURRENTLY active — switching conversations never causes a message
 *      typed for conversation A to be silently sent into conversation B.
 */

import type { ChatSendEffort, ChatSendMode, ChatSendModel } from '@/prototype/state/chat-send';

export interface QueuedMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly body: string;
  /** The send-mode/effort/model in effect AT THE MOMENT the message was queued — frozen, never
   *  re-read from the composer's current picker state when the message is actually flushed. */
  readonly mode: ChatSendMode;
  readonly effort: ChatSendEffort | undefined;
  /** feat-model-picker: mirrors `effort`'s own frozen-at-queue-time convention one field over. */
  readonly model: ChatSendModel | undefined;
  /** The real reason the last flush attempt was refused, or null before any attempt. */
  readonly error: string | null;
}

let queueSeq = 0;

/** A fresh, unique id for a newly queued message. Exported so tests can reason about ordering
 *  without depending on this module's private counter shape. */
export function nextQueuedMessageId(): string {
  queueSeq += 1;
  return `queued-${queueSeq}`;
}

export interface EnqueueParams {
  readonly conversationId: string;
  readonly body: string;
  readonly mode: ChatSendMode;
  readonly effort: ChatSendEffort | undefined;
  readonly model: ChatSendModel | undefined;
}

export function enqueueMessage(queue: readonly QueuedMessage[], params: EnqueueParams): readonly QueuedMessage[] {
  return [...queue, { id: nextQueuedMessageId(), error: null, ...params }];
}

export function removeQueuedMessage(queue: readonly QueuedMessage[], id: string): readonly QueuedMessage[] {
  return queue.filter((item) => item.id !== id);
}

/** The oldest item still eligible for an automatic flush: belongs to `conversationId` and has no
 *  recorded error yet. See this file's header, rule 2, for why a failed item is skipped rather
 *  than retried. */
export function selectNextQueuedMessage(queue: readonly QueuedMessage[], conversationId: string): QueuedMessage | null {
  return queue.find((item) => item.conversationId === conversationId && item.error === null) ?? null;
}

export function markQueuedMessageFailed(queue: readonly QueuedMessage[], id: string, error: string): readonly QueuedMessage[] {
  return queue.map((item) => (item.id === id ? { ...item, error } : item));
}
