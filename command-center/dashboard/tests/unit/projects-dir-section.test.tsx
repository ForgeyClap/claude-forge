/**
 * ProjectsDirSection — WP-S1 (owner request 2026-09-27). Same stubbed-fetch component-test
 * pattern as `discord-view.test.tsx`/`connect-wizard.test.tsx`: no store, no router — the
 * component reads/writes the gateway directly through `gateway-discord-projects-dir.ts`. `fetch`
 * is routed by URL substring since this component calls three different routes
 * (`/api/discord/projects-dir` GET+POST, `/api/discord/browse-folder` GET).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import ProjectsDirSection from '@/views/discord/ProjectsDirSection';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 400): Response {
  return { ok, status, json: async () => body } as Response;
}

const DEFAULT_SETTING = { ok: true, dir: 'C:\\Users\\me\\Documents\\ForgeProjects', source: 'default', exists: false, project_count: null };
const REAL_SETTING = { ok: true, dir: 'C:\\Users\\me\\MyProjects', source: 'setting', exists: true, project_count: 2 };

/** Routes every fetch call by URL substring — the same shape discord-view.test.tsx's own
 *  statusResponse() helper generalizes to three endpoints instead of one. `browse` describes one
 *  folder level; `postResponse` is what a POST to projects-dir answers with. */
function makeFetchMock({
  setting = DEFAULT_SETTING,
  browse = { ok: true, path: 'C:\\Users\\me\\Documents', parent: 'C:\\Users\\me', folders: ['alpha', 'Beta'] },
  postResponse,
}: {
  setting?: Record<string, unknown>;
  browse?: Record<string, unknown> | ((url: string) => Record<string, unknown>);
  postResponse?: Record<string, unknown>;
} = {}) {
  return vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST' && url.includes('/api/discord/projects-dir')) {
      const body = postResponse ?? { ok: true, dir: 'C:\\picked', restarted: false, pid: null };
      return jsonResponse(body, body.ok !== false, body.ok === false ? 400 : 200);
    }
    if (url.includes('/api/discord/browse-folder')) {
      const body = typeof browse === 'function' ? browse(url) : browse;
      return jsonResponse(body, body.ok !== false, body.ok === false ? 400 : 200);
    }
    if (url.includes('/api/discord/projects-dir')) {
      return jsonResponse(setting);
    }
    return jsonResponse({ ok: true });
  });
}

describe('ProjectsDirSection — read side', () => {
  it('shows a loading state, then the real dir/source/count', async () => {
    vi.stubGlobal('fetch', makeFetchMock());
    render(createElement(ProjectsDirSection));

    expect(screen.getByText('Reading the projects folder…')).toBeInTheDocument();

    expect(await screen.findByText('C:\\Users\\me\\Documents\\ForgeProjects')).toBeInTheDocument();
    expect(screen.getByText('This folder does not exist yet.')).toBeInTheDocument();
    expect(screen.getByText('The default location — nothing chosen yet.')).toBeInTheDocument();
  });

  it('a real setting with a project count shows "Chosen by you." and the honest count', async () => {
    vi.stubGlobal('fetch', makeFetchMock({ setting: REAL_SETTING }));
    render(createElement(ProjectsDirSection));

    expect(await screen.findByText('C:\\Users\\me\\MyProjects')).toBeInTheDocument();
    expect(screen.getByText('2 project folders found.')).toBeInTheDocument();
    expect(screen.getByText('Chosen by you.')).toBeInTheDocument();
  });

  it('a transport error is shown, never silently hidden', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, false, 503)));
    render(createElement(ProjectsDirSection));
    expect(await screen.findByText(/Could not reach the gateway: HTTP 503/)).toBeInTheDocument();
  });
});

