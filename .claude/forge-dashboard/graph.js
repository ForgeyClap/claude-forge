'use strict';
/* Forge Control Center — interaction + render orchestration: world transform, pan/zoom, minimap,
   node reconcile, edges (critical/handoff/waiting/loop/active), panel wiring. Live, viewport-stable. */

const STATE_CLS = { running: 's-run', done: 's-done', waiting: 's-wait', previewing: 's-prev', failed: 's-fail', internal: 's-int' };
const STATE_WORD = { running: 'running', done: 'completed', waiting: 'waiting', previewing: 'previewing', failed: 'failed', internal: 'internal only' };
const MM_COL = { running: '#ffb454', done: '#46e08a', waiting: '#37e0e0', previewing: '#5aa9ff', failed: '#ff4d4d', internal: '#5e6b66' };
let currentLens = 'note', firstPaint = true, CURRENT_EDGES = []; // default = the ALL tab — everything in one graph (owner: "alles op 1 tablad")
const NODE_ELS = new Map();
// milestone/structural kinds show their catLabel (not a role label) even when refKey is set for selection
const MILE_KINDS = new Set(['mission', 'masterplan', 'lead', 'merge', 'codex', 'report', 'leadreview', 'rework', 'fixloop', 'qa', 'output', 'preflight', 'collector']);

/* ---------- viewport ---------- */
const VP = {
  tx: 0, ty: 0, scale: 1, worldW: 1000, worldH: 700, MIN: 0.3, MAX: 2.2, _raf: 0, canvas: null, viewport: null,
  init() { this.canvas = $('canvas'); this.viewport = $('viewport'); },
  schedule() { if (this._raf) return; this._raf = requestAnimationFrame(() => { this._raf = 0;
    this.viewport.style.transform = 'translate3d(' + this.tx.toFixed(1) + 'px,' + this.ty.toFixed(1) + 'px,0) scale(' + this.scale.toFixed(3) + ')';
    MM.syncRect(); const z = $('vp-zoom'); if (z) z.textContent = Math.round(this.scale * 100) + '%'; }); },
  zoomAt(sx, sy, f) { const ns = Math.max(this.MIN, Math.min(this.MAX, this.scale * f)); if (ns === this.scale) return;
    this.tx = sx - (sx - this.tx) * (ns / this.scale); this.ty = sy - (sy - this.ty) * (ns / this.scale); this.scale = ns; this.schedule(); },
  fit(pad) { pad = pad || 64; const r = this.canvas.getBoundingClientRect(); if (!r.width) return;
    const sw = (r.width - pad * 2) / this.worldW, sh = (r.height - pad * 2) / this.worldH;
    let s = Math.min(sw, sh, 1.3); if (s < 0.8) s = Math.min(sw, 1.1); if (s < 0.55) s = 0.55; s = Math.max(this.MIN, Math.min(this.MAX, s));
    this.scale = s; this.tx = this.worldW * s <= r.width ? (r.width - this.worldW * s) / 2 : pad; this.ty = this.worldH * s <= r.height ? (r.height - this.worldH * s) / 2 : pad; this.schedule(); },
  reset() { this.fit(64); },
  centerOnWorld(wx, wy) { const r = this.canvas.getBoundingClientRect(); this.tx = r.width / 2 - wx * this.scale; this.ty = r.height / 2 - wy * this.scale; this.schedule(); },
};
function screenToWorld(sx, sy) { return { x: (sx - VP.tx) / VP.scale, y: (sy - VP.ty) / VP.scale }; }

