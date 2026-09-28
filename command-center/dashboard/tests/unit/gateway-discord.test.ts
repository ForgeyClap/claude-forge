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
  requestDiscordConnect,
  requestDiscordSelectGuild,
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
      // WP-v290-B: absent on the wire in this fixture -> the honest null/[] defaults, never guessed.
      username: null,
      applicationId: null,
      guilds: [],
      inviteUrl: null,
      setupState: null,
      loginError: null,
      // WP-P1: same honesty rule — absent on the wire here -> honest false/null defaults.
      depsInstalled: false,
      depsInstallPhase: null,
      depsInstallError: null,
      // WP-DA: an absent autostart block (an older gateway) -> null, never a guessed "yes".
      autostart: null,
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

  it('WP-v290-B: username/applicationId/guilds/inviteUrl/setupState/loginError are parsed verbatim when present', () => {
    const service = parseDiscordService({
      ok: true,
      service: {
        installed: true,
        running: true,
        pid: 1,
        started_at: null,
        transport: 'discord',
        ports: { bot: 4501, manager: null },
        health: null,
        conflict: null,
        env_keys: [],
        state_dir: '',
        log_file: '',
        username: 'ForgeBot',
        application_id: '998877665544332211',
        guilds: [{ id: '1', name: 'Alpha' }, { id: '2', name: 'Beta' }],
        invite_url: 'https://discord.com/oauth2/authorize?client_id=998877665544332211&scope=bot%20applications.commands&permissions=12345',
        setup_state: 'login-failed',
        login_error: 'Discord rejected the login: bad token.',
      },
    });
    expect(service.username).toBe('ForgeBot');
    expect(service.applicationId).toBe('998877665544332211');
    expect(service.guilds).toEqual([{ id: '1', name: 'Alpha' }, { id: '2', name: 'Beta' }]);
    expect(service.inviteUrl).toBe(
      'https://discord.com/oauth2/authorize?client_id=998877665544332211&scope=bot%20applications.commands&permissions=12345',
    );
    expect(service.setupState).toBe('login-failed');
    expect(service.loginError).toBe('Discord rejected the login: bad token.');
  });

  it('WP-v290-B: an absent guilds/username/etc. reads back the honest empty defaults, never fabricated', () => {
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
        conflict: null,
        env_keys: [],
        state_dir: '',
        log_file: '',
      },
    });
    expect(service.username).toBeNull();
    expect(service.applicationId).toBeNull();
    expect(service.guilds).toEqual([]);
    expect(service.inviteUrl).toBeNull();
    expect(service.setupState).toBeNull();
    expect(service.loginError).toBeNull();
  });

  it('WP-P1: deps_installed/deps_install_phase/deps_install_error are parsed verbatim when present', () => {
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
        conflict: null,
        env_keys: [],
        state_dir: '',
        log_file: '',
        deps_installed: false,
        deps_install_phase: 'failed',
        deps_install_error: 'npm was not found on this machine — install Node.js (which includes npm) and try again',
      },
    });
    expect(service.depsInstalled).toBe(false);
    expect(service.depsInstallPhase).toBe('failed');
    expect(service.depsInstallError).toBe('npm was not found on this machine — install Node.js (which includes npm) and try again');
  });

  it('WP-P1: an absent deps_* triple reads back the honest false/null defaults, never fabricated', () => {
    const service = parseDiscordService({
      ok: true,
      service: {
        installed: true,
        running: true,
        pid: 1,
        started_at: null,
        transport: 'discord',
        ports: { bot: 4501, manager: null },
        health: null,
        conflict: null,
        env_keys: [],
        state_dir: '',
        log_file: '',
      },
    });
    expect(service.depsInstalled).toBe(false);
    expect(service.depsInstallPhase).toBeNull();
    expect(service.depsInstallError).toBeNull();
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
    expect(result).toEqual({ ok: true, pid: 99, error: null, warning: null });

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
    expect(result).toEqual({ ok: true, stopped: true, error: null, warning: null });
  });

  it('a failure returns the real error text, never a fabricated success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ ok: false, error: 'Could not stop the process.' }) }) as Response),
    );
    const result = await requestDiscordStop();
    expect(result).toEqual({ ok: false, stopped: false, error: 'Could not stop the process.', warning: null });
  });
});

/* ------------------------------------------------------------ WP-v290-B: connect / select-guild */

describe('requestDiscordConnect', () => {
  it('sends the token in the POST body and extracts the real pid on success', async () => {
    const fetchSpy = vi.fn(async (_input: unknown, _init?: RequestInit) => ({ ok: true, status: 202, json: async () => ({ ok: true, pid: 42 }) }) as Response);
    vi.stubGlobal('fetch', fetchSpy);

    const result = await requestDiscordConnect('fake.token.value');
    expect(result).toEqual({ ok: true, pid: 42, error: null });

    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({ token: 'fake.token.value' });
  });

  it('includes guildId in the body only when given', async () => {
    const fetchSpy = vi.fn(async (_input: unknown, _init?: RequestInit) => ({ ok: true, status: 202, json: async () => ({ ok: true, pid: 1 }) }) as Response);
    vi.stubGlobal('fetch', fetchSpy);

    await requestDiscordConnect('fake.token.value', '123456789012345678');
    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({ token: 'fake.token.value', guildId: '123456789012345678' });
  });

  it('a 400 bad-token-format failure returns the gateway\'s own real error text verbatim', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({ ok: false, error: 'that does not look like a real Discord bot token' }),
      }) as Response),
    );
    const result = await requestDiscordConnect('not-a-real-token');
    expect(result).toEqual({ ok: false, pid: null, error: 'that does not look like a real Discord bot token' });
  });

  it('sends the exec token header when present', async () => {
    setExecToken('tok-connect');
    const fetchSpy = vi.fn(async (_input: unknown, _init?: RequestInit) => ({ ok: true, status: 202, json: async () => ({ ok: true, pid: 1 }) }) as Response);
    vi.stubGlobal('fetch', fetchSpy);

    await requestDiscordConnect('fake.token.value');
    const [, init] = fetchSpy.mock.calls[0];
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers[EXEC_TOKEN_HEADER]).toBe('tok-connect');
  });
});

describe('requestDiscordSelectGuild', () => {
  it('sends the chosen guildId and extracts the real pid on success', async () => {
    const fetchSpy = vi.fn(async (_input: unknown, _init?: RequestInit) => ({ ok: true, status: 202, json: async () => ({ ok: true, pid: 7 }) }) as Response);
    vi.stubGlobal('fetch', fetchSpy);

    const result = await requestDiscordSelectGuild('999888777666555444');
    expect(result).toEqual({ ok: true, pid: 7, error: null });

    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({ guildId: '999888777666555444' });
  });

  it('a failure returns the real error text, never a fabricated success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ ok: false, error: 'guildId must be a real Discord server ID' }) }) as Response),
    );
    const result = await requestDiscordSelectGuild('nope');
    expect(result).toEqual({ ok: false, pid: null, error: 'guildId must be a real Discord server ID' });
  });
});
