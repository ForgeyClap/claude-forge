#!/usr/bin/env node
'use strict';
/**
 * forge-consolidate.cjs — honesty-safe lesson-store consolidator (WAVE E / PIECE E2, 2026-07-18).
 * Zero-dependency (fs/path only). Operates directly on ONE lessons.jsonl-style store file (the same
 * one-JSON-per-line shape forge-memory.cjs::addLesson() writes: {id,type,tags,text,evidence,ts}, plus
 * the utility-tracking fields forge-reinforce.cjs maintains: {utility,uses,reinforced_by,last_reinforced,
 * decayed_at,merged_ids}). This file NEVER writes those base fields' semantics differently than
 * forge-memory.cjs does and NEVER re-implements redaction — it only merges/decays/prunes on top of an
 * already-written store.
 *
 * HONESTY CORE (untouchable, see CLAUDE.md invariants): a lesson is a real, evidence-linked memory ONLY
 * when its `text` is non-empty AND its `evidence` field parses to a JSON object carrying a real, non-empty
 * `run_id` AND it carries a valid `ts`. validateCanonical() enforces exactly this — nothing more, nothing
 * less. consolidate() NEVER inspects, rewrites, blends, or "improves" a lesson's `text` at any step; a
 * record either keeps its original text verbatim or is removed entirely (rejected or pruned). There is no
 * code path in this file that can synthesize new lesson text.
 *
 * THREE OPERATIONS (run in this fixed order, one store, one pass):
 *   1. REJECT non-canonical records — any record failing validateCanonical() (missing text, missing/
 *      unparsable evidence.run_id, missing/invalid ts) is a synthesised or quote-less entry and is
 *      dropped from the active store outright, reported under `rejected` with a reason. This is the
 *      no-synthesis guard's enforcement point.
 *   2. MERGE exact duplicates — two canonical records with the same `type` and the same normalized `text`
 *      (case/whitespace-insensitive, byte-identical otherwise) are the same lesson recorded twice. The
 *      OLDEST record's `text` survives VERBATIM as the merged record's text; tags and reinforced_by sets
 *      are unioned (never a source of double-counted `uses`), and the absorbed ids are recorded under
 *      `merged_ids` for audit. A near-duplicate that is NOT an exact normalized-text match is left as two
 *      separate lessons — this module never guesses at "close enough".
 *   3. DECAY stale utility, then PRUNE net-negative-with-real-evidence records — a record whose utility
 *      has gone untouched (no reinforcement) for longer than `decayAfterDays` has its utility numeric
 *      field (never text) shrunk toward zero by `decayFactor`; a record is only ever PRUNED (removed from
 *      the store) once it has genuinely accumulated `minUsesForPrune` real reinforcements AND its utility
 *      is still at/below `pruneThreshold` — a fresh, never-reinforced lesson (uses:0) is never pruned just
 *      for being new or unused.
 *
 * MODULE API:
 *   consolidate(opts) -> { store, before, after, rejected:[{id,reason}], mergedCount, decayedCount,
 *     prunedCount, prunedIds, keptIds, notes:[...] }
 *   opts.store (REQUIRED) — path to the lessons.jsonl-style file (created if missing = empty result).
 *   opts.decayAfterDays (default 30), opts.decayFactor (default 0.85), opts.pruneThreshold (default -2),
 *   opts.minUsesForPrune (default 2), opts.dryRun (default false — when true, nothing is written, the
 *   report reflects what WOULD happen), opts.now (ms epoch override — hermetic-test seam).
 *
 * CLI:
 *   node forge-consolidate.cjs --store <file> [--decay-after-days N] [--decay-factor F]
 *     [--prune-threshold N] [--min-uses-for-prune N] [--dry-run] [--json]
 * Exit codes: 0 = ran (even an honestly-empty/no-op result) · 2 = usage error (missing --store) or a
 * genuinely unreadable store file (not simple ENOENT, which degrades to an empty store).
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_DECAY_AFTER_DAYS = 30;
const DEFAULT_DECAY_FACTOR = 0.85;
const DEFAULT_PRUNE_THRESHOLD = -2;
const DEFAULT_MIN_USES_FOR_PRUNE = 2;
const UTILITY_MIN = -5;
const UTILITY_MAX = 5;

function clampUtility(n) { return Math.max(UTILITY_MIN, Math.min(UTILITY_MAX, Number.isFinite(n) ? n : 0)); }
function normalizeText(s) { return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim(); }

/** parseEvidenceRunId(evidence) -> string|null. `evidence` is expected to be the JSON string
 *  forge-distill.cjs writes: {run_id, ts, event_type}. Anything that doesn't parse to an object with a
 *  non-empty run_id is honestly reported as null — never guessed. */