/* ---------- minimap ---------- */
const MM = {
  box: null, cv: null, ctx: null, rect: null, s: 1, ox: 0, oy: 0,
  init() { this.box = $('minimap'); this.cv = $('mm-canvas'); this.rect = $('mm-view'); if (!this.cv) return; this.ctx = this.cv.getContext('2d');
    this.box.addEventListener('pointerdown', (e) => { const b = this.cv.getBoundingClientRect(); VP.centerOnWorld((e.clientX - b.left - this.ox) / this.s, (e.clientY - b.top - this.oy) / this.s); }); },
  render(nodes) { if (!this.ctx) return; const bw = this.box.clientWidth, bh = this.box.clientHeight; this.cv.width = bw; this.cv.height = bh; const ctx = this.ctx; ctx.clearRect(0, 0, bw, bh);
    if (nodes.length < 6) { this.box.style.display = 'none'; return; } this.box.style.display = '';
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + (n.h || 66)); }
    const pad = 8, cw = Math.max(1, maxX - minX), ch = Math.max(1, maxY - minY); this.s = Math.min((bw - pad * 2) / cw, (bh - pad * 2) / ch); this.ox = pad - minX * this.s; this.oy = pad - minY * this.s;
    for (const n of nodes) { ctx.fillStyle = MM_COL[n.state] || '#5e6b66'; ctx.fillRect(this.ox + n.x * this.s, this.oy + n.y * this.s, Math.max(2, n.w * this.s), Math.max(2, n.h * this.s)); }
    this.syncRect(); },
  syncRect() { if (!this.rect || !VP.canvas) return; const r = VP.canvas.getBoundingClientRect(); const tl = screenToWorld(0, 0), br = screenToWorld(r.width, r.height);
    this.rect.style.left = (this.ox + tl.x * this.s) + 'px'; this.rect.style.top = (this.oy + tl.y * this.s) + 'px'; this.rect.style.width = Math.max(6, (br.x - tl.x) * this.s) + 'px'; this.rect.style.height = Math.max(6, (br.y - tl.y) * this.s) + 'px'; },
};

/* ---------- generic node render ---------- */
function gnodeInner(n) { const m = n.meta || {};
  const hasTotal = m.total != null && +m.total > 0; const doneN = +m.done || 0, totalN = +m.total || 0;
  // meter replaces the old green bar: a gear that SPINS while running + a done/total counter (0/6 → 1/6)
  const showMeter = (n.kind === 'agent' || n.kind === 'stage' || n.kind === 'phase' || n.kind === 'dag') && (hasTotal || n.state === 'done' || n.state === 'running');
  const cat = ((MILE_KINDS.has(n.kind) || n.kind === 'agent') && n.catLabel) ? n.catLabel : (n.refKey ? agentColor(n.refKey, n.role).label : (n.catLabel || n.kind.toUpperCase()));
  // agent → task1 → task2 … : real logged tasks listed under the agent name (capped, oldest folded into "+N earlier")
  let tl = '';
  if (Array.isArray(m.tasklist) && m.tasklist.length) { const MAXT = 4; const shown = m.tasklist.slice(-MAXT); const extra = m.tasklist.length - shown.length;
    tl = '<ul class="tlist">' + (extra > 0 ? '<li class="tl-more">+' + extra + ' earlier</li>' : '')
      + shown.map((t) => '<li class="tl-item ' + (STATE_CLS[t.status] || 's-wait') + '"><i class="tl-dot"></i><span>' + esc(trunc(t.title, 30)) + '</span></li>').join('') + '</ul>'; }
  let meter = '';
  if (showMeter) { const counter = hasTotal ? (doneN + '/' + totalN) : ''; const running = n.state === 'running'; const glyph = n.state === 'done' ? '✓' : '⚙';
    meter = '<span class="pmeter' + (running ? ' spin' : '') + (n.state === 'done' ? ' ok' : '') + '" title="' + (hasTotal ? doneN + ' of ' + totalN + ' tasks done' : (running ? 'running' : '')) + '">'
      + '<span class="gear" aria-hidden="true">' + glyph + '</span>' + (counter ? '<span class="pnum">' + esc(counter) + '</span>' : '') + '</span>'; }
  return (n.badge ? '<span class="edgebadge">' + esc(n.badge) + '</span>' : '')
    + '<div class="cat"><span class="gl">' + (n.glyph || '●') + '</span>' + esc(cat) + (m.derived ? '<span class="derived">derived</span>' : '') + '</div>'
    + '<div class="ttl">' + esc(n.label) + '</div>'
    + (n.sub ? '<div class="sub">' + esc(n.sub) + '</div>' : '')
    + tl + meter;
}
function placeNode(el, n) { el.style.left = n.x + 'px'; el.style.top = n.y + 'px'; el.style.width = n.w + 'px'; if (n.h) el.style.minHeight = n.h + 'px';
  if (n.accent) el.style.setProperty('--role', n.accent); if (n.fill) el.style.setProperty('--role-fill', n.fill); if (n.fillLo) el.style.setProperty('--role-fill-lo', n.fillLo); }
