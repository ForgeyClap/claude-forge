import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Leest de OFFICIËLE abonnements-usage (dezelfde bron als /usage in Claude Code):
// sessie (5 uur), week (7 dagen) en de model-specifieke weekbalk (bv. "Fable").
//
// Veiligheid: het OAuth-token wordt uitsluitend read-only uit het lokale
// credentials-bestand gelezen en NOOIT gelogd, doorgestuurd of in een bericht
// gezet. Alleen de percentages/resettijden verlaten deze module.
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CRED_FILE = path.join(os.homedir(), '.claude', '.credentials.json');

function readToken() {
  try {
    const raw = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
    return raw?.claudeAiOauth?.accessToken ?? raw?.accessToken ?? null;
  } catch {
    return null;
  }
}

export function bar(percent, width = 10) {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

export function resetIn(iso, now = Date.now()) {
  const ms = new Date(iso).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return 'nu';
  const h = Math.floor(ms / 3600000);
  const d = Math.floor(h / 24);
  if (d >= 1) return `${d}d`;
  return h >= 1 ? `${h}u` : `${Math.max(1, Math.round(ms / 60000))}m`;
}

export function normalize(payload) {
  const out = [];
  for (const l of payload?.limits ?? []) {
    const model = l.scope?.model?.display_name ?? null;
    const label =
      l.kind === 'session'
        ? 'Sessie (5 uur)'
        : l.kind === 'weekly_all'
          ? 'Week (7 dagen)'
          : model
            ? `Week ${model}`
            : 'Week (overig)';
    out.push({
      kind: l.kind,
      label,
      percent: Number(l.percent) || 0,
      resetsAt: l.resets_at ?? null,
      severity: l.severity ?? 'normal',
    });
  }
  // Fallback voor accounts zonder `limits`-array.
  if (out.length === 0 && payload?.five_hour) {
    out.push({
      kind: 'session',
      label: 'Sessie (5 uur)',
      percent: Number(payload.five_hour.utilization) || 0,
      resetsAt: payload.five_hour.resets_at ?? null,
      severity: 'normal',
    });
  }
  const credits = payload?.extra_usage?.is_enabled
    ? {
        utilization: payload.extra_usage.utilization ?? null,
        usedCredits: payload.extra_usage.used_credits ?? null,
        limitReached: Boolean(payload.extra_usage.spend_limit_reached),
      }
    : null;
  return { limits: out, credits, fetchedAt: Date.now() };
}

export class SubscriptionUsage {
  constructor({ cacheMs = 60_000, now = () => Date.now(), fetchImpl = null } = {}) {
    this.cacheMs = cacheMs;
    this.now = now;
    this.fetchImpl = fetchImpl ?? ((url, opts) => fetch(url, opts));
    this.cache = null;
  }

  async get({ force = false } = {}) {
    if (!force && this.cache && this.now() - this.cache.fetchedAt < this.cacheMs) return this.cache;
    const token = readToken();
    if (!token) return { unavailable: 'geen lokaal Claude-token gevonden', limits: [] };
    let payload;
    try {
      const res = await this.fetchImpl(USAGE_URL, {
        headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return { unavailable: `endpoint gaf status ${res.status}`, limits: [] };
      payload = await res.json();
    } catch (err) {
      // Nooit de foutmelding met headers/token doorgeven — alleen de reden.
      return { unavailable: `niet op te halen (${String(err?.message ?? err).slice(0, 60)})`, limits: [] };
    }
    this.cache = normalize(payload);
    return this.cache;
  }

  // Compacte, mobiel-leesbare weergave.
  static format(usage) {
    if (usage.unavailable) return `📊 Abonnement-verbruik: ${usage.unavailable}`;
    const lines = usage.limits.map(
      (l) =>
        `${l.severity === 'normal' ? '' : '⚠️ '}${l.label}: ${bar(l.percent)} ${l.percent}%` +
        (l.resetsAt ? ` _(reset in ${resetIn(l.resetsAt)})_` : ''),
    );
    if (usage.credits) {
      lines.push(
        `Extra credits: ${usage.credits.utilization ?? '?'}%${usage.credits.limitReached ? ' — LIMIET BEREIKT' : ''}`,
      );
    }
    return lines.join('\n');
  }

  // Hoogste actieve percentage — voor de pauzeerdrempel van de bot.
  static peak(usage) {
    return (usage.limits ?? []).reduce((max, l) => Math.max(max, l.percent), 0);
  }
}
