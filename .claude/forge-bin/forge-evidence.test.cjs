#!/usr/bin/env node
'use strict';
// forge-evidence.test.cjs — real tests for the required-evidence gate (2026-07-18, piece C2).
// Proves the core honesty property both ways: a website run WITHOUT the required responsive-screenshot
// artifacts is reported missing/not-ok, and the SAME run WITH real artifact/event evidence supplied is
// reported ok — so the gate can neither over-claim proof that wasn't produced nor under-credit proof that
// was. Every domain's required set is proven enforced (empty input -> every item missing), all three
// evidence `kind`s are proven via a hermetic custom config (the shipped config only exercises 'artifact' and
// 'artifact_or_event'), malformed config variants are proven to throw rather than silently pass, and the
// CLI's 0/3/2 exit codes are proven via a real spawned subprocess.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const evidence = require('./forge-evidence.cjs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

const CLI = path.join(__dirname, 'forge-evidence.cjs');
function runCLI(argv) { return spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' }); }
function freshDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); }
function writeConfig(obj) {
  const dir = freshDir('forge-evidence-cfg');
  const p = path.join(dir, 'required-evidence.json');
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

console.log('forge-evidence tests (required-evidence gate)');

// ---------------------------------------------------------------------------
// 1) config loads, every domain has a non-empty, well-formed evidence set
// ---------------------------------------------------------------------------
console.log('\n1) config / listDomains — the real required-evidence.json');

t('loadConfig() parses the real required-evidence.json without throwing', () => {
  const data = evidence.loadConfig();
  assert.ok(data.domains && typeof data.domains === 'object');
});
t('listDomains() returns the 10 Forge domains (website, fullstack, n8n, scraping, rag, prediction, integration, tooling, meta, dev-tooling)', () => {
  const domains = evidence.listDomains().sort();
  assert.deepStrictEqual(domains, ['fullstack', 'integration', 'n8n', 'prediction', 'rag', 'scraping', 'website', 'tooling', 'meta', 'dev-tooling'].sort());
});
t('every domain has a non-empty evidence array with id/label/kind on each item', () => {
  const data = evidence.loadConfig();
  for (const key of Object.keys(data.domains)) {
    const list = data.domains[key].evidence;
    assert.ok(Array.isArray(list) && list.length > 0, 'domain ' + key + ' has no evidence items');
    for (const item of list) {
      assert.ok(item.id && item.label && item.kind, 'malformed evidence item in domain ' + key + ': ' + JSON.stringify(item));
      assert.ok(evidence.KNOWN_KINDS.includes(item.kind), 'unknown kind in domain ' + key + ': ' + item.kind);
    }
  }
});

// ---------------------------------------------------------------------------
// 2) website — WITHOUT responsive screenshots => missing (not ok); WITH them => ok
// ---------------------------------------------------------------------------
console.log('\n2) website domain — the core honesty property, proven both ways');

t('website run with NO artifacts/events at all: not ok, every required item reported missing', () => {
  const r = evidence.check({ domain: 'website', artifacts: [], events: [] });
  assert.strictEqual(r.ok, false);
  assert.ok(r.missing.includes('responsive-screenshot-mobile'));
  assert.ok(r.missing.includes('responsive-screenshot-tablet'));
  assert.ok(r.missing.includes('responsive-screenshot-desktop'));
  assert.ok(r.missing.includes('zero-console-errors-note'));
  assert.deepStrictEqual(r.satisfied, []);
});
t('website run with only a DESKTOP screenshot: still not ok, mobile/tablet/console-note still missing', () => {
  const r = evidence.check({ domain: 'website', artifacts: ['screenshots/desktop-1440.png'], events: [] });
  assert.strictEqual(r.ok, false);
  assert.ok(r.satisfied.includes('responsive-screenshot-desktop'));
  assert.ok(r.missing.includes('responsive-screenshot-mobile'));
  assert.ok(r.missing.includes('responsive-screenshot-tablet'));
});
t('website run with real mobile+tablet+desktop screenshots + a console-errors note event: ok, nothing missing', () => {
  const r = evidence.check({
    domain: 'website',
    artifacts: ['screenshots/mobile-375.png', 'screenshots/tablet-768.png', 'screenshots/desktop-1440.png'],
    events: ['zero_console_errors_noted'],
  });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.missing, []);
  assert.ok(r.satisfied.includes('responsive-screenshot-mobile'));
  assert.ok(r.satisfied.includes('responsive-screenshot-tablet'));
  assert.ok(r.satisfied.includes('responsive-screenshot-desktop'));
  assert.ok(r.satisfied.includes('zero-console-errors-note'));
});
t('website: the console-errors note may also be satisfied by an artifact instead of an event (artifact_or_event)', () => {
  const r = evidence.check({
    domain: 'website',
    artifacts: ['screenshots/mobile-375.png', 'screenshots/tablet-768.png', 'screenshots/desktop-1440.png', 'notes/zero-console-errors.md'],
    events: [],
  });
  assert.strictEqual(r.ok, true);
});
t('matching is case-insensitive on artifact substrings', () => {
  const r = evidence.check({ domain: 'website', artifacts: ['Screenshots/MOBILE-375.PNG'], events: [] });
  assert.ok(r.satisfied.includes('responsive-screenshot-mobile'));
});
t('a single non-array string is accepted for artifacts/events (not just arrays)', () => {
  const r = evidence.check({ domain: 'website', artifacts: 'screenshots/mobile-320.png', events: 'zero_console_errors_noted' });
  assert.ok(r.satisfied.includes('responsive-screenshot-mobile'));
  assert.ok(r.satisfied.includes('zero-console-errors-note'));
});

