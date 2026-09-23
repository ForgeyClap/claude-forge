#!/usr/bin/env node
'use strict';
// forge-lock-guard.test.cjs — tests the mechanical hotspot write-lock (2026-07-24). Hermetic: every case
// uses an isolated temp dir (opts.dir) + an injected clock (opts.now) so nothing touches the real lock dir
// and TTL/expiry is deterministic (no real waiting).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const lg = require('./forge-lock-guard.cjs');

let passed = 0, failed = 0;
function t(name, fn) { try { fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); } }

// fresh isolated lock dir per case
let seq = 0;
function tmpDir() { const d = path.join(os.tmpdir(), 'forge-lock-test-' + process.pid + '-' + (seq++)); try { fs.rmSync(d, { recursive: true, force: true }); } catch {} return d; }
const T0 = 1000000; // fixed base clock
const HOT = '.claude/forge-bin/forge-sync.cjs';

console.log('forge-lock-guard tests');

t('acquire on a free hotspot succeeds and records the run', () => {
  const dir = tmpDir();
  const r = lg.acquire({ hotspot: HOT, runId: 'run-A', owner: 'boss-1' }, { dir, now: T0 });
  assert.ok(r.ok, 'expected ok');
  assert.strictEqual(r.lock.run_id, 'run-A');
  assert.strictEqual(r.lock.owner, 'boss-1');
  assert.strictEqual(r.lock.expires_at, T0 + lg.DEFAULT_TTL_MS);
});

t('a DIFFERENT run is blocked with a conflict naming the holder + remaining time', () => {
  const dir = tmpDir();
  lg.acquire({ hotspot: HOT, runId: 'run-A' }, { dir, now: T0, ttlMs: 10000 });
  const r = lg.acquire({ hotspot: HOT, runId: 'run-B' }, { dir, now: T0 + 3000, ttlMs: 10000 });
  assert.ok(!r.ok, 'expected conflict');
  assert.ok(r.conflict, 'expected conflict detail');
  assert.strictEqual(r.conflict.held_by_run, 'run-A');
  assert.strictEqual(r.conflict.remaining_ms, 7000);
});

t('re-acquire refresht ALLEEN met het exacte CAS-token; dezelfde runId zonder token is een conflict (r4 #3)', () => {
  const dir = tmpDir();
  const first = lg.acquire({ hotspot: HOT, runId: 'run-A' }, { dir, now: T0, ttlMs: 10000 });
  assert.ok(first.ok && first.token, 'acquire moet een token geven');
  // ZONDER token: geen eigendom — twee agents die toevallig dezelfde runId voeren mogen elkaars lock
  // niet stilzwijgend verversen (precies het r4-#3-defect).
  const noToken = lg.acquire({ hotspot: HOT, runId: 'run-A' }, { dir, now: T0 + 5000, ttlMs: 10000 });
  assert.ok(!noToken.ok && noToken.conflict, 'zelfde runId zonder token = conflict');
  // MET het exacte token: CAS-refresh slaagt.
  const r = lg.acquire({ hotspot: HOT, runId: 'run-A', token: first.token }, { dir, now: T0 + 5000, ttlMs: 10000 });
  assert.ok(r.ok && r.refreshed, 'expected refreshed ok');
  assert.strictEqual(r.lock.expires_at, T0 + 5000 + 10000);
  // en de expliciete refresh() doet hetzelfde met verliesdetectie
  const rf = lg.refresh({ hotspot: HOT, runId: 'run-A', token: first.token }, { dir, now: T0 + 6000, ttlMs: 10000 });
  assert.ok(rf.ok, 'refresh met token slaagt');
  const rfBad = lg.refresh({ hotspot: HOT, runId: 'run-A', token: 'verkeerd-token' }, { dir, now: T0 + 6000 });
  assert.ok(!rfBad.ok && /token mismatch/.test(rfBad.reason), 'refresh met fout token = LOST');
});

t('check reports HELD while active, FREE after expiry', () => {
  const dir = tmpDir();
  lg.acquire({ hotspot: HOT, runId: 'run-A' }, { dir, now: T0, ttlMs: 10000 });
  assert.strictEqual(lg.check({ hotspot: HOT }, { dir, now: T0 + 1 }).held, true);
  const after = lg.check({ hotspot: HOT }, { dir, now: T0 + 10000 });
  assert.strictEqual(after.held, false);
  assert.strictEqual(after.expired, true);
});

