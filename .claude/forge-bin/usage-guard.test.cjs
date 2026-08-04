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

// ================================================================================================
// MULTI-ACCOUNT + TYPED-LIMITS (2026-08-03). MEASURED DEFECTS these close, all from one live session:
//  (a) the owner switches between TWO Claude accounts; the guard had NO account identity anywhere, so
//      ~/.claude/FORGE_USAGE_GUARD_STATE.json kept account A's numbers (week 37%) while the live API
//      reported account B (week 86%) — a stale pause/resume decision made on the wrong account's data;
//  (b) the usage endpoint now returns a TYPED `limits` array (kinds seen live: session, weekly_all,
//      weekly_scoped with a per-model scope) while the guard only read the legacy five_hour/seven_day
//      fields — every other window, incl. any daily/scoped one, was invisible and could never pause;
//  (c) a null resets_at was formatted as "1/1/1970" — a fabricated-looking date instead of "unknown".
// These tests exercise the REAL module (usage-guard.cjs is now require-safe: the CLI only runs under
// require.main === module), replacing the old mirror-the-logic-inline approach for this surface.
// ================================================================================================
const G = require('./usage-guard.cjs');

test('typed limits: every window in the limits[] array is parsed, not just the legacy two', () => {
  const j = {
    five_hour: { utilization: 5, resets_at: '2026-08-04T00:00:00Z' },
    seven_day: { utilization: 86, resets_at: '2026-08-05T20:00:00Z' },
    limits: [
      { kind: 'session', group: 'session', percent: 5, resets_at: '2026-08-04T00:00:00Z', scope: null },
      { kind: 'weekly_all', group: 'weekly', percent: 86, resets_at: '2026-08-05T20:00:00Z', scope: null },
      { kind: 'weekly_scoped', group: 'weekly', percent: 60, resets_at: '2026-08-05T20:00:00Z', scope: { model: { display_name: 'Fable' } } },
      { kind: 'daily', group: 'daily', percent: 97, resets_at: '2026-08-04T06:00:00Z', scope: null },
    ],
  };
  const w = G.normalizeWindows(j);
  assert.strictEqual(w.length, 4, 'all four windows must survive parsing');
  assert.ok(w.some((x) => x.kind === 'daily' && x.pct === 97), 'a daily window must be visible');
  assert.ok(w.some((x) => x.kind === 'weekly_scoped' && /Fable/.test(x.label)), 'a scoped window keeps its model in the label');
  assert.strictEqual(w[0].source, 'limits');
});

test('typed limits: a NON-legacy window over the threshold really crosses (the daily-blindness bug)', () => {
  const j = { five_hour: { utilization: 5 }, seven_day: { utilization: 40 },
    limits: [{ kind: 'daily', group: 'daily', percent: 97, resets_at: null, scope: null }] };
  const crossed = G.crossedWindows(G.normalizeWindows(j), 93);
  assert.strictEqual(crossed.length, 1);
  assert.strictEqual(crossed[0].kind, 'daily');
});

test('typed limits: no limits[] at all still falls back to the legacy five_hour/seven_day pair', () => {
  const w = G.normalizeWindows({ five_hour: { utilization: 12, resets_at: null }, seven_day: { utilization: 44, resets_at: null } });
  assert.strictEqual(w.length, 2);
  assert.ok(w.every((x) => x.source === 'legacy'));
  assert.deepStrictEqual(w.map((x) => x.pct), [12, 44]);
});

test('typed limits: a non-numeric percent is dropped, never coerced into a fake 0', () => {
  const w = G.normalizeWindows({ limits: [{ kind: 'session', percent: null }, { kind: 'weekly_all', percent: 50 }] });
  assert.strictEqual(w.length, 1);
  assert.strictEqual(w[0].pct, 50);
});

test('account identity: a fingerprint is derived and NEVER contains the raw uuid/email/token', () => {
  const id = G.fingerprintAccount({ accountUuid: '3b51fe17-3d99-4577-8800-280e298bcbb1', organizationUuid: '67d9053f-1bb0-498c-942e-7f7822740933', emailAddress: 'owner@example.com' });
  assert.ok(/^[0-9a-f]{12}$/.test(id.fp), 'fingerprint must be a short hex digest, got ' + id.fp);
  assert.strictEqual(id.source, 'account-uuid');
  const blob = JSON.stringify(id);
  assert.ok(!/3b51fe17|67d9053f|owner@example\.com/.test(blob), 'identity object leaked a raw identifier');
});

test('account identity: two different accounts produce different fingerprints; the same one is stable', () => {
  const a = G.fingerprintAccount({ accountUuid: 'aaaaaaaa-0000-0000-0000-000000000001' });
  const a2 = G.fingerprintAccount({ accountUuid: 'aaaaaaaa-0000-0000-0000-000000000001' });
  const b = G.fingerprintAccount({ accountUuid: 'bbbbbbbb-0000-0000-0000-000000000002' });
  assert.strictEqual(a.fp, a2.fp);
  assert.notStrictEqual(a.fp, b.fp);
});

