// Discord autostart (v2.9.0 WP-DA) — the Discord bot comes back by itself when the Command Center
// starts, so a reboot or a supervisor restart never silently leaves the owner's remote control off.
//
// Before this, the bot only ever started from a dashboard click (switch, Connect Discord, server
// pick). After a reboot it stayed off, and a crash-restart of the gateway even STOPPED it (bin.mjs's
// drain stops the child) with nothing starting it again — a beginner does not know to flip a switch.
//
// The rule, in order (every "no" is reported in plain words, never silently):
//   1. CC_DISCORD_AUTOSTART=off in this process's environment -> never (temp/test gateways set this, so
//      a test run can never start the owner's real bot).
//   2. The owner setting `discord-autostart` (FORGE_CONFIG_SCHEMA.json, default ON, machine-wide) is off
//      -> never. When the setting cannot be read, the bot is NOT started: the setting carries disclosure
//      flags (internet, unattended, quota), and Forge's fail-safe rule (forge-config.cjs FAILSAFE_FLAGGED)
//      is that such a setting falls back to OFF, never silently on. The note says so in plain words.
//   3. The owner switched the bot OFF themselves (dashboard switch) -> it stays off until they switch it
//      on again. That choice is remembered in `<discord data dir>/desired-state.json`, written only by
//      the owner's own actions (the routes in server.mjs), never by a crash drain or by this module.
//      A choice file that exists but cannot be read counts as "unknown" -> not started (fail-safe too).
//   4. Discord is not installed or not connected yet (no bot token; checked by NAME only through
//      getDiscordStatus()'s env_keys, a value is never read here) -> nothing to start.
//   5. The bot already runs, or something already answers on its port -> no second bot.
//   6. Otherwise: startDiscordService(), the exact same start every dashboard click uses.
//
// Codex stop-review 2026-09-28 (DA-1, DA-2): the status block reports READINESS separately (so the
// dashboard never promises an autostart for a bot that is not connected, or whose last start failed),
// and a failed save of the owner's choice is kept and reported (routes answer remembered:false with a
// plain warning, and the status block carries save_error) instead of only being logged.
//
// Codex run B F-08: steps 3 to 6 run as ONE queued Discord operation (discord-ops.mjs), the same queue
// the dashboard's start/stop/connect/server routes use. A stop the owner clicks while boot is still
// checking therefore waits until boot's start is done and then stops the bot; before, boot went on to
// start the bot from a choice it had read before the owner switched it off.
import fs from 'node:fs';
import path from 'node:path';
import { getDiscordStateDir, getDiscordStatus, startDiscordService } from './discord-service.mjs';
import { runDiscordOperation } from './discord-ops.mjs';
import { buildForgeConfig } from './config.mjs';
import { PROJECT_ROOT } from './paths.mjs';
import { redact, stripDiscordIds } from './redact.mjs';

export const AUTOSTART_SETTING_KEY = 'discord-autostart';
export const AUTOSTART_ENV_OPT_OUT = 'CC_DISCORD_AUTOSTART';

/** Why this gateway process must never start the bot by itself, or null. Besides the explicit
 *  CC_DISCORD_AUTOSTART=off, a process that is recognisably a TEST refuses on its own (defense in depth,
 *  found live 2026-09-28: the source doctor's gateway-drain test started the real gateway from the real
 *  command-center folder, which shares the owner's .data and Discord token, and that test gateway
 *  started the owner's real bot): CC_TEST_THROW_AFTER_MS (the gateway's own fault-injection hook) and
 *  NODE_TEST_CONTEXT (set by `node --test` for everything it runs). */
export function autostartOptOutReason(env) {
  const e = env || {};
  if (String(e[AUTOSTART_ENV_OPT_OUT] || '').toLowerCase() === 'off') return 'turned off for this gateway process (' + AUTOSTART_ENV_OPT_OUT + '=off)';
  if (e.CC_TEST_THROW_AFTER_MS) return 'this is a fault-injection test gateway (CC_TEST_THROW_AFTER_MS), which never starts the real bot';
  if (e.NODE_TEST_CONTEXT) return 'this gateway runs under the Node test runner (NODE_TEST_CONTEXT), which never starts the real bot';
  return null;
}
const TOKEN_ENV_NAME = 'DISCORD_BOT_TOKEN';
const DESIRED_VALUES = new Set(['running', 'stopped']);
const BY_VALUES = new Set(['dashboard', 'connect', 'guild']);
const DETAIL_MAX_CHARS = 300;

// ---- the owner's own on/off choice ------------------------------------------------------------------

let desiredStateFileOverride = null;
/** Test seam: points the remembered choice at a temp file. Production code never calls it. */
export function _setDesiredStateFileForTests(file) { desiredStateFileOverride = file; }

