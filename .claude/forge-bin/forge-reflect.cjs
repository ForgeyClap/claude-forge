#!/usr/bin/env node
'use strict';
/**
 * forge-reflect.cjs — owner-correction -> evidence-linked lesson writer (MANUAL-ONLY).
 *
 * PROBLEM (verified gap): forge-distill.cjs turns *run events* into per-Boss lessons, but it explicitly
 * excludes the Lead/orchestrator (see its GENERIC_AGENTS list) — so an owner correction inside a live
 * session ("nee, gebruik knop X", "never end posts with a question") never becomes a persisted lesson.
 * Those corrections are the highest-value learning signal Forge has, and today they evaporate at session
 * end. This tool closes that gap for the one actor forge-distill cannot see: the owner.
 *
 * WHAT THIS FILE IS: the mechanical writer only. It takes a verbatim owner quote (the evidence) plus a
 * short lesson text and writes ONE typed lesson via forge-memory.cjs's addLesson() API — this file NEVER
 * reimplements storage or redaction, exactly like forge-distill.cjs never does.
 *
 * WHAT THIS FILE IS NOT: it does not scan a session transcript, does not itself decide which corrections
 * matter, and does not touch any skill file. That judgment (scan session -> classify confidence ->
 * propose -> OWNER approves) is a Lead procedure, not code. This tool is invoked only AFTER that human
 * approval step, with the owner's own words already in hand.
 *
 * MANUAL-ONLY (hard constraint): this tool MUST NEVER be wired to a hook, a Stop-hook, or any background
 * loop — Forge's no-hooks governance is intentional. An automatic "reflect at session end" mode would
 * learn from unreviewed noise instead of owner-approved signal. Run it by hand from the CLI only.
 *
 * CLI:
 *   node forge-reflect.cjs add <boss-slug> --text "<lesson text>" --quote "<verbatim owner correction>"
 *        [--type episodic|semantic|procedural] [--confidence high|medium|low] [--tags a,b,c] [--json]
 *     Writes one lesson for <boss-slug>. --quote is MANDATORY (refuse, exit 2, without it) — the
 *     verbatim owner words ARE the evidence, the same way a run event is the evidence for forge-distill.
 *     Boss resolves against .claude/config/agents/agent-registry.json (slug or display name); an
 *     unreadable registry resolves nothing (fail-safe). Generic names (lead/boss/orchestrator/...) are
 *     refused — lessons belong to a working Boss. Default --type episodic (a correction is a
 *     guard-rail). Default --confidence high (an explicit owner correction is a strong signal). Text and
 *     quote are sanitized to a single line (control chars stripped, whitespace collapsed) and truncated.
 *     Deduped by normalized lesson text per Boss (identical text -> skipped, exit 0, nothing added).
 *     Auto-tagged with 'owner-correction' + 'forge-reflect' plus any --tags.
 *   node forge-reflect.cjs list <boss-slug> [--k N] [--json]
 *     Prints that Boss's owner-correction lessons (tags include 'owner-correction'), newest first.
 *     Honest empty state (exit 0, not an error) when there are none yet.
 *
 * Exit codes: 0 = success (including an honest empty list, or a skipped duplicate) · 1 = real error
 * (unexpected failure) · 2 = usage error or a refused write (missing evidence, unregistered/generic
 * boss, bad --type/--confidence, missing arguments).
 *
 * FORGE_PROJECT_ROOT overrides the project root (same convention as forge-memory.cjs / forge-distill.cjs)
 * — every path is built with path.join so this is Windows-safe. Zero npm dependencies: fs/path only,
 * plus the sibling forge-memory.cjs module (all storage + redaction stays owned there). No LLM call, no
 * network call, no hook wiring.
 */
const fs = require('fs');
const path = require('path');
const memory = require('./forge-memory.cjs');

const PROJECT_ROOT = process.env.FORGE_PROJECT_ROOT ? path.resolve(process.env.FORGE_PROJECT_ROOT) : path.resolve(__dirname, '..', '..');

