#!/usr/bin/env node
'use strict';
/**
 * forge-gate-evidence.cjs — RUW BEWIJS PER POORT (Codex rapport-review R-01/R-05, 2026-08-07).
 *
 * PROBLEEM dat dit oplost: rapporten schreven "doctor ALL GREEN · suite 65/0" als TEKST in een event.
 * De hashketen bewijst dan dat de bewering niet naderhand is gewijzigd — niet dat de test ooit zo
 * draaide. Een onafhankelijke reviewer kon de groene uitslagen dus niet verifiëren.
 *
 * WAT DIT DOET: draait elke opgegeven poort ECHT, en legt per poort vast:
 *   command (exacte argv) · cwd · started_at/ended_at (ISO) · duration_ms · exit_code ·
 *   output_bytes · output_sha256 · output_file (ruwe stdout+stderr op schijf) · tail (laatste regels)
 * Resultaat: <run>/gate-evidence.json — een MANIFEST dat in git getrackt kan worden, terwijl de ruwe
 * outputs lokaal blijven (hun sha256 in het manifest maakt ze verifieerbaar). Exit 1 zodra één poort
 * een non-zero exit gaf: het manifest is nooit "groen" over een rode poort.
 *
 * CLI:
 *   node forge-gate-evidence.cjs --run <run_id> [--root <projectRoot>] [--gates <gates.json>] [--json]
 *   node forge-gate-evidence.cjs --run <id> --gate "naam::cmd arg arg" [--gate ...]
 * gates.json: [{ "name": "...", "cmd": "node", "args": ["..."], "cwd": "optioneel-relatief" }, ...]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const PROJECT_ROOT_DEFAULT = path.resolve(__dirname, '..', '..');

function parseArgs(argv) {
  const o = { run: null, root: null, gates: null, json: false, inline: [], merge: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run') o.run = argv[++i];
    else if (a === '--root') o.root = argv[++i];
    else if (a === '--gates') o.gates = argv[++i];
    else if (a === '--json') o.json = true;
    else if (a === '--merge') o.merge = true;
    else if (a === '--gate') o.inline.push(argv[++i]);
  }
  return o;
}

/** runGate — voert EEN poort uit en levert het bewijsrecord.
 *  SHELL-DISCIPLINE (zelfde regel als forge-integrate.cjs): shell:false zodat de argv exact blijft —
 *  BEHALVE voor npm op win32, waar Node 20+ een .cmd zonder shell met EINVAL weigert
 *  (CVE-2024-27980-mitigatie). Dat is veilig omdat elk npm-argument hier een VASTE string is; een
 *  poort met vrije/variabele argumenten mag deze uitzondering nooit gebruiken. De eerste run van dit
 *  bestand liep precies op die val (2 poorten exit -1 in 2ms) — en het manifest weigerde terecht
 *  groen te zijn, wat exact de bedoeling van deze recorder is. */
/** SECRET-REDACTIE (Codex r6b #7): dit manifest wordt GETRACKT in git. Een test die een token in zijn
 *  laatste foutregel of in een argument print, zou dat geheim anders permanent committen. De tail en de
 *  argv/command gaan daarom door een redactor; een argv die er ondanks redactie nog secret-achtig
 *  uitziet laat de poort hard falen i.p.v. hem stilzwijgend vast te leggen. De sha256/bytes worden over
 *  de ONgeredigeerde uitvoer berekend (anders zou het hash-bewijs niet meer bij het bestand horen). */
const SECRET_PATTERNS = [
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/gi,
  /\beyJ[A-Za-z0-9._-]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b[A-Za-z0-9_-]*(?:token|secret|password|passwd|api[_-]?key)[A-Za-z0-9_-]*\s*[=:]\s*\S{6,}/gi,
];
function redact(text) {
  let out = String(text == null ? '' : text);
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[REDACTED]');
  return out;
}
function looksSecret(text) {
  const t = String(text == null ? '' : text);
  return SECRET_PATTERNS.some((re) => { re.lastIndex = 0; return re.test(t); });
}

