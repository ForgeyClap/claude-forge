// WP-v290-B (beginner Discord onboarding) — invite.js: real discord.js permission-flag math,
// never a hand-typed magic number. discord.js is a real dependency of this package, so
// computeInvitePermissions() runs for real here (no network — pure local bitfield math).
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeInvitePermissions, buildInviteUrl, _flagNamesForTests } from '../src/invite.js';

test('computeInvitePermissions: matches a manually-OR\'d bitfield built from the SAME real discord.js flags', async () => {
  const { PermissionsBitField } = await import('discord.js');
  const names = _flagNamesForTests();
  assert.ok(names.length > 0);

  let expected = 0n;
  for (const name of names) {
    const value = PermissionsBitField.Flags[name];
    assert.notEqual(value, undefined, `discord.js must know the flag "${name}"`);
    expected |= value;
  }

  const permissions = await computeInvitePermissions();
  assert.equal(typeof permissions, 'string');
  assert.equal(permissions, expected.toString(), 'the computed value must equal the real flags OR-ed together, never a hand-typed number');
});

test('computeInvitePermissions: the baseline flag list includes every permission this codebase actually uses', () => {
  const names = _flagNamesForTests();
  // The owner's explicit baseline (see invite.js header comment for why each is here).
  for (const required of [
    'ViewChannel',
    'SendMessages',
    'ReadMessageHistory',
    'ManageChannels',
    'EmbedLinks',
    'AttachFiles',
    'SendMessagesInThreads',
    'CreatePublicThreads',
    'AddReactions',
  ]) {
    assert.ok(names.includes(required), `missing baseline flag: ${required}`);
  }
  // Found by inspection (transport/discord.js's purge() calls channel.bulkDelete(), which is a
  // real Manage Messages permission) — not part of the owner's literal baseline list, but real
  // code depends on it, so it must be included too.
  assert.ok(names.includes('ManageMessages'), 'purge() calls bulkDelete(), which needs Manage Messages');
});

test('buildInviteUrl: builds the real OAuth2 authorize URL shape with client_id + both scopes + the given permissions', () => {
  const url = buildInviteUrl('998877665544332211', '12345');
  assert.equal(
    url,
    'https://discord.com/oauth2/authorize?client_id=998877665544332211&scope=bot%20applications.commands&permissions=12345',
  );
});

test('buildInviteUrl: an unknown/absent application id returns null rather than a broken URL', () => {
  assert.equal(buildInviteUrl(null, '12345'), null);
  assert.equal(buildInviteUrl(undefined, '12345'), null);
  assert.equal(buildInviteUrl('', '12345'), null);
});
