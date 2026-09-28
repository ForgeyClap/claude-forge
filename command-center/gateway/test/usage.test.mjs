// T3.9 / WP7c tests — buildUsage() against an isolated, test-owned fixture path (never the real
// ~/.claude/FORGE_USAGE_PRESSURE.json on this machine).
//
// fix-test-hygiene: the previous version of this file asserted directly against whatever this ONE
// machine happens to have on disk right now — `result.provenance === 'REPORTED'` is only true when
// FORGE_USAGE_PRESSURE.json actually exists here. On a fresh clone/CI (no such file) that assertion
// fails for a reason that has nothing to do with the code under test, AND the 'NOT CONFIGURED'
// fallback branch (usage.mjs's catch on a missing file) was never exercised at all. Both branches
// are now driven explicitly via the module's own test-only override seam
// (`_setUsagePressureFileForTests` / `_setUsageGuardStateFileForTests`), so this file is hermetic:
// its result no longer depends on this machine's real, live-rewritten usage files.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildUsage,
  _setUsagePressureFileForTests,
  _setUsageGuardStateFileForTests,
  _setUsageGuardPidFileForTests,
  _setPidAliveForTests,
} from '../src/usage.mjs';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-usage-test-'));
const presentPressurePath = path.join(tempDir, 'FORGE_USAGE_PRESSURE.json');
const presentGuardPath = path.join(tempDir, 'FORGE_USAGE_GUARD_STATE.json');
const absentPressurePath = path.join(tempDir, 'does-not-exist-pressure.json');
const absentGuardPath = path.join(tempDir, 'does-not-exist-guard.json');
const pidPath = path.join(tempDir, 'forge-usage-guard.pid');
const absentPidPath = path.join(tempDir, 'does-not-exist.pid');
// Never the real ~/.claude/forge-usage-guard.pid, not even in the older tests below.
_setUsageGuardPidFileForTests(absentPidPath);

afterEach(() => {
  // Always leave the module pointed at a real path (present or absent) — never at a stale
  // override — so a test that forgets to set both overrides still gets isolation, not a leak
  // into the real machine file.
  _setUsagePressureFileForTests(absentPressurePath);
  _setUsageGuardStateFileForTests(absentGuardPath);
  _setUsageGuardPidFileForTests(absentPidPath);
  _setPidAliveForTests(null);
});

after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('buildUsage: pressure file PRESENT -> provenance REPORTED with the exact real values written to it', () => {
  const fixture = {
    level: 'moderate',
    week: 42,
    nvidia_shift_at: '2026-07-30T00:00:00.000Z',
    pause_at: null,
    updated_at: new Date().toISOString(),
  };
  fs.writeFileSync(presentPressurePath, JSON.stringify(fixture), 'utf8');
  _setUsagePressureFileForTests(presentPressurePath);
  _setUsageGuardStateFileForTests(absentGuardPath);

  const result = buildUsage();
  assert.equal(result.ok, true);
  assert.equal(result.provenance, 'REPORTED');
  assert.equal(result.level, 'moderate');
  assert.equal(result.week, 42);
  assert.equal(result.nvidia_shift_at, fixture.nvidia_shift_at);
  assert.equal(result.pause_at, null);
  assert.equal(result.updated_at, fixture.updated_at);
  assert.equal(typeof result.age_ms, 'number');
  assert.ok(result.age_ms >= 0);
});

test('buildUsage: pressure file ABSENT -> honest NOT CONFIGURED, never a fabricated level/week', () => {
  _setUsagePressureFileForTests(absentPressurePath);
  _setUsageGuardStateFileForTests(absentGuardPath);

  const result = buildUsage();
  assert.equal(result.ok, true);
  assert.equal(result.provenance, 'NOT CONFIGURED');
  assert.equal(result.level, undefined, 'a NOT CONFIGURED result must never carry a guessed level field');
  assert.equal(result.week, undefined, 'a NOT CONFIGURED result must never carry a guessed week field');
  assert.match(result.note, /no FORGE_USAGE_PRESSURE\.json found/);
});

test('buildUsage: pressure file present but unparseable JSON -> UNVERIFIED, not a crash', () => {
  fs.writeFileSync(presentPressurePath, '{ not valid json', 'utf8');
  _setUsagePressureFileForTests(presentPressurePath);
  _setUsageGuardStateFileForTests(absentGuardPath);

  const result = buildUsage();
  assert.equal(result.ok, true);
  assert.equal(result.provenance, 'UNVERIFIED');
  assert.match(result.note, /could not be parsed/);
});

