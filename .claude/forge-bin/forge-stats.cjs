#!/usr/bin/env node
'use strict';
/**
 * forge-stats.cjs — zero-dependency, READ-ONLY run-outcome statistics projector (2026-07-12, WP2).
 *
 * Forge logs rich per-run events (.claude/forge-runs/&lt;run_id&gt;/events.jsonl) but nothing folds them
 * into outcomes. This walks EVERY run's events.jsonl, aggregates dispatches/completions/failures/rework/
 * gates per canonical Boss slug (config/agents/agent-registry.json — "Build Boss" and "build-boss" are
 * folded to ONE slug, since real history contains both forms) and per project_type x Boss, writes
 * .claude/forge-runs/STATS.json, prints a compact table, and emits ADVISORY routing hints.
 *
 * READ-ONLY GUARANTEE: the ONLY write this file ever performs is .claude/forge-runs/STATS.json (aggregate
 * numbers + Boss slugs + a sanitized project_type classifier — never raw event/note text). Every run's
 * events.jsonl and run.json are opened with fs.readFileSync only and are never modified, moved, or deleted.
 *
 * ADVISORY-ONLY: the printed/stored "ADVISORY:" lines are plain text observations for a human/Head Chef
 * to read. forge-stats NEVER edits agent-model-map.json, agent-registry.json, or any other config — it has
 * no write path to any file except STATS.json.
 *
 * Usage:
 *   node forge-stats.cjs [--json] [--no-write] [--threshold <pct>] [--min-samples <n>]
 *     --json           print the full stats object instead of the compact table
 *     --no-write       compute + print only; do not write STATS.json
 *     --threshold      rework-rate percent (per project_type x Boss) that triggers an advisory (default 30)
 *     --min-samples    minimum completed runs (per project_type x Boss) before an advisory can fire (default 3)
 *
 * FORGE_PROJECT_ROOT overrides the project root (test isolation); defaults to two levels up from this file
 * (.claude/forge-bin -> project root). Windows-safe (path.join/path.sep throughout, no shell assumptions).
 *
 * Exit codes: 0 = success (including the honest zero-runs case) · 1 = real error · 2 = usage error.
 */
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = process.env.FORGE_PROJECT_ROOT ? path.resolve(process.env.FORGE_PROJECT_ROOT) : path.resolve(__dirname, '..', '..');
const CLAUDE_DIR = path.join(PROJECT_ROOT, '.claude');
const RUNS_DIR = path.join(CLAUDE_DIR, 'forge-runs');
const REGISTRY_FILE = path.join(CLAUDE_DIR, 'config', 'agents', 'agent-registry.json');
const STATS_FILE = path.join(RUNS_DIR, 'STATS.json');

// Resiliency fallback ONLY — used when the real registry can't be read, so forge-stats still degrades
// gracefully instead of silently reporting zero Bosses. Keep in sync with agent-registry.json if a new
// permanent Boss is ever added there (this file never writes to that registry itself).
const FALLBACK_BOSSES = {
  boss: 'Boss', 'head-chef': 'Head Chef', 'review-boss': 'Review Boss', 'test-boss': 'Test Boss',
  'ui-boss': 'UI Boss', 'seo-boss': 'SEO Boss', 'security-boss': 'Security Boss', 'skill-boss': 'Skill Boss',
  'search-boss': 'Search Boss', 'build-boss': 'Build Boss', 'integration-boss': 'Integration Boss', 'docs-boss': 'Docs Boss',
};

function safeReadJson(p) {
  try { const j = JSON.parse(fs.readFileSync(p, 'utf8')); return (j && typeof j === 'object') ? j : null; } catch { return null; }
}

/** loadRegistrySlugMap(registryFile) -> Map(lowercased slug|display-name -> canonical slug). Never throws. */
function loadRegistrySlugMap(registryFile) {
  const reg = safeReadJson(registryFile);
  let src = FALLBACK_BOSSES;
  if (reg && reg.agents && typeof reg.agents === 'object') {
    src = {};
    for (const [slug, a] of Object.entries(reg.agents)) src[slug] = (a && a.name) ? String(a.name) : slug;
  }
  const map = new Map();
  for (const [slug, name] of Object.entries(src)) { map.set(slug.toLowerCase(), slug); map.set(String(name).toLowerCase(), slug); }
  return map;
}

/** canonicalSlug(map, raw) -> registered Boss slug, or null when raw is empty/unregistered (e.g. "orchestrator"). */
function canonicalSlug(map, raw) {
  if (raw == null) return null;
  const key = String(raw).trim().toLowerCase();
  return key ? (map.get(key) || null) : null;
}

