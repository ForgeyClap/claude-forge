// Diagnose: met welke guilds is deze bot verbonden? (helpt bij Unknown Guild)
import { loadConfig } from './config.js';

const config = loadConfig();
const { Client, GatewayIntentBits, Events } = await import('discord.js');
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

await new Promise((resolve, reject) => {
  client.once(Events?.ClientReady ?? 'ready', resolve);
  client.login(config.botToken).catch(reject);
});
console.log(`Bot: ${client.user.tag} (${client.user.id})`);
console.log(`Geconfigureerd DISCORD_GUILD_ID: ${config.guildId}`);

const guilds = await client.guilds.fetch();
if (guilds.size === 0) {
  console.log('\nDe bot zit in GEEN ENKELE server. Nodig hem uit via:');
  console.log(
    `https://discord.com/oauth2/authorize?client_id=${client.user.id}&scope=bot&permissions=309237746704`,
  );
} else {
  console.log(`\nDe bot zit in ${guilds.size} server(s):`);
  for (const g of guilds.values()) console.log(`  ${g.name} — ${g.id}`);
  console.log('\nZet het juiste ID in .env als DISCORD_GUILD_ID.');
}
await client.destroy();
