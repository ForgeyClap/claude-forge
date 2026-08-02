#!/usr/bin/env node
'use strict';
/**
 * forge-runwatch.cjs — COMPLETION / STALL predicate for a Forge run (2026-07-24). Zero-dependency
 * (fs/path only), Windows-safe, side-effect-free (reads only, never writes/logs). The mechanical answer to
 * the owner's global-CLAUDE.md Orchestration-Safety HARD MUST: "Completion is proven ONLY by a real
 * task-completion notification or a non-empty result line in the run's journal — never by a 0-byte/placeholder
 * output file, a guess, or 'it's probably done.'"
 *
 * WHY (vs the already-shipped forge-run-state.cjs): forge-run-state is a RESUME projector (what to
 * re-dispatch after a crash). forge-runwatch is a live GATING predicate + STALL detector: it answers
 * "is this run genuinely DONE right now, and if not, is an agent STALLED?" and — crucially — returns the
 * ACTUAL terminal event line as evidence, so the Lead can drive a real Monitor until-loop on proof instead
 * of re-reading a placeholder file. No hook, no autonomy: the Lead stays active in-session and calls it.
 *
 * STATUS MODEL:
 *   done     — every agent that STARTED has a real terminal event (completed/failed/aborted).
 *   stalled  — at least one started agent has NO terminal event AND has been silent >= stallMs.
 *   running  — started agents remain open but none has crossed the stall window yet.
 *   empty    — no agent-start events at all (nothing dispatched / wrong run id).
 * `complete` is true ONLY for `done`, and `evidence` carries the literal terminal event lines that justify it.
 *
 * MODEL (pure core is testable without files; every fn takes opts.now / opts.stallMs / opts.eventsPath):
 *   projectRunWatch(events[], opts) -> { overall, complete, counts, evidence[], stalledAgents[], runningAgents[], lastEventAt, stallMs }
 *   watch(runId, opts)              -> same, after reading <runsDir>/<runId>/events.jsonl (opts.eventsPath / opts.runsDir override)
 *   readEvents(runId, opts)         -> parsed events[] | null (null = no such run / unreadable)
 *
 * CLI (exit: 0 = done · 3 = not-done yet (running OR stalled) · 2 = no such run / usage):
 *   node forge-runwatch.cjs <run_id> [--stall-min N] [--json]
 *   Prints a one-line verdict; --json prints the full status. A `stalled` verdict is the Lead's cue to
 *   Monitor-confirm and (only then, explicitly) TaskStop + record an ABORTED ledger status — never automatic.
 */
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = process.env.FORGE_PROJECT_ROOT ? path.resolve(process.env.FORGE_PROJECT_ROOT) : path.resolve(__dirname, '..', '..');
const RUNS_DIR = path.join(PROJECT_ROOT, '.claude', 'forge-runs');
const DEFAULT_STALL_MS = 15 * 60 * 1000; // 15 min silent + no terminal event = stalled

const RE_START = /^(agent|subagent)_started$/;
const RE_DONE = /^(agent|subagent)_completed$/;
const RE_FAIL = /^(agent|subagent)_failed$/;
const RE_ABORT = /^(agent|subagent)_aborted$/;

function parseTs(e) { const t = Date.parse(e && (e.timestamp || e.ts || '')); return Number.isFinite(t) ? t : null; }

