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

// CONFIG SANDBOX (v2.7.0, 2026-09-24): usage-guard.cjs now reads its thresholds and its on/off switch through
// forge-config.cjs when it loads. Point that resolver at a throwaway home + project root BEFORE the first
// require, so no test here reads the owner's real FORGE_CONFIG.json — and every child process inherits the sandbox.
const CONFIG_SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-cfg-'));
process.env.FORGE_CONFIG_HOME = path.join(CONFIG_SANDBOX, 'home');
process.env.FORGE_PROJECT_ROOT = path.join(CONFIG_SANDBOX, 'project');

// TEST-CREDENTIAL-ISOLATION (2026-09-24): every path usage-guard.cjs derives from HOME (CRED_FILE,
// STATE_FILE, PID_FILE, LOG_FILE, PAUSED_JOURNAL, PRESSURE_FILE, IDENTITY_FILE, the account-map file) is
// computed ONCE at module load time from FORGE_USAGE_GUARD_HOME / FORGE_USAGE_GUARD_IDENTITY (or the
// real ~/.claude when those are unset). This file used to set only the two config-sandbox vars above
// before the module's first `require()` below — every OTHER seam kept resolving to the REAL ~/.claude,
// so a test whose injected `deps` omitted one function (readCredentialFp — confirmed missing from
// tickHarness, see the #13 tests) silently fell back to the real reader and touched the real
// .credentials.json. ALL isolation now happens BEFORE this file's own first require of the module.
const REAL_HOME = os.homedir();
const ISOLATED_HOME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-isolated-home-'));
const ISOLATED_CLAUDE_HOME = path.join(ISOLATED_HOME_ROOT, '.claude');
fs.mkdirSync(ISOLATED_CLAUDE_HOME, { recursive: true });
process.env.HOME = ISOLATED_HOME_ROOT;
process.env.USERPROFILE = ISOLATED_HOME_ROOT;
process.env.FORGE_USAGE_GUARD_HOME = ISOLATED_CLAUDE_HOME;
process.env.FORGE_USAGE_GUARD_IDENTITY = path.join(ISOLATED_CLAUDE_HOME, '.claude.json');

// Deny-by-default net: every path override above should make a real-credential read impossible, but a
// regression must be a loud, immediate test failure — never a silent real-network/real-credential read.
const realFsReadFileSync = fs.readFileSync;
const REAL_CRED_FILE = path.join(REAL_HOME, '.claude', '.credentials.json');
fs.readFileSync = function guardedReadFileSync(p, ...rest) {
  if (typeof p === 'string' && path.resolve(p) === REAL_CRED_FILE) {
    throw new Error('TEST ISOLATION VIOLATION: attempted to read the REAL credentials file at ' + p);
  }
  return realFsReadFileSync.call(fs, p, ...rest);
};

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

// WP-S14 finding 1.2 (2026-09-26 independent review): this test used to claim the OPPOSITE of the real
// N1 decision (see windowAppliesNow, ~line 890) — an API-inactive PER-MODEL window with no matching model
// hint is advisory only; it does NOT pause every model for days while a different model is in use.
// crossedWindows() itself is threshold-only (it has no concept of "model in use"), so it still correctly
// reports the window crossed; the REAL pause decision additionally requires windowAppliesNow().
test('an API-inactive per-model window crosses the raw threshold but is ADVISORY ONLY — it does not pause (N1)', () => {
  const w = G.normalizeWindows({ limits: [{ kind: 'weekly_scoped', percent: 96, is_active: false, resets_at: null, scope: { model: { display_name: 'Fable' } } }] });
  assert.strictEqual(w[0].isActive, false);
  assert.strictEqual(G.crossedWindows(w, 93).length, 1, 'crossedWindows() is threshold-only and unaware of model scope');
  assert.strictEqual(G.windowAppliesNow(w[0], null), false, 'no matching model hint and the endpoint says inactive -> advisory, not a real pause trigger');
  const wouldActuallyPause = G.crossedWindows(w, 93).filter((x) => G.windowAppliesNow(x, null));
  assert.strictEqual(wouldActuallyPause.length, 0, 'the real pause decision (crossedWindows + windowAppliesNow) must not include this window');
});
// WP-S14 1.2 hardening (reviewer note): session/weekly_all are all-models BY KIND, not merely "no
// scope.model was present" — a malformed/unexpected scope.model on one of them must never turn it into a
// per-model window that could be silently filtered out of the pause decision.
test('WP-S14 1.2 hardening: session/weekly_all stay all-models even with a malformed scope.model', () => {
  const w = G.normalizeWindows({ limits: [
    { kind: 'session', group: 'session', percent: 99, is_active: false, scope: { model: { display_name: 'Fable' } } },
    { kind: 'weekly_all', group: 'weekly', percent: 99, is_active: false, scope: { model: { display_name: 'Fable' } } },
  ] });
  const session = w.find((x) => x.kind === 'session');
  const weeklyAll = w.find((x) => x.kind === 'weekly_all');
  assert.strictEqual(session.model, null, 'a scope.model on a session window must be ignored — session is all-models by kind');
  assert.strictEqual(weeklyAll.model, null, 'a scope.model on a weekly_all window must be ignored — weekly_all is all-models by kind');
  assert.strictEqual(G.windowAppliesNow(session, null), true);
  assert.strictEqual(G.windowAppliesNow(weeklyAll, null), true);
  // defense in depth: even a hand-built window object that (wrongly) carries a .model on one of these
  // kinds must still always apply — windowAppliesNow checks the KIND too, not only whether .model is set.
  assert.strictEqual(G.windowAppliesNow({ kind: 'session', model: 'Fable', isActive: false }, null), true);
  assert.strictEqual(G.windowAppliesNow({ kind: 'weekly_all', model: 'Fable', isActive: false }, null), true);
});
// WP-S14 1.2 hardening (reviewer note): a raw model id (as set via FORGE_USAGE_GUARD_MODEL) never matched
// the usage endpoint's human display name for the same model — sameModel/normalizeModelToken now strip
// the "claude-" prefix and every separator before comparing.
test('WP-S14 1.2 hardening: sameModel normalises a raw model id and a display name to the same token', () => {
  assert.strictEqual(G.sameModel('claude-opus-4-8', 'Opus 4.8'), true);
  assert.strictEqual(G.sameModel('claude-opus-5-5', 'Opus 5.5'), true);
  assert.strictEqual(G.sameModel('Opus 4.8', 'claude-opus-4-8'), true, 'must be symmetric');
  assert.strictEqual(G.sameModel('claude-opus-4-8', 'Opus 5.5'), false, 'different models must still not match');
  assert.strictEqual(G.normalizeModelToken('claude-opus-4-8'), G.normalizeModelToken('Opus 4.8'));
});
test('WP-S14 1.2 hardening: a raw model id in FORGE_USAGE_GUARD_MODEL now matches a per-model window\'s display name', () => {
  const saved = process.env.FORGE_USAGE_GUARD_MODEL;
  try {
    process.env.FORGE_USAGE_GUARD_MODEL = 'claude-opus-4-8';
    const hint = G.resolveActiveModelHint({});
    assert.strictEqual(hint, 'claude-opus-4-8');
    assert.strictEqual(G.windowAppliesNow({ kind: 'weekly_scoped', model: 'Opus 4.8', isActive: null }, hint), true,
      'a raw model id env hint must match the window\'s human display name');
  } finally {
    if (saved === undefined) delete process.env.FORGE_USAGE_GUARD_MODEL; else process.env.FORGE_USAGE_GUARD_MODEL = saved;
  }
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
    // TEST-CREDENTIAL-ISOLATION (2026-09-24): without this override, tick()'s default readCredentialFp
    // reads the real CRED_FILE (now redirected by the isolated FORGE_USAGE_GUARD_HOME above, but this
    // explicit override is the correct fix regardless of that isolation — a harness's injected deps
    // object should be fully self-contained, not rely on a module-level env seam it never mentions).
    // null mirrors "no credential readable", which is harmless here: fetchUsage() is always overridden
    // per-test and never sets u.credentialFp unless a test explicitly wants to exercise that branch.
    readCredentialFp: () => null,
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

test('N01 (second Codex recheck, 2026-09-24): a first low-usage tick stamps account A into state; enabling an override for A then switching to account B at 100% must clear the foreign override and pause — account reconciliation now happens INSIDE the locked "normal ok write" transaction, not only in the pre-lock decision snapshot', async () => {
  const identA = { fp: 'n01-account-a', source: 'account-uuid' };
  const h = tickHarness({
    initialState: { mode: 'ok' }, // genuinely fresh state — mirrors a brand-new install, never yet stamped
    deps: {
      readIdentity: () => ({ ...identA }),
      fetchUsage: async () => usageWith(20), // low usage — takes the "normal ok write" branch, never pause
    },
  });
  await G.tick(h.deps);
  assert.strictEqual(h.state.value.account && h.state.value.account.fp, 'n01-account-a',
    'the FIRST successful (low-usage, non-switch, non-pause) tick must stamp the account — leaving it unstamped is exactly what let the NEXT tick misread a real switch as "first-stamp (adoption)": ' + JSON.stringify(h.state.value));

  // Mirrors the shape override-on's own N01 stamping fix produces for account A (exercised end-to-end
  // separately at the CLI level below) — an active override sitting in state while account is stamped A.
  h.state.value.ownerOverride = { active: true, at: new Date().toISOString(), reason: 'test override for A' };

  // Switch identity to a DIFFERENT account and measure 100% usage.
  const identB = { fp: 'n01-account-b', source: 'account-uuid' };
  h.deps.readIdentity = () => ({ ...identB });
  h.deps.fetchUsage = async () => usageWith(100);
  await G.tick(h.deps);

  assert.strictEqual(h.state.value.ownerOverride, undefined, 'account B\'s tick must NEVER inherit account A\'s override — the switch write is a full, clean reset: ' + JSON.stringify(h.state.value));
  assert.strictEqual(h.state.value.account && h.state.value.account.fp, 'n01-account-b', 'the switch write must stamp the NEW account');
  assert.strictEqual(h.calls.doPause.length, 1, 'account B at 100% must actually reach doPause once the foreign override is correctly cleared (the regression made zero pauses happen)');
  assert.strictEqual(h.calls.doPause[0].ident && h.calls.doPause[0].ident.fp, 'n01-account-b');
});

// ---- V15 (Codex recheck out-p10, 2026-09-24, FOURTH recheck of usage-guard's own lock/override design):
// state.json's `ownerOverride` cache is no longer trusted on its own for the pause/don't-pause decision —
// it is recomputed FRESH, every tick, from an independent, single-writer, expiry-aware grant record
// (forge-ownergrant.cjs's readOverrideGrant/writeOverrideGrant, see usage-guard-override.cjs's own header).
// This maps directly onto Codex's five-step schedule (B reclaims and passes its fence; a delayed reclaimer R
// captures B's fresh lock; C clears the override through a real writeStateTo; R's restore fails against C's
// lock; B's already-approved rename still resurrects `active:true`): the SPECIFIC vacancy that schedule
// depended on is now structurally impossible (usage-guard-state.test.cjs's own "the lock path is NEVER
// absent during a reclaim" proof), but the file's own honest residual note stands — writeStateTo's adjacent
// fence-check-then-rename remains two syscalls, and a real OS can in principle still interleave another
// process's action between them. These three tests prove the CONSEQUENCE that residual would produce (a
// resurrected or wrongly-cleared cache) can no longer change the real outcome.
//
// `__setOwnerGrantRootForTests` is a MODULE-LEVEL mutation (see usage-guard.cjs's own N06 history for why
// it exists as an in-process, require()-only seam). This project's own documented hazard — a synchronous
// mutation made by an earlier, still-pending ASYNC test body leaks into every LATER test's view, because
// nothing in this shared test file's queueing model runs a `finally` block until that specific test's own
// awaited promise actually resolves, which happens well after every OTHER test() call in this file has
// already been registered and started running — applies here just as much as to `process.env`/`global.fetch`
// (a first attempt at these three tests set/reset this exact seam in-process and measurably corrupted TWO
// unrelated, pre-existing tests elsewhere in this same file). Each test below therefore runs in its own
// SPAWNED SUBPROCESS (this file's own established convention for this entire class of hazard), so the seam
// lives and dies with a single, disposable process and can never leak into anything else.
function runV15OverrideProbe(scriptLines, extraEnv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-v15-override-'));
  const script = path.join(dir, 'probe.cjs');
  fs.writeFileSync(script, scriptLines.join('\n'), 'utf8');
  const env = Object.assign({}, process.env, {
    FORGE_USAGE_GUARD_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'guard-v15-override-home-')),
    FORGE_CONFIG_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'guard-v15-override-cfghome-')),
    FORGE_PROJECT_ROOT: fs.mkdtempSync(path.join(os.tmpdir(), 'guard-v15-override-proj-')),
    FORGE_USAGE_GUARD_STATE: path.join(dir, 'state.json'),
    NVIDIA_SKIP_ENV_FILES: '1',
  });
  delete env.FORGE_USAGE_GUARD_STATE_LOCK_WAIT_MS;
  Object.assign(env, extraEnv || {}); // deliberately AFTER the delete — a caller may opt back in
  const r = require('child_process').spawnSync(process.execPath, [script], { encoding: 'utf8', env, timeout: 30000 });
  const lastLine = (r.stdout || '').trim().split('\n').pop();
  let out; try { out = JSON.parse(lastLine); } catch { out = { parseError: (r.stdout || '') + (r.stderr || '') }; }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  return out;
}
const V15_PROBE_FETCH_MOCK = [
  'global.fetch = async (url) => {',
  '  const u = String(url);',
  '  if (/\\/api\\/companies$/.test(u)) return { ok: true, status: 200, json: async () => [] };', // zero agents — only the OVERRIDE DECISION is under test here
  '  return { ok: true, status: 200, json: async () => ({}) };',
  '};',
];

test('V15: a genuinely GRANTED, unexpired override still suppresses pausing at 100% usage — the grant must actively PERMIT this, not merely fail to forbid it', () => {
  const out = runV15OverrideProbe([
    "'use strict';",
    ...V15_PROBE_FETCH_MOCK,
    'const fs = require("fs"); const path = require("path");',
    'const G = require(' + JSON.stringify(path.join(__dirname, 'usage-guard.cjs')) + ');',
    'const grantRoot = fs.mkdtempSync(path.join(require("os").tmpdir(), "guard-v15-grant-on-scratch-"));',
    'G.__setOwnerGrantRootForTests(grantRoot);',
    // N10 (2026-09-24): the grant is now bound to an account label — write one MATCHING the identity this
    // tick measures under, and a real future `until` (N12: a missing expiry is INVALID, never "unlimited").
    'const until = new Date(Date.now()+3600000).toISOString();',
    // wave 8: a grant now needs a matching credentialGeneration stamp on both sides to be honoured at all
    // (see usage-guard-override.cjs's own header) — this test is about the ACCOUNT-BINDING positive case,
    // so the generation stamp is trivially equal here (nothing rotated), never the thing under test.
    'require(' + JSON.stringify(path.join(__dirname, 'forge-ownergrant.cjs')) + ').writeOverrideGrant({ active: true, at: new Date().toISOString(), until, reason: "test grant", accountLabel: "v15-on-account", credentialGeneration: "G0" }, { projectRoot: grantRoot });',
    'fs.writeFileSync(process.env.FORGE_USAGE_GUARD_STATE, JSON.stringify({ mode: "ok", ownerOverride: { active: true, at: new Date().toISOString(), reason: "test grant" } }));',
    '(async () => {',
    '  const ident = { fp: "v15-on-account", source: "account-uuid" };',
    '  const u = { session: { pct: 100, resetsAt: null }, week: { pct: 10, resetsAt: null }, windows: G.normalizeWindows({ limits: [{ kind: "session", group: "session", percent: 100, resets_at: null }] }), credits: { present: false }, credentialFp: null };',
    '  await G.tick({ fetchUsage: async () => u, readIdentity: () => ident, readCredentialFp: () => null, readCredentialGeneration: () => "G0" });',
    '  const st = JSON.parse(fs.readFileSync(process.env.FORGE_USAGE_GUARD_STATE, "utf8"));',
    '  process.stdout.write(JSON.stringify({ st }));',
    '})().catch((e) => { process.stdout.write(JSON.stringify({ uncaught: String((e && e.message) || e) })); process.exitCode = 1; });',
  ]);
  assert.ok(out.st, 'state file must have been written: ' + JSON.stringify(out));
  assert.strictEqual(out.st.mode, 'ok', 'a genuinely granted override must still suppress pausing at 100% usage (mode must stay ok, never paused): ' + JSON.stringify(out.st));
  assert.strictEqual(out.st.ownerOverride && out.st.ownerOverride.active, true, 'the cache must still show the override active: ' + JSON.stringify(out.st));
});

test('V15 (FOURTH recheck): a resurrected/stale ownerOverride cache with NO matching authoritative grant does NOT suppress pausing — the next 100% tick still PAUSES and rewrites the cache to match reality', () => {
  const out = runV15OverrideProbe([
    "'use strict';",
    ...V15_PROBE_FETCH_MOCK,
    'const fs = require("fs");',
    'const G = require(' + JSON.stringify(path.join(__dirname, 'usage-guard.cjs')) + ');',
    // NO grant is ever written anywhere — TRUSTED_OWNERGRANT_ROOT stays at its real default, which this
    // scratch sandbox (fresh FORGE_PROJECT_ROOT/HOME, unrelated to the real trusted root) never populates —
    // mirrors "grant absent" (a stale writer resurrected the CACHE's active:true, but never actually re-granted).
    'fs.writeFileSync(process.env.FORGE_USAGE_GUARD_STATE, JSON.stringify({ mode: "ok", ownerOverride: { active: true, at: new Date().toISOString(), reason: "stale resurrection" } }));',
    '(async () => {',
    '  const ident = { fp: null, source: "unknown" };',
    '  const u = { session: { pct: 100, resetsAt: null }, week: { pct: 10, resetsAt: null }, windows: G.normalizeWindows({ limits: [{ kind: "session", group: "session", percent: 100, resets_at: null }] }), credits: { present: false }, credentialFp: null };',
    '  await G.tick({ fetchUsage: async () => u, readIdentity: () => ident, readCredentialFp: () => null });',
    '  const st = JSON.parse(fs.readFileSync(process.env.FORGE_USAGE_GUARD_STATE, "utf8"));',
    '  process.stdout.write(JSON.stringify({ st }));',
    '})().catch((e) => { process.stdout.write(JSON.stringify({ uncaught: String((e && e.message) || e) })); process.exitCode = 1; });',
  ]);
  assert.ok(out.st, 'state file must have been written: ' + JSON.stringify(out));
  assert.strictEqual(out.st.mode, 'paused', 'a cached override with no backing grant must NOT suppress a real 100% pause: ' + JSON.stringify(out.st));
  assert.strictEqual(out.st.ownerOverride, undefined, 'the phantom cache entry must be reconciled away, not left to keep lying next tick: ' + JSON.stringify(out.st));
});

test('V15 (FOURTH recheck, mirror case): a valid, unexpired grant keeps the override ACTIVE even though the cache was cleared/absent — the grant decides, never the cache', () => {
  const out = runV15OverrideProbe([
    "'use strict';",
    ...V15_PROBE_FETCH_MOCK,
    'const fs = require("fs"); const path = require("path");',
    'const G = require(' + JSON.stringify(path.join(__dirname, 'usage-guard.cjs')) + ');',
    'const grantRoot = fs.mkdtempSync(path.join(require("os").tmpdir(), "guard-v15-grant-nocache-scratch-"));',
    'G.__setOwnerGrantRootForTests(grantRoot);',
    // N10/N12 (2026-09-24): bound to a matching account label, with a real future `until`.
    'const until = new Date(Date.now()+3600000).toISOString();',
    // wave 8: matching credentialGeneration stamp on both sides — see the identical note on the test above.
    'require(' + JSON.stringify(path.join(__dirname, 'forge-ownergrant.cjs')) + ').writeOverrideGrant({ active: true, at: new Date().toISOString(), until, reason: "granted, cache lost", accountLabel: "v15-nocache-account", credentialGeneration: "G0" }, { projectRoot: grantRoot });',
    // the CACHE shows nothing at all (as if a stale writer, or a crash, wiped it) — the grant alone must decide.
    'fs.writeFileSync(process.env.FORGE_USAGE_GUARD_STATE, JSON.stringify({ mode: "ok" }));',
    '(async () => {',
    '  const ident = { fp: "v15-nocache-account", source: "account-uuid" };',
    '  const u = { session: { pct: 100, resetsAt: null }, week: { pct: 10, resetsAt: null }, windows: G.normalizeWindows({ limits: [{ kind: "session", group: "session", percent: 100, resets_at: null }] }), credits: { present: false }, credentialFp: null };',
    '  await G.tick({ fetchUsage: async () => u, readIdentity: () => ident, readCredentialFp: () => null, readCredentialGeneration: () => "G0" });',
    '  const st = JSON.parse(fs.readFileSync(process.env.FORGE_USAGE_GUARD_STATE, "utf8"));',
    '  process.stdout.write(JSON.stringify({ st }));',
    '})().catch((e) => { process.stdout.write(JSON.stringify({ uncaught: String((e && e.message) || e) })); process.exitCode = 1; });',
  ]);
  assert.ok(out.st, 'state file must have been written: ' + JSON.stringify(out));
  assert.strictEqual(out.st.mode, 'ok', 'the authoritative grant must suppress pausing even with an empty cache: ' + JSON.stringify(out.st));
  assert.strictEqual(out.st.ownerOverride && out.st.ownerOverride.active, true, 'the cache must be REBUILT from the grant, not left absent: ' + JSON.stringify(out.st));
});

// ---- N10 (2026-09-24, Security Boss addendum reconfirmed) — ACCOUNT BINDING REGRESSION, proven through
// tick() with a REAL grant written in the SAME shape runOverrideOn() uses (active/at/until/reason/
// accountLabel — never just seeding state.json's cache, which the earlier N01 test above already covers and
// which never reaches the grant path at all). ----
test('N10: an authoritative grant bound to account A must NOT suppress pausing after a switch to account B at 100% usage — no inherited override, a real pause', () => {
  const out = runV15OverrideProbe([
    "'use strict';",
    ...V15_PROBE_FETCH_MOCK,
    'const fs = require("fs"); const path = require("path");',
    'const G = require(' + JSON.stringify(path.join(__dirname, 'usage-guard.cjs')) + ');',
    'const Grant = require(' + JSON.stringify(path.join(__dirname, 'forge-ownergrant.cjs')) + ');',
    'const grantRoot = fs.mkdtempSync(path.join(require("os").tmpdir(), "guard-n10-scratch-"));',
    'G.__setOwnerGrantRootForTests(grantRoot);',
    '(async () => {',
    '  const identA = { fp: "n10-account-a", source: "account-uuid" };',
    '  const uLow = { session: { pct: 20, resetsAt: null }, week: { pct: 10, resetsAt: null }, windows: G.normalizeWindows({ limits: [{ kind: "session", group: "session", percent: 20, resets_at: null }] }), credits: { present: false }, credentialFp: null };',
    '  await G.tick({ fetchUsage: async () => uLow, readIdentity: () => identA, readCredentialFp: () => null });', // stamps account A into state
    // the SAME shape runOverrideOn() writes: active, at, until, reason, accountLabel.
    '  Grant.writeOverrideGrant({ active: true, at: new Date().toISOString(), until: new Date(Date.now()+3600000).toISOString(), reason: "owner bought credits for A", accountLabel: identA.fp }, { projectRoot: grantRoot });',
    '  const identB = { fp: "n10-account-b", source: "account-uuid" };',
    '  const uHigh = { session: { pct: 100, resetsAt: null }, week: { pct: 10, resetsAt: null }, windows: G.normalizeWindows({ limits: [{ kind: "session", group: "session", percent: 100, resets_at: null }] }), credits: { present: false }, credentialFp: null };',
    '  await G.tick({ fetchUsage: async () => uHigh, readIdentity: () => identB, readCredentialFp: () => null });',
    '  const st = JSON.parse(fs.readFileSync(process.env.FORGE_USAGE_GUARD_STATE, "utf8"));',
    '  process.stdout.write(JSON.stringify({ st }));',
    '})().catch((e) => { process.stdout.write(JSON.stringify({ uncaught: String((e && e.message) || e) })); process.exitCode = 1; });',
  ]);
  assert.ok(out.st, 'state file must have been written: ' + JSON.stringify(out));
  assert.strictEqual(out.st.mode, 'paused', 'account B at 100% must actually pause — the authoritative grant belongs to account A only: ' + JSON.stringify(out.st));
  assert.strictEqual(out.st.ownerOverride, undefined, 'account B must never inherit account A\'s override: ' + JSON.stringify(out.st));
});

test('N10: an otherwise-valid grant is refused when the current identity is UNKNOWN, and when the grant carries no state at all (absent) — both fail-safe to a real pause', () => {
  const out = runV15OverrideProbe([
    "'use strict';",
    ...V15_PROBE_FETCH_MOCK,
    'const fs = require("fs"); const path = require("path");',
    'const G = require(' + JSON.stringify(path.join(__dirname, 'usage-guard.cjs')) + ');',
    'const Grant = require(' + JSON.stringify(path.join(__dirname, 'forge-ownergrant.cjs')) + ');',
    'const grantRoot = fs.mkdtempSync(path.join(require("os").tmpdir(), "guard-n10-unknown-scratch-"));',
    'G.__setOwnerGrantRootForTests(grantRoot);',
    // a real, otherwise-valid grant bound to a KNOWN account exists...
    'Grant.writeOverrideGrant({ active: true, at: new Date().toISOString(), until: new Date(Date.now()+3600000).toISOString(), reason: "granted for a known account", accountLabel: "n10-known-account" }, { projectRoot: grantRoot });',
    '(async () => {',
    // ...but THIS tick's identity is unknown (fp: null) — must refuse, never inherit.
    '  const identUnknown = { fp: null, source: "unknown" };',
    '  const uHigh = { session: { pct: 100, resetsAt: null }, week: { pct: 10, resetsAt: null }, windows: G.normalizeWindows({ limits: [{ kind: "session", group: "session", percent: 100, resets_at: null }] }), credits: { present: false }, credentialFp: null };',
    '  await G.tick({ fetchUsage: async () => uHigh, readIdentity: () => identUnknown, readCredentialFp: () => null });',
    '  const st = JSON.parse(fs.readFileSync(process.env.FORGE_USAGE_GUARD_STATE, "utf8"));',
    '  process.stdout.write(JSON.stringify({ st }));',
    '})().catch((e) => { process.stdout.write(JSON.stringify({ uncaught: String((e && e.message) || e) })); process.exitCode = 1; });',
  ]);
  assert.ok(out.st, 'state file must have been written: ' + JSON.stringify(out));
  assert.strictEqual(out.st.mode, 'paused', 'an unknown/unverifiable current identity must never be able to consume someone else\'s grant: ' + JSON.stringify(out.st));
});

