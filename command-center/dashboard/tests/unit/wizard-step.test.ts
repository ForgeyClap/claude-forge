/**
 * wizard-step.ts — WP-v290-B (beginner Discord onboarding). Pure logic, no React, no network:
 * plain `DiscordService` fixtures built from `EMPTY_DISCORD_SERVICE` so every test only overrides
 * what it actually cares about.
 */
import { describe, expect, it } from 'vitest';
import { EMPTY_DISCORD_SERVICE } from '@/prototype/state/gateway-discord';
import type { DiscordService } from '@/prototype/state/gateway-discord';
import { computeWizardStep, findConnectedGuildName, ownerDetected } from '@/views/discord/wizard-step';

function service(overrides: Partial<DiscordService>): DiscordService {
  return { ...EMPTY_DISCORD_SERVICE, ...overrides };
}

const TOKEN_PRESENT = [{ name: 'DISCORD_BOT_TOKEN', present: true }];
const TOKEN_ABSENT = [{ name: 'DISCORD_BOT_TOKEN', present: false }];

describe('computeWizardStep', () => {
  it('no token saved yet -> "token", regardless of anything else', () => {
    expect(computeWizardStep(service({ envKeys: TOKEN_ABSENT, running: true, transport: 'discord', setupState: 'ready' }))).toBe(
      'token',
    );
    expect(computeWizardStep(service({ envKeys: [] }))).toBe('token');
  });

  it('a login failure sends the wizard back to "token", even though a token IS saved', () => {
    expect(computeWizardStep(service({ envKeys: TOKEN_PRESENT, setupState: 'login-failed' }))).toBe('token');
  });

  it('token saved, bot in zero servers -> "invite"', () => {
    expect(computeWizardStep(service({ envKeys: TOKEN_PRESENT, setupState: 'awaiting-invite' }))).toBe('invite');
  });

  it('token saved, bot in 2+ servers, none chosen -> "guild"', () => {
    expect(computeWizardStep(service({ envKeys: TOKEN_PRESENT, setupState: 'awaiting-guild-selection' }))).toBe('guild');
  });

  it('token saved, really running on the real transport, phase "ready" AND a confirmed server -> "done"', () => {
    expect(
      computeWizardStep(
        service({
          envKeys: TOKEN_PRESENT,
          running: true,
          transport: 'discord',
          setupState: 'ready',
          health: { guildId: '1' },
          guilds: [{ id: '1', name: 'My Server' }],
        }),
      ),
    ).toBe('done');
  });

  it('Codex K3-7: phase "ready" but NO confirmed server yet -> still "invite", never a premature "done"', () => {
    expect(
      computeWizardStep(service({ envKeys: TOKEN_PRESENT, running: true, transport: 'discord', setupState: 'ready', guilds: [] })),
    ).toBe('invite');
  });

  it('WP-L2 finding 7 (Codex): an older bot with no setup_state at all (null), running on the real transport -> "awaiting-setup", never a premature "done"', () => {
    // This used to read as "done" on that signal alone — but the process being alive on the real
    // transport is not the same claim as setup actually being finished (an old bot could still be
    // mid-boot, still resolving its guild, or genuinely stuck). See the honest waiting state below.
    expect(
      computeWizardStep(service({ envKeys: TOKEN_PRESENT, running: true, transport: 'discord', setupState: null })),
    ).toBe('awaiting-setup');
  });

  it('Codex K3-7: a NEWER bot reporting a real in-progress phase (connecting/reconciling/syncing-projects) is NEVER shown as "done" merely because the process is alive on the real transport', () => {
    for (const phase of ['connecting', 'reconciling', 'syncing-projects']) {
      expect(
        computeWizardStep(service({ envKeys: TOKEN_PRESENT, running: true, transport: 'discord', setupState: phase, guilds: [] })),
      ).toBe('invite');
      // Even with a confirmed guild already resolved, a real non-ready phase still means setup is
      // not finished — health.phase is the honest signal here, not the presence of a guild id.
      expect(
        computeWizardStep(
          service({
            envKeys: TOKEN_PRESENT,
            running: true,
            transport: 'discord',
            setupState: phase,
            health: { guildId: '1' },
            guilds: [{ id: '1', name: 'My Server' }],
          }),
        ),
      ).toBe('invite');
    }
  });

  it('an unrecognised FUTURE phase string this wizard has never seen is treated as not-yet-ready, never "done"', () => {
    expect(
      computeWizardStep(
        service({ envKeys: TOKEN_PRESENT, running: true, transport: 'discord', setupState: 'some-future-phase-nobody-wrote-yet', guilds: [] }),
      ),
    ).toBe('invite');
  });

  it('token saved but not running on the real transport yet -> "invite" (harmless to look at while reconnecting)', () => {
    expect(computeWizardStep(service({ envKeys: TOKEN_PRESENT, running: false, transport: 'mock', setupState: null }))).toBe(
      'invite',
    );
    expect(computeWizardStep(service({ envKeys: TOKEN_PRESENT, running: true, transport: 'mock', setupState: null }))).toBe(
      'invite',
    );
  });

  it('WP-L2 finding 7: an already-connected pre-WP-v290-B fixture (transport=discord, running, no setup_state at all) now reads as "awaiting-setup", not a fabricated "done"', () => {
    // Exactly the shape discord-view.test.tsx's own RUNNING_SERVICE fixture uses. Before finding 7's
    // fix this read as "done" purely because the process was alive on the real transport — corrected
    // to the honest "awaiting-setup" wait state, since aliveness alone never proved setup finished.
    expect(
      computeWizardStep(
        service({
          envKeys: [
            { name: 'DISCORD_BOT_TOKEN', present: true },
            { name: 'DISCORD_GUILD_ID', present: false },
          ],
          running: true,
          transport: 'discord',
          setupState: null,
        }),
      ),
    ).toBe('awaiting-setup');
  });

  it('WP-L2 finding 7: "awaiting-setup" (setupState null) is distinct from "invite" (not yet running on the real transport at all)', () => {
    expect(
      computeWizardStep(service({ envKeys: TOKEN_PRESENT, running: false, transport: 'mock', setupState: null })),
    ).toBe('invite');
    expect(
      computeWizardStep(service({ envKeys: TOKEN_PRESENT, running: true, transport: 'discord', setupState: null })),
    ).toBe('awaiting-setup');
  });
});