// ---------------------------------------------------------------------------
// 3) every domain's required evidence set is enforced (empty input -> everything missing)
// ---------------------------------------------------------------------------
console.log('\n3) each domain\'s required evidence set enforced');

for (const domain of evidence.listDomains()) {
  t(domain + ': empty artifacts/events -> not ok, every configured item reported missing', () => {
    const data = evidence.loadConfig();
    const expectedIds = data.domains[domain].evidence.map((i) => i.id).sort();
    const r = evidence.check({ domain, artifacts: [], events: [] });
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(r.missing.sort(), expectedIds);
    assert.deepStrictEqual(r.satisfied, []);
  });
}

t('n8n: validate_workflow output + inactive-import note both present -> ok', () => {
  const r = evidence.check({
    domain: 'n8n',
    artifacts: [],
    events: ['workflow_validated', 'workflow_imported_inactive'],
  });
  assert.strictEqual(r.ok, true);
});
t('scraping: a real robots/source-compliance note satisfies the single required item', () => {
  const r = evidence.check({ domain: 'scraping', artifacts: ['notes/robots-check.md'], events: [] });
  assert.strictEqual(r.ok, true);
});

// ---------------------------------------------------------------------------
// 3b) tooling / meta / dev-tooling — the GENUINE tooling evidence standard, proven both ways
// (2026-07-22 — closes the real config gap the forge-2026-07-22-v9-selfaudit run surfaced: this domain
// used to have NO entry at all, so evidence-satisfied could never be satisfied for it. These tests prove
// the new standard actually BITES a lazy tooling run, not merely that it exists.)
// ---------------------------------------------------------------------------
console.log('\n3b) tooling/meta/dev-tooling domain — the genuine tooling evidence standard');

t('tooling: a genuinely lazy run (no check_passed/doctor_run, no final-report, no audit artifact) is NOT ok — all 3 items missing', () => {
  const r = evidence.check({ domain: 'tooling', artifacts: [], events: ['agent_started', 'agent_completed'] });
  assert.strictEqual(r.ok, false);
  assert.ok(r.missing.includes('verified-check-or-doctor-run'));
  assert.ok(r.missing.includes('final-report-artifact'));
  assert.ok(r.missing.includes('audit-or-analysis-artifact'));
});
t('tooling: a real check_passed event + a real final-report artifact + a real audit_iteration event -> ok, nothing missing', () => {
  const r = evidence.check({
    domain: 'tooling',
    artifacts: ['final-report.md'],
    events: ['check_passed', 'audit_iteration'],
  });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.missing, []);
  assert.ok(r.satisfied.includes('verified-check-or-doctor-run'));
  assert.ok(r.satisfied.includes('final-report-artifact'));
  assert.ok(r.satisfied.includes('audit-or-analysis-artifact'));
});
t('tooling: doctor_run + capabilities_reported also satisfy the verification/audit items (the documented OR-alternatives)', () => {
  const r = evidence.check({
    domain: 'tooling',
    artifacts: ['final-report.md'],
    events: ['doctor_run', 'capabilities_reported'],
  });
  assert.strictEqual(r.ok, true);
});
t('tooling: a run WITHOUT a real report but WITH verification+audit evidence is still NOT ok (report-artifact genuinely required on its own)', () => {
  const r = evidence.check({ domain: 'tooling', artifacts: [], events: ['check_passed', 'audit_iteration'] });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.missing, ['final-report-artifact']);
});
t('tooling: a run WITHOUT any real verification signal but WITH report+audit evidence is still NOT ok (a lazy run cannot skip proof of a real check)', () => {
  const r = evidence.check({ domain: 'tooling', artifacts: ['final-report.md'], events: ['audit_iteration'] });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.missing, ['verified-check-or-doctor-run']);
});
t('tooling: a bare narrative agent_note event mentioning "audit" is NOT evidence — only the real registered events/artifacts count', () => {
  const r = evidence.check({
    domain: 'tooling',
    artifacts: ['final-report.md'],
    events: ['check_passed', 'agent_note'],
  });
  assert.strictEqual(r.ok, false);
  assert.ok(r.missing.includes('audit-or-analysis-artifact'));
});
t('meta and dev-tooling are exact duplicates of the tooling evidence set (same 3-item family, no code-level alias mechanism exists)', () => {
  const data = evidence.loadConfig();
  assert.deepStrictEqual(data.domains.meta.evidence, data.domains.tooling.evidence);
  assert.deepStrictEqual(data.domains['dev-tooling'].evidence, data.domains.tooling.evidence);
});
t('meta domain: same lazy-run-fails / real-run-passes behavior as tooling (proves the duplicate is live, not just present)', () => {
  const lazy = evidence.check({ domain: 'meta', artifacts: [], events: [] });
  assert.strictEqual(lazy.ok, false);
  const real = evidence.check({ domain: 'meta', artifacts: ['final-report.md'], events: ['check_passed', 'audit_iteration'] });
  assert.strictEqual(real.ok, true);
});
t('dev-tooling domain: same lazy-run-fails / real-run-passes behavior as tooling', () => {
  const lazy = evidence.check({ domain: 'dev-tooling', artifacts: [], events: [] });
  assert.strictEqual(lazy.ok, false);
  const real = evidence.check({ domain: 'dev-tooling', artifacts: ['final-report.md'], events: ['doctor_run', 'capabilities_reported'] });
  assert.strictEqual(real.ok, true);
});

