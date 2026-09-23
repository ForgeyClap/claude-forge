#!/usr/bin/env node
'use strict';
/**
 * forge-mcp-gate.cjs — MCP least-privilege REGISTRY + VALIDATOR + PLANNER (WAVE G1, 2026-07-19). The
 * enforcement core for the safety doctrine in scratchpad/forge-ecosystem-w2.json: Forge's zero-dependency
 * default stays 100% intact — this module NEVER installs, connects to, or activates any MCP server. It only
 * (1) catalogs known servers + their capability tier, (2) enforces a per-Boss least-privilege allow-list,
 * and (3) plans which tool ids are relevant to a task within a Boss's tier (defer-loading — never load every
 * schema). A server is usable ONLY if the owner has explicitly opted it in (config/orchestration/mcp-opt-in.json,
 * owner-authored, NOT shipped by Forge) AND the requesting Boss's tier + allow-list covers it. Absent/not
 * opted-in => native fallback, logged honestly (event mcp_native_fallback — see EVENT_TYPES below).
 *
 * NOTE — deliberately named forge-mcp-gate.cjs, NOT forge-mcp.cjs: that filename is already a real, tested,
 * wired-in module (a read-only MCP *server* exposing this project's own Forge run-state, required by
 * forge-bench.cjs). This file is unrelated (an MCP *client-side* gate for Bosses consuming EXTERNAL MCP
 * servers) and must not collide with or overwrite it.
 *
 * TIERS (least-privilege, doctrine #2): 0 = read-only LOCAL (docs/LSP read) · 1 = read-only REMOTE (web
 * search, docs fetch, GitHub READ) · 2 = SANDBOXED action (browser-QA drive, no persistent writes) ·
 * 3 = WRITE-PRIMITIVE (any mcp write: GitHub write, file write, deploy, publish).
 *
 * TIER-3 IS NEVER A STANDING GRANT (doctrine #3/#4): config/orchestration/mcp-grants.json never lists a
 * tier-3 server for any Boss. A tier-3 request is always a separate, per-use, owner-approved exception:
 * without opts.ownerGrant it is denied outright; WITH opts.ownerGrant it still ALWAYS calls the real
 * forge-actiongate.cjs::classify() (the existing hard-gate, reused — not duplicated) against the described
 * action text, and is allowed ONLY if that classifier genuinely confirms a matching hard gate — exactly the
 * same STOP-and-confirm mechanism deploy/git-push/spend already use. This can never be bypassed by editing
 * mcp-grants.json alone.
 *
 * MODEL:
 *   loadRegistry(opts) -> { servers:[...] } from mcp-registry.json (opts.registryPath override).
 *   loadGrants(opts)   -> { bosses:{...} } from mcp-grants.json (opts.grantsPath override).
 *   loadOptIn(opts)    -> { opted_in:[...] } from mcp-opt-in.json (opts.optInPath override); MISSING file is
 *                         a normal dormant default ({opted_in:[]}) — a MALFORMED file throws.
 *   validateGrant({ boss, server, tool, tier }, opts) -> { allowed, tier, reason }.
 *     opts.ownerGrant  — per-use owner-approval token, required (but not sufficient alone) for tier-3.
 *     opts.text        — the real action description forwarded to actiongate.classify() for a tier-3 request
 *                         (defaults to a generic constructed sentence when omitted — safe-closed by default).
 *     opts.gatesPath / opts.projectRoot — forwarded to forge-actiongate.classify() (test hermeticity).
 *   planLoad({ task, boss }, opts) -> { boss, task, tools:[{id,tier,purpose}], native_fallback:[...] } —
 *     ONLY the tool ids relevant to the task text (keyword match), already filtered to the boss's granted +
 *     opted-in + in-tier servers (defer-loading — never return the whole registry).
 *   status(opts) -> per server { id, tier, installed, opted_in, active:false } — active is ALWAYS false;
 *     loadRegistry() itself hard-errors if any registry entry ever ships with status:"active".
 *
 * EVENT_TYPES (declared here for Head Chef/G-integrate to wire into forge-dashboard/log-event.cjs — this
 * file does NOT call log-event.cjs itself, per the shared-file rule for this wave):
 *   mcp_grant_validated — a validateGrant() call resolved allowed:true.
 *   mcp_grant_denied    — a validateGrant() call resolved allowed:false.
 *   mcp_tool_loaded     — a planLoad() tool entry was actually used by a Boss.
 *   mcp_native_fallback — a relevant tool was NOT usable (not opted-in / above tier / not granted) and the
 *                         Boss fell back to its native Claude runtime instead.
 *
 * CLI:
 *   node forge-mcp-gate.cjs registry [--json]
 *   node forge-mcp-gate.cjs grants <boss> [--json]
 *   node forge-mcp-gate.cjs validate <boss> <server> [tool] [--tier N] [--owner-grant <token>]
 *                                    [--text "<action>"] [--json]
 *   node forge-mcp-gate.cjs status [--json]
 *   node forge-mcp-gate.cjs plan <boss> "<task>" [--json]
 * Exit codes: 0 = ok/allowed · 3 = validate denied (mirrors forge-actiongate's gate=3 convention) ·
 * 2 = usage/config error.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const actiongate = require('./forge-actiongate.cjs');

/** verifyOwnerGrant(token, opts) -> {ok, reason, source} — AUDIT FIX 2026-08-03.
 *  A tier-3 (write-primitive) grant used to be ANY truthy value supplied by the same caller that
 *  wanted the write. It is now matched against a secret only the owner can write: the env var
 *  FORGE_MCP_OWNER_GRANT, or .claude/config/forge-mcp-owner-grant.txt under the project root. Forge
 *  never generates this secret — a secret the system could mint would authorise the system to itself.
 *  No secret configured => refused (a missing lock is not an open door). Mirrors forge-genesis.cjs's
 *  ownerApprovalSecret()/tokenMatches() deliberately, so there is ONE approval convention to learn. */
