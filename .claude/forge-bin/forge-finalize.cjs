#!/usr/bin/env node
'use strict';
/**
 * forge-finalize.cjs — HET ene gezaghebbende eindverdict van een run (audit G4, 2026-08-06).
 *
 * PROBLEEM: runwatch, runcontract, verify, trace, tickets, budget en het dashboard projecteerden elk hun
 * EIGEN "klaar" uit andere signalen — dezelfde run kon tegelijk done en niet-done zijn, en geen enkel
 * oordeel was tegen een vaste log-inhoud gepind. Deze poort produceert tegen EEN eventlog-digest een
 * duurzame receipt; elke consument die "is deze run af?" wil weten hoort DEZE receipt te lezen en elk
 * ander signaal hooguit als voortgangsweergave te tonen.
 *
 * MODEL:
 *   finalize --run <id> [--root <projectRoot>]
 *     1. leest events.jsonl via log-event.cjs::readEventsClassified — FAIL-CLOSED: missing/empty/
 *        partial/corrupt is een weigering met de exacte toestand (audit G6), nooit "geen events dus ok";
 *     2. eist een terminaal run_completed-event in de log (zonder afronding valt er niets te finaliseren);
 *     3. draait forge-runcontract.cjs check --run <id> (het bestaande hard-rules-contract) — exit != 0 is
 *        een weigering die de contract-uitvoer meegeeft;
 *     4. schrijft ATOMISCH <run>/run-finalized.json: { run_id, digest: sha256(events.jsonl-bytes),
 *        seq_last, events, contract: 'ok', finalized_at } en logt een run_finalized-event (dat event ligt
 *        NA de digest — de receipt pint de log ZOALS GEFINALISEERD; het event is de audittrail).
 *     IDEMPOTENT: een tweede finalize tegen dezelfde digest herbevestigt de bestaande receipt (exit 0,
 *     geen tweede event); een gegroeide/gewijzigde log na finalisatie is een weigering (exit 3) — een
 *     "afgeronde" run waar nog events bij komen is precies de inconsistentie die dit zichtbaar maakt.
 *   check --run <id> [--json]
 *     FINALIZED  — receipt aanwezig en de digest matcht de huidige log (het event dat de finalisatie
 *                  zelf logde wordt daarbij verdisconteerd: de log mag exact die staart-events dragen);
 *     STALE      — receipt aanwezig maar de log is daarna nog veranderd;
 *     NOT_FINALIZED — geen receipt.
 *   Exit: 0 ok/FINALIZED · 3 geweigerd/STALE/NOT_FINALIZED · 2 usage/config.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const PROJECT_ROOT_DEFAULT = path.resolve(__dirname, '..', '..');

function runsDirOf(root) { return path.join(root, '.claude', 'forge-runs'); }
function eventsFileOf(root, runId) { return path.join(runsDirOf(root), runId, 'events.jsonl'); }
function receiptFileOf(root, runId) { return path.join(runsDirOf(root), runId, 'run-finalized.json'); }
function logEventCli(root) { return path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs'); }

function loadClassifier(root) {
  // de centrale JSONL-semantiek leeft in log-event.cjs (audit G6) — een consument herimplementeert die niet
  const p = logEventCli(root);
  try { return require(p); } catch (e) { return null; }
}

function digestOf(file) {
  const buf = fs.readFileSync(file);
  return { digest: crypto.createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
}

function writeAtomic(file, contents) {
  const tmp = file + '.' + process.pid + '.' + Math.random().toString(36).slice(2, 8) + '.tmp';
  try {
    // r5 #11: gefsynct vóór de rename — een receipt die de rename overleeft maar zijn bytes niet is erger
    // dan geen receipt (parent-dir-fsync bestaat niet op Windows/Node; gedocumenteerd restrisico).
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, contents, null, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  }
  catch (e) { try { fs.unlinkSync(tmp); } catch { } throw e; }
}

/** markRunFinalized — stopt de valse liveness-claim van een gefinaliseerde run.
 *
 *  GEMETEN DEFECT (2026-08-09, volledige doctor): `run liveness` meldde forge-2026-08-07-erratum als
 *  "still marked running but proven not alive (stalled, silent 12h)" terwijl die run een GELDIGE receipt
 *  had. Oorzaak: finalize LAS run.json (voor het domein) maar schreef hem nooit terug, dus elke
 *  gefinaliseerde run bleef liveness claimen die hij niet waarmaakte — een advisory die met valse
 *  positieven volloopt, wordt genegeerd, en dan mist hij de ECHTE stalled run.
 *
 *  Twee bewuste beperkingen:
 *   - run.json is METADATA, niet bewijs. Het gezag is en blijft de receipt (sha256 over events.jsonl);
 *     die wordt hier niet aangeraakt, dus geen enkele digest of ketenclaim verschuift.
 *   - FAIL-SAFE: ontbrekende, onparseerbare of niet-schrijfbare run.json geeft een reden terug en laat
 *     een geslaagde finalisatie ongemoeid. Metadata mag bewijs nooit omverhalen.
 *  Bewust GEEN nieuwe statuswaarde: 'completed' is het bestaande vocabulaire (19 runs) en finalize
 *  slaagt alleen op een groen contract met run_completed als laatste lifecycle-event, dus hij is waar. */
/** evidenceDigestOf — de canonieke bewijsdigest van deze run, of null als er geen (geldige) bewijsset is.
 *  Leunt op forge-runcontract's canonicalizer zodat er ÉÉN definitie van "de bewijsset" bestaat en de
 *  poort en de receipt niet uit elkaar kunnen groeien. */
