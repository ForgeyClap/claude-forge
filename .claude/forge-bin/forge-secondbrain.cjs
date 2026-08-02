#!/usr/bin/env node
'use strict';
/**
 * forge-secondbrain.cjs — Forge SECOND BRAIN: a READ-ONLY, EVIDENCE-CITED portfolio strategist across the
 * owner's Forge projects (2026-07-19, PIECE J3). Zero-dependency (fs/path/child_process only, plus the
 * sibling forge-harvest.cjs module — this file NEVER reimplements discovery or the secret-excluded-filename
 * guard; it reuses forge-harvest's already-tested ones, same "compose, don't duplicate" rule forge-harvest
 * itself follows for forge-store.cjs/forge-memory.cjs/forge-consolidate.cjs).
 *
 * PURPOSE: proactively surface portfolio-level facts the owner would otherwise have to notice by hand —
 * "project X has a committed .env", "project Y's doctor run is failing", "projects A and B share half their
 * dependencies" — as a weekly strategy digest. This is NOT an LLM summarizer and NOT a guess generator:
 * every single recommendation in the digest is backed by a real, cited {project, file, fact} triple pointing
 * at something this tool actually read off disk. A signal with no real citation is dropped, never invented
 * (the exact CLAIM=PROOF discipline forge-harvest's "verbatim source line only" rule already embodies).
 *
 * ══════════════════════════ HARD GUARDRAILS (every one of these is load-bearing) ══════════════════════════
 * 1. READ-ONLY ON EVERY SCANNED PROJECT. Every function in this module only ever calls fs.readdirSync/
 *    fs.statSync/fs.readFileSync/spawnSync('git', ['ls-files', ...]) against a discovered project's OWN
 *    directory tree. There is NOT ONE fs.writeFileSync/appendFileSync/mkdirSync/rmSync call anywhere in this
 *    file — unlike forge-harvest.cjs (which writes into ITS OWN project's global lesson store), the second
 *    brain writes nothing at all, anywhere, ever. scan()/report() are pure read -> transform.
 * 2. NEVER OPENS A SECRET FILE'S CONTENTS. A `.env`'s existence is checked with fs.existsSync + (if git is
 *    available) `git ls-files` to learn whether it is TRACKED — its contents are never passed to
 *    fs.readFileSync. Every other file this tool DOES read (package.json, doctor.json, run.json, and mtime-
 *    only checks on FORGE_MEMORY.md) is first checked against the reused forge-harvest.cjs::isForbiddenFilename()
 *    guard (defense-in-depth: none of these names ever match it, but every read in this file goes through
 *    the same reused gate forge-harvest already trusts, rather than a second, parallel judgment call).
 * 3. EXPLICIT DISCOVERY ONLY, REUSED VERBATIM. discoverProjects() is a direct passthrough to
 *    forge-harvest.cjs::discover() — the exact same explicit `opts.projects` / one-level `opts.scanDir`
 *    marker-gated discovery forge-harvest already ships and is already tested. Calling with neither yields
 *    an honest empty result, never a silent whole-disk scan.
 * 4. EVIDENCE-GATED OUTPUT (honesty core / CLAIM=PROOF). Every finding this module produces carries an
 *    `evidence: {project, file, fact}` triple built from something real: a `git ls-files` result, an
 *    fs.statSync mtime, or a parsed JSON field this tool actually read. report() runs EVERY finding through
 *    hasRealEvidence() before it can become a "recommendation" — a finding missing any of project/file/fact
 *    (a non-empty string) is silently dropped and counted under `dropped_unevidenced`, never surfaced. This
 *    holds even when report() is called directly with a hand-built (not scan()-produced) array, which is
 *    exactly what the mutation-verification test below proves.
 *
 * MODULE API:
 *   discoverProjects(opts) -> [{project, path}]                          (passthrough to forge-harvest.discover)
 *   checkEnvSignals(entry) -> [finding, ...]                              (committed .env / missing .env.example)
 *   checkStaleDependencies(entry, opts) -> [finding, ...]                 (package.json mtime age hint)
 *   checkDoctorReceipt(entry) -> [finding, ...]                          (most-recent forge-runs/<run>/doctor.json ok:false)
 *   checkMemoryStaleness(entry, opts) -> [finding, ...]                   (FORGE_MEMORY.md mtime age hint)
 *   crossProjectOverlaps(discovered, opts) -> [finding, ...]              (shared package.json dependency names)
 *   scan(opts) -> { projects_scanned, projects:[{project, path, findings:[...]}], overlaps:[...], notes:[...] }
 *   hasRealEvidence(finding) -> boolean                                   (the evidence-gating predicate, exported for direct testing)
 *   buildRecommendations(findings) -> { accepted:[...], dropped:[...] }
 *   report(scanResultOrFindings, opts) -> { generated_at, projects_scanned, recommendations:[...], dropped_unevidenced }
 *   formatReport(reportResult) -> string   (human-readable digest for the CLI)
 *   opts.projects / opts.scanDir — discovery source, same contract as forge-harvest.cjs (guardrail 3).
 *   opts.staleDependencyDays (default 180), opts.staleMemoryDays (default 90), opts.overlapMinShared
 *     (default 3), opts.now (ms epoch override — hermetic-test seam).
 *
 * CLI:
 *   node forge-secondbrain.cjs scan --dir <dir> [--json]
 *   node forge-secondbrain.cjs report --dir <dir> [--json]
 * (--projects <a,b,...> also accepted as an explicit-list alternative to --dir, mirroring forge-harvest.cjs.)
 * Exit codes: 0 = ran (an honestly-empty scan/report, including "neither --dir nor --projects given", is
 * still success, never an error) · 2 = usage error (a flag given with no value, or an unknown subcommand).
 *
 * EVENT LOGGING: this module does not call log-event.cjs itself (shared-file rule — a future integration
 * pass wires the CLI to log a real event). The event_type it needs registered in log-event.cjs's
 * KNOWN_EVENT_TYPES vocabulary is `portfolio_scanned`.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const harvestTool = require('./forge-harvest.cjs');

const DEFAULT_STALE_DEPENDENCY_DAYS = 180;
const DEFAULT_STALE_MEMORY_DAYS = 90;
const DEFAULT_OVERLAP_MIN_SHARED = 3;

// ---- guardrail 3: explicit discovery only, reused verbatim from forge-harvest.cjs ----
/** discoverProjects(opts) -> [{project, path}]. Pure passthrough — see file header guardrail 3. Never
 *  reimplements discovery; a change to forge-harvest's marker/one-level rules is inherited automatically. */
