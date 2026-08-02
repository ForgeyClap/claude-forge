#!/usr/bin/env node
'use strict';
/**
 * forge-scout.cjs — external-capability research term-generator + persistent vetting ledger (2026-07-22,
 * PIECE P5). Zero-dependency (fs/path only). This module does NOT perform the actual web-search or video
 * watching itself — that is done by the Lead/Search Boss at runtime per `forge-scout` SKILL.md doctrine
 * (real web-search, then WATCH EACH candidate's video via the `./watch` skill before forming a verdict).
 * What THIS file owns:
 *   1. terms()    — given a project domain (+ optional free-form keywords), generate a TAILORED search-term
 *      list from per-domain seed templates — deliberately NOT a generic "claude skill" search. Distinct
 *      domains produce distinct, domain-flavored terms (see SEED_TEMPLATES); an uncurated domain still gets
 *      a domain-tailored (not generic) fallback built from the domain word itself.
 *   2. record()/list()/isVetted() — an append-only ledger at config/orchestration/FORGE_SCOUT_VETTING.json.
 *      A HARD-PASS verdict for a capability PERSISTS: once recorded, isVetted() always surfaces the
 *      HARD-PASS ahead of any later attempt to (re-)APPROVE the same capability, so junk is never
 *      re-evaluated on a future Scout pass. The ledger file itself is never overwritten wholesale — every
 *      record() call reads the existing file, appends one new entry, and writes the file back whole (same
 *      read-modify-write discipline as forge-store.cjs's per-entity writes); no prior entry is ever deleted
 *      or mutated in place.
 *
 * LEDGER SHAPE (config/orchestration/FORGE_SCOUT_VETTING.json):
 *   { "_doc": <string>, "version": 1, "entries": [ { capability, verdict, reason, source, ts }, ... ] }
 *   verdict is one of 'approve' | 'hard-pass'. A malformed ledger (invalid JSON, wrong top-level shape, an
 *   entry missing a required field) THROWS on read — same fail-closed posture forge-actiongate.cjs and
 *   forge-evidence.cjs use for their own config files; a corrupt ledger must never be silently treated as
 *   "nothing vetted yet."
 *
 * MODEL:
 *   terms({ domain, keywords }, opts) -> { domain, terms: [string,...] }
 *   record({ capability, verdict, reason, source }, opts) -> the appended entry (with ts stamped)
 *   list(opts) -> { entries: [...] }
 *   isVetted(capability, opts) -> null (never vetted) | the prevailing entry (a HARD-PASS, if one exists
 *     for this capability, ALWAYS wins over a later approve; otherwise the most recent entry)
 *   opts.vettingPath overrides the default config/orchestration/FORGE_SCOUT_VETTING.json location (test
 *   hermeticity, same seam every sibling Wave tool uses). process.env.FORGE_SCOUT_VETTING_PATH is the same
 *   override applied when no opts.vettingPath is given — this is what lets the CLI be exercised hermetically
 *   from a spawned subprocess (mirrors forge-store.cjs's FORGE_STORE_ROOT env-var test seam) without ever
 *   writing to this repo's real ledger file.
 *
 * CLI:
 *   node forge-scout.cjs terms --domain <d> [--keywords <k1,k2,...>] [--json]
 *   node forge-scout.cjs record --capability <c> --verdict <approve|hard-pass> --reason "<r>" [--source <s>] [--json]
 *   node forge-scout.cjs list [--json]
 * Exit codes: terms/list: 0 always (advisory, never a gate) · record: 0 = recorded · 2 = usage/validation
 *   error (missing/invalid field, malformed ledger).
 */
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'orchestration', 'FORGE_SCOUT_VETTING.json');
const VALID_VERDICTS = new Set(['approve', 'hard-pass']);

// ---------------------------------------------------------------------------------------------------------
// terms() — tailored, per-domain search-term generation
// ---------------------------------------------------------------------------------------------------------

