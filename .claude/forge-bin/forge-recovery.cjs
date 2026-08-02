#!/usr/bin/env node
'use strict';
/*
 * forge-recovery.cjs — Forge-native enforcement engine for the GLOBAL RESEARCH RECOVERY &
 * SOLUTION-FIRST POLICY (2026-07-23). Zero-dependency. Module API + CLI.
 *
 * Purpose: stop agents giving up after one failed method. A failed method (401/403/404, no key,
 * wrong path, nested repo, tool unavailable, skill won't import) is NOT an automatic BLOCKED — it
 * triggers a bounded, SAFE recovery loop (public pages -> search -> exact-name GitHub -> repo-path
 * discovery -> Forge-native reimplementation). It NEVER authorizes bypassing authentication, access
 * controls, paywalls, private sources, or any security/owner gate. A BLOCKED status is invalid
 * without a documented attempt ledger (>=3 alternatives, >=5 for high-value) + a Verify-Agent verdict.
 * Secrets are redacted from every recorded attempt.
 *
 * Module API: require('./forge-recovery.cjs') -> {
 *   loadPolicy, POLICY_DEFAULTS, classifyBlocker, isHardStop, requiredAlternatives,
 *   generateAlternatives, githubQueriesFor, repoPathCandidates, redactSecrets, redactRecord,
 *   verifyIdentity, canBlock, finalStatusValid, assertNoAuthBypass, recordAttempt
 * }
 */
const fs = require('fs');
const path = require('path');

const POLICY_PATH = path.join(__dirname, '..', 'config', 'orchestration', 'FORGE_RECOVERY_POLICY.json');
const LEDGER_PATH = path.join(__dirname, '..', 'forge-research', 'recovery-attempts.jsonl');

const POLICY_DEFAULTS = {
  policy: 'global-research-recovery-solution-first',
  version: 1,
  internal_use_only: true,
  public_redistribution_allowed: false,
  solutionFirst: true,
  minimumAlternativeMethods: 3,
  highValueMinimumAlternativeMethods: 5,
  blockOnSecurityRisk: true,
  continueIndependentTracks: true,
  allowPublicWebFallback: true,
  allowFirecrawlPublicDiscovery: true,
  allowExactNameGithubSearch: true,
  allowForgeNativeReimplementation: true,
  allowAuthBypass: false,
  allowPrivateSourceAccessWithoutPermission: false,
  requireVerifyAgent: true,
  requireAttemptLedgerBeforeBlocked: true,
  notImmediateBlockers: [
    'http_401', 'http_403', 'http_404', 'no_api_key', 'empty_search', 'wrong_path',
    'nested_repo', 'layout_differs', 'tool_unavailable', 'mcp_unauthenticated',
    'package_install_failed', 'skill_import_failed', 'incompatible_command',
    'undesirable_dependency', 'one_request_failed', 'one_scrape_failed', 'firecrawl_failed',
  ],
  hardStopConditions: [
    'auth_bypass', 'access_control_bypass', 'paywall_evasion', 'private_repo_no_permission',
    'secret_exposure', 'unauthorized_live_action', 'malicious_code', 'destructive_command',
    'owner_restriction_violation', 'unresolved_critical_security_risk',
  ],
  allowedFinalStatuses: [
    'FOUND_DIRECT', 'FOUND_VIA_PUBLIC_FALLBACK', 'FOUND_VIA_GITHUB_SEARCH',
    'FOUND_VIA_REPOSITORY_DISCOVERY', 'FOUND_VIA_FIRECRAWL', 'FOUND_VIA_WEB_SEARCH',
    'FOUND_VIA_SOURCE_REFERENCE', 'PARTIAL_SOURCE_RECOVERED', 'SAFE_ALTERNATIVE_ADOPTED',
    'FORGE_NATIVE_REIMPLEMENTATION', 'REJECTED_UNSAFE', 'BLOCKED_ACCESS',
    'BLOCKED_EXTERNAL_LIMIT', 'BLOCKED_PERMISSION', 'BLOCKED_AFTER_EXHAUSTIVE_RECOVERY',
  ],
  ledger: '.claude/forge-research/recovery-attempts.jsonl',
};

function readJson(f, fallback) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } }

function loadPolicy(opts) {
  opts = opts || {};
  const p = opts.policyPath || POLICY_PATH;
  const raw = readJson(p, null);
  if (!raw || typeof raw !== 'object') return Object.assign({}, POLICY_DEFAULTS);
  return Object.assign({}, POLICY_DEFAULTS, raw);
}

