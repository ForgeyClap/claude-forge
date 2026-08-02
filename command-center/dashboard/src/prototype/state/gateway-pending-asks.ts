/**
 * gateway-pending-asks — the real, project-wide "is a session waiting on you" signal
 * (feat-live-visibility, Gap A: "a waiting question is invisible outside its own conversation").
 *
 * Reads `GET /api/pending-asks?project=` (gateway/src/pending-asks.mjs), which joins the ACTIVE
 * project's own conversations against `ask-store.mjs`'s live in-memory pending-ask registry — the
 * one place a real, currently-blocked `claude` child is tracked. See that gateway module's own
 * header for why this is never re-derived from a looser client-side scan.
 *
 * SCOPE: the ACTIVE project's conversations only — mirrors `gateway-capabilities.ts`'s
 * `useGatewayTools`/`useGatewayMcp` (`projectName === ''` means "nothing selected yet", never a
 * cross-project fetch). A genuinely global (all-projects) indicator would need a fetch per known
 * project on every poll tick; the active project is the one the owner is actually looking at, and
 * every other real project-scoped poll in this codebase (`useGatewayChatRuns`,
 * `useGatewayProjectAgents`, …) already draws this same boundary.
 *
 * HONESTY: `url === null` (no active project) never fetches and the hook stays a stable empty
 * array — never a guess. A failed poll keeps the LAST known-good rows rather than wiping them to a
 * fabricated empty state (mirrors `gateway-capabilities.ts`'s `useGatewayPoll` precedent).
 */

import { useEffect, useState } from 'react';

import { gwGet, pickArray, pickNumber, pickString } from '@/prototype/state/gateway-client';

import { PROJECT_DATA_POLL_MS, type Keyed } from './adapter/shared';

export interface PendingAskRow {
  readonly id: string;
  readonly conversationId: string;
  /** A real excerpt of the conversation's own first user turn — `null` when that conversation
   *  genuinely has no user-turn text yet. Never fabricated. */
  readonly conversationFirstMessage: string | null;
  readonly turnId: string | null;
  readonly questionCount: number;
}

function toPendingAskRow(row: Record<string, unknown>): PendingAskRow {
  return {
    id: pickString(row, ['id']) ?? '',
    conversationId: pickString(row, ['conversation_id']) ?? '',
    conversationFirstMessage: pickString(row, ['conversation_first_message']),
    turnId: pickString(row, ['turn_id']),
    questionCount: pickNumber(row, ['question_count']) ?? 0,
  };
}

/** Maps `GET /api/pending-asks`'s real response 1:1 — a missing/absent `pending_asks` field reads
 *  back an honest empty array, never fabricated. */
export function parsePendingAskRows(data: Record<string, unknown>): readonly PendingAskRow[] {
  return pickArray(data, ['pending_asks']).map(toPendingAskRow);
}

const EMPTY_PENDING_ASKS: readonly PendingAskRow[] = [];

/** Polls the active project's real pending-ask list. An empty `projectName` (no project selected)
 *  never fetches and returns the stable empty array. */
export function useGatewayPendingAsks(projectName: string): readonly PendingAskRow[] {
  const [state, setState] = useState<Keyed<readonly PendingAskRow[]>>({ key: '', value: EMPTY_PENDING_ASKS });

  useEffect(() => {
    if (projectName === '') return undefined;
    let cancelled = false;
    async function tick(): Promise<void> {
      const result = await gwGet(`/api/pending-asks?project=${encodeURIComponent(projectName)}`);
      if (cancelled || !result.ok) return;
      setState({ key: projectName, value: parsePendingAskRows(result.data) });
    }
    void tick();
    const id = setInterval(() => void tick(), PROJECT_DATA_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [projectName]);

  return state.key === projectName ? state.value : EMPTY_PENDING_ASKS;
}
