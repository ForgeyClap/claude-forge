#!/usr/bin/env node
'use strict';
/**
 * forge-finalize.cjs — het ene eindverdict (audit G4, 2026-08-06). Hermetisch: eigen temp-root met een
 * echte writer-kopie + minimale hard-rules, zodat finalize het ECHTE contract draait.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (extra ? ' :: ' + extra : '')); } };

const FIN = path.join(__dirname, 'forge-finalize.cjs');
const F = require(FIN);

// hermetische root met echte writer + echte runcontract + een MINIMALE rules-set (1 altijd-groene regel)
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'finalize-'));
fs.mkdirSync(path.join(ROOT, '.claude', 'forge-dashboard'), { recursive: true });
fs.mkdirSync(path.join(ROOT, '.claude', 'forge-bin'), { recursive: true });
fs.mkdirSync(path.join(ROOT, '.claude', 'config', 'orchestration'), { recursive: true });
fs.copyFileSync(path.join(__dirname, '..', 'forge-dashboard', 'log-event.cjs'), path.join(ROOT, '.claude', 'forge-dashboard', 'log-event.cjs'));
fs.copyFileSync(path.join(__dirname, 'forge-runcontract.cjs'), path.join(ROOT, '.claude', 'forge-bin', 'forge-runcontract.cjs'));
fs.copyFileSync(FIN, path.join(ROOT, '.claude', 'forge-bin', 'forge-finalize.cjs'));
try { fs.mkdirSync(path.join(ROOT, '.claude', 'config', 'agents'), { recursive: true }); fs.copyFileSync(path.join(__dirname, '..', 'config', 'agents', 'agent-registry.json'), path.join(ROOT, '.claude', 'config', 'agents', 'agent-registry.json')); } catch { }
fs.writeFileSync(path.join(ROOT, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json'), JSON.stringify({
  owners_allowlist: ['owner'],
  rules: [{ id: 'has-start', rule: 'run has a start event', trigger: 'always', check: { type: 'event-present', key: ['run_started'] }, severity: 'block', override: 'n/a', source: 'test' }],
}, null, 2));

const LOGEVT = path.join(ROOT, '.claude', 'forge-dashboard', 'log-event.cjs');
/** R5-06/R5-07 (vijfde herreview): finalize eist sinds deze ronde een BINDBARE bewijsset — een receipt
 *  met `evidence_digest: null` sloeg alle nieuwe controles over en kreeg toch FINALIZED. Elke fixture
 *  krijgt daarom bij zijn eerste event een minimale, GROENE bewijsset; tests die juist willen aantonen
 *  dat gewijzigd of ongeldig bewijs faalt, overschrijven hem daarna expliciet. */
const zaaiBewijs = (run) => {
  const d = path.join(ROOT, '.claude', 'forge-runs', run);
  fs.mkdirSync(d, { recursive: true });
  const f = path.join(d, 'gate-evidence.json');
  if (!fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify({ run_id: run, gates: [{ name: 'suite', command: 'node test', output_file: 'gate-output/suite.txt', exit_code: 0, output_sha256: 'a'.repeat(64), evidence_verified: true, code: { commit: 'a'.repeat(40), worktree_clean: true, stable: true } }] }));
};
const log = (run, type, extra) => {
  zaaiBewijs(run);
  return spawnSync(process.execPath, [LOGEVT, run, type, JSON.stringify(Object.assign({ agent: 'orchestrator' }, extra || {}))], { encoding: 'utf8' });
};

console.log('forge-finalize (hermetisch, root=' + ROOT + ')');

// 1) een complete run finaliseert; idempotente herhaling; check = FINALIZED
{
  const RUN = 'fin-ok';
  log(RUN, 'run_started', { note: 's' });
  log(RUN, 'run_completed', { command: 'x', output: 'klaar', note: 'af' });
  const r = F.finalize(ROOT, RUN);
  t('1 finalize slaagt op een complete run met groen contract', r.ok === true && r.verdict === 'finalized', JSON.stringify(r).slice(0, 200));
  // sinds de r4-#9/#10-herbouw pint de receipt de log INCLUSIEF het run_finalized-slotevent (3 events)
  t('1 de receipt pint digest/bytes/aantal events (incl. het run_finalized-slotevent)', r.receipt && r.receipt.digest && r.receipt.events === 3 && r.receipt.bytes > 0, JSON.stringify(r.receipt || {}).slice(0, 160));
  t('1 het run_finalized-audittrail-event is gelogd', r.event_logged === true, r.event_error);
  const again = F.finalize(ROOT, RUN);
  t('1 een tweede finalize is een idempotente herbevestiging (geen tweede event)', again.ok === true && again.idempotent === true);
  const c = F.check(ROOT, RUN);
  t('1 check = FINALIZED (de run_finalized-staart is verdisconteerd)', c.verdict === 'FINALIZED', JSON.stringify(c).slice(0, 160));
}

