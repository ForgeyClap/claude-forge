#!/usr/bin/env node
'use strict';
/**
 * log-event.cjs concurrency + JSONL-semantiek (audits G1/G3/G6, 2026-08-06) — hermetisch: draait tegen
 * een KOPIE van de writer in een temp-.claude-boom; echte runs worden nooit aangeraakt.
 *
 * G1: de append was read-tail→hash→append zonder lock — 120 gelijktijdige writers vorkte de hash-keten
 * (meerdere events met dezelfde prev_hash) en elke lineaire chain-walk las de run als getamperd. Nu:
 * exclusieve wx-lock + retry/backoff + monotone seq. Deze suite bewijst het met ECHTE processen.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (extra ? ' :: ' + extra : '')); } };
const sleep = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { } };

// hermetische sandbox met een kopie van de ECHTE writer + registry
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'logev-conc-'));
fs.mkdirSync(path.join(SB, '.claude', 'forge-dashboard'), { recursive: true });
// FORGE_TEST_WRITER_SRC: RED-bewijs-haak — wijs naar een OUDE writer (bv. uit git) om aan te tonen dat
// deze suite het defect daar echt rood ziet; default = de echte huidige writer.
const WRITER_SRC = process.env.FORGE_TEST_WRITER_SRC || path.join(__dirname, '..', 'forge-dashboard', 'log-event.cjs');
fs.copyFileSync(WRITER_SRC, path.join(SB, '.claude', 'forge-dashboard', 'log-event.cjs'));
try {
  fs.mkdirSync(path.join(SB, '.claude', 'config', 'agents'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'config', 'agents', 'agent-registry.json'), path.join(SB, '.claude', 'config', 'agents', 'agent-registry.json'));
} catch { /* registry optioneel */ }
const LOGEVT = path.join(SB, '.claude', 'forge-dashboard', 'log-event.cjs');
const runFile = (runId) => path.join(SB, '.claude', 'forge-runs', runId, 'events.jsonl');
const readLines = (runId) => { try { return fs.readFileSync(runFile(runId), 'utf8').split(/\r?\n/).filter((s) => s.trim()); } catch { return []; } };

console.log('log-event concurrency/semantiek (hermetisch, sandbox=' + SB + ')');

// ============================================================================================
// 1) DE KERN (verplichte verificatie #2): 120 ECHT gelijktijdige appends — exact aantal, unieke
//    monotone seq, EEN lineaire hash-keten, geen verloren of corrupte events.
// ============================================================================================
console.log('\n1) 120 gelijktijdige appends');
{
  const RUN = 'stress-conc';
  const N = 120;
  const gate = path.join(SB, 'GO');
  const runner = path.join(SB, 'runner.cjs');
  fs.writeFileSync(runner, [
    "const fs=require('fs');",
    "const {spawnSync}=require('child_process');",
    "const i=process.argv[2];",
    "const sab=new Int32Array(new SharedArrayBuffer(4));",
    "while(!fs.existsSync(" + JSON.stringify(gate) + ")){Atomics.wait(sab,0,0,2);}",
    "const r=spawnSync(process.execPath,[" + JSON.stringify(LOGEVT) + ",'" + RUN + "','agent_progress',JSON.stringify({agent:'orchestrator',note:'stress-'+i,status:'completed'})],{encoding:'utf8'});",
    "fs.writeFileSync(" + JSON.stringify(path.join(SB, 'res-')) + "+i+'.json',JSON.stringify({status:r.status,err:(r.stderr||'').slice(0,200)}));",
  ].join('\n'), 'utf8');
  const kids = [];
  for (let i = 0; i < N; i++) kids.push(spawn(process.execPath, [runner, String(i)], { stdio: 'ignore' }));
  // startlijn: wacht tot alle runners leven, geef dan het startschot
  const resCount = () => fs.readdirSync(SB).filter((f) => f.startsWith('res-')).length;
  sleep(1500); // runners booten
  fs.writeFileSync(gate, 'go');
  const deadline = Date.now() + 120000;
  while (resCount() < N && Date.now() < deadline) sleep(50);
  for (const k of kids) { try { k.kill(); } catch { } }
  const results = fs.readdirSync(SB).filter((f) => f.startsWith('res-')).map((f) => JSON.parse(fs.readFileSync(path.join(SB, f), 'utf8')));
  const failures = results.filter((r) => r.status !== 0);
  t('alle ' + N + ' writers rapporteerden terug', results.length === N, results.length + '/' + N);
  t('alle appends slaagden (geen lock-timeout onder normale contentie)', failures.length === 0, JSON.stringify(failures.slice(0, 3)));

  const lines = readLines(RUN);
  t('exact ' + N + ' regels geschreven (geen verloren events)', lines.length === N, String(lines.length));
  let events = [];
  let parseFailures = 0;
  for (const l of lines) { try { events.push(JSON.parse(l)); } catch { parseFailures++; } }
  t('elke regel parseert als JSON (geen torn/corrupte regels)', parseFailures === 0, parseFailures + ' onparseerbaar');

  const genesis = events.filter((e) => String(e.prev_hash).startsWith('genesis:'));
  t('exact EEN genesis-event', genesis.length === 1, String(genesis.length));
  const prevCounts = new Map();
  for (const e of events) prevCounts.set(e.prev_hash, (prevCounts.get(e.prev_hash) || 0) + 1);
  const forked = [...prevCounts.values()].filter((c) => c > 1).length;
  t('nul dubbele prev_hash-waarden (de keten vorkt niet)', forked === 0, forked + ' vorken');

  // lineaire walk vanaf genesis + herberekening van elke schakel
  const byPrev = new Map(events.map((e) => [e.prev_hash, e]));
  let cur = byPrev.get('genesis:' + RUN), walked = 0, recomputeOk = true;
  while (cur && walked < N + 5) {
    const canon = (() => { const k = Object.keys(cur).filter((x) => x !== 'entry_hash' && x !== 'prev_hash').sort(); const o = {}; for (const x of k) o[x] = cur[x]; return JSON.stringify(o); })();
    if (crypto.createHash('sha256').update(canon + cur.prev_hash).digest('hex') !== cur.entry_hash) { recomputeOk = false; break; }
    walked++;
    cur = byPrev.get(cur.entry_hash);
  }
  t('EEN lineaire hash-keten van genesis tot staart (lengte ' + N + ')', walked === N, 'walk=' + walked);
  t('elke schakel herberekent correct (sha256(canonical+prev)==entry_hash)', recomputeOk);

  const seqs = events.map((e) => e.seq).sort((a, b) => a - b);
  const monotone = seqs.every((s, i) => s === i + 1);
  t('seq is strikt monotoon 1..' + N + ' zonder gaten of duplicaten', monotone, seqs.slice(0, 5).join(',') + '...');
}