const MCP_GRANT_SECRET_REL = path.join('.claude', 'config', 'forge-mcp-owner-grant.txt');
function ownerGrantSecret(opts) {
  opts = opts || {};
  const env = opts.env || process.env;
  const root = opts.projectRoot ? path.resolve(opts.projectRoot) : path.resolve(__dirname, '..', '..');
  const p = path.join(root, MCP_GRANT_SECRET_REL);
  // ENV IS NOT AN OWNER CHANNEL (broad Codex audit #8, fixed 2026-08-05): the process requesting a
  // tier-3 write can set FORGE_MCP_OWNER_GRANT itself, which turned this verification into a mirror.
  // File only; `allowEnv` is a deliberate test seam, off in every production caller.
  const fromEnv = opts.allowEnv === true && typeof env.FORGE_MCP_OWNER_GRANT === 'string' ? env.FORGE_MCP_OWNER_GRANT.trim() : '';
  if (fromEnv) return { value: fromEnv, path: p, source: 'env' };
  try {
    const fromFile = fs.readFileSync(p, 'utf8').trim();
    if (fromFile) return { value: fromFile, path: p, source: 'file' };
  } catch { /* absent — reported below */ }
  return { value: null, path: p, source: 'none' };
}
function verifyOwnerGrant(token, opts) {
  const secret = ownerGrantSecret(opts);
  if (!secret.value) {
    return { ok: false, reason: 'no owner grant secret is configured — write one to ' + secret.path + ' so a grant can be VERIFIED instead of assumed (an environment variable does not count: the process requesting the write can set it)' };
  }
  if (typeof token !== 'string' || !token.trim()) {
    return { ok: false, reason: 'owner grant must be an explicit, non-empty token' };
  }
  const a = crypto.createHash('sha256').update(String(token)).digest();
  const b = crypto.createHash('sha256').update(String(secret.value)).digest();
  if (!crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'the supplied owner grant token does not match the owner grant secret' };
  }
  return { ok: true, reason: 'owner grant verified (' + secret.source + ')', source: secret.source };
}

const REGISTRY_PATH = path.join(__dirname, '..', 'config', 'orchestration', 'mcp-registry.json');
const GRANTS_PATH = path.join(__dirname, '..', 'config', 'orchestration', 'mcp-grants.json');
const OPTIN_PATH = path.join(__dirname, '..', 'config', 'orchestration', 'mcp-opt-in.json'); // owner-authored, optional — dormant by default

const EVENT_TYPES = ['mcp_grant_validated', 'mcp_grant_denied', 'mcp_tool_loaded', 'mcp_native_fallback'];