function runGate(gate, root) {
  const cwd = gate.cwd ? path.resolve(root, gate.cwd) : root;
  const needsShell = process.platform === 'win32' && (gate.cmd === 'npm' || gate.cmd === 'npx');
  if (needsShell && (gate.args || []).some((a) => /[^A-Za-z0-9_.:@/\-]/.test(String(a)))) {
    throw new Error('poort "' + gate.name + '": npm-shell-uitzondering staat alleen VASTE, simpele argumenten toe — kreeg: ' + JSON.stringify(gate.args));
  }
  for (const a of [gate.cmd, ...(gate.args || [])]) {
    if (looksSecret(a)) throw new Error('poort "' + gate.name + '": een argument ziet er secret-achtig uit — een GETRACKT manifest mag dat nooit dragen (r6b #7); geef geheimen via env of een bestand door');
  }
  const started = new Date();
  const t0 = process.hrtime.bigint();
  const r = spawnSync(gate.cmd, gate.args || [], { cwd, shell: needsShell, encoding: 'utf8', timeout: gate.timeout_ms || 1800000, maxBuffer: 64 * 1024 * 1024 });
  const durationMs = Number((process.hrtime.bigint() - t0) / 1000000n);
  const ended = new Date();
  const output = String(r.stdout || '') + String(r.stderr || '');
  const lines = output.split(/\r?\n/).filter((s) => s.trim());
  return {
    name: gate.name,
    command: redact([gate.cmd, ...(gate.args || [])].join(' ')),
    argv: [gate.cmd, ...(gate.args || [])].map(redact),
    cwd: path.relative(root, cwd) || '.',
    started_at: started.toISOString(),
    ended_at: ended.toISOString(),
    duration_ms: durationMs,
    exit_code: r.status === null ? -1 : r.status,
    timed_out: !!(r.error && /ETIMEDOUT|timed?\s*out/i.test(String(r.error.message || r.error))),
    spawn_error: r.error ? String(r.error.message || r.error).slice(0, 200) : null,
    output_bytes: Buffer.byteLength(output, 'utf8'),
    output_sha256: crypto.createHash('sha256').update(output, 'utf8').digest('hex'),
    tail: lines.slice(-3).map((l) => redact(l).slice(0, 300)),
    _output: output,
  };
}

/** tokenize — splitst een inline --gate-commando in argv MET respect voor dubbele quotes. Een naïeve
 *  split op spaties brak elk pad met een spatie ("C:\Program Files\nodejs\node.exe", en deze
 *  projectmap heet zelf "my project (v2)!") — de eigen testsuite ving dat direct. Voor complexe
 *  commando's blijft de --gates JSON-vorm de bedoelde route. */
function tokenize(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; continue; }
    if (!inQ && /\s/.test(c)) { if (cur) { out.push(cur); cur = ''; } continue; }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

/** gitState(root) -> {available:true, commit, parent, worktree_clean, dirty_files, ...} of
 *  {available:false, confirmed_no_repo, reason}.
 *
 *  Bewust GEEN throw: bewijs verzamelen mag niet stuklopen omdat git ontbreekt. Maar het verschil tussen
 *  "schone boom op commit X" en "onbekend" moet in het manifest staan, niet worden weggelaten — dat
 *  weglaten was precies de klacht (R3-08/R4-08/R5-10).
 *
 *  WP-S13 (2.1, 2026-09-26 laptop re-audit, review C VERDICT FAIL) — this used to run its OWN
 *  `git rev-parse HEAD` and treat ANY non-zero exit (dubious ownership, no commits yet, a poisoned
 *  GIT_DIR, git missing) as `available:false`, which record() below then read as a POSITIVELY confirmed
 *  no-git project — silently relaxing the commit binding on a root that merely refused to answer, not
 *  one that genuinely has no git. Rebuilt on forge-runcontract.cjs's shared, three-way `gitProbe()` so
 *  this can never independently disagree with check()'s own `noGitAtRoot` about the same root.
 *  `confirmed_no_repo:true` is set ONLY on gitProbe's positively-confirmed 'no-repo' state; every other
 *  failure (gitProbe's 'undetermined') reports `confirmed_no_repo:false` — record() below requires the
 *  former on BOTH readings before it will ever tag a gate `no_git:true`. */
