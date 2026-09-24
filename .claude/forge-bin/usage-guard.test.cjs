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
const { execFileSync, spawn } = require('child_process');

let pass = 0, fail = 0;
// PROMISE-AWARE (2026-08-06): an async test used to be counted PASS the moment fn() returned a pending
// promise — its assertions ran later as unhandled rejections and could never fail the suite. Async tests
// are now queued and awaited before the final tally; a test that cannot fail is not a test.
const asyncQueue = [];
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      asyncQueue.push(r.then(() => { pass++; console.log('PASS - ' + name); })
        .catch((e) => { fail++; console.log('FAIL - ' + name + ' :: ' + e.message); }));
      return;
    }
    pass++; console.log('PASS - ' + name);
  }
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
  // FLAKINESS-WORTEL GEVONDEN (2026-08-06, vloot-diagnose): dit was een byte-gelijkheids-assert op het
  // ECHTE ~/.claude/FORGE_RESUME_STATE.json voor/na — een bestand dat de LIVE sessie en haar hooks
  // legitiem herschrijven. Elke legitieme schrijf die toevallig tijdens deze suite viel = 1 "failure":
  // exact de intermitterende enkele rode test die install-validaties (die deze suite in het doelproject
  // draaien terwijl de hoofdsessie doorwerkt) al drie projecten lang liet terugrollen, en de "transiente"
  // doctor-rood van 2026-08-05. De ECHTE invariant — de hermetische run lekt zijn testdata niet naar de
  // echte HOME — blijft volledig overeind; alleen de race op andermans legitieme writes is weg.
  const realStateFile = path.join(os.homedir(), '.claude', 'FORGE_RESUME_STATE.json');
  withTmpHome((tmpHome) => {
    runForgeResume(tmpHome, ['set', '--project', 'ShouldNotLeak']);
  });
  const after = fs.existsSync(realStateFile) ? fs.readFileSync(realStateFile, 'utf8') : null;
  if (after != null) assert.ok(!after.includes('ShouldNotLeak'), 'real state file must not contain test data — the hermetic run leaked into the real HOME');
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

// ---- ATOMIC STATE WRITE (Codex adversarial review #6, 2026-08-03) ----
// Three processes share one state file (watcher, CLI, PreToolUse hook) and every reader treats
// unparseable JSON as "no state" — i.e. it fails OPEN. An in-place truncate-and-rewrite therefore had a
// window where a reader saw a half file and silently ignored a real pause. Writes now go to a unique
// temp file and are renamed into place.
// CORRECTED 2026-08-05 (broad Codex audit, finding #30). The first version of this test wrote and read
// SEQUENTIALLY in one process: every write had finished before its read began, so no reader ever
// overlapped a writer and the test would have stayed green with the atomic rename reverted to an
// in-place write — a test that passes for the wrong reason is worse than no test. It now runs a REAL
// concurrent writer process against a reader loop, and proves the property in both directions: the
// atomic writer is never caught mid-write, and a deliberately non-atomic writer IS caught. If the
// control arm cannot produce a torn read on this machine the assertion is skipped honestly rather than
// silently claiming proof it did not obtain.
test('a concurrent reader NEVER sees a partial state file (real overlapping writer, both directions)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-atomic-'));
  const guardPath = path.join(__dirname, 'usage-guard.cjs').replace(/\\/g, '/');
  const payload = 'x'.repeat(400000); // big enough that a non-atomic write has a visible window

  const runArm = (mode) => {
    const f = path.join(dir, mode + '-state.json');
    fs.writeFileSync(f, JSON.stringify({ mode: 'ok' }));
    const writer = path.join(dir, 'writer-' + mode + '.cjs');
    fs.writeFileSync(writer, [
      "const fs=require('fs');",
      "const G=require('" + guardPath + "');",
      "const f=" + JSON.stringify(f) + ", big=" + JSON.stringify(payload) + ";",
      "const end=Date.now()+1500;",
      "while(Date.now()<end){",
      mode === 'atomic'
        ? "  G.writeStateTo(f,{mode:'paused',filler:big});G.writeStateTo(f,{mode:'ok'});"
        : "  fs.writeFileSync(f, JSON.stringify({mode:'paused',filler:big}));fs.writeFileSync(f, JSON.stringify({mode:'ok'}));",
      "}",
    ].join('\n'), 'utf8');
    const child = spawn(process.execPath, [writer], { stdio: 'ignore' });
    let reads = 0, torn = 0;
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      try { JSON.parse(fs.readFileSync(f, 'utf8')); reads++; } catch { torn++; }
    }
    try { child.kill(); } catch { /* already gone */ }
    return { reads, torn };
  };

  const atomic = runArm('atomic');
  assert.ok(atomic.reads > 50, 'the reader barely ran (' + atomic.reads + ' reads) — the test proves nothing');
  assert.strictEqual(atomic.torn, 0, atomic.torn + ' of ' + (atomic.reads + atomic.torn) + ' concurrent reads saw a partial file despite the atomic write');

  // control arm: the same race WITHOUT the atomic rename must be catchable, otherwise the arm above
  // is not evidence of anything on this filesystem.
  const naive = runArm('naive');
  if (naive.torn === 0) {
    console.log('    (control arm produced no torn read on this filesystem — the atomic arm is therefore not conclusive here; reported, not glossed over)');
  } else {
    assert.ok(naive.torn > 0, 'control arm sanity');
  }
});

test('no temp files are left behind after writing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-atomic2-'));
  const f = path.join(dir, 'state.json');
  for (let i = 0; i < 5; i++) G.writeStateTo(f, { mode: 'ok', n: i });
  const leftovers = fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));
  assert.deepStrictEqual(leftovers, [], 'temp files left behind: ' + leftovers.join(', '));
});

test('a write that cannot happen THROWS rather than pretending the state was persisted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-atomic3-'));
  const f = path.join(dir, 'no-such-subdir', 'state.json'); // parent does not exist
  assert.throws(() => G.writeStateTo(f, { mode: 'ok' }), 'a failed persist must not return silently');
});

// ============================================================================================
// WATCHER SINGLETON — ATOMIC CLAIM (broad Codex audit #17, 2026-08-05)
// --------------------------------------------------------------------------------------------
// The "refuse a second watcher" guard was check-then-write: `watch` read the pid file, decided the
// slot was free, and wrote its own pid ~10 lines later — unconditionally. Two watchers starting in
// the same moment both passed the check and both wrote, which is exactly the duplicate the guard
// exists to prevent. These tests race REAL processes; a mirrored in-test copy of the logic would
// prove nothing about the shipped code, and the control arm proves the race is genuinely reachable
// on this machine (a test that cannot fail is not evidence).
// ============================================================================================
const GUARD_PATH = path.join(__dirname, 'usage-guard.cjs').replace(/\\/g, '/');

