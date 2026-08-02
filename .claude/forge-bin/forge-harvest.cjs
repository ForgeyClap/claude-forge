#!/usr/bin/env node
'use strict';
/**
 * forge-harvest.cjs — READ-ONLY cross-project learning harvester (2026-07-18, post-WAVE-E). Zero-
 * dependency (fs/path/crypto only, plus the sibling forge-store.cjs, forge-memory.cjs, forge-consolidate.cjs
 * modules — this file NEVER reimplements secret redaction, the lesson-store shape, or the canonical-quote
 * guard; it composes the ones that already exist and are already tested).
 *
 * PURPOSE: let Forge literally learn ACROSS projects. Each Forge project already keeps its own local
 * `.claude/FORGE_*.md` memory files (decisions, task history, agent ledger, status notes). This tool reads
 * those files from OTHER Forge projects (never writes to them), pulls out real, already-written lines as
 * canonical lesson-quotes, and stores them in THIS project's reserved `global` lesson namespace — the exact
 * namespace forge-recall.cjs::recall() always blends into every dispatch, regardless of which Boss is being
 * recalled from. A lesson recorded once in project A can then surface as advisory guidance in project B.
 *
 * WHAT "LEARNING" ACTUALLY MEANS HERE (read before trusting a number): this tool captures LOGGED, ALREADY-
 * WRITTEN evidence — a decision-log row, a "what worked" bullet, a recurring owner-ask already typed into
 * FORGE_MEMORY.md/FORGE_DECISIONS.md/etc by a past run. It is NOT a summarizer, NOT an LLM, and NOT a
 * judge of what "worked" beyond what a human/agent already wrote down as a real line of text. A project
 * that did real work but never wrote it into its FORGE_*.md files yields ZERO lessons from that work —
 * un-recorded history is invisible to this tool by design (the honesty core forbids inferring a lesson
 * that was never actually written).
 *
 * ══════════════════════════ HARD GUARDRAILS (every one of these is load-bearing) ══════════════════════════
 * 1. READ-ONLY ON OTHER PROJECTS. discover()/harvestProject() only ever call fs.readFileSync/fs.statSync/
 *    fs.readdirSync against a discovered project's OWN directory tree. The only fs WRITE call in this
 *    entire module (mkdirSync/writeFileSync/appendFileSync, all via forge-consolidate.cjs's readStore/
 *    writeStore helpers) targets exactly ONE path: the resolved global lesson store (opts.globalStore, or
 *    its default under THIS project's own `.claude/agent-memory/global/lessons.jsonl`). No function in this
 *    file ever builds a write path from a discovered project's directory.
 * 2. SECRETS/PII EXCLUDED. isForbiddenFilename() refuses to open any file named .env / .env.* / *.key /
 *    *.pem / *secret* / *credential* / id_rsa* — checked before every fs.readFileSync call, even though the
 *    fixed MARKER_FILES allow-list never names one of these (defense in depth, not decoration). Every line
 *    of text that IS read is redacted with memory.scrub() (forge-store.cjs's SECRET_PATTERNS + forge-
 *    memory.cjs's own extra SECRET_RE list — the SAME reused detectors forge-doctor.cjs's leak scan is
 *    built from) before it can become a lesson candidate; stillLeaking() then re-checks the REDACTED text
 *    against both pattern sets and DROPS the candidate outright if a secret-shaped token still remains.
 * 3. EVIDENCED-ONLY (honesty core / CLAIM=PROOF). A harvested lesson's `text` is the trimmed, VERBATIM
 *    source line — never synthesised, never summarised into a new claim. Every lesson also carries `ts` +
 *    `evidence` (a JSON string with a real, non-empty `run_id`) so it passes forge-consolidate.cjs's own
 *    validateCanonical() unchanged — the SAME guard the rest of Forge's learning engine (forge-reinforce,
 *    forge-recall) already trusts. filterCanonical() runs every produced lesson through that exact function;
 *    anything that somehow fails it is rejected and counted under `skipped_syntheticjunk`, never written.
 * 4. EXPLICIT DISCOVERY ONLY. discover() never walks the filesystem beyond what the caller explicitly asked
 *    for: either an explicit `opts.projects` list, or an explicit `opts.scanDir` whose IMMEDIATE child
 *    directories (one level, never recursive) are checked for a `.claude/FORGE_*` marker file. Calling with
 *    neither yields an honest empty result (0 projects, a clear note) — never a silent whole-disk scan.
 * 5. GLOBAL NAMESPACE OUTPUT ONLY. Every harvested lesson is tagged `cross_project:true` + `source_project`
 *    and is written ONLY into the reserved `global` namespace (forge-recall.cjs::GLOBAL_NAMESPACE) of the
 *    CURRENT project running this tool — never into any individual harvested project, and never into a
 *    per-Boss namespace.
 *
 * MODULE API:
 *   discover(opts) -> [{project, path}]
 *   harvestProject({project, path}, opts) -> [lesson, ...]   (documented single-project extraction step)
 *   filterCanonical(lessons) -> { accepted:[...], rejected:[{id, reason}, ...] }  (reuses forge-consolidate)
 *   harvest(opts) -> { projects_scanned, lessons_found, lessons_stored, skipped_secret, skipped_syntheticjunk,
 *     would_store, global_store, global_namespace, projects:[{project, path, candidates, lessons}], dry_run,
 *     notes:[...] }
 *   opts.projects (string[]) / opts.scanDir (string) — discovery source (guardrail 4).
 *   opts.globalStore — override the global lesson-store file path (hermetic-test seam; production default is
 *     `<root>/.claude/agent-memory/global/lessons.jsonl`, the exact path forge-recall.cjs already reads).
 *   opts.root — project root override (mirrors forge-memory.cjs/forge-recall.cjs's FORGE_PROJECT_ROOT idea).
 *   opts.dryRun — evaluate the full pipeline (discover -> extract -> redact -> validate -> dedupe) but never
 *     call writeStore(); `would_store` reports what a real run would have added.
 *
 * CLI:
 *   node forge-harvest.cjs --scan <dir> [--global-store <file>] [--dry-run] [--json]
 *   node forge-harvest.cjs --projects <a,b,...> [--global-store <file>] [--dry-run] [--json]
 * Exit codes: 0 = ran (an honestly-empty harvest, including "neither --scan nor --projects given", is still
 * success, never an error) · 2 = usage error (a flag given with no value) or a genuine runtime error.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./forge-store.cjs');
const memory = require('./forge-memory.cjs');
const consolidateModule = require('./forge-consolidate.cjs');

const PROJECT_ROOT = process.env.FORGE_PROJECT_ROOT ? path.resolve(process.env.FORGE_PROJECT_ROOT) : path.resolve(__dirname, '..', '..');
const GLOBAL_NAMESPACE = 'global'; // MUST match forge-recall.cjs::GLOBAL_NAMESPACE — this is the reserved namespace every dispatch blends in.
const MARKER_FILES = ['FORGE_MEMORY.md', 'FORGE_TASK_HISTORY.md', 'FORGE_DECISIONS.md', 'FORGE_AGENT_LEDGER.md', 'FORGE_PROJECT_PROFILE.md'];
const MIN_QUOTE_LEN = 15; // filters pure markdown noise (empty checkboxes, bare "- ", a lone table pipe)
const DATE_RE = /\b(20\d{2}-\d{2}-\d{2})\b/;

// ---- guardrail 2: never open a secret-shaped filename, ever, regardless of caller ----
function isForbiddenFilename(name) {
  const base = String(name || '');
  if (/^\.env(\.|$)/i.test(base)) return true;
  if (/\.key$/i.test(base)) return true;
  if (/\.pem$/i.test(base)) return true;
  if (/secret/i.test(base)) return true;
  if (/credential/i.test(base)) return true;
  if (/^id_rsa/i.test(base)) return true;
  return false;
}

// ---- guardrail 4: explicit discovery only ----
/** isMarkedProjectDir(dir) -> true when dir/.claude/ contains at least one FORGE_*-named entry. A pure
 *  existence check, never opens/reads the file — discovery only decides WHICH directories are eligible. */
