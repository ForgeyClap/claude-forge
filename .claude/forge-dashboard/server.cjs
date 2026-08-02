#!/usr/bin/env node
/**
 * Forge Control Center — project-local dashboard server (zero dependencies).
 *
 * PER-PROJECT and ISOLATED: serves the UI + a JSON API + a live SSE stream that
 * read ONLY this project's .claude/ (forge-runs + FORGE_*.md). Never reads other
 * projects, never writes outside this project's .claude/forge-dashboard/.
 *
 * Live updates: GET /api/events/stream (Server-Sent Events) tails the latest run's
 * events.jsonl and pushes new events to the browser. The frontend falls back to
 * efficient polling (250ms; 100ms fast mode) if SSE is unavailable. No fake data.
 *
 * Port: deterministic per project (3737-3999, hash of path) in .claude/forge-dashboard/PORT.
 *
 * Modes:
 *   node server.cjs                 # start the dashboard
 *   node server.cjs --assign-only   # write PORT + DASHBOARD_STATE.json, then exit
 *   node server.cjs --status        # print project-local status (port, run, events, memory)
 *   node server.cjs --runs          # list project-local runs
 *   node server.cjs --open-report    # print latest final report
 *   node server.cjs --health        # ping the running dashboard's /api/health
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
// Defense-in-depth: one bad request/tick must never kill the whole per-project dashboard.
process.on('uncaughtException', (e) => { try { console.error('[forge-dashboard] uncaught:', e && e.message); } catch {} });
process.on('unhandledRejection', (e) => { try { console.error('[forge-dashboard] unhandled rejection:', e && e.message); } catch {} });

const crypto = require('crypto');
const SCRIPT_DIR = __dirname;
const DASH_DIR = __dirname;
const safeRead = (p) => { try { const s = fs.readFileSync(p, 'utf8'); return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s; } catch { return null; } };
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };

// --- STRICT PROJECT ROOT DETECTION (isolation) ---
// Priority: explicit FORGE_PROJECT_ROOT override -> the server's own install location (__dirname/../..).
// __dirname is authoritative because the dashboard is a PER-PROJECT install (the server lives inside the project it serves);
// cwd is reported in /api/health for transparency but never trusted. The global template is never served as a project.
function detectProjectRoot() {
  // env override is only honored when it points at THIS server's own install (realpath match) —
  // it may not redirect an installed dashboard to serve a different project's memory/runs.
  const envRoot = process.env.FORGE_PROJECT_ROOT;
  if (envRoot) {
    try {
      const candidate = path.join(envRoot, '.claude', 'forge-dashboard', 'server.cjs');
      if (exists(candidate) && fs.realpathSync(candidate) === fs.realpathSync(__filename)) return path.resolve(envRoot);
      console.error('[forge-dashboard] FORGE_PROJECT_ROOT ignored: it does not contain THIS server install (' + envRoot + ')');
    } catch { /* ignore malformed override */ }
  }
  return path.resolve(__dirname, '..', '..');
}
const PROJECT_DIR = detectProjectRoot();
const PROJECT_POSIX = PROJECT_DIR.split(path.sep).join('/');
const IS_TEMPLATE = /\/forge\/template(\/|$)/.test(PROJECT_POSIX); // never serve the global Forge template as a project
const PROJECT_NAME = path.basename(PROJECT_DIR);
const PROJECT_ID = PROJECT_NAME + ':' + crypto.createHash('sha1').update(PROJECT_DIR).digest('hex').slice(0, 8);
const CLAUDE_DIR = path.join(PROJECT_DIR, '.claude');
const RUNS_DIR = path.join(CLAUDE_DIR, 'forge-runs');
const PORT_FILE = path.join(DASH_DIR, 'PORT');
const STATE_FILE = path.join(DASH_DIR, 'DASHBOARD_STATE.json');
const SESSION_FILE = path.join(CLAUDE_DIR, 'FORGE_SESSION_STATE.json');
const MEMORY_FILE = path.join(CLAUDE_DIR, 'FORGE_MEMORY.md');
const MEMORY_FILES = ['FORGE_PROJECT_PROFILE.md', 'FORGE_MEMORY.md', 'FORGE_DECISIONS.md', 'FORGE_TASK_HISTORY.md', 'FORGE_AGENT_LEDGER.md', 'FORGE_SKILL_REGISTRY.md'];
const PORT_LO = 3737, PORT_HI = 3999, PORT_SPAN = PORT_HI - PORT_LO + 1;
const STREAM_INTERVAL = 250;
const DEFAULT_SETTINGS = { refresh_mode: 'sse', polling_interval_ms: 250, fast_mode: false, auto_scroll_logs: true, compact_mode: false, layout_version: 'forge-studio-v7' };
let CURRENT_PORT = PORT_LO;
let STATE_RESET = false; // set true when stale cross-project DASHBOARD_STATE was detected + reset

function hashPort(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return PORT_LO + (h % PORT_SPAN); }
function preferredPort() {
  const fromFile = parseInt((safeRead(PORT_FILE) || '').trim(), 10);
  if (Number.isInteger(fromFile) && fromFile >= PORT_LO && fromFile <= PORT_HI) return fromFile;
  const fromEnv = parseInt(process.env.FORGE_DASHBOARD_PORT || '', 10);
  if (Number.isInteger(fromEnv) && fromEnv >= PORT_LO && fromEnv <= PORT_HI) return fromEnv;
  return hashPort(PROJECT_DIR);
}
function nextPort(p) { return p + 1 > PORT_HI ? PORT_LO : p + 1; }

