#!/usr/bin/env node
'use strict';
/**
 * forge-vault.cjs — Forge Knowledge Vault (v2.9.0, WP-E). Zero-dependency, Windows-safe.
 *
 * PATTERN CREDIT: adapted from the note-taking pattern in claude-obsidian
 * (github.com/AgriciDaniel/claude-obsidian, MIT license) — atomic, cited, linked markdown notes that
 * compound over time. That project's engine is Python; this is a from-scratch, zero-dependency Node
 * reimplementation of the PATTERN (frontmatter + wikilinks + an index), not a port of its code, so a
 * fresh Windows laptop with no Python installed still gets the feature automatically.
 *
 * WHAT THIS WRITES: after a REAL finished run, plain markdown notes under <project>/.claude/forge-vault/
 *   Home.md              — one index, links every note, newest runs first.
 *   runs/<run_id>.md      — that run's mission excerpt, what changed, checks, links to its decisions/topics.
 *   decisions/<slug>.md   — one note per decision (decision_logged events + matching sections of
 *                           FORGE_DECISIONS.md / FORGE_MEMORY.md that name this run).
 *   topics/<area>.md      — one note per area a run touched (derived from files_changed paths),
 *                           listing every run/decision that touched it (rebuilt by scanning, see below).
 *
 * DESIGN — why scanning, not accumulation: runs/<id>.md and decisions/<slug>.md are the only PRIMARY
 * records (each fully regenerated from that one run's own data). Home.md and topics/<area>.md are pure
 * DERIVED VIEWS rebuilt by scanning the primary notes' own frontmatter (a run note tags itself
 * "topic:<slug>"; a decision note's source_run names its run). This avoids parsing this file's own
 * previously-written bullet lists back out of a topic note (fragile) and makes every view self-healing:
 * delete a run note by hand and the next update() call for any run naturally stops listing it.
 *
 * IDEMPOTENCE: a note's frontmatter `updated` timestamp is EXCLUDED from the before/after comparison
 * (canonicalizeForCompare) — running update twice with no new facts writes nothing at all, not even a
 * timestamp bump. `created` is read back from the existing file and reused, never reset.
 *
 * MANUAL TEXT: everything at/after the first literal "<!-- forge:manual -->" line in an existing note is
 * copied forward byte-for-byte on every regeneration — a user's own notes below that marker are never
 * touched. A fresh note gets an empty marker block appended so the boundary always exists.
 *
 * HONESTY / SAFETY: every piece of free text (mission excerpts, decision text, check notes, file paths)
 * passes through this project's existing secret redaction (forge-store.cjs::redactValue) before it is
 * ever written to disk; if that module cannot be loaded, the text is replaced with a safe placeholder
 * instead of being written raw (fail-closed, same discipline as forge-toolhook.cjs's scrub()). This file
 * never reads .env or a credentials file, and never invents content — a run with neither a readable
 * run.json nor a readable events.jsonl produces no notes at all. Per-note and per-list size caps keep the
 * vault from growing unbounded.
 *
 * THIS FILE NEVER LOGS AN EVENT: forge-finalize.cjs pins the eventlog digest into the receipt the
 * moment finalize succeeds; any consumer that appended one more line afterwards would make that receipt
 * STALE on its very next check. The vault is a best-effort side artifact, not part of the audited trail.
 *
 * CLI:
 *   node forge-vault.cjs update --run <run_id> [--root <projectRoot>] [--json]
 *   node forge-vault.cjs status [--root <projectRoot>] [--json]
 *
 * Module API: require(...) -> { updateVault, statusOf, deriveTopics, extractSectionMentioning,
 *   configRead, configOn, PROJECT_ROOT_DEFAULT }
 *
 * TEST ISOLATION: every function takes `root` explicitly; tests pass a throwaway temp dir. opts.configModule
 * injects a fake forge-config.cjs (tests only).
 */
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT_DEFAULT = path.resolve(__dirname, '..', '..');
const RUN_ID_RE = /^[A-Za-z0-9_-]+$/;
const MANUAL_MARKER = '<!-- forge:manual -->';

// ---- size caps (keep the vault readable and bounded — never a dumping ground) ----
const MAX_MISSION_CHARS = 700;
const MAX_DECISION_CHARS = 1400;
const MAX_CHECK_NOTE_CHARS = 220;
const MAX_CHECKS_LISTED = 30;
const MAX_FILES_LISTED = 80;
const MAX_DECISIONS_PER_RUN = 12;
const MAX_NOTE_BODY_CHARS = 20000;
const MAX_LOG_READ_CHARS = 400000; // cap on reading FORGE_DECISIONS.md / FORGE_MEMORY.md
const MAX_REPORT_READ_CHARS = 20000; // cap on reading final-report.md
// v2.9.0 WP-K2 (Codex F7): a run touching thousands of distinct files (e.g. a bulk file_changed event)
// used to make deriveTopics() mint a topic PER FILE and updateVault() rebuild every one of them by
// rescanning the note directories — O(topics) note writes x O(topics) directory rescans, which stalls
// finalize. Two independent caps, both honestly disclosed in the run note (see renderRunNote):
const MAX_TOPICS_PER_RUN = 12; // distinct topic slugs derived per run, newest-seen-first
const MAX_FILES_CONSIDERED = 500; // distinct changed files even LOOKED AT for topic derivation / listing

