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
import { runDiscordOperation } from '../src/discord-ops.mjs';
import { request, requestWithBody } from '../test-support/helpers.mjs';
import {
  _setDiscordPathsForTests,
  _setSpawnFnForTests,
  _setFetchFnForTests,
  _setExtraEnvOverridesForTests,
  _setKillFnForTests,
  _setHomeDirForTests,
  _resetDiscordServiceForTests,
} from '../src/discord-service.mjs';

let server;
let port;
let tempDir;
let homeDir; // WP-S1: a throwaway stand-in for os.homedir(), never the real one

function makeFakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return child;
}

// WP-P1: pre-creates a `node_modules/discord.js/package.json` marker by default so every route
// test below (none of which are about the deps-install feature) keeps exercising the
// already-installed fast path it was written against — see discord-service.test.mjs's own
// `isolatedPaths()` header for the identical reasoning.
function isolatedPaths(dir) {
  const mainJsDir = path.join(dir, 'src');
  fs.mkdirSync(mainJsDir, { recursive: true });
  const mainJs = path.join(mainJsDir, 'main.js');
  fs.writeFileSync(mainJs, '// fake main.js for route tests\n', 'utf8');
  const envExampleFile = path.join(dir, '.env.example');
  fs.writeFileSync(envExampleFile, 'TRANSPORT=mock\nDISCORD_BOT_TOKEN=\nBOT_HTTP_PORT=3979\n', 'utf8');
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, 'TRANSPORT=mock\n', 'utf8');
  fs.mkdirSync(path.join(dir, 'node_modules', 'discord.js'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'discord.js', 'package.json'), '{"name":"discord.js"}\n', 'utf8');
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
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-routes-discord-home-'));
  _resetDiscordServiceForTests();
  _setDiscordPathsForTests(isolatedPaths(tempDir));
  _setHomeDirForTests(homeDir);
  _setFetchFnForTests(async () => { throw new Error('unreachable — isolated test port, nothing listens'); });
});