// 2) na-finalisatie-groei met een ANDER event = STALE (het ene eindverdict signaleert de inconsistentie)
{
  const RUN = 'fin-groei';
  log(RUN, 'run_started', { note: 's' });
  log(RUN, 'run_completed', { command: 'x', output: 'klaar' });
  F.finalize(ROOT, RUN);
  log(RUN, 'agent_note', { note: 'nagekomen werk?!' });
  const c = F.check(ROOT, RUN);
  t('2 een gefinaliseerde run die nog events krijgt wordt STALE', c.verdict === 'STALE', c.verdict + ' — ' + (c.reason || ''));
  const re = F.finalize(ROOT, RUN);
  // r5 #10 verscherpte de weigering: een werk-event na run_completed wordt nu al VOOR de receipt-check
  // afgekeurd ("werk-event"); de oudere "veranderd"-tekst geldt op het pad zonder illegale staart.
  t('2 herfinaliseren over de gegroeide log wordt geweigerd met uitleg', re.ok === false && /veranderd|werk-event/.test(re.reason), re.reason);
}

// 3) fail-closed op de logtoestanden (audit G6): corrupt en partial finaliseren NOOIT
{
  const RUN = 'fin-corrupt';
  log(RUN, 'run_started', { note: 's' });
  log(RUN, 'run_completed', { command: 'x', output: 'k' });
  const f = path.join(ROOT, '.claude', 'forge-runs', RUN, 'events.jsonl');
  const orig = fs.readFileSync(f, 'utf8');
  const lines = orig.trim().split('\n');
  fs.writeFileSync(f, lines[0] + '\n{{{kapot\n' + lines[1] + '\n');
  const r = F.finalize(ROOT, RUN);
  t('3 een corrupte middenregel weigert finalisatie met de toestand benoemd', r.ok === false && /corrupt/.test(r.reason));
  fs.writeFileSync(f, orig + '{"event_type":"trunca');
  const r2 = F.finalize(ROOT, RUN);
  t('3 een afgekapte staart (partial) weigert ook', r2.ok === false && /partial/.test(r2.reason));
  fs.rmSync(f, { force: true });
  const r3 = F.finalize(ROOT, RUN);
  t('3 een ontbrekende log weigert (missing)', r3.ok === false && /missing/.test(r3.reason));
}

// 4) zonder run_completed of met een rood contract wordt niet gefinaliseerd
{
  const RUN = 'fin-open';
  log(RUN, 'run_started', { note: 's' });
  const r = F.finalize(ROOT, RUN);
  t('4 zonder run_completed valt er niets te finaliseren', r.ok === false && /run_completed/.test(r.reason));
  const RUN2 = 'fin-roodcontract';
  // run_completed maar ZONDER run_started -> de fixture-regel has-start is rood
  log(RUN2, 'run_completed', { command: 'x', output: 'k' });
  const r2 = F.finalize(ROOT, RUN2);
  t('4 een rood contract blokkeert finalisatie met de contract-uitvoer erbij', r2.ok === false && /contract/.test(r2.reason));
}

// 5) r4 #10-rest: vervalste of extra run_finalized-staartregels maken het verdict STALE — de receipt is
//    een EXACTE digest-match over de hele log, er bestaat geen "toegestane staart" om te vervalsen.
{
  const RUN = 'fin-forge-tail';
  log(RUN, 'run_started', { note: 's' });
  log(RUN, 'run_completed', { command: 'x', output: 'klaar' });
  const r = F.finalize(ROOT, RUN);
  t('5 finalize slaagt als basis', r.ok === true);
  const f = path.join(ROOT, '.claude', 'forge-runs', RUN, 'events.jsonl');
  const good = fs.readFileSync(f, 'utf8');
  // (a) een EXTRA vervalste run_finalized-regel (zonder geldige keten) achter de echte staart
  fs.writeFileSync(f, good + JSON.stringify({ run_id: RUN, event_type: 'run_finalized', agent: 'orchestrator', note: 'vervalst' }) + '\n');
  t('5a een vervalste extra run_finalized-regel => STALE', F.check(ROOT, RUN).verdict === 'STALE');
  // (b) truncatie tot exact receipt.bytes MINUS het slotevent (de oude prefix-aanval)
  const receipt = F.readReceipt(ROOT, RUN);
  const lines5 = good.trim().split('\n');
  fs.writeFileSync(f, lines5.slice(0, -1).join('\n') + '\n');
  t('5b truncatie die het run_finalized-slotevent verwijdert => STALE', F.check(ROOT, RUN).verdict === 'STALE');
  // (c) exacte herstel-bytes => weer FINALIZED (bewijst dat de match byte-exact is, niet heuristisch)
  fs.writeFileSync(f, good);
  t('5c exact herstel van de gepinde bytes => weer FINALIZED', F.check(ROOT, RUN).verdict === 'FINALIZED');
  t('5d de receipt pint domein en ruleset-hash (r4 #8-rest)', receipt && 'domain' in receipt && typeof receipt.ruleset_sha256 === 'string', JSON.stringify(receipt || {}).slice(0, 200));
}

// 6) r4 #8: run_completed gevolgd door rework/check_failed is NIET terminaal — finalize weigert
{
  const RUN = 'fin-rework';
  log(RUN, 'run_started', { note: 's' });
  log(RUN, 'run_completed', { command: 'x', output: 'klaar' });
  log(RUN, 'check_failed', { command: 'toets', output: 'rood', note: 'na de afronding alsnog rood' });
  const r = F.finalize(ROOT, RUN);
  t('6 run_completed -> check_failed: de gereduceerde lifecycle-staat blokkeert finalisatie', r.ok === false && /lifecycle|check_failed/.test(r.reason), r.reason);
}

