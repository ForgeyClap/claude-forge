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
// CORRECTED 2026-08-04 (audit sweep). This used to pin listDomains() to exactly those 10 names — which
// quietly asserted that 10 domains was CORRECT, while config/rubrics/ defined 17 and the block+
// cannot_override `evidence-satisfied` rule therefore had nothing to check for the other 16. A test that
// pins a number is only worth having when the number is a property; here the real property is "no rubric
// domain is left without an evidence entry", which the coverage test at the bottom of this file asserts.
// What stays pinned here: the ORIGINAL 10 must never silently disappear.
t('listDomains() still contains every originally-covered Forge domain (no silent removals)', () => {
  const domains = evidence.listDomains();
  for (const d of ['fullstack', 'integration', 'n8n', 'prediction', 'rag', 'scraping', 'website', 'tooling', 'meta', 'dev-tooling']) {
    assert.ok(domains.includes(d), 'domain disappeared from required-evidence.json: ' + d);
  }
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
        // specific:true on the first item satisfies loadConfig's "a domain must have at least one
        // domain-specific requirement" rule (audit #5); none of these fixture items lists a generic event,
        // so the flag changes nothing about what this section is measuring (kind semantics).
        { id: 'pure-artifact', label: 'artifact-only item', kind: 'artifact', any_of_substrings: ['needle'], specific: true },
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
  const p = writeConfig({ domains: { customdomain: { evidence: [{ id: 'only-item', label: 'x', kind: 'artifact', any_of_substrings: ['zzz'], specific: true }] } } });
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

// ============================================================================================
// DOMAIN COVERAGE (audit sweep 2026-08-03, closed 2026-08-04).
// MEASURED DEFECT: FORGE_HARD_RULES.json's `evidence-satisfied` rule is severity:block AND
// cannot_override:true AND domain_aware — but required-evidence.json only defined 10 domains while
// config/rubrics/ defined 17. A run classified payments/mobile/game/api/... therefore hit a rule it
// could never satisfy and could never be excused from. Exactly the gap the `tooling` domain hit on
// 2026-07-22, honestly written down at the time and then left open for 16 other domains.
// These tests keep the two vocabularies from drifting apart again, and — just as important — keep the
// new entries SATISFIABLE: an evidence block referencing an event type that log-event.cjs does not
// know is a rule nobody can ever meet, which is how the original gap looked from the inside.
// ============================================================================================
{
  const fs2 = require('fs');
  const path2 = require('path');
  const ROOT2 = path2.resolve(__dirname, '..', '..');
  const rubricsDir = path2.join(ROOT2, '.claude', 'config', 'rubrics');

  t('every rubric domain has a required-evidence entry (the block+cannot_override rule is satisfiable)', () => {
    const domains = evidence.listDomains({});
    const rubrics = fs2.readdirSync(rubricsDir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
    const missing = rubrics.filter((r) => !domains.includes(r));
    assert.deepStrictEqual(missing, [], 'rubric domains with no evidence entry: ' + missing.join(', '));
  });

  t('every evidence block references ONLY event types log-event.cjs actually knows', () => {
    const src = fs2.readFileSync(path2.join(ROOT2, '.claude', 'forge-dashboard', 'log-event.cjs'), 'utf8');
    const m = src.match(/KNOWN_EVENT_TYPES\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
    assert.ok(m, 'could not read KNOWN_EVENT_TYPES from log-event.cjs');
    // NOTE: event types contain digits (e2e_passed, e2e_result) — an [a-z_] class silently
    // misses them and would report a REGISTERED type as unknown. Verified against log-event.cjs:347.
    const known = new Set((m[1].match(/'[a-z0-9_]+'/g) || []).map((s) => s.replace(/'/g, '')));
    const cfg = JSON.parse(fs2.readFileSync(path2.join(ROOT2, '.claude', 'config', 'orchestration', 'required-evidence.json'), 'utf8'));
    const unknown = [];
    for (const [dom, entry] of Object.entries(cfg.domains)) {
      for (const block of (entry.evidence || [])) {
        for (const t2 of (block.any_of_events || [])) {
          if (!known.has(t2)) unknown.push(dom + '.' + block.id + ' -> ' + t2);
        }
      }
    }
    assert.deepStrictEqual(unknown, [], 'evidence blocks referencing unregistered event types (unmeetable rules): ' + unknown.join('; '));
  });

  t('every evidence block can be satisfied by SOMETHING (never an empty requirement)', () => {
    const cfg = JSON.parse(fs2.readFileSync(path2.join(ROOT2, '.claude', 'config', 'orchestration', 'required-evidence.json'), 'utf8'));
    const empty = [];
    for (const [dom, entry] of Object.entries(cfg.domains)) {
      assert.ok(Array.isArray(entry.evidence) && entry.evidence.length, 'domain ' + dom + ' has no evidence blocks');
      for (const b of entry.evidence) {
        const subs = (b.any_of_substrings || []).length;
        const evs = (b.any_of_events || []).length;
        if (!subs && !evs) empty.push(dom + '.' + b.id);
      }
    }
    assert.deepStrictEqual(empty, [], 'evidence blocks with no way to satisfy them: ' + empty.join(', '));
  });

  t('a newly covered domain really evaluates (payments, spot-check through the real checker)', () => {
    const res = evidence.check({ domain: 'payments', artifacts: [], events: [] }, {});
    assert.strictEqual(res.ok, false, 'an empty payments run must NOT satisfy the evidence gate');
    assert.ok(res.missing.length > 0, 'the checker returned no missing items for an empty run');
    const satisfied = evidence.check({ domain: 'payments', artifacts: ['final-report.md'], events: ['check_passed', 'webhook_auth_verified', 'audit_finding'] }, {});
    assert.strictEqual(satisfied.ok, true, 'a payments run WITH real evidence should pass, missing: ' + JSON.stringify(satisfied.missing));
  });
}

// ============================================================================================
// NAMING A FILE IS NOT PRODUCING ONE (broad Codex audit #4, fixed 2026-08-05).
// Artifact requirements were substring matches over caller-supplied strings while every label promised
// "a real, non-empty artifact exists". One invented path satisfied four website requirements at once
// without a single screenshot existing. When the run directory is known, an artifact claim must now
// resolve to a REGULAR, NON-EMPTY file inside that run; when it is not known, the result says
// artifacts_verified:false instead of implying a check that never happened.
// ============================================================================================
{
  const fs3 = require('fs');
  const os3 = require('os');
  const path3 = require('path');
  const runDir = fs3.mkdtempSync(path3.join(os3.tmpdir(), 'evidence-run-'));
  fs3.mkdirSync(path3.join(runDir, 'artifacts'), { recursive: true });
  const realShot = path3.join(runDir, 'artifacts', 'mobile-375.png');
  fs3.writeFileSync(realShot, 'PNGDATA');
  fs3.writeFileSync(path3.join(runDir, 'artifacts', 'empty-desktop-1440.png'), ''); // 0 bytes = not evidence

  t('an INVENTED artifact path no longer satisfies anything when the run dir is known', () => {
    const r = evidence.check({ domain: 'website', artifacts: ['fake/mobile-tablet-desktop-zero-console-375-768-1440.png'], events: [] }, { runDir });
    assert.strictEqual(r.ok, false, 'a made-up filename satisfied the gate');
    assert.ok(r.missing.includes('responsive-screenshot-mobile'));
    assert.ok(Array.isArray(r.artifacts_rejected) && r.artifacts_rejected.length === 1, JSON.stringify(r));
  });

  t('a REAL non-empty artifact inside the run still satisfies its requirement', () => {
    const r = evidence.check({ domain: 'website', artifacts: ['artifacts/mobile-375.png'], events: [] }, { runDir });
    assert.ok(r.satisfied.includes('responsive-screenshot-mobile'), JSON.stringify(r));
  });

  t('a 0-byte file is not evidence', () => {
    const r = evidence.check({ domain: 'website', artifacts: ['artifacts/empty-desktop-1440.png'], events: [] }, { runDir });
    assert.ok(!r.satisfied.includes('responsive-screenshot-desktop'), JSON.stringify(r));
  });

  t('an artifact OUTSIDE the run directory is refused (containment)', () => {
    const outside = path3.join(fs3.mkdtempSync(path3.join(os3.tmpdir(), 'evidence-outside-')), 'mobile-375.png');
    fs3.writeFileSync(outside, 'PNGDATA');
    const r = evidence.check({ domain: 'website', artifacts: [outside], events: [] }, { runDir });
    assert.ok(!r.satisfied.includes('responsive-screenshot-mobile'), 'an artifact outside the run was accepted');
  });

  t('without a run directory the result HONESTLY reports that nothing was verified', () => {
    const r = evidence.check({ domain: 'website', artifacts: ['screenshots/mobile-375.png'], events: [] });
    assert.strictEqual(r.artifacts_verified, false, 'must not imply a filesystem check that did not happen');
    assert.ok(r.satisfied.includes('responsive-screenshot-mobile'), 'legacy string matching still applies when there is nothing to verify against');
  });
}

// =====================================================================================
// A GENERIC "SOMETHING PASSED" EVENT IS NOT PROOF OF A SPECIFIC GUARANTEE (Codex audit #5)
// -------------------------------------------------------------------------------------
// Emitting one `check_passed` used to satisfy 3 of the 4 payments requirements: "the security surface
// was really examined" and "payment safety was really exercised" both went green off an event that
// could have come from a lint run. The same leak sat in 14 of 26 domains. Requirements that promise a
// DOMAIN-SPECIFIC fact are now marked specific:true and refuse domain-agnostic events, enforced both at
// config load time and in the satisfaction decision itself.
// =====================================================================================
console.log('\n9) a generic event cannot satisfy a domain-specific requirement (audit #5)');

t('ONE generic check_passed no longer satisfies the payments guarantees (the finding, against the REAL config)', () => {
  const r = evidence.check({ domain: 'payments', artifacts: [], events: ['check_passed'] });
  assert.strictEqual(r.ok, false, 'a lone check_passed must not clear the payments gate');
  for (const id of ['security-surface-checked', 'idempotency-or-webhook-evidence']) {
    assert.ok(r.missing.includes(id), id + ' is still satisfiable by a bare check_passed: ' + JSON.stringify(r));
  }
});

t('the payments guarantees ARE satisfied by their own specific evidence', () => {
  const r = evidence.check({ domain: 'payments', artifacts: [], events: ['check_passed', 'audit_finding', 'webhook_auth_verified'] });
  assert.deepStrictEqual(r.missing, ['final-report-artifact'], 'only the report artifact should be left: ' + JSON.stringify(r.missing));
});

t('the two payments guarantees cannot be met by the SAME single event', () => {
  const onlyWebhook = evidence.check({ domain: 'payments', artifacts: [], events: ['check_passed', 'webhook_auth_verified'] });
  assert.ok(onlyWebhook.missing.includes('security-surface-checked'), 'a webhook check is not a security audit');
  const onlyAudit = evidence.check({ domain: 'payments', artifacts: [], events: ['check_passed', 'audit_finding'] });
  assert.ok(onlyAudit.missing.includes('idempotency-or-webhook-evidence'), 'a security audit is not an idempotency/webhook exercise');
});

t('NO domain in the real config has a specific requirement that accepts a generic event', () => {
  const cfg = evidence.loadConfig();
  const GENERIC = ['check_passed', 'quality_gate_passed', 'integration_gate_passed', 'agent_completed', 'run_completed', 'report_generated', 'wp_completed'];
  const leaks = [];
  for (const [key, dom] of Object.entries(cfg.domains)) {
    for (const item of dom.evidence) {
      if (!item.specific) continue;
      const bad = (item.any_of_events || []).filter((e) => GENERIC.includes(e));
      if (bad.length) leaks.push(key + '/' + item.id + ' accepts ' + bad.join(','));
    }
  }
  assert.deepStrictEqual(leaks, [], 'specific requirements still accepting generic events: ' + leaks.join(' · '));
});

t('EVERY domain in the real config has at least one domain-specific requirement', () => {
  const cfg = evidence.loadConfig();
  const toothless = Object.entries(cfg.domains).filter(([, dom]) => !dom.evidence.some((i) => i.specific)).map(([k]) => k);
  assert.deepStrictEqual(toothless, [], 'domains fully satisfiable by generic evidence: ' + toothless.join(', '));
});

t('a config that lets a specific requirement accept a generic event is REFUSED at load time', () => {
  const p = writeConfig({
    domains: {
      leaky: {
        evidence: [{ id: 'sec', label: 'security really checked', kind: 'event', any_of_events: ['check_passed'], specific: true }],
      },
    },
  });
  assert.throws(() => evidence.loadConfig(p), /marked specific:true but accepts the domain-agnostic event/,
    'the config regression must be caught where it happens — at load');
});

t('a domain whose every requirement is generic is REFUSED at load time', () => {
  const p = writeConfig({
    domains: {
      toothless: {
        evidence: [{ id: 'any-check', label: 'a check ran', kind: 'event', any_of_events: ['check_passed'] }],
      },
    },
  });
  assert.throws(() => evidence.loadConfig(p), /has no requirement marked specific:true/,
    'a domain with no specific requirement is not a gate');
});

t('isSatisfied itself refuses a generic event on a specific item (not only the config loader)', () => {
  const item = { id: 'x', label: 'x', kind: 'artifact_or_event', any_of_substrings: ['zzz'], any_of_events: ['check_passed', 'webhook_auth_verified'], specific: true };
  assert.strictEqual(evidence.isSatisfied(item, [], ['check_passed']), false, 'a generic event must not satisfy a specific item even when handed straight to the decision');
  assert.strictEqual(evidence.isSatisfied(item, [], ['webhook_auth_verified']), true, 'its own specific event must still satisfy it');
  assert.strictEqual(evidence.isSatisfied(item, ['has-zzz-inside'], []), true, 'a matching artifact must still satisfy it');
  const generic = { ...item, specific: false };
  assert.strictEqual(evidence.isSatisfied(generic, [], ['check_passed']), true, 'a requirement that is genuinely generic is unchanged');
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
