/**
 * wizard-step — pure step-computation for the Connect Wizard (WP-v290-B, beginner Discord
 * onboarding). No React, no fetch: a single function from the real `DiscordService` contract
 * (`gateway-discord.ts`) to "which step should the wizard show right now", so it is trivially
 * unit-testable and never guesses at UI concerns.
 *
 * ADDITIVE, NEVER REPLACING: `ConnectWizard` is rendered ABOVE the existing Service/EnvKeys/Health
 * panels, never instead of them — an already-connected owner (any `'done'` result) simply does not
 * see the wizard; the classic panels are completely unchanged (see `DiscordView.tsx`). This keeps
 * every pre-existing panel test valid untouched while still surfacing the wizard the moment it is
 * actually useful.
 */
import type { DiscordService } from '@/prototype/state/gateway-discord';

export type WizardStepKey = 'token' | 'invite' | 'guild' | 'awaiting-setup' | 'done';

/**
 * Decides which step is "current":
 *  - no real token saved yet -> 'token' (steps 1/2/3 — server, bot, paste token — are all shown as
 *    instructions/inputs at this point; there is nothing live to distinguish between "haven't made
 *    a server yet" and "haven't made the bot yet", so both are always shown as plain steps).
 *  - the LAST connection attempt failed (bad token, Message Content Intent not enabled, ...) ->
 *    back to 'token', with `service.loginError` shown as the real, plain-language reason — the fix
 *    for both of those is "paste a (corrected) token again".
 *  - a token IS saved, but the bot reports it is in zero servers -> 'invite' (step 4a).
 *  - a token IS saved, the bot is in 2+ servers and none is chosen yet -> 'guild' (step 4b).
 *  - the OLDER bot health shape that predates `setup_state` entirely (`setupState === null`) ->
 *    'awaiting-setup' once running on the real transport (Codex finding 7, WP-L2): this used to
 *    read as 'done' on that signal alone, but "the process is alive on the real transport" is not
 *    the same claim as "setup is actually finished" — an old bot could be alive and still mid-boot,
 *    still resolving its guild, or genuinely stuck. Showing an honest "waiting for the bot to
 *    report that setup is finished" beats a premature, unverifiable "Done".
 *  - a bot that DOES report `setup_state`, running on the real transport, reaches 'done' ONLY once
 *    it reports the real 'ready' phase AND a confirmed server is found in service.guilds (Codex
 *    finding K3-7) — a known in-progress phase (e.g. 'connecting'/'reconciling'/
 *    'syncing-projects', or any future phase string this wizard has never seen) must never be
 *    shown as "Done" just because the child process happens to be running on the discord
 *    transport already; the process being alive is not the same claim as setup being finished.
 *  - anything short of that confirmed-ready state -> 'invite', the same honest "use the invite
 *    link" / waiting step already shown while reconnecting — never a guess dressed up as "Done".
 */
export function computeWizardStep(service: DiscordService): WizardStepKey {
  const tokenSaved = service.envKeys.some((key) => key.name === 'DISCORD_BOT_TOKEN' && key.present);
  if (!tokenSaved) return 'token';
  if (service.setupState === 'login-failed') return 'token';
  if (service.setupState === 'awaiting-guild-selection') return 'guild';
  if (service.setupState === 'awaiting-invite') return 'invite';
  const onRealTransport = service.running && service.transport === 'discord';
  if (service.setupState === null) return onRealTransport ? 'awaiting-setup' : 'invite';
  if (service.setupState === 'ready' && onRealTransport && findConnectedGuildName(service) !== null) {
    return 'done';
  }
  return 'invite';
}

/** Whether the owner-created server has already been resolved — used to decide whether the Done
 *  step's "detected server" line has a real name to show. */
export function findConnectedGuildName(service: DiscordService): string | null {
  const guildId = service.health && typeof service.health.guildId === 'string' ? service.health.guildId : null;
  if (!guildId) return null;
  const match = service.guilds.find((g) => g.id === guildId);
  return match ? match.name : null;
}

/** Whether OWNER_USER_IDS has a real value saved — the Done step shows this as a boolean
 *  ("detected automatically"), never the raw Discord user id (same restraint env_keys already
 *  applies to every secret-shaped field). */
export function ownerDetected(service: DiscordService): boolean {
  return service.envKeys.some((key) => key.name === 'OWNER_USER_IDS' && key.present);
}
