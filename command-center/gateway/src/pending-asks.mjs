// Forge Command Center gateway — project-scoped pending-ask summary (feat-live-visibility, work
// package feat-live-visibility, Gap A: "a waiting question is invisible outside its own
// conversation").
//
// PURE READ, mirrors chat-runs.mjs's own project-scoping convention (listConversations().filter
// by project first) — but for the actual "is this genuinely pending" fact, this module NEVER
// re-derives it by re-scanning conversation events itself. It joins against ask-store.mjs's own
// `listPendingAskSummaries()` — the live, in-memory registry that IS the authoritative "a real
// `claude` child is blocked on this right now" signal (see that function's own header for why it
// can never report a ghost ask). This is the one honest way to answer "is a session waiting on
// me" from outside that session's own conversation, without inventing a second, looser version of
// the resolving-kind rule `dashboard/.../ask-questions.ts`'s `findPendingAsk` already encodes.
import { listConversations, readConversation } from './conversations.mjs';
import { listPendingAskSummaries } from './ask-store.mjs';

function findFirstUserTurnText(conv) {
  if (!conv.ok) return null;
  const userTurn = conv.turns.find((t) => t.role === 'user' && typeof t.text === 'string' && t.text.length > 0);
  return userTurn ? userTurn.text : null;
}

/**
 * Every ask genuinely pending right now for `projectName`'s conversations — one row per pending
 * ask: `{ id, conversation_id, conversation_first_message, turn_id, question_count }`.
 * `conversation_first_message` is a real excerpt of the user's own first turn (the same raw text
 * `deriveTitleFromText` would shorten), included so a caller can label the jump-to-conversation
 * link without a second round-trip — `null` when the conversation genuinely has no user turn text
 * yet. An unknown/empty project name reads back an honest empty array, never a throw (mirrors
 * `listChatRuns`'s own contract).
 */
export function listPendingAsksForProject(projectName) {
  if (typeof projectName !== 'string' || projectName.length === 0) return [];

  const projectConvIds = new Set(listConversations().filter((c) => c.project === projectName).map((c) => c.id));
  if (projectConvIds.size === 0) return [];

  const out = [];
  for (const ask of listPendingAskSummaries()) {
    if (!projectConvIds.has(ask.convId)) continue;
    const conv = readConversation(ask.convId);
    out.push({
      id: ask.id,
      conversation_id: ask.convId,
      conversation_first_message: findFirstUserTurnText(conv),
      turn_id: ask.turnId,
      question_count: ask.questionCount,
    });
  }
  return out;
}
