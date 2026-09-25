#!/usr/bin/env node
'use strict';
// forge-autonomy.test.cjs — real tests for the continue-within-mission autonomy policy (WAVE B / B3,
// 2026-07-18). Central claim under test: decide() ALWAYS defers to a usage-limit pause and to the SHARED
// forge-actiongate hard-gates classifier BEFORE ever consulting a mode — proven at all three modes,
// including full-auto-within-mission, and proven that an NL "advisory" phrase like "ga door" can never
// bypass a hard gate (decide() doesn't even look at nl_phrases_advisory). Hermetic: every test that needs
// a custom config writes its own fixture under a fresh tmp dir and passes it via opts.configPath /
// opts.gatesPath — nothing is written to ~/.claude or outside a tmp dir.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
// CONFIG + GUARD SANDBOX (v2.7.0, 2026-09-24): the mode now also comes from `/forge config` (forge-config.cjs) and
// decideLive() reads the usage guard's state file. Point both at throwaway dirs BEFORE the require, so no test here
// reads the owner's real FORGE_CONFIG.json or ~/.claude state — and every CLI child inherits the sandbox.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-cfg-'));
process.env.FORGE_CONFIG_HOME = path.join(SANDBOX, 'home');
process.env.FORGE_PROJECT_ROOT = path.join(SANDBOX, 'project');
process.env.FORGE_USAGE_GUARD_HOME = path.join(SANDBOX, 'guard-home');
delete process.env.FORGE_USAGE_GUARD_STATE;
const autonomy = require('./forge-autonomy.cjs');
const actiongate = require('./forge-actiongate.cjs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

const CLI = path.join(__dirname, 'forge-autonomy.cjs');
function runCLI(argv) { return spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' }); }

function freshDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); }

const REAL_CONFIG = autonomy.CONFIG_PATH;
const REAL_GATES = actiongate.CONFIG_PATH;
const MODES = ['ask-each-phase', 'continue-within-mission', 'full-auto-within-mission'];

console.log('forge-autonomy tests (continue-within-mission policy — always defers to hard gates)');

// ---------------------------------------------------------------------------
// 1) config integrity — real config loads, refuses malformed config
// ---------------------------------------------------------------------------
console.log('\n1) config / getConfig');

t('loadConfig() parses the real FORGE_AUTONOMY.json without throwing', () => {
  const cfg = autonomy.loadConfig();
  assert.strictEqual(cfg.default, 'continue-within-mission');
  assert.ok(cfg.modes && typeof cfg.modes === 'object');
});
t('getConfig() returns the same shape as loadConfig()', () => {
  const cfg = autonomy.getConfig({});
  assert.ok(Array.isArray(cfg.always_interrupt));
});
t('real config defines exactly the three documented modes', () => {
  const cfg = autonomy.loadConfig();
  assert.deepStrictEqual(Object.keys(cfg.modes).sort(), [...MODES].sort());
});
t('always_interrupt manifest matches forge-actiongate.KNOWN_GATES + "usage-limit" (no drift)', () => {
  const cfg = autonomy.loadConfig();
  const expected = [...actiongate.KNOWN_GATES, 'usage-limit'].sort();
  assert.deepStrictEqual([...cfg.always_interrupt].sort(), expected);
});

t('a config missing "default" throws', () => {
  const bad = path.join(freshDir('autonomy-badcfg'), 'FORGE_AUTONOMY.json');
  fs.writeFileSync(bad, JSON.stringify({ modes: { x: 'y' }, always_interrupt: [] }));
  assert.throws(() => autonomy.loadConfig(bad));
});
t('a config missing "modes" throws', () => {
  const bad = path.join(freshDir('autonomy-badcfg'), 'FORGE_AUTONOMY.json');
  fs.writeFileSync(bad, JSON.stringify({ default: 'x', always_interrupt: [] }));
  assert.throws(() => autonomy.loadConfig(bad));
});
t('a config whose "default" is not a key in "modes" throws', () => {
  const bad = path.join(freshDir('autonomy-badcfg'), 'FORGE_AUTONOMY.json');
  fs.writeFileSync(bad, JSON.stringify({ default: 'nope', modes: { x: 'y' }, always_interrupt: [] }));
  assert.throws(() => autonomy.loadConfig(bad));
});
t('a config missing "always_interrupt" array throws', () => {
  const bad = path.join(freshDir('autonomy-badcfg'), 'FORGE_AUTONOMY.json');
  fs.writeFileSync(bad, JSON.stringify({ default: 'x', modes: { x: 'y' } }));
  assert.throws(() => autonomy.loadConfig(bad));
});
t('a missing config file throws (never silently returns a default config)', () => {
  assert.throws(() => autonomy.loadConfig(path.join(freshDir('autonomy-nope'), 'does-not-exist.json')));
});