// ---- N10 residual / WAVE 8 (2026-09-24, Codex p12 wave 7 finding N10; Codex p13 out-p13 finding N10),
// proven END-TO-END through tick(). Codex's `N10_stale_profile_low_then_high` measured that the wave-7
// "same generation observed twice = confirmed" rule promoted a stale profile's mismatch to "confirmed"
// without any independent evidence (zero pauses from tick two on). The FINAL policy (see
// usage-guard-override.cjs's own header): honoured again ONLY via (a) an in-process memory proof that the
// same bearer credential fingerprint was present when this account was last confirmed, or (b) a fresh
// override-on. ----
test('N10 wave-8 (end-to-end via tick()): REPEATING the identical mismatched generation on a second tick — Codex\'s exact measured defect — still does NOT re-honour the grant; the agent stays paused on every tick until the owner acts', () => {
  const out = runV15OverrideProbe([
    "'use strict';",
    ...V15_PROBE_FETCH_MOCK,
    'const fs = require("fs"); const path = require("path");',
    'const G = require(' + JSON.stringify(path.join(__dirname, 'usage-guard.cjs')) + ');',
    'const Grant = require(' + JSON.stringify(path.join(__dirname, 'forge-ownergrant.cjs')) + ');',
    'const grantRoot = fs.mkdtempSync(path.join(require("os").tmpdir(), "guard-n10gen-scratch-"));',
    'G.__setOwnerGrantRootForTests(grantRoot);',
    // granted under generation G0 — a real future expiry, bound to the one account this whole scenario uses.
    'Grant.writeOverrideGrant({ active: true, at: new Date().toISOString(), until: new Date(Date.now()+3600000).toISOString(), reason: "granted under G0", accountLabel: "n10gen-account", credentialGeneration: "G0" }, { projectRoot: grantRoot });',
    'const ident = { fp: "n10gen-account", source: "account-uuid" };', // the SAME identity every single tick — a permanently stale profile
    'const uHigh = { session: { pct: 100, resetsAt: null }, week: { pct: 10, resetsAt: null }, windows: G.normalizeWindows({ limits: [{ kind: "session", group: "session", percent: 100, resets_at: null }] }), credits: { present: false }, credentialFp: null };',
    '(async () => {',
    // tick 1: the credential FILE has already rotated to generation G1 (the profile has not caught up), and
    // this is the FIRST tick this process has ever seen for this account — no memory proof exists yet.
    '  await G.tick({ fetchUsage: async () => uHigh, readIdentity: () => ident, readCredentialFp: () => "fp-repeat", readCredentialGeneration: () => "G1" });',
    '  const stAfterTick1 = JSON.parse(fs.readFileSync(process.env.FORGE_USAGE_GUARD_STATE, "utf8"));',
    // tick 2: the SAME generation G1, and the SAME credentialFp, observed AGAIN — repetition alone must not
    // promote anything (there was never a PRIOR confirmed baseline to prove it against).
    '  await G.tick({ fetchUsage: async () => uHigh, readIdentity: () => ident, readCredentialFp: () => "fp-repeat", readCredentialGeneration: () => "G1" });',
    '  const stAfterTick2 = JSON.parse(fs.readFileSync(process.env.FORGE_USAGE_GUARD_STATE, "utf8"));',
    '  process.stdout.write(JSON.stringify({ stAfterTick1, stAfterTick2 }));',
    '})().catch((e) => { process.stdout.write(JSON.stringify({ uncaught: String((e && e.message) || e) })); process.exitCode = 1; });',
  ]);
  assert.ok(!out.uncaught, JSON.stringify(out));
  assert.strictEqual(out.stAfterTick1.mode, 'paused', 'a credential that rotated since the grant was issued, while the profile stayed stale, must NOT silently suppress a real pause forever (the measured defect was ZERO pauses): ' + JSON.stringify(out.stAfterTick1));
  assert.strictEqual(out.stAfterTick2.mode, 'paused', 'observing the identical (still-mismatched) generation a second time is NOT evidence of anything by itself — this is the exact vulnerability Codex measured: ' + JSON.stringify(out.stAfterTick2));
  assert.ok(!JSON.stringify(out).includes('fp-repeat'), 'the bearer-derived fingerprint must never reach the state file: ' + JSON.stringify(out));
});
test('N10 wave-8 (end-to-end via tick()): an ORDINARY access-token refresh (credentials file rewritten, SAME credentialFp) is honoured on the very tick it is observed — no pause at all — once this account has already been confirmed once by this watcher process', () => {
  const out = runV15OverrideProbe([
    "'use strict';",
    ...V15_PROBE_FETCH_MOCK,
    'const fs = require("fs"); const path = require("path");',
    'const G = require(' + JSON.stringify(path.join(__dirname, 'usage-guard.cjs')) + ');',
    'const Grant = require(' + JSON.stringify(path.join(__dirname, 'forge-ownergrant.cjs')) + ');',
    'const grantRoot = fs.mkdtempSync(path.join(require("os").tmpdir(), "guard-n10-refresh-scratch-"));',
    'G.__setOwnerGrantRootForTests(grantRoot);',
    // wave 9 (N10 residual, out-p14): the memory-proof baseline is now bound to the grant's own issuanceId —
    // this is the SAME grant record (one write, never replaced) across both ticks, so the issuance is
    // unchanged; this test is about the ordinary-refresh case, not a replacement.
    'Grant.writeOverrideGrant({ active: true, at: new Date().toISOString(), until: new Date(Date.now()+3600000).toISOString(), reason: "granted under G0", accountLabel: "n10-refresh-account", credentialGeneration: "G0", issuanceId: "iss-refresh-e2e" }, { projectRoot: grantRoot });',
    'const ident = { fp: "n10-refresh-account", source: "account-uuid" };',
    'const uHigh = { session: { pct: 100, resetsAt: null }, week: { pct: 10, resetsAt: null }, windows: G.normalizeWindows({ limits: [{ kind: "session", group: "session", percent: 100, resets_at: null }] }), credits: { present: false }, credentialFp: null };',
    '(async () => {',
    // tick 1: trivial match (G0 == grant's own stamp) — establishes the in-memory baseline for this account.
    '  await G.tick({ fetchUsage: async () => uHigh, readIdentity: () => ident, readCredentialFp: () => "fp-stable", readCredentialGeneration: () => "G0" });',
    '  const stAfterTick1 = JSON.parse(fs.readFileSync(process.env.FORGE_USAGE_GUARD_STATE, "utf8"));',
    // tick 2: the FILE changed (G0 -> G1, an ordinary refresh rewriting mtime/size) but the refresh token
    // itself — and therefore its fingerprint — is UNCHANGED. Must be honoured immediately, no pause.
    '  await G.tick({ fetchUsage: async () => uHigh, readIdentity: () => ident, readCredentialFp: () => "fp-stable", readCredentialGeneration: () => "G1" });',
    '  const stAfterTick2 = JSON.parse(fs.readFileSync(process.env.FORGE_USAGE_GUARD_STATE, "utf8"));',
    '  process.stdout.write(JSON.stringify({ stAfterTick1, stAfterTick2 }));',
    '})().catch((e) => { process.stdout.write(JSON.stringify({ uncaught: String((e && e.message) || e) })); process.exitCode = 1; });',
  ]);
  assert.ok(!out.uncaught, JSON.stringify(out));
  assert.strictEqual(out.stAfterTick1.mode, 'ok', JSON.stringify(out.stAfterTick1));
  assert.strictEqual(out.stAfterTick2.mode, 'ok', 'an ordinary refresh that keeps the same bearer credential must never cause even a brief pause: ' + JSON.stringify(out.stAfterTick2));
  assert.strictEqual(out.stAfterTick2.ownerOverride && out.stAfterTick2.ownerOverride.active, true, JSON.stringify(out.stAfterTick2));
  assert.ok(!JSON.stringify(out).includes('fp-stable'), 'the bearer-derived fingerprint must never reach the state file: ' + JSON.stringify(out));
});
test('N10 wave-8 (end-to-end via tick()): a credential ROTATION (a DIFFERENT credentialFp than the last confirmed one) is NOT honoured — a real pause fires and it stays paused until the owner reruns override-on', () => {
  const out = runV15OverrideProbe([
    "'use strict';",
    ...V15_PROBE_FETCH_MOCK,
    'const fs = require("fs"); const path = require("path");',
    'const G = require(' + JSON.stringify(path.join(__dirname, 'usage-guard.cjs')) + ');',
    'const Grant = require(' + JSON.stringify(path.join(__dirname, 'forge-ownergrant.cjs')) + ');',
    'const grantRoot = fs.mkdtempSync(path.join(require("os").tmpdir(), "guard-n10-rotate-scratch-"));',
    'G.__setOwnerGrantRootForTests(grantRoot);',
    'Grant.writeOverrideGrant({ active: true, at: new Date().toISOString(), until: new Date(Date.now()+3600000).toISOString(), reason: "granted under G0", accountLabel: "n10-rotate-account", credentialGeneration: "G0" }, { projectRoot: grantRoot });',
    'const ident = { fp: "n10-rotate-account", source: "account-uuid" };',
    'const uHigh = { session: { pct: 100, resetsAt: null }, week: { pct: 10, resetsAt: null }, windows: G.normalizeWindows({ limits: [{ kind: "session", group: "session", percent: 100, resets_at: null }] }), credits: { present: false }, credentialFp: null };',
    '(async () => {',
    '  await G.tick({ fetchUsage: async () => uHigh, readIdentity: () => ident, readCredentialFp: () => "fp-old", readCredentialGeneration: () => "G0" });',
    '  const stAfterTick1 = JSON.parse(fs.readFileSync(process.env.FORGE_USAGE_GUARD_STATE, "utf8"));',
    '  await G.tick({ fetchUsage: async () => uHigh, readIdentity: () => ident, readCredentialFp: () => "fp-new", readCredentialGeneration: () => "G1" });',
    '  const stAfterTick2 = JSON.parse(fs.readFileSync(process.env.FORGE_USAGE_GUARD_STATE, "utf8"));',
    '  process.stdout.write(JSON.stringify({ stAfterTick1, stAfterTick2 }));',
    '})().catch((e) => { process.stdout.write(JSON.stringify({ uncaught: String((e && e.message) || e) })); process.exitCode = 1; });',
  ]);
  assert.ok(!out.uncaught, JSON.stringify(out));
  assert.strictEqual(out.stAfterTick1.mode, 'ok', JSON.stringify(out.stAfterTick1));
  assert.strictEqual(out.stAfterTick2.mode, 'paused', 'a genuinely different bearer credential must never be assumed to be the same one: ' + JSON.stringify(out.stAfterTick2));
  assert.ok(!JSON.stringify(out).includes('fp-old') && !JSON.stringify(out).includes('fp-new'), 'neither fingerprint may ever reach the state file: ' + JSON.stringify(out));
});
test('N10 wave-8: a watcher RESTART (a brand-new OS process) loses the in-memory proof — even the identical credentialFp cannot be honoured, because only the process that actually observed it can vouch for it; override-on must be rerun', () => {
  const grantRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-n10-restart-grant-'));
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-n10-restart-state-')), 'state.json');
  require('./forge-ownergrant.cjs').writeOverrideGrant({ active: true, at: new Date().toISOString(), until: new Date(Date.now() + 3600000).toISOString(), reason: 'granted under G0', accountLabel: 'n10-restart-account', credentialGeneration: 'G0' }, { projectRoot: grantRoot });
  const extraEnv = { FORGE_USAGE_GUARD_STATE: stateFile };
  const script = (gen, fp) => [
    "'use strict';",
    ...V15_PROBE_FETCH_MOCK,
    'const fs = require("fs");',
    'const G = require(' + JSON.stringify(path.join(__dirname, 'usage-guard.cjs')) + ');',
    'G.__setOwnerGrantRootForTests(' + JSON.stringify(grantRoot) + ');',
    'const ident = { fp: "n10-restart-account", source: "account-uuid" };',
    'const uHigh = { session: { pct: 100, resetsAt: null }, week: { pct: 10, resetsAt: null }, windows: G.normalizeWindows({ limits: [{ kind: "session", group: "session", percent: 100, resets_at: null }] }), credits: { present: false }, credentialFp: null };',
    '(async () => {',
    '  await G.tick({ fetchUsage: async () => uHigh, readIdentity: () => ident, readCredentialFp: () => ' + JSON.stringify(fp) + ', readCredentialGeneration: () => ' + JSON.stringify(gen) + ' });',
    '  const st = JSON.parse(fs.readFileSync(process.env.FORGE_USAGE_GUARD_STATE, "utf8"));',
    '  process.stdout.write(JSON.stringify({ st }));',
    '})().catch((e) => { process.stdout.write(JSON.stringify({ uncaught: String((e && e.message) || e) })); process.exitCode = 1; });',
  ];
  // "watcher run 1": trivial match (G0 == grant's own stamp) — establishes ITS OWN in-memory baseline.
  const outA = runV15OverrideProbe(script('G0', 'fp-orig'), extraEnv);
  assert.ok(!outA.uncaught, JSON.stringify(outA));
  assert.strictEqual(outA.st.mode, 'ok', JSON.stringify(outA));
  // "watcher run 2" (a brand-new, separate OS process — every runV15OverrideProbe call already is one): the
  // generation has drifted to G1, and the credentialFp is IDENTICAL to run 1's — but this process never
  // observed that itself, so it has nothing to prove it with.
  const outB = runV15OverrideProbe(script('G1', 'fp-orig'), extraEnv);
  assert.ok(!outB.uncaught, JSON.stringify(outB));
  assert.strictEqual(outB.st.mode, 'paused', 'a fresh process must never inherit a PRIOR process\'s in-memory confirmation: ' + JSON.stringify(outB));
});
test('N10 wave-8 (end-to-end via tick()): a LEGACY grant with no credentialGeneration stamp at all is NOT honoured — a real pause fires even though the account label matches exactly; a one-time override-on re-arms it', () => {
  const out = runV15OverrideProbe([
    "'use strict';",
    ...V15_PROBE_FETCH_MOCK,
    'const fs = require("fs"); const path = require("path");',
    'const G = require(' + JSON.stringify(path.join(__dirname, 'usage-guard.cjs')) + ');',
    'const Grant = require(' + JSON.stringify(path.join(__dirname, 'forge-ownergrant.cjs')) + ');',
    'const grantRoot = fs.mkdtempSync(path.join(require("os").tmpdir(), "guard-n10-legacy-scratch-"));',
    'G.__setOwnerGrantRootForTests(grantRoot);',
    'Grant.writeOverrideGrant({ active: true, at: new Date().toISOString(), until: new Date(Date.now()+3600000).toISOString(), reason: "legacy, no stamp", accountLabel: "n10-legacy-account" }, { projectRoot: grantRoot });',
    'const ident = { fp: "n10-legacy-account", source: "account-uuid" };',
    'const uHigh = { session: { pct: 100, resetsAt: null }, week: { pct: 10, resetsAt: null }, windows: G.normalizeWindows({ limits: [{ kind: "session", group: "session", percent: 100, resets_at: null }] }), credits: { present: false }, credentialFp: null };',
    '(async () => {',
    '  await G.tick({ fetchUsage: async () => uHigh, readIdentity: () => ident, readCredentialFp: () => "fp-legacy", readCredentialGeneration: () => "G1" });',
    '  const st = JSON.parse(fs.readFileSync(process.env.FORGE_USAGE_GUARD_STATE, "utf8"));',
    '  process.stdout.write(JSON.stringify({ st }));',
    '})().catch((e) => { process.stdout.write(JSON.stringify({ uncaught: String((e && e.message) || e) })); process.exitCode = 1; });',
  ]);
  assert.ok(!out.uncaught, JSON.stringify(out));
  assert.strictEqual(out.st.mode, 'paused', 'a grant written before the credentialGeneration field existed must never be silently treated as verified: ' + JSON.stringify(out.st));
});
test('N10 wave-8 (end-to-end via tick()): the CURRENT credential file being unreadable (readCredentialGeneration returns null) is NOT honoured — a real pause fires even though the grant carries a valid stamp', () => {
  const out = runV15OverrideProbe([
    "'use strict';",
    ...V15_PROBE_FETCH_MOCK,
    'const fs = require("fs"); const path = require("path");',
    'const G = require(' + JSON.stringify(path.join(__dirname, 'usage-guard.cjs')) + ');',
    'const Grant = require(' + JSON.stringify(path.join(__dirname, 'forge-ownergrant.cjs')) + ');',
    'const grantRoot = fs.mkdtempSync(path.join(require("os").tmpdir(), "guard-n10-unreadable-scratch-"));',
    'G.__setOwnerGrantRootForTests(grantRoot);',
    'Grant.writeOverrideGrant({ active: true, at: new Date().toISOString(), until: new Date(Date.now()+3600000).toISOString(), reason: "granted under G0", accountLabel: "n10-unreadable-account", credentialGeneration: "G0" }, { projectRoot: grantRoot });',
    'const ident = { fp: "n10-unreadable-account", source: "account-uuid" };',
    'const uHigh = { session: { pct: 100, resetsAt: null }, week: { pct: 10, resetsAt: null }, windows: G.normalizeWindows({ limits: [{ kind: "session", group: "session", percent: 100, resets_at: null }] }), credits: { present: false }, credentialFp: null };',
    '(async () => {',
    '  await G.tick({ fetchUsage: async () => uHigh, readIdentity: () => ident, readCredentialFp: () => null, readCredentialGeneration: () => null });',
    '  const st = JSON.parse(fs.readFileSync(process.env.FORGE_USAGE_GUARD_STATE, "utf8"));',
    '  process.stdout.write(JSON.stringify({ st }));',
    '})().catch((e) => { process.stdout.write(JSON.stringify({ uncaught: String((e && e.message) || e) })); process.exitCode = 1; });',
  ]);
  assert.ok(!out.uncaught, JSON.stringify(out));
  assert.strictEqual(out.st.mode, 'paused', 'an unverifiable current credential must never default to "assume it still matches": ' + JSON.stringify(out.st));
});

// ---- N10 WAVE 10 (2026-09-24, Codex out-p15 finding N10, "snapshot race") — readCredentialFp() and
// credentialGeneration() used to be read SEPARATELY inside tick(), at two different moments; a credential
// rotation landing in between could pair a STALE fingerprint with a FRESH generation. readCredentialSnapshot()
// now reads both from ONE atomic pass (single fd: fstat, then read, then close) and tick() calls it exactly
// once per tick, reusing the same pair for the mid-check rotation gate and the owner-override resolver call.
// ----
test('N10 wave 10: readCredentialSnapshot() derives generation and credentialFp from ONE consistent read, matching an independent fstat+hash of the same fixture', () => {
  const credFile = path.join(ISOLATED_CLAUDE_HOME, '.credentials.json');
  const refreshToken = 'unit-test-refresh-token-n10w10';
  fs.writeFileSync(credFile, JSON.stringify({ claudeAiOauth: { accessToken: 'unit-test-access', refreshToken } }));
  try {
    const snap = G.readCredentialSnapshot();
    const st = fs.statSync(credFile);
    assert.strictEqual(snap.generation, String(st.mtimeMs) + ':' + String(st.size), JSON.stringify(snap));
    const expectedFp = require('crypto').createHash('sha256').update('rt:' + refreshToken).digest('hex').slice(0, 12);
    assert.strictEqual(snap.credentialFp, expectedFp, JSON.stringify(snap));
    assert.ok(!JSON.stringify(snap).includes(refreshToken), 'the raw refresh token must never appear in the snapshot: ' + JSON.stringify(snap));
  } finally { try { fs.unlinkSync(credFile); } catch { /* best effort */ } }
});
test('N10 wave 10: readCredentialSnapshot() is null-safe when the credentials file is absent', () => {
  const credFile = path.join(ISOLATED_CLAUDE_HOME, '.credentials.json');
  try { fs.unlinkSync(credFile); } catch { /* already absent */ }
  const snap = G.readCredentialSnapshot();
  assert.deepStrictEqual(snap, { generation: null, credentialFp: null });
});
// ---- SB-L5 (2026-09-24, Security Boss wave 11, sec-w11) — this project does NOT write .credentials.json;
// Claude Code does, and this file has no control over (or visibility into) whether that write is an atomic
// rename-based replace or an IN-PLACE rewrite of the same inode. An in-place rewrite landing DURING the
// single read this function performs can tear the content relative to the fstat taken just before it.
// readCredentialSnapshot() now re-fstats the SAME fd immediately after the read and refuses the whole
// snapshot (both fields null) when the two disagree, rather than pairing possibly-torn content with a stamp
// that no longer describes it. ----
test('SB-L5: readCredentialSnapshot() refuses the whole snapshot when the credentials file is rewritten IN PLACE during the read itself (fstat before/after the read disagree)', () => {
  const credFile = path.join(ISOLATED_CLAUDE_HOME, '.credentials.json');
  fs.writeFileSync(credFile, JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'rt-before-rewrite' } }));
  const origReadFileSync = fs.readFileSync;
  let rewrote = false;
  fs.readFileSync = function guardTornReadProbe(p, opts) {
    const result = origReadFileSync(p, opts);
    if (typeof p === 'number' && !rewrote) {
      rewrote = true;
      // simulate an IN-PLACE rewrite (truncate+write to the SAME path/inode) landing DURING this read — a
      // DIFFERENT size guarantees the post-read fstat disagrees with the pre-read one, regardless of mtime
      // clock resolution.
      fs.writeFileSync(credFile, JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'rt-after-in-place-rewrite-longer-value' } }));
    }
    return result;
  };
  try {
    const snap = G.readCredentialSnapshot();
    assert.ok(rewrote, 'sanity: the simulated in-place rewrite must actually have run during the read');
    assert.deepStrictEqual(snap, { generation: null, credentialFp: null }, 'a torn read (the file moved during our own read) must refuse the whole snapshot rather than pair possibly-stale content with a now-wrong generation stamp: ' + JSON.stringify(snap));
  } finally {
    fs.readFileSync = origReadFileSync;
    try { fs.unlinkSync(credFile); } catch { /* best effort */ }
  }
});
test('N10 wave 10 (end-to-end via tick(), through the real runOverrideOn-equivalent grant writes, tick() and the real resolver): Codex\'s exact interleaving — a legitimate replacement grant (new issuanceId + generation) lands between two credential reads, then the OLD credential returns under yet a THIRD generation — must fire a real pause on the unconfirmed tick, never inherit the replacement grant\'s proof under a stale fingerprint (N10_mixed_snapshot_real_override_on_new_uuid)', () => {
  const out = runV15OverrideProbe([
    "'use strict';",
    ...n17FetchMock(),
    'const fs = require("fs"); const path = require("path");',
    'const G = require(' + JSON.stringify(path.join(__dirname, 'usage-guard.cjs')) + ');',
    'const Grant = require(' + JSON.stringify(path.join(__dirname, 'forge-ownergrant.cjs')) + ');',
    'const grantRoot = fs.mkdtempSync(path.join(require("os").tmpdir(), "guard-n10w10-scratch-"));',
    'G.__setOwnerGrantRootForTests(grantRoot);',
    'const ident = { fp: "n10w10-account", source: "account-uuid" };',
    'const uHigh = { session: { pct: 100, resetsAt: null }, week: { pct: 10, resetsAt: null }, windows: G.normalizeWindows({ limits: [{ kind: "session", group: "session", percent: 100, resets_at: null }] }), credits: { present: false }, credentialFp: null };',
    '(async () => {',
    '  const until = new Date(Date.now()+3600000).toISOString();',
    // tick 1: the ORIGINAL grant (ISS-A/GA), credential genuinely at GA with fp FP-A — a real atomic read
    // can only ever report the self-consistent pair for this moment.
    '  Grant.writeOverrideGrant({ active: true, at: new Date().toISOString(), until, reason: "original grant", accountLabel: "n10w10-account", credentialGeneration: "GA", issuanceId: "ISS-A" }, { projectRoot: grantRoot });',
    '  await G.tick({ fetchUsage: async () => uHigh, readIdentity: () => ident, readCredentialSnapshot: () => ({ credentialFp: "FP-A", generation: "GA" }) });',
    '  const stAfterTick1 = JSON.parse(fs.readFileSync(process.env.FORGE_USAGE_GUARD_STATE, "utf8"));',
    // a LEGITIMATE replacement grant lands (owner reran override-on after rotating credentials): new
    // issuanceId ISS-B, stamped to the NEW generation GB. tick 2's real atomic snapshot at THIS moment can
    // only be the self-consistent {GB, FP-B} pair — never a torn mix of the old fp with the new generation
    // (that torn pairing is exactly what the pre-wave-10 two-separate-reads code could produce; see this
    // file\'s wp-q2 report for the RED proof against the pre-fix baseline).
    '  Grant.writeOverrideGrant({ active: true, at: new Date().toISOString(), until, reason: "replacement grant", accountLabel: "n10w10-account", credentialGeneration: "GB", issuanceId: "ISS-B" }, { projectRoot: grantRoot });',
    '  await G.tick({ fetchUsage: async () => uHigh, readIdentity: () => ident, readCredentialSnapshot: () => ({ credentialFp: "FP-B", generation: "GB" }) });',
    '  const stAfterTick2 = JSON.parse(fs.readFileSync(process.env.FORGE_USAGE_GUARD_STATE, "utf8"));',
    // the OLD credential (FP-A) returns under a THIRD generation GC — no new grant issued. A correctly
    // seeded proof (bound to FP-B, tick 2\'s real fingerprint) must NOT match FP-A — the grant\'s own
    // generation (GB) no longer matches (GC) either, so this must fail closed to a REAL pause.
    '  await G.tick({ fetchUsage: async () => uHigh, readIdentity: () => ident, readCredentialSnapshot: () => ({ credentialFp: "FP-A", generation: "GC" }) });',
    '  const stAfterTick3 = JSON.parse(fs.readFileSync(process.env.FORGE_USAGE_GUARD_STATE, "utf8"));',
    '  process.stdout.write(JSON.stringify({ stAfterTick1, stAfterTick2, stAfterTick3, pauseCalls, resumeCalls }));',
    '})().catch((e) => { process.stdout.write(JSON.stringify({ uncaught: String((e && e.message) || e) })); process.exitCode = 1; });',
  ]);
  assert.ok(!out.uncaught, JSON.stringify(out));
  assert.strictEqual(out.stAfterTick1.mode, 'ok', 'the original grant is genuinely valid — no pause yet: ' + JSON.stringify(out.stAfterTick1));
  assert.strictEqual(out.stAfterTick2.mode, 'ok', 'the replacement grant is ALSO genuinely valid for the new credential — still no pause: ' + JSON.stringify(out.stAfterTick2));
  assert.strictEqual(out.stAfterTick3.mode, 'paused', 'the old credential returning under an unconfirmed generation must NOT inherit the replacement grant\'s proof — a real pause must fire: ' + JSON.stringify(out.stAfterTick3));
  assert.strictEqual(out.pauseCalls, 1, 'exactly one real Paperclip pause call must have fired on the unconfirmed tick — Codex measured ZERO here on the pre-fix code: ' + JSON.stringify(out));
  assert.ok(!JSON.stringify(out).includes('FP-A') && !JSON.stringify(out).includes('FP-B'), 'the bearer-derived fingerprint must never reach the state file: ' + JSON.stringify(out));
});

// ---- N17 (2026-09-24, Codex p13 out-p13 finding N17, regression on N16) — a legitimately re-honoured
// override (owner reran override-on after a real, guard-owned pause) must actually RESUME the paused
// Paperclip agent(s) through the existing resume path, not just flip state.json's `mode` back to 'ok' while
// leaving them stuck. Codex's `N16_refresh_pause_not_resumed_after_confirmation_or_usage_reset`: one pause,
// zero resumes, agent still paused, state reporting 'ok'. ----
function n17FetchMock() {
  return [
    'let pauseCalls = 0, resumeCalls = 0;',
    'global.fetch = async (url, init) => {',
    '  const u = String(url); const m = (init && init.method) || "GET";',
    '  if (/\\/api\\/companies$/.test(u)) return { ok: true, status: 200, json: async () => [{ id: "c1", name: "Co" }] };',
    '  if (/\\/api\\/companies\\/c1\\/agents$/.test(u)) return { ok: true, status: 200, json: async () => [{ id: "a1", name: "Agent1", status: "running" }] };',
    '  if (/\\/api\\/agents\\/a1\\/pause$/.test(u) && m === "POST") { pauseCalls++; return { ok: true, status: 200, json: async () => ({}) }; }',
    '  if (/\\/api\\/agents\\/a1\\/resume$/.test(u) && m === "POST") { resumeCalls++; return { ok: true, status: 200, json: async () => ({}) }; }',
    '  return { ok: true, status: 200, json: async () => ({}) };',
    '};',
  ];
}
test('N17: an override that becomes honoured again after a real guard-owned pause actually RESUMES the paused agent (through the existing resume path) instead of leaving it stuck while state reports ok', () => {
  const out = runV15OverrideProbe([
    "'use strict';",
    ...n17FetchMock(),
    'const fs = require("fs"); const path = require("path");',
    'const G = require(' + JSON.stringify(path.join(__dirname, 'usage-guard.cjs')) + ');',
    'const Grant = require(' + JSON.stringify(path.join(__dirname, 'forge-ownergrant.cjs')) + ');',
    'const grantRoot = fs.mkdtempSync(path.join(require("os").tmpdir(), "guard-n17-scratch-"));',
    'G.__setOwnerGrantRootForTests(grantRoot);',
    'Grant.writeOverrideGrant({ active: true, at: new Date().toISOString(), until: new Date(Date.now()+3600000).toISOString(), reason: "granted under G0", accountLabel: "n17-account", credentialGeneration: "G0" }, { projectRoot: grantRoot });',
    'const ident = { fp: "n17-account", source: "account-uuid" };',
    'const uHigh = { session: { pct: 100, resetsAt: null }, week: { pct: 10, resetsAt: null }, windows: G.normalizeWindows({ limits: [{ kind: "session", group: "session", percent: 100, resets_at: null }] }), credits: { present: false }, credentialFp: null };',
    '(async () => {',
    // tick 1: the credential generation has already drifted (G0 -> G1) with no prior in-memory confirmation
    // — NOT honoured, falls through, real 100% usage pauses agent a1 for real.
    '  await G.tick({ fetchUsage: async () => uHigh, readIdentity: () => ident, readCredentialFp: () => "fp-n17", readCredentialGeneration: () => "G1" });',
    '  const stAfterPause = JSON.parse(fs.readFileSync(process.env.FORGE_USAGE_GUARD_STATE, "utf8"));',
    // the owner reruns override-on (simulated directly here): re-stamp the grant to the CURRENT generation.
    '  Grant.writeOverrideGrant({ active: true, at: new Date().toISOString(), until: new Date(Date.now()+3600000).toISOString(), reason: "re-authorized", accountLabel: "n17-account", credentialGeneration: "G1" }, { projectRoot: grantRoot });',
    // tick 2: trivial match now (G1 == G1) — override is honoured again; must ALSO resume the guard-owned pause.
    '  await G.tick({ fetchUsage: async () => uHigh, readIdentity: () => ident, readCredentialFp: () => "fp-n17", readCredentialGeneration: () => "G1" });',
    '  const stAfterReconcile = JSON.parse(fs.readFileSync(process.env.FORGE_USAGE_GUARD_STATE, "utf8"));',
    '  process.stdout.write(JSON.stringify({ stAfterPause, stAfterReconcile, pauseCalls, resumeCalls }));',
    '})().catch((e) => { process.stdout.write(JSON.stringify({ uncaught: String((e && e.message) || e) })); process.exitCode = 1; });',
  ]);
  assert.ok(!out.uncaught, JSON.stringify(out));
  assert.strictEqual(out.stAfterPause.mode, 'paused', JSON.stringify(out.stAfterPause));
  assert.strictEqual(out.pauseCalls, 1, 'the real Paperclip pause API must have been called exactly once: ' + JSON.stringify(out));
  assert.strictEqual(out.stAfterReconcile.mode, 'ok', JSON.stringify(out.stAfterReconcile));
  assert.strictEqual(out.resumeCalls, 1, 'a legitimately re-honoured override must actually resume the guard-owned pause through the real API — this is exactly what Codex\'s N17 finding measured as missing (zero resumes): ' + JSON.stringify(out));
  assert.ok(!Array.isArray(out.stAfterReconcile.pausedAgents) || out.stAfterReconcile.pausedAgents.length === 0, 'the state must no longer list the agent as paused once it has genuinely been resumed: ' + JSON.stringify(out.stAfterReconcile));
  assert.ok(!JSON.stringify(out).includes('fp-n17'), 'the bearer-derived fingerprint must never reach the state file: ' + JSON.stringify(out));
});

