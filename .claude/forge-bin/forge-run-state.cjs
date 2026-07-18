#!/usr/bin/env node
'use strict';
/**
 * forge-run-state.cjs — DURABLE RESUME projector (2026-07-11, NEXT tier). Folds a run's events.jsonl into a
 * resume plan so a crashed/interrupted L3/L4 run restarts only the UNFINISHED work packages, not from zero.
 * Deterministic projection (no side effects). The Lead reads the plan and re-dispatches only the listed Bosses.
 *
 * IDEMPOTENCY (honest limit): "exactly-once" is really effectively-once. Before RE-running any side-effecting
 * action on resume (email/SMS/deploy/migration/PR/payment), the owning Boss MUST check an intent/receipt key
 * so replay never re-sends. This projector marks agents whose last event looks side-effecting so resume is
 * careful, but true replay fidelity depends on the run logging those receipts (see forge-core add-on).
 *
 * Usage:  node forge-run-state.cjs <run_id> [--json]
 * Exit: 0 = nothing to resume (complete) · 3 = resumable work remains · 2 = no such run.
 */
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = process.env.FORGE_PROJECT_ROOT ? path.resolve(process.env.FORGE_PROJECT_ROOT) : path.resolve(__dirname, '..', '..');
const RUNS_DIR = path.join(PROJECT_ROOT, '.claude', 'forge-runs');
const SIDE_EFFECT_HINT = /(email|mail|deploy|migrat|payment|charge|refund|sms|webhook|publish|push|pr[_-]?open|outreach)/i;

function safeRead(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function readEvents(id) { const raw = safeRead(path.join(RUNS_DIR, id, 'events.jsonl')); if (!raw) return null; const out = []; for (const l of raw.split(/\r?\n/)) { const t = l.trim(); if (!t) continue; try { const v = JSON.parse(t); if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v); } catch {} } return out; }

function projectRunState(runId, events) {
  const agents = {};
  const touch = (k) => (agents[k] || (agents[k] = { started: false, completed: false, failed: false, events: 0, last: '', lastType: '', sideEffecting: false }));
  const gates = {};
  for (const e of events) {
    const k = e.agent || 'system'; const t = e.event_type || '';
    const a = touch(k); a.events++; if (e.timestamp) a.last = e.timestamp; a.lastType = t;
    if (t === 'agent_started' || t === 'subagent_started') a.started = true;
    else if (t === 'agent_completed' || t === 'subagent_completed') { a.completed = true; a.failed = false; }
    else if (t === 'agent_failed' || t === 'subagent_failed') a.failed = true;
    if (SIDE_EFFECT_HINT.test(t) || SIDE_EFFECT_HINT.test(String(e.task || '')) || SIDE_EFFECT_HINT.test(String(e.note || ''))) a.sideEffecting = true;
    if (t === 'quality_gate_passed') gates[e.gate || e.note || 'gate'] = 'passed';
    else if (t === 'quality_gate_blocked') gates[e.gate || e.note || 'gate'] = 'blocked';
  }
  const unfinished = Object.keys(agents).filter((k) => agents[k].started && !agents[k].completed && !agents[k].failed);
  const failed = Object.keys(agents).filter((k) => agents[k].failed && !agents[k].completed);
  const blockedGates = Object.keys(gates).filter((g) => gates[g] === 'blocked');
  const resume = Array.from(new Set([...unfinished, ...failed]));
  const sideEffectWarnings = resume.filter((k) => agents[k].sideEffecting);
  return {
    run_id: runId, agents, gates,
    unfinished, failed, blocked_gates: blockedGates,
    resume, side_effect_warnings: sideEffectWarnings,
    resumable: resume.length > 0 || blockedGates.length > 0,
    complete: resume.length === 0 && blockedGates.length === 0,
  };
}

module.exports = { projectRunState };

if (require.main === module) {
  const args = process.argv.slice(2);
  const runId = args.find((a) => !a.startsWith('--'));
  const json = args.includes('--json');
  if (!runId || !/^[A-Za-z0-9_-]+$/.test(runId)) { console.error('usage: node forge-run-state.cjs <run_id> [--json]'); process.exit(2); }
  const events = readEvents(runId);
  if (events == null) { console.error('no such run / no events: ' + runId); process.exit(2); }
  const st = projectRunState(runId, events);
  if (json) { console.log(JSON.stringify(st, null, 2)); }
  else {
    console.log('forge run-state · ' + runId + (st.complete ? ' · COMPLETE (nothing to resume)' : ' · RESUMABLE'));
    if (st.resume.length) console.log('  re-dispatch: ' + st.resume.join(', '));
    if (st.blocked_gates.length) console.log('  blocked gates: ' + st.blocked_gates.join(', '));
    if (st.side_effect_warnings.length) console.log('  ⚠ idempotency: check receipt keys before re-running (' + st.side_effect_warnings.join(', ') + ')');
  }
  process.exit(st.resumable ? 3 : 0);
}