function gitState(root) {
  let RC;
  try { RC = require('./forge-runcontract.cjs'); }
  catch (e) { return { available: false, confirmed_no_repo: false, reason: 'forge-runcontract.cjs (de gedeelde git-probe) niet laadbaar: ' + (e && e.message ? e.message : String(e)) }; }
  if (typeof RC.gitProbe !== 'function') return { available: false, confirmed_no_repo: false, reason: 'gitProbe niet beschikbaar in forge-runcontract.cjs' };
  let probe;
  try { probe = RC.gitProbe(root); }
  catch (e) { return { available: false, confirmed_no_repo: false, reason: 'git-probe faalde: ' + (e && e.message ? e.message : String(e)) }; }
  if (probe.state === 'undetermined') return { available: false, confirmed_no_repo: false, reason: probe.reason };
  if (probe.state === 'no-repo') {
    return {
      available: false, confirmed_no_repo: true,
      reason: 'bevestigd: geen git-repository onder ' + root + ' (git meldt zelf "not a git repository" EN er is geen .git-item in de boomstructuur) — bewijs wordt gebonden aan de eigen output_sha256 van elke poort, nooit aan een broncode-digest',
    };
  }
  const cleanEnv = typeof RC.cleanGitEnv === 'function' ? RC.cleanGitEnv() : process.env;
  const git = (...a) => spawnSync('git', ['-C', root, ...a], { encoding: 'utf8', timeout: 15000, env: cleanEnv });
  const commit = probe.commit;
  const parentR = git('rev-parse', 'HEAD^');
  const statusR = git('status', '--porcelain');
  const vuil = statusR && statusR.status === 0
    ? String(statusR.stdout || '').split(/\r?\n/).filter((l) => l.trim())
    : null;
  const paden = vuil ? vuil.map((l) => l.slice(3).replace(/\\/g, '/')) : null;
  /** "Vuil" hoort te betekenen dat de BRONCODE afwijkt, niet dat onze eigen output afwijkt. Het manifest
   *  dat we op dit moment schrijven en de door een hook geregenereerde snapshot zijn zelfreferentiële
   *  ruis: zolang die meetellen kan `worktree_clean` per definitie nooit true worden, en dan zegt het
   *  veld niets meer. Ze blijven zichtbaar in dirty_files — alleen het OORDEEL kijkt naar de bron. */
  const eigenRuis = (p) => /\.claude\/forge-runs\/[^/]+\/gate-evidence\.json$/.test(p) || /\.claude\/FORGE_SNAPSHOT\.md$/.test(p);
  const bron = paden ? paden.filter((p) => !eigenRuis(p)) : null;
  /** R9-03: HEAD + een boolean is een grove maat. De vingerafdruk hasht de volledige status-uitvoer van
   *  de vuile BRONbestanden, zodat een wijziging die de clean-vlag niet omzet toch zichtbaar is. */
  /** R10-05 (tiende herreview) — ALWEER EEN CLAIM DIE NIET KLOPTE. Ik beschreef dit als "hash van alle
   *  vuile bronbestanden", maar hij hashte alleen hun PADNAMEN. Wijzigt de inhoud van een bestand dat al
   *  vuil was, dan blijft de padlijst identiek en de vingerafdruk dus gelijk — precies het geval dat deze
   *  maat moest vangen. Nu gaat de INHOUD erin: per vuil bronbestand een sha256 van de bytes (bounded,
   *  onleesbaar = expliciet gemarkeerd i.p.v. overgeslagen). */
  const inhoudsdelen = (bron || []).map((rel) => {
    try {
      const buf = fs.readFileSync(path.join(root, rel));
      return rel + ':' + crypto.createHash('sha256').update(buf).digest('hex');
    } catch (e) {
      return rel + ':ONLEESBAAR(' + (e && e.code ? e.code : 'fout') + ')';
    }
  });
  const vingerafdruk = crypto.createHash('sha256').update([commit, ...inhoudsdelen].join('\n')).digest('hex');
  return {
    available: true,
    confirmed_no_repo: false,
    commit,
    source_fingerprint: vingerafdruk,
    parent: parentR && parentR.status === 0 ? String(parentR.stdout || '').trim() : null,
    worktree_clean: bron ? bron.length === 0 : null,
    dirty_source_files: bron ? bron.slice(0, 50) : null,
    dirty_files: paden ? paden.slice(0, 50) : null,
    note: 'De poorten draaiden op DEZE staat. worktree_clean kijkt naar dirty_source_files: dat zijn de vuile bestanden MINUS onze eigen output (het bewijsmanifest en de gegenereerde snapshot). Is hij false, dan beschrijft commit alleen de basis en niet de exacte geteste bytes — commit eerst en draai de poorten daarna opnieuw.',
  };
}