// ---------------------------------------------------------------------------
// 2) tier 1 — usage-limit ALWAYS interrupts, at every mode
// ---------------------------------------------------------------------------
console.log('\n2) usage-limit pause always interrupts (tier 1, all modes)');

for (const mode of MODES) {
  t('atUsageLimit interrupts at mode=' + mode + ' even with benign text', () => {
    const r = autonomy.decide({ text: 'continue with the next phase', atUsageLimit: true }, { mode });
    assert.strictEqual(r.proceed, false);
    assert.strictEqual(r.interruptedBy, 'usage-limit');
  });
}
t('usage-limit interrupts even at full-auto-within-mission with a plain phase transition', () => {
  const r = autonomy.decide({ phaseTransition: true, atUsageLimit: true }, { mode: 'full-auto-within-mission' });
  assert.strictEqual(r.proceed, false);
  assert.strictEqual(r.interruptedBy, 'usage-limit');
});

// ---------------------------------------------------------------------------
// 3) tier 2 — a real hard gate ALWAYS interrupts, at every mode, including full-auto
// ---------------------------------------------------------------------------
console.log('\n3) hard gates always interrupt (tier 2, all modes, via real forge-actiongate)');

const GATE_TRIGGERS = [
  { id: 'deploy', text: "let's deploy this to prod now" },
  { id: 'git-push', text: 'please git push this to origin' },
  { id: 'spend', text: 'go ahead and charge the customer for this order' },
  { id: 'dns-change', text: 'please change the DNS record for the domain' },
  { id: 'workflow-activate', text: 'please activate the n8n workflow for lead capture' },
];

for (const g of GATE_TRIGGERS) {
  for (const mode of MODES) {
    t(g.id + ' interrupts at mode=' + mode, () => {
      const r = autonomy.decide({ text: g.text }, { mode });
      assert.strictEqual(r.proceed, false, 'expected ' + g.id + ' to interrupt at ' + mode);
      assert.strictEqual(r.interruptedBy, g.id);
    });
  }
}

t('full-auto-within-mission specifically is proven to stop on deploy/push/spend (explicit requirement)', () => {
  for (const g of GATE_TRIGGERS.slice(0, 3)) {
    const r = autonomy.decide({ text: g.text }, { mode: 'full-auto-within-mission' });
    assert.strictEqual(r.proceed, false, g.id + ' must interrupt full-auto-within-mission');
    assert.strictEqual(r.interruptedBy, g.id);
  }
});

t('evasion-fix: outbound-sms gate now interrupts decide() on a plain "send the email to the client" (2026-07-18 break-swarm follow-up — was proceed:true before the hard-gates.json fix)', () => {
  const r = autonomy.decide({ text: 'send the email to the client', phaseTransition: true }, { mode: 'continue-within-mission' });
  assert.strictEqual(r.proceed, false, 'expected the outbound-sms gate to interrupt a live email send');
  assert.strictEqual(r.interruptedBy, 'outbound-sms');
});

t('the write-outside-root ISOLATION gate (path-escape, not text regex) also always-interrupts, even full-auto', () => {
  const root = freshDir('autonomy-root');
  for (const mode of MODES) {
    const r = autonomy.decide({ text: 'writing a file', path: '../other-project/secret.js' }, { mode, projectRoot: root });
    assert.strictEqual(r.proceed, false, 'expected isolation gate to interrupt at ' + mode);
    assert.strictEqual(r.interruptedBy, 'write-outside-root');
  }
});

t('benign text with no gate does NOT set interruptedBy at any mode (only real gates do)', () => {
  for (const mode of MODES) {
    const r = autonomy.decide({ text: 'add a dark-mode toggle to the settings page' }, { mode });
    assert.notStrictEqual(r.interruptedBy, 'deploy');
  }
});

// ---------------------------------------------------------------------------
// 4) tier 3 — mode logic (only reached once tiers 1/2 are clear)
// ---------------------------------------------------------------------------
console.log('\n4) mode logic — continue-within-mission and full-auto skip the phase re-ask; ask-each-phase does not');

