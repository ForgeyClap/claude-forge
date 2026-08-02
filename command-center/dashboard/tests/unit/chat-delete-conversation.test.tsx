/**
 * ChatView "Delete conversation" — feat-delete-conversation.
 *
 * Locks in the real flow for the conversation-header delete affordance: production drives a real
 * `DELETE /api/conversations/:id` (`requestDeleteConversation`, gateway-actions.ts) through the
 * shared `ConfirmDeleteConversationDialog`; fixtures show the same honest placeholder toast every
 * other conversation action in this view already uses (see `ChatView.tsx`'s own "New" button).
 * Mirrors `chat-project-mismatch.test.tsx`'s own render helper and `STUB_CHAT_CONTROLLER`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import type { ReactElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeAction, PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import { ChatSendContext } from '@/prototype/state/chat-send';
import type { ChatSendController } from '@/prototype/state/chat-send';
import type { Conversation, Project } from '@/prototype/types/prototype-types';
import ChatView from '@/views/chat/ChatView';

function buildProject(id: string, name: string): Project {
  return {
    prototype: true,
    id,
    name,
    description: '',
    type: 'unknown',
    status: 'waiting',
    lastActivity: '2026-07-29T00:00:00.000Z',
    path: `C:\\Users\\YOU\\Documents\\${id}`,
    templateVersion: 'v1',
    pinned: false,
    conversationCount: 0,
    missionCount: 0,
    taskCount: 0,
    agentCount: 0,
    skills: [],
    health: { tests: { passed: 0, failed: 0, skipped: 0 }, openTickets: 0, blockers: 0, score: 0 },
  };
}

const PROJECT_ONE = buildProject('proj-one', 'Project One');

const CONVERSATION_ONE: Conversation = {
  prototype: true,
  id: 'c-one',
  projectId: PROJECT_ONE.id,
  title: 'First conversation',
  updatedAt: '2 min ago',
  messageCount: 2,
  messages: [],
};

function buildState(overrides: Partial<PrototypeState> = {}): PrototypeState {
  return {
    data: EMPTY_DATASET,
    appearance: 'dark',
    resolvedTheme: 'dark',
    density: 'comfortable',
    reducedMotion: false,
    sidebarCollapsed: false,
    mobileDrawerOpen: false,
    inspectorOpen: false,
    dockOpen: false,
    dockTab: 'activity',
    paletteOpen: false,
    activeProjectId: PROJECT_ONE.id,
    activeConversationId: CONVERSATION_ONE.id,
    selection: { kind: 'none' },
    pinnedProjectIds: [],
    projectQuery: '',
    agentFilter: 'all',
    agentLayout: 'grouped',
    taskLayout: 'kanban',
    taskColumnOverrides: {},
    extraMessages: {},
    stream: null,
    claudeCodeState: 'not-connected',
    toasts: [],
    ...overrides,
  };
}

/** A no-op stand-in for the real, gateway-backed chat controller. Never calls fetch itself. */
const STUB_CHAT_CONTROLLER: ChatSendController = {
  run: { runId: null, status: null, active: false },
  canSend: true,
  disabledReason: null,
  sending: false,
  stopping: false,
  send: async () => ({ ok: true, error: null }),
  stop: async () => ({ ok: true, error: null }),
};

interface RenderOptions {
  /** Omit to mimic fixtures mode (no production chat controller mounted at all). */
  readonly chat?: ChatSendController;
}

function renderChatView(dispatch: (action: PrototypeAction) => void, state: PrototypeState, options: RenderOptions = {}) {
  const value: StoreValue = { state, dispatch };
  let tree: ReactElement = createElement(PrototypeContext.Provider, { value }, createElement(ChatView));
  if (options.chat) tree = createElement(ChatSendContext.Provider, { value: options.chat }, tree);
  return render(createElement(MemoryRouter, null, tree));
}

describe('ChatView — "Delete conversation"', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('production: opens a real confirm dialog and sends a real DELETE on confirm', async () => {
    const calls: { url: string; method: string | undefined }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method });
        return { ok: true, status: 200, json: async () => ({ ok: true, deleted: true }) };
      }) as unknown as typeof fetch,
    );
    const state = buildState({ data: { ...EMPTY_DATASET, projects: [PROJECT_ONE], conversations: [CONVERSATION_ONE] } });
    const dispatch = vi.fn();
    renderChatView(dispatch, state, { chat: STUB_CHAT_CONTROLLER });

    fireEvent.click(screen.getByRole('button', { name: 'Delete conversation' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete conversation' });
    expect(within(dialog).getByText(new RegExp(CONVERSATION_ONE.title))).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(calls.some((c) => c.method === 'DELETE' && c.url.includes(CONVERSATION_ONE.id))).toBe(true),
    );
  });

  it('production: a successful delete detaches the active conversation (no dead reference — conversation/activate(""))', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, deleted: true }) })) as unknown as typeof fetch,
    );
    const state = buildState({ data: { ...EMPTY_DATASET, projects: [PROJECT_ONE], conversations: [CONVERSATION_ONE] } });
    const dispatch = vi.fn();
    renderChatView(dispatch, state, { chat: STUB_CHAT_CONTROLLER });

    fireEvent.click(screen.getByRole('button', { name: 'Delete conversation' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete conversation' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: 'conversation/activate', id: '' }));
  });

  it('production: a failed delete (real 409 busy conversation) shows an honest toast and never detaches', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 409,
        json: async () => ({ ok: false, error: 'conversation has a pending execution — stop it before deleting' }),
      })) as unknown as typeof fetch,
    );
    const state = buildState({ data: { ...EMPTY_DATASET, projects: [PROJECT_ONE], conversations: [CONVERSATION_ONE] } });
    const dispatch = vi.fn();
    renderChatView(dispatch, state, { chat: STUB_CHAT_CONTROLLER });

    fireEvent.click(screen.getByRole('button', { name: 'Delete conversation' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete conversation' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'toast/push',
          toast: expect.objectContaining({ title: 'Delete failed', detail: expect.stringMatching(/pending execution/) }),
        }),
      ),
    );
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'conversation/activate' }));
  });

  it('fixtures: shows the honest placeholder toast and never drives a real delete (no production chat controller mounted)', () => {
    // UsageBar (always mounted by ChatView, real in every mode — see its own header) polls
    // health/usage regardless of fixtures vs. production, so this stubs a benign response for
    // those rather than asserting zero fetch calls; the real assertion below is narrower and
    // exact: no DELETE, and no call naming this conversation's id at all.
    const calls: { url: string; method: string | undefined }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method });
        return { ok: true, status: 200, json: async () => ({}) };
      }) as unknown as typeof fetch,
    );
    const state = buildState({ data: { ...EMPTY_DATASET, projects: [PROJECT_ONE], conversations: [CONVERSATION_ONE] } });
    const dispatch = vi.fn();
    // No `chat` option — mirrors fixtures mode exactly like chat-project-mismatch.test.tsx.
    renderChatView(dispatch, state);

    fireEvent.click(screen.getByRole('button', { name: 'Delete conversation' }));

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'toast/push',
        toast: expect.objectContaining({ title: 'Delete conversation', detail: expect.stringMatching(/placeholder/i) }),
      }),
    );
    expect(screen.queryByRole('dialog', { name: 'Delete conversation' })).toBeNull();
    expect(calls.some((c) => c.method === 'DELETE' || c.url.includes(CONVERSATION_ONE.id))).toBe(false);
  });
});
