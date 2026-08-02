#!/usr/bin/env node
'use strict';
/** forge-taskcontract.test.cjs — the FAILURE SIDE of the task contract (2026-08-01).
 *
 *  Measured on 2026-08-01: `failure_conditions`, `on_stuck`, `requires_inputs` and `result_caveat` returned
 *  ZERO hits across this whole project, and `non_goals` existed in forge-prd.cjs with no verify side at all.
 *  Forge blocked on silent OMISSION (a dropped acceptance criterion) but had no vocabulary for "this result is
 *  unacceptable", no agreed behaviour when an agent gets stuck, no way to refuse a dispatch that has no input
 *  to work from, and no field for the conditions under which a green result stops holding.
 *
 *  This suite covers the four new fields and their verify sides. Hermetic: FORGE_STORE_ROOT is pointed at a
 *  throwaway .claude/ under os.tmpdir() BEFORE forge-verify.cjs is required (it resolves CLAUDE_DIR once, at
 *  require time — same escape hatch forge-verify.test.cjs and forge-store.test.cjs use). Nothing here reads or
 *  writes the real project's .claude/. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-taskcontract-'));
const CLAUDE_DIR = path.join(TMP, '.claude');
fs.mkdirSync(CLAUDE_DIR, { recursive: true });
process.env.FORGE_STORE_ROOT = CLAUDE_DIR;

const V = require('./forge-verify.cjs');
const P = require('./forge-prd.cjs');
const R = require('./forge-report.cjs');
const store = require('./forge-store.cjs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

console.log('forge-taskcontract tests (failure_conditions · non_goals · on_stuck · requires_inputs · result_caveat)');

let seq = 0;
function writeRun(events) {
  const runId = 'run-tc-' + (++seq);
  const dir = path.join(CLAUDE_DIR, 'forge-runs', runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'),
    events.map((e) => JSON.stringify(Object.assign({ ts: new Date().toISOString() }, e))).join('\n') + '\n', 'utf8');
  return { runId, dir };
}
function writePrdMeta(prdId, sections) {
  const dir = path.join(CLAUDE_DIR, 'forge-prd');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, prdId + '.meta.json'),
    JSON.stringify({ prd_id: prdId, title: prdId, sections }, null, 2) + '\n', 'utf8');
}

// =====================================================================================================
// 1) failure_conditions — the PRD side
// =====================================================================================================
t('renderPrd renders a Failure Conditions section, right after Acceptance Criteria', () => {
  const md = P.renderPrd({
    prd_id: 'prd-fc-render', title: 'FC',
    sections: {
      acceptance_criteria: [{ id: 'ac-1', text: 'the page loads' }],
      failure_conditions: [{ id: 'fc-1', text: 'looks like a generic template' }, 'broken on mobile'],
    },
  });
  assert.ok(md.includes('## Failure Conditions'), 'no Failure Conditions heading:\n' + md);
  assert.ok(md.includes('looks like a generic template') && md.includes('broken on mobile'), md);
  assert.ok(md.indexOf('## Failure Conditions') > md.indexOf('## Acceptance Criteria'),
    'Failure Conditions must sit beside the criteria it mirrors, not at the top');
  assert.ok(/\*\*fc-1\*\*/.test(md), 'an explicit id is not rendered: ' + md);
});

t('a PRD WITHOUT failure_conditions still renders and says so honestly (nothing is now mandatory)', () => {
  const md = P.renderPrd({ prd_id: 'prd-fc-absent', title: 'no fc', sections: { goal: 'ship it' } });
  assert.ok(md.includes('## Failure Conditions'), md);
  assert.ok(/## Failure Conditions\s*\n+_\(not specified\)_/.test(md),
    'a missing failure_conditions must render like every other missing section:\n' + md);
});