// Curated seed templates per domain slug (lowercase key). Deliberately domain-flavored — never a bare
// "claude skill"/"claude plugin" phrase on its own. Domain slugs beyond the 7 in domain-presets.json are
// included here on purpose: Scout researches ANY project shape (slides, astro, etc.), not just the domains
// that have a full requirements playbook.
const SEED_TEMPLATES = {
  slides: [
    'claude powerpoint skill', 'claude slide generator skill',
    'I stopped using PowerPoint claude code skill', 'claude code slides plugin',
    'ai presentation generator mcp',
  ],
  presentation: [
    'claude powerpoint skill', 'claude slide generator skill',
    'I stopped using PowerPoint claude code skill', 'claude code slides plugin',
  ],
  astro: [
    'claude astro skill', 'bulk website generator claude',
    'claude code astro plugin', 'astro content collection claude skill',
    'static site generator claude mcp',
  ],
  website: [
    'claude website builder skill', 'claude landing page generator plugin',
    'claude code frontend skill', 'I stopped hand-coding html claude skill',
  ],
  fullstack: [
    'claude fullstack scaffolding skill', 'claude code backend generator plugin',
    'claude api boilerplate skill',
  ],
  n8n: [
    'claude n8n workflow skill', 'claude code automation builder plugin',
    'n8n workflow generator claude mcp',
  ],
  scraping: [
    'claude web scraping skill', 'claude code scraper plugin',
    'claude data extraction mcp',
  ],
  rag: [
    'claude rag pipeline skill', 'claude chatbot knowledge base plugin',
    'claude code retrieval augmented generation skill',
  ],
  prediction: [
    'claude sports prediction skill', 'claude data science forecasting plugin',
  ],
  integration: [
    'claude telegram bot skill', 'claude api integration plugin',
    'claude code webhook skill',
  ],
  electron: [
    'claude electron app skill', 'claude desktop app generator plugin',
    'I stopped building electron by hand claude skill',
  ],
  desktop: [
    'claude electron app skill', 'claude desktop app generator plugin',
    'I stopped building desktop apps by hand claude skill',
  ],
  ecommerce: [
    'claude etsy listing skill', 'claude shopify automation plugin',
    'claude ecommerce product generator skill',
  ],
  dashboard: [
    'claude dashboard builder skill', 'claude data viz plugin',
    'claude code analytics dashboard skill',
  ],
  game: [
    'claude browser game skill', 'claude code game generator plugin',
    'phaser claude skill',
  ],
  mobile: [
    'claude react native skill', 'claude mobile app generator plugin',
  ],
  mlops: [
    'claude mlops skill', 'claude model deployment plugin',
  ],
  tooling: [
    'claude dev tooling skill', 'claude cli generator plugin',
  ],
  voice: [
    'claude voice agent skill', 'claude ai phone agent plugin',
  ],
};

const MAX_TERMS = 16;

function dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const s of arr) {
    const key = String(s).trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(String(s).trim());
  }
  return out;
}

/** genericFallback(domain) — still domain-TAILORED (bakes the actual domain word in), just not curated. */
function genericFallback(domain) {
  return [
    'claude ' + domain + ' skill',
    'claude code ' + domain + ' plugin',
    'I stopped doing ' + domain + ' manually claude skill',
    domain + ' generator claude mcp',
  ];
}

function keywordTerms(keyword) {
  const k = String(keyword).trim();
  if (!k) return [];
  return [
    'claude ' + k + ' skill',
    k + ' claude code plugin',
    'I stopped using ' + k + ' claude code skill',
  ];
}

/** terms({domain, keywords}, opts) -> { domain, terms }. Throws on a missing/empty domain — a caller must
 *  know what it's researching; there is no "generic, no domain" mode. */
function terms(params, opts) {
  params = params || {};
  opts = opts || {};
  if (!params.domain || typeof params.domain !== 'string' || !params.domain.trim()) {
    throw new Error('forge-scout: terms() requires a non-empty "domain" string');
  }
  const domain = params.domain.trim();
  const key = domain.toLowerCase();
  const seeded = SEED_TEMPLATES[key] || [];
  const fallback = seeded.length ? [] : genericFallback(domain);

  const keywords = Array.isArray(params.keywords) ? params.keywords : (params.keywords ? [params.keywords] : []);
  const kwTerms = [];
  for (const kw of keywords) kwTerms.push(...keywordTerms(kw));

  const merged = dedupe([...seeded, ...fallback, ...kwTerms]).slice(0, MAX_TERMS);
  return { domain, terms: merged };
}

