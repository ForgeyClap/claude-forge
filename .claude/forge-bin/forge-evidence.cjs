#!/usr/bin/env node
'use strict';
/**
 * forge-evidence.cjs — required-evidence gate (2026-07-18, piece C2). The SINGLE source of truth for
 * deciding whether a run produced the PROOF a domain needs to honestly be called "done" — encodes the
 * repeated owner ask "prove it with REAL proof" and kills the failure mode where a doctor/verify pass says
 * done but the underlying evidence (responsive screenshots, validate_workflow output, a robots/source note,
 * etc.) was never actually produced. Reads config/orchestration/required-evidence.json — no other file may
 * re-implement this matching logic (same single-source-of-truth discipline forge-actiongate.cjs established
 * for hard-gates.json). Zero-dependency (fs/path only). Pure check() — the only I/O is a cached, synchronous
 * read of the JSON config on first use.
 *
 * MODEL:
 *   check({ domain, artifacts, events }, opts) -> { ok:boolean, domain:string, missing:[id,...], satisfied:[id,...] }
 *     domain    — required domain slug (must match a key in required-evidence.json's "domains", e.g.
 *                 "website", "fullstack", "n8n", "scraping", "rag", "prediction", "integration").
 *     artifacts — array (or single string) of artifact paths/ids the caller can actually point to. Evidence
 *                 "presence" is judged ONLY from what is passed here — this function never scans the
 *                 filesystem and never invents proof; an empty/omitted artifacts list simply means no
 *                 artifact-kind evidence can be satisfied, honestly.
 *     events    — array (or single string) of logged event types the caller can actually point to (e.g.
 *                 from events.jsonl). Same honesty rule as artifacts.
 *   opts.evidencePath overrides the default config/orchestration/required-evidence.json location (test
 *   hermeticity, same seam as forge-actiongate.cjs's opts.configPath).
 *
 *   Each evidence item in the config has a `kind`:
 *     - 'artifact'         — satisfied when ANY supplied artifact string contains (case-insensitive) ANY of
 *                             the item's `any_of_substrings`.
 *     - 'event'            — satisfied when ANY supplied event type exactly matches (case-insensitive) ANY
 *                             of the item's `any_of_events`.
 *     - 'artifact_or_event'— satisfied by either path above.
 *   An item that isn't satisfied lands in `missing` (by id); a satisfied item lands in `satisfied` (by id).
 *   `ok` is true only when `missing` is empty.
 *
 * CLI:
 *   node forge-evidence.cjs check --domain <domain> [--artifacts <a,b,...>] [--events <a,b,...>] [--json]
 * Exit codes: 0 = ok (every required evidence item present) · 3 = not ok (at least one missing — mirrors
 * the sibling *-gate tools' STOP=3 convention, e.g. forge-actiongate's gate=3) · 2 = usage/config error.
 */
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'orchestration', 'required-evidence.json');
const KNOWN_KINDS = ['artifact', 'event', 'artifact_or_event'];

let _cache = null; // { path, data } — cached across calls in the SAME process; tests override via opts.evidencePath
function loadConfig(configPath) {
  const p = configPath || CONFIG_PATH;
  if (_cache && _cache.path === p) return _cache.data;

  const raw = fs.readFileSync(p, 'utf8');
  let data;
  try { data = JSON.parse(raw); }
  catch (e) { throw new Error('forge-evidence: ' + p + ' is not valid JSON: ' + e.message); }

  if (!data || typeof data.domains !== 'object' || data.domains === null || Array.isArray(data.domains) || Object.keys(data.domains).length === 0) {
    throw new Error('forge-evidence: ' + p + ' is missing a non-empty "domains" object');
  }

  for (const domainKey of Object.keys(data.domains)) {
    const entry = data.domains[domainKey];
    if (!entry || !Array.isArray(entry.evidence) || entry.evidence.length === 0) {
      throw new Error('forge-evidence: domain "' + domainKey + '" in ' + p + ' is missing a non-empty "evidence" array');
    }
    for (const item of entry.evidence) {
      if (!item || !item.id || typeof item.id !== 'string') {
        throw new Error('forge-evidence: an evidence item in domain "' + domainKey + '" of ' + p + ' is missing a string "id": ' + JSON.stringify(item));
      }
      if (!item.label || typeof item.label !== 'string') {
        throw new Error('forge-evidence: evidence item "' + item.id + '" in domain "' + domainKey + '" of ' + p + ' is missing a string "label"');
      }
      if (!KNOWN_KINDS.includes(item.kind)) {
        throw new Error('forge-evidence: evidence item "' + item.id + '" in domain "' + domainKey + '" of ' + p + ' has unknown kind "' + item.kind + '" (must be one of ' + KNOWN_KINDS.join(', ') + ')');
      }
      if ((item.kind === 'artifact' || item.kind === 'artifact_or_event') && (!Array.isArray(item.any_of_substrings) || item.any_of_substrings.length === 0)) {
        throw new Error('forge-evidence: evidence item "' + item.id + '" in domain "' + domainKey + '" of ' + p + ' has kind "' + item.kind + '" but no non-empty "any_of_substrings"');
      }
      if ((item.kind === 'event' || item.kind === 'artifact_or_event') && (!Array.isArray(item.any_of_events) || item.any_of_events.length === 0)) {
        throw new Error('forge-evidence: evidence item "' + item.id + '" in domain "' + domainKey + '" of ' + p + ' has kind "' + item.kind + '" but no non-empty "any_of_events"');
      }
    }
  }

  _cache = { path: p, data };
  return data;
}

function toArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function matchesArtifact(artifacts, substrings) {
  if (!Array.isArray(substrings) || substrings.length === 0) return false;
  const lowered = artifacts.map((a) => String(a).toLowerCase());
  return substrings.some((sub) => {
    const needle = String(sub).toLowerCase();
    return lowered.some((a) => a.includes(needle));
  });
}

function matchesEvent(events, eventNames) {
  if (!Array.isArray(eventNames) || eventNames.length === 0) return false;
  const lowered = events.map((e) => String(e).toLowerCase());
  return eventNames.some((name) => lowered.includes(String(name).toLowerCase()));
}

function isSatisfied(item, artifacts, events) {
  if (item.kind === 'artifact') return matchesArtifact(artifacts, item.any_of_substrings);
  if (item.kind === 'event') return matchesEvent(events, item.any_of_events);
  return matchesArtifact(artifacts, item.any_of_substrings) || matchesEvent(events, item.any_of_events);
}

function check(params, opts) {
  params = params || {};
  opts = opts || {};
  if (!params.domain || typeof params.domain !== 'string') {
    throw new Error('forge-evidence: check() requires a non-empty "domain" string');
  }

  const { domains } = loadConfig(opts.evidencePath);
  const domainEntry = domains[params.domain] || domains[params.domain.toLowerCase()];
  if (!domainEntry) {
    throw new Error('forge-evidence: unknown domain "' + params.domain + '" (known domains: ' + Object.keys(domains).join(', ') + ')');
  }

  const artifacts = toArray(params.artifacts);
  const events = toArray(params.events);

  const missing = [];
  const satisfied = [];
  for (const item of domainEntry.evidence) {
    if (isSatisfied(item, artifacts, events)) satisfied.push(item.id);
    else missing.push(item.id);
  }

  return { ok: missing.length === 0, domain: params.domain, missing, satisfied };
}

function listDomains(opts) {
  const { domains } = loadConfig(opts && opts.evidencePath);
  return Object.keys(domains);
}

module.exports = { check, loadConfig, listDomains, matchesArtifact, matchesEvent, isSatisfied, KNOWN_KINDS, CONFIG_PATH };

// ---- CLI ----
function parseArgs(argv) {
  const cmd = argv[0] || null;
  const rest = argv.slice(1);
  const opts = { cmd, domain: null, artifacts: [], events: [], json: false, positional: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--domain') opts.domain = rest[++i];
    else if (a === '--artifacts') opts.artifacts = (rest[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--events') opts.events = (rest[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--json') opts.json = true;
    else opts.positional.push(a);
  }
  return opts;
}
function printUsage() {
  console.error('Usage: node forge-evidence.cjs check --domain <domain> [--artifacts <a,b,...>] [--events <a,b,...>] [--json]');
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  try {
    if (opts.cmd === 'check') {
      if (!opts.domain) { console.error('forge-evidence: check requires --domain <domain>'); process.exitCode = 2; }
      else {
        const result = check({ domain: opts.domain, artifacts: opts.artifacts, events: opts.events }, {});
        if (opts.json) {
          console.log(JSON.stringify(result));
        } else if (result.ok) {
          console.log('OK — all required evidence present for domain "' + result.domain + '" (' + result.satisfied.length + ' item(s)).');
        } else {
          console.log('MISSING EVIDENCE for domain "' + result.domain + '": ' + result.missing.join(', '));
          console.log('satisfied: ' + (result.satisfied.length ? result.satisfied.join(', ') : '(none)'));
        }
        process.exitCode = result.ok ? 0 : 3;
      }
    } else {
      printUsage();
      process.exitCode = 2;
    }
  } catch (e) {
    console.error('forge-evidence: ' + e.message);
    process.exitCode = 2;
  }
}
