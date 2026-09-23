#!/usr/bin/env node
'use strict';
/**
 * independent-verification — de honesty-core-regel die zelf-goedkeuring onmogelijk maakt
 * (research-lane A, 2026-08-09). RED-baseline die dit afdwingt: een Boss logde zijn EIGEN check_passed
 * en kreeg CONTRACT OK (red-baseline-imp001.txt). Hermetisch: eigen temp-root, echte writer + contract.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (extra ? ' :: ' + extra : '')); } };
const RC = require(path.join(__dirname, 'forge-runcontract.cjs'));

console.log('independent-verification (honesty-core)');

// ---- 1) ADVERSARIEEL (herbouwd 2026-08-09 na Codex-review F-01..F-10). De VORIGE versie van dit blok
//      legde de drie onveilige routes vast als GEWENST gedrag — 13/0 groen terwijl zeven invarianten open
//      stonden. Elke test hieronder probeert de poort te BREKEN; alleen de laatste twee horen te slagen.
{
  const iv = RC.independentVerification;
  const COMMIT = 'a'.repeat(40);
  const EVID = 'b'.repeat(64);
  const werk = (a, type) => ({ event_type: type || 'wp_completed', agent: a });
  const start = (a, id) => ({ event_type: 'review_started', agent: a, review_id: id });
  const klaar = (a, id, extra) => Object.assign({
    event_type: 'review_completed', agent: a, review_id: id,
    subject_log_hash: '@nu', commit_sha: COMMIT, evidence_digest: EVID, review_verdict: 'pass',
  }, extra || {});
  /** keten() stempelt prev_hash/entry_hash zoals de ECHTE writer dat doet. Zonder dit zou een fixture
   *  subjectbinding kunnen "halen" door prev_hash en subject_log_hash allebei zelf te verzinnen — precies
   *  het gat dat de evaluator sinds deze ronde dichttimmert. `@nu` = de reviewer las de actuele staat. */
  const H = (i) => crypto.createHash('sha256').update('keten' + i).digest('hex');
  const keten = (evs) => evs.map((e, i) => {
    const g = Object.assign({}, e, { prev_hash: i === 0 ? 'genesis' : H(i - 1), entry_hash: H(i) });
    if (g.subject_log_hash === '@nu') g.subject_log_hash = g.prev_hash;
    return g;
  });

  const goed = iv(keten([werk('Build Boss'), start('Verify Boss', 'r1'), klaar('Verify Boss', 'r1')]), { commitSha: COMMIT, evidenceDigest: EVID });
  t('1 een volledige, causale, subject-gebonden review SLAAGT', goed.ok === true && goed.route === 'causal-review', JSON.stringify(goed));
  t('1 en rapporteert eerlijk dat de scheiding op LABEL rust, niet op principal', goed.label_only === true);

  // F-01: de gecontroleerde partij noemt zichzelf externe reviewer
  t('1 F-01 een eigen check_passed met runtime:codex bewijst NIETS',
    iv([werk('Build Boss'), { event_type: 'check_passed', agent: 'Build Boss', runtime: 'codex' }]).ok === false);
  t('1 F-01 ook een agent_started met runtime:codex opent geen achterdeur',
    iv([werk('Build Boss'), { event_type: 'agent_started', agent: 'Build Boss', runtime: 'codex' }]).ok === false);
  // F-05: vrije attributie
  t('1 F-05 een verzonnen verified_by bewijst NIETS',
    iv([werk('x'), { event_type: 'check_passed', agent: 'x', verified_by: 'Iemand Die Nooit Bestond' }]).ok === false);
  // F-08: types die de strict writer niet kent mogen geen route zijn
  t('1 F-08 codex_review/verify_result zijn geen geldige review-events',
    iv([werk('x'), { event_type: 'codex_review', agent: 'y' }, { event_type: 'verify_result', agent: 'y' }]).ok === false);

  // causaliteit
  t('1 een completion zonder review_id wordt geweigerd',
    iv(keten([werk('a'), klaar('V', 'r1', { review_id: '' })])).ok === false);
  t('1 een completion zonder bijbehorende start wordt geweigerd',
    iv(keten([werk('a'), klaar('V', 'r-onbekend')])).ok === false);
  t('1 een start NA de completion is geen causale volgorde',
    iv(keten([werk('a'), klaar('V', 'r1'), start('V', 'r1')])).ok === false);
  t('1 een start van een ANDERE agent dan de afsluiter wordt geweigerd',
    iv(keten([werk('a'), start('W', 'r1'), klaar('V', 'r1')])).ok === false);
  t('1 de reviewer mag zelf geen werk hebben gedaan (zelf-goedkeuring)',
    iv(keten([werk('V'), start('V', 'r1'), klaar('V', 'r1')])).ok === false);

  // F-03 subjectbinding
  t('1 subject_log_hash die afwijkt van de echte runstaat wordt geweigerd',
    iv(keten([werk('a'), start('V', 'r1'), klaar('V', 'r1')]).map(e=>e.event_type==='review_completed'?Object.assign({},e,{subject_log_hash:'c'.repeat(64)}):e)).ok === false);
  t('1 een ongeketend event (geen prev_hash) kan niet subject-gebonden zijn',
    iv(keten([werk('a'), start('V', 'r1'), klaar('V', 'r1')]).map(e=>e.event_type==='review_completed'?Object.assign({},e,{prev_hash:''}):e)).ok === false);
  t('1 een ontbrekende of misvormde commit_sha wordt geweigerd',
    iv(keten([werk('a'), start('V', 'r1'), klaar('V', 'r1', { commit_sha: 'niet-een-sha' })])).ok === false);
  t('1 een review van een ANDERE commit dan de actuele wordt geweigerd',
    iv(keten([werk('a'), start('V', 'r1'), klaar('V', 'r1')]), { commitSha: 'd'.repeat(40), evidenceDigest: EVID }).ok === false);
  t('1 met de JUISTE actuele commit slaagt dezelfde review wel',
    iv(keten([werk('a'), start('V', 'r1'), klaar('V', 'r1')]), { commitSha: COMMIT, evidenceDigest: EVID }).ok === true);
  t('1 een ontbrekende evidence_digest wordt geweigerd',
    iv(keten([werk('a'), start('V', 'r1'), klaar('V', 'r1', { evidence_digest: '' })])).ok === false);

  // F-04 staleness
  const stale = iv(keten([werk('a'), start('V', 'r1'), klaar('V', 'r1'), werk('a', 'file_changed')]), { commitSha: COMMIT, evidenceDigest: EVID });
  t('1 F-04 werk NA de review maakt de review stale', stale.ok === false && /stale/.test(stale.reason), stale.reason);
  t('1 F-04 een nieuwe run_completed herstelt een stale review NIET',
    iv(keten([werk('a'), start('V', 'r1'), klaar('V', 'r1'), werk('a', 'file_changed'), { event_type: 'run_completed', agent: 'a' }])).ok === false);
  const hersteld = iv(keten([werk('a'), start('V', 'r1'), klaar('V', 'r1'), werk('a', 'file_changed'), start('V', 'r2'), klaar('V', 'r2')]), { commitSha: COMMIT, evidenceDigest: EVID });
  t('1 F-04 een NIEUWE review ná dat werk slaagt wel', hersteld.ok === true, hersteld.reason);

  // F-06 lege en geweigerde runs
  t('1 F-06 helemaal geen work-event => MISSING', iv(keten([start('V', 'r1'), klaar('V', 'r1')])).ok === false);
  t('1 F-06 alleen lifecycle en notities => MISSING',
    iv(keten([{ event_type: 'run_started', agent: 'a' }, { event_type: 'agent_note', agent: 'a', note: 'x' }, start('V', 'r1'), klaar('V', 'r1')])).ok === false);
  t('1 F-06 en de reden zegt WAAROM (niets om onafhankelijk van te zijn)',
    /niets om onafhankelijk van te zijn/.test(iv(keten([start('V', 'r1'), klaar('V', 'r1')])).reason));

  // een log ZONDER keten kan subjectbinding niet bewijzen: dan zijn prev_hash en subject_log_hash allebei
  // door de aanroeper te verzinnen. Fail-closed, geen zachte route.
  const ongeketend = iv([werk('a'), start('V', 'r1'), Object.assign(klaar('V', 'r1'), { prev_hash: 'z'.repeat(64), subject_log_hash: 'z'.repeat(64) })]);
  t('1 een ONGEKETENDE log kan subjectbinding niet bewijzen', ongeketend.ok === false && /keten is hier onderbroken/.test(ongeketend.reason), ongeketend.reason);

  // N-01: anoniem gelogd werk mag niet ONZICHTBAAR zijn — dan logt de uitvoerder zijn werk zonder naam,
  // valt buiten de werkersverzameling, en keurt het daarna onder een naam goed.
  const anoniem = iv(keten([{ event_type: 'wp_completed' }, start('V', 'r1'), klaar('V', 'r1')]), { commitSha: COMMIT, evidenceDigest: EVID });
  t('1 N-01 werk zonder agent maakt onafhankelijkheid ONBEPAALBAAR (fail-closed)',
    anoniem.ok === false && /zonder agent/i.test(anoniem.reason), anoniem.reason);

  // N-05: hergebruik van een review_id na nieuw werk mag niet opnieuw slagen
  const replay = iv(keten([werk('a'), start('V', 'r1'), klaar('V', 'r1'), werk('a', 'file_changed'), klaar('V', 'r1')]), { commitSha: COMMIT, evidenceDigest: EVID });
  t('1 N-05 een tweede completion op DEZELFDE start na nieuw werk wordt geweigerd', replay.ok === false, replay.reason);

  // N-04: inhoud produceren is werk — een reviewer die zelf een rapport opleverde is geen buitenstaander
  const rapporteur = iv(keten([werk('a'), { event_type: 'report_generated', agent: 'V' }, start('V', 'r1'), klaar('V', 'r1')]), { commitSha: COMMIT, evidenceDigest: EVID });
  t('1 N-04 wie zelf een rapport genereerde telt als werker, niet als reviewer', rapporteur.ok === false, rapporteur.reason);
  const naRapport = iv(keten([werk('a'), start('V', 'r1'), klaar('V', 'r1'), { event_type: 'report_generated', agent: 'a' }]), { commitSha: COMMIT, evidenceDigest: EVID });
  t('1 N-04 een rapport NA de review maakt hem stale', naRapport.ok === false && /stale/.test(naRapport.reason), naRapport.reason);

  // N-03: een willekeurige 64-hex evidence_digest is geen binding — hij moet de ECHTE bewijsset dekken
  t('1 N-03 een evidence_digest die niet de actuele bewijsset is, wordt geweigerd',
    iv(keten([werk('a'), start('V', 'r1'), klaar('V', 'r1')]), { commitSha: COMMIT, evidenceDigest: 'e'.repeat(64) }).ok === false);
  t('1 N-03 zonder bewijsset is er niets om aan te binden (fail-closed)',
    iv(keten([werk('a'), start('V', 'r1'), klaar('V', 'r1')]), { commitSha: COMMIT }).ok === false);
  // en de canonieke digest is stabiel onder wisselende timestamps/paden maar gevoelig voor de uitslag
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iv-evid-'));
    const schrijf = (gates) => {
      fs.mkdirSync(path.join(dir, '.claude', 'forge-runs', 'r'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.claude', 'forge-runs', 'r', 'gate-evidence.json'), JSON.stringify({ run_id: 'r', gates: gates.map((g) => Object.assign({ evidence_verified: true, code: { commit: 'a'.repeat(40), worktree_clean: true, stable: true } }, g)) }));
      return RC.canonicalEvidenceDigest(dir, 'r').digest;
    };
    const a = schrijf([{ name: 's', command: 'node test', output_file: 'gate-output/s.txt', exit_code: 0, output_sha256: 'a'.repeat(64), started_at: 'nu', duration_ms: 1 }]);
    const b = schrijf([{ name: 's', command: 'node test', output_file: 'gate-output/s.txt', exit_code: 0, output_sha256: 'a'.repeat(64), started_at: 'later', duration_ms: 999 }]);
    t('1 N-03 de digest negeert tijdstempels en duur (anders is hij bij elke herhaling anders)', a === b);
    const c = schrijf([{ name: 's', command: 'node test', output_file: 'gate-output/s.txt', exit_code: 1, output_sha256: 'a'.repeat(64) }]);
    t('1 N-03 maar een andere UITSLAG geeft wel een andere digest', a !== c);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // R3-04: een bewijsset moet ECHT bewijs zijn — vorm alleen is niet genoeg
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iv-schema-'));
    const digestVan = (gates) => {
      fs.mkdirSync(path.join(dir, '.claude', 'forge-runs', 'r'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.claude', 'forge-runs', 'r', 'gate-evidence.json'), JSON.stringify({ run_id: 'r', gates: gates.map((g) => Object.assign({ evidence_verified: true, code: { commit: 'a'.repeat(40), worktree_clean: true, stable: true } }, g)) }));
      return RC.canonicalEvidenceDigest(dir, 'r');
    };
    const geldig = [{ name: 's', command: 'node test', output_file: 'gate-output/s.txt', exit_code: 0, output_sha256: 'a'.repeat(64) }];
    t('1 R3-04 een geldige bewijsset levert een digest', digestVan(geldig) !== null);
    t('1 R3-04 een LEGE poort ({}) levert GEEN digest', digestVan([{}]) === null);
    t('1 R3-04 een poort zonder naam levert geen digest', digestVan([{ exit_code: 0, output_sha256: 'a'.repeat(64) }]) === null);
    t('1 R3-04 een niet-integer exitcode levert geen digest', digestVan([{ name: 's', command: 'node test', output_file: 'gate-output/s.txt', exit_code: '0', output_sha256: 'a'.repeat(64) }]) === null);
    t('1 R3-04 een misvormde output-hash levert geen digest', digestVan([{ name: 's', command: 'node test', output_file: 'gate-output/s.txt', exit_code: 0, output_sha256: 'kort' }]) === null);
    t('1 R3-04 DUBBELE poortnamen maken de sortering ambigu en worden geweigerd',
      digestVan([{ name: 's', command: 'node test', output_file: 'gate-output/s.txt', exit_code: 0, output_sha256: 'a'.repeat(64) }, { name: 's', command: 'node test', output_file: 'gate-output/s.txt', exit_code: 1, output_sha256: 'b'.repeat(64) }]) === null);
    const p1 = digestVan([{ name: 'a', command: 'node test', output_file: 'gate-output/a.txt', exit_code: 0, output_sha256: 'a'.repeat(64) }, { name: 'b', command: 'node test', output_file: 'gate-output/b.txt', exit_code: 0, output_sha256: 'b'.repeat(64) }]);
    const p2 = digestVan([{ name: 'b', command: 'node test', output_file: 'gate-output/b.txt', exit_code: 0, output_sha256: 'b'.repeat(64) }, { name: 'a', command: 'node test', output_file: 'gate-output/a.txt', exit_code: 0, output_sha256: 'a'.repeat(64) }]);
    t('1 R3-04 en de volgorde in het bestand mag de digest niet veranderen', p1.digest === p2.digest);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // R3-02: namen moeten toetsbaar zijn, en zonder registry is dat onmogelijk => fail-closed
  {
    const bekend = new Set(['build boss', 'review boss']);
    const basis = keten([werk('Build Boss'), start('Review Boss', 'r1'), klaar('Review Boss', 'r1')]);
    t('1 R3-02 met een geldige registry slaagt de review',
      iv(basis, { commitSha: COMMIT, evidenceDigest: EVID, knownAgents: bekend }).ok === true);
    t('1 R3-02 een werker met een NIET-geregistreerde naam wordt geweigerd',
      iv(keten([werk('Phantom Worker'), start('Review Boss', 'r1'), klaar('Review Boss', 'r1')]), { commitSha: COMMIT, evidenceDigest: EVID, knownAgents: bekend }).ok === false);
    const spook = iv(keten([werk('Build Boss'), start('Spookreviewer', 'r1'), klaar('Spookreviewer', 'r1')]), { commitSha: COMMIT, evidenceDigest: EVID, knownAgents: bekend });
    t('1 R3-02 een reviewer met een NIET-geregistreerde naam wordt geweigerd', spook.ok === false && /agentregistry/.test(spook.reason), spook.reason);
    const geenRegistry = iv(basis, { commitSha: COMMIT, evidenceDigest: EVID, knownAgents: new Set() });
    t('1 R3-02 ZONDER registry telt geen enkele verificatie (fail-closed, niet fail-open)',
      geenRegistry.ok === false && /fail-closed/.test(geenRegistry.reason), geenRegistry.reason);
    t('1 R3-02 en de echte projectregistry levert bruikbare namen op',
      (RC.knownAgentNames(path.join(__dirname, '..', '..')) || new Set()).has('build boss'));
  }

  /** R4-01: een review die NIET goedkeurt mag geen goedkeuring zijn. Dit was het pijnlijkste gat: de poort
   *  keek of er EEN review bestond, niet of die positief eindigde — en forge-verify emitteert
   *  lead_review_completed juist bij FOUTEN, dus een afkeuring bevestigde de afronding. */
  {
    const basis = (extra) => iv(keten([werk('a'), start('V', 'r1'), klaar('V', 'r1', extra)]), { commitSha: COMMIT, evidenceDigest: EVID });
    t('1 R4-01 een review met verdict CHANGES_REQUIRED bevestigt NIETS',
      basis({ review_verdict: 'CHANGES_REQUIRED' }).ok === false);
    t('1 R4-01 ook "blocked" of "fail" telt niet als goedkeuring',
      basis({ review_verdict: 'blocked' }).ok === false && basis({ review_verdict: 'fail' }).ok === false);
    const zonder = basis({ review_verdict: undefined });
    t('1 R4-01 een review ZONDER verdict is fail-closed, niet "waarschijnlijk goed"',
      zonder.ok === false && /verdict/.test(zonder.reason), zonder.reason);
    t('1 R4-01 een ok:false-vlag overrulet een positief klinkend verdict',
      basis({ review_verdict: 'pass', ok: false }).ok === false);
    t('1 R4-01 en een echt goedkeurend verdict slaagt wel', basis({ review_verdict: 'approved' }).ok === true);
  }

  // R4-02: de uitzonderingslijst mag alleen INERTE events bevatten
  t('1 R4-02 rejected_approach is werk (de writer eist er zelfs bewijs op)', RC.isWorkEventType('rejected_approach') === true);
  t('1 R4-02 agent_output en decision_logged zijn werk', RC.isWorkEventType('agent_output') === true && RC.isWorkEventType('decision_logged') === true);
  t('1 R4-02 een reviewer die zelf rejected_approach produceerde is geen buitenstaander',
    iv(keten([werk('a'), { event_type: 'rejected_approach', agent: 'V' }, start('V', 'r1'), klaar('V', 'r1')]), { commitSha: COMMIT, evidenceDigest: EVID }).ok === false);
  t('1 R4-02 en rejected_approach NA de review maakt hem stale',
    iv(keten([werk('a'), start('V', 'r1'), klaar('V', 'r1'), { event_type: 'rejected_approach', agent: 'a' }]), { commitSha: COMMIT, evidenceDigest: EVID }).ok === false);

  /** RONDE 5 — vier gaten die de VORIGE ronde had geïntroduceerd of gemist. */
  {
    const basis = (extra) => iv(keten([werk('a'), start('V', 'r1'), klaar('V', 'r1', extra)]), { commitSha: COMMIT, evidenceDigest: EVID });
    // R5-02: tegenstrijdige uitkomstvelden — zo verstop je een afkeuring
    t('1 R5-02 review_verdict:approved naast verdict:CHANGES_REQUIRED wordt geweigerd',
      basis({ review_verdict: 'approved', verdict: 'CHANGES_REQUIRED' }).ok === false);
    t('1 R5-02 ook status/result/outcome tellen mee',
      basis({ review_verdict: 'pass', status: 'failed' }).ok === false
      && basis({ review_verdict: 'pass', outcome: 'blocked' }).ok === false
      && basis({ review_verdict: 'pass', result: 'rejected' }).ok === false);
    t('1 R5-02 en de STRING "false" in ok telt net zo goed als de boolean',
      basis({ review_verdict: 'pass', ok: 'false' }).ok === false);
    t('1 R5-02 een eenduidig positief beeld slaagt wel',
      basis({ review_verdict: 'pass', status: 'ok', ok: true }).ok === true);
  }
  // R5-03: een goedkeuring bovenop ROOD bewijs bevestigt niets
  t('1 R5-03 een gefaalde poort in de bewijsset blokkeert de verificatie',
    iv(keten([werk('a'), start('V', 'r1'), klaar('V', 'r1')]), { commitSha: COMMIT, evidenceDigest: EVID, evidenceAllGreen: false, evidenceFailed: ['doctor'] }).ok === false);
  t('1 R5-03 en de reden noemt de gefaalde poort',
    /doctor/.test(iv(keten([werk('a'), start('V', 'r1'), klaar('V', 'r1')]), { commitSha: COMMIT, evidenceDigest: EVID, evidenceAllGreen: false, evidenceFailed: ['doctor'] }).reason));
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iv-rood-'));
    fs.mkdirSync(path.join(dir, '.claude', 'forge-runs', 'r'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'forge-runs', 'r', 'gate-evidence.json'), JSON.stringify({ run_id: 'r', gates: [{ name: 'a', command: 'node test', output_file: 'gate-output/a.txt', exit_code: 0, output_sha256: 'a'.repeat(64), evidence_verified: true, code: { commit: 'a'.repeat(40), worktree_clean: true, stable: true } }, { name: 'b', command: 'node test', output_file: 'gate-output/b.txt', exit_code: 1, output_sha256: 'b'.repeat(64), evidence_verified: true, code: { commit: 'a'.repeat(40), worktree_clean: true, stable: true } }] }));
    const r = RC.canonicalEvidenceDigest(dir, 'r');
    t('1 R5-03 de canonicalizer meldt eerlijk WELKE poort faalde', r.allGreen === false && r.failed.join() === 'b', JSON.stringify(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // R5-04: een AFGEKEURDE poging verbruikt de start net zo goed
  t('1 R5-04 afgekeurd-dan-goedgekeurd op dezelfde start wordt geweigerd',
    iv(keten([werk('a'), start('V', 'r1'), klaar('V', 'r1', { review_verdict: 'CHANGES_REQUIRED' }), klaar('V', 'r1')]), { commitSha: COMMIT, evidenceDigest: EVID }).ok === false);
  // R5-01: actieve uitvoering is werk; dispatch blijft een gemotiveerde uitzondering
  t('1 R5-01 een reviewer die zelf fix_started logde is geen buitenstaander',
    iv(keten([werk('a'), { event_type: 'fix_started', agent: 'V' }, start('V', 'r1'), klaar('V', 'r1')]), { commitSha: COMMIT, evidenceDigest: EVID }).ok === false);
  t('1 R5-01 uitvoering NA de review maakt hem stale',
    iv(keten([werk('a'), start('V', 'r1'), klaar('V', 'r1'), { event_type: 'fix_started', agent: 'a' }]), { commitSha: COMMIT, evidenceDigest: EVID }).ok === false);
  /** R6-02 (zesde herreview) haalde mijn eerdere aanname onderuit dat een dispatch categorisch geen werk
   *  is. Een probe met `agent_started {agent:"Review Boss", task:"implement patch"}` toont letterlijk dat
   *  de bevestiger voor IMPLEMENTATIE is ingezet. Nu geldt: een dispatch is werk TENZIJ hij aantoonbaar
   *  een reviewopdracht is — het bewijs ligt bij het event, niet bij de aanname. */
  t('1 R6-02 een dispatch om te IMPLEMENTEREN maakt de reviewer een uitvoerder',
    iv(keten([werk('a'), { event_type: 'agent_started', agent: 'V', dispatch_id: 'd1', task: 'implement patch' }, start('V', 'r1'), klaar('V', 'r1')]), { commitSha: COMMIT, evidenceDigest: EVID }).ok === false);
  t('1 R6-02 een dispatch ZONDER opdracht telt ook als werk (veilige default)',
    iv(keten([werk('a'), { event_type: 'agent_started', agent: 'V', dispatch_id: 'd1' }, start('V', 'r1'), klaar('V', 'r1')]), { commitSha: COMMIT, evidenceDigest: EVID }).ok === false);
  t('1 R6-02/R7-04 alleen een GESTRUCTUREERD rolveld laat de reviewer buitenstaander zijn',
    iv(keten([werk('a'), { event_type: 'agent_started', agent: 'V', dispatch_id: 'd1', role: 'review', task: 'review WP2' }, start('V', 'r1'), klaar('V', 'r1')]), { commitSha: COMMIT, evidenceDigest: EVID }).ok === true);
  // R6-03: een owner_override kan het contract na het oordeel doen kantelen — dus staling, maar de owner
  // is geen uitvoerder.
  t('1 R6-03 een owner_override NA de review maakt hem stale',
    iv(keten([werk('a'), start('V', 'r1'), klaar('V', 'r1'), { event_type: 'owner_override', agent: 'owner', rule: 'x', by: 'owner', reason: 'y' }]), { commitSha: COMMIT, evidenceDigest: EVID }).ok === false);
  t('1 R6-03 maar de owner belandt niet in de werkersverzameling',
    iv(keten([{ event_type: 'owner_override', agent: 'owner', rule: 'x', by: 'owner', reason: 'y' }, werk('a'), start('V', 'r1'), klaar('V', 'r1')]), { commitSha: COMMIT, evidenceDigest: EVID }).workers.includes('owner') === false);
  // R6-01: "er was ooit een goedkeuring" is niet hetzelfde als "het oordeel staat"
  t('1 R6-01 een AFKEURING na de goedkeuring haalt die onderuit',
    iv(keten([werk('a'), start('V', 'r1'), klaar('V', 'r1'), start('W', 'r2'), klaar('W', 'r2', { review_verdict: 'CHANGES_REQUIRED' })]), { commitSha: COMMIT, evidenceDigest: EVID }).ok === false);
  t('1 R6-01 en de reden noemt de latere ongeldige completion',
    /niet geldig/i.test(iv(keten([werk('a'), start('V', 'r1'), klaar('V', 'r1'), start('W', 'r2'), klaar('W', 'r2', { review_verdict: 'blocked' })]), { commitSha: COMMIT, evidenceDigest: EVID }).reason));

  /** R5-06 — zelf gevonden bij het draaien van ronde 5, en het bevestigt Codex' waarschuwing uit R4-01:
   *  forge-verify.cjs logt `lead_review_completed` juist BIJ EEN MISMATCH, als trigger voor rework. Een
   *  eventtype dat "review afgerond" heet maar "er is werk mislukt" betekent, hoort geen kandidaat te
   *  zijn voor onafhankelijke verificatie. Ik had het laten staan omdat de verdict-eis het toch wel zou
   *  tegenhouden — dat is te slim geredeneerd: het juiste antwoord is hem er niet in te hebben. */
  t('1 R5-06 lead_review_* is GEEN geldig reviewprotocol (het is een rework-trigger)',
    !RC.REVIEW_DONE_TYPES.has('lead_review_completed') && !RC.REVIEW_START_TYPES.has('lead_review_started'));
  t('1 R5-06 en zo\'n event bevestigt dus niets, ook niet met een positief verdict',
    iv(keten([werk('a'), { event_type: 'lead_review_started', agent: 'V', review_id: 'r1' },
      { event_type: 'lead_review_completed', agent: 'V', review_id: 'r1', subject_log_hash: '@nu', commit_sha: COMMIT, evidence_digest: EVID, review_verdict: 'pass' }]),
    { commitSha: COMMIT, evidenceDigest: EVID }).ok === false);

  /** RONDE 6 — resterende bevindingen uit de nooit-verwerkte backlog. */
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iv-r6-'));
    const digestVan = (extra, gate) => {
      fs.mkdirSync(path.join(dir, '.claude', 'forge-runs', 'r'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.claude', 'forge-runs', 'r', 'gate-evidence.json'),
        JSON.stringify(Object.assign({ gates: [Object.assign({ name: 's', command: 'node test', output_file: 'gate-output/s.txt', exit_code: 0, output_sha256: 'a'.repeat(64) }, gate || {})] }, extra || {})));
      return RC.canonicalEvidenceDigest(dir, 'r');
    };
    t('1 R6-05 een AFGEKAPTE poort (timed_out) is geen bewijs', digestVan(null, { timed_out: true }) === null);
    t('1 R6-05 een poort die nooit startte (spawn_error) evenmin', digestVan(null, { spawn_error: 'ENOENT' }) === null);
    t('1 R6-05 en een hash die de recorder zelf niet kon bevestigen ook niet', digestVan(null, { evidence_verified: false }) === null);
    t('1 R6-05 een manifest van een ANDERE run telt niet als bewijs van deze run', digestVan({ run_id: 'een-andere-run' }) === null);
    t('1 R6-05 maar het correcte manifest levert gewoon een digest', digestVan({ run_id: 'r' }, { evidence_verified: true, code: { commit: 'a'.repeat(40), worktree_clean: true, stable: true } }) !== null);
    /** R8-03: een codepin die je niet AFDWINGT bindt niets. */
    t('1 R8-03 een poort zonder codemeting telt niet als bewijs', digestVan({ run_id: 'r' }, { evidence_verified: true }) === null);
    t('1 R8-03 een onstabiele meting (code bewoog tijdens de poort) evenmin', digestVan({ run_id: 'r' }, { evidence_verified: true, code: { commit: 'a'.repeat(40), worktree_clean: true, stable: false } }) === null);
    t('1 R8-03 en bewijs dat op een VUILE bron draaide ook niet', digestVan({ run_id: 'r' }, { evidence_verified: true, code: { commit: 'a'.repeat(40), worktree_clean: false, stable: true } }) === null);
    t('1 R7-06 zonder run_id is de bewijsset niet aan DEZE run gebonden', digestVan({}, { evidence_verified: true }) === null);
    t('1 R7-06 en evidence_verified moet EXPLICIET true zijn, niet slechts niet-false', digestVan({ run_id: 'r' }, {}) === null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // R6-08: een AANWEZIG maar leeg uitkomstveld is geen goedkeuring
  t('1 R6-08 review_verdict:approved met ok:"" wordt geweigerd',
    iv(keten([werk('a'), start('V', 'r1'), klaar('V', 'r1', { ok: '' })]), { commitSha: COMMIT, evidenceDigest: EVID }).ok === false);
  t('1 R6-08 een leeg status-veld ook',
    iv(keten([werk('a'), start('V', 'r1'), klaar('V', 'r1', { status: '' })]), { commitSha: COMMIT, evidenceDigest: EVID }).ok === false);
  t('1 R6-08 en alleen de BOOLEAN true telt, niet de string',
    iv(keten([werk('a'), start('V', 'r1'), klaar('V', 'r1', { ok: 'true' })]), { commitSha: COMMIT, evidenceDigest: EVID }).ok === false);

  /** N-10: de regeltekst die operators en het dashboard LEZEN mag de handhaving niet tegenspreken. Hij
   *  beschreef nog steeds "runtime codex / verify_result / verified_by / agent diversity" als geldige
   *  routes, terwijl die alle vier zijn verwijderd — dat nodigt uit tot het herintroduceren van precies
   *  de emitters die de poort onveilig maakten. */
  {
    const prod = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'orchestration', 'FORGE_HARD_RULES.json'), 'utf8'));
    const regel = prod.rules.find((r) => r.id === 'independent-verification') || {};
    const verwijderd = [/runtime codex/i, /verify_result/i, /verified_by/i, /agent diversity/i];
    const nogGenoemd = verwijderd.filter((re) => re.test(String(regel.rule || '')));
    t('1 N-10 de regeltekst noemt GEEN verwijderde route meer', nogGenoemd.length === 0, 'nog genoemd: ' + nogGenoemd.map(String).join(', '));
    t('1 N-10 en beschrijft het causale protocol dat echt wordt afgedwongen',
      /review_completed/.test(String(regel.rule || '')) && /review_id/.test(String(regel.rule || '')));
    t('1 N-10 inclusief de eerlijke label-beperking', /LABEL/i.test(String(regel.rule || '')));
  }

  /** RONDE 7 — twee gaten die IK in de vorige ronde zelf introduceerde. */
  // R7-04: vrije tekst mocht een veiligheidsgrens bepalen; "implement review feedback" gold als review.
  {
    const dispatch = (extra) => iv(keten([werk('a'), Object.assign({ event_type: 'agent_started', agent: 'V' }, extra), start('V', 'r1'), klaar('V', 'r1')]), { commitSha: COMMIT, evidenceDigest: EVID });
    t('1 R7-04 "implement review feedback" is UITVOEREND werk, geen reviewopdracht',
      dispatch({ task: 'implement review feedback' }).ok === false);
    t('1 R7-04 het woord review in een narratief veld beslist niets meer',
      dispatch({ note: 'zie de review-opmerkingen van gisteren' }).ok === false);
    t('1 R7-04 alleen een gestructureerd rolveld telt', dispatch({ role: 'review', task: 'review WP2' }).ok === true);
    t('1 R7-04 en een uitvoerende task overruled een reviewrol (doen gaat voor etiket)',
      dispatch({ role: 'review', task: 'implement the patch' }).ok === false);
    /** R8-01: mijn R7-04-fix gebruikte een DENYLIST van uitvoeringswerkwoorden, dus alles wat daar niet
     *  in stond gold als review — `develop production feature` kwam er gewoon door. Dezelfde fout als
     *  R3-01, een laag dieper. Nu positief bewijs: de taak moet ZELF reviewwerk beschrijven. */
    for (const taak of ['develop production feature', 'ship the release', 'wire up the gateway', 'onbekende opdracht']) {
      t('1 R8-01 role:review met task "' + taak + '" is WERK (denylist faalde hier open)',
        dispatch({ role: 'review', task: taak }).ok === false);
    }
    for (const taak of ['review WP2', 'audit the diff', 'verify WP2', 'beoordeel de diff']) {
      t('1 R8-01 maar task "' + taak + '" beschrijft zelf reviewwerk en telt wel',
        dispatch({ role: 'review', task: taak }).ok === true);
    }
  }
  // R7-05: de staleness-check hanteerde een ZWAKKERE definitie van goedkeuring dan de hoofdvalidator
  t('1 R7-05 een latere afkeuring met een LEEG veld telt ook als afkeuring',
    iv(keten([werk('a'), start('V', 'r1'), klaar('V', 'r1'), start('W', 'r2'), klaar('W', 'r2', { status: '' })]), { commitSha: COMMIT, evidenceDigest: EVID }).ok === false);
  t('1 R7-05 en een latere completion met ok:"true" (string) telt eveneens als afkeuring',
    iv(keten([werk('a'), start('V', 'r1'), klaar('V', 'r1'), start('W', 'r2'), klaar('W', 'r2', { ok: 'true' })]), { commitSha: COMMIT, evidenceDigest: EVID }).ok === false);
  t('1 R7-05 beide ingangen delen nu EEN definitie van goedkeuring',
    RC.isGoedkeuring({ review_verdict: 'pass' }).ok === true && RC.isGoedkeuring({ review_verdict: 'pass', ok: 'true' }).ok === false);

  /** R8-02: de staleness-check keek alleen naar het VERDICT van latere completions. Een tweede
   *  POSITIEVE completion die een verbruikt review_id hergebruikt of een verkeerde commit draagt, is
   *  net zo goed een signaal dat er iets niet klopt — die mag de goedkeuring niet ongemoeid laten. */
  t('1 R8-02 een latere POSITIEVE completion op een verbruikt review_id blokkeert het oordeel',
    iv(keten([werk('a'), start('V', 'r1'), klaar('V', 'r1'), klaar('V', 'r1')]), { commitSha: COMMIT, evidenceDigest: EVID }).ok === false);
  t('1 R8-02 en een latere completion met een VERKEERDE commit ook',
    iv(keten([werk('a'), start('V', 'r1'), klaar('V', 'r1'), start('W', 'r2'), klaar('W', 'r2', { commit_sha: 'f'.repeat(40) })]), { commitSha: COMMIT, evidenceDigest: EVID }).ok === false);

  /** R9-07: herstel MOET mogelijk zijn. Mijn R8-02-fix blokkeerde op elke latere ongeldige completion,
   *  ook als daarna een verse, geldige review volgde — precies de weg die de foutmelding voorschrijft. */
  const hersteldNaFout = iv(keten([werk('a'), start('V', 'r1'), klaar('V', 'r1'),
    klaar('V', 'r1'),
    start('W', 'r2'), klaar('W', 'r2')]), { commitSha: COMMIT, evidenceDigest: EVID });
  t('1 R9-07 na een ongeldige completion herstelt een VERSE geldige review het oordeel',
    hersteldNaFout.ok === true, hersteldNaFout.reason);
  t('1 R9-07 maar een ongeldige LAATSTE completion laat het rood',
    iv(keten([werk('a'), start('V', 'r1'), klaar('V', 'r1'), start('W', 'r2'), klaar('W', 'r2', { review_verdict: 'blocked' })]), { commitSha: COMMIT, evidenceDigest: EVID }).ok === false);

  /** R9-01: mijn 'positief bewijs' had nog drie gaten. Onbekend hoort aan de strenge kant te vallen. */
  {
    const d = (extra) => iv(keten([werk('a'), Object.assign({ event_type: 'agent_started', agent: 'V' }, extra), start('V', 'r1'), klaar('V', 'r1')]), { commitSha: COMMIT, evidenceDigest: EVID });
    t('1 R9-01 een reviewrol ZONDER taak bewijst niets (waarvoor ingezet is dan onbekend)',
      d({ role: 'review' }).ok === false);
    t('1 R9-01 een GEMENGDE taak (review and implement) is uitvoering',
      d({ role: 'review', task: 'review and implement production feature' }).ok === false);
    t('1 R9-01 een TEGENSTRIJDIG rolveld laat de reviewclaim vervallen',
      d({ role: 'review', dispatch_role: 'implementation', task: 'review WP2' }).ok === false);
    t('1 R9-01 en een eenduidige reviewopdracht telt gewoon',
      d({ role: 'review', task: 'review WP2' }).ok === true);
  }

  /** R9-08: de suite dekte de nieuwe eisen van ronde 9 nog niet. Elk van deze bindingen kreeg pas
   *  betekenis toen hij ergens werd AFGEDWONGEN — dus hoort er per binding een test te staan die faalt
   *  zodra de handhaving wegvalt. */
  {
    const evid = (extra) => Object.assign({ commitSha: COMMIT, evidenceDigest: EVID }, extra || {});
    const basis = keten([werk('a'), start('V', 'r1'), klaar('V', 'r1')]);
    t('1 R9-02 bewijs van een ANDERE commit dan de beoordeelde wordt geweigerd',
      iv(basis, evid({ evidenceCommit: 'f'.repeat(40) })).ok === false);
    t('1 R9-02 en de reden zegt dat bewijs en oordeel over verschillende code gaan',
      /verschillende code/.test(iv(basis, evid({ evidenceCommit: 'f'.repeat(40) })).reason));
    t('1 R9-02 bewijs van DEZELFDE commit is gewoon in orde',
      iv(basis, evid({ evidenceCommit: COMMIT })).ok === true);
  }
  // R9-05: de canonicalizer vertrouwt `evidence_verified` niet blind meer als het bestand er nog ligt
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iv-readback-'));
    const runDir = path.join(dir, '.claude', 'forge-runs', 'r');
    fs.mkdirSync(path.join(runDir, 'gate-output'), { recursive: true });
    const uitvoer = 'echte poortuitvoer\n';
    const sha = crypto.createHash('sha256').update(uitvoer, 'utf8').digest('hex');
    fs.writeFileSync(path.join(runDir, 'gate-output', 's.txt'), uitvoer);
    const manifest = (outSha) => {
      fs.writeFileSync(path.join(runDir, 'gate-evidence.json'), JSON.stringify({ run_id: 'r', gates: [{
        name: 's', command: 'node test', exit_code: 0, output_sha256: outSha, evidence_verified: true,
        output_file: '.claude/forge-runs/r/gate-output/s.txt',
        code: { commit: 'a'.repeat(40), worktree_clean: true, stable: true },
      }] }));
      return RC.canonicalEvidenceDigest(dir, 'r');
    };
    t('1 R9-05 een manifest dat WEL bij zijn bewaarde uitvoer past, telt', manifest(sha) !== null);
    t('1 R9-05 een manifest dat NIET meer bij zijn bestand past, telt niet — ook al staat evidence_verified op true',
      manifest('b'.repeat(64)) === null);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /** R10-01 — DERDE keer dezelfde vormfout: R3-01 leerde dat een denylist onveilig faalt, R8-01 bouwde
   *  er toch een, R9-01 breidde die uit. `task:"review code and update production source"` kwam erdoor
   *  omdat "update" er niet in stond. Nu een ALLOWLIST op tokenniveau: elk woord moet uit de
   *  reviewwoordenschat komen, dus ook een woord dat ik nooit heb bedacht maakt het uitvoerend werk. */
  {
    const d = (task) => iv(keten([werk('a'), { event_type: 'agent_started', agent: 'V', role: 'review', task }, start('V', 'r1'), klaar('V', 'r1')]), { commitSha: COMMIT, evidenceDigest: EVID });
    for (const taak of ['review code and update production source', 'review and modify production source',
      'review code and implement fix', 'review and ship it', 'review the changes and deploy',
      'review then rewrite the module', 'review plus tweak the config']) {
      t('1 R10-01 gemengde opdracht is WERK: "' + taak + '"', d(taak).ok === false);
    }
    for (const taak of ['review WP2', 'independent review of the diff', 'audit the changes in WP2',
      'beoordeel deze wijzigingen', 'verify commit a1b2c3d']) {
      t('1 R10-01 zuivere reviewopdracht telt: "' + taak + '"', d(taak).ok === true);
    }
  }

  /** R10-03: een zelfgeschreven noop-poort zonder command of outputbestand is geen bewijs. */
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iv-r10-'));
    const digestVan = (gate) => {
      fs.mkdirSync(path.join(dir, '.claude', 'forge-runs', 'r'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.claude', 'forge-runs', 'r', 'gate-evidence.json'),
        JSON.stringify({ run_id: 'r', gates: [Object.assign({ name: 'g', exit_code: 0, output_sha256: 'a'.repeat(64), evidence_verified: true, code: { commit: 'a'.repeat(40), worktree_clean: true, stable: true } }, gate)] }));
      return RC.canonicalEvidenceDigest(dir, 'r');
    };
    t('1 R10-03 een poort ZONDER command is geen uitgevoerde poort', digestVan({ output_file: 'x.txt' }) === null);
    t('1 R10-03 een poort ZONDER output_file heeft geen verifieerbare uitvoer', digestVan({ command: 'node t' }) === null);
    t('1 R10-03 met beide velden telt hij gewoon', digestVan({ command: 'node t', output_file: 'x.txt' }) !== null);
    t('1 R10-03 argv als alternatief voor command telt ook', digestVan({ argv: ['node', 't'], output_file: 'x.txt' }) !== null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  /** R10-02: check() geeft de bewijscommit door en de evaluator vergelijkt hem met de beoordeelde
   *  commit — dit is de E2E-doorgifte die R10-06 miste (de unit-test bewees hem niet via check()). */

  // N-06: een onderbroken keten vlak vóór de completion mag niet worden overgeslagen
  const gat = keten([werk('a'), start('V', 'r1'), klaar('V', 'r1')]).map((e, i) => (i === 1 ? Object.assign({}, e, { entry_hash: undefined }) : e));
  t('1 N-06 een directe voorganger zonder entry_hash breekt de subjectbinding',
    iv(gat, { commitSha: COMMIT, evidenceDigest: EVID }).ok === false);

  // F-08: elke naam in de allowlist moet de strict writer ECHT kennen
  const writerSrc = fs.readFileSync(path.join(__dirname, '..', 'forge-dashboard', 'log-event.cjs'), 'utf8');
  const bekend = new Set([...(writerSrc.match(/const KNOWN_EVENT_TYPES = new Set\(\[([\s\S]*?)\]\)/)[1].matchAll(/'([a-z0-9_]+)'/g))].map((m) => m[1]));
  const onbekend = [...RC.REVIEW_START_TYPES, ...RC.REVIEW_DONE_TYPES, ...RC.NON_WORK_EVENT_TYPES].filter((x) => !bekend.has(x));
  t('1 F-08 elk eventtype dat de poort NOEMT is ECHT geregistreerd bij de writer', onbekend.length === 0, 'onbekend: ' + onbekend.join(', '));
  /** R3-01: parametrisch over ELK geregistreerd type — zo kan een nieuw eventtype niet stilzwijgend in
   *  de verkeerde bak belanden. De omkering maakt onbekend = werk, dus deze test bewaakt vooral dat de
   *  niet-werk-lijst niets bevat wat in werkelijkheid iets produceert. */
  /** R4-06/R5-11: de vorige taxonomietest gebruikte een SUFFIX-regex en miste daardoor precies
   *  `_output`, `_assigned`, `_approach` en `_logged` — de vier die ronde 4 als verkeerd ingedeeld
   *  aanwees. Een test die zijn eigen blinde vlek deelt met de code bewijst niets. Nu ECHT parametrisch:
   *  elk geregistreerd type wordt geclassificeerd en de niet-werk-lijst moet stuk voor stuk verdedigbaar
   *  zijn — geen enkel type mag daar staan zonder dat het in de expliciete, gemotiveerde set voorkomt. */
  const inertVerwacht = new Set([
    'run_started', 'run_completed', 'run_finalized',
    'project_scanned', 'profile_loaded', 'memory_loaded', 'skill_loaded', 'file_read', 'owner_prefs_loaded',
    'claude_md_checked', 'project_skill_dir_checked', 'ecc_inventory',
    'agent_selected', 'agent_note', 'agent_next_action', 'owner_override', 'gate_evaluated',
  ]);
  const nietWerk = [...bekend].filter((x) => !RC.isWorkEventType(x));
  const onverwachtInert = nietWerk.filter((x) => !inertVerwacht.has(x) && !RC.REVIEW_START_TYPES.has(x) && !RC.REVIEW_DONE_TYPES.has(x));
  t('1 R4-06 elk als niet-werk ingedeeld type staat in de EXPLICIETE, gemotiveerde lijst',
    onverwachtInert.length === 0, 'onverwacht inert: ' + onverwachtInert.join(', '));
  for (const gemist of ['agent_output', 'rework_assigned', 'rejected_approach', 'decision_logged']) {
    t('1 R4-06 ' + gemist + ' telt als werk (de suffixregex zag hem niet)', RC.isWorkEventType(gemist) === true);
  }
  // Elk producerend suffix hoort werk te zijn, met precies EEN gemotiveerde uitzondering: `run_completed`
  // is lifecycle (het markeert de afronding, het produceert niets). Die uitzondering staat hier bij naam,
  // zodat een NIEUW producerend type niet stilzwijgend mee kan liften.
  const producerendMaarInert = [...bekend].filter((x) => /_(completed|created|generated|stored|done)$/.test(x)
    && !RC.REVIEW_DONE_TYPES.has(x) && !RC.isWorkEventType(x));
  t('1 R4-06 elk producerend type is werk, op de ene gemotiveerde lifecycle-uitzondering na',
    producerendMaarInert.join() === 'run_completed', 'onverwacht inert: ' + producerendMaarInert.join(', '));
  t('1 R3-01 research_done telt als werk (het gat uit ronde 3)', RC.isWorkEventType('research_done') === true);
  t('1 R3-01 een ONBEKEND nieuw type valt aan de strenge kant (= werk)', RC.isWorkEventType('een_type_dat_morgen_wordt_toegevoegd') === true);
}

// ---- 2) end-to-end door de ECHTE writer + het ECHTE contract
function fixture(naam, evs, fopts) {
  fopts = fopts || {};
  const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'iv-e2e-'));
  for (const d of ['forge-dashboard', 'forge-bin', 'config/orchestration', 'config/agents']) fs.mkdirSync(path.join(ROOT, '.claude', d), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'forge-dashboard', 'log-event.cjs'), path.join(ROOT, '.claude/forge-dashboard/log-event.cjs'));
  fs.copyFileSync(path.join(__dirname, 'forge-runcontract.cjs'), path.join(ROOT, '.claude/forge-bin/forge-runcontract.cjs'));
  try { fs.copyFileSync(path.join(__dirname, '..', 'config', 'agents', 'agent-registry.json'), path.join(ROOT, '.claude/config/agents/agent-registry.json')); } catch { }
  fs.writeFileSync(path.join(ROOT, '.claude/config/orchestration/FORGE_HARD_RULES.json'), JSON.stringify({
    owners_allowlist: ['owner'],
    rules: [{ id: 'independent-verification', rule: 'x', trigger: 'always', check: { type: 'independent-verification' }, severity: 'block', override: 'UN-OVERRIDABLE', cannot_override: true, source: 'test' }],
  }, null, 2));
  /** N-07 (post-fix herreview): de vorige positieve E2E-test slaagde JUIST doordat de HEAD-route stuk
   *  was — een verzonnen sha in een niet-git-map werd nooit vergeleken. Deze root is nu een ECHTE
   *  git-repo met een echte commit, zodat commit_sha tegen een werkelijke HEAD wordt getoetst. */
  const git = (...a) => spawnSync('git', ['-C', ROOT, ...a], { encoding: 'utf8' });
  if (fopts.git !== false) git('init', '-q');
  if (fopts.git !== false) { git('config', 'user.email', 'test@forge.local'); git('config', 'user.name', 'Forge Test'); }
  fs.writeFileSync(path.join(ROOT, 'iets.txt'), 'inhoud\n');
  if (fopts.git !== false) { git('add', '-A'); git('commit', '-q', '-m', 'fixture'); }
  const HEAD = fopts.git === false ? 'e'.repeat(40) : String(git('rev-parse', 'HEAD').stdout || '').trim();
  const LOG = path.join(ROOT, '.claude/forge-dashboard/log-event.cjs');
  const EVENTS = path.join(ROOT, '.claude', 'forge-runs', naam, 'events.jsonl');
  /** laatste entry_hash = de runstaat waarop een reviewer zich baseert. De reviewer LEEST die vóór hij
   *  zijn completion schrijft; landt er intussen nog een event, dan wijkt prev_hash af en valt de review
   *  terecht af. Dat is de subjectbinding, niet een formaliteit. */
  const staat = () => {
    const regels = fs.readFileSync(EVENTS, 'utf8').split(/\r?\n/).filter((l) => l.trim());
    return JSON.parse(regels[regels.length - 1]).entry_hash;
  };
  /** N-03: de review moet aan een ECHTE bewijsset binden. Deze fixture schrijft er daarom een, en de
   *  reviewer gebruikt de canoniek herberekende digest — niet een verzonnen 64-hex waarde. */
  fs.mkdirSync(path.join(ROOT, '.claude', 'forge-runs', naam), { recursive: true });
  fs.writeFileSync(path.join(ROOT, '.claude', 'forge-runs', naam, 'gate-evidence.json'), JSON.stringify({
    schema: 1, run_id: naam, all_green: true,
    gates: [{ name: 'suite', command: 'node test', output_file: 'gate-output/suite.txt', exit_code: 0, output_sha256: 'c'.repeat(64), evidence_verified: true, code: { commit: HEAD, worktree_clean: true, stable: true } }],
  }, null, 2));
  const EVIDENCE = RC.canonicalEvidenceDigest(ROOT, naam).digest;
  const codes = [];
  for (const e of evs) {
    const payload = typeof e === 'function' ? e(staat, HEAD, EVIDENCE) : e;
    const r = spawnSync(process.execPath, [LOG, naam, payload.event_type, JSON.stringify(payload)], { encoding: 'utf8' });
    // F-06: een helper die exitcodes negeert kan een run "verifiëren" waarin de writer alles weigerde
    codes.push({ type: payload.event_type, status: r.status, err: String(r.stderr || '').trim().slice(0, 160) });
  }
  const rc = spawnSync(process.execPath, [path.join(ROOT, '.claude/forge-bin/forge-runcontract.cjs'), 'check', '--run', naam, '--root', ROOT], { encoding: 'utf8' });
  fs.rmSync(ROOT, { recursive: true, force: true });
  return { status: rc.status, out: String(rc.stdout || ''), err: String(rc.stderr || ''), codes };
}
{
  const werkbewijs = { event_type: 'wp_completed', agent: 'Build Boss', command: 'npm run build', output: 'build ok' };
  const COMMIT = 'a'.repeat(40); const EVID = 'b'.repeat(64);

  const zelf = fixture('e2e-zelf', [{ event_type: 'run_started', agent: 'Build Boss', note: 's' }, werkbewijs,
    { event_type: 'check_passed', agent: 'Build Boss', command: 'npm test', output: '12 passed, 0 failed' }]);
  t('2 E2E: een run waarin de uitvoerder zichzelf goedkeurt is NIET DONE', zelf.status === 3 && /independent-verification/.test(zelf.out), 'exit=' + zelf.status + ' ' + zelf.out.slice(0, 120) + zelf.err.slice(0, 120));
  t('2 E2E: elk seed-event van die run is ECHT geaccepteerd (geen stil genegeerde weigering)',
    zelf.codes.every((c) => c.status === 0), JSON.stringify(zelf.codes.filter((c) => c.status !== 0)));

  // de oude "tweede waarnemer logt gewoon een check_passed"-route BESTAAT NIET MEER (F-01/F-05)
  const losseClaim = fixture('e2e-losse-claim', [{ event_type: 'run_started', agent: 'Build Boss', note: 's' }, werkbewijs,
    { event_type: 'check_passed', agent: 'Review Boss', command: 'npm test', output: '12 passed, 0 failed' }]);
  t('2 E2E: een kale pass-claim van een tweede label is GEEN verificatie meer', losseClaim.status === 3 && /independent-verification/.test(losseClaim.out), 'exit=' + losseClaim.status);

  // het ECHTE protocol, volledig door de echte writer heen
  const echt = fixture('e2e-review', [
    { event_type: 'run_started', agent: 'Build Boss', note: 's' },
    werkbewijs,
    { event_type: 'review_started', agent: 'Review Boss', review_id: 'rev-1', note: 'onafhankelijke review geopend' },
    (staat, HEAD, EVIDENCE) => ({ event_type: 'review_completed', agent: 'Review Boss', review_id: 'rev-1', subject_log_hash: staat(), commit_sha: HEAD, evidence_digest: EVIDENCE, review_verdict: 'pass', note: 'beoordeeld en akkoord' }),
  ]);
  t('2 E2E: het volledige causale protocol door de ECHTE writer geeft CONTRACT OK', echt.status === 0 && /CONTRACT OK/.test(echt.out), 'exit=' + echt.status + ' ' + echt.out.slice(0, 200) + echt.err.slice(0, 200));
  t('2 E2E: en de writer accepteerde elk van die events', echt.codes.every((c) => c.status === 0), JSON.stringify(echt.codes.filter((c) => c.status !== 0)));

  // ... en werk NA de review haalt hem weer onderuit (F-04), end-to-end
  const naWerk = fixture('e2e-review-stale', [
    { event_type: 'run_started', agent: 'Build Boss', note: 's' },
    werkbewijs,
    { event_type: 'review_started', agent: 'Review Boss', review_id: 'rev-1', note: 'review geopend' },
    (staat, HEAD, EVIDENCE) => ({ event_type: 'review_completed', agent: 'Review Boss', review_id: 'rev-1', subject_log_hash: staat(), commit_sha: HEAD, evidence_digest: EVIDENCE, review_verdict: 'pass', note: 'akkoord' }),
    { event_type: 'file_changed', agent: 'Build Boss', path: 'src/iets.js', note: 'toch nog even iets aangepast' },
  ]);
  t('2 E2E: werk NA de review maakt de run weer NIET DONE', naWerk.status === 3 && /independent-verification/.test(naWerk.out), 'exit=' + naWerk.status + ' ' + naWerk.out.slice(0, 160));

  /** N-02: bewijs dat de HEAD-vergelijking ECHT draait. Zonder deze twee zou een stille null-HEAD (de
   *  bug die de vorige ronde onopgemerkt bleef) er weer als groen uitzien. */
  const andereCommit = fixture('e2e-review-andere-commit', [
    { event_type: 'run_started', agent: 'Build Boss', note: 's' },
    werkbewijs,
    { event_type: 'review_started', agent: 'Review Boss', review_id: 'rev-1', note: 'review geopend' },
    (staat, HEAD, EVIDENCE) => ({ event_type: 'review_completed', agent: 'Review Boss', review_id: 'rev-1', subject_log_hash: staat(), commit_sha: 'f'.repeat(40), evidence_digest: EVIDENCE, review_verdict: 'pass', note: 'akkoord' }),
  ]);
  t('2 E2E: een review van een ANDERE commit dan de echte HEAD wordt geweigerd', andereCommit.status === 3, 'exit=' + andereCommit.status + ' ' + andereCommit.out.slice(0, 160));

  const zonderGit = fixture('e2e-review-zonder-git', [
    { event_type: 'run_started', agent: 'Build Boss', note: 's' },
    werkbewijs,
    { event_type: 'review_started', agent: 'Review Boss', review_id: 'rev-1', note: 'review geopend' },
    (staat, HEAD, EVIDENCE) => ({ event_type: 'review_completed', agent: 'Review Boss', review_id: 'rev-1', subject_log_hash: staat(), commit_sha: HEAD, evidence_digest: EVIDENCE, review_verdict: 'pass', note: 'akkoord' }),
  ], { git: false });
  t('2 E2E: zonder git kan de commitbinding niet worden getoetst => fail-closed, NIET groen', zonderGit.status === 3, 'exit=' + zonderGit.status + ' ' + zonderGit.out.slice(0, 200));

  /** N-01 (writer-kant): een reviewer die niet in de registry staat moet door de ECHTE writer worden
   *  geweigerd. Deze test ving mijn eigen fout: alle fixtures hierboven gebruikten "Verify Boss", een
   *  naam die helemaal niet bestaat — en niets controleerde dat, omdat review-events buiten de
   *  agent-validatie vielen. Een spookreviewer is precies het scenario dat deze poort moet uitsluiten. */
  const spook = fixture('e2e-spookreviewer', [
    { event_type: 'run_started', agent: 'Build Boss', note: 's' },
    werkbewijs,
    { event_type: 'review_started', agent: 'Niemand Die Bestaat', review_id: 'rev-1', note: 'review geopend' },
    (staat, HEAD, EVIDENCE) => ({ event_type: 'review_completed', agent: 'Niemand Die Bestaat', review_id: 'rev-1', subject_log_hash: staat(), commit_sha: HEAD, evidence_digest: EVIDENCE, review_verdict: 'pass', note: 'akkoord' }),
  ]);
  t('2 E2E: de writer WEIGERT een niet-geregistreerde reviewer',
    spook.codes.filter((c) => /review_/.test(c.type)).every((c) => c.status !== 0), JSON.stringify(spook.codes.filter((c) => /review_/.test(c.type))));
  t('2 E2E: en die run haalt het contract dus niet', spook.status === 3, 'exit=' + spook.status);

  const naamloos = fixture('e2e-naamloze-reviewer', [
    { event_type: 'run_started', agent: 'Build Boss', note: 's' },
    werkbewijs,
    { event_type: 'review_started', review_id: 'rev-1', note: 'review zonder agent' },
  ]);
  t('2 E2E: een review-event ZONDER agent wordt door de writer geweigerd',
    naamloos.codes.some((c) => c.type === 'review_started' && c.status !== 0), JSON.stringify(naamloos.codes));

  /** R4-05: strict mode uitzetten mag een build soepeler maken, maar niet betekenen dat "wie dit
   *  goedkeurde" een vrij invulbaar veld wordt. Deze test draait de ECHTE writer met
   *  FORGE_STRICT_EVENTS=0 en verwacht dat de spookreviewer nog steeds wordt geweigerd. */
  {
    const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'iv-optout-'));
    for (const d of ['forge-dashboard', 'config/agents']) fs.mkdirSync(path.join(ROOT, '.claude', d), { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', 'forge-dashboard', 'log-event.cjs'), path.join(ROOT, '.claude/forge-dashboard/log-event.cjs'));
    fs.copyFileSync(path.join(__dirname, '..', 'config', 'agents', 'agent-registry.json'), path.join(ROOT, '.claude/config/agents/agent-registry.json'));
    const LOG = path.join(ROOT, '.claude/forge-dashboard/log-event.cjs');
    const zonderStrict = (type, payload) => spawnSync(process.execPath, [LOG, 'optout', type, JSON.stringify(payload)],
      { encoding: 'utf8', env: Object.assign({}, process.env, { FORGE_STRICT_EVENTS: '0' }) });
    const spookOptOut = zonderStrict('review_started', { agent: 'Niemand Die Bestaat', review_id: 'r1', note: 'x' });
    t('2 R4-05 met FORGE_STRICT_EVENTS=0 wordt een spookreviewer NOG STEEDS geweigerd',
      spookOptOut.status !== 0 && /NIET opt-out/.test(String(spookOptOut.stderr || '')), 'exit=' + spookOptOut.status + ' ' + String(spookOptOut.stderr || '').slice(0, 160));
    const echtOptOut = zonderStrict('review_started', { agent: 'Review Boss', review_id: 'r1', note: 'x' });
    t('2 R4-05 maar een ECHTE reviewer komt er ook zonder strict mode gewoon door', echtOptOut.status === 0, String(echtOptOut.stderr || '').slice(0, 160));
    /** R5-11: de strict-off test dekte alleen `review_started`. Een poort die maar op één van zijn zes
     *  types wordt getoetst, is niet aantoonbaar gesloten. */
    const klaarOptOut = zonderStrict('review_completed', { agent: 'Niemand Die Bestaat', review_id: 'r1', note: 'x' });
    t('2 R5-11 ook review_completed weigert een spookreviewer zonder strict mode', klaarOptOut.status !== 0, 'exit=' + klaarOptOut.status);
    const codexOptOut = zonderStrict('codex_review_started', { agent: 'Niemand Die Bestaat', review_id: 'r1', note: 'x' });
    t('2 R5-11 en codex_review_started evenmin', codexOptOut.status !== 0, 'exit=' + codexOptOut.status);

    /** R6-07: de writer dwong identiteit alleen af op agent-/subagent-events, dus phantom of naamloos
     *  WERK belandde gewoon in de audittrail (de poort ving het later fail-closed op, maar mijn claim
     *  dat de writer work-identiteit afdwingt was te sterk). De drie zwaarstwegende worktypes worden nu
     *  wel naamgecontroleerd. */
    const strictRun = (type, payload) => spawnSync(process.execPath, [LOG, 'r607', type, JSON.stringify(payload)], { encoding: 'utf8' });
    for (const type of ['file_changed', 'report_generated', 'wp_completed']) {
      const spook = strictRun(type, { agent: 'Phantom Worker', path: 'a.js', command: 'x', output: 'y' });
      t('2 R6-07 ' + type + ' met een niet-geregistreerde actor wordt geweigerd', spook.status !== 0, 'exit=' + spook.status);
    }
    const echtWerk = strictRun('file_changed', { agent: 'Build Boss', path: 'a.js' });
    t('2 R6-07 en met een echte Boss komt hetzelfde event gewoon door', echtWerk.status === 0, String(echtWerk.stderr || '').slice(0, 160));
    fs.rmSync(ROOT, { recursive: true, force: true });
  }
}

// ---- 3) configcontract: keyloze checktypes
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iv-cfg-'));
  const rules = (extra) => {
    const p = path.join(dir, 'r' + Math.random().toString(36).slice(2) + '.json');
    fs.writeFileSync(p, JSON.stringify({ owners_allowlist: ['owner'], rules: [Object.assign({ id: 'iv', rule: 'x', trigger: 'always', severity: 'block', override: 'UN', source: 't' }, extra)] }));
    return p;
  };
  let ok1 = true; try { RC.loadRules(rules({ check: { type: 'independent-verification' } })); } catch { ok1 = false; }
  t('3 een keyloze check ZONDER key laadt', ok1);
  let threw = null; try { RC.loadRules(rules({ check: { type: 'independent-verification', key: ['iets'] } })); } catch (e) { threw = e; }
  t('3 een keyloze check MET key wordt geweigerd', threw !== null && /keyless/.test(threw.message), threw && threw.message);
  let threw2 = null; try { RC.loadRules(rules({ check: { type: 'event-present' } })); } catch (e) { threw2 = e; }
  t('3 een key-gedreven check ZONDER key blijft een harde configfout', threw2 !== null && /check\.key/.test(threw2.message));
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- 4) F-07 (Codex-review 2026-08-09, high): de regel BELOOFDE UN-OVERRIDABLE maar miste
//      `cannot_override:true`, en forge-runcontract laat elke regel ZONDER die boolean via owner_override
//      verdwijnen. De regel die zelf-goedkeuring verbiedt was dus zelf wegdrukbaar. De belofte staat in
//      vrije tekst, de handhaving in een boolean — niets verbond die twee, dus voegt dit blok naast de
//      fix ook de bewaker toe die de belofte AFDWINGT.
{
  const prod = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'orchestration', 'FORGE_HARD_RULES.json'), 'utf8'));
  const belooft = prod.rules.filter((r) => /UN-?OVERRIDABLE/i.test(String(r.override || '')));
  const gebroken = belooft.filter((r) => r.cannot_override !== true).map((r) => r.id);
  t('4 elke regel die UN-OVERRIDABLE BELOOFT draagt ook cannot_override:true', gebroken.length === 0, 'gebroken: ' + gebroken.join(', '));
  t('4 en independent-verification is er daadwerkelijk een van',
    (prod.rules.find((r) => r.id === 'independent-verification') || {}).cannot_override === true);

  // de bewaker zelf: tekst die UN-OVERRIDABLE belooft zonder de boolean is een HARDE configfout
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iv-override-'));
  const schrijf = (extra) => {
    const p = path.join(dir, 'r' + Math.random().toString(36).slice(2) + '.json');
    fs.writeFileSync(p, JSON.stringify({ owners_allowlist: ['owner'], rules: [Object.assign({ id: 'x', rule: 'x', trigger: 'always', check: { type: 'event-present', key: ['a'] }, severity: 'block', source: 't' }, extra)] }));
    return p;
  };
  let e1 = null; try { RC.loadRules(schrijf({ override: 'UN-OVERRIDABLE — dit mag nooit weg' })); } catch (e) { e1 = e; }
  t('4 een UN-OVERRIDABLE-belofte ZONDER de boolean is een harde configfout', e1 !== null && /cannot_override/.test(e1.message), e1 && e1.message);
  let e2 = null; try { RC.loadRules(schrijf({ override: 'UN-OVERRIDABLE — dit mag nooit weg', cannot_override: true })); } catch (e) { e2 = e; }
  t('4 met de boolean laadt dezelfde regel gewoon', e2 === null, e2 && e2.message);
  let e3 = null; try { RC.loadRules(schrijf({ override: 'owner mag dit overrulen met reden' })); } catch (e) { e3 = e; }
  t('4 een regel die GEEN belofte doet blijft ongemoeid', e3 === null, e3 && e3.message);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- 5) end-to-end op de ECHTE productieconfig: een GELDIGE owner_override mag deze regel niet wissen
{
  const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'iv-prod-'));
  for (const d of ['forge-dashboard', 'forge-bin', 'config/orchestration', 'config/agents']) fs.mkdirSync(path.join(ROOT, '.claude', d), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'forge-dashboard', 'log-event.cjs'), path.join(ROOT, '.claude/forge-dashboard/log-event.cjs'));
  fs.copyFileSync(path.join(__dirname, 'forge-runcontract.cjs'), path.join(ROOT, '.claude/forge-bin/forge-runcontract.cjs'));
  try { fs.copyFileSync(path.join(__dirname, '..', 'config', 'agents', 'agent-registry.json'), path.join(ROOT, '.claude/config/agents/agent-registry.json')); } catch { }
  // GEEN synthetische trigger:'always'-fixture meer (F-10): dit is de ECHTE regelset.
  const prodPath = path.join(__dirname, '..', 'config', 'orchestration', 'FORGE_HARD_RULES.json');
  const prod = JSON.parse(fs.readFileSync(prodPath, 'utf8'));
  const owner = (prod.owners_allowlist && prod.owners_allowlist[0]) || 'owner';
  fs.copyFileSync(prodPath, path.join(ROOT, '.claude/config/orchestration/FORGE_HARD_RULES.json'));
  const LOG = path.join(ROOT, '.claude/forge-dashboard/log-event.cjs');
  const schrijf = (run, type, payload) => {
    const r = spawnSync(process.execPath, [LOG, run, type, JSON.stringify(payload)], { encoding: 'utf8' });
    return r.status; // F-06: geen enkele helper mag een weigering stil negeren
  };
  const RUN = 'prod-override';
  // F-10: de regel triggert op complexity:>=L2, dus een L1-fixture BEWIJST NIETS — hij zou groen zijn omdat
  // de regel niet eens meedoet. run.json verklaart hier expliciet L2 (DECLARED_LEVEL_FIELDS.complexity).
  fs.mkdirSync(path.join(ROOT, '.claude', 'forge-runs', RUN), { recursive: true });
  fs.writeFileSync(path.join(ROOT, '.claude', 'forge-runs', RUN, 'run.json'), JSON.stringify({ run_id: RUN, complexity: 'L2', status: 'running' }, null, 2));
  const codes = [
    schrijf(RUN, 'run_started', { agent: 'Build Boss', note: 's' }),
    schrijf(RUN, 'wp_completed', { agent: 'Build Boss', command: 'npm run build', output: 'build ok' }),
    schrijf(RUN, 'check_passed', { agent: 'Build Boss', command: 'npm test', output: '12 passed, 0 failed' }),
    schrijf(RUN, 'owner_override', { agent: 'orchestrator', rule: 'independent-verification', by: owner, reason: 'ik neem dit bewust voor mijn rekening voor deze run' }),
  ];
  t('5 elk seed-event is door de ECHTE strict writer geaccepteerd (geen stil genegeerde weigering)',
    codes.every((c) => c === 0), 'exitcodes: ' + codes.join(','));
  const rc = spawnSync(process.execPath, [path.join(ROOT, '.claude/forge-bin/forge-runcontract.cjs'), 'check', '--run', RUN, '--root', ROOT, '--json'], { encoding: 'utf8' });
  let res = null; try { res = JSON.parse(rc.stdout); } catch { }
  t('5 een GELDIGE owner_override wist independent-verification NIET',
    !!res && res.missing.includes('independent-verification'), JSON.stringify(res && { missing: res.missing, overridden: res.overridden }));
  t('5 en de regel verschijnt ook niet in overridden',
    !!res && !(res.overridden || []).some((o) => o.id === 'independent-verification'), JSON.stringify(res && res.overridden));
  fs.rmSync(ROOT, { recursive: true, force: true });
}