test('account switch: a state written by another account is DETECTED, never silently reused', () => {
  const prev = { mode: 'paused', percents: { session: 23, week: 37 }, account: { fp: 'aaaaaaaaaaaa' } };
  const sw = G.detectAccountSwitch(prev, { fp: 'bbbbbbbbbbbb', source: 'account-uuid' });
  assert.strictEqual(sw.switched, true);
  assert.strictEqual(sw.from, 'aaaaaaaaaaaa');
  assert.strictEqual(sw.to, 'bbbbbbbbbbbb');
});

test('account switch: the same account is NOT a switch, and an unknown identity never forces one', () => {
  assert.strictEqual(G.detectAccountSwitch({ account: { fp: 'aaaaaaaaaaaa' } }, { fp: 'aaaaaaaaaaaa' }).switched, false);
  assert.strictEqual(G.detectAccountSwitch({ account: { fp: 'aaaaaaaaaaaa' } }, { fp: null, source: 'unknown' }).switched, false);
  assert.strictEqual(G.detectAccountSwitch({ mode: 'ok' }, { fp: 'bbbbbbbbbbbb' }).switched, false, 'first-ever stamping is adoption, not a switch');
});

test('account switch: the new account starts CLEAN — no carried percentages, pause, or credits override', () => {
  const prev = { mode: 'paused', percents: { session: 23, week: 37 }, trigger: [{ name: 'week', pct: 95 }],
    pausedAgents: [{ id: 'x' }], ownerOverride: { active: true, reason: 'credits bought on account A' },
    account: { fp: 'aaaaaaaaaaaa' } };
  const next = G.stateForAccount(prev, { fp: 'bbbbbbbbbbbb', source: 'account-uuid' });
  assert.strictEqual(next.mode, 'ok');
  assert.strictEqual(next.percents, undefined, 'account A percentages must not survive');
  assert.strictEqual(next.ownerOverride, undefined, 'a credits override bought on account A must NOT suppress the guard on account B');
  assert.strictEqual(next.pausedAgents, undefined);
  assert.strictEqual(next.account.fp, 'bbbbbbbbbbbb');
  assert.strictEqual(next.previousAccount.fp, 'aaaaaaaaaaaa', 'the switch is recorded, not erased');
});

test('account switch: same account keeps its state untouched (no gratuitous reset)', () => {
  const prev = { mode: 'paused', percents: { session: 91, week: 94 }, ownerOverride: { active: true }, account: { fp: 'aaaaaaaaaaaa' } };
  const next = G.stateForAccount(prev, { fp: 'aaaaaaaaaaaa', source: 'account-uuid' });
  assert.strictEqual(next.mode, 'paused');
  assert.strictEqual(next.ownerOverride.active, true);
  assert.strictEqual(next.percents.week, 94);
});

test('account switch: an unstamped legacy state is ADOPTED (stamped), keeping its data', () => {
  const next = G.stateForAccount({ mode: 'paused', percents: { session: 91, week: 94 } }, { fp: 'aaaaaaaaaaaa', source: 'account-uuid' });
  assert.strictEqual(next.mode, 'paused');
  assert.strictEqual(next.account.fp, 'aaaaaaaaaaaa');
});

test('fmtReset: a null/absent reset prints "onbekend", never a fabricated 1970 date', () => {
  assert.strictEqual(G.fmtReset(null), 'onbekend');
  assert.strictEqual(G.fmtReset(undefined), 'onbekend');
  assert.strictEqual(G.fmtReset(''), 'onbekend');
  assert.ok(!/1970/.test(G.fmtReset(null)));
  assert.ok(/2026/.test(G.fmtReset('2026-08-05T20:00:00Z')), 'a real timestamp still formats');
});

test('watcher liveness: a live pid whose last check is ancient reads as STALE, not RUNNING', () => {
  const now = Date.parse('2026-08-03T19:00:00Z');
  const fresh = G.watcherHealth({ pidAlive: true, lastCheckAt: '2026-08-03T18:59:00Z', intervalSec: 120, now });
  assert.strictEqual(fresh.state, 'running');
  const stale = G.watcherHealth({ pidAlive: true, lastCheckAt: '2026-08-03T16:55:00Z', intervalSec: 120, now });
  assert.strictEqual(stale.state, 'stale', 'a process that stopped checking must not be reported as healthy');
  assert.ok(stale.staleSec > 3 * 120);
  const dead = G.watcherHealth({ pidAlive: false, lastCheckAt: '2026-08-03T18:59:00Z', intervalSec: 120, now });
  assert.strictEqual(dead.state, 'not-running');
  const never = G.watcherHealth({ pidAlive: true, lastCheckAt: null, intervalSec: 120, now });
  assert.strictEqual(never.state, 'unknown', 'no check timestamp is honest uncertainty, not a green light');
});

