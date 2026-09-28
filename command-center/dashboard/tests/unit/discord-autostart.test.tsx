/**
 * v2.9.0 WP-DA — the Discord bot comes back by itself when the Command Center starts. Covers the parser
 * for the `autostart` block of GET /api/discord/status, the "Starts automatically" row of the Discord
 * view's Service panel, and the warning when the switch worked but the choice could not be saved.
 * Codex stop-review 2026-09-28: DA-1 (never "YES" for a bot that is not connected or whose last start
 * failed) and DA-2 (a failed save is shown, never a silent success). Same stubbed-fetch pattern as
 * `discord-view.test.tsx`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import DiscordView from '@/views/discord/DiscordView';
import { parseDiscordService, requestDiscordStop } from '@/prototype/state/gateway-discord';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const BASE_SERVICE = {
  installed: true,
  running: true,
  pid: 4242,
  started_at: '2026-09-28T09:00:00.000Z',
  transport: 'discord',
  ports: { bot: 3979, manager: null },
  health: null,
  conflict: null,
  env_keys: [{ name: 'DISCORD_BOT_TOKEN', present: true }],
  state_dir: '.data/discord/state',
  log_file: '.data/discord/discord-bot.log',
  // The bot reports setup as finished, so the view shows the classic panels (no wizard).
  setup_state: 'ready',
  guilds: [{ id: '1', name: 'My server' }],
  username: 'Forge bot',
};

/** A fully ready, will-start autostart block; each test overrides what it needs. */
function autostartBlock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    setting: true,
    setting_note: null,
    desired: null,
    desired_invalid: false,
    desired_note: null,
    ready: true,
    ready_reason: null,
    env_opt_out: false,
    conflict: null,
    effective: true,
    last: null,
    save_error: null,
    ...overrides,
  };
}

function serviceWith(autostart: Record<string, unknown> | undefined): Record<string, unknown> {
  return autostart === undefined ? { ...BASE_SERVICE } : { ...BASE_SERVICE, autostart };
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function stubStatus(service: Record<string, unknown>, stopBody?: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST' && url.includes('/api/discord/stop')) return jsonResponse(stopBody ?? { ok: true, stopped: true, remembered: true });
      if (url.includes('/api/discord/status')) return jsonResponse({ ok: true, service });
      return jsonResponse({ ok: true });
    }),
  );
}

async function rowValue(): Promise<void> {
  expect(await screen.findByText('Starts automatically')).toBeInTheDocument();
}

describe('parseDiscordService — autostart block', () => {
  it('parses the whole block verbatim, including readiness, the last start and a save error', () => {
    const s = parseDiscordService({
      service: serviceWith(
        autostartBlock({
          desired: 'running',
          last: { at: '2026-09-28T09:00:01.000Z', outcome: 'started', detail: 'started automatically (pid 4242)' },
          save_error: { at: '2026-09-28T09:05:00.000Z', desired: 'stopped', detail: 'could not save the "stopped" choice (EPERM)' },
        }),
      ),
    });
    expect(s.autostart).toEqual({
      setting: true,
      desired: 'running',
      desiredInvalid: false,
      desiredNote: null,
      ready: true,
      readyReason: null,
      envOptOut: false,
      conflict: null,
      effective: true,
      saveError: 'could not save the "stopped" choice (EPERM)',
      lastOutcome: 'started',
      lastDetail: 'started automatically (pid 4242)',
      lastAt: '2026-09-28T09:00:01.000Z',
    });
  });

  it('an older gateway without the block reads back null, never a guessed "yes"', () => {
    expect(parseDiscordService({ service: serviceWith(undefined) }).autostart).toBeNull();
  });

  it('missing readiness fields read back as not ready, never a guessed "ready"', () => {
    const s = parseDiscordService({ service: serviceWith({ setting: true, desired: 'paused', effective: true, last: null }) });
    expect(s.autostart?.desired).toBeNull();
    expect(s.autostart?.ready).toBe(false);
    expect(s.autostart?.saveError).toBeNull();
  });
});

