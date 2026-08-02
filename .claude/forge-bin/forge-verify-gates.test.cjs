#!/usr/bin/env node
'use strict';
/** forge-verify-gates.test.cjs — THE GATE-ISOLATION MATRIX for forge-verify.cjs's exit code (2026-08-01).
 *
 *  WHY THIS SUITE EXISTS (the fourth false-green found in one night, so a per-case fix is provably not
 *  enough). An independent witness deleted `failures.failure_hits.length === 0` from forge-verify's
 *  exit-code chain and the whole project stayed green: forge-taskcontract 30 passed / 0 failed,
 *  forge-verify 153 passed / 0 failed, and forge-doctor's "no-op tests" check saw nothing (that check only
 *  finds suites with zero assertion sites — this suite had plenty, they just could not fail).
 *
 *  The mechanism is general, and it is NOT specific to failure conditions: forge-verify has SIX gates and
 *  exactly one exit code. A test that asserts `exit === 1` proves nothing about the gate it names unless
 *  that gate is the ONLY reason the run is non-zero. The failure-condition test's scenario logged a
 *  `check_failed` from "Build Boss" followed by `agent_completed` — which is also a textbook agent
 *  MISMATCH (claims done with an unfinished task), and the mismatch gate alone already forced exit 1. The
 *  assertion was structurally incapable of failing.
 *
 *  WHAT THIS SUITE PINS, per gate, for EVERY gate:
 *    (1) an ISOLATING scenario exists — a real run through the real CLI in which that gate is the only
 *        non-zero counter on forge-verify's own VERIFY: line;
 *    (2) that scenario exits 1 — so deleting that gate from the exit code turns this suite red;
 *    (3) the counters are read back from the CLI's PRINTED output, never re-derived here. Re-deriving
 *        them in the test would re-implement the very bug the test is meant to catch.
 *
 *  AND THE STRUCTURAL HALF — the part that makes this more than six more hand-written cases. The gate set
 *  is exported DATA (forge-verify.cjs::EXIT_GATES), and this suite asserts the mapping in BOTH directions:
 *    · every live gate key must have a registered isolating scenario → a SEVENTH gate added tomorrow with
 *      no isolating scenario fails here, at the moment it is added;
 *    · every registered scenario must still map to a live gate key → DELETING a gate (the exact 2026-08-01
 *      mutation) fails here too, instead of silently weakening the tool.
 *
 *  Hermetic: FORGE_STORE_ROOT points at a throwaway .claude/ under os.tmpdir(), set BEFORE forge-verify.cjs
 *  is required (it resolves forge-store's CLAUDE_DIR once, at require time — the same escape hatch
 *  forge-verify.test.cjs / forge-taskcontract.test.cjs use). Nothing here reads or writes the real project.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-verify-gates-'));
const CLAUDE_DIR = path.join(TMP, '.claude');
fs.mkdirSync(CLAUDE_DIR, { recursive: true });
process.env.FORGE_STORE_ROOT = CLAUDE_DIR;

const V = require('./forge-verify.cjs');
const store = require('./forge-store.cjs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

console.log('forge-verify gate-isolation matrix (one isolating scenario per exit-code gate)');

// ---- fixture helpers ---------------------------------------------------------------------------------
function writeRun(runId, events) {
  const dir = path.join(CLAUDE_DIR, 'forge-runs', runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'),
    events.map((e) => JSON.stringify(Object.assign({ ts: new Date().toISOString() }, e))).join('\n') + '\n', 'utf8');
  return runId;
}
function writePrdMeta(prdId, sections) {
  const dir = path.join(CLAUDE_DIR, 'forge-prd');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, prdId + '.meta.json'),
    JSON.stringify({ prd_id: prdId, title: prdId, sections }, null, 2) + '\n', 'utf8');
}
function runCli(runId) {
  return spawnSync(process.execPath, [path.join(__dirname, 'forge-verify.cjs'), runId, '--root', TMP],
    { env: Object.assign({}, process.env, { FORGE_STORE_ROOT: CLAUDE_DIR }), encoding: 'utf8' });
}

/**
 * parseVerifyLine(stdout) -> { counts: {gateKey: n}, line }
 * Reads the per-gate counters back off forge-verify's OWN printed VERIFY: line, matching each segment
 * against EXIT_GATES in order. Deliberately strict: an unparseable segment, a wrong label, or a different
 * number of segments THROWS rather than defaulting to zero — a silently-zero counter is precisely the
 * failure mode this suite exists to catch, and it must not be re-introduced inside the test harness.
 */