// ---- owner setting (forge-config.cjs, v2.9.0 schema key "vault") — soft-required, same idiom as
// forge-toolhook.cjs / forge-memory.cjs (duplicated deliberately: each hook stays independently loadable
// even if a sibling is broken). ----
let cfg = null;
try { cfg = require('./forge-config.cjs'); } catch { cfg = null; }
/** configRead(key, fallback, opts) -> { value, source, degraded, reason }. Never throws. opts.projectRoot
 *  is the root this tool acts on (ignored when FORGE_PROJECT_ROOT is set); opts.configModule injects a
 *  module (tests; null = "absent"). */
function configRead(key, fallback, opts) {
  opts = opts || {};
  const mod = opts.configModule !== undefined ? opts.configModule : cfg;
  const o = opts.projectRoot && !process.env.FORGE_PROJECT_ROOT ? { projectRoot: opts.projectRoot } : {};
  let why = 'forge-config.cjs not found';
  try {
    if (mod && typeof mod.safeGet === 'function') {
      const r = mod.safeGet(key, Object.assign({ fallback }, o));
      if (r && typeof r.value === typeof fallback) return r;
      why = 'forge-config gave no usable value';
    } else if (mod && typeof mod.get === 'function') {
      const e = mod.get(key, o);
      if (e && typeof e.value === typeof fallback) return { value: e.value, source: e.source || 'unknown', degraded: false, reason: null };
      why = 'forge-config gave a value of the wrong type';
    }
  } catch (e) { why = 'settings unreadable: ' + ((e && e.message) || e); }
  return { value: fallback, source: 'built-in', degraded: true, reason: why + ' — ' + key + ' uses the built-in ' + JSON.stringify(fallback) };
}
function configOn(key, def, opts) { return configRead(key, def, opts).value; }

