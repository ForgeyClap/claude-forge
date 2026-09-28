import { redactSecrets } from './audit.js';

// Ruwe CLI-fouten omzetten naar één begrijpelijke Nederlandse regel — en altijd
// door de secret-redactie, want stderr kan tokens of paden bevatten.
const PATTERNS = [
  // Discord weigert een actie omdat de bot een recht mist (50013) of iets niet kan zien (50001): zeg welk recht
  // en waar je het geeft, in plaats van een kale API-fout (live gevonden 2026-09-28).
  [/Missing Permissions|\b50013\b/i, () => 'de bot mist een Discord-recht: geef de rol van de bot "Kanalen beheren" (Serverinstellingen → Rollen), of nodig de bot opnieuw uit met dat recht'],
  [/Missing Access|\b50001\b/i, () => 'de bot kan dit kanaal of deze categorie niet zien: geef de rol van de bot toegang (Serverinstellingen → Rollen, of de rechten van het kanaal)'],
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
