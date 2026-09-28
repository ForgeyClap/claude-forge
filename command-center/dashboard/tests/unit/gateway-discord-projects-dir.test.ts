/**
 * gateway-discord-projects-dir.ts — WP-S1 (owner request 2026-09-27). Pure
 * `parseProjectsDirSetting` tests (no network), `useGatewayProjectsDir` poll-hook tests, and
 * `requestSetProjectsDir`/`requestBrowseFolder` action tests, all against a stubbed `fetch` —
 * same house pattern as `gateway-discord.test.ts`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor, cleanup, act } from '@testing-library/react';

import {
  EMPTY_PROJECTS_DIR_SETTING,
  requestBrowseFolder,
  requestSetProjectsDir,
  useGatewayProjectsDir,
} from '@/prototype/state/gateway-discord-projects-dir';
import { EXEC_TOKEN_HEADER } from '@/prototype/state/gateway-client';

const EXEC_TOKEN_META_NAME = 'cc-exec-token';

function setExecToken(token: string | null): void {
  document.querySelectorAll(`meta[name="${EXEC_TOKEN_META_NAME}"]`).forEach((node) => node.remove());
  if (token === null) return;
  const meta = document.createElement('meta');
  meta.setAttribute('name', EXEC_TOKEN_META_NAME);
  meta.setAttribute('content', token);
  document.head.appendChild(meta);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setExecToken(null);
});

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 400): Response {
  return { ok, status, json: async () => body } as Response;
}

/* ------------------------------------------------------------ useGatewayProjectsDir */

describe('useGatewayProjectsDir', () => {
  it('polls GET /api/discord/projects-dir and returns the real parsed setting', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ ok: true, dir: '/home/me/Documents/ForgeProjects', source: 'default', exists: true, project_count: 3 }),
      ),
    );

    const { result } = renderHook(() => useGatewayProjectsDir());
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toEqual(EMPTY_PROJECTS_DIR_SETTING);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.data).toEqual({
      dir: '/home/me/Documents/ForgeProjects',
      source: 'default',
      exists: true,
      projectCount: 3,
      projectCountTruncated: false,
    });
  });

  it('Codex run B F-04: project_count_truncated:true reports projectCountTruncated:true, so a huge folder never reads as an exact count', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          ok: true,
          dir: '/home/me/Documents/ForgeProjects',
          source: 'setting',
          exists: true,
          project_count: 5000,
          project_count_truncated: true,
        }),
      ),
    );
    const { result } = renderHook(() => useGatewayProjectsDir());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data.projectCount).toBe(5000);
    expect(result.current.data.projectCountTruncated).toBe(true);
  });

  it('an unreachable/malformed source value reads back null, never a guess', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true, dir: '/x', source: 'weird-value', exists: false })));
    const { result } = renderHook(() => useGatewayProjectsDir());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data.source).toBeNull();
    expect(result.current.data.projectCount).toBeNull();
  });

  it('a failed poll reports the real transport error and keeps the last known-good data', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn();
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ ok: true, dir: '/real/projects', source: 'setting', exists: true, project_count: 5 }),
      );
      fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
      vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

      const { result } = renderHook(() => useGatewayProjectsDir());

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0); // the mount-time immediate poll resolves
      });
      expect(result.current.data.dir).toBe('/real/projects');
      expect(result.current.error).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(15000); // the next scheduled poll fires and fails
      });
      expect(result.current.error).toBe('HTTP 503');
      expect(result.current.data.dir).toBe('/real/projects'); // never wiped to a fabricated empty
    } finally {
      vi.useRealTimers();
    }
  });

  it('refresh() re-fetches immediately rather than waiting for the next scheduled poll', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn();
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ ok: true, dir: '/before', source: 'default', exists: false, project_count: null }),
      );
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ ok: true, dir: '/after', source: 'setting', exists: true, project_count: 1 }),
      );
      vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

      const { result } = renderHook(() => useGatewayProjectsDir());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.data.dir).toBe('/before');

      act(() => {
        result.current.refresh();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.data.dir).toBe('/after');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ------------------------------------------------------------ requestSetProjectsDir */

describe('requestSetProjectsDir', () => {
  it('sends dir+create in the POST body, extracts the real dir/restarted/pid on success, and sends the exec token header when present', async () => {
    setExecToken('tok-123');
    const fetchSpy = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      jsonResponse({ ok: true, dir: '/chosen/projects', restarted: true, pid: 555 }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const result = await requestSetProjectsDir('/chosen/projects', true);
    expect(result).toEqual({ ok: true, dir: '/chosen/projects', restarted: true, restartError: null, error: null });

    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({ dir: '/chosen/projects', create: true });
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers[EXEC_TOKEN_HEADER]).toBe('tok-123');
  });

  it('create defaults to false when omitted', async () => {
    const fetchSpy = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      jsonResponse({ ok: true, dir: '/x', restarted: false, pid: null }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    await requestSetProjectsDir('/x');
    const [, init] = fetchSpy.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({ dir: '/x', create: false });
  });

  it('a save success that could not restart reports restarted:false with the real restart_error, never a fabricated success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ ok: true, dir: '/x', restarted: false, restart_error: 'the install did not finish in time', pid: null }),
      ),
    );
    const result = await requestSetProjectsDir('/x');
    expect(result).toEqual({ ok: true, dir: '/x', restarted: false, restartError: 'the install did not finish in time', error: null });
  });

  it('a validation failure (e.g. a system folder) returns the gateway\'s own real error text verbatim, never a client-invented message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ ok: false, error: 'that is a Windows system folder — pick (or make) an ordinary folder instead' }, false, 400),
      ),
    );
    const result = await requestSetProjectsDir('C:\\Windows');
    expect(result).toEqual({ ok: false, dir: null, restarted: false, restartError: null, error: 'that is a Windows system folder — pick (or make) an ordinary folder instead' });
  });
});