// ---- the account stamp must survive EVERY state write (found by the audit sweep, 2026-08-03) ----
// doPause()/doResume() deliberately build a FRESH state object (that is how a stale pause is dropped),
// carrying only ownerOverride/credits forward. The brand-new `account` stamp was not on that carry list,
// so every pause or resume silently erased it — and the next tick then read from:null and called a real
// account switch "first-stamp (adoption)". The account gate died exactly when it was needed most.
// Fixed at the ONE choke point every writer goes through, not per call site.
test('account stamp survives a state write that forgot it (single choke point, not per call site)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-stamp-'));
  const f = path.join(dir, 'state.json');
  fs.writeFileSync(f, JSON.stringify({ mode: 'ok', account: { fp: 'aaaaaaaaaaaa', source: 'account-uuid' } }));
  G.writeStateTo(f, { mode: 'paused', trigger: [{ name: 'week', pct: 95 }] }); // a doPause-shaped fresh object
  const after = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.strictEqual(after.mode, 'paused');
  assert.strictEqual(after.account && after.account.fp, 'aaaaaaaaaaaa', 'the stamp must not be dropped by a fresh-object write');
});

test('an EXPLICIT account in the written state always wins (a real switch is never overwritten by the old stamp)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-stamp2-'));
  const f = path.join(dir, 'state.json');
  fs.writeFileSync(f, JSON.stringify({ mode: 'ok', account: { fp: 'aaaaaaaaaaaa' } }));
  G.writeStateTo(f, { mode: 'ok', account: { fp: 'bbbbbbbbbbbb', source: 'account-uuid' } });
  assert.strictEqual(JSON.parse(fs.readFileSync(f, 'utf8')).account.fp, 'bbbbbbbbbbbb');
});

test('heartbeat: every state write stamps a fresh watchdog heartbeat', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-hb-'));
  const f = path.join(dir, 'state.json');
  G.writeStateTo(f, { mode: 'ok' });
  const hb = JSON.parse(fs.readFileSync(f, 'utf8')).heartbeatAt;
  assert.ok(hb && Number.isFinite(Date.parse(hb)), 'heartbeatAt must be a real timestamp, got ' + hb);
});

// ---- inactive windows (audit finding: is_active was parsed but never used) ----
// ---- CODEX ADVERSARIAL REVIEW (gpt-5.6-sol, effort max, 2026-08-03) finding #10 ----
// The first version returned as soon as limits[] produced one usable window, which DROPPED the legacy
// pair entirely: a response carrying limits=[{weekly_scoped,10%}] plus five_hour=99% reported only 10%
// and would never pause. Typed wins per identity; legacy fills the gaps; nothing is double-counted.
test('typed and legacy windows are MERGED — a 99% legacy window is not hidden by one typed entry', () => {
  const w = G.normalizeWindows({
    five_hour: { utilization: 99, resets_at: '2026-08-04T00:00:00Z' },
    seven_day: { utilization: 40 },
    limits: [{ kind: 'weekly_scoped', group: 'weekly', percent: 10, scope: { model: { display_name: 'A' } } }],
  });
  assert.strictEqual(w.length, 3, 'expected typed + both legacy windows, got ' + JSON.stringify(w.map((x) => x.label)));
  assert.strictEqual(G.crossedWindows(w, 93).length, 1, 'the 99% session window must still cross the threshold');
  assert.strictEqual(G.crossedWindows(w, 93)[0].pct, 99);
});

test('a window reported BOTH typed and legacy is counted once (typed wins, no double pause/resume entry)', () => {
  const w = G.normalizeWindows({
    five_hour: { utilization: 50 },
    limits: [{ kind: 'session', group: 'session', percent: 55, resets_at: '2026-08-04T00:00:00Z' }],
  });
  assert.strictEqual(w.length, 1);
  assert.strictEqual(w[0].pct, 55, 'the typed value must win over the legacy one');
  assert.strictEqual(w[0].source, 'limits');
});

test('duplicate typed records for the same window identity are not counted twice', () => {
  const w = G.normalizeWindows({ limits: [
    { kind: 'weekly_scoped', group: 'weekly', percent: 10, scope: { model: { display_name: 'A' } } },
    { kind: 'weekly_scoped', group: 'weekly', percent: 10, scope: { model: { display_name: 'A' } } },
    { kind: 'weekly_scoped', group: 'weekly', percent: 96, scope: { model: { display_name: 'B' } } },
  ] });
  assert.strictEqual(w.length, 2, 'same-identity duplicate must collapse, different scope must not');
  assert.ok(w.some((x) => /B/.test(x.label) && x.pct === 96));
});

test('a genuine percent 0 survives (0 is data; only null/absent is no-data)', () => {
  const w = G.normalizeWindows({ limits: [{ kind: 'session', percent: 0 }] });
  assert.strictEqual(w.length, 1);
  assert.strictEqual(w[0].pct, 0);
});

test('an API-inactive window still counts toward the pause decision (fail-safe, documented on purpose)', () => {
  const w = G.normalizeWindows({ limits: [{ kind: 'weekly_scoped', percent: 96, is_active: false, resets_at: null, scope: { model: { display_name: 'Fable' } } }] });
  assert.strictEqual(w[0].isActive, false);
  assert.strictEqual(G.crossedWindows(w, 93).length, 1, 'a 96% window must pause even when the API calls it inactive — pausing early is the safe error');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
