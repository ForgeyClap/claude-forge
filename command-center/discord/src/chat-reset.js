import fs from 'node:fs';
import path from 'node:path';
import { redactSecrets } from './audit.js';

// Periodieke chat-reset met transcript (owner-eis: elke 30 min opruimen zodat het
// kanaal niet volloopt). Harde veiligheidsregels:
//  - NOOIT resetten als er een run bezig is of wachtende items zijn in dat kanaal
//    (een prompt die 30+ minuten duurt mag niet breken en niets verliezen);
//  - eerst transcript wegschrijven (.txt — leesbaar op mobiel), dan pas wissen;
//  - message-cursor vooruitzetten VOOR het wissen, zodat reconcile na een herstart
//    geen oude prompts opnieuw uitvoert;
//  - de eigenaar krijgt een ping met het transcript als bijlage.
export function formatTranscript(messages, { projectId, channelId }) {
  const lines = [
    `FORGE TRANSCRIPT`,
    `project : ${projectId}`,
    `kanaal  : ${channelId}`,
    `gemaakt : ${new Date().toISOString()}`,
    `berichten: ${messages.length}`,
    ''.padEnd(60, '='),
    '',
  ];
  for (const m of messages) {
    const when = new Date(m.timestamp ?? Date.now()).toISOString().replace('T', ' ').slice(0, 19);
    const who = m.isBot ? 'BOT ' : 'JIJ ';
    lines.push(`[${when}] ${who} ${String(m.content ?? '').replace(/\n/g, '\n                          ')}`);
    for (const a of m.attachments ?? []) lines.push(`                          (bijlage: ${a.name})`);
  }
  lines.push('', ''.padEnd(60, '='), 'einde transcript');
  return lines.join('\n');
}

export class ChatReset {
  constructor({
    transport,
    router,
    queue,
    scheduler,
    audit,
    cursors,
    saveCursors,
    ownerUserIds = [],
    transcriptDir,
    intervalMs = 30 * 60 * 1000,
    now = () => Date.now(),
  }) {
    Object.assign(this, {
      transport,
      router,
      queue,
      scheduler,
      audit,
      cursors,
      saveCursors,
      ownerUserIds,
      transcriptDir,
      intervalMs,
      now,
    });
    this.lastReset = new Map(); // channelId -> ms
    this.timer = null;
  }

  #busy(channelId) {
    if (this.scheduler?.activeRuns?.has(channelId)) return true;
    return this.queue.items.some(
      (i) =>
        i.threadId === channelId &&
        ['QUEUED', 'STARTING', 'RUNNING', 'WAITING_FOR_CONFIRMATION'].includes(i.state),
    );
  }

  writeTranscript(projectId, channelId, messages) {
    // Transcripts gaan naar schijf EN als bijlage terug het kanaal in: eerst door
    // de secret-redactie, want een chat kan een gepaste token/webhook bevatten.
    const text = redactSecrets(formatTranscript(messages, { projectId, channelId }));
    const dir = path.join(this.transcriptDir, projectId);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = path.join(dir, `${stamp}.txt`);
    fs.writeFileSync(file, text, 'utf8');
    return { file, text };
  }

  async resetChannel(project, { force = false } = {}) {
    const channelId = project.forumChannelId;
    if (!force && this.#busy(channelId)) {
      this.audit?.record('chat_reset_deferred', { channelId, reason: 'run_actief_of_wachtrij' });
      return { skipped: true, reason: 'busy' };
    }
    let messages = [];
    try {
      messages = await this.transport.fetchAll(channelId, 500);
    } catch (err) {
      this.audit?.record('chat_reset_fetch_failed', { channelId, error: String(err?.message ?? err) });
      return { skipped: true, reason: 'fetch_failed' };
    }
    if (messages.length < 6) {
      this.lastReset.set(channelId, this.now());
      return { skipped: true, reason: 'te_weinig_berichten' };
    }

    const { file, text } = this.writeTranscript(project.projectId, channelId, messages);

    // Cursor vooruit VOOR het wissen: anders haalt reconcile straks niets of juist
    // oude prompts opnieuw op.
    const newest = messages[messages.length - 1];
    if (newest?.messageId) {
      this.cursors.lastSeen[channelId] = newest.messageId;
      this.saveCursors?.();
    }

    let deleted = 0;
    try {
      deleted = await this.transport.purge(channelId);
    } catch (err) {
      this.audit?.record('chat_reset_purge_failed', { channelId, error: String(err?.message ?? err) });
      await this.transport
        .send(
          channelId,
          `⚠️ Kon de chat niet opruimen (${redactSecrets(String(err?.message ?? err)).slice(0, 120)}). Transcript is wel bewaard.`,
          [{ name: path.basename(file), content: text }],
        )
        .catch(() => {});
      return { skipped: true, reason: 'purge_failed', file };
    }

    this.lastReset.set(channelId, this.now());
    this.audit?.record('chat_reset_done', { channelId, deleted, transcript: file });
    const ping = this.ownerUserIds.length ? `<@${this.ownerUserIds[0]}> ` : '';
    await this.transport
      .send(
        channelId,
        `${ping}🧹 Chat opgeruimd (${deleted} berichten). Alles staat in het transcript hieronder — je gesprek met mij loopt gewoon door, ik ben niets vergeten.`,
        [{ name: path.basename(file), content: text }],
      )
      .catch(() => {});
    return { skipped: false, deleted, file };
  }

  async runOnce() {
    const results = [];
    for (const project of this.router.projects.filter((p) => !p.archived)) {
      const last = this.lastReset.get(project.forumChannelId) ?? 0;
      if (this.now() - last < this.intervalMs) continue;
      results.push({ projectId: project.projectId, ...(await this.resetChannel(project)) });
    }
    return results;
  }

  start() {
    this.stop();
    // Elke minuut kijken of er iets toe is aan een reset; de interval-check per
    // kanaal doet het echte werk (zo pakt hij een uitgestelde reset snel op zodra
    // een lange run klaar is).
    this.timer = setInterval(() => {
      this.runOnce().catch((err) =>
        this.audit?.record('chat_reset_error', { error: String(err?.message ?? err) }),
      );
    }, 60_000);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    // Startmoment telt als "net gereset", zodat een herstart niet meteen wist.
    for (const p of this.router.projects) this.lastReset.set(p.forumChannelId, this.now());
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
