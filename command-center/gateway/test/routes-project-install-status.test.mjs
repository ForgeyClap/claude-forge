// HTTP-level integration tests for build-async-install's GET /api/projects/install-status route,
// against a real instance of the gateway bound to an ephemeral port. Mirrors
// ../test/routes-project-create.test.mjs's own real-server + isolated-temp-root pattern: this suite
// NEVER writes into the real Documents\ForgeProjecten and NEVER spawns a real
// `forge-sync.cjs install` child process — the isolated root makes installForgeInto's own FIXED
// FORGE_PROJECTS_ROOT containment check refuse before anything is ever spawned (same safety
// property ../test/routes-project-create.test.mjs already documents for its own POST tests).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.mjs';
import {
  _setProjectsRootForTests,
  _resetProjectsRootForTests,
  _resetInstallStatusForTests,
} from '../src/projects-create.mjs';
import { request, requestWithBody } from '../test-support/helpers.mjs';

let server;
let port;
let tempRoot;

before(async () => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gateway-install-status-test-'));
  _setProjectsRootForTests(tempRoot);
  server = createServer();
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
});

after(async () => {
  _resetProjectsRootForTests();
  _resetInstallStatusForTests();
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  await new Promise((resolve) => server.close(resolve));
});

function statusUrl(name) {
  return `/api/projects/install-status?name=${encodeURIComponent(name)}`;
}

async function pollUntilTerminal(name, { attempts = 40, delayMs = 25 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    const res = await request(port, statusUrl(name));
    if (res.json && (res.json.state === 'installed' || res.json.state === 'failed')) return res;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`install-status for "${name}" never reached a terminal state within budget`);
}

test('GET /api/projects/install-status?name=<never created> honestly reports state:"unknown" with a note (empty map)', async () => {
  const res = await request(port, statusUrl('Never Created Project'));
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.state, 'unknown');
  assert.equal(res.json.reason, null);
  assert.match(res.json.note, /no install status recorded/);
});

test('GET /api/projects/install-status with an invalid name is rejected with 400 (same allowlist as POST)', async () => {
  const res = await request(port, statusUrl('bad/name!'));
  assert.equal(res.statusCode, 400);
  assert.equal(res.json.ok, false);
  assert.match(res.json.error, /name must match/);
});

test('GET /api/projects/install-status with a missing ?name is rejected with 400', async () => {
  const res = await request(port, '/api/projects/install-status');
  assert.equal(res.statusCode, 400);
  assert.equal(res.json.ok, false);
  assert.match(res.json.error, /non-empty string/);
});

test('GET /api/projects/install-status with a traversal payload as name is rejected with 400, never treated as containment-ok', async () => {
  const res = await request(port, statusUrl('../../evil'));
  assert.equal(res.statusCode, 400);
  assert.equal(res.json.ok, false);
  assert.match(res.json.error, /name must match/);
});

test('POST /api/projects then GET install-status: real name-keyed wiring reaches "installing" then honestly settles to "failed" (isolated root, containment refusal, zero real spawns)', async () => {
  const name = 'Status Wiring Project';
  const created = await requestWithBody(port, '/api/projects', { jsonBody: { name } });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json.ok, true);
  // build-async-install: the POST body no longer carries the installer's outcome at all — the
  // dashboard learns it only from this GET route.
  assert.equal('forge_installed' in created.json, false);
  assert.equal('forge_install_reason' in created.json, false);

  const settled = await pollUntilTerminal(name);
  assert.equal(settled.statusCode, 200);
  assert.equal(settled.json.ok, true);
  assert.equal(settled.json.state, 'failed');
  assert.match(settled.json.reason, /outside the real Forge projects root/);
  assert.equal(typeof settled.json.started_at, 'string');
  assert.equal(typeof settled.json.finished_at, 'string');
});