// ============================================================================================
// 2) LOCK-EERLIJKHEID: een vastgehouden verse lock => eerlijke weigering, GEEN ongelockte append;
//    een stale lock (dode pid) => overgenomen.
// ============================================================================================
console.log('\n2) lock-eerlijkheid');
{
  const RUN = 'stress-lock';
  const runDir = path.join(SB, '.claude', 'forge-runs', RUN);
  fs.mkdirSync(runDir, { recursive: true });
  // verse lock van een LEVEND proces (onszelf)
  fs.writeFileSync(path.join(runDir, 'events.jsonl.lock'), JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }), { flag: 'wx' });
  const r = spawnSync(process.execPath, [LOGEVT, RUN, 'agent_progress', JSON.stringify({ agent: 'orchestrator', note: 'x', status: 'completed' })], { encoding: 'utf8', timeout: 20000, env: Object.assign({}, process.env, { FORGE_EVENTS_LOCK_TIMEOUT_MS: '1500' }) });
  t('een vastgehouden verse lock geeft een eerlijke non-zero exit', r.status !== 0);
  t('en er is NIETS geschreven (nooit een ongelockte append)', readLines(RUN).length === 0);
  t('de weigering zegt waarom', /lock/i.test(r.stderr || ''), (r.stderr || '').slice(0, 120));
  fs.unlinkSync(path.join(runDir, 'events.jsonl.lock'));

  // stale lock: dode pid + oude mtime -> overgenomen
  fs.writeFileSync(path.join(runDir, 'events.jsonl.lock'), JSON.stringify({ pid: 999999, ts: '2026-01-01T00:00:00Z' }));
  const old = Date.now() / 1000 - 3600;
  fs.utimesSync(path.join(runDir, 'events.jsonl.lock'), old, old);
  const r2 = spawnSync(process.execPath, [LOGEVT, RUN, 'agent_progress', JSON.stringify({ agent: 'orchestrator', note: 'y', status: 'completed' })], { encoding: 'utf8', timeout: 20000 });
  t('een stale lock (dode pid, oude mtime) wordt overgenomen — de guard blokkeert niet eeuwig', r2.status === 0, (r2.stderr || '').slice(0, 120));
  t('en het event is echt geschreven', readLines(RUN).length === 1);
}

