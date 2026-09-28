// GET /api/usage source: ~/.claude/FORGE_USAGE_PRESSURE.json — account-wide, no `?project=` (the
// literal WP3 endpoint shape carries none). This file is written by the owner's usage-guard
// tooling, never by this gateway. provenance is 'REPORTED' (matching this project's own
// capability-map wording for this exact source: "provenance REPORTED (official endpoint)") when
// real data is read; an absent file is honestly 'NOT CONFIGURED', never a fabricated number.
//
// WP7c addition: `guard` — the usage-guard's OWN pause/resume state, read from the SEPARATE
// ~/.claude/FORGE_USAGE_GUARD_STATE.json file (`forge-bin/usage-guard.cjs`'s `readState()`/
// `writeState()`). Read independently and best-effort: a missing/unparseable guard-state file
// never blocks the pressure fields above from being reported, and vice versa — the two files are
// written by the same tool but on different schedules, so either can legitimately be present
// without the other.
import fs from 'node:fs';
import { FORGE_USAGE_PRESSURE_FILE, FORGE_USAGE_GUARD_STATE_FILE, FORGE_USAGE_GUARD_PID_FILE } from './paths.mjs';
// WP-CC1 (Lead review, LOW): `last_error` is free text written by a SEPARATE tool (usage-guard.cjs)
// — the same reasoning recovery.mjs already applies to its own whole-file reads (sec-delta F1: "a
// stray credential accidentally logged/echoed ... is the realistic path"). redactNullable() passes
// the honest `null` case through untouched and only ever redacts an actual string.
import { redactNullable } from './redact.mjs';

// fix-test-hygiene: test-only override seam, mirroring the existing convention used throughout
// this codebase (conversations.mjs's `_setConversationsDirForTests`, models.mjs's
// `_setNvidiaProviderCjsForTests`). Without this, buildUsage() always reads the REAL, machine-owned
// ~/.claude/FORGE_USAGE_PRESSURE.json / FORGE_USAGE_GUARD_STATE.json — so a test asserting on it
// depends on whatever this one machine happens to have on disk right now (present or absent), which
// is not reproducible on a fresh clone/CI and never exercises the "file absent" branch at all.
// Production code never calls either setter — only gateway tests do, always pointed at an isolated
// temp path (or a deliberately non-existent one to prove the honest fallback branch).
let pressureFileOverride = null;
let guardStateFileOverride = null;
function activePressureFile() { return pressureFileOverride || FORGE_USAGE_PRESSURE_FILE; }
function activeGuardStateFile() { return guardStateFileOverride || FORGE_USAGE_GUARD_STATE_FILE; }
export function _setUsagePressureFileForTests(p) { pressureFileOverride = p; }
export function _setUsageGuardStateFileForTests(p) { guardStateFileOverride = p; }
let guardPidFileOverride = null;
let pidAliveOverride = null;
function activeGuardPidFile() { return guardPidFileOverride || FORGE_USAGE_GUARD_PID_FILE; }
export function _setUsageGuardPidFileForTests(p) { guardPidFileOverride = p; }
export function _setPidAliveForTests(fn) { pidAliveOverride = fn; }

// ---- is the guard's watcher really running? ------------------------------------------------------
// A guard state that says mode "ok" is only a promise while its watcher process runs: after a reboot
// the state file stays "ok" but nothing checks usage any more, and the dashboard used to show
// "Guard Active" regardless (found live 2026-09-28). Same rule as usage-guard.cjs's own `status`
// (watcherHealth): no live pid is "not-running"; a live pid whose heartbeat is older than three check
// intervals is "stale" (the process hangs, or the pid was reused by another program); no heartbeat at
// all is honestly "unknown", never a green light.
export const DEFAULT_GUARD_INTERVAL_SEC = 120; // usage-guard.cjs's default `usage-guard.interval`
const MIN_GUARD_INTERVAL_SEC = 30; // usage-guard.cjs: INTERVAL = Math.max(30, configured)

