import { newId } from './ids.js';

// Idee B: goedkeuring met knoppen op de telefoon. Bij een risicovolle opdracht
// (verwijderen, deployen, geld uitgeven, pushen) vraagt de bot eerst om
// bevestiging met [Ja] [Nee] in plaats van dat je moet typen.
//
// De detectie kijkt naar de OPDRACHT van de eigenaar, niet naar modeloutput:
// zo kan tekst uit een bijlage of een antwoord nooit zelf een gate openen.
const RISKY = [
  { re: /\b(deploy|deployen|uitrollen|naar productie|live zetten)\b/i, label: 'deployen naar productie' },
  { re: /\b(git\s+push|force\s*push|pushen naar (main|master))\b/i, label: 'code pushen' },
  { re: /\b(verwijder(en)?|delete|wis(sen)?|rm\s+-rf|drop\s+(table|database))\b/i, label: 'iets verwijderen' },
  { re: /\b(betaal|afrekenen|aankoop|koop|abonnement afsluiten|credits kopen)\b/i, label: 'geld uitgeven' },
  { re: /\b(dns|domein|nameserver)\b/i, label: 'DNS/domein wijzigen' },
  { re: /\b(mail(en)? (naar|aan)|verstuur.*(mail|email)|sms|bel(len)?)\b/i, label: 'iets naar buiten versturen' },
];

export function detectRisk(content) {
  const text = String(content ?? '');
  for (const r of RISKY) if (r.re.test(text)) return r.label;
  return null;
}

export class Approvals {
  constructor({ audit, timeoutMs = 30 * 60 * 1000, now = () => Date.now() } = {}) {
    this.audit = audit;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.pending = new Map(); // approvalId -> { item, label, createdAt }
  }

  create(item, label) {
    const id = newId('apr').slice(0, 20);
    this.pending.set(id, { item, label, createdAt: this.now() });
    this.audit?.record('approval_requested', { approvalId: id, itemId: item.id, label });
    return { id, label };
  }

  get(id) {
    const entry = this.pending.get(id);
    if (!entry) return null;
    if (this.now() - entry.createdAt > this.timeoutMs) {
      this.pending.delete(id);
      this.audit?.record('approval_expired', { approvalId: id });
      return null;
    }
    return entry;
  }

  resolve(id, approved) {
    const entry = this.get(id);
    if (!entry) return null;
    this.pending.delete(id);
    this.audit?.record(approved ? 'approval_granted' : 'approval_denied', {
      approvalId: id,
      itemId: entry.item.id,
      label: entry.label,
    });
    return { ...entry, approved };
  }

  // Verlopen aanvragen opruimen (voorkomt onbegrensde Map).
  sweep() {
    for (const [id, entry] of this.pending) {
      if (this.now() - entry.createdAt > this.timeoutMs) {
        this.pending.delete(id);
        this.audit?.record('approval_expired', { approvalId: id });
      }
    }
  }

  static buttonRows(approvalId) {
    return [
      {
        type: 1, // action row
        components: [
          { type: 2, style: 3, custom_id: `forge_ok:${approvalId}`, label: 'Ja, doe het' },
          { type: 2, style: 4, custom_id: `forge_no:${approvalId}`, label: 'Nee' },
        ],
      },
    ];
  }
}
