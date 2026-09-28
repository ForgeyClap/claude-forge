/**
 * DiscordView — WP-D2 (forge-2026-07-30-discord). Same stubbed-fetch component-test pattern as
 * `live-agents-strip.test.tsx`: no store, no router — the view takes no props and reads/writes
 * the gateway directly through `gateway-discord.ts`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import DiscordView from '@/views/discord/DiscordView';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function statusResponse(service: Record<string, unknown> | null): Response {
  const body = service === null ? { ok: true } : { ok: true, service };
  return { ok: true, status: 200, json: async () => body } as Response;
}

const RUNNING_SERVICE = {
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
};

const STOPPED_SERVICE = {
  installed: true,
  running: false,
  pid: null,
  started_at: null,
  transport: 'mock',
  ports: { bot: null, manager: null },
  health: null,
  conflict: null,
  env_keys: [{ name: 'DISCORD_BOT_TOKEN', present: false }],
  state_dir: '.claude/forge-discord/state',
  log_file: '.claude/forge-discord/discord.log',
};

describe('DiscordView — not installed', () => {
  it('shows a distinct honest empty state, never confused with "installed but stopped"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => statusResponse(null)));
    render(createElement(DiscordView));

    expect(
      await screen.findByText('Discord service is not installed in this project'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Service')).toBeNull();
  });
});

describe('DiscordView — installed and running', () => {
  it('renders real status fields from the contract, and the switch reflects service.running', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => statusResponse(RUNNING_SERVICE)));
    render(createElement(DiscordView));

    const toggle = await screen.findByRole('switch');
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));

    expect(screen.getByText('RUNNING')).toBeInTheDocument();
    expect(screen.getByText('4242')).toBeInTheDocument();
    expect(screen.getByText('2026-07-30T09:00:00.000Z')).toBeInTheDocument();
    expect(screen.getByText('discord')).toBeInTheDocument();
    expect(screen.getByText('.claude/forge-discord/state')).toBeInTheDocument();
  });

  it('renders env keys as name + present/missing chips, never a value', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => statusResponse(RUNNING_SERVICE)));
    render(createElement(DiscordView));

    expect(await screen.findByText('DISCORD_BOT_TOKEN')).toBeInTheDocument();
    expect(screen.getByText('Present')).toBeInTheDocument();
    expect(screen.getByText('DISCORD_GUILD_ID')).toBeInTheDocument();
    expect(screen.getByText('Missing')).toBeInTheDocument();
  });

  it('renders whatever real health fields exist, defensively', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => statusResponse(RUNNING_SERVICE)));
    render(createElement(DiscordView));

    // v2.9.0 (audit finding 31): plain labels and readable values; the raw field name stays as the tooltip.
    expect(await screen.findByText('Queue depth')).toBeInTheDocument();
    expect(screen.getByTitle('queue_depth')).toBeInTheDocument();
    expect(screen.getByText('0')).toBeInTheDocument();
    expect(screen.getByText('Uptime')).toBeInTheDocument();
    expect(screen.getByTitle('uptime_seconds')).toBeInTheDocument();
    expect(screen.getByText('13 min')).toBeInTheDocument();
  });
});

describe('DiscordView — installed and stopped', () => {
  it('the switch reflects false and no health metrics are fabricated', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => statusResponse(STOPPED_SERVICE)));
    render(createElement(DiscordView));

    const toggle = await screen.findByRole('switch');
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
    expect(screen.getByText('STOPPED')).toBeInTheDocument();
    expect(
      screen.getByText('Bot not reachable — it may be stopped or still starting.'),
    ).toBeInTheDocument();
  });

  it('a real conflict is shown verbatim', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        statusResponse({ ...STOPPED_SERVICE, conflict: 'Another process is already listening on port 4501.' }),
      ),
    );
    render(createElement(DiscordView));

    expect(
      await screen.findByText('Another process is already listening on port 4501.'),
    ).toBeInTheDocument();
  });
});

describe('DiscordView — WP-P1 automatic Discord-dependency install status (shown inside the Connect wizard)', () => {
  it('shows the honest "installing" message while the one-time dependency install is in progress', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => statusResponse({ ...STOPPED_SERVICE, deps_install_phase: 'installing' })),
    );
    render(createElement(DiscordView));

    expect(
      await screen.findByText(/Installing the Discord bot.s software/),
    ).toBeInTheDocument();
  });

  it('shows the real failure message, verbatim, when the automatic install failed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        statusResponse({
          ...STOPPED_SERVICE,
          deps_install_phase: 'failed',
          deps_install_error: 'npm was not found on this machine — install Node.js (which includes npm) and try again',
        }),
      ),
    );
    render(createElement(DiscordView));

    expect(
      await screen.findByText('npm was not found on this machine — install Node.js (which includes npm) and try again'),
    ).toBeInTheDocument();
  });

  it('shows neither message once installed — the ordinary, steady-state case', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => statusResponse({ ...STOPPED_SERVICE, deps_installed: true, deps_install_phase: 'installed' })),
    );
    render(createElement(DiscordView));

    await screen.findByText('STOPPED'); // wait for the real status to have rendered at all
    expect(screen.queryByText(/Installing the Discord bot.s software/)).toBeNull();
    expect(screen.queryByText(/could not be installed automatically/)).toBeNull();
  });
});

describe('DiscordView — the on/off switch never optimistic, shows real errors verbatim', () => {
  it('shows a pending line while the start request is in flight, then the real 409 error text on failure — the switch never flips until the next poll', async () => {
    // A holder object, not a bare `let`: TS does not narrow a mutable object property across a
    // closure boundary the way it narrows a plain `let` variable, which is what is read here
    // (assigned inside the fetch mock's closure, read later after several `await`s).
    const startResolver: { current: ((value: Response) => void) | null } = { current: null };
    const fetchSpy = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/discord/status')) return statusResponse(STOPPED_SERVICE);
      if (url.includes('/api/discord/start') && init?.method === 'POST') {
        return new Promise<Response>((resolve) => {
          startResolver.current = resolve;
        });
      }
      return statusResponse(STOPPED_SERVICE);
    });
    vi.stubGlobal('fetch', fetchSpy);

    render(createElement(DiscordView));
    const toggle = await screen.findByRole('switch');
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));

    fireEvent.click(toggle);

    expect(await screen.findByText('Starting…')).toBeInTheDocument();
    // Never optimistic: still reflects the last real poll, not the click.
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    expect(startResolver.current).not.toBeNull();
    startResolver.current?.({
      ok: false,
      status: 409,
      json: async () => ({ ok: false, error: 'Another Discord bot instance is already running.' }),
    } as Response);

    expect(
      await screen.findByText('Another Discord bot instance is already running.'),
    ).toBeInTheDocument();
    // Still not flipped — only a real status poll reporting running:true would do that.
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });
});

describe('DiscordView — a transport error from the status poll itself', () => {
  it('shows the real transport error honestly, without a store to fall back on', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }) as Response),
    );
    render(createElement(DiscordView));

    expect(
      await screen.findByText(/Could not reach the gateway: HTTP 503/),
    ).toBeInTheDocument();
  });
});
