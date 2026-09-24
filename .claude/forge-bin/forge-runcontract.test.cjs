#!/usr/bin/env node
'use strict';
/** Hermetic tests for forge-runcontract.cjs. Uses os.mkdtemp fixtures (own temp root, never the real
 *  project's .claude/) — mirrors forge-verify.test.cjs's writeEvents() pattern. Covers BOTH the real
 *  production FORGE_HARD_RULES.json (proving the seeded non-negotiables actually work against a genuine
 *  run shape) and a small synthetic rules fixture (proving the generic block/warn/override/malformed
 *  mechanism in isolation, independent of which specific rules happen to be seeded today). */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const RC = require('./forge-runcontract.cjs');

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runcontract-test-'));
/** R6-06 (zesde herreview): check() koos de regelset vroeger via het `__dirname`-gebonden RULES_PATH,
 *  ongeacht `opts.root` — dus een run uit root B werd beoordeeld tegen de regels van installatie A. Deze
 *  fixture leunde precies op dat gedrag: een tijdelijke root zonder eigen regelbestand. Nu brengt hij zijn
 *  regels mee, zoals een echt project dat ook doet; de test toetst daarmee het bedoelde contract in plaats
 *  van een toevallige fallback. */
fs.mkdirSync(path.join(TMP, '.claude', 'config', 'orchestration'), { recursive: true });
fs.copyFileSync(path.join(__dirname, '..', 'config', 'orchestration', 'FORGE_HARD_RULES.json'),
  path.join(TMP, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json'));
// A minimal REAL writer at TMP's canonical <root>/.claude/forge-dashboard/log-event.cjs path, so any
// --log-event/logEvent:true call against TMP that does NOT pass an explicit opts.logEventPath override has
// a genuinely working writer to succeed against (RC-PROOF-WRITE-SILENT, 2026-09-24: a failed write now
// gates the CLI's exit code — a test proving "the flag is accepted" needs a writer that actually accepts).
// PART 6 below overwrites this same path with its OWN capture-based writer for its own root-containment
// assertions; both shapes are equivalent (append argv[2] to a capture file, implicit exit 0).
fs.mkdirSync(path.join(TMP, '.claude', 'forge-dashboard'), { recursive: true });
const DEFAULT_WRITER_CAPTURE = path.join(TMP, '.claude', 'forge-dashboard', 'captured-default-writer.jsonl');
fs.writeFileSync(path.join(TMP, '.claude', 'forge-dashboard', 'log-event.cjs'), [
  "const fs=require('fs');",
  "fs.appendFileSync(" + JSON.stringify(DEFAULT_WRITER_CAPTURE) + ", process.argv[2] + '\\n');",
].join('\n'), 'utf8');
console.log('forge-runcontract offline tests (hermetic root=' + TMP + ')');

function writeRun(runId, lines, extraFiles) {
  const dir = path.join(TMP, '.claude', 'forge-runs', runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), lines.join('\n') + '\n', 'utf8');
  for (const name of Object.keys(extraFiles || {})) fs.writeFileSync(path.join(dir, name), extraFiles[name], 'utf8');
  return dir;
}
const ev = (o) => JSON.stringify(o);
// legacy (RETIRED, V9-fix 2026-07-22) free-text agent_note "override:<ruleId>" convention — kept ONLY to
// prove it no longer clears anything (break-swarm DEFECT 2's exact forged-note repro), never used as a real
// override anywhere below.
const note = (ruleId, extra) => ev(Object.assign({ event_type: 'agent_note', agent: 'orchestrator', note: 'override:' + ruleId + (extra ? ' — ' + extra : '') }));
// the ONLY real override mechanism post-fix: a structured, attributed owner_override event.
const ownerOverride = (ruleId, reason, by) => ev({ event_type: 'owner_override', rule: ruleId, reason, by: (by === undefined ? 'owner' : by) });
// a path that never resolves to a real file, so tests are hermetic against loadOwnerAllowlist()'s
// FORGE_OWNER_PROFILE.json fallback read regardless of what the real project's copy contains today.
const NO_OWNER_PROFILE = path.join(TMP, 'no-such-owner-profile.json');

// ================================================================================================
// PART 1 — the REAL production FORGE_HARD_RULES.json against genuine run shapes
// ================================================================================================

// ---- a run satisfying every "always" rule (no domain passed -> web/correctness-critical rules don't apply) ----
const completeEvents = [
  ev({ event_type: 'memory_loaded', agent: 'orchestrator' }),
  ev({ event_type: 'owner_prefs_loaded', agent: 'orchestrator' }),
  ev({ event_type: 'research_done', agent: 'orchestrator', note: 'searched existing implementations first' }),
  ev({ event_type: 'prd_generated', agent: 'orchestrator' }),
  ev({ event_type: 'agent_started', agent: 'Build Boss' }),
  ev({ event_type: 'zero_console_errors_noted', agent: 'UI Boss' }),
  ev({ event_type: 'check_passed', agent: 'Test Boss', task: 'suite' }),
  ev({ event_type: 'agent_completed', agent: 'Build Boss' }),
];
writeRun('run-complete', completeEvents, { 'final-report.md': '# Report\n', 'run.json': '{}' });
const complete = RC.check({ run_id: 'run-complete' }, { root: TMP });
t('complete run: ok:true', complete.ok === true);
t('complete run: no missing rules', complete.missing.length === 0);
t('complete run: all 8 always-rules satisfied', complete.satisfied.length === 8);
t('complete run: satisfied includes report-present (real final-report.md file)', complete.satisfied.includes('report-present'));

// ---- missing owner_prefs_loaded specifically (isolate the axis — everything else present) ----
const missingPrefsEvents = completeEvents.filter((line) => !line.includes('"owner_prefs_loaded"'));
writeRun('run-missing-prefs', missingPrefsEvents, { 'final-report.md': '# Report\n' });
const missingPrefs = RC.check({ run_id: 'run-missing-prefs' }, { root: TMP });
t('run missing owner_prefs_loaded: ok:false', missingPrefs.ok === false);
t('run missing owner_prefs_loaded: names the rule "owner-prefs-loaded" in missing[]', missingPrefs.missing.length === 1 && missingPrefs.missing[0] === 'owner-prefs-loaded');
t('run missing owner_prefs_loaded: the other 7 always-rules still satisfied', missingPrefs.satisfied.length === 7);

// ---- the same missing-prefs run, but with a real structured owner_override event for exactly that rule ----
const overriddenEvents = missingPrefsEvents.concat([ownerOverride('owner-prefs-loaded', 'owner explicitly reviewed and waived the prefs echo for this smoke test run')]);
writeRun('run-overridden-prefs', overriddenEvents, { 'final-report.md': '# Report\n' });
const overriddenResult = RC.check({ run_id: 'run-overridden-prefs' }, { root: TMP, ownerProfilePath: NO_OWNER_PROFILE });
t('overridden run: ok:true (a valid owner_override neutralizes the missing block-rule)', overriddenResult.ok === true);
t('overridden run: missing[] is empty', overriddenResult.missing.length === 0);
t('overridden run: overridden[] lists owner-prefs-loaded with the real reason/by', overriddenResult.overridden.length === 1 &&
  overriddenResult.overridden[0].id === 'owner-prefs-loaded' && overriddenResult.overridden[0].by === 'owner' &&
  /owner explicitly reviewed/.test(overriddenResult.overridden[0].reason));

// ---- web domain run WITHOUT responsive screenshot evidence -> NOT DONE ----
writeRun('run-web-missing', completeEvents, { 'final-report.md': '# Report\n' });
const webMissing = RC.check({ run_id: 'run-web-missing', domain: 'website' }, { root: TMP });
t('web run without responsive evidence: ok:false (NOT DONE)', webMissing.ok === false);
t('web run without responsive evidence: names web-responsive-evidence in missing[]', webMissing.missing.includes('web-responsive-evidence'));

// ---- web domain run WITH real responsive screenshot evidence (domain_aware path via forge-verify) ----
// RC-DOMAIN-BYPASS (2026-09-24): web-responsive-evidence is now AUTHORITATIVE on a real "web" domain —
// the claimed screenshot artifacts must genuinely EXIST under the run directory (forge-evidence.cjs's
// artifactsOnDisk()), not merely be named in an event. The fixture writes the real files it claims.
const webSatisfiedEvents = completeEvents.concat([
  ev({ event_type: 'browser_screenshot_captured', agent: 'UI Boss', screenshot_path: 'artifacts/mobile-390.png' }),
  ev({ event_type: 'browser_screenshot_captured', agent: 'UI Boss', screenshot_path: 'artifacts/tablet-768.png' }),
  ev({ event_type: 'browser_screenshot_captured', agent: 'UI Boss', screenshot_path: 'artifacts/desktop-1440.png' }),
]);
const webSatisfiedDir = writeRun('run-web-satisfied', webSatisfiedEvents, { 'final-report.md': '# Report\n' });
fs.mkdirSync(path.join(webSatisfiedDir, 'artifacts'), { recursive: true });
for (const name of ['mobile-390.png', 'tablet-768.png', 'desktop-1440.png']) {
  fs.writeFileSync(path.join(webSatisfiedDir, 'artifacts', name), 'fake-png-bytes-' + name);
}
const webSatisfied = RC.check({ run_id: 'run-web-satisfied', domain: 'website' }, { root: TMP });
t('web run WITH real 3-breakpoint screenshots + zero-console-errors: ok:true', webSatisfied.ok === true);
t('web run WITH real evidence: web-responsive-evidence is satisfied (domain_aware path)', webSatisfied.satisfied.includes('web-responsive-evidence'));

// counterweight, RC-DOMAIN-BYPASS: the SAME event shape but the claimed screenshot files do NOT actually
// exist on disk must now be REJECTED — the exact repro this finding proved ("one disproven/fabricated
// browser_screenshot_captured satisfied responsive evidence").
writeRun('run-web-fabricated', webSatisfiedEvents, { 'final-report.md': '# Report\n' }); // no artifacts/ dir written
const webFabricated = RC.check({ run_id: 'run-web-fabricated', domain: 'website' }, { root: TMP });
t('RC-DOMAIN-BYPASS: a "web" domain run whose claimed screenshots do not exist on disk is NOT satisfied', !webFabricated.satisfied.includes('web-responsive-evidence') && webFabricated.missing.includes('web-responsive-evidence'));

// ---- tooling domain run (2026-07-22 — closes the real "no tooling domain in required-evidence.json" gap
// the forge-2026-07-22-v9-selfaudit self-audit run surfaced honestly). Deliberately does NOT reuse
// completeEvents (it already carries zero_console_errors_noted, one of evidence-satisfied's GENERIC
// fallback keys, which would satisfy the rule regardless of domain and never exercise the domain_aware
// forge-verify.cjs::evidenceCheck() fallback this test exists to prove). ----
const toolingSatisfiedEvents = [
  ev({ event_type: 'memory_loaded', agent: 'orchestrator' }),
  ev({ event_type: 'owner_prefs_loaded', agent: 'orchestrator' }),
  ev({ event_type: 'research_done', agent: 'orchestrator' }),
  ev({ event_type: 'prd_generated', agent: 'orchestrator' }),
  ev({ event_type: 'agent_started', agent: 'Build Boss' }),
  ev({ event_type: 'check_passed', agent: 'Build Boss', command: 'node forge-doctor.cjs', exit_code: 0, evidence: 'forge-doctor ALL GREEN' }),
  ev({ event_type: 'audit_iteration', agent: 'Build Boss', iteration: 1, note: 'real audit-loop iteration' }),
  ev({ event_type: 'report_generated', agent: 'Build Boss', path: 'final-report.md' }),
];
writeRun('run-tooling-satisfied', toolingSatisfiedEvents, { 'final-report.md': '# Report\n' });
const toolingSatisfied = RC.check({ run_id: 'run-tooling-satisfied', domain: 'tooling' }, { root: TMP });
t('tooling-domain run WITH check_passed + audit_iteration + a real final-report path ref: ok:true (evidence-satisfied via domain_aware fallback)', toolingSatisfied.ok === true);
t('tooling-domain run WITH real evidence: evidence-satisfied lands in satisfied[]', toolingSatisfied.satisfied.includes('evidence-satisfied'));

// ---- tooling domain run with only dispatch/plan events (no verified check, no audit signal, no report-path
// event) -> evidence-satisfied genuinely missing, proving the standard actually bites a lazy run ----
const toolingLazyEvents = [
  ev({ event_type: 'memory_loaded', agent: 'orchestrator' }),
  ev({ event_type: 'owner_prefs_loaded', agent: 'orchestrator' }),
  ev({ event_type: 'research_done', agent: 'orchestrator' }),
  ev({ event_type: 'prd_generated', agent: 'orchestrator' }),
  ev({ event_type: 'agent_started', agent: 'Build Boss' }),
  ev({ event_type: 'agent_completed', agent: 'Build Boss' }),
];
writeRun('run-tooling-lazy', toolingLazyEvents, { 'final-report.md': '# Report\n' });
const toolingLazy = RC.check({ run_id: 'run-tooling-lazy', domain: 'tooling' }, { root: TMP });
t('tooling-domain lazy run (dispatch/plan only, no verified check/audit/report-path event): ok:false', toolingLazy.ok === false);
t('tooling-domain lazy run: evidence-satisfied is genuinely missing (a real final-report.md FILE exists but no EVENT references it — evidenceCheck() only ever derives artifacts from logged event fields, never a directory scan)', toolingLazy.missing.includes('evidence-satisfied'));

// ---- correctness-critical domain run, no fixtures_waived, no override -> NOT DONE ----
writeRun('run-finance-missing', completeEvents, { 'final-report.md': '# Report\n' });
const financeMissing = RC.check({ run_id: 'run-finance-missing', domain: 'finance' }, { root: TMP });
t('finance-domain run without fixtures_waived/override: ok:false', financeMissing.ok === false);
t('finance-domain run without fixtures_waived/override: names correctness-critical-fixtures', financeMissing.missing.includes('correctness-critical-fixtures'));

// ---- correctness-critical domain run WITH fixtures_waived logged -> ok:true ----
const financeWaivedEvents = completeEvents.concat([ev({ event_type: 'fixtures_waived', agent: 'orchestrator', note: 'owner accepted synthetic-only for this smoke test' })]);
writeRun('run-finance-waived', financeWaivedEvents, { 'final-report.md': '# Report\n' });
const financeWaived = RC.check({ run_id: 'run-finance-waived', domain: 'finance' }, { root: TMP });
t('finance-domain run WITH fixtures_waived: ok:true', financeWaived.ok === true);
t('finance-domain run WITH fixtures_waived: correctness-critical-fixtures satisfied', financeWaived.satisfied.includes('correctness-critical-fixtures'));

// ---- a non-web, non-correctness-critical domain (e.g. "n8n") never applies the web/fixtures rules ----
writeRun('run-n8n-domain', completeEvents, { 'final-report.md': '# Report\n' });
const n8nResult = RC.check({ run_id: 'run-n8n-domain', domain: 'n8n' }, { root: TMP });
t('n8n-domain run: ok:true (web/correctness-critical rules simply do not apply)', n8nResult.ok === true);
t('n8n-domain run: web-responsive-evidence and correctness-critical-fixtures are absent from every bucket', (() => {
  const all = n8nResult.satisfied.concat(n8nResult.missing, n8nResult.warnings, n8nResult.overridden.map((o) => o.id));
  return !all.includes('web-responsive-evidence') && !all.includes('correctness-critical-fixtures');
})());

// ================================================================================================
// V9-fix (2026-07-22) — break-swarm DEFECT 1/2/3 repros against the REAL production FORGE_HARD_RULES.json
// ================================================================================================

// ---- DEFECT 1: a 0-byte / whitespace-only final-report.md must NOT satisfy report-present ----
writeRun('run-0byte-report', completeEvents, { 'final-report.md': '' });
const zeroByteReport = RC.check({ run_id: 'run-0byte-report' }, { root: TMP });
t('DEFECT 1 repro: a 0-byte final-report.md does NOT satisfy report-present', zeroByteReport.missing.includes('report-present'));
t('DEFECT 1 repro: a 0-byte final-report.md flips the whole contract to ok:false', zeroByteReport.ok === false);

writeRun('run-whitespace-report', completeEvents, { 'final-report.md': '   \n\t  \n' });
const whitespaceReport = RC.check({ run_id: 'run-whitespace-report' }, { root: TMP });
t('DEFECT 1 repro: a whitespace-only final-report.md does NOT satisfy report-present either', whitespaceReport.missing.includes('report-present'));

// ---- DEFECT 2: a forged worker agent_note ("override:<ruleId>" substring) NO LONGER clears anything ----
const forgedNoteEvents = missingPrefsEvents.concat([
  ev({ event_type: 'agent_note', agent: 'worker-3', note: 'override:owner-prefs-loaded' }),
]);
writeRun('run-forged-worker-note', forgedNoteEvents, { 'final-report.md': '# Report\n' });
const forgedNoteResult = RC.check({ run_id: 'run-forged-worker-note' }, { root: TMP, ownerProfilePath: NO_OWNER_PROFILE });
t('DEFECT 2 repro: a forged worker agent_note "override:owner-prefs-loaded" no longer clears the rule', forgedNoteResult.missing.includes('owner-prefs-loaded'));
t('DEFECT 2 repro: the forged note produces ok:false (NOT DONE), not a silent bypass', forgedNoteResult.ok === false);
t('DEFECT 2 repro: overridden[] is empty — no note-based override is ever recognized anymore', forgedNoteResult.overridden.length === 0);

// ---- DEFECT 2 repro (worst case, the EXACT break-swarm scenario): a run with ONLY forged agent_note
// "override:<id>" text for EVERY always-rule (no real work at all) must still be honestly ok:false ----
const ALWAYS_RULE_IDS = ['memory-read', 'owner-prefs-loaded', 'research-done', 'plan-or-prd-present', 'dispatch-logged', 'evidence-satisfied', 'verify-checked', 'report-present'];
const onlyForgedNotes = ALWAYS_RULE_IDS.map((id) => ev({ event_type: 'agent_note', agent: 'worker-3', note: 'override:' + id }));
writeRun('run-only-forged-notes', onlyForgedNotes, {}); // deliberately NO final-report.md, NO real work at all
const onlyForgedResult = RC.check({ run_id: 'run-only-forged-notes' }, { root: TMP, ownerProfilePath: NO_OWNER_PROFILE });
t('DEFECT 2 repro (worst case): a run of nothing but forged agent_notes is honestly ok:false', onlyForgedResult.ok === false);
t('DEFECT 2 repro (worst case): every always-rule is genuinely missing, none silently overridden', ALWAYS_RULE_IDS.every((id) => onlyForgedResult.missing.includes(id)) && onlyForgedResult.overridden.length === 0);

// ---- DEFECT 2: a VALID structured owner_override is REJECTED when `by` is not a configured owner id ----
const wrongByEvents = missingPrefsEvents.concat([ownerOverride('owner-prefs-loaded', 'a real, substantive reason with real explanatory content', 'worker-3')]);
writeRun('run-wrong-by', wrongByEvents, { 'final-report.md': '# Report\n' });
const wrongByResult = RC.check({ run_id: 'run-wrong-by' }, { root: TMP, ownerProfilePath: NO_OWNER_PROFILE });
t('DEFECT 2: an owner_override with by:"worker-3" (not in owners_allowlist) never clears the rule', wrongByResult.missing.includes('owner-prefs-loaded') && wrongByResult.overridden.length === 0);

// ---- DEFECT 2: a valid-shaped owner_override is REJECTED when reason is blank or just the bare token ----
writeRun('run-blank-reason', missingPrefsEvents.concat([ownerOverride('owner-prefs-loaded', '   ')]), { 'final-report.md': '# Report\n' });
const blankReasonResult = RC.check({ run_id: 'run-blank-reason' }, { root: TMP, ownerProfilePath: NO_OWNER_PROFILE });
t('DEFECT 2: an owner_override with a blank reason never clears the rule', blankReasonResult.missing.includes('owner-prefs-loaded') && blankReasonResult.overridden.length === 0);

writeRun('run-bare-token-reason', missingPrefsEvents.concat([ownerOverride('owner-prefs-loaded', 'override:owner-prefs-loaded')]), { 'final-report.md': '# Report\n' });
const bareTokenReasonResult = RC.check({ run_id: 'run-bare-token-reason' }, { root: TMP, ownerProfilePath: NO_OWNER_PROFILE });
t('DEFECT 2: an owner_override whose reason is JUST the bare "override:<id>" token never clears the rule', bareTokenReasonResult.missing.includes('owner-prefs-loaded') && bareTokenReasonResult.overridden.length === 0);

writeRun('run-bare-id-reason', missingPrefsEvents.concat([ownerOverride('owner-prefs-loaded', 'owner-prefs-loaded')]), { 'final-report.md': '# Report\n' });
const bareIdReasonResult = RC.check({ run_id: 'run-bare-id-reason' }, { root: TMP, ownerProfilePath: NO_OWNER_PROFILE });
t('DEFECT 2: an owner_override whose reason is JUST the bare rule id never clears the rule', bareIdReasonResult.missing.includes('owner-prefs-loaded') && bareIdReasonResult.overridden.length === 0);

// ---- DEFECT 2: the honesty-core cannot_override rules can NEVER be cleared, even by a PERFECTLY VALID,
// correctly-attributed owner_override event ----
const CANNOT_OVERRIDE_KEY_LITERAL = {
  'memory-read': '"memory_loaded"',
  'dispatch-logged': '"agent_started"',
  'evidence-satisfied': '"zero_console_errors_noted"',
  'verify-checked': '"check_passed"',
};
for (const ruleId of Object.keys(CANNOT_OVERRIDE_KEY_LITERAL).concat(['report-present'])) {
  let gapEvents = completeEvents;
  let extraFiles = { 'final-report.md': '# Report\n' };
  if (ruleId === 'report-present') extraFiles = { 'final-report.md': '' }; // 0-byte -> genuinely missing (DEFECT 1 mechanism)
  else gapEvents = completeEvents.filter((line) => !line.includes(CANNOT_OVERRIDE_KEY_LITERAL[ruleId]));
  gapEvents = gapEvents.concat([ownerOverride(ruleId, 'owner explicitly reviewed and approved skipping this for a real, substantive reason', 'owner')]);
  const runId = 'run-cannot-override-' + ruleId;
  writeRun(runId, gapEvents, extraFiles);
  const res = RC.check({ run_id: runId }, { root: TMP, ownerProfilePath: NO_OWNER_PROFILE });
  t('DEFECT 2: cannot_override rule "' + ruleId + '" is NEVER cleared, even by a valid owner_override', res.missing.includes(ruleId) && !res.overridden.some((o) => o.id === ruleId));
}

// ---- DEFECT 3: a negating/quoted mention of "override:<ruleId>" is never even read as an override candidate
// (it isn't the required event_type/shape at all — this is automatic once free-text notes are retired, but
// proven explicitly since it was the literal break-swarm repro) ----
const negatingNoteEvents = missingPrefsEvents.concat([
  ev({ event_type: 'agent_note', agent: 'orchestrator', note: 'The team did NOT log an "override:owner-prefs-loaded" note — it is genuinely still missing.' }),
]);
writeRun('run-negating-note', negatingNoteEvents, { 'final-report.md': '# Report\n' });
const negatingResult = RC.check({ run_id: 'run-negating-note' }, { root: TMP, ownerProfilePath: NO_OWNER_PROFILE });
t('DEFECT 3 repro: a negating/quoted mention of the override token never clears the rule', negatingResult.missing.includes('owner-prefs-loaded') && negatingResult.overridden.length === 0);

// ================================================================================================
// PART 2 — synthetic rules fixture: proves the GENERIC block/warn/override/malformed mechanism,
// independent of which specific rules FORGE_HARD_RULES.json happens to seed today.
// ================================================================================================
const FIXTURE_RULES_PATH = path.join(TMP, 'fixture-rules.json');
fs.writeFileSync(FIXTURE_RULES_PATH, JSON.stringify({
  version: 1,
  owners_allowlist: ['owner'],
  rules: [
    { id: 'rule-must-signal', rule: 'test block rule', trigger: 'always', check: { type: 'event-present', key: 'signal_must' }, severity: 'block', override: 'owner_override rule:rule-must-signal', source: 'test fixture' },
    { id: 'rule-warn-signal', rule: 'test warn rule', trigger: 'always', check: { type: 'event-present', key: 'signal_warn' }, severity: 'warn', override: 'owner_override rule:rule-warn-signal', source: 'test fixture' },
    { id: 'rule-web-only', rule: 'test web-trigger rule', trigger: 'web', check: { type: 'event-present', key: 'signal_web' }, severity: 'block', override: 'owner_override rule:rule-web-only', source: 'test fixture' },
    { id: 'rule-artifact', rule: 'test artifact-present rule', trigger: 'always', check: { type: 'artifact-present', key: 'special-marker' }, severity: 'block', override: 'owner_override rule:rule-artifact', source: 'test fixture' },
  ],
}), 'utf8');

// a SEPARATE small rules fixture, used only by the isolated DEFECT 2 (cannot_override)/DEFECT 3 (prefix
// collision) tests below — kept out of FIXTURE_RULES_PATH above so it never perturbs the pre-existing
// invariants (fxA/fxB/etc. count on EXACTLY the 4 rules above being the whole rule set).
const DEFECT_RULES_PATH = path.join(TMP, 'defect-rules.json');
fs.writeFileSync(DEFECT_RULES_PATH, JSON.stringify({
  version: 1,
  owners_allowlist: ['owner'],
  rules: [
    { id: 'rule-cannot-override', rule: 'test cannot_override rule', trigger: 'always', check: { type: 'event-present', key: 'signal_cannot_override' }, severity: 'block', override: 'UN-OVERRIDABLE for this fixture', source: 'test fixture', cannot_override: true },
    { id: 'prefix-rule', rule: 'test prefix-collision SHORT rule (DEFECT 3)', trigger: 'always', check: { type: 'event-present', key: 'signal_prefix' }, severity: 'block', override: 'owner_override rule:prefix-rule', source: 'test fixture' },
    { id: 'prefix-rule-longer', rule: 'test prefix-collision LONG rule sharing "prefix-rule" as a prefix (DEFECT 3)', trigger: 'always', check: { type: 'event-present', key: 'signal_prefix_longer' }, severity: 'block', override: 'owner_override rule:prefix-rule-longer', source: 'test fixture' },
  ],
}), 'utf8');

// (a) signal_must present, signal_warn absent, no domain -> ok:true (block met), one warning
writeRun('fx-block-met-warn-missing', [
  ev({ event_type: 'signal_must' }),
], { 'special-marker.txt': 'x' });
const fxA = RC.check({ run_id: 'fx-block-met-warn-missing' }, { root: TMP, rulesPath: FIXTURE_RULES_PATH });
t('fixture: block rule met + warn rule missing -> ok:true', fxA.ok === true);
t('fixture: warn rule missing lands in warnings[], never missing[]', fxA.warnings.includes('rule-warn-signal') && !fxA.missing.includes('rule-warn-signal'));
t('fixture: artifact-present rule satisfied by a real matching filename', fxA.satisfied.includes('rule-artifact'));

// (b) signal_must ABSENT, no override -> ok:false, missing names the rule
writeRun('fx-block-missing', [
  ev({ event_type: 'signal_warn' }),
], { 'special-marker.txt': 'x' });
const fxB = RC.check({ run_id: 'fx-block-missing' }, { root: TMP, rulesPath: FIXTURE_RULES_PATH });
t('fixture: block rule missing, no override -> ok:false', fxB.ok === false);
t('fixture: missing[] names exactly "rule-must-signal"', fxB.missing.length === 1 && fxB.missing[0] === 'rule-must-signal');
t('fixture: warn rule satisfied this time (signal_warn present) — no false warning', !fxB.warnings.includes('rule-warn-signal'));

// (c) signal_must ABSENT, but only a LEGACY forged agent_note "override:rule-must-signal" -> V9-fix:
// no longer clears anything (DEFECT 2 retirement, proven again against the synthetic fixture in isolation)
writeRun('fx-block-legacy-note-ignored', [
  ev({ event_type: 'signal_warn' }),
  note('rule-must-signal', 'owner explicitly waived for this fixture'),
], { 'special-marker.txt': 'x' });
const fxLegacy = RC.check({ run_id: 'fx-block-legacy-note-ignored' }, { root: TMP, rulesPath: FIXTURE_RULES_PATH, ownerProfilePath: NO_OWNER_PROFILE });
t('fixture DEFECT 2: a legacy agent_note "override:rule-must-signal" no longer clears the rule', fxLegacy.ok === false && fxLegacy.missing.includes('rule-must-signal') && fxLegacy.overridden.length === 0);

// (c') signal_must ABSENT, but a REAL structured owner_override event -> ok:true, listed in overridden
writeRun('fx-block-overridden', [
  ev({ event_type: 'signal_warn' }),
  ownerOverride('rule-must-signal', 'owner explicitly reviewed and waived this for the fixture'),
], { 'special-marker.txt': 'x' });
const fxC = RC.check({ run_id: 'fx-block-overridden' }, { root: TMP, rulesPath: FIXTURE_RULES_PATH, ownerProfilePath: NO_OWNER_PROFILE });
t('fixture: block rule missing BUT validly owner_override-ridden -> ok:true', fxC.ok === true);
t('fixture: overridden[] lists rule-must-signal with the real reason/by', fxC.overridden.length === 1 && fxC.overridden[0].id === 'rule-must-signal' && fxC.overridden[0].by === 'owner');
t('fixture: an overridden rule never also appears in missing[]', !fxC.missing.includes('rule-must-signal'));

// (c'') cannot_override rule missing (isolated DEFECT_RULES_PATH fixture) -> a validly-shaped,
// validly-attributed owner_override STILL never clears it
writeRun('fx-cannot-override', [
  ownerOverride('rule-cannot-override', 'owner explicitly reviewed and approved skipping this for a real reason'),
], {});
const fxCannotOverride = RC.check({ run_id: 'fx-cannot-override' }, { root: TMP, rulesPath: DEFECT_RULES_PATH, ownerProfilePath: NO_OWNER_PROFILE });
t('fixture DEFECT 2: cannot_override:true rule is never cleared even by a valid owner_override', fxCannotOverride.missing.includes('rule-cannot-override') && !fxCannotOverride.overridden.some((o) => o.id === 'rule-cannot-override'));

// (c''') DEFECT 3 — prefix collision: overriding the LONGER rule id must never clear the SHORTER rule id
// that happens to be its exact string prefix (the old substring-matching bug's exact failure mode)
writeRun('fx-prefix-collision', [
  ownerOverride('prefix-rule-longer', 'owner explicitly reviewed and waived the LONGER rule only'),
], {});
const fxPrefix = RC.check({ run_id: 'fx-prefix-collision' }, { root: TMP, rulesPath: DEFECT_RULES_PATH, ownerProfilePath: NO_OWNER_PROFILE });
t('fixture DEFECT 3: overriding "prefix-rule-longer" clears only that exact rule', fxPrefix.overridden.length === 1 && fxPrefix.overridden[0].id === 'prefix-rule-longer');
t('fixture DEFECT 3: the shorter "prefix-rule" (an exact string-prefix of the overridden id) remains genuinely missing', fxPrefix.missing.includes('prefix-rule'));

// (d) artifact-present rule missing (no matching file), no override -> ok:false
writeRun('fx-artifact-missing', [
  ev({ event_type: 'signal_must' }),
  ev({ event_type: 'signal_warn' }),
], {});
const fxD = RC.check({ run_id: 'fx-artifact-missing' }, { root: TMP, rulesPath: FIXTURE_RULES_PATH });
t('fixture: artifact-present rule missing (no real file) -> ok:false', fxD.ok === false);
t('fixture: missing[] names "rule-artifact"', fxD.missing.includes('rule-artifact'));

// (e) web-trigger rule: not applied without a domain, applied+missing WITH domain:'web'
writeRun('fx-web-no-domain', [
  ev({ event_type: 'signal_must' }),
  ev({ event_type: 'signal_warn' }),
], { 'special-marker.txt': 'x' });
const fxE1 = RC.check({ run_id: 'fx-web-no-domain' }, { root: TMP, rulesPath: FIXTURE_RULES_PATH });
t('fixture: web-trigger rule does not apply when no domain is passed', !fxE1.satisfied.includes('rule-web-only') && !fxE1.missing.includes('rule-web-only'));
const fxE2 = RC.check({ run_id: 'fx-web-no-domain', domain: 'web' }, { root: TMP, rulesPath: FIXTURE_RULES_PATH });
t('fixture: web-trigger rule applies + is missing when domain:"web" is passed -> NOT DONE', fxE2.ok === false && fxE2.missing.includes('rule-web-only'));
const fxE3 = RC.check({ run_id: 'fx-web-no-domain', domain: 'website' }, { root: TMP, rulesPath: FIXTURE_RULES_PATH });
t('fixture: trigger "web" also matches domain:"website" (both accepted spellings)', fxE3.missing.includes('rule-web-only'));

// (f) malformed rules file throws (never silently swallowed)
const MALFORMED_RULES_PATH = path.join(TMP, 'malformed-rules.json');
fs.writeFileSync(MALFORMED_RULES_PATH, '{ this is not valid json,,, ', 'utf8');
let malformedThrew = null;
try { RC.check({ run_id: 'fx-block-met-warn-missing' }, { root: TMP, rulesPath: MALFORMED_RULES_PATH }); } catch (e) { malformedThrew = e; }
t('malformed rules file: check() throws', malformedThrew instanceof Error);
t('malformed rules file: error message mentions the file is not valid JSON', malformedThrew && /not valid JSON/.test(malformedThrew.message));

// (g) rules file with a structurally-invalid rule (missing severity) also throws
const BAD_SHAPE_RULES_PATH = path.join(TMP, 'bad-shape-rules.json');
fs.writeFileSync(BAD_SHAPE_RULES_PATH, JSON.stringify({ version: 1, rules: [{ id: 'x', rule: 'y', trigger: 'always', check: { type: 'event-present', key: 'z' } }] }), 'utf8');
let badShapeThrew = null;
try { RC.check({ run_id: 'fx-block-met-warn-missing' }, { root: TMP, rulesPath: BAD_SHAPE_RULES_PATH }); } catch (e) { badShapeThrew = e; }
t('rules file with a rule missing "severity": check() throws', badShapeThrew instanceof Error);

// (h) an unreadable run (no events.jsonl at all) throws — never a fabricated "clean" result
let missingRunThrew = null;
try { RC.check({ run_id: 'does-not-exist-run' }, { root: TMP }); } catch (e) { missingRunThrew = e; }
t('a run with no events.jsonl at all: check() throws (never fabricates ok:true)', missingRunThrew instanceof Error);

// ---- unit-level helpers ----
t('ruleApplies: "always" trigger applies regardless of domain (including null)', RC.ruleApplies({ trigger: 'always' }, null) === true);
t('ruleApplies: "web" trigger does not apply to an unrelated domain', RC.ruleApplies({ trigger: 'web' }, 'finance') === false);
t('ruleApplies: "domain:finance" trigger applies only to that exact domain', RC.ruleApplies({ trigger: 'domain:finance' }, 'finance') === true && RC.ruleApplies({ trigger: 'domain:finance' }, 'data') === false);
t('hasEvent: case-insensitive event_type match', RC.hasEvent([{ event_type: 'Research_Done' }], 'research_done') === true);
t('hasArtifact: case-insensitive substring match (legacy string[] input, treated as already-known-non-empty)', RC.hasArtifact(['FINAL-REPORT.MD'], 'final-report') === true);
// 12 sinds 2026-08-09: `independent-verification` erbij (research-lane A — zelf-goedkeuring was
// mogelijk op de un-overridable honesty-core; RED-baseline in red-baseline-imp001.txt).
t('listRules: production FORGE_HARD_RULES.json has exactly 12 seeded rules', RC.listRules({}).length === 12, String(RC.listRules({}).length));
t('listRules: de honesty-core bevat de independent-verification-regel', RC.listRules({}).some((r) => r.id === 'independent-verification' && r.check.type === 'independent-verification'));

// ---- unit-level helpers: V9-fix DEFECT 1/2/3 pure-function proof ----
t('DEFECT 1: hasArtifact rejects an object-shaped artifact with nonEmpty:false, accepts nonEmpty:true', RC.hasArtifact([{ name: 'FINAL-REPORT.MD', nonEmpty: false }], 'final-report') === false && RC.hasArtifact([{ name: 'FINAL-REPORT.MD', nonEmpty: true }], 'final-report') === true);
t('DEFECT 1: listRunArtifacts tags a real 0-byte file nonEmpty:false', (() => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runcontract-artifact-'));
  fs.writeFileSync(path.join(d, 'final-report.md'), '');
  const arts = RC.listRunArtifacts(d);
  return arts.length === 1 && arts[0].name === 'final-report.md' && arts[0].nonEmpty === false;
})());
t('DEFECT 1: listRunArtifacts tags a real non-empty file nonEmpty:true', (() => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runcontract-artifact2-'));
  fs.writeFileSync(path.join(d, 'final-report.md'), '# real content\n');
  const arts = RC.listRunArtifacts(d);
  return arts.length === 1 && arts[0].nonEmpty === true;
})());
t('DEFECT 2: isMeaningfulReason rejects blank, bare-token, and bare rule-id reasons', RC.isMeaningfulReason('', 'x') === false && RC.isMeaningfulReason('   ', 'x') === false && RC.isMeaningfulReason('override:x', 'x') === false && RC.isMeaningfulReason('x', 'x') === false);
t('DEFECT 2: isMeaningfulReason accepts a real explanation, even one that also mentions the rule id', RC.isMeaningfulReason('x waived because this is a genuine 1-line typo fix', 'x') === true);
t('DEFECT 2: loadOwnerAllowlist fails CLOSED to an empty Set when nothing configures an owner id', RC.loadOwnerAllowlist({}, { ownerProfilePath: NO_OWNER_PROFILE }).size === 0);
t('DEFECT 2: loadOwnerAllowlist reads owners_allowlist case-insensitively', RC.loadOwnerAllowlist({ owners_allowlist: ['Owner'] }, { ownerProfilePath: NO_OWNER_PROFILE }).has('owner') === true);
t('DEFECT 3: findOwnerOverride requires an EXACT rule-id match — a longer id sharing a prefix never matches a shorter one', RC.findOwnerOverride([{ event_type: 'owner_override', rule: 'research-done-later', reason: 'a real reason with content', by: 'owner' }], 'research-done', new Set(['owner'])) === null);
t('findOwnerOverride: a genuinely matching, well-formed event resolves with the real reason/by', (() => {
  const res = RC.findOwnerOverride([{ event_type: 'owner_override', rule: 'research-done', reason: 'a real reason with content', by: 'owner' }], 'research-done', new Set(['owner']));
  return res && res.reason === 'a real reason with content' && res.by === 'owner';
})());

