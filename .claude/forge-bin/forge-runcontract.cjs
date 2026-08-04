#!/usr/bin/env node
'use strict';
/**
 * forge-runcontract.cjs — run-contract checker (P1 / V9-build, 2026-07-21). THE mechanism that makes
 * config/orchestration/FORGE_HARD_RULES.json's non-negotiables "cannot be skipped" instead of merely
 * documented: given a REAL run (its events.jsonl content + the real files actually sitting in that run's
 * own directory), decides which hard rules are satisfied, which are genuinely missing, and which were
 * explicitly overridden by the owner — a PURE projection of what actually happened, never an assumption
 * or a trusted self-report. Zero-dependency (fs/path only; lazily requires two SIBLING forge-bin modules
 * for reuse, never re-implementing their logic — same single-source-of-truth discipline every sibling
 * *-gate tool in this project already follows).
 *
 * MODEL:
 *   check({ run_id, domain, complexity }, opts) -> { ok, run_id, domain, satisfied:[id,...], missing:[id,...],
 *                                          warnings:[id,...], overridden:[{id,reason,by,note},...],
 *                                          complexity, complexity_source, complexity_declared,
 *                                          complexity_derived, complexity_units, unevaluated:[{id,trigger,reason}] }
 *     run_id  — required. Resolves to <root>/.claude/forge-runs/<run_id>/events.jsonl by default.
 *     domain  — optional real domain slug (e.g. "website", "finance") — decides which trigger:"web" /
 *               trigger:"correctness-critical" / trigger:"domain:<x>" rules even APPLY to this run, and
 *               (for an event-present check with domain_aware:true) unlocks the stronger domain-specific
 *               required-evidence.json proof via forge-verify.cjs::evidenceCheck() (reused, never
 *               re-implemented).
 *     complexity — optional fan-out level ("L1".."L4"). See COMPLEXITY below; it can only RAISE the level
 *               the run's own run.json/events already establish, never lower it.
 *
 * COMPLEXITY (OWNER-PUNT B / richting 2, 2026-08-03 — "the rule must discriminate"):
 *   The measured problem: FORGE_HARD_RULES.json's plan-or-prd-present is an event-present rule whose key is
 *   ["prd_generated","mission_blueprint_created","agent_work_package_created"], and hasEvent() is OR — so the
 *   router's own standing instruction ("every Lead logs an agent_work_package_created per dispatched
 *   subagent") satisfied it on EVERY run via the cheapest of the three. Counted over the 30 real runs in
 *   .claude/forge-runs on 2026-08-03: agent_work_package_created 12 events, prd_generated 2. A rule every run
 *   satisfies by construction discriminates nothing, so the expensive alternative was never chosen.
 *   The fix needs "heavy work owes a real PRD, light work does not" to be EXPRESSIBLE, which it was not: the
 *   trigger vocabulary knew only always|web|correctness-critical|domain:<x>, and no L-level ever reached the
 *   ctx. Hence (a) a new trigger form `complexity:>=L<1-4>`, and (b) a real resolver:
 *     - DECLARED — read from the run's own run.json (fields `complexity`/`fanout`/`fan_out`/`level`).
 *       Measured: run.json really does carry this ("complexity" in 10 runs, "fanout" in 5) and NO event type
 *       carries it — but 12 of 30 runs have no run.json at all, so declared is often simply absent.
 *     - DERIVED — measured from real dispatch volume (countUnits/levelFromUnits) using CLAUDE.md's own
 *       fan-out bands. A derived level is an INFERENCE, not a declaration, and is always reported as such:
 *       complexity_source says which half produced the verdict, and complexity_declared/complexity_derived/
 *       complexity_units are all reported separately so it can never be passed off as a declared level.
 *     - Reconciled by MAX (declared/derived/param), because run.json is a SELF-REPORT: a Lead must not be
 *       able to write "complexity":"L1" and dodge a heavy-work rule while really dispatching twenty agents.
 *       Lowering is possible only through the attributed owner_override route, which leaves a reason on the
 *       record. Any rule scoped by complexity therefore stays overridable — a block on an inference must
 *       always have a usable, recorded escape hatch.
 *
 * UNKNOWN TRIGGERS (same date): forge-sync.cjs ships this file and FORGE_HARD_RULES.json to 12 projects as
 *   SEPARATE files, so one half can lag the other. Previously ANY unrecognized trigger threw, turning a
 *   version skew into a hard crash. Now a structurally BROKEN trigger still throws (malformed config), while
 *   a well-formed but UNKNOWN one is skipped and reported in `unevaluated` — never counted as satisfied and
 *   never counted as missing, because it was genuinely never judged. This helps only from this version
 *   forward: a copy of forge-runcontract.cjs older than 2026-08-03 still crashes on "complexity:>=L3".
 *     opts.root        — project root (default: two levels up from forge-bin, i.e. this project).
 *     opts.runDir       — override the run directory directly (test hermeticity).
 *     opts.eventsPath   — override the events.jsonl path directly (test hermeticity) — the run directory
 *                          used for the real-artifact-file scan is derived as this path's dirname.
 *     opts.rulesPath    — override config/orchestration/FORGE_HARD_RULES.json (test hermeticity).
 *     opts.ownerProfilePath — override FORGE_OWNER_PROFILE.json's path (test hermeticity).
 *
 *   Every rule in FORGE_HARD_RULES.json that APPLIES to this run (see ruleApplies()) is evaluated:
 *     - satisfied  -> its check genuinely matched real events.jsonl content or a real run-directory file
 *                      (an artifact-present check additionally requires the matched file to be genuinely
 *                      non-empty — see listRunArtifacts()/hasArtifact() — a 0-byte placeholder never counts).
 *     - missing    -> severity:"block", unsatisfied, and NO valid owner override was found — this is what
 *                      makes the whole contract `ok:false` ("NOT DONE").
 *     - warnings   -> severity:"warn", unsatisfied — reported, never affects `ok`.
 *     - overridden -> unsatisfied, rule.cannot_override is not true, AND a genuine STRUCTURED owner_override
 *                      event was found in the run's own events.jsonl (see findOwnerOverride() below) —
 *                      reported with the real reason/by as proof, never silently dropped, and never counts
 *                      toward `missing` regardless of severity.
 *   SECURITY (V9-fix, 2026-07-22 — break-swarm DEFECT 2/3): an override is recognized ONLY from an explicit,
 *   structured, attributed, affirmative owner act — never a free-text substring. The old "agent_note whose
 *   note contains override:<ruleId>" convention is RETIRED: agent_note is a freely-loggable event any
 *   dispatched subagent can emit, so a substring match let the very agents these rules police clear their own
 *   rules (a forged run of nothing but such notes returned ok:true). The ONLY thing that can override a rule
 *   now is a real event shaped EXACTLY like:
 *     { event_type:'owner_override', rule:'<exact-rule-id>', reason:'<non-empty, non-bare-token reason>', by:'<owner id>' }
 *   — `rule` must EXACT-match the rule id (no substring/prefix/negation matching of any kind: an
 *   "override:research-done-later"-style mention can never clear "research-done", and a negating mention like
 *   "did NOT use override:dispatch-logged" is never even read as an override candidate — it is not the
 *   required event_type/shape at all); `reason` must be non-blank AND more than just the bare rule id/token
 *   repeated (see isMeaningfulReason()); `by` must match a configured owner id (see loadOwnerAllowlist() —
 *   read from FORGE_HARD_RULES.json's own `owners_allowlist` array and/or FORGE_OWNER_PROFILE.json), failing
 *   CLOSED to "no override possible" when neither configures any id (an empty/missing allow-list can never be
 *   treated as "anyone is the owner"). A rule flagged `cannot_override:true` in FORGE_HARD_RULES.json (the
 *   honesty-core subset: memory-read, dispatch-logged, evidence-satisfied, verify-checked, report-present)
 *   can NEVER be cleared this way, full stop — not even by a validly-attributed owner_override event; check()
 *   does not even look for one on those rules.
 *   A rule whose trigger does not apply to this run (domain) is skipped entirely — it appears in none of
 *   the four buckets, exactly like forge-orchestrate.cjs's audit() only reports on steps it can actually
 *   judge from real content.
 *
 * CLI:
 *   node forge-runcontract.cjs check --run <id> [--domain <d>] [--root <projectRoot>] [--json]
 * Exit codes: 0 = contract satisfied (every applicable block-rule met or overridden) · 3 = NOT DONE (at
 *   least one applicable block-rule missing — mirrors forge-actiongate's gate=3 / forge-evidence's not-ok=3
 *   convention) · 2 = usage/config error (bad/missing rules file, bad run_id, unreadable events file).
 */