t('continue-within-mission: a plain phase transition proceeds without re-asking (default mode, no opts.mode)', () => {
  const r = autonomy.decide({ text: 'moving to the next phase', phaseTransition: true }, {});
  assert.strictEqual(r.proceed, true);
  assert.strictEqual(r.interruptedBy, null);
});
t('continue-within-mission explicit: a plain phase transition proceeds', () => {
  const r = autonomy.decide({ phaseTransition: true }, { mode: 'continue-within-mission' });
  assert.strictEqual(r.proceed, true);
  assert.strictEqual(r.interruptedBy, null);
});
t('full-auto-within-mission: a plain phase transition proceeds without re-asking', () => {
  const r = autonomy.decide({ phaseTransition: true }, { mode: 'full-auto-within-mission' });
  assert.strictEqual(r.proceed, true);
  assert.strictEqual(r.interruptedBy, null);
});
t('ask-each-phase: a plain phase transition STOPS for owner confirmation (a real re-ask, not a hard interrupt)', () => {
  const r = autonomy.decide({ phaseTransition: true }, { mode: 'ask-each-phase' });
  assert.strictEqual(r.proceed, false);
  assert.strictEqual(r.interruptedBy, null, 'a mode-based stop must NOT be reported as a hard interrupt');
});
t('ask-each-phase: NOT a phase transition (e.g. a mid-phase question) still proceeds', () => {
  const r = autonomy.decide({ text: 'what does this function do' }, { mode: 'ask-each-phase' });
  assert.strictEqual(r.proceed, true);
});
t('unknown mode throws rather than silently defaulting', () => {
  assert.throws(() => autonomy.decide({ phaseTransition: true }, { mode: 'bogus-mode' }));
});

// ---------------------------------------------------------------------------
// 5) NL phrases are ADVISORY ONLY — decide() never looks at them, so "ga door" cannot bypass a hard gate
// ---------------------------------------------------------------------------
console.log('\n5) NL "ga door" is advisory only — never bypasses a hard gate');

t('"ga door" combined with a deploy trigger still interrupts (advisory text never unlocks a gate)', () => {
  const r = autonomy.decide({ text: 'ga door en deploy dit naar productie' }, { mode: 'full-auto-within-mission' });
  assert.strictEqual(r.proceed, false);
  assert.strictEqual(r.interruptedBy, 'deploy');
});
t('"ga door" alone (no gate) proceeds at continue-within-mission on its own merits, not because of the phrase', () => {
  const r = autonomy.decide({ text: 'ga door', phaseTransition: true }, { mode: 'continue-within-mission' });
  assert.strictEqual(r.proceed, true);
});
t('decide() ignores an nl_phrases_advisory-shaped field even if a caller mistakenly passes one', () => {
  const r1 = autonomy.decide({ text: 'deploy to prod', nl_phrase: 'werk op loop' }, { mode: 'ask-each-phase' });
  const r2 = autonomy.decide({ text: 'deploy to prod' }, { mode: 'ask-each-phase' });
  assert.deepStrictEqual(r1, r2, 'an extra nl_phrase field must not change the outcome');
});

// ---------------------------------------------------------------------------
// 6) hermetic config/gates overrides — opts.configPath / opts.gatesPath
// ---------------------------------------------------------------------------
console.log('\n6) opts.configPath / opts.gatesPath hermetic overrides');

t('a custom FORGE_AUTONOMY.json fixture (different default mode) is honored via opts.configPath', () => {
  const dir = freshDir('autonomy-cfg');
  const cfgPath = path.join(dir, 'FORGE_AUTONOMY.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    default: 'ask-each-phase',
    modes: { 'ask-each-phase': 'stop every phase' },
    always_interrupt: ['usage-limit'],
  }));
  const r = autonomy.decide({ phaseTransition: true }, { configPath: cfgPath });
  assert.strictEqual(r.proceed, false, 'fixture default is ask-each-phase, so a phase transition must stop');
});

t('a custom hard-gates.json fixture (extra gate) is honored via opts.gatesPath, still always-interrupts', () => {
  const dir = freshDir('autonomy-gates');
  const gatesPath = path.join(dir, 'hard-gates.json');
  fs.writeFileSync(gatesPath, JSON.stringify({
    gates: [{ id: 'test-only-gate', class: 'irreversible', reason: 'test fixture gate', match: { kind: 'regex', pattern: '\\btest-trigger\\b', flags: 'i' } }],
  }));
  const r = autonomy.decide({ text: 'please test-trigger this now' }, { mode: 'full-auto-within-mission', gatesPath });
  assert.strictEqual(r.proceed, false);
  assert.strictEqual(r.interruptedBy, 'test-only-gate');
});

