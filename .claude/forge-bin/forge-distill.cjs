#!/usr/bin/env node
'use strict';
/**
 * forge-distill.cjs — self-learning distill loop for Forge's per-Boss memory (forge-memory.cjs).
 *
 * PROBLEM (verified gap): forge-memory.cjs (typed lessons + top-K recall + enforced redaction) has
 * ZERO callers — nothing turns a real run's outcome into a lesson, and nothing injects past lessons
 * before a Boss is dispatched. This tool closes that loop with two commands:
 *
 *   DISTILL — reads a run's real .claude/forge-runs/<run_id>/events.jsonl and writes evidence-linked
 *             lessons via forge-memory's addLesson() API (this file NEVER reimplements storage or
 *             redaction — that stays owned by forge-memory.cjs).
 *   RECALL  — reads top-K lessons for a Boss via forge-memory's recall() and prints an
 *             injection-ready ADVISORY block a Lead can paste before dispatching that Boss.
 *
 * CLEAN-ROOM NOTE: "distill successful/failed trajectories into typed, evidence-linked memory, then
 * recall top-K before the next attempt" follows the published pattern description of the
 * ReasoningBank paper (arXiv:2509.25140, Apache-2.0 reference paper) — no code from that paper or any
 * other project is used here. This is an original, zero-dependency implementation.
 *
 * DETERMINISTIC BY DESIGN — this file NEVER calls an LLM. Lessons are template-rendered from
 * structured event fields only (task/note/issue/reason/required_fix/output). Forge's own verify-loop
 * (check_passed / quality_gate_x / rework_x) already supplies the judgment signal; re-deriving that
 * judgment with another model call would (a) spend hidden tokens on every run and (b) open a
 * memory-poisoning vector (a bad LLM summary silently becoming "advice" fed into a future prompt).
 *
 * CLI:
 *   node forge-distill.cjs --run <run_id> [--max N] [--dry-run] [--json]
 *     Distill one run's events.jsonl into per-Boss lessons. Default --max 3 lessons per Boss per run
 *     (failures/guard-rails prioritized over successes/strategies when capped). --dry-run evaluates
 *     the whole pipeline (evidence/substance/dedupe/cap) but writes nothing and never self-logs.
 *   node forge-distill.cjs --recall <boss> [keywords...] [--k N] [--json]
 *     Print the top-K (default 5) lessons for <boss> as an ADVISORY block. Honest empty state when
 *     there are no lessons yet (exit 0, not an error).
 *
 * Exit codes: 0 = success (including an honest empty result) · 1 = real error (run/events.jsonl not
 * found or unreadable) · 2 = usage error (missing/invalid arguments).
 *
 * FORGE_PROJECT_ROOT overrides the project root (same convention as forge-memory.cjs / forge-cost.cjs)
 * — every path is built with path.join so this is Windows-safe. Zero npm dependencies (fs/path/
 * child_process only, plus the sibling forge-memory.cjs module).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const memory = require('./forge-memory.cjs');

const PROJECT_ROOT = process.env.FORGE_PROJECT_ROOT ? path.resolve(process.env.FORGE_PROJECT_ROOT) : path.resolve(__dirname, '..', '..');

// ---- event vocabulary this tool reacts to (see .claude/forge-dashboard/log-event.cjs header) ----
const FAILURE_TYPES = new Set(['subagent_failed', 'agent_failed', 'rework_task_created', 'rework_assigned', 'quality_gate_blocked', 'check_failed']);
const SUCCESS_TYPES = new Set(['subagent_completed', 'agent_completed', 'quality_gate_passed', 'retest_completed']);
const REWORK_TYPES = new Set(['rework_task_created', 'rework_assigned']);
// same generic/non-attributable names as log-event.cjs's GENERIC_AGENTS — a Lead/orchestrator label
// is not a working Boss and must never get its own memory file.
const GENERIC_AGENTS = new Set(['lead', 'boss', 'orchestrator', 'system', 'paperclip', 'forge-router', 'main', 'codex', '']);
const TYPE_LABEL = { episodic: 'guard-rail', semantic: 'strategy', procedural: 'procedure' };

// ---- small pure helpers ----
// Single-line data guarantee (security-boss LOW-2, 2026-07-12): interpolated event fields are
// attacker-influencable in principle, so control chars are stripped and whitespace collapsed — a
// crafted multi-line note can never smuggle an instruction-looking line into a recalled lesson.
// fix-cap-order: SCRUB FIRST, cut second. This used to cut at 200/300 chars and leave redaction to
// forge-memory.addLesson() further down the pipe — redaction therefore ran on ALREADY-CUT text. Every
// pattern in forge-store.cjs that needs a trailing anchor (the full PEM block needs its
// `-----END ... PRIVATE KEY-----`, a JWT needs all three dot-separated segments) then matched nothing
// and the readable head survived into .claude/agent-memory/<boss>/lessons.jsonl. Measured on a real
// events.jsonl-shaped `issue` field: a PEM header line (BEGIN-marker + base64 body, written out in
// full in the test, never here — quoting it verbatim in a comment trips our own leak scan) came through
// intact; scrubbing first yields `***REDACTED***`. The scrubber stays OWNED by forge-memory.cjs (this
// file still reimplements no redaction of its own, per its own header) — it is only applied at the
// right moment. Scrubbing twice is harmless: it is idempotent.
function truncate(s, n) { s = memory.scrub(String(s == null ? '' : s)).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function normalizeText(s) { return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim(); }
function hasSubstance(ev) { return ['task', 'note', 'output', 'evidence'].some((k) => ev[k] != null && String(ev[k]).trim().length > 0); }
function extractKeywords(text, max) {
  const seen = new Set(); const out = [];
  for (const w of String(text || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 3 || seen.has(w)) continue;
    seen.add(w); out.push(w);
    if (out.length >= max) break;
  }
  return out;
}
function buildTags(taskText, projectType) {
  const tags = extractKeywords(taskText, 6);
  for (const kw of extractKeywords(projectType, 4)) if (!tags.includes(kw)) tags.push(kw);
  tags.push('forge-distill');
  return tags.slice(0, 12);
}

/** Registry lookup: normalizes a display name or slug to the registry's slug key. Read-only — never
 *  writes to agent-registry.json. Missing/unreadable registry -> nothing resolves (fail safe: no
 *  registry to prove membership means no lesson gets attributed to an unverified Boss). */
