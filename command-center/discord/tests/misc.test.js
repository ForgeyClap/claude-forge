import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
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

// C1 fix (WP-C1, 2026-09-26 laptop re-audit — coordinator flag): projectsDir's default used to be
// the maintainer's own hard-coded `C:\Users\YOU\Documents\ForgeProjects`, which does not exist on
// any other machine. It must now be derived from the CURRENT user's real home directory, with no
// other username baked in anywhere in the value.
test('config: projectsDir default carries no author-specific path and resolves under the current home directory', () => {
  const cwd = tmpStateDir();
  const cfg = loadConfig({ env: { TRANSPORT: 'mock' }, cwd });

  // The old default was a LITERAL hard-coded path (`C:\Users\YOU\Documents\ForgeProjects`) that
  // never changed regardless of who ran this code. The real regression test is not "does the
  // string contain a particular username" (on the maintainer's own machine, the CURRENT real
  // os.homedir() legitimately does) — it is "was this value actually DERIVED from the current
  // user's real home directory", which is exactly as true on the maintainer's machine as on anyone
  // else's.
  assert.ok(cfg.projectsDir.startsWith(os.homedir()), `expected "${cfg.projectsDir}" to start with the current home directory "${os.homedir()}"`);
  assert.equal(cfg.projectsDir, path.join(os.homedir(), 'Documents', 'ForgeProjects'));
  assert.equal(path.isAbsolute(cfg.projectsDir), true);

  // An explicit override still wins — this default is a fallback, never a forced path.
  const overridden = loadConfig({ env: { TRANSPORT: 'mock', FORGE_PROJECTS_DIR: path.join(cwd, 'elsewhere') }, cwd });
  assert.equal(overridden.projectsDir, path.join(cwd, 'elsewhere'));
});