let _regCache = null; // { path, data } — cached across calls in the SAME process; tests override via opts.registryPath
function loadRegistry(opts) {
  opts = opts || {};
  const p = opts.registryPath || REGISTRY_PATH;
  if (_regCache && _regCache.path === p) return _regCache.data;
  const raw = fs.readFileSync(p, 'utf8');
  const data = JSON.parse(raw);
  if (!data || !Array.isArray(data.servers) || data.servers.length === 0) {
    throw new Error('forge-mcp-gate: ' + p + ' is missing a non-empty "servers" array');
  }
  for (const s of data.servers) {
    if (!s.id || typeof s.tier !== 'number' || !s.status) {
      throw new Error('forge-mcp-gate: server entry missing id/tier/status in ' + p + ': ' + JSON.stringify(s));
    }
    if (s.status === 'active') {
      throw new Error('forge-mcp-gate: server "' + s.id + '" has status "active" in the registry — the registry must NEVER ship pre-activated; use the owner-authored opt-in file instead');
    }
  }
  _regCache = { path: p, data };
  return data;
}

let _grantsCache = null;
function loadGrants(opts) {
  opts = opts || {};
  const p = opts.grantsPath || GRANTS_PATH;
  if (_grantsCache && _grantsCache.path === p) return _grantsCache.data;
  const raw = fs.readFileSync(p, 'utf8');
  const data = JSON.parse(raw);
  if (!data || !data.bosses || typeof data.bosses !== 'object' || Array.isArray(data.bosses)) {
    throw new Error('forge-mcp-gate: ' + p + ' is missing a non-empty "bosses" object');
  }
  for (const [id, g] of Object.entries(data.bosses)) {
    if (typeof g.max_tier !== 'number' || !Array.isArray(g.allow_servers)) {
      throw new Error('forge-mcp-gate: boss "' + id + '" grant missing max_tier/allow_servers in ' + p);
    }
  }
  _grantsCache = { path: p, data };
  return data;
}

let _optInCache = null;
function loadOptIn(opts) {
  opts = opts || {};
  const p = opts.optInPath || OPTIN_PATH;
  if (_optInCache && _optInCache.path === p) return _optInCache.data;
  let data = { opted_in: [] };
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.opted_in)) throw new Error('forge-mcp-gate: ' + p + ' must be {"opted_in": [...]}');
    data = parsed;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e; // a MISSING opt-in file is the normal dormant default; a MALFORMED one is a hard error
  }
  _optInCache = { path: p, data };
  return data;
}

// Normalize a Boss identifier to its registry slug (mirrors nvidia-provider.cjs::normAgent so the same
// display-name / case / whitespace forms work everywhere): "Boss"/"  boss "/"Build Boss" -> "boss"/"build-boss".
function normBoss(boss) {
  if (boss == null) return null;
  const s = String(boss).trim().toLowerCase();
  if (!s) return null;
  return s.replace(/\s+/g, '-');
}

function defaultActionText(serverId, tool, bossSlug) {
  return 'mcp write-primitive tool "' + (tool || serverId) + '" on server "' + serverId + '" requested by boss "' + bossSlug + '"';
}

/** validateGrant — see file header for the full contract. Never throws for a normal decision; throws only
 *  on malformed/missing config (loadRegistry/loadGrants/loadOptIn), matching the sibling gate files' posture. */
