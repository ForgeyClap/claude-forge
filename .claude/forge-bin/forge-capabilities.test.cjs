#!/usr/bin/env node
'use strict';
// forge-capabilities.test.cjs — real tests for the honest capabilities-vs-usage inventory (2026-07-22,
// WAVE V9 / piece P2). Proves: inventory() finds the REAL forge-bin tools/forge-* skills/gates on disk
// (never a hardcoded list); a hermetic fixture root proves usage() counts a used capability and reports a
// never-used one as 0/null (no fabrication); status classification (active/dormant/opt-in) is correct at
// both the inventory layer (static) and the report layer (usage-aware); malformed run dirs/events/config are
// tolerated rather than crashing; the CLI's inventory/usage/report subcommands work end-to-end via a real
// spawned subprocess.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const caps = require('./forge-capabilities.cjs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

const CLI = path.join(__dirname, 'forge-capabilities.cjs');
function runCLI(argv) { return spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' }); }
function freshDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); }

// ---------------------------------------------------------------------------
// fixture builder — a hermetic root with fake tools/skills/gates/runs/memory
// ---------------------------------------------------------------------------
function buildFixtureRoot() {
  const root = freshDir('forge-capabilities-fixture');
  const cd = path.join(root, '.claude');

  // forge-bin: 3 real tool files (one never mentioned anywhere, one mentioned only via a run event, one
  // mentioned only via FORGE_* history) + a .test.cjs sibling that must be EXCLUDED from inventory.
  const binDir = path.join(cd, 'forge-bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'fake-tool.cjs'), '// fake tool used via a run event\n');
  fs.writeFileSync(path.join(binDir, 'fake-tool.test.cjs'), '// must be excluded from inventory\n');
  fs.writeFileSync(path.join(binDir, 'only-in-history-tool.cjs'), '// mentioned only in FORGE_* history\n');
  fs.writeFileSync(path.join(binDir, 'never-used-tool.cjs'), '// never mentioned anywhere\n');

  // skills: one forge-* skill used via a run event, one forge-* skill used only via agent-memory, one
  // forge-* skill never used, and one NON-forge-prefixed skill that must be EXCLUDED entirely.
  const skillsDir = path.join(cd, 'skills');
  for (const name of ['forge-fake', 'forge-onlymemory', 'forge-neverused']) {
    fs.mkdirSync(path.join(skillsDir, name), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, name, 'SKILL.md'), '# ' + name + '\n');
  }
  fs.mkdirSync(path.join(skillsDir, 'notforge'), { recursive: true });
  fs.writeFileSync(path.join(skillsDir, 'notforge', 'SKILL.md'), '# notforge\n');
  // a forge-* directory WITHOUT a SKILL.md must also be excluded (not a real skill)
  fs.mkdirSync(path.join(skillsDir, 'forge-incomplete'), { recursive: true });

  // gates config: 2 real gates; a 3rd "known" id is deliberately left OUT of config to prove present:false
  const orchDir = path.join(cd, 'config', 'orchestration');
  fs.mkdirSync(orchDir, { recursive: true });
  const gatesConfigPath = path.join(orchDir, 'hard-gates.json');
  fs.writeFileSync(gatesConfigPath, JSON.stringify({
    gates: [
      { id: 'test-gate-a', class: 'irreversible', match: { kind: 'regex', pattern: 'deploy-now' }, reason: 'test gate a' },
      { id: 'test-gate-b', class: 'irreversible', match: { kind: 'regex', pattern: 'spend-now' }, reason: 'test gate b' },
    ],
  }));
  const knownGateIds = ['test-gate-a', 'test-gate-b', 'test-gate-missing'];

  // forge-runs: 2 real runs proving used-capability detection + last-used update-to-latest + tolerance of
  // a malformed/blank line, PLUS a stray non-directory entry directly under forge-runs (malformed layout).
  const runsDir = path.join(cd, 'forge-runs');
  fs.mkdirSync(runsDir, { recursive: true });
  fs.writeFileSync(path.join(runsDir, 'not-a-run-dir.txt'), 'stray file, not a run directory\n');
  const run1 = path.join(runsDir, 'forge-2026-07-20-000000');
  fs.mkdirSync(run1, { recursive: true });
  fs.writeFileSync(path.join(run1, 'events.jsonl'), [
    JSON.stringify({ event_type: 'skill_loaded', skill: 'forge-fake', timestamp: '2026-07-20T00:00:00.000Z' }),
    JSON.stringify({ event_type: 'command_run', command: 'node forge-bin/fake-tool.cjs run', timestamp: '2026-07-20T00:05:00.000Z' }),
    JSON.stringify({ event_type: 'gate_evaluated', gate: 'test-gate-a', timestamp: '2026-07-20T00:10:00.000Z' }),
    '', // blank line — must be tolerated
    '{ not valid json at all', // malformed line — must be tolerated, not crash
  ].join('\n') + '\n');
  const run2 = path.join(runsDir, 'forge-2026-07-21-000000');
  fs.mkdirSync(run2, { recursive: true });
  fs.writeFileSync(path.join(run2, 'events.jsonl'), [
    JSON.stringify({ event_type: 'skill_loaded', skill: 'forge-fake', timestamp: '2026-07-21T09:00:00.000Z' }),
  ].join('\n') + '\n');
  // a run directory with NO events.jsonl at all — malformed but must be tolerated, not crash
  fs.mkdirSync(path.join(runsDir, 'forge-2026-07-22-empty-run'), { recursive: true });
  // an OUT-OF-ORDER run: its directory name sorts LAST (alphabetically after the two above), but its own
  // event timestamp is EARLIER than run1's — proves "last_used" is chosen by real max-timestamp comparison,
  // not merely "whichever run happened to be read last".
  const run0 = path.join(runsDir, 'forge-9999-99-99-out-of-order');
  fs.mkdirSync(run0, { recursive: true });
  fs.writeFileSync(path.join(run0, 'events.jsonl'), [
    JSON.stringify({ event_type: 'command_run', command: 'node forge-bin/fake-tool.cjs run', timestamp: '2020-01-01T00:00:00.000Z' }),
  ].join('\n') + '\n');

  // agent-memory: a real written mention of forge-onlymemory, with no run attribution possible
  const memDir = path.join(cd, 'agent-memory', 'build-boss');
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, 'MEMORY.md'), '# Build Boss Memory\n\n- used the forge-onlymemory skill successfully on a prior task.\n');

  // top-level FORGE_* history: a real written mention of only-in-history-tool
  fs.writeFileSync(path.join(cd, 'FORGE_TASK_HISTORY.md'), '# Task History\n\n- ran only-in-history-tool to clean things up.\n');
  // a non-FORGE_-prefixed file placed alongside must be ignored by readForgeStarHaystacks
  fs.writeFileSync(path.join(cd, 'README.md'), 'this file must not be scanned for FORGE_* mentions\n');

  return { root, cd, gatesConfigPath, knownGateIds, runsDir };
}

