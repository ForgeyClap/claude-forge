#!/usr/bin/env node
'use strict';
// forge-recovery.test.cjs — real behavior tests for the solution-first recovery engine (2026-07-23).
// Maps 1:1 to the mission's 20 mandatory recovery tests, plus engine invariants. Hermetic: ledger
// writes use dryRun or a fresh os.tmpdir() path; the fixture-merge test writes ONLY under os.tmpdir();
// the two real-repo reads (project policy config, best-effort global file) are READ-ONLY.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const R = require('./forge-recovery.cjs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}
function freshDir(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p + '-')); }
const CLI = path.join(__dirname, 'forge-recovery.cjs');

console.log('forge-recovery tests (solution-first recovery engine — 20 mandatory + invariants)');

console.log('\n1) API 401 does not auto-block');
t('classifyBlocker(http_401): autoBlock=false, recoverable=true', () => {
  const c = R.classifyBlocker('http_401');
  assert.strictEqual(c.autoBlock, false);
  assert.strictEqual(c.recoverable, true);
});
t('numeric 401 and "unauthorized" normalize to http_401 and stay recoverable', () => {
  assert.strictEqual(R.classifyBlocker(401).signal, 'http_401');
  assert.strictEqual(R.classifyBlocker('unauthorized').autoBlock, false);
});

console.log('\n2) public fallback starts after API failure');
t('generateAlternatives (no firecrawl) leads with public_pages then search', () => {
  const g = R.generateAlternatives({ name: 'x' }, { firecrawlAvailable: false });
  assert.strictEqual(g.routes[0].route, 'public_pages');
  assert.ok(g.routes.some((r) => r.route === 'search_engine'));
});

console.log('\n3) exact-name GitHub queries are generated');
t('githubQueriesFor includes exact-name + SKILL.md + site:github.com forms', () => {
  const q = R.githubQueriesFor('gws-gmail-reply', {});
  assert.ok(q.includes('"gws-gmail-reply" SKILL.md'));
  assert.ok(q.includes('site:github.com "gws-gmail-reply"'));
  assert.ok(q.includes('site:github.com "skills/gws-gmail-reply"'));
});

console.log('\n4) nested repository paths are discovered');
t('repoPathCandidates includes nested skills/ and .claude/skills/ and packages/', () => {
  const p = R.repoPathCandidates('gws-gmail-reply');
  assert.ok(p.includes('skills/gws-gmail-reply/SKILL.md'));
  assert.ok(p.includes('.claude/skills/gws-gmail-reply/SKILL.md'));
  assert.ok(p.includes('packages/gws-gmail-reply/'));
});

console.log('\n5) similar names do not become false matches');
t('same name + different owner + no corroboration => NAME_COLLISION, not proceedable', () => {
  const v = R.verifyIdentity({ expectedName: 'gws-gmail-reply', foundName: 'gws-gmail-reply', expectedOwner: 'alice', foundOwner: 'bob' });
  assert.strictEqual(v.confidence, 'NAME_COLLISION');
  assert.strictEqual(v.canProceed, false);
});

console.log('\n6) firecrawl failure triggers the next fallback');
t('firecrawl_failed is recoverable, and the chain still offers search + github', () => {
  assert.strictEqual(R.classifyBlocker('firecrawl_failed').recoverable, true);
  const g = R.generateAlternatives({ name: 'x' }, { firecrawlAvailable: false });
  assert.ok(g.routes.some((r) => r.route === 'search_engine'));
  assert.ok(g.routes.some((r) => r.route === 'exact_name_github'));
});

console.log('\n7) unsafe candidate is rejected without stopping the mission');
t('malicious_code => hardStop, REJECTED_UNSAFE, missionContinue=true', () => {
  const c = R.classifyBlocker('malicious_code');
  assert.strictEqual(c.hardStop, true);
  assert.strictEqual(c.recommendedCandidateStatus, 'REJECTED_UNSAFE');
  assert.strictEqual(c.missionContinue, true);
});

console.log('\n8) Forge-native replacement can be proposed');
t('generateAlternatives includes forge_native_reimplementation', () => {
  const g = R.generateAlternatives({ name: 'x' }, {});
  assert.ok(g.routes.some((r) => r.route === 'forge_native_reimplementation'));
});

