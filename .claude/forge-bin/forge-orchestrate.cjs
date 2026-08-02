#!/usr/bin/env node
'use strict';
/**
 * forge-orchestrate.cjs — run-driver checklist auditor (WAVE C / C5, 2026-07-18). Encodes the canonical,
 * ORDERED per-run checklist (config/orchestration/run-checklist.json — the single source of truth this
 * file reads, never re-derives) and, given a run's REAL logged events, projects which checklist steps
 * actually ran vs were skipped — PURELY from event content, never inferred from side-effects (a file that
 * looks right, an agent that claims done). This is the forcing function against the "a check was silently
 * skipped / doctor said 10/10 but a step was actually missed" complaint: a step only counts as having run
 * when a matching, non-disproven event is really sitting in events.jsonl. Zero-dependency (fs/path only).
 *
 * MODEL:
 *   plan(opts) -> [step, ...]              — the ordered checklist steps, straight from run-checklist.json.
 *   audit({events} | {eventsPath}, opts) -> { ran:[...], skipped:[...], out_of_order:[...] }
 *     input.events      — an already-parsed array of event objects (preferred for library callers/tests).
 *     input.eventsPath  — OR a path to a run's events.jsonl (line-delimited JSON, BOM-tolerant, malformed
 *                          lines silently skipped — same tolerance forge-verify.cjs's readEventsJsonl uses).
 *     opts.checklistPath / opts.eventsPath — test-hermeticity override seams (same convention as every
 *     sibling Wave-B/C tool: forge-standing.cjs's rulesPath, forge-autonomy.cjs's configPath).
 *
 *   A step "ran" when at least one event in the run matches its `produces_event` type(s) (any-of when an
 *   array), its optional `match: {field, includes}` case-insensitive-substring condition (if present), and
 *   is NOT itself disproven by log-event.cjs's own CONTENT ORACLE (_forge_verify.proof_verified === false)
 *   — the "required-evidence" half of this piece's mandate: a claimed pass with disproven evidence never
 *   counts as a completed step, so `verify` can't be satisfied by a check_passed event log-event.cjs itself
 *   already flagged as a lie. A step with no matching event lands in `skipped` with a plain-language reason.
 *
 *   out_of_order: walks `ran` in CANONICAL (checklist) order, tracking the highest event index seen so far.
 *   A step whose matched event index is LOWER than that running maximum genuinely occurred before an
 *   earlier-in-the-checklist step's own event — flagged with `should_follow` naming the step it jumped
 *   ahead of. A step that is itself skipped is never compared (nothing to place in the timeline).
 *
 * CLI:
 *   node forge-orchestrate.cjs plan [--json]
 *   node forge-orchestrate.cjs audit --events <events.jsonl> [--json]
 * Exit codes: plan: 0 always (informational) · audit: 0 = every required step ran, in order · 3 = a
 * required step was skipped or an out-of-order step was detected (mirrors forge-actiongate's gate=3
 * convention) · 2 = usage/config error (bad/missing checklist or events file).
 */
const fs = require('fs');
const path = require('path');

const CHECKLIST_PATH = path.join(__dirname, '..', 'config', 'orchestration', 'run-checklist.json');

