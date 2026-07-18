#!/usr/bin/env node
'use strict';
/**
 * forge-heartbeat.cjs — stall/silence watchdog for a Forge run. Zero-dependency, Windows-safe. Reads
 * ONLY the real events already logged to <run>/events.jsonl (no polling of a live agent, no guessing) —
 * an agent is STALLED when it has started but has gone quiet for longer than a window and never logged
 * a completion/failure event.
 *
 * WHY: a long multi-agent run can have a Boss go silent mid-work (crashed, stuck in a loop, waiting on
 * something nobody is watching). Nothing previously flagged that automatically. This tool is a cheap,
 * read-only check the Lead (or forge-doctor later) can run periodically or whenever a run "feels quiet".
 *
 * SEMANTICS:
 *   - An agent is TRACKED once it has an agent_started or subagent_started event.
 *   - An agent is FINISHED if it has an agent_completed / subagent_completed / agent_failed /
 *     subagent_failed event anywhere in its history — finished agents are never flagged, no matter how
 *     old their last event is (silence after completion is expected, not a stall).
 *   - An UNFINISHED agent is STALLED when (opts.now - lastEventTimestamp) > windowMs (default 10 min).
 *   - Within STALLED, an agent is additionally flagged NEVER_PROGRESSED when its start event is also its
 *     only/last event (zero events logged since starting) — a stronger signal than "went quiet after
 *     some progress".
 *   - Events without a resolvable `timestamp` are ignored for lastTs purposes (never crash, never assume
 *     "now" for a missing timestamp — that would hide a real stall or invent a false one).
 *
 * CLI:
 *   node forge-heartbeat.cjs check <run_id> [--root <projectRoot>] [--window <minutes>] [--json]
 *     Prints one line per stalled agent, or a single "no stalled agents" line. Exit code: 0 when
 *     nothing is stalled, 1 when at least one agent is stalled (safe to gate a hook/CI step on it).
 *
 * Module API: { checkRun, readEventsJsonl, DEFAULT_WINDOW_MS }
 *
 * TEST ISOLATION: checkRun(runDir, opts) takes a plain directory path and an injectable opts.now — no
 * project coupling, no real clock dependency, mirrors forge-verify.cjs's verifyRun(runDir, opts) shape.
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

const STARTED_TYPES = new Set(['agent_started', 'subagent_started']);
const FINISHED_TYPES = new Set(['agent_completed', 'subagent_completed', 'agent_failed', 'subagent_failed']);

// ---- reading events.jsonl (line-delimited JSON, BOM-tolerant, malformed lines skipped) -----------
function readEventsJsonl(runDir) {
  const file = path.join(runDir, 'events.jsonl');
  if (!fs.existsSync(file)) {
    throw new Error('no events.jsonl found at ' + file + ' — run does not exist or has not logged anything yet');
  }
  let raw = fs.readFileSync(file, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // strip BOM
  const events = [];
  let malformed = 0;
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try { events.push(JSON.parse(s)); } catch { malformed++; }
  }
  return { events, malformed };
}

function parseTs(e) {
  if (!e || !e.timestamp) return null;
  const ms = Date.parse(e.timestamp);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * checkRun(runDir, opts) -> { agents, stalled, malformed, ok }
 *   opts.now       injectable "current time" in ms since epoch (default Date.now()) — for tests.
 *   opts.windowMs  silence threshold in ms (default DEFAULT_WINDOW_MS).
 *
 * agents: every agent that has a start event, with { agent, started, finished, lastTs, lastEventType,
 *   eventCount, stalled, neverProgressed, minutesSilent }.
 * stalled: the subset of `agents` where stalled === true (finished agents are never included here).
 */
