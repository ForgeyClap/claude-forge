// v2.9.0 WP-DA — unit coverage for discord-autostart.mjs: the Discord bot comes back by itself when the
// Command Center starts, unless the owner said otherwise. Every case injects its own setting/status/start
// fakes and a temp desired-state file, so nothing here reads the real bot state or starts a real bot.
// Codex stop-review 2026-09-28: DA-1 (readiness reported separately; never "yes" for a bot that cannot
// start) and DA-2 (a failed save of the owner's choice is kept and reported, never only logged).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  autostartDiscordOnBoot,
  getAutostartInfo,
  readDesiredState,
  recordDesiredState,
  readinessOf,
  saveWarningFor,
  _setDesiredStateFileForTests,
  _resetAutostartForTests,
} from '../src/discord-autostart.mjs';
import { runDiscordOperation } from '../src/discord-ops.mjs';

const FIXED_NOW = new Date(Date.UTC(2026, 8, 28, 9, 0, 0));
// Token-shaped (three dot-separated parts) so redact.mjs's DISCORD_BOT_TOKEN pattern fires; built from
// pieces, the same way redact.test.mjs does, so this file never holds one literal token-shaped value.
const FAKE_TOKEN = ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'Gx2abc', 'abcdefghijklmnopqrstuvwxyz0123'].join('.');
const SETTING_ON = async () => ({ value: true, note: null });

let dir;
let file;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-discord-autostart-test-'));
  file = path.join(dir, 'desired-state.json');
  _resetAutostartForTests();
  _setDesiredStateFileForTests(file);
});

afterEach(() => {
  _resetAutostartForTests();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

/** A connected, installed, stopped bot — the state in which autostart must start it. */
function readyStatus(overrides = {}) {
  return {
    installed: true,
    running: false,
    conflict: null,
    env_keys: [{ name: 'DISCORD_BOT_TOKEN', present: true }, { name: 'TRANSPORT', present: true }],
    ...overrides,
  };
}

function deps({ setting = { value: true, note: null }, status = readyStatus(), start, env = {} } = {}) {
  const calls = { start: 0 };
  return {
    calls,
    readSetting: async () => setting,
    getStatus: async () => status,
    start: start || (async () => { calls.start += 1; return { ok: true, status: 202, pid: 4242 }; }),
    env,
    now: () => FIXED_NOW,
  };
}

// ---- the remembered choice ----------------------------------------------------------------------------

test('desired state: nothing recorded yet reads null; a recorded choice reads back', () => {
  assert.equal(readDesiredState(), null);
  assert.equal(recordDesiredState('stopped', 'dashboard', FIXED_NOW), true);
  assert.deepEqual(readDesiredState(), { desired: 'stopped', by: 'dashboard', at: FIXED_NOW.toISOString(), invalid: false });
  assert.equal(recordDesiredState('running', 'connect', FIXED_NOW), true);
  assert.equal(readDesiredState().desired, 'running');
  assert.equal(readDesiredState().by, 'connect');
  assert.deepEqual(fs.readdirSync(dir), ['desired-state.json'], 'no temp file is left behind');
});

test('desired state: a damaged or invalid file is "unknown" (invalid), never "no choice" and never a guess', () => {
  fs.writeFileSync(file, '{not json', 'utf8');
  assert.equal(readDesiredState().invalid, true);
  assert.equal(readDesiredState().desired, null);
  fs.writeFileSync(file, JSON.stringify({ desired: 'paused' }), 'utf8');
  assert.equal(readDesiredState().invalid, true);
  fs.writeFileSync(file, JSON.stringify({ desired: 'stopped', by: 'something-else' }), 'utf8');
  assert.deepEqual(readDesiredState(), { desired: 'stopped', by: null, at: null, invalid: false });
});

test('desired state: only running/stopped can be recorded', () => {
  assert.throws(() => recordDesiredState('paused', 'dashboard'), /running or stopped/);
});

test('DA-2: a failed save returns false, is kept as save_error, and the next good save clears it', async () => {
  fs.mkdirSync(file); // a folder where the file must go: the atomic rename fails
  assert.equal(recordDesiredState('stopped', 'dashboard', FIXED_NOW), false);
  const info = await getAutostartInfo({ env: {}, readSetting: SETTING_ON, status: readyStatus() });
  assert.ok(info.save_error, 'save_error is reported');
  assert.equal(info.save_error.desired, 'stopped');
  assert.match(info.save_error.detail, /could not save the "stopped" choice/);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], 'no temp file is left behind');

  fs.rmSync(file, { recursive: true, force: true });
  assert.equal(recordDesiredState('stopped', 'dashboard', FIXED_NOW), true);
  const after = await getAutostartInfo({ env: {}, readSetting: SETTING_ON, status: readyStatus() });
  assert.equal(after.save_error, null, 'a later successful save clears the error');
});