// WP7c — the guard-state sub-object, same hermetic convention: both branches (real file present /
// absent) are exercised explicitly rather than depending on this machine's real usage-guard state.
test('buildUsage: guard-state file PRESENT -> guard.available true with the exact real values written to it', () => {
  _setUsagePressureFileForTests(absentPressurePath);
  const fixture = { mode: 'ok', pauseAt: null, resumeAt: null, pausedAgents: ['agent-a', 'agent-b'], lastCheckAt: new Date().toISOString() };
  fs.writeFileSync(presentGuardPath, JSON.stringify(fixture), 'utf8');
  _setUsageGuardStateFileForTests(presentGuardPath);

  const result = buildUsage();
  assert.ok('guard' in result, 'guard field must always be present, independent of the pressure-file branch');
  assert.equal(result.guard.available, true);
  assert.equal(result.guard.mode, 'ok');
  assert.equal(result.guard.pause_at, null);
  assert.equal(result.guard.week_pause_at, null, 'no weekly pause point in the state file -> honest null');
  assert.equal(result.guard.paused_agent_count, 2);
  assert.equal(typeof result.guard.age_ms, 'number');
  assert.ok(result.guard.age_ms >= 0);
});

test('buildUsage passes the guard\'s weekly pause point through as week_pause_at (2026-09-28)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-usage-week-'));
  const p = path.join(dir, 'state.json');
  fs.writeFileSync(p, JSON.stringify({ mode: 'ok', pauseAt: 98, weekPauseAt: 85, resumeAt: 0, lastCheckAt: new Date().toISOString() }), 'utf8');
  _setUsageGuardStateFileForTests(p);
  try {
    const result = buildUsage();
    assert.equal(result.guard.pause_at, 98);
    assert.equal(result.guard.week_pause_at, 85);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildUsage: guard-state file ABSENT -> honest guard.available false with a real note, never a guessed mode', () => {
  _setUsagePressureFileForTests(absentPressurePath);
  _setUsageGuardStateFileForTests(absentGuardPath);

  const result = buildUsage();
  assert.ok('guard' in result);
  assert.equal(result.guard.available, false);
  assert.equal(typeof result.guard.note, 'string');
  assert.equal(result.guard.mode, undefined, 'an unavailable guard state must never carry a guessed mode field');
});

// WP-CC1 (item 13) — the guard-state fields the usage pill needs: session%/week%, reset times,
// the guard's own last error, and the pending-checkup flag.
test('buildUsage: guard PRESENT with percents/resets/lastError/pendingCheckup -> all real values pass through', () => {
  _setUsagePressureFileForTests(absentPressurePath);
  const fixture = {
    mode: 'ok',
    percents: { session: 27, week: 48 },
    resets: { session: null, week: '2026-10-02T15:00:00.191Z' },
    lastCheckAt: new Date().toISOString(),
    lastError: 'usage endpoint HTTP 429',
    pendingCheckup: true,
  };
  fs.writeFileSync(presentGuardPath, JSON.stringify(fixture), 'utf8');
  _setUsageGuardStateFileForTests(presentGuardPath);

  const result = buildUsage();
  assert.equal(result.guard.session_pct, 27);
  assert.equal(result.guard.week_pct, 48);
  assert.equal(result.guard.session_reset_at, null);
  assert.equal(result.guard.week_reset_at, '2026-10-02T15:00:00.191Z');
  assert.equal(result.guard.last_error, 'usage endpoint HTTP 429');
  assert.equal(result.guard.pending_checkup, true);
});

// WP-CC1 (Lead review, LOW): `last_error` is free text from a separate tool and must be redacted
// before it leaves this process — same reasoning/shape as recovery-redaction.test.mjs's own fake
// credentials (obviously-synthetic, matching redact.mjs's real GENERIC_SK_KEY pattern). The point
// is not that this exact string ever appears in a real lastError; it is that if someone later
// removes the redactNullable() call, this fails loudly instead of the gap re-opening silently.
test('buildUsage: a credential-shaped guard lastError never leaves the gateway unredacted', () => {
  _setUsagePressureFileForTests(absentPressurePath);
  const FAKE_SK = 'sk-abcdefghijklmnopqrstuvwxyz012345';
  fs.writeFileSync(presentGuardPath, JSON.stringify({
    mode: 'ok',
    lastCheckAt: new Date().toISOString(),
    lastError: 'usage endpoint failed, key ' + FAKE_SK + ' rejected',
  }), 'utf8');
  _setUsageGuardStateFileForTests(presentGuardPath);

  const result = buildUsage();
  assert.doesNotMatch(result.guard.last_error, /sk-abcdefghijklmnopqrstuvwxyz012345/);
  assert.match(result.guard.last_error, /\[REDACTED:GENERIC_SK_KEY\]/);
});

