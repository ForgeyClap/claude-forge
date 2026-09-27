// Entrypoint voor de bot-service.
//   TRANSPORT=mock|discord · RUNNER=fake|claude (default fake)
// Startvolgorde: health-poort EERST claimen (single-instance-lock, fase zichtbaar
// voor het dashboard) → dan pas Discord verbinden → reconcile → projectsync → ready.
import { loadConfig, describeConfig } from './config.js';
import { ForgeDiscordGateway } from './gateway.js';
import { createFakeRunner } from './runner-fake.js';
import { createClaudeRunner } from './runner-claude.js';
import { SessionStore } from './session-store.js';
import { ProjectSync } from './project-sync.js';
import { startHealthServer } from './health-server.js';
import { createOwnerAwareProjectResolver } from './owner-elevation.js';
import { computeInvitePermissions } from './invite.js';
import { resolveGuild, resolveOwner } from './guild-autodetect.js';
import { writeEnvValues } from './env-store.js';
import { classifyLoginError } from './login-error.js';
import path from 'node:path';

const config = loadConfig();
console.log('[forge-discord] config:', JSON.stringify(describeConfig(config)));

// WP-v290-B: computed ONCE here (the only place this whole boot touches discord.js purely for
// permission math) and handed to the health server, which reuses it on every /api/health snapshot
// without importing discord.js itself. Guarded to the real transport only — mock transport (used
// by nearly every existing test in this package) never had a discord.js runtime dependency before
// this WP and must not gain one now; it never has an applicationId to build an invite URL from
// anyway, so `null` here is the honest value, not a shortcut.
const invitePermissions = config.transport === 'discord' ? await computeInvitePermissions() : null;

// Snelle voorcontrole: draait er al een instantie?
try {
  const res = await fetch(`http://127.0.0.1:${config.botHttpPort}/api/health`, {
    signal: AbortSignal.timeout(1200),
  });
  if (res.ok) {
    const other = await res.json();
    console.error(`[forge-discord] STOP: er draait al een bot (pid ${other.pid}). Deze instantie sluit af.`);
    process.exit(1);
  }
} catch {
  // niets bereikbaar → wij mogen starten
}

let transport;
if (config.transport === 'discord') {
  const { DiscordTransport } = await import('./transport/discord.js');
  transport = new DiscordTransport({ botToken: config.botToken, guildId: config.guildId });
} else {
  const { MockTransport } = await import('./transport/mock.js');
  transport = new MockTransport();
}

const runnerKind = process.env.RUNNER ?? config.runner ?? 'fake';
const sessionStore = new SessionStore(config.stateDir);
let gateway;
let projectMemory = null;
const runner =
  runnerKind === 'claude'
    ? createClaudeRunner({
        cwd: process.env.RUNNER_CWD ?? process.cwd(),
        sessionStore,
        stateDir: config.stateDir,
        // Permissiemodus PER BERICHT: een prompt van de geverifieerde owner mag
        // op volledige rechten draaien; iedereen/alles anders niet, en een
        // bewust read-only gezet project blijft read-only (owner-elevation.js).
        resolveProject: createOwnerAwareProjectResolver({
          findProject: (projectId) =>
            gateway?.router.projects.find((p) => p.projectId === projectId) ?? null,
          // Functie, geen kopie: de ownerlijst wordt bij ELK bericht opnieuw gelezen.
          ownerUserIds: () => config.ownerUserIds,
          audit: { record: (type, data) => gateway?.audit.record(type, data) },
        }),
        // Live voortgang in hetzelfde statusbericht (geen extra chatberichten).
        onProgress: (item, text) => gateway?.runStatus.progress(item, text),
        projectMemory: { summary: (id) => projectMemory?.summary(id) ?? '' },
      })
    : createFakeRunner({ delayMs: 300 });

