#!/usr/bin/env node
'use strict';
/**
 * forge-mcp.cjs — READ-ONLY Model Context Protocol server exposing THIS project's Forge run state
 * (2026-07-11, agent-ecosystem NEXT tier). Turns Forge from a CLI into an interoperable service: any MCP
 * host (Claude Desktop, Cursor, VS Code/Copilot, ChatGPT, Gemini, other agents) can read Forge runs,
 * events, reports and memory. Hand-rolled zero-dependency JSON-RPC 2.0 over newline-delimited stdio
 * (Forge already hand-rolls SSE) — stdout carries ONLY JSON-RPC; all logging goes to stderr.
 *
 * SAFE BY DESIGN: read-only (no run-triggering, no writes), scoped strictly to <project>/.claude/forge-runs
 * + Forge memory files, run ids are alphanumeric+_- only (no traversal), and text output is passed through
 * the same secret-redactor Forge uses at write time. Run-triggering (MCP Tasks) + HTTP transport are
 * deliberately NOT here — exposing a write/run tool re-creates the 2025 "privileged agent + untrusted input"
 * token-leak pattern; keep it stdio + read-only.
 *
 * Register in an MCP host as:  { "command": "node", "args": ["<abs>/.claude/forge-bin/forge-mcp.cjs"],
 *                               "env": { "FORGE_PROJECT_ROOT": "<abs project root>" } }
 */
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = process.env.FORGE_PROJECT_ROOT ? path.resolve(process.env.FORGE_PROJECT_ROOT) : path.resolve(__dirname, '..', '..');
const CLAUDE_DIR = path.join(PROJECT_ROOT, '.claude');
const RUNS_DIR = path.join(CLAUDE_DIR, 'forge-runs');
const MEMORY_FILES = ['FORGE_MEMORY.md', 'FORGE_PROJECT_PROFILE.md', 'FORGE_DECISIONS.md', 'FORGE_TASK_HISTORY.md', 'FORGE_AGENT_LEDGER.md'];
const SERVER = { name: 'forge', version: '1.0.0' };
const DEFAULT_PROTOCOL = '2025-06-18';

// Reuse Forge's own secret-redactor when available so nothing sensitive leaves via MCP.
let redact = (s) => String(s == null ? '' : s);
try { const store = require('./forge-store.cjs'); if (typeof store.redactValue === 'function') redact = (s) => { try { return store.redactValue(String(s == null ? '' : s)); } catch { return String(s == null ? '' : s); } }; } catch { /* no store — identity */ }

function log(...a) { process.stderr.write('[forge-mcp] ' + a.join(' ') + '\n'); }
function safeRead(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function runIdOk(id) { return typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id); }
function listRunIds() { try { return fs.readdirSync(RUNS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; } }
function readRunMeta(id) { const rj = safeRead(path.join(RUNS_DIR, id, 'run.json')); if (!rj) return {}; try { return JSON.parse(rj); } catch { return { parse_error: true }; } }
function readEvents(id) { const raw = safeRead(path.join(RUNS_DIR, id, 'events.jsonl')); if (!raw) return []; const out = []; for (const l of raw.split(/\r?\n/)) { const t = l.trim(); if (!t) continue; try { const v = JSON.parse(t); if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v); } catch { /* skip */ } } return out; }
function projectName() { try { const s = JSON.parse(safeRead(path.join(CLAUDE_DIR, 'forge-dashboard', 'DASHBOARD_STATE.json')) || '{}'); if (s.project_name) return s.project_name; } catch {} return path.basename(PROJECT_ROOT); }
function latestRunId() {
  const ids = listRunIds(); if (!ids.length) return null;
  let best = null, bestT = -Infinity;
  for (const id of ids) { let t = NaN; try { t = Date.parse(readRunMeta(id).started); } catch {} if (Number.isFinite(t) && t > bestT) { bestT = t; best = id; } }
  return best || ids.sort().reverse()[0];
}
function runSummary(id) { const meta = readRunMeta(id); const evs = readEvents(id); return { id, status: meta.status || 'unknown', request: meta.request || '', started: meta.started || '', events: evs.length }; }

const TOOLS = [
  { name: 'forge_status', description: 'Latest Forge run status + project info for this project (read-only).', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'forge_list_runs', description: 'List all Forge runs (id, status, request, started, event count).', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'forge_get_run', description: 'Get one run: its run.json meta, event count, and the last N events.', inputSchema: { type: 'object', properties: { run_id: { type: 'string' }, last: { type: 'number', description: 'trailing events to include (default 20)' } }, required: ['run_id'], additionalProperties: false } },
  { name: 'forge_read_report', description: 'Read a run final-report.md.', inputSchema: { type: 'object', properties: { run_id: { type: 'string' } }, required: ['run_id'], additionalProperties: false } },
];

