#!/usr/bin/env node
'use strict';
/**
 * forge-promptcheck.cjs — Prompt Master dispatch-prompt linter (WP-PROMPTCHECK). Zero-dependency,
 * Windows-safe. ADVISORY / NON-BLOCKING (Forge is security-light) — this is a nudge toward sharper
 * Boss dispatch prompts, never a gate. Deterministic heuristics only: no LLM call, no network call.
 *
 * WHY: the owner wants Prompt Master's agentic-prompt diagnostic ALWAYS applied to what Forge says to
 * a Boss. A well-shaped dispatch states: starting state/target, what's allowed, what's forbidden, when
 * to stop, how "done" is measured, and that evidence (not a claim) proves it. This tool scores a raw
 * dispatch/work-package prompt text against those 7 dimensions and prints concrete, one-line fixes.
 *
 * THE 7 DIMENSIONS (each present/missing, case-insensitive keyword + structure heuristics):
 *   1. target-state         — states the deliverable / what "done"/"target" looks like.
 *   2. allowed-scope         — anchors which files/dirs/paths/actions are IN scope.
 *   3. forbidden-scope       — a scope lock / what NOT to touch.
 *   4. stop-condition        — when to stop / ask-before triggers / no runaway.
 *   5. acceptance-criteria   — measurable done / success criteria / tests.
 *   6. evidence-honesty      — requires real evidence / no fabricated claims.
 *   7. no-vague-verbs        — FAILS when the prompt leans on vague verbs (handle/improve/make
 *      better/fix stuff/optimize/clean up/some/etc) with no concrete file/dir/path grounding nearby.
 *
 * MAPPING to the canonical Forge work-package shape (see forge-router SKILL.md "Emit Work Packages"):
 *   mission -> target-state · inputs/allowed_actions -> allowed-scope · not_allowed -> forbidden-scope
 *   · success_criteria doubles as an implicit stop-condition AND acceptance-criteria signal ·
 *   rework_criteria -> acceptance-criteria · evidence_required -> evidence-honesty. A real Forge work
 *   package built from that template already tends to pass — that's the point: this tool rewards the
 *   shape Forge already asks Bosses to use, and flags freehand prompts that skipped it.
 *
 * SCORING: passed = number of the 7 dimensions that pass. score mirrors the documented "passed/7"
 * framing — it is surfaced as that same integer (not a 0..1 fraction) so the verdict thresholds below
 * read directly off it; `total` (fixed at 7) is the denominator for the human "X/7" display.
 *   verdict: passed>=6 -> PROMPT-MASTER-SHAPED · passed 4-5 -> "OK (sharpen: <missing dims>)" ·
 *            passed<4  -> "NEEDS-SHARPENING (<missing dims>)"
 *
 * CLI:
 *   node forge-promptcheck.cjs <promptFile|-> [--json] [--strict] [--run <run_id>]
 *     <promptFile>  path to a text file holding the dispatch prompt; "-" reads it from STDIN.
 *     --json        print { score, passed, total, verdict, dimensions, missing, suggestions } instead
 *                   of the human report.
 *     --strict      exit 1 when passed < 6 (opt-in gate). Without it, this tool is purely advisory.
 *     --run <id>    also log ONE `agent_note` event via ../forge-dashboard/log-event.cjs summarizing
 *                   the score for that run's dashboard. A failure to log is a warning, never fatal —
 *                   this tool never blocks the caller on a logging problem.
 *
 * Exit codes: 0 = advisory pass-through (default, regardless of score) · 1 = --strict threshold not met
 * (passed < 6) · 2 = usage error (no file argument, or the prompt could not be read).
 *
 * Module API: { DIMENSIONS, checkPrompt, formatReport, hasKeyword, hasPathOrFileToken, countVagueHits }
 * FORGE_PROJECT_ROOT overrides the project root used to locate log-event.cjs for --run (same convention
 * as forge-reflect.cjs / forge-memory.cjs). Deterministic; no LLM; no network.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PROJECT_ROOT = process.env.FORGE_PROJECT_ROOT ? path.resolve(process.env.FORGE_PROJECT_ROOT) : path.resolve(__dirname, '..', '..');

// ---- small pure helpers -----------------------------------------------------------------------------
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** hasKeyword(text, phrase) -> whole-word/whole-phrase, case-insensitive, whitespace-flexible match. */
function hasKeyword(text, phrase) {
  const pattern = '\\b' + escapeRe(phrase).replace(/ /g, '\\s+') + '\\b';
  return new RegExp(pattern, 'i').test(text);
}

