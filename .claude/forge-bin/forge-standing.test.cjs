#!/usr/bin/env node
'use strict';
// forge-standing.test.cjs — real tests for the standing-rules resolver (2026-07-18, WAVE B / B2).
// Every test uses either the REAL seed file (config/orchestration/FORGE_STANDING_RULES.json, read-only,
// proving seed integrity) or a fixture written into a fresh temp dir via opts.rulesPath (hermetic — no test
// ever writes to config/orchestration/ or ~/.claude). CLI tests spawn a real subprocess against the real
// seed file (mirrors forge-actiongate.test.cjs's CLI-layer proof).
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
function runCLI(argv) { return spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' }); }

function freshDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); }
function writeRules(rules, extra) {
  const dir = freshDir('forge-standing-fixture');
  const p = path.join(dir, 'FORGE_STANDING_RULES.json');
  fs.writeFileSync(p, JSON.stringify(Object.assign({ version: 1, rules }, extra || {})));
  return p;
}
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

console.log('forge-standing tests (standing-rules resolver)');

// ---------------------------------------------------------------------------
// 1) seed integrity — the REAL config file
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

// ---------------------------------------------------------------------------
// 2) trigger matching — always / domain / glob / on-request
// ---------------------------------------------------------------------------
console.log('\n2) trigger matching');

t('trigger:"always" fires regardless of type/paths', () => {
  const p = writeRules([baseRule({ id: 'a1', trigger: 'always', scope: 'global' })]);
  const r1 = standing.match({}, { rulesPath: p });
  const r2 = standing.match({ type: 'website', paths: ['x/y.js'] }, { rulesPath: p });
  assert.ok(r1.active.some((x) => x.id === 'a1'));
  assert.ok(r2.active.some((x) => x.id === 'a1'));
});

t('trigger:"domain" fires only when type matches the rule\'s domain', () => {
  const p = writeRules([baseRule({ id: 'd1', trigger: 'domain', domain: 'website', scope: 'domain:website' })]);
  const hit = standing.match({ type: 'website' }, { rulesPath: p });
  const miss = standing.match({ type: 'n8n' }, { rulesPath: p });
  const none = standing.match({}, { rulesPath: p });
  assert.ok(hit.active.some((x) => x.id === 'd1'));
  assert.ok(!miss.active.some((x) => x.id === 'd1'));
  assert.ok(!none.active.some((x) => x.id === 'd1'));
});

t('trigger:"domain" match is case-insensitive', () => {
  const p = writeRules([baseRule({ id: 'd2', trigger: 'domain', domain: 'scraping', scope: 'domain:scraping' })]);
  const hit = standing.match({ type: 'Scraping' }, { rulesPath: p });
  assert.ok(hit.active.some((x) => x.id === 'd2'));
});

t('trigger:"glob" fires only when a supplied path matches the glob', () => {
  const p = writeRules([baseRule({ id: 'g1', trigger: 'glob', glob: '**/.env*', scope: 'path:**/.env*' })]);
  const hit = standing.match({ paths: ['project/sub/.env.local'] }, { rulesPath: p });
  const miss = standing.match({ paths: ['project/sub/config.json'] }, { rulesPath: p });
  const none = standing.match({}, { rulesPath: p });
  assert.ok(hit.active.some((x) => x.id === 'g1'));
  assert.ok(!miss.active.some((x) => x.id === 'g1'));
  assert.ok(!none.active.some((x) => x.id === 'g1'));
});

t('trigger:"glob" normalizes backslashes so Windows-style paths still match', () => {
  const p = writeRules([baseRule({ id: 'g2', trigger: 'glob', glob: '**/.env*', scope: 'path:**/.env*' })]);
  const hit = standing.match({ paths: ['project\\sub\\.env'] }, { rulesPath: p });
  assert.ok(hit.active.some((x) => x.id === 'g2'));
});