function validateGrant(params, opts) {
  params = params || {};
  opts = opts || {};
  const registry = loadRegistry(opts);
  const grants = loadGrants(opts);
  const optIn = loadOptIn(opts);

  const bossSlug = normBoss(params.boss);
  if (!bossSlug) return { allowed: false, tier: typeof params.tier === 'number' ? params.tier : null, reason: 'boss is required' };

  const serverId = params.server;
  const serverEntry = registry.servers.find((s) => s.id === serverId);
  if (!serverEntry) return { allowed: false, tier: typeof params.tier === 'number' ? params.tier : null, reason: 'unknown mcp server "' + serverId + '"' };

  // TIER COMES FROM THE REGISTRY (fix 2026-08-05, broad Codex audit finding #7). This used to prefer a
  // CALLER-SUPPLIED tier, so the party asking for permission decided which rules applied to it: calling
  // validateGrant({server:'github-write', tier:0}) on a registry tier-3 server skipped the entire tier-3
  // owner-verification branch below. A caller may still RAISE the tier (that is how an escalation probe
  // asks "would tier 2 be allowed for this?"), but it can never LOWER it — the effective tier is the max
  // of what the registry says and what the caller claims, and a non-integer registry tier is refused
  // outright rather than silently treated as 0.
  const registryTier = serverEntry.tier;
  if (!Number.isInteger(registryTier) || registryTier < 0 || registryTier > 3) {
    return { allowed: false, tier: null, reason: 'server "' + serverId + '" has an invalid registry tier (' + JSON.stringify(registryTier) + ') — refusing rather than guessing' };
  }
  const claimed = typeof params.tier === 'number' && Number.isInteger(params.tier) ? params.tier : registryTier;
  const tier = Math.max(registryTier, claimed);

  const bossGrant = grants.bosses[bossSlug];
  if (!bossGrant) return { allowed: false, tier, reason: 'unknown boss "' + params.boss + '"' };

  const isOptedIn = Array.isArray(optIn.opted_in) && optIn.opted_in.includes(serverId);
  if (!isOptedIn) return { allowed: false, tier, reason: 'server "' + serverId + '" is not opted-in (dormant by default) — native fallback required' };

  // Tier 3 (WRITE-PRIMITIVE) is NEVER a standing grant — always a separate, per-use, owner-approved
  // exception verified live through the real forge-actiongate.cjs classifier, regardless of max_tier/
  // allow_servers for this boss (doctrine #3/#4). This branch is intentionally reached BEFORE the
  // standard tier<=max_tier / allow_servers check below so a tier-3 request can never slip through it.
  if (tier === 3) {
    if (!opts.ownerGrant) {
      return { allowed: false, tier, reason: 'write-primitive: requires per-use owner grant via hard-gate' };
    }
    // AUDIT FIX (2026-08-03): BOTH halves of this gate used to come from the party asking for
    // permission — `ownerGrant` was any truthy value, and the text handed to the classifier was
    // free-form caller input. `{ ownerGrant: 'x', text: 'deploy to production' }` therefore produced
    // ALLOWED for whatever the caller actually meant to do. The grant is now verified against a secret
    // only the OWNER writes, and the caller's text can only ADD to the canonical action description.
    const grantCheck = verifyOwnerGrant(opts.ownerGrant, opts);
    if (!grantCheck.ok) {
      return { allowed: false, tier, reason: 'write-primitive: ' + grantCheck.reason };
    }
    const gateOpts = {};
    if (opts.gatesPath) gateOpts.configPath = opts.gatesPath;
    if (opts.projectRoot) gateOpts.projectRoot = opts.projectRoot;
    // The canonical description (server/tool/boss) is ALWAYS classified; caller text is appended as
    // extra context, never a replacement — a benign-sounding string can no longer hide the real action.
    const canonical = defaultActionText(serverId, params.tool, bossSlug);
    const extra = typeof opts.text === 'string' && opts.text.trim() ? ' — ' + opts.text.trim() : '';
    const text = canonical + extra;
    const classified = actiongate.classify(text, gateOpts);
    if (classified.gate) {
      return { allowed: true, tier, reason: 'owner-granted write-primitive confirmed via hard gate "' + classified.id + '" (' + classified.reason + ')', gate: classified, classifiedText: text };
    }
    return { allowed: false, tier, reason: 'owner grant verified but forge-actiongate found no matching hard gate for this action — describe the real action via opts.text so it can be verified; it stays blocked otherwise', gate: classified, classifiedText: text };
  }

  // Tiers 0-2 — standard least-privilege standing-grant check: BOTH must hold independently.
  if (!bossGrant.allow_servers.includes(serverId)) {
    return { allowed: false, tier, reason: 'boss "' + bossSlug + '" is not granted server "' + serverId + '"' };
  }
  if (tier > bossGrant.max_tier) {
    return { allowed: false, tier, reason: 'tier ' + tier + ' exceeds boss "' + bossSlug + '" max_tier ' + bossGrant.max_tier };
  }
  return { allowed: true, tier, reason: 'boss "' + bossSlug + '" is granted server "' + serverId + '" at tier ' + tier + ' (max_tier ' + bossGrant.max_tier + ')' };
}

