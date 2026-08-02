import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ForgeDiscordGateway } from '../src/gateway.js';
import { MockTransport } from '../src/transport/mock.js';
import { createFakeRunner } from '../src/runner-fake.js';
import { buildArgs, MODELS, EFFORTS } from '../src/runner-claude.js';
import { UsageTracker } from '../src/usage-tracker.js';
import { ProjectSync } from '../src/project-sync.js';
import { ChannelIndicator } from '../src/channel-indicator.js';
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
const say = (transport, content) =>
  transport.simulateIncoming({ threadId: 'tA1', channelId: 'chanA', senderId: 'owner1', content });

test('model + effort per project instelbaar en beland in de CLI-args', async () => {
  const { transport, gateway } = build();
  say(transport, '/forge model sonnet');
  say(transport, '/forge effort high');
  await gateway.whenIdle();
  const p = gateway.router.projects.find((x) => x.projectId === 'projA');
  assert.equal(p.model, 'sonnet');
  assert.equal(p.effort, 'high');
  const args = buildArgs({ model: p.model, effort: p.effort });
  assert.ok(args.includes('--model'));
  assert.ok(args.includes(MODELS.sonnet));
  assert.ok(args.includes('--effort'));
  assert.ok(args.includes('high'));
});

test('onbekend model/effort wordt geweigerd en toont de keuzes', async () => {
  const { transport, gateway } = build();
  say(transport, '/forge model gpt9');
  await gateway.whenIdle();
  assert.equal(gateway.router.projects.find((x) => x.projectId === 'projA').model, undefined);
  assert.ok(transport.sent.some((m) => m.content.includes('Kies uit')));
  assert.equal(buildArgs({ model: 'gpt9', effort: 'turbo' }).includes('--model'), false);
  assert.ok(EFFORTS.includes('max'));
});

test('usage: alleen echte cijfers, samenvatting per project', () => {
  const dir = tmpStateDir();
  let now = 1_000_000;
  const u = new UsageTracker({ stateDir: dir, now: () => now });
  u.record({ id: 'i1', projectId: 'projA', threadId: 't' }, { costUsd: 0.05, durationMs: 60000, usage: { input_tokens: 100, output_tokens: 50 } });
  u.record({ id: 'i2', projectId: 'projB', threadId: 't' }, { costUsd: 0.02, durationMs: 30000, usage: { input_tokens: 10, output_tokens: 5 } });
  u.record({ id: 'i3', projectId: 'projA', threadId: 't' }, { costUsd: null, durationMs: 1000 });
  const s = u.summary({ sinceMs: 3600 * 1000 });
  assert.equal(s.runs, 3);
  assert.equal(s.costUsd, 0.07);
  assert.equal(s.inputTokens, 110);
  assert.equal(s.perProject.projA.runs, 2);
  assert.equal(s.runsZonderKosten, 1);
  now += 7200 * 1000; // alles buiten het venster
  assert.equal(u.summary({ sinceMs: 3600 * 1000 }).runs, 0);
});

test('/forge usage geeft een mobiel-korte samenvatting', async () => {
  const { transport, gateway } = build();
  gateway.usage = new UsageTracker({ stateDir: tmpStateDir() });
  gateway.usage.record({ id: 'x', projectId: 'projA', threadId: 'tA1' }, { costUsd: 0.1, durationMs: 120000 });
  say(transport, '/forge usage 12');
  await gateway.whenIdle();
  const msg = transport.sent.find((m) => m.content.includes('Deze bot, laatste 12 uur'));
  assert.ok(msg);
  assert.ok(msg.content.includes('runs: 1'));
  assert.ok(msg.content.length < 1500); // mobiel-kort
});

test('statusregel van de agent wordt eruit gefilterd en stuurt het bolletje', async () => {
  const { transport, gateway } = build({
    runner: async () => ({ answer: 'STATUS: INPUT_NODIG\nIk heb je API-sleutel nodig.' }),
  });
  say(transport, 'doe iets');
  await gateway.whenIdle();
  const answer = transport.sent.find((m) => m.content.includes('API-sleutel'));
  assert.ok(answer);
  assert.equal(answer.content.includes('STATUS:'), false);
});

test('projecten zonder bestaande map worden gearchiveerd (alleen projectkanalen tellen)', async () => {
  const projectsDir = tmpStateDir();
  fs.mkdirSync(path.join(projectsDir, 'echt-project'));
  const { gateway } = build();
  gateway.router.registerProject({ projectId: 'oud-kanaal', name: 'oud', forumChannelId: 'chanOud', path: null });
  const sync = new ProjectSync({
    projectsDir,
    router: gateway.router,
    audit: gateway.audit,
    channelOps: { ensureTextChannel: async (n) => ({ channelId: `c_${n}`, created: true }) },
  });
  await sync.syncOnce({ archiveOrphans: true });
  assert.equal(gateway.router.projects.find((p) => p.projectId === 'oud-kanaal').archived, true);
  assert.equal(gateway.router.projects.find((p) => p.projectId === 'echt-project').archived, false);
  sync.stop();
});

test('indicator: kritieke status mag het laatste token gebruiken, routine niet', async () => {
  const calls = [];
  let now = 0;
  const ind = new ChannelIndicator({
    transport: { setChannelPrefix: async (c, e) => calls.push(e) },
    now: () => now,
  });
  // Capaciteit 3: bezig (kost 1) → vrij (kost 1) → nog 1 token over.
  ind.set('c1', 'busy');
  now += 9_000;
  ind.set('c1', 'busy');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, ['🔴']);
  ind.set('c1', 'idle'); // run klaar
  now += 95_000; // idle-hysterese van 90s verstreken
  ind.set('c1', 'idle'); // volgende tick (in productie doet de interne timer dit)
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, ['🔴', '🟢'], 'groen komt binnen dezelfde run, niet pas na 6 minuten');

  // Nu nog 1 token: een routine-wissel wacht, een kritieke melding gaat wél door.
  ind.set('c1', 'busy');
  now += 9_000;
  ind.set('c1', 'busy');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, ['🔴', '🟢'], 'routine wacht op budget');
  ind.set('c1', 'error');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, ['🔴', '🟢', '🟠'], 'fout mag het laatste token gebruiken');
  ind.stop();
});
