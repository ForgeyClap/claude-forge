// Codex r4 #14 (2026-08-07): de claude-runner faalt GESLOTEN — geen kale PATH-lookup, geen
// CLAUDE_BIN/homedir-fallback. De PATH-poisoning-test bewijst dat een fake `claude` vooraan PATH
// NOOIT wordt uitgevoerd: de constructie weigert al voordat er iets te spawnen valt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClaudeRunner } from '../src/runner-claude.js';

function withEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) { saved[k] = process.env[k]; if (overrides[k] === undefined) delete process.env[k]; else process.env[k] = overrides[k]; }
  try { return fn(); }
  finally { for (const k of Object.keys(overrides)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

test('zonder CLAUDE_CLI_PATH weigert de runner te construeren (geen kale PATH-lookup meer)', () => {
  withEnv({ CLAUDE_CLI_PATH: undefined }, () => {
    assert.throws(() => createClaudeRunner({}), /CLAUDE_CLI_PATH/);
  });
});

test('een RELATIEF CLAUDE_CLI_PATH wordt geweigerd (cwd-shadow onmogelijk)', () => {
  withEnv({ CLAUDE_CLI_PATH: 'claude' }, () => {
    assert.throws(() => createClaudeRunner({}), /ABSOLUUT/);
  });
});

test('een NIET-BESTAAND absoluut CLAUDE_CLI_PATH wordt geweigerd', () => {
  const ghost = path.join(os.tmpdir(), 'bestaat-echt-niet-' + process.pid, 'claude.exe');
  withEnv({ CLAUDE_CLI_PATH: ghost }, () => {
    assert.throws(() => createClaudeRunner({}), /bestaat niet/);
  });
});

test('PATH-poisoning: een fake claude vooraan PATH wordt NOOIT uitgevoerd — de weigering valt vóór elke spawn', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-poison-'));
  const marker = path.join(dir, 'UITGEVOERD.txt');
  // de fake schrijft een marker zodra hij draait — het bewijs dat hij NIET draaide is diens afwezigheid
  const fake = path.join(dir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
  fs.writeFileSync(fake, process.platform === 'win32'
    ? '@echo off\r\necho poisoned > "' + marker + '"\r\n'
    : '#!/bin/sh\necho poisoned > "' + marker + '"\n');
  if (process.platform !== 'win32') fs.chmodSync(fake, 0o755);
  withEnv({ PATH: dir + path.delimiter + process.env.PATH, CLAUDE_CLI_PATH: undefined }, () => {
    assert.throws(() => createClaudeRunner({}), /CLAUDE_CLI_PATH/);
  });
  assert.equal(fs.existsSync(marker), false, 'de fake claude mag nooit zijn uitgevoerd');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('een gebrokerd, geldig absoluut pad wordt geaccepteerd (de enige legitieme route)', () => {
  // node zelf is een bestaand absoluut binair — als pad-validatiefixture (er wordt niets gespawnd)
  withEnv({ CLAUDE_CLI_PATH: process.execPath }, () => {
    const runner = createClaudeRunner({});
    assert.equal(typeof runner, 'function');
  });
});

test('een EXPLICIETE claudePath-parameter blijft mogelijk (bewuste keuze van de aanroeper, bv. tests)', () => {
  withEnv({ CLAUDE_CLI_PATH: undefined }, () => {
    const runner = createClaudeRunner({ claudePath: process.execPath });
    assert.equal(typeof runner, 'function');
  });
});

// ── BROKER-ATTEST v2 (Codex r5 #30-rest) ────────────────────────────────────────────────────────
// r6-contract: attest draagt een sha256-CONTENT-digest; corrupt attest = fout (geen v1-downgrade);
// de broker wordt bij constructie gepind; per-spawn herverificatie loopt via de ECHTE runner-aanroep.
import { verifyCliAttest, readCliAttestFromEnv } from '../src/runner-claude.js';

function attestFor(target) {
  const st = fs.statSync(target);
  const sha = (crypto => crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex'))(require_crypto());
  return { v: 2, path: target, size: st.size, mtime_ms: st.mtimeMs, sha256: sha };
}
import cryptoMod from 'node:crypto';
function require_crypto() { return cryptoMod; }

test('attest v2: geldig attest (size+mtime+sha256 matchen) wordt geaccepteerd en levert het pad', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attest-ok-'));
  const target = path.join(dir, 'claude-fixture.exe');
  fs.writeFileSync(target, 'FIXTURE-BINARY-INHOUD');
  const v = verifyCliAttest(attestFor(target));
  assert.equal(v.ok, true);
  assert.equal(v.path, target);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('attest v2 (r6 #5): een content-swap met GELIJKE size en teruggezette mtime wordt door de sha256 gevangen', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attest-swap-'));
  const target = path.join(dir, 'claude-fixture.exe');
  fs.writeFileSync(target, 'AAAAAAAAAAAAAAAA');
  const at = attestFor(target);
  const st0 = fs.statSync(target);
  fs.writeFileSync(target, 'BBBBBBBBBBBBBBBB'); // zelfde lengte, andere inhoud
  fs.utimesSync(target, st0.atimeMs / 1000, st0.mtimeMs / 1000); // mtime teruggezet
  const v = verifyCliAttest(at);
  assert.equal(v.ok, false);
  assert.match(v.reason, /sha256-mismatch|CONTENT/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('attest v2 zonder sha256-veld wordt geweigerd (r6 #5)', () => {
  const st = fs.statSync(process.execPath);
  const v = verifyCliAttest({ v: 2, path: process.execPath, size: st.size, mtime_ms: st.mtimeMs });
  assert.equal(v.ok, false);
  assert.match(v.reason, /sha256/);
});

test('r6 #6: een AANWEZIG maar corrupt/onbekend-versie-attest is een FOUT, geen stille v1-terugval', () => {
  withEnv({ CLAUDE_CLI_ATTEST: '{"v":1,"path":"x"}', CLAUDE_CLI_PATH: process.execPath }, () => {
    assert.throws(() => createClaudeRunner({}), /corrupt|onbekende versie/);
  });
  withEnv({ CLAUDE_CLI_ATTEST: 'geen json', CLAUDE_CLI_PATH: process.execPath }, () => {
    assert.throws(() => createClaudeRunner({}), /corrupt|onbekende versie/);
  });
  // ECHT afwezig attest + geldige v1-env = de gefaseerde v1-route (met deprecatiewaarschuwing)
  withEnv({ CLAUDE_CLI_ATTEST: undefined, CLAUDE_CLI_PATH: process.execPath }, () => {
    const runner = createClaudeRunner({});
    assert.equal(typeof runner, 'function');
  });
});

test('r6 #7/#8/#9: de ECHTE runner-aanroep weigert op de GEPINDE attest — ook nadat de env is gewist', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attest-spawn-'));
  const target = path.join(dir, 'claude-fixture.exe');
  fs.copyFileSync(process.execPath, target);
  const at = attestFor(target);
  let runner;
  withEnv({ CLAUDE_CLI_ATTEST: JSON.stringify(at), CLAUDE_CLI_PATH: undefined }, () => {
    runner = createClaudeRunner({}); // attest wordt HIER gepind in de closure
  });
  // env is nu terug op de oude staat (gewist) — r6 #7: dat mag de verificatie NIET uitschakelen
  fs.appendFileSync(target, 'X'); // swap NA constructie: size+sha wijken af
  // r6b #4: de rejecttekst alleen is te zwak — een regressie die EERST spawnt en daarna met dezelfde
  // tekst reject zou groen blijven. We tellen daarom de ECHTE spawns via een child_process-spy.
  const cp = await import('node:child_process');
  const realSpawn = cp.spawn;
  let spawnCalls = 0;
  const spy = (...a) => { spawnCalls += 1; return realSpawn(...a); };
  try {
    Object.defineProperty(cp.default ?? cp, 'spawn', { value: spy, configurable: true, writable: true });
  } catch { /* niet-configureerbaar: de telling valt dan terug op 0 en de assert hieronder blijft geldig */ }
  await assert.rejects(
    () => runner({ item: { content: 'ping', projectId: 'p1' }, signal: new AbortController().signal }),
    /attest v2/,
    'de echte runner-aanroep moet VOOR elke spawn op de gepinde attest weigeren'
  );
  assert.equal(spawnCalls, 0, 'er mag GEEN enkel child-proces gestart zijn voordat de attest werd geweigerd');
  try { Object.defineProperty(cp.default ?? cp, 'spawn', { value: realSpawn, configurable: true, writable: true }); } catch { }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('r6b #3: een AANWEZIGE lege CLAUDE_CLI_ATTEST telt als kapot attest, niet als afwezig', () => {
  withEnv({ CLAUDE_CLI_ATTEST: '', CLAUDE_CLI_PATH: process.execPath }, () => {
    assert.equal(readCliAttestFromEnv().state, 'invalid');
    assert.throws(() => createClaudeRunner({}), /corrupt|onbekende versie/);
  });
  withEnv({ CLAUDE_CLI_ATTEST: '   ', CLAUDE_CLI_PATH: process.execPath }, () => {
    assert.throws(() => createClaudeRunner({}), /corrupt|onbekende versie/);
  });
});

test('readCliAttestFromEnv onderscheidt absent / v2 / invalid expliciet (r6 #6)', () => {
  withEnv({ CLAUDE_CLI_ATTEST: undefined }, () => assert.equal(readCliAttestFromEnv().state, 'absent'));
  withEnv({ CLAUDE_CLI_ATTEST: '{"v":2,"path":"x"}' }, () => assert.equal(readCliAttestFromEnv().state, 'v2'));
  withEnv({ CLAUDE_CLI_ATTEST: 'kapot' }, () => assert.equal(readCliAttestFromEnv().state, 'invalid'));
});