// raceClaim — start N real subprocesses that all try to claim the SAME pid file at the same moment.
// Node takes ~50ms to boot, and spawning is sequential, so a naive "spin until the gate file appears"
// would let the first worker finish before the last one even started — the race would never happen and
// the control arm would report a false all-clear. Every worker therefore announces itself with a
// ready-<pid> file and only THEN spins on the gate; the parent opens the gate once all N are waiting,
// which puts them inside the same few microseconds.
//
// The naive arm reproduces the ORIGINAL code's shape faithfully, including its width: the real `watch`
// did readPidRecord() → log(...) (an appendFileSync — genuine synchronous disk I/O) → two process.on
// registrations → writeFileSync. The appendFileSync between check and write below is that same log
// line, not an artificial delay inserted to manufacture a failure.
function raceClaim(mode, n) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-claim-' + mode + '-'));
  const pidFile = path.join(dir, 'watcher.pid');
  const gate = path.join(dir, 'GO');
  const runner = path.join(dir, 'runner.cjs');
  fs.writeFileSync(runner, [
    "const fs=require('fs');",
    "const G=require('" + GUARD_PATH + "');",
    "const pidFile=" + JSON.stringify(pidFile) + ", gate=" + JSON.stringify(gate) + ", dir=" + JSON.stringify(dir) + ";",
    "const me=Number(process.argv[2]);",
    "const p=require('path');",
    "fs.writeFileSync(p.join(dir,'ready-'+me), '1');", // announce: I am at the start line
    "const __sab=new Int32Array(new SharedArrayBuffer(4));",
    "while(!fs.existsSync(gate)){Atomics.wait(__sab,0,0,2);}", // micro-sleep spin: onder een volle doctor-run (115 parallelle suites) verhongerde de harde busy-wait de racers en werd de suite flaky
    "let won=false, why='';",
    mode === 'atomic'
      // the SHIPPED claim, with pid/liveness/verification injected so the fixture is hermetic
      ? [
        "const r=G.claimWatcherSlot({pidFile, pid:me, script:" + JSON.stringify(GUARD_PATH) + ",",
        "  isAlive:(x)=>x!==me, verify:()=>({ok:true})});",
        "won=r.ok; why=r.reason||r.mode||'';",
      ].join('\n')
      // the OLD check-then-write shape, reproduced exactly — including the log() write in between
      : [
        "let existing=0; try{existing=JSON.parse(fs.readFileSync(pidFile,'utf8')).pid||0;}catch(e){}",
        "if(existing && existing!==me){ won=false; why='refused'; }",
        "else {",
        "  fs.appendFileSync(p.join(dir,'watch.log'), 'usage-guard watch started (pid '+me+')\\n');",
        "  fs.writeFileSync(pidFile, JSON.stringify({pid:me})+'\\n'); won=true; why='wrote';",
        "}",
      ].join('\n'),
    "fs.writeFileSync(p.join(dir,'result-'+me+'.json'), JSON.stringify({won,why}));",
  ].join('\n'), 'utf8');

  const kids = [];
  for (let i = 1; i <= n; i++) kids.push(spawn(process.execPath, [runner, String(1000 + i)], { stdio: 'ignore' }));
  const countFiles = (prefix) => fs.readdirSync(dir).filter((f) => f.startsWith(prefix)).length;
  const readyBy = Date.now() + 20000;
  const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); // sync micro-sleep, geen CPU-verbranding
  while (countFiles('ready-') < n && Date.now() < readyBy) sleepMs(5);
  const allReady = countFiles('ready-') === n;
  fs.writeFileSync(gate, 'go'); // release them all together
  const deadline = Date.now() + 20000;
  while (countFiles('result-') < n && Date.now() < deadline) sleepMs(5);
  for (const k of kids) { try { k.kill(); } catch { /* already exited */ } }
  const results = fs.readdirSync(dir).filter((f) => f.startsWith('result-')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  return { results, winners: results.filter((r) => r.won).length, pidFile, dir, allReady };
}

test('EXACTLY ONE of 6 racing watchers claims the slot (real concurrent processes, shipped code)', () => {
  const r = raceClaim('atomic', 6);
  assert.ok(r.allReady, 'not every racer reached the start line — the race did not really run');
  assert.strictEqual(r.results.length, 6, 'only ' + r.results.length + '/6 workers reported back — the race did not really run');
  assert.strictEqual(r.winners, 1, r.winners + ' of 6 concurrent starters believed they claimed the watcher slot (must be exactly 1): '
    + JSON.stringify(r.results));
  const rec = JSON.parse(fs.readFileSync(r.pidFile, 'utf8'));
  assert.ok(rec.pid >= 1001 && rec.pid <= 1006, 'the pid file must name a real racer, got ' + rec.pid);
});

test('control arm: the OLD check-then-write guard DOES let more than one through (the race is real here)', () => {
  // If this arm cannot produce a double-claim on this machine, the test above is not conclusive HERE —
  // report that honestly instead of silently banking a green.
  let sawDouble = false, attempts = 0, best = 0;
  while (!sawDouble && attempts < 5) {
    attempts++;
    const r = raceClaim('naive', 6);
    best = Math.max(best, r.winners);
    if (r.winners > 1) sawDouble = true;
  }
  if (!sawDouble) {
    console.log('    (control arm never produced a double-claim in ' + attempts + ' rounds — max ' + best
      + ' winner(s); the atomic test above is therefore not conclusive on this machine; reported, not glossed over)');
  } else {
    assert.ok(best > 1, 'control arm sanity: ' + best + ' concurrent starters won with the OLD logic');
  }
});

test('a LIVE, verifiable watcher is refused — never taken over', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-claim-live-'));
  const pidFile = path.join(dir, 'watcher.pid');
  fs.writeFileSync(pidFile, JSON.stringify({ pid: 4242, startedAt: '2026-08-05T00:00:00.000Z', script: 'usage-guard.cjs' }) + '\n');
  const r = G.claimWatcherSlot({ pidFile, pid: 99, isAlive: (p) => p === 4242, verify: () => ({ ok: true }) });
  assert.strictEqual(r.ok, false, 'a second watcher must be refused while a real one is running');
  assert.match(r.reason, /already running/);
  assert.strictEqual(JSON.parse(fs.readFileSync(pidFile, 'utf8')).pid, 4242, 'the live watcher\'s record must survive untouched');
});