test('DA-2: the save warning says plainly what the failure means for each choice', () => {
  assert.match(saveWarningFor('stopped'), /could not save that you switched it off, so it may start again by itself/);
  assert.match(saveWarningFor('running'), /could not save that you switched it on/);
});

// ---- readiness ------------------------------------------------------------------------------------------

test('DA-1: readiness needs an installed service with a bot token (by name); a missing status is not ready', () => {
  assert.deepEqual(readinessOf(readyStatus()), { ready: true, reason: null });
  assert.match(readinessOf(readyStatus({ installed: false })).reason, /not installed/);
  assert.match(readinessOf(readyStatus({ env_keys: [{ name: 'DISCORD_BOT_TOKEN', present: false }] })).reason, /not connected yet/);
  assert.match(readinessOf(readyStatus({ env_keys: [] })).reason, /not connected yet/);
  assert.equal(readinessOf(undefined).ready, false);
});

// ---- the boot-time autostart ------------------------------------------------------------------------------

test('autostart: a connected, stopped bot is started once, with the pid in the note', async () => {
  const d = deps();
  const r = await autostartDiscordOnBoot(d);
  assert.equal(r.outcome, 'started');
  assert.match(r.detail, /pid 4242/);
  assert.equal(d.calls.start, 1);
  assert.equal(r.at, FIXED_NOW.toISOString());
});

test('autostart: CC_DISCORD_AUTOSTART=off (test/temp gateways) never starts the bot', async () => {
  const d = deps({ env: { CC_DISCORD_AUTOSTART: 'off' } });
  const r = await autostartDiscordOnBoot(d);
  assert.equal(r.outcome, 'skipped');
  assert.match(r.detail, /CC_DISCORD_AUTOSTART=off/);
  assert.equal(d.calls.start, 0);
});

test('autostart: a recognisable test gateway never starts the real bot, even without the explicit opt-out', async () => {
  const faultInjection = deps({ env: { CC_TEST_THROW_AFTER_MS: '2500' } });
  const r1 = await autostartDiscordOnBoot(faultInjection);
  assert.equal(r1.outcome, 'skipped');
  assert.match(r1.detail, /fault-injection test gateway/);
  assert.equal(faultInjection.calls.start, 0);

  const nodeTest = deps({ env: { NODE_TEST_CONTEXT: 'child-v8' } });
  const r2 = await autostartDiscordOnBoot(nodeTest);
  assert.equal(r2.outcome, 'skipped');
  assert.match(r2.detail, /Node test runner/);
  assert.equal(nodeTest.calls.start, 0);

  const info = await getAutostartInfo({ env: {}, readSetting: SETTING_ON, status: readyStatus(), env: { CC_TEST_THROW_AFTER_MS: '1' } });
  assert.equal(info.env_opt_out, true);
  assert.equal(info.effective, false);
});

test('autostart: the discord-autostart setting off means no start, and says how to turn it on', async () => {
  const d = deps({ setting: { value: false, note: null } });
  const r = await autostartDiscordOnBoot(d);
  assert.equal(r.outcome, 'skipped');
  assert.match(r.detail, /discord-autostart setting is off/);
  assert.match(r.detail, /\/forge config set discord-autostart on/);
  assert.equal(d.calls.start, 0);
});

test('autostart: an unreadable setting is treated as OFF (fail-safe for a setting that runs unattended), and says so', async () => {
  const d = deps({ setting: { value: null, note: 'Forge settings could not be read' } });
  const r = await autostartDiscordOnBoot(d);
  assert.equal(r.outcome, 'skipped');
  assert.match(r.detail, /could not be read, so the bot was not started automatically/);
  assert.equal(d.calls.start, 0);
});

test('autostart: the owner switched the bot off themselves, so it stays off', async () => {
  recordDesiredState('stopped', 'dashboard', FIXED_NOW);
  const d = deps();
  const r = await autostartDiscordOnBoot(d);
  assert.equal(r.outcome, 'skipped');
  assert.match(r.detail, /switched the bot off yourself/);
  assert.equal(d.calls.start, 0);
});

