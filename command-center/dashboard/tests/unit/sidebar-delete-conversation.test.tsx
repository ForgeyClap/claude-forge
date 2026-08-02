/**
 * Sidebar "Delete conversation" — feat-delete-conversation.
 *
 * Locks in the real flow: each "Recent conversations" row gets a real delete affordance
 * (`ConfirmDeleteConversationDialog`) that drives a real `DELETE /api/conversations/:id`
 * (`requestDeleteConversation`, gateway-actions.ts) — mirrors `sidebar-new-project.test.tsx`'s own
 * fetch-stub precedent for "New project". Stubs `globalThis.fetch` directly, no real network.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeAction, PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import type { Conversation } from '@/prototype/types/prototype-types';
import Sidebar from '@/components/shell/Sidebar';

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
    activeProjectId: '',
    activeConversationId: '',
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

const CONVERSATION_ONE: Conversation = {
  prototype: true,
  id: 'c-one',
  projectId: 'proj-one',
  title: 'First conversation',
  updatedAt: '2 min ago',
  messageCount: 3,
  messages: [],
};

function renderSidebar(dispatch: (action: PrototypeAction) => void, state: PrototypeState) {
  const value: StoreValue = { state, dispatch };
  return render(
    createElement(
      MemoryRouter,
      null,
      createElement(PrototypeContext.Provider, { value }, createElement(Sidebar)),
    ),
  );
}

/** Every call not asserted on directly gets a benign empty-ok response, mirroring
 *  `sidebar-new-project.test.tsx`'s own catch-all precedent for the connection/health poll. */
function stubBenignFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })) as unknown as typeof fetch);
}

describe('Sidebar — "Delete conversation"', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders a real delete affordance for each recent conversation row', () => {
    stubBenignFetch();
    const state = buildState({ data: { ...EMPTY_DATASET, conversations: [CONVERSATION_ONE] } });
    renderSidebar(vi.fn(), state);

    expect(screen.getByRole('button', { name: `Delete ${CONVERSATION_ONE.title}` })).toBeInTheDocument();
  });

  it('opens a real confirm dialog before deleting anything (no browser confirm())', async () => {
    stubBenignFetch();
    const state = buildState({ data: { ...EMPTY_DATASET, conversations: [CONVERSATION_ONE] } });
    renderSidebar(vi.fn(), state);

    fireEvent.click(screen.getByRole('button', { name: `Delete ${CONVERSATION_ONE.title}` }));

    const dialog = await screen.findByRole('dialog', { name: 'Delete conversation' });
    expect(within(dialog).getByText(new RegExp(CONVERSATION_ONE.title))).toBeInTheDocument();
  });

  it('confirming sends a real DELETE and hides the row from the list on success (optimistic update)', async () => {
    const calls: { url: string; method: string | undefined }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method });
        return { ok: true, status: 200, json: async () => ({ ok: true, deleted: true }) };
      }) as unknown as typeof fetch,
    );
    const state = buildState({ data: { ...EMPTY_DATASET, conversations: [CONVERSATION_ONE] } });
    renderSidebar(vi.fn(), state);

    fireEvent.click(screen.getByRole('button', { name: `Delete ${CONVERSATION_ONE.title}` }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete conversation' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(calls.some((c) => c.method === 'DELETE' && c.url.includes(CONVERSATION_ONE.id))).toBe(true),
    );
    await waitFor(() => expect(screen.queryByText(CONVERSATION_ONE.title)).toBeNull());
  });

  it('shows the gateway\'s real error text and keeps the row when the delete fails (e.g. a real 409 busy conversation)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 409,
        json: async () => ({ ok: false, error: 'conversation has a pending execution — stop it before deleting' }),
      })) as unknown as typeof fetch,
    );
    const dispatch = vi.fn();
    const state = buildState({ data: { ...EMPTY_DATASET, conversations: [CONVERSATION_ONE] } });
    renderSidebar(dispatch, state);

    fireEvent.click(screen.getByRole('button', { name: `Delete ${CONVERSATION_ONE.title}` }));
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
    // The row must still be present — a rejected delete never hides it.
    expect(screen.getByText(CONVERSATION_ONE.title)).toBeInTheDocument();
  });

  it('dispatches conversation/activate("") to detach when the deleted conversation was the active one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, deleted: true }) })) as unknown as typeof fetch,
    );
    const dispatch = vi.fn();
    const state = buildState({
      data: { ...EMPTY_DATASET, conversations: [CONVERSATION_ONE] },
      activeConversationId: CONVERSATION_ONE.id,
    });
    renderSidebar(dispatch, state);

    fireEvent.click(screen.getByRole('button', { name: `Delete ${CONVERSATION_ONE.title}` }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete conversation' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: 'conversation/activate', id: '' }));
  });

  it('never dispatches conversation/activate when the deleted conversation was NOT the active one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, deleted: true }) })) as unknown as typeof fetch,
    );
    const dispatch = vi.fn();
    const state = buildState({
      data: { ...EMPTY_DATASET, conversations: [CONVERSATION_ONE] },
      activeConversationId: 'some-other-conversation',
    });
    renderSidebar(dispatch, state);

    fireEvent.click(screen.getByRole('button', { name: `Delete ${CONVERSATION_ONE.title}` }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete conversation' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.queryByText(CONVERSATION_ONE.title)).toBeNull());
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'conversation/activate' }));
  });
});