t('trigger:"on-request" never fires passively (no onRequest supplied)', () => {
  const p = writeRules([baseRule({ id: 'o1', trigger: 'on-request', scope: 'on-request' })]);
  const r = standing.match({ type: 'website', paths: ['a/b.js'] }, { rulesPath: p });
  assert.ok(!r.active.some((x) => x.id === 'o1'));
});
t('trigger:"on-request" fires when onRequest:true', () => {
  const p = writeRules([baseRule({ id: 'o2', trigger: 'on-request', scope: 'on-request' })]);
  const r = standing.match({ onRequest: true }, { rulesPath: p });
  assert.ok(r.active.some((x) => x.id === 'o2'));
});
t('trigger:"on-request" fires when onRequest is an array containing the rule id, ignores other ids', () => {
  const p = writeRules([
    baseRule({ id: 'o3', trigger: 'on-request', scope: 'on-request' }),
    baseRule({ id: 'o4', trigger: 'on-request', scope: 'on-request' }),
  ]);
  const r = standing.match({ onRequest: ['o3'] }, { rulesPath: p });
  assert.ok(r.active.some((x) => x.id === 'o3'));
  assert.ok(!r.active.some((x) => x.id === 'o4'));
});

t('a status:"proposed" or status:"retired" rule never fires even if its trigger would otherwise match', () => {
  const p = writeRules([
    baseRule({ id: 'p1', trigger: 'always', status: 'proposed' }),
    baseRule({ id: 'p2', trigger: 'always', status: 'retired' }),
  ]);
  const r = standing.match({}, { rulesPath: p });
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
  const p = writeRules([
    baseRule({ id: 'core1', trigger: 'always', topic: 'coretest', cannot_override_core: true }),
    baseRule({ id: 'loser-glob', trigger: 'glob', glob: '**/*.js', topic: 'coretest', cannot_override_core: false }),
    baseRule({ id: 'loser-domain', trigger: 'domain', domain: 'website', topic: 'coretest', cannot_override_core: false }),
  ]);
  const r = standing.match({ type: 'website', paths: ['a/b.js'] }, { rulesPath: p });
  assert.ok(r.active.some((x) => x.id === 'core1'), 'core rule must be active');
  assert.ok(!r.active.some((x) => x.id === 'loser-glob'), 'glob rule loses to core rule');
  assert.ok(!r.active.some((x) => x.id === 'loser-domain'), 'domain rule loses to core rule');
  const shadowGlob = r.shadowed.find((x) => x.id === 'loser-glob');
  const shadowDomain = r.shadowed.find((x) => x.id === 'loser-domain');
  assert.strictEqual(shadowGlob.beaten_by, 'core1');
  assert.strictEqual(shadowDomain.beaten_by, 'core1');
});

t('two cannot_override_core rules sharing a topic both stay active (tie among core rules is not a loss)', () => {
  const p = writeRules([
    baseRule({ id: 'core-a', trigger: 'always', topic: 'dualcoretest', cannot_override_core: true }),
    baseRule({ id: 'core-b', trigger: 'always', topic: 'dualcoretest', cannot_override_core: true }),
  ]);
  const r = standing.match({}, { rulesPath: p });
  assert.ok(r.active.some((x) => x.id === 'core-a'));
  assert.ok(r.active.some((x) => x.id === 'core-b'));
  assert.strictEqual(r.shadowed.length, 0);
});

// ---------------------------------------------------------------------------
// 5) malformed / missing config is refused, not silently accepted
// ---------------------------------------------------------------------------
console.log('\n5) config integrity — refuses malformed input rather than silently passing everything');

