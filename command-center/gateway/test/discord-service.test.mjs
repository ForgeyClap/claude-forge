// WP-D1 (feat-discord-gateway) — unit-level coverage for discord-service.mjs. Every test here uses
// injected fake spawn/fetch/kill functions and isolated temp paths (_setDiscordPathsForTests) — NO
// real process is ever spawned and NO real network call ever reaches the live old bot instance
// (127.0.0.1:3979). The one genuinely-real spawn is covered separately in
// discord-service-real-spawn.test.mjs, per the WP's own "never start the real bot with a real token
// in any test" instruction (mock transport only, isolated port).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getDiscordStatus,
  startDiscordService,
  stopDiscordService,
  connectDiscordService,
  selectDiscordGuild,
  isValidBotTokenFormat,
  isValidSnowflake,
  _setDiscordPathsForTests,
  _setSpawnFnForTests,
  _setFetchFnForTests,
  _setKillFnForTests,
  _setExtraEnvOverridesForTests,
  _resetDiscordServiceForTests,
  _acquireEnvLockForTests,
  _releaseEnvLockForTests,
} from '../src/discord-service.mjs';

// A real, definitely-exited pid — spawnSync blocks until the child is already gone, so by the time
// we have `pid` back, `process.kill(pid, 0)` reliably throws ESRCH (the exact "confirmed dead"
// signal the fix relies on) rather than an arbitrary large literal that some platform could still
// interpret as a live/permission-denied pid.
function definitelyDeadPid() {
  const result = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  return result.pid;
}

let tempDir;

// r6b #6: de spawn-stubs negeerden de OPTIES, dus de uiteindelijke child-env (waar de fail-closed
// brokergrens over gaat) was onzichtbaar voor tests. Deze capture legt de laatste spawn-opties vast.
let _lastSpawnOpts = null;
function lastSpawnEnv() { return (_lastSpawnOpts && _lastSpawnOpts.env) || {}; }
function captureSpawn(pid) { return (_cmd, _args, opts) => { _lastSpawnOpts = opts || null; return makeFakeChild(pid); }; }

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