function callTool(name, args) {
  args = args || {};
  if (name === 'forge_status') { const id = latestRunId(); return { project: projectName(), project_root: PROJECT_ROOT, latest_run: id ? runSummary(id) : null, total_runs: listRunIds().length }; }
  if (name === 'forge_list_runs') { return { runs: listRunIds().map(runSummary).sort((a, b) => (a.started < b.started ? 1 : -1)) }; }
  if (name === 'forge_get_run') { const id = args.run_id; if (!runIdOk(id)) throw new Error('invalid run_id'); const evs = readEvents(id); const n = Number.isFinite(args.last) ? Math.max(0, args.last) : 20; return { id, run: readRunMeta(id), event_count: evs.length, last_events: evs.slice(-n) }; }
  if (name === 'forge_read_report') { const id = args.run_id; if (!runIdOk(id)) throw new Error('invalid run_id'); const rep = safeRead(path.join(RUNS_DIR, id, 'final-report.md')); if (rep == null) throw new Error('no report for run ' + id); return { id, report: rep }; }
  throw new Error('unknown tool: ' + name);
}

function listResources() {
  const res = []; const have = (p) => { try { return fs.existsSync(p); } catch { return false; } };
  for (const id of listRunIds().slice(0, 50)) {
    const d = path.join(RUNS_DIR, id);
    if (have(path.join(d, 'run.json'))) res.push({ uri: 'forge://run/' + id + '/run.json', name: id + ' · run.json', mimeType: 'application/json' });
    if (have(path.join(d, 'events.jsonl'))) res.push({ uri: 'forge://run/' + id + '/events.jsonl', name: id + ' · events', mimeType: 'application/x-ndjson' });
    if (have(path.join(d, 'final-report.md'))) res.push({ uri: 'forge://run/' + id + '/report.md', name: id + ' · final report', mimeType: 'text/markdown' });
  }
  for (const f of MEMORY_FILES) if (have(path.join(CLAUDE_DIR, f))) res.push({ uri: 'forge://memory/' + f, name: f, mimeType: 'text/markdown' });
  return res;
}
function readResource(uri) {
  const mRun = /^forge:\/\/run\/([A-Za-z0-9_-]+)\/(run\.json|events\.jsonl|report\.md)$/.exec(uri);
  if (mRun) { const file = mRun[2] === 'report.md' ? 'final-report.md' : mRun[2]; const body = safeRead(path.join(RUNS_DIR, mRun[1], file)); if (body == null) throw new Error('resource not found'); return { uri, mimeType: file === 'run.json' ? 'application/json' : (file === 'events.jsonl' ? 'application/x-ndjson' : 'text/markdown'), text: redact(body) }; }
  const mMem = /^forge:\/\/memory\/([A-Za-z0-9_.-]+)$/.exec(uri);
  if (mMem && MEMORY_FILES.includes(mMem[1])) { const body = safeRead(path.join(CLAUDE_DIR, mMem[1])); if (body == null) throw new Error('resource not found'); return { uri, mimeType: 'text/markdown', text: redact(body) }; }
  throw new Error('unknown or forbidden resource uri');
}

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function ok(id, result) { send({ jsonrpc: '2.0', id, result }); }
function err(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

function handle(req) {
  const { id, method, params } = req;
  if (method === 'initialize') return ok(id, { protocolVersion: (params && params.protocolVersion) || DEFAULT_PROTOCOL, capabilities: { tools: {}, resources: {} }, serverInfo: SERVER });
  if (method === 'notifications/initialized' || method === 'initialized') return; // notification — no reply
  if (method === 'ping') return ok(id, {});
  if (method === 'tools/list') return ok(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const name = params && params.name;
    try { const data = callTool(name, params && params.arguments); return ok(id, { content: [{ type: 'text', text: redact(JSON.stringify(data, null, 2)) }] }); }
    catch (e) { return ok(id, { content: [{ type: 'text', text: 'error: ' + (e.message || e) }], isError: true }); }
  }
  if (method === 'resources/list') return ok(id, { resources: listResources() });
  if (method === 'resources/read') {
    try { return ok(id, { contents: [readResource(params && params.uri)] }); }
    catch (e) { return err(id, -32602, e.message || String(e)); }
  }
  if (id != null) err(id, -32601, 'method not found: ' + method);
}

// Module export for headless testing (drive handle() without stdio).
module.exports = { handle, callTool, listResources, readResource, TOOLS, PROJECT_ROOT };

if (require.main === module) {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    buf += c; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let req; try { req = JSON.parse(line); } catch { continue; }
      try { handle(req); } catch (e) { if (req && req.id != null) err(req.id, -32603, 'internal: ' + (e.message || e)); }
    }
  });
  process.stdin.on('end', () => process.exit(0));
  log('read-only server ready · project=' + projectName() + ' · ' + PROJECT_ROOT);
}
