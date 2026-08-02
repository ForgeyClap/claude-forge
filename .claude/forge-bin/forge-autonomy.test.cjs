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

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
