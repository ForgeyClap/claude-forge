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
import { FORGE_USAGE_PRESSURE_FILE, FORGE_USAGE_GUARD_STATE_FILE } from './paths.mjs';

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

function readGuardState(nowMs) {
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
  };
}

export function buildUsage() {
  const now = new Date();
  const guard = readGuardState(now.getTime());
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
