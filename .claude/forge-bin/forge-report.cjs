#!/usr/bin/env node
'use strict';
/**
 * forge-report.cjs — parses, validates, and ingests the structured subagent completion-report
 * contract. Zero-dependency, Windows-safe. This is what stops the Lead from hand-transcribing a
 * dispatched Boss's final message: every dispatched agent ends its message with ONE fenced block —
 *
 *   ```forge-report
 *   {
 *     "status": "completed|partial|blocked|failed",
 *     "work_package": "WP-…",
 *     "files_changed": ["…"],
 *     "tests_run": "…command + result…",
 *     "evidence": ["…"],
 *     "blockers": ["…"],
 *     "next_action": "…"
 *   }
 *   ```
 *
 * — and this tool parses that block out of the agent's raw text, validates it against the contract,
 * and (on success) logs it into the run's events.jsonl via forge-dashboard/log-event.cjs so the
 * dashboard renders it without the Lead re-typing anything.
 *
 * CONTRACT / HONESTY RULES (the point of this tool):
 *   - status must be one of completed|partial|blocked|failed.
 *   - work_package must be a non-empty string.
 *   - files_changed must be an array (may be empty — e.g. a pure investigation work package).
 *   - evidence must be an array; when status === 'completed' it must contain at least one non-empty
 *     string. A "completed" claim WITHOUT evidence is invalid — that is the entire point of the gate.
 *   - blockers must be a non-empty array when status === 'blocked' (a blocked claim with no blockers
 *     listed is invalid).
 *   - tests_run must be a string or an array — "none" is an honest, valid answer.
 *   - next_action must be a non-empty string.
 *   - result_caveat (OPTIONAL, 2026-08-01) must be a non-empty string WHEN PRESENT. See below.
 *   - Only the LAST ```forge-report fenced block in the text is used (an agent may think out loud with
 *     earlier examples/drafts; the final block is the real contract).
 *
 * THE FAILURE SIDE OF THE CONTRACT (2026-08-01). Measured that day: `result_caveat`, `on_stuck` and
 * `requires_inputs` returned ZERO hits repo-wide. The contract above validated status/work_package/
 * files_changed/tests_run/evidence/blockers/next_action — seven fields about what WORKED and not one about
 * the conditions under which the result stops holding, what an agent should do when it gets stuck, or what a
 * work package needs before it can start at all. Those three gaps are where self-deception lives: a green
 * test on a conveniently chosen scenario reads identically to a green test on the real one.
 *
 *   result_caveat  — "under what circumstances does this result NOT hold". OPTIONAL and validated only when
 *                    present (an empty or non-string value IS an error — a field that can be filled with
 *                    whitespace is a rubber stamp). When a COMPLETED report omits it, parseReport returns an
 *                    honest NOTE rather than an error: making it required would invalidate every report
 *                    written before today, and a contract that rejects the past teaches people to route
 *                    around it. Notes are surfaced by the CLI and by any caller that wants them.
 *   on_stuck       — the DISPATCH side (validateBrief below): one of exactly three agreed behaviours, so
 *                    "the agent got stuck" has a defined outcome instead of an improvised one.
 *   requires_inputs— also dispatch side: the artefact/event keys this work package cannot start without.
 *                    The SCHEMA is checked here (pure, no I/O — the same discipline validateReport follows);
 *                    resolving those keys against real run state is forge-verify.cjs::checkRequiredInputs,
 *                    which is the module that already owns "does this claim match the run".
 *   - On ingest, the WHOLE report is redacted with forge-store.cjs's redactValue() before it ever
 *     touches events.jsonl — a secret pasted into evidence/tests_run never reaches disk in the clear.
 *   - On a validation failure, ingest logs NOTHING — the report goes back to the agent, not the dashboard.
 *
 * CLI:
 *   node forge-report.cjs validate <file|->
 *     Reads a file (or stdin with "-"), parses + validates, prints errors, exit 0 (valid) / 2 (invalid).
 *
 *   node forge-report.cjs ingest <run_id> <file|-> --agent "<Boss name>" [--root <projectRoot>]
 *     Parses + validates; on success, redacts the report and logs ONE agent_output event
 *     ({agent, output: '<compact one-line summary>', report: <redacted report>}) plus ONE
 *     agent_evidence_added event ({agent, evidence: '<joined evidence>'}) via
 *     spawnSync(node, [<root>/.claude/forge-dashboard/log-event.cjs, ...]) — both event types are
 *     already registered in log-event.cjs's KNOWN_EVENT_TYPES (VISIBLE-REASONING category). run_id is
 *     validated against ^[A-Za-z0-9_-]+$ (same shape as every other Forge tool). On a validation
 *     failure: exit 2, print the errors, log NOTHING (the Lead must send the report back to the agent).
 *
 * Module API: { parseReport, validateReport, buildIngestEvents, findLastForgeReportBlock,
 *   summarizeReport, REQUIRED_STATUSES }
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const store = require('./forge-store.cjs');

const DEFAULT_ROOT = path.resolve(__dirname, '..', '..');
const REQUIRED_STATUSES = ['completed', 'partial', 'blocked', 'failed'];

// ---- 1) find + parse the fenced block ----------------------------------------------------------
// Only the LAST occurrence wins — an agent may show an earlier example/draft block while reasoning.
function findLastForgeReportBlock(text) {
  const re = /```forge-report[ \t]*\r?\n([\s\S]*?)```/g;
  let m;
  let last = null;
  while ((m = re.exec(text)) !== null) last = m[1];
  return last;
}

// ---- 2) validate the parsed object against the contract ----------------------------------------
function nonEmptyString(v) { return typeof v === 'string' && v.trim().length > 0; }

function validateReport(report) {
  const errors = [];
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    return ['report must be a JSON object'];
  }
  if (!REQUIRED_STATUSES.includes(report.status)) {
    errors.push('status must be one of: ' + REQUIRED_STATUSES.join(', ') + ' (got ' + JSON.stringify(report.status) + ')');
  }
  if (!nonEmptyString(report.work_package)) {
    errors.push('work_package must be a non-empty string');
  }
  if (!Array.isArray(report.files_changed)) {
    errors.push('files_changed must be an array (use [] when no files changed)');
  }
  if (!Array.isArray(report.evidence)) {
    errors.push('evidence must be an array (use [] when there is genuinely none — but see the completed rule below)');
  } else if (report.status === 'completed') {
    const real = report.evidence.filter(nonEmptyString);
    if (real.length === 0) {
      errors.push('evidence must contain at least one non-empty string when status is "completed" — a completed claim REQUIRES evidence');
    }
  }
  if (report.status === 'blocked') {
    const list = Array.isArray(report.blockers) ? report.blockers.filter((b) => b != null && String(b).trim().length > 0) : [];
    if (list.length === 0) errors.push('blockers must be a non-empty array when status is "blocked"');
  } else if (report.blockers !== undefined && !Array.isArray(report.blockers)) {
    errors.push('blockers must be an array when present');
  }
  if (!(typeof report.tests_run === 'string' || Array.isArray(report.tests_run))) {
    errors.push('tests_run must be a string or an array — use "none" if nothing was run (be honest)');
  }
  if (!nonEmptyString(report.next_action)) {
    errors.push('next_action must be a non-empty string');
  }
  // result_caveat is OPTIONAL, but a present one must say something. `undefined` passes (see reportNotes);
  // `""`, `"   "` and a non-string are errors, because a field that accepts whitespace is not a caveat, it is
  // a checkbox, and a checkbox is exactly what this field exists to not be.
  if (report.result_caveat !== undefined && !nonEmptyString(report.result_caveat)) {
    errors.push('result_caveat must be a non-empty string when present — it answers "under what circumstances does this result NOT hold"; omit the field entirely rather than filling it with whitespace');
  }
  return errors;
}

/** reportNotes(report) -> [string] — VALID-but-worth-saying observations. Deliberately separate from
 *  validateReport's errors: a note never makes a report invalid and never blocks an ingest. Today it carries
 *  exactly one thing — a completed claim with no stated caveat — because that is the case where the report is
 *  formally perfect and still leaves the most important question unanswered. A blocked/failed report is not
 *  nagged: its blockers already ARE the statement of what does not hold. */
