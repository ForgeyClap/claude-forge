// Idee G: automatisch herstel bij TIJDELIJKE fouten. Een netwerkhik of rate-limit
// hoort de eigenaar niet te bereiken; een echte fout (verkeerde opdracht, code
// die niet compileert) wel — die moet hij juist zien.
import { redactAndCap } from './audit.js';
const TRANSIENT = [
  /rate.?limit|429/i,
  /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed/i,
  /50[234]\b|overloaded|temporarily unavailable/i,
  /timeout/i,
];

export function isTransient(err) {
  const text = String(err?.message ?? err ?? '');
  // Een door de eigenaar afgebroken run is geen fout om te herhalen.
  if (/aborted/i.test(text)) return false;
  return TRANSIENT.some((re) => re.test(text));
}

// Exponentiële backoff met een plafond: 30s, 60s, 120s.
export function backoffMs(attempt) {
  return Math.min(120_000, 30_000 * 2 ** Math.max(0, attempt - 1));
}

export class RetryPolicy {
  constructor({ maxAutoRetries = 3, audit, now = () => Date.now() } = {}) {
    this.maxAutoRetries = maxAutoRetries;
    this.audit = audit;
    this.now = now;
    this.attempts = new Map(); // itemId -> aantal automatische pogingen
    this.timers = new Set();
  }

  // Retourneert true als de fout automatisch wordt herhaald (dan geen melding
  // naar de eigenaar); false als hij de fout moet zien.
  shouldRetry(item, err) {
    if (!isTransient(err)) return false;
    const done = this.attempts.get(item.id) ?? 0;
    return done < this.maxAutoRetries;
  }

  schedule(item, err, requeue) {
    const attempt = (this.attempts.get(item.id) ?? 0) + 1;
    this.attempts.set(item.id, attempt);
    const delay = backoffMs(attempt);
    this.audit?.record('auto_retry_scheduled', {
      itemId: item.id,
      attempt,
      delayMs: delay,
      // fix-cap-order: was `.slice(0, 200)` — afkappen VÓÓR de redactie in AuditLedger.record().
      // Een Discord-bottoken in een foutmelding dat over teken 200 heen liep verloor zijn derde
      // segment, matchte daardoor niet meer, en belandde leesbaar in de ledger.
      error: redactAndCap(String(err?.message ?? err), 200),
    });
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      requeue(item, attempt);
    }, delay);
    if (typeof timer.unref === 'function') timer.unref();
    this.timers.add(timer);
    return { attempt, delay };
  }

  clear(itemId) {
    this.attempts.delete(itemId);
  }

  stop() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}
