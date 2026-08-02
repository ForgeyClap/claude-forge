#!/usr/bin/env node
'use strict';
/** Offline, headless test for the cross-run Stats dashboard panel (forge-dashboard/panels.js, 2026-07-24).
 *  Loads the REAL panels.js in a Node vm with a minimal DOM/global stub and drives the ACTUAL
 *  DOCK_TABS/renderDock() path for the 'stats' tab — a pass proves the shipped panel renders the already-
 *  computed STATS.json honestly (real data, honest loading/empty/error states, never a fabricated number).
 *  Pure in-memory; never touches the project. Mirrors forge-doctor-panel.test.cjs. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };

const PANELS_PATH = path.join(__dirname, '..', 'forge-dashboard', 'panels.js');
const PANELS_SRC = fs.readFileSync(PANELS_PATH, 'utf8');

function makeEl() { return { innerHTML: '', textContent: '', className: '', hidden: false, style: {}, dataset: {}, scrollHeight: 0, scrollTop: 0, clientHeight: 0 }; }

function loadPanels(initialState) {
  const elements = new Map();
  const document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, makeEl()); return elements.get(id); },
    querySelectorAll() { return []; }, createElement() { return makeEl(); },
  };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const pad2 = (n) => (n < 10 ? '0' + n : '' + n);
  const hhmmss = (iso) => { try { const d = new Date(iso); if (Number.isNaN(d.getTime())) return ''; return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()); } catch { return ''; } };
  const trunc = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const fileName = (f) => !f ? '' : (typeof f === 'string' ? f : (f.file || ''));
  const statusLabel = (s) => ({ done: 'COMPLETED', running: 'RUNNING', failed: 'FAILED', waiting: 'WAITING' }[s] || 'WAITING');
  const STATE = Object.assign({
    meta: { name: '—', port: '' }, run: {}, events: [], report: null, memory: {}, runs: 0, malformed: 0,
    settings: { polling_interval_ms: 250, fast_mode: false, auto_scroll_logs: true },
    _nodes: [], _prevCount: 0, eccMode: { normal: 'on', full_test: 'off' }, session: { mode: 'off' },
    bosses: [], prds: [], mindmaps: [], tickets: [], artifacts: [], doctor: null, capabilities: null, runcontract: null, stats: null,
    replay: { active: false, playing: false, cursor: 0, speed: 1 },
    ui: { insTab: 'summary', actFilter: 'all', dockTab: 'log', collapsed: new Set() },
  }, initialState || {});
  const sandbox = {
    document, console, STATE, Forge: {},
    $: (id) => document.getElementById(id), esc, trunc, hhmmss, fileName, statusLabel,
    SYNTH: {}, GROUP_ORDER: [], GROUP_LABEL: {}, selRef: { refKey: null, refEvIdx: null },
    agentColor: () => ({ solid: '#fff', glyph: '' }), isSubagentNode: () => false, progress: () => 0, ago: () => '—',
    eccSummary: () => ({ state: 'off', normal: 'on', full_test: 'off', attempted: false, selected: [], invoked: [], skills: [], nativeFallback: false }),
    governanceSummary: () => ({ claudeMd: '—', skills: [], created: 0, used: 0, registry: '—' }),
    codexStatus: () => ({ label: '—', state: '' }),
  };
  sandbox.window = { Forge: sandbox.Forge };
  vm.createContext(sandbox);
  vm.runInContext(PANELS_SRC, sandbox, { filename: 'panels.js' });
  return { sandbox, document };
}

console.log('forge-stats dashboard panel offline tests (headless vm + DOM stub)');

t('panels.js registers a "stats" dock tab', /\[\s*['"]stats['"]\s*,\s*['"]Stats['"]\s*\]/.test(PANELS_SRC));

// 1) real STATS.json data renders per-Boss rows + the scanned-runs banner
const stats = { ok: true, generated_at: '2026-07-24T21:00:00Z', runs_scanned: 22, perBoss: {
  'build-boss': { dispatched: 15, completed: 43, failed: 0, rework_received: 2, first_pass_rate: 92 },
  'review-boss': { dispatched: 3, completed: 3, failed: 1, rework_received: 0, first_pass_rate: 100 },
} };
const { sandbox: sb1, document: doc1 } = loadPanels({ stats });
t('renderDock + renderStats are exposed', typeof sb1.renderDock === 'function' && typeof sb1.renderStats === 'function');
sb1.STATE.ui.dockTab = 'stats';
sb1.renderDock();
const h1 = doc1.getElementById('dock-body').innerHTML;
t('stats panel shows the runs-scanned banner', h1.includes('22 runs scanned') && h1.includes('2 bosses'));
t('stats panel renders the build-boss row with real numbers', h1.includes('build-boss') && h1.includes('15 disp') && h1.includes('43 done') && h1.includes('2 rework'));
t('stats panel renders first-pass rate', h1.includes('92% 1st-pass') && h1.includes('100% 1st-pass'));
t('stats panel shows a failed count honestly', h1.includes('1 fail'));
t('dock-tabs row includes a Stats button', doc1.getElementById('dock-tabs').innerHTML.includes('>Stats<'));

// 2) loadStatsPanel exists and is wired to fetch /api/stats
t('loadStatsPanel is exposed for the lazy-load path', typeof sb1.loadStatsPanel === 'function');

// 3) honest states: absent STATS.json (server {ok:false,error}) shows the error, never a fabricated stat
const { sandbox: sb2, document: doc2 } = loadPanels({ stats: { ok: false, error: 'no STATS.json yet — run forge-stats.cjs after some runs', perBoss: {} } });
sb2.STATE.ui.dockTab = 'stats'; sb2.renderDock();
const h2 = doc2.getElementById('dock-body').innerHTML;
t('missing STATS.json renders the honest error, no fabricated rows', h2.includes('no STATS.json yet') && !h2.includes('disp'));

// 4) still-loading (null) shows a loading state, not a fabricated one
const { sandbox: sb3, document: doc3 } = loadPanels({ stats: null });
sb3.STATE.ui.dockTab = 'stats'; sb3.renderDock();
t('null stats renders a loading state', doc3.getElementById('dock-body').innerHTML.includes('Loading cross-run stats'));

// 5) ok:true but empty perBoss -> honest "no stats yet", not a blank/fabricated panel
const { sandbox: sb4, document: doc4 } = loadPanels({ stats: { ok: true, runs_scanned: 0, perBoss: {} } });
sb4.STATE.ui.dockTab = 'stats'; sb4.renderDock();
t('empty perBoss renders the honest no-stats state', doc4.getElementById('dock-body').innerHTML.includes('No cross-run stats yet'));

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