// ---------------------------------------------------------------------------
// 4) all three evidence kinds proven via a hermetic custom config
// ---------------------------------------------------------------------------
console.log('\n4) evidence kind coverage — artifact / event / artifact_or_event (hermetic config)');

const kindCfgPath = writeConfig({
  domains: {
    testdomain: {
      evidence: [
        { id: 'pure-artifact', label: 'artifact-only item', kind: 'artifact', any_of_substrings: ['needle'] },
        { id: 'pure-event', label: 'event-only item', kind: 'event', any_of_events: ['thing_happened'] },
        { id: 'either', label: 'either item', kind: 'artifact_or_event', any_of_substrings: ['sub'], any_of_events: ['evt_ok'] },
      ],
    },
  },
});

t('kind:"artifact" is satisfied by a matching artifact and NOT by a matching event of the same name', () => {
  const r1 = evidence.check({ domain: 'testdomain', artifacts: ['has-a-needle-in-it'], events: [] }, { evidencePath: kindCfgPath });
  assert.ok(r1.satisfied.includes('pure-artifact'));
  const r2 = evidence.check({ domain: 'testdomain', artifacts: [], events: ['needle'] }, { evidencePath: kindCfgPath });
  assert.ok(r2.missing.includes('pure-artifact'));
});
t('kind:"event" is satisfied by an exact-match event and NOT by a substring-matching artifact', () => {
  const r1 = evidence.check({ domain: 'testdomain', artifacts: [], events: ['thing_happened'] }, { evidencePath: kindCfgPath });
  assert.ok(r1.satisfied.includes('pure-event'));
  const r2 = evidence.check({ domain: 'testdomain', artifacts: ['thing_happened_and_more'], events: [] }, { evidencePath: kindCfgPath });
  assert.ok(r2.missing.includes('pure-event'));
});
t('kind:"artifact_or_event" is satisfied by either the artifact OR the event alone', () => {
  const r1 = evidence.check({ domain: 'testdomain', artifacts: ['has-sub-in-it'], events: [] }, { evidencePath: kindCfgPath });
  assert.ok(r1.satisfied.includes('either'));
  const r2 = evidence.check({ domain: 'testdomain', artifacts: [], events: ['evt_ok'] }, { evidencePath: kindCfgPath });
  assert.ok(r2.satisfied.includes('either'));
  const r3 = evidence.check({ domain: 'testdomain', artifacts: [], events: [] }, { evidencePath: kindCfgPath });
  assert.ok(r3.missing.includes('either'));
});

// ---------------------------------------------------------------------------
// 5) unknown domain refuses rather than silently returning empty/ok
// ---------------------------------------------------------------------------
console.log('\n5) unknown domain');

t('check() with an unknown domain throws, listing the known domains', () => {
  assert.throws(() => evidence.check({ domain: 'not-a-real-domain' }), /unknown domain.*not-a-real-domain/i);
});
t('check() without a domain at all throws', () => {
  assert.throws(() => evidence.check({}), /requires a non-empty "domain"/);
});

