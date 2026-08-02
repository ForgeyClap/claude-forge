import test from 'node:test';
import assert from 'node:assert/strict';
import { IngressQueue, QueueState } from '../src/queue.js';
import { tmpStateDir } from './helpers.js';

const msg = (over = {}) => ({
  messageId: over.messageId ?? `m_${Math.random().toString(36).slice(2)}`,
  guildId: 'g1',
  channelId: 'chan1',
  threadId: 'thread1',
  senderId: 'owner1',
  content: 'doe iets',
  ...over,
});

test('dedup: zelfde message-ID wordt exact één keer verwerkt', () => {
  const q = new IngressQueue({ stateDir: tmpStateDir() });
  const first = q.enqueue(msg({ messageId: 'm1' }));
  const second = q.enqueue(msg({ messageId: 'm1' }));
  assert.equal(first.accepted, true);
  assert.equal(second.accepted, false);
  assert.equal(second.duplicate, true);
  assert.equal(q.items.length, 1);
});

test('prompt ouder dan expiry vraagt bevestiging; confirm zet hem in de wachtrij', () => {
  const q = new IngressQueue({ stateDir: tmpStateDir(), expiryMs: 2 * 3600 * 1000 });
  const old = q.enqueue(msg({ receivedAt: Date.now() - 3 * 3600 * 1000 }));
  assert.equal(old.item.state, QueueState.WAITING_FOR_CONFIRMATION);
  q.confirm(old.item.id);
  assert.equal(q.getItem(old.item.id).state, QueueState.QUEUED);
});

test('max queued per thread wordt afgedwongen', () => {
  const q = new IngressQueue({ stateDir: tmpStateDir(), maxQueuedPerThread: 2 });
  assert.equal(q.enqueue(msg()).accepted, true);
  assert.equal(q.enqueue(msg()).accepted, true);
  const third = q.enqueue(msg());
  assert.equal(third.accepted, false);
  assert.equal(third.reason, 'queue_limit');
});

test('queue overleeft een procesherstart (durable state)', () => {
  const dir = tmpStateDir();
  const q1 = new IngressQueue({ stateDir: dir });
  const { item } = q1.enqueue(msg({ messageId: 'persist1' }));
  const q2 = new IngressQueue({ stateDir: dir });
  assert.ok(q2.byMessageId('persist1'));
  assert.equal(q2.byMessageId('persist1').id, item.id);
  assert.equal(q2.enqueue(msg({ messageId: 'persist1' })).duplicate, true);
});

test('FIFO met priority-override', () => {
  const q = new IngressQueue({ stateDir: tmpStateDir() });
  q.enqueue(msg({ messageId: 'a', content: 'eerste' }));
  q.enqueue(msg({ messageId: 'b', content: 'tweede' }));
  assert.equal(q.nextForThread('thread1').messageId, 'a');
  q.enqueue(msg({ messageId: 'c', content: 'spoed', priority: 5 }));
  assert.equal(q.nextForThread('thread1').messageId, 'c');
});

test('herhaald falen eindigt in DEAD_LETTER na maxAttempts', () => {
  const q = new IngressQueue({ stateDir: tmpStateDir(), maxAttempts: 2 });
  const { item } = q.enqueue(msg());
  q.markFailed(item.id, 'boom');
  assert.equal(q.getItem(item.id).state, QueueState.FAILED);
  q.requeue(item.id);
  q.markFailed(item.id, 'boom2');
  assert.equal(q.getItem(item.id).state, QueueState.DEAD_LETTER);
});
