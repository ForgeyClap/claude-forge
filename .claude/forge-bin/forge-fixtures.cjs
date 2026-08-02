#!/usr/bin/env node
'use strict';
/**
 * forge-fixtures.cjs — real-fixtures intake gate (2026-07-18, WAVE D / D2). Applies the Forge honesty
 * core to TEST DATA itself: correctness-critical work (finance/invoicing, parsers, OCR, data/ETL
 * transforms, prediction/backtesting) must be proven against REAL owner-provided sample input, not
 * silently accepted on synthetic-only fixtures. Zero-dependency (no fs/child_process needed — this
 * module classifies and checks; it never reads the .claude/forge-fixtures/ vault directory itself, it
 * only judges what a caller tells it was provided, same "judge only supplied evidence, never scan/
 * invent proof" discipline forge-evidence.cjs uses for required-evidence.json).
 *
 * MODEL:
 *   requirement({ domain }, opts) -> { domain, required:boolean, reason:string }
 *     `domain` is matched case-insensitively against a fixed correctness-critical list (finance,
 *     parser, ocr, data, prediction). Any other domain (e.g. "marketing", "copy", "website-copy") is
 *     NOT required — synthetic or no fixtures is acceptable there. An empty/missing domain is treated
 *     as not correctness-critical (never blocks on missing classification).
 *
 *   check({ domain, providedFixtures, waiver }, opts) -> { ok, needFixtures, domain, required,
 *                                                           fixtures:[...], waiver:{reason,flagged}|null,
 *                                                           reason:string }
 *     `providedFixtures` may be an array of fixture identifiers/paths or a comma-separated string;
 *     empty/missing means none were provided. `waiver` is a free-text reason string logged by the
 *     caller (e.g. the owner explicitly accepting the gap).
 *
 *     Decision table for a correctness-critical domain (required===true):
 *       - real fixtures provided               -> ok:true,  needFixtures:true,  waiver:null
 *       - no fixtures, explicit non-empty waiver -> ok:true,  needFixtures:true,  waiver:{reason,flagged:true}
 *       - no fixtures, no waiver                -> ok:false, needFixtures:true,  waiver:null  (BLOCKED —
 *         no silent synthetic fallback; "done" cannot be honestly claimed until real fixtures exist or
 *         an explicit waiver is logged)
 *     A non-critical domain is always ok:true, needFixtures:false, regardless of fixtures/waiver.
 *
 *     Advisory, matches this project's light-security governance (CLAUDE.md: "no mandatory security
 *     gates") — check() never touches the filesystem or blocks a process by itself; it returns an
 *     honest ok:false for the Lead/owner to act on. The CLI below is the enforcement surface a caller
 *     can wire into a gate (exit 3) if they choose to.
 *
 * CLI:
 *   node forge-fixtures.cjs requirement --domain <d> [--json]
 *   node forge-fixtures.cjs check --domain <d> [--fixtures <a,b>] [--waiver "<reason>"] [--json]
 * Exit codes: 0 = ok (not required / fixtures satisfied / waived) · 3 = BLOCKED (correctness-critical
 * domain, no real fixtures, no waiver) · 2 = usage error.
 */

// Correctness-critical domains — being subtly wrong on real-world input is the actual risk, so
// synthetic-only fixtures don't prove correctness. Kept as a fixed, explicit list (same
// single-source-of-truth discipline forge-actiongate.cjs's KNOWN_GATES uses) rather than a heuristic.
const CRITICAL_DOMAINS = ['finance', 'parser', 'ocr', 'data', 'prediction'];

const CRITICAL_REASONS = {
  finance: 'financial/invoicing/accounting logic must be proven against real numbers, not synthetic guesses',
  parser: 'a parser that is silently wrong on real-world irregular input is worse than one that fails loudly',
  ocr: 'OCR accuracy on clean synthetic text says nothing about real scanned/photographed documents',
  data: 'data-transform/ETL correctness depends on real messy input shapes synthetic fixtures never reproduce',
  prediction: 'prediction/backtesting integrity requires real historical data, never a fabricated series',
};

function normalizeDomain(domain) {
  return String(domain == null ? '' : domain).trim().toLowerCase();
}

