#!/usr/bin/env node
'use strict';
// forge-mcp.test.cjs — tests the read-only Forge MCP server (JSON-RPC handlers + tools + resources +
// isolation). Uses the module exports (handle/callTool/listResources/readResource) so it is deterministic;
// PROJECT_ROOT resolves to the template (forge-mcp.cjs __dirname/../..), which has real forge-runs.
// Convention: prints "<N> passed, <M> failed"; exit non-zero on any failure.
const assert = require('assert');
const mcp = require('./forge-mcp.cjs');

let passed = 0, failed = 0;
function t(name, fn) { try { fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); } }
// capture the last JSON-RPC line handle() writes to stdout
function cap(fn) { const orig = process.stdout.write; let out = ''; process.stdout.write = (s) => { out += s; return true; }; try { fn(); } finally { process.stdout.write = orig; } const lines = out.trim().split('\n').filter(Boolean); return lines.length ? JSON.parse(lines[lines.length - 1]) : null; }

console.log('forge MCP server tests (read-only, isolation-guarded)');

t('exposes exactly the 4 read-only tools', () => { assert.strictEqual(mcp.TOOLS.length, 4); assert.deepStrictEqual(mcp.TOOLS.map((x) => x.name).sort(), ['forge_get_run', 'forge_list_runs', 'forge_read_report', 'forge_status']); });

t('initialize returns serverInfo + tools/resources capabilities', () => {
  const r = cap(() => mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
  assert.strictEqual(r.result.serverInfo.name, 'forge');
  assert.ok(r.result.capabilities.tools && r.result.capabilities.resources);
  assert.ok(r.result.protocolVersion);
});

t('notifications/initialized produces NO reply (it is a notification)', () => {
  const r = cap(() => mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  assert.strictEqual(r, null);
});

t('tools/list returns the tool schemas', () => {
  const r = cap(() => mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
  assert.strictEqual(r.result.tools.length, 4);
  assert.ok(r.result.tools.every((x) => x.inputSchema && x.inputSchema.type === 'object'));
});

t('tools/call forge_status returns a text content block', () => {
  const r = cap(() => mcp.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'forge_status', arguments: {} } }));
  assert.ok(Array.isArray(r.result.content) && r.result.content[0].type === 'text');
  const data = JSON.parse(r.result.content[0].text);
  assert.ok(typeof data.project === 'string' && typeof data.total_runs === 'number');
});

t('forge_list_runs returns a runs array', () => {
  const data = mcp.callTool('forge_list_runs', {});
  assert.ok(Array.isArray(data.runs));
});

t('forge_get_run rejects a traversal run_id', () => {
  const r = cap(() => mcp.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'forge_get_run', arguments: { run_id: '../secrets' } } }));
  assert.ok(r.result.isError === true);
});

t('resources/list enumerates run + memory resources with forge:// uris', () => {
  const res = mcp.listResources();
  assert.ok(Array.isArray(res));
  assert.ok(res.every((x) => /^forge:\/\//.test(x.uri)));
});

t('resources/read rejects a path-traversal uri', () => {
  const r = cap(() => mcp.handle({ jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: 'forge://run/..%2f..%2fetc/run.json' } }));
  assert.ok(r.error && r.error.code === -32602);
});

t('every listed resource actually reads back (no dangling uris)', () => {
  const res = mcp.listResources();
  if (!res.length) { assert.ok(true); return; } // no runs/memory in template → vacuously ok
  for (const r of res.slice(0, 10)) { const out = mcp.readResource(r.uri); assert.ok(typeof out.text === 'string' && out.uri === r.uri, 'dangling resource: ' + r.uri); }
});

t('unknown method returns method-not-found', () => {
  const r = cap(() => mcp.handle({ jsonrpc: '2.0', id: 6, method: 'no/such/method' }));
  assert.ok(r.error && r.error.code === -32601);
});

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