// ---- N17 RESIDUAL, WAVE 9 (2026-09-24, Codex p14 out-p14 finding N17 — "PARTLY CLOSED": the wave-8 fix
// above only ever reconciled a stuck pause through tick()'s own override-active branch; runOverrideOn()'s
// OWN resume loop — the one the `override-on` COMMAND itself runs, synchronously, before that branch ever
// gets a chance to run — still claimed unconditional success. Codex's `N17_override_on_failed_resume_
// then_two_ticks`, through the REAL exported runOverrideOn(): a resume response that fails still left
// `mode:'ok'` and `pausedAgents:[]` on disk, and two SUBSEQUENT ticks made no retry at all (resume calls
// stayed 1 -> 1) because the tick's own override-active branch only re-resumes when it sees `mode:'paused'`
// — which runOverrideOn had already erased. THE FIX: runOverrideOn's resume loop now removes ONLY the
// agents that genuinely resumed from `pausedAgents`; anything left keeps `mode:'paused'` (never 'ok') so
// the tick's existing override-active reconciliation branch (see tick()'s own N17 comment, unchanged)
// retries it — through the SAME doResume() path — on every following tick, exactly like an ordinary
// partial-resume failure already does elsewhere in this file. This test goes through the REAL
// runOverrideOn() (never a re-implemented copy, and never writing the replacement grant directly). ----
test('N17 wave 9: runOverrideOn() with a resume that FAILS never claims success on disk — the agent stays paused, retries on every following tick (through the real doResume path), and only clears once a resume genuinely succeeds', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-n17w9-'));
  const script = path.join(dir, 'probe.cjs');
  fs.writeFileSync(script, [
    "'use strict';",
    // the resume endpoint for a1 fails the first TWO times, succeeds the third — proving both the
    // runOverrideOn-triggered attempt AND the first tick's retry genuinely happened before success.
    'let resumeCalls = 0;',
    'global.fetch = async (url, init) => {',
    '  const u = String(url); const m = (init && init.method) || "GET";',
    '  if (/\\/api\\/agents\\/a1\\/resume$/.test(u) && m === "POST") {',
    '    resumeCalls++;',
    '    if (resumeCalls < 3) return { ok: false, status: 500, json: async () => ({}) };',
    '    return { ok: true, status: 200, json: async () => ({}) };',
    '  }',
    '  return { ok: true, status: 200, json: async () => ({}) };',
    '};',
    'const fs = require("fs"); const path = require("path");',
    'process.argv = [process.execPath, "usage-guard.cjs", "override-on", "--owner-approval", "N17W9-TEST-TOKEN", "--reason", "n17 wave9 test"];',
    'const G = require(' + JSON.stringify(path.join(__dirname, 'usage-guard.cjs')) + ');',
    'const Grant = require(' + JSON.stringify(path.join(__dirname, 'forge-ownergrant.cjs')) + ');',
    'const grantRoot = fs.mkdtempSync(path.join(require("os").tmpdir(), "guard-n17w9-scratch-"));',
    'G.__setOwnerGrantRootForTests(grantRoot);',
    'fs.mkdirSync(path.join(grantRoot, ".claude", "config"), { recursive: true });',
    'fs.writeFileSync(path.join(grantRoot, ".claude", "config", "forge-owner-grant.txt"), "N17W9-TEST-TOKEN\\n");',
    // a real (fake-content) credentials file so credentialGeneration() is a stable, non-null stamp — its
    // BYTES are never read for the generation stamp (mtime+size only), so fake content is safe here.
    'fs.writeFileSync(path.join(process.env.FORGE_USAGE_GUARD_HOME, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "x", refreshToken: "y" } }));',
    'const identityFile = process.env.FORGE_USAGE_GUARD_IDENTITY;',
    'fs.writeFileSync(identityFile, JSON.stringify({ oauthAccount: { accountUuid: "n17w9-account-uuid", organizationUuid: "n17w9-org" } }));',
    'const ident = G.readAccountIdentity();',
    // pre-seed a guard-owned pause: agent a1 already paused before the owner runs override-on.
    'fs.writeFileSync(process.env.FORGE_USAGE_GUARD_STATE, JSON.stringify({ mode: "paused", account: { fp: ident.fp, source: ident.source }, pausedAgents: [{ id: "a1", name: "Agent1", company: "Co" }] }));',
    'class ExitSignal { constructor(c) { this.code = c; } }',
    'const realExit = process.exit.bind(process);',
    'process.exit = (c) => { throw new ExitSignal(c); };',
    'const logs = []; const realErr = console.error, realLog = console.log;',
    'console.error = (m) => logs.push({ level: "error", m: String(m) });',
    'console.log = (m) => logs.push({ level: "log", m: String(m) });',
    '(async () => {',
    '  let exitCode = null;',
    '  try { await G.runOverrideOn(); } catch (e) { if (e instanceof ExitSignal) exitCode = e.code; else throw e; }',
    '  const stAfterOn = JSON.parse(fs.readFileSync(process.env.FORGE_USAGE_GUARD_STATE, "utf8"));',
    '  const uHigh = { session: { pct: 100, resetsAt: null }, week: { pct: 10, resetsAt: null }, windows: G.normalizeWindows({ limits: [{ kind: "session", group: "session", percent: 100, resets_at: null }] }), credits: { present: false }, credentialFp: null };',
    '  await G.tick({ fetchUsage: async () => uHigh, readIdentity: () => ident, readCredentialFp: () => null, readCredentialGeneration: G.credentialGeneration });',
    '  const stAfterTick1 = JSON.parse(fs.readFileSync(process.env.FORGE_USAGE_GUARD_STATE, "utf8"));',
    '  await G.tick({ fetchUsage: async () => uHigh, readIdentity: () => ident, readCredentialFp: () => null, readCredentialGeneration: G.credentialGeneration });',
    '  const stAfterTick2 = JSON.parse(fs.readFileSync(process.env.FORGE_USAGE_GUARD_STATE, "utf8"));',
    '  console.error = realErr; console.log = realLog;',
    '  process.stdout.write(JSON.stringify({ exitCode, logs, stAfterOn, stAfterTick1, stAfterTick2, resumeCalls }));',
    '  realExit(0);',
    '})().catch((e) => { process.stdout.write(JSON.stringify({ uncaught: String((e && e.message) || e) })); realExit(1); });',
  ].join('\n'), 'utf8');
  const stateFile = path.join(dir, 'state.json');
  const env = Object.assign({}, process.env, {
    FORGE_USAGE_GUARD_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'guard-n17w9-home-')),
    FORGE_CONFIG_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'guard-n17w9-cfghome-')),
    FORGE_PROJECT_ROOT: fs.mkdtempSync(path.join(os.tmpdir(), 'guard-n17w9-proj-')),
    FORGE_USAGE_GUARD_STATE: stateFile,
    FORGE_USAGE_GUARD_IDENTITY: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-n17w9-identity-')), '.claude.json'),
    NVIDIA_SKIP_ENV_FILES: '1',
  });
  delete env.FORGE_USAGE_GUARD_STATE_LOCK_WAIT_MS;
  const r = require('child_process').spawnSync(process.execPath, [script], { encoding: 'utf8', env, timeout: 30000 });
  const lastLine = (r.stdout || '').trim().split('\n').pop();
  let out; try { out = JSON.parse(lastLine); } catch { out = { parseError: (r.stdout || '') + (r.stderr || '') + '\n' + lastLine }; }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  assert.ok(!out.uncaught, JSON.stringify(out));
  assert.strictEqual(out.exitCode, 0, 'the grant itself DID take effect — override-on must still exit 0 even though a resume failed: ' + JSON.stringify(out));
  // the FIRST resume attempt (inside runOverrideOn itself) must have genuinely happened and failed.
  assert.strictEqual(out.stAfterOn.mode, 'paused', 'a failed resume must NEVER be reported as mode:"ok": ' + JSON.stringify(out.stAfterOn));
  assert.ok(Array.isArray(out.stAfterOn.pausedAgents) && out.stAfterOn.pausedAgents.some((a) => a.id === 'a1'), 'the agent that failed to resume must stay in pausedAgents, never silently dropped: ' + JSON.stringify(out.stAfterOn));
  const onLine = out.logs.map((l) => l.m).join('\n');
  assert.match(onLine, /could not be resumed yet|watcher retries every tick/i, 'the printed outcome must honestly say a resume is still pending, never claim full success: ' + onLine);
  // tick 1: the override is still honoured (same account/generation) — must RETRY the resume (call #2), and
  // it fails again — must still NOT report 'ok'.
  assert.strictEqual(out.stAfterTick1.mode, 'paused', 'the first tick must retry, not silently give up or fabricate "ok": ' + JSON.stringify(out.stAfterTick1));
  assert.ok(Array.isArray(out.stAfterTick1.pausedAgents) && out.stAfterTick1.pausedAgents.some((a) => a.id === 'a1'), JSON.stringify(out.stAfterTick1));
  // tick 2: the resume mock now succeeds (call #3) — the agent must genuinely be reported resumed.
  assert.strictEqual(out.stAfterTick2.mode, 'ok', 'once the resume genuinely succeeds, the state must say so: ' + JSON.stringify(out.stAfterTick2));
  assert.ok(!Array.isArray(out.stAfterTick2.pausedAgents) || out.stAfterTick2.pausedAgents.length === 0, JSON.stringify(out.stAfterTick2));
  assert.strictEqual(out.resumeCalls, 3, 'exactly three resume attempts must have been made — one from runOverrideOn, one from each retrying tick — never zero retries: ' + JSON.stringify(out));
});

// ---- N17 WAVE 10 RESIDUAL (2026-09-24, Codex out-p15 finding N17) — the wave-8/9 fix above still wrote
// `mode:'ok'` in tick()'s own override-active transaction BEFORE doResume() ever ran. Codex's
// `N17_retry_write_lock_refused`: when the bookkeeping write INSIDE doResume()'s own reconciliation is
// refused (lock unavailable) or fenced (reclaimed mid-transaction), that earlier premature 'ok' write is the
// only one that landed — state read 'ok' with an unresolved agent, and the NEXT tick's `wasPaused` check
// (st.mode === 'paused') read the wrongly-healthy cache and never even retried (resume calls stuck at
// 1 -> 2 -> 2). THE FIX: `mode` is withheld from tick()'s own write whenever there is something to
// reconcile — doResume() alone decides 'ok' vs 'paused'+resumePending, from its OWN outcome. ----
test('N17 wave 10: a REFUSED bookkeeping write inside doResume() during override reconciliation must never leave mode stuck at "ok" with an unresolved agent — the paused marker survives, and the very next tick still retries and eventually succeeds', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-n17w10-'));
  const script = path.join(dir, 'probe.cjs');
  fs.writeFileSync(script, [
    "'use strict';",
    'let resumeCalls = 0;',
    'global.fetch = async (url, init) => {',
    '  const u = String(url); const m = (init && init.method) || "GET";',
    '  if (/\\/api\\/agents\\/a1\\/resume$/.test(u) && m === "POST") { resumeCalls++; return { ok: true, status: 200, json: async () => ({}) }; }',
    '  return { ok: true, status: 200, json: async () => ({}) };',
    '};',
    'const fs = require("fs"); const path = require("path");',
    'const G = require(' + JSON.stringify(path.join(__dirname, 'usage-guard.cjs')) + ');',
    'const Grant = require(' + JSON.stringify(path.join(__dirname, 'forge-ownergrant.cjs')) + ');',
    'const grantRoot = fs.mkdtempSync(path.join(require("os").tmpdir(), "guard-n17w10-scratch-"));',
    'G.__setOwnerGrantRootForTests(grantRoot);',
    'const ident = { fp: "n17w10-account", source: "account-uuid" };',
    'const uHigh = { session: { pct: 100, resetsAt: null }, week: { pct: 10, resetsAt: null }, windows: G.normalizeWindows({ limits: [{ kind: "session", group: "session", percent: 100, resets_at: null }] }), credits: { present: false }, credentialFp: null };',
    'const stateFile = process.env.FORGE_USAGE_GUARD_STATE;',
    'const lockPath = stateFile + ".lock";',
    'const realDoResume = G.doResume;',
    'let doResumeCalls = 0;',
    '(async () => {',
    '  const until = new Date(Date.now()+3600000).toISOString();',
    '  Grant.writeOverrideGrant({ active: true, at: new Date().toISOString(), until, reason: "granted", accountLabel: "n17w10-account", credentialGeneration: "G0", issuanceId: "ISS-N17W10" }, { projectRoot: grantRoot });',
    // pre-seed a guard-owned pause, exactly as a real prior tick would have left it.
    '  fs.writeFileSync(stateFile, JSON.stringify({ mode: "paused", account: { fp: ident.fp, source: ident.source }, pausedAgents: [{ id: "a1", name: "Agent1", company: "Co" }] }));',
    // tick 1: override honoured — reconciliation runs, but an EXTERNAL writer seizes the state lock the
    // instant doResume() is invoked (a real lock-timeout refusal, not a mock of the write itself), exactly
    // modelling a genuine refused/fenced bookkeeping write mid-reconciliation.
    '  await G.tick({ fetchUsage: async () => uHigh, readIdentity: () => ident, readCredentialSnapshot: () => ({ credentialFp: "fpX", generation: "G0" }),',
    '    doResume: async (...a) => { doResumeCalls++; fs.writeFileSync(lockPath, "external-writer-holds-lock"); try { return await realDoResume(...a); } finally { try { fs.unlinkSync(lockPath); } catch {} } },',
    '  });',
    '  const stAfterTick1 = JSON.parse(fs.readFileSync(stateFile, "utf8"));',
    // tick 2: lock is free — reconciliation must actually run again (proving the retry continues) and
    // succeed for real this time.
    '  await G.tick({ fetchUsage: async () => uHigh, readIdentity: () => ident, readCredentialSnapshot: () => ({ credentialFp: "fpX", generation: "G0" }),',
    '    doResume: async (...a) => { doResumeCalls++; return await realDoResume(...a); },',
    '  });',
    '  const stAfterTick2 = JSON.parse(fs.readFileSync(stateFile, "utf8"));',
    '  process.stdout.write(JSON.stringify({ stAfterTick1, stAfterTick2, doResumeCalls, resumeCalls }));',
    '})().catch((e) => { process.stdout.write(JSON.stringify({ uncaught: String((e && e.message) || e) })); process.exitCode = 1; });',
  ].join('\n'), 'utf8');
  const stateFile = path.join(dir, 'state.json');
  const env = Object.assign({}, process.env, {
    FORGE_USAGE_GUARD_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'guard-n17w10-home-')),
    FORGE_CONFIG_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'guard-n17w10-cfghome-')),
    FORGE_PROJECT_ROOT: fs.mkdtempSync(path.join(os.tmpdir(), 'guard-n17w10-proj-')),
    FORGE_USAGE_GUARD_STATE: stateFile,
    FORGE_USAGE_GUARD_IDENTITY: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-n17w10-identity-')), '.claude.json'),
    NVIDIA_SKIP_ENV_FILES: '1',
    FORGE_USAGE_GUARD_STATE_LOCK_WAIT_MS: '150', // short, deterministic budget for the real lock-refusal
  });
  const r = require('child_process').spawnSync(process.execPath, [script], { encoding: 'utf8', env, timeout: 30000 });
  const lastLine = (r.stdout || '').trim().split('\n').pop();
  let out; try { out = JSON.parse(lastLine); } catch { out = { parseError: (r.stdout || '') + (r.stderr || '') + '\n' + lastLine }; }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  assert.ok(!out.uncaught, JSON.stringify(out));
  assert.strictEqual(out.stAfterTick1.mode, 'paused', 'a refused bookkeeping write during reconciliation must never leave "ok" behind — this is exactly Codex\'s N17 residual: ' + JSON.stringify(out.stAfterTick1));
  assert.ok(Array.isArray(out.stAfterTick1.pausedAgents) && out.stAfterTick1.pausedAgents.some((a) => a.id === 'a1'), 'the unresolved agent must stay listed, never silently dropped: ' + JSON.stringify(out.stAfterTick1));
  assert.strictEqual(out.doResumeCalls, 2, 'the SECOND tick must retry reconciliation — never stuck at 1 -> 2 -> 2: ' + JSON.stringify(out));
  assert.strictEqual(out.stAfterTick2.mode, 'ok', 'once reconciliation genuinely succeeds, state must say so: ' + JSON.stringify(out.stAfterTick2));
  assert.ok(!Array.isArray(out.stAfterTick2.pausedAgents) || out.stAfterTick2.pausedAgents.length === 0, JSON.stringify(out.stAfterTick2));
});

test('N17 wave 10: a no-op reconciliation outcome (modelling either a refused or a fenced bookkeeping write — indistinguishable from tick()\'s own override-active branch) never flips mode to "ok" on its own; only doResume()\'s own successful write may', () => {
  const out = runV15OverrideProbe([
    "'use strict';",
    ...V15_PROBE_FETCH_MOCK,
    'const fs = require("fs"); const path = require("path");',
    'const G = require(' + JSON.stringify(path.join(__dirname, 'usage-guard.cjs')) + ');',
    'const Grant = require(' + JSON.stringify(path.join(__dirname, 'forge-ownergrant.cjs')) + ');',
    'const grantRoot = fs.mkdtempSync(path.join(require("os").tmpdir(), "guard-n17w10b-scratch-"));',
    'G.__setOwnerGrantRootForTests(grantRoot);',
    'const until = new Date(Date.now()+3600000).toISOString();',
    'Grant.writeOverrideGrant({ active: true, at: new Date().toISOString(), until, reason: "granted", accountLabel: "n17w10b-account", credentialGeneration: "G0", issuanceId: "ISS-N17W10B" }, { projectRoot: grantRoot });',
    'const ident = { fp: "n17w10b-account", source: "account-uuid" };',
    'const uHigh = { session: { pct: 100, resetsAt: null }, week: { pct: 10, resetsAt: null }, windows: G.normalizeWindows({ limits: [{ kind: "session", group: "session", percent: 100, resets_at: null }] }), credits: { present: false }, credentialFp: null };',
    'fs.writeFileSync(process.env.FORGE_USAGE_GUARD_STATE, JSON.stringify({ mode: "paused", account: { fp: ident.fp, source: ident.source }, pausedAgents: [{ id: "a1", name: "Agent1", company: "Co" }] }));',
    'let doResumeCalls = 0;',
    '(async () => {',
    // a doResume() that makes NO persisted change at all — exactly what a refused OR a fenced bookkeeping
    // write both look like from this branch's own perspective (neither ever tells the caller "I wrote
    // something"; both are logged and skipped internally).
    '  await G.tick({ fetchUsage: async () => uHigh, readIdentity: () => ident, readCredentialSnapshot: () => ({ credentialFp: "fpY", generation: "G0" }), doResume: async () => { doResumeCalls++; } });',
    '  const st = JSON.parse(fs.readFileSync(process.env.FORGE_USAGE_GUARD_STATE, "utf8"));',
    '  process.stdout.write(JSON.stringify({ st, doResumeCalls }));',
    '})().catch((e) => { process.stdout.write(JSON.stringify({ uncaught: String((e && e.message) || e) })); process.exitCode = 1; });',
  ]);
  assert.ok(!out.uncaught, JSON.stringify(out));
  assert.strictEqual(out.doResumeCalls, 1, JSON.stringify(out));
  assert.strictEqual(out.st.mode, 'paused', 'a no-op reconciliation must never leave "ok" behind by itself — only doResume()\'s OWN successful write may transition mode: ' + JSON.stringify(out.st));
  assert.ok(Array.isArray(out.st.pausedAgents) && out.st.pausedAgents.some((a) => a.id === 'a1'), JSON.stringify(out.st));
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
  // wp20 M6: `start` now refuses without a login FILE (macOS keeps it in the Keychain). A login file WITHOUT an
  // access token lets the real start proceed while readToken() still throws before any fetch — no network call.
  fs.writeFileSync(path.join(isolatedHome, '.credentials.json'), JSON.stringify({ claudeAiOauth: {} }));
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
    FORGE_CONFIG_HOME: isolatedHome, // no FORGE_CONFIG.json here -> usage-guard is ON by default (v2.7.0)
    // a slow CI runner (windows-latest/Node 18) needed more than the 10 s default before the child claimed; the
    // suite went red inside the doctor and green on the immediate re-run — timing, not logic
    FORGE_USAGE_GUARD_CLAIM_TIMEOUT_MS: '30000',
  });
  // REGRESSION PROOF setup: snapshot the REAL home's pressure file BEFORE the isolated child ticks, so
  // the assertion at the bottom is real evidence, not a guess.
  const realPressureFile = path.join(os.homedir(), '.claude', 'FORGE_USAGE_PRESSURE.json');
  const realPressureExistedBefore = fs.existsSync(realPressureFile);
  const realPressureMtimeBefore = realPressureExistedBefore ? fs.statSync(realPressureFile).mtimeMs : null;

  const res = require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'usage-guard.cjs'), 'start', '--interval', '60'], {
    encoding: 'utf8', timeout: 60000,
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
    encoding: 'utf8', timeout: 60000,
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
  // v2.7.0 DISCLOSURE: a REAL start tells the owner what the guard reads and how to switch it off (schema text);
  // a start that did not start a new watcher (already running / refused) prints none of it.
  const disc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'orchestration', 'FORGE_CONFIG_SCHEMA.json'), 'utf8')).settings['usage-guard'].disclosure;
  assert.ok((res.stdout || '').includes(disc.nl) && (res.stdout || '').includes(disc.en), 'a real start prints the schema disclosure (nl + en): ' + (res.stdout || '').slice(0, 300));
  assert.ok(/Uit: \/forge config set usage-guard uit/.test(res.stdout || ''), 'a real start ends with the one-command way to switch it off');
  assert.ok(!/Uit: \/forge config set usage-guard uit/.test(res2.stdout || '') && !(res2.stdout || '').includes(disc.nl), 'no disclosure when no NEW watcher started: ' + (res2.stdout || '').slice(0, 200));
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

