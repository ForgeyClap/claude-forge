import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ForgeDiscordGateway } from '../src/gateway.js';
import { MockTransport } from '../src/transport/mock.js';
import { createFakeRunner, abortableDelay } from '../src/runner-fake.js';
import { IngressQueue, QueueState } from '../src/queue.js';
import { AuditLedger, redactSecrets, redactDeep } from '../src/audit.js';
import { describeConfig } from '../src/config.js';
import { guardRequest } from '../src/local-guard.js';
import { PermissionGateway } from '../src/permissions.js';
import { friendlyError } from '../src/friendly-error.js';
import { buildDenyRules, ensureProjectSettings } from '../src/write-boundary.js';
import { tmpStateDir, baseConfig } from './helpers.js';

function build({ runner } = {}) {
  const transport = new MockTransport();
  const gateway = new ForgeDiscordGateway({
    config: baseConfig(tmpStateDir()),
    transport,
    runner: runner ?? createFakeRunner({ delayMs: 10 }),
  });
  gateway.router.registerProject({ projectId: 'projA', name: 'A', forumChannelId: 'chanA' });
  return { transport, gateway };
}
const say = (transport, content, over = {}) =>
  transport.simulateIncoming({ threadId: 'tA1', channelId: 'chanA', senderId: 'owner1', content, ...over });

// ─── HIGH: geslaagde run mag niet FAILED worden als het versturen faalt ───
test('een geslaagde run blijft COMPLETED als het versturen van het antwoord faalt', async () => {
  const { transport, gateway } = build();
  transport.failNextSend = 99; // elke send faalt
  const msg = say(transport, 'doe iets');
  await gateway.whenIdle();
  const item = gateway.queue.byMessageId(msg.messageId);
  assert.equal(item.state, QueueState.COMPLETED, 'run was geslaagd en moet dat blijven');
  assert.equal(item.attempts, 0, 'geen mislukte poging registreren voor een geslaagde run');
  const failed = gateway.audit.readAll().filter((e) => e.type === 'delivery_failed');
  assert.equal(failed.length, 1, 'afleverfout wordt wel eerlijk gelogd');
});

test('een afgeronde opdracht kan niet meer naar FAILED terugvallen', () => {
  const q = new IngressQueue({ stateDir: tmpStateDir() });
  const { item } = q.enqueue({ messageId: 'm1', threadId: 't1', senderId: 'o', content: 'x' });
  q.markStarting(item.id);
  q.markRunning(item.id, 'run1');
  q.markCompleted(item.id);
  q.markFailed(item.id, 'send mislukt');
  assert.equal(q.getItem(item.id).state, QueueState.COMPLETED);
  assert.equal(q.getItem(item.id).attempts, 0);
});

test('DEAD_LETTER kan opnieuw in de wachtrij (niet onherstelbaar vanaf de telefoon)', () => {
  const q = new IngressQueue({ stateDir: tmpStateDir(), maxAttempts: 1 });
  const { item } = q.enqueue({ messageId: 'm1', threadId: 't1', senderId: 'o', content: 'x' });
  q.markFailed(item.id, 'boem');
  assert.equal(q.getItem(item.id).state, QueueState.DEAD_LETTER);
  q.requeue(item.id);
  assert.equal(q.getItem(item.id).state, QueueState.QUEUED);
  assert.equal(q.getItem(item.id).attempts, 0);
});

test('prune ruimt oude afgeronde items op, houdt open items', () => {
  const dir = tmpStateDir();
  let now = 1_000_000_000;
  const q = new IngressQueue({ stateDir: dir, now: () => now, maxQueuedPerThread: 200 });
  for (let i = 0; i < 60; i += 1) {
    const { item } = q.enqueue({ messageId: `m${i}`, threadId: 't1', senderId: 'o', content: 'x' });
    if (i < 55) {
      q.markStarting(item.id);
      q.markRunning(item.id, `r${i}`);
      q.markCompleted(item.id);
    }
  }
  now += 8 * 24 * 3600 * 1000;
  const removed = q.prune();
  assert.ok(removed > 0);
  assert.equal(q.items.filter((i) => i.state === QueueState.QUEUED).length, 5, 'open items blijven');
});

