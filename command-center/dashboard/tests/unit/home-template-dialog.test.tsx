/**
 * Home "Start something" template cards — build-lastdemos.
 *
 * Locks in the real flow: all six template cards are no longer disabled,
 * clicking one opens the SAME real `NewProjectDialog` Sidebar's own "New
 * project" button uses (never a duplicate), seeded with that template's name
 * as a starting suggestion, and submitting still drives the real
 * `POST /api/projects` route (gateway-actions.ts's `requestNewProject`) —
 * mirrors `sidebar-new-project.test.tsx`'s fetch-stub precedent.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';

import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeAction, PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import HomeView from '@/views/home/HomeView';

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

function installFetchMock(): { bodies: unknown[] } {
  const bodies: unknown[] = [];
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/projects') && init?.method === 'POST') {
      if (typeof init.body === 'string') bodies.push(JSON.parse(init.body));
      return {
        ok: true,
        status: 201,
        json: async () => ({ ok: true, project: { name: 'Website', path: 'C:\\Users\\YOU\\Documents\\ForgeProjecten\\Website' } }),
      } as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return { bodies };
}

function renderHome(dispatch: (action: PrototypeAction) => void, state: PrototypeState = buildState()) {
  const value: StoreValue = { state, dispatch };
  return render(
    createElement(
      MemoryRouter,
      null,
      createElement(PrototypeContext.Provider, { value }, createElement(HomeView)),
    ),
  );
}

describe('Home — "Start something" template cards', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders all six template cards as enabled, not disabled', () => {
    installFetchMock();
    renderHome(vi.fn());

    const buttons = screen.getAllByRole('button', { name: /Website|Full-stack app|Automation|Chatbot|Scraper|Research/ });
    expect(buttons.length).toBe(6);
    for (const button of buttons) expect(button).not.toBeDisabled();
  });

  it('opens NewProjectDialog seeded with the clicked template\'s name, and creating a real project activates it', async () => {
    const { bodies } = installFetchMock();
    const dispatch = vi.fn();
    renderHome(dispatch);

    fireEvent.click(screen.getByRole('button', { name: /Website/ }));

    const dialog = await screen.findByRole('dialog', { name: 'New project' });
    const input = within(dialog).getByLabelText('Project name') as HTMLInputElement;
    expect(input.value).toBe('Website');
    // Honest description: the template only names the project, nothing more.
    expect(dialog.textContent).toMatch(/only a suggestion/i);
    expect(dialog.textContent).toMatch(/no template content or scaffolding is added/i);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({ name: 'Website' });

    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith({ type: 'project/activate', id: 'Website' }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New project' })).toBeNull());
  });

  it('the button title states honestly that only the name is suggested', () => {
    installFetchMock();
    renderHome(vi.fn());
    const button = screen.getByRole('button', { name: /Research/ });
    expect(button.title).toMatch(/suggests/i);
    expect(button.title).toMatch(/no template content or scaffolding/i);
  });
});
