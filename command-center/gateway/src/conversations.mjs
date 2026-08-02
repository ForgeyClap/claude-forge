// WP4 T4.2-T4.4 conversation store — append-only JSONL, one file per conversation, under
// command-center/.data/conversations/<id>.jsonl (D2: gateway-owned, sole writer, NEVER writes
// into .claude/). One line per record: {type:"meta"|"turn"|"event", ...}. Read paths always
// re-read straight off disk (these files are small; no incremental cache is needed for
// correctness — the SSE tailer below is the one place that DOES need byte-offset tailing, mirrored
// from events.mjs's proven pattern rather than sharing code with it, so this WP never risks
// regressing the already-reviewed forge-runs event tailer).
//
// refactor-gateway-split (forge-2026-07-30-cc-finish) UPDATE — this file was ~546 lines, over the
// project's own 500-line-per-file guidance, mixing storage/paths + id generation, read-side
// redaction pass-through, turn/meta read-write + the listing summary cache, and the live SSE tail
// together. Pure structural split, ZERO behavior change: the real code now lives in
// `conversation-store.mjs`, `conversation-redact.mjs`, `conversation-stream.mjs` and
// `conversation-turns.mjs` (see each sibling file's own header for exactly which section it carries
// and why). This file is now a pure re-export façade: every name below is exported under its EXACT
// original name and signature (including every `_...ForTests` seam the test suite already depends
// on), so no other file in the codebase needed to change a single import.
export {
  _setConversationsDirForTests,
  generateConversationId,
  conversationExists,
} from './conversation-store.mjs';

export {
  attachConversationStream,
  _resetConversationStreamCapForTests,
  _conversationStreamCapConstantsForTests,
} from './conversation-stream.mjs';

export {
  createConversation,
  deriveTitleFromText,
  readConversation,
  _resetConversationsSummaryCacheForTests,
  _conversationsSummaryCacheSizeForTests,
  _CONVERSATIONS_SUMMARY_MAX_CACHE_ENTRIES_FOR_TESTS,
  listConversations,
  appendUserTurn,
  appendAssistantTurn,
  appendConversationEvent,
  deleteConversation,
  _resetConversationsForTests,
} from './conversation-turns.mjs';
