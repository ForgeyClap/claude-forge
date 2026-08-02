import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ForgeDiscordGateway } from '../src/gateway.js';
import { MockTransport } from '../src/transport/mock.js';
import { createFakeRunner, abortableDelay } from '../src/runner-fake.js';
import { ChannelIndicator, stripIndicator } from '../src/channel-indicator.js';
import { ChatReset, formatTranscript } from '../src/chat-reset.js';
import { buildArgs } from '../src/runner-claude.js';
import { buildSystemPrompt } from '../src/mobile-profile.js';
import { tmpStateDir, baseConfig } from './helpers.js';

function build({ runner } = {}) {
  const transport = new MockTransport();
  const gateway = new ForgeDiscordGateway({
    config: baseConfig(tmpStateDir()),
    transport,
    runner: runner ?? createFakeRunner({ delayMs: 20 }),
  });
  gateway.router.registerProject({ projectId: 'projA', name: 'A', forumChannelId: 'chanA' });
  return { transport, gateway };
}

const say = (transport, content, over = {}) =>
  transport.simulateIncoming({ threadId: 'tA1', channelId: 'chanA', senderId: 'owner1', content, ...over });

test('status: één bericht per opdracht dat wordt bewerkt (geen chat-spam, juiste volgorde)', async () => {
  const { transport, gateway } = build();
  say(transport, 'doe iets');
  await gateway.whenIdle();
  // 1 statusbericht + 1 antwoordbericht = 2 (niet 3 losse meldingen)
  assert.equal(transport.sent.length, 2);
  const statusMsg = transport.sent[0];
  assert.ok(transport.edits.some((e) => e.messageId === statusMsg.messageId && e.content.includes('🔴')));
  assert.ok(transport.edits.some((e) => e.messageId === statusMsg.messageId && e.content.includes('🟢 **Klaar**')));
  // laatste bericht = antwoord mét owner-ping
  assert.ok(transport.sent[1].content.startsWith('<@owner1>'));
  assert.ok(transport.sent[1].content.includes('Echo: doe iets'));
});

test('status: volgorde klopt ook als de run direct start (geen race)', async () => {
  const { transport, gateway } = build();
  say(transport, 'snel');
  await gateway.whenIdle();
  const first = transport.sent[0].content;
  assert.ok(first.includes('Ontvangen') || first.includes('wachtrij'), `onverwacht eerste bericht: ${first}`);
});

test('lang antwoord: .txt-bijlage (mobiel leesbaar), niet .md', async () => {
  const { transport, gateway } = build({ runner: async () => ({ answer: 'Y'.repeat(4000) }) });
  say(transport, 'lang');
  await gateway.whenIdle();
  const withFile = transport.sent.find((m) => (m.files ?? []).length > 0);
  assert.ok(withFile);
  assert.ok(withFile.files[0].name.endsWith('.txt'));
  assert.equal(withFile.files[0].content.length, 4000);
});

test('kanaal-indicator: 🔴 bij bezig, 🟢 bij vrij (bij het kanaal, niet in chat)', async () => {
  const calls = [];
  let now = 0;
  const ind = new ChannelIndicator({
    transport: { setChannelPrefix: async (c, e) => calls.push(e) },
    now: () => now,
  });
  ind.set('c1', true);
  now += 9_000; // busy-hysterese gehaald
  ind.set('c1', true);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, ['🔴']);
  now += 12 * 60 * 1000; // tokens bijgevuld
  ind.set('c1', false);
  now += 95_000; // idle-hysterese gehaald
  ind.set('c1', false);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, ['🔴', '🟢']);
  ind.stop();
});

test('kanaal-indicator: korte run verspilt geen hernoem-budget (hysterese)', async () => {
  const calls = [];
  let now = 0;
  const ind = new ChannelIndicator({
    transport: { setChannelPrefix: async (c, e) => calls.push(e) },
    now: () => now,
  });
  ind.set('c1', true);
  now += 3_000; // run al klaar binnen 3s
  ind.set('c1', false);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, []); // geen enkele rename → budget intact
  ind.stop();
});

