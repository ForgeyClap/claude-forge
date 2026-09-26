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
const crypto = require('crypto');

const RULES_PATH = path.join(__dirname, '..', 'config', 'orchestration', 'FORGE_HARD_RULES.json');
const DEFAULT_ROOT = path.resolve(__dirname, '..', '..');

const KNOWN_TRIGGER_LITERALS = new Set(['always', 'web', 'correctness-critical']);
const KNOWN_CHECK_TYPES = new Set(['event-present', 'artifact-present', 'doctor-check', 'independent-verification']);
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
  /** R10-04: de hash hoort bij de EXACT gelezen bytes van dit proces — zie het resultaatveld
   *  `ruleset_sha256_used` waarmee finalize het A→B→A-venster rond de contractcheck sluit. */
  const rawSha = crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
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
    // KEYLOZE CHECKTYPES (2026-08-09): een check die de HELE eventstroom beoordeelt i.p.v. op een
    // eventnaam te matchen heeft per definitie geen `key`. Ze staan expliciet in deze set — een
    // TYPFOUT in een key-gebaseerd type blijft dus gewoon een harde configfout.
    const KEYLESS_CHECK_TYPES = new Set(['doctor-check', 'independent-verification']);
    if (!KEYLESS_CHECK_TYPES.has(r.check.type)) {
      if (r.check.key == null || !(typeof r.check.key === 'string' ? r.check.key.length > 0 : (Array.isArray(r.check.key) && r.check.key.length > 0))) {
        throw new Error('forge-runcontract: rule "' + r.id + '" has an invalid/empty check.key in ' + p);
      }
    } else if (r.check.key != null) {
      throw new Error('forge-runcontract: rule "' + r.id + '" is a keyless check type (' + r.check.type + ') but carries a check.key in ' + p + ' — remove it so the rule cannot silently look key-driven');
    }
    /** F-07 (Codex-review 2026-08-09, high — GEMETEN op de echte productieconfig): de belofte staat in
     *  VRIJE TEKST (`override: "UN-OVERRIDABLE — ..."`) maar de handhaving hangt aan een BOOLEAN
     *  (`cannot_override`, zie de override-lookup verderop). Niets verbond die twee, dus de regel die
     *  zelf-goedkeuring verbiedt was zélf wegdrukbaar met een geldige owner_override — gereproduceerd:
     *  hij verscheen gewoon in `overridden`. Een belofte die niet afdwingbaar is, is erger dan geen
     *  belofte: hij wekt vertrouwen dat de code niet waarmaakt. Daarom is de tekst nu bindend. */
    if (/UN-?OVERRIDABLE/i.test(String(r.override || '')) && r.cannot_override !== true) {
      throw new Error('forge-runcontract: rule "' + r.id + '" declares UN-OVERRIDABLE in its override text but does not carry cannot_override:true in ' + p + ' — the promise is enforced by the boolean, not by prose, so without it a valid owner_override silently clears this rule');
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

  _rulesCache = { path: p, sha256: rawSha, data, unknownTriggers };
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

let _manifestCache; // undefined = not yet attempted, null = load failed, object = loaded module
function loadManifestTool() {
  if (_manifestCache !== undefined) return _manifestCache;
  try { _manifestCache = require('./forge-manifest.cjs'); } catch { _manifestCache = null; }
  return _manifestCache;
}

// ---- manifest completeness (RC-MANIFEST-STALE, 2026-09-24, out-p5.md — companion to isStalingEvent above) ---
// The isStalingEvent fix above catches "armed AFTER a review". This catches the plainer case: a manifest was
// armed once, a package never finished, and nothing after it ever re-reviewed — the run can still show
// missing:[] for evidence-satisfied/verify-checked because those rules only ever asked "was ANY accepted
// evidence event logged", never "did the run's OWN declared plan actually finish". A named, owner-authenticated
// skip is the one legitimate way to close an armed package without a completion event.
const MANIFEST_SKIP_RULE = 'manifest-complete';
const MANIFEST_GATED_RULE_IDS = ['evidence-satisfied', 'verify-checked'];
/** findManifestSkip(events, wpId, ownerAllowlist) -> {reason,by}|null — the SAME owner_override shape and
 *  the SAME allow-list findOwnerOverride() enforces, additionally bound to ONE named wp_id: event_type
 *  'owner_override', rule EXACT 'manifest-complete', wp_id EXACT match, a meaningful reason, `by` in the
 *  configured owner allow-list. Fail-closed like every other override lookup in this file: no id, no reason,
 *  or no configured allow-list means no skip is ever recognized. */
function findManifestSkip(events, wpId, ownerAllowlist) {
  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    if (typeof e.event_type !== 'string' || e.event_type.toLowerCase() !== 'owner_override') continue;
    if (typeof e.rule !== 'string' || e.rule !== MANIFEST_SKIP_RULE) continue;
    if (e.wp_id == null || String(e.wp_id) !== String(wpId)) continue;
    if (!isMeaningfulReason(e.reason, MANIFEST_SKIP_RULE)) continue;
    const by = (typeof e.by === 'string') ? e.by.trim() : '';
    if (!by || !ownerAllowlist.has(by.toLowerCase())) continue;
    return { reason: String(e.reason).trim(), by };
  }
  return null;
}
/** manifestCompleteness(root, runId, events, ownerAllowlist) -> {applicable, ok, outstanding:[{wp_id,status}],
 *  reason?}
 *  Reads the run's OWN manifest.json (via forge-manifest.cjs's `load()`) and projects its real status purely
 *  from this run's events (forge-manifest.cjs's own pure `projectManifest()` — never writes, never re-derives
 *  a second projection algorithm). A project without forge-manifest.cjs, or a run that never armed one, is
 *  simply NOT APPLICABLE — never a fabricated block on a run that used no manifest at all.
 *
 *  V21 (2026-09-24 second Codex recheck, out-p7.md) — every `mod.load()` exception used to collapse to the
 *  SAME `{applicable:false, ok:true}` "never armed" outcome, whether the manifest was genuinely never armed
 *  (ENOENT) or was ARMED and then corrupted, made unreadable (EACCES), or deleted outright. REPRODUCED: an
 *  armed-but-unfinished manifest made the contract red; replacing manifest.json with malformed JSON, or
 *  injecting an EACCES on read, made the SAME run green again — corrupting the mandatory-work record was
 *  strictly BETTER for the run than leaving it intact. `manifest_armed` (see `isStalingEvent` above) is this
 *  run's own event-logged proof that a manifest WAS armed; when that event is present, a `load()` failure of
 *  ANY kind is a genuine defect in required evidence — reported `applicable:true, ok:false` with the reason —
 *  never silently downgraded to "not applicable". Only a run whose events never recorded arming at all stays
 *  NOT APPLICABLE, matching every other run that used no manifest. `hasEvent()` already excludes a disproven
 *  `manifest_armed` claim (content-oracle proof_verified:false), so a fabricated arming claim does not count
 *  as "armed" here either.
 *
 *  V21 (2026-09-24 THIRD Codex recheck, out-p8.md remaining gap) — the module-unavailable branch below ran
 *  BEFORE `armed` was even computed, so forcing `loadManifestTool()`'s require() itself to fail (a genuinely
 *  incomplete/damaged installation, not just a missing manifest.json for this one run) collapsed straight to
 *  the SAME "never armed" `{applicable:false, ok:true}` outcome even for a run whose OWN events already
 *  recorded `manifest_armed`. REPRODUCED: an armed fixture with a forced module-load failure reported
 *  `{ok:true, missing:[]}` exactly like a run that used no manifest at all. `armed` is now checked FIRST — an
 *  armed run whose loader is unavailable is a genuine defect (`applicable:true, ok:false`), never silently
 *  reclassified as not-applicable; only a run that never armed anything stays not-applicable, matching every
 *  other module-load failure path in this function. */
