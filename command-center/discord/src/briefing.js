import { SubscriptionUsage } from './subscription-usage.js';
import { scanRecent } from './project-diff.js';

// Idee D: één ochtendbericht per project — wat is er gedaan, wat staat open, wat
// kost het. Alles uit ECHTE gegevens (queue, usage-log, bestandswijzigingen);
// nooit verzonnen activiteit.
export function formatBriefing({ projectId, runs, costUsd, changedFiles, open, failed }) {
  const regels = [`**${projectId}**`];
  regels.push(
    runs === 0
      ? '• geen opdrachten uitgevoerd'
      : `• ${runs} opdracht${runs === 1 ? '' : 'en'} uitgevoerd${costUsd ? ` ($${costUsd.toFixed(2)})` : ''}`,
  );
  if (changedFiles.length) {
    const namen = changedFiles.slice(0, 3).map((f) => f.file.split(/[\\/]/).pop());
    regels.push(`• ${changedFiles.length} bestand(en) gewijzigd: ${namen.join(', ')}`);
  }
  if (open > 0) regels.push(`• ${open} opdracht(en) in de wachtrij`);
  if (failed > 0) regels.push(`• ⚠️ ${failed} mislukt — \`/forge queue\` voor details`);
  return regels.join('\n');
}

export class DailyBriefing {
  constructor({
    transport,
    router,
    queue,
    usage,
    subscriptionUsage,
    audit,
    ownerUserIds = [],
    infoChannelId = null,
    hourLocal = 8,
    now = () => Date.now(),
  }) {
    Object.assign(this, {
      transport,
      router,
      queue,
      usage,
      subscriptionUsage,
      audit,
      ownerUserIds,
      infoChannelId,
      hourLocal,
      now,
    });
    this.lastSentDay = null;
    this.timer = null;
  }

  async build() {
    const sinceMs = 24 * 3600 * 1000;
    const blokken = [];
    for (const project of this.router.projects.filter((p) => !p.archived)) {
      const summary = this.usage?.summary({ sinceMs, projectId: project.projectId }) ?? { runs: 0 };
      const items = this.queue.items.filter((i) => i.threadId === project.forumChannelId);
      const open = items.filter((i) => ['QUEUED', 'WAITING_FOR_CONFIRMATION'].includes(i.state)).length;
      const failed = items.filter((i) => ['FAILED', 'DEAD_LETTER'].includes(i.state)).length;
      const changedFiles = project.path ? scanRecent(project.path, { sinceMs, max: 30 }) : [];
      // Projecten zonder enige activiteit overslaan — anders is de briefing ruis.
      if (summary.runs === 0 && changedFiles.length === 0 && open === 0 && failed === 0) continue;
      blokken.push(
        formatBriefing({
          projectId: project.projectId,
          runs: summary.runs ?? 0,
          costUsd: summary.costUsd ?? 0,
          changedFiles,
          open,
          failed,
        }),
      );
    }
    let usageBlok = '';
    if (this.subscriptionUsage) {
      const sub = await this.subscriptionUsage.get();
      if (!sub.unavailable) usageBlok = `\n\n📊 **Verbruik**\n${SubscriptionUsage.format(sub)}`;
    }
    const ping = this.ownerUserIds.length ? `<@${this.ownerUserIds[0]}> ` : '';
    const kop = `${ping}☀️ **Ochtendbriefing** — afgelopen 24 uur`;
    const body = blokken.length ? blokken.join('\n\n') : 'Geen activiteit in de afgelopen 24 uur.';
    return `${kop}\n\n${body}${usageBlok}`;
  }

  async sendNow(channelId = null) {
    const target = channelId ?? this.infoChannelId;
    if (!target) return null;
    const text = await this.build();
    await this.transport.send(target, text).catch(() => {});
    this.audit?.record('briefing_sent', { channelId: target });
    return text;
  }

  // Elk kwartier kijken of het briefing-uur is aangebroken (1x per dag).
  start() {
    this.stop();
    const check = () => {
      const d = new Date(this.now());
      const dag = d.toISOString().slice(0, 10);
      if (d.getHours() === this.hourLocal && this.lastSentDay !== dag) {
        this.lastSentDay = dag;
        this.sendNow().catch((err) =>
          this.audit?.record('briefing_error', { error: String(err?.message ?? err) }),
        );
      }
    };
    this.timer = setInterval(check, 15 * 60 * 1000);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    // Vandaag niet meer versturen als het uur al voorbij is bij het opstarten.
    const nu = new Date(this.now());
    if (nu.getHours() >= this.hourLocal) this.lastSentDay = nu.toISOString().slice(0, 10);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
