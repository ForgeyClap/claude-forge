#!/usr/bin/env node
'use strict';
/**
 * forge-capabilities.cjs — honest capabilities-vs-usage inventory (2026-07-22, WAVE V9 / piece P2). Answers
 * the owner's recurring complaint "I have all this Forge tooling installed and I barely notice it" with a
 * real, evidence-based answer instead of a marketing list: for every forge-bin tool, forge-* skill, and
 * config-declared hard-gate that ACTUALLY EXISTS on disk, report whether it has EVER really been used — and
 * when. Zero-dependency (fs/path only, plus the sibling forge-actiongate.cjs module for the single-source-of-
 * truth gate vocabulary — never re-implements KNOWN_GATES/classify()).
 *
 * HONESTY MODEL (read before trusting a number):
 *   - inventory() NEVER hardcodes which tools/skills exist — it globs forge-bin's *.cjs files and every
 *     skills/forge-<name> directory's SKILL.md off the real filesystem, exactly like forge-doctor.cjs's own
 *     syncCompleteness()/listSkillFiles() do, so this list can never silently drift from what is installed.
 *   - Gates are the one EXCEPTION that is allowed to reference a fixed vocabulary, because that vocabulary
 *     already exists as forge-actiongate.cjs's own KNOWN_GATES (the established single source of truth for
 *     which hard-gates SHOULD exist) — reusing it here lets inventory() report a genuinely useful drift signal
 *     (present:false) when a known gate id has gone missing from config/orchestration/hard-gates.json, which a
 *     pure filesystem glob could never detect on its own.
 *   - usage() counts a capability as "used" only when its name (or, for a gate, its id) is found verbatim
 *     inside REAL logged evidence: an events.jsonl line under .claude/forge-runs/, or a real line already
 *     written into .claude/agent-memory/**\/*.md|*.jsonl or a top-level .claude/FORGE_*.md|*.json file. This
 *     is deliberately the SAME word-boundary substring-matching model forge-evidence.cjs already uses for its
 *     artifact/event matching (documented there as an accepted approximation, not exact call-graph tracing) —
 *     a capability with a short/common-English name (e.g. gate id "deploy" or "spend") can occasionally match
 *     an unrelated mention of that literal word. This module never claims otherwise; it reports a mention
 *     count, not a proof of invocation.
 *   - A never-used capability is reported as times_used:0, last_used_run:null, last_used_ts:null — that IS
 *     the finding the owner wants to see, never silently omitted or guessed into "probably fine".
 *   - last_used is taken from the REAL logged event's own `timestamp` field when present (ISO-8601 strings
 *     compare correctly as plain strings); a mention found only in a memory/FORGE_* text file (no run
 *     attribution possible) still increments times_used honestly, but never fabricates a run id or a
 *     timestamp for it.
 *
 * MODULE API:
 *   inventory(opts) -> [{ id, kind:'tool'|'skill'|'gate', name, present:bool, status:'active'|'dormant'|'opt-in' }]
 *     Status is a STATIC, usage-independent design classification (report() below is what folds in real
 *     usage evidence): a gate present in config is 'active' (classify() always enforces it structurally,
 *     independent of whether it has fired yet); a KNOWN gate id missing from config is 'dormant' (declared
 *     expectation, not actually wired up — a real drift finding); every tool/skill is 'opt-in' at this layer,
 *     reflecting Forge's own "pick the smallest relevant team per task" design (config/... forge-router) — no
 *     tool or skill in this system is globally mandatory, all are chosen per-task.
 *   usage({ runsDir }, opts) -> [{ id, kind, name, present, times_used, last_used_run, last_used_ts }]
 *     opts.root/opts.agentMemoryDir/opts.claudeDir/opts.binDir/opts.skillsDir/opts.gatesConfigPath/
 *     opts.knownGateIds are the hermetic-test override seams (same convention as every sibling forge-bin tool).
 *   report(opts) -> { capabilities:[{ capability, name, kind, present, status, times_used, last_used_run,
 *     last_used_ts }], summary:{ total, active, dormant, opt_in, never_used } }
 *     `status` here is usage-AWARE: any tool/skill with times_used>0 is promoted to 'active' (real evidence of
 *     use overrides the static 'opt-in' design label); a gate keeps its inventory-time status regardless of
 *     times_used (see inventory() doc above — "never yet observed firing" is not the same finding as "not
 *     wired up at all", and both are still visible via times_used/last_used on the same record).
 *
 * CLI:
 *   node forge-capabilities.cjs inventory [--json] [--root <dir>] [--bin-dir <dir>] [--skills-dir <dir>]
 *     [--gates-config <file>] [--known-gates <a,b,...>]
 *   node forge-capabilities.cjs usage [--json] [--root <dir>] [--runs-dir <dir>] [--agent-memory-dir <dir>]
 *     [--claude-dir <dir>] [--bin-dir <dir>] [--skills-dir <dir>] [--gates-config <file>] [--known-gates <a,b,...>]
 *   node forge-capabilities.cjs report [--json] [<same overrides as usage>]
 * Exit codes: 0 = ran (an honestly-empty inventory/usage/report is still success, never an error) ·
 *   2 = usage error (bad/missing flag value, unknown command).
 */
