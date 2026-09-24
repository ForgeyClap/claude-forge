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

t('resolveOwnerOverride: a real, unexpired grant -> active, and the record is returned for cache rebuilding', () => {
  const dir = scratchRoot();
  Grant.writeOverrideGrant({ active: true, at: '2026-09-24T00:00:00.000Z', reason: 'test' }, { projectRoot: dir });
  const r = O.resolveOwnerOverride({ projectRoot: dir });
  assert.strictEqual(r.active, true);
  assert.strictEqual(r.record.reason, 'test');
});

t('resolveOwnerOverride: an EXPIRED grant -> inactive, regardless of what a caller\'s cache might separately claim', () => {
  const dir = scratchRoot();
  Grant.writeOverrideGrant({ active: true, at: new Date().toISOString(), until: '2020-01-01T00:00:00.000Z' }, { projectRoot: dir });
  const r = O.resolveOwnerOverride({ projectRoot: dir });
  assert.strictEqual(r.active, false);
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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