// ================================================================================================
// PART 3 — CLI smoke tests (spawned child process, same hermetic TMP root)
// ================================================================================================
const runCli = (...args) => spawnSync(process.execPath, [path.join(__dirname, 'forge-runcontract.cjs'), ...args], { encoding: 'utf8' });

const cliOk = runCli('check', '--run', 'run-complete', '--root', TMP, '--json');
t('CLI: exits 0 on a complete run', cliOk.status === 0);
t('CLI --json: parses and reports ok:true', (() => { try { return JSON.parse(cliOk.stdout).ok === true; } catch { return false; } })());

const cliNotDone = runCli('check', '--run', 'run-missing-prefs', '--root', TMP);
t('CLI: exits 3 on a NOT-DONE run (missing block-rule)', cliNotDone.status === 3);
t('CLI: prints the missing rule id', /MISSING owner-prefs-loaded/.test(cliNotDone.stdout));

const cliWebNotDone = runCli('check', '--run', 'run-web-missing', '--domain', 'website', '--root', TMP);
t('CLI: web run without responsive evidence exits 3', cliWebNotDone.status === 3);

const cliUsage = runCli('check', '--root', TMP);
t('CLI: missing --run prints usage and exits 2', cliUsage.status === 2 && /requires --run/.test(cliUsage.stderr));