function nodeSig(n) { const m = n.meta || {}; const tlsig = Array.isArray(m.tasklist) ? m.tasklist.length + ':' + m.tasklist.map((t) => (t.status || '?')[0]).join('') : '';
  return n.state + '|' + n.label + '|' + n.sub + '|' + n.x + ',' + n.y + '|' + (m.pct || '') + '|' + (m.total || '') + ',' + (m.done || '') + '|' + (n.badge || '') + '|' + tlsig; }
function selMatches(n) { return (selRef.refEvIdx != null && selRef.refEvIdx === n.refEvIdx) || (selRef.refKey != null && selRef.refEvIdx == null && n.refEvIdx == null && selRef.refKey === n.refKey); }
function classFor(n) { return 'gnode is-' + n.kind + ' ' + STATE_CLS[n.state] + (n.lens ? ' lens-' + n.lens : '') + (selMatches(n) ? ' sel' : ''); }
function ariaFor(n) { return [n.label, n.role || n.kind, STATE_WORD[n.state], n.sub].filter(Boolean).join(', '); }
function pulseOnce(el, cls) { el.classList.add(cls); el.addEventListener('animationend', () => el.classList.remove(cls), { once: true }); }
function reconcileGraph(nodes) {
  const world = $('graph'); const seen = new Set();
  for (const n of nodes) { seen.add(n.id); let rec = NODE_ELS.get(n.id);
    if (!rec) { const el = document.createElement('div'); el.className = classFor(n) + ' is-new'; el.dataset.id = n.id; el.tabIndex = 0; el.setAttribute('role', 'button'); el.setAttribute('aria-label', ariaFor(n));
      el.innerHTML = gnodeInner(n); placeNode(el, n); el.addEventListener('animationend', () => el.classList.remove('is-new'), { once: true });
      el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); selectNode(n.id); } });
      world.appendChild(el); NODE_ELS.set(n.id, { el, sig: nodeSig(n), state: n.state }); }
    else { const sig = nodeSig(n); if (sig !== rec.sig) { const prev = rec.state; rec.el.className = classFor(n); rec.el.innerHTML = gnodeInner(n); placeNode(rec.el, n); rec.el.setAttribute('aria-label', ariaFor(n)); rec.sig = sig; rec.state = n.state;
      if (prev === 'running' && n.state === 'done') pulseOnce(rec.el, 'just-done'); if (prev !== 'failed' && n.state === 'failed') pulseOnce(rec.el, 'just-fail'); } } }
  for (const [id, rec] of NODE_ELS) if (!seen.has(id)) { rec.el.remove(); NODE_ELS.delete(id); }
}

