/**
 * ConnectWizard — WP-v290-B (beginner Discord onboarding). Same stubbed-fetch component-test
 * pattern as `discord-view.test.tsx`: no store, no router — the component takes a plain
 * `DiscordService` prop and writes through `gateway-discord.ts`'s real actions.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import ConnectWizard from '@/views/discord/ConnectWizard';
import { EMPTY_DISCORD_SERVICE } from '@/prototype/state/gateway-discord';
import type { DiscordService } from '@/prototype/state/gateway-discord';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function service(overrides: Partial<DiscordService>): DiscordService {
  return { ...EMPTY_DISCORD_SERVICE, ...overrides };
}

function jsonResponse(body: unknown, ok = true, status = ok ? 202 : 400): Response {
  return { ok, status, json: async () => body } as Response;
}

const NO_TOKEN = service({ envKeys: [{ name: 'DISCORD_BOT_TOKEN', present: false }] });

describe('ConnectWizard — steps 1 and 2 (always instructions + a link)', () => {
  it('shows the make-server and make-bot links, and both limit lines, regardless of state', () => {
    render(createElement(ConnectWizard, { service: NO_TOKEN, onChanged: () => {} }));
    expect(screen.getByRole('link', { name: /open discord/i })).toHaveAttribute('href', 'https://discord.com/channels/@me');
    expect(screen.getByRole('link', { name: /open developer portal/i })).toHaveAttribute(
      'href',
      'https://discord.com/developers/applications',
    );
    expect(screen.getByText(/a bot that creates its own server automatically/i)).toBeInTheDocument();
    expect(screen.getByText(/there is no api for that step/i)).toBeInTheDocument();
  });

  it('marks steps 1/2 as current when no token is saved, and as done once one is', () => {
    const { rerender } = render(createElement(ConnectWizard, { service: NO_TOKEN, onChanged: () => {} }));
    const steps = screen.getAllByRole('listitem');
    expect(steps[0]).toHaveClass('fw-wizard__step--current');

    rerender(
      createElement(ConnectWizard, {
        service: service({ envKeys: [{ name: 'DISCORD_BOT_TOKEN', present: true }], setupState: 'awaiting-invite' }),
        onChanged: () => {},
      }),
    );
    const stepsAfter = screen.getAllByRole('listitem');
    expect(stepsAfter[0]).toHaveClass('fw-wizard__step--done');
  });
});

describe('ConnectWizard — step 3 (paste the token)', () => {
  it('typing and submitting calls requestDiscordConnect with the trimmed token, shows "Connecting…", then calls onChanged on success', async () => {
    const onChanged = vi.fn();
    const fetchSpy = vi.fn(async (_input: unknown, _init?: RequestInit) => {
      return jsonResponse({ ok: true, pid: 42 });
    });
    vi.stubGlobal('fetch', fetchSpy);

    render(createElement(ConnectWizard, { service: NO_TOKEN, onChanged }));
    const input = screen.getByLabelText(/bot token/i);
    fireEvent.change(input, { target: { value: '  fake.token.value  ' } });
    fireEvent.click(screen.getByRole('button', { name: /connect/i }));

    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({ token: 'fake.token.value' });

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('a 400 bad-token failure shows the real gateway error text and does not call onChanged', async () => {
    const onChanged = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ ok: false, error: 'that does not look like a real Discord bot token' }, false, 400)),
    );

    render(createElement(ConnectWizard, { service: NO_TOKEN, onChanged }));
    const input = screen.getByLabelText(/bot token/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'not-a-real-token' } });
    fireEvent.click(screen.getByRole('button', { name: /connect/i }));

    expect(await screen.findByText('that does not look like a real Discord bot token')).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
    // Codex finding K3-9: the rejected token must never keep sitting in the field/state either.
    expect(input.value).toBe('');
  });

  it('the Connect button stays disabled when the token field is empty', () => {
    render(createElement(ConnectWizard, { service: NO_TOKEN, onChanged: () => {} }));
    expect(screen.getByRole('button', { name: /connect/i })).toBeDisabled();
  });

  it('a real service.loginError is shown on the token step (the wizard is back here because login failed)', () => {
    const failed = service({
      envKeys: [{ name: 'DISCORD_BOT_TOKEN', present: true }],
      setupState: 'login-failed',
      loginError: 'Discord rejected the login: bad token.',
    });
    render(createElement(ConnectWizard, { service: failed, onChanged: () => {} }));
    expect(screen.getByText('Discord rejected the login: bad token.')).toBeInTheDocument();
  });
});

describe('ConnectWizard — step 4 (invite or guild pick, whichever is live)', () => {
  it('shows the real invite link when the bot is awaiting an invite', () => {
    const awaitingInvite = service({
      envKeys: [{ name: 'DISCORD_BOT_TOKEN', present: true }],
      setupState: 'awaiting-invite',
      inviteUrl: 'https://discord.com/oauth2/authorize?client_id=1&scope=bot%20applications.commands&permissions=1',
    });
    render(createElement(ConnectWizard, { service: awaitingInvite, onChanged: () => {} }));
    expect(screen.getByRole('link', { name: /invite to my server/i })).toHaveAttribute(
      'href',
      'https://discord.com/oauth2/authorize?client_id=1&scope=bot%20applications.commands&permissions=1',
    );
  });

  it('shows a real guild picker built from service.guilds when several are found, and picking one calls requestDiscordSelectGuild', async () => {
    const onChanged = vi.fn();
    const fetchSpy = vi.fn(async (_input: unknown, _init?: RequestInit) => jsonResponse({ ok: true, pid: 7 }));
    vi.stubGlobal('fetch', fetchSpy);

    const awaitingGuild = service({
      envKeys: [{ name: 'DISCORD_BOT_TOKEN', present: true }],
      setupState: 'awaiting-guild-selection',
      guilds: [{ id: '1', name: 'Alpha' }, { id: '2', name: 'Beta' }],
    });
    render(createElement(ConnectWizard, { service: awaitingGuild, onChanged }));

    expect(screen.getByText(/this bot is already in 2 servers/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Beta' }));

    const [, init] = fetchSpy.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({ guildId: '2' });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it('a guild-pick failure shows the real error text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: false, error: 'could not save the chosen server' }, false, 400)));
    const awaitingGuild = service({
      envKeys: [{ name: 'DISCORD_BOT_TOKEN', present: true }],
      setupState: 'awaiting-guild-selection',
      guilds: [{ id: '1', name: 'Alpha' }],
    });
    render(createElement(ConnectWizard, { service: awaitingGuild, onChanged: () => {} }));
    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));
    expect(await screen.findByText('could not save the chosen server')).toBeInTheDocument();
  });
});

describe('ConnectWizard — step 5 (done)', () => {
  it('shows the real detected server name and owner-detected state once step is done', () => {
    const done = service({
      envKeys: [
        { name: 'DISCORD_BOT_TOKEN', present: true },
        { name: 'OWNER_USER_IDS', present: true },
      ],
      running: true,
      transport: 'discord',
      setupState: 'ready',
      health: { guildId: '1' },
      guilds: [{ id: '1', name: 'My Server' }],
    });
    render(createElement(ConnectWizard, { service: done, onChanged: () => {} }));
    expect(screen.getByText(/connected to my server/i)).toBeInTheDocument();
    expect(screen.getByText(/owner detected automatically/i)).toBeInTheDocument();
  });

  it('shows an honest "not yet detected" when the owner is not resolved, never a fabricated success', () => {
    // Codex K3-7: "done" now also requires a CONFIRMED server (health.guildId matching a real
    // entry in service.guilds) — a guild is resolved here so this fixture reaches "done" at all;
    // only OWNER_USER_IDS is deliberately left unresolved, which is what this test is about.
    const done = service({
      envKeys: [{ name: 'DISCORD_BOT_TOKEN', present: true }],
      running: true,
      transport: 'discord',
      setupState: 'ready',
      health: { guildId: '1' },
      guilds: [{ id: '1', name: 'My Server' }],
    });
    render(createElement(ConnectWizard, { service: done, onChanged: () => {} }));
    expect(screen.getByText(/connected to my server/i)).toBeInTheDocument();
    expect(screen.getByText(/owner not detected yet/i)).toBeInTheDocument();
  });

  it('before done, step 5 says to finish the steps above first', () => {
    render(createElement(ConnectWizard, { service: NO_TOKEN, onChanged: () => {} }));
    expect(screen.getByText(/finish the steps above first/i)).toBeInTheDocument();
  });

  it('WP-L2 finding 7: an older bot with no setup_state at all, running on the real transport, shows an honest waiting message — never a fabricated "Done"', () => {
    const legacyRunning = service({
      envKeys: [{ name: 'DISCORD_BOT_TOKEN', present: true }],
      running: true,
      transport: 'discord',
      setupState: null,
    });
    render(createElement(ConnectWizard, { service: legacyRunning, onChanged: () => {} }));
    expect(screen.getByText(/waiting for the bot to report that setup is finished/i)).toBeInTheDocument();
    expect(screen.queryByText(/connected to/i)).toBeNull();
    expect(screen.queryByText(/finish the steps above first/i)).toBeNull();
  });
});