console.log('\n9) BLOCKED requires an attempt ledger');
t('canBlock with only a BLOCKED status (no ledger) is rejected', () => {
  const b = R.canBlock({ finalStatus: 'BLOCKED_ACCESS' });
  assert.strictEqual(b.ok, false);
  assert.ok(b.missing.length >= 1);
});

console.log('\n10) Verify Agent rejects insufficient recovery evidence');
t('2 alternatives + no verify verdict => canBlock false; complete record => true', () => {
  const insufficient = R.canBlock({ finalStatus: 'BLOCKED_AFTER_EXHAUSTIVE_RECOVERY', alternativesAttempted: ['a', 'b'], queries: ['q'], tools: ['webfetch'] });
  assert.strictEqual(insufficient.ok, false); // <3 alternatives AND no verify verdict
  const complete = R.canBlock({ finalStatus: 'BLOCKED_AFTER_EXHAUSTIVE_RECOVERY', alternativesAttempted: ['a', 'b', 'c'], queries: ['q'], tools: ['webfetch'], verifyVerdict: 'BLOCKED' });
  assert.strictEqual(complete.ok, true);
});

console.log('\n11) independent tracks continue when one item is blocked');
t('policy.continueIndependentTracks true and 403 keeps missionContinue', () => {
  assert.strictEqual(R.loadPolicy().continueIndependentTracks, true);
  assert.strictEqual(R.classifyBlocker('http_403').missionContinue, true);
});

console.log('\n12+14) real global instructions contain the policy AND preserve existing rules');
// Rewritten 2026-07-23 (codex flagged the old fs-append fixture as tautological — it exercised nothing).
// This asserts the REAL merge OUTCOME: the policy import is present AND a pre-existing modular import
// still is (proving existing rules were preserved). The else-branch is a real assertion, never a no-op.
t('global CLAUDE.md carries the policy import + a pre-existing import (or project config proves inheritance)', () => {
  const g = path.join(os.homedir(), '.claude', 'CLAUDE.md');
  if (fs.existsSync(g)) {
    const txt = fs.readFileSync(g, 'utf8');
    assert.ok(/@GLOBAL_RESEARCH_RECOVERY_POLICY\.md|global research recovery/i.test(txt), 'policy not merged into global');
    assert.ok(/@ECC_GLOBAL_POLICY\.md|@TOKEN_EFFICIENCY_GLOBAL_POLICY\.md|@CODEX_GLOBAL_POLICY\.md/.test(txt), 'existing imports not preserved');
  } else {
    const cfg = path.join(__dirname, '..', 'config', 'orchestration', 'FORGE_RECOVERY_POLICY.json');
    assert.ok(fs.existsSync(cfg), 'no global file and no project policy config');
    assert.strictEqual(JSON.parse(fs.readFileSync(cfg, 'utf8')).solutionFirst, true);
  }
});

console.log('\n13) new Forge projects inherit the machine-readable policy');
t('project FORGE_RECOVERY_POLICY.json exists with the key invariants', () => {
  const cfg = path.join(__dirname, '..', 'config', 'orchestration', 'FORGE_RECOVERY_POLICY.json');
  assert.ok(fs.existsSync(cfg), 'policy config missing');
  const p = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  assert.strictEqual(p.solutionFirst, true);
  assert.strictEqual(p.allowAuthBypass, false);
  assert.strictEqual(p.requireAttemptLedgerBeforeBlocked, true);
});

console.log('\n15) no authentication bypass route is permitted');
t('assertNoAuthBypass throws on a bypass route; every generated route is safe', () => {
  assert.throws(() => R.assertNoAuthBypass({ route: 'auth_bypass' }), /allowAuthBypass=false/);
  assert.throws(() => R.assertNoAuthBypass({ route: 'public_pages', authBypass: true }), /bypass/);
  assert.strictEqual(R.loadPolicy().allowAuthBypass, false);
  const g = R.generateAlternatives({ name: 'x' }, {});
  g.routes.forEach((r) => assert.strictEqual(R.assertNoAuthBypass(r), true));
});