const cliBadCmd = runCli('bogus-command');
t('CLI: unknown subcommand exits 2', cliBadCmd.status === 2);

// ================================================================================================
// PART 4 — gate_evaluated proof event (2026-08-02). MEASURED GAP this closes: forge-runcontract has
// existed, tested, and cited by FORGE_HARD_RULES.json since V9 — and across 846 real events in 31
// runs there was not ONE gate_evaluated, because nothing ever emitted it. A gate that evaluates
// silently is indistinguishable from a gate that never ran; the owner experienced that as "agents
// forget the tasks". Same one-act discipline as forge-manifest's manifest_armed: the check and its
// proof event happen together, opt-in via --log-event, spawned through the ONE real writer
// (log-event.cjs) so hash-chain/strict-validation are never bypassed. Stub via opts.logEventPath —
// the stub is REALLY spawned and its argv REALLY read back, so the wiring itself is proven.
// ================================================================================================
{
  const root = fs.mkdtempSync(path.join(TMP, 'logevent-'));
  const stub = path.join(root, 'stub-log-event.cjs');
  const capture = path.join(root, 'captured.json');
  fs.writeFileSync(stub, [
    "const fs=require('fs');",
    "fs.appendFileSync(" + JSON.stringify(capture) + ", process.argv[2] + '\\n');",
    "if (process.env.FAKE_EXIT) { console.error('stub refused'); process.exit(Number(process.env.FAKE_EXIT)); }",
  ].join('\n'), 'utf8');
  // "never spawned" must read as an honest empty capture, not a crash — the red phase of these very
  // tests IS the never-spawned state.
  const readCaptured = () => {
    if (!fs.existsSync(capture)) return [];
    return fs.readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  };

  // (1) a passing check with logEvent:true still passes AND emits exactly one gate_evaluated
  const okRes = RC.check({ run_id: 'run-complete' }, { root: TMP, logEvent: true, logEventPath: stub });
  t('check({logEvent:true}) on a complete run still reports ok:true', okRes.ok === true);
  t('check({logEvent:true}) reports the logging outcome in result.logged', !!okRes.logged && okRes.logged.ok === true);
  t('the emitted event is gate_evaluated, carries the run_id, and says the contract PASSED', (() => {
    const evs = readCaptured();
    return evs.length === 1 && evs[0].event_type === 'gate_evaluated' && evs[0].run_id === 'run-complete'
      && /pass|ok|satisfied/i.test(evs[0].note || '');
  })());

  // (2) a NOT-DONE check emits an event that NAMES the missing rules — a silent red gate teaches nothing
  const badRes = RC.check({ run_id: 'run-missing-prefs' }, { root: TMP, logEvent: true, logEventPath: stub });
  t('check({logEvent:true}) on a NOT-DONE run still reports ok:false', badRes.ok === false);
  t('the NOT-DONE event names the exact missing rule id in its note', (() => {
    const evs = readCaptured();
    const last = evs[evs.length - 1];
    return evs.length === 2 && /owner-prefs-loaded/.test(last.note || '');
  })());

  // (3) opt-in stays opt-in: without logEvent nothing is spawned (log-event.cjs default is unchanged)
  const before = readCaptured().length;
  RC.check({ run_id: 'run-complete' }, { root: TMP, logEventPath: stub });
  t('check() without logEvent emits nothing (opt-in, never the default)', readCaptured().length === before);

  // (4) a logging failure is reported honestly but NEVER flips the check verdict — the check already
  // happened; a broken logger must not turn a done run into not-done or vice versa
  const broken = RC.check({ run_id: 'run-complete' }, { root: TMP, logEvent: true, logEventPath: path.join(root, 'does-not-exist.cjs') });
  t('a failed proof-log is reported {logged.ok:false, reason} without changing ok', broken.ok === true && !!broken.logged && broken.logged.ok === false && typeof broken.logged.reason === 'string');
}

