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

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