function requirement(input, opts) {
  input = input || {};
  opts = opts || {}; // reserved for future overrides; kept for API-signature consistency with the rest of forge-bin
  const domain = normalizeDomain(input.domain);
  const required = CRITICAL_DOMAINS.includes(domain);
  let reason;
  if (required) {
    reason = CRITICAL_REASONS[domain] || 'correctness-critical domain — real fixtures required';
  } else if (domain) {
    reason = 'domain "' + domain + '" is not correctness-critical — synthetic or no fixtures is acceptable';
  } else {
    reason = 'no domain supplied — treated as not correctness-critical, not blocked';
  }
  return { domain, required, reason };
}

function normalizeFixtures(providedFixtures) {
  if (providedFixtures == null) return [];
  if (Array.isArray(providedFixtures)) {
    return providedFixtures.map((f) => String(f).trim()).filter(Boolean);
  }
  return String(providedFixtures)
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean);
}

function normalizeWaiver(waiver) {
  const text = waiver == null ? '' : String(waiver).trim();
  return text.length > 0 ? text : null;
}

function check(input, opts) {
  input = input || {};
  opts = opts || {};
  const req = requirement({ domain: input.domain }, opts);
  const fixtures = normalizeFixtures(input.providedFixtures);
  const waiverText = normalizeWaiver(input.waiver);

  if (!req.required) {
    return { ok: true, needFixtures: false, domain: req.domain, required: false, fixtures, waiver: null, reason: req.reason };
  }
  if (fixtures.length > 0) {
    return {
      ok: true,
      needFixtures: true,
      domain: req.domain,
      required: true,
      fixtures,
      waiver: null,
      reason: 'real fixtures provided for correctness-critical domain "' + req.domain + '"',
    };
  }
  if (waiverText) {
    return {
      ok: true,
      needFixtures: true,
      domain: req.domain,
      required: true,
      fixtures,
      waiver: { reason: waiverText, flagged: true },
      reason: 'no real fixtures provided — explicit logged waiver accepted (flagged, not silent)',
    };
  }
  return {
    ok: false,
    needFixtures: true,
    domain: req.domain,
    required: true,
    fixtures,
    waiver: null,
    reason:
      'correctness-critical domain "' + req.domain + '" has NO real fixtures and NO logged waiver — ' +
      'cannot be called done (no silent synthetic fallback)',
  };
}

module.exports = { requirement, check, normalizeDomain, normalizeFixtures, normalizeWaiver, CRITICAL_DOMAINS };

// ---- CLI ----
function parseArgs(argv) {
  const cmd = argv[0] || null;
  const rest = argv.slice(1);
  const opts = { cmd, domain: null, fixtures: null, waiver: null, json: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--domain') opts.domain = rest[++i];
    else if (a === '--fixtures') opts.fixtures = rest[++i];
    else if (a === '--waiver') opts.waiver = rest[++i];
    else if (a === '--json') opts.json = true;
  }
  return opts;
}
function printUsage() {
  console.error('Usage: node forge-fixtures.cjs requirement --domain <d> [--json]');
  console.error('       node forge-fixtures.cjs check --domain <d> [--fixtures <a,b>] [--waiver "<reason>"] [--json]');
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  try {
    if (opts.cmd === 'requirement') {
      if (!opts.domain) {
        printUsage();
        process.exitCode = 2;
      } else {
        const result = requirement({ domain: opts.domain }, {});
        if (opts.json) console.log(JSON.stringify(result));
        else console.log((result.required ? 'REQUIRED' : 'not required') + ' — ' + result.domain + ' — ' + result.reason);
        process.exitCode = 0;
      }
    } else if (opts.cmd === 'check') {
      if (!opts.domain) {
        printUsage();
        process.exitCode = 2;
      } else {
        const result = check({ domain: opts.domain, providedFixtures: opts.fixtures, waiver: opts.waiver }, {});
        if (opts.json) console.log(JSON.stringify(result));
        else console.log((result.ok ? 'OK' : 'BLOCKED') + ' — ' + result.reason);
        process.exitCode = result.ok ? 0 : 3;
      }
    } else {
      printUsage();
      process.exitCode = 2;
    }
  } catch (e) {
    console.error('forge-fixtures: ' + e.message);
    process.exitCode = 2;
  }
}