let _cache = null; // { path, data } — cached across calls in the SAME process; tests override via opts.checklistPath
function loadChecklist(opts) {
  opts = opts || {};
  const p = opts.checklistPath || CHECKLIST_PATH;
  if (_cache && _cache.path === p) return _cache.data;

  const raw = fs.readFileSync(p, 'utf8');
  let data;
  try { data = JSON.parse(raw); }
  catch (e) { throw new Error('forge-orchestrate: ' + p + ' is not valid JSON: ' + e.message); }

  if (!data || !Array.isArray(data.steps) || data.steps.length === 0) {
    throw new Error('forge-orchestrate: ' + p + ' is missing a non-empty "steps" array');
  }

  const seenIds = new Set();
  for (const s of data.steps) {
    if (!s.id || typeof s.id !== 'string') {
      throw new Error('forge-orchestrate: a step in ' + p + ' is missing a string "id": ' + JSON.stringify(s));
    }
    if (seenIds.has(s.id)) {
      throw new Error('forge-orchestrate: duplicate step id "' + s.id + '" in ' + p);
    }
    seenIds.add(s.id);
    if (!s.label || typeof s.label !== 'string') {
      throw new Error('forge-orchestrate: step "' + s.id + '" is missing a string "label" in ' + p);
    }
    if (typeof s.required !== 'boolean') {
      throw new Error('forge-orchestrate: step "' + s.id + '" is missing a boolean "required" in ' + p);
    }
    if (s.produces_event != null) {
      const arr = Array.isArray(s.produces_event) ? s.produces_event : [s.produces_event];
      if (arr.length === 0 || arr.some((x) => typeof x !== 'string' || !x)) {
        throw new Error('forge-orchestrate: step "' + s.id + '" has an invalid "produces_event" (must be a non-empty string or array of non-empty strings) in ' + p);
      }
    }
    if (s.match != null) {
      if (typeof s.match !== 'object' || Array.isArray(s.match) || !s.match.field || typeof s.match.field !== 'string'
        || s.match.includes == null || typeof s.match.includes !== 'string') {
        throw new Error('forge-orchestrate: step "' + s.id + '" has an invalid "match" (must be {field:string, includes:string}) in ' + p);
      }
    }
  }

  _cache = { path: p, data };
  return data;
}

/** plan(opts) -> the ordered checklist steps, straight from run-checklist.json (see file header). */
function plan(opts) {
  return loadChecklist(opts).steps;
}

/** producesEvents(step) -> string[] — normalizes a step's produces_event (string|array|absent) to an array. */
function producesEvents(step) {
  if (step.produces_event == null) return [];
  return Array.isArray(step.produces_event) ? step.produces_event : [step.produces_event];
}

/** eventMatchesStep(e, step) -> boolean — see file header MODEL section for the full contract. Never
 *  throws on a malformed event object; simply reports no match. */
function eventMatchesStep(e, step) {
  if (!e || typeof e !== 'object' || !e.event_type) return false;
  const types = producesEvents(step);
  if (types.length === 0 || !types.includes(e.event_type)) return false;
  if (step.match) {
    const val = e[step.match.field];
    if (typeof val !== 'string' || !val.toLowerCase().includes(String(step.match.includes).toLowerCase())) return false;
  }
  // required-evidence: an event log-event.cjs's own CONTENT ORACLE already disproved is a CLAIM, not real
  // evidence — never counts toward a checklist step, regardless of its event_type/match match.
  if (e._forge_verify && e._forge_verify.proof_verified === false) return false;
  return true;
}

/** readEventsJsonl(eventsPath) -> event[] — line-delimited JSON, BOM-tolerant, malformed lines skipped
 *  (mirrors forge-verify.cjs::readEventsJsonl's tolerance so a partially-corrupt log never crashes audit()). */
function readEventsJsonl(eventsPath) {
  let raw;
  try { raw = fs.readFileSync(eventsPath, 'utf8'); }
  catch (e) {
    throw new Error('forge-orchestrate: could not read events file ' + eventsPath + ': ' + e.message);
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const events = [];
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try { events.push(JSON.parse(s)); } catch { /* malformed line — skip, never crash */ }
  }
  return events;
}

/** audit(input, opts) -> { ran, skipped, out_of_order } — see file header for the full contract. Throws
 *  only on a usage error (no events source supplied, unreadable events file) or a malformed checklist
 *  (loadChecklist) — never on a normal, even fully-empty, events array. */