// (5) CLI: --log-event is a real flag wired to the same path (proven via env override seam or by flag
// parse alone if no seam exists — at minimum the flag must not be rejected and must appear in usage)
const cliLog = runCli('check', '--run', 'run-complete', '--root', TMP, '--log-event', '--json');
t('CLI: --log-event is accepted (exit 0 on a complete run, not a usage error)', cliLog.status === 0);
t('CLI --json with --log-event reports the logged outcome field', (() => {
  try { const j = JSON.parse(cliLog.stdout); return 'logged' in j; } catch { return false; }
})());

// ================================================================================================
// PART 5 — OWNER-PUNT B / RICHTING 2 (2026-08-03): the rule must DISCRIMINATE.
//
// MEASURED PROBLEM: `plan-or-prd-present` is an event-present rule whose key is
// ["prd_generated","mission_blueprint_created","agent_work_package_created"], and hasEvent() is
// OR-semantics — so the router's own standing instruction ("every Lead logs an
// agent_work_package_created per dispatched subagent") satisfies it on EVERY run via the CHEAPEST of
// the three. Counted over the 30 real runs in .claude/forge-runs on 2026-08-03:
// agent_work_package_created = 12 events, mission_blueprint_created = 2, prd_generated = 2. The
// expensive alternative is essentially never chosen, so a rule that fires on every run discriminates
// nothing. Heavy work must genuinely require a PRD; light work must not.
//
// The blocker richting 2 had to solve first: KNOWN_TRIGGER_LITERALS only knew
// always|web|correctness-critical plus domain:<x>, and no L-level ever reached the ctx — "only at
// L3/L4" was not even EXPRESSIBLE. Hence a new trigger form (complexity:>=L<n>) plus a real
// complexity resolver.
//
// WHERE THE LEVEL COMES FROM (measured, not assumed — see the 30 runs on 2026-08-03):
//   - run.json DOES carry it, under two different spellings: `complexity` (10 runs) and `fanout`
//     (5 runs). NO event type carries it — run_started has no level field in any of the 25 real
//     run_started events.
//   - but only 18 of 30 runs declare one at all (10 runs have no run.json whatsoever).
//   => so the level is DECLARED where available and DERIVED from measurable dispatch volume
//      otherwise, and the two are reconciled by MAX (a run cannot declare itself small to dodge a
//      rule). Both halves are reported separately so a derived level is never passed off as a
//      declared one.
// ================================================================================================