// ============================================================================================
// 3) BATCH-MODUS (G3): N events, EEN proces, EEN lock — keten + seq lopen gewoon door; een
//    STRICT-geweigerde regel geeft exit 2 en wordt NIET geschreven (zelfde semantiek als losse calls).
// ============================================================================================
console.log('\n3) batch-modus');
{
  const RUN = 'stress-batch';
  const batch = [];
  for (let i = 0; i < 10; i++) batch.push(JSON.stringify({ event_type: 'agent_progress', agent: 'orchestrator', note: 'b' + i, status: 'completed' }));
  const r = spawnSync(process.execPath, [LOGEVT, '--batch', RUN], { input: batch.join('\n') + '\n', encoding: 'utf8' });
  t('batch van 10 accepteert met exit 0', r.status === 0, (r.stderr || '').slice(0, 120));
  const events = readLines(RUN).map((l) => JSON.parse(l));
  t('alle 10 geschreven met doorlopende seq 1..10', events.length === 10 && events.every((e, i) => e.seq === i + 1));
  const chainOk = events.every((e, i) => i === 0 ? String(e.prev_hash).startsWith('genesis:') : e.prev_hash === events[i - 1].entry_hash);
  t('de keten is lineair binnen en na de batch', chainOk);

  // ALL-OR-NOTHING (Codex r4 #2, 2026-08-07): een geweigerde regel weigert de HELE batch — er wordt
  // NIETS geschreven, zodat een retry na het fixen van de slechte regel nooit de goede dupliceert.
  const mixed = [
    JSON.stringify({ event_type: 'agent_progress', agent: 'orchestrator', note: 'ok1', status: 'completed' }),
    JSON.stringify({ event_type: 'check_passed', agent: 'orchestrator', note: 'zonder bewijs' }),
    JSON.stringify({ event_type: 'agent_progress', agent: 'orchestrator', note: 'ok2', status: 'completed' }),
  ];
  const r2 = spawnSync(process.execPath, [LOGEVT, '--batch', RUN], { input: mixed.join('\n') + '\n', encoding: 'utf8' });
  t('een STRICT-geweigerde regel in de batch geeft exit 2', r2.status === 2);
  t('de weigering noemt de regel en de reden', /line 2/.test(r2.stderr || '') && /STRICT REFUSED/.test(r2.stderr || ''));
  t('en meldt de all-or-nothing-weigering expliciet', /all-or-nothing/.test(r2.stderr || ''));
  const after = readLines(RUN).map((l) => JSON.parse(l));
  t('all-or-nothing: OOK de goede regels van de geweigerde batch zijn NIET geschreven (10 totaal)', after.length === 10 && after.every((e) => e.event_type !== 'check_passed'), String(after.length));
  // de retry met alleen goede regels is nu veilig en dupliceert niets
  const retry = [mixed[0], mixed[2]];
  const r3 = spawnSync(process.execPath, [LOGEVT, '--batch', RUN], { input: retry.join('\n') + '\n', encoding: 'utf8' });
  const after3 = readLines(RUN).map((l) => JSON.parse(l));
  t('een retry zonder de slechte regel schrijft exact de 2 events (12 totaal, seq loopt door)', r3.status === 0 && after3.length === 12 && after3[11].seq === 12, 'status=' + r3.status + ' len=' + after3.length);
}

// ============================================================================================
// 4) readEventsClassified (G6): missing | empty | partial | corrupt | valid — de centrale semantiek
//    waarop completion-gates fail-closed kunnen bouwen.
// ============================================================================================
console.log('\n4) JSONL-foutsemantiek');
{
  const M = require(LOGEVT);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logev-cls-'));
  const f = (name) => path.join(dir, name);
  t('missing: bestand bestaat niet', M.readEventsClassified(f('nope.jsonl')).status === 'missing');
  fs.writeFileSync(f('empty.jsonl'), '');
  t('empty: bestaat maar leeg', M.readEventsClassified(f('empty.jsonl')).status === 'empty');
  fs.writeFileSync(f('empty2.jsonl'), '\n\n  \n');
  t('empty: alleen blanco regels is ook empty', M.readEventsClassified(f('empty2.jsonl')).status === 'empty');
  fs.writeFileSync(f('valid.jsonl'), JSON.stringify({ a: 1 }) + '\n' + JSON.stringify({ b: 2 }) + '\n');
  const v = M.readEventsClassified(f('valid.jsonl'));
  t('valid: alle regels parseren, entries compleet', v.status === 'valid' && v.entries.length === 2);
  fs.writeFileSync(f('partial.jsonl'), JSON.stringify({ a: 1 }) + '\n{"b":2,"truncat');
  const p = M.readEventsClassified(f('partial.jsonl'));
  t('partial: alleen de LAATSTE regel kapot (crash mid-append)', p.status === 'partial' && p.entries.length === 1 && p.badLines.length === 1);
  fs.writeFileSync(f('corrupt.jsonl'), JSON.stringify({ a: 1 }) + '\n{{{ kapot midden\n' + JSON.stringify({ c: 3 }) + '\n');
  const c = M.readEventsClassified(f('corrupt.jsonl'));
  t('corrupt: een NIET-laatste regel kapot = echte beschadiging', c.status === 'corrupt' && c.entries.length === 2 && c.badLines[0].line === 2);
}