// ─── HIGH: stop meldt zich, fout pingt ───
test('/forge stop zet het statusbericht op gestopt (geen eeuwig "bezig")', async () => {
  const { transport, gateway } = build({
    runner: async ({ signal }) => {
      await abortableDelay(60_000, signal);
      return { answer: 'nooit' };
    },
  });
  say(transport, 'lange klus');
  await new Promise((r) => setTimeout(r, 20));
  gateway.stop('tA1');
  await gateway.whenIdle();
  assert.ok(transport.edits.some((e) => e.content.includes('Gestopt')), 'statusbericht is bijgewerkt');
  assert.equal(gateway.runStatus.messages.size, 0, 'geen lekkende state na stop');
});

test('een mislukte run geeft een ping met item-id en retry-hint', async () => {
  const { transport, gateway } = build({
    runner: async () => { throw new Error('claude exit 1: iets ging mis'); },
  });
  say(transport, 'faal');
  await gateway.whenIdle();
  const ping = transport.sent.find((m) => m.content.includes('Mislukt') && m.content.includes('<@owner1>'));
  assert.ok(ping, 'fout krijgt een echte ping (edits geven geen notificatie)');
  assert.ok(ping.content.includes('/forge retry'), 'met een manier om het opnieuw te proberen');
});

test('foutmeldingen worden begrijpelijk Nederlands', () => {
  assert.equal(friendlyError(new Error('runner timeout na 1800000ms')), 'tijd op na 30 minuten');
  assert.ok(friendlyError(new Error('spawn claude ENOENT')).includes('niet gevonden'));
  assert.ok(friendlyError(new Error('429 rate limit')).includes('rate limit'));
  const fakeToken = ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GaBcDe', 'aBcDeFgHiJkLmNoPqRsTuVwXyZ012345'].join('.'); // zie misc.test.js
  assert.equal(friendlyError(new Error('token=' + fakeToken)).includes('MTIz'), false);
});

// ─── HIGH: fout/vraag-bolletje blijft staan ───
test('fout-bolletje wordt niet meteen door groen overschreven', async () => {
  let ronde = 0;
  const { transport, gateway } = build({
    runner: async () => {
      ronde += 1;
      return { answer: ronde === 1 ? 'STATUS: FOUT\nkon het niet afmaken' : 'STATUS: OK\ngelukt' };
    },
  });
  say(transport, 'iets');
  await gateway.whenIdle();
  const prefixes = (transport.channelPrefixes ?? []).map((p) => p.emoji);
  assert.equal(prefixes.includes('🟢'), false, 'geen groen na een fout');
  assert.deepEqual(prefixes, ['🟠'], 'het kanaal toont de fout');
  assert.equal(gateway.stickyState.get('tA1'), 'error');
  // Nieuwe opdracht heft de fout op; een geslaagde run laat het weer groen worden.
  say(transport, 'opnieuw', { messageId: 'nieuw1' });
  await gateway.whenIdle();
  assert.equal(gateway.stickyState.has('tA1'), false, 'fout is opgeheven na een geslaagde run');
});

// ─── security ───
test('config-log toont geen webhook-URL of token', () => {
  const safe = describeConfig({
    ...baseConfig('/tmp/x'),
    botToken: ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GaBcDe', 'aBcDeFgHiJkLmNoPqRsTuVwXyZ012345'].join('.'),
    ownerWebhookUrl: 'https://discord.com/api/webhooks/123/geheim',
    nieuwVeldMetSecret: 'sk-ant-abcdefghijklmnop',
  });
  const txt = JSON.stringify(safe);
  assert.equal(txt.includes('geheim'), false);
  assert.equal(txt.includes('MTIz'), false);
  assert.equal(txt.includes('sk-ant'), false, 'onbekende velden komen niet in het log (allowlist)');
  assert.equal(safe.ownerWebhookUrl, '***set***');
  assert.ok(safe.transport);
});

