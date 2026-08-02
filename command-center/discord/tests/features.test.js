import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ForgeDiscordGateway } from '../src/gateway.js';
import { MockTransport } from '../src/transport/mock.js';
import { createFakeRunner } from '../src/runner-fake.js';
import { SessionStore } from '../src/session-store.js';
import { buildArgs, buildPrompt, parseClaudeJson } from '../src/runner-claude.js';
import { ProjectSync, slugify } from '../src/project-sync.js';
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

test('presence: rood tijdens run, groen erna; typing-indicator actief', async () => {
  const { transport, gateway } = build();
  transport.simulateIncoming({ threadId: 'tA1', channelId: 'chanA', senderId: 'owner1', content: 'werk' });
  await gateway.whenIdle();
  assert.equal(transport.presence.busy, false);
  assert.ok(transport.presenceLog.some((p) => p.busy === true));
  assert.ok(transport.typingCalls.includes('tA1'));
});

test('session-store: bewaart en wist sessies per conversatie (durable)', () => {
  const dir = tmpStateDir();
  const s1 = new SessionStore(dir);
  s1.set('conv_1', 'sess_abc');
  const s2 = new SessionStore(dir);
  assert.equal(s2.get('conv_1'), 'sess_abc');
  s2.clear('conv_1');
  assert.equal(new SessionStore(dir).get('conv_1'), null);
});

test('runner-helpers: args, forge-prefix en JSON-parsing', () => {
  assert.deepEqual(buildArgs({}), ['-p', '--output-format', 'json']);
  const validSession = 'a1b2c3d4-5e6f-7890-abcd-ef1234567890';
  assert.deepEqual(buildArgs({ sessionId: validSession, permissionMode: 'acceptEdits' }), [
    '-p', '--output-format', 'json', '--resume', validSession, '--permission-mode', 'acceptEdits',
  ]);
  // Onveilig/onjuist sessie-ID wordt geweigerd (geen command-injectie via state).
  assert.equal(buildArgs({ sessionId: 's1' }).includes('--resume'), false);
  assert.equal(buildArgs({ sessionId: 'x & calc.exe' }).includes('--resume'), false);
  assert.deepEqual(buildArgs({ permissionMode: 'default' }), ['-p', '--output-format', 'json']);
  assert.equal(buildPrompt({ content: 'bouw x', forgeMode: true }), '/forge bouw x');
  assert.equal(buildPrompt({ content: 'bouw x', forgeMode: false }), 'bouw x');
  const parsed = parseClaudeJson(JSON.stringify({ result: 'antwoord', session_id: 's9', total_cost_usd: 0.01 }));
  assert.equal(parsed.answer, 'antwoord');
  assert.equal(parsed.sessionId, 's9');
  assert.equal(parseClaudeJson('gewoon tekst').answer, 'gewoon tekst');
});

function fakeChannelOps() {
  const calls = [];
  return {
    calls,
    ensureTextChannel: async (name) => {
      calls.push(name);
      return { channelId: `chan_${name}`, created: !calls.slice(0, -1).includes(name), migrated: false };
    },
  };
}

test('project-sync: nieuwe map → kanaal + mapping met forge-detectie', async () => {
  const projectsDir = tmpStateDir();
  fs.mkdirSync(path.join(projectsDir, 'Mijn Project X'));
  fs.mkdirSync(path.join(projectsDir, 'forge-proj', '.claude', 'commands'), { recursive: true });
  fs.writeFileSync(path.join(projectsDir, 'forge-proj', '.claude', 'commands', 'forge.md'), '# forge');
  fs.mkdirSync(path.join(projectsDir, '.hidden-infra'));

  const { gateway } = build();
  const sync = new ProjectSync({
    projectsDir,
    router: gateway.router,
    audit: gateway.audit,
    channelOps: fakeChannelOps(),
  });
  const added = await sync.syncOnce();
  assert.equal(added.length, 2); // .hidden-infra overgeslagen
  const px = gateway.router.projects.find((p) => p.projectId === 'mijn-project-x');
  assert.ok(px);
  assert.equal(px.forgeMode, false);
  const fp = gateway.router.projects.find((p) => p.projectId === 'forge-proj');
  assert.equal(fp.forgeMode, true); // .claude/commands/forge.md gedetecteerd
  // tweede sync: idempotent, niets nieuws
  assert.equal((await sync.syncOnce()).length, 0);
});

