// SECURITY — REDACT-BEFORE-CAP ORDERING (fix-cap-order), Discord-zijde.
//
// DEZELFDE KLASSE als in de gateway: een waarde wordt eerst afgekapt en PAS DAARNA geredigeerd. Elk
// patroon dat een staart nodig heeft om te matchen, matcht dan niet meer en laat een leesbare kop
// achter. In `redactSecrets` is DISCORD_TOKEN_RE (`<id>.<timestamp>.<hmac>`) precies zo'n patroon:
// kap af middenin het derde segment en `MTIzNDU2Nzg5MDEyMzQ1Njc4.Gh1jKl.aaaaaaaaaa` blijft staan.
//
// Deze test somt de gevallen niet op maar GENEREERT ze: elk patroon uit redactSecrets krijgt een
// monster, en elk monster wordt over elke echte cap-grens heen gelegd op meerdere dieptes. De
// COVERAGE GATE onderaan faalt zodra redactSecrets een patroon krijgt waarvoor hier geen monster
// bestaat, zodat een volgende ontwikkelaar niet ongemerkt buiten de dekking kan vallen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactAndCap, redactSecrets, AuditLedger } from '../src/audit.js';
import { RetryPolicy } from '../src/retry-policy.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Eén monster per patroon in redactSecrets, plus de VERZWAKTE vorm ervan: hoe een gelekte kop eruit
// ziet. `[REDACTED]` matcht met opzet geen van deze verzwakte vormen.
const SECRETS = {
  discord_bot_token: {
    build: () => 'MTIzNDU2Nzg5MDEyMzQ1Njc4.Gh1jKl.' + 'a'.repeat(40),
    partial: /[\w-]{23,28}\.[\w-]{6,7}\./,
  },
  discord_webhook: {
    build: () => 'https://discord.com/api/webhooks/123456789012345678/' + 'w'.repeat(60),
    partial: /https?:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\/\S/,
  },
  anthropic_key: {
    build: () => 'sk-ant-' + 'A1b2C3d4E5'.repeat(6),
    partial: /sk-ant-[\w-]{6,}/,
  },
  bearer: {
    build: () => 'Bearer ' + 'T0k3n.value-'.repeat(6),
    partial: /Bearer\s+[\w.-]{8,}/,
  },
  keyed_secret: {
    // KEYED_SECRET_RE vervangt alleen de WAARDE (`$1[REDACTED]`), dus de sleutelnaam `api_key=` hoort
    // te blijven staan — die is geen geheim. De negatieve lookahead zorgt dat de markering zelf niet
    // als lek wordt gelezen; alles wat NIET met `[REDACTED` begint is echt waardemateriaal.
    build: () => 'api_key=' + 'S3cr3tV4lu3'.repeat(6),
    partial: /api[_-]?key["']?\s*[:=]\s*["']?(?!\[REDACTED)[^"'\s,}]{6,}/i,
  },
};

test('COVERAGE GATE: elk patroon in redactSecrets heeft hier een monster dat de grens kruist', () => {
  // Afgeleid van het echte gedrag, niet van een handmatige lijst: elk monster MOET volledig
  // geredigeerd worden door redactSecrets. Een patroon dat verdwijnt of verandert laat dit vallen.
  for (const [name, spec] of Object.entries(SECRETS)) {
    const whole = redactSecrets('prefix ' + spec.build() + ' suffix');
    assert.doesNotMatch(whole, spec.partial, `monster '${name}' wordt door redactSecrets niet (meer) volledig geredigeerd`);
    assert.match(whole, /\[REDACTED/, `monster '${name}' levert geen redactiemarkering op`);
  }
});

// De echte caps die in dit project vóór de redactie stonden.
const CAPS = [
  { name: 'retry-policy audit error', cap: 200 },
  { name: 'attachments error', cap: 80 },
  { name: 'friendly-error default', cap: 300 },
];
const STRADDLE_FRACTIONS = [0.1, 0.4, 0.7, 0.95];

for (const { name, cap } of CAPS) {
  for (const [patternName, spec] of Object.entries(SECRETS)) {
    const secret = spec.build();
    for (const fraction of STRADDLE_FRACTIONS) {
      test(`SECURITY: ${patternName} over de cap van ${name} (${Math.round(fraction * 100)}% erbuiten) komt nooit leesbaar door`, () => {
        const past = Math.max(1, Math.min(secret.length - 1, Math.round(secret.length * fraction)));
        const inside = secret.length - past;
        const lead = 'x'.repeat(Math.max(0, cap - inside - 1));
        const field = lead + ' ' + secret + 'x'.repeat(32);
        assert.ok(field.length > cap, 'het gegenereerde veld moet de cap echt overschrijden');

        const out = redactAndCap(field, cap);
        assert.ok(out.length <= cap, `${name} overschreed zijn eigen cap (${out.length} > ${cap})`);
        const hit = spec.partial.exec(out);
        assert.equal(hit, null, `${name} lekte leesbaar ${patternName}-materiaal over de ${cap}-tekens grens: ${JSON.stringify(hit ? hit[0].slice(0, 60) : '')}`);
      });
    }
  }
}

// Het echte pad, niet alleen de helper: RetryPolicy schrijft de foutmelding in de audit-ledger.
test('SECURITY: een bottoken in een fout die de 200-tekens cut kruist belandt niet leesbaar in de audit-ledger', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-cap-order-'));
  const ledgerPath = path.join(dir, 'audit.jsonl');
  try {
    const token = SECRETS.discord_bot_token.build();
    const prefix = 'claude exit 1: auth failed using ';
    // De cut op 200 valt met opzet middenin het derde tokensegment.
    const pad = 200 - prefix.length - (24 + 1 + 6 + 1 + 10);
    const err = new Error('x'.repeat(pad) + prefix + token + ' — rate limit, retrying');

    const audit = new AuditLedger(ledgerPath);
    const policy = new RetryPolicy({ audit, maxAutoRetries: 3 });
    policy.schedule({ id: 'item-1' }, err, () => {});
    policy.clearAll?.();

    const raw = fs.readFileSync(ledgerPath, 'utf8');
    assert.doesNotMatch(raw, SECRETS.discord_bot_token.partial, 'de ledger op schijf bevat leesbaar tokenmateriaal');
    assert.match(raw, /\[REDACTED/, 'de ledger moet de eerlijke redactiemarkering dragen');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