function parseVerifyLine(stdout) {
  const line = String(stdout || '').split(/\r?\n/).find((l) => l.startsWith('VERIFY: '));
  assert.ok(line, 'no VERIFY: line in the CLI output:\n' + stdout);
  const body = line.slice('VERIFY: '.length).split(' · advisory:')[0];
  const segments = body.split(', ');
  assert.strictEqual(segments.length, V.EXIT_GATES.length,
    'the VERIFY: line reports ' + segments.length + ' counter(s) but EXIT_GATES declares ' + V.EXIT_GATES.length +
    ' — the printed summary and the gate set have drifted apart:\n' + line);
  const counts = {};
  V.EXIT_GATES.forEach((gate, i) => {
    const m = /^(\d+) (.+)$/.exec(segments[i]);
    assert.ok(m, 'unparseable VERIFY: segment ' + JSON.stringify(segments[i]) + ' in:\n' + line);
    assert.strictEqual(m[2], gate.label,
      'VERIFY: segment ' + i + ' is labelled "' + m[2] + '" but gate ' + gate.key + ' is labelled "' + gate.label +
      '" — the line is not being rendered from EXIT_GATES:\n' + line);
    counts[gate.key] = Number(m[1]);
  });
  return { counts, line };
}

// ---- the isolating scenarios, one per gate -----------------------------------------------------------
// EVERY scenario below is built so that exactly ONE gate can possibly be non-zero. The comments name the
// specific thing that keeps each of the other five at zero, because that is the load-bearing part: it is
// what a future edit would have to break for this suite to stop proving anything.
const SCENARIOS = {
  // An agent claims done with a task it never terminated. No tickets belong to this run, no PRD is linked
  // (so neither acceptance nor failure conditions can fire), and no event carries a path (so the isolation
  // tripwire has nothing to inspect).
  mismatches: () => writeRun('gate-mismatch-only', [
    { event_type: 'run_started', agent: 'orchestrator' },
    { event_type: 'agent_started', agent: 'Build Boss' },
    { event_type: 'check_started', agent: 'Build Boss', task: 'unit tests' }, // never terminated -> open
    { event_type: 'agent_completed', agent: 'Build Boss', status: 'done' },   // claims done anyway
  ]),

  // A genuinely clean agent (its one task is done, so no mismatch) plus one still-open ticket tied to this
  // run. No PRD, no paths.
  open_tickets: () => {
    const runId = writeRun('gate-open-ticket-only', [
      { event_type: 'agent_started', agent: 'Clean Boss' },
      { event_type: 'check_passed', agent: 'Clean Boss', task: 'suite' },
      { event_type: 'agent_completed', agent: 'Clean Boss' },
    ]);
    store.putEntity('tickets', 'tk-gate-open-1', {
      ticket_id: 'tk-gate-open-1', run_id: runId, title: 'still open', status: 'open',
      created: new Date().toISOString(),
    });
    return runId;
  },

  // Same clean agent, but the ticket claims done while carrying required_tests and no test_evidence — the
  // test-first rule's unproven-done shape. Status is 'done', so it is NOT also an open ticket.
  unproven_tickets: () => {
    const runId = writeRun('gate-unproven-ticket-only', [
      { event_type: 'agent_started', agent: 'Clean Boss 2' },
      { event_type: 'check_passed', agent: 'Clean Boss 2', task: 'suite' },
      { event_type: 'agent_completed', agent: 'Clean Boss 2' },
    ]);
    store.putEntity('tickets', 'tk-gate-unproven-1', {
      ticket_id: 'tk-gate-unproven-1', run_id: runId, title: 'needs evidence', status: 'done',
      required_tests: ['x.test.cjs'], created: new Date().toISOString(),
    });
    return runId;
  },

  // One logged file_changed escaping the project root. file_changed is a TERMINAL event type, so the task
  // it creates is DONE — the agent may claim completion without producing a mismatch. No tickets, no PRD.
  isolation_violations: () => writeRun('gate-isolation-only', [
    { event_type: 'agent_started', agent: 'Build Boss' },
    { event_type: 'file_changed', agent: 'Build Boss', path: '../../outside-project/secret.txt' },
    { event_type: 'agent_completed', agent: 'Build Boss' },
  ]),

  // A PRD whose single acceptance criterion never got its ticket (tk-<prd>-1 does not exist). The PRD
  // declares NO failure_conditions, so the failure gate cannot fire off the same fixture.
  acceptance_gaps: () => {
    writePrdMeta('prdgateac', { acceptance_criteria: [{ id: 'ac-1', text: 'the page loads' }] });
    return writeRun('gate-acceptance-only', [
      { event_type: 'agent_started', agent: 'Clean Boss 3' },
      { event_type: 'prd_generated', agent: 'orchestrator', prd_id: 'prdgateac' },
      { event_type: 'check_passed', agent: 'Clean Boss 3', task: 'suite' },
      { event_type: 'agent_completed', agent: 'Clean Boss 3' },
    ]);
  },

  // THE SCENARIO THE WITNESS PROVED WAS MISSING. A PRD declaring only failure_conditions (no
  // acceptance_criteria -> no acceptance gap possible), and a check_failed naming that exact prd_id/fc_id.
  // The agent that logged it does NOT claim completion — that single omission is what keeps the mismatch
  // gate at zero, and it is why the original test could not fail: its fixture ended in agent_completed.
  // An UNATTENDED run that stopped on its dollar ceiling. The events themselves are deliberately spotless
  // (one task, terminated, then a completion claim) so no mismatch is possible; there are no tickets, no
  // PRD and no paths, so the ticket/acceptance/failure/isolation gates cannot fire either. The ONLY thing
  // wrong with this run is the budget verdict forge-run-budget.cjs left in its directory — which is
  // exactly the point: a wrapper that ran out of money produced a run that LOOKS finished from its events.
  budget_stops: () => {
    const runId = writeRun('gate-budget-only', [
      { event_type: 'run_started', agent: 'orchestrator' },
      { event_type: 'agent_started', agent: 'Sweep Boss' },
      { event_type: 'check_passed', agent: 'Sweep Boss', task: 'suite' },
      { event_type: 'agent_completed', agent: 'Sweep Boss', status: 'done' },
    ]);
    fs.appendFileSync(path.join(CLAUDE_DIR, 'forge-runs', runId, 'budget-verdicts.jsonl'),
      JSON.stringify({
        ts: new Date().toISOString(), wrapper: 'maand-sweep', status: 'stopped_by_budget',
        budget_stopped: true, cap_usd: 5, cost_usd: 5.02,
        reason: 'the run reported total_cost_usd 5.02 against a cap of 5',
      }) + '\n', 'utf8');
    return runId;
  },

  failure_hits: () => {
    writePrdMeta('prdgatefc', { failure_conditions: [{ id: 'fc-1', text: 'the bundle exceeds 1MB' }] });
    return writeRun('gate-failure-only', [
      { event_type: 'run_started', agent: 'orchestrator' },
      { event_type: 'prd_generated', agent: 'orchestrator', prd_id: 'prdgatefc' },
      { event_type: 'agent_started', agent: 'QA Boss' },
      { event_type: 'check_failed', agent: 'QA Boss', prd_id: 'prdgatefc', fc_id: 'fc-1', note: 'bundle is 2.3MB' },
    ]);
  },
};

