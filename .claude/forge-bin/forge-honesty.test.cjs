#!/usr/bin/env node
'use strict';
/** Offline, headless test for the Forge dashboard HONESTY fixes (2026-07-10 investigation): task
 *  double-counting in buildNodes(), the ticket_created/cost_sampled taxonomy gap, the claims-vs-tasks
 *  mismatch flag, eta()/nextStep() honesty, the badge-complete/tp-check replay gate, the Codex-fail gate
 *  banner, and the unstamped-events trust gap.
 *
 *  Loads the REAL app.js and then the REAL panels.js source into ONE Node vm context — the same order
 *  and same shared global scope index.html gives them as two consecutive <script> tags — with a minimal
 *  document/window stub. A pass here proves the SHIPPED buildNodes()/taskStatus()/eta()/nextStep()/
 *  gatesOverall()/trustStats() actually behave this way, not a reimplementation. graph.js is intentionally
 *  NOT loaded (it auto-inits and needs a much larger DOM/canvas surface than this harness stubs).
 *  Pure in-memory; never touches the real project. Exit 0 = all pass. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };

const DASH_DIR = path.join(__dirname, '..', 'forge-dashboard');
const APP_SRC = fs.readFileSync(path.join(DASH_DIR, 'app.js'), 'utf8');
const PANELS_SRC = fs.readFileSync(path.join(DASH_DIR, 'panels.js'), 'utf8');

function makeEl() { return { innerHTML: '', textContent: '', className: '', hidden: false, style: {}, dataset: {}, scrollHeight: 0, scrollTop: 0, clientHeight: 0 }; }

// Loads the REAL app.js then the REAL panels.js into ONE fresh vm context with a minimal document/window
// stub. Returns run(code) — executes a code string inside that live context and returns its completion
// value, so STATE/buildNodes/etc. referenced by `code` are the actual shipped bindings (STATE is declared
// `const` in app.js, so it is only reachable through vm.runInContext expressions, never as sandbox.STATE).
function loadDashboard() {
  const elements = new Map();
  const document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, makeEl()); return elements.get(id); },
    querySelectorAll() { return []; }, createElement() { return makeEl(); },
  };
  const sandbox = { document, console, window: {} };
  vm.createContext(sandbox);
  vm.runInContext(APP_SRC, sandbox, { filename: 'app.js' });
  vm.runInContext(PANELS_SRC, sandbox, { filename: 'panels.js' });
  return { sandbox, run: (code) => vm.runInContext(code, sandbox) };
}

console.log('forge dashboard honesty-fix offline tests (headless vm, real app.js + panels.js)');

t('app.js defines a TASK_PAIRS start/terminal pairing table', /TASK_PAIRS\s*=\s*\{/.test(APP_SRC));
t('app.js taskStatus() closes the ticket/cost taxonomy gap', /'ticket_created',\s*'ticket_updated',\s*'cost_sampled'/.test(APP_SRC));
t('app.js buildNodes() computes a _claimMismatch flag', /_claimMismatch\s*=/.test(APP_SRC));
t('panels.js gatesOverall() flags a Codex fail distinctly from a clean pass', /Codex flagged an issue/.test(PANELS_SRC));
t('panels.js GATE_REQUIRED still excludes codex (skip must never block green)', !/GATE_REQUIRED\s*=\s*\[[^\]]*'codex'/.test(PANELS_SRC));
t('panels.js trustStats() tracks unstamped events', /unstamped/.test(PANELS_SRC));

// ---------------------------------------------------------------------------------------------------
// 1) started x3 + passed x3 + subagent_completed -> 3 tasks (paired, not 6), all done, no mismatch.
// ---------------------------------------------------------------------------------------------------
{
  const { run } = loadDashboard();
  const events = [
    { agent: 'tester', event_type: 'check_started', task: 'check A', timestamp: '2026-07-10T00:00:00Z' },
    { agent: 'tester', event_type: 'check_passed', task: 'check A', timestamp: '2026-07-10T00:00:01Z' },
    { agent: 'tester', event_type: 'check_started', task: 'check B', timestamp: '2026-07-10T00:00:02Z' },
    { agent: 'tester', event_type: 'check_passed', task: 'check B', timestamp: '2026-07-10T00:00:03Z' },
    { agent: 'tester', event_type: 'check_started', task: 'check C', timestamp: '2026-07-10T00:00:04Z' },
    { agent: 'tester', event_type: 'check_passed', task: 'check C', timestamp: '2026-07-10T00:00:05Z' },
    { agent: 'tester', event_type: 'subagent_completed', timestamp: '2026-07-10T00:00:06Z' },
  ];
  const r = run(`
    STATE.events = ${JSON.stringify(events)};
    STATE.run = {};
    STATE._nodes = buildNodes();
    const n = STATE._nodes.find((x) => x.key === 'tester');
    ({ tasksLen: n.tasks.length, allDone: n.tasks.every((tk) => tk.status === 'done'), status: n.status, claimMismatch: !!n._claimMismatch });
  `);
  t('Fix1: 3 paired check_started/check_passed -> 3 tasks, not 6', r.tasksLen === 3);
  t('Fix1: all 3 paired tasks resolve to done', r.allDone === true);
  t('Fix1: node status is done (subagent_completed)', r.status === 'done');
  t('Fix3: no false claim-mismatch when everything genuinely closed', r.claimMismatch === false);
}

// ---------------------------------------------------------------------------------------------------
// 2) a check_started with no terminal + agent_completed -> open task survives (never auto-closed) AND
//    _claimMismatch === true (node claims done while a real task is still open).
// ---------------------------------------------------------------------------------------------------
{
  const { run } = loadDashboard();
  const events = [
    { agent: 'coder', event_type: 'check_started', task: 'unclosed check', timestamp: '2026-07-10T00:00:00Z' },
    { agent: 'coder', event_type: 'agent_completed', timestamp: '2026-07-10T00:00:01Z' },
  ];
  const r = run(`
    STATE.events = ${JSON.stringify(events)};
    STATE.run = { status: 'running' };
    STATE._nodes = buildNodes();
    const n = STATE._nodes.find((x) => x.key === 'coder');
    ({ tasksLen: n.tasks.length, taskStatus: n.tasks[0] && n.tasks[0].status, nodeStatus: n.status, claimMismatch: !!n._claimMismatch });
  `);
  t('Fix1: an unterminated check_started is never auto-closed', r.tasksLen === 1 && r.taskStatus === 'running');
  t('sanity: node claims done via agent_completed while a task is still open', r.nodeStatus === 'done');
  t('Fix3: claims-vs-tasks mismatch is flagged true', r.claimMismatch === true);
}

// ---------------------------------------------------------------------------------------------------
// 3) real-run shape: run_started + ticket_created x3 + cost_sampled + run.status completed -> those 4
//    one-shot FACT tasks classify as 'done' (taxonomy fix), no mismatch.
// ---------------------------------------------------------------------------------------------------
{
  const { run } = loadDashboard();
  const events = [
    { event_type: 'run_started', timestamp: '2026-07-10T00:00:00Z' },
    { event_type: 'ticket_created', note: 'ticket 1', timestamp: '2026-07-10T00:00:01Z' },
    { event_type: 'ticket_created', note: 'ticket 2', timestamp: '2026-07-10T00:00:02Z' },
    { event_type: 'ticket_created', note: 'ticket 3', timestamp: '2026-07-10T00:00:03Z' },
    { event_type: 'cost_sampled', note: 'cost sample', timestamp: '2026-07-10T00:00:04Z' },
  ];
  const r = run(`
    STATE.events = ${JSON.stringify(events)};
    STATE.run = { status: 'completed' };
    STATE._nodes = buildNodes();
    const n = STATE._nodes.find((x) => x.key === 'orchestrator');
    ({ tasksLen: n.tasks.length, statuses: n.tasks.map((tk) => tk.status), nodeStatus: n.status, claimMismatch: !!n._claimMismatch });
  `);
  t('Fix2: ticket_created x3 + cost_sampled -> 4 tasks (no false pairing collapse)', r.tasksLen === 4);
  t('Fix2: all 4 one-shot FACT tasks classify as done', r.statuses.every((s) => s === 'done'));
  t('Fix3: a genuinely-complete run has no false mismatch', r.claimMismatch === false);
}

// ---------------------------------------------------------------------------------------------------
// 4) eta() must not short-circuit to 'done' off STATE.run.status alone — only real progress() >= 100 proves it.
// ---------------------------------------------------------------------------------------------------
{
  const { run } = loadDashboard();
  const events = [
    { agent: 'builder', event_type: 'agent_started', timestamp: '2026-07-10T00:00:00Z' },
    { agent: 'builder', event_type: 'agent_failed', note: 'crashed', timestamp: '2026-07-10T00:00:01Z' },
  ];
  const r = run(`
    STATE.events = ${JSON.stringify(events)};
    STATE.run = { status: 'completed', started: '2026-07-10T00:00:00.000Z' };
    STATE._nodes = buildNodes();
    ({ progress: progress(), etaVal: eta(), nextStepVal: nextStep() });
  `);
  t('sanity: progress() is honestly < 100 with a failed, never-done node', r.progress < 100);
  t('Fix4a: eta() does not claim "done" just because run.status==="completed"', r.etaVal !== 'done');
  t('Fix4b: nextStep() does not claim "run complete" while real progress is < 100', r.nextStepVal !== 'run complete');
}

// ---------------------------------------------------------------------------------------------------
// 5) trustStats() on 9 unstamped events -> unstamped=9, stamped=0, pct null, verdict not a false OK.
// ---------------------------------------------------------------------------------------------------
{
  const { run } = loadDashboard();
  const events = Array.from({ length: 9 }, (_, i) => ({ agent: 'x', event_type: 'agent_note', note: 'n' + i, timestamp: '2026-07-10T00:00:0' + i + 'Z' }));
  const r = run(`
    STATE.events = ${JSON.stringify(events)};
    const stats = trustStats();
    const html = renderTrust();
    ({ stats, html });
  `);
  t('Fix6: 9 events with no _forge_verify stamp -> unstamped=9', r.stats.unstamped === 9);
  t('Fix6: stamped=0 -> pct is null (rendered as —, not a fabricated 100%)', r.stats.stamped === 0 && r.stats.pct === null);
  t('Fix6: verdict honestly says nothing was verified, not a false OK', r.html.includes('no stamped events') && !/trust-verdict ok"/.test(r.html));
}

// ---------------------------------------------------------------------------------------------------
// 6) gatesOverall() with codex fail + every required gate passing -> ok:false (codex stays non-required
//    but a real failure must not be hidden behind "all required gates pass").
// ---------------------------------------------------------------------------------------------------
{
  const { run } = loadDashboard();
  const r = run(`
    const g = {
      tests: { state: 'pass', evidence: '' }, build: { state: 'pass', evidence: '' },
      screenshot: { state: 'pass', evidence: '' }, security: { state: 'pass', evidence: '' },
      codex: { state: 'fail', evidence: '' }, lead: { state: 'pass', evidence: '' },
    };
    gatesOverall(g);
  `);
  t('Fix5: a Codex fail flips ok:false even though every required gate passes', r.ok === false);
  t('Fix5: banner text names the Codex flag instead of a blanket "all required gates pass"', /Codex flagged an issue/.test(r.text));
}

// ---------------------------------------------------------------------------------------------------
// WP23 (2026-09-24) — "verify: heartbeats and evidence-closed tasks", mirrored from forge-verify.cjs's
// verifyRun() into app.js's buildNodes() (same 3-place discipline the file headers describe).
// ---------------------------------------------------------------------------------------------------
{
  const { run } = loadDashboard();
  const events = [
    { agent: 'Build Boss', event_type: 'agent_started', timestamp: '2026-09-24T00:00:00Z' },
    { agent: 'Build Boss', event_type: 'agent_progress', wp_id: 'wp1', note: 'heartbeat', timestamp: '2026-09-24T00:00:01Z' },
    { agent: 'Build Boss', event_type: 'subagent_completed', wp_id: 'wp1', status: 'completed', timestamp: '2026-09-24T00:00:02Z' },
  ];
  const r = run(`
    STATE.events = ${JSON.stringify(events)};
    STATE.run = {};
    STATE._nodes = buildNodes();
    const n = STATE._nodes.find((x) => x.key === 'Build Boss');
    ({ heartbeat: n.tasks.find((tk) => tk.event && tk.event.event_type === 'agent_progress') });
  `);
  t('RULE 1: app.js closes a same-wp_id heartbeat on subagent_completed', r.heartbeat && r.heartbeat.status === 'done');
}
{
  const { run } = loadDashboard();
  const events = [
    { agent: 'Search Boss', event_type: 'agent_progress', wp_id: 'wpA', note: 'heartbeat', timestamp: '2026-09-24T00:00:00Z' },
    { agent: 'Search Boss', event_type: 'subagent_completed', wp_id: 'wpB', status: 'completed', timestamp: '2026-09-24T00:00:01Z' },
  ];
  const r = run(`
    STATE.events = ${JSON.stringify(events)};
    STATE.run = {};
    STATE._nodes = buildNodes();
    const n = STATE._nodes.find((x) => x.key === 'Search Boss');
    ({ heartbeat: n.tasks.find((tk) => tk.event && tk.event.event_type === 'agent_progress') });
  `);
  t('RULE 1: app.js does NOT close a heartbeat when the completion names a different wp_id', r.heartbeat && r.heartbeat.status !== 'done');
}
{
  const { run } = loadDashboard();
  const events = [
    { agent: 'Docs Boss', event_type: 'agent_progress', wp_id: 'wp13b', note: 'heartbeat', timestamp: '2026-09-24T00:00:00Z' },
    { agent: 'Docs Boss', event_type: 'subagent_completed', wp_id: 'wp13b', status: 'completed_with_blockers', timestamp: '2026-09-24T00:00:01Z' },
  ];
  const r = run(`
    STATE.events = ${JSON.stringify(events)};
    STATE.run = {};
    STATE._nodes = buildNodes();
    const n = STATE._nodes.find((x) => x.key === 'Docs Boss');
    ({ heartbeat: n.tasks.find((tk) => tk.event && tk.event.event_type === 'agent_progress') });
  `);
  t('RULE 1: a completed_with_blockers completion closes the heartbeat as FAILED, not done (blockers stay visible)', r.heartbeat && r.heartbeat.status === 'failed');
}
{
  const { run } = loadDashboard();
  const events = [
    { agent: 'Review Boss', event_type: 'check_failed', event_id: 'ev-app-closes-1', task: 'lint gate', timestamp: '2026-09-24T00:00:00Z' },
    { agent: 'orchestrator', event_type: 'fix_completed', closes_event_id: 'ev-app-closes-1', evidence: 'reran lint, 0 errors', timestamp: '2026-09-24T00:00:01Z' },
  ];
  const r = run(`
    STATE.events = ${JSON.stringify(events)};
    STATE.run = {};
    STATE._nodes = buildNodes();
    const n = STATE._nodes.find((x) => x.key === 'Review Boss');
    ({ closedTask: n.tasks[0], advisories: STATE._closesAdvisories.length });
  `);
  t('RULE 2: app.js closes an EARLIER task on a different node via closes_event_id + evidence', r.closedTask.status === 'done');
  t('RULE 2: no advisory for a valid closure', r.advisories === 0);
}
{
  const { run } = loadDashboard();
  const events = [
    { agent: 'Review Boss', event_type: 'check_failed', event_id: 'ev-app-closes-2', task: 'lint gate', timestamp: '2026-09-24T00:00:00Z' },
    { agent: 'orchestrator', event_type: 'fix_completed', closes_event_id: 'ev-app-closes-2', timestamp: '2026-09-24T00:00:01Z' },
  ];
  const r = run(`
    STATE.events = ${JSON.stringify(events)};
    STATE.run = {};
    STATE._nodes = buildNodes();
    const n = STATE._nodes.find((x) => x.key === 'Review Boss');
    ({ closedTask: n.tasks[0], advisories: STATE._closesAdvisories });
  `);
  t('RULE 2: without evidence, app.js closes nothing', r.closedTask.status !== 'done');
  t('RULE 2: exactly one advisory naming "no evidence"', r.advisories.length === 1 && /no evidence/.test(r.advisories[0]));
}

// ---------------------------------------------------------------------------------------------------
// RULE 3 (2026-09-24, loop wp-l1) — review_started/review_completed TASK_PAIRS pair, mirrored from
// forge-verify.cjs's verifyRun() into app.js's buildNodes() (same 3-place discipline the file headers
// describe). Real defect: a verify-boss run ended with 2 "open" review_started tasks although both
// matching review_completed events were logged.
// ---------------------------------------------------------------------------------------------------
{
  const { run } = loadDashboard();
  const events = [
    { agent: 'Review Boss', event_type: 'agent_started', timestamp: '2026-09-24T00:00:00Z' },
    { agent: 'Review Boss', event_type: 'review_started', review_id: 'rv-1', task: 'review wp1', timestamp: '2026-09-24T00:00:01Z' },
    { agent: 'Review Boss', event_type: 'review_completed', review_id: 'rv-1', status: 'PASS', timestamp: '2026-09-24T00:00:02Z' },
  ];
  const r = run(`
    STATE.events = ${JSON.stringify(events)};
    STATE.run = {};
    STATE._nodes = buildNodes();
    const n = STATE._nodes.find((x) => x.key === 'Review Boss');
    ({ review: n.tasks.find((tk) => tk.event && tk.event.event_type === 'review_started'), taskCount: n.tasks.length });
  `);
  t('RULE 3: app.js closes a same-review_id review_started on review_completed', r.review && r.review.status === 'done');
  t('RULE 3: the pair collapses into ONE task (not two)', r.taskCount === 1);
}
{
  const { run } = loadDashboard();
  const events = [
    { agent: 'Review Boss', event_type: 'review_started', review_id: 'rv-1', task: 'review wp1', timestamp: '2026-09-24T00:00:00Z' },
    { agent: 'Review Boss', event_type: 'review_completed', review_id: 'rv-2', status: 'PASS', timestamp: '2026-09-24T00:00:01Z' },
  ];
  const r = run(`
    STATE.events = ${JSON.stringify(events)};
    STATE.run = {};
    STATE._nodes = buildNodes();
    const n = STATE._nodes.find((x) => x.key === 'Review Boss');
    ({ review: n.tasks.find((tk) => tk.event && tk.event.event_type === 'review_started'), taskCount: n.tasks.length });
  `);
  t('RULE 3: app.js does NOT close a review_started when the completion names a DIFFERENT review_id', r.review && r.review.status !== 'done');
  t('RULE 3: a mismatched review_id stays two separate tasks', r.taskCount === 2);
}
{
  const { run } = loadDashboard();
  const events = [
    { agent: 'Review Boss', event_type: 'review_started', review_id: 'rv-3', task: 'review wp3', timestamp: '2026-09-24T00:00:00Z' },
    { agent: 'Review Boss', event_type: 'review_completed', review_id: 'rv-3', status: 'FAIL changes-required', timestamp: '2026-09-24T00:00:01Z' },
  ];
  const r = run(`
    STATE.events = ${JSON.stringify(events)};
    STATE.run = {};
    STATE._nodes = buildNodes();
    const n = STATE._nodes.find((x) => x.key === 'Review Boss');
    ({ review: n.tasks.find((tk) => tk.event && tk.event.event_type === 'review_started') });
  `);
  t('RULE 3: a FAIL verdict resolves the paired task as failed, not done (blockers stay visible)', r.review && r.review.status === 'failed');
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
