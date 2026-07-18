#!/usr/bin/env node
'use strict';
/**
 * forge-mindmap.cjs — zero-dependency mind-map generator/writer for Forge Mission Control Phase 2
 * (WP4 "Mind Map"). Windows-safe (node "C:/Program Files/nodejs/node.exe" or any Node on PATH).
 *
 * Parses an indented plain-text outline into a small node/edge graph, renders it to a guarded
 * Mermaid string, and stores it via forge-store.cjs (`.claude/forge-mindmaps/`) so the dashboard's
 * radial "MIND MAP" lens (forge-dashboard/lenses.js) can render it read-only.
 *
 * REUSES forge-bin/forge-store.cjs (do not re-implement its guards):
 *   - redactValue      — deep-redacts every string leaf before anything touches disk or stdout.
 *   - resolveStoreDir  — path-contained resolution of the forge-mindmaps/ store dir.
 *   - isValidId        — same ^[A-Za-z0-9_-]+$ guard used everywhere in Forge (blocks traversal).
 *   - CLAUDE_DIR        — project .claude/ root (honors FORGE_STORE_ROOT for hermetic tests).
 *
 * Outline format (2-space or tab indent = depth):
 *   Mission Control Phase 2
 *     WP4 Mind Map
 *       Writer
 *       Lens
 *     WP5 Something
 *   -> first non-blank line is the root (kind "root"); every other line is a child of the nearest
 *      shallower line (kind "branch" if it has children, else "leaf").
 *
 * CLI:
 *   node forge-mindmap.cjs from-outline '<outline-text>' <map_id> [--run <run_id>] [--mermaid] [--write]
 *     -> builds {map_id, title, nodes, edges} from the outline and prints it as JSON (dry-run).
 *        --write persists it via writeMindmap(); --mermaid also writes a <map_id>.mmd sidecar;
 *        --run <run_id> logs mindmap_generated to that run's dashboard events (only when --write
 *        actually persisted something — never logs a generation event for data that was not stored).
 *   node forge-mindmap.cjs write '<map-json>' [--run <run_id>] [--mermaid]
 *     -> writeMindmap() an already-built {map_id, title?, nodes, edges} object directly.
 *
 * Module API: require('./forge-mindmap.cjs') -> { buildFromOutline, toMermaid, writeMindmap }
 *
 * SECRET HYGIENE: every string in the map is redacted (forge-store's redactValue) before it is
 * written to disk or printed — a raw secret is never rendered, stored, or printed.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { redactValue, resolveStoreDir, isValidId, CLAUDE_DIR } = require('./forge-store.cjs');

// ---- outline parsing ----
// Each tab = one depth level; every 2 spaces = one depth level. Mixed indent is tolerated (best-effort,
// never throws) — the exact indent unit does not need to be consistent across the whole outline.
function indentDepth(rawLine) {
  let i = 0, depth = 0, spaceRun = 0;
  while (i < rawLine.length) {
    const ch = rawLine[i];
    if (ch === '\t') { depth++; spaceRun = 0; i++; continue; }
    if (ch === ' ') { spaceRun++; if (spaceRun === 2) { depth++; spaceRun = 0; } i++; continue; }
    break;
  }
  return depth;
}
// isValidId-safe slug: lowercase, non [A-Za-z0-9_-] runs collapsed to '-', trimmed; falls back to
// "node" if the label has no usable characters. Suffixed with the line's index, so ids are always
// unique without needing a dedupe pass.
function slugId(label, i) {
  let slug = String(label == null ? '' : label).trim().toLowerCase().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) slug = 'node';
  return slug + '-' + i;
}
/**
 * buildFromOutline(text) -> { nodes:[{id,label,kind,parent}], edges:[{from,to}] }
 * Parses an indented plain-text outline. Root = first non-blank line (kind 'root'). Every other line
 * becomes a child of the nearest line at depth-1 (a depth jump of more than one level is clamped to
 * the current stack depth, so no line is ever silently dropped). Never throws on empty/malformed input.
 */