// ============================================================================================
// 5) LOCK-FENCING + CONJUNCTIEVE STALENESS (Codex r4 #1): een LEVENDE houder >10s wordt NIET
//    bestolen; future-mtime blokkeert een dode houder niet; een gestolen lock => append weigert.
// ============================================================================================
console.log('\n5) fencing + conjunctieve staleness');
{
  const RUN = 'stress-fence';
  const runDir = path.join(SB, '.claude', 'forge-runs', RUN);
  fs.mkdirSync(runDir, { recursive: true });
  const lockPath = path.join(runDir, 'events.jsonl.lock');

  // (a) LEVENDE houder >10s (backdated mtime, pid = onszelf): mag NIET overgenomen worden.
  //     RED voor de fix: age-only nam hem over en de keten kon vorken.
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }), { flag: 'wx' });
  const oldT = Date.now() / 1000 - 30; // 30s oud = ver voorbij LOCK_STALE_MS
  fs.utimesSync(lockPath, oldT, oldT);
  const ra = spawnSync(process.execPath, [LOGEVT, RUN, 'agent_progress', JSON.stringify({ agent: 'orchestrator', note: 'steel-me-niet', status: 'completed' })], { encoding: 'utf8', timeout: 20000, env: Object.assign({}, process.env, { FORGE_EVENTS_LOCK_TIMEOUT_MS: '1500' }) });
  t('een LEVENDE houder >10s (oude mtime, levend pid) wordt NIET bestolen — eerlijke weigering', ra.status !== 0, 'status=' + ra.status);
  t('en er is niets geschreven', readLines(RUN).length === 0);
  fs.unlinkSync(lockPath);

  // (b) future-mtime + DODE pid: moet WEL gereapt worden (voorheen blokkeerde ageMs<0 elke recovery).
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, ts: new Date().toISOString() }));
  const fut = Date.now() / 1000 + 3600;
  fs.utimesSync(lockPath, fut, fut);
  const rb = spawnSync(process.execPath, [LOGEVT, RUN, 'agent_progress', JSON.stringify({ agent: 'orchestrator', note: 'future-dead', status: 'completed' })], { encoding: 'utf8', timeout: 20000, env: Object.assign({}, process.env, { FORGE_EVENTS_LOCK_TIMEOUT_MS: '5000' }) });
  t('future-mtime met DODE pid wordt gereapt (recovery niet permanent geblokkeerd)', rb.status === 0, (rb.stderr || '').slice(0, 120));
  t('en het event is geschreven', readLines(RUN).length === 1);

  // (c) future-mtime + LEVEND pid: NIET reapen — eerlijke weigering.
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }), { flag: 'wx' });
  fs.utimesSync(lockPath, fut, fut);
  const rc = spawnSync(process.execPath, [LOGEVT, RUN, 'agent_progress', JSON.stringify({ agent: 'orchestrator', note: 'future-alive', status: 'completed' })], { encoding: 'utf8', timeout: 20000, env: Object.assign({}, process.env, { FORGE_EVENTS_LOCK_TIMEOUT_MS: '1500' }) });
  t('future-mtime met LEVEND pid wordt NIET gereapt', rc.status !== 0 && readLines(RUN).length === 1, 'status=' + rc.status);
  fs.unlinkSync(lockPath);

  // (d) FENCING via de echte module-API: acquire de lock, vervang de naam door een "dief", en bewijs
  //     dat de eigendomscheck het verlies detecteert (de append-wiring gebruikt exact deze check en
  //     weigert dan met "fencing" — zie appendChainedLocked).
  const L = require(LOGEVT);
  const acq = L.acquireEventsLock(runDir, { timeoutMs: 2000 });
  t('acquire levert een fencing-identiteit (ino + birthtime)', acq.ok === true && acq.ino != null);
  t('de eigen lock wordt herkend', L.stillOwnsLock(acq) === true);
  fs.unlinkSync(lockPath); // simuleer een onterechte takeover-unlink...
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 424242, ts: new Date().toISOString() })); // ...en een verse dief
  t('na vervanging van de locknaam detecteert stillOwnsLock het verlies (ino-mismatch)', L.stillOwnsLock(acq) === false);
  // release mag de lock van de dief NIET verwijderen (fencing in releaseEventsLock)
  L.releaseEventsLock(acq);
  t('release laat de lock van de opvolger staan (geen unlink na verlies)', fs.existsSync(lockPath));
  fs.unlinkSync(lockPath);
}