// a slash-delimited path segment ("src/components/Hero.tsx", ".claude/forge-bin/x.cjs") or a bare
// filename carrying a recognizable extension ("Hero.tsx") — either counts as concrete grounding.
const PATH_TOKEN_RE = /[\w.-]+\/[\w./-]+/;
const FILE_EXT_RE = /\b[\w-]+\.(?:cjs|js|mjs|ts|tsx|jsx|md|json|yml|yaml|py|txt|html|css|sh|ps1|cmd)\b/i;
function hasPathOrFileToken(text) { return PATH_TOKEN_RE.test(text) || FILE_EXT_RE.test(text); }

const VAGUE_PATTERNS = [
  /\bhandle\b/gi,
  /\bimprove\b/gi,
  /\bmake\s+(?:\w+\s+)?better\b/gi,
  /\bfix\s+stuff\b/gi,
  /\boptimize\b/gi,
  /\bclean[\s-]*up\b/gi,
  /\bsome\b/gi,
  /\betc\b/gi,
];
function countVagueHits(text) {
  let n = 0;
  for (const re of VAGUE_PATTERNS) { const m = text.match(re); if (m) n += m.length; }
  return n;
}

// ---- the 7 dimensions --------------------------------------------------------------------------------
const KEYWORD_DIMENSIONS = [
  { key: 'target-state', keywords: ['deliverable', 'target', 'produce', 'build', 'output_artifact', 'done when', 'result', 'goal', 'mission'],
    suggestion: 'state the target/deliverable: what "done" looks like (mission, output_artifact, or a "done when..." line).' },
  { key: 'allowed-scope', keywords: ['allowed_actions', 'work only', 'edit only', 'these files', 'inputs'], pathFallback: true,
    suggestion: 'anchor the allowed scope: which files/dirs/actions are IN scope (allowed_actions, explicit paths, or "work only in <dir>").' },
  { key: 'forbidden-scope', keywords: ['not_allowed', 'do not', 'never', 'scope lock', 'only the', 'must not', 'forbidden'],
    suggestion: 'add a scope lock: which files/dirs may and may NOT be touched (not_allowed / "do not" / "never touch X").' },
  { key: 'stop-condition', keywords: ['stop', 'stop condition', 'ask before', 'do not proceed', 'checkpoint', 'when complete', 'success_criteria'],
    suggestion: 'add a stop condition: when to stop or ask before proceeding (e.g. "stop when X", "ask before Y").' },
  { key: 'acceptance-criteria', keywords: ['success_criteria', 'acceptance', 'must pass', 'tests', 'criteria', 'verify', 'rework_criteria'],
    suggestion: 'add measurable acceptance criteria: success_criteria / tests that must pass / how to verify "done".' },
  { key: 'evidence-honesty', keywords: ['evidence', 'evidence_required', 'real output', 'do not claim', 'honesty', 'proof'],
    suggestion: 'require real evidence: quote actual command output, no fabricated claims of success (evidence_required).' },
];

const VAGUE_VERB_SUGGESTION = 'replace vague verbs (handle/improve/make better/fix stuff/optimize/clean up/some/etc) with concrete nouns + file/dir paths.';

const DIMENSIONS = KEYWORD_DIMENSIONS.map((d) => ({
  key: d.key,
  suggestion: d.suggestion,
  check: (text) => d.keywords.some((k) => hasKeyword(text, k)) || (d.pathFallback === true && hasPathOrFileToken(text)),
})).concat([{
  key: 'no-vague-verbs',
  suggestion: VAGUE_VERB_SUGGESTION,
  // fails only when vague-verb density is real (>2 hits) AND there is no concrete path/file anchor.
  check: (text) => !(countVagueHits(text) > 2 && !hasPathOrFileToken(text)),
}]);