// ---- secret redaction (forge-store.cjs::redactText) — a string that cannot be redacted is never
// written raw; it is replaced with a safe placeholder instead (fail-closed). v2.9.0 WP-K2 (Codex F5):
// redactValue()'s key-name heuristic only ever matches OBJECT KEYS, so a labelled secret sitting in
// ordinary FREE TEXT ("password=hunter2" inside a decision_logged note or a FORGE_DECISIONS.md/
// FORGE_MEMORY.md section) passed straight through when this called redactValue() on a bare string.
// redactText() adds the missing key=value/key: value scan on top of the same SECRET_PATTERNS pass —
// prefer it, but degrade to redactValue() for an older forge-store.cjs that has not been synced yet
// (still better than nothing) rather than fail closed on a missing NEW export alone.
let redactFn = null;
try {
  const store = require('./forge-store.cjs');
  if (typeof store.redactText === 'function') redactFn = (v) => store.redactText(v);
  else if (typeof store.redactValue === 'function') redactFn = (v) => store.redactValue(v);
} catch { redactFn = null; }
function scrub(s) {
  if (typeof s !== 'string' || !s.length) return '';
  if (!redactFn) return '[content unavailable: redaction module missing]';
  try { const out = redactFn(s); return typeof out === 'string' ? out : '[content unavailable: redaction failed]'; }
  catch { return '[content unavailable: redaction failed]'; }
}
function capStr(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s; }
function nowIso() { return new Date().toISOString(); }
function slugify(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

// ---- paths (defense in depth: every id this file itself GENERATES is already regex-safe via slugify/
// RUN_ID_RE, but every resolved path is still checked to stay inside its intended base dir — same
// belt-and-braces discipline as forge-store.cjs / forge-dashboard/log-event.cjs). ----
function vaultDirOf(root) { return path.join(root, '.claude', 'forge-vault'); }
function runsSubdirOf(root) { return path.join(vaultDirOf(root), 'runs'); }
function decisionsSubdirOf(root) { return path.join(vaultDirOf(root), 'decisions'); }
function topicsSubdirOf(root) { return path.join(vaultDirOf(root), 'topics'); }
function runsDirOf(root) { return path.join(root, '.claude', 'forge-runs'); }
function withinBase(base, target) {
  const b = path.resolve(base), t = path.resolve(target);
  return t === b || t.startsWith(b + path.sep);
}
function safeNoteFile(dir, slug) {
  const clean = slugify(slug);
  if (!clean) return null;
  const file = path.join(dir, clean + '.md');
  return withinBase(dir, file) ? file : null;
}
/** safeRealpath(p) -> the OS-resolved real path, or null if it does not exist / cannot be resolved. Never
 *  throws. Uses realpathSync.native so this reads the actual filesystem answer (symlinks/junctions fully
 *  resolved), not Node's own JS-level path math. */
function safeRealpath(p) { try { return fs.realpathSync.native(p); } catch { return null; } }
/** isPathSafeUnderRoot(root, targetDir) -> {safe, reason?} — v2.9.0 WP-K2 (Codex F6): withinBase() above is
 *  PURELY LEXICAL (string prefix comparison), so if `.claude/forge-vault`, `.claude/forge-vault/runs`,
 *  `/decisions`, or `/topics` is ever a symlink or an NTFS junction pointing OUTSIDE the project, every
 *  lexical check still reports "inside" while the actual write lands wherever that link points. Defense in
 *  depth, same belt-and-braces spirit as the rest of this file:
 *   (1) lstat every path component between `root` and `targetDir` that already EXISTS on disk (a component
 *       that does not exist yet will be created fresh by mkdirSync, under the real root, so it is safe by
 *       construction and never lstat'd); a symlink/junction anywhere in that chain is refused outright.
 *   (2) belt-and-braces: if `targetDir` already fully exists, its OS-resolved real path must still sit
 *       inside the project's own OS-resolved real root — catches a component this walk cannot see (e.g. the
 *       root itself arriving already symlinked from the caller).
 *  Never throws. A refusal here means the vault SKIPS that one write (see renderNote) — it never throws and
 *  never fails the run; finalize is unaffected (the vault has always been a best-effort side artifact). */
function isPathSafeUnderRoot(root, targetDir) {
  const realRoot = safeRealpath(root);
  if (!realRoot) return { safe: false, reason: 'project root "' + root + '" could not be resolved' };
  const rel = path.relative(root, targetDir);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    return { safe: false, reason: 'target "' + targetDir + '" is not lexically inside the project root' };
  }
  let cur = root;
  for (const seg of rel.split(path.sep).filter(Boolean)) {
    cur = path.join(cur, seg);
    let st;
    try { st = fs.lstatSync(cur); } catch { continue; } // does not exist yet — created fresh under the real root, safe
    if (st.isSymbolicLink()) {
      return { safe: false, reason: 'refusing to write through "' + path.relative(root, cur) + '" — it is a symlink/junction, not a real directory (possible path-escape attempt)' };
    }
  }
  const realTarget = safeRealpath(targetDir);
  if (realTarget && realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
    return { safe: false, reason: 'refusing to write — the resolved vault path escapes the real project root' };
  }
  return { safe: true };
}

// ---- tiny hand-rolled YAML-ish frontmatter (zero-dependency; only ever round-trips values THIS file
// itself wrote, so a full YAML parser is unneeded — every string is quote-escaped so free-form content
// can never break out of its field or inject a new one). ----
function yamlStr(s) {
  return '"' + String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ').trim() + '"';
}
function unYamlStr(s) { return String(s == null ? '' : s).replace(/\\"/g, '"').replace(/\\\\/g, '\\'); }
function renderFrontmatter(fm) {
  const tags = Array.isArray(fm.tags) ? fm.tags : [];
  return [
    '---',
    'title: ' + yamlStr(fm.title),
    'type: ' + yamlStr(fm.type),
    'created: ' + yamlStr(fm.created || nowIso()),
    'updated: ' + yamlStr(fm.updated || nowIso()),
    'source_run: ' + (fm.source_run ? yamlStr(fm.source_run) : 'null'),
    'tags: [' + tags.map(yamlStr).join(', ') + ']',
    '---',
  ].join('\n');
}
/** parseFrontmatter(raw) -> {title,type,created,updated,source_run,tags[]} or null (no frontmatter
 *  block). Only understands the exact shape renderFrontmatter() produces (double-quoted scalars, an
 *  inline quoted-string array) — safe because nothing else ever writes these files. */
function parseFrontmatter(raw) {
  const m = String(raw || '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return null;
  const text = m[1];
  const strField = (name) => {
    const mm = text.match(new RegExp('^' + name + ':\\s*"((?:[^"\\\\]|\\\\.)*)"\\s*$', 'm'));
    return mm ? unYamlStr(mm[1]) : null;
  };
  const tagsMatch = text.match(/^tags:\s*\[(.*)\]\s*$/m);
  const tags = [];
  if (tagsMatch && tagsMatch[1].trim()) {
    const re = /"((?:[^"\\]|\\.)*)"/g;
    let mm;
    while ((mm = re.exec(tagsMatch[1]))) tags.push(unYamlStr(mm[1]));
  }
  return {
    _blockLength: m[0].length, title: strField('title'), type: strField('type'),
    created: strField('created'), updated: strField('updated'), source_run: strField('source_run'), tags,
  };
}