// ============================================================================================
// 6) WAL-TRANSACTIONALITEIT (Codex r4 #2): een crash/short-write laat een WAL + fragment achter;
//    de volgende writer kapt terug naar base en replayt de volledige payload — keten intact.
// ============================================================================================
console.log('\n6) WAL-recovery');
{
  const RUN = 'stress-wal';
  const runDir = path.join(SB, '.claude', 'forge-runs', RUN);
  fs.mkdirSync(runDir, { recursive: true });
  const evFile = path.join(runDir, 'events.jsonl');
  const walFile = evFile + '.wal';

  // basis: 2 goede events via de echte CLI
  for (const n of ['w1', 'w2']) spawnSync(process.execPath, [LOGEVT, RUN, 'agent_progress', JSON.stringify({ agent: 'orchestrator', note: n, status: 'completed' })], { encoding: 'utf8' });
  const base = fs.statSync(evFile).size;
  const before = readLines(RUN).map((l) => JSON.parse(l));
  t('basis: 2 events staan er', before.length === 2);

  // simuleer een crash NA de WAL-write maar met een SHORT append (fragment): schrijf de WAL zoals de
  // writer dat doet en een half fragment in de log.
  const crypto2 = require('crypto');
  const M = require(LOGEVT);
  const tail = before[before.length - 1];
  const ev3 = { run_id: RUN, event_type: 'agent_progress', agent: 'orchestrator', note: 'w3-crashte', status: 'completed', prev_hash: tail.entry_hash, seq: 3 };
  const canon = (() => { const k = Object.keys(ev3).filter((x) => x !== 'entry_hash' && x !== 'prev_hash').sort(); const o = {}; for (const x of k) o[x] = ev3[x]; return JSON.stringify(o); })();
  ev3.entry_hash = crypto2.createHash('sha256').update(canon + ev3.prev_hash).digest('hex');
  const payload = JSON.stringify(ev3) + '\n';
  fs.writeFileSync(walFile, JSON.stringify({ base_bytes: base, payload_sha256: crypto2.createHash('sha256').update(payload, 'utf8').digest('hex'), payload }), 'utf8');
  fs.appendFileSync(evFile, payload.slice(0, 25), 'utf8'); // short write: het gevreesde fragment

  // RED voor de fix: de volgende append versmolt met het fragment of weigerde permanent.
  // GREEN: de volgende writer replayt eerst de WAL (truncate->volledige payload) en appendt daarna zelf.
  const r = spawnSync(process.execPath, [LOGEVT, RUN, 'agent_progress', JSON.stringify({ agent: 'orchestrator', note: 'w4-na-recovery', status: 'completed' })], { encoding: 'utf8' });
  t('append na crash+fragment slaagt (WAL-recovery repareerde de log eerst)', r.status === 0, (r.stderr || '').slice(0, 160));
  const after = readLines(RUN).map((l) => JSON.parse(l));
  t('de log bevat 4 volledige events (fragment weg, gecrashte batch gereplayd)', after.length === 4 && after[2].note === 'w3-crashte' && after[3].note === 'w4-na-recovery', String(after.length));
  t('de WAL is opgeruimd', !fs.existsSync(walFile));
  const chainOk = after.every((e, i) => i === 0 ? String(e.prev_hash).startsWith('genesis:') : e.prev_hash === after[i - 1].entry_hash);
  t('de keten is lineair door de recovery heen (seq 1..4)', chainOk && after.every((e, i) => e.seq === i + 1));

  // externe truncatie ONDER de WAL-base => fail-closed, geen "reparatie" over tamper heen
  fs.writeFileSync(walFile, JSON.stringify({ base_bytes: fs.statSync(evFile).size + 999, payload_sha256: crypto2.createHash('sha256').update('x', 'utf8').digest('hex'), payload: 'x' }), 'utf8');
  const r2 = spawnSync(process.execPath, [LOGEVT, RUN, 'agent_progress', JSON.stringify({ agent: 'orchestrator', note: 'na-tamper', status: 'completed' })], { encoding: 'utf8' });
  t('log kleiner dan WAL-base => eerlijke weigering (extern ingekort)', r2.status !== 0 && /SMALLER|truncated/i.test(r2.stderr || ''), (r2.stderr || '').slice(0, 140));
  fs.unlinkSync(walFile);
}