t('an empty rules array throws', () => {
  const p = writeRules([]);
  assert.throws(() => standing.load({ rulesPath: p }));
});
t('a rule missing "id" throws', () => {
  const r = baseRule({}); delete r.id;
  const p = writeRules([r]);
  assert.throws(() => standing.load({ rulesPath: p }));
});
t('a rule missing "text" throws', () => {
  const r = baseRule({}); delete r.text;
  const p = writeRules([r]);
  assert.throws(() => standing.load({ rulesPath: p }));
});
t('a rule missing "source" throws (a rule with no evidence must be refused)', () => {
  const r = baseRule({}); delete r.source;
  const p = writeRules([r]);
  assert.throws(() => standing.load({ rulesPath: p }));
});
t('a rule missing "scope" throws', () => {
  const r = baseRule({}); delete r.scope;
  const p = writeRules([r]);
  assert.throws(() => standing.load({ rulesPath: p }));
});
t('a rule with an unknown trigger throws', () => {
  const p = writeRules([baseRule({ trigger: 'sometimes' })]);
  assert.throws(() => standing.load({ rulesPath: p }));
});
t('a rule with an unknown status throws', () => {
  const p = writeRules([baseRule({ status: 'maybe' })]);
  assert.throws(() => standing.load({ rulesPath: p }));
});
t('a duplicate rule id throws', () => {
  const p = writeRules([baseRule({ id: 'dup' }), baseRule({ id: 'dup' })]);
  assert.throws(() => standing.load({ rulesPath: p }));
});
t('trigger:"domain" without a "domain" field throws', () => {
  const p = writeRules([baseRule({ trigger: 'domain', domain: null })]);
  assert.throws(() => standing.load({ rulesPath: p }));
});
t('trigger:"glob" without a "glob" field throws', () => {
  const p = writeRules([baseRule({ trigger: 'glob', glob: null })]);
  assert.throws(() => standing.load({ rulesPath: p }));
});
t('invalid JSON syntax throws with a clear message, not a silent empty result', () => {
  const dir = freshDir('forge-standing-badjson');
  const p = path.join(dir, 'bad.json');
  fs.writeFileSync(p, '{ not valid json');
  assert.throws(() => standing.load({ rulesPath: p }));
});
t('a missing rules file throws (never silently returns "no rules")', () => {
  assert.throws(() => standing.load({ rulesPath: path.join(freshDir('forge-standing-nope'), 'does-not-exist.json') }));
});

// ---------------------------------------------------------------------------
// 6) hermeticity — fixture calls never touch the real config file
// ---------------------------------------------------------------------------
console.log('\n6) hermeticity');

