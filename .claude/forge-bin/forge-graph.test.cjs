#!/usr/bin/env node
'use strict';
// forge-graph.test.cjs — tests the orchestration DAG loader + traversal (2026-07-11).
const assert = require('assert');
const g = require('./forge-graph.cjs');

let passed = 0, failed = 0;
function t(name, fn) { try { fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); } }

console.log('forge orchestration-DAG tests');
const graph = g.loadGraph();

t('the shipped forge-graph.json is valid', () => { const v = g.validateGraph(graph); assert.ok(v.ok, v.errors.join('; ')); });
t('start node is defined', () => assert.ok(graph.nodes.some((n) => n.id === graph.start)));
t('test-boss PASS -> review-boss', () => assert.deepStrictEqual(g.nextNodes(graph, 'test-boss', 'pass').map((x) => x.to), ['review-boss']));
t('test-boss FAIL -> build-boss (rework edge)', () => { const nx = g.nextNodes(graph, 'test-boss', 'fail'); assert.ok(nx.length === 1 && nx[0].to === 'build-boss' && nx[0].kind === 'rework'); });
t('review-boss FAIL -> head-chef (rework)', () => assert.strictEqual(g.nextNodes(graph, 'review-boss', 'fail')[0].to, 'head-chef'));
t('docs-boss PASS -> done (terminal)', () => assert.strictEqual(g.nextNodes(graph, 'docs-boss', 'pass')[0].to, 'done'));
t('resumeNode: with boss+head-chef done -> build-boss', () => assert.strictEqual(g.resumeNode(graph, ['boss', 'head-chef']), 'build-boss'));
t('resumeNode: nothing done -> the start node', () => assert.strictEqual(g.resumeNode(graph, []), graph.start));
t('validateGraph catches an edge to an unknown node', () => { const bad = { start: 'a', nodes: [{ id: 'a' }], edges: [{ from: 'a', to: 'ghost', on: 'pass' }] }; const v = g.validateGraph(bad); assert.ok(!v.ok && v.errors.some((e) => /ghost/.test(e))); });
t('validateGraph catches a dead-end (no outgoing edge)', () => { const bad = { start: 'a', nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ from: 'a', to: 'b', on: 'pass' }] }; const v = g.validateGraph(bad); assert.ok(!v.ok && v.errors.some((e) => /"b"/.test(e))); });

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