function reportNotes(report) {
  const notes = [];
  if (!report || typeof report !== 'object') return notes;
  if (report.status === 'completed' && report.result_caveat === undefined) {
    notes.push('no result_caveat given: this report claims completed without stating under what circumstances '
      + 'the result does NOT hold (platform, data, scale, scenario). Not an error — the field is optional — but '
      + 'a green result whose validity conditions are unwritten is the easiest kind to over-trust.');
  }
  return notes;
}

/** parseReport(text) -> {ok:true, report, notes:[...]} | {ok:false, errors:[...], notes:[]}
 *  `notes` is additive (2026-08-01) — existing callers reading .ok/.report/.errors are unaffected. */
function parseReport(text) {
  if (typeof text !== 'string') return { ok: false, errors: ['input must be a string'], notes: [] };
  const blockText = findLastForgeReportBlock(text);
  if (blockText === null) return { ok: false, errors: ['no ```forge-report fenced block found in text'], notes: [] };
  let report;
  try {
    report = JSON.parse(blockText);
  } catch (e) {
    return { ok: false, errors: ['malformed JSON in ```forge-report block: ' + e.message], notes: [] };
  }
  const errors = validateReport(report);
  if (errors.length) return { ok: false, errors, notes: reportNotes(report) };
  return { ok: true, report, notes: reportNotes(report) };
}