function checkRun(runDir, opts) {
  opts = opts || {};
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const windowMs = typeof opts.windowMs === 'number' ? opts.windowMs : DEFAULT_WINDOW_MS;

  const { events, malformed } = readEventsJsonl(runDir);
  const byAgent = new Map();

  events.forEach((e) => {
    if (!e || typeof e !== 'object') return;
    const agent = e.agent;
    if (agent == null || agent === '') return; // skip events without an agent — no SYNTH fallback
    if (!STARTED_TYPES.has(e.event_type) && !byAgent.has(agent)) return; // only track agents that have started
    if (!byAgent.has(agent)) {
      byAgent.set(agent, { agent, started: false, finished: false, lastTs: null, lastEventType: null, eventCount: 0 });
    }
    const rec = byAgent.get(agent);
    if (STARTED_TYPES.has(e.event_type)) rec.started = true;
    if (FINISHED_TYPES.has(e.event_type)) rec.finished = true;
    rec.eventCount++;
    const ts = parseTs(e);
    if (ts !== null && (rec.lastTs === null || ts >= rec.lastTs)) {
      rec.lastTs = ts;
      rec.lastEventType = e.event_type;
    }
  });

  const agents = Array.from(byAgent.values()).map((rec) => {
    const silentMs = rec.lastTs === null ? null : (now - rec.lastTs);
    const stalled = rec.started && !rec.finished && silentMs !== null && silentMs > windowMs;
    const neverProgressed = stalled && rec.eventCount <= 1;
    return {
      agent: rec.agent,
      started: rec.started,
      finished: rec.finished,
      lastTs: rec.lastTs,
      lastEventType: rec.lastEventType,
      eventCount: rec.eventCount,
      minutesSilent: silentMs === null ? null : Math.floor(silentMs / 60000),
      stalled,
      neverProgressed,
    };
  });

  const stalled = agents.filter((a) => a.stalled);
  return { agents, stalled, malformed, ok: stalled.length === 0 };
}

module.exports = { checkRun, readEventsJsonl, DEFAULT_WINDOW_MS };

// ---- CLI -------------------------------------------------------------------------------------------
if (require.main === module) {
  function parseArgs(argv) {
    const out = { cmd: argv[0] || null, run_id: null, root: DEFAULT_ROOT, windowMinutes: null, json: false };
    const pos = [];
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--root') out.root = argv[++i];
      else if (a === '--window') out.windowMinutes = Number(argv[++i]);
      else if (a === '--json') out.json = true;
      else pos.push(a);
    }
    out.run_id = pos[0] || null;
    return out;
  }

  function fmtStalledLine(a) {
    const tag = a.neverProgressed ? 'NEVER PROGRESSED' : 'STALLED';
    return '  ⚠ ' + tag + ': ' + a.agent + ' — silent ' + a.minutesSilent + 'm (last: ' + (a.lastEventType || 'n/a') + ')';
  }

  function cliMain(opts) {
    const root = path.resolve(opts.root);
    const runDir = path.join(root, '.claude', 'forge-runs', opts.run_id);
    const windowMs = opts.windowMinutes != null && !Number.isNaN(opts.windowMinutes) ? opts.windowMinutes * 60 * 1000 : DEFAULT_WINDOW_MS;
    const result = checkRun(runDir, { windowMs });

    const activeChecked = result.agents.filter((a) => a.started && !a.finished).length;
    const lines = [];
    if (result.stalled.length === 0) {
      lines.push('✓ no stalled agents (' + activeChecked + ' active checked)');
    } else {
      lines.push('Forge Heartbeat — ' + opts.run_id);
      for (const a of result.stalled) lines.push(fmtStalledLine(a));
      lines.push('⚠ ' + result.stalled.length + ' stalled agent(s) — silence is a flag to CHECK the agent, not to auto-kill it.');
    }
    console.log(lines.join('\n'));

    if (opts.json) {
      console.log(JSON.stringify({ run_id: opts.run_id, root, window_ms: windowMs, agents: result.agents, stalled: result.stalled, malformed: result.malformed }, null, 2));
    }

    process.exitCode = result.ok ? 0 : 1;
  }

  const opts = parseArgs(process.argv.slice(2));
  if (opts.cmd !== 'check') {
    console.error('Usage: node forge-heartbeat.cjs check <run_id> [--root <projectRoot>] [--window <minutes>] [--json]');
    process.exitCode = 1;
  } else if (!opts.run_id || !/^[A-Za-z0-9_-]+$/.test(opts.run_id)) {
    console.error('Usage: node forge-heartbeat.cjs check <run_id> [--root <projectRoot>] [--window <minutes>] [--json]');
    console.error('invalid or missing run_id (allowed: A-Z a-z 0-9 _ -)');
    process.exitCode = 1;
  } else {
    try { cliMain(opts); } catch (e) { console.error('forge-heartbeat: ' + e.message); process.exitCode = 1; }
  }
}