const fs = require('fs');
const path = require('path');

const RULES_PATH = path.join(__dirname, '..', 'config', 'orchestration', 'FORGE_HARD_RULES.json');
const DEFAULT_ROOT = path.resolve(__dirname, '..', '..');

const KNOWN_TRIGGER_LITERALS = new Set(['always', 'web', 'correctness-critical']);
const KNOWN_CHECK_TYPES = new Set(['event-present', 'artifact-present', 'doctor-check']);
const KNOWN_SEVERITIES = new Set(['block', 'warn']);
const WEB_DOMAINS = new Set(['web', 'website']);
const CRITICAL_DOMAINS_FALLBACK = ['finance', 'parser', 'ocr', 'data', 'prediction']; // used only if forge-fixtures.cjs can't be loaded

// ---- complexity trigger vocabulary (OWNER-PUNT B / richting 2, 2026-08-03) -------------------------------
// COMPLEXITY_TRIGGER_RE is the ONE place the new trigger form is defined: "complexity:>=L<n>", n in 1..4.
// Only the >= comparison exists — that is the whole shape of the need ("heavy work owes more"), and inventing
// <=/== operators nobody asked for would be vocabulary this file has to keep honouring forever.
const COMPLEXITY_TRIGGER_RE = /^complexity:>=L([1-4])$/;
const LEVEL_RE = /^L([1-4])$/i;
// TRIGGER_SHAPE_RE separates "structurally broken config" from "vocabulary this checker predates". A bare
// token (`always`) or a namespaced token with a NON-EMPTY payload (`domain:finance`, `complexity:>=L3`,
// `phase:beta`) is structurally well-formed; anything else (missing, non-string, blank, `domain:` with no
// payload) is a genuinely malformed rules file and still throws — see loadRules() below.
const TRIGGER_SHAPE_RE = /^[a-z][a-z0-9-]*(?::\S+)?$/i;

/** parseLevel(v) -> 'L1'..'L4' | null — tolerant of case and surrounding whitespace, never throws. */
function parseLevel(v) {
  if (typeof v !== 'string') return null;
  const m = LEVEL_RE.exec(v.trim());
  return m ? 'L' + m[1] : null;
}
function levelNum(level) {
  const parsed = parseLevel(level);
  return parsed ? Number(parsed.slice(1)) : 0;
}
function maxLevel(a, b) {
  return levelNum(a) >= levelNum(b) ? (parseLevel(a) || parseLevel(b)) : (parseLevel(b) || parseLevel(a));
}