t('a custom hard-gates.json fixture that does NOT match the given text proceeds normally', () => {
  const dir = freshDir('autonomy-gates');
  const gatesPath = path.join(dir, 'hard-gates.json');
  fs.writeFileSync(gatesPath, JSON.stringify({
    gates: [{ id: 'test-only-gate', class: 'irreversible', reason: 'test fixture gate', match: { kind: 'regex', pattern: '\\btest-trigger\\b', flags: 'i' } }],
  }));
  const r = autonomy.decide({ text: 'add a dark-mode toggle' }, { mode: 'full-auto-within-mission', gatesPath });
  assert.strictEqual(r.proceed, true);
});

t('real config + real gates still work after fixture overrides were exercised (no cross-test cache leakage)', () => {
  const r = autonomy.decide({ text: 'add a dark-mode toggle' }, { mode: 'continue-within-mission' });
  assert.strictEqual(r.proceed, true);
  const r2 = autonomy.decide({ text: 'git push to origin main' }, { mode: 'continue-within-mission' });
  assert.strictEqual(r2.proceed, false);
  assert.strictEqual(r2.interruptedBy, 'git-push');
});

// ---------------------------------------------------------------------------
// 7) CLI — exit codes 0 (proceed) / 3 (interrupted) / 2 (usage error), real spawned subprocess
// ---------------------------------------------------------------------------
console.log('\n7) CLI exit codes (real spawned subprocess)');

t('CLI decide with benign text and no --phase exits 0 and prints PROCEED', () => {
  const r = runCLI(['decide', 'add a dark-mode toggle']);
  assert.strictEqual(r.status, 0);
  assert.ok(r.stdout.includes('PROCEED'));
});
t('CLI decide --phase --mode ask-each-phase exits 3 and prints STOP', () => {
  const r = runCLI(['decide', 'moving on', '--phase', '--mode', 'ask-each-phase']);
  assert.strictEqual(r.status, 3);
  assert.ok(r.stdout.includes('STOP'));
});
t('CLI decide --phase with default mode (continue-within-mission) exits 0', () => {
  const r = runCLI(['decide', 'moving on', '--phase']);
  assert.strictEqual(r.status, 0);
});
t('CLI decide --usage-limit exits 3 with interruptedBy=usage-limit even at full-auto', () => {
  const r = runCLI(['decide', 'moving on', '--phase', '--usage-limit', '--mode', 'full-auto-within-mission', '--json']);
  assert.strictEqual(r.status, 3);
  const parsed = JSON.parse(r.stdout.trim());
  assert.strictEqual(parsed.interruptedBy, 'usage-limit');
});
t('CLI decide with a deploy trigger exits 3 and prints the gate id via --json', () => {
  const r = runCLI(['decide', 'deploy this to prod now', '--json']);
  assert.strictEqual(r.status, 3);
  const parsed = JSON.parse(r.stdout.trim());
  assert.strictEqual(parsed.interruptedBy, 'deploy');
});
t('CLI with an unknown command exits 2 (usage error), not a silent pass', () => {
  const r = runCLI(['bogus-command']);
  assert.strictEqual(r.status, 2);
});
t('CLI with no command at all exits 2', () => {
  const r = runCLI([]);
  assert.strictEqual(r.status, 2);
});
t('CLI decide with an unknown --mode exits 2 (config/usage error, not a silent default)', () => {
  const r = runCLI(['decide', 'moving on', '--mode', 'bogus-mode']);
  assert.strictEqual(r.status, 2);
});

// ---------------------------------------------------------------------------
// 8) v2.7.0 — the mode comes from `/forge config`; decideLive() reads the real usage-guard pause
// ---------------------------------------------------------------------------
console.log('\n8) owner config + live usage-limit (v2.7.0, sandboxed)');

function configFixture(settings) {
  const root = freshDir('autonomy-root');
  const home = freshDir('autonomy-home');
  const entries = {};
  for (const [k, v] of Object.entries(settings || {})) entries[k] = { value: v, set_at: '2026-09-24T00:00:00Z', set_by: 'test' };
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  // project-scope keys (autonomy) live in the project file, global-scope keys (usage-guard) in the global file
  const projectSettings = {}; const globalSettings = {};
  for (const [k, e] of Object.entries(entries)) (k.startsWith('usage-guard') ? globalSettings : projectSettings)[k] = e;
  fs.writeFileSync(path.join(root, '.claude', 'FORGE_CONFIG.json'), JSON.stringify({ version: 1, settings: projectSettings }));
  fs.writeFileSync(path.join(home, 'FORGE_CONFIG.json'), JSON.stringify({ version: 1, settings: globalSettings }));
  return { root, home, configOpts: { projectRoot: root, configHome: home } };
}
function guardState(state) {
  const dir = freshDir('autonomy-guard');
  const statePath = path.join(dir, 'FORGE_USAGE_GUARD_STATE.json');
  if (state) fs.writeFileSync(statePath, JSON.stringify(state));
  return { dir, statePath };
}