// 7) 2 GELIJKTIJDIGE finalizers (echte processen): exact één receipt, exact één run_finalized-event,
//    en check() eindigt FINALIZED — geen dubbele audittrail, geen gescheurde receipt.
{
  const RUN = 'fin-race';
  log(RUN, 'run_started', { note: 's' });
  log(RUN, 'run_completed', { command: 'x', output: 'klaar' });
  const FINCLI = path.join(ROOT, '.claude', 'forge-bin', 'forge-finalize.cjs');
  const { spawn } = require('child_process');
  const kids = [1, 2].map(() => spawn(process.execPath, [FINCLI, 'finalize', '--run', RUN, '--root', ROOT], { stdio: 'ignore' }));
  const t0 = Date.now();
  let done = 0;
  for (const k of kids) k.on('exit', () => { done++; });
  while (done < 2 && Date.now() - t0 < 30000) { try { require('child_process').execSync(process.platform === 'win32' ? 'ping -n 1 127.0.0.1 > NUL' : 'sleep 0.1'); } catch { } }
  const evs = fs.readFileSync(path.join(ROOT, '.claude', 'forge-runs', RUN, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const finEvents = evs.filter((e) => e.event_type === 'run_finalized');
  t('7 twee gelijktijdige finalizers: exact EEN run_finalized-event', finEvents.length === 1, String(finEvents.length));
  t('7 en het eindverdict is FINALIZED', F.check(ROOT, RUN).verdict === 'FINALIZED', JSON.stringify(F.check(ROOT, RUN)).slice(0, 160));
}

// 8) r4 #7: het completionpad in EEN commando — contract --finalize eindigt pas groen met een receipt
{
  const RUN = 'fin-e2e';
  log(RUN, 'run_started', { note: 's' });
  log(RUN, 'run_completed', { command: 'x', output: 'klaar' });
  const RC = path.join(ROOT, '.claude', 'forge-bin', 'forge-runcontract.cjs');
  const r = spawnSync(process.execPath, [RC, 'check', '--run', RUN, '--root', ROOT, '--finalize'], { encoding: 'utf8' });
  t('8 contract --finalize: groen contract + receipt in een stap (exit 0)', r.status === 0, (r.stdout || '').slice(0, 200));
  t('8 de uitvoer toont de FINALIZED-digest', /FINALIZED @/.test(r.stdout || ''));
  t('8 en check() bevestigt het ene eindverdict', F.check(ROOT, RUN).verdict === 'FINALIZED');
  // een run zonder afronding eindigt met --finalize NIET in exit 0
  const RUN2 = 'fin-e2e-open';
  log(RUN2, 'run_started', { note: 's' });
  const r2 = spawnSync(process.execPath, [RC, 'check', '--run', RUN2, '--root', ROOT, '--finalize'], { encoding: 'utf8' });
  t('8 zonder run_completed geeft het gecombineerde pad geen exit 0', r2.status !== 0);
}

/** 9) run.json blijft niet "running" claimen na finalisatie.
 *  GEMETEN DEFECT (2026-08-09, volledige doctor): `run liveness` wees forge-2026-08-07-erratum aan als
 *  "still marked running but proven not alive (stalled, silent 12h)" — terwijl die run een GELDIGE
 *  receipt had. finalize las run.json wel (voor het domein) maar schreef hem nooit terug, dus elke
 *  gefinaliseerde run bleef liveness claimen die hij niet waarmaakte. De receipt (digest over
 *  events.jsonl) is en blijft het gezag; run.json is metadata — daarom mag een mislukte statusupdate
 *  een geslaagde finalize NOOIT degraderen. */
{
  const RUN = 'fin-runjson';
  const dir = path.join(ROOT, '.claude', 'forge-runs', RUN);
  log(RUN, 'run_started', { note: 's' });
  log(RUN, 'run_completed', { command: 'x', output: 'klaar' });
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ run_id: RUN, status: 'running', mission: 'blijft staan' }, null, 2));
  const r = F.finalize(ROOT, RUN);
  const j = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'));
  t('9 finalize slaagt', r.ok === true, JSON.stringify(r).slice(0, 160));
  t('9 run.json claimt na finalisatie geen liveness meer', j.status !== 'running', 'status=' + j.status);
  t('9 en gebruikt het BESTAANDE vocabulaire (completed), geen nieuwe waarde', j.status === 'completed', 'status=' + j.status);
  t('9 de receipt-digest is als kruisverwijzing vastgelegd', j.finalize_digest === r.receipt.digest && j.finalized_at === r.receipt.finalized_at);
  t('9 bestaande velden blijven behouden', j.mission === 'blijft staan' && j.run_id === RUN);
  t('9 finalize rapporteert de statuswijziging eerlijk', r.run_meta && r.run_meta.updated === true && r.run_meta.status_before === 'running');
  // het gezag ligt bij de receipt: de log mag door deze metadata-update niet verschoven zijn
  t('9 de log is NIET aangeraakt (check blijft FINALIZED)', F.check(ROOT, RUN).verdict === 'FINALIZED');
}
{
  // fail-safe: een onparseerbare of ontbrekende run.json mag een geldige finalisatie niet omverhalen
  const RUN = 'fin-runjson-corrupt';
  const dir = path.join(ROOT, '.claude', 'forge-runs', RUN);
  log(RUN, 'run_started', { note: 's' });
  log(RUN, 'run_completed', { command: 'x', output: 'klaar' });
  fs.writeFileSync(path.join(dir, 'run.json'), '{ dit is geen json');
  const r = F.finalize(ROOT, RUN);
  t('9 een corrupte run.json degradeert de finalisatie NIET', r.ok === true && r.verdict === 'finalized', JSON.stringify(r).slice(0, 160));
  t('9 en de corrupte run.json wordt met rust gelaten (niet overschreven)', fs.readFileSync(path.join(dir, 'run.json'), 'utf8') === '{ dit is geen json');
  t('9 finalize meldt eerlijk dat de metadata niet is bijgewerkt', r.run_meta && r.run_meta.updated === false && /onparseerbaar/.test(r.run_meta.reason || ''));

  const RUN2 = 'fin-runjson-afwezig';
  log(RUN2, 'run_started', { note: 's' });
  log(RUN2, 'run_completed', { command: 'x', output: 'klaar' });
  const r2 = F.finalize(ROOT, RUN2);
  t('9 een ONTBREKENDE run.json degradeert de finalisatie evenmin', r2.ok === true && r2.run_meta && r2.run_meta.updated === false);
}