function readGuardPid() {
  let raw;
  try { raw = fs.readFileSync(activeGuardPidFile(), 'utf8').trim(); } catch { return 0; }
  if (!raw) return 0;
  try {
    const j = JSON.parse(raw);
    if (j && typeof j === 'object') return Number.isInteger(Number(j.pid)) && Number(j.pid) > 0 ? Number(j.pid) : 0;
  } catch { /* a bare number from an older guard build */ }
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

function pidIsAlive(pid) {
  if (pidAliveOverride) return pidAliveOverride(pid);
  try { process.kill(pid, 0); return true; } catch (err) { return !!(err && err.code === 'EPERM'); }
}

function watcherHealth(nowMs, heartbeatIso, intervalSec) {
  const interval = Number.isFinite(intervalSec) && intervalSec > 0 ? Math.max(MIN_GUARD_INTERVAL_SEC, intervalSec) : DEFAULT_GUARD_INTERVAL_SEC;
  const pid = readGuardPid();
  if (!pid || !pidIsAlive(pid)) return { watcher: 'not-running', watcher_stale_sec: null, watcher_interval_sec: interval };
  const ms = heartbeatIso ? Date.parse(heartbeatIso) : NaN;
  if (!Number.isFinite(ms)) return { watcher: 'unknown', watcher_stale_sec: null, watcher_interval_sec: interval };
  const staleSec = Math.max(0, Math.round((nowMs - ms) / 1000));
  return { watcher: staleSec > interval * 3 ? 'stale' : 'running', watcher_stale_sec: staleSec, watcher_interval_sec: interval };
}

function readGuardState(nowMs, intervalSec) {
  let raw;
  try {
    raw = fs.readFileSync(activeGuardStateFile(), 'utf8');
  } catch {
    return { available: false, note: 'no FORGE_USAGE_GUARD_STATE.json found under the OS home .claude dir' };
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return { available: false, note: 'FORGE_USAGE_GUARD_STATE.json present but could not be parsed: ' + err.message };
  }
  const lastCheckMs = data.lastCheckAt ? Date.parse(data.lastCheckAt) : NaN;
  const ageMs = Number.isFinite(lastCheckMs) ? nowMs - lastCheckMs : null;
  // WP-CC1 (item 13): the guard-state file also carries the real session%/week% measurements, when
  // they last reset, and the guard's own last error/pending-checkup flag — none of which reached
  // this endpoint before, so the dashboard's usage pill had nothing to show but "n/a". Read
  // straight off `data.percents`/`data.resets` (usage-guard.cjs's own `writeState()` shape,
  // verified live) — an absent sub-object degrades to honest nulls, never a guessed 0%.
  const percents = data.percents && typeof data.percents === 'object' ? data.percents : null;
  const resets = data.resets && typeof data.resets === 'object' ? data.resets : null;
  return {
    available: true,
    // 'ok' | 'paused' — real values usage-guard.cjs's own `st.mode` writes; anything else it might
    // write in the future is passed through literally rather than remapped to a guessed enum.
    mode: typeof data.mode === 'string' ? data.mode : null,
    pause_at: data.pauseAt != null ? data.pauseAt : null,
    resume_at: data.resumeAt != null ? data.resumeAt : null,
    // Only a real array counts; anything else (absent field in the current 'ok' state) is
    // honestly null rather than presented as "0 paused".
    paused_agent_count: Array.isArray(data.pausedAgents) ? data.pausedAgents.length : null,
    last_check_at: data.lastCheckAt || null,
    age_ms: ageMs,
    // WP-CC1 (item 13) additions — real values only, honest null when the sub-object/field itself
    // is absent (never a fabricated 0% or false):
    session_pct: percents && typeof percents.session === 'number' ? percents.session : null,
    week_pct: percents && typeof percents.week === 'number' ? percents.week : null,
    session_reset_at: resets && (typeof resets.session === 'string' || resets.session === null) ? resets.session : null,
    week_reset_at: resets && (typeof resets.week === 'string' || resets.week === null) ? resets.week : null,
    // WP-CC1 (Lead review, LOW): redacted before it ever leaves this process — free text from
    // another tool can carry a leaked credential (e.g. echoed from a failed HTTP call's own body).
    last_error: redactNullable(typeof data.lastError === 'string' ? data.lastError : null),
    pending_checkup: typeof data.pendingCheckup === 'boolean' ? data.pendingCheckup : false,
    // watcher / watcher_stale_sec / watcher_interval_sec: is anything really checking usage right now?
    ...watcherHealth(nowMs, data.heartbeatAt || data.lastCheckAt || null, intervalSec),
  };
}

/** opts.intervalSec: the owner's `usage-guard.interval` setting (server.mjs reads it through config.mjs);
 *  left out, the guard's own default is used to judge whether its watcher still ticks. */
export function buildUsage(opts = {}) {
  const now = new Date();
  const guard = readGuardState(now.getTime(), opts.intervalSec);
  let raw;
  try {
    raw = fs.readFileSync(activePressureFile(), 'utf8');
  } catch {
    return { ok: true, provenance: 'NOT CONFIGURED', note: 'no FORGE_USAGE_PRESSURE.json found under the OS home .claude dir', captured_at: now.toISOString(), age_ms: 0, guard };
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return { ok: true, provenance: 'UNVERIFIED', note: 'FORGE_USAGE_PRESSURE.json present but could not be parsed: ' + err.message, captured_at: now.toISOString(), age_ms: 0, guard };
  }
  const updatedAtMs = data.updated_at ? Date.parse(data.updated_at) : NaN;
  const ageMs = Number.isFinite(updatedAtMs) ? now.getTime() - updatedAtMs : null;
  return {
    ok: true,
    provenance: 'REPORTED',
    level: data.level != null ? data.level : null,
    week: data.week != null ? data.week : null,
    nvidia_shift_at: data.nvidia_shift_at != null ? data.nvidia_shift_at : null,
    pause_at: data.pause_at != null ? data.pause_at : null,
    updated_at: data.updated_at || null,
    age_ms: ageMs,
    captured_at: now.toISOString(),
    guard,
  };
}