// ---------------------------------------------------------------------------
// 6) malformed config is refused, not silently accepted
// ---------------------------------------------------------------------------
console.log('\n6) config integrity — refuses malformed input rather than silently passing everything');

t('an empty "domains" object throws', () => {
  const p = writeConfig({ domains: {} });
  assert.throws(() => evidence.check({ domain: 'website' }, { evidencePath: p }));
});
t('a domain with an empty "evidence" array throws', () => {
  const p = writeConfig({ domains: { website: { evidence: [] } } });
  assert.throws(() => evidence.check({ domain: 'website' }, { evidencePath: p }));
});
t('an evidence item missing "kind" throws', () => {
  const p = writeConfig({ domains: { website: { evidence: [{ id: 'x', label: 'y' }] } } });
  assert.throws(() => evidence.check({ domain: 'website' }, { evidencePath: p }));
});
t('an evidence item with kind "artifact" but no any_of_substrings throws', () => {
  const p = writeConfig({ domains: { website: { evidence: [{ id: 'x', label: 'y', kind: 'artifact' }] } } });
  assert.throws(() => evidence.check({ domain: 'website' }, { evidencePath: p }));
});
t('an evidence item with kind "event" but no any_of_events throws', () => {
  const p = writeConfig({ domains: { website: { evidence: [{ id: 'x', label: 'y', kind: 'event' }] } } });
  assert.throws(() => evidence.check({ domain: 'website' }, { evidencePath: p }));
});
t('an evidence item with an unknown kind throws', () => {
  const p = writeConfig({ domains: { website: { evidence: [{ id: 'x', label: 'y', kind: 'bogus' }] } } });
  assert.throws(() => evidence.check({ domain: 'website' }, { evidencePath: p }));
});
t('a config file that is not valid JSON throws', () => {
  const dir = freshDir('forge-evidence-badjson');
  const p = path.join(dir, 'required-evidence.json');
  fs.writeFileSync(p, '{ not valid json');
  assert.throws(() => evidence.check({ domain: 'website' }, { evidencePath: p }));
});
t('a missing config file throws (never silently returns "no requirements")', () => {
  assert.throws(() => evidence.check({ domain: 'website' }, { evidencePath: path.join(freshDir('forge-evidence-nope'), 'does-not-exist.json') }));
});

// ---------------------------------------------------------------------------
// 7) hermetic — the module never touches the real config when opts.evidencePath is supplied
// ---------------------------------------------------------------------------
console.log('\n7) hermeticity');

t('a hermetic custom config with a domain not present in the real config still works end-to-end', () => {
  const p = writeConfig({ domains: { customdomain: { evidence: [{ id: 'only-item', label: 'x', kind: 'artifact', any_of_substrings: ['zzz'] }] } } });
  const r = evidence.check({ domain: 'customdomain', artifacts: ['contains-zzz-here'] }, { evidencePath: p });
  assert.strictEqual(r.ok, true);
});

// ---------------------------------------------------------------------------
// 8) CLI — exit codes 0 (ok) / 3 (missing evidence) / 2 (usage/config error)
// ---------------------------------------------------------------------------
console.log('\n8) CLI exit codes (real spawned subprocess)');

t('CLI check with no evidence supplied for website exits 3 and lists missing ids', () => {
  const r = runCLI(['check', '--domain', 'website']);
  assert.strictEqual(r.status, 3);
  assert.ok(r.stdout.includes('MISSING EVIDENCE'));
  assert.ok(r.stdout.includes('responsive-screenshot-mobile'));
});
t('CLI check with full evidence for scraping exits 0', () => {
  const r = runCLI(['check', '--domain', 'scraping', '--artifacts', 'notes/robots-check.md']);
  assert.strictEqual(r.status, 0);
  assert.ok(r.stdout.includes('OK'));
});
t('CLI check --json prints a parseable result object', () => {
  const r = runCLI(['check', '--domain', 'n8n', '--events', 'workflow_validated,workflow_imported_inactive', '--json']);
  const parsed = JSON.parse(r.stdout.trim());
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.domain, 'n8n');
});
t('CLI check without --domain exits 2 (usage error)', () => {
  const r = runCLI(['check']);
  assert.strictEqual(r.status, 2);
});
t('CLI check with an unknown domain exits 2 (config/usage error, not a silent pass)', () => {
  const r = runCLI(['check', '--domain', 'not-a-real-domain']);
  assert.strictEqual(r.status, 2);
});
t('CLI with an unknown command exits 2', () => {
  const r = runCLI(['bogus-command']);
  assert.strictEqual(r.status, 2);
});
t('CLI with no command at all exits 2', () => {
  const r = runCLI([]);
  assert.strictEqual(r.status, 2);
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