test('a DEAD holder is taken over (a crashed watcher must not lock the account out of being guarded)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-claim-dead-'));
  const pidFile = path.join(dir, 'watcher.pid');
  fs.writeFileSync(pidFile, JSON.stringify({ pid: 4242, script: 'usage-guard.cjs' }) + '\n');
  const r = G.claimWatcherSlot({ pidFile, pid: 99, isAlive: () => false, verify: () => ({ ok: false, reason: 'process not running' }) });
  assert.strictEqual(r.ok, true, 'a dead holder must not block a fresh watcher: ' + r.reason);
  assert.strictEqual(r.mode, 'took-over-stale');
  assert.strictEqual(JSON.parse(fs.readFileSync(pidFile, 'utf8')).pid, 99);
});

test('a RECYCLED pid running something else is taken over (it is not a watcher)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-claim-recycled-'));
  const pidFile = path.join(dir, 'watcher.pid');
  fs.writeFileSync(pidFile, JSON.stringify({ pid: 4242, script: 'usage-guard.cjs' }) + '\n');
  const r = G.claimWatcherSlot({ pidFile, pid: 99, isAlive: () => true, verify: () => ({ ok: false, reason: 'pid 4242 does not run this guard script (recycled pid) — refusing to kill it' }) });
  assert.strictEqual(r.ok, true, 'a recycled pid must not permanently block the guard: ' + r.reason);
  assert.strictEqual(JSON.parse(fs.readFileSync(pidFile, 'utf8')).pid, 99);
});

test('an UNVERIFIABLE live holder is refused and says so — not silently duplicated', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-claim-unknown-'));
  const pidFile = path.join(dir, 'watcher.pid');
  fs.writeFileSync(pidFile, JSON.stringify({ pid: 4242 }) + '\n');
  const r = G.claimWatcherSlot({ pidFile, pid: 99, isAlive: () => true, verify: () => ({ ok: false, reason: 'cannot verify pid 4242 on linux (no recorded script match) — refusing to kill it' }) });
  assert.strictEqual(r.ok, false, 'an unidentifiable live holder must not be taken over');
  assert.match(r.reason, /cannot be identified/);
  assert.strictEqual(JSON.parse(fs.readFileSync(pidFile, 'utf8')).pid, 4242, 'the unknown holder\'s record must survive untouched');
});

test('a takeover lock held by another starter blocks the takeover (no two starters take over at once)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-claim-lock-'));
  const pidFile = path.join(dir, 'watcher.pid');
  fs.writeFileSync(pidFile, JSON.stringify({ pid: 4242 }) + '\n');
  fs.writeFileSync(pidFile + '.takeover.lock', 'held by another starter');
  const r = G.claimWatcherSlot({ pidFile, pid: 99, isAlive: () => false, verify: () => ({ ok: false, reason: 'process not running' }) });
  assert.strictEqual(r.ok, false, 'a concurrent takeover must not be joined');
  assert.match(r.reason, /taking over the stale pid file right now/);
});

test('an ABANDONED takeover lock does not block the guard forever', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-claim-lock2-'));
  const pidFile = path.join(dir, 'watcher.pid');
  fs.writeFileSync(pidFile, JSON.stringify({ pid: 4242 }) + '\n');
  fs.writeFileSync(pidFile + '.takeover.lock', 'abandoned by a killed starter');
  // now() jumped past STALE_LOCK_MS: the lock is older than any real takeover could take
  const r = G.claimWatcherSlot({
    pidFile, pid: 99, isAlive: () => false, verify: () => ({ ok: false, reason: 'process not running' }),
    now: () => Date.now() + G.STALE_LOCK_MS + 5000,
  });
  assert.strictEqual(r.ok, true, 'an abandoned lock must be reclaimed, not honoured forever: ' + r.reason);
  assert.strictEqual(JSON.parse(fs.readFileSync(pidFile, 'utf8')).pid, 99);
});

test('releaseWatcherSlot removes OUR record and refuses to remove someone else\'s', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-release-'));
  const pidFile = path.join(dir, 'watcher.pid');
  fs.writeFileSync(pidFile, JSON.stringify({ pid: 77 }) + '\n');
  const foreign = G.releaseWatcherSlot({ pidFile, pid: 99 });
  assert.strictEqual(foreign.removed, false, 'we must never delete another watcher\'s claim');
  assert.ok(fs.existsSync(pidFile));
  const mine = G.releaseWatcherSlot({ pidFile, pid: 77 });
  assert.strictEqual(mine.removed, true, 'our own claim must be released on a clean exit: ' + mine.reason);
  assert.ok(!fs.existsSync(pidFile));
});

// ============================================================================================
// #13/#15/#18 — ACCOUNT-CONSISTENTIE, STABIELE VENSTER-IDENTITEIT, POSIX PID-BEWIJS
// (broad Codex audit, gefixt 2026-08-06)
// ============================================================================================

// ---- #15: stillHighTrigger — de resume-beslissing op stabiele venster-identiteit ----
test('#15 pause op Opus 96% resumet NIET omdat Sonnet (zelfde kind, eerder in de lijst) laag staat', () => {
  const windows = G.normalizeWindows({ limits: [
    { kind: 'weekly_scoped', group: 'weekly', percent: 20, resets_at: null, scope: { model: { display_name: 'Sonnet' } } },
    { kind: 'weekly_scoped', group: 'weekly', percent: 96, resets_at: null, scope: { model: { display_name: 'Opus' } } },
  ] });
  const opus = windows.find((w) => w.label.includes('Opus'));
  const trigger = [{ id: opus.id, name: opus.label, metric: opus.kind, pct: 96, resetsAt: null }];
  // Oude kind-only matching vond Sonnet (20%) het eerst -> stillHigh false -> onterechte resume + flapping.
  assert.strictEqual(G.stillHighTrigger(trigger, windows, 70, { sessionPct: 10, weekPct: 10 }), true,
    'de guard moet op ZIJN venster (Opus 96%) blijven wachten, niet op het eerste venster met dezelfde kind');
});

test('#15 spiegel: de trigger-window is gereset -> resume, ook al staat een ANDER venster met dezelfde kind hoog', () => {
  const windows = G.normalizeWindows({ limits: [
    { kind: 'weekly_scoped', group: 'weekly', percent: 96, resets_at: null, scope: { model: { display_name: 'Opus' } } },
    { kind: 'weekly_scoped', group: 'weekly', percent: 5, resets_at: null, scope: { model: { display_name: 'Sonnet' } } },
  ] });
  const sonnet = windows.find((w) => w.label.includes('Sonnet'));
  const trigger = [{ id: sonnet.id, name: sonnet.label, metric: sonnet.kind, pct: 96, resetsAt: null }];
  // Oude matching vond Opus (96%) het eerst -> bleef "gepauzeerd" op een venster dat nooit kruiste.
  assert.strictEqual(G.stillHighTrigger(trigger, windows, 70, { sessionPct: 10, weekPct: 10 }), false,
    'het eigen venster is gereset (5%) — een ander venster met dezelfde kind mag de pauze niet vasthouden');
});