function listRunIds() {
  if (!exists(RUNS_DIR)) return [];
  return fs.readdirSync(RUNS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort().reverse();
}
function readRun(id) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null; // run ids are alphanumeric + _ - only — reject any path chars (no traversal)
  const dir = path.join(RUNS_DIR, id);
  const base = path.resolve(RUNS_DIR), resolved = path.resolve(dir);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null; // belt-and-suspenders containment
  if (!exists(dir)) return null;
  let run = {};
  const rj = safeRead(path.join(dir, 'run.json'));
  if (rj) { try { run = JSON.parse(rj); } catch { run = { parse_error: true }; } }
  run.run_id = run.run_id || id;
  const events = []; let malformed = 0;
  const ev = safeRead(path.join(dir, 'events.jsonl'));
  if (ev) for (const line of ev.split(/\r?\n/)) { const t = line.trim(); if (!t) continue; try { const v = JSON.parse(t); if (v && typeof v === 'object' && !Array.isArray(v)) events.push(v); else malformed++; } catch { malformed++; } }
  return { run, events, report: safeRead(path.join(dir, 'final-report.md')), malformed };
}
function memoryState() {
  const out = {};
  for (const f of MEMORY_FILES) {
    const p = path.join(CLAUDE_DIR, f);
    if (exists(p)) { const s = fs.statSync(p); out[f] = { exists: true, mtime: s.mtime.toISOString(), content: safeRead(p) }; }
    else out[f] = { exists: false };
  }
  return out;
}
function latestRunId() { // newest by run.json started timestamp; fall back to lexicographic id order on ties/missing
  const ids = listRunIds();
  if (!ids.length) return null;
  let best = null, bestT = -Infinity;
  for (const id of ids) {
    let t = NaN;
    const rj = safeRead(path.join(RUNS_DIR, id, 'run.json'));
    if (rj) { try { t = Date.parse(JSON.parse(rj).started); } catch {} }
    if (Number.isFinite(t)) { if (t > bestT) { bestT = t; best = id; } }
    else if (best === null && bestT === -Infinity) best = best || null; // keep scanning for a dated run
  }
  return best || ids[0]; // ids already sorted desc → ids[0] is the lexicographic fallback
}
function eccMode() { // ECC-first default: Normal ON, Full Test OFF. Reads .claude/FORGE_ECC_MODE.json (+ ECC_TEST_MODE.md opt-in marker).
  let normal = 'on', full = 'off';
  const raw = safeRead(path.join(CLAUDE_DIR, 'FORGE_ECC_MODE.json'));
  if (raw) { try { const m = JSON.parse(raw); if (m.ecc_normal_mode) normal = String(m.ecc_normal_mode); if (m.ecc_full_test_mode) full = String(m.ecc_full_test_mode); } catch {} }
  if (exists(path.join(CLAUDE_DIR, 'ECC_TEST_MODE.md'))) full = 'on';
  return { normal, full_test: full };
}
function sessionMode() { // Forge Session Mode (project-local): off | on | paused. Default off until /forge or "gebruik Forge" starts it.
  let mode = 'off', since = '', last = '';
  const raw = safeRead(path.join(CLAUDE_DIR, 'FORGE_SESSION_STATE.json'));
  if (raw) { try { const s = JSON.parse(raw); if (s.mode) mode = String(s.mode); since = s.since || ''; last = s.last_activity || ''; } catch {} }
  return { mode, since, last_activity: last };
}
function readSettings() {
  const raw = safeRead(STATE_FILE);
  if (raw) { try { const s = JSON.parse(raw).settings; if (s) return Object.assign({}, DEFAULT_SETTINGS, s); } catch {} }
  return Object.assign({}, DEFAULT_SETTINGS);
}
function writeState(status) {
  const state = {
    project_name: PROJECT_NAME, project_folder: PROJECT_DIR, project_id: PROJECT_ID, created_for: 'this project only',
    server_pid: process.pid,
    preferred_port: preferredPort(), last_actual_port: CURRENT_PORT, last_url: 'http://localhost:' + CURRENT_PORT,
    last_started_at: new Date().toISOString(), status, latest_run_id: latestRunId(),
    settings: readSettings(),
  };
  try { fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state, null, 2) + '\n', 'utf8'); fs.renameSync(STATE_FILE + '.tmp', STATE_FILE); } catch { try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n', 'utf8'); } catch {} } // atomic write (tmp+rename), plain-write fallback
  return state;
}
function writePortFile(port) { try { fs.writeFileSync(PORT_FILE, String(port) + '\n', 'utf8'); } catch {} }
// Detect a DASHBOARD_STATE.json copied from a DIFFERENT project root -> back it up + flag reset (state is rewritten fresh on start).
function validateState() {
  const raw = safeRead(STATE_FILE); if (!raw) return 'OK';
  let s; try { s = JSON.parse(raw); } catch { return 'OK'; }
  const stateRoot = s.project_folder ? path.resolve(s.project_folder) : null;
  if (stateRoot && stateRoot !== PROJECT_DIR) { try { fs.writeFileSync(STATE_FILE + '.mismatch.bak', raw, 'utf8'); } catch {} STATE_RESET = true; return 'STATE_PROJECT_MISMATCH'; }
  return 'OK';
}
// Lightweight run metadata (run.json only — no event parsing) for isolation scans + run lists.
function readRunMeta(id) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  const rj = safeRead(path.join(RUNS_DIR, id, 'run.json'));
  if (!rj) return {};
  try { return JSON.parse(rj); } catch { return { parse_error: true }; }
}
// Windows paths are case-insensitive and the drive letter case can differ ("c:" vs "C:") + slash style
// varies — compare normalized so an old run.json with a lowercase drive doesn't false-positive as a
// cross-project mismatch (fix 2026-07-09 UI checkup).
function _normPath(p) { return path.resolve(String(p)).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(); }
function runMismatch(meta) { const rf = meta && meta.project_folder; return !!(rf && _normPath(rf) !== _normPath(PROJECT_DIR)); }
// Overall isolation status for /api/health (never serve template / cross-project state or runs).
// Scans EVERY run's project_folder (cheap: run.json only) — not just the latest.
function isolationStatus() {
  if (IS_TEMPLATE) return 'PROJECT_ROOT_MISMATCH';
  if (STATE_RESET) return 'STATE_PROJECT_MISMATCH';
  for (const id of listRunIds()) { if (runMismatch(readRunMeta(id))) return 'RUN_PROJECT_MISMATCH'; }
  return 'OK';
}

