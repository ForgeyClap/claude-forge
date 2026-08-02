#!/usr/bin/env node
'use strict';
/**
 * forge-reinforce.cjs — outcome-gated lesson utility scorer (WAVE E / PIECE E2, 2026-07-18). Zero-
 * dependency (fs/path only, plus the sibling forge-consolidate.cjs for the shared store-record helpers —
 * single source of truth for validateCanonical/clampUtility, never re-implemented here) and the sibling
 * forge-verify.cjs (lazily required) as the ONE real outcome oracle this tool trusts.
 *
 * OUTCOME-GATED (mandatory): a lesson's utility only ever moves because of a REAL run outcome, read
 * straight from that run's own events.jsonl via forge-verify.cjs::verifyRun() — the exact same
 * agent-claims-vs-real-events mismatch signal forge-verify's own CLI gates its exit code on
 * (mismatches===0 -> verified-good). This tool never re-derives "good/bad" from a different, looser
 * heuristic, and never asks an LLM to judge a run. A run whose outcome cannot be determined (missing/
 * unreadable events.jsonl, forge-verify.cjs unavailable) reinforces NOTHING — outcome:null is never
 * silently treated as good or bad.
 *
 * ANTI-GAMING (mandatory, three independent guards):
 *   1. NO SELF-REINFORCEMENT — a lesson can never be reinforced by the very run that produced it. Every
 *      canonical lesson's `evidence` carries the run_id it was distilled from (forge-distill.cjs's
 *      contract); a run whose id matches that run_id is skipped for that lesson, full stop.
 *   2. PRECEDENCE — a lesson can only be reinforced by a run that started AFTER the lesson's own `ts`. A
 *      lesson cannot retroactively take credit/blame for a run that happened before it existed (or
 *      concurrently, when start times are equal or unknown).
 *   3. BOUNDED, IDEMPOTENT — utility is clamped to forge-consolidate's [UTILITY_MIN, UTILITY_MAX] range
 *      (no unbounded runaway score from re-running this tool many times), and each (lesson, run) pair is
 *      recorded in the lesson's `reinforced_by` set the FIRST time it is scored — a later re-run over the
 *      same store + the same runs directory is a true no-op for those pairs (only genuinely NEW runs added
 *      to the runs directory since the last reinforce() call can move utility further).
 *
 * A lesson failing forge-consolidate.cjs::validateCanonical() (no real evidence.run_id, no valid ts, no
 * text) is UNREINFORCEABLE — reported, never scored, and never crashes the run.
 *
 * MODULE API:
 *   reinforce(opts) -> { store, runsDir, lessonsConsidered, runsConsidered, reinforcedGood, reinforcedBad,
 *     selfBlocked, notPreceding, alreadyDone, unreinforceable, undeterminable, perLesson:{id:{...}}, notes }
 *   opts.store (REQUIRED) — a lessons.jsonl-style file path (same shape forge-consolidate.cjs reads/writes).
 *   opts.runs (REQUIRED) — a directory whose immediate subdirectories are candidate runs, each expected to
 *     hold its own events.jsonl (and optionally run.json with a `started_at` ISO timestamp — falls back to
 *     the earliest event's own `timestamp` field when run.json/started_at is absent).
 *   opts.step (default 1) — the fixed utility delta applied per (lesson,run) pair, before clamping.
 *   opts.dryRun (default false), opts.now (ms epoch override — unused directly, kept for symmetry/tests).
 *
 * CLI:
 *   node forge-reinforce.cjs --store <file> --runs <dir> [--step N] [--dry-run] [--json]
 * Exit codes: 0 = ran (even an honestly-empty/no-op result) · 2 = usage error (missing --store/--runs) or
 * a genuine runtime error.
 */
const fs = require('fs');
const path = require('path');
const consolidateModule = require('./forge-consolidate.cjs');

const DEFAULT_STEP = 1;

let _verifyCache; // undefined = not yet attempted, null = load failed, object = loaded module
function loadVerify() {
  if (_verifyCache !== undefined) return _verifyCache;
  try { _verifyCache = require('./forge-verify.cjs'); } catch { _verifyCache = null; }
  return _verifyCache;
}

/** runOutcome(runDir) -> {ok:true|false|null, ...}. ok===true/false is the outcome-gate's ONLY real
 *  signal (forge-verify.cjs::verifyRun mismatches===0); ok===null means undeterminable — NEVER guessed. */
function runOutcome(runDir) {
  const verify = loadVerify();
  if (!verify) return { ok: null, reason: 'forge-verify.cjs unavailable' };
  let result;
  try { result = verify.verifyRun(runDir, {}); }
  catch (e) { return { ok: null, reason: 'could not verify: ' + e.message }; }
  return { ok: result.mismatches === 0, mismatches: result.mismatches, malformed: result.malformed };
}

/** readRunStartedAt(runDir) -> ms epoch | null. Prefers run.json's started_at; falls back to the
 *  earliest `timestamp` found across events.jsonl. null when neither source yields a valid instant —
 *  such a run can never satisfy the PRECEDENCE guard (treated as "cannot confirm this run started after
 *  the lesson", so it is skipped, never assumed to be fine). */
function readRunStartedAt(runDir) {
  try {
    const rj = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
    if (rj && rj.started_at) {
      const t = Date.parse(rj.started_at);
      if (Number.isFinite(t)) return t;
    }
  } catch { /* fall through to events.jsonl */ }
  let raw;
  try { raw = fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8'); } catch { return null; }
  let earliest = null;
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    let e;
    try { e = JSON.parse(s); } catch { continue; }
    const t = e && e.timestamp && Date.parse(e.timestamp);
    if (Number.isFinite(t) && (earliest === null || t < earliest)) earliest = t;
  }
  return earliest;
}