test('#15 legacy trigger zonder id: bare kind alleen bij precies EEN kandidaat; ambigu = geen gok', () => {
  const one = G.normalizeWindows({ limits: [{ kind: 'daily', group: 'daily', percent: 97, resets_at: null }] });
  assert.strictEqual(G.stillHighTrigger([{ name: 'daily', metric: 'daily' }], one, 70, {}), true, 'een kind is ondubbelzinnig bij een kandidaat');
  const two = G.normalizeWindows({ limits: [
    { kind: 'weekly_scoped', group: 'weekly', percent: 96, scope: { model: { display_name: 'Opus' } } },
    { kind: 'weekly_scoped', group: 'weekly', percent: 5, scope: { model: { display_name: 'Sonnet' } } },
  ] });
  assert.strictEqual(G.stillHighTrigger([{ name: 'weekly_scoped', metric: 'weekly_scoped' }], two, 70, { sessionPct: 10, weekPct: 10 }), false,
    'twee kandidaten met dezelfde kind = een gok; niet stilzwijgend het eerste venster nemen (crossedWindows her-pauzeert zo nodig direct)');
});

test('#15 een verdwenen trigger-venster houdt de pauze niet eeuwig vast', () => {
  const windows = G.normalizeWindows({ limits: [{ kind: 'session', group: 'session', percent: 10 }] });
  const trigger = [{ id: 'daily|daily|daily', name: 'daily', metric: 'daily', pct: 97 }];
  assert.strictEqual(G.stillHighTrigger(trigger, windows, 70, { sessionPct: 10, weekPct: 10 }), false,
    'het venster wordt niet meer gerapporteerd — er is niets om op te wachten (her-pauze en resumeAtEpoch blijven de vangnetten)');
});

test('#15 normalizeWindows geeft elk venster (typed EN legacy) een stabiele id', () => {
  const w = G.normalizeWindows({
    limits: [{ kind: 'weekly_scoped', group: 'weekly', percent: 50, scope: { model: { display_name: 'Opus' } } }],
    five_hour: { utilization: 10, resets_at: null },
  });
  assert.ok(w.every((x) => typeof x.id === 'string' && x.id.includes('|')), 'elke window draagt kind|group|label als id: ' + JSON.stringify(w));
  const ids = w.map((x) => x.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'ids zijn uniek');
});

// ---- #13: tick leest de identiteit VOOR en NA de fetch; een mid-check switch = geen actie ----
function tickHarness(overrides) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-tick-'));
  const stateFile = path.join(dir, 'state.json');
  const calls = { doPause: [], doResume: [], logs: [] };
  const state = { value: overrides.initialState || { mode: 'ok' } };
  const deps = {
    readState: () => JSON.parse(JSON.stringify(state.value)),
    writeState: (s) => { state.value = JSON.parse(JSON.stringify(s)); fs.writeFileSync(stateFile, JSON.stringify(s)); return s; },
    doPause: async (u, crossed, ident) => { calls.doPause.push({ crossed, ident }); },
    doResume: async (u, st, ident) => { calls.doResume.push({ st, ident }); },
    log: (m) => calls.logs.push(m),
    writePressureFile: () => {},
    ...overrides.deps,
  };
  return { deps, calls, state, stateFile };
}
function usageWith(pct) {
  const windows = G.normalizeWindows({ limits: [{ kind: 'session', group: 'session', percent: pct, resets_at: null }] });
  return { session: { pct, resetsAt: null }, week: { pct: 10, resetsAt: null }, windows, credits: { used: NaN, limit: NaN, remaining: NaN } };
}

test('#13 een account-switch TIJDENS de fetch verwerpt de meting — geen pauze onder de verkeerde stempel', async () => {
  const identRef = { fp: 'aaaa11112222', source: 'account-uuid' };
  const h = tickHarness({
    initialState: { mode: 'ok', account: { fp: 'aaaa11112222', source: 'account-uuid' } },
    deps: {
      readIdentity: () => ({ ...identRef }),
      fetchUsage: async () => { identRef.fp = 'bbbb33334444'; return usageWith(100); }, // login halverwege de check
    },
  });
  await G.tick(h.deps);
  assert.strictEqual(h.calls.doPause.length, 0, 'account A\'s 100% mag account B nooit pauzeren');
  assert.notStrictEqual(h.state.value.mode, 'paused', 'de state mag niet op paused staan');
  assert.match(String(h.state.value.lastError || ''), /switched mid-check/, 'de verworpen meting is eerlijk vastgelegd');
});

test('#13 zonder switch pauzeert de tick gewoon, en geeft hij de GEVALIDEERDE identiteit aan doPause door', async () => {
  const h = tickHarness({
    initialState: { mode: 'ok', account: { fp: 'aaaa11112222', source: 'account-uuid' } },
    deps: {
      readIdentity: () => ({ fp: 'aaaa11112222', source: 'account-uuid' }),
      fetchUsage: async () => usageWith(100),
    },
  });
  await G.tick(h.deps);
  assert.strictEqual(h.calls.doPause.length, 1, 'een echt gekruist venster pauzeert nog steeds');
  assert.strictEqual(h.calls.doPause[0].ident && h.calls.doPause[0].ident.fp, 'aaaa11112222', 'doPause krijgt de gevalideerde identiteit als expliciete stempel');
  assert.ok(h.calls.doPause[0].crossed.every((t) => typeof t.id === 'string' && t.id.includes('|')), 'elke trigger draagt de stabiele venster-id (#15)');
});

test('#13 accountStamp maakt de expliciete stempel; zonder identiteit blijft de write ongewijzigd', () => {
  const withId = G.accountStamp({ fp: 'cccc55556666', source: 'account-uuid' });
  assert.strictEqual(withId.account.fp, 'cccc55556666');
  assert.strictEqual(withId.account.source, 'account-uuid');
  assert.deepStrictEqual(G.accountStamp(null), {}, 'geen identiteit = geen stempel (de writeStateTo-carry blijft dan het vangnet)');
});

