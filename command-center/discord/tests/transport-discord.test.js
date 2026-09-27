// WP-v290-B (beginner Discord onboarding) — DiscordTransport.reRegisterSlashCommandsForGuild():
// never opens a real network connection here — connect() itself is intentionally NOT exercised
// (that needs a real token, owner-gated). This constructs the transport directly and stubs
// `client.application.commands.set` to prove the guild-scoping behavior in isolation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DiscordTransport } from '../src/transport/discord.js';

test('reRegisterSlashCommandsForGuild: updates this.guildId and re-registers the command set scoped to the given guild', async () => {
  const transport = new DiscordTransport({ botToken: 'irrelevant-for-this-test', guildId: '' });
  assert.equal(transport.guildId, '', 'starts empty, matching a fresh onboarding connect');

  let capturedGuildId = null;
  let capturedCommandCount = null;
  transport.client = {
    application: {
      commands: {
        set: async (commands, guildId) => {
          capturedCommandCount = commands.length;
          capturedGuildId = guildId;
          return { size: commands.length };
        },
      },
    },
  };

  await transport.reRegisterSlashCommandsForGuild('123456789012345678');

  assert.equal(transport.guildId, '123456789012345678', 'the transport\'s own guildId must be updated — used by every message filter from now on');
  assert.equal(capturedGuildId, '123456789012345678', 'commands.set() must be called with the real guild id, not global');
  assert.equal(capturedCommandCount, 1, 'the real /forge command set must be re-registered, not an empty list');
});

test('reRegisterSlashCommandsForGuild: can be called again with a different guild (e.g. a corrected pick) and updates guildId again', async () => {
  const transport = new DiscordTransport({ botToken: 'irrelevant-for-this-test', guildId: 'old-guild' });
  const seenGuildIds = [];
  transport.client = {
    application: { commands: { set: async (commands, guildId) => { seenGuildIds.push(guildId); return { size: commands.length }; } } },
  };

  await transport.reRegisterSlashCommandsForGuild('first');
  await transport.reRegisterSlashCommandsForGuild('second');

  assert.deepEqual(seenGuildIds, ['first', 'second']);
  assert.equal(transport.guildId, 'second');
});
