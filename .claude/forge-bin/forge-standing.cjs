#!/usr/bin/env node
'use strict';
/**
 * forge-standing.cjs — enforceable OWNER standing-rules resolver (2026-07-18, WAVE B / B2). The SINGLE
 * source of truth for reading and matching config/orchestration/FORGE_STANDING_RULES.json — no other file
 * may re-implement scope/trigger matching (same "single source of truth, no parallel logic" discipline
 * forge-actiongate.cjs::classify established for hard-gates.json; a later B4 piece wires forge-core/router
 * to call THIS module's match(), not a re-implementation). Zero-dependency (fs/path only). Advisory, not a
 * hook — this project's governance is light-security (CLAUDE.md: "no mandatory security gates"); a match()
 * result is meant to be INJECTED into a dispatch prompt as "ADVISORY OWNER CONSTRAINTS", never used to
 * silently block a run.
 *
 * MODEL:
 *   load(opts) -> { version, rules:[...] }  — parses + validates the rules file (cached per resolved path).
 *   listActive(opts) -> [rule, ...]         — every rule with status:'active', unfiltered by match context.
 *   match({type, paths, onRequest}, opts) -> { active:[rule,...], shadowed:[{id,topic,beaten_by,reason},...] }
 *
 *   A rule fires when its `trigger` condition is met against the match context:
 *     - trigger:'always'      — fires unconditionally (global standing rule).
 *     - trigger:'domain'      — fires when params.type equals rule.domain (case-insensitive).
 *     - trigger:'glob'        — fires when ANY of params.paths matches rule.glob (zero-dep glob: '**' = any
 *                                depth, '*' = one path segment, '?' = one char; '/' is the segment boundary,
 *                                backslashes are normalized to '/' before matching so Windows paths work).
 *     - trigger:'on-request'  — fires ONLY when params.onRequest is exactly true, or is an array that
 *                                includes the rule's id (never fires passively).
 *
 *   SHADOWING (precedence when >1 fired rule shares the same non-null `topic`): glob(3) > domain(2) >
 *   on-request(2) > always(1) — the highest-ranked rule(s) in a topic group land in `active`, the rest land
 *   in `shadowed` with { id, topic, beaten_by, reason }, so a caller never loses a value silently. A rule
 *   with cannot_override_core:true is treated as an INFINITE rank within its topic group — it can never be
 *   the one shadowed-out, no matter what else fires for that topic (it CAN still coexist with another
 *   equally-infinite core rule; only non-core rules in that topic ever land in `shadowed`). Rules with
 *   topic:null never participate in shadowing — every one of them that fires lands directly in `active`.
 *
 * remember(text, opts) -> rule — WAVE B / B4 (2026-07-18): the ONLY sanctioned path that ever writes a NEW
 *   status:"active" rule into this file. Everything else in Forge (forge-reflect's future distillation, any
 *   automated learning loop) may only STAGE a candidate elsewhere — never write here directly and never
 *   promote a candidate to active on its own (see forge-prefs.cjs::listCandidates()'s parallel STAGE-ONLY
 *   rule for owner-profile prefs). remember() exists specifically so an explicit owner "/forge remember"
 *   command has ONE real, auditable write path: it appends a new rule with source:"owner /forge remember"
 *   (never a fabricated/inferred source) and status:"active" immediately — no staging step, because the
 *   owner typing "/forge remember X" IS the real evidence this rule is grounded in, the same way a verbatim
 *   CLAUDE.md quote grounds a hand-seeded rule. cannot_override_core is ALWAYS false for a remembered rule
 *   (an owner can add a new constraint this way, never mint a new untouchable-core rule — that stays a
 *   hand-seeded, reviewed invariant). Validates the built rule with the exact same shape rules load()
 *   enforces before writing, and refuses (throws, writes nothing) on: empty/whitespace-only text, an unknown
 *   trigger, a domain/glob trigger missing its required field, or a colliding rule id. opts.rulesPath
 *   overrides the default file path (test hermeticity, same seam as load()/match()).
 *
 * CLI:
 *   node forge-standing.cjs match [--type <domain>] [--paths <glob,glob,...>] [--on-request] [--json]
 *   node forge-standing.cjs list [--json]
 *   node forge-standing.cjs remember "<text>" [--scope <scope>] [--trigger <trigger>] [--domain <domain>]
 *     [--glob <glob>] [--topic <topic>] [--id <id>] [--json]
 * Exit codes: match/list: 0 = command ran (regardless of how many rules matched — this is advisory, not a
 * gate) · 2 = usage error or a malformed/unreadable rules file. remember: 0 = rule written · 2 = usage/
 * validation error (nothing written).
 */
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'orchestration', 'FORGE_STANDING_RULES.json');
const KNOWN_TRIGGERS = ['always', 'domain', 'glob', 'on-request'];
const KNOWN_STATUSES = ['active', 'proposed', 'retired'];
const PRECEDENCE = { glob: 3, domain: 2, 'on-request': 2, always: 1 };