function canonicalEvidenceOf(root, runId) {
  try {
    const RC = require(path.join(__dirname, 'forge-runcontract.cjs'));
    if (typeof RC.canonicalEvidenceDigest !== 'function') return null;
    return RC.canonicalEvidenceDigest(root, runId);
  } catch { return null; }
}

function evidenceDigestOf(root, runId) {
  try {
    const RC = require(path.join(__dirname, 'forge-runcontract.cjs'));
    if (typeof RC.canonicalEvidenceDigest !== 'function') return null;
    const r = RC.canonicalEvidenceDigest(root, runId);
    return r ? r.digest : null;
  } catch { return null; }
}

/** independentVerificationStatus — de gesaneerde onafhankelijkheidsstand die in de receipt hoort.
 *  Draagt ALTIJD `label_only` mee (de owner-gated grens uit F-02) en, wanneer de regel op dit niveau niet
 *  geldt, expliciet `applicable:false` — zodat NOT_APPLICABLE nooit als "geverifieerd" leest. */
function independentVerificationStatus(root, runId) {
  try {
    const RC = require(path.join(__dirname, 'forge-runcontract.cjs'));
    if (typeof RC.check !== 'function') return { available: false, reason: 'runcontract niet laadbaar', label_only: true };
    /** R7-08 (zevende herreview): deze aanroep gaf GEEN commit_sha mee, terwijl de evaluator zonder
     *  actuele commit fail-closed rood wordt. Een geldige finalisatie schreef daardoor een receipt die
     *  tegelijk FINALIZED en `independent_verification.ok:false` zei — twee tegenstrijdige gezaghebbende
     *  signalen uit één bestand. Dezelfde HEAD-resolutie als de CLI, dus dezelfde uitkomst. */
    const commitSha = typeof RC.resolveHeadCommit === 'function' ? RC.resolveHeadCommit(root) : null;
    const r = RC.check({ run_id: runId, commit_sha: commitSha }, { root });
    const d = r && r.rule_details && r.rule_details['independent-verification'];
    if (!d) return { available: false, reason: 'de regel is op deze run niet geevalueerd', label_only: true };
    return {
      available: true,
      applicable: d.applicable !== false,
      ok: d.ok === true,
      route: d.route || null,
      reviewer: d.reviewer || null,
      review_id: d.review && d.review.review_id ? d.review.review_id : null,
      label_only: true,
      caveat: 'De scheiding werker/reviewer rust op AGENTLABEL, niet op een runtimeprincipal. Een uitvoerder met twee geregistreerde labels kan deze poort passeren; echte provenance is owner-gated (zie OWNER-GATED.md).',
    };
  } catch (e) {
    return { available: false, reason: 'status niet vast te stellen: ' + (e && e.message ? e.message : String(e)), label_only: true };
  }
}