// WP2 Agent Board: the 12 permanent Bosses (config/agents/agent-registry.json). Read-only, honest —
// missing/broken registry -> [] (never throws, never invents a Boss that isn't in the file).
function readBosses() {
  const raw = safeRead(path.join(CLAUDE_DIR, 'config', 'agents', 'agent-registry.json'));
  if (!raw) return [];
  try {
    const reg = JSON.parse(raw);
    const agents = (reg && reg.agents) || {};
    return Object.keys(agents).map((slug) => {
      const a = agents[slug] || {};
      return { slug, name: a.name || slug, role: a.role || '', responsibilities: a.responsibilities || '' };
    });
  } catch { return []; }
}

// WP3 PRD viewer: read-only list of generated PRDs (.claude/forge-prd/*.meta.json, written by
// forge-bin/forge-prd.cjs). Fully guarded, BOM-tolerant (via safeRead) — missing dir -> [];
// unreadable/malformed file -> skipped; never throws (mirrors readBosses() honesty pattern).
// This function is READ-ONLY: it never writes, and no write endpoint exists for PRDs.
const PRD_SECTION_KEYS = ['goal', 'users', 'problem', 'solution', 'modules', 'user_stories', 'mvp_scope', 'non_goals', 'architecture', 'risks', 'acceptance_criteria', 'test_plan', 'roadmap'];
function _prdSectionHasContent(v) { if (v == null) return false; if (typeof v === 'string') return v.trim().length > 0; if (Array.isArray(v)) return v.length > 0; return false; }
function _prdAcceptanceCount(v) { if (Array.isArray(v)) return v.length; if (typeof v === 'string' && v.trim()) return 1; return 0; }
function readPrds() {
  const dir = path.join(CLAUDE_DIR, 'forge-prd');
  if (!exists(dir)) return [];
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.meta.json')); } catch { return []; }
  const out = [];
  for (const f of files) {
    const raw = safeRead(path.join(dir, f));
    if (!raw) continue;
    let json;
    try { json = JSON.parse(raw); } catch { continue; }
    if (!json || typeof json !== 'object') continue;
    const sections = (json.sections && typeof json.sections === 'object') ? json.sections : {};
    out.push({
      prd_id: json.prd_id || f.replace(/\.meta\.json$/, ''),
      title: json.title || '(untitled)',
      project: json.project || '',
      created: json._generated || json.created || '',
      sections_present: PRD_SECTION_KEYS.filter((k) => _prdSectionHasContent(sections[k])),
      acceptance_count: _prdAcceptanceCount(sections.acceptance_criteria),
    });
  }
  out.sort((a, b) => String(b.created).localeCompare(String(a.created)));
  return out;
}

// WP4 Mind Map viewer: read-only list of generated mind maps (.claude/forge-mindmaps/*.json, written
// by forge-bin/forge-mindmap.cjs). Fully guarded, BOM-tolerant (via safeRead) — missing dir -> [];
// unreadable/malformed file -> skipped; never throws (mirrors readPrds()/readBosses() honesty pattern).
// Only "<id>.json" entity files are read — the ".mmd" mermaid sidecar, the ".md" outline sidecar, and
// "index.jsonl" are excluded by the ".json" suffix filter. READ-ONLY: no write endpoint exists.
function readMindmaps() {
  const dir = path.join(CLAUDE_DIR, 'forge-mindmaps');
  if (!exists(dir)) return [];
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const f of files) {
    const raw = safeRead(path.join(dir, f));
    if (!raw) continue;
    let json;
    try { json = JSON.parse(raw); } catch { continue; }
    if (!json || typeof json !== 'object') continue;
    out.push({
      map_id: json.map_id || f.replace(/\.json$/, ''),
      title: json.title || '',
      nodes: Array.isArray(json.nodes) ? json.nodes : [],
      edges: Array.isArray(json.edges) ? json.edges : [],
      created: json._generated || json.created || '',
    });
  }
  out.sort((a, b) => String(b.created).localeCompare(String(a.created)));
  return out;
}

