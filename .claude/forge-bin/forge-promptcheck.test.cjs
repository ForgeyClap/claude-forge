#!/usr/bin/env node
'use strict';
/** Hermetic, real-CLI tests for forge-promptcheck.cjs (WP-PROMPTCHECK). Every case runs the actual CLI
 *  via spawnSync (never requires the module directly for assertions) so exit codes / stdout / logged
 *  events are proven, not assumed (the `ask` section adds ONE direct check of the exported pure scoreAsk,
 *  since that function is itself documented module API). Temp prompt files + a temp fake .claude/ project root live under one
 *  os.tmpdir() dir — nothing here touches this repo's real .claude/forge-runs/. Exit 0 = all pass. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-promptcheck-test-'));
const CLI = path.join(__dirname, 'forge-promptcheck.cjs');

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };

console.log('forge-promptcheck offline tests (hermetic tmp=' + TMP + ')');

function writePrompt(name, text) {
  const p = path.join(TMP, name + '-' + Math.random().toString(36).slice(2) + '.txt');
  fs.writeFileSync(p, text, 'utf8');
  return p;
}
function runCli(args, opts) {
  return spawnSync(process.execPath, [CLI, ...args], Object.assign({ encoding: 'utf8' }, opts || {}));
}
function runJson(text, extraArgs) {
  const file = writePrompt('p', text);
  const r = runCli([file, '--json'].concat(extraArgs || []));
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch { /* leave null; assertions below fail loudly */ }
  return { r, parsed };
}

// ---- fixtures ----
// A prompt shaped like a real Forge work package (see forge-router SKILL.md "Emit Work Packages") —
// this is the "a good dispatch already passes" claim from the read-first material, proven for real.
const STRONG_PROMPT = [
  'WORK PACKAGE -- Build Boss',
  'mission: Build the LoginForm component; the deliverable is src/components/LoginForm.tsx.',
  'inputs: src/components/LoginForm.tsx, src/lib/auth.ts',
  'allowed_actions: edit only these files listed in inputs.',
  'not_allowed: do not touch src/lib/session.ts; never modify unrelated files.',
  'output_artifact: src/components/LoginForm.tsx',
  'evidence_required: quote real npm test output as evidence; do not claim success without proof.',
  'success_criteria: must pass tests/login.test.ts; verify with npm test.',
  'rework_criteria: missing validation or an unhandled error path.',
].join('\n');

const WEAK_PROMPT = 'improve the thing and fix stuff';

// ---- 1) strong dispatch -> score >=6, PROMPT-MASTER-SHAPED, exit 0 ----
{
  const { r, parsed } = runJson(STRONG_PROMPT);
  t('case1: CLI exits 0', r.status === 0);
  t('case1: parsed JSON present', !!parsed);
  t('case1: passed >= 6', !!parsed && parsed.passed >= 6);
  t('case1: verdict is PROMPT-MASTER-SHAPED', !!parsed && parsed.verdict === 'PROMPT-MASTER-SHAPED');
}

// ---- 2) weak vague prompt -> low score, NEEDS-SHARPENING, missing dims listed, exit 0 (advisory) ----
{
  const { r, parsed } = runJson(WEAK_PROMPT);
  t('case2: CLI exits 0 (advisory, non-blocking by default)', r.status === 0);
  t('case2: low score (< 4)', !!parsed && parsed.passed < 4);
  t('case2: verdict is NEEDS-SHARPENING', !!parsed && /^NEEDS-SHARPENING/.test(parsed.verdict));
  t('case2: missing dims listed (non-empty)', !!parsed && Array.isArray(parsed.missing) && parsed.missing.length > 0);
}

// ---- 3) --strict on the weak prompt -> exit 1 ----
{
  const file = writePrompt('weak-strict', WEAK_PROMPT);
  const r = runCli([file, '--strict']);
  t('case3: --strict on a weak prompt exits 1', r.status === 1);
}
// --strict on the strong prompt still exits 0 (sanity check the flag doesn't just always fail/pass)
{
  const file = writePrompt('strong-strict', STRONG_PROMPT);
  const r = runCli([file, '--strict']);
  t('case3b: --strict on a strong prompt exits 0', r.status === 0);
}

