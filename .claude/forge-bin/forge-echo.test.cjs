#!/usr/bin/env node
'use strict';
// forge-echo.test.cjs — real tests for the applied-prefs ECHO (WAVE B / B4, 2026-07-18). Every fixture-based
// section runs under a fresh os.tmpdir() directory — this file NEVER writes to this repo's real
// .claude/forge-runs/ and NEVER writes to a real ~/.claude. emitEcho() tests spawn the REAL, already-edited
// .claude/forge-dashboard/log-event.cjs (copied verbatim into a temp fixture project so its own CLAUDE_DIR/
// RUNS_DIR resolve inside the fixture, not this repo) — proving the actual 3-place event-registration wiring
// works end to end, not just that composeEcho() produces the right string.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
// v2.7.0: composeEcho() also reads forge-config.cjs. Before anything runs, its env seams point at a throwaway
// TRAP dir, so a call without opts.configOpts (sections 1-3, and the spawned CLI, which inherits this env) can
// never read this repo's or the owner's real FORGE_CONFIG.json — section 4 proves nothing landed in the trap.
const CFG_TRAP = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-config-trap-'));
process.env.FORGE_CONFIG_HOME = path.join(CFG_TRAP, 'home');
process.env.FORGE_PROJECT_ROOT = path.join(CFG_TRAP, 'proj');
const echo = require('./forge-echo.cjs');
const forgeConfig = require('./forge-config.cjs');
const CONFIG_KEYS = Object.keys(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'orchestration', 'FORGE_CONFIG_SCHEMA.json'), 'utf8')).settings);

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

function freshDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); }
function writeProfile(dir, name, prefsObj) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify({ version: 1, prefs: prefsObj }));
  return p;
}
function entry(value, source, confidence, scope) {
  return { value, source: source || 'test source quote', confidence: confidence || 'evidenced', scope: scope || 'global' };
}
function writeRules(dir, rules) {
  const p = path.join(dir, 'FORGE_STANDING_RULES.json');
  fs.writeFileSync(p, JSON.stringify({ version: 1, rules }));
  return p;
}
function baseRule(overrides) {
  return Object.assign({
    id: 'r-' + Math.random().toString(36).slice(2),
    text: 'test rule text', scope: 'global', trigger: 'always', domain: null, glob: null, topic: null,
    source: 'unit-test fixture (not real owner evidence)', confidence: 'high', status: 'active', cannot_override_core: false,
  }, overrides || {});
}
const NOWHERE = path.join(os.tmpdir(), 'forge-echo-does-not-exist-' + Date.now(), 'FORGE_OWNER_PROFILE.json');

console.log('forge-echo tests (applied-prefs ECHO — WAVE B / B4)');

// ---------------------------------------------------------------------------
// 1) composeEcho() — pure summary composition
// ---------------------------------------------------------------------------
console.log('\n1) composeEcho()');

t('empty prefs + empty rules -> honest 0/0 summary, no crash', () => {
  const dir = freshDir('echo-empty');
  const rulesPath = writeRules(dir, [baseRule({ id: 'only-rule', trigger: 'on-request' })]); // never fires passively
  const e = echo.composeEcho({}, { profilePath: NOWHERE, globalProfilePath: NOWHERE, rulesPath });
  assert.strictEqual(e.prefsCount, 0);
  assert.strictEqual(e.activeRulesCount, 0);
  assert.ok(e.summary.includes('0 pref(s)'));
  assert.ok(e.summary.includes('0 active standing-rule(s)'));
});

t('resolved prefs and active rules both appear in the summary with real key/id samples', () => {
  const dir = freshDir('echo-basic');
  const profilePath = writeProfile(dir, 'profile.json', { never_auto_push: entry(true), language: entry('nl') });
  const rulesPath = writeRules(dir, [baseRule({ id: 'always-fires', trigger: 'always' })]);
  const e = echo.composeEcho({}, { profilePath, globalProfilePath: NOWHERE, rulesPath });
  assert.strictEqual(e.prefsCount, 2);
  assert.strictEqual(e.activeRulesCount, 1);
  assert.ok(e.summary.includes('never_auto_push'));
  assert.ok(e.summary.includes('always-fires'));
});

