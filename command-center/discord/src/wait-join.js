// Wacht tot de bot lid is van de geconfigureerde guild (via guildCreate-event
// of al aanwezig), print bevestiging en sluit af. Timeout: 15 minuten.
import { loadConfig } from './config.js';

const config = loadConfig();
const { Client, GatewayIntentBits, Events } = await import('discord.js');
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const timeout = setTimeout(() => {
  console.error('Timeout: bot is na 15 min nog geen lid van de guild.');
  client.destroy().finally(() => process.exit(1));
}, 15 * 60 * 1000);

async function done(guild) {
  clearTimeout(timeout);
  console.log(`Bot is lid van: ${guild.name} (${guild.id})`);
  await client.destroy();
  process.exit(0);
}

client.on(Events?.GuildCreate ?? 'guildCreate', (guild) => {
  if (guild.id === config.guildId) done(guild);
});

await new Promise((resolve, reject) => {
  client.once(Events?.ClientReady ?? 'ready', resolve);
  client.login(config.botToken).catch(reject);
});
const existing = client.guilds.cache.get(config.guildId);
if (existing) {
  done(existing);
} else {
  console.log(`Wachten tot de bot wordt toegevoegd aan guild ${config.guildId}…`);
}