function readJsonSafe(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function readTextSafe(file, cap) {
  try { const s = fs.readFileSync(file, 'utf8'); return typeof cap === 'number' ? s.slice(0, cap) : s; }
  catch { return null; }
}

/** extractSectionMentioning(text, needle) -> the markdown heading block (that heading line through the
 *  line before the next heading of equal-or-shallower depth) whose heading line contains `needle`, or
 *  null. Used to pull the FORGE_DECISIONS.md / FORGE_MEMORY.md section for a given run_id — both files
 *  are hand-maintained prose with a "## ... (run <id> — ...)" heading convention; this never needs a
 *  general markdown parser because it only ever looks for one exact substring. */
function extractSectionMentioning(text, needle) {
  if (!text || !needle) return null;
  const lines = text.split(/\r?\n/);
  let start = -1, level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+/);
    if (m && lines[i].includes(needle)) { start = i; level = m[1].length; break; }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+/);
    if (m && m[1].length <= level) { end = i; break; }
  }
  return lines.slice(start, end).join('\n').trim() || null;
}

// ---- reading a run's real data (fail-safe: a missing/corrupt piece degrades quietly, never throws) ----
function readEventsFor(root, runId) {
  let entries = [];
  try {
    const logEvent = require(path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs'));
    const file = path.join(runsDirOf(root), runId, 'events.jsonl');
    if (typeof logEvent.readEventsClassified === 'function' && fs.existsSync(file)) {
      const cls = logEvent.readEventsClassified(file, { verifyChain: true, runId });
      if (cls && Array.isArray(cls.entries)) entries = cls.entries;
    }
  } catch { /* best-effort — an unreadable log yields an empty event list, never a thrown error */ }
  return entries;
}
function buildRunData(root, runId) {
  const runDir = path.join(runsDirOf(root), runId);
  const runMeta = readJsonSafe(path.join(runDir, 'run.json'));
  const entries = readEventsFor(root, runId);
  const finalReport = readTextSafe(path.join(runDir, 'final-report.md'), MAX_REPORT_READ_CHARS);
  const startedEvent = entries.find((e) => e && e.event_type === 'run_started');
  const missionRaw = (runMeta && (runMeta.mission || runMeta.request)) || (startedEvent && startedEvent.note) || null;
  const created = (runMeta && runMeta.started_at) || (entries[0] && entries[0].timestamp) || null;
  const checksPassed = entries.filter((e) => e && e.event_type === 'check_passed');
  const checksFailed = entries.filter((e) => e && e.event_type === 'check_failed');
  const decisionEvents = entries.filter((e) => e && e.event_type === 'decision_logged' && typeof e.note === 'string' && e.note.trim());
  const filesChanged = [];
  for (const e of entries) {
    if (e && e.event_type === 'file_changed' && Array.isArray(e.files_changed)) {
      for (const f of e.files_changed) if (typeof f === 'string' && f.trim()) filesChanged.push(f.trim());
    }
  }
  // v2.9.0 WP-K2 (Codex F7): cap DISTINCT files considered per run — see MAX_FILES_CONSIDERED doc comment.
  // Deduped first (a file touched by several file_changed events must count once), then capped; the true
  // total is kept so renderRunNote can disclose the truncation honestly instead of hiding it.
  const uniqueFilesChanged = [...new Set(filesChanged)];
  const filesTruncated = uniqueFilesChanged.length > MAX_FILES_CONSIDERED;
  return {
    exists: !!(runMeta || entries.length), runMeta, finalReport, missionRaw, created,
    checksPassed, checksFailed, decisionEvents,
    filesChanged: uniqueFilesChanged.slice(0, MAX_FILES_CONSIDERED),
    filesChangedTotal: uniqueFilesChanged.length, filesTruncated,
  };
}

/** collectDecisionItems — merges this run's own decision_logged events with any FORGE_DECISIONS.md /
 *  FORGE_MEMORY.md section that names this run_id (plus's WP-E input list). Capped and order-stable
 *  (event order, then decisions-log, then memory), so re-running update() for the same on-disk state
 *  always yields the same ordered list -> the same deterministic decision slugs. */
function collectDecisionItems(root, runId, data) {
  const items = [];
  for (const e of data.decisionEvents) items.push({ text: e.note.trim(), ts: e.timestamp || null, src: 'run event' });
  const decLog = readTextSafe(path.join(root, '.claude', 'FORGE_DECISIONS.md'), MAX_LOG_READ_CHARS);
  const sec1 = extractSectionMentioning(decLog, runId);
  if (sec1) items.push({ text: sec1, ts: null, src: 'FORGE_DECISIONS.md' });
  const mem = readTextSafe(path.join(root, '.claude', 'FORGE_MEMORY.md'), MAX_LOG_READ_CHARS);
  const sec2 = extractSectionMentioning(mem, runId);
  if (sec2) items.push({ text: sec2, ts: null, src: 'FORGE_MEMORY.md' });
  return items.slice(0, MAX_DECISIONS_PER_RUN);
}

// ---- topic derivation from changed file paths (ordered, most-specific-first; the LAST two rules are
// deliberate catch-alls so "tests"/"docs" never steal a match a specific tool's own rule should get). ----
const TOPIC_RULES = [
  ['gate-hook', /forge-gate|hard-gates\.json|actiongate/i],
  ['dashboard', /forge-dashboard|command-center/i],
  ['vault', /forge-vault/i],
  ['config', /forge-config|FORGE_CONFIG_SCHEMA/i],
  ['runcontract', /forge-runcontract|forge-finalize/i],
  ['sync', /forge-sync/i],
  ['installer', /forge-setup|install\.(sh|ps1|cmd)/i],
  ['doctor', /forge-doctor/i],
  ['usage-guard', /usage-guard/i],
  ['memory', /forge-memory|agent-memory/i],
  ['skills', /[\\/]skills[\\/]/i],
  ['tests', /\.test\.cjs$/i],
  ['docs', /\.md$/i],
];
function topicForFile(file) {
  for (const [slug, re] of TOPIC_RULES) if (re.test(file)) return slug;
  const base = String(file).split(/[\\/]/).pop() || '';
  const noExt = base.replace(/\.[A-Za-z0-9]{1,6}$/, ''); // strip one trailing short extension, any kind
  return slugify(noExt) || 'general';
}
/** deriveTopics(filesChanged) -> Map<topicSlug, Set<file>>, with a non-enumerable-in-spirit `.truncated`
 *  boolean flag stamped onto the returned Map when the MAX_TOPICS_PER_RUN cap actually dropped a would-be
 *  topic (v2.9.0 WP-K2, Codex F7 — thousands of distinct, TOPIC_RULES-unmatched files used to mint
 *  thousands of one-file topics; a NEW topic slug is refused once the cap is hit, but a file that matches an
 *  ALREADY-admitted slug still joins it, so the cap limits topic COUNT, never a topic's own file list).
 *  Exported for direct unit testing. */
function deriveTopics(filesChanged) {
  const map = new Map();
  let truncated = false;
  for (const f of filesChanged || []) {
    if (typeof f !== 'string' || !f.trim()) continue;
    const slug = topicForFile(f);
    if (!map.has(slug)) {
      if (map.size >= MAX_TOPICS_PER_RUN) { truncated = true; continue; }
      map.set(slug, new Set());
    }
    map.get(slug).add(f);
  }
  map.truncated = truncated;
  return map;
}

// ---- atomic, idempotent note writer ----
function canonicalizeForCompare(s) { return s.replace(/^updated: ".*"$/m, 'updated: "_"'); }
function readExistingParts(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { exists: false, created: null, manual: '\n' + MANUAL_MARKER + '\n' }; }
  const fm = parseFrontmatter(raw);
  const body = fm ? raw.slice(fm._blockLength) : raw;
  const markerIdx = body.indexOf(MANUAL_MARKER);
  const manual = markerIdx === -1 ? '\n' + MANUAL_MARKER + '\n' : body.slice(markerIdx);
  return { exists: true, created: fm ? fm.created : null, manual };
}
function writeAtomicText(file, contents) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.' + process.pid + '.' + Math.random().toString(36).slice(2, 8) + '.tmp';
  fs.writeFileSync(tmp, contents, 'utf8');
  fs.renameSync(tmp, file);
}
/** renderNote(root, file, fm, generatedBody) -> {written, file}. Never throws (a write failure is reported
 *  back, not thrown — callers stay best-effort). Preserves `created` and any hand-written manual section;
 *  skips the write entirely when nothing but `updated` would change (true idempotence, not just a cheap
 *  content diff). v2.9.0 WP-K2 (Codex F6): every write funnels through this one function, so the
 *  symlink/junction path-escape guard (isPathSafeUnderRoot) lives here ONCE rather than duplicated at each
 *  of the 4 call sites — a refusal skips just this note (written:false, skipped:true, reason), never throws,
 *  never touches the filesystem. */
