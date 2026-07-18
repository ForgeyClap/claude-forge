#!/usr/bin/env node
'use strict';
/** Offline, hermetic tests for forge-intake.cjs (WP-INTAKE — Prompt Master intake question engine). Pure
 *  function coverage (normText/groupQuestions/assembleAll/capList/buildIntake) runs in-process; CLI
 *  behavior (exit codes, --json shape, --tier/--max/--extra, and real --run agent_note logging) is
 *  exercised via spawnSync subprocess calls against a fixture question-bank.json under one os.tmpdir()
 *  root — this file NEVER touches the real project's .claude/forge-runs/ or the real question bank.
 *  Exit 0 = all pass. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const I = require('./forge-intake.cjs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-intake-test-'));
const REAL_LOG_EVENT = path.join(__dirname, '..', 'forge-dashboard', 'log-event.cjs');
const CLI = path.join(__dirname, 'forge-intake.cjs');

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };

console.log('forge-intake offline tests (hermetic tmp=' + TMP + ')');

// ---- fixture bank (small, deliberately shaped for tier/max/extra/dedup coverage) ----
const FIXTURE_BANK = {
  version: '2026-07-13-test',
  universal: [
    { dimension: 'goal', question: 'What should this accomplish?', why: 'w1', options: ['a', 'b'], tier: 'required' },
    { dimension: 'audience', question: 'Who is the audience?', why: 'w2', options: ['x'], tier: 'required' },
    { dimension: 'references', question: 'Any references?', why: 'w3', options: [], tier: 'recommended' },
  ],
  byType: {
    website: [
      { dimension: 'design', question: 'What visual direction?', why: 'w4', options: ['edgy'], tier: 'required' },
      { dimension: 'scope', question: 'Which pages?', why: 'w5', options: [], tier: 'recommended' },
    ],
  },
};

let caseN = 0;
function caseRoot() {
  const d = path.join(TMP, 'case' + (++caseN));
  fs.mkdirSync(path.join(d, '.claude', 'config', 'intake'), { recursive: true });
  fs.writeFileSync(path.join(d, '.claude', 'config', 'intake', 'question-bank.json'), JSON.stringify(FIXTURE_BANK, null, 2));
  return d;
}
function makeLogFixture(root) {
  fs.mkdirSync(path.join(root, '.claude', 'forge-dashboard'), { recursive: true });
  fs.copyFileSync(REAL_LOG_EVENT, path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs'));
}
function eventsOf(root, runId) {
  return fs.readFileSync(path.join(root, '.claude', 'forge-runs', runId, 'events.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}
function runCli(args, root) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: root ? Object.assign({}, process.env, { FORGE_PROJECT_ROOT: root }) : process.env });
}

// ===================================================================================
// GROUP A — pure function coverage (normText, groupQuestions, assembleAll, capList, buildIntake)
// ===================================================================================
{
  t('normText: lowercases + collapses whitespace + trims', I.normText('  Any   REFERENCES?  ') === 'any references?');
  t('normText: null/undefined -> empty string', I.normText(null) === '' && I.normText(undefined) === '');

  const g = I.groupQuestions(FIXTURE_BANK.universal, 'universal');
  t('groupQuestions: required ordered before recommended', g[0].tier === 'required' && g[1].tier === 'required' && g[2].tier === 'recommended');
  t('groupQuestions: group tag applied', g.every((q) => q.group === 'universal'));
  t('groupQuestions: malformed items (no question) silently dropped, never throws', I.groupQuestions([{ dimension: 'x' }, null, 'not-an-object'], 'universal').length === 0);

  const asm = I.assembleAll(FIXTURE_BANK, 'website', []);
  t('assembleAll (known type): universal(3) THEN website(2), no typeNote', asm.items.length === 5 && asm.typeNote === null);
  t('assembleAll (known type): group order is universal,universal,universal,website,website', asm.items.map((q) => q.group).join(',') === 'universal,universal,universal,website,website');
  t('assembleAll (known type): required-before-recommended within each group', asm.items[0].tier === 'required' && asm.items[1].tier === 'required' && asm.items[2].tier === 'recommended' && asm.items[3].tier === 'required' && asm.items[4].tier === 'recommended');

  const asmUnknown = I.assembleAll(FIXTURE_BANK, 'bogus-type', []);
  t('assembleAll (unknown type): universal only', asmUnknown.items.length === 3 && asmUnknown.items.every((q) => q.group === 'universal'));
  t('assembleAll (unknown type): honest note naming the type', /unknown\/again type 'bogus-type'/.test(asmUnknown.typeNote));

  const asmOmitted = I.assembleAll(FIXTURE_BANK, '', []);
  t('assembleAll (omitted type): universal only + note says (none)', asmOmitted.items.length === 3 && /unknown\/again type '\(none\)'/.test(asmOmitted.typeNote));

  const asmExtra = I.assembleAll(FIXTURE_BANK, 'website', [
    { dimension: 'novel', question: 'What about a totally new dimension?', why: 'w6', options: [], tier: 'recommended' },
    { dimension: 'dup', question: '  what SHOULD   this accomplish?  ', why: 'dup-of-universal', tier: 'required' }, // dupes universal q1 (normalized)
  ]);
  t('assembleAll (+extra): non-duplicate extra question appended', asmExtra.items.some((q) => q.group === 'extra' && q.question === 'What about a totally new dimension?'));
  t('assembleAll (+extra): duplicate (normalized) extra question NOT added', asmExtra.items.filter((q) => I.normText(q.question) === I.normText('What should this accomplish?')).length === 1);
  t('assembleAll (+extra): total is universal(3)+website(2)+extra(1 unique)=6', asmExtra.items.length === 6);

  const cap = I.capList(asm.items, 3); // 3 required total in `asm`, 2 recommended
  t('capList: all 3 required kept, 0 recommended fit at max=3', cap.kept.length === 3 && cap.kept.every((q) => q.tier === 'required') && cap.dropped === 2);
  const cap4 = I.capList(asm.items, 4);
  t('capList: at max=4, required(3) + first recommended in original list order kept, 1 dropped',
    cap4.kept.length === 4 && cap4.dropped === 1
    && cap4.kept.map((q) => q.tier).join(',') === 'required,required,recommended,required'
    && cap4.kept[2].question === 'Any references?');

  const built = I.buildIntake(FIXTURE_BANK, { type: 'website', tier: 'all', max: null, extraQuestions: [] });
  t('buildIntake: numbers 1..N sequentially', built.questions.every((q, i) => q.n === i + 1));
  t('buildIntake: count/required/recommended add up (5/3/2)', built.count === 5 && built.required === 3 && built.recommended === 2);
}

// ===================================================================================
// GROUP B — CLI: known type -> universal THEN byType, required before recommended (test 1)
// ===================================================================================
{
  const root = caseRoot();
  const r = runCli(['--type', 'website'], root);
  t('CLI known type: exit 0', r.status === 0);
  t('CLI known type: header reports 5 vragen (3 verplicht, 2 aanbevolen)', /website · 5 vragen \(3 verplicht, 2 aanbevolen\)/.test(r.stdout));
  const lines = r.stdout.split(/\r?\n/).filter((l) => /^\d+\. \[/.test(l));
  t('CLI known type: 5 numbered question lines in correct group/tier order', lines.length === 5
    && /^1\. \[required\] \(goal\)/.test(lines[0])
    && /^2\. \[required\] \(audience\)/.test(lines[1])
    && /^3\. \[recommended\] \(references\)/.test(lines[2])
    && /^4\. \[required\] \(design\)/.test(lines[3])
    && /^5\. \[recommended\] \(scope\)/.test(lines[4]));
}

// ===================================================================================
// GROUP C — CLI: unknown/omitted type -> universal only + honest note, exit 0 (test 2)
// ===================================================================================
{
  const root = caseRoot();
  const rUnknown = runCli(['--type', 'not-a-real-type'], root);
  t('CLI unknown type: exit 0', rUnknown.status === 0);
  t('CLI unknown type: universal-only count (3 vragen)', /universal · 3 vragen \(2 verplicht, 1 aanbevolen\)/.test(rUnknown.stdout) === false && /not-a-real-type · 3 vragen \(2 verplicht, 1 aanbevolen\)/.test(rUnknown.stdout));
  t('CLI unknown type: honest note printed', /Let op: unknown\/again type 'not-a-real-type'/.test(rUnknown.stdout));

  const rOmitted = runCli([], root);
  t('CLI omitted type: exit 0', rOmitted.status === 0);
  t('CLI omitted type: universal-only header + note', /universal · 3 vragen/.test(rOmitted.stdout) && /Let op: unknown\/again type '\(none\)'/.test(rOmitted.stdout));
}

// ===================================================================================
// GROUP D — CLI: --tier required -> only required questions (test 3)
// ===================================================================================
{
  const root = caseRoot();
  const r = runCli(['--type', 'website', '--tier', 'required'], root);
  t('CLI --tier required: exit 0', r.status === 0);
  t('CLI --tier required: 3 vragen (3 verplicht, 0 aanbevolen)', /website · 3 vragen \(3 verplicht, 0 aanbevolen\)/.test(r.stdout));
  t('CLI --tier required: no [recommended] line present', !/\[recommended\]/.test(r.stdout));
}

// ===================================================================================
// GROUP E — CLI: --max N -> capped at N, required kept, honest drop count (test 4)
// ===================================================================================
{
  const root = caseRoot();
  const r3 = runCli(['--type', 'website', '--max', '3'], root);
  t('CLI --max 3: exit 0', r3.status === 0);
  t('CLI --max 3: 3 vragen, all required, drop note for 2', /website · 3 vragen \(3 verplicht, 0 aanbevolen\)/.test(r3.stdout) && /Let op: --max liet 2 aanbevolen/.test(r3.stdout));

  const r4 = runCli(['--type', 'website', '--max', '4'], root);
  t('CLI --max 4: 4 vragen (3 verplicht, 1 aanbevolen), drop note for 1', /website · 4 vragen \(3 verplicht, 1 aanbevolen\)/.test(r4.stdout) && /Let op: --max liet 1 aanbevolen/.test(r4.stdout));

  const r10 = runCli(['--type', 'website', '--max', '10'], root);
  t('CLI --max 10 (no real cap): all 5 kept, no drop note', /website · 5 vragen \(3 verplicht, 2 aanbevolen\)/.test(r10.stdout) && !/--max liet/.test(r10.stdout));
}

// ===================================================================================
// GROUP F — CLI: --extra merges + dedupes (test 5); malformed/missing --extra ignored (test 6)
// ===================================================================================
{
  const root = caseRoot();
  const extraGood = path.join(root, 'extra-good.json');
  fs.writeFileSync(extraGood, JSON.stringify([
    { dimension: 'novel', question: 'What about a totally new angle?', why: 'novel', options: ['p', 'q'], tier: 'recommended' },
    { dimension: 'dup', question: '  WHO is the   audience?  ', why: 'dup', tier: 'required' }, // dupes universal q2
  ]));
  const rExtra = runCli(['--type', 'website', '--extra', extraGood], root);
  t('CLI --extra: exit 0', rExtra.status === 0);
  t('CLI --extra: unique extra question merged (6 total: 5 base + 1 unique)', /website · 6 vragen \(3 verplicht, 3 aanbevolen\)/.test(rExtra.stdout));
  t('CLI --extra: duplicate question text NOT double-added (still exactly one "Who is the audience?" line)', (rExtra.stdout.match(/Who is the audience\?/g) || []).length === 1);
  t('CLI --extra: new question text appears exactly once', (rExtra.stdout.match(/What about a totally new angle\?/g) || []).length === 1);

  // missing --extra file
  const rMissing = runCli(['--type', 'website', '--extra', path.join(root, 'does-not-exist.json')], root);
  t('CLI --extra missing file: exit 0 (non-fatal)', rMissing.status === 0);
  t('CLI --extra missing file: falls back to base 5 questions', /website · 5 vragen \(3 verplicht, 2 aanbevolen\)/.test(rMissing.stdout));
  t('CLI --extra missing file: note on stderr, no crash', /--extra file unreadable/.test(rMissing.stderr));

  // malformed (invalid JSON) --extra file
  const extraBad = path.join(root, 'extra-bad.json');
  fs.writeFileSync(extraBad, '{not valid json');
  const rBad = runCli(['--type', 'website', '--extra', extraBad], root);
  t('CLI --extra malformed JSON: exit 0 (non-fatal)', rBad.status === 0);
  t('CLI --extra malformed JSON: falls back to base 5 questions', /website · 5 vragen \(3 verplicht, 2 aanbevolen\)/.test(rBad.stdout));
  t('CLI --extra malformed JSON: note on stderr, no crash', /--extra file is not valid JSON/.test(rBad.stderr));

  // --extra file that parses but is not an array
  const extraNotArray = path.join(root, 'extra-not-array.json');
  fs.writeFileSync(extraNotArray, JSON.stringify({ question: 'oops, this is an object not an array' }));
  const rNotArray = runCli(['--type', 'website', '--extra', extraNotArray], root);
  t('CLI --extra non-array JSON: exit 0 (non-fatal)', rNotArray.status === 0);
  t('CLI --extra non-array JSON: note on stderr naming the requirement', /--extra file must be a JSON array/.test(rNotArray.stderr));
}

// ===================================================================================
// GROUP G — CLI: missing bank -> exit 1 clear error (test 7)
// ===================================================================================
{
  const emptyRoot = path.join(TMP, 'no-bank-root');
  fs.mkdirSync(emptyRoot, { recursive: true });
  const r = runCli(['--type', 'website'], emptyRoot);
  t('CLI missing bank: exit 1', r.status === 1);
  t('CLI missing bank: clear error on stderr naming the bank', /forge-intake: cannot read question bank/.test(r.stderr));
  t('CLI missing bank: nothing printed to stdout', r.stdout.trim() === '');
}

// ===================================================================================
// GROUP H — CLI: --json shape parses with documented fields + correct counts (test 8)
// ===================================================================================
{
  const root = caseRoot();
  const r = runCli(['--type', 'website', '--json'], root);
  t('CLI --json: exit 0', r.status === 0);
  let parsed = null; try { parsed = JSON.parse(r.stdout); } catch { /* fail below */ }
  t('CLI --json: parses as valid JSON', !!parsed);
  t('CLI --json: documented top-level fields present', !!parsed && ['type', 'version', 'count', 'required', 'recommended', 'questions'].every((k) => k in parsed));
  t('CLI --json: type/version/counts correct', !!parsed && parsed.type === 'website' && parsed.version === '2026-07-13-test' && parsed.count === 5 && parsed.required === 3 && parsed.recommended === 2);
  t('CLI --json: questions[] length matches count, each carries n/group/dimension/question/why/options/tier', !!parsed && parsed.questions.length === 5
    && parsed.questions.every((q) => ['n', 'group', 'dimension', 'question', 'why', 'options', 'tier'].every((k) => k in q)));
  t('CLI --json: n is 1..5 in order', !!parsed && parsed.questions.every((q, i) => q.n === i + 1));

  // --task is surfaced when given
  const rTask = runCli(['--type', 'website', '--json', '--task', 'build a bakery site'], root);
  const parsedTask = JSON.parse(rTask.stdout);
  t('CLI --json --task: task field surfaced', parsedTask.task === 'build a bakery site');
}