// ---- 2b) the DISPATCH half of the same contract: the work-package brief -------------------------------
/** BRIEF_ON_STUCK — the only three behaviours a stuck agent may be told to take, and there are exactly three
 *  on purpose. "Ask" concentrates every question into ONE consolidated interruption instead of a drip feed;
 *  "stop and report" preserves what was actually tried instead of burning the rest of the budget guessing;
 *  "flagged best guess" allows progress but forces the assumption to be visible in the result. Anything else
 *  ("improvise", "figure it out") is not a behaviour, it is the absence of one — which is what a brief with no
 *  on_stuck field silently means today. */
const BRIEF_ON_STUCK = ['ask_owner', 'stop_and_report', 'flagged_best_guess'];

/** validateBrief(brief) -> [errors]. PURE — no I/O, exactly like validateReport. Only `work_package` is
 *  required: on_stuck and requires_inputs are OPTIONAL so that every dispatch written before today stays
 *  valid, and their absence is surfaced through briefNotes() instead of through a rejection. */
function validateBrief(brief) {
  const errors = [];
  if (brief === null || typeof brief !== 'object' || Array.isArray(brief)) return ['brief must be a JSON object'];
  if (!nonEmptyString(brief.work_package)) errors.push('work_package must be a non-empty string');
  if (brief.on_stuck !== undefined && !BRIEF_ON_STUCK.includes(brief.on_stuck)) {
    errors.push('on_stuck must be one of: ' + BRIEF_ON_STUCK.join(', ') + ' (got ' + JSON.stringify(brief.on_stuck) + ')');
  }
  if (brief.requires_inputs !== undefined) {
    if (!Array.isArray(brief.requires_inputs)) {
      errors.push('requires_inputs must be an array of input keys (e.g. ["prd.acceptance_criteria", "event.browser_screenshot_captured.screenshot_path"])');
    } else if (!brief.requires_inputs.every(nonEmptyString)) {
      errors.push('requires_inputs must contain only non-empty strings — an empty key cannot be resolved against run state and would silently pass');
    }
  }
  return errors;
}

/** briefNotes(brief) -> [string] — valid-but-worth-saying, same contract as reportNotes(). */
function briefNotes(brief) {
  const notes = [];
  if (!brief || typeof brief !== 'object') return notes;
  if (brief.on_stuck === undefined) {
    notes.push('no on_stuck given: this brief does not say what the agent should do when it gets stuck, so the '
      + 'behaviour is whatever the agent improvises. Allowed values: ' + BRIEF_ON_STUCK.join(', ') + '.');
  }
  if (brief.requires_inputs === undefined) {
    notes.push('no requires_inputs given: nothing will be checked before dispatch, so this work package can be '
      + 'started against empty input and left to improvise.');
  }
  return notes;
}

// ---- 3) build the ingest events (pure — no I/O; unit-testable without touching events.jsonl) ---
function summarizeReport(report) {
  const filesN = Array.isArray(report.files_changed) ? report.files_changed.length : 0;
  const tests = Array.isArray(report.tests_run) ? report.tests_run.join(' | ') : String(report.tests_run);
  return report.status + ' · ' + report.work_package + ' · ' + filesN + ' file(s) · tests: ' + tests;
}

/**
 * buildIngestEvents(report, agent) -> [{event_type, extra}, {event_type, extra}]
 * Redacts the WHOLE report via forge-store.redactValue before it is embedded in either event. Only
 * emits event_type names already registered in forge-dashboard/log-event.cjs KNOWN_EVENT_TYPES:
 * agent_output, agent_evidence_added (both VISIBLE-REASONING, not hidden chain-of-thought).
 */