// ============================================================================================
// 7) KETENVALIDATIE IN DE CLASSIFIER (Codex r4 #11): een bewerkt event, een seq-gat of een kaal
//    {a:1} is onder verifyChain GEEN 'valid' meer — de completion-poorten zien 'corrupt'.
// ============================================================================================
console.log('\n7) verifyChain');
{
  const M = require(LOGEVT);
  const RUN = 'stress-chainval';
  const runDir = path.join(SB, '.claude', 'forge-runs', RUN);
  for (const n of ['c1', 'c2', 'c3']) spawnSync(process.execPath, [LOGEVT, RUN, 'agent_progress', JSON.stringify({ agent: 'orchestrator', note: n, status: 'completed' })], { encoding: 'utf8' });
  const evFile = path.join(runDir, 'events.jsonl');
  const good = fs.readFileSync(evFile, 'utf8');

  const v = M.readEventsClassified(evFile, { verifyChain: true, runId: RUN });
  t('een echte, onbewerkte log is valid onder verifyChain', v.status === 'valid', v.badLines && v.badLines[0] && v.badLines[0].reason);

  // (a) inhoud bewerkt zonder de hash te repareren
  fs.writeFileSync(evFile, good.replace('"note":"c2"', '"note":"GEMANIPULEERD"'), 'utf8');
  const a = M.readEventsClassified(evFile, { verifyChain: true, runId: RUN });
  t('een bewerkt event (hash klopt niet meer) => corrupt', a.status === 'corrupt' && /entry_hash/.test(a.badLines[0].reason || ''), JSON.stringify(a.badLines));
  t('zonder verifyChain blijft dezelfde log parse-valid (weergave-consumenten ongemoeid)', M.readEventsClassified(evFile).status === 'valid');

  // (b) kaal object zonder event_type
  fs.writeFileSync(evFile, good + JSON.stringify({ a: 1 }) + '\n', 'utf8');
  const b = M.readEventsClassified(evFile, { verifyChain: true, runId: RUN });
  t('een kaal {a:1} als staartregel => corrupt onder verifyChain', b.status === 'corrupt', JSON.stringify(b.badLines));

  // (c) seq-gat: verwijder het middelste event
  const lines3 = good.trim().split('\n');
  fs.writeFileSync(evFile, lines3[0] + '\n' + lines3[2] + '\n', 'utf8');
  const cgap = M.readEventsClassified(evFile, { verifyChain: true, runId: RUN });
  t('een verwijderd midden-event (keten- en seq-gat) => corrupt', cgap.status === 'corrupt', JSON.stringify(cgap.badLines));

  // (d) verkeerde run_id
  fs.writeFileSync(evFile, good, 'utf8');
  const d = M.readEventsClassified(evFile, { verifyChain: true, runId: 'andere-run' });
  t('run_id-mismatch => corrupt', d.status === 'corrupt' && /run_id/.test(d.badLines[0].reason || ''));

  // (e) de fail-closed writer weigert nu ook een hash-getamperde log
  fs.writeFileSync(evFile, good.replace('"note":"c2"', '"note":"GEMANIPULEERD"'), 'utf8');
  const r = spawnSync(process.execPath, [LOGEVT, RUN, 'agent_progress', JSON.stringify({ agent: 'orchestrator', note: 'mag-niet', status: 'completed' })], { encoding: 'utf8' });
  t('append over een hash-getamperde log wordt geweigerd (fail-closed writer + verifyChain)', r.status !== 0 && /CORRUPT/i.test(r.stderr || ''), (r.stderr || '').slice(0, 140));
  fs.writeFileSync(evFile, good, 'utf8');
}