// ===================================================================================
// GROUP I — CLI: --run logs exactly one agent_note (test 9); logging failure tolerated
// ===================================================================================
{
  const root = caseRoot();
  makeLogFixture(root);
  const runId = 'run-intake-1';
  const r = runCli(['--type', 'website', '--run', runId], root);
  t('CLI --run: exit 0', r.status === 0);
  t('CLI --run: the question list is still printed on stdout', /website · 5 vragen/.test(r.stdout));
  const events = eventsOf(root, runId);
  const noteEvents = events.filter((e) => e.event_type === 'agent_note');
  t('CLI --run: exactly one agent_note event appended', noteEvents.length === 1);
  const ev = noteEvents[0];
  t('CLI --run: agent/role are orchestrator/lead', ev.agent === 'orchestrator' && ev.role === 'lead');
  t('CLI --run: note names the count/type/required', ev.note === 'forge-intake: 5 intake-vragen voor type website (3 verplicht)');
  t('CLI --run: evidence points at the bank', ev.evidence === 'config/intake/question-bank.json');

  // logging-failure tolerance: no log-event.cjs present -> exit code + stdout unaffected, warning on stderr
  const brokenRoot = caseRoot();
  const rBroken = runCli(['--type', 'website', '--run', 'run-intake-2'], brokenRoot);
  t('CLI --run logging failure: exit code still 0 (list still valid)', rBroken.status === 0);
  t('CLI --run logging failure: question list still printed', /website · 5 vragen/.test(rBroken.stdout));
  t('CLI --run logging failure: warning on stderr, not swallowed', /agent_note logging failed/.test(rBroken.stderr));
}

// ===================================================================================
// GROUP J — CLI: usage errors -> exit 2 (test 10)
// ===================================================================================
{
  const root = caseRoot();
  t('CLI usage: unknown flag -> exit 2', runCli(['--bogus-flag', 'x'], root).status === 2);
  t('CLI usage: --max non-number -> exit 2', runCli(['--type', 'website', '--max', 'abc'], root).status === 2);
  t('CLI usage: --max negative -> exit 2', runCli(['--type', 'website', '--max', '-1'], root).status === 2);
  t('CLI usage: --max non-integer -> exit 2', runCli(['--type', 'website', '--max', '2.5'], root).status === 2);
  t('CLI usage: --tier invalid value -> exit 2', runCli(['--type', 'website', '--tier', 'bogus'], root).status === 2);
  const rUsage = runCli(['--bogus-flag', 'x'], root);
  t('CLI usage: usage message printed on stderr', /Usage: node forge-intake\.cjs/.test(rUsage.stderr));
  t('CLI usage: nothing printed to stdout on usage error', rUsage.stdout.trim() === '');
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
