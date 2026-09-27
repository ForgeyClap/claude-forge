#!/usr/bin/env node
'use strict';
// log-event-review-dispatch-warning.test.cjs — v2.9.0 lesson fix (WP-J1, 2026-09-27).
//
// REAL INCIDENT: the Lead logged `subagent_started` for a reviewer with `role:"reviewer"` and
// `task:"independent read-only verification review of v2.8.1"`. forge-runcontract.cjs's own
// isReviewDispatch() rejected it — "v2.8.1" is not in its REVIEW_WOORDEN allowlist — so the dispatch counted
// as WORK, and that reviewer could never be the run's independent reviewer. The hash-chained log could not be
// corrected after the fact.
//
// THIS FILE proves: (1) log-event.cjs's writer now WARNS (never refuses — the event is still written) on
// exactly this shape: a dispatch START/creation event whose role field reads like a reviewer per
// forge-runcontract.cjs's own REVIEW_ROLE_RE, but whose task/mission does not pass isReviewDispatch(); (2) a
// genuinely pure-review dispatch stays silent (no false positive); (3) an ordinary work dispatch (no
// reviewer-shaped role at all) stays silent; (4) the warning is REUSING forge-runcontract.cjs's own
// isReviewDispatch(), never a re-typed copy of its rules — proven by monkey-patching the live export and
// observing log-event.cjs's verdict change accordingly; (5) end to end through the real spawned CLI: exit
// code 0 (never refused), a plain NL+EN warning on stderr, and `_forge_verify.review_dispatch_counts_as_work`
// really lands in the written events.jsonl line.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

const LE = require('../forge-dashboard/log-event.cjs');
const RC = require('./forge-runcontract.cjs');

console.log('log-event review-dispatch warning tests (WP-J1)');

function baseEvent(extra) {
  // agent:'Build Boss' (a real registered Boss) + dispatch_id present so the UNRELATED agent/dispatch STRICT
  // checks never interfere with what this suite is actually testing.
  return Object.assign({ run_id: 'wp-j1-unit-test-not-a-real-run', event_type: 'subagent_started', agent: 'Build Boss', dispatch_id: 'toolu_wpj1test' }, extra);
}

console.log('\n1) fires exactly on the reported incident shape, event still written (never refused)');
t('reviewer role + a task word outside REVIEW_WOORDEN ("v2.8.1") -> warned, not refused', () => {
  const ev = baseEvent({ role: 'reviewer', task: 'independent read-only verification review of v2.8.1' });
  const val = LE.validateForWrite(ev);
  assert.strictEqual(val.ok, true, 'the event must still be written: ' + JSON.stringify(val));
  assert.strictEqual(val.verify && val.verify.review_dispatch_counts_as_work, true, JSON.stringify(val.verify));
  assert.ok(/counts as WORK/.test(val.verify.review_dispatch_warning), val.verify.review_dispatch_warning);
  assert.ok(/telt.*als WERK/.test(val.verify.review_dispatch_warning), 'missing the Dutch half: ' + val.verify.review_dispatch_warning);
  // the mutated event itself (what actually gets appended to events.jsonl) carries the stamp too
  assert.strictEqual(ev._forge_verify.review_dispatch_counts_as_work, true);
  // this must be a live re-derivation, not a fixed string — sanity check the flagged FIELD NAME appears
  // (v2.9.0 WP-K2, Codex F8: the field's raw VALUE — "reviewer" — must NOT appear here any more, only the
  // field name "role"; see the dedicated F8 suite below for the full raw-value-never-leaks proof).
  assert.ok(val.verify.review_dispatch_warning.includes('fields: role'), val.verify.review_dispatch_warning);
  assert.ok(!val.verify.review_dispatch_warning.includes('"reviewer"'), 'F8 regression: the raw field VALUE leaked into the warning: ' + val.verify.review_dispatch_warning);
});
t('confirms this is really forge-runcontract.cjs\'s own verdict: isReviewDispatch(the same event) is false', () => {
  const ev = baseEvent({ role: 'reviewer', task: 'independent read-only verification review of v2.8.1' });
  assert.strictEqual(RC.isReviewDispatch(ev), false);
});

console.log('\n2) no false positive: a genuinely pure-review dispatch stays silent');
t('reviewer role + a task built entirely from REVIEW_WOORDEN -> no warning', () => {
  const ev = baseEvent({ role: 'reviewer', task: 'review the diff' });
  const val = LE.validateForWrite(ev);
  assert.strictEqual(val.ok, true);
  // val.verify legitimately still carries the UNRELATED agent_registered:true stamp (a registered "Build
  // Boss" dispatch always gets that) — only review_dispatch_counts_as_work must be absent here.
  assert.ok(!val.verify || !val.verify.review_dispatch_counts_as_work, JSON.stringify(val.verify));
  assert.strictEqual(RC.isReviewDispatch(ev), true, 'sanity check: the contract really does accept this one');
});

