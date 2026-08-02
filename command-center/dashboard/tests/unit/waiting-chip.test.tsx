/**
 * WaitingChip — feat-live-visibility (Gap A). Renders nothing when no ask is genuinely pending
 * (honest empty state), shows a real, clickable chip when one is, and jumps to the right
 * conversation on click. Same render harness as `sidebar-new-project.test.tsx`
 * (PrototypeContext.Provider + MemoryRouter, a stubbed `fetch`).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeAction, PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import { WaitingChip } from '@/components/shell/WaitingChip';

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
    activeProjectId: 'demo-project',
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

function renderChip(dispatch: (action: PrototypeAction) => void, state: PrototypeState = buildState()) {
  const value: StoreValue = { state, dispatch };
  return render(
    createElement(MemoryRouter, null, createElement(PrototypeContext.Provider, { value }, createElement(WaitingChip))),
  );
}

describe('WaitingChip', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders nothing when no ask is genuinely pending for the active project (honest empty state)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, pending_asks: [] }) }) as Response));
    const { container } = renderChip(vi.fn());
    await waitFor(() => expect(container.querySelector('.fw-waiting')).toBeNull());
  });

  it('shows the real chip once a genuine pending ask is fetched, and jumps to its conversation on click', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes('/api/pending-asks')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              pending_asks: [{ id: 'ask-1', conversation_id: 'c-1', conversation_first_message: 'Which color?', turn_id: 't-1', question_count: 1 }],
            }),
          } as Response;
        }
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      }),
    );
    const dispatch = vi.fn();
    renderChip(dispatch);

    const button = await screen.findByRole('button', { name: /Waiting on you/ });
    fireEvent.click(button);

    expect(dispatch).toHaveBeenCalledWith({ type: 'conversation/activate', id: 'c-1' });
  });

  it('shows a real count when more than one conversation is genuinely waiting', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes('/api/pending-asks')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              pending_asks: [
                { id: 'ask-1', conversation_id: 'c-1', conversation_first_message: 'Q1', turn_id: 't-1', question_count: 1 },
                { id: 'ask-2', conversation_id: 'c-2', conversation_first_message: 'Q2', turn_id: 't-2', question_count: 1 },
              ],
            }),
          } as Response;
        }
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      }),
    );
    renderChip(vi.fn());

    await waitFor(() => expect(screen.getByRole('button', { name: /Waiting on you/ }).textContent).toContain('2'));
  });

  it('no active project selected: never fetches, renders nothing', async () => {
    const fetchSpy = vi.fn(async (_input: unknown) => ({ ok: true, status: 200, json: async () => ({ ok: true, pending_asks: [] }) }) as Response);
    vi.stubGlobal('fetch', fetchSpy);
    const { container } = renderChip(vi.fn(), buildState({ activeProjectId: '' }));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.querySelector('.fw-waiting')).toBeNull();
    expect(fetchSpy.mock.calls.every((call) => !String(call[0]).includes('/api/pending-asks'))).toBe(true);
  });
});