function audit(input, opts) {
  opts = opts || {};
  input = input || {};
  let events;
  if (Array.isArray(input.events)) {
    events = input.events;
  } else if (input.eventsPath || opts.eventsPath) {
    events = readEventsJsonl(input.eventsPath || opts.eventsPath);
  } else {
    throw new Error('forge-orchestrate: audit requires input.events[] (an array) or input.eventsPath (a file path)');
  }

  const steps = plan(opts);
  const ran = [];
  const skipped = [];
  const outOfOrder = [];
  let maxEvIdx = -1;
  let maxStepId = null;

  for (const step of steps) {
    let foundIdx = -1;
    let foundType = null;
    for (let i = 0; i < events.length; i++) {
      if (eventMatchesStep(events[i], step)) { foundIdx = i; foundType = events[i].event_type; break; }
    }
    if (foundIdx === -1) {
      const types = producesEvents(step);
      skipped.push({
        id: step.id,
        label: step.label,
        required: step.required,
        reason: types.length
          ? 'no matching event (' + types.join('/') + ') found in this run' + (step.match ? (' with ' + step.match.field + ' containing "' + step.match.includes + '"') : '')
          : 'step has no produces_event to check against — cannot be audited from events alone',
      });
      continue;
    }
    ran.push({ id: step.id, label: step.label, evIdx: foundIdx, event_type: foundType });
    if (foundIdx < maxEvIdx) {
      outOfOrder.push({ id: step.id, label: step.label, evIdx: foundIdx, should_follow: maxStepId });
    } else {
      maxEvIdx = foundIdx;
      maxStepId = step.id;
    }
  }

  return { ran, skipped, out_of_order: outOfOrder };
}

module.exports = { plan, audit, loadChecklist, eventMatchesStep, producesEvents, readEventsJsonl, CHECKLIST_PATH };

// ---- CLI ----
function parseArgs(argv) {
  const cmd = argv[0] || null;
  const rest = argv.slice(1);
  const opts = { cmd, events: null, json: false, positional: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--events') opts.events = rest[++i];
    else if (a === '--json') opts.json = true;
    else opts.positional.push(a);
  }
  return opts;
}
function printUsage() {
  console.error('Usage: node forge-orchestrate.cjs plan [--json]');
  console.error('       node forge-orchestrate.cjs audit --events <events.jsonl> [--json]');
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  try {
    if (opts.cmd === 'plan') {
      const steps = plan({});
      if (opts.json) {
        console.log(JSON.stringify(steps));
      } else {
        steps.forEach((s, i) => {
          console.log((i + 1) + '. [' + (s.required ? 'required' : 'optional') + '] ' + s.id + ' — ' + s.label);
        });
      }
      process.exitCode = 0;
    } else if (opts.cmd === 'audit') {
      if (!opts.events) {
        console.error('forge-orchestrate: audit requires --events <events.jsonl>');
        process.exitCode = 2;
      } else {
        const result = audit({ eventsPath: opts.events }, {});
        if (opts.json) {
          console.log(JSON.stringify(result));
        } else {
          console.log('ran (' + result.ran.length + '):');
          for (const r of result.ran) console.log('  ' + r.id + '\t<- ' + r.event_type + ' @' + r.evIdx);
          console.log('skipped (' + result.skipped.length + '):');
          for (const s of result.skipped) console.log('  ' + s.id + (s.required ? ' [REQUIRED]' : '') + ' — ' + s.reason);
          console.log('out_of_order (' + result.out_of_order.length + '):');
          for (const o of result.out_of_order) console.log('  ' + o.id + ' @' + o.evIdx + ' — should follow "' + o.should_follow + '"');
        }
        const requiredSkipped = result.skipped.some((s) => s.required);
        process.exitCode = (requiredSkipped || result.out_of_order.length) ? 3 : 0;
      }
    } else {
      printUsage();
      process.exitCode = 2;
    }
  } catch (e) {
    console.error('forge-orchestrate: ' + e.message);
    process.exitCode = 2;
  }
}
