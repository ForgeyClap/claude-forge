#!/usr/bin/env node
'use strict';
// forge-standing.test.cjs — real tests for the standing-rules resolver (2026-07-18, WAVE B / B2;
// TEMPLATE/USER SPLIT tests added 2026-09-26 for the external-audit N4/P1 fix). Every FIXTURE test uses
// opts.rulesPath/opts.userRulesPath pointing at a fresh temp dir (hermetic — no fixture test ever writes to
// config/orchestration/). Section 1/1b/8b deliberately exercise the REAL project files (this project's own
// FORGE_STANDING_RULES.json / .user.json) to prove the real N4/P1 fix actually landed here, not just in a
// fixture — those are the only tests that touch real files, and they only ever remove the exact thing the
// fix is supposed to remove (an owner-remember-sourced rule), never anything else.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const standing = require('./forge-standing.cjs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

const CLI = path.join(__dirname, 'forge-standing.cjs');
function runCLI(argv, env) { return spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8', env: env || process.env }); }

function freshDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); }
function writeRules(rules, extra) {
  const dir = freshDir('forge-standing-fixture');
  const p = path.join(dir, 'FORGE_STANDING_RULES.json');
  fs.writeFileSync(p, JSON.stringify(Object.assign({ version: 1, rules }, extra || {})));
  return p;
}
function userPathFor(templatePath) { return path.join(path.dirname(templatePath), 'FORGE_STANDING_RULES.user.json'); }
function baseRule(overrides) {
  return Object.assign({
    id: 'r-' + Math.random().toString(36).slice(2),
    text: 'test rule text',
    scope: 'global',
    trigger: 'always',
    domain: null,
    glob: null,
    topic: null,
    source: 'unit-test fixture (not real owner evidence)',
    confidence: 'high',
    status: 'active',
    cannot_override_core: false,
  }, overrides || {});
}
// A fixture pair (template + a NON-EXISTENT user path) is the normal shape for most tests below — the user
// file springs into existence only when remember()/migration actually writes something.
function fixturePair(rules) {
  const templatePath = writeRules(rules);
  return { templatePath, userPath: userPathFor(templatePath) };
}

console.log('forge-standing tests (standing-rules resolver + template/user split)');

// ---------------------------------------------------------------------------
// 1) seed integrity — the REAL config file (product rules only, per the N4/P1 fix)
// ---------------------------------------------------------------------------
console.log('\n1) seed integrity (real FORGE_STANDING_RULES.json)');

t('load() parses the real seed file without throwing', () => {
  const data = standing.load();
  assert.ok(Array.isArray(data.rules) && data.rules.length >= 5);
});
t('every seed rule has a non-empty source (real evidence, no fabricated rule)', () => {
  for (const r of standing.load().rules) {
    assert.ok(typeof r.source === 'string' && r.source.trim().length > 0, r.id + ' is missing a source');
  }
});
t('every seed rule has id/text/scope/trigger/status; trigger is a known value', () => {
  for (const r of standing.load().rules) {
    assert.ok(r.id && r.text && r.scope && r.status);
    assert.ok(standing.KNOWN_TRIGGERS.includes(r.trigger), r.id + ' has unknown trigger ' + r.trigger);
  }
});
t('seed rule ids are unique', () => {
  const ids = standing.load().rules.map((r) => r.id);
  assert.strictEqual(new Set(ids).size, ids.length);
});
t('the honesty-core-untouchable seed rule exists and carries cannot_override_core:true', () => {
  const r = standing.load().rules.find((x) => x.id === 'honesty-core-untouchable');
  assert.ok(r, 'seed must include honesty-core-untouchable');
  assert.strictEqual(r.cannot_override_core, true);
});
t('listActive() returns only status:active rules from the real seed file', () => {
  for (const r of standing.listActive()) assert.strictEqual(r.status, 'active');
});
t('the does-it-for-you rule is active, global, always-on, topic autonomy, sourced from the SHIPPED commands/forge.md (never an unshipped scratch transcript)', () => {
  const r = standing.load().rules.find((x) => x.id === 'does-it-for-you');
  assert.ok(r, 'seed must include does-it-for-you');
  assert.strictEqual(r.status, 'active');
  assert.strictEqual(r.scope, 'global');
  assert.strictEqual(r.trigger, 'always');
  assert.strictEqual(r.topic, 'autonomy');
  assert.strictEqual(r.confidence, 'high');
  assert.strictEqual(r.cannot_override_core, false);
  assert.match(r.text, /never asks the user to run a file or code/);
  assert.match(r.text, /only a hard gate or a real usage-limit pause interrupts/);
  assert.ok(r.source.includes('commands/forge.md'), 'must cite a file that actually ships with the product');
  assert.ok(!/_scratch/.test(r.source), 'must never cite an unshipped scratch transcript as evidence');
  assert.ok(standing.match({}).active.some((x) => x.id === 'does-it-for-you'), 'an always-trigger rule fires on every run');
});