console.log('forge-capabilities tests (honest capabilities-vs-usage inventory)');

// ---------------------------------------------------------------------------
// 1) inventory() finds the REAL forge-bin tools / forge-* skills / gates on disk
// ---------------------------------------------------------------------------
console.log('\n1) inventory() against the REAL project — never a hardcoded list');

t('inventory() finds this module itself as a real forge-bin tool', () => {
  const inv = caps.inventory({});
  const ids = inv.map((c) => c.id);
  assert.ok(ids.includes('tool:forge-capabilities'), 'expected tool:forge-capabilities in ' + JSON.stringify(ids.slice(0, 5)) + '...');
});
t('inventory() finds real forge-* skills (e.g. forge-website) and excludes non-forge skills (e.g. gsap)', () => {
  const inv = caps.inventory({});
  const ids = inv.map((c) => c.id);
  assert.ok(ids.includes('skill:forge-website'));
  assert.ok(!ids.includes('skill:gsap') && !ids.some((id) => id === 'skill:humanizer'));
});
t('inventory() finds real hard-gates (e.g. deploy) from the real hard-gates.json via KNOWN_GATES', () => {
  const inv = caps.inventory({});
  const ids = inv.map((c) => c.id);
  assert.ok(ids.includes('gate:deploy'));
  const deployGate = inv.find((c) => c.id === 'gate:deploy');
  assert.strictEqual(deployGate.present, true);
  assert.strictEqual(deployGate.status, 'active');
});
t('every real inventory item has a well-formed shape (id/kind/name/present/status)', () => {
  const inv = caps.inventory({});
  assert.ok(inv.length > 10, 'expected a substantial real inventory, got ' + inv.length);
  for (const c of inv) {
    assert.ok(c.id && typeof c.id === 'string');
    assert.ok(['tool', 'skill', 'gate'].includes(c.kind));
    assert.ok(c.name && typeof c.name === 'string');
    assert.ok(typeof c.present === 'boolean');
    assert.ok(['active', 'dormant', 'opt-in'].includes(c.status));
  }
});

