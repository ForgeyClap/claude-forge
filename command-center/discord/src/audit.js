import { JsonlLog } from './store.js';

// Discord-bottokens hebben de vorm <base64 id>.<6-7 tekens>.<27+ tekens>;
// daarnaast generieke key=value-secrets afdekken vóór iets de ledger raakt.
const DISCORD_TOKEN_RE = /[\w-]{23,28}\.[\w-]{6,7}\.[\w-]{25,}/g;
const KEYED_SECRET_RE = /((?:token|secret|password|api[_-]?key)["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi;
const WEBHOOK_RE = /https?:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\/\S+/gi;
const ANTHROPIC_KEY_RE = /sk-ant-[\w-]{10,}/gi;
const BEARER_RE = /(Bearer\s+)[\w.-]{16,}/gi;

export function redactSecrets(text) {
  return String(text)
    .replace(DISCORD_TOKEN_RE, '[REDACTED]')
    .replace(WEBHOOK_RE, '[REDACTED_WEBHOOK]')
    .replace(ANTHROPIC_KEY_RE, '[REDACTED_KEY]')
    .replace(BEARER_RE, '$1[REDACTED]')
    .replace(KEYED_SECRET_RE, '$1[REDACTED]');
}

// Redacteren PER STRINGWAARDE. Redacteren over geserialiseerde JSON kon de JSON
// zelf breken (een quote in de invoer maakte record() gooien en de bot stoppen).
const SECRET_KEY_RE = /token|secret|password|api[_-]?key|webhook|credential|authorization/i;

export function redactDeep(value, depth = 0) {
  if (depth > 8) return '[te diep]';
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // Ook op SLEUTELNAAM redacteren: bij per-waarde redactie is de context
      // ("token=") weg, dus {token: 'abc'} zou anders ongemerkt doorglippen.
      out[k] = SECRET_KEY_RE.test(k) && typeof v === 'string' ? '[REDACTED]' : redactDeep(v, depth + 1);
    }
    return out;
  }
  return value;
}

// DE ENIGE MANIER OM EEN VRIJE-TEKSTWAARDE IN TE KORTEN (fix-cap-order).
// Redigeert op de VOLLE lengte en kapt daarna pas af — nooit andersom.
//
// Andersom breekt elk patroon dat een staart nodig heeft om te matchen. DISCORD_TOKEN_RE is er zo
// een: `<id>.<timestamp>.<hmac>`. Wordt er eerst afgekapt middenin het derde segment, dan matcht de
// regex niets meer en blijft `MTIzNDU2Nzg5MDEyMzQ1Njc4.Gh1jKl.aaaaaaaaaa` gewoon leesbaar in de
// ledger staan — gemeten via retry-policy.js's `.slice(0, 200)` vóór `record()`. Redigeren-dan-kappen
// levert op exact dezelfde invoer `[REDACTED]` op.
//
// Dit is dezelfde fout die in dit project al eerder in `.claude/forge-bin/forge-toolhook.cjs` en in de
// gateway (`command-center/gateway/src/redact.mjs` — `redactAndCap`) is gevonden. Daarom staat de
// volgorde hier in ÉÉN functie, naast de patronen die hij beschermt: een aanroeper kan de volgorde
// niet meer omdraaien zonder deze functie zelf te bewerken.
export function redactAndCap(value, maxLength) {
  const redacted = redactSecrets(value);
  return redacted.length > maxLength ? redacted.slice(0, maxLength) : redacted;
}

export class AuditLedger {
  constructor(filePath, { now = () => new Date().toISOString() } = {}) {
    this.log = new JsonlLog(filePath);
    this.now = now;
  }

  record(type, data = {}) {
    try {
      const entry = { ts: this.now(), type, ...redactDeep(data) };
      this.log.append(entry);
      return entry;
    } catch {
      // Loggen mag NOOIT de aanroeper laten crashen.
      return null;
    }
  }

  readAll() {
    return this.log.readAll();
  }
}