// ---- 4) each of the 7 dimensions individually detected (missing exactly one -> only that one flagged) ----
{
  const HEADER = 'Dispatch prompt for Boss X.';
  // Each field is deliberately isolated: it carries ONLY the keyword(s) for its own dimension, with no
  // path/file tokens and no words that belong to any other dimension's keyword list (hand-verified).
  const FIELDS = {
    'target-state': 'Mission: this task has a clear deliverable and target result; done when the goal is reached.',
    'allowed-scope': 'Allowed_actions: work only on the assigned inputs; edit only what is listed.',
    'forbidden-scope': 'Not_allowed: do not touch the shared config; never modify unrelated code. This is a scope lock -- only the assigned area may change, nothing else, must not go outside that boundary.',
    'stop-condition': 'Stop condition: ask before proceeding if requirements are unclear; checkpoint before any destructive change; when complete, report back.',
    'acceptance-criteria': 'Acceptance: this must pass a review; verify thoroughly against the criteria. Rework_criteria: redo if broken.',
    'evidence-honesty': 'Evidence_required: quote the real command output as evidence; include proof; maintain honesty at every step.',
  };
  const KEYS = Object.keys(FIELDS);
  function buildPrompt(excludeKey) {
    const parts = [HEADER];
    for (const k of KEYS) { if (k !== excludeKey) parts.push(FIELDS[k]); }
    return parts.join('\n');
  }

  const baseline = runJson(buildPrompt(null));
  t('case4: baseline (all 6 keyword fields present) -> all 6 keyword dims true', !!baseline.parsed && KEYS.every((k) => baseline.parsed.dimensions[k] === true));
  t('case4: baseline also passes no-vague-verbs (0 vague words used)', !!baseline.parsed && baseline.parsed.dimensions['no-vague-verbs'] === true);

  for (const k of KEYS) {
    const { parsed } = runJson(buildPrompt(k));
    const onlyThisMissing = !!parsed && parsed.dimensions[k] === false && KEYS.filter((x) => x !== k).every((x) => parsed.dimensions[x] === true);
    t('case4: removing "' + k + '" flags only that dimension', onlyThisMissing);
  }

  // no-vague-verbs dimension in isolation: keep all 6 keyword fields, add nothing but vague filler.
  const vagueOnly = runJson(buildPrompt(null) + ' Please handle this, improve it, and clean up some stuff, etc.');
  const onlyVagueMissing = !!vagueOnly.parsed && vagueOnly.parsed.dimensions['no-vague-verbs'] === false && KEYS.every((k) => vagueOnly.parsed.dimensions[k] === true);
  t('case4: adding vague filler on top of the full baseline flags only no-vague-verbs', onlyVagueMissing);
}

// ---- 5) no-vague-verbs: flagged without path grounding; not flagged when paths/specifics are present ----
{
  const { parsed: p1 } = runJson('handle the stuff, improve it, etc');
  t('case5: vague verbs with no path/file token -> flagged', !!p1 && p1.dimensions['no-vague-verbs'] === false);

  const { parsed: p2 } = runJson('Edit src/lib/auth.ts: handle the edge cases in validate(), improve error handling for empty input, and optimize the hot path in src/lib/auth.ts.');
  t('case5: vague verbs anchored by concrete paths -> not flagged', !!p2 && p2.dimensions['no-vague-verbs'] === true);
}

// ---- 6) STDIN mode ('-') works ----
{
  const r = runCli(['-', '--json'], { input: STRONG_PROMPT });
  let parsed = null; try { parsed = JSON.parse(r.stdout); } catch { /* fail below */ }
  t('case6: stdin mode exits 0', r.status === 0);
  t('case6: stdin mode scores the strong prompt correctly', !!parsed && parsed.passed >= 6);
}

// ---- 7) --json shape parses with score/verdict/dimensions/missing ----
{
  const { parsed } = runJson(STRONG_PROMPT);
  t('case7: json has numeric score', !!parsed && typeof parsed.score === 'number');
  t('case7: json has numeric passed', !!parsed && typeof parsed.passed === 'number');
  t('case7: json total is 7', !!parsed && parsed.total === 7);
  t('case7: json has a string verdict', !!parsed && typeof parsed.verdict === 'string');
  t('case7: json dimensions object has exactly 7 keys', !!parsed && parsed.dimensions && Object.keys(parsed.dimensions).length === 7);
  t('case7: json has a missing array', !!parsed && Array.isArray(parsed.missing));
  t('case7: json has a suggestions array', !!parsed && Array.isArray(parsed.suggestions));
}