test('audit-redactie breekt niet op quotes en crasht nooit', () => {
  const ledger = new AuditLedger(path.join(tmpStateDir(), 'audit.jsonl'));
  const entry = ledger.record('command_received', { content: '/forge help password:"x', nested: { token: 'abc123456' } });
  assert.ok(entry, 'record() gooit niet');
  const all = ledger.readAll();
  assert.equal(all.length, 1);
  assert.equal(JSON.stringify(all).includes('abc123456'), false);
  assert.equal(redactDeep({ a: ['sk-ant-1234567890abc'] }).a[0].includes('sk-ant-1'), false);
});

test('webhook-URLs worden geredacteerd', () => {
  const txt = redactSecrets('kijk: https://discord.com/api/webhooks/1532/XVM1pPeiWkt0IXbBQk6frOwRB');
  assert.equal(txt.includes('XVM1pPei'), false);
  assert.ok(txt.includes('[REDACTED_WEBHOOK]'));
});

test('lokale endpoints weigeren vreemde Host- en Origin-headers', () => {
  const ok = guardRequest({ method: 'GET', headers: { host: '127.0.0.1:3987' } }, 3987);
  assert.equal(ok.ok, true);
  const badHost = guardRequest({ method: 'GET', headers: { host: 'kwaadaardig.nl' } }, 3987);
  assert.equal(badHost.ok, false);
  const csrf = guardRequest(
    { method: 'POST', headers: { host: '127.0.0.1:3987', origin: 'https://kwaadaardig.nl' } },
    3987,
  );
  assert.equal(csrf.ok, false);
  const cli = guardRequest({ method: 'POST', headers: { host: '127.0.0.1:3987' } }, 3987);
  assert.equal(cli.ok, true, 'curl/script zonder Origin mag wel');
});

test('permissie-gateway kent het bot-ID ook als dat later bekend wordt', () => {
  const transport = { botUserId: null };
  const gw = new PermissionGateway({ ownerUserIds: ['owner1'], botUserId: () => transport.botUserId });
  transport.botUserId = 'bot99'; // pas na login bekend
  assert.equal(gw.check({ senderId: 'bot99', messageId: 'm' }).allowed, false);
  assert.equal(gw.check({ senderId: 'owner1', messageId: 'm' }).allowed, true);
});

test('schrijf-grens: deny-regels dekken globale config, .env en de bot-map', () => {
  const rules = buildDenyRules({ botDir: 'C:/bot' }).join('|');
  assert.ok(rules.includes('.claude'));
  assert.ok(rules.includes('.env'));
  assert.ok(rules.includes('C:/bot'));
  const projectDir = tmpStateDir();
  const stateDir = tmpStateDir();
  const file = ensureProjectSettings(projectDir, { botDir: 'C:/bot', stateDir });
  assert.ok(file && fs.existsSync(file));
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(parsed.permissions.deny.length >= 5);
  assert.equal(ensureProjectSettings('/bestaat/niet', { stateDir }), null);
});

// ─── UX ───
test('bericht in een niet-gekoppeld kanaal geeft uitleg (geen stilte), maar spamt niet', async () => {
  const { transport, gateway } = build();
  transport.simulateIncoming({ threadId: 'tX', channelId: 'onbekend', senderId: 'owner1', content: 'hoi' });
  transport.simulateIncoming({ threadId: 'tX', channelId: 'onbekend', senderId: 'owner1', content: 'hoi 2' });
  await gateway.whenIdle();
  const hints = transport.sent.filter((m) => m.content.includes('nog niet bij een Forge-project'));
  assert.equal(hints.length, 1, 'één uitleg per 10 minuten');
});

test('te lang bericht wordt gemarkeerd afgekapt met .txt-bijlage', async () => {
  const { transport, gateway } = build({ runner: async () => ({ answer: 'Z'.repeat(9000) }) });
  say(transport, 'lang');
  await gateway.whenIdle();
  const withFile = transport.sent.find((m) => (m.files ?? []).length > 0);
  assert.ok(withFile.files[0].name.endsWith('.txt'));
  assert.ok(withFile.content.includes('bijlage'));
});
