/**
 * conversations — the real conversation list + active conversation detail poll/SSE hook.
 *
 * refactor-chat-split (forge-2026-07-30-cc-finish): split out of `gateway-chat.ts` — see that
 * file's own header for the full history and honesty rules. Pure structural move: no behavior
 * changed, `useGatewayConversations`'s own contract is unchanged.
 */

import { useEffect, useMemo, useState } from 'react';

import type { ChatMessage, Conversation } from '@/prototype/types/prototype-types';

import { gwEventSource, gwGet } from '@/prototype/state/gateway-client';

import { parseConversationDetail } from './live-activity';
import type { ConversationDetail, ConversationRow } from './turn-parsers';
import { CONVERSATION_DETAIL_POLL_MS, parseConversationRows } from './turn-parsers';

const CONVERSATIONS_POLL_MS = 4000;

const EMPTY_ROWS: readonly ConversationRow[] = [];
const EMPTY_MESSAGES: readonly ChatMessage[] = [];

/**
 * fix-ui-clutter (item 3): a conversation with no real title used to fall back to its own raw
 * id (`c-ms6e73oh-…`) — the exact ugly-id surface the owner flagged across the ChatView header,
 * breadcrumb, sidebar recents and Inspector. The gateway now writes a real title server-side
 * from the first user turn (a separate, parallel fix); this is the honest client-side fallback
 * for the window before that happens (a conversation with no turns yet) — a readable "New chat
 * — <project>" label, never the id. `row.project` is this gateway's own project folder name,
 * which IS its human-readable name (`toGatewayProject` sets `id`/`name` to the same string), so
 * no extra project lookup is needed.
 */
function fallbackConversationTitle(project: string | null): string {
  return project !== null && project !== '' ? `New chat — ${project}` : 'New chat';
}

function buildConversations(
  rows: readonly ConversationRow[],
  activeConversationId: string,
  detail: ConversationDetail | null,
): readonly Conversation[] {
  return rows.map((row) => {
    const messages = row.id === activeConversationId && detail !== null ? detail.messages : EMPTY_MESSAGES;
    const record: Omit<Conversation, 'prototype'> = {
      id: row.id,
      projectId: row.project ?? '',
      title: row.title ?? fallbackConversationTitle(row.project),
      updatedAt: row.updatedAt,
      messageCount: row.turnCount,
      messages,
    };
    return record as unknown as Conversation;
  });
}

/**
 * The real conversation list, with the active conversation's full turn history
 * kept fresh by a poll AND a real SSE tail (`GET /:id/stream`) — every incoming
 * frame triggers one authoritative re-fetch of the full conversation rather
 * than hand-reconstructing partial `stream-json` deltas, so the rendered
 * message can never be a guess at what the CLI is mid-way through saying.
 */
interface KeyedDetail {
  readonly key: string;
  readonly value: ConversationDetail | null;
}

export function useGatewayConversations(activeConversationId: string): readonly Conversation[] {
  const [rows, setRows] = useState<readonly ConversationRow[]>(EMPTY_ROWS);
  // Keyed by conversation id, gated at read time — an effect should
  // synchronize with the gateway, not reset React state as a side effect of
  // its own guard clause (`react-hooks/set-state-in-effect`). An empty
  // selection, or a still-in-flight fetch for a newly activated conversation,
  // reads as the honest "no detail yet" fallback below with no extra render.
  const [detailState, setDetailState] = useState<KeyedDetail>({ key: '', value: null });

  useEffect(() => {
    let cancelled = false;
    async function tick(): Promise<void> {
      const result = await gwGet('/api/conversations');
      if (cancelled || !result.ok) return;
      setRows(parseConversationRows(result.data));
    }
    void tick();
    const id = setInterval(() => void tick(), CONVERSATIONS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    if (activeConversationId === '') return undefined;
    let cancelled = false;
    async function refresh(): Promise<void> {
      const result = await gwGet(`/api/conversations/${encodeURIComponent(activeConversationId)}`);
      if (cancelled || !result.ok) return;
      setDetailState({ key: activeConversationId, value: parseConversationDetail(activeConversationId, result.data) });
    }
    void refresh();
    const pollId = setInterval(() => void refresh(), CONVERSATION_DETAIL_POLL_MS);

    let source: EventSource | null = null;
    try {
      source = gwEventSource(`/api/conversations/${encodeURIComponent(activeConversationId)}/stream`);
      source.onmessage = () => void refresh();
    } catch {
      source = null; // SSE is a real-time bonus; the poll above still keeps this correct
    }

    return () => {
      cancelled = true;
      clearInterval(pollId);
      if (source !== null) source.close();
    };
  }, [activeConversationId]);

  const detail = detailState.key === activeConversationId ? detailState.value : null;
  return useMemo(() => buildConversations(rows, activeConversationId, detail), [rows, activeConversationId, detail]);
}
