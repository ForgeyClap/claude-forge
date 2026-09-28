// v2.9.0 WP-DA — HTTP-level proof that the Discord routes remember the owner's own on/off choice and that
// GET /api/discord/status reports the autostart state. Same harness as routes-discord.test.mjs: a real
// gateway on an ephemeral port, every discord-service path isolated in a temp folder, a fake spawn, so
// nothing here touches the real command-center/discord/.env, the real bot state or the live bot.
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
import { _resetAutostartForTests } from '../src/discord-autostart.mjs';

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

// discord-autostart.mjs keeps the remembered choice next to the bot's state folder.
function desiredFile() {
  return path.join(tempDir, 'desired-state.json');
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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-routes-discord-autostart-'));
  _resetDiscordServiceForTests();
  _resetAutostartForTests();
  _setDiscordPathsForTests(isolatedPaths(tempDir));
  _setFetchFnForTests(async () => { throw new Error('unreachable — isolated test port, nothing listens'); });
});

afterEach(() => {
  _resetDiscordServiceForTests();
  _resetAutostartForTests();
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

test('GET /api/discord/status carries an autostart block; nothing chosen yet means it will come back by itself', async () => {
  const res = await request(port, '/api/discord/status');
  assert.equal(res.statusCode, 200);
  const a = res.json.service.autostart;
  assert.ok(a && typeof a === 'object', 'autostart block present');
  assert.equal(a.desired, null);
  assert.equal(a.last, null);
  assert.equal(typeof a.effective, 'boolean');
  // Existing fields are untouched (only an addition).
  assert.equal(res.json.service.installed, true);
  assert.ok(Array.isArray(res.json.service.env_keys));
});

test('POST /api/discord/stop remembers the owner\'s "off": the bot will not come back by itself', async () => {
  const res = await requestWithBody(port, '/api/discord/stop', { method: 'POST' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.remembered, true);
  assert.equal(res.json.warning, undefined);
  const saved = JSON.parse(fs.readFileSync(desiredFile(), 'utf8'));
  assert.equal(saved.desired, 'stopped');
  assert.equal(saved.by, 'dashboard');
  const status = await request(port, '/api/discord/status');
  assert.equal(status.json.service.autostart.desired, 'stopped');
  assert.equal(status.json.service.autostart.effective, false);
});

test('POST /api/discord/start remembers the owner\'s "on" only when the start really succeeded', async () => {
  _setExtraEnvOverridesForTests({ RUNNER: 'fake' });
  _setSpawnFnForTests(() => makeFakeChild(5151));
  const res = await requestWithBody(port, '/api/discord/start', { method: 'POST' });
  assert.equal(res.statusCode, 202);
  assert.equal(res.json.remembered, true);
  assert.equal(JSON.parse(fs.readFileSync(desiredFile(), 'utf8')).desired, 'running');
});

test('DA-2: when the "off" cannot be saved, the stop still happens but the answer says so (never a silent success)', async () => {
  fs.mkdirSync(desiredFile()); // a folder where the file must go: the save fails
  const res = await requestWithBody(port, '/api/discord/stop', { method: 'POST' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.ok, true, 'the bot did stop');
  assert.equal(res.json.remembered, false);
  assert.match(res.json.warning, /could not save that you switched it off, so it may start again by itself/);
  const status = await request(port, '/api/discord/status');
  assert.ok(status.json.service.autostart.save_error, 'the dashboard sees the failed save too');
  assert.equal(status.json.service.autostart.save_error.desired, 'stopped');
});

test('DA-1: GET /api/discord/status never promises an autostart for a bot that is not connected yet', async () => {
  // The isolated .env has no DISCORD_BOT_TOKEN value, so the bot is not connected.
  const status = await request(port, '/api/discord/status');
  const a = status.json.service.autostart;
  assert.equal(a.ready, false);
  assert.match(a.ready_reason, /not connected yet/);
  assert.equal(a.effective, false);
});

test('a refused POST /api/discord/start records nothing', async () => {
  // Something already answers on the bot port -> 409, never spawns, and no choice is remembered.
  _setFetchFnForTests(async () => ({ ok: true, json: async () => ({ live: true, pid: 33333 }) }));
  const res = await requestWithBody(port, '/api/discord/start', { method: 'POST' });
  assert.equal(res.statusCode, 409);
  assert.equal(fs.existsSync(desiredFile()), false);
});

test('POST /api/discord/stop without the exec token is refused and records nothing', async () => {
  const res = await requestWithBody(port, '/api/discord/stop', { method: 'POST', omitExecToken: true });
  assert.equal(res.statusCode, 403);
  assert.equal(fs.existsSync(desiredFile()), false);
});

test('F-08: two start clicks at the same moment start ONE bot; the second is told it already runs', async () => {
  // A real health probe of the bot port takes time; that wait is where two clicks used to overlap.
  _setFetchFnForTests(async () => { await new Promise((r) => setTimeout(r, 50)); throw new Error('unreachable — nothing listens'); });
  _setExtraEnvOverridesForTests({ RUNNER: 'fake' });
  let spawns = 0;
  _setSpawnFnForTests(() => { spawns += 1; return makeFakeChild(6000 + spawns); });
  const [a, b] = await Promise.all([
    requestWithBody(port, '/api/discord/start', { method: 'POST' }),
    requestWithBody(port, '/api/discord/start', { method: 'POST' }),
  ]);
  assert.equal(spawns, 1, 'never two bots on one token');
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [202, 409]);
});

test('F-08: a start and a stop clicked together end with the bot off and "off" remembered', async () => {
  // A real health probe of the bot port takes time; that wait is where two clicks used to overlap.
  _setFetchFnForTests(async () => { await new Promise((r) => setTimeout(r, 50)); throw new Error('unreachable — nothing listens'); });
  _setExtraEnvOverridesForTests({ RUNNER: 'fake' });
  _setSpawnFnForTests(() => makeFakeChild(7070));
  const start = requestWithBody(port, '/api/discord/start', { method: 'POST' });
  const stop = requestWithBody(port, '/api/discord/stop', { method: 'POST' });
  const [s1, s2] = await Promise.all([start, stop]);
  assert.equal(s1.statusCode, 202);
  assert.equal(s2.statusCode, 200);
  assert.equal(JSON.parse(fs.readFileSync(desiredFile(), 'utf8')).desired, 'stopped');
  const status = await request(port, '/api/discord/status');
  assert.equal(status.json.service.running, false);
});