function discoverProjects(opts) { return harvestTool.discover(opts); }

function daysSince(mtimeMs, nowMs) { return Math.floor((nowMs - mtimeMs) / 86400000); }

// ---- 1) security-drift hint: a committed .env, or a .env with no .env.example placeholder ----
/** checkEnvSignals(entry) -> [finding, ...]. NEVER opens .env's contents (guardrail 2) — only checks
 *  existence (fs.existsSync) and, when git is available, whether it is TRACKED (`git ls-files`). A
 *  "committed" claim is only ever made when git actually confirms it; an untracked local .env is normal and
 *  produces no finding at all (never manufactured noise). */
function checkEnvSignals(entry) {
  const out = [];
  const envPath = path.join(entry.path, '.env');
  if (!fs.existsSync(envPath)) return out;

  const gls = spawnSync('git', ['-C', entry.path, 'ls-files', '.env'], { encoding: 'utf8' });
  const gitRan = !gls.error && gls.status === 0;
  const tracked = gitRan && /(^|\r?\n)\.env(\r?\n|$)/.test(gls.stdout || '');
  if (tracked) {
    out.push({
      type: 'env_committed',
      severity: 'high',
      project: entry.project,
      message: entry.project + ': a .env file is committed to git — rotate any real secrets in it and untrack it.',
      evidence: { project: entry.project, file: '.env', fact: 'git ls-files -C ' + entry.project + ' confirms .env is a tracked file' },
    });
  }

  const examplePath = path.join(entry.path, '.env.example');
  if (!fs.existsSync(examplePath)) {
    out.push({
      type: 'missing_env_example',
      severity: 'medium',
      project: entry.project,
      message: entry.project + ': has a .env file but no .env.example placeholder for onboarding.',
      evidence: { project: entry.project, file: '.env.example', fact: entry.project + ' has a .env file at its project root but no sibling .env.example' },
    });
  }
  return out;
}

// ---- 2) stale-dep hint: package.json hasn't changed in a long time ----
/** checkStaleDependencies(entry, opts) -> [finding, ...]. Evidence is package.json's own real mtime — never
 *  a guessed "last updated" date, never a fetched registry comparison. */