// Keyword hints per server id, used ONLY for defer-loading relevance matching in planLoad() — not a
// classifier, just a cheap substring match so a task never pulls in the whole registry's tool schemas.
const KEYWORD_MAP = {
  context7: ['doc', 'docs', 'documentation', 'api reference', 'library'],
  playwright: ['browser', 'e2e', 'playwright', 'click through', 'ui test', 'end-to-end'],
  'chrome-devtools': ['devtools', 'performance trace', 'console log', 'network trace', 'lighthouse'],
  'github-read': ['github', 'pull request', ' pr ', 'issue', 'repo'],
  'github-write': ['push', 'commit', 'merge', 'create pr', 'release'],
  exa: ['search', 'research', 'find sources', 'web search'],
  firecrawl: ['scrape', 'crawl', 'fetch page', 'extract page'],
  'serena-lsp': ['definition', 'references', 'symbol', 'refactor', 'go to def'],
};

/** planLoad — defer-loading: return only the server ids relevant to task text, already filtered to the
 *  boss's granted + opted-in + in-tier servers. Never throws for an unknown boss (returns an empty plan with
 *  a reason) — a Head Chef caller should be able to plan-probe any boss id without a hard failure. */
function planLoad(input, opts) {
  input = input || {};
  opts = opts || {};
  const registry = loadRegistry(opts);
  const grants = loadGrants(opts);
  const optIn = loadOptIn(opts);

  const bossSlug = normBoss(input.boss);
  const bossGrant = bossSlug && grants.bosses[bossSlug];
  const task = String(input.task || '').toLowerCase();
  const tools = [];
  const nativeFallback = [];

  if (!bossGrant) return { boss: input.boss || null, task: input.task || '', tools, native_fallback: nativeFallback, reason: 'unknown boss' };

  for (const server of registry.servers) {
    const kws = KEYWORD_MAP[server.id] || [server.id];
    const relevant = kws.some((k) => task.includes(k));
    if (!relevant) continue;
    const inTier = server.tier <= bossGrant.max_tier;
    const granted = bossGrant.allow_servers.includes(server.id);
    const isOptedIn = Array.isArray(optIn.opted_in) && optIn.opted_in.includes(server.id);
    if (inTier && granted && isOptedIn) {
      tools.push({ id: server.id, tier: server.tier, purpose: server.purpose });
    } else {
      nativeFallback.push({ id: server.id, tier: server.tier, reason: !granted ? 'not granted to boss' : (!inTier ? 'above boss max_tier' : 'not opted-in') });
    }
  }
  return { boss: bossSlug, task: input.task || '', tools, native_fallback: nativeFallback };
}

/** status — per-server dormancy report. `active` is ALWAYS false: Forge itself never activates a server;
 *  loadRegistry() already hard-errors if a registry entry ever ships pre-activated (status:"active"), so an
 *  "active without opt-in" state can never reach this function in the first place — the assertion lives at
 *  load time, not read time, exactly like a doctor check would want it caught. */
function status(opts) {
  opts = opts || {};
  const registry = loadRegistry(opts);
  const optIn = loadOptIn(opts);
  return registry.servers.map((s) => ({
    id: s.id,
    tier: s.tier,
    installed: s.status !== 'not-installed',
    opted_in: Array.isArray(optIn.opted_in) && optIn.opted_in.includes(s.id),
    active: false,
  }));
}

/** discoverConfiguredServers(opts) -> [{id, source}] — every MCP server this machine is ACTUALLY
 *  configured to connect, read from the places Claude Code really reads:
 *    1. <project>/.mcp.json                          → mcpServers keys
 *    2. <project>/.claude/settings.json | .local.json → mcpServers keys + enabledMcpjsonServers names
 *    3. ~/.claude.json                                → global mcpServers + this project's entry
 *    4. ~/.claude/settings.json                       → mcpServers + enabledMcpjsonServers
 *  Read-only, never throws: an unreadable/absent source is simply not a source.
 *
 *  WHY THIS EXISTS (audit sweep 2026-08-03, acted on 2026-08-04): mcp-registry.json calls itself "the
 *  authoritative server catalog", and every one of its 8 entries is `not-installed`. Meanwhile this
 *  machine really had claude-flow (≈400 tools incl. terminal_execute/http_fetch), n8n, and claude.ai
 *  connectors connected — none of them in the registry. The tier-3 write gate therefore governed only
 *  servers that do not exist here, while the ones that do exist fell outside the doctrine entirely.
 *  A catalog that cannot notice reality drifting away from it is a document, not a control. */