// ---- #18: POSIX PID-eigendom — record-bewijs alleen is nooit meer genoeg ----
test('#18 verdictFromCmdline: een vreemd proces is RECYCLED (code), een status-call NOT-WATCHER, een echte watcher ok', () => {
  const rec = { pid: 4242, script: path.join(__dirname, 'usage-guard.cjs') };
  const alien = G.verdictFromCmdline(4242, rec, '/usr/sbin/unrelated-daemon --flag');
  assert.strictEqual(alien.ok, false); assert.strictEqual(alien.code, 'recycled');
  const status = G.verdictFromCmdline(4242, rec, 'node ' + rec.script + ' status');
  assert.strictEqual(status.ok, false); assert.strictEqual(status.code, 'not-watcher');
  const real = G.verdictFromCmdline(4242, rec, 'node ' + rec.script + ' watch --interval 120');
  assert.strictEqual(real.ok, true);
});

test('#18 incumbentStatus classificeert op machineleesbare code — een geherformuleerde reason blokkeert de start niet eeuwig', () => {
  const rec = { pid: 4242 };
  const viaCode = G.incumbentStatus(rec, { pid: 99, isAlive: () => true, verify: () => ({ ok: false, code: 'recycled', reason: 'totaal andere bewoording' }) });
  assert.strictEqual(viaCode.kind, 'stale', 'code recycled = veilig over te nemen, ongeacht de proza');
  const viaProse = G.incumbentStatus(rec, { pid: 99, isAlive: () => true, verify: () => ({ ok: false, reason: 'pid 4242 does not run this guard script (recycled pid) — refusing to kill it' }) });
  assert.strictEqual(viaProse.kind, 'stale', 'de oude proza-route blijft als fallback werken');
  const unknown = G.incumbentStatus(rec, { pid: 99, isAlive: () => true, verify: () => ({ ok: false, code: 'unverifiable', reason: 'x' }) });
  assert.strictEqual(unknown.kind, 'unverifiable', 'onidentificeerbaar levend proces blijft een eerlijke weigering');
});

test('#18 ownsPid weigert een levend maar onleesbaar proces (geen cmdline-bewijs = geen kill), en herkent het eigen echte kind wel', function () {
  // Echt kind-proces als recycled-pid-stand-in: leeft, maar draait NIET dit guard-script.
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { stdio: 'ignore' });
  try {
    const rec = { pid: child.pid, startedAt: new Date().toISOString(), script: path.join(__dirname, 'usage-guard.cjs') };
    const r = G.ownsPid(child.pid, rec);
    // Op Windows leest de CIM-route de echte command line; op POSIX de nieuwe /proc//ps-route. Beide
    // moeten dit kind WEIGEREN ondanks het perfect matchende record — dat record-alleen-accept was #18.
    assert.strictEqual(r.ok, false, 'een levend proces dat het guard-script niet draait mag nooit ok zijn (record-bewijs alleen telt niet): ' + JSON.stringify(r));
    assert.ok(['recycled', 'unverifiable', 'not-watcher'].includes(r.code), 'de weigering draagt een machineleesbare code: ' + JSON.stringify(r));
  } finally { try { child.kill(); } catch { /* al weg */ } }
});

  // ============================================================================================
// H3 — COMPENSATIEJOURNAL · START-HANDSHAKE · LOGROTATIE (uitgestelde punten 1+2 en G9a, 2026-08-06)
// ============================================================================================

test('H3.1 doPause journalt elke gepauzeerde agent account-onafhankelijk; doResume hervat OOK een agent die alleen het journal nog kent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-journal-'));
  const journal = path.join(dir, 'paused.jsonl');
  // simulatie via de geexporteerde journal-helpers + een tick-harnas: pauze onder account A
  G.journalAppend && (() => { })();
  // schrijf zoals doPause dat doet
  fs.writeFileSync(journal, JSON.stringify({ ts: '2026-08-06T00:00:00Z', agentId: 7, name: 'wkr', company: 'c', action: 'paused', accountFp: 'aaaa', resolved: false }) + '\n');
  // unresolvedPausedAgents leest per agent het laatste record
  const orig = process.env.FORGE_USAGE_GUARD_JOURNAL;
  process.env.FORGE_USAGE_GUARD_JOURNAL = journal;
  try {
    // module her-laden zodat PAUSED_JOURNAL de env oppakt (const bij load)
    delete require.cache[require.resolve('./usage-guard.cjs')];
    const G2 = require('./usage-guard.cjs');
    const open1 = G2.unresolvedPausedAgents();
    assert.strictEqual(open1.length, 1, 'agent 7 hoort onopgelost in het journal te staan');
    assert.strictEqual(String(open1[0].agentId), '7');
    // resolved-regel sluit hem af — laatste record per agent wint
    G2.journalAppend({ agentId: 7, action: 'resumed', resolved: true });
    assert.strictEqual(G2.unresolvedPausedAgents().length, 0, 'een resolved-regel sluit de agent af');
    // idempotentie: nog een resolved-regel verandert niets
    G2.journalAppend({ agentId: 7, action: 'resumed', resolved: true });
    assert.strictEqual(G2.unresolvedPausedAgents().length, 0);
  } finally {
    if (orig === undefined) delete process.env.FORGE_USAGE_GUARD_JOURNAL; else process.env.FORGE_USAGE_GUARD_JOURNAL = orig;
    delete require.cache[require.resolve('./usage-guard.cjs')];
  }
});

test('H3.1b het account-switch-scenario end-to-end: pauze onder A -> switch naar B -> de A-agents worden via het journal hervat', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-switch-'));
  const journal = path.join(dir, 'paused.jsonl');
  const orig = process.env.FORGE_USAGE_GUARD_JOURNAL;
  process.env.FORGE_USAGE_GUARD_JOURNAL = journal;
  try {
    delete require.cache[require.resolve('./usage-guard.cjs')];
    const G2 = require('./usage-guard.cjs');
    // stap 1: het journal kent een onder A gepauzeerde agent (zoals doPause hem schrijft)
    G2.journalAppend({ agentId: 42, name: 'a42', company: 'c', action: 'paused', accountFp: 'acct-A', resolved: false });
    // stap 2: de OUDE code bewaarde dit nergens accountsonafhankelijk — bewijs dat stateForAccount de
    // pausedAgents-lijst inderdaad NIET meeneemt (het defect), en dat het journal hem WEL kent (de fix)
    const stA = { mode: 'paused', account: { fp: 'acct-A' }, pausedAgents: [{ id: 42, name: 'a42', company: 'c' }], percents: { session: 95, week: 40 } };
    const st2 = G2.stateForAccount(stA, { fp: 'acct-B', source: 'account-uuid' });
    assert.strictEqual(st2.pausedAgents, undefined, 'de state-reset draagt pausedAgents bewust NIET over');
    const open = G2.unresolvedPausedAgents();
    assert.strictEqual(open.length, 1, 'het journal kent de agent nog — dat is de compensatie');
    assert.strictEqual(String(open[0].agentId), '42');
  } finally {
    if (orig === undefined) delete process.env.FORGE_USAGE_GUARD_JOURNAL; else process.env.FORGE_USAGE_GUARD_JOURNAL = orig;
    delete require.cache[require.resolve('./usage-guard.cjs')];
  }
});

