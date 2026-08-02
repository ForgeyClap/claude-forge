/**
 * `gateway-chat.ts` — `useGatewayChatSendController`'s cross-project send guard
 * (P1-7, fix-crossproject, forge-2026-07-29-cc-finish).
 *
 * BUG THIS GUARDS AGAINST: `Sidebar.tsx`'s `openProject` dispatches only
 * `project/activate`, leaving `activeConversationId` pointed at whichever
 * conversation was active before the switch — which may belong to a
 * DIFFERENT project. The gateway derives a spawned `claude` process's working
 * directory from the conversation's own `meta.project` (`server.mjs`), so
 * posting into that stale conversation id would silently run the user's
 * message against the WRONG project's repository. The same mismatch can also
 * happen on cold start, before any project/activate action ever fires — see
 * the `PrototypeProvider.tsx` effect that seeds `activeConversationId` from
 * the newest GATEWAY-WIDE conversation, which does not have to belong to the
 * first real project.
 *
 * THE FIX (`useGatewayChatSendController`): `knownConversation` is now keyed
 * on BOTH conversation id AND project — a conversation whose id is known but
 * whose own `projectId` does not match `activeProjectId` is treated exactly
 * like an unknown conversation, so `send()` creates a brand-new conversation
 * in the ACTIVE project instead of posting into the mismatched one. One
 * guard covers both the mid-session-switch shape and the cold-start shape,
 * because both simply present as "activeConversationId belongs to the wrong
 * project" to this hook.
 *
 * No network, mocked `fetch` only (mirrors `gateway-recovery-hooks.test.ts`'s
 * own precedent for this seam) — every assertion below is about which real
 * HTTP route was (or, critically, was NOT) called.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

import { useGatewayChatSendController } from '@/prototype/state/gateway-chat';
import type { KnownConversationRef } from '@/prototype/state/gateway-chat';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

interface RecordedCall {
  readonly method: string;
  readonly url: string;
  readonly body: Record<string, unknown> | undefined;
}

/**
 * A minimal real-shaped router for the two POST routes `send()` can reach:
 * `POST /api/conversations` (create) and `POST /api/conversations/:id/messages`.
 * Every call is recorded so a test can assert both what WAS called and — the
 * whole point of this file — what was deliberately never called.
 */
function stubFetchRouter(
  overrides: { readonly createId?: string; readonly sendExecutionStarted?: boolean } = {},
): { readonly calls: readonly RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const createId = overrides.createId ?? 'c-new';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      calls.push({ method, url, body });

      if (method === 'POST' && url.endsWith('/api/conversations')) {
        return jsonResponse({ ok: true, conversation: { id: createId, project: body?.project ?? null, title: null } });
      }
      if (method === 'POST' && /\/api\/conversations\/[^/]+\/messages$/.test(url)) {
        return jsonResponse({
          ok: true,
          execution_started: overrides.sendExecutionStarted ?? false,
          turn_id: overrides.sendExecutionStarted ? 't-1' : null,
        });
      }
      // Anything else (e.g. a stray pending-turn detail poll) — honest empty ok.
      return jsonResponse({ ok: true });
    }),
  );
  return { calls };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const PROJECT_A = 'project-a';
const PROJECT_B = 'project-b';

