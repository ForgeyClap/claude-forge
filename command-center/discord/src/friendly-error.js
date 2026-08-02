import { redactSecrets } from './audit.js';

// Ruwe CLI-fouten omzetten naar één begrijpelijke Nederlandse regel — en altijd
// door de secret-redactie, want stderr kan tokens of paden bevatten.
const PATTERNS = [
  [/runner timeout na (\d+)ms/i, (m) => `tijd op na ${Math.round(Number(m[1]) / 60000)} minuten`],
  [/aborted/i, () => 'gestopt'],
  [/ENOENT|not recognized|command not found/i, () => 'Claude Code kon niet gestart worden (claude niet gevonden)'],
  [/rate.?limit|429/i, () => 'te veel verzoeken (rate limit) — even wachten en opnieuw proberen'],
  [/ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed/i, () => 'netwerkprobleem'],
  [/EACCES|EPERM|permission denied/i, () => 'geen rechten op een bestand of map'],
  [/usage limit|quota/i, () => 'verbruikslimiet bereikt'],
  [/claude exit (\d+)/i, (m) => `Claude stopte met foutcode ${m[1]}`],
];

export function friendlyError(err, { maxLength = 220 } = {}) {
  const raw = String(err?.message ?? err ?? 'onbekende fout');
  for (const [re, fn] of PATTERNS) {
    const m = raw.match(re);
    if (m) return fn(m);
  }
  return redactSecrets(raw).slice(0, maxLength);
}
