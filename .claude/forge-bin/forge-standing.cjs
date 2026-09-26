#!/usr/bin/env node
'use strict';
/**
 * forge-standing.cjs — enforceable OWNER standing-rules resolver (2026-07-18, WAVE B / B2; TEMPLATE/USER
 * SPLIT added 2026-09-26, external audit N4/P1). The SINGLE source of truth for reading and matching
 * config/orchestration/FORGE_STANDING_RULES.json + FORGE_STANDING_RULES.user.json — no other file may
 * re-implement scope/trigger matching (same "single source of truth, no parallel logic" discipline
 * forge-actiongate.cjs::classify established for hard-gates.json; a later B4 piece wires forge-core/router
 * to call THIS module's match(), not a re-implementation). Zero-dependency (fs/path only). Advisory, not a
 * hook — this project's governance is light-security (CLAUDE.md: "no mandatory security gates"); a match()
 * result is meant to be INJECTED into a dispatch prompt as "ADVISORY OWNER CONSTRAINTS", never used to
 * silently block a run.
 *
 * TEMPLATE vs USER SPLIT (2026-09-26 fix for N4, P1 privacy finding) — read this before touching the write
 * path. The external fresh-laptop audit found the SHIPPED FORGE_STANDING_RULES.json carrying a maintainer's
 * own "/forge remember" rule (an instruction about the maintainer's private Codex account), sent to every
 * fresh install. Root cause: remember() used to write directly into the file forge-sync.cjs treats as
 * TEMPLATE-OWNED (synced/overwritten from the product template on every update). The structural fix:
 *   - FORGE_STANDING_RULES.json  (CONFIG_PATH)      — PRODUCT rules only. Ships with the template. Every
 *     rule here must be grounded in evidence that ALSO ships with the product (this project's own CLAUDE.md,
 *     a shipped skill/command file, the Bash tool's own Git Safety Protocol) — never a citation to a file
 *     that does not exist on a fresh install (an unshipped global policy file, a scratch /goal transcript).
 *   - FORGE_STANDING_RULES.user.json (USER_CONFIG_PATH) — OWNER-ADDED rules only. Never shipped, never in
 *     forge-sync.cjs's SYSTEM list, never overwritten/deleted by a template sync (see that file's own
 *     comment next to the SYSTEM array for the matching note). remember() writes ONLY here now.
 *   - load()/listActive()/match() transparently MERGE both files (template rules + user rules) so every
 *     existing caller keeps seeing the full active rule set with zero call-site changes.
 *   - MIGRATION: the first load() call against a given (templatePath, userPath) pair that finds a rule in
 *     the TEMPLATE file whose source is exactly OWNER_REMEMBER_SOURCE ("owner /forge remember" — the one
 *     marker remember() has always stamped) MOVES it (not copies-and-keeps) into the user file and rewrites
 *     the template file without it. This is what heals an already-affected install (this project's own
 *     copy included) without a human editing JSON by hand. The move is computed in memory first and the
 *     disk write is best-effort (wrapped in try/catch) — a transient write failure never makes the rule
 *     vanish from match()/listActive() for this read; it is simply retried on the next load().
 *
 * MODEL:
 *   load(opts) -> { version, rules:[...] }  — parses + validates + merges the template and user rules files
 *     (cached per resolved (templatePath, userPath) pair within THIS process).
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
 *   status:"active" rule, and (since the 2026-09-26 split) it writes EXCLUSIVELY into the USER file, never
 *   the shipped template. Everything else in Forge (forge-reflect's future distillation, any automated
 *   learning loop) may only STAGE a candidate elsewhere — never write here directly and never promote a
 *   candidate to active on its own (see forge-prefs.cjs::listCandidates()'s parallel STAGE-ONLY rule for
 *   owner-profile prefs). remember() exists specifically so an explicit owner "/forge remember" command has
 *   ONE real, auditable write path: it appends a new rule with source:"owner /forge remember" (never a
 *   fabricated/inferred source) and status:"active" IMMEDIATELY — no staging step, because the owner typing
 *   "/forge remember X" IS the real evidence this rule is grounded in, the same way a verbatim CLAUDE.md
 *   quote grounds a hand-seeded rule. This "active immediately, no staging" behavior was re-reviewed against
 *   the 2026-09-26 audit's Part V-G side-effect note and kept ON PURPOSE (documented here, not silently
 *   glossed over): the harmful part of the old behavior was WHERE it activated (the shipped template, now
 *   fixed), not WHEN. cannot_override_core is ALWAYS false for a remembered rule (an owner can add a new
 *   constraint this way, never mint a new untouchable-core rule — that stays a hand-seeded, reviewed
 *   invariant). Validates the built rule with the same shape load() enforces before writing, and refuses
 *   (throws, writes nothing) on: empty/whitespace-only text, an unknown trigger, a domain/glob trigger
 *   missing its required field, or a colliding rule id (checked against the user file's own entries, and —
 *   best-effort, never a hard requirement — against the shipped template's ids too, so a typo'd --id can
 *   never silently mask a product rule). opts.userRulesPath overrides the default user-file path (test
 *   hermeticity, same seam as load()/match()); opts.rulesPath still lets a caller point the (best-effort)
 *   template id-collision check at a fixture instead of the real shipped file.
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
// USER_CONFIG_PATH — owner-added state. NEVER add this filename to forge-sync.cjs's SYSTEM/SYSTEM_GLOB
// list: it must never be synced from, or overwritten/deleted by, the product template. See forge-sync.cjs's
// own comment next to SYSTEM for the matching note.
const USER_CONFIG_PATH = path.join(__dirname, '..', 'config', 'orchestration', 'FORGE_STANDING_RULES.user.json');
const OWNER_REMEMBER_SOURCE = 'owner /forge remember';
const KNOWN_TRIGGERS = ['always', 'domain', 'glob', 'on-request'];
const KNOWN_STATUSES = ['active', 'proposed', 'retired'];
const PRECEDENCE = { glob: 3, domain: 2, 'on-request': 2, always: 1 };

function defaultUserDoc() {
  return {
    _doc: 'Forge V2 — OWNER-ADDED standing rules (2026-09-26 split, N4/P1 fix). NEVER shipped, NEVER ' +
      'overwritten or deleted by forge-sync.cjs (not in its SYSTEM/SYSTEM_GLOB list) — this is the ' +
      'owner’s own project-local state, not product template state. Populated ONLY by an explicit ' +
      'owner "/forge remember" command (forge-standing.cjs::remember()) or by the one-time migration that ' +
      'moves an owner-added rule out of the shipped FORGE_STANDING_RULES.json when one is found there (see ' +
      'that file’s own _doc). Read together with the shipped file by forge-standing.cjs::load()/' +
      'match()/listActive() — no other tool reads or writes this file. Safe to delete: it is recreated ' +
      'empty on the next "/forge remember".',
    version: 1,
    rules: [],
  };
}

function resolveUserPath(opts) {
  opts = opts || {};
  if (opts.userRulesPath) return opts.userRulesPath;
  if (process.env.FORGE_STANDING_RULES_USER_PATH) return process.env.FORGE_STANDING_RULES_USER_PATH;
  // v2.8.0 (Lead, post-merge): a caller that points at a DIFFERENT template (another project's rules, a test
  // fixture) gets THAT template's sibling user file — never this install's own owner rules. Without this, the
  // owner's private rules leaked into every other rules file Forge read (found by forge-echo/forge-audit-loop
  // counting one rule too many once a real FORGE_STANDING_RULES.user.json existed).
  if (opts.rulesPath) return String(opts.rulesPath).replace(/\.json$/i, '') + '.user.json';
  return USER_CONFIG_PATH;
}

/** validateRulesArray — the exact per-rule checks load() has always enforced, extracted so both the
 *  template file and the user file are held to the same fail-closed shape. Throws on the first problem
 *  found (never silently drops/fixes a bad rule). `seenIds` lets a caller run this across TWO files and
 *  still catch a cross-file duplicate id. */