// WP5 Ticket board: read-only list of stored tickets (.claude/forge-tickets/*.json, written by
// forge-bin/forge-store.cjs directly or via forge-prd.cjs's criteriaToTickets()). Fully guarded,
// BOM-tolerant (via safeRead) — missing dir -> []; unreadable/malformed file -> skipped; never throws
// (mirrors readPrds()/readMindmaps() honesty pattern). Only "<id>.json" entity files are read —
// "index.jsonl" is explicitly excluded. READ-ONLY: no write endpoint exists for tickets.
function readTickets() {
  const dir = path.join(CLAUDE_DIR, 'forge-tickets');
  if (!exists(dir)) return [];
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'index.jsonl'); } catch { return []; }
  const out = [];
  for (const f of files) {
    const raw = safeRead(path.join(dir, f));
    if (!raw) continue;
    let json;
    try { json = JSON.parse(raw); } catch { continue; }
    if (!json || typeof json !== 'object') continue;
    out.push({
      ticket_id: json.ticket_id || f.replace(/\.json$/, ''),
      prd_id: json.prd_id || '',
      run_id: json.run_id || '',
      title: json.title || '(untitled)',
      owner: json.owner || '',
      status: json.status || 'open',
      risk_level: json.risk_level || '',
      created: json.created || json._stored || '',
    });
  }
  out.sort((a, b) => String(b.created).localeCompare(String(a.created)));
  return out;
}

// WP5 Vault: read-only METADATA list of stored artifacts (.claude/forge-artifacts/*.json, written by
// forge-bin/forge-artifact.cjs / forge-store.cjs). Only lightweight fields are read here — big artifact
// bodies are never inlined into /api/state; the full record is fetched on demand via the read-only,
// containment-guarded GET /api/artifact/<id>. Same guarded/BOM-tolerant/never-throws pattern as readPrds().
function readArtifacts() {
  const dir = path.join(CLAUDE_DIR, 'forge-artifacts');
  if (!exists(dir)) return [];
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'index.jsonl'); } catch { return []; }
  const out = [];
  for (const f of files) {
    const raw = safeRead(path.join(dir, f));
    if (!raw) continue;
    let json;
    try { json = JSON.parse(raw); } catch { continue; }
    if (!json || typeof json !== 'object') continue;
    out.push({
      artifact_id: json.artifact_id || f.replace(/\.json$/, ''),
      kind: json.kind || '',
      title: json.title || '(untitled)',
      produced_by: json.produced_by || '',
      run_id: json.run_id || '',
      created: json.created || json._stored || '',
    });
  }
  out.sort((a, b) => String(b.created).localeCompare(String(a.created)));
  return out;
}

// V9-INTEGRATE (2026-07-22): "Capabilities & Enforcement" panel — GET /api/capabilities (forge-capabilities.cjs
// report()) and GET /api/runcontract?run=<id> (forge-runcontract.cjs check()). Lazy, guarded requires of the
// sibling forge-bin tools — SOFT dependency, same discipline forge-doctor.cjs already uses for its own soft
// siblings (forge-sync.cjs/forge-verify.cjs): a missing/broken tool degrades the two endpoints honestly
// ({ok:false, error}) instead of crashing the whole dashboard. Both tools are pure fs/path readers (never
// spawn a subprocess, never write), so requiring them at server start carries no side effects.
let capsTool = null;
try { capsTool = require(path.join(CLAUDE_DIR, 'forge-bin', 'forge-capabilities.cjs')); } catch { capsTool = null; }
let rcTool = null;
try { rcTool = require(path.join(CLAUDE_DIR, 'forge-bin', 'forge-runcontract.cjs')); } catch { rcTool = null; }

// V9-INTEGRATE (2026-07-22): readCapabilities()/readRunContract() are the PURE, exported read functions behind
// GET /api/capabilities and GET /api/runcontract — extracted out of the inline route handler (mirroring the
// readDoctor()/readBossAgents() convention already established above) SPECIFICALLY so a test can exercise the
// real route logic (real capsTool.report()/rcTool.check() calls against THIS project's real .claude/, real
// honest-degrade shape when a sibling tool is unavailable/throws) without binding a port or spinning up an
// HTTP server — same "require server.cjs, call the exported pure function directly" discipline every other
// forge-dashboard test in this project already uses (forge-artifact-endpoint.test.cjs, forge-doctor-panel.test.cjs).
// Never mutates PROJECT_DIR/CLAUDE_DIR; always reads the real, single, per-install project this server serves.
function readCapabilities() {
  if (!capsTool) return { ok: false, error: 'forge-capabilities.cjs not available', capabilities: [], summary: null };
  try { return Object.assign({ ok: true }, capsTool.report({ root: PROJECT_DIR })); }
  catch (e) { return { ok: false, error: e.message, capabilities: [], summary: null }; }
}
function readRunContract(runId, domain) {
  if (!rcTool) return { ok: false, error: 'forge-runcontract.cjs not available', run_id: runId };
  try { return rcTool.check({ run_id: runId, domain: domain || null }, { root: PROJECT_DIR }); }
  catch (e) { return { ok: false, error: e.message, run_id: runId }; }
}
// Cross-run analytics panel (2026-07-24): READ-ONLY read of the STATS.json that forge-stats.cjs already
// computes (its only write) — the dashboard previously never surfaced it. Never runs forge-stats itself
// (that walks every run + writes the file); it only serves the already-computed aggregate. Missing/malformed
// STATS.json degrades honestly to {ok:false, error} with an empty perBoss — never a fabricated stat.
function readStats() {
  const raw = safeRead(path.join(RUNS_DIR, 'STATS.json'));
  if (raw == null) return { ok: false, error: 'no STATS.json yet — run forge-stats.cjs after some runs', perBoss: {}, runs_scanned: 0 };
  try { return Object.assign({ ok: true }, JSON.parse(raw)); }
  catch (e) { return { ok: false, error: 'STATS.json parse error: ' + e.message, perBoss: {}, runs_scanned: 0 }; }
}