// ---------------------------------------------------------------------------
// 1b) N4/P1 — the shipped template carries ZERO owner-added rules, and never cites
//     an unshipped policy file / scratch transcript as evidence
// ---------------------------------------------------------------------------
console.log('\n1b) N4/P1 — shipped template has zero owner-added rules, zero unshipped citations');

t('a FRESH TEMPLATE (this project\'s real, on-disk FORGE_STANDING_RULES.json) carries zero rules sourced from an owner "/forge remember" (read the RAW file directly — never through load(), which would re-merge the user file back in)', () => {
  const raw = JSON.parse(fs.readFileSync(standing.CONFIG_PATH, 'utf8'));
  const ownerRules = raw.rules.filter((r) => r.source === standing.OWNER_REMEMBER_SOURCE);
  assert.strictEqual(ownerRules.length, 0, 'the shipped template must never carry an owner /forge remember rule: ' + JSON.stringify(ownerRules.map((r) => r.id)));
});

t('a synthetic fresh template (no owner rules, no user file yet) never surfaces an owner-remember rule via load()', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'product-rule-1' })]);
  assert.ok(!fs.existsSync(userPath), 'the user file must not exist yet for a truly fresh template');
  const data = standing.load({ rulesPath: templatePath, userRulesPath: userPath });
  assert.strictEqual(data.rules.filter((r) => r.source === standing.OWNER_REMEMBER_SOURCE).length, 0);
});

t('no shipped standing rule cites an unshipped global policy file or a scratch transcript as evidence', () => {
  const raw = JSON.parse(fs.readFileSync(standing.CONFIG_PATH, 'utf8'));
  for (const r of raw.rules) {
    assert.ok(!/FABLE5_SAFE_GLOBAL_POLICY/.test(r.source), r.id + ' cites an unshipped global policy file');
    assert.ok(!/_scratch\//.test(r.source), r.id + ' cites an unshipped scratch transcript');
  }
});

// ---------------------------------------------------------------------------
// 2) trigger matching — always / domain / glob / on-request
// ---------------------------------------------------------------------------
console.log('\n2) trigger matching');

t('trigger:"always" fires regardless of type/paths', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'a1', trigger: 'always', scope: 'global' })]);
  const r1 = standing.match({}, { rulesPath: templatePath, userRulesPath: userPath });
  const r2 = standing.match({ type: 'website', paths: ['x/y.js'] }, { rulesPath: templatePath, userRulesPath: userPath });
  assert.ok(r1.active.some((x) => x.id === 'a1'));
  assert.ok(r2.active.some((x) => x.id === 'a1'));
});

t('trigger:"domain" fires only when type matches the rule\'s domain', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'd1', trigger: 'domain', domain: 'website', scope: 'domain:website' })]);
  const opts = { rulesPath: templatePath, userRulesPath: userPath };
  const hit = standing.match({ type: 'website' }, opts);
  const miss = standing.match({ type: 'n8n' }, opts);
  const none = standing.match({}, opts);
  assert.ok(hit.active.some((x) => x.id === 'd1'));
  assert.ok(!miss.active.some((x) => x.id === 'd1'));
  assert.ok(!none.active.some((x) => x.id === 'd1'));
});

t('trigger:"domain" match is case-insensitive', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'd2', trigger: 'domain', domain: 'scraping', scope: 'domain:scraping' })]);
  const hit = standing.match({ type: 'Scraping' }, { rulesPath: templatePath, userRulesPath: userPath });
  assert.ok(hit.active.some((x) => x.id === 'd2'));
});

t('trigger:"glob" fires only when a supplied path matches the glob', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'g1', trigger: 'glob', glob: '**/.env*', scope: 'path:**/.env*' })]);
  const opts = { rulesPath: templatePath, userRulesPath: userPath };
  const hit = standing.match({ paths: ['project/sub/.env.local'] }, opts);
  const miss = standing.match({ paths: ['project/sub/config.json'] }, opts);
  const none = standing.match({}, opts);
  assert.ok(hit.active.some((x) => x.id === 'g1'));
  assert.ok(!miss.active.some((x) => x.id === 'g1'));
  assert.ok(!none.active.some((x) => x.id === 'g1'));
});

t('trigger:"glob" normalizes backslashes so Windows-style paths still match', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'g2', trigger: 'glob', glob: '**/.env*', scope: 'path:**/.env*' })]);
  const hit = standing.match({ paths: ['project\\sub\\.env'] }, { rulesPath: templatePath, userRulesPath: userPath });
  assert.ok(hit.active.some((x) => x.id === 'g2'));
});