t('matchParams (type/paths) are forwarded to standing.match() — a domain rule only fires for its domain', () => {
  const dir = freshDir('echo-domain');
  const rulesPath = writeRules(dir, [baseRule({ id: 'web-only', trigger: 'domain', domain: 'website', scope: 'domain:website' })]);
  const hit = echo.composeEcho({ type: 'website' }, { profilePath: NOWHERE, globalProfilePath: NOWHERE, rulesPath });
  const miss = echo.composeEcho({ type: 'n8n' }, { profilePath: NOWHERE, globalProfilePath: NOWHERE, rulesPath });
  assert.ok(hit.rules.some((r) => r.id === 'web-only'));
  assert.ok(!miss.rules.some((r) => r.id === 'web-only'));
});

t('shadowed rules are counted and surfaced separately from active ones', () => {
  const dir = freshDir('echo-shadow');
  const rulesPath = writeRules(dir, [
    baseRule({ id: 'core-shadow', trigger: 'always', topic: 'sametopic', cannot_override_core: true }),
    baseRule({ id: 'loser-shadow', trigger: 'always', topic: 'sametopic', cannot_override_core: false }),
  ]);
  const e = echo.composeEcho({}, { profilePath: NOWHERE, globalProfilePath: NOWHERE, rulesPath });
  assert.strictEqual(e.shadowedCount, 1);
  assert.ok(e.summary.includes('1 shadowed'));
  assert.ok(e.shadowed.some((s) => s.id === 'loser-shadow'));
});

t('more than 5 prefs/rules: summary samples cap at 5 and adds an ellipsis marker', () => {
  const dir = freshDir('echo-many');
  const prefsObj = {};
  for (let i = 0; i < 7; i++) prefsObj['pref' + i] = entry(i);
  const profilePath = writeProfile(dir, 'profile.json', prefsObj);
  const rules = [];
  for (let i = 0; i < 7; i++) rules.push(baseRule({ id: 'rule' + i, trigger: 'always' }));
  const rulesPath = writeRules(dir, rules);
  const e = echo.composeEcho({}, { profilePath, globalProfilePath: NOWHERE, rulesPath });
  assert.strictEqual(e.prefsCount, 7);
  assert.strictEqual(e.activeRulesCount, 7);
  assert.ok(e.summary.includes('…'), 'expected an ellipsis marker when more than 5 items resolved');
});

t('malformed profile propagates the underlying throw (composeEcho adds no new failure mode)', () => {
  const dir = freshDir('echo-bad');
  const p = path.join(dir, 'bad.json');
  fs.writeFileSync(p, '{ not valid json');
  const rulesPath = writeRules(dir, [baseRule({})]);
  assert.throws(() => echo.composeEcho({}, { profilePath: p, globalProfilePath: NOWHERE, rulesPath }));
});

// ---------------------------------------------------------------------------
// 2) emitEcho() — real end-to-end wiring through the REAL log-event.cjs
// ---------------------------------------------------------------------------
console.log('\n2) emitEcho() — real log-event.cjs wiring (fixture project, never this repo\'s forge-runs)');

function makeFixtureProject() {
  const root = freshDir('echo-fixture-project');
  const dashDir = path.join(root, '.claude', 'forge-dashboard');
  fs.mkdirSync(dashDir, { recursive: true });
  const realLogEvent = path.join(__dirname, '..', 'forge-dashboard', 'log-event.cjs');
  const logEventPath = path.join(dashDir, 'log-event.cjs');
  fs.copyFileSync(realLogEvent, logEventPath);
  // also copy the real Boss registry so log-event.cjs's agent-name canonicalization behaves exactly like
  // production inside the fixture too (a fixture without it would silently skip canonicalization, which
  // would make the "opts.agent override" test below prove less than it claims to).
  const regDir = path.join(root, '.claude', 'config', 'agents');
  fs.mkdirSync(regDir, { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'config', 'agents', 'agent-registry.json'), path.join(regDir, 'agent-registry.json'));
  return { root, logEventPath };
}