function markRunFinalized(root, runId, receipt) {
  const p = path.join(runsDirOf(root), runId, 'run.json');
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch { return { updated: false, reason: 'geen run.json aanwezig' }; }
  let j;
  try { j = JSON.parse(raw); } catch { return { updated: false, reason: 'run.json is onparseerbaar — met rust gelaten' }; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { updated: false, reason: 'run.json is geen object — met rust gelaten' };
  const before = j.status;
  j.status = 'completed';
  j.finalized_at = receipt.finalized_at;
  j.finalize_digest = receipt.digest;
  try { writeAtomic(p, JSON.stringify(j, null, 2) + '\n'); }
  catch (e) { return { updated: false, reason: 'schrijven mislukt: ' + (e && e.message ? e.message : String(e)) }; }
  return { updated: true, status_before: before === undefined ? null : before, status_after: 'completed' };
}

function classify(root, runId) {
  const M = loadClassifier(root);
  const file = eventsFileOf(root, runId);
  if (!M || typeof M.readEventsClassified !== 'function') {
    // geen writer-module bereikbaar = we kunnen de log niet eerlijk beoordelen — fail-closed
    return { status: 'unreadable', entries: [], badLines: [], reason: 'log-event.cjs (de centrale JSONL-semantiek) is niet laadbaar onder ' + root };
  }
  // r4 #11 (2026-08-07): de completion-poort valideert schema + hashketen, niet alleen JSON-parseerbaarheid
  // — een omgezet event, seq-gat of vervalste staartregel is hier 'corrupt', nooit 'valid'.
  return M.readEventsClassified(file, { verifyChain: true, runId });
}

// De gereduceerde lifecycle-staat van een run: het LAATSTE event uit deze set bepaalt of de run "af" is.
// run_completed -> rework_started/check_failed betekent: er kwam werk NA de afronding — niet finaliseren (r4 #8).
// run_finalized zit er bewust NIET in: dat is de audittrail van deze poort zelf (de idempotente hercheck
// zou anders zijn eigen slotevent als "werk na de afronding" lezen).
const LIFECYCLE_EVENTS = new Set(['run_started', 'run_completed', 'rework_started', 'check_failed']);

function runDomainOf(root, runId) {
  // gezaghebbende runmetadata (r4 #8-rest): run.json > declared domain in events > null (runcontract deriveert dan zelf)
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(runsDirOf(root), runId, 'run.json'), 'utf8'));
    if (meta && typeof meta.domain === 'string' && meta.domain.trim()) return meta.domain.trim();
  } catch { }
  return null;
}
function rulesetHashOf(root) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(path.join(root, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json'))).digest('hex'); }
  catch { return null; }
}

/** finalize (herbouwd, Codex r4 #8-rest/#9/#10-rest, 2026-08-07) — de receipt pint nu de VOLLEDIGE log
 *  INCLUSIEF exact het eigen run_finalized-audittrail-event als laatste regel:
 *    1. keten-gevalideerde classificatie (fail-closed);
 *    2. lifecycle: het laatste lifecycle-event moet run_completed zijn (afronding is terminaal);
 *    3. contract met het ECHTE domein uit run.json (web-/correctness-critical-regels tellen mee);
 *    4. digest-stabiliteit: de digest wordt NA de contractcheck herlezen — is de log intussen veranderd,
 *       dan is er geen stabiele transactie en weigeren we (#9);
 *    5. het run_finalized-event wordt EERST geappend (via de writer, onder de events-lock, keten-gehasht);
 *       faalt die append, dan is er GEEN receipt — auditlogging is verplicht, niet best-effort (#9);
 *    6. de receipt pint digest+bytes van de log MET dat event. check() = exacte digest-match: elke
 *       truncatie, aangroei of vervalste extra run_finalized-regel wijzigt de digest ⇒ STALE (#10-rest).
 *  Idempotent: bestaande receipt + exacte digest-match = herbevestiging zonder tweede event. */
/** finalizeLock — de hele finalize-transactie (classify → contract → audittrail-append → receipt) is
 *  exclusief per run: twee gelijktijdige finalizers zouden anders BEIDE een run_finalized appenden en
 *  elkaars receipt overschrijven (gevonden door de 2-finalizers-racetest, 2026-08-07). wx-create; een
 *  achterblijver ouder dan 60s is een crash-artefact en wordt gereapt. */
function acquireFinalizeLock(root, runId) {
  const lockPath = path.join(runsDirOf(root), runId, 'run-finalized.lock');
  const t0 = process.hrtime.bigint();
  const elapsed = () => Number((process.hrtime.bigint() - t0) / 1000000n);
  for (;;) {
    try { const fd = fs.openSync(lockPath, 'wx'); try { fs.writeSync(fd, String(process.pid)); } catch { } return { fd, lockPath }; }
    catch (e) {
      if (e.code !== 'EEXIST') return null;
      // r5 #8: de 60s-leeftijdsreap kon een LEVENDE finalizer (contract-child mag 120s lopen) bestelen.
      // Reap nu pas boven de maximale operatieduur (180s > 120s contract-timeout) EN alleen met een
      // aantoonbaar dode houder-pid (onleesbaar token = crash-artefact). Monotone klok tegen NTP-sprongen.
      try {
        const st = fs.statSync(lockPath);
        const age = Date.now() - st.mtimeMs;
        let holderPid = null;
        try { const n = Number(fs.readFileSync(lockPath, 'utf8').trim()); if (Number.isFinite(n) && n > 0) holderPid = n; } catch { }
        const holderDead = holderPid === null ? true : (() => { try { process.kill(holderPid, 0); return false; } catch { return true; } })();
        if (age > 180000 && holderDead) { fs.unlinkSync(lockPath); continue; }
      } catch { continue; }
      if (elapsed() > 30000) return null;
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40); } catch { }
    }
  }
}
function releaseFinalizeLock(l) { if (!l) return; try { fs.closeSync(l.fd); } catch { } try { fs.unlinkSync(l.lockPath); } catch { } }