gateway = new ForgeDiscordGateway({ config, transport, runner });
gateway.sessionStore = sessionStore;
const { UsageTracker } = await import('./usage-tracker.js');
gateway.usage = new UsageTracker({ stateDir: config.stateDir });
const { SubscriptionUsage } = await import('./subscription-usage.js');
gateway.subscriptionUsage = new SubscriptionUsage();

// Project-geheugen: korte geschiedenis per project, gaat mee bij een nieuw gesprek.
const { ProjectMemory } = await import('./project-memory.js');
projectMemory = new ProjectMemory({ baseDir: config.projectsDir, audit: gateway.audit });
gateway.projectMemory = projectMemory;

// Spraakmemo's en screenshots als invoer (altijd als DATA, nooit als instructie).
const { AttachmentHandler } = await import('./attachments.js');
gateway.attachments = new AttachmentHandler({ audit: gateway.audit });

// Auto-pauze bij hoge usage of een bereikt dagplafond.
const { UsageGuard } = await import('./usage-guard.js');
gateway.usageGuard = new UsageGuard({
  subscriptionUsage: gateway.subscriptionUsage,
  usage: gateway.usage,
  audit: gateway.audit,
  stateDir: config.stateDir,
  pauseAtPercent: config.pauseAtPercent,
  resumeAtPercent: config.resumeAtPercent,
  dailyCostLimitUsd: config.dailyCostLimitUsd,
  notify: (text) => {
    const first = gateway.router.projects.find((p) => !p.archived);
    return first ? transport.send(first.forumChannelId, text) : Promise.resolve();
  },
});

let phase = 'starting';
// WP-v290-B: a plain-language reason once transport.connect() fails (bad token, Message Content
// Intent not enabled, ...) — reported via /api/health so the dashboard can explain it instead of
// the beginner only ever seeing a bare crash in a log file they do not know to look at.
let loginError = null;
const shutdown = async () => {
  console.log('[forge-discord] afsluiten…');
  phase = 'stopping';
  gateway.projectSync?.stop();
  gateway.chatReset?.stop();
  gateway.briefing?.stop();
  gateway.schedules?.stop();
  gateway.usageGuard?.stop();
  gateway.retryPolicy?.stop();
  gateway.indicator?.stop();
  gateway.shutdown();
  await gateway.whenIdle();
  health.stop();
  if (typeof transport.destroy === 'function') await transport.destroy();
  process.exit(0);
};

// Poort claimen vóór het (trage) verbinden — mislukt dit, dan draait er al één.
const health = startHealthServer({
  gateway,
  config,
  runnerKind,
  onShutdown: shutdown,
  getPhase: () => phase,
  getLoginError: () => loginError,
  invitePermissions,
});
try {
  await health.listening;
} catch (err) {
  console.error(`[forge-discord] STOP: ${err.message}`);
  process.exit(1);
}
console.log(`[forge-discord] health-lock actief: http://127.0.0.1:${config.botHttpPort}/api/health`);

if (typeof transport.connect === 'function') {
  phase = 'connecting';
  try {
    await transport.connect();
  } catch (err) {
    // WP-v290-B: never let a beginner's wrong-token/wrong-intent paste crash this process with
    // nothing but an unread log file — stay alive, report WHY over /api/health, and skip every
    // step below that assumes a real connected client.
    loginError = classifyLoginError(err);
    phase = 'login-failed';
    console.error(`[forge-discord] STOP: ${loginError}`);
  }
  if (!loginError) {
    console.log('[forge-discord] transport verbonden; reconcile start…');
    phase = 'reconciling';
    await gateway.reconcile();
    await transport.setBusy?.(false);
  }
}