// Same fail-safe list as forge-distill.cjs's / log-event.cjs's GENERIC_AGENTS: a Lead/orchestrator label
// is not a working Boss and must never get its own memory file. Kept as an independent local copy since
// this tool is zero-dep (fs/path + forge-memory.cjs only) and must not require a sibling CLI file.
const GENERIC_AGENTS = new Set(['lead', 'boss', 'orchestrator', 'system', 'paperclip', 'forge-router', 'main', 'codex', '']);
const CONFIDENCE_LEVELS = new Set(['high', 'medium', 'low']);
const TEXT_MAX = 500;
const QUOTE_MAX = 300;

// ---- small pure helpers (mirrors forge-distill.cjs's truncate/normalizeText idiom) ----
function truncate(s, n) { s = String(s == null ? '' : s).replace(/[\p{Cc}]/gu, ' ').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function normalizeText(s) { return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim(); }

/** Registry lookup: read-only, never writes agent-registry.json. Missing/unreadable registry -> empty
 *  maps -> nothing resolves (fail-safe: no registry to prove membership means no lesson gets attributed
 *  to an unverified Boss). Same shape as forge-distill.cjs's loadRegistry(). */
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
/** Resolves a raw boss name to { slug, reason }. slug is null with a human reason when refused. */
function resolveBoss(rawName, registry) {
  const key = String(rawName == null ? '' : rawName).toLowerCase().trim();
  if (!key) return { slug: null, reason: 'a <boss-slug> is required' };
  if (GENERIC_AGENTS.has(key)) return { slug: null, reason: `'${rawName}' is a generic/lead/orchestrator name, not a working Boss — lessons must belong to a registered Boss` };
  const slug = registry.canon.get(key);
  if (!slug) return { slug: null, reason: `unregistered boss '${rawName}' (not found in .claude/config/agents/agent-registry.json)` };
  return { slug, reason: null };
}

function buildEvidence(quote, confidence) {
  return JSON.stringify({ source: 'owner-correction', quote: truncate(quote, QUOTE_MAX), ts: new Date().toISOString(), confidence });
}
function buildTags(userTags) {
  const tags = ['owner-correction', 'forge-reflect'];
  for (const t of userTags || []) { const v = String(t == null ? '' : t).trim(); if (v && !tags.includes(v.toLowerCase())) tags.push(v); }
  return tags;
}

function parseArgs(argv) {
  const opts = { mode: null, boss: null, text: '', quote: '', type: 'episodic', confidence: 'high', tags: [], k: null, json: false };
  let i = 0;
  if (argv[0] === 'add' || argv[0] === 'list') { opts.mode = argv[0]; i = 1; }
  if (argv[i] != null && !String(argv[i]).startsWith('--')) { opts.boss = argv[i]; i++; }
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--text') opts.text = argv[++i];
    else if (a === '--quote') opts.quote = argv[++i];
    else if (a === '--type') opts.type = argv[++i];
    else if (a === '--confidence') opts.confidence = argv[++i];
    else if (a === '--tags') opts.tags = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--k') opts.k = Number(argv[++i]);
    else if (a === '--json') opts.json = true;
  }
  return opts;
}

function printUsage() {
  console.error('Usage: node forge-reflect.cjs add <boss-slug> --text "<lesson>" --quote "<verbatim owner correction>" [--type episodic|semantic|procedural] [--confidence high|medium|low] [--tags a,b,c] [--json]');
  console.error('       node forge-reflect.cjs list <boss-slug> [--k N] [--json]');
}

