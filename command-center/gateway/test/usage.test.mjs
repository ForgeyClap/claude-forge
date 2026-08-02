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
} from '../src/usage.mjs';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-usage-test-'));
const presentPressurePath = path.join(tempDir, 'FORGE_USAGE_PRESSURE.json');
const presentGuardPath = path.join(tempDir, 'FORGE_USAGE_GUARD_STATE.json');
const absentPressurePath = path.join(tempDir, 'does-not-exist-pressure.json');
const absentGuardPath = path.join(tempDir, 'does-not-exist-guard.json');

afterEach(() => {
  // Always leave the module pointed at a real path (present or absent) — never at a stale
  // override — so a test that forgets to set both overrides still gets isolation, not a leak
  // into the real machine file.
  _setUsagePressureFileForTests(absentPressurePath);
  _setUsageGuardStateFileForTests(absentGuardPath);
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
  assert.equal(result.guard.paused_agent_count, 2);
  assert.equal(typeof result.guard.age_ms, 'number');
  assert.ok(result.guard.age_ms >= 0);
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

test('buildUsage: the two files vary independently — pressure PRESENT while guard is ABSENT still reports both honestly', () => {
  fs.writeFileSync(presentPressurePath, JSON.stringify({ level: 'low', week: 1, updated_at: new Date().toISOString() }), 'utf8');
  _setUsagePressureFileForTests(presentPressurePath);
  _setUsageGuardStateFileForTests(absentGuardPath);

  const result = buildUsage();
  assert.equal(result.provenance, 'REPORTED');
  assert.equal(result.guard.available, false);
});