function renderNote(root, file, fm, generatedBody) {
  try {
    if (!file) return { written: false, file: null };
    const safety = isPathSafeUnderRoot(root, path.dirname(file));
    if (!safety.safe) return { written: false, file, skipped: true, reason: safety.reason };
    const existing = readExistingParts(file);
    const finalCreated = existing.created || fm.created || nowIso();
    const head = renderFrontmatter(Object.assign({}, fm, { created: finalCreated, updated: nowIso() }));
    const body = capStr(String(generatedBody || '').trim(), MAX_NOTE_BODY_CHARS);
    const manual = existing.manual.replace(/^\n*/, '\n');
    const content = head + '\n\n' + body + '\n' + manual;
    if (existing.exists) {
      let oldRaw = '';
      try { oldRaw = fs.readFileSync(file, 'utf8'); } catch { /* fall through to write */ }
      if (oldRaw && canonicalizeForCompare(oldRaw) === canonicalizeForCompare(content)) return { written: false, file };
    }
    writeAtomicText(file, content);
    return { written: true, file };
  } catch (e) { return { written: false, file, error: e && e.message ? e.message : String(e) }; }
}
function scanNotesDir(dir) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { files = []; }
  const out = [];
  for (const f of files) {
    let raw = '';
    try { raw = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    out.push({ slug: f.slice(0, -3), fm: parseFrontmatter(raw) || {} });
  }
  return out;
}