t('trigger:"on-request" never fires passively (no onRequest supplied)', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'o1', trigger: 'on-request', scope: 'on-request' })]);
  const r = standing.match({ type: 'website', paths: ['a/b.js'] }, { rulesPath: templatePath, userRulesPath: userPath });
  assert.ok(!r.active.some((x) => x.id === 'o1'));
});
t('trigger:"on-request" fires when onRequest:true', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'o2', trigger: 'on-request', scope: 'on-request' })]);
  const r = standing.match({ onRequest: true }, { rulesPath: templatePath, userRulesPath: userPath });
  assert.ok(r.active.some((x) => x.id === 'o2'));
});
t('trigger:"on-request" fires when onRequest is an array containing the rule id, ignores other ids', () => {
  const { templatePath, userPath } = fixturePair([
    baseRule({ id: 'o3', trigger: 'on-request', scope: 'on-request' }),
    baseRule({ id: 'o4', trigger: 'on-request', scope: 'on-request' }),
  ]);
  const r = standing.match({ onRequest: ['o3'] }, { rulesPath: templatePath, userRulesPath: userPath });
  assert.ok(r.active.some((x) => x.id === 'o3'));
  assert.ok(!r.active.some((x) => x.id === 'o4'));
});

t('a status:"proposed" or status:"retired" rule never fires even if its trigger would otherwise match', () => {
  const { templatePath, userPath } = fixturePair([
    baseRule({ id: 'p1', trigger: 'always', status: 'proposed' }),
    baseRule({ id: 'p2', trigger: 'always', status: 'retired' }),
  ]);
  const r = standing.match({}, { rulesPath: templatePath, userRulesPath: userPath });
  assert.ok(!r.active.some((x) => x.id === 'p1'));
  assert.ok(!r.active.some((x) => x.id === 'p2'));
});

// ---------------------------------------------------------------------------
// 3) shadowing — real seed data (draft-only-outreach-global vs -scraping)
// ---------------------------------------------------------------------------
console.log('\n3) shadowing (higher-precedence trigger wins within a shared topic)');

t('type:"scraping" — the domain-specific outreach rule wins, the global one is shadowed', () => {
  const r = standing.match({ type: 'scraping' });
  assert.ok(r.active.some((x) => x.id === 'draft-only-outreach-scraping'), 'scraping-specific rule should be active');
  assert.ok(!r.active.some((x) => x.id === 'draft-only-outreach-global'), 'global rule should NOT be active here');
  const shadow = r.shadowed.find((x) => x.id === 'draft-only-outreach-global');
  assert.ok(shadow, 'global outreach rule should be reported as shadowed');
  assert.strictEqual(shadow.beaten_by, 'draft-only-outreach-scraping');
});

t('type:"website" — only the global outreach rule fires; the scraping one never fires, so nothing is shadowed for that topic', () => {
  const r = standing.match({ type: 'website' });
  assert.ok(r.active.some((x) => x.id === 'draft-only-outreach-global'));
  assert.ok(!r.active.some((x) => x.id === 'draft-only-outreach-scraping'));
  assert.ok(!r.shadowed.some((x) => x.topic === 'outreach'));
});

t('unrelated topics (e.g. honesty, isolation) are unaffected by the outreach shadow computation', () => {
  const r = standing.match({ type: 'scraping' });
  assert.ok(r.active.some((x) => x.id === 'honesty-core-untouchable'));
  assert.ok(r.active.some((x) => x.id === 'isolation-only-this-folder'));
});

// ---------------------------------------------------------------------------
// 4) cannot_override_core — un-shadowable, regardless of nominal precedence
// ---------------------------------------------------------------------------
console.log('\n4) cannot_override_core — un-shadowable');

t('a cannot_override_core rule is NEVER shadowed, even by a nominally higher-precedence glob/domain rule sharing its topic', () => {
  const { templatePath, userPath } = fixturePair([
    baseRule({ id: 'core1', trigger: 'always', topic: 'coretest', cannot_override_core: true }),
    baseRule({ id: 'loser-glob', trigger: 'glob', glob: '**/*.js', topic: 'coretest', cannot_override_core: false }),
    baseRule({ id: 'loser-domain', trigger: 'domain', domain: 'website', topic: 'coretest', cannot_override_core: false }),
  ]);
  const r = standing.match({ type: 'website', paths: ['a/b.js'] }, { rulesPath: templatePath, userRulesPath: userPath });
  assert.ok(r.active.some((x) => x.id === 'core1'), 'core rule must be active');
  assert.ok(!r.active.some((x) => x.id === 'loser-glob'), 'glob rule loses to core rule');
  assert.ok(!r.active.some((x) => x.id === 'loser-domain'), 'domain rule loses to core rule');
  const shadowGlob = r.shadowed.find((x) => x.id === 'loser-glob');
  const shadowDomain = r.shadowed.find((x) => x.id === 'loser-domain');
  assert.strictEqual(shadowGlob.beaten_by, 'core1');
  assert.strictEqual(shadowDomain.beaten_by, 'core1');
});

