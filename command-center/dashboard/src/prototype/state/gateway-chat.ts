/**
 * Forge Command Center — the gateway conversation layer.
 *
 * WP7b. Two responsibilities:
 *
 *   1. `useGatewayConversations` — the real conversation list (`GET
 *      /api/conversations`, gateway-wide, project-tagged per row) plus the full
 *      turn history for whichever conversation is active (`GET
 *      /api/conversations/:id`, refreshed on a poll and on every real SSE frame
 *      from `GET /api/conversations/:id/stream`). Mapped straight onto the
 *      view-facing `Conversation`/`ChatMessage` shapes `ChatView` already
 *      renders — no markup changes needed anywhere in the chat view tree.
 *
 *   2. `useGatewayChatSendController` — the THIRD send-path the integration plan
 *      names (alongside the fixture reveal and the unused bridge path): Send
 *      drives `POST /api/conversations` (create, if needed) then `POST
 *      /:id/messages`, which is the SAME `exec-bridge.mjs` that already spawns a
 *      real local `claude` CLI. Stop drives `POST /:id/stop`. Implements the
 *      exact `ChatSendController` contract `chat-send.ts` defines (imported as a
 *      TYPE only — that file is untouched, 0 diff) so `ChatView.tsx` needs no
 *      changes: it already reads `useChatSend()`, which resolves whichever
 *      controller `PrototypeProvider` mounted into `ChatSendContext`.
 *
 * HONESTY RULES (mirrors `store-adapter.ts`'s own three rules):
 *   1. Never fabricate a row — a conversation/message here is real, folded from
 *      a real gateway record, or it does not exist.
 *   2. Never fabricate a status — `run.active` is derived from a REAL pending
 *      turn id and REAL follow-up records (an assistant turn, or a
 *      `stopped_by_user`/`spawn_error` event carrying the same turn id), never
 *      guessed from elapsed time.
 *   3. `send()` NEVER appends a local reply. The assistant's real turn arrives
 *      through the poll/SSE refresh above and renders through the mapping below.
 *   4. `send()` NEVER posts into a conversation that does not belong to the
 *      active project (fix-crossproject, forge-2026-07-29-cc-finish). The
 *      gateway derives a spawned `claude` process's working directory from
 *      `conv.meta.project` (`server.mjs`) — posting a message meant for the
 *      project shown on screen into a conversation tagged with a DIFFERENT
 *      project would silently run that message against the wrong repository.
 *      `knownConversation` below is therefore keyed on BOTH id and project:
 *      a conversation whose id is known but whose project does not match
 *      `activeProjectId` is treated exactly like an unknown conversation — a
 *      brand-new conversation is created in the active project instead. This
 *      also makes the cold-start path safe (the initial `activeConversationId`
 *      picked before any project switch can likewise belong to a different
 *      project than `activeProjectId`) with the same one guard.
 *
 * GATEWAY GAP, named honestly: there is no per-conversation "is a run currently
 * executing" READ endpoint (`isConversationBusy` is internal-only gateway
 * state). `run.active` is therefore reconstructed client-side from the turn the
 * gateway told us it started (`POST /:id/messages`'s own `execution_started`
 * flag) until a real follow-up record proves it finished — the same class of
 * "derive from real evidence, not from a lie" thing this codebase already does
 * everywhere else.
 *
 * refactor-chat-split (forge-2026-07-30-cc-finish) UPDATE — this file was 847 lines, well past
 * this project's own 500-line-per-file guidance, mixing the raw turn/conversation shapes and their
 * field parsers, the live-activity synthetic message, the conversation list/detail poll+SSE hook,
 * and the send controller together. Pure structural split, ZERO behavior change: the real code now
 * lives in `state/gateway-chat/{turn-parsers,live-activity,conversations,send-controller}.ts`
 * (see each sibling's own header for exactly which section it carries and why). This file is now a
 * pure re-export façade: every name below is exported under its EXACT original name and signature,
 * so no other file in the codebase needed to change a single import.
 */

export type { ExecutionAvailability } from './gateway-chat/turn-parsers';
export { parseExecutionAvailability } from './gateway-chat/turn-parsers';

export type { ChatMessageUsage } from './gateway-chat/turn-parsers';
export { readChatMessageUsage } from './gateway-chat/turn-parsers';

export { readChatMessageMode, readChatMessageEffort, readChatMessageRequestedModel } from './gateway-chat/turn-parsers';

export type { ChatFileEdit } from './gateway-chat/turn-parsers';
export { readChatMessageFileEdits } from './gateway-chat/turn-parsers';

export type { ChatShellCommand } from './gateway-chat/turn-parsers';
export { readChatMessageShellCommands } from './gateway-chat/turn-parsers';

export { readChatMessageIsLive } from './gateway-chat/turn-parsers';

export { toGatewayMessage } from './gateway-chat/turn-parsers';

export { useGatewayConversations } from './gateway-chat/conversations';

export type { KnownConversationRef, GatewayChatSendParams } from './gateway-chat/send-controller';
export { useGatewayChatSendController } from './gateway-chat/send-controller';