t('config autonomy=ask-each-phase: a plain phase transition stops (normal re-ask, not a hard interrupt)', () => {
  const fx = configFixture({ autonomy: 'ask-each-phase' });
  const r = autonomy.decide({ text: 'moving on to phase 2', phaseTransition: true }, { configOpts: fx.configOpts });
  assert.strictEqual(r.proceed, false);
  assert.strictEqual(r.interruptedBy, null);
  assert.strictEqual(r.mode, 'ask-each-phase');
  assert.match(r.modeSource, /forge-config/);
});
t('config autonomy=full-auto-within-mission still stops on a hard gate', () => {
  const fx = configFixture({ autonomy: 'full-auto-within-mission' });
  const r = autonomy.decide({ text: 'git push to origin main', phaseTransition: true }, { configOpts: fx.configOpts });
  assert.strictEqual(r.proceed, false);
  assert.strictEqual(r.interruptedBy, 'git-push');
});
t('opts.mode (the current instruction) beats the config value', () => {
  const fx = configFixture({ autonomy: 'ask-each-phase' });
  const r = autonomy.decide({ text: 'moving on', phaseTransition: true }, { configOpts: fx.configOpts, mode: 'continue-within-mission' });
  assert.strictEqual(r.proceed, true);
  assert.strictEqual(r.modeSource, 'opts.mode');
});
t('no config file: the config default (continue-within-mission) proceeds on a phase transition', () => {
  const fx = configFixture({});
  const r = autonomy.decide({ text: 'moving on', phaseTransition: true }, { configOpts: fx.configOpts });
  assert.strictEqual(r.proceed, true);
  assert.strictEqual(r.mode, 'continue-within-mission');
});
t('forge-config.cjs absent: falls back to FORGE_AUTONOMY.json default', () => {
  const r = autonomy.decide({ text: 'moving on', phaseTransition: true }, { configModule: null });
  assert.strictEqual(r.mode, autonomy.loadConfig().default);
  assert.match(r.modeSource, /FORGE_AUTONOMY\.json/);
});
t('a malformed config file never throws out of decide(): it falls back to the FORGE_AUTONOMY.json default', () => {
  const fx = configFixture({});
  fs.writeFileSync(path.join(fx.root, '.claude', 'FORGE_CONFIG.json'), '{ "settings": ');
  const r = autonomy.decide({ text: 'moving on', phaseTransition: true }, { configOpts: fx.configOpts });
  assert.strictEqual(r.mode, autonomy.loadConfig().default);
  assert.strictEqual(r.proceed, true);
  assert.strictEqual(r.modeSource, 'FORGE_AUTONOMY.json default');
  assert.ok(/damaged/.test(r.config_note || '') && !/\n/.test(r.config_note), 'M3: the degraded read is named: ' + r.config_note);
});
t('CFG-01 (Codex recheck 2026-09-24): a damaged GLOBAL settings file can never bypass an existing, unexpired pause', () => {
  const fx = configFixture({ 'usage-guard': true });
  fs.writeFileSync(path.join(fx.home, 'FORGE_CONFIG.json'), JSON.stringify({ version: 1, settings: { 'usage-guard': { value: true }, 'usage-guard.pause-at': { value: 'banana' } } }));
  const g = guardState({ mode: 'paused' });
  const u = autonomy.usageLimitActive({ statePath: g.statePath, configOpts: fx.configOpts });
  // "may forge-config collect usage data" (the switch, unreadable here) is a SEPARATE question from "must an
  // already-recorded pause be honoured" (this call) — a damaged/unrelated setting must never disable tier 1.
  assert.deepStrictEqual([u.active, u.source], [true, 'state'], 'a damaged config must still honour a recorded pause: ' + u.reason);
  assert.strictEqual(u.config_note, undefined, 'honouring the pause needs no config at all');
  // With NO pause on file at all, the damaged config still only affects the WORDING (never a real pause).
  const noPause = guardState(null);
  const u2 = autonomy.usageLimitActive({ statePath: noPause.statePath, configOpts: fx.configOpts });
  assert.deepStrictEqual([u2.active, u2.source], [false, 'guard-off']);
  assert.ok(/damaged/.test(u2.config_note || '') && /usage-guard = off/.test(u2.config_note), 'config_note: ' + u2.config_note);
  assert.ok(/settings unreadable/.test(u2.reason), u2.reason);
  const fine = configFixture({ 'usage-guard': true });
  const ok = autonomy.usageLimitActive({ statePath: g.statePath, configOpts: fine.configOpts });
  assert.deepStrictEqual([ok.active, ok.config_note], [true, undefined], 'a readable ON still honours the pause');
});
t('usageLimitActive: a paused state file (no reset time reached) is an active usage limit', () => {
  const g = guardState({ mode: 'paused', percents: { session: 99, week: 40 } });
  const u = autonomy.usageLimitActive({ statePath: g.statePath, configOpts: configFixture({}).configOpts });
  assert.strictEqual(u.active, true);
  assert.match(u.reason, /paused/);
});
t('decideLive: a paused guard interrupts by usage-limit, even at full-auto-within-mission', () => {
  const fx = configFixture({ autonomy: 'full-auto-within-mission' });
  const g = guardState({ mode: 'paused' });
  const r = autonomy.decideLive({ text: 'moving on', phaseTransition: true }, { statePath: g.statePath, configOpts: fx.configOpts });
  assert.strictEqual(r.proceed, false);
  assert.strictEqual(r.interruptedBy, 'usage-limit');
  assert.strictEqual(r.usageLimit.active, true);
});
t('decideLive: a missing state file proceeds (no pause was ever recorded)', () => {
  const g = guardState(null);
  const r = autonomy.decideLive({ text: 'moving on', phaseTransition: true }, { statePath: g.statePath, configOpts: configFixture({}).configOpts });
  assert.strictEqual(r.proceed, true);
  assert.strictEqual(r.usageLimit.active, false);
  assert.strictEqual(r.usageLimit.source, 'no-state');
});
t('decideLive: guard state mode ok proceeds', () => {
  const g = guardState({ mode: 'ok' });
  const r = autonomy.decideLive({ text: 'moving on', phaseTransition: true }, { statePath: g.statePath, configOpts: configFixture({}).configOpts });
  assert.strictEqual(r.proceed, true);
});
t('CFG-01: usage-guard OFF in the config still honours a fresh unexpired pause (the switch only labels an ABSENT pause)', () => {
  const g = guardState({ mode: 'paused' });
  const u = autonomy.usageLimitActive({ statePath: g.statePath, configOpts: configFixture({ 'usage-guard': false }).configOpts });
  assert.deepStrictEqual([u.active, u.source], [true, 'state'], u.reason);
});
t('usageLimitActive: with usage-guard OFF and no pause on file at all, the reason is worded "guard-off"', () => {
  const noPause = guardState(null);
  const u = autonomy.usageLimitActive({ statePath: noPause.statePath, configOpts: configFixture({ 'usage-guard': false }).configOpts });
  assert.strictEqual(u.active, false);
  assert.strictEqual(u.source, 'guard-off');
});
t('usageLimitActive: a pause whose reset time has passed is not active (mirrors the hook self-heal)', () => {
  const g = guardState({ mode: 'paused', resumeAtEpoch: 1000 });
  const u = autonomy.usageLimitActive({ statePath: g.statePath, now: 2000, configOpts: configFixture({}).configOpts });
  assert.strictEqual(u.active, false);
});
t('usageLimitActive: a state file saved with a byte-order mark still reads as paused (Windows editors add one)', () => {
  const g = guardState(null);
  fs.writeFileSync(g.statePath, String.fromCharCode(0xFEFF) + JSON.stringify({ mode: 'paused' }));
  const u = autonomy.usageLimitActive({ statePath: g.statePath, configOpts: configFixture({}).configOpts });
  assert.strictEqual(u.active, true, u.reason);
});
t('usageLimitActive: the default state path is <FORGE_USAGE_GUARD_HOME>/FORGE_USAGE_GUARD_STATE.json', () => {
  const home = freshDir('autonomy-guardhome');
  fs.writeFileSync(path.join(home, 'FORGE_USAGE_GUARD_STATE.json'), JSON.stringify({ mode: 'paused' }));
  const u = autonomy.usageLimitActive({ guardHome: home, configOpts: configFixture({}).configOpts });
  assert.strictEqual(u.active, true);
  assert.strictEqual(path.resolve(u.file), path.resolve(path.join(home, 'FORGE_USAGE_GUARD_STATE.json')));
});
t('decide() itself stays pure of the live state: a paused state file never changes plain decide()', () => {
  const g = guardState({ mode: 'paused' });
  const prev = process.env.FORGE_USAGE_GUARD_STATE;
  process.env.FORGE_USAGE_GUARD_STATE = g.statePath;
  try {
    const r = autonomy.decide({ text: 'moving on', phaseTransition: true }, { configOpts: configFixture({}).configOpts });
    assert.strictEqual(r.proceed, true);
  } finally { if (prev === undefined) delete process.env.FORGE_USAGE_GUARD_STATE; else process.env.FORGE_USAGE_GUARD_STATE = prev; }
});
t('CLI decide --live with a paused guard state exits 3 and names usage-limit', () => {
  const home = freshDir('autonomy-cli-guard');
  fs.writeFileSync(path.join(home, 'FORGE_USAGE_GUARD_STATE.json'), JSON.stringify({ mode: 'paused' }));
  const r = spawnSync(process.execPath, [CLI, 'decide', 'moving on', '--phase', '--live', '--json'], { encoding: 'utf8', env: Object.assign({}, process.env, { FORGE_USAGE_GUARD_HOME: home }) });
  assert.strictEqual(r.status, 3, r.stdout + r.stderr);
  assert.strictEqual(JSON.parse(r.stdout.trim()).interruptedBy, 'usage-limit');
});
t('CLI decide without --live ignores the state file (exit 0 on a plain phase)', () => {
  const home = freshDir('autonomy-cli-guard2');
  fs.writeFileSync(path.join(home, 'FORGE_USAGE_GUARD_STATE.json'), JSON.stringify({ mode: 'paused' }));
  const r = spawnSync(process.execPath, [CLI, 'decide', 'moving on', '--phase'], { encoding: 'utf8', env: Object.assign({}, process.env, { FORGE_USAGE_GUARD_HOME: home }) });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
});
t('CLI decide honours the project config (autonomy=ask-each-phase -> exit 3 on --phase)', () => {
  const fx = configFixture({ autonomy: 'ask-each-phase' });
  const r = spawnSync(process.execPath, [CLI, 'decide', 'moving on', '--phase'], { encoding: 'utf8', env: Object.assign({}, process.env, { FORGE_PROJECT_ROOT: fx.root, FORGE_CONFIG_HOME: fx.home }) });
  assert.strictEqual(r.status, 3, r.stdout + r.stderr);
  assert.ok(r.stdout.includes('STOP'));
});

