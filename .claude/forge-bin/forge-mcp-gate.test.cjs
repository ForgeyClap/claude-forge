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
// CORRECTED 2026-08-04 (audit follow-up). This used to assert `status === 'not-installed'` for EVERY
// entry, which quietly encoded "the registry only ever lists servers that do not exist here" — and that
// assumption is precisely what let the registry stay blind while claude-flow and n8n were really
// connected and governed by no tier at all. The safety property was never "nothing is installed"; it is
// **nothing is pre-ACTIVATED** (loadRegistry hard-errors on status:"active" for the same reason).
// A registry that may record reality can be checked against reality; one that may not, cannot.
t('no registry entry is ever pre-ACTIVATED (the real dormancy invariant)',
  realRegistry.servers.every((s) => s.status !== 'active' && s.active !== true));
t('an entry that records a REAL connected server still grants nothing by itself (status is reality, not permission)',
  realRegistry.servers.filter((s) => s.status === 'connected').every((s) => G.status({}).find((x) => x.id === s.id).active === false));
t('the registry has NOT drifted away from what this machine actually configures',
  G.unregisteredServers({}).ok === true, JSON.stringify(G.unregisteredServers({}).unregistered));
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

// ============================================================================================
// WP-L3 (2026-09-24, dormant opt-in MCP registry entries) — n8n-mcp (czlonkowski/n8n-mcp, MIT) added as a
// new tier-1 entry; playwright (microsoft/playwright-mcp, Apache-2.0) already existed at tier 2 and only
// gained a clarified notes field. Both came out of the beginner-sweep scout vetting (wp-l2).
// ============================================================================================
{
  const REQUIRED_SHAPE = (e) => !!e && typeof e.id === 'string' && typeof e.purpose === 'string'
    && Number.isInteger(e.tier) && typeof e.network === 'string' && typeof e.credentials_needed === 'boolean'
    && typeof e.install_hint === 'string' && typeof e.status === 'string' && typeof e.notes === 'string';

  const n8nMcp = realRegistry.servers.find((s) => s.id === 'n8n-mcp');
  t('registry has a new "n8n-mcp" entry (czlonkowski/n8n-mcp)', !!n8nMcp);
  t('n8n-mcp entry matches the standard registry entry shape', REQUIRED_SHAPE(n8nMcp));
  t('n8n-mcp is tier 1 (read-only docs/validation, matches the scout verdict)', n8nMcp && n8nMcp.tier === 1);
  t('n8n-mcp needs no credentials (docs-only mode per its README)', n8nMcp && n8nMcp.credentials_needed === false);
  t('n8n-mcp ships dormant (status not-installed)', n8nMcp && n8nMcp.status === 'not-installed');
  t('n8n-mcp install_hint explicitly excludes the live N8N_API_URL/KEY escalation', n8nMcp && /N8N_API_URL/.test(n8nMcp.install_hint) && /higher-tier/.test(n8nMcp.install_hint));

  const pw = realRegistry.servers.find((s) => s.id === 'playwright');
  t('playwright entry (microsoft/playwright-mcp) still matches the standard shape', REQUIRED_SHAPE(pw));
  t('playwright stays tier 2 (sandboxed browser QA, not bumped to a write-primitive)', pw && pw.tier === 2);
  t('playwright notes route write-shaped browser actions through forge-actiongate.cjs, never assume the tier-2 grant covers them', pw && /forge-actiongate\.cjs/.test(pw.notes));

  t('integration-boss is granted n8n-mcp within its existing max_tier (1, not raised)',
    realGrants.bosses['integration-boss'].allow_servers.includes('n8n-mcp') && realGrants.bosses['integration-boss'].max_tier === 1);
  t('build-boss (max_tier 0) is correctly NOT granted n8n-mcp (tier 1 exceeds its max_tier)',
    !realGrants.bosses['build-boss'].allow_servers.includes('n8n-mcp') && realGrants.bosses['build-boss'].max_tier === 0);
  t('no max_tier was raised for any Boss by this change (still the documented defaults)',
    realGrants.bosses['build-boss'].max_tier === 0 && realGrants.bosses['integration-boss'].max_tier === 1
    && realGrants.bosses['test-boss'].max_tier === 2 && realGrants.bosses['ui-boss'].max_tier === 2);

  t('doctrine: every real registry entry is not-installed, except the two documented REAL-connected exceptions (each tier 3, never a standing grant)',
    realRegistry.servers.every((s) => s.status === 'not-installed' || (s.status === 'connected' && s.tier === 3)));

  t('n8n-mcp resolves as NOT installed/enabled via status() (dormant by default, no auto-opt-in)', (() => {
    const s = G.status({}).find((x) => x.id === 'n8n-mcp');
    return !!s && s.installed === false && s.opted_in === false && s.active === false;
  })());
}

