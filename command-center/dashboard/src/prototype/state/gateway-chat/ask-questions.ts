/**
 * ask-questions — the real "ask the owner" question/answer layer (feat-ask-owner,
 * forge-2026-07-30-cc-finish).
 *
 * The gateway records a real question set as a plain `event` record on the conversation itself
 * (`kind: 'ask_questions'`, `gateway/src/server.mjs`'s `POST /api/ask`) — exactly the same
 * mechanism `live-activity.ts` already reads for `file_edit`/`todo_snapshot`/`shell_command`
 * events, reused here rather than inventing a second channel. This file scans that SAME real
 * `events` array for the LATEST unresolved ask (one with no later `ask_answered`/`ask_timed_out`
 * event carrying its own id) and exposes it as `PendingAsk`.
 *
 * `useGatewayAskQuestions` mirrors `send-controller.ts`'s own precedent exactly: "a second small
 * poll on the same route, traded deliberately for simplicity over cross-hook plumbing on a local,
 * low-traffic gateway" (that file's own words) — no SSE here, a poll is enough and keeps this file
 * fully independent of `conversations.ts`'s own detail state.
 *
 * HONESTY RULE: `submit()` never optimistically clears the pending question locally — the box only
 * ever closes once the NEXT real poll confirms a resolving event (`ask_answered`) is present. This
 * mirrors this codebase's "never optimistic, always re-read" convention (see the agent-model-edit
 * work in this same run's memory) — a submit that silently failed server-side must never look like
 * it succeeded on screen.
 *
 * fix-ghost-asks (forge-2026-07-30-cc-finish, item 3): the gateway can now close out a pending ask
 * it never got an owner answer for — `kind: 'ask_abandoned'`, `data:{id,reason}`
 * (`gateway/src/ask-store.mjs`'s `abandonPendingAsksForConversation`, `gateway/src/ask-boot-scan.mjs`)
 * — because the execution that opened it ended (stopped/closed/timed out) or the gateway restarted
 * with it still dangling on disk. `findPendingAsk` treats `ask_abandoned` as a THIRD resolving kind
 * (alongside `ask_answered`/`ask_timed_out`) so the wizard never opens for an already-abandoned ask
 * at all — but a wizard that is ALREADY open when the abandonment lands must not just silently
 * vanish on the next poll the way a real answer does; `findAbandonReason` + `useGatewayAskQuestions`'s
 * own `abandoned` state below is what lets `AskQuestionsDialog` show one honest line instead.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { gwGet, gwPost, pickArray, pickBool, pickRecord, pickString, pickStringArray, readExecToken, EXEC_TOKEN_HEADER } from '@/prototype/state/gateway-client';

import { CONVERSATION_DETAIL_POLL_MS } from './turn-parsers';

export interface AskQuestion {
  readonly header: string | null;
  readonly question: string;
  readonly options: readonly string[];
  readonly multiSelect: boolean;
  /** feat-ask-recommended: the exact option text the session genuinely recommends, or null. The
   *  gateway only stores it when it matches one of `options`; the wizard renders it as a
   *  "Recommended" mark on that row — advice, never a pre-selection. */
  readonly recommended: string | null;
}

export interface PendingAsk {
  readonly id: string;
  readonly questions: readonly AskQuestion[];
}

/** fix-ghost-asks item 3: the one honest "this question is gone" notice — `reason` is the real,
 *  machine-readable string the gateway recorded (`execution_stopped` / `execution_closed` /
 *  `execution_timed_out` / `gateway_restart`), never fabricated or guessed. */
export interface AbandonedAskNotice {
  readonly id: string;
  readonly reason: string | null;
}

function parseAskQuestions(data: Record<string, unknown> | null): readonly AskQuestion[] {
  if (data === null) return [];
  return pickArray(data, ['questions'])
    .map((q) => ({
      header: pickString(q, ['header']),
      question: pickString(q, ['question']) ?? '',
      options: pickStringArray(q, ['options']),
      multiSelect: pickBool(q, ['multiSelect']) ?? false,
      recommended: pickString(q, ['recommended']),
    }))
    .filter((q) => q.question.length > 0);
}