// ============================================================================================
// H6 — GUARD-CORRUPT (Codex recheck wp-f4, 2026-09-24): a malformed/unreadable state file must read as
// mode:'corrupt' (an explicit, honest label — never a silently-invented mode:'ok'), a FAILED measurement
// must preserve 'corrupt' rather than replacing it with a fabricated 'ok', and only a fresh, SUCCESSFUL,
// validated measurement may move the state forward — explicitly logged, never silently.
//
// Each test is fully self-contained (its own temp dir/env-var set-restore, awaited to completion inside
// the async test body itself) — the module's async `test()` wrapper QUEUES a promise-returning test body
// rather than running it immediately, so a shared outer setup/teardown block (the H4 pattern, which only
// ever holds SYNCHRONOUS tests) would tear down the temp dir before these async bodies actually run.
// ============================================================================================
const failingFetch6 = async () => { throw new Error('simulated fetch failure'); };
const unknownIdent6 = () => ({ fp: null, source: 'unknown' });
async function withCorruptStateGuard6(initialContent, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-corrupt-'));
  const stateFile = path.join(dir, 'state.json');
  const orig = process.env.FORGE_USAGE_GUARD_STATE;
  process.env.FORGE_USAGE_GUARD_STATE = stateFile;
  delete require.cache[require.resolve('./usage-guard.cjs')];
  const G6 = require('./usage-guard.cjs');
  try {
    if (initialContent !== null) fs.writeFileSync(stateFile, initialContent);
    else try { fs.unlinkSync(stateFile); } catch { /* genuinely missing on purpose */ }
    await run(G6, stateFile);
  } finally {
    if (orig === undefined) delete process.env.FORGE_USAGE_GUARD_STATE; else process.env.FORGE_USAGE_GUARD_STATE = orig;
    delete require.cache[require.resolve('./usage-guard.cjs')];
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

test('GUARD-CORRUPT: a malformed state file reads as mode:"corrupt"; a failed measurement preserves it (never a fabricated "ok")', () =>
  withCorruptStateGuard6('{ not valid json', async (G6, stateFile) => {
    await G6.tick({ fetchUsage: failingFetch6, readIdentity: unknownIdent6, log: () => {} });
    const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.strictEqual(persisted.mode, 'corrupt', 'a failed measurement must never replace corrupt state with a fabricated ok: ' + JSON.stringify(persisted));
    assert.strictEqual(persisted.corruptReason, 'invalid-json');
    assert.ok(typeof persisted.lastError === 'string' && persisted.lastError.length > 0, 'the failed measurement is still honestly recorded');
  }));

test('GUARD-CORRUPT: an unexpected JSON shape (a bare array) also reads as corrupt, never ok', () =>
  withCorruptStateGuard6(JSON.stringify([1, 2, 3]), async (G6, stateFile) => {
    await G6.tick({ fetchUsage: failingFetch6, readIdentity: unknownIdent6, log: () => {} });
    const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.strictEqual(persisted.mode, 'corrupt');
    assert.strictEqual(persisted.corruptReason, 'unexpected-shape');
  }));

test('GUARD-CORRUPT: a genuinely MISSING state file (never written yet) is legitimately mode:"ok", not corrupt', () =>
  withCorruptStateGuard6(null, async (G6, stateFile) => {
    await G6.tick({ fetchUsage: failingFetch6, readIdentity: unknownIdent6, log: () => {} });
    const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.strictEqual(persisted.mode, 'ok');
    assert.strictEqual(persisted.corruptReason, undefined);
  }));

test('GUARD-CORRUPT: a fresh SUCCESSFUL measurement recovers corrupt state explicitly (logged, stale fields cleared) — never silently', () =>
  withCorruptStateGuard6('{ not valid json', async (G6, stateFile) => {
    const logs = [];
    const windows = G6.normalizeWindows({ limits: [{ kind: 'session', group: 'session', percent: 10, resets_at: null }] });
    const usage = { session: { pct: 10, resetsAt: null }, week: { pct: 10, resetsAt: null }, windows, credits: { used: NaN, limit: NaN, remaining: NaN } };
    await G6.tick({ fetchUsage: async () => usage, readIdentity: unknownIdent6, log: (m) => logs.push(m), doPause: async () => {}, doResume: async () => {} });
    const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.strictEqual(persisted.mode, 'ok');
    assert.strictEqual(persisted.corruptReason, undefined, 'stale corrupt-diagnostic fields must not linger once recovered');
    assert.strictEqual(persisted.corruptAt, undefined);
    assert.ok(logs.some((l) => /STATE WAS CORRUPT/.test(l)), 'the recovery must be explicitly logged, never silent: ' + JSON.stringify(logs));
  }));

test('GUARD-CORRUPT: a corrupt state that IS over the pause threshold on the fresh measurement pauses for real (does not need to "resume" first)', () =>
  withCorruptStateGuard6('not json at all', async (G6) => {
    const calls = { doPause: 0 };
    const windows = G6.normalizeWindows({ limits: [{ kind: 'session', group: 'session', percent: 99, resets_at: null }] });
    const usage = { session: { pct: 99, resetsAt: null }, week: { pct: 10, resetsAt: null }, windows, credits: { used: NaN, limit: NaN, remaining: NaN } };
    await G6.tick({ fetchUsage: async () => usage, readIdentity: unknownIdent6, log: () => {}, doPause: async () => { calls.doPause++; }, doResume: async () => {} });
    assert.strictEqual(calls.doPause, 1, 'a real crossed window on the recovering measurement must pause immediately');
  }));

// ============================================================================================
// H5 — v2.7.0 (2026-09-24): the guard's settings come from /forge config. Precedence: CLI flag > forge-config
//      value > the hard default (pause-at 98 — the only pause literal left; the 93/95 drift is gone). `start`
//      refuses when the owner switched the guard off, and prints the disclosure only on a REAL start.
//      Every CLI call runs in a sandbox home: never the real ~/.claude, never a real login file.
// ============================================================================================
{
  const G5 = require('./usage-guard.cjs');
  const SCHEMA5 = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'orchestration', 'FORGE_CONFIG_SCHEMA.json'), 'utf8'));
  const t5 = (name, fn) => test('H5 ' + name, fn);
  const pick = (s, k) => [s[k].value, s[k].source];

  t5('no flag + no config -> pause-at 98 (standaard), resume-at 0, interval 120, nvidia-shift-at 80', () => {
    const s = G5.resolveGuardSettings([], null);
    assert.deepStrictEqual(pick(s, 'pause-at'), [98, 'standaard']);
    assert.deepStrictEqual(pick(s, 'resume-at'), [0, 'standaard']);
    assert.deepStrictEqual(pick(s, 'interval'), [120, 'standaard']);
    assert.deepStrictEqual(pick(s, 'nvidia-shift-at'), [80, 'standaard']);
    assert.deepStrictEqual(pick(s, 'enabled'), [true, 'standaard']);
    assert.strictEqual(s.force, false);
  });
  t5('the hard defaults agree with the schema defaults (one number, no drift)', () => {
    const s = G5.resolveGuardSettings([], null);
    for (const k of ['pause-at', 'resume-at', 'interval', 'nvidia-shift-at']) {
      assert.strictEqual(s[k].value, SCHEMA5.settings['usage-guard.' + k].default, k);
    }
    assert.strictEqual(s.enabled.value, SCHEMA5.settings['usage-guard'].default);
  });
  t5('a config value beats the default and is labelled instelling', () => {
    const s = G5.resolveGuardSettings(['status'], { 'usage-guard.pause-at': { value: 97, source: 'global' }, 'usage-guard.nvidia-shift-at': { value: 70, source: 'project' } });
    assert.deepStrictEqual(pick(s, 'pause-at'), [97, 'instelling']);
    assert.deepStrictEqual(pick(s, 'nvidia-shift-at'), [70, 'instelling']);
    assert.deepStrictEqual(pick(s, 'resume-at'), [0, 'standaard']);
  });
  t5('a config entry that only carries the schema default is labelled standaard', () => {
    const s = G5.resolveGuardSettings([], { 'usage-guard.pause-at': { value: 98, source: 'default' } });
    assert.deepStrictEqual(pick(s, 'pause-at'), [98, 'standaard']);
  });
  t5('a CLI flag beats the config value and is labelled vlag', () => {
    const s = G5.resolveGuardSettings(['watch', '--pause-at', '90', '--interval', '60'], { 'usage-guard.pause-at': { value: 97, source: 'project' }, 'usage-guard.interval': { value: 300, source: 'global' } });
    assert.deepStrictEqual(pick(s, 'pause-at'), [90, 'vlag']);
    assert.deepStrictEqual(pick(s, 'interval'), [60, 'vlag']);
  });
  t5('an unparseable flag is ignored with a warning and never becomes NaN (NaN would never pause)', () => {
    const s = G5.resolveGuardSettings(['--pause-at', 'abc'], { 'usage-guard.pause-at': { value: 97, source: 'global' } });
    assert.deepStrictEqual(pick(s, 'pause-at'), [97, 'instelling']);
    assert.strictEqual(s.warnings.length, 1);
    assert.match(s.warnings[0], /--pause-at/);
  });
  t5('the on/off switch: config off is reported as instelling; --force is detected', () => {
    const s = G5.resolveGuardSettings(['start', '--force'], { 'usage-guard': { value: false, source: 'global' } });
    assert.deepStrictEqual(pick(s, 'enabled'), [false, 'instelling']);
    assert.strictEqual(s.force, true);
  });
  t5('pure: the same input gives the same output and the input is not mutated', () => {
    const argvIn = ['--pause-at', '91'];
    const cfgIn = { 'usage-guard.pause-at': { value: 97, source: 'global' } };
    const snap = JSON.stringify([argvIn, cfgIn]);
    assert.deepStrictEqual(G5.resolveGuardSettings(argvIn, cfgIn), G5.resolveGuardSettings(argvIn, cfgIn));
    assert.strictEqual(JSON.stringify([argvIn, cfgIn]), snap);
  });
  t5('drift canary: the source has one pause default (98) and no 93/95 left in the argv default, usage text or header', () => {
    const src = fs.readFileSync(path.join(__dirname, 'usage-guard.cjs'), 'utf8');
    assert.ok(!/argv\('pause-at',\s*\d+\)/.test(src), 'pause-at must not carry its own argv() default any more');
    assert.ok(!/--pause-at 9[0-7]\b/.test(src), 'the usage text must not advertise another pause default');
    assert.ok(!/pause-at\s*%?\s*\(default 9[0-7]\)/.test(src), 'the header must not document another pause default');
    assert.ok(/'pause-at': 98\b/.test(src), 'the hard default 98 is the one literal');
  });
  t5('loadGuardConfig reads a real FORGE_CONFIG.json through forge-config.cjs (sandbox home)', () => {
    const home = process.env.FORGE_CONFIG_HOME;
    fs.mkdirSync(home, { recursive: true });
    const f = path.join(home, 'FORGE_CONFIG.json');
    fs.writeFileSync(f, JSON.stringify({ version: 1, settings: { 'usage-guard.pause-at': { value: 97, set_at: '2026-09-24T00:00:00Z', set_by: 'test' } } }));
    try {
      const r = G5.loadGuardConfig();
      assert.deepStrictEqual([r.cfg['usage-guard.pause-at'].value, r.cfg['usage-guard.pause-at'].source], [97, 'global']);
      assert.strictEqual(r.cfg['usage-guard'].value, true);
      assert.strictEqual(r.disclosure.nl, SCHEMA5.settings['usage-guard'].disclosure.nl);
      assert.strictEqual(r.note, null);
      assert.deepStrictEqual(pick(G5.resolveGuardSettings([], r.cfg), 'pause-at'), [97, 'instelling']);
    } finally { fs.rmSync(f, { force: true }); }
  });
  t5('loadGuardConfig without forge-config.cjs falls back to the schema defaults (98, standaard)', () => {
    const r = G5.loadGuardConfig({ configModule: null });
    assert.deepStrictEqual([r.cfg['usage-guard.pause-at'].value, r.cfg['usage-guard.pause-at'].source], [98, 'default']);
    assert.strictEqual(r.cfg['usage-guard'].value, true);
    assert.strictEqual(r.disclosure.en, SCHEMA5.settings['usage-guard'].disclosure.en);
    assert.deepStrictEqual(pick(G5.resolveGuardSettings([], r.cfg), 'pause-at'), [98, 'standaard']);
  });
  t5('M3: a malformed FORGE_CONFIG.json is UNREADABLE — thresholds at the defaults, a visible note, unreadable:true (never a silent ON)', () => {
    const home = process.env.FORGE_CONFIG_HOME;
    fs.mkdirSync(home, { recursive: true });
    const f = path.join(home, 'FORGE_CONFIG.json');
    fs.writeFileSync(f, '{ "version": 1, "settings": { "usage-guard": ');
    try {
      const r = G5.loadGuardConfig();
      assert.ok(typeof r.note === 'string' && r.note.length > 0, 'a visible note, not silence');
      assert.strictEqual(r.unreadable, true, 'the caller must be able to tell unreadable from on');
      assert.match(r.note, /usage guard start niet \(veilige standaard: uit\)/);
      assert.strictEqual(r.cfg['usage-guard.pause-at'].value, 98);
      assert.deepStrictEqual(G5.readGuardSwitch(), { on: false, unreadable: true }, 'the switch reads as OFF');
    } finally { fs.rmSync(f, { force: true }); }
  });
  t5('M3: a missing forge-config.cjs is unreadable too (switch OFF); a readable file is not', () => {
    assert.strictEqual(G5.loadGuardConfig({ configModule: null }).unreadable, true);
    assert.deepStrictEqual(G5.readGuardSwitch({ configModule: null }), { on: false, unreadable: true });
    assert.strictEqual(G5.loadGuardConfig().unreadable, false);
    assert.deepStrictEqual(G5.readGuardSwitch(), { on: true, unreadable: false });
  });

  // ---- CLI, real subprocess, sandbox home (no login file -> the usage fetch fails before any network call) ----
  function sandbox5(configSettings) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-h5-'));
    const home = path.join(dir, '.claude');
    fs.mkdirSync(home, { recursive: true });
    if (configSettings) fs.writeFileSync(path.join(home, 'FORGE_CONFIG.json'), JSON.stringify({ version: 1, settings: configSettings }));
    const env = Object.assign({}, process.env, {
      HOME: dir, USERPROFILE: dir,
      FORGE_USAGE_GUARD_HOME: home, FORGE_CONFIG_HOME: home, FORGE_PROJECT_ROOT: path.join(dir, 'project'),
      FORGE_USAGE_GUARD_PID: path.join(dir, 'guard.pid'), FORGE_USAGE_GUARD_LOG: path.join(dir, 'guard.log'),
      FORGE_USAGE_GUARD_STATE: path.join(dir, 'state.json'), FORGE_USAGE_PRESSURE_FILE: path.join(dir, 'pressure.json'),
      FORGE_USAGE_GUARD_JOURNAL: path.join(dir, 'paused.jsonl'), FORGE_USAGE_GUARD_IDENTITY: path.join(dir, 'identity.json'),
    });
    return { dir, home, env };
  }
  const runGuard = (argv5, env) => require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'usage-guard.cjs'), ...argv5], { encoding: 'utf8', timeout: 30000, env });
  const val = (v) => ({ value: v, set_at: '2026-09-24T00:00:00Z', set_by: 'test' });

  t5('CLI status (no config) prints "pause-at 98% (bron: standaard)"', () => {
    const sb = sandbox5(null);
    const r = runGuard(['status'], sb.env);
    assert.match(r.stdout || '', /pause-at 98% \(bron: standaard\)/, (r.stdout || '') + (r.stderr || ''));
  });
  t5('CLI status with a config value prints bron: instelling; a --pause-at flag prints bron: vlag', () => {
    const sb = sandbox5({ 'usage-guard.pause-at': val(97) });
    const a = runGuard(['status'], sb.env);
    assert.match(a.stdout || '', /pause-at 97% \(bron: instelling\)/, (a.stdout || '') + (a.stderr || ''));
    const b = runGuard(['status', '--pause-at', '91'], sb.env);
    assert.match(b.stdout || '', /pause-at 91% \(bron: vlag\)/, (b.stdout || '') + (b.stderr || ''));
  });
  t5('CLI start with usage-guard OFF in the config exits 3 with the plain message and spawns nothing', () => {
    const sb = sandbox5({ 'usage-guard': val(false) });
    const r = runGuard(['start'], sb.env);
    // REGRESSION SAFETY: if a broken build DID start a watcher, kill exactly the pid its own sandbox pid file names
    // (only a child spawned by this call can have written it) before asserting — never leave an orphan behind.
    try {
      const leaked = JSON.parse(fs.readFileSync(sb.env.FORGE_USAGE_GUARD_PID, 'utf8')).pid;
      if (leaked && G5.pidAlive(leaked)) process.kill(leaked);
    } catch { /* no pid file = nothing was spawned, which is the expected outcome */ }
    assert.strictEqual(r.status, 3, 'exit 3 = act on this: ' + (r.stdout || '') + (r.stderr || ''));
    assert.ok((r.stdout || '').includes('usage-guard staat UIT in je instellingen (aanzetten: /forge config set usage-guard aan) / usage guard is OFF in your settings'), r.stdout);
    assert.ok(!fs.existsSync(sb.env.FORGE_USAGE_GUARD_PID), 'no watcher claimed a slot');
    assert.ok(!fs.existsSync(sb.env.FORGE_USAGE_GUARD_LOG), 'no watcher log was opened (nothing was spawned)');
    assert.ok(!(r.stdout || '').includes(SCHEMA5.settings['usage-guard'].disclosure.nl), 'no disclosure when nothing started');
  });

  // ---- wp20 security fixes (2026-09-24): L1 credential errors · M6 no login file · M3 unreadable settings · L2 switch
  // re-read per check. Every CLI call runs in a sandbox home; a login file here never holds a usable token, so
  // readToken() throws before any fetch — no network call anywhere in this block.
  const credFile = (sb) => path.join(sb.home, '.credentials.json');
  const readIf = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
  const hasPath = (text, p) => text.includes(p) || text.includes(p.split(path.sep).join('/')) || text.includes(JSON.stringify(p).slice(1, -1));
  const nap = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { } };
  // REGRESSION SAFETY: a broken build could leave a watcher behind — kill exactly the pid ITS OWN sandbox pid file names.
  const killLeak = (sb) => {
    try {
      const p = JSON.parse(fs.readFileSync(sb.env.FORGE_USAGE_GUARD_PID, 'utf8')).pid;
      if (p && p !== process.pid && G5.pidAlive(p)) process.kill(p);
    } catch { /* no pid file = nothing was spawned */ }
  };
  // v2.8.0: the reason is platform-honest (the Keychain remark is macOS-only; a fresh Windows/Linux machine is
  // simply not logged in yet) — mirror usage-guard.cjs's own wording per platform.
  const NO_CRED = 'usage guard cannot measure on this machine: no ~/.claude/.credentials.json (' +
    (process.platform === 'darwin'
      ? 'macOS keeps the Claude Code login in the Keychain, which the guard cannot read'
      : 'Claude Code is not logged in on this machine yet, or keeps its login elsewhere') + ') — ';

  t5('L1: a torn/malformed login file never puts token fragments or the home path into state, log or output', () => {
    const sb = sandbox5(null);
    // a damaged file whose token lost its opening quote: V8's JSON.parse message then quotes the input around the error
    const torn = '{"claudeAiOauth":{"accessToken":sk-ant-oat01-SECRETFRAGMENTqz9}}';
    fs.writeFileSync(credFile(sb), torn);
    let raw = ''; try { JSON.parse(torn); } catch (e) { raw = e.message; }
    // Control arm — Node/V8-version dependent: Node 20+ quotes the input ("Unexpected token 's', "…sk-ant-oat…" is not
    // valid JSON"), Node 18 prints only "Unexpected token s in JSON at position 32". The product assertions below hold on
    // both; the control only proves the leak is REAL on runtimes that quote. On a runtime that does not quote, say so
    // instead of failing the suite (found on the ubuntu/Node 18 CI runner, 2026-09-24 — the local run was Node 24).
    if (/sk-ant-oat/.test(raw)) {
      assert.ok(true, 'control: this runtime quotes the login file in the raw JSON.parse message');
    } else {
      console.log('  note: this Node runtime (' + process.version + ') does not quote the input in JSON.parse errors; control arm not applicable, product assertions still enforced');
    }
    const r = runGuard(['watch', '--once'], sb.env);
    const state = readIf(sb.env.FORGE_USAGE_GUARD_STATE);
    const logText = readIf(sb.env.FORGE_USAGE_GUARD_LOG);
    assert.ok(state.length > 0 && logText.length > 0, 'the failed check was recorded: ' + (r.stdout || '') + (r.stderr || ''));
    assert.strictEqual(JSON.parse(state).lastError, 'credentials file unreadable (SyntaxError)');
    for (const [name, text] of [['state', state], ['log', logText], ['stdout', r.stdout || ''], ['stderr', r.stderr || '']]) {
      assert.ok(!/sk-ant|oat01|essToken|qz9|FRAGMENT|SECRET/.test(text), name + ' must not carry any part of the login file: ' + text.slice(0, 300));
      assert.ok(!hasPath(text, sb.home), name + ' must not carry the absolute home path');
    }
  });
  t5('L1: a login file without a token, and a missing login file, give fixed messages without any path', () => {
    const sb = sandbox5(null);
    fs.writeFileSync(credFile(sb), JSON.stringify({ claudeAiOauth: {} }));
    runGuard(['watch', '--once'], sb.env);
    assert.strictEqual(JSON.parse(readIf(sb.env.FORGE_USAGE_GUARD_STATE) || '{}').lastError, 'no OAuth token in the credentials file (.credentials.json)');
    fs.rmSync(credFile(sb));
    runGuard(['watch', '--once'], sb.env);
    const stText = readIf(sb.env.FORGE_USAGE_GUARD_STATE);
    assert.strictEqual(JSON.parse(stText || '{}').lastError, 'credentials file unreadable (ENOENT)');
    assert.ok(!hasPath(stText, sb.home) && !hasPath(readIf(sb.env.FORGE_USAGE_GUARD_LOG), sb.home), 'no absolute path in state or log');
  });
  t5('M6: start without a login file prints one honest line, exits 3 and spawns nothing — --force does not change that', () => {
    const sb = sandbox5(null);
    for (const argv5 of [['start'], ['start', '--force']]) {
      const r = runGuard(argv5, sb.env);
      killLeak(sb);
      assert.strictEqual(r.status, 3, argv5.join(' ') + ': ' + (r.stdout || '') + (r.stderr || ''));
      assert.strictEqual((r.stdout || '').trim(), NO_CRED + 'not started');
      assert.ok(!fs.existsSync(sb.env.FORGE_USAGE_GUARD_PID) && !fs.existsSync(sb.env.FORGE_USAGE_GUARD_LOG), 'nothing was spawned');
    }
  });
  t5('M6: status without a login file says the same, not a raw file error', () => {
    const sb = sandbox5(null);
    const r = runGuard(['status'], sb.env);
    assert.ok((r.stdout || '').includes(NO_CRED + 'no measurement'), r.stdout);
    assert.ok(!/ENOENT|usage fetch failed/.test((r.stdout || '') + (r.stderr || '')), (r.stdout || '') + (r.stderr || ''));
  });
  t5('M3: start with an unreadable FORGE_CONFIG.json refuses (exit 3, plain message) and spawns nothing', () => {
    const sb = sandbox5(null);
    fs.writeFileSync(path.join(sb.home, 'FORGE_CONFIG.json'), '{ "version": 1, "settings": ');
    fs.writeFileSync(credFile(sb), JSON.stringify({ claudeAiOauth: {} })); // login file present: M6 is not the reason
    const r = runGuard(['start'], sb.env);
    killLeak(sb);
    assert.strictEqual(r.status, 3, (r.stdout || '') + (r.stderr || ''));
    assert.ok((r.stdout || '').includes('instellingen onleesbaar — usage guard start niet; herstel of reset met /forge config reset --yes'), r.stdout);
    assert.ok(!fs.existsSync(sb.env.FORGE_USAGE_GUARD_PID), 'no watcher claimed a slot');
  });
  t5('L2: a real watcher whose switch is OFF at its check logs one line, releases its pid file and exits 0 — no check made', () => {
    const sb = sandbox5({ 'usage-guard': val(false) });
    const r = runGuard(['watch', '--interval', '60'], sb.env);
    killLeak(sb);
    const logText = readIf(sb.env.FORGE_USAGE_GUARD_LOG);
    assert.strictEqual(r.status, 0, 'a clean exit: ' + (r.stdout || '') + (r.stderr || ''));
    assert.ok(/usage-guard staat nu UIT in je instellingen — de watcher stopt/.test(logText), logText);
    assert.ok(!/CHECK FAILED|REAL usage/.test(logText), 'no usage check after the switch went off: ' + logText);
    assert.ok(!fs.existsSync(sb.env.FORGE_USAGE_GUARD_PID), 'the pid file was released');
  });
  // N06 (third Codex recheck, 2026-09-24): FORGE_USAGE_GUARD_OWNERGRANT_ROOT was itself the vulnerability
  // — a caller could redirect authoritative grant-root selection via its OWN environment, exactly the
  // "verified against a value I just chose" failure mode forge-ownergrant.cjs's own header already warns
  // against for the SECRET. It is now REMOVED from every production code path: `TRUSTED_OWNERGRANT_ROOT` is
  // a module-level `let`, set once from `__dirname` and NEVER re-derived from `process.env` or any CLI flag.
  // The two tests below therefore split what the OLD single env-var-redirected test proved:
  //  (1) "force forwarding survives its own first failed check" is decoupled from the grant check entirely
  //      — watchStep() itself never verifies a grant (only the CLI's `start`/`watch --force` DISPATCH does,
  //      before ever calling watchStep) — so this is proven in-process via watchStep() directly.
  //  (2) "a legitimate grant is honoured" is proven via the new __setOwnerGrantRootForTests() module-level
  //      seam (require()'d directly, in-process — the SAME `spawnGuardProbe` convention already used
  //      elsewhere in this file), never via an env var reachable from a real `node usage-guard.cjs ...`
  //      invocation. KNOWN GAP (named, not silently dropped): this no longer proves the FULL `start --force`
  //      CLI subprocess succeeds end-to-end with a real trusted-root grant — doing that would require either
  //      writing a real secret into this project's own live `.claude/config/forge-owner-grant.txt` (unsafe:
  //      risks colliding with a real owner-configured secret) or extracting a separately-exported `runCli()`
  //      from the monolithic `require.main === module` block (a structural change out of this narrow fix's
  //      scope). The REFUSAL direction — the security-critical one — remains fully proven end-to-end via a
  //      real spawned CLI subprocess in the tests below.
  t5('watchStep() forwards force and survives its own first failed check — this mechanism is independent of the (now root-locked) grant check, which only ever runs in the CLI dispatch BEFORE watchStep is reached', () => {
    const sb = sandbox5({ 'usage-guard': val(false) });
    fs.writeFileSync(credFile(sb), JSON.stringify({ claudeAiOauth: {} })); // present but tokenless — the first tick genuinely fails (CHECK FAILED), never a real network call
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-watchstep-'));
    const script = path.join(dir, 'probe.cjs');
    fs.writeFileSync(script, [
      "'use strict';",
      'const G = require(' + JSON.stringify(path.join(__dirname, 'usage-guard.cjs')) + ');',
      '(async () => {',
      '  const first = await G.watchStep({ forced: true }, { exit: () => {}, release: () => {} });',
      '  const st1 = JSON.parse(require("fs").readFileSync(process.env.FORGE_USAGE_GUARD_STATE, "utf8"));',
      '  const second = await G.watchStep({ forced: true, seenOn: first.seenOn }, { exit: () => {}, release: () => {} });',
      '  process.stdout.write(JSON.stringify({ first, second, lastError1: st1.lastError }));',
      '})().catch((e) => { process.stdout.write(JSON.stringify({ uncaught: String((e && e.message) || e) })); process.exitCode = 1; });',
    ].join('\n'), 'utf8');
    // usage-guard.cjs's own log() also writes plain console.log lines ("CHECK FAILED...") to this SAME
    // stdout — the probe's JSON result is always the LAST line it writes (this file's own established
    // convention; see the V29 tests above), never a naive whole-stdout JSON.parse.
    const r = require('child_process').spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 30000, env: sb.env });
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    const lastLine = (r.stdout || '').trim().split('\n').pop();
    let out; try { out = JSON.parse(lastLine); } catch { out = { parseError: (r.stdout || '') + (r.stderr || '') }; }
    assert.strictEqual(out.first && out.first.outcome, 'ticked', 'the FIRST forced tick, with the switch OFF, must still reach tick() rather than self-stop: ' + JSON.stringify(out));
    assert.match(out.lastError1 || '', /no OAuth token/, 'the forced tick really ran (and really failed, safely, for lack of a token) rather than being skipped: ' + JSON.stringify(out));
    assert.strictEqual(out.second && out.second.outcome, 'ticked', 'a SECOND forced tick must also proceed — the watcher is never undone by its own first failed check: ' + JSON.stringify(out));
  });
  t5('N06: a legitimate grant at the seam-selected root is honoured by verifyForcedWatchGrant — the SAME function the CLI dispatch calls', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-n06-legit-'));
    const script = path.join(dir, 'probe.cjs');
    fs.writeFileSync(script, [
      "'use strict';",
      'const G = require(' + JSON.stringify(path.join(__dirname, 'usage-guard.cjs')) + ');',
      'const fs = require("fs"); const path = require("path");',
      'const root = process.argv[2];',
      'fs.mkdirSync(path.join(root, ".claude", "config"), { recursive: true });',
      'fs.writeFileSync(path.join(root, ".claude", "config", "forge-owner-grant.txt"), "SEAM-TEST-TOKEN\\n");',
      'G.__setOwnerGrantRootForTests(root);',
      'const okResult = G.verifyForcedWatchGrant("SEAM-TEST-TOKEN");',
      'const wrongResult = G.verifyForcedWatchGrant("guessed-wrong");',
      'G.__setOwnerGrantRootForTests(null); // reset — a null/falsy argument restores the real trusted root',
      'process.stdout.write(JSON.stringify({ okResult, wrongResult }));',
    ].join('\n'), 'utf8');
    const r = require('child_process').spawnSync(process.execPath, [script, dir], { encoding: 'utf8', timeout: 30000 });
    let out; try { out = JSON.parse(r.stdout); } catch { out = { parseError: (r.stdout || '') + (r.stderr || '') }; }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    assert.strictEqual(out.okResult && out.okResult.ok, true, 'a matching token against the seam-selected root must succeed: ' + JSON.stringify(out));
    assert.strictEqual(out.wrongResult && out.wrongResult.ok, false, 'a wrong token must still be refused even with a matching root: ' + JSON.stringify(out));
  });
  t5('N06: FORGE_USAGE_GUARD_OWNERGRANT_ROOT no longer selects anything — a real CLI subprocess given that env var pointed at a scratch root WITH a matching grant, and no grant anywhere under the trusted root, is REFUSED', () => {
    const sb = sandbox5({ 'usage-guard': val(false) });
    fs.writeFileSync(credFile(sb), JSON.stringify({ claudeAiOauth: {} }));
    const grantRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-n06-inert-'));
    try {
      fs.mkdirSync(path.join(grantRoot, '.claude', 'config'), { recursive: true });
      fs.writeFileSync(path.join(grantRoot, '.claude', 'config', 'forge-owner-grant.txt'), 'N06-SCRATCH-TOKEN\n');
      const env = Object.assign({}, sb.env, { FORGE_USAGE_GUARD_OWNERGRANT_ROOT: grantRoot });
      const r = runGuard(['watch', '--force', '--interval', '60', '--owner-approval', 'N06-SCRATCH-TOKEN'], env);
      try {
        const leaked = JSON.parse(fs.readFileSync(sb.env.FORGE_USAGE_GUARD_PID, 'utf8')).pid;
        if (leaked && G5.pidAlive(leaked)) process.kill(leaked);
      } catch { /* no pid file = nothing was spawned, which is the expected (refused) outcome */ }
      assert.strictEqual(r.status, 3, 'a token that only matches a caller-selected scratch root must be REFUSED, not honoured: ' + (r.stdout || '') + (r.stderr || ''));
      assert.ok(/watch --force REFUSED/.test(r.stderr || ''), (r.stdout || '') + (r.stderr || ''));
      assert.ok(!fs.existsSync(sb.env.FORGE_USAGE_GUARD_PID), 'no slot may be claimed on a caller-selected-root grant');
    } finally { fs.rmSync(grantRoot, { recursive: true, force: true }); }
  });
  t5('N06: forge-ownergrant.cjs itself has no env-selected root — projectRoot only ever comes from an explicit function argument or its own DEFAULT_ROOT constant', () => {
    const src = fs.readFileSync(path.join(__dirname, 'forge-ownergrant.cjs'), 'utf8');
    assert.ok(!/projectRoot[\s\S]{0,60}process\.env/.test(src) && !/process\.env\.[A-Z_]*ROOT/.test(src),
      'forge-ownergrant.cjs must never select its projectRoot from an environment variable: ' + src.match(/process\.env\.[A-Z_]*/g));
  });
  t5('N06: usage-guard.cjs source no longer reads FORGE_USAGE_GUARD_OWNERGRANT_ROOT from process.env anywhere', () => {
    const src = fs.readFileSync(path.join(__dirname, 'usage-guard.cjs'), 'utf8');
    assert.ok(!/process\.env\.FORGE_USAGE_GUARD_OWNERGRANT_ROOT/.test(src), 'the removed env var must not be read anywhere in production code: ' + (src.match(/.{0,40}FORGE_USAGE_GUARD_OWNERGRANT_ROOT.{0,40}/g) || []).join('\n'));
  });
  // ---- V18, second Codex recheck (2026-09-24): continuous forced watching (`start --force` / `watch
  // --force`, never --once) is now REFUSED outright without a verified owner-authorisation grant — the
  // exact reproduction Codex used (three off-state ticks, zero grant check) must now be impossible.
  t5('V18: start --force WITHOUT --owner-approval is REFUSED (exit 3) — no watcher spawned, no pid file written', () => {
    const sb = sandbox5({ 'usage-guard': val(false) });
    fs.writeFileSync(credFile(sb), JSON.stringify({ claudeAiOauth: {} }));
    // deliberately no forge-owner-grant.txt anywhere OWNERGRANT_PROJECT_ROOT could resolve to
    const grantRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-v18-noroot-'));
    try {
      const r = runGuard(['start', '--force', '--interval', '60'], Object.assign({}, sb.env, { FORGE_USAGE_GUARD_OWNERGRANT_ROOT: grantRoot }));
      // REGRESSION SAFETY (mirrors the existing "CLI start with usage-guard OFF" test's own pattern): if a
      // broken build DID spawn a detached watcher despite the missing grant, kill exactly the pid its own
      // sandbox pid file names before asserting — never leave a real orphaned watcher process behind.
      try {
        const leaked = JSON.parse(fs.readFileSync(sb.env.FORGE_USAGE_GUARD_PID, 'utf8')).pid;
        if (leaked && G5.pidAlive(leaked)) process.kill(leaked);
      } catch { /* no pid file = nothing was spawned, which is the expected outcome */ }
      assert.strictEqual(r.status, 3, 'a refusal must exit 3: ' + (r.stdout || '') + (r.stderr || ''));
      assert.ok(/start --force REFUSED/.test(r.stdout || ''), r.stdout);
      assert.ok(!fs.existsSync(sb.env.FORGE_USAGE_GUARD_PID), 'no watcher may be spawned without a verified grant');
    } finally { fs.rmSync(grantRoot, { recursive: true, force: true }); }
  });
  t5('V18: start --force with a WRONG --owner-approval token is REFUSED (exit 3) — a guessed token never authorises', () => {
    const sb = sandbox5({ 'usage-guard': val(false) });
    fs.writeFileSync(credFile(sb), JSON.stringify({ claudeAiOauth: {} }));
    const grantRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-v18-wrong-'));
    try {
      fs.mkdirSync(path.join(grantRoot, '.claude', 'config'), { recursive: true });
      fs.writeFileSync(path.join(grantRoot, '.claude', 'config', 'forge-owner-grant.txt'), 'REAL-SECRET\n');
      const r = runGuard(['start', '--force', '--interval', '60', '--owner-approval', 'guessed-wrong'], Object.assign({}, sb.env, { FORGE_USAGE_GUARD_OWNERGRANT_ROOT: grantRoot }));
      // REGRESSION SAFETY: same defensive kill as above.
      try {
        const leaked = JSON.parse(fs.readFileSync(sb.env.FORGE_USAGE_GUARD_PID, 'utf8')).pid;
        if (leaked && G5.pidAlive(leaked)) process.kill(leaked);
      } catch { /* nothing was spawned, which is the expected outcome */ }
      assert.strictEqual(r.status, 3, (r.stdout || '') + (r.stderr || ''));
      assert.ok(!fs.existsSync(sb.env.FORGE_USAGE_GUARD_PID), 'no watcher may be spawned on a wrong token');
    } finally { fs.rmSync(grantRoot, { recursive: true, force: true }); }
  });
  t5('V18: `watch --force` invoked DIRECTLY (not via start) is ALSO refused without a grant — the same exception applies to both entry points', () => {
    const sb = sandbox5({ 'usage-guard': val(false) });
    fs.writeFileSync(credFile(sb), JSON.stringify({ claudeAiOauth: {} }));
    const grantRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-v18-watch-'));
    try {
      const r = runGuard(['watch', '--force', '--interval', '60'], Object.assign({}, sb.env, { FORGE_USAGE_GUARD_OWNERGRANT_ROOT: grantRoot }));
      assert.strictEqual(r.status, 3, (r.stdout || '') + (r.stderr || ''));
      assert.ok(/watch --force REFUSED/.test(r.stderr || ''), (r.stdout || '') + (r.stderr || ''));
      assert.ok(!fs.existsSync(sb.env.FORGE_USAGE_GUARD_PID), 'no slot may be claimed without a verified grant');
    } finally { fs.rmSync(grantRoot, { recursive: true, force: true }); }
  });
  t5('V18: a plain one-shot --force on check/status/credits is COMPLETELY UNCHANGED — it still needs no owner-approval at all (exception 1 vs exception 3 stay distinct)', () => {
    const sb = sandbox5({ 'usage-guard': val(false) });
    fs.writeFileSync(credFile(sb), JSON.stringify({ claudeAiOauth: {} }));
    const grantRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-v18-oneshot-'));
    try {
      // no grant file anywhere, no --owner-approval — a one-shot --force must still proceed straight to
      // "no OAuth token" (it got PAST the off-switch gate, which is all this test is proving)
      const r = runGuard(['status', '--force'], Object.assign({}, sb.env, { FORGE_USAGE_GUARD_OWNERGRANT_ROOT: grantRoot }));
      assert.ok(!/REFUSED|owner authorisation/.test((r.stdout || '') + (r.stderr || '')), 'plain --force on status must never require a grant: ' + (r.stdout || '') + (r.stderr || ''));
    } finally { fs.rmSync(grantRoot, { recursive: true, force: true }); }
  });
  t5('V18 FINAL EXCEPTION TABLE drift-canary: the source documents exactly 3 exceptions and start/watch both call the SAME shared grant check', () => {
    const src = fs.readFileSync(path.join(__dirname, 'usage-guard.cjs'), 'utf8');
    assert.ok(/V18 FINAL EXCEPTION TABLE/.test(src), 'the 3-exception table must be documented in the source');
    assert.ok(/\(1\) ONE-SHOT, READ-ONLY/.test(src) && /\(2\) VERIFIED-GRANT, CONSEQUENTIAL/.test(src) && /\(3\) VERIFIED-GRANT, SUSTAINED/.test(src), 'all three exceptions must be individually named');
    assert.strictEqual((src.match(/verifyForcedWatchGrant\(/g) || []).length >= 3, true, 'both the start and watch CLI handlers (plus the function definition) must reference the ONE shared grant check, not a re-implemented copy');
  });
  // N06 (third Codex recheck, 2026-09-24): this test used to prove "override-on stamps the account it is
  // granted FOR" by granting itself via FORGE_USAGE_GUARD_OWNERGRANT_ROOT — exactly the env-var root
  // selection N06 removes. It is now split: the REFUSAL direction (security-critical) stays a full,
  // real-CLI-subprocess proof; the account-stamping code path itself (N01, a DIFFERENT, already-closed
  // finding — see the tick()-based N01 test above, which fully covers that regression without needing any
  // grant at all) is checked structurally, so a future edit cannot silently detach the stamp from the
  // override-on handler while still passing every other test in this file. KNOWN GAP (named, not silently
  // dropped): this no longer proves the account-stamp write happens via a live, successful override-on CLI
  // subprocess — doing that safely would require either a real secret in this project's own
  // `.claude/config/forge-owner-grant.txt` (out of scope: risks colliding with a real owner-configured
  // secret, and outside this work package's authorised file list) or an exported `runCli()` (a structural
  // change out of this narrow fix's scope).
  t5('N06: `override-on` is REFUSED when only a caller-selected scratch root has a matching grant — the trusted root has none', () => {
    const sb = sandbox5({ 'usage-guard': val(true) });
    fs.writeFileSync(sb.env.FORGE_USAGE_GUARD_IDENTITY, JSON.stringify({ oauthAccount: { accountUuid: 'n01-cli-uuid-0000', organizationUuid: 'org-n01' } }));
    const grantRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-n06-onlgrant-'));
    try {
      fs.mkdirSync(path.join(grantRoot, '.claude', 'config'), { recursive: true });
      fs.writeFileSync(path.join(grantRoot, '.claude', 'config', 'forge-owner-grant.txt'), 'N01-TEST-TOKEN\n');
      const env = Object.assign({}, sb.env, { FORGE_USAGE_GUARD_OWNERGRANT_ROOT: grantRoot });
      const r = runGuard(['override-on', '--owner-approval', 'N01-TEST-TOKEN', '--reason', 'test'], env);
      assert.strictEqual(r.status, 3, 'a scratch-root-only grant must be REFUSED now that the env var no longer selects the root: ' + (r.stdout || '') + (r.stderr || ''));
      assert.ok(/override-on REFUSED/.test(r.stderr || ''), (r.stdout || '') + (r.stderr || ''));
      assert.ok(!fs.existsSync(sb.env.FORGE_USAGE_GUARD_STATE) || !JSON.parse(fs.readFileSync(sb.env.FORGE_USAGE_GUARD_STATE, 'utf8')).ownerOverride, 'no override may be set on a refused grant');
    } finally { fs.rmSync(grantRoot, { recursive: true, force: true }); }
  });
  t5('N06/N01 structural check: runOverrideOn()\'s account-stamping call still sits INSIDE the same grant-gated, TRUSTED_OWNERGRANT_ROOT-checked function — a future edit cannot silently detach the two', () => {
    // normalize CRLF -> LF first: this file may be checked out with CRLF line endings (Windows
    // core.autocrlf), and a literal `\n` in the anchor pattern below must not silently fail to match `\r\n`.
    const src = fs.readFileSync(path.join(__dirname, 'usage-guard.cjs'), 'utf8').replace(/\r\n/g, '\n');
    // N11 (2026-09-24, Security Boss addendum): override-on's body was EXTRACTED from the inline
    // `if (cmd === 'override-on') {...}` CLI dispatch into a plain, exported, directly-callable
    // `runOverrideOn()` function precisely so N11's lock/removal-failure scenarios could be exercised
    // end-to-end via require() + __setOwnerGrantRootForTests() (see usage-guard-override.test.cjs and the
    // dedicated N11 tests below) without ever writing to this project's own live secret file. The CLI
    // dispatch itself is now just `if (cmd === 'override-on') { await runOverrideOn(); return; }`.
    const m = src.match(/async function runOverrideOn\(\) \{[\s\S]*?\n\}/);
    assert.ok(m, 'the runOverrideOn function must be present and structurally intact');
    const body = m[0];
    assert.ok(/projectRoot: TRUSTED_OWNERGRANT_ROOT/.test(body), 'runOverrideOn must verify its grant against the trusted root: ' + body.slice(0, 400));
    assert.ok(/accountStamp\(readAccountIdentity\(\)\)/.test(body), 'runOverrideOn must still stamp the account it is granted for (N01): ' + body.slice(0, 400));
    // the stamp must be assigned BEFORE the write, and the grant check must run BEFORE any of it.
    const grantIdx = body.indexOf('projectRoot: TRUSTED_OWNERGRANT_ROOT');
    const stampIdx = body.indexOf('accountStamp(readAccountIdentity())');
    const writeIdx = body.indexOf('writeState(st, fence)');
    assert.ok(grantIdx >= 0 && stampIdx > grantIdx && writeIdx > stampIdx, 'order must be grant-check -> account-stamp -> write: ' + JSON.stringify({ grantIdx, stampIdx, writeIdx }));
    assert.ok(src.includes("if (cmd === 'override-on') { await runOverrideOn(); return; }"), 'the CLI dispatch must delegate to runOverrideOn()');
  });
  // V15 (FOURTH Codex recheck, 2026-09-24) structural check: runOverrideOn/runOverrideOff both write the
  // AUTHORITATIVE override-grant record (usage-guard-override.cjs / forge-ownergrant.cjs), at the SAME
  // trusted root, and runOverrideOn writes it BEFORE ever touching the (lock-contended) state cache. The
  // actual grant-record READ/WRITE behavior itself (readOverrideGrant/writeOverrideGrant, and tick()'s use
  // of it) IS fully exercised end-to-end below and in forge-ownergrant.test.cjs / usage-guard-override.test.cjs;
  // N11's lock/removal-FAILURE scenarios are exercised end-to-end through runOverrideOn()/runOverrideOff()
  // themselves in the dedicated N11 tests further below.
  t5('V15 (FOURTH recheck) structural check: runOverrideOn writes the authoritative grant BEFORE the state lock; runOverrideOff clears it unconditionally', () => {
    const src = fs.readFileSync(path.join(__dirname, 'usage-guard.cjs'), 'utf8').replace(/\r\n/g, '\n');
    const onMatch = src.match(/async function runOverrideOn\(\) \{[\s\S]*?\n\}/);
    assert.ok(onMatch, 'runOverrideOn must be present and structurally intact');
    const onBody = onMatch[0];
    const writeGrantCall = "og.writeOverrideGrant({ active: true, at: new Date().toISOString(), until, reason, accountLabel: grantIdent.fp, credentialGeneration: grantCredentialGeneration, issuanceId }, { projectRoot: TRUSTED_OWNERGRANT_ROOT })";
    assert.ok(onBody.includes(writeGrantCall), 'runOverrideOn must write the authoritative grant record: ' + onBody.slice(0, 800));
    const grantCheckIdx = onBody.indexOf('projectRoot: TRUSTED_OWNERGRANT_ROOT'); // the verifyOwnerGrant() call, first occurrence
    const writeGrantIdx = onBody.indexOf(writeGrantCall);
    const lockIdx = onBody.indexOf('withStateLock(async (fence)');
    assert.ok(grantCheckIdx >= 0 && writeGrantIdx > grantCheckIdx && lockIdx > writeGrantIdx,
      'order must be token-check -> write authoritative grant -> (only then) attempt the state lock: ' + JSON.stringify({ grantCheckIdx, writeGrantIdx, lockIdx }));

    const offMatch = src.match(/async function runOverrideOff\(\) \{[\s\S]*?\n\}/);
    assert.ok(offMatch, 'runOverrideOff must be present and structurally intact');
    const offBody = offMatch[0];
    assert.ok(offBody.includes("writeOverrideGrant({ active: false }, { projectRoot: TRUSTED_OWNERGRANT_ROOT })"),
      'runOverrideOff must clear the authoritative grant record, at the SAME trusted root: ' + offBody);
    const offLockIdx = offBody.indexOf('withStateLock((fence)');
    const offGrantIdx = offBody.indexOf('writeOverrideGrant({ active: false }');
    assert.ok(offGrantIdx >= 0 && offLockIdx > offGrantIdx, 'runOverrideOff must clear the grant BEFORE attempting the state lock: ' + JSON.stringify({ offGrantIdx, offLockIdx }));
  });
  // ---- N11 (2026-09-24, Security Boss addendum reconfirmed): BOTH injected failures, END-TO-END through
  // the REAL exported runOverrideOn()/runOverrideOff() functions (never a re-implemented copy) — the exact
  // reason these were extracted from the inline CLI dispatch in the first place. `process.exit` and
  // `console.error`/`console.log` are intercepted so the spawned probe script can observe the outcome
  // instead of the whole process terminating on the first call; the REAL grant file, REAL secret-token
  // check and REAL state lock are exercised throughout — only the ONE targeted failure is injected. ----
  t5('N11: override-off — an injected grant-REMOVAL failure (directory sitting where the grant file should be) is reported HONESTLY as NOT re-armed, exits nonzero, and never claims success', () => {
    const out = runV15OverrideProbe([
      "'use strict';",
      'const fs = require("fs"); const path = require("path");',
      'const G = require(' + JSON.stringify(path.join(__dirname, 'usage-guard.cjs')) + ');',
      'const Grant = require(' + JSON.stringify(path.join(__dirname, 'forge-ownergrant.cjs')) + ');',
      'const grantRoot = fs.mkdtempSync(path.join(require("os").tmpdir(), "guard-n11-off-scratch-"));',
      'G.__setOwnerGrantRootForTests(grantRoot);',
      'const grantFile = Grant.overrideGrantFilePath({ projectRoot: grantRoot });',
      // a DIRECTORY sitting at the grant file's own path makes unlinkSync fail (EPERM/EISDIR, never ENOENT).
      'fs.mkdirSync(grantFile, { recursive: true });',
      // process.exit() NEVER returns in real life — the production code relies on that (it keeps writing
      // MORE lines after an early process.exit() call, assuming control never reaches them). A mock that
      // merely records the code and returns normally would let execution fall through into that later code
      // — THROW instead, so control genuinely stops at the exact point real process.exit() would terminate.
      'class ExitSignal { constructor(c) { this.code = c; } }',
      'const realExit = process.exit.bind(process);',
      'process.exit = (c) => { throw new ExitSignal(c); };',
      'const logs = []; const realErr = console.error, realLog = console.log;',
      'console.error = (m) => logs.push({ level: "error", m: String(m) });',
      'console.log = (m) => logs.push({ level: "log", m: String(m) });',
      '(async () => {',
      '  let exitCode = null;',
      '  try { await G.runOverrideOff(); } catch (e) { if (e instanceof ExitSignal) exitCode = e.code; else throw e; }',
      '  console.error = realErr; console.log = realLog;',
      '  process.stdout.write(JSON.stringify({ exitCode, logs, grantStillDirectory: fs.statSync(grantFile).isDirectory() }));',
      '  realExit(0);',
      '})().catch((e) => { process.stdout.write(JSON.stringify({ uncaught: String((e && e.message) || e) })); realExit(1); });',
    ]);
    assert.ok(!out.uncaught, JSON.stringify(out));
    assert.strictEqual(out.exitCode, 1, 'a failed grant removal must exit nonzero: ' + JSON.stringify(out));
    const text = out.logs.map((l) => l.m).join('\n');
    assert.match(text, /protection is NOT re-armed/, 'must say NOT re-armed, plainly: ' + text);
    assert.ok(!/OVERRIDE CLEARED/.test(text), 'must never print the success headline on a failed removal: ' + text);
    assert.strictEqual(out.grantStillDirectory, true, 'the (broken) grant path must be left untouched — no silent partial cleanup');
  });
  t5('N11: override-on — an injected ACTIVATION-TIME state-lock failure still reports the grant as genuinely ACTIVE (never "no change made") and exits 0', () => {
    const out = runV15OverrideProbe([
      "'use strict';",
      'const fs = require("fs"); const path = require("path");',
      'process.argv = [process.execPath, "usage-guard.cjs", "override-on", "--owner-approval", "N11-TEST-TOKEN", "--reason", "n11 lock test"];',
      'const G = require(' + JSON.stringify(path.join(__dirname, 'usage-guard.cjs')) + ');',
      'const Grant = require(' + JSON.stringify(path.join(__dirname, 'forge-ownergrant.cjs')) + ');',
      'const grantRoot = fs.mkdtempSync(path.join(require("os").tmpdir(), "guard-n11-on-scratch-"));',
      'G.__setOwnerGrantRootForTests(grantRoot);',
      'fs.mkdirSync(path.join(grantRoot, ".claude", "config"), { recursive: true });',
      'fs.writeFileSync(path.join(grantRoot, ".claude", "config", "forge-owner-grant.txt"), "N11-TEST-TOKEN\\n");',
      // U02 (2026-09-24, Codex p12 wave 7): runOverrideOn() now REFUSES outright when the current account
      // identity is unknown — a real, KNOWN identity is required here so this test still exercises its own
      // original scenario (an activation-time LOCK failure), not the new identity-refusal path.
      'fs.writeFileSync(process.env.FORGE_USAGE_GUARD_IDENTITY, JSON.stringify({ oauthAccount: { accountUuid: "n11-on-account-uuid", organizationUuid: "n11-org" } }));',
      // pre-hold the state lock with a token naming THIS script's own (very much alive) pid — withStateLock
      // must genuinely refuse to acquire it within the short wait budget below, never treat it as stale.
      'const stateFile = process.env.FORGE_USAGE_GUARD_STATE;',
      'fs.writeFileSync(stateFile + ".lock", process.pid + ":deadbeef00000000");',
      'class ExitSignal { constructor(c) { this.code = c; } }', // see the override-off test above for why THROW, not a recording no-op
      'const realExit = process.exit.bind(process);',
      'process.exit = (c) => { throw new ExitSignal(c); };',
      'const logs = []; const realErr = console.error, realLog = console.log;',
      'console.error = (m) => logs.push({ level: "error", m: String(m) });',
      'console.log = (m) => logs.push({ level: "log", m: String(m) });',
      '(async () => {',
      '  let exitCode = null;',
      '  try { await G.runOverrideOn(); } catch (e) { if (e instanceof ExitSignal) exitCode = e.code; else throw e; }',
      '  console.error = realErr; console.log = realLog;',
      '  const grantAfter = Grant.readOverrideGrant({ projectRoot: grantRoot });',
      '  process.stdout.write(JSON.stringify({ exitCode, logs, grantActive: grantAfter.active }));',
      '  realExit(0);',
      '})().catch((e) => { process.stdout.write(JSON.stringify({ uncaught: String((e && e.message) || e) })); realExit(1); });',
    ], {
      FORGE_USAGE_GUARD_STATE_LOCK_WAIT_MS: '200',
      FORGE_USAGE_GUARD_IDENTITY: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-n11-on-identity-')), '.claude.json'),
    });
    assert.ok(!out.uncaught, JSON.stringify(out));
    assert.strictEqual(out.grantActive, true, 'the authoritative grant must be genuinely active despite the lock failure: ' + JSON.stringify(out));
    assert.strictEqual(out.exitCode, 0, 'the security-relevant action (the grant) DID succeed — this must exit 0, not fail: ' + JSON.stringify(out));
    const text = out.logs.map((l) => l.m).join('\n');
    assert.match(text, /authoritative grant is ACTIVE/, 'must say the grant is genuinely active: ' + text);
    assert.match(text, /state lock could not be acquired/, 'must name the actual (lock) failure: ' + text);
    assert.ok(!/no change made/.test(text), 'must never claim "no change made" once the grant genuinely took effect: ' + text);
  });

  // ---- U02 (2026-09-24, Codex p12 wave 7): runOverrideOn() must VALIDATE before any write or resume — a
  // grant that could never actually protect anything (unknown identity to bind it to, or an expiry already
  // in the past) is refused outright, never silently written and reported as a success. ----
  function runOverrideOnRefusalProbe(extraArgv, extraEnv) {
    return runV15OverrideProbe([
      "'use strict';",
      'const fs = require("fs"); const path = require("path");',
      'process.argv = [process.execPath, "usage-guard.cjs", "override-on", "--owner-approval", "U02-TEST-TOKEN", "--reason", "u02 test"' + (extraArgv ? ', ' + extraArgv : '') + '];',
      'const G = require(' + JSON.stringify(path.join(__dirname, 'usage-guard.cjs')) + ');',
      'const Grant = require(' + JSON.stringify(path.join(__dirname, 'forge-ownergrant.cjs')) + ');',
      'const grantRoot = fs.mkdtempSync(path.join(require("os").tmpdir(), "guard-u02-scratch-"));',
      'G.__setOwnerGrantRootForTests(grantRoot);',
      'fs.mkdirSync(path.join(grantRoot, ".claude", "config"), { recursive: true });',
      'fs.writeFileSync(path.join(grantRoot, ".claude", "config", "forge-owner-grant.txt"), "U02-TEST-TOKEN\\n");',
      'class ExitSignal { constructor(c) { this.code = c; } }',
      'const realExit = process.exit.bind(process);',
      'process.exit = (c) => { throw new ExitSignal(c); };',
      'const logs = []; const realErr = console.error, realLog = console.log;',
      'console.error = (m) => logs.push({ level: "error", m: String(m) });',
      'console.log = (m) => logs.push({ level: "log", m: String(m) });',
      '(async () => {',
      '  let exitCode = null;',
      '  try { await G.runOverrideOn(); } catch (e) { if (e instanceof ExitSignal) exitCode = e.code; else throw e; }',
      '  console.error = realErr; console.log = realLog;',
      '  const grantAfter = Grant.readOverrideGrant({ projectRoot: grantRoot });',
      '  const stateFileExists = fs.existsSync(process.env.FORGE_USAGE_GUARD_STATE);',
      '  process.stdout.write(JSON.stringify({ exitCode, logs, grantActive: grantAfter.active, grantFileExists: fs.existsSync(Grant.overrideGrantFilePath({ projectRoot: grantRoot })), stateFileExists }));',
      '  realExit(0);',
      '})().catch((e) => { process.stdout.write(JSON.stringify({ uncaught: String((e && e.message) || e) })); realExit(1); });',
    ], extraEnv || {});
  }
  t5('on_unknown — U02: override-on REFUSES when the current account identity is unknown, BEFORE any write — no grant file, no state change', () => {
    // no FORGE_USAGE_GUARD_IDENTITY override: the default sandbox profile file does not exist, so identity
    // is genuinely unknown here, exactly like the real "not signed in yet" case.
    const out = runOverrideOnRefusalProbe();
    assert.ok(!out.uncaught, JSON.stringify(out));
    assert.strictEqual(out.exitCode, 3, JSON.stringify(out));
    assert.match(out.logs.map((l) => l.m).join('\n'), /cannot bind the override to an account.*identity is unknown|identity unknown/i, JSON.stringify(out));
    assert.strictEqual(out.grantFileExists, false, 'no grant file may be written on refusal: ' + JSON.stringify(out));
    assert.strictEqual(out.stateFileExists, false, 'no state file may be touched on refusal (no resume/lock attempt at all): ' + JSON.stringify(out));
  });
  t5('on_expired — U02: override-on REFUSES when the resolved expiry is already in the past, BEFORE any write — no grant file, no state change', () => {
    const identityFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-u02-expired-identity-')), '.claude.json');
    fs.writeFileSync(identityFile, JSON.stringify({ oauthAccount: { accountUuid: 'u02-expired-account-uuid', organizationUuid: 'u02-org' } }));
    const out = runOverrideOnRefusalProbe('"--until", "2020-01-01T00:00:00.000Z"', { FORGE_USAGE_GUARD_IDENTITY: identityFile });
    assert.ok(!out.uncaught, JSON.stringify(out));
    assert.strictEqual(out.exitCode, 3, JSON.stringify(out));
    assert.match(out.logs.map((l) => l.m).join('\n'), /not in the future/i, JSON.stringify(out));
    assert.strictEqual(out.grantFileExists, false, 'no grant file may be written on refusal: ' + JSON.stringify(out));
    assert.strictEqual(out.stateFileExists, false, 'no state file may be touched on refusal: ' + JSON.stringify(out));
  });
  t5('on_valid — U02 counterweight: a KNOWN identity and a future expiry are NOT refused by the new validation — the positive case is not accidentally broken', () => {
    const identityFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-u02-valid-identity-')), '.claude.json');
    fs.writeFileSync(identityFile, JSON.stringify({ oauthAccount: { accountUuid: 'u02-valid-account-uuid', organizationUuid: 'u02-org' } }));
    const out = runOverrideOnRefusalProbe(null, { FORGE_USAGE_GUARD_IDENTITY: identityFile });
    assert.ok(!out.uncaught, JSON.stringify(out));
    assert.strictEqual(out.exitCode, 0, JSON.stringify(out));
    assert.strictEqual(out.grantActive, true, JSON.stringify(out));
  });

  // ---- Finding 5 (2026-09-24, Codex p12 wave 7): an explicit --until beyond the 30-day maximum is clamped
  // down, and override-on says so on stdout — Finding 3 (2026-09-24, Codex p13 out-p13): this is an
  // informational notice about a SUCCESSFUL grant, never an error, so it must land on stdout (console.log),
  // not stderr — the prior placement contradicted this file's own documented claim. ----
  t5('Finding 5: override-on with a --until far beyond 30 days is CLAMPED to the maximum, and prints a clamp note on STDOUT (never stderr)', () => {
    const identityFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-clamp-identity-')), '.claude.json');
    fs.writeFileSync(identityFile, JSON.stringify({ oauthAccount: { accountUuid: 'clamp-account-uuid', organizationUuid: 'clamp-org' } }));
    const farFuture = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000).toISOString();
    const out = runOverrideOnRefusalProbe('"--until", ' + JSON.stringify(farFuture), { FORGE_USAGE_GUARD_IDENTITY: identityFile });
    assert.ok(!out.uncaught, JSON.stringify(out));
    assert.strictEqual(out.exitCode, 0, JSON.stringify(out));
    assert.strictEqual(out.grantActive, true, JSON.stringify(out));
    const text = out.logs.map((l) => l.m).join('\n');
    assert.match(text, /clamped/i, 'must tell the owner the requested --until was clamped: ' + text);
    assert.ok(!text.includes(farFuture), 'must not have granted the unbounded window verbatim: ' + text);
    const clampLine = out.logs.find((l) => /clamped/i.test(l.m));
    assert.ok(clampLine, 'the clamp note must actually be present in the captured logs: ' + JSON.stringify(out));
    assert.strictEqual(clampLine.level, 'log', 'Finding 3: the clamp note is an informational notice about a SUCCESSFUL grant, not an error — it must print via console.log (stdout), never console.error (stderr): ' + JSON.stringify(out));
  });

  // ---- U01 (2026-09-24, Codex p12 wave 7): a NON-fencing exception thrown by POST-MUTATION bookkeeping (a
  // resume call, or a writeState failure that is not the expected EFENCED reclaim signal) must never escape
  // uncaught past the point where the already-succeeded grant outcome gets reported — reported honestly via
  // describeOverrideLockOutcome's "cache lagging" wording, exit 0 either way (the grant itself DID succeed). ----
  t5('on_cache — U01: a thrown, non-EFENCED writeState failure inside override-on\'s bookkeeping is caught and reported as "override active, cache lagging", exit 0, and the grant is genuinely active', () => {
    const identityFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-u01-on-identity-')), '.claude.json');
    fs.writeFileSync(identityFile, JSON.stringify({ oauthAccount: { accountUuid: 'u01-on-account-uuid', organizationUuid: 'u01-org' } }));
    const out = runV15OverrideProbe([
      "'use strict';",
      'const fs = require("fs"); const path = require("path");',
      'process.argv = [process.execPath, "usage-guard.cjs", "override-on", "--owner-approval", "U01-TEST-TOKEN", "--reason", "u01 on cache test"];',
      'const G = require(' + JSON.stringify(path.join(__dirname, 'usage-guard.cjs')) + ');',
      'const Grant = require(' + JSON.stringify(path.join(__dirname, 'forge-ownergrant.cjs')) + ');',
      'const grantRoot = fs.mkdtempSync(path.join(require("os").tmpdir(), "guard-u01-on-scratch-"));',
      'G.__setOwnerGrantRootForTests(grantRoot);',
      'fs.mkdirSync(path.join(grantRoot, ".claude", "config"), { recursive: true });',
      'fs.writeFileSync(path.join(grantRoot, ".claude", "config", "forge-owner-grant.txt"), "U01-TEST-TOKEN\\n");',
      // inject a NON-EFENCED throw from inside the bookkeeping transaction — a plain, ordinary write failure
      // (EIO-shaped, never {code:"EFENCED"}), which must NOT be confused with a benign reclaim signal.
      'const realWriteFileSync = fs.writeFileSync;',
      'let injected = false;',
      'fs.writeFileSync = function (p, ...rest) {',
      '  if (!injected && typeof p === "string" && p.indexOf(process.env.FORGE_USAGE_GUARD_STATE + ".") === 0 && p.endsWith(".tmp")) { injected = true; const e = new Error("EIO simulated (non-EFENCED)"); e.code = "EIO"; throw e; }',
      '  return realWriteFileSync.call(fs, p, ...rest);',
      '};',
      'class ExitSignal { constructor(c) { this.code = c; } }',
      'const realExit = process.exit.bind(process);',
      'process.exit = (c) => { throw new ExitSignal(c); };',
      'const logs = []; const realErr = console.error, realLog = console.log;',
      'console.error = (m) => logs.push({ level: "error", m: String(m) });',
      'console.log = (m) => logs.push({ level: "log", m: String(m) });',
      '(async () => {',
      '  let exitCode = null;',
      '  try { await G.runOverrideOn(); } catch (e) { if (e instanceof ExitSignal) exitCode = e.code; else throw e; }',
      '  fs.writeFileSync = realWriteFileSync;',
      '  console.error = realErr; console.log = realLog;',
      '  const grantAfter = Grant.readOverrideGrant({ projectRoot: grantRoot });',
      '  process.stdout.write(JSON.stringify({ exitCode, logs, grantActive: grantAfter.active, injected }));',
      '  realExit(0);',
      '})().catch((e) => { process.stdout.write(JSON.stringify({ uncaught: String((e && e.message) || e) })); realExit(1); });',
    ], { FORGE_USAGE_GUARD_IDENTITY: identityFile });
    assert.ok(!out.uncaught, 'the exception must be caught — never an uncaught rejection: ' + JSON.stringify(out));
    assert.strictEqual(out.injected, true, 'the injected failure must actually have fired: ' + JSON.stringify(out));
    assert.strictEqual(out.grantActive, true, 'the authoritative grant must be genuinely active despite the bookkeeping throw: ' + JSON.stringify(out));
    assert.strictEqual(out.exitCode, 0, 'the grant DID succeed — this must exit 0: ' + JSON.stringify(out));
    const text = out.logs.map((l) => l.m).join('\n');
    assert.match(text, /override active, cache lagging/i, JSON.stringify(out));
    assert.match(text, /EIO simulated/, 'must name the actual bookkeeping error: ' + text);
  });
  t5('off_cache — U01: a thrown, non-EFENCED writeState failure inside override-off\'s bookkeeping is caught and reported as "protection re-armed, cache lagging", exit 0, and the grant is genuinely cleared', () => {
    const out = runV15OverrideProbe([
      "'use strict';",
      'const fs = require("fs"); const path = require("path");',
      'process.argv = [process.execPath, "usage-guard.cjs", "override-off"];',
      'const G = require(' + JSON.stringify(path.join(__dirname, 'usage-guard.cjs')) + ');',
      'const Grant = require(' + JSON.stringify(path.join(__dirname, 'forge-ownergrant.cjs')) + ');',
      'const grantRoot = fs.mkdtempSync(path.join(require("os").tmpdir(), "guard-u01-off-scratch-"));',
      'G.__setOwnerGrantRootForTests(grantRoot);',
      // a real, active grant exists — override-off must clear it regardless of the injected bookkeeping throw.
      'Grant.writeOverrideGrant({ active: true, at: new Date().toISOString(), until: new Date(Date.now()+3600000).toISOString(), reason: "pre-existing", accountLabel: "u01-off-account" }, { projectRoot: grantRoot });',
      'const realWriteFileSync = fs.writeFileSync;',
      'let injected = false;',
      'fs.writeFileSync = function (p, ...rest) {',
      '  if (!injected && typeof p === "string" && p.indexOf(process.env.FORGE_USAGE_GUARD_STATE + ".") === 0 && p.endsWith(".tmp")) { injected = true; const e = new Error("EIO simulated (non-EFENCED)"); e.code = "EIO"; throw e; }',
      '  return realWriteFileSync.call(fs, p, ...rest);',
      '};',
      'class ExitSignal { constructor(c) { this.code = c; } }',
      'const realExit = process.exit.bind(process);',
      'process.exit = (c) => { throw new ExitSignal(c); };',
      'const logs = []; const realErr = console.error, realLog = console.log;',
      'console.error = (m) => logs.push({ level: "error", m: String(m) });',
      'console.log = (m) => logs.push({ level: "log", m: String(m) });',
      '(async () => {',
      '  let exitCode = null;',
      '  try { await G.runOverrideOff(); } catch (e) { if (e instanceof ExitSignal) exitCode = e.code; else throw e; }',
      '  fs.writeFileSync = realWriteFileSync;',
      '  console.error = realErr; console.log = realLog;',
      '  const grantAfter = Grant.readOverrideGrant({ projectRoot: grantRoot });',
      '  process.stdout.write(JSON.stringify({ exitCode, logs, grantActive: grantAfter.active, injected }));',
      '  realExit(0);',
      '})().catch((e) => { process.stdout.write(JSON.stringify({ uncaught: String((e && e.message) || e) })); realExit(1); });',
    ]);
    assert.ok(!out.uncaught, 'the exception must be caught — never an uncaught rejection: ' + JSON.stringify(out));
    assert.strictEqual(out.injected, true, 'the injected failure must actually have fired: ' + JSON.stringify(out));
    assert.strictEqual(out.grantActive, false, 'the authoritative grant must be genuinely cleared despite the bookkeeping throw: ' + JSON.stringify(out));
    assert.strictEqual(out.exitCode, 0, 'protection IS re-armed — this must exit 0: ' + JSON.stringify(out));
    const text = out.logs.map((l) => l.m).join('\n');
    assert.match(text, /protection re-armed, cache lagging/i, JSON.stringify(out));
    assert.match(text, /EIO simulated/, 'must name the actual bookkeeping error: ' + text);
  });

  // ---- GUARD-OFF-BYPASS (Codex recheck wp-f4, 2026-09-24): with usage-guard OFF, no command path may
  // read the login token or contact the network/Paperclip — enforced at the SAME two choke points
  // (fetchUsage/pc) every caller (check/status/credits/watch --once/tick/doPause/doResume/override-on)
  // shares. --force is the one documented CLI exception.
  //
  // Both tests below spawn an isolated SUBPROCESS (matching nvidia-provider.test.cjs's own fetch-spy
  // convention, and this file's own runGuard()/H3.2b pattern) rather than monkey-patching the shared
  // `global.fetch`/`process.env` of THIS test process in an async test body — the async test() wrapper
  // queues promise-returning bodies rather than running them to completion immediately (see the H6
  // GUARD-CORRUPT section's own comment on this), so two such bodies genuinely interleave and a global
  // mutation in one is visible to the other. A real subprocess has its own process-wide state, so this
  // hazard cannot occur no matter how the two tests interleave.
  function spawnGuardProbe(env, scriptLines) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-probe-'));
    const script = path.join(dir, 'probe.cjs');
    fs.writeFileSync(script, scriptLines.join('\n'), 'utf8');
    const r = require('child_process').spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 30000, env });
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    try { return JSON.parse(r.stdout); } catch { return { parseError: (r.stdout || '') + (r.stderr || '') }; }
  }
  t5('GUARD-OFF-BYPASS: fetchUsage()/pc() refuse when the switch is off (guardNetworkAllowed is the shared gate)', () => {
    const sb = sandbox5({ 'usage-guard': val(false) });
    fs.writeFileSync(credFile(sb), JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-VALIDSHAPEDTOKEN1234567890' } }));
    const out = spawnGuardProbe(sb.env, [
      "'use strict';",
      'const G = require(' + JSON.stringify(path.join(__dirname, 'usage-guard.cjs')) + ');',
      '(async () => {',
      '  const gate = G.guardNetworkAllowed({});',
      '  let fetchErr = null; try { await G.fetchUsage(); } catch (e) { fetchErr = e.message; }',
      '  const pcResult = await G.pc("GET", "/api/companies");',
      '  process.stdout.write(JSON.stringify({ gateOk: gate.ok, fetchErr, pcStatus: pcResult.status, pcBlocked: pcResult.blocked }));',
      '})().catch((e) => { process.stdout.write(JSON.stringify({ uncaught: String((e && e.message) || e) })); process.exitCode = 1; });',
    ]);
    assert.strictEqual(out.gateOk, false, JSON.stringify(out));
    assert.ok(/usage-guard staat uit|usage guard is switched off/.test(out.fetchErr || ''), JSON.stringify(out));
    assert.strictEqual(out.pcStatus, 0, JSON.stringify(out));
    assert.strictEqual(out.pcBlocked, true, JSON.stringify(out));
  });
  t5('GUARD-OFF-BYPASS: fetchUsage({force:true}) genuinely proceeds past the off-switch gate (verified via a fetch spy in an isolated subprocess — no real network)', () => {
    const sb = sandbox5({ 'usage-guard': val(false) });
    fs.writeFileSync(credFile(sb), JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-VALIDSHAPEDTOKEN1234567890' } }));
    const out = spawnGuardProbe(sb.env, [
      "'use strict';",
      'let calls = 0;',
      'global.fetch = async () => { calls++; return { ok: true, status: 200, json: async () => ({ five_hour: { utilization: 5 }, seven_day: { utilization: 5 } }) }; };',
      'const G = require(' + JSON.stringify(path.join(__dirname, 'usage-guard.cjs')) + ');',
      '(async () => {',
      '  let blockedErr = null; try { await G.fetchUsage(); } catch (e) { blockedErr = e.message; }',
      '  const blockedCalls = calls;',
      '  const u = await G.fetchUsage({ force: true });',
      '  process.stdout.write(JSON.stringify({ blockedErr, blockedCalls, forcedCalls: calls, forcedPct: u.session.pct }));',
      '})().catch((e) => { process.stdout.write(JSON.stringify({ uncaught: String((e && e.message) || e) })); process.exitCode = 1; });',
    ]);
    assert.ok(/usage-guard staat uit|usage guard is switched off/.test(out.blockedErr || ''), JSON.stringify(out));
    assert.strictEqual(out.blockedCalls, 0, 'no fetch happened before force was passed: ' + JSON.stringify(out));
    assert.strictEqual(out.forcedCalls, 1, 'force:true reaches the real request path: ' + JSON.stringify(out));
    assert.strictEqual(out.forcedPct, 5, JSON.stringify(out));
  });
  t5('GUARD-OFF-BYPASS: CLI check/status/credits refuse cleanly when usage-guard is off — a login file IS present, but never read', () => {
    const sb = sandbox5({ 'usage-guard': val(false) });
    fs.writeFileSync(credFile(sb), JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-VALIDSHAPEDTOKEN1234567890' } }));
    for (const argvCmd of [['check'], ['status'], ['credits']]) {
      const r = runGuard(argvCmd, sb.env);
      assert.strictEqual(r.status, 3, argvCmd.join(' ') + ': ' + (r.stdout || '') + (r.stderr || ''));
      assert.ok(/usage-guard staat uit|usage guard is switched off/.test(r.stdout || ''), argvCmd.join(' ') + ': ' + r.stdout);
      assert.ok(!/no OAuth token|REAL usage \(official endpoint\)|usage endpoint HTTP/.test(r.stdout || ''), argvCmd.join(' ') + ' must never have reached the token/network: ' + r.stdout);
    }
  });
  t5('GUARD-OFF-BYPASS: watch --once refuses cleanly when off, with no CHECK FAILED / no-OAuth-token noise (never reads the token)', () => {
    const sb = sandbox5({ 'usage-guard': val(false) });
    fs.writeFileSync(credFile(sb), JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-VALIDSHAPEDTOKEN1234567890' } }));
    const r = runGuard(['watch', '--once'], sb.env);
    const logText = readIf(sb.env.FORGE_USAGE_GUARD_LOG);
    assert.ok(/usage-guard staat uit|usage guard is switched off/.test(logText), logText || (r.stdout + r.stderr));
    assert.ok(!/no OAuth token|CHECK FAILED/.test(logText), 'watch --once must refuse before ever reading the token: ' + logText);
  });

  // ---- GUARD-TOKEN-ERROR (2026-09-24): a syntactically valid credentials file whose token is
  // structurally malformed (an embedded control character) must never reach fetch()'s Headers
  // construction — Node's own header validation would otherwise throw a TypeError quoting the token
  // verbatim. readToken() rejects it first, with a FIXED message that never echoes the token.
  t5('GUARD-TOKEN-ERROR: a control-character token is rejected BEFORE fetch(); state/log/stdout carry a FIXED message, never the token', () => {
    const sb = sandbox5(null);
    fs.writeFileSync(credFile(sb), JSON.stringify({ claudeAiOauth: { accessToken: 'SYNTHETIC-OAUTH\nINJECTED-SECRET-FRAGMENT' } }));
    const r = runGuard(['watch', '--once'], sb.env);
    const state = readIf(sb.env.FORGE_USAGE_GUARD_STATE);
    const logText = readIf(sb.env.FORGE_USAGE_GUARD_LOG);
    assert.ok(state.length > 0, 'the failed check was recorded: ' + (r.stdout || '') + (r.stderr || ''));
    assert.strictEqual(JSON.parse(state).lastError, 'OAuth token in the credentials file has an unexpected shape (rejected before use)');
    for (const [name, text] of [['state', state], ['log', logText], ['stdout', r.stdout || ''], ['stderr', r.stderr || '']]) {
      assert.ok(!/SYNTHETIC-OAUTH|INJECTED-SECRET-FRAGMENT/.test(text), name + ' must not carry any part of the malformed token: ' + text.slice(0, 300));
    }
  });

  // ---- GUARD-TOKEN-FINGERPRINT (2026-09-24): a credential-derived fingerprint (sha256 of
  // accountUuid+organizationUuid) must never reach a persisted artifact — readAccountIdentity() now
  // returns an OPAQUE LOCAL LABEL (via the local-only account-map file), never the raw fingerprint.
  function withIdentitySandbox(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-fp-'));
    const identityFile = path.join(dir, 'identity.json');
    const mapFile = path.join(dir, 'account-map.json');
    const saved = { FORGE_USAGE_GUARD_IDENTITY: process.env.FORGE_USAGE_GUARD_IDENTITY, FORGE_USAGE_GUARD_ACCOUNT_MAP: process.env.FORGE_USAGE_GUARD_ACCOUNT_MAP };
    process.env.FORGE_USAGE_GUARD_IDENTITY = identityFile;
    process.env.FORGE_USAGE_GUARD_ACCOUNT_MAP = mapFile;
    delete require.cache[require.resolve('./usage-guard.cjs')];
    const G8 = require('./usage-guard.cjs');
    try { return fn(G8, identityFile, mapFile); }
    finally {
      for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
      delete require.cache[require.resolve('./usage-guard.cjs')];
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  t5('GUARD-TOKEN-FINGERPRINT: readAccountIdentity() returns an OPAQUE LOCAL LABEL, never the raw sha256 fingerprint, and is STABLE across calls', () => {
    withIdentitySandbox((G8, identityFile, mapFile) => {
      fs.writeFileSync(identityFile, JSON.stringify({ oauthAccount: { accountUuid: 'aaaaaaaa-0000-0000-0000-000000000001', organizationUuid: 'org-1' } }));
      const id1 = G8.readAccountIdentity();
      assert.ok(id1.fp, 'an identity is derived');
      assert.ok(!/^[0-9a-f]{12}$/.test(id1.fp), 'the returned fp must not LOOK like the raw 12-hex-char sha256 fingerprint: ' + id1.fp);
      const rawFp = G8.fingerprintAccount({ accountUuid: 'aaaaaaaa-0000-0000-0000-000000000001', organizationUuid: 'org-1' }).fp;
      assert.ok(!id1.fp.includes(rawFp), 'the label must not embed the raw fingerprint');
      const id2 = G8.readAccountIdentity();
      assert.strictEqual(id2.fp, id1.fp, 'the SAME identity maps to the SAME label across calls (persisted local mapping)');
      // the raw fingerprint is allowed to live ONLY in the local, purpose-built mapping file (never
      // synced/dashboarded/published — see usage-guard-redact.cjs's own header).
      assert.ok(fs.readFileSync(mapFile, 'utf8').includes(rawFp));
    });
  });
  t5('GUARD-TOKEN-FINGERPRINT: two DIFFERENT account identities map to two DIFFERENT labels', () => {
    withIdentitySandbox((G8, identityFile) => {
      fs.writeFileSync(identityFile, JSON.stringify({ oauthAccount: { accountUuid: 'aaaaaaaa-0000-0000-0000-000000000001' } }));
      const idA = G8.readAccountIdentity();
      fs.writeFileSync(identityFile, JSON.stringify({ oauthAccount: { accountUuid: 'bbbbbbbb-0000-0000-0000-000000000002' } }));
      const idB = G8.readAccountIdentity();
      assert.notStrictEqual(idA.fp, idB.fp);
    });
  });
  t5('GUARD-TOKEN-FINGERPRINT: without the profile file, identity is honestly "unknown" — the removed refresh-token fallback never fires (a refresh token is never hashed for identity)', () => {
    const sb = sandbox5(null);
    fs.writeFileSync(credFile(sb), JSON.stringify({ claudeAiOauth: { refreshToken: 'SYNTHETIC-REFRESH-TOKEN-SHOULD-NEVER-BE-HASHED-FOR-IDENTITY' } }));
    const savedEnv = {};
    for (const k of Object.keys(sb.env)) { savedEnv[k] = process.env[k]; process.env[k] = sb.env[k]; }
    delete require.cache[require.resolve('./usage-guard.cjs')];
    const G9 = require('./usage-guard.cjs');
    try {
      const id = G9.readAccountIdentity();
      assert.strictEqual(id.fp, null);
      assert.strictEqual(id.source, 'unknown');
    } finally {
      for (const k of Object.keys(savedEnv)) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
      delete require.cache[require.resolve('./usage-guard.cjs')];
    }
  });

  // ---- GUARD-BODY-TIMEOUT (2026-09-24): the abort deadline must cover body consumption (r.json()), not
  // just the initial fetch() — a response whose headers resolve instantly but whose body stalls must
  // still be aborted at the deadline. Uses FORGE_USAGE_GUARD_FETCH_TIMEOUT_MS (a test-only override,
  // mirroring the existing FORGE_USAGE_GUARD_CLAIM_TIMEOUT_MS seam) so this is provable with a real,
  // short, bounded wait instead of the real 30s.
  t5('GUARD-BODY-TIMEOUT: a response that resolves its headers but stalls its body is aborted at the deadline, not left hanging', () => {
    const sb = sandbox5(null);
    fs.writeFileSync(credFile(sb), JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-VALIDSHAPEDTOKEN1234567890' } }));
    const env = Object.assign({}, sb.env, { FORGE_USAGE_GUARD_FETCH_TIMEOUT_MS: '300' });
    const start = Date.now();
    const out = spawnGuardProbe(env, [
      "'use strict';",
      // headers resolve immediately; the body NEVER completes on its own — only the deadline's abort
      // signal can ever settle this promise. If GUARD-BODY-TIMEOUT regressed (clearTimeout back in an
      // inner finally right after fetch() resolves), this promise would hang forever and the child
      // process would be killed by the spawnSync timeout instead of exiting quickly on its own.
      'global.fetch = async (url, init) => ({ ok: true, status: 200, json: () => new Promise((resolve, reject) => {',
      '  if (init.signal.aborted) return reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));',
      '  init.signal.addEventListener("abort", () => reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" })), { once: true });',
      '}) });',
      'const G = require(' + JSON.stringify(path.join(__dirname, 'usage-guard.cjs')) + ');',
      '(async () => {',
      '  let err = null; try { await G.fetchUsage(); } catch (e) { err = e.message; }',
      '  process.stdout.write(JSON.stringify({ err }));',
      '})().catch((e) => { process.stdout.write(JSON.stringify({ uncaught: String((e && e.message) || e) })); process.exitCode = 1; });',
    ]);
    assert.ok(Date.now() - start < 10000, 'the abort must fire close to the short override deadline, not hang the whole subprocess');
    assert.match(out.err || '', /usage endpoint timed out after 0s \(response body never completed\)/, JSON.stringify(out));
  });

  // ---- GUARD-STATE-RACE (Codex recheck wp-f4, 2026-09-24): doPause()/doResume() must read
  // ownerOverride/credits FRESH at write-time (inside the state lock), never from a snapshot captured
  // before their own async Paperclip work — otherwise a concurrent override-off clearing the override
  // mid-pause-round is silently reverted the moment the stale pause finally writes.
  t5('GUARD-STATE-RACE: doPause() honors an ownerOverride cleared WHILE it is mid-flight, instead of reviving it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-race-'));
    const stateFile = path.join(dir, 'state.json');
    const saved = process.env.FORGE_USAGE_GUARD_STATE;
    process.env.FORGE_USAGE_GUARD_STATE = stateFile;
    delete require.cache[require.resolve('./usage-guard.cjs')];
    const G11 = require('./usage-guard.cjs');
    try {
      fs.writeFileSync(stateFile, JSON.stringify({ mode: 'ok', ownerOverride: { active: true, at: new Date().toISOString(), reason: 'test' } }));
      const u = { session: { pct: 99, resetsAt: null }, week: { pct: 10, resetsAt: null } };
      const crossed = [{ id: 'session|session|session', name: 'session', metric: 'session', pct: 99, resetsAt: null }];
      // doPause() is called but NOT yet awaited: its first real work (allAgents() -> pc() -> a real
      // fetch() to an unreachable loopback Paperclip) is genuine async I/O, so none of its continuations
      // can run until this synchronous block below finishes and the event loop is given a chance —
      // meaning the state mutation below is GUARANTEED to land before doPause() ever reads the state for
      // its write, deterministically reproducing "a concurrent clear happened mid-pause-round" without
      // relying on real timing.
      const pausePromise = G11.doPause(u, crossed, { fp: null, source: 'unknown' });
      const midFlight = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      delete midFlight.ownerOverride;
      fs.writeFileSync(stateFile, JSON.stringify(midFlight));
      await pausePromise;
      const final = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      assert.strictEqual(final.ownerOverride, undefined, 'a concurrently-cleared override must not be silently restored: ' + JSON.stringify(final));
      assert.strictEqual(final.mode, 'paused');
    } finally {
      if (saved === undefined) delete process.env.FORGE_USAGE_GUARD_STATE; else process.env.FORGE_USAGE_GUARD_STATE = saved;
      delete require.cache[require.resolve('./usage-guard.cjs')];
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  t5('GUARD-STATE-RACE: an ownerOverride SET while doPause() is mid-flight (the mirror case) still survives — the fresh read is not one-directional', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-race2-'));
    const stateFile = path.join(dir, 'state.json');
    const saved = process.env.FORGE_USAGE_GUARD_STATE;
    process.env.FORGE_USAGE_GUARD_STATE = stateFile;
    delete require.cache[require.resolve('./usage-guard.cjs')];
    const G12 = require('./usage-guard.cjs');
    try {
      fs.writeFileSync(stateFile, JSON.stringify({ mode: 'ok' }));
      const u = { session: { pct: 99, resetsAt: null }, week: { pct: 10, resetsAt: null } };
      const crossed = [{ id: 'session|session|session', name: 'session', metric: 'session', pct: 99, resetsAt: null }];
      const pausePromise = G12.doPause(u, crossed, { fp: null, source: 'unknown' });
      const midFlight = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      midFlight.ownerOverride = { active: true, at: new Date().toISOString(), reason: 'set mid-flight' };
      fs.writeFileSync(stateFile, JSON.stringify(midFlight));
      await pausePromise;
      const final = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      assert.strictEqual(final.ownerOverride && final.ownerOverride.reason, 'set mid-flight');
    } finally {
      if (saved === undefined) delete process.env.FORGE_USAGE_GUARD_STATE; else process.env.FORGE_USAGE_GUARD_STATE = saved;
      delete require.cache[require.resolve('./usage-guard.cjs')];
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ---- V14 (Codex recheck wp-f4, 2026-09-24): a PERSISTENTLY FAILING account-map (resolveLocalAccountLabel
  // can neither read nor persist a label) must never mint a fresh random label per call — tick() reads
  // identity TWICE per check (identBefore/ident) and treats ANY change as a "mid-check account switch",
  // discarding the measurement. Repeated 100% ticks under such a failure must still PAUSE exactly once and
  // then correctly recognise "still paused, still high" on every following tick — never flap or discard.
  function tickV14Scenario(mapFileFor, label) {
    t5('V14: repeated 100% ticks under a persistently-failing account-map (' + label + ') still PAUSE (pauses:1, stateMode:\'paused\')', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-v14tick-'));
      const identityFile = path.join(dir, 'identity.json');
      fs.writeFileSync(identityFile, JSON.stringify({ oauthAccount: { accountUuid: 'v14-tick-uuid-0000', organizationUuid: 'org-v14' } }));
      const mapFile = mapFileFor(dir);
      const stateFile = path.join(dir, 'state.json');
      const saved = {
        FORGE_USAGE_GUARD_IDENTITY: process.env.FORGE_USAGE_GUARD_IDENTITY,
        FORGE_USAGE_GUARD_ACCOUNT_MAP: process.env.FORGE_USAGE_GUARD_ACCOUNT_MAP,
        FORGE_USAGE_GUARD_STATE: process.env.FORGE_USAGE_GUARD_STATE,
      };
      process.env.FORGE_USAGE_GUARD_IDENTITY = identityFile;
      process.env.FORGE_USAGE_GUARD_ACCOUNT_MAP = mapFile;
      process.env.FORGE_USAGE_GUARD_STATE = stateFile;
      delete require.cache[require.resolve('./usage-guard.cjs')];
      const G14 = require('./usage-guard.cjs');
      try {
        const usage100 = {
          session: { pct: 100, resetsAt: null }, week: { pct: 100, resetsAt: null },
          windows: G14.normalizeWindows({ limits: [{ kind: 'session', group: 'session', percent: 100, resets_at: null }] }),
          credits: { present: false }, credentialFp: null,
        };
        let pauseCalls = 0;
        const realDoPause = G14.doPause;
        for (let i = 0; i < 3; i++) {
          await G14.tick({ fetchUsage: async () => usage100, doPause: async (...a) => { pauseCalls++; return realDoPause(...a); }, log: () => {} });
        }
        assert.strictEqual(pauseCalls, 1, 'every one of the 3 ticks must reach the real pause/stay-paused decision, never bail out on a false mid-check account switch (identity churn): pauseCalls=' + pauseCalls);
        const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        assert.strictEqual(st.mode, 'paused', 'the persisted state must genuinely be paused: ' + JSON.stringify(st));
      } finally {
        for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
        delete require.cache[require.resolve('./usage-guard.cjs')];
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }
  // Scenario A: the map's parent directory does not exist — every read AND write attempt fails (ENOENT).
  tickV14Scenario((dir) => path.join(dir, 'does-not-exist', 'account-map.json'), 'read+write failure, missing parent dir');
  // Scenario B: the map path IS a directory — read fails (EISDIR) and the publishing rename fails too
  // (the tmp file writes fine into the parent, but rename(tmp -> mapFile) cannot replace a directory).
  tickV14Scenario((dir) => { const p = path.join(dir, 'account-map.json'); fs.mkdirSync(p); return p; }, 'read+rename failure, map path is a directory');

  // ---- V15 (Codex recheck wp-f4, 2026-09-24): withStateLock is now FAIL-CLOSED — a lock that cannot be
  // acquired within the bounded wait REFUSES the transaction (fn() never runs) instead of the old "run it
  // unlocked after ~2s" behaviour, which let a slow/blocked writer overwrite a concurrent writer's change.
  function withIsolatedGuard(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-v15-'));
    const stateFile = path.join(dir, 'state.json');
    const saved = { FORGE_USAGE_GUARD_STATE: process.env.FORGE_USAGE_GUARD_STATE, FORGE_USAGE_GUARD_STATE_LOCK_WAIT_MS: process.env.FORGE_USAGE_GUARD_STATE_LOCK_WAIT_MS };
    process.env.FORGE_USAGE_GUARD_STATE = stateFile;
    process.env.FORGE_USAGE_GUARD_STATE_LOCK_WAIT_MS = '150'; // short, deterministic budget instead of the real 2000ms
    delete require.cache[require.resolve('./usage-guard.cjs')];
    const G15 = require('./usage-guard.cjs');
    return (async () => {
      try { return await fn(G15, stateFile); }
      finally {
        for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
        delete require.cache[require.resolve('./usage-guard.cjs')];
        fs.rmSync(dir, { recursive: true, force: true });
      }
    })();
  }
  t5('V15: withStateLock REFUSES a transaction that cannot acquire the lock within the bounded wait — never runs it unlocked (reproduces Codex\'s exact ordering: an override transaction held past the wait budget while another clears it must never cause a stale restoration)', () =>
    withIsolatedGuard(async (G15, stateFile) => {
      fs.writeFileSync(stateFile, JSON.stringify({ mode: 'ok', ownerOverride: { active: true, reason: 'initial' } }));
      let releaseSlowWriter;
      const slowWriterDone = new Promise((res) => { releaseSlowWriter = res; });
      // Writer A: acquires the lock and holds it OPEN well past the (shortened) 150ms wait budget, then
      // writes an override — reproducing "an override transaction held > the wait budget".
      const writerA = G15.withStateLock(async () => {
        await slowWriterDone;
        const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        st.ownerOverride = { active: true, reason: 'writer A (slow holder)' };
        fs.writeFileSync(stateFile, JSON.stringify(st));
        return 'A-done';
      });
      await new Promise((res) => setTimeout(res, 300)); // well past the 150ms budget — A still holds the lock
      // Writer B: attempts to CLEAR the override while A still holds the lock — must be REFUSED, never run unlocked.
      let bRan = false;
      const resultB = await G15.withStateLock(() => { bRan = true; const st = JSON.parse(fs.readFileSync(stateFile, 'utf8')); delete st.ownerOverride; fs.writeFileSync(stateFile, JSON.stringify(st)); });
      assert.strictEqual(resultB.ok, false, 'writer B must be REFUSED while A still holds the lock past the budget: ' + JSON.stringify(resultB));
      assert.strictEqual(resultB.reason, 'lock-timeout');
      assert.strictEqual(bRan, false, 'writer B\'s transaction must never have RUN — a refusal must never execute fn() unlocked');
      releaseSlowWriter();
      const resultA = await writerA;
      assert.strictEqual(resultA.ok, true, JSON.stringify(resultA));
      assert.strictEqual(resultA.value, 'A-done');
      const final = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      assert.strictEqual(final.ownerOverride.reason, 'writer A (slow holder)', 'no stale restoration: B never wrote, so A\'s own write is exactly what survives — ' + JSON.stringify(final));
      // Once A releases the lock, a RETRIED clear succeeds normally — fail-closed is temporary, not permanent.
      const resultC = await G15.withStateLock(() => { const st = JSON.parse(fs.readFileSync(stateFile, 'utf8')); delete st.ownerOverride; fs.writeFileSync(stateFile, JSON.stringify(st)); });
      assert.strictEqual(resultC.ok, true, JSON.stringify(resultC));
      assert.strictEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')).ownerOverride, undefined);
    }));
  t5('V15: the NORMAL tick "ok" write also goes through the (now fail-closed) state lock — a busy lock is refused and honestly logged, never written unlocked', () =>
    withIsolatedGuard(async (G15b, stateFile) => {
      fs.writeFileSync(stateFile + '.lock', ''); // simulate ANOTHER writer already holding the state lock
      let writeStateCalls = 0;
      const usage = usageWith(10); // low usage — takes the "normal ok write" branch, never pause/resume
      const calls = { logs: [] };
      try {
        await G15b.tick({
          fetchUsage: async () => usage,
          readIdentity: () => ({ fp: null, source: 'unknown' }),
          readCredentialFp: () => null,
          writePressureFile: () => {},
          readState: () => ({ mode: 'ok' }),
          writeState: (s) => { writeStateCalls++; return s; },
          doPause: async () => { throw new Error('must not pause at 10%'); },
          doResume: async () => { throw new Error('must not resume — not paused'); },
          log: (m) => calls.logs.push(m),
        });
        assert.strictEqual(writeStateCalls, 0, 'the write must never run while the lock is held by someone else');
        assert.ok(calls.logs.some((m) => /state-lock: normal ok write.*lock-timeout/.test(m)), 'a clear refusal must be logged: ' + JSON.stringify(calls.logs));
      } finally { try { fs.unlinkSync(stateFile + '.lock'); } catch { /* best effort */ } }
    }));
  t5('V18 DECISION (Codex recheck wp-f4): --force on check/status/credits is a plain CLI exception, NOT gated by forge-ownergrant.cjs — pinned so a future change must deliberately revisit this contract rather than silently drift either way', () => {
    assert.strictEqual(G5.guardNetworkAllowed({ force: true }).ok, true, '--force must proceed without any owner-grant check');
    const src = fs.readFileSync(path.join(__dirname, 'usage-guard.cjs'), 'utf8');
    assert.ok(/V18 DECISION/.test(src), 'the --force vs owner-grant decision must be documented in the source, not left implicit');
    assert.ok(!/o\.force === true[\s\S]{0,120}verifyOwnerGrant/.test(src), '--force must not be silently wired to the owner-grant check');
  });

  // ---- V29 (Codex recheck wp-f4, 2026-09-24): SIGTERM cancellation must propagate through Paperclip
  // operations too, not only the usage-endpoint fetch — pc()/allAgents()/doPause()/doResume() all thread
  // an external AbortSignal now. Per this project's own lesson (a real POSIX SIGTERM cannot be proven
  // end-to-end via process.kill() on Windows — no real signal delivery), this verifies the cancellable
  // mechanism DIRECTLY and deterministically: a fetch-spy aborts the shared signal as a side effect of the
  // FIRST pause request, so whether the second agent's request fires is a real, non-timing-dependent fact.
  t5('V29: pc()/doPause() honor a shutdown signal — an already-aborted signal refuses immediately (no fetch at all), and no SUBSEQUENT Paperclip request is issued once shutdown begins mid-round', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-v29-'));
    const script = path.join(dir, 'probe.cjs');
    fs.writeFileSync(script, [
      "'use strict';",
      'const calls = [];',
      'const ac = new AbortController();',
      'global.fetch = async (url, init) => {',
      '  const u = String(url);',
      '  calls.push({ url: u, method: (init && init.method) || "GET" });',
      '  if (/\\/api\\/companies$/.test(u)) return { ok: true, status: 200, json: async () => [{ id: "c1", name: "Co" }] };',
      '  if (/\\/api\\/companies\\/c1\\/agents$/.test(u)) return { ok: true, status: 200, json: async () => [{ id: "a1", name: "Agent1", status: "running" }, { id: "a2", name: "Agent2", status: "running" }] };',
      '  if (/\\/pause$/.test(u)) { ac.abort(); return { ok: true, status: 200, json: async () => ({}) }; }', // shutdown begins DURING a1's own pause request
      '  return { ok: true, status: 200, json: async () => ({}) };',
      '};',
      'const G = require(' + JSON.stringify(path.join(__dirname, 'usage-guard.cjs')) + ');',
      '(async () => {',
      '  const preAborted = new AbortController(); preAborted.abort();',
      '  const preResult = await G.pc("GET", "/api/companies", undefined, { signal: preAborted.signal });',
      '  const callsBeforePause = calls.length;',
      '  const u = { session: { pct: 99, resetsAt: null }, week: { pct: 10, resetsAt: null } };',
      '  const crossed = [{ id: "session|session|session", name: "session", metric: "session", pct: 99, resetsAt: null }];',
      '  await G.doPause(u, crossed, { fp: null, source: "unknown" }, { signal: ac.signal });',
      '  const pauseCalls = calls.filter((c) => /\\/pause$/.test(c.url)).length;',
      '  process.stdout.write(JSON.stringify({ preAbortedStatus: preResult.status, preAbortedRan: callsBeforePause, pauseCalls }));',
      '})().catch((e) => { process.stdout.write(JSON.stringify({ uncaught: String((e && e.message) || e) })); process.exitCode = 1; });',
    ].join('\n'), 'utf8');
    const env = Object.assign({}, process.env, {
      FORGE_USAGE_GUARD_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'guard-v29-home-')),
      FORGE_CONFIG_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'guard-v29-cfghome-')),
      FORGE_PROJECT_ROOT: fs.mkdtempSync(path.join(os.tmpdir(), 'guard-v29-proj-')),
      NVIDIA_SKIP_ENV_FILES: '1',
    });
    // TEST-ISOLATION (2026-09-24): an EARLIER test's own env override (FORGE_USAGE_GUARD_STATE_LOCK_WAIT_MS,
    // set synchronously by a still-pending async test body — see this project's own "async test bodies
    // genuinely interleave" lesson) can otherwise leak into this snapshot of process.env; this probe's
    // state lock is never contended, so force the real default rather than inherit an ambient override.
    delete env.FORGE_USAGE_GUARD_STATE_LOCK_WAIT_MS;
    const r = require('child_process').spawnSync(process.execPath, [script], { encoding: 'utf8', env, timeout: 30000 });
    // usage-guard.cjs's own log() also writes plain console.log lines to this SAME stdout — the probe's
    // JSON result is always the LAST line it writes (no trailing newline of its own).
    const lastLine = (r.stdout || '').trim().split('\n').pop();
    let out; try { out = JSON.parse(lastLine); } catch { out = { parseError: (r.stdout || '') + (r.stderr || '') }; }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    assert.strictEqual(out.preAbortedStatus, 0, 'an already-aborted signal must refuse pc() immediately: ' + JSON.stringify(out));
    assert.strictEqual(out.preAbortedRan, 0, 'an already-aborted signal must never reach fetch(): ' + JSON.stringify(out));
    assert.strictEqual(out.pauseCalls, 1, 'exactly ONE pause request may happen (agent a1) — a2\'s must never fire once shutdown began mid-round: ' + JSON.stringify(out));
  });

  // ---- V29, second Codex recheck (2026-09-24): an interrupted pause round (a1 paused, a2 never attempted
  // because shutdown began) must persist the UNFINISHED work and retry it on the very next 100%-usage tick
  // — never take the "still high, wait" branch while a2 remains genuinely unpaused. Codex's exact schedule:
  // interrupt after pausing A of two agents, restart with a fresh signal, the next tick must pause B.
  t5('V29: an interrupted pause round retries the unfinished agent on the NEXT tick instead of reporting the round complete', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-v29b-'));
    const script = path.join(dir, 'probe.cjs');
    fs.writeFileSync(script, [
      "'use strict';",
      'const agentStatus = { a1: "running", a2: "running" };',
      'const pauseCallCount = { a1: 0, a2: 0 };',
      'const ac = new AbortController();',
      'global.fetch = async (url, init) => {',
      '  const u = String(url);',
      '  if (/\\/api\\/companies$/.test(u)) return { ok: true, status: 200, json: async () => [{ id: "c1", name: "Co" }] };',
      '  if (/\\/api\\/companies\\/c1\\/agents$/.test(u)) return { ok: true, status: 200, json: async () => Object.keys(agentStatus).map((id) => ({ id, name: id, company: "Co", status: agentStatus[id] })) };',
      '  const m = u.match(/\\/api\\/agents\\/(a\\d)\\/pause$/);',
      '  if (m) {',
      '    const id = m[1];',
      '    pauseCallCount[id]++;',
      '    agentStatus[id] = "paused";',
      '    if (id === "a1") ac.abort(); // shutdown begins the instant a1 is genuinely paused — a2 must never be attempted THIS round',
      '    return { ok: true, status: 200, json: async () => ({}) };',
      '  }',
      '  return { ok: true, status: 200, json: async () => ({}) };',
      '};',
      'const G = require(' + JSON.stringify(path.join(__dirname, 'usage-guard.cjs')) + ');',
      '(async () => {',
      '  const ident = { fp: "v29b-account", source: "account-uuid" };',
      '  const u = { session: { pct: 100, resetsAt: null }, week: { pct: 10, resetsAt: null }, windows: G.normalizeWindows({ limits: [{ kind: "session", group: "session", percent: 100, resets_at: null }] }), credits: { present: false }, credentialFp: null };',
      '  const crossed = [{ id: "session|session|session", name: "session", metric: "session", pct: 100, resetsAt: null }];',
      '  await G.doPause(u, crossed, ident, { signal: ac.signal }); // ROUND 1: interrupted after a1',
      '  const afterRound1 = JSON.parse(require("fs").readFileSync(process.env.FORGE_USAGE_GUARD_STATE, "utf8"));',
      '  const pauseCallCountAfterRound1 = { a1: pauseCallCount.a1, a2: pauseCallCount.a2 };',
      '  // ROUND 2: "restart with a fresh signal" — a brand-new AbortController, never aborted.',
      '  const fresh = new AbortController();',
      '  let doPauseCalls = 0;',
      '  const realDoPause = G.doPause;',
      '  await G.tick({ fetchUsage: async () => u, readIdentity: () => ident, readCredentialFp: () => null, doPause: async (...a) => { doPauseCalls++; return realDoPause(...a); } }, { signal: fresh.signal });',
      '  const afterRound2 = JSON.parse(require("fs").readFileSync(process.env.FORGE_USAGE_GUARD_STATE, "utf8"));',
      '  process.stdout.write(JSON.stringify({ pauseCallCountAfterRound1, pauseCallCount, doPauseCalls, afterRound1, afterRound2 }));',
      '})().catch((e) => { process.stdout.write(JSON.stringify({ uncaught: String((e && e.message) || e) })); process.exitCode = 1; });',
    ].join('\n'), 'utf8');
    const stateFile = path.join(dir, 'state.json');
    const env = Object.assign({}, process.env, {
      FORGE_USAGE_GUARD_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'guard-v29b-home-')),
      FORGE_CONFIG_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'guard-v29b-cfghome-')),
      FORGE_PROJECT_ROOT: fs.mkdtempSync(path.join(os.tmpdir(), 'guard-v29b-proj-')),
      FORGE_USAGE_GUARD_STATE: stateFile,
      NVIDIA_SKIP_ENV_FILES: '1',
    });
    delete env.FORGE_USAGE_GUARD_STATE_LOCK_WAIT_MS; // TEST-ISOLATION (see the V29 SIGTERM test's own comment)
    const r = require('child_process').spawnSync(process.execPath, [script], { encoding: 'utf8', env, timeout: 30000 });
    const lastLine = (r.stdout || '').trim().split('\n').pop();
    let out; try { out = JSON.parse(lastLine); } catch { out = { parseError: (r.stdout || '') + (r.stderr || '') }; }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    assert.strictEqual(out.pauseCallCountAfterRound1 && out.pauseCallCountAfterRound1.a1, 1, 'a1 must be paused exactly once, in round 1: ' + JSON.stringify(out));
    assert.strictEqual(out.pauseCallCountAfterRound1 && out.pauseCallCountAfterRound1.a2, 0, 'a2 must NEVER be attempted in round 1 (shutdown began right after a1): ' + JSON.stringify(out));
    assert.strictEqual(out.pauseCallCount && out.pauseCallCount.a2, 1, 'a2 must be paused exactly once overall, in round 2\'s retry: ' + JSON.stringify(out));
    assert.ok(Array.isArray(out.afterRound1 && out.afterRound1.pausePending) && out.afterRound1.pausePending.length === 1 && out.afterRound1.pausePending[0].id === 'a2',
      'round 1 must persist a2 as unfinished pause work, never report the round complete: ' + JSON.stringify(out.afterRound1));
    assert.strictEqual(out.doPauseCalls, 1, 'the retry must go through doPause again on the very next tick — never the "still high, wait" branch: ' + JSON.stringify(out));
    assert.strictEqual(out.afterRound2 && out.afterRound2.pausePending, undefined, 'once a2 is genuinely paused too, pausePending must be cleared — the round is NOW complete: ' + JSON.stringify(out.afterRound2));
    assert.strictEqual(out.afterRound2 && out.afterRound2.mode, 'paused');
    const ids = ((out.afterRound2 && out.afterRound2.pausedAgents) || []).map((a) => a.id).sort();
    assert.deepStrictEqual(ids, ['a1', 'a2'], 'the final pausedAgents list must include BOTH agents (round 1\'s a1 merged with round 2\'s a2): ' + JSON.stringify(out.afterRound2));
  });

  // ---- V29, THIRD Codex recheck (2026-09-24): the second recheck's fix above only ever set `stopIndex`
  // via the PRE-check at the top of a loop iteration — an abort that lands WHILE the CURRENT (only) agent's
  // own pause request is genuinely in-flight fell into the old `else` branch (a completed-failure shape),
  // journalled `pause-failed`/`resolved:true`, and was lost forever: restarting with a fresh signal issued
  // ZERO requests on the next 100%-usage tick. Unlike the two tests above (whose fetch mocks call `ac.abort()`
  // as a side effect but then still RESOLVE the fetch normally with status 200 — proving only the
  // "no SUBSEQUENT request" contract), this mock genuinely REJECTS the in-flight request's own promise with
  // an AbortError once its signal aborts, mirroring real fetch/undici cancellation semantics.
  t5('V29 (third recheck): a cancellation DURING the ONLY agent\'s own in-flight pause request keeps that agent PENDING — restart with a fresh signal must retry it, never report the round complete with nothing to retry', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-v29c-'));
    const script = path.join(dir, 'probe.cjs');
    fs.writeFileSync(script, [
      "'use strict';",
      'const ac = new AbortController();',
      'global.fetch = async (url, init) => {',
      '  const u = String(url);',
      '  if (/\\/api\\/companies$/.test(u)) return { ok: true, status: 200, json: async () => [{ id: "c1", name: "Co" }] };',
      '  if (/\\/api\\/companies\\/c1\\/agents$/.test(u)) return { ok: true, status: 200, json: async () => [{ id: "a1", name: "Agent1", company: "Co", status: "running" }] };',
      '  if (/\\/pause$/.test(u)) {',
      '    return new Promise((resolve, reject) => {',
      '      if (init.signal.aborted) return reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));',
      '      init.signal.addEventListener("abort", () => reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" })), { once: true });',
      '    });',
      '  }',
      '  return { ok: true, status: 200, json: async () => ({}) };',
      '};',
      'const G = require(' + JSON.stringify(path.join(__dirname, 'usage-guard.cjs')) + ');',
      '(async () => {',
      '  const ident = { fp: "v29c-account", source: "account-uuid" };',
      '  const u = { session: { pct: 100, resetsAt: null }, week: { pct: 10, resetsAt: null } };',
      '  const crossed = [{ id: "session|session|session", name: "session", metric: "session", pct: 100, resetsAt: null }];',
      '  const pausePromise = G.doPause(u, crossed, ident, { signal: ac.signal });',
      '  setTimeout(() => ac.abort(), 30); // abort WHILE a1\'s own pause request is genuinely in-flight',
      '  await pausePromise;',
      '  const st = JSON.parse(require("fs").readFileSync(process.env.FORGE_USAGE_GUARD_STATE, "utf8"));',
      '  process.stdout.write(JSON.stringify({ st }));',
      '})().catch((e) => { process.stdout.write(JSON.stringify({ uncaught: String((e && e.message) || e) })); process.exitCode = 1; });',
    ].join('\n'), 'utf8');
    const stateFile = path.join(dir, 'state.json');
    const env = Object.assign({}, process.env, {
      FORGE_USAGE_GUARD_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'guard-v29c-home-')),
      FORGE_CONFIG_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'guard-v29c-cfghome-')),
      FORGE_PROJECT_ROOT: fs.mkdtempSync(path.join(os.tmpdir(), 'guard-v29c-proj-')),
      FORGE_USAGE_GUARD_STATE: stateFile,
      NVIDIA_SKIP_ENV_FILES: '1',
    });
    delete env.FORGE_USAGE_GUARD_STATE_LOCK_WAIT_MS; // TEST-ISOLATION (see the V29 SIGTERM test's own comment)
    const r = require('child_process').spawnSync(process.execPath, [script], { encoding: 'utf8', env, timeout: 30000 });
    const lastLine = (r.stdout || '').trim().split('\n').pop();
    let out; try { out = JSON.parse(lastLine); } catch { out = { parseError: (r.stdout || '') + (r.stderr || '') }; }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    assert.ok(out.st, 'state file must have been written: ' + JSON.stringify(out));
    assert.ok(Array.isArray(out.st.pausePending) && out.st.pausePending.length === 1 && out.st.pausePending[0].id === 'a1',
      'the ONLY agent, cancelled mid-request, must be recorded as pending — never a silently completed round: ' + JSON.stringify(out.st));
    assert.strictEqual(out.st.mode, 'paused');
    assert.deepStrictEqual(out.st.pausedAgents || [], [], 'the aborted agent must never appear in pausedAgents — it was never confirmed paused');
  });

  // ---- N08 (Codex recheck out-p10, 2026-09-24): abort classification + pending-retry-vs-reset ordering ----
  t5('N08: an ordinary request-deadline failure (Node\'s own TimeoutError, message "The operation was aborted due to timeout") is a COMPLETED failure, never a shutdown cancellation — the caller\'s own shutdown signal never fired, so the agent is journalled as a real pause-failed miss, never left dangling as "pending" forever', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-n08a-'));
    const script = path.join(dir, 'probe.cjs');
    fs.writeFileSync(script, [
      "'use strict';",
      'const ac = new AbortController();', // the caller's OWN shutdown signal — NEVER aborted in this test
      'global.fetch = async (url, init) => {',
      '  const u = String(url);',
      '  if (/\\/api\\/companies$/.test(u)) return { ok: true, status: 200, json: async () => [{ id: "c1", name: "Co" }] };',
      '  if (/\\/api\\/companies\\/c1\\/agents$/.test(u)) return { ok: true, status: 200, json: async () => [{ id: "a1", name: "Agent1", company: "Co", status: "running" }] };',
      '  if (/\\/pause$/.test(u)) {',
      '    // mirrors Node\'s OWN internal AbortSignal.timeout(10000) firing — NOT a shutdown: o.signal (ac.signal)',
      '    // is never aborted anywhere in this test, only the (unrelated) internal 10s deadline would fire in reality.',
      '    const e = new Error("The operation was aborted due to timeout"); e.name = "TimeoutError";',
      '    throw e;',
      '  }',
      '  return { ok: true, status: 200, json: async () => ({}) };',
      '};',
      'const G = require(' + JSON.stringify(path.join(__dirname, 'usage-guard.cjs')) + ');',
      '(async () => {',
      '  const ident = { fp: "n08a-account", source: "account-uuid" };',
      '  const u = { session: { pct: 100, resetsAt: null }, week: { pct: 10, resetsAt: null } };',
      '  const crossed = [{ id: "session|session|session", name: "session", metric: "session", pct: 100, resetsAt: null }];',
      '  await G.doPause(u, crossed, ident, { signal: ac.signal });',
      '  const st = JSON.parse(require("fs").readFileSync(process.env.FORGE_USAGE_GUARD_STATE, "utf8"));',
      '  process.stdout.write(JSON.stringify({ st, callerSignalAborted: ac.signal.aborted }));',
      '})().catch((e) => { process.stdout.write(JSON.stringify({ uncaught: String((e && e.message) || e) })); process.exitCode = 1; });',
    ].join('\n'), 'utf8');
    const stateFile = path.join(dir, 'state.json');
    const env = Object.assign({}, process.env, {
      FORGE_USAGE_GUARD_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'guard-n08a-home-')),
      FORGE_CONFIG_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'guard-n08a-cfghome-')),
      FORGE_PROJECT_ROOT: fs.mkdtempSync(path.join(os.tmpdir(), 'guard-n08a-proj-')),
      FORGE_USAGE_GUARD_STATE: stateFile,
      NVIDIA_SKIP_ENV_FILES: '1',
    });
    delete env.FORGE_USAGE_GUARD_STATE_LOCK_WAIT_MS; // TEST-ISOLATION (see the V29 SIGTERM test's own comment)
    const r = require('child_process').spawnSync(process.execPath, [script], { encoding: 'utf8', env, timeout: 30000 });
    const lastLine = (r.stdout || '').trim().split('\n').pop();
    let out; try { out = JSON.parse(lastLine); } catch { out = { parseError: (r.stdout || '') + (r.stderr || '') }; }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    assert.strictEqual(out.callerSignalAborted, false, 'sanity: the caller never aborted its own shutdown signal in this scenario: ' + JSON.stringify(out));
    assert.ok(out.st, 'state file must have been written: ' + JSON.stringify(out));
    assert.deepStrictEqual(out.st.pausePending || [], [], 'a genuine (non-shutdown) request-deadline failure must NEVER be recorded as pending/unfinished work: ' + JSON.stringify(out.st));
  });

  t5('N08: pending pause work never preempts reset/resume evaluation — with usage back at 0%, one never-yet-paused pending agent and one already-paused agent, the paused agent is RESUMED and ZERO new pause requests are issued', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-n08b-'));
    const script = path.join(dir, 'probe.cjs');
    fs.writeFileSync(script, [
      "'use strict';",
      'let pauseCalls = 0, resumeCalls = [];',
      'global.fetch = async (url, init) => {',
      '  const u = String(url);',
      '  if (/\\/api\\/companies$/.test(u)) return { ok: true, status: 200, json: async () => [{ id: "c1", name: "Co" }] };',
      // LIVE Paperclip status: a1 already paused for real; a2 still running (never actually paused) — the
      // exact "one repeatedly timing-out pending agent (a2) + one already-paused agent (a1)" schedule.
      '  if (/\\/api\\/companies\\/c1\\/agents$/.test(u)) return { ok: true, status: 200, json: async () => [{ id: "a1", name: "Agent1", company: "Co", status: "paused" }, { id: "a2", name: "Agent2", company: "Co", status: "running" }] };',
      '  if (/\\/api\\/agents\\/a2\\/pause$/.test(u)) { pauseCalls++; return { ok: true, status: 200, json: async () => ({}) }; }',
      '  const m = u.match(/\\/api\\/agents\\/(a\\d)\\/resume$/);',
      '  if (m) { resumeCalls.push(m[1]); return { ok: true, status: 200, json: async () => ({}) }; }',
      '  return { ok: true, status: 200, json: async () => ({}) };',
      '};',
      'const G = require(' + JSON.stringify(path.join(__dirname, 'usage-guard.cjs')) + ');',
      'const fs = require("fs");',
      // pre-seed state: mode paused, a1 already confirmed paused, a2 STILL pending from an earlier interrupted round.
      'fs.writeFileSync(process.env.FORGE_USAGE_GUARD_STATE, JSON.stringify({',
      '  mode: "paused",',
      '  trigger: [{ id: "session|session|session", name: "session", metric: "session", pct: 100, resetsAt: null }],',
      '  pauseAt: 98, resumeAt: 0,',
      '  pausedAgents: [{ id: "a1", name: "Agent1", company: "Co" }],',
      '  pausePending: [{ id: "a2", name: "Agent2", company: "Co" }],',
      '}));',
      '(async () => {',
      '  const ident = { fp: "n08b-account", source: "account-uuid" };',
      // usage is now back at 0% — well below resume-at (0) is false (0 is not > 0) => NOT stillHigh => resume wins.
      '  const u = { session: { pct: 0, resetsAt: null }, week: { pct: 0, resetsAt: null }, windows: G.normalizeWindows({ limits: [{ kind: "session", group: "session", percent: 0, resets_at: null }] }), credits: { present: false }, credentialFp: null };',
      '  await G.tick({ fetchUsage: async () => u, readIdentity: () => ident, readCredentialFp: () => null });',
      '  const st = JSON.parse(fs.readFileSync(process.env.FORGE_USAGE_GUARD_STATE, "utf8"));',
      '  process.stdout.write(JSON.stringify({ st, pauseCalls, resumeCalls }));',
      '})().catch((e) => { process.stdout.write(JSON.stringify({ uncaught: String((e && e.message) || e) })); process.exitCode = 1; });',
    ].join('\n'), 'utf8');
    const stateFile = path.join(dir, 'state.json');
    const env = Object.assign({}, process.env, {
      FORGE_USAGE_GUARD_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'guard-n08b-home-')),
      FORGE_CONFIG_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'guard-n08b-cfghome-')),
      FORGE_PROJECT_ROOT: fs.mkdtempSync(path.join(os.tmpdir(), 'guard-n08b-proj-')),
      FORGE_USAGE_GUARD_STATE: stateFile,
      NVIDIA_SKIP_ENV_FILES: '1',
    });
    delete env.FORGE_USAGE_GUARD_STATE_LOCK_WAIT_MS;
    const r = require('child_process').spawnSync(process.execPath, [script], { encoding: 'utf8', env, timeout: 30000 });
    const lastLine = (r.stdout || '').trim().split('\n').pop();
    let out; try { out = JSON.parse(lastLine); } catch { out = { parseError: (r.stdout || '') + (r.stderr || '') }; }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    assert.strictEqual(out.pauseCalls, 0, 'zero NEW pause requests may be issued once usage has genuinely recovered — the old order kept retrying a2\'s pause forever: ' + JSON.stringify(out));
    assert.ok(Array.isArray(out.resumeCalls) && out.resumeCalls.includes('a1'), 'the already-paused agent must be RESUMED: ' + JSON.stringify(out));
    assert.ok(out.st, 'state file must have been written: ' + JSON.stringify(out));
    assert.strictEqual(out.st.mode, 'ok', 'the account must actually resume, not stay stuck in "paused" retrying pause work that is no longer warranted: ' + JSON.stringify(out.st));
  });

  // ---- GUARD-STOP (Codex recheck wp-f4, 2026-09-24): retained timer handles, a shutdown check BEFORE
  // starting new work, an abortable in-flight request, and a `stop` exit code that actually reflects
  // whether the watcher was confirmed dead.
  t5('GUARD-STOP: fetchUsage(opts.signal) aborts an in-flight request when an EXTERNAL signal fires, not just the internal timeout', () => {
    const sb = sandbox5(null);
    fs.writeFileSync(credFile(sb), JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-VALIDSHAPEDTOKEN1234567890' } }));
    const out = spawnGuardProbe(sb.env, [
      "'use strict';",
      'global.fetch = async (url, init) => ({ ok: true, status: 200, json: () => new Promise((resolve, reject) => {',
      '  if (init.signal.aborted) return reject(Object.assign(new Error("aborted"), { name: "AbortError" }));',
      '  init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });',
      '}) });',
      'const G = require(' + JSON.stringify(path.join(__dirname, 'usage-guard.cjs')) + ');',
      'const ac = new AbortController();',
      '(async () => {',
      '  const p = G.fetchUsage({ signal: ac.signal });',
      '  setTimeout(() => ac.abort(), 50);',
      '  let err = null; try { await p; } catch (e) { err = e.message; }',
      '  process.stdout.write(JSON.stringify({ err }));',
      '})().catch((e) => { process.stdout.write(JSON.stringify({ uncaught: String((e && e.message) || e) })); process.exitCode = 1; });',
    ]);
    assert.match(out.err || '', /shutting down/, JSON.stringify(out));
  });
  t5('V20/GUARD-STOP: `stop` actually terminates a real running watcher and exits 0 — the watcher\'s own first tick is deny-by-default intercepted, never a real network/Paperclip call', () => {
    const sb = sandbox5(null);
    fs.writeFileSync(credFile(sb), JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-VALIDSHAPEDTOKEN1234567890' } }));
    // V20 (Codex recheck wp-f4, 2026-09-24): this test supplies a syntactically-valid-but-fake token and
    // starts a REAL detached watcher — without interception it could reach the LIVE api.anthropic.com
    // endpoint. FORGE_USAGE_GUARD_DENY_NETWORK installs a deny-by-default global.fetch stub in that real
    // child process (it inherits this env, unmodified, via spawn()'s default env passthrough).
    const denyLog = path.join(sb.dir, 'deny-network.jsonl');
    const startEnv = Object.assign({}, sb.env, { FORGE_USAGE_GUARD_CLAIM_TIMEOUT_MS: '30000', FORGE_USAGE_GUARD_DENY_NETWORK: '1', FORGE_USAGE_GUARD_DENY_NETWORK_LOG: denyLog });
    const startR = runGuard(['start', '--interval', '60'], startEnv);
    let pid = null;
    try { pid = JSON.parse(fs.readFileSync(sb.env.FORGE_USAGE_GUARD_PID, 'utf8')).pid; } catch { pid = null; }
    try {
      assert.strictEqual(startR.status, 0, (startR.stdout || '') + (startR.stderr || ''));
      assert.ok(pid && G5.pidAlive(pid), 'the watcher actually started');
      // Bounded wait for the seam to have actually intercepted the watcher's first tick request BEFORE
      // stopping it — proves the interception engaged with a REAL call attempt, not a vacuous no-op.
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline && !fs.existsSync(denyLog)) nap(100);
      assert.ok(fs.existsSync(denyLog), 'the deny-network seam must have intercepted at least one request from the real watcher: ' + readIf(sb.env.FORGE_USAGE_GUARD_LOG));
      const denied = readIf(denyLog).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      assert.ok(denied.length >= 1 && denied.every((r) => /api\.anthropic\.com/.test(r.url)), 'the intercepted request must be the real usage endpoint, never allowed through: ' + JSON.stringify(denied));
      const stopR = runGuard(['stop'], sb.env);
      assert.strictEqual(stopR.status, 0, 'a real, successful stop must exit 0: ' + (stopR.stdout || '') + (stopR.stderr || ''));
      assert.ok(/usage-guard stopped/.test(stopR.stdout || ''), stopR.stdout);
      assert.ok(!G5.pidAlive(pid), 'the watcher process is actually gone');
      assert.ok(!fs.existsSync(sb.env.FORGE_USAGE_GUARD_PID), 'the pid file was removed on confirmed death');
      const stopAgain = runGuard(['stop'], sb.env);
      assert.strictEqual(stopAgain.status, 0);
      assert.ok(/not running/.test(stopAgain.stdout || ''), stopAgain.stdout);
    } finally {
      if (pid && pid !== process.pid && G5.pidAlive(pid)) { try { process.kill(pid); } catch { /* best effort */ } }
    }
  });
  t5('GUARD-STOP: a `stop` that cannot confirm death exits NONZERO (contract check — the old code always exited 0)', () => {
    const src = fs.readFileSync(path.join(__dirname, 'usage-guard.cjs'), 'utf8');
    assert.match(src, /process\.exit\(stoppedOk \? 0 : 1\)/, 'the stop command must report a real, non-hardcoded exit code');
  });

  // ---- GUARD-DISCLOSURE (Codex recheck wp-f4, 2026-09-24): every watcher activation path discloses
  // BEFORE its first credential use — a direct `watch` invocation (never disclosed at all before) and a
  // schema-unavailable fallback (previously omitted the credential source/destination/persistence/
  // storage-location details).
  t5('GUARD-DISCLOSURE: the real (non --once) watcher logs the disclosure BEFORE its first tick/check line — covers both the direct-`watch` code path and start\'s own race', () => {
    const sb = sandbox5(null);
    fs.writeFileSync(credFile(sb), JSON.stringify({ claudeAiOauth: {} })); // present but tokenless — readToken() fails fast, no real network either way
    const r = runGuard(['start', '--interval', '60'], Object.assign({}, sb.env, { FORGE_USAGE_GUARD_CLAIM_TIMEOUT_MS: '30000' }));
    let pid = null;
    try { pid = JSON.parse(fs.readFileSync(sb.env.FORGE_USAGE_GUARD_PID, 'utf8')).pid; } catch { pid = null; }
    try {
      assert.strictEqual(r.status, 0, (r.stdout || '') + (r.stderr || ''));
      const logText = readIf(sb.env.FORGE_USAGE_GUARD_LOG);
      const disclosureIdx = logText.search(/Reads your Claude login token locally|leest je Claude-login-token/);
      assert.ok(disclosureIdx >= 0, 'the real watcher must have LOGGED its disclosure: ' + logText);
      const tickIdx = logText.search(/CHECK FAILED|REAL usage|ok — /);
      if (tickIdx >= 0) assert.ok(disclosureIdx < tickIdx, 'the disclosure must precede the first tick/check line, not follow it');
    } finally {
      if (pid && pid !== process.pid && G5.pidAlive(pid)) { try { process.kill(pid); } catch { /* best effort */ } }
    }
  });
  t5('V30 (Codex recheck wp-f4): `watch --once` ALSO logs the disclosure BEFORE its first tick — it used to call tick() straight after the gate check with no disclosure at all', () => {
    const sb = sandbox5(null);
    fs.writeFileSync(credFile(sb), JSON.stringify({ claudeAiOauth: {} })); // present but tokenless — readToken() fails fast, no real network either way
    const r = runGuard(['watch', '--once'], sb.env);
    assert.strictEqual(r.status, 0, (r.stdout || '') + (r.stderr || ''));
    const logText = readIf(sb.env.FORGE_USAGE_GUARD_LOG);
    const disclosureIdx = logText.search(/Reads your Claude login token locally|leest je Claude-login-token/);
    assert.ok(disclosureIdx >= 0, '`watch --once` must have LOGGED its disclosure before its first tick: ' + logText);
    const tickIdx = logText.search(/CHECK FAILED|REAL usage|ok — /);
    if (tickIdx >= 0) assert.ok(disclosureIdx < tickIdx, 'the disclosure must precede --once\'s own first tick/check line, not follow it: ' + logText);
  });
  t5('GUARD-DISCLOSURE: the fallback (schema/forge-config unavailable) is a COMPLETE disclosure — credential source, destination, persistence and storage location, not just "measures your usage"', () => {
    const lines = G5.disclosureLines(null);
    const joined = lines.join(' ');
    assert.match(joined, /\.credentials\.json/, 'names the credential source');
    assert.match(joined, /api\.anthropic\.com/, 'names the destination');
    assert.match(joined, /background process|achtergrondproces/i, 'discloses it keeps running in the background');
    assert.match(joined, /also after the session closes|ook na het sluiten van de sessie/i, 'discloses persistence after the session closes');
    assert.match(joined, /~\/\.claude/, 'names the storage location');
    assert.match(joined, /usage-guard uit/, 'names the off command');
  });

  // ---- CFG-05 (Codex recheck wp-f4, 2026-09-24): thresholds/flags are validated against the schema's own
  // min/max/integer bounds — out-of-range, fractional or nonfinite values are rejected with a warning and
  // the guard falls back to the next source instead of silently accepting them.
  t5('CFG-05: an out-of-range --pause-at flag is rejected with a warning; the config value is used instead', () => {
    const s = G5.resolveGuardSettings(['--pause-at', '150'], { 'usage-guard.pause-at': { value: 90, source: 'global' } });
    assert.deepStrictEqual([s['pause-at'].value, s['pause-at'].source], [90, 'instelling']);
    assert.strictEqual(s.warnings.length, 1);
    assert.match(s.warnings[0], /--pause-at 150 is buiten het toegestane bereik|out of the allowed range/);
  });
  t5('CFG-05: a fractional --interval flag is rejected (Number.isInteger check) — falls through to the default', () => {
    const s = G5.resolveGuardSettings(['--interval', '45.5'], null);
    assert.deepStrictEqual([s.interval.value, s.interval.source], [120, 'standaard']);
    assert.strictEqual(s.warnings.length, 1);
  });
  t5('CFG-05: a negative --resume-at flag is rejected — the schema minimum is 0', () => {
    const s = G5.resolveGuardSettings(['--resume-at', '-5'], null);
    assert.deepStrictEqual([s['resume-at'].value, s['resume-at'].source], [0, 'standaard']);
    assert.strictEqual(s.warnings.length, 1);
  });
  t5('CFG-05: an out-of-range CONFIG value (not a flag) is also rejected, with its own warning, and the hard default is used', () => {
    const s = G5.resolveGuardSettings([], { 'usage-guard.nvidia-shift-at': { value: 5, source: 'global' } });
    assert.deepStrictEqual([s['nvidia-shift-at'].value, s['nvidia-shift-at'].source], [80, 'standaard']);
    assert.strictEqual(s.warnings.length, 1);
    assert.match(s.warnings[0], /usage-guard\.nvidia-shift-at=5 is buiten|is out of the allowed range/);
  });
  t5('CFG-05: values exactly AT the schema min/max boundary are accepted (inclusive bounds)', () => {
    const s1 = G5.resolveGuardSettings(['--pause-at', '50'], null); // schema min
    assert.deepStrictEqual([s1['pause-at'].value, s1['pause-at'].source], [50, 'vlag']);
    const s2 = G5.resolveGuardSettings(['--pause-at', '99'], null); // schema max
    assert.deepStrictEqual([s2['pause-at'].value, s2['pause-at'].source], [99, 'vlag']);
  });
  t5('CFG-05: a 100% window still pauses at every ACCEPTED threshold (the bounds check never disables the actual pause decision)', () => {
    for (const pauseAt of [50, 90, 99]) {
      const windows = G5.normalizeWindows({ limits: [{ kind: 'session', group: 'session', percent: 100, resets_at: null }] });
      assert.strictEqual(G5.crossedWindows(windows, pauseAt).length, 1, 'pause-at ' + pauseAt + ' must still trip on 100%');
    }
  });
  // ---- V19 (Codex recheck wp-f4, 2026-09-24): a missing/malformed/BOM-prefixed schema must NEVER mean
  // "no bounds" — it means "fall back to the hard-coded GUARD_BOUNDS_FALLBACK bounds", so an out-of-range
  // or fractional threshold is still rejected even when the real schema file cannot be read at all.
  t5('V19: guardBounds() falls back to the hard-coded bounds (never {}) when the schema file does not exist', () => {
    const b = G5.guardBounds(path.join(os.tmpdir(), 'this-schema-does-not-exist-' + Date.now() + '.json'));
    assert.deepStrictEqual(b, { 'pause-at': { min: 50, max: 99 }, 'resume-at': { min: 0, max: 98 }, interval: { min: 30, max: 900 }, 'nvidia-shift-at': { min: 50, max: 99 } });
    const s = G5.resolveGuardSettings(['--pause-at', '150'], null, { bounds: b });
    assert.deepStrictEqual([s['pause-at'].value, s['pause-at'].source], [98, 'standaard'], 'a missing schema must still REFUSE an out-of-range flag — never fail open to "no bounds"');
    assert.strictEqual(s.warnings.length, 1);
  });
  t5('V19: guardBounds() falls back to the hard-coded bounds when the schema file is malformed JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-v19-'));
    try {
      const schemaFile = path.join(dir, 'malformed.json');
      fs.writeFileSync(schemaFile, '{ "settings": ');
      const b = G5.guardBounds(schemaFile);
      assert.deepStrictEqual(b['pause-at'], { min: 50, max: 99 });
      const s = G5.resolveGuardSettings(['--pause-at', '4.5'], null, { bounds: b });
      assert.deepStrictEqual([s['pause-at'].value, s['pause-at'].source], [98, 'standaard'], 'a malformed schema must still REFUSE a fractional flag');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  t5('V19: guardBounds() accepts a BOM-prefixed schema exactly like the config core does (real bounds, not the fallback)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-v19-'));
    try {
      const schemaFile = path.join(dir, 'bom-schema.json');
      const real = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'orchestration', 'FORGE_CONFIG_SCHEMA.json'), 'utf8'));
      fs.writeFileSync(schemaFile, '﻿' + JSON.stringify(real));
      const b = G5.guardBounds(schemaFile);
      assert.deepStrictEqual(b['pause-at'], { min: 50, max: 99 }, 'the REAL schema bounds, read past the BOM — not silently degraded to the fallback');
      const s = G5.resolveGuardSettings(['--pause-at', '150'], null, { bounds: b });
      assert.deepStrictEqual([s['pause-at'].value, s['pause-at'].source], [98, 'standaard']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  // ---- REG-USAGE-GUARANTEE (Codex recheck wp-f4, 2026-09-24 — code part): the guard cannot guarantee a
  // task is never cut off mid-way (it samples on an interval); `status`/`start` must say so in plain
  // words instead of implying an instant, guaranteed block. Exact wording (report to Docs Boss so the
  // README/CHANGELOG match): "sampled every N s (best effort — a task can still cross the limit between
  // samples; this is not an instant, guaranteed block)" / NL: "gemeten elke N s (beste-poging — een taak
  // kan tussen twee metingen door de limiet nog overschrijden; dit is geen ogenblikkelijke, gegarandeerde
  // blokkade)".
  t5('REG-USAGE-GUARANTEE: CLI status prints the "sampled every Ns, best effort" wording, never implying an instant guarantee', () => {
    const sb = sandbox5(null);
    const r = runGuard(['status'], sb.env);
    assert.match(r.stdout || '', /sampled every \d+s \(best effort — a task can still cross the limit between samples; this is not an instant, guaranteed block\)/, r.stdout);
    assert.match(r.stdout || '', /gemeten elke \d+s \(beste-poging/, r.stdout);
  });
  t5('REG-USAGE-GUARANTEE: CLI start prints the SAME wording on a real, verified start', () => {
    const sb = sandbox5(null);
    fs.writeFileSync(credFile(sb), JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-VALIDSHAPEDTOKEN1234567890' } }));
    // V20: a valid-shaped fake token + a real detached watcher — deny-by-default so this offline suite
    // never reaches the live endpoint (see the V20/GUARD-STOP test above for the full rationale).
    const r = runGuard(['start', '--interval', '60'], Object.assign({}, sb.env, { FORGE_USAGE_GUARD_CLAIM_TIMEOUT_MS: '30000', FORGE_USAGE_GUARD_DENY_NETWORK: '1' }));
    let pid = null;
    try { pid = JSON.parse(fs.readFileSync(sb.env.FORGE_USAGE_GUARD_PID, 'utf8')).pid; } catch { pid = null; }
    try {
      assert.strictEqual(r.status, 0, (r.stdout || '') + (r.stderr || ''));
      assert.match(r.stdout || '', /sampled every 60s \(best effort — a task can still cross the limit between samples; this is not an instant, guaranteed block\)/, r.stdout);
    } finally {
      if (pid && pid !== process.pid && G5.pidAlive(pid)) { try { process.kill(pid); } catch { /* best effort */ } }
    }
  });

  t5('L2: watchStep re-reads the REAL settings file before every check — flipping it to OFF stops the watcher and releases its pid file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-l2-'));
    const home = path.join(dir, 'home');
    const proj = path.join(dir, 'project');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
    const setSwitch = (on) => fs.writeFileSync(path.join(home, 'FORGE_CONFIG.json'), JSON.stringify({ version: 1, settings: { 'usage-guard': val(on) } }));
    const pidFile = path.join(dir, 'watcher.pid');
    fs.writeFileSync(pidFile, JSON.stringify({ pid: process.pid }) + '\n');
    const calls = { ticks: 0, exits: [], logs: [] };
    const deps = {
      readSwitch: () => G5.readGuardSwitch({ configOpts: { configHome: home, projectRoot: proj } }),
      tick: async () => { calls.ticks++; },
      log: (m) => calls.logs.push(m),
      release: () => G5.releaseWatcherSlot({ pidFile, pid: process.pid }),
      exit: (c) => calls.exits.push(c),
    };
    try {
      setSwitch(true);
      const s1 = await G5.watchStep({ forced: false, seenOn: false }, deps);
      assert.deepStrictEqual([s1.outcome, s1.seenOn, calls.ticks, calls.exits.length], ['ticked', true, 1, 0]);
      setSwitch(false);
      const s2 = await G5.watchStep({ forced: false, seenOn: s1.seenOn }, deps);
      assert.strictEqual(s2.outcome, 'switched-off');
      assert.strictEqual(calls.ticks, 1, 'no check after the switch went off');
      assert.deepStrictEqual(calls.exits, [0]);
      assert.ok(!fs.existsSync(pidFile), 'the pid file was removed');
      assert.strictEqual(calls.logs.length, 1);
      assert.match(calls.logs[0], /UIT in je instellingen/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  t5('L2: forced watcher runs while OFF until it has seen ON; unreadable stops a normal watcher; a lost slot exits 1 first', async () => {
    const run = async (ctx, sw, owns) => {
      const calls = { ticks: 0, exits: [], logs: [], reads: 0 };
      const step = await G5.watchStep(ctx, {
        stillOwnsSlot: () => owns !== false, readSwitch: () => { calls.reads++; return sw; }, tick: async () => { calls.ticks++; },
        log: (m) => calls.logs.push(m), release: () => {}, exit: (c) => calls.exits.push(c),
      });
      return Object.assign(calls, step);
    };
    const OFF = { on: false, unreadable: false };
    const ON = { on: true, unreadable: false };
    const a = await run({ forced: true, seenOn: false }, OFF);
    assert.deepStrictEqual([a.outcome, a.seenOn, a.ticks, a.exits.length], ['ticked', false, 1, 0], 'forced + never on: keeps checking');
    const b = await run({ forced: true, seenOn: a.seenOn }, ON);
    assert.deepStrictEqual([b.outcome, b.seenOn], ['ticked', true]);
    const c = await run({ forced: true, seenOn: b.seenOn }, OFF);
    assert.deepStrictEqual([c.outcome, c.ticks, c.exits], ['switched-off', 0, [0]], 'on -> off stops even a forced watcher');
    const d = await run({ forced: false, seenOn: true }, { on: false, unreadable: true });
    assert.deepStrictEqual([d.outcome, d.exits], ['switched-off', [0]]);
    assert.match(d.logs[0], /instellingen onleesbaar/);
    const e = await run({ forced: false, seenOn: true }, ON, false);
    assert.deepStrictEqual([e.outcome, e.exits, e.reads, e.ticks], ['lost-slot', [1], 0, 0]);
  });
  try { fs.rmSync(CONFIG_SANDBOX, { recursive: true, force: true }); } catch { }
}

// ---- SB-M6 (2026-09-24, Security Boss wave 11, sec-w11) — a resume attempt that keeps failing must never
// block an owner forever: (b) a 404/410 (the Paperclip agent no longer exists) counts as RESOLVED, never an
// endless retry target; (c) a genuinely-transient failure is retried across ticks but CAPPED at
// RESUME_RETRY_MAX, escalating with exactly ONE notice (never a repeated no-op status loop), while (d) the
// wave-10 rule ("no ok before reconciliation succeeds") stays intact for real transient failures — a partial
// failure never claims 'ok'. See forge-autonomy.test.cjs's own SB-M6 tests for the companion fix (autonomy
// ignoring a guard-owned pause once an override is honoured). ----
test('SB-M6(b): a resume answered with 404 (agent deleted) counts as RESOLVED — never retried forever, state clears to ok', () => {
  const out = runV15OverrideProbe([
    "'use strict';",
    'let resumeCalls = 0;',
    'global.fetch = async (url, init) => {',
    '  const u = String(url); const m = (init && init.method) || "GET";',
    '  if (/\\/api\\/agents\\/a1\\/resume$/.test(u) && m === "POST") { resumeCalls++; return { ok: false, status: 404, json: async () => ({ error: "not found" }) }; }',
    '  return { ok: true, status: 200, json: async () => ({}) };',
    '};',
    'const fs = require("fs"); const path = require("path");',
    'const G = require(' + JSON.stringify(path.join(__dirname, 'usage-guard.cjs')) + ');',
    'const ident = { fp: "sb-m6-account", source: "account-uuid" };',
    'const uLow = { session: { pct: 5, resetsAt: null }, week: { pct: 5, resetsAt: null }, windows: G.normalizeWindows({ limits: [{ kind: "session", group: "session", percent: 5, resets_at: null }] }), credits: { present: false }, credentialFp: null };',
    'fs.writeFileSync(process.env.FORGE_USAGE_GUARD_STATE, JSON.stringify({ mode: "paused", account: { fp: ident.fp, source: ident.source }, pausedAgents: [{ id: "a1", name: "Agent1", company: "Co" }] }));',
    // doResume() logs via the module\'s own internal log() helper (console.log + a log FILE), not via an
    // injectable `log` dep — capture the real console.log stream directly, exactly like this file\'s own
    // N17W9 test does for runOverrideOn()\'s log output.
    'const logs = []; const realLog = console.log;',
    'console.log = (m) => { logs.push(String(m)); };',
    '(async () => {',
    '  await G.tick({ fetchUsage: async () => uLow, readIdentity: () => ident, readCredentialFp: () => null, readCredentialGeneration: () => null });',
    '  const st = JSON.parse(fs.readFileSync(process.env.FORGE_USAGE_GUARD_STATE, "utf8"));',
    '  console.log = realLog;',
    '  process.stdout.write(JSON.stringify({ st, resumeCalls, logs }));',
    '})().catch((e) => { console.log = realLog; process.stdout.write(JSON.stringify({ uncaught: String((e && e.message) || e) })); process.exitCode = 1; });',
  ]);
  assert.ok(!out.uncaught, JSON.stringify(out));
  assert.strictEqual(out.resumeCalls, 1, JSON.stringify(out));
  assert.strictEqual(out.st.mode, 'ok', 'a 404 (agent no longer exists) must resolve, never stay paused forever: ' + JSON.stringify(out.st));
  assert.ok(!Array.isArray(out.st.pausedAgents) || out.st.pausedAgents.length === 0, JSON.stringify(out.st));
  assert.ok(out.logs.some((l) => /no longer exist/.test(l)), 'the resolution must be named honestly in the log, not silently folded into an ordinary "resumed" count: ' + JSON.stringify(out.logs));
});
test('SB-M6(c/d): a genuinely-transient resume failure is retried across ticks, CAPPED, and escalates with exactly ONE notice — eventual success still fully clears the pause and its retry bookkeeping', () => {
  const out = runV15OverrideProbe([
    "'use strict';",
    'let resumeCalls = 0;',
    'global.fetch = async (url, init) => {',
    '  const u = String(url); const m = (init && init.method) || "GET";',
    '  if (/\\/api\\/agents\\/a1\\/resume$/.test(u) && m === "POST") {',
    '    resumeCalls++;',
    '    if (resumeCalls >= 12) return { ok: true, status: 200, json: async () => ({}) };',
    '    return { ok: false, status: 500, json: async () => ({}) };',
    '  }',
    '  return { ok: true, status: 200, json: async () => ({}) };',
    '};',
    'const fs = require("fs"); const path = require("path");',
    'const G = require(' + JSON.stringify(path.join(__dirname, 'usage-guard.cjs')) + ');',
    'const ident = { fp: "sb-m6-retry-account", source: "account-uuid" };',
    'const uLow = { session: { pct: 5, resetsAt: null }, week: { pct: 5, resetsAt: null }, windows: G.normalizeWindows({ limits: [{ kind: "session", group: "session", percent: 5, resets_at: null }] }), credits: { present: false }, credentialFp: null };',
    'fs.writeFileSync(process.env.FORGE_USAGE_GUARD_STATE, JSON.stringify({ mode: "paused", account: { fp: ident.fp, source: ident.source }, pausedAgents: [{ id: "a1", name: "Agent1", company: "Co" }] }));',
    'const logs = []; const realLog = console.log;',
    'console.log = (m) => { logs.push(String(m)); };',
    '(async () => {',
    '  const states = [];',
    '  for (let i = 0; i < 15; i++) {',
    '    await G.tick({ fetchUsage: async () => uLow, readIdentity: () => ident, readCredentialFp: () => null, readCredentialGeneration: () => null });',
    '    states.push(JSON.parse(fs.readFileSync(process.env.FORGE_USAGE_GUARD_STATE, "utf8")));',
    '  }',
    '  console.log = realLog;',
    '  process.stdout.write(JSON.stringify({ states, resumeCalls, logs }));',
    '})().catch((e) => { console.log = realLog; process.stdout.write(JSON.stringify({ uncaught: String((e && e.message) || e) })); process.exitCode = 1; });',
  ]);
  assert.ok(!out.uncaught, JSON.stringify(out));
  const exhaustedStates = out.states.filter((s) => s.retriesExhausted === true);
  assert.ok(exhaustedStates.length > 0, 'must reach retriesExhausted after enough consecutive failures: ' + JSON.stringify(out.states.map((s) => ({ mode: s.mode, count: s.resumeRetryCount, ex: s.retriesExhausted }))));
  const escalationLogs = out.logs.filter((l) => /RETRIES EXHAUSTED/.test(l));
  assert.strictEqual(escalationLogs.length, 1, 'the escalation notice must fire exactly ONCE, never every tick (no no-op status loop): ' + JSON.stringify(out.logs));
  // (d) never claim 'ok' while reconciliation has not yet succeeded — every state before the real success must
  // still say 'paused', never a premature 'ok'.
  assert.ok(out.states.slice(0, 11).every((s) => s.mode === 'paused'), 'no state before the real success may claim ok: ' + JSON.stringify(out.states.map((s) => s.mode)));
  const finalState = out.states[out.states.length - 1];
  assert.strictEqual(finalState.mode, 'ok', 'eventual success must still fully clear the pause: ' + JSON.stringify(finalState));
  assert.strictEqual(finalState.retriesExhausted, undefined, 'a successful resume must clear the exhausted flag: ' + JSON.stringify(finalState));
  assert.strictEqual(finalState.resumeRetryCount, undefined, 'a successful resume must clear the retry counter: ' + JSON.stringify(finalState));
});

// ============================================================================================
// N1 — fresh-laptop re-audit, 2026-09-26: a full per-model window must not pause every model for
// days while a DIFFERENT model still has room in the all-models window. See windowAppliesNow(),
// triggerCanResumeByModelSwitch() and their tick() call sites in usage-guard.cjs for the fix.
// ============================================================================================
function usageWithLimits(sessionPct, weekPct, limits) {
  const j = { five_hour: { utilization: sessionPct, resets_at: null }, seven_day: { utilization: weekPct, resets_at: null }, limits };
  return { session: { pct: sessionPct, resetsAt: null }, week: { pct: weekPct, resetsAt: null }, windows: G.normalizeWindows(j), credits: { used: NaN, limit: NaN, remaining: NaN } };
}

test('N1 pure: windowAppliesNow — an all-models window (no .model) always applies, regardless of isActive', () => {
  assert.strictEqual(G.windowAppliesNow({ model: null, isActive: false }, null), true);
  assert.strictEqual(G.windowAppliesNow({ model: null, isActive: null }, 'Opus'), true);
});
test('N1 pure: windowAppliesNow — a per-model window applies when is_active says so, regardless of the hint', () => {
  assert.strictEqual(G.windowAppliesNow({ model: 'Fable', isActive: true }, null), true);
  assert.strictEqual(G.windowAppliesNow({ model: 'Fable', isActive: true }, 'Opus'), true);
});
test('N1 pure: windowAppliesNow — a per-model window applies when the model hint matches, even if is_active is unknown', () => {
  assert.strictEqual(G.windowAppliesNow({ model: 'Fable 5.1', isActive: null }, 'Fable'), true);
});
test('N1 pure: windowAppliesNow FAIL SAFE — a per-model window does NOT apply when neither is_active nor the hint says so (advisory, never a silent ignore of a DIFFERENT window)', () => {
  assert.strictEqual(G.windowAppliesNow({ model: 'Fable', isActive: false }, null), false);
  assert.strictEqual(G.windowAppliesNow({ model: 'Fable', isActive: null }, 'Opus'), false);
});
test('N1 pure: sameModel is case/whitespace-insensitive and tolerates a version suffix on either side', () => {
  assert.strictEqual(G.sameModel('Fable', 'fable 5.1'), true);
  assert.strictEqual(G.sameModel('Opus 5.5', 'opus'), true);
  assert.strictEqual(G.sameModel('Opus', 'Fable'), false);
  assert.strictEqual(G.sameModel(null, 'Opus'), false);
});
test('N1 pure: resolveActiveModelHint — opts.model wins, then FORGE_USAGE_GUARD_MODEL, else null (never guesses)', () => {
  assert.strictEqual(G.resolveActiveModelHint({ model: 'Sonnet' }), 'Sonnet');
  const saved = process.env.FORGE_USAGE_GUARD_MODEL;
  try {
    process.env.FORGE_USAGE_GUARD_MODEL = 'Haiku';
    assert.strictEqual(G.resolveActiveModelHint({}), 'Haiku');
    assert.strictEqual(G.resolveActiveModelHint({ model: 'Sonnet' }), 'Sonnet', 'an explicit opts.model still wins over the env seam');
  } finally {
    if (saved === undefined) delete process.env.FORGE_USAGE_GUARD_MODEL; else process.env.FORGE_USAGE_GUARD_MODEL = saved;
  }
  delete process.env.FORGE_USAGE_GUARD_MODEL;
  assert.strictEqual(G.resolveActiveModelHint({}), null, 'no source configured -> unknown, never a fabricated guess');
});
test('N1 pure: normalizeWindows carries the window\'s own model scope (null for session/weekly_all, the display_name for a scoped window) and a genuine tri-state isActive', () => {
  const w = G.normalizeWindows({
    five_hour: { utilization: 5, resets_at: null },
    limits: [
      { kind: 'weekly_scoped', group: 'weekly', percent: 100, is_active: false, resets_at: null, scope: { model: { display_name: 'Fable' } } },
      { kind: 'weekly_all', group: 'weekly', percent: 40, resets_at: null }, // typed, no scope.model -> global
    ],
  });
  const session = w.find((x) => x.kind === 'session');
  const fable = w.find((x) => x.kind === 'weekly_scoped');
  const weeklyAll = w.find((x) => x.kind === 'weekly_all');
  assert.strictEqual(session.model, null, 'the legacy session window is never per-model');
  assert.strictEqual(weeklyAll.model, null, 'a typed window with no scope.model is global, not per-model');
  assert.strictEqual(fable.model, 'Fable');
  assert.strictEqual(fable.isActive, false, 'an EXPLICIT is_active:false must survive as false, not be collapsed to "unknown"');
  const unset = G.normalizeWindows({ limits: [{ kind: 'daily', percent: 50 }] })[0];
  assert.strictEqual(unset.isActive, null, 'an ABSENT is_active must read as unknown (null), never silently "false"');
});
test('N1 pure: triggerCanResumeByModelSwitch — clears a pause caused SOLELY by a per-model trigger once the live window says is_active:false', () => {
  const before = G.normalizeWindows({ limits: [{ kind: 'weekly_scoped', percent: 100, is_active: true, scope: { model: { display_name: 'Fable' } } }] });
  const trigger = [{ id: before[0].id, name: before[0].label, metric: 'weekly_scoped', pct: 100, model: 'Fable' }];
  const nowInactive = G.normalizeWindows({ limits: [{ kind: 'weekly_scoped', percent: 100, is_active: false, scope: { model: { display_name: 'Fable' } } }] });
  assert.strictEqual(G.triggerCanResumeByModelSwitch(trigger, nowInactive, null), true, 'the live endpoint itself now says this window is not the one in force');
});
test('N1 pure: triggerCanResumeByModelSwitch — NEVER clears a pause that includes an all-models trigger, no matter the model hint', () => {
  const trigger = [{ id: 'session|session|session', name: 'session', metric: 'session', pct: 99, model: null }];
  assert.strictEqual(G.triggerCanResumeByModelSwitch(trigger, [], 'anything'), false, 'an account-wide limit is unaffected by which model is selected');
});
test('N1 pure: triggerCanResumeByModelSwitch FAIL SAFE — an unresolvable trigger (no live window, no hint) is treated as STILL applying, never auto-resumed on an absence of information', () => {
  const trigger = [{ id: 'weekly_scoped|weekly|gone', name: 'weekly_scoped (Fable)', metric: 'weekly_scoped', pct: 100, model: 'Fable' }];
  assert.strictEqual(G.triggerCanResumeByModelSwitch(trigger, [], null), false);
});

test('N1 integration: a full per-model window does NOT pause Forge while a DIFFERENT model has room in the all-models window — reported advisory, never silently dropped', async () => {
  const limits = [{ kind: 'weekly_scoped', group: 'weekly', percent: 100, is_active: false, resets_at: null, scope: { model: { display_name: 'Fable' } } }];
  const h = tickHarness({
    initialState: { mode: 'ok', account: { fp: 'n1-advisory', source: 'account-uuid' } },
    deps: {
      readIdentity: () => ({ fp: 'n1-advisory', source: 'account-uuid' }),
      fetchUsage: async () => usageWithLimits(5, 50, limits), // session 5%, week 50% — both well under pause-at
    },
  });
  await G.tick(h.deps);
  assert.strictEqual(h.calls.doPause.length, 0, 'a per-model window at 100% must never pause a session that is not using that model — this is the exact N1 bug');
  assert.ok(h.calls.logs.some((l) => /ADVISORY/.test(l) && /Fable/.test(l) && /100/.test(l)), 'the guard must still say so plainly in the log, never silently drop it: ' + JSON.stringify(h.calls.logs));
});

test('N1 integration: the SAME per-model window DOES pause once the endpoint marks it is_active — the live signal is authoritative', async () => {
  const limits = [{ kind: 'weekly_scoped', group: 'weekly', percent: 100, is_active: true, resets_at: null, scope: { model: { display_name: 'Fable' } } }];
  const h = tickHarness({
    initialState: { mode: 'ok', account: { fp: 'n1-active', source: 'account-uuid' } },
    deps: {
      readIdentity: () => ({ fp: 'n1-active', source: 'account-uuid' }),
      fetchUsage: async () => usageWithLimits(5, 50, limits),
    },
  });
  await G.tick(h.deps);
  assert.strictEqual(h.calls.doPause.length, 1, 'is_active:true is the authoritative live signal — it must still pause');
  assert.ok(h.calls.doPause[0].crossed.every((c) => c.model === 'Fable'), 'the trigger must carry the window\'s model, needed later for a model-switch resume');
});

test('N1 integration: "switching models is enough" — a pause caused solely by one per-model window auto-resumes once the live endpoint no longer marks it is_active, even though its percent is still 100', async () => {
  const seedWindows = G.normalizeWindows({ limits: [{ kind: 'weekly_scoped', group: 'weekly', percent: 100, is_active: true, scope: { model: { display_name: 'Fable' } } }] });
  const h = tickHarness({ initialState: { mode: 'ok' } });
  h.state.value = {
    mode: 'paused',
    trigger: [{ id: seedWindows[0].id, name: seedWindows[0].label, metric: 'weekly_scoped', pct: 100, resetsAt: null, model: 'Fable' }],
    pauseAt: 98, resumeAt: 0,
    account: { fp: 'n1-resume', source: 'account-uuid' },
    pausedAgents: [],
  };
  h.deps.readIdentity = () => ({ fp: 'n1-resume', source: 'account-uuid' });
  h.deps.fetchUsage = async () => usageWithLimits(5, 50, [{ kind: 'weekly_scoped', group: 'weekly', percent: 100, is_active: false, resets_at: null, scope: { model: { display_name: 'Fable' } } }]);
  await G.tick(h.deps);
  assert.strictEqual(h.calls.doResume.length, 1, 'the endpoint itself now says the Fable window is not the one in force — switching models must be enough to resume: ' + JSON.stringify(h.calls));
});

test('N1 integration: a pause that ALSO includes an all-models window is never lifted just because the per-model trigger stopped being active', async () => {
  const seedWindows = G.normalizeWindows({ limits: [{ kind: 'weekly_scoped', group: 'weekly', percent: 100, is_active: true, scope: { model: { display_name: 'Fable' } } }] });
  const h = tickHarness({ initialState: { mode: 'ok' } });
  h.state.value = {
    mode: 'paused',
    trigger: [
      { id: 'weekly_all|weekly|weekly_all', name: 'weekly_all', metric: 'weekly_all', pct: 99, resetsAt: null, model: null },
      { id: seedWindows[0].id, name: seedWindows[0].label, metric: 'weekly_scoped', pct: 100, resetsAt: null, model: 'Fable' },
    ],
    pauseAt: 98, resumeAt: 0,
    account: { fp: 'n1-mixed', source: 'account-uuid' },
    pausedAgents: [],
  };
  h.deps.readIdentity = () => ({ fp: 'n1-mixed', source: 'account-uuid' });
  // weekly_all is STILL at 99% (over pause-at) — an unaffected model switch must never lift this.
  h.deps.fetchUsage = async () => usageWithLimits(5, 99, [{ kind: 'weekly_scoped', group: 'weekly', percent: 100, is_active: false, resets_at: null, scope: { model: { display_name: 'Fable' } } }]);
  await G.tick(h.deps);
  assert.strictEqual(h.calls.doResume.length, 0, 'an all-models window in the trigger mix must keep the pause regardless of any per-model switch: ' + JSON.stringify(h.calls));
});

// ============================================================================================
// N8 — fresh-laptop re-audit, 2026-09-26: an upgrade (raw fingerprint -> opaque label) must never
// read as a real account switch and reset guard state / resume paused agents.
// ============================================================================================
test('N8 pure: detectAccountSwitch — a state stamped with the OLD raw fingerprint is an upgrade, not a switch, when ident.rawFp proves it is the SAME account', () => {
  const r = G.detectAccountSwitch({ account: { fp: 'aaaaaaaaaaaa' } }, { fp: 'account-1-abc123', source: 'account-uuid', rawFp: 'aaaaaaaaaaaa' });
  assert.strictEqual(r.switched, false, 'the raw fingerprint matches this account\'s CURRENT fingerprint — only the label scheme changed: ' + JSON.stringify(r));
  assert.strictEqual(r.to, 'account-1-abc123');
});
test('N8 pure: detectAccountSwitch — WITHOUT a matching rawFp, a differently-shaped fp is still a real switch (no regression on the existing contract)', () => {
  const r = G.detectAccountSwitch({ account: { fp: 'aaaaaaaaaaaa' } }, { fp: 'bbbbbbbbbbbb', source: 'account-uuid' });
  assert.strictEqual(r.switched, true, 'a plain ident with no rawFp field must behave exactly as before this fix — existing callers/tests are unaffected');
});
test('N8 integration: stateForAccount migrates an old raw-fingerprint stamp to the new opaque label WITHOUT resetting mode/pausedAgents/trigger', () => {
  const prev = {
    mode: 'paused', pausedAgents: [{ id: 'agent-1', name: 'A1' }],
    trigger: [{ id: 'session|session|session', name: 'session', metric: 'session', pct: 99 }],
    percents: { session: 99, week: 50 },
    account: { fp: 'aaaaaaaaaaaa', source: 'account-uuid' }, // the pre-2.7.2 shape: the raw fp stored directly
  };
  const ident = { fp: 'account-1-abc123', source: 'account-uuid', rawFp: 'aaaaaaaaaaaa' };
  const next = G.stateForAccount(prev, ident);
  assert.strictEqual(next.mode, 'paused', 'an upgrade must never resume a real, still-active pause');
  assert.deepStrictEqual(next.pausedAgents, prev.pausedAgents, 'an upgrade must never forget which agents are paused');
  assert.deepStrictEqual(next.trigger, prev.trigger);
  assert.strictEqual(next.account.fp, 'account-1-abc123', 'the stamp itself IS migrated to the new label');
  assert.strictEqual(next.previousAccount, undefined, 'this must never be recorded as a real account switch');
});

// ============================================================================================
// Part II — fresh-laptop re-audit, 2026-09-26: a pid file pointing at a dead process must be
// detected and cleaned (a hard kill/crash/reboot can always leave one behind; see
// cleanupStalePidFile's own header for why this can never be fully prevented, only reacted to).
// ============================================================================================
test('Part II pure: cleanupStalePidFile removes a pid file whose process is provably dead', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-pid-cleanup-'));
  const pidFile = path.join(dir, 'watcher.pid');
  try {
    // a pid that is essentially guaranteed not to exist as a live process on this machine
    fs.writeFileSync(pidFile, JSON.stringify({ pid: 999999, script: __filename }) + '\n');
    const r = G.cleanupStalePidFile(pidFile, { pid: 999999, script: __filename });
    assert.strictEqual(r.removed, true, JSON.stringify(r));
    assert.ok(!fs.existsSync(pidFile), 'the stale pid file must actually be gone');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('Part II pure: cleanupStalePidFile leaves a genuinely alive process\'s pid file alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-pid-cleanup2-'));
  const pidFile = path.join(dir, 'watcher.pid');
  try {
    fs.writeFileSync(pidFile, JSON.stringify({ pid: process.pid, script: __filename }) + '\n');
    // this test process itself is alive but is NOT running usage-guard.cjs's `watch` subcommand, so
    // ownsPid() classifies it 'not-watcher' (provably not a live watcher) — still safe to remove.
    const r = G.cleanupStalePidFile(pidFile, { pid: process.pid, script: __filename });
    assert.strictEqual(r.removed, true, 'a live process that is provably NOT the watcher is still safe to clean up: ' + JSON.stringify(r));
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
});
test('Part II pure: cleanupStalePidFile never touches an empty/absent pid file', () => {
  const r = G.cleanupStalePidFile('/does/not/exist/watcher.pid', { pid: 0 });
  assert.strictEqual(r.removed, false);
});
// WP-S14 finding 1.1 (2026-09-26 independent review): status read the pid record, judged it dead, then
// deleted it with no re-check — a `start` claiming the slot in the meantime (ownsPid's Windows CIM query /
// POSIX /proc read is slow enough for that) got its brand-new record deleted, leaving the account
// unguarded. Simulate that race DETERMINISTICALLY: the injected `verify` seam rewrites the pid file (as a
// concurrent `start` would) as a side effect of its own (slow, real) verification call.
test('WP-S14 1.1: cleanupStalePidFile refuses to delete a pid file that changed to a new live claim between the dead-check and the delete', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-pid-race-'));
  const pidFile = path.join(dir, 'watcher.pid');
  try {
    fs.writeFileSync(pidFile, JSON.stringify({ pid: 999999, startedAt: 't1', nonce: 'old', script: __filename }) + '\n');
    const raceVerify = () => {
      // simulate a concurrent `start` claiming the slot WHILE our (slow) verify call is still running
      fs.writeFileSync(pidFile, JSON.stringify({ pid: process.pid, startedAt: 't2', nonce: 'new', script: __filename }) + '\n');
      return { ok: false, code: 'dead', reason: 'process not running' };
    };
    const r = G.cleanupStalePidFile(pidFile, { pid: 999999 }, { verify: raceVerify });
    assert.strictEqual(r.removed, false, 'must refuse once the file changed under it: ' + JSON.stringify(r));
    assert.ok(fs.existsSync(pidFile), 'the new live claim must survive the cleanup');
    const survived = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
    assert.strictEqual(survived.pid, process.pid, 'the NEW claim must still be the one on disk, untouched');
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
});
test('WP-S14 1.1: cleanupStalePidFile still removes the file when nothing changed between the dead-check and the delete', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-pid-race-nochange-'));
  const pidFile = path.join(dir, 'watcher.pid');
  try {
    fs.writeFileSync(pidFile, JSON.stringify({ pid: 999999, startedAt: 't1', nonce: 'old', script: __filename }) + '\n');
    const r = G.cleanupStalePidFile(pidFile, { pid: 999999 });
    assert.strictEqual(r.removed, true, 'the ordinary no-race case must still clean up: ' + JSON.stringify(r));
    assert.ok(!fs.existsSync(pidFile));
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
});

// ============================================================================================
// Part V-D — fresh-laptop re-audit, 2026-09-26: pause/resume/account-switch notices must follow
// the owner's `language` setting (auto/en/nl), English as the fallback — not Dutch-only.
// ============================================================================================
test('Part V-D pure: pickLang picks nl only for the literal "nl" language, English for anything else (including undefined/auto/unknown)', () => {
  assert.strictEqual(G.pickLang('nl', 'NL-TEXT', 'EN-TEXT'), 'NL-TEXT');
  assert.strictEqual(G.pickLang('en', 'NL-TEXT', 'EN-TEXT'), 'EN-TEXT');
  assert.strictEqual(G.pickLang(undefined, 'NL-TEXT', 'EN-TEXT'), 'EN-TEXT');
  assert.strictEqual(G.pickLang('auto', 'NL-TEXT', 'EN-TEXT'), 'EN-TEXT');
});
test('Part V-D pure: resolveGuardLanguage falls back to English when forge-config.cjs is unavailable — never throws, never silently NL', () => {
  assert.strictEqual(G.resolveGuardLanguage({ configModule: null }), 'en');
});
test('Part V-D integration: stateForAccount\'s accountSwitchNotice follows the lang argument (English default when omitted, matching every pre-existing 2-argument call/test)', () => {
  const prev = { mode: 'ok', account: { fp: 'aaaaaaaaaaaa' } };
  const identB = { fp: 'bbbbbbbbbbbb', source: 'account-uuid' };
  const nextDefault = G.stateForAccount(prev, identB);
  assert.ok(/ACCOUNT SWITCH detected/.test(nextDefault.accountSwitchNotice), 'omitting lang must default to English: ' + nextDefault.accountSwitchNotice);
  const nextNl = G.stateForAccount(prev, identB, 'nl');
  assert.ok(/ACCOUNT SWITCH gedetecteerd/.test(nextNl.accountSwitchNotice), 'lang "nl" must produce the Dutch notice: ' + nextNl.accountSwitchNotice);
});
test('Part V-D integration: doPause\'s state.notice follows opts.lang (English default) — no longer Dutch-only regardless of the owner\'s language setting', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-lang-pause-'));
  const stateFile = path.join(dir, 'state.json');
  const saved = { FORGE_USAGE_GUARD_STATE: process.env.FORGE_USAGE_GUARD_STATE, FORGE_USAGE_GUARD_DENY_NETWORK: process.env.FORGE_USAGE_GUARD_DENY_NETWORK };
  process.env.FORGE_USAGE_GUARD_STATE = stateFile;
  delete require.cache[require.resolve('./usage-guard.cjs')];
  const GL = require('./usage-guard.cjs');
  try {
    const u = { session: { pct: 99, resetsAt: null }, week: { pct: 40, resetsAt: null } };
    const crossed = [{ id: 'session|session|session', name: 'session', pct: 99, metric: 'session', resetsAt: null, model: null }];
    await GL.doPause(u, crossed, { fp: 'lang-test', source: 'account-uuid' }, { lang: 'en' });
    const stEn = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.ok(/PAUSED/.test(stEn.notice) && !/PAUZEER/.test(stEn.notice), 'lang:"en" must produce the English notice: ' + stEn.notice);
    await GL.doPause(u, crossed, { fp: 'lang-test', source: 'account-uuid' }, { lang: 'nl' });
    const stNl = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.ok(/PAUZEER/.test(stNl.notice), 'lang:"nl" must produce the Dutch notice: ' + stNl.notice);
  } finally {
    delete require.cache[require.resolve('./usage-guard.cjs')];
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('N1 integration: doPause\'s notice names the paused window and adds the "switching models is enough" line ONLY when every crossed window is per-model', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-switchnote-'));
  const stateFile = path.join(dir, 'state.json');
  const saved = process.env.FORGE_USAGE_GUARD_STATE;
  process.env.FORGE_USAGE_GUARD_STATE = stateFile;
  delete require.cache[require.resolve('./usage-guard.cjs')];
  const GL = require('./usage-guard.cjs');
  try {
    const u = { session: { pct: 5, resetsAt: null }, week: { pct: 50, resetsAt: null } };
    const perModelOnly = [{ id: 'weekly_scoped|weekly|weekly_scoped (Fable)', name: 'weekly_scoped (Fable)', pct: 100, metric: 'weekly_scoped', resetsAt: null, model: 'Fable' }];
    await GL.doPause(u, perModelOnly, { fp: 'switchnote-1', source: 'account-uuid' }, { lang: 'en' });
    const st1 = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.ok(/Fable/.test(st1.notice), 'the notice must name the window that paused Forge: ' + st1.notice);
    assert.ok(/[Ss]witching to a different model is enough/.test(st1.notice), 'every crossed window is per-model — the switch-note must appear: ' + st1.notice);

    const mixed = [
      { id: 'weekly_all|weekly|weekly_all', name: 'weekly_all', pct: 99, metric: 'weekly_all', resetsAt: null, model: null },
      { id: 'weekly_scoped|weekly|weekly_scoped (Fable)', name: 'weekly_scoped (Fable)', pct: 100, metric: 'weekly_scoped', resetsAt: null, model: 'Fable' },
    ];
    await GL.doPause(u, mixed, { fp: 'switchnote-2', source: 'account-uuid' }, { lang: 'en' });
    const st2 = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.ok(!/switching to a different model is enough/i.test(st2.notice), 'an all-models window in the mix must NEVER claim a model switch would help: ' + st2.notice);
  } finally {
    delete require.cache[require.resolve('./usage-guard.cjs')];
    if (saved === undefined) delete process.env.FORGE_USAGE_GUARD_STATE; else process.env.FORGE_USAGE_GUARD_STATE = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

Promise.all(asyncQueue).then(() => {
console.log('\n' + pass + ' passed, ' + fail + ' failed');
  fs.readFileSync = realFsReadFileSync; // TEST-CREDENTIAL-ISOLATION: restore before the process exits
  try { fs.rmSync(ISOLATED_HOME_ROOT, { recursive: true, force: true }); } catch { }
  process.exit(fail ? 1 : 0);
});