/** `<discord data dir>/desired-state.json` — next to the bot's own state folder, owned by the gateway. */
export function desiredStateFile() {
  return desiredStateFileOverride || path.join(path.dirname(getDiscordStateDir()), 'desired-state.json');
}

/** The owner's last own choice:
 *   - null                                   no choice was ever recorded (the file does not exist);
 *   - { desired, by, at, invalid: false }    a readable choice;
 *   - { desired: null, invalid: true, ... }  the file exists but cannot be read or is not a valid choice.
 *  "invalid" is deliberately NOT the same as "no choice": autostart treats it as unknown and does not
 *  start the bot (fail-safe), because it may well have said "stopped". */
export function readDesiredState() {
  let raw;
  try {
    raw = fs.readFileSync(desiredStateFile(), 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    return { desired: null, by: null, at: null, invalid: true, reason: 'the saved choice could not be read (' + ((err && err.code) || 'error') + ')' };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !DESIRED_VALUES.has(parsed.desired)) {
      return { desired: null, by: null, at: null, invalid: true, reason: 'the saved choice is not a valid on/off choice' };
    }
    return {
      desired: parsed.desired,
      by: BY_VALUES.has(parsed.by) ? parsed.by : null,
      at: typeof parsed.at === 'string' ? parsed.at.slice(0, 40) : null,
      invalid: false,
    };
  } catch {
    return { desired: null, by: null, at: null, invalid: true, reason: 'the saved choice is damaged' };
  }
}

let lastSaveError = null; // { at, desired, detail } of the last failed save, cleared by the next successful one

/** The plain warning a route returns when the owner's choice could not be saved (DA-2). */
export function saveWarningFor(desired) {
  return desired === 'stopped'
    ? 'The bot stopped, but Forge could not save that you switched it off, so it may start again by itself the next time the Command Center starts. Switch it off once more; if this keeps happening, turn off "discord-autostart" in Settings.'
    : 'The bot started, but Forge could not save that you switched it on, so after a restart it follows your previous choice. Switch it on once more to save it.';
}

/** Remembers the owner's own choice ('running' | 'stopped'), written atomically (temp file + rename, so a
 *  symlink at the target is replaced, never followed). Returns true when saved. On a failure it returns
 *  false AND keeps the failure for GET /api/discord/status (save_error), so the caller and the dashboard
 *  can both say it was not saved (DA-2); the next successful save clears it. */
export function recordDesiredState(desired, by, now = new Date()) {
  if (!DESIRED_VALUES.has(desired)) throw new Error('recordDesiredState: desired must be running or stopped');
  const file = desiredStateFile();
  const tmp = file + '.' + process.pid + '.tmp';
  const body = JSON.stringify({ desired, by: BY_VALUES.has(by) ? by : 'dashboard', at: now.toISOString() }) + '\n';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, file);
    lastSaveError = null;
    return true;
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* nothing was written */ }
    lastSaveError = {
      at: now.toISOString(),
      desired,
      detail: redact('could not save the "' + desired + '" choice (' + ((err && err.code) || (err && err.message) || 'error') + ')').slice(0, DETAIL_MAX_CHARS),
    };
    return false;
  }
}

// ---- the owner setting ------------------------------------------------------------------------------

/** { value: true|false|null, note } — null when the setting cannot be read (then autostart stays off: the
 *  fail-safe rule above). Reads through config.mjs, i.e. the gateway's own central forge-config.cjs
 *  `list`, cached there for 30 s, so the frequent status poll costs nothing extra. */
export async function readAutostartSetting() {
  try {
    const cfg = await buildForgeConfig(PROJECT_ROOT);
    if (!cfg || cfg.available !== true) {
      return { value: null, note: 'Forge settings could not be read' + (cfg && cfg.note ? ' (' + cfg.note + ')' : '') };
    }
    const row = (cfg.settings || []).find((s) => s && s.key === AUTOSTART_SETTING_KEY);
    if (!row) return { value: null, note: 'this Forge version has no discord-autostart setting yet' };
    return { value: row.value === true, note: null };
  } catch (err) {
    return { value: null, note: 'Forge settings could not be read (' + (err && err.message ? err.message : String(err)) + ')' };
  }
}

// ---- readiness ---------------------------------------------------------------------------------------

/** { ready, reason } — can the bot be started at all right now? Installed and connected (a bot token is
 *  present, checked by NAME only). A missing status counts as not ready, never as a guess. */
export function readinessOf(status) {
  if (!status || status.installed !== true) return { ready: false, reason: 'the Discord service is not installed' };
  const tokenKey = (status.env_keys || []).find((k) => k && k.name === TOKEN_ENV_NAME);
  if (!tokenKey || tokenKey.present !== true) return { ready: false, reason: 'Discord is not connected yet (no bot token saved)' };
  return { ready: true, reason: null };
}

// ---- the boot-time autostart ------------------------------------------------------------------------