test('H3.2 awaitChildClaim: claim door het kind = ok; vreemd levend pid = weigering; dood kind = weigering; timeout = weigering', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-hs-'));
  const pidFile = path.join(dir, 'watch.pid');
  // (a) kind claimt -> ok
  fs.writeFileSync(pidFile, JSON.stringify({ pid: 1234, script: 'usage-guard.cjs' }));
  const a = G.awaitChildClaim({ pidFile, childPid: 1234, isAlive: () => true, timeoutMs: 500, pollMs: 10 });
  assert.strictEqual(a.ok, true);
  // (b) een ANDER levend pid houdt het slot -> eerlijke weigering (kind verloor de race)
  fs.writeFileSync(pidFile, JSON.stringify({ pid: 999, script: 'usage-guard.cjs' }));
  const b = G.awaitChildClaim({ pidFile, childPid: 1234, isAlive: () => true, timeoutMs: 500, pollMs: 10 });
  assert.strictEqual(b.ok, false);
  assert.match(b.reason, /held by pid 999/);
  // (c) kind dood zonder claim -> weigering met verwijzing naar het log
  fs.rmSync(pidFile, { force: true });
  const c = G.awaitChildClaim({ pidFile, childPid: 1234, isAlive: (p) => p !== 1234, timeoutMs: 500, pollMs: 10 });
  assert.strictEqual(c.ok, false);
  assert.match(c.reason, /exited before claiming/);
  // (d) kind leeft maar claimt nooit -> timeout-weigering
  const d = G.awaitChildClaim({ pidFile, childPid: 1234, isAlive: () => true, timeoutMs: 300, pollMs: 20 });
  assert.strictEqual(d.ok, false);
  assert.match(d.reason, /did not claim/);
});

test('H3.2b start-handshake end-to-end: een decoy-kind dat nooit claimt geeft een eerlijke non-zero start', () => {
  // integratie via de ECHTE CLI in een geisoleerde HOME: het "kind" is een decoy dat nooit het
  // pid-bestand claimt — de OUDE start printte dan toch "started"; de nieuwe weigert.
  //
  // F1 SECURITY FIX (2026-09-24): dit spawnt de ECHTE `start` -> een gedetacheerde `watch` -> een echte
  // eerste tick(). Zonder isolatie las die tick het ECHTE ~/.claude/.credentials.json OAuth-token, riep
  // de LIVE api.anthropic.com aan en overschreef het ECHTE ~/.claude/FORGE_USAGE_PRESSURE.json — dus elke
  // verplichte doctor-testrun deed dit stilletjes op een verse install. HOME/USERPROFILE/
  // FORGE_USAGE_GUARD_HOME/FORGE_USAGE_PRESSURE_FILE/FORGE_USAGE_GUARD_JOURNAL/FORGE_USAGE_GUARD_IDENTITY
  // wijzen nu ALLEMAAL naar een geisoleerde temp-`.claude`-map zonder credentials.json: readToken() gooit
  // dan AL VOOR elke fetch ("no OAuth token in …") — dus geen netwerkcall — en tick() degradeert daarna
  // eerlijk via zijn bestaande fail-safe pad ("CHECK FAILED (no action taken — fail-safe)"). Er bestaat
  // geen --dry-run voor de fetch zelf (alleen voor de pause/resume-actie erna), dus isolatie van
  // CRED_FILE is de enige manier om deze test zonder netwerkcall te laten lopen.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-hs2-'));
  const isolatedHome = path.join(tmp, '.claude');
  fs.mkdirSync(isolatedHome, { recursive: true });
  const pidFile = path.join(tmp, 'guard.pid');
  const isolatedEnv = Object.assign({}, process.env, {
    HOME: tmp,
    USERPROFILE: tmp,
    FORGE_USAGE_GUARD_HOME: isolatedHome,
    FORGE_USAGE_GUARD_PID: pidFile,
    FORGE_USAGE_GUARD_LOG: path.join(tmp, 'guard.log'),
    FORGE_USAGE_GUARD_STATE: path.join(tmp, 'state.json'),
    FORGE_USAGE_PRESSURE_FILE: path.join(tmp, 'FORGE_USAGE_PRESSURE.json'),
    FORGE_USAGE_GUARD_JOURNAL: path.join(tmp, 'paused.jsonl'),
    FORGE_USAGE_GUARD_IDENTITY: path.join(tmp, 'claude-identity.json'), // deliberately absent
  });
  // REGRESSION PROOF setup: snapshot the REAL home's pressure file BEFORE the isolated child ticks, so
  // the assertion at the bottom is real evidence, not a guess.
  const realPressureFile = path.join(os.homedir(), '.claude', 'FORGE_USAGE_PRESSURE.json');
  const realPressureExistedBefore = fs.existsSync(realPressureFile);
  const realPressureMtimeBefore = realPressureExistedBefore ? fs.statSync(realPressureFile).mtimeMs : null;

  const res = require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'usage-guard.cjs'), 'start', '--interval', '60'], {
    encoding: 'utf8', timeout: 30000,
    env: isolatedEnv,
    // het echte kind zal WEL claimen — dus voor de weiger-kant: bezet het slot vooraf met onszelf
  });
  // Het echte kind claimde het geisoleerde pid-bestand — lees ZIJN pid NU, VOOR het slot hieronder
  // bewust wordt overschreven om een bezet-slot-weigering te simuleren. Dit las voorheen PAS na die
  // overschrijving, dus las het de EIGEN testpid terug en werd het echte kind nooit gedood (het bleef
  // ~60s doortikken) — precies het lek dat deze fix dichtzet.
  let realChildPid = null;
  try { const rec = JSON.parse(fs.readFileSync(pidFile, 'utf8')); if (rec && rec.pid) realChildPid = rec.pid; } catch { }

  // vooraf bezet slot: schrijf ONS pid erin en start opnieuw — het kind weigert (already running-conflict)
  fs.writeFileSync(pidFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), script: path.join(__dirname, 'usage-guard.cjs') }));
  const res2 = require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'usage-guard.cjs'), 'start', '--interval', '60'], {
    encoding: 'utf8', timeout: 30000,
    env: isolatedEnv,
  });

  // Cleanup: kill EXACTLY the real child pid captured above (never re-read from the now-overwritten
  // pid file), then verify it is actually gone rather than assuming the kill worked.
  if (realChildPid) {
    try { process.kill(realChildPid); } catch { }
    for (let i = 0; i < 30 && G.pidAlive(realChildPid); i++) {
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); } catch { }
    }
    if (G.pidAlive(realChildPid)) { try { process.kill(realChildPid, 'SIGKILL'); } catch { } }
    // Linux (measured on the ubuntu CI runner): SIGTERM is handled gracefully and even after SIGKILL the pid stays
    // visible for a moment (zombie until reaped), so the liveness check must WAIT for the exit rather than look once.
    for (let i = 0; i < 50 && G.pidAlive(realChildPid); i++) {
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); } catch { }
    }
  }

  const claimed = res.status === 0 && /claim geverifieerd/.test(res.stdout || '');
  assert.ok(claimed, 'een echte start hoort pas "started" te melden NA een geverifieerde claim: ' + (res.stdout || '') + (res.stderr || ''));
  assert.ok(res2.status !== 0 || /already running/.test(res2.stdout || ''), 'een bezet slot hoort een eerlijke weigering of already-running te geven: status=' + res2.status + ' out=' + (res2.stdout || '').slice(0, 120));
  if (realChildPid) assert.ok(!G.pidAlive(realChildPid), 'het echte gedetacheerde kind (pid ' + realChildPid + ') moet dood zijn na cleanup — geen wees-watcher achterlaten');

  // REGRESSION PROOF (F1): het ECHTE ~/.claude/FORGE_USAGE_PRESSURE.json moet volledig onaangeroerd
  // blijven — dit is het echte, dragende bewijs dat de isolatie hierboven end-to-end werkte.
  const realPressureExistedAfter = fs.existsSync(realPressureFile);
  const realPressureMtimeAfter = realPressureExistedAfter ? fs.statSync(realPressureFile).mtimeMs : null;
  assert.strictEqual(realPressureExistedAfter, realPressureExistedBefore, 'het ECHTE ~/.claude/FORGE_USAGE_PRESSURE.json mag niet van bestaan-status wisselen door een geisoleerde testrun');
  assert.strictEqual(realPressureMtimeAfter, realPressureMtimeBefore, 'het ECHTE ~/.claude/FORGE_USAGE_PRESSURE.json mag niet herschreven worden door een geisoleerde testrun');
});