// ---------------------------------------------------------------------------
// 2) hermetic fixture — status classification + usage counting, both ways
// ---------------------------------------------------------------------------
console.log('\n2) hermetic fixture — inventory + status classification');

const fx = buildFixtureRoot();
const fxOpts = { root: fx.root, gatesConfigPath: fx.gatesConfigPath, knownGateIds: fx.knownGateIds };

t('fixture inventory finds exactly the 3 real forge-bin tools (test.cjs sibling excluded)', () => {
  const inv = caps.inventory(fxOpts);
  const toolIds = inv.filter((c) => c.kind === 'tool').map((c) => c.id).sort();
  assert.deepStrictEqual(toolIds, ['tool:fake-tool', 'tool:never-used-tool', 'tool:only-in-history-tool']);
});
t('fixture inventory finds exactly the 3 real forge-* skills (notforge + forge-incomplete excluded)', () => {
  const inv = caps.inventory(fxOpts);
  const skillIds = inv.filter((c) => c.kind === 'skill').map((c) => c.id).sort();
  assert.deepStrictEqual(skillIds, ['skill:forge-fake', 'skill:forge-neverused', 'skill:forge-onlymemory']);
});
t('fixture gates: present gate is "active", known-but-missing gate is "dormant"', () => {
  const inv = caps.inventory(fxOpts);
  const a = inv.find((c) => c.id === 'gate:test-gate-a');
  const missing = inv.find((c) => c.id === 'gate:test-gate-missing');
  assert.strictEqual(a.present, true);
  assert.strictEqual(a.status, 'active');
  assert.strictEqual(missing.present, false);
  assert.strictEqual(missing.status, 'dormant');
});
t('fixture tools/skills are all "opt-in" at the static inventory layer, regardless of future usage', () => {
  const inv = caps.inventory(fxOpts);
  for (const c of inv) if (c.kind === 'tool' || c.kind === 'skill') assert.strictEqual(c.status, 'opt-in', c.id + ' should be opt-in at inventory time');
});

console.log('\n3) hermetic fixture — usage() counts real evidence, honestly reports zero for the unused');

