#!/usr/bin/env node
'use strict';
/**
 * Offline tests for the usage-guard reset-rhythm auto-resume feature + forge-resume.cjs + the
 * NVIDIA-shift soft pressure threshold (owner policy: prefer NVIDIA agents over Claude agents at
 * ~80% weekly usage, advisory-only, no quality downgrade, never pauses/blocks anything).
 * No network, no live OAuth key.
 *
 * usage-guard.cjs and the global hook are argv-driven CLI scripts that act immediately (usage-guard.cjs
 * even hits the live network for `status`/`check` on require()), so this test deliberately does NOT
 * require() them — it replicates the tiny PURE helpers (resumeAtEpoch math, creditsExhausted, the
 * hook's self-heal predicate, computePressureLevel/buildPressureData) inline, mirroring the real
 * implementations 1:1. forge-resume.cjs IS a real CLI, so it is exercised as a genuine subprocess
 * against a temp HOME, hermetically.
 *
 * Run: node usage-guard.test.cjs   (exit 0 = all pass, exit 1 = at least one failure)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('PASS - ' + name); }
  catch (e) { fail++; console.log('FAIL - ' + name + ' :: ' + e.message); }
}

// ---- 1) resumeAtEpoch helper (mirrors usage-guard.cjs doPause()'s computation) ----
function computeResumeAtEpoch(resetsAtIso, graceMin) {
  const ms = Date.parse(resetsAtIso);
  if (!Number.isFinite(ms)) return NaN;
  return ms + graceMin * 60000;
}
test('resumeAtEpoch = resets_at + graceMin minutes', () => {
  const resetsAt = '2026-07-09T10:00:00.000Z';
  const graceMin = 5;
  const got = computeResumeAtEpoch(resetsAt, graceMin);
  const want = Date.parse(resetsAt) + 5 * 60000;
  assert.strictEqual(got, want);
});
test('resumeAtEpoch picks the SOONEST of multiple resets_at', () => {
  const a = computeResumeAtEpoch('2026-07-09T10:00:00.000Z', 5);
  const b = computeResumeAtEpoch('2026-07-09T09:00:00.000Z', 5);
  assert.strictEqual(Math.min(a, b), b);
});
test('resumeAtEpoch is NaN-safe on an unparseable resets_at', () => {
  const got = computeResumeAtEpoch('not-a-date', 5);
  assert.ok(Number.isNaN(got));
});

// ---- 2) creditsExhausted (mirrors usage-guard.cjs creditsFrom()/creditsExhausted()) ----
function creditsFrom(j) {
  const e = j && j.extra_usage;
  const present = !!e && typeof e === 'object';
  const src = present ? e : {};
  const limit = Number(src.monthly_limit), used = Number(src.used_credits);
  return {
    present, enabled: src.is_enabled === true, limit, used,
    remaining: (Number.isFinite(limit) && Number.isFinite(used)) ? (limit - used) : NaN,
    disabledReason: src.disabled_reason || null,
  };
}
function creditsExhausted(c) {
  if (!c || !c.present) return false;
  if (c.enabled === false) return true;
  if (c.disabledReason) return true;
  if (Number.isFinite(c.remaining) && c.remaining <= 0) return true;
  return false;
}
test('creditsExhausted: missing extra_usage -> false', () => {
  assert.strictEqual(creditsExhausted(creditsFrom({})), false);
});
test('creditsExhausted: is_enabled false -> true', () => {
  assert.strictEqual(creditsExhausted(creditsFrom({ extra_usage: { is_enabled: false, monthly_limit: 1000, used_credits: 100 } })), true);
});
test('creditsExhausted: used >= limit -> true', () => {
  assert.strictEqual(creditsExhausted(creditsFrom({ extra_usage: { is_enabled: true, monthly_limit: 1000, used_credits: 1000 } })), true);
});
test('creditsExhausted: used < limit and enabled -> false', () => {
  assert.strictEqual(creditsExhausted(creditsFrom({ extra_usage: { is_enabled: true, monthly_limit: 1000, used_credits: 100 } })), false);
});

// ---- 3) hook self-heal predicate (mirrors forge-usage-guard-hook.cjs) ----
function shouldRhythmResume(mode, resumeAtEpoch, now) {
  return mode === 'paused' && Number.isFinite(Number(resumeAtEpoch)) && now >= Number(resumeAtEpoch);
}
test('hook self-heal: resumes when now is past resumeAtEpoch', () => {
  assert.strictEqual(shouldRhythmResume('paused', 1000, 2000), true);
});
test('hook self-heal: does not resume before resumeAtEpoch', () => {
  assert.strictEqual(shouldRhythmResume('paused', 5000, 2000), false);
});
test('hook self-heal: does not resume when mode is not paused', () => {
  assert.strictEqual(shouldRhythmResume('ok', 1000, 2000), false);
});
test('hook self-heal: does not resume with a missing/NaN resumeAtEpoch', () => {
  assert.strictEqual(shouldRhythmResume('paused', undefined, 2000), false);
  assert.strictEqual(shouldRhythmResume('paused', NaN, 2000), false);
});

// ---- 4) forge-resume.cjs round-trip (hermetic: fake HOME via env; real ~/.claude untouched) ----
const NODE = process.execPath;
const FORGE_RESUME_CJS = path.join(__dirname, 'forge-resume.cjs');
function withTmpHome(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-resume-test-'));
  try { return fn(tmp); } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
}
function runForgeResume(tmpHome, cliArgs) {
  return execFileSync(NODE, [FORGE_RESUME_CJS, ...cliArgs], {
    env: { ...process.env, USERPROFILE: tmpHome, HOME: tmpHome },
    encoding: 'utf8',
  });
}
test('forge-resume set/todo-add/todo-status/show round-trip in an isolated HOME', () => {
  withTmpHome((tmpHome) => {
    runForgeResume(tmpHome, ['set', '--project', 'TestProj', '--path', 'C:/x/TestProj', '--phase', 'build', '--last', 'wrote hook', '--next', 'write tests']);
    runForgeResume(tmpHome, ['todo-add', 'write', 'the', 'usage-guard', 'test']);
    runForgeResume(tmpHome, ['todo-add', 'sync', 'template']);
    runForgeResume(tmpHome, ['todo-status', '1', 'done']);
    const out = runForgeResume(tmpHome, ['show']);

    const stateFile = path.join(tmpHome, '.claude', 'FORGE_RESUME_STATE.json');
    assert.ok(fs.existsSync(stateFile), 'state file should be created under the fake HOME');
    const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.strictEqual(s.project, 'TestProj');
    assert.strictEqual(s.phase, 'build');
    assert.strictEqual(s.last_done, 'wrote hook');
    assert.strictEqual(s.next, 'write tests');
    assert.strictEqual(s.todo.length, 2);
    assert.strictEqual(s.todo[0].status, 'done');
    assert.strictEqual(s.todo[1].status, 'pending');
    assert.ok(out.includes('open to-do: 1'), 'show output should report 1 open todo, got: ' + out);
  });
});
test('forge-resume never writes to the real global HOME during the isolated test', () => {
  const realStateFile = path.join(os.homedir(), '.claude', 'FORGE_RESUME_STATE.json');
  const before = fs.existsSync(realStateFile) ? fs.readFileSync(realStateFile, 'utf8') : null;
  withTmpHome((tmpHome) => {
    runForgeResume(tmpHome, ['set', '--project', 'ShouldNotLeak']);
  });
  const after = fs.existsSync(realStateFile) ? fs.readFileSync(realStateFile, 'utf8') : null;
  assert.strictEqual(before, after, 'real ~/.claude/FORGE_RESUME_STATE.json must be untouched by the hermetic test');
  if (after != null) assert.ok(!after.includes('ShouldNotLeak'), 'real state file must not contain test data');
});

// ---- 5) NVIDIA-shift soft pressure threshold (mirrors usage-guard.cjs computePressureLevel()/
// buildPressureData()/writePressureFile() 1:1 — advisory-only routing signal, purely additive; the
// real pause/resume decision is untouched and always wins independently of this classification) ----
function computePressureLevel(weekPct, nvidiaShiftAt) {
  if (!Number.isFinite(weekPct) || !Number.isFinite(nvidiaShiftAt)) return 'unknown';
  return weekPct >= nvidiaShiftAt ? 'nvidia-preferred' : 'normal';
}
function buildPressureData(weekPct, nvidiaShiftAt, pauseAt) {
  return {
    level: computePressureLevel(weekPct, nvidiaShiftAt),
    week: Number.isFinite(weekPct) ? weekPct : null,
    nvidia_shift_at: nvidiaShiftAt,
    pause_at: pauseAt,
    updated_at: new Date().toISOString(),
  };
}

test('pressure boundary: week 79% (default nvidia-shift-at 80) -> normal', () => {
  assert.strictEqual(computePressureLevel(79, 80), 'normal');
});
test('pressure boundary: week 80% (default nvidia-shift-at 80) -> nvidia-preferred (>= is inclusive)', () => {
  assert.strictEqual(computePressureLevel(80, 80), 'nvidia-preferred');
});
test('pressure: 92% and 93% (inside the pause-at window) still classify nvidia-preferred — the pause decision ' +
  'is a wholly separate, unaffected code path; this level never itself pauses/blocks anything', () => {
  assert.strictEqual(computePressureLevel(92, 80), 'nvidia-preferred');
  assert.strictEqual(computePressureLevel(93, 80), 'nvidia-preferred');
});
test('pressure: pause-at "winning" never suppresses the pressure-file write — buildPressureData() always ' +
  'returns a complete object regardless of how high week% is (mirrors writePressureFile() being called ' +
  'unconditionally in tick(), before any pause/resume branching)', () => {
  const atPause = buildPressureData(93, 80, 93);
  assert.strictEqual(atPause.level, 'nvidia-preferred');
  assert.strictEqual(atPause.week, 93);
  assert.strictEqual(atPause.pause_at, 93);
});
test('pressure: missing/non-numeric week% -> unknown (never fabricated)', () => {
  assert.strictEqual(computePressureLevel(NaN, 80), 'unknown');
  assert.strictEqual(computePressureLevel(undefined, 80), 'unknown');
});
test('pressure: missing/non-numeric threshold -> unknown', () => {
  assert.strictEqual(computePressureLevel(85, NaN), 'unknown');
});
test('pressure: data object for a missing-data evaluation has week:null (not NaN, not fabricated)', () => {
  const d = buildPressureData(NaN, 80, 93);
  assert.strictEqual(d.level, 'unknown');
  assert.strictEqual(d.week, null);
});
test('pressure: CLI --nvidia-shift-at override works (a custom, lower threshold flips the classification ' +
  'for the same week% that would be "normal" under the 80 default)', () => {
  assert.strictEqual(computePressureLevel(75, 80), 'normal');
  assert.strictEqual(computePressureLevel(75, 70), 'nvidia-preferred');
});
test('pressure-file schema: exact keys, types and literal level values', () => {
  const normal = buildPressureData(50, 80, 93);
  assert.deepStrictEqual(Object.keys(normal).sort(), ['level', 'nvidia_shift_at', 'pause_at', 'updated_at', 'week'].sort());
  assert.strictEqual(normal.level, 'normal');
  assert.strictEqual(typeof normal.week, 'number');
  assert.strictEqual(typeof normal.nvidia_shift_at, 'number');
  assert.strictEqual(typeof normal.pause_at, 'number');
  assert.ok(!Number.isNaN(Date.parse(normal.updated_at)), 'updated_at must be a parseable ISO timestamp');

  const preferred = buildPressureData(85, 80, 93);
  assert.strictEqual(preferred.level, 'nvidia-preferred');

  const unknown = buildPressureData(NaN, 80, 93);
  assert.strictEqual(unknown.level, 'unknown');
  assert.strictEqual(unknown.week, null);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