const dispatches = (n, agentPrefix) => Array.from({ length: n }, (_, i) => ev({ event_type: 'subagent_started', agent: (agentPrefix || 'Boss') + '-' + i }));

// ---- (5a) the NEW trigger form must be a VALID trigger (today loadRules() throws on it) ----
const CX_RULES_PATH = path.join(TMP, 'complexity-rules.json');
fs.writeFileSync(CX_RULES_PATH, JSON.stringify({
  version: 1,
  owners_allowlist: ['owner'],
  rules: [
    { id: 'heavy-only', rule: 'test complexity-trigger rule', trigger: 'complexity:>=L3', check: { type: 'event-present', key: 'signal_heavy' }, severity: 'block', override: 'owner_override rule:heavy-only', source: 'test fixture' },
  ],
}), 'utf8');
let cxLoadThrew = null;
try { RC.loadRules(CX_RULES_PATH); } catch (e) { cxLoadThrew = e; }
t('5a: a rule with trigger "complexity:>=L3" loads without throwing (the new trigger form is valid vocabulary)', cxLoadThrew === null);

// ---- (5b) a LIGHT run: the complexity rule simply does not apply ----
writeRun('cx-light', [ev({ event_type: 'memory_loaded' })].concat(dispatches(1)), {});
const cxLight = RC.check({ run_id: 'cx-light' }, { root: TMP, rulesPath: CX_RULES_PATH });
t('5b: on a light run the complexity:>=L3 rule lands in NO bucket (it does not apply)', (() => {
  const all = cxLight.satisfied.concat(cxLight.missing, cxLight.warnings, cxLight.overridden.map((o) => o.id));
  return !all.includes('heavy-only');
})());
t('5b: a light run is ok:true and reports complexity L1', cxLight.ok === true && cxLight.complexity === 'L1');

// ---- (5c) a HEAVY run: the same rule applies and genuinely bites ----
writeRun('cx-heavy', [ev({ event_type: 'memory_loaded' })].concat(dispatches(13)), {});
const cxHeavy = RC.check({ run_id: 'cx-heavy' }, { root: TMP, rulesPath: CX_RULES_PATH });
t('5c: on a heavy run the complexity:>=L3 rule applies and is genuinely missing -> ok:false', cxHeavy.ok === false && cxHeavy.missing.includes('heavy-only'));
t('5c: a 13-dispatch run resolves to L4 (CLAUDE.md fan-out bands: L1<=3, L2<=6, L3<=12, L4>12)', cxHeavy.complexity === 'L4');

// ---- (5d) ruleApplies() unit-level: the third (complexity) argument ----
t('5d: ruleApplies("complexity:>=L3") is true at L3 and L4, false at L1/L2', (() => {
  const r = { trigger: 'complexity:>=L3' };
  return RC.ruleApplies(r, null, 'L3') === true && RC.ruleApplies(r, null, 'L4') === true
    && RC.ruleApplies(r, null, 'L2') === false && RC.ruleApplies(r, null, 'L1') === false;
})());
t('5d: ruleApplies("complexity:>=L3") is false when NO complexity is known (same discipline as an unknown domain)', RC.ruleApplies({ trigger: 'complexity:>=L3' }, null, null) === false);
t('5d: an "always" rule is unaffected by the new third argument', RC.ruleApplies({ trigger: 'always' }, null, 'L1') === true);

// ---- (5e/5f) DECLARED level, read from run.json under BOTH real spellings measured in this repo ----
writeRun('cx-declared-complexity', [ev({ event_type: 'memory_loaded' })], { 'run.json': JSON.stringify({ run_id: 'cx-declared-complexity', complexity: 'L3' }) });
const cxDeclared = RC.check({ run_id: 'cx-declared-complexity' }, { root: TMP, rulesPath: CX_RULES_PATH });
t('5e: a declared run.json "complexity":"L3" is read and honestly labelled source:"declared"', cxDeclared.complexity === 'L3' && cxDeclared.complexity_source === 'declared' && cxDeclared.complexity_declared === 'L3');
t('5e: a declared L3 makes the complexity:>=L3 rule apply (and bite) on a run with zero dispatch events', cxDeclared.missing.includes('heavy-only'));

writeRun('cx-declared-fanout', [ev({ event_type: 'memory_loaded' })], { 'run.json': JSON.stringify({ run_id: 'cx-declared-fanout', fanout: 'L4' }) });
const cxFanout = RC.check({ run_id: 'cx-declared-fanout' }, { root: TMP, rulesPath: CX_RULES_PATH });
t('5f: the other real spelling, run.json "fanout":"L4", is read the same way', cxFanout.complexity === 'L4' && cxFanout.complexity_source === 'declared');

// ---- (5g) DERIVED level when nothing is declared — and it must SAY it is derived ----
writeRun('cx-derived', [ev({ event_type: 'memory_loaded' })].concat(dispatches(8)), {});
const cxDerived = RC.check({ run_id: 'cx-derived' }, { root: TMP, rulesPath: CX_RULES_PATH });
t('5g: with no run.json the level is DERIVED from real dispatch volume and labelled source:"derived"', cxDerived.complexity === 'L3' && cxDerived.complexity_source === 'derived' && cxDerived.complexity_declared === null);
t('5g: the derived level carries the real measured unit count as its evidence', cxDerived.complexity_units === 8 && cxDerived.complexity_derived === 'L3');