function buildFromOutline(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  const nodes = [], edges = [], stack = [];
  let i = 0, rootSeen = false;
  for (const rawLine of lines) {
    if (!rawLine.trim()) continue;
    const label = rawLine.trim();
    const depth = rootSeen ? Math.min(indentDepth(rawLine), stack.length) : 0;
    const id = slugId(label, i++);
    const parent = depth > 0 ? stack[depth - 1] : null;
    stack[depth] = id;
    stack.length = depth + 1; // drop stale deeper entries so a later dedent reattaches correctly
    nodes.push({ id, label, kind: null, parent });
    if (parent) edges.push({ from: parent, to: id });
    rootSeen = true;
  }
  const hasChildren = new Set(edges.map((e) => e.from));
  nodes.forEach((n, idx) => { n.kind = idx === 0 ? 'root' : (hasChildren.has(n.id) ? 'branch' : 'leaf'); });
  return { nodes, edges };
}

// ---- mermaid rendering (guarded — never throws on malformed input) ----
function mmid(id) { return String(id == null ? '' : id).replace(/[^A-Za-z0-9_]/g, '_') || 'n'; }
/** toMermaid(map) -> a guarded `graph TD` mermaid string (edges rendered as `A --> B`). */
function toMermaid(map) {
  const m = (map && typeof map === 'object') ? map : {};
  const nodes = Array.isArray(m.nodes) ? m.nodes : [];
  const edges = Array.isArray(m.edges) ? m.edges : [];
  const ids = new Set(nodes.map((n) => n && n.id));
  const lines = ['graph TD'];
  nodes.forEach((n) => { if (!n || n.id == null) return; const label = String(n.label == null ? n.id : n.label).replace(/"/g, "'"); lines.push('  ' + mmid(n.id) + '["' + label + '"]'); });
  edges.forEach((e) => { if (!e || !ids.has(e.from) || !ids.has(e.to)) return; lines.push('  ' + mmid(e.from) + ' --> ' + mmid(e.to)); });
  return lines.join('\n') + '\n';
}

// ---- markdown outline rendering (guarded) ----
function renderOutlineMd(map) {
  const m = (map && typeof map === 'object') ? map : {};
  const nodes = Array.isArray(m.nodes) ? m.nodes : [];
  const byId = new Map(nodes.filter((n) => n && n.id != null).map((n) => [n.id, n]));
  const children = new Map();
  nodes.forEach((n) => { if (n && n.parent != null) { if (!children.has(n.parent)) children.set(n.parent, []); children.get(n.parent).push(n.id); } });
  const root = nodes.find((n) => n && n.kind === 'root') || nodes[0];
  const lines = ['# ' + (m.title || (root && root.label) || 'Mind Map')];
  const seen = new Set();
  (function walk(id, depth) {
    if (id == null || seen.has(id)) return; // guard against a malformed cyclic parent chain
    const n = byId.get(id); if (!n) return;
    seen.add(id);
    lines.push('  '.repeat(depth) + '- ' + n.label);
    (children.get(id) || []).forEach((cid) => walk(cid, depth + 1));
  })(root && root.id, 0);
  return lines.join('\n') + '\n';
}

// ---- store writes (forge-mindmaps/<id>.json [+ .mmd] [+ .md] + index.jsonl) ----
function resolveMindmapFile(id, ext) {
  if (!isValidId(id)) throw new Error('writeMindmap: invalid map_id (allowed: A-Z a-z 0-9 _ -): ' + id);
  const dir = resolveStoreDir('mindmaps');
  const file = path.join(dir, id + ext);
  const base = path.resolve(dir), resolved = path.resolve(file);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) throw new Error('writeMindmap: id escapes forge-mindmaps/ — refused');
  return { dir, file };
}
/**
 * writeMindmap(map, opts) -> { map_id, jsonPath, mmdPath, mdPath }. Validates map.map_id, redacts every
 * string leaf, writes <map_id>.json (+ <map_id>.mmd when opts.mermaid, + <map_id>.md when
 * opts.outlineMd), and appends an index.jsonl row. Never writes a raw secret.
 */
function writeMindmap(map, opts) {
  opts = opts || {};
  if (!map || typeof map !== 'object') throw new Error('writeMindmap: map must be an object');
  const id = map.map_id;
  const { dir, file: jsonPath } = resolveMindmapFile(id, '.json');
  fs.mkdirSync(dir, { recursive: true });
  const redacted = redactValue(map);
  const generated = new Date().toISOString();
  const stored = {
    map_id: id,
    title: redacted.title || '',
    nodes: Array.isArray(redacted.nodes) ? redacted.nodes : [],
    edges: Array.isArray(redacted.edges) ? redacted.edges : [],
    _generated: generated,
  };
  fs.writeFileSync(jsonPath, JSON.stringify(stored, null, 2) + '\n', 'utf8');
  fs.appendFileSync(path.join(dir, 'index.jsonl'), JSON.stringify({ id, ts: generated, store: 'mindmaps', title: stored.title }) + '\n', 'utf8');
  let mmdPath = null, mdPath = null;
  if (opts.mermaid) { mmdPath = resolveMindmapFile(id, '.mmd').file; fs.writeFileSync(mmdPath, toMermaid(stored), 'utf8'); }
  if (opts.outlineMd) { mdPath = resolveMindmapFile(id, '.md').file; fs.writeFileSync(mdPath, renderOutlineMd(stored), 'utf8'); }
  return { map_id: id, jsonPath, mmdPath, mdPath };
}

function logEvent(runId, eventType, extra) {
  const logEventPath = path.join(CLAUDE_DIR, 'forge-dashboard', 'log-event.cjs');
  return spawnSync(process.execPath, [logEventPath, runId, eventType, JSON.stringify(extra || {})], { encoding: 'utf8' });
}

module.exports = { buildFromOutline, toMermaid, writeMindmap };

// ---- CLI ----
if (require.main === module) {
  const main = () => {
    const argv = process.argv.slice(2);
    const cmd = argv[0];

    if (cmd === 'from-outline') {
      const outlineText = argv[1];
      const mapId = argv[2];
      if (!outlineText || !mapId) { console.error("Usage: node forge-mindmap.cjs from-outline '<outline-text>' <map_id> [--run <id>] [--mermaid] [--write]"); process.exitCode = 1; return; }

      let run = null, wantMermaid = false, wantWrite = false;
      for (let i = 3; i < argv.length; i++) {
        if (argv[i] === '--run') run = argv[++i];
        else if (argv[i] === '--mermaid') wantMermaid = true;
        else if (argv[i] === '--write') wantWrite = true;
      }

      const built = buildFromOutline(outlineText);
      const map = { map_id: mapId, title: (built.nodes[0] && built.nodes[0].label) || mapId, nodes: built.nodes, edges: built.edges };

      if (!wantWrite) { console.log(JSON.stringify(map, null, 2)); return; }

      let result;
      try { result = writeMindmap(map, { mermaid: wantMermaid }); }
      catch (e) { console.error('forge-mindmap: write failed: ' + e.message); process.exitCode = 1; return; }

      if (run) {
        const g = logEvent(run, 'mindmap_generated', { agent: 'orchestrator', note: 'Mind map generated: ' + map.title, map_id: result.map_id });
        if (g.status !== 0) console.error('forge-mindmap: log-event (mindmap_generated) warning: ' + (g.stderr || '').trim());
      }

      console.log('Mind map written: ' + result.map_id);
      console.log('  json: ' + result.jsonPath);
      if (result.mmdPath) console.log('  mmd:  ' + result.mmdPath);
      return;
    }

    if (cmd === 'write') {
      const json = argv[1];
      if (!json) { console.error("Usage: node forge-mindmap.cjs write '<map-json>' [--run <id>] [--mermaid]"); process.exitCode = 1; return; }
      let map;
      try { map = JSON.parse(json); } catch (e) { console.error('forge-mindmap: invalid JSON: ' + e.message); process.exitCode = 1; return; }

      let run = null, wantMermaid = false;
      for (let i = 2; i < argv.length; i++) {
        if (argv[i] === '--run') run = argv[++i];
        else if (argv[i] === '--mermaid') wantMermaid = true;
      }

      let result;
      try { result = writeMindmap(map, { mermaid: wantMermaid }); }
      catch (e) { console.error('forge-mindmap: write failed: ' + e.message); process.exitCode = 1; return; }

      if (run) {
        const g = logEvent(run, 'mindmap_generated', { agent: 'orchestrator', note: 'Mind map generated: ' + (map.title || result.map_id), map_id: result.map_id });
        if (g.status !== 0) console.error('forge-mindmap: log-event (mindmap_generated) warning: ' + (g.stderr || '').trim());
      }

      console.log('Mind map written: ' + result.map_id);
      console.log('  json: ' + result.jsonPath);
      if (result.mmdPath) console.log('  mmd:  ' + result.mmdPath);
      return;
    }

    console.error("Usage: node forge-mindmap.cjs <from-outline|write> ... [--run <id>] [--mermaid] [--write]");
    process.exitCode = 1;
  };
  try { main(); } catch (e) { console.error('forge-mindmap: ' + e.message); process.exitCode = 1; }
}