// ---- 6) F-09: één betekenis van "geverifieerd" in het hele systeem.
//      coldverify beoordeelt BEWIJSKRACHT (proven/unproven/unassessable) met de bouwer-narratief eruit
//      gefilterd; dat is iets anders dan ONAFHANKELIJKHEID (wie beoordeelde het). Zolang die twee
//      vocabulaires elkaar niet raken, kan een lezer ze niet verwarren — maar dat was tot nu toe een
//      toevalligheid van het ontwerp. Deze tests maken de scheiding afdwingbaar.
{
  const cvSrc = fs.readFileSync(path.join(__dirname, 'forge-coldverify.cjs'), 'utf8');
  t('6 coldverify claimt nergens independent-verification', !/independent[-_ ]verification/i.test(cvSrc));
  const CV = require(path.join(__dirname, 'forge-coldverify.cjs'));
  const verdicts = CV.VERDICTS || ['proven', 'unproven', 'unassessable'];
  t('6 en zijn verdict-vocabulaire overlapt niet met dat van de onafhankelijkheidspoort',
    !verdicts.some((v) => /verified|independent/i.test(String(v))), JSON.stringify(verdicts));
  // finalize consumeert de ENE evaluator via runcontract — geen tweede implementatie ernaast
  const finSrc = fs.readFileSync(path.join(__dirname, 'forge-finalize.cjs'), 'utf8');
  t('6 finalize implementeert GEEN eigen onafhankelijkheidsoordeel maar leunt op het contract',
    !/independentVerification\s*\(/.test(finSrc) && /runcontract/i.test(finSrc));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