// ======================================================================================================
// 1) the structural half — the gate set and the scenario set must match, in BOTH directions
// ======================================================================================================
t('EXIT_GATES is a well-formed, non-empty list of uniquely-keyed gates', () => {
  assert.ok(Array.isArray(V.EXIT_GATES) && V.EXIT_GATES.length > 0, 'EXIT_GATES is not a non-empty array');
  const keys = V.EXIT_GATES.map((g) => g.key);
  assert.strictEqual(new Set(keys).size, keys.length, 'duplicate gate key(s): ' + keys.join(', '));
  for (const g of V.EXIT_GATES) {
    assert.ok(typeof g.key === 'string' && g.key.trim(), 'a gate has no key: ' + JSON.stringify(g));
    assert.ok(typeof g.label === 'string' && g.label.trim(), 'gate ' + g.key + ' has no label');
    assert.strictEqual(typeof g.count, 'function', 'gate ' + g.key + ' has no count() accessor');
  }
});

t('EVERY exit-code gate has an isolating scenario (a new gate cannot be added without one)', () => {
  const missing = V.EXIT_GATES.map((g) => g.key).filter((k) => !SCENARIOS[k]);
  assert.deepStrictEqual(missing, [],
    'these gates influence the exit code but have NO scenario in which they are the only reason for it: ' +
    missing.join(', ') + '. Add one to SCENARIOS above — a gate with no isolating scenario is a gate no ' +
    'test can prove, which is exactly the 2026-08-01 defect.');
});