// ---------------------------------------------------------------------------------------------------------
// vetting ledger — record()/list()/isVetted()
// ---------------------------------------------------------------------------------------------------------

function nowIso() { return new Date().toISOString(); }

function defaultLedger() {
  return {
    _doc: 'Forge V2 PIECE P5 (2026-07-22) — persistent Scout vetting ledger. Append-only: a HARD-PASS ' +
      'verdict for a capability PERSISTS and is never silently overwritten by a later approve attempt. ' +
      'Written/read by forge-bin/forge-scout.cjs only.',
    version: 1,
    entries: [],
  };
}

/** loadLedger(vettingPath) -> {_doc, version, entries}. Missing file degrades to an honest empty ledger
 *  (normal for a fresh project — Scout hasn't recorded anything yet). A PRESENT-but-malformed file (invalid
 *  JSON, wrong top-level shape, or an entry missing a required field) THROWS — fail closed, same rule every
 *  sibling config/ledger reader in this project already applies. */
function resolvePath(vettingPath) {
  return vettingPath || process.env.FORGE_SCOUT_VETTING_PATH || CONFIG_PATH;
}

function loadLedger(vettingPath) {
  const p = resolvePath(vettingPath);
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return defaultLedger();
    throw new Error('forge-scout: ledger file unreadable (' + p + '): ' + e.message);
  }
  let data;
  try { data = JSON.parse(raw); }
  catch (e) { throw new Error('forge-scout: ledger file is not valid JSON (' + p + '): ' + e.message); }
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.entries)) {
    throw new Error('forge-scout: ledger file must be a JSON object with an "entries" array (' + p + ')');
  }
  for (const entry of data.entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('forge-scout: ledger file has a malformed entry (not an object) in ' + p);
    }
    if (typeof entry.capability !== 'string' || !entry.capability.trim()) {
      throw new Error('forge-scout: ledger entry missing non-empty "capability" in ' + p);
    }
    if (!VALID_VERDICTS.has(entry.verdict)) {
      throw new Error('forge-scout: ledger entry "' + entry.capability + '" has invalid "verdict" in ' + p + ' (must be approve|hard-pass): ' + JSON.stringify(entry.verdict));
    }
    if (typeof entry.reason !== 'string' || !entry.reason.trim()) {
      throw new Error('forge-scout: ledger entry "' + entry.capability + '" missing non-empty "reason" in ' + p);
    }
  }
  return data;
}

function saveLedger(vettingPath, ledger) {
  const p = resolvePath(vettingPath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(ledger, null, 2) + '\n', 'utf8');
}

/** record({capability, verdict, reason, source}, opts) -> appends ONE new entry (never rewrites/removes an
 *  existing one) and returns it. Validates capability/verdict/reason are present and well-formed; source is
 *  optional. Throws (fail closed) on invalid input OR a malformed pre-existing ledger — never silently
 *  drops a verdict or silently "fixes" a corrupt file. */
function record(params, opts) {
  params = params || {};
  opts = opts || {};
  const capability = typeof params.capability === 'string' ? params.capability.trim() : '';
  if (!capability) throw new Error('forge-scout: record() requires a non-empty "capability" string');
  if (!VALID_VERDICTS.has(params.verdict)) {
    throw new Error('forge-scout: record() requires "verdict" to be one of approve|hard-pass, got: ' + JSON.stringify(params.verdict));
  }
  const reason = typeof params.reason === 'string' ? params.reason.trim() : '';
  if (!reason) throw new Error('forge-scout: record() requires a non-empty "reason" string');

  const vettingPath = resolvePath(opts.vettingPath); // honors opts.vettingPath, then FORGE_SCOUT_VETTING_PATH, then CONFIG_PATH
  const ledger = loadLedger(vettingPath); // throws on a pre-existing malformed ledger — fail closed

  const entry = {
    capability,
    verdict: params.verdict,
    reason,
    source: typeof params.source === 'string' && params.source.trim() ? params.source.trim() : null,
    ts: nowIso(),
  };
  ledger.entries = [...ledger.entries, entry]; // append — never mutate/remove a prior entry
  saveLedger(vettingPath, ledger);
  return entry;
}

