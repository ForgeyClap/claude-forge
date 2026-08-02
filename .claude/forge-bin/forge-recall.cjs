#!/usr/bin/env node
'use strict';
/**
 * forge-recall.cjs — utility-ranked lesson recall with a reserved GLOBAL/Lead namespace (WAVE E / PIECE
 * E2, 2026-07-18). Zero-dependency (fs/path only, plus the sibling forge-memory.cjs — the single source
 * of truth for the on-disk per-Boss lesson-store path/slug rule and its mechanically-enforced redaction;
 * this file NEVER re-implements storage, writes, or redaction, only READS via forge-memory's own
 * listLessons()).
 *
 * PURPOSE: before dispatching a Boss, recall the top-utility RELEVANT lessons for that Boss's own
 * namespace, blended with a reserved "global" namespace that is recalled before EVERY dispatch regardless
 * of which Boss is being dispatched — the Lead-level lessons ("never auto-push", "honesty core", etc.)
 * that apply no matter who is working. Ranking combines a keyword/recency relevance score (same formula
 * forge-memory.cjs::recall() and forge-learn.cjs::scoreLesson() already use, so a lesson without a
 * reinforced utility yet still ranks sensibly) with each lesson's `utility` field (as maintained by
 * forge-reinforce.cjs; absent/non-finite defaults to 0 — a lesson that was never reinforced ranks purely
 * on relevance, never fabricated confidence).
 *
 * THE GLOBAL/LEAD GUARANTEE: lessons stored under the reserved GLOBAL_NAMESPACE ("global") are NEVER
 * filtered out by a zero/negative relevance score the way a namespace-specific lesson is — recall()
 * reserves at least half of the requested top-K slots (or every global lesson there is, if fewer) for the
 * best-scoring global lessons before filling any remaining slots with namespace-specific ones. This is
 * what "recalled before every dispatch" means here: a caller that queries any namespace still gets the
 * standing global lessons back, not just whatever happens to keyword-match.
 *
 * CROSS-PROJECT LESSONS (2026-07-18, forge-harvest.cjs): the reserved global namespace this file blends
 * into every recall() call is no longer only fed by THIS project's own forge-distill.cjs runs — an owner-
 * invoked, read-only `forge-harvest.cjs --scan <portfolio-dir>` (or `/forge learn`) can also add real,
 * evidenced lines harvested from OTHER Forge projects' `.claude/FORGE_*.md` memory files, tagged
 * `cross_project:true` + `source_project`. Nothing in THIS file changes to support that — forge-harvest.cjs
 * writes into the exact same `global` lessons.jsonl store this file already reads via loadNamespace(), so a
 * lesson that worked in project A can surface here as advisory guidance in project B, opt-in and secrets-
 * excluded (see forge-harvest.cjs header doc comment for the full model).
 *
 * MODULE API:
 *   recall({query, namespace}, opts) -> { namespace, globalNamespace, lessons:[...], globalIncluded, notes }
 *   params.namespace (default: the GLOBAL_NAMESPACE itself — recalling with no namespace IS recalling the
 *     global/Lead lessons). params.query — free-text keywords, optional.
 *   opts.root (project root override), opts.k (top-K, default 5), opts.now (ms epoch override).
 *
 * CLI:
 *   node forge-recall.cjs --query "<t>" [--namespace <boss-slug>] [--k N] [--json]
 * Exit codes: 0 = ran (an honestly-empty recall is still success, never an error).
 * FORGE_PROJECT_ROOT overrides the project root (same convention as forge-memory.cjs/forge-distill.cjs).
 */
const path = require('path');
const memory = require('./forge-memory.cjs');

const PROJECT_ROOT = process.env.FORGE_PROJECT_ROOT ? path.resolve(process.env.FORGE_PROJECT_ROOT) : path.resolve(__dirname, '..', '..');
const GLOBAL_NAMESPACE = 'global';
const UTILITY_WEIGHT = 1;
const TYPE_LABEL = { episodic: 'guard-rail', semantic: 'strategy', procedural: 'procedure' };

function normTerms(query) { return String(query == null ? '' : query).toLowerCase().split(/\W+/).filter(Boolean); }

/** scoreLesson — same keyword/tag/recency formula as forge-memory.cjs::recall(), PLUS a utility term.
 *  A lesson with no `utility` field yet (never reinforced) contributes 0 from that term — never invented. */