t('emitEcho() logs a real owner_prefs_loaded event into the fixture project\'s events.jsonl', () => {
  const { logEventPath } = makeFixtureProject();
  const dir = freshDir('echo-emit');
  const profilePath = writeProfile(dir, 'profile.json', { never_auto_push: entry(true) });
  const rulesPath = writeRules(dir, [baseRule({ id: 'always-fires', trigger: 'always' })]);
  const runId = 'forge-echo-test-' + Date.now();
  const result = echo.emitEcho(runId, {}, { logEventPath, profilePath, globalProfilePath: NOWHERE, rulesPath });
  assert.strictEqual(result.logged, true, 'log-event.cjs stderr: ' + result.stderr);
  assert.strictEqual(result.status, 0);

  const eventsFile = path.join(path.dirname(logEventPath), '..', 'forge-runs', runId, 'events.jsonl');
  assert.ok(fs.existsSync(eventsFile), 'expected events.jsonl to be written at ' + eventsFile);
  const lines = fs.readFileSync(eventsFile, 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l));
  const ev = lines.find((e) => e.event_type === 'owner_prefs_loaded');
  assert.ok(ev, 'expected an owner_prefs_loaded event in events.jsonl');
  assert.strictEqual(ev.note, result.summary);
  assert.strictEqual(ev.prefs_count, 1);
  assert.strictEqual(ev.active_rules_count, 1);
  assert.strictEqual(ev.agent, 'orchestrator');
  // real log-event.cjs honesty stamping must NOT flag this as unknown/unproven — proves registration worked.
  assert.ok(!ev._forge_verify || !ev._forge_verify.event_type_unknown, 'owner_prefs_loaded must be a KNOWN event_type');
});

t('emitEcho() honors opts.agent to override the logged agent field', () => {
  const { logEventPath } = makeFixtureProject();
  const dir = freshDir('echo-emit-agent');
  const rulesPath = writeRules(dir, [baseRule({})]);
  const runId = 'forge-echo-test-agent-' + Date.now();
  const result = echo.emitEcho(runId, {}, { logEventPath, profilePath: NOWHERE, globalProfilePath: NOWHERE, rulesPath, agent: 'head-chef' });
  assert.strictEqual(result.logged, true);
  const eventsFile = path.join(path.dirname(logEventPath), '..', 'forge-runs', runId, 'events.jsonl');
  const lines = fs.readFileSync(eventsFile, 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l));
  assert.strictEqual(lines[0].agent, 'Head Chef'); // canonicalized by the real log-event.cjs's Boss-name mapping
});

t('emitEcho() throws on an invalid run_id (usage error, mirrors log-event.cjs\'s own guard)', () => {
  const { logEventPath } = makeFixtureProject();
  assert.throws(() => echo.emitEcho('not a valid id!!', {}, { logEventPath, profilePath: NOWHERE, globalProfilePath: NOWHERE }));
});

t('emitEcho() never writes into THIS repo\'s real forge-runs/ (fixture-only proof)', () => {
  const { logEventPath, root } = makeFixtureProject();
  const runId = 'forge-echo-isolation-' + Date.now();
  echo.emitEcho(runId, {}, { logEventPath, profilePath: NOWHERE, globalProfilePath: NOWHERE });
  const realRunDir = path.join(__dirname, '..', 'forge-runs', runId);
  assert.ok(!fs.existsSync(realRunDir), 'emitEcho leaked a write into the real repo forge-runs/');
  assert.ok(fs.existsSync(path.join(root, '.claude', 'forge-runs', runId)), 'expected the write inside the fixture root instead');
});

// ---------------------------------------------------------------------------
// 3) CLI (real spawned subprocess)
// ---------------------------------------------------------------------------
console.log('\n3) CLI');

