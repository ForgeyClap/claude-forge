#!/usr/bin/env node
'use strict';
/**
 * forge-intake.cjs — Prompt Master intake question engine (WP-INTAKE). Windows-safe zero-dependency
 * (fs/path/child_process only). At the start of a /forge build the Lead presents the OWNER ONE big
 * clarifying-question list (the owner's explicit choice — not a multi-turn wizard) so the project's real
 * goal is captured before any team is spawned. This file only SELECTS and RENDERS that list — it never
 * asks the owner anything itself and never calls an LLM or the network; every question comes from the
 * owner-editable bank at `.claude/config/intake/question-bank.json`.
 *
 * BANK SHAPE (read-only; this file never writes it):
 *   { version, universal: [ {dimension, question, why, options[], tier:'required'|'recommended'} ],
 *     byType: { "<slug>": [ same shape ] } }  — slugs e.g. website, ecommerce, fullstack, electron, n8n,
 *   integration, rag, voice, prediction, scraping, dashboard.
 *
 * SELECTION ORDER: ALL of `universal` first, then `byType[<type>]` (if the slug exists) — within EACH
 * group, tier 'required' precedes 'recommended', original bank order otherwise preserved. `--extra` items
 * (a subagent's novel-project question brainstorm) are appended as a third 'extra' group, deduped against
 * every question already selected by normalized (lowercased, whitespace-collapsed) question text.
 * `--tier required` drops every 'recommended' question. `--max N` NEVER drops a 'required' question — it
 * only trims 'recommended' questions (in list order) once the total would exceed N, and reports the exact
 * drop count honestly. An unknown or omitted `--type` falls back to universal-only with a printed note
 * (extend `byType` in the bank for new project types — never force-fit).
 *
 * CLI:
 *   node forge-intake.cjs --type <slug> [--task "<desc>"] [--tier required|all] [--max N]
 *                          [--extra <file.json>] [--json] [--run <run_id>]
 *     Human output (default): one numbered list, `N. [tier] (dimension) question` + why/opties lines,
 *     with a Dutch header/footer (owner-chosen voice — matches this project's Forge NL conventions).
 *     --json prints { type, version, count, required, recommended, note, droppedCount, questions[] }.
 *     --run <run_id> additionally logs ONE `agent_note` event (agent:orchestrator, role:lead) via
 *     ../forge-dashboard/log-event.cjs describing how many intake questions were produced. A logging
 *     failure is reported to stderr but NEVER changes the exit code — the question list already printed
 *     is still valid.
 *
 * Exit codes: 0 = list produced (even with an unknown-type/extra-file note) · 1 = the bank could not be
 * read/parsed · 2 = usage error (unknown flag, bad --tier, non-numeric/negative --max).
 *
 * FORGE_PROJECT_ROOT overrides the project root (same convention as forge-evals.cjs/forge-distill.cjs) —
 * every path is built with path.join. DETERMINISTIC; NO LLM — questions come only from the owner-editable
 * bank (+ an optional pre-brainstormed `--extra` file); this file never invents question text itself.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PROJECT_ROOT = process.env.FORGE_PROJECT_ROOT ? path.resolve(process.env.FORGE_PROJECT_ROOT) : path.resolve(__dirname, '..', '..');

// ---- pure helpers ----
function normText(s) { return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim(); }
function tierOf(t) { return t === 'required' ? 'required' : 'recommended'; }
function tierRank(t) { return tierOf(t) === 'required' ? 0 : 1; }

/** groupQuestions(list, groupName) -> annotated, tier-sorted (required before recommended, stable)
 *  question objects for one bank group ('universal' or a byType slug). Never throws on a malformed item. */
function groupQuestions(list, groupName) {
  return (Array.isArray(list) ? list : [])
    .filter((q) => q && typeof q === 'object' && typeof q.question === 'string' && q.question.trim())
    .slice()
    .sort((a, b) => tierRank(a.tier) - tierRank(b.tier))
    .map((q) => ({
      group: groupName,
      dimension: typeof q.dimension === 'string' && q.dimension.trim() ? q.dimension.trim() : 'general',
      question: q.question.trim(),
      why: typeof q.why === 'string' ? q.why.trim() : '',
      options: Array.isArray(q.options) ? q.options : [],
      tier: tierOf(q.tier),
    }));
}

/** loadBank(bankPath) -> {ok:true, bank} | {ok:false, error}. Never throws. */
function loadBank(bankPath) {
  let raw;
  try { raw = fs.readFileSync(bankPath, 'utf8'); } catch (e) { return { ok: false, error: `cannot read question bank (${bankPath}): ${e.message}` }; }
  let obj;
  try { obj = JSON.parse(raw); } catch (e) { return { ok: false, error: `invalid JSON in question bank: ${e.message}` }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || !Array.isArray(obj.universal)) {
    return { ok: false, error: 'question bank must be an object with a "universal" array' };
  }
  return { ok: true, bank: obj };
}