// ---- rules config (single source of truth: FORGE_HARD_RULES.json) --------------------------------------
let _rulesCache = null; // { path, data, unknownTriggers } — cached per-path in the SAME process; tests override via opts.rulesPath
/** isValidTrigger(t) -> boolean — true only for vocabulary THIS checker can actually evaluate. */
function isValidTrigger(t) {
  if (typeof t !== 'string') return false;
  if (KNOWN_TRIGGER_LITERALS.has(t)) return true;
  if (t.startsWith('domain:') && t.length > 'domain:'.length) return true;
  return COMPLEXITY_TRIGGER_RE.test(t);
}
/** isWellFormedTrigger(t) -> boolean — true when `t` is at least SHAPED like a trigger, even if this
 *  checker does not know the vocabulary (see TRIGGER_SHAPE_RE). This is the seam that turns a fleet version
 *  skew into an honest degrade instead of a crash. */
function isWellFormedTrigger(t) {
  return typeof t === 'string' && TRIGGER_SHAPE_RE.test(t.trim()) && t.trim() === t;
}

/** loadRulesMeta(rulesPath) -> { data, unknownTriggers:[{id,trigger}] } — the full parse result, including
 *  the rules this checker cannot judge because their trigger vocabulary is newer than this file.
 *
 *  WHY (2026-08-03): forge-sync.cjs ships config/orchestration/FORGE_HARD_RULES.json and
 *  forge-bin/forge-runcontract.cjs to 12 projects as SEPARATE files, so one half can lag the other. Before
 *  this change, ANY trigger this file did not recognize threw — meaning a project that received the newer
 *  rules file but not the newer checker would hard-crash every run-contract evaluation instead of degrading.
 *  Now: a structurally BROKEN trigger (missing/non-string/blank/`domain:` with no payload) is still a
 *  malformed config and still throws; a structurally well-formed but UNKNOWN one is collected here, skipped
 *  by check(), and reported in result.unevaluated so it is loudly visible rather than silently passing.
 *  This helps only from THIS version of the file forward — a copy of forge-runcontract.cjs older than
 *  2026-08-03 still throws on "complexity:>=L3"; the fleet fix is to sync the pair together. */
function loadRulesMeta(rulesPath) {
  const p = rulesPath || RULES_PATH;
  if (_rulesCache && _rulesCache.path === p) return _rulesCache;

  const raw = fs.readFileSync(p, 'utf8');
  let data;
  try { data = JSON.parse(raw); }
  catch (e) { throw new Error('forge-runcontract: ' + p + ' is not valid JSON: ' + e.message); }

  if (!data || !Array.isArray(data.rules) || data.rules.length === 0) {
    throw new Error('forge-runcontract: ' + p + ' is missing a non-empty "rules" array');
  }

  const unknownTriggers = [];
  const seenIds = new Set();
  for (const r of data.rules) {
    if (!r || typeof r !== 'object') throw new Error('forge-runcontract: a rule entry in ' + p + ' is not an object: ' + JSON.stringify(r));
    if (!r.id || typeof r.id !== 'string') throw new Error('forge-runcontract: a rule entry in ' + p + ' is missing a string "id": ' + JSON.stringify(r));
    if (seenIds.has(r.id)) throw new Error('forge-runcontract: duplicate rule id "' + r.id + '" in ' + p);
    seenIds.add(r.id);
    if (!r.rule || typeof r.rule !== 'string') throw new Error('forge-runcontract: rule "' + r.id + '" is missing a string "rule" in ' + p);
    if (!isValidTrigger(r.trigger)) {
      if (!isWellFormedTrigger(r.trigger)) {
        throw new Error('forge-runcontract: rule "' + r.id + '" has an invalid "trigger" in ' + p + ' (must be "always", "web", "correctness-critical", "domain:<x>", or "complexity:>=L<1-4>")');
      }
      // well-formed but unknown vocabulary -> this rules file is newer than this checker. Degrade honestly.
      unknownTriggers.push({ id: r.id, trigger: r.trigger });
    }
    if (!r.check || typeof r.check !== 'object' || Array.isArray(r.check)) {
      throw new Error('forge-runcontract: rule "' + r.id + '" is missing a "check" object in ' + p);
    }
    if (!KNOWN_CHECK_TYPES.has(r.check.type)) {
      throw new Error('forge-runcontract: rule "' + r.id + '" has an unknown check.type "' + r.check.type + '" in ' + p + ' (must be one of ' + Array.from(KNOWN_CHECK_TYPES).join(', ') + ')');
    }
    if (r.check.key == null || !(typeof r.check.key === 'string' ? r.check.key.length > 0 : (Array.isArray(r.check.key) && r.check.key.length > 0))) {
      throw new Error('forge-runcontract: rule "' + r.id + '" has an invalid/empty check.key in ' + p);
    }
    if (!KNOWN_SEVERITIES.has(r.severity)) {
      throw new Error('forge-runcontract: rule "' + r.id + '" has an invalid "severity" in ' + p + ' (must be "block" or "warn")');
    }
    if (!r.override || typeof r.override !== 'string') throw new Error('forge-runcontract: rule "' + r.id + '" is missing a string "override" in ' + p);
    if (!r.source || typeof r.source !== 'string') throw new Error('forge-runcontract: rule "' + r.id + '" is missing a string "source" in ' + p);
    if (r.cannot_override !== undefined && typeof r.cannot_override !== 'boolean') {
      throw new Error('forge-runcontract: rule "' + r.id + '" has a non-boolean "cannot_override" in ' + p);
    }
  }
  if (data.owners_allowlist !== undefined && !Array.isArray(data.owners_allowlist)) {
    throw new Error('forge-runcontract: ' + p + ' has a non-array "owners_allowlist"');
  }

  _rulesCache = { path: p, data, unknownTriggers };
  return _rulesCache;
}

/** loadRules(rulesPath) -> the parsed rules data (unchanged signature — every pre-existing caller keeps
 *  working; loadRulesMeta() above is the richer form check() uses). */
function loadRules(rulesPath) {
  return loadRulesMeta(rulesPath).data;
}

