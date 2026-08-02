// Beheer-laag voor serverstructuur: privé categorie + tekstkanalen (chats).
// Bestaat een kanaal nog als forum, dan wordt het automatisch omgezet naar
// een tekstkanaal (owner-keuze 2026-07-30: chats i.p.v. forums).
export class DiscordAdmin {
  constructor({ client, guildId, ownerUserIds, categoryName = '🔨 FORGE PROJECTS' }) {
    this.client = client;
    this.guildId = guildId;
    this.ownerUserIds = ownerUserIds;
    this.categoryName = categoryName;
    this.cache = { guild: null, channels: null, at: 0 };
  }

  // Guild + kanaallijst maximaal 1x per 20s ophalen — zonder cache hamert elke
  // sync ~14x de channels-endpoint en loopt alles vast op Discord-rate-limits.
  async #load(force = false) {
    if (!force && this.cache.channels && Date.now() - this.cache.at < 20_000) return this.cache;
    const guild = await this.client.guilds.fetch(this.guildId);
    const channels = await guild.channels.fetch();
    this.cache = { guild, channels, at: Date.now() };
    return this.cache;
  }

  async #overwrites(guild) {
    const { PermissionFlagsBits, OverwriteType } = await import('discord.js');
    const ALLOW = [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.CreatePublicThreads,
      PermissionFlagsBits.SendMessagesInThreads,
      PermissionFlagsBits.AttachFiles,
    ];
    return [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel], type: OverwriteType.Role },
      ...this.ownerUserIds.map((id) => ({ id, allow: ALLOW, type: OverwriteType.Member })),
      { id: this.client.user.id, allow: ALLOW, type: OverwriteType.Member },
    ];
  }

  async #category({ guild, channels }) {
    const { ChannelType } = await import('discord.js');
    let category = channels.find(
      (c) => c?.type === ChannelType.GuildCategory && c.name === this.categoryName,
    );
    if (!category) {
      category = await guild.channels.create({
        name: this.categoryName,
        type: ChannelType.GuildCategory,
        permissionOverwrites: await this.#overwrites(guild),
      });
      channels.set(category.id, category);
    }
    return category;
  }

  async ensureTextChannel(name, { knownChannelId = null } = {}) {
    const { ChannelType, PermissionFlagsBits } = await import('discord.js');
    const { stripIndicator } = await import('./channel-indicator.js');
    const loaded = await this.#load();
    const { guild, channels } = loaded;
    const category = await this.#category(loaded);
    // 1) op ID (overleeft hernoemen/emoji-prefix) 2) op kale naam.
    let existing =
      (knownChannelId ? channels.get(knownChannelId) : null) ??
      channels.find((c) => c?.parentId === category.id && stripIndicator(c.name) === name);
    // Duplicaten opruimen: alles met dezelfde kale naam behalve degene die we houden.
    const dupes = channels.filter(
      (c) =>
        c?.parentId === category.id &&
        stripIndicator(c.name) === name &&
        c.id !== (existing?.id ?? knownChannelId),
    );
    for (const dupe of dupes.values()) {
      try {
        const msgs = await dupe.messages.fetch({ limit: 5 }).catch(() => null);
        const empty = !msgs || msgs.filter((m) => !m.author?.bot).size === 0;
        if (empty) {
          await dupe.delete('duplicaat opruimen (leeg)');
          channels.delete(dupe.id);
        } else {
          await dupe.setName(`dup-${name}`.slice(0, 100), 'duplicaat gemarkeerd (had berichten)');
        }
      } catch {
        // niet fataal — duplicaat blijft dan staan
      }
    }
    let migrated = dupes.size > 0;
    // Privé-eis (owner 2026-07-30): alleen owner + bot. Een kanaal zonder
    // deny-@everyone wordt opnieuw aangemaakt mét privé-overwrites (de bot heeft
    // geen Manage Roles, dus bestaande permissies aanpassen kan niet).
    const isPrivate = (ch) =>
      ch.permissionOverwrites?.cache
        ?.get(guild.roles.everyone.id)
        ?.deny.has(PermissionFlagsBits.ViewChannel) ?? false;
    if (existing && (existing.type !== ChannelType.GuildText || !isPrivate(existing))) {
      await existing.delete('heal: kanaal moet privé chat zijn (owner-keuze)');
      channels.delete(existing.id);
      existing = null;
      migrated = true;
    }
    if (existing) {
      // Buiten de categorie beland? Terugzetten (owner-eis: alles in FORGE PROJECTS).
      if (existing.parentId !== category.id) {
        try {
          await existing.setParent(category.id, { lockPermissions: false });
          migrated = true;
        } catch {
          // geen rechten → laat staan, sync blijft werken op ID
        }
      }
      return { channelId: existing.id, created: false, migrated };
    }
    const channel = await guild.channels.create({
      name,
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: await this.#overwrites(guild),
    });
    channels.set(channel.id, channel);
    return { channelId: channel.id, created: true, migrated };
  }
}