test('buildUsage: guard PRESENT but with no percents/resets/lastError/pendingCheckup -> honest nulls/false, never fabricated', () => {
  _setUsagePressureFileForTests(absentPressurePath);
  fs.writeFileSync(presentGuardPath, JSON.stringify({ mode: 'ok', lastCheckAt: new Date().toISOString() }), 'utf8');
  _setUsageGuardStateFileForTests(presentGuardPath);

  const result = buildUsage();
  assert.equal(result.guard.session_pct, null);
  assert.equal(result.guard.week_pct, null);
  assert.equal(result.guard.session_reset_at, null);
  assert.equal(result.guard.week_reset_at, null);
  assert.equal(result.guard.last_error, null);
  assert.equal(result.guard.pending_checkup, false);
});

test('buildUsage: the two files vary independently — pressure PRESENT while guard is ABSENT still reports both honestly', () => {
  fs.writeFileSync(presentPressurePath, JSON.stringify({ level: 'low', week: 1, updated_at: new Date().toISOString() }), 'utf8');
  _setUsagePressureFileForTests(presentPressurePath);
  _setUsageGuardStateFileForTests(absentGuardPath);

  const result = buildUsage();
  assert.equal(result.provenance, 'REPORTED');
  assert.equal(result.guard.available, false);
});

// ---- is the guard's watcher really running? (found live 2026-09-28: "Guard Active" with a dead watcher) ----

function guardWithHeartbeat(secondsAgo) {
  const beat = secondsAgo === null ? undefined : new Date(Date.now() - secondsAgo * 1000).toISOString();
  fs.writeFileSync(presentGuardPath, JSON.stringify({ mode: 'ok', pauseAt: 98, lastCheckAt: beat, heartbeatAt: beat }), 'utf8');
  _setUsagePressureFileForTests(absentPressurePath);
  _setUsageGuardStateFileForTests(presentGuardPath);
}

test('guard watcher: mode ok but no watcher pid -> not-running, never "active"', () => {
  guardWithHeartbeat(10);
  const g = buildUsage().guard;
  assert.equal(g.mode, 'ok');
  assert.equal(g.watcher, 'not-running');
});

test('guard watcher: a pid file whose process is gone -> not-running', () => {
  guardWithHeartbeat(10);
  fs.writeFileSync(pidPath, JSON.stringify({ pid: 4321, startedAt: 'x', script: 'usage-guard.cjs' }), 'utf8');
  _setUsageGuardPidFileForTests(pidPath);
  _setPidAliveForTests(() => false);
  assert.equal(buildUsage().guard.watcher, 'not-running');
});

test('guard watcher: a live pid with a fresh heartbeat -> running; the legacy bare-number pid file is read too', () => {
  guardWithHeartbeat(30);
  fs.writeFileSync(pidPath, '4321', 'utf8');
  _setUsageGuardPidFileForTests(pidPath);
  _setPidAliveForTests((pid) => pid === 4321);
  const g = buildUsage().guard;
  assert.equal(g.watcher, 'running');
  assert.equal(g.watcher_interval_sec, 120);
  assert.ok(g.watcher_stale_sec >= 29 && g.watcher_stale_sec <= 32, String(g.watcher_stale_sec));
});

test('guard watcher: a live pid whose heartbeat is older than three intervals -> stale; a longer configured interval keeps it running', () => {
  guardWithHeartbeat(20 * 60);
  fs.writeFileSync(pidPath, JSON.stringify({ pid: 4321 }), 'utf8');
  _setUsageGuardPidFileForTests(pidPath);
  _setPidAliveForTests((pid) => pid === 4321);
  assert.equal(buildUsage().guard.watcher, 'stale', 'default 120 s interval: 20 min without a heartbeat is a hanging watcher');
  assert.equal(buildUsage({ intervalSec: 600 }).guard.watcher, 'running', 'the owner checks every 10 min: 20 min is still within three intervals');
  assert.equal(buildUsage({ intervalSec: 5 }).guard.watcher_interval_sec, 30, 'the guard never ticks faster than every 30 s');
});

test('guard watcher: a live pid but no heartbeat at all -> unknown (honest uncertainty, never a green light)', () => {
  guardWithHeartbeat(null);
  fs.writeFileSync(pidPath, JSON.stringify({ pid: 4321 }), 'utf8');
  _setUsageGuardPidFileForTests(pidPath);
  _setPidAliveForTests(() => true);
  assert.equal(buildUsage().guard.watcher, 'unknown');
});