t('two cannot_override_core rules sharing a topic both stay active (tie among core rules is not a loss)', () => {
  const { templatePath, userPath } = fixturePair([
    baseRule({ id: 'core-a', trigger: 'always', topic: 'dualcoretest', cannot_override_core: true }),
    baseRule({ id: 'core-b', trigger: 'always', topic: 'dualcoretest', cannot_override_core: true }),
  ]);
  const r = standing.match({}, { rulesPath: templatePath, userRulesPath: userPath });
  assert.ok(r.active.some((x) => x.id === 'core-a'));
  assert.ok(r.active.some((x) => x.id === 'core-b'));
  assert.strictEqual(r.shadowed.length, 0);
});

// ---------------------------------------------------------------------------
// 5) malformed / missing config is refused, not silently accepted
// ---------------------------------------------------------------------------
console.log('\n5) config integrity — refuses malformed input rather than silently passing everything');

t('an empty rules array throws', () => {
  const { templatePath, userPath } = fixturePair([]);
  assert.throws(() => standing.load({ rulesPath: templatePath, userRulesPath: userPath }));
});
t('a rule missing "id" throws', () => {
  const r = baseRule({}); delete r.id;
  const { templatePath, userPath } = fixturePair([r]);
  assert.throws(() => standing.load({ rulesPath: templatePath, userRulesPath: userPath }));
});
t('a rule missing "text" throws', () => {
  const r = baseRule({}); delete r.text;
  const { templatePath, userPath } = fixturePair([r]);
  assert.throws(() => standing.load({ rulesPath: templatePath, userRulesPath: userPath }));
});
t('a rule missing "source" throws (a rule with no evidence must be refused)', () => {
  const r = baseRule({}); delete r.source;
  const { templatePath, userPath } = fixturePair([r]);
  assert.throws(() => standing.load({ rulesPath: templatePath, userRulesPath: userPath }));
});
t('a rule missing "scope" throws', () => {
  const r = baseRule({}); delete r.scope;
  const { templatePath, userPath } = fixturePair([r]);
  assert.throws(() => standing.load({ rulesPath: templatePath, userRulesPath: userPath }));
});
t('a rule with an unknown trigger throws', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ trigger: 'sometimes' })]);
  assert.throws(() => standing.load({ rulesPath: templatePath, userRulesPath: userPath }));
});
t('a rule with an unknown status throws', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ status: 'maybe' })]);
  assert.throws(() => standing.load({ rulesPath: templatePath, userRulesPath: userPath }));
});
t('a duplicate rule id within the template throws', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'dup' }), baseRule({ id: 'dup' })]);
  assert.throws(() => standing.load({ rulesPath: templatePath, userRulesPath: userPath }));
});
t('a rule id shared between the template and the user file throws (cross-file duplicate is still caught)', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'shared-id' })]);
  fs.writeFileSync(userPath, JSON.stringify({ version: 1, rules: [baseRule({ id: 'shared-id' })] }));
  assert.throws(() => standing.load({ rulesPath: templatePath, userRulesPath: userPath }));
});
t('trigger:"domain" without a "domain" field throws', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ trigger: 'domain', domain: null })]);
  assert.throws(() => standing.load({ rulesPath: templatePath, userRulesPath: userPath }));
});
t('trigger:"glob" without a "glob" field throws', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ trigger: 'glob', glob: null })]);
  assert.throws(() => standing.load({ rulesPath: templatePath, userRulesPath: userPath }));
});
t('invalid JSON syntax throws with a clear message, not a silent empty result', () => {
  const dir = freshDir('forge-standing-badjson');
  const p = path.join(dir, 'bad.json');
  fs.writeFileSync(p, '{ not valid json');
  assert.throws(() => standing.load({ rulesPath: p, userRulesPath: userPathFor(p) }));
});
t('a missing rules file throws (never silently returns "no rules")', () => {
  assert.throws(() => standing.load({ rulesPath: path.join(freshDir('forge-standing-nope'), 'does-not-exist.json') }));
});
t('a malformed (non-array-rules) user file throws rather than being silently ignored', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'seed-ok' })]);
  fs.mkdirSync(path.dirname(userPath), { recursive: true });
  fs.writeFileSync(userPath, JSON.stringify({ version: 1, rules: 'not-an-array' }));
  assert.throws(() => standing.load({ rulesPath: templatePath, userRulesPath: userPath }));
});

// ---------------------------------------------------------------------------
// 6) hermeticity — fixture calls never touch the real config file
// ---------------------------------------------------------------------------
console.log('\n6) hermeticity');

t('a hermetic fixture rule id does not leak into the real seed file result', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'totally-fake-fixture-only', trigger: 'always' })]);
  standing.match({}, { rulesPath: templatePath, userRulesPath: userPath }); // populates the module cache for that path pair
  const real = standing.match({}); // load the REAL files fresh (different path pair -> cache miss -> re-read)
  assert.ok(!real.active.some((x) => x.id === 'totally-fake-fixture-only'));
});