function isMarkedProjectDir(dir) {
  let entries;
  try { entries = fs.readdirSync(path.join(dir, '.claude')); } catch { return false; }
  return entries.some((f) => /^FORGE_/.test(f));
}
/** discover(opts) -> [{project, path}]. Only ever consults opts.projects (explicit list) or opts.scanDir's
 *  IMMEDIATE children (one level, never recursive) — see file header guardrail 4. Neither given -> []. */
function discover(opts) {
  opts = opts || {};
  const results = [];
  if (Array.isArray(opts.projects) && opts.projects.length) {
    for (const p of opts.projects) {
      const abs = path.resolve(String(p));
      if (isMarkedProjectDir(abs)) results.push({ project: path.basename(abs), path: abs });
    }
    return results;
  }
  if (opts.scanDir) {
    const scanRoot = path.resolve(String(opts.scanDir));
    let entries;
    try { entries = fs.readdirSync(scanRoot, { withFileTypes: true }); } catch { return []; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const abs = path.join(scanRoot, e.name);
      if (isMarkedProjectDir(abs)) results.push({ project: e.name, path: abs });
    }
    return results;
  }
  return [];
}

// ---- per-project, read-only file access (fixed 5-file allow-list only — see MARKER_FILES) ----
/** readMarkerFile(projectPath, filename) -> {text, mtimeIso} | null. Only ever reads a name from the fixed
 *  MARKER_FILES allow-list, and only after isForbiddenFilename() clears it (belt-and-suspenders — see
 *  guardrail 2). Missing/unreadable/not-a-file -> null, skipped honestly, never guessed. */