// ---- wp20 L8 (2026-09-24): a paused state without a reset time from a watcher that stopped checking is STALE ----
const L8_NOW = Date.parse('2026-09-24T12:00:00Z');
const agoIso = (sec) => new Date(L8_NOW - sec * 1000).toISOString();
t('L8: a FRESH paused state (last check 60 s ago, no reset time) is still an active usage limit', () => {
  const g = guardState({ mode: 'paused', lastCheckAt: agoIso(60) });
  const u = autonomy.usageLimitActive({ statePath: g.statePath, now: L8_NOW, configOpts: configFixture({}).configOpts });
  assert.strictEqual(u.active, true, u.reason);
  assert.strictEqual(u.source, 'state');
});
t('L8: a STALE paused state (last check older than 3 x 120 s, no reset time) is NOT active and says why', () => {
  const g = guardState({ mode: 'paused', lastCheckAt: agoIso(361), heartbeatAt: agoIso(400) });
  const u = autonomy.usageLimitActive({ statePath: g.statePath, now: L8_NOW, configOpts: configFixture({}).configOpts });
  assert.strictEqual(u.active, false);
  assert.strictEqual(u.source, 'stale');
  assert.match(u.reason, /361 s ago \(more than 3 x the 120 s interval\).*NOT treated as active/);
});
t('L8: exactly 3 x the interval is still fresh; a newer heartbeat keeps an old lastCheckAt fresh', () => {
  const edge = guardState({ mode: 'paused', lastCheckAt: agoIso(360) });
  assert.strictEqual(autonomy.usageLimitActive({ statePath: edge.statePath, now: L8_NOW, configOpts: configFixture({}).configOpts }).active, true);
  const hb = guardState({ mode: 'paused', lastCheckAt: agoIso(5000), heartbeatAt: agoIso(30) });
  assert.strictEqual(autonomy.usageLimitActive({ statePath: hb.statePath, now: L8_NOW, configOpts: configFixture({}).configOpts }).active, true);
});
t('L8: the owner interval (usage-guard.interval 300) moves the stale line to 900 s', () => {
  const fx = configFixture({ 'usage-guard.interval': 300 });
  const fresh = guardState({ mode: 'paused', lastCheckAt: agoIso(800) });
  assert.strictEqual(autonomy.usageLimitActive({ statePath: fresh.statePath, now: L8_NOW, configOpts: fx.configOpts }).active, true);
  const stale = guardState({ mode: 'paused', lastCheckAt: agoIso(901) });
  const u = autonomy.usageLimitActive({ statePath: stale.statePath, now: L8_NOW, configOpts: fx.configOpts });
  assert.deepStrictEqual([u.active, u.source], [false, 'stale'], u.reason);
});
t('L8: a pause WITH a future reset time stays active even when the last check is old (the reset rule decides)', () => {
  const g = guardState({ mode: 'paused', lastCheckAt: agoIso(5000), resumeAtEpoch: L8_NOW + 3600 * 1000 });
  const u = autonomy.usageLimitActive({ statePath: g.statePath, now: L8_NOW, configOpts: configFixture({}).configOpts });
  assert.strictEqual(u.active, true, u.reason);
});
t('L8: decideLive on a stale pause proceeds instead of stopping every phase forever', () => {
  const g = guardState({ mode: 'paused', lastCheckAt: agoIso(3600) });
  const r = autonomy.decideLive({ text: 'moving on', phaseTransition: true }, { statePath: g.statePath, now: L8_NOW, configOpts: configFixture({ autonomy: 'full-auto-within-mission' }).configOpts });
  assert.strictEqual(r.proceed, true, r.reason);
  assert.strictEqual(r.usageLimit.source, 'stale');
});