test('stripIndicator haalt emoji-prefix weg (voorkomt duplicaat-kanalen)', () => {
  assert.equal(stripIndicator('🔴littlebazzar'), 'littlebazzar');
  assert.equal(stripIndicator('🟢 littlebazzar'), 'littlebazzar');
  assert.equal(stripIndicator('littlebazzar'), 'littlebazzar');
});

test('mobiel profiel: huisregels alleen bij verse sessie, niet bij --resume', () => {
  const sp = buildSystemPrompt({});
  assert.ok(sp.includes('TELEFOON'));
  assert.ok(sp.includes('.txt'));
  assert.ok(buildArgs({ systemPrompt: sp }).includes('--append-system-prompt'));
  assert.equal(
    buildArgs({ systemPrompt: sp, sessionId: 'a1b2c3d4-5e6f-7890-abcd-ef1234567890' }).includes(
      '--append-system-prompt',
    ),
    false,
  );
  assert.ok(buildSystemPrompt({ forgeMode: true }).includes('Forge-werkwijze'));
});

function resetHarness(overrides = {}) {
  const { transport, gateway } = build(overrides.build ?? {});
  const dir = tmpStateDir();
  const reset = new ChatReset({
    transport,
    router: gateway.router,
    queue: gateway.queue,
    scheduler: gateway.scheduler,
    audit: gateway.audit,
    cursors: gateway.cursors,
    saveCursors: () => {},
    ownerUserIds: ['owner1'],
    transcriptDir: dir,
    intervalMs: 1,
  });
  return { transport, gateway, reset, dir };
}

test('chat-reset: transcript wegschrijven, wissen, ping + .txt-bijlage', async () => {
  const { transport, gateway, reset, dir } = resetHarness();
  for (let i = 0; i < 8; i += 1) say(transport, `bericht ${i}`, { messageId: `hist${i}` });
  await gateway.whenIdle();
  const res = await reset.resetChannel({ projectId: 'projA', forumChannelId: 'tA1' });
  assert.equal(res.skipped, false);
  assert.ok(fs.existsSync(res.file));
  assert.ok(res.file.endsWith('.txt'));
  assert.ok(fs.readFileSync(res.file, 'utf8').includes('bericht 3'));
  const notice = transport.sent[transport.sent.length - 1];
  assert.ok(notice.content.startsWith('<@owner1>'));
  assert.ok(notice.files[0].name.endsWith('.txt'));
  assert.equal((await transport.fetchAll('tA1')).length, 1); // alleen de nieuwe melding
  assert.equal(gateway.cursors.lastSeen.tA1 !== undefined, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('chat-reset: NOOIT resetten tijdens een lopende run (30-min-prompt blijft heel)', async () => {
  const { transport, gateway, reset } = resetHarness({
    build: {
      runner: async ({ signal }) => {
        await abortableDelay(60_000, signal);
        return { answer: 'nooit' };
      },
    },
  });
  for (let i = 0; i < 8; i += 1) say(transport, `bericht ${i}`, { messageId: `b${i}` });
  const res = await reset.resetChannel({ projectId: 'projA', forumChannelId: 'tA1' });
  assert.equal(res.skipped, true);
  assert.equal(res.reason, 'busy');
  assert.ok((await transport.fetchAll('tA1')).length > 5); // niets gewist
  gateway.shutdown();
  await gateway.whenIdle();
});

test('transcript-formaat is leesbare platte tekst met JIJ/BOT-labels', () => {
  const txt = formatTranscript(
    [
      { timestamp: 0, isBot: false, content: 'hoi' },
      { timestamp: 0, isBot: true, content: 'terug', attachments: [{ name: 'a.txt' }] },
    ],
    { projectId: 'p', channelId: 'c' },
  );
  assert.ok(txt.includes('JIJ  hoi'));
  assert.ok(txt.includes('BOT  terug'));
  assert.ok(txt.includes('bijlage: a.txt'));
});