t('release vereist runId ÉN het CAS-token van de acquirer (r4 #3)', () => {
  const dir = tmpDir();
  const a = lg.acquire({ hotspot: HOT, runId: 'run-A' }, { dir, now: T0 });
  const denied = lg.release({ hotspot: HOT, runId: 'run-B', token: a.token }, { dir });
  assert.ok(!denied.ok, 'non-owner release must be denied');
  const deniedNoToken = lg.release({ hotspot: HOT, runId: 'run-A' }, { dir });
  assert.ok(!deniedNoToken.ok && /token/.test(deniedNoToken.reason), 'release zonder token moet geweigerd worden op een token-dragende lock');
  const ok = lg.release({ hotspot: HOT, runId: 'run-A', token: a.token }, { dir });
  assert.ok(ok.ok && ok.released, 'owner release with token must succeed');
  assert.strictEqual(lg.check({ hotspot: HOT }, { dir, now: T0 + 1 }).held, false);
});

t('nascent/corrupt lockbestand (r4 #4): jong = afwachten, oud = gereapt; check meldt corrupt', () => {
  const dir = tmpDir();
  const file = require('path').join(dir, lg.keyOf(HOT) + '.json');
  require('fs').mkdirSync(dir, { recursive: true });
  require('fs').writeFileSync(file, '{ "half geschreven'); // crash tussen create en volledige write
  // check noemt hem niet meer "vrij" maar corrupt
  const c = lg.check({ hotspot: HOT }, { dir, now: T0 });
  assert.strictEqual(c.held, false);
  assert.strictEqual(c.corrupt, true);
  // oud maken -> acquire reapt het artefact en claimt gewoon
  const old = (Date.now() - 60000) / 1000;
  require('fs').utimesSync(file, old, old);
  const r = lg.acquire({ hotspot: HOT, runId: 'run-N' }, { dir, now: T0, ttlMs: 5000 });
  assert.ok(r.ok, 'acquire over een OUD crash-artefact moet slagen (reap + claim): ' + (r.reason || ''));
  assert.strictEqual(lg.check({ hotspot: HOT }, { dir, now: T0 + 1 }).lock.run_id, 'run-N');
});

t('absurde expires_at wordt geklemd (r4 #4): een vooruitlopende klok zet de hotspot niet dagen vast', () => {
  const dir = tmpDir();
  const file = require('path').join(dir, lg.keyOf(HOT) + '.json');
  require('fs').mkdirSync(dir, { recursive: true });
  // handgeschreven lock die beweert pas over 10 jaar te verlopen
  require('fs').writeFileSync(file, JSON.stringify({ hotspot: lg.normHotspot(HOT), run_id: 'run-clock', owner: 'x', acquired_at: T0, ttl_ms: 999, expires_at: T0 + 315360000000, note: '' }));
  // binnen de 24h-klem: nog gewoon geldig bezet
  const held = lg.acquire({ hotspot: HOT, runId: 'run-B' }, { dir, now: T0 + 1000, ttlMs: 5000 });
  assert.ok(!held.ok, 'binnen de klem blijft de lock bezet');
  // voorbij acquired_at + 24h: effectief verlopen ondanks de absurde expires_at
  const r = lg.acquire({ hotspot: HOT, runId: 'run-B' }, { dir, now: T0 + lg.TTL_CLAMP_MS + 1000, ttlMs: 5000 });
  assert.ok(r.ok, 'voorbij de 24h-klem moet de steal slagen: ' + (r.reason || ''));
});

t('an EXPIRED lock is stolen by a new run (crash self-heal)', () => {
  const dir = tmpDir();
  lg.acquire({ hotspot: HOT, runId: 'run-A' }, { dir, now: T0, ttlMs: 5000 });
  const r = lg.acquire({ hotspot: HOT, runId: 'run-B' }, { dir, now: T0 + 6000, ttlMs: 5000 });
  assert.ok(r.ok, 'expected steal to succeed');
  assert.strictEqual(r.stolenFromExpired, 'run-A');
  assert.strictEqual(lg.check({ hotspot: HOT }, { dir, now: T0 + 6001 }).lock.run_id, 'run-B');
});

t('heldLocks projects all lock files and flags expired ones', () => {
  const dir = tmpDir();
  lg.acquire({ hotspot: 'a/one.cjs', runId: 'run-A' }, { dir, now: T0, ttlMs: 10000 });
  lg.acquire({ hotspot: 'b/two.cjs', runId: 'run-B' }, { dir, now: T0, ttlMs: 1000 });
  const held = lg.heldLocks({ dir, now: T0 + 2000 });
  assert.strictEqual(held.length, 2);
  const expiredCount = held.filter((h) => h.expired).length;
  assert.strictEqual(expiredCount, 1, 'exactly one should be expired');
});

