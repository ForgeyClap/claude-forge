/**
 * Forge Workspace — the production chat send path.
 *
 * The composer is the centre of the product: it is where a person's text becomes
 * a REAL Claude Code process running inside a real project. In the disconnected
 * prototype the "reply" was a canned string revealed by a timer — correct for the
 * theme showcase and the unit tests, and a lie anywhere near production. This
 * module is the honest counterpart: it drives `sendMessage` / `stopRun` /
 * `createConversation` against the live bridge and reports only what actually
 * happened.
 *
 * THE RULES IT HOLDS, because the whole system stands on them.
 *
 *   1. NO FABRICATED REPLY. `send` starts a run and returns. It NEVER appends an
 *      assistant message of its own — the real `run.output.delta` / `claude.message`
 *      events fold into the live store and render through the adapter. A local echo
 *      here would double or invent the answer, which is exactly what this file
 *      exists not to do.
 *
 *   2. STATUS IS READ, NEVER ASSERTED. The run status the composer shows
 *      (STARTING/RUNNING/STREAMING/COMPLETED/FAILED/CANCELLED …) is derived from
 *      the run record the live store folded from real events — never from an
 *      optimistic guess made the moment a request was issued.
 *
 *   3. A FAILURE STAYS A FAILURE. When the bridge refuses, `send` returns the real
 *      reason and `ok: false`. The composer keeps the draft text: nothing is
 *      cleared and nothing claims to have been sent.
 *
 *   4. NOTHING IS SILENTLY DROPPED. With no conversation yet, `send` creates one
 *      first (`createConversation`) and sends into it. With no project at all it
 *      refuses with an honest reason rather than swallowing the message.
 *
 * This module is only ever mounted on the PRODUCTION path (see
 * `PrototypeProvider`). In fixtures the context is absent, `useChatSend()` returns
 * null, and the view falls back to the untouched local reveal.
 */

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { Dispatch } from 'react';

import type { OperationalStatus } from '@/shared/protocol';
import { BridgeOperationError } from '@/prototype/state/bridge-client';
import { getSharedLiveStore } from '@/prototype/state/live-store';
import type { LiveRun, LiveState } from '@/prototype/state/live-store';
import type { PrototypeAction } from '@/prototype/state/prototype-store';

/* ========================================================================== */
/*  Run status vocabulary                                                      */
/* ========================================================================== */

/**
 * The operational statuses that mean a run is still in flight — the states where
 * Stop is meaningful and a new message must not be started. Mirrors the bridge's
 * `isLiveRunStatus`, declared locally so this browser module pulls in nothing
 * from the Node-only storage layer. Terminal states (COMPLETED, FAILED,
 * CANCELLED, INTERRUPTED, …) are deliberately absent.
 */
const ACTIVE_RUN_STATUSES: ReadonlySet<OperationalStatus> = new Set<OperationalStatus>([
  'CREATED',
  'QUEUED',
  'STARTING',
  'RUNNING',
  'STREAMING',
  'WAITING',
  'WAITING_FOR_PERMISSION',
  'VERIFYING',
  'REVIEWING',
  'REPAIRING',
  'RETRYING',
  'STOPPING',
  'RECOVERING',
]);

/** True when a run in this status is still ongoing. */
export function isActiveRunStatus(status: OperationalStatus): boolean {
  return ACTIVE_RUN_STATUSES.has(status);
}

/* ========================================================================== */
/*  Derivation helpers                                                         */
/* ========================================================================== */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The conversation id out of a `createConversation` result, defensively. The
 * bridge shape is `{ conversation: { id, … }, … }`; a `conversationId` alias is
 * accepted too. Anything else yields null and the caller refuses honestly rather
 * than sending into an id it invented.
 */
export function pickConversationId(result: unknown): string | null {
  const obj = asRecord(result);
  if (obj === null) return null;
  const conversation = asRecord(obj.conversation);
  const id = conversation !== null ? conversation.id : obj.conversationId;
  return typeof id === 'string' && id.trim().length > 0 ? id : null;
}

/**
 * The run most recently referenced by this conversation's events, preferring one
 * that is still active. `LiveRun` carries no conversation id — the link lives on
 * the events — so it is recovered by scanning the (bounded, newest-last) event
 * window backwards. Returns null when the conversation has no run yet.
 */
export function selectLatestRunForConversation(
  live: LiveState,
  conversationId: string,
): LiveRun | null {
  if (conversationId === '') return null;

  const orderedRunIds: string[] = [];
  for (let i = live.events.length - 1; i >= 0; i -= 1) {
    const event = live.events[i];
    if (
      event.conversationId === conversationId &&
      typeof event.runId === 'string' &&
      event.runId.length > 0 &&
      !orderedRunIds.includes(event.runId)
    ) {
      orderedRunIds.push(event.runId);
    }
  }

  const runs: LiveRun[] = [];
  for (const id of orderedRunIds) {
    const run = live.runs.find((r) => r.id === id);
    if (run !== undefined) runs.push(run);
  }

  const active = runs.find(
    (r) => r.operationalStatus !== null && isActiveRunStatus(r.operationalStatus),
  );
  return active ?? runs[0] ?? null;
}