/** discoverRuns(runsDir) -> [{runId, runDir, startedAt}, ...]. Only immediate subdirectories that
 *  actually hold an events.jsonl count as a run — an empty/missing runsDir degrades to []. */
function discoverRuns(runsDir) {
  let entries;
  try { entries = fs.readdirSync(runsDir, { withFileTypes: true }); } catch { return []; }
  const runs = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const runDir = path.join(runsDir, e.name);
    if (!fs.existsSync(path.join(runDir, 'events.jsonl'))) continue;
    runs.push({ runId: e.name, runDir, startedAt: readRunStartedAt(runDir) });
  }
  return runs;
}

/** reinforce(opts) -> summary — see file header for the full contract. */
function reinforce(opts) {
  opts = opts || {};
  if (!opts.store) throw new Error('forge-reinforce: opts.store (a lessons.jsonl file path) is required');
  if (!opts.runs) throw new Error('forge-reinforce: opts.runs (a directory of run subfolders) is required');
  const step = Number.isFinite(opts.step) ? opts.step : DEFAULT_STEP;

  const records = consolidateModule.readStore(opts.store);
  const runs = discoverRuns(opts.runs);

  let reinforcedGood = 0, reinforcedBad = 0, selfBlocked = 0, notPreceding = 0, alreadyDone = 0, unreinforceable = 0, undeterminable = 0;
  const perLesson = {};

  for (const r of records) {
    const v = consolidateModule.validateCanonical(r);
    if (!v.ok) { unreinforceable++; continue; } // no real evidence to outcome-gate against — never scored
    if (!Array.isArray(r.reinforced_by)) r.reinforced_by = [];
    if (!Number.isFinite(r.utility)) r.utility = 0;
    const lessonRunId = v.runId;
    const lessonTs = Date.parse(r.ts);

    const lessonSummary = { good: 0, bad: 0, skipped_self: 0, skipped_not_preceding: 0, skipped_already: 0 };
    perLesson[r.id] = lessonSummary;

    for (const run of runs) {
      if (run.runId === lessonRunId) { selfBlocked++; lessonSummary.skipped_self++; continue; } // guard 1: no self-reinforcement
      if (run.startedAt === null || !(lessonTs < run.startedAt)) { notPreceding++; lessonSummary.skipped_not_preceding++; continue; } // guard 2: precedence
      if (r.reinforced_by.includes(run.runId)) { alreadyDone++; lessonSummary.skipped_already++; continue; } // guard 3: idempotent

      const outcome = runOutcome(run.runDir);
      if (outcome.ok === null) { undeterminable++; continue; } // never guessed good or bad

      r.reinforced_by.push(run.runId);
      r.uses = r.reinforced_by.length;
      r.last_reinforced = new Date(run.startedAt).toISOString();
      if (outcome.ok) {
        r.utility = consolidateModule.clampUtility(r.utility + step);
        reinforcedGood++; lessonSummary.good++;
      } else {
        r.utility = consolidateModule.clampUtility(r.utility - step);
        reinforcedBad++; lessonSummary.bad++;
      }
    }
  }

  if (!opts.dryRun) consolidateModule.writeStore(opts.store, records);

  return {
    store: opts.store, runsDir: opts.runs,
    lessonsConsidered: records.length, runsConsidered: runs.length,
    reinforcedGood, reinforcedBad, selfBlocked, notPreceding, alreadyDone, unreinforceable, undeterminable,
    perLesson,
    notes: [
      unreinforceable ? unreinforceable + ' lesson(s) unreinforceable (no real evidence.run_id/ts — never scored)' : 'every lesson had real evidence to gate on',
      selfBlocked ? selfBlocked + ' self-reinforcement attempt(s) blocked' : 'no self-reinforcement attempts seen',
      undeterminable ? undeterminable + ' run(s) had an undeterminable outcome — treated as neither good nor bad' : 'every candidate run had a determinable outcome',
    ],
  };
}

module.exports = { reinforce, runOutcome, readRunStartedAt, discoverRuns, DEFAULT_STEP };

// ---- CLI ----
function parseArgs(argv) {
  const opts = { store: null, runs: null, step: null, dryRun: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--store') opts.store = argv[++i];
    else if (a === '--runs') opts.runs = argv[++i];
    else if (a === '--step') opts.step = Number(argv[++i]);
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--json') opts.json = true;
  }
  return opts;
}
function printUsage() {
  console.error('Usage: node forge-reinforce.cjs --store <file> --runs <dir> [--step N] [--dry-run] [--json]');
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.store || !opts.runs) { printUsage(); process.exitCode = 2; }
  else {
    try {
      const result = reinforce(opts);
      if (opts.json) console.log(JSON.stringify(result));
      else {
        console.log('forge-reinforce ' + opts.store + ' against ' + opts.runs + (opts.dryRun ? ' (dry-run)' : ''));
        console.log('  lessons: ' + result.lessonsConsidered + '  runs: ' + result.runsConsidered);
        console.log('  reinforced good: ' + result.reinforcedGood + '  reinforced bad: ' + result.reinforcedBad);
        for (const n of result.notes) console.log('  ' + n);
      }
      process.exitCode = 0;
    } catch (e) {
      console.error('forge-reinforce: ' + e.message);
      process.exitCode = 2;
    }
  }
}
