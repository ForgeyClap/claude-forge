import test from 'node:test';
import assert from 'node:assert/strict';
import { ForgeDiscordGateway } from '../src/gateway.js';
import { MockTransport } from '../src/transport/mock.js';
import { createFakeRunner, abortableDelay } from '../src/runner-fake.js';
import { QueueState } from '../src/queue.js';
import { tmpStateDir, baseConfig } from './helpers.js';

function build({ runner, configOverrides = {} } = {}) {
  const transport = new MockTransport();
  const config = baseConfig(tmpStateDir(), configOverrides);
  const gateway = new ForgeDiscordGateway({
    config,
    transport,
    runner: runner ?? createFakeRunner({ delayMs: 5 }),
  });
  gateway.router.registerProject({ projectId: 'projA', name: 'A', forumChannelId: 'chanA' });
  return { transport, gateway, config };
}

const incoming = (transport, over = {}) =>
  transport.simulateIncoming({
    threadId: 'tA1',
    channelId: 'chanA',
    senderId: 'owner1',
    content: 'bouw feature X',
    ...over,
  });

test('ACC-1: normale prompt → ack + antwoord in dezelfde thread', async () => {
  const { transport, gateway } = build();
  incoming(transport);
  await gateway.whenIdle();
  const inThread = transport.sent.filter((m) => m.threadId === 'tA1');
  assert.ok(inThread.some((m) => m.content.includes('Ontvangen') || m.content.includes('wachtrij')));
  assert.ok(inThread.some((m) => m.content.includes('Echo: bouw feature X')));
});

test('ACC-2: offline → bericht bewaard → reconcile → exact één uitvoering', async () => {
  const { transport, gateway } = build();
  transport.disconnect();
  incoming(transport, { messageId: 'offline1', content: 'offline opdracht' });
  assert.equal(gateway.queue.items.length, 0);
  transport.reconnect();
  await gateway.reconcile();
  await gateway.whenIdle();
  const echoes = transport.sent.filter((m) => m.content.includes('Echo: offline opdracht'));
  assert.equal(echoes.length, 1);
});

test('ACC-3: prompt ouder dan 2 uur vereist bevestiging vóór uitvoering', async () => {
  const { transport, gateway } = build();
  const old = incoming(transport, { timestamp: Date.now() - 6 * 3600 * 1000, content: 'oude opdracht' });
  await gateway.whenIdle();
  const item = gateway.queue.byMessageId(old.messageId);
  assert.equal(item.state, QueueState.WAITING_FOR_CONFIRMATION);
  assert.equal(transport.sent.some((m) => m.content.includes('Echo: oude opdracht')), false);
  gateway.queue.confirm(item.id);
  gateway.scheduler.tick();
  await gateway.whenIdle();
  assert.ok(transport.sent.some((m) => m.content.includes('Echo: oude opdracht')));
});

test('ACC-4: tweede prompt tijdens actieve run wacht FIFO', async () => {
  const { transport, gateway } = build({ runner: createFakeRunner({ delayMs: 40 }) });
  incoming(transport, { messageId: 'f1', content: 'eerste' });
  incoming(transport, { messageId: 'f2', content: 'tweede' });
  assert.equal(gateway.scheduler.activeCount(), 1);
  await gateway.whenIdle();
  const echoes = transport.sent
    .filter((m) => m.content.includes('Echo: '))
    .map((m) => m.content.replace('<@owner1> ', ''));
  assert.deepEqual(echoes, ['Echo: eerste', 'Echo: tweede']);
});

test('ACC-5: stop geeft echte cancellation met status CANCELLED', async () => {
  const { transport, gateway } = build({
    runner: async ({ signal }) => {
      await abortableDelay(60_000, signal);
      return { answer: 'nooit' };
    },
  });
  const msg = incoming(transport, { content: 'lange run' });
  assert.equal(gateway.scheduler.activeCount(), 1);
  assert.equal(gateway.stop('tA1'), true);
  await gateway.whenIdle();
  const item = gateway.queue.byMessageId(msg.messageId);
  assert.equal(item.state, QueueState.CANCELLED);
});