function record(runId, gates, opts) {
  opts = opts || {};
  const root = opts.root ? path.resolve(opts.root) : PROJECT_ROOT_DEFAULT;
  const runDir = path.join(root, '.claude', 'forge-runs', runId);
  const rawDir = path.join(runDir, 'gate-output');
  fs.mkdirSync(rawDir, { recursive: true });
  // --merge: eerder vastgelegde poorten behouden zodat een enkele herdraai niet de hele reeks
  // (bv. een 3,5-minuten-doctor) hoeft te herhalen; poorten met dezelfde naam worden VERVANGEN.
  let prior = [];
  if (opts.merge) {
    try { const m = JSON.parse(fs.readFileSync(path.join(runDir, 'gate-evidence.json'), 'utf8')); if (Array.isArray(m.gates)) prior = m.gates; } catch { }
  }
  const results = [];
  const usedOutFiles = new Map();
  for (const g of gates) {
    /** R8-04 (achtste herreview) — WEERLEGT MIJN CLAIM "per poort gemeten": ik nam één gitState() ná ALLE
     *  poorten en plakte die op elk record. Bron of HEAD kon dus tijdens een poort wijzigen en vóór de
     *  eindmeting worden hersteld, waarna het record een staat claimde waarop die poort nooit volledig
     *  draaide. Nu ECHT per poort: vóór en ná, en alleen wanneer beide metingen identiek zijn geldt de
     *  binding — anders draagt het record `stable:false` en is duidelijk dat de code tijdens die poort
     *  bewoog. */
    const codeVoor = gitState(root);
    const res = runGate(g, root);
    const codeNa = gitState(root);
    /** R9-03 (negende herreview) — EERLIJKE GRENS, geen fix. `stable` vergelijkt de codestaat VOOR en NA
     *  een poort. Een wijziging die tijdens de poort wordt gemaakt en vóór het einde teruggedraaid
     *  (A→B→A), geeft identieke eindpunten en blijft dus onzichtbaar. Dat is geen scherpere vergelijking
     *  waard: eindpunten kunnen per definitie geen tussentijdse toestand uitsluiten. Echt sluitend zou
     *  continu meten vereisen (een filesystem-watcher of een sandbox die schrijven blokkeert tijdens een
     *  poort) — een andere architectuur, niet een strengere check.
     *  Wat hier WEL gebeurt: de vergelijking gaat nu over de volledige BRONVINGERAFDRUK (HEAD + de hash
     *  van alle vuile bronbestanden), niet alleen over HEAD + een boolean. Daarmee wordt elke wijziging
     *  gezien die niet exact is teruggedraaid — de A→B→A-restklasse blijft, en staat gedocumenteerd in
     *  het manifest zelf via `stable_limitation`. */
    const gitStabiel = !!codeVoor && !!codeNa && codeVoor.available === true && codeNa.available === true
      && codeVoor.commit === codeNa.commit && codeVoor.source_fingerprint === codeNa.source_fingerprint;
    /** D2 fix (2026-09-26, fresh-laptop re-audit) — a project with NO git repository could never produce a
     *  single `stable:true` gate record: `codeVoor.available`/`codeNa.available` are both `false` by
     *  construction, so EVERY gate looked exactly like "the code changed during this gate" — indistinguishable
     *  from a real tamper, and it silently poisoned forge-runcontract.cjs's canonicalEvidenceDigest() forever
     *  (a required code.stable===true never held). There is nothing to destabilize without a versioning
     *  concept: a gate whose BEFORE and AFTER measurement both honestly agree "no git repository here" is
     *  bound instead to its own real output_sha256 (a genuine file digest, computed above and re-verified on
     *  read-back below) — never a fabricated commit, and never a false "unstable" claim either.
     *  2.1 fix (WP-S13, 2026-09-26 laptop re-audit, review C VERDICT FAIL) — `available === false` used to
     *  cover BOTH a positively confirmed no-git root AND an UNDETERMINED one (git refused for some other
     *  reason: dubious ownership, no commits yet, a poisoned env, git missing). This let an undetermined
     *  root be recorded `no_git:true` — exactly the false relaxation the fix closes. Now requires
     *  `confirmed_no_repo === true` on BOTH readings; an undetermined reading falls through to the
     *  `stable:false` branch below instead, fail-closed exactly as it was before the D2 no-git path ever
     *  existed. */
    const noGitStabiel = !!codeVoor && !!codeNa && codeVoor.available === false && codeNa.available === false
      && codeVoor.confirmed_no_repo === true && codeNa.confirmed_no_repo === true;
    if (gitStabiel) {
      res._code = { commit: codeNa.commit, worktree_clean: codeNa.worktree_clean, stable: true, no_git: false, source_fingerprint: codeNa.source_fingerprint };
    } else if (noGitStabiel) {
      res._code = { commit: null, worktree_clean: null, stable: true, no_git: true, reason: (codeNa && codeNa.reason) || (codeVoor && codeVoor.reason) || 'geen git-repository — bewijs gebonden aan de eigen output_sha256 van deze poort, niet aan een commit' };
    } else {
      res._code = { stable: false, no_git: false, reason: 'de codestaat veranderde TIJDENS deze poort, of kon niet betrouwbaar twee keer worden vastgesteld (bv. git weigerde tijdelijk) — de uitslag hoort bij geen enkele vaste commit', before: codeVoor && (codeVoor.commit || codeVoor.reason), after: codeNa && (codeNa.commit || codeNa.reason) };
    }
    // ruwe output op schijf (lokaal bewijs; de sha in het manifest maakt hem verifieerbaar)
    // r6b #8: twee poortnamen mogen NOOIT op hetzelfde outputpad landen — na sanitizing kunnen
    // "a/b" en "a:b" hetzelfde worden en zou de een de bewijsuitvoer van de ander overschrijven.
    const safe = String(g.name).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);
    if (usedOutFiles.has(safe) && usedOutFiles.get(safe) !== g.name) {
      throw new Error('poortnamen "' + usedOutFiles.get(safe) + '" en "' + g.name + '" botsen op hetzelfde bewijs-outputpad (' + safe + '.txt) — hernoem er een (r6b #8)');
    }
    usedOutFiles.set(safe, g.name);
    const outFile = path.join(rawDir, safe + '.txt');
    fs.writeFileSync(outFile, res._output, 'utf8');
    res.output_file = path.relative(root, outFile).replace(/\\/g, '/');
    delete res._output;
    results.push(res);
    if (!opts.quiet) console.log((res.exit_code === 0 ? '  ok  ' : '  FAIL ') + res.name + ' · exit ' + res.exit_code + ' · ' + res.duration_ms + 'ms · sha ' + res.output_sha256.slice(0, 12) + '… · ' + (res.tail[res.tail.length - 1] || '').slice(0, 90));
  }
  /** r6b #8: BEHOUDEN records worden opnieuw gehasht. Zonder die hercontrole beweert het manifest
   *  "verifieerbaar" over een bewijsbestand dat intussen ontbreekt, gewijzigd of overschreven is —
   *  en zou all_green daar stil overheen lopen. Een mismatch/afwezigheid maakt de poort ROOD met
   *  reden; hij verdwijnt nooit stilzwijgend uit het manifest. */
  const names = new Set(results.map((r) => r.name));
  const retained = prior.filter((p) => !names.has(p.name)).map((p) => {
    const rec = Object.assign({}, p);
    try {
      const raw = fs.readFileSync(path.join(root, p.output_file), 'utf8');
      const sha = crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
      if (sha !== p.output_sha256) {
        rec.evidence_verified = false;
        rec.evidence_problem = 'sha256 van het bewaarde bewijsbestand wijkt af van het manifest (bestand gewijzigd/overschreven)';
        rec.exit_code = rec.exit_code === 0 ? -2 : rec.exit_code;
      } else rec.evidence_verified = true;
    } catch (e) {
      rec.evidence_verified = false;
      rec.evidence_problem = 'bewijsbestand ontbreekt of is onleesbaar: ' + (e.code || e.message);
      rec.exit_code = rec.exit_code === 0 ? -2 : rec.exit_code;
    }
    return rec;
  });
  /** R7-07 (zevende herreview): `--merge` behield oude gaterecords maar schreef ÉÉN top-level codestaat.
   *  Het manifest noemde dus commit X terwijl negen van de tien poorten vóór X hadden gedraaid — mijn
   *  claim "het manifest pint zijn eigen commit" gold alleen voor de nieuwste poorten. Bewijs is PER
   *  POORT, dus de codebinding hoort dat ook te zijn: elke poort draagt nu de commit waarop hij echt
   *  draaide, en de top-level samenvatting zegt eerlijk of die allemaal gelijk zijn. */
  const codeNu = gitState(root);
  for (const r of results) {
    /** R9-05 (negende herreview): hier stond `evidence_verified = true` met de motivering "zojuist zelf
     *  geschreven" — een aanname, geen verificatie. De MERGE-tak leest zijn bewaarde bestanden wel terug
     *  (zie hierboven), maar verse records kregen het vinkje gratis. Een schrijfactie die faalt, afkapt of
     *  door iets anders wordt overschreven, leverde dus toch "geverifieerd" bewijs. Nu leest ook het
     *  verse pad terug en hasht opnieuw: het vinkje betekent voortaan dat het bestand op schijf ECHT bij
     *  de hash in het manifest hoort. */
    try {
      const opSchijf = fs.readFileSync(path.join(root, r.output_file), 'utf8');
      const sha = crypto.createHash('sha256').update(opSchijf, 'utf8').digest('hex');
      if (sha === r.output_sha256) r.evidence_verified = true;
      else {
        r.evidence_verified = false;
        r.evidence_problem = 'read-back na het schrijven wijkt af van de berekende sha256 — de bewaarde uitvoer hoort niet bij dit record';
        r.exit_code = r.exit_code === 0 ? -2 : r.exit_code;
      }
    } catch (e) {
      r.evidence_verified = false;
      r.evidence_problem = 'de bewaarde uitvoer is niet terug te lezen: ' + (e && e.message ? e.message : String(e));
      r.exit_code = r.exit_code === 0 ? -2 : r.exit_code;
    }
    r.code = r._code || { stable: false, reason: 'geen per-poort-meting beschikbaar' };
    delete r._code;
  }
  const all = [...retained, ...results];
  const failed = all.filter((r) => r.exit_code !== 0 || r.evidence_verified === false);
  const manifest = {
    schema: 1,
    run_id: runId,
    generated_at: new Date().toISOString(),
    host_node: process.version,
    platform: process.platform,
    gates_total: all.length,
    gates_failed: failed.length,
    all_green: failed.length === 0,
    evidence_reverified_on_merge: !!opts.merge,
    /** CODE-BINDING (R3-08 / R4-08 / R5-10 — drie keer dezelfde bevinding, drie reviewrondes lang):
     *  het manifest bewees WELKE outputs bestaan, niet welke CODE die outputs heeft voortgebracht. De
     *  poorten draaiden steevast vlak vóór de commit, dus "8 poorten groen" was administratief groen in
     *  plaats van commit-gebonden groen — een lezer kon niet nagaan waarop het sloeg. Nu pint het
     *  manifest de commit waarop is gedraaid, plus of de werkboom daarbij schoon was. Een vuile boom is
     *  geen fout maar wel een beperking: dan zegt de commit-sha niet het hele verhaal, en dat hoort
     *  zichtbaar te zijn in plaats van weggelaten. */
    code: (() => {
      /** R7-07: de top-level staat is voortaan een SAMENVATTING van wat de poorten zelf dragen, niet een
       *  losse momentopname die over behouden records heen claimt. `uniform:false` betekent letterlijk:
       *  deze poorten zijn niet allemaal op dezelfde commit gedraaid — lees de per-poort-binding. */
      const commits = [...new Set(all.map((g) => (g.code && g.code.commit) || null).filter(Boolean))];
      const schoon = all.every((g) => g.code && g.code.stable === true && g.code.worktree_clean === true);
      return Object.assign({}, codeNu, {
        uniform: commits.length <= 1 && all.every((g) => g.code && g.code.stable === true),
        commits_in_manifest: commits,
        all_gates_on_clean_worktree: schoon,
        stable_limitation: 'stable vergelijkt de bronvingerafdruk VOOR en NA elke poort. Een wijziging die tijdens de poort wordt gemaakt en voor het einde exact wordt teruggedraaid (A->B->A) geeft identieke eindpunten en blijft onzichtbaar; dat vereist continu meten, niet een strengere vergelijking.',
        note: commits.length > 1
          ? 'LET OP: de poorten in dit manifest draaiden op VERSCHILLENDE commits (zie per-poort `code`). De top-level commit is die van de laatste run, niet van alle poorten.'
          : 'Alle poorten draaiden op dezelfde commit; is all_gates_on_clean_worktree false, dan beschrijft die commit de basis en niet de exacte geteste bytes.',
      });
    })(),
    note: 'Elke regel is een ECHT uitgevoerde poort: exacte argv, exitcode, timestamps en de sha256 van de ruwe uitvoer. De ruwe uitvoer staat lokaal onder gate-output/ (gitignored); dit manifest is het getrackte, verifieerbare bewijs.',
    gates: all,
  };
  const manifestFile = path.join(runDir, 'gate-evidence.json');
  const tmp = manifestFile + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, manifestFile);
  return { manifest, manifestFile };
}

