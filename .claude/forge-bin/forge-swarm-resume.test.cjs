#!/usr/bin/env node
'use strict';
/**
 * Hermetic tests for forge-swarm-resume.cjs (WAVE D / D1, 2026-07-18). EVERY fixture lives under a fresh
 * os.tmpdir() directory — this file NEVER touches this repo's real .claude/forge-runs/, and never touches
 * the pre-existing, unrelated forge-resume.cjs (global cross-session to-do CLI) this piece deliberately
 * avoided colliding with (see forge-swarm-resume.cjs's own header NAMING NOTE). Exit 0 = all pass.
 *
 * Section map:
 *   1) resume() returns exactly the unfinished WPs (with narrowed_prompt) and excludes done ones
 *   2) resume() on a fully-done run returns unfinished:[] and resumable:false — never re-dispatches a done WP
 *   3) resume() throws when no manifest was ever armed for the run (never fabricates an empty resume plan)
 *   4) resume() surfaces failed WPs as resumable (unfinished), never silently dropped
 *   5) resume() on an all-armed (never-touched) run returns every WP as unfinished
 *   6) real spawned CLI: exit codes 0/2/3, --json output, human-readable plan line
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const mf = require('./forge-manifest.cjs');
const sr = require('./forge-swarm-resume.cjs');

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };

function freshDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); }
function writeEvents(root, runId, events) {
  const dir = path.join(root, '.claude', 'forge-runs', runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''), 'utf8');
}

const CLI = path.join(__dirname, 'forge-swarm-resume.cjs');
function runCLI(argv, env) { return spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8', env: env || process.env }); }

const fourWps = () => ([
  { wp_id: 'wp1', agent: 'Build Boss', narrowed_prompt: 'build the login form' },
  { wp_id: 'wp2', agent: 'Build Boss', narrowed_prompt: 'build the signup form' },
  { wp_id: 'wp3', agent: 'Test Boss', narrowed_prompt: 'write login tests' },
  { wp_id: 'wp4', agent: 'UI Boss', narrowed_prompt: 'style the auth pages' },
]);

console.log('1) resume() returns exactly the unfinished WPs (with narrowed_prompt), excludes done ones');
{
  const root = freshDir('sr-core');
  mf.arm({ run_id: 'run-a', wps: fourWps() }, { root });
  writeEvents(root, 'run-a', [
    { event_type: 'wp_completed', agent: 'Build Boss', wp_id: 'wp1', timestamp: '2026-07-18T10:00:00Z' },
    { event_type: 'check_passed', agent: 'Test Boss', wp_id: 'wp3', command: 'npm test', exit_code: 0, timestamp: '2026-07-18T10:01:00Z' },
  ]);
  const r = sr.resume({ run_id: 'run-a' }, { root });
  t('run_id echoed back', r.run_id === 'run-a');
  t('exactly 2 done (wp1, wp3)', r.done.length === 2 && r.done.map((w) => w.wp_id).sort().join(',') === 'wp1,wp3');
  t('exactly 2 unfinished (wp2, wp4)', r.unfinished.length === 2 && r.unfinished.map((w) => w.wp_id).sort().join(',') === 'wp2,wp4');
  t('every unfinished WP carries its original narrowed_prompt', r.unfinished.find((w) => w.wp_id === 'wp2').narrowed_prompt === 'build the signup form');
  t('unfinished WPs carry their agent', r.unfinished.find((w) => w.wp_id === 'wp4').agent === 'UI Boss');
  t('resumable is true', r.resumable === true);
  t('plan mentions both unfinished wp ids', /wp2/.test(r.plan) && /wp4/.test(r.plan));
  t('plan does not mention the done wp ids (wp1/wp3 excluded from the re-dispatch list)', !/wp1/.test(r.plan) && !/wp3/.test(r.plan));
}

console.log('2) resume() on a fully-done run — never re-dispatches a done WP');
{
  const root = freshDir('sr-done');
  mf.arm({ run_id: 'run-done', wps: [{ wp_id: 'solo', agent: 'Build Boss', narrowed_prompt: 'x' }] }, { root });
  writeEvents(root, 'run-done', [{ event_type: 'wp_completed', agent: 'Build Boss', wp_id: 'solo', timestamp: '2026-07-18T10:00:00Z' }]);
  const r = sr.resume({ run_id: 'run-done' }, { root });
  t('unfinished is empty', r.unfinished.length === 0);
  t('done has the one WP', r.done.length === 1 && r.done[0].wp_id === 'solo');
  t('resumable is false', r.resumable === false);
  t('plan says nothing to resume', /nothing to resume/.test(r.plan));
}

console.log('3) resume() throws honestly when no manifest was ever armed — never fabricates an empty plan');
{
  const root = freshDir('sr-noarm');
  t('resume() throws for a run that was never armed', (() => { try { sr.resume({ run_id: 'never-armed' }, { root }); return false; } catch (e) { return /no manifest found/.test(e.message); } })());
  t('resume() throws for an invalid run_id', (() => { try { sr.resume({ run_id: 'bad id!' }, { root }); return false; } catch (e) { return /valid run_id/.test(e.message); } })());
}

console.log('4) resume() surfaces a failed WP as unfinished — never silently dropped');
{
  const root = freshDir('sr-failed');
  mf.arm({ run_id: 'run-failed', wps: [{ wp_id: 'wpF', agent: 'Build Boss', narrowed_prompt: 'risky change' }] }, { root });
  writeEvents(root, 'run-failed', [{ event_type: 'wp_failed', agent: 'Build Boss', wp_id: 'wpF', timestamp: '2026-07-18T10:00:00Z' }]);
  const r = sr.resume({ run_id: 'run-failed' }, { root });
  t('a failed WP appears in unfinished', r.unfinished.length === 1 && r.unfinished[0].wp_id === 'wpF' && r.unfinished[0].status === 'failed');
  t('resumable is true', r.resumable === true);
}

console.log('5) resume() on an all-armed (never-touched) run returns every WP as unfinished');
{
  const root = freshDir('sr-allarmed');
  mf.arm({ run_id: 'run-allarmed', wps: fourWps() }, { root });
  const r = sr.resume({ run_id: 'run-allarmed' }, { root });
  t('all 4 WPs are unfinished', r.unfinished.length === 4);
  t('done is empty', r.done.length === 0);
  t('resumable is true', r.resumable === true);
}

console.log('6) real spawned CLI: exit codes, --json output, human-readable plan');
{
  const root = freshDir('sr-cli');
  const wpsFile = path.join(root, 'wps.json');
  fs.writeFileSync(wpsFile, JSON.stringify(fourWps()), 'utf8');
  const env = Object.assign({}, process.env, { FORGE_PROJECT_ROOT: root });

  spawnSync(process.execPath, [path.join(__dirname, 'forge-manifest.cjs'), 'arm', '--run', 'run-cli', '--wps', wpsFile], { env });
  writeEvents(root, 'run-cli', [{ event_type: 'wp_completed', agent: 'Build Boss', wp_id: 'wp1', timestamp: '2026-07-18T10:00:00Z' }]);

  const res = runCLI(['--run', 'run-cli', '--json'], env);
  t('CLI exits 3 (resumable — 3 of 4 unfinished)', res.status === 3);
  const rj = JSON.parse(res.stdout);
  t('CLI --json reports unfinished.length === 3', rj.unfinished.length === 3);
  t('CLI --json reports done.length === 1', rj.done.length === 1);

  // r4 #5: de eerste (claimende) aanroep hierboven heeft de 3 WP's geleased — een TWEEDE claimende
  // aanroep mag ze dus NIET meer krijgen (dat was precies het dubbel-dispatch-defect). Kijken doe je
  // met --plan (read-only, geen claims).
  const humanRes = runCLI(['--run', 'run-cli', '--plan'], env);
  t('CLI --plan (read-only) print RESUMABLE met de volledige unfinished-lijst', /RESUMABLE/.test(humanRes.stdout) && /PLAN-ONLY/.test(humanRes.stdout));
  t('CLI --plan toont een unfinished wp met zijn narrowed_prompt', /wp2.*build the signup form/.test(humanRes.stdout));
  const second = runCLI(['--run', 'run-cli', '--json'], env);
  const sj = JSON.parse(second.stdout);
  t('een TWEEDE claimende aanroep krijgt de al-geleasede WP\'s NIET (leased_elsewhere)', sj.unfinished.length === 0 && sj.leased_elsewhere.length === 3, JSON.stringify(sj.leased_elsewhere || []).slice(0, 120));

  const missingRunRes = runCLI(['--run', 'never-armed-cli'], env);
  t('CLI on a never-armed run exits 2', missingRunRes.status === 2);
  t('CLI on a never-armed run prints the honest error', /no manifest found/.test(missingRunRes.stderr));

  const noArgsRes = runCLI([], env);
  t('CLI with no --run exits 2 and prints usage', noArgsRes.status === 2 && /Usage:/.test(noArgsRes.stderr));

  // fully resolve the run -> exit 0, COMPLETE
  writeEvents(root, 'run-cli', [
    { event_type: 'wp_completed', agent: 'Build Boss', wp_id: 'wp1', timestamp: '2026-07-18T10:00:00Z' },
    { event_type: 'wp_completed', agent: 'Build Boss', wp_id: 'wp2', timestamp: '2026-07-18T10:01:00Z' },
    { event_type: 'wp_completed', agent: 'Test Boss', wp_id: 'wp3', timestamp: '2026-07-18T10:02:00Z' },
    { event_type: 'wp_completed', agent: 'UI Boss', wp_id: 'wp4', timestamp: '2026-07-18T10:03:00Z' },
  ]);
  const completeRes = runCLI(['--run', 'run-cli'], env);
  t('CLI exits 0 once every WP is done (COMPLETE)', completeRes.status === 0);
  t('CLI prints COMPLETE and "nothing to resume"', /COMPLETE/.test(completeRes.stdout) && /nothing to resume/.test(completeRes.stdout));
}

// ============================================================================================
// G5 — ATOMISCHE WP-LEASES + FAULT-INJECTION (verplichte verificatie #4, 2026-08-06):
// exact EEN side effect per idempotency-key (wp_id), ook bij gelijktijdige resumes en crash-herstart.
// ============================================================================================
console.log('\nG5) wp-leases: exact een side effect per wp');
{
  const os5 = require('os');
  const { spawn } = require('child_process');
  const sleep5 = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { } };
  const MOD = path.join(__dirname, 'forge-swarm-resume.cjs').replace(/\\/g, '/');

  // (a) 2 ECHT gelijktijdige claimers op dezelfde wp -> precies 1 winnaar
  {
    const root = fs.mkdtempSync(path.join(os5.tmpdir(), 'lease-race-'));
    const gate = path.join(root, 'GO');
    const runner = path.join(root, 'runner.cjs');
    fs.writeFileSync(runner, [
      "const fs=require('fs');const p=require('path');",
      "const M=require(" + JSON.stringify(MOD) + ");",
      "const me=process.argv[2];",
      "fs.writeFileSync(p.join(" + JSON.stringify(root) + ",'ready-'+me),'1');",
      "const sab=new Int32Array(new SharedArrayBuffer(4));",
      "while(!fs.existsSync(" + JSON.stringify(gate) + ")){Atomics.wait(sab,0,0,2);}",
      "const r=M.claimWp({run_id:'lease-run',wp_id:'wp1',holder:'h'+me},{root:" + JSON.stringify(root) + "});",
      "if(r.ok && !r.alreadyMine){fs.appendFileSync(p.join(" + JSON.stringify(root) + ",'SIDE-EFFECT.log'),'dispatch wp1 door h'+me+'\\n');}",
      "fs.writeFileSync(p.join(" + JSON.stringify(root) + ",'res-'+me+'.json'),JSON.stringify(r));",
    ].join('\n'));
    const kids = [];
    for (let i = 1; i <= 2; i++) kids.push(spawn(process.execPath, [runner, String(i)], { stdio: 'ignore' }));
    const count = (pfx) => fs.readdirSync(root).filter((f) => f.startsWith(pfx)).length;
    const rb = Date.now() + 15000; while (count('ready-') < 2 && Date.now() < rb) sleep5(5);
    fs.writeFileSync(gate, 'go');
    const dl = Date.now() + 15000; while (count('res-') < 2 && Date.now() < dl) sleep5(5);
    for (const k of kids) { try { k.kill(); } catch { } }
    const results = fs.readdirSync(root).filter((f) => f.startsWith('res-')).map((f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')));
    const winners = results.filter((r) => r.ok).length;
    t('G5a twee gelijktijdige claims op dezelfde wp: precies EEN winnaar', winners === 1, JSON.stringify(results));
    const effects = fs.readFileSync(path.join(root, 'SIDE-EFFECT.log'), 'utf8').trim().split('\n').filter(Boolean);
    t('G5a exact EEN side effect voor wp1 (de idempotency-key hield)', effects.length === 1, effects.join(' | '));
  }

  // (b) crash-herstart: houder crasht NA de claim maar VOOR het side effect — binnen de TTL blijft de
  //     lease geweigerd (geen dubbel risico), na de TTL neemt een herstart hem over: nog steeds 1 effect.
  {
    const M = require(MOD);
    const root = fs.mkdtempSync(path.join(os5.tmpdir(), 'lease-crash-'));
    const c1 = M.claimWp({ run_id: 'crash-run', wp_id: 'wpX', holder: 'attempt-1' }, { root, ttlMs: 400 });
    t('G5b attempt-1 claimt', c1.ok === true);
    // crash: GEEN release, GEEN side effect. Een verse herstart binnen de TTL:
    const c2 = M.claimWp({ run_id: 'crash-run', wp_id: 'wpX', holder: 'attempt-2' }, { root, ttlMs: 400 });
    t('G5b binnen de TTL wordt de wees-lease geweigerd (nooit gokken dat de houder dood is)', c2.ok === false && /geleased/.test(c2.reason || ''));
    sleep5(600); // TTL voorbij
    const c3 = M.claimWp({ run_id: 'crash-run', wp_id: 'wpX', holder: 'attempt-2' }, { root, ttlMs: 400 });
    t('G5b na de TTL neemt de herstart de lease over (tookOverStale)', c3.ok === true && c3.tookOverStale === true, JSON.stringify(c3));
    // r4 #5: een herclaim door dezelfde houder is NIET meer stil ok (dat maakte de eigen WP opnieuw
    // dispatchbaar) — hij weigert met alreadyMine; alleen het expliciete reclaim-protocol geeft een
    // verse lease (recovery na een eigen crash).
    const c4 = M.claimWp({ run_id: 'crash-run', wp_id: 'wpX', holder: 'attempt-2' }, { root, ttlMs: 400 });
    t('G5b een stille herclaim door dezelfde houder WEIGERT met alreadyMine (geen dubbele dispatch)', c4.ok === false && c4.alreadyMine === true, JSON.stringify(c4));
    // r5 #14: reclaim op een LEVENDE eigen lease weigert ook — pas na de expiry is het recovery
    const c5live = M.claimWp({ run_id: 'crash-run', wp_id: 'wpX', holder: 'attempt-2', reclaim: true }, { root, ttlMs: 400 });
    t('G5b reclaim op een LEVENDE eigen lease WEIGERT (twee processen met dezelfde holder dispatchen nooit dubbel)', c5live.ok === false && /LEEFT/.test(c5live.reason || ''), JSON.stringify(c5live).slice(0, 140));
    sleep5(600); // expiry van de c3-lease (ttl 400)
    const c5 = M.claimWp({ run_id: 'crash-run', wp_id: 'wpX', holder: 'attempt-2', reclaim: true }, { root, ttlMs: 400 });
    t('G5b reclaim:true op een VERLOPEN eigen lease geeft hem opnieuw uit (recoveryprotocol)', c5.ok === true && typeof c5.token === 'string', JSON.stringify(c5).slice(0, 120));
    // release: vreemde houder geweigerd; houder zonder token geweigerd (CAS); houder mét token slaagt
    t('G5b release door een vreemde houder wordt geweigerd', M.releaseWp({ run_id: 'crash-run', wp_id: 'wpX', holder: 'niet-ik', token: c5.token }, { root }).released === false);
    t('G5b release zonder token wordt geweigerd op een token-dragende lease', M.releaseWp({ run_id: 'crash-run', wp_id: 'wpX', holder: 'attempt-2' }, { root }).released === false);
    t('G5b release door de houder met het exacte token slaagt', M.releaseWp({ run_id: 'crash-run', wp_id: 'wpX', holder: 'attempt-2', token: c5.token }, { root }).released === true);
    // r4 #6: injectieve leasekeys — wp-id's die na sanitizing botsten delen GEEN bestand meer
    const k1 = M.claimWp({ run_id: 'crash-run', wp_id: 'foo/bar', holder: 'h1' }, { root });
    const k2 = M.claimWp({ run_id: 'crash-run', wp_id: 'foo?bar', holder: 'h2' }, { root });
    t('G5c injectieve keys: foo/bar en foo?bar krijgen ELK hun eigen lease', k1.ok === true && k2.ok === true);
    t('G5c release van de een raakt de ander niet', M.releaseWp({ run_id: 'crash-run', wp_id: 'foo/bar', holder: 'h1', token: k1.token }, { root }).released === true && M.claimWp({ run_id: 'crash-run', wp_id: 'foo?bar', holder: 'h3' }, { root }).ok === false);
    // r4 #6: een contender met een MINI-ttl kan een levende default-lease niet stelen (expiry uit het record)
    const live = M.claimWp({ run_id: 'crash-run', wp_id: 'wpLive', holder: 'levend' }, { root }); // default 30min
    const thief = M.claimWp({ run_id: 'crash-run', wp_id: 'wpLive', holder: 'dief' }, { root, ttlMs: 1 });
    t('G5c ttlMs:1-contender steelt een levende default-lease NIET (expiry komt uit het record van de houder)', live.ok === true && thief.ok === false && /geleased/.test(thief.reason || ''), JSON.stringify(thief).slice(0, 120));
    // r4 #6: refreshWp verlengt token-geverifieerd; fout token = LOST
    const rf = M.refreshWp({ run_id: 'crash-run', wp_id: 'wpLive', token: live.token }, { root });
    t('G5c refreshWp met het exacte token verlengt de lease', rf.ok === true);
    const rfBad = M.refreshWp({ run_id: 'crash-run', wp_id: 'wpLive', token: 'fout' }, { root });
    t('G5c refreshWp met een fout token meldt verlies (houder hoort te stoppen)', rfBad.ok === false && /token/.test(rfBad.reason || ''));
  }
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