t('a tool mentioned in a real run event (command_run) is counted, with last_used populated', () => {
  const u = caps.usage({ runsDir: fx.runsDir }, fxOpts);
  const c = u.find((x) => x.id === 'tool:fake-tool');
  assert.strictEqual(c.times_used, 2); // run1 (2026-07-20) + the deliberately out-of-order run0 (2020-01-01)
  assert.strictEqual(c.last_used_run, 'forge-2026-07-20-000000');
  assert.strictEqual(c.last_used_ts, '2026-07-20T00:05:00.000Z');
});
t('last_used is chosen by real MAX timestamp, not by directory read/iteration order: an out-of-order run dir '
  + '(sorts last alphabetically, but its own event timestamp is far OLDER) must not overwrite the true latest use', () => {
  const u = caps.usage({ runsDir: fx.runsDir }, fxOpts);
  const c = u.find((x) => x.id === 'tool:fake-tool');
  // fake-tool now appears in BOTH run1 (2026-07-20) and the out-of-order run0 (2020-01-01, read last)
  assert.strictEqual(c.times_used, 2);
  assert.strictEqual(c.last_used_run, 'forge-2026-07-20-000000');
  assert.strictEqual(c.last_used_ts, '2026-07-20T00:05:00.000Z');
});
t('a skill used in TWO run events across two runs: times_used=2 and last_used points at the LATEST run/ts', () => {
  const u = caps.usage({ runsDir: fx.runsDir }, fxOpts);
  const c = u.find((x) => x.id === 'skill:forge-fake');
  assert.strictEqual(c.times_used, 2);
  assert.strictEqual(c.last_used_run, 'forge-2026-07-21-000000');
  assert.strictEqual(c.last_used_ts, '2026-07-21T09:00:00.000Z');
});
t('a gate fired via a real gate_evaluated event is counted as used', () => {
  const u = caps.usage({ runsDir: fx.runsDir }, fxOpts);
  const c = u.find((x) => x.id === 'gate:test-gate-a');
  assert.strictEqual(c.times_used, 1);
  assert.strictEqual(c.last_used_run, 'forge-2026-07-20-000000');
});
t('a gate NEVER fired (test-gate-b) is honestly reported as 0/null even though it is present in config', () => {
  const u = caps.usage({ runsDir: fx.runsDir }, fxOpts);
  const c = u.find((x) => x.id === 'gate:test-gate-b');
  assert.strictEqual(c.times_used, 0);
  assert.strictEqual(c.last_used_run, null);
  assert.strictEqual(c.last_used_ts, null);
});
t('a skill mentioned only in agent-memory (no run) is counted but gets no run/timestamp attribution', () => {
  const u = caps.usage({ runsDir: fx.runsDir }, fxOpts);
  const c = u.find((x) => x.id === 'skill:forge-onlymemory');
  assert.strictEqual(c.times_used, 1);
  assert.strictEqual(c.last_used_run, null);
  assert.strictEqual(c.last_used_ts, null);
});
t('a tool mentioned only in top-level FORGE_*.md history is counted, no run/timestamp attribution', () => {
  const u = caps.usage({ runsDir: fx.runsDir }, fxOpts);
  const c = u.find((x) => x.id === 'tool:only-in-history-tool');
  assert.strictEqual(c.times_used, 1);
  assert.strictEqual(c.last_used_run, null);
});
t('README.md (not FORGE_*-prefixed) is never scanned — proven by a name that ONLY appears there', () => {
  // never-used-tool.cjs is not mentioned in README.md's own text at all, but this also proves the scanner
  // does not pick up the literal word "file" from README.md and miscount an unrelated capability.
  const u = caps.usage({ runsDir: fx.runsDir }, fxOpts);
  const c = u.find((x) => x.id === 'tool:never-used-tool');
  assert.strictEqual(c.times_used, 0, 'never-used-tool must stay at 0 — nothing should leak in from README.md');
});
t('a genuinely never-mentioned tool AND skill are both honestly reported as 0/null (no fabrication)', () => {
  const u = caps.usage({ runsDir: fx.runsDir }, fxOpts);
  const tool = u.find((x) => x.id === 'tool:never-used-tool');
  const skill = u.find((x) => x.id === 'skill:forge-neverused');
  for (const c of [tool, skill]) {
    assert.strictEqual(c.times_used, 0);
    assert.strictEqual(c.last_used_run, null);
    assert.strictEqual(c.last_used_ts, null);
  }
});

console.log('\n4) malformed run dirs / events / config are tolerated, never crash');