function parseEvidenceRunId(evidence) {
  if (typeof evidence !== 'string' || !evidence.trim()) return null;
  let obj;
  try { obj = JSON.parse(evidence); } catch { return null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (typeof obj.run_id !== 'string' || !obj.run_id.trim()) return null;
  return obj.run_id;
}

// ---- store IO (one-JSON-per-line, malformed lines silently dropped — mirrors forge-orchestrate.cjs's
// readEventsJsonl tolerance so a partially-corrupt store never crashes this tool) ----
function readStore(storePath) {
  let raw;
  try { raw = fs.readFileSync(storePath, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return [];
    throw new Error('forge-consolidate: could not read store ' + storePath + ': ' + e.message);
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try { const obj = JSON.parse(s); if (obj && typeof obj === 'object' && !Array.isArray(obj)) out.push(obj); } catch { /* malformed line — dropped */ }
  }
  return out;
}
function writeStore(storePath, records) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const body = records.map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(storePath, body.length ? body + '\n' : '', 'utf8');
}

/** validateCanonical(record) -> {ok:true, runId} | {ok:false, reason}. The ONLY gate deciding whether a
 *  record counts as a real, evidence-linked lesson. Never inspects `text` beyond "is it a non-empty
 *  string" — it never judges the CONTENT of the quote, only that a quote genuinely exists and is tied to
 *  a real run_id + timestamp. */
function validateCanonical(record) {
  if (!record || typeof record !== 'object') return { ok: false, reason: 'not an object' };
  if (typeof record.text !== 'string' || !record.text.trim()) return { ok: false, reason: 'empty/missing text — no canonical quote' };
  if (typeof record.ts !== 'string' || !record.ts.trim() || Number.isNaN(Date.parse(record.ts))) {
    return { ok: false, reason: 'missing/invalid timestamp — cannot tie this text to a real logged moment' };
  }
  const runId = parseEvidenceRunId(record.evidence);
  if (!runId) return { ok: false, reason: 'evidence does not carry a real run_id — synthesised/quote-less, not real logged evidence' };
  return { ok: true, reason: null, runId };
}

function mergeKey(record) { return String(record.type || 'semantic') + '::' + normalizeText(record.text); }

/** consolidate(opts) -> summary — see file header for the full contract. */
function consolidate(opts) {
  opts = opts || {};
  if (!opts.store) throw new Error('forge-consolidate: opts.store (a lessons.jsonl file path) is required');
  const decayAfterDays = Number.isFinite(opts.decayAfterDays) ? opts.decayAfterDays : DEFAULT_DECAY_AFTER_DAYS;
  const decayFactor = Number.isFinite(opts.decayFactor) ? opts.decayFactor : DEFAULT_DECAY_FACTOR;
  const pruneThreshold = Number.isFinite(opts.pruneThreshold) ? opts.pruneThreshold : DEFAULT_PRUNE_THRESHOLD;
  const minUsesForPrune = Number.isFinite(opts.minUsesForPrune) ? opts.minUsesForPrune : DEFAULT_MIN_USES_FOR_PRUNE;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();

  const raw = readStore(opts.store);
  const before = raw.length;

  // Step 1: reject non-canonical (synthesised/quote-less) records — never kept in the active store.
  const rejected = [];
  const canonical = [];
  for (const r of raw) {
    const v = validateCanonical(r);
    if (!v.ok) { rejected.push({ id: r && r.id, reason: v.reason }); continue; }
    // Normalize housekeeping fields (numeric/array only — `text` is NEVER touched here or anywhere below).
    if (!Number.isFinite(r.utility)) r.utility = 0; else r.utility = clampUtility(r.utility);
    if (!Number.isFinite(r.uses)) r.uses = 0;
    if (!Array.isArray(r.reinforced_by)) r.reinforced_by = [];
    if (!Array.isArray(r.tags)) r.tags = [];
    canonical.push(r);
  }

  // Step 2: merge exact-normalized-text duplicates (same type+text) — oldest record's text survives
  // VERBATIM. NEVER blends/rewrites text; only tags/reinforced_by/uses/merged_ids are touched.
  const groups = new Map();
  for (const r of canonical) {
    const key = mergeKey(r);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  let mergedCount = 0;
  const survivors = [];
  for (const group of groups.values()) {
    if (group.length === 1) { survivors.push(group[0]); continue; }
    group.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)); // oldest first
    const winner = Object.assign({}, group[0]); // text is group[0].text — untouched, never blended
    const tagSet = new Set(winner.tags);
    const reinforcedBy = new Set(winner.reinforced_by);
    const mergedIds = new Set(winner.merged_ids || []);
    for (let i = 1; i < group.length; i++) {
      const loser = group[i];
      mergedIds.add(loser.id);
      for (const tag of loser.tags || []) tagSet.add(tag);
      for (const rid of loser.reinforced_by || []) reinforcedBy.add(rid);
      winner.utility = clampUtility(Math.max(winner.utility, Number.isFinite(loser.utility) ? loser.utility : 0));
    }
    winner.tags = Array.from(tagSet).slice(0, 12);
    winner.reinforced_by = Array.from(reinforcedBy);
    winner.uses = winner.reinforced_by.length; // never double-counted — derived from the unioned set
    winner.merged_ids = Array.from(mergedIds);
    survivors.push(winner);
    mergedCount += group.length - 1;
  }

  // Step 3a: decay stale utility (numeric only — text untouched).
  let decayedCount = 0;
  for (const r of survivors) {
    const anchor = r.last_reinforced || r.ts;
    const ageDays = (now - Date.parse(anchor)) / 86400000;
    if (Number.isFinite(ageDays) && ageDays > decayAfterDays && r.utility) {
      const decayed = clampUtility(r.utility * decayFactor);
      if (decayed !== r.utility) { r.utility = decayed; r.decayed_at = new Date(now).toISOString(); decayedCount++; }
    }
  }

  // Step 3b: prune — only a record with REAL negative evidence (uses >= minUsesForPrune) at/below
  // pruneThreshold is removed. A fresh/untested lesson is never pruned just for being new.
  const kept = [];
  const pruned = [];
  for (const r of survivors) {
    if (r.uses >= minUsesForPrune && r.utility <= pruneThreshold) { pruned.push({ id: r.id, utility: r.utility, uses: r.uses }); continue; }
    kept.push(r);
  }

  if (!opts.dryRun) writeStore(opts.store, kept);

  return {
    store: opts.store, before, after: kept.length,
    rejected, mergedCount, decayedCount, prunedCount: pruned.length,
    prunedIds: pruned.map((p) => p.id), keptIds: kept.map((r) => r.id),
    notes: [
      rejected.length ? rejected.length + ' non-canonical (synthesised/quote-less) record(s) rejected' : 'no non-canonical records found',
      mergedCount ? mergedCount + ' duplicate record(s) merged into their oldest survivor (text never rewritten)' : 'no duplicates found',
      decayedCount ? decayedCount + ' stale record(s) decayed' : 'no stale records to decay',
      pruned.length ? pruned.length + ' record(s) pruned (net-negative utility backed by real reinforcement evidence)' : 'no records pruned',
    ],
  };
}