/** checkPrompt(text) -> { score, passed, total:7, verdict, dimensions:{key:bool}, missing:[...], suggestions:[...] } */
function checkPrompt(rawText) {
  const text = String(rawText == null ? '' : rawText);
  const dimensions = {};
  const missing = [];
  const suggestions = [];
  for (const d of DIMENSIONS) {
    const ok = d.check(text);
    dimensions[d.key] = ok;
    if (!ok) { missing.push(d.key); suggestions.push(d.suggestion); }
  }
  const passed = Object.values(dimensions).filter(Boolean).length;
  const total = DIMENSIONS.length;
  let verdict;
  if (passed >= 6) verdict = 'PROMPT-MASTER-SHAPED';
  else if (passed >= 4) verdict = 'OK (sharpen: ' + missing.join(', ') + ')';
  else verdict = 'NEEDS-SHARPENING (' + missing.join(', ') + ')';
  return { score: passed, passed, total, verdict, dimensions, missing, suggestions };
}

function formatReport(result) {
  const lines = ['forge-promptcheck: score ' + result.passed + '/' + result.total + ' -- ' + result.verdict];
  for (const d of DIMENSIONS) {
    const ok = result.dimensions[d.key];
    lines.push('  ' + (ok ? '✓' : '✗') + ' ' + d.key + (ok ? '' : ' -- ' + d.suggestion));
  }
  return lines.join('\n');
}

module.exports = { DIMENSIONS, checkPrompt, formatReport, hasKeyword, hasPathOrFileToken, countVagueHits };

// ---- CLI ----
function readInput(fileArg) {
  if (fileArg === '-') return fs.readFileSync(0, 'utf8');
  return fs.readFileSync(fileArg, 'utf8');
}
function parseArgs(argv) {
  const opts = { file: null, json: false, strict: false, run: null };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--strict') opts.strict = true;
    else if (a === '--run') opts.run = argv[++i];
    else positional.push(a);
  }
  opts.file = positional[0] || null;
  return opts;
}
function printUsage() {
  console.error('Usage: node forge-promptcheck.cjs <promptFile|-> [--json] [--strict] [--run <run_id>]');
}

if (require.main === module) {
  const main = () => {
    const opts = parseArgs(process.argv.slice(2));
    if (!opts.file) { printUsage(); process.exitCode = 2; return; }

    let text;
    try { text = readInput(opts.file); }
    catch (e) { console.error('forge-promptcheck: could not read prompt (' + opts.file + '): ' + e.message); process.exitCode = 2; return; }

    const result = checkPrompt(text);
    if (opts.json) console.log(JSON.stringify(result));
    else console.log(formatReport(result));

    if (opts.run) {
      if (!/^[A-Za-z0-9_-]+$/.test(opts.run)) {
        console.error('forge-promptcheck: invalid --run id (allowed: A-Z a-z 0-9 _ -)');
      } else {
        const logEventPath = path.join(PROJECT_ROOT, '.claude', 'forge-dashboard', 'log-event.cjs');
        const payload = {
          agent: 'orchestrator', role: 'lead',
          note: 'forge-promptcheck: ' + result.passed + '/' + result.total + ' ' + result.verdict,
          evidence: 'dispatch prompt lint',
        };
        const r = spawnSync(process.execPath, [logEventPath, opts.run, 'agent_note', JSON.stringify(payload)], { encoding: 'utf8' });
        if (r.status !== 0) console.error('forge-promptcheck: log-event warning: ' + ((r.stderr || r.stdout || r.error && r.error.message || '').trim() || 'non-zero exit'));
      }
    }

    process.exitCode = (opts.strict && result.passed < 6) ? 1 : 0;
  };
  try { main(); } catch (e) { console.error('forge-promptcheck: ' + e.message); process.exitCode = 1; }
}