// ---- note builders ----
function renderRunNote(root, runId, data, decisionRefs, topicSlugs, topicsTruncated) {
  const file = safeNoteFile(runsSubdirOf(root), runId);
  if (!file) return { written: false, file: null };
  const lines = ['# ' + runId, ''];
  const missionExcerpt = data.missionRaw ? scrub(capStr(data.missionRaw, MAX_MISSION_CHARS)).replace(/\r?\n+/g, ' ') : null;
  if (missionExcerpt) { lines.push('**Mission:**', '> ' + missionExcerpt, ''); }
  lines.push('## What changed');
  // v2.9.0 WP-K2 (Codex F7): data.filesChanged is already capped at MAX_FILES_CONSIDERED (see buildRunData)
  // — this note says so explicitly rather than silently listing a partial set with no explanation.
  if (data.filesTruncated) lines.push('_' + data.filesChangedTotal + ' files changed in this run — only the first ' + MAX_FILES_CONSIDERED + ' were indexed (topic derivation and this listing are capped for performance)._', '');
  if (data.filesChanged.length) {
    for (const f of data.filesChanged.slice(0, MAX_FILES_LISTED)) lines.push('- `' + scrub(f) + '`');
    if (data.filesChanged.length > MAX_FILES_LISTED) lines.push('- … and ' + (data.filesChanged.length - MAX_FILES_LISTED) + ' more');
  } else lines.push('- (no file_changed events recorded for this run)');
  lines.push('', '## Checks');
  const checks = [...data.checksPassed.map((e) => ['PASS', e]), ...data.checksFailed.map((e) => ['FAIL', e])];
  if (checks.length) {
    for (const [label, e] of checks.slice(0, MAX_CHECKS_LISTED)) {
      const note = scrub(capStr(e.note || '(no note)', MAX_CHECK_NOTE_CHARS)).replace(/\r?\n+/g, ' ');
      lines.push('- ' + label + ' — ' + note + (e.timestamp ? ' (' + e.timestamp + ')' : ''));
    }
  } else lines.push('- (no check_passed/check_failed events recorded for this run)');
  lines.push('', '## Decisions');
  if (decisionRefs.length) for (const d of decisionRefs) lines.push('- [[decisions/' + d + ']]');
  else lines.push('- (none recorded for this run)');
  lines.push('', '## Topics');
  if (topicSlugs.length) for (const t of topicSlugs) lines.push('- [[topics/' + t + ']]');
  else lines.push('- (none derived — no files_changed data for this run)');
  // v2.9.0 WP-K2 (Codex F7): deriveTopics() caps at MAX_TOPICS_PER_RUN — say so honestly instead of quietly
  // dropping the rest.
  if (topicsTruncated) lines.push('', '_topics capped at ' + MAX_TOPICS_PER_RUN + ' for this run — more files were changed but not indexed as separate topics._');
  return renderNote(root, file, {
    title: runId, type: 'run', created: data.created, source_run: runId,
    tags: ['run', ...topicSlugs.map((t) => 'topic:' + t)],
  }, lines.join('\n'));
}
function renderDecisionNote(root, slug, runId, item) {
  const file = safeNoteFile(decisionsSubdirOf(root), slug);
  if (!file) return { written: false, file: null };
  const text = scrub(capStr(item.text, MAX_DECISION_CHARS));
  const lines = [
    '# Decision: ' + slug, '',
    '**Source:** ' + item.src + (item.ts ? ' · ' + item.ts : ''),
    '**Run:** [[runs/' + runId + ']]', '',
    '> ' + text.replace(/\r?\n/g, '\n> '),
  ];
  return renderNote(root, file, {
    title: 'Decision ' + slug, type: 'decision', created: item.ts, source_run: runId, tags: ['decision'],
  }, lines.join('\n'));
}
/** rebuildTopicNote(root, slug, runsIndex?, decisionsIndex?) — v2.9.0 WP-K2 (Codex F7): runsIndex/
 *  decisionsIndex let updateVault() scan the runs/decisions note directories ONCE and reuse that same
 *  in-memory list for every topic, instead of this function re-scanning + re-parsing every note file on
 *  disk once PER TOPIC (O(topics x notesOnDisk) — the actual stall Codex measured with thousands of
 *  distinct files). Optional and falls back to its own scan when omitted, so direct/older callers keep
 *  working unchanged. */