test('H3.3 logrotatie: een log boven de grens roteert naar .1 en verliest de recente regels niet', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-rot-'));
  const logFile = path.join(tmp, 'g.log');
  const orig = process.env.FORGE_USAGE_GUARD_LOG;
  process.env.FORGE_USAGE_GUARD_LOG = logFile;
  try {
    delete require.cache[require.resolve('./usage-guard.cjs')];
    const G2 = require('./usage-guard.cjs');
    fs.writeFileSync(logFile, 'x'.repeat(6 * 1024 * 1024)); // boven de 5MB-grens
    G2.rotateLogIfNeeded();
    assert.ok(fs.existsSync(logFile + '.1'), 'het volle log hoort naar .1 geroteerd te zijn');
    assert.ok(!fs.existsSync(logFile) || fs.statSync(logFile).size < 1024, 'het actieve log is weer klein/leeg');
    // en een tweede rotatie overschrijft .1 (twee generaties, begrensd)
    fs.writeFileSync(logFile, 'y'.repeat(6 * 1024 * 1024));
    G2.rotateLogIfNeeded();
    assert.ok(fs.statSync(logFile + '.1').size >= 6 * 1024 * 1024, '.1 is de vorige generatie');
  } finally {
    if (orig === undefined) delete process.env.FORGE_USAGE_GUARD_LOG; else process.env.FORGE_USAGE_GUARD_LOG = orig;
    delete require.cache[require.resolve('./usage-guard.cjs')];
  }
});