// WP7 Doctor: newest run's doctor.json (forge-bin/forge-doctor.cjs), compacted for the Doctor panel +
// the Project Registry's test_status. Guarded/never-throws; returns null when no doctor run exists yet.
function readDoctor() {
  let ids; try { ids = listRunIds(); } catch { return null; }
  for (const id of ids) {
    const raw = safeRead(path.join(CLAUDE_DIR, 'forge-runs', id, 'doctor.json'));
    if (!raw) continue;
    let d; try { d = JSON.parse(raw); } catch { continue; }
    if (!d || typeof d !== 'object' || !d.checks) continue;
    const c = d.checks, g = (x, k, dflt) => (x && x[k] != null ? x[k] : dflt);
    return {
      run_id: id, ok: !!d.ok, generated_at: d.generated_at || '',
      node_check: { ok: !!g(c.node_check, 'ok', false), total: g(c.node_check, 'total', 0) },
      tests: { ok: !!g(c.tests, 'ok', false), passed: g(c.tests, 'passed', 0), failed: g(c.tests, 'failed', 0), suites: g(c.tests, 'suites', 0) },
      strict_events: { ok: !!g(c.strict_events, 'ok', false) },
      dashboard_spa: { ok: !!g(c.dashboard_spa, 'ok', false) },
      leak_scan: { ok: !!g(c.leak_scan, 'ok', false), scanned: g(c.leak_scan, 'scanned', 0), hits: (c.leak_scan && Array.isArray(c.leak_scan.hits)) ? c.leak_scan.hits.length : 0 },
    };
  }
  return null;
}

// WP8 Bosses panel: read-only per-Boss agent-file + memory-lesson-count view. Reuses readBosses() (WP2, the
// single source of truth for "which 12 Bosses exist" = config/agents/agent-registry.json) for the roster —
// never a second hardcoded name list. For each Boss, reads .claude/agents/<slug>.md frontmatter for
// model/tools (same shape as forge-bin/forge-doctor.cjs's parseFrontmatter, duplicated locally so this
// dashboard never requires forge-bin/ at runtime) + counts TOP-LEVEL "- " bullets under "## Lessons" in
// .claude/agent-memory/<slug>/MEMORY.md. GUARDED (safeRead never throws, never invents a Boss). SECURITY:
// exposes ONLY the lesson COUNT, never memory file content/text.
function _parseAgentFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) { const mm = line.match(/^([A-Za-z_]+):\s*(.*)$/); if (mm) fm[mm[1]] = mm[2].trim(); }
  return fm;
}
function _bossToolTier(tools) {
  const s = String(tools || '');
  if (!s || s === '—') return '—'; // Review Boss LOW-fix 2026-07-10: a missing/frontmatter-less agent file must
  //   degrade the tier column to '—' too — never assert 'read-only' (a capability) for a file we couldn't read.
  if (/\bBash\b/.test(s)) return 'balanced';
  if (/\bWrite\b/.test(s) || /\bEdit\b/.test(s)) return 'orchestrator';
  return 'read-only';
}
function _bossLessonCount(memRaw) {
  if (!memRaw) return 0;
  const h = memRaw.match(/^##\s*Lessons\s*$/m);
  if (!h) return 0;
  const rest = memRaw.slice(memRaw.indexOf(h[0]) + h[0].length);
  const stop = rest.search(/^#{1,6}\s/m);
  const section = stop === -1 ? rest : rest.slice(0, stop);
  return (section.match(/^-\s+/gm) || []).length; // top-level bullets ONLY — indented sub-bullets don't count
}
function readBossAgents() {
  const roster = readBosses(); // [{slug, name, role, responsibilities}, ...] — never duplicated here
  return roster.map((b) => {
    let model = '—', tools = '—';
    const raw = safeRead(path.join(CLAUDE_DIR, 'agents', b.slug + '.md'));
    if (raw) { const fm = _parseAgentFrontmatter(raw); if (fm) { model = fm.model || '—'; tools = fm.tools || '—'; } }
    const memRaw = safeRead(path.join(CLAUDE_DIR, 'agent-memory', b.slug, 'MEMORY.md'));
    return { slug: b.slug, name: b.name || b.slug, model, tools, tool_tier: _bossToolTier(tools), memory_lessons: _bossLessonCount(memRaw) };
  });
}

// WP5 Vault: containment-guarded id validation + path resolution for GET /api/artifact/<id> — SAME shape
// as readRun()'s guard above (regex allowlist + belt-and-suspenders startsWith(base+sep) containment).
// Exported (module.exports below) so tests can exercise the guard without requiring server.cjs to bind a port.
// V9-INTEGRATE (2026-07-22): GET /api/runcontract?run=<id> reuses the SAME run-id allowlist regex every
// other guarded route here already uses (log-event.cjs / /api/run / /api/artifact) — no new containment
// pattern invented. Exported so it can be exercised offline without binding a port (same discipline as
// artifactIdOk above).
function runIdOk(id) { return typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id); }
function artifactIdOk(id) { return typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id); }
function resolveArtifactPath(id) {
  if (!artifactIdOk(id)) return null;
  const dir = path.join(CLAUDE_DIR, 'forge-artifacts');
  const file = path.join(dir, id + '.json');
  const base = path.resolve(dir), resolved = path.resolve(file);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null; // belt-and-suspenders containment
  return file;
}