function rebuildTopicNote(root, slug, runsIndex, decisionsIndex) {
  const file = safeNoteFile(topicsSubdirOf(root), slug);
  if (!file) return { written: false, file: null };
  const runsAll = runsIndex || scanNotesDir(runsSubdirOf(root));
  const matchingRuns = runsAll
    .filter((r) => Array.isArray(r.fm.tags) && r.fm.tags.includes('topic:' + slug))
    .map((r) => r.slug).sort().reverse();
  const decisionsAll = decisionsIndex || scanNotesDir(decisionsSubdirOf(root));
  const matchingDecisions = decisionsAll
    .filter((d) => d.fm.source_run && matchingRuns.includes(d.fm.source_run))
    .map((d) => d.slug).sort().reverse();
  const lines = ['# Topic: ' + slug, '', '## Runs (' + matchingRuns.length + ')'];
  if (matchingRuns.length) for (const r of matchingRuns) lines.push('- [[runs/' + r + ']]');
  else lines.push('- (none yet)');
  lines.push('', '## Decisions (' + matchingDecisions.length + ')');
  if (matchingDecisions.length) for (const d of matchingDecisions) lines.push('- [[decisions/' + d + ']]');
  else lines.push('- (none recorded yet)');
  return renderNote(root, file, {
    title: 'Topic: ' + slug, type: 'topic', created: nowIso(), source_run: null, tags: ['topic', slug],
  }, lines.join('\n'));
}
function rebuildHome(root) {
  const file = path.join(vaultDirOf(root), 'Home.md');
  const runsAll = scanNotesDir(runsSubdirOf(root)).sort((a, b) => String(b.fm.created || b.slug).localeCompare(String(a.fm.created || a.slug)));
  const decisionsAll = scanNotesDir(decisionsSubdirOf(root)).sort((a, b) => b.slug.localeCompare(a.slug));
  const topicsAll = scanNotesDir(topicsSubdirOf(root)).sort((a, b) => a.slug.localeCompare(b.slug));
  const lines = [
    '# Forge Vault', '',
    'Adapted from the note-taking pattern in claude-obsidian (github.com/AgriciDaniel/claude-obsidian, MIT), rebuilt zero-dependency for Forge.', '',
    '## Runs (' + runsAll.length + ', newest first)',
  ];
  if (runsAll.length) for (const r of runsAll) lines.push('- [[runs/' + r.slug + ']]' + (r.fm.created ? ' — ' + String(r.fm.created).slice(0, 10) : ''));
  else lines.push('- (no finished runs yet)');
  lines.push('', '## Decisions (' + decisionsAll.length + ')');
  if (decisionsAll.length) for (const d of decisionsAll) lines.push('- [[decisions/' + d.slug + ']]');
  else lines.push('- (none recorded yet)');
  lines.push('', '## Topics (' + topicsAll.length + ')');
  if (topicsAll.length) for (const tItem of topicsAll) lines.push('- [[topics/' + tItem.slug + ']]');
  else lines.push('- (none yet)');
  return renderNote(root, file, {
    title: 'Forge Vault', type: 'index', created: nowIso(), source_run: null, tags: ['vault', 'index'],
  }, lines.join('\n'));
}

/** updateVault(root, runId, opts) -> the ONE entry point. Never throws. Respects the "vault" owner
 *  setting (default on): when off, returns {ok:true, skipped:true} and writes nothing at all. When a
 *  run has neither a readable run.json nor any readable events, also writes nothing (never invents a
 *  note for a run this file cannot actually see). */