test('commando: /forge newproject maakt map + kanaal aan', async () => {
  const projectsDir = tmpStateDir();
  const { transport, gateway } = build();
  gateway.projectSync = new ProjectSync({
    projectsDir,
    router: gateway.router,
    audit: gateway.audit,
    channelOps: fakeChannelOps(),
  });
  transport.simulateIncoming({
    threadId: 'tA1', channelId: 'chanA', senderId: 'owner1', content: '/forge newproject Super Bot',
  });
  await gateway.whenIdle();
  assert.ok(fs.existsSync(path.join(projectsDir, 'super-bot')));
  assert.ok(gateway.router.projects.find((p) => p.projectId === 'super-bot'));
  assert.ok(transport.sent.some((m) => m.content.includes('Project aangemaakt ✅')));
  // ongeldige naam faalt netjes
  transport.simulateIncoming({
    threadId: 'tA1', channelId: 'chanA', senderId: 'owner1', content: '/forge newproject !!',
  });
  await gateway.whenIdle();
  assert.ok(transport.sent.some((m) => m.content.includes('Aanmaken mislukt')));
});

test('commando: /forge session reset wist het gespreksgeheugen', async () => {
  const { transport, gateway } = build();
  gateway.sessionStore = new SessionStore(tmpStateDir());
  const route = gateway.router.resolveRoute({ channelId: 'chanA', threadId: 'tA1' });
  gateway.sessionStore.set(route.conversationId, 'sess_oud');
  transport.simulateIncoming({
    threadId: 'tA1', channelId: 'chanA', senderId: 'owner1', content: '/forge session reset',
  });
  await gateway.whenIdle();
  assert.equal(gateway.sessionStore.get(route.conversationId), null);
  assert.ok(transport.sent.some((m) => m.content.includes('Gespreksgeheugen gewist')));
});

test('commando: /forge write on|off schakelt schrijfmodus per project', async () => {
  const { transport, gateway } = build();
  transport.simulateIncoming({
    threadId: 'tA1', channelId: 'chanA', senderId: 'owner1', content: '/forge write on',
  });
  await gateway.whenIdle();
  assert.equal(
    gateway.router.projects.find((p) => p.projectId === 'projA').permissionMode,
    'acceptEdits',
  );
  assert.ok(transport.sent.some((m) => m.content.includes('Schrijfmodus AAN')));
  transport.simulateIncoming({
    threadId: 'tA1', channelId: 'chanA', senderId: 'owner1', content: '/forge write off',
  });
  await gateway.whenIdle();
  assert.equal(
    gateway.router.projects.find((p) => p.projectId === 'projA').permissionMode,
    'default',
  );
});

test('lange antwoorden gaan als .md-bijlage (Discord 2000-tekens-limiet)', async () => {
  const { transport, gateway } = build({
    runner: async () => ({ answer: 'X'.repeat(5000) }),
  });
  transport.simulateIncoming({ threadId: 'tA1', channelId: 'chanA', senderId: 'owner1', content: 'lang' });
  await gateway.whenIdle();
  const withFile = transport.sent.find((m) => (m.files ?? []).length > 0);
  assert.ok(withFile, 'bijlage-bericht ontbreekt');
  assert.equal(withFile.files[0].content.length, 5000);
});

test('slugify: veilige kanaalnamen', () => {
  assert.equal(slugify('Mijn Project X'), 'mijn-project-x');
  assert.equal(slugify('  --Räre__Näme!! '), 'r-re-n-me');
  assert.equal(slugify('!!'), '');
});