const fs = require('fs');
const path = require('path');
const actiongate = require('./forge-actiongate.cjs');

const PROJECT_ROOT_DEFAULT = path.resolve(__dirname, '..', '..');

function projectRoot(opts) { return (opts && opts.root) ? path.resolve(opts.root) : PROJECT_ROOT_DEFAULT; }
function claudeDir(opts) { return (opts && opts.claudeDir) ? path.resolve(opts.claudeDir) : path.join(projectRoot(opts), '.claude'); }

// ---------------------------------------------------------------------------
// inventory sources — real filesystem globs only (see file header)
// ---------------------------------------------------------------------------

/** listBinTools(opts) -> [{id, kind:'tool', name, path}]. Globs forge-bin/*.cjs, excluding *.test.cjs and
 *  this module's own file (a capabilities tool inventorying itself is harmless but adds no signal). */
function listBinTools(opts) {
  const dir = (opts && opts.binDir) ? path.resolve(opts.binDir) : path.join(claudeDir(opts), 'forge-bin');
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.cjs') || e.name.endsWith('.test.cjs')) continue;
    const name = e.name.slice(0, -'.cjs'.length);
    out.push({ id: 'tool:' + name, kind: 'tool', name, path: path.join(dir, e.name) });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** listForgeSkills(opts) -> [{id, kind:'skill', name, path}]. Globs every skills/forge-<name> directory's
 *  SKILL.md — only Forge's OWN skill vocabulary (per the work package: "the forge-* skills"), never every
 *  3rd-party skill dir (e.g. gsap/humanizer) that happens to also live under skills/. */
function listForgeSkills(opts) {
  const dir = (opts && opts.skillsDir) ? path.resolve(opts.skillsDir) : path.join(claudeDir(opts), 'skills');
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith('forge-')) continue;
    const skillFile = path.join(dir, e.name, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;
    out.push({ id: 'skill:' + e.name, kind: 'skill', name: e.name, path: skillFile });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** listGateCapabilities(opts) -> [{id, kind:'gate', name, present, gateClass, loadError}]. See file header
 *  for why gates are allowed a fixed expected-id vocabulary (actiongate.KNOWN_GATES) unlike tools/skills:
 *  it is the one case where "present:false" is itself a genuine, useful drift finding. Any REAL gate found
 *  in config that ISN'T in the known list is still included (present:true) — a real config entry is never
 *  silently dropped just because it wasn't anticipated. */
function listGateCapabilities(opts) {
  opts = opts || {};
  let gates = [];
  let loadError = null;
  try { gates = actiongate.listGates({ configPath: opts.gatesConfigPath }); }
  catch (e) { loadError = e.message; }
  const byId = new Map(gates.map((g) => [g.id, g]));
  const knownIds = Array.isArray(opts.knownGateIds) ? opts.knownGateIds : actiongate.KNOWN_GATES;
  const out = [];
  const seen = new Set();
  for (const id of knownIds) {
    const g = byId.get(id);
    out.push({ id: 'gate:' + id, kind: 'gate', name: id, present: !!g, gateClass: g ? g.class : null, loadError: g ? null : loadError });
    seen.add(id);
  }
  for (const g of gates) {
    if (seen.has(g.id)) continue; // a real config gate NOT in the known list — still reported, never dropped
    out.push({ id: 'gate:' + g.id, kind: 'gate', name: g.id, present: true, gateClass: g.class, loadError: null });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** inventory(opts) -> see file header MODULE API. */
function inventory(opts) {
  opts = opts || {};
  const tools = listBinTools(opts).map((c) => ({ id: c.id, kind: c.kind, name: c.name, present: true, status: 'opt-in' }));
  const skills = listForgeSkills(opts).map((c) => ({ id: c.id, kind: c.kind, name: c.name, present: true, status: 'opt-in' }));
  const gates = listGateCapabilities(opts).map((c) => ({ id: c.id, kind: c.kind, name: c.name, present: c.present, status: c.present ? 'active' : 'dormant' }));
  return [...tools, ...skills, ...gates];
}

// ---------------------------------------------------------------------------
// usage sources — real logged evidence only (see file header)
// ---------------------------------------------------------------------------

function defaultRunsDir(opts) { return path.join(claudeDir(opts), 'forge-runs'); }
function defaultAgentMemoryDir(opts) { return path.join(claudeDir(opts), 'agent-memory'); }

/** readRunHits(runsDir) -> [{runId, ts, haystack}], one entry per parseable events.jsonl line across every
 *  run directory. Tolerant by design: a missing runsDir, a run with no events.jsonl, or an unparseable/
 *  truncated line is silently skipped rather than thrown — a malformed run must never crash usage(). */
function readRunHits(runsDir) {
  let runIds = [];
  try { runIds = fs.readdirSync(runsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); }
  catch { return []; }
  const hits = [];
  for (const runId of runIds.sort()) {
    const evFile = path.join(runsDir, runId, 'events.jsonl');
    let raw;
    try { raw = fs.readFileSync(evFile, 'utf8'); } catch { continue; } // no events.jsonl in this run dir — tolerated
    for (const line of raw.split(/\r?\n/)) {
      const s = line.trim();
      if (!s) continue;
      let ev;
      try { ev = JSON.parse(s); } catch { continue; } // malformed/truncated line — skip, never crash
      hits.push({ runId, ts: typeof ev.timestamp === 'string' ? ev.timestamp : null, haystack: JSON.stringify(ev).toLowerCase() });
    }
  }
  return hits;
}

/** readTextHaystacks(dir) -> [lowercased file text, ...] for every .md/.jsonl/.json file under dir (recursive).
 *  No run/timestamp attribution is possible for these hits (see file header) — used only to add real,
 *  already-written mentions to times_used, mirroring forge-harvest.cjs's own "only real written text counts"
 *  posture. Tolerant of a missing dir. */
function readTextHaystacks(dir) {
  const out = [];
  (function walk(d) {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (e.isFile() && /\.(md|jsonl|json)$/i.test(e.name)) {
        try { out.push(fs.readFileSync(p, 'utf8').toLowerCase()); } catch { /* unreadable — skipped honestly */ }
      }
    }
  })(dir);
  return out;
}

/** readForgeStarHaystacks(claudeDirPath) -> [lowercased file text, ...] for the top-level .claude/FORGE_*.md
 *  and FORGE_*.json files (project memory/ledger/history) — one directory level only, never recursive. */
function readForgeStarHaystacks(claudeDirPath) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(claudeDirPath, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isFile() && /^FORGE_.*\.(md|json)$/i.test(e.name)) {
      try { out.push(fs.readFileSync(path.join(claudeDirPath, e.name), 'utf8').toLowerCase()); } catch { /* unreadable — skipped honestly */ }
    }
  }
  return out;
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** nameAppears(name, haystack) -> true when `name` appears in `haystack` as a whole token, case-insensitive.
 *  Deliberately the SAME substring-style approximation forge-evidence.cjs already uses (see file header) — a
 *  real mention, not exact call-graph proof. Capability names themselves contain hyphens (e.g. "forge-
 *  doctor"), so a plain regex \b word-boundary is NOT strict enough — hyphen is a non-word character, so
 *  \bforge-doctor\b would still match inside "forge-doctor-panel-widget". Instead require a non-alphanumeric,
 *  non-hyphen, non-underscore character (or a real string edge) on both sides, so "forge-doctor" only matches
 *  a standalone token, never as a prefix fragment of a longer hyphenated identifier. */
function nameAppears(name, haystack) {
  const re = new RegExp('(^|[^a-z0-9_-])' + escapeRe(String(name).toLowerCase()) + '($|[^a-z0-9_-])', 'i');
  return re.test(String(haystack).toLowerCase());
}

/** usage(params, opts) -> see file header MODULE API. params.runsDir overrides the default forge-runs dir;
 *  everything else is a hermetic-test override seam on opts (root/agentMemoryDir/claudeDir/binDir/skillsDir/
 *  gatesConfigPath/knownGateIds), mirroring the override-seam convention every sibling forge-bin tool uses. */
function usage(params, opts) {
  params = params || {};
  opts = opts || {};
  const runsDir = params.runsDir ? path.resolve(params.runsDir) : defaultRunsDir(opts);
  const agentMemoryDir = opts.agentMemoryDir ? path.resolve(opts.agentMemoryDir) : defaultAgentMemoryDir(opts);

  const runHits = readRunHits(runsDir);
  const staticHaystacks = [...readTextHaystacks(agentMemoryDir), ...readForgeStarHaystacks(claudeDir(opts))];

  const caps = inventory(opts);
  return caps.map((cap) => {
    let timesUsed = 0;
    let lastUsedRun = null;
    let lastUsedTs = null;
    for (const hit of runHits) {
      if (!nameAppears(cap.name, hit.haystack)) continue;
      timesUsed++;
      if (!lastUsedTs || (hit.ts && hit.ts > lastUsedTs)) { lastUsedTs = hit.ts; lastUsedRun = hit.runId; }
    }
    for (const hay of staticHaystacks) {
      if (nameAppears(cap.name, hay)) timesUsed++; // real mention found — but no run/timestamp can be honestly attributed
    }
    return { id: cap.id, kind: cap.kind, name: cap.name, present: cap.present, times_used: timesUsed, last_used_run: lastUsedRun, last_used_ts: lastUsedTs };
  });
}

/** report(opts) -> see file header MODULE API. */
function report(opts) {
  opts = opts || {};
  const inv = inventory(opts);
  const statusById = new Map(inv.map((c) => [c.id, c.status]));
  const usageList = usage({ runsDir: opts.runsDir }, opts);

  const summary = { total: 0, active: 0, dormant: 0, opt_in: 0, never_used: 0 };
  const capabilities = usageList.map((u) => {
    const inventoryStatus = statusById.get(u.id) || 'opt-in';
    // gates keep their static (structural) status regardless of observed usage — see file header; tools/
    // skills are promoted to 'active' only by REAL evidence of use (times_used > 0), otherwise stay 'opt-in'.
    const status = u.kind === 'gate' ? inventoryStatus : (u.times_used > 0 ? 'active' : 'opt-in');
    summary.total++;
    if (status === 'active') summary.active++;
    else if (status === 'dormant') summary.dormant++;
    else summary.opt_in++;
    if (u.times_used === 0) summary.never_used++;
    return {
      capability: u.id,
      name: u.name,
      kind: u.kind,
      present: u.present,
      status,
      times_used: u.times_used,
      last_used_run: u.last_used_run,
      last_used_ts: u.last_used_ts,
    };
  });
  return { capabilities, summary };
}

module.exports = {
  inventory, usage, report,
  listBinTools, listForgeSkills, listGateCapabilities,
  readRunHits, readTextHaystacks, readForgeStarHaystacks, nameAppears, escapeRe,
  PROJECT_ROOT_DEFAULT,
};

// ---- CLI ----
function parseArgs(argv) {
  const cmd = argv[0] || null;
  const rest = argv.slice(1);
  const opts = {
    cmd, json: false, usageError: null,
    root: null, runsDir: null, agentMemoryDir: null, claudeDir: null,
    binDir: null, skillsDir: null, gatesConfigPath: null, knownGateIds: null,
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--json') opts.json = true;
    else if (a === '--root') opts.root = rest[++i];
    else if (a === '--runs-dir') opts.runsDir = rest[++i];
    else if (a === '--agent-memory-dir') opts.agentMemoryDir = rest[++i];
    else if (a === '--claude-dir') opts.claudeDir = rest[++i];
    else if (a === '--bin-dir') opts.binDir = rest[++i];
    else if (a === '--skills-dir') opts.skillsDir = rest[++i];
    else if (a === '--gates-config') opts.gatesConfigPath = rest[++i];
    else if (a === '--known-gates') opts.knownGateIds = (rest[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (!opts.usageError) opts.usageError = 'unknown argument: ' + a;
  }
  return opts;
}
function toModuleOpts(o) {
  return {
    root: o.root || undefined,
    runsDir: o.runsDir || undefined,
    agentMemoryDir: o.agentMemoryDir || undefined,
    claudeDir: o.claudeDir || undefined,
    binDir: o.binDir || undefined,
    skillsDir: o.skillsDir || undefined,
    gatesConfigPath: o.gatesConfigPath || undefined,
    knownGateIds: o.knownGateIds || undefined,
  };
}
function printUsage() {
  console.error('Usage: node forge-capabilities.cjs inventory [--json] [--root <dir>] [--bin-dir <dir>] [--skills-dir <dir>] [--gates-config <file>] [--known-gates <a,b,...>]');
  console.error('       node forge-capabilities.cjs usage [--json] [--root <dir>] [--runs-dir <dir>] [--agent-memory-dir <dir>] [--claude-dir <dir>] [--bin-dir <dir>] [--skills-dir <dir>] [--gates-config <file>] [--known-gates <a,b,...>]');
  console.error('       node forge-capabilities.cjs report [--json] [<same overrides as usage>]');
}
function printCapabilityLine(c) {
  const usedBit = c.times_used > 0
    ? c.times_used + 'x, last: ' + (c.last_used_run || '?') + (c.last_used_ts ? ' @ ' + c.last_used_ts : '')
    : 'never used';
  return '  [' + c.status + '] ' + (c.capability || c.id) + ' (' + c.kind + ') — ' + usedBit;
}

if (require.main === module) {
  const raw = parseArgs(process.argv.slice(2));
  if (raw.usageError) { console.error('forge-capabilities: ' + raw.usageError); printUsage(); process.exitCode = 2; }
  else {
    try {
      const opts = toModuleOpts(raw);
      if (raw.cmd === 'inventory') {
        const result = inventory(opts);
        if (raw.json) console.log(JSON.stringify(result));
        else { console.log('forge-capabilities inventory (' + result.length + ' capabilities)'); for (const c of result) console.log('  [' + c.status + '] ' + c.id + ' (' + c.kind + ', present:' + c.present + ')'); }
        process.exitCode = 0;
      } else if (raw.cmd === 'usage') {
        const result = usage({ runsDir: opts.runsDir }, opts);
        if (raw.json) console.log(JSON.stringify(result));
        else {
          console.log('forge-capabilities usage (' + result.length + ' capabilities)');
          for (const c of result) console.log('  ' + c.id + ' (' + c.kind + ') — ' + (c.times_used > 0 ? c.times_used + 'x, last: ' + (c.last_used_run || '?') : 'never used'));
        }
        process.exitCode = 0;
      } else if (raw.cmd === 'report') {
        const result = report(opts);
        if (raw.json) console.log(JSON.stringify(result));
        else {
          console.log('forge-capabilities report');
          console.log('  total: ' + result.summary.total + '  active: ' + result.summary.active + '  dormant: ' + result.summary.dormant + '  opt-in: ' + result.summary.opt_in + '  never-used: ' + result.summary.never_used);
          for (const c of result.capabilities) console.log(printCapabilityLine(c));
        }
        process.exitCode = 0;
      } else {
        printUsage();
        process.exitCode = 2;
      }
    } catch (e) {
      console.error('forge-capabilities: ' + e.message);
      process.exitCode = 2;
    }
  }
}
