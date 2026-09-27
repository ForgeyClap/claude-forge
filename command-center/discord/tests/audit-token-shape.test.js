// WP-L2 Codex-bevinding 3 (deel 1): DISCORD_TOKEN_RE in audit.js herkende eerder alleen 23-28/6-7/
// 25+ tekens per segment — SMALLER dan de gedeelde vorm die de gateway-kant accepteert
// (`DISCORD_BOT_TOKEN_CORE_SOURCE` in gateway/src/redact.mjs, 10-70/3-20/10-70; dezelfde vorm die
// discord-service.mjs's isValidBotTokenFormat() gebruikt om een token op de weg IN goed te keuren).
// Deze test bouwt het KLEINSTE tokenformaat dat de gateway nog als geldig accepteert (10/3/10
// tekens) en toont dat audit.js's redactSecrets() het nu ook herkent — vóór de fix faalde dit
// (het monster was te kort voor de oude 23/6-7/25+ ondergrens en bleef onveranderd, leesbaar staan).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets } from '../src/audit.js';

// In stukjes opgebouwd (nooit een letterlijke token-vormige string op één plek) — dezelfde
// GitHub-push-protection-ontwijking die misc.test.js's eigen audit-test al documenteert.
const MIN_SHAPE_TOKEN = ['a'.repeat(10), 'b'.repeat(3), 'c'.repeat(10)].join('.');

test('WP-L2 finding 3: redactSecrets herkent de gedeelde MINIMUM tokenvorm (10/3/10 tekens) die de gateway-validator ook accepteert', () => {
  // "leaked" ipv "token=" in de omgevende tekst, zodat dit specifiek DISCORD_TOKEN_RE test en niet
  // per ongeluk via KEYED_SECRET_RE (dat alleen op token=/secret=/... trigger) toevallig slaagt.
  const line = `leaked in log: ${MIN_SHAPE_TOKEN} end of line`;
  const redacted = redactSecrets(line);
  assert.equal(redacted.includes(MIN_SHAPE_TOKEN), false, 'de minimum-vorm token moet geredigeerd worden, niet leesbaar blijven staan');
  assert.match(redacted, /\[REDACTED\]/);
});

test('a token shorter than the shared minimum shape (9/2/9) is correctly left alone by DISCORD_TOKEN_RE (no over-matching)', () => {
  const tooShort = ['a'.repeat(9), 'b'.repeat(2), 'c'.repeat(9)].join('.');
  const line = `leaked in log: ${tooShort} end of line`;
  const redacted = redactSecrets(line);
  assert.equal(redacted, line, 'a below-minimum shape must not be treated as a Discord bot token');
});