function validateRulesArray(rules, filePath, seenIds) {
  seenIds = seenIds || new Set();
  for (const r of rules) {
    if (!r.id || typeof r.id !== 'string') {
      throw new Error('forge-standing: a rule in ' + filePath + ' is missing a string "id": ' + JSON.stringify(r));
    }
    if (seenIds.has(r.id)) {
      throw new Error('forge-standing: duplicate rule id "' + r.id + '" (checked across the template and user rules files)');
    }
    seenIds.add(r.id);

    if (!r.text || typeof r.text !== 'string') {
      throw new Error('forge-standing: rule "' + r.id + '" is missing "text" in ' + filePath);
    }
    if (!r.source || typeof r.source !== 'string') {
      throw new Error('forge-standing: rule "' + r.id + '" is missing a "source" (every rule must carry real evidence) in ' + filePath);
    }
    if (!r.scope || typeof r.scope !== 'string') {
      throw new Error('forge-standing: rule "' + r.id + '" is missing "scope" in ' + filePath);
    }
    if (!KNOWN_TRIGGERS.includes(r.trigger)) {
      throw new Error('forge-standing: rule "' + r.id + '" has unknown trigger "' + r.trigger + '" (must be one of ' + KNOWN_TRIGGERS.join(', ') + ') in ' + filePath);
    }
    if (!KNOWN_STATUSES.includes(r.status)) {
      throw new Error('forge-standing: rule "' + r.id + '" has unknown status "' + r.status + '" (must be one of ' + KNOWN_STATUSES.join(', ') + ') in ' + filePath);
    }
    if (r.trigger === 'domain' && (!r.domain || typeof r.domain !== 'string')) {
      throw new Error('forge-standing: rule "' + r.id + '" has trigger:"domain" but no "domain" string in ' + filePath);
    }
    if (r.trigger === 'glob' && (!r.glob || typeof r.glob !== 'string')) {
      throw new Error('forge-standing: rule "' + r.id + '" has trigger:"glob" but no "glob" string in ' + filePath);
    }
  }
  return seenIds;
}

