#!/usr/bin/env node
'use strict';
/** forge-caller-wiring.test.cjs — 2026-08-01, "pakket 2: geef bewezen, getest gereedschap een echte aanroeper".
 *
 * Three measured cases of the SAME defect class: a pure, tested function that nobody calls. Each one is
 * proven end-to-end here BEFORE it was wired up.
 *
 *  (a) forge-beads.cjs::ready() (the honest frontier — what can start RIGHT NOW — plus 3-colour-DFS cycle
 *      detection) had zero callers outside its own test file. forge-manifest.cjs — the module that holds the
 *      armed work packages AND their `deps` — exported only arm/load/reconcile/status, so the dispatch ORDER
 *      was whatever the Lead judged by eye. That is exactly the hotspot the owner's Orchestration-Safety
 *      HARD MUST ("one writer per hotspot at a time") is about: a computed frontier hands out disjoint work,
 *      an eyeballed order does not.
 *  (b) forge-verify.cjs::loopConvergence(rounds, opts) exists, is pure and tested, and reports both
 *      `converged` (a dry streak: no NEW findings) and `hitCap`. Nothing called it — not even the CLI — so
 *      the rework loop had no brake at all.
 *  (c) forge-runwatch.cjs answers "is this run genuinely alive" WITH the terminal event line as evidence,
 *      but only ever on request. Nothing ran it periodically, which is why run forge-2026-07-29-cc-finish
 *      sat on status "running" for 30+ hours after it was really finished.
 *
 * PROOF STYLE: hermetic os.mkdtemp roots only — nothing here ever writes into the real project's .claude/.
 * Every frontier/brake/liveness assertion is made against REAL module output or a REALLY spawned CLI, never
 * a stub, and every "must not fire" case is pinned as hard as its "must fire" twin so an implementation that
 * always says yes (or always says no) cannot pass. See the ANTI-TIEBREAK notes at A2/A12, B6/B7 and C8.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { spawnSync } = require('child_process');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}
const NODE = process.execPath;
const ids = (arr) => arr.map((w) => w.wp_id);

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// (a) forge-manifest.cjs must be able to answer "what can start now" by CALLING forge-beads' frontier core
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n(a) forge-manifest frontier — ready() / waves() delegating to forge-beads');

const M = require('./forge-manifest.cjs');
const BEADS = require('./forge-beads.cjs');
const TMP_A = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-frontier-'));

const wp = (id, deps) => ({ wp_id: id, agent: 'Build Boss', narrowed_prompt: 'do ' + id, deps: deps || [] });
function armRun(runId, wps) {
  const r = M.arm({ run_id: runId, wps }, { root: TMP_A });
  assert.ok(r.ok, 'fixture arm() failed: ' + JSON.stringify(r));
}
function writeRunEvents(root, runId, lines) {
  const dir = path.join(root, '.claude', 'forge-runs', runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n', 'utf8');
  return dir;
}

// A chain armed in a DELIBERATELY WRONG order: manifest order is c, a, b — the frontier is [a] alone.
armRun('run-chain', [wp('wp-c', ['wp-b']), wp('wp-a'), wp('wp-b', ['wp-a'])]);
// Two genuinely independent packages + one that needs both — the parallel-wave shape.
armRun('run-parallel', [wp('wp-p1'), wp('wp-p2'), wp('wp-p3', ['wp-p1', 'wp-p2'])]);
// A real deadlock: x needs y, y needs x. Must be DETECTED and excluded, never hang.
armRun('run-cycle', [wp('wp-x', ['wp-y']), wp('wp-y', ['wp-x'])]);
// A dangling dep — an id that resolves to no work package at all.
armRun('run-dangling', [wp('wp-ok'), wp('wp-d', ['wp-never-armed'])]);

t('A1: forge-manifest exports ready() and waves() as callable functions', () => {
  assert.strictEqual(typeof M.ready, 'function', 'M.ready is not a function');
  assert.strictEqual(typeof M.waves, 'function', 'M.waves is not a function');
});

// ANTI-TIEBREAK: asserted as the EXACT frontier, never "non-empty". An implementation that returns every
// unfinished WP (3 ids) or the manifest's own first entry (wp-c) fails here for its own reason.
t('A2: ready() on the chain returns EXACTLY the one package whose deps are all done', () => {
  const r = M.ready('run-chain', { root: TMP_A });
  assert.deepStrictEqual(ids(r.ready), ['wp-a']);
});
t('A3: ready() excludes both dependent packages by name (deps unmet, not merely "later in the list")', () => {
  const got = ids(M.ready('run-chain', { root: TMP_A }).ready);
  assert.ok(!got.includes('wp-b'), 'wp-b must not be ready: its dep wp-a is not done');
  assert.ok(!got.includes('wp-c'), 'wp-c must not be ready: its dep wp-b is not done');
});
t('A4: ready() reports honest totals alongside the frontier', () => {
  const r = M.ready('run-chain', { root: TMP_A });
  assert.strictEqual(r.total, 3);
  assert.strictEqual(r.done, 0);
  assert.strictEqual(r.run_id, 'run-chain');
});
t('A5: after a REAL wp_completed event + reconcile, the frontier moves to exactly the next package', () => {
  writeRunEvents(TMP_A, 'run-chain', [
    { event_type: 'wp_completed', agent: 'Build Boss', wp_id: 'wp-a', timestamp: '2026-08-01T10:00:00Z', evidence: 'suite green' },
  ]);
  const rec = M.reconcile({ run_id: 'run-chain' }, { root: TMP_A });
  assert.strictEqual(rec.done.length, 1, 'fixture precondition: reconcile must flip wp-a to done');
  const r = M.ready('run-chain', { root: TMP_A });
  assert.deepStrictEqual(ids(r.ready), ['wp-b']);
  assert.strictEqual(r.done, 1);
});
t('A6: waves() returns the full computed dispatch ORDER, not the manifest order', () => {
  const w = M.waves('run-chain', { root: TMP_A });
  assert.deepStrictEqual(w.waves.map(ids), [['wp-b'], ['wp-c']], 'wp-a is already done and must not reappear');
});
t('A7: waves() puts genuinely INDEPENDENT packages in ONE wave (the safe-parallel group)', () => {
  const w = M.waves('run-parallel', { root: TMP_A });
  assert.deepStrictEqual(w.waves.map(ids), [['wp-p1', 'wp-p2'], ['wp-p3']]);
});
t('A8: a dependency CYCLE is detected, excluded from the frontier, and never loops forever', () => {
  const r = M.ready('run-cycle', { root: TMP_A });
  assert.deepStrictEqual(ids(r.ready), [], 'a package inside a cycle can never honestly be "ready"');
  assert.strictEqual(r.cycles.length, 1, 'the cycle must be REPORTED, not silently swallowed');
  assert.ok(r.cycles[0].includes('wp-x') && r.cycles[0].includes('wp-y'), 'cycle must name both packages');
  const w = M.waves('run-cycle', { root: TMP_A });
  assert.deepStrictEqual(w.waves, [], 'no wave can be scheduled out of a pure cycle');
  assert.deepStrictEqual(w.unschedulable.slice().sort(), ['wp-x', 'wp-y']);
});
t('A9: a DANGLING dep blocks its package (fails closed) and is named, while its sibling stays ready', () => {
  const r = M.ready('run-dangling', { root: TMP_A });
  assert.deepStrictEqual(ids(r.ready), ['wp-ok']);
  assert.deepStrictEqual(r.dangling, [{ wp_id: 'wp-d', missing: ['wp-never-armed'] }]);
  const w = M.waves('run-dangling', { root: TMP_A });
  assert.deepStrictEqual(w.unschedulable, ['wp-d']);
});
t('A10: the frontier core is IMPORTED from forge-beads, not re-implemented (identity, not a copy)', () => {
  assert.strictEqual(typeof M.beadsCore, 'function', 'M.beadsCore is not a function');
  const core = M.beadsCore();
  assert.strictEqual(core.computeReady, BEADS.computeReady, 'computeReady must be the SAME function object forge-beads exports');
  assert.strictEqual(core.computeCycles, BEADS.computeCycles, 'computeCycles must be the SAME function object forge-beads exports');
});
t('A11: ready() output matches a direct forge-beads computeReady() call on the mapped work packages', () => {
  const wps = M.load('run-parallel', { root: TMP_A });
  const direct = BEADS.computeReady(M.wpsToBeads(wps));
  assert.deepStrictEqual(ids(M.ready('run-parallel', { root: TMP_A }).ready), direct.ready.map((b) => b.id));
});
// ANTI-TIEBREAK: pins the STATUS MAPPING itself. An implementation that maps 'failed' to something
// non-actionable would still pass A2-A9 (no fixture above has a failed WP) but fails here.
t('A12: status mapping — done satisfies a dep, failed does NOT, and a failed package is re-dispatchable', () => {
  const beads = M.wpsToBeads([
    { wp_id: 'w1', status: 'done', deps: [] },
    { wp_id: 'w2', status: 'failed', deps: [] },
    { wp_id: 'w3', status: 'armed', deps: [] },
  ]);
  assert.deepStrictEqual(beads.map((b) => [b.id, b.status]), [['w1', 'done'], ['w2', 'open'], ['w3', 'open']]);
  const blocked = BEADS.computeReady(M.wpsToBeads([
    { wp_id: 'w2', status: 'failed', deps: [] },
    { wp_id: 'w4', status: 'armed', deps: ['w2'] },
  ]));
  assert.deepStrictEqual(blocked.ready.map((b) => b.id), ['w2'], 'a failed package is actionable again; its dependent is not');
});
t('A13: ready() fails closed on a run that was never armed (same contract as load())', () => {
  assert.throws(() => M.ready('run-never-armed', { root: TMP_A }), /no manifest found/);
});

const manifestCli = (...args) => spawnSync(NODE, [path.join(__dirname, 'forge-manifest.cjs'), ...args],
  { encoding: 'utf8', env: Object.assign({}, process.env, { FORGE_PROJECT_ROOT: TMP_A }) });
t('A14: CLI `ready --run <id> --json` exits 0 and prints the real frontier', () => {
  const r = manifestCli('ready', '--run', 'run-parallel', '--json');
  assert.strictEqual(r.status, 0, 'exit ' + r.status + ' — ' + (r.stderr || '').trim());
  const parsed = JSON.parse(r.stdout.trim());
  assert.deepStrictEqual(ids(parsed.ready), ['wp-p1', 'wp-p2']);
});
t('A15: CLI `ready` on a cyclic run exits 3 (advisory needs-attention, mirrors forge-beads) and names the cycle', () => {
  const r = manifestCli('ready', '--run', 'run-cycle', '--json');
  assert.strictEqual(r.status, 3, 'exit ' + r.status + ' — ' + (r.stderr || '').trim());
  const parsed = JSON.parse(r.stdout.trim());
  assert.strictEqual(parsed.cycles.length, 1);
  assert.deepStrictEqual(parsed.ready, []);
});
t('A16: CLI `waves --run <id> --json` exits 0 and prints the grouped dispatch order', () => {
  const r = manifestCli('waves', '--run', 'run-parallel', '--json');
  assert.strictEqual(r.status, 0, 'exit ' + r.status + ' — ' + (r.stderr || '').trim());
  const parsed = JSON.parse(r.stdout.trim());
  assert.deepStrictEqual(parsed.waves.map(ids), [['wp-p1', 'wp-p2'], ['wp-p3']]);
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// (b) forge-verify.cjs must actually BRAKE the rework loop with loopConvergence()
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n(b) forge-verify rework brake — loopConvergence() wired into the real CLI');

const V = require('./forge-verify.cjs');
const TMP_B = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-loopbrake-'));
const CLAUDE_B = path.join(TMP_B, '.claude');
fs.mkdirSync(path.join(CLAUDE_B, 'forge-dashboard'), { recursive: true });
// the real shipped logger, copied in — --enforce spawns it as a child, exactly like production does
fs.copyFileSync(path.join(__dirname, '..', 'forge-dashboard', 'log-event.cjs'), path.join(CLAUDE_B, 'forge-dashboard', 'log-event.cjs'));

const verifyCli = (...args) => spawnSync(NODE, [path.join(__dirname, 'forge-verify.cjs'), ...args],
  { encoding: 'utf8', env: Object.assign({}, process.env, { FORGE_STORE_ROOT: CLAUDE_B }) });
const eventsFile = (runId) => path.join(CLAUDE_B, 'forge-runs', runId, 'events.jsonl');
const lineCount = (runId) => fs.readFileSync(eventsFile(runId), 'utf8').trim().split('\n').length;
const newLines = (runId, before) => fs.readFileSync(eventsFile(runId), 'utf8').trim().split('\n').slice(before).map((l) => JSON.parse(l));

// A real mismatch (claims done with an open task) so --enforce has genuine rework to create.
const MISMATCH = [
  { event_type: 'agent_started', agent: 'Build Boss' },
  { event_type: 'check_started', agent: 'Build Boss', task: 'unit tests' }, // never terminated -> open
  { event_type: 'agent_completed', agent: 'Build Boss', status: 'done' },   // claims done anyway
];
// Five rounds, each with a genuinely NEW finding -> never converges, hits the default cap of 5.
const FIVE_NOVEL_ROUNDS = [
  { event_type: 'check_failed', agent: 'Test Boss', issue: 'finding A' },
  { event_type: 'lead_review_started', agent: 'orchestrator' },
  { event_type: 'check_failed', agent: 'Test Boss', issue: 'finding B' },
  { event_type: 'retest_started', agent: 'Test Boss' },
  { event_type: 'check_failed', agent: 'Test Boss', issue: 'finding C' },
  { event_type: 'lead_review_started', agent: 'orchestrator' },
  { event_type: 'check_failed', agent: 'Test Boss', issue: 'finding D' },
  { event_type: 'retest_started', agent: 'Test Boss' },
  { event_type: 'check_failed', agent: 'Test Boss', issue: 'finding E' },
];
// Two rounds, the second repeating the IDENTICAL finding -> zero new findings -> a dry streak.
const DRY_ROUNDS = [
  { event_type: 'check_failed', agent: 'Test Boss', issue: 'the same finding' },
  { event_type: 'retest_started', agent: 'Test Boss' },
  { event_type: 'check_failed', agent: 'Test Boss', issue: 'the same finding' },
];

writeRunEvents(TMP_B, 'run-loop-capped', MISMATCH.concat(FIVE_NOVEL_ROUNDS));
writeRunEvents(TMP_B, 'run-loop-capped-2', MISMATCH.concat(FIVE_NOVEL_ROUNDS));
writeRunEvents(TMP_B, 'run-loop-dry', MISMATCH.concat(DRY_ROUNDS));
writeRunEvents(TMP_B, 'run-loop-fresh', MISMATCH.slice());          // a mismatch, but the loop never ran
writeRunEvents(TMP_B, 'run-loop-advisory', [                        // clean: nobody claims done
  { event_type: 'agent_started', agent: 'Loop Boss' },
].concat(FIVE_NOVEL_ROUNDS));
// B10-B12 fixtures (2026-08-01, brake correction — see the block comment above those tests).
// CLEAN runs: nobody claims done, no tickets, no PRD -> verify reports 0 of everything and exits 0, so
// --enforce has NO rework round to open. Their loops are nevertheless braked (converged / at the cap).
writeRunEvents(TMP_B, 'run-loop-clean-dry', [{ event_type: 'agent_started', agent: 'Loop Boss' }].concat(DRY_ROUNDS));
writeRunEvents(TMP_B, 'run-loop-clean-capped', [{ event_type: 'agent_started', agent: 'Loop Boss' }].concat(FIVE_NOVEL_ROUNDS));
// A genuinely braked run WITH real rework pending — the case the brake is actually for, run three times.
writeRunEvents(TMP_B, 'run-loop-dry-idem', MISMATCH.concat(DRY_ROUNDS));

t('B0: fixture precondition — the pure function really reports hitCap/converged for these fixtures', () => {
  const capped = V.loopConvergence(V.roundsFromEvents(MISMATCH.concat(FIVE_NOVEL_ROUNDS)), { dryStreak: 1, max: 5 });
  assert.strictEqual(capped.rounds, 5);
  assert.strictEqual(capped.hitCap, true);
  assert.strictEqual(capped.converged, false);
  const dry = V.loopConvergence(V.roundsFromEvents(MISMATCH.concat(DRY_ROUNDS)), { dryStreak: 1, max: 5 });
  assert.strictEqual(dry.converged, true);
  assert.strictEqual(dry.hitCap, false);
});

t('B1: the CLI prints a Loop: section carrying the REAL round count', () => {
  const r = verifyCli('run-loop-capped', '--root', TMP_B);
  assert.ok(/^Loop:/m.test(r.stdout), 'no Loop: section in CLI output:\n' + r.stdout);
  assert.ok(/5 round\(s\)/.test(r.stdout), 'Loop: section does not name the real 5 rounds:\n' + r.stdout);
});
t('B2: --json carries a loop block equal to the pure loopConvergence() result', () => {
  const r = verifyCli('run-loop-capped', '--root', TMP_B, '--json');
  const parsed = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
  const expect = V.loopConvergence(V.roundsFromEvents(MISMATCH.concat(FIVE_NOVEL_ROUNDS)), { dryStreak: 1, max: 5 });
  assert.ok(parsed.loop, 'no loop block in --json output');
  assert.strictEqual(parsed.loop.rounds, expect.rounds);
  assert.strictEqual(parsed.loop.converged, expect.converged);
  assert.strictEqual(parsed.loop.hitCap, expect.hitCap);
  assert.deepStrictEqual(parsed.loop.newFindingsByRound, expect.newFindingsByRound);
});
t('B3: a plain (non-enforce) run stays READ-ONLY — the Loop: section logs nothing', () => {
  const before = lineCount('run-loop-fresh');
  verifyCli('run-loop-fresh', '--root', TMP_B);
  assert.strictEqual(lineCount('run-loop-fresh'), before, 'a non-enforce run must never append an event');
});
t('B4: BRAKE — --enforce on a capped loop appends EXACTLY ONE event, and it is quality_gate_blocked', () => {
  const before = lineCount('run-loop-capped');
  const r = verifyCli('run-loop-capped', '--root', TMP_B, '--enforce');
  const added = newLines('run-loop-capped', before);
  assert.deepStrictEqual(added.map((e) => e.event_type), ['quality_gate_blocked'],
    'expected the brake to replace the rework trio, got: ' + JSON.stringify(added.map((e) => e.event_type)) + '\n' + r.stdout);
});
t('B5: the brake event carries the real, checkable numbers (rounds + cap), not a vague note', () => {
  const last = newLines('run-loop-capped', lineCount('run-loop-capped') - 1)[0];
  assert.strictEqual(last.event_type, 'quality_gate_blocked');
  const note = String(last.note || '') + ' ' + String(last.reason || '') + ' ' + String(last.evidence || '');
  assert.ok(/5/.test(note), 'brake note must name the real round count: ' + note);
  assert.ok(/round/i.test(note), 'brake note must say what was capped: ' + note);
});
t('B6: DRY STREAK — --enforce on a loop with no NEW findings also stops instead of spinning', () => {
  const before = lineCount('run-loop-dry');
  verifyCli('run-loop-dry', '--root', TMP_B, '--enforce');
  const added = newLines('run-loop-dry', before);
  assert.deepStrictEqual(added.map((e) => e.event_type), ['quality_gate_blocked']);
});
// ANTI-TIEBREAK 1: an implementation that ALWAYS brakes passes B4/B6 but can never create a first rework.
t('B7: NO brake before the loop has ever run — a fresh mismatch still gets its full rework trio', () => {
  const before = lineCount('run-loop-fresh');
  verifyCli('run-loop-fresh', '--root', TMP_B, '--enforce');
  const added = newLines('run-loop-fresh', before);
  assert.deepStrictEqual(added.map((e) => e.event_type), ['lead_review_completed', 'rework_task_created', 'rework_assigned']);
  assert.ok(!added.some((e) => e.event_type === 'quality_gate_blocked'), 'a loop that never ran must not be braked');
});
// ANTI-TIEBREAK 2: proves the cap is the CONFIGURED number, not a coincidence of this fixture.
t('B8: --max-rounds raises the cap for real — the same capped fixture then gets its rework trio', () => {
  const before = lineCount('run-loop-capped-2');
  verifyCli('run-loop-capped-2', '--root', TMP_B, '--enforce', '--max-rounds', '99');
  const added = newLines('run-loop-capped-2', before);
  assert.deepStrictEqual(added.map((e) => e.event_type), ['lead_review_completed', 'rework_task_created', 'rework_assigned']);
});
t('B9: the loop verdict is ADVISORY in the exit code — an otherwise-clean run with a capped loop exits 0', () => {
  const r = verifyCli('run-loop-advisory', '--root', TMP_B);
  assert.ok(/HARD CAP|hit the cap|hitCap/i.test(r.stdout), 'the capped loop must be visible in the output:\n' + r.stdout);
  assert.strictEqual(r.status, 0, 'exit ' + r.status + ' — the loop check must never gate the exit code\n' + r.stdout);
});

// ── BRAKE CORRECTION (2026-08-01, independent-witness defect 1) ────────────────────────────────────────
// The brake as first shipped ran BEFORE enforce() knew whether it had any rework to open, so on a run that
// verify itself calls clean (0 mismatches / 0 open tickets / 0 unproven / 0 isolation / 0 acceptance gaps,
// exit 0) it turned "write nothing" into "write a red blocker": measured 3 quality_gate_blocked events for
// 3 --enforce passes on one clean run. That event is consumed as a REAL blocker by forge-run-state
// (gates -> blocked), forge-snapshot (GAP_EVENT_TYPES), forge-distill (FAILURE_TYPES), forge-stats and
// forge-briefing (BLOCKED_EVENT_TYPES), so a clean run landed in project history as blocked, repeatedly.
// B10/B11 pin "nothing to brake -> no blocker" for BOTH brake branches (converged and hard cap); B12 pins
// idempotency. B4/B6/B7/B8 above stay the other half of the vice: the brake must still fire, once, exactly
// where there IS a round to stop.
t('B10: CLEAN + converged loop — verify says 0 of everything, so --enforce writes NOTHING (no blocker)', () => {
  const plain = verifyCli('run-loop-clean-dry', '--root', TMP_B);
  assert.strictEqual(plain.status, 0, 'fixture precondition: this run must verify CLEAN, got exit ' + plain.status + '\n' + plain.stdout);
  assert.ok(/VERIFY: 0 mismatch\(es\), 0 open\/unreadable ticket\(s\), 0 unproven done-ticket\(s\), 0 isolation violation\(s\), 0 acceptance gap\(s\)/.test(plain.stdout),
    'fixture precondition: verify must report a fully clean run:\n' + plain.stdout);
  // ANTI-TIEBREAK: without this, a fixture whose loop simply is not braked would pass for the wrong reason.
  assert.ok(/STOP — converged:/.test(plain.stdout), 'fixture precondition: this loop really IS braked:\n' + plain.stdout);
  const before = lineCount('run-loop-clean-dry');
  const r = verifyCli('run-loop-clean-dry', '--root', TMP_B, '--enforce');
  const added = newLines('run-loop-clean-dry', before);
  assert.deepStrictEqual(added.map((e) => e.event_type), [],
    'a clean run must never be marked blocked, got: ' + JSON.stringify(added.map((e) => e.event_type)) + '\n' + r.stdout);
  assert.ok(/ENFORCE: nothing to do/.test(r.stdout), 'enforce must honestly report it had nothing to do:\n' + r.stdout);
});
t('B11: CLEAN + hard-capped loop — same, the cap branch may not invent a blocker either', () => {
  const plain = verifyCli('run-loop-clean-capped', '--root', TMP_B);
  assert.strictEqual(plain.status, 0, 'fixture precondition: this run must verify CLEAN, got exit ' + plain.status + '\n' + plain.stdout);
  assert.ok(/HARD CAP/.test(plain.stdout), 'fixture precondition: this loop really IS at the cap:\n' + plain.stdout);
  const before = lineCount('run-loop-clean-capped');
  const r = verifyCli('run-loop-clean-capped', '--root', TMP_B, '--enforce');
  const added = newLines('run-loop-clean-capped', before);
  assert.deepStrictEqual(added.map((e) => e.event_type), [],
    'a clean run must never be marked blocked, got: ' + JSON.stringify(added.map((e) => e.event_type)) + '\n' + r.stdout);
});
t('B12: IDEMPOTENT — 3x --enforce on the same braked run leaves exactly ONE quality_gate_blocked', () => {
  const before = lineCount('run-loop-dry-idem');
  const r1 = verifyCli('run-loop-dry-idem', '--root', TMP_B, '--enforce');
  verifyCli('run-loop-dry-idem', '--root', TMP_B, '--enforce');
  verifyCli('run-loop-dry-idem', '--root', TMP_B, '--enforce');
  const added = newLines('run-loop-dry-idem', before);
  assert.deepStrictEqual(added.map((e) => e.event_type), ['quality_gate_blocked'],
    '3 enforces must leave 1 blocker (the brake is as idempotent as appendNote), got: ' +
    JSON.stringify(added.map((e) => e.event_type)) + '\n' + r1.stdout);
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
// (c) forge-runwatch.cjs must run AUTOMATICALLY — as a doctor advisory — and name a dead run with evidence
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n(c) forge-doctor run-liveness advisory — forge-runwatch wired into a check that always runs');

const D = require('./forge-doctor.cjs');
const RW = require('./forge-runwatch.cjs');
const TMP_C = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-liveness-'));
const RUNS_C = path.join(TMP_C, '.claude', 'forge-runs');
const NOW_C = Date.parse('2026-08-01T12:00:00Z');
const hoursAgo = (h) => new Date(NOW_C - h * 3600 * 1000).toISOString();

function makeRun(runId, runJson, events) {
  const dir = path.join(RUNS_C, runId);
  fs.mkdirSync(dir, { recursive: true });
  if (runJson) fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(Object.assign({ run_id: runId }, runJson), null, 2), 'utf8');
  if (events) fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  return dir;
}
// the real 30+-hour shape: a terminal event exists, yet the ledger still says "running"
makeRun('run-dead', { status: 'running', started_at: hoursAgo(48) }, [
  { event_type: 'agent_started', agent: 'Build Boss', dispatch_id: 'd1', timestamp: hoursAgo(48) },
  { event_type: 'agent_completed', agent: 'Build Boss', timestamp: hoursAgo(40), note: 'work finished' },
]);
// genuinely hung: started, never terminated, silent for two days
makeRun('run-hung', { status: 'running', started_at: hoursAgo(48) }, [
  { event_type: 'agent_started', agent: 'Test Boss', dispatch_id: 'd2', timestamp: hoursAgo(40) },
]);
// alive right now — must NOT be reported
makeRun('run-live', { status: 'running', started_at: hoursAgo(1) }, [
  { event_type: 'agent_started', agent: 'Review Boss', dispatch_id: 'd3', timestamp: new Date(NOW_C - 60 * 1000).toISOString() },
]);
// honestly closed — must NOT be reported even though it has no terminal agent event
makeRun('run-closed', { status: 'completed', started_at: hoursAgo(48) }, [
  { event_type: 'agent_started', agent: 'Docs Boss', dispatch_id: 'd4', timestamp: hoursAgo(40) },
]);
// marked running, two days old, and never logged a single event
makeRun('run-noevents', { status: 'running', started_at: hoursAgo(48) }, null);

t('C1: forge-doctor exports runLiveness() as a callable check', () => {
  assert.strictEqual(typeof D.runLiveness, 'function', 'D.runLiveness is not a function');
});
t('C2: it reports EXACTLY the three dead runs and neither of the healthy ones', () => {
  const r = D.runLiveness(TMP_C, { now: NOW_C });
  assert.deepStrictEqual(r.findings.map((f) => f.run_id).sort(), ['run-dead', 'run-hung', 'run-noevents']);
  assert.strictEqual(r.ok, false);
});
t('C3: each finding is classified by what the evidence actually shows', () => {
  const byId = {};
  for (const f of D.runLiveness(TMP_C, { now: NOW_C }).findings) byId[f.run_id] = f;
  assert.strictEqual(byId['run-dead'].kind, 'finished_but_open');
  assert.strictEqual(byId['run-hung'].kind, 'stalled');
  assert.strictEqual(byId['run-noevents'].kind, 'no_events');
});
t('C4: the evidence is forge-runwatch\'s OWN terminal event line, not a re-implementation', () => {
  const f = D.runLiveness(TMP_C, { now: NOW_C }).findings.find((x) => x.run_id === 'run-dead');
  const direct = RW.watch('run-dead', { runsDir: RUNS_C, now: NOW_C, stallMs: 6 * 3600 * 1000 });
  assert.deepStrictEqual(f.evidence, direct.evidence);
  assert.strictEqual(f.evidence[0].event_type, 'agent_completed');
  assert.strictEqual(f.overall, direct.overall);
});
t('C5: a run that really IS alive is never reported (kills "flag every running run")', () => {
  const r = D.runLiveness(TMP_C, { now: NOW_C });
  assert.ok(!r.findings.some((f) => f.run_id === 'run-live'), 'a run with a fresh event must not be called dead');
});
t('C6: a run whose ledger honestly says completed is never reported (the status gate is real)', () => {
  const r = D.runLiveness(TMP_C, { now: NOW_C });
  assert.ok(!r.findings.some((f) => f.run_id === 'run-closed'));
  assert.strictEqual(r.checked, 4, 'only the four running-status runs are evaluated');
});
// ANTI-TIEBREAK: proves C5 passed because of the TIME WINDOW, not because run-live is special.
t('C7: shrink the silence window and the live run becomes a finding too — the window is real', () => {
  const r = D.runLiveness(TMP_C, { now: NOW_C, windowMs: 1 });
  assert.ok(r.findings.some((f) => f.run_id === 'run-live'), 'with a 1ms window every silent run must be reported');
});
t('C8: a fresh project with no runs at all is honestly clean, never a fabricated finding', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-liveness-empty-'));
  const r = D.runLiveness(empty, { now: NOW_C });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.checked, 0);
  assert.deepStrictEqual(r.findings, []);
});

function fakeReport(liveness) {
  return {
    ok: true, root: TMP_C, generated_at: '2026-08-01T12:00:00Z',
    checks: {
      node_check: { ok: true, total: 1, failed: 0, failures: [], reason: '' },
      tests: { ok: true, suites: 1, passed: 1, failed: 0 },
      strict_events: { ok: true, known_accepted: true, unknown_rejected: true },
      dashboard_spa: { ok: true, missing: [] },
      leak_scan: { ok: true, scanned: 0, source: 'fs', hits: [], skipped: [] },
    },
    advisory: { run_liveness: liveness },
  };
}
t('C9: printSummary renders a ⚠ run-liveness advisory line naming the dead run', () => {
  const summary = D.printSummary(fakeReport(D.runLiveness(TMP_C, { now: NOW_C })));
  assert.ok(/run liveness \(advisory, non-blocking\)/.test(summary), 'no run-liveness advisory line:\n' + summary);
  assert.ok(/run-dead/.test(summary), 'the advisory line must name the real run:\n' + summary);
});
t('C10: that advisory NEVER turns the doctor red — the summary still ends in ALL GREEN', () => {
  const rep = fakeReport(D.runLiveness(TMP_C, { now: NOW_C }));
  assert.strictEqual(rep.advisory.run_liveness.ok, false, 'precondition: the advisory really is unhealthy');
  const summary = D.printSummary(rep);
  assert.ok(/⇒ ALL GREEN/.test(summary), 'an advisory must never flip the verdict:\n' + summary);
  assert.ok(!/✗ run liveness/.test(summary), 'the advisory must never render as a hard-fail line');
});
t('C11: a clean liveness result renders as a ✓ advisory line with a real count', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-liveness-clean-'));
  const summary = D.printSummary(fakeReport(D.runLiveness(empty, { now: NOW_C })));
  assert.ok(/✓ run liveness \(advisory\)/.test(summary), 'no clean advisory line:\n' + summary);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