/** loadExtra(extraPath) -> {questions[], note|null}. Missing/unreadable/malformed file is NEVER fatal —
 *  it is reported via `note` and treated as zero extra questions. Never throws. */
function loadExtra(extraPath) {
  if (!extraPath) return { questions: [], note: null };
  let raw;
  try { raw = fs.readFileSync(extraPath, 'utf8'); }
  catch (e) { return { questions: [], note: `--extra file unreadable (${e.message}) — ignored` }; }
  let arr;
  try { arr = JSON.parse(raw); }
  catch (e) { return { questions: [], note: `--extra file is not valid JSON (${e.message}) — ignored` }; }
  if (!Array.isArray(arr)) return { questions: [], note: '--extra file must be a JSON array of question objects — ignored' };
  return { questions: arr, note: null };
}

/** assembleAll(bank, type, extraQuestions) -> {items[], typeNote|null, trimmedType}. Builds the FULL
 *  ordered (not yet tier/max-filtered) list: universal, then byType[type] (or a fallback note), then a
 *  deduped 'extra' group. Dedup compares normalized question text against everything already selected. */
function assembleAll(bank, type, extraQuestions) {
  const items = groupQuestions(bank.universal, 'universal');
  const trimmedType = type ? String(type).trim() : '';
  let typeNote = null;
  if (trimmedType && bank.byType && Array.isArray(bank.byType[trimmedType])) {
    items.push(...groupQuestions(bank.byType[trimmedType], trimmedType));
  } else {
    typeNote = `unknown/again type '${trimmedType || '(none)'}' — universal questions only; extend byType in question-bank.json`;
  }
  const seen = new Set(items.map((q) => normText(q.question)));
  const extra = (Array.isArray(extraQuestions) ? extraQuestions : [])
    .filter((q) => q && typeof q === 'object' && typeof q.question === 'string' && q.question.trim())
    .map((q) => ({
      group: 'extra',
      dimension: typeof q.dimension === 'string' && q.dimension.trim() ? q.dimension.trim() : 'extra',
      question: q.question.trim(),
      why: typeof q.why === 'string' ? q.why.trim() : '',
      options: Array.isArray(q.options) ? q.options : [],
      tier: tierOf(q.tier),
      _norm: normText(q.question),
    }))
    .filter((q) => { if (seen.has(q._norm)) return false; seen.add(q._norm); return true; })
    .sort((a, b) => tierRank(a.tier) - tierRank(b.tier))
    .map((q) => { const { _norm, ...rest } = q; return rest; });
  items.push(...extra);
  return { items, typeNote, trimmedType };
}

/** capList(items, max) -> {kept[], dropped}. NEVER drops a 'required' question; fills the remaining
 *  budget with 'recommended' questions in original list order, dropping the rest — honestly counted. */
function capList(items, max) {
  const requiredCount = items.filter((q) => q.tier === 'required').length;
  const remaining = Math.max(0, max - requiredCount);
  let used = 0, dropped = 0;
  const kept = [];
  for (const q of items) {
    if (q.tier === 'required') kept.push(q);
    else if (used < remaining) { kept.push(q); used++; }
    else dropped++;
  }
  return { kept, dropped };
}

/** buildIntake(bank, opts) -> the final numbered result. opts: {type, tier:'required'|'all',
 *  max:number|null, extraQuestions[]}. Pure/deterministic given the same bank + opts. */
function buildIntake(bank, opts) {
  opts = opts || {};
  const { items, typeNote, trimmedType } = assembleAll(bank, opts.type, opts.extraQuestions);
  let working = opts.tier === 'required' ? items.filter((q) => q.tier === 'required') : items;
  let dropped = 0;
  if (Number.isFinite(opts.max)) {
    const capped = capList(working, opts.max);
    working = capped.kept;
    dropped = capped.dropped;
  }
  const questions = working.map((q, i) => Object.assign({ n: i + 1 }, q));
  const required = questions.filter((q) => q.tier === 'required').length;
  return {
    type: trimmedType || null,
    version: bank.version || null,
    note: typeNote,
    droppedCount: dropped,
    questions,
    count: questions.length,
    required,
    recommended: questions.length - required,
  };
}