/* ---------- world edges ---------- */
const EDGE_COL = { critical: '#46e08a', done: '#2faa66', active: '#ffb454', fail: '#ff4d4d', handoff: '#93aaa0', wait: '#37e0e0', loop: '#5aa9ff', idle: '#6b8078', spine: '#37e0e0', artifact: '#37e0e0', blocked: '#ff7a6e' };
function marker(name, color) { return '<marker id="ah-' + name + '" viewBox="0 0 8 8" refX="6.5" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="' + color + '"/></marker>'; }
function edgeClass(e, a, b) {
  if (e.kind === 'artifact') return 'artifact'; if (e.kind === 'blocked') return 'blocked';
  if (e.kind === 'loop') return 'loop'; if (e.kind === 'spine') return 'spine'; if (e.kind === 'wait' || e.kind === 'dim') return 'wait';
  if (e.kind === 'critical') return b.state === 'failed' ? 'fail' : 'critical';
  if (e.kind === 'handoff') return (a.state === 'running' || b.state === 'running') ? 'active' : 'handoff';
  if (e.kind === 'flow-fail' || e.kind === 'branch-fail' || b.state === 'failed') return 'fail';
  if (e.kind === 'flow-active' || e.kind === 'branch-active' || a.state === 'running' || b.state === 'running') return 'active';
  if (b.state === 'done') return 'done'; return 'idle';
}
function drawEdgesWorld(nodes) {
  const by = new Map(nodes.map((n) => [n.id, n])); const svg = $('edges');
  let out = '<defs>' + Object.keys(EDGE_COL).map((k) => marker(k, EDGE_COL[k])).join('') + '</defs>';
  for (const e of CURRENT_EDGES) { const a = by.get(e.from), b = by.get(e.to); if (!a || !b) continue;
    const cls = edgeClass(e, a, b); let d;
    if (e.kind === 'loop') { const x1 = a.x, y1 = a.y + (a.h || 66) / 2, x2 = b.x, y2 = b.y + (b.h || 66) / 2;
      if (Math.abs(x1 - x2) < 200) { const bow = Math.min(x1, x2) - 120; d = 'M ' + x1 + ' ' + y1 + ' C ' + bow + ' ' + y1 + ', ' + bow + ' ' + y2 + ', ' + x2 + ' ' + y2; }
      else { const my = Math.max(y1, y2) + 96; d = 'M ' + x1 + ' ' + y1 + ' C ' + x1 + ' ' + my + ', ' + x2 + ' ' + my + ', ' + x2 + ' ' + y2; } }
    else { const p1 = { x: a.x + a.w, y: a.y + (a.h || 66) / 2 }, p2 = { x: b.x, y: b.y + (b.h || 66) / 2 };
      if (Math.abs(p2.y - p1.y) > Math.abs(p2.x - p1.x) && p2.x < p1.x + 40) { const my = (p1.y + p2.y) / 2; const cxx = (a.x + a.w / 2); d = 'M ' + (a.x + a.w / 2) + ' ' + (a.y + (a.h || 66)) + ' C ' + cxx + ' ' + my + ', ' + (b.x + b.w / 2) + ' ' + my + ', ' + (b.x + b.w / 2) + ' ' + b.y; }
      else { const dx = Math.max(24, (p2.x - p1.x) * 0.4); d = 'M ' + p1.x + ' ' + p1.y + ' C ' + (p1.x + dx) + ' ' + p1.y + ', ' + (p2.x - dx) + ' ' + p2.y + ', ' + p2.x + ' ' + p2.y; } }
    out += '<path class="edge ' + cls + '" marker-end="url(#ah-' + cls + ')" d="' + d + '"/>'; }
  svg.setAttribute('width', VP.worldW); svg.setAttribute('height', VP.worldH); svg.style.width = VP.worldW + 'px'; svg.style.height = VP.worldH + 'px'; svg.innerHTML = out;
}

/* ---------- selection ---------- */
function findModelNode(id) { return CURRENT_MODEL.nodes.find((n) => n.id === id); }
function applySel() { for (const [id, rec] of NODE_ELS) rec.el.classList.toggle('sel', !!selMatches(findModelNode(id) || {})); }
function selectNode(id) { const n = findModelNode(id); if (!n) return; selRef = { refKey: n.refKey, refEvIdx: n.refEvIdx }; selectedKey = id; applySel(); renderInspector(); renderSidebar(); }
function selectAgent(key) { selRef = { refKey: key, refEvIdx: null }; applySel(); renderInspector(); renderSidebar(); }
function focusNode(key) { const n = CURRENT_MODEL.nodes.find((x) => x.refKey === key) || CURRENT_MODEL.nodes.find((x) => x.id === 'agent:' + key); if (n) VP.centerOnWorld(n.x + n.w / 2, n.y + (n.h || 66) / 2); }
function syncSelection() { if (selRef.refEvIdx == null && !selRef.refKey) return; let m = null;
  if (selRef.refEvIdx != null) m = CURRENT_MODEL.nodes.find((n) => n.refEvIdx === selRef.refEvIdx);
  if (!m && selRef.refKey) m = CURRENT_MODEL.nodes.find((n) => n.refKey === selRef.refKey && n.refEvIdx == null);
  selectedKey = m ? m.id : null; applySel(); }