function updateVault(root, runId, opts) {
  opts = opts || {};
  root = root || PROJECT_ROOT_DEFAULT;
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) {
    return { ok: false, reason: 'invalid run_id (allowed: A-Z a-z 0-9 _ -): ' + JSON.stringify(runId) };
  }
  const cfgOpts = Object.assign({ projectRoot: root }, opts.configModule !== undefined ? { configModule: opts.configModule } : {});
  const on = configRead('vault', true, cfgOpts);
  if (on.value !== true) return { ok: true, skipped: true, reason: 'vault off (owner setting)', notes_written: 0, notes_unchanged: 0 };
  try {
    const data = buildRunData(root, runId);
    if (!data.exists) return { ok: false, skipped: true, reason: 'no run.json or readable events.jsonl found for ' + runId };

    let written = 0, unchanged = 0;
    const tally = (r) => { if (r && r.written) written++; else unchanged++; };

    const decisionItems = collectDecisionItems(root, runId, data);
    const decisionRefs = decisionItems.map((_, i) => runId + '-d' + String(i + 1).padStart(2, '0'));
    const topicMap = deriveTopics(data.filesChanged);
    const topicSlugs = [...topicMap.keys()];

    tally(renderRunNote(root, runId, data, decisionRefs, topicSlugs, topicMap.truncated === true));
    decisionItems.forEach((item, i) => tally(renderDecisionNote(root, decisionRefs[i], runId, item)));
    // v2.9.0 WP-K2 (Codex F7): scan the runs/decisions note directories ONCE for this whole call and reuse
    // that same in-memory list for every topic rebuild below, instead of rebuildTopicNote() re-scanning +
    // re-parsing every note file on disk once PER TOPIC (the actual O(topics x notesOnDisk) stall). Scanned
    // AFTER the run/decision notes above are written, so this run's own note is already reflected in it.
    const runsIndexForTopics = scanNotesDir(runsSubdirOf(root));
    const decisionsIndexForTopics = scanNotesDir(decisionsSubdirOf(root));
    for (const slug of topicSlugs) tally(rebuildTopicNote(root, slug, runsIndexForTopics, decisionsIndexForTopics));
    tally(rebuildHome(root));

    return { ok: true, skipped: false, run_id: runId, notes_written: written, notes_unchanged: unchanged, decisions: decisionRefs, topics: topicSlugs };
  } catch (e) {
    return { ok: false, reason: 'vault update failed: ' + (e && e.message ? e.message : String(e)) };
  }
}

function statusOf(root, opts) {
  opts = opts || {};
  root = root || PROJECT_ROOT_DEFAULT;
  const cfgOpts = Object.assign({ projectRoot: root }, opts.configModule !== undefined ? { configModule: opts.configModule } : {});
  const on = configRead('vault', true, cfgOpts);
  const dir = vaultDirOf(root);
  const exists = fs.existsSync(dir);
  const counts = { runs: 0, decisions: 0, topics: 0 };
  if (exists) {
    counts.runs = scanNotesDir(runsSubdirOf(root)).length;
    counts.decisions = scanNotesDir(decisionsSubdirOf(root)).length;
    counts.topics = scanNotesDir(topicsSubdirOf(root)).length;
  }
  return { ok: true, enabled: on.value === true, config_source: on.source, exists, home: fs.existsSync(path.join(dir, 'Home.md')), counts, dir };
}

module.exports = {
  updateVault, statusOf, deriveTopics, extractSectionMentioning, configRead, configOn,
  PROJECT_ROOT_DEFAULT, vaultDirOf, runsSubdirOf, decisionsSubdirOf, topicsSubdirOf,
  // v2.9.0 WP-K2 (Codex F6/F7) — exported for direct unit testing.
  isPathSafeUnderRoot, MAX_TOPICS_PER_RUN, MAX_FILES_CONSIDERED,
};

// ---- CLI ----
if (require.main === module) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const opt = (name) => { const i = argv.indexOf(name); return i !== -1 && i + 1 < argv.length ? argv[i + 1] : null; };
  const json = argv.includes('--json');
  const root = opt('--root') ? path.resolve(opt('--root')) : PROJECT_ROOT_DEFAULT;
  if (cmd === 'update') {
    const runId = opt('--run');
    if (!runId) {
      console.error('usage: node forge-vault.cjs update --run <run_id> [--root <projectRoot>] [--json]');
      process.exit(2);
    }
    const r = updateVault(root, runId, {});
    if (json) console.log(JSON.stringify(r));
    else if (r.ok && r.skipped) console.log('vault: skipped — ' + r.reason);
    else if (r.ok) console.log('vault: ' + r.notes_written + ' note(s) written, ' + r.notes_unchanged + ' unchanged -> ' + vaultDirOf(root));
    else console.error('vault: ' + r.reason);
    process.exit(r.ok ? 0 : 1);
  } else if (cmd === 'status') {
    const r = statusOf(root, {});
    if (json) console.log(JSON.stringify(r));
    else console.log('vault ' + (r.enabled ? 'ON' : 'OFF') + ' (' + r.config_source + ') · ' + r.counts.runs + ' run note(s), ' + r.counts.decisions + ' decision(s), ' + r.counts.topics + ' topic(s) -> ' + r.dir);
    process.exit(0);
  } else {
    console.error('usage: node forge-vault.cjs update --run <run_id> [--root <projectRoot>] [--json]');
    console.error('       node forge-vault.cjs status [--root <projectRoot>] [--json]');
    process.exit(2);
  }
}