/** 10) R3-05 (derde Codex-herreview): de receipt pinde de eventlog en de ruleset maar NIET de bewijsset,
 *  dus `gate-evidence.json` kon ná finalisatie veranderen terwijl het gezaghebbende verdict FINALIZED
 *  bleef — een TOCTOU-gat precies op de plek waar het oordeel definitief hoort te zijn. */
{
  const RUN = 'fin-evidence';
  const dir = path.join(ROOT, '.claude', 'forge-runs', RUN);
  const schrijfBewijs = (sha) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'gate-evidence.json'), JSON.stringify({ run_id: RUN, gates: [{ name: 'suite', command: 'node test', output_file: 'gate-output/suite.txt', exit_code: 0, output_sha256: sha, evidence_verified: true, code: { commit: 'a'.repeat(40), worktree_clean: true, stable: true } }] }));
  };
  log(RUN, 'run_started', { note: 's' });
  log(RUN, 'run_completed', { command: 'x', output: 'klaar' });
  schrijfBewijs('a'.repeat(64));
  const r = F.finalize(ROOT, RUN);
  t('10 finalize pint de canonieke bewijsdigest in de receipt', r.ok === true && typeof r.receipt.evidence_digest === 'string' && r.receipt.evidence_digest.length === 64, JSON.stringify(r.receipt && r.receipt.evidence_digest));
  t('10 en check meldt FINALIZED zolang het bewijs ongewijzigd is', F.check(ROOT, RUN).verdict === 'FINALIZED');
  // nu het bewijs veranderen ZONDER de log aan te raken — precies het TOCTOU-scenario
  schrijfBewijs('b'.repeat(64));
  const na = F.check(ROOT, RUN);
  t('10 gewijzigd bewijs na finalisatie maakt het verdict STALE', na.verdict === 'STALE' && /bewijsset/.test(na.reason || ''), na.verdict + ' — ' + (na.reason || ''));
  // en een verwijderde/ongeldige bewijsset is evenmin stilzwijgend in orde
  fs.writeFileSync(path.join(dir, 'gate-evidence.json'), JSON.stringify({ gates: [{}] }));
  t('10 een ONGELDIGE bewijsset na finalisatie is ook STALE', F.check(ROOT, RUN).verdict === 'STALE');
}