/* ---------- render orchestration ---------- */
// which event types are present now (computed once per render) — drives the lens data indicators
function _eventTypeSet() { const s = new Set(); for (const e of visibleEvents()) s.add(e.event_type); return s; }
// is a lens backed by real data right now, and if not, what does it need? (honest "why is this empty")
function lensDataInfo(id, types) { types = types || _eventTypeSet();
  const anyRe = (re) => { for (const t of types) if (re.test(t)) return true; return false; };
  const nAgents = STATE._nodes.length;
  switch (id) {
    case 'note': return { ok: types.size > 0 || (STATE.prds || []).length > 0 || (STATE.tickets || []).length > 0 || (STATE.artifacts || []).length > 0 || !!STATE.doctor || (STATE.mindmaps || []).length > 0,
      need: 'No activity yet — every agent, task, gate, PRD, mind map, artifact and cost appears here once a run logs real events.' };
    case 'execution': return { ok: anyRe(/^(file_read|file_changed|command_run|skill_loaded)$/), need: 'file / command / skill activity' };
    case 'test': return { ok: anyRe(/^check_/), need: 'check_started / check_passed / check_failed' };
    case 'review': return { ok: anyRe(/codex|fix_|retest|quality_gate|check_failed/), need: 'codex / fix / retest / quality-gate events' };
    case 'artifacts': return { ok: STATE._nodes.some((n) => (n.artifacts && n.artifacts.length) || (n.filesChanged && n.filesChanged.size)), need: 'artifacts or changed files' };
    case 'pipeline': return { ok: anyRe(/^(run_started|agent_started|agent_selected|agent_work_package_created|codex_review_started|report_generated)$/), need: 'run / agent stage events' };
    case 'dag': case 'agents': case 'flow': case 'taskgraph': return { ok: nAgents > 0, need: 'agents (run / agent events)' };
    case 'workflow': return { ok: types.size > 0, need: 'any events' };
    case 'mindmap': return { ok: (STATE.mindmaps || []).length > 0, need: 'a mind map — generate one with forge-mindmap' };
    default: return { ok: true, need: '' };
  } }
// dim lens tabs that have no data yet (so "empty categories" read as honestly-empty, not broken)
function updateLensData() { const types = _eventTypeSet();
  document.querySelectorAll('.lensbar button').forEach((b) => { const id = b.dataset.lens; if (!id) return; const info = lensDataInfo(id, types);
    b.classList.toggle('lens-empty-tab', !info.ok); if (!info.ok) b.title = 'no data yet — needs ' + info.need; else b.removeAttribute('title'); }); }
function renderActive() {
  const L = window.Forge.LENSES[currentLens] || window.Forge.LENSES.flow;
  // Codex finding: lenses must see the SAME replay-sliced events as buildNodes — otherwise future
  // milestones (rework/merge/final) leak into the graph mid-replay.
  const model = L.build({ events: visibleEvents(), run: STATE.run, agents: STATE._nodes, mindmaps: STATE.mindmaps || [],
    prds: STATE.prds || [], tickets: STATE.tickets || [], artifacts: STATE.artifacts || [], doctor: STATE.doctor || null });
  CURRENT_MODEL = model; CURRENT_EDGES = model.edges || []; VP.worldW = model.world.w || 1000; VP.worldH = model.world.h || 700;
  updateLensData();
  const empty = $('lens-empty');
  if (empty) { const has = model.nodes.length > 0; empty.hidden = has;
    if (!has) { const info = lensDataInfo(currentLens); const lbl = L.label || currentLens.toUpperCase();
      empty.innerHTML = esc(lbl) + ' — no data yet · needs ' + esc(info.need) + ' <span class="blink">waiting for events</span>'; } }
  reconcileGraph(model.nodes); requestAnimationFrame(() => drawEdgesWorld(model.nodes)); MM.render(model.nodes); syncSelection();
  if (firstPaint) { VP.fit(64); firstPaint = false; } else VP.schedule();
}
function renderAll() { STATE._nodes = buildNodes(); renderActive(); renderTop(); renderSidebar(); renderInspector(); renderActivity(); renderDock(); renderMetrics(); renderReplayBar(); STATE._prevCount = STATE.events.length; }