t('EVERY registered scenario still maps to a live gate (a deleted gate cannot pass unnoticed)', () => {
  const live = new Set(V.EXIT_GATES.map((g) => g.key));
  const orphaned = Object.keys(SCENARIOS).filter((k) => !live.has(k));
  assert.deepStrictEqual(orphaned, [],
    'these scenarios target gates that are no longer in EXIT_GATES: ' + orphaned.join(', ') +
    '. Either a gate was dropped from the exit code (the exact mutation that survived on 2026-08-01), ' +
    'or a stale scenario needs removing — both must be a decision, not a silent drift.');
});

// ======================================================================================================
// 2) the per-gate half — each gate, alone, really does flip the exit code
// ======================================================================================================
for (const gate of V.EXIT_GATES) {
  const build = SCENARIOS[gate.key];
  if (!build) continue; // already reported as a failure by the coverage test above
  t('GATE ' + gate.key + ': an isolated run trips ONLY this counter and exits 1', () => {
    const runId = build();
    const r = runCli(runId);
    const { counts, line } = parseVerifyLine(r.stdout);
    assert.ok(counts[gate.key] > 0,
      'the scenario for ' + gate.key + ' did not actually trip that gate (counter is ' + counts[gate.key] +
      ') — the fixture no longer exercises what it claims:\n' + line + '\n' + r.stdout);
    const others = Object.keys(counts).filter((k) => k !== gate.key && counts[k] !== 0);
    assert.deepStrictEqual(others, [],
      'the scenario for ' + gate.key + ' also trips ' + others.join(', ') + ' — it is NOT isolating, so its ' +
      'exit-code assertion would be satisfied by another gate:\n' + line);
    assert.strictEqual(r.status, 1,
      'exit ' + r.status + ' — gate ' + gate.key + ' is the only non-zero counter, so it alone must gate. ' +
      'If this is red, that clause is missing from the exit code:\n' + line + '\n' + r.stdout);
  });
}

// ======================================================================================================
// 3) anti-tiebreak — the harness must be able to say 0 as well as 1
// ======================================================================================================
// Without this, an implementation (or a mis-built fixture set) that ALWAYS exits 1 would pass everything
// above for entirely the wrong reason.
t('a run clean on every gate exits 0 with all counters at zero', () => {
  const runId = writeRun('gate-all-clean', [
    { event_type: 'run_started', agent: 'orchestrator' },
    { event_type: 'agent_started', agent: 'Clean Boss 4' },
    { event_type: 'check_passed', agent: 'Clean Boss 4', task: 'suite' },
    { event_type: 'agent_completed', agent: 'Clean Boss 4' },
  ]);
  const r = runCli(runId);
  const { counts, line } = parseVerifyLine(r.stdout);
  const nonZero = Object.keys(counts).filter((k) => counts[k] !== 0);
  assert.deepStrictEqual(nonZero, [], 'a deliberately clean run reports non-zero gate(s): ' + nonZero.join(', ') + '\n' + line);
  assert.strictEqual(r.status, 0, 'exit ' + r.status + ' on a fully clean run:\n' + r.stdout);
});

