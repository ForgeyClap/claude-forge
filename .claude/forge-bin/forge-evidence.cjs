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

/** GENERIC_EVENTS — the events that say "something was checked" or "something finished" WITHOUT saying
 *  what (broad Codex audit #5, fixed 2026-08-05). They were listed as acceptable proof inside
 *  DOMAIN-SPECIFIC requirements, which quietly collapsed most domains to a single fact: emitting one
 *  `check_passed` satisfied 3 of the 4 payments requirements — "the security surface was really examined"
 *  and "payment safety was really exercised" both ticked green off an event that could have come from a
 *  lint run. The same leak was in 14 of 26 domains. A requirement marked `specific: true` now REFUSES
 *  these events: it must be met by a domain-specific event or by a real, on-disk artifact. The two ids
 *  that are generic BY DESIGN (a domain's "a real check ran at all" item and its final report) simply are
 *  not marked specific, so nothing about them changes. */
const GENERIC_EVENTS = ['check_passed', 'quality_gate_passed', 'integration_gate_passed', 'agent_completed',
  'run_completed', 'report_generated', 'wp_completed'];
const isGenericEvent = (name) => GENERIC_EVENTS.includes(String(name).toLowerCase());

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
      // A domain-specific guarantee may not be provable by a domain-agnostic event — the config itself is
      // where this regressed last time, so it is rejected at LOAD time rather than quietly accepted.
      if (item.specific) {
        const leaked = (item.any_of_events || []).filter(isGenericEvent);
        if (leaked.length) {
          throw new Error('forge-evidence: evidence item "' + item.id + '" in domain "' + domainKey + '" of ' + p
            + ' is marked specific:true but accepts the domain-agnostic event(s) ' + leaked.join(', ')
            + ' — a generic "something passed" event is not proof of a specific guarantee (remove them, or drop specific:true if the requirement really is generic)');
        }
      }
    }
    // A domain whose every requirement can be met by generic evidence has no real gate at all.
    if (!entry.evidence.some((i) => i.specific)) {
      throw new Error('forge-evidence: domain "' + domainKey + '" in ' + p + ' has no requirement marked specific:true'
        + ' — every one of its guarantees would be satisfiable by generic "a check passed / the run finished" evidence');
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

/** artifactsOnDisk — REAL FILES ONLY (broad Codex audit #4, fixed 2026-08-05).
 *  Artifact requirements were substring matches over caller-supplied STRINGS, while every label promised
 *  "a real, non-empty artifact exists". Emitting the single made-up path
 *  `fake/mobile-tablet-desktop-zero-console-375-768-1440.png` therefore satisfied four website
 *  requirements at once without a single screenshot existing — the evidence gate could be passed by
 *  naming a file rather than producing one. When a run directory is known (opts.runDir / opts.root +
 *  run_id), an `artifact` claim now only counts if it resolves to a REGULAR, NON-EMPTY file inside that
 *  run's own tree. Without a run directory there is nothing to verify against, so the old
 *  string-matching behaviour stays — and `verified:false` in the result says so out loud rather than
 *  implying a check that did not happen. */
function artifactsOnDisk(artifacts, opts) {
  const fs2 = require('fs');
  const path2 = require('path');
  const runDir = opts && opts.runDir ? path2.resolve(opts.runDir)
    : (opts && opts.root && opts.runId ? path2.resolve(opts.root, '.claude', 'forge-runs', String(opts.runId)) : null);
  if (!runDir) return { verified: false, artifacts };
  const kept = [];
  for (const a of artifacts) {
    const candidates = [path2.resolve(runDir, a), path2.resolve(runDir, 'artifacts', a), path2.isAbsolute(a) ? path2.resolve(a) : null].filter(Boolean);
    for (const c of candidates) {
      // containment: an artifact claim may never point outside the run it belongs to
      const rel = path2.relative(runDir, c);
      if (rel.startsWith('..') || path2.isAbsolute(rel)) continue;
      let st = null;
      try { st = fs2.lstatSync(c); } catch { continue; }
      if (!st.isFile() || st.size === 0) continue; // a symlink/dir/empty file is not evidence
      kept.push(a);
      break;
    }
  }
  return { verified: true, artifacts: kept };
}

function isSatisfied(item, artifacts, events) {
  // Belt AND braces: loadConfig already refuses a specific item that lists a generic event, but the
  // decision itself must be right even if a config reaches this function another way (a hand-built item
  // in a caller, a future loader). A specific requirement never counts a domain-agnostic event.
  const acceptedEvents = item.specific ? (item.any_of_events || []).filter((e) => !isGenericEvent(e)) : item.any_of_events;
  if (item.kind === 'artifact') return matchesArtifact(artifacts, item.any_of_substrings);
  if (item.kind === 'event') return matchesEvent(events, acceptedEvents);
  return matchesArtifact(artifacts, item.any_of_substrings) || matchesEvent(events, acceptedEvents);
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

  const claimedArtifacts = toArray(params.artifacts);
  const events = toArray(params.events);

  // Verify artifact CLAIMS against the filesystem when a run directory is known (see artifactsOnDisk).
  const disk = artifactsOnDisk(claimedArtifacts, { runDir: opts.runDir, root: opts.root, runId: opts.runId || params.run_id });
  const artifacts = disk.artifacts;
  const rejected = disk.verified ? claimedArtifacts.filter((a) => !artifacts.includes(a)) : [];

  const missing = [];
  const satisfied = [];
  for (const item of domainEntry.evidence) {
    if (isSatisfied(item, artifacts, events)) satisfied.push(item.id);
    else missing.push(item.id);
  }

  return {
    ok: missing.length === 0, domain: params.domain, missing, satisfied,
    // Honest provenance: `artifacts_verified:false` means NO filesystem check was possible (no run dir
    // given), not that the artifacts were checked and found fine.
    artifacts_verified: disk.verified,
    ...(rejected.length ? { artifacts_rejected: rejected, artifacts_rejected_reason: 'claimed artifact path is not a real, non-empty regular file inside this run' } : {}),
  };
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