function loadRegistry(root) {
  const canon = new Map(); const display = new Map();
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'config', 'agents', 'agent-registry.json'), 'utf8'));
    for (const [slug, a] of Object.entries(reg.agents || {})) {
      const name = a && a.name ? String(a.name) : slug;
      canon.set(slug.toLowerCase(), slug);
      canon.set(name.toLowerCase(), slug);
      display.set(slug, name);
    }
  } catch { /* honest fallback: empty maps, everything below is treated as unregistered */ }
  return { canon, display };
}
function rawBossFor(ev) { return REWORK_TYPES.has(ev.event_type) ? (ev.target || ev.to || ev.agent) : ev.agent; }
function resolveBoss(rawName, registry) {
  const key = String(rawName == null ? '' : rawName).toLowerCase().trim();
  if (!key || GENERIC_AGENTS.has(key)) return null;
  return registry.canon.get(key) || null;
}

function buildFailureLesson(ev, bossDisplay, projectType) {
  const task = truncate(ev.task || ev.note || '(unspecified task)', 200);
  const issue = truncate(ev.issue || ev.reason || ev.note || '(no reason given)', 300);
  const fix = truncate(ev.required_fix || ev.next_action || '(no fix specified)', 300);
  return { type: 'episodic', text: `GUARD-RAIL (${bossDisplay}): on task '${task}' — ${issue}; required fix: ${fix}.`, tags: buildTags(task, projectType) };
}
function buildSuccessLesson(ev, bossDisplay, projectType) {
  const task = truncate(ev.task || ev.note || '(unspecified task)', 200);
  const summary = truncate(ev.note || ev.evidence || ev.output || '(no summary)', 300);
  return { type: 'semantic', text: `STRATEGY (${bossDisplay}): '${task}' passed — ${summary}.`, tags: buildTags(task, projectType) };
}

/**
 * distillRun(runId, opts) -> { error } | { runId, malformed, totalEvents, written, refused, skipped,
 *   guardRails, strategies, perBoss: {slug:{written,guard_rails,strategies}}, projectType }
 * opts: { max, dryRun, root }. Never throws — a bad run/events.jsonl comes back as {error} instead.
 */