module.exports = { record, runGate, tokenize };

if (require.main === module) {
  const o = parseArgs(process.argv.slice(2));
  if (!o.run || !/^[A-Za-z0-9_-]+$/.test(o.run)) {
    console.error('usage: node forge-gate-evidence.cjs --run <run_id> [--root <projectRoot>] [--gates <gates.json>] [--gate "naam::cmd arg"] [--merge] [--json]');
    process.exit(2);
  }
  let gates = [];
  if (o.gates) {
    try { gates = JSON.parse(fs.readFileSync(path.resolve(o.gates), 'utf8')); }
    catch (e) { console.error('gates-bestand onleesbaar: ' + e.message); process.exit(2); }
  }
  for (const spec of o.inline) {
    const idx = spec.indexOf('::');
    if (idx === -1) { console.error('--gate verwacht "naam::commando args"'); process.exit(2); }
    const name = spec.slice(0, idx);
    const parts = tokenize(spec.slice(idx + 2).trim());
    if (!parts.length) { console.error('--gate "' + name + '" heeft geen commando'); process.exit(2); }
    gates.push({ name, cmd: parts[0], args: parts.slice(1) });
  }
  if (!gates.length) { console.error('geen poorten opgegeven (--gates of --gate)'); process.exit(2); }
  const { manifest, manifestFile } = record(o.run, gates, { root: o.root, merge: o.merge });
  if (o.json) console.log(JSON.stringify(manifest, null, 2));
  else console.log('\n' + manifest.gates_total + ' poort(en) · ' + (manifest.all_green ? 'ALLE GROEN' : manifest.gates_failed + ' GEFAALD') + ' -> ' + path.relative(process.cwd(), manifestFile));
  process.exit(manifest.all_green ? 0 : 1);
}