function discoverConfiguredServers(opts) {
  opts = opts || {};
  const out = [];
  const seen = new Set();
  const add = (id, source) => {
    const key = String(id);
    if (!key || seen.has(key + '|' + source)) return;
    seen.add(key + '|' + source);
    out.push({ id: key, source });
  };
  // UNREADABLE IS NOT EMPTY (broad Codex audit #28, fixed 2026-08-05). Every source was read with a
  // catch-all that turned a malformed or permission-denied config into `null`, i.e. into "this machine
  // configures no servers" — so the drift check reported CLEAN precisely when it could not see. A file
  // that exists but cannot be parsed is now recorded as an unreadable source and surfaces in the result.
  const unreadable = [];
  const readJson = (p, label) => {
    if (!fs.existsSync(p)) return null; // genuinely absent: nothing to read, nothing to report
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch (e) { unreadable.push({ source: label, path: p, error: e.message }); return null; }
  };
  const harvest = (obj, source) => {
    if (!obj || typeof obj !== 'object') return;
    if (obj.mcpServers && typeof obj.mcpServers === 'object') Object.keys(obj.mcpServers).forEach((k) => add(k, source));
    if (Array.isArray(obj.enabledMcpjsonServers)) obj.enabledMcpjsonServers.forEach((k) => add(k, source));
  };
  const projectRoot = opts.projectRoot ? path.resolve(opts.projectRoot) : path.resolve(__dirname, '..', '..');
  const home = opts.homeDir ? path.resolve(opts.homeDir) : require('os').homedir();

  harvest(readJson(path.join(projectRoot, '.mcp.json'), '.mcp.json'), '.mcp.json');
  harvest(readJson(path.join(projectRoot, '.claude', 'settings.json'), '.claude/settings.json'), '.claude/settings.json');
  harvest(readJson(path.join(projectRoot, '.claude', 'settings.local.json'), '.claude/settings.local.json'), '.claude/settings.local.json');
  harvest(readJson(path.join(home, '.claude', 'settings.json'), '~/.claude/settings.json'), '~/.claude/settings.json');

  const globalCfg = readJson(path.join(home, '.claude.json'), '~/.claude.json');
  if (globalCfg) {
    harvest(globalCfg, '~/.claude.json');
    const projects = globalCfg.projects && typeof globalCfg.projects === 'object' ? globalCfg.projects : {};
    for (const key of Object.keys(projects)) {
      if (path.resolve(key) === projectRoot) harvest(projects[key], '~/.claude.json (this project)');
    }
  }
  out.unreadableSources = unreadable; // carried on the array so callers can see what could NOT be read
  return out;
}

/** unregisteredServers(opts) -> {ok, unregistered:[{id, sources}], configured, known} — the drift check.
 *  ok:false means at least one server this machine is configured to connect is absent from the registry,
 *  i.e. it is governed by NO tier and NO per-Boss grant. Reported, never auto-added: silently inventing a
 *  tier for someone else's server would be exactly the fabricated-authority problem this guards against. */
function unregisteredServers(opts) {
  opts = opts || {};
  const known = new Set(loadRegistry(opts).servers.map((s) => s.id));
  const configured = discoverConfiguredServers(opts);
  const byId = new Map();
  for (const c of configured) {
    if (known.has(c.id)) continue;
    if (!byId.has(c.id)) byId.set(c.id, { id: c.id, sources: [] });
    byId.get(c.id).sources.push(c.source);
  }
  const unregistered = Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
  // An UNREADABLE source is not a clean bill of health (audit #28): if a config exists but cannot be
  // parsed, this check simply could not see what it is meant to see, so it is not ok.
  const unreadable = Array.isArray(configured.unreadableSources) ? configured.unreadableSources : [];
  if (unreadable.length) {
    return {
      ok: false, unregistered, unreadable,
      configured: configured.map((c) => c.id).filter((v, i, a) => a.indexOf(v) === i).sort(),
      known: Array.from(known).sort(),
      reason: unreadable.length + ' MCP config source(s) exist but could NOT be read, so this check is blind rather than clean: '
        + unreadable.map((u) => u.source + ' (' + u.error + ')').join('; ')
        + (unregistered.length ? ' · plus ' + unregistered.length + ' unregistered server(s)' : ''),
    };
  }
  return {
    ok: unregistered.length === 0,
    unreadable,
    unregistered,
    configured: configured.map((c) => c.id).filter((v, i, a) => a.indexOf(v) === i).sort(),
    known: Array.from(known).sort(),
    reason: unregistered.length
      ? unregistered.length + ' configured MCP server(s) are absent from the registry, so no tier and no per-Boss grant governs them: '
        + unregistered.map((u) => u.id + ' (' + u.sources.join(', ') + ')').join('; ')
      : 'every configured MCP server is present in the registry',
  };
}