/** 11) R4-03 (vierde herreview): de IDEMPOTENTE herbevestiging vergeleek alleen logdigest/bytes en gaf
 *  direct succes, terwijl check() op hetzelfde bewijs wél STALE meldde. Twee ingangen naar hetzelfde
 *  verdict die van elkaar verschillen zijn erger dan één strenge ingang: je kiest dan gewoon de ingang
 *  die groen zegt. */
{
  const RUN = 'fin-idem-evidence';
  const dir = path.join(ROOT, '.claude', 'forge-runs', RUN);
  const schrijfBewijs = (sha) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'gate-evidence.json'), JSON.stringify({ run_id: RUN, gates: [{ name: 'suite', command: 'node test', output_file: 'gate-output/suite.txt', exit_code: 0, output_sha256: sha, evidence_verified: true, code: { commit: 'a'.repeat(40), worktree_clean: true, stable: true } }] }));
  };
  log(RUN, 'run_started', { note: 's' });
  log(RUN, 'run_completed', { command: 'x', output: 'klaar' });
  schrijfBewijs('a'.repeat(64));
  t('11 eerste finalisatie slaagt', F.finalize(ROOT, RUN).ok === true);
  t('11 en een herbevestiging op ONGEWIJZIGD bewijs blijft idempotent groen', F.finalize(ROOT, RUN).idempotent === true);
  schrijfBewijs('b'.repeat(64));
  const na = F.finalize(ROOT, RUN);
  t('11 maar op GEWIJZIGD bewijs weigert de herbevestiging', na.ok === false && /bewijsset/.test(na.reason || ''), JSON.stringify(na).slice(0, 200));
  t('11 en check() zegt hetzelfde (geen ingang die milder is)', F.check(ROOT, RUN).verdict === 'STALE');
}
{
  // R4-03: ook een gewijzigde REGELSET maakt het oordeel ongeldig — het gold tegen andere regels
  const RUN = 'fin-ruleset';
  log(RUN, 'run_started', { note: 's' });
  log(RUN, 'run_completed', { command: 'x', output: 'klaar' });
  t('11 finalisatie slaagt op de oorspronkelijke regelset', F.finalize(ROOT, RUN).ok === true);
  const regels = path.join(ROOT, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json');
  const origineel = fs.readFileSync(regels, 'utf8');
  const gewijzigd = JSON.parse(origineel);
  gewijzigd.rules.push({ id: 'nieuw', rule: 'x', trigger: 'always', check: { type: 'event-present', key: ['iets'] }, severity: 'warn', override: 'n/a', source: 'test' });
  fs.writeFileSync(regels, JSON.stringify(gewijzigd, null, 2));
  t('11 een gewijzigde regelset maakt het verdict STALE', F.check(ROOT, RUN).verdict === 'STALE');
  t('11 en de herbevestiging weigert eveneens', F.finalize(ROOT, RUN).ok === false);
  fs.writeFileSync(regels, origineel);
  t('11 na herstel van de regelset is het verdict weer FINALIZED', F.check(ROOT, RUN).verdict === 'FINALIZED');
}

/** 12) R5-06/R5-07: een receipt zonder bindbare pins is geen receipt, en de pins moeten OVERLEVEN. */
{
  const RUN = 'fin-geen-bewijs';
  const dir = path.join(ROOT, '.claude', 'forge-runs', RUN);
  log(RUN, 'run_started', { note: 's' });
  log(RUN, 'run_completed', { command: 'x', output: 'klaar' });
  fs.rmSync(path.join(dir, 'gate-evidence.json'), { force: true });
  const r = F.finalize(ROOT, RUN);
  t('12 zonder bewijsset WEIGERT finalize (i.p.v. een onbindbare receipt te schrijven)',
    r.ok === false && /bewijsset/.test(r.reason || ''), JSON.stringify(r).slice(0, 180));
  t('12 en er ligt geen receipt', !fs.existsSync(path.join(dir, 'run-finalized.json')));
}
{
  // een HANDGESCHREVEN receipt zonder pins mag nooit als geldig eindverdict gelden
  const RUN = 'fin-legacy-receipt';
  const dir = path.join(ROOT, '.claude', 'forge-runs', RUN);
  log(RUN, 'run_started', { note: 's' });
  log(RUN, 'run_completed', { command: 'x', output: 'klaar' });
  const ok = F.finalize(ROOT, RUN);
  t('12 de normale finalisatie slaagt', ok.ok === true, JSON.stringify(ok).slice(0, 160));
  const echt = JSON.parse(fs.readFileSync(path.join(dir, 'run-finalized.json'), 'utf8'));
  for (const veld of ['evidence_digest', 'ruleset_sha256']) {
    const zonder = Object.assign({}, echt); delete zonder[veld];
    fs.writeFileSync(path.join(dir, 'run-finalized.json'), JSON.stringify(zonder, null, 2));
    t('12 een receipt ZONDER ' + veld + ' is ongeldig, niet "oud maar goed"', F.check(ROOT, RUN).verdict !== 'FINALIZED');
  }
  const oudSchema = Object.assign({}, echt, { schema: 1 });
  fs.writeFileSync(path.join(dir, 'run-finalized.json'), JSON.stringify(oudSchema, null, 2));
  t('12 en schema 1 evenmin (alleen schema 2 bindt bewijs en regelset)', F.check(ROOT, RUN).verdict !== 'FINALIZED');
  fs.writeFileSync(path.join(dir, 'run-finalized.json'), JSON.stringify(echt, null, 2));
  t('12 de echte receipt is daarna gewoon weer FINALIZED', F.check(ROOT, RUN).verdict === 'FINALIZED');
}

/** 13) R4-07/R5-08: het gezaghebbende eindverdict draagt zijn eigen BEPERKING mee. Zonder dit leest een
 *  consument FINALIZED als principal-onafhankelijk, terwijl de scheiding op agentlabel rust. */
{
  const RUN = 'fin-caveat';
  log(RUN, 'run_started', { note: 's' });
  log(RUN, 'run_completed', { command: 'x', output: 'klaar' });
  const r = F.finalize(ROOT, RUN);
  const iv = r.receipt && r.receipt.independent_verification;
  t('13 de receipt draagt een independent_verification-status', !!iv, JSON.stringify(r.receipt || {}).slice(0, 200));
  t('13 en die status zegt EXPLICIET dat de scheiding label-only is', iv && iv.label_only === true);
  t('13 met een leesbare caveat die naar de owner-gate verwijst', iv && (!iv.caveat || /OWNER-GATED/.test(iv.caveat) || iv.available === false));
  const c = F.check(ROOT, RUN);
  t('13 ook de check-uitslag draagt de caveat (niet alleen de receipt)', c.label_only === true && !!c.independent_verification);
  t('13 en het verdict zelf is gewoon FINALIZED', c.verdict === 'FINALIZED');
}

/** 14) RONDE 7 — vier gaten in finalize, waarvan drie claims van mijzelf weerspraken. */
{
  const RUN = 'fin-r7';
  const dir = path.join(ROOT, '.claude', 'forge-runs', RUN);
  log(RUN, 'run_started', { note: 's' });
  log(RUN, 'run_completed', { command: 'x', output: 'klaar' });
  t('14 basisfinalisatie slaagt', F.finalize(ROOT, RUN).ok === true);
  const echt = JSON.parse(fs.readFileSync(path.join(dir, 'run-finalized.json'), 'utf8'));

  // R7-01: de IDEMPOTENTE tak valideerde de receipt niet via receiptState
  for (const [veld, waarde] of [['schema', 1], ['run_id', 'een-andere-run'], ['contract', 'nope']]) {
    fs.writeFileSync(path.join(dir, 'run-finalized.json'), JSON.stringify(Object.assign({}, echt, { [veld]: waarde }), null, 2));
    const r = F.finalize(ROOT, RUN);
    t('14 R7-01 een receipt met ongeldige ' + veld + ' krijgt GEEN idempotent succes', r.ok === false, JSON.stringify(r).slice(0, 160));
    t('14 R7-01 en check() zegt hetzelfde (geen mildere ingang)', F.check(ROOT, RUN).verdict !== 'FINALIZED');
  }
  fs.writeFileSync(path.join(dir, 'run-finalized.json'), JSON.stringify(echt, null, 2));
  t('14 R7-01 de echte receipt is daarna weer gewoon FINALIZED', F.check(ROOT, RUN).verdict === 'FINALIZED');

  // R7-08: receipt en independent_verification mogen elkaar niet tegenspreken
  const iv = echt.independent_verification;
  t('14 R7-08 de receipt spreekt zichzelf niet tegen (FINALIZED naast een rode iv-status)',
    !!iv && (iv.applicable === false || iv.ok === true || iv.available === false), JSON.stringify(iv));
}
{
  // R7-02: pins worden VOOR de contractcheck genomen; een lege/ongeldige regelset is fataal, geen null
  const RUN = 'fin-r7-pins';
  log(RUN, 'run_started', { note: 's' });
  log(RUN, 'run_completed', { command: 'x', output: 'klaar' });
  const regels = path.join(ROOT, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json');
  const origineel = fs.readFileSync(regels, 'utf8');
  fs.rmSync(regels, { force: true });
  const r = F.finalize(ROOT, RUN);
  t('14 R7-02 zonder leesbare regelset finaliseert hij NIET met een null-pin', r.ok === false, JSON.stringify(r).slice(0, 200));
  fs.writeFileSync(regels, origineel);
  t('14 R7-02 en met de regelset terug slaagt hij gewoon', F.finalize(ROOT, RUN).ok === true);
}

/** 15) R8-05: de receipt pinde log, bewijs en regelset — maar niet de CODE. Na finalisatie kon de commit
 *  waarop het bewijs draaide veranderen terwijl check() FINALIZED bleef zeggen. */
{
  const RUN = 'fin-codepin';
  const dir = path.join(ROOT, '.claude', 'forge-runs', RUN);
  const bewijsOpCommit = (commit) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'gate-evidence.json'), JSON.stringify({ run_id: RUN, gates: [{ name: 'suite', command: 'node test', output_file: 'gate-output/suite.txt', exit_code: 0, output_sha256: 'a'.repeat(64), evidence_verified: true, code: { commit, worktree_clean: true, stable: true } }] }));
  };
  log(RUN, 'run_started', { note: 's' });
  log(RUN, 'run_completed', { command: 'x', output: 'klaar' });
  bewijsOpCommit('a'.repeat(40));
  const r = F.finalize(ROOT, RUN);
  t('15 de receipt pint de commit waarop het bewijs draaide', r.ok === true && r.receipt.code_commit === 'a'.repeat(40), JSON.stringify(r.receipt && r.receipt.code_commit));
  t('15 en check meldt FINALIZED zolang die commit klopt', F.check(ROOT, RUN).verdict === 'FINALIZED');
  bewijsOpCommit('b'.repeat(40));
  const na = F.check(ROOT, RUN);
  t('15 bewijs dat naar een ANDERE commit verschuift maakt het verdict STALE', na.verdict === 'STALE', na.verdict + ' — ' + (na.reason || ''));
}