/** listRules(opts) -> the raw rule entries, straight from FORGE_HARD_RULES.json (see file header). */
function listRules(opts) {
  return loadRules((opts || {}).rulesPath).rules;
}

// ---- lazy sibling reuse (never re-implemented) ----------------------------------------------------------
let _fixturesCache; // undefined = not yet attempted, null = load failed, object = loaded module
function loadFixturesTool() {
  if (_fixturesCache !== undefined) return _fixturesCache;
  try { _fixturesCache = require('./forge-fixtures.cjs'); } catch { _fixturesCache = null; }
  return _fixturesCache;
}
function criticalDomains() {
  const tool = loadFixturesTool();
  return (tool && Array.isArray(tool.CRITICAL_DOMAINS) && tool.CRITICAL_DOMAINS.length) ? tool.CRITICAL_DOMAINS : CRITICAL_DOMAINS_FALLBACK;
}

let _verifyCache; // undefined = not yet attempted, null = load failed, object = loaded module
function loadVerifyTool() {
  if (_verifyCache !== undefined) return _verifyCache;
  try { _verifyCache = require('./forge-verify.cjs'); } catch { _verifyCache = null; }
  return _verifyCache;
}

// ---- trigger applicability -------------------------------------------------------------------------------
/** ruleApplies(rule, domain, complexity) -> boolean — see file header MODEL section. Both `domain` and
 *  `complexity` may be null/undefined (not known for this run); a rule scoped to the axis a caller knows
 *  nothing about simply does not apply — the same under-claiming discipline the domain axis has always used,
 *  never a fabricated match. Only "always" rules apply when neither is known. Never throws. */
function ruleApplies(rule, domain, complexity) {
  const d = domain ? String(domain).trim().toLowerCase() : null;
  if (rule.trigger === 'always') return true;
  // complexity is a domain-INDEPENDENT axis — evaluated before the domain guard below, so a
  // "complexity:>=L3" rule fires on a heavy run whose domain is unknown.
  const cx = COMPLEXITY_TRIGGER_RE.exec(rule.trigger);
  if (cx) {
    const level = levelNum(complexity);
    return level > 0 && level >= Number(cx[1]);
  }
  if (!d) return false;
  if (rule.trigger === 'web') return WEB_DOMAINS.has(d);
  if (rule.trigger === 'correctness-critical') return criticalDomains().some((x) => String(x).toLowerCase() === d);
  if (rule.trigger.startsWith('domain:')) return rule.trigger.slice('domain:'.length).toLowerCase() === d;
  return false;
}

// ---- complexity resolution (DECLARED vs DERIVED — never conflated) ---------------------------------------
// The dispatch events that count as one unit of dispatched work. Same three event types dispatch-logged's own
// check.key already uses — reused deliberately, so "a run dispatched agents" means ONE thing in this file.
const DISPATCH_EVENT_TYPES = ['agent_started', 'subagent_started', 'custom_subagent_created'];
const WORK_PACKAGE_EVENT_TYPE = 'agent_work_package_created';
// run.json field names that really carry a level in this project's own history (measured 2026-08-03 across
// the 30 runs in .claude/forge-runs: "complexity" in 10 runs, "fanout" in 5). fan_out/level are accepted as
// obvious spelling variants so a future writer does not silently produce an unread field.
const DECLARED_LEVEL_FIELDS = ['complexity', 'fanout', 'fan_out', 'level'];

/** countUnits(events) -> number — the REAL count of dispatched work units in this run: the larger of
 *  (a) how many dispatch events were logged and (b) how many work packages were created. Both are counted
 *  as raw EVENTS, not distinct agent names: this project reuses 12 permanent Boss names, so distinct names
 *  badly understate fan-out (measured: run forge-2026-07-26-command-center logged 26 subagent_started events
 *  across only 6 distinct names). Never throws. */
function countUnits(events) {
  let dispatch = 0, packages = 0;
  for (const e of events) {
    if (!e || typeof e !== 'object' || typeof e.event_type !== 'string') continue;
    const type = e.event_type.toLowerCase();
    if (DISPATCH_EVENT_TYPES.includes(type)) dispatch++;
    else if (type === WORK_PACKAGE_EVENT_TYPE) packages++;
  }
  return Math.max(dispatch, packages);
}

/** levelFromUnits(units) -> 'L1'..'L4' — the project's OWN fan-out bands, quoted from CLAUDE.md ("L1 small
 *  (1–3 agents) · L2 medium (3–6) · L3 complex (6–12) · L4 large (phased)"), not thresholds invented here.
 *  Boundaries are resolved downward (3 -> L1, 6 -> L2, 12 -> L3) so a run on a band edge is never pushed
 *  into owing MORE than the band it sits on. */
function levelFromUnits(units) {
  if (units <= 3) return 'L1';
  if (units <= 6) return 'L2';
  if (units <= 12) return 'L3';
  return 'L4';
}

/** declaredLevel(runMeta) -> 'L1'..'L4' | null — the level a run.json DECLARES, or null when it declares
 *  none (measured: 12 of this project's 30 runs have no run.json at all, and 2 more have one with no level
 *  field — so "declared" is genuinely often absent, never assumable). */
function declaredLevel(runMeta) {
  if (!runMeta || typeof runMeta !== 'object') return null;
  for (const field of DECLARED_LEVEL_FIELDS) {
    const parsed = parseLevel(runMeta[field]);
    if (parsed) return parsed;
  }
  return null;
}