function finalize(root, runId) {
  const flock = acquireFinalizeLock(root, runId);
  if (!flock) return { ok: false, verdict: 'refused', reason: 'finalize-lock niet verkregen (een andere finalizer is bezig of een crash-artefact blokkeert) — probeer opnieuw' };
  try { return finalizeLocked(root, runId); }
  finally { releaseFinalizeLock(flock); }
}
function finalizeLocked(root, runId) {
  const file = eventsFileOf(root, runId);
  const cls = classify(root, runId);
  if (cls.status !== 'valid') {
    return { ok: false, verdict: 'refused', reason: 'events.jsonl is ' + cls.status + (cls.badLines && cls.badLines.length ? ' (regel ' + cls.badLines.map((b) => b.line + (b.reason ? ':' + b.reason : '')).join(',') + ')' : '') + ' — een completion-poort finaliseert nooit over een onleesbare/gemanipuleerde log (fail-closed)', classification: cls.status };
  }
  const events = cls.entries;
  const lastLifecycle = [...events].reverse().find((e) => LIFECYCLE_EVENTS.has(e.event_type));
  if (!lastLifecycle || lastLifecycle.event_type !== 'run_completed') {
    return { ok: false, verdict: 'refused', reason: 'de gereduceerde lifecycle-staat is ' + (lastLifecycle ? lastLifecycle.event_type : 'geen lifecycle-event') + ', niet run_completed — na de afronding kwam er werk bij of de run claimt zelf nog geen afronding' };
  }
  /** r5 #10 (2026-08-07): "laatste lifecycle-event = run_completed" liet WERK-events na de afronding toe
   *  (file_changed, wp_failed, fix_started, ...) zolang ze niet in de lifecycle-set zaten. Na
   *  run_completed zijn uitsluitend audit-events legitiem — al het andere is werk-na-afronding en
   *  blokkeert finalisatie. */
  const POST_COMPLETION_ALLOWED = new Set(['run_finalized', 'gate_evaluated', 'contract_checked']);
  const completedIdx = events.lastIndexOf(lastLifecycle);
  const illegalTail = events.slice(completedIdx + 1).find((e) => !POST_COMPLETION_ALLOWED.has(e.event_type));
  if (illegalTail) {
    return { ok: false, verdict: 'refused', reason: 'na run_completed volgt nog een werk-event (' + illegalTail.event_type + ') — de afronding is niet terminaal; rond het werk echt af en log opnieuw run_completed' };
  }

  /** R7-01 (zevende herreview): de idempotente tak las de receipt met `readReceipt()` — een kale
   *  JSON-parse — en vergeleek alleen digests. Schema, run_id, contract en de pinvorm werden NIET
   *  gevalideerd, terwijl `check()` dat wél doet. Een schema-1-receipt of een receipt van een andere run
   *  kreeg zo exit 0 en "finalized". Twee ingangen naar hetzelfde oordeel met verschillende strengheid,
   *  voor de derde keer in deze reeks — daarom nu dezelfde poortwachter voor allebei. */
  const bestaandeStaat = receiptState(root, runId);
  if (bestaandeStaat.state === 'invalid') {
    return { ok: false, verdict: 'refused', reason: 'er ligt al een receipt, maar die is ONGELDIG (' + bestaandeStaat.reason + ') — een herbevestiging kan dat niet repareren; verwijder of herstel hem bewust' };
  }
  const existing = bestaandeStaat.state === 'valid' ? bestaandeStaat.receipt || readReceipt(root, runId) : null;
  if (existing) {
    const d0 = digestOf(file);
    // De herbevestiging verzoent ook de metadata: runs die vóór deze fix zijn gefinaliseerd dragen nog
    // status 'running' en blijven liveness claimen. Zelfgenezend, want de receipt bewijst hier al dat de
    // run klaar is — en fail-safe, dus een onveranderbare run.json breekt de herbevestiging niet.
    if (d0.digest === existing.digest && d0.bytes === existing.bytes) {
      /** R4-03 (vierde herreview): de idempotente herbevestiging vergeleek ALLEEN logdigest en bytes en
       *  gaf daarna direct succes — gewijzigd bewijs of een gewijzigde regelset bleef zo groen, terwijl
       *  check() wél STALE zou melden. Twee ingangen naar hetzelfde verdict mogen niet verschillen, dus
       *  de herbevestiging toetst nu exact wat de receipt pint. */
      {
        const nu = evidenceDigestOf(root, runId);
        if (nu !== existing.evidence_digest) {
          return { ok: false, verdict: 'refused', reason: 'de bewijsset is sinds de finalisatie veranderd (gate-evidence ' + existing.evidence_digest.slice(0, 12) + '… -> ' + (nu ? nu.slice(0, 12) + '…' : 'ontbreekt/ongeldig') + ') — een herbevestiging kan dat niet wegpoetsen' };
        }
      }
      {
        const nuCode = (canonicalEvidenceOf(root, runId) || {}).commit || null;
        if (nuCode !== existing.code_commit) {
          return { ok: false, verdict: 'refused', reason: 'het bewijs hoort nu bij commit ' + String(nuCode).slice(0, 12) + '… terwijl de receipt ' + String(existing.code_commit).slice(0, 12) + '… pinde — een herbevestiging kan dat verschil niet wegpoetsen' };
        }
      }
      {
        const nuRules = rulesetHashOf(root);
        if (nuRules !== existing.ruleset_sha256) {
          return { ok: false, verdict: 'refused', reason: 'de regelset is sinds de finalisatie veranderd (' + existing.ruleset_sha256.slice(0, 12) + '… -> ' + String(nuRules).slice(0, 12) + '…) — het oordeel gold tegen andere regels' };
        }
      }
      return { ok: true, verdict: 'finalized', receipt: existing, idempotent: true, run_meta: markRunFinalized(root, runId, existing) };
    }
    return { ok: false, verdict: 'refused', reason: 'run is al gefinaliseerd op digest ' + String(existing.digest).slice(0, 12) + '… maar de log is daarna veranderd (nu ' + d0.digest.slice(0, 12) + '…) en matcht de receipt niet meer — onderzoek de aangroei; een afgeronde run verandert niet', stale: true };
  }

  // digest VOOR de contractcheck — en HERLEZEN erna: het contract mag de bewijslog niet onder ons vandaan
  // zien veranderen (r4 #9). runcontract wordt hier bewust ZONDER --log-event gedraaid (leest alleen).
  const dPre = digestOf(file);
  /** R7-02 (zevende herreview): ik CLAIMDE dat de pins vóór de contractcheck werden bepaald, maar ze
   *  stonden er ná — en `rulesetPin` mocht null zijn, waardoor `null === null` een "geslaagde" finalize
   *  met een direct ongeldige receipt kon opleveren. Nu echt vóór, welgevormd geëist, en na elke stap
   *  opnieuw vergeleken. Wat je pint moet de staat zijn die BEOORDEELD is, niet de staat die daarna
   *  toevallig op schijf stond. */
  /** R10-02: ÉÉN canonieke lezing voor digest én commit — de eerdere aparte tweede lezing op het
   *  receipt-schrijfpunt was zelf een TOCTOU-venster. */
  const evidenceSetPre = canonicalEvidenceOf(root, runId);
  const evidencePre = evidenceSetPre ? evidenceSetPre.digest : null;
  if (!evidencePre) {
    return { ok: false, verdict: 'refused', reason: 'geen geldige bewijsset (gate-evidence.json) voor deze run — een eindverdict dat aan geen bewijs gebonden is, is geen eindverdict' };
  }
  const rulesetPre = rulesetHashOf(root);
  if (typeof rulesetPre !== 'string' || !/^[0-9a-f]{64}$/i.test(rulesetPre)) {
    return { ok: false, verdict: 'refused', reason: 'de regelset levert geen welgevormde sha256 (' + JSON.stringify(rulesetPre) + ') — zonder die pin is onbekend tegen welke regels het oordeel gold' };
  }
  const domain = runDomainOf(root, runId);
  const contractCli = path.join(root, '.claude', 'forge-bin', 'forge-runcontract.cjs');
  const rcArgs = [contractCli, 'check', '--run', runId, '--root', root, '--json'];
  if (domain) rcArgs.push('--domain', domain);
  const rc = spawnSync(process.execPath, rcArgs, { encoding: 'utf8', timeout: 120000 });
  if (rc.status !== 0) {
    return { ok: false, verdict: 'refused', reason: 'forge-runcontract is niet groen (exit ' + rc.status + (domain ? ', domein ' + domain : '') + ') — finaliseren over een rood contract zou het ene eindverdict corrumperen', contract_output: String(rc.stdout || '').trim().slice(0, 800) };
  }
  /** R10-04 (tiende herreview): eindpunten vergelijken laat het venster WAARIN het kind las onzichtbaar
   *  (ruleset A → zwakkere B → A tijdens de child = groen beoordeeld onder B, receipt pint A). Het kind
   *  rapporteert daarom nu ZELF welke hashes het las, en die moeten exact onze pins zijn. Onparseerbare
   *  kinduitvoer is fail-closed: een contract waarvan we niet weten wat het las, bewijst niets. */
  let kind;
  try { kind = JSON.parse(String(rc.stdout || '')); }
  catch { return { ok: false, verdict: 'refused', reason: 'de contractcheck gaf geen parseerbare JSON terug — onbekend welke regelset/bewijsset het kind werkelijk las (fail-closed)' }; }
  if (kind.ruleset_sha256_used !== rulesetPre) {
    return { ok: false, verdict: 'refused', reason: 'het contract-kind las regelset ' + String(kind.ruleset_sha256_used).slice(0, 12) + '… terwijl finalize ' + rulesetPre.slice(0, 12) + '… pinde — de regels wisselden tijdens de check (A→B→A is nu zichtbaar)' };
  }
  if (kind.evidence_digest_used !== evidencePre) {
    return { ok: false, verdict: 'refused', reason: 'het contract-kind las bewijsset ' + String(kind.evidence_digest_used).slice(0, 12) + '… terwijl finalize ' + evidencePre.slice(0, 12) + '… pinde — het bewijs wisselde tijdens de check' };
  }
  const dPost = digestOf(file);
  if (dPost.digest !== dPre.digest) {
    return { ok: false, verdict: 'refused', reason: 'de eventlog veranderde TIJDENS de contractcheck (digest ' + dPre.digest.slice(0, 12) + '… -> ' + dPost.digest.slice(0, 12) + '…) — geen stabiele transactie; draai finalize opnieuw op een rustende log' };
  }

  /** r5 #11: crash-recovery — eindigt de log al op een run_finalized-slotevent ZONDER receipt (een
   *  eerdere finalize crashte tussen slotevent en receipt-write), dan appenden we GEEN tweede slotevent
   *  maar schrijven we de receipt over de bestaande staat. */
  const lastEntry = events[events.length - 1];
  const danglingSlot = lastEntry && lastEntry.event_type === 'run_finalized';
  if (!danglingSlot) {
    // audittrail EERST (verplicht, via de writer onder de events-lock) — daarna pint de receipt de log MET dit event.
    const le = spawnSync(process.execPath, [logEventCli(root), runId, 'run_finalized', JSON.stringify({ agent: 'orchestrator', evidence: 'run-finalized.json', note: 'digest-basis ' + dPost.digest.slice(0, 16) + '… · ' + events.length + ' events · contract ok' + (domain ? ' · domein ' + domain : '') })], { encoding: 'utf8', timeout: 60000 });
    if (le.status !== 0) {
      return { ok: false, verdict: 'refused', reason: 'het verplichte run_finalized-audittrail-event kon niet worden gelogd (exit ' + le.status + ': ' + String(le.stderr || '').trim().slice(0, 200) + ') — zonder audittrail geen receipt', event_error: String(le.stderr || '').trim().slice(0, 200) };
    }
  }
  const clsFinal = classify(root, runId);
  if (clsFinal.status !== 'valid') {
    return { ok: false, verdict: 'refused', reason: 'de log is na het audittrail-event niet meer keten-valide (' + clsFinal.status + ') — receipt geweigerd' };
  }
  /** r5 #9: is er TUSSEN de contractcheck en het slotevent alsnog een werk-/lifecycle-event geland
   *  (check_failed, file_changed, ...), dan pint de receipt anders een rood log. Herbeoordeel de
   *  volledige lifecycle + staartregel op de eindstand; het exacte slotevent moet de laatste regel zijn. */
  const finalEvents = clsFinal.entries;
  const lastFinal = finalEvents[finalEvents.length - 1];
  if (!lastFinal || lastFinal.event_type !== 'run_finalized') {
    return { ok: false, verdict: 'refused', reason: 'na het audittrail-event landde nog een ander event (' + (lastFinal ? lastFinal.event_type : 'geen') + ' als laatste regel) — geen stabiele transactie; receipt geweigerd' };
  }
  const lastLifecycleFinal = [...finalEvents].reverse().find((e) => LIFECYCLE_EVENTS.has(e.event_type));
  if (!lastLifecycleFinal || lastLifecycleFinal.event_type !== 'run_completed') {
    return { ok: false, verdict: 'refused', reason: 'tijdens het finaliseren veranderde de lifecycle-staat (' + (lastLifecycleFinal ? lastLifecycleFinal.event_type : 'geen') + ') — receipt geweigerd' };
  }
  /** R7-03 (zevende herreview): na de contractcheck werd alleen gecontroleerd dat `run_finalized` de
   *  laatste regel is en `run_completed` het laatste lifecycle-event. De illegalTail-controle uit de
   *  voorfase werd NIET herhaald, dus een `file_changed` of `owner_override` kon precies tussen de
   *  contractcheck en onze eigen slot-append landen: daarna is het slotevent weer netjes de laatste regel
   *  en werd een onbeoordeelde staat gefinaliseerd. Dezelfde controle hoort op de eindstand te draaien. */
  const completedIdxFinal = finalEvents.map((e) => e.event_type).lastIndexOf('run_completed');
  const illegalTailFinal = finalEvents.slice(completedIdxFinal + 1).find((e) => !POST_COMPLETION_ALLOWED.has(e.event_type));
  if (illegalTailFinal) {
    return { ok: false, verdict: 'refused', reason: 'tussen de contractcheck en het slotevent landde nog een werk-event (' + illegalTailFinal.event_type + ') — die staat is nooit beoordeeld; receipt geweigerd' };
  }
  /** R5-06/R5-07: een receipt zonder bindbare bewijsset is geen receipt. Eerder schreef finalize dan
   *  gewoon `evidence_digest: null`, waarna check() de vergelijking oversloeg (die was conditioneel) en
   *  alsnog FINALIZED gaf. Nu weigert finalize eerlijk. De pins worden HIER bepaald en na de
   *  receipt-write opnieuw geverifieerd, zodat een wijziging tussen contractcheck en write niet als
   *  nooit-beoordeeld bewijs kan worden ingepind. */
  /** R7-02: de pins die het CONTRACT beoordeeld heeft, moeten na het slotevent nog exact gelden — anders
   *  pinnen we een staat die niemand heeft beoordeeld. */
  const evidenceDigest = evidencePre;
  const rulesetPin = rulesetPre;
  if (evidenceDigestOf(root, runId) !== evidenceDigest || rulesetHashOf(root) !== rulesetPin) {
    return { ok: false, verdict: 'refused', reason: 'de bewijsset of regelset veranderde TIJDENS de contractcheck — het groene oordeel gold over een andere staat; draai finalize opnieuw op een rustende staat' };
  }
  const dFinal = digestOf(file);
  const lastSeq = finalEvents.reduce((m, e) => Number.isFinite(Number(e.seq)) ? Math.max(m, Number(e.seq)) : m, 0);
  /** R10-02: een receipt die tegelijk FINALIZED en een RODE toepasselijke IV-status draagt, geeft twee
   *  tegenstrijdige gezaghebbende signalen af (HEAD-race tussen contractcheck en statusbepaling). Dat
   *  is geen metadata-detail: dan is niet bewezen wat de receipt claimt. Fail-closed. */
  const ivStatus = independentVerificationStatus(root, runId);
  if (ivStatus && ivStatus.available === true && ivStatus.applicable !== false && ivStatus.ok !== true) {
    return { ok: false, verdict: 'refused', reason: 'de independent-verification-status is TOEPASSELIJK maar niet groen op het moment van finaliseren — een FINALIZED-receipt naast een rode IV-status zou twee tegenstrijdige eindsignalen afgeven; los de verificatie op of draai finalize opnieuw op een rustende staat' };
  }
  const receipt = {
    schema: 2, run_id: runId, digest: dFinal.digest, bytes: dFinal.bytes, events: finalEvents.length, seq_last: lastSeq || null,
    contract: 'ok', domain: domain, ruleset_sha256: rulesetPin,
    /** R3-05 (derde Codex-herreview 2026-08-09): de receipt pinde de eventlog en de ruleset, maar NIET de
     *  bewijsset. Daardoor kon `gate-evidence.json` ná finalisatie veranderen terwijl het gezaghebbende
     *  verdict FINALIZED bleef — een TOCTOU-gat precies op de plek waar het oordeel definitief hoort te
     *  zijn. De canonieke digest gaat nu mee in de receipt en wordt bij elke check herberekend. */
    evidence_digest: evidenceDigest,
    /** R8-05 (achtste herreview): de receipt pinde log, bewijs en regelset — maar niet de CODE. Na
     *  finalisatie kon HEAD of de bron veranderen terwijl check() en de idempotente herbevestiging
     *  FINALIZED bleven zeggen. De commit waarop het bewijs draaide staat nu in de receipt en wordt bij
     *  elke check hervergeleken; verschuift hij, dan is het oordeel over andere code geveld. */
    code_commit: (evidenceSetPre && evidenceSetPre.commit) || null,
    /** R4-07/R5-08 (twee rondes, zelfde punt): de gezaghebbende receipt droeg de owner-gated caveat NIET.
     *  Een consument las FINALIZED en kon dat als principal-onafhankelijk opvatten, terwijl OWNER-GATED.md
     *  juist vastlegt dat de scheiding op agentLABEL rust. Een eindverdict dat zijn eigen beperking niet
     *  meedraagt, laat de lezer een sterkere claim maken dan het bewijs toestaat. */
    independent_verification: ivStatus,
    finalized_at: new Date().toISOString(), ...(danglingSlot ? { recovered_dangling_slot: true } : {}),
  };
  writeAtomic(receiptFileOf(root, runId), JSON.stringify(receipt, null, 2) + '\n');
  /** r5 #9 (staart): landde er een append tussen dFinal en de receipt-write, dan zou finalize "ok"
   *  teruggeven met een direct-STALE receipt. Naverificatie: matcht de log de receipt niet meer exact,
   *  dan gaat de receipt weg en faalt de finalize eerlijk. */
  /** R5-07: de log werd na de receipt-write al nageverifieerd, maar bewijs en regelset niet — een
   *  wijziging in dat venster belandde ongezien als "nieuwe" pin in de receipt. */
  if (evidenceDigestOf(root, runId) !== evidenceDigest || rulesetHashOf(root) !== rulesetPin) {
    try { fs.unlinkSync(receiptFileOf(root, runId)); } catch { }
    return { ok: false, verdict: 'refused', reason: 'de bewijsset of regelset veranderde TIJDENS het finaliseren — receipt teruggetrokken; draai finalize opnieuw op een rustende staat' };
  }
  const dVerify = digestOf(file);
  if (dVerify.digest !== dFinal.digest || dVerify.bytes !== dFinal.bytes) {
    try { fs.unlinkSync(receiptFileOf(root, runId)); } catch { }
    return { ok: false, verdict: 'refused', reason: 'de log veranderde tijdens het schrijven van de receipt (digest ' + dFinal.digest.slice(0, 12) + '… -> ' + dVerify.digest.slice(0, 12) + '…) — receipt teruggetrokken; draai finalize opnieuw op een rustende log' };
  }
  // Bewust NA de staartverificatie: pas als de receipt onherroepelijk staat, mag de metadata volgen.
  // Faalt dit, dan blijft de finalisatie geldig en meldt run_meta eerlijk waarom hij niet is bijgewerkt.
  const runMeta = markRunFinalized(root, runId, receipt);
  return { ok: true, verdict: 'finalized', receipt, event_logged: true, run_meta: runMeta };
}