// ---- 8) --run logs one agent_note (real log-event.cjs copied into a temp project root); failure tolerated ----
{
  const root = path.join(TMP, 'run-root');
  fs.mkdirSync(path.join(root, '.claude', 'forge-dashboard'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude', 'forge-runs'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude', 'config', 'agents'), { recursive: true });
  const realLogEvent = path.join(__dirname, '..', 'forge-dashboard', 'log-event.cjs');
  fs.copyFileSync(realLogEvent, path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs'));
  fs.writeFileSync(path.join(root, '.claude', 'config', 'agents', 'agent-registry.json'), JSON.stringify({ agents: {} }));

  const file = writePrompt('run-ok', STRONG_PROMPT);
  const r = runCli([file, '--run', 'forge-test-run-001'], { env: Object.assign({}, process.env, { FORGE_PROJECT_ROOT: root }) });
  t('case8: CLI with --run still exits 0', r.status === 0);

  const evPath = path.join(root, '.claude', 'forge-runs', 'forge-test-run-001', 'events.jsonl');
  let events = [];
  try { events = fs.readFileSync(evPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); } catch { /* none written */ }
  t('case8: exactly one event logged', events.length === 1);
  t('case8: event_type is agent_note', events.length === 1 && events[0].event_type === 'agent_note');
  t('case8: agent is orchestrator', events.length === 1 && events[0].agent === 'orchestrator');
  t('case8: note carries the score', events.length === 1 && /\d\/7/.test(String(events[0].note)));

  // failure tolerated: FORGE_PROJECT_ROOT points at a dir with no log-event.cjs at all -> CLI still exits 0.
  const badRoot = path.join(TMP, 'run-root-missing');
  fs.mkdirSync(badRoot, { recursive: true });
  const file2 = writePrompt('run-missing', STRONG_PROMPT);
  const r2 = runCli([file2, '--run', 'forge-test-run-002'], { env: Object.assign({}, process.env, { FORGE_PROJECT_ROOT: badRoot }) });
  t('case8b: missing log-event.cjs is tolerated (CLI still exits 0)', r2.status === 0);
  t('case8b: a warning is still surfaced on stderr', /log-event warning/.test(r2.stderr));
}

// ---- 9) usage errors: no file argument at all, and an unreadable/nonexistent file, both exit 2 ----
{
  const r1 = runCli([]);
  t('case9: no arguments at all -> usage error exit 2', r1.status === 2);

  const r2 = runCli([path.join(TMP, 'does-not-exist-' + Math.random().toString(36).slice(2) + '.txt')]);
  t('case9b: nonexistent prompt file -> usage/read error exit 2', r2.status === 2);
}

// =====================================================================================================
// `ask` subcommand (wp6, 2026-09-24) — prompt-doctor on the RAW owner request. Real CLI again, plus one
// direct check of the exported pure function scoreAsk (the documented module API for in-process callers).
// =====================================================================================================
function runAsk(args, opts) {
  const r = runCli(['ask'].concat(args), opts);
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch { /* human mode or failure; assertions decide */ }
  return { r, parsed };
}
// wp18: every text in the ask JSON is bilingual — a failing dimension's fix is {nl, en}, a passing one null.
const isBilingual = (x) => !!x && typeof x.nl === 'string' && x.nl.length > 0 && typeof x.en === 'string' && x.en.length > 0;
const onlyMissing = (p, id) => !!p && p.missing.length === 1 && p.missing[0] === id
  && p.dimensions.filter((d) => !d.pass).map((d) => d.id).join() === id
  && isBilingual(p.dimensions.find((d) => d.id === id).fix) && p.dimensions.filter((d) => d.pass).every((d) => d.fix === null);

const ASK_NL_CLEAR = 'Voeg in src/components/Header.astro een zoekknop toe aan de bestaande Astro-site. Gebruik de huidige Tailwind-stijl en geen nieuwe dependencies. Klaar als de knop op mobiel en desktop zichtbaar is en de zoekpagina opent.';
const ASK_EN_CLEAR = 'Add a search button to src/components/Header.astro in the existing Astro site. Use the current Tailwind styles and no new dependencies. Done when the button is visible on mobile and desktop and opens the search page.';

// ---- 10) vague asks (NL + EN) -> VAGUE, one question, exit 3 ----
{
  const nl = runAsk(['maak het beter', '--json']);
  t('ask10: NL "maak het beter" exits 3 (VAGUE — act on it)', nl.r.status === 3);
  // wp18: the skill ranks F3 (very short) above F1 (vague verb), so a 3-word vague ask now asks F3 and records F1.
  t('ask10: NL vague verdict names the ONE thing asked — the top-ranked gap F3 (skill order F3 > F1)', !!nl.parsed && nl.parsed.verdict === 'VAGUE — ask one question: F3' && nl.parsed.passed <= 2 && nl.parsed.total === 5 && nl.parsed.gaps.join() === 'F3,F1,F6,F2');
  t('ask10: NL vague carries ONE question (research §B wording), bilingual, detected as nl', !!nl.parsed && nl.parsed.lang === 'nl' && nl.parsed.suggested_question.nl === 'Wat moet het vooral doen?' && nl.parsed.suggested_question.en === 'What should it mainly do?' && nl.parsed.nextQuestion.nl === nl.parsed.suggested_question.nl);
  t('ask10: every OTHER gap (F1 included) and every missing dimension becomes a bilingual assumption', !!nl.parsed && nl.parsed.assumptions.map((a) => a.id).join() === 'F1,F6,F2,' + nl.parsed.missing.join() && nl.parsed.assumptions.every((a) => /^\S/.test(a.nl) && /^\S/.test(a.en)));
  const human = runAsk(['maak het beter']);
  t('ask10: NL human report is Dutch and shows the owner question with its options', human.r.status === 3 && /VAAG — stel één vraag over: F3/.test(human.r.stdout) && /Vraag aan de eigenaar: Wat moet het vooral doen\?/.test(human.r.stdout) && /A\) klanten laten bellen\/aanvragen \*/.test(human.r.stdout));
  const en = runAsk(['make it better', '--json']);
  t('ask11: EN "make it better" exits 3 with an English question', en.r.status === 3 && !!en.parsed && en.parsed.lang === 'en' && en.parsed.suggested_question.en === 'What should it mainly do?' && /^VAGUE — ask one question: /.test(en.parsed.verdict));
  t('ask11: EN human report is English', /Question for the owner: /.test(runAsk(['make it better']).r.stdout));
}

