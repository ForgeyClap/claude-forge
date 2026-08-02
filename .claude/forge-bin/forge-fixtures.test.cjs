#!/usr/bin/env node
'use strict';
// forge-fixtures.test.cjs — real tests for the real-fixtures intake gate (2026-07-18, WAVE D / D2).
// Proves the honesty-core-for-test-data contract: a correctness-critical domain with no real fixtures
// and no logged waiver is BLOCKED (no silent synthetic fallback); real fixtures or an explicit waiver
// unblock it (waiver stays visibly flagged, never silent); a non-critical domain is never blocked.
// Hermetic — no filesystem/network I/O, pure function calls plus real spawned CLI subprocess checks.
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const fixtures = require('./forge-fixtures.cjs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

const CLI = path.join(__dirname, 'forge-fixtures.cjs');
function runCLI(argv) { return spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' }); }

console.log('forge-fixtures tests (real-fixtures intake gate)');

// ---------------------------------------------------------------------------
// 1) requirement() — correctness-critical domains vs. non-critical
// ---------------------------------------------------------------------------
console.log('\n1) requirement() — domain classification');

for (const d of fixtures.CRITICAL_DOMAINS) {
  t('requirement(): "' + d + '" is REQUIRED and carries a non-empty reason', () => {
    const r = fixtures.requirement({ domain: d });
    assert.strictEqual(r.required, true);
    assert.strictEqual(r.domain, d);
    assert.ok(r.reason && r.reason.length > 0);
  });
  t('requirement(): "' + d.toUpperCase() + '" (case-insensitive) is also REQUIRED', () => {
    const r = fixtures.requirement({ domain: d.toUpperCase() });
    assert.strictEqual(r.required, true);
    assert.strictEqual(r.domain, d);
  });
}

t('requirement(): CRITICAL_DOMAINS lists exactly finance/parser/ocr/data/prediction (no drift)', () => {
  assert.deepStrictEqual([...fixtures.CRITICAL_DOMAINS].sort(), ['data', 'finance', 'ocr', 'parser', 'prediction']);
});

t('requirement(): "marketing" (marketing copy) is NOT required', () => {
  const r = fixtures.requirement({ domain: 'marketing' });
  assert.strictEqual(r.required, false);
  assert.ok(r.reason.includes('marketing'));
});

t('requirement(): "website-copy" is NOT required', () => {
  const r = fixtures.requirement({ domain: 'website-copy' });
  assert.strictEqual(r.required, false);
});

t('requirement(): missing/empty domain is treated as not required, never blocks on missing classification', () => {
  const r1 = fixtures.requirement({});
  const r2 = fixtures.requirement({ domain: '' });
  const r3 = fixtures.requirement({ domain: '   ' });
  assert.strictEqual(r1.required, false);
  assert.strictEqual(r2.required, false);
  assert.strictEqual(r3.required, false);
});

t('requirement(): whitespace-padded domain is trimmed before matching', () => {
  const r = fixtures.requirement({ domain: '  finance  ' });
  assert.strictEqual(r.required, true);
  assert.strictEqual(r.domain, 'finance');
});

// ---------------------------------------------------------------------------
// 2) check() — the core honesty-for-test-data decision table
// ---------------------------------------------------------------------------
console.log('\n2) check() — finance domain w/o fixtures & w/o waiver => BLOCKED');

t('check(): finance domain, no fixtures, no waiver => ok:false, needFixtures:true, no silent pass', () => {
  const r = fixtures.check({ domain: 'finance', providedFixtures: null, waiver: null });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.needFixtures, true);
  assert.strictEqual(r.required, true);
  assert.strictEqual(r.waiver, null);
  assert.deepStrictEqual(r.fixtures, []);
  assert.ok(r.reason.includes('NO real fixtures') && r.reason.includes('NO logged waiver'));
});

t('check(): parser domain, empty fixtures array, no waiver => BLOCKED', () => {
  const r = fixtures.check({ domain: 'parser', providedFixtures: [], waiver: undefined });
  assert.strictEqual(r.ok, false);
});

t('check(): ocr domain, fixtures given as an empty/whitespace-only string => BLOCKED (no fixtures found)', () => {
  const r = fixtures.check({ domain: 'ocr', providedFixtures: '  ,  ,' });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.fixtures, []);
});