function buildState() {
  const ids = listRunIds();
  return {
    project: { name: PROJECT_NAME, dir: PROJECT_DIR, id: PROJECT_ID, isolation: isolationStatus() },
    port: CURRENT_PORT, generated_at: new Date().toISOString(), settings: readSettings(),
    runs: ids.map((id) => { const run = readRunMeta(id) || {}; return { id, status: run.status || 'unknown', request: run.request || '', started: run.started || '', project_mismatch: runMismatch(run) || undefined }; }),
    latest: ids.length ? readRun(ids[0]) : null,
    memory: memoryState(),
    ecc_mode: eccMode(),
    session: sessionMode(),
    bosses: readBosses(),
    prds: readPrds(),
    mindmaps: readMindmaps(),
    tickets: readTickets(),
    artifacts: readArtifacts(),
    doctor: readDoctor(),
    boss_agents: readBossAgents(),
  };
}

// ---------- CLI modes ----------
const ARGV = process.argv.slice(2);
if (ARGV.includes('--assign-only')) {
  const p = preferredPort(); CURRENT_PORT = p;
  if (!exists(PORT_FILE)) writePortFile(p);
  writeState('installed');
  console.log('Forge dashboard port assigned: ' + p + '  (http://localhost:' + p + ')');
  console.log('PORT + DASHBOARD_STATE.json written in .claude/forge-dashboard/. Dashboard not started.');
  process.exit(0);
}
if (ARGV.includes('--status')) {
  const p = preferredPort(); const ids = listRunIds(); const latest = ids[0] ? readRun(ids[0]) : null;
  const st = readSettings();
  console.log('Forge status — ' + path.basename(PROJECT_DIR));
  console.log('  project folder : ' + PROJECT_DIR);
  console.log('  dashboard port : ' + p + '   URL: http://localhost:' + p);
  console.log('  update mode    : ' + st.refresh_mode + ' (SSE /api/events/stream; polling fallback ' + st.polling_interval_ms + 'ms' + (st.fast_mode ? ', fast 100ms' : '') + ')');
  console.log('  latest run     : ' + (ids[0] || '(none)'));
  console.log('  events         : ' + (latest ? latest.events.length : 0) + (latest && latest.malformed ? ('  (' + latest.malformed + ' malformed, skipped)') : ''));
  console.log('  total runs     : ' + ids.length);
  console.log('  memory files   :');
  for (const f of MEMORY_FILES) console.log('    [' + (exists(path.join(CLAUDE_DIR, f)) ? 'x' : ' ') + '] ' + f);
  const rp = ids[0] ? path.join(RUNS_DIR, ids[0], 'final-report.md') : null;
  console.log('  latest report  : ' + (rp && exists(rp) ? rp : '(none)'));
  process.exit(0);
}
if (ARGV.includes('--runs')) {
  const ids = listRunIds();
  if (!ids.length) { console.log('No runs yet in ' + RUNS_DIR); process.exit(0); }
  console.log('Forge runs (' + path.basename(PROJECT_DIR) + ', newest first):');
  for (const id of ids) { const r = readRun(id); const run = (r && r.run) || {}; console.log('  ' + id + '  [' + (run.status || '?') + ']  ' + (run.request || '')); }
  process.exit(0);
}
if (ARGV.includes('--open-report')) {
  const ids = listRunIds();
  if (!ids.length) { console.log('No runs yet.'); process.exit(0); }
  const rp = path.join(RUNS_DIR, ids[0], 'final-report.md');
  console.log('Latest report: ' + rp + '\n');
  console.log(safeRead(rp) || '(no final-report.md for the latest run yet)');
  process.exit(0);
}
if (ARGV.includes('--health')) {
  const p = preferredPort();
  const req = http.get({ host: '127.0.0.1', port: p, path: '/api/health', timeout: 2500 }, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => { console.log('Dashboard health (port ' + p + '): ' + d); process.exit(0); }); });
  req.on('timeout', () => req.destroy());
  req.on('error', (e) => { console.log('Dashboard not running on port ' + p + ' (' + e.message + '). Start it: node .claude/forge-dashboard/server.cjs'); process.exit(0); });
  return;
}

// ---------- HTTP server + SSE ----------
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/lenses.js': ['lenses.js', 'text/javascript; charset=utf-8'],
  '/panels.js': ['panels.js', 'text/javascript; charset=utf-8'],
  '/graph.js': ['graph.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
};

const sseClients = new Set();
function sseSend(res, event, dataObj) { try { res.write('event: ' + event + '\ndata: ' + JSON.stringify(dataObj) + '\n\n'); } catch {} }

