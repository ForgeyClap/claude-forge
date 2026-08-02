#!/usr/bin/env node
'use strict';
/**
 * Forge ↔ Paperclip bridge (zero-dependency, project-local).
 *
 * Makes "gebruik Forge" auto-provision Paperclip WITHOUT the two systems drifting apart:
 * every Paperclip step is ALSO logged to this project's Forge dashboard (log-event.cjs),
 * so the Control Center shows the control plane live (no more empty/ghost dashboards).
 *
 * Mapping (user decision 2026-07-02): 1 Forge project = 1 Paperclip COMPANY (own org chart,
 * goals, projects, agents). Binding stored in .claude/FORGE_PAPERCLIP_BINDING.json.
 * Agent instruction docs live IN the project: docs/agents/<slug>/{AGENTS,SOUL,TOOLS}.md.
 *
 * Built-in guards (from the isolated lab findings):
 *  - BLOCKER-12/13: adapterConfig.command uses the durable standalone path with FORWARD slashes
 *  - BLOCKER-14: git init + baseline commit in the project folder before agents run
 *  - BLOCKER-15: no comment/self-wakes are configured by this bridge
 *  - loopback only (127.0.0.1:3100) · runtime stop after proof (stop cmd) · no credentials copied
 *
 * Usage:
 *   node .claude/forge-bin/forge-paperclip.cjs status
 *   node .claude/forge-bin/forge-paperclip.cjs up                          # start runtime if down
 *   node .claude/forge-bin/forge-paperclip.cjs ensure --run <run_id> --goal "<goal>" [--agents <file.json>]
 *   node .claude/forge-bin/forge-paperclip.cjs ticket --run <run_id> --title "<t>" --agent <slug> [--desc "<d>"]
 *   node .claude/forge-bin/forge-paperclip.cjs stop  --run <run_id>        # stop runtime (after proof)
 *
 * Agents JSON: [{ "slug":"design-agent","name":"Design Agent","role":"designer","title":"UI/UX",
 *   "capabilities":"...", "soul":"personality/values text", "tools":"allowed tools text",
 *   "adapterType":"claude_local"|"process"|"none", "reportsTo":"<slug>" }, ...]
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execSync, execFileSync } = require('child_process');

const CLAUDE_DIR = path.resolve(__dirname, '..');
const PROJECT_DIR = path.resolve(__dirname, '..', '..');
const PROJECT_NAME = path.basename(PROJECT_DIR);
const BINDING_FILE = path.join(CLAUDE_DIR, 'FORGE_PAPERCLIP_BINDING.json');
const LOG_EVENT = path.join(CLAUDE_DIR, 'forge-dashboard', 'log-event.cjs');
const BASE = process.env.PAPERCLIP_URL || 'http://127.0.0.1:3100';
// Portable defaults (deep-scan: template must not hardcode one machine). Prefer explicit env, then the
// owner's existing lab home if it already exists (preserve their data), else a project-local home.
const LAB_HOME = 'C:/Users/YOU/Documents/Paperclip-Test/forge-paperclip-lab/pc-home';
const PC_HOME = process.env.PAPERCLIP_HOME || (fs.existsSync(LAB_HOME) ? LAB_HOME : path.join(CLAUDE_DIR, 'paperclip-home'));
// Default OS lookup for `claude` on PATH (win: where, posix: which) — the ONLY part of
// resolveClaudeBin() that touches a real process; kept as an injectable default (opts.lookup) so
// resolveClaudeBin() itself is a safely-callable, directly-testable function. `require()`-ing this
// module never runs it with its real defaults (see the require.main guard at the bottom).
function defaultClaudeBinLookup() {
  const cmd = process.platform === 'win32' ? 'where claude' : 'command -v claude';
  return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] });
}
function resolveClaudeBin(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  if (env.FORGE_CLAUDE_BIN) return env.FORGE_CLAUDE_BIN;
  const lookup = o.lookup || defaultClaudeBinLookup;
  try { // resolve `claude` on PATH; first non-blank line wins
    const hit = String(lookup()).split(/\r?\n/).find((x) => x.trim());
    if (hit && hit.trim()) return hit.trim();
  } catch {}
  return 'C:/Users/YOU/.local/bin/claude.exe'; // last-resort fallback (this machine's known path)
}
let CLAUDE_BIN = null; // resolved lazily by the require.main guard below (guard #3) — keeps a plain
                        // `require()` of this module side-effect-free (no OS process spawned on load)

const args = process.argv.slice(2);
const cmd = args[0] || 'status';
function arg(name, dflt) { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt; }
const RUN_ID = arg('run', null);

// Run-id safety guard: only [A-Za-z0-9_-]+ may ever reach the log-event.cjs subprocess argv (mirrors
// log-event.cjs's own guard). Extracted as a pure, exported, directly-testable predicate.
const RUN_ID_SAFE_PATTERN = /^[A-Za-z0-9_-]+$/;
function isSafeRunId(id) { return typeof id === 'string' && RUN_ID_SAFE_PATTERN.test(id); }

function logEvent(type, obj) { // mirror every Paperclip step into the Forge dashboard (visibility contract)
  if (!RUN_ID || !fs.existsSync(LOG_EVENT)) return;
  if (!isSafeRunId(RUN_ID)) return;                             // reject unsafe run ids (mirror log-event.cjs)
  // execFileSync with an argv array — NO shell, so user-controlled titles/goals/agent names cannot
  // inject cmd.exe commands or be corrupted by quotes/%VARS% (deep-scan CONFIRMED HIGH, 2026-07-07).
  try { execFileSync(process.execPath, [LOG_EVENT, RUN_ID, type, JSON.stringify(obj)], { stdio: 'ignore' }); } catch {}
}
function api(method, p, body) {
  return new Promise((resolve) => {
    const u = new URL(BASE + p);
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}, timeout: 15000 },
      (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch {} resolve({ status: res.statusCode, json: j, raw: d }); }); });
    req.on('error', (e) => resolve({ status: 0, json: null, raw: String(e.message) }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null, raw: 'timeout' }); });
    if (data) req.write(data); req.end();
  });
}
const list = (j) => Array.isArray(j) ? j : (j && (j.items || j.data || j.results)) || [];
async function health() { const r = await api('GET', '/api/health'); return r.status === 200 ? r.json : null; }
function readBinding(file = BINDING_FILE) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } }
function writeBinding(b, file = BINDING_FILE) { fs.writeFileSync(file, JSON.stringify(b, null, 2) + '\n'); }

async function cmdStatus() {
  const h = await health();
  const b = readBinding();
  console.log('Paperclip runtime : ' + (h ? ('UP — ' + BASE + ' (v' + (h.version || '?') + ', mode ' + (h.deploymentMode || '?') + ')') : 'DOWN — ' + BASE));
  console.log('Project           : ' + PROJECT_NAME + '  (' + PROJECT_DIR + ')');
  console.log('Binding           : ' + (b.companyId ? ('company "' + b.companyName + '" (' + b.companyId + ') · project ' + (b.projectId || '—') + ' · goal ' + (b.goalId || '—') + ' · agents ' + Object.keys(b.agents || {}).length) : 'none yet (run: ensure)'));
  return h ? 0 : 1;
}

// Paperclip's embedded Postgres port (isolated, NEVER the system DB on 5432).
const PC_DB_PORT = process.env.PAPERCLIP_DB_PORT || '54329';
function pidsOnPort(port) {
  try {
    const out = execSync('powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ' + port + ' -State Listen -EA SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique"', { encoding: 'utf8' });
    return out.split(/\s+/).filter((x) => /^\d+$/.test(x));
  } catch { return []; }
}
// taskkill a process tree. force=false sends a graceful terminate (lets shutdown handlers run);
// force=true is /F (hard kill) — last resort only, since hard-killing Postgres can leave a stale lock.
function killTree(pid, force) { try { execSync('taskkill /PID ' + pid + ' /T' + (force ? ' /F' : ''), { stdio: 'ignore' }); return true; } catch { return false; } }
const sleepMs = (ms) => { try { execSync('powershell -NoProfile -Command "Start-Sleep -Milliseconds ' + ms + '"', { stdio: 'ignore' }); } catch {} };
// Clear an ORPHANED embedded PG on the embedded port (NEVER 5432): graceful first, force only if it survives,
// and only remove the postmaster.pid lock once nothing is listening (so we never strand a live cluster).
// Kill ONLY the embedded Postgres bundled by npx paperclipai (executable path under
// @embedded-postgres). NEVER matches the real system service (Program Files\PostgreSQL) — that
// runs elsewhere and its path never contains "embedded-postgres". Path-based, so it clears a
// stranded cluster even when the TCP table shows a stale owner and the port sweep misses it.
function killEmbeddedPgByPath() {
  try {
    execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'postgres.exe\'\\" | '
      + 'Where-Object { $_.ExecutablePath -like \'*embedded-postgres*\' } | '
      + 'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"', { stdio: 'ignore' });
  } catch {}
}
// Clear an ORPHANED embedded PG so a fresh runtime can start. Sweeps the embedded port AND the
// next few ports it drifts to (54329..54331) when the first is held, plus a path-based kill, then
// removes the stale postmaster.pid lock once nothing is listening (so we never strand a live cluster).
const PC_DB_PORTS = [PC_DB_PORT, '54330', '54331'];
function freeEmbeddedPg() {
  for (const port of PC_DB_PORTS) {
    const pids = pidsOnPort(port);
    if (pids.length) { pids.forEach((p) => killTree(p, false)); sleepMs(1200); pidsOnPort(port).forEach((p) => killTree(p, true)); }
  }
  killEmbeddedPgByPath();                                                          // path-based backstop
  sleepMs(800);
  if (PC_DB_PORTS.every((p) => pidsOnPort(p).length === 0)) {
    try { const lock = path.join(PC_HOME, 'instances', 'default', 'db', 'postmaster.pid'); if (fs.existsSync(lock)) fs.unlinkSync(lock); } catch {}
  }
}

async function cmdUp() {
  let h = await health();
  if (h) { console.log('Paperclip already running at ' + BASE + ' (v' + h.version + ') — reusing.'); logEvent('paperclip_runtime_reused', { agent: 'paperclip', role: 'control plane', status: 'done', note: 'Runtime reused at ' + BASE, evidence: '/api/health v' + h.version }); return 0; }
  freeEmbeddedPg(); // clear any orphaned embedded PG (drifted ports + path-based) before starting
  console.log('Starting Paperclip runtime (loopback, home: ' + PC_HOME + ') …');
  const logFile = path.join(PC_HOME, 'forge-bridge-server.log');
  const out = fs.openSync(logFile, 'a');
  // Use `run` (serves the API on :3100), NOT `onboard` — onboard is an interactive setup flow that
  // never binds the server, so `up` used to time out at 120s. `run` reads instances/default/config.json
  // (local_trusted, loopback) and serves immediately. Detached + unref so it OUTLIVES this process.
  const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--yes', 'paperclipai', 'run'], {
    cwd: path.dirname(PC_HOME), detached: true, stdio: ['ignore', out, out], windowsHide: true, shell: process.platform === 'win32',
    env: Object.assign({}, process.env, { PAPERCLIP_HOME: PC_HOME, PAPERCLIP_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1' }),
  });
  child.unref();
  for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 2000)); h = await health(); if (h) break; process.stdout.write('.'); }
  console.log('');
  if (!h) { console.error('BLOCKED: Paperclip did not become healthy within 120s — see ' + logFile); logEvent('paperclip_runtime_blocked', { agent: 'paperclip', role: 'control plane', status: 'failed', reason: 'health timeout', evidence: logFile }); return 1; }
  console.log('Paperclip UP at ' + BASE + ' (v' + h.version + ')');
  logEvent('paperclip_runtime_started', { agent: 'paperclip', role: 'control plane', status: 'done', note: 'Runtime started at ' + BASE + ' (v' + h.version + ', loopback, isolated home)', evidence: logFile });
  // Auto-start the usage guard (95% pause / 0% resume, real endpoint) — single global instance (user decision 2026-07-03).
  try { execSync('node "' + path.join(__dirname, 'usage-guard.cjs') + '" start', { stdio: 'inherit' }); } catch (e) { console.log('usage-guard start skipped: ' + e.message.split('\n')[0]); }
  return 0;
}

// Paperclip role enum: ceo|cto|cmo|cfo|security|engineer|designer|pm|qa|devops|researcher|general.
// Friendly Forge roles map onto it; unknown -> general. adapterType 'none' -> 'process' (lab-proven for non-executing agents).
const ROLE_MAP = { lead: 'ceo', orchestrator: 'ceo', boss: 'ceo', architect: 'cto', marketing: 'cmo', budget: 'cfo', ops: 'cfo',
  security: 'security', engineer: 'engineer', frontend: 'engineer', backend: 'engineer', coder: 'engineer',
  designer: 'designer', design: 'designer', 'ui/ux': 'designer', pm: 'pm', product: 'pm', qa: 'qa', tester: 'qa',
  devops: 'devops', n8n: 'devops', researcher: 'researcher', research: 'researcher', general: 'general' };
function pcRole(role) { const k = String(role || '').toLowerCase(); return ROLE_MAP[k] || (['ceo','cto','cmo','cfo','security','engineer','designer','pm','qa','devops','researcher','general'].includes(k) ? k : 'general'); }
// Paperclip shows/uses instruction bundles ONLY for LOCAL adapters. So every Forge agent defaults to a
// local adapter (claude_local) — this guarantees EVERY agent (incl. the Lead) has real, visible, usable
// instructions. Agents stay idle until explicitly assigned a heartbeat, so this costs nothing by default.
const LOCAL_ADAPTERS = new Set(['acpx_local', 'claude_local', 'codex_local', 'droid_local', 'gemini_local', 'opencode_local', 'pi_local', 'cursor']);
function pcAdapter(t) { const v = String(t || '').toLowerCase(); return LOCAL_ADAPTERS.has(v) ? v : 'claude_local'; }

// Forward-slash path guard (BLOCKER-12/13): the durable standalone command path and the workspace
// cwd sent to Paperclip must never contain a Windows backslash.
function toForwardSlashes(p) { return p.split(path.sep).join('/'); }

// Model tier per Forge role → Paperclip adapterConfig.model (+ effort). Mirrors .claude/FORGE_MODEL_ROUTING.json
// (user decision 2026-07-03). WHY: with no explicit model, Paperclip falls back to the adapter's "cheap"
// profile (claude-sonnet-4-6, effort low) — even for the Lead. We set it per tier so the Lead runs on Opus 4.8
// and routine work on the CURRENT Sonnet. The `sonnet`/`haiku` aliases resolve to the current version at
// runtime (Sonnet 5 / Haiku 4.5), so Paperclip's stale model list never pins us to Sonnet 4.6. Opus uses the
// explicit id `claude-opus-4-8` (it IS in Paperclip's list → clean "Claude Opus 4.8" label). The Lead may PATCH
// a specific agent to opus at runtime for the highest-stakes work (dynamic escalation).
const OPUS_ROLES = new Set(['lead', 'orchestrator', 'boss', 'ceo', 'architect', 'cto', 'security', 'security-reviewer', 'codex-reviewer']);
const HAIKU_ROLES = new Set(['classifier', 'summarizer', 'memory-writer', 'formatter']);
function modelFor(role) {
  const k = String(role || '').toLowerCase();
  if (OPUS_ROLES.has(k)) return { model: 'claude-opus-4-8', effort: 'high' };
  if (HAIKU_ROLES.has(k)) return { model: 'haiku' }; // alias → current Haiku 4.5 (effort unsupported on Haiku)
  return { model: 'sonnet', effort: 'high' };         // alias → current Sonnet 5 (versatile default)
}

function agentDocs(a, companyName, goalText, baseDir = PROJECT_DIR, claudeBin = CLAUDE_BIN) {
  const dir = path.join(baseDir, 'docs', 'agents', a.slug);
  fs.mkdirSync(dir, { recursive: true });
  const w = (f, s) => fs.writeFileSync(path.join(dir, f), s);
  w('AGENTS.md', '---\nschema: agentcompanies/v1\nkind: agent\nslug: ' + a.slug + '\nname: ' + a.name + '\ndescription: ' + (a.title || a.role) + '\n---\n\n# ' + a.name + '\n\n**Company:** ' + companyName + ' · **Role:** ' + a.role + ' · **Title:** ' + (a.title || a.role) + '\n**Reports to:** ' + (a.reportsTo || (pcRole(a.role) === 'ceo' ? '— (top of org chart)' : 'lead-agent')) + '\n\n## Mission\n' + (a.mission || ('Execute ' + a.role + ' work for: ' + goalText)) + '\n\n## Responsibilities\n' + (a.capabilities || '-') + '\n\n## Working rules\n- Work ONLY inside this project folder (workspace-bound).\n- Update your ticket status; log progress; report blockers immediately.\n- Provide proof (files/paths) for every completed task — done without proof is not done.\n- No credentials, no production deploys, no other projects.\n');
  w('SOUL.md', '# SOUL — ' + a.name + '\n\n' + (a.soul || ('Precise, honest, and scoped. You are the ' + (a.title || a.role) + ' of ' + companyName + '. You do real work (files, checks, proof) — never decorative reports. You say "blocked" early instead of faking progress. You keep outputs small, reviewable, and inside your assigned scope.')) + '\n');
  w('TOOLS.md', '# TOOLS — ' + a.name + '\n\n' + (a.tools || ('- Claude Code CLI (standalone): ' + claudeBin + '\n- File read/write inside the project workspace only\n- Forge event log: node .claude/forge-dashboard/log-event.cjs <run_id> agent_progress …\n- FORBIDDEN: credentials, production systems, folders outside this project')) + '\n');
  return dir;
}

// --- Catalog skills → auto-installed into the company + assigned per role (owner decision 2026-07-03).
// Every Forge project gets the full Paperclip skill catalog, with role-appropriate skills attached to
// each agent (more skills = better agents). Slugs resolve to company skill keys via skills/sync; the
// catalog is installed once per company by ensureCatalogSkills().
const SKILLS_BY_ROLE = {
  ceo:        ['paperclip', 'paperclip-board', 'paperclip-converting-plans-to-tasks', 'task-planning', 'issue-triage'],
  pm:         ['paperclip', 'task-planning', 'paperclip-converting-plans-to-tasks', 'paperclip-board', 'doc-maintenance'],
  engineer:   ['paperclip', 'task-planning', 'doc-maintenance', 'github-pr-workflow', 'para-memory-files'],
  designer:   ['paperclip', 'design-critique', 'wireframe', 'paperclip-capsules', 'agent-browser'],
  researcher: ['paperclip', 'last30days', 'agent-browser'],
  qa:         ['paperclip', 'qa-acceptance', 'issue-triage', 'agent-browser'],
  cmo:        ['paperclip', 'last30days', 'agent-browser', 'release-announcement'],
  cfo:        ['paperclip', 'task-planning'],
  devops:     ['paperclip', 'github-pr-workflow', 'doc-maintenance'],
  security:   ['paperclip', 'issue-triage'],
  general:    ['paperclip', 'issue-triage'],
};
function skillsForRole(role) { return SKILLS_BY_ROLE[pcRole(role)] || ['paperclip']; }

// Install the full app-shipped skills catalog into the company (idempotent). Catalog install only adds
// company_skills rows; agents then attach via skills/sync (skillsForRole). Called once in cmdEnsure.
let _catalogInstalled = false;
async function ensureCatalogSkills(companyId) {
  if (_catalogInstalled) return;
  const cat = list((await api('GET', '/api/skills/catalog')).json);
  let ok = 0;
  for (const s of cat) {
    const r = await api('POST', '/api/companies/' + companyId + '/skills/install-catalog', { catalogSkillId: s.id });
    if (r.status >= 200 && r.status < 300) ok++;
  }
  _catalogInstalled = true;
  logEvent('paperclip_skills_catalog_installed', { agent: 'paperclip', role: 'control plane', status: 'done', note: 'Installed ' + ok + '/' + cat.length + ' catalog skills into the company library' });
  return ok;
}

// Wire an agent's REAL instructions + skills into Paperclip (not just files on disk).
// Fixes: (C) custom AGENTS/SOUL/TOOLS become the agent's Paperclip instruction bundle (its actual
// runtime instructions, replacing the generic default); (A) relevant skills get attached per role.
async function wireAgent(agentId, a, dir) {
  // (C) instructions bundle — AGENTS.md is the ENTRY; SOUL/TOOLS added as bundle files
  let instrOk = false;
  for (const f of ['AGENTS.md', 'SOUL.md', 'TOOLS.md']) {
    try {
      const content = fs.readFileSync(path.join(dir, f), 'utf8');
      const r = await api('PUT', '/api/agents/' + agentId + '/instructions-bundle/file', { path: f, content, clearLegacyPromptTemplate: f === 'AGENTS.md' });
      if (r.status >= 200 && r.status < 300) instrOk = true;
    } catch {}
  }
  if (instrOk) logEvent('paperclip_agent_instructions_set', { agent: a.slug, status: 'done', note: 'Custom AGENTS/SOUL/TOOLS wired into the Paperclip instruction bundle', evidence: 'instructions-bundle' });
  else logEvent('paperclip_agent_instructions_failed', { agent: a.slug, status: 'failed', reason: 'instructions-bundle PUT not accepted (adapter may not support managed bundle)' });
  // (A) skills — role-appropriate set from the full catalog (installed once by ensureCatalogSkills)
  const desiredSkills = skillsForRole(a.role);
  const s = await api('POST', '/api/agents/' + agentId + '/skills/sync', { desiredSkills });
  if (s.status >= 200 && s.status < 300) logEvent('paperclip_agent_skills_attached', { agent: a.slug, status: 'done', note: 'Skills attached: ' + desiredSkills.join(', '), evidence: 'skills/sync' });
  else logEvent('paperclip_agent_skills_failed', { agent: a.slug, status: 'failed', reason: 'skills/sync ' + s.status + ' (adapter "' + a.adapterType + '" may not support skills)' });
}

async function cmdEnsure() {
  const goalText = arg('goal', 'Deliver the current Forge mission for ' + PROJECT_NAME);
  const agentsFile = arg('agents', null);
  let roster = [
    { slug: 'lead-agent', name: 'Lead Agent', role: 'lead', title: 'Project Lead / CEO', capabilities: 'Mission interpretation, work packages, task assignment, review, final verdict.', adapterType: 'none' },
    { slug: 'qa-agent', name: 'QA Agent', role: 'qa', title: 'QA / Proof', capabilities: 'Validation, screenshot QA, proof logging.', adapterType: 'none', reportsTo: 'lead-agent' },
  ];
  if (agentsFile && fs.existsSync(agentsFile)) roster = JSON.parse(fs.readFileSync(agentsFile, 'utf8'));

  const h = await health();
  if (!h) { console.error('Paperclip DOWN — run: forge-paperclip.cjs up'); return 1; }
  const b = readBinding();
  logEvent('paperclip_selected', { agent: 'paperclip', role: 'control plane', status: 'done', note: 'Paperclip control plane active for this run (1 project = 1 company).' });

  // guard BLOCKER-14: git init + baseline commit before any claude_local agent writes here.
  // Steps are separate + identity is provided inline so the commit can't fail silently on a box without git config.
  try {
    if (!fs.existsSync(path.join(PROJECT_DIR, '.git'))) { execSync('git init', { cwd: PROJECT_DIR, stdio: 'ignore' }); console.log('git: repo initialized (claude_local guard)'); }
    const hasCommit = (() => { try { execSync('git rev-parse HEAD', { cwd: PROJECT_DIR, stdio: 'ignore' }); return true; } catch { return false; } })();
    if (!hasCommit) {
      // Ensure a .gitignore covering .env exists FIRST, so a fresh-folder baseline can never stage secrets.
      const gi = path.join(PROJECT_DIR, '.gitignore');
      if (!fs.existsSync(gi)) fs.writeFileSync(gi, '.env\n.env.*\n!.env.example\nnode_modules/\n*.log\n');
      else if (!/^\.env\s*$/m.test(fs.readFileSync(gi, 'utf8'))) fs.appendFileSync(gi, '\n.env\n.env.*\n!.env.example\n');
      execSync('git add -A', { cwd: PROJECT_DIR, stdio: 'ignore' });
      execSync('git -c user.name="Forge Bridge" -c user.email="forge-bridge@local" commit -m "forge-paperclip baseline" --no-verify --allow-empty', { cwd: PROJECT_DIR, stdio: 'ignore' });
      console.log('git: baseline commit created (claude_local guard)');
    }
  } catch (e) { console.log('git guard WARNING: ' + e.message.split('\n')[0] + ' — claude_local runs may fail (BLOCKER-14)'); logEvent('paperclip_git_guard_warning', { agent: 'paperclip', status: 'failed', reason: 'git init/baseline failed', note: String(e.message).slice(0, 120) }); }

  // 1) company (find-or-create by name)
  let companyId = b.companyId;
  if (!companyId) {
    const all = await api('GET', '/api/companies');
    const found = list(all.json).find((c) => c.name === PROJECT_NAME);
    if (found) { companyId = found.id; console.log('company: reused "' + PROJECT_NAME + '" (' + companyId + ')'); logEvent('paperclip_company_reused', { agent: 'paperclip', status: 'done', note: 'Company reused: ' + PROJECT_NAME, evidence: companyId }); }
    else {
      const r = await api('POST', '/api/companies', { name: PROJECT_NAME, description: 'Forge project company for ' + PROJECT_DIR });
      if (!r.json || !r.json.id) { console.error('company create FAILED: ' + r.status + ' ' + r.raw.slice(0, 200)); return 1; }
      companyId = r.json.id; console.log('company: created "' + PROJECT_NAME + '" (' + companyId + ')');
      logEvent('paperclip_company_created', { agent: 'paperclip', status: 'done', note: 'Company created: ' + PROJECT_NAME, evidence: companyId });
    }
  }

  // 2) goal
  let goalId = b.goalId;
  if (!goalId) {
    const r = await api('POST', '/api/companies/' + companyId + '/goals', { title: goalText, description: 'Forge mission goal · project ' + PROJECT_NAME, level: 'company', status: 'active' });
    goalId = r.json && r.json.id;
    console.log('goal: ' + (goalId ? 'created (' + goalId + ') — "' + goalText + '"' : 'FAILED ' + r.status));
    if (goalId) logEvent('paperclip_goal_created', { agent: 'paperclip', status: 'done', note: 'Goal: ' + goalText, evidence: goalId });
  }

  // 3) project + workspace bound to THIS folder (forward slashes — BLOCKER-13 class)
  let projectId = b.projectId;
  if (!projectId) {
    const cwd = toForwardSlashes(PROJECT_DIR);
    const r = await api('POST', '/api/companies/' + companyId + '/projects', { name: PROJECT_NAME + ' — forge', description: goalText, goalIds: goalId ? [goalId] : [], status: 'in_progress', workspace: { name: PROJECT_NAME, cwd, isPrimary: true } });
    projectId = r.json && r.json.id;
    console.log('project: ' + (projectId ? 'created (' + projectId + ') · workspace → ' + cwd : 'FAILED ' + r.status + ' ' + r.raw.slice(0, 160)));
    if (projectId) { logEvent('paperclip_project_created', { agent: 'paperclip', status: 'done', note: 'Project + workspace bound to exact folder', evidence: projectId }); logEvent('paperclip_workspace_bound', { agent: 'paperclip', status: 'done', note: 'workspace cwd = ' + cwd }); }
  }

  // 3b) install the full skill catalog into the company (once) so agents can be wired with role skills
  await ensureCatalogSkills(companyId);

  // 4) agents (find-or-create by name) + instruction docs in docs/agents/<slug>/
  const agents = b.agents || {};
  const existing = list((await api('GET', '/api/companies/' + companyId + '/agents')).json);
  const idBySlug = {};
  for (const a of roster) {
    const dir = agentDocs(a, PROJECT_NAME, goalText);
    let found = existing.find((x) => x.name === a.name) || (agents[a.slug] && existing.find((x) => x.id === agents[a.slug]) ? { id: agents[a.slug] } : null);
    if (found) {
      idBySlug[a.slug] = found.id; agents[a.slug] = found.id; console.log('agent: reused ' + a.slug + ' (' + found.id + ')');
      // upgrade a reused agent's adapter to a local one if needed, so its instruction bundle becomes usable/visible
      const desiredAdapter = pcAdapter(a.adapterType);
      try {
        const cur = await api('GET', '/api/agents/' + found.id);
        const mdl = modelFor(a.role);
        const body = {};
        if (cur.json && cur.json.adapterType !== desiredAdapter) body.adapterType = desiredAdapter;
        if (desiredAdapter === 'claude_local') body.adapterConfig = Object.assign({ command: toForwardSlashes(CLAUDE_BIN) }, mdl); // set/refresh model tier (Paperclip merges adapterConfig)
        if (Object.keys(body).length) {
          const pr = await api('PATCH', '/api/agents/' + found.id, body);
          if (pr.status >= 200 && pr.status < 300) console.log('  agent updated ' + a.slug + ' -> ' + desiredAdapter + ' · model ' + mdl.model);
        }
      } catch {}
      logEvent('paperclip_agent_reused', { agent: a.slug, role: a.role, status: 'done', note: 'Paperclip agent reused · docs at ' + path.relative(PROJECT_DIR, dir) });
      await wireAgent(found.id, a, dir); continue;
    }
    const adapter = pcAdapter(a.adapterType);
    const body = { name: a.name, role: pcRole(a.role), title: a.title || a.role, capabilities: a.capabilities || '', adapterType: adapter };
    if (a.reportsTo && idBySlug[a.reportsTo]) body.reportsTo = idBySlug[a.reportsTo];
    if (adapter === 'claude_local') body.adapterConfig = Object.assign({ command: toForwardSlashes(CLAUDE_BIN), env: {} }, modelFor(a.role)); // durable path + model tier (BLOCKER-12/13; model routing 2026-07-03)
    const r = await api('POST', '/api/companies/' + companyId + '/agents', body);
    const id = r.json && r.json.id;
    if (!id) { console.error('agent ' + a.slug + ' create FAILED: ' + r.status + ' ' + r.raw.slice(0, 160)); logEvent('paperclip_agent_failed', { agent: a.slug, status: 'failed', reason: 'create failed ' + r.status }); continue; }
    idBySlug[a.slug] = id; agents[a.slug] = id;
    console.log('agent: created ' + a.slug + ' (' + id + ') · docs → ' + path.relative(PROJECT_DIR, dir));
    logEvent('paperclip_agent_created', { agent: a.slug, role: a.role, runtime: (a.adapterType === 'claude_local' ? 'ecc-agent' : 'internal'), status: 'previewing', note: 'Paperclip agent + AGENTS/SOUL/TOOLS docs', evidence: 'docs/agents/' + a.slug + '/', files_changed: ['docs/agents/' + a.slug + '/AGENTS.md', 'docs/agents/' + a.slug + '/SOUL.md', 'docs/agents/' + a.slug + '/TOOLS.md'] });
    logEvent('paperclip_agent_docs_written', { agent: a.slug, status: 'done', note: 'Instruction docs written', evidence: 'docs/agents/' + a.slug + '/' });
    await wireAgent(id, a, dir);
  }

  writeBinding({ companyName: PROJECT_NAME, companyId, goalId, goalText, projectId, agents, base: BASE, pcHome: PC_HOME, updated: new Date().toISOString(), guards: { loopback_only: true, comment_wakes: 'not configured by bridge (BLOCKER-15 guard)', claude_bin: CLAUDE_BIN, git_initialized: fs.existsSync(path.join(PROJECT_DIR, '.git')) } });
  console.log('binding: written → ' + path.relative(PROJECT_DIR, BINDING_FILE));
  console.log('ENSURE OK — company/goal/project/workspace/agents ready · dashboard events logged' + (RUN_ID ? ' (run ' + RUN_ID + ')' : ' (no --run: events skipped)'));
  return 0;
}

async function cmdTicket() {
  const b = readBinding();
  if (!b.companyId) { console.error('No binding — run ensure first.'); return 1; }
  const title = arg('title', null); if (!title) { console.error('--title required'); return 1; }
  const slug = arg('agent', null);
  const body = { title, description: arg('desc', 'Forge work package ticket'), status: 'todo', priority: arg('priority', 'medium'), projectId: b.projectId, goalId: b.goalId };
  if (slug && b.agents && b.agents[slug]) body.assigneeAgentId = b.agents[slug];
  const r = await api('POST', '/api/companies/' + b.companyId + '/issues', body);
  const id = r.json && r.json.id;
  console.log('ticket: ' + (id ? 'created (' + id + ') → ' + (slug || 'unassigned') : 'FAILED ' + r.status + ' ' + r.raw.slice(0, 160)));
  if (id) logEvent('paperclip_ticket_created', { agent: slug || 'paperclip', status: 'previewing', note: 'Ticket: ' + title, evidence: id });
  return id ? 0 : 1;
}

// pause/resume: halt or restart the AGENTS without touching the runtime — the dashboard stays up.
// WHY: killing the runtime to stop an agent stampede (heartbeats auto-run agents ~60min after the
// runtime starts) took the user's dashboard down (Moneymaker 2026-07-03). Agents are the thing to
// halt; the runtime/dashboard should stay visible. `pause` = all company agents (or --agent <slug>).
async function companyAgents() {
  const b = readBinding();
  if (!b.companyId) { console.error('No binding — run ensure first.'); return null; }
  const r = await api('GET', '/api/companies/' + b.companyId + '/agents');
  const list = Array.isArray(r.json) ? r.json : [];
  if (!list.length && b.agents) return Object.entries(b.agents).map(([slug, id]) => ({ id, name: slug, status: '?' }));
  return list;
}
async function cmdPause() {
  const slug = arg('agent', null);
  const reason = arg('reason', 'Paused by Forge — single-writer build phase; dashboard stays up. Resume with: forge-paperclip resume');
  const b = readBinding();
  let targets = await companyAgents(); if (!targets) return 1;
  if (slug) { const id = b.agents && b.agents[slug]; targets = targets.filter((a) => a.id === id || a.name === slug); if (!targets.length) { console.error('agent not found: ' + slug); return 1; } }
  let ok = 0;
  for (const a of targets) { const r = await api('POST', '/api/agents/' + a.id + '/pause', { reason }); if (r.status >= 200 && r.status < 300) { ok++; console.log('paused  ' + a.name); } else console.error('FAILED  ' + a.name + ' [' + r.status + ']'); }
  logEvent('paperclip_agents_paused', { agent: 'paperclip', status: 'done', note: 'Paused ' + ok + '/' + targets.length + ' agents (runtime/dashboard stays up)', evidence: 'POST /agents/:id/pause' });
  console.log(ok + '/' + targets.length + ' paused — runtime + dashboard remain UP.');
  return ok === targets.length ? 0 : 1;
}
async function cmdResume() {
  const slug = arg('agent', null);
  const b = readBinding();
  let targets = await companyAgents(); if (!targets) return 1;
  if (slug) { const id = b.agents && b.agents[slug]; targets = targets.filter((a) => a.id === id || a.name === slug); if (!targets.length) { console.error('agent not found: ' + slug); return 1; } }
  let ok = 0;
  for (const a of targets) { const r = await api('POST', '/api/agents/' + a.id + '/resume', {}); if (r.status >= 200 && r.status < 300) { ok++; console.log('resumed ' + a.name); } else console.error('FAILED  ' + a.name + ' [' + r.status + '] ' + String(r.raw || '').slice(0, 80)); }
  logEvent('paperclip_agents_resumed', { agent: 'paperclip', status: 'done', note: 'Resumed ' + ok + '/' + targets.length + ' agents — heartbeats may auto-run them again', evidence: 'POST /agents/:id/resume' });
  console.log(ok + '/' + targets.length + ' resumed — NOTE: heartbeats may start agents automatically.');
  return ok === targets.length ? 0 : 1;
}

async function cmdStop() {
  const h = await health();
  if (!h && pidsOnPort(PC_DB_PORT).length === 0) { console.log('Paperclip already down.'); return 0; }
  console.log('NOTE: stop kills the RUNTIME (dashboard goes down). To halt agents but keep the dashboard up, use: pause');
  try {
    // 1) GRACEFUL: ask the Paperclip node runtime to close (no /F) so it shuts its embedded Postgres
    //    down cleanly (checkpoints + releases the data-dir lock). Force-killing PG is what left an
    //    undead cluster holding :54329 last time — this avoids that entirely.
    const pids = pidsOnPort('3100');
    for (const pid of pids) killTree(pid, false);
    let clean = false;
    for (let i = 0; i < 10; i++) { sleepMs(1000); if (!(await health()) && pidsOnPort(PC_DB_PORT).length === 0) { clean = true; break; } }
    if (clean) {
      console.log('Paperclip stopped gracefully (PIDs: ' + pids.join(', ') + ') — embedded Postgres shut down cleanly, no force-kill.');
      logEvent('paperclip_runtime_stopped', { agent: 'paperclip', role: 'control plane', status: 'done', note: 'Graceful stop; embedded Postgres closed cleanly (no force-kill) — prevents the data-dir lock.' });
      return 0;
    }
    // 2) LAST RESORT: it didn't close in ~10s → force-kill node + embedded PG and clear any stale lock.
    console.log('Graceful stop timed out — force-stopping (last resort).');
    for (const pid of pidsOnPort('3100')) killTree(pid, true);
    freeEmbeddedPg();
    console.log('Paperclip runtime force-stopped + embedded Postgres freed.');
    logEvent('paperclip_runtime_stopped', { agent: 'paperclip', role: 'control plane', status: 'done', note: 'Force-stop after graceful timeout (Postgres force-killed + lock cleared).' });
  } catch (e) { console.error('stop failed: ' + e.message); return 1; }
  return 0;
}

// Pure/safely-callable exports — directly behavior-testable without ever touching network, git, an
// OS process, or a port (see forge-paperclip.test.cjs). Everything else in this file (cmdStatus..
// cmdStop, wireAgent, ensureCatalogSkills, freeEmbeddedPg, pidsOnPort, killTree, sleepMs, api,
// health, companyAgents, logEvent) stays CLI-internal and UNEXPORTED: each one performs real
// network/OS-process/port work and is intentionally not part of the public surface.
module.exports = {
  pcRole, pcAdapter, modelFor, skillsForRole,
  readBinding, writeBinding,
  toForwardSlashes,
  isSafeRunId,
  resolveClaudeBin,
  agentDocs,
  list,
  ROLE_MAP, LOCAL_ADAPTERS, OPUS_ROLES, HAIKU_ROLES, SKILLS_BY_ROLE,
};

// CLI entry point — guarded so `require('./forge-paperclip.cjs')` (e.g. from a test) loads the
// module WITHOUT starting the runtime, touching the network, running git, or exiting the process.
if (require.main === module) {
  CLAUDE_BIN = resolveClaudeBin(); // resolve now (guard #3) — only when actually running as the CLI
  (async () => {
    const fn = { status: cmdStatus, up: cmdUp, ensure: cmdEnsure, ticket: cmdTicket, pause: cmdPause, resume: cmdResume, stop: cmdStop }[cmd];
    if (!fn) { console.error('unknown command: ' + cmd + ' (use status|up|ensure|ticket|pause|resume|stop)'); process.exit(1); }
    process.exit(await fn());
  })();
}