describe('ProjectsDirSection — folder browser', () => {
  it('"Change folder" opens the picker and lists the real starting folder', async () => {
    vi.stubGlobal('fetch', makeFetchMock());
    render(createElement(ProjectsDirSection));
    await screen.findByText('C:\\Users\\me\\Documents\\ForgeProjects');

    fireEvent.click(screen.getByRole('button', { name: /change folder/i }));

    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('C:\\Users\\me\\Documents')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'alpha' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Beta' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /up one level/i })).toBeInTheDocument();
  });

  it('clicking a folder navigates INTO it (a new browse call with the joined path)', async () => {
    const fetchMock = makeFetchMock({
      browse: (url) =>
        url.includes('alpha')
          ? { ok: true, path: 'C:\\Users\\me\\Documents\\alpha', parent: 'C:\\Users\\me\\Documents', folders: [] }
          : { ok: true, path: 'C:\\Users\\me\\Documents', parent: 'C:\\Users\\me', folders: ['alpha', 'Beta'] },
    });
    vi.stubGlobal('fetch', fetchMock);
    render(createElement(ProjectsDirSection));
    await screen.findByText('C:\\Users\\me\\Documents\\ForgeProjects');
    fireEvent.click(screen.getByRole('button', { name: /change folder/i }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('button', { name: 'alpha' });

    fireEvent.click(within(dialog).getByRole('button', { name: 'alpha' }));

    expect(await within(dialog).findByText('C:\\Users\\me\\Documents\\alpha')).toBeInTheDocument();
    const calledUrls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(calledUrls.some((u) => u.includes(encodeURIComponent('C:\\Users\\me\\Documents/alpha')))).toBe(true);
  });

  it('the up-one-level row navigates to the reported parent', async () => {
    const fetchMock = makeFetchMock({
      browse: (url) =>
        url.includes(encodeURIComponent('C:\\Users\\me'))
          ? { ok: true, path: 'C:\\Users\\me', parent: 'C:\\Users', folders: ['Documents'] }
          : { ok: true, path: 'C:\\Users\\me\\Documents', parent: 'C:\\Users\\me', folders: ['alpha', 'Beta'] },
    });
    vi.stubGlobal('fetch', fetchMock);
    render(createElement(ProjectsDirSection));
    await screen.findByText('C:\\Users\\me\\Documents\\ForgeProjects');
    fireEvent.click(screen.getByRole('button', { name: /change folder/i }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('button', { name: /up one level/i });

    fireEvent.click(within(dialog).getByRole('button', { name: /up one level/i }));

    expect(await within(dialog).findByText('C:\\Users\\me')).toBeInTheDocument();
  });

  it('Cancel closes the picker without saving anything', async () => {
    const fetchMock = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    render(createElement(ProjectsDirSection));
    await screen.findByText('C:\\Users\\me\\Documents\\ForgeProjects');
    fireEvent.click(screen.getByRole('button', { name: /change folder/i }));
    await screen.findByRole('dialog');

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toBe(false);
  });
});

describe('ProjectsDirSection — saving', () => {
  it('"Use this folder" saves the currently browsed path (create:false) and shows the restart note on success', async () => {
    const fetchMock = makeFetchMock({ postResponse: { ok: true, dir: 'C:\\Users\\me\\Documents', restarted: true, pid: 42 } });
    vi.stubGlobal('fetch', fetchMock);
    render(createElement(ProjectsDirSection));
    await screen.findByText('C:\\Users\\me\\Documents\\ForgeProjects');
    fireEvent.click(screen.getByRole('button', { name: /change folder/i }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('C:\\Users\\me\\Documents');

    fireEvent.click(within(dialog).getByRole('button', { name: /use this folder/i }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(
      await screen.findByText('Saved — the bot restarted and channels are being made for each project folder.'),
    ).toBeInTheDocument();

    const postCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
    expect(postCall).toBeDefined();
    const [, init] = postCall as [unknown, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ dir: 'C:\\Users\\me\\Documents', create: false });
  });

  it('a save that could not restart shows the real restart_error, not a fabricated success', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetchMock({ postResponse: { ok: true, dir: 'C:\\x', restarted: false, restart_error: 'the install did not finish in time', pid: null } }),
    );
    render(createElement(ProjectsDirSection));
    await screen.findByText('C:\\Users\\me\\Documents\\ForgeProjects');
    fireEvent.click(screen.getByRole('button', { name: /change folder/i }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('C:\\Users\\me\\Documents');

    fireEvent.click(within(dialog).getByRole('button', { name: /use this folder/i }));

    expect(
      await screen.findByText('Saved, but the bot could not restart automatically: the install did not finish in time'),
    ).toBeInTheDocument();
  });

  it('a save with nothing running yet shows the plain "used next time the bot starts" note', async () => {
    vi.stubGlobal('fetch', makeFetchMock({ postResponse: { ok: true, dir: 'C:\\x', restarted: false, pid: null } }));
    render(createElement(ProjectsDirSection));
    await screen.findByText('C:\\Users\\me\\Documents\\ForgeProjects');
    fireEvent.click(screen.getByRole('button', { name: /change folder/i }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('C:\\Users\\me\\Documents');

    fireEvent.click(within(dialog).getByRole('button', { name: /use this folder/i }));

    expect(await screen.findByText('Saved. This folder will be used the next time the bot starts.')).toBeInTheDocument();
  });

  it('a save FAILURE shows the real gateway error INSIDE the still-open picker, never hidden behind it', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetchMock({ postResponse: { ok: false, error: 'that is a Windows system folder — pick (or make) an ordinary folder instead' } }),
    );
    render(createElement(ProjectsDirSection));
    await screen.findByText('C:\\Users\\me\\Documents\\ForgeProjects');
    fireEvent.click(screen.getByRole('button', { name: /change folder/i }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('C:\\Users\\me\\Documents');

    fireEvent.click(within(dialog).getByRole('button', { name: /use this folder/i }));

    expect(
      await within(dialog).findByText('that is a Windows system folder — pick (or make) an ordinary folder instead'),
    ).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument(); // stays open so the user can retry
  });

  it('"Use this path" sends the typed path and the create toggle state', async () => {
    const fetchMock = makeFetchMock({ postResponse: { ok: true, dir: 'C:\\typed\\path', restarted: false, pid: null } });
    vi.stubGlobal('fetch', fetchMock);
    render(createElement(ProjectsDirSection));
    await screen.findByText('C:\\Users\\me\\Documents\\ForgeProjects');
    fireEvent.click(screen.getByRole('button', { name: /change folder/i }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('C:\\Users\\me\\Documents');

    fireEvent.change(within(dialog).getByLabelText(/or type a path/i), { target: { value: 'C:\\typed\\path' } });
    fireEvent.click(within(dialog).getByRole('switch'));
    fireEvent.click(within(dialog).getByRole('button', { name: /use this path/i }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const postCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
    const [, init] = postCall as [unknown, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ dir: 'C:\\typed\\path', create: true });
  });

  it('"Use this path" stays disabled while the field is empty', async () => {
    vi.stubGlobal('fetch', makeFetchMock());
    render(createElement(ProjectsDirSection));
    await screen.findByText('C:\\Users\\me\\Documents\\ForgeProjects');
    fireEvent.click(screen.getByRole('button', { name: /change folder/i }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('C:\\Users\\me\\Documents');
    expect(within(dialog).getByRole('button', { name: /use this path/i })).toBeDisabled();
  });
});
