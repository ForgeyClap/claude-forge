#!/usr/bin/env node
'use strict';
/** Hermetic + real-config tests for forge-mcp-gate.cjs (WAVE G1, 2026-07-19). Fixture files live under a
 *  fresh os.mkdtemp temp dir so nothing touches the real project config except the explicit "real config
 *  sanity" section, which only READS the real registry/grants files. Convention (matches nvidia-provider.
 *  test.cjs / forge-actiongate's sibling style): t()-harness, REAL assertions, spawned CLI tests, exit
 *  codes 0/2/3, "<N> passed, <M> failed" summary line, non-zero exit on any failure. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const G = require('./forge-mcp-gate.cjs');

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };

console.log('forge-mcp-gate offline tests');

// ---------------------------------------------------------------------------------------------------------
// 1) REAL config sanity — reads the actual shipped registry/grants (not fixtures).
// ---------------------------------------------------------------------------------------------------------
const realRegistry = G.loadRegistry({});
const realGrants = G.loadGrants({});
t('real registry has >=7 seeded servers', realRegistry.servers.length >= 7);
t('every real server is dormant (status "not-installed")', realRegistry.servers.every((s) => s.status === 'not-installed'));
t('every real server has a valid tier 0-3', realRegistry.servers.every((s) => [0, 1, 2, 3].includes(s.tier)));
{
  const r = realRegistry.servers.find((s) => s.id === 'github-read');
  const w = realRegistry.servers.find((s) => s.id === 'github-write');
  t('github is split: github-read is tier1, github-write is tier3', !!r && r.tier === 1 && !!w && w.tier === 3);
}
const twelveBosses = ['boss', 'head-chef', 'review-boss', 'test-boss', 'ui-boss', 'seo-boss', 'security-boss', 'skill-boss', 'search-boss', 'build-boss', 'integration-boss', 'docs-boss'];
t('real grants cover all 12 permanent Bosses', twelveBosses.every((b) => realGrants.bosses[b]));
t('NO boss has tier3 in its default grant (doctrine: no Boss gets tier3 by default)', Object.values(realGrants.bosses).every((g) => {
  return g.allow_servers.every((sid) => { const s = realRegistry.servers.find((x) => x.id === sid); return !s || s.tier < 3; });
}));
t('doctrine default: build-boss max_tier=0', realGrants.bosses['build-boss'].max_tier === 0);
t('doctrine default: search-boss/review-boss/integration-boss max_tier=1', realGrants.bosses['search-boss'].max_tier === 1 && realGrants.bosses['review-boss'].max_tier === 1 && realGrants.bosses['integration-boss'].max_tier === 1);
t('doctrine default: ui-boss/test-boss max_tier=2', realGrants.bosses['ui-boss'].max_tier === 2 && realGrants.bosses['test-boss'].max_tier === 2);
t('status() with real config: nothing is auto-active', G.status({}).every((s) => s.active === false));
t('status() with real config: nothing is opted-in by default (no opt-in file shipped)', G.status({}).every((s) => s.opted_in === false));

// ---------------------------------------------------------------------------------------------------------
// 2) Hermetic fixtures — isolated temp dir, never touches real project config.
// ---------------------------------------------------------------------------------------------------------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mcp-gate-test-'));
const registryPath = path.join(TMP, 'mcp-registry.json');
const grantsPath = path.join(TMP, 'mcp-grants.json');
const optInAllPath = path.join(TMP, 'mcp-opt-in-all.json');
const optInNonePath = path.join(TMP, 'mcp-opt-in-none.json'); // deliberately missing file -> tests the ENOENT default
const gatesAlwaysPath = path.join(TMP, 'hard-gates-always.json');
const gatesNeverPath = path.join(TMP, 'hard-gates-never.json');

fs.writeFileSync(registryPath, JSON.stringify({
  servers: [
    { id: 'serena-lsp', purpose: 'local semantic code read', tier: 0, network: 'none', credentials_needed: false, install_hint: 'x', status: 'not-installed', notes: '' },
    { id: 'context7', purpose: 'remote docs lookup', tier: 1, network: 'read', credentials_needed: false, install_hint: 'x', status: 'not-installed', notes: '' },
    { id: 'playwright', purpose: 'browser QA drive', tier: 2, network: 'read-write', credentials_needed: false, install_hint: 'x', status: 'not-installed', notes: '' },
    { id: 'github-write', purpose: 'github write access', tier: 3, network: 'read-write', credentials_needed: true, install_hint: 'x', status: 'not-installed', notes: '' },
  ],
}));
fs.writeFileSync(grantsPath, JSON.stringify({
  bosses: {
    'build-boss': { max_tier: 0, allow_servers: ['serena-lsp'], why: 'fixture' },
    'search-boss': { max_tier: 1, allow_servers: ['context7'], why: 'fixture' },
    'ui-boss': { max_tier: 2, allow_servers: ['playwright'], why: 'fixture' },
  },
}));
fs.writeFileSync(optInAllPath, JSON.stringify({ opted_in: ['serena-lsp', 'context7', 'playwright', 'github-write'] }));
fs.writeFileSync(gatesAlwaysPath, JSON.stringify({ gates: [{ id: 'test-always-gate', class: 'irreversible', reason: 'fixture gate that matches everything', match: { kind: 'regex', pattern: '.*' } }] }));
fs.writeFileSync(gatesNeverPath, JSON.stringify({ gates: [{ id: 'test-never-gate', class: 'irreversible', reason: 'fixture gate that never matches', match: { kind: 'regex', pattern: '^this-will-never-appear-in-any-text$' } }] }));

const baseOpts = () => ({ registryPath, grantsPath, optInPath: optInAllPath });
const baseOptsNoOptIn = () => ({ registryPath, grantsPath, optInPath: optInNonePath });

// ---- validateGrant: tiers 0-2 standard path ----
{
  const r = G.validateGrant({ boss: 'build-boss', server: 'playwright' }, baseOpts());
  t('tier0 boss (build-boss) CANNOT get a tier2 tool (playwright)', r.allowed === false && r.tier === 2);
}
{
  const r = G.validateGrant({ boss: 'build-boss', server: 'serena-lsp' }, baseOpts());
  t('tier0 boss (build-boss) CAN get its own tier0 tool (serena-lsp)', r.allowed === true && r.tier === 0);
}
{
  // escalation-sensitive: serena-lsp IS in build-boss's allow_servers, but the caller forces tier=2 —
  // isolates the tier<=max_tier comparison from the allow_servers check (mutation target #1).
  const r = G.validateGrant({ boss: 'build-boss', server: 'serena-lsp', tier: 2 }, baseOpts());
  t('escalation guard: granted server but forced tier(2) > max_tier(0) is denied', r.allowed === false && /exceeds/.test(r.reason));
}
{
  const r = G.validateGrant({ boss: 'search-boss', server: 'context7' }, baseOpts());
  t('tier1 boss (search-boss) CAN get its own tier1 tool (context7)', r.allowed === true);
}
{
  const r = G.validateGrant({ boss: 'search-boss', server: 'playwright', tier: 2 }, baseOpts());
  t('tier1 boss (search-boss) is not granted an ungranted tier2 server', r.allowed === false && /not granted/.test(r.reason));
}

// ---- validateGrant: tier-3 write-primitive path — ALWAYS gated ----
{
  const r = G.validateGrant({ boss: 'search-boss', server: 'github-write', tool: 'push' }, baseOpts());
  t('tier1 boss requesting a tier3 (github-write-like) tool is ALWAYS denied without owner grant', r.allowed === false && r.tier === 3 && /requires per-use owner grant/.test(r.reason));
}
{
  const r = G.validateGrant({ boss: 'ui-boss', server: 'github-write' }, baseOpts());
  t('even a tier2-max boss cannot get tier3 without owner grant', r.allowed === false && r.tier === 3);
}
{
  // WITH a fake owner grant but a hard-gate config that NEVER matches -> still denied (proves classify() is
  // REALLY consulted, not just bypassed by the presence of ownerGrant alone).
  const r = G.validateGrant({ boss: 'search-boss', server: 'github-write' }, { ...baseOpts(), ownerGrant: 'fake-token-1', gatesPath: gatesNeverPath });
  t('owner grant + a hard-gate config that never matches -> STILL denied (real classify() call, no blind bypass)', r.allowed === false && /no matching hard gate/.test(r.reason));
}
{
  // WITH a fake owner grant AND a hard-gate config that always matches -> allowed, and the result carries the
  // REAL matched gate id from that fixture (proves the actual forge-actiongate.classify() call, not a stub).
  const r = G.validateGrant({ boss: 'search-boss', server: 'github-write' }, { ...baseOpts(), ownerGrant: 'fake-token-1', gatesPath: gatesAlwaysPath });
  t('owner grant + a hard-gate config that matches -> allowed, carries the real matched gate id', r.allowed === true && r.gate && r.gate.id === 'test-always-gate');
}
{
  // custom action text still flows through to the real classifier.
  const r = G.validateGrant({ boss: 'search-boss', server: 'github-write' }, { ...baseOpts(), ownerGrant: 'fake-token-1', gatesPath: gatesAlwaysPath, text: 'push commits to origin' });
  t('opts.text is forwarded to the real actiongate classify() call', r.allowed === true && r.gate.matched.includes('test-always-gate'));
}

// ---- validateGrant: opt-in gating ----
{
  const r = G.validateGrant({ boss: 'build-boss', server: 'serena-lsp' }, baseOptsNoOptIn());
  t('a not-opted-in server is unusable even though tier + grant would allow it', r.allowed === false && /not opted-in/.test(r.reason));
}

// ---- validateGrant: identity edge cases ----
{
  const r = G.validateGrant({ boss: 'Build Boss', server: 'serena-lsp' }, baseOpts());
  t('boss id normalizes display-name/case/whitespace forms ("Build Boss" -> "build-boss")', r.allowed === true);
}
{
  const r = G.validateGrant({ boss: 'nonexistent-boss', server: 'serena-lsp' }, baseOpts());
  t('unknown boss is denied, not silently passed', r.allowed === false && /unknown boss/.test(r.reason));
}
{
  const r = G.validateGrant({ boss: 'build-boss', server: 'nonexistent-server' }, baseOpts());
  t('unknown server is denied, not silently passed', r.allowed === false && /unknown mcp server/.test(r.reason));
}
{
  const r = G.validateGrant({ boss: '', server: 'serena-lsp' }, baseOpts());
  t('empty boss is denied', r.allowed === false && /boss is required/.test(r.reason));
}

// ---------------------------------------------------------------------------------------------------------
// 3) planLoad — defer-loading: only relevant + in-tier + granted + opted-in tools come back.
// ---------------------------------------------------------------------------------------------------------
{
  const plan = G.planLoad({ boss: 'search-boss', task: 'look up the api reference documentation for this library' }, baseOpts());
  t('planLoad returns only relevant+in-tier tools for search-boss', plan.tools.length === 1 && plan.tools[0].id === 'context7');
}
{
  const plan = G.planLoad({ boss: 'build-boss', task: 'find the definition of this symbol' }, baseOpts());
  t('planLoad matches build-boss to its serena-lsp (LSP-style keyword)', plan.tools.some((x) => x.id === 'serena-lsp'));
}
{
  const plan = G.planLoad({ boss: 'build-boss', task: 'push this commit and create a release' }, baseOpts());
  t('planLoad surfaces a relevant-but-ungranted tool as native_fallback, not tools', plan.tools.every((x) => x.id !== 'github-write') && plan.native_fallback.some((x) => x.id === 'github-write'));
}
{
  const plan = G.planLoad({ boss: 'build-boss', task: 'write a poem about spring' }, baseOpts());
  t('planLoad returns nothing for an irrelevant task', plan.tools.length === 0 && plan.native_fallback.length === 0);
}
{
  const plan = G.planLoad({ boss: 'ghost-boss', task: 'anything' }, baseOpts());
  t('planLoad for an unknown boss returns empty + reason, does not throw', plan.tools.length === 0 && plan.reason === 'unknown boss');
}
{
  const plan = G.planLoad({ boss: 'build-boss', task: 'find the definition of this symbol' }, baseOptsNoOptIn());
  t('planLoad respects opt-in: a relevant+granted+in-tier but NOT opted-in tool goes to native_fallback', plan.tools.length === 0 && plan.native_fallback.some((x) => x.id === 'serena-lsp' && x.reason === 'not opted-in'));
}

// ---------------------------------------------------------------------------------------------------------
// 4) status — dormancy report.
// ---------------------------------------------------------------------------------------------------------
{
  const s = G.status(baseOpts());
  t('status: 4 fixture servers reported', s.length === 4);
  t('status: nothing is auto-active regardless of opt-in', s.every((x) => x.active === false));
  t('status: opt-in reflected per server', s.find((x) => x.id === 'github-write').opted_in === true);
  t('status: installed flag reflects registry status field', s.every((x) => x.installed === false));
}
{
  const s = G.status(baseOptsNoOptIn());
  t('status: with no opt-in file, everything reports opted_in:false', s.every((x) => x.opted_in === false));
}

// ---------------------------------------------------------------------------------------------------------
// 5) malformed config throws (loadRegistry / loadGrants / loadOptIn).
// ---------------------------------------------------------------------------------------------------------
function throws(fn) { try { fn(); return false; } catch { return true; } }

const badRegistryMissingArray = path.join(TMP, 'bad-registry-1.json');
fs.writeFileSync(badRegistryMissingArray, JSON.stringify({ notServers: [] }));
t('loadRegistry throws when "servers" array is missing', throws(() => G.loadRegistry({ registryPath: badRegistryMissingArray })));

const badRegistryActive = path.join(TMP, 'bad-registry-2.json');
fs.writeFileSync(badRegistryActive, JSON.stringify({ servers: [{ id: 'x', purpose: 'p', tier: 0, status: 'active' }] }));
t('loadRegistry throws when a server ships pre-activated (status:"active")', throws(() => G.loadRegistry({ registryPath: badRegistryActive })));

const badRegistryEntry = path.join(TMP, 'bad-registry-3.json');
fs.writeFileSync(badRegistryEntry, JSON.stringify({ servers: [{ id: 'x' }] }));
t('loadRegistry throws when a server entry is missing tier/status', throws(() => G.loadRegistry({ registryPath: badRegistryEntry })));

const badGrantsMissing = path.join(TMP, 'bad-grants-1.json');
fs.writeFileSync(badGrantsMissing, JSON.stringify({ notBosses: {} }));
t('loadGrants throws when "bosses" object is missing', throws(() => G.loadGrants({ grantsPath: badGrantsMissing })));

const badGrantsEntry = path.join(TMP, 'bad-grants-2.json');
fs.writeFileSync(badGrantsEntry, JSON.stringify({ bosses: { 'build-boss': { allow_servers: ['x'] } } }));
t('loadGrants throws when a boss entry is missing max_tier', throws(() => G.loadGrants({ grantsPath: badGrantsEntry })));

const badOptIn = path.join(TMP, 'bad-optin.json');
fs.writeFileSync(badOptIn, 'not valid json {{{');
t('loadOptIn throws on malformed JSON', throws(() => G.loadOptIn({ optInPath: badOptIn })));

const badOptInShape = path.join(TMP, 'bad-optin-shape.json');
fs.writeFileSync(badOptInShape, JSON.stringify({ wrongKey: [] }));
t('loadOptIn throws when present but wrong shape (no "opted_in" array)', throws(() => G.loadOptIn({ optInPath: badOptInShape })));

t('loadOptIn does NOT throw on a genuinely MISSING file (normal dormant default)', !throws(() => G.loadOptIn({ optInPath: optInNonePath })));
t('loadOptIn missing file resolves to {opted_in: []}', JSON.stringify(G.loadOptIn({ optInPath: optInNonePath })) === JSON.stringify({ opted_in: [] }));

// ---------------------------------------------------------------------------------------------------------
// 6) CLI (spawned, real config — exercises exit codes 0/2/3 end-to-end).
// ---------------------------------------------------------------------------------------------------------
const BIN = path.join(__dirname, 'forge-mcp-gate.cjs');
function run(args) { return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' }); }

{
  const r = run(['registry', '--json']);
  t('CLI registry --json exits 0 and prints a JSON array', r.status === 0 && Array.isArray(JSON.parse(r.stdout)));
}
{
  const r = run(['status', '--json']);
  const parsed = JSON.parse(r.stdout);
  t('CLI status --json exits 0, nothing active, nothing opted-in on real config', r.status === 0 && parsed.every((x) => x.active === false && x.opted_in === false));
}
{
  const r = run(['validate', 'build-boss', 'serena-lsp', 'lsp', '--json']);
  const parsed = JSON.parse(r.stdout);
  t('CLI validate against real (non-opted-in) config exits 3 (denied)', r.status === 3 && parsed.allowed === false);
}
{
  const r = run(['plan', 'build-boss', 'find', 'the', 'definition']);
  t('CLI plan exits 0', r.status === 0);
}
{
  const r = run(['grants', 'not-a-real-boss']);
  t('CLI grants for an unknown boss exits 2', r.status === 2);
}
{
  const r = run([]);
  t('CLI with no command exits 2 (usage error)', r.status === 2);
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
