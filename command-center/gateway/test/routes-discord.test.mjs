// WP-D1 (feat-discord-gateway) — HTTP-level integration tests for the three discord routes, same
// harness pattern as routes-pending-asks.test.mjs (a real gateway on an ephemeral port). Every test
// isolates discord-service.mjs's module state via its own test seams (_setDiscordPathsForTests/
// _setSpawnFnForTests/_setFetchFnForTests) so NONE of these HTTP calls ever reach the real
// command-center/discord/.env or the live old bot instance on port 3979.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.mjs';
import { request, requestWithBody } from '../test-support/helpers.mjs';
import {
  _setDiscordPathsForTests,
  _setSpawnFnForTests,
  _setFetchFnForTests,
  _resetDiscordServiceForTests,
} from '../src/discord-service.mjs';

let server;
let port;
let tempDir;

function makeFakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return child;
}

function isolatedPaths(dir) {
  const mainJsDir = path.join(dir, 'src');
  fs.mkdirSync(mainJsDir, { recursive: true });
  const mainJs = path.join(mainJsDir, 'main.js');
  fs.writeFileSync(mainJs, '// fake main.js for route tests\n', 'utf8');
  const envExampleFile = path.join(dir, '.env.example');
  fs.writeFileSync(envExampleFile, 'TRANSPORT=mock\nDISCORD_BOT_TOKEN=\nBOT_HTTP_PORT=3979\n', 'utf8');
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, 'TRANSPORT=mock\n', 'utf8');
  return {
    discordDir: dir,
    mainJs,
    envFile,
    envExampleFile,
    stateDir: path.join(dir, 'state'),
    logFile: path.join(dir, 'discord-bot.log'),
  };
}

before(async () => {
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

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-routes-discord-test-'));
  _resetDiscordServiceForTests();
  _setDiscordPathsForTests(isolatedPaths(tempDir));
  _setFetchFnForTests(async () => { throw new Error('unreachable — isolated test port, nothing listens'); });
});

afterEach(() => {
  _resetDiscordServiceForTests();
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

test('GET /api/discord/status returns a real 200 shape, no exec token needed (read-only)', async () => {
  const res = await request(port, '/api/discord/status');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.ok, true);
  const s = res.json.service;
  assert.equal(s.installed, true);
  assert.equal(s.running, false);
  assert.equal(s.pid, null);
  assert.equal(s.health, null);
  assert.ok(Array.isArray(s.env_keys));
  assert.ok(s.env_keys.every((k) => Object.keys(k).sort().join(',') === 'name,present'));
  assert.equal(typeof s.state_dir, 'string');
  assert.equal(typeof s.log_file, 'string');
});

test('POST /api/discord/start without the exec token is rejected with 403, never spawns', async () => {
  let spawnCalls = 0;
  _setSpawnFnForTests(() => { spawnCalls += 1; return makeFakeChild(1111); });
  const res = await requestWithBody(port, '/api/discord/start', { method: 'POST', omitExecToken: true });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json.ok, false);
  assert.equal(spawnCalls, 0);
});

test('POST /api/discord/start with a valid exec token really spawns and returns 202+pid', async () => {
  _setSpawnFnForTests(() => makeFakeChild(2222));
  const res = await requestWithBody(port, '/api/discord/start', { method: 'POST' });
  assert.equal(res.statusCode, 202);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.pid, 2222);

  const statusRes = await request(port, '/api/discord/status');
  assert.equal(statusRes.json.service.running, true);
  assert.equal(statusRes.json.service.pid, 2222);
});

test('POST /api/discord/start refuses 409 when a conflict probe finds something already answering, never spawns', async () => {
  _setFetchFnForTests(async () => ({ ok: true, json: async () => ({ live: true, pid: 33333 }) }));
  let spawnCalls = 0;
  _setSpawnFnForTests(() => { spawnCalls += 1; return makeFakeChild(4444); });

  const res = await requestWithBody(port, '/api/discord/start', { method: 'POST' });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json.ok, false);
  assert.match(res.json.error, /already answering/);
  assert.equal(spawnCalls, 0);
});

test('POST /api/discord/stop without the exec token is rejected with 403', async () => {
  const res = await requestWithBody(port, '/api/discord/stop', { method: 'POST', omitExecToken: true });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json.ok, false);
});

test('POST /api/discord/stop with a valid exec token is idempotent (200, stopped:false) when nothing is tracked', async () => {
  const res = await requestWithBody(port, '/api/discord/stop', { method: 'POST' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.stopped, false);
});

test('GET /api/discord/start (no matching GET route for this path) is a real 404, not a fabricated success', async () => {
  const res = await request(port, '/api/discord/start');
  assert.equal(res.statusCode, 404);
});

test('DELETE /api/discord/status (unsupported method for this path) is rejected with 405', async () => {
  const res = await requestWithBody(port, '/api/discord/status', { method: 'DELETE' });
  assert.equal(res.statusCode, 405);
});