function distillRun(runId, opts) {
  opts = opts || {};
  const root = opts.root;
  // Same run-id shape log-event.cjs enforces (security-boss LOW-1): no traversal via --run, even read-only.
  if (!/^[A-Za-z0-9_-]+$/.test(String(runId == null ? '' : runId))) return { error: `invalid run id '${runId}' (allowed: A-Za-z0-9_- only)` };
  const runDir = path.join(root, '.claude', 'forge-runs', runId);
  const eventsPath = path.join(runDir, 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return { error: `run '${runId}' not found (no events.jsonl at ${eventsPath})` };

  let raw;
  try { raw = fs.readFileSync(eventsPath, 'utf8'); } catch (e) { return { error: `cannot read events.jsonl: ${e.message}` }; }

  let projectType = 'unknown';
  try { const rj = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8')); if (rj && rj.project_type) projectType = String(rj.project_type); } catch { /* honest fallback */ }

  const registry = loadRegistry(root);
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length);
  let malformed = 0;
  const events = [];
  for (const line of lines) { try { events.push(JSON.parse(line)); } catch { malformed++; } }

  // Pass 1: classify each event + resolve the Boss it belongs to.
  const candidates = [];
  let skipped = 0;
  for (const ev of events) {
    const category = FAILURE_TYPES.has(ev.event_type) ? 'failure' : SUCCESS_TYPES.has(ev.event_type) ? 'success' : null;
    if (!category) continue; // not a distillable signal
    const slug = resolveBoss(rawBossFor(ev), registry);
    if (!slug) { skipped++; continue; } // unregistered/generic agent — counted, never written
    candidates.push({ ev, category, slug });
  }

  // Pass 2: group per Boss, sort failures before successes (stable sort — ties keep run order).
  const byBoss = new Map();
  for (const c of candidates) { if (!byBoss.has(c.slug)) byBoss.set(c.slug, []); byBoss.get(c.slug).push(c); }
  const rank = { failure: 0, success: 1 };
  for (const list of byBoss.values()) list.sort((a, b) => rank[a.category] - rank[b.category]);

  const maxPerBoss = Number.isFinite(opts.max) && opts.max > 0 ? opts.max : 3;
  let written = 0, refused = 0, guardRails = 0, strategies = 0;
  const perBoss = {};

  // Pass 3: evidence -> substance -> cap -> dedupe -> write, per Boss.
  for (const [slug, list] of byBoss.entries()) {
    const existing = new Set(memory.listLessons(slug, root).map((l) => normalizeText(l.text)));
    perBoss[slug] = { written: 0, guard_rails: 0, strategies: 0 };
    let countForBoss = 0;
    for (const c of list) {
      const ev = c.ev;
      if (!ev.timestamp) { refused++; continue; } // CLAIM=PROOF: no evidence, no lesson
      if (c.category === 'success' && !hasSubstance(ev)) { skipped++; continue; }
      // review-boss LOW (2026-07-12): a failure with no reason AND no fix AND no substance would render
      // "(no reason given); required fix: (no fix specified)" — evidence-backed but worthless advice; skip.
      if (c.category === 'failure' && !hasSubstance(ev) && !(ev.issue || ev.reason || ev.required_fix || ev.next_action)) { skipped++; continue; }
      if (countForBoss >= maxPerBoss) { skipped++; continue; } // capped — failures already sorted first
      const bossDisplay = registry.display.get(slug) || slug;
      const lesson = c.category === 'failure' ? buildFailureLesson(ev, bossDisplay, projectType) : buildSuccessLesson(ev, bossDisplay, projectType);
      const norm = normalizeText(lesson.text);
      if (existing.has(norm)) { skipped++; continue; } // near-duplicate of an existing lesson
      const evidence = JSON.stringify({ run_id: runId, ts: ev.timestamp, event_type: ev.event_type });
      if (!opts.dryRun) memory.addLesson(slug, { type: lesson.type, text: lesson.text, tags: lesson.tags, evidence, ts: ev.timestamp }, root);
      existing.add(norm);
      countForBoss++; written++; perBoss[slug].written++;
      if (c.category === 'failure') { guardRails++; perBoss[slug].guard_rails++; } else { strategies++; perBoss[slug].strategies++; }
    }
  }

  return { runId, malformed, totalEvents: events.length, written, refused, skipped, guardRails, strategies, perBoss, projectType };
}

/** Best-effort: log ONE memory_updated event via the real log-event.cjs so the run's activity log
 *  reflects the distill. Uses `root` (not a hardcoded path) so a FORGE_PROJECT_ROOT override in tests
 *  targets that root's OWN log-event.cjs — never the real project's forge-runs. Never throws; a
 *  logging failure is reported back, not swallowed, and never invalidates the distill result itself. */
function logMemoryUpdated(runId, root, summary) {
  const bosses = Object.keys(summary.perBoss).filter((b) => summary.perBoss[b].written > 0);
  if (!bosses.length) return { skipped: true };
  const note = `forge-distill: ${summary.written} lessons (${summary.guardRails} guard-rails, ${summary.strategies} strategies) for ${bosses.join(', ')}`;
  const evidence = bosses.map((b) => `agent-memory/${b}/lessons.jsonl`).join(', ');
  const logEventPath = path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs');
  const payload = JSON.stringify({ agent: 'orchestrator', role: 'lead', note, evidence });
  const r = spawnSync(process.execPath, [logEventPath, runId, 'memory_updated', payload], { encoding: 'utf8' });
  if (r.error) return { ok: false, reason: r.error.message };
  if (r.status !== 0) return { ok: false, reason: (r.stderr || r.stdout || 'log-event.cjs exited ' + r.status).toString().trim() };
  return { ok: true };
}

function parseEvidenceRunId(evidence) { try { const o = JSON.parse(evidence); if (o && o.run_id) return o.run_id; } catch { /* not JSON */ } return evidence || 'unknown'; }
function formatRecall(boss, lessons) {
  if (!lessons.length) return [`no distilled lessons yet for ${boss}`];
  const out = [`ADVISORY LESSONS for ${boss} (evidence-based, non-binding — from past runs):`];
  lessons.forEach((l, i) => out.push(`${i + 1}. [${TYPE_LABEL[l.type] || l.type}] ${l.text} (evidence: ${parseEvidenceRunId(l.evidence)})`));
  return out;
}

function parseArgs(argv) {
  const opts = { mode: null, runId: null, boss: null, keywords: [], k: 5, max: 3, dryRun: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run') { opts.mode = 'run'; opts.runId = argv[++i]; }
    else if (a === '--recall') {
      opts.mode = 'recall'; opts.boss = argv[++i];
      while (i + 1 < argv.length && !String(argv[i + 1]).startsWith('--')) opts.keywords.push(argv[++i]);
    }
    else if (a === '--max') opts.max = Number(argv[++i]);
    else if (a === '--k') opts.k = Number(argv[++i]);
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--json') opts.json = true;
  }
  return opts;
}

function printUsage() {
  console.error('Usage: node forge-distill.cjs --run <run_id> [--max N] [--dry-run] [--json]');
  console.error('       node forge-distill.cjs --recall <boss> [keywords...] [--k N] [--json]');
}

if (require.main === module) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.mode === 'run') {
      if (!opts.runId || opts.runId.startsWith('--')) { console.error('forge-distill: --run requires a <run_id>'); process.exitCode = 2; }
      else {
        const summary = distillRun(opts.runId, { max: opts.max, dryRun: opts.dryRun, root: PROJECT_ROOT });
        if (summary.error) { console.error('forge-distill: ' + summary.error); process.exitCode = 1; }
        else {
          let logResult = null;
          if (!opts.dryRun && summary.written >= 1) logResult = logMemoryUpdated(opts.runId, PROJECT_ROOT, summary);
          if (opts.json) {
            console.log(JSON.stringify({ written: summary.written, refused: summary.refused, skipped: summary.skipped, perBoss: summary.perBoss, malformed: summary.malformed, guardRails: summary.guardRails, strategies: summary.strategies, dryRun: !!opts.dryRun, logged: logResult }));
          } else {
            console.log(`forge-distill --run ${opts.runId}${opts.dryRun ? ' (dry-run)' : ''}: ${summary.written} written (${summary.guardRails} guard-rails, ${summary.strategies} strategies), ${summary.refused} refused, ${summary.skipped} skipped, ${summary.malformed} malformed lines.`);
            if (logResult && logResult.ok === false) console.error('forge-distill: memory_updated logging failed (distill result still valid): ' + logResult.reason);
          }
          process.exitCode = 0;
        }
      }
    } else if (opts.mode === 'recall') {
      if (!opts.boss || opts.boss.startsWith('--')) { console.error('forge-distill: --recall requires a <boss>'); process.exitCode = 2; }
      else {
        const k = Number.isFinite(opts.k) && opts.k > 0 ? opts.k : 5;
        const lessons = memory.recall(opts.boss, opts.keywords.join(' '), k, PROJECT_ROOT);
        if (opts.json) console.log(JSON.stringify({ lessons }));
        else console.log(formatRecall(opts.boss, lessons).join('\n'));
        process.exitCode = 0;
      }
    } else { printUsage(); process.exitCode = 2; }
  } catch (e) { console.error('forge-distill: ' + e.message); process.exitCode = 1; }
}

module.exports = { distillRun, logMemoryUpdated, formatRecall, parseArgs, resolveBoss, loadRegistry, buildFailureLesson, buildSuccessLesson, normalizeText };