function readMarkerFile(projectPath, filename) {
  if (!MARKER_FILES.includes(filename)) return null;
  if (isForbiddenFilename(filename)) return null;
  const abs = path.join(projectPath, '.claude', filename);
  let st;
  try { st = fs.statSync(abs); } catch { return null; }
  if (!st.isFile()) return null;
  try { return { text: fs.readFileSync(abs, 'utf8'), mtimeIso: st.mtime.toISOString() }; }
  catch { return null; }
}

// ---- candidate-line extraction: only real, already-written source lines count (guardrail 3) ----
/** isCandidateLine(rawLine) -> true for a bullet (`- `/`* `), a numbered item (`1. `), or a markdown table
 *  data row (`| ... |`, not the `|---|` separator) carrying real substance. Headings/prose/blank lines are
 *  intentionally excluded — decisions/what-worked notes/owner-asks in these 5 files are written as bullets
 *  or table rows, not as free prose, so this stays a mechanical (never inferred) selection. */
function isCandidateLine(rawLine) {
  const t = String(rawLine == null ? '' : rawLine).trim();
  if (!t) return false;
  if (/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(t)) return false; // markdown table separator row
  const isBullet = /^[-*]\s+\S/.test(t);
  const isNumbered = /^\d+\.\s+\S/.test(t);
  const isTableRow = /^\|.*\|$/.test(t) && t.replace(/\|/g, '').trim().length > 0;
  if (!isBullet && !isNumbered && !isTableRow) return false;
  const stripped = t.replace(/^[-*]\s*(\[[ xX]\]\s*)?/, '').replace(/^\d+\.\s*/, '').replace(/^\|/, '').replace(/\|$/, '').trim();
  return stripped.length >= MIN_QUOTE_LEN;
}
/** extractCandidates(fileText, sourceFile, fallbackTs) -> [{text, sourceFile, line, ts}, ...]. `text` is
 *  the trimmed VERBATIM source line (never rewritten/summarised). `ts` prefers a real YYYY-MM-DD found in
 *  the line itself; otherwise falls back to the file's own mtime — both are real, never fabricated. */