/** The view of the conversation's current run. All three fields are real. */
export interface ChatRunView {
  readonly runId: string | null;
  readonly status: OperationalStatus | null;
  readonly active: boolean;
}

function runViewFor(live: LiveState, conversationId: string): ChatRunView {
  const run = selectLatestRunForConversation(live, conversationId);
  if (run === null) return { runId: null, status: null, active: false };
  const status = run.operationalStatus;
  return {
    runId: run.id,
    status,
    active: status !== null && isActiveRunStatus(status),
  };
}

/**
 * The project a message would run in: the active one when it is real, otherwise
 * the sole/first known project, otherwise null. The production provider keeps the
 * active id valid whenever any project exists, so the fallbacks only matter on
 * the way into a freshly discovered workspace.
 */
function resolveProjectId(live: LiveState, activeProjectId: string): string | null {
  if (activeProjectId !== '' && live.projects.some((p) => p.id === activeProjectId)) {
    return activeProjectId;
  }
  return live.projects[0]?.id ?? null;
}

/** A bridge error message is safe to show and never carries a secret. */
function describeError(err: unknown): string {
  if (err instanceof BridgeOperationError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

/* ========================================================================== */
/*  The controller                                                             */
/* ========================================================================== */

/** The result of a send/stop attempt. `ok:false` always carries a real reason. */
export interface ChatSendOutcome {
  readonly ok: boolean;
  readonly error: string | null;
}

/**
 * composer-modes-ui (widened from fix-ui-clutter's original `'execute' | 'plan'`): the full set
 * Claude Code's own `--permission-mode` picker offers — mirrors `gateway/src/server.mjs`'s
 * `EXEC_MODE_VALUES` allowlist exactly (`'accept-edits'`/`'bypass'` map to the CLI's own
 * `acceptEdits`/`bypassPermissions` choices server-side, `exec-bridge.mjs`). Owned here (the
 * shared contract file) rather than in `gateway-chat.ts`, which already imports types FROM this
 * file — defining it there instead would risk a circular import the moment this file needed it too.
 */
export type ChatSendMode = 'execute' | 'plan' | 'accept-edits' | 'bypass';

/**
 * composer-modes-ui: the real `--effort` choices, mirroring `gateway/src/server.mjs`'s
 * `EXEC_EFFORT_VALUES` allowlist exactly. `undefined` (never a member of this type) means the
 * field is omitted from the request entirely — the CLI's own default, never guessed at here.
 */
export type ChatSendEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * feat-model-picker: the real, full model ids this composer's picker offers — mirrors
 * `gateway/src/server.mjs`'s `EXEC_MODEL_VALUES` allowlist (the picker's own subset of it; the
 * gateway's own allowlist additionally accepts short aliases like 'fable'/'opus'/'sonnet'/'haiku',
 * but the picker always sends a pinned full id so an explicit choice can never silently drift onto
 * a future "latest" model). `undefined` (never a member of this type) means the field is omitted
 * from the request entirely — the CLI's own default, never guessed at here.
 *
 * `'claude-opus-5[1m]'` (2026-07-30 CORRECTION): the "[1m]" context-window suffix was originally
 * left out of this type on the theory that `claude --help` gave no evidence it was valid `--model`
 * INPUT — real, non-mock `claude -p --model 'claude-opus-5[1m]' ...` CLI runs now prove it IS
 * accepted (see `gateway/src/server.mjs`'s own `EXEC_MODEL_VALUES` comment for the exact commands/
 * exit codes this is based on). It replaces the plain `'claude-opus-5'` as the picker's one Opus
 * choice — the precise, real 1M-context variant the composer's "Opus (1M context)" option means,
 * rather than an ambiguous plain id that might resolve to a different context window depending on
 * account defaults.
 */
export type ChatSendModel = 'claude-fable-5' | 'claude-opus-5[1m]' | 'claude-sonnet-5' | 'claude-haiku-4-5-20251001';

export interface ChatSendController {
  /** The conversation's current run, folded from real events. */
  readonly run: ChatRunView;
  /** Whether a message can be started right now. */
  readonly canSend: boolean;
  /** Why sending is disabled, or null when it is not. Honest, user-facing. */
  readonly disabledReason: string | null;
  /** A send request is in flight (the createConversation/sendMessage round trip). */
  readonly sending: boolean;
  /** A stop request is in flight. */
  readonly stopping: boolean;
  /**
   * Start a real Claude Code run for `message` in the active project and
   * conversation, creating the conversation first when there is none. Never
   * appends a local message. Returns whether the bridge accepted it.
   *
   * `mode` (fix-ui-clutter, item 7; widened composer-modes-ui) is optional and defaults to
   * `'execute'` — a caller that omits it (every pre-existing call site) is unaffected. `effort`
   * (composer-modes-ui) is optional too and, when omitted, is never sent at all — not defaulted
   * to any particular level. `model` (feat-model-picker) follows the exact same optional,
   * never-defaulted pattern one parameter over. Only the real gateway send path
   * (`gateway-chat.ts`) currently reads any of the three; the fixture reveal below ignores all
   * extra arguments entirely, which is a fewer-parameters implementation of this same wider
   * contract.
   */
  send(message: string, mode?: ChatSendMode, effort?: ChatSendEffort, model?: ChatSendModel): Promise<ChatSendOutcome>;
  /** Ask the bridge to cancel the conversation's active run. */
  stop(): Promise<ChatSendOutcome>;
}

/**
 * Build the production chat controller for the active project/conversation.
 * Mounted once, at the production provider, so the hook order is stable.
 */
export function useChatSendController(params: {
  readonly live: LiveState;
  readonly activeProjectId: string;
  readonly activeConversationId: string;
  readonly dispatch: Dispatch<PrototypeAction>;
}): ChatSendController {
  const { live, activeProjectId, activeConversationId, dispatch } = params;
  const store = getSharedLiveStore();

  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  // Guards a re-entrant send (a fast second Enter) without waiting on a state
  // flush, so a doubled request can never reach the bridge from this tab.
  const sendingRef = useRef(false);

  const run = useMemo(() => runViewFor(live, activeConversationId), [live, activeConversationId]);
  const projectId = useMemo(() => resolveProjectId(live, activeProjectId), [live, activeProjectId]);

  const knownConversation = useMemo(
    () => activeConversationId !== '' && live.conversations.some((c) => c.id === activeConversationId),
    [live.conversations, activeConversationId],
  );

  const send = useCallback(
    async (message: string): Promise<ChatSendOutcome> => {
      const text = message.trim();
      if (text.length === 0) return { ok: false, error: null };
      if (sendingRef.current) {
        return { ok: false, error: 'A message is already being sent; wait for it to start.' };
      }
      if (projectId === null) {
        return { ok: false, error: 'Select or create a project before sending a message.' };
      }
      if (run.active) {
        return {
          ok: false,
          error: 'A run is already in progress in this conversation. Stop it or let it finish first.',
        };
      }

      sendingRef.current = true;
      setSending(true);
      try {
        let conversationId = activeConversationId;
        if (!knownConversation) {
          // No conversation yet — create one, then send into it. The message is
          // never dropped on the way.
          const created = await store.call('createConversation', { projectId });
          const newId = pickConversationId(created);
          if (newId === null) {
            return { ok: false, error: 'The bridge did not return a conversation to send into.' };
          }
          conversationId = newId;
          dispatch({ type: 'conversation/activate', id: conversationId });
        }

        await store.call('sendMessage', { projectId, conversationId, message: text });
        // Deliberately nothing else: the assistant reply arrives as real streamed
        // events and renders through the adapter. No local message is appended.
        return { ok: true, error: null };
      } catch (err) {
        return { ok: false, error: describeError(err) };
      } finally {
        sendingRef.current = false;
        setSending(false);
      }
    },
    [store, projectId, run.active, activeConversationId, knownConversation, dispatch],
  );

  const stop = useCallback(async (): Promise<ChatSendOutcome> => {
    if (run.runId === null || !run.active) {
      // Nothing to cancel. Reported as a no-op success rather than an error.
      return { ok: true, error: null };
    }
    setStopping(true);
    try {
      await store.call('stopRun', { runId: run.runId });
      // The real CANCELLED outcome is written by the bridge once the exit is
      // OBSERVED and arrives as a run.cancelled/run.state event, which the live
      // store folds — so the status the UI shows is the real one, not this call's.
      return { ok: true, error: null };
    } catch (err) {
      return { ok: false, error: describeError(err) };
    } finally {
      setStopping(false);
    }
  }, [store, run.runId, run.active]);

  return useMemo<ChatSendController>(
    () => ({
      run,
      canSend: projectId !== null && !run.active,
      disabledReason:
        projectId === null ? 'Select or create a project to start a conversation.' : null,
      sending,
      stopping,
      send,
      stop,
    }),
    [run, projectId, sending, stopping, send, stop],
  );
}

/* ========================================================================== */
/*  Context                                                                    */
/* ========================================================================== */

/**
 * Null everywhere the production provider does not mount it — in fixtures, in the
 * theme showcase and in the unit tests — which is the signal the chat view uses
 * to fall back to the untouched local reveal.
 */
export const ChatSendContext = createContext<ChatSendController | null>(null);

/** The production chat controller, or null on the fixture path. */
export function useChatSend(): ChatSendController | null {
  return useContext(ChatSendContext);
}