module.exports = {
  consolidate, validateCanonical, parseEvidenceRunId, normalizeText, mergeKey, clampUtility,
  readStore, writeStore,
  DEFAULT_DECAY_AFTER_DAYS, DEFAULT_DECAY_FACTOR, DEFAULT_PRUNE_THRESHOLD, DEFAULT_MIN_USES_FOR_PRUNE,
  UTILITY_MIN, UTILITY_MAX,
};

// ---- CLI ----
function parseArgs(argv) {
  const opts = { store: null, decayAfterDays: null, decayFactor: null, pruneThreshold: null, minUsesForPrune: null, dryRun: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--store') opts.store = argv[++i];
    else if (a === '--decay-after-days') opts.decayAfterDays = Number(argv[++i]);
    else if (a === '--decay-factor') opts.decayFactor = Number(argv[++i]);
    else if (a === '--prune-threshold') opts.pruneThreshold = Number(argv[++i]);
    else if (a === '--min-uses-for-prune') opts.minUsesForPrune = Number(argv[++i]);
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--json') opts.json = true;
  }
  return opts;
}
function printUsage() {
  console.error('Usage: node forge-consolidate.cjs --store <file> [--decay-after-days N] [--decay-factor F]');
  console.error('       [--prune-threshold N] [--min-uses-for-prune N] [--dry-run] [--json]');
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.store) { printUsage(); process.exitCode = 2; }
  else {
    try {
      const result = consolidate(opts);
      if (opts.json) console.log(JSON.stringify(result));
      else {
        console.log('forge-consolidate ' + opts.store + (opts.dryRun ? ' (dry-run)' : ''));
        console.log('  before: ' + result.before + '  after: ' + result.after);
        for (const n of result.notes) console.log('  ' + n);
        for (const r of result.rejected) console.log('  REJECTED ' + (r.id || '(no id)') + ' — ' + r.reason);
      }
      process.exitCode = 0;
    } catch (e) {
      console.error('forge-consolidate: ' + e.message);
      process.exitCode = 2;
    }
  }
}