module.exports = {
  loadRegistry, loadGrants, loadOptIn, validateGrant, planLoad, status, normBoss,
  discoverConfiguredServers, unregisteredServers,
  EVENT_TYPES, REGISTRY_PATH, GRANTS_PATH, OPTIN_PATH,
};

// ---- CLI ----
function parseArgs(argv) {
  const cmd = argv[0] || null;
  const rest = argv.slice(1);
  const opts = { cmd, tier: null, ownerGrant: null, text: null, json: false, positional: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--tier') opts.tier = Number(rest[++i]);
    else if (a === '--owner-grant') opts.ownerGrant = rest[++i];
    else if (a === '--text') opts.text = rest[++i];
    else if (a === '--json') opts.json = true;
    else opts.positional.push(a);
  }
  return opts;
}
function printUsage() {
  console.error('Usage: node forge-mcp-gate.cjs registry [--json]');
  console.error('       node forge-mcp-gate.cjs grants <boss> [--json]');
  console.error('       node forge-mcp-gate.cjs validate <boss> <server> [tool] [--tier N] [--owner-grant <token>] [--text "<action>"] [--json]');
  console.error('       node forge-mcp-gate.cjs status [--json]');
  console.error('       node forge-mcp-gate.cjs plan <boss> "<task>" [--json]');
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  try {
    if (opts.cmd === 'registry') {
      const data = loadRegistry({});
      if (opts.json) console.log(JSON.stringify(data.servers));
      else for (const s of data.servers) console.log(s.id + '\ttier=' + s.tier + '\t' + s.status + '\t' + s.purpose);
      process.exitCode = 0;
    } else if (opts.cmd === 'grants') {
      const boss = opts.positional[0];
      const data = loadGrants({});
      const g = boss ? data.bosses[normBoss(boss)] : data.bosses;
      if (boss && !g) { console.error('forge-mcp-gate: unknown boss "' + boss + '"'); process.exitCode = 2; }
      else { console.log(JSON.stringify(g, null, opts.json ? 0 : 2)); process.exitCode = 0; }
    } else if (opts.cmd === 'validate') {
      const [boss, server, tool] = opts.positional;
      const vOpts = {};
      if (opts.ownerGrant) vOpts.ownerGrant = opts.ownerGrant;
      if (opts.text) vOpts.text = opts.text;
      const result = validateGrant({ boss, server, tool, tier: Number.isFinite(opts.tier) ? opts.tier : undefined }, vOpts);
      if (opts.json) console.log(JSON.stringify(result));
      else console.log((result.allowed ? 'ALLOWED' : 'DENIED') + ' [tier ' + result.tier + '] — ' + result.reason);
      process.exitCode = result.allowed ? 0 : 3;
    } else if (opts.cmd === 'status') {
      const data = status({});
      if (opts.json) console.log(JSON.stringify(data));
      else for (const s of data) console.log(s.id + '\ttier=' + s.tier + '\tinstalled=' + s.installed + '\topted_in=' + s.opted_in + '\tactive=' + s.active);
      process.exitCode = 0;
    } else if (opts.cmd === 'plan') {
      const [boss] = opts.positional;
      const task = opts.positional.slice(1).join(' ');
      const data = planLoad({ boss, task }, {});
      if (opts.json) console.log(JSON.stringify(data));
      else { console.log('plan for ' + data.boss + ': ' + (data.tools.map((t) => t.id).join(', ') || '(none relevant)')); if (data.native_fallback.length) console.log('native fallback: ' + data.native_fallback.map((t) => t.id).join(', ')); }
      process.exitCode = 0;
    } else {
      printUsage();
      process.exitCode = 2;
    }
  } catch (e) {
    console.error('forge-mcp-gate: ' + e.message);
    process.exitCode = 2;
  }
}