/** readRulesDoc(p, {required}) -> parsed {_doc?, version, rules} or null (only when !required and the file
 *  is missing). A present-but-malformed file (bad JSON, wrong top-level shape) always throws — same
 *  fail-closed posture the rest of this module uses. */
function readRulesDoc(p, opts) {
  opts = opts || {};
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT' && !opts.required) return null;
    // Keep the fs error CODE on the rethrown error: callers (forge-audit-loop's MEMORY-INTEGRITY check) tell
    // "missing / fresh project" (medium) from "unreadable or corrupt" (high) by e.code === 'ENOENT'.
    const wrapped = new Error(e.code === 'ENOENT' ? 'forge-standing: ' + p + ' does not exist' : 'forge-standing: could not read ' + p + ': ' + e.message);
    wrapped.code = e.code;
    throw wrapped;
  }
  let data;
  try { data = JSON.parse(raw); }
  catch (e) { throw new Error('forge-standing: ' + p + ' is not valid JSON: ' + e.message); }
  if (!data || !Array.isArray(data.rules)) {
    throw new Error('forge-standing: ' + p + ' is missing a "rules" array');
  }
  if (opts.required && data.rules.length === 0) {
    throw new Error('forge-standing: ' + p + ' is missing a non-empty "rules" array');
  }
  return data;
}

/** migrateOwnerRules — moves (never copies-and-keeps) every template rule whose source is exactly
 *  OWNER_REMEMBER_SOURCE into the user doc. Computed in memory unconditionally; the disk write is
 *  best-effort so a transient I/O failure never makes an owner rule vanish from THIS read (it is simply
 *  retried on the next load()). Returns { templateRules, userDoc } — both reflecting the post-migration
 *  state regardless of whether the write actually landed on disk. */
function migrateOwnerRules(templateData, templatePath, userPath) {
  const toMigrate = templateData.rules.filter((r) => r.source === OWNER_REMEMBER_SOURCE);
  if (toMigrate.length === 0) {
    return { templateRules: templateData.rules, userDoc: readRulesDoc(userPath) || defaultUserDoc() };
  }

  let userDoc = readRulesDoc(userPath) || defaultUserDoc();
  const existingIds = new Set(userDoc.rules.map((r) => r.id));
  const toAppend = toMigrate.filter((r) => !existingIds.has(r.id));
  userDoc = Object.assign({}, userDoc, { rules: userDoc.rules.concat(toAppend) });

  const templateRules = templateData.rules.filter((r) => r.source !== OWNER_REMEMBER_SOURCE);
  const cleanedTemplate = Object.assign({}, templateData, { rules: templateRules });

  try {
    fs.mkdirSync(path.dirname(userPath), { recursive: true });
    fs.writeFileSync(userPath, JSON.stringify(userDoc, null, 2) + '\n', 'utf8');
    fs.writeFileSync(templatePath, JSON.stringify(cleanedTemplate, null, 2) + '\n', 'utf8');
  } catch (e) {
    // Best-effort: the in-memory result below still reflects the migrated state for THIS read even if the
    // disk write failed (permission/lock/read-only fs) — never silently lose the rule, never crash load().
    console.error('forge-standing: could not persist the owner-rule migration (' + e.message + ') — retrying on next load()');
  }

  return { templateRules, userDoc };
}