let _cache = null; // { path, data } — cached per resolved path within THIS process; tests override via opts.rulesPath
function load(opts) {
  opts = opts || {};
  const p = opts.rulesPath || CONFIG_PATH;
  if (_cache && _cache.path === p) return _cache.data;

  const raw = fs.readFileSync(p, 'utf8');
  let data;
  try { data = JSON.parse(raw); }
  catch (e) { throw new Error('forge-standing: ' + p + ' is not valid JSON: ' + e.message); }

  if (!data || !Array.isArray(data.rules) || data.rules.length === 0) {
    throw new Error('forge-standing: ' + p + ' is missing a non-empty "rules" array');
  }

  const seenIds = new Set();
  for (const r of data.rules) {
    if (!r.id || typeof r.id !== 'string') {
      throw new Error('forge-standing: a rule in ' + p + ' is missing a string "id": ' + JSON.stringify(r));
    }
    if (seenIds.has(r.id)) {
      throw new Error('forge-standing: duplicate rule id "' + r.id + '" in ' + p);
    }
    seenIds.add(r.id);

    if (!r.text || typeof r.text !== 'string') {
      throw new Error('forge-standing: rule "' + r.id + '" is missing "text" in ' + p);
    }
    if (!r.source || typeof r.source !== 'string') {
      throw new Error('forge-standing: rule "' + r.id + '" is missing a "source" (every rule must carry real evidence) in ' + p);
    }
    if (!r.scope || typeof r.scope !== 'string') {
      throw new Error('forge-standing: rule "' + r.id + '" is missing "scope" in ' + p);
    }
    if (!KNOWN_TRIGGERS.includes(r.trigger)) {
      throw new Error('forge-standing: rule "' + r.id + '" has unknown trigger "' + r.trigger + '" (must be one of ' + KNOWN_TRIGGERS.join(', ') + ') in ' + p);
    }
    if (!KNOWN_STATUSES.includes(r.status)) {
      throw new Error('forge-standing: rule "' + r.id + '" has unknown status "' + r.status + '" (must be one of ' + KNOWN_STATUSES.join(', ') + ') in ' + p);
    }
    if (r.trigger === 'domain' && (!r.domain || typeof r.domain !== 'string')) {
      throw new Error('forge-standing: rule "' + r.id + '" has trigger:"domain" but no "domain" string in ' + p);
    }
    if (r.trigger === 'glob' && (!r.glob || typeof r.glob !== 'string')) {
      throw new Error('forge-standing: rule "' + r.id + '" has trigger:"glob" but no "glob" string in ' + p);
    }
  }

  _cache = { path: p, data };
  return data;
}

function listActive(opts) {
  const { rules } = load(opts);
  return rules.filter((r) => r.status === 'active');
}

/** globToRegExp — zero-dep glob compiler. '**' matches any depth (including '/'), '*' matches within one
 *  path segment, '?' matches one non-'/' char. Everything else is regex-escaped literally. Case-insensitive
 *  and normalizes '\' to '/' before compiling so Windows-style glob text still matches forward-slash paths. */
function globToRegExp(glob) {
  const norm = String(glob).replace(/\\/g, '/');
  let out = '';
  for (let i = 0; i < norm.length; i++) {
    const c = norm[i];
    if (c === '*') {
      if (norm[i + 1] === '*') { out += '.*'; i++; }
      else out += '[^/]*';
    } else if (c === '?') {
      out += '[^/]';
    } else if ('.+^${}()|[]\\'.indexOf(c) !== -1) {
      out += '\\' + c;
    } else {
      out += c;
    }
  }
  return new RegExp('^' + out + '$', 'i');
}

