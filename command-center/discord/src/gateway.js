import path from 'node:path';
import { AuditLedger } from './audit.js';
import { IngressQueue, QueueState } from './queue.js';
import { Router } from './router.js';
import { PermissionGateway } from './permissions.js';
import { Scheduler } from './scheduler.js';
import { Outbox } from './outbox.js';
import { JsonStore } from './store.js';
import { sha256 } from './ids.js';
import { isCommand, handleCommand } from './commands.js';
import { RunStatus } from './run-status.js';
import { ChannelIndicator } from './channel-indicator.js';
import { friendlyError } from './friendly-error.js';
import { AttachmentHandler } from './attachments.js';
import { Approvals, detectRisk } from './approvals.js';
import { RetryPolicy } from './retry-policy.js';

// De wiring van de hele pijplijn (plan §1): transport → permissions → router →
// queue → scheduler → runner → antwoord + outbox. Forge blijft bron van waarheid;
// dit is uitsluitend de transport/routerings/queue-laag.
export class ForgeDiscordGateway {
  constructor({ config, transport, runner, now = Date.now }) {
    this.config = config;
    this.transport = transport;
    this.audit = new AuditLedger(path.join(config.stateDir, 'audit.jsonl'));
    this.queue = new IngressQueue({
      stateDir: config.stateDir,
      audit: this.audit,
      now,
      expiryMs: config.expiryMs,
      maxQueuedPerThread: config.maxQueuedPerThread,
    });
    this.router = new Router({ stateDir: config.stateDir, audit: this.audit });
    this.permissions = new PermissionGateway({
      ownerUserIds: config.ownerUserIds,
      botUserId: () => transport.botUserId,
      audit: this.audit,
    });
    this.outbox = new Outbox({ stateDir: config.stateDir, audit: this.audit, transport });
    this.typingTimers = new Map();
    // NB: heet bewust runStatus — `status()` is de health-methode van de gateway.
    this.runStatus = new RunStatus({
      transport,
      audit: this.audit,
      ownerUserIds: config.ownerUserIds,
    });
    this.indicator = new ChannelIndicator({ transport, audit: this.audit });
    // Standaard aan (niet afhankelijk van de wiring): tijdelijke fouten worden
    // stil herhaald en risicovolle opdrachten vragen eerst om bevestiging.
    this.retryPolicy = new RetryPolicy({ audit: this.audit });
    this.approvals = new Approvals({ audit: this.audit });
    this.scheduler = new Scheduler({
      queue: this.queue,
      audit: this.audit,
      runner,
      maxGlobalActiveRuns: config.globalMaxActiveRuns,
      onComplete: (item, result) => this.#deliverResult(item, result),
      onError: (item, err) => this.#deliverError(item, err),
      onStart: (item) => this.#runStarted(item),
      onSettle: (item) => this.#runSettled(item),
      onCancel: (item) => this.runStatus.cancelled(item),
      isPaused: () => this.usageGuard?.paused === true,
    });
    // Per thread de laatste terminale toestand (error/waiting) zodat 'vrij' die
    // niet meteen overschrijft — anders zie je een fout nooit op je telefoon.
    this.stickyState = new Map();
    this.cursorStore = new JsonStore(path.join(config.stateDir, 'cursors.json'));
    this.cursors = this.cursorStore.load({ lastSeen: {} });
    this.pending = new Set();
    this.ackedAsStarted = new Set();
    this.hintedAt = new Map();

    transport.on('message', (msg) => {
      this.#track(
        this.handleIncoming(msg).catch((err) =>
          this.audit.record('handle_incoming_error', { error: String(err?.message ?? err) }),
        ),
      );
    });
    transport.on('slash', ({ msg, reply }) => {
      this.#track(
        this.#handleSlash(msg, reply).catch((err) =>
          this.audit.record('slash_error', { error: String(err?.message ?? err) }),
        ),
      );
    });
    transport.on('approval', (evt) => {
      this.#track(
        this.#handleApproval(evt).catch((err) =>
          this.audit.record('approval_error', { error: String(err?.message ?? err) }),
        ),
      );
    });
    transport.on('resumed', () => {
      this.#track(
        this.reconcile().catch((err) =>
          this.audit.record('reconcile_error', { error: String(err?.message ?? err) }),
        ),
      );
    });
  }

  #track(promise) {
    this.pending.add(promise);
    promise.finally(() => this.pending.delete(promise));
    return promise;
  }

  // Slash-interactions: zelfde permissie/route-checks, antwoord via de interaction.
  async #handleSlash(msg, replyFn) {
    this.audit.record('slash_command_received', { threadId: msg.threadId, content: msg.content });
    const perm = this.permissions.check(msg);
    if (!perm.allowed) return replyFn('⛔ Geen toegang (alleen de eigenaar mag commando\'s geven).');
    const route = this.router.resolveRoute({ channelId: msg.channelId, threadId: msg.threadId });
    if (!route) return replyFn('Dit kanaal is niet aan een Forge-project gekoppeld.');
    if (route.archived) return replyFn('Dit project is gearchiveerd.');
    return handleCommand({ msg, gateway: this, replyFn });
  }

  // Knop [Ja]/[Nee] onder een goedkeuringsverzoek.
  async #handleApproval({ approvalId, approved, senderId, respond }) {
    if (!this.config.ownerUserIds.includes(senderId)) {
      return respond('⛔ Alleen de eigenaar kan dit goedkeuren.');
    }
    const resolved = this.approvals?.resolve(approvalId, approved);
    if (!resolved) {
      return respond('Dit verzoek is verlopen of al beantwoord. Stuur de opdracht opnieuw.');
    }
    if (!approved) {
      this.queue.remove(resolved.item.id);
      return respond(`🚫 Niet uitgevoerd (${resolved.label}). De opdracht is verwijderd.`);
    }
    this.queue.confirm(resolved.item.id);
    await respond(`✅ Goedgekeurd (${resolved.label}) — ik ga aan de slag.`);
    this.scheduler.tick();
    return null;
  }

  async handleIncoming(msg) {
    this.#advanceCursor(msg.threadId, msg.messageId);
    const perm = this.permissions.check(msg);
    if (!perm.allowed) return { handled: false, reason: perm.reason };

    const route = this.router.resolveRoute({ channelId: msg.channelId, threadId: msg.threadId });
    if (!route) {
      // Geen stilte: één keer per 10 min uitleggen waarom hier niets gebeurt.
      const last = this.hintedAt.get(msg.threadId) ?? 0;
      if (Date.now() - last > 10 * 60 * 1000) {
        this.hintedAt.set(msg.threadId, Date.now());
        await this.transport
          .send(
            msg.threadId,
            'Dit kanaal hoort nog niet bij een Forge-project. Stuur je opdracht in een projectkanaal, of maak er een met `/forge newproject <naam>`.',
          )
          .catch(() => {});
      }
      return { handled: false, reason: 'unregistered_or_conflict' };
    }
    if (route.archived) {
      await this.transport.send(
        msg.threadId,
        'Dit project is gearchiveerd. Heractiveer het voordat je nieuwe opdrachten stuurt.',
      );
      return { handled: false, reason: 'archived' };
    }

    // Thread-commando's (plan §6) gaan niet de wachtrij in.
    if (isCommand(msg.content)) {
      this.audit.record('command_received', { threadId: msg.threadId, content: msg.content });
      return handleCommand({ msg, gateway: this });
    }

    // Nieuwe opdracht heft een openstaande fout/vraag op dit kanaal op.
    this.stickyState.delete(msg.threadId);

    // Spraakmemo's/screenshots opslaan in de projectmap en als DATA aankondigen.
    let attachmentInfo = '';
    if (this.attachments && msg.attachments?.length) {
      const project = this.router.projects.find((p) => p.projectId === route.projectId);
      const prepared = await this.attachments.prepare(msg.attachments, project?.path);
      attachmentInfo = AttachmentHandler.describe(prepared);
      // Eerlijk zijn als een spraakmemo niet gelezen kon worden.
      const waarschuwing = AttachmentHandler.audioWarning(prepared);
      if (waarschuwing) await this.transport.send(msg.threadId, waarschuwing).catch(() => {});
    }

    const res = this.queue.enqueue({
      ...msg,
      projectId: route.projectId,
      conversationId: route.conversationId,
      receivedAt: msg.timestamp,
      attachmentInfo,
    });
    if (res.duplicate) return { handled: false, reason: 'duplicate' };
    if (!res.accepted) {
      await this.transport.send(
        msg.threadId,
        `Wachtrij-limiet bereikt (max ${this.config.maxQueuedPerThread} per thread) — probeer later opnieuw.`,
      );
      return { handled: false, reason: res.reason };
    }

    // Statusbericht EERST aanmaken (één bericht per opdracht dat later wordt
    // bewerkt), dan pas de run starten — zo kan de volgorde nooit omdraaien.
    // Risicovolle opdracht? Eerst knoppen, dan uitvoeren (idee B).
    const risk = this.approvals ? detectRisk(msg.content) : null;
    if (risk && res.item.state === QueueState.QUEUED) {
      this.queue.holdForApproval(res.item.id);
      const { id } = this.approvals.create(res.item, risk);
      const ping = this.config.ownerUserIds.length ? `<@${this.config.ownerUserIds[0]}> ` : '';
      await this.transport
        .send(
          msg.threadId,
          `${ping}⚠️ **Bevestiging nodig** — dit lijkt op **${risk}**.\n"${msg.content.slice(0, 200)}"\n\nWil je dat ik dit uitvoer?`,
          [],
          { components: Approvals.buttonRows(id) },
        )
        .catch(() => {});
      return { handled: true, item: res.item, awaitingApproval: true };
    }

    const hours = Math.round(this.config.expiryMs / 3600000);
    if (res.item.state === QueueState.WAITING_FOR_CONFIRMATION) {
      this.#track(
        this.runStatus.begin(
          res.item,
          `⏳ **Ontvangen** — deze opdracht is ouder dan ${hours} uur. Bevestig met \`/forge confirm ${res.item.id.slice(0, 12)}\`.`,
        ),
      );
      return { handled: true, item: res.item };
    }
    const position = this.queue.items.filter(
      (i) => i.threadId === msg.threadId && i.state === QueueState.QUEUED,
    ).length;
    // Niet awaiten: RunStatus zet latere edits achter deze send-promise, dus de
    // volgorde blijft goed terwijl de run direct (synchroon) kan starten.
    this.#track(
      this.runStatus.begin(
        res.item,
        position > 1
          ? `📥 **In de wachtrij** (plek ${position}) — "${res.item.content.slice(0, 90)}"`
          : `📥 **Ontvangen** — "${res.item.content.slice(0, 100)}"`,
      ),
    );
    this.scheduler.tick();
    return { handled: true, item: res.item };
  }

  async #deliverResult(item, result) {
    const raw = result.answer ?? '(geen antwoord)';
    // Statusregel van de agent eruit filteren en gebruiken voor het kanaalbolletje.
    const statusMatch = raw.match(/^\s*STATUS:\s*(OK|FOUT|INPUT_NODIG)\s*\n?/i);
    const answer = statusMatch ? raw.slice(statusMatch[0].length).trim() || raw : raw;
    if (statusMatch) {
      const kind = statusMatch[1].toUpperCase();
      if (kind === 'FOUT') this.#setSticky(item.threadId, 'error');
      else if (kind === 'INPUT_NODIG') this.#setSticky(item.threadId, 'waiting');
    }
    this.usage?.record(item, result);
    this.retryPolicy?.clear(item.id);
    // Project-geheugen: één regel per opdracht, gaat mee bij een nieuw gesprek.
    this.projectMemory?.append(item.projectId, { prompt: item.content, answer });

    // EERST het antwoord versturen, DAARNA het statusbericht op 🟢 zetten: zo kan
    // een mislukte send nooit een "klaar"-melding zonder antwoord achterlaten.
    if (answer.length > 1700) {
      // Discord knipt op 2000 tekens. Bijlage als .txt — .md is op mobiel niet
      // in te zien. Eerste regels blijven leesbaar in de chat zelf.
      const preview = answer.slice(0, 1200).trimEnd();
      await this.runStatus.answer(item, `${preview}\n\n…(volledig antwoord in de bijlage)`, [
        { name: `antwoord-${item.id.slice(4, 12)}.txt`, content: answer },
      ]);
    } else {
      await this.runStatus.answer(item, answer);
    }
    await this.runStatus.done(item);
    if (result.finalReport) {
      const markdown = result.finalReport.markdown ?? '';
      await this.outbox.dispatchFinalReport({
        projectId: item.projectId,
        missionId: result.finalReport.missionId,
        reportId: result.finalReport.reportId,
        reportHash: sha256(markdown),
        threadId: item.threadId,
        summary: result.finalReport.summary ?? 'Eindrapport',
        reportText: markdown,
        dashboardLink: result.finalReport.dashboardLink ?? null,
      });
    }
  }

  // Rood/groen: bij het kanaal (naam-prefix, zichtbaar op mobiel) + bot-presence
  // + typing-indicator. Geen extra chatberichten.
  #runStarted(item) {
    this.runStatus.running(item)?.catch?.(() => {});
    this.indicator.set(item.threadId, true);
    this.#updatePresence();
    const ping = () => this.transport.sendTyping?.(item.threadId)?.catch?.(() => {});
    ping();
    this.typingTimers.set(item.threadId, setInterval(ping, 8000));
  }

  // Fout/input-nodig blijft staan tot de owner een nieuwe opdracht stuurt.
  #setSticky(threadId, state) {
    this.stickyState.set(threadId, state);
    this.indicator.set(threadId, state);
  }

  #runSettled(item) {
    const timer = this.typingTimers.get(item.threadId);
    if (timer) clearInterval(timer);
    this.typingTimers.delete(item.threadId);
    // Alleen op groen als er niets meer wacht in dit kanaal EN er geen
    // openstaande fout/vraag is.
    const stillBusy = this.queue.items.some(
      (i) =>
        i.threadId === item.threadId &&
        ['QUEUED', 'STARTING', 'RUNNING'].includes(i.state),
    );
    if (!stillBusy && !this.stickyState.has(item.threadId)) {
      this.indicator.set(item.threadId, false);
    }
    this.#updatePresence();
  }

  // Fouten krijgen een ECHTE ping (een edit geeft geen notificatie op je telefoon)
  // plus het item-id en de manier om het opnieuw te proberen. Tijdelijke fouten
  // (netwerk, rate limit) worden eerst stil automatisch herhaald.
  async #deliverError(item, err) {
    if (this.retryPolicy?.shouldRetry(item, err)) {
      const { attempt, delay } = this.retryPolicy.schedule(item, err, (target) => {
        this.queue.requeue(target.id);
        this.scheduler.tick();
      });
      await this.runStatus
        .running(item)
        ?.catch?.(() => {});
      this.runStatus.progress(
        item,
        `tijdelijke fout — poging ${attempt} over ${Math.round(delay / 1000)}s`,
      );
      return;
    }
    this.retryPolicy?.clear(item.id);
    this.#setSticky(item.threadId, 'error');
    const reason = friendlyError(err);
    await this.runStatus.failed(item, reason);
    await this.runStatus
      .answer(
        item,
        `🟠 **Mislukt** — ${reason}\nOpnieuw proberen: \`/forge retry ${item.id.slice(0, 12)}\``,
      )
      .catch(() => {});
  }

  #updatePresence() {
    const active = this.scheduler.activeCount();
    const promise =
      active > 0
        ? this.transport.setBusy?.(true, `${active} run${active > 1 ? 's' : ''} bezig`)
        : this.transport.setBusy?.(false, 'vrij');
    promise?.catch?.(() => {});
  }

  #advanceCursor(threadId, messageId) {
    this.cursors.lastSeen[threadId] = messageId;
    this.cursorStore.save(this.cursors);
  }

  // Herstart/reconnect (plan §5 OFFLINE): geschiedenis na de laatst geziene
  // message-ID per thread backfillen via REST en door de normale pijplijn halen;
  // dedup in de queue garandeert exact-één-verwerking.
  async reconcile() {
    this.audit.record('reconcile_started', {});
    // Ook threads ontdekken die tijdens offline zijn aangemaakt: per
    // geregistreerd (niet-gearchiveerd) forumkanaal de threads opvragen.
    const threads = new Set(this.#knownThreads());
    for (const project of this.router.projects.filter((p) => !p.archived)) {
      // Tekstkanaal-modus: het kanaal zelf is de "thread". Bij een echt
      // forumkanaal faalt fetchSince hierop; dat vangt de try/catch hieronder.
      threads.add(project.forumChannelId);
      if (typeof this.transport.listThreads === 'function') {
        for (const t of await this.transport.listThreads(project.forumChannelId)) threads.add(t);
      }
    }
    let recovered = 0;
    for (const threadId of threads) {
      const after = this.cursors.lastSeen[threadId] ?? null;
      let missed = [];
      try {
        missed = await this.transport.fetchSince(threadId, after);
      } catch (err) {
        this.audit.record('reconcile_thread_error', {
          threadId,
          error: String(err?.message ?? err),
        });
        continue;
      }
      for (const msg of missed) {
        const r = await this.handleIncoming(msg);
        if (r.handled) recovered += 1;
      }
    }
    this.audit.record('reconcile_completed', { recovered });
    return recovered;
  }

  #knownThreads() {
    const set = new Set(Object.keys(this.router.conversations));
    for (const t of Object.keys(this.cursors.lastSeen)) set.add(t);
    return [...set];
  }

  stop(threadId) {
    return this.scheduler.stop(threadId);
  }

  shutdown() {
    this.scheduler.shutdown();
    this.runStatus.stop();
    this.indicator.stop();
    for (const timer of this.typingTimers.values()) clearInterval(timer);
    this.typingTimers.clear();
    this.audit.record('gateway_shutdown', {});
  }

  status() {
    return {
      transportConnected: this.transport.connected ?? null,
      queueDepth: this.queue.depth(),
      activeRuns: this.scheduler.activeCount(),
      deliveries: this.outbox.list().map((d) => ({ id: d.id, state: d.state })),
    };
  }

  // Draineert de VOLLEDIGE pijplijn: in-flight message-handling én actieve runs.
  async whenIdle() {
    while (this.pending.size > 0 || this.scheduler.activeCount() > 0) {
      await Promise.allSettled([...this.pending]);
      await this.scheduler.whenIdle();
    }
  }
}