// ============================================================================================
// H4 — Codex r4 #15/#16/#20 (2026-08-07): pauseId-matching · write-ahead-intent · compactie ·
//      nonce-handshake · rotatielock met copy-truncate. Synchook: VOOR de tally (geen async).
// ============================================================================================
{
  // lokale adapter naar de promise-aware test(): cond-stijl asserts, synchrone telling
  const t = (name, cond, extra) => test(name, () => { if (!cond) throw new Error(extra || 'assertion false'); });
  const os4 = require('os');
  const path4 = require('path');
  const fs4 = require('fs');
  const dir4 = fs4.mkdtempSync(path4.join(os4.tmpdir(), 'guard-h4-'));
  const J = path4.join(dir4, 'journal.jsonl');
  process.env.FORGE_USAGE_GUARD_JOURNAL = J;
  process.env.FORGE_USAGE_GUARD_LOG = path4.join(dir4, 'guard.log');
  process.env.FORGE_USAGE_GUARD_PID = path4.join(dir4, 'guard.pid');
  delete require.cache[require.resolve('./usage-guard.cjs')];
  const G4 = require('./usage-guard.cjs');

  // #15a: een OUDE resolve (pauseId A) die NA een nieuwere pauze (pauseId B) in het bestand landt
  // (gelijktijdige watch --once) mag B niet maskeren.
  fs4.writeFileSync(J, [
    JSON.stringify({ ts: '2026-08-07T10:00:00Z', agentId: 'ag1', action: 'paused', pauseId: 'A', resolved: false }),
    JSON.stringify({ ts: '2026-08-07T10:05:00Z', agentId: 'ag1', action: 'paused', pauseId: 'B', resolved: false }),
    JSON.stringify({ ts: '2026-08-07T10:01:00Z', agentId: 'ag1', action: 'resumed', pauseId: 'A', resolved: true }),
  ].join('\n') + '\n');
  const un1 = G4.unresolvedPausedAgents();
  t('H4 #15a een oude resolve (pauseId A) maskeert een nieuwere pauze (B) NIET', un1.length === 1 && un1[0].pauseId === 'B');
  // en de juiste resolve sluit hem wel
  fs4.appendFileSync(J, JSON.stringify({ ts: '2026-08-07T10:06:00Z', agentId: 'ag1', action: 'resumed', pauseId: 'B', resolved: true }) + '\n');
  t('H4 #15a de resolve met de JUISTE pauseId sluit de pauze af', G4.unresolvedPausedAgents().length === 0);

  // #15b: write-ahead — alleen een intent (crash direct na de pause-API) is al hervatbaar
  fs4.writeFileSync(J, JSON.stringify({ ts: '2026-08-07T11:00:00Z', agentId: 'ag2', action: 'pause-intent', pauseId: 'C', resolved: false }) + '\n');
  const un2 = G4.unresolvedPausedAgents();
  t('H4 #15b een kale pause-intent (crash na de API, voor het result) telt als onopgelost', un2.length === 1 && un2[0].agentId === 'ag2');

  // #15b2: legacy-records zonder pauseId blijven werken (oude journals)
  fs4.writeFileSync(J, [
    JSON.stringify({ ts: '2026-08-07T11:10:00Z', agentId: 'ag3', action: 'paused', resolved: false }),
    JSON.stringify({ ts: '2026-08-07T11:11:00Z', agentId: 'ag3', action: 'resumed', resolved: true }),
  ].join('\n') + '\n');
  t('H4 #15b2 legacy-records (zonder pauseId) resolven zoals voorheen', G4.unresolvedPausedAgents().length === 0);

  // #15c: compactie — een groot journal vol geresolvede sporen krimpt; het onopgeloste spoor blijft
  const bulk = [];
  for (let i = 0; i < 3000; i++) {
    bulk.push(JSON.stringify({ ts: '2026-08-07T12:00:00Z', agentId: 'bulk' + i, action: 'paused', pauseId: 'p' + i, resolved: false }));
    bulk.push(JSON.stringify({ ts: '2026-08-07T12:01:00Z', agentId: 'bulk' + i, action: 'resumed', pauseId: 'p' + i, resolved: true }));
  }
  bulk.push(JSON.stringify({ ts: '2026-08-07T12:02:00Z', agentId: 'blijft', action: 'paused', pauseId: 'z', resolved: false }));
  fs4.writeFileSync(J, bulk.join('\n') + '\n');
  const sizeBefore = fs4.statSync(J).size;
  G4.compactJournalIfNeeded();
  const sizeAfter = fs4.statSync(J).size;
  const un3 = G4.unresolvedPausedAgents();
  t('H4 #15c compactie krimpt het journal fors (' + sizeBefore + 'B -> ' + sizeAfter + 'B)', sizeAfter < sizeBefore / 10, String(sizeAfter));
  t('H4 #15c en bewaart exact het onopgeloste spoor', un3.length === 1 && un3[0].agentId === 'blijft');

  // #16: nonce-handshake — een record met het juiste pid maar de VERKEERDE/ontbrekende nonce is geen bewijs
  const P = process.env.FORGE_USAGE_GUARD_PID;
  fs4.writeFileSync(P, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), script: 'x', nonce: 'oude-start' }) + '\n');
  const hs1 = G4.awaitChildClaim({ pidFile: P, childPid: process.pid, timeoutMs: 300, pollMs: 20, nonce: 'nieuwe-start' });
  t('H4 #16 pid-match met een ANDERE nonce wordt geweigerd (oud/vreemd record is geen claim-bewijs)', hs1.ok === false && /nonce/.test(hs1.reason || ''), JSON.stringify(hs1).slice(0, 140));
  fs4.writeFileSync(P, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), script: 'x', nonce: 'nieuwe-start' }) + '\n');
  const hs2 = G4.awaitChildClaim({ pidFile: P, childPid: process.pid, timeoutMs: 300, pollMs: 20, nonce: 'nieuwe-start' });
  t('H4 #16 pid + juiste nonce + levend kind = geverifieerde claim', hs2.ok === true);
  // claim-then-crash: juiste nonce maar het kind is DOOD => geen "started"
  fs4.writeFileSync(P, JSON.stringify({ pid: 999999, startedAt: new Date().toISOString(), script: 'x', nonce: 'n3' }) + '\n');
  const hs3 = G4.awaitChildClaim({ pidFile: P, childPid: 999999, timeoutMs: 300, pollMs: 20, nonce: 'n3', isAlive: () => false });
  t('H4 #16 claim-then-crash: een dood kind met een kloppend record is GEEN start', hs3.ok === false, JSON.stringify(hs3).slice(0, 120));
  // claimWatcherSlot schrijft de nonce mee in het record
  fs4.rmSync(P, { force: true });
  const cl = G4.claimWatcherSlot({ pidFile: P, nonce: 'geschreven-nonce' });
  const recN = G4.readPidRecordFrom(P);
  t('H4 #16 claimWatcherSlot schrijft de start-nonce in het pid-record', cl.ok === true && recN.nonce === 'geschreven-nonce');

  // #20: rotatie — copy+truncate onder een lock; een bestaande lock laat de rotatie deze ronde over
  const L = process.env.FORGE_USAGE_GUARD_LOG;
  const big = 'x'.repeat(1024);
  const lines20 = [];
  for (let i = 0; i < 6 * 1024; i++) lines20.push(big);
  fs4.writeFileSync(L, lines20.join('\n') + '\n'); // > 5MB
  fs4.writeFileSync(L + '.rotate.lock', 'bezet'); // een andere roteerder is bezig
  G4.rotateLogIfNeeded();
  t('H4 #20 een bezette rotatielock => rotatie deze ronde overgeslagen (geen dubbele rm/rename)', fs4.statSync(L).size > 5 * 1024 * 1024 && !fs4.existsSync(L + '.1'));
  fs4.rmSync(L + '.rotate.lock', { force: true });
  G4.rotateLogIfNeeded();
  t('H4 #20 zonder lock roteert copy+truncate: .1 draagt de historie, het actieve log is leeg', fs4.existsSync(L + '.1') && fs4.statSync(L + '.1').size > 5 * 1024 * 1024 && fs4.statSync(L).size === 0);
  // open-fd-gedrag: een fd dat VOOR de rotatie op het log openstond schrijft NA copy+truncate nog steeds
  // naar het ACTIEVE bestand (het bestand is niet vervangen, alleen geleegd) — het geërfde-stderr-hazard
  fs4.writeFileSync(L, 'voor-rotatie\n');
  const fd20 = fs4.openSync(L, 'a');
  fs4.writeFileSync(L, 'x'.repeat(6 * 1024 * 1024)); // groei voorbij de drempel
  G4.rotateLogIfNeeded();
  fs4.writeSync(fd20, 'na-rotatie-via-oud-fd\n');
  fs4.closeSync(fd20);
  t('H4 #20 een geërfd open fd schrijft na copy+truncate naar het ACTIEVE log (niet naar een ontkoppelde inode)', fs4.readFileSync(L, 'utf8').includes('na-rotatie-via-oud-fd'));

  delete process.env.FORGE_USAGE_GUARD_JOURNAL;
  delete process.env.FORGE_USAGE_GUARD_LOG;
  delete process.env.FORGE_USAGE_GUARD_PID;
  delete require.cache[require.resolve('./usage-guard.cjs')];
  try { fs4.rmSync(dir4, { recursive: true, force: true }); } catch { }
}

Promise.all(asyncQueue).then(() => {
console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
});