function checkStaleDependencies(entry, opts) {
  const out = [];
  const pkgPath = path.join(entry.path, 'package.json');
  if (harvestTool.isForbiddenFilename(path.basename(pkgPath))) return out; // defense-in-depth (never true here)
  let st;
  try { st = fs.statSync(pkgPath); } catch { return out; }
  if (!st.isFile()) return out;
  const thresholdDays = Number.isFinite(opts.staleDependencyDays) ? opts.staleDependencyDays : DEFAULT_STALE_DEPENDENCY_DAYS;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const ageDays = daysSince(st.mtimeMs, now);
  if (ageDays >= thresholdDays) {
    out.push({
      type: 'stale_dependencies_hint',
      severity: 'medium',
      project: entry.project,
      message: entry.project + ': package.json has not changed in ' + ageDays + ' days — dependencies may be stale, worth an audit.',
      evidence: { project: entry.project, file: 'package.json', fact: 'package.json mtime is ' + ageDays + ' days old (>= ' + thresholdDays + '-day staleness threshold)' },
    });
  }
  return out;
}

// ---- 3) doctor/test status, IF a forge-runs receipt exists (never fabricated when it doesn't) ----
/** checkDoctorReceipt(entry) -> [finding, ...]. Reads the MOST RECENT forge-runs/<run_id>/doctor.json (by
 *  real directory mtime, never by parsing/guessing a run-id naming convention). No receipt on disk -> no
 *  finding at all — this tool never claims doctor status it never actually observed. */
function checkDoctorReceipt(entry) {
  const out = [];
  const runsDir = path.join(entry.path, '.claude', 'forge-runs');
  let runDirs;
  try { runDirs = fs.readdirSync(runsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); }
  catch { return out; }
  if (!runDirs.length) return out;

  let latest = null, latestMtimeMs = -Infinity;
  for (const name of runDirs) {
    let st;
    try { st = fs.statSync(path.join(runsDir, name)); } catch { continue; }
    if (st.mtimeMs > latestMtimeMs) { latestMtimeMs = st.mtimeMs; latest = name; }
  }
  if (!latest) return out;

  const doctorPath = path.join(runsDir, latest, 'doctor.json');
  if (harvestTool.isForbiddenFilename(path.basename(doctorPath))) return out; // defense-in-depth (never true here)
  let raw;
  try { raw = fs.readFileSync(doctorPath, 'utf8'); } catch { return out; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return out; }

  if (parsed && parsed.ok === false) {
    out.push({
      type: 'doctor_failing',
      severity: 'high',
      project: entry.project,
      message: entry.project + ': the most recent doctor run (' + latest + ') reported ok:false.',
      evidence: { project: entry.project, file: '.claude/forge-runs/' + latest + '/doctor.json', fact: 'doctor.json for run "' + latest + '" has ok:false' },
    });
  }
  return out;
}

// ---- 4) memory staleness: FORGE_MEMORY.md hasn't been touched in a long time ----
/** checkMemoryStaleness(entry, opts) -> [finding, ...]. Content is never read (mtime-only) — a project that
 *  legitimately keeps a short, stable FORGE_MEMORY.md is not penalized for its length, only its recency. */
function checkMemoryStaleness(entry, opts) {
  const out = [];
  const memPath = path.join(entry.path, '.claude', 'FORGE_MEMORY.md');
  if (harvestTool.isForbiddenFilename(path.basename(memPath))) return out; // defense-in-depth (never true here)
  let st;
  try { st = fs.statSync(memPath); } catch { return out; }
  if (!st.isFile()) return out;
  const thresholdDays = Number.isFinite(opts.staleMemoryDays) ? opts.staleMemoryDays : DEFAULT_STALE_MEMORY_DAYS;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const ageDays = daysSince(st.mtimeMs, now);
  if (ageDays >= thresholdDays) {
    out.push({
      type: 'memory_stale',
      severity: 'low',
      project: entry.project,
      message: entry.project + ': FORGE_MEMORY.md has not been updated in ' + ageDays + ' days.',
      evidence: { project: entry.project, file: '.claude/FORGE_MEMORY.md', fact: 'FORGE_MEMORY.md mtime is ' + ageDays + ' days old (>= ' + thresholdDays + '-day staleness threshold)' },
    });
  }
  return out;
}

// ---- 5) "these two projects share X" — real cross-project overlap from package.json dependency names ----
/** readPackageDependencyNames(entry) -> string[] | null. Reads only the dependency/devDependency KEY names
 *  (never version strings, never scripts, never anything that could itself carry a secret-shaped value). */
