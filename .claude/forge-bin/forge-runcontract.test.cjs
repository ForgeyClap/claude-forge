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
const webSatisfiedEvents = completeEvents.concat([
  ev({ event_type: 'browser_screenshot_captured', agent: 'UI Boss', screenshot_path: 'artifacts/mobile-390.png' }),
  ev({ event_type: 'browser_screenshot_captured', agent: 'UI Boss', screenshot_path: 'artifacts/tablet-768.png' }),
  ev({ event_type: 'browser_screenshot_captured', agent: 'UI Boss', screenshot_path: 'artifacts/desktop-1440.png' }),
]);
writeRun('run-web-satisfied', webSatisfiedEvents, { 'final-report.md': '# Report\n' });
const webSatisfied = RC.check({ run_id: 'run-web-satisfied', domain: 'website' }, { root: TMP });
t('web run WITH real 3-breakpoint screenshots + zero-console-errors: ok:true', webSatisfied.ok === true);
t('web run WITH real evidence: web-responsive-evidence is satisfied (domain_aware path)', webSatisfied.satisfied.includes('web-responsive-evidence'));

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
t('listRules: production FORGE_HARD_RULES.json has exactly 10 seeded rules', RC.listRules({}).length === 10);

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

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