// ---- (5h) ANTI-TAMPER: declared and derived are reconciled by MAX — a run cannot declare itself
// small to dodge a rule it is measurably big enough to owe ----
writeRun('cx-understated', [ev({ event_type: 'memory_loaded' })].concat(dispatches(20)), { 'run.json': JSON.stringify({ run_id: 'cx-understated', complexity: 'L1' }) });
const cxUnderstated = RC.check({ run_id: 'cx-understated' }, { root: TMP, rulesPath: CX_RULES_PATH });
t('5h: a run declaring L1 while really dispatching 20 units is treated as L4 (max of declared/derived)', cxUnderstated.complexity === 'L4' && cxUnderstated.complexity_declared === 'L1' && cxUnderstated.complexity_derived === 'L4');
t('5h: the understating run is honestly labelled source:"derived" (the derived half is what won)', cxUnderstated.complexity_source === 'derived' && cxUnderstated.missing.includes('heavy-only'));

// ---- (5i) THE ACTUAL ASK, against the REAL production FORGE_HARD_RULES.json: a HEAVY run whose only
// plan artifact is the cheap agent_work_package_created must now be NOT DONE ----
const heavyNoPrd = completeEvents
  .filter((line) => !line.includes('"prd_generated"'))
  .concat([ev({ event_type: 'agent_work_package_created', agent: 'orchestrator', note: 'the cheap alternative' })])
  .concat(dispatches(9));
writeRun('run-heavy-no-prd', heavyNoPrd, { 'final-report.md': '# Report\n' });
const heavyNoPrdRes = RC.check({ run_id: 'run-heavy-no-prd' }, { root: TMP });
t('5i: a HEAVY run with only agent_work_package_created (no PRD) is ok:false', heavyNoPrdRes.ok === false);
t('5i: it names prd-required-for-heavy-work in missing[]', heavyNoPrdRes.missing.includes('prd-required-for-heavy-work'));
t('5i: the cheap alternative still satisfies the FLOOR rule plan-or-prd-present (the two rules are distinct)', heavyNoPrdRes.satisfied.includes('plan-or-prd-present'));

// ---- (5j) COUNTERWEIGHT against the new rule being simply "always block": the same heavy run WITH a real
// prd_generated must still be ok:true. Honest note on its red-phase status: the ok:true HALF of this
// assertion was already true before the change (the rule did not exist, so nothing could block); the
// satisfied[] half was genuinely red (a rule that does not exist can never land in satisfied[]). It is kept
// as a pair because ok:true alone is what proves the sharpened rule does not simply block every heavy run. ----
const heavyWithPrd = completeEvents.concat(dispatches(9));
writeRun('run-heavy-with-prd', heavyWithPrd, { 'final-report.md': '# Report\n' });
const heavyWithPrdRes = RC.check({ run_id: 'run-heavy-with-prd' }, { root: TMP });
// 2026-08-09: sinds independent-verification (un-overridable, >=L2) is een ZWARE run per definitie ook aan
// die regel gebonden, en deze fixture schrijft een SYNTHETISCHE, ongeketende log — daarop is subjectbinding
// onbewijsbaar, dus die regel hoort hier te ontbreken. De assertie wordt daarom PRECIEZER, niet zwakker:
// de bedoelde regel is echt satisfied, en het enige wat nog mist is exact independent-verification.
t('5j (counterweight): a heavy run WITH a real prd_generated satisfies the sharpened rule', heavyWithPrdRes.satisfied.includes('prd-required-for-heavy-work'));
t('5j (counterweight): and NOTHING else blocks it — the only remaining gap is the independent review', JSON.stringify(heavyWithPrdRes.missing) === JSON.stringify(['independent-verification']), JSON.stringify(heavyWithPrdRes.missing));

// ---- (5k) COUNTERWEIGHT (green before AND after): a LIGHT run keeps the cheap alternative — this
// change must not make every small run owe a PRD ----
const lightNoPrd = completeEvents
  .filter((line) => !line.includes('"prd_generated"'))
  .concat([ev({ event_type: 'agent_work_package_created', agent: 'orchestrator' })]);
writeRun('run-light-no-prd', lightNoPrd, { 'final-report.md': '# Report\n' });
const lightNoPrdRes = RC.check({ run_id: 'run-light-no-prd' }, { root: TMP });
t('5k (counterweight): a LIGHT run with only agent_work_package_created stays ok:true', lightNoPrdRes.ok === true);
t('5k (counterweight): prd-required-for-heavy-work lands in NO bucket on a light run', (() => {
  const all = lightNoPrdRes.satisfied.concat(lightNoPrdRes.missing, lightNoPrdRes.warnings, lightNoPrdRes.overridden.map((o) => o.id));
  return !all.includes('prd-required-for-heavy-work');
})());

// ---- (5l) the owner_override escape hatch must stay USABLE on the newly-sharpened rule ----
const heavyOverridden = heavyNoPrd.concat([ownerOverride('prd-required-for-heavy-work', 'owner reviewed: this L3 run is 9 mechanical file moves against an already-approved plan, a PRD adds nothing')]);
writeRun('run-heavy-overridden', heavyOverridden, { 'final-report.md': '# Report\n' });
const heavyOverriddenRes = RC.check({ run_id: 'run-heavy-overridden' }, { root: TMP, ownerProfilePath: NO_OWNER_PROFILE });
t('5l: a valid owner_override clears prd-required-for-heavy-work', heavyOverriddenRes.overridden.some((o) => o.id === 'prd-required-for-heavy-work') && !heavyOverriddenRes.missing.includes('prd-required-for-heavy-work'));
// en tegelijk het bewijs dat de escape hatch NIET universeel is: independent-verification draagt
// cannot_override:true en blijft dus staan waar prd-required-for-heavy-work verdwijnt.
t('5l: but the same hatch does NOT clear the un-overridable honesty-core rule', heavyOverriddenRes.missing.includes('independent-verification') && !heavyOverriddenRes.overridden.some((o) => o.id === 'independent-verification'));
t('5l: the override is reported with the real reason/by, never silently dropped', heavyOverriddenRes.overridden.some((o) => o.id === 'prd-required-for-heavy-work' && o.by === 'owner' && /mechanical file moves/.test(o.reason)));
t('5l: prd-required-for-heavy-work is NOT flagged cannot_override (the escape hatch must exist)', RC.listRules({}).some((r) => r.id === 'prd-required-for-heavy-work' && r.cannot_override !== true));

// ---- (5m/5n) THE FLEET BREAK-POINT: forge-sync.cjs ships config/orchestration/FORGE_HARD_RULES.json and
// forge-bin/forge-runcontract.cjs to 12 projects as separate files, so one half can lag the other. Today
// loadRules() THROWS on any trigger it does not know, which turns a version skew into a hard crash instead
// of an honest degrade. A well-formed but UNKNOWN trigger must be reported and skipped, never crash. ----
const UNKNOWN_TRIGGER_RULES_PATH = path.join(TMP, 'unknown-trigger-rules.json');
fs.writeFileSync(UNKNOWN_TRIGGER_RULES_PATH, JSON.stringify({
  version: 1,
  owners_allowlist: ['owner'],
  rules: [
    { id: 'from-the-future', rule: 'a rule using trigger vocabulary this checker predates', trigger: 'phase:beta', check: { type: 'event-present', key: 'signal_future' }, severity: 'block', override: 'owner_override rule:from-the-future', source: 'test fixture' },
    { id: 'ordinary-rule', rule: 'an ordinary rule in the same file', trigger: 'always', check: { type: 'event-present', key: 'signal_must' }, severity: 'block', override: 'owner_override rule:ordinary-rule', source: 'test fixture' },
  ],
}), 'utf8');
let unknownTriggerThrew = null, unknownTriggerRes = null;
try { unknownTriggerRes = RC.check({ run_id: 'fx-block-met-warn-missing' }, { root: TMP, rulesPath: UNKNOWN_TRIGGER_RULES_PATH }); } catch (e) { unknownTriggerThrew = e; }
t('5m: an unknown-but-well-formed trigger does NOT crash check() (a stale synced rules file degrades, never hard-fails)', unknownTriggerThrew === null);
t('5m: the un-judgeable rule is reported in unevaluated[] with its real trigger — an honest warning, not silence', !!unknownTriggerRes && unknownTriggerRes.unevaluated.some((u) => u.id === 'from-the-future' && u.trigger === 'phase:beta'));
t('5m: the un-judgeable rule appears in NO verdict bucket (it was never judged, so it is neither met nor missing)', (() => {
  if (!unknownTriggerRes) return false;
  const all = unknownTriggerRes.satisfied.concat(unknownTriggerRes.missing, unknownTriggerRes.warnings, unknownTriggerRes.overridden.map((o) => o.id));
  return !all.includes('from-the-future');
})());
t('5n: the OTHER rules in the same stale file are still evaluated normally (degrade, not abandon)', !!unknownTriggerRes && unknownTriggerRes.satisfied.includes('ordinary-rule'));
// RC-UNKNOWN-RULE-GREEN (2026-09-24, out-p5.md): "degrade, not abandon" was previously read as "never
// affects ok" — but an un-judged BLOCKING obligation is exactly what "NOT DONE" means. from-the-future is
// severity:"block", so an honest degrade must still refuse CONTRACT OK, distinctly from an ordinary missing
// rule (namespaced unknown-rule:<id> in `missing`, never confused with a genuinely-evaluated-and-failed id).
t('RC-UNKNOWN-RULE-GREEN: an unevaluated BLOCKING rule prevents CONTRACT OK', !!unknownTriggerRes && unknownTriggerRes.ok === false);
t('RC-UNKNOWN-RULE-GREEN: it is reported as a distinctly-namespaced missing entry', !!unknownTriggerRes && unknownTriggerRes.missing.includes('unknown-rule:from-the-future'));

// COUNTERWEIGHT: an unevaluated ADVISORY (severity:"warn") rule with unknown vocabulary must NOT flip ok —
// only a BLOCKING obligation nobody judged makes a degrade dishonest to certify as done.
const UNKNOWN_WARN_RULES_PATH = path.join(TMP, 'unknown-trigger-warn-rules.json');
fs.writeFileSync(UNKNOWN_WARN_RULES_PATH, JSON.stringify({
  version: 1,
  rules: [
    { id: 'from-the-future-warn', rule: 'an advisory rule using future vocabulary', trigger: 'phase:beta', check: { type: 'event-present', key: 'signal_future' }, severity: 'warn', override: 'n/a', source: 'test fixture' },
    { id: 'ordinary-rule-2', rule: 'an ordinary rule in the same file', trigger: 'always', check: { type: 'event-present', key: 'signal_must' }, severity: 'block', override: 'owner_override rule:ordinary-rule-2', source: 'test fixture' },
  ],
}), 'utf8');
const unknownWarnRes = RC.check({ run_id: 'fx-block-met-warn-missing' }, { root: TMP, rulesPath: UNKNOWN_WARN_RULES_PATH });
t('RC-UNKNOWN-RULE-GREEN counterweight: an unevaluated ADVISORY rule does not flip ok', unknownWarnRes.ok === true && unknownWarnRes.satisfied.includes('ordinary-rule-2'));
t('RC-UNKNOWN-RULE-GREEN counterweight: it is still visible in unevaluated[], never silent', unknownWarnRes.unevaluated.some((u) => u.id === 'from-the-future-warn'));

