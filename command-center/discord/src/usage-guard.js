import path from 'node:path';
import { JsonStore } from './store.js';
import { SubscriptionUsage } from './subscription-usage.js';

// Idee K + I: automatisch pauzeren bij hoge usage of een bereikt dagplafond.
// Doel: nooit halverwege een run tegen de limiet aanlopen. Wachtende opdrachten
// blijven bewaard; de eigenaar wordt ÉÉN keer gewaarschuwd (geen statusloop) en
// zodra er weer ruimte is gaat de wachtrij automatisch door.
export class UsageGuard {
  constructor({
    subscriptionUsage,
    usage,
    audit,
    stateDir,
    notify = null, // (tekst) => Promise — één ping bij pauzeren/hervatten
    pauseAtPercent = 90,
    resumeAtPercent = 80,
    dailyCostLimitUsd = 0,
    checkMs = 120_000,
    now = () => Date.now(),
  }) {
    Object.assign(this, {
      subscriptionUsage,
      usage,
      audit,
      notify,
      pauseAtPercent,
      resumeAtPercent,
      dailyCostLimitUsd,
      checkMs,
      now,
    });
    this.store = new JsonStore(path.join(stateDir, 'usage-guard.json'));
    const data = this.store.load({
      paused: false,
      reason: null,
      since: null,
      notified: false,
      manual: false,
    });
    this.state = data;
    this.timer = null;
  }

  #persist() {
    this.store.save(this.state);
  }

  // Handmatige pauze (/forge pause): blijft staan tot /forge resume, ook na een
  // herstart. De automatische evaluatie mag hem NIET opheffen.
  pauseManually(reason = 'handmatig gepauzeerd') {
    this.state = { paused: true, reason, since: this.now(), notified: true, manual: true };
    this.#persist();
    this.audit?.record('usage_guard_paused', { reason, manual: true });
    return this.state;
  }

  resumeManually() {
    this.state = { paused: false, reason: null, since: null, notified: false, manual: false };
    this.#persist();
    this.audit?.record('usage_guard_resumed', { manual: true });
    return this.state;
  }

  get paused() {
    return this.state.paused === true;
  }

  reason() {
    return this.state.reason ?? null;
  }

  // Dagkosten uit de eigen registratie (alleen echte, gerapporteerde kosten).
  #dailyCost() {
    if (!this.usage) return 0;
    return this.usage.summary({ sinceMs: 24 * 3600 * 1000 }).costUsd ?? 0;
  }

  async evaluate() {
    // Een handmatige pauze wordt nooit automatisch opgeheven.
    if (this.state.manual) return this.state;
    let peak = null;
    let usageText = '';
    if (this.subscriptionUsage) {
      const sub = await this.subscriptionUsage.get();
      if (!sub.unavailable) {
        peak = SubscriptionUsage.peak(sub);
        usageText = SubscriptionUsage.format(sub);
      }
    }
    const cost = this.#dailyCost();
    const overCost = this.dailyCostLimitUsd > 0 && cost >= this.dailyCostLimitUsd;
    const overUsage = peak !== null && peak >= this.pauseAtPercent;

    if (!this.paused && (overUsage || overCost)) {
      this.state = {
        paused: true,
        reason: overCost
          ? `dagplafond bereikt ($${cost.toFixed(2)} van $${this.dailyCostLimitUsd})`
          : `verbruik op ${peak}% (pauzeren vanaf ${this.pauseAtPercent}%)`,
        since: this.now(),
        notified: false,
        manual: false,
      };
      this.#persist();
      this.audit?.record('usage_guard_paused', { reason: this.state.reason, peak, cost });
      if (!this.state.notified) {
        this.state.notified = true;
        this.#persist();
        await this.notify?.(
          `⏸️ **Even op pauze** — ${this.state.reason}.\nJe opdrachten blijven bewaard en gaan automatisch door zodra er weer ruimte is.${usageText ? `\n\n${usageText}` : ''}`,
        )?.catch?.(() => {});
      }
      return this.state;
    }

    if (this.paused) {
      // Onbekend verbruik (netwerkfout) mag een verbruik-pauze NIET stil opheffen:
      // dan zou een API-storing de rem eraf halen.
      const usageOk = peak === null ? !/verbruik/.test(this.state.reason ?? '') : peak <= this.resumeAtPercent;
      const costOk = this.dailyCostLimitUsd === 0 || cost < this.dailyCostLimitUsd;
      if (usageOk && costOk) {
        this.state = { paused: false, reason: null, since: null, notified: false, manual: false };
        this.#persist();
        this.audit?.record('usage_guard_resumed', { peak, cost });
        await this.notify?.(
          `▶️ **Weer aan de slag** — verbruik is gezakt${peak !== null ? ` naar ${peak}%` : ''}. Ik pak de wachtrij weer op.`,
        )?.catch?.(() => {});
      }
    }
    return this.state;
  }

  start() {
    this.stop();
    this.timer = setInterval(() => {
      this.evaluate().catch((err) =>
        this.audit?.record('usage_guard_error', { error: String(err?.message ?? err) }),
      );
    }, this.checkMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