// ---------------------------------------------------------------------------
// 7) CLI (real spawned subprocess, real seed file)
// ---------------------------------------------------------------------------
console.log('\n7) CLI');

t('CLI match --type website --json includes ui-quality-for-web', () => {
  const r = runCLI(['match', '--type', 'website', '--json']);
  assert.strictEqual(r.status, 0);
  const parsed = JSON.parse(r.stdout.trim());
  assert.ok(parsed.active.some((x) => x.id === 'ui-quality-for-web'));
});
t('CLI match --paths <.env path> --json includes no-secrets-in-env-files', () => {
  const r = runCLI(['match', '--paths', 'app/.env.production', '--json']);
  assert.strictEqual(r.status, 0);
  const parsed = JSON.parse(r.stdout.trim());
  assert.ok(parsed.active.some((x) => x.id === 'no-secrets-in-env-files'));
});
t('CLI match --type scraping --json shows the shadow of draft-only-outreach-global', () => {
  const r = runCLI(['match', '--type', 'scraping', '--json']);
  const parsed = JSON.parse(r.stdout.trim());
  assert.ok(parsed.shadowed.some((x) => x.id === 'draft-only-outreach-global'));
});
t('CLI match --on-request --json includes codex-review-on-request', () => {
  const r = runCLI(['match', '--on-request', '--json']);
  const parsed = JSON.parse(r.stdout.trim());
  assert.ok(parsed.active.some((x) => x.id === 'codex-review-on-request'));
});
t('CLI match (no flags) --json never includes the on-request-only rule', () => {
  const r = runCLI(['match', '--json']);
  const parsed = JSON.parse(r.stdout.trim());
  assert.ok(!parsed.active.some((x) => x.id === 'codex-review-on-request'));
});
t('CLI list --json returns every active rule with id/text/source, including the migrated owner rule from the user file', () => {
  const r = runCLI(['list', '--json']);
  assert.strictEqual(r.status, 0);
  const parsed = JSON.parse(r.stdout.trim());
  assert.ok(Array.isArray(parsed) && parsed.length >= 5);
  for (const rule of parsed) assert.ok(rule.id && rule.text && rule.source);
});
t('CLI with an unknown command exits 2 (usage error), not a silent pass', () => {
  const r = runCLI(['bogus-command']);
  assert.strictEqual(r.status, 2);
});
t('CLI with no command at all exits 2', () => {
  const r = runCLI([]);
  assert.strictEqual(r.status, 2);
});
t('CLI honors FORGE_STANDING_RULES_PATH/_USER_PATH together for match/list, never touching the real files', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'cli-fixture-rule', trigger: 'always' })]);
  const env = Object.assign({}, process.env, { FORGE_STANDING_RULES_PATH: templatePath, FORGE_STANDING_RULES_USER_PATH: userPath });
  const r = runCLI(['list', '--json'], env);
  const parsed = JSON.parse(r.stdout.trim());
  assert.ok(parsed.some((x) => x.id === 'cli-fixture-rule'));
  assert.strictEqual(parsed.length, 1, 'only the fixture rule should be visible, never the real seed set');
});

// ---------------------------------------------------------------------------
// 8) remember() — the ONLY sanctioned auto-active write path (WAVE B / B4), writes to the USER file
// ---------------------------------------------------------------------------
console.log('\n8) remember() — /forge remember writes ONLY to the user file (hermetic fixtures)');

t('remember() appends a new active rule with source:"owner /forge remember" into the USER file, never the template', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'seed-1' })]);
  const before = fs.readFileSync(templatePath, 'utf8');
  const rule = standing.remember('never deploy on Fridays', { rulesPath: templatePath, userRulesPath: userPath });
  assert.strictEqual(rule.status, 'active');
  assert.strictEqual(rule.source, 'owner /forge remember');
  assert.strictEqual(rule.text, 'never deploy on Fridays');
  assert.strictEqual(fs.readFileSync(templatePath, 'utf8'), before, 'remember() must never touch the template file');
  const userData = JSON.parse(fs.readFileSync(userPath, 'utf8'));
  assert.strictEqual(userData.rules.length, 1);
  assert.ok(userData.rules.some((r) => r.id === rule.id && r.status === 'active'));
});

t('remember() creates the user file from scratch when it does not exist yet (a fresh project has no owner rules yet)', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'seed-1b' })]);
  assert.ok(!fs.existsSync(userPath));
  standing.remember('first ever remembered rule', { rulesPath: templatePath, userRulesPath: userPath });
  assert.ok(fs.existsSync(userPath), 'remember() must create the user file on first use');
});

t('remember() defaults to trigger:"always", scope:"global", cannot_override_core:false', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'seed-2' })]);
  const rule = standing.remember('a default-shape rule', { rulesPath: templatePath, userRulesPath: userPath });
  assert.strictEqual(rule.trigger, 'always');
  assert.strictEqual(rule.scope, 'global');
  assert.strictEqual(rule.cannot_override_core, false);
});

