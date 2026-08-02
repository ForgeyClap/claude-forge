import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from '../src/router.js';
import { Outbox } from '../src/outbox.js';
import { MockTransport } from '../src/transport/mock.js';
import { tmpStateDir } from './helpers.js';

test('router: stabiele project- en conversation-mapping op ID', () => {
  const r = new Router({ stateDir: tmpStateDir() });
  r.registerProject({ projectId: 'projA', name: 'Project A', forumChannelId: 'chanA' });
  const route1 = r.resolveRoute({ channelId: 'chanA', threadId: 't1' });
  const route2 = r.resolveRoute({ channelId: 'chanA', threadId: 't1' });
  assert.equal(route1.projectId, 'projA');
  assert.equal(route1.conversationId, route2.conversationId);
});

test('router: onbekend kanaal wordt genegeerd, archief blokkeert', () => {
  const r = new Router({ stateDir: tmpStateDir() });
  assert.equal(r.resolveRoute({ channelId: 'onbekend', threadId: 't1' }), null);
  r.registerProject({ projectId: 'projA', name: 'A', forumChannelId: 'chanA' });
  r.archiveProject('projA');
  assert.equal(r.resolveRoute({ channelId: 'chanA', threadId: 't2' }).archived, true);
  r.reactivateProject('projA');
  assert.equal(r.resolveRoute({ channelId: 'chanA', threadId: 't2' }).archived, false);
});

test('router: cross-project routering wordt geweigerd', () => {
  const r = new Router({ stateDir: tmpStateDir() });
  r.registerProject({ projectId: 'projA', name: 'A', forumChannelId: 'chanA' });
  r.registerProject({ projectId: 'projB', name: 'B', forumChannelId: 'chanB' });
  r.resolveRoute({ channelId: 'chanA', threadId: 't1' });
  assert.equal(r.resolveRoute({ channelId: 'chanB', threadId: 't1' }), null);
});

const report = (over = {}) => ({
  projectId: 'projA',
  missionId: 'mis1',
  reportId: 'rep1',
  reportHash: 'hash1',
  threadId: 't1',
  summary: 'Klaar',
  reportText: 'Rapport',
  ...over,
});

test('outbox: exactly-once per idempotency key', async () => {
  const transport = new MockTransport();
  const o = new Outbox({ stateDir: tmpStateDir(), transport });
  const first = await o.dispatchFinalReport(report());
  const second = await o.dispatchFinalReport(report());
  assert.equal(first.duplicate, false);
  assert.equal(first.delivery.state, 'DELIVERED');
  assert.equal(second.duplicate, true);
  assert.equal(transport.sent.length, 1);
});

test('outbox: retry na transportfout, dead-letter na maxAttempts, resend werkt', async () => {
  const transport = new MockTransport();
  const o = new Outbox({ stateDir: tmpStateDir(), transport, maxAttempts: 1 });
  transport.failNextSend = 1;
  const res = await o.dispatchFinalReport(report());
  assert.equal(res.delivery.state, 'DEAD_LETTER');
  const resent = await o.resend(res.delivery.id);
  assert.equal(resent.delivery.state, 'DELIVERED');
  assert.equal(transport.sent.length, 1);
});

test('outbox: crash mid-send wordt UNCERTAIN, nooit blind opnieuw versturen', async () => {
  const dir = tmpStateDir();
  const file = path.join(dir, 'deliveries.json');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      deliveries: [
        {
          id: 'dlv_crashed',
          key: Outbox.idempotencyKey(report()),
          reportId: 'rep1',
          threadId: 't1',
          payload: { summary: 's', reportText: 'x', dashboardLink: null },
          attempts: 1,
          state: 'SENDING',
          messageIds: [],
        },
      ],
    }),
  );
  const transport = new MockTransport();
  const o = new Outbox({ stateDir: dir, transport });
  assert.equal(o.list()[0].state, 'UNCERTAIN');
  const again = await o.dispatchFinalReport(report());
  assert.equal(again.duplicate, true);
  assert.equal(transport.sent.length, 0);
});