function pathMatchesGlob(candidatePath, glob) {
  if (!candidatePath || !glob) return false;
  const re = globToRegExp(glob);
  return re.test(String(candidatePath).replace(/\\/g, '/'));
}

function ruleFires(rule, ctx) {
  if (rule.trigger === 'always') return true;
  if (rule.trigger === 'domain') {
    return !!(ctx.type && rule.domain && String(rule.domain).toLowerCase() === String(ctx.type).toLowerCase());
  }
  if (rule.trigger === 'glob') {
    return ctx.paths.some((p) => pathMatchesGlob(p, rule.glob));
  }
  if (rule.trigger === 'on-request') {
    if (ctx.onRequest === true) return true;
    if (Array.isArray(ctx.onRequest)) return ctx.onRequest.includes(rule.id);
    return false;
  }
  return false;
}

function rank(rule) {
  if (rule.cannot_override_core) return Infinity;
  return PRECEDENCE[rule.trigger] || 0;
}

function match(params, opts) {
  params = params || {};
  const ctx = {
    type: params.type || null,
    paths: Array.isArray(params.paths) ? params.paths : (params.paths ? [params.paths] : []),
    onRequest: params.onRequest,
  };

  const fired = listActive(opts).filter((r) => ruleFires(r, ctx));

  const byTopic = new Map();
  const active = [];

  for (const r of fired) {
    if (!r.topic) { active.push(r); continue; }
    if (!byTopic.has(r.topic)) byTopic.set(r.topic, []);
    byTopic.get(r.topic).push(r);
  }

  const shadowed = [];
  for (const [topic, group] of byTopic) {
    const maxRank = Math.max(...group.map(rank));
    const winners = group.filter((r) => rank(r) === maxRank);
    const winnerIds = winners.map((r) => r.id);
    for (const r of group) {
      if (winnerIds.includes(r.id)) {
        active.push(r);
      } else {
        shadowed.push({
          id: r.id,
          topic,
          beaten_by: winnerIds[0],
          reason: 'lower-precedence (' + r.trigger + ') than ' + winners[0].trigger + ' for topic "' + topic + '"',
        });
      }
    }
  }

  return { active, shadowed };
}

/** remember(text, opts) -> the newly-written rule object — see file header for the full contract. Fail-closed:
 *  validates BEFORE writing (mirrors load()'s own per-rule checks), so an invalid call never partially writes
 *  or corrupts the rules file. Bypasses the module's read cache on write (invalidates it for this exact path)
 *  so an immediately-following load()/match() call on the same path sees the new rule, not a stale cache hit. */