function readReceipt(root, runId) {
  try { return JSON.parse(fs.readFileSync(receiptFileOf(root, runId), 'utf8')); } catch { return null; }
}
/** receiptState — r5 #7/#11: onderscheid AFWEZIG (nooit gefinaliseerd) van ONLEESBAAR/ONGELDIG
 *  (fail-closed: een corrupt of zelfgeschreven receipt is nooit stilzwijgend "geen receipt" of
 *  "geldig"). Een geldig receipt draagt run_id-binding, digest/bytes en contract:'ok'. */
function receiptState(root, runId) {
  const file = receiptFileOf(root, runId);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { state: 'absent' }; }
  let r;
  try { r = JSON.parse(raw); } catch { return { state: 'invalid', reason: 'receipt is onparseerbaar (fail-closed)' }; }
  if (!r || typeof r !== 'object' || Array.isArray(r)) return { state: 'invalid', reason: 'receipt is geen object' };
  if (r.run_id !== runId) return { state: 'invalid', reason: 'receipt draagt run_id ' + String(r.run_id).slice(0, 40) + ', niet ' + runId };
  if (typeof r.digest !== 'string' || r.digest.length !== 64 || !Number.isFinite(r.bytes)) return { state: 'invalid', reason: 'receipt mist een geldige digest/bytes-pin' };
  if (r.contract !== 'ok') return { state: 'invalid', reason: 'receipt claimt geen groen contract' };
  /** R5-06 (vijfde herreview): de evidence- en rulesetvergelijkingen in check() draaiden alleen ALS de
   *  receipt die pins al droeg — en receiptState eiste ze niet. Een legacy of zelfgeschreven receipt zonder
   *  beide pins kreeg dus gewoon FINALIZED en sloeg alle nieuwe controles over. Een conditionele controle
   *  op een veld dat je niet verplicht stelt, is geen controle. Vanaf schema 2 zijn ze verplicht en
   *  welgevormd; een receipt zonder die binding is ONGELDIG, niet "oud maar goed". */
  if (r.schema !== 2) return { state: 'invalid', reason: 'receipt draagt schema ' + JSON.stringify(r.schema) + ' — alleen schema 2 bindt bewijs en regelset, dus een oudere receipt is niet te vertrouwen' };
  if (typeof r.evidence_digest !== 'string' || !/^[0-9a-f]{64}$/i.test(r.evidence_digest)) return { state: 'invalid', reason: 'receipt mist een welgevormde evidence_digest — het oordeel is dan aan geen bewijsset gebonden' };
  if (typeof r.ruleset_sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(r.ruleset_sha256)) return { state: 'invalid', reason: 'receipt mist een welgevormde ruleset_sha256 — onbekend tegen welke regels het oordeel gold' };
  /** R9-04 (negende herreview): code_commit werd wel GESCHREVEN maar door niets geeist of vergeleken —
   *  receiptState liet hem weg, de idempotente herbevestiging keek er niet naar. Een pin die geen enkele
   *  ingang controleert, bindt niets; dat is exact hetzelfde patroon als R8-03 een laag hoger. */
  if (typeof r.code_commit !== 'string' || !/^[0-9a-f]{40}$/i.test(r.code_commit)) return { state: 'invalid', reason: 'receipt mist een welgevormde code_commit — onbekend op welke code het bewijs draaide' };
  return { state: 'valid', receipt: r };
}

