// 🔴/🟢 zichtbaar BIJ het kanaal (in de kanaallijst, dus ook op mobiel) door de
// kanaalnaam te prefixen.
//
// Discord deelt naam+topic in één bucket: ~2 wijzigingen per 10 min per kanaal,
// en een 429 hier kan ~10 minuten ALLE /channels-acties blokkeren (dus ook je
// statusbericht-edits). Daarom (research 2026-07-30):
//   - token-bucket met trage refill (1 per 6 min, capaciteit 2);
//   - 1 token gereserveerd voor kritieke overgangen (fout / input nodig);
//   - hysterese zodat de naam niet flappert tussen twee snelle runs;
//   - latest-wins: nooit een tweede rename in de wachtrij, alleen de nieuwste wens.
// Discord staat ~2 kanaalwijzigingen per 10 min toe. Met 1 token per 2,5 min en
// capaciteit 3 kan 🔴→🟢 binnen één run rond zonder minuten op groen te wachten;
// de hysterese (8s/90s) voorkomt dat korte runs het budget opsouperen.
const REFILL_MS = 150_000;
const CAPACITY = 3;
const TICK_MS = 15_000;

export const STATES = {
  busy: { emoji: '🔴', hysteresisMs: 8_000, critical: false },
  idle: { emoji: '🟢', hysteresisMs: 90_000, critical: false },
  error: { emoji: '🟠', hysteresisMs: 0, critical: true },
  waiting: { emoji: '🔵', hysteresisMs: 0, critical: true },
};

export const stripIndicator = (name) =>
  String(name ?? '').replace(/^(?:🔴|🟢|🟠|🔵|⚪)[-–—\s]*/u, '');

export class ChannelIndicator {
  constructor({ transport, audit, now = () => Date.now() }) {
    this.transport = transport;
    this.audit = audit;
    this.now = now;
    this.channels = new Map();
    this.timer = null;
  }

  #entry(channelId) {
    if (!this.channels.has(channelId)) {
      this.channels.set(channelId, {
        desired: null,
        desiredSince: 0,
        applied: null,
        tokens: CAPACITY,
        lastRefill: this.now(),
        blockedUntil: 0,
      });
    }
    return this.channels.get(channelId);
  }

  set(channelId, stateOrBusy) {
    const state =
      typeof stateOrBusy === 'boolean' ? (stateOrBusy ? 'busy' : 'idle') : stateOrBusy;
    if (!STATES[state]) return;
    const entry = this.#entry(channelId);
    if (entry.desired !== state) {
      entry.desired = state;
      entry.desiredSince = this.now();
    }
    this.#ensureTimer();
    this.#tick(channelId);
  }

  #refill(entry) {
    const elapsed = this.now() - entry.lastRefill;
    if (elapsed < REFILL_MS) return;
    const gained = Math.floor(elapsed / REFILL_MS);
    entry.tokens = Math.min(CAPACITY, entry.tokens + gained);
    entry.lastRefill += gained * REFILL_MS;
  }

  #tick(channelId) {
    const entry = this.#entry(channelId);
    if (!entry.desired || entry.desired === entry.applied) return;
    if (this.now() < entry.blockedUntil) return;
    const spec = STATES[entry.desired];
    if (this.now() - entry.desiredSince < spec.hysteresisMs) return; // nog niet stabiel
    this.#refill(entry);
    // Kritieke meldingen (fout/vraag) mogen het laatste token gebruiken; routine
    // laat er één over zodat een fout altijd nog gemeld kan worden.
    const needed = spec.critical ? 1 : 2;
    if (entry.tokens < needed) return;


    entry.tokens -= 1;
    const want = entry.desired;
    entry.applied = want;
    Promise.resolve(this.transport.setChannelPrefix?.(channelId, spec.emoji))
      .then(() => this.audit?.record('channel_indicator_set', { channelId, state: want }))
      .catch((err) => {
        entry.applied = null;
        entry.tokens = 0;
        // Bij een 429 het kanaal pauzeren tot na retry_after (+marge).
        const retryMs = (err?.retryAfter ?? err?.timeToReset ?? 0) || REFILL_MS;
        entry.blockedUntil = this.now() + retryMs + 5000;
        this.audit?.record('channel_indicator_failed', {
          channelId,
          error: String(err?.message ?? err),
          blockedMs: retryMs,
        });
      });
  }

  #ensureTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      for (const channelId of this.channels.keys()) this.#tick(channelId);
    }, TICK_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
