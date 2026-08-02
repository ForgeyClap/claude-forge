// Eén statusbericht per opdracht dat wordt BEWERKT (ontvangen → bezig → klaar),
// in plaats van drie losse berichten. Voorkomt zowel de volgorde-race als het
// vollopen van het kanaal. Message-edits zijn goedkoop bij Discord.
export class RunStatus {
  constructor({ transport, audit, ownerUserIds = [] }) {
    this.transport = transport;
    this.audit = audit;
    this.ownerUserIds = ownerUserIds;
    this.messages = new Map(); // itemId -> Promise<messageId|null>
    this.startedAt = new Map(); // itemId -> ms
    this.steps = new Map(); // itemId -> string[]
    this.lastProgressAt = new Map(); // itemId -> ms
    this.heartbeats = new Map(); // itemId -> interval
  }

  // Minimaal 12s tussen twee voortgangs-edits (ruim binnen de kanaallimiet).
  static PROGRESS_MS = 12_000;
  // Hartslag als er geen nieuwe stappen komen (lange denk- of buildstap).
  static HEARTBEAT_MS = 75_000;

  #ping() {
    return this.ownerUserIds.length ? `<@${this.ownerUserIds[0]}> ` : '';
  }

  static duration(ms) {
    const s = Math.round(ms / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  }

  // Direct aanroepen bij binnenkomst; retourneert niets (fire-and-forget), maar de
  // messageId-promise wordt bewaard zodat latere updates er netjes op wachten.
  begin(item, text) {
    const promise = Promise.resolve(this.transport.send(item.threadId, text))
      .then((res) => res?.messageId ?? null)
      .catch(() => null);
    this.messages.set(item.id, promise);
    return promise;
  }

  async #edit(item, text) {
    const messageId = await this.messages.get(item.id);
    if (!messageId) {
      // Geen statusbericht (bv. na herstart): stuur er alsnog één.
      return this.begin(item, text);
    }
    try {
      await this.transport.edit(messageId, text, item.threadId);
    } catch (err) {
      this.audit?.record('status_edit_failed', { itemId: item.id, error: String(err?.message ?? err) });
    }
    return messageId;
  }

  running(item) {
    this.startedAt.set(item.id, Date.now());
    this.steps.set(item.id, []);
    // Hartslag: ook zonder nieuwe stappen blijft de verstreken tijd meelopen, zodat
    // je op je telefoon ziet dat hij nog leeft (en hoe lang hij al bezig is).
    const beat = setInterval(() => this.#beat(item), RunStatus.HEARTBEAT_MS);
    if (typeof beat.unref === 'function') beat.unref();
    this.heartbeats.set(item.id, beat);
    return this.#edit(item, `🔴 **Bezig** — "${item.content.slice(0, 100)}"\n_gestart, ik meld me zodra het klaar is_`);
  }

  #beat(item) {
    if (!this.startedAt.has(item.id)) return;
    this.lastProgressAt.set(item.id, Date.now());
    this.#edit(item, this.#bezigTekst(item))?.catch?.(() => {});
  }

  #bezigTekst(item) {
    const started = this.startedAt.get(item.id) ?? Date.now();
    const took = RunStatus.duration(Date.now() - started);
    const steps = this.steps.get(item.id) ?? [];
    const recent = steps.slice(-3).map((s) => `• ${s}`).join('\n');
    const laatste = steps.length
      ? `\n${recent}`
      : '\n_nog geen stappen gemeld — hij denkt of draait een lange stap_';
    return `🔴 **Bezig** (${took}) — "${item.content.slice(0, 80)}"${laatste}`;
  }

  // Live voortgang: laatste 3 stappen in hetzelfde statusbericht, hooguit één
  // edit per PROGRESS_MS (Discord-edits zijn goedkoop, maar niet gratis).
  progress(item, text) {
    const steps = this.steps.get(item.id);
    if (!steps) return;
    if (steps[steps.length - 1] === text) return; // geen herhaling
    steps.push(text);
    const last = this.lastProgressAt.get(item.id) ?? 0;
    if (Date.now() - last < RunStatus.PROGRESS_MS) return;
    this.lastProgressAt.set(item.id, Date.now());
    this.#edit(item, this.#bezigTekst(item))?.catch?.(() => {});
  }

  async done(item, { extra = '' } = {}) {
    const took = RunStatus.duration(Date.now() - (this.startedAt.get(item.id) ?? Date.now()));
    const steps = this.steps.get(item.id) ?? [];
    const stepInfo = steps.length ? `\n_${steps.length} stappen uitgevoerd_` : '';
    await this.#edit(item, `🟢 **Klaar** in ${took} — "${item.content.slice(0, 80)}"${stepInfo}${extra}`);
    this.cleanup(item.id);
    return took;
  }

  async failed(item, error) {
    await this.#edit(item, `🟠 **Mislukt** — ${String(error).slice(0, 300)}`);
    this.cleanup(item.id);
  }

  async cancelled(item) {
    await this.#edit(item, `⚪ **Gestopt** — "${item.content.slice(0, 80)}"`);
    this.cleanup(item.id);
  }

  // Ping + eindantwoord als apart bericht (zodat de notificatie op de telefoon komt).
  answer(item, text, files = []) {
    return this.transport.send(item.threadId, `${this.#ping()}${text}`, files);
  }

  messageIdFor(item) {
    return this.messages.get(item.id) ?? null;
  }

  cleanup(itemId) {
    const beat = this.heartbeats.get(itemId);
    if (beat) clearInterval(beat);
    this.heartbeats.delete(itemId);
    this.messages.delete(itemId);
    this.startedAt.delete(itemId);
    this.steps.delete(itemId);
    this.lastProgressAt.delete(itemId);
  }

  // Alle timers stoppen bij afsluiten (voorkomt hangende intervals).
  stop() {
    for (const beat of this.heartbeats.values()) clearInterval(beat);
    this.heartbeats.clear();
  }
}