/**
 * resolveComplexity(events, runMeta, paramLevel) -> { level, declared, derived, source, units }
 *
 * HONESTY CONTRACT — a DERIVED level is not a DECLARED level, and this function never lets one masquerade
 * as the other. `declared` is what the run itself claimed (run.json; null when it claimed nothing),
 * `derived` is what the run's real events MEASURE (countUnits -> levelFromUnits), and `source` names which
 * one actually produced the returned `level`. Any rule that fires on a derived level is, by construction,
 * firing on an inference — which is why both halves are reported in check()'s result and why a rule scoped
 * this way stays overridable.
 *
 * RECONCILIATION IS BY MAX, deliberately: run.json is written by the Lead, i.e. it is a SELF-REPORT. If the
 * declared level alone decided, a Lead could write "complexity":"L1" and dodge every heavy-work rule while
 * really dispatching twenty agents. Taking the highest of declared/derived/param means a run can always be
 * held to at least what it measurably did. Lowering is therefore not possible by declaration — it is
 * possible only through the owner_override route, which is attributed and leaves a reason on the record.
 *
 * Measured bias (2026-08-03, across the 17 of this project's 30 real runs that declare a level): derived
 * AGREES with declared on 3, UNDER-states it on 14 (e.g. forge-2026-07-13-scout-adopt declares L4 but logged
 * only 3 dispatch events; forge-2026-07-14-hardening declares L4 and logged none), and NEVER over-states it.
 * So derivation on its own errs toward demanding LESS — under-claiming over over-claiming, the same bias
 * FORGE_HARD_RULES.json's own HONEST GAPS already prefer. The practical consequence is worth stating
 * plainly: a genuinely heavy run that logs no dispatch events and declares nothing will be read as L1 and
 * will NOT be asked for a PRD. That is a real hole, and it is the honest one to leave open — the alternative
 * (guessing heaviness from weaker signals) would block light runs on nothing.
 */
function resolveComplexity(events, runMeta, paramLevel) {
  const units = countUnits(events || []);
  const derived = levelFromUnits(units);
  const declared = declaredLevel(runMeta);
  const param = parseLevel(paramLevel);

  let level = derived;
  if (declared) level = maxLevel(level, declared);
  if (param) level = maxLevel(level, param);

  const source = (declared === level) ? 'declared' : (param === level) ? 'param' : 'derived';
  return { level, declared, derived, source, units };
}

// ---- reading a run's real content (PURE projection — never assumed) --------------------------------------
/** readEventsJsonl(eventsPath) -> event[] — line-delimited JSON, BOM-tolerant, malformed lines silently
 *  skipped (mirrors forge-verify.cjs/forge-orchestrate.cjs's own readEventsJsonl tolerance). Throws only
 *  when the file itself cannot be read (missing/unreadable run). */
function readEventsJsonl(eventsPath) {
  let raw;
  try { raw = fs.readFileSync(eventsPath, 'utf8'); }
  catch (e) { throw new Error('forge-runcontract: could not read events file ' + eventsPath + ': ' + e.message); }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // strip BOM
  const events = [];
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try { events.push(JSON.parse(s)); } catch { /* malformed line — skip, never crash */ }
  }
  return events;
}

/** listRunArtifacts(runDir) -> {name, nonEmpty}[] — the REAL files actually sitting in the run's own
 *  directory (e.g. final-report.md, run.json), excluding events.jsonl itself (that is judged as events, not
 *  an artifact), each tagged with whether its REAL content is genuinely non-empty (V9-fix, 2026-07-22 —
 *  break-swarm DEFECT 1: a 0-byte/whitespace-only placeholder file used to satisfy an artifact-present check
 *  on filename alone — "a real final-report must actually exist" now means it, not just that some file with
 *  a matching name happens to sit there). A missing/unreadable directory yields an empty list rather than
 *  throwing — the events.jsonl read above is what surfaces a genuinely missing run. An individual file that
 *  cannot be read is honestly tagged nonEmpty:false (never assumed non-empty). */
function listRunArtifacts(runDir) {
  let entries;
  try { entries = fs.readdirSync(runDir, { withFileTypes: true }); } catch { return []; }
  const files = entries.filter((e) => e.isFile() && e.name !== 'events.jsonl');
  return files.map((e) => {
    let nonEmpty = false;
    try { nonEmpty = fs.readFileSync(path.join(runDir, e.name), 'utf8').trim().length > 0; } catch { nonEmpty = false; }
    return { name: e.name, nonEmpty };
  });
}

function toArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function hasEvent(events, key) {
  const wanted = toArray(key).map((t) => String(t).toLowerCase());
  if (wanted.length === 0) return false;
  return events.some((e) => e && typeof e === 'object' && typeof e.event_type === 'string' && wanted.includes(e.event_type.toLowerCase()));
}

/** hasArtifact(artifacts, key) -> boolean — case-insensitive filename-substring match AGAINST a genuinely
 *  non-empty file only (V9-fix, DEFECT 1 — see listRunArtifacts() doc). `artifacts` is normally the
 *  {name,nonEmpty}[] shape listRunArtifacts() returns; a plain string[] (legacy direct callers / narrow unit
 *  tests that only want to prove the filename-matching half in isolation) is still accepted and treated as
 *  already-known-non-empty, so a caller that already filtered/knows its list is real content keeps working. */
function hasArtifact(artifacts, key) {
  const subs = toArray(key).map((s) => String(s).toLowerCase());
  if (subs.length === 0) return false;
  return subs.some((sub) => artifacts.some((a) => {
    const name = (typeof a === 'string') ? a : (a && a.name);
    const nonEmpty = (typeof a === 'string') ? true : !!(a && a.nonEmpty);
    return typeof name === 'string' && name.toLowerCase().includes(sub) && nonEmpty;
  }));
}

function hasDoctorRun(events) {
  return hasEvent(events, 'doctor_run');
}

/** checkSatisfied(rule, ctx) -> boolean — evaluates ONE rule's check against ctx:{events, artifacts, domain}.
 *  A domain_aware event-present check that fails on its own generic key also tries forge-verify.cjs's
 *  evidenceCheck(events, domain) (reused, never re-implemented) as an OR-fallback — see FORGE_HARD_RULES.json
 *  header doc for the exact contract. Never throws; a sibling-tool load/config failure is treated as "no
 *  domain-specific proof available", never a fabricated pass. */
