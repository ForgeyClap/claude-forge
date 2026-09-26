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
 *     GUARD (2026-09-26 fix for external-audit 3.3, LOW): this write-capable migration step only ever runs
 *     when `templatePath` resolves to THIS install's own CONFIG_PATH, or when the caller explicitly passes
 *     `opts.migrate:true`. A caller reading a DIFFERENT rules file (forge-audit-loop.cjs's `--root <other
 *     project>` integrity check, a test fixture, any future tool) gets a read-only load(): no rewrite of
 *     that template, no sibling user file created next to it. An owner-sourced rule already sitting in a
 *     foreign template is still visible (unmigrated) in the merged read — nothing vanishes — it is just
 *     never written to that other project's disk by a read that was never supposed to write anywhere.
 *
 * SHADOW-PROTECTION FOR TEMPLATE RULES (2026-09-26 fix for external-audit 3.2, MEDIUM): a user (owner-added)
 * rule may ADD a new active rule or REINFORCE an existing topic, but it must never SHADOW (push out of
 * `active`) a shipped template rule sharing that rule's topic — regardless of nominal trigger precedence.
 * Mechanism: every rule load() returns is tagged in-memory with `_origin: 'template'|'user'` (never
 * persisted to disk); `rank()` adds a fixed +100 floor for template-origin rules before applying the normal
 * trigger-precedence table, so ANY template rule outranks ANY user rule in the same topic group, even a
 * user glob rule (nominally rank 3) against a template always rule (nominally rank 1). A user rule that
 * loses this way is reported in `shadowed` exactly like any other losing rule — it is never silently
 * dropped, just never allowed to win against a shipped protection like never-auto-push,
 * isolation-only-this-folder, or draft-only-outreach-global. cannot_override_core still outranks everything
 * (Infinity), template or user.
 *
 * USER-FILE FAILURE ISOLATION (2026-09-26 fix for external-audit 3.2, MEDIUM): a broken user file (missing
 * "rules" array, invalid JSON, a rule that fails validateRulesArray, or a rule id that reuses a shipped
 * template id) must never take the shipped template rules down with it. load() validates each user rule
 * INDIVIDUALLY: a rule that fails validation, or whose id collides with a template id (template wins,
 * always) or with another user rule (first one wins), is dropped from the active set and named in ONE
 * visible console.error warning; every other valid user rule still loads normally. Only the TEMPLATE file
 * keeps the original fail-closed "throw on any problem" posture — a broken template is a real install
 * problem, not something load() should paper over.
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
 *  retried on the next load()). Returns { templateRules, userDoc, warning }. `userDoc` is null when nothing
 *  needed migrating (caller must read the user file itself) OR when migration could not safely read the
 *  user file (caller falls back the same way, `warning` explains why); it is otherwise the FULL merged doc
 *  (prior user rules + newly migrated ones), matching what actually landed on disk (or would have, had the
 *  best-effort write succeeded). Never throws — a broken user file must not crash load() (audit 3.2); the
 *  owner rule simply stays put in the template for this read and migration retries next time. */
function migrateOwnerRules(templateData, templatePath, userPath) {
  const toMigrate = templateData.rules.filter((r) => r.source === OWNER_REMEMBER_SOURCE);
  if (toMigrate.length === 0) {
    return { templateRules: templateData.rules, userDoc: null, warning: null };
  }

  let userDoc;
  try {
    userDoc = readRulesDoc(userPath) || defaultUserDoc();
    if (!userDoc || !Array.isArray(userDoc.rules)) {
      throw new Error(userPath + ' is missing a "rules" array');
    }
  } catch (e) {
    return {
      templateRules: templateData.rules,
      userDoc: null,
      warning: 'forge-standing: WARNING — could not migrate owner rule(s) out of the shipped template because ' +
        userPath + ' could not be read (' + e.message + '). The owner rule(s) stay in the template for now; ' +
        'fix or remove that file to complete the migration on a later run.',
    };
  }

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

  return { templateRules, userDoc, warning: null };
}

/** loadUserRulesSafe — reads and validates the user rules file WITHOUT ever throwing (audit 3.2): a rule
 *  that fails validateRulesArray, or whose id collides with a template id (template wins) or with another
 *  user rule already accepted in this same read (first one wins), is skipped and named in the returned
 *  `warning`; every other valid rule still loads. `preloadedDoc`, when given, is the already-migrated doc
 *  from migrateOwnerRules (used instead of re-reading the file) so a successful migration's in-memory
 *  result is what gets validated here, not a second disk read. Returns { rules, warning } — `rules` is
 *  always an array (empty on total failure), `warning` is a single string or null. */
function loadUserRulesSafe(userPath, templateIds, preloadedDoc) {
  let doc = preloadedDoc;
  if (!doc) {
    try {
      doc = readRulesDoc(userPath) || defaultUserDoc();
    } catch (e) {
      return { rules: [], warning: 'forge-standing: WARNING — ignoring ' + userPath + ' (' + e.message + '); using the shipped rules only until the owner file is fixed.' };
    }
  }
  if (!doc || !Array.isArray(doc.rules)) {
    return { rules: [], warning: 'forge-standing: WARNING — ' + userPath + ' has no valid "rules" array; using the shipped rules only until the owner file is fixed.' };
  }

  const validRules = [];
  const seenUserIds = new Set();
  const skipped = [];
  for (const r of doc.rules) {
    try {
      validateRulesArray([r], userPath, new Set());
    } catch (e) {
      skipped.push((r && r.id ? r.id : '<unnamed rule>') + ' (' + e.message + ')');
      continue;
    }
    if (templateIds.has(r.id)) {
      skipped.push(r.id + ' (id collides with a shipped template rule — the shipped rule wins)');
      continue;
    }
    if (seenUserIds.has(r.id)) {
      skipped.push(r.id + ' (duplicate id within the user file — the first one wins)');
      continue;
    }
    seenUserIds.add(r.id);
    // N2 fix (external-audit 2026-09-26, LOW): a hand-edited user file is the same unreviewed threat model
    // as 3.1/3.2 — it must never be able to mint an untouchable rule. cannot_override_core is unconditionally
    // forced false on every user-file rule here, regardless of what is written on disk, so a rule like
    // {topic:"push", cannot_override_core:true} can never get rank()'s Infinity and shadow a shipped
    // never-auto-push template rule. remember() already writes false; this also covers a hand-edited file.
    validRules.push(r.cannot_override_core ? Object.assign({}, r, { cannot_override_core: false }) : r);
  }

  const warning = skipped.length
    ? 'forge-standing: WARNING — ignoring ' + skipped.length + ' rule(s) in ' + userPath + ': ' + skipped.join('; ')
    : null;
  return { rules: validRules, warning };
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

  // 3.3 fix: only ever migrate (write-capable) when this IS the install's own shipped rules file, or the
  // caller explicitly opts in. A caller reading a different project's rules file stays strictly read-only.
  const shouldMigrate = opts.migrate === true || templatePath === CONFIG_PATH;
  let templateRules = templateData.rules;
  let preloadedUserDoc = null;
  if (shouldMigrate) {
    const migrated = migrateOwnerRules(templateData, templatePath, userPath);
    templateRules = migrated.templateRules;
    preloadedUserDoc = migrated.userDoc;
    if (migrated.warning) console.error(migrated.warning);
  }

  validateRulesArray(templateRules, templatePath); // template stays fail-closed: any problem throws

  const templateIds = new Set(templateRules.map((r) => r.id));
  const userResult = loadUserRulesSafe(userPath, templateIds, preloadedUserDoc);
  if (userResult.warning) console.error(userResult.warning);

  const taggedTemplate = templateRules.map((r) => Object.assign({}, r, { _origin: 'template' }));
  const taggedUser = userResult.rules.map((r) => Object.assign({}, r, { _origin: 'user' }));

  const data = { version: templateData.version, rules: taggedTemplate.concat(taggedUser) };
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
  const base = PRECEDENCE[rule.trigger] || 0;
  // 3.2 fix: a template-origin rule always outranks a user-origin rule sharing the same topic, regardless
  // of nominal trigger precedence — a user rule may add or reinforce, never shadow a shipped protection.
  return rule._origin === 'template' ? base + 100 : base;
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
      } else if (r._origin === 'user' && winners[0]._origin === 'template') {
        // 3.2 fix: a user rule never shadows a template rule, even when its OWN trigger would nominally
        // outrank the template rule's trigger — say so plainly instead of the misleading generic reason.
        shadowed.push({
          id: r.id,
          topic,
          beaten_by: winnerIds[0],
          reason: 'a user-added rule can never shadow the shipped template rule "' + winners[0].id + '" for topic "' + topic + '" (add or reinforce, never override)',
        });
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