// =====================================================================================================
// 2) failure_conditions — the VERIFY side (a hit condition is a blocker, like a dropped requirement)
// =====================================================================================================
t('a HIT failure condition is a blocker', () => {
  writePrdMeta('prdfc1', {
    acceptance_criteria: ['the page loads'],
    failure_conditions: [{ id: 'fc-1', text: 'any file over 500 lines' }],
  });
  const { runId, dir } = writeRun([
    { event_type: 'prd_generated', agent: 'orchestrator', prd_id: 'prdfc1' },
    { event_type: 'check_failed', agent: 'Build Boss', prd_id: 'prdfc1', fc_id: 'fc-1', note: 'server.cjs is 812 lines' },
  ]);
  const res = V.checkFailureConditions(runId, { runDir: dir });
  assert.strictEqual(res.failure_hits.length, 1, JSON.stringify(res));
  const hit = res.failure_hits[0];
  assert.strictEqual(hit.severity, 'blocker', 'a hit failure condition must be a blocker, got ' + hit.severity);
  assert.strictEqual(hit.fc_id, 'fc-1');
  assert.ok(/812 lines|over 500 lines/.test(hit.description), hit.description);
});

t('an UNCHECKED failure condition is an honest note, NOT a blocker (existing runs must not break)', () => {
  writePrdMeta('prdfc2', { failure_conditions: ['animations stutter'] });
  const { runId, dir } = writeRun([{ event_type: 'prd_generated', agent: 'orchestrator', prd_id: 'prdfc2' }]);
  const res = V.checkFailureConditions(runId, { runDir: dir });
  assert.strictEqual(res.failure_hits.length, 0, 'an unchecked condition must never be a hit: ' + JSON.stringify(res.failure_hits));
  assert.strictEqual(res.unchecked.length, 1, JSON.stringify(res));
  assert.ok(/never checked|no event/i.test(res.unchecked[0].reason), res.unchecked[0].reason);
});

t('a CLEARED failure condition (check_passed against it) is neither a hit nor unchecked', () => {
  writePrdMeta('prdfc3', { failure_conditions: [{ id: 'fc-1', text: 'broken on mobile' }] });
  const { runId, dir } = writeRun([
    { event_type: 'prd_generated', agent: 'orchestrator', prd_id: 'prdfc3' },
    { event_type: 'check_passed', agent: 'QA Boss', prd_id: 'prdfc3', fc_id: 'fc-1', command: 'playwright mobile', output: '3 passed' },
  ]);
  const res = V.checkFailureConditions(runId, { runDir: dir });
  assert.strictEqual(res.failure_hits.length, 0, JSON.stringify(res.failure_hits));
  assert.strictEqual(res.unchecked.length, 0, JSON.stringify(res.unchecked));
  assert.strictEqual(res.cleared.length, 1, JSON.stringify(res));
});

t('an explicit owner decision WAIVES a hit condition and the waiver stays visible', () => {
  writePrdMeta('prdfc4', { failure_conditions: [{ id: 'fc-1', text: 'file over 500 lines' }] });
  const { runId, dir } = writeRun([
    { event_type: 'prd_generated', agent: 'orchestrator', prd_id: 'prdfc4' },
    { event_type: 'check_failed', agent: 'Build Boss', prd_id: 'prdfc4', fc_id: 'fc-1', note: '812 lines' },
    { event_type: 'decision_logged', agent: 'owner', prd_id: 'prdfc4', fc_id: 'fc-1', decision: 'accepted for this run, split next sprint', by: 'owner' },
  ]);
  const res = V.checkFailureConditions(runId, { runDir: dir });
  assert.strictEqual(res.failure_hits.length, 0, 'an owner-waived hit must not stay a blocker: ' + JSON.stringify(res.failure_hits));
  assert.strictEqual(res.waived.length, 1, JSON.stringify(res));
  assert.ok(/split next sprint/.test(res.waived[0].decision), JSON.stringify(res.waived[0]));
});