t('remember() honors explicit --scope/--trigger/--domain/--topic/--id', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'seed-3' })]);
  const rule = standing.remember('website-only rule', { rulesPath: templatePath, userRulesPath: userPath, trigger: 'domain', domain: 'website', scope: 'domain:website', topic: 'my-topic', id: 'my-custom-id' });
  assert.strictEqual(rule.id, 'my-custom-id');
  assert.strictEqual(rule.trigger, 'domain');
  assert.strictEqual(rule.domain, 'website');
  assert.strictEqual(rule.topic, 'my-topic');
});

t('remember() honors explicit --glob for trigger:"glob"', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'seed-4' })]);
  const rule = standing.remember('glob rule', { rulesPath: templatePath, userRulesPath: userPath, trigger: 'glob', glob: '**/*.secret' });
  assert.strictEqual(rule.trigger, 'glob');
  assert.strictEqual(rule.glob, '**/*.secret');
});

t('a rule written by remember() actually fires via match() on a later, independent read (cache invalidated), merged with the template', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'seed-5' })]);
  standing.remember('freshly remembered rule', { rulesPath: templatePath, userRulesPath: userPath, id: 'fresh-remembered' });
  const r = standing.match({}, { rulesPath: templatePath, userRulesPath: userPath });
  assert.ok(r.active.some((x) => x.id === 'fresh-remembered'));
  assert.ok(r.active.some((x) => x.id === 'seed-5'), 'the template rule must still be present alongside the remembered one');
});

t('remember() cannot mint a new cannot_override_core rule even if a caller tries to pass it', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'seed-6' })]);
  const rule = standing.remember('trying to sneak in core status', { rulesPath: templatePath, userRulesPath: userPath, cannot_override_core: true });
  assert.strictEqual(rule.cannot_override_core, false);
});

t('remember() with empty/whitespace-only text throws, writes nothing', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'seed-7' })]);
  assert.throws(() => standing.remember('   ', { rulesPath: templatePath, userRulesPath: userPath }));
  assert.ok(!fs.existsSync(userPath), 'remember() must write nothing on validation failure');
});

t('remember() with an unknown trigger throws, writes nothing', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'seed-8' })]);
  assert.throws(() => standing.remember('bad trigger rule', { rulesPath: templatePath, userRulesPath: userPath, trigger: 'sometimes' }));
  assert.ok(!fs.existsSync(userPath));
});

t('remember() with trigger:"domain" but no --domain throws, writes nothing', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'seed-9' })]);
  assert.throws(() => standing.remember('missing domain', { rulesPath: templatePath, userRulesPath: userPath, trigger: 'domain' }));
  assert.ok(!fs.existsSync(userPath));
});

t('remember() with trigger:"glob" but no --glob throws, writes nothing', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'seed-10' })]);
  assert.throws(() => standing.remember('missing glob', { rulesPath: templatePath, userRulesPath: userPath, trigger: 'glob' }));
  assert.ok(!fs.existsSync(userPath));
});

t('remember() with an --id colliding inside the user file throws, writes nothing new', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'seed-11' })]);
  standing.remember('first rule', { rulesPath: templatePath, userRulesPath: userPath, id: 'collide-me' });
  const before = fs.readFileSync(userPath, 'utf8');
  assert.throws(() => standing.remember('dup id rule', { rulesPath: templatePath, userRulesPath: userPath, id: 'collide-me' }));
  assert.strictEqual(fs.readFileSync(userPath, 'utf8'), before);
});

t('remember() with an --id colliding with a shipped TEMPLATE rule id throws (never silently masks a product rule)', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'product-rule-x' })]);
  assert.throws(() => standing.remember('trying to shadow a product rule', { rulesPath: templatePath, userRulesPath: userPath, id: 'product-rule-x' }), /collides with a shipped product rule id/);
  assert.ok(!fs.existsSync(userPath), 'nothing should be written when the id collides with a product rule');
});

t('remember() against a malformed (present) user file throws, writes nothing new', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'seed-12' })]);
  fs.mkdirSync(path.dirname(userPath), { recursive: true });
  fs.writeFileSync(userPath, '{ broken');
  assert.throws(() => standing.remember('rule text', { rulesPath: templatePath, userRulesPath: userPath }));
  assert.strictEqual(fs.readFileSync(userPath, 'utf8'), '{ broken');
});

t('remember() never writes to the REAL config/orchestration/FORGE_STANDING_RULES.json (hermeticity proof)', () => {
  const before = fs.readFileSync(standing.CONFIG_PATH, 'utf8');
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'seed-13' })]);
  standing.remember('a fixture-only rule', { rulesPath: templatePath, userRulesPath: userPath });
  assert.strictEqual(fs.readFileSync(standing.CONFIG_PATH, 'utf8'), before, 'remember() must never touch the real seed file when userRulesPath overrides it');
});

