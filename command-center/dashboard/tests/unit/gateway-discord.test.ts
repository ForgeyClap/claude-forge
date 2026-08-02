/**
 * gateway-discord.ts — WP-D2 (forge-2026-07-30-discord). Pure `parseDiscordService` tests (no
 * network), `useGatewayDiscordStatus` poll-hook tests, and `requestDiscordStart`/
 * `requestDiscordStop` action tests, all against a stubbed `fetch` — same house pattern as
 * `gateway-agent-dispatches.test.ts`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor, cleanup, act } from '@testing-library/react';

import {
  EMPTY_DISCORD_SERVICE,
  parseDiscordService,
  requestDiscordStart,
  requestDiscordStop,
  useGatewayDiscordStatus,
} from '@/prototype/state/gateway-discord';
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

/* ------------------------------------------------------------ parseDiscordService */

describe('parseDiscordService — the real GET /api/discord/status response shape', () => {
  it('a response with no service field at all reads back the honest empty constant, never fabricated', () => {
    expect(parseDiscordService({ ok: true })).toEqual(EMPTY_DISCORD_SERVICE);
  });

  it('parses a real, RUNNING, live-transport service verbatim', () => {
    const service = parseDiscordService({
      ok: true,
      service: {
        installed: true,
        running: true,
        pid: 4242,
        started_at: '2026-07-30T09:00:00.000Z',
        transport: 'discord',
        ports: { bot: 4501, manager: null },
        health: { queue_depth: 0, uptime_seconds: 812 },
        conflict: null,
        env_keys: [
          { name: 'DISCORD_BOT_TOKEN', present: true },
          { name: 'DISCORD_GUILD_ID', present: false },
        ],
        state_dir: '.claude/forge-discord/state',
        log_file: '.claude/forge-discord/discord.log',
      },
    });

    expect(service).toEqual({
      installed: true,
      running: true,
      pid: 4242,
      startedAt: '2026-07-30T09:00:00.000Z',
      transport: 'discord',
      ports: { bot: 4501, manager: null },
      health: { queue_depth: 0, uptime_seconds: 812 },
      conflict: null,
      envKeys: [
        { name: 'DISCORD_BOT_TOKEN', present: true },
        { name: 'DISCORD_GUILD_ID', present: false },
      ],
      stateDir: '.claude/forge-discord/state',
      logFile: '.claude/forge-discord/discord.log',
    });
  });

  it('a genuinely STOPPED, not-installed-yet service reads back honest nulls/false, never guessed', () => {
    const service = parseDiscordService({
      ok: true,
      service: {
        installed: false,
        running: false,
        pid: null,
        started_at: null,
        transport: null,
        ports: { bot: null, manager: null },
        health: null,
        conflict: null,
        env_keys: [],
        state_dir: '',
        log_file: '',
      },
    });
    expect(service.installed).toBe(false);
    expect(service.running).toBe(false);
    expect(service.pid).toBeNull();
    expect(service.health).toBeNull();
    expect(service.envKeys).toEqual([]);
  });

  it('a real conflict string is carried through verbatim', () => {
    const service = parseDiscordService({
      ok: true,
      service: {
        installed: true,
        running: false,
        pid: null,
        started_at: null,
        transport: null,
        ports: { bot: null, manager: null },
        health: null,
        conflict: 'Another process is already listening on port 4501.',
        env_keys: [],
        state_dir: '.claude/forge-discord/state',
        log_file: '.claude/forge-discord/discord.log',
      },
    });
    expect(service.conflict).toBe('Another process is already listening on port 4501.');
  });

  it('ports.manager is ALWAYS null per the fixed contract, even if the wire sent something else', () => {
    const service = parseDiscordService({
      ok: true,
      service: {
        installed: true,
        running: true,
        pid: 1,
        started_at: null,
        transport: 'mock',
        ports: { bot: 4501, manager: 9999 },
        health: null,
        conflict: null,
        env_keys: [],
        state_dir: '',
        log_file: '',
      },
    });
    expect(service.ports.manager).toBeNull();
    expect(service.ports.bot).toBe(4501);
  });
});

/* ------------------------------------------------------------ useGatewayDiscordStatus */

