import test from 'node:test';
import assert from 'node:assert/strict';
import { ForgeDiscordGateway } from '../src/gateway.js';
import { MockTransport } from '../src/transport/mock.js';
import { createFakeRunner, abortableDelay } from '../src/runner-fake.js';
import { QueueState } from '../src/queue.js';
import { tmpStateDir, baseConfig } from './helpers.js';

function build({ runner } = {}) {
  const transport = new MockTransport();
  const gateway = new ForgeDiscordGateway({
    config: baseConfig(tmpStateDir()),
    transport,
    runner: runner ?? createFakeRunner({ delayMs: 5 }),
  });
  gateway.router.registerProject({ projectId: 'projA', name: 'A', forumChannelId: 'chanA' });
  return { transport, gateway };
}

const say = (transport, content, over = {}) =>
  transport.simulateIncoming({
    threadId: 'tA1',
    channelId: 'chanA',
    senderId: 'owner1',
    content,
    ...over,
  });

test('commando: /forge status antwoordt en gaat niet de wachtrij in', async () => {
  const { transport, gateway } = build();
  say(transport, '/forge status');
  await gateway.whenIdle();
  assert.equal(gateway.queue.items.length, 0);
  assert.ok(transport.sent.some((m) => m.content.startsWith('Status —')));
});

test('commando: /forge stop annuleert de actieve run', async () => {
  const { transport, gateway } = build({
    runner: async ({ signal }) => {
      await abortableDelay(60_000, signal);
      return { answer: 'nooit' };
    },
  });
  const msg = say(transport, 'lange taak');
  assert.equal(gateway.scheduler.activeCount(), 1);
  say(transport, '/forge stop');
  await gateway.whenIdle();
  assert.equal(gateway.queue.byMessageId(msg.messageId).state, QueueState.CANCELLED);
  assert.ok(transport.sent.some((m) => m.content.includes('Run gestopt')));
});

test('commando: /forge confirm voert een oude opdracht alsnog uit (prefix-match)', async () => {
  const { transport, gateway } = build();
  const old = say(transport, 'oude taak', { timestamp: Date.now() - 5 * 3600 * 1000 });
  await gateway.whenIdle();
  const item = gateway.queue.byMessageId(old.messageId);
  assert.equal(item.state, QueueState.WAITING_FOR_CONFIRMATION);
  say(transport, `/forge confirm ${item.id.slice(0, 10)}`);
  await gateway.whenIdle();
  assert.ok(transport.sent.some((m) => m.content.includes('Echo: oude taak')));
});

test('commando: /forge help en onbekend commando geven het overzicht', async () => {
  const { transport, gateway } = build();
  say(transport, '/forge help');
  say(transport, '/forge watdanook');
  await gateway.whenIdle();
  const helps = transport.sent.filter((m) => m.content.includes('Forge-commando'));
  assert.equal(helps.length, 2);
});

test('commando: /forge remove haalt een wachtend item uit de rij', async () => {
  const { transport, gateway } = build({
    runner: async ({ signal }) => {
      await abortableDelay(60_000, signal);
      return { answer: 'nooit' };
    },
  });
  say(transport, 'run 1');
  const queued = say(transport, 'run 2 (wachtend)');
  const item = gateway.queue.byMessageId(queued.messageId);
  assert.equal(item.state, QueueState.QUEUED);
  say(transport, `/forge remove ${item.id.slice(0, 10)}`);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(gateway.queue.byMessageId(queued.messageId).state, QueueState.CANCELLED);
  gateway.shutdown();
  await gateway.whenIdle();
});