function remember(text, opts) {
  opts = opts || {};
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('forge-standing: remember requires non-empty "text" (the rule content)');
  }
  const rulesPath = opts.rulesPath || CONFIG_PATH;

  let raw;
  try { raw = fs.readFileSync(rulesPath, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') throw new Error('forge-standing: remember requires an existing rules file at ' + rulesPath + ' (never creates one from scratch)');
    throw new Error('forge-standing: remember could not read ' + rulesPath + ': ' + e.message);
  }
  let data;
  try { data = JSON.parse(raw); }
  catch (e) { throw new Error('forge-standing: remember: ' + rulesPath + ' is not valid JSON: ' + e.message); }
  if (!data || !Array.isArray(data.rules)) {
    throw new Error('forge-standing: remember: ' + rulesPath + ' is missing a "rules" array');
  }

  const trigger = opts.trigger || 'always';
  if (!KNOWN_TRIGGERS.includes(trigger)) {
    throw new Error('forge-standing: remember: unknown trigger "' + trigger + '" (must be one of ' + KNOWN_TRIGGERS.join(', ') + ')');
  }
  if (trigger === 'domain' && (!opts.domain || typeof opts.domain !== 'string')) {
    throw new Error('forge-standing: remember: trigger "domain" requires a non-empty --domain');
  }
  if (trigger === 'glob' && (!opts.glob || typeof opts.glob !== 'string')) {
    throw new Error('forge-standing: remember: trigger "glob" requires a non-empty --glob');
  }

  const id = opts.id || ('owner-remember-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8));
  if (data.rules.some((r) => r.id === id)) {
    throw new Error('forge-standing: remember: rule id "' + id + '" already exists in ' + rulesPath);
  }

  const rule = {
    id,
    text: text.trim(),
    scope: opts.scope || 'global',
    trigger,
    domain: trigger === 'domain' ? opts.domain : null,
    glob: trigger === 'glob' ? opts.glob : null,
    topic: opts.topic || null,
    source: 'owner /forge remember',
    confidence: 'high',
    status: 'active',
    // NEVER settable via remember() — minting a new untouchable-core rule stays a hand-seeded, reviewed
    // invariant, not something a single owner command can create in one step.
    cannot_override_core: false,
    notes: opts.notes || null,
  };

  const nextData = Object.assign({}, data, { rules: data.rules.concat([rule]) });
  fs.writeFileSync(rulesPath, JSON.stringify(nextData, null, 2) + '\n', 'utf8');
  if (_cache && _cache.path === rulesPath) _cache = null; // invalidate so the next load()/match() sees the write

  return rule;
}

module.exports = { load, listActive, match, remember, globToRegExp, pathMatchesGlob, ruleFires, rank, KNOWN_TRIGGERS, KNOWN_STATUSES, PRECEDENCE, CONFIG_PATH };

// ---- CLI ----
function parseArgs(argv) {
  const cmd = argv[0] || null;
  const rest = argv.slice(1);
  const opts = { cmd, type: null, paths: [], onRequest: false, json: false, scope: null, trigger: null, domain: null, glob: null, topic: null, id: null, positional: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--type') opts.type = rest[++i];
    else if (a === '--paths') opts.paths = (rest[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--on-request') opts.onRequest = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--scope') opts.scope = rest[++i];
    else if (a === '--trigger') opts.trigger = rest[++i];
    else if (a === '--domain') opts.domain = rest[++i];
    else if (a === '--glob') opts.glob = rest[++i];
    else if (a === '--topic') opts.topic = rest[++i];
    else if (a === '--id') opts.id = rest[++i];
    else opts.positional.push(a);
  }
  return opts;
}
function printUsage() {
  console.error('Usage: node forge-standing.cjs match [--type <domain>] [--paths <glob,glob,...>] [--on-request] [--json]');
  console.error('       node forge-standing.cjs list [--json]');
  console.error('       node forge-standing.cjs remember "<text>" [--scope <scope>] [--trigger <trigger>] [--domain <domain>] [--glob <glob>] [--topic <topic>] [--id <id>] [--json]');
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  try {
    if (opts.cmd === 'match') {
      const result = match({ type: opts.type, paths: opts.paths, onRequest: opts.onRequest }, {});
      if (opts.json) {
        console.log(JSON.stringify(result));
      } else {
        console.log('active (' + result.active.length + '):');
        for (const r of result.active) console.log('  ' + r.id + '\t[' + r.scope + ']\t' + r.text);
        console.log('shadowed (' + result.shadowed.length + '):');
        for (const s of result.shadowed) console.log('  ' + s.id + '\tbeaten_by=' + s.beaten_by + '\t' + s.reason);
      }
      process.exitCode = 0;
    } else if (opts.cmd === 'list') {
      const list = listActive({});
      if (opts.json) console.log(JSON.stringify(list));
      else for (const r of list) console.log(r.id + '\t[' + r.scope + ']\t' + r.text);
      process.exitCode = 0;
    } else if (opts.cmd === 'remember') {
      const text = opts.positional[0];
      if (!text) { console.error('forge-standing: remember requires "<text>"'); process.exitCode = 2; }
      else {
        // FORGE_STANDING_RULES_PATH: a test-hermeticity seam (same convention as forge-prefs.cjs's
        // FORGE_OWNER_PROFILE / forge-verify.cjs's FORGE_STORE_ROOT) — unset in normal owner use, so the CLI
        // writes the real config/orchestration/FORGE_STANDING_RULES.json by default.
        const rememberOpts = { scope: opts.scope, trigger: opts.trigger, domain: opts.domain, glob: opts.glob, topic: opts.topic, id: opts.id };
        if (process.env.FORGE_STANDING_RULES_PATH) rememberOpts.rulesPath = process.env.FORGE_STANDING_RULES_PATH;
        const rule = remember(text, rememberOpts);
        if (opts.json) console.log(JSON.stringify(rule));
        else console.log('REMEMBERED ' + rule.id + ' — ' + rule.text);
        process.exitCode = 0;
      }
    } else {
      printUsage();
      process.exitCode = 2;
    }
  } catch (e) {
    console.error('forge-standing: ' + e.message);
    process.exitCode = 2;
  }
}