t('a bare decision_logged with no text and no attribution does NOT waive anything', () => {
  writePrdMeta('prdfc5', { failure_conditions: [{ id: 'fc-1', text: 'file over 500 lines' }] });
  const { runId, dir } = writeRun([
    { event_type: 'prd_generated', agent: 'orchestrator', prd_id: 'prdfc5' },
    { event_type: 'check_failed', agent: 'Build Boss', prd_id: 'prdfc5', fc_id: 'fc-1', note: '812 lines' },
    { event_type: 'decision_logged', prd_id: 'prdfc5', fc_id: 'fc-1' },
  ]);
  const res = V.checkFailureConditions(runId, { runDir: dir });
  assert.strictEqual(res.failure_hits.length, 1, 'an empty decision must not clear a real hit: ' + JSON.stringify(res));
});

t('a run with no PRD linked is not a failure (most historic runs predate forge-prd)', () => {
  const { runId, dir } = writeRun([{ event_type: 'run_started', agent: 'orchestrator' }]);
  const res = V.checkFailureConditions(runId, { runDir: dir });
  assert.strictEqual(res.failure_hits.length, 0);
  assert.ok(/no PRD linked/i.test(res.note), res.note);
});

t('a failure hit produces the SAME registered rework trio as a dropped acceptance criterion', () => {
  const evs = V.buildFailureEnforceEvents({ prd_id: 'p', fc_id: 'fc-1', text: 'x', description: 'd', fix_hint: 'h' });
  assert.deepStrictEqual(evs.map((e) => e.event_type),
    ['lead_review_completed', 'rework_task_created', 'rework_assigned'],
    'a new event vocabulary was invented: ' + JSON.stringify(evs.map((e) => e.event_type)));
  assert.strictEqual(evs[1].extra.fc_id, 'fc-1', 'the rework task does not name the failure condition');
});

// =====================================================================================================
// 3) non_goals — checked against what was actually delivered (ADVISORY)
// =====================================================================================================
t('a delivered file matching an explicit non-goal match term is a scope violation', () => {
  writePrdMeta('prdng1', { non_goals: [{ id: 'ng-1', text: 'no authentication in the MVP', match: ['auth', 'login'] }] });
  const { runId, dir } = writeRun([
    { event_type: 'prd_generated', agent: 'orchestrator', prd_id: 'prdng1' },
    { event_type: 'file_changed', agent: 'Build Boss', path: 'src/auth/session.ts' },
  ]);
  const res = V.checkNonGoals(runId, { runDir: dir });
  assert.strictEqual(res.scope_violations.length, 1, JSON.stringify(res));
  const v = res.scope_violations[0];
  assert.strictEqual(v.ng_id, 'ng-1');
  assert.strictEqual(v.matched_term, 'auth');
  assert.strictEqual(v.derived, false, 'an author-declared term must not be labelled derived');
  assert.strictEqual(v.severity, 'warning', 'a path keyword match is suspicion, not proof — it must not claim blocker');
});

t('a non-goal in plain prose is still checked, but its terms are labelled DERIVED', () => {
  writePrdMeta('prdng2', { non_goals: ['do not build a payments module'] });
  const { runId, dir } = writeRun([
    { event_type: 'prd_generated', agent: 'orchestrator', prd_id: 'prdng2' },
    { event_type: 'file_changed', agent: 'Build Boss', files_changed: ['app/payments/checkout.ts'] },
  ]);
  const res = V.checkNonGoals(runId, { runDir: dir });
  assert.strictEqual(res.scope_violations.length, 1, JSON.stringify(res));
  assert.strictEqual(res.scope_violations[0].derived, true, 'a term guessed from prose must say so');
  assert.strictEqual(res.scope_violations[0].matched_term, 'payments');
});

t('short/stopword-only non-goals are reported as unchecked instead of matching everything', () => {
  writePrdMeta('prdng3', { non_goals: ['not for now'] });
  const { runId, dir } = writeRun([
    { event_type: 'prd_generated', agent: 'orchestrator', prd_id: 'prdng3' },
    { event_type: 'file_changed', agent: 'Build Boss', path: 'src/index.ts' },
  ]);
  const res = V.checkNonGoals(runId, { runDir: dir });
  assert.strictEqual(res.scope_violations.length, 0, 'stopwords matched real files: ' + JSON.stringify(res.scope_violations));
  assert.strictEqual(res.unchecked.length, 1, JSON.stringify(res));
  assert.ok(/no usable|no checkable/i.test(res.unchecked[0].reason), res.unchecked[0].reason);
});

