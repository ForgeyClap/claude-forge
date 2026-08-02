// Lokale demo zonder Discord: laat de hele pijplijn zien met de mock-transport.
// Draaien: npm run demo
import fs from 'node:fs';
import { ForgeDiscordGateway } from './gateway.js';
import { MockTransport } from './transport/mock.js';
import { createFakeRunner } from './runner-fake.js';
import { loadConfig, describeConfig } from './config.js';

const config = loadConfig({ env: { TRANSPORT: 'mock', OWNER_USER_IDS: 'owner1', STATE_DIR: './state/demo' } });
// Demo is een wegwerp-scenario: verse state per run, anders onderdrukt de
// (bewust) durable dedup de hele flow bij een tweede run.
fs.rmSync(config.stateDir, { recursive: true, force: true });
console.log('Config:', describeConfig(config));

const transport = new MockTransport();
const gateway = new ForgeDiscordGateway({
  config,
  transport,
  runner: createFakeRunner({
    delayMs: 200,
    makeReport: (item) => ({
      missionId: 'demo-missie',
      reportId: `rep-${item.messageId}`,
      summary: 'Demo-missie afgerond ✅',
      markdown: `# Eindrapport\n\nPrompt: ${item.content}\n\nAlles groen.`,
    }),
  }),
});

gateway.router.registerProject({ projectId: 'proj-demo', name: 'Demo Project', forumChannelId: 'chan-demo' });

console.log('\n--- Owner stuurt een prompt in de projectthread ---');
transport.simulateIncoming({
  threadId: 'thread-demo-1',
  channelId: 'chan-demo',
  senderId: 'owner1',
  content: 'Bouw de landingspagina',
});

console.log('\n--- Indringer probeert hetzelfde (wordt genegeerd) ---');
transport.simulateIncoming({
  threadId: 'thread-demo-1',
  channelId: 'chan-demo',
  senderId: 'indringer',
  content: 'rm -rf alles',
});

await gateway.whenIdle();

console.log('\n--- Wat de bot in de thread heeft gepost ---');
for (const m of transport.sent) {
  console.log(`[${m.threadId}] ${m.content}${m.files?.length ? ` (+bijlage: ${m.files[0].name})` : ''}`);
}
console.log('\n--- Status ---');
console.log(JSON.stringify(gateway.status(), null, 2));
gateway.shutdown();
