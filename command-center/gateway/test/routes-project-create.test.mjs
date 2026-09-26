// HTTP-level integration tests for build-newproject's POST /api/projects route, against a real
// instance of the gateway bound to an ephemeral port. `_setProjectsRootForTests` points every
// creation at an isolated temp dir — this suite NEVER writes into the real
// Documents\ForgeProjects.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.mjs';
import { _setProjectsRootForTests, _resetProjectsRootForTests } from '../src/projects-create.mjs';
import { request, requestWithBody } from '../test-support/helpers.mjs';

let server;
let port;
let tempRoot;

before(async () => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gateway-newproject-test-'));
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
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  await new Promise((resolve) => server.close(resolve));
});

test('POST /api/projects creates a real project directory with the forge-dashboard marker and a CLAUDE.md', async () => {
  const res = await requestWithBody(port, '/api/projects', { jsonBody: { name: 'Test Project' } });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.project.name, 'Test Project');

  const target = path.join(tempRoot, 'Test Project');
  assert.equal(fs.existsSync(target), true);
  assert.equal(fs.statSync(path.join(target, '.claude', 'forge-dashboard')).isDirectory(), true);
  const claudeMd = fs.readFileSync(path.join(target, 'CLAUDE.md'), 'utf8');
  assert.match(claudeMd, /Test Project/);
  assert.match(claudeMd, /New project/);
});

test('POST /api/projects with a name that already exists on disk is rejected with 409', async () => {
  const first = await requestWithBody(port, '/api/projects', { jsonBody: { name: 'Duplicate Project' } });
  assert.equal(first.statusCode, 201);

  const second = await requestWithBody(port, '/api/projects', { jsonBody: { name: 'Duplicate Project' } });
  assert.equal(second.statusCode, 409);
  assert.equal(second.json.ok, false);
  assert.match(second.json.error, /already exists/);
});

test('POST /api/projects with an invalid name (bad characters) is rejected with 400', async () => {
  const res = await requestWithBody(port, '/api/projects', { jsonBody: { name: 'bad/name!' } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json.ok, false);
  assert.match(res.json.error, /name must match/);
  assert.equal(fs.existsSync(path.join(tempRoot, 'bad', 'name!')), false);
});

test('TRAVERSAL: POST /api/projects with a "../" traversal payload as name is rejected with 400, nothing escapes the temp root', async () => {
  const res = await requestWithBody(port, '/api/projects', { jsonBody: { name: '../../evil' } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json.ok, false);
  assert.equal(fs.existsSync(path.join(tempRoot, '..', '..', 'evil')), false);
});

test('SCHEMA: POST /api/projects missing the required name field is rejected with 400', async () => {
  const res = await requestWithBody(port, '/api/projects', { jsonBody: {} });
  assert.equal(res.statusCode, 400);
  assert.match(res.json.error, /missing required field/);
});

test('SCHEMA: POST /api/projects with an unknown field is rejected with 400', async () => {
  const res = await requestWithBody(port, '/api/projects', { jsonBody: { name: 'Ok Name', evil: 'x' } });
  assert.equal(res.statusCode, 400);
  assert.match(res.json.error, /unknown field/);
});

test('GET /api/projects is unaffected by adding the POST route', async () => {
  const res = await request(port, '/api/projects');
  assert.equal(res.statusCode === 200 || res.statusCode === 502, true);
  assert.equal(typeof res.json.ok, 'boolean');
});

// N6 fix (WP-C1, 2026-09-26 laptop re-audit): POST /api/projects had NO exec-token check at all
// before this fix (audit: `POST /api/projects {"name":""}` no token -> 400 "validated, not
// gated" — the body was validated before any auth check ever ran, and a VALID body created a real
// project + started a detached installer with no auth at all). The token is now checked before
// the body is even read, so a missing token is rejected regardless of what the body contains.
test('N6 AUTH: POST /api/projects with an otherwise-valid body and NO exec token is rejected with 403, nothing is created', async () => {
  const res = await requestWithBody(port, '/api/projects', { jsonBody: { name: 'No Token Project' }, omitExecToken: true });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json.ok, false);
  assert.match(res.json.error, /execution token/);
  assert.equal(fs.existsSync(path.join(tempRoot, 'No Token Project')), false);
});

test('N6 AUTH: POST /api/projects with an INVALID body and NO exec token is still rejected with 403 (token beats body validation)', async () => {
  const res = await requestWithBody(port, '/api/projects', { jsonBody: { name: '' }, omitExecToken: true });
  assert.equal(res.statusCode, 403);
  assert.match(res.json.error, /execution token/);
});
