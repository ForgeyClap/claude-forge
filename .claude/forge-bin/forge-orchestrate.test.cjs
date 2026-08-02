#!/usr/bin/env node
'use strict';
// forge-orchestrate.test.cjs — real tests for the run-driver checklist auditor (2026-07-18, WAVE C / C5).
// Every test uses either the REAL seed file (config/orchestration/run-checklist.json, read-only, proving
// seed integrity + real-world audit behavior) or a fixture written into a fresh temp dir via
// opts.checklistPath (hermetic — no test ever writes to config/orchestration/). CLI tests spawn a real
// subprocess against the real checklist (mirrors forge-standing.test.cjs's CLI-layer proof).
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const orchestrate = require('./forge-orchestrate.cjs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

const CLI = path.join(__dirname, 'forge-orchestrate.cjs');
function runCLI(argv) { return spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' }); }

function freshDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); }
function writeChecklist(steps, extra) {
  const dir = freshDir('forge-orchestrate-fixture');
  const p = path.join(dir, 'run-checklist.json');
  fs.writeFileSync(p, JSON.stringify(Object.assign({ version: 1, steps }, extra || {})));
  return p;
}
function writeEventsFile(events) {
  const dir = freshDir('forge-orchestrate-events');
  const p = path.join(dir, 'events.jsonl');
  fs.writeFileSync(p, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  return p;
}
function baseStep(overrides) {
  return Object.assign({
    id: 's-' + Math.random().toString(36).slice(2),
    label: 'test step',
    required: true,
    produces_event: 'test_event_type_placeholder',
  }, overrides || {});
}

console.log('forge-orchestrate tests (run-driver checklist auditor)');

// ---------------------------------------------------------------------------
// 1) seed integrity — the REAL config/orchestration/run-checklist.json
// ---------------------------------------------------------------------------
console.log('\n1) seed integrity (real run-checklist.json)');

t('plan() parses the real checklist without throwing and returns the 10 canonical ordered steps', () => {
  const steps = orchestrate.plan({});
  assert.ok(Array.isArray(steps) && steps.length === 10);
  assert.deepStrictEqual(steps.map((s) => s.id), [
    'read-memory', 'load-owner-prefs', 'autonomy-decide', 'intake', 'route', 'arm-manifest', 'dispatch', 'verify', 'report', 'update-memory',
  ]);
});
t('every real step has id/label/required; required steps all carry a produces_event', () => {
  for (const s of orchestrate.plan({})) {
    assert.ok(s.id && s.label && typeof s.required === 'boolean', s.id + ' missing id/label/required');
    if (s.required) assert.ok(s.produces_event, s.id + ' is required but has no produces_event');
  }
});
t('real step ids are unique', () => {
  const ids = orchestrate.plan({}).map((s) => s.id);
  assert.strictEqual(new Set(ids).size, ids.length);
});
t('the "intake" step declares a match condition (agent_note is otherwise ambiguous)', () => {
  const step = orchestrate.plan({}).find((s) => s.id === 'intake');
  assert.ok(step.match && step.match.field === 'note' && /forge-intake/i.test(step.match.includes));
});

// ---------------------------------------------------------------------------
// 2) eventMatchesStep — matching semantics
// ---------------------------------------------------------------------------
console.log('\n2) eventMatchesStep semantics');

t('matches a single-string produces_event', () => {
  const step = baseStep({ produces_event: 'foo_event' });
  assert.ok(orchestrate.eventMatchesStep({ event_type: 'foo_event' }, step));
  assert.ok(!orchestrate.eventMatchesStep({ event_type: 'bar_event' }, step));
});
t('matches any-of an array produces_event', () => {
  const step = baseStep({ produces_event: ['a_event', 'b_event'] });
  assert.ok(orchestrate.eventMatchesStep({ event_type: 'a_event' }, step));
  assert.ok(orchestrate.eventMatchesStep({ event_type: 'b_event' }, step));
  assert.ok(!orchestrate.eventMatchesStep({ event_type: 'c_event' }, step));
});
t('a step with no produces_event never matches any event', () => {
  const step = baseStep({}); delete step.produces_event;
  assert.ok(!orchestrate.eventMatchesStep({ event_type: 'anything' }, step));
});
t('match:{field,includes} requires the field to contain the substring, case-insensitively', () => {
  const step = baseStep({ produces_event: 'agent_note', match: { field: 'note', includes: 'forge-intake' } });
  assert.ok(orchestrate.eventMatchesStep({ event_type: 'agent_note', note: 'FORGE-INTAKE: 4 questions' }, step));
  assert.ok(!orchestrate.eventMatchesStep({ event_type: 'agent_note', note: 'unrelated note' }, step));
  assert.ok(!orchestrate.eventMatchesStep({ event_type: 'agent_note' }, step), 'missing field never matches');
});
t('required-evidence: an event with _forge_verify.proof_verified:false never counts as a match', () => {
  const step = baseStep({ produces_event: 'check_passed' });
  const disproven = { event_type: 'check_passed', _forge_verify: { proof_verified: false, proof_reason: 'exit_code 1 != 0' } };
  assert.ok(!orchestrate.eventMatchesStep(disproven, step));
  const proven = { event_type: 'check_passed', _forge_verify: { proof_verified: true } };
  assert.ok(orchestrate.eventMatchesStep(proven, step));
  const unstamped = { event_type: 'check_passed' };
  assert.ok(orchestrate.eventMatchesStep(unstamped, step), 'an event with no _forge_verify stamp at all is not treated as disproven');
});
t('a malformed/non-object event never matches (never throws)', () => {
  const step = baseStep({ produces_event: 'foo_event' });
  assert.ok(!orchestrate.eventMatchesStep(null, step));
  assert.ok(!orchestrate.eventMatchesStep(undefined, step));
  assert.ok(!orchestrate.eventMatchesStep('a string', step));
  assert.ok(!orchestrate.eventMatchesStep({}, step));
});

// ---------------------------------------------------------------------------
// 3) audit() — full real-checklist run: everything ran, nothing skipped
// ---------------------------------------------------------------------------
console.log('\n3) audit() — a full run against the REAL checklist');

function fullRunEvents() {
  return [
    { event_type: 'memory_loaded', agent: 'orchestrator' },
    { event_type: 'owner_prefs_loaded', agent: 'orchestrator', note: 'owner prefs/rules applied' },
    { event_type: 'decision_logged', agent: 'orchestrator', note: 'autonomy mode continue-within-mission' },
    { event_type: 'agent_note', agent: 'orchestrator', note: 'forge-intake: 6 intake-vragen voor type website (3 verplicht)' },
    { event_type: 'agent_selected', agent: 'orchestrator', note: 'routed to forge-website, L2' },
    { event_type: 'manifest_armed', agent: 'orchestrator', note: 'forge-manifest arm: 3 work package(s) armed [wp1, wp2, wp3]' },
    { event_type: 'agent_started', agent: 'build-boss', role: 'hero', dispatch_id: 'toolu_fake_1' },
    { event_type: 'check_passed', agent: 'test-boss', command: 'npm test', output: '42 passed', exit_code: 0 },
    { event_type: 'report_generated', agent: 'orchestrator' },
    { event_type: 'memory_updated', agent: 'orchestrator' },
  ];
}

t('a full run in canonical order: every step ran, none skipped, no out-of-order', () => {
  const result = orchestrate.audit({ events: fullRunEvents() }, {});
  assert.strictEqual(result.ran.length, 10);
  assert.strictEqual(result.skipped.length, 0);
  assert.strictEqual(result.out_of_order.length, 0);
  assert.deepStrictEqual(result.ran.map((r) => r.id), [
    'read-memory', 'load-owner-prefs', 'autonomy-decide', 'intake', 'route', 'arm-manifest', 'dispatch', 'verify', 'report', 'update-memory',
  ]);
});

// ---------------------------------------------------------------------------
// 3b) arm-manifest (2026-08-01) — the step that makes the dispatch manifest actually exist.
// MEASURED RED BEFORE THIS STEP EXISTED: 0 of 32 run directories under .claude/forge-runs/ held a
// manifest.json (21 held a run.json), so forge-manifest.cjs::ready()/waves() — the mechanical guarantee
// behind the owner's "one writer per hotspot at a time" HARD MUST — had no data at all, and audit() never
// reported the omission because the checklist had no such step to skip.
// ---------------------------------------------------------------------------
console.log('\n3b) arm-manifest — armed before dispatch, advisory, provable from a real manifest_armed event');

t('the real checklist contains an arm-manifest step, positioned BEFORE dispatch', () => {
  const ids = orchestrate.plan({}).map((s) => s.id);
  assert.ok(ids.includes('arm-manifest'), 'arm-manifest step is missing from the real run-checklist.json');
  assert.ok(ids.indexOf('arm-manifest') < ids.indexOf('dispatch'),
    'arming must come BEFORE dispatch — narrowed_prompt/deps have to be recorded before the work goes out');
  assert.ok(ids.indexOf('route') < ids.indexOf('arm-manifest'), 'arming follows routing (the team must be chosen first)');
});

t('arm-manifest is advisory (required:false) so no existing run is retroactively broken', () => {
  const step = orchestrate.plan({}).find((s) => s.id === 'arm-manifest');
  assert.strictEqual(step.required, false);
  assert.strictEqual(step.produces_event, 'manifest_armed');
});

t('a run WITHOUT manifest_armed reports arm-manifest as skipped by name, but does NOT flip the audit exit contract', () => {
  const events = fullRunEvents().filter((e) => e.event_type !== 'manifest_armed');
  const result = orchestrate.audit({ events }, {});
  const skipped = result.skipped.find((s) => s.id === 'arm-manifest');
  assert.ok(skipped, 'a run that never armed must still be NAMED in skipped — visible, never silent');
  assert.strictEqual(skipped.required, false);
  assert.ok(/no matching event \(manifest_armed\)/.test(skipped.reason));
  assert.ok(!result.skipped.some((s) => s.required), 'no REQUIRED step may be skipped by this fixture — the exit code must stay 0');
});

t('a real manifest_armed event satisfies the step', () => {
  const result = orchestrate.audit({ events: fullRunEvents() }, {});
  const ran = result.ran.find((r) => r.id === 'arm-manifest');
  assert.ok(ran, 'manifest_armed must satisfy arm-manifest');
  assert.strictEqual(ran.event_type, 'manifest_armed');
});

t('dispatching BEFORE the manifest was armed is caught as out_of_order, should_follow "arm-manifest"', () => {
  const full = fullRunEvents();
  const armIdx = full.findIndex((e) => e.event_type === 'manifest_armed');
  const dispIdx = full.findIndex((e) => e.event_type === 'agent_started');
  const events = full.slice();
  events[armIdx] = full[dispIdx]; events[dispIdx] = full[armIdx];
  const result = orchestrate.audit({ events }, {});
  assert.strictEqual(result.out_of_order.length, 1);
  assert.strictEqual(result.out_of_order[0].id, 'dispatch');
  assert.strictEqual(result.out_of_order[0].should_follow, 'arm-manifest',
    'work that went out before its manifest was armed must be named against arm-manifest: ' + JSON.stringify(result.out_of_order));
});

t('a DISPROVEN manifest_armed event does not satisfy the step (required-evidence applies here too)', () => {
  const events = fullRunEvents().map((e) => e.event_type === 'manifest_armed'
    ? Object.assign({}, e, { _forge_verify: { proof_verified: false, proof_reason: 'no manifest file' } })
    : e);
  const result = orchestrate.audit({ events }, {});
  assert.ok(result.skipped.some((s) => s.id === 'arm-manifest'), 'a disproven manifest_armed must not satisfy arm-manifest');
});

// ---------------------------------------------------------------------------
// 4) audit() — a run missing the verify step
// ---------------------------------------------------------------------------
console.log('\n4) audit() — a run missing the verify step');

t('a run with no check_passed/quality_gate_passed/retest_completed event shows verify in skipped (required)', () => {
  const events = fullRunEvents().filter((e) => e.event_type !== 'check_passed');
  const result = orchestrate.audit({ events }, {});
  assert.strictEqual(result.ran.length, 9);
  assert.strictEqual(result.skipped.length, 1);
  assert.strictEqual(result.skipped[0].id, 'verify');
  assert.strictEqual(result.skipped[0].required, true);
  assert.ok(/no matching event/.test(result.skipped[0].reason));
});

t('required-evidence: a check_passed event present but disproven (proof_verified:false) ALSO shows verify as skipped', () => {
  const events = fullRunEvents().map((e) => e.event_type === 'check_passed'
    ? Object.assign({}, e, { _forge_verify: { proof_verified: false, proof_reason: 'exit_code 1 != 0' } })
    : e);
  const result = orchestrate.audit({ events }, {});
  assert.ok(result.skipped.some((s) => s.id === 'verify'), 'a disproven check_passed must not satisfy the verify step');
});

// ---------------------------------------------------------------------------
// 5) audit() — out-of-order detection
// ---------------------------------------------------------------------------
console.log('\n5) audit() — out-of-order detection');

t('dispatch logged before route is flagged out_of_order, should_follow "route"', () => {
  // manifest_armed is dropped here so this case stays about route-vs-dispatch ALONE (arm-manifest sits
  // between them in the canonical order and would otherwise add a second, unrelated out-of-order entry).
  const full = fullRunEvents().filter((e) => e.event_type !== 'manifest_armed');
  // swap indices 4 (agent_selected/route) and 5 (agent_started/dispatch)
  const events = full.slice();
  const routeEv = events[4], dispatchEv = events[5];
  events[4] = dispatchEv; events[5] = routeEv;
  const result = orchestrate.audit({ events }, {});
  assert.strictEqual(result.ran.length, 9, 'every step except the (advisory) arm-manifest found a matching event');
  assert.strictEqual(result.out_of_order.length, 1);
  assert.strictEqual(result.out_of_order[0].id, 'dispatch');
  assert.strictEqual(result.out_of_order[0].should_follow, 'route');
});

t('a well-ordered run reports zero out_of_order entries even with unrelated events interleaved', () => {
  const full = fullRunEvents();
  const withNoise = [full[0], { event_type: 'file_read', agent: 'build-boss', file: 'src/x.ts' }, ...full.slice(1)];
  const result = orchestrate.audit({ events: withNoise }, {});
  assert.strictEqual(result.out_of_order.length, 0);
});

// ---------------------------------------------------------------------------
// 6) audit() input handling
// ---------------------------------------------------------------------------
console.log('\n6) audit() input handling');

t('audit() reads events from an eventsPath file (line-delimited JSON)', () => {
  const p = writeEventsFile(fullRunEvents());
  const result = orchestrate.audit({ eventsPath: p }, {});
  assert.strictEqual(result.ran.length, 10);
});
t('audit() tolerates a BOM and malformed/blank lines in the events file', () => {
  const dir = freshDir('forge-orchestrate-bom');
  const p = path.join(dir, 'events.jsonl');
  const body = '﻿' + fullRunEvents().map((e) => JSON.stringify(e)).join('\n') + '\n\nnot json at all\n  \n';
  fs.writeFileSync(p, body, 'utf8');
  const result = orchestrate.audit({ eventsPath: p }, {});
  assert.strictEqual(result.ran.length, 10);
});
t('audit() with neither events[] nor eventsPath throws a clear usage error', () => {
  assert.throws(() => orchestrate.audit({}, {}), /requires input\.events/);
});
t('audit() with an unreadable eventsPath throws', () => {
  assert.throws(() => orchestrate.audit({ eventsPath: path.join(freshDir('forge-orchestrate-nope'), 'missing.jsonl') }, {}));
});
t('an empty events array: every step is skipped, none ran (9 required + the advisory arm-manifest)', () => {
  const result = orchestrate.audit({ events: [] }, {});
  assert.strictEqual(result.ran.length, 0);
  assert.strictEqual(result.skipped.length, 10);
  assert.strictEqual(result.skipped.filter((s) => s.required === true).length, 9);
  assert.deepStrictEqual(result.skipped.filter((s) => s.required === false).map((s) => s.id), ['arm-manifest']);
});

// ---------------------------------------------------------------------------
// 7) config integrity — refuses malformed input rather than silently passing everything
// ---------------------------------------------------------------------------
console.log('\n7) config integrity');

t('an empty steps array throws', () => {
  const p = writeChecklist([]);
  assert.throws(() => orchestrate.plan({ checklistPath: p }));
});
t('a step missing "id" throws', () => {
  const s = baseStep({}); delete s.id;
  const p = writeChecklist([s]);
  assert.throws(() => orchestrate.plan({ checklistPath: p }));
});
t('a step missing "label" throws', () => {
  const s = baseStep({}); delete s.label;
  const p = writeChecklist([s]);
  assert.throws(() => orchestrate.plan({ checklistPath: p }));
});
t('a step missing "required" (or non-boolean) throws', () => {
  const s = baseStep({}); delete s.required;
  const p = writeChecklist([s]);
  assert.throws(() => orchestrate.plan({ checklistPath: p }));
});
t('a step with an invalid produces_event (empty array) throws', () => {
  const p = writeChecklist([baseStep({ produces_event: [] })]);
  assert.throws(() => orchestrate.plan({ checklistPath: p }));
});
t('a step with an invalid produces_event (non-string entry) throws', () => {
  const p = writeChecklist([baseStep({ produces_event: ['ok_event', 42] })]);
  assert.throws(() => orchestrate.plan({ checklistPath: p }));
});
t('a step with an invalid "match" (missing includes) throws', () => {
  const p = writeChecklist([baseStep({ match: { field: 'note' } })]);
  assert.throws(() => orchestrate.plan({ checklistPath: p }));
});
t('a duplicate step id throws', () => {
  const p = writeChecklist([baseStep({ id: 'dup' }), baseStep({ id: 'dup' })]);
  assert.throws(() => orchestrate.plan({ checklistPath: p }));
});
t('invalid JSON syntax throws with a clear message, not a silent empty result', () => {
  const dir = freshDir('forge-orchestrate-badjson');
  const p = path.join(dir, 'bad.json');
  fs.writeFileSync(p, '{ not valid json');
  assert.throws(() => orchestrate.plan({ checklistPath: p }));
});
t('a missing checklist file throws (never silently returns "no steps")', () => {
  assert.throws(() => orchestrate.plan({ checklistPath: path.join(freshDir('forge-orchestrate-nope2'), 'does-not-exist.json') }));
});
t('a step WITHOUT produces_event is valid (optional field) and audits as unauditable-from-events', () => {
  const s = baseStep({}); delete s.produces_event;
  const p = writeChecklist([s]);
  const result = orchestrate.audit({ events: [] }, { checklistPath: p });
  assert.strictEqual(result.skipped.length, 1);
  assert.ok(/cannot be audited from events alone/.test(result.skipped[0].reason));
});

// ---------------------------------------------------------------------------
// 8) hermeticity — fixture calls never touch/leak into the real checklist
// ---------------------------------------------------------------------------
console.log('\n8) hermeticity');

t('a hermetic fixture step id does not leak into the real checklist plan()', () => {
  const p = writeChecklist([baseStep({ id: 'totally-fake-fixture-only', produces_event: 'x' })]);
  orchestrate.plan({ checklistPath: p }); // populates the module cache for that path
  const real = orchestrate.plan({}); // real file, different path -> cache miss -> re-read
  assert.ok(!real.some((s) => s.id === 'totally-fake-fixture-only'));
});

t('a fixture checklist with two ordered steps correctly detects out-of-order against its OWN steps', () => {
  const p = writeChecklist([
    baseStep({ id: 'first', produces_event: 'ev_first' }),
    baseStep({ id: 'second', produces_event: 'ev_second' }),
  ]);
  const events = [{ event_type: 'ev_second' }, { event_type: 'ev_first' }];
  const result = orchestrate.audit({ events }, { checklistPath: p });
  assert.strictEqual(result.ran.length, 2);
  assert.strictEqual(result.out_of_order.length, 1);
  assert.strictEqual(result.out_of_order[0].id, 'second');
  assert.strictEqual(result.out_of_order[0].should_follow, 'first');
});

// ---------------------------------------------------------------------------
// 9) CLI (real spawned subprocess, real seed checklist)
// ---------------------------------------------------------------------------
console.log('\n9) CLI');

t('CLI plan --json returns the 10 canonical steps in order', () => {
  const r = runCLI(['plan', '--json']);
  assert.strictEqual(r.status, 0, 'stderr: ' + r.stderr);
  const parsed = JSON.parse(r.stdout.trim());
  assert.strictEqual(parsed.length, 10);
  assert.strictEqual(parsed[0].id, 'read-memory');
  assert.strictEqual(parsed[9].id, 'update-memory');
});
t('CLI plan (human output) lists every step id', () => {
  const r = runCLI(['plan']);
  assert.strictEqual(r.status, 0);
  for (const id of ['read-memory', 'load-owner-prefs', 'autonomy-decide', 'intake', 'route', 'arm-manifest', 'dispatch', 'verify', 'report', 'update-memory']) {
    assert.ok(r.stdout.includes(id), 'missing ' + id + ' in plan output');
  }
});
t('CLI audit --events <full run> --json exits 0 with everything ran', () => {
  const p = writeEventsFile(fullRunEvents());
  const r = runCLI(['audit', '--events', p, '--json']);
  assert.strictEqual(r.status, 0, 'stderr: ' + r.stderr);
  const parsed = JSON.parse(r.stdout.trim());
  assert.strictEqual(parsed.ran.length, 10);
  assert.strictEqual(parsed.skipped.length, 0);
});
t('CLI audit --events <run missing verify> exits 3 (a required step was skipped)', () => {
  const p = writeEventsFile(fullRunEvents().filter((e) => e.event_type !== 'check_passed'));
  const r = runCLI(['audit', '--events', p, '--json']);
  assert.strictEqual(r.status, 3);
  const parsed = JSON.parse(r.stdout.trim());
  assert.ok(parsed.skipped.some((s) => s.id === 'verify'));
});
t('CLI audit --events <out-of-order run> exits 3', () => {
  const full = fullRunEvents().filter((e) => e.event_type !== 'manifest_armed');
  const events = full.slice();
  const routeEv = events[4], dispatchEv = events[5];
  events[4] = dispatchEv; events[5] = routeEv;
  const p = writeEventsFile(events);
  const r = runCLI(['audit', '--events', p, '--json']);
  assert.strictEqual(r.status, 3);
});
t('CLI audit without --events exits 2 (usage error)', () => {
  const r = runCLI(['audit']);
  assert.strictEqual(r.status, 2);
});
t('CLI with an unknown command exits 2', () => {
  const r = runCLI(['bogus-command']);
  assert.strictEqual(r.status, 2);
});
t('CLI with no command at all exits 2', () => {
  const r = runCLI([]);
  assert.strictEqual(r.status, 2);
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
