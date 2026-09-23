// Richt de Discord-server in volgens plan §1/§3: een privé categorie
// "FORGE PROJECTS" met per projectmap een eigen kanaal (forum waar mogelijk,
// anders tekst), gekoppeld aan de projectmap zodat runs in de juiste map draaien.
// Gebruik: node src/setup-projects.js [projecten-basis-map]
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { Router } from './router.js';
import { AuditLedger } from './audit.js';

const config = loadConfig();
const baseDir = process.argv[2] ?? 'C:\\Users\\YOU\\Documents\\ForgeProjects';
const CATEGORY_NAME = '🔨 FORGE PROJECTS';

const projectDirs = fs
  .readdirSync(baseDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
  .map((d) => d.name);
if (projectDirs.length === 0) {
  console.error(`Geen projectmappen gevonden in ${baseDir}`);
  process.exit(1);
}
console.log(`Projecten in ${baseDir}: ${projectDirs.join(', ')}\n`);

const { Client, GatewayIntentBits, ChannelType, Events, PermissionFlagsBits, OverwriteType } =
  await import('discord.js');
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
await new Promise((resolve, reject) => {
  client.once(Events?.ClientReady ?? 'ready', resolve);
  client.login(config.botToken).catch(reject);
});
const guild = await client.guilds.fetch(config.guildId);
console.log(`Server: ${guild.name}`);

const ALLOW = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.AttachFiles,
];
const overwrites = [
  { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel], type: OverwriteType.Role },
  ...config.ownerUserIds.map((id) => ({ id, allow: ALLOW, type: OverwriteType.Member })),
  { id: client.user.id, allow: ALLOW, type: OverwriteType.Member },
];

const channels = await guild.channels.fetch();
let category = channels.find((c) => c?.type === ChannelType.GuildCategory && c.name === CATEGORY_NAME);
if (!category) {
  category = await guild.channels.create({
    name: CATEGORY_NAME,
    type: ChannelType.GuildCategory,
    permissionOverwrites: overwrites,
  });
  console.log(`Categorie aangemaakt: ${CATEGORY_NAME}`);
} else {
  console.log(`Categorie bestaat al: ${CATEGORY_NAME}`);
}

const audit = new AuditLedger(path.join(config.stateDir, 'audit.jsonl'));
const router = new Router({ stateDir: config.stateDir, audit });

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90);

// Overwrites gaan mee bij CREATE (lockPermissions achteraf vereist Manage Roles,
// die de bot bewust niet heeft). Een bestaand kanaal zonder privé-overwrite wordt
// opnieuw aangemaakt (verse setup; kanalen zijn dan nog leeg).
const isPrivate = (ch) =>
  ch.permissionOverwrites?.cache
    ?.get(guild.roles.everyone.id)
    ?.deny.has(PermissionFlagsBits.ViewChannel) ?? false;

async function findOrCreateChannel(name) {
  let existing = (await guild.channels.fetch()).find(
    (c) => c?.parentId === category.id && c.name === name,
  );
  if (existing && !isPrivate(existing)) {
    await existing.delete('setup: opnieuw aanmaken met privé-permissies');
    existing = null;
  }
  if (existing) {
    return {
      channel: existing,
      created: false,
      kind: existing.type === ChannelType.GuildForum ? 'forum' : 'tekst',
    };
  }
  const base = { name, parent: category.id, permissionOverwrites: overwrites };
  try {
    const forum = await guild.channels.create({ ...base, type: ChannelType.GuildForum });
    return { channel: forum, created: true, kind: 'forum' };
  } catch {
    const text = await guild.channels.create({ ...base, type: ChannelType.GuildText });
    return { channel: text, created: true, kind: 'tekst' };
  }
}

const rows = [];
for (const dir of projectDirs) {
  const channelName = slug(dir);
  const { channel, created, kind } = await findOrCreateChannel(channelName);
  const projectPath = path.join(baseDir, dir);
  router.registerProject({ projectId: channelName, name: dir, forumChannelId: channel.id, path: projectPath });
  rows.push({ dir, channelName, kind, created, id: channel.id });
  console.log(`  ${created ? '✚' : '='} #${channelName} (${kind}) ← ${projectPath}`);
}

// Info-kanaal met overzicht — expliciet een TEKSTkanaal (forum heeft geen .send()).
let info = (await guild.channels.fetch()).find(
  (c) => c?.parentId === category.id && c.name === 'forge-info',
);
if (info && info.type !== ChannelType.GuildText) {
  await info.delete('setup: forge-info moet een tekstkanaal zijn');
  info = null;
}
if (!info) {
  info = await guild.channels.create({
    name: 'forge-info',
    parent: category.id,
    permissionOverwrites: overwrites,
    type: ChannelType.GuildText,
  });
}
const overview = [
  '# 🔨 Forge Remote Control',
  '',
  'Stuur een prompt in een projectkanaal en Forge voert hem uit in de bijbehorende projectmap:',
  '',
  ...rows.map((r) => `- <#${r.id}> → \`${r.dir}\``),
  '',
  'Commando\'s: `/forge status` · `/forge queue` · `/forge stop` · `/forge help`',
  'Alleen de eigenaar (allowlist) kan opdrachten geven; bots/webhooks worden genegeerd.',
].join('\n');
await info.send(overview);
console.log(`\nOverzicht geplaatst in #forge-info. Setup klaar — ${rows.length} projecten gekoppeld.`);
await client.destroy();