/* ---------- live vs replay ---------- */
let replayTimer = null;
function replayStop() { if (replayTimer) { clearInterval(replayTimer); replayTimer = null; } }
function replayStart() { replayStop(); const iv = Math.max(120, Math.round(650 / (STATE.replay.speed || 1)));
  replayTimer = setInterval(() => { const r = STATE.replay; if (!r.playing) return;
    if (r.cursor >= STATE.events.length) { r.playing = false; replayStop(); renderAll(); return; }
    r.cursor++; renderAll(); }, iv); }
function replayToggle() { const r = STATE.replay;
  if (!r.active) { r.active = true; r.playing = true; if (r.cursor >= STATE.events.length) r.cursor = 0; replayStart(); }
  else if (r.playing) { r.playing = false; replayStop(); }
  else { r.playing = true; if (r.cursor >= STATE.events.length) r.cursor = 0; replayStart(); }
  renderAll(); }
function replayReset() { const r = STATE.replay; r.active = true; r.playing = false; r.cursor = 0; replayStop(); renderAll(); }
function replayLive() { const r = STATE.replay; r.active = false; r.playing = false; r.cursor = STATE.events.length; replayStop(); renderAll(); }
function replaySpeed() { const r = STATE.replay; r.speed = r.speed === 1 ? 2 : r.speed === 2 ? 5 : 1; if (r.playing) replayStart(); renderReplayBar(); }
function renderReplayBar() { const bar = $('replay-bar'); if (!bar) return; const r = STATE.replay; const n = STATE.events.length;
  const done = (STATE.run.status || '').toLowerCase() === 'completed';
  const playBtn = $('rp-play'), label = $('rp-label'), spd = $('rp-speed');
  if (spd) spd.textContent = (r.speed || 1) + 'x';
  if (playBtn) playBtn.textContent = (r.active && r.playing) ? '⏸' : '▶';
  if (label) label.textContent = r.active ? ('Replaying ' + Math.min(r.cursor, n) + '/' + n) : (done ? 'Completed run — Replay available' : 'Live run');
  bar.classList.toggle('replaying', r.active); bar.classList.toggle('disabled', n === 0); }
function initReplay() { const p = $('rp-play'); if (p) p.addEventListener('click', replayToggle);
  const s = $('rp-speed'); if (s) s.addEventListener('click', replaySpeed);
  const rs = $('rp-reset'); if (rs) rs.addEventListener('click', replayReset);
  const lv = $('rp-live'); if (lv) lv.addEventListener('click', replayLive); renderReplayBar(); }