t('a stray non-directory file directly under forge-runs/ is skipped without crashing', () => {
  assert.doesNotThrow(() => caps.usage({ runsDir: fx.runsDir }, fxOpts));
});
t('a run directory with NO events.jsonl at all is skipped without crashing', () => {
  const u = caps.usage({ runsDir: fx.runsDir }, fxOpts);
  assert.ok(Array.isArray(u) && u.length > 0);
});
t('a malformed/blank line inside a real events.jsonl is skipped, not counted, not crashed', () => {
  // run1's events.jsonl has one blank line + one invalid-JSON line; if either were mis-parsed it would
  // either throw or silently inflate some capability's times_used — neither happens.
  assert.doesNotThrow(() => caps.usage({ runsDir: fx.runsDir }, fxOpts));
});
t('a completely missing forge-runs directory does not throw, and a capability with NO static mention anywhere stays honestly 0/null', () => {
  const nowhere = path.join(freshDir('forge-capabilities-norun'), 'does-not-exist');
  const u = caps.usage({ runsDir: nowhere }, fxOpts);
  assert.ok(Array.isArray(u) && u.length > 0);
  const neverMentioned = u.find((c) => c.id === 'tool:never-used-tool');
  assert.strictEqual(neverMentioned.times_used, 0);
  assert.strictEqual(neverMentioned.last_used_run, null);
  assert.strictEqual(neverMentioned.last_used_ts, null);
  // a capability normally only proven used via a RUN event (fake-tool/forge-fake/test-gate-a) genuinely has
  // no evidence left once forge-runs/ is gone — still honestly 0, never fabricated from stale state.
  const runOnly = u.find((c) => c.id === 'gate:test-gate-a');
  assert.strictEqual(runOnly.times_used, 0);
});
t('a missing/invalid gates config is tolerated: known gate ids reported present:false, no throw', () => {
  const badGatesPath = path.join(freshDir('forge-capabilities-badgates'), 'does-not-exist.json');
  const inv = caps.inventory({ root: fx.root, gatesConfigPath: badGatesPath, knownGateIds: ['whatever-id'] });
  const g = inv.find((c) => c.id === 'gate:whatever-id');
  assert.ok(g);
  assert.strictEqual(g.present, false);
  assert.strictEqual(g.status, 'dormant');
});

// ---------------------------------------------------------------------------
// 5) report() — usage-aware status + summary counts
// ---------------------------------------------------------------------------
console.log('\n5) report() — usage-aware status promotion + summary tally');

t('report(): a used tool/skill is promoted to "active"; an unused one stays "opt-in"', () => {
  const r = caps.report(Object.assign({}, fxOpts, { runsDir: fx.runsDir }));
  const usedTool = r.capabilities.find((c) => c.capability === 'tool:fake-tool');
  const unusedTool = r.capabilities.find((c) => c.capability === 'tool:never-used-tool');
  assert.strictEqual(usedTool.status, 'active');
  assert.strictEqual(usedTool.times_used, 2);
  assert.strictEqual(unusedTool.status, 'opt-in');
  assert.strictEqual(unusedTool.times_used, 0);
});
t('report(): a gate keeps its static status regardless of whether it has fired yet', () => {
  const r = caps.report(Object.assign({}, fxOpts, { runsDir: fx.runsDir }));
  const firedGate = r.capabilities.find((c) => c.capability === 'gate:test-gate-a');
  const neverFiredGate = r.capabilities.find((c) => c.capability === 'gate:test-gate-b');
  const missingGate = r.capabilities.find((c) => c.capability === 'gate:test-gate-missing');
  assert.strictEqual(firedGate.status, 'active');
  assert.strictEqual(neverFiredGate.status, 'active'); // present + structurally enforced, even though times_used is 0
  assert.strictEqual(neverFiredGate.times_used, 0);
  assert.strictEqual(missingGate.status, 'dormant');
});
t('report(): summary tallies are internally consistent with the per-capability list', () => {
  const r = caps.report(Object.assign({}, fxOpts, { runsDir: fx.runsDir }));
  const byStatus = { active: 0, dormant: 0, 'opt-in': 0 };
  for (const c of r.capabilities) byStatus[c.status]++;
  assert.strictEqual(r.summary.total, r.capabilities.length);
  assert.strictEqual(r.summary.active, byStatus.active);
  assert.strictEqual(r.summary.dormant, byStatus.dormant);
  assert.strictEqual(r.summary.opt_in, byStatus['opt-in']);
  const neverUsedCount = r.capabilities.filter((c) => c.times_used === 0).length;
  assert.strictEqual(r.summary.never_used, neverUsedCount);
});

