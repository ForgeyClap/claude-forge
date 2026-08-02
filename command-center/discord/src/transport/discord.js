import { EventEmitter } from 'node:events';

// Echte Discord-adapter met dezelfde interface als MockTransport.
// discord.js wordt lazy geïmporteerd zodat de rest van het systeem (mock, tests)
// zonder deze dependency draait. Activeren is owner-gated: vereist .env met token.
export class DiscordTransport extends EventEmitter {
  constructor({ botToken, guildId }) {
    super();
    this.botToken = botToken;
    this.guildId = guildId;
    this.client = null;
    this.botUserId = null;
    this.connected = false;
  }

  async connect() {
    let djs;
    try {
      djs = await import('discord.js');
    } catch {
      throw new Error('discord.js ontbreekt — installeer met: npm install discord.js');
    }
    const { Client, GatewayIntentBits, Partials, Events } = djs;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent, // privileged: aanzetten in het Developer Portal
      ],
      partials: [Partials.Channel],
      // Zonder dit slaapt @discordjs/rest bij een 429 op /channels tot retry_after
      // (~10 min) en bevriest daarmee ook de statusbericht-edits. Liever een fout
      // die de indicator afvangt dan een bevroren bot.
      rest: { rejectOnRateLimit: (info) => info.route.startsWith('/channels') },
    });
    this.client.rest.on('rateLimited', (info) => {
      console.warn(`[forge-discord] rate limit op ${info.route} (${info.timeToReset}ms)`);
    });

    this.client.on(Events?.MessageCreate ?? 'messageCreate', (msg) => {
      if (msg.guildId !== this.guildId) return;
      this.emit('message', this.#normalize(msg));
    });
    this.client.on('shardResume', () => {
      this.connected = true;
      this.emit('resumed');
    });
    this.client.on('shardDisconnect', () => {
      this.connected = false;
      this.emit('disconnected');
    });

    this.client.on(Events?.InteractionCreate ?? 'interactionCreate', (interaction) => {
      this.#handleInteraction(interaction).catch(() => {});
    });

    await new Promise((resolve, reject) => {
      this.client.once(Events?.ClientReady ?? 'ready', resolve);
      this.client.login(this.botToken).catch(reject);
    });
    this.botUserId = this.client.user.id;
    this.connected = true;
    await this.#registerSlashCommands();
  }

  // Echte Discord application-commands (guild-scoped = direct zichtbaar met
  // autocomplete, ook op mobiel). Tekstvariant (/forge … als bericht) blijft werken.
  async #registerSlashCommands() {
    const { SlashCommandBuilder } = await import('discord.js');
    const withArg = (sub, desc, argDesc) =>
      sub.setDescription(desc).addStringOption((o) => o.setName('waarde').setDescription(argDesc).setRequired(true));
    const cmd = new SlashCommandBuilder()
      .setName('forge')
      .setDescription('Forge remote control')
      .addSubcommand((s) => s.setName('status').setDescription('Actieve runs + wachtrij'))
      .addSubcommand((s) => s.setName('queue').setDescription('Open items in dit kanaal'))
      .addSubcommand((s) => s.setName('stop').setDescription('Stop de actieve run (checkpoint bewaard)'))
      .addSubcommand((s) => s.setName('interrupt').setDescription('Onderbreek; volgende prompt krijgt voorrang'))
      .addSubcommand((s) => withArg(s.setName('confirm'), 'Bevestig een oude opdracht', 'Item-id (prefix)'))
      .addSubcommand((s) => withArg(s.setName('retry'), 'Zet een gefaald item terug in de wachtrij', 'Item-id (prefix)'))
      .addSubcommand((s) => withArg(s.setName('remove'), 'Verwijder een wachtend item', 'Item-id (prefix)'))
      .addSubcommand((s) => withArg(s.setName('resend'), 'Verstuur een eindrapport opnieuw', 'Delivery-id (prefix)'))
      .addSubcommand((s) => withArg(s.setName('newproject'), 'Maak projectmap + kanaal aan', 'Projectnaam'))
      .addSubcommand((s) =>
        s.setName('write').setDescription('Schrijfrechten voor dit project').addStringOption((o) =>
          o.setName('waarde').setDescription('on of off').setRequired(true).addChoices(
            { name: 'on', value: 'on' },
            { name: 'off', value: 'off' },
          ),
        ),
      )
      .addSubcommand((s) =>
        s.setName('model').setDescription('Model voor dit project').addStringOption((o) =>
          o.setName('waarde').setDescription('model').setRequired(true).addChoices(
            { name: 'fable (slimst)', value: 'fable' },
            { name: 'opus', value: 'opus' },
            { name: 'sonnet (snel)', value: 'sonnet' },
            { name: 'haiku (goedkoop)', value: 'haiku' },
          ),
        ),
      )
      .addSubcommand((s) =>
        s.setName('effort').setDescription('Denkdiepte voor dit project').addStringOption((o) =>
          o.setName('waarde').setDescription('effort').setRequired(true).addChoices(
            { name: 'low', value: 'low' },
            { name: 'medium', value: 'medium' },
            { name: 'high', value: 'high' },
            { name: 'xhigh', value: 'xhigh' },
            { name: 'max', value: 'max' },
          ),
        ),
      )
      .addSubcommand((s) =>
        s.setName('usage').setDescription('Verbruik: runs, kosten, tokens').addStringOption((o) =>
          o.setName('waarde').setDescription('aantal uren terugkijken (standaard 24)').setRequired(false),
        ),
      )
      .addSubcommand((s) =>
        s.setName('diff').setDescription('Welke bestanden zijn er gewijzigd').addStringOption((o) =>
          o.setName('waarde').setDescription('aantal uren terugkijken (standaard 1)').setRequired(false),
        ),
      )
      .addSubcommand((s) => s.setName('reset').setDescription('Chat nu opruimen (transcript bewaard)'))
      .addSubcommand((s) => s.setName('session-reset').setDescription('Vers gesprek in dit kanaal'))
      .addSubcommand((s) =>
        withArg(s.setName('schedule'), 'Plan een opdracht', 'bv: elke dag 08:00 draai de tests'),
      )
      .addSubcommand((s) => s.setName('schedules').setDescription('Geplande opdrachten in dit kanaal'))
      .addSubcommand((s) => withArg(s.setName('unschedule'), 'Verwijder een planning', 'planning-id'))
      .addSubcommand((s) => s.setName('briefing').setDescription('Stuur de dagbriefing nu'))
      .addSubcommand((s) => s.setName('pause').setDescription('Pauzeer de bot (wachtrij blijft)'))
      .addSubcommand((s) => s.setName('resume').setDescription('Hervat na een pauze'))
      .addSubcommand((s) => s.setName('memory').setDescription('Wat ik van dit project weet'))
      .addSubcommand((s) => s.setName('help').setDescription('Commando-overzicht'));
    const set = await this.client.application.commands.set([cmd], this.guildId);
    console.log(`[forge-discord] slash-commands geregistreerd (guild-scoped, ${set.size} command(s))`);
  }

  async #handleInteraction(interaction) {
    // Goedkeuringsknoppen (idee B): [Ja, doe het] / [Nee].
    if (interaction.isButton?.() && String(interaction.customId).startsWith('forge_')) {
      const [kind, approvalId] = String(interaction.customId).split(':');
      this.emit('approval', {
        approvalId,
        approved: kind === 'forge_ok',
        senderId: interaction.user.id,
        threadId: interaction.channelId,
        respond: async (text) => {
          try {
            await interaction.update({ content: String(text).slice(0, 1900), components: [] });
          } catch {
            await this.send(interaction.channelId, text).catch(() => {});
          }
        },
      });
      return;
    }
    if (!interaction.isChatInputCommand?.() || interaction.commandName !== 'forge') return;
    const sub = interaction.options.getSubcommand();
    const waarde = interaction.options.getString('waarde') ?? '';
    await interaction.deferReply();
    const content =
      sub === 'session-reset' ? '/forge session reset' : `/forge ${sub}${waarde ? ` ${waarde}` : ''}`;
    const isThread = typeof interaction.channel?.isThread === 'function' && interaction.channel.isThread();
    const msg = {
      messageId: `slash_${interaction.id}`,
      guildId: interaction.guildId,
      channelId: isThread ? interaction.channel.parentId : interaction.channelId,
      threadId: interaction.channelId,
      senderId: interaction.user.id,
      content,
      isBot: false,
      isWebhook: false,
      timestamp: Date.now(),
      attachments: [],
    };
    this.emit('slash', {
      msg,
      reply: async (text) => {
        try {
          await interaction.editReply(String(text).slice(0, 1900));
        } catch {
          // interaction verlopen → val terug op gewoon kanaalbericht
          await this.send(msg.threadId, text).catch(() => {});
        }
      },
    });
  }

  #normalize(msg) {
    const isThread = typeof msg.channel?.isThread === 'function' && msg.channel.isThread();
    return {
      messageId: msg.id,
      guildId: msg.guildId,
      channelId: isThread ? msg.channel.parentId : msg.channelId,
      threadId: msg.channelId,
      senderId: msg.author?.id,
      content: msg.content ?? '',
      isBot: Boolean(msg.author?.bot),
      isWebhook: Boolean(msg.webhookId),
      timestamp: msg.createdTimestamp,
      attachments: [...(msg.attachments?.values() ?? [])].map((a) => ({
        name: a.name,
        url: a.url,
        size: a.size,
      })),
    };
  }

  // Rood/groen bolletje naast de bot: bezig = dnd (rood), vrij = online (groen).
  async setBusy(busy, label = null) {
    if (!this.client?.user) return;
    const { ActivityType } = await import('discord.js');
    this.client.user.setPresence({
      status: busy ? 'dnd' : 'online',
      activities: [
        {
          name: 'status',
          type: ActivityType.Custom,
          state: busy ? `🔴 Bezig — ${label ?? 'run actief'}` : '🟢 Vrij — stuur je opdracht',
        },
      ],
    });
  }

  async sendTyping(threadId) {
    const channel = await this.client.channels.fetch(threadId);
    if (typeof channel?.sendTyping === 'function') await channel.sendTyping();
  }

  // 🔴/🟢 vóór de kanaalnaam — zichtbaar in de kanaallijst, dus ook op mobiel.
  async setChannelPrefix(channelId, emoji) {
    const { stripIndicator } = await import('../channel-indicator.js');
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.name) return;
    const base = stripIndicator(channel.name);
    const next = `${emoji}${base}`.slice(0, 100);
    if (channel.name === next) return;
    await channel.setName(next, 'Forge run-status');
  }

  // Volledige (recente) geschiedenis ophalen voor een transcript.
  async fetchAll(channelId, max = 500) {
    const channel = await this.client.channels.fetch(channelId);
    const out = [];
    let before;
    while (out.length < max) {
      const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      if (batch.size === 0) break;
      const sorted = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      out.unshift(...sorted.map((m) => this.#normalize(m)));
      before = sorted[0].id;
      if (batch.size < 100) break;
    }
    return out.slice(-max);
  }

  // Kanaal leegmaken; bulkDelete kan alleen berichten < 14 dagen oud.
  async purge(channelId) {
    const channel = await this.client.channels.fetch(channelId);
    let deleted = 0;
    for (let round = 0; round < 6; round += 1) {
      const batch = await channel.messages.fetch({ limit: 100 });
      if (batch.size === 0) break;
      const removed = await channel.bulkDelete(batch, true);
      deleted += removed.size;
      if (removed.size === 0) break; // alleen nog berichten ouder dan 14 dagen
    }
    return deleted;
  }

  // Alleen expliciet genoemde gebruikers mogen gepingd worden: de inhoud is deels
  // model-gestuurd, dus @everyone/rollen worden hier hard geblokkeerd.
  #mentions(content) {
    const users = [...String(content).matchAll(/<@!?(\d{5,25})>/g)].map((m) => m[1]);
    return { parse: [], users: [...new Set(users)], roles: [], repliedUser: false };
  }

  // Eén plek die de 2000-tekenslimiet afhandelt: te lang → afkappen MET markering
  // en de volledige tekst als .txt-bijlage (leesbaar op mobiel).
  #payload(content, files = []) {
    const text = String(content);
    const attachments = [...files];
    let out = text;
    if (text.length > 1900) {
      out = `${text.slice(0, 1750).trimEnd()}\n…(afgekapt — volledige tekst in de bijlage)`;
      attachments.push({ name: 'volledig.txt', content: text });
    }
    const payload = { content: out, allowedMentions: this.#mentions(out) };
    if (attachments.length) {
      payload.files = attachments.map((f) => ({
        attachment: Buffer.from(f.content, 'utf8'),
        name: f.name,
      }));
    }
    return payload;
  }

  async send(threadId, content, files = [], { components = null } = {}) {
    const channel = await this.client.channels.fetch(threadId);
    const payload = this.#payload(content, files);
    if (components) payload.components = components;
    const sent = await channel.send(payload);
    return { messageId: sent.id };
  }

  async edit(messageId, content, channelId) {
    const channel = await this.client.channels.fetch(channelId);
    const message = await channel.messages.fetch(messageId);
    const text = String(content);
    await message.edit({
      content: text.length > 1900 ? `${text.slice(0, 1880).trimEnd()}…` : text,
      allowedMentions: this.#mentions(text),
    });
    return { messageId };
  }

  async fetchSince(threadId, afterMessageId) {
    const channel = await this.client.channels.fetch(threadId);
    const out = [];
    let after = afterMessageId ?? '0';
    for (;;) {
      const batch = await channel.messages.fetch({ after, limit: 100 });
      if (batch.size === 0) break;
      const sorted = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      out.push(...sorted);
      after = sorted[sorted.length - 1].id;
      if (batch.size < 100) break;
    }
    return out.map((m) => this.#normalize(m));
  }

  async listThreads(channelId) {
    const forum = await this.client.channels.fetch(channelId);
    if (!forum?.threads) return [];
    const active = await forum.threads.fetchActive();
    return [...active.threads.keys()];
  }

  async destroy() {
    this.connected = false;
    await this.client?.destroy();
  }
}