console.log('\n16) secrets are redacted from recovery logs');
t('redactSecrets masks nvapi/sk/ghp/Bearer and KEY=value; nested via redactRecord', () => {
  const s = R.redactSecrets('NVIDIA_API_KEY=nvapi-abc123def456ghi789 tok=Bearer sk-ABCDEFGH12345678');
  assert.ok(!s.includes('nvapi-abc123def456ghi789'));
  assert.ok(!s.includes('sk-ABCDEFGH12345678'));
  assert.ok(s.includes('***REDACTED***'));
  const rec = R.redactRecord({ note: 'key is ghp_ABCDEFGHIJKLMNOPQRST12', ok: true });
  assert.ok(!JSON.stringify(rec).includes('ghp_ABCDEFGHIJKLMNOPQRST12'));
});
t('recordAttempt(dryRun) returns a redacted, fully-shaped record and writes nothing', () => {
  const rec = R.recordAttempt({ itemId: 's1', initialFailure: 'token NVIDIA_API_KEY=nvapi-zzz999aaa888bbb', finalStatus: 'FOUND_VIA_GITHUB_SEARCH' }, { dryRun: true, now: '2026-07-23T00:00:00Z' });
  assert.ok(!JSON.stringify(rec).includes('nvapi-zzz999aaa888bbb'));
  assert.strictEqual(rec.timestamp, '2026-07-23T00:00:00Z');
  assert.ok('alternativesGenerated' in rec && 'verifyVerdict' in rec);
});
t('recordAttempt writes one JSONL line to a tmp ledger (hermetic)', () => {
  const dir = freshDir('recovery-ledger');
  const lp = path.join(dir, 'recovery-attempts.jsonl');
  R.recordAttempt({ itemId: 's2', finalStatus: 'FOUND_VIA_PUBLIC_FALLBACK' }, { ledgerPath: lp, now: '2026-07-23T00:00:00Z' });
  const lines = fs.readFileSync(lp, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(JSON.parse(lines[0]).itemId, 's2');
});

console.log('\n17) recovered source maps to the correct skill');
t('exact name + owner + SKILL.md => VERIFIED_EXACT and proceedable', () => {
  const v = R.verifyIdentity({ expectedName: 'gws-gmail-reply', foundName: 'gws-gmail-reply', expectedOwner: 'acme', foundOwner: 'acme', hasSkillMd: true });
  assert.strictEqual(v.confidence, 'VERIFIED_EXACT');
  assert.strictEqual(v.canProceed, true);
});

console.log('\n18) false GitHub matches are detected');
t('an unrelated found name => not proceedable', () => {
  const v = R.verifyIdentity({ expectedName: 'gws-gmail-reply', foundName: 'kubernetes-operator' });
  assert.strictEqual(v.canProceed, false);
  assert.ok(v.confidence === 'UNVERIFIED' || v.confidence === 'POSSIBLE');
});

console.log('\n19) public descriptions can locate original repositories');
t('githubQueriesFor with a description yields a description-based query', () => {
  const q = R.githubQueriesFor('gws-gmail-reply', { description: 'Automatically sets In-Reply-To header' });
  assert.ok(q.some((s) => /description search:/.test(s)));
  assert.ok(q.some((s) => s.includes('"Automatically sets In-Reply-To header"')));
});

console.log('\n20) a failed method is distinguished from an impossible objective');
t('http_401 objective still possible; a 410 gone flags objectiveImpossible', () => {
  const c = R.classifyBlocker('http_401');
  assert.strictEqual(c.objectiveImpossible, false);
  assert.strictEqual(c.recoverable, true);
  assert.strictEqual(R.classifyBlocker('410').objectiveImpossible, true);
});

console.log('\n21-24) engine invariants');
t('finalStatusValid accepts allowed statuses and rejects junk', () => {
  assert.strictEqual(R.finalStatusValid('FORGE_NATIVE_REIMPLEMENTATION'), true);
  assert.strictEqual(R.finalStatusValid('SKIPPED'), false);
});
t('requiredAlternatives is 3 normal / 5 high-value', () => {
  assert.strictEqual(R.requiredAlternatives(R.loadPolicy(), false), 3);
  assert.strictEqual(R.requiredAlternatives(R.loadPolicy(), true), 5);
});
t('high-value generateAlternatives still meets the >=5 minimum', () => {
  const g = R.generateAlternatives({ name: 'x', owner: 'o', description: 'does a thing' }, { highValue: true, firecrawlAvailable: true });
  assert.strictEqual(g.min, 5);
  assert.strictEqual(g.meetsMin, true);
});
t('CLI selftest exits 0; bad command exits 2', () => {
  assert.strictEqual(spawnSync(process.execPath, [CLI, 'selftest'], { encoding: 'utf8' }).status, 0);
  assert.strictEqual(spawnSync(process.execPath, [CLI, 'bogus'], { encoding: 'utf8' }).status, 2);
});

console.log('\n25) adversarial-review hardening (2026-07-23 — fixes for real workflow findings)');
t('redactSecrets now masks AWS/Google/Slack/JWT token shapes', () => {
  const s = R.redactSecrets('a AKIAIOSFODNN7EXAMPLE b AIzaSyD0123456789abcdefghijklmnopqrstuvw c xoxb-111111111111-abcdefabcdef d eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdEFGh');
  assert.ok(!s.includes('AKIAIOSFODNN7EXAMPLE'), 'AWS key leaked');
  assert.ok(!s.includes('AIzaSyD0123456789abcdefghijklmnopqrstuvw'), 'Google key leaked');
  assert.ok(!s.includes('xoxb-111111111111-abcdefabcdef'), 'Slack token leaked');
  assert.ok(!/eyJhbGciOiJIUzI1NiJ9\.eyJzdWIiOiIxIn0\.abcdEFGh/.test(s), 'JWT leaked');
});
t('redactSecrets does NOT over-redact hyphenated words / non-secret names / lowercase', () => {
  assert.strictEqual(R.redactSecrets('task-management-workflow'), 'task-management-workflow');
  assert.strictEqual(R.redactSecrets('risk-assessment-report'), 'risk-assessment-report');
  assert.strictEqual(R.redactSecrets('MONKEY=banana'), 'MONKEY=banana');
  assert.strictEqual(R.redactSecrets('TOKENIZER=gpt2-large'), 'TOKENIZER=gpt2-large');
  assert.strictEqual(R.redactSecrets('monkey: banana bread'), 'monkey: banana bread');
});
t('redactSecrets does NOT redact a git SHA / content hash (legitimate ledger data)', () => {
  const sha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  assert.strictEqual(R.redactSecrets('hash ' + sha), 'hash ' + sha);
});
t('redactSecrets DOES redact real env-style secret assignments', () => {
  assert.ok(R.redactSecrets('NVIDIA_API_KEY=nvapi-abc123def456ghi').includes('***REDACTED***'));
  assert.ok(R.redactSecrets('AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIexample').includes('***REDACTED***'));
  assert.ok(!R.redactSecrets('API_TOKEN=supersecretvalue').includes('supersecretvalue'));
});
t('canBlock rejects a fabricated empty-string ledger + junk verdict (the exploit)', () => {
  const b = R.canBlock({ finalStatus: 'BLOCKED_ACCESS', alternativesAttempted: ['', '', ''], queries: [''], tools: [''], verifyVerdict: 'x' });
  assert.strictEqual(b.ok, false);
});
t('canBlock rejects an invalid BLOCKED status not in allowedFinalStatuses', () => {
  const b = R.canBlock({ finalStatus: 'BLOCKEDXYZ', alternativesAttempted: ['a', 'b', 'c'], queries: ['q'], tools: ['t'], verifyVerdict: 'BLOCKED' });
  assert.strictEqual(b.ok, false);
});
t('assertNoAuthBypass inspects method/description, not just the route id', () => {
  assert.throws(() => R.assertNoAuthBypass({ route: 'discovery', method: 'bypass login wall with a stolen session cookie' }), /allowAuthBypass=false/);
  assert.throws(() => R.assertNoAuthBypass({ route: 'session_hijack' }), /allowAuthBypass=false/);
  assert.throws(() => R.assertNoAuthBypass({ route: 'privilege_escalation' }), /allowAuthBypass=false/);
  assert.strictEqual(R.assertNoAuthBypass({ route: 'public_pages', method: 'public leaderboards' }), true);
});
t('classifyBlocker exposes autoReject/action so hard-stops are not silently un-rejected', () => {
  const c = R.classifyBlocker('malicious_code');
  assert.strictEqual(c.autoReject, true);
  assert.strictEqual(c.action, 'reject_candidate');
  const ok = R.classifyBlocker('http_401');
  assert.strictEqual(ok.autoReject, false);
  assert.strictEqual(ok.action, 'recover');
});
t('numeric 410 maps to gone_410 (symmetry fix from Verify Agent)', () => {
  assert.strictEqual(R.classifyBlocker(410).signal, 'gone_410');
  assert.strictEqual(R.classifyBlocker(410).objectiveImpossible, true);
  assert.strictEqual(R.classifyBlocker('410').objectiveImpossible, true);
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
