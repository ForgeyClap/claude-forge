// HTTP-level integration tests for the 3 new WP6 JSON endpoints (/api/tools, /api/mcp,
// /api/capabilities) plus T6.7's cross-endpoint secret-boundary scan — same pattern as the
// existing routes-wp3.test.mjs (left untouched; it is itself the regression proof for the WP3
// endpoints).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from '../src/server.mjs';
import { PROJECT_ROOT } from '../src/paths.mjs';
import { _resetProjectsCacheForTests } from '../src/projects.mjs';
import { _resetToolsCacheForTests } from '../src/tools.mjs';
import { _resetCapabilitiesCacheForTests } from '../src/capabilities.mjs';
import { request } from '../test-support/helpers.mjs';

const THIS_PROJECT_NAME = path.basename(PROJECT_ROOT);
const RUN_ID = 'forge-2026-07-26-command-center';

let server;
let port;

before(async () => {
  _resetProjectsCacheForTests();
  _resetToolsCacheForTests();
  _resetCapabilitiesCacheForTests();
  server = createServer();
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('GET /api/tools returns the real forge-bin tool inventory', async () => {
  const res = await request(port, '/api/tools?project=' + encodeURIComponent(THIS_PROJECT_NAME));
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.ok, true);
  assert.ok(res.json.tools_count >= 60);
  assert.ok(res.json.tools.some((t) => t.name === 'forge-doctor.cjs' && t.has_test === true));
});

test('GET /api/mcp returns the real dormant 8-server MCP registry', async () => {
  const res = await request(port, '/api/mcp?project=' + encodeURIComponent(THIS_PROJECT_NAME));
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.servers_count, 8);
  assert.equal(res.json.installed_count, 0);
  assert.ok(res.json.servers.every((s) => s.status === 'not-installed'));
});

test('GET /api/capabilities runs the real report and returns real capabilities + summary', async () => {
  const res = await request(port, '/api/capabilities?project=' + encodeURIComponent(THIS_PROJECT_NAME));
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.available, true);
  assert.ok(res.json.capabilities.length >= 100);
  assert.ok(res.json.summary && typeof res.json.summary.total === 'number');
});

test('SECURITY: /api/tools with an unknown project never reaches the filesystem', async () => {
  const res = await request(port, '/api/tools?project=totally-not-real');
  assert.equal(res.statusCode, 404);
});

test('SECURITY: /api/mcp with a path-traversal project name is rejected by the allowlist', async () => {
  const res = await request(port, '/api/mcp?project=' + encodeURIComponent('../../'));
  assert.equal(res.statusCode, 404);
});

test('SECURITY: /api/capabilities with an unknown project never spawns anything', async () => {
  const res = await request(port, '/api/capabilities?project=totally-not-real');
  assert.equal(res.statusCode, 404);
});

// ── T6.7: the browser must NEVER receive a secret, from ANY endpoint ──────────────────────────
// Real credential shapes this project's own docs/config explicitly warn about (NVIDIA, generic
// "sk-" style keys, GitHub personal access tokens, AWS access key ids). This scans the RAW response
// body text of every endpoint below (not a parsed/re-serialized copy) against real, populated data.
const SECRET_PATTERNS = [
  { name: 'nvidia api key', re: /nvapi-[A-Za-z0-9_-]{10,}/ },
  { name: 'generic sk- style key', re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: 'github personal access token', re: /\bghp_[A-Za-z0-9]{10,}/ },
  { name: 'aws access key id', re: /\bAKIA[A-Z0-9]{10,}/ },
];

function assertNoSecrets(label, bodyText) {
  for (const p of SECRET_PATTERNS) {
    assert.doesNotMatch(bodyText, p.re, label + ' response body must never contain a ' + p.name);
  }
}

test('SECRET BOUNDARY: no response body from any real, populated endpoint contains a secret-shaped string', async () => {
  const projectQ = 'project=' + encodeURIComponent(THIS_PROJECT_NAME);
  const endpoints = [
    '/api/health',
    '/api/projects',
    '/api/runs?' + projectQ,
    '/api/events?' + projectQ + '&run=' + RUN_ID + '&after=0',
    '/api/missions?' + projectQ + '&run=' + RUN_ID,
    '/api/agents?' + projectQ,
    '/api/skills?' + projectQ,
    '/api/tools?' + projectQ,
    '/api/mcp?' + projectQ,
    '/api/models',
    '/api/capabilities?' + projectQ,
    '/api/proof?' + projectQ + '&run=' + RUN_ID,
    '/api/usage',
    '/api/conversations',
  ];

  for (const urlPath of endpoints) {
    const res = await request(port, urlPath);
    assert.equal(res.statusCode, 200, urlPath + ' must return 200 for this scan to be meaningful');
    assertNoSecrets(urlPath, res.body);
  }
});