function streamTick() {
  if (sseClients.size === 0) return;
  const ids = listRunIds();
  const latestId = ids[0] || null;
  const r = latestId ? readRun(latestId) : { run: {}, events: [], report: null, malformed: 0 };
  for (const res of sseClients) {
    if (res.writableEnded) { sseClients.delete(res); continue; }
    if (res._runId !== latestId) {
      res._runId = latestId; res._sent = 0; res._report = undefined;
      sseSend(res, 'run', { run: r.run, malformed: r.malformed, runs: ids.length });
    }
    if (r.events.length > res._sent) {
      const fresh = r.events.slice(res._sent); res._sent = r.events.length;
      sseSend(res, 'events', { events: fresh, total: r.events.length, malformed: r.malformed });
    }
    if (r.report && res._report !== r.report) { res._report = r.report; sseSend(res, 'report', { report: r.report }); }
  }
}
const t1 = setInterval(streamTick, STREAM_INTERVAL); if (t1.unref) t1.unref();
const t2 = setInterval(() => { for (const res of sseClients) sseSend(res, 'ping', { t: Date.now() }); }, 15000); if (t2.unref) t2.unref();

// ── DNS-REBINDING + CROSS-SITE GUARD (security fix 2026-07-11) ──────────────────────────────────────
// Binding to 127.0.0.1 is NOT enough: a malicious web page whose domain re-resolves to 127.0.0.1
// (DNS-rebinding) can fetch /api/state and read full memory content + absolute project paths. Two checks:
// (1) the Host header must be a localhost name — a rebinding attack still carries the ATTACKER's Host;
// (2) cross-site browser requests to /api/* are rejected via Sec-Fetch-Site / Origin. Legit same-origin
// dashboard traffic and CLI/Playwright health checks (Host: localhost|127.0.0.1) pass untouched.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
function hostName(req) {
  const h = String((req.headers && req.headers.host) || '');
  if (!h) return '';
  try { return new URL('http://' + h).hostname.toLowerCase(); } catch { return h.toLowerCase(); }
}
function hostOk(req) { const h = hostName(req); return h === '' || LOCAL_HOSTS.has(h); }
function crossSiteOk(req) {
  const sfs = String((req.headers && req.headers['sec-fetch-site']) || '').toLowerCase();
  if (sfs && sfs !== 'same-origin' && sfs !== 'same-site' && sfs !== 'none') return false; // cross-site browser fetch
  const origin = req.headers && req.headers.origin;
  if (origin) { try { if (!LOCAL_HOSTS.has(new URL(origin).hostname.toLowerCase())) return false; } catch { return false; } }
  return true;
}