t('a run that delivers nothing outside its non-goals is clean', () => {
  writePrdMeta('prdng4', { non_goals: [{ id: 'ng-1', text: 'no auth', match: ['auth'] }] });
  const { runId, dir } = writeRun([
    { event_type: 'prd_generated', agent: 'orchestrator', prd_id: 'prdng4' },
    { event_type: 'file_changed', agent: 'Build Boss', path: 'src/landing/hero.tsx' },
  ]);
  const res = V.checkNonGoals(runId, { runDir: dir });
  assert.strictEqual(res.scope_violations.length, 0, JSON.stringify(res.scope_violations));
  assert.ok(res.delivered_paths >= 1, 'it must say how much delivered surface it actually looked at');
});

// =====================================================================================================
// 4) result_caveat — the report side
// =====================================================================================================
function block(o) { return '```forge-report\n' + JSON.stringify(o, null, 2) + '\n```'; }
const baseReport = {
  status: 'completed', work_package: 'WP-1', files_changed: ['a.cjs'],
  tests_run: 'node a.test.cjs — 3 passed', evidence: ['3 passed, 0 failed'], blockers: [], next_action: 'none',
};

t('result_caveat is accepted and carried through when present', () => {
  const r = R.parseReport(block(Object.assign({}, baseReport, { result_caveat: 'only proven on Windows/Node 22; no Linux run' })));
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  assert.strictEqual(r.report.result_caveat, 'only proven on Windows/Node 22; no Linux run');
});

t('a completed report WITHOUT result_caveat is still VALID, with an honest note (non-breaking)', () => {
  const r = R.parseReport(block(baseReport));
  assert.strictEqual(r.ok, true, 'adding the field must not invalidate every existing report: ' + JSON.stringify(r.errors));
  assert.ok(Array.isArray(r.notes), 'parseReport does not report notes at all');
  assert.ok(r.notes.some((n) => /result_caveat/.test(n)), 'the missing caveat is not mentioned: ' + JSON.stringify(r.notes));
});

t('an EMPTY result_caveat is rejected — the field must not become a rubber stamp', () => {
  const r = R.parseReport(block(Object.assign({}, baseReport, { result_caveat: '   ' })));
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /result_caveat/.test(e)), JSON.stringify(r.errors));
});

t('a non-string result_caveat is rejected', () => {
  const r = R.parseReport(block(Object.assign({}, baseReport, { result_caveat: ['a', 'b'] })));
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /result_caveat/.test(e)), JSON.stringify(r.errors));
});

t('a blocked report needs no caveat note (the blockers already carry the caveat)', () => {
  const r = R.parseReport(block(Object.assign({}, baseReport, { status: 'blocked', blockers: ['no API key'] })));
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  assert.ok(!r.notes.some((n) => /result_caveat/.test(n)), 'a blocked report should not be nagged: ' + JSON.stringify(r.notes));
});

// =====================================================================================================
// 5) on_stuck + requires_inputs — the dispatch brief
// =====================================================================================================
t('validateBrief accepts the three agreed on_stuck behaviours and nothing else', () => {
  assert.deepStrictEqual(R.BRIEF_ON_STUCK.slice().sort(), ['ask_owner', 'flagged_best_guess', 'stop_and_report']);
  for (const b of R.BRIEF_ON_STUCK) {
    assert.deepStrictEqual(R.validateBrief({ work_package: 'WP-1', on_stuck: b }), [], 'rejected a valid on_stuck: ' + b);
  }
  const errs = R.validateBrief({ work_package: 'WP-1', on_stuck: 'improvise' });
  assert.ok(errs.some((e) => /on_stuck/.test(e)), JSON.stringify(errs));
});

