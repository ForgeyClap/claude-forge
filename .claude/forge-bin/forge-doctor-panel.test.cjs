#!/usr/bin/env node
'use strict';
/** Offline, headless test for the WP7 Doctor dashboard panel (forge-dashboard/panels.js). Loads the REAL
 *  panels.js in a Node vm with a minimal DOM/global stub and drives the ACTUAL DOCK_TABS/renderDock() path
 *  — a pass proves the shipped 'doctor' panel renders correctly. Pure in-memory; never touches the project. */
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
  const statusLabel = (s) => ({ done: 'COMPLETED', running: 'RUNNING', failed: 'FAILED', waiting: 'WAITING', previewing: 'PREVIEWING', internal: 'INTERNAL ONLY' }[s] || 'WAITING');
  const STATE = Object.assign({
    meta: { name: '—', port: '' }, run: {}, events: [], report: null, memory: {}, runs: 0, malformed: 0,
    settings: { polling_interval_ms: 250, fast_mode: false, auto_scroll_logs: true },
    _nodes: [], _prevCount: 0, eccMode: { normal: 'on', full_test: 'off' }, session: { mode: 'off' },
    bosses: [], prds: [], mindmaps: [], tickets: [], artifacts: [], doctor: null,
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

console.log('forge-doctor dashboard panel offline tests (headless vm + DOM stub)');

t('panels.js registers a "doctor" dock tab', /\[\s*['"]doctor['"]\s*,\s*['"]Doctor['"]\s*\]/.test(PANELS_SRC));

// 1) an ALL-GREEN doctor result renders each check as PASS
const green = { run_id: 'forge-2026-07-10', ok: true, generated_at: '2026-07-10T00:00:00Z',
  node_check: { ok: true, total: 34 }, tests: { ok: true, passed: 306, failed: 0, suites: 15 },
  strict_events: { ok: true }, dashboard_spa: { ok: true }, leak_scan: { ok: true, scanned: 87, hits: 0 } };
const { sandbox: sb1, document: doc1 } = loadPanels({ doctor: green });
t('renderDock is exposed', typeof sb1.renderDock === 'function');
sb1.STATE.ui.dockTab = 'doctor';
sb1.renderDock();
const h1 = doc1.getElementById('dock-body').innerHTML;
t('doctor panel shows ALL GREEN banner', h1.includes('ALL GREEN') && h1.includes('forge-2026-07-10'));
t('doctor panel renders the tests tally (306 passed)', h1.includes('306') && h1.includes('15 suites'));
t('doctor panel renders 5 rows all PASS', (h1.match(/>PASS</g) || []).length === 5);
t('doctor panel has no FAIL pill when all green', !h1.includes('>FAIL<'));
t('dock-tabs row includes a Doctor button', doc1.getElementById('dock-tabs').innerHTML.includes('>Doctor<'));

// 2) a failing leak scan renders a FAIL row + FAILURES banner (honest, not hidden)
const red = Object.assign({}, green, { ok: false, leak_scan: { ok: false, scanned: 90, hits: 2 } });
const { sandbox: sb2, document: doc2 } = loadPanels({ doctor: red });
sb2.STATE.ui.dockTab = 'doctor'; sb2.renderDock();
const h2 = doc2.getElementById('dock-body').innerHTML;
t('doctor panel shows FAILURES banner when a check fails', h2.includes('FAILURES'));
t('doctor panel shows a FAIL pill for the failing leak scan', h2.includes('>FAIL<') && h2.includes('2 hit(s)'));

// 3) no doctor run -> honest empty state, never a fabricated result
const { sandbox: sb3, document: doc3 } = loadPanels({ doctor: null });
sb3.STATE.ui.dockTab = 'doctor'; sb3.renderDock();
const h3 = doc3.getElementById('dock-body').innerHTML;
t('null doctor renders the honest empty state', h3.includes('No doctor run yet'));
t('empty doctor does not fabricate a PASS', !h3.includes('>PASS<'));

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