// WP-v290-B (beginner onboarding, auto-detect): fills in DISCORD_GUILD_ID/OWNER_USER_IDS from what
// Discord itself already told us at login — nobody has to go hunt for a numeric ID by hand. Pure
// decision logic lives in guild-autodetect.js (fully unit-tested there); this is only the I/O
// around it. Mock transport has no real `client`/guild list, so this only ever does anything for a
// genuine Discord connection. Skipped entirely once loginError is set — the client is not in a
// usable state (never fully connected) at that point.
if (config.transport === 'discord' && !loginError) {
  const guildsNow = [...(transport.client.guilds?.cache?.values() ?? [])].map((g) => ({
    id: g.id,
    name: g.name,
    ownerId: g.ownerId,
  }));
  const { guildId: resolvedGuildId, phase: awaitPhase } = resolveGuild(guildsNow, config.guildId);
  if (resolvedGuildId && resolvedGuildId !== config.guildId) {
    config.guildId = resolvedGuildId;
    const picked = guildsNow.find((g) => g.id === resolvedGuildId);
    await transport.reRegisterSlashCommandsForGuild(resolvedGuildId);
    writeEnvValues(process.cwd(), { DISCORD_GUILD_ID: resolvedGuildId });
    console.log(`[forge-discord] server automatisch gekozen: ${picked?.name ?? resolvedGuildId} (${resolvedGuildId})`);
  } else if (awaitPhase) {
    phase = awaitPhase;
    console.log(
      awaitPhase === 'awaiting-invite'
        ? '[forge-discord] LET OP: de bot is nog in geen enkele server uitgenodigd — gebruik de invite-link.'
        : `[forge-discord] LET OP: de bot zit in ${guildsNow.length} servers — kies er één via het dashboard.`,
    );
  }
  if (config.guildId) {
    const knownGuild = guildsNow.find((g) => g.id === config.guildId) ?? null;
    const resolvedOwners = resolveOwner(knownGuild, config.ownerUserIds);
    if (resolvedOwners) {
      // In-place splice, NEVER `config.ownerUserIds = resolvedOwners` — gateway.js's constructor
      // (already run at this point) handed this EXACT array object, by reference, to both
      // PermissionGateway and RunStatus (`this.ownerUserIds = ownerUserIds`, no copy). A plain
      // reassignment here would only ever update `config`'s own pointer, leaving those two — the
      // ones that actually GATE whether the newly-detected owner may use the bot at all — still
      // looking at the original empty array. Splicing the SAME array in place is visible to every
      // holder of that reference immediately, no restart required.
      config.ownerUserIds.splice(0, config.ownerUserIds.length, ...resolvedOwners);
      writeEnvValues(process.cwd(), { OWNER_USER_IDS: resolvedOwners.join(',') });
      console.log('[forge-discord] server-eigenaar automatisch als Forge-owner ingesteld.');
    }
  }
}