// ---- (5o) COUNTERWEIGHT (green before AND after): tolerance is limited to UNKNOWN VOCABULARY. A
// structurally broken trigger (missing / not a string / empty) is still a malformed config and still throws.
// Without this, "degrade gracefully" would quietly become "accept anything". ----
for (const bad of [undefined, null, 42, '', '   ', 'domain:']) {
  const p = path.join(TMP, 'bad-trigger-' + String(bad).replace(/\W/g, '_') + '.json');
  fs.writeFileSync(p, JSON.stringify({ version: 1, rules: [{ id: 'x', rule: 'y', trigger: bad, check: { type: 'event-present', key: 'z' }, severity: 'block', override: 'o', source: 's' }] }), 'utf8');
  let threw = null;
  try { RC.loadRules(p); } catch (e) { threw = e; }
  t('5o (counterweight): a structurally invalid trigger (' + JSON.stringify(bad) + ') still throws — tolerance covers unknown vocabulary only', threw instanceof Error);
}

// ---- (5p) params.complexity: an explicit caller-provided level, also reconciled by MAX ----
const cxParam = RC.check({ run_id: 'cx-light', complexity: 'L4' }, { root: TMP, rulesPath: CX_RULES_PATH });
t('5p: an explicit params.complexity is honoured and labelled source:"param"', cxParam.complexity === 'L4' && cxParam.complexity_source === 'param' && cxParam.missing.includes('heavy-only'));
const cxParamTooLow = RC.check({ run_id: 'cx-heavy', complexity: 'L1' }, { root: TMP, rulesPath: CX_RULES_PATH });
t('5p: an explicit params.complexity can never LOWER a measurably heavier run below its real level', cxParamTooLow.complexity === 'L4' && cxParamTooLow.missing.includes('heavy-only'));

// ---- (5q) CLI surface ----
const cliCx = runCli('check', '--run', 'cx-heavy', '--root', TMP, '--rules', CX_RULES_PATH, '--json');
t('5q: CLI --rules + a heavy run exits 3 and reports the resolved complexity in --json', (() => {
  try { const j = JSON.parse(cliCx.stdout); return cliCx.status === 3 && j.complexity === 'L4' && j.complexity_source === 'derived'; } catch { return false; }
})());
const cliCxFlag = runCli('check', '--run', 'cx-light', '--root', TMP, '--rules', CX_RULES_PATH, '--complexity', 'L4', '--json');
t('5q: CLI --complexity L4 is accepted and raises the resolved level', (() => {
  try { const j = JSON.parse(cliCxFlag.stdout); return j.complexity === 'L4' && cliCxFlag.status === 3; } catch { return false; }
})());
const cliUnknown = runCli('check', '--run', 'fx-block-met-warn-missing', '--root', TMP, '--rules', UNKNOWN_TRIGGER_RULES_PATH);
// RC-UNKNOWN-RULE-GREEN: from-the-future is severity:"block", so this now exits 3 (not 0) — the CLI still
// never CRASHES on the unknown trigger, and still PRINTS it loudly; it simply no longer claims done.
t('5q: CLI on a stale rules file with an unevaluated BLOCKING rule exits 3 and PRINTS the unevaluated-rule warning (honest, not silent, not a crash)', cliUnknown.status === 3 && /unevaluated|from-the-future/.test(cliUnknown.stdout + cliUnknown.stderr));