describe('useGatewayDiscordStatus', () => {
  function jsonResponse(body: unknown, ok = true, status = 200): Response {
    return { ok, status, json: async () => body } as Response;
  }

  it('polls GET /api/discord/status and returns the real parsed service', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes('/api/discord/status')) {
          return jsonResponse({
            ok: true,
            service: {
              installed: true,
              running: true,
              pid: 777,
              started_at: '2026-07-30T09:00:00.000Z',
              transport: 'mock',
              ports: { bot: 4501, manager: null },
              health: { ok: true },
              conflict: null,
              env_keys: [],
              state_dir: 'state',
              log_file: 'log',
            },
          });
        }
        return jsonResponse({ ok: true });
      }),
    );

    const { result } = renderHook(() => useGatewayDiscordStatus());
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.data.running).toBe(true);
    expect(result.current.data.pid).toBe(777);
  });

  it('a failed poll (5s later) reports the real transport error and keeps the last known-good data', async () => {
    // Same house pattern as gateway-capabilities.test.ts's useGatewayTools fake-timer test:
    // vi.useFakeTimers() BEFORE renderHook, then vi.advanceTimersByTimeAsync for the mount-time
    // tick and the next scheduled tick, in a try/finally so a failure never leaks fake timers
    // into a later test.
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn();
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          service: {
            installed: true,
            running: true,
            pid: 5,
            started_at: null,
            transport: 'mock',
            ports: { bot: null, manager: null },
            health: null,
            conflict: null,
            env_keys: [],
            state_dir: '',
            log_file: '',
          },
        }),
      });
      fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
      vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

      const { result } = renderHook(() => useGatewayDiscordStatus());

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0); // the mount-time immediate poll resolves
      });
      expect(result.current.data.pid).toBe(5);
      expect(result.current.error).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000); // the next scheduled poll fires and fails
      });
      expect(result.current.error).toBe('HTTP 503');
      // Last known-good data must survive the failed poll — never wiped to a fabricated empty.
      expect(result.current.data.pid).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ------------------------------------------------------------ start / stop actions */

describe('requestDiscordStart', () => {
  it('202 success extracts the real pid, and sends the exec token header when present', async () => {
    setExecToken('tok-123');
    const fetchSpy = vi.fn(async (_input: unknown, _init?: RequestInit) => ({ ok: true, status: 202, json: async () => ({ ok: true, pid: 99 }) }) as Response);
    vi.stubGlobal('fetch', fetchSpy);

    const result = await requestDiscordStart();
    expect(result).toEqual({ ok: true, pid: 99, error: null });

    const [, init] = fetchSpy.mock.calls[0];
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers[EXEC_TOKEN_HEADER]).toBe('tok-123');
  });

  it('409 conflict returns the gateway\'s own real error text verbatim, never a client-invented message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 409,
        json: async () => ({ ok: false, error: 'Another Discord bot instance is already running.' }),
      }) as Response),
    );

    const result = await requestDiscordStart();
    expect(result.ok).toBe(false);
    expect(result.pid).toBeNull();
    expect(result.error).toBe('Another Discord bot instance is already running.');
  });

  it('no exec token available (no meta tag): the header is simply omitted, never fabricated', async () => {
    const fetchSpy = vi.fn(async (_input: unknown, _init?: RequestInit) => ({ ok: true, status: 202, json: async () => ({ ok: true, pid: 1 }) }) as Response);
    vi.stubGlobal('fetch', fetchSpy);

    await requestDiscordStart();
    const [, init] = fetchSpy.mock.calls[0];
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers[EXEC_TOKEN_HEADER]).toBeUndefined();
  });
});

describe('requestDiscordStop', () => {
  it('200 success extracts the real stopped flag', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, stopped: true }) }) as Response));
    const result = await requestDiscordStop();
    expect(result).toEqual({ ok: true, stopped: true, error: null });
  });

  it('a failure returns the real error text, never a fabricated success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ ok: false, error: 'Could not stop the process.' }) }) as Response),
    );
    const result = await requestDiscordStop();
    expect(result).toEqual({ ok: false, stopped: false, error: 'Could not stop the process.' });
  });
});