const CLI = path.join(__dirname, 'forge-echo.cjs');
function runCLI(argv) { return spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' }); }

t('CLI compose --json exits 0 and prints a parseable echo against the REAL seeded project profile/rules', () => {
  const r = runCLI(['compose', '--json']);
  assert.strictEqual(r.status, 0);
  const parsed = JSON.parse(r.stdout.trim());
  assert.ok(parsed.prefsCount >= 9, 'expected at least the 9 real seeded owner-profile prefs');
  assert.ok(parsed.activeRulesCount >= 4, 'expected at least the real seeded always-on standing rules');
  assert.ok(typeof parsed.summary === 'string' && parsed.summary.length > 0);
});

t('CLI compose --type website --json includes the website-domain standing rule', () => {
  const r = runCLI(['compose', '--type', 'website', '--json']);
  const parsed = JSON.parse(r.stdout.trim());
  assert.ok(parsed.rules.some((x) => x.id === 'ui-quality-for-web'));
});

t('CLI emit with no run_id exits 2 (usage error)', () => {
  const r = runCLI(['emit']);
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

// ---------------------------------------------------------------------------
// 4) the Forge SETTINGS half of the echo (forge-config.cjs, v2.7.0) — temp config home + temp project only
// ---------------------------------------------------------------------------
console.log('\n4) config settings in the echo (forge-config.cjs)');

function configFixture() {
  const root = freshDir('echo-config');
  const home = path.join(root, 'home');
  const proj = path.join(root, 'proj');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
  const rulesPath = writeRules(root, [baseRule({ id: 'only-rule', trigger: 'on-request' })]);
  return {
    root, rulesPath,
    configOpts: { configHome: home, projectRoot: proj },
    globalFile: path.join(home, 'FORGE_CONFIG.json'),
    projectFile: path.join(proj, '.claude', 'FORGE_CONFIG.json'),
    base: { profilePath: NOWHERE, globalProfilePath: NOWHERE, rulesPath },
  };
}
const writeSettings = (p, settings) => fs.writeFileSync(p, JSON.stringify({ version: 1, settings }));
const configBracket = (summary) => { const m = /config: \d+ setting\(s\) \[([^\]]*)\]/.exec(summary); return m ? m[1] : null; };

t('no settings files: every schema setting is counted, no overrides, no "changed" clause', () => {
  const fx = configFixture();
  const e = echo.composeEcho({}, Object.assign({ configOpts: fx.configOpts }, fx.base));
  assert.strictEqual(e.configCount, CONFIG_KEYS.length);
  assert.deepStrictEqual(e.configOverrides, []);
  assert.strictEqual(e.configChangedCount, 0);
  assert.ok(e.summary.includes(', config: ' + CONFIG_KEYS.length + ' setting(s) ['), e.summary);
  assert.ok(!/changed since last run/.test(e.summary), e.summary);
  assert.ok(e.summary.includes('…'), 'more than 5 settings must show the ellipsis marker');
});

t('project + global values are overrides with their source, and are sampled FIRST', () => {
  const fx = configFixture();
  writeSettings(fx.projectFile, { council: { value: 'off' } });
  writeSettings(fx.globalFile, { 'usage-guard.pause-at': { value: 97 } });
  const e = echo.composeEcho({}, Object.assign({ configOpts: fx.configOpts }, fx.base));
  const byKey = Object.fromEntries(e.configOverrides.map((o) => [o.key, o]));
  assert.deepStrictEqual(byKey.council, { key: 'council', value: 'off', source: 'project' });
  assert.deepStrictEqual(byKey['usage-guard.pause-at'], { key: 'usage-guard.pause-at', value: 97, source: 'global' });
  assert.strictEqual(e.configOverrides.length, 2);
  const samples = configBracket(e.summary).split(', ').slice(0, 2).sort();
  assert.deepStrictEqual(samples, ['council="off"', 'usage-guard.pause-at=97'], e.summary);
});

t('per-run flags count as overrides (source "flag") through opts.configOpts', () => {
  const fx = configFixture();
  const e = echo.composeEcho({}, Object.assign({ configOpts: Object.assign({ flags: ['council=off'] }, fx.configOpts) }, fx.base));
  assert.deepStrictEqual(e.configOverrides, [{ key: 'council', value: 'off', source: 'flag' }]);
});

t('the product-default layer reads the SAME owner profile as the prefs half (profilePath forwarded)', () => {
  const fx = configFixture();
  const profilePath = writeProfile(fx.root, 'profile.json', { ui_quality_default: entry(false) });
  const e = echo.composeEcho({}, { configOpts: fx.configOpts, profilePath, globalProfilePath: NOWHERE, rulesPath: fx.rulesPath });
  assert.ok(configBracket(e.summary).split(', ').includes('ui-quality=false'), e.summary);
  assert.deepStrictEqual(e.configOverrides, [], 'a product-default is not an owner override');
});

t('opts.configDiff (a real forge-config diff) adds "<k> changed since last run"', () => {
  const fx = configFixture();
  const o = Object.assign({ sessionStatePath: path.join(fx.root, 'state.json') }, fx.configOpts);
  forgeConfig.markSeen(o);
  forgeConfig.set('council', 'off', o);
  forgeConfig.set('usage-guard.pause-at', '96', o);
  const d = forgeConfig.diff(o);
  assert.strictEqual(d.changed.length, 2);
  const e = echo.composeEcho({}, Object.assign({ configOpts: fx.configOpts, configDiff: d }, fx.base));
  assert.strictEqual(e.configChangedCount, 2);
  assert.ok(e.summary.includes(', 2 changed since last run'), e.summary);
});

t('a damaged settings file does not crash the echo: "config: unreadable" + a note, never "0 settings"', () => {
  const fx = configFixture();
  fs.writeFileSync(fx.projectFile, '{ not json');
  const e = echo.composeEcho({}, Object.assign({ configOpts: fx.configOpts }, fx.base));
  assert.ok(e.summary.includes('config: unreadable'), e.summary);
  assert.ok(!/config: 0 setting/.test(e.summary), e.summary);
  assert.strictEqual(e.configCount, null);
  assert.ok(e.notes.some((n) => /^forge-config: /.test(n) && /FORGE_CONFIG\.json/.test(n)), JSON.stringify(e.notes));
});

t('soft sibling: a tree WITHOUT forge-config.cjs still echoes prefs/rules and says config is unavailable', () => {
  const root = freshDir('echo-no-config');
  const bin = path.join(root, '.claude', 'forge-bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const f of ['forge-echo.cjs', 'forge-prefs.cjs', 'forge-standing.cjs']) fs.copyFileSync(path.join(__dirname, f), path.join(bin, f));
  const orch = path.join(root, '.claude', 'config', 'orchestration');
  fs.mkdirSync(orch, { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'config', 'orchestration', 'FORGE_STANDING_RULES.json'), path.join(orch, 'FORGE_STANDING_RULES.json'));
  const r = spawnSync(process.execPath, [path.join(bin, 'forge-echo.cjs'), 'compose', '--json'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout.trim());
  assert.ok(parsed.summary.includes('owner prefs/rules applied') && parsed.summary.includes('config: unreadable'), parsed.summary);
  assert.ok(parsed.notes.some((n) => /forge-config\.cjs not available/.test(n)), JSON.stringify(parsed.notes));
});

t('emitEcho() carries config_count / config_overrides_count / config_changed_count into the real event', () => {
  const fx = configFixture();
  const { logEventPath } = makeFixtureProject();
  writeSettings(fx.projectFile, { council: { value: 'off' } });
  const runId = 'forge-echo-config-' + Date.now();
  const result = echo.emitEcho(runId, {}, Object.assign({ logEventPath, configOpts: fx.configOpts, configDiff: { changed: [{ key: 'council' }] } }, fx.base));
  assert.strictEqual(result.logged, true, result.stderr);
  const eventsFile = path.join(path.dirname(logEventPath), '..', 'forge-runs', runId, 'events.jsonl');
  const ev = fs.readFileSync(eventsFile, 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l)).find((x) => x.event_type === 'owner_prefs_loaded');
  assert.deepStrictEqual([ev.config_count, ev.config_overrides_count, ev.config_changed_count], [CONFIG_KEYS.length, 1, 1]);
  assert.ok(ev.note.includes(', 1 changed since last run'), ev.note);
});

t('hermetic: composeEcho() is read-only and nothing landed in the config trap dir', () => {
  assert.deepStrictEqual(fs.readdirSync(CFG_TRAP), [], 'something was written into ' + CFG_TRAP);
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