function readPackageDependencyNames(entry) {
  const pkgPath = path.join(entry.path, 'package.json');
  if (harvestTool.isForbiddenFilename(path.basename(pkgPath))) return null; // defense-in-depth (never true here)
  let raw;
  try { raw = fs.readFileSync(pkgPath, 'utf8'); } catch { return null; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const names = new Set([
    ...Object.keys(parsed.dependencies || {}),
    ...Object.keys(parsed.devDependencies || {}),
  ]);
  return Array.from(names);
}

/** crossProjectOverlaps(discovered, opts) -> [finding, ...]. Compares every project PAIR's real
 *  dependency-name sets; a shared-count >= opts.overlapMinShared becomes a real, cited overlap finding
 *  (never a fabricated "these look similar" guess). */
function crossProjectOverlaps(discovered, opts) {
  const out = [];
  const minShared = Number.isFinite(opts.overlapMinShared) ? opts.overlapMinShared : DEFAULT_OVERLAP_MIN_SHARED;
  const depMap = new Map();
  for (const entry of discovered || []) {
    const names = readPackageDependencyNames(entry);
    if (names && names.length) depMap.set(entry.project, new Set(names));
  }
  const projects = Array.from(depMap.keys());
  for (let i = 0; i < projects.length; i++) {
    for (let j = i + 1; j < projects.length; j++) {
      const a = projects[i], b = projects[j];
      const shared = Array.from(depMap.get(a)).filter((d) => depMap.get(b).has(d)).sort();
      if (shared.length >= minShared) {
        out.push({
          type: 'cross_project_overlap',
          severity: 'info',
          projects: [a, b],
          shared_dependencies: shared,
          message: a + ' and ' + b + ' share ' + shared.length + ' dependencies (' + shared.slice(0, 5).join(', ') + (shared.length > 5 ? ', ...' : '') + ') — consider a shared internal package.',
          evidence: { project: a + ' + ' + b, file: 'package.json (both)', fact: a + ' and ' + b + ' both declare: ' + shared.join(', ') },
        });
      }
    }
  }
  return out;
}

// ---- scan(): orchestrates every check above, per discovered project, plus portfolio-level overlaps ----
/** scan(opts) -> see file header MODULE API. Pure read-only; never writes anything (guardrail 1). */
function scan(opts) {
  opts = opts || {};
  const discovered = discoverProjects(opts);
  const notes = [];
  const hadExplicitSource = (Array.isArray(opts.projects) && opts.projects.length) || !!opts.scanDir;
  if (!discovered.length) {
    notes.push(hadExplicitSource
      ? 'discovery ran but found 0 marked projects (no candidate carried a .claude/FORGE_* marker, or none of the named --projects were found)'
      : 'no --dir/--projects (opts.scanDir/opts.projects) provided — explicit discovery is required by design; nothing scanned');
  }

  const perProject = [];
  for (const entry of discovered) {
    const findings = []
      .concat(checkEnvSignals(entry))
      .concat(checkStaleDependencies(entry, opts))
      .concat(checkDoctorReceipt(entry))
      .concat(checkMemoryStaleness(entry, opts));
    perProject.push({ project: entry.project, path: entry.path, findings });
  }
  const overlaps = crossProjectOverlaps(discovered, opts);
  notes.push('projects scanned: ' + (perProject.length ? perProject.map((p) => p.project).join(', ') : '(none)'));

  return {
    projects_scanned: discovered.length,
    projects: perProject,
    overlaps,
    notes,
  };
}

// ---- guardrail 4: evidence-gating, applied at report() time regardless of where findings came from ----
/** hasRealEvidence(finding) -> true only when finding.evidence is a real, non-empty {project, file, fact}
 *  triple of strings. Exported standalone so a test can prove the gate directly against a hand-built
 *  (not scan()-produced) finding — the mutation-verification target for this whole module. */
function hasRealEvidence(finding) {
  const ev = finding && finding.evidence;
  if (!ev || typeof ev !== 'object') return false;
  return ['project', 'file', 'fact'].every((k) => typeof ev[k] === 'string' && ev[k].trim().length > 0);
}

/** buildRecommendations(findings) -> {accepted, dropped}. The single evidence-gating chokepoint report()
 *  runs every candidate finding through — see guardrail 4. */
function buildRecommendations(findings) {
  const accepted = [];
  const dropped = [];
  for (const f of findings || []) {
    if (hasRealEvidence(f)) accepted.push(f);
    else dropped.push(f);
  }
  return { accepted, dropped };
}

function flattenScanResult(scanResult) {
  if (Array.isArray(scanResult)) return scanResult;
  const out = [];
  for (const p of (scanResult && scanResult.projects) || []) out.push(...(p.findings || []));
  out.push(...((scanResult && scanResult.overlaps) || []));
  return out;
}

/** report(scanResultOrFindings, opts) -> weekly strategy digest. Accepts EITHER a scan() result object OR a
 *  flat array of finding-shaped objects (the latter is what the mutation test uses to prove the gate holds
 *  even outside the normal scan() -> report() pipeline). Every recommendation in the output carries the
 *  evidence it was built from; anything unevidenced is counted in `dropped_unevidenced` and never shown. */
function report(scanResultOrFindings, opts) {
  opts = opts || {};
  const findings = flattenScanResult(scanResultOrFindings);
  const { accepted, dropped } = buildRecommendations(findings);
  const generatedAt = Number.isFinite(opts.now) ? new Date(opts.now).toISOString() : new Date().toISOString();
  return {
    generated_at: generatedAt,
    projects_scanned: Array.isArray(scanResultOrFindings) ? null : ((scanResultOrFindings && scanResultOrFindings.projects_scanned) || 0),
    recommendations: accepted,
    dropped_unevidenced: dropped.length,
  };
}

function formatReport(result) {
  const lines = [];
  lines.push('Forge Second Brain — weekly strategy digest (' + result.generated_at + ')');
  if (!result.recommendations.length) lines.push('  no evidenced recommendations this run.');
  for (const r of result.recommendations) {
    lines.push('  - [' + (r.severity || 'info') + '] ' + r.message);
    lines.push('      evidence: ' + r.evidence.project + ' / ' + r.evidence.file + ' — ' + r.evidence.fact);
  }
  if (result.dropped_unevidenced) lines.push('  (' + result.dropped_unevidenced + ' unevidenced candidate(s) dropped, never shown)');
  return lines.join('\n');
}

module.exports = {
  discoverProjects, checkEnvSignals, checkStaleDependencies, checkDoctorReceipt, checkMemoryStaleness,
  readPackageDependencyNames, crossProjectOverlaps, scan,
  hasRealEvidence, buildRecommendations, flattenScanResult, report, formatReport,
  DEFAULT_STALE_DEPENDENCY_DAYS, DEFAULT_STALE_MEMORY_DAYS, DEFAULT_OVERLAP_MIN_SHARED,
};

// ---- CLI ----
function parseArgs(argv) {
  const first = argv[0] || null;
  const topLevelHelp = first === '--help' || first === '-h';
  const cmd = topLevelHelp ? null : first;
  const rest = argv.slice(1);
  const opts = { cmd, scanDir: null, projects: null, json: false, help: topLevelHelp, usageError: null };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--dir' || a === '--scan') { opts.scanDir = rest[++i]; if ((!opts.scanDir || opts.scanDir.startsWith('--')) && !opts.usageError) opts.usageError = a + ' requires a <dir>'; }
    else if (a === '--projects') {
      const raw = rest[++i];
      if (!raw || raw.startsWith('--')) { if (!opts.usageError) opts.usageError = '--projects requires a comma-separated list'; }
      else opts.projects = raw.split(',').map((s) => s.trim()).filter(Boolean);
    }
    else if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (!opts.usageError) opts.usageError = 'unknown argument: ' + a;
  }
  return opts;
}
function printUsage() {
  console.error('Usage: node forge-secondbrain.cjs scan --dir <dir> [--json]');
  console.error('       node forge-secondbrain.cjs report --dir <dir> [--json]');
  console.error('       (--projects <a,b,...> also accepted instead of --dir)');
}
function printScanSummary(result) {
  const lines = [];
  lines.push('forge-secondbrain scan');
  lines.push('  projects scanned: ' + result.projects_scanned);
  for (const p of result.projects) lines.push('  - ' + p.project + ': ' + p.findings.length + ' finding(s)');
  if (result.overlaps.length) lines.push('  overlaps: ' + result.overlaps.length);
  for (const n of result.notes) lines.push('  ' + n);
  return lines.join('\n');
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { printUsage(); process.exitCode = 0; }
  else if (opts.usageError) { console.error('forge-secondbrain: ' + opts.usageError); printUsage(); process.exitCode = 2; }
  else if (opts.cmd === 'scan') {
    try {
      const result = scan({ scanDir: opts.scanDir, projects: opts.projects });
      if (opts.json) console.log(JSON.stringify(result));
      else console.log(printScanSummary(result));
      process.exitCode = 0;
    } catch (e) {
      console.error('forge-secondbrain: ' + e.message);
      process.exitCode = 2;
    }
  } else if (opts.cmd === 'report') {
    try {
      const scanResult = scan({ scanDir: opts.scanDir, projects: opts.projects });
      const result = report(scanResult);
      if (opts.json) console.log(JSON.stringify(result));
      else console.log(formatReport(result));
      process.exitCode = 0;
    } catch (e) {
      console.error('forge-secondbrain: ' + e.message);
      process.exitCode = 2;
    }
  } else {
    printUsage();
    process.exitCode = 2;
  }
}