/* ---------- lens routing ---------- */
function lensFromURL() { const q = new URLSearchParams(location.search).get('lens'); return (q && window.Forge.LENSES[q]) ? q : 'note'; }
function setLens(id, fromUser) { const L = window.Forge.LENSES; if (!L[id]) id = 'flow'; if (id === currentLens && fromUser) return;
  currentLens = id; const u = new URL(location.href); u.searchParams.set('lens', id); history.replaceState(null, '', u);
  document.querySelectorAll('.lensbar button').forEach((b) => { const on = b.dataset.lens === id; b.setAttribute('aria-selected', on ? 'true' : 'false'); b.tabIndex = on ? 0 : -1; });
  for (const rec of NODE_ELS.values()) rec.el.remove(); NODE_ELS.clear();
  const g = $('graph'); g.classList.add('lens-swapping'); g.addEventListener('animationend', () => g.classList.remove('lens-swapping'), { once: true });
  firstPaint = true; renderAll();
}
function buildLensBar() { const bar = $('lensbar'); bar.setAttribute('role', 'tablist');
  bar.innerHTML = window.Forge.LENS_ORDER.map((id) => { const l = window.Forge.LENSES[id]; return '<button role="tab" data-lens="' + id + '" aria-selected="' + (id === currentLens) + '" tabindex="' + (id === currentLens ? 0 : -1) + '">' + esc(l.label) + '</button>'; }).join('');
  bar.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setLens(b.dataset.lens, true); }); }
function initKeys() { const order = window.Forge.LENS_ORDER;
  window.addEventListener('keydown', (e) => { if (e.target.matches && e.target.matches('input,textarea')) return; const onNode = e.target.closest && e.target.closest('.gnode');
    if (e.key >= '1' && e.key <= '8') { const n = order[+e.key - 1]; if (n) setLens(n, true); }
    else if (!onNode && (e.key === ']' || e.key === 'ArrowRight')) setLens(order[(order.indexOf(currentLens) + 1) % order.length], true);
    else if (!onNode && (e.key === '[' || e.key === 'ArrowLeft')) setLens(order[(order.indexOf(currentLens) - 1 + order.length) % order.length], true);
    else if (e.key === 'f' || e.key === 'F') VP.fit(); else if (e.key === '0') VP.reset();
    else if (e.key === '+' || e.key === '=') { const r = VP.canvas.getBoundingClientRect(); VP.zoomAt(r.width / 2, r.height / 2, 1.2); }
    else if (e.key === '-') { const r = VP.canvas.getBoundingClientRect(); VP.zoomAt(r.width / 2, r.height / 2, 1 / 1.2); } }); }