/**
 * Scans a conversation's real `events` array for the latest `ask_questions` event that has NO
 * later `ask_answered`/`ask_timed_out` event carrying the same `data.id` — that is the one genuine
 * pending question set, or `null` when there is none (never existed, or already resolved).
 */
export function findPendingAsk(events: readonly Record<string, unknown>[]): PendingAsk | null {
  // Plain for-loops (not .forEach/.some closures) deliberately — a `let` reassigned inside a
  // callback loses TypeScript's narrowing precision for reads after the call, which a straight-
  // line loop does not.
  let lastAskId: string | null = null;
  let lastAskIndex = -1;
  let lastAskQuestions: readonly AskQuestion[] = [];

  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (pickString(event, ['kind']) !== 'ask_questions') continue;
    const data = pickRecord(event, ['data']);
    const id = data !== null ? pickString(data, ['id']) : null;
    if (id === null) continue;
    lastAskId = id;
    lastAskIndex = index;
    lastAskQuestions = parseAskQuestions(data);
  }

  if (lastAskId === null || lastAskQuestions.length === 0) return null;

  let resolved = false;
  for (let index = lastAskIndex + 1; index < events.length; index++) {
    const kind = pickString(events[index], ['kind']);
    // fix-ghost-asks item 3: `ask_abandoned` is a THIRD resolving kind, alongside the two above —
    // an already-abandoned ask must never open a wizard on a fresh poll (e.g. a conversation that
    // was already dangling before this tab ever opened it, or the boot scan's own gateway_restart
    // resolution landing between two polls).
    if (kind !== 'ask_answered' && kind !== 'ask_timed_out' && kind !== 'ask_abandoned') continue;
    const data = pickRecord(events[index], ['data']);
    if (data !== null && pickString(data, ['id']) === lastAskId) {
      resolved = true;
      break;
    }
  }
  if (resolved) return null;

  return { id: lastAskId, questions: lastAskQuestions };
}

/** fix-ghost-asks item 3: scans for a REAL `ask_abandoned` event carrying this exact `askId` (as
 *  `data.id`). Returns `undefined` when NO such event exists for this id at all (the caller must
 *  not treat that as "abandoned with no reason") — otherwise the event's own `data.reason` string,
 *  or `null` when the event exists but carries no reason string (never fabricated). Deliberately
 *  independent of `findPendingAsk`'s own "latest ask only" scoping: an already-open wizard needs to
 *  detect the abandonment of the SPECIFIC ask it is showing, not just whatever the latest one is. */
export function findAbandonReason(events: readonly Record<string, unknown>[], askId: string): string | null | undefined {
  for (const event of events) {
    if (pickString(event, ['kind']) !== 'ask_abandoned') continue;
    const data = pickRecord(event, ['data']);
    if (data !== null && pickString(data, ['id']) === askId) {
      return pickString(data, ['reason']);
    }
  }
  return undefined;
}

/** Submits the owner's REAL answers for one ask id — `answers` is position-correlated to
 *  `PendingAsk.questions` (one non-empty string per question). Never throws. */
export async function submitAskAnswers(askId: string, answers: readonly string[]): Promise<{ ok: boolean; error: string | null }> {
  const token = readExecToken();
  const headers: Record<string, string> = token !== null ? { [EXEC_TOKEN_HEADER]: token } : {};
  const result = await gwPost(`/api/ask/${encodeURIComponent(askId)}/answer`, { answers: answers.map((a) => ({ answer: a })) }, headers);
  return { ok: result.ok, error: result.ok ? null : result.error };
}

