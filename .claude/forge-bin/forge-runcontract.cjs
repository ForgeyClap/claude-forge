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
 *   check({ run_id, domain }, opts) -> { ok, run_id, domain, satisfied:[id,...], missing:[id,...],
 *                                          warnings:[id,...], overridden:[{id,reason,by,note},...] }
 *     run_id  — required. Resolves to <root>/.claude/forge-runs/<run_id>/events.jsonl by default.
 *     domain  — optional real domain slug (e.g. "website", "finance") — decides which trigger:"web" /
 *               trigger:"correctness-critical" / trigger:"domain:<x>" rules even APPLY to this run, and
 *               (for an event-present check with domain_aware:true) unlocks the stronger domain-specific
 *               required-evidence.json proof via forge-verify.cjs::evidenceCheck() (reused, never
 *               re-implemented).
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

// ---- rules config (single source of truth: FORGE_HARD_RULES.json) --------------------------------------
let _rulesCache = null; // { path, data } — cached across calls in the SAME process; tests override via opts.rulesPath
function isValidTrigger(t) {
  return typeof t === 'string' && (KNOWN_TRIGGER_LITERALS.has(t) || (t.startsWith('domain:') && t.length > 'domain:'.length));
}

function loadRules(rulesPath) {
  const p = rulesPath || RULES_PATH;
  if (_rulesCache && _rulesCache.path === p) return _rulesCache.data;

  const raw = fs.readFileSync(p, 'utf8');
  let data;
  try { data = JSON.parse(raw); }
  catch (e) { throw new Error('forge-runcontract: ' + p + ' is not valid JSON: ' + e.message); }

  if (!data || !Array.isArray(data.rules) || data.rules.length === 0) {
    throw new Error('forge-runcontract: ' + p + ' is missing a non-empty "rules" array');
  }

  const seenIds = new Set();
  for (const r of data.rules) {
    if (!r || typeof r !== 'object') throw new Error('forge-runcontract: a rule entry in ' + p + ' is not an object: ' + JSON.stringify(r));
    if (!r.id || typeof r.id !== 'string') throw new Error('forge-runcontract: a rule entry in ' + p + ' is missing a string "id": ' + JSON.stringify(r));
    if (seenIds.has(r.id)) throw new Error('forge-runcontract: duplicate rule id "' + r.id + '" in ' + p);
    seenIds.add(r.id);
    if (!r.rule || typeof r.rule !== 'string') throw new Error('forge-runcontract: rule "' + r.id + '" is missing a string "rule" in ' + p);
    if (!isValidTrigger(r.trigger)) {
      throw new Error('forge-runcontract: rule "' + r.id + '" has an invalid "trigger" in ' + p + ' (must be "always", "web", "correctness-critical", or "domain:<x>")');
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

  _rulesCache = { path: p, data };
  return data;
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
/** ruleApplies(rule, domain) -> boolean — see file header MODEL section. domain may be null/undefined
 *  (no domain known); only "always" rules apply in that case. Never throws. */
function ruleApplies(rule, domain) {
  const d = domain ? String(domain).trim().toLowerCase() : null;
  if (rule.trigger === 'always') return true;
  if (!d) return false;
  if (rule.trigger === 'web') return WEB_DOMAINS.has(d);
  if (rule.trigger === 'correctness-critical') return criticalDomains().some((x) => String(x).toLowerCase() === d);
  if (rule.trigger.startsWith('domain:')) return rule.trigger.slice('domain:'.length).toLowerCase() === d;
  return false;
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
  const rulesData = loadRules(opts.rulesPath);
  const rules = rulesData.rules;
  const ownerAllowlist = loadOwnerAllowlist(rulesData, opts);

  const satisfied = [];
  const missing = [];
  const warnings = [];
  const overridden = [];

  for (const rule of rules) {
    if (!ruleApplies(rule, domain)) continue;
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

  const result = { ok: missing.length === 0, run_id: params.run_id, domain, satisfied, missing, warnings, overridden };

  // gate_evaluated proof event (2026-08-02, opt-in — the gap this closes: this checker existed, was
  // tested, and was cited by FORGE_HARD_RULES.json since V9, yet across 846 real events in 31 runs not
  // ONE gate_evaluated was ever logged, because nothing emitted it. A gate that evaluates silently is
  // indistinguishable from a gate that never ran. Same one-act discipline as forge-manifest's
  // manifest_armed: the check and its proof happen together; a logging failure is reported honestly in
  // result.logged but NEVER flips the verdict — the evaluation already happened.
  if (opts.logEvent === true) result.logged = logGateEvaluated(result, opts);

  return result;
}

// The ONE event writer this project has is .claude/forge-dashboard/log-event.cjs — spawned rather than
// re-implemented, so hash-chaining/honesty-stamping/strict validation are never bypassed (identical
// pattern to forge-manifest.cjs::logManifestArmed, deliberately, so there is one convention to learn).
const LOG_EVENT_PATH = path.join(__dirname, '..', 'forge-dashboard', 'log-event.cjs');

/** logGateEvaluated(result, opts) -> {ok, event_type, reason?, status?} — best-effort, never throws. */
function logGateEvaluated(result, opts) {
  opts = opts || {};
  const script = opts.logEventPath || LOG_EVENT_PATH;
  const note = (result.ok
    ? 'run contract PASSED — ' + result.satisfied.length + ' rule(s) satisfied'
    : 'run contract NOT DONE — missing: ' + result.missing.join(', '))
    + (result.overridden.length ? ' · ' + result.overridden.length + ' overridden' : '')
    + (result.warnings.length ? ' · warnings: ' + result.warnings.join(', ') : '');
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
  check, listRules, loadRules, ruleApplies, checkSatisfied, findOwnerOverride, isMeaningfulReason, loadOwnerAllowlist,
  readEventsJsonl, listRunArtifacts, hasEvent, hasArtifact, logGateEvaluated,
  RULES_PATH, OWNER_PROFILE_PATH, KNOWN_TRIGGER_LITERALS, KNOWN_CHECK_TYPES, KNOWN_SEVERITIES,
};

// ---- CLI ----
function parseArgs(argv) {
  const cmd = argv[0] || null;
  const rest = argv.slice(1);
  const opts = { cmd, run: null, domain: null, root: null, json: false, logEvent: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--run') opts.run = rest[++i];
    else if (a === '--domain') opts.domain = rest[++i];
    else if (a === '--root') opts.root = rest[++i];
    else if (a === '--json') opts.json = true;
    else if (a === '--log-event') opts.logEvent = true;
  }
  return opts;
}
function printUsage() {
  console.error('Usage: node forge-runcontract.cjs check --run <id> [--domain <d>] [--root <projectRoot>] [--json] [--log-event]');
  console.error('  --log-event  also append a gate_evaluated proof event to the run (via log-event.cjs, one act)');
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
        if (opts.logEvent) callOpts.logEvent = true;
        const result = check({ run_id: opts.run, domain: opts.domain }, callOpts);
        // json-mode contract: `logged` must be present whenever --log-event was asked for, so a caller
        // can always distinguish "proof written" from "proof failed" from "proof not requested".
        if (opts.logEvent && !('logged' in result)) result.logged = { ok: false, reason: 'internal: check() did not report a logging outcome' };
        if (opts.json) {
          console.log(JSON.stringify(result));
        } else if (result.ok) {
          console.log('CONTRACT OK — ' + opts.run + ' (' + result.satisfied.length + ' rule(s) satisfied' +
            (result.overridden.length ? ', ' + result.overridden.length + ' overridden' : '') +
            (result.warnings.length ? ', ' + result.warnings.length + ' warning(s)' : '') + ')');
          for (const w of result.warnings) console.log('  ⚠ warn: ' + w);
          for (const o of result.overridden) console.log('  ↷ overridden: ' + o.id + ' — "' + o.note + '"');
        } else {
          console.log('NOT DONE — ' + opts.run + ' is missing ' + result.missing.length + ' required rule(s):');
          for (const m of result.missing) console.log('  ✗ MISSING ' + m);
          for (const w of result.warnings) console.log('  ⚠ warn: ' + w);
          for (const o of result.overridden) console.log('  ↷ overridden: ' + o.id + ' — "' + o.note + '"');
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