// ================================================================================================
// 16) FINALIZE-FAILED-GATE (2026-09-24, out-p5.md) — a red gate in the evidence set refuses finalize on
//     EVERY complexity, not only inside the L2+ independent-review rule.
// ================================================================================================
{
  const RUN = 'fin-failed-gate';
  const dir = path.join(ROOT, '.claude', 'forge-runs', RUN);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'gate-evidence.json'), JSON.stringify({
    run_id: RUN, gates: [{ name: 'suite', command: 'node test', output_file: 'gate-output/suite.txt', exit_code: 1, output_sha256: 'a'.repeat(64), evidence_verified: true, code: { commit: 'a'.repeat(40), worktree_clean: true, stable: true } }],
  }));
  log(RUN, 'run_started', { note: 's' });
  log(RUN, 'run_completed', { command: 'x', output: 'klaar' });
  const r = F.finalize(ROOT, RUN);
  t('16 a red gate (exit_code:1) in the evidence set refuses finalize even though the run-contract rule is otherwise green', r.ok === false, JSON.stringify(r).slice(0, 200));
  t('16 the reason names the failed gate', /gefaalde poort/.test(r.reason || ''));
  t('16 no receipt was written', !fs.existsSync(F.receiptFileOf(ROOT, RUN)));
}

// ================================================================================================
// 17) RECEIPT-FORGERY (2026-09-24, out-p5.md) — acceptance (`check()`) RE-EVALUATES the contract instead
//     of trusting the receipt's own `contract:"ok"` string. Proven with a REAL post-finalize state change
//     (an armed-but-unfinished manifest package) that changes NOTHING the receipt's pinned hashes cover
//     (events.jsonl bytes, gate-evidence.json, FORGE_HARD_RULES.json) — only a genuine re-run of the
//     contract can catch it.
// ================================================================================================
{
  // OWN fresh root — forge-runcontract.cjs caches its parsed rules file by PATH at module scope
  // (_rulesCache); the shared ROOT's rules path was already read (and cached) by tests 1-16, so
  // overwriting its bytes here would silently evaluate against the stale cached content instead.
  const FROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'finalize-forgery-'));
  fs.mkdirSync(path.join(FROOT, '.claude', 'forge-dashboard'), { recursive: true });
  fs.mkdirSync(path.join(FROOT, '.claude', 'forge-bin'), { recursive: true });
  fs.mkdirSync(path.join(FROOT, '.claude', 'config', 'orchestration'), { recursive: true });
  fs.copyFileSync(LOGEVT, path.join(FROOT, '.claude', 'forge-dashboard', 'log-event.cjs'));
  fs.copyFileSync(path.join(__dirname, 'forge-runcontract.cjs'), path.join(FROOT, '.claude', 'forge-bin', 'forge-runcontract.cjs'));
  fs.copyFileSync(FIN, path.join(FROOT, '.claude', 'forge-bin', 'forge-finalize.cjs'));
  fs.copyFileSync(path.join(__dirname, 'forge-manifest.cjs'), path.join(FROOT, '.claude', 'forge-bin', 'forge-manifest.cjs'));
  // evidence-satisfied/verify-checked (RC-MANIFEST-STALE's gated ids) so this run's baseline can be
  // genuinely green before proving the post-finalize manifest gate catches it.
  fs.writeFileSync(path.join(FROOT, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json'), JSON.stringify({
    owners_allowlist: ['owner'],
    rules: [
      { id: 'has-start', rule: 'run has a start event', trigger: 'always', check: { type: 'event-present', key: ['run_started'] }, severity: 'block', override: 'n/a', source: 'test' },
      { id: 'evidence-satisfied', rule: 'evidence exists', trigger: 'always', check: { type: 'event-present', key: ['check_passed'] }, severity: 'block', override: 'n/a', source: 'test' },
      { id: 'verify-checked', rule: 'a check ran', trigger: 'always', check: { type: 'event-present', key: ['check_passed'] }, severity: 'block', override: 'n/a', source: 'test' },
    ],
  }, null, 2));
  const RUN = 'fin-receipt-forgery';
  const flog = (type, extra) => { const d = path.join(FROOT, '.claude', 'forge-runs', RUN); fs.mkdirSync(d, { recursive: true });
    const f = path.join(d, 'gate-evidence.json');
    if (!fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify({ run_id: RUN, gates: [{ name: 'suite', command: 'node test', output_file: 'gate-output/suite.txt', exit_code: 0, output_sha256: 'a'.repeat(64), evidence_verified: true, code: { commit: 'a'.repeat(40), worktree_clean: true, stable: true } }] }));
    return spawnSync(process.execPath, [path.join(FROOT, '.claude', 'forge-dashboard', 'log-event.cjs'), RUN, type, JSON.stringify(Object.assign({ agent: 'orchestrator' }, extra || {}))], { encoding: 'utf8' });
  };
  flog('run_started', { note: 's' });
  flog('check_passed', { task: 'suite', command: 'node test', output: 'ok' });
  flog('run_completed', { command: 'x', output: 'klaar' });
  const F_FORGERY = require(path.join(FROOT, '.claude', 'forge-bin', 'forge-finalize.cjs'));
  const before = F_FORGERY.finalize(FROOT, RUN);
  t('17 setup: a genuine finalize succeeds first', before.ok === true, JSON.stringify(before).slice(0, 160));
  t('17 setup: check() confirms FINALIZED before any manifest is armed', F_FORGERY.check(FROOT, RUN).verdict === 'FINALIZED');
  // arm a manifest WITHOUT --log-event: events.jsonl (and therefore the receipt's pinned digest) is
  // byte-for-byte unchanged — only a real contract re-evaluation can see the new, unfinished obligation.
  const MANIFEST = require(path.join(FROOT, '.claude', 'forge-bin', 'forge-manifest.cjs'));
  const armed = MANIFEST.arm({ run_id: RUN, wps: [{ wp_id: 'wp-forge', agent: 'Build Boss', narrowed_prompt: 'do a thing' }] }, { root: FROOT });
  t('17 setup: arm() wrote a manifest without touching events.jsonl', armed.ok === true);
  const after = F_FORGERY.check(FROOT, RUN);
  t('RECEIPT-FORGERY: acceptance re-evaluates the contract and catches the new unfinished obligation — no longer FINALIZED', after.verdict !== 'FINALIZED', JSON.stringify(after).slice(0, 220));
  try { fs.rmSync(FROOT, { recursive: true, force: true }); } catch { }
}

