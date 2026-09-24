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

// Hermetic-by-default (2026-09-24, loop wp-l1): the SECRET BOUNDARY test below hits /api/models too, which
// runs the SAME real nvidia-provider.cjs health probe as models.test.mjs/routes-wp3.test.mjs (see either
// file's own comment) — the server here runs IN-PROCESS, so a child spawned by its route handler inherits
// THIS process's env. Force a hermetic child env for the whole file by default (no dotenv-file loading, no
// key); set FORGE_GATEWAY_LIVE_NVIDIA=1 to opt into the real, live-network variant instead. Never changes
// what any test here asserts about response shape.
const LIVE_NVIDIA = process.env.FORGE_GATEWAY_LIVE_NVIDIA === '1';
const HERMETIC_NVIDIA_ENV_NAMES = ['NVIDIA_API_KEY', 'NVIDIA_SKIP_ENV_FILES'];
let savedNvidiaEnv = null;

before(async () => {
  _resetProjectsCacheForTests();
  _resetToolsCacheForTests();
  _resetCapabilitiesCacheForTests();
  if (!LIVE_NVIDIA) {
    savedNvidiaEnv = Object.fromEntries(HERMETIC_NVIDIA_ENV_NAMES.map((k) => [k, process.env[k]]));
    process.env.NVIDIA_API_KEY = '';
    process.env.NVIDIA_SKIP_ENV_FILES = '1';
  }
  server = createServer();
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  if (savedNvidiaEnv) { for (const [k, v] of Object.entries(savedNvidiaEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
});

test('GET /api/tools returns the real forge-bin tool inventory', async () => {
  const res = await request(port, '/api/tools?project=' + encodeURIComponent(THIS_PROJECT_NAME));
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.ok, true);
  assert.ok(res.json.tools_count >= 60);
  assert.ok(res.json.tools.some((t) => t.name === 'forge-doctor.cjs' && t.has_test === true));
});

// BIJGEWERKT (audit-reconciliatie 2026-08-06): deze test codificeerde het 8-server-register van vóór
// 2026-08-04 — de MCP-drift-fix registreerde toen de ECHT draaiende claude-flow en n8n (status
// 'connected' = werkelijkheid, geen toestemming). De echte invariant is niet "alles not-installed"
// maar "nooit pre-ACTIVATED": elke server is not-installed OF eerlijk connected, nooit activated.
// BIJGEWERKT (loop wp-l1/wp-l3, 2026-09-24): Integration Boss registreerde n8n-mcp als dormant tier-1
// not-installed entry (wp-l3, .claude/forge-runs/forge-2026-09-24-loop-deeplearn/events.jsonl seq 12) —
// het echte, settled register telt nu 11 servers, nog steeds nooit pre-activated.
test('GET /api/mcp returns the real MCP registry (11 servers, none pre-activated)', async () => {
  const res = await request(port, '/api/mcp?project=' + encodeURIComponent(THIS_PROJECT_NAME));
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.servers_count, 11);
  assert.ok(res.json.servers.some((s) => s.id === 'claude-flow' && s.status === 'connected'));
  assert.ok(res.json.servers.some((s) => s.id === 'n8n' && s.status === 'connected'));
  assert.ok(res.json.servers.every((s) => s.status === 'not-installed' || s.status === 'connected'), 'geen enkele server mag pre-activated zijn');
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
