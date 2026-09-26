/**
 * send-controller — the third send-path controller (`useGatewayChatSendController`).
 *
 * refactor-chat-split (forge-2026-07-30-cc-finish): split out of `gateway-chat.ts` — see that
 * file's own header for the full history, the cross-project guard (honesty rule 4), and the
 * GATEWAY GAP this reconstructs client-side. Pure structural move: no behavior changed.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch } from 'react';

import type { ChatRunView, ChatSendController, ChatSendEffort, ChatSendMode, ChatSendModel, ChatSendOutcome } from '@/prototype/state/chat-send';
import type { PrototypeAction } from '@/prototype/state/prototype-store';
import type { OperationalStatus } from '@/shared/protocol';

import { EXEC_TOKEN_HEADER, gwGet, gwPost, pickBool, pickRecord, pickString, readExecToken } from '@/prototype/state/gateway-client';

import { parseConversationDetail } from './live-activity';
import type { ConversationDetail } from './turn-parsers';
import { CONVERSATION_DETAIL_POLL_MS } from './turn-parsers';

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A follow-up record proving the pending turn finished, one way or another. */
function pendingTurnResolved(detail: ConversationDetail | null, pendingTurnId: string): boolean {
  if (detail === null) return false;
  const hasAssistantReply = detail.turns.some(
    (t) => pickString(t, ['role']) === 'assistant' && pickString(t, ['turn_id']) === pendingTurnId,
  );
  if (hasAssistantReply) return true;
  return detail.events.some((e) => {
    const kind = pickString(e, ['kind']);
    return (kind === 'stopped_by_user' || kind === 'spawn_error') && pickString(e, ['turn_id']) === pendingTurnId;
  });
}

/** The minimal per-conversation fact this controller needs to guard against a
 *  cross-project send: which project a known conversation id actually belongs
 *  to. `Conversation` already carries both — callers pass the real records
 *  (or an equivalent projection of them), never bare ids. */
export interface KnownConversationRef {
  readonly id: string;
  readonly projectId: string;
}

export interface GatewayChatSendParams {
  readonly activeProjectId: string;
  readonly activeConversationId: string;
  readonly knownConversations: readonly KnownConversationRef[];
  readonly dispatch: Dispatch<PrototypeAction>;
}

/**
 * Builds the production chat controller for the active project/conversation,
 * driving the gateway's REST conversation routes directly. Mirrors
 * `chat-send.ts::useChatSendController`'s public contract exactly, so
 * `ChatView.tsx` is unaware which backend answered.
 *
 * Polls its OWN copy of the active conversation's turns/events (independent of
 * `useGatewayConversations`'s copy) purely to detect whether a pending send has
 * resolved — a second small poll on the same route, traded deliberately for
 * simplicity over cross-hook plumbing on a local, low-traffic gateway.
 */