// Channel setup/chat-reset/briefing/schedules/usage-guard all assume a real, known guild — skipped
// for this boot when the auto-detect step above could not resolve one yet (0 or 2+ servers), or
// when the connection itself never succeeded (loginError). The process stays alive either way; the
// dashboard polls /api/health's `phase` and shows the right onboarding step (invite link, guild
// picker, or the plain-language login error).
if (config.transport === 'discord' && config.guildId && !loginError) {
  phase = 'syncing-projects';
  const { DiscordAdmin } = await import('./discord-admin.js');
  const admin = new DiscordAdmin({
    client: transport.client,
    guildId: config.guildId,
    ownerUserIds: config.ownerUserIds,
  });
  const info = await admin.ensureTextChannel('forge-info');
  // WP-v290-B: a short welcome/test message, but ONLY the first time this channel is genuinely
  // created — never repeated on an ordinary restart (info.created is false then), so onboarding
  // does not spam #forge-info every time the bot comes back up.
  if (info.created) {
    await transport
      .send(info.channelId, '👋 Forge is verbonden met deze server. Dit kanaal toont projectupdates — stuur hier gerust een testbericht.')
      .catch(() => {});
  }
  const sync = new ProjectSync({
    projectsDir: config.projectsDir,
    router: gateway.router,
    audit: gateway.audit,
    channelOps: admin,
    announce: (text) => transport.send(info.channelId, text),
  });
  gateway.projectSync = sync;
  const added = await sync.syncOnce({ verifyChannels: true, archiveOrphans: true });
  if (added.length) console.log(`[forge-discord] projectsync: ${added.length} kanaal/kanalen bijgewerkt`);
  sync.start(60_000);

  // Chat elke 30 min opruimen met transcript — nooit tijdens een actieve run.
  const { ChatReset } = await import('./chat-reset.js');
  const reset = new ChatReset({
    transport,
    router: gateway.router,
    queue: gateway.queue,
    scheduler: gateway.scheduler,
    audit: gateway.audit,
    cursors: gateway.cursors,
    saveCursors: () => gateway.cursorStore.save(gateway.cursors),
    ownerUserIds: config.ownerUserIds,
    transcriptDir: path.join(process.cwd(), 'transcripts'),
    intervalMs: config.chatResetMinutes * 60 * 1000,
  });
  gateway.chatReset = reset;
  if (config.chatResetMinutes > 0) {
    reset.start();
    console.log(`[forge-discord] chat-reset actief: elke ${config.chatResetMinutes} min (met transcript)`);
  }

  // Ochtendbriefing per project (idee D).
  const { DailyBriefing } = await import('./briefing.js');
  gateway.briefing = new DailyBriefing({
    transport,
    router: gateway.router,
    queue: gateway.queue,
    usage: gateway.usage,
    subscriptionUsage: gateway.subscriptionUsage,
    audit: gateway.audit,
    ownerUserIds: config.ownerUserIds,
    infoChannelId: info.channelId,
    hourLocal: config.briefingHour,
  });
  if (config.briefingHour >= 0) {
    gateway.briefing.start();
    console.log(`[forge-discord] ochtendbriefing om ${config.briefingHour}:00 in #forge-info`);
  }

  // Geplande opdrachten (idee J) — lopen door de normale pijplijn.
  const { Schedules } = await import('./schedules.js');
  gateway.schedules = new Schedules({
    stateDir: config.stateDir,
    audit: gateway.audit,
    onFire: (s) => {
      transport
        .simulateIncoming?.({ ...s, content: s.prompt }) ?? // mock-pad (tests)
        gateway
          .handleIncoming({
            messageId: `sched_${s.id}_${Date.now()}`,
            guildId: config.guildId,
            channelId: s.channelId,
            threadId: s.threadId,
            senderId: s.senderId,
            content: s.prompt,
            isBot: false,
            isWebhook: false,
            timestamp: Date.now(),
            attachments: [],
          })
          .catch(() => {});
    },
  });
  gateway.schedules.start();

  gateway.usageGuard.start();
  await gateway.usageGuard.evaluate();
  if (gateway.usageGuard.paused) {
    console.log(`[forge-discord] LET OP: gepauzeerd — ${gateway.usageGuard.reason()}`);
  }
}

// WP-v290-B: never overwrite an honest 'awaiting-invite'/'awaiting-guild-selection'/'login-failed'
// with 'ready' — those phases mean setup is genuinely not done (or failed) yet, and the dashboard
// is showing the real reason.
const NOT_READY_PHASES = ['awaiting-invite', 'awaiting-guild-selection', 'login-failed'];
if (!NOT_READY_PHASES.includes(phase)) phase = 'ready';
// Wachtende/herstelde items direct oppakken + periodieke veiligheids-tick,
// zodat een herstart nooit een QUEUED item laat liggen.
const startedNow = gateway.scheduler.tick();
if (startedNow.length) console.log(`[forge-discord] ${startedNow.length} wachtende run(s) hervat`);
const tickTimer = setInterval(() => gateway.scheduler.tick(), 15_000);
if (typeof tickTimer.unref === 'function') tickTimer.unref();
console.log(`[forge-discord] actief (transport=${config.transport}, runner=${runnerKind}).`);

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
