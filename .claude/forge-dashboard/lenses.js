'use strict';
/* Forge Control Center — lens registry + layout engine. Zero deps. Real data only.
   Every lens: build(ctx{events,run,agents}) -> { nodes:[GNode], edges:[GEdge], world:{w,h} }. */
(function () {
  const F = () => window.Forge;
  const NOTE_TYPES = new Set(['agent_note', 'agent_output', 'agent_decision_summary', 'agent_next_action', 'agent_evidence_added']);
  const EXEC_TYPES = new Set(['file_read', 'file_changed', 'command_run', 'skill_loaded']);
  const PHASES = ['classify', 'scan', 'route', 'plan', 'execute', 'review', 'report'];
  const PHASE_GLYPH = { classify: '⌖', scan: '⌕', route: '◇', plan: '▤', execute: '⚙', review: '◈', report: '▭' };
  const GORDER = ['control', 'context', 'planning', 'domain', 'execution', 'review', 'report'];
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const idx = (arr) => { const m = new Map(); arr.forEach((id, i) => m.set(id, i)); return m; };

  function node(id, label, kind, lens, state, m) { m = m || {};
    return { id, label, kind, lens, state, sub: m.sub || '', role: m.role || '', glyph: m.glyph || '', accent: m.accent || '', fill: m.fill || '', fillLo: m.fillLo || '', badge: m.badge || '', catLabel: m.catLabel || '', refKey: m.refKey, refEvIdx: m.refEvIdx, meta: m, x: 0, y: 0, w: m.w || 196, h: m.h || 66 }; }
  function edge(from, to, kind) { return { id: from + '->' + to, from, to, kind: kind || 'flow' }; }
  function agentKeyOf(e) { return e.agent || F().SYNTH[e.event_type] || 'system'; }
  function reasonText(e) { return e.note || e.output || e.decision_summary || e.summary || e.next_action || e.evidence || e.event_type; }
  function execLabel(e) { return e.command || fileName(e.files_changed && e.files_changed[0]) || fileName(e.files_read && e.files_read[0]) || e.skill || e.event_type; }
  function execGlyph(t) { return ({ file_read: '↑', file_changed: '↓', command_run: '$', skill_loaded: '⊕' })[t] || '·'; }
  function fileName(f) { return !f ? '' : (typeof f === 'string' ? f : (f.file || '')); }
  function withRole(n, key, role) { const c = F().agentColor(key, role); n.role = c.role; n.glyph = n.glyph || c.glyph; n.accent = c.solid; n.fill = c.fill; n.fillLo = c.fillLo; return n; }
  function aState(a) { return a ? F().nodeState(a) : 'waiting'; }
  function agentStateOf(agents, key) { const a = agents.find((x) => x.key === key); return aState(a); }
  function prettyAgentName(k) { return String(k || 'agent').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()); }

  /* ---------- layered left->right DAG ---------- */
  function layeredLR(nodes, edges, opts) {
    const o = Object.assign({ colGap: 250, rowGap: 104, padX: 80, padY: 56, laneByAgent: false, maxDepth: Infinity, seedRoots: [] }, opts);
    const N = new Map(nodes.map((n) => [n.id, n])); const adj = new Map(), radj = new Map(), indeg = new Map();
    nodes.forEach((n) => { adj.set(n.id, []); radj.set(n.id, []); indeg.set(n.id, 0); });
    edges.forEach((e) => { if (!N.has(e.from) || !N.has(e.to)) return; adj.get(e.from).push(e.to); radj.get(e.to).push(e.from); indeg.set(e.to, indeg.get(e.to) + 1); });
    const layer = new Map(nodes.map((n) => [n.id, 0])); const li = new Map(indeg); const q = nodes.filter((n) => li.get(n.id) === 0).map((n) => n.id); const seen = new Set();
    while (q.length) { const u = q.shift(); seen.add(u); for (const v of adj.get(u)) { layer.set(v, Math.max(layer.get(v), layer.get(u) + 1)); li.set(v, li.get(v) - 1); if (li.get(v) === 0) q.push(v); } }
    nodes.forEach((n) => { if (!seen.has(n.id)) { const p = radj.get(n.id).map((x) => layer.get(x)); layer.set(n.id, p.length ? Math.max(...p) + 1 : 0); } });
    if (o.laneByAgent) nodes.forEach((n) => { if (n.meta && n.meta.step != null) layer.set(n.id, n.meta.step); });
    if (o.maxDepth !== Infinity) nodes.forEach((n) => layer.set(n.id, Math.min(layer.get(n.id), o.maxDepth)));
    o.seedRoots.forEach((id) => { if (N.has(id)) layer.set(id, 0); });
    const maxL = Math.max(0, ...[...layer.values()]); const layers = Array.from({ length: maxL + 1 }, () => []);
    nodes.forEach((n) => layers[layer.get(n.id)].push(n.id));
    const seedKey = (id) => o.laneByAgent && N.get(id).meta ? (N.get(id).meta.lane != null ? N.get(id).meta.lane : 0) : (N.get(id).refEvIdx != null ? N.get(id).refEvIdx : (N.get(id).meta && N.get(id).meta.order != null ? N.get(id).meta.order : id));
    layers.forEach((Lr) => Lr.sort((a, b) => cmp(seedKey(a), seedKey(b))));
    const mean = (ids, pos) => { const v = ids.map((i) => pos.get(i)).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    for (let s = 0; s < 4; s++) {
      for (let l = 1; l <= maxL; l++) { const pos = idx(layers[l - 1]); layers[l].sort((a, b) => { const ma = mean(radj.get(a), pos), mb = mean(radj.get(b), pos); return (ma == null || mb == null) ? 0 : ma - mb; }); }
      for (let l = maxL - 1; l >= 0; l--) { const pos = idx(layers[l + 1]); layers[l].sort((a, b) => { const ma = mean(adj.get(a), pos), mb = mean(adj.get(b), pos); return (ma == null || mb == null) ? 0 : ma - mb; }); }
    }
    // HEIGHT-AWARE vertical packing (fix 2026-07-09: y = i*rowGap ignored each node's real height, so
    // taller nodes stacked/overlapped). Treat rowGap as the center-distance of a nominal 66px node; use
    // the excess as the inter-node GAP and lay out by cumulative actual heights so nothing ever overlaps.
    const gap = Math.max(12, (o.rowGap || 104) - 66);
    const colH = layers.map((col) => col.length ? col.reduce((s, id) => s + (N.get(id).h || 66) + gap, -gap) : 0);
    const maxColH = Math.max(o.rowGap || 104, ...colH);
    layers.forEach((col, l) => { const x = o.padX + l * o.colGap; let yy = o.padY + (maxColH - colH[l]) / 2;
      col.forEach((id) => { const n = N.get(id); n.x = x; n.y = yy; yy += (n.h || 66) + gap; }); });
    return { nodes, edges, world: { w: o.padX * 2 + (maxL + 1) * o.colGap, h: o.padY * 2 + maxColH } };
  }
  function chainLR(nodes, edges, opts) { const o = Object.assign({ colGap: 240, y: 150, padX: 80 }, opts); nodes.forEach((n, i) => { n.x = o.padX + i * o.colGap; n.y = o.y; }); return { nodes, edges, world: { w: o.padX * 2 + Math.max(1, nodes.length) * o.colGap, h: o.y * 2 + 120 } }; }
  function empty() { return { nodes: [], edges: [], world: { w: 600, h: 400 } }; }

  /* ---------- radial (root-centered rings by BFS depth) — WP4 Mind Map ---------- */
  // Root (kind 'root', else the node with no incoming edge, else nodes[0]) sits at the world center.
  // Every other node is grouped into a ring by its BFS depth from the root; a ring's nodes are spread
  // evenly by angle starting at 0 (east) — for a 1-node ring that places it directly to the right of
  // center, never stacked on the root. Different rings sit at different radii and, within a ring, no
  // two nodes share an angle, so nodes never overlap. Any node unreachable from the root (disconnected
  // outline) is placed on one extra outer ring rather than dropped, so nothing goes missing.
  function radial(nodes, edges, opts) {
    const o = Object.assign({ ringGap: 220, margin: 90 }, opts);
    if (!nodes.length) return { nodes, edges, world: { w: o.margin * 2 + 196, h: o.margin * 2 + 66 } };
    const N = new Map(nodes.map((n) => [n.id, n]));
    const adj = new Map(nodes.map((n) => [n.id, []]));
    const indeg = new Map(nodes.map((n) => [n.id, 0]));
    edges.forEach((e) => { if (!N.has(e.from) || !N.has(e.to)) return; adj.get(e.from).push(e.to); indeg.set(e.to, indeg.get(e.to) + 1); });
    const root = nodes.find((n) => n.kind === 'root') || nodes.find((n) => indeg.get(n.id) === 0) || nodes[0];
    const depth = new Map([[root.id, 0]]); const q = [root.id];
    while (q.length) { const u = q.shift(); for (const v of adj.get(u)) { if (!depth.has(v)) { depth.set(v, depth.get(u) + 1); q.push(v); } } }
    let maxDepth = 0; depth.forEach((d) => { if (d > maxDepth) maxDepth = d; });
    let hasOrphans = false;
    nodes.forEach((n) => { if (!depth.has(n.id)) { hasOrphans = true; } });
    if (hasOrphans) { maxDepth += 1; nodes.forEach((n) => { if (!depth.has(n.id)) depth.set(n.id, maxDepth); }); }
    const rings = new Map();
    nodes.forEach((n) => { const d = depth.get(n.id) || 0; if (!rings.has(d)) rings.set(d, []); rings.get(d).push(n); });
    const maxW = Math.max(196, ...nodes.map((n) => n.w || 196));
    const maxH = Math.max(66, ...nodes.map((n) => n.h || 66));
    const cx = o.margin + maxDepth * o.ringGap + maxW / 2;
    const cy = o.margin + maxDepth * o.ringGap + maxH / 2;
    (rings.get(0) || [root]).forEach((n) => { n.x = cx - n.w / 2; n.y = cy - n.h / 2; });
    for (let d = 1; d <= maxDepth; d++) {
      const ring = rings.get(d) || []; const k = ring.length; if (!k) continue;
      const r = d * o.ringGap;
      ring.forEach((n, i) => { const a = i * (2 * Math.PI / k); n.x = cx + r * Math.cos(a) - n.w / 2; n.y = cy + r * Math.sin(a) - n.h / 2; });
    }
    return { nodes, edges, world: { w: cx + maxDepth * o.ringGap + maxW / 2 + o.margin, h: cy + maxDepth * o.ringGap + maxH / 2 + o.margin } };
  }

  /* ---------- helpers ---------- */
  function phaseOf(e) { const t = e.event_type;
    if (t === 'run_started' || t === 'mission_packet_created') return 'classify';
    if (['project_scanned', 'profile_loaded', 'memory_loaded', 'memory_updated', 'decision_logged'].includes(t)) return 'scan';
    if (t === 'agent_selected' || t === 'agent_work_package_created') return 'route';
    if (t.indexOf('agent_') === 0 && /plan|architect/i.test(e.agent || '')) return 'plan';
    if (['check_started', 'check_passed', 'check_failed', 'codex_review_started', 'codex_finding', 'fix_started', 'fix_completed', 'retest_started', 'retest_completed', 'quality_gate_passed', 'quality_gate_blocked'].includes(t) || /review|codex|security/i.test(e.agent || '')) return 'review';
    if (['report_generated', 'run_completed'].includes(t)) return 'report';
    return 'execute'; }
  function rollPhase(cur, s) { if (cur === 'failed' || s === 'failed') return 'failed'; if (s === 'running') return cur === 'done' ? 'done' : 'running'; if (s === 'done' && cur === 'waiting') return 'done'; return cur === 'waiting' ? s : cur; }
  function dedupeAcyclic(edges) { const out = [], seen = new Set(); for (const e of edges) { if (seen.has(e.id) || e.from === e.to) continue; seen.add(e.id); out.push(e); } return out; }
  function dagDeps(agents, events) { const present = new Set(agents.map((a) => a.key)); const edges = [];
    const add = (f, t, k) => { if (f !== t && present.has(f) && present.has(t)) edges.push(edge('agent:' + f, 'agent:' + t, k)); };
    events.filter((e) => e.event_type === 'agent_handoff').forEach((e) => { const to = e.to || e.handoff_to || e.handoff; if (to) add(agentKeyOf(e), to, 'handoff'); });
    events.filter((e) => e.event_type === 'agent_selected' || e.event_type === 'agent_work_package_created').forEach((e) => { if (e.agent) add('orchestrator', e.agent, 'handoff'); });
    const changedBy = {}; events.forEach((e) => { (e.files_changed || []).forEach((f) => { changedBy[fileName(f)] = agentKeyOf(e); }); (e.files_read || []).forEach((f) => { const fn = fileName(f); if (changedBy[fn]) add(changedBy[fn], agentKeyOf(e), 'dep'); }); });
    return dedupeAcyclic(edges); }
  function pairChecks(events) { const open = {}; const out = [];
    events.forEach((e, i) => { const k = e.agent || '?';
      if (e.event_type === 'check_started') { const c = { startIdx: i, agent: e.agent, task: e.task || 'check', state: 'running' }; (open[k] = open[k] || []).push(c); out.push(c); }
      else if (e.event_type === 'check_passed' || e.event_type === 'check_failed') { const st = e.event_type === 'check_passed' ? 'done' : 'failed'; const q = open[k]; const c = q && q.shift(); if (c) { c.state = st; if (e.task) c.task = e.task; } else out.push({ startIdx: i, agent: e.agent, task: e.task || e.note || 'check', state: st }); } });
    return out.sort((a, b) => a.startIdx - b.startIdx); }
  function rollChecks(cs) { if (cs.some((c) => c.state === 'failed')) return 'failed'; if (cs.some((c) => c.state === 'running')) return 'running'; if (cs.length && cs.every((c) => c.state === 'done')) return 'done'; return 'waiting'; }
  function collapseToStages(events) { const stages = []; const live = {};
    events.forEach((e, i) => { const k = agentKeyOf(e); const t = e.event_type;
      if (t === 'run_started') stages.push({ id: 'run', label: 'RUN', key: k, evIdx: i, state: 'running', done: 0, total: 0 });
      else if (t === 'agent_started' || ((t === 'agent_selected' || t === 'agent_work_package_created') && !live[k])) { if (!live[k]) { const s = { id: 'a:' + k, label: k, key: k, evIdx: i, state: t === 'agent_started' ? 'running' : F().statusClass(e.status || 'waiting'), done: 0, total: 0 }; live[k] = s; stages.push(s); } }
      else if (t === 'codex_review_started') stages.push(live['c:' + i] = { id: 'c:' + i, label: 'CODEX REVIEW', key: k, evIdx: i, state: 'running', done: 0, total: 0 });
      else if (t === 'report_generated') stages.push({ id: 'report', label: 'REPORT', key: k, evIdx: i, state: 'done', done: 1, total: 1 });
      if (live[k] && EXEC_TYPES.has(t)) { live[k].total++; live[k].done++; }
      if (t === 'agent_completed' && live[k]) live[k].state = 'done';
      if (t === 'agent_failed' && live[k]) live[k].state = 'failed';
      if (t === 'agent_progress' && live[k] && F().nodeState(e) === 'waiting') live[k].state = 'waiting'; });
    if (events.some((e) => e.event_type === 'run_completed')) { const r = stages.find((s) => s.id === 'run'); if (r) { r.state = 'done'; r.done = 1; r.total = 1; } }
    return stages; }
  function hasOpenFixLoop(events) { let open = false; for (const e of events) { const t = e.event_type; if (t === 'codex_finding' || t === 'check_failed' || t === 'fix_started' || t === 'quality_gate_blocked') open = true; if (t === 'quality_gate_passed' || t === 'retest_completed') open = false; } return open; }
  function rollReview(events) { if (events.some((e) => e.event_type === 'quality_gate_passed')) return 'done'; if (events.some((e) => e.event_type === 'quality_gate_blocked')) return 'failed'; if (events.some((e) => /codex_review_started|codex_finding|fix_started|retest_started/.test(e.event_type))) return 'running'; if (events.some((e) => e.event_type === 'agent_work_package_created' && /codex/.test(e.agent || ''))) return 'previewing'; return 'waiting'; }

  /* ---------- lenses ---------- */
  const LENSES = {
    flow: { id: 'flow', label: 'FLOW (AGENT EXECUTION)', build(ctx) {
      const { agents, events, run } = ctx; if (!agents.length) return empty();
      const G = F(); const SL = G.statusLabel || ((s) => String(s).toUpperCase());
      const nodes = [], edges = [];
      const someType = (...ts) => events.some((e) => ts.includes(e.event_type));
      // classify (preflight/context kept OUT of the main subagent row)
      const preAgents = agents.filter((a) => G.isPreflight(a));
      const lead = agents.find((a) => G.isLeadNode(a));
      const codexA = agents.find((a) => G.isCodexNode(a));
      const reportA = agents.find((a) => G.isReportNode(a));
      const subs = agents.filter((a) => G.isSubagentNode(a)).sort((x, y) => (GORDER.indexOf(x.group) - GORDER.indexOf(y.group)) || cmp(x.key, y.key));
      const W = { preflight: 152, mission: 192, lead: 214, plan: 234, sub: 200, out: 188, collector: 200, review: 214, rework: 198, fix: 174, qa: 174, merge: 208, codex: 204, final: 204 };
      const H = { preflight: 54, mission: 76, lead: 92, plan: 78, sub: 90, out: 58, collector: 74, review: 82, rework: 72, fix: 66, qa: 66, merge: 84, codex: 84, final: 84 };
      const padX = 76, padY = 44, vGap = 56, hGap = 40;

      function agentNode(a, kind, title, w, h) { const c = G.agentColor(a.key, a.role); const st = aState(a); const bd = G.runtimeBadge(a);
        // Node = AGENT (name) → its tasks listed beneath, with a spinning-gear + done/total counter (no green bar).
        // Honest: an agent that logged NO activity says so explicitly instead of faking progress.
        const tasks = a.tasks || [];
        const doneT = tasks.filter((t) => t.status === 'done').length;
        // TITLE is always the agent's own NAME for subagent nodes — never a task string (owner: "agent > task1 > task2").
        const nm = kind === 'agent' ? prettyAgentName(a.key) : (title || a.title || a.key);
        let sub = a.role || c.label;
        if (kind === 'agent') {
          if (!tasks.length && st === 'running') sub = '⚠ running — no activity logged yet';
          else if (tasks.length) sub = (a._claimMismatch ? '⚠ claims done · ' : '') + doneT + '/' + tasks.length + ' tasks' + (a.runtime ? ' · ' + a.runtime : '');
        }
        const tasklist = kind === 'agent' ? tasks.map((t) => ({ title: t.title, status: t.status })) : null;
        // grow the node so the task rows fit (agents with more tasks are taller — honest, not fixed)
        const rows = Math.min(4, tasks.length) + (tasks.length > 4 ? 1 : 0);
        const hh = kind === 'agent' ? h + rows * 15 : h;
        const n = node('agent:' + a.key, nm, kind, 'flow', st, { refKey: a.key, w, h: hh, derived: a.derived, custom: a.custom, sub, badge: bd.text, total: kind === 'agent' ? tasks.length : 0, done: doneT, tasklist, catLabel: kind === 'agent' ? G.categoryLabel(a.role, a.key, a.custom) : '' });
        n.role = c.role; n.glyph = c.glyph; n.accent = c.solid; n.fill = c.fill; n.fillLo = c.fillLo; nodes.push(n); return n; }
      function ms(id, title, kind, state, glyph, accent, sub, w, h, extra) { const n = node(id, title, kind, 'flow', state, Object.assign({ catLabel: kind.replace(/[-_]/g, ' ').toUpperCase(), sub, w, h }, extra || {})); n.glyph = glyph; n.accent = accent; nodes.push(n); return n; }

      // --- Preflight / Context band (separated; no main-flow edges) ---
      const preNodes = preAgents.map((a) => { const st = aState(a); const setup = a.group === 'context' ? 'CONTEXT' : 'SETUP';
        return ms('pre:' + a.key, a.key, 'preflight', st === 'failed' ? 'failed' : 'internal', '◦', 'var(--st-int)', st === 'done' ? 'setup done' : (a.role || 'context'), W.preflight, H.preflight, { refKey: a.key, badge: setup, derived: a.derived }); });

      // --- Row 1: User Mission -> Lead Agent ---
      const missionN = ms('flow:mission', 'USER MISSION', 'mission', 'done', '✉', 'var(--cyan)', (run && run.request) ? G.trunc(run.request, 46) : 'forge run', W.mission, H.mission, { refKey: lead ? lead.key : undefined });
      const leadN = lead ? agentNode(lead, 'lead', 'LEAD AGENT', W.lead, H.lead) : ms('flow:lead', 'LEAD AGENT', 'lead', 'waiting', '♛', 'var(--green)', 'orchestrator', W.lead, H.lead);
      if (lead) leadN.sub = lead.key;

      // --- Row 2: Master Plan / Mission Blueprint ---
      const planReal = !!(lead && lead.blueprint);
      const planState = planReal || subs.some((s) => aState(s) !== 'waiting') ? 'done' : (lead ? aState(lead) : 'waiting');
      const planN = ms('flow:plan', 'MASTER PLAN', 'masterplan', planState, '▤', 'var(--st-prev)', planReal ? 'mission blueprint' : 'plan (derived)', W.plan, H.plan, { refKey: planReal && lead ? lead.key : undefined, derived: !planReal });

      // --- Row 3: Subagent execution layer ---
      const subNodes = subs.map((a) => agentNode(a, 'agent', null, W.sub, H.sub));

      // --- Row 4: Output / artifact layer (one per sub that produced something) ---
      const outBySub = new Map();
      subs.forEach((a) => { const art = a.artifacts[0]; const file = [...a.filesChanged][0]; const label = (art && (art.artifact || art.path)) || file; if (!label) return;
        const st = aState(a); const out = ms('out:' + a.key, G.trunc(label, 26), 'output', st === 'failed' ? 'failed' : st === 'done' ? 'done' : st === 'running' ? 'running' : 'previewing', '▭', G.agentColor(a.key, a.role).solid, art ? (art.kind || 'artifact') : 'file', W.out, H.out, { refKey: a.key, badge: 'ARTIFACT' });
        outBySub.set(a.key, out); });
      const outNodes = subs.map((a) => outBySub.get(a.key)).filter(Boolean);

      // --- Row 5: Lead Review + Rework tasks ---
      const reviewDone = someType('lead_review_completed'), reviewStarted = someType('lead_review_started');
      const allSubsDone = subs.length > 0 && subs.every((s) => ['done', 'internal'].includes(aState(s)));
      const reviewState = reviewDone ? 'done' : reviewStarted ? 'running' : (allSubsDone ? 'done' : 'waiting');
      const reviewN = (subs.length || reviewStarted || reviewDone) ? ms('flow:review', 'LEAD REVIEW', 'leadreview', reviewState, '◈', 'var(--cyan)', reviewDone || reviewStarted ? 'review · rework' : 'review · rework (derived)', W.review, H.review, { refKey: lead ? lead.key : undefined, derived: !(reviewDone || reviewStarted) }) : null;
      const reworkNodes = events.map((e, i) => ({ e, i })).filter((x) => x.e.event_type === 'rework_task_created').map(({ e, i }) => {
        const sev = (e.severity || '').toLowerCase(); const tgt = e.target || e.to || e.agent;
        const fixed = events.some((x) => x.event_type === 'rework_completed' && (x.agent === tgt || x.target === tgt));
        const st = fixed ? 'done' : (/crit|high/.test(sev) ? 'failed' : 'previewing');
        return ms('rework:' + i, G.trunc(e.issue || e.note || 'rework', 24), 'rework', st, '⟲', 'var(--st-run)', (e.severity || 'rework') + (tgt ? ' → ' + tgt : ''), W.rework, H.rework, { refEvIdx: i, refKey: tgt, badge: 'REWORK' }); });

      // --- Row 6: Fix loop + Retest (only if real events) ---
      const hasFix = someType('fix_started', 'fix_completed', 'rework_started', 'rework_completed');
      const fixN = hasFix ? ms('flow:fix', 'FIX LOOP', 'fixloop', someType('fix_completed', 'rework_completed') ? 'done' : 'running', '⚒', 'var(--st-run)', 'fix · improve', W.fix, H.fix) : null;
      const hasRetest = someType('retest_started', 'retest_completed', 'check_started', 'check_passed', 'check_failed');
      const retestFail = events.some((e) => e.event_type === 'check_failed');
      const retestDone = someType('retest_completed') || (someType('check_passed') && !retestFail);
      const retestN = hasRetest ? ms('flow:retest', 'QA / RETEST', 'qa', retestFail ? 'failed' : retestDone ? 'done' : 'running', '◉', 'var(--cyan)', 'retest', W.qa, H.qa) : null;

      // --- Row 7: Merge -> Codex -> Final ---
      const mergeReal = someType('merge_started', 'merge_completed');
      const mState = subs.some((s) => aState(s) === 'failed') ? 'failed' : (someType('merge_started') && !someType('merge_completed')) ? 'running' : ((someType('merge_completed') || allSubsDone) ? 'done' : 'waiting');
      const mergeN = ms('flow:merge', 'MERGE & SYNTHESIS', 'merge', mState, '⊕', 'var(--green)', 'collect · resolve · synthesize', W.merge, H.merge, { refKey: lead ? lead.key : undefined, derived: !mergeReal });
      const cstat = G.codexStatus ? G.codexStatus() : { state: 'previewing', label: 'CODEX —' };
      const codexState = cstat.state;
      const codexSub = (cstat.label || 'CODEX').replace(/^CODEX[: ]*/, '') || 'review';
      const codexBadge = codexState === 'done' ? 'CODEX ✓' : codexState === 'failed' ? 'CODEX ✕' : codexState === 'internal' ? 'CODEX —' : 'CODEX';
      const codexN = codexA ? agentNode(codexA, 'codex', 'CODEX REVIEW', W.codex, H.codex) : ms('flow:codex', 'CODEX REVIEW', 'codex', codexState, '⧉', 'var(--blue)', codexSub, W.codex, H.codex, { badge: codexBadge });
      if (codexA) { codexN.sub = codexSub; codexN.badge = codexBadge; }
      const finalReal = someType('final_output_created', 'report_generated'); // run_completed alone is run-level state, not proof of a final output (Codex finding)
      const finState = reportA ? aState(reportA) : (finalReal ? 'done' : 'waiting');
      const finalN = reportA ? agentNode(reportA, 'report', 'FINAL OUTPUT', W.final, H.final) : ms('flow:final', 'FINAL OUTPUT', 'report', finState, '✓', 'var(--amber)', 'report + artifacts', W.final, H.final, { derived: !finalReal });
      if (reportA) finalN.sub = 'report + artifacts';

      // Artifact Collector — bundles many output edges into one before Lead Review (large swarms, ≥4 subagents) to avoid spaghetti
      const bigSwarm = subs.length >= 4;
      const collectorN = (bigSwarm && reviewN) ? ms('flow:collector', 'ARTIFACT COLLECTOR', 'collector', outNodes.length ? 'done' : (subs.some((s) => aState(s) === 'running') ? 'running' : 'waiting'), '⊞', 'var(--cyan)', outNodes.length ? (outNodes.length + ' artifacts → review') : (subs.length + ' agents → review'), W.collector, H.collector) : null;

      // On a COMPLETED run, a milestone that never ran must not look "open" (orange/blue/cyan) — that reads as an
      // unfinished gap. Resolve any still-waiting/previewing milestone to a deliberate grey "skipped" state.
      if (someType('run_completed')) [collectorN, reviewN, fixN, retestN, mergeN, codexN, finalN].forEach((n) => {
        if (n && (n.state === 'waiting' || n.state === 'previewing')) { n.state = 'internal'; n.skipped = true; n.sub = (n.sub ? n.sub + ' · ' : '') + 'skipped'; }
      });

      // --- edges ---
      edges.push(edge(missionN.id, leadN.id, 'critical'));
      edges.push(edge(leadN.id, planN.id, 'critical'));
      subs.forEach((a, i) => { const st = aState(a); edges.push(edge(planN.id, subNodes[i].id, st === 'running' ? 'flow-active' : st === 'failed' ? 'flow-fail' : 'handoff')); });
      subs.forEach((a) => { const out = outBySub.get(a.key); const st = aState(a); const sink = collectorN ? collectorN.id : (reviewN ? reviewN.id : null);
        if (out) { edges.push(edge('agent:' + a.key, out.id, st === 'done' ? 'critical' : st === 'failed' ? 'flow-fail' : 'handoff')); if (sink) edges.push(edge(out.id, sink, collectorN ? 'artifact' : (st === 'done' ? 'critical' : 'handoff'))); }
        else if (sink) edges.push(edge('agent:' + a.key, sink, collectorN ? 'artifact' : (st === 'done' ? 'critical' : st === 'failed' ? 'flow-fail' : 'handoff'))); });
      if (collectorN && reviewN) edges.push(edge(collectorN.id, reviewN.id, 'critical'));
      reworkNodes.forEach((rn) => { const src = reviewN ? reviewN.id : planN.id; edges.push(edge(src, rn.id, rn.state === 'done' ? 'handoff' : 'flow-fail')); if (rn.refKey && nodes.some((x) => x.id === 'agent:' + rn.refKey)) edges.push(edge(rn.id, 'agent:' + rn.refKey, 'loop')); });
      let preMerge = reviewN ? reviewN.id : planN.id;
      if (fixN) { edges.push(edge(preMerge, fixN.id, 'critical')); preMerge = fixN.id; }
      if (retestN) { edges.push(edge(preMerge, retestN.id, retestN.state === 'failed' ? 'flow-fail' : 'critical')); preMerge = retestN.id; }
      edges.push(edge(preMerge, mergeN.id, 'critical'));
      edges.push(edge(mergeN.id, codexN.id, 'critical'));
      if (hasOpenFixLoop(events) && (fixN || retestN)) edges.push(edge(codexN.id, fixN ? fixN.id : retestN.id, 'loop')); // only when a real fix/retest node exists — no spurious merge↔codex cycle
      edges.push(edge(codexN.id, finalN.id, finState === 'done' ? 'critical' : 'handoff'));

      // --- layout: separated preflight band (top), then LEFT -> RIGHT stage columns ---
      const colGapX = 64, vGap2 = 28;
      const row5 = [reviewN].concat(reworkNodes).filter(Boolean);
      const row6 = [fixN, retestN].filter(Boolean);
      const stackH = (arr) => arr.reduce((s, n) => s + n.h, 0) + vGap2 * Math.max(0, arr.length - 1);
      const colDefs = [[missionN], [leadN], [planN], subNodes, outNodes, collectorN ? [collectorN] : null, row5, row6, [mergeN], [codexN], [finalN]].filter((c) => c && c.length);
      const maxStack = Math.max(H.sub, ...colDefs.map(stackH));
      const topY = preNodes.length ? (padY + H.preflight + Math.round(vGap * 1.6)) : padY;
      const cy = topY + maxStack / 2; // vertical center of the flow (tallest column)
      let x = padX;
      const placeCol = (arr) => { const colW = Math.max(...arr.map((n) => n.w)); let yy = cy - stackH(arr) / 2; for (const n of arr) { n.x = x + (colW - n.w) / 2; n.y = yy; yy += n.h + vGap2; } x += colW + colGapX; return colW; };
      placeCol([missionN]); placeCol([leadN]); placeCol([planN]);
      if (subNodes.length) placeCol(subNodes);
      // outputs column — each output sits to the RIGHT of (and level with) its subagent
      if (outNodes.length) { const colW = Math.max(...outNodes.map((n) => n.w)); subs.forEach((a) => { const out = outBySub.get(a.key), sn = nodes.find((z) => z.id === 'agent:' + a.key); if (out && sn) { out.x = x + (colW - out.w) / 2; out.y = sn.y + (sn.h - out.h) / 2; } }); x += colW + colGapX; }
      if (collectorN) placeCol([collectorN]);
      if (row5.length) placeCol(row5);
      if (row6.length) placeCol(row6);
      placeCol([mergeN]); placeCol([codexN]); placeCol([finalN]);
      const worldW = x + padX;
      // preflight / context band — horizontal strip across the top, clearly above the main flow
      if (preNodes.length) { const tot = preNodes.reduce((s, n) => s + n.w, 0) + hGap * Math.max(0, preNodes.length - 1); let px = Math.max(padX, (worldW - tot) / 2); for (const n of preNodes) { n.x = px; n.y = padY; px += n.w + hGap; } }
      return { nodes, edges, world: { w: worldW, h: topY + maxStack + padY + 12 } };
    } },

    // ALL (2026-07-10 Mission Control layout rework — owner sketch): USER REQUEST → LEAD AGENT → HEAD CHEF
    // (task planner — only when a real agent matches it) → a vertical fan-out of Boss lanes (every real
    // subagent from ctx.agents, same set the flow lens considers subagents — GORDER/key sorted), each
    // followed by its OWN horizontal chain of real task nodes → every lane converges into REVIEW → CODEX →
    // FIX LOOP → FINAL OUTPUT, reusing the flow lens's own review/codex/fix/retest/final milestone logic
    // (copied in, flow.js itself is untouched) so the convergence stages carry the same honest
    // real/derived/skipped states. The system summary nodes (GATES/DOCTOR/PRD/MIND MAP/VAULT/TICKETS/COST)
    // live in a separate top strip, spread out and wired to NOTHING — the owner's red-box callout that
    // these are "onnodige dingen die niks met het werk te maken hebben" and must sit apart from the work
    // pipeline. Real data only: nothing renders without a genuine data source backing it. Kept as lens id
    // 'note' so existing ?lens=note URLs keep working; visible label is 'ALL'.
    note: { id: 'note', label: 'ALL', build(ctx) {
      const { agents, events, run } = ctx;
      const prds = ctx.prds || [], tickets = ctx.tickets || [], artifacts = ctx.artifacts || [], mindmaps = ctx.mindmaps || [];
      const doctor = ctx.doctor || null;
      const hasStoreData = !!(prds.length || tickets.length || artifacts.length || mindmaps.length || doctor);
      if (!agents.length && !events.length && !hasStoreData) return { nodes: [], edges: [], world: { w: 960, h: 600 } };
      const G = F(); const nodes = [], edges = [];
      const someType = (...ts) => events.some((e) => ts.includes(e.event_type));
      // spacing (owner 2026-07-10: "meer ruimte er tussen") — generous gaps everywhere; the clearance
      // test in forge-all-lens.test.cjs enforces a minimum breathing room between EVERY pair of nodes.
      const padX = 76, padY = 56, colGapX = 110, rowGapY = 56;

      // --- TOP STRIP: system summary nodes — one per data source, ONLY when real data exists (never a
      // placeholder). Spread out, clearly separated, and wired to NOTHING — never part of the work pipeline.
      const summaryNodes = [];
      const addSummary = (id, label, state, sub, glyph, accent) => { const n = node(id, label, 'stage', 'note', state, { sub, w: 200, h: 66, catLabel: 'SYSTEM' }); n.glyph = glyph; n.accent = accent; nodes.push(n); summaryNodes.push(n); };
      if (typeof gateVerdicts === 'function' && typeof gatesOverall === 'function' && events.length) {
        const g = gateVerdicts(); const overall = gatesOverall(g);
        const states = Object.keys(g).map((k) => g[k].state); const passN = states.filter((s) => s === 'pass').length;
        addSummary('sum:gates', 'GATES', overall.ok ? 'done' : (states.includes('fail') ? 'failed' : 'waiting'), passN + '/' + states.length + ' pass', '⛒', 'var(--cyan)');
      }
      if (doctor) addSummary('sum:doctor', 'DOCTOR', doctor.ok ? 'done' : 'failed', doctor.ok ? 'ALL GREEN' : 'FAILURES', '✚', doctor.ok ? 'var(--green)' : 'var(--st-fail)');
      if (prds.length) { const totalAC = prds.reduce((s, p) => s + (Number(p && p.acceptance_count) || 0), 0); addSummary('sum:prd', 'PRD', 'done', prds.length + ' PRD(s) · ' + totalAC + ' AC', '▤', 'var(--amber)'); }
      if (mindmaps.length) addSummary('sum:mindmap', 'MIND MAP', 'done', mindmaps.length + ' map(s)', '◎', 'var(--blue)');
      if (artifacts.length) addSummary('sum:vault', 'VAULT', 'done', artifacts.length + ' artifact(s)', '▭', 'var(--cyan)');
      if (tickets.length) { const openN = tickets.filter((tk) => String((tk && tk.status) || '').toLowerCase() !== 'done').length; addSummary('sum:tickets', 'TICKETS', openN ? 'running' : 'done', openN + '/' + tickets.length + ' open', '☐', 'var(--st-run)'); }
      if (typeof costStats === 'function') { const s = costStats(); if (s && s.any) addSummary('sum:cost', 'COST', 'done', (s.totalTokens || 0) + ' tok', '$', 'var(--amber)'); }
      const stripY = 40, stripColGap = 330; // node w=200 -> 130px clear air between strip cards
      summaryNodes.forEach((n, i) => { n.x = padX + i * stripColGap; n.y = stripY; }); // one row, spread wide, no edges
      const stripBottom = summaryNodes.length ? stripY + 66 : 0;
      const stripWorldW = summaryNodes.length ? (padX + (summaryNodes.length - 1) * stripColGap + 200 + padX) : 0;

      if (!agents.length) { // system data only, no run yet — honest strip-only view; no pipeline to draw
        return { nodes, edges: [], world: { w: Math.max(960, stripWorldW), h: stripY + 66 + padY } };
      }

      // --- MAIN PIPELINE (below the strip) ---
      const pipelineTopY = summaryNodes.length ? (stripBottom + 150) : padY; // clear band between strip and work
      const lead = agents.find((a) => G.isLeadNode(a));
      const codexA = agents.find((a) => G.isCodexNode(a));
      const reportA = agents.find((a) => G.isReportNode(a));
      let subs = agents.filter((a) => G.isSubagentNode(a));
      const isHeadChef = (a) => /head.?chef|task.?planner/i.test(String(a.key || '') + ' ' + String(a.role || ''));
      const isReviewAgent = (a) => /review[-_. ]?boss|\breviewer\b/i.test(String(a.key || '') + ' ' + String(a.role || ''));
      const headChefA = subs.find(isHeadChef); if (headChefA) subs = subs.filter((a) => a !== headChefA);
      const reviewBossA = subs.find(isReviewAgent); if (reviewBossA) subs = subs.filter((a) => a !== reviewBossA);
      subs = subs.sort((x, y) => (GORDER.indexOf(x.group) - GORDER.indexOf(y.group)) || cmp(x.key, y.key));

      const W = { mission: 192, lead: 214, headchef: 200, sub: 200, task: 190, review: 214, codex: 204, fix: 174, final: 204 };
      const H = { mission: 76, lead: 92, headchef: 90, sub: 90, task: 46, review: 82, codex: 84, fix: 66, final: 84 };

      // real-agent node — SAME shape as the agent nodes everywhere else in this lens (gear counter +
      // '⚠ claims done · ' mismatch prefix) whether it lands on LEAD/HEAD CHEF/a Boss lane/REVIEW/CODEX/
      // FINAL — only the CSS "kind" (and, for the milestone stages, the fixed conceptual title) differ.
      function agentNode(a, kind, title, w, h) { const c = G.agentColor(a.key, a.role); const st = aState(a);
        const tasks = a.tasks || []; const doneT = tasks.filter((t) => t.status === 'done').length;
        const nm = kind === 'agent' ? prettyAgentName(a.key) : (title || prettyAgentName(a.key));
        let sub;
        if (!tasks.length && st === 'running') sub = '⚠ running — no activity logged yet';
        else if (tasks.length) sub = (a.role || c.label) + ' · ' + (a._claimMismatch ? '⚠ claims done · ' : '') + doneT + '/' + tasks.length + ' tasks';
        else sub = a.role || c.label;
        const n = node('agent:' + a.key, nm, kind, 'note', st, { refKey: a.key, w, h, derived: a.derived, sub, total: tasks.length, done: doneT });
        n.role = c.role; n.glyph = c.glyph; n.accent = c.solid; n.fill = c.fill; n.fillLo = c.fillLo; nodes.push(n); return n; }
      function ms(id, title, kind, state, glyph, accent, sub, w, h, extra) { const n = node(id, title, kind, 'note', state, Object.assign({ catLabel: kind.replace(/[-_]/g, ' ').toUpperCase(), sub, w, h }, extra || {})); n.glyph = glyph; n.accent = accent; nodes.push(n); return n; }

      // Column 0: USER REQUEST — real data only (ctx.run.request)
      const userReqN = (run && run.request) ? ms('note:mission', 'USER REQUEST', 'mission', 'done', '✉', 'var(--cyan)', G.trunc(run.request, 44), W.mission, H.mission) : null;
      // Column 1: LEAD AGENT
      const leadN = lead ? agentNode(lead, 'lead', 'LEAD AGENT', W.lead, H.lead) : ms('note:lead', 'LEAD AGENT', 'lead', 'waiting', '♛', 'var(--green)', 'orchestrator', W.lead, H.lead);
      // Column 2: HEAD CHEF — ONLY when a real agent matches (task planner); otherwise skipped entirely, no fake node
      const headChefN = headChefA ? agentNode(headChefA, 'agent', null, W.headchef, H.headchef) : null;

      // Boss lanes: every remaining real subagent, each followed by its own real task chain
      const laneRows = subs.map((a) => {
        const bossNode = agentNode(a, 'agent', null, W.sub, H.sub);
        const srcTasks = a.tasks || [];
        const taskNodes = srcTasks.map((t) => { const tn = node('task:' + t.evIdx, G.trunc(t.title, 26), 'task', 'note', t.status,
          { refEvIdx: t.evIdx, refKey: a.key, sub: (G.hhmmss ? G.hhmmss(t.ts) : ''), w: W.task, h: H.task, catLabel: 'TASK' });
          tn.accent = bossNode.accent; nodes.push(tn); return tn; });
        for (let i = 0; i < taskNodes.length; i++) { const t = srcTasks[i]; edges.push(edge(i === 0 ? bossNode.id : taskNodes[i - 1].id, taskNodes[i].id, t.status === 'done' ? 'critical' : t.status === 'failed' ? 'flow-fail' : 'handoff')); }
        return { a, bossNode, taskNodes, sinkId: taskNodes.length ? taskNodes[taskNodes.length - 1].id : bossNode.id };
      });

      // REVIEW — a real Review-Boss/reviewer agent if present, else the flow-lens-style review milestone
      let reviewN;
      if (reviewBossA) reviewN = agentNode(reviewBossA, 'leadreview', 'REVIEW BOSS', W.review, H.review);
      else {
        const reviewDone = someType('lead_review_completed'), reviewStarted = someType('lead_review_started');
        const allLanesDone = laneRows.length > 0 && laneRows.every((lr) => ['done', 'internal'].includes(aState(lr.a)));
        const reviewState = reviewDone ? 'done' : reviewStarted ? 'running' : (allLanesDone ? 'done' : 'waiting');
        reviewN = (laneRows.length || reviewStarted || reviewDone) ? ms('note:review', 'REVIEW BOSS', 'leadreview', reviewState, '◈', 'var(--cyan)', (reviewDone || reviewStarted) ? 'final QA · review' : 'final QA · review (derived)', W.review, H.review, { derived: !(reviewDone || reviewStarted) }) : null;
      }

      // CODEX — the flow lens's own codex milestone logic (real codex_* events; grey/'skip' when not invoked)
      const cstat = G.codexStatus ? G.codexStatus() : { state: 'previewing', label: 'CODEX —' };
      const codexState = cstat.state;
      const codexSub = (cstat.label || 'CODEX').replace(/^CODEX[: ]*/, '') || 'review';
      const codexBadge = codexState === 'done' ? 'CODEX ✓' : codexState === 'failed' ? 'CODEX ✕' : codexState === 'internal' ? 'CODEX —' : 'CODEX';
      const codexN = codexA ? agentNode(codexA, 'codex', 'CODEX REVIEW', W.codex, H.codex) : ms('note:codex', 'CODEX REVIEW', 'codex', codexState, '⧉', 'var(--blue)', codexSub, W.codex, H.codex, { badge: codexBadge });
      if (codexA) { codexN.sub = codexSub; codexN.badge = codexBadge; }

      // FIX LOOP — flow's fix + retest milestone logic combined into one convergence node; only exists
      // when there is a real fix/rework/retest/check signal (data-gated, never fabricated).
      const hasFix = someType('fix_started', 'fix_completed', 'rework_started', 'rework_completed');
      const hasRetest = someType('retest_started', 'retest_completed', 'check_started', 'check_passed', 'check_failed');
      const retestFail = events.some((e) => e.event_type === 'check_failed');
      const fixDone = someType('fix_completed', 'rework_completed');
      const retestDone = someType('retest_completed') || (someType('check_passed') && !retestFail);
      const hasFixLoop = hasFix || hasRetest;
      const fixLoopDone = (!hasFix || fixDone) && (!hasRetest || retestDone);
      const fixLoopState = retestFail ? 'failed' : (hasFixLoop && fixLoopDone ? 'done' : (hasFixLoop ? 'running' : 'waiting'));
      const fixLoopSub = [hasFix ? 'fix' : null, hasRetest ? 'retest' : null].filter(Boolean).join(' · ') || 'rework & retest';
      const fixLoopN = hasFixLoop ? ms('note:fix', 'FIX LOOP', 'fixloop', fixLoopState, '⚒', 'var(--st-run)', fixLoopSub, W.fix, H.fix) : null;

      // FINAL OUTPUT — flow's final milestone logic (honest derived/skipped states)
      const finalReal = someType('final_output_created', 'report_generated');
      const finState = reportA ? aState(reportA) : (finalReal ? 'done' : 'waiting');
      const finalN = reportA ? agentNode(reportA, 'report', 'FINAL OUTPUT', W.final, H.final) : ms('note:final', 'FINAL OUTPUT', 'report', finState, '✓', 'var(--amber)', 'report + artifacts', W.final, H.final, { derived: !finalReal });
      if (reportA) finalN.sub = 'report + artifacts';

      // on a COMPLETED run, a convergence milestone that never ran must not look "open" — grey it out
      // honestly instead (same fix as the flow lens).
      if (someType('run_completed')) [reviewN, fixLoopN, codexN, finalN].forEach((n) => {
        if (n && (n.state === 'waiting' || n.state === 'previewing')) { n.state = 'internal'; n.skipped = true; n.sub = (n.sub ? n.sub + ' · ' : '') + 'skipped'; }
      });

      // --- layout: height-aware lane stacking (Y) first, then left->right columns (X) — never overlaps ---
      let laneY = pipelineTopY;
      laneRows.forEach((lr) => { const rowH = Math.max(lr.bossNode.h, lr.taskNodes.length ? Math.max(...lr.taskNodes.map((t) => t.h)) : 0);
        lr.rowY = laneY; lr.rowH = rowH; laneY += rowH + rowGapY; });
      const lanesBottom = laneRows.length ? laneY - rowGapY : pipelineTopY + H.sub;
      const lanesCenterY = (pipelineTopY + lanesBottom) / 2;
      laneRows.forEach((lr) => { lr.bossNode.y = lr.rowY + (lr.rowH - lr.bossNode.h) / 2; lr.taskNodes.forEach((tn) => { tn.y = lr.rowY + (lr.rowH - tn.h) / 2; }); });

      let x = padX;
      if (userReqN) { userReqN.x = x; userReqN.y = lanesCenterY - userReqN.h / 2; x += userReqN.w + colGapX; }
      leadN.x = x; leadN.y = lanesCenterY - leadN.h / 2; x += leadN.w + colGapX;
      if (headChefN) { headChefN.x = x; headChefN.y = lanesCenterY - headChefN.h / 2; x += headChefN.w + colGapX; }
      const bossX0 = x;
      laneRows.forEach((lr) => { lr.bossNode.x = bossX0; let tx = bossX0 + lr.bossNode.w + colGapX;
        lr.taskNodes.forEach((tn) => { tn.x = tx; tx += tn.w + colGapX; }); });
      const laneRightEdges = laneRows.map((lr) => { const last = lr.taskNodes.length ? lr.taskNodes[lr.taskNodes.length - 1] : lr.bossNode; return last.x + last.w; });
      let cx = laneRightEdges.length ? Math.max(...laneRightEdges) + colGapX : bossX0;
      const placeConverge = (n) => { if (!n) return; n.x = cx; n.y = lanesCenterY - n.h / 2; cx += n.w + colGapX; };
      placeConverge(reviewN); placeConverge(codexN); placeConverge(fixLoopN); placeConverge(finalN);

      // --- edges: USER REQUEST -> LEAD -> HEAD CHEF (if any) -> each Boss -> its task chain -> REVIEW ->
      // CODEX -> FIX LOOP (if any) -> FINAL OUTPUT, plus the dashed FIX LOOP -> LEAD feedback loop ---
      if (userReqN) edges.push(edge(userReqN.id, leadN.id, 'critical'));
      if (headChefN) edges.push(edge(leadN.id, headChefN.id, 'critical'));
      const bossSource = headChefN ? headChefN.id : leadN.id;
      laneRows.forEach((lr) => { const st = aState(lr.a); edges.push(edge(bossSource, lr.bossNode.id, st === 'running' ? 'flow-active' : st === 'failed' ? 'flow-fail' : 'handoff')); });
      if (reviewN) laneRows.forEach((lr) => { const st = aState(lr.a); edges.push(edge(lr.sinkId, reviewN.id, st === 'failed' ? 'flow-fail' : 'critical')); });
      const preCodex = reviewN ? reviewN.id : bossSource;
      edges.push(edge(preCodex, codexN.id, 'critical'));
      let preFinal = codexN.id;
      if (fixLoopN) { edges.push(edge(codexN.id, fixLoopN.id, fixLoopState === 'failed' ? 'flow-fail' : 'critical')); preFinal = fixLoopN.id; }
      edges.push(edge(preFinal, finalN.id, finState === 'done' ? 'critical' : 'handoff'));
      if (fixLoopN) edges.push(edge(fixLoopN.id, leadN.id, 'loop')); // dashed feedback loop, matches the sketch

      const worldW = Math.max(cx + padX, stripWorldW, 960);
      const worldH = Math.max(lanesBottom + padY, stripBottom + padY + 60);
      return { nodes, edges, world: { w: worldW, h: worldH } };
    } },
    workflow: { id: 'workflow', label: 'WORKFLOW', build(ctx) {
      const { events } = ctx; const nodes = PHASES.map((p) => node('phase:' + p, p.toUpperCase(), 'phase', 'workflow', 'waiting', { phase: p, total: 0, done: 0, w: 208, h: 84, glyph: PHASE_GLYPH[p], catLabel: 'PHASE' }));
      const by = new Map(nodes.map((n) => [n.id, n]));
      events.forEach((e) => { const n = by.get('phase:' + phaseOf(e)); if (!n) return; n.meta.total++; const s = F().nodeState(e); if (s === 'done') n.meta.done++; n.state = rollPhase(n.state, s); });
      nodes.forEach((n) => { n.sub = n.meta.done + '/' + n.meta.total + ' events'; n.accent = 'var(--cyan)'; });
      const edges = []; for (let i = 0; i < PHASES.length - 1; i++) edges.push(edge('phase:' + PHASES[i], 'phase:' + PHASES[i + 1], 'critical'));
      const m = layeredLR(nodes, edges, { colGap: 224 });
      if (events.some((e) => e.event_type === 'check_failed' || e.event_type === 'quality_gate_blocked')) m.edges.push(edge('phase:review', 'phase:execute', 'loop'));
      return m;
    } },
    execution: { id: 'execution', label: 'EXEC', build(ctx) {
      const { events, agents } = ctx; const nodes = [], edges = [], seen = {};
      events.forEach((e, i) => { if (!EXEC_TYPES.has(e.event_type)) return; const k = agentKeyOf(e);
        if (!seen[k]) { seen[k] = true; const a = node('agent:' + k, k, 'agent', 'execution', agentStateOf(agents, k), { refKey: k, w: 204 }); withRole(a, k, e.role); nodes.push(a); }
        const n = node('exec:' + i, F().trunc(execLabel(e), 36), 'exec', 'execution', F().nodeState(e), { refEvIdx: i, refKey: k, glyph: execGlyph(e.event_type), sub: F().trunc(execLabel(e), 44), w: 240, h: 48, catLabel: 'EXEC' });
        n.accent = F().agentColor(k, e.role).solid; nodes.push(n); edges.push(edge('agent:' + k, n.id, 'handoff')); });
      return nodes.length ? layeredLR(nodes, edges, { maxDepth: 1, colGap: 300, rowGap: 72 }) : empty();
    } },
    dag: { id: 'dag', label: 'DAG', build(ctx) {
      const { events, agents } = ctx; if (!agents.length) return empty();
      const nodes = agents.map((a) => { const n = node('agent:' + a.key, a.title || a.key, 'dag', 'dag', F().nodeState(a), { refKey: a.key, w: 192, h: 74, derived: a.derived }); withRole(n, a.key, a.role); return n; });
      const edges = dagDeps(agents, events); const m = layeredLR(nodes, edges, { colGap: 232 });
      m.nodes.forEach((n) => { n.sub = 'echelon L' + Math.max(0, Math.round((n.x - 80) / 232)); }); return m;
    } },
    agents: { id: 'agents', label: 'AGENTS', build(ctx) {
      const { events, agents } = ctx; if (!agents.length) return empty();
      const nodes = agents.map((a) => { const c = F().agentColor(a.key, a.role); const done = a.tasks.filter((t) => t.status === 'done').length;
        const n = node('agent:' + a.key, a.title || a.key, 'agent', 'agents', F().nodeState(a), { refKey: a.key, band: c.band, total: a.tasks.length, done, sub: c.band + ' · ' + done + '/' + a.tasks.length + ' done', w: 224, h: 92, derived: a.derived, badge: a.tasks.length ? '↦+' + a.tasks.length : '' });
        n.role = c.role; n.glyph = c.glyph; n.accent = c.solid; n.fill = c.fill; n.fillLo = c.fillLo; return n; });
      const edges = dagDeps(agents, events).filter((e) => e.kind === 'handoff');
      const roots = nodes.filter((n) => n.meta.band === 'control').map((n) => n.id);
      return layeredLR(nodes, edges, { seedRoots: roots, colGap: 286, rowGap: 112 });
    } },
    pipeline: { id: 'pipeline', label: 'PIPELINE', build(ctx) {
      const stages = collapseToStages(ctx.events); if (!stages.length) return empty();
      const nodes = stages.map((s, i) => node('stage:' + s.id, s.label, 'stage', 'pipeline', s.state, { refKey: s.key, refEvIdx: s.evIdx, done: s.done, total: s.total, order: i, sub: s.total ? s.done + '/' + s.total : '', pct: s.total ? Math.round(s.done / s.total * 100) : (s.state === 'done' ? 100 : 0), w: 200, h: 78, catLabel: 'STAGE' }));
      nodes.forEach((n) => withRole(n, n.meta.refKey));
      const edges = []; for (let i = 0; i < nodes.length - 1; i++) edges.push(edge(nodes[i].id, nodes[i + 1].id, 'critical'));
      return chainLR(nodes, edges, { colGap: 232 });
    } },
    test: { id: 'test', label: 'TEST', build(ctx) {
      const checks = pairChecks(ctx.events); const root = node('tests:root', 'TESTS', 'root', 'test', checks.length ? rollChecks(checks) : 'waiting', { glyph: '◉', w: 158, sub: checks.length + ' checks', catLabel: 'TESTS', accent: 'var(--cyan)' });
      const nodes = [root]; const edges = [];
      checks.forEach((c) => { const n = node('check:' + c.startIdx, F().trunc(c.task, 34), 'check', 'test', c.state, { refEvIdx: c.startIdx, refKey: c.agent, glyph: '◉', sub: c.agent || '', w: 256, h: 50, catLabel: 'CHECK' }); withRole(n, c.agent); nodes.push(n); edges.push(edge('tests:root', n.id, c.state === 'failed' ? 'flow-fail' : 'handoff')); });
      return checks.length ? layeredLR(nodes, edges, { maxDepth: 1, colGap: 320, rowGap: 78 }) : empty();
    } },
    review: { id: 'review', label: 'REVIEW', build(ctx) {
      const { events } = ctx; if (!events.some((e) => /codex|fix_|retest|quality_gate|check_failed/.test(e.event_type))) return empty();
      const nodes = [], edges = [];
      const root = node('review:codex', 'CODEX REVIEW', 'codex', 'review', rollReview(events), { glyph: '⧉', w: 204, h: 78, catLabel: 'REVIEW', accent: 'var(--blue)', sub: 'review loop' }); nodes.push(root);
      events.forEach((e, i) => { if (e.event_type !== 'codex_finding' && e.event_type !== 'check_failed') return; const sev = (e.severity || '').toLowerCase();
        const st = (/crit|high/.test(sev) || e.event_type === 'check_failed') ? 'failed' : /med/.test(sev) ? 'waiting' : 'internal';
        const n = node('finding:' + i, F().trunc(e.issue || e.note || 'finding', 32), 'finding', 'review', st, { refEvIdx: i, refKey: e.agent, glyph: '◈', sub: (e.severity || e.area || 'finding'), w: 236, h: 50, catLabel: 'FINDING' }); nodes.push(n); edges.push(edge('review:codex', n.id, st === 'failed' ? 'flow-fail' : 'handoff')); });
      let prev = 'review:codex';
      if (events.some((e) => /fix_/.test(e.event_type))) { const st = events.some((e) => e.event_type === 'fix_completed') ? 'done' : 'running'; nodes.push(node('review:fix', 'FIX', 'stage', 'review', st, { glyph: '⚒', w: 170, h: 64, catLabel: 'FIX' })); edges.push(edge(prev, 'review:fix', 'critical')); prev = 'review:fix'; }
      if (events.some((e) => /retest/.test(e.event_type))) { const st = events.some((e) => e.event_type === 'retest_completed') ? 'done' : 'running'; nodes.push(node('review:retest', 'RETEST', 'stage', 'review', st, { glyph: '◉', w: 170, h: 64, catLabel: 'RETEST' })); edges.push(edge(prev, 'review:retest', 'critical')); prev = 'review:retest'; }
      const gp = events.some((e) => e.event_type === 'quality_gate_passed'), gb = events.some((e) => e.event_type === 'quality_gate_blocked');
      if (gp || gb) { nodes.push(node('review:gate', 'QUALITY GATE', 'stage', 'review', gp ? 'done' : 'failed', { glyph: '⛒', w: 182, h: 64, catLabel: 'GATE' })); edges.push(edge(prev, 'review:gate', 'critical')); if (gb) edges.push(edge('review:gate', 'review:fix', 'loop')); }
      return layeredLR(nodes, edges, { colGap: 286, rowGap: 70 });
    } },
    artifacts: { id: 'artifacts', label: 'ARTIFACTS', build(ctx) {
      const { agents } = ctx; const nodes = [], edges = []; let any = false;
      agents.forEach((a) => { const arts = a.artifacts.length ? a.artifacts.map((x) => ({ label: x.artifact || x.path, kind: x.kind || 'artifact', derived: false })) : [...a.filesChanged].map((f) => ({ label: f, kind: 'file', derived: true }));
        if (!arts.length) return; any = true;
        const h = node('agentHdr:' + a.key, a.key, 'agentHdr', 'artifacts', F().nodeState(a), { refKey: a.key, w: 178 }); withRole(h, a.key, a.role); nodes.push(h);
        arts.forEach((art, i) => { const n = node('art:' + a.key + ':' + i, F().trunc(art.label, 30), 'artifact', 'artifacts', art.derived ? 'previewing' : 'done', { refKey: a.key, glyph: '▭', sub: art.kind + (art.derived ? ' · derived' : ''), w: 236, h: 50, catLabel: 'ARTIFACT', derived: art.derived }); n.accent = F().agentColor(a.key, a.role).solid; nodes.push(n); edges.push(edge('agentHdr:' + a.key, n.id, 'handoff')); });
      });
      return any ? layeredLR(nodes, edges, { maxDepth: 1, colGap: 300, rowGap: 62 }) : empty();
    } },
    // TASK GRAPH (2026-07-09 Mission Control §D): every subagent + EACH task it performed is its own connected
    // node — agent → task1 → task2 → … — so the whole run reads as one big live node-graph. Real data only:
    // tasks come straight from buildNodes()'s n.tasks (real logged non-backbone events); nothing synthesized.
    taskgraph: { id: 'taskgraph', label: 'TASK GRAPH', build(ctx) {
      const { agents, events } = ctx; if (!agents.length) return empty();
      const nodes = [], edges = [];
      agents.forEach((a) => {
        const c = F().agentColor(a.key, a.role); const done = a.tasks.filter((t) => t.status === 'done').length;
        const an = node('agent:' + a.key, prettyAgentName(a.key), 'agent', 'taskgraph', F().nodeState(a),
          { refKey: a.key, total: a.tasks.length, done, sub: (a.role || c.label) + ' · ' + (a._claimMismatch ? '⚠ claims done · ' : '') + done + '/' + a.tasks.length + ' tasks', w: 210, h: 74, derived: a.derived });
        an.role = c.role; an.glyph = c.glyph; an.accent = c.solid; an.fill = c.fill; an.fillLo = c.fillLo; nodes.push(an);
        let prev = 'agent:' + a.key; // chain the agent's tasks sequentially (agent → task1 → task2 → …)
        a.tasks.forEach((t) => {
          const tn = node('task:' + t.evIdx, F().trunc(t.title, 30), 'task', 'taskgraph', t.status,
            { refEvIdx: t.evIdx, refKey: a.key, sub: (F().hhmmss ? F().hhmmss(t.ts) : ''), w: 208, h: 46, catLabel: 'TASK' });
          tn.accent = c.solid; nodes.push(tn);
          edges.push(edge(prev, tn.id, t.status === 'done' ? 'critical' : t.status === 'failed' ? 'flow-fail' : 'handoff'));
          prev = tn.id;
        });
      });
      // keep real agent→agent handoffs so parallel Boss lanes still connect
      const handoffs = dagDeps(agents, events).filter((e) => e.kind === 'handoff');
      return layeredLR(nodes, edges.concat(handoffs), { colGap: 252, rowGap: 96 });
    } },
    // MIND MAP (2026-07-10 Mission Control WP4): renders the LATEST stored mind map
    // (.claude/forge-mindmaps/, forge-bin/forge-mindmap.cjs) as a root-centered radial graph. Read-only,
    // real data only — ctx.mindmaps comes straight from the server's readMindmaps(); nothing synthesized.
    mindmap: { id: 'mindmap', label: 'MIND MAP', build(ctx) {
      const maps = ctx.mindmaps || []; if (!maps.length) return empty();
      const map = maps[0]; // readMindmaps() sorts newest-first, same convention as readPrds()
      const srcNodes = Array.isArray(map.nodes) ? map.nodes : []; const srcEdges = Array.isArray(map.edges) ? map.edges : [];
      if (!srcNodes.length) return empty();
      const nodes = srcNodes.map((n) => node('mm:' + n.id, n.label, n.kind || 'concept', 'mindmap', 'done', { w: 200, h: 64 }));
      const idSet = new Set(srcNodes.map((n) => n.id));
      const edges = srcEdges.filter((e) => idSet.has(e.from) && idSet.has(e.to)).map((e) => edge('mm:' + e.from, 'mm:' + e.to, 'flow'));
      return radial(nodes, edges, { ringGap: 220 });
    } },
    // WATERFALL / GANTT (2026-07-11): a time-axis view — one swimlane per Boss, bars = task-span duration,
    // positioned by real event timestamps so bottlenecks, stalls and wait-gaps are visible (what no topology
    // lens shows). Pure client-side: spans are paired from *_started → *_(passed|completed|failed) events;
    // node x = time, width = duration. Reuses placeNode (x/y/w/h) — no renderer change.
    waterfall: { id: 'waterfall', label: 'WATERFALL', build(ctx) {
      const evs = (ctx.events || []).filter((e) => e && e.timestamp);
      const timed = evs.map((e) => ({ e, t: Date.parse(e.timestamp), key: agentKeyOf(e) })).filter((x) => Number.isFinite(x.t));
      if (!timed.length) return empty();
      let minT = Infinity, maxT = -Infinity;
      for (const x of timed) { if (x.t < minT) minT = x.t; if (x.t > maxT) maxT = x.t; }
      const spanT = Math.max(1, maxT - minT);
      const laneOrder = []; const byLane = new Map();
      for (const x of timed) { if (!byLane.has(x.key)) { byLane.set(x.key, []); laneOrder.push(x.key); } byLane.get(x.key).push(x); }
      const PAD_X = 150, TIME_W = Math.max(900, Math.min(2200, timed.length * 26)), HEAD = 56, ROW = 58, BAR_H = 30;
      const xOf = (t) => PAD_X + ((t - minT) / spanT) * TIME_W;
      const isStart = (t) => /_started$/.test(t);
      const isEnd = (t) => /_(passed|completed|failed)$/.test(t);
      const clip = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
      const fmt = (ms) => ms < 1000 ? ms + 'ms' : (ms < 60000 ? (ms / 1000).toFixed(1) + 's' : Math.floor(ms / 60000) + 'm' + Math.round((ms % 60000) / 1000) + 's');
      const nodes = [];
      laneOrder.forEach((key, li) => {
        const y = HEAD + li * ROW;
        const list = byLane.get(key).slice().sort((a, b) => a.t - b.t);
        const laneStart = list[0].t, laneEnd = list[list.length - 1].t;
        const laneState = ctx.agents ? agentStateOf(ctx.agents, key) : 'done';
        const lbl = node('wflane:' + key, clip(prettyAgentName(key), 18), 'agent', 'waterfall', laneState, { w: PAD_X - 16, h: BAR_H, sub: fmt(laneEnd - laneStart), refKey: key });
        withRole(lbl, key); lbl.x = 8; lbl.y = y; nodes.push(lbl);
        const open = []; const spans = [];
        for (const x of list) {
          const t = x.e.event_type;
          if (isStart(t)) open.push(x);
          else if (isEnd(t) && open.length) { const s = open.shift(); spans.push({ from: s.t, to: x.t, state: /_failed$/.test(t) ? 'failed' : 'done', label: x.e.task || s.e.task || x.e.note || t }); }
        }
        for (const s of open) spans.push({ from: s.t, to: laneEnd, state: 'running', label: s.e.task || s.e.note || s.e.event_type });
        if (!spans.length) spans.push({ from: laneStart, to: laneEnd, state: laneState, label: prettyAgentName(key) + ' activity' });
        spans.forEach((s, si) => {
          const x0 = xOf(s.from), w = Math.max(72, xOf(s.to) - x0); // min bar width so a short-span label never wraps into a tall box
          const bar = node('wf:' + key + ':' + si, clip(s.label, 16), 'agent', 'waterfall', s.state, { w, h: BAR_H, sub: fmt(s.to - s.from), refKey: key });
          withRole(bar, key); bar.x = x0; bar.y = y; nodes.push(bar);
        });
      });
      return { nodes, edges: [], world: { w: PAD_X + TIME_W + 120, h: HEAD + laneOrder.length * ROW + 80 } };
    } },
  };
  const LENS_ORDER = ['note', 'workflow', 'execution', 'dag', 'agents', 'pipeline', 'flow', 'waterfall', 'taskgraph', 'mindmap', 'test', 'review', 'artifacts'];
  window.Forge = Object.assign(window.Forge || {}, { LENSES, LENS_ORDER, layeredLR, chainLR, radial });
})();