// --- blocker classification -------------------------------------------------
const ALIASES = {
  '401': 'http_401', '403': 'http_403', '404': 'http_404', '429': 'http_429', '410': 'gone_410',
  unauthorized: 'http_401', forbidden: 'http_403', 'not found': 'http_404', 'not_found': 'http_404',
  'no key': 'no_api_key', 'missing key': 'no_api_key', notfound: 'http_404',
};
function normSignal(signal) {
  if (signal == null) return 'unknown';
  // numeric codes go through the SAME alias table as strings (fix: numeric 410 -> gone_410,
  // matching string '410'; found by the Verify Agent as an asymmetry, 2026-07-23).
  if (typeof signal === 'number') { const s = String(signal); return ALIASES[s] || ('http_' + s); }
  let s = String(signal).trim().toLowerCase();
  if (/^\d{3}$/.test(s)) return ALIASES[s] || ('http_' + s);
  if (ALIASES[s]) return ALIASES[s];
  return s.replace(/[\s-]+/g, '_');
}

function isHardStop(signal, policy) {
  policy = policy || loadPolicy();
  const n = normSignal(signal);
  return (policy.hardStopConditions || []).includes(n);
}

function classifyBlocker(signal, opts) {
  opts = opts || {};
  const policy = opts.policy || loadPolicy();
  const n = normSignal(signal);
  const hardStop = (policy.hardStopConditions || []).includes(n) || opts.security === true;
  const known = (policy.notImmediateBlockers || []).includes(n);
  return {
    signal: n,
    hardStop,
    // solution-first: a method failure NEVER auto-blocks; unknown failures also enter recovery.
    autoBlock: false,
    // a hard-stop still requires a DECISION: reject the candidate. `autoReject`/`action` remove the
    // misuse trap where a caller gated only on `autoBlock` and never rejected malicious/destructive
    // candidates (Security Boss finding, 2026-07-23).
    autoReject: hardStop,
    action: hardStop ? 'reject_candidate' : 'recover',
    recoverable: !hardStop,
    // the OBJECTIVE stays possible even when one METHOD fails (only permanent removals flag this)
    objectiveImpossible: n === 'gone_410',
    // a hard-stop rejects the CANDIDATE, but the mission keeps running other tracks
    missionContinue: policy.continueIndependentTracks !== false,
    recommendedCandidateStatus: hardStop ? 'REJECTED_UNSAFE' : null,
    knownRecoverable: known,
  };
}

// --- alternative generation -------------------------------------------------
function requiredAlternatives(policy, highValue) {
  policy = policy || loadPolicy();
  return highValue ? (policy.highValueMinimumAlternativeMethods || 5) : (policy.minimumAlternativeMethods || 3);
}

function firstWords(s, n) {
  return String(s || '').trim().split(/\s+/).slice(0, n || 6).join(' ');
}

function githubQueriesFor(name, meta) {
  meta = meta || {};
  const q = [
    '"' + name + '" GitHub',
    '"' + name + '" SKILL.md',
    'site:github.com "' + name + '"',
    'site:github.com "' + name + '" "SKILL.md"',
    'site:github.com "skills/' + name + '"',
    'github code search: ' + name,
    'github repo search: ' + name,
  ];
  if (meta.owner) {
    q.push('site:github.com/' + meta.owner + ' "' + name + '"');
    q.push('repo owner search: ' + meta.owner + ' ' + name);
  }
  if (meta.description) {
    q.push('site:github.com "' + name + '" "' + firstWords(meta.description) + '"');
    q.push('description search: ' + firstWords(meta.description));
  }
  if (meta.install) q.push('install-command search: ' + firstWords(meta.install, 4));
  return q;
}

function repoPathCandidates(name) {
  return [
    'SKILL.md',
    'skills/' + name + '/SKILL.md',
    '.claude/skills/' + name + '/SKILL.md',
    'plugins/' + name + '/',
    'commands/' + name + '/',
    'packages/' + name + '/',
    'src/skills/' + name + '/',
    'examples/' + name + '/',
    'marketplace/' + name + '/',
  ];
}