function extractCandidates(fileText, sourceFile, fallbackTs) {
  const lines = String(fileText == null ? '' : fileText).split(/\r?\n/);
  const out = [];
  lines.forEach((raw, idx) => {
    if (!isCandidateLine(raw)) return;
    const text = raw.trim();
    const m = text.match(DATE_RE);
    const ts = m ? new Date(m[1] + 'T00:00:00.000Z').toISOString() : fallbackTs;
    out.push({ text, sourceFile, line: idx + 1, ts });
  });
  return out;
}

// ---- guardrail 2: redact, then verify, then drop if anything secret-shaped survives ----
/** stillLeaking(text) -> true if a KNOWN secret pattern (forge-store's SECRET_PATTERNS, the same set
 *  forge-doctor.cjs's leak scan is derived from, plus forge-memory's own extra SECRET_RE list) still
 *  matches AFTER redaction — i.e. redaction failed for this text. Defense-in-depth: memory.scrub() should
 *  already have removed every one of these, so a true hit here means "do not trust this text at all". */
function stillLeaking(text) {
  const s = String(text == null ? '' : text);
  for (const re of store.SECRET_PATTERNS) { re.lastIndex = 0; if (re.test(s)) return true; }
  if (Array.isArray(memory.SECRET_RE)) { for (const re of memory.SECRET_RE) { re.lastIndex = 0; if (re.test(s)) return true; } }
  return false;
}
/** redactCandidate(candidate) -> candidate with redacted text, or null when DROPPED (secret-shaped token
 *  survived redaction — guardrail 2's hard "never a leaking lesson" rule). Reuses memory.scrub(), the exact
 *  redaction every forge-distill.cjs-written lesson already goes through — never a second, weaker scrubber. */
function redactCandidate(candidate) {
  const redactedText = memory.scrub(candidate.text);
  if (stillLeaking(redactedText)) return null;
  return Object.assign({}, candidate, { text: redactedText });
}