test('autostart: an unreadable saved choice is not started (it may have said "off"), and says how to fix it', async () => {
  fs.writeFileSync(file, '{damaged', 'utf8');
  const d = deps();
  const r = await autostartDiscordOnBoot(d);
  assert.equal(r.outcome, 'skipped');
  assert.match(r.detail, /damaged, so the bot was not started automatically; switch it on in the dashboard/);
  assert.equal(d.calls.start, 0);
});

test('autostart: the owner switched it on again, so it starts', async () => {
  recordDesiredState('stopped', 'dashboard', FIXED_NOW);
  recordDesiredState('running', 'dashboard', FIXED_NOW);
  const d = deps();
  assert.equal((await autostartDiscordOnBoot(d)).outcome, 'started');
  assert.equal(d.calls.start, 1);
});

test('autostart: not installed, or not connected yet (no token), means nothing to start', async () => {
  const notInstalled = deps({ status: readyStatus({ installed: false }) });
  assert.match((await autostartDiscordOnBoot(notInstalled)).detail, /not installed/);
  assert.equal(notInstalled.calls.start, 0);

  const noToken = deps({ status: readyStatus({ env_keys: [{ name: 'DISCORD_BOT_TOKEN', present: false }] }) });
  const r = await autostartDiscordOnBoot(noToken);
  assert.equal(r.outcome, 'skipped');
  assert.match(r.detail, /not connected yet/);
  assert.equal(noToken.calls.start, 0);
});

test('autostart: an already running bot, or something on the bot port, is never started twice', async () => {
  const running = deps({ status: readyStatus({ running: true }) });
  assert.match((await autostartDiscordOnBoot(running)).detail, /already running/);
  assert.equal(running.calls.start, 0);

  const conflict = deps({ status: readyStatus({ conflict: 'a process is already answering on port 3979' }) });
  assert.match((await autostartDiscordOnBoot(conflict)).detail, /already answers on the bot port/);
  assert.equal(conflict.calls.start, 0);
});

test('autostart: a refused start is reported as failed, with any token redacted', async () => {
  const d = deps({ start: async () => ({ ok: false, status: 503, error: 'login failed for ' + FAKE_TOKEN }) });
  const r = await autostartDiscordOnBoot(d);
  assert.equal(r.outcome, 'failed');
  assert.ok(r.detail.includes('[REDACTED:DISCORD_BOT_TOKEN]'), r.detail);
  assert.ok(!r.detail.includes(FAKE_TOKEN));
});

test('autostart: an unexpected error never escapes; it is reported as failed', async () => {
  const d = deps();
  d.getStatus = async () => { throw new Error('status probe exploded'); };
  const r = await autostartDiscordOnBoot(d);
  assert.equal(r.outcome, 'failed');
  assert.match(r.detail, /status probe exploded/);
});

// ---- the status block ----------------------------------------------------------------------------------------

test('status info: effective only when the setting is on, not switched off, AND the bot is ready (DA-1)', async () => {
  const on = await getAutostartInfo({ env: {}, readSetting: SETTING_ON, status: readyStatus() });
  assert.equal(on.effective, true);
  assert.equal(on.ready, true);
  assert.equal(on.desired, null);
  assert.equal(on.last, null);
  assert.equal(on.save_error, null);

  const noToken = await getAutostartInfo({ env: {}, readSetting: SETTING_ON, status: readyStatus({ env_keys: [] }) });
  assert.equal(noToken.effective, false, 'a bot that is not connected is never promised an autostart');
  assert.equal(noToken.ready, false);
  assert.match(noToken.ready_reason, /not connected yet/);

  const notInstalled = await getAutostartInfo({ env: {}, readSetting: SETTING_ON, status: readyStatus({ installed: false }) });
  assert.equal(notInstalled.effective, false);

  const noStatus = await getAutostartInfo({ env: {}, readSetting: SETTING_ON });
  assert.equal(noStatus.effective, false, 'without a status there is no readiness claim');

  const unreadable = await getAutostartInfo({ env: {}, readSetting: async () => ({ value: null, note: 'x' }), status: readyStatus() });
  assert.equal(unreadable.effective, false);
});