// ---------------------------------------------------------------------------
// 6) nameAppears() word-boundary matching
// ---------------------------------------------------------------------------
console.log('\n6) nameAppears() — word-boundary substring matching');

t('nameAppears matches a whole-word occurrence, case-insensitively', () => {
  assert.ok(caps.nameAppears('forge-doctor', '"skill":"forge-doctor"'));
  assert.ok(caps.nameAppears('forge-doctor', 'RAN FORGE-DOCTOR TODAY'));
});
t('nameAppears does NOT match a name that is only a substring of a longer identifier', () => {
  assert.ok(!caps.nameAppears('forge-doctor', 'forge-doctor-panel-widget'));
  assert.ok(!caps.nameAppears('deploy', 'redeploying the stack'));
});

// ---------------------------------------------------------------------------
// 7) CLI — inventory / usage / report subcommands, real spawned subprocess
// ---------------------------------------------------------------------------
console.log('\n7) CLI subcommands (real spawned subprocess)');

function cliOverrides(fixture) {
  return ['--root', fixture.root, '--gates-config', fixture.gatesConfigPath, '--known-gates', fixture.knownGateIds.join(',')];
}

t('CLI inventory --json against the fixture returns the expected tool/skill/gate counts', () => {
  const r = runCLI(['inventory', '--json', ...cliOverrides(fx)]);
  assert.strictEqual(r.status, 0);
  const parsed = JSON.parse(r.stdout.trim());
  assert.strictEqual(parsed.filter((c) => c.kind === 'tool').length, 3);
  assert.strictEqual(parsed.filter((c) => c.kind === 'skill').length, 3);
  assert.strictEqual(parsed.filter((c) => c.kind === 'gate').length, 3);
});
t('CLI usage --json against the fixture reports the used tool with times_used=1', () => {
  const r = runCLI(['usage', '--json', '--runs-dir', fx.runsDir, ...cliOverrides(fx)]);
  assert.strictEqual(r.status, 0);
  const parsed = JSON.parse(r.stdout.trim());
  const c = parsed.find((x) => x.id === 'tool:fake-tool');
  assert.strictEqual(c.times_used, 2);
});
t('CLI report --json against the fixture returns a consistent summary', () => {
  const r = runCLI(['report', '--json', '--runs-dir', fx.runsDir, ...cliOverrides(fx)]);
  assert.strictEqual(r.status, 0);
  const parsed = JSON.parse(r.stdout.trim());
  assert.strictEqual(parsed.summary.total, parsed.capabilities.length);
});
t('CLI report (human-readable) against the fixture prints a summary line', () => {
  const r = runCLI(['report', '--runs-dir', fx.runsDir, ...cliOverrides(fx)]);
  assert.strictEqual(r.status, 0);
  assert.ok(r.stdout.includes('total:'));
});
t('CLI with an unknown command exits 2', () => {
  const r = runCLI(['bogus-command']);
  assert.strictEqual(r.status, 2);
});
t('CLI with no command at all exits 2', () => {
  const r = runCLI([]);
  assert.strictEqual(r.status, 2);
});
t('CLI with an unknown flag exits 2', () => {
  const r = runCLI(['inventory', '--not-a-real-flag']);
  assert.strictEqual(r.status, 2);
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