describe('useGatewayChatSendController — never posts into a conversation from a different project', () => {
  it('a conversation known to belong to a DIFFERENT project is treated as unknown: send() creates a NEW conversation in the active project, and NEVER posts to the foreign conversation', async () => {
    const { calls } = stubFetchRouter({ createId: 'c-fresh' });
    const dispatch = vi.fn();
    const knownConversations: readonly KnownConversationRef[] = [{ id: 'c-foreign', projectId: PROJECT_A }];

    const { result } = renderHook(() =>
      useGatewayChatSendController({
        activeProjectId: PROJECT_B,
        activeConversationId: 'c-foreign',
        knownConversations,
        dispatch,
      }),
    );

    await act(async () => {
      const outcome = await result.current.send('hello');
      expect(outcome.ok).toBe(true);
    });

    // The message must NEVER reach the foreign conversation's own endpoint.
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/api/conversations/c-foreign/messages'))).toBe(false);

    // Instead: a brand-new conversation scoped to the ACTIVE project…
    const createCall = calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/conversations'));
    expect(createCall?.body).toEqual({ project: PROJECT_B, title: null });

    // …and the message posted into THAT new conversation.
    const newPost = calls.find((c) => c.method === 'POST' && c.url.includes('/api/conversations/c-fresh/messages'));
    expect(newPost?.body).toEqual({ text: 'hello' });

    expect(dispatch).toHaveBeenCalledWith({ type: 'conversation/activate', id: 'c-fresh' });
  });

  it('cold-start path: the hook mounts already pointed at a conversation from a different project (no prior project-switch action at all) — the very first send is still safe', async () => {
    // Mirrors PrototypeProvider's cold-start effect: `activeConversationId` can
    // start out as the newest GATEWAY-WIDE conversation, which is not filtered
    // by project and so does not have to belong to `activeProjectId` (the
    // first real project). No `project/activate`/`conversation/activate`
    // dispatch or rerender precedes this — the mismatch is present at mount.
    const { calls } = stubFetchRouter({ createId: 'c-cold-start-new' });
    const dispatch = vi.fn();
    const knownConversations: readonly KnownConversationRef[] = [
      { id: 'c-newest-gatewaywide', projectId: 'some-other-project' },
    ];

    const { result } = renderHook(() =>
      useGatewayChatSendController({
        activeProjectId: PROJECT_A,
        activeConversationId: 'c-newest-gatewaywide',
        knownConversations,
        dispatch,
      }),
    );

    await act(async () => {
      const outcome = await result.current.send('cold start message');
      expect(outcome.ok).toBe(true);
    });

    expect(
      calls.some((c) => c.method === 'POST' && c.url.includes('/api/conversations/c-newest-gatewaywide/messages')),
    ).toBe(false);

    const createCall = calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/conversations'));
    expect(createCall?.body).toEqual({ project: PROJECT_A, title: null });
    expect(dispatch).toHaveBeenCalledWith({ type: 'conversation/activate', id: 'c-cold-start-new' });
  });

  it('a project switch mid-session (activeProjectId changes, activeConversationId stays put — the exact Sidebar.openProject shape) is caught on the very next send', async () => {
    const { calls } = stubFetchRouter({ createId: 'c-after-switch' });
    const dispatch = vi.fn();
    const knownConversations: readonly KnownConversationRef[] = [{ id: 'c-a1', projectId: PROJECT_A }];

    const { result, rerender } = renderHook(
      ({ activeProjectId }: { activeProjectId: string }) =>
        useGatewayChatSendController({
          activeProjectId,
          activeConversationId: 'c-a1',
          knownConversations,
          dispatch,
        }),
      { initialProps: { activeProjectId: PROJECT_A } },
    );

    // `Sidebar.tsx`'s `openProject` dispatches only `project/activate` — this
    // rerender reproduces the exact resulting prop shape: `activeProjectId`
    // moved on, `activeConversationId` deliberately did not.
    rerender({ activeProjectId: PROJECT_B });

    await act(async () => {
      const outcome = await result.current.send('after switching projects');
      expect(outcome.ok).toBe(true);
    });

    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/api/conversations/c-a1/messages'))).toBe(false);
    const createCall = calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/conversations'));
    expect(createCall?.body).toEqual({ project: PROJECT_B, title: null });
  });
});

describe('useGatewayChatSendController — the safe/known path is unaffected by the fix', () => {
  it('a conversation known to belong to the ACTIVE project posts straight into it — no new conversation is created, no dispatch fires', async () => {
    const { calls } = stubFetchRouter();
    const dispatch = vi.fn();
    const knownConversations: readonly KnownConversationRef[] = [{ id: 'c-a1', projectId: PROJECT_A }];

    const { result } = renderHook(() =>
      useGatewayChatSendController({
        activeProjectId: PROJECT_A,
        activeConversationId: 'c-a1',
        knownConversations,
        dispatch,
      }),
    );

    await act(async () => {
      const outcome = await result.current.send('hello');
      expect(outcome.ok).toBe(true);
    });

    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/conversations'))).toBe(false);
    const directPost = calls.find((c) => c.method === 'POST' && c.url.includes('/api/conversations/c-a1/messages'));
    expect(directPost?.body).toEqual({ text: 'hello' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('no active conversation at all still creates a fresh conversation in the active project (unaffected baseline, pre-existing "unknown conversation" behaviour)', async () => {
    const { calls } = stubFetchRouter({ createId: 'c-brand-new' });
    const dispatch = vi.fn();

    const { result } = renderHook(() =>
      useGatewayChatSendController({
        activeProjectId: PROJECT_A,
        activeConversationId: '',
        knownConversations: [],
        dispatch,
      }),
    );

    await act(async () => {
      await result.current.send('first message');
    });

    const createCall = calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/conversations'));
    expect(createCall?.body).toEqual({ project: PROJECT_A, title: null });
    expect(dispatch).toHaveBeenCalledWith({ type: 'conversation/activate', id: 'c-brand-new' });
  });
});