/** check — het ene eindverdict voor consumenten (herbouwd, r4 #10-rest): de receipt pint de VOLLEDIGE
 *  log inclusief het run_finalized-slotevent, dus het verdict is een EXACTE digest+bytes-match plus een
 *  keten-valide log. Truncatie, aangroei, bewerking of een vervalste extra run_finalized-regel wijzigt de
 *  bytes of breekt de keten ⇒ STALE. Er bestaat geen "toegestane staart" meer om te vervalsen. */
function check(root, runId) {
  const rs = receiptState(root, runId);
  if (rs.state === 'absent') return { verdict: 'NOT_FINALIZED', reason: 'geen run-finalized.json receipt' };
  if (rs.state === 'invalid') return { verdict: 'STALE', reason: 'receipt ongeldig: ' + rs.reason + ' — fail-closed (r5 #7)' };
  const receipt = rs.receipt;
  const cls = classify(root, runId);
  if (cls.status === 'missing') return { verdict: 'STALE', receipt, reason: 'receipt aanwezig maar de eventlog ontbreekt' };
  if (cls.status !== 'valid') {
    return { verdict: 'STALE', receipt, reason: 'eventlog is ' + cls.status + ' — het gefinaliseerde bewijs is niet meer keten-integer' };
  }
  // r5 #7: de log moet ook INHOUDELIJK de gefinaliseerde vorm hebben — het exacte slotevent als laatste
  // regel. Een pre-r5-receipt (zonder slotevent-in-digest) valt hierdoor eerlijk op STALE en vergt een
  // bewuste herfinalizatie, nooit een stilzwijgende acceptatie onder oude semantiek.
  const last = cls.entries[cls.entries.length - 1];
  if (!last || last.event_type !== 'run_finalized') {
    return { verdict: 'STALE', receipt, reason: 'de log eindigt niet op het run_finalized-slotevent (laatste: ' + (last ? last.event_type : 'geen') + ') — geen geldige gefinaliseerde vorm' };
  }
  let d = null;
  try { d = digestOf(eventsFileOf(root, runId)); } catch { return { verdict: 'STALE', receipt, reason: 'eventlog onleesbaar' }; }
  if (d.digest !== receipt.digest || d.bytes !== receipt.bytes) {
    return { verdict: 'STALE', receipt, reason: 'de log matcht de receipt niet meer exact (digest/bytes gewijzigd — afgekapt, aangegroeid of bewerkt)' };
  }
  /** R3-05: de bewijsset hoort net zo goed bij het gepinde subject als de log. Wijzigt gate-evidence.json
   *  na de finalisatie, dan is het oordeel niet meer over dat bewijs gegeven — dus STALE, precies zoals
   *  bij een gewijzigde log. Receipts van vóór deze wijziging dragen geen evidence_digest; die blijven
   *  geldig op hun eigen (log-)pin, maar krijgen wel een zichtbare markering dat die binding ontbrak. */
  {
    /** R10-02: één canonieke lezing voor digest ÉN commit — en de code_commit-vergelijking die bij mijn
     *  R9-refactor uit check() was weggevallen, staat hier nu onlosmakelijk naast de digest. Een receipt
     *  waarvan de code_commit is gemanipuleerd terwijl het bewijs ongewijzigd bleef, valt hierop. */
    const nuSet = canonicalEvidenceOf(root, runId);
    const nu = nuSet ? nuSet.digest : null;
    if (nu !== receipt.evidence_digest) {
      return { verdict: 'STALE', receipt, reason: 'de bewijsset is sinds de finalisatie veranderd (gate-evidence ' + receipt.evidence_digest.slice(0, 12) + '… -> ' + (nu ? nu.slice(0, 12) + '…' : 'ontbreekt/ongeldig') + ') — het verdict sloeg op ander bewijs' };
    }
    const nuCommit = (nuSet && nuSet.commit) || null;
    if (nuCommit !== receipt.code_commit) {
      return { verdict: 'STALE', receipt, reason: 'het bewijs hoort bij commit ' + String(nuCommit).slice(0, 12) + '… terwijl de receipt code_commit ' + String(receipt.code_commit).slice(0, 12) + '… draagt — de codepin klopt niet meer met het bewijs' };
    }
  }
  /** R4-03: de receipt pinde de regelset al, maar check() vergeleek hem nooit. Een gewijzigde
   *  FORGE_HARD_RULES.json betekent dat het oordeel tegen ANDERE regels is geveld — even ongeldig als een
   *  gewijzigde log. */
  {
    const nuRules = rulesetHashOf(root);
    if (nuRules !== receipt.ruleset_sha256) {
      return { verdict: 'STALE', receipt, reason: 'de regelset is sinds de finalisatie veranderd (' + receipt.ruleset_sha256.slice(0, 12) + '… -> ' + String(nuRules).slice(0, 12) + '…) — het verdict gold tegen andere regels' };
    }
  }
  /** R4-07/R5-08: ook de UITSLAG draagt de caveat, niet alleen de receipt — een consument die alleen
   *  `verdict` leest, mag de owner-gated beperking niet mislopen. */
  return {
    verdict: 'FINALIZED', receipt,
    evidence_pinned: typeof receipt.evidence_digest === 'string' && !!receipt.evidence_digest,
    independent_verification: receipt.independent_verification || { available: false, reason: 'receipt van vóór deze pinning', label_only: true },
    label_only: true,
  };
}

