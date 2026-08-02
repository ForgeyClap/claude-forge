// WP-D1 (feat-discord-gateway) — unit-level coverage for discord-service.mjs. Every test here uses
// injected fake spawn/fetch/kill functions and isolated temp paths (_setDiscordPathsForTests) — NO
// real process is ever spawned and NO real network call ever reaches the live old bot instance
// (127.0.0.1:3979). The one genuinely-real spawn is covered separately in
// discord-service-real-spawn.test.mjs, per the WP's own "never start the real bot with a real token
// in any test" instruction (mock transport only, isolated port).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getDiscordStatus,
  startDiscordService,
  stopDiscordService,
  _setDiscordPathsForTests,
  _setSpawnFnForTests,
  _setFetchFnForTests,
  _setKillFnForTests,
  _resetDiscordServiceForTests,
} from '../src/discord-service.mjs';

let tempDir;

function makeFakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return child;
}

function isolatedPaths({ mainJsExists = true, envContent = '' } = {}) {
  const mainJsDir = path.join(tempDir, 'src');
  fs.mkdirSync(mainJsDir, { recursive: true });
  const mainJs = path.join(mainJsDir, 'main.js');
  if (mainJsExists) fs.writeFileSync(mainJs, '// fake main.js for tests\n', 'utf8');
  const envExampleFile = path.join(tempDir, '.env.example');
  fs.writeFileSync(
    envExampleFile,
    ['TRANSPORT=mock', 'DISCORD_BOT_TOKEN=', 'BOT_HTTP_PORT=3979', 'OWNER_WEBHOOK_URL='].join('\n') + '\n',
    'utf8',
  );
  const envFile = path.join(tempDir, '.env');
  fs.writeFileSync(envFile, envContent, 'utf8');
  return {
    discordDir: tempDir,
    mainJs,
    envFile,
    envExampleFile,
    stateDir: path.join(tempDir, 'state'),
    logFile: path.join(tempDir, 'discord-bot.log'),
  };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-discord-service-test-'));
  _resetDiscordServiceForTests();
});

afterEach(() => {
  _resetDiscordServiceForTests();
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

test('installed:false + start() refuses 404 when main.js is not present, never attempts a spawn', async () => {
  _setDiscordPathsForTests(isolatedPaths({ mainJsExists: false }));
  let spawnCalls = 0;
  _setSpawnFnForTests(() => { spawnCalls += 1; return makeFakeChild(1234); });
  _setFetchFnForTests(async () => { throw new Error('nothing should ever be reachable in this test'); });

  const status = await getDiscordStatus();
  assert.equal(status.installed, false);

  const result = await startDiscordService();
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.match(result.error, /not found/);
  assert.equal(spawnCalls, 0, 'a missing install must never spawn anything');
});

test('env_keys reports {name,present} booleans only — never a value, even for a present secret', async () => {
  _setDiscordPathsForTests(isolatedPaths({ envContent: 'DISCORD_BOT_TOKEN=super-secret-value-should-never-leak\nTRANSPORT=discord\n' }));
  _setFetchFnForTests(async () => { throw new Error('unreachable'); });

  const status = await getDiscordStatus();
  const tokenKey = status.env_keys.find((k) => k.name === 'DISCORD_BOT_TOKEN');
  assert.ok(tokenKey, 'DISCORD_BOT_TOKEN must appear (declared in .env.example)');
  assert.equal(tokenKey.present, true);
  assert.equal('value' in tokenKey, false, 'env_keys entries must never carry a value field');
  assert.deepEqual(Object.keys(tokenKey).sort(), ['name', 'present']);
  // Whole-response serialization must never contain the real secret string either.
  assert.equal(JSON.stringify(status).includes('super-secret-value-should-never-leak'), false);

  const emptyKey = status.env_keys.find((k) => k.name === 'OWNER_WEBHOOK_URL');
  assert.equal(emptyKey.present, false, 'a key absent from .env must report present:false');
});

test('GET status reports an honest conflict when something already answers but this gateway did not start it', async () => {
  _setDiscordPathsForTests(isolatedPaths());
  _setFetchFnForTests(async () => ({ ok: true, json: async () => ({ live: true, pid: 99999, phase: 'ready' }) }));

  const status = await getDiscordStatus();
  assert.equal(status.running, false);
  assert.equal(status.pid, null);
  assert.ok(status.conflict, 'a reachable-but-untracked health endpoint must be reported as a conflict');
  assert.match(status.conflict, /already answering/);
  assert.deepEqual(status.health, { live: true, pid: 99999, phase: 'ready' }, 'the bot own /api/health payload must pass through verbatim');
});

test('start() refuses 409 without ever spawning when the conflict probe finds something already answering', async () => {
  _setDiscordPathsForTests(isolatedPaths());
  let spawnCalls = 0;
  _setSpawnFnForTests(() => { spawnCalls += 1; return makeFakeChild(1234); });
  _setFetchFnForTests(async () => ({ ok: true, json: async () => ({ live: true, pid: 55555 }) }));

  const result = await startDiscordService();
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.match(result.error, /already answering/);
  assert.match(result.error, /55555/, 'the real reported pid of the conflicting process should be named');
  assert.equal(spawnCalls, 0, 'a detected conflict must never spawn a second process');
});

test('start() spawns exactly once and tracks pid/started_at; a second start() refuses 409 without spawning again', async () => {
  _setDiscordPathsForTests(isolatedPaths());
  let spawnCalls = 0;
  _setSpawnFnForTests(() => { spawnCalls += 1; return makeFakeChild(4242); });
  _setFetchFnForTests(async () => { throw new Error('nothing reachable — clear to start'); });

  const first = await startDiscordService();
  assert.equal(first.ok, true);
  assert.equal(first.status, 202);
  assert.equal(first.pid, 4242);
  assert.equal(spawnCalls, 1);

  const status = await getDiscordStatus();
  assert.equal(status.running, true);
  assert.equal(status.pid, 4242);
  assert.ok(status.started_at, 'a running service must report a real started_at timestamp');

  const second = await startDiscordService();
  assert.equal(second.ok, false);
  assert.equal(second.status, 409);
  assert.match(second.error, /already running in this gateway/);
  assert.equal(spawnCalls, 1, 'an already-tracked service must never spawn a second child');
});

test('stop() is idempotent and never calls the kill function when nothing is tracked', async () => {
  _setDiscordPathsForTests(isolatedPaths());
  let killCalls = 0;
  _setKillFnForTests(() => { killCalls += 1; });
  _setFetchFnForTests(async () => { throw new Error('unreachable'); });

  const result = await stopDiscordService();
  assert.equal(result.ok, true);
  assert.equal(result.stopped, false);
  assert.equal(killCalls, 0);
});

test('stop() kills exactly the tracked pid via the injected kill function, then clears tracked state', async () => {
  _setDiscordPathsForTests(isolatedPaths());
  _setSpawnFnForTests(() => makeFakeChild(7777));
  _setFetchFnForTests(async () => { throw new Error('unreachable — both the pre-start probe and the graceful shutdown POST fail, forcing the kill path'); });

  const started = await startDiscordService();
  assert.equal(started.ok, true);

  let killedPid = null;
  _setKillFnForTests((child) => { killedPid = child.pid; });

  const stopped = await stopDiscordService();
  assert.equal(stopped.ok, true);
  assert.equal(stopped.stopped, true);
  assert.equal(killedPid, 7777, 'stop() must kill exactly the pid this module itself tracked');

  const status = await getDiscordStatus();
  assert.equal(status.running, false);
  assert.equal(status.pid, null);
});