t('reapStale deletes ONLY expired locks', () => {
  const dir = tmpDir();
  lg.acquire({ hotspot: 'a/one.cjs', runId: 'run-A' }, { dir, now: T0, ttlMs: 10000 });
  lg.acquire({ hotspot: 'b/two.cjs', runId: 'run-B' }, { dir, now: T0, ttlMs: 1000 });
  const r = lg.reapStale({ dir, now: T0 + 2000 });
  assert.strictEqual(r.reaped, 1);
  assert.strictEqual(lg.heldLocks({ dir, now: T0 + 2000 }).length, 1, 'active lock survives reap');
});

t('hotspot normalization is case/separator/trailing-slash insensitive (same key)', () => {
  const dir = tmpDir();
  lg.acquire({ hotspot: 'A\\B\\Core.CJS', runId: 'run-A' }, { dir, now: T0 });
  // a different textual form of the same path must see the existing lock and conflict
  const r = lg.acquire({ hotspot: 'a/b/core.cjs/', runId: 'run-B' }, { dir, now: T0 + 1 });
  assert.ok(!r.ok, 'normalized-equal hotspots must collide');
  assert.strictEqual(lg.keyOf('A\\B\\Core.CJS'), lg.keyOf('a/b/core.cjs/'));
});

t('acquire without hotspot or runId fails cleanly (no throw)', () => {
  assert.strictEqual(lg.acquire({ runId: 'x' }, { dir: tmpDir() }).ok, false);
  assert.strictEqual(lg.acquire({ hotspot: HOT }, { dir: tmpDir() }).ok, false);
});

// cleanup any temp dirs this run created
for (let i = 0; i < seq; i++) { try { fs.rmSync(path.join(os.tmpdir(), 'forge-lock-test-' + process.pid + '-' + i), { recursive: true, force: true }); } catch {} }