// ---- 12) clear asks (NL + EN) -> CLEAR, no question, no assumptions, exit 0 ----
{
  const nl = runAsk([ASK_NL_CLEAR, '--json']);
  t('ask12: NL clear request (file + stack + done-criterion) is CLEAR, exit 0', nl.r.status === 0 && !!nl.parsed && nl.parsed.verdict === 'CLEAR' && nl.parsed.passed === 5 && nl.parsed.score === 5);
  t('ask12: CLEAR has no gaps, no question, no assumptions, no missing dims, all fixes null', !!nl.parsed && nl.parsed.gaps.length === 0 && nl.parsed.nextQuestion === null && nl.parsed.suggested_question === null && nl.parsed.assumptions.length === 0 && nl.parsed.missing.length === 0 && nl.parsed.dimensions.every((d) => d.pass && d.fix === null));
  t('ask12: NL clear human report reads HELDER', /5\/5 — HELDER/.test(runAsk([ASK_NL_CLEAR]).r.stdout));
  const en = runAsk([ASK_EN_CLEAR, '--json']);
  t('ask13: EN clear request is CLEAR, exit 0, lang en', en.r.status === 0 && !!en.parsed && en.parsed.verdict === 'CLEAR' && en.parsed.lang === 'en');
  t('ask13: JSON dimensions are exactly the 5 ids, in order', !!en.parsed && en.parsed.dimensions.map((d) => d.id).join() === 'clarity,specificity,context,completeness,structure');
}

// ---- 14) every dimension FAILS on its own (NL + EN), everything else passing -> OK, exit 0 ----
{
  const WALL_NL = 'voeg in src/components/Header.astro een zoekknop toe aan de bestaande Astro-site en gebruik daarbij de huidige Tailwind-stijl zonder nieuwe dependencies en zorg dat de knop op mobiel en op desktop netjes rechts in de header staat en klaar als de knop zichtbaar is en de zoekpagina opent en de bestaande tests nog steeds slagen en er niets anders verandert aan de rest van de site';
  const WALL_EN = 'add a search button to src/components/Header.astro in the existing Astro site and use the current Tailwind styles without new dependencies and make sure the button sits on the right side of the header on mobile and on desktop and it is done when the button is visible and opens the search page and the existing tests still pass and nothing else on the site changes at all';
  const ISOLATED = [
    ['clarity', 'nl', 'Ik wil de header in src/components/Header.astro van de bestaande Astro-site. Klaar als de knop op mobiel zichtbaar is.'],
    ['specificity', 'nl', 'Voeg een nieuwe optie toe in het bestaande project met de huidige stack. Klaar als het werkt en alles groen is.'],
    ['context', 'nl', 'Voeg een zoekknop toe aan de header. Klaar als de knop zichtbaar is.'],
    ['completeness', 'nl', 'Voeg een zoekknop toe aan de header van de bestaande Astro-site.'],
    ['structure', 'nl', WALL_NL],
    ['clarity', 'en', 'I want something with the header in src/components/Header.astro of the existing Astro site. Done when the button is visible on mobile.'],
    ['specificity', 'en', 'Add a new option in the existing project with the current stack. Done when it works and everything is green.'],
    ['context', 'en', 'Add a search button to the header. Done when the button is visible.'],
    ['completeness', 'en', 'Add a search button to the header of the existing Astro site.'],
    ['structure', 'en', WALL_EN],
  ];
  for (const [id, lang, text] of ISOLATED) {
    const { r, parsed } = runAsk([text, '--json']);
    t('ask14: ' + lang + ' — only "' + id + '" fails, verdict OK — auto-fill: ' + id + ', exit 0', r.status === 0 && onlyMissing(parsed, id) && parsed.verdict === 'OK — auto-fill: ' + id && parsed.lang === lang && parsed.suggested_question === null && parsed.assumptions.filter((a) => a.id === id).length === 1);
  }
  const short = runAsk(['fix login.ts', '--json']);
  t('ask14: a 1-3 word request fails structure', !!short.parsed && short.parsed.dimensions.find((d) => d.id === 'structure').pass === false);
}

// ---- 15) 3/5 -> OK with auto-fill list, assumptions for each missing dim, no question ----
{
  const { r, parsed } = runAsk(['Voeg een zoekknop toe aan de header.', '--json']);
  t('ask15: 3/5 request is "OK — auto-fill: context, completeness", exit 0', r.status === 0 && !!parsed && parsed.passed === 3 && parsed.verdict === 'OK — auto-fill: context, completeness');
  t('ask15: OK records one assumption per missing dimension (+ gaps F3 short, F6 no audience, F2 no done check) and asks nothing', !!parsed && parsed.assumptions.map((a) => a.id).join() === 'F3,F6,F2,context,completeness' && parsed.suggested_question === null && parsed.nextQuestion === null);
}

// ---- 16) usage errors -> exit 2 ----
{
  t('ask16: empty text -> exit 2', runCli(['ask', '']).status === 2);
  t('ask16: whitespace-only text -> exit 2', runCli(['ask', '   \t  ']).status === 2);
  t('ask16: no text at all -> exit 2', runCli(['ask']).status === 2);
  t('ask16: --lang xx -> exit 2', runCli(['ask', 'voeg een knop toe', '--lang', 'xx']).status === 2);
  const f = writePrompt('ask-both', ASK_NL_CLEAR);
  t('ask16: inline text AND --file -> exit 2', runCli(['ask', 'voeg een knop toe', '--file', f]).status === 2);
  t('ask16: unreadable --file -> exit 2', runCli(['ask', '--file', path.join(TMP, 'nope-' + Math.random().toString(36).slice(2) + '.txt')]).status === 2);
  t('ask16: an empty --file -> exit 2', runCli(['ask', '--file', writePrompt('ask-empty', '  \n ')]).status === 2);
}