export interface AskQuestionsController {
  readonly pending: PendingAsk | null;
  readonly submitting: boolean;
  readonly submit: (answers: readonly string[]) => Promise<{ ok: boolean; error: string | null }>;
  /** fix-ghost-asks item 3: non-null for exactly one poll cycle's worth of "the ask that WAS
   *  pending just got abandoned" — see `dismissAbandoned` below for how the caller clears it. */
  readonly abandoned: AbandonedAskNotice | null;
  /** Clears `abandoned` — called once the owner acknowledges the honest notice (AskQuestionsDialog's
   *  own "Close" action). Never re-fetches; this is purely local UI state. */
  readonly dismissAbandoned: () => void;
}

/** The real pending-ask poll for one conversation. `conversationId === ''` means "nothing to
 *  watch" — the caller (ChatView) passes `''` outside production/no active conversation. */
export function useGatewayAskQuestions(conversationId: string): AskQuestionsController {
  const [pending, setPending] = useState<PendingAsk | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [lastConversationId, setLastConversationId] = useState(conversationId);
  const [abandoned, setAbandoned] = useState<AbandonedAskNotice | null>(null);
  // fix-ghost-asks item 3: a ref, not state — this only needs to survive BETWEEN poll ticks inside
  // the same effect closure (to notice the pending -> abandoned transition), it never needs to
  // trigger a re-render on its own (the `abandoned`/`pending` state setters already do that).
  const lastPendingIdRef = useRef<string | null>(null);

  // Clears any stale pending-ask/abandoned-notice from a PREVIOUS conversation the instant the id
  // changes, so a conversation switch never briefly shows the wrong conversation's question (or a
  // stale "session ended" notice) while the first fetch for the new one is still in flight.
  // Adjusted during render (the same pattern AskQuestionsDialog.tsx already uses for its own
  // per-ask reset), not inside a useEffect — this is derived state, not a synchronization with an
  // external system. `lastPendingIdRef` itself is reset separately, inside the polling effect below
  // (a ref must never be written during render — react-hooks' own rule — so its reset lives where
  // the ref is actually used: at the top of the effect instance this same conversationId change
  // re-runs).
  if (conversationId !== lastConversationId) {
    setLastConversationId(conversationId);
    setPending(null);
    setAbandoned(null);
  }

  useEffect(() => {
    // A fresh effect instance per conversationId (this effect's own dependency array) — reset
    // BEFORE anything else so a stale ask id from the PREVIOUS conversation can never leak into
    // this conversation's own abandon-detection below, matching the pending/abandoned state reset
    // right above (which is render-phase state, whereas this is genuinely effect-owned ref state).
    lastPendingIdRef.current = null;
    if (conversationId === '') return undefined;
    let cancelled = false;
    async function check(): Promise<void> {
      const result = await gwGet(`/api/conversations/${encodeURIComponent(conversationId)}`);
      if (cancelled || !result.ok) return;
      const events = pickArray(result.data, ['events']);
      const nextPending = findPendingAsk(events);
      // fix-ghost-asks item 3: the ask that was pending on the LAST tick just stopped being
      // pending on THIS tick — check whether that is because it was genuinely abandoned (as
      // opposed to a real answer, which needs no notice at all — the box just silently closes,
      // exactly as it always has).
      if (nextPending === null && lastPendingIdRef.current !== null) {
        const reason = findAbandonReason(events, lastPendingIdRef.current);
        if (reason !== undefined) setAbandoned({ id: lastPendingIdRef.current, reason });
      }
      lastPendingIdRef.current = nextPending?.id ?? null;
      setPending(nextPending);
    }
    void check();
    const id = setInterval(() => void check(), CONVERSATION_DETAIL_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [conversationId]);

  const dismissAbandoned = useCallback(() => setAbandoned(null), []);

  const submit = useCallback(
    async (answers: readonly string[]): Promise<{ ok: boolean; error: string | null }> => {
      if (pending === null) return { ok: false, error: 'no pending question to answer' };
      setSubmitting(true);
      try {
        return await submitAskAnswers(pending.id, answers);
      } finally {
        setSubmitting(false);
      }
    },
    [pending],
  );

  return { pending, submitting, submit, abandoned, dismissAbandoned };
}