afterEach(() => {
  _resetDiscordServiceForTests();
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  fs.rmSync(homeDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
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

// ── WP-S1 (owner request 2026-09-27): the Discord "projects folder" setting + folder picker ────
// Deep validation-rule coverage (drive root / system folder / home root / create-inside-home-only
// / atomic-write shape / conditional restart) already lives in discord-projects-dir.test.mjs at
// the unit level — these tests cover HTTP wiring only: auth, schema, status codes, and one real
// round trip through the actual server.

test('GET /api/discord/projects-dir returns a real 200 shape, no exec token needed (read-only)', async () => {
  const res = await request(port, '/api/discord/projects-dir');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.dir, path.join(homeDir, 'Documents', 'ForgeProjects'));
  assert.equal(res.json.source, 'default');
  assert.equal(res.json.exists, false);
  assert.equal(res.json.project_count, null);
});

test('POST /api/discord/projects-dir without the exec token is rejected with 403, never writes .env', async () => {
  const envBefore = fs.readFileSync(path.join(tempDir, '.env'), 'utf8');
  const target = path.join(homeDir, 'Projects');
  fs.mkdirSync(target, { recursive: true });

  const res = await requestWithBody(port, '/api/discord/projects-dir', {
    method: 'POST',
    jsonBody: { dir: target },
    omitExecToken: true,
  });
  assert.equal(res.statusCode, 403);
  assert.equal(fs.readFileSync(path.join(tempDir, '.env'), 'utf8'), envBefore);
});

test('POST /api/discord/projects-dir with an unknown body field is rejected with 400 (strict schema)', async () => {
  const res = await requestWithBody(port, '/api/discord/projects-dir', {
    method: 'POST',
    jsonBody: { dir: homeDir, extra: 'nope' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json.ok, false);
});

test('POST /api/discord/projects-dir with a non-string dir is rejected with 400', async () => {
  const res = await requestWithBody(port, '/api/discord/projects-dir', { method: 'POST', jsonBody: { dir: 42 } });
  assert.equal(res.statusCode, 400);
  assert.match(res.json.error, /dir must be a string/);
});

test('POST /api/discord/projects-dir with a non-boolean create is rejected with 400', async () => {
  const res = await requestWithBody(port, '/api/discord/projects-dir', {
    method: 'POST',
    jsonBody: { dir: homeDir, create: 'yes' },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json.error, /create must be a boolean/);
});

test('POST /api/discord/projects-dir with a real exec token and an existing folder saves it — GET then reflects the new setting', async () => {
  const target = path.join(homeDir, 'Projects');
  fs.mkdirSync(path.join(target, 'demo-project'), { recursive: true });

  const postRes = await requestWithBody(port, '/api/discord/projects-dir', { method: 'POST', jsonBody: { dir: target } });
  assert.equal(postRes.statusCode, 200, JSON.stringify(postRes.json));
  assert.equal(postRes.json.ok, true);
  assert.equal(postRes.json.dir, target);
  assert.equal(postRes.json.restarted, false, 'nothing is tracked as running in this test');

  const getRes = await request(port, '/api/discord/projects-dir');
  assert.equal(getRes.json.dir, target);
  assert.equal(getRes.json.source, 'setting');
  assert.equal(getRes.json.exists, true);
  assert.equal(getRes.json.project_count, 1);
});

test('POST /api/discord/projects-dir refuses a Windows system folder with 400, never writes .env', { skip: process.platform !== 'win32' }, async () => {
  const winDir = process.env.WINDIR || process.env.SystemRoot;
  const envBefore = fs.readFileSync(path.join(tempDir, '.env'), 'utf8');
  const res = await requestWithBody(port, '/api/discord/projects-dir', { method: 'POST', jsonBody: { dir: winDir } });
  assert.equal(res.statusCode, 400);
  assert.match(res.json.error, /Windows system folder/);
  assert.equal(fs.readFileSync(path.join(tempDir, '.env'), 'utf8'), envBefore);
});

test('POST /api/discord/projects-dir restarts an actually-running bot (restarted:true, a fresh pid)', async () => {
  _setExtraEnvOverridesForTests({ RUNNER: 'fake' });
  _setKillFnForTests(() => {});
  let spawnCalls = 0;
  _setSpawnFnForTests(() => {
    spawnCalls += 1;
    return makeFakeChild(5100 + spawnCalls);
  });

  const startRes = await requestWithBody(port, '/api/discord/start', { method: 'POST' });
  assert.equal(startRes.statusCode, 202, JSON.stringify(startRes.json));

  const target = path.join(homeDir, 'RestartProjects');
  fs.mkdirSync(target, { recursive: true });
  const res = await requestWithBody(port, '/api/discord/projects-dir', { method: 'POST', jsonBody: { dir: target } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.json));
  assert.equal(res.json.restarted, true);
  assert.equal(res.json.pid, 5102);
});

test('DELETE /api/discord/projects-dir (unsupported method) is rejected with 405', async () => {
  const res = await requestWithBody(port, '/api/discord/projects-dir', { method: 'DELETE' });
  assert.equal(res.statusCode, 405);
});

test('GET /api/discord/browse-folder with no ?dir defaults to the real <home>/Documents, no exec token needed', async () => {
  // folder-browse.mjs is a separate, stateless module with no home-dir override seam of its own
  // (unlike discord-service.mjs's `_setHomeDirForTests`) — its default root is the machine's REAL
  // os.homedir(), same as folder-browse.test.mjs's own unit-level assertion for this exact case.
  const res = await request(port, '/api/discord/browse-folder');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.path, fs.realpathSync.native(path.join(os.homedir(), 'Documents')));
});

test('GET /api/discord/browse-folder?dir=<real folder> lists real subfolder names only', async () => {
  const target = path.join(homeDir, 'Browsable');
  fs.mkdirSync(path.join(target, 'child-one'), { recursive: true });
  fs.mkdirSync(path.join(target, '.hidden'), { recursive: true });
  fs.writeFileSync(path.join(target, 'a-file.txt'), 'x', 'utf8');

  const res = await request(port, '/api/discord/browse-folder?dir=' + encodeURIComponent(target));
  assert.equal(res.statusCode, 200, JSON.stringify(res.json));
  assert.deepEqual(res.json.folders, ['child-one']);
  assert.equal('content' in res.json, false);
});

test('GET /api/discord/browse-folder?dir=<missing folder> answers 400, honestly', async () => {
  const res = await request(port, '/api/discord/browse-folder?dir=' + encodeURIComponent(path.join(homeDir, 'nope')));
  assert.equal(res.statusCode, 400);
  assert.equal(res.json.ok, false);
});

test('POST /api/discord/browse-folder (GET-only route) is rejected with 405, even with a real exec token', async () => {
  const res = await requestWithBody(port, '/api/discord/browse-folder', { method: 'POST', jsonBody: {} });
  assert.equal(res.statusCode, 405);
});

// v2.9.0 (Command Center audit finding 31): GET /api/discord/activity reads the SAME state folder
// GET /api/discord/status reports (the isolated one from beforeEach here), never the real bot state.
test('GET /api/discord/activity summarizes the isolated bot state folder, no exec token needed (read-only)', async () => {
  const stateDir = path.join(tempDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(
    path.join(stateDir, 'queue.json'),
    JSON.stringify({ items: [{ id: 'x1', projectId: 'alpha', state: 'COMPLETED', content: 'private route text', receivedAt: now - 2000, startedAt: now - 1500, completedAt: now - 500 }] }),
    'utf8',
  );
  fs.writeFileSync(path.join(stateDir, 'usage.jsonl'), JSON.stringify({ ts: now - 500, projectId: 'alpha', costUsd: 0.5 }) + '\n', 'utf8');
  const res = await request(port, '/api/discord/activity');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.ok, true);
  const a = res.json.activity;
  assert.equal(a.available, true);
  assert.equal(a.state_dir, stateDir);
  assert.equal(a.jobs.total, 1);
  assert.deepEqual(a.jobs.by_state, { COMPLETED: 1 });
  assert.equal(a.jobs.recent[0].duration_ms, 1000);
  assert.equal(a.cost.total_usd, 0.5);
  assert.ok(!JSON.stringify(res.json).includes('private route text'), 'message text must never be returned');
});

test('GET /api/discord/activity with no bot state yet answers 200 with available:false, not an error', async () => {
  const res = await request(port, '/api/discord/activity');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.activity.available, false);
  assert.equal(res.json.activity.jobs.total, 0);
});

test('POST /api/discord/activity (GET-only route) is rejected with 405, even with a real exec token', async () => {
  const res = await requestWithBody(port, '/api/discord/activity', { method: 'POST', jsonBody: {} });
  assert.equal(res.statusCode, 405);
});

test('F-08: saving the projects folder waits its turn behind a running Discord operation (it may restart the bot)', async () => {
  const target = path.join(homeDir, 'Projects');
  fs.mkdirSync(target, { recursive: true });
  let release;
  const busy = runDiscordOperation(() => new Promise((r) => { release = r; }));
  let answered = false;
  const save = requestWithBody(port, '/api/discord/projects-dir', { method: 'POST', jsonBody: { dir: target } }).then((res) => { answered = true; return res; });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(answered, false, 'the save must wait while another Discord operation runs');
  release();
  await busy;
  const res = await save;
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.ok, true);
});