describe('DiscordView — "Starts automatically" row', () => {
  it('YES only when it will really try, with the last start in the hint', async () => {
    stubStatus(serviceWith(autostartBlock({ last: { at: 'x', outcome: 'started', detail: 'started automatically (pid 4242)' } })));
    render(createElement(DiscordView));
    await rowValue();
    expect(screen.getByText('YES')).toBeInTheDocument();
    expect(screen.getByText(/starts by itself whenever the Command Center starts/)).toBeInTheDocument();
    expect(screen.getByText(/Last Command Center start: started automatically \(pid 4242\)\./)).toBeInTheDocument();
  });

  it('DA-1: NOT YET (never YES) while Discord is not connected, naming the reason', async () => {
    stubStatus(serviceWith(autostartBlock({ ready: false, ready_reason: 'Discord is not connected yet (no bot token saved)', effective: false })));
    render(createElement(DiscordView));
    await rowValue();
    expect(screen.getByText('NOT YET')).toBeInTheDocument();
    expect(screen.queryByText('YES')).not.toBeInTheDocument();
    expect(screen.getByText(/Discord is not connected yet \(no bot token saved\)/)).toBeInTheDocument();
  });

  it('DA-1: FAILED (never YES) when the last automatic start failed, with its reason', async () => {
    stubStatus(serviceWith(autostartBlock({ last: { at: 'x', outcome: 'failed', detail: 'no claude CLI found' } })));
    render(createElement(DiscordView));
    await rowValue();
    expect(screen.getByText('FAILED')).toBeInTheDocument();
    expect(screen.queryByText('YES')).not.toBeInTheDocument();
    expect(screen.getByText(/the last automatic start failed: no claude CLI found/)).toBeInTheDocument();
  });

  it('DA-2: UNSURE when the owner\'s last choice could not be saved', async () => {
    stubStatus(serviceWith(autostartBlock({ save_error: { at: 'x', desired: 'stopped', detail: 'could not save the "stopped" choice (EPERM)' } })));
    render(createElement(DiscordView));
    await rowValue();
    expect(screen.getByText('UNSURE')).toBeInTheDocument();
    expect(screen.getByText(/Forge could not save the "stopped" choice \(EPERM\), so after a restart the bot follows your previous choice/)).toBeInTheDocument();
  });

  it('DA-3: BLOCKED (never YES) when another program already answers on the bot port', async () => {
    stubStatus(serviceWith(autostartBlock({ conflict: 'a process is already answering on port 3979', effective: false })));
    render(createElement(DiscordView));
    await rowValue();
    expect(screen.getByText('BLOCKED')).toBeInTheDocument();
    expect(screen.queryByText('YES')).not.toBeInTheDocument();
    expect(screen.getByText(/Another program already answers on the bot's port/)).toBeInTheDocument();
  });

  it('DA-3: NO when automatic start is turned off for this Command Center process', async () => {
    stubStatus(serviceWith(autostartBlock({ env_opt_out: true, effective: false })));
    render(createElement(DiscordView));
    await rowValue();
    expect(screen.getByText('NO')).toBeInTheDocument();
    expect(screen.getByText(/turned off for this Command Center process \(CC_DISCORD_AUTOSTART=off\)/)).toBeInTheDocument();
  });

  it('NO when the owner switched the bot off themselves', async () => {
    stubStatus(serviceWith(autostartBlock({ desired: 'stopped', effective: false })));
    render(createElement(DiscordView));
    await rowValue();
    expect(screen.getByText('NO')).toBeInTheDocument();
    expect(screen.getByText(/You switched the bot off, so it stays off after a restart/)).toBeInTheDocument();
  });

  it('NO when the setting is off, naming the setting', async () => {
    stubStatus(serviceWith(autostartBlock({ setting: false, effective: false })));
    render(createElement(DiscordView));
    await rowValue();
    expect(screen.getByText('NO')).toBeInTheDocument();
    expect(screen.getByText(/Turned off in Settings \("discord-autostart"\)/)).toBeInTheDocument();
  });

  // WP-RB-CC (review finding L-2): the gateway's own last-boot detail (`discord-autostart.mjs`'s
  // real "setting is off" text, copied here verbatim — a drift between the two would fail this test)
  // used to end in "turn it on with /forge config set discord-autostart on", landing right after this
  // same view's own "Turn it on there" — two different instructions for the same action, one of them
  // a command a beginner should never be told to type. Both halves must now agree: "in Settings".
  it("L-2: the full sentence (this view + the gateway's own last-boot detail) never tells a beginner to type a command, and both halves agree on Settings", async () => {
    stubStatus(
      serviceWith(
        autostartBlock({
          setting: false,
          effective: false,
          last: { at: '2026-09-28T09:00:00.000Z', outcome: 'skipped', detail: 'the discord-autostart setting is off (turn on "Start the Discord bot automatically" in Settings)' },
        }),
      ),
    );
    render(createElement(DiscordView));
    await rowValue();
    expect(screen.getByText('NO')).toBeInTheDocument();
    const hint = screen.getByText(/Turned off in Settings \("discord-autostart"\)/);
    expect(hint.textContent).toMatch(/Turn it on there/);
    expect(hint.textContent).toMatch(/Start the Discord bot automatically" in Settings/);
    expect(hint.textContent).not.toMatch(/\/forge config/);
  });

  it('NO when the settings could not be read (the safe choice), said in plain words', async () => {
    stubStatus(serviceWith(autostartBlock({ setting: null, effective: false })));
    render(createElement(DiscordView));
    await rowValue();
    expect(screen.getByText('NO')).toBeInTheDocument();
    expect(screen.getByText(/settings could not be read right now, so the bot does not start by itself/)).toBeInTheDocument();
  });

  it('NO when the saved choice is damaged, and says how to fix it', async () => {
    stubStatus(serviceWith(autostartBlock({ desired_invalid: true, desired_note: 'the saved choice is damaged', effective: false })));
    render(createElement(DiscordView));
    await rowValue();
    expect(screen.getByText('NO')).toBeInTheDocument();
    expect(screen.getByText(/Your last on\/off choice could not be read \(the saved choice is damaged\)/)).toBeInTheDocument();
  });

  it('an older gateway shows an honest dash, not a guess', async () => {
    stubStatus(serviceWith(undefined));
    render(createElement(DiscordView));
    await rowValue();
    expect(screen.getAllByText('Not reported by the gateway.').length).toBeGreaterThan(0);
  });
});

describe('DA-2: the switch worked but the choice was not saved', () => {
  it('requestDiscordStop carries the gateway\'s own warning when remembered is false', async () => {
    const warning = 'The bot stopped, but Forge could not save that you switched it off.';
    stubStatus(serviceWith(autostartBlock()), { ok: true, stopped: true, remembered: false, warning });
    const r = await requestDiscordStop();
    expect(r).toEqual({ ok: true, stopped: true, error: null, warning });
  });

  it('a saved choice (or an older gateway) carries no warning', async () => {
    stubStatus(serviceWith(autostartBlock()), { ok: true, stopped: true });
    expect((await requestDiscordStop()).warning).toBeNull();
  });

  it('the Service panel shows the warning right after the switch is used', async () => {
    const warning = 'The bot stopped, but Forge could not save that you switched it off, so it may start again by itself.';
    stubStatus(serviceWith(autostartBlock()), { ok: true, stopped: true, remembered: false, warning });
    render(createElement(DiscordView));
    const toggle = await screen.findByRole('switch');
    fireEvent.click(toggle);
    expect(await screen.findByText(warning)).toBeInTheDocument();
  });
});
