#!/usr/bin/env node
'use strict';
/**
 * forge-graph.cjs — executable orchestration DAG (2026-07-11, LATER tier). Loads config/orchestration/
 * forge-graph.json (Boss loop as nodes + pass/fail/rework edges) and provides deterministic, resumable
 * control: given the current node + gate outcome, which node(s) run next; validate the graph; find the
 * resume node from a set of completed nodes. Pure logic — the Lead executes the actual Boss dispatches.
 *
 * CLI: node forge-graph.cjs — no arguments; loads and validates forge-graph.json, prints a one-line
 *      node/edge/validity summary, and exits 0 (valid) or 1 (invalid). Everything else here is a library
 *      of pure helpers (loadGraph/validateGraph/nextNodes/resumeNode) for the Lead's own dispatch loop.
 */
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = process.env.FORGE_PROJECT_ROOT ? path.resolve(process.env.FORGE_PROJECT_ROOT) : path.resolve(__dirname, '..', '..');
const GRAPH_PATH = path.join(PROJECT_ROOT, '.claude', 'config', 'orchestration', 'forge-graph.json');

function loadGraph(p) { return JSON.parse(fs.readFileSync(p || GRAPH_PATH, 'utf8')); }

function validateGraph(graph) {
  const errors = [];
  if (!graph || !Array.isArray(graph.nodes) || !graph.nodes.length) return { ok: false, errors: ['no nodes'] };
  const ids = graph.nodes.map((n) => n.id);
  const set = new Set(ids);
  if (set.size !== ids.length) errors.push('duplicate node ids');
  if (graph.start && !set.has(graph.start)) errors.push('start node "' + graph.start + '" not defined');
  for (const e of (graph.edges || [])) {
    if (!set.has(e.from)) errors.push('edge from unknown node "' + e.from + '"');
    if (!set.has(e.to)) errors.push('edge to unknown node "' + e.to + '"');
    if (e.on && !['pass', 'fail'].includes(e.on)) errors.push('edge ' + e.from + '->' + e.to + ' has bad on="' + e.on + '"');
  }
  // every non-terminal node should have an outgoing pass edge (else the flow dead-ends)
  for (const n of graph.nodes) { if (n.type === 'terminal') continue; if (!(graph.edges || []).some((e) => e.from === n.id)) errors.push('node "' + n.id + '" has no outgoing edge'); }
  return { ok: errors.length === 0, errors };
}

// Next node id(s) from `nodeId` given a gate `outcome` ('pass'|'fail'); an edge with no `on` matches any.
function nextNodes(graph, nodeId, outcome) {
  return (graph.edges || []).filter((e) => e.from === nodeId && (!e.on || e.on === outcome)).map((e) => ({ to: e.to, kind: e.kind || 'flow' }));
}

// Given completed node ids, the resume node = the first node on the start→done pass-path not yet completed.
function resumeNode(graph, completed) {
  const done = new Set(completed || []);
  let cur = graph.start || (graph.nodes[0] && graph.nodes[0].id);
  const seen = new Set();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    if (!done.has(cur)) return cur;
    const nx = nextNodes(graph, cur, 'pass').filter((n) => n.to !== 'done');
    cur = nx.length ? nx[0].to : null;
  }
  return null; // all done
}

module.exports = { loadGraph, validateGraph, nextNodes, resumeNode, GRAPH_PATH };

if (require.main === module) {
  const g = loadGraph();
  const v = validateGraph(g);
  console.log('forge-graph: ' + g.nodes.length + ' nodes, ' + (g.edges || []).length + ' edges · ' + (v.ok ? 'VALID' : 'INVALID: ' + v.errors.join('; ')));
  console.log('start=' + g.start + ' · test-boss FAIL -> ' + JSON.stringify(nextNodes(g, 'test-boss', 'fail')));
  process.exit(v.ok ? 0 : 1);
}