/* ---------- pan / zoom / panel wiring ---------- */
const PAN = { suppress: false };
function initInteraction() {
  const canvas = VP.canvas; let down = null;
  canvas.addEventListener('pointerdown', (e) => { if (e.button !== 0 || (e.target.closest && e.target.closest('.minimap,.vp-controls'))) return; down = { sx: e.clientX, sy: e.clientY, ox: VP.tx, oy: VP.ty, moved: false }; canvas.classList.add('grabbing'); });
  window.addEventListener('pointermove', (e) => { if (!down) return; const dx = e.clientX - down.sx, dy = e.clientY - down.sy; if (Math.abs(dx) + Math.abs(dy) > 4) down.moved = true; VP.tx = down.ox + dx; VP.ty = down.oy + dy; VP.schedule(); });
  window.addEventListener('pointerup', () => { if (down) { PAN.suppress = down.moved; down = null; canvas.classList.remove('grabbing'); } });
  canvas.addEventListener('click', (e) => { if (PAN.suppress) { PAN.suppress = false; return; } const el = e.target.closest && e.target.closest('.gnode'); if (el) selectNode(el.dataset.id); });
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); const r = canvas.getBoundingClientRect(); if (e.shiftKey) { VP.tx -= e.deltaY; VP.schedule(); } else VP.zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.1 : 1 / 1.1); }, { passive: false });
  $('vp-in').addEventListener('click', () => { const r = canvas.getBoundingClientRect(); VP.zoomAt(r.width / 2, r.height / 2, 1.2); });
  $('vp-out').addEventListener('click', () => { const r = canvas.getBoundingClientRect(); VP.zoomAt(r.width / 2, r.height / 2, 1 / 1.2); });
  $('vp-fit').addEventListener('click', () => VP.fit());
  // sidebar
  $('sb-groups').addEventListener('click', (e) => { const h = e.target.closest('.sb-ghead'); if (h) { const g = h.dataset.toggle; if (STATE.ui.collapsed.has(g)) STATE.ui.collapsed.delete(g); else STATE.ui.collapsed.add(g); renderSidebar(); return; }
    const row = e.target.closest('.sb-row'); if (row) { selectAgent(row.dataset.agent); focusNode(row.dataset.agent); } });
  // inspector tabs
  $('ins-tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { STATE.ui.insTab = b.dataset.itab; renderInspector(); } });
  // activity
  $('act-filters').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { STATE.ui.actFilter = b.dataset.actf; renderActivity(); } });
  $('act-feed').addEventListener('click', (e) => { const r = e.target.closest('.act-row'); if (r) { const ev = STATE.events[+r.dataset.ev]; if (ev) { const k = ev.agent || SYNTH[ev.event_type]; selectAgent(k); focusNode(k); } } });
  $('act-more').addEventListener('click', (e) => { e.preventDefault(); STATE.ui.dockTab = 'log'; renderDock(); });
  // dock tabs
  $('dock-tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { STATE.ui.dockTab = b.dataset.dock; renderDock();
    // V9-INTEGRATE (2026-07-22): the 'capabilities' tab lazy-loads its data on activation (real filesystem
    // scan + per-run contract check, never worth polling on the fast SSE/250ms tick — see panels.js
    // loadCapabilitiesPanel() doc comment). Fire-and-forget; loadCapabilitiesPanel() re-renders itself.
    if (b.dataset.dock === 'capabilities' && typeof loadCapabilitiesPanel === 'function') loadCapabilitiesPanel();
    if (b.dataset.dock === 'stats' && typeof loadStatsPanel === 'function') loadStatsPanel();
  } });
  // copy url
  $('copy-url').addEventListener('click', () => { try { navigator.clipboard.writeText(location.origin + location.pathname); const b = $('copy-url'); b.textContent = 'Copied ✓'; setTimeout(() => b.textContent = 'Copy URL', 1200); } catch {} });
  let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { MM.render(CURRENT_MODEL.nodes); VP.schedule(); }, 120); });
}

/* ---------- boot ---------- */
const SHOT = new URLSearchParams(location.search).has('shot');
// ?run=<id> pins a historical run — it's static (no SSE stream, no auto-refresh to latest) (Mission Control 2026-07-09)
const PINNED_RUN = new URLSearchParams(location.search).get('run');
function init() { VP.init(); MM.init(); currentLens = lensFromURL(); buildLensBar(); initInteraction(); initKeys(); initReplay();
  // snapshots hide the replay bar (clean screenshots) unless ?showreplay=1 (browser-proof testing of the bar itself)
  if (SHOT && !new URLSearchParams(location.search).has('showreplay')) { const rb = $('replay-bar'); if (rb) rb.style.display = 'none'; }
  const q = new URLSearchParams(location.search); const selParam = q.get('sel'), tabParam = q.get('tab'), dockParam = q.get('dock');
  fetchState().then(() => { if (dockParam) STATE.ui.dockTab = dockParam; renderAll(); // ?dock=<id> deep-links a dock tab (Mission Control 2026-07-10)
    // V9-INTEGRATE (2026-07-22): a ?dock=capabilities deep-link must also trigger the lazy load (the dock-tabs
    // click handler above only fires on a real click, not on this programmatic tab selection).
    if (dockParam === 'capabilities' && typeof loadCapabilitiesPanel === 'function') loadCapabilitiesPanel();
    if (dockParam === 'stats' && typeof loadStatsPanel === 'function') loadStatsPanel();
    if (selParam) { if (tabParam) STATE.ui.insTab = tabParam; selectAgent(selParam); focusNode(selParam); }
    if (SHOT || PINNED_RUN) setLive('on', PINNED_RUN ? 'RUN ' + PINNED_RUN.replace(/^forge-/, '') : 'SNAPSHOT'); else connectSSE(); });
  if (!SHOT && !PINNED_RUN) setInterval(async () => { await fetchState(); renderTop(); renderMetrics(); }, 5000); }
init();
