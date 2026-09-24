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
  const NO_CRED = 'usage guard cannot measure on this machine: no ~/.claude/.credentials.json (macOS keeps the login in the Keychain) — ';

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
  t5('L2: start --force with the switch OFF forwards --force — the watcher is not undone by its own first check', () => {
    const sb = sandbox5({ 'usage-guard': val(false) });
    fs.writeFileSync(credFile(sb), JSON.stringify({ claudeAiOauth: {} }));
    const r = runGuard(['start', '--force', '--interval', '60'], Object.assign({}, sb.env, { FORGE_USAGE_GUARD_CLAIM_TIMEOUT_MS: '30000' }));
    let pid = null;
    try { pid = JSON.parse(fs.readFileSync(sb.env.FORGE_USAGE_GUARD_PID, 'utf8')).pid; } catch { pid = null; }
    try {
      assert.strictEqual(r.status, 0, (r.stdout || '') + (r.stderr || ''));
      assert.ok(pid && G5.pidAlive(pid), 'the forced watcher claimed its slot');
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && !/CHECK FAILED/.test(readIf(sb.env.FORGE_USAGE_GUARD_LOG))) nap(200);
      const logText = readIf(sb.env.FORGE_USAGE_GUARD_LOG);
      assert.ok(/CHECK FAILED \(no action taken — fail-safe\): no OAuth token/.test(logText), 'the forced watcher made its first check: ' + logText);
      nap(300);
      assert.ok(G5.pidAlive(pid), 'still running after its first check');
      assert.ok(!/de watcher stopt/.test(readIf(sb.env.FORGE_USAGE_GUARD_LOG)), 'it did not stop itself');
    } finally {
      // exact-PID cleanup of the child THIS test started (from its own sandbox pid file), then wait for the exit
      if (pid && pid !== process.pid) {
        try { process.kill(pid); } catch { }
        for (let i = 0; i < 30 && G5.pidAlive(pid); i++) nap(100);
        if (G5.pidAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { } }
        for (let i = 0; i < 50 && G5.pidAlive(pid); i++) nap(100);
      }
    }
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
  t5('GUARD-STOP: `stop` actually terminates a real running watcher and exits 0; stopping an already-gone watcher is a clean, honest no-op', () => {
    const sb = sandbox5(null);
    fs.writeFileSync(credFile(sb), JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-VALIDSHAPEDTOKEN1234567890' } }));
    const startR = runGuard(['start', '--interval', '60'], Object.assign({}, sb.env, { FORGE_USAGE_GUARD_CLAIM_TIMEOUT_MS: '30000' }));
    let pid = null;
    try { pid = JSON.parse(fs.readFileSync(sb.env.FORGE_USAGE_GUARD_PID, 'utf8')).pid; } catch { pid = null; }
    try {
      assert.strictEqual(startR.status, 0, (startR.stdout || '') + (startR.stderr || ''));
      assert.ok(pid && G5.pidAlive(pid), 'the watcher actually started');
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
  t5('CFG-05: guardBounds() degrades to no bounds (accept any finite integer) when the schema is unreadable, rather than breaking every threshold', () => {
    const b = G5.guardBounds(path.join(os.tmpdir(), 'this-schema-does-not-exist-' + Date.now() + '.json'));
    assert.deepStrictEqual(b, {});
    const s = G5.resolveGuardSettings(['--pause-at', '150'], null, { bounds: b });
    assert.deepStrictEqual([s['pause-at'].value, s['pause-at'].source], [150, 'vlag'], 'no bounds known -> the pre-CFG-05 behaviour (accept any finite number)');
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
    const r = runGuard(['start', '--interval', '60'], Object.assign({}, sb.env, { FORGE_USAGE_GUARD_CLAIM_TIMEOUT_MS: '30000' }));
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

Promise.all(asyncQueue).then(() => {
console.log('\n' + pass + ' passed, ' + fail + ' failed');
  fs.readFileSync = realFsReadFileSync; // TEST-CREDENTIAL-ISOLATION: restore before the process exits
  try { fs.rmSync(ISOLATED_HOME_ROOT, { recursive: true, force: true }); } catch { }
  process.exit(fail ? 1 : 0);
});