function buildIngestEvents(report, agent) {
  const redacted = store.redactValue(report);
  const evidenceJoined = Array.isArray(redacted.evidence) ? redacted.evidence.filter(nonEmptyString).join('; ') : '';
  return [
    { event_type: 'agent_output', extra: { agent, output: summarizeReport(redacted), report: redacted } },
    { event_type: 'agent_evidence_added', extra: { agent, evidence: evidenceJoined } },
  ];
}

module.exports = {
  parseReport, validateReport, buildIngestEvents, findLastForgeReportBlock, summarizeReport, REQUIRED_STATUSES,
  // 2026-08-01 — the failure side of the same contract (see the file header): the report's validity
  // conditions, and the dispatch brief's stuck-behaviour + required inputs.
  reportNotes, validateBrief, briefNotes, BRIEF_ON_STUCK,
};

// ---- CLI -----------------------------------------------------------------------------------------
function readInput(fileArg) {
  if (fileArg === '-') return fs.readFileSync(0, 'utf8');
  return fs.readFileSync(fileArg, 'utf8');
}

if (require.main === module) {
  const main = () => {
    const argv = process.argv.slice(2);
    const cmd = argv[0];

    if (cmd === 'validate') {
      const fileArg = argv[1];
      if (!fileArg) { console.error('Usage: forge-report.cjs validate <file|->'); process.exitCode = 1; return; }
      let text;
      try { text = readInput(fileArg); } catch (e) { console.error('forge-report: could not read input: ' + e.message); process.exitCode = 1; return; }
      const result = parseReport(text);
      if (result.ok) {
        console.log('VALID — ' + result.report.work_package + ' (' + result.report.status + ')');
        // notes never change the exit code — they are what a valid report still leaves unsaid
        (result.notes || []).forEach((n) => console.log('  note: ' + n));
        process.exitCode = 0;
      } else {
        console.error('INVALID:');
        result.errors.forEach((e) => console.error('  - ' + e));
        process.exitCode = 2;
      }
      return;
    }

    if (cmd === 'ingest') {
      const rest = argv.slice(1);
      const pos = [];
      let agent = null;
      let root = DEFAULT_ROOT;
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--agent') agent = rest[++i];
        else if (rest[i] === '--root') root = rest[++i];
        else pos.push(rest[i]);
      }
      const [runId, fileArg] = pos;
      if (!runId || !fileArg || !agent) {
        console.error('Usage: forge-report.cjs ingest <run_id> <file|-> --agent "<Boss name>" [--root <projectRoot>]');
        process.exitCode = 1;
        return;
      }
      if (!/^[A-Za-z0-9_-]+$/.test(runId)) {
        console.error('forge-report: invalid run_id (allowed: A-Z a-z 0-9 _ -): ' + runId);
        process.exitCode = 1;
        return;
      }
      let text;
      try { text = readInput(fileArg); } catch (e) { console.error('forge-report: could not read input: ' + e.message); process.exitCode = 1; return; }
      const result = parseReport(text);
      if (!result.ok) {
        console.error('INGEST REFUSED — report invalid, send it back to ' + agent + ':');
        result.errors.forEach((e) => console.error('  - ' + e));
        process.exitCode = 2; // nothing is logged on an invalid report
        return;
      }
      const events = buildIngestEvents(result.report, agent);
      const logEventPath = path.join(path.resolve(root), '.claude', 'forge-dashboard', 'log-event.cjs');
      let failures = 0;
      for (const ev of events) {
        const r = spawnSync(process.execPath, [logEventPath, runId, ev.event_type, JSON.stringify(ev.extra)], { encoding: 'utf8' });
        if (r.status !== 0) { failures++; console.error('forge-report: log-event warning (' + ev.event_type + '): ' + ((r.stderr || r.stdout || '').trim())); }
      }
      console.log((failures ? 'INGESTED WITH WARNINGS' : 'INGESTED') + ' — ' + agent + ' · ' + result.report.status + ' · ' + result.report.work_package + ' -> run ' + runId);
      process.exitCode = failures ? 1 : 0;
      return;
    }

    console.error('Usage: node forge-report.cjs <validate|ingest> ...');
    process.exitCode = 1;
  };
  try { main(); } catch (e) { console.error('forge-report: ' + e.message); process.exitCode = 1; }
}