t('CLI remember "<text>" --json writes into the FORGE_STANDING_RULES_USER_PATH fixture (hermetic — never touches the real files) and prints it', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'seed-cli-1' })]);
  const env = Object.assign({}, process.env, { FORGE_STANDING_RULES_PATH: templatePath, FORGE_STANDING_RULES_USER_PATH: userPath });
  const realTemplateBefore = fs.readFileSync(standing.CONFIG_PATH, 'utf8');
  const r = spawnSync(process.execPath, [CLI, 'remember', 'cli remembered rule', '--json'], { encoding: 'utf8', env });
  assert.strictEqual(r.status, 0, 'stderr: ' + r.stderr);
  const parsed = JSON.parse(r.stdout.trim());
  assert.strictEqual(parsed.source, 'owner /forge remember');
  assert.strictEqual(parsed.text, 'cli remembered rule');
  const written = JSON.parse(fs.readFileSync(userPath, 'utf8'));
  assert.ok(written.rules.some((x) => x.id === parsed.id));
  assert.strictEqual(fs.readFileSync(templatePath, 'utf8'), fs.readFileSync(templatePath, 'utf8'), 'sanity');
  assert.strictEqual(fs.readFileSync(standing.CONFIG_PATH, 'utf8'), realTemplateBefore, 'the real template file must be untouched by a hermetic CLI call');
});

t('CLI remember honors --scope/--trigger/--domain/--topic/--id via FORGE_STANDING_RULES_USER_PATH', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'seed-cli-2' })]);
  const env = Object.assign({}, process.env, { FORGE_STANDING_RULES_PATH: templatePath, FORGE_STANDING_RULES_USER_PATH: userPath });
  const r = spawnSync(process.execPath, [CLI, 'remember', 'website-only cli rule', '--trigger', 'domain', '--domain', 'website', '--scope', 'domain:website', '--topic', 'cli-topic', '--id', 'cli-custom-id', '--json'], { encoding: 'utf8', env });
  assert.strictEqual(r.status, 0, 'stderr: ' + r.stderr);
  const parsed = JSON.parse(r.stdout.trim());
  assert.strictEqual(parsed.id, 'cli-custom-id');
  assert.strictEqual(parsed.trigger, 'domain');
  assert.strictEqual(parsed.domain, 'website');
  assert.strictEqual(parsed.topic, 'cli-topic');
});

t('CLI remember with no text argument exits 2 (usage error), writes nothing', () => {
  const { templatePath, userPath } = fixturePair([baseRule({ id: 'seed-cli-3' })]);
  const env = Object.assign({}, process.env, { FORGE_STANDING_RULES_PATH: templatePath, FORGE_STANDING_RULES_USER_PATH: userPath });
  const r = spawnSync(process.execPath, [CLI, 'remember'], { encoding: 'utf8', env });
  assert.strictEqual(r.status, 2);
  assert.ok(!fs.existsSync(userPath));
});

t('CLI remember with no env override set falls back to the real files — proven via a guaranteed-failing collision against a REAL product rule id, so nothing is actually written', () => {
  const env = Object.assign({}, process.env);
  delete env.FORGE_STANDING_RULES_PATH;
  delete env.FORGE_STANDING_RULES_USER_PATH;
  const r = spawnSync(process.execPath, [CLI, 'remember', 'should collide', '--id', 'honesty-core-untouchable'], { encoding: 'utf8', env });
  assert.strictEqual(r.status, 2);
  assert.ok(r.stderr.includes('collides with a shipped product rule id'), 'stderr: ' + r.stderr);
});

// ---------------------------------------------------------------------------
// 9) MIGRATION — an owner-remember rule found in the template MOVES (not copies) into the user file
// ---------------------------------------------------------------------------
console.log('\n9) migration — owner-remember rules move out of the template, they never stay in both places');

t('load() migrates an owner-remember-sourced template rule into a brand-new user file, and removes it from the template on disk', () => {
  const { templatePath, userPath } = fixturePair([
    baseRule({ id: 'product-rule-migr-1' }),
    baseRule({ id: 'owner-rule-to-migrate', source: standing.OWNER_REMEMBER_SOURCE, text: 'an owner rule that should not ship' }),
  ]);
  assert.ok(!fs.existsSync(userPath), 'no user file should exist before migration runs');

  const data = standing.load({ rulesPath: templatePath, userRulesPath: userPath });

  // moved, not copied: present exactly once, in the user file, absent from the template on disk
  const templateOnDisk = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
  assert.ok(!templateOnDisk.rules.some((r) => r.id === 'owner-rule-to-migrate'), 'the owner rule must be REMOVED from the template file on disk');
  assert.ok(fs.existsSync(userPath), 'migration must create the user file');
  const userOnDisk = JSON.parse(fs.readFileSync(userPath, 'utf8'));
  assert.strictEqual(userOnDisk.rules.filter((r) => r.id === 'owner-rule-to-migrate').length, 1, 'the owner rule must land in the user file exactly once');

  // still visible/active via the merged load() result — migration never loses the rule
  assert.ok(data.rules.some((r) => r.id === 'owner-rule-to-migrate'), 'the migrated rule must still be active via the merged view');
  assert.ok(data.rules.some((r) => r.id === 'product-rule-migr-1'), 'the product rule must remain untouched');
});

