#!/usr/bin/env node
'use strict';
// forge-waterfall.test.cjs — headless test for the WATERFALL/GANTT lens (2026-07-11).
// Loads the REAL app.js + lenses.js into one vm context (same globals index.html gives them) and drives
// window.Forge.LENSES.waterfall.build() with sample timestamped events, asserting spans are laid out in
// per-Boss swimlanes positioned by real time. Proves the SHIPPED lens behaves this way, not a reimpl.
// Convention: prints "<N> passed, <M> failed"; exit non-zero on any failure.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DASH = path.join(__dirname, '..', 'forge-dashboard');
const APP = fs.readFileSync(path.join(DASH, 'app.js'), 'utf8');
const LENS = fs.readFileSync(path.join(DASH, 'lenses.js'), 'utf8');

function makeEl() { return { innerHTML: '', textContent: '', className: '', hidden: false, style: {}, dataset: {}, scrollHeight: 0, scrollTop: 0, clientHeight: 0, addEventListener() {}, appendChild() {}, setAttribute() {} }; }
const document = { getElementById() { return makeEl(); }, querySelectorAll() { return []; }, createElement() { return makeEl(); }, addEventListener() {} };
const sandbox = { document, console, setTimeout, setInterval, clearTimeout, clearInterval, requestAnimationFrame: () => 0, EventSource: function () { this.addEventListener = () => {}; }, location: { search: '' }, URLSearchParams, fetch: () => Promise.reject(new Error('no net')) };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(APP, sandbox, { filename: 'app.js' });
vm.runInContext(LENS, sandbox, { filename: 'lenses.js' });

let pass = 0, fail = 0;
const t = (n, c) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n); } };

console.log('forge waterfall/gantt lens tests (headless vm, real app.js + lenses.js)');
const F = sandbox.window.Forge;
const events = [
  { agent: 'Build Boss', event_type: 'agent_started', timestamp: '2026-07-11T00:00:00Z' },
  { agent: 'Build Boss', event_type: 'agent_completed', timestamp: '2026-07-11T00:00:10Z' },
  { agent: 'Test Boss', event_type: 'check_started', task: 'e2e', timestamp: '2026-07-11T00:00:05Z' },
  { agent: 'Test Boss', event_type: 'check_passed', task: 'e2e', timestamp: '2026-07-11T00:00:20Z' },
];

t('waterfall lens is registered', !!(F && F.LENSES && F.LENSES.waterfall));
t('waterfall is in LENS_ORDER', F.LENS_ORDER.includes('waterfall'));
const m = F.LENSES.waterfall.build({ events, run: {}, agents: [] });
t('returns nodes + edges + a sized world', Array.isArray(m.nodes) && Array.isArray(m.edges) && m.world && m.world.w > 0 && m.world.h > 0);
t('2 Boss lanes -> 2 lane-labels + 2 bars = 4 nodes', m.nodes.length === 4);
const bBar = m.nodes.find((n) => n.id === 'wf:Build Boss:0');
const tBar = m.nodes.find((n) => n.id === 'wf:Test Boss:0');
t('earliest span starts at the left gutter (PAD_X=150)', bBar && bBar.x === 150);
t('a later span is positioned further right on the time axis', tBar && tBar.x > 150);
t('Build Boss span duration reads 10.0s', bBar && bBar.sub === '10.0s');
t('Test Boss span duration reads 15.0s', tBar && tBar.sub === '15.0s');
t('a check_passed span is marked done', tBar && tBar.state === 'done');
t('bars carry refKey for inspector wiring', bBar && bBar.refKey === 'Build Boss');
t('empty events -> empty model (no crash)', (() => { const e = F.LENSES.waterfall.build({ events: [], run: {}, agents: [] }); return e && Array.isArray(e.nodes); })());

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