// ---- 17) --file and stdin input ----
{
  const viaFile = runAsk(['--file', writePrompt('ask-file', ASK_NL_CLEAR), '--json']);
  t('ask17: --file <path> is scored like inline text', viaFile.r.status === 0 && !!viaFile.parsed && viaFile.parsed.verdict === 'CLEAR');
  const viaStdin = runAsk(['--file', '-', '--json'], { input: 'make it better' });
  t('ask17: --file - reads stdin', viaStdin.r.status === 3 && !!viaStdin.parsed && viaStdin.parsed.lang === 'en');
}

// ---- 18) determinism: same input twice -> byte-identical JSON ----
{
  const a1 = runCli(['ask', ASK_NL_CLEAR, '--json']).stdout;
  const a2 = runCli(['ask', ASK_NL_CLEAR, '--json']).stdout;
  const b1 = runCli(['ask', 'maak het beter', '--json']).stdout;
  const b2 = runCli(['ask', 'maak het beter', '--json']).stdout;
  t('ask18: same clear input twice -> byte-identical JSON', a1.length > 0 && a1 === a2);
  t('ask18: same vague input twice -> byte-identical JSON', b1.length > 0 && b1 === b2);
}

// ---- 19) --lang overrides detection and the output language ----
{
  const { parsed } = runAsk(['maak het beter', '--lang', 'en', '--json']);
  t('ask19: --lang en on a Dutch request -> lang en; JSON still carries both languages', !!parsed && parsed.lang === 'en' && parsed.suggested_question.en === 'What should it mainly do?' && parsed.nextQuestion.nl === 'Wat moet het vooral doen?');
  const out = runCli(['ask', 'maak het beter', '--lang', 'en']).stdout;
  t('ask19: --lang en human output is English (question, options, assumptions)', /VAGUE — ask one question: F3/.test(out) && /A\) let customers call or send a request \*/.test(out) && /Assumptions to record/.test(out) && !/Aanname/.test(out));
}