test('DA-3: a conflict on the bot port, or CC_DISCORD_AUTOSTART=off for this process, is never reported as "will start"', async () => {
  const conflict = await getAutostartInfo({
    readSetting: SETTING_ON,
    status: readyStatus({ conflict: 'a process is already answering on port 3979 — this gateway did not start it' }),
    env: {},
  });
  assert.equal(conflict.effective, false, 'boot would skip on a conflict, so the status must not promise a start');
  assert.match(conflict.conflict, /already answering on port 3979/);
  assert.equal(conflict.ready, true, 'readiness itself is unaffected; the conflict is reported on its own');

  const optOut = await getAutostartInfo({ env: {}, readSetting: SETTING_ON, status: readyStatus(), env: { CC_DISCORD_AUTOSTART: 'off' } });
  assert.equal(optOut.effective, false);
  assert.equal(optOut.env_opt_out, true);

  const clear = await getAutostartInfo({ env: {}, readSetting: SETTING_ON, status: readyStatus(), env: {} });
  assert.equal(clear.effective, true);
  assert.equal(clear.conflict, null);
  assert.equal(clear.env_opt_out, false);
});

test('status info: the owner\'s off, an unreadable choice, and the last boot outcome are all reported', async () => {
  recordDesiredState('stopped', 'dashboard', FIXED_NOW);
  const off = await getAutostartInfo({ env: {}, readSetting: SETTING_ON, status: readyStatus() });
  assert.equal(off.effective, false);
  assert.equal(off.desired, 'stopped');
  assert.equal(off.desired_by, 'dashboard');

  fs.writeFileSync(file, '{damaged', 'utf8');
  const damaged = await getAutostartInfo({ env: {}, readSetting: SETTING_ON, status: readyStatus() });
  assert.equal(damaged.effective, false);
  assert.equal(damaged.desired_invalid, true);
  assert.match(damaged.desired_note, /damaged/);

  recordDesiredState('running', 'dashboard', FIXED_NOW);
  await autostartDiscordOnBoot(deps({ start: async () => ({ ok: false, status: 503, error: 'no claude CLI found' }) }));
  const failed = await getAutostartInfo({ env: {}, readSetting: SETTING_ON, status: readyStatus() });
  assert.equal(failed.last.outcome, 'failed');
  assert.match(failed.last.detail, /no claude CLI found/);
});

// ---- Codex run B F-08: boot and the owner's own clicks never interleave -------------------------------

test('F-08: a stop clicked while boot is still checking the bot waits for boot, then stops it (the stop wins)', async () => {
  const order = [];
  let releaseStatus;
  let statusAsked;
  const statusGate = new Promise((r) => { releaseStatus = r; });
  const bootIsChecking = new Promise((r) => { statusAsked = r; });
  const boot = autostartDiscordOnBoot({
    ...deps(),
    getStatus: async () => { statusAsked(); await statusGate; return readyStatus(); },
    start: async () => { order.push('start'); return { ok: true, status: 202, pid: 4242 }; },
  });
  // Boot has read "no choice yet" and is now waiting for the bot's status: the old race window.
  await bootIsChecking;
  // What POST /api/discord/stop does: the stop and the saved "off" as one queued operation.
  const stop = runDiscordOperation(async () => {
    order.push('stop');
    recordDesiredState('stopped', 'dashboard', FIXED_NOW);
  });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, [], 'the stop waits while boot is still checking');
  releaseStatus();
  await Promise.all([boot, stop]);
  assert.deepEqual(order, ['start', 'stop'], 'the stop comes last, so the bot ends up off');
  assert.equal(readDesiredState().desired, 'stopped');
});

test('F-08: a stop that got in before boot means boot sees the owner\'s "off" and never starts the bot', async () => {
  const d = deps();
  const stop = runDiscordOperation(async () => {
    await new Promise((r) => setImmediate(r));
    recordDesiredState('stopped', 'dashboard', FIXED_NOW);
  });
  const outcome = await autostartDiscordOnBoot(d);
  await stop;
  assert.equal(d.calls.start, 0);
  assert.equal(outcome.outcome, 'skipped');
  assert.match(outcome.detail, /you switched the bot off yourself/);
});

test('F-10: a Discord id in a start error or a port conflict never reaches the status block', async () => {
  const failed = await autostartDiscordOnBoot(deps({ start: async () => ({ ok: false, status: 500, error: 'Unknown Channel 123456789012345678' }) }));
  assert.doesNotMatch(failed.detail, /\d{17}/);
  assert.match(failed.detail, /Unknown Channel \[discord id\]/);
  const info = await getAutostartInfo({ env: {}, readSetting: SETTING_ON, status: readyStatus({ conflict: 'guild 1532155925555576001 already has a bot on this port' }) });
  assert.doesNotMatch(info.conflict, /\d{17}/);
});
