#!/usr/bin/env node
'use strict';
/**
 * forge-secret-scrub.cjs — ADVISORY secret/PII scanner for RUNTIME artifacts (2026-07-24). Zero-dependency,
 * Windows-safe. Reuses the SINGLE source of truth for secret patterns — forge-store.cjs's hardened
 * SECRET_PATTERNS (the exact set forge-doctor's leak-scan already trusts) — so there is only ever one
 * pattern list to maintain, never a drifting copy.
 *
 * WHY it is NOT redundant with forge-doctor's leak scan: the doctor scans git-TRACKED source files. This
 * scans RUNTIME artifacts, most notably `.claude/forge-runs/<id>/events.jsonl` — deliberately NOT
 * git-tracked (see .gitignore's forge-runs ignore rule; NOTE: never write a literal "star-slash" glob
 * inside this block comment — it closes the comment early and breaks the file) and therefore never
 * reached by that scan, where a leaked key or token could quietly accumulate across runs.
 * CORRECTION (2026-07-26, wp7 triage):
 * an earlier version of this comment also claimed the `.claude/FORGE_*.md` memory files were "deliberately
 * NOT git-tracked" — that was wrong. Those files ARE git-tracked (no .gitignore rule covers them) and are
 * therefore already covered by the doctor's leak scan; scanning them here is redundant belt-and-suspenders,
 * not the genuine gap. `events.jsonl` is the one real, uncovered target this tool exists for.
 *
 * SECURITY / HONESTY: it reports ONLY the location — { file, line, pattern } — and NEVER the matched secret
 * text (identical discipline to the doctor's leakScan). Per-line scanning (ReDoS-hardened, mirrors the
 * doctor's per-regel approach). It is ADVISORY (scan-and-report) — it changes NOTHING and blocks NOTHING,
 * consistent with Forge's security-light "no mandatory gates" posture. An owner who wants it to fire on every
 * write can wire it as an opt-in PostToolUse hook — see config/orchestration/HOOKS_OPT_IN.md (shipped
 * DISABLED). The non-zero exit on findings is only so such an opt-in hook COULD gate on it if the owner chooses.
 *
 * MODEL (pure scanners are testable without the real project):
 *   scanText(text, label)     -> [{ file:label, line, pattern }]   (pattern = "secret-pattern#<i>", never the secret)
 *   scanFile(file, label?)    -> hits[] for one file (unreadable file -> [])
 *   defaultTargets()          -> runtime artifacts to scan (events.jsonl across runs + memory files)
 *   scan(files?)              -> { scanned, hits, clean }          (files omitted -> defaultTargets())
 *
 * CLI (exit: 0 = clean · 3 = finding(s) — advisory, never a hard block · 2 = usage):
 *   node forge-secret-scrub.cjs [file ...] [--json]     (no files -> scan runtime artifacts by default)
 */
const fs = require('fs');
const path = require('path');
const store = require('./forge-store.cjs');

const PATTERNS = Array.isArray(store.SECRET_PATTERNS) ? store.SECRET_PATTERNS : [];
const PROJECT_ROOT = process.env.FORGE_PROJECT_ROOT ? path.resolve(process.env.FORGE_PROJECT_ROOT) : path.resolve(__dirname, '..', '..');
const CLAUDE_DIR = path.join(PROJECT_ROOT, '.claude');
const RUNS_DIR = path.join(CLAUDE_DIR, 'forge-runs');
const MEMORY_FILES = ['FORGE_MEMORY.md', 'FORGE_DECISIONS.md', 'FORGE_TASK_HISTORY.md', 'FORGE_AGENT_LEDGER.md', 'FORGE_PROJECT_PROFILE.md'];

// Detect a hit WITHOUT ever capturing/returning the secret. Per-line so a huge file can't ReDoS on one regex,
// and .match() (not .test()) so the shared /g patterns' lastIndex state can never bleed across calls.
function lineHasPattern(line, re) { try { return !!String(line).match(re); } catch { return false; } }

function scanText(text, label) {
  const hits = [];
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (let p = 0; p < PATTERNS.length; p++) {
      if (lineHasPattern(lines[i], PATTERNS[p])) hits.push({ file: label, line: i + 1, pattern: 'secret-pattern#' + p });
    }
  }
  return hits;
}

function scanFile(file, label) {
  let raw; try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  return scanText(raw, label || file);
}

function defaultTargets() {
  const targets = [];
  try {
    for (const d of fs.readdirSync(RUNS_DIR, { withFileTypes: true })) {
      if (d.isDirectory()) { const p = path.join(RUNS_DIR, d.name, 'events.jsonl'); if (fs.existsSync(p)) targets.push(p); }
    }
  } catch {}
  for (const m of MEMORY_FILES) { const p = path.join(CLAUDE_DIR, m); if (fs.existsSync(p)) targets.push(p); }
  return targets;
}

function scan(files) {
  const list = (Array.isArray(files) && files.length) ? files : defaultTargets();
  let hits = [];
  for (const f of list) hits = hits.concat(scanFile(f));
  return { scanned: list.length, hits, clean: hits.length === 0 };
}

module.exports = { scanText, scanFile, scan, defaultTargets, PATTERN_COUNT: PATTERNS.length };

if (require.main === module) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const files = args.filter((a) => !a.startsWith('--'));
  const r = scan(files);
  if (json) { console.log(JSON.stringify(r, null, 2)); }
  else {
    console.log('forge-secret-scrub (advisory) · scanned ' + r.scanned + ' runtime artifact(s) · ' + (r.clean ? 'CLEAN' : r.hits.length + ' finding(s)'));
    // location only — never the secret
    r.hits.slice(0, 50).forEach((h) => console.log('  ⚠ ' + h.pattern + ' in ' + h.file + ':' + h.line));
    if (r.hits.length > 50) console.log('  … ' + (r.hits.length - 50) + ' more');
    if (!r.clean) console.log('  (advisory only — nothing was blocked or modified; rotate any real exposed secret)');
  }
  process.exit(r.clean ? 0 : 3);
}