// ---- 20) --run logs exactly ONE agent_note; exit code still reflects the verdict ----
{
  const root = path.join(TMP, 'ask-run-root');
  fs.mkdirSync(path.join(root, '.claude', 'forge-dashboard'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude', 'forge-runs'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude', 'config', 'agents'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'forge-dashboard', 'log-event.cjs'), path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs'));
  fs.writeFileSync(path.join(root, '.claude', 'config', 'agents', 'agent-registry.json'), JSON.stringify({ agents: {} }));
  const r = runCli(['ask', 'maak het beter', '--run', 'forge-test-ask-001'], { env: Object.assign({}, process.env, { FORGE_PROJECT_ROOT: root }) });
  t('ask20: --run on a vague ask still exits 3', r.status === 3);
  let events = [];
  try { events = fs.readFileSync(path.join(root, '.claude', 'forge-runs', 'forge-test-ask-001', 'events.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); } catch { /* none written */ }
  t('ask20: exactly one agent_note logged, carrying the ask score', events.length === 1 && events[0].event_type === 'agent_note' && /^forge-promptcheck ask: 0\/5 VAGUE/.test(String(events[0].note)));
}

// ---- 21) backward compatibility: a dispatch-prompt file literally named "ask" is reachable as ./ask ----
{
  const dir = path.join(TMP, 'ask-named');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ask'), STRONG_PROMPT, 'utf8');
  const r = runCli(['./ask', '--json'], { cwd: dir });
  let parsed = null; try { parsed = JSON.parse(r.stdout); } catch { /* fail below */ }
  t('ask21: ./ask still runs the dispatch-prompt mode (total 7, PROMPT-MASTER-SHAPED)', r.status === 0 && !!parsed && parsed.total === 7 && parsed.verdict === 'PROMPT-MASTER-SHAPED');
}

// ---- 23) failure-mode gap detectors (research §B) — one Dutch FAIL case + its clear counterpart each ----
{
  const gapsOf = (text) => { const { parsed } = runAsk([text, '--json']); return parsed ? parsed.gaps : null; };
  const DETECTORS = [
    ['F1', 'maak het beter', ASK_NL_CLEAR],
    ['F3', 'maak een webshop', ASK_NL_CLEAR],
    ['F7', 'Bouw een platform zoals Marktplaats maar dan voor tweedehands fietsen in Utrecht.',
      'Bouw een eerste versie waarin fietsverkopers in Utrecht een advertentie met foto en prijs plaatsen. Klaar als één advertentie zichtbaar is.'],
    ['F5', 'Bouw een website en een chatbot voor mijn kapsalon in Utrecht, zodat klanten makkelijk een afspraak maken.',
      'Bouw een website voor mijn kapsalon in Utrecht, zodat klanten makkelijk een afspraak maken.'],
    ['F8', 'Maak de verzendknop op het formulier van mijn site groter, zodat klanten hem goed zien.',
      'Maak de verzendknop op het formulier in src/pages/contact.astro groter, zodat klanten hem goed zien.'],
    ['F9', 'De checkout werkt niet meer.',
      'De checkout werkt niet meer sinds de update van gisteren: ik verwacht een bedankpagina maar zie een lege pagina.'],
    ['F10', 'Maak de homepage van de webshop moderner en strakker.',
      'Maak de homepage van de webshop moderner, zoals https://stripe.com, met meer witruimte.'],
    ['F13', 'Stuur de nieuwsbrief naar alle klanten.',
      'Zet de nieuwsbrief voor alle klanten alleen als concept klaar; versturen pas na mijn OK.'],
    // wp18: the five detectors the skill describes that wp6 did not implement yet
    ['F2', 'Bouw een contactformulier voor mijn klanten op de bestaande website, zodat ze een afspraak aanvragen.',
      'Bouw een contactformulier voor mijn klanten op de bestaande website. Klaar als een testaanvraag in mijn mailbox staat.'],
    ['F4', 'Zet er een database in voor de klantgegevens van de kapsalon.',
      'Zet er een database in, zodat klantgegevens van de kapsalon niet meer kwijtraken.'],
    ['F6', 'Bouw een eenvoudige website met openingstijden, prijzen en een belknop. Klaar als hij op mobiel werkt.',
      'Bouw een eenvoudige website voor mijn klanten met openingstijden, prijzen en een belknop. Klaar als hij op mobiel werkt.'],
    ['F11', 'Pas de homepage van de webshop aan met nieuwe kleuren. Klaar als het er fris uitziet.',
      'Pas de homepage van de webshop aan met nieuwe kleuren; teksten en logo blijven hetzelfde. Klaar als het er fris uitziet.'],
    ['F12', 'Laat maar, eigenlijk wil ik toch liever een webshop in plaats van de website.',
      'Bouw na de website ook een webshop voor mijn klanten. Klaar als er één product in staat.'],
  ];
  for (const [id, bad, good] of DETECTORS) {
    const badGaps = gapsOf(bad); const goodGaps = gapsOf(good);
    t('ask23: ' + id + ' fires on "' + bad.slice(0, 40) + '"', Array.isArray(badGaps) && badGaps.includes(id));
    t('ask23: ' + id + ' stays quiet on its clear counterpart', Array.isArray(goodGaps) && !goodGaps.includes(id));
  }
  const ranked = runAsk(['het formulier doet het niet meer', '--json']).parsed;
  t('ask23: gaps are ranked (bug-without-symptom F9 before anchor-less reference F8 before short F3 before no-done-check F2) and the question is F9', !!ranked && ranked.gaps.join() === 'F9,F8,F3,F2' && ranked.nextQuestion.id === 'F9' && ranked.suggested_question.nl === 'Wat zie je gebeuren?');
  const outward = runAsk(['Stuur de nieuwsbrief naar alle klanten in de bestaande Mailchimp-lijst. Klaar als iedereen hem heeft.', '--json']);
  t('ask23: an outward action (F13) always gets its question — even on a CLEAR score, and exits 3 so the caller asks it (review-boss M2)', outward.r.status === 3 && !!outward.parsed && outward.parsed.verdict === 'CLEAR' && outward.parsed.nextQuestion && outward.parsed.nextQuestion.id === 'F13' && outward.parsed.suggested_question.nl === 'Moet Forge echt versturen, of eerst klaarzetten?');
  const q = outward.parsed && outward.parsed.nextQuestion;
  t('ask23: nextQuestion shape — id, nl, en, options {key, label:{nl,en}} with exactly one recommended (A) plus a way out, bilingual assume', !!q && q.nl && q.en && q.recommended === 'A' && q.options.filter((o) => o.recommended).map((o) => o.key).join() === 'A' && q.options.every((o) => isBilingual(o.label)) && q.options.some((o) => o.label.nl === 'iets anders' && o.label.en === 'something else') && isBilingual(q.assume));
  const multi = runAsk(['website en chatbot', '--json']).parsed; // VAGUE, so the top gap (F5) is asked
  t('ask23: F5 options are the detected deliverables in order (first one recommended) plus "iets anders"', !!multi && multi.nextQuestion && multi.nextQuestion.id === 'F5' && multi.nextQuestion.options.map((o) => o.key + ':' + o.label.nl + ':' + o.recommended).join('|') === 'A:website:true|B:chatbot:false|C:iets anders:false');
}

// ---- 24) wp18: skill ranking, --midrun (F12), false-positive guards, bilingual contract, live examples, the split ----
{
  const ask = (text, extra) => runAsk([text, '--json'].concat(extra || [])).parsed;
  const RANK = ['F13', 'F9', 'F8', 'F5', 'F7', 'F3', 'F4', 'F1', 'F11', 'F10', 'F6', 'F2', 'F12'];
  const inRankOrder = (gaps) => gaps.every((g, i) => RANK.includes(g) && (i === 0 || RANK.indexOf(gaps[i - 1]) < RANK.indexOf(g)));

  const r13 = ask('maak het beter en stuur het naar mijn klanten');
  t('ask24: F13 outranks F1 — nextQuestion is F13, F1 is recorded as an assumption', !!r13 && r13.gaps[0] === 'F13' && r13.gaps.includes('F1') && r13.nextQuestion.id === 'F13' && r13.assumptions.some((a) => a.id === 'F1'));
  t('ask24: the asked gap is never also recorded as an assumption', !!r13 && !r13.assumptions.some((a) => a.id === 'F13'));
  const MANY2 = 'Eigenlijk werkt mijn site niet. Pas hem aan, zet er AI in, maak alles op de website mooier en stuur het naar iedereen op Facebook.';
  const many1 = ask('Eigenlijk: mijn site werkt niet, pas hem aan en zet er AI in en maak het mooier en strakker, stuur het daarna naar iedereen.');
  const many2 = ask(MANY2);
  t('ask24: gaps follow the skill order F13 > F9 > F8 > F5 > F7 > F3 > F4 > F1 > F11 > F10 > F6 > F2 (F12 last)', !!many1 && !!many2 && many1.gaps.length >= 6 && many2.gaps.length >= 6
    && inRankOrder(many1.gaps) && inRankOrder(many2.gaps) && many1.gaps.includes('F9') && many2.gaps.includes('F7'));

  const MID = 'Laat maar, eigenlijk wil ik toch liever een webshop in plaats van de website.';
  const m0 = ask(MID);
  const f12 = m0 && m0.gapDetails.find((g) => g.id === 'F12');
  t('ask24 F12: flagged midrun:true (listed last), never the question and never an assumption without --midrun', !!f12 && f12.midrun === true && m0.gaps[m0.gaps.length - 1] === 'F12'
    && m0.gapDetails.filter((g) => g.id !== 'F12').every((g) => g.midrun === false) && (!m0.nextQuestion || m0.nextQuestion.id !== 'F12') && !m0.assumptions.some((a) => a.id === 'F12'));
  const m1 = ask(MID, ['--midrun']);
  t('ask24 F12 --midrun: ranks right after F13 and is the one question (A = finish the current work first)', !!m1 && m1.gaps[0] === 'F12' && m1.nextQuestion.id === 'F12'
    && m1.nextQuestion.options[0].label.en === 'finish the current work first' && m1.nextQuestion.options[0].recommended === true && m1.nextQuestion.options.some((o) => o.label.nl === 'iets anders'));

  const gapsOf2 = (text) => { const p = ask(text); return p ? p.gaps : []; };
  t('ask24 F7: "alles" next to a deliverable noun fires', gapsOf2('Bouw een app die alles kan voor mijn sportclub.').includes('F7'));
  t('ask24 F7: "alles" without a deliverable noun or platform stays quiet (wp6 false positive)', !gapsOf2('Controleer alles in de map en verwijder oude bestanden.').includes('F7'));
  t('ask24 F8: "weer" next to a failure verb (werkt weer niet) fires', gapsOf2('Het contactformulier werkt weer niet.').includes('F8'));
  t('ask24 F8: "weer" as "again, a new one" stays quiet', !gapsOf2('Ik wil weer een nieuwe website voor de bakkerij in Utrecht.').includes('F8'));
  t('ask24 F8: "het weer" (the weather) stays quiet', !gapsOf2('Maak een app die het weer van morgen laat zien voor fietsers.').includes('F8'));
  t('ask24 F7: Bol.com matches as a word', gapsOf2('Maak een winkel zoals Bol.com voor tweedehands boeken.').includes('F7'));
  t('ask24 F7: "bol" inside a word (bolletje, symbolen) stays quiet', !gapsOf2('Maak een pagina met een bolletje-animatie en symbolen voor mijn klanten.').includes('F7'));
  t('ask24 F13: a negated pay verb ("zonder online betalen") is not an outward action', !gapsOf2('Bouw een webshop voor mijn klanten zonder online betalen. Klaar als de productpagina werkt.').includes('F13'));
  t('ask24 F11: "sinds de update" is a noun, not a change intent', !gapsOf2('De checkout werkt niet meer sinds de update van gisteren.').includes('F11'));
  t('ask24 F4: a tech name as existing context ("in de bestaande React-app") is not a solution-instead-of-outcome', !gapsOf2('Voeg in de bestaande React-app een zoekveld toe aan de header. Klaar als het werkt.').includes('F4'));
  const silent = ask('Ik wil weer een nieuwe website voor de bakkerij in Utrecht.');
  t('ask24: F6/F2 are never the question (skill: safe defaults) — a VAGUE ask with only those falls back to the dimension question', !!silent && /^VAGUE/.test(silent.verdict)
    && silent.gaps.join() === 'F6,F2' && silent.nextQuestion === null && isBilingual(silent.suggested_question) && ['F6', 'F2'].every((id) => silent.assumptions.some((a) => a.id === id)));

  const vague = ask('maak het beter');
  t('ask24: every dimension fix is {nl, en} when failing and null when passing', !!vague && vague.dimensions.every((d) => (d.pass ? d.fix === null : isBilingual(d.fix))));
  t('ask24: suggested_question and every assumption are bilingual', !!vague && isBilingual(vague.suggested_question) && vague.assumptions.every(isBilingual));
  const jsonNoLang = (args) => { const p = runAsk(args).parsed; if (p) delete p.lang; return JSON.stringify(p); };
  t('ask24: --lang only chooses the human print — the JSON is identical apart from `lang`', jsonNoLang(['maak het beter', '--json', '--lang', 'nl']) === jsonNoLang(['maak het beter', '--json', '--lang', 'en']));
  const enHuman = runCli(['ask', 'maak het beter', '--lang', 'en']).stdout;
  t('ask24: --lang en prints the English fix for a Dutch request, and each gap assumption names its F-id', /-- Start with a concrete verb/.test(enHuman) && /\n {2}- F1: Only the look;/.test(enHuman) && /\n {2}- Assumption: /.test(enHuman));

  const ASKMOD = require('./forge-promptcheck-ask.cjs');
  const SKILL = fs.readFileSync(path.join(__dirname, '..', 'skills', 'forge-prompt-coach', 'SKILL.md'), 'utf8');
  const firstSentence = (s) => s.split('?')[0] + '?';
  const wordingDrift = ['F1', 'F2', 'F3', 'F4', 'F6', 'F9', 'F10', 'F11', 'F13'].filter((id) => {
    const g = ASKMOD.GAPS[id];
    return !['nl', 'en'].every((L) => SKILL.includes(firstSentence(g.q[L])) && SKILL.includes('A) ' + g.options[0][L] + ' B) ' + g.options[1][L] + ' C) ' + g.options[2][L]));
  });
  t('ask24: NL + EN question and A/B/C options match the forge-prompt-coach SKILL table (no-placeholder modes; drift: ' + (wordingDrift.join(',') || 'none') + ')', wordingDrift.length === 0);
  t('ask24: every F1–F13 entry is bilingual (question, options, assume) and the rank/askable sets are the skill\'s', Object.keys(ASKMOD.GAPS).length === 13
    && Object.values(ASKMOD.GAPS).every((g) => isBilingual(g.q) && isBilingual(g.assume) && (g.options === null || (g.options.length === 3 && g.options.every(isBilingual))))
    && ASKMOD.GAP_RANK.join('>') === 'F13>F9>F8>F5>F7>F3>F4>F1>F11>F10>F6>F2' && [...ASKMOD.ASKABLE].sort().join() === 'F1,F13,F3,F4,F5,F7,F8,F9');

  const KAPSALON = 'Bouw een one-page site voor kapsalon Knip in Utrecht voor buurtklanten, zodat ze via WhatsApp een afspraak maken. Klaar als de preview op mobiel werkt en de belknop werkt. Niet: online betalen.';
  const kap = runAsk([KAPSALON, '--json']);
  t('ask24 live: the research §D.1 good request is CLEAR/OK, exit 0, no question, no gaps (sentence end + "Niet:" do not fake F9/F13)', kap.r.status === 0 && !!kap.parsed
    && /^(?:CLEAR|OK)/.test(kap.parsed.verdict) && kap.parsed.nextQuestion === null && kap.parsed.gaps.length === 0);
  const d1 = runCli(['ask', MANY2, '--json', '--midrun']).stdout;
  const d2 = runCli(['ask', MANY2, '--json', '--midrun']).stdout;
  t('ask24: a many-gap request (+ --midrun) twice -> byte-identical JSON', d1.length > 0 && d1 === d2);

  const mod0 = require('./forge-promptcheck.cjs');
  t('ask24 split: forge-promptcheck.cjs re-exports the ask module API (same function objects)', mod0.scoreAsk === ASKMOD.scoreAsk && mod0.formatAskReport === ASKMOD.formatAskReport && mod0.detectAskLang === ASKMOD.detectAskLang && mod0.ASK_DIMENSION_IDS === ASKMOD.ASK_DIMENSION_IDS);
  const lineCount = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8').split('\n').length;
  t('ask24 split: both promptcheck files stay under 500 lines (' + lineCount('forge-promptcheck.cjs') + ' / ' + lineCount('forge-promptcheck-ask.cjs') + ')', lineCount('forge-promptcheck.cjs') < 500 && lineCount('forge-promptcheck-ask.cjs') < 500);
}

// ---- 22) exported pure function ----
{
  const mod = require('./forge-promptcheck.cjs');
  const direct = mod.scoreAsk(ASK_EN_CLEAR);
  t('ask22: scoreAsk is exported and matches the CLI verdict', typeof mod.scoreAsk === 'function' && direct.verdict === 'CLEAR' && direct.total === 5);
  let code = null; try { mod.scoreAsk('   '); } catch (e) { code = e.code; }
  t('ask22: scoreAsk throws EMPTY_REQUEST on whitespace (usage error, not a verdict)', code === 'EMPTY_REQUEST');
  t('ask22: scoreAsk is deterministic in-process too', JSON.stringify(mod.scoreAsk('maak het beter')) === JSON.stringify(mod.scoreAsk('maak het beter')));
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