/** list(opts) -> {entries}. Throws on a malformed ledger (same fail-closed rule as loadLedger). */
function list(opts) {
  opts = opts || {};
  const ledger = loadLedger(resolvePath(opts.vettingPath));
  return { entries: ledger.entries };
}

/** isVetted(capability, opts) -> null | prevailing entry. A HARD-PASS for this capability ALWAYS wins over
 *  any later approve attempt for the same capability — this is what makes a HARD-PASS "persist": once
 *  recorded, no subsequent record() call can make isVetted() report anything other than that HARD-PASS for
 *  this capability. Absent a HARD-PASS, the most recently recorded entry for the capability is returned. */
function isVetted(capability, opts) {
  opts = opts || {};
  const cap = typeof capability === 'string' ? capability.trim() : '';
  if (!cap) throw new Error('forge-scout: isVetted() requires a non-empty capability string');
  const { entries } = list(opts);
  const matches = entries.filter((e) => e.capability.trim().toLowerCase() === cap.toLowerCase());
  if (matches.length === 0) return null;
  const hardPass = matches.find((e) => e.verdict === 'hard-pass');
  if (hardPass) return hardPass;
  return matches[matches.length - 1];
}

module.exports = {
  terms, record, list, isVetted,
  loadLedger, saveLedger, defaultLedger, resolvePath,
  SEED_TEMPLATES, VALID_VERDICTS, CONFIG_PATH, MAX_TERMS,
};

// ---- CLI ----
function parseArgs(argv) {
  const cmd = argv[0] || null;
  const rest = argv.slice(1);
  const opts = { cmd, domain: null, keywords: [], capability: null, verdict: null, reason: null, source: null, json: false, positional: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--domain') opts.domain = rest[++i];
    else if (a === '--keywords') opts.keywords = (rest[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--capability') opts.capability = rest[++i];
    else if (a === '--verdict') opts.verdict = rest[++i];
    else if (a === '--reason') opts.reason = rest[++i];
    else if (a === '--source') opts.source = rest[++i];
    else if (a === '--json') opts.json = true;
    else opts.positional.push(a);
  }
  return opts;
}
function printUsage() {
  console.error('Usage: node forge-scout.cjs terms --domain <d> [--keywords <k1,k2,...>] [--json]');
  console.error('       node forge-scout.cjs record --capability <c> --verdict <approve|hard-pass> --reason "<r>" [--source <s>] [--json]');
  console.error('       node forge-scout.cjs list [--json]');
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  try {
    if (opts.cmd === 'terms') {
      if (!opts.domain) { console.error('forge-scout: terms requires --domain <d>'); process.exitCode = 2; }
      else {
        const result = terms({ domain: opts.domain, keywords: opts.keywords }, {});
        if (opts.json) console.log(JSON.stringify(result));
        else { console.log('domain: ' + result.domain); for (const t of result.terms) console.log('  - ' + t); }
        process.exitCode = 0;
      }
    } else if (opts.cmd === 'record') {
      if (!opts.capability || !opts.verdict || !opts.reason) {
        console.error('forge-scout: record requires --capability <c> --verdict <approve|hard-pass> --reason "<r>"');
        process.exitCode = 2;
      } else {
        const entry = record({ capability: opts.capability, verdict: opts.verdict, reason: opts.reason, source: opts.source }, {});
        if (opts.json) console.log(JSON.stringify(entry));
        else console.log('recorded [' + entry.verdict + '] ' + entry.capability + ' — ' + entry.reason);
        process.exitCode = 0;
      }
    } else if (opts.cmd === 'list') {
      const result = list({});
      if (opts.json) console.log(JSON.stringify(result));
      else {
        console.log('forge-scout ledger — ' + result.entries.length + ' entrie(s)');
        for (const e of result.entries) console.log('  [' + e.verdict + '] ' + e.capability + ' — ' + e.reason + (e.source ? ' (' + e.source + ')' : ''));
      }
      process.exitCode = 0;
    } else {
      printUsage();
      process.exitCode = 2;
    }
  } catch (e) {
    console.error('forge-scout: ' + e.message);
    process.exitCode = 2;
  }
}