t('a brief without on_stuck is VALID but noted (existing dispatches keep working)', () => {
  assert.deepStrictEqual(R.validateBrief({ work_package: 'WP-1' }), []);
  const notes = R.briefNotes({ work_package: 'WP-1' });
  assert.ok(notes.some((n) => /on_stuck/.test(n)), JSON.stringify(notes));
});

t('requires_inputs must be an array of non-empty strings when present', () => {
  assert.deepStrictEqual(R.validateBrief({ work_package: 'WP-1', requires_inputs: ['prd.acceptance_criteria'] }), []);
  assert.ok(R.validateBrief({ work_package: 'WP-1', requires_inputs: 'prd.acceptance_criteria' })
    .some((e) => /requires_inputs/.test(e)));
  assert.ok(R.validateBrief({ work_package: 'WP-1', requires_inputs: ['  '] }).some((e) => /requires_inputs/.test(e)));
});

t('a dispatch is REFUSED with an explicit reason when a required input is absent from run state', () => {
  const { runId, dir } = writeRun([{ event_type: 'run_started', agent: 'orchestrator' }]);
  const res = V.checkRequiredInputs({ work_package: 'WP-9', requires_inputs: ['prd.acceptance_criteria'] }, runId, { runDir: dir });
  assert.strictEqual(res.dispatch_allowed, false, JSON.stringify(res));
  assert.strictEqual(res.missing.length, 1, JSON.stringify(res));
  assert.ok(/no PRD|not present|absent/i.test(res.missing[0].reason), res.missing[0].reason);
  assert.ok(/WP-9/.test(res.reason), 'the refusal does not name the work package: ' + res.reason);
});

t('a dispatch is ALLOWED once the required input really exists in run state', () => {
  writePrdMeta('prdri1', { acceptance_criteria: ['the page loads'] });
  const { runId, dir } = writeRun([
    { event_type: 'prd_generated', agent: 'orchestrator', prd_id: 'prdri1' },
    { event_type: 'browser_screenshot_captured', agent: 'QA Boss', screenshot_path: 'shots/home.png' },
  ]);
  const res = V.checkRequiredInputs(
    { work_package: 'WP-10', requires_inputs: ['prd.acceptance_criteria', 'event.browser_screenshot_captured.screenshot_path'] },
    runId, { runDir: dir });
  assert.strictEqual(res.dispatch_allowed, true, JSON.stringify(res));
  assert.strictEqual(res.satisfied.length, 2, JSON.stringify(res));
});

t('an event key whose field is empty counts as MISSING, not satisfied', () => {
  const { runId, dir } = writeRun([
    { event_type: 'browser_screenshot_captured', agent: 'QA Boss', screenshot_path: '' },
  ]);
  const res = V.checkRequiredInputs(
    { work_package: 'WP-11', requires_inputs: ['event.browser_screenshot_captured.screenshot_path'] }, runId, { runDir: dir });
  assert.strictEqual(res.dispatch_allowed, false, JSON.stringify(res));
});

t('a ticket key resolves against the real ticket store', () => {
  store.putEntity('tickets', 'tk-ri-1', { ticket_id: 'tk-ri-1', title: 'exists', status: 'open' });
  const { runId, dir } = writeRun([{ event_type: 'run_started' }]);
  const ok = V.checkRequiredInputs({ work_package: 'WP-12', requires_inputs: ['ticket.tk-ri-1'] }, runId, { runDir: dir });
  assert.strictEqual(ok.dispatch_allowed, true, JSON.stringify(ok));
  const bad = V.checkRequiredInputs({ work_package: 'WP-13', requires_inputs: ['ticket.tk-nope'] }, runId, { runDir: dir });
  assert.strictEqual(bad.dispatch_allowed, false, JSON.stringify(bad));
});