function checkSatisfied(rule, ctx) {
  const c = rule.check;
  let satisfied = false;
  if (c.type === 'event-present') satisfied = hasEvent(ctx.events, c.key);
  else if (c.type === 'artifact-present') satisfied = hasArtifact(ctx.artifacts, c.key);
  else if (c.type === 'doctor-check') satisfied = hasDoctorRun(ctx.events);

  if (!satisfied && c.domain_aware === true && ctx.domain) {
    const verify = loadVerifyTool();
    if (verify && typeof verify.evidenceCheck === 'function') {
      try {
        const res = verify.evidenceCheck(ctx.events, ctx.domain, {});
        if (res && res.ok === true) satisfied = true;
      } catch { /* domain evidence check unavailable/malformed config — no fabricated pass */ }
    }
  }
  return satisfied;
}

const OWNER_PROFILE_PATH = path.join(__dirname, '..', 'FORGE_OWNER_PROFILE.json');

/** isMeaningfulReason(reason, ruleId) -> boolean — true only when `reason` is a non-blank string that says
 *  MORE than just the bare rule id or the bare "override:<ruleId>" token (V9-fix, DEFECT 2: the doctor's own
 *  doctor_check_overrides model already demands a real, non-blank reason for exactly this honesty purpose —
 *  mirrored here, plus the extra "not just the bare token" guard this ask specifically requires so a lazy
 *  `reason:"override:dispatch-logged"` can never itself masquerade as an explanation). Mentioning the rule id
 *  ALONGSIDE real explanatory text is fine (e.g. "dispatch-logged waived — see run.json") — only a reason
 *  that reduces to NOTHING once the bare token is removed is rejected. */
function isMeaningfulReason(reason, ruleId) {
  if (typeof reason !== 'string') return false;
  const trimmed = reason.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  const idLower = String(ruleId).toLowerCase();
  const bareToken = 'override:' + idLower;
  if (lower === bareToken || lower === idLower) return false;
  const stripped = lower.split(bareToken).join(' ').split(idLower).join(' ').trim();
  return stripped.length > 0;
}

/** loadOwnerAllowlist(rulesData, opts) -> Set<string> — the lowercased set of owner ids a `by` field is
 *  allowed to match (V9-fix, DEFECT 2). Reads BOTH: (1) FORGE_HARD_RULES.json's own top-level
 *  `owners_allowlist` array (the primary, in-repo source of truth this project owns), and (2)
 *  FORGE_OWNER_PROFILE.json's optional `owner_id` (or `prefs.owner_id.value`) field, if either project ever
 *  seeds one — additive, never a replacement. A missing/malformed/absent source contributes nothing (never
 *  throws); when NEITHER source configures any id the returned set is EMPTY, which findOwnerOverride() below
 *  treats as "no override can ever be recognized" — fail CLOSED, never "any `by` value is accepted". */
function loadOwnerAllowlist(rulesData, opts) {
  const ids = new Set();
  if (rulesData && Array.isArray(rulesData.owners_allowlist)) {
    for (const id of rulesData.owners_allowlist) if (typeof id === 'string' && id.trim()) ids.add(id.trim().toLowerCase());
  }
  const profilePath = (opts && opts.ownerProfilePath) || OWNER_PROFILE_PATH;
  try {
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    const fromProfile = (profile && typeof profile.owner_id === 'string') ? profile.owner_id
      : (profile && profile.prefs && profile.prefs.owner_id && typeof profile.prefs.owner_id.value === 'string') ? profile.prefs.owner_id.value
      : null;
    if (fromProfile && fromProfile.trim()) ids.add(fromProfile.trim().toLowerCase());
  } catch { /* profile missing/malformed -> contributes no id, never a crash (same tolerant-degrade discipline as the rest of this file) */ }
  return ids;
}

/** findOwnerOverride(events, ruleId, ownerAllowlist) -> {reason,by}|null — recognizes an override ONLY from
 *  an explicit, structured, attributed, affirmative owner act (V9-fix, 2026-07-22 — break-swarm DEFECT 2/3;
 *  see file header doc for the full model). Requires ALL of, on the SAME event:
 *    - event_type is (case-insensitively) "owner_override" — never merely an agent_note;
 *    - `rule` is a string and EXACT-matches ruleId (no substring/prefix/negation matching — a mention of the
 *      rule id inside a longer or negated string, or a different rule id that happens to share a prefix,
 *      never matches);
 *    - `reason` passes isMeaningfulReason() (non-blank, more than just the bare token);
 *    - `by` is a non-blank string that appears (case-insensitively) in `ownerAllowlist` — an empty allowlist
 *      can never match anything, by construction (fail-closed).
 *  Returns the FIRST match, carrying the real reason/by as proof — never a bare boolean, so an override is
 *  always independently inspectable. */
function findOwnerOverride(events, ruleId, ownerAllowlist) {
  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    if (typeof e.event_type !== 'string' || e.event_type.toLowerCase() !== 'owner_override') continue;
    if (typeof e.rule !== 'string' || e.rule !== ruleId) continue;
    if (!isMeaningfulReason(e.reason, ruleId)) continue;
    const by = (typeof e.by === 'string') ? e.by.trim() : '';
    if (!by || !ownerAllowlist.has(by.toLowerCase())) continue;
    return { reason: String(e.reason).trim(), by };
  }
  return null;
}

/**
 * check({ run_id, domain }, opts) -> { ok, run_id, domain, satisfied, missing, warnings, overridden }
 * See file header for the full contract. Throws on a usage error (missing/invalid run_id, unreadable
 * events.jsonl, malformed FORGE_HARD_RULES.json) — never on a normal, even fully-empty, run.
 */