// ================================================================================================
// PART 6 — ROOT CONTAINMENT of the gate proof event (2026-08-03). MEASURED BUG this closes: the
// --log-event writer resolved log-event.cjs via __dirname (this install's own forge-dashboard/),
// IGNORING opts.root — so every hermetic test run / doctor run / post-install validation in a
// FOREIGN root wrote a real gate_evaluated into THIS project's .claude/forge-runs/run-complete/
// (18 polluted events found 2026-08-02→03, plus one seeded into the canonical template and every
// fresh install target). The proof event must land under the SAME root the check evaluated.
// ================================================================================================
{
  const REAL_PROJECT_ROOT = path.join(__dirname, '..', '..');
  const realPolluted = path.join(REAL_PROJECT_ROOT, '.claude', 'forge-runs', 'run-complete', 'events.jsonl');
  const realLineCount = () => {
    try { return fs.readFileSync(realPolluted, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; }
  };

  // seed a REAL writer stub at the root's canonical writer path — <root>/.claude/forge-dashboard/log-event.cjs
  const rootWriterDir = path.join(TMP, '.claude', 'forge-dashboard');
  fs.mkdirSync(rootWriterDir, { recursive: true });
  const rootCapture = path.join(rootWriterDir, 'captured-by-root-writer.jsonl');
  fs.writeFileSync(path.join(rootWriterDir, 'log-event.cjs'), [
    "const fs=require('fs');",
    "fs.appendFileSync(" + JSON.stringify(rootCapture) + ", process.argv[2] + '\\n');",
  ].join('\n'), 'utf8');
  const rootCaptured = () => {
    if (!fs.existsSync(rootCapture)) return [];
    return fs.readFileSync(rootCapture, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  };

  // (6a) module form: logEvent under a foreign root resolves THAT root's writer — not this install's
  const beforeA = realLineCount();
  const resA = RC.check({ run_id: 'run-complete' }, { root: TMP, logEvent: true });
  t('6a: check({root, logEvent:true}) spawns <root>/.claude/forge-dashboard/log-event.cjs', rootCaptured().length === 1 && rootCaptured()[0].run_id === 'run-complete');
  t('6a: the logging outcome is reported ok against the root writer', !!resA.logged && resA.logged.ok === true);
  t('6a: NOTHING was written into the executing install\'s own forge-runs (cross-project leak closed)', realLineCount() === beforeA);

  // (6b) CLI form: --root + --log-event stays inside --root
  const beforeB = realLineCount();
  const cliRooted = runCli('check', '--run', 'run-complete', '--root', TMP, '--log-event', '--json');
  t('6b: CLI --root + --log-event exits 0 and logs via the root writer', cliRooted.status === 0 && rootCaptured().length === 2);
  t('6b: CLI --root + --log-event leaves the executing install\'s forge-runs untouched', realLineCount() === beforeB);

  // (6c) a root WITHOUT a writer reports {logged.ok:false} honestly — it must never silently fall
  // back to another install's writer (that fallback IS the pollution bug)
  const bareRoot = fs.mkdtempSync(path.join(TMP, 'bare-root-'));
  // "bare" slaat op de ontbrekende WRITER, niet op de regelset: sinds R6-06 hoort elke root zijn eigen
  // regels te dragen, anders zou deze test stilletijgend de regels van de uitvoerende installatie lenen.
  fs.mkdirSync(path.join(bareRoot, '.claude', 'config', 'orchestration'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'config', 'orchestration', 'FORGE_HARD_RULES.json'),
    path.join(bareRoot, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json'));
  const bareDir = path.join(bareRoot, '.claude', 'forge-runs', 'r1');
  fs.mkdirSync(bareDir, { recursive: true });
  fs.writeFileSync(path.join(bareDir, 'events.jsonl'), completeEvents.join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(bareDir, 'final-report.md'), '# r\n', 'utf8');
  const beforeC = realLineCount();
  const resC = RC.check({ run_id: 'r1' }, { root: bareRoot, logEvent: true });
  t('6c: a root without its own log-event.cjs reports logged.ok:false with a reason (no silent fallback)', !!resC.logged && resC.logged.ok === false && typeof resC.logged.reason === 'string');
  t('6c: the verdict itself is unchanged by the missing writer', resC.ok === true);
  t('6c: and still nothing leaked into the executing install\'s forge-runs', realLineCount() === beforeC);

  // RC-PROOF-WRITE-SILENT (2026-09-24, out-p5.md): a green CONTRACT OK with a REQUESTED but FAILED
  // --log-event write used to exit 0 silently in both output modes. The CLI must now refuse to call that
  // success — the requested audit proof genuinely does not exist.
  const cliNoWriterText = runCli('check', '--run', 'r1', '--root', bareRoot, '--log-event');
  t('RC-PROOF-WRITE-SILENT: a failed --log-event write makes the CLI exit nonzero even on an otherwise-green contract (text mode)', cliNoWriterText.status !== 0);
  t('RC-PROOF-WRITE-SILENT: text mode NAMES the failed proof write, not silence', /PROOF NOT LOGGED/.test(cliNoWriterText.stdout));
  const cliNoWriterJson = runCli('check', '--run', 'r1', '--root', bareRoot, '--log-event', '--json');
  t('RC-PROOF-WRITE-SILENT: a failed --log-event write makes the CLI exit nonzero (json mode)', cliNoWriterJson.status !== 0);
  t('RC-PROOF-WRITE-SILENT: json mode reports logged.ok:false', (() => {
    try { const j = JSON.parse(cliNoWriterJson.stdout); return j.logged && j.logged.ok === false; } catch { return false; }
  })());

  // (6d) an explicit opts.logEventPath still wins (the existing stub seam keeps working)
  const seamCapture = path.join(TMP, 'seam-capture.jsonl');
  const seamStub = path.join(TMP, 'seam-stub.cjs');
  fs.writeFileSync(seamStub, "require('fs').appendFileSync(" + JSON.stringify(seamCapture) + ", process.argv[2] + '\\n');", 'utf8');
  RC.check({ run_id: 'run-complete' }, { root: TMP, logEvent: true, logEventPath: seamStub });
  t('6d: an explicit logEventPath overrides root resolution (test seam preserved)', fs.existsSync(seamCapture) && rootCaptured().length === 2);
}

// ================================================================================================
// PART 7 — RC-CLAIMS-AS-PROOF / RC-DOMAIN-BYPASS / RC-MANIFEST-STALE (2026-09-24, out-p5.md)
// ================================================================================================

// ---- RC-CLAIMS-AS-PROOF: the exact counterfeit-fixture repro — every claim disproven, must exit 3 ----
{
  const disprovenEvents = completeEvents.map((line) => {
    const o = JSON.parse(line);
    o._forge_verify = { proof_verified: false };
    return ev(o);
  });
  writeRun('run-counterfeit', disprovenEvents, { 'final-report.md': '# Report\n', 'not-a-final-report.old': 'x' });
  const counterfeit = RC.check({ run_id: 'run-counterfeit' }, { root: TMP });
  t('RC-CLAIMS-AS-PROOF: seven disproven claim-events no longer satisfy their rules', counterfeit.ok === false);
  t('RC-CLAIMS-AS-PROOF: none of the disproven event-present rules land in satisfied[]', ['memory-read', 'owner-prefs-loaded', 'research-done', 'dispatch-logged'].every((id) => !counterfeit.satisfied.includes(id)));
  const cliCounterfeit = runCli('check', '--run', 'run-counterfeit', '--root', TMP);
  t('RC-CLAIMS-AS-PROOF: the CLI exits 3 on the counterfeit fixture', cliCounterfeit.status === 3);
}

// ---- RC-DOMAIN-BYPASS: domain resolved from run.json when --domain is absent ----
{
  writeRun('run-declared-domain', completeEvents, { 'final-report.md': '# Report\n', 'run.json': JSON.stringify({ domain: 'website' }) });
  const declaredNoParam = RC.check({ run_id: 'run-declared-domain' }, { root: TMP }); // no domain param at all
  t('RC-DOMAIN-BYPASS: an omitted --domain resolves from run.json instead of null', declaredNoParam.domain === 'website' && declaredNoParam.domain_source === 'declared');
  t('RC-DOMAIN-BYPASS: the resolved domain rule actually applies now (missing web-responsive-evidence)', declaredNoParam.missing.includes('web-responsive-evidence'));
  // explicit param still wins, but a genuine conflict is reported rather than silently overwritten
  const explicitOverride = RC.check({ run_id: 'run-declared-domain', domain: 'finance' }, { root: TMP });
  t('RC-DOMAIN-BYPASS: an explicit --domain still wins over the declared one', explicitOverride.domain === 'finance');
  t('RC-DOMAIN-BYPASS: the conflict is reported, not silently dropped', explicitOverride.domain_source === 'param-override' && explicitOverride.domain_declared === 'website' && explicitOverride.domain_overridden === true);
  // no conflict: explicit param matches the declared domain
  const matchingParam = RC.check({ run_id: 'run-declared-domain', domain: 'website' }, { root: TMP });
  t('RC-DOMAIN-BYPASS: a matching explicit domain is reported as "param", not an override', matchingParam.domain_source === 'param' && matchingParam.domain_overridden === false);
}

// ---- RC-MANIFEST-STALE: an armed-but-unfinished manifest package invalidates evidence-satisfied/verify-checked ----
{
  const MANIFEST = require('./forge-manifest.cjs');
  const runId = 'run-manifest-stale';
  writeRun(runId, completeEvents, { 'final-report.md': '# Report\n' });
  const before = RC.check({ run_id: runId }, { root: TMP });
  t('RC-MANIFEST-STALE setup: without any manifest, the run is a genuine ok:true baseline', before.ok === true);

  const armed = MANIFEST.arm({ run_id: runId, wps: [{ wp_id: 'wp-1', agent: 'Build Boss', narrowed_prompt: 'do the thing' }] }, { root: TMP });
  t('RC-MANIFEST-STALE setup: arm() really wrote a manifest', armed.ok === true);
  const after = RC.check({ run_id: runId }, { root: TMP });
  t('RC-MANIFEST-STALE: an armed-but-never-finished package revokes evidence-satisfied', after.ok === false && after.missing.includes('evidence-satisfied'));
  t('RC-MANIFEST-STALE: it also revokes verify-checked', after.missing.includes('verify-checked'));
  t('RC-MANIFEST-STALE: the manifest-complete detail names the outstanding package', after.rule_details['manifest-complete'] && after.rule_details['manifest-complete'].outstanding.some((o) => o.wp_id === 'wp-1'));

  // a real wp_completed event for that exact wp_id clears it
  const finishedEvents = completeEvents.concat([ev({ event_type: 'wp_completed', agent: 'Build Boss', wp_id: 'wp-1' })]);
  writeRun(runId, finishedEvents, { 'final-report.md': '# Report\n' });
  const finished = RC.check({ run_id: runId }, { root: TMP });
  t('RC-MANIFEST-STALE: a real wp_completed for the armed package restores evidence-satisfied/verify-checked', finished.ok === true);

  // an owner-authenticated skip (not a self-attributed agent waiver) also clears it, without a completion event
  const skippedLines = completeEvents.concat([ev(Object.assign(JSON.parse(ownerOverride('manifest-complete', 'wp-1 dropped after scope change, owner reviewed', 'owner')), { wp_id: 'wp-1' }))]);
  writeRun(runId, skippedLines, { 'final-report.md': '# Report\n' });
  const skipped = RC.check({ run_id: runId }, { root: TMP, ownerProfilePath: NO_OWNER_PROFILE });
  t('RC-MANIFEST-STALE: an owner-authenticated, wp_id-bound skip also clears it', skipped.ok === true);

  // an agent-attributed (non-owner) "skip" must NOT clear it — same fail-closed discipline as findOwnerOverride
  const fakeSkipLines = completeEvents.concat([ev({ event_type: 'owner_override', rule: 'manifest-complete', wp_id: 'wp-1', reason: 'I decided this is fine', by: 'Build Boss' })]);
  writeRun(runId, fakeSkipLines, { 'final-report.md': '# Report\n' });
  const fakeSkip = RC.check({ run_id: runId }, { root: TMP, ownerProfilePath: NO_OWNER_PROFILE });
  t('RC-MANIFEST-STALE: a non-owner-attributed "skip" does NOT clear the outstanding package', fakeSkip.ok === false && fakeSkip.missing.includes('evidence-satisfied'));
}

// ================================================================================================
// V21/V25 (2026-09-24 second Codex recheck, out-p7.md)
// ================================================================================================

// ---- V21: manifest LOAD FAILURES must not read as "never armed" once manifest_armed is genuinely on
// record — corrupt/deleted-after-arm both stay red; only a genuinely never-armed run is not-applicable ----
{
  const MANIFEST = require('./forge-manifest.cjs');
  const runId = 'run-v21-manifest-load-fail';
  // a real manifest_armed EVENT (not just the manifest.json file) — the discriminator manifestCompleteness
  // now consults via hasEvent(). This test's TMP root's log-event.cjs is a minimal argv-capture stub (see
  // the file header), not a real writer, so arm()'s own opt-in --log-event would not land in THIS run's
  // events.jsonl — write it the same way every other fixture in this file writes its events instead.
  const v21Events = completeEvents.concat([ev({ event_type: 'manifest_armed', agent: 'orchestrator', note: 'manifest arm: 1 work package(s) armed [wp-v21]' })]);
  writeRun(runId, v21Events, { 'final-report.md': '# Report\n' });
  const armed = MANIFEST.arm({ run_id: runId, wps: [{ wp_id: 'wp-v21', agent: 'Build Boss', narrowed_prompt: 'do the thing' }] }, { root: TMP });
  t('V21 setup: arm() really wrote a manifest', armed.ok === true);
  const manifestPath = path.join(TMP, '.claude', 'forge-runs', runId, 'manifest.json');

  fs.writeFileSync(manifestPath, '{{{not json');
  const corrupt = RC.check({ run_id: runId }, { root: TMP });
  t('V21: a CORRUPT manifest after a real manifest_armed event stays RED, not green', corrupt.ok === false && corrupt.missing.includes('evidence-satisfied'));
  t('V21: manifest-complete is applicable:true, ok:false, and names the load failure',
    !!corrupt.rule_details['manifest-complete'] && corrupt.rule_details['manifest-complete'].applicable === true
    && corrupt.rule_details['manifest-complete'].ok === false && /could not be loaded/.test(corrupt.rule_details['manifest-complete'].reason || ''));

  fs.rmSync(manifestPath, { force: true });
  const deleted = RC.check({ run_id: runId }, { root: TMP });
  t('V21: a DELETED-after-arm manifest also stays RED (never silently reclassified as "never armed")',
    deleted.ok === false && !!deleted.rule_details['manifest-complete'] && deleted.rule_details['manifest-complete'].applicable === true);

  const neverArmedRunId = 'run-v21-never-armed';
  writeRun(neverArmedRunId, completeEvents, { 'final-report.md': '# Report\n' });
  const neverArmed = RC.check({ run_id: neverArmedRunId }, { root: TMP });
  t('V21 counterweight: a run that never armed any manifest stays a genuine ok:true (not-applicable, not red)',
    neverArmed.ok === true && (!neverArmed.rule_details['manifest-complete'] || neverArmed.rule_details['manifest-complete'].applicable !== true));
}

// ---- V25: a caller --domain must not WEAKEN the declared run.json domain — the union of both domains'
// obligations applies, so a correctness-critical declared domain cannot be checked away by an override ----
{
  const runId = 'run-v25-domain-union';
  writeRun(runId, completeEvents, { 'final-report.md': '# Report\n', 'run.json': JSON.stringify({ domain: 'finance' }) });
  const declared = RC.check({ run_id: runId }, { root: TMP });
  t('V25 setup: the declared finance domain alone is genuinely red (no fixtures_waived event)', declared.ok === false && declared.missing.includes('correctness-critical-fixtures'));
  const overridden = RC.check({ run_id: runId, domain: 'api' }, { root: TMP });
  t('V25: overriding to a non-critical domain does NOT drop the declared critical-domain obligation (union, not replacement)', overridden.ok === false && overridden.missing.includes('correctness-critical-fixtures'));
  t('V25: the reported domain still reflects the explicit override (caller intent stays visible)', overridden.domain === 'api' && overridden.domain_overridden === true);

  // counterweight: a real fixtures_waived event clears it under the union too — an override can still add
  // obligations without being able to erase what the run itself declared
  const waivedEvents = completeEvents.concat([ev({ event_type: 'fixtures_waived', agent: 'orchestrator', note: 'real fixtures used, waiver logged' })]);
  writeRun(runId, waivedEvents, { 'final-report.md': '# Report\n', 'run.json': JSON.stringify({ domain: 'finance' }) });
  const waivedOverridden = RC.check({ run_id: runId, domain: 'api' }, { root: TMP });
  t('V25 counterweight: a real fixtures_waived event clears the union obligation regardless of the override', waivedOverridden.ok === true);
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