// The two tests below build their OWN fixture on purpose. Reusing one of the SCENARIOS runs would make them
// depend on the loop above having run — so deleting a gate would fail them for the wrong reason ("fixture
// missing") on top of the real structural failure, which is noise in exactly the moment the report has to be
// precise. This run is deliberately non-clean in a gate-agnostic way (an agent claiming done with an
// unfinished task) and the assertions below never name a specific gate key.
const NON_CLEAN_RUN = writeRun('gate-agreement', [
  { event_type: 'run_started', agent: 'orchestrator' },
  { event_type: 'agent_started', agent: 'Agreement Boss' },
  { event_type: 'check_started', agent: 'Agreement Boss', task: 'unfinished work' },
  { event_type: 'agent_completed', agent: 'Agreement Boss', status: 'done' },
]);

// The printed line and the exit code are derived from the SAME list, so they cannot disagree — pinned here
// against a future "just print it by hand again" edit.
t('the exit code agrees with the printed counters on a real non-clean run', () => {
  const r = runCli(NON_CLEAN_RUN);
  const { counts, line } = parseVerifyLine(r.stdout);
  const anyNonZero = Object.keys(counts).some((k) => counts[k] > 0);
  assert.ok(anyNonZero, 'fixture precondition: this run must trip at least one gate:\n' + line);
  assert.strictEqual(r.status, anyNonZero ? 1 : 0,
    'the VERIFY: counters say ' + JSON.stringify(counts) + ' but the exit code is ' + r.status);
});

// exitCodeFor()/gateCounts() are the exported predicate the CLI itself uses — pin them directly too, so a
// caller (or a future orchestrator) gets the same verdict without spawning the CLI.
t('exitCodeFor()/gateCounts() agree with the CLI for the same run state', () => {
  const runDir = path.join(CLAUDE_DIR, 'forge-runs', NON_CLEAN_RUN);
  const ctx = {
    verify: V.verifyRun(runDir, {}),
    tickets: V.verifyTickets({ run_id: NON_CLEAN_RUN }),
    isolation: V.isolationTripwire(runDir, TMP),
    acceptance: V.checkAcceptanceCoverage(NON_CLEAN_RUN, { runDir }),
    failures: V.checkFailureConditions(NON_CLEAN_RUN, { runDir }),
    budget: V.budgetStops(runDir),
  };
  const counts = V.gateCounts(ctx);
  assert.ok(Object.keys(counts).some((k) => counts[k] > 0), 'the exported counters call this run clean: ' + JSON.stringify(counts));
  assert.strictEqual(V.exitCodeFor(ctx), 1, 'exitCodeFor disagrees with its own counters: ' + JSON.stringify(counts));
  const cli = parseVerifyLine(runCli(NON_CLEAN_RUN).stdout);
  assert.deepStrictEqual(counts, cli.counts, 'the exported predicate and the CLI report different counters');
});

// A gate accessor that breaks must GATE, not silently read as clean — 0 is the one answer a broken counter
// may never give (see gateCount()'s doc comment in forge-verify.cjs).
t('a gate whose accessor throws counts as tripped, never as clean', () => {
  const broken = [{ key: 'boom', label: 'boom(s)', count: () => { throw new Error('accessor blew up'); } }];
  const saved = V.EXIT_GATES.splice(0, V.EXIT_GATES.length, ...broken);
  try {
    assert.strictEqual(V.exitCodeFor({}), 1, 'a throwing gate accessor was treated as clean');
    assert.strictEqual(V.gateCounts({}).boom, 1, 'a throwing gate accessor reported 0');
  } finally {
    V.EXIT_GATES.splice(0, V.EXIT_GATES.length, ...saved); // restore the real gate set for any later test
  }
  assert.strictEqual(V.EXIT_GATES.length, saved.length, 'the real gate set was not restored');
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
