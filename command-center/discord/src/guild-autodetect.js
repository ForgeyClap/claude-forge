// WP-v290-B (beginner Discord onboarding) — pure decision logic for "which server, which owner".
// Deliberately has NO network/discord.js dependency at all: main.js gathers the real guild list
// from the already-logged-in client (`client.guilds.cache`) and passes plain {id,name,ownerId}
// objects in here, so this whole module is testable with plain fixtures, no live Discord needed.

/**
 * @typedef {{ id: string, name: string, ownerId?: string | null }} GuildInfo
 */

/**
 * Decides what (if anything) can be auto-resolved for DISCORD_GUILD_ID.
 *  - already configured -> keep it, nothing to detect.
 *  - the bot is in exactly one server -> auto-pick it.
 *  - the bot is in zero servers -> nothing to pick yet; the owner still needs to use the invite link.
 *  - the bot is in several servers -> nothing to pick automatically; the owner must choose.
 * @param {readonly GuildInfo[]} guilds real guilds the bot's own client reported after login
 * @param {string | null | undefined} currentGuildId the already-configured value (if any)
 * @returns {{ guildId: string | null, phase: 'awaiting-invite' | 'awaiting-guild-selection' | null }}
 */
export function resolveGuild(guilds, currentGuildId) {
  if (typeof currentGuildId === 'string' && currentGuildId.length > 0) {
    return { guildId: currentGuildId, phase: null };
  }
  if (guilds.length === 1) return { guildId: guilds[0].id, phase: null };
  if (guilds.length === 0) return { guildId: null, phase: 'awaiting-invite' };
  return { guildId: null, phase: 'awaiting-guild-selection' };
}

/**
 * Decides the Forge owner allowlist when it is still empty: the person who created the server is
 * its `ownerId` — exactly one person, matching the owner's own stated reasoning ("that person
 * created the server, so they are the Forge owner"). Returns `null` when there is nothing new to
 * set (already configured, no matching guild, or the guild has no known ownerId), so the caller
 * can tell "nothing changed" apart from "resolved to a real value".
 * @param {GuildInfo | null | undefined} guild the resolved guild, or null when not yet known
 * @param {readonly string[]} currentOwnerUserIds the already-configured allowlist (if any)
 * @returns {readonly string[] | null}
 */
export function resolveOwner(guild, currentOwnerUserIds) {
  if (Array.isArray(currentOwnerUserIds) && currentOwnerUserIds.length > 0) return null;
  if (!guild || typeof guild.ownerId !== 'string' || guild.ownerId.length === 0) return null;
  return [guild.ownerId];
}
