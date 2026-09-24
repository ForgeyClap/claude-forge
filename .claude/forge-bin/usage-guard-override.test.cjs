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
