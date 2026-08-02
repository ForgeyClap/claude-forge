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
import path from 'node:path';

const config = loadConfig();
console.log('[forge-discord] config:', JSON.stringify(describeConfig(config)));

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
  await transport.connect();
  console.log('[forge-discord] transport verbonden; reconcile start…');
  phase = 'reconciling';
  await gateway.reconcile();
  await transport.setBusy?.(false);
}

if (config.transport === 'discord') {
  phase = 'syncing-projects';
  const { DiscordAdmin } = await import('./discord-admin.js');
  const admin = new DiscordAdmin({
    client: transport.client,
    guildId: config.guildId,
    ownerUserIds: config.ownerUserIds,
  });
  const info = await admin.ensureTextChannel('forge-info');
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

phase = 'ready';
// Wachtende/herstelde items direct oppakken + periodieke veiligheids-tick,
// zodat een herstart nooit een QUEUED item laat liggen.
const startedNow = gateway.scheduler.tick();
if (startedNow.length) console.log(`[forge-discord] ${startedNow.length} wachtende run(s) hervat`);
const tickTimer = setInterval(() => gateway.scheduler.tick(), 15_000);
if (typeof tickTimer.unref === 'function') tickTimer.unref();
console.log(`[forge-discord] actief (transport=${config.transport}, runner=${runnerKind}).`);

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