test('ACC-6: eindrapport exactly-once (summary + .txt bijlage, geen duplicate)', async () => {
  const makeReport = () => ({
    missionId: 'mis1',
    reportId: 'rep1',
    markdown: '# Eindrapport\nAlles groen.',
    summary: 'Missie afgerond.',
  });
  const { transport, gateway } = build({ runner: createFakeRunner({ delayMs: 5, makeReport }) });
  incoming(transport, { messageId: 'r1', content: 'missie' });
  await gateway.whenIdle();
  incoming(transport, { messageId: 'r2', content: 'missie' });
  await gateway.whenIdle();
  const withAttachment = transport.sent.filter((m) => (m.files ?? []).length > 0);
  assert.equal(withAttachment.length, 1);
  assert.equal(withAttachment[0].files[0].name, 'rapport-rep1.txt');
});

test('ACC-7: twee projecten tegelijk → volledige isolatie', async () => {
  const { transport, gateway } = build();
  gateway.router.registerProject({ projectId: 'projB', name: 'B', forumChannelId: 'chanB' });
  incoming(transport, { threadId: 'tA1', channelId: 'chanA', messageId: 'pa', content: 'voor A' });
  incoming(transport, { threadId: 'tB1', channelId: 'chanB', messageId: 'pb', content: 'voor B' });
  await gateway.whenIdle();
  assert.ok(transport.sent.some((m) => m.threadId === 'tA1' && m.content.includes('Echo: voor A')));
  assert.ok(transport.sent.some((m) => m.threadId === 'tB1' && m.content.includes('Echo: voor B')));
  assert.equal(gateway.queue.byMessageId('pa').projectId, 'projA');
  assert.equal(gateway.queue.byMessageId('pb').projectId, 'projB');
  assert.equal(
    transport.sent.some((m) => m.threadId === 'tA1' && m.content.includes('Echo: voor B')),
    false,
  );
});

test('ACC-8: ongeautoriseerde gebruikers, bots en webhooks worden genegeerd', async () => {
  const { transport, gateway } = build();
  incoming(transport, { senderId: 'indringer', messageId: 'x1' });
  incoming(transport, { senderId: 'anderebot', isBot: true, messageId: 'x2' });
  incoming(transport, { senderId: 'webhookje', isWebhook: true, messageId: 'x3' });
  await gateway.whenIdle();
  assert.equal(gateway.queue.items.length, 0);
  assert.equal(transport.sent.length, 0);
  const rejections = gateway.audit.readAll().filter((e) => e.type === 'message_rejected');
  assert.equal(rejections.length, 3);
});

test('ACC-9: herstart van de gateway verliest geen queue-items (durable)', async () => {
  const transport = new MockTransport();
  const config = baseConfig(tmpStateDir());
  const gateway = new ForgeDiscordGateway({
    config,
    transport,
    runner: async ({ signal }) => {
      await abortableDelay(60_000, signal);
      return { answer: 'nooit' };
    },
  });
  gateway.router.registerProject({ projectId: 'projA', name: 'A', forumChannelId: 'chanA' });
  incoming(transport, { messageId: 'restart1', content: 'na herstart' });
  incoming(transport, { messageId: 'restart2', content: 'na herstart 2' });
  // "Crash": gateway1 blijft hangen met restart1 RUNNING en restart2 QUEUED op disk.

  const transport2 = new MockTransport();
  const gateway2 = new ForgeDiscordGateway({
    config,
    transport: transport2,
    runner: createFakeRunner({ delayMs: 5 }),
  });
  // Restart-recovery: RUNNING → QUEUED; beide items daarna gewoon uitgevoerd.
  assert.ok(gateway2.queue.byMessageId('restart1'));
  assert.ok(gateway2.queue.byMessageId('restart2'));
  gateway2.scheduler.tick();
  await gateway2.whenIdle();
  assert.ok(transport2.sent.some((m) => m.content.includes('Echo: na herstart')));
  assert.ok(transport2.sent.some((m) => m.content.includes('Echo: na herstart 2')));

  // Opruimen: de "gecrashte" gateway1 volledig afsluiten zodat de event loop leegloopt.
  gateway.shutdown();
  await gateway.whenIdle();
});