describe('findConnectedGuildName', () => {
  it('matches health.guildId against the real guilds list', () => {
    const s = service({
      health: { guildId: '2' },
      guilds: [{ id: '1', name: 'Alpha' }, { id: '2', name: 'Beta' }],
    });
    expect(findConnectedGuildName(s)).toBe('Beta');
  });

  it('no health.guildId -> null, never a guess', () => {
    expect(findConnectedGuildName(service({ health: null, guilds: [{ id: '1', name: 'Alpha' }] }))).toBeNull();
    expect(findConnectedGuildName(service({ health: {}, guilds: [{ id: '1', name: 'Alpha' }] }))).toBeNull();
  });

  it('a guildId with no matching entry in guilds -> null, never a fabricated name', () => {
    expect(findConnectedGuildName(service({ health: { guildId: '999' }, guilds: [{ id: '1', name: 'Alpha' }] }))).toBeNull();
  });
});

describe('ownerDetected', () => {
  it('true when OWNER_USER_IDS is present', () => {
    expect(ownerDetected(service({ envKeys: [{ name: 'OWNER_USER_IDS', present: true }] }))).toBe(true);
  });

  it('false when OWNER_USER_IDS is missing or explicitly not present', () => {
    expect(ownerDetected(service({ envKeys: [{ name: 'OWNER_USER_IDS', present: false }] }))).toBe(false);
    expect(ownerDetected(service({ envKeys: [] }))).toBe(false);
  });
});