// ================================================================================================
// 18) FINALIZE-STALE-CODE (2026-09-24, out-p5.md) — a receipt's code_commit pin must be compared against
//     the REAL current git HEAD, not just against the (unchanged) gate-evidence.json it was pinned from.
//     Uses its OWN real git repo — ROOT above has none, so resolveHeadCommit() there is always null.
// ================================================================================================
{
  const GITROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'finalize-git-'));
  fs.mkdirSync(path.join(GITROOT, '.claude', 'forge-dashboard'), { recursive: true });
  fs.mkdirSync(path.join(GITROOT, '.claude', 'forge-bin'), { recursive: true });
  fs.mkdirSync(path.join(GITROOT, '.claude', 'config', 'orchestration'), { recursive: true });
  fs.copyFileSync(LOGEVT, path.join(GITROOT, '.claude', 'forge-dashboard', 'log-event.cjs'));
  fs.copyFileSync(path.join(__dirname, 'forge-runcontract.cjs'), path.join(GITROOT, '.claude', 'forge-bin', 'forge-runcontract.cjs'));
  fs.copyFileSync(FIN, path.join(GITROOT, '.claude', 'forge-bin', 'forge-finalize.cjs'));
  fs.writeFileSync(path.join(GITROOT, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json'), JSON.stringify({
    owners_allowlist: ['owner'],
    rules: [{ id: 'has-start', rule: 'run has a start event', trigger: 'always', check: { type: 'event-present', key: ['run_started'] }, severity: 'block', override: 'n/a', source: 'test' }],
  }, null, 2));
  const git = (...args) => spawnSync('git', args, { cwd: GITROOT, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(GITROOT, 'seed.txt'), 'seed\n');
  git('add', '.');
  git('commit', '-q', '-m', 'seed');
  const head1 = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: GITROOT, encoding: 'utf8' }).stdout.trim();
  const noGit = head1 === '' || !/^[0-9a-f]{40}$/i.test(head1);
  if (noGit) {
    console.log('  SKIP 18 FINALIZE-STALE-CODE: no working `git` in this environment — cannot exercise a real HEAD change');
  } else {
    const RUN = 'fin-stale-code';
    const gitLog = (type, extra) => { const d = path.join(GITROOT, '.claude', 'forge-runs', RUN); fs.mkdirSync(d, { recursive: true });
      const f = path.join(d, 'gate-evidence.json');
      if (!fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify({ run_id: RUN, gates: [{ name: 'suite', command: 'node test', output_file: 'gate-output/suite.txt', exit_code: 0, output_sha256: 'a'.repeat(64), evidence_verified: true, code: { commit: head1, worktree_clean: true, stable: true } }] }));
      return spawnSync(process.execPath, [path.join(GITROOT, '.claude', 'forge-dashboard', 'log-event.cjs'), RUN, type, JSON.stringify(Object.assign({ agent: 'orchestrator' }, extra || {}))], { encoding: 'utf8' });
    };
    gitLog('run_started', { note: 's' });
    gitLog('run_completed', { command: 'x', output: 'klaar' });
    const FIN_GIT = require(path.join(GITROOT, '.claude', 'forge-bin', 'forge-finalize.cjs'));
    const r1 = FIN_GIT.finalize(GITROOT, RUN);
    t('18 finalize succeeds on the real git HEAD', r1.ok === true && r1.receipt.code_commit === head1, JSON.stringify(r1).slice(0, 200));
    t('18 check() reports FINALIZED while HEAD is unchanged', FIN_GIT.check(GITROOT, RUN).verdict === 'FINALIZED');
    // move HEAD without touching gate-evidence.json (still declares the OLD commit) or events.jsonl
    fs.writeFileSync(path.join(GITROOT, 'seed2.txt'), 'seed2\n');
    git('add', '.');
    git('commit', '-q', '-m', 'a real second commit');
    const afterHeadChange = FIN_GIT.check(GITROOT, RUN);
    t('FINALIZE-STALE-CODE: a real HEAD change after finalization downgrades the verdict to HISTORICAL, not a stale-looking FINALIZED', afterHeadChange.verdict === 'HISTORICAL', JSON.stringify(afterHeadChange).slice(0, 220));
  }
  try { fs.rmSync(GITROOT, { recursive: true, force: true }); } catch { }
}

try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { }
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
