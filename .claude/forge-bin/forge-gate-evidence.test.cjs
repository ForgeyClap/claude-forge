#!/usr/bin/env node
'use strict';
/**
 * forge-gate-evidence.cjs — bewijsrecorder (Codex rapport-review R-01/R-05, 2026-08-07).
 * Hermetisch: eigen temp-root, eigen mini-poorten (echte node-processen), nooit de echte runs.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name + (extra ? ' :: ' + extra : '')); } };

const TOOL = path.join(__dirname, 'forge-gate-evidence.cjs');
const E = require(TOOL);
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-evidence-'));
const RUN = 'evidence-run';
fs.mkdirSync(path.join(ROOT, '.claude', 'forge-runs', RUN), { recursive: true });

// mini-poorten: echte node-processen met bekende uitvoer en exitcode
const okScript = path.join(ROOT, 'ok.cjs');
fs.writeFileSync(okScript, "console.log('7 passed, 0 failed');process.exit(0);");
const badScript = path.join(ROOT, 'bad.cjs');
fs.writeFileSync(badScript, "console.log('3 passed, 2 failed');console.error('boem');process.exit(1);");

console.log('forge-gate-evidence (hermetisch, root=' + ROOT + ')');

// 1) groene poort: record klopt en is zelf-verifieerbaar
{
  const { manifest, manifestFile } = E.record(RUN, [{ name: 'groen', cmd: process.execPath, args: [okScript] }], { root: ROOT, quiet: true });
  const g = manifest.gates[0];
  t('1 manifest bevat de poort met exit 0 en all_green', manifest.all_green === true && manifest.gates_total === 1 && g.exit_code === 0);
  t('1 de exacte argv is vastgelegd (geen shell-string)', Array.isArray(g.argv) && g.argv[0] === process.execPath && g.argv[1] === okScript);
  t('1 timestamps + duur zijn echt', typeof g.started_at === 'string' && typeof g.ended_at === 'string' && g.duration_ms >= 0 && Date.parse(g.ended_at) >= Date.parse(g.started_at));
  t('1 de tail draagt de echte uitslagregel', (g.tail || []).join(' ').includes('7 passed, 0 failed'));
  const raw = fs.readFileSync(path.join(ROOT, g.output_file), 'utf8');
  t('1 output_sha256 hoort ECHT bij de opgeslagen ruwe uitvoer', crypto.createHash('sha256').update(raw, 'utf8').digest('hex') === g.output_sha256);
  t('1 het manifest staat op de verwachte plek', fs.existsSync(manifestFile) && manifestFile.endsWith('gate-evidence.json'));
}

// 2) rode poort: het manifest is NOOIT groen over een non-zero exit (de kern van deze recorder)
{
  const { manifest } = E.record(RUN, [{ name: 'rood', cmd: process.execPath, args: [badScript] }], { root: ROOT, quiet: true });
  const g = manifest.gates.find((x) => x.name === 'rood');
  t('2 een rode poort levert exit 1 in het record', g.exit_code === 1);
  t('2 het manifest is NIET groen', manifest.all_green === false && manifest.gates_failed >= 1);
  t('2 stderr zit mee in de vastgelegde uitvoer', fs.readFileSync(path.join(ROOT, g.output_file), 'utf8').includes('boem'));
}

// 3) --merge: eerdere poorten blijven, gelijknamige worden vervangen
{
  E.record(RUN, [{ name: 'blijft', cmd: process.execPath, args: [okScript] }], { root: ROOT, quiet: true });
  const { manifest } = E.record(RUN, [{ name: 'rood', cmd: process.execPath, args: [okScript] }], { root: ROOT, quiet: true, merge: true });
  const namen = manifest.gates.map((g) => g.name);
  t('3 merge behoudt de eerder vastgelegde poort', namen.includes('blijft'));
  t('3 merge VERVANGT de gelijknamige poort (rood is nu groen)', manifest.gates.filter((g) => g.name === 'rood').length === 1 && manifest.gates.find((g) => g.name === 'rood').exit_code === 0);
  t('3 en het manifest wordt daarmee groen', manifest.all_green === true, JSON.stringify(namen));
}

// 4) CLI-contract: exit 1 zodra een poort rood is, exit 0 als alles groen is
{
  // paden met spaties MOETEN werken (node staat in "C:\Program Files\..."; deze projectmap heet
  // "my project (v2)!") — daarom quotes in de inline --gate-vorm.
  const q = (x) => '"' + x + '"';
  const r1 = spawnSync(process.execPath, [TOOL, '--run', RUN, '--root', ROOT, '--gate', 'cli-rood::' + q(process.execPath) + ' ' + q(badScript)], { encoding: 'utf8' });
  t('4 CLI exit 1 bij een rode poort', r1.status === 1, 'status=' + r1.status);
  const r2 = spawnSync(process.execPath, [TOOL, '--run', RUN, '--root', ROOT, '--gate', 'cli-groen::' + q(process.execPath) + ' ' + q(okScript)], { encoding: 'utf8' });
  t('4 CLI exit 0 wanneer de opgegeven poort groen is (pad met spaties werkt)', r2.status === 0, 'status=' + r2.status + ' :: ' + (r2.stdout || '').slice(0, 160));
  const rawPad = String.raw`C:\Program Files\nodejs\node.exe`;
  t('4 de tokenizer houdt een gequoteerd pad met spaties heel',
    JSON.stringify(E.tokenize('"' + rawPad + '" --flag x')) === JSON.stringify([rawPad, '--flag', 'x']),
    JSON.stringify(E.tokenize('"' + rawPad + '" --flag x')));
  t('4 en splitst een ONgequoteerd pad met spaties wél (documenteert waarom quotes nodig zijn)',
    E.tokenize(rawPad + ' --flag').length === 3);
  const r3 = spawnSync(process.execPath, [TOOL, '--root', ROOT], { encoding: 'utf8' });
  t('4 CLI zonder --run weigert met usage (exit 2)', r3.status === 2 && /usage:/.test(r3.stderr || ''));
}

// 5) npm-shell-uitzondering (win32): VASTE argumenten mogen, vrije/variabele NIET
{
  let threw = null;
  try { E.record(RUN, [{ name: 'npm-vrij', cmd: 'npm', args: ['test', '--silent', 'iets met spaties & ampersand'] }], { root: ROOT, quiet: true }); }
  catch (e) { threw = e; }
  if (process.platform === 'win32') {
    t('5 npm met vrije/onveilige argumenten wordt geweigerd (shell-uitzondering blijft eng)', threw !== null && /VASTE, simpele argumenten/.test(threw.message), threw && threw.message);
  } else {
    t('5 SKIP-voorwaarde geverifieerd: de npm-shell-uitzondering geldt alleen op win32 (dit is ' + process.platform + ')', process.platform !== 'win32');
  }
}

try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { }
/** R9-08 (negende herreview): de recorder-suite dekte de codebinding en de read-back niet. Beide zijn
 *  claims die pas iets betekenen als ze worden AFGEDWONGEN — dus horen ze een test te hebben die faalt
 *  zodra de handhaving wegvalt. */
{
  const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ge-r9-'));
  const R = require(path.join(__dirname, 'forge-gate-evidence.cjs'));
  const res = R.record('r9', [{ name: 'echo', cmd: process.execPath, args: ['-e', 'console.log("hallo")'] }], { root: ROOT });
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude', 'forge-runs', 'r9', 'gate-evidence.json'), 'utf8'));
  const g = m.gates[0];
  t('R9-08 elke poort draagt een eigen codemeting', !!g.code, JSON.stringify(g.code));
  t('R9-08 met een expliciete stable-vlag (per poort gemeten, niet achteraf geplakt)', typeof g.code.stable === 'boolean');
  t('R9-08 evidence_verified is op READ-BACK gebaseerd: het bestand op schijf hoort echt bij de hash',
    g.evidence_verified === true && crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, g.output_file), 'utf8'), 'utf8').digest('hex') === g.output_sha256);
  // sabotage de bewaarde uitvoer -> een MERGE moet dat zien en het record rood maken
  fs.writeFileSync(path.join(ROOT, g.output_file), 'gemanipuleerd\n');
  R.record('r9', [{ name: 'tweede', cmd: process.execPath, args: ['-e', 'console.log("x")'] }], { root: ROOT, merge: true });
  const m2 = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude', 'forge-runs', 'r9', 'gate-evidence.json'), 'utf8'));
  const oud = m2.gates.find((x) => x.name === 'echo');
  t('R9-08 een gemanipuleerd bewijsbestand maakt het behouden record ONgeverifieerd',
    oud && oud.evidence_verified === false, JSON.stringify(oud && { v: oud.evidence_verified, p: oud.evidence_problem }));
  t('R9-08 en het manifest is daardoor niet meer all_green', m2.all_green === false);
  t('R9-08 de A->B->A-grens staat expliciet IN het manifest', typeof m2.code.stable_limitation === 'string' && /A->B->A/.test(m2.code.stable_limitation));
  fs.rmSync(ROOT, { recursive: true, force: true });
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