function projectRunWatch(events, opts = {}) {
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const stallMs = (opts.stallMs && opts.stallMs > 0) ? opts.stallMs : DEFAULT_STALL_MS;
  const agents = {};
  const touch = (k) => (agents[k] || (agents[k] = { agent: k, started: false, terminal: null, terminalType: null, terminalEvidence: null, lastType: '', lastTs: null, events: 0 }));
  let lastEventAt = null;
  for (const e of (Array.isArray(events) ? events : [])) {
    if (!e || typeof e !== 'object') continue;
    const k = e.agent || e.subagent || 'system';
    const type = e.event_type || e.type || '';
    const ts = parseTs(e);
    const a = touch(k); a.events++; a.lastType = type;
    if (ts != null) { a.lastTs = ts; if (lastEventAt == null || ts > lastEventAt) lastEventAt = ts; }
    if (RE_START.test(type)) a.started = true;
    else if (RE_DONE.test(type)) { a.terminal = 'completed'; a.terminalType = type; a.terminalEvidence = { agent: k, event_type: type, timestamp: e.timestamp || null, note: e.note || '' }; }
    else if (RE_FAIL.test(type)) { a.terminal = 'failed'; a.terminalType = type; a.terminalEvidence = { agent: k, event_type: type, timestamp: e.timestamp || null, note: e.note || '' }; }
    else if (RE_ABORT.test(type)) { a.terminal = 'aborted'; a.terminalType = type; a.terminalEvidence = { agent: k, event_type: type, timestamp: e.timestamp || null, note: e.note || '' }; }
  }
  const started = Object.values(agents).filter((a) => a.started);
  const open = started.filter((a) => !a.terminal);
  const stalled = open.filter((a) => a.lastTs != null && (now - a.lastTs) >= stallMs);
  const running = open.filter((a) => !(a.lastTs != null && (now - a.lastTs) >= stallMs));
  const done = started.filter((a) => a.terminal === 'completed');
  const failed = started.filter((a) => a.terminal === 'failed' || a.terminal === 'aborted');
  let overall;
  if (started.length === 0) overall = 'empty';
  else if (open.length === 0) overall = 'done';
  else if (stalled.length > 0) overall = 'stalled';
  else overall = 'running';
  return {
    overall, complete: overall === 'done', stallMs,
    counts: { started: started.length, done: done.length, failed: failed.length, running: running.length, stalled: stalled.length },
    evidence: started.filter((a) => a.terminalEvidence).map((a) => a.terminalEvidence),
    stalledAgents: stalled.map((a) => ({ agent: a.agent, silent_ms: a.lastTs != null ? (now - a.lastTs) : null, last_type: a.lastType })),
    runningAgents: running.map((a) => a.agent),
    lastEventAt,
  };
}

function readEvents(runId, opts = {}) {
  const p = opts.eventsPath || path.join(opts.runsDir || RUNS_DIR, runId, 'events.jsonl');
  let raw; try { raw = fs.readFileSync(p, 'utf8'); } catch { return null; }
  const out = [];
  for (const line of raw.split(/\r?\n/)) { const t = line.trim(); if (!t) continue; try { const v = JSON.parse(t); if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v); } catch {} }
  return out;
}

function watch(runId, opts = {}) {
  const events = readEvents(runId, opts);
  if (events == null) return null;
  return projectRunWatch(events, opts);
}

module.exports = { projectRunWatch, watch, readEvents, DEFAULT_STALL_MS };

if (require.main === module) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const runId = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--stall-min');
  const smIdx = args.indexOf('--stall-min');
  const stallMs = smIdx >= 0 ? (parseFloat(args[smIdx + 1]) * 60 * 1000) : undefined;
  if (!runId || !/^[A-Za-z0-9_.-]+$/.test(runId)) { console.error('usage: node forge-runwatch.cjs <run_id> [--stall-min N] [--json]'); process.exit(2); }
  const st = watch(runId, { stallMs });
  if (st == null) { console.error('no such run / no events: ' + runId); process.exit(2); }
  if (json) { console.log(JSON.stringify(st, null, 2)); }
  else {
    const c = st.counts;
    console.log('forge runwatch · ' + runId + ' · ' + st.overall.toUpperCase() +
      '  (started=' + c.started + ' done=' + c.done + ' failed=' + c.failed + ' running=' + c.running + ' stalled=' + c.stalled + ')');
    if (st.overall === 'stalled') st.stalledAgents.forEach((s) => console.log('  ⚠ STALLED ' + s.agent + ' · silent ' + Math.round((s.silent_ms || 0) / 1000) + 's · last=' + s.last_type + ' → Monitor-confirm then explicit TaskStop + ABORTED ledger'));
    if (st.complete) console.log('  ✓ completion proven by ' + st.evidence.length + ' terminal event line(s) — no guessing');
  }
  process.exit(st.complete ? 0 : 3);
}