function generateAlternatives(item, opts) {
  item = item || {};
  opts = opts || {};
  const policy = opts.policy || loadPolicy();
  const highValue = !!opts.highValue;
  const routes = [];
  if (opts.firecrawlAvailable && policy.allowFirecrawlPublicDiscovery) {
    routes.push({ route: 'firecrawl_public', safe: true, method: 'crawl public skill index (discovery data, not truth)' });
  }
  if (policy.allowPublicWebFallback) {
    routes.push({ route: 'public_pages', safe: true, method: 'public skills.sh leaderboards/category/creator/detail pages' });
    routes.push({ route: 'search_engine', safe: true, method: 'web search for exact name + description' });
  }
  if (policy.allowExactNameGithubSearch) {
    routes.push({ route: 'exact_name_github', safe: true, method: 'exact-name GitHub search', queries: githubQueriesFor(item.name, item) });
  }
  routes.push({ route: 'repo_structure_discovery', safe: true, method: 'try alternate repo paths', paths: repoPathCandidates(item.name) });
  if (policy.allowForgeNativeReimplementation) {
    routes.push({ route: 'forge_native_reimplementation', safe: true, method: 'safe zero-dep Forge-native reconstruction of the behavior' });
  }
  // enforce: every generated route is safe (no auth-bypass) — throws if any route is unsafe.
  routes.forEach((r) => assertNoAuthBypass(r, policy));
  const min = requiredAlternatives(policy, highValue);
  return { routes, min, meetsMin: routes.length >= min, highValue, ledger: policy.ledger };
}