console.log('\n3) no over-firing: an ordinary work dispatch (no reviewer-shaped role) stays silent');
t('role:"implementation" -> never even checked against isReviewDispatch, no warning', () => {
  const ev = baseEvent({ role: 'implementation', task: 'implement the login feature' });
  const val = LE.validateForWrite(ev);
  assert.strictEqual(val.ok, true);
  assert.ok(!val.verify || !val.verify.review_dispatch_counts_as_work, JSON.stringify(val.verify));
});
t('a reviewer role with NO task/mission at all also warns (unknown intent is not evidence of review either)', () => {
  const ev = baseEvent({ role: 'reviewer' });
  const val = LE.validateForWrite(ev);
  assert.strictEqual(val.ok, true);
  assert.strictEqual(val.verify && val.verify.review_dispatch_counts_as_work, true, JSON.stringify(val.verify));
});
t('a non-dispatch event type (e.g. agent_progress) is never checked at all, even with a reviewer-shaped role', () => {
  const ev = { run_id: 'wp-j1-unit-test-not-a-real-run', event_type: 'agent_progress', agent: 'Build Boss', role: 'reviewer', note: 'still going' };
  const val = LE.validateForWrite(ev);
  assert.ok(!val.verify || !val.verify.review_dispatch_counts_as_work, JSON.stringify(val.verify));
});

console.log('\n4) REUSE, not a copy: log-event.cjs defers to forge-runcontract.cjs\'s own live isReviewDispatch()');
t('monkey-patching the shared RC.isReviewDispatch export changes log-event.cjs\'s verdict — proves it is the same live function, never a re-typed ruleset', () => {
  const original = RC.isReviewDispatch;
  try {
    RC.isReviewDispatch = () => true; // pretend everything is a pure review, even the "v2.8.1" shape
    const ev = baseEvent({ role: 'reviewer', task: 'independent read-only verification review of v2.8.1' });
    const val = LE.validateForWrite(ev);
    assert.ok(!val.verify || !val.verify.review_dispatch_counts_as_work, 'log-event.cjs must follow the patched contract verdict: ' + JSON.stringify(val.verify));
  } finally {
    RC.isReviewDispatch = original;
  }
});