t('an UNRECOGNISED input key is unresolvable and BLOCKS — never silently satisfied', () => {
  const { runId, dir } = writeRun([{ event_type: 'run_started' }]);
  const res = V.checkRequiredInputs({ work_package: 'WP-14', requires_inputs: ['vibes.good'] }, runId, { runDir: dir });
  assert.strictEqual(res.dispatch_allowed, false, 'an unknown key must not read as satisfied: ' + JSON.stringify(res));
  assert.strictEqual(res.unresolvable.length, 1, JSON.stringify(res));
  assert.ok(/prd\.|event\.|ticket\./.test(res.unresolvable[0].reason), 'the reason does not say what IS supported: ' + res.unresolvable[0].reason);
});

t('a brief with no requires_inputs is allowed (nothing new is mandatory)', () => {
  const { runId, dir } = writeRun([{ event_type: 'run_started' }]);
  const res = V.checkRequiredInputs({ work_package: 'WP-15' }, runId, { runDir: dir });
  assert.strictEqual(res.dispatch_allowed, true, JSON.stringify(res));
  assert.ok(/no required inputs/i.test(res.reason), res.reason);
});

// =====================================================================================================
// 6) the gate: a hit failure condition gates like a dropped requirement; non_goals stays advisory
// =====================================================================================================
const { spawnSync } = require('child_process');
function runVerifyCli(runId) {
  return spawnSync(process.execPath, [path.join(__dirname, 'forge-verify.cjs'), runId, '--root', TMP],
    { env: Object.assign({}, process.env, { FORGE_STORE_ROOT: CLAUDE_DIR }), encoding: 'utf8' });
}

t('CLI exit 1 on a hit failure condition — a blocker, exactly like a dropped acceptance criterion', () => {
  writePrdMeta('prdgate1', { failure_conditions: [{ id: 'fc-1', text: 'bundle over 1MB' }] });
  const { runId } = writeRun([
    { event_type: 'run_started', agent: 'orchestrator' },
    { event_type: 'prd_generated', agent: 'orchestrator', prd_id: 'prdgate1' },
    { event_type: 'agent_started', agent: 'Build Boss' },
    { event_type: 'check_failed', agent: 'Build Boss', prd_id: 'prdgate1', fc_id: 'fc-1', note: 'bundle is 2.3MB' },
    { event_type: 'agent_completed', agent: 'Build Boss' },
  ]);
  const r = runVerifyCli(runId);
  assert.ok(/Failure Conditions:/.test(r.stdout), 'no Failure Conditions section:\n' + r.stdout);
  assert.ok(/BLOCKER fc=fc-1/.test(r.stdout), 'the hit is not shown as a blocker:\n' + r.stdout);
  assert.strictEqual(r.status, 1, 'a hit failure condition must gate:\n' + r.stdout);
});