module.exports = { finalize, check, readReceipt, receiptFileOf, classify };

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const get = (name) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : null; };
  const root = get('root') ? path.resolve(get('root')) : PROJECT_ROOT_DEFAULT;
  const runId = get('run');
  const asJson = args.includes('--json');
  if (!cmd || !runId || !/^[A-Za-z0-9_-]+$/.test(runId)) {
    console.error('usage: node forge-finalize.cjs finalize|check --run <id> [--root <projectRoot>] [--json]');
    process.exit(2);
  }
  if (cmd === 'finalize') {
    const r = finalize(root, runId);
    console.log(asJson ? JSON.stringify(r, null, 2) : (r.ok ? 'FINALIZED — ' + runId + ' @ ' + r.receipt.digest.slice(0, 16) + '… (' + r.receipt.events + ' events' + (r.idempotent ? ', idempotente herbevestiging' : '') + ')' : 'REFUSED — ' + r.reason));
    process.exit(r.ok ? 0 : 3);
  }
  if (cmd === 'check') {
    const r = check(root, runId);
    console.log(asJson ? JSON.stringify(r, null, 2) : r.verdict + (r.reason ? ' — ' + r.reason : ''));
    process.exit(r.verdict === 'FINALIZED' ? 0 : 3);
  }
  console.error('unknown command: ' + cmd);
  process.exit(2);
}
