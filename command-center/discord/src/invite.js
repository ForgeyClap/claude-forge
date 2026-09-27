// WP-v290-B (beginner Discord onboarding) — builds the bot's OAuth2 invite URL from REAL
// discord.js permission flags, never a hand-typed magic number. Every flag name below is tied to
// real behavior already in this codebase; see the comment on each line. `discord.js` is a real,
// unconditional dependency of THIS package (see package.json) — dynamic import here matches the
// existing lazy-import convention already used by discord-admin.js/setup-projects.js/
// transport/discord.js (`await import('discord.js')`), so this module costs nothing when unused
// (mock transport, tests that never call these two exports).
const FLAG_NAMES = [
  'ViewChannel', // discord-admin.js / setup-projects.js: the private-category permission overwrites
  'SendMessages', // every transport.send()
  'ReadMessageHistory', // fetchAll()/fetchSince()/chat-reset transcript reads
  'ManageChannels', // discord-admin.js: category + channel create/delete/setParent/setName
  'EmbedLinks', // part of the owner's specified baseline; not yet exercised by an existing send
  'AttachFiles', // transport/discord.js send(): an over-2000-char reply attaches a .txt file
  'SendMessagesInThreads',
  'CreatePublicThreads',
  'AddReactions', // part of the owner's specified baseline; not yet exercised by existing code
  'ManageMessages', // transport/discord.js purge(): channel.bulkDelete()
];

/**
 * Computes the combined permissions bitfield (as a decimal string, the shape the OAuth2 invite
 * URL's `permissions` query param expects) from the real `PermissionsBitField.Flags` values.
 * Throws if a flag name above is ever misspelled/renamed by a discord.js upgrade — fail loud
 * rather than silently invite with a wrong/missing permission.
 * @returns {Promise<string>}
 */
export async function computeInvitePermissions() {
  const { PermissionsBitField } = await import('discord.js');
  const flags = FLAG_NAMES.map((name) => {
    const value = PermissionsBitField.Flags[name];
    if (value === undefined) throw new Error(`invite.js: unknown discord.js permission flag "${name}"`);
    return value;
  });
  return new PermissionsBitField(flags).bitfield.toString();
}

/**
 * Pure, sync URL formatter — no discord.js import needed here, so callers that already computed
 * `permissions` once (main.js does this a single time at boot) can reuse it on every health-status
 * snapshot without re-touching discord.js. `scope=bot applications.commands` matches this bot's
 * real usage: guild-scoped `/forge` slash commands (see transport/discord.js's
 * `#registerSlashCommands`) plus the ordinary bot gateway connection.
 * @param {string | null | undefined} applicationId
 * @param {string} permissions
 * @returns {string | null}
 */
export function buildInviteUrl(applicationId, permissions) {
  if (typeof applicationId !== 'string' || applicationId.length === 0) return null;
  const params = `client_id=${encodeURIComponent(applicationId)}&scope=bot%20applications.commands&permissions=${encodeURIComponent(permissions)}`;
  return `https://discord.com/oauth2/authorize?${params}`;
}

/** Test-only: the exact flag-name list, so a test can assert against it without duplicating (and
 *  drifting from) the literal array above. */
export function _flagNamesForTests() {
  return [...FLAG_NAMES];
}
