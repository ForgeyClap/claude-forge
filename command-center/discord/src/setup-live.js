// Eenmalige live-setup: verbindt met Discord, toont de kanalen van de guild,
// vindt of maakt het kanaal #forge-canary, registreert de project-mapping en
// plaatst een startbericht. Gebruik: node src/setup-live.js [bestaand-kanaal-id]
import { loadConfig } from './config.js';
import { Router } from './router.js';
import { AuditLedger } from './audit.js';
import path from 'node:path';

const config = loadConfig();
if (config.transport !== 'discord') {
  console.error('Zet TRANSPORT=discord in .env voordat je de live-setup draait.');
  process.exit(1);
}

const { Client, GatewayIntentBits, ChannelType, Events } = await import('discord.js');
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

await new Promise((resolve, reject) => {
  client.once(Events?.ClientReady ?? 'ready', resolve);
  client.login(config.botToken).catch(reject);
});
console.log(`Verbonden als bot: ${client.user.tag} (${client.user.id})`);

const guild = await client.guilds.fetch(config.guildId);
console.log(`Guild: ${guild.name} (${guild.id})\n`);

const channels = await guild.channels.fetch();
console.log('Kanalen in deze server:');
for (const ch of channels.values()) {
  if (ch) console.log(`  [type ${ch.type}] ${ch.name} — ${ch.id}`);
}

let canary = null;
const argChannelId = process.argv[2];
if (argChannelId) {
  canary = await guild.channels.fetch(argChannelId);
  if (!canary) {
    console.error(`Kanaal ${argChannelId} niet gevonden in deze guild.`);
    process.exit(1);
  }
} else {
  canary = channels.find((ch) => ch?.name === 'forge-canary') ?? null;
  if (!canary) {
    try {
      canary = await guild.channels.create({ name: 'forge-canary', type: ChannelType.GuildText });
      console.log(`\nKanaal #forge-canary aangemaakt: ${canary.id}`);
    } catch (err) {
      console.error(
        `\nKon geen kanaal aanmaken (${err.message}). Maak zelf een tekstkanaal en draai:` +
          '\n  node src/setup-live.js <kanaal-id>',
      );
      process.exit(1);
    }
  } else {
    console.log(`\nBestaand kanaal #forge-canary gevonden: ${canary.id}`);
  }
}

const audit = new AuditLedger(path.join(config.stateDir, 'audit.jsonl'));
const router = new Router({ stateDir: config.stateDir, audit });
router.registerProject({ projectId: 'proj-canary', name: 'Forge Canary', forumChannelId: canary.id });
console.log(`Mapping geregistreerd: proj-canary → #${canary.name} (${canary.id})`);

await canary.send(
  'Forge canary-bot verbonden ✅ — start de service (`node src/main.js`) en stuur hier je eerste prompt. `/forge help` voor commando\'s.',
);
console.log('Startbericht geplaatst. Setup klaar.');
await client.destroy();