// ============================================================================================
// G2 (2026-08-06): ATOMISCHE CLAIM — twee ECHT gelijktijdige contenders, precies EEN winnaar.
// De oude acquire was read-then-write: beide lazen "vrij" en beide kregen ok:true. Deze tests
// racen echte processen achter een startlijn; de expired-takeover en refresh/release-correctheid
// (verplichte verificatie #3) zitten er ook in.
// ============================================================================================
console.log('\nG2) atomische claim onder echte gelijktijdigheid');
{
  const tc = (name, cond, extra) => { if (cond) { passed++; console.log('  ok   ' + name); } else { failed++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); } };
  const os = require('os');
  const { spawn } = require('child_process');
  const GUARD = path.join(__dirname, 'forge-lock-guard.cjs').replace(/\\/g, '/');
  const sleepR = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { } };

  const raceAcquire = (n, preexisting) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lockguard-race-'));
    const lockDir = path.join(dir, 'locks');
    if (preexisting) {
      fs.mkdirSync(lockDir, { recursive: true });
      const G = require(GUARD);
      fs.writeFileSync(path.join(lockDir, G.keyOf('hot/spot.cjs') + '.json'), JSON.stringify(preexisting, null, 2));
    }
    const gate = path.join(dir, 'GO');
    const runner = path.join(dir, 'runner.cjs');
    fs.writeFileSync(runner, [
      "const fs=require('fs');const p=require('path');",
      "const G=require(" + JSON.stringify(GUARD) + ");",
      "const me=process.argv[2];",
      "fs.writeFileSync(p.join(" + JSON.stringify(dir) + ",'ready-'+me),'1');",
      "const sab=new Int32Array(new SharedArrayBuffer(4));",
      "while(!fs.existsSync(" + JSON.stringify(gate) + ")){Atomics.wait(sab,0,0,2);}",
      "const r=G.acquire({hotspot:'hot/spot.cjs',runId:'run-'+me},{dir:" + JSON.stringify(lockDir) + "});",
      "fs.writeFileSync(p.join(" + JSON.stringify(dir) + ",'res-'+me+'.json'),JSON.stringify(r));",
    ].join('\n'));
    const kids = [];
    for (let i = 1; i <= n; i++) kids.push(spawn(process.execPath, [runner, String(i)], { stdio: 'ignore' }));
    const count = (pfx) => fs.readdirSync(dir).filter((f) => f.startsWith(pfx)).length;
    const readyBy = Date.now() + 20000;
    while (count('ready-') < n && Date.now() < readyBy) sleepR(5);
    fs.writeFileSync(gate, 'go');
    const deadline = Date.now() + 20000;
    while (count('res-') < n && Date.now() < deadline) sleepR(5);
    for (const k of kids) { try { k.kill(); } catch { } }
    const results = [];
    for (const f of fs.readdirSync(dir).filter((x) => x.startsWith('res-'))) results.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    return { results, winners: results.filter((r) => r.ok).length, lockDir, dir };
  };

  // (a) vrij slot, 2 gelijktijdige contenders -> precies 1 winnaar (het gemelde defect)
  const a = raceAcquire(2, null);
  tc('G2a twee gelijktijdige acquires op een vrij slot: precies EEN winnaar', a.winners === 1, JSON.stringify(a.results));
  tc('G2a de verliezer krijgt het eerlijke conflict met de winnende run', a.results.some((r) => !r.ok && r.conflict && /^run-/.test(r.conflict.held_by_run)));

  // (b) 6 contenders (ruimer dan de verplichte 2) -> nog steeds 1
  const b = raceAcquire(6, null);
  tc('G2b zes gelijktijdige contenders: nog steeds precies EEN winnaar', b.winners === 1, String(b.winners));

  // (c) expired takeover: 2 gelijktijdige stelers van een verlopen lock -> precies 1 winnaar
  const expired = { hotspot: 'hot/spot.cjs', run_id: 'old-run', owner: 'old-run', acquired_at: Date.now() - 3600000, ttl_ms: 1000, expires_at: Date.now() - 3599000, note: '' };
  const c = raceAcquire(2, expired);
  tc('G2c verlopen lock: twee gelijktijdige stelers, precies EEN winnaar', c.winners === 1, JSON.stringify(c.results));
  // Sinds de graveyard-rename (r4 #3/#4) zijn reap en claim ontkoppeld: de contender die het verlopen
  // bestand wegzette hoeft niet degene te zijn wiens create wint. Het echte invariant: de oude houder is
  // WEG en de winnaar is een van de stelers — en ALS iemand stolenFromExpired meldt, noemt hij old-run.
  const winner = c.results.find((r) => r.ok);
  tc('G2c de verlopen houder is vervangen door de winnaar (old-run is weg)', winner && winner.lock && winner.lock.run_id !== 'old-run', JSON.stringify(winner || {}));
  tc('G2c een eventuele stolenFromExpired-melding noemt eerlijk old-run', c.results.every((r) => !r.stolenFromExpired || r.stolenFromExpired === 'old-run'));

  // (d) refresh/release-correctheid met CAS-token (verplichte verificatie #3 · r4 #3)
  {
    const G = require(GUARD);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lockguard-rr-'));
    const o = { dir };
    const r1 = G.acquire({ hotspot: 'x/y.cjs', runId: 'A' }, o);
    tc('G2d verse acquire slaagt en levert een CAS-token', r1.ok === true && !r1.refreshed && typeof r1.token === 'string' && r1.token.length > 0);
    const r2same = G.acquire({ hotspot: 'x/y.cjs', runId: 'A' }, o);
    tc('G2d her-acquire ZONDER token is een conflict (runId-gelijkheid is geen eigendom meer)', r2same.ok === false && !!r2same.conflict);
    const r2 = G.acquire({ hotspot: 'x/y.cjs', runId: 'A', token: r1.token }, o);
    tc('G2d her-acquire MET het exacte token is een refresh', r2.ok === true && r2.refreshed === true);
    const r3 = G.acquire({ hotspot: 'x/y.cjs', runId: 'B' }, o);
    tc('G2d een andere run wordt geweigerd zolang de lock leeft', r3.ok === false && r3.conflict.held_by_run === 'A');
    const rel = G.release({ hotspot: 'x/y.cjs', runId: 'B', token: r2.token }, o);
    tc('G2d release door een niet-eigenaar wordt geweigerd', rel.ok === false);
    const relNoTok = G.release({ hotspot: 'x/y.cjs', runId: 'A' }, o);
    tc('G2d release zonder token wordt geweigerd op een token-dragende lock', relNoTok.ok === false && /token/.test(relNoTok.reason || ''));
    const rel2 = G.release({ hotspot: 'x/y.cjs', runId: 'A', token: r2.token }, o);
    tc('G2d release door de eigenaar met token slaagt', rel2.ok === true && rel2.released === true);
    const r4 = G.acquire({ hotspot: 'x/y.cjs', runId: 'B' }, o);
    tc('G2d na release is het slot echt vrij', r4.ok === true);
    // verliesdetectie: refresh nadat de lock is weggenomen faalt eerlijk (fencing-gedrag)
    G.release({ hotspot: 'x/y.cjs', runId: 'B', token: r4.token }, o);
    const lost = G.refresh({ hotspot: 'x/y.cjs', runId: 'B', token: r4.token }, o);
    tc('G2d refresh na verlies van de lock meldt LOST (houder stopt, schrijft niet door)', lost.ok === false && /lost|gone/i.test(lost.reason || ''));
  }
}

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