/* ------------------------------------------------------------ requestBrowseFolder */

describe('requestBrowseFolder', () => {
  it('omitting dir calls the route with no query string', async () => {
    const fetchSpy = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      jsonResponse({ ok: true, path: '/home/me/Documents', parent: '/home/me', folders: ['a', 'b'] }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const result = await requestBrowseFolder();
    expect(result).toEqual({ ok: true, path: '/home/me/Documents', parent: '/home/me', folders: ['a', 'b'], truncated: false, error: null });

    const [urlArg] = fetchSpy.mock.calls[0];
    expect(String(urlArg)).not.toContain('?dir=');
  });

  it('a given dir is sent, percent-encoded, as ?dir=', async () => {
    const fetchSpy = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      jsonResponse({ ok: true, path: 'C:\\Users\\me', parent: 'C:\\Users', folders: [] }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    await requestBrowseFolder('C:\\Users\\me');
    const [urlArg] = fetchSpy.mock.calls[0];
    expect(String(urlArg)).toContain('?dir=' + encodeURIComponent('C:\\Users\\me'));
  });

  it('the top of the tree reports parent:null, never a self-referencing "up"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true, path: 'C:\\', parent: null, folders: ['Users', 'Windows'] })));
    const result = await requestBrowseFolder('C:\\');
    expect(result.parent).toBeNull();
    expect(result.folders).toEqual(['Users', 'Windows']);
  });

  it('a real gateway error (e.g. folder not found) is returned verbatim, never a fabricated empty success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: false, error: 'folder not found: ENOENT' }, false, 400)));
    const result = await requestBrowseFolder('/nope');
    expect(result).toEqual({ ok: false, path: null, parent: null, folders: [], truncated: false, error: 'folder not found: ENOENT' });
  });

  it('Codex run B F-04: truncated:true on the wire is reported honestly, never silently dropped', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ ok: true, path: '/huge', parent: '/', folders: ['a', 'b'], truncated: true })),
    );
    const result = await requestBrowseFolder('/huge');
    expect(result.truncated).toBe(true);
  });
});