function slugify(name) {
  return String(name == null ? '' : name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'unknown';
}

/** buildLessonRecord(projectSlug, candidate) -> a canonical lesson record shaped exactly like
 *  forge-memory.cjs::addLesson()'s output PLUS forge-reinforce.cjs's housekeeping fields (utility/uses/
 *  reinforced_by), so it drops straight into the same lessons.jsonl store forge-consolidate/forge-reinforce/
 *  forge-recall already operate on. evidence.run_id is a real, traceable, non-empty pointer back to the
 *  exact quoted source line (project/file/line) — it is NOT a fabricated Forge run id, and it is never
 *  claimed to be one; it exists solely so forge-consolidate.cjs::validateCanonical() (guardrail 3's guard)
 *  has real evidence to check, exactly as it already requires for every other lesson in the system. */
function buildLessonRecord(projectSlug, candidate) {
  const runId = 'harvest:' + projectSlug + ':' + candidate.sourceFile + ':' + candidate.line;
  const evidence = JSON.stringify({
    run_id: runId, ts: candidate.ts, event_type: 'cross_project_harvest',
    project: projectSlug, source_file: candidate.sourceFile, line: candidate.line,
  });
  const id = crypto.createHash('sha1').update('harvest' + candidate.text + candidate.ts + runId).digest('hex').slice(0, 12);
  return {
    id, type: 'semantic',
    tags: Array.from(new Set(['cross_project', projectSlug, candidate.sourceFile.toLowerCase().replace(/\.md$/, '')])).slice(0, 12),
    text: candidate.text, evidence, ts: candidate.ts,
    cross_project: true, source_project: projectSlug, source_file: candidate.sourceFile, line: candidate.line,
    utility: 0, uses: 0, reinforced_by: [],
  };
}

/** harvestProjectDetailed(entry, opts) -> {lessons, candidatesSeen, secretDropped}. Internal helper that
 *  gives harvest() the drop-reason accounting the documented harvestProject() API intentionally does not
 *  expose (it returns a bare lesson array per the module contract). Read-only: only ever calls
 *  readMarkerFile() against entry.path — never writes anything (guardrail 1). */
function harvestProjectDetailed(entry) {
  const projectSlug = slugify(entry.project);
  const lessons = [];
  let candidatesSeen = 0, secretDropped = 0;
  for (const filename of MARKER_FILES) {
    const file = readMarkerFile(entry.path, filename);
    if (!file) continue; // missing/unreadable — skipped honestly, never guessed or synthesised
    for (const candidate of extractCandidates(file.text, filename, file.mtimeIso)) {
      candidatesSeen++;
      const redacted = redactCandidate(candidate);
      if (!redacted) { secretDropped++; continue; }
      lessons.push(buildLessonRecord(projectSlug, redacted));
    }
  }
  return { lessons, candidatesSeen, secretDropped };
}
/** harvestProject({project, path}, opts) -> [lesson, ...] — the documented module API (see file header).
 *  Pure read + transform; never touches disk beyond reading the 5 MARKER_FILES under entry.path. */
function harvestProject(entry, opts) { // eslint-disable-line no-unused-vars -- opts kept for API symmetry/future use
  return harvestProjectDetailed(entry).lessons;
}

/** filterCanonical(lessons) -> {accepted, rejected}. Reuses forge-consolidate.cjs::validateCanonical()
 *  UNCHANGED (guardrail 3) — a lesson missing real text/ts/evidence.run_id is rejected here by the exact
 *  same guard the rest of Forge's learning engine already trusts, never a locally reimplemented check. */
function filterCanonical(lessons) {
  const accepted = [];
  const rejected = [];
  for (const l of lessons || []) {
    const v = consolidateModule.validateCanonical(l);
    if (v.ok) accepted.push(l);
    else rejected.push({ id: l && l.id, reason: v.reason });
  }
  return { accepted, rejected };
}

function defaultGlobalStorePath(root) { return path.join(root, '.claude', 'agent-memory', GLOBAL_NAMESPACE, 'lessons.jsonl'); }

/** harvest(opts) -> summary — see file header MODULE API for the full contract. The ONLY write this
 *  function ever performs is consolidateModule.writeStore(globalStorePath, ...) — see guardrail 1. */
function harvest(opts) {
  opts = opts || {};
  const root = opts.root || PROJECT_ROOT;
  const globalStorePath = opts.globalStore || defaultGlobalStorePath(root);
  const discovered = discover(opts);
  const notes = [];
  const hadExplicitSource = (Array.isArray(opts.projects) && opts.projects.length) || !!opts.scanDir;
  if (!discovered.length) {
    notes.push(hadExplicitSource
      ? 'discovery ran but found 0 marked projects (no candidate carried a .claude/FORGE_* marker, or none of the named --projects were found)'
      : 'no --scan/--projects (opts.scanDir/opts.projects) provided — explicit discovery is required by design; nothing harvested');
  }

  let lessonsFound = 0, skippedSecret = 0, skippedSyntheticJunk = 0;
  const canonicalLessons = [];
  const perProject = [];
  for (const entry of discovered) {
    const { lessons, candidatesSeen, secretDropped } = harvestProjectDetailed(entry);
    lessonsFound += lessons.length;
    skippedSecret += secretDropped;
    const { accepted, rejected } = filterCanonical(lessons);
    skippedSyntheticJunk += rejected.length;
    canonicalLessons.push(...accepted);
    perProject.push({ project: entry.project, path: entry.path, candidates: candidatesSeen, lessons: lessons.length, accepted: accepted.length });
  }
  notes.push('projects harvested: ' + (perProject.length ? perProject.map((p) => p.project).join(', ') : '(none)'));

  const existing = consolidateModule.readStore(globalStorePath);
  const seenKeys = new Set(existing.map((r) => consolidateModule.mergeKey(r)));
  const toWrite = existing.slice();
  let wouldStore = 0;
  for (const lesson of canonicalLessons) {
    const key = consolidateModule.mergeKey(lesson);
    if (seenKeys.has(key)) continue; // already known (this run or a prior harvest) — dedupe, never grow unbounded
    seenKeys.add(key);
    toWrite.push(lesson);
    wouldStore++;
  }

  if (!opts.dryRun && wouldStore > 0) consolidateModule.writeStore(globalStorePath, toWrite);

  return {
    projects_scanned: discovered.length,
    lessons_found: lessonsFound,
    lessons_stored: opts.dryRun ? 0 : wouldStore,
    skipped_secret: skippedSecret,
    skipped_syntheticjunk: skippedSyntheticJunk,
    would_store: wouldStore,
    global_store: globalStorePath,
    global_namespace: GLOBAL_NAMESPACE,
    projects: perProject,
    dry_run: !!opts.dryRun,
    notes,
  };
}

module.exports = {
  discover, harvestProject, filterCanonical, harvest,
  isForbiddenFilename, isMarkedProjectDir, isCandidateLine, extractCandidates, redactCandidate, stillLeaking,
  buildLessonRecord, slugify, defaultGlobalStorePath,
  MARKER_FILES, GLOBAL_NAMESPACE, MIN_QUOTE_LEN,
};

// ---- CLI ----
function parseArgs(argv) {
  const opts = { scanDir: null, projects: null, globalStore: null, dryRun: false, json: false, help: false, usageError: null };
  // note: every branch below only ever SETS opts.usageError when it isn't already set (`opts.usageError ||`
  // -style guard via `!opts.usageError &&`), so the FIRST usage problem encountered is what gets reported —
  // a caller passing several bad tokens gets an actionable, stable message instead of whichever one happened
  // to be parsed last.
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--scan') { opts.scanDir = argv[++i]; if ((!opts.scanDir || opts.scanDir.startsWith('--')) && !opts.usageError) opts.usageError = '--scan requires a <dir>'; }
    else if (a === '--projects') {
      const raw = argv[++i];
      if (!raw || raw.startsWith('--')) { if (!opts.usageError) opts.usageError = '--projects requires a comma-separated list'; }
      else opts.projects = raw.split(',').map((s) => s.trim()).filter(Boolean);
    }
    else if (a === '--global-store') { opts.globalStore = argv[++i]; if ((!opts.globalStore || opts.globalStore.startsWith('--')) && !opts.usageError) opts.usageError = '--global-store requires a <file>'; }
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (!opts.usageError) opts.usageError = 'unknown argument: ' + a;
  }
  return opts;
}
function printUsage() {
  console.error('Usage: node forge-harvest.cjs --scan <dir> [--global-store <file>] [--dry-run] [--json]');
  console.error('       node forge-harvest.cjs --projects <a,b,...> [--global-store <file>] [--dry-run] [--json]');
}
function printSummary(result) {
  const lines = [];
  lines.push('forge-harvest' + (result.dry_run ? ' (dry-run)' : ''));
  lines.push('  projects scanned: ' + result.projects_scanned + '  lessons found: ' + result.lessons_found);
  lines.push('  ' + (result.dry_run ? 'would store: ' + result.would_store : 'stored: ' + result.lessons_stored) +
    '  skipped (secret): ' + result.skipped_secret + '  skipped (non-canonical): ' + result.skipped_syntheticjunk);
  lines.push('  global store: ' + result.global_store + '  namespace: ' + result.global_namespace);
  for (const p of result.projects) lines.push('  - ' + p.project + ': ' + p.candidates + ' candidate(s) -> ' + p.lessons + ' lesson(s) (' + p.accepted + ' canonical)');
  for (const n of result.notes) lines.push('  ' + n);
  return lines.join('\n');
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { printUsage(); process.exitCode = 0; }
  else if (opts.usageError) { console.error('forge-harvest: ' + opts.usageError); printUsage(); process.exitCode = 2; }
  else {
    try {
      const result = harvest({ scanDir: opts.scanDir, projects: opts.projects, globalStore: opts.globalStore, dryRun: opts.dryRun, root: PROJECT_ROOT });
      if (opts.json) console.log(JSON.stringify(result));
      else console.log(printSummary(result));
      process.exitCode = 0;
    } catch (e) {
      console.error('forge-harvest: ' + e.message);
      process.exitCode = 2;
    }
  }
}
