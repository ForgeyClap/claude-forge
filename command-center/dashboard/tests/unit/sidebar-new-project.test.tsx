/**
 * Sidebar "New project" — build-newproject.
 *
 * Locks in the real flow: both "New project" controls (the full-width button
 * and the collapsed-rail icon button) are no longer disabled, opening them
 * drives `NewProjectDialog`, and submitting a name sends a real
 * `POST /api/projects` through `gateway-actions.ts`'s `requestNewProject` —
 * mirrors `gateway-actions.test.ts`'s fetch-stub precedent for "New chat".
 *
 * build-async-install: the 201 response no longer carries the Forge-install outcome — `Sidebar`
 * now polls `GET /api/projects/install-status?name=<n>` (`pollProjectInstall`, gateway-actions.ts)
 * and toasts the real, terminal outcome once that settles. Every fetch stub below answers that GET
 * with a TERMINAL state on its very first call (never `'installing'`/`'unknown'`) so no test ever
 * leaves a real 5s `setTimeout` poll tick dangling past the test's own lifetime.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeAction, PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
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

/** Answers `GET /api/projects/install-status?name=...` with a TERMINAL state on the first call —
 *  see this file's header for why that matters (no dangling poll timer past the test). */
function installStatusResponse(state: 'installed' | 'failed', reason: string | null = null): Response {
  return { ok: true, status: 200, json: async () => ({ ok: true, state, reason, note: null }) } as Response;
}

function installFetchMock(): { fetchMock: ReturnType<typeof vi.fn>; bodies: unknown[] } {
  const bodies: unknown[] = [];
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/projects') && init?.method === 'POST') {
      if (typeof init.body === 'string') bodies.push(JSON.parse(init.body));
      return {
        ok: true,
        status: 201,
        json: async () => ({ ok: true, project: { name: 'Demo Project', path: 'C:\\Users\\YOU\\Documents\\ForgeProjects\\Demo Project' } }),
      } as Response;
    }
    if (url.includes('/api/projects/install-status')) return installStatusResponse('installed');
    // Every other call (the health-poll connection store, a GET project list, ...) gets a benign
    // empty-ok response — this suite asserts on the /api/projects POST only.
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return { fetchMock, bodies };
}

function renderSidebar(dispatch: (action: PrototypeAction) => void, state: PrototypeState = buildState()) {
  const value: StoreValue = { state, dispatch };
  return render(
    createElement(
      MemoryRouter,
      null,
      createElement(PrototypeContext.Provider, { value }, createElement(Sidebar)),
    ),
  );
}

describe('Sidebar — "New project"', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders both New project controls (full button + rail icon button) as enabled, not disabled', () => {
    installFetchMock();
    renderSidebar(vi.fn());

    const buttons = screen.getAllByRole('button', { name: 'New project' });
    expect(buttons).toHaveLength(2);
    for (const button of buttons) expect(button).not.toBeDisabled();
  });

  it('opens the dialog and POSTs a real /api/projects request on submit, then activates the created project', async () => {
    const { bodies } = installFetchMock();
    const dispatch = vi.fn();
    renderSidebar(dispatch);

    fireEvent.click(screen.getAllByRole('button', { name: 'New project' })[0]);

    const dialog = await screen.findByRole('dialog', { name: 'New project' });
    const input = within(dialog).getByLabelText('Project name');
    fireEvent.change(input, { target: { value: 'Demo Project' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({ name: 'Demo Project' });

    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith({ type: 'project/activate', id: 'Demo Project' }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New project' })).toBeNull());
  });

  it('toasts an honest "installing" status right after creation (build-async-install)', async () => {
    const dispatch = vi.fn();
    installFetchMock();
    renderSidebar(dispatch);

    fireEvent.click(screen.getAllByRole('button', { name: 'New project' })[0]);
    const dialog = await screen.findByRole('dialog', { name: 'New project' });
    fireEvent.change(within(dialog).getByLabelText('Project name'), { target: { value: 'Demo Project' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'toast/push',
          toast: expect.objectContaining({ title: 'Project created', detail: expect.stringMatching(/being installed/i) }),
        }),
      ),
    );
  });

  it('polls install-status and toasts the real terminal outcome exactly once when the Forge installer fails (build-async-install)', async () => {
    const dispatch = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/api/projects') && init?.method === 'POST') {
          return {
            ok: true,
            status: 201,
            json: async () => ({ ok: true, project: { name: 'Demo Project', path: 'C:\\Users\\YOU\\Documents\\ForgeProjects\\Demo Project' } }),
          } as Response;
        }
        if (url.includes('/api/projects/install-status')) {
          return installStatusResponse('failed', 'the Forge installer timed out after 480000ms');
        }
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      }) as unknown as typeof fetch,
    );
    renderSidebar(dispatch);

    fireEvent.click(screen.getAllByRole('button', { name: 'New project' })[0]);
    const dialog = await screen.findByRole('dialog', { name: 'New project' });
    fireEvent.change(within(dialog).getByLabelText('Project name'), { target: { value: 'Demo Project' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));

    // Still activates the project immediately — creation itself succeeded; the install outcome is
    // learned later, asynchronously.
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: 'project/activate', id: 'Demo Project' }));

    // The terminal toast: the real, honest failure reason from install-status, shown exactly once.
    await waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'toast/push',
          toast: expect.objectContaining({
            title: expect.stringMatching(/forge install failed/i),
            detail: expect.stringMatching(/timed out/i),
          }),
        }),
      ),
    );
    const failureToasts = dispatch.mock.calls.filter(([action]) => {
      if (action.type !== 'toast/push') return false;
      return /forge install failed/i.test(action.toast.title);
    });
    expect(failureToasts).toHaveLength(1);
  });

  it('shows the gateway\'s real error text and keeps the dialog open on failure (no silent no-op)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/api/projects') && init?.method === 'POST') {
          return { ok: false, status: 409, json: async () => ({ ok: false, error: 'a project named "Demo Project" already exists' }) } as Response;
        }
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      }) as unknown as typeof fetch,
    );
    const dispatch = vi.fn();
    renderSidebar(dispatch);

    fireEvent.click(screen.getAllByRole('button', { name: 'New project' })[0]);
    const dialog = await screen.findByRole('dialog', { name: 'New project' });
    fireEvent.change(within(dialog).getByLabelText('Project name'), { target: { value: 'Demo Project' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/already exists/);
    expect(screen.getByRole('dialog', { name: 'New project' })).toBeInTheDocument();
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'project/activate' }));
  });
});