function listRunDirs(runsDir) {
  let ents = [];
  try { ents = fs.readdirSync(runsDir, { withFileTypes: true }); } catch { return []; }
  return ents.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

/** readEventsFile(p) -> { events:[obj...], malformed:N } or null when the file is missing. Never throws. */
function readEventsFile(p) {
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch { return null; }
  const events = []; let malformed = 0;
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try { const v = JSON.parse(t); if (v && typeof v === 'object' && !Array.isArray(v)) events.push(v); else malformed++; }
    catch { malformed++; }
  }
  return { events, malformed };
}

const DISPATCH_TYPES = new Set(['subagent_started', 'agent_started']);
const COMPLETE_TYPES = new Set(['subagent_completed', 'agent_completed']);
const FAIL_TYPES = new Set(['subagent_failed', 'agent_failed']);
const REWORK_TYPES = new Set(['rework_task_created', 'rework_assigned']);

const newBossBucket = () => ({ dispatched: 0, completed: 0, failed: 0, rework_received: 0, gates_passed: 0, gates_blocked: 0, total_runs_with_boss: 0, first_pass_runs: 0 });
const newTypeBucket = () => ({ completed: 0, rework_received: 0, total_runs: 0, first_pass_runs: 0 });

/**
 * computeStats(runsDir, registryFile, opts) -> { generated_at, runs_scanned, malformed_skipped, perBoss,
 *   perType, advisories }. Pure read: opens every <runsDir>/*&#47;events.jsonl (+ sibling run.json for
 * project_type), never writes anything, never throws — malformed lines/dirs are counted and skipped.
 */
function computeStats(runsDir, registryFile, opts) {
  opts = opts || {};
  const threshold = Number.isFinite(opts.threshold) ? opts.threshold : 30;
  const minSamples = Number.isFinite(opts.minSamples) ? opts.minSamples : 3;
  const slugMap = loadRegistrySlugMap(registryFile);

  const perBoss = {};
  const perType = {};
  let runsScanned = 0;
  let malformedSkipped = 0;

  for (const dir of listRunDirs(runsDir)) {
    const runDir = path.join(runsDir, dir);
    const read = readEventsFile(path.join(runDir, 'events.jsonl'));
    if (read == null) continue; // no events.jsonl -> not a run we scan
    runsScanned++;
    malformedSkipped += read.malformed;

    const runJson = safeReadJson(path.join(runDir, 'run.json'));
    // project_type is a short classifier ("website","n8n") — sanitize anyway (security-boss LOW-3):
    // single-line, length-capped, so a weird run.json can never smuggle bulk text into STATS.json.
    const projectType = ((runJson && runJson.project_type && String(runJson.project_type).replace(/\s+/g, ' ').trim()) || 'unknown').slice(0, 60);
    if (!perType[projectType]) perType[projectType] = {};
    const bucket = (slug) => perBoss[slug] || (perBoss[slug] = newBossBucket());
    const typeBucket = (slug) => perType[projectType][slug] || (perType[projectType][slug] = newTypeBucket());

    const runCompleted = new Set();
    const runReworked = new Set();

    for (const e of read.events) {
      const et = e.event_type;
      if (DISPATCH_TYPES.has(et)) {
        const slug = canonicalSlug(slugMap, e.agent);
        if (slug) bucket(slug).dispatched++;
      } else if (COMPLETE_TYPES.has(et)) {
        const slug = canonicalSlug(slugMap, e.agent);
        if (slug) { bucket(slug).completed++; runCompleted.add(slug); typeBucket(slug).completed++; }
      } else if (FAIL_TYPES.has(et)) {
        const slug = canonicalSlug(slugMap, e.agent);
        if (slug) bucket(slug).failed++;
      } else if (REWORK_TYPES.has(et)) {
        const slug = canonicalSlug(slugMap, e.target != null ? e.target : e.to);
        if (slug) { bucket(slug).rework_received++; runReworked.add(slug); typeBucket(slug).rework_received++; }
      } else if (et === 'quality_gate_passed') {
        const slug = canonicalSlug(slugMap, e.agent);
        if (slug) bucket(slug).gates_passed++;
      } else if (et === 'quality_gate_blocked') {
        const slug = canonicalSlug(slugMap, e.agent);
        if (slug) bucket(slug).gates_blocked++;
      }
    }

    for (const slug of runCompleted) {
      const b = bucket(slug); b.total_runs_with_boss++;
      const firstPass = !runReworked.has(slug);
      if (firstPass) b.first_pass_runs++;
      const tb = typeBucket(slug); tb.total_runs++;
      if (firstPass) tb.first_pass_runs++;
    }
  }

  const perBossOut = {};
  for (const slug of Object.keys(perBoss).sort()) {
    const b = perBoss[slug];
    perBossOut[slug] = Object.assign({}, b, {
      first_pass_rate: b.total_runs_with_boss > 0 ? Math.round((b.first_pass_runs / b.total_runs_with_boss) * 100) : null,
    });
  }

  const perTypeOut = {};
  const advisories = [];
  for (const type of Object.keys(perType).sort()) {
    const out = {};
    for (const slug of Object.keys(perType[type]).sort()) {
      const tb = perType[type][slug];
      const rate = tb.total_runs > 0 ? Math.round(((tb.total_runs - tb.first_pass_runs) / tb.total_runs) * 100) : 0;
      out[slug] = { completed: tb.completed, rework_received: tb.rework_received, rework_rate: rate };
      if (tb.total_runs >= minSamples && rate >= threshold) {
        advisories.push('ADVISORY: ' + slug + ' rework-rate ' + rate + '% over ' + tb.total_runs + ' runs (' + type + ') — consider model escalation for this role (owner decision; forge-stats never changes config).');
      }
    }
    perTypeOut[type] = out;
  }
  advisories.sort();

  return { generated_at: new Date().toISOString(), runs_scanned: runsScanned, malformed_skipped: malformedSkipped, perBoss: perBossOut, perType: perTypeOut, advisories };
}

