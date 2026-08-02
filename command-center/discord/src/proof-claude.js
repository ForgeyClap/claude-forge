// Anti-false-positive bewijs: draait er ÉCHT een Claude-model achter de runner?
// Test 1: nonce-echo — het antwoord moet een onvoorspelbare code bevatten die
//         alleen een echte model-run kan teruggeven.
// Test 2: geheugen — een tweede run in dezelfde conversatie moet de nonce
//         herinneren (bewijst --resume sessie-continuïteit).
import crypto from 'node:crypto';
import { createClaudeRunner } from './runner-claude.js';
import { SessionStore } from './session-store.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const nonce = `FORGE-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
const sessionStore = new SessionStore(config.stateDir);
const runner = createClaudeRunner({ sessionStore, timeoutMs: 5 * 60 * 1000 });
const conversationId = `proof_${Date.now()}`;

console.log(`Nonce: ${nonce}`);
console.log('Test 1: echte model-run (nonce-echo)…');
const t0 = Date.now();
const r1 = await runner({
  item: { conversationId, content: `Antwoord met exact deze code en niets anders: ${nonce}` },
  signal: new AbortController().signal,
});
const d1 = ((Date.now() - t0) / 1000).toFixed(1);
const pass1 = r1.answer.includes(nonce);
console.log(`  antwoord (${d1}s): ${r1.answer.slice(0, 120)}`);
console.log(`  ${pass1 ? 'PASS' : 'FAIL'} — nonce ${pass1 ? 'aanwezig' : 'ONTBREEKT'}`);

console.log('Test 2: gespreksgeheugen (--resume)…');
const t1 = Date.now();
const r2 = await runner({
  item: { conversationId, content: 'Welke code noemde ik zojuist? Antwoord met alleen die code.' },
  signal: new AbortController().signal,
});
const d2 = ((Date.now() - t1) / 1000).toFixed(1);
const pass2 = r2.answer.includes(nonce);
console.log(`  antwoord (${d2}s): ${r2.answer.slice(0, 120)}`);
console.log(`  ${pass2 ? 'PASS' : 'FAIL'} — geheugen ${pass2 ? 'werkt' : 'FAALT'}`);

console.log(`\nEINDVERDICT: ${pass1 && pass2 ? 'FULL PASS — echte Claude-runs met geheugen bewezen' : 'FAIL'}`);
process.exit(pass1 && pass2 ? 0 : 1);