function scoreLesson(lesson, terms, now) {
  const hay = ((lesson.text || '') + ' ' + (lesson.tags || []).join(' ')).toLowerCase();
  let s = 0;
  for (const t of terms) { if ((lesson.tags || []).includes(t)) s += 2; else if (hay.includes(t)) s += 1; }
  const ageDays = (now - Date.parse(lesson.ts)) / 86400000;
  const recency = Number.isFinite(ageDays) ? Math.max(0, 1 - ageDays / 60) : 0;
  const utility = Number.isFinite(lesson.utility) ? lesson.utility : 0;
  return s + recency * 0.5 + utility * UTILITY_WEIGHT;
}

function loadNamespace(namespace, root) { return memory.listLessons(namespace, root); }

/** recall(params, opts) -> see file header MODULE API. Pure/read-only. */
function recall(params, opts) {
  params = params || {}; opts = opts || {};
  const root = opts.root || PROJECT_ROOT;
  const namespace = params.namespace ? String(params.namespace) : GLOBAL_NAMESPACE;
  const k = Number.isFinite(opts.k) && opts.k > 0 ? opts.k : 5;
  const terms = normTerms(params.query);
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();

  const globalRaw = loadNamespace(GLOBAL_NAMESPACE, root);
  const globalScored = globalRaw
    .map((l) => ({ lesson: Object.assign({}, l, { namespace: GLOBAL_NAMESPACE }), score: scoreLesson(l, terms, now) }))
    .sort((a, b) => b.score - a.score);

  let nsScored = [];
  if (namespace !== GLOBAL_NAMESPACE) {
    const nsRaw = loadNamespace(namespace, root);
    nsScored = nsRaw
      .map((l) => ({ lesson: Object.assign({}, l, { namespace }), score: scoreLesson(l, terms, now) }))
      .filter((x) => x.score > 0) // namespace-specific lessons still need real relevance — never fabricated
      .sort((a, b) => b.score - a.score);
  }

  // GLOBAL GUARANTEE: reserve at least half of k (or fewer, if the global store has fewer lessons than
  // that) for the best global lessons, regardless of their query-relevance score.
  const globalReserve = globalScored.length ? Math.min(globalScored.length, Math.max(1, Math.ceil(k / 2))) : 0;
  const globalTop = globalScored.slice(0, globalReserve);
  const remaining = Math.max(0, k - globalTop.length);
  const nsTop = nsScored.slice(0, remaining);

  const combined = globalTop.concat(nsTop).sort((a, b) => b.score - a.score);

  const notes = [];
  if (!globalRaw.length) notes.push('no lessons yet in the reserved global/Lead namespace');
  if (namespace !== GLOBAL_NAMESPACE && !nsScored.length) notes.push('no relevant namespace-specific lessons for "' + namespace + '"');

  return {
    namespace, globalNamespace: GLOBAL_NAMESPACE,
    lessons: combined.map((x) => x.lesson),
    globalIncluded: globalTop.length,
    notes,
  };
}

function formatRecall(result) {
  if (!result.lessons.length) return ['no lessons found for namespace "' + result.namespace + '" (global + namespace checked)'];
  const out = ['RECALLED LESSONS for "' + result.namespace + '" (global/Lead namespace always included, non-binding):'];
  result.lessons.forEach((l, i) => {
    const scope = l.namespace === result.globalNamespace ? '[global]' : '[' + l.namespace + ']';
    const utility = Number.isFinite(l.utility) ? l.utility : 0;
    out.push((i + 1) + '. ' + scope + ' [' + (TYPE_LABEL[l.type] || l.type) + '] ' + l.text + ' (utility: ' + utility + ')');
  });
  return out;
}

module.exports = { recall, formatRecall, scoreLesson, loadNamespace, normTerms, GLOBAL_NAMESPACE, UTILITY_WEIGHT };

// ---- CLI ----
function parseArgs(argv) {
  const opts = { query: '', namespace: null, k: null, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--query') opts.query = argv[++i] || '';
    else if (a === '--namespace') opts.namespace = argv[++i];
    else if (a === '--k') opts.k = Number(argv[++i]);
    else if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}
function printUsage() {
  console.error('Usage: node forge-recall.cjs --query "<t>" [--namespace <boss-slug>] [--k N] [--json]');
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { printUsage(); process.exitCode = 0; }
  else {
    try {
      const result = recall({ query: opts.query, namespace: opts.namespace }, { root: PROJECT_ROOT, k: Number.isFinite(opts.k) && opts.k > 0 ? opts.k : undefined });
      if (opts.json) console.log(JSON.stringify(result));
      else console.log(formatRecall(result).join('\n'));
      process.exitCode = 0;
    } catch (e) {
      console.error('forge-recall: ' + e.message);
      process.exitCode = 2;
    }
  }
}