function handler(req, res) {
  let parsed; try { parsed = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); return res.end('bad request'); }
  const pathname = parsed.pathname;
  // Security: reject non-localhost Host (DNS-rebinding) on everything, and cross-site browser access to /api/*.
  if (!hostOk(req)) { res.writeHead(403, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'forbidden host — Forge dashboard is localhost-only (DNS-rebinding blocked)' })); }
  if (pathname.startsWith('/api/') && !crossSiteOk(req)) { res.writeHead(403, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'cross-site request blocked' })); }

  if (req.method === 'GET' && STATIC[pathname]) {
    const [file, type] = STATIC[pathname];
    const body = safeRead(path.join(DASH_DIR, file));
    if (body == null) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); return res.end(body);
  }
  if (pathname === '/api/events/stream') {
    if (sseClients.size >= 25) { res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '5' }); return res.end(JSON.stringify({ error: 'too many SSE clients (cap 25) — close stale tabs or use polling' })); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    res._runId = undefined; res._sent = 0; res._report = undefined;
    sseClients.add(res);
    streamTick();
    req.on('close', () => sseClients.delete(res));
    return;
  }
  if (pathname === '/api/health') {
    const latestId = latestRunId(); const lr = latestId ? readRun(latestId) : null;
    const latestRunRoot = lr && lr.run && lr.run.project_folder ? lr.run.project_folder : null;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({
      ok: true, dashboard: 'Forge Control Center',
      project_name: PROJECT_NAME, project_root: PROJECT_DIR, project_folder: PROJECT_DIR, project_id: PROJECT_ID,
      dashboard_port: CURRENT_PORT, port: CURRENT_PORT, server_pid: process.pid,
      cwd: process.cwd(), script_dir: SCRIPT_DIR,
      port_file_path: PORT_FILE, dashboard_state_path: STATE_FILE, runs_path: RUNS_DIR, memory_path: MEMORY_FILE, session_state_path: SESSION_FILE,
      latest_run_id: latestId, latest_run_project_root: latestRunRoot,
      isolation_status: isolationStatus(), state_reset: STATE_RESET, is_template: IS_TEMPLATE,
      sse_clients: sseClients.size,
    }));
  }
  if (pathname === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify(buildState()));
  }
  if (pathname === '/api/runs') {
    const ids = listRunIds();
    const runs = ids.map((id) => { const r = readRun(id); const run = (r && r.run) || {}; return { id, status: run.status || 'unknown', request: run.request || '', started: run.started || '', events: r ? r.events.length : 0 }; });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify({ runs }));
  }
  if (pathname === '/api/run' || pathname.startsWith('/api/run/')) {
    let id; // malformed %-encoding must return 400, never throw (a bare "%E0" would otherwise kill the process)
    try { id = pathname.startsWith('/api/run/') ? decodeURIComponent(pathname.slice('/api/run/'.length)) : (parsed.searchParams.get('id') || ''); }
    catch { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'bad id encoding' })); }
    const r = readRun(id);
    res.writeHead(r ? 200 : 404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify(r || { error: 'not found' }));
  }
  // WP5 Vault: GET /api/artifact/<id> — READ-ONLY, containment-guarded (artifactIdOk + resolveArtifactPath,
  // same shape as the /api/run guard above). Any non-GET method simply does not match this branch and
  // falls through to the generic 404 below (no other method is ever handled here). The stored file is
  // already redacted at write time (forge-store.cjs putEntity) — this route never re-processes/re-redacts,
  // it only serves the already-safe bytes back, scoped strictly to forge-artifacts/.
  if (req.method === 'GET' && (pathname === '/api/artifact' || pathname.startsWith('/api/artifact/'))) {
    let id; // malformed %-encoding must return 400, never throw (mirrors the /api/run handling above)
    try { id = pathname.startsWith('/api/artifact/') ? decodeURIComponent(pathname.slice('/api/artifact/'.length)) : (parsed.searchParams.get('id') || ''); }
    catch { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'bad id encoding' })); }
    if (!artifactIdOk(id)) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'bad id' })); }
    const file = resolveArtifactPath(id);
    if (!file) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'bad id' })); }
    const raw = safeRead(file);
    if (raw == null) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'not found' })); }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(raw);
  }
  // V9-INTEGRATE (2026-07-22): GET /api/capabilities — READ-ONLY real capability-vs-usage inventory (never
  // fabricated; degrades honestly to {ok:false, error} when the sibling tool is unavailable/throws, same
  // shape every other route here uses). 200 either way — this is an advisory report, not a resource lookup.
  if (req.method === 'GET' && pathname === '/api/capabilities') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(readCapabilities()));
  }
  // GET /api/stats — READ-ONLY cross-run analytics from the already-computed STATS.json (forge-stats.cjs).
  // 200 either way (advisory report, not a resource lookup): honest {ok:false,error} when absent/malformed.
  if (req.method === 'GET' && pathname === '/api/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(readStats()));
  }
  // V9-INTEGRATE (2026-07-22): GET /api/runcontract?run=<id>[&domain=<d>] — READ-ONLY forge-runcontract.cjs
  // check() against a real run. `run` is validated with the SAME allowlist regex every other guarded route
  // here uses (runIdOk) before it ever reaches path.join — never trust a query-string value into a filesystem
  // path unchecked. Malformed/missing run -> 400 (a usage error, not a resource that might exist); a run that
  // exists but the tool throws on (e.g. no events.jsonl yet) -> 200 with {ok:false, error} (an honest advisory
  // result, not a server fault).
  if (req.method === 'GET' && pathname === '/api/runcontract') {
    const runId = parsed.searchParams.get('run') || '';
    if (!runIdOk(runId)) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'bad or missing ?run=<id>' })); }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    const domain = parsed.searchParams.get('domain') || null;
    return res.end(JSON.stringify(readRunContract(runId, domain)));
  }
  res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not found' }));
}

function listen(port, triesLeft) {
  // STRICT ISOLATION GUARDS (run once before binding)
  if (IS_TEMPLATE) { console.error('Forge dashboard REFUSED: this is the global Forge template, not a project. Run it from a project (.claude/forge-dashboard/server.cjs) or set FORGE_PROJECT_ROOT.'); process.exit(2); }
  if (!exists(CLAUDE_DIR)) { console.error('Forge dashboard: no Forge install at project root\n  ' + PROJECT_DIR + '\n  (.claude/ not found). Install Forge V2 here first; not serving another project.'); process.exit(2); }
  const sv = validateState(); // backs up + flags reset on cross-project DASHBOARD_STATE
  const server = http.createServer(handler);
  server.on('error', (e) => { if (e.code === 'EADDRINUSE' && triesLeft > 0) listen(nextPort(port), triesLeft - 1); else { console.error('Forge Control Center failed to start:', e.message); process.exit(1); } });
  server.listen(port, '127.0.0.1', () => {
    CURRENT_PORT = port; writePortFile(port); writeState('ready');
    const iso = isolationStatus();
    console.log('');
    console.log('  Forge Control Center is running.');
    console.log('  URL:          http://localhost:' + port);
    console.log('  Project:      ' + PROJECT_NAME + '  (' + PROJECT_ID + ')');
    console.log('  Project root: ' + PROJECT_DIR);
    console.log('  Server PID:   ' + process.pid);
    console.log('  Isolation:    ' + iso + (sv === 'STATE_PROJECT_MISMATCH' ? '  [stale DASHBOARD_STATE from another project was reset → .mismatch.bak]' : ''));
    console.log('  Live updates: SSE (/api/events/stream) + polling fallback (250ms)');
    console.log('  Health:       http://localhost:' + port + '/api/health');
    console.log('  Runs:         ' + RUNS_DIR);
    console.log('  (Ctrl+C to stop · stop by PID above, or by listening port)');
    console.log('');
  });
}
// Guarded so this file can be require()'d (e.g. by forge-artifact-endpoint.test.cjs, to reach the pure
// artifactIdOk()/resolveArtifactPath() guard functions below) WITHOUT binding a port or starting a server.
if (require.main === module) {
  listen(preferredPort(), PORT_SPAN);
}

module.exports = { artifactIdOk, resolveArtifactPath, runIdOk, readCapabilities, readRunContract };