function manifestCompleteness(root, runId, events, ownerAllowlist) {
  const armed = hasEvent(events, 'manifest_armed');
  const mod = loadManifestTool();
  if (!mod || typeof mod.load !== 'function' || typeof mod.projectManifest !== 'function') {
    if (armed) {
      return { applicable: true, ok: false, outstanding: [], reason: 'manifest_armed is logged for this run but forge-manifest.cjs (load/projectManifest) is unavailable — an armed run\'s declared obligations cannot be silently discarded because the loader module itself is missing or incomplete' };
    }
    return { applicable: false, ok: true, outstanding: [] };
  }
  let wps;
  try { wps = mod.load(runId, { root }); }
  catch (e) {
    if (armed) {
      return { applicable: true, ok: false, outstanding: [], reason: 'manifest_armed is logged for this run but the manifest could not be loaded (' + (e && e.message ? e.message : String(e)) + ') — a corrupted or missing manifest after arming is a defect, never a silent pass' };
    }
    return { applicable: false, ok: true, outstanding: [] }; // no manifest ever armed for this run
  }
  const projected = mod.projectManifest(wps, events);
  const outstanding = [];
  for (const wp of projected) {
    if (wp.status === 'done') continue;
    if (findManifestSkip(events, wp.wp_id, ownerAllowlist)) continue;
    outstanding.push({ wp_id: wp.wp_id, status: wp.status });
  }
  return { applicable: true, ok: outstanding.length === 0, outstanding };
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
function readEventsJsonl(eventsPath, runId) {
  // AUDIT G6 (2026-08-06): een onparseerbare regel werd hier STIL geskipt — een afgekapte staart (crash
  // mid-append) of een corrupte middenregel verdween geruisloos uit het bewijs waar dit CONTRACT zijn
  // block-oordeel op velt. Een completion-gate is fail-closed: de centrale classifier (log-event.cjs,
  // missing|empty|partial|corrupt|valid) beslist, en alles behalve valid/empty is een harde weigering
  // met de exacte toestand en regelnummers — nooit "die regel telt gewoon niet mee".
  // BEWUST de EIGEN module (__dirname-relatief), nooit de writer van de doel-root: een vreemde root kan
  // daar elk willekeurig script hebben staan en require() VOERT dat uit (de eigen testfixture bewees het
  // — een capture-stub draaide mee als "classifier"). Classificatie is puur lezen; onze module volstaat.
  let cls = null;
  try {
    const M = require(path.join(__dirname, '..', 'forge-dashboard', 'log-event.cjs'));
    // Codex r5 #6 (2026-08-07): het CONTRACT leest met de STRIKTE bril — schema + hashketen + run-binding.
    // Een omgezet event met een stale hash of een geketend event van een andere run is hier corrupt.
    if (M && typeof M.readEventsClassified === 'function') cls = M.readEventsClassified(eventsPath, { verifyChain: true, runId });
  } catch (e) {
    /** R3-06 (derde herreview): de terugval parseert alleen JSON en verifieert de HASHKETEN NIET. Op een
     *  beschadigde installatie werd een completion-oordeel daarmee fail-OPEN: oudere entries konden zijn
     *  gewijzigd zonder dat iets dat opmerkte, terwijl de poort gewoon groen gaf. Een contractcheck zonder
     *  ketenvalidatie is geen contractcheck — dus geen stille terugval meer, maar een harde fout. */
    throw new Error('forge-runcontract: de event-classifier (.claude/forge-dashboard/log-event.cjs) kon niet worden geladen: ' + (e && e.message ? e.message : String(e)) + ' — zonder ketenvalidatie is een completion-oordeel niet te vertrouwen, dus fail-closed');
  }
  if (!cls) {
    throw new Error('forge-runcontract: de event-classifier levert geen readEventsClassified() — deze installatie kan de hashketen niet verifieren, dus geen completion-oordeel (fail-closed)');
  }
  if (cls) {
    if (cls.status === 'missing') throw new Error('forge-runcontract: could not read events file ' + eventsPath + ': ' + (cls.error || 'missing'));
    if (cls.status === 'partial' || cls.status === 'corrupt') {
      /** WP-S13 (2.2, 2026-09-26 laptop re-audit, review C VERDICT FAIL) — this is a FACT about the run's
       *  OWN log (a genuinely damaged/tampered chain), never a tool/environment problem. Tagged so a
       *  caller like forge-certify.cjs's contractState() can tell "this run's log is damaged" apart from
       *  "this tool could not evaluate at all" (module missing, no rules file) WITHOUT re-implementing the
       *  classifier's own judgement or fragile string-matching the message. See forgeLogDamaged's doc at
       *  its one other use site (contractState) for why the distinction matters. */
      const err = new Error('forge-runcontract: events log is ' + cls.status.toUpperCase() + ' (regel ' + cls.badLines.map((b) => b.line + (b.reason ? ':' + b.reason : '')).join(',') + ') — a completion contract never judges a damaged log (fail-closed); repair or investigate ' + eventsPath);
      err.forgeLogDamaged = true;
      throw err;
    }
    return cls.entries;
  }
  let raw;
  try { raw = fs.readFileSync(eventsPath, 'utf8'); }
  catch (e) { throw new Error('forge-runcontract: could not read events file ' + eventsPath + ': ' + e.message); }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // strip BOM
  const events = [];
  let lineNo = 0;
  for (const line of raw.split(/\r?\n/)) {
    lineNo++;
    const s = line.trim();
    if (!s) continue;
    try { events.push(JSON.parse(s)); }
    catch {
      // net als hierboven: een onparseerbare regel is een feit over DEZE log, geen infrastructuurfout.
      const err = new Error('forge-runcontract: events log has an unparseable line ' + lineNo + ' — fail-closed (was: silently skipped)');
      err.forgeLogDamaged = true;
      throw err;
    }
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

/** eventIsDisproven(e) — mirrors forge-manifest.cjs::eventIsDisproven(): log-event.cjs's own CONTENT
 *  ORACLE already flagged this event's pass-claim as false (non-zero exit code / missing-or-blank proof
 *  artifact). Such an event is a CLAIM, not evidence.
 *  V23 (2026-09-24 second Codex recheck, out-p7.md) — delegates to the ONE shared predicate in
 *  forge-proof-gate.cjs (also consulted by forge-verify.cjs's taskStatus()) so this file's independent-
 *  review protocol and the task-closure path can never again disagree about what counts as disproven.
 *  Falls back to the identical inline check if the sibling is ever unreachable. */
let _proofGateCache; // undefined = not yet attempted, null = load failed, object = loaded module
function loadProofGate() {
  if (_proofGateCache !== undefined) return _proofGateCache;
  try { _proofGateCache = require('./forge-proof-gate.cjs'); } catch { _proofGateCache = null; }
  return _proofGateCache;
}
function eventIsDisproven(e) {
  const pg = loadProofGate();
  if (pg && typeof pg.isDisprovenEvent === 'function') return pg.isDisprovenEvent(e);
  return !!(e && e._forge_verify && e._forge_verify.proof_verified === false);
}

/** RC-CLAIMS-AS-PROOF (2026-09-24 Codex re-review, out-p5.md) — hasEvent() used to match on `event_type`
 *  alone, so an event the writer's own content oracle already flagged as false
 *  (`_forge_verify.proof_verified === false`) still satisfied any rule keyed to its type. REPRODUCED: seven
 *  claimed events, each stamped proof_verified:false, produced CONTRACT OK with no real work or check ever
 *  executed. A disproven claim is now rejected outright — never counted as satisfying evidence.
 *  SCOPE NOTE (honesty): the fuller ask ("require the evidence reference fields the rule names — path/
 *  tally/exit code — to be present") is NOT implemented for every event-present rule in this pass. Most
 *  event-present rules (memory-read, owner-prefs-loaded, research-done, dispatch-logged, …) are narrative
 *  one-shot facts with no natural path/tally/exit-code payload at all — inventing a required field for them
 *  would need a FORGE_HARD_RULES.json schema change (check.evidence_fields) that is out of this file's
 *  edit scope for this work package (that config is governed elsewhere) and would need a coordinated
 *  fixture migration across ~30 historical runs and this project's own test suites to avoid a mass false-
 *  red regression. The concrete, reproduced exploit (a disproven claim counting as proof) is fixed
 *  unconditionally here; the broader schema-level evidence-grammar requirement is DEFERRED — see this
 *  work package's report for the explicit classification. */
function hasEvent(events, key) {
  const wanted = toArray(key).map((t) => String(t).toLowerCase());
  if (wanted.length === 0) return false;
  return events.some((e) => e && typeof e === 'object' && typeof e.event_type === 'string'
    && wanted.includes(e.event_type.toLowerCase()) && !eventIsDisproven(e));
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
/** independentVerification(events) — WIE bevestigde de claim? (research-lane A, 2026-08-09)
 *  Het defect dat dit sluit is gemeten en gereproduceerd: de un-overridable `verify-checked`-regel werd
 *  bevredigd door ELK check_passed-event, ongeacht wie het logde. Een Boss kon dus zijn eigen werk
 *  goedkeuren en CONTRACT OK krijgen (RED-baseline: red-baseline-imp001.txt). Externe onderbouwing:
 *  self-preference bias bij LLM-als-jury (arXiv:2410.21819) en Anthropic's eigen subagent-richtlijn om
 *  review door een CONTEXT-GEÏSOLEERDE agent te laten doen.
 *
 *  Een run telt als onafhankelijk geverifieerd zodra ÉÉN van deze drie waar is — elk is een echte,
 *  gelogde gebeurtenis, geen vertrouwensverklaring:
 *   (1) DIVERSITEIT — een pass-claim (check_passed/quality_gate_passed/retest_completed) is gelogd door
 *       een agent die in deze run GEEN werk-event logde (de waarnemer is niet de uitvoerder);
 *   (2) EXTERNE REVIEWER — een event met runtime 'codex' (of een verify_result/codex_review-event):
 *       een onafhankelijke reviewer buiten deze agent heeft echt gedraaid;
 *   (3) EXPLICIETE ATTRIBUTIE — een pass-claim draagt `verified_by` met een andere naam dan zijn eigen
 *       `agent`; dat maakt de tweede waarnemer expliciet en controleerbaar in de log.
 *  Geeft {ok, route, workers, verifiers, reason} terug — de reden gaat mee in de contract-uitvoer zodat
 *  een rode uitslag zegt WAT er ontbreekt, niet alleen DAT er iets ontbreekt. */

/** Waarom niet "elke agent die iets logde": `run_started`, notities en audit-events zijn geen werk, en
 *  die actor-benadering maakte `run_started(A) + review(B)` tot een geldige verificatie van een run
 *  waarin NIEMAND iets deed (F-06). Zie de omkering hieronder voor hoe "werk" nu wordt bepaald. */
/** NON_WORK_EVENT_TYPES — de OMKERING (R3-01, derde herreview 2026-08-09).
 *
 *  Twee rondes lang was dit een allowlist van "werk". Die faalt structureel ONVEILIG: elk eventtype dat
 *  je vergeet — of dat later wordt toegevoegd — telt dan automatisch NIET als werk, waardoor de
 *  uitvoerder buiten de werkersverzameling valt en zichzelf mag goedkeuren. Ronde 2 vond zo zes gaten
 *  (report_generated, prd_generated, …), ronde 3 nóg een (`research_done`). Een lijst die je moet
 *  aanvullen om veilig te blijven, is de verkeerde vorm.
 *
 *  Daarom omgekeerd: ALLES is werk, tenzij het hier expliciet als niet-werk staat. Vergeet je iets, dan
 *  is de uitkomst STRENGER (te veel als werk geteld), niet zwakker. Deze lijst bevat uitsluitend events
 *  die per definitie niets produceren of veranderen: lifecycle, waarnemingen, notities, audit en de
 *  review-events zelf. Een parametrische test toetst elk geregistreerd type tegen deze indeling, zodat
 *  een nieuw type niet stilzwijgend in de verkeerde bak belandt. */
const NON_WORK_EVENT_TYPES = new Set([
  // lifecycle
  'run_started', 'run_completed', 'run_finalized',
  // waarnemen/laden — leest, verandert niets
  'project_scanned', 'profile_loaded', 'memory_loaded', 'skill_loaded', 'file_read', 'owner_prefs_loaded',
  'claude_md_checked', 'project_skill_dir_checked', 'ecc_inventory',
  /** DISPATCH — bewust non-work, met reden: `agent_started`/`subagent_started` worden door de LEAD gelogd
   *  OVER een agent, inclusief over de reviewer zelf. Telden die als werk, dan zou elke gedispatchte
   *  reviewer automatisch uitvoerder zijn en kon niemand ooit reviewen — de poort zou zichzelf blokkeren.
   *  Dit is dus geen vergeten geval maar een gemotiveerde uitzondering. */
  'agent_selected',
  /** R5-01 (vijfde herreview): `agent_progress`, `check_started`, `fix_started`, `retest_started`,
   *  `merge_started` en `rework_started` stonden hier ook, maar de writer en het dashboard behandelen ze
   *  als ACTIEVE UITVOERING. Een reviewer die zelf `fix_started` logde bleef daardoor "buitenstaander",
   *  en zulke activiteit ná een review maakte hem niet stale. Ze zijn nu werk: wie begint te fixen,
   *  voert uit. */
  // zuiver narratief: een aantekening of een volgende-stap is geen uitkomst
  'agent_note', 'agent_next_action',
  // governance/audit
  'owner_override', 'gate_evaluated',
  /** 2026-09-24 (run forge-2026-09-24-config-v250): `manifest_armed` is the arm TOOL's own proof over run
   *  bookkeeping (.claude/forge-runs/<run>/manifest.json) — the same family as `gate_evaluated`: it records
   *  that a Forge tool ran, produces nothing of the reviewed product, and cannot make a review stale (the
   *  reviewed subject is code + gates, never the run's own bookkeeping). The plan CONTENT lives in
   *  `agent_work_package_created`, which stays work (for STALENESS — see isStalingEvent) but, per the D3
   *  fix below, is no longer attributed to its `agent` field as that agent doing work — see
   *  ASSIGNMENT_EVENT_TYPES. Found because forge-manifest.cjs logged this proof without an agent, which
   *  N-01 read as anonymous work and blocked finalize; the tool now stamps the orchestrator as well, so
   *  both the classification and the attribution are right. */
  'manifest_armed',
  /** R4-02 (vierde herreview): hier stonden ook `agent_output`, `decision_logged`, `rework_assigned` en
   *  `rejected_approach`. Dat was fout, en precies de valkuil van de omkering: de uitzonderingslijst mag
   *  alleen INERTE events bevatten. `rejected_approach` eist bij de writer zelfs BEWIJS en geldt later als
   *  vertrouwd resultaat; `agent_output` en `decision_logged` leveren inhoud op. Een reviewer die zoiets
   *  zelf produceerde viel daardoor buiten de werkersverzameling, en zulk werk ná een review maakte hem
   *  niet stale. Ze zijn nu gewoon werk — wie iets oplevert, is een uitvoerder. */
]);
/** ASSIGNMENT_EVENT_TYPES (D3 fix, 2026-09-26 fresh-laptop re-audit; NARROWED by the 2.3 fix, WP-S13,
 *  same date, review C VERDICT FAIL) — an event that only ANNOUNCES who a work package is assigned to,
 *  logged by the Lead ABOUT another agent (forge.md:89), never by that agent about itself, and carrying
 *  NO proof the agent was actually dispatched (no dispatch_id, no runtime, no allowed-actions — a bare
 *  plan). It stays a work-type event for isWorkEvent/isStalingEvent (new planned work still makes a prior
 *  "everything reviewed" verdict stale), but its `agent` field must never be read as that agent doing work
 *  in independentVerification's worker-attribution loop — see the call site below.
 *
 *  2.3 REGRESSION FIX: the original D3 fix put `custom_subagent_created` in this set too, unconditionally
 *  exempting it from worker attribution. That event is NOT a bare plan — the un-overridable
 *  `dispatch-logged` rule (FORGE_HARD_RULES.json) accepts it as REAL proof an agent was dispatched
 *  (dispatch_id, mission, allowed actions), exactly like `agent_started`/`subagent_started`.
 *  REPRODUCED: `custom_subagent_created {agent:"Review Boss", role:"implementer", mission:"implement X"}`
 *  with no later event naming Review Boss let Review Boss's own later approval pass as independent —
 *  before D3 this was correctly blocked as self-approval. Moved to IV_DISPATCH_TYPES below, where it now
 *  gets the exact same `!isReviewDispatch(e)` gating as the other two real dispatch events: it counts as
 *  work UNLESS the event itself proves it was a review assignment. Only `agent_work_package_created` (the
 *  bare, unproven plan) stays unconditionally exempt here. */
const ASSIGNMENT_EVENT_TYPES = new Set(['agent_work_package_created']);
/** IV_DISPATCH_TYPES — `agent_started`/`subagent_started`/`custom_subagent_created` worden door de Lead
 *  gelogd OVER een agent, maar zijn stuk voor stuk ECHT dispatchbewijs (dispatch_id/mission/allowed
 *  actions) — geen kaal plan.
 *
 *  R6-02 (zesde herreview) weerlegde mijn eerdere aanname dat ze daarom categorisch geen werk zijn: een
 *  probe met `agent_started {agent:"Review Boss", task:"implement patch"}` liet de log letterlijk zien dat
 *  de bevestiger voor IMPLEMENTATIE was gedispatcht, terwijl de poort hem als buitenstaander behandelde.
 *  Ik had die uitzondering zelf al gemarkeerd als het punt waar ik twijfelde — terecht.
 *
 *  Nu omgekeerd: een dispatch is WERK, tenzij hij aantoonbaar een REVIEW-opdracht is. Bewijzen dat je
 *  voor review bent ingezet ligt bij het event; ontbreekt dat bewijs, dan is de veilige lezing dat er
 *  uitvoerend werk is gedispatcht. `custom_subagent_created` volgt vanaf de 2.3-fix (WP-S13) exact
 *  dezelfde regel — zie ASSIGNMENT_EVENT_TYPES hierboven voor waarom hij daar is weggehaald. */
const IV_DISPATCH_TYPES = new Set(['agent_started', 'subagent_started', 'custom_subagent_created']);
/** R7-04 (zevende herreview) — MIJN EIGEN R6-02-FIX WAS TE RUIM. Het volstond dat "review" ergens in een
 *  vrij tekstveld voorkwam, dus `task: "implement review feedback"` gold als reviewopdracht: precies de
 *  implementatie-dispatch die R6-02 juist moest vangen. Vrije tekst laten beslissen over een
 *  veiligheidsgrens is de fout; een woord dat toevallig voorkomt is geen bewijs van intentie.
 *
 *  Nu twee eisen tegelijk: (1) een expliciet, gestructureerd veld dat de rol vastlegt, en (2) die rol
 *  moet de HELE waarde zijn, niet een woord in een zin. Zo blijft een dispatch die naar review verwijst
 *  maar iets anders doet gewoon werk — de veilige lezing. */
/** R8-01 (achtste herreview) — IK MAAKTE DEZELFDE FOUT ALS BIJ R3-01, één laag dieper. Mijn R7-04-fix
 *  gebruikte een DENYLIST van uitvoeringswerkwoorden (implement|fix|patch|…): alles wat daar niet in
 *  stond, gold als review. `task: "develop production feature"` kwam er dus gewoon door. Een denylist
 *  faalt open op precies de gevallen die je niet hebt bedacht — dat is de fout die ik bij de
 *  work-taxonomie al had omgekeerd en hier opnieuw introduceerde.
 *
 *  Nu POSITIEF BEWIJS aan beide kanten: een dispatch telt alleen als review wanneer het rolveld exact een
 *  reviewrol is EN de taak — als die er is — zelf aantoonbaar reviewwerk beschrijft. Onbekende of
 *  onbeschreven taken vallen aan de strenge kant: werk. */
const REVIEW_ROLE_RE = /^(review|reviewer|independent[ _-]?review|code[ _-]?review|verify|verification|audit|controle)$/i;
const REVIEW_TAAK_RE = /^(?:[a-z ]*\b(?:review|reviewing|verify|verifying|verification|audit|auditing|inspect|inspection|assess|assessment|controleer|controle|beoordeel|beoordeling)\b[a-z0-9 _./:#-]*)$/i;
/** R9-01 (negende herreview): mijn "positief bewijs" was nog steeds te ruim. Drie gaten bleven open:
 *   - een reviewrol ZONDER taak gold als review — terwijl "waarvoor is deze agent ingezet" dan juist
 *     onbekend is, en onbekend hoort aan de strenge kant te vallen;
 *   - `task:"review and implement production feature"` paste op de reviewregex, want die keek of de
 *     zin ergens reviewwoorden bevatte in plaats van of hij UITSLUITEND review beschrijft;
 *   - `role:"review"` naast `dispatch_role:"implementation"` telde als review: één passend veld won van
 *     een tegenstrijdig veld, precies de "verstop een afkeuring"-vorm uit R5-02.
 *  Nu: ALLE aanwezige rolvelden moeten een reviewrol zijn (geen tegenspraak), er MOET een taak zijn, en
 *  die taak mag geen uitvoerende component bevatten. */
/** R10-01 — DERDE KEER DEZELFDE FOUT. R3-01 leerde: een lijst die je moet aanvullen om veilig te blijven
 *  is de verkeerde vorm. In R8-01 bouwde ik hem toch als denylist van uitvoeringswerkwoorden, en in R9-01
 *  breidde ik die denylist uit in plaats van hem om te keren. Nu komt `task:"review code and update
 *  production source"` erdoor, want "update" stond er niet in. Elke uitbreiding lost één geval op en laat
 *  de rest open.
 *
 *  Daarom nu een echte ALLOWLIST op tokenniveau: elk woord in de taak moet uit een kleine, vaste
 *  reviewwoordenschat komen (of een onschuldige verwijzing zijn zoals WP2, #123, een pad). Eén onbekend
 *  woord — welk woord dan ook — maakt het uitvoerend werk. Vergeet ik een legitiem reviewwoord, dan valt
 *  een echte review ten onrechte af en vraagt iemand om herformulering; dat is de goede richting om in te
 *  falen. */
const REVIEW_WOORDEN = new Set([
  'review', 'reviewing', 'reviewed', 'rereview', 're-review', 'code-review', 'codereview',
  'verify', 'verifying', 'verification', 'validate', 'validating', 'validation',
  'audit', 'auditing', 'inspect', 'inspecting', 'inspection', 'assess', 'assessing', 'assessment',
  'check', 'checking', 'controleer', 'controle', 'beoordeel', 'beoordeling', 'nakijken', 'toets', 'toetsen',
  'independent', 'onafhankelijk', 'onafhankelijke', 'of', 'the', 'a', 'an', 'de', 'het', 'een', 'van',
  'and', 'en', 'op', 'in', 'for', 'voor', 'this', 'deze', 'dit', 'run', 'diff', 'patch', 'pr', 'commit',
  'changes', 'wijzigingen', 'work', 'werk', 'package', 'pakket', 'only', 'alleen', 'read-only',
]);
const ONSCHULDIGE_VERWIJZING_RE = /^(?:wp[-_]?\d+|#\d+|[a-f0-9]{7,40}|[\w./-]+\.(?:js|cjs|mjs|ts|json|md)|\d+)$/i;
/** N6 fix (2026-09-26 independent review, LOW) — this used to read ONLY `e.task`, but the documented
 *  `custom_subagent_created` event (commands/forge.md step 5: "log `custom_subagent_created` with: name ·
 *  role · why needed · project evidence · mission · inputs · ...") carries `mission`, never `task`. A
 *  custom reviewer dispatched EXACTLY as documented (role:"review", mission:"review the auth diff") could
 *  never be recognised as a review dispatch — it always counted as work, which fails CLOSED (safe) but
 *  wrongly blocks that reviewer's own later approval as self-approval. Now both `task` and `mission` are
 *  accepted; TAAK_VELDEN below is checked with the same "every present field must independently read as
 *  review-only, one contradiction drops the claim" discipline already used for the role fields above — a
 *  dispatch carrying `task:"implement X"` alongside `mission:"review Y"` still counts as work, the safe
 *  reading, never review just because one of the two fields looks like review. */
const TAAK_VELDEN = ['task', 'mission'];
function isReviewDispatch(e) {
  if (!e || typeof e !== 'object') return false;
  // Alleen gestructureerde rolvelden tellen — `note`/`goal` zijn narratief en beslissen hier niets meer.
  const rolVelden = ['role', 'dispatch_role', 'purpose'].filter((f) => typeof e[f] === 'string' && e[f].trim() !== '');
  if (!rolVelden.length) return false;
  // Eén tegenstrijdig rolveld is genoeg om de reviewclaim te laten vervallen.
  if (!rolVelden.every((f) => REVIEW_ROLE_RE.test(e[f].trim()))) return false;
  // F5 fix (2026-09-26 independent review, NOTE): a PRESENT but NON-string task/mission (e.g. a number or
  // object) used to be silently filtered out below exactly like a genuinely ABSENT field — if the OTHER
  // field happened to be pure review text, the dispatch was wrongly classified as review-only with an
  // unexamined non-string value hiding behind it. Same "one contradiction is enough" discipline as the role
  // fields above: a present-but-wrong-shape task/mission poisons the whole claim -> counts as work (false),
  // the safe reading. `null`/`undefined` still mean "not present at all" and fall through to the normal
  // string filter below.
  for (const f of TAAK_VELDEN) {
    if (e[f] !== undefined && e[f] !== null && typeof e[f] !== 'string') return false;
  }
  // Zonder taak/mission is onbekend waarvoor de agent is ingezet — dat is geen bewijs van review.
  const taakVelden = TAAK_VELDEN.filter((f) => typeof e[f] === 'string' && e[f].trim() !== '');
  if (!taakVelden.length) return false;
  /** ALLOWLIST (R10-01, uitgebreid met `mission` door N6): elk woord in ELK aanwezig taakveld moet uit de
   *  reviewwoordenschat komen of een onschuldige verwijzing zijn. Eén onbekend woord — in `task` OF
   *  `mission` — maakt het uitvoerend werk; een aanwezig veld dat niet puur review beschrijft laat de hele
   *  claim vervallen, ook als het andere veld wel puur review beschrijft. */
  for (const f of taakVelden) {
    const taak = e[f].trim();
    const woorden = taak.toLowerCase().split(/[\s,;:()[\]]+/).filter(Boolean);
    if (!woorden.length) return false;
    if (!woorden.some((w) => /review|verif|validat|audit|inspect|assess|controle|beoorde|toets|nakijk/.test(w))) return false;
    if (!woorden.every((w) => REVIEW_WOORDEN.has(w) || ONSCHULDIGE_VERWIJZING_RE.test(w))) return false;
  }
  return true;
}
function isWorkEventType(type) {
  return !NON_WORK_EVENT_TYPES.has(type) && !REVIEW_START_TYPES.has(type) && !REVIEW_DONE_TYPES.has(type);
}
/** isWorkEvent(e) — de EVENT-variant: kijkt ook naar de inhoud, want bij een dispatch bepaalt de opdracht
 *  of het werk of review was. Alle andere types volgen puur hun type. */
function isWorkEvent(e) {
  const type = e && typeof e.event_type === 'string' ? e.event_type.toLowerCase() : '';
  if (!type) return false;
  if (IV_DISPATCH_TYPES.has(type)) return !isReviewDispatch(e);
  return isWorkEventType(type);
}
/** Het CAUSALE reviewprotocol op eventtypes die de writer echt registreert (F-08). Een completion telt
 *  alleen met een eerdere start van DEZELFDE reviewer onder hetzelfde review_id. */
/** R5-06 (zelf gevonden bij het draaien van ronde 5):  hoort NIET in dit protocol.
 *  forge-verify.cjs logt lead_review_completed juist BIJ EEN MISMATCH, als trigger voor rework — het is
 *  een afkeuring, geen goedkeuring. Codex wees daar in R4-01 al op; ik had het type toen laten staan
 *  omdat de verdict-eis het toch zou tegenhouden. Dat is te slim: een eventtype dat 'review afgerond'
 *  heet maar 'er is werk mislukt' betekent, hoort geen kandidaat te zijn. Weg uit beide sets. */
const REVIEW_START_TYPES = new Set(['review_started', 'codex_review_started']);
const REVIEW_DONE_TYPES = new Set(['review_completed', 'codex_review_completed']);
/** R4-01: alleen een EXPLICIET goedkeurend verdict telt. Bewust een korte, gesloten lijst: alles wat er
 *  niet in staat — CHANGES_REQUIRED, blocked, of niets — is geen goedkeuring. */
const POSITIEVE_REVIEW_VERDICTS = new Set(['pass', 'passed', 'approved', 'ok', 'akkoord', 'goedgekeurd']);
/** Events die een eerdere review STALE maken (F-04): alles wat het beoordeelde subject nog kan veranderen. */
// staleness volgt exact dezelfde definitie: alles wat het beoordeelde subject nog kan veranderen
/** Staleness volgt de werkdefinitie, PLUS `owner_override` (R6-03, zesde herreview): een override kan een
 *  ontbrekende contractregel rechtstreeks opheffen, waardoor het contract ná het oordeel van "niet klaar"
 *  naar "klaar" verschuift zonder dat er ooit opnieuw is gekeken. De owner is daarmee géén uitvoerder —
 *  hij hoort niet in de werkersverzameling — maar zijn ingreep maakt een eerdere review wel verouderd. */
/** RC-MANIFEST-STALE (2026-09-24 Codex re-review, out-p5.md) — REVERSES the 2026-09-24 Lead decision
 *  recorded in FORGE_DECISIONS.md ("Poortclassificatie aangepast met reden"), which read `manifest_armed`
 *  as fully inert because it "produces nothing of the reviewed product, same family as gate_evaluated".
 *  That reasoning conflated two DIFFERENT questions this file asks about every event:
 *    isWorkEvent    — did this event itself EXECUTE or PRODUCE something (decides who may not self-review);
 *    isStalingEvent — can a PRIOR review still be trusted about the CURRENT state of the run.
 *  Those are not the same axis. Arming a NEW work package after a review closed does not retroactively turn
 *  the arming agent into an "executor" of that work — so manifest_armed correctly stays OUT of isWorkEvent
 *  (the earlier decision was right about that half). But it DOES mean the reviewed subject just changed:
 *  there is now unreviewed, still-armed work sitting in the run that a prior "everything looked done" review
 *  could not possibly have judged, because it did not exist yet when that review ran. Treating it as inert
 *  for BOTH axes let a green independent-review survive an arm-after-review with no re-check at all.
 *  REPRODUCED (out-p5.md): arming a package after a green L2 review, through the real arm path, kept
 *  `missing:[]` / `review.ok:true`. Removing only the manifest_armed exemption from isStalingEvent in memory
 *  restored `missing:["independent-verification"]` — proving this one-line exemption, not some other defect,
 *  was the whole gap. See manifestCompleteness() below for the companion half: even without a NEW arm-after-
 *  review event, an armed package that simply never finished must not let evidence-satisfied/verify-checked
 *  read as satisfied either. */
function isStalingEvent(e) {
  const type = e && typeof e.event_type === 'string' ? e.event_type.toLowerCase() : '';
  return type === 'owner_override' || type === 'manifest_armed' || isWorkEvent(e);
}
const SHA1_RE = /^[0-9a-f]{40}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/i;

/** independentVerification(events, opts) -> {ok, route, workers, reviewer, reason, review}
 *  opts.noGit (D2 fix, 2026-09-26) — true only when check()'s own independent probe of the current root
 *  found NO git repository at all (never merely "caller omitted commitSha" — see check()'s noGitAtRoot).
 *  When true, the completion event's commit_sha is neither required nor format-checked (there is no HEAD
 *  to bind to); the hash-chain and evidence_digest bindings below still apply in full.
 *
 *  HERBOUWD 2026-08-09 na een onafhankelijke Codex-review (VERDICT CHANGES_REQUIRED, F-01..F-10). De
 *  eerste versie accepteerde drie routes die alle drie door de gecontroleerde partij zelf te vullen waren:
 *   - `runtime:'codex'` in de eigen eventpayload  -> een worker riep zichzelf externe reviewer (F-01);
 *   - vrije `verified_by:'wie dan ook'`           -> een verzonnen naam volstond (F-05);
 *   - `codex_review`/`verify_result`              -> types die de strict writer niet eens kent (F-08).
 *  Alle drie zijn VERWIJDERD, niet verzacht: caller-JSON is geen provenance. Wat overblijft is één route
 *  die volledig uit de gelogde, hash-geketende werkelijkheid volgt:
 *
 *    een REVIEW-COMPLETION door een agent die géén werk deed in deze run, causaal gekoppeld aan zijn
 *    EIGEN eerdere review-start onder hetzelfde review_id, gebonden aan het exacte subject, en niet stale.
 *
 *  SUBJECTBINDING (F-03) zonder externe aanroep: de log is hash-geketend, dus het `prev_hash` van het
 *  completion-event IS per constructie de digest van de runstaat vlak vóór die review. Een review die
 *  `subject_log_hash` draagt dat daarvan afwijkt, beoordeelde een andere staat en telt niet. `commit_sha`
 *  moet aanwezig en welgevormd zijn; is de actuele commit bekend (opts.commitSha), dan moet hij exact
 *  matchen. `evidence_digest` legt de bewijsset vast waarop het oordeel rust.
 *
 *  EERLIJKE GRENS (F-02, bewust NIET weggepoetst): dit scheidt op AGENTLABEL, niet op runtimeprincipal.
 *  Er bestaat in deze codebase geen writer-gestempelde principal-identiteit — de writer is een CLI die de
 *  aanroeper zelf start. Eén uitvoerder die twee geregistreerde labels voert, kan deze scheiding dus nog
 *  steeds omzeilen. Echte provenance vereist dat de gateway een ondertekend dispatchreceipt stempelt; dat
 *  raakt command-center/ en is OWNER-GATED. Tot die tijd rapporteert `label_only:true` deze grens mee, in
 *  plaats van hem stil te verzwijgen. */
/** isGoedkeuring(ev) -> {ok:true} of {ok:false, reden}. DE ENE definitie van "deze review keurde goed".
 *  R7-05: er stonden er twee, en de zwakkere zat in de staleness-check — dus een latere afkeuring met een
 *  leeg veld of `ok:"true"` telde daar niet als afkeuring terwijl de hoofdvalidator hem wél zou weigeren.
 *  Twee ingangen naar hetzelfde oordeel die van elkaar verschillen, zijn erger dan één strenge.
 *  V23 (2026-09-24 second Codex recheck, out-p7.md) — deze functie keek alleen naar het VERDICT-veld en
 *  nooit naar log-event.cjs's eigen content-oracle stempel. REPRODUCED: een `review_completed` met een
 *  positief verdict MAAR `_forge_verify.proof_verified:false` (de writer kon de eigen claim niet bevestigen)
 *  gold hier gewoon als goedkeuring, en valideerde zo als een onafhankelijke review. Een weerlegde claim is
 *  geen bewijs, ongeacht welk verdict-woord ernaast staat — gecontroleerd EERST, vóór elke verdict-lezing. */
const UITKOMST_VELDEN = ['review_verdict', 'verdict', 'status', 'result', 'outcome'];
function isGoedkeuring(ev) {
  if (eventIsDisproven(ev)) return { ok: false, reden: 'dit event is door de eigen contentoracle als proof_verified:false gemarkeerd — een weerlegde claim is geen goedkeuring, welk verdict-veld er ook naast staat' };
  const norm = (a) => String(a == null ? '' : a).trim().toLowerCase();
  const aanwezig = UITKOMST_VELDEN.filter((f) => ev[f] !== undefined).map((f) => ({ f, v: norm(ev[f]) }));
  if (!aanwezig.length) return { ok: false, reden: 'geen machineleesbaar review_verdict — een review zonder uitslag bevestigt niets' };
  const leeg = aanwezig.filter((g) => g.v === '');
  if (leeg.length) return { ok: false, reden: leeg.map((g) => g.f).join(', ') + ' is aanwezig maar LEEG — een uitspraak zonder inhoud is geen goedkeuring' };
  const negatief = aanwezig.filter((g) => !POSITIEVE_REVIEW_VERDICTS.has(g.v));
  if (negatief.length) return { ok: false, reden: 'de uitkomst is niet eenduidig goedgekeurd (' + negatief.map((g) => g.f + '="' + g.v + '"').join(', ') + ') — verwacht een van: ' + [...POSITIEVE_REVIEW_VERDICTS].join(', ') };
  if (ev.ok !== undefined && ev.ok !== true) return { ok: false, reden: 'het event draagt ok=' + JSON.stringify(ev.ok) + ' — alleen de boolean true telt als goedkeuring' };
  return { ok: true };
}

function independentVerification(events, opts) {
  opts = opts || {};
  const norm = (a) => String(a == null ? '' : a).trim().toLowerCase();
  const list = Array.isArray(events) ? events : [];

  const workers = new Set();
  const anoniemWerk = [];
  const starts = new Map(); // review_id -> {agent, index}
  const completions = [];
  let lastWorkIndex = -1;

  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (!e || typeof e !== 'object' || typeof e.event_type !== 'string') continue;
    const type = e.event_type.toLowerCase();
    const agent = norm(e.agent);
    /** N-01 (post-fix herreview): een work-event ZONDER agent viel stilzwijgend buiten de werkersverzameling.
     *  Dat is de gevaarlijkste variant: de uitvoerder logt zijn werk anoniem, verdwijnt uit `workers`, en
     *  keurt het daarna onder een naam goed. Anoniem werk maakt de onafhankelijkheid dus ONBEPAALBAAR —
     *  fail-closed, niet onzichtbaar. */
    /** D3 fix (2026-09-26, fresh-laptop re-audit) — `agent_work_package_created` is the LEAD announcing
     *  who a work package is ASSIGNED to (forge.md:89: "agent, role, runtime, mission, ...
     *  status:'previewing'"), logged BY the Lead, naming the intended executor in `agent`, with NO proof
     *  a dispatch actually happened. Crediting that name as a WORKER let a reviewer's own work-package
     *  assignment count as the reviewer doing work in this run — REPRODUCED (executed replay of a real
     *  mission): "de reviewer (review boss) deed in deze run zelf werk — dat is zelf-goedkeuring", purely
     *  because the Lead had logged the review Boss's OWN dispatch announcement. Creating a work package
     *  FOR an agent is not that agent DOING anything — only a genuine execution event
     *  (agent_started/subagent_started/custom_subagent_created/subagent_completed/etc.) proves the named
     *  agent actually worked. This event type stays counted for STALENESS (isStalingEvent below still
     *  calls isWorkEvent — new planned work still makes a prior "everything is done" review stale), and
     *  stays OUT of `anoniemWerk` too (an assignment with no named assignee is not the dangerous "who did
     *  this?" case N-01 exists for — nobody DID anything here at all).
     *  2.3 fix (WP-S13, same date) — `custom_subagent_created` is REAL dispatch proof (dispatch_id,
     *  mission, allowed actions — see IV_DISPATCH_TYPES), unlike the bare plan above, so it was moved OUT
     *  of ASSIGNMENT_EVENT_TYPES and into IV_DISPATCH_TYPES: `isWorkEvent(e)` now gates it through
     *  `!isReviewDispatch(e)` exactly like `agent_started`/`subagent_started`, so it counts as work unless
     *  the event itself PROVES it was a review assignment. */
    if (isWorkEvent(e) && !ASSIGNMENT_EVENT_TYPES.has(type)) {
      if (agent) workers.add(agent);
      else anoniemWerk.push(type);
    }
    if (isStalingEvent(e)) lastWorkIndex = i;
    if (REVIEW_START_TYPES.has(type)) {
      const id = typeof e.review_id === 'string' ? e.review_id.trim() : '';
      /** R3-03: een review_id dat twee keer als start voorkomt is ambigu — welke van de twee hoort bij
       *  welke completion? Volgorde-afhankelijke uitkomsten zijn precies wat een poort niet mag hebben,
       *  dus zo'n id wordt vergiftigd in plaats van "de eerste wint". */
      if (id) starts.has(id) ? starts.get(id).dubbel = true : starts.set(id, { agent, index: i });
    } else if (REVIEW_DONE_TYPES.has(type)) {
      completions.push({ ev: e, agent, index: i });
    }
  }

  const base = { workers: [...workers], label_only: true };
  /** R3-02 (derde herreview): de registrycheck van de writer dekt maar een deel van de eventtypes en faalt
   *  OPEN — ontbreekt de registry, dan geldt elke naam als geregistreerd. Een uitvoerder kon zijn werk dus
   *  onder "Phantom Worker" schrijven en het daarna onder een echt label goedkeuren. De poort toetst nu
   *  zelf: elke werker en de reviewer moeten een BEKENDE naam dragen, en zonder registry is dat niet vast
   *  te stellen — dan telt geen enkele verificatie (fail-closed, niet fail-open). */
  if (opts.knownAgents !== undefined) {
    if (!(opts.knownAgents instanceof Set) || opts.knownAgents.size === 0) {
      return Object.assign({ ok: false, route: null, reason: 'de agentregistry kon niet worden gelezen, dus namen zijn niet te toetsen — fail-closed (een niet te verifieren identiteit is geen identiteit)' }, base);
    }
    const onbekendeWerkers = [...workers].filter((w) => !opts.knownAgents.has(w));
    if (onbekendeWerkers.length) {
      return Object.assign({ ok: false, route: null, reason: 'werk gelogd onder niet-geregistreerde naam/namen: ' + onbekendeWerkers.join(', ') + ' — wie dat was is niet vast te stellen, dus onafhankelijkheid evenmin' }, base);
    }
  }
  if (anoniemWerk.length) {
    return Object.assign({ ok: false, route: null, reason: 'er is werk gelogd ZONDER agent (' + [...new Set(anoniemWerk)].join(', ') + ') — wie het deed is dan onbekend, dus onafhankelijkheid is onbepaalbaar (fail-closed)' }, base);
  }
  if (!workers.size) {
    // F-06: geen enkel toegelaten werk-event — ook wanneer de run vol notities of lifecycle-events staat,
    // en ook wanneer de strict writer alle werk-events weigerde (die staan dan simpelweg niet in de log).
    return Object.assign({ ok: false, route: null, reason: 'geen enkel toegelaten work-event in deze run — er is niets om onafhankelijk van te zijn (lifecycle-, notitie- en audit-events tellen niet als werk)' }, base);
  }
  if (!completions.length) {
    return Object.assign({ ok: false, route: null, reason: 'geen review-completion in deze run — verwacht ' + [...REVIEW_DONE_TYPES].join('/') + ' met review_id, subject_log_hash, commit_sha en evidence_digest, gelogd door een agent die hier geen werk deed' }, base);
  }


  /** R8-02 (achtste herreview): elke completion gaat nu door EEN volledige protocolvalidator, en het
   *  resultaat wordt bewaard. Vroeger stopte de lus bij de eerste geldige completion, waardoor een
   *  latere ONGELDIGE completion (hergebruikt review_id, verkeerde commit, ontbrekende start) onzichtbaar
   *  bleef: alleen een expliciet NEGATIEF verdict werd nog gezien. Een ongeldige review na een
   *  goedkeuring is net zo goed een signaal dat er iets niet klopt. Startconsumptie gebeurt in deze ene
   *  pass, dus precies een keer per completion — ongeacht de uitkomst.
   *  Geen vroege return meer: eerst alles beoordelen, dan pas oordelen. */
  function valideerCompletion(c) {
    const e = c.ev;
    const id = typeof e.review_id === 'string' ? e.review_id.trim() : '';
    const subjectLogHash = typeof e.subject_log_hash === 'string' ? e.subject_log_hash.trim() : '';
    const commitSha = typeof e.commit_sha === 'string' ? e.commit_sha.trim() : '';
    const evidenceDigest = typeof e.evidence_digest === 'string' ? e.evidence_digest.trim() : '';
    const noem = e.event_type + '#' + (id || 'zonder-review_id');

    /** R5-04 (vijfde herreview): de consumptie stond NA de verdict- en reviewercontroles, dus een
     *  afgekeurde poging verbruikte niets — start -> CHANGES_REQUIRED -> approved werkte gewoon op
     *  dezelfde start. Ik had in de vorige ronde geclaimd dat dit al opgelost was; dat was onjuist.
     *  De koppeling wordt daarom als EERSTE bepaald en de start onmiddellijk verbruikt: één start hoort
     *  bij één afrondingspoging, ongeacht de uitkomst daarvan. */
    if (!id) { return { ok: false, reden: 'mist review_id, dus er is geen causale koppeling met een review-start' }; }
    const start = starts.get(id);
    if (!start) { return { ok: false, reden: 'er bestaat geen review-start met dit review_id' }; }
    if (start.dubbel) { return { ok: false, reden: 'dit review_id komt meer dan eens als start voor — ambigu, dus onbruikbaar als causale koppeling' }; }
    if (start.consumed) { return { ok: false, reden: 'deze review-start is al door een eerdere completion gebruikt — één start hoort bij één afronding' }; }
    start.consumed = true;
    if (!c.agent) { return { ok: false, reden: 'geen agent op het completion-event' }; }
    /** R4-01 (vierde herreview) — het pijnlijkste gat van allemaal: de poort keek of er EEN review was,
     *  niet of die review POSITIEF eindigde. Een `review_completed` met verdict CHANGES_REQUIRED telde
     *  dus als bevestiging van afronding. Erger nog: forge-verify.cjs emitteert `lead_review_completed`
     *  juist bij FOUTEN ("Never marks anything done"), dus een afkeuring bevestigde de afronding.
     *  Een review zonder expliciet, machineleesbaar positief verdict bewijst niets — en het ontbreken
     *  van dat veld is geen "waarschijnlijk goed", maar fail-closed. */
    /** R5-02 (vijfde herreview): `review_verdict` won altijd van `verdict`, en alleen exact `ok:false`
     *  werd bekeken. Een event met review_verdict:"approved" naast verdict:"CHANGES_REQUIRED",
     *  status:"failed", outcome:"blocked" en ok:"false" kwam er dus doorheen. Nu telt ELK uitkomstveld
     *  mee en moet het beeld eenduidig positief zijn: één afwijkend of tegenstrijdig veld is genoeg om
     *  te weigeren. Tegenstrijdigheid is geen detail — het is precies hoe je een afkeuring verstopt. */
    /** R6-08 (zesde herreview): LEGE waarden werden genegeerd, dus `review_verdict:"approved", ok:""`
     *  kwam erdoor — terwijl ik claimde dat ieder AANWEZIG uitkomstveld ondubbelzinnig positief moet
     *  zijn. Een leeg veld is geen afwezig veld: het is een aanwezige uitspraak zonder inhoud, en dat is
     *  geen goedkeuring. Aanwezig ⇒ niet-leeg ⇒ positief; en `ok` moet exact de boolean true zijn. */
    const oordeel = isGoedkeuring(e);
    if (!oordeel.ok) { return { ok: false, reden: noem + ': ' + oordeel.reden }; }
    if (opts.knownAgents instanceof Set && opts.knownAgents.size && !opts.knownAgents.has(c.agent)) { return { ok: false, reden: 'de reviewer "' + c.agent + '" staat niet in de agentregistry — een naam die niemand kent bewijst geen tweede partij' }; }
    if (workers.has(c.agent)) { return { ok: false, reden: 'de reviewer (' + c.agent + ') deed in deze run zelf werk — dat is zelf-goedkeuring' }; }
    if (start.index >= c.index) { return { ok: false, reden: 'de review-start staat NA de completion — geen causale volgorde' }; }
    if (start.agent !== c.agent) { return { ok: false, reden: 'de start is van ' + (start.agent || '(naamloos)') + ' maar de completion van ' + c.agent + ' — een review sluit je zelf af' }; }
    /** N-05 (post-fix herreview): de start moet NA al het werk liggen dat aan deze completion voorafgaat.
     *  Zonder die eis werkte hergebruik van een review_id: work → start → complete → NIEUW werk →
     *  nogmaals complete. Die tweede completion leunde op dezelfde oude start en gold weer als geldig,
     *  terwijl er intussen werk bij was gekomen. Eén regel dekt replay, ID-hergebruik én "verse review
     *  vereist na nieuw werk": een review die begon vóór het werk kan dat werk niet beoordeeld hebben. */
    const werkVoorDeze = list.slice(0, c.index).reduce((max, x, idx) => (x && typeof x === 'object' && typeof x.event_type === 'string' && isWorkEvent(x) ? idx : max), -1);
    if (start.index < werkVoorDeze) { return { ok: false, reden: 'de review-start ligt VOOR werk dat daarna nog kwam (' + list[werkVoorDeze].event_type + ') — die review kan dat werk niet beoordeeld hebben; open een verse review' }; }
    if (!subjectLogHash) { return { ok: false, reden: 'mist subject_log_hash, dus het oordeel is aan geen enkele runstaat gebonden' }; }
    const prev = typeof e.prev_hash === 'string' ? e.prev_hash.trim() : '';
    if (!prev) { return { ok: false, reden: 'het event draagt geen prev_hash — subjectbinding is niet verifieerbaar op een ongeketende log' }; }
    if (subjectLogHash !== prev) { return { ok: false, reden: 'subject_log_hash (' + subjectLogHash.slice(0, 12) + '…) wijkt af van de werkelijke runstaat bij dit event (' + prev.slice(0, 12) + '…) — er is een ANDERE staat beoordeeld' }; }
    /** Zonder deze koppeling zou `prev_hash === subject_log_hash` te vervullen zijn door BEIDE zelf te
     *  verzinnen. De keten is de enige partij die dit niet kan liegen: prev_hash moet exact de entry_hash
     *  van het voorgaande event zijn. Is de log helemaal niet geketend, dan is subjectbinding onbewijsbaar
     *  en weigeren we — fail-closed, geen zachte route voor "log zonder keten". */
    /** N-06 (post-fix herreview): "zoek achteruit naar enig eerder entry_hash" liet een ONMIDDELLIJKE
     *  voorganger zonder hash toe — dan sluit prev_hash aan op een event dat twee plekken terug ligt en is
     *  de keten in werkelijkheid onderbroken. Het moet exact de directe voorganger zijn, met een
     *  welgevormde sha256. */
    const vorige = c.index > 0 ? list[c.index - 1] : null;
    const vorigeHash = vorige && typeof vorige === 'object' && typeof vorige.entry_hash === 'string' ? vorige.entry_hash.trim() : '';
    if (!SHA256_RE.test(vorigeHash)) { return { ok: false, reden: 'de directe voorganger draagt geen welgevormde entry_hash — de keten is hier onderbroken, dus subject_log_hash is door de aanroeper zelf te verzinnen' }; }
    if (vorigeHash !== prev) { return { ok: false, reden: 'prev_hash sluit niet aan op de directe voorganger (verwacht ' + vorigeHash.slice(0, 12) + '…) — het event is losgekoppeld van de runstaat' }; }
    /** D2 fix (2026-09-26, fresh-laptop re-audit) — a genuinely git-less project has no commit to bind to
     *  at all: `opts.commitSha` is always null (resolveHeadCommit honestly returns null), so the unconditional
     *  version of this check made independent-verification, and therefore the whole run contract, permanently
     *  unsatisfiable on such a project. `opts.noGit` is a real, independent probe of the CURRENT root (see
     *  check()'s `noGitAtRoot`) — never true just because a caller omitted commit_sha on a project that DOES
     *  have git, so a real project keeps the exact fail-closed behaviour below, unchanged. Binding still
     *  rests on subject_log_hash/prev_hash (the hash chain, checked above) and evidence_digest (checked
     *  below, itself now bound to a real file digest instead of a commit — see canonicalEvidenceDigest's D2
     *  fix) — a git-less review is not an UNVERIFIED review, only an unversioned one. */
    if (!opts.noGit) {
      if (!SHA1_RE.test(commitSha)) { return { ok: false, reden: 'commit_sha ontbreekt of is niet welgevormd — onbekend welke code beoordeeld is' }; }
      /** N-02 (post-fix herreview): een vormcontrole zonder vergelijking is geen binding — élke geldige
       *  40-hex waarde kwam erdoor. Nu FAIL-CLOSED: is de actuele HEAD niet vast te stellen, dan kan de
       *  commitbinding niet worden getoetst en telt de review niet. Liever geen verificatie dan een
       *  verificatie waarvan niemand weet waarop hij sloeg. */
      if (!opts.commitSha) { return { ok: false, reden: 'de actuele HEAD kon niet worden vastgesteld, dus commit_sha is niet te toetsen — fail-closed' }; }
      if (norm(commitSha) !== norm(opts.commitSha)) { return { ok: false, reden: 'beoordeelde commit ' + commitSha.slice(0, 12) + '… is niet de actuele commit ' + String(opts.commitSha).slice(0, 12) + '…' }; }
    } else if (opts.evidenceCommit) {
      /** D2 anti-fabrication guard — skipping the commit_sha check above must NEVER become a way to sneak a
       *  FAKE commit through. If this root genuinely has no git (opts.noGit) but the evidence set still
       *  claims a real commit (canonicalEvidenceDigest's git-bound branch, not its D2 no_git branch), that
       *  is a contradiction a real no-git measurement could never produce — either a stale evidence set from
       *  a different (git-having) root, or a hand-tampered gate-evidence.json. Refused, never trusted, even
       *  if the completion event's own commit_sha happens to match it (the exact shape that made this gap
       *  reproducible before this guard existed). */
      return { ok: false, reden: 'deze root heeft geen git-repository, maar de bewijsset claimt toch een commit (' + String(opts.evidenceCommit).slice(0, 12) + '…) — dat kan uit een eerlijke no-git-meting nooit komen, dus geweigerd in plaats van vertrouwd' };
    }
    if (!SHA256_RE.test(evidenceDigest)) { return { ok: false, reden: 'evidence_digest ontbreekt of is niet welgevormd — onbekend welke bewijsset beoordeeld is' }; }
    /** N-03: vorm is geen binding. Zonder herberekening voldeed élke 64-hex waarde en sloeg het oordeel
     *  nergens op. De digest wordt nu tegen de CANONIEKE bewijsset van deze run gelegd; ontbreekt die set,
     *  dan is er niets om aan te binden en telt de review niet — fail-closed, geen zachte route. */
    if (!opts.evidenceDigest) { return { ok: false, reden: 'er is geen bewijsset (gate-evidence.json) voor deze run, dus evidence_digest is nergens aan te binden — fail-closed' }; }
    if (norm(evidenceDigest) !== norm(opts.evidenceDigest)) { return { ok: false, reden: 'beoordeelde bewijsset ' + evidenceDigest.slice(0, 12) + '… is niet de actuele (' + String(opts.evidenceDigest).slice(0, 12) + '…) — het bewijs is sinds de review veranderd' }; }
    if (opts.evidenceAllGreen === false) { return { ok: false, reden: 'de bewijsset bevat gefaalde poort(en) (' + (opts.evidenceFailed || []).join(', ') + ') — een goedkeuring bovenop rood bewijs bevestigt niets' }; }
    /** R9-02 (negende herreview): de canonicalizer LEVERDE de gatecommit al, maar check() gaf hem niet
     *  door — dus niets vergeleek waarop het bewijs draaide met de commit die beoordeeld wordt. Een run
     *  kon zo groen zijn met bewijs van heel andere code. Zit de commit in de bewijsset, dan moet hij
     *  gelijk zijn aan de commit die deze review claimt te beoordelen. */
    if (opts.evidenceCommit && norm(opts.evidenceCommit) !== norm(commitSha)) { return { ok: false, reden: 'het bewijs draaide op commit ' + String(opts.evidenceCommit).slice(0, 12) + '… maar de review claimt commit ' + commitSha.slice(0, 12) + '… — bewijs en oordeel gaan over verschillende code' }; }
    if (lastWorkIndex > c.index) { return { ok: false, reden: 'er is NA deze review nog werk gelogd (' + (list[lastWorkIndex].event_type) + ') — de review is stale' }; }

    return {
      ok: true,
      review: { review_id: id, commit_sha: commitSha, subject_log_hash: subjectLogHash, evidence_digest: evidenceDigest },
      reviewer: c.agent,
      reden: 'review ' + id + ' afgerond door ' + c.agent + ' (deed zelf geen werk), gekoppeld aan zijn eigen start, gebonden aan commit ' + commitSha.slice(0, 12) + '… en runstaat ' + subjectLogHash.slice(0, 12) + '…, en niet stale',
    };
  }
  const beoordeeld = completions.map((c) => ({ c, res: valideerCompletion(c) }));
  const afgewezenRedenen = beoordeeld.filter((x) => !x.res.ok).map((x) => x.c.ev.event_type + '#' + (x.c.ev.review_id || 'zonder-review_id') + ': ' + x.res.reden);
  /** R9-07 (negende herreview) — REGRESSIE UIT MIJN EIGEN R8-02-FIX. Ik verankerde het oordeel aan de
   *  EERSTE geldige goedkeuring en blokkeerde daarna op elke latere ongeldige completion. Gevolg:
   *  `goedkeuring -> ongeldig -> verse start -> geldige goedkeuring` bleef rood, terwijl mijn eigen
   *  foutmelding letterlijk zegt "open een verse review". Een gate die de voorgeschreven herstelweg
   *  afsluit, dwingt geen kwaliteit af maar blokkeert werk.
   *  Nu telt de LAATSTE completion: die bepaalt de eindstand. Is die geldig, dan is de run geverifieerd;
   *  is die ongeldig of afkeurend, dan niet — ongeacht wat ervoor stond. Herstel is daarmee mogelijk
   *  zonder dat een oude goedkeuring een nieuwere afkeuring kan overstemmen. */
  const laatste = beoordeeld.length ? beoordeeld[beoordeeld.length - 1] : null;
  if (laatste && laatste.res.ok) {
    const c = laatste.c;
    return Object.assign({ ok: true, route: 'causal-review', reviewer: c.agent, review: laatste.res.review, reason: laatste.res.reden }, base);
  }
  if (laatste && beoordeeld.some((x) => x.res.ok)) {
    return Object.assign({ ok: false, route: null, reason: 'de LAATSTE review-completion is niet geldig (' + laatste.c.ev.event_type + ' door ' + (laatste.c.agent || '(naamloos)') + ': ' + laatste.res.reden + ') — een eerdere goedkeuring telt niet meer; sluit af met een geldige verse review' }, base);
  }
  return Object.assign({ ok: false, route: null, reason: 'geen bruikbare review-completion: ' + afgewezenRedenen.join(' | ') }, base);
}

/** sanitizeIv — alleen wat een lezer nodig heeft om te begrijpen WAAROM, nooit ruwe eventpayloads:
 *  daar kan vrije tekst (paden, commando's, output) in staan die niet in een contractuitslag hoort. */
function sanitizeIv(iv) {
  const kort = (s) => String(s == null ? '' : s).slice(0, 400);
  return {
    ok: iv.ok === true, route: iv.route || null, workers: (iv.workers || []).slice(0, 20),
    reviewer: iv.reviewer || null, label_only: iv.label_only === true,
    review: iv.review ? {
      review_id: kort(iv.review.review_id),
      commit_sha: kort(iv.review.commit_sha),
      subject_log_hash: kort(iv.review.subject_log_hash),
      evidence_digest: kort(iv.review.evidence_digest),
    } : null,
    reason: kort(iv.reason),
  };
}

/** resolveHeadCommit(root) / gitProbe(root) — see the full doc right above their implementation,
 *  further down this file (near knownAgentNames). gitProbe is the ONE shared, three-way git probe
 *  (WP-S13, 2.1); resolveHeadCommit is its thin backward-compatible wrapper. */
/** canonicalEvidenceDigest(root, runId) -> {digest, gates} of null.
 *
 *  N-03 (post-fix herreview 2026-08-09): `evidence_digest` werd alleen op VORM gecontroleerd — elke
 *  willekeurige 64-hex waarde voldeed, dus de review was aan geen enkel werkelijk bewijs gebonden. Een
 *  digest die niets samenvat is een placeholder, geen binding.
 *
 *  De canonieke vorm is bewust MINIMAAL en stabiel: per poort alleen `name`, `exit_code` en
 *  `output_sha256`, gesorteerd op naam. Timestamps, duur en paden horen er NIET in — die veranderen bij
 *  elke herhaling zonder dat het bewijs verandert, en zouden de digest onbruikbaar maken. Wat er wél in
 *  zit is precies wat een oordeel draagt: welke poort, of hij slaagde, en de hash van zijn uitvoer. */
function canonicalEvidenceDigest(root, runId) {
  const file = path.join(root, '.claude', 'forge-runs', runId, 'gate-evidence.json');
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  let j;
  try { j = JSON.parse(raw); } catch { return null; }
  const gates = Array.isArray(j && j.gates) ? j.gates : null;
  if (!gates || !gates.length) return null;
  /** R3-04 (derde herreview): zonder schemavalidatie leverde zelfs `{gates:[{}]}` een bruikbare digest —
   *  een betekenisloze bewijsset ging dan door voor exact gebonden bewijs. Elke poort moet een niet-lege
   *  UNIEKE naam, een integer exitcode en een welgevormde sha256 dragen; anders is er geen bewijsset en
   *  telt de review niet. Duplicaatnamen zijn expliciet fataal: die maken de sortering ambigu, waardoor
   *  dezelfde inhoud twee verschillende digests kan opleveren. */
  /** R6-05 (zesde herreview): de canonicalizer keek alleen naar naam, exitcode en een ZELFGERAPPORTEERDE
   *  output-hash. Een poort die is afgekapt (`timed_out`), nooit gestart (`spawn_error`) of waarvan de
   *  recorder de hash niet kon herverifiëren (`evidence_verified:false`) telde gewoon mee als bewijs. Ook
   *  het `run_id` in het manifest werd niet vergeleken, dus de bewijsset van een ANDERE run paste net zo
   *  goed. Al die gevallen zijn nu fataal: liever geen bewijsset dan een bewijsset die iets anders
   *  beschrijft dan wat er gedraaid heeft. */
  /** R7-06 (zevende herreview): `run_id` was OPTIONEEL, dus oud of cross-run bewijs kon worden hergebruikt
   *  door het veld simpelweg weg te laten. En de codepin die ik in het vorige blok toevoegde was voor de
   *  contractlogica puur decoratief: hij zat niet in de digest, dus dezelfde poorten op andere code gaven
   *  dezelfde digest. Beide zijn nu bindend: run_id verplicht en exact, en de commit per poort telt mee in
   *  de canonieke vorm — ander bewijs op andere code is dan ook een andere digest. */
  if (String(j.run_id || '') !== String(runId)) return null;
  const namen = new Set();
  const canon = [];
  for (const g of gates) {
    if (!g || typeof g !== 'object') return null;
    const name = typeof g.name === 'string' ? g.name.trim() : '';
    if (!name || namen.has(name)) return null;
    /** R10-03 (tiende herreview): een handgeschreven `noop`-poort ZONDER command en zonder outputbestand
     *  leverde een groene digest — de canonicalizer accepteerde elk zelfbenoemd record. Een poort zonder
     *  command is geen uitgevoerde poort, en een poort zonder outputverwijzing heeft geen verifieerbare
     *  uitvoer. Beide zijn nu verplicht. (Een volledige VERWACHTE gatecatalogus per domein hoort bij de
     *  Quality-laag / required-evidence-integratie — daar wordt afgedwongen WELKE poorten er moeten zijn;
     *  hier wordt afgedwongen dat elke aanwezige poort echt en verifieerbaar is.) */
    const heeftCommand = (typeof g.command === 'string' && g.command.trim() !== '')
      || (Array.isArray(g.argv) && g.argv.length > 0);
    if (!heeftCommand) return null;
    if (typeof g.output_file !== 'string' || g.output_file.trim() === '') return null;
    namen.add(name);
    if (!Number.isInteger(g.exit_code)) return null;
    if (g.timed_out === true) return null;              // afgekapt = geen uitslag
    if (g.spawn_error) return null;                     // nooit gedraaid = geen bewijs
    if (g.evidence_verified !== true) return null;      // R7-06: alleen een EXPLICIET bevestigde hash telt
    /** R9-05: `evidence_verified` is het woord van de RECORDER. Ligt de ruwe uitvoer er nog, dan
     *  controleert de poort dat zelf — een manifest dat niet meer bij zijn eigen bestanden past, is geen
     *  bewijs. Ontbreekt het bestand (gitignored, andere machine), dan blijft het manifest de enige bron;
     *  dat is een bewuste beperking, geen stilzwijgend vertrouwen. */
    if (typeof g.output_file === 'string' && g.output_file) {
      try {
        const opSchijf = fs.readFileSync(path.join(root, g.output_file), 'utf8');
        if (crypto.createHash('sha256').update(opSchijf, 'utf8').digest('hex') !== String(g.output_sha256).trim().toLowerCase()) return null;
      } catch { /* bestand is er niet meer — het manifest blijft de bron, zie commentaar hierboven */ }
    }
    const sha = typeof g.output_sha256 === 'string' ? g.output_sha256.trim().toLowerCase() : '';
    if (!/^[0-9a-f]{64}$/.test(sha)) return null;
    /** R8-03 (achtste herreview): `code.commit` werd wél aan de digest toegevoegd maar niet VERPLICHT of
     *  gevalideerd — probes leverden groene digests voor ontbrekende code, `commit:"not-a-sha"` en
     *  `worktree_clean:false`. Een codepin die je niet afdwingt, bindt niets. Een poort telt nu alleen mee
     *  met een stabiele meting, een welgevormde commit én een schone bron: bewijs dat op bewegende of
     *  ongecommitte code draaide, kan niet aan die code worden opgehangen. */
    const code = g.code;
    if (!code || typeof code !== 'object') return null;
    if (code.stable !== true) return null;
    /** D2 fix (2026-09-26, fresh-laptop re-audit) — a project with NO git repository could never produce a
     *  usable evidence digest at all: forge-gate-evidence.cjs's gitState() honestly returns
     *  {available:false} for every gate, so `code.commit` was never a well-formed sha and this whole
     *  function returned null forever, which meant independent-verification (and therefore the run
     *  contract) could never pass for a genuinely git-less project. That is not a real security
     *  requirement — a commit sha binds evidence to a VERSION, and a project with no versioning concept has
     *  nothing to bind to. forge-gate-evidence.cjs's own `record()` now marks such a gate `code.no_git:true`
     *  with `commit:null` (never a fabricated commit) — this file accepts that shape as an ALTERNATE, honest
     *  binding: the gate's evidence rests on its own real output_sha256 (already required above) instead of
     *  a commit. A no-git gate must not ALSO claim a commit or a worktree state it cannot measure — either
     *  one present is a malformed record, not evidence. KNOWN, NAMED LIMITATION (never silently smoothed
     *  over): without git there is no way to detect that two gates in the same evidence set ran against
     *  DIFFERENT source states (the whole reason R8-03 below exists) — every no-git gate is tagged with the
     *  same opaque marker, so that specific cross-gate drift protection simply does not exist for a
     *  git-less project. */
    let codeRef;
    if (code.no_git === true) {
      if (code.commit != null || code.worktree_clean != null) return null; // a no-git record claiming a commit/worktree state is malformed, not evidence
      codeRef = 'no-git';
    } else {
      const commit = typeof code.commit === 'string' ? code.commit.trim().toLowerCase() : '';
      if (!/^[0-9a-f]{40}$/.test(commit)) return null;
      if (code.worktree_clean !== true) return null;
      codeRef = 'git:' + commit;
    }
    canon.push({ name, exit_code: g.exit_code, output_sha256: sha, commit: codeRef });
  }
  canon.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  /** R5-03 (vijfde herreview): de digest vatte ook een RODE bewijsset samen, en de evaluator keek alleen
   *  of hij matchte — een positieve review kon dus een run met een gefaalde poort bevestigen en
   *  finaliseren. De digest blijft bewust over ALLE poorten gaan (anders is hij geen eerlijke
   *  samenvatting van wat er gedraaid heeft), maar een completion eist daarnaast dat elke poort groen is. */
  const rood = canon.filter((g) => g.exit_code !== 0).map((g) => g.name);
  /** R8-03: poorten die op VERSCHILLENDE commits (of een mix van git- en no-git-bewijs) draaiden vormen
   *  samen geen bewijs over één staat. */
  const refs = [...new Set(canon.map((g) => g.commit))];
  if (refs.length > 1) return null;
  const ref = refs[0] || null;
  const noGit = ref === 'no-git';
  return {
    digest: crypto.createHash('sha256').update(JSON.stringify(canon)).digest('hex'), gates: canon.length,
    allGreen: rood.length === 0, failed: rood,
    // D2: a no-git evidence set never reports a commit — null, never fabricated. A git-bound set strips
    // the internal 'git:' tag back off so callers keep seeing a bare 40-hex sha, exactly as before.
    commit: noGit ? null : (ref ? ref.slice('git:'.length) : null),
    no_git: noGit,
  };
}

/** knownAgentNames(root) -> Set van gecanonicaliseerde, BEKENDE agentnamen (registry + .claude/agents/*.md
 *  + de generieke rollen), of null wanneer er geen registry te lezen is. null betekent fail-closed bij de
 *  aanroeper — niet 'dan maar iedereen toestaan' (R3-02). */
function knownAgentNames(root) {
  const namen = new Set(['lead', 'boss', 'orchestrator', 'system', 'forge-router', 'main', 'codex']);
  let uitRegistry = 0;
  try {
    const raw = fs.readFileSync(path.join(root, '.claude', 'config', 'agents', 'agent-registry.json'), 'utf8');
    for (const m of raw.matchAll(/"(?:name|id)"\s*:\s*"([^"]+)"/g)) { namen.add(m[1].trim().toLowerCase()); uitRegistry++; }
  } catch { return null; }
  if (!uitRegistry) return null;
  try {
    for (const f of fs.readdirSync(path.join(root, '.claude', 'agents'))) {
      if (f.endsWith('.md')) { const n = f.replace(/\.md$/, '').toLowerCase(); namen.add(n); namen.add(n.replace(/-/g, ' ')); }
    }
  } catch { /* geen agents-map is geen fout: de registry is de bron */ }
  return namen;
}

/** cleanGitEnv() -> a copy of process.env with every variable that could redirect git AWAY from the
 *  real repository at `-C root` stripped: GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE,
 *  GIT_CEILING_DIRECTORIES, and any GIT_CONFIG* variable (GIT_CONFIG_COUNT/KEY_n/VALUE_n/GLOBAL/SYSTEM/
 *  NOSYSTEM/...). WP-S13 (2.1, 2026-09-26 laptop re-audit): before this fix a caller could prefix
 *  `GIT_DIR=<nonexistent>` (or a GIT_CEILING_DIRECTORIES above root) to a Forge tool invocation and make a
 *  project that DOES have git look exactly like one that has none — every no-git relaxation in this file
 *  trusted that false signal. Every git spawn in this module goes through this env, so the probe below can
 *  never be fooled by the calling process's own environment.
 *
 *  N4 fix (2026-09-26 independent review, LOW): gitProbe()'s `zegtNietEenRepo` check below matches git's
 *  "not a git repository" message literally — but that message is TRANSLATED by locale (LC_ALL/LANG) or
 *  LANGUAGE. Under a non-English locale a truly git-less project would get git's message in another
 *  language, the regex would miss it, and the root would read as 'undetermined' instead of the correctly
 *  relaxed 'no-repo' — fails closed (never silently wrong), but quietly undoes the D2 no-git relaxation
 *  this file exists for. Force English output from every git call fed this env, regardless of what the
 *  parent process's own locale carries: LC_ALL/LANG win over every other locale category, LANGUAGE (glibc's
 *  own priority-ordered override list) is removed so it can never re-introduce a translation underneath. */
function cleanGitEnv() {
  const env = Object.assign({}, process.env);
  delete env.GIT_DIR; delete env.GIT_WORK_TREE; delete env.GIT_INDEX_FILE; delete env.GIT_CEILING_DIRECTORIES;
  for (const k of Object.keys(env)) { if (k.indexOf('GIT_CONFIG') === 0) delete env[k]; }
  env.LC_ALL = 'C';
  env.LANG = 'C';
  delete env.LANGUAGE;
  return env;
}

/** hasGitEntryInAncestry(root) -> true when a `.git` entry (file OR directory — a worktree's `.git` is a
 *  FILE, a normal repo's is a directory; both count) exists at `root` or any parent, up to the filesystem
 *  root. A pure filesystem check, independent of git's own exit code/stderr — the second, independent leg
 *  `gitProbe()` requires before it will ever call a root "no-repo" (see its doc). */
function hasGitEntryInAncestry(root) {
  let dir = path.resolve(root);
  for (;;) {
    try { fs.lstatSync(path.join(dir, '.git')); return true; } catch { /* geen .git hier — verder omhoog */ }
    const parent = path.dirname(dir);
    if (parent === dir) return false; // filesystem-root bereikt zonder ooit een .git te vinden
    dir = parent;
  }
}

/** gitProbe(root) -> ONE shared, honest, THREE-WAY probe of a root's git state (WP-S13, 2.1, 2026-09-26
 *  laptop re-audit, review C VERDICT FAIL). Before this fix, `resolveHeadCommit` returned `null` for
 *  BOTH "definitely no git repository" and "git exists but refused/failed/timed out for some other
 *  reason" (dubious ownership, a repo with no commits yet, a poisoned env, ENOENT). Every no-git
 *  relaxation in this file (and in forge-gate-evidence.cjs / forge-finalize.cjs) trusted that single
 *  `null` as a confirmed "no git here" — so a repo that merely refused (Windows "dubious ownership" is
 *  the common case) could be walked straight through the relaxed path meant ONLY for a genuinely
 *  git-less project. `resolveHeadCommit`, `gitState` (forge-gate-evidence.cjs) and `headProbeOf`
 *  (forge-finalize.cjs) now ALL call into this ONE function so they can never independently disagree
 *  about the same root again.
 *
 *  Returns exactly one of:
 *   {state:'repo', commit:'<40-hex>'}   — a REAL commit was resolved. The only state a caller may bind
 *                                         gate evidence to a source commit under.
 *   {state:'no-repo'}                   — POSITIVELY confirmed, on BOTH independent legs: (1) git itself
 *                                         (run with the poisoning-resistant env below) says "not a git
 *                                         repository", AND (2) no `.git` entry exists anywhere from
 *                                         `root` up to the filesystem root. Only THIS state may relax a
 *                                         commit-binding requirement — and even then the binding is
 *                                         honestly to the gate's OWN output digest, never to a source-tree
 *                                         digest (no source-tree digest exists here; see the no_git
 *                                         branches in forge-gate-evidence.cjs / canonicalEvidenceDigest).
 *   {state:'undetermined', reason}      — git is missing (ENOENT), timed out, was killed by a signal,
 *                                         refused for a reason OTHER than "not a git repository"
 *                                         (dubious ownership / safe.directory, permission), returned a
 *                                         malformed HEAD, OR the filesystem check found a `.git` entry
 *                                         despite git's own "not a git repository" error (an inconsistent
 *                                         signal — never trusted). MUST be treated exactly like a real git
 *                                         failure by every caller — fail-closed, same as before the D2 fix
 *                                         existed. Never, ever treated as 'no-repo'. */
function gitProbe(root) {
  if (typeof root !== 'string' || !root) throw new TypeError('gitProbe: root moet een pad zijn, kreeg ' + typeof root);
  const { spawnSync } = require('child_process'); // lazy: een kale check() blijft puur
  let g;
  try {
    g = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10000, env: cleanGitEnv() });
  } catch (e) {
    // git zelf is niet uitvoerbaar (ENOENT) of de spawn faalde anderszins — dat is per definitie ONBESLIST,
    // nooit stilzwijgend 'no-repo': er is helemaal niets gemeten.
    return { state: 'undetermined', reason: 'git niet uitvoerbaar: ' + (e && e.message ? e.message : String(e)) };
  }
  if (!g) return { state: 'undetermined', reason: 'git-aanroep leverde geen resultaat' };
  if (g.error) return { state: 'undetermined', reason: 'git-aanroep faalde: ' + (g.error.message || String(g.error)) };
  if (g.signal) return { state: 'undetermined', reason: 'git-aanroep werd afgebroken door signaal ' + g.signal + ' (timeout of externe kill) — geen betrouwbare meting' };
  if (g.status === 0) {
    const s = String(g.stdout || '').trim();
    if (/^[0-9a-f]{40}$/i.test(s)) return { state: 'repo', commit: s.toLowerCase() };
    return { state: 'undetermined', reason: 'git gaf exit 0 maar geen welgevormde 40-hex HEAD terug (' + JSON.stringify(s.slice(0, 80)) + ')' };
  }
  const stderr = String(g.stderr || '');
  const zegtNietEenRepo = /not a git repository/i.test(stderr);
  if (zegtNietEenRepo && !hasGitEntryInAncestry(root)) return { state: 'no-repo' };
  if (zegtNietEenRepo) {
    // git zegt "not a git repository", maar er ligt WEL een .git-item hoger in de boom — een inconsistent
    // signaal (bv. GIT_DISCOVERY_ACROSS_FILESYSTEM, een kapotte .git, of een permissiemuur). Nooit
    // vertrouwd als bevestigd geen-git: er ligt duidelijk iets, we konden het alleen niet eerlijk lezen.
    return { state: 'undetermined', reason: 'git meldt "not a git repository", maar er is wél een .git-item boven ' + root + ' — inconsistent signaal, niet vertrouwd als bevestigd geen-git' };
  }
  // Elke andere weigering (dubious ownership/safe.directory, een repo zonder commits nog
  // ("does not have any commits yet"), permissiefouten, ...) is git dat WEL een repository ziet maar
  // niet kan/wil antwoorden — dat is onbeslist, nooit een bevestiging van geen-git.
  return { state: 'undetermined', reason: 'git weigerde (exit ' + g.status + '): ' + stderr.trim().slice(0, 300) };
}

/** resolveHeadCommit(root) -> 40-hex sha of null. A thin, backward-compatible wrapper over gitProbe():
 *  null now covers BOTH 'no-repo' and 'undetermined' — exactly as intended for a caller that only wants
 *  "a commit if there is one to bind to". Any caller that needs to tell "confirmed no git" apart from
 *  "could not determine" (the whole point of the 2.1 fix) MUST call gitProbe() directly instead — see
 *  check()'s own `noGitAtRoot` and forge-finalize.cjs's `headProbeOf` for the two real examples.
 *
 *  GEMETEN FOUT (post-fix herreview 2026-08-09, N-02): de eerste versie stond inline in de CLI en
 *  verwees naar een variabele `root` die daar niet bestaat. Dat gooide een ReferenceError, die door de
 *  eigen `catch {}` STIL werd opgeslokt — commitSha bleef null en de HEAD-vergelijking heeft nooit
 *  gedraaid, terwijl ik hem als werkend rapporteerde. Twee lessen, hier vastgelegd: (1) een catch die
 *  een programmeerfout niet onderscheidt van een verwachte omgevingsfout maakt een bug onzichtbaar;
 *  (2) een pad dat alleen in productie loopt heeft een eigen test nodig. Daarom is dit nu een
 *  geëxporteerde functie met een expliciete parameter, en gooit een ReferenceError/TypeError door
 *  in plaats van te verdwijnen. */
function resolveHeadCommit(root) {
  const p = gitProbe(root);
  return p.state === 'repo' ? p.commit : null;
}

function checkSatisfied(rule, ctx) {
  const c = rule.check;
  let satisfied = false;
  if (c.type === 'event-present') satisfied = hasEvent(ctx.events, c.key);
  else if (c.type === 'independent-verification') {
    const iv = independentVerification(ctx.events, { commitSha: ctx.commitSha, noGit: ctx.noGit, evidenceDigest: ctx.evidenceDigest, evidenceAllGreen: ctx.evidenceAllGreen, evidenceFailed: ctx.evidenceFailed, evidenceCommit: ctx.evidenceCommit, knownAgents: ctx.knownAgents });
    satisfied = iv.ok;
    ctx._independentVerification = iv; // reden meegeven aan de rapportage (F-12)
  }
  else if (c.type === 'artifact-present') satisfied = hasArtifact(ctx.artifacts, c.key);
  else if (c.type === 'doctor-check') satisfied = hasDoctorRun(ctx.events);

  /** RC-DOMAIN-BYPASS (2026-09-24, out-p5.md) — TWO compounding defects, not one:
   *   (1) `{}` here starved forge-evidence.cjs's own artifactsOnDisk() of a runDir, so it always returned
   *       {verified:false} for every claimed artifact and evidenceCheck() fell back to trusting the bare
   *       claim — fixed by threading ctx.runDir through.
   *   (2) the domain-aware check only ever ran `if (!satisfied ...)` — an OR, never an override. So even
   *       with (1) fixed AND an explicit real domain passed, the cheap generic hasEvent() (ANY
   *       browser_screenshot_captured event, any path, real or fabricated) already set satisfied=true and
   *       the stronger, domain-specific 3-breakpoint check never even ran. REPRODUCED: an explicit
   *       domain:"website" plus one browser_screenshot_captured event naming a NONEXISTENT file still
   *       returned "web-responsive-evidence" satisfied.
   *   Fix (2) is DELIBERATELY SCOPED by `rule.trigger`, not blanket-authoritative for every domain_aware
   *   rule: 'web-responsive-evidence' triggers ONLY on 'web' — its domain is the entire reason it applies
   *   at all, and its own rule text demands the specific 3-breakpoint set, so a real domain match makes the
   *   stronger check AUTHORITATIVE both ways (grant AND revoke). 'evidence-satisfied' triggers 'always' and
   *   its OWN documented rule text says "either a generic evidence-fact event, OR (when a real domain is
   *   known) the domain's full required-evidence.json set" — an explicit OR, never a narrowing — so for an
   *   'always'-triggered rule the domain-aware result only ever ADDS a way to satisfy it, never revokes a
   *   real generic evidence-fact the rule already accepted on its own documented terms. */
  /** V25 (2026-09-24 THIRD Codex recheck, out-p8.md remaining gap) — this branch used to consult only the
   *  single ctx.domain value (the caller's resolved domain), so an unrelated/unknown override domain could
   *  starve the domain-specific check entirely and silently fall back to the generic, revocable event-present
   *  signal above. It now iterates ctx.domainCandidates: every domain the CALLER-INDEPENDENT rule.trigger
   *  actually matches (precomputed by the caller; falls back to [ctx.domain] for any caller that has not been
   *  updated to pass the new field, so this stays backward-compatible) — and applies each rule's own
   *  documented strictness contract (see RC-DOMAIN-BYPASS doc above) across that whole set instead of one
   *  caller-chosen value. */
  if (c.domain_aware === true) {
    const candidates = [...new Set((Array.isArray(ctx.domainCandidates) ? ctx.domainCandidates : (ctx.domain ? [ctx.domain] : [])).filter(Boolean))];
    if (candidates.length) {
      const verify = loadVerifyTool();
      if (verify && typeof verify.evidenceCheck === 'function') {
        const results = [];
        for (const d of candidates) {
          try {
            const res = verify.evidenceCheck(ctx.events, d, { runDir: ctx.runDir });
            if (res) results.push(res);
          } catch { /* this ONE candidate domain's evidence check threw — treated as unavailable for it only */ }
        }
        if (results.length) {
          if (rule.trigger !== 'always') satisfied = results.every((r) => r.ok === true); // domain IS why this rule applies — every domain it genuinely applies under must hold
          else if (results.some((r) => r.ok === true)) satisfied = true; // 'always' rule: any matching domain's proof only ADDS a path, never revokes
        }
      }
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

  const root = opts.root ? path.resolve(opts.root) : DEFAULT_ROOT;
  const runDir = opts.runDir ? path.resolve(opts.runDir) : path.join(root, '.claude', 'forge-runs', params.run_id);
  const eventsPath = opts.eventsPath || path.join(runDir, 'events.jsonl');
  const artifactsDir = path.dirname(eventsPath);

  const events = readEventsJsonl(eventsPath, params.run_id);
  const artifacts = listRunArtifacts(artifactsDir);
  /** R6-06 (zesde herreview): `opts.root` stuurde run, registry, bewijs en HEAD, maar NIET de regelset —
   *  die viel terug op het `__dirname`-gebonden RULES_PATH van de installatie. `--root project-B` kon
   *  daardoor events uit B beoordelen tegen de regels van A en CONTRACT OK geven. De E2E verborg dat
   *  juist, omdat die het script naar de tijdelijke root kopieert. Eén root bepaalt nu ook de regels. */
  const meta = loadRulesMeta(opts.rulesPath || path.join(root, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json'));
  const rulesData = meta.data;
  const rules = rulesData.rules;
  const ownerAllowlist = loadOwnerAllowlist(rulesData, opts);

  // The run's own manifest, read best-effort for its DECLARED complexity. A missing/malformed run.json is
  // normal here (12 of this project's 30 runs have none) — it degrades to "nothing declared", never a throw.
  let runMeta = null;
  try { runMeta = JSON.parse(fs.readFileSync(path.join(artifactsDir, 'run.json'), 'utf8')); } catch { runMeta = null; }
  const cx = resolveComplexity(events, runMeta, params.complexity);

  /** RC-DOMAIN-BYPASS (2026-09-24, out-p5.md) — domain used to come ONLY from `params.domain`; a run whose
   *  own run.json genuinely declared `domain:"finance"` was silently read as domain:null the moment a
   *  caller (or the CLI's default invocation with no --domain) omitted it, skipping every domain-scoped
   *  rule for a run that plainly said what domain it was. Declared metadata now provides the FALLBACK; an
   *  explicit param still WINS (a caller may deliberately check under a different/narrower domain), but a
   *  genuine conflict between the two is reported rather than silently dropped, so a mismatch is visible
   *  instead of one value quietly overwriting the other with no trace. */
  const declaredDomain = (runMeta && typeof runMeta.domain === 'string' && runMeta.domain.trim()) ? runMeta.domain.trim() : null;
  const paramDomain = params.domain ? String(params.domain).trim() : null;
  const domain = paramDomain || declaredDomain || null;
  const domainOverridden = !!(paramDomain && declaredDomain && declaredDomain.toLowerCase() !== paramDomain.toLowerCase());
  const domainSource = paramDomain ? (domainOverridden ? 'param-override' : 'param') : (declaredDomain ? 'declared' : 'none');
  /** V25 (2026-09-24 second Codex recheck, out-p7.md) — `domain` above still gave the CALLER'S param
   *  unconditional precedence for RULE APPLICABILITY, not just for the reported label: `ruleApplies(rule,
   *  domain, ...)` only ever consulted the single winning value. REPRODUCED: a run.json declaring
   *  `domain:"finance"` (a correctness-critical domain, obligated to prove real fixtures) read as fully
   *  compliant the moment a caller checked it with `--domain api` — `domain_overridden:true` was reported,
   *  but nothing actually still required the finance obligation. A caller relabeling the check must not be
   *  able to WEAKEN what the run itself declared: on a genuine conflict, a rule now applies if it applies to
   *  EITHER the declared OR the param domain (the union of both obligation sets), so an explicit but
   *  narrower override can still legitimately ADD rules (the caller's own declared intent) without ever
   *  being able to drop the run's own declared ones. No conflict (equal, or only one present) is the
   *  ordinary single-domain case, unchanged. */
  function ruleAppliesForRun(rule, complexity) {
    if (!domainOverridden) return ruleApplies(rule, domain, complexity);
    return ruleApplies(rule, declaredDomain, complexity) || ruleApplies(rule, paramDomain, complexity);
  }
  // V25 (2026-09-24 THIRD Codex recheck, out-p8.md remaining gap) — ruleAppliesForRun() above only decided
  // whether a domain_aware rule's OBLIGATION applies at all (the union). checkSatisfied()'s domain-specific
  // evidence check still received the single caller-resolved `domain` value, so an unrelated/unknown override
  // domain could starve that check of the ACTUAL domain that made the rule apply, silently falling back to
  // the generic (revocable) event-present signal. REPRODUCED: a website-declared run with a claimed-but-
  // nonexistent screenshot correctly failed under domain:"website", but passed under an unrelated
  // domain:"unknown-audit-domain" even though nothing about the real evidence changed. Fix: precompute, per
  // rule, every candidate domain whose OWN trigger genuinely matches (never the caller's unrelated override
  // alone) and hand the whole set to checkSatisfied — it evaluates non-'always' rules AUTHORITATIVELY across
  // that set (every matching domain must be satisfied) and 'always' rules ADDITIVELY (any matching domain
  // adds a path, never revokes), preserving each rule's own documented strictness contract from RC-DOMAIN-
  // BYPASS above, just no longer collapsed onto a single caller-chosen value.
  const candidateDomainPool = domainOverridden ? [declaredDomain, paramDomain] : [domain];

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

  const ruleDetails = {};
  /** R9-09/R9-06 (gehesen, R10): één HEAD-resolutie en één bewijsset-lezing voor de HELE check — niet
   *  per regel opnieuw. De velden gaan ook mee in het resultaat (ruleset_sha256_used e.d.), dus ze
   *  moeten buiten de lus leven. */
  /** D2 fix (2026-09-26, fresh-laptop re-audit) / 2.1 fix (WP-S13, same date, review C VERDICT FAIL) —
   *  `noGitAtRoot` is a REAL, INDEPENDENT probe of THIS root (never affected by a caller-supplied
   *  params.commit_sha override), so a caller who simply omitted commit_sha on a project that DOES have
   *  git can never be confused with a project that genuinely has none. It is now the THREE-WAY gitProbe(),
   *  and `noGitAtRoot` is true ONLY on its POSITIVELY confirmed 'no-repo' state — never on 'undetermined'
   *  (git missing, timed out, dubious-ownership/safe.directory refusal, a repo with no commits yet, a
   *  poisoned env). Before this fix both 'no-repo' and 'undetermined' collapsed onto the same `null`
   *  return from resolveHeadCommit(), so an UNDETERMINED root was silently treated exactly like a
   *  confirmed no-git one — review C's 2.1 finding. Only a genuinely git-less root (state:'no-repo')
   *  relaxes the completion event's commit_sha requirement below (see independentVerification's opts.noGit)
   *  — a project with real git, OR one this probe simply could not read, keeps the exact same fail-closed
   *  behaviour as before the D2 fix ever existed. */
  const gitProbeResult = gitProbe(root);
  const headCommitProbe = gitProbeResult.state === 'repo' ? gitProbeResult.commit : null;
  const noGitAtRoot = gitProbeResult.state === 'no-repo';
  const effectieveCommit = params.commit_sha !== undefined ? params.commit_sha : headCommitProbe;
  const evidenceSet = canonicalEvidenceDigest(root, params.run_id);
  for (const rule of rules) {
    if (unknownTriggerIds.has(rule.id)) continue;
    if (!ruleAppliesForRun(rule, cx.level)) {
      /** F-09/punt 10: op L1 triggert deze regel niet. Stilzwijgen zou de gevaarlijkste uitkomst zijn —
       *  een lezer (of dashboard) leest "geen missing rules" dan als "onafhankelijk geverifieerd". Daarom
       *  expliciet NOT_APPLICABLE, zodat L1 nergens verificatie CLAIMT die niet heeft plaatsgevonden. */
      if (rule.check && rule.check.type === 'independent-verification') {
        ruleDetails['independent-verification'] = { ok: false, applicable: false, route: null, workers: [], reviewer: null, label_only: true, review: null, reason: 'NOT_APPLICABLE — deze regel geldt vanaf ' + rule.trigger + ' en deze run is ' + cx.level + '; er is dus GEEN onafhankelijke verificatie vastgesteld (dat is iets anders dan geslaagd)' };
      }
      continue;
    }
    /** F-12: de evaluator schreef zijn reden naar een WEGGEGOOIDE ctx, dus een rood contract toonde
     *  alleen de regel-ID — niet welke workers/reviewer of welke stale binding het afkeurde. Eén ctx die
     *  blijft leven, en de gesaneerde uitkomst gaat mee in `result.rule_details`. */
    /** R9-09 (negende herreview): alleen de CLI resolveerde HEAD. Productie-aanroepers (server.cjs,
     *  forge-doctor) riepen check() zonder commit_sha aan, waarna een TOEPASSELIJKE onafhankelijke
     *  verificatie altijd fail-closed rood werd — de poort blokkeerde dus op een detail van de
     *  aanroeper in plaats van op de werkelijkheid. check() resolveert nu zelf wanneer de aanroeper
     *  niets meegeeft; expliciet meegeven blijft winnen (tests kunnen zo een vaste commit forceren). */

    /** R9-06: de canonicalizer werd DRIE KEER aangeroepen voor digest, allGreen en failed — drie losse
     *  lezingen van een bestand dat tussendoor kan wijzigen. Nu een keer lezen en dat ene resultaat
     *  gebruiken, zodat de drie velden gegarandeerd bij dezelfde bewijsset horen. */

    // V25: the candidates this SPECIFIC rule's trigger genuinely matches (never a domain the rule would not
    // even apply under on its own) — see the doc above candidateDomainPool.
    const domainCandidatesForRule = candidateDomainPool.filter((d) => d && ruleApplies(rule, d, cx.level));
    const ruleCtx = { events, artifacts, domain, domainCandidates: domainCandidatesForRule, runDir: artifactsDir, commitSha: effectieveCommit || null, noGit: noGitAtRoot, evidenceDigest: (evidenceSet || {}).digest || null, evidenceAllGreen: (evidenceSet || {}).allGreen === true, evidenceFailed: (evidenceSet || {}).failed || [], evidenceCommit: (evidenceSet || {}).commit || null, knownAgents: knownAgentNames(root) || new Set() };
    if (checkSatisfied(rule, ruleCtx)) {
      if (ruleCtx._independentVerification) ruleDetails['independent-verification'] = sanitizeIv(ruleCtx._independentVerification);
      satisfied.push(rule.id); continue;
    }
    if (ruleCtx._independentVerification) ruleDetails['independent-verification'] = sanitizeIv(ruleCtx._independentVerification);

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

  /** RC-UNKNOWN-RULE-GREEN (2026-09-24, out-p5.md) — an unevaluated rule was reported in `unevaluated` but
   *  never affected `ok`, so a version-skewed rules file with an unsupported BLOCKING rule still produced
   *  CONTRACT OK — that obligation was never judged, yet the contract claimed satisfaction. An unevaluated
   *  ADVISORY (severity:"warn") rule is left alone (a caller cannot judge it either, and it never gated
   *  anyway). A blocking one now gets its own `missing`-equivalent entry, kept namespaced (`unknown-rule:<id>`)
   *  so it is never confused with a genuinely-evaluated-and-failed rule id in `missing`/rule_details. */
  const unknownBlocking = [];
  for (const u of meta.unknownTriggers) {
    const rule = rules.find((r) => r.id === u.id);
    if (rule && rule.severity === 'block') {
      const markerId = 'unknown-rule:' + u.id;
      unknownBlocking.push(markerId);
      ruleDetails[markerId] = { ok: false, applicable: null, reason: 'BLOCKING rule "' + u.id + '" uses an unknown trigger ("' + u.trigger + '") this checker cannot evaluate — a version-skewed rules file must never read as satisfied for an obligation nobody judged' };
    }
  }
  if (unknownBlocking.length) missing.push(...unknownBlocking);

  /** RC-MANIFEST-STALE, part 2 (2026-09-24, out-p5.md) — see manifestCompleteness()'s own doc above. An
   *  armed-but-never-finished (and never owner-skipped) work package retroactively invalidates a claimed
   *  evidence-satisfied/verify-checked pass: those rules must reflect real completion of the run's OWN
   *  declared plan, not merely "some accepted evidence event exists somewhere in the log". */
  const manifestState = manifestCompleteness(root, params.run_id, events, ownerAllowlist);
  if (manifestState.applicable) {
    if (!manifestState.ok) {
      // V21: a load-failure reason (corrupt/unreadable/deleted-after-arm) carries no `outstanding` list at
      // all — use manifestState's own reason instead of an empty-list sentence in that case.
      const reason = manifestState.outstanding.length
        ? 'armed manifest package(s) without a completion event or an owner-authenticated skip: '
          + manifestState.outstanding.map((o) => o.wp_id + ' (' + o.status + ')').join(', ')
        : (manifestState.reason || 'the run\'s manifest could not be confirmed complete');
      for (const gateId of MANIFEST_GATED_RULE_IDS) {
        const idx = satisfied.indexOf(gateId);
        if (idx !== -1) {
          satisfied.splice(idx, 1);
          if (!missing.includes(gateId)) missing.push(gateId);
          const prevReason = ruleDetails[gateId] && ruleDetails[gateId].reason;
          ruleDetails[gateId] = Object.assign({}, ruleDetails[gateId] || {}, { ok: false, reason: (prevReason ? prevReason + ' · ' : '') + 'RC-MANIFEST-STALE: ' + reason });
        }
      }
      ruleDetails['manifest-complete'] = { ok: false, applicable: true, outstanding: manifestState.outstanding, reason };
    } else {
      ruleDetails['manifest-complete'] = { ok: true, applicable: true, outstanding: [] };
    }
  }

  const result = {
    ok: missing.length === 0, run_id: params.run_id, domain, satisfied, missing, warnings, overridden,
    // RC-DOMAIN-BYPASS: a caller/reader must be able to see whether the effective domain came from an
    // explicit --domain, the run's own declared run.json, or neither — and whether the two disagreed.
    domain_source: domainSource, domain_declared: declaredDomain, domain_overridden: domainOverridden,
    // F-12: waarom een keyloze check faalde/slaagde, gesaneerd — anders toont een rood contract alleen een ID
    rule_details: ruleDetails,
    // complexity_* is reported on EVERY result, even when no rule is scoped to it — a caller must always be
    // able to see which level a verdict was reached at, and whether that level was declared or only derived.
    complexity: cx.level, complexity_source: cx.source, complexity_declared: cx.declared,
    complexity_derived: cx.derived, complexity_units: cx.units,
    unevaluated,
    /** R10-04: wat DIT proces werkelijk las. Een aanroeper (finalize) kan zelf alleen eindpunten
     *  vergelijken; het venster waarin dit kind las blijft dan onzichtbaar (A→B→A). Door de gebruikte
     *  hashes in het resultaat te rapporteren, kan finalize zijn eigen pins tegen de WERKELIJK
     *  beoordeelde staat leggen in plaats van tegen een herlezenaanname. */
    ruleset_sha256_used: meta.sha256 || null,
    evidence_digest_used: (evidenceSet || {}).digest || null,
    evidence_commit_used: (evidenceSet || {}).commit || null,
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
  independentVerification,
  // geëxporteerd zodat tests kunnen AFDWINGEN dat elk gebruikt eventtype echt bij de writer geregistreerd
  // staat (F-08) — een magic string die niemand kan loggen is een route die alleen op papier bestaat.
  NON_WORK_EVENT_TYPES, ASSIGNMENT_EVENT_TYPES, IV_DISPATCH_TYPES, isReviewDispatch, isWorkEventType, isWorkEvent, isStalingEvent, isGoedkeuring, knownAgentNames, REVIEW_START_TYPES, REVIEW_DONE_TYPES, resolveHeadCommit, canonicalEvidenceDigest,
  // WP-S13 (2.1) — the ONE shared, three-way git probe + its env hardening, so gate-evidence.cjs and
  // finalize.cjs can never independently disagree with check() about the same root.
  gitProbe, cleanGitEnv, hasGitEntryInAncestry,
  check, listRules, loadRules, loadRulesMeta, ruleApplies, checkSatisfied, findOwnerOverride, isMeaningfulReason, loadOwnerAllowlist,
  readEventsJsonl, listRunArtifacts, hasEvent, hasArtifact, logGateEvaluated, eventIsDisproven,
  // RC-MANIFEST-STALE (2026-09-24) — exported so a test can exercise the manifest-completeness gate and the
  // owner-authenticated per-package skip directly, without spawning the CLI.
  manifestCompleteness, findManifestSkip, MANIFEST_SKIP_RULE, MANIFEST_GATED_RULE_IDS,
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
    else if (a === '--finalize') opts.finalize = true;
  }
  return opts;
}
function printUsage() {
  console.error('Usage: node forge-runcontract.cjs check --run <id> [--domain <d>] [--complexity L1|L2|L3|L4] [--root <projectRoot>] [--rules <path>] [--json] [--log-event] [--finalize]');
  console.error('  --complexity  raise the run\'s fan-out level (it is otherwise read from run.json and/or derived from real');
  console.error('                dispatch volume; this flag can only RAISE, never lower — see resolveComplexity())');
  console.error('  --rules       evaluate against a specific FORGE_HARD_RULES.json (default: this project\'s own)');
  console.error('  --log-event   also append a gate_evaluated proof event to the run (via log-event.cjs, one act)');
  console.error('  --finalize    on a green contract, immediately run forge-finalize (the ONE authoritative DONE');
  console.error('                receipt) and require it green too — the canonical completion path in one command');
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
        /** F-03: zonder de ACTUELE commit is `commit_sha` op een review een veld dat niemand controleert.
         *  De CLI kent de werkbare boom, dus die levert hem aan. Geen git-repo (of git ontbreekt) =>
         *  null: de evaluator eist dan nog steeds een welgevormde commit_sha op de review, maar kan hem
         *  niet kruiselings toetsen — dat is een eerlijke beperking, geen stille goedkeuring. */
        /** R4-04 (vierde herreview): `check()` valt zonder --root terug op DEFAULT_ROOT (de installatie
         *  waarin dit script staat), maar de HEAD werd uit `process.cwd()` gehaald. Een absolute aanroep
         *  vanuit repo B beoordeelde dan een run uit repo A tegen de HEAD van B — de commitbinding wees
         *  naar de verkeerde geschiedenis. Eén effectieve root voor run, regels, registry, bewijs én HEAD. */
        const effectiveRoot = callOpts.root ? path.resolve(callOpts.root) : DEFAULT_ROOT;
        const commitSha = resolveHeadCommit(effectiveRoot);
        const result = check({ run_id: opts.run, domain: opts.domain, complexity: opts.complexity, commit_sha: commitSha }, callOpts);
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
            /** N-09: de gesaneerde reden bestond al in `rule_details`, maar alleen de JSON-modus toonde
             *  hem. Een operator die de gewone uitvoer las, zag "MISSING independent-verification" en
             *  moest zelf raden of het zelf-goedkeuring, stale werk, een verkeerde commit of een
             *  gebroken ketenbinding was. De reden staat er nu gewoon bij. */
            for (const m of result.missing) {
              console.log('  ✗ MISSING ' + m);
              const d = result.rule_details && result.rule_details[m];
              if (d && d.reason) console.log('      ↳ ' + String(d.reason).slice(0, 300));
            }
          }
          console.log(cxLine);
          for (const w of result.warnings) console.log('  ⚠ warn: ' + w);
          for (const o of result.overridden) console.log('  ↷ overridden: ' + o.id + ' — "' + o.note + '"');
          // An un-judgeable rule must be LOUD: a stale synced rules file that silently drops a rule is exactly
          // the failure this degrade path exists to make visible.
          for (const u of result.unevaluated) console.log('  ⚠ unevaluated: ' + u.id + ' — ' + u.reason);
          // RC-PROOF-WRITE-SILENT (2026-09-24, out-p5.md) — text mode used to print NOTHING about a failed
          // --log-event write; a green contract read as "CONTRACT OK" with no trace that the requested audit
          // proof never landed. Both modes now say so explicitly.
          if (opts.logEvent && result.logged) console.log(result.logged.ok ? '  ✓ proof logged (gate_evaluated)' : '  ✗ PROOF NOT LOGGED — ' + (result.logged.reason || 'unknown reason'));
        }
        // RC-PROOF-WRITE-SILENT: the documented completion command (`.claude/commands/forge.md`) asks for
        // --log-event as PART OF the completion claim, not as decoration — a writer failure here means the
        // requested audit trail does not exist, so this run cannot honestly report exit 0 either.
        const logWriteFailed = !!(opts.logEvent && result.logged && result.logged.ok !== true);
        // r4 #7 (2026-08-07): het gezaghebbende eindverdict zit nu IN het completionpad — met --finalize
        // eindigt een groen contract pas in exit 0 wanneer ook forge-finalize zijn digest-receipt schreef.
        if (result.ok && opts.finalize) {
          const finMod = require(path.join(__dirname, 'forge-finalize.cjs'));
          const fin = finMod.finalize(opts.root ? path.resolve(opts.root) : path.resolve(__dirname, '..', '..'), opts.run);
          if (opts.json) console.log(JSON.stringify({ finalize: fin.ok ? 'finalized' : 'refused', reason: fin.reason || null }));
          else console.log(fin.ok ? '  ⇒ FINALIZED @ ' + fin.receipt.digest.slice(0, 16) + '…' + (fin.idempotent ? ' (idempotente herbevestiging)' : '') : '  ⇒ FINALIZE REFUSED — ' + fin.reason);
          process.exitCode = (fin.ok && !logWriteFailed) ? 0 : 3;
        } else {
          process.exitCode = (result.ok && !logWriteFailed) ? 0 : 3;
        }
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