function check(params, opts) {
  params = params || {};
  opts = opts || {};
  if (!params.run_id || typeof params.run_id !== 'string') {
    throw new Error('forge-runcontract: check() requires a non-empty "run_id" string');
  }
  const domain = params.domain ? String(params.domain) : null;

  const root = opts.root ? path.resolve(opts.root) : DEFAULT_ROOT;
  const runDir = opts.runDir ? path.resolve(opts.runDir) : path.join(root, '.claude', 'forge-runs', params.run_id);
  const eventsPath = opts.eventsPath || path.join(runDir, 'events.jsonl');
  const artifactsDir = path.dirname(eventsPath);

  const events = readEventsJsonl(eventsPath);
  const artifacts = listRunArtifacts(artifactsDir);
  const meta = loadRulesMeta(opts.rulesPath);
  const rulesData = meta.data;
  const rules = rulesData.rules;
  const ownerAllowlist = loadOwnerAllowlist(rulesData, opts);

  // The run's own manifest, read best-effort for its DECLARED complexity. A missing/malformed run.json is
  // normal here (12 of this project's 30 runs have none) — it degrades to "nothing declared", never a throw.
  let runMeta = null;
  try { runMeta = JSON.parse(fs.readFileSync(path.join(artifactsDir, 'run.json'), 'utf8')); } catch { runMeta = null; }
  const cx = resolveComplexity(events, runMeta, params.complexity);

  const unknownTriggerIds = new Set(meta.unknownTriggers.map((u) => u.id));
  const satisfied = [];
  const missing = [];
  const warnings = [];
  const overridden = [];
  // Rules this checker genuinely CANNOT judge (their trigger vocabulary is newer than this file). Reported,
  // never silently treated as met or missing — see loadRulesMeta()'s doc for the fleet-skew reasoning.
  const unevaluated = meta.unknownTriggers.map((u) => ({
    id: u.id,
    trigger: u.trigger,
    reason: 'unknown trigger "' + u.trigger + '" — this rules file is newer than forge-runcontract.cjs; rule skipped, not judged',
  }));

  for (const rule of rules) {
    if (unknownTriggerIds.has(rule.id)) continue;
    if (!ruleApplies(rule, domain, cx.level)) continue;
    if (checkSatisfied(rule, { events, artifacts, domain })) { satisfied.push(rule.id); continue; }

    // V9-fix (DEFECT 2): a rule flagged cannot_override:true is NEVER even eligible for the override lookup —
    // not "eligible but never matched", genuinely never consulted, so no future change to findOwnerOverride()
    // could ever accidentally clear one of these.
    if (rule.cannot_override !== true) {
      const ov = findOwnerOverride(events, rule.id, ownerAllowlist);
      if (ov) { overridden.push({ id: rule.id, reason: ov.reason, by: ov.by, note: 'owner_override by ' + ov.by + ': ' + ov.reason }); continue; }
    }

    if (rule.severity === 'block') missing.push(rule.id);
    else warnings.push(rule.id);
  }

  const result = {
    ok: missing.length === 0, run_id: params.run_id, domain, satisfied, missing, warnings, overridden,
    // complexity_* is reported on EVERY result, even when no rule is scoped to it — a caller must always be
    // able to see which level a verdict was reached at, and whether that level was declared or only derived.
    complexity: cx.level, complexity_source: cx.source, complexity_declared: cx.declared,
    complexity_derived: cx.derived, complexity_units: cx.units,
    unevaluated,
  };

  // gate_evaluated proof event (2026-08-02, opt-in — the gap this closes: this checker existed, was
  // tested, and was cited by FORGE_HARD_RULES.json since V9, yet across 846 real events in 31 runs not
  // ONE gate_evaluated was ever logged, because nothing emitted it. A gate that evaluates silently is
  // indistinguishable from a gate that never ran. Same one-act discipline as forge-manifest's
  // manifest_armed: the check and its proof happen together; a logging failure is reported honestly in
  // result.logged but NEVER flips the verdict — the evaluation already happened.
  if (opts.logEvent === true) result.logged = logGateEvaluated(result, opts);

  return result;
}

// The ONE event writer a project has is <root>/.claude/forge-dashboard/log-event.cjs — spawned rather
// than re-implemented, so hash-chaining/honesty-stamping/strict validation are never bypassed (identical
// pattern to forge-manifest.cjs::logManifestArmed, deliberately, so there is one convention to learn).
// ROOT CONTAINMENT (2026-08-03): the writer is resolved under the SAME root the check evaluated —
// never via __dirname. The old __dirname resolution made every foreign-root caller (hermetic tests,
// doctor suite runs, post-install validation in a fresh target) write real gate_evaluated events into
// THIS install's .claude/forge-runs/ — the "run-complete" pollution found in the project, the canonical
// template, and every fresh install target. A root without its own writer is reported honestly as
// {logged.ok:false}; it must never silently fall back to another install's writer.
function logEventScriptFor(root) {
  return path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs');
}

