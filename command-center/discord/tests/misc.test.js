import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { AuditLedger, redactSecrets } from '../src/audit.js';
import { loadConfig, describeConfig } from '../src/config.js';
import { tmpStateDir } from './helpers.js';

test('audit: Discord-token-achtige strings worden geredacteerd', () => {
  // In stukken samengesteld: bij het draaien exact hetzelfde token-vormige nep-token, maar de
  // literal staat niet in de repo (GitHub push protection ziet anders een 'Discord Bot Token').
  const fakeToken = ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GaBcDe', 'aBcDeFgHiJkLmNoPqRsTuVwXyZ012345'].join('.');
  const redacted = redactSecrets(`token=${fakeToken} en verder niks`);
  assert.equal(redacted.includes(fakeToken), false);
  assert.ok(redacted.includes('[REDACTED]'));

  const ledger = new AuditLedger(path.join(tmpStateDir(), 'audit.jsonl'));
  ledger.record('test_event', { note: `apiKey=supergeheim123` });
  const entries = ledger.readAll();
  assert.equal(JSON.stringify(entries).includes('supergeheim123'), false);
});

test('config: mock-transport werkt zonder secrets, discord-transport eist ze', () => {
  const cwd = tmpStateDir();
  const cfg = loadConfig({ env: { TRANSPORT: 'mock' }, cwd });
  assert.equal(cfg.transport, 'mock');
  assert.equal(cfg.expiryMs, 2 * 3600 * 1000);

  assert.throws(
    () => loadConfig({ env: { TRANSPORT: 'discord' }, cwd }),
    /DISCORD_BOT_TOKEN.*DISCORD_GUILD_ID.*OWNER_USER_IDS|vereist/,
  );

  const full = loadConfig({
    env: {
      TRANSPORT: 'discord',
      DISCORD_BOT_TOKEN: 'x.y.z',
      DISCORD_GUILD_ID: 'g',
      OWNER_USER_IDS: 'u1, u2',
    },
    cwd,
  });
  assert.deepEqual(full.ownerUserIds, ['u1', 'u2']);
  assert.equal(describeConfig(full).botToken, '***set***');
});