// N6/C2 fix (WP-C1, 2026-09-26 laptop re-audit): this test used to rely on the REAL `claude` CLI
// being resolvable on PATH (isolatedPaths() with no RUNNER — see startDiscordService's own
// fail-closed CLI-broker gate) to reach 202 at all; on a fresh laptop without `claude` on PATH it
// got an honest 503 instead, unrelated to what this test actually verifies (spawn/pid tracking,
// not the CLI-broker gate — that gate has its OWN dedicated tests just below, "FAIL-CLOSED GRENS
// VAN DE CLI-BROKER"). RUNNER=fake is the same, already-established escape hatch those dedicated
// tests use ("RUNNER=fake uit het .env-bestand van het KIND telt mee") — it makes this test
// deterministic on every machine, CI included, without weakening the broker gate itself.
test('start() spawns exactly once and tracks pid/started_at; a second start() refuses 409 without spawning again', async () => {
  _setDiscordPathsForTests(isolatedPaths({ envContent: 'RUNNER=fake\n' }));
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

// N6/C2 fix (WP-C1): same RUNNER=fake reasoning as the test above — this test needs start() to
// really reach 202 so it can prove stop() kills the tracked pid; it must not depend on whether the
// real `claude` CLI happens to be on this machine's PATH.
test('stop() kills exactly the tracked pid via the injected kill function, then clears tracked state', async () => {
  _setDiscordPathsForTests(isolatedPaths({ envContent: 'RUNNER=fake\n' }));
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

// ── FAIL-CLOSED GRENS VAN DE CLI-BROKER (Codex r6b #6, 2026-08-09) ─────────────────────────────────
// De attest/503/.env-RUNNER/beschermde-sleutel-paden hadden geen gerichte assertions: een regressie in
// die grens bleef groen. Deze tests kijken naar de ECHTE child-env die start() zou meegeven en naar
// het feit dat er bij een fail-closed weigering NUL keer gespawnd wordt.
test('r6b #6: zonder gebrokerd CLI-pad weigert start() met 503 en spawnt NIETS (tenzij RUNNER=fake)', async () => {
  _setDiscordPathsForTests(isolatedPaths());
  let spawnCalls = 0;
  _setSpawnFnForTests((...a) => { spawnCalls += 1; return captureSpawn(111)(...a); });
  _setFetchFnForTests(async () => { throw new Error('niets bereikbaar — vrij om te starten'); });
  // forceer "resolver levert niets" door PATH leeg te maken; de resolver vindt dan geen claude
  const savedPath = process.env.PATH;
  const savedCli = process.env.CLAUDE_CLI_PATH;
  process.env.PATH = path.join(tempDir, 'leeg-pad-zonder-claude');
  delete process.env.CLAUDE_CLI_PATH;
  try {
    const r = await startDiscordService();
    if (r.ok === false) {
      assert.equal(r.status, 503, 'een niet-opbouwbaar attest/pad hoort 503 te geven: ' + JSON.stringify(r).slice(0, 200));
      assert.match(r.error, /fail-closed/);
      assert.equal(spawnCalls, 0, 'een fail-closed weigering mag NOOIT spawnen');
    } else {
      // de machine heeft een echte claude op een absoluut pad dat de resolver ook zonder PATH vindt:
      // dan hoort de child een attest MET sha256 te krijgen (de andere helft van dezelfde grens).
      assert.equal(spawnCalls, 1);
      const env = lastSpawnEnv();
      assert.ok(env.CLAUDE_CLI_ATTEST, 'een geslaagde start hoort een v2-attest mee te geven');
      const at = JSON.parse(env.CLAUDE_CLI_ATTEST);
      assert.equal(at.v, 2);
      assert.equal(typeof at.sha256, 'string');
      assert.equal(at.sha256.length, 64);
    }
  } finally {
    process.env.PATH = savedPath;
    if (savedCli === undefined) delete process.env.CLAUDE_CLI_PATH; else process.env.CLAUDE_CLI_PATH = savedCli;
  }
});

test('r6b #6: RUNNER=fake uit het .env-bestand van het KIND telt mee (geen 503 op een testconfig)', async () => {
  _setDiscordPathsForTests(isolatedPaths({ envContent: 'TRANSPORT=mock\nRUNNER=fake\nBOT_HTTP_PORT=3979\n' }));
  let spawnCalls = 0;
  _setSpawnFnForTests((...a) => { spawnCalls += 1; return captureSpawn(222)(...a); });
  _setFetchFnForTests(async () => { throw new Error('niets bereikbaar'); });
  const savedPath = process.env.PATH;
  const savedCli = process.env.CLAUDE_CLI_PATH;
  process.env.PATH = path.join(tempDir, 'leeg-pad-zonder-claude');
  delete process.env.CLAUDE_CLI_PATH;
  try {
    const r = await startDiscordService();
    assert.equal(r.ok, true, 'met RUNNER=fake in .env mag de service starten zonder attest: ' + JSON.stringify(r).slice(0, 200));
    assert.equal(spawnCalls, 1);
  } finally {
    process.env.PATH = savedPath;
    if (savedCli === undefined) delete process.env.CLAUDE_CLI_PATH; else process.env.CLAUDE_CLI_PATH = savedCli;
  }
});

// ── WP-v290-B (beginner Discord onboarding, B1/B2) ─────────────────────────────────────────────
// Built in pieces (never a literal token-shaped string in one place) — same GitHub push-protection
// dodge misc.test.js's own audit test already documents, reused verbatim here.
const FAKE_TOKEN = ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GaBcDe', 'aBcDeFgHiJkLmNoPqRsTuVwXyZ012345'].join('.');

test('isValidBotTokenFormat: a real three-part shape passes; missing dots/whitespace/empty do not', () => {
  assert.equal(isValidBotTokenFormat(FAKE_TOKEN), true);
  assert.equal(isValidBotTokenFormat('not-a-token'), false);
  assert.equal(isValidBotTokenFormat('only.two-parts'), false);
  assert.equal(isValidBotTokenFormat(FAKE_TOKEN + ' '), false, 'trailing whitespace must be rejected, never silently trimmed');
  assert.equal(isValidBotTokenFormat('a b.c.d'), false, 'internal whitespace must be rejected');
  assert.equal(isValidBotTokenFormat(''), false);
  assert.equal(isValidBotTokenFormat(null), false);
  assert.equal(isValidBotTokenFormat(undefined), false);
  assert.equal(isValidBotTokenFormat(12345), false, 'a non-string must never be treated as valid');
});

test('isValidSnowflake: digits-only, bounded length', () => {
  assert.equal(isValidSnowflake('123456789012345678'), true);
  assert.equal(isValidSnowflake('abc'), false);
  assert.equal(isValidSnowflake(''), false);
  assert.equal(isValidSnowflake('12'), false, 'too short to be a real snowflake');
  assert.equal(isValidSnowflake('1'.repeat(30)), false, 'absurdly long values must be rejected');
});

test('connectDiscordService: an invalid token format is refused with 400 and NOTHING is ever written or spawned', async () => {
  _setDiscordPathsForTests(isolatedPaths({ envContent: 'TRANSPORT=mock\nSOME_OTHER_KEY=keep-me\n' }));
  let spawnCalls = 0;
  _setSpawnFnForTests(() => { spawnCalls += 1; return makeFakeChild(1); });
  _setFetchFnForTests(async () => { throw new Error('unreachable — clear to start'); });

  const result = await connectDiscordService({ token: 'clearly-not-a-real-token' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(spawnCalls, 0, 'an invalid token must never reach the spawn path');

  const envAfter = fs.readFileSync(path.join(tempDir, '.env'), 'utf8');
  assert.equal(envAfter, 'TRANSPORT=mock\nSOME_OTHER_KEY=keep-me\n', '.env must be byte-identical — nothing was ever written');
});

test('connectDiscordService: an invalid guildId format is refused with 400 without touching .env', async () => {
  _setDiscordPathsForTests(isolatedPaths({ envContent: 'TRANSPORT=mock\n' }));
  _setFetchFnForTests(async () => { throw new Error('unreachable'); });

  const result = await connectDiscordService({ token: FAKE_TOKEN, guildId: 'not-a-snowflake' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  const envAfter = fs.readFileSync(path.join(tempDir, '.env'), 'utf8');
  assert.equal(envAfter, 'TRANSPORT=mock\n');
});

test('connectDiscordService: a valid token merge-writes .env (TRANSPORT=discord + the token), preserving unrelated keys, then really starts', async () => {
  _setDiscordPathsForTests(isolatedPaths({ envContent: '# a comment, keep me\nTRANSPORT=mock\nRUNNER=fake\nSOME_OTHER_KEY=keep-me\n' }));
  let spawnCalls = 0;
  _setSpawnFnForTests(() => { spawnCalls += 1; return makeFakeChild(9001); });
  _setFetchFnForTests(async () => { throw new Error('unreachable — clear to start'); });

  const result = await connectDiscordService({ token: FAKE_TOKEN });
  assert.equal(result.ok, true, 'connect failed: ' + JSON.stringify(result));
  assert.equal(result.status, 202);
  assert.equal(result.pid, 9001);
  assert.equal(spawnCalls, 1);
  assert.equal(JSON.stringify(result).includes(FAKE_TOKEN), false, 'the token must never be echoed back in the result');

  const envAfter = fs.readFileSync(path.join(tempDir, '.env'), 'utf8');
  assert.match(envAfter, /# a comment, keep me/, 'unrelated comment lines must survive the merge');
  assert.match(envAfter, /^SOME_OTHER_KEY=keep-me$/m, 'unrelated keys must survive the merge');
  assert.match(envAfter, /^RUNNER=fake$/m, 'unrelated keys must survive the merge');
  assert.match(envAfter, /^TRANSPORT=discord$/m, 'TRANSPORT must be flipped to discord');
  assert.match(envAfter, new RegExp('^DISCORD_BOT_TOKEN=' + FAKE_TOKEN.replace(/[.]/g, '\\.') + '$', 'm'));

  const status = await getDiscordStatus();
  assert.equal(status.running, true);
  assert.equal(status.pid, 9001);
});

test('connectDiscordService: an optional guildId is also written when given', async () => {
  _setDiscordPathsForTests(isolatedPaths({ envContent: 'TRANSPORT=mock\nRUNNER=fake\n' }));
  _setSpawnFnForTests(() => makeFakeChild(9002));
  _setFetchFnForTests(async () => { throw new Error('unreachable'); });

  const result = await connectDiscordService({ token: FAKE_TOKEN, guildId: '123456789012345678' });
  assert.equal(result.ok, true, JSON.stringify(result));

  const envAfter = fs.readFileSync(path.join(tempDir, '.env'), 'utf8');
  assert.match(envAfter, /^DISCORD_GUILD_ID=123456789012345678$/m);
});

test('connectDiscordService: replaces a previously-tracked instance rather than running two at once', async () => {
  _setDiscordPathsForTests(isolatedPaths({ envContent: 'TRANSPORT=mock\nRUNNER=fake\n' }));
  let spawnCalls = 0;
  _setSpawnFnForTests(() => { spawnCalls += 1; return makeFakeChild(1000 + spawnCalls); });
  _setFetchFnForTests(async () => { throw new Error('unreachable'); });

  const first = await startDiscordService();
  assert.equal(first.ok, true);
  assert.equal(spawnCalls, 1);

  const second = await connectDiscordService({ token: FAKE_TOKEN });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(spawnCalls, 2, 'connect must stop the old tracked child before starting the new one');

  const status = await getDiscordStatus();
  assert.equal(status.running, true);
  assert.equal(status.pid, second.pid);
});

test('selectDiscordGuild: an invalid guildId is refused with 400 without touching .env or restarting anything', async () => {
  _setDiscordPathsForTests(isolatedPaths({ envContent: 'TRANSPORT=discord\nDISCORD_GUILD_ID=\n' }));
  let spawnCalls = 0;
  _setSpawnFnForTests(() => { spawnCalls += 1; return makeFakeChild(1); });
  _setFetchFnForTests(async () => { throw new Error('unreachable'); });

  const result = await selectDiscordGuild({ guildId: 'nope' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(spawnCalls, 0);
  const envAfter = fs.readFileSync(path.join(tempDir, '.env'), 'utf8');
  assert.equal(envAfter, 'TRANSPORT=discord\nDISCORD_GUILD_ID=\n');
});

test('selectDiscordGuild: a valid guildId that the bot is ACTUALLY in is persisted and the service is (re)started', async () => {
  _setDiscordPathsForTests(isolatedPaths({ envContent: 'TRANSPORT=discord\nRUNNER=fake\nDISCORD_GUILD_ID=\n' }));
  _setSpawnFnForTests(() => makeFakeChild(4444));
  // The FIRST /api/health probe is this route's own guild-membership verification, against the OLD
  // (about-to-be-restarted) instance — it must see the real guild list. Every probe AFTER that is
  // startDiscordService()'s own conflict check, running once the old instance has been stopped, and
  // must see nothing there (so it proceeds to spawn the new one) — modelling the real stop-then-
  // start sequence, not just satisfying the assertion.
  let healthCalls = 0;
  _setFetchFnForTests(async (url) => {
    if (!String(url).includes('/api/health')) return { ok: true, json: async () => ({ ok: true }) };
    healthCalls += 1;
    if (healthCalls === 1) {
      return {
        ok: true,
        json: async () => ({ live: true, pid: 1, phase: 'awaiting-guild-selection', guilds: [{ id: '111', name: 'Alpha' }, { id: '987654321098765432', name: 'Beta' }] }),
      };
    }
    throw new Error('unreachable — the old instance is stopped by now');
  });

  const result = await selectDiscordGuild({ guildId: '987654321098765432' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.pid, 4444);

  const envAfter = fs.readFileSync(path.join(tempDir, '.env'), 'utf8');
  assert.match(envAfter, /^DISCORD_GUILD_ID=987654321098765432$/m);
});

test('SECURITY Codex K3-6: selectDiscordGuild refuses a format-valid id the bot is NOT actually in, never writes or restarts', async () => {
  _setDiscordPathsForTests(isolatedPaths({ envContent: 'TRANSPORT=discord\nRUNNER=fake\nDISCORD_GUILD_ID=\n' }));
  let spawnCalls = 0;
  _setSpawnFnForTests(() => { spawnCalls += 1; return makeFakeChild(1); });
  _setFetchFnForTests(async () => ({
    ok: true,
    json: async () => ({ live: true, pid: 1, phase: 'awaiting-guild-selection', guilds: [{ id: '111', name: 'Alpha' }] }),
  }));

  const result = await selectDiscordGuild({ guildId: '999999999999999999' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.match(result.error, /not one of the servers this bot is currently in/);
  assert.equal(spawnCalls, 0);
  const envAfter = fs.readFileSync(path.join(tempDir, '.env'), 'utf8');
  assert.equal(envAfter, 'TRANSPORT=discord\nRUNNER=fake\nDISCORD_GUILD_ID=\n', '.env must be completely untouched');
});

test('SECURITY Codex K3-6: selectDiscordGuild refuses outright when the bot/guild list is not reachable, never writes or restarts', async () => {
  _setDiscordPathsForTests(isolatedPaths({ envContent: 'TRANSPORT=discord\nRUNNER=fake\nDISCORD_GUILD_ID=\n' }));
  let spawnCalls = 0;
  _setSpawnFnForTests(() => { spawnCalls += 1; return makeFakeChild(1); });
  _setFetchFnForTests(async () => { throw new Error('unreachable'); });

  const result = await selectDiscordGuild({ guildId: '987654321098765432' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.match(result.error, /not running.*list of servers is not known/);
  assert.equal(spawnCalls, 0);
  const envAfter = fs.readFileSync(path.join(tempDir, '.env'), 'utf8');
  assert.equal(envAfter, 'TRANSPORT=discord\nRUNNER=fake\nDISCORD_GUILD_ID=\n', '.env must be completely untouched');
});

test('getDiscordStatus: promotes username/application_id/guilds/invite_url/setup_state/login_error from the bot\'s own health verbatim, honest nulls when unreachable', async () => {
  _setDiscordPathsForTests(isolatedPaths());
  _setFetchFnForTests(async () => { throw new Error('unreachable'); });
  const unreachable = await getDiscordStatus();
  assert.equal(unreachable.username, null);
  assert.equal(unreachable.application_id, null);
  assert.deepEqual(unreachable.guilds, []);
  assert.equal(unreachable.invite_url, null);
  assert.equal(unreachable.setup_state, null);
  assert.equal(unreachable.login_error, null);

  _setFetchFnForTests(async () => ({
    ok: true,
    json: async () => ({
      live: true,
      phase: 'awaiting-guild-selection',
      botUsername: 'ForgeBot',
      applicationId: '111222333',
      guilds: [{ id: '1', name: 'Alpha' }, { id: '2', name: 'Beta' }],
      inviteUrl: 'https://discord.com/oauth2/authorize?client_id=111222333&scope=bot%20applications.commands&permissions=123',
      loginError: null,
    }),
  }));
  const reachable = await getDiscordStatus();
  assert.equal(reachable.username, 'ForgeBot');
  assert.equal(reachable.application_id, '111222333');
  assert.deepEqual(reachable.guilds, [{ id: '1', name: 'Alpha' }, { id: '2', name: 'Beta' }]);
  assert.match(reachable.invite_url, /^https:\/\/discord\.com\/oauth2\/authorize\?/);
  assert.equal(reachable.setup_state, 'awaiting-guild-selection');
  assert.equal(reachable.login_error, null);

  _setFetchFnForTests(async () => ({
    ok: true,
    json: async () => ({ live: true, phase: 'login-failed', loginError: 'Discord rejected the login: bad token.' }),
  }));
  const failed = await getDiscordStatus();
  assert.equal(failed.setup_state, 'login-failed');
  assert.equal(failed.login_error, 'Discord rejected the login: bad token.');
});

test('WP-L2 finding 3: a Discord-bot-token-shaped string nested anywhere inside the bot health payload is redacted before getDiscordStatus() ever returns it', async () => {
  _setDiscordPathsForTests(isolatedPaths());
  // The gateway's OWN shared minimum shape (10/3/10 chars) — see redact.mjs's
  // DISCORD_BOT_TOKEN_CORE_SOURCE, the same shape isValidBotTokenFormat() validates on the way in.
  const minShapeToken = ['a'.repeat(10), 'b'.repeat(3), 'c'.repeat(10)].join('.');
  _setFetchFnForTests(async () => ({
    ok: true,
    json: async () => ({
      live: true,
      phase: 'ready',
      // Nested on purpose — a shallow, top-level-only redaction would miss this.
      diagnostics: { lastError: `re-auth using ${minShapeToken} failed` },
    }),
  }));

  const status = await getDiscordStatus();
  assert.equal(
    JSON.stringify(status).includes(minShapeToken),
    false,
    'the raw token-shaped string must never reach the returned status, at any depth',
  );
  assert.match(status.health.diagnostics.lastError, /\[REDACTED:DISCORD_BOT_TOKEN\]/);
});

test('r6b #6: een GEERFD CLAUDE_CLI_PATH/ATTEST wordt gestript en overrides kunnen de gebrokerde sleutels niet kapen', async () => {
  _setDiscordPathsForTests(isolatedPaths({ envContent: 'TRANSPORT=mock\nRUNNER=fake\n' }));
  _setSpawnFnForTests(captureSpawn(333));
  _setFetchFnForTests(async () => { throw new Error('niets bereikbaar'); });
  _setExtraEnvOverridesForTests({ RUNNER: 'fake', CLAUDE_CLI_PATH: 'C:\kwaadaardig\claude.exe', CLAUDE_CLI_ATTEST: '{"v":2,"path":"C:\\kwaadaardig\\claude.exe"}' });
  const savedCli = process.env.CLAUDE_CLI_PATH;
  const savedAt = process.env.CLAUDE_CLI_ATTEST;
  process.env.CLAUDE_CLI_PATH = 'C:\geerfd\claude.exe';
  process.env.CLAUDE_CLI_ATTEST = '{"v":2,"path":"C:\\geerfd\\claude.exe"}';
  try {
    const r = await startDiscordService();
    assert.equal(r.ok, true);
    const env = lastSpawnEnv();
    // het GEERFDE pad/attest mag nooit ongewijzigd doorlekken naar het kind
    assert.notEqual(env.CLAUDE_CLI_PATH, 'C:\geerfd\claude.exe', 'een geerfd CLI-pad moet gestript zijn');
    assert.notEqual(env.CLAUDE_CLI_ATTEST, '{"v":2,"path":"C:\\geerfd\\claude.exe"}', 'een geerfd attest moet gestript zijn');
  } finally {
    if (savedCli === undefined) delete process.env.CLAUDE_CLI_PATH; else process.env.CLAUDE_CLI_PATH = savedCli;
    if (savedAt === undefined) delete process.env.CLAUDE_CLI_ATTEST; else process.env.CLAUDE_CLI_ATTEST = savedAt;
    _setExtraEnvOverridesForTests(null);
  }
});

test('SECURITY Codex K3-4: a Discord bot token split across two stdout chunks is still fully redacted in discord-bot.log', async () => {
  const paths = isolatedPaths({ envContent: 'TRANSPORT=mock\nRUNNER=fake\n' });
  _setDiscordPathsForTests(paths);
  let child;
  _setSpawnFnForTests(() => {
    child = makeFakeChild(555);
    return child;
  });
  _setFetchFnForTests(async () => { throw new Error('unreachable'); });
  _setExtraEnvOverridesForTests({ RUNNER: 'fake' });

  const result = await startDiscordService();
  assert.equal(result.ok, true, JSON.stringify(result));

  const token = ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GaBcDe', 'a'.repeat(30)].join('.'); // a real-shaped token
  const half = Math.floor(token.length / 2);
  child.stdout.emit('data', Buffer.from('leaked during boot: ' + token.slice(0, half)));
  child.stdout.emit('data', Buffer.from(token.slice(half) + ' end of line\n'));
  // WP-L2 finding N1: the redactors now finalize on 'close' (stdio fully drained), never on the
  // earlier 'exit' — real Node always emits both, in this order, for a normally-exited child.
  child.emit('exit', 0);
  child.emit('close', 0); // flushes whatever the stream redactor was still holding back

  // The write is real disk I/O on a real fs.WriteStream, whose underlying file descriptor opens
  // asynchronously — poll briefly (the file may not exist for the first few ms) rather than assume
  // a fixed delay or let one early ENOENT read fail the whole test.
  const deadline = Date.now() + 2000;
  let content = '';
  while (Date.now() < deadline) {
    try {
      content = fs.readFileSync(paths.logFile, 'utf8');
      if (content.length > 0) break;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(content.includes(token), false, 'the raw, split token must never reach the log file');
  assert.match(content, /\[REDACTED:DISCORD_BOT_TOKEN\]/);
});

test('WP-L2 finding N1: stdout data delivered AFTER "exit" but before "close" is still flushed to the log, never silently dropped', async () => {
  const paths = isolatedPaths({ envContent: 'TRANSPORT=mock\nRUNNER=fake\n' });
  _setDiscordPathsForTests(paths);
  let child;
  _setSpawnFnForTests(() => {
    child = makeFakeChild(556);
    return child;
  });
  _setFetchFnForTests(async () => { throw new Error('unreachable'); });
  _setExtraEnvOverridesForTests({ RUNNER: 'fake' });

  const result = await startDiscordService();
  assert.equal(result.ok, true, JSON.stringify(result));

  child.stdout.emit('data', Buffer.from('before exit line\n'));
  child.emit('exit', 0); // the process itself has ended...
  // ...but a real child process's stdio can still deliver already-buffered data AFTER 'exit' and
  // before 'close' — this line models exactly that late-arriving chunk. Finalizing on 'exit' (the
  // pre-fix behavior) would have flushed-and-forgotten before this chunk ever arrived, permanently
  // losing it in the redactor's held-back carry buffer (nothing else ever calls `.end()` again).
  const lateMarker = 'LATE-DATA-AFTER-EXIT-MARKER';
  child.stdout.emit('data', Buffer.from(lateMarker + '\n'));
  child.emit('close', 0); // only now have stdio streams truly finished — finalize must happen here

  const deadline = Date.now() + 2000;
  let content = '';
  while (Date.now() < deadline) {
    try {
      content = fs.readFileSync(paths.logFile, 'utf8');
      if (content.includes(lateMarker)) break;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.match(content, /before exit line/);
  assert.ok(content.includes(lateMarker), 'data delivered after "exit" but before "close" must still reach the log, never dropped');
});

test('SECURITY Codex K3-5: a crash between the temp-file write and the rename leaves the original .env completely intact', async () => {
  const paths = isolatedPaths({ envContent: 'TRANSPORT=mock\nRUNNER=fake\nOWNER_WEBHOOK_URL=https://keep.example/x\n' });
  _setDiscordPathsForTests(paths);
  _setSpawnFnForTests(() => makeFakeChild(7001));
  _setFetchFnForTests(async () => { throw new Error('unreachable'); });
  const originalContent = fs.readFileSync(paths.envFile, 'utf8');

  const originalRename = fs.renameSync;
  fs.renameSync = () => {
    throw new Error('simulated crash between the temp-file write and the rename');
  };
  try {
    const result = await connectDiscordService({ token: FAKE_TOKEN });
    assert.equal(result.ok, false);
    assert.match(result.error, /could not save the connection/);
  } finally {
    fs.renameSync = originalRename;
  }

  const afterCrash = fs.readFileSync(paths.envFile, 'utf8');
  assert.equal(afterCrash, originalContent, '.env must be exactly what it was before the simulated crash — never truncated, never partial');
  assert.equal(fs.existsSync(paths.envFile + '.lock'), false, 'the lock must be released even when the write fails');

  // The failed attempt must not have wedged anything — a real write right after must still succeed.
  const retry = await connectDiscordService({ token: FAKE_TOKEN });
  assert.equal(retry.ok, true, JSON.stringify(retry));
  const finalContent = fs.readFileSync(paths.envFile, 'utf8');
  assert.match(finalContent, /^OWNER_WEBHOOK_URL=https:\/\/keep\.example\/x$/m, 'unrelated pre-existing content must survive the whole sequence');
});

// ── WP-L2 finding 5/N3/N4: OWNERSHIP-AWARE .env lock ────────────────────────────────────────────
// Direct unit coverage via the test-only _acquireEnvLockForTests/_releaseEnvLockForTests seam —
// precise control over the lock file's own content/mtime, without racing the full write path.
function backdateMtime(filePath, ageMs) {
  const old = new Date(Date.now() - ageMs);
  fs.utimesSync(filePath, old, old);
}

test('WP-L2 finding 5/N3: a directory sitting at the lock path gives a bounded, clear error — never an unbounded spin', () => {
  const envFile = path.join(tempDir, '.env');
  const lockPath = envFile + '.lock';
  fs.mkdirSync(lockPath); // the exact "cannot be removed" shape Codex named
  backdateMtime(lockPath, 60_000); // well past ENV_LOCK_STALE_MS so the reclaim path is exercised, not just the plain wait

  const startedAt = Date.now();
  assert.throws(() => _acquireEnvLockForTests(envFile), /timed out|could not remove/i);
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs < 4000, `must fail bounded by ENV_LOCK_TIMEOUT_MS, not hang — took ${elapsedMs}ms`);
  assert.equal(fs.existsSync(lockPath), true, 'an un-removable directory is left in place, never partially destroyed');
});

test('WP-L2 finding 5: a lock whose owner pid is genuinely still ALIVE is never stolen, even long past the staleness window', () => {
  const envFile = path.join(tempDir, '.env');
  const lockPath = envFile + '.lock';
  const originalContent = JSON.stringify({ owner: 'the-original-live-owner', pid: process.pid, ts: Date.now() - 60_000 });
  fs.writeFileSync(lockPath, originalContent, 'utf8');
  backdateMtime(lockPath, 60_000); // far past ENV_LOCK_STALE_MS

  const startedAt = Date.now();
  assert.throws(
    () => _acquireEnvLockForTests(envFile),
    /timed out waiting for the lock/,
    'a live owner must make this a real, honest timeout — never a silent steal',
  );
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs < 4000, `must still be bounded by ENV_LOCK_TIMEOUT_MS — took ${elapsedMs}ms`);
  assert.equal(fs.readFileSync(lockPath, 'utf8'), originalContent, 'the live owner\'s lock content must be completely untouched — never stolen');
});

test('WP-L2 finding 5: a stale lock whose owner pid is confirmed DEAD is reclaimed and re-acquired', () => {
  const envFile = path.join(tempDir, '.env');
  const lockPath = envFile + '.lock';
  const deadPid = definitelyDeadPid();
  fs.writeFileSync(lockPath, JSON.stringify({ owner: 'a-crashed-previous-writer', pid: deadPid, ts: Date.now() - 60_000 }), 'utf8');
  backdateMtime(lockPath, 60_000);

  const lock = _acquireEnvLockForTests(envFile);
  assert.equal(lock.lockPath, lockPath);
  assert.equal(typeof lock.ownerId, 'string');
  const holder = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  assert.equal(holder.owner, lock.ownerId, 'the reclaimed lock must now show OUR fresh owner id, not the dead previous one');
  assert.equal(holder.pid, process.pid);
  _releaseEnvLockForTests(lock);
  assert.equal(fs.existsSync(lockPath), false, 'our own release must clean up the lock we just legitimately acquired');
});

test('WP-L2 finding N4: release() never deletes a lock that now belongs to a DIFFERENT owner', () => {
  const envFile = path.join(tempDir, '.env');
  const lockPath = envFile + '.lock';
  const lock = _acquireEnvLockForTests(envFile);

  // Simulate a race: between our acquisition and our release, the lock was reclaimed by someone
  // else (e.g. this process itself lost the lock past the staleness window and a new writer took
  // over) — the file at lockPath now genuinely belongs to a DIFFERENT owner id.
  const otherOwnerContent = JSON.stringify({ owner: 'a-completely-different-owner', pid: process.pid, ts: Date.now() });
  fs.writeFileSync(lockPath, otherOwnerContent, 'utf8');

  _releaseEnvLockForTests(lock); // using the OLD lock object — must be a no-op against the new owner
  assert.equal(fs.existsSync(lockPath), true, 'release must never delete a lock it does not currently own');
  assert.equal(fs.readFileSync(lockPath, 'utf8'), otherOwnerContent, 'the other owner\'s lock content must be completely untouched');
});