// ============================================================================================
// 8) EXACT-ONCE TXN-IDEMPOTENTIE (Codex r5 #3 - aangescherpt r6 #1/#2/#10): writer-origin-velden,
//    inhoudsgebonden keys, crash-retry via WAL, en TWEE GELIJKTIJDIGE processen met dezelfde txn.
// ============================================================================================
console.log('\n8) txn-idempotentie (exact-once)');
{
  const RUN = 'stress-txn';
  const mkLines = (tag, n) => { const b = []; for (let i = 0; i < n; i++) b.push(JSON.stringify({ event_type: 'agent_progress', agent: 'orchestrator', note: tag + '-' + i, status: 'completed' })); return b; };
  const mkBatch = (tag, n) => mkLines(tag, n || 3).join('\n') + '\n';
  // exact zoals de CLI de caller-events opbouwt (parse -> run_id erbij): nodig om txn_sha vooraf te kennen
  const callerEvents = (tag, n) => mkLines(tag, n).map((l) => { const ev = JSON.parse(l); ev.run_id = RUN; return ev; });
  const crypto8 = require('crypto');
  // zelfde normalisatie als de writer (r6 #2): volatiele/writer-velden buiten de digest
  const TXN_VOL = new Set(['timestamp', '_forge_verify', 'event_id', 'prev_hash', 'seq', 'entry_hash', 'txn_id', 'txn_sha256', 'txn_count']);
  const txnNorm = (ev) => { const k = Object.keys(ev).filter((x) => !TXN_VOL.has(x)).sort(); const o = Object.create(null); for (const x of k) o[x] = ev[x]; return o; };
  const shaOf = (evs) => crypto8.createHash('sha256').update(JSON.stringify(evs.map(txnNorm)), 'utf8').digest('hex');

  // (a) eerste aanbieding schrijft; tweede met DEZELFDE txn+inhoud is een bevestigde no-op
  const r1 = spawnSync(process.execPath, [LOGEVT, '--batch', RUN, '--txn', 'txn-eerste-batch'], { input: mkBatch('a'), encoding: 'utf8' });
  t('8a eerste aanbieding met --txn schrijft (exit 0)', r1.status === 0, (r1.stderr || '').slice(0, 120));
  const r2 = spawnSync(process.execPath, [LOGEVT, '--batch', RUN, '--txn', 'txn-eerste-batch'], { input: mkBatch('a'), encoding: 'utf8' });
  t('8a dubbele aanbieding met dezelfde txn+inhoud = bevestigde no-op (exit 0, already applied)', r2.status === 0 && /already applied/.test(r2.stdout || ''), (r2.stdout || '').slice(0, 120));
  let evs8 = readLines(RUN).map((l) => JSON.parse(l));
  t('8a de log draagt exact EEN batch met writer-gestempelde txn-velden', evs8.length === 3 && evs8.every((e) => e.txn_id === 'txn-eerste-batch' && typeof e.txn_sha256 === 'string' && e.txn_count === 3));
  // r6 #10: event_id is een echte v4-uuid, uniek, en gebonden in de hash
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  t('8a event_id: v4-uuid-vorm en uniek over de batch', evs8.every((e) => UUID_RE.test(e.event_id)) && new Set(evs8.map((e) => e.event_id)).size === evs8.length);
  {
    const e0 = evs8[0];
    const canonWith = (() => { const k = Object.keys(e0).filter((x) => x !== 'entry_hash' && x !== 'prev_hash').sort(); const o = Object.create(null); for (const x of k) o[x] = e0[x]; return JSON.stringify(o); })();
    const recomputed = crypto8.createHash('sha256').update(canonWith + e0.prev_hash).digest('hex');
    const e0zonder = Object.assign({}, e0); delete e0zonder.event_id;
    const canonZonder = (() => { const k = Object.keys(e0zonder).filter((x) => x !== 'entry_hash' && x !== 'prev_hash').sort(); const o = Object.create(null); for (const x of k) o[x] = e0zonder[x]; return JSON.stringify(o); })();
    const recomputedZonder = crypto8.createHash('sha256').update(canonZonder + e0.prev_hash).digest('hex');
    t('8a event_id is hash-gebonden (herberekening klopt MET, en faalt ZONDER het veld)', recomputed === e0.entry_hash && recomputedZonder !== e0.entry_hash);
  }

  // (b) r6 #2: DEZELFDE key met ANDERE inhoud is GEEN retry - harde weigering, niets geschreven
  const rb = spawnSync(process.execPath, [LOGEVT, '--batch', RUN, '--txn', 'txn-eerste-batch'], { input: mkBatch('anders', 4), encoding: 'utf8' });
  t('8b zelfde key + andere inhoud wordt geweigerd (geen stille no-op, geen write)', rb.status !== 0 && /ANDERE inhoud/.test(rb.stderr || '') && readLines(RUN).length === 3, (rb.stderr || '').slice(0, 140));

  // (c) r6 #1: txn-velden zijn writer-origin - een event-body met txn_id wordt als hele batch geweigerd
  const spoof = JSON.stringify({ event_type: 'agent_progress', agent: 'orchestrator', note: 's', status: 'completed', txn_id: 'txn-slachtoffer' }) + '\n';
  const rc = spawnSync(process.execPath, [LOGEVT, '--batch', RUN], { input: spoof, encoding: 'utf8' });
  t('8c txn_id in de event-body (zonder --txn) = weigering: spoofing van andermans key onmogelijk', rc.status !== 0 && /writer-gestempeld/.test(rc.stderr || '') && readLines(RUN).length === 3, (rc.stderr || '').slice(0, 140));
  const rd = spawnSync(process.execPath, [LOGEVT, '--batch', RUN, '--txn', 'txn-slachtoffer'], { input: mkBatch('echte'), encoding: 'utf8' });
  t('8c de ECHTE transactie met die key schrijft daarna gewoon (6 events)', rd.status === 0 && readLines(RUN).length === 6);

  // (d) crash-simulatie: WAL + short fragment met de txn-velden zoals de writer ze stempelt; retry met
  //     EXACT dezelfde caller-inhoud -> recovery replayt, dedupe matcht key+sha -> bevestigde no-op.
  const evFile8 = runFile(RUN);
  const before8 = fs.readFileSync(evFile8, 'utf8');
  evs8 = readLines(RUN).map((l) => JSON.parse(l));
  const tail8 = evs8[evs8.length - 1];
  const crashCaller = callerEvents('crash', 2);
  const crashSha = shaOf(crashCaller);
  const batchB = [];
  let prev8 = tail8.entry_hash, seq8 = tail8.seq;
  for (let i = 0; i < 2; i++) {
    const ev = Object.assign({}, crashCaller[i], { event_id: '11111111-2222-4333-8444-55555555555' + i, txn_id: 'txn-crash-batch', txn_sha256: crashSha, txn_count: 2, prev_hash: prev8, seq: ++seq8 });
    const canon = (() => { const k = Object.keys(ev).filter((x) => x !== 'entry_hash' && x !== 'prev_hash').sort(); const o = Object.create(null); for (const x of k) o[x] = ev[x]; return JSON.stringify(o); })();
    ev.entry_hash = crypto8.createHash('sha256').update(canon + ev.prev_hash).digest('hex');
    prev8 = ev.entry_hash;
    batchB.push(JSON.stringify(ev));
  }
  const payload8 = batchB.join('\n') + '\n';
  fs.writeFileSync(evFile8 + '.wal', JSON.stringify({ base_bytes: Buffer.byteLength(before8, 'utf8'), payload_sha256: crypto8.createHash('sha256').update(payload8, 'utf8').digest('hex'), payload: payload8 }), 'utf8');
  fs.appendFileSync(evFile8, payload8.slice(0, 30), 'utf8'); // het crash-fragment
  const r3 = spawnSync(process.execPath, [LOGEVT, '--batch', RUN, '--txn', 'txn-crash-batch'], { input: mkBatch('crash', 2), encoding: 'utf8' });
  t('8d retry-na-crash met dezelfde txn+inhoud: WAL-recovery + inhoudsgebonden dedupe = no-op', r3.status === 0 && /already applied/.test(r3.stdout || ''), (r3.stdout || r3.stderr || '').slice(0, 160));
  evs8 = readLines(RUN).map((l) => JSON.parse(l));
  t('8d exact EEN crash-batch in de log (8 events, geen dubbele side effects)', evs8.length === 8 && evs8.filter((e) => e.txn_id === 'txn-crash-batch').length === 2, String(evs8.length));
  const chain8 = evs8.every((e, i) => i === 0 ? String(e.prev_hash).startsWith('genesis:') : e.prev_hash === evs8[i - 1].entry_hash);
  t('8d de keten is lineair door recovery + dedupe heen (seq 1..8)', chain8 && evs8.every((e, i) => e.seq === i + 1));

  // (e) r6 #10: TWEE GELIJKTIJDIGE processen met DEZELFDE txn en inhoud - exact een batch, een no-op
  const gate8 = path.join(SB, 'GO8');
  const runner8 = path.join(SB, 'runner8.cjs');
  fs.writeFileSync(runner8, [
    "const fs=require('fs');const {spawnSync}=require('child_process');",
    "const i=process.argv[2];",
    "const sab=new Int32Array(new SharedArrayBuffer(4));",
    "fs.writeFileSync(" + JSON.stringify(path.join(SB, 'ready8-')) + "+i,'1');",
    "while(!fs.existsSync(" + JSON.stringify(gate8) + ")){Atomics.wait(sab,0,0,1);}",
    "const input=" + JSON.stringify(mkBatch('race', 2)) + ";",
    "const r=spawnSync(process.execPath,[" + JSON.stringify(LOGEVT) + ",'--batch','" + RUN + "','--txn','txn-race-batch'],{input,encoding:'utf8'});",
    "fs.writeFileSync(" + JSON.stringify(path.join(SB, 'res8-')) + "+i+'.json',JSON.stringify({status:r.status,out:(r.stdout||'').slice(0,80)}));",
  ].join('\n'), 'utf8');
  const kids8 = [1, 2].map((i) => spawn(process.execPath, [runner8, String(i)], { stdio: 'ignore' }));
  // r6b #5: ECHTE tweezijdige barrière. Een vaste sleep kon op een trage machine het tweede proces
  // pas ná de vrijgave laten starten — dan test je sequentiële dedupe i.p.v. de race. Beide kinderen
  // melden nu READY; pas als BEIDE er zijn valt het startschot.
  const readyDl = Date.now() + 30000;
  while (fs.readdirSync(SB).filter((f) => f.startsWith('ready8-')).length < 2 && Date.now() < readyDl) sleep(10);
  t('8e barrière: BEIDE processen melden READY vóór het startschot', fs.readdirSync(SB).filter((f) => f.startsWith('ready8-')).length === 2);
  fs.writeFileSync(gate8, 'go');
  const dl8 = Date.now() + 30000;
  while (fs.readdirSync(SB).filter((f) => f.startsWith('res8-')).length < 2 && Date.now() < dl8) sleep(50);
  for (const k of kids8) { try { k.kill(); } catch { } }
  const res8 = fs.readdirSync(SB).filter((f) => f.startsWith('res8-')).map((f) => JSON.parse(fs.readFileSync(path.join(SB, f), 'utf8')));
  evs8 = readLines(RUN).map((l) => JSON.parse(l));
  const raceEvents = evs8.filter((e) => e.txn_id === 'txn-race-batch');
  t('8e twee gelijktijdige processen met dezelfde txn: exact EEN batch geschreven (10 events totaal)', raceEvents.length === 2 && evs8.length === 10, 'race=' + raceEvents.length + ' totaal=' + evs8.length);
  t('8e beide processen eindigen exit 0 en precies een meldt already-applied', res8.length === 2 && res8.every((r) => r.status === 0) && res8.filter((r) => /already applied/.test(r.out)).length === 1, JSON.stringify(res8));

  // (f) legacy zonder --txn blijft exact als voorheen + CLI-contract op een ongeldige key
  const r5b = spawnSync(process.execPath, [LOGEVT, '--batch', RUN], { input: mkBatch('legacy'), encoding: 'utf8' });
  evs8 = readLines(RUN).map((l) => JSON.parse(l));
  t('8f legacy-zonder-txn appendt ongewijzigd (13 events) zonder txn-velden, met event_id', r5b.status === 0 && evs8.length === 13 && evs8.slice(10).every((e) => e.txn_id === undefined && typeof e.event_id === 'string'));
  const r6b = spawnSync(process.execPath, [LOGEVT, '--batch', RUN, '--txn', 'kort'], { input: mkBatch('x'), encoding: 'utf8' });
  t('8f een ongeldige --txn-vorm weigert (exit 1) zonder te schrijven', r6b.status === 1 && readLines(RUN).length === 13);
}

try { fs.rmSync(SB, { recursive: true, force: true }); } catch { /* best effort */ }
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
