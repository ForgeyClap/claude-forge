#!/usr/bin/env node
'use strict';
/**
 * usage-guard-override.test.cjs — unit tests for the credits-override DEFENSE IN DEPTH layer (V15, FOURTH
 * Codex recheck, 2026-09-24). See usage-guard-override.cjs's own header for WHY this file exists. No
 * network, no real project — every scenario points `projectRoot` at its own scratch temp dir.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const O = require('./usage-guard-override.cjs');
const Grant = require('./forge-ownergrant.cjs');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error('  FAIL ' + name + ' — ' + e.message); } };

console.log('usage-guard-override tests (V15 defense-in-depth)');

function scratchRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'guard-override-')); }

t('resolveOwnerOverride: no grant file at all -> inactive', () => {
  const dir = scratchRoot();
  const r = O.resolveOwnerOverride({ projectRoot: dir });
  assert.strictEqual(r.active, false);
});

const FUTURE = new Date(Date.now() + 3600000).toISOString();

t('resolveOwnerOverride: a real, unexpired grant for the SAME account -> active, and the record is returned for cache rebuilding', () => {
  const dir = scratchRoot();
  Grant.writeOverrideGrant({ active: true, at: '2026-09-24T00:00:00.000Z', reason: 'test', until: FUTURE, accountLabel: 'acct-x' }, { projectRoot: dir });
  const r = O.resolveOwnerOverride({ projectRoot: dir, accountLabel: 'acct-x' });
  assert.strictEqual(r.active, true);
  assert.strictEqual(r.record.reason, 'test');
  assert.strictEqual(r.rejected, undefined);
});

t('resolveOwnerOverride: an EXPIRED grant -> inactive, regardless of what a caller\'s cache might separately claim', () => {
  const dir = scratchRoot();
  Grant.writeOverrideGrant({ active: true, at: new Date().toISOString(), until: '2020-01-01T00:00:00.000Z', accountLabel: 'acct-x' }, { projectRoot: dir });
  const r = O.resolveOwnerOverride({ projectRoot: dir, accountLabel: 'acct-x' });
  assert.strictEqual(r.active, false);
  assert.strictEqual(r.rejected, null, 'an ordinary expired grant is not a REJECTED grant — there is simply no active grant');
});

// ---- N10 (2026-09-24, Security Boss addendum reconfirmed): ACCOUNT BINDING — a grant for one account must
// never suppress pausing for a DIFFERENT, an UNKNOWN, or a label-less-grant's current account. ----
t('N10: a grant bound to account A is REJECTED (override OFF) when the CURRENT account is B (foreign-account)', () => {
  const dir = scratchRoot();
  Grant.writeOverrideGrant({ active: true, at: new Date().toISOString(), until: FUTURE, reason: 'granted for A', accountLabel: 'account-a' }, { projectRoot: dir });
  const r = O.resolveOwnerOverride({ projectRoot: dir, accountLabel: 'account-b' });
  assert.strictEqual(r.active, false, 'account B must never inherit account A\'s override: ' + JSON.stringify(r));
  assert.strictEqual(r.rejected, 'foreign-account');
});
t('N10: a LABEL-LESS (legacy) grant is REJECTED even though the current identity IS known', () => {
  const dir = scratchRoot();
  Grant.writeOverrideGrant({ active: true, at: new Date().toISOString(), until: FUTURE, reason: 'legacy, no accountLabel' }, { projectRoot: dir });
  const r = O.resolveOwnerOverride({ projectRoot: dir, accountLabel: 'account-known' });
  assert.strictEqual(r.active, false, 'a grant with no account binding at all must never be honoured: ' + JSON.stringify(r));
  assert.strictEqual(r.rejected, 'label-less-grant');
});
t('N10: an otherwise-valid grant is REJECTED when the CURRENT identity is unknown (unverifiable) — fail-safe means override OFF, never ON, when identity cannot be proven', () => {
  const dir = scratchRoot();
  Grant.writeOverrideGrant({ active: true, at: new Date().toISOString(), until: FUTURE, reason: 'granted for A', accountLabel: 'account-a' }, { projectRoot: dir });
  const r1 = O.resolveOwnerOverride({ projectRoot: dir, accountLabel: null });
  const r2 = O.resolveOwnerOverride({ projectRoot: dir }); // accountLabel omitted entirely
  assert.strictEqual(r1.active, false, JSON.stringify(r1));
  assert.strictEqual(r1.rejected, 'unknown-identity');
  assert.strictEqual(r2.active, false, JSON.stringify(r2));
  assert.strictEqual(r2.rejected, 'unknown-identity');
});
t('N10: a matching accountLabel on both sides is honoured — the positive case is not accidentally broken by the binding check', () => {
  const dir = scratchRoot();
  Grant.writeOverrideGrant({ active: true, at: new Date().toISOString(), until: FUTURE, accountLabel: 'account-same' }, { projectRoot: dir });
  const r = O.resolveOwnerOverride({ projectRoot: dir, accountLabel: 'account-same' });
  assert.strictEqual(r.active, true, JSON.stringify(r));
});

// ---- N10 residual (2026-09-24, Codex p12 wave 7 finding N10) — STALE PROFILE, ROTATED CREDENTIAL: an
// account-label match alone is not enough once the credential FILE has changed since the grant was issued.
// See the file header for the full rationale, the GUARD-TOKEN-FINGERPRINT constraint that shaped this design
// (mtime/size metadata only, never anything credential-derived), and its honestly-documented limitation. ----
t('N10 residual: a matching account label but a DIFFERENT credentialGeneration than the grant is REJECTED (credential-generation-unconfirmed), never silently honoured', () => {
  const dir = scratchRoot();
  Grant.writeOverrideGrant({ active: true, at: new Date().toISOString(), until: FUTURE, reason: 'granted under generation G0', accountLabel: 'acct-gen', credentialGeneration: 'G0' }, { projectRoot: dir });
  const r = O.resolveOwnerOverride({ projectRoot: dir, accountLabel: 'acct-gen', credentialGeneration: 'G1' });
  assert.strictEqual(r.active, false, 'a credential that rotated since the grant was issued must not silently keep suppressing pausing: ' + JSON.stringify(r));
  assert.strictEqual(r.rejected, 'credential-generation-unconfirmed');
  assert.strictEqual(r.currentGeneration, 'G1');
});
t('N10 residual: an UNCHANGED credentialGeneration (same as the grant\'s own stamp) is honoured normally — no false positive on the ordinary, nothing-changed case', () => {
  const dir = scratchRoot();
  Grant.writeOverrideGrant({ active: true, at: new Date().toISOString(), until: FUTURE, reason: 'granted', accountLabel: 'acct-gen2', credentialGeneration: 'G0' }, { projectRoot: dir });
  const r = O.resolveOwnerOverride({ projectRoot: dir, accountLabel: 'acct-gen2', credentialGeneration: 'G0' });
  assert.strictEqual(r.active, true, JSON.stringify(r));
});
t('N10 residual: once the CALLER supplies a confirmedGeneration equal to the current one, the grant is honoured again despite the generation mismatch against the original grant stamp (the one-tick-grace re-confirmation)', () => {
  const dir = scratchRoot();
  Grant.writeOverrideGrant({ active: true, at: new Date().toISOString(), until: FUTURE, reason: 'granted under G0', accountLabel: 'acct-gen3', credentialGeneration: 'G0' }, { projectRoot: dir });
  const r = O.resolveOwnerOverride({ projectRoot: dir, accountLabel: 'acct-gen3', credentialGeneration: 'G1', confirmedGeneration: 'G1' });
  assert.strictEqual(r.active, true, 'a caller-confirmed generation must re-honour the grant: ' + JSON.stringify(r));
});
t('N10 residual: an OLD-STYLE grant with no credentialGeneration at all is unaffected — backward compatible with every existing N10 account-binding test', () => {
  const dir = scratchRoot();
  Grant.writeOverrideGrant({ active: true, at: new Date().toISOString(), until: FUTURE, reason: 'legacy, no generation stamp', accountLabel: 'acct-gen4' }, { projectRoot: dir });
  const r = O.resolveOwnerOverride({ projectRoot: dir, accountLabel: 'acct-gen4', credentialGeneration: 'G1' });
  assert.strictEqual(r.active, true, 'a grant written before this field existed must not suddenly start refusing: ' + JSON.stringify(r));
});
t('N10 residual: no credentialGeneration supplied by the caller at all (e.g. the credential file became unreadable mid-tick) also does not trigger the new check — falls back to pre-existing account-binding behaviour only', () => {
  const dir = scratchRoot();
  Grant.writeOverrideGrant({ active: true, at: new Date().toISOString(), until: FUTURE, reason: 'granted under G0', accountLabel: 'acct-gen5', credentialGeneration: 'G0' }, { projectRoot: dir });
  const r = O.resolveOwnerOverride({ projectRoot: dir, accountLabel: 'acct-gen5' });
  assert.strictEqual(r.active, true, JSON.stringify(r));
});

// ---- Finding 5 (2026-09-24, Codex p12 wave 7) — resolveGrantUntil: 30 days is now a MAXIMUM, not merely a
// default; an explicit later --until is clamped, never accepted verbatim (an unbounded suppression window). ----
t('resolveGrantUntil: a rawUntil well within 30 days is returned unchanged, clamped:false', () => {
  const soon = new Date(Date.now() + 3600000).toISOString();
  const r = O.resolveGrantUntil(soon);
  assert.strictEqual(r.until, soon);
  assert.strictEqual(r.clamped, false);
});
t('resolveGrantUntil: a rawUntil LATER than 30 days is clamped DOWN to the 30-day maximum, clamped:true', () => {
  const farFuture = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000).toISOString(); // ~400 days out
  const r = O.resolveGrantUntil(farFuture);
  assert.strictEqual(r.clamped, true, JSON.stringify(r));
  assert.notStrictEqual(r.until, farFuture);
  const days = (Date.parse(r.until) - Date.now()) / (24 * 60 * 60 * 1000);
  assert.ok(days > 29 && days <= 30.01, 'clamped value must land at ~30 days: ' + days);
});
t('resolveGrantUntil: a missing/unparseable rawUntil falls back to the 30-day default, clamped:false (nothing explicit was clamped)', () => {
  const r1 = O.resolveGrantUntil(null);
  const r2 = O.resolveGrantUntil('not-a-real-date');
  assert.strictEqual(r1.clamped, false, JSON.stringify(r1));
  assert.strictEqual(r2.clamped, false, JSON.stringify(r2));
  const days1 = (Date.parse(r1.until) - Date.now()) / (24 * 60 * 60 * 1000);
  assert.ok(days1 > 29 && days1 <= 30.01, JSON.stringify(r1));
});

// ---- Finding 3 (U01, 2026-09-24, Codex p12 wave 7) — describeOverrideLockOutcome's new `bookkeepingThrew`
// wording: a post-mutation bookkeeping exception (caught by usage-guard.cjs's runOverrideOn/runOverrideOff
// around their whole withStateLock() call) must be reported as "cache lagging", never as a lock-acquisition
// failure (which would be misleading — the lock WAS acquired; the bookkeeping inside it threw). ----
t('describeOverrideLockOutcome: kind "on", bookkeepingThrew -> "override active, cache lagging" wording, partial:true, exit-0-worthy', () => {
  const r = O.describeOverrideLockOutcome('on', { ok: false, reason: 'boom', bookkeepingThrew: true }, { until: FUTURE });
  assert.strictEqual(r.partial, true, JSON.stringify(r));
  assert.match(r.line, /override active, cache lagging/i, r.line);
  assert.match(r.line, /boom/, r.line);
});
t('describeOverrideLockOutcome: kind "off", bookkeepingThrew -> "protection re-armed, cache lagging" wording, partial:true, exit-0-worthy', () => {
  const r = O.describeOverrideLockOutcome('off', { ok: false, reason: 'boom', bookkeepingThrew: true }, {});
  assert.strictEqual(r.partial, true, JSON.stringify(r));
  assert.match(r.line, /protection re-armed, cache lagging/i, r.line);
  assert.match(r.line, /boom/, r.line);
});
t('describeOverrideLockOutcome: a plain lock-timeout (no bookkeepingThrew) keeps its ORIGINAL wording — the new branch never changes the pre-existing N11 case', () => {
  const r1 = O.describeOverrideLockOutcome('on', { ok: false, reason: 'lock-timeout' }, { until: FUTURE });
  assert.match(r1.line, /state lock could not be acquired/, r1.line);
  assert.ok(!/cache lagging/.test(r1.line), r1.line);
  const r2 = O.describeOverrideLockOutcome('off', { ok: false, reason: 'lock-timeout' }, {});
  assert.match(r2.line, /state-lock cache bookkeeping failed/, r2.line);
  assert.ok(!/cache lagging/.test(r2.line), r2.line);
});

t('cachedOverrideFrom: an inactive record -> undefined (so a caller can delete/omit the field cleanly)', () => {
  assert.strictEqual(O.cachedOverrideFrom({ active: false }), undefined);
  assert.strictEqual(O.cachedOverrideFrom(null), undefined);
});

t('cachedOverrideFrom: an active record -> a full cache object carrying reason/until/reArmWhenCreditsExhausted', () => {
  const c = O.cachedOverrideFrom({ active: true, at: '2026-09-24T00:00:00.000Z', reason: 'r', until: '2027-01-01T00:00:00.000Z' });
  assert.strictEqual(c.active, true);
  assert.strictEqual(c.reason, 'r');
  assert.strictEqual(c.until, '2027-01-01T00:00:00.000Z');
  assert.strictEqual(c.reArmWhenCreditsExhausted, true);
});

t('cachedOverrideFrom is a PURE function of the grant record — never trusts/echoes a caller-supplied cache', () => {
  // cachedOverrideFrom takes only ONE argument (the fresh record) — a caller cannot pass its own stale
  // cache in and have it influence the result; this is a structural/API-shape guarantee.
  assert.strictEqual(O.cachedOverrideFrom.length, 1, 'cachedOverrideFrom must take exactly the fresh record, nothing else');
});

// ---- reason redaction (N10/N11/N12 qualification, 2026-09-24: "reasons are stored without redaction") ----
t('cachedOverrideFrom: the reason is passed through usage-guard-redact.cjs\'s sanitizeReason — control characters never survive into the cache', () => {
  const c = O.cachedOverrideFrom({ active: true, at: '2026-09-24T00:00:00.000Z', reason: 'legit reason\nFAKE-LOG-LINE: pwned', until: '2027-01-01T00:00:00.000Z' });
  assert.ok(!/\n/.test(c.reason), 'a control character in the reason must never reach the persisted cache: ' + JSON.stringify(c.reason));
});
t('cachedOverrideFrom: a long token-shaped reason is masked, never echoed into the cache', () => {
  const fakeToken = 'sk-ant-oat01-' + 'a'.repeat(40);
  const c = O.cachedOverrideFrom({ active: true, at: '2026-09-24T00:00:00.000Z', reason: fakeToken, until: '2027-01-01T00:00:00.000Z' });
  assert.ok(!c.reason.includes(fakeToken), 'a pasted-by-mistake token-shaped reason must be masked: ' + c.reason);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