// ---- wp-l3: validateGrant() refuses n8n-mcp/playwright for a Boss not listed, or above its own tier ----
{
  const nRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-gate-wpl3-'));
  const nRegistryPath = path.join(nRoot, 'mcp-registry.json');
  const nGrantsPath = path.join(nRoot, 'mcp-grants.json');
  const nOptInPath = path.join(nRoot, 'mcp-opt-in.json');
  fs.writeFileSync(nRegistryPath, JSON.stringify({
    servers: [
      { id: 'n8n-mcp', purpose: 'n8n node docs + workflow validation', tier: 1, network: 'read', credentials_needed: false, install_hint: 'x', status: 'not-installed', notes: 'x' },
      { id: 'playwright', purpose: 'browser QA drive', tier: 2, network: 'read-write', credentials_needed: false, install_hint: 'x', status: 'not-installed', notes: 'x' },
    ],
  }));
  fs.writeFileSync(nGrantsPath, JSON.stringify({
    bosses: {
      'integration-boss': { max_tier: 1, allow_servers: ['n8n-mcp'], why: 'fixture' },
      'build-boss': { max_tier: 0, allow_servers: [], why: 'fixture: not listed for n8n-mcp' },
      'ui-boss': { max_tier: 2, allow_servers: ['playwright'], why: 'fixture' },
      'test-boss': { max_tier: 0, allow_servers: ['playwright'], why: 'fixture: listed but BELOW playwright\'s own tier, to isolate the tier check from the allow-list check' },
    },
  }));
  fs.writeFileSync(nOptInPath, JSON.stringify({ opted_in: ['n8n-mcp', 'playwright'] }));
  const nOpts = () => ({ registryPath: nRegistryPath, grantsPath: nGrantsPath, optInPath: nOptInPath });

  {
    const r = G.validateGrant({ boss: 'integration-boss', server: 'n8n-mcp' }, nOpts());
    t('n8n-mcp: integration-boss (listed, in-tier) IS allowed', r.allowed === true, r.reason);
  }
  {
    const r = G.validateGrant({ boss: 'build-boss', server: 'n8n-mcp' }, nOpts());
    t('n8n-mcp: a Boss NOT on its allow-list is refused ("not granted")', r.allowed === false && /not granted/.test(r.reason), r.reason);
  }
  {
    const r = G.validateGrant({ boss: 'test-boss', server: 'playwright' }, nOpts());
    t('playwright: a Boss listed but ABOVE its own max_tier is refused ("exceeds")', r.allowed === false && /exceeds/.test(r.reason), r.reason);
  }
  {
    const r = G.validateGrant({ boss: 'ui-boss', server: 'playwright' }, nOpts());
    t('playwright: a Boss within tier and on the allow-list IS allowed', r.allowed === true, r.reason);
  }
}

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
// AUDIT FIX (2026-08-03): a tier-3 owner grant is now VERIFIED against an owner-written secret, so a
// fixture exercising the real write-primitive path must plant that secret first — exactly like a real
// owner would. Fixtures asserting a REFUSAL deliberately do not call this.
const grantRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-gate-grant-'));
fs.mkdirSync(path.join(grantRoot, '.claude', 'config'), { recursive: true });
fs.writeFileSync(path.join(grantRoot, '.claude', 'config', 'forge-mcp-owner-grant.txt'), 'FIXTURE-OWNER-GRANT\n', 'utf8');
const ownerGrantOpts = () => ({ ownerGrant: 'FIXTURE-OWNER-GRANT', projectRoot: grantRoot, env: {} });
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
  const r = G.validateGrant({ boss: 'search-boss', server: 'github-write' }, { ...baseOpts(), ...ownerGrantOpts(), gatesPath: gatesNeverPath });
  t('owner grant + a hard-gate config that never matches -> STILL denied (real classify() call, no blind bypass)', r.allowed === false && /no matching hard gate/.test(r.reason));
}
{
  // WITH a fake owner grant AND a hard-gate config that always matches -> allowed, and the result carries the
  // REAL matched gate id from that fixture (proves the actual forge-actiongate.classify() call, not a stub).
  const r = G.validateGrant({ boss: 'search-boss', server: 'github-write' }, { ...baseOpts(), ...ownerGrantOpts(), gatesPath: gatesAlwaysPath });
  t('owner grant + a hard-gate config that matches -> allowed, carries the real matched gate id', r.allowed === true && r.gate && r.gate.id === 'test-always-gate');
}
{
  // custom action text still flows through to the real classifier.
  const r = G.validateGrant({ boss: 'search-boss', server: 'github-write' }, { ...baseOpts(), ...ownerGrantOpts(), gatesPath: gatesAlwaysPath, text: 'push commits to origin' });
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

// ============================================================================================
// TIER-3 GRANT MUST BE VERIFIABLE, AND THE CLASSIFIED TEXT MUST CARRY THE REAL ACTION
// (audit sweep, 2026-08-03). MEASURED DEFECT: both halves of the write-primitive gate were supplied
// by the party asking for permission. `opts.ownerGrant` was any truthy value, and the text handed to
// the hard-gate classifier was free-form caller input — so
//   validateGrant({...}, { ownerGrant: 'x', text: 'deploy to production' })
// produced ALLOWED for whatever the caller actually intended to do. The grant is now checked against
// an owner-controlled secret, and the caller's text can only ADD to the canonical action description,
// never replace it.
// ============================================================================================
{
  const secretRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-gate-secret-'));
  const secretPath = path.join(secretRoot, '.claude', 'config', 'forge-mcp-owner-grant.txt');
  fs.mkdirSync(path.dirname(secretPath), { recursive: true });
  fs.writeFileSync(secretPath, 'REAL-OWNER-GRANT\n', 'utf8');
  const withSecret = (extra) => ({ ...baseOpts(), gatesPath: gatesAlwaysPath, projectRoot: secretRoot, env: {}, ...extra });

  {
    const r = G.validateGrant({ boss: 'search-boss', server: 'github-write' }, withSecret({ ownerGrant: 'guessed' }));
    t('T3a an arbitrary truthy ownerGrant is NO LONGER accepted (self-granted write is refused)', r.allowed === false, r.reason);
    t('T3a the refusal names the unverifiable grant, not a missing gate', /grant/i.test(r.reason || ''), r.reason);
  }
  {
    const r = G.validateGrant({ boss: 'search-boss', server: 'github-write' }, withSecret({ ownerGrant: 'REAL-OWNER-GRANT' }));
    t('T3b the token matching the owner secret IS accepted (happy path intact)', r.allowed === true, r.reason);
  }
  {
    // no secret configured anywhere -> refuse rather than fall back to "any string is fine"
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-gate-nosecret-'));
    const r = G.validateGrant({ boss: 'search-boss', server: 'github-write' }, { ...baseOpts(), gatesPath: gatesAlwaysPath, projectRoot: bare, env: {}, ownerGrant: 'anything' });
    t('T3c with NO owner grant secret configured the write-primitive stays blocked', r.allowed === false, r.reason);
  }
  {
    // the caller's text may add context, but the canonical action (server/tool/boss) is always classified too
    const r = G.validateGrant({ boss: 'search-boss', server: 'github-write', tool: 'create_pull_request' },
      withSecret({ ownerGrant: 'REAL-OWNER-GRANT', text: 'harmless sounding text' }));
    t('T3d the classified text still contains the REAL action identity, not only the caller string',
      r.allowed === true && typeof r.classifiedText === 'string'
      && r.classifiedText.includes('github-write') && r.classifiedText.includes('create_pull_request')
      && r.classifiedText.includes('harmless sounding text'), r.classifiedText);
  }
}

// ============================================================================================
// REGISTRY-DRIFT DETECTION (audit sweep 2026-08-03, built 2026-08-04).
// MEASURED DEFECT: mcp-registry.json calls itself "the authoritative server catalog" and every one of
// its 8 entries is `not-installed` — while this machine really had claude-flow (≈400 tools, incl.
// terminal_execute/http_fetch) and n8n connected, neither of them in the registry. The tier-3 write
// gate hardened the day before therefore governed only servers that do not exist here, while the ones
// that DO exist fell outside the doctrine entirely. A catalog that cannot notice reality drifting away
// from it is a document, not a control — so the drift is now detectable, and reported, never auto-added.
// ============================================================================================
{
  const dRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-discover-'));
  fs.mkdirSync(path.join(dRoot, '.claude'), { recursive: true });
  const dHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-home-'));
  fs.mkdirSync(path.join(dHome, '.claude'), { recursive: true });

  fs.writeFileSync(path.join(dRoot, '.mcp.json'), JSON.stringify({ mcpServers: { 'from-mcp-json': {} } }));
  fs.writeFileSync(path.join(dRoot, '.claude', 'settings.local.json'), JSON.stringify({ enabledMcpjsonServers: ['from-settings-local'] }));
  fs.writeFileSync(path.join(dHome, '.claude.json'), JSON.stringify({
    mcpServers: { 'from-global': {} },
    projects: { [dRoot]: { mcpServers: { 'from-project-entry': {} } }, 'C:/some/other/project': { mcpServers: { 'other-project-only': {} } } },
  }));
  const dOpts = { projectRoot: dRoot, homeDir: dHome, registryPath, grantsPath, optInPath: optInAllPath };

  {
    const ids = G.discoverConfiguredServers(dOpts).map((s) => s.id).sort();
    t('D1 discovery reads .mcp.json, settings.local.json, global mcpServers AND this project\'s entry',
      ids.includes('from-mcp-json') && ids.includes('from-settings-local') && ids.includes('from-global') && ids.includes('from-project-entry'), ids.join(','));
    t('D1 another project\'s servers are NOT attributed to this project', !ids.includes('other-project-only'), ids.join(','));
  }
  {
    const found = G.discoverConfiguredServers(dOpts).find((s) => s.id === 'from-settings-local');
    t('D2 each discovered server carries the source it came from (so a finding is actionable)',
      !!found && /settings\.local\.json/.test(found.source), found && found.source);
  }
  {
    const r = G.unregisteredServers(dOpts);
    t('D3 a configured server absent from the registry is reported as UNREGISTERED', r.ok === false && r.unregistered.length === 4, JSON.stringify(r.unregistered.map((u) => u.id)));
    t('D3 the reason names the servers and says they are governed by no tier/grant',
      /no tier and no per-Boss grant/.test(r.reason) && /from-global/.test(r.reason), r.reason);
    t('D3 nothing is auto-added to the registry (reported, never invented)',
      G.loadRegistry(dOpts).servers.every((s) => !String(s.id).startsWith('from-')));
  }
  {
    // a registry that DOES know the configured server -> clean
    const regPath2 = path.join(dRoot, 'registry-complete.json');
    fs.writeFileSync(regPath2, JSON.stringify({ servers: [
      { id: 'from-mcp-json', purpose: 'x', tier: 1, network: 'read', credentials_needed: false, install_hint: 'x', status: 'not-installed', notes: '' },
      { id: 'from-settings-local', purpose: 'x', tier: 1, network: 'read', credentials_needed: false, install_hint: 'x', status: 'not-installed', notes: '' },
      { id: 'from-global', purpose: 'x', tier: 1, network: 'read', credentials_needed: false, install_hint: 'x', status: 'not-installed', notes: '' },
      { id: 'from-project-entry', purpose: 'x', tier: 1, network: 'read', credentials_needed: false, install_hint: 'x', status: 'not-installed', notes: '' },
    ] }));
    const r = G.unregisteredServers({ ...dOpts, registryPath: regPath2 });
    t('D4 when the registry knows every configured server the check is clean', r.ok === true && r.unregistered.length === 0, r.reason);
  }
  {
    // no config sources at all -> honest empty, never a crash
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-bare-'));
    const r = G.unregisteredServers({ projectRoot: bare, homeDir: bare, registryPath, grantsPath, optInPath: optInAllPath });
    t('D5 a machine with no MCP config at all is clean, not a crash', r.ok === true && r.configured.length === 0);
  }
}

// ============================================================================================
// THE REQUESTER MAY NOT CHOOSE WHICH RULES APPLY TO IT (broad Codex audit #7, fixed 2026-08-05).
// validateGrant used to PREFER a caller-supplied `tier`, so passing tier:0 for a registry tier-3 server
// skipped the whole tier-3 owner-verification branch — the party asking for write access decided it was
// not a write. The registry is now the floor; a caller may only raise.
// ============================================================================================
{
  const r = G.validateGrant({ boss: 'search-boss', server: 'github-write', tier: 0 }, baseOpts());
  t('T7 a caller cannot DOWNGRADE a registry tier-3 server to tier 0 to dodge the write gate',
    r.allowed === false && r.tier === 3, 'tier=' + r.tier + ' allowed=' + r.allowed);
  t('T7 the refusal is the tier-3 owner-grant path, not a lucky miss elsewhere',
    /owner grant|write-primitive/i.test(r.reason || ''), r.reason);
}
{
  // raising still works (an escalation probe asking "would tier 2 be allowed here?")
  const r = G.validateGrant({ boss: 'build-boss', server: 'serena-lsp', tier: 2 }, baseOpts());
  t('T7 a caller may still RAISE the tier (escalation probe intact)', r.allowed === false && /exceeds/.test(r.reason));
}
{
  const badReg = path.join(TMP, 'registry-bad-tier.json');
  fs.writeFileSync(badReg, JSON.stringify({ servers: [{ id: 'weird', purpose: 'x', tier: '3', network: 'read', credentials_needed: false, install_hint: 'x', status: 'not-installed', notes: '' }] }));
  let threwOrRefused = false;
  try {
    const r = G.validateGrant({ boss: 'search-boss', server: 'weird' }, { ...baseOpts(), registryPath: badReg });
    threwOrRefused = r.allowed === false;
  } catch { threwOrRefused = true; } // loadRegistry hard-rejects a non-number tier — also acceptable
  t('T7 a non-integer registry tier is refused, never silently treated as 0', threwOrRefused);
}

// ============================================================================================
// UNREADABLE IS NOT EMPTY (broad Codex audit #28, fixed 2026-08-05). Every config source was read with
// a catch-all that turned a malformed/permission-denied file into `null` — i.e. into "no servers
// configured" — so the drift check reported CLEAN exactly when it could not see. And the env channel
// for the tier-3 owner grant was settable by the very process requesting the write (#8).
// ============================================================================================
{
  const uRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-unreadable-'));
  fs.mkdirSync(path.join(uRoot, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(uRoot, '.mcp.json'), '{ "mcpServers": {  '); // truncated on purpose
  const uHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-unreadable-home-'));
  const r = G.unregisteredServers({ projectRoot: uRoot, homeDir: uHome, registryPath, grantsPath, optInPath: optInAllPath });
  t('U1 a config that exists but cannot be parsed makes the check NOT ok (blind, not clean)', r.ok === false, r.reason);
  t('U1 the unreadable source is named so the finding is actionable', Array.isArray(r.unreadable) && r.unreadable.length === 1 && /\.mcp\.json/.test(r.unreadable[0].source), JSON.stringify(r.unreadable));
  t('U1 the reason says it is blind rather than clean', /blind rather than clean/.test(r.reason || ''), r.reason);

  const okRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-absent-'));
  const r2 = G.unregisteredServers({ projectRoot: okRoot, homeDir: uHome, registryPath, grantsPath, optInPath: optInAllPath });
  t('U2 a genuinely ABSENT config is still clean (absent != unreadable)', r2.ok === true && (r2.unreadable || []).length === 0, r2.reason);
}
{
  // #8: an env-only owner grant must no longer authorise a tier-3 write
  const envOnly = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-envonly-'));
  const r = G.validateGrant({ boss: 'search-boss', server: 'github-write' },
    { ...baseOpts(), gatesPath: gatesAlwaysPath, projectRoot: envOnly, env: { FORGE_MCP_OWNER_GRANT: 'self-chosen' }, ownerGrant: 'self-chosen' });
  t('U3 an env-supplied owner grant alone does NOT authorise a write-primitive', r.allowed === false, r.reason);
  const r2 = G.validateGrant({ boss: 'search-boss', server: 'github-write' },
    { ...baseOpts(), gatesPath: gatesAlwaysPath, projectRoot: envOnly, env: { FORGE_MCP_OWNER_GRANT: 'self-chosen' }, ownerGrant: 'self-chosen', allowEnv: true });
  t('U3 the explicit test seam still exercises the env path', r2.allowed === true, r2.reason);
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
