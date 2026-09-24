#!/usr/bin/env node
'use strict';
/** Hermetic tests for forge-verify.cjs. Uses os.mkdtemp fixtures + FORGE_STORE_ROOT (same escape hatch
 *  as forge-store.test.cjs) so nothing ever touches the real project's .claude/. Set FORGE_STORE_ROOT
 *  BEFORE requiring forge-verify.cjs — it resolves forge-store.cjs's CLAUDE_DIR once, at require time. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-verify-test-'));
const CLAUDE_DIR = path.join(TMP, '.claude');
process.env.FORGE_STORE_ROOT = CLAUDE_DIR;
const V = require('./forge-verify.cjs');
const store = require('./forge-store.cjs');

// The CLI's --enforce path spawns the REAL .claude/forge-dashboard/log-event.cjs as a child process (never
// re-implemented here — see forge-verify.cjs's own logEvent() helper). Copy the actual project script into
// the hermetic root ONCE so a CLI --enforce test below exercises the SAME code production uses, not a stub.
// log-event.cjs is self-contained (fs/path/crypto only; CLAUDE_DIR resolved from its own __dirname), so a
// plain file copy is safe and stays hermetic (still never touches the real project's .claude/).
{
  const hermeticDashboardDir = path.join(CLAUDE_DIR, 'forge-dashboard');
  fs.mkdirSync(hermeticDashboardDir, { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'forge-dashboard', 'log-event.cjs'), path.join(hermeticDashboardDir, 'log-event.cjs'));
}

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };

console.log('forge-verify offline tests (hermetic root=' + TMP + ')');

function writeEvents(runId, lines) {
  const dir = path.join(CLAUDE_DIR, 'forge-runs', runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), lines.join('\n') + '\n', 'utf8');
  return dir;
}
const ev = (o) => JSON.stringify(o);

// ---- fixture: run-combo — Build Boss (GENUINE mismatch: 3 done + 3 truly-open tasks) + Test Boss
// (clean, exercises Fix-1 pairing) + one malformed line. Pairing parity (2026-07-10): a
// check_started followed by its check_passed is ONE task, so the mismatch fixture uses starts that
// NEVER got a terminal — the honest "agent left work open" shape.
const comboDir = writeEvents('run-combo', [
  ev({ event_type: 'agent_started', agent: 'Build Boss', status: 'running' }),
  ev({ event_type: 'check_started', agent: 'Build Boss', task: 'lint' }),
  ev({ event_type: 'check_passed', agent: 'Build Boss', task: 'lint' }),        // pairs with the start -> 1 done task
  ev({ event_type: 'file_changed', agent: 'Build Boss', files_changed: ['a.js'] }), // done fact
  ev({ event_type: 'file_changed', agent: 'Build Boss', files_changed: ['b.js'] }), // done fact
  ev({ event_type: 'check_started', agent: 'Build Boss', task: 'unit tests' }), // NEVER terminated -> open
  ev({ event_type: 'check_started', agent: 'Build Boss', task: 'e2e' }),        // NEVER terminated -> open
  ev({ event_type: 'agent_progress', agent: 'Build Boss', note: 'wiring config' }), // running -> open
  '{this is not valid json,,,',                       // malformed — must be skipped, no crash
  ev({ event_type: 'agent_completed', agent: 'Build Boss', status: 'done' }),   // claims done anyway
  ev({ event_type: 'agent_started', agent: 'Test Boss' }),
  ev({ event_type: 'check_started', agent: 'Test Boss', task: 'suite' }),
  ev({ event_type: 'check_passed', agent: 'Test Boss', task: 'suite' }),        // pairs -> 1 done task
  ev({ event_type: 'file_changed', agent: 'Test Boss', files_changed: ['t.js'] }),
  ev({ event_type: 'agent_completed', agent: 'Test Boss' }),
  ev({ event_type: 'agent_note', note: 'no agent field on purpose below' }),
  ev({ agent: '', event_type: 'check_started' }),      // empty agent — must be skipped too
]);

const combo = V.verifyRun(comboDir, {});
const buildBoss = combo.agents.find((a) => a.agent === 'Build Boss');
const testBoss = combo.agents.find((a) => a.agent === 'Test Boss');

t('verifyRun finds both agents', combo.agents.length === 2);
t('Build Boss: tasksTotal=6 (paired start+pass = ONE task)', buildBoss.tasksTotal === 6);
t('Build Boss: tasksDone=3', buildBoss.tasksDone === 3);
t('Build Boss: claimsDone=true', buildBoss.claimsDone === true);
t('Build Boss: mismatch=true (fixture A)', buildBoss.mismatch === true);
t('Build Boss: tasksOpen has 3 entries with title/evIdx/status/event_type', buildBoss.tasksOpen.length === 3 &&
  buildBoss.tasksOpen.every((o) => 'title' in o && 'evIdx' in o && 'status' in o && 'event_type' in o));
t('Build Boss: the open tasks are the never-terminated ones', buildBoss.tasksOpen.every((o) => o.event_type === 'check_started' || o.event_type === 'agent_progress'));
t('Test Boss: tasksTotal=2 (pairing collapses start+pass), tasksDone=2', testBoss.tasksTotal === 2 && testBoss.tasksDone === 2);
t('Test Boss: mismatch=false (fixture B)', testBoss.mismatch === false);
t('overall mismatches count = 1', combo.mismatches === 1);
t('malformed line was skipped, not thrown', combo.malformed === 1);
t('agent_started/agent_completed do not inflate tasksTotal (BACKBONE)', buildBoss.tasksTotal === 6);

// ---- taxonomy parity (Fix 2): one-shot FACT events count as done tasks, exactly like the dashboard ----
const factsDir = writeEvents('run-facts', [
  ev({ event_type: 'run_started', agent: 'orchestrator' }),
  ev({ event_type: 'ticket_created', agent: 'orchestrator', ticket_id: 'tk-1' }),
  ev({ event_type: 'ticket_created', agent: 'orchestrator', ticket_id: 'tk-2' }),
  ev({ event_type: 'cost_sampled', agent: 'orchestrator', tokens: 1200 }),
  ev({ event_type: 'agent_completed', agent: 'orchestrator' }),
]);
const facts = V.verifyRun(factsDir, {});
const orch = facts.agents.find((a) => a.agent === 'orchestrator');
t('taxonomy parity: ticket_created/cost_sampled count as done (3/3, no false 0/3)', orch.tasksTotal === 3 && orch.tasksDone === 3 && orch.mismatch === false);

// ---- fixture: run-clean-only — a single fully-clean agent, no tickets tied to this run ----
const cleanDir = writeEvents('run-clean-only', [
  ev({ event_type: 'agent_started', agent: 'Test Boss' }),
  ev({ event_type: 'check_passed', agent: 'Test Boss' }),
  ev({ event_type: 'agent_completed', agent: 'Test Boss' }),
]);
const clean = V.verifyRun(cleanDir, {});
t('run-clean-only: zero mismatches', clean.mismatches === 0);

// ---- verifyRun on a missing run dir -> clean, non-crashing error ----
let threw = null;
try { V.verifyRun(path.join(CLAUDE_DIR, 'forge-runs', 'does-not-exist'), {}); } catch (e) { threw = e; }
t('verifyRun on missing dir throws', threw instanceof Error);
t('verifyRun missing-dir error message is clean/informative', threw && /events\.jsonl/.test(threw.message));

// ---- ticket fixture: one OPEN ticket tied to run-combo, one DONE ticket (must not show as open) ----
store.putEntity('tickets', 'tk-open-1', {
  ticket_id: 'tk-open-1', run_id: 'run-combo', title: 'Finish the remaining checks', status: 'open', created: new Date().toISOString(),
});
store.putEntity('tickets', 'tk-done-1', {
  ticket_id: 'tk-done-1', run_id: 'run-combo', title: 'Already finished', status: 'done', created: new Date().toISOString(),
});
// test-first rule fixtures: a DONE ticket with required_tests but NO test_evidence = UNPROVEN;
// with test_evidence = clean.
store.putEntity('tickets', 'tk-unproven-1', {
  ticket_id: 'tk-unproven-1', run_id: 'run-combo', title: 'auth works', status: 'done',
  required_tests: ['auth.test.cjs'], created: new Date().toISOString(),
});
store.putEntity('tickets', 'tk-proven-1', {
  ticket_id: 'tk-proven-1', run_id: 'run-combo', title: 'login works', status: 'done',
  required_tests: ['login.test.cjs'], test_evidence: 'node login.test.cjs -> 12 passed, 0 failed', created: new Date().toISOString(),
});
const tix = V.verifyTickets({ run_id: 'run-combo' });
t('verifyTickets finds all four tickets for the run', tix.tickets.length === 4);
t('verifyTickets.open lists only the open ticket', tix.open.length === 1 && tix.open[0].ticket_id === 'tk-open-1');
t('test-first: done + required_tests + NO test_evidence -> UNPROVEN', tix.unproven.length === 1 && tix.unproven[0].ticket_id === 'tk-unproven-1');
t('test-first: done + required_tests + test_evidence -> clean', !tix.unproven.some((tk) => tk.ticket_id === 'tk-proven-1'));
t('test-first: done WITHOUT required_tests -> not unproven', !tix.unproven.some((tk) => tk.ticket_id === 'tk-done-1'));
const tixOther = V.verifyTickets({ run_id: 'run-clean-only' });
t('verifyTickets scoped to a different run_id finds none', tixOther.tickets.length === 0 && tixOther.open.length === 0 && tixOther.unproven.length === 0);

// ---- buildEnforceEvents: pure payload builder, registered event types only ----
const REGISTERED = new Set(['lead_review_started', 'lead_review_completed', 'rework_task_created', 'rework_assigned', 'ticket_updated', 'agent_note']);
const built = V.buildEnforceEvents(buildBoss);
t('buildEnforceEvents returns exactly 3 events', built.length === 3);
t('buildEnforceEvents uses ONLY registered event_type names', built.every((e) => REGISTERED.has(e.event_type)));
t('buildEnforceEvents never emits event_type "done" or similar invented type', !built.some((e) => /done|closed|resolve/i.test(e.event_type)));
const lrc = built.find((e) => e.event_type === 'lead_review_completed');
t('lead_review_completed carries agent=orchestrator + note + evidence', lrc.extra.agent === 'orchestrator' && typeof lrc.extra.note === 'string' && typeof lrc.extra.evidence === 'string');
t('lead_review_completed note mentions the mismatched agent and the fraction', lrc.extra.note.includes('Build Boss') && lrc.extra.note.includes('3/6'));
const rtc = built.find((e) => e.event_type === 'rework_task_created');
t('rework_task_created targets the mismatched agent', rtc.extra.target === 'Build Boss');
t('rework_task_created carries issue + required_fix', typeof rtc.extra.issue === 'string' && typeof rtc.extra.required_fix === 'string');
const ra = built.find((e) => e.event_type === 'rework_assigned');
t('rework_assigned addressed to the mismatched agent', ra.extra.to === 'Build Boss');
t('buildEnforceEvents never marks anything as done (no status:done anywhere)', !built.some((e) => e.extra.status === 'done'));

// ---- exported constants stay in sync with app.js (spot checks, not exhaustive) ----
t('TERMINAL_TYPES includes check_passed', V.TERMINAL_TYPES.has('check_passed'));
t('TERMINAL_TYPES includes agent_completed', V.TERMINAL_TYPES.has('agent_completed'));
t('TERMINAL_TYPES does NOT include check_started (running, not done)', !V.TERMINAL_TYPES.has('check_started'));
t('BACKBONE includes agent_completed', V.BACKBONE.has('agent_completed'));
t('BACKBONE includes run_started', V.BACKBONE.has('run_started'));
t('BACKBONE does NOT include check_passed (a real task type)', !V.BACKBONE.has('check_passed'));

// ---- CLI smoke tests (spawned child process, same hermetic FORGE_STORE_ROOT) ----
const cliEnv = Object.assign({}, process.env, { FORGE_STORE_ROOT: CLAUDE_DIR });
const runCli = (...args) => spawnSync(process.execPath, [path.join(__dirname, 'forge-verify.cjs'), ...args], { env: cliEnv, encoding: 'utf8' });

const cliMismatch = runCli('run-combo', '--root', TMP, '--json');
t('CLI exits 1 on the mismatched fixture (run-combo)', cliMismatch.status === 1);
t('CLI prints the MISMATCH marker for Build Boss', /MISMATCH Build Boss/.test(cliMismatch.stdout));
t('CLI prints the UNPROVEN DONE marker for the test-first violation', /UNPROVEN DONE tk-unproven-1/.test(cliMismatch.stdout));
t('CLI --json output parses and reports mismatches=1', (() => {
  try { const j = JSON.parse(cliMismatch.stdout.slice(cliMismatch.stdout.indexOf('{'))); return j.mismatches === 1; } catch { return false; }
})());

const cliClean = runCli('run-clean-only', '--root', TMP);
t('CLI exits 0 on the clean fixture (run-clean-only, no open tickets)', cliClean.status === 0);

const cliBadRunId = runCli('../evil', '--root', TMP);
t('CLI rejects a traversal-looking run_id (non-zero exit)', cliBadRunId.status !== 0);

const cliMissingRun = runCli('does-not-exist-run', '--root', TMP);
t('CLI on a missing run prints a clean error and exits non-zero', cliMissingRun.status !== 0 && /forge-verify:/.test(cliMissingRun.stderr));

// ---- MUTATION-TESTING SURVIVOR PINS (WP3 Spoor C, 2026-07-14) — the "rework-gate" honesty core.
// forge-mutate.cjs found these exact gate-decision weakenings surviving against the pre-existing suite.
// See build-boss's report for the exact red-then-restored proof per survivor.

// 7d) THE core exit-code gate combinator: `mismatches===0 && open.length===0 && unproven.length===0`.
// The pre-existing "run-combo" fixture has ALL THREE conditions simultaneously bad, so it can never
// distinguish && from || (both short-circuit to the same "fail" result). These three ISOLATED fixtures
// each have exactly ONE bad condition and the other two clean — the shape that actually forces && vs ||
// apart, and the shape a real "an unproven done was silently accepted" bug would look like.
const openOnlyDir = writeEvents('run-open-only', [
  ev({ event_type: 'agent_started', agent: 'Clean Boss' }),
  ev({ event_type: 'check_passed', agent: 'Clean Boss' }),
  ev({ event_type: 'agent_completed', agent: 'Clean Boss' }),
]);
store.putEntity('tickets', 'tk-open-only-1', { ticket_id: 'tk-open-only-1', run_id: 'run-open-only', title: 'still open', status: 'open', created: new Date().toISOString() });
const openOnly = V.verifyRun(openOnlyDir, {});
const openOnlyTix = V.verifyTickets({ run_id: 'run-open-only' });
t('7d-setup: run-open-only has ZERO agent mismatches (isolates the open-ticket axis)', openOnly.mismatches === 0);
t('7d-setup: run-open-only has exactly ONE open ticket, ZERO unproven', openOnlyTix.open.length === 1 && openOnlyTix.unproven.length === 0);
const cliOpenOnly = runCli('run-open-only', '--root', TMP);
t('7d1: CLI exits 1 when mismatches=0 AND unproven=0 but an OPEN ticket remains (kills the && -> || gate bypass)', cliOpenOnly.status === 1);

const unprovenOnlyDir = writeEvents('run-unproven-only', [
  ev({ event_type: 'agent_started', agent: 'Clean Boss 2' }),
  ev({ event_type: 'check_passed', agent: 'Clean Boss 2' }),
  ev({ event_type: 'agent_completed', agent: 'Clean Boss 2' }),
]);
store.putEntity('tickets', 'tk-unproven-only-1', { ticket_id: 'tk-unproven-only-1', run_id: 'run-unproven-only', title: 'needs evidence', status: 'done', required_tests: ['x.test.cjs'], created: new Date().toISOString() });
const unprovenOnly = V.verifyRun(unprovenOnlyDir, {});
const unprovenOnlyTix = V.verifyTickets({ run_id: 'run-unproven-only' });
t('7d-setup: run-unproven-only has ZERO mismatches and ZERO open tickets (isolates the unproven axis)', unprovenOnly.mismatches === 0 && unprovenOnlyTix.open.length === 0);
t('7d-setup: run-unproven-only has exactly ONE unproven done-ticket', unprovenOnlyTix.unproven.length === 1);
const cliUnprovenOnly = runCli('run-unproven-only', '--root', TMP);
t('7d2: CLI exits 1 when mismatches=0 AND open=0 but an UNPROVEN done-ticket remains (an unproven "done" must never be silently accepted)', cliUnprovenOnly.status === 1);

// 7e) evidence-requirement TRIGGER boundary: a done ticket with an EXPLICITLY EMPTY required_tests
// array ("no tests are required for this ticket") must never be flagged unproven — only a NON-empty
// required_tests[] without test_evidence should be. Pins the `.length > 0` boundary against a `>= 0`
// weakening (which would flag every done ticket carrying a required_tests key at all, even an empty one).
store.putEntity('tickets', 'tk-empty-required', { ticket_id: 'tk-empty-required', run_id: 'run-empty-required', title: 'no tests needed', status: 'done', required_tests: [], created: new Date().toISOString() });
const emptyRequiredTix = V.verifyTickets({ run_id: 'run-empty-required' });
t('7e1: a done ticket with an EMPTY required_tests[] is NOT flagged unproven', !emptyRequiredTix.unproven.some((tk) => tk.ticket_id === 'tk-empty-required'));

// 7f) statusClass() "done" bucket must not become a catch-all: an event carrying an UNRECOGNIZED
// explicit status string (matching none of internal/preview/failed/done/waiting/running keywords) must
// stay non-done — never silently accepted as finished work.
const mysteryDir = writeEvents('run-mystery-status', [
  ev({ event_type: 'agent_progress', agent: 'Mystery Boss', status: 'mystery-status-xyz' }),
  ev({ event_type: 'agent_completed', agent: 'Mystery Boss' }),
]);
const mysteryResult = V.verifyRun(mysteryDir, {});
const mysteryBoss = mysteryResult.agents.find((a) => a.agent === 'Mystery Boss');
t('7f1: an event with an unrecognized explicit status string is never classified as a done task', mysteryBoss.tasksDone === 0 && mysteryBoss.tasksTotal === 1);
t('7f2: Mystery Boss claims done (agent_completed) with its one task still unclassified-as-done -> mismatch=true', mysteryBoss.mismatch === true);

// 7g) ROUTER GUARD pin (L131 `if (e.status) return statusClass(e.status);`) — an explicit non-done status
// on a TERMINAL-event-type task must WIN over the event_type's own TERMINAL_TYPES-implied 'done'. Using
// `subagent_completed` here would NOT exercise this at all — that event_type is itself a BACKBONE type
// (see verifyRun's `if (BACKBONE.has(t)) return;`, which runs BEFORE any task is ever created), so it never
// becomes a task record regardless of status. `check_passed` is a real TERMINAL_TYPES member that is NOT
// BACKBONE and needs no paired check_started to become its own task (the pairing lookup simply finds no
// open task and falls through to a fresh push) — the correct fixture shape to actually route the event
// through taskStatus(e)'s L131 guard.
const routerGuardDir = writeEvents('run-router-guard', [
  ev({ event_type: 'agent_started', agent: 'Router Boss' }),
  ev({ event_type: 'check_passed', agent: 'Router Boss', task: 'integration check', status: 'failed' }), // terminal event_type + explicit non-done status
  ev({ event_type: 'agent_completed', agent: 'Router Boss' }),
]);
const routerGuardResult = V.verifyRun(routerGuardDir, {});
const routerBoss = routerGuardResult.agents.find((a) => a.agent === 'Router Boss');
t('7g1: a check_passed event carrying an explicit status:"failed" is NOT counted as done (explicit status wins over the terminal event_type)', routerBoss.tasksDone === 0 && routerBoss.tasksTotal === 1);
t('7g2: Router Boss claims done but its one task is genuinely open (failed) -> mismatch=true (the gate must still block)', routerBoss.mismatch === true);

// ================================================================================================
// WAVE A (2026-07-18) — isolationTripwire + loop-until-dry (roundsFromEvents/loopConvergence)
// ================================================================================================

// ---- isolationTripwire ----
// TMP is both the fixture "project root" (matches how the CLI derives projectRoot from --root) and the
// parent of CLAUDE_DIR, so a real forge-runs/<id>/events.jsonl lives under it exactly like production.
const isoCleanDir = writeEvents('run-iso-clean', [
  ev({ event_type: 'agent_started', agent: 'Build Boss' }),
  ev({ event_type: 'file_changed', agent: 'Build Boss', path: 'src/app.js' }),
  ev({ event_type: 'file_changed', agent: 'Build Boss', files_changed: ['src/a.js', 'src/b.js'] }),
  ev({ event_type: 'command_run', agent: 'Build Boss', command: 'npm test', output_path: path.join(TMP, 'log.txt') }),
  ev({ event_type: 'agent_completed', agent: 'Build Boss' }),
]);
const isoClean = V.isolationTripwire(isoCleanDir, TMP);
t('isolationTripwire: all-inside-root run is ok:true', isoClean.ok === true);
t('isolationTripwire: checked counts every path-bearing field (1 + 2 + 1 = 4)', isoClean.checked === 4);
t('isolationTripwire: zero violations on a clean run', isoClean.violations.length === 0);

const isoEmptyDir = writeEvents('run-iso-empty', [
  ev({ event_type: 'agent_started', agent: 'Build Boss' }),
  ev({ event_type: 'agent_note', agent: 'Build Boss', note: 'planning only, nothing written yet' }),
  ev({ event_type: 'agent_completed', agent: 'Build Boss' }),
]);
const isoEmpty = V.isolationTripwire(isoEmptyDir, TMP);
t('isolationTripwire: a run with zero path-bearing events is ok:true with checked:0 (labeled, not a false clean)', isoEmpty.ok === true && isoEmpty.checked === 0);

const isoRelEscapeDir = writeEvents('run-iso-rel-escape', [
  ev({ event_type: 'file_changed', agent: 'Build Boss', path: '../../outside-project/secret.txt' }),
]);
const isoRelEscape = V.isolationTripwire(isoRelEscapeDir, TMP);
t('isolationTripwire: a ../ relative escape is flagged', isoRelEscape.ok === false && isoRelEscape.violations.length === 1);
t('isolationTripwire: violation carries evIdx/event_type/field/path/reason', (() => {
  const v = isoRelEscape.violations[0];
  return v.evIdx === 0 && v.event_type === 'file_changed' && v.field === 'path' && /outside-project/.test(v.path) && /outside project root/.test(v.reason);
})());

const OUTSIDE_ABS = path.join(os.tmpdir(), 'forge-verify-outside-fixture-' + process.pid);
const isoAbsEscapeDir = writeEvents('run-iso-abs-escape', [
  ev({ event_type: 'file_changed', agent: 'Build Boss', path: OUTSIDE_ABS }),
]);
const isoAbsEscape = V.isolationTripwire(isoAbsEscapeDir, TMP);
t('isolationTripwire: an absolute path outside root is flagged', isoAbsEscape.ok === false && isoAbsEscape.violations.length === 1);

const isoArrayEscapeDir = writeEvents('run-iso-array-escape', [
  ev({ event_type: 'file_changed', agent: 'Build Boss', files_changed: ['src/a.js', '../escaped.js'] }),
]);
const isoArrayEscape = V.isolationTripwire(isoArrayEscapeDir, TMP);
t('isolationTripwire: an escape hiding inside files_changed[] (alongside a clean entry) is flagged', isoArrayEscape.violations.length === 1 &&
  isoArrayEscape.violations[0].field === 'files_changed' && /escaped\.js/.test(isoArrayEscape.violations[0].path));

const isoIgnoredTypeDir = writeEvents('run-iso-ignored-type', [
  ev({ event_type: 'agent_note', agent: 'Build Boss', note: 'not a tracked type', path: '../../outside/should-be-ignored.txt' }),
]);
const isoIgnoredType = V.isolationTripwire(isoIgnoredTypeDir, TMP);
t('isolationTripwire: a path field on a NON-tracked event_type is not scanned (only file_changed/file_read/command_run/custom_skill_* are)', isoIgnoredType.checked === 0 && isoIgnoredType.ok === true);

t('isolationTripwire: reuses forge-actiongate.isPathEscape when available (same verdict as forge-actiongate directly)', (() => {
  const actiongate = require('./forge-actiongate.cjs');
  return V.isPathOutsideRoot(TMP, '../escape-check.txt') === actiongate.isPathEscape(TMP, '../escape-check.txt');
})());

// ---- isolationTripwire wired into the CLI ----
const cliIsoViolation = runCli('run-iso-rel-escape', '--root', TMP);
t('CLI: exits 1 on a run with an isolation violation (folds into the gate exit code)', cliIsoViolation.status === 1);
t('CLI: prints the ISOLATION marker with the offending path', /ISOLATION file_changed path=".*outside-project.*secret\.txt"/.test(cliIsoViolation.stdout));

const cliIsoClean = runCli('run-iso-clean', '--root', TMP, '--json');
t('CLI: a run clean on mismatches/tickets/isolation exits 0', cliIsoClean.status === 0);
t('CLI: prints the clean isolation line with a real checked count', /no isolation violations \(4 path\(s\) checked\)/.test(cliIsoClean.stdout));
t('CLI --json: isolation block is present with ok:true and the real checked count', (() => {
  try { const j = JSON.parse(cliIsoClean.stdout.slice(cliIsoClean.stdout.indexOf('{'))); return j.isolation && j.isolation.ok === true && j.isolation.checked === 4; } catch { return false; }
})());

// ---- roundsFromEvents ----
const noBoundaryEvents = [
  { event_type: 'rework_task_created', issue: 'lint fails' },
  { event_type: 'check_failed', task: 'unit' },
];
t('roundsFromEvents: findings before any boundary all land in round 0', (() => {
  const rounds = V.roundsFromEvents(noBoundaryEvents);
  return rounds.length === 1 && rounds[0].length === 2;
})());

const boundaryEvents = [
  { event_type: 'rework_task_created', issue: 'lint fails' },
  { event_type: 'lead_review_started' },
  { event_type: 'rework_task_created', issue: 'lint fails' }, // same finding recurring
  { event_type: 'retest_started' },
  { event_type: 'check_failed', task: 'e2e' }, // genuinely new
];
const splitRounds = V.roundsFromEvents(boundaryEvents);
t('roundsFromEvents: lead_review_started/retest_started split into 3 rounds', splitRounds.length === 3);
t('roundsFromEvents: round 0 has the initial finding, round 1 the recurrence, round 2 the new one', splitRounds[0].length === 1 && splitRounds[1].length === 1 && splitRounds[2].length === 1);
t('roundsFromEvents: BACKBONE/unrelated event types (e.g. agent_progress) are not counted as findings', (() => {
  const rounds = V.roundsFromEvents([{ event_type: 'agent_progress', note: 'working' }, { event_type: 'rework_task_created', issue: 'x' }]);
  return rounds[0].length === 1;
})());

// ---- loopConvergence ----
t('loopConvergence: empty rounds[] is never converged', V.loopConvergence([]).converged === false && V.loopConvergence([]).rounds === 0);
t('loopConvergence: a single round with zero findings converges immediately (default dryStreak=1)', V.loopConvergence([[]]).converged === true);
t('loopConvergence: a single round WITH findings does not converge', V.loopConvergence([['a']]).converged === false);

const dryTail = V.loopConvergence([['a'], [], []]); // finding, then two genuinely clean rounds
t('loopConvergence: [f, empty, empty] converges with default dryStreak=1 (last round is clean)', dryTail.converged === true && dryTail.dryStreak === 2);

t('loopConvergence: dryStreak=2 requires TWO trailing clean rounds — [f, empty, empty] converges', V.loopConvergence([['a'], [], []], { dryStreak: 2 }).converged === true);
t('loopConvergence: dryStreak=2 with only ONE trailing clean round does NOT converge yet', V.loopConvergence([['a'], []], { dryStreak: 2 }).converged === false);

// dedup-by-signature: the SAME finding recurring in a later round must NOT count as "new" — this is the
// core anti-fabrication logic (a real convergence check must not be fooled by an agent re-surfacing the
// identical unresolved issue every round and calling that "clean").
const recurring = V.loopConvergence([['dup-issue'], ['dup-issue']]);
t('loopConvergence: a recurring IDENTICAL finding in round 2 counts as ZERO new findings (dedup, not blind "round is non-empty")', recurring.newFindingsByRound[1] === 0 && recurring.converged === true);

const genuinelyNew = V.loopConvergence([['issue-a'], ['issue-b']]);
t('loopConvergence: a DIFFERENT finding in round 2 counts as 1 new finding — does not converge', genuinelyNew.newFindingsByRound[1] === 1 && genuinelyNew.converged === false);

t('loopConvergence: hitCap reports true once round count reaches max, independent of convergence', V.loopConvergence([['a'], ['b'], ['c']], { max: 3 }).hitCap === true);
t('loopConvergence: hitCap stays false below max', V.loopConvergence([['a'], ['b']], { max: 3 }).hitCap === false);

t('loopConvergence: never mutates its input rounds array', (() => {
  const input = [['a'], []];
  const snapshot = JSON.stringify(input);
  V.loopConvergence(input, { dryStreak: 2 });
  return JSON.stringify(input) === snapshot;
})());

// ---- end-to-end: real events -> roundsFromEvents -> loopConvergence, same recurring-issue scenario
// a real rework loop would hit (agent reports the SAME unresolved finding twice, so it must not converge
// as "dry" after only the recurrence — it converges only once a round genuinely adds nothing new).
const e2eRounds = V.roundsFromEvents([
  { event_type: 'check_failed', task: 'auth flow broken' },
  { event_type: 'lead_review_started' },
  { event_type: 'check_failed', task: 'auth flow broken' }, // still broken, same issue
  { event_type: 'retest_started' },
  { event_type: 'check_failed', task: 'auth flow broken' }, // still broken, same issue again
]);
const e2eConverged = V.loopConvergence(e2eRounds, { dryStreak: 2 });
t('e2e: a finding that recurs unchanged across 3 rounds converges once 2 trailing rounds add nothing NEW (even though every round is non-empty)', e2eConverged.converged === true);
t('e2e: newFindingsByRound is [1,0,0] — only the FIRST sighting of the recurring issue counts as new', JSON.stringify(e2eConverged.newFindingsByRound) === JSON.stringify([1, 0, 0]));

// ================================================================================================
// WAVE C / C-INTEGRATE (2026-07-18) — evidenceCheck() + --domain CLI wiring (required-evidence gate)
// ================================================================================================

// ---- evidenceCheck: unknown/falsy domain -> null (explicit "not applicable", never a fake pass) ----
t('evidenceCheck: no domain -> null', V.evidenceCheck([], null, {}) === null);
t('evidenceCheck: empty-string domain -> null', V.evidenceCheck([], '', {}) === null);
t('evidenceCheck: unknown domain -> null (not a fake ok:true)', V.evidenceCheck([], 'not-a-real-domain', {}) === null);

// ---- evidenceCheck: website domain, missing everything (no artifacts/events in this run) ----
const webMissing = V.evidenceCheck([
  { event_type: 'agent_started', agent: 'UI Boss' },
  { event_type: 'agent_completed', agent: 'UI Boss' },
], 'website', {});
t('evidenceCheck: website with zero evidence -> ok:false, all 4 items missing', webMissing && webMissing.ok === false && webMissing.missing.length === 4);
t('evidenceCheck: website missing includes the real evidence ids', webMissing && ['responsive-screenshot-mobile', 'responsive-screenshot-tablet', 'responsive-screenshot-desktop', 'zero-console-errors-note'].every((id) => webMissing.missing.includes(id)));

// ---- evidenceCheck: website domain, evidence derived from REAL logged event fields (artifact substrings
// + event types) — proves the run->artifacts/events projection actually works, not just a passthrough ----
const webSatisfied = V.evidenceCheck([
  { event_type: 'browser_screenshot_captured', agent: 'UI Boss', screenshot_path: 'artifacts/mobile-390.png' },
  { event_type: 'browser_screenshot_captured', agent: 'UI Boss', screenshot_path: 'artifacts/tablet-768.png' },
  { event_type: 'browser_screenshot_captured', agent: 'UI Boss', screenshot_path: 'artifacts/desktop-1440.png' },
  { event_type: 'zero_console_errors_noted', agent: 'UI Boss', note: 'zero console errors at all 3 breakpoints' },
], 'website', {});
t('evidenceCheck: website with real matching artifacts+event -> ok:true, 0 missing', webSatisfied && webSatisfied.ok === true && webSatisfied.missing.length === 0);
t('evidenceCheck: website satisfied includes all 4 real ids', webSatisfied && webSatisfied.satisfied.length === 4);

// ---- evidenceCheck: files_changed[] array field also counts as an artifact source ----
const webViaFilesChanged = V.evidenceCheck([
  { event_type: 'file_changed', agent: 'UI Boss', files_changed: ['screenshots/mobile-375.png', 'screenshots/tablet-768.png', 'screenshots/desktop-1920.png', 'reports/zero-console-errors.txt'] },
], 'website', {});
t('evidenceCheck: files_changed[] entries alone satisfy website evidence (artifact substrings only, no event needed)', webViaFilesChanged && webViaFilesChanged.ok === true);

// ---- evidenceCheck: fullstack domain (artifact_or_event kind) ----
const fullstackPartial = V.evidenceCheck([
  { event_type: 'e2e_passed', agent: 'Test Boss', note: 'e2e suite green' },
], 'fullstack', {});
t('evidenceCheck: fullstack with only e2e_passed logged -> integration-gate-result still missing', fullstackPartial && fullstackPartial.ok === false
  && fullstackPartial.satisfied.includes('e2e-test-result') && fullstackPartial.missing.includes('integration-gate-result'));

// ---- evidenceCheck: tooling domain (2026-07-22 — closes the real "no tooling domain in required-evidence.json"
// gap the forge-2026-07-22-v9-selfaudit self-audit run surfaced honestly). Proves the standard both ways on a
// REALISTIC run-event shape (mirroring the real self-audit run's own event fields), not a toy fixture. ----
const toolingLazy = V.evidenceCheck([
  { event_type: 'agent_started', agent: 'Build Boss', runtime: 'internal' },
  { event_type: 'agent_completed', agent: 'Build Boss' },
], 'tooling', {});
t('evidenceCheck: a lazy tooling run (dispatch only — no verified check, no report, no audit artifact) -> ok:false, all 3 items missing', toolingLazy && toolingLazy.ok === false && toolingLazy.missing.length === 3);

const toolingGenuine = V.evidenceCheck([
  { event_type: 'agent_started', agent: 'Build Boss', runtime: 'internal' },
  { event_type: 'check_passed', agent: 'Build Boss', command: 'node .claude/forge-bin/forge-doctor.cjs', exit_code: 0, evidence: 'forge-doctor ALL GREEN 88 suites/4276 tests' },
  { event_type: 'audit_iteration', agent: 'Build Boss', iteration: 1, note: 'real forge-audit-loop.cjs iteration' },
  { event_type: 'report_generated', agent: 'Build Boss', path: 'final-report.md' },
], 'tooling', {});
t('evidenceCheck: a genuine tooling run (verified check_passed + real audit_iteration + a real final-report artifact ref) -> ok:true, nothing missing', toolingGenuine && toolingGenuine.ok === true && toolingGenuine.missing.length === 0);

const toolingNoReport = V.evidenceCheck([
  { event_type: 'check_passed', agent: 'Build Boss', command: 'node .claude/forge-bin/forge-doctor.cjs', exit_code: 0, evidence: 'ALL GREEN' },
  { event_type: 'audit_iteration', agent: 'Build Boss', iteration: 1 },
], 'tooling', {});
t('evidenceCheck: a tooling run WITHOUT a real report artifact (only verification+audit) -> ok:false, final-report-artifact genuinely missing (the standard bites, not a rubber stamp)', toolingNoReport && toolingNoReport.ok === false
  && toolingNoReport.missing.length === 1 && toolingNoReport.missing[0] === 'final-report-artifact');

const toolingNoVerification = V.evidenceCheck([
  { event_type: 'report_generated', agent: 'Build Boss', path: 'final-report.md' },
  { event_type: 'audit_iteration', agent: 'Build Boss', iteration: 1 },
], 'tooling', {});
t('evidenceCheck: a tooling run WITHOUT any real verification signal (only report+audit) -> ok:false, verified-check-or-doctor-run genuinely missing', toolingNoVerification && toolingNoVerification.ok === false
  && toolingNoVerification.missing.length === 1 && toolingNoVerification.missing[0] === 'verified-check-or-doctor-run');

// ---- evidenceCheck: 'artifact_id' field gap fix (2026-07-26, fix-ronde wp5) — forge-artifact.cjs's real
// `artifact_stored` event shape ({agent, artifact_id, kind, title}, see forge-artifact.cjs) carries NONE of
// the pre-existing 5 EVIDENCE_ARTIFACT_FIELDS, so a genuinely-registered artifact was previously invisible
// to this gate. These tests use the REAL event shape forge-artifact.cjs actually emits, not a toy fixture. ----
const toolingArtifactStoredMatches = V.evidenceCheck([
  { event_type: 'check_passed', agent: 'Build Boss', command: 'node .claude/forge-bin/forge-doctor.cjs', exit_code: 0, evidence: 'ALL GREEN' },
  { event_type: 'audit_iteration', agent: 'Build Boss', iteration: 1 },
  { event_type: 'artifact_stored', agent: 'report-writer', artifact_id: 'final-report-full-audit', kind: '', title: 'Final report' },
], 'tooling', {});
t("evidenceCheck: an artifact_stored event whose artifact_id CONTAINS the required substring ('final-report-full-audit' contains 'final-report') satisfies that evidence item", toolingArtifactStoredMatches
  && toolingArtifactStoredMatches.ok === true && toolingArtifactStoredMatches.satisfied.includes('final-report-artifact'));

// load-bearing anti-false-pass test: an artifact_stored event whose id does NOT contain the required
// substring must NOT satisfy it — proves this is still real substring matching, not "any artifact_stored
// event satisfies anything".
const toolingArtifactStoredNoMatch = V.evidenceCheck([
  { event_type: 'check_passed', agent: 'Build Boss', command: 'node .claude/forge-bin/forge-doctor.cjs', exit_code: 0, evidence: 'ALL GREEN' },
  { event_type: 'audit_iteration', agent: 'Build Boss', iteration: 1 },
  { event_type: 'artifact_stored', agent: 'report-writer', artifact_id: 'unrelated-scratch-note', kind: '', title: 'Something else entirely' },
], 'tooling', {});
t('evidenceCheck: an artifact_stored event whose artifact_id does NOT contain the required substring does NOT satisfy it (no blanket pass)', toolingArtifactStoredNoMatch
  && toolingArtifactStoredNoMatch.ok === false && toolingArtifactStoredNoMatch.missing.includes('final-report-artifact')
  && !toolingArtifactStoredNoMatch.satisfied.includes('final-report-artifact'));

// empty/missing artifact_id must contribute nothing (no fabricated evidence from a blank/absent id)
const toolingArtifactStoredEmptyId = V.evidenceCheck([
  { event_type: 'artifact_stored', agent: 'report-writer', artifact_id: '', kind: '', title: 'final-report but empty id' },
  { event_type: 'artifact_stored', agent: 'report-writer', kind: '', title: 'final-report but missing id field' },
], 'tooling', {});
t('evidenceCheck: artifact_stored with an empty or missing artifact_id contributes nothing (title is never harvested)', toolingArtifactStoredEmptyId
  && !toolingArtifactStoredEmptyId.satisfied.includes('final-report-artifact') && toolingArtifactStoredEmptyId.missing.includes('final-report-artifact'));

// regression: the pre-existing 5 scalar fields + 2 array fields still work exactly as before (unchanged
// behavior) — re-run of the original webSatisfied/webViaFilesChanged/tooling fixtures already above cover
// this too, but assert it directly here so a future field-list edit can't silently break the old fields.
const regressionOldFields = V.evidenceCheck([
  { event_type: 'report_generated', agent: 'Build Boss', path: 'final-report.md' },
], 'tooling', {});
t("evidenceCheck: regression — the pre-existing 'path' field still satisfies final-report-artifact unchanged", regressionOldFields
  && regressionOldFields.satisfied.includes('final-report-artifact'));
const regressionFilesChangedArray = V.evidenceCheck([
  { event_type: 'file_changed', agent: 'Build Boss', files_changed: ['docs/final-report-draft.md'] },
], 'tooling', {});
t("evidenceCheck: regression — the pre-existing 'files_changed[]' array field still satisfies final-report-artifact unchanged", regressionFilesChangedArray
  && regressionFilesChangedArray.satisfied.includes('final-report-artifact'));

// ---- evidenceCheck: never throws on a malformed/empty events array ----
t('evidenceCheck: empty events array + real domain -> ok:false, never throws', (() => {
  try { const r = V.evidenceCheck([], 'website', {}); return r && r.ok === false; } catch { return false; }
})());
t('evidenceCheck: non-array events -> treated as empty, never throws', (() => {
  try { const r = V.evidenceCheck(undefined, 'website', {}); return r && r.ok === false; } catch { return false; }
})());

// ---- CLI --domain wiring: advisory only, NEVER changes the exit code ----
const cliDomainMissingOnCleanRun = runCli('run-clean-only', '--root', TMP, '--domain', 'website', '--json');
t('CLI --domain on an otherwise-clean run still exits 0 (evidence is advisory, never gates)', cliDomainMissingOnCleanRun.status === 0);
t('CLI --domain prints the loud MISSING EVIDENCE line', /MISSING EVIDENCE for domain "website"/.test(cliDomainMissingOnCleanRun.stdout));
t('CLI --domain --json: evidence block present with ok:false and real missing ids', (() => {
  try {
    const j = JSON.parse(cliDomainMissingOnCleanRun.stdout.slice(cliDomainMissingOnCleanRun.stdout.indexOf('{')));
    return j.evidence && j.evidence.ok === false && j.evidence.domain === 'website' && j.evidence.missing.length === 4;
  } catch { return false; }
})());

const evidenceCleanDir = writeEvents('run-evidence-clean', [
  ev({ event_type: 'agent_started', agent: 'UI Boss' }),
  ev({ event_type: 'browser_screenshot_captured', agent: 'UI Boss', screenshot_path: 'artifacts/mobile-390.png' }),
  ev({ event_type: 'browser_screenshot_captured', agent: 'UI Boss', screenshot_path: 'artifacts/tablet-768.png' }),
  ev({ event_type: 'browser_screenshot_captured', agent: 'UI Boss', screenshot_path: 'artifacts/desktop-1440.png' }),
  ev({ event_type: 'zero_console_errors_noted', agent: 'UI Boss' }),
  ev({ event_type: 'agent_completed', agent: 'UI Boss' }),
]);
const cliDomainSatisfied = runCli('run-evidence-clean', '--root', TMP, '--domain', 'website');
t('CLI --domain with real satisfying evidence prints the OK line', /all required evidence present for domain "website"/.test(cliDomainSatisfied.stdout));
t('CLI --domain with real satisfying evidence still exits 0 (also clean on mismatches/tickets/isolation)', cliDomainSatisfied.status === 0);

const cliNoDomain = runCli('run-clean-only', '--root', TMP);
t('CLI without --domain never prints an Evidence: section at all', !/Evidence \(advisory/.test(cliNoDomain.stdout));

const cliUnknownDomain = runCli('run-clean-only', '--root', TMP, '--domain', 'not-a-real-domain');
t('CLI with an unrecognized --domain prints the "not recognized" skip line, still exits 0', /not recognized by required-evidence\.json/.test(cliUnknownDomain.stdout) && cliUnknownDomain.status === 0);

// ================================================================================================
// BACKLOG ITEM 7 / spec-drift — checkAcceptanceCoverage() + buildAcceptanceEnforceEvents() (2026-07-31)
// See .claude/forge-research/MINING-RONDE-1-2026-07-31.md section 2 for the mined design this implements.
// ================================================================================================

function writePrdMeta(prdId, criteria) {
  const dir = path.join(CLAUDE_DIR, 'forge-prd');
  fs.mkdirSync(dir, { recursive: true });
  const meta = { prd_id: prdId, title: 'Test PRD ' + prdId, sections: { acceptance_criteria: criteria } };
  fs.writeFileSync(path.join(dir, prdId + '.meta.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');
  return meta;
}

// ---- (a) full coverage -> 0 gaps ----
writePrdMeta('prd-cov-full', [{ id: 'ac-1', text: 'First criterion' }, { id: 'ac-2', text: 'Second criterion' }]);
store.putEntity('tickets', 'tk-prd-cov-full-1', { ticket_id: 'tk-prd-cov-full-1', prd_id: 'prd-cov-full', run_id: 'run-ac-full', title: 'First criterion', status: 'done', created: new Date().toISOString() });
store.putEntity('tickets', 'tk-prd-cov-full-2', { ticket_id: 'tk-prd-cov-full-2', prd_id: 'prd-cov-full', run_id: 'run-ac-full', title: 'Second criterion', status: 'done', created: new Date().toISOString() });
const acFullDir = writeEvents('run-ac-full', [
  ev({ event_type: 'agent_started', agent: 'Build Boss' }),
  ev({ event_type: 'prd_generated', agent: 'orchestrator', prd_id: 'prd-cov-full', run_id: 'run-ac-full' }),
  ev({ event_type: 'ticket_created', agent: 'orchestrator', ticket_id: 'tk-prd-cov-full-1', prd_id: 'prd-cov-full' }),
  ev({ event_type: 'ticket_created', agent: 'orchestrator', ticket_id: 'tk-prd-cov-full-2', prd_id: 'prd-cov-full' }),
  ev({ event_type: 'ticket_updated', agent: 'orchestrator', ticket_id: 'tk-prd-cov-full-1', note: 'closed with test_evidence' }),
  ev({ event_type: 'ticket_updated', agent: 'orchestrator', ticket_id: 'tk-prd-cov-full-2', note: 'closed with test_evidence' }),
  ev({ event_type: 'agent_completed', agent: 'Build Boss' }),
]);
const acFull = V.checkAcceptanceCoverage('run-ac-full', { runDir: acFullDir });
t('checkAcceptanceCoverage (a): full coverage -> 0 gaps', acFull.acceptance_gaps.length === 0);
t('checkAcceptanceCoverage (a): prds_checked includes prd-cov-full', acFull.prds_checked.includes('prd-cov-full'));
t('checkAcceptanceCoverage (a): note is null (a real PRD IS linked)', acFull.note === null);
const cliAcFull = runCli('run-ac-full', '--root', TMP);
t('CLI (a): a fully-covered, otherwise-clean run exits 0', cliAcFull.status === 0);
t('CLI (a): prints the clean acceptance-coverage line', /all acceptance criteria covered \(1 PRD\(s\) checked\)/.test(cliAcFull.stdout));

// ---- (b) ticket deleted/never-created while the PRD still lists the criterion -> 1 blocker ----
writePrdMeta('prd-cov-missing', [{ id: 'ac-1', text: 'Only criterion' }]);
// tk-prd-cov-missing-1 intentionally NEVER created — the "dropped/deleted ticket" shape.
const acMissingDir = writeEvents('run-ac-missing', [
  ev({ event_type: 'agent_started', agent: 'Build Boss' }),
  ev({ event_type: 'prd_generated', agent: 'orchestrator', prd_id: 'prd-cov-missing', run_id: 'run-ac-missing' }),
  ev({ event_type: 'agent_completed', agent: 'Build Boss' }),
]);
const acMissing = V.checkAcceptanceCoverage('run-ac-missing', { runDir: acMissingDir });
t('checkAcceptanceCoverage (b): ticket deleted/never-created -> exactly 1 blocker gap', acMissing.acceptance_gaps.length === 1);
t('checkAcceptanceCoverage (b): the gap names the right prd_id/ac_id/ticket_id + severity blocker', (() => {
  const g = acMissing.acceptance_gaps[0];
  return g.prd_id === 'prd-cov-missing' && g.ac_id === 'ac-1' && g.ticket_id === 'tk-prd-cov-missing-1' && g.severity === 'blocker';
})());
const cliAcMissing = runCli('run-ac-missing', '--root', TMP, '--json');
t('CLI (b): a run with a dropped acceptance criterion exits 1 (existing gate EXTENDED, not replaced)', cliAcMissing.status === 1);
t('CLI (b): prints the BLOCKER line naming ac-1/prd-cov-missing/tk-prd-cov-missing-1', /BLOCKER ac=ac-1 prd=prd-cov-missing ticket=tk-prd-cov-missing-1/.test(cliAcMissing.stdout));
t('CLI (b) --json: acceptance_gaps carries the real gap', (() => {
  try {
    const j = JSON.parse(cliAcMissing.stdout.slice(cliAcMissing.stdout.indexOf('{')));
    return Array.isArray(j.acceptance_gaps) && j.acceptance_gaps.length === 1 && j.acceptance_gaps[0].ac_id === 'ac-1';
  } catch { return false; }
})());

// ---- (c) ticket still open, run claims completion -> 1 blocker ----
writePrdMeta('prd-cov-open', [{ id: 'ac-1', text: 'Still open criterion' }]);
store.putEntity('tickets', 'tk-prd-cov-open-1', { ticket_id: 'tk-prd-cov-open-1', prd_id: 'prd-cov-open', run_id: 'run-ac-open', title: 'Still open criterion', status: 'open', created: new Date().toISOString() });
const acOpenDir = writeEvents('run-ac-open', [
  ev({ event_type: 'agent_started', agent: 'Build Boss' }),
  ev({ event_type: 'prd_generated', agent: 'orchestrator', prd_id: 'prd-cov-open', run_id: 'run-ac-open' }),
  ev({ event_type: 'ticket_created', agent: 'orchestrator', ticket_id: 'tk-prd-cov-open-1', prd_id: 'prd-cov-open' }),
  ev({ event_type: 'agent_completed', agent: 'Build Boss', status: 'done' }), // the run claims completion anyway
]);
const acOpen = V.checkAcceptanceCoverage('run-ac-open', { runDir: acOpenDir });
t('checkAcceptanceCoverage (c): ticket still open + run claims completion -> exactly 1 blocker gap', acOpen.acceptance_gaps.length === 1);
t('checkAcceptanceCoverage (c): the gap description says not marked done', /not marked done/.test(acOpen.acceptance_gaps[0].description));

// ---- extra rigor pin: ticket says DONE in the store but THIS run never references it at all -> still a
// gap. Proves the in-run-evidence half of rule (b) is load-bearing, not vacuous (a naive "trust the store
// status field alone" implementation would wrongly report 0 gaps here). ----
writePrdMeta('prd-cov-orphan', [{ id: 'ac-1', text: 'Orphan-done criterion' }]);
store.putEntity('tickets', 'tk-prd-cov-orphan-1', { ticket_id: 'tk-prd-cov-orphan-1', prd_id: 'prd-cov-orphan', run_id: 'run-ac-orphan', title: 'Orphan-done criterion', status: 'done', created: new Date().toISOString() });
const acOrphanDir = writeEvents('run-ac-orphan', [
  ev({ event_type: 'agent_started', agent: 'Build Boss' }),
  ev({ event_type: 'prd_generated', agent: 'orchestrator', prd_id: 'prd-cov-orphan', run_id: 'run-ac-orphan' }),
  ev({ event_type: 'agent_completed', agent: 'Build Boss' }),
  // NOTE: no event anywhere in this run references tk-prd-cov-orphan-1.
]);
const acOrphan = V.checkAcceptanceCoverage('run-ac-orphan', { runDir: acOrphanDir });
t('checkAcceptanceCoverage (rigor pin): store says done but THIS run never references the ticket -> still a gap', acOrphan.acceptance_gaps.length === 1);
t('checkAcceptanceCoverage (rigor pin): description explains no completion event in this run', /never records a real completion event/.test(acOrphan.acceptance_gaps[0].description));

// ---- (d) no PRD linked -> empty gaps + honest one-line note ----
const acNoneDir = writeEvents('run-ac-none', [
  ev({ event_type: 'agent_started', agent: 'Build Boss' }),
  ev({ event_type: 'check_passed', agent: 'Build Boss', task: 'lint' }),
  ev({ event_type: 'agent_completed', agent: 'Build Boss' }),
]);
const acNone = V.checkAcceptanceCoverage('run-ac-none', { runDir: acNoneDir });
t('checkAcceptanceCoverage (d): no PRD linked -> empty gaps', acNone.acceptance_gaps.length === 0);
t('checkAcceptanceCoverage (d): no PRD linked -> honest one-line note', acNone.note === 'no PRD linked to this run');
t('checkAcceptanceCoverage (d): no PRD linked -> prds_checked is empty', acNone.prds_checked.length === 0);
const cliAcNone = runCli('run-ac-none', '--root', TMP);
t('CLI (d): a run with no PRD linked still exits 0 when otherwise clean', cliAcNone.status === 0);
t('CLI (d): prints the honest no-PRD-linked note', /\(no PRD linked to this run\)/.test(cliAcNone.stdout));

// ---- (e) --enforce appends only the registered event trio, closes/edits nothing ----
const beforeEnforceLineCount = fs.readFileSync(path.join(acMissingDir, 'events.jsonl'), 'utf8').trim().split('\n').length;
const missingTicketPath = path.join(CLAUDE_DIR, 'forge-tickets', 'tk-prd-cov-missing-1.json');
t('enforce-setup: the gap ticket genuinely does not exist before --enforce', !fs.existsSync(missingTicketPath));
const cliEnforceAc = runCli('run-ac-missing', '--root', TMP, '--enforce');
t('CLI --enforce (e): still exits 1 (enforce logs, never fixes)', cliEnforceAc.status === 1);
t('CLI --enforce (e): prints an ENFORCED line mentioning 1 acceptance gap flagged', /1 acceptance gap\(s\) flagged/.test(cliEnforceAc.stdout));
const afterEnforceLines = fs.readFileSync(path.join(acMissingDir, 'events.jsonl'), 'utf8').trim().split('\n');
t('CLI --enforce (e): appended EXACTLY 3 new event lines (the registered trio, nothing else)', afterEnforceLines.length === beforeEnforceLineCount + 3);
const newAcEvents = afterEnforceLines.slice(beforeEnforceLineCount).map((l) => JSON.parse(l));
t('CLI --enforce (e): new events are exactly lead_review_completed, rework_task_created, rework_assigned, in order', newAcEvents.map((x) => x.event_type).join(',') === 'lead_review_completed,rework_task_created,rework_assigned');
t('CLI --enforce (e): rework_task_created names the exact prd_id/ac_id/ticket_id', newAcEvents[1].prd_id === 'prd-cov-missing' && newAcEvents[1].ac_id === 'ac-1' && newAcEvents[1].ticket_id === 'tk-prd-cov-missing-1');
t('CLI --enforce (e): rework_assigned also carries the ac_id', newAcEvents[2].ac_id === 'ac-1');
t('CLI --enforce (e): closes nothing — the missing ticket still does not exist afterward', !fs.existsSync(missingTicketPath));
const acMissingAfterEnforce = V.checkAcceptanceCoverage('run-ac-missing', { runDir: acMissingDir });
t('CLI --enforce (e): re-checking right after still shows the SAME 1 gap (enforce never fixes anything)', acMissingAfterEnforce.acceptance_gaps.length === 1);

// ---- buildAcceptanceEnforceEvents: pure payload builder, registered event types only (mirrors the
// existing buildEnforceEvents tests above, reusing the same REGISTERED set) ----
const sampleGap = { prd_id: 'prd-x', ac_id: 'ac-2', ticket_id: 'tk-prd-x-2', severity: 'blocker', description: 'criterion desc', fix_hint: 'do the fix' };
const builtAc = V.buildAcceptanceEnforceEvents(sampleGap);
t('buildAcceptanceEnforceEvents returns exactly 3 events', builtAc.length === 3);
t('buildAcceptanceEnforceEvents uses ONLY registered event_type names', builtAc.every((e) => REGISTERED.has(e.event_type)));
t('buildAcceptanceEnforceEvents never emits an invented done/closed event type', !builtAc.some((e) => /done|closed|resolve/i.test(e.event_type)));
const acLrc = builtAc.find((e) => e.event_type === 'lead_review_completed');
t('lead_review_completed names prd_id and ac_id in its note', acLrc.extra.note.includes('prd-x') && acLrc.extra.note.includes('ac-2'));
const acRtc = builtAc.find((e) => e.event_type === 'rework_task_created');
t('rework_task_created threads prd_id/ac_id/ticket_id + issue/required_fix', acRtc.extra.prd_id === 'prd-x' && acRtc.extra.ac_id === 'ac-2' && acRtc.extra.ticket_id === 'tk-prd-x-2' && acRtc.extra.issue === 'criterion desc' && acRtc.extra.required_fix === 'do the fix');
const acRa = builtAc.find((e) => e.event_type === 'rework_assigned');
t('rework_assigned carries the ac_id too', acRa.extra.ac_id === 'ac-2');
t('buildAcceptanceEnforceEvents never marks anything as done (no status:done anywhere)', !builtAc.some((e) => e.extra.status === 'done'));

// ---- explicit owner decision (requirement #1's "or an explicit owner decision event") ----
writePrdMeta('prd-cov-decided', [{ id: 'ac-1', text: 'Manually covered criterion' }]);
// tk-prd-cov-decided-1 intentionally never created — covered by an explicit owner decision instead.
const acDecidedDir = writeEvents('run-ac-decided', [
  ev({ event_type: 'agent_started', agent: 'Build Boss' }),
  ev({ event_type: 'prd_generated', agent: 'orchestrator', prd_id: 'prd-cov-decided', run_id: 'run-ac-decided' }),
  ev({ event_type: 'decision_logged', agent: 'orchestrator', prd_id: 'prd-cov-decided', ac_id: 'ac-1', decision: 'covered by manual QA sign-off, no ticket needed', by: 'owner' }),
  ev({ event_type: 'agent_completed', agent: 'Build Boss' }),
]);
const acDecided = V.checkAcceptanceCoverage('run-ac-decided', { runDir: acDecidedDir });
t('checkAcceptanceCoverage: an explicit, attributed owner decision clears a criterion with no ticket at all', acDecided.acceptance_gaps.length === 0);

// negative pin: a decision_logged referencing the right ids but with NO real decision text/attribution
// must NOT count — proves this is a real structured/attributed match, not a bare event_type+id hit.
writePrdMeta('prd-cov-bare-decision', [{ id: 'ac-1', text: 'Needs a real decision' }]);
const acBareDir = writeEvents('run-ac-bare-decision', [
  ev({ event_type: 'prd_generated', agent: 'orchestrator', prd_id: 'prd-cov-bare-decision', run_id: 'run-ac-bare-decision' }),
  ev({ event_type: 'decision_logged', agent: '', prd_id: 'prd-cov-bare-decision', ac_id: 'ac-1', decision: '   ', by: '' }),
]);
const acBare = V.checkAcceptanceCoverage('run-ac-bare-decision', { runDir: acBareDir });
t('checkAcceptanceCoverage: a blank/unattributed decision_logged does NOT clear the criterion (still 1 gap)', acBare.acceptance_gaps.length === 1);

// ---- isolated gate-mutation pin (mirrors the existing 7d1/7d2 pins above): a run clean on EVERYTHING
// (mismatches, tickets, isolation) except ONE acceptance gap must still flip the exit code — kills a
// future "forgot to add acceptance_gaps.length===0 to the && chain" regression. ----
writePrdMeta('prd-cov-gate-only', [{ id: 'ac-1', text: 'Gate isolation criterion' }]);
const gateOnlyDir = writeEvents('run-ac-gate-only', [
  ev({ event_type: 'agent_started', agent: 'Clean Boss 3' }),
  ev({ event_type: 'prd_generated', agent: 'orchestrator', prd_id: 'prd-cov-gate-only', run_id: 'run-ac-gate-only' }),
  ev({ event_type: 'check_passed', agent: 'Clean Boss 3' }),
  ev({ event_type: 'agent_completed', agent: 'Clean Boss 3' }),
]);
const gateOnly = V.verifyRun(gateOnlyDir, {});
const gateOnlyTix = V.verifyTickets({ run_id: 'run-ac-gate-only' });
const gateOnlyIso = V.isolationTripwire(gateOnlyDir, TMP);
t('gate-pin setup: run-ac-gate-only has ZERO agent mismatches, ZERO tickets, ZERO isolation violations (isolates the acceptance-gap axis)', gateOnly.mismatches === 0 && gateOnlyTix.tickets.length === 0 && gateOnlyIso.violations.length === 0);
const cliGateOnly = runCli('run-ac-gate-only', '--root', TMP);
t('gate-pin: CLI exits 1 purely because of the acceptance gap (kills a dropped acceptance_gaps clause in the exit-code &&)', cliGateOnly.status === 1);

// ---- FOUND BY THE COMMAND AUDIT (2026-08-02): the SILENT FALSE PASS on the honesty gate itself ----
// The public quick-reference documented `forge-verify.cjs --run <run_id>`. parseArgs knew no --run, so
// pos[0] became the literal string "--run", which PASSED the old /^[A-Za-z0-9_-]+$/ guard (hyphen is in
// the class), opened .claude/forge-runs/--run, found nothing, printed "0 mismatch(es)" and exited 0.
// Forge's own honesty gate greenlit a run it never looked at. Three pins, each one direction of the fix:
const cliDashRun = runCli('--run', 'run-combo', '--root', TMP, '--json');
t('FALSE-PASS pin 1: the documented `--run <id>` form now works and sees the REAL run (mismatches=1, exit 1)', (() => {
  // same human-header-then-JSON parse the cliMismatch test above uses
  try { return cliDashRun.status === 1 && JSON.parse(cliDashRun.stdout.slice(cliDashRun.stdout.indexOf('{'))).mismatches === 1; } catch { return false; }
})());
const cliFlagAsId = runCli('--bogus-flag', '--root', TMP);
t('FALSE-PASS pin 2: a token starting with "-" is REJECTED as a run_id, never silently verified', cliFlagAsId.status !== 0 && /invalid|usage/i.test(cliFlagAsId.stderr));
const cliGhost = runCli('run-that-was-never-created', '--root', TMP);
t('FALSE-PASS pin 3: a run directory that does not exist is LOUD (non-zero + names the path), never "0 mismatches"', cliGhost.status !== 0 && /does not exist|no such run/i.test(cliGhost.stderr + cliGhost.stdout) && !/0 mismatch/.test(cliGhost.stdout));

// =====================================================================================================
// WP23 (2026-09-24) — "verify: heartbeats and evidence-closed tasks". Real defect measured on
// forge-2026-09-24-config-v250: agent_progress heartbeats of already-COMPLETED work packages, and a
// completed_with_blockers subagent_output the Lead had already fixed, could never close, so finished
// work read as 67 permanently-open tasks. Fixtures below reproduce the exact shapes.
// =====================================================================================================

// ---- RULE 1a: a heartbeat closes when the completion shares its wp_id ----
const hbSameWpDir = writeEvents('run-wp23-hb-same-wp', [
  ev({ event_type: 'agent_started', agent: 'Build Boss' }),
  ev({ event_type: 'agent_progress', agent: 'Build Boss', wp_id: 'wp1', role: 'build-boss', note: 'working wp1' }),
  ev({ event_type: 'subagent_completed', agent: 'Build Boss', wp_id: 'wp1', role: 'build-boss', status: 'completed' }),
]);
const hbSameWp = V.verifyRun(hbSameWpDir, {});
const hbSameWpAgent = hbSameWp.agents.find((a) => a.agent === 'Build Boss');
t('RULE 1a: a heartbeat with the SAME wp_id as the completion closes (0 open tasks)', hbSameWpAgent.tasksOpen.length === 0);
t('RULE 1a: the closed heartbeat resolves done', hbSameWpAgent.tasksDone === hbSameWpAgent.tasksTotal && hbSameWpAgent.tasksTotal > 0);
t('RULE 1a: no false mismatch once the heartbeat is genuinely closed', hbSameWpAgent.mismatch === false);

// ---- RULE 1b: a heartbeat of a DIFFERENT wp_id is NOT closed by an unrelated completion ----
const hbDiffWpDir = writeEvents('run-wp23-hb-diff-wp', [
  ev({ event_type: 'agent_started', agent: 'Search Boss' }),
  ev({ event_type: 'agent_progress', agent: 'Search Boss', wp_id: 'wpA', note: 'working wpA' }),
  ev({ event_type: 'subagent_completed', agent: 'Search Boss', wp_id: 'wpB', status: 'completed' }),
]);
const hbDiffWp = V.verifyRun(hbDiffWpDir, {});
const hbDiffWpAgent = hbDiffWp.agents.find((a) => a.agent === 'Search Boss');
t('RULE 1b: a heartbeat of a DIFFERENT wp_id stays open (a different WP finishing must not close it)', hbDiffWpAgent.tasksOpen.some((tk) => tk.event_type === 'agent_progress'));

// ---- RULE 1c: heartbeats of a completed_with_blockers completion become FAILED, and still count as open
// (blockers are never hidden as done) ----
const hbBlockedDir = writeEvents('run-wp23-hb-blocked', [
  ev({ event_type: 'agent_started', agent: 'Docs Boss' }),
  ev({ event_type: 'agent_progress', agent: 'Docs Boss', wp_id: 'wp13b', note: 'drafting docs' }),
  ev({ event_type: 'subagent_completed', agent: 'Docs Boss', wp_id: 'wp13b', status: 'completed_with_blockers' }),
]);
const hbBlocked = V.verifyRun(hbBlockedDir, {});
const hbBlockedAgent = hbBlocked.agents.find((a) => a.agent === 'Docs Boss');
const hbBlockedHeartbeat = hbBlockedAgent.tasksOpen.find((tk) => tk.event_type === 'agent_progress');
t('RULE 1c: a heartbeat closed by a completed_with_blockers completion becomes FAILED, not done', !!hbBlockedHeartbeat && hbBlockedHeartbeat.status === 'failed');

// ---- RULE 2a: closes_event_id + non-empty evidence closes the named EARLIER task ----
const closeGoodDir = writeEvents('run-wp23-closes-good', [
  ev({ event_type: 'check_failed', agent: 'Review Boss', event_id: 'ev-closes-good-1', task: 'lint gate' }),
  ev({ event_type: 'fix_completed', agent: 'orchestrator', closes_event_id: 'ev-closes-good-1', evidence: 'reran lint, 0 errors' }),
]);
const closeGood = V.verifyRun(closeGoodDir, {});
const closeGoodAgent = closeGood.agents.find((a) => a.agent === 'Review Boss');
t('RULE 2a: closes_event_id + evidence closes the earlier task (0 open on Review Boss)', closeGoodAgent.tasksOpen.length === 0);
t('RULE 2a: no advisory line when the closure is valid', closeGood.closesAdvisories.length === 0);

// ---- RULE 2b: closes_event_id WITHOUT evidence closes nothing + logs one advisory ----
const closeNoEvidenceDir = writeEvents('run-wp23-closes-no-evidence', [
  ev({ event_type: 'check_failed', agent: 'Review Boss', event_id: 'ev-closes-noev-1', task: 'lint gate' }),
  ev({ event_type: 'fix_completed', agent: 'orchestrator', closes_event_id: 'ev-closes-noev-1' }),
]);
const closeNoEvidence = V.verifyRun(closeNoEvidenceDir, {});
const closeNoEvidenceAgent = closeNoEvidence.agents.find((a) => a.agent === 'Review Boss');
t('RULE 2b: closes_event_id WITHOUT evidence closes nothing (task stays open)', closeNoEvidenceAgent.tasksOpen.length === 1);
t('RULE 2b: exactly one advisory line explains why, naming "no evidence"', closeNoEvidence.closesAdvisories.length === 1 && /no evidence/.test(closeNoEvidence.closesAdvisories[0]));

// ---- RULE 2c: an unknown closes_event_id closes nothing + logs one advisory ----
const closeUnknownDir = writeEvents('run-wp23-closes-unknown', [
  ev({ event_type: 'fix_completed', agent: 'orchestrator', closes_event_id: 'ev-never-logged', evidence: 'proof' }),
]);
const closeUnknown = V.verifyRun(closeUnknownDir, {});
t('RULE 2c: an unknown event_id is ignored with an advisory naming it "unknown"', closeUnknown.closesAdvisories.length === 1 && /unknown event_id/.test(closeUnknown.closesAdvisories[0]));

// ---- RULE 2d: a forward/self reference (target not strictly earlier than the closer) is ignored ----
const closeForwardDir = writeEvents('run-wp23-closes-forward', [
  ev({ event_type: 'fix_completed', agent: 'orchestrator', event_id: 'ev-self-1', closes_event_id: 'ev-self-1', evidence: 'proof' }),
]);
const closeForward = V.verifyRun(closeForwardDir, {});
t('RULE 2d: a self/forward reference is ignored with an advisory naming "forward reference"', closeForward.closesAdvisories.length === 1 && /forward reference/.test(closeForward.closesAdvisories[0]));

// ---- RULE 1+2 combined: mismatch flips true -> false on a fixture shaped like the real defect run
// (forge-2026-09-24-config-v250) — a Boss claims done while its own heartbeats and a blocked output are
// still open; a matching subagent_completed + a Lead fix_completed with evidence close them for real. ----
const realShapeDir = writeEvents('run-wp23-real-shape', [
  ev({ event_type: 'agent_started', agent: 'Build Boss' }),
  ev({ event_type: 'agent_progress', agent: 'Build Boss', wp_id: 'wp1', note: 'heartbeat 1' }),
  ev({ event_type: 'agent_progress', agent: 'Build Boss', wp_id: 'wp1', note: 'heartbeat 2' }),
  ev({ event_type: 'subagent_output_created', agent: 'Build Boss', event_id: 'ev-real-shape-blocked', wp_id: 'wp1', status: 'completed_with_blockers', output: 'shipped with 2 known blockers' }),
  ev({ event_type: 'subagent_completed', agent: 'Build Boss', wp_id: 'wp1', status: 'completed' }),
  ev({ event_type: 'fix_completed', agent: 'orchestrator', closes_event_id: 'ev-real-shape-blocked', evidence: 'both blockers fixed and retested' }),
  ev({ event_type: 'agent_completed', agent: 'Build Boss', status: 'done' }),
]);
const realShape = V.verifyRun(realShapeDir, {});
const realShapeAgent = realShape.agents.find((a) => a.agent === 'Build Boss');
t('RULE 1+2 combined: the real-shape fixture now has ZERO open tasks', realShapeAgent.tasksOpen.length === 0);
t('RULE 1+2 combined: mismatch is false once heartbeats + the blocked output genuinely close', realShapeAgent.mismatch === false);

// =====================================================================================================
// RULE 3 (2026-09-24, loop wp-l1): review_started/review_completed TASK_PAIRS pair — real defect: a
// verify-boss run ended with 2 "open" review_started tasks although both review_completed events were
// logged, and the Lead had to hand-close them with fix_completed + closes_event_id.
// =====================================================================================================

// ---- RULE 3a: a review_completed with the SAME review_id as the open review_started closes it ----
const reviewSameIdDir = writeEvents('run-wp-l1-review-same-id', [
  ev({ event_type: 'agent_started', agent: 'Review Boss' }),
  ev({ event_type: 'review_started', agent: 'Review Boss', review_id: 'rv-1', task: 'review wp1' }),
  ev({ event_type: 'review_completed', agent: 'Review Boss', review_id: 'rv-1', status: 'PASS' }),
]);
const reviewSameId = V.verifyRun(reviewSameIdDir, {});
const reviewSameIdAgent = reviewSameId.agents.find((a) => a.agent === 'Review Boss');
t('RULE 3a: review_completed with the SAME review_id closes the review_started (0 open tasks)', reviewSameIdAgent.tasksOpen.length === 0);
t('RULE 3a: the closed review task resolves done', reviewSameIdAgent.tasksDone === reviewSameIdAgent.tasksTotal && reviewSameIdAgent.tasksTotal > 0);

// ---- RULE 3b: a review_completed with a DIFFERENT review_id does NOT close the open review_started ----
const reviewDiffIdDir = writeEvents('run-wp-l1-review-diff-id', [
  ev({ event_type: 'agent_started', agent: 'Review Boss' }),
  ev({ event_type: 'review_started', agent: 'Review Boss', review_id: 'rv-1', task: 'review wp1' }),
  ev({ event_type: 'review_completed', agent: 'Review Boss', review_id: 'rv-2', status: 'PASS' }),
]);
const reviewDiffId = V.verifyRun(reviewDiffIdDir, {});
const reviewDiffIdAgent = reviewDiffId.agents.find((a) => a.agent === 'Review Boss');
t('RULE 3b: a DIFFERENT review_id does not close the open review_started (still open)', reviewDiffIdAgent.tasksOpen.some((tk) => tk.event_type === 'review_started'));
t('RULE 3b: the mismatched review_completed becomes its own separate task', reviewDiffIdAgent.tasksTotal === 2);

// ---- RULE 3c: no review_id on either side falls back to same-agent earliest-open matching (still pairs) ----
const reviewNoIdDir = writeEvents('run-wp-l1-review-no-id', [
  ev({ event_type: 'agent_started', agent: 'Review Boss' }),
  ev({ event_type: 'review_started', agent: 'Review Boss', task: 'review wp2' }),
  ev({ event_type: 'review_completed', agent: 'Review Boss', status: 'PASS' }),
]);
const reviewNoId = V.verifyRun(reviewNoIdDir, {});
const reviewNoIdAgent = reviewNoId.agents.find((a) => a.agent === 'Review Boss');
t('RULE 3c: no review_id on either side still pairs via same-agent fallback (0 open tasks)', reviewNoIdAgent.tasksOpen.length === 0);

// ---- RULE 3d: a FAIL/changes-required verdict closes the pairing but resolves FAILED, not done (still
// counted as open/unresolved by tasksOpen — a failed review is never hidden as done) ----
const reviewFailDir = writeEvents('run-wp-l1-review-fail', [
  ev({ event_type: 'agent_started', agent: 'Review Boss' }),
  ev({ event_type: 'review_started', agent: 'Review Boss', review_id: 'rv-3', task: 'review wp3' }),
  ev({ event_type: 'review_completed', agent: 'Review Boss', review_id: 'rv-3', status: 'FAIL changes-required' }),
]);
const reviewFail = V.verifyRun(reviewFailDir, {});
const reviewFailAgent = reviewFail.agents.find((a) => a.agent === 'Review Boss');
const reviewFailTask = reviewFailAgent.tasksOpen.find((tk) => tk.event_type === 'review_started');
t('RULE 3d: a FAIL verdict resolves the paired task as failed, still counted open (not hidden as done)', !!reviewFailTask && reviewFailTask.status === 'failed');

// ---- RULE 3e: two concurrent reviews by the same agent with different review_ids close independently ----
const reviewConcurrentDir = writeEvents('run-wp-l1-review-concurrent', [
  ev({ event_type: 'agent_started', agent: 'Review Boss' }),
  ev({ event_type: 'review_started', agent: 'Review Boss', review_id: 'rv-a', task: 'review A' }),
  ev({ event_type: 'review_started', agent: 'Review Boss', review_id: 'rv-b', task: 'review B' }),
  ev({ event_type: 'review_completed', agent: 'Review Boss', review_id: 'rv-b', status: 'PASS' }),
]);
const reviewConcurrent = V.verifyRun(reviewConcurrentDir, {});
const reviewConcurrentAgent = reviewConcurrent.agents.find((a) => a.agent === 'Review Boss');
t('RULE 3e: closing rv-b leaves rv-a (a different review_id) genuinely open', reviewConcurrentAgent.tasksOpen.some((tk) => tk.event_type === 'review_started'));
t('RULE 3e: exactly one review_started remains open (rv-a), rv-b closed', reviewConcurrentAgent.tasksOpen.filter((tk) => tk.event_type === 'review_started').length === 1);

// =====================================================================================================
// 2026-09-24 (out-p5.md fix-round) — VERIFY-FAILED-REVIEW-DONE / VERIFY-DEAD-WORKER-GREEN /
// VERIFY-ARBITRARY-CLOSURE / VERIFY-SELF-WAIVER / EVENT-RUN-BINDING-GAP
// =====================================================================================================

// ---- statusClass "incomplete" substring bug: negated-done text must not read as done ----
t('statusClass: "incomplete" is not read as done via the "complete" substring', V.taskStatus({ event_type: 'x', status: 'incomplete' }) !== 'done');
t('statusClass: "not completed" is not read as done', V.taskStatus({ event_type: 'x', status: 'not completed' }) !== 'done');
t('statusClass: a genuinely positive "complete" still reads done', V.taskStatus({ event_type: 'x', status: 'complete' }) === 'done');

// ---- VERIFY-FAILED-REVIEW-DONE: review_verdict (not `status`) drives the outcome ----
t('reviewOutcome: review_verdict:"fail" (no status field) is failed, not done', V.reviewOutcome({ event_type: 'review_completed', review_verdict: 'fail' }) === 'failed');
t('reviewOutcome: review_verdict:"approved" is done', V.reviewOutcome({ event_type: 'review_completed', review_verdict: 'approved' }) === 'done');
t('reviewOutcome: ok:false alongside a positive verdict field still fails (contradiction is a rejection)', V.reviewOutcome({ event_type: 'review_completed', review_verdict: 'approved', ok: false }) === 'failed');
t('reviewOutcome: no outcome field at all returns null (caller uses its own default)', V.reviewOutcome({ event_type: 'review_completed' }) === null);
const verdictDoneDir = writeEvents('run-verdict-fail', [
  ev({ event_type: 'agent_started', agent: 'Review Boss' }),
  ev({ event_type: 'review_started', agent: 'Review Boss', review_id: 'rv-verdict', task: 'review x' }),
  ev({ event_type: 'review_completed', agent: 'Review Boss', review_id: 'rv-verdict', review_verdict: 'CHANGES_REQUIRED' }),
]);
const verdictFail = V.verifyRun(verdictDoneDir, {});
const verdictFailAgent = verdictFail.agents.find((a) => a.agent === 'Review Boss');
const verdictFailTask = verdictFailAgent.tasksOpen.find((tk) => tk.event_type === 'review_started');
t('verifyRun: a review_verdict:CHANGES_REQUIRED (no status field) resolves the paired task as failed, not done', !!verdictFailTask && verdictFailTask.status === 'failed');

// ---- VERIFY-FAILED-REVIEW-DONE: an orphan review_completed (no matching review_started) is NOT done ----
const orphanReviewDir = writeEvents('run-orphan-review', [
  ev({ event_type: 'agent_started', agent: 'Review Boss' }),
  ev({ event_type: 'review_completed', agent: 'Review Boss', review_id: 'rv-orphan', status: 'PASS' }),
]);
const orphanReview = V.verifyRun(orphanReviewDir, {});
const orphanReviewAgent = orphanReview.agents.find((a) => a.agent === 'Review Boss');
const orphanTask = orphanReviewAgent.tasksOpen.find((tk) => tk.event_type === 'review_completed');
t('verifyRun: an orphan review_completed (no matching start) is NOT counted done, even with a positive status', !!orphanTask);

// ---- VERIFY-DEAD-WORKER-GREEN: a start + unfinished heartbeat, no completion, no failure claim ----
const deadWorkerDir = writeEvents('run-dead-worker', [
  ev({ event_type: 'agent_started', agent: 'Ghost Boss' }),
  ev({ event_type: 'agent_progress', agent: 'Ghost Boss', note: 'still going…' }),
]);
const deadWorker = V.verifyRun(deadWorkerDir, {});
const ghostAgent = deadWorker.agents.find((a) => a.agent === 'Ghost Boss');
t('VERIFY-DEAD-WORKER-GREEN: an agent with an open heartbeat and no completion/failure claim is flagged deadWorker', ghostAgent.deadWorker === true);
t('VERIFY-DEAD-WORKER-GREEN: mismatch stays false for it (that predicate is about claimsDone specifically)', ghostAgent.mismatch === false);
// counterweight: an honest agent_failed claim is NOT also flagged deadWorker
const failedWorkerDir = writeEvents('run-failed-worker', [
  ev({ event_type: 'agent_started', agent: 'Honest Boss' }),
  ev({ event_type: 'agent_progress', agent: 'Honest Boss', note: 'trying…' }),
  ev({ event_type: 'agent_failed', agent: 'Honest Boss', note: 'crashed, reported honestly' }),
]);
const failedWorker = V.verifyRun(failedWorkerDir, {});
const honestAgent = failedWorker.agents.find((a) => a.agent === 'Honest Boss');
t('VERIFY-DEAD-WORKER-GREEN counterweight: an honest agent_failed claim is NOT flagged deadWorker', honestAgent.deadWorker === false);

// ---- VERIFY-DEAD-WORKER-GREEN (role-only fallback): two DIFFERENT wp_id heartbeats must BOTH stay open
// when only a role-only completion (no wp_id) is logged ----
const roleOnlyDir = writeEvents('run-role-only-two-wps', [
  ev({ event_type: 'agent_started', agent: 'Multi Boss', role: 'build' }),
  ev({ event_type: 'agent_progress', agent: 'Multi Boss', wp_id: 'wp-a', role: 'build', note: 'hb a' }),
  ev({ event_type: 'agent_progress', agent: 'Multi Boss', wp_id: 'wp-b', role: 'build', note: 'hb b' }),
  ev({ event_type: 'subagent_completed', agent: 'Multi Boss', role: 'build', status: 'completed' }), // no wp_id
]);
const roleOnly = V.verifyRun(roleOnlyDir, {});
const multiAgent = roleOnly.agents.find((a) => a.agent === 'Multi Boss');
const openHeartbeats = multiAgent.tasksOpen.filter((tk) => tk.event_type === 'agent_progress');
t('VERIFY-DEAD-WORKER-GREEN: a role-only completion (no wp_id) closes NEITHER of two explicit-wp_id heartbeats', openHeartbeats.length === 2);

// ---- VERIFY-ARBITRARY-CLOSURE: "." is not evidence ----
const closeDotDir = writeEvents('run-closes-dot-evidence', [
  ev({ event_type: 'check_failed', agent: 'Review Boss', event_id: 'ev-dot-1', task: 'lint gate' }),
  ev({ event_type: 'fix_completed', agent: 'orchestrator', closes_event_id: 'ev-dot-1', evidence: '.' }),
]);
const closeDot = V.verifyRun(closeDotDir, {});
const closeDotAgent = closeDot.agents.find((a) => a.agent === 'Review Boss');
t('VERIFY-ARBITRARY-CLOSURE: a bare "." is rejected as evidence (task stays open)', closeDotAgent.tasksOpen.length === 1);
t('VERIFY-ARBITRARY-CLOSURE: an advisory names "no evidence" for the bare "."', /no evidence/.test(closeDot.closesAdvisories[0] || ''));

// ---- VERIFY-ARBITRARY-CLOSURE: single consumption — a SECOND closer cannot re-close an already-closed target ----
const closeDoubleDir = writeEvents('run-closes-double', [
  ev({ event_type: 'check_failed', agent: 'Review Boss', event_id: 'ev-double-1', task: 'lint gate' }),
  ev({ event_type: 'fix_completed', agent: 'orchestrator', closes_event_id: 'ev-double-1', evidence: 'first fix, 3/3 passed' }),
  ev({ event_type: 'check_failed', agent: 'Other Boss', event_id: 'ev-double-2', task: 'unrelated' }),
  ev({ event_type: 'fix_completed', agent: 'Second Closer', closes_event_id: 'ev-double-1', evidence: 'trying to re-close, exit 0' }),
]);
const closeDouble = V.verifyRun(closeDoubleDir, {});
t('VERIFY-ARBITRARY-CLOSURE: a second closer cannot re-close an already-closed target', closeDouble.closesAdvisories.some((a) => /already closed/.test(a)));

// ---- VERIFY-ARBITRARY-CLOSURE: an already-DONE target cannot be "closed" retroactively ----
const closeDoneDir = writeEvents('run-closes-done-target', [
  ev({ event_type: 'ticket_created', agent: 'orchestrator', event_id: 'ev-already-done-1', note: 'fact' }),
  ev({ event_type: 'fix_completed', agent: 'orchestrator', closes_event_id: 'ev-already-done-1', evidence: 'trying to close a done fact, exit 0' }),
]);
const closeDone = V.verifyRun(closeDoneDir, {});
t('VERIFY-ARBITRARY-CLOSURE: an already-done target is refused with an advisory naming it', closeDone.closesAdvisories.some((a) => /already done/.test(a)));

// ---- VERIFY-ARBITRARY-CLOSURE: self-closure needs a tally/exit line, cross-agent needs only real evidence ----
const selfCloseWeakDir = writeEvents('run-self-close-weak', [
  ev({ event_type: 'check_failed', agent: 'Build Boss', event_id: 'ev-self-weak-1', task: 'lint gate' }),
  ev({ event_type: 'fix_completed', agent: 'Build Boss', closes_event_id: 'ev-self-weak-1', evidence: 'fixed it, looks good now' }),
]);
const selfCloseWeak = V.verifyRun(selfCloseWeakDir, {});
const selfCloseWeakAgent = selfCloseWeak.agents.find((a) => a.agent === 'Build Boss');
t('VERIFY-ARBITRARY-CLOSURE: self-closure with only prose (no tally/exit) is refused', selfCloseWeakAgent.tasksOpen.length === 1);
t('VERIFY-ARBITRARY-CLOSURE: the advisory names the self-closure tally/exit requirement', selfCloseWeak.closesAdvisories.some((a) => /tally\/exit-code/.test(a)));
const selfCloseStrongDir = writeEvents('run-self-close-strong', [
  ev({ event_type: 'check_failed', agent: 'Build Boss', event_id: 'ev-self-strong-1', task: 'lint gate' }),
  ev({ event_type: 'fix_completed', agent: 'Build Boss', closes_event_id: 'ev-self-strong-1', evidence: 'reran the suite: 12/12 passed' }),
]);
const selfCloseStrong = V.verifyRun(selfCloseStrongDir, {});
const selfCloseStrongAgent = selfCloseStrong.agents.find((a) => a.agent === 'Build Boss');
t('VERIFY-ARBITRARY-CLOSURE: self-closure WITH a real tally line succeeds', selfCloseStrongAgent.tasksOpen.length === 0);

// ---- VERIFY-SELF-WAIVER: an agent-attributed (non-owner) decision must NOT clear an acceptance gap ----
writePrdMeta('prd-cov-self-waiver', [{ id: 'ac-1', text: 'Needs a real owner decision' }]);
const selfWaiverDir = writeEvents('run-ac-self-waiver', [
  ev({ event_type: 'prd_generated', agent: 'orchestrator', prd_id: 'prd-cov-self-waiver', run_id: 'run-ac-self-waiver' }),
  ev({ event_type: 'decision_logged', agent: 'Build Boss', prd_id: 'prd-cov-self-waiver', ac_id: 'ac-1', decision: 'I decided this is fine, skipping the ticket', by: 'Build Boss' }),
]);
const selfWaiver = V.checkAcceptanceCoverage('run-ac-self-waiver', { runDir: selfWaiverDir, ownerAllowlist: new Set(['owner']) });
t('VERIFY-SELF-WAIVER: a decision attributed to a non-owner agent does NOT clear the gap', selfWaiver.acceptance_gaps.length === 1);
// counterweight: the SAME shape with `by` in the allow-list clears it
const realWaiverDir = writeEvents('run-ac-real-waiver', [
  ev({ event_type: 'prd_generated', agent: 'orchestrator', prd_id: 'prd-cov-self-waiver', run_id: 'run-ac-real-waiver' }),
  ev({ event_type: 'decision_logged', agent: 'Build Boss', prd_id: 'prd-cov-self-waiver', ac_id: 'ac-1', decision: 'owner reviewed and waived this criterion', by: 'owner' }),
]);
const realWaiver = V.checkAcceptanceCoverage('run-ac-real-waiver', { runDir: realWaiverDir, ownerAllowlist: new Set(['owner']) });
t('VERIFY-SELF-WAIVER counterweight: a decision attributed to a configured owner id DOES clear the gap', realWaiver.acceptance_gaps.length === 0);

// ---- EVENT-RUN-BINDING-GAP: a foreign run_id event must not be treated as belonging to THIS run ----
const foreignRunDir = writeEvents('run-foreign-binding-target', [
  ev({ event_type: 'agent_started', agent: 'Build Boss' }),
  ev({ event_type: 'check_started', agent: 'Build Boss', task: 'unit tests' }),
  ev({ event_type: 'check_passed', agent: 'Build Boss', task: 'unit tests', run_id: 'OTHER-RUN' }), // foreign run_id
  ev({ event_type: 'agent_completed', agent: 'Build Boss', status: 'done' }),
]);
const foreignRun = V.verifyRun(foreignRunDir, {});
t('EVENT-RUN-BINDING-GAP: a foreign run_id event is excluded and reported', foreignRun.foreignRunId === 1);
const foreignRunAgent = foreignRun.agents.find((a) => a.agent === 'Build Boss');
t('EVENT-RUN-BINDING-GAP: the excluded foreign event never closed the local check_started (still open, real mismatch)', foreignRunAgent.mismatch === true);

// ---- VERIFY-READ-ERROR-GREEN: a corrupt ticket / an unreadable ticket store fails closed, isolated env ----
{
  const freshTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-verify-unreadable-'));
  const freshClaude = path.join(freshTmp, '.claude');
  fs.mkdirSync(path.join(freshClaude, 'forge-tickets'), { recursive: true });
  fs.writeFileSync(path.join(freshClaude, 'forge-tickets', 'tk-corrupt-gate.json'), '{not valid json', 'utf8');
  fs.mkdirSync(path.join(freshClaude, 'forge-dashboard'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'forge-dashboard', 'log-event.cjs'), path.join(freshClaude, 'forge-dashboard', 'log-event.cjs'));
  const runId = 'run-unreadable-ticket';
  const runDir = path.join(freshClaude, 'forge-runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'events.jsonl'), [
    ev({ event_type: 'agent_started', agent: 'Clean Boss' }),
    ev({ event_type: 'check_passed', agent: 'Clean Boss', task: 'suite' }),
    ev({ event_type: 'agent_completed', agent: 'Clean Boss' }),
  ].join('\n') + '\n', 'utf8');
  const freshEnv = Object.assign({}, process.env, { FORGE_STORE_ROOT: freshClaude });
  const r = spawnSync(process.execPath, [path.join(__dirname, 'forge-verify.cjs'), runId, '--root', freshTmp, '--json'], { env: freshEnv, encoding: 'utf8' });
  t('VERIFY-READ-ERROR-GREEN: a corrupt ticket file in the store gates the CLI (nonzero), even though the run itself is otherwise clean', r.status !== 0);
  t('VERIFY-READ-ERROR-GREEN: the printed VERIFY line names the open/unreadable ticket gate', /open\/unreadable ticket/.test(r.stdout));
}

// ================================================================================================
// V23/V24/V27/V31 (2026-09-24 second Codex recheck, out-p7.md)
// ================================================================================================

// ---- V23: a DISPROVEN completion (_forge_verify.proof_verified:false) must not close its own paired task,
// even with an otherwise-perfectly-positive status/verdict ----
{
  const disprovenCloseDir = writeEvents('run-v23-disproven-close', [
    ev({ event_type: 'check_started', agent: 'Build Boss', task: 'lint gate' }),
    ev({ event_type: 'check_passed', agent: 'Build Boss', task: 'lint gate', _forge_verify: { proof_verified: false } }),
  ]);
  const disprovenClose = V.verifyRun(disprovenCloseDir, {});
  const disprovenCloseAgent = disprovenClose.agents.find((a) => a.agent === 'Build Boss');
  t('V23: a disproven check_passed does NOT close its paired check_started (task stays open)', disprovenCloseAgent.tasksOpen.length === 1);
  t('V23: the surviving task is reported failed, not silently done', disprovenCloseAgent.tasksOpen[0].status === 'failed');
}
// ---- V23 counterweight: the same shape WITHOUT the disproven stamp closes normally ----
{
  const provenCloseDir = writeEvents('run-v23-proven-close', [
    ev({ event_type: 'check_started', agent: 'Build Boss', task: 'lint gate' }),
    ev({ event_type: 'check_passed', agent: 'Build Boss', task: 'lint gate' }),
  ]);
  const provenClose = V.verifyRun(provenCloseDir, {});
  const provenCloseAgent = provenClose.agents.find((a) => a.agent === 'Build Boss');
  t('V23 counterweight: an ordinary (non-disproven) check_passed closes its pair as before', provenCloseAgent.tasksOpen.length === 0);
}
// ---- V23: a disproven completion must not close a closes_event_id target either ----
{
  const disprovenClosesIdDir = writeEvents('run-v23-disproven-closes-id', [
    ev({ event_type: 'check_failed', agent: 'Review Boss', event_id: 'ev-v23-1', task: 'security check' }),
    ev({ event_type: 'fix_completed', agent: 'orchestrator', closes_event_id: 'ev-v23-1', evidence: 'reran, 5/5 passed', _forge_verify: { proof_verified: false } }),
  ]);
  const disprovenClosesId = V.verifyRun(disprovenClosesIdDir, {});
  const disprovenClosesIdAgent = disprovenClosesId.agents.find((a) => a.agent === 'Review Boss');
  t('V23: a disproven closes_event_id completion does not clear the target (still open)', disprovenClosesIdAgent.tasksOpen.length === 1);
}
// ---- V23: forge-runcontract.cjs's independent-review protocol also rejects a disproven review completion
// (isGoedkeuring), not just forge-verify.cjs's task-closure path — same central predicate, both call sites ----
{
  const RC = require('./forge-runcontract.cjs');
  const positive = RC.isGoedkeuring({ review_verdict: 'approved' });
  t('V23 setup: an ordinary positive verdict is approved', positive.ok === true);
  const disprovenPositive = RC.isGoedkeuring({ review_verdict: 'approved', _forge_verify: { proof_verified: false } });
  t('V23: isGoedkeuring rejects a disproven event even with a positive verdict string', disprovenPositive.ok === false);
}

// ---- V24: a review_completed with ONLY {ok:false} (no verdict/status/result/outcome field at all) must
// be recognised as an outcome and read as failed, not fall through to the TERMINAL_TYPES 'done' default ----
{
  t('V24: reviewOutcome({event_type:review_completed, ok:false}) is failed, not null', V.reviewOutcome({ event_type: 'review_completed', ok: false }) === 'failed');
  const okFalseReviewDir = writeEvents('run-v24-ok-false-review', [
    ev({ event_type: 'review_started', agent: 'Review Boss', review_id: 'rv-v24', task: 'review the change' }),
    ev({ event_type: 'review_completed', agent: 'Review Boss', review_id: 'rv-v24', ok: false }),
    ev({ event_type: 'agent_completed', agent: 'Review Boss', status: 'done' }),
  ]);
  const okFalseReview = V.verifyRun(okFalseReviewDir, {});
  const okFalseReviewAgent = okFalseReview.agents.find((a) => a.agent === 'Review Boss');
  t('V24: the review_completed with ok:false keeps the paired review OPEN (mismatch), not silently done', okFalseReviewAgent.mismatch === true && okFalseReviewAgent.tasksOpen.length === 1);
  const okFalseCli = spawnSync(process.execPath, [path.join(__dirname, 'forge-verify.cjs'), 'run-v24-ok-false-review', '--root', TMP], { encoding: 'utf8' });
  t('V24: the CLI exits nonzero on an ok:false-only failed review followed by agent_completed', okFalseCli.status !== 0);
}

// ================================================================================================
// V24 REGRESSION (2026-09-24 THIRD Codex recheck, out-p8.md) — the wave-2 fix above delegated to
// forge-runcontract.cjs's isGoedkeuring(), a DIFFERENT, stricter protocol that requires a textual verdict
// field to be present at all — so a bare {ok:true} (no textual verdict) regressed from 'done' at the
// original baseline to 'failed'. Fixed by delegating to forge-proof-gate.cjs's own canonical reviewOutcome().
//
// This EXACT fixture table is duplicated verbatim in forge-dashboard/forge-honesty.test.cjs against app.js's
// own hand-mirrored reviewOutcome() — both consumers are asserted against the SAME data so they cannot
// silently drift apart again the way forge-verify.cjs and app.js just did.
// ================================================================================================
const V24_REVIEW_OUTCOME_FIXTURES = [
  { name: 'ok:true alone (no textual verdict) -> done (the regression this fix restores)', event: { event_type: 'review_completed', ok: true }, expect: 'done' },
  { name: 'ok:false alone -> failed', event: { event_type: 'review_completed', ok: false }, expect: 'failed' },
  { name: 'positive textual verdict alone -> done', event: { event_type: 'review_completed', review_verdict: 'approved' }, expect: 'done' },
  { name: 'positive textual verdict + ok:true (agreeing) -> done', event: { event_type: 'review_completed', review_verdict: 'pass', ok: true }, expect: 'done' },
  { name: 'positive textual verdict CONTRADICTED by ok:false -> failed', event: { event_type: 'review_completed', review_verdict: 'pass', ok: false }, expect: 'failed' },
  { name: 'negative textual verdict ("needs fixes") -> failed', event: { event_type: 'review_completed', status: 'needs fixes' }, expect: 'failed' },
  { name: 'disproven claim (_forge_verify.proof_verified:false) + ok:true -> failed', event: { event_type: 'review_completed', ok: true, _forge_verify: { proof_verified: false } }, expect: 'failed' },
  { name: 'no outcome signal at all -> null (caller uses its own default)', event: { event_type: 'review_completed' }, expect: null },
];
for (const fx of V24_REVIEW_OUTCOME_FIXTURES) {
  const got = V.reviewOutcome(fx.event);
  t('V24 fixture-table (forge-verify.cjs reviewOutcome): ' + fx.name, got === fx.expect, 'got=' + JSON.stringify(got));
}
{
  // end-to-end counterweight: the restored boolean-only 'done' path actually closes its paired task again
  const okTrueReviewDir = writeEvents('run-v24-ok-true-review', [
    ev({ event_type: 'review_started', agent: 'Review Boss', review_id: 'rv-v24b', task: 'review the change' }),
    ev({ event_type: 'review_completed', agent: 'Review Boss', review_id: 'rv-v24b', ok: true }),
  ]);
  const okTrueReview = V.verifyRun(okTrueReviewDir, {});
  const okTrueReviewAgent = okTrueReview.agents.find((a) => a.agent === 'Review Boss');
  t('V24 REGRESSION: a boolean-only ok:true review_completed closes its paired review_started (done, not failed)', okTrueReviewAgent.tasksOpen.length === 0);
}

// ---- V27: one completion closes ONE obligation — its own natural TASK_PAIRS pair, never ALSO an unrelated
// closes_event_id target at the same time ----
{
  const pairPlusReferenceDir = writeEvents('run-v27-pair-plus-reference', [
    ev({ event_type: 'fix_started', agent: 'Build Boss' }),
    ev({ event_type: 'check_failed', agent: 'Review Boss', event_id: 'ev-v27-1', task: 'security check' }),
    ev({ event_type: 'fix_completed', agent: 'Build Boss', closes_event_id: 'ev-v27-1', evidence: 'fixed my own thing, 5/5 passed' }),
  ]);
  const pairPlusReference = V.verifyRun(pairPlusReferenceDir, {});
  const buildBossAgent = pairPlusReference.agents.find((a) => a.agent === 'Build Boss');
  const reviewBossAgent = pairPlusReference.agents.find((a) => a.agent === 'Review Boss');
  t('V27: the completion closes its own paired fix_started task', buildBossAgent.tasksOpen.length === 0);
  t('V27: the UNRELATED reviewer failure stays open — not double-closed by the same completion', reviewBossAgent.tasksOpen.length === 1);
  t('V27: an advisory explains the reference was ignored (one obligation, not two)', pairPlusReference.closesAdvisories.some((a) => /one obligation/.test(a)));
}
// ---- V27 counterweight: when the completion has NO natural pair of its own, closes_event_id still works
// exactly as before (this fix must not disable RULE 2 in general) ----
{
  const noNaturalPairDir = writeEvents('run-v27-no-natural-pair', [
    ev({ event_type: 'check_failed', agent: 'Review Boss', event_id: 'ev-v27-2', task: 'security check' }),
    ev({ event_type: 'fix_completed', agent: 'orchestrator', closes_event_id: 'ev-v27-2', evidence: 'fixed it, 5/5 passed' }),
  ]);
  const noNaturalPair = V.verifyRun(noNaturalPairDir, {});
  const reviewBossAgent2 = noNaturalPair.agents.find((a) => a.agent === 'Review Boss');
  t('V27 counterweight: closes_event_id still closes a genuinely unrelated task when the closer has no natural pair of its own', reviewBossAgent2.tasksOpen.length === 0);
}

// ---- V31: a MALFORMED run_id (null / non-string) must never close a current-run obligation — same
// treatment as an already-rejected FOREIGN STRING run_id, not the same treatment as a genuinely absent one ----
{
  const nullRunIdDir = writeEvents('run-v31-null-run-id', [
    ev({ event_type: 'agent_started', agent: 'Build Boss' }),
    ev({ event_type: 'check_started', agent: 'Build Boss', task: 'unit tests' }),
    ev({ event_type: 'check_passed', agent: 'Build Boss', task: 'unit tests', run_id: null }),
    ev({ event_type: 'agent_completed', agent: 'Build Boss', status: 'done' }),
  ]);
  const nullRunId = V.verifyRun(nullRunIdDir, {});
  t('V31: a run_id:null event is excluded and counted exactly like a foreign string run_id', nullRunId.foreignRunId === 1);
  const nullRunIdAgent = nullRunId.agents.find((a) => a.agent === 'Build Boss');
  t('V31: the excluded null-run_id event never closed the local check_started (still open, real mismatch)', nullRunIdAgent.mismatch === true);
}
{
  const numberRunIdDir = writeEvents('run-v31-number-run-id', [
    ev({ event_type: 'agent_started', agent: 'Build Boss' }),
    ev({ event_type: 'check_started', agent: 'Build Boss', task: 'unit tests' }),
    ev({ event_type: 'check_passed', agent: 'Build Boss', task: 'unit tests', run_id: 12345 }),
    ev({ event_type: 'agent_completed', agent: 'Build Boss', status: 'done' }),
  ]);
  const numberRunId = V.verifyRun(numberRunIdDir, {});
  t('V31: a non-string (number) run_id is also excluded, not treated as legacy-absent', numberRunId.foreignRunId === 1);
}
// ---- V31 counterweight: a genuinely ABSENT run_id key (never set at all) is still the ordinary legacy
// case and is left alone — this fix must not regress every run_id-less fixture in this file ----
{
  const absentRunIdDir = writeEvents('run-v31-absent-run-id', [
    ev({ event_type: 'agent_started', agent: 'Build Boss' }),
    ev({ event_type: 'check_started', agent: 'Build Boss', task: 'unit tests' }),
    ev({ event_type: 'check_passed', agent: 'Build Boss', task: 'unit tests' }),
    ev({ event_type: 'agent_completed', agent: 'Build Boss', status: 'done' }),
  ]);
  const absentRunId = V.verifyRun(absentRunIdDir, {});
  t('V31 counterweight: a genuinely absent run_id field is legacy-allowed, not foreign', absentRunId.foreignRunId === 0);
  const absentRunIdAgent = absentRunId.agents.find((a) => a.agent === 'Build Boss');
  t('V31 counterweight: the ordinary run_id-less event closes its pair normally', absentRunIdAgent.mismatch === false);
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