// --- secret redaction -------------------------------------------------------
// Redact by secret VALUE-SHAPE (robust across surrounding text) + a STRICT env-style NAME=value rule.
// Hardened 2026-07-23 after adversarial review: (a) added AWS/Google/Slack/JWT token shapes that were
// leaking to the ledger; (b) leading (?<![A-Za-z0-9]) on sk-/nvapi- so they no longer fire mid-word
// ("task-management" no longer -> "sk-" match); (c) the NAME=value rule now requires an UPPERCASE
// env-style name whose underscore-delimited segments include an exact sensitive word, so "MONKEY",
// "TOKENIZER", and lowercase "monkey:" are NOT redacted. Deliberately does NOT blanket-redact long hex:
// git SHAs / content hashes are legitimate ledger data (confirmed by the reviewer).
function redactSecrets(input) {
  if (input == null) return input;
  let s = String(input);
  s = s.replace(/(?<![A-Za-z0-9])nvapi-[A-Za-z0-9_\-]{6,}/g, 'nvapi-***REDACTED***');
  s = s.replace(/(?<![A-Za-z0-9])sk-[A-Za-z0-9_\-]{8,}/g, 'sk-***REDACTED***');
  s = s.replace(/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, (m) => m.slice(0, 4) + '***REDACTED***');
  s = s.replace(/\bgithub_pat_[A-Za-z0-9_]{16,}\b/g, 'github_pat_***REDACTED***');
  s = s.replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***REDACTED***');
  s = s.replace(/\bAIza[0-9A-Za-z_\-]{30,}/g, 'AIza***REDACTED***');
  s = s.replace(/\bxox[baprs]-[0-9A-Za-z\-]{10,}/g, (m) => m.slice(0, 5) + '***REDACTED***');
  s = s.replace(/\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{5,}\.[A-Za-z0-9_\-]{5,}\b/g, 'eyJ***REDACTED_JWT***');
  s = s.replace(/(Bearer\s+)[A-Za-z0-9._\-]{8,}/gi, '$1***REDACTED***');
  s = s.replace(
    /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)(\s*[:=]\s*)(['"]?)([^\s'"]{4,})(\3)/g,
    (m, name, sep, q, _val, q2) => {
      const segs = name.split('_');
      const sensitive = /^(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|APIKEY|ACCESSKEY|SECRETKEY|AUTH)$/;
      const hit = segs.some((seg) => sensitive.test(seg)) || /(?:^|_)(KEY|TOKEN|SECRET|PASSWORD)$/.test(name);
      return hit ? name + sep + q + '***REDACTED***' + q2 : m;
    }
  );
  return s;
}

function redactRecord(obj) {
  if (obj == null) return obj;
  if (typeof obj === 'string') return redactSecrets(obj);
  if (Array.isArray(obj)) return obj.map(redactRecord);
  if (typeof obj === 'object') {
    const out = {};
    for (const k of Object.keys(obj)) out[k] = redactRecord(obj[k]);
    return out;
  }
  return obj;
}

// --- identity verification --------------------------------------------------
function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }
function nameSimilar(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

function verifyIdentity(sig) {
  sig = sig || {};
  const nameExact = !!(sig.foundName && sig.expectedName) && norm(sig.foundName) === norm(sig.expectedName);
  const ownerExact = !!(sig.foundOwner && sig.expectedOwner) && norm(sig.foundOwner) === norm(sig.expectedOwner);
  const ownerMismatch = !!(sig.foundOwner && sig.expectedOwner) && norm(sig.foundOwner) !== norm(sig.expectedOwner);
  const corroboration = [sig.hasSkillMd, sig.descriptionMatch, sig.installMatch, sig.hashMatch].filter(Boolean).length;
  let confidence;
  if (nameExact && sig.hashMatch) confidence = 'VERIFIED_EXACT';
  else if (nameExact && ownerExact && corroboration >= 1) confidence = 'VERIFIED_EXACT';
  else if (nameExact && corroboration >= 1 && !ownerMismatch) confidence = 'HIGH_CONFIDENCE';
  else if (nameExact && ownerMismatch && corroboration === 0) confidence = 'NAME_COLLISION';
  else if (nameExact) confidence = 'POSSIBLE';
  else if (nameSimilar(sig.expectedName, sig.foundName)) confidence = 'POSSIBLE';
  else confidence = 'UNVERIFIED';
  return { confidence, canProceed: confidence === 'VERIFIED_EXACT' || confidence === 'HIGH_CONFIDENCE', corroboration, ownerMismatch };
}

// --- block gate + status validity ------------------------------------------
function finalStatusValid(status, policy) {
  policy = policy || loadPolicy();
  return (policy.allowedFinalStatuses || []).includes(status);
}

function canBlock(record, opts) {
  opts = opts || {};
  const policy = opts.policy || loadPolicy();
  record = record || {};
  if (!policy.requireAttemptLedgerBeforeBlocked) return { ok: true, missing: [], min: 0 };
  const highValue = !!record.highValue;
  const min = requiredAlternatives(policy, highValue);
  const missing = [];
  // Content-aware gate (hardened 2026-07-23): a fabricated ledger of empty strings + any truthy
  // verdict + a fake "BLOCKEDXYZ" status previously passed. Now: status must be a REAL BLOCKED_*
  // status, ledger entries must be non-empty, and the verdict must be a recognized Verify-Agent verdict.
  const KNOWN_VERDICTS = new Set([
    'VERIFIED_PASS', 'VERIFIED_PASS_WITH_LIMITATIONS', 'REJECTED', 'BLOCKED', 'INSUFFICIENT_EVIDENCE',
  ]);
  const nonEmpty = (a) => (Array.isArray(a) ? a.filter((x) => (typeof x === 'string' ? x.trim().length > 0 : x != null)) : []);
  if (!finalStatusValid(record.finalStatus, policy) || !/^BLOCKED/.test(String(record.finalStatus || ''))) {
    missing.push('finalStatus must be a valid BLOCKED_* status (in allowedFinalStatuses)');
  }
  const attempted = nonEmpty(record.alternativesAttempted);
  if (attempted.length < min) missing.push('needs >=' + min + ' NON-EMPTY alternativesAttempted (has ' + attempted.length + ')');
  if (nonEmpty(record.queries).length < 1) missing.push('needs non-empty queries[]');
  if (nonEmpty(record.tools).length < 1) missing.push('needs non-empty tools[]');
  if (policy.requireVerifyAgent) {
    const vv = String(record.verifyVerdict || '').toUpperCase().replace(/\s+/g, '_');
    if (!record.verifyVerdict) missing.push('needs Verify Agent verdict');
    else if (!KNOWN_VERDICTS.has(vv)) missing.push('verifyVerdict not a recognized Verify-Agent verdict: ' + record.verifyVerdict);
  }
  return { ok: missing.length === 0, missing, min };
}

// --- safety guard -----------------------------------------------------------
function assertNoAuthBypass(route, policy) {
  policy = policy || loadPolicy();
  // Inspect ALL free-text fields, not just the route id (Security Boss finding 2026-07-23: a bypass
  // described in route.method/description previously passed). Expanded denylist covers the common
  // phrasings an agent-proposed route might use.
  const parts = [];
  if (typeof route === 'string') parts.push(route);
  else if (route && typeof route === 'object') {
    for (const k of ['route', 'method', 'description', 'detail', 'note']) if (route[k]) parts.push(String(route[k]));
    if (Array.isArray(route.queries)) parts.push(route.queries.join(' '));
    if (Array.isArray(route.paths)) parts.push(route.paths.join(' '));
  }
  const hay = parts.join(' ').toLowerCase();
  const DENY = /(auth[_\s-]?bypass|bypass[_\s-]?(auth|login|access|paywall)|access[_\s-]?control[_\s-]?(bypass|evasion)|paywall[_\s-]?(evasion|bypass)?|private[_\s-]?repo|credential.{0,4}(steal|dump|theft)|stolen.{0,6}(session|cookie|credential|token)|session[_\s-]?hijack|cookie[_\s-]?theft|privilege[_\s-]?escalation|disable[_\s-]?auth|unauthenticated.{0,6}(exploit|endpoint)|hidden[_\s-]?endpoint|brute[_\s-]?force)/i;
  const flagged = DENY.test(hay) || (route && (route.authBypass === true || route.bypassAuth === true));
  if (flagged && !policy.allowAuthBypass) {
    throw new Error('prohibited by FORGE_RECOVERY_POLICY (allowAuthBypass=false): route implies auth/access bypass -> ' + hay.slice(0, 140));
  }
  return true;
}

// --- ledger -----------------------------------------------------------------
function recordAttempt(record, opts) {
  opts = opts || {};
  const ledgerPath = opts.ledgerPath || LEDGER_PATH;
  const now = opts.now || new Date().toISOString();
  const full = {
    itemId: record.itemId || null,
    itemType: record.itemType || null,
    objective: record.objective || null,
    initialMethod: record.initialMethod || null,
    initialFailure: record.initialFailure || null,
    failureClass: record.failureClass || null,
    alternativesGenerated: record.alternativesGenerated || [],
    alternativesAttempted: record.alternativesAttempted || [],
    queries: record.queries || [],
    tools: record.tools || [],
    firecrawlUsed: record.firecrawlUsed === true,
    githubRecoveryUsed: record.githubRecoveryUsed === true,
    forgeNativeConsidered: record.forgeNativeConsidered === true,
    securityDecision: record.securityDecision || null,
    finalStatus: record.finalStatus || null,
    resultSource: record.resultSource || null,
    verifyVerdict: record.verifyVerdict || null,
    identityConfidence: record.identityConfidence || null,
    timestamp: now,
  };
  const safe = redactRecord(full);
  if (!opts.dryRun) {
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.appendFileSync(ledgerPath, JSON.stringify(safe) + '\n');
  }
  return safe;
}

module.exports = {
  POLICY_DEFAULTS, POLICY_PATH, LEDGER_PATH,
  loadPolicy, classifyBlocker, isHardStop, requiredAlternatives, normSignal,
  generateAlternatives, githubQueriesFor, repoPathCandidates,
  redactSecrets, redactRecord, verifyIdentity, canBlock, finalStatusValid,
  assertNoAuthBypass, recordAttempt,
};

// --- CLI --------------------------------------------------------------------
if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const rest = args.slice(1);
  const out = (o) => console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 2));
  function parseJsonArg(a) { try { return JSON.parse(a); } catch { try { return JSON.parse(fs.readFileSync(a, 'utf8')); } catch { return null; } } }
  function flag(name, def) { const i = rest.indexOf('--' + name); return i >= 0 ? rest[i + 1] : def; }
  try {
    if (cmd === 'classify') { out(classifyBlocker(rest[0])); }
    else if (cmd === 'queries') { out(githubQueriesFor(rest[0], { description: flag('desc'), owner: flag('owner') })); }
    else if (cmd === 'paths') { out(repoPathCandidates(rest[0])); }
    else if (cmd === 'alternatives') { out(generateAlternatives({ name: rest[0], description: flag('desc'), owner: flag('owner') }, { highValue: rest.includes('--high') })); }
    else if (cmd === 'redact') { out(redactSecrets(rest.join(' '))); }
    else if (cmd === 'identity') { out(verifyIdentity(parseJsonArg(rest[0]) || {})); }
    else if (cmd === 'check-block') { out(canBlock(parseJsonArg(rest[0]) || {})); }
    else if (cmd === 'policy') { out(loadPolicy()); }
    else if (cmd === 'selftest') {
      const c = classifyBlocker('http_401');
      const g = generateAlternatives({ name: 'gws-gmail-reply' }, {});
      const b = canBlock({ finalStatus: 'BLOCKED_ACCESS' });
      const ok = c.autoBlock === false && c.recoverable === true && g.meetsMin === true && b.ok === false;
      out({ selftest: ok ? 'PASS' : 'FAIL', classify401: c, meetsMin: g.meetsMin, blockWithoutLedger: b.ok });
      process.exit(ok ? 0 : 1);
    } else {
      out('usage: forge-recovery.cjs <classify|queries|paths|alternatives|redact|identity|check-block|policy|selftest> [args]');
      process.exit(2);
    }
  } catch (e) { console.error('forge-recovery error: ' + e.message); process.exit(1); }
}