console.log('\n5) end to end through the real spawned CLI (sandbox: log-event.cjs + forge-runcontract.cjs + registry)');
{
  const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'logev-revwarn-'));
  fs.mkdirSync(path.join(SB, '.claude', 'forge-dashboard'), { recursive: true });
  fs.mkdirSync(path.join(SB, '.claude', 'forge-bin'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'forge-dashboard', 'log-event.cjs'), path.join(SB, '.claude', 'forge-dashboard', 'log-event.cjs'));
  fs.copyFileSync(path.join(__dirname, 'forge-runcontract.cjs'), path.join(SB, '.claude', 'forge-bin', 'forge-runcontract.cjs'));
  try {
    fs.mkdirSync(path.join(SB, '.claude', 'config', 'agents'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', 'config', 'agents', 'agent-registry.json'), path.join(SB, '.claude', 'config', 'agents', 'agent-registry.json'));
  } catch { /* registry optioneel, zelfde als de concurrency-suite */ }
  const LOGEVT = path.join(SB, '.claude', 'forge-dashboard', 'log-event.cjs');
  const RUN_ID = 'wp-j1-cli-test';
  const payload = JSON.stringify({ agent: 'Build Boss', dispatch_id: 'toolu_wpj1cli', role: 'reviewer', task: 'independent read-only verification review of v2.8.1' });

  t('CLI: exits 0 (event still written, never refused) and prints the plain NL+EN warning on stderr', () => {
    const r = spawnSync(process.execPath, [LOGEVT, RUN_ID, 'subagent_started', payload], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, 'stdout=' + r.stdout + ' stderr=' + r.stderr);
    assert.ok(/WARNING/.test(r.stderr), 'stderr: ' + r.stderr);
    assert.ok(/counts as WORK/.test(r.stderr), 'stderr: ' + r.stderr);
    assert.ok(/telt.*als WERK/.test(r.stderr), 'stderr missing the Dutch half: ' + r.stderr);
  });
  t('the written events.jsonl line really carries _forge_verify.review_dispatch_counts_as_work:true', () => {
    const lines = fs.readFileSync(path.join(SB, '.claude', 'forge-runs', RUN_ID, 'events.jsonl'), 'utf8').split(/\r?\n/).filter((s) => s.trim());
    const last = JSON.parse(lines[lines.length - 1]);
    assert.strictEqual(last.event_type, 'subagent_started');
    assert.strictEqual(last._forge_verify && last._forge_verify.review_dispatch_counts_as_work, true, JSON.stringify(last._forge_verify));
  });
  t('CLI: a pure-review task on the same shape exits 0 with NO warning on stderr', () => {
    const okPayload = JSON.stringify({ agent: 'Build Boss', dispatch_id: 'toolu_wpj1cli2', role: 'reviewer', task: 'review the diff' });
    const r = spawnSync(process.execPath, [LOGEVT, RUN_ID, 'subagent_started', okPayload], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, 'stdout=' + r.stdout + ' stderr=' + r.stderr);
    assert.ok(!/WARNING/.test(r.stderr), 'stderr: ' + r.stderr);
  });
  fs.rmSync(SB, { recursive: true, force: true });
}

console.log('\n6) F8 (Codex v2.9.0 WP-K2) — the warning NEVER echoes a raw field VALUE, only field NAMES');
t('a secret-shaped value in an unrelated role-ish field (purpose) never leaks into _forge_verify', () => {
  const ev = baseEvent({ role: 'reviewer', purpose: 'access_token=abc123', task: 'independent read-only verification review of v2.8.1' });
  const val = LE.validateForWrite(ev);
  assert.strictEqual(val.ok, true, JSON.stringify(val));
  assert.strictEqual(val.verify && val.verify.review_dispatch_counts_as_work, true, JSON.stringify(val.verify));
  assert.ok(!val.verify.review_dispatch_warning.includes('access_token=abc123'), 'F8: raw secret-shaped value leaked into the warning: ' + val.verify.review_dispatch_warning);
  assert.ok(!val.verify.review_dispatch_warning.includes('abc123'), 'F8: raw secret leaked (partial): ' + val.verify.review_dispatch_warning);
  assert.ok(val.verify.review_dispatch_warning.includes('purpose'), 'the field NAME "purpose" should still be named: ' + val.verify.review_dispatch_warning);
  assert.ok(val.verify.review_dispatch_warning.includes('role'), 'the field NAME "role" should still be named: ' + val.verify.review_dispatch_warning);
  // the event's OWN field is untouched (that is the caller's own data, unrelated to this fix) — only the
  // WARNING must never repeat it a second time.
  assert.strictEqual(ev.purpose, 'access_token=abc123');
});

t('CLI end-to-end: the secret-shaped purpose value never appears on stderr, only the field name', () => {
  const SB2 = fs.mkdtempSync(path.join(os.tmpdir(), 'logev-revwarn-f8-'));
  fs.mkdirSync(path.join(SB2, '.claude', 'forge-dashboard'), { recursive: true });
  fs.mkdirSync(path.join(SB2, '.claude', 'forge-bin'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'forge-dashboard', 'log-event.cjs'), path.join(SB2, '.claude', 'forge-dashboard', 'log-event.cjs'));
  fs.copyFileSync(path.join(__dirname, 'forge-runcontract.cjs'), path.join(SB2, '.claude', 'forge-bin', 'forge-runcontract.cjs'));
  try {
    fs.mkdirSync(path.join(SB2, '.claude', 'config', 'agents'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', 'config', 'agents', 'agent-registry.json'), path.join(SB2, '.claude', 'config', 'agents', 'agent-registry.json'));
  } catch { /* registry optioneel, zelfde als de concurrency-suite */ }
  const LOGEVT2 = path.join(SB2, '.claude', 'forge-dashboard', 'log-event.cjs');
  const payload = JSON.stringify({ agent: 'Build Boss', dispatch_id: 'toolu_wpj1f8', role: 'reviewer', purpose: 'access_token=abc123', task: 'independent read-only verification review of v2.8.1' });
  const r = spawnSync(process.execPath, [LOGEVT2, 'wp-k2-f8-cli-test', 'subagent_started', payload], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, 'stdout=' + r.stdout + ' stderr=' + r.stderr);
  assert.ok(/WARNING/.test(r.stderr), 'stderr: ' + r.stderr);
  assert.ok(!r.stderr.includes('access_token=abc123'), 'F8: secret leaked on stderr: ' + r.stderr);
  assert.ok(!r.stderr.includes('abc123'), 'F8: partial secret leaked on stderr: ' + r.stderr);
  fs.rmSync(SB2, { recursive: true, force: true });
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