console.log('\n3) check() — real fixtures provided => OK');

t('check(): finance domain WITH real fixtures (array) => ok:true, waiver:null', () => {
  const r = fixtures.check({ domain: 'finance', providedFixtures: ['invoice-2026-01.pdf', 'ledger-export.csv'] });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.needFixtures, true);
  assert.strictEqual(r.waiver, null);
  assert.deepStrictEqual(r.fixtures, ['invoice-2026-01.pdf', 'ledger-export.csv']);
});

t('check(): data domain WITH real fixtures given as a comma-separated string => ok:true, parsed into an array', () => {
  const r = fixtures.check({ domain: 'data', providedFixtures: 'sample-export.csv, messy-rows.json' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.fixtures, ['sample-export.csv', 'messy-rows.json']);
});

t('check(): prediction domain WITH real fixtures => ok:true', () => {
  const r = fixtures.check({ domain: 'prediction', providedFixtures: ['historical-odds-2025.csv'] });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.required, true);
});

console.log('\n4) check() — explicit logged waiver => OK, but flagged (never silent)');

t('check(): finance domain, no fixtures, WITH an explicit waiver => ok:true, waiver flagged with reason', () => {
  const r = fixtures.check({ domain: 'finance', providedFixtures: null, waiver: 'owner has not provided sample invoices yet, approved to proceed' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.needFixtures, true);
  assert.ok(r.waiver && r.waiver.flagged === true);
  assert.strictEqual(r.waiver.reason, 'owner has not provided sample invoices yet, approved to proceed');
  assert.ok(r.reason.includes('waiver'));
});

t('check(): a whitespace-only waiver does NOT count as a real waiver => still BLOCKED', () => {
  const r = fixtures.check({ domain: 'ocr', providedFixtures: null, waiver: '   ' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.waiver, null);
});

t('check(): real fixtures present takes precedence over an unnecessary waiver (waiver stays null when fixtures satisfy it)', () => {
  const r = fixtures.check({ domain: 'finance', providedFixtures: ['real-invoice.pdf'], waiver: 'not needed but supplied anyway' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.waiver, null);
});

console.log('\n5) check() — non-critical domain => OK without fixtures, regardless of waiver');

t('check(): marketing domain, no fixtures, no waiver => ok:true, needFixtures:false', () => {
  const r = fixtures.check({ domain: 'marketing' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.needFixtures, false);
  assert.strictEqual(r.required, false);
  assert.strictEqual(r.waiver, null);
});

t('check(): non-critical domain with fixtures supplied anyway still reports needFixtures:false', () => {
  const r = fixtures.check({ domain: 'copywriting', providedFixtures: ['sample-copy.txt'] });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.needFixtures, false);
});

t('check(): missing domain (not classified) => ok:true, never blocks on unknown classification', () => {
  const r = fixtures.check({});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.required, false);
});

// ---------------------------------------------------------------------------
// 6) normalizeFixtures() / normalizeWaiver() — small pure-helper edge cases
// ---------------------------------------------------------------------------
console.log('\n6) normalize helpers');

t('normalizeFixtures(): null/undefined => []', () => {
  assert.deepStrictEqual(fixtures.normalizeFixtures(null), []);
  assert.deepStrictEqual(fixtures.normalizeFixtures(undefined), []);
});
t('normalizeFixtures(): array with blank entries is filtered and trimmed', () => {
  assert.deepStrictEqual(fixtures.normalizeFixtures([' a.csv ', '', '  ', 'b.csv']), ['a.csv', 'b.csv']);
});
t('normalizeWaiver(): blank/whitespace waiver normalizes to null', () => {
  assert.strictEqual(fixtures.normalizeWaiver(''), null);
  assert.strictEqual(fixtures.normalizeWaiver('   '), null);
  assert.strictEqual(fixtures.normalizeWaiver(null), null);
});
t('normalizeWaiver(): a real reason is trimmed and kept', () => {
  assert.strictEqual(fixtures.normalizeWaiver('  approved by owner  '), 'approved by owner');
});

// ---------------------------------------------------------------------------
// 7) CLI — real spawned subprocess, exit codes 0 (ok) / 3 (blocked) / 2 (usage)
// ---------------------------------------------------------------------------
console.log('\n7) CLI (real spawned subprocess)');

t('CLI requirement --domain finance --json reports required:true', () => {
  const r = runCLI(['requirement', '--domain', 'finance', '--json']);
  assert.strictEqual(r.status, 0);
  const parsed = JSON.parse(r.stdout.trim());
  assert.strictEqual(parsed.required, true);
});
t('CLI requirement --domain marketing --json reports required:false', () => {
  const r = runCLI(['requirement', '--domain', 'marketing', '--json']);
  assert.strictEqual(r.status, 0);
  const parsed = JSON.parse(r.stdout.trim());
  assert.strictEqual(parsed.required, false);
});
t('CLI requirement with no --domain exits 2 (usage error)', () => {
  const r = runCLI(['requirement']);
  assert.strictEqual(r.status, 2);
});
t('CLI check --domain finance (no fixtures, no waiver) exits 3 (BLOCKED)', () => {
  const r = runCLI(['check', '--domain', 'finance', '--json']);
  assert.strictEqual(r.status, 3);
  const parsed = JSON.parse(r.stdout.trim());
  assert.strictEqual(parsed.ok, false);
});
t('CLI check --domain finance --fixtures a.pdf,b.csv exits 0 (OK)', () => {
  const r = runCLI(['check', '--domain', 'finance', '--fixtures', 'a.pdf,b.csv', '--json']);
  assert.strictEqual(r.status, 0);
  const parsed = JSON.parse(r.stdout.trim());
  assert.strictEqual(parsed.ok, true);
  assert.deepStrictEqual(parsed.fixtures, ['a.pdf', 'b.csv']);
});
t('CLI check --domain finance --waiver "<reason>" exits 0 (OK, flagged waiver)', () => {
  const r = runCLI(['check', '--domain', 'finance', '--waiver', 'owner approved gap', '--json']);
  assert.strictEqual(r.status, 0);
  const parsed = JSON.parse(r.stdout.trim());
  assert.strictEqual(parsed.ok, true);
  assert.ok(parsed.waiver && parsed.waiver.flagged === true);
});
t('CLI check --domain marketing (no fixtures) exits 0 (OK, non-critical)', () => {
  const r = runCLI(['check', '--domain', 'marketing', '--json']);
  assert.strictEqual(r.status, 0);
});
t('CLI check with no --domain exits 2 (usage error)', () => {
  const r = runCLI(['check']);
  assert.strictEqual(r.status, 2);
});
t('CLI with an unknown command exits 2 (usage error), not a silent pass', () => {
  const r = runCLI(['bogus-command']);
  assert.strictEqual(r.status, 2);
});
t('CLI with no command at all exits 2', () => {
  const r = runCLI([]);
  assert.strictEqual(r.status, 2);
});
t('CLI check (non-JSON, human-readable) prints BLOCKED / OK prefix', () => {
  const blocked = runCLI(['check', '--domain', 'finance']);
  assert.ok(blocked.stdout.includes('BLOCKED'));
  const ok = runCLI(['check', '--domain', 'marketing']);
  assert.ok(ok.stdout.includes('OK'));
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