// ── ISOLATION PIN (2026-08-01, independent-witness defect 2) ──────────────────────────────────────────
// The test above cannot fail. Its fixture logs `check_failed` from Build Boss and then `agent_completed`,
// which is ALSO a textbook agent mismatch (claims done with an unfinished task) — and the mismatch gate
// alone already forces exit 1. Deleting `failures.failure_hits.length === 0` from forge-verify's exit code
// left this whole suite at 30 passed / 0 failed. Measured, not assumed.
//
// This pin is the same claim made in a run where a HIT FAILURE CONDITION IS THE ONLY POSSIBLE REASON for a
// non-zero exit. Every other gate is held at zero deliberately: no ticket belongs to this run (open/unproven
// both 0), no event carries a path (isolation 0), the PRD declares no acceptance_criteria (acceptance 0),
// and — the load-bearing difference from the fixture above — the agent that logged the failed check does NOT
// claim completion, so there is no mismatch. The assertion is made against forge-verify's OWN VERIFY: line,
// so "isolated" is verified evidence rather than a comment.
// (The same property is enforced for ALL six gates, structurally, in forge-verify-gates.test.cjs.)
t('CLI exit 1 with a hit failure condition as the ONLY non-zero counter — the gate really is load-bearing', () => {
  writePrdMeta('prdgateiso', { failure_conditions: [{ id: 'fc-1', text: 'the bundle exceeds 1MB' }] });
  const { runId } = writeRun([
    { event_type: 'run_started', agent: 'orchestrator' },
    { event_type: 'prd_generated', agent: 'orchestrator', prd_id: 'prdgateiso' },
    { event_type: 'agent_started', agent: 'QA Boss' },
    { event_type: 'check_failed', agent: 'QA Boss', prd_id: 'prdgateiso', fc_id: 'fc-1', note: 'bundle is 2.3MB' },
    // NOTE: no agent_completed anywhere — that omission is what keeps the mismatch gate at zero.
  ]);
  const r = runVerifyCli(runId);
  const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith('VERIFY: '));
  assert.ok(line, 'no VERIFY: line in:\n' + r.stdout);
  assert.ok(/^VERIFY: 0 mismatch\(es\), 0 open ticket\(s\), 0 unproven done-ticket\(s\), 0 isolation violation\(s\), 0 acceptance gap\(s\), 1 failure-condition hit\(s\)/.test(line),
    'this run is NOT isolated to the failure-condition gate — some other gate is non-zero, so its exit code ' +
    'would prove nothing:\n' + line);
  assert.strictEqual(r.status, 1,
    'exit ' + r.status + ' — the failure-condition hit is the only non-zero counter, so it alone must gate. ' +
    'A red here means that clause is missing from forge-verify\'s exit code:\n' + line);
});

t('CLI stays 0 on a non-goal scope warning — advisory, never a gate', () => {
  writePrdMeta('prdgate2', { non_goals: [{ id: 'ng-1', text: 'no auth', match: ['auth'] }] });
  const { runId } = writeRun([
    { event_type: 'run_started', agent: 'orchestrator' },
    { event_type: 'prd_generated', agent: 'orchestrator', prd_id: 'prdgate2' },
    { event_type: 'agent_started', agent: 'Build Boss' },
    { event_type: 'file_changed', agent: 'Build Boss', path: path.join(TMP, 'src', 'auth', 'session.ts') },
    { event_type: 'agent_completed', agent: 'Build Boss' },
  ]);
  const r = runVerifyCli(runId);
  assert.ok(/Non-Goals \(advisory, non-blocking\):/.test(r.stdout), 'no Non-Goals section:\n' + r.stdout);
  assert.ok(/SCOPE ng=ng-1/.test(r.stdout), 'the scope warning is not shown:\n' + r.stdout);
  assert.strictEqual(r.status, 0, 'a keyword-matched scope warning must NOT gate:\n' + r.stdout);
});

t('CLI --json carries failure_condition_hits and non_goal_violations', () => {
  writePrdMeta('prdgate3', {
    failure_conditions: [{ id: 'fc-1', text: 'a' }],
    non_goals: [{ id: 'ng-1', text: 'no auth', match: ['auth'] }],
  });
  const { runId } = writeRun([
    { event_type: 'run_started', agent: 'orchestrator' },
    { event_type: 'prd_generated', agent: 'orchestrator', prd_id: 'prdgate3' },
    { event_type: 'file_changed', agent: 'Build Boss', path: 'src/auth/x.ts' },
  ]);
  const r = spawnSync(process.execPath, [path.join(__dirname, 'forge-verify.cjs'), runId, '--root', TMP, '--json'],
    { env: Object.assign({}, process.env, { FORGE_STORE_ROOT: CLAUDE_DIR }), encoding: 'utf8' });
  const j = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
  assert.ok(Array.isArray(j.failure_condition_hits), 'no failure_condition_hits in --json: ' + Object.keys(j).join(', '));
  assert.ok(Array.isArray(j.non_goal_violations), 'no non_goal_violations in --json: ' + Object.keys(j).join(', '));
  assert.strictEqual(j.non_goal_violations.length, 1, JSON.stringify(j.non_goal_violations));
  assert.strictEqual(j.failure_condition_hits.length, 0, 'an unchecked condition must not count as a hit');
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