// ---- SB-M6 (2026-09-24, Security Boss wave 11, sec-w11) — an owner who already PAID for a usage-override
// must never be blocked forever by a guard-owned "paused" state that only persists because a resume attempt
// keeps failing (e.g. an agent that no longer exists) — see usage-guard.cjs's own doResume()/runOverrideOn()
// SB-M6 history. state.json's `ownerOverride` cache is written FRESH every tick directly from the
// authoritative grant record whenever it is actually honoured (usage-guard.cjs's tick() /
// usage-guard-override.cjs's resolveOwnerOverride()) — reading it here reads THAT already-honoured decision,
// never a stale flag used to greenlight a NEW pause decision (that remains usage-guard.cjs's own rule). ----
t('SB-M6: a guard-owned "paused" state with a CURRENTLY HONOURED, unexpired usage-override is NOT treated as a live usage-limit block (a resume-retry bookkeeping loop must never block an owner who already paid)', () => {
  const g = guardState({ mode: 'paused', ownerOverride: { active: true, until: new Date(Date.now() + 3600000).toISOString() }, resumePending: true, pausedAgents: [{ id: 'a1' }] });
  const u = autonomy.usageLimitActive({ statePath: g.statePath, configOpts: configFixture({}).configOpts });
  assert.strictEqual(u.active, false, u.reason);
  assert.strictEqual(u.source, 'override-honoured');
});
t('SB-M6: an EXPIRED ownerOverride cache does NOT suppress the pause — fail toward blocking, exactly like the real guard behaves once it reconciles', () => {
  const g = guardState({ mode: 'paused', ownerOverride: { active: true, until: new Date(Date.now() - 1000).toISOString() } });
  const u = autonomy.usageLimitActive({ statePath: g.statePath, configOpts: configFixture({}).configOpts });
  assert.strictEqual(u.active, true, u.reason);
});
t('SB-M6: a "paused" state with NO ownerOverride at all is unaffected by this fix — an ordinary pause still blocks normally', () => {
  const g = guardState({ mode: 'paused' });
  const u = autonomy.usageLimitActive({ statePath: g.statePath, configOpts: configFixture({}).configOpts });
  assert.strictEqual(u.active, true, u.reason);
  assert.notStrictEqual(u.source, 'override-honoured');
});
t('SB-M6: decideLive proceeds (even at full-auto-within-mission) when a guard-owned pause coexists with a currently-honoured override', () => {
  const fx = configFixture({ autonomy: 'full-auto-within-mission' });
  const g = guardState({ mode: 'paused', ownerOverride: { active: true, until: new Date(Date.now() + 3600000).toISOString() } });
  const r = autonomy.decideLive({ text: 'moving on', phaseTransition: true }, { statePath: g.statePath, configOpts: fx.configOpts });
  assert.strictEqual(r.proceed, true, r.reason);
  assert.strictEqual(r.usageLimit.active, false);
});

try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* best effort */ }
console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