export function useGatewayChatSendController(params: GatewayChatSendParams): ChatSendController {
  const { activeProjectId, activeConversationId, knownConversations, dispatch } = params;

  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [pendingTurnId, setPendingTurnId] = useState<string | null>(null);
  const pendingConversationRef = useRef<string | null>(null);

  // Known AND belongs to the active project — see this file's header, honesty
  // rule 4. A conversation whose id is known but whose own project tag does
  // not match `activeProjectId` (the sidebar switched projects without
  // clearing the selection, or the cold-start pick landed on a foreign
  // conversation) is treated exactly like an unknown one: `send` below creates
  // a brand-new conversation in the active project rather than posting into
  // the mismatched one.
  const activeConversationRef =
    activeConversationId !== '' ? knownConversations.find((c) => c.id === activeConversationId) : undefined;
  const knownConversation = activeConversationRef !== undefined && activeConversationRef.projectId === activeProjectId;

  // A pending turn belongs to exactly one conversation. Switching conversations
  // (or the tracked one no longer being the active one) drops the stale marker
  // rather than reporting a foreign run as active.
  useEffect(() => {
    if (pendingConversationRef.current !== null && pendingConversationRef.current !== activeConversationId) {
      setPendingTurnId(null);
      pendingConversationRef.current = null;
    }
  }, [activeConversationId]);

  // Clears the pending marker the moment real evidence shows the turn finished
  // (an assistant reply, a stop, or a spawn error) — never on a timer.
  useEffect(() => {
    if (pendingTurnId === null || activeConversationId === '') return undefined;
    const turnId = pendingTurnId; // narrowed const — stays non-null inside the closure below
    const conversationId = activeConversationId;
    let cancelled = false;
    async function check(): Promise<void> {
      const result = await gwGet(`/api/conversations/${encodeURIComponent(conversationId)}`);
      if (cancelled || !result.ok) return;
      const detail = parseConversationDetail(conversationId, result.data);
      if (pendingTurnResolved(detail, turnId)) {
        setPendingTurnId(null);
        pendingConversationRef.current = null;
      }
    }
    void check();
    const id = setInterval(() => void check(), CONVERSATION_DETAIL_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [pendingTurnId, activeConversationId]);

  const active = pendingTurnId !== null;
  const run: ChatRunView = useMemo(
    () => ({
      runId: pendingTurnId,
      status: (active ? 'RUNNING' : null) as OperationalStatus | null,
      active,
    }),
    [pendingTurnId, active],
  );

  const send = useCallback(
    // fix-ui-clutter (item 7): `mode` is optional and defaults to 'execute' (the existing
    // behaviour) — only a non-'execute' selection changes the request body at all, so a caller
    // that never passes it (every pre-existing call site) is byte-identical to before.
    // composer-modes-ui: `effort` is optional too and, when omitted, is never added to the body —
    // the CLI's own default, never guessed at here. feat-model-picker: `model` follows the exact
    // same optional, never-defaulted pattern one parameter over.
    async (message: string, mode?: ChatSendMode, effort?: ChatSendEffort, model?: ChatSendModel): Promise<ChatSendOutcome> => {
      const text = message.trim();
      if (text.length === 0) return { ok: false, error: null };
      if (activeProjectId === '') {
        return { ok: false, error: 'Select or create a project before sending a message.' };
      }
      if (active) {
        return {
          ok: false,
          error: 'A run is already in progress in this conversation. Stop it or let it finish first.',
        };
      }

      setSending(true);
      try {
        // N6 fix (WP-C1, 2026-09-26 laptop re-audit): the gateway now checks the exec token for
        // EVERY non-GET request, including 'plan' mode and the conversation-create call below
        // (both used to be exempt/omitted) — computed once up front and reused for both real
        // writes this branch can make. `null` (no meta tag found — see `readExecToken`'s own doc
        // comment) means the header is simply omitted; the gateway then answers with an honest 403.
        const token = readExecToken();
        const execHeaders: Record<string, string> = token !== null ? { [EXEC_TOKEN_HEADER]: token } : {};

        let conversationId = activeConversationId;
        if (!knownConversation) {
          const created = await gwPost('/api/conversations', { project: activeProjectId, title: null }, execHeaders);
          if (!created.ok) return { ok: false, error: created.error };
          const conversation = pickRecord(created.data, ['conversation']);
          const newId = conversation !== null ? pickString(conversation, ['id']) : null;
          if (newId === null) return { ok: false, error: 'The gateway did not return a conversation to send into.' };
          conversationId = newId;
          dispatch({ type: 'conversation/activate', id: conversationId });
        }

        // Immutable, additive body-building: `mode` only rides along when it is a real,
        // non-default choice; `effort`/`model` only ride along when the sender actually chose
        // one. None of the three is ever defaulted here — an omitted one is genuinely absent from
        // the wire body, not silently filled with 'execute'/a guessed level/a guessed model.
        const modeField = mode !== undefined && mode !== 'execute' ? { mode } : {};
        const effortField = effort !== undefined ? { effort } : {};
        const modelField = model !== undefined ? { model } : {};
        const body: { text: string; mode?: ChatSendMode; effort?: ChatSendEffort; model?: ChatSendModel } = {
          text,
          ...modeField,
          ...effortField,
          ...modelField,
        };
        const sent = await gwPost(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, body, execHeaders);
        if (!sent.ok) return { ok: false, error: sent.error };
        const started = pickBool(sent.data, ['execution_started']) ?? false;
        const turnId = pickString(sent.data, ['turn_id']);
        if (started && turnId !== null) {
          pendingConversationRef.current = conversationId;
          setPendingTurnId(turnId);
        }
        // Deliberately nothing else: the real assistant reply arrives through
        // the poll/SSE refresh in `useGatewayConversations` and renders through
        // the mapping above. No local message is ever appended.
        return { ok: true, error: null };
      } catch (err) {
        return { ok: false, error: describeError(err) };
      } finally {
        setSending(false);
      }
    },
    [activeProjectId, activeConversationId, knownConversation, active, dispatch],
  );

  const stop = useCallback(async (): Promise<ChatSendOutcome> => {
    if (activeConversationId === '' || !active) {
      return { ok: true, error: null };
    }
    setStopping(true);
    try {
      // N6 fix (WP-C1): POST .../stop is a real write too (the gateway now checks the exec token
      // for every non-GET request) — this route never sent it at all before this fix.
      const token = readExecToken();
      const execHeaders: Record<string, string> = token !== null ? { [EXEC_TOKEN_HEADER]: token } : {};
      const result = await gwPost(`/api/conversations/${encodeURIComponent(activeConversationId)}/stop`, {}, execHeaders);
      if (!result.ok) return { ok: false, error: result.error };
      setPendingTurnId(null);
      pendingConversationRef.current = null;
      return { ok: true, error: null };
    } catch (err) {
      return { ok: false, error: describeError(err) };
    } finally {
      setStopping(false);
    }
  }, [activeConversationId, active]);

  return useMemo<ChatSendController>(
    () => ({
      run,
      canSend: activeProjectId !== '' && !active,
      disabledReason: activeProjectId === '' ? 'Select or create a project to start a conversation.' : null,
      sending,
      stopping,
      send,
      stop,
    }),
    [run, activeProjectId, active, sending, stopping, send, stop],
  );
}
