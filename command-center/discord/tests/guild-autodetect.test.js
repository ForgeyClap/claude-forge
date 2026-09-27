// WP-v290-B (beginner Discord onboarding) — guild-autodetect.js's pure decision logic. No
// discord.js, no network: plain fixtures only, exactly the point of extracting this out of main.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveGuild, resolveOwner } from '../src/guild-autodetect.js';

const ALPHA = { id: '1', name: 'Alpha', ownerId: 'owner-1' };
const BETA = { id: '2', name: 'Beta', ownerId: 'owner-2' };

test('resolveGuild: an already-configured guildId is kept as-is, never overridden by the live list', () => {
  const result = resolveGuild([ALPHA, BETA], '999');
  assert.deepEqual(result, { guildId: '999', phase: null });
});

test('resolveGuild: exactly one real server is auto-picked', () => {
  const result = resolveGuild([ALPHA], '');
  assert.deepEqual(result, { guildId: '1', phase: null });
});

test('resolveGuild: zero servers -> awaiting-invite, nothing picked', () => {
  const result = resolveGuild([], null);
  assert.deepEqual(result, { guildId: null, phase: 'awaiting-invite' });
});

test('resolveGuild: two or more servers -> awaiting-guild-selection, nothing auto-picked', () => {
  const result = resolveGuild([ALPHA, BETA], undefined);
  assert.deepEqual(result, { guildId: null, phase: 'awaiting-guild-selection' });
});

test('resolveOwner: already-configured owners are kept, nothing overridden', () => {
  assert.equal(resolveOwner(ALPHA, ['someone-else']), null);
});

test('resolveOwner: an empty owner list resolves to [guild.ownerId] — the person who created the server', () => {
  assert.deepEqual(resolveOwner(ALPHA, []), ['owner-1']);
  assert.deepEqual(resolveOwner(BETA, []), ['owner-2']);
});

test('resolveOwner: no guild known yet (still awaiting invite/selection) resolves to null, never a guess', () => {
  assert.equal(resolveOwner(null, []), null);
  assert.equal(resolveOwner(undefined, []), null);
});

test('resolveOwner: a guild with no real ownerId resolves to null rather than an empty/fabricated owner', () => {
  assert.equal(resolveOwner({ id: '3', name: 'NoOwner' }, []), null);
  assert.equal(resolveOwner({ id: '3', name: 'NoOwner', ownerId: '' }, []), null);
});