/** formatTable(stats) -> compact aligned "boss | dispatched | completed | failed | rework | first-pass%" text + advisories. */
function formatTable(stats) {
  const bosses = Object.keys(stats.perBoss);
  const lines = [];
  if (!bosses.length) {
    lines.push('(no Boss activity found in any scanned run)');
  } else {
    const header = ['boss', 'dispatched', 'completed', 'failed', 'rework', 'first-pass%'];
    const rows = [header].concat(bosses.map((slug) => {
      const b = stats.perBoss[slug];
      return [slug, String(b.dispatched), String(b.completed), String(b.failed), String(b.rework_received), b.first_pass_rate == null ? 'n/a' : b.first_pass_rate + '%'];
    }));
    const widths = header.map((_, i) => Math.max(...rows.map((r) => r[i].length)));
    for (const r of rows) lines.push(r.map((c, i) => c.padEnd(widths[i])).join(' | '));
  }
  lines.push('');
  lines.push(stats.advisories.length ? stats.advisories.join('\n') : '(no advisories — no Boss/project-type crossed the rework-rate threshold with enough samples)');
  return lines.join('\n');
}

function parseArgs(argv) {
  const opts = { json: false, write: true, threshold: 30, minSamples: 3 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--no-write') opts.write = false;
    else if (a === '--threshold') { const v = Number(argv[++i]); if (!Number.isFinite(v)) { opts.usageError = '--threshold requires a numeric percentage'; break; } opts.threshold = v; }
    else if (a === '--min-samples') { const v = Number(argv[++i]); if (!Number.isFinite(v)) { opts.usageError = '--min-samples requires a numeric value'; break; } opts.minSamples = v; }
    else { opts.usageError = 'unknown argument: ' + a; break; }
  }
  return opts;
}

module.exports = { computeStats, loadRegistrySlugMap, canonicalSlug, formatTable, parseArgs };

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.usageError) {
    console.error('forge-stats: ' + opts.usageError);
    console.error('Usage: node forge-stats.cjs [--json] [--no-write] [--threshold <pct>] [--min-samples <n>]');
    process.exitCode = 2;
  } else {
    try {
      const stats = computeStats(RUNS_DIR, REGISTRY_FILE, { threshold: opts.threshold, minSamples: opts.minSamples });
      if (opts.write) {
        fs.mkdirSync(RUNS_DIR, { recursive: true });
        fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2) + '\n', 'utf8');
      }
      if (opts.json) {
        console.log(JSON.stringify(stats, null, 2));
      } else {
        console.log('forge-stats · ' + stats.runs_scanned + ' run(s) scanned' + (stats.malformed_skipped ? ' · ' + stats.malformed_skipped + ' malformed line(s) skipped' : ''));
        console.log(formatTable(stats));
        console.log(opts.write ? ('wrote ' + path.relative(PROJECT_ROOT, STATS_FILE).split(path.sep).join('/')) : '(--no-write: STATS.json not written)');
      }
      process.exitCode = 0;
    } catch (e) {
      console.error('forge-stats: error: ' + e.message);
      process.exitCode = 1;
    }
  }
}
