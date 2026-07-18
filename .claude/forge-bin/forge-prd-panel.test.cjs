#!/usr/bin/env node
'use strict';
/** Offline, headless test for the WP3 PRD dashboard panel (forge-dashboard/panels.js). No prior
 *  panels3456-test.cjs/agentboard-test.cjs file exists in this template to mirror line-for-line, so
 *  this harness builds the minimal DOM/global stub panels.js actually needs (same globals app.js
 *  defines before panels.js loads in index.html: $, esc, STATE, etc.) and loads the REAL panels.js
 *  source in a Node vm context — it exercises the ACTUAL DOCK_TABS/renderDock() code path, not a
 *  reimplementation, so a pass here proves the shipped panel renders correctly.
 *  Never touches the real project; pure in-memory. Exit 0 = all pass. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };

const PANELS_PATH = path.join(__dirname, '..', 'forge-dashboard', 'panels.js');
const PANELS_SRC = fs.readFileSync(PANELS_PATH, 'utf8');

function makeEl() { return { innerHTML: '', textContent: '', className: '', hidden: false, style: {}, dataset: {}, scrollHeight: 0, scrollTop: 0, clientHeight: 0 }; }

// Loads a fresh copy of panels.js into its own vm context (new context per call -> no top-level
// const/let redeclaration clashes across calls) with a minimal document + global stub.
function loadPanels(initialState) {
  const elements = new Map();
  const document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, makeEl()); return elements.get(id); },
    querySelectorAll() { return []; },
    createElement() { return makeEl(); },
  };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const pad2 = (n) => (n < 10 ? '0' + n : '' + n);
  const hhmmss = (iso) => { try { const d = new Date(iso); if (Number.isNaN(d.getTime())) return ''; return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()); } catch { return ''; } };
  const trunc = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const fileName = (f) => !f ? '' : (typeof f === 'string' ? f : (f.file || ''));
  const statusLabel = (s) => ({ done: 'COMPLETED', running: 'RUNNING', failed: 'FAILED', waiting: 'WAITING', previewing: 'PREVIEWING', internal: 'INTERNAL ONLY' }[s] || 'WAITING');
  const STATE = Object.assign({
    meta: { name: '—', port: '' }, run: {}, events: [], report: null, memory: {}, runs: 0, malformed: 0,
    settings: { polling_interval_ms: 250, fast_mode: false, auto_scroll_logs: true },
    _nodes: [], _prevCount: 0, eccMode: { normal: 'on', full_test: 'off' }, session: { mode: 'off' },
    bosses: [], prds: [],
    replay: { active: false, playing: false, cursor: 0, speed: 1 },
    ui: { insTab: 'summary', actFilter: 'all', dockTab: 'log', collapsed: new Set() },
  }, initialState || {});
  const Forge = {};
  const sandbox = {
    document, console, STATE, Forge,
    $: (id) => document.getElementById(id), esc, trunc, hhmmss, fileName, statusLabel,
    SYNTH: {}, GROUP_ORDER: [], GROUP_LABEL: {}, selRef: { refKey: null, refEvIdx: null },
    agentColor: () => ({ solid: '#fff', glyph: '' }),
    isSubagentNode: () => false,
    progress: () => 0, ago: () => '—',
    eccSummary: () => ({ state: 'off', normal: 'on', full_test: 'off', attempted: false, selected: [], invoked: [], skills: [], nativeFallback: false }),
    governanceSummary: () => ({ claudeMd: '—', skills: [], created: 0, used: 0, registry: '—' }),
    codexStatus: () => ({ label: '—', state: '' }),
  };
  sandbox.window = { Forge: sandbox.Forge };
  vm.createContext(sandbox);
  vm.runInContext(PANELS_SRC, sandbox, { filename: 'panels.js' });
  return { sandbox, document };
}

console.log('forge-prd dashboard panel offline tests (headless vm + DOM stub)');

t('panels.js source registers a "prd" dock tab', /\[\s*['"]prd['"]\s*,\s*['"]PRD['"]\s*\]/.test(PANELS_SRC));

// 1) one real PRD -> the 'prd' dock tab (via the ACTUAL renderDock()) shows title + acceptance count
const prdRow = { prd_id: 'prd-demo-001', title: 'Forge Mission Control Phase 2', project: 'demo-project', created: '2026-07-10T12:00:00.000Z', sections_present: ['goal', 'acceptance_criteria'], acceptance_count: 3 };
const { sandbox: sb1, document: doc1 } = loadPanels({ prds: [prdRow] });
t('renderDock is exposed by panels.js', typeof sb1.renderDock === 'function');
sb1.STATE.ui.dockTab = 'prd';
sb1.renderDock();
const html1 = doc1.getElementById('dock-body').innerHTML;
t('prd panel renders the PRD title', html1.includes('Forge Mission Control Phase 2'));
t('prd panel renders the acceptance-criteria count (3)', /\b3\b/.test(html1) && /AC/.test(html1));
t('prd panel does not render the empty-state text when a PRD exists', !html1.includes('No PRDs yet'));
t('dock-tabs row includes a PRD button', doc1.getElementById('dock-tabs').innerHTML.includes('>PRD<'));

// 2) empty state.prds -> honest empty-state text, never a crash, never a fake row
const { sandbox: sb2, document: doc2 } = loadPanels({ prds: [] });
sb2.STATE.ui.dockTab = 'prd';
sb2.renderDock();
const html2 = doc2.getElementById('dock-body').innerHTML;
t('empty state.prds renders the honest empty-state message', html2.includes('No PRDs yet — generate one with forge-prd.'));
t('empty state does not fabricate a PRD row', !html2.includes('prd-demo-001'));

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