/** cmdAdd(opts, root) -> { code, message, json } — never throws; refusals are just a non-zero code. */
function cmdAdd(opts, root) {
  if (!String(opts.text || '').trim()) return { code: 2, message: 'forge-reflect: --text is required and cannot be empty' };
  if (!String(opts.quote || '').trim()) return { code: 2, message: 'forge-reflect: --quote is required — the verbatim owner correction IS the evidence for this lesson' };
  if (!memory.TYPES.has(opts.type)) return { code: 2, message: `forge-reflect: bad --type '${opts.type}' (allowed: ${[...memory.TYPES].join('|')})` };
  if (!CONFIDENCE_LEVELS.has(opts.confidence)) return { code: 2, message: `forge-reflect: bad --confidence '${opts.confidence}' (allowed: ${[...CONFIDENCE_LEVELS].join('|')})` };

  const registry = loadRegistry(root);
  const resolved = resolveBoss(opts.boss, registry);
  if (!resolved.slug) return { code: 2, message: `forge-reflect: refused — ${resolved.reason}` };

  const text = truncate(opts.text, TEXT_MAX);
  const norm = normalizeText(text);
  const existing = memory.listLessons(resolved.slug, root);
  if (existing.some((l) => normalizeText(l.text) === norm)) {
    return { code: 0, message: `forge-reflect: skipped — an identical lesson already exists for ${resolved.slug}`, json: { status: 'skipped', boss: resolved.slug, reason: 'duplicate' } };
  }

  const evidence = buildEvidence(opts.quote, opts.confidence);
  const tags = buildTags(opts.tags);
  const rec = memory.addLesson(resolved.slug, { type: opts.type, text, tags, evidence }, root);
  return { code: 0, message: `forge-reflect: lesson ${rec.id} (${rec.type}) stored for ${resolved.slug} [owner-correction]`, json: { status: 'written', boss: resolved.slug, lesson: rec } };
}

/** cmdList(opts, root) -> { code, message, json }. Read-only: no registry check required to browse. */
function cmdList(opts, root) {
  const registry = loadRegistry(root);
  const key = String(opts.boss == null ? '' : opts.boss).toLowerCase().trim();
  const slug = registry.canon.get(key) || opts.boss; // best-effort fallback: memDir() normalizes either way
  const all = memory.listLessons(slug, root).filter((l) => Array.isArray(l.tags) && l.tags.includes('owner-correction'));
  const newestFirst = all.slice().reverse(); // append-only file: last line written = newest, no ts-parsing needed
  const k = Number.isFinite(opts.k) && opts.k > 0 ? opts.k : newestFirst.length;
  const shown = newestFirst.slice(0, k);
  if (!shown.length) return { code: 0, message: `forge-reflect: no owner-correction lessons yet for ${opts.boss}`, json: { boss: opts.boss, lessons: [] } };
  const lines = [`OWNER-CORRECTION LESSONS for ${opts.boss} (newest first):`];
  shown.forEach((l, i) => {
    let ev = null; try { ev = JSON.parse(l.evidence); } catch { /* not JSON */ }
    const conf = ev && ev.confidence ? ` [confidence:${ev.confidence}]` : '';
    const quote = ev && ev.quote ? ` — quote: "${ev.quote}"` : '';
    lines.push(`${i + 1}. [${l.type}]${conf} ${l.text}${quote} (ts: ${l.ts})`);
  });
  return { code: 0, message: lines.join('\n'), json: { boss: opts.boss, lessons: shown } };
}

if (require.main === module) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.mode !== 'add' && opts.mode !== 'list') { printUsage(); process.exitCode = 2; }
    else if (!opts.boss) { console.error('forge-reflect: <boss-slug> is required'); process.exitCode = 2; }
    else {
      const result = opts.mode === 'add' ? cmdAdd(opts, PROJECT_ROOT) : cmdList(opts, PROJECT_ROOT);
      if (opts.json) console.log(JSON.stringify(result.json));
      else if (result.code === 2) console.error(result.message);
      else console.log(result.message);
      process.exitCode = result.code;
    }
  } catch (e) { console.error('forge-reflect: ' + e.message); process.exitCode = 1; }
}

module.exports = { parseArgs, cmdAdd, cmdList, loadRegistry, resolveBoss, truncate, normalizeText, buildEvidence, buildTags };
