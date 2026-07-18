#!/usr/bin/env node
'use strict';
/** Offline, headless test for the WP4 "MIND MAP" dashboard lens (forge-dashboard/lenses.js). Loads the
 *  REAL lenses.js source in a Node vm context (same technique as forge-prd-panel.test.cjs for panels.js)
 *  so a pass here proves the shipped lens's build()/radial() code actually behaves, not a reimplementation.
 *  Never touches the real project; pure in-memory. Exit 0 = all pass. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };

const LENSES_PATH = path.join(__dirname, '..', 'forge-dashboard', 'lenses.js');
const LENSES_SRC = fs.readFileSync(LENSES_PATH, 'utf8');

// Loads a fresh copy of lenses.js into its own vm context (new context per call -> no top-level
// const/let redeclaration clashes across calls). lenses.js only needs a `window` object to attach
// `window.Forge` to — it does not touch the DOM.
function loadLenses() {
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(LENSES_SRC, sandbox, { filename: 'lenses.js' });
  return sandbox.window.Forge;
}

console.log('forge-mindmap dashboard lens offline tests (headless vm)');

t('lenses.js source registers a "mindmap" lens id', /mindmap:\s*\{\s*id:\s*['"]mindmap['"]/.test(LENSES_SRC));
t('lenses.js exports a radial() layout fn', /radial\s*[,}]/.test(LENSES_SRC));

const Forge = loadLenses();
t('window.Forge.LENSES.mindmap is defined', !!(Forge && Forge.LENSES && Forge.LENSES.mindmap));
t('window.Forge.LENS_ORDER includes "mindmap" right after "taskgraph"',
  !!(Forge && Forge.LENS_ORDER && Forge.LENS_ORDER.indexOf('mindmap') === Forge.LENS_ORDER.indexOf('taskgraph') + 1));
t('window.Forge.radial is exported', typeof (Forge && Forge.radial) === 'function');

// 1) a real stored mind map (root + 3 children) -> 4 nodes, root near world center, children distinct
//    positions (no stacking), positive world size.
const ctxWithData = {
  mindmaps: [{
    map_id: 'm1',
    nodes: [
      { id: 'root', label: 'R', kind: 'root' },
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
      { id: 'c', label: 'C' },
    ],
    edges: [{ from: 'root', to: 'a' }, { from: 'root', to: 'b' }, { from: 'root', to: 'c' }],
  }],
};
const model = Forge.LENSES.mindmap.build(ctxWithData);
t('build() returns 4 nodes for a root + 3 children map', model.nodes.length === 4);
t('build() returns 3 edges', model.edges.length === 3);
t('world.w and world.h are positive', model.world && model.world.w > 0 && model.world.h > 0);

const rootNode = model.nodes.find((n) => n.id === 'mm:root');
const children = model.nodes.filter((n) => n.id !== 'mm:root');
t('the root node is present', !!rootNode);
const rootCx = rootNode.x + rootNode.w / 2, rootCy = rootNode.y + rootNode.h / 2;
const worldCx = model.world.w / 2, worldCy = model.world.h / 2;
t('the root is at (or very near) the world center', Math.abs(rootCx - worldCx) < 1 && Math.abs(rootCy - worldCy) < 1);

t('the 3 children have DISTINCT (x,y) positions (no stacking)', (() => {
  const seen = new Set();
  for (const n of children) { const key = Math.round(n.x) + ',' + Math.round(n.y); if (seen.has(key)) return false; seen.add(key); }
  return seen.size === children.length;
})());
t('no child sits exactly on top of the root', children.every((n) => Math.abs((n.x + n.w / 2) - rootCx) > 1 || Math.abs((n.y + n.h / 2) - rootCy) > 1));

// 2) empty ctx.mindmaps -> honest empty model (0 nodes), never a crash
const emptyModel = Forge.LENSES.mindmap.build({ mindmaps: [] });
t('build() with no stored mind maps returns 0 nodes (honest empty, not a crash)', Array.isArray(emptyModel.nodes) && emptyModel.nodes.length === 0);
t('build() with no stored mind maps returns 0 edges', Array.isArray(emptyModel.edges) && emptyModel.edges.length === 0);
t('build() with missing ctx.mindmaps (undefined) never throws', (() => { try { const m = Forge.LENSES.mindmap.build({}); return Array.isArray(m.nodes) && m.nodes.length === 0; } catch { return false; } })());

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
