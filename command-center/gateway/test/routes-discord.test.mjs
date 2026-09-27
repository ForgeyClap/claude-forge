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
  _setExtraEnvOverridesForTests,
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

// N6/C2 fix (WP-C1, 2026-09-26 laptop re-audit): this route also gates on startDiscordService's own
// fail-closed CLI-broker check — without a real `claude` CLI resolvable on PATH (true on a fresh
// laptop, per the audit) it honestly answers 503, not 202, which has nothing to do with what this
// test verifies (the HTTP route wiring for a successful start). RUNNER=fake is the same escape
// hatch discord-service.test.mjs's own dedicated CLI-broker tests already use, so this stays
// deterministic on every machine, CI included, without weakening the broker gate itself (that gate
// has its own coverage in discord-service.test.mjs).
test('POST /api/discord/start with a valid exec token really spawns and returns 202+pid', async () => {
  _setExtraEnvOverridesForTests({ RUNNER: 'fake' });
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

// ── WP-v290-B (beginner Discord onboarding, B1/B2) ─────────────────────────────────────────────
// Built in pieces (never a literal token-shaped string in one place) — same GitHub push-protection
// dodge misc.test.js's own audit test in the discord/ package already documents.
const FAKE_TOKEN = ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GaBcDe', 'aBcDeFgHiJkLmNoPqRsTuVwXyZ012345'].join('.');

test('POST /api/discord/connect without the exec token is rejected with 403, never spawns, never writes .env', async () => {
  let spawnCalls = 0;
  _setSpawnFnForTests(() => { spawnCalls += 1; return makeFakeChild(1111); });
  const envBefore = fs.readFileSync(path.join(tempDir, '.env'), 'utf8');

  const res = await requestWithBody(port, '/api/discord/connect', {
    method: 'POST',
    jsonBody: { token: FAKE_TOKEN },
    omitExecToken: true,
  });
  assert.equal(res.statusCode, 403);
  assert.equal(spawnCalls, 0);
  assert.equal(fs.readFileSync(path.join(tempDir, '.env'), 'utf8'), envBefore, '.env must be untouched');
});

test('POST /api/discord/connect with a malformed token is rejected with 400, never spawns, never writes .env, and the bad token never appears in the response body', async () => {
  let spawnCalls = 0;
  _setSpawnFnForTests(() => { spawnCalls += 1; return makeFakeChild(1112); });
  const badToken = 'clearly not a real token';
  const envBefore = fs.readFileSync(path.join(tempDir, '.env'), 'utf8');

  const res = await requestWithBody(port, '/api/discord/connect', { method: 'POST', jsonBody: { token: badToken } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json.ok, false);
  assert.equal(spawnCalls, 0);
  assert.equal(fs.readFileSync(path.join(tempDir, '.env'), 'utf8'), envBefore);
  assert.equal(res.body.includes(badToken), false, 'even a REJECTED token must never be echoed back in the response');
});

test('POST /api/discord/connect with an unknown body field is rejected with 400 (strict schema)', async () => {
  const res = await requestWithBody(port, '/api/discord/connect', {
    method: 'POST',
    jsonBody: { token: FAKE_TOKEN, extra: 'nope' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json.ok, false);
});

test('POST /api/discord/connect with a real exec token and a valid token really writes .env and starts the service — the token never appears anywhere in the response', async () => {
  _setExtraEnvOverridesForTests({ RUNNER: 'fake' });
  _setSpawnFnForTests(() => makeFakeChild(2223));

  const res = await requestWithBody(port, '/api/discord/connect', { method: 'POST', jsonBody: { token: FAKE_TOKEN } });
  assert.equal(res.statusCode, 202, JSON.stringify(res.json));
  assert.equal(res.json.ok, true);
  assert.equal(res.json.pid, 2223);
  assert.equal(res.body.includes(FAKE_TOKEN), false, 'the real token must never be echoed back in the response body');

  const envAfter = fs.readFileSync(path.join(tempDir, '.env'), 'utf8');
  assert.match(envAfter, /^TRANSPORT=discord$/m);
  assert.ok(envAfter.includes(FAKE_TOKEN), '.env itself (never the HTTP response) is where the token belongs');

  const statusRes = await request(port, '/api/discord/status');
  assert.equal(statusRes.json.service.running, true);
  assert.equal(statusRes.json.service.pid, 2223);
});

test('POST /api/discord/guild without the exec token is rejected with 403 and never touches .env', async () => {
  const envBefore = fs.readFileSync(path.join(tempDir, '.env'), 'utf8');
  const res = await requestWithBody(port, '/api/discord/guild', {
    method: 'POST',
    jsonBody: { guildId: '123456789012345678' },
    omitExecToken: true,
  });
  assert.equal(res.statusCode, 403);
  assert.equal(fs.readFileSync(path.join(tempDir, '.env'), 'utf8'), envBefore);
});

test('POST /api/discord/guild with a non-numeric guildId is rejected with 400', async () => {
  const res = await requestWithBody(port, '/api/discord/guild', { method: 'POST', jsonBody: { guildId: 'not-a-real-id' } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json.ok, false);
});

test('POST /api/discord/guild with a real exec token and a guildId the bot is ACTUALLY in persists it and (re)starts the service', async () => {
  _setExtraEnvOverridesForTests({ RUNNER: 'fake' });
  _setSpawnFnForTests(() => makeFakeChild(3334));
  // The FIRST /api/health probe is this route's own guild-membership verification against the OLD
  // instance; every probe after that is startDiscordService()'s own conflict check, which must see
  // nothing there once the old instance has been stopped — see the matching comment in
  // discord-service.test.mjs's own version of this fixture for the full reasoning.
  let healthCalls = 0;
  _setFetchFnForTests(async (url) => {
    if (!String(url).includes('/api/health')) return { ok: true, json: async () => ({ ok: true }) };
    healthCalls += 1;
    if (healthCalls === 1) {
      return { ok: true, json: async () => ({ live: true, pid: 1, phase: 'awaiting-guild-selection', guilds: [{ id: '987654321098765432', name: 'Beta' }] }) };
    }
    throw new Error('unreachable — the old instance is stopped by now');
  });

  const res = await requestWithBody(port, '/api/discord/guild', { method: 'POST', jsonBody: { guildId: '987654321098765432' } });
  assert.equal(res.statusCode, 202, JSON.stringify(res.json));
  assert.equal(res.json.ok, true);
  assert.equal(res.json.pid, 3334);

  const envAfter = fs.readFileSync(path.join(tempDir, '.env'), 'utf8');
  assert.match(envAfter, /^DISCORD_GUILD_ID=987654321098765432$/m);
});

test('SECURITY Codex K3-6: POST /api/discord/guild refuses a format-valid guildId the bot is NOT in, never restarts', async () => {
  let spawnCalls = 0;
  _setExtraEnvOverridesForTests({ RUNNER: 'fake' });
  _setSpawnFnForTests(() => { spawnCalls += 1; return makeFakeChild(9); });
  _setFetchFnForTests(async () => ({
    ok: true,
    json: async () => ({ live: true, pid: 1, phase: 'awaiting-guild-selection', guilds: [{ id: '111', name: 'Alpha' }] }),
  }));

  const res = await requestWithBody(port, '/api/discord/guild', { method: 'POST', jsonBody: { guildId: '987654321098765432' } });
  assert.equal(res.statusCode, 400, JSON.stringify(res.json));
  assert.equal(res.json.ok, false);
  assert.match(res.json.error, /not one of the servers this bot is currently in/);
  assert.equal(spawnCalls, 0);
  const envAfter = fs.readFileSync(path.join(tempDir, '.env'), 'utf8');
  assert.equal(envAfter.includes('DISCORD_GUILD_ID=987654321098765432'), false);
});

test('GET /api/discord/connect (no matching GET route for this path) is a real 404', async () => {
  const res = await request(port, '/api/discord/connect');
  assert.equal(res.statusCode, 404);
});