let _cache = null; // { key, data } — cached per resolved (templatePath, userPath) pair within THIS process
function load(opts) {
  opts = opts || {};
  const templatePath = opts.rulesPath || CONFIG_PATH;
  const userPath = resolveUserPath(opts);
  const cacheKey = templatePath + '::' + userPath;
  if (_cache && _cache.key === cacheKey) return _cache.data;

  const templateData = readRulesDoc(templatePath, { required: true });
  validateRulesArray(templateData.rules, templatePath);

  const migrated = migrateOwnerRules(templateData, templatePath, userPath);
  validateRulesArray(migrated.userDoc.rules, userPath);

  const seenIds = new Set();
  validateRulesArray(migrated.templateRules, templatePath, seenIds);
  validateRulesArray(migrated.userDoc.rules, userPath, seenIds); // throws on a cross-file id collision

  const data = { version: templateData.version, rules: migrated.templateRules.concat(migrated.userDoc.rules) };
  _cache = { key: cacheKey, data };
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

/** remember(text, opts) -> the newly-written rule object — see file header for the full contract. Writes
 *  EXCLUSIVELY into the user rules file (never the shipped template). Fail-closed: validates BEFORE
 *  writing, so an invalid call never partially writes or corrupts the user file. Bypasses the module's read
 *  cache on write (invalidates it) so an immediately-following load()/match() call sees the new rule. */
function remember(text, opts) {
  opts = opts || {};
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('forge-standing: remember requires non-empty "text" (the rule content)');
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

  const userPath = resolveUserPath(opts);
  let userDoc;
  try {
    const raw = fs.readFileSync(userPath, 'utf8');
    userDoc = JSON.parse(raw);
    if (!userDoc || !Array.isArray(userDoc.rules)) {
      throw new Error('forge-standing: remember: ' + userPath + ' exists but is missing a "rules" array');
    }
  } catch (e) {
    if (e.code === 'ENOENT') userDoc = defaultUserDoc();
    else throw new Error('forge-standing: remember could not read/parse ' + userPath + ': ' + e.message);
  }

  const id = opts.id || ('owner-remember-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8));
  if (userDoc.rules.some((r) => r.id === id)) {
    throw new Error('forge-standing: remember: rule id "' + id + '" already exists in ' + userPath);
  }
  // Best-effort: never let a new owner rule silently mask a shipped product rule id. An unreadable/missing
  // template never blocks remember() — only an ACTUAL id collision does.
  try {
    const templatePath = opts.rulesPath || CONFIG_PATH;
    const tdata = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
    if (tdata && Array.isArray(tdata.rules) && tdata.rules.some((r) => r.id === id)) {
      throw new Error('forge-standing: remember: rule id "' + id + '" collides with a shipped product rule id');
    }
  } catch (e) {
    if (/collides with a shipped product rule id/.test(e.message)) throw e;
    // else: template unreadable/missing/malformed — ignore, this is a best-effort check only.
  }

  const rule = {
    id,
    text: text.trim(),
    scope: opts.scope || 'global',
    trigger,
    domain: trigger === 'domain' ? opts.domain : null,
    glob: trigger === 'glob' ? opts.glob : null,
    topic: opts.topic || null,
    source: OWNER_REMEMBER_SOURCE,
    confidence: 'high',
    status: 'active',
    // NEVER settable via remember() — minting a new untouchable-core rule stays a hand-seeded, reviewed
    // invariant, not something a single owner command can create in one step.
    cannot_override_core: false,
    notes: opts.notes || null,
  };

  fs.mkdirSync(path.dirname(userPath), { recursive: true });
  fs.writeFileSync(userPath, JSON.stringify(Object.assign({}, userDoc, { rules: userDoc.rules.concat([rule]) }), null, 2) + '\n', 'utf8');
  _cache = null; // invalidate so the next load()/match() sees the write, regardless of which path combo was cached

  return rule;
}

module.exports = {
  load, listActive, match, remember, globToRegExp, pathMatchesGlob, ruleFires, rank,
  KNOWN_TRIGGERS, KNOWN_STATUSES, PRECEDENCE, CONFIG_PATH, USER_CONFIG_PATH, OWNER_REMEMBER_SOURCE,
};

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
  // FORGE_STANDING_RULES_PATH / FORGE_STANDING_RULES_USER_PATH: test-hermeticity seams (same convention as
  // forge-prefs.cjs's FORGE_OWNER_PROFILE / forge-verify.cjs's FORGE_STORE_ROOT) — unset in normal owner
  // use, so the CLI reads/writes the real config/orchestration/FORGE_STANDING_RULES(.user).json by default.
  const fileOpts = {};
  if (process.env.FORGE_STANDING_RULES_PATH) fileOpts.rulesPath = process.env.FORGE_STANDING_RULES_PATH;
  if (process.env.FORGE_STANDING_RULES_USER_PATH) fileOpts.userRulesPath = process.env.FORGE_STANDING_RULES_USER_PATH;
  try {
    if (opts.cmd === 'match') {
      const result = match({ type: opts.type, paths: opts.paths, onRequest: opts.onRequest }, fileOpts);
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
      const list = listActive(fileOpts);
      if (opts.json) console.log(JSON.stringify(list));
      else for (const r of list) console.log(r.id + '\t[' + r.scope + ']\t' + r.text);
      process.exitCode = 0;
    } else if (opts.cmd === 'remember') {
      const text = opts.positional[0];
      if (!text) { console.error('forge-standing: remember requires "<text>"'); process.exitCode = 2; }
      else {
        const rememberOpts = Object.assign({ scope: opts.scope, trigger: opts.trigger, domain: opts.domain, glob: opts.glob, topic: opts.topic, id: opts.id }, fileOpts);
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