/** logGateEvaluated(result, opts) -> {ok, event_type, reason?, status?} — best-effort, never throws. */
function logGateEvaluated(result, opts) {
  opts = opts || {};
  const root = opts.root ? path.resolve(opts.root) : DEFAULT_ROOT;
  const script = opts.logEventPath || logEventScriptFor(root);
  if (!opts.logEventPath && !fs.existsSync(script)) {
    return { ok: false, event_type: 'gate_evaluated', reason: 'no event writer under this root (' + script + ' missing) — refusing cross-install fallback' };
  }
  const note = (result.ok
    ? 'run contract PASSED — ' + result.satisfied.length + ' rule(s) satisfied'
    : 'run contract NOT DONE — missing: ' + result.missing.join(', '))
    + (result.complexity ? ' · complexity ' + result.complexity + ' (' + result.complexity_source + ')' : '')
    + (result.overridden.length ? ' · ' + result.overridden.length + ' overridden' : '')
    + (result.warnings.length ? ' · warnings: ' + result.warnings.join(', ') : '')
    + (result.unevaluated && result.unevaluated.length ? ' · unevaluated: ' + result.unevaluated.map((u) => u.id).join(', ') : '');
  const ev = { run_id: result.run_id, event_type: 'gate_evaluated', agent: 'orchestrator', note, ok: result.ok };
  let res;
  try {
    const { spawnSync } = require('child_process'); // lazy — a plain check() never needs it
    res = spawnSync(process.execPath, [script, JSON.stringify(ev)], { encoding: 'utf8' });
  } catch (e) {
    return { ok: false, event_type: 'gate_evaluated', reason: 'could not spawn log-event.cjs: ' + e.message };
  }
  if (res.error) return { ok: false, event_type: 'gate_evaluated', reason: 'could not spawn log-event.cjs: ' + res.error.message };
  if (res.status !== 0) {
    return { ok: false, event_type: 'gate_evaluated', status: res.status, reason: 'log-event.cjs exited ' + res.status + ': ' + String(res.stderr || '').trim() };
  }
  return { ok: true, event_type: 'gate_evaluated', status: 0 };
}

module.exports = {
  check, listRules, loadRules, loadRulesMeta, ruleApplies, checkSatisfied, findOwnerOverride, isMeaningfulReason, loadOwnerAllowlist,
  readEventsJsonl, listRunArtifacts, hasEvent, hasArtifact, logGateEvaluated,
  resolveComplexity, countUnits, levelFromUnits, declaredLevel, parseLevel, isValidTrigger, isWellFormedTrigger,
  RULES_PATH, OWNER_PROFILE_PATH, KNOWN_TRIGGER_LITERALS, KNOWN_CHECK_TYPES, KNOWN_SEVERITIES,
  COMPLEXITY_TRIGGER_RE, DISPATCH_EVENT_TYPES, DECLARED_LEVEL_FIELDS,
};

// ---- CLI ----
function parseArgs(argv) {
  const cmd = argv[0] || null;
  const rest = argv.slice(1);
  const opts = { cmd, run: null, domain: null, root: null, rules: null, complexity: null, json: false, logEvent: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--run') opts.run = rest[++i];
    else if (a === '--domain') opts.domain = rest[++i];
    else if (a === '--root') opts.root = rest[++i];
    else if (a === '--rules') opts.rules = rest[++i];
    else if (a === '--complexity') opts.complexity = rest[++i];
    else if (a === '--json') opts.json = true;
    else if (a === '--log-event') opts.logEvent = true;
  }
  return opts;
}
function printUsage() {
  console.error('Usage: node forge-runcontract.cjs check --run <id> [--domain <d>] [--complexity L1|L2|L3|L4] [--root <projectRoot>] [--rules <path>] [--json] [--log-event]');
  console.error('  --complexity  raise the run\'s fan-out level (it is otherwise read from run.json and/or derived from real');
  console.error('                dispatch volume; this flag can only RAISE, never lower — see resolveComplexity())');
  console.error('  --rules       evaluate against a specific FORGE_HARD_RULES.json (default: this project\'s own)');
  console.error('  --log-event   also append a gate_evaluated proof event to the run (via log-event.cjs, one act)');
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  try {
    if (opts.cmd === 'check') {
      if (!opts.run) {
        console.error('forge-runcontract: check requires --run <id>');
        process.exitCode = 2;
      } else {
        const callOpts = {};
        if (opts.root) callOpts.root = opts.root;
        if (opts.rules) callOpts.rulesPath = opts.rules;
        if (opts.logEvent) callOpts.logEvent = true;
        const result = check({ run_id: opts.run, domain: opts.domain, complexity: opts.complexity }, callOpts);
        // json-mode contract: `logged` must be present whenever --log-event was asked for, so a caller
        // can always distinguish "proof written" from "proof failed" from "proof not requested".
        if (opts.logEvent && !('logged' in result)) result.logged = { ok: false, reason: 'internal: check() did not report a logging outcome' };
        if (opts.json) {
          console.log(JSON.stringify(result));
        } else {
          const cxLine = '  · complexity ' + result.complexity + ' (' + result.complexity_source + '; declared ' +
            (result.complexity_declared || 'none') + ', derived ' + result.complexity_derived + ' from ' +
            result.complexity_units + ' dispatched unit(s))';
          if (result.ok) {
            console.log('CONTRACT OK — ' + opts.run + ' (' + result.satisfied.length + ' rule(s) satisfied' +
              (result.overridden.length ? ', ' + result.overridden.length + ' overridden' : '') +
              (result.warnings.length ? ', ' + result.warnings.length + ' warning(s)' : '') + ')');
          } else {
            console.log('NOT DONE — ' + opts.run + ' is missing ' + result.missing.length + ' required rule(s):');
            for (const m of result.missing) console.log('  ✗ MISSING ' + m);
          }
          console.log(cxLine);
          for (const w of result.warnings) console.log('  ⚠ warn: ' + w);
          for (const o of result.overridden) console.log('  ↷ overridden: ' + o.id + ' — "' + o.note + '"');
          // An un-judgeable rule must be LOUD: a stale synced rules file that silently drops a rule is exactly
          // the failure this degrade path exists to make visible.
          for (const u of result.unevaluated) console.log('  ⚠ unevaluated: ' + u.id + ' — ' + u.reason);
        }
        process.exitCode = result.ok ? 0 : 3;
      }
    } else {
      printUsage();
      process.exitCode = 2;
    }
  } catch (e) {
    console.error('forge-runcontract: ' + e.message);
    process.exitCode = 2;
  }
}