let lastAutostart = null; // { at, outcome: 'started'|'skipped'|'failed', detail }

/** Runs once when the gateway has started listening (bin.mjs). Never throws: every outcome, including
 *  an unexpected error, comes back as { at, outcome, detail } and is kept for GET /api/discord/status.
 *  From reading the owner's choice up to the start it holds the Discord operation queue (F-08).
 *  `deps` are test seams (readSetting, getStatus, start, env, now); production passes none. */
export async function autostartDiscordOnBoot(deps = {}) {
  const readSetting = deps.readSetting || readAutostartSetting;
  const getStatus = deps.getStatus || getDiscordStatus;
  const start = deps.start || startDiscordService;
  const env = deps.env || process.env;
  const now = deps.now || (() => new Date());
  const finish = (outcome, detail) => {
    lastAutostart = { at: now().toISOString(), outcome, detail: redact(stripDiscordIds(String(detail))).slice(0, DETAIL_MAX_CHARS) };
    return lastAutostart;
  };
  try {
    const optOut = autostartOptOutReason(env);
    if (optOut) return finish('skipped', optOut);
    const setting = await readSetting();
    if (setting.value === false) {
      return finish('skipped', 'the discord-autostart setting is off (turn it on with /forge config set discord-autostart on)');
    }
    if (setting.value !== true) {
      return finish('skipped', (setting.note || 'the discord-autostart setting could not be read') +
        ', so the bot was not started automatically (a setting that runs unattended stays off when it cannot be read)');
    }
    return await runDiscordOperation(async () => {
      const desired = readDesiredState();
      if (desired && desired.invalid) {
        return finish('skipped', desired.reason + ', so the bot was not started automatically; switch it on in the dashboard to start it and save your choice again');
      }
      if (desired && desired.desired === 'stopped') {
        return finish('skipped', 'you switched the bot off yourself; it stays off until you switch it on again');
      }
      const status = await getStatus();
      const readiness = readinessOf(status);
      if (!readiness.ready) return finish('skipped', readiness.reason);
      if (status.running === true) return finish('skipped', 'the bot is already running');
      if (status.conflict) return finish('skipped', 'something already answers on the bot port, so no second bot is started');
      const result = await start();
      if (result && result.ok) {
        return finish('started', 'started automatically' + (result.pid ? ' (pid ' + result.pid + ')' : ''));
      }
      return finish('failed', (result && result.error) || 'the start was refused');
    });
  } catch (err) {
    return finish('failed', err && err.message ? err.message : String(err));
  }
}

/** The autostart block of GET /api/discord/status. `effective` answers the owner's real question:
 *  "will the bot try to start by itself next time the Command Center starts?" — true only when EVERY
 *  condition autostartDiscordOnBoot() checks would let it through: the setting is on, this gateway
 *  process has no CC_DISCORD_AUTOSTART=off, the owner did not switch it off (and their choice is
 *  readable), the bot is ready (installed and connected), and nothing else occupies the bot port.
 *  `ready`/`ready_reason`, `env_opt_out`, `conflict`, `last` (the last boot's outcome) and `save_error`
 *  let the dashboard say exactly why not, or that the last automatic start failed (Codex DA-1, DA-3).
 *  deps: { status } — the getDiscordStatus() result the caller already has; readSetting, env (tests). */
export async function getAutostartInfo(deps = {}) {
  const readSetting = deps.readSetting || readAutostartSetting;
  const env = deps.env || process.env;
  const setting = await readSetting();
  const desired = readDesiredState();
  const readiness = readinessOf(deps.status);
  const desiredInvalid = !!(desired && desired.invalid);
  const envOptOut = autostartOptOutReason(env) !== null;
  // DA-3: a conflict (another process already answers on the bot port) makes boot skip the start;
  // reported here so the dashboard never promises a start the gateway would refuse.
  const conflict = deps.status && typeof deps.status.conflict === 'string' && deps.status.conflict ? redact(stripDiscordIds(deps.status.conflict)) : null;
  return {
    setting: setting.value,
    setting_note: setting.note,
    desired: desired && !desiredInvalid ? desired.desired : null,
    desired_by: desired && !desiredInvalid ? desired.by : null,
    desired_at: desired && !desiredInvalid ? desired.at : null,
    desired_invalid: desiredInvalid,
    desired_note: desiredInvalid ? desired.reason : null,
    ready: readiness.ready,
    ready_reason: readiness.reason,
    env_opt_out: envOptOut,
    conflict,
    effective: setting.value === true && !envOptOut && !desiredInvalid && !(desired && desired.desired === 'stopped') && readiness.ready && conflict === null,
    last: lastAutostart,
    save_error: lastSaveError,
  };
}

/** Test seam: forgets the last boot outcome, the last save error and the file override between tests. */
export function _resetAutostartForTests() { lastAutostart = null; lastSaveError = null; desiredStateFileOverride = null; }
