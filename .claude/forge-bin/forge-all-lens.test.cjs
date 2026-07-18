#!/usr/bin/env node
'use strict';
/** Offline, headless test for the "ALL" dashboard lens (forge-dashboard/lenses.js, lens id kept as
 *  'note' so existing ?lens=note URLs keep working). Loads the REAL lenses.js source in a Node vm
 *  context (same technique as forge-mindmap-lens.test.cjs) so a pass here proves the shipped lens's
 *  build() code actually behaves, not a reimplementation. Never touches the real project; pure
 *  in-memory. Exit 0 = all pass.
 *
 *  2026-07-10 layout rework (owner sketch): USER REQUEST -> LEAD AGENT -> HEAD CHEF (only if a real
 *  agent matches it) -> Boss lanes (each with its own real task chain) -> REVIEW -> CODEX -> FIX LOOP ->
 *  FINAL OUTPUT, with the system summary nodes (GATES/DOCTOR/PRD/MIND MAP/VAULT/TICKETS/COST) moved into
 *  a separate, edge-less top strip. This file replaces the pre-rework assertions with ones that match the
 *  new node/edge shape while keeping the same spirit: data-gating, honest empty state, and the
 *  claims-vs-tasks mismatch prefix all still get exercised. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };

const LENSES_PATH = path.join(__dirname, '..', 'forge-dashboard', 'lenses.js');
const LENSES_SRC = fs.readFileSync(LENSES_PATH, 'utf8');

// Minimal stand-ins for the app.js-provided window.Forge helpers the lens calls (real definitions live in
// app.js, loaded AFTER lenses.js in index.html). isLeadNode/isCodexNode/isReportNode/isPreflight/
// isSubagentNode mirror app.js's actual regexes closely (not simplified fakes) so head-chef / review-boss
// / lead detection in these tests means something real.
function forgeStub() {
  const _rk = (a) => (String((a && a.role) || '') + ' ' + String((a && a.key) || '')).toLowerCase();
  return {
    agentColor(key, role) { return { role: role || 'role', glyph: '●', solid: '#8f8', fill: 'rgba(0,0,0,.1)', fillLo: 'rgba(0,0,0,.05)', label: String(role || 'agent').toUpperCase(), band: 'domain' }; },
    nodeState(a) { return (a && a.status) || 'waiting'; },
    trunc(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; },
    hhmmss(ts) { return String(ts || ''); },
    isLeadNode(a) { return /lead|orchestr|integrat/.test(_rk(a)); },
    isCodexNode(a) { return /codex/.test(_rk(a)); },
    isReportNode(a) { return (a && a.group === 'report') || /report.?writer|deliver|final.?output/.test(_rk(a)); },
    isPreflight(a) { if (this.isLeadNode(a)) return false; const k = String((a && a.key) || '').toLowerCase();
      if (a && a.group === 'context') return true;
      return /forge-router|memory-loader|project-scan|ecc-mode|forge-core|task-history|dashboard-status|project-identity|skill-runner/.test(k); },
    isSubagentNode(a) { return !this.isPreflight(a) && !this.isLeadNode(a) && !this.isCodexNode(a) && !this.isReportNode(a); },
    runtimeBadge() { return { text: '', full: '' }; },
    codexStatus() { return { state: 'previewing', label: 'CODEX —' }; },
    categoryLabel(role) { return String(role || 'SPECIALIST').toUpperCase(); },
    statusLabel(s) { return String(s || 'WAITING').toUpperCase(); },
  };
}

// Loads a fresh copy of lenses.js into its own vm context (new context per call -> no top-level
// const/let redeclaration clashes across calls). `withPanelStubs` optionally attaches SANDBOX-GLOBAL
// gateVerdicts/gatesOverall/costStats (the shape panels.js gives them in the real page — bare global
// function declarations, not window.Forge members) so the `typeof gateVerdicts === 'function'` guards
// in the lens can be exercised both present and absent.
function loadLenses(withPanelStubs) {
  const sandbox = { window: { Forge: forgeStub() }, console };
  if (withPanelStubs) {
    sandbox.gateVerdicts = () => ({
      tests: { state: 'pass', evidence: '6/6 checks' },
      build: { state: 'pass', evidence: 'quality gate passed' },
      screenshot: { state: 'pass', evidence: 'screenshot captured' },
      security: { state: 'pass', evidence: 'security check passed' },
      codex: { state: 'pass', evidence: 'codex review completed' },
      lead: { state: 'pending', evidence: 'no lead review logged yet' },
    });
    sandbox.gatesOverall = (g) => {
      const req = ['tests', 'build', 'screenshot', 'security', 'lead'];
      const bad = req.some((k) => g[k].state !== 'pass');
      return { ok: !bad, text: bad ? 'required gates pending' : 'all required gates pass' };
    };
    sandbox.costStats = () => ({ any: true, totalTokens: 4200, totalCost: 1.23, perAgent: new Map(), budget: null });
  }
  vm.createContext(sandbox);
  vm.runInContext(LENSES_SRC, sandbox, { filename: 'lenses.js' });
  return sandbox.window.Forge;
}

console.log('forge "ALL" dashboard lens offline tests (headless vm)');

t('lenses.js source still registers the lens under id "note"', /note:\s*\{\s*id:\s*['"]note['"]/.test(LENSES_SRC));
t('lenses.js source labels the tab "ALL"', /id:\s*['"]note['"][\s\S]{0,20}label:\s*['"]ALL['"]/.test(LENSES_SRC));

const positionsDistinct = (nodes) => {
  const seen = new Set();
  for (const n of nodes) { const key = Math.round(n.x) + ',' + Math.round(n.y); if (seen.has(key)) return false; seen.add(key); }
  return seen.size === nodes.length;
};
const byId = (nodes, id) => nodes.find((n) => n.id === id);
const noOverlap = (nodes) => { // real bounding-box overlap check (stronger than distinct-position)
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i], b = nodes[j];
    const ax2 = a.x + a.w, ay2 = a.y + (a.h || 66), bx2 = b.x + b.w, by2 = b.y + (b.h || 66);
    const overlaps = a.x < bx2 && ax2 > b.x && a.y < by2 && ay2 > b.y;
    if (overlaps) return false;
  }
  return true;
};
// CLEARANCE check (owner 2026-07-10 "meer ruimte er tussen"): every pair of node boxes must keep at
// least `gap` px of AIR between them — inflate each box by gap/2 on all sides and require the inflated
// boxes still don't intersect. Stronger than noOverlap: touching or near-touching nodes FAIL this.
const minClearance = (nodes, gap) => {
  const g = gap / 2;
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i], b = nodes[j];
    const ax1 = a.x - g, ay1 = a.y - g, ax2 = a.x + a.w + g, ay2 = a.y + (a.h || 66) + g;
    const bx1 = b.x - g, by1 = b.y - g, bx2 = b.x + b.w + g, by2 = b.y + (b.h || 66) + g;
    if (ax1 < bx2 && ax2 > bx1 && ay1 < by2 && ay2 > by1) return { a: a.id, b: b.id };
  }
  return null;
};

// ---------------------------------------------------------------------------------------------------
// 1) Full pipeline: USER REQUEST (run.request set) + LEAD (with a claims-vs-tasks mismatch) + a real
//    HEAD CHEF agent + a real REVIEW BOSS agent (pulled OUT of the Boss-lane fan-out) + 2 ordinary Boss
//    lanes (search-boss, build-boss) each with their own real tasks + real fix/retest events (-> FIX
//    LOOP renders) + stubbed gates/doctor/prd/mindmap/tickets/artifacts/cost (-> full top strip).
// ---------------------------------------------------------------------------------------------------
{
  const Forge = loadLenses(true);
  const ctx = {
    run: { request: 'Build the checkout flow end to end, ship it, and document it for the team' },
    agents: [
      { key: 'search-boss', role: 'Research / current information', status: 'done', derived: false, group: 'domain', tasks: [
        { evIdx: 0, title: 'gather context', status: 'done', ts: 't1' },
        { evIdx: 1, title: 'research', status: 'done', ts: 't2' },
      ] },
      { key: 'build-boss', role: 'Implementation / coding', status: 'running', derived: false, group: 'execution', tasks: [
        { evIdx: 2, title: 'implement feature', status: 'done', ts: 't3' },
        { evIdx: 3, title: 'local checks', status: 'running', ts: 't4' },
      ] },
      { key: 'head-chef', role: 'Execution controller / task planner', status: 'done', derived: false, group: 'planning', tasks: [] },
      { key: 'review-boss', role: 'Final QA reviewer', status: 'running', derived: false, group: 'review', tasks: [
        { evIdx: 4, title: 'final QA pass', status: 'running', ts: 't5' },
      ] },
      { key: 'lead-orchestrator', role: 'Lead Agent / orchestrator', status: 'done', derived: false, _claimMismatch: true, group: 'control', tasks: [
        { evIdx: 5, title: 'plan mission', status: 'done', ts: 't0' },
        { evIdx: 6, title: 'open follow-up', status: 'running', ts: 't6' },
      ] },
    ],
    events: [
      { event_type: 'run_started', timestamp: 't0' },
      { event_type: 'fix_started', timestamp: 't7' },
      { event_type: 'fix_completed', timestamp: 't8' },
      { event_type: 'retest_started', timestamp: 't9' },
      { event_type: 'retest_completed', timestamp: 't10' },
    ],
    prds: [{ prd_id: 'p1', title: 'Feature X', acceptance_count: 5 }],
    mindmaps: [{ map_id: 'm1', nodes: [], edges: [] }],
    tickets: [{ ticket_id: 'tk1', status: 'open' }, { ticket_id: 'tk2', status: 'done' }],
    artifacts: [{ artifact_id: 'a1', title: 'build.zip' }],
    doctor: { ok: true, run_id: 'r1' },
  };
  const model = Forge.LENSES.note.build(ctx);
  const nodes = model.nodes, edges = model.edges;

  // --- system summary nodes: top strip, spread out, edge-less ---
  const gates = byId(nodes, 'sum:gates'), doc = byId(nodes, 'sum:doctor'), prd = byId(nodes, 'sum:prd'),
    mm = byId(nodes, 'sum:mindmap'), vault = byId(nodes, 'sum:vault'), tix = byId(nodes, 'sum:tickets'), cost = byId(nodes, 'sum:cost');
  t('GATES summary node is present', !!gates);
  t('DOCTOR summary node is present', !!doc);
  t('PRD summary node is present', !!prd);
  t('MIND MAP summary node is present', !!mm);
  t('VAULT summary node is present', !!vault);
  t('TICKETS summary node is present', !!tix);
  t('COST summary node is present', !!cost);
  t('GATES sub shows a real pass count (5/6 pass)', gates && gates.sub === '5/6 pass');
  t('DOCTOR sub honestly reports ALL GREEN', doc && doc.sub === 'ALL GREEN' && doc.state === 'done');
  t('PRD sub shows the real PRD + acceptance-criteria counts', prd && prd.sub === '1 PRD(s) · 5 AC');
  t('TICKETS sub shows the real open/total count', tix && tix.sub === '1/2 open' && tix.state === 'running');
  t('COST sub shows the real token total', cost && cost.sub === '4200 tok');

  const summaryIds = ['sum:gates', 'sum:doctor', 'sum:prd', 'sum:mindmap', 'sum:vault', 'sum:tickets', 'sum:cost'];
  const summaryNodesFound = summaryIds.map((id) => byId(nodes, id));
  const pipelineNodes = nodes.filter((n) => summaryIds.indexOf(n.id) === -1);
  t('(a) every system node sits ABOVE every pipeline node (y < all pipeline y)', summaryNodesFound.every((sn) => pipelineNodes.every((pn) => sn.y < pn.y)));
  const sysXs = summaryNodesFound.map((n) => n.x).sort((a, b) => a - b);
  let sysGapOk = true; for (let i = 1; i < sysXs.length; i++) if (sysXs[i] - sysXs[i - 1] < 200) sysGapOk = false;
  t('(a) system nodes are pairwise x-distinct with gap >= 200', sysGapOk && new Set(sysXs).size === sysXs.length);
  t('(b) system nodes have ZERO edges (never wired into the work pipeline)', summaryIds.every((id) => !edges.some((e) => e.from === id || e.to === id)));

  // --- USER REQUEST (real run.request set) ---
  const userReq = byId(nodes, 'note:mission');
  t('(c) USER REQUEST node is present when run.request is set', !!userReq);

  // --- LEAD: real agent node, mismatch prefix + gear counter, exactly like the per-agent style ---
  const leadN = byId(nodes, 'agent:lead-orchestrator');
  t('LEAD is a real agent node (id agent:lead-orchestrator)', !!leadN);
  t('LEAD shows the "⚠ claims done" mismatch prefix', !!leadN && leadN.sub.indexOf('⚠ claims done') > -1);
  t('LEAD shows a real done/total task counter', !!leadN && leadN.meta.total === 2 && leadN.meta.done === 1);

  // --- HEAD CHEF: real agent, pulled out of the Boss-lane fan-out ---
  const headChef = byId(nodes, 'agent:head-chef');
  t('HEAD CHEF node is present (a real head-chef/task-planner agent exists)', !!headChef);
  t('HEAD CHEF is NOT also rendered as a Boss lane (only one node for head-chef)', nodes.filter((n) => n.refKey === 'head-chef').length === 1);

  // --- REVIEW BOSS: real agent, pulled out of the Boss-lane fan-out, not exploded into a task chain ---
  const reviewN = byId(nodes, 'agent:review-boss');
  t('REVIEW is the real review-boss agent node (not a derived milestone)', !!reviewN);
  t('REVIEW BOSS is NOT also rendered as a Boss lane (only one node for review-boss)', nodes.filter((n) => n.refKey === 'review-boss').length === 1);
  t('review-boss\'s own task is summarized on the node, not exploded into a separate task node', !byId(nodes, 'task:4'));

  // --- Boss lanes: search-boss, build-boss, each with their own real task chain ---
  const searchBoss = byId(nodes, 'agent:search-boss'), buildBoss = byId(nodes, 'agent:build-boss');
  t('Boss lane "search-boss" is present', !!searchBoss);
  t('Boss lane "build-boss" is present', !!buildBoss);
  t('search-boss\'s 2 tasks are real chained task nodes', !!byId(nodes, 'task:0') && !!byId(nodes, 'task:1'));
  t('build-boss\'s 2 tasks are real chained task nodes', !!byId(nodes, 'task:2') && !!byId(nodes, 'task:3'));
  t('LEAD\'s own tasks are summarized on the node, not exploded into separate task nodes', !byId(nodes, 'task:5') && !byId(nodes, 'task:6'));

  // --- CODEX + FIX LOOP + FINAL OUTPUT (milestones; no real codex/report agent in this fixture) ---
  const codexN = byId(nodes, 'note:codex'), fixN = byId(nodes, 'note:fix'), finalN = byId(nodes, 'note:final');
  t('CODEX REVIEW milestone node is present', !!codexN);
  t('FIX LOOP node is present (real fix_started/fix_completed + retest events exist)', !!fixN);
  t('FINAL OUTPUT milestone node is present', !!finalN);

  // --- (d) pipeline x-order: USER REQUEST < LEAD < Boss < its tasks < REVIEW < CODEX < FIX < FINAL ---
  t('(d) USER REQUEST is left of LEAD', userReq.x < leadN.x);
  t('(d) LEAD is left of HEAD CHEF', leadN.x < headChef.x);
  t('(d) HEAD CHEF is left of the Boss lanes', headChef.x < searchBoss.x && headChef.x < buildBoss.x);
  t('(d) a Boss lane is left of its own tasks', searchBoss.x < byId(nodes, 'task:0').x && byId(nodes, 'task:0').x < byId(nodes, 'task:1').x);
  t('(d) the Boss lanes are left of REVIEW', Math.max(byId(nodes, 'task:1').x, byId(nodes, 'task:3').x) < reviewN.x);
  t('(d) REVIEW is left of CODEX', reviewN.x < codexN.x);
  t('(d) CODEX is left of FIX LOOP', codexN.x < fixN.x);
  t('(d) FIX LOOP is left of FINAL OUTPUT', fixN.x < finalN.x);

  // --- feedback loop + core wiring ---
  t('FIX LOOP feeds back to LEAD with the dashed "loop" edge kind', edges.some((e) => e.from === fixN.id && e.to === leadN.id && e.kind === 'loop'));
  t('USER REQUEST -> LEAD edge exists', edges.some((e) => e.from === userReq.id && e.to === leadN.id));
  t('LEAD -> HEAD CHEF edge exists', edges.some((e) => e.from === leadN.id && e.to === headChef.id));
  t('HEAD CHEF -> each Boss lane edge exists', edges.some((e) => e.from === headChef.id && e.to === searchBoss.id) && edges.some((e) => e.from === headChef.id && e.to === buildBoss.id));
  t('each Boss lane\'s last task feeds REVIEW', edges.some((e) => e.from === 'task:1' && e.to === reviewN.id) && edges.some((e) => e.from === 'task:3' && e.to === reviewN.id));
  t('REVIEW -> CODEX -> FIX LOOP -> FINAL OUTPUT chain exists', edges.some((e) => e.from === reviewN.id && e.to === codexN.id) && edges.some((e) => e.from === codexN.id && e.to === fixN.id) && edges.some((e) => e.from === fixN.id && e.to === finalN.id));

  // --- (f) no overlaps anywhere ---
  t('(f) all node positions are DISTINCT (no overlap)', positionsDistinct(nodes));
  t('(f) no two node bounding boxes actually overlap', noOverlap(nodes));
  // --- (g) CLEARANCE: enough breathing room so nothing "in de weg staat" ---
  const tooClose = minClearance(nodes, 40);
  t('(g) EVERY pair of nodes keeps >=40px air between boxes' + (tooClose ? ' (violated: ' + tooClose.a + ' vs ' + tooClose.b + ')' : ''), tooClose === null);
  const stripClear = minClearance(nodes.filter((n) => n.id.startsWith('sum:')), 100);
  t('(g) system-strip cards keep >=100px air between each other' + (stripClear ? ' (violated: ' + stripClear.a + ' vs ' + stripClear.b + ')' : ''), stripClear === null);
  t('world.w and world.h are positive', model.world && model.world.w > 0 && model.world.h > 0);
}

// ---------------------------------------------------------------------------------------------------
// 2) fully empty ctx (no agents, no events, no store data, doctor null) -> honest empty model, no crash.
// ---------------------------------------------------------------------------------------------------
{
  const Forge = loadLenses(true);
  const emptyCtx = { agents: [], events: [], prds: [], tickets: [], artifacts: [], mindmaps: [], doctor: null, run: {} };
  const model = Forge.LENSES.note.build(emptyCtx);
  t('fully empty ctx -> 0 nodes (honest empty, not a crash)', Array.isArray(model.nodes) && model.nodes.length === 0);
  t('fully empty ctx -> 0 edges', Array.isArray(model.edges) && model.edges.length === 0);
  t('fully empty ctx -> positive placeholder world size', model.world && model.world.w > 0 && model.world.h > 0);

  t('build() with entirely missing ctx fields never throws', (() => {
    try { const m = Forge.LENSES.note.build({ agents: [], events: [] }); return Array.isArray(m.nodes) && m.nodes.length === 0; } catch { return false; }
  })());
}

// ---------------------------------------------------------------------------------------------------
// 3) events + agents present, but NO store data, NO run.request, NO head-chef/review-boss agent, AND
//    gateVerdicts/gatesOverall/costStats are not even defined (typeof guard exercised) -> the "solo" Boss
//    lane + its task render, but nothing else is fabricated: no summary node, no USER REQUEST node, no
//    HEAD CHEF node, no extra agent-kind node.
// ---------------------------------------------------------------------------------------------------
{
  const Forge = loadLenses(false); // no gateVerdicts/gatesOverall/costStats in this sandbox at all
  const ctx = {
    agents: [{ key: 'solo', role: 'developer', status: 'running', derived: false, group: 'domain', tasks: [
      { evIdx: 0, title: 'do the thing', status: 'running', ts: 't1' },
    ] }],
    events: [{ event_type: 'agent_started', agent: 'solo', timestamp: 't0' }],
    prds: [], tickets: [], artifacts: [], mindmaps: [], doctor: null,
  };
  const model = Forge.LENSES.note.build(ctx);
  const nodes = model.nodes;
  t('Boss lane "solo" is present', !!byId(nodes, 'agent:solo'));
  t('its task node is present', !!byId(nodes, 'task:0'));
  t('NO summary node ("sum:*") is fabricated when stores are empty and gate/cost fns are absent', !nodes.some((n) => String(n.id).indexOf('sum:') === 0));
  t('(c) NO USER REQUEST node is fabricated when ctx.run has no request', !byId(nodes, 'note:mission'));
  t('(e) NO HEAD CHEF node is fabricated when no agent matches head-chef/task-planner', !nodes.some((n) => n.refKey && /head.?chef|task.?planner/i.test(n.refKey)));
  t('only ONE real agent-kind node exists ("solo") — nothing extra invented', nodes.filter((n) => n.kind === 'agent').length === 1);
  t('all node positions are DISTINCT (no overlap) even in the minimal case', positionsDistinct(nodes));
  t('no bounding-box overlap even in the minimal case', noOverlap(nodes));
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