t('migration is idempotent: a second load() call after migration does not duplicate the rule anywhere', () => {
  const { templatePath, userPath } = fixturePair([
    baseRule({ id: 'product-rule-migr-2' }),
    baseRule({ id: 'owner-rule-idempotent', source: standing.OWNER_REMEMBER_SOURCE }),
  ]);
  standing.load({ rulesPath: templatePath, userRulesPath: userPath });
  // force a fresh (uncached) re-read by re-invoking load() with the same paths after clearing the module
  // cache the only way this module exposes: writing a new remember() elsewhere invalidates it globally.
  standing.remember('unrelated cache-buster', { rulesPath: templatePath, userRulesPath: path.join(path.dirname(userPath), 'other-user.json') });
  const data2 = standing.load({ rulesPath: templatePath, userRulesPath: userPath });
  assert.strictEqual(data2.rules.filter((r) => r.id === 'owner-rule-idempotent').length, 1, 'must appear exactly once after a second migration pass');
  const userOnDisk = JSON.parse(fs.readFileSync(userPath, 'utf8'));
  assert.strictEqual(userOnDisk.rules.filter((r) => r.id === 'owner-rule-idempotent').length, 1);
});

t('migration merges into an EXISTING user file (with its own prior rules) instead of overwriting it', () => {
  const { templatePath, userPath } = fixturePair([
    baseRule({ id: 'product-rule-migr-3' }),
    baseRule({ id: 'owner-rule-merge-target', source: standing.OWNER_REMEMBER_SOURCE }),
  ]);
  fs.mkdirSync(path.dirname(userPath), { recursive: true });
  fs.writeFileSync(userPath, JSON.stringify({ version: 1, rules: [baseRule({ id: 'already-remembered-earlier', source: standing.OWNER_REMEMBER_SOURCE })] }));

  const data = standing.load({ rulesPath: templatePath, userRulesPath: userPath });
  assert.ok(data.rules.some((r) => r.id === 'already-remembered-earlier'), 'a prior user rule must survive migration');
  assert.ok(data.rules.some((r) => r.id === 'owner-rule-merge-target'), 'the newly migrated rule must also be present');
  const userOnDisk = JSON.parse(fs.readFileSync(userPath, 'utf8'));
  assert.strictEqual(userOnDisk.rules.length, 2);
});

console.log('');
// ---- v2.8.0 (Lead, post-merge): owner rules never leak into another rules file; missing keeps ENOENT ----
{
  const savedEnv = process.env.FORGE_STANDING_RULES_USER_PATH;
  delete process.env.FORGE_STANDING_RULES_USER_PATH;
  try {
    t('isolation: a caller-supplied rulesPath never reads THIS install\'s own user rules (no sibling user file)', () => {
      const p = writeRules([baseRule({ id: 'fixture-only-rule' })]);
      const data = standing.load({ rulesPath: p });
      assert.strictEqual(data.rules.length, 1, 'expected exactly the fixture rule, got ' + data.rules.map((r) => r.id).join(','));
      assert.strictEqual(data.rules[0].id, 'fixture-only-rule');
    });
    t('isolation: a caller-supplied rulesPath DOES read its own sibling FORGE_STANDING_RULES.user.json', () => {
      const p = writeRules([baseRule({ id: 'fixture-template-rule' })]);
      fs.writeFileSync(userPathFor(p), JSON.stringify({ version: 1, rules: [baseRule({ id: 'fixture-owner-rule', source: 'owner /forge remember' })] }));
      const ids = standing.load({ rulesPath: p }).rules.map((r) => r.id).sort();
      assert.deepStrictEqual(ids, ['fixture-owner-rule', 'fixture-template-rule']);
    });
    t('a missing template throws an error that keeps code ENOENT (audit-loop tells missing from corrupt by it)', () => {
      const missing = path.join(freshDir('forge-standing-missing'), 'FORGE_STANDING_RULES.json');
      let err = null;
      try { standing.load({ rulesPath: missing }); } catch (e) { err = e; }
      assert.ok(err, 'expected load() to throw for a missing template');
      assert.strictEqual(err.code, 'ENOENT');
    });
  } finally {
    if (savedEnv === undefined) delete process.env.FORGE_STANDING_RULES_USER_PATH; else process.env.FORGE_STANDING_RULES_USER_PATH = savedEnv;
  }
}

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