t('a hermetic fixture rule id does not leak into the real seed file result', () => {
  const p = writeRules([baseRule({ id: 'totally-fake-fixture-only', trigger: 'always' })]);
  standing.match({}, { rulesPath: p }); // load the fixture (populates the module cache for that path)
  const real = standing.match({}); // load the REAL file fresh (different path -> cache miss -> re-read)
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
t('CLI list --json returns every active rule with id/text/source', () => {
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

// ---------------------------------------------------------------------------
// 8) remember() — the ONLY sanctioned auto-active write path (WAVE B / B4)
// ---------------------------------------------------------------------------
console.log('\n8) remember() — /forge remember (hermetic, never touches the real config file)');

t('remember() appends a new active rule with source:"owner /forge remember"', () => {
  const p = writeRules([baseRule({ id: 'seed-1' })]);
  const rule = standing.remember('never deploy on Fridays', { rulesPath: p });
  assert.strictEqual(rule.status, 'active');
  assert.strictEqual(rule.source, 'owner /forge remember');
  assert.strictEqual(rule.text, 'never deploy on Fridays');
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.strictEqual(data.rules.length, 2);
  assert.ok(data.rules.some((r) => r.id === rule.id && r.status === 'active'));
});

t('remember() defaults to trigger:"always", scope:"global", cannot_override_core:false', () => {
  const p = writeRules([baseRule({ id: 'seed-2' })]);
  const rule = standing.remember('a default-shape rule', { rulesPath: p });
  assert.strictEqual(rule.trigger, 'always');
  assert.strictEqual(rule.scope, 'global');
  assert.strictEqual(rule.cannot_override_core, false);
});

t('remember() honors explicit --scope/--trigger/--domain/--topic/--id', () => {
  const p = writeRules([baseRule({ id: 'seed-3' })]);
  const rule = standing.remember('website-only rule', { rulesPath: p, trigger: 'domain', domain: 'website', scope: 'domain:website', topic: 'my-topic', id: 'my-custom-id' });
  assert.strictEqual(rule.id, 'my-custom-id');
  assert.strictEqual(rule.trigger, 'domain');
  assert.strictEqual(rule.domain, 'website');
  assert.strictEqual(rule.topic, 'my-topic');
});

t('remember() honors explicit --glob for trigger:"glob"', () => {
  const p = writeRules([baseRule({ id: 'seed-4' })]);
  const rule = standing.remember('glob rule', { rulesPath: p, trigger: 'glob', glob: '**/*.secret' });
  assert.strictEqual(rule.trigger, 'glob');
  assert.strictEqual(rule.glob, '**/*.secret');
});

t('a rule written by remember() actually fires via match() on a later, independent read (cache invalidated)', () => {
  const p = writeRules([baseRule({ id: 'seed-5' })]);
  standing.remember('freshly remembered rule', { rulesPath: p, id: 'fresh-remembered' });
  const r = standing.match({}, { rulesPath: p });
  assert.ok(r.active.some((x) => x.id === 'fresh-remembered'));
});

t('remember() cannot mint a new cannot_override_core rule even if a caller tries to pass it', () => {
  const p = writeRules([baseRule({ id: 'seed-6' })]);
  const rule = standing.remember('trying to sneak in core status', { rulesPath: p, cannot_override_core: true });
  assert.strictEqual(rule.cannot_override_core, false);
});

t('remember() with empty/whitespace-only text throws, writes nothing', () => {
  const p = writeRules([baseRule({ id: 'seed-7' })]);
  const before = fs.readFileSync(p, 'utf8');
  assert.throws(() => standing.remember('   ', { rulesPath: p }));
  assert.strictEqual(fs.readFileSync(p, 'utf8'), before, 'remember() must write nothing on validation failure');
});

t('remember() with an unknown trigger throws, writes nothing', () => {
  const p = writeRules([baseRule({ id: 'seed-8' })]);
  const before = fs.readFileSync(p, 'utf8');
  assert.throws(() => standing.remember('bad trigger rule', { rulesPath: p, trigger: 'sometimes' }));
  assert.strictEqual(fs.readFileSync(p, 'utf8'), before);
});

t('remember() with trigger:"domain" but no --domain throws, writes nothing', () => {
  const p = writeRules([baseRule({ id: 'seed-9' })]);
  const before = fs.readFileSync(p, 'utf8');
  assert.throws(() => standing.remember('missing domain', { rulesPath: p, trigger: 'domain' }));
  assert.strictEqual(fs.readFileSync(p, 'utf8'), before);
});

t('remember() with trigger:"glob" but no --glob throws, writes nothing', () => {
  const p = writeRules([baseRule({ id: 'seed-10' })]);
  const before = fs.readFileSync(p, 'utf8');
  assert.throws(() => standing.remember('missing glob', { rulesPath: p, trigger: 'glob' }));
  assert.strictEqual(fs.readFileSync(p, 'utf8'), before);
});

t('remember() with a colliding --id throws, writes nothing', () => {
  const p = writeRules([baseRule({ id: 'collide-me' })]);
  const before = fs.readFileSync(p, 'utf8');
  assert.throws(() => standing.remember('dup id rule', { rulesPath: p, id: 'collide-me' }));
  assert.strictEqual(fs.readFileSync(p, 'utf8'), before);
});

t('remember() against a missing rules file throws (never creates one from scratch)', () => {
  assert.throws(() => standing.remember('orphan rule', { rulesPath: path.join(freshDir('forge-standing-remember-nope'), 'does-not-exist.json') }));
});

t('remember() against a malformed rules file (invalid JSON) throws, writes nothing new', () => {
  const dir = freshDir('forge-standing-remember-bad');
  const p = path.join(dir, 'bad.json');
  fs.writeFileSync(p, '{ broken');
  assert.throws(() => standing.remember('rule text', { rulesPath: p }));
  assert.strictEqual(fs.readFileSync(p, 'utf8'), '{ broken');
});

t('remember() never writes to the REAL config/orchestration/FORGE_STANDING_RULES.json (hermeticity proof)', () => {
  const before = fs.readFileSync(standing.CONFIG_PATH, 'utf8');
  const p = writeRules([baseRule({ id: 'seed-11' })]);
  standing.remember('a fixture-only rule', { rulesPath: p });
  assert.strictEqual(fs.readFileSync(standing.CONFIG_PATH, 'utf8'), before, 'remember() must never touch the real seed file when rulesPath overrides it');
});

t('CLI remember "<text>" --json writes a real rule into a FORGE_STANDING_RULES_PATH fixture (hermetic — never touches the real seed file) and prints it', () => {
  const p = writeRules([baseRule({ id: 'seed-cli-1' })]);
  const env = Object.assign({}, process.env, { FORGE_STANDING_RULES_PATH: p });
  const realBefore = fs.readFileSync(standing.CONFIG_PATH, 'utf8');
  const r = spawnSync(process.execPath, [CLI, 'remember', 'cli remembered rule', '--json'], { encoding: 'utf8', env });
  assert.strictEqual(r.status, 0, 'stderr: ' + r.stderr);
  const parsed = JSON.parse(r.stdout.trim());
  assert.strictEqual(parsed.source, 'owner /forge remember');
  assert.strictEqual(parsed.text, 'cli remembered rule');
  const written = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.ok(written.rules.some((x) => x.id === parsed.id));
  assert.strictEqual(fs.readFileSync(standing.CONFIG_PATH, 'utf8'), realBefore, 'the real seed file must be untouched by a hermetic CLI call');
});

t('CLI remember honors --scope/--trigger/--domain/--topic/--id via FORGE_STANDING_RULES_PATH', () => {
  const p = writeRules([baseRule({ id: 'seed-cli-2' })]);
  const env = Object.assign({}, process.env, { FORGE_STANDING_RULES_PATH: p });
  const r = spawnSync(process.execPath, [CLI, 'remember', 'website-only cli rule', '--trigger', 'domain', '--domain', 'website', '--scope', 'domain:website', '--topic', 'cli-topic', '--id', 'cli-custom-id', '--json'], { encoding: 'utf8', env });
  assert.strictEqual(r.status, 0, 'stderr: ' + r.stderr);
  const parsed = JSON.parse(r.stdout.trim());
  assert.strictEqual(parsed.id, 'cli-custom-id');
  assert.strictEqual(parsed.trigger, 'domain');
  assert.strictEqual(parsed.domain, 'website');
  assert.strictEqual(parsed.topic, 'cli-topic');
});

t('CLI remember with no text argument exits 2 (usage error), writes nothing', () => {
  const p = writeRules([baseRule({ id: 'seed-cli-3' })]);
  const env = Object.assign({}, process.env, { FORGE_STANDING_RULES_PATH: p });
  const before = fs.readFileSync(p, 'utf8');
  const r = spawnSync(process.execPath, [CLI, 'remember'], { encoding: 'utf8', env });
  assert.strictEqual(r.status, 2);
  assert.strictEqual(fs.readFileSync(p, 'utf8'), before);
});

t('CLI remember with no FORGE_STANDING_RULES_PATH env set falls back to the real CONFIG_PATH (documented default, proven via a guaranteed-failing call so nothing is actually written)', () => {
  // a colliding id against a REAL seed rule id proves the CLI reached the real file's validation path
  // (collision throw) without this test ever writing to it.
  const env = Object.assign({}, process.env);
  delete env.FORGE_STANDING_RULES_PATH;
  const r = spawnSync(process.execPath, [CLI, 'remember', 'should collide', '--id', 'honesty-core-untouchable'], { encoding: 'utf8', env });
  assert.strictEqual(r.status, 2);
  assert.ok(r.stderr.includes('already exists'));
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