// ---- rendering ----
function formatHuman(result) {
  const typeLabel = result.type || 'universal';
  const lines = [`Prompt Master intake — ${typeLabel} · ${result.count} vragen (${result.required} verplicht, ${result.recommended} aanbevolen)`];
  if (result.note) lines.push('Let op: ' + result.note);
  if (result.droppedCount > 0) lines.push(`Let op: --max liet ${result.droppedCount} aanbevolen vra(a)g(en) vallen.`);
  lines.push('');
  for (const q of result.questions) {
    lines.push(`${q.n}. [${q.tier}] (${q.dimension}) ${q.question}`);
    if (q.why) lines.push('      why: ' + q.why);
    if (q.options.length) lines.push('      opties: ' + q.options.join(' · '));
  }
  lines.push('');
  lines.push('Beantwoord per nummer of kies een optie hierboven — je antwoorden voeden de PRD en de Boss-dispatches.');
  return lines.join('\n');
}

function toJson(result, task) {
  const out = {
    type: result.type, version: result.version, count: result.count, required: result.required,
    recommended: result.recommended, note: result.note, droppedCount: result.droppedCount, questions: result.questions,
  };
  if (task) out.task = task;
  return out;
}

/** logIntakeNote(runId, root, result, typeLabel) -> {ok:true} | {ok:false, reason}. Best-effort, never
 *  throws; a failure never invalidates the already-printed question list. */
function logIntakeNote(runId, root, result, typeLabel) {
  const logEventPath = path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs');
  const note = `forge-intake: ${result.count} intake-vragen voor type ${typeLabel} (${result.required} verplicht)`;
  const payload = JSON.stringify({ agent: 'orchestrator', role: 'lead', note, evidence: 'config/intake/question-bank.json' });
  const r = spawnSync(process.execPath, [logEventPath, runId, 'agent_note', payload], { encoding: 'utf8' });
  if (r.error) return { ok: false, reason: r.error.message };
  if (r.status !== 0) return { ok: false, reason: (r.stderr || r.stdout || 'log-event.cjs exited ' + r.status).toString().trim() };
  return { ok: true };
}

// ---- CLI ----
function parseArgs(argv) {
  const opts = { type: null, task: null, tier: 'all', max: null, extra: null, json: false, run: null };
  const errors = [];
  const KNOWN = new Set(['--type', '--task', '--tier', '--max', '--extra', '--json', '--run']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!KNOWN.has(a)) { errors.push(`unknown flag '${a}'`); continue; }
    if (a === '--json') { opts.json = true; continue; }
    const v = argv[++i];
    if (v === undefined) { errors.push(`${a} requires a value`); continue; }
    if (a === '--type') opts.type = v;
    else if (a === '--task') opts.task = v;
    else if (a === '--tier') opts.tier = v;
    else if (a === '--max') opts.max = v;
    else if (a === '--extra') opts.extra = v;
    else if (a === '--run') opts.run = v;
  }
  if (opts.tier !== 'all' && opts.tier !== 'required') errors.push(`--tier must be 'required' or 'all' (got '${opts.tier}')`);
  let maxNum = null;
  if (opts.max != null) {
    maxNum = Number(opts.max);
    if (!Number.isFinite(maxNum) || maxNum < 0 || !Number.isInteger(maxNum)) errors.push(`--max must be a non-negative integer (got '${opts.max}')`);
  }
  opts.maxNum = maxNum;
  return { opts, errors };
}

function printUsage() {
  console.error('Usage: node forge-intake.cjs --type <slug> [--task "<desc>"] [--tier required|all] [--max N] [--extra <file.json>] [--json] [--run <run_id>]');
}

module.exports = {
  normText, groupQuestions, loadBank, loadExtra, assembleAll, capList, buildIntake,
  formatHuman, toJson, logIntakeNote, parseArgs,
};

if (require.main === module) {
  try {
    const { opts, errors } = parseArgs(process.argv.slice(2));
    if (errors.length) {
      errors.forEach((e) => console.error('forge-intake: ' + e));
      printUsage();
      process.exitCode = 2;
    } else {
      const bankPath = path.join(PROJECT_ROOT, '.claude', 'config', 'intake', 'question-bank.json');
      const loaded = loadBank(bankPath);
      if (!loaded.ok) {
        console.error('forge-intake: ' + loaded.error);
        process.exitCode = 1;
      } else {
        const extraLoaded = loadExtra(opts.extra);
        if (extraLoaded.note) console.error('forge-intake: ' + extraLoaded.note);
        const result = buildIntake(loaded.bank, { type: opts.type, tier: opts.tier, max: opts.maxNum, extraQuestions: extraLoaded.questions });
        if (opts.json) console.log(JSON.stringify(toJson(result, opts.task)));
        else console.log(formatHuman(result));
        if (opts.run) {
          const logged = logIntakeNote(opts.run, PROJECT_ROOT, result, result.type || 'universal');
          if (logged.ok === false) console.error('forge-intake: agent_note logging failed (question list still valid): ' + logged.reason);
        }
        process.exitCode = 0;
      }
    }
  } catch (e) { console.error('forge-intake: ' + e.message); process.exitCode = 1; }
}
