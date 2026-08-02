// GET /api/tools source: an honest inventory of the SELECTED project's own .claude/forge-bin/
// *.cjs tool scripts — name, whether a matching *.test.cjs exists (`has_test`, a real quality
// signal per T6.4), size and mtime. Read-only: this module NEVER executes any of these scripts —
// the one allowlisted spawn this whole WP is permitted lives in capabilities.mjs. Cached 60s per
// project — a plain directory listing + stat is cheap, but a poll cadence still benefits from not
// re-reading the whole directory on every tick.
import fs from 'node:fs';
import path from 'node:path';
import { containmentOk } from './security.mjs';

const CACHE_TTL_MS = 60_000;
// WP10 F4 (Codex, bounded-cache hardening): hard cap on distinct cached project paths so memory
// stays bounded regardless of how many different projects get inventoried over the gateway's
// lifetime. FIFO eviction (oldest-inserted key first) — simple and sufficient for a read-only,
// non-adversarial-key cache like this one.
const MAX_CACHE_ENTRIES = 100;
const cacheByProject = new Map(); // projectPath -> { data, capturedAtMs, expiresAt }

function evictIfNeeded(key) {
  if (cacheByProject.has(key)) return;
  while (cacheByProject.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = cacheByProject.keys().next().value;
    cacheByProject.delete(oldestKey);
  }
}

function computeTools(projectPath) {
  const claudeDir = path.join(projectPath, '.claude');
  const binDir = path.join(claudeDir, 'forge-bin');
  if (!containmentOk(claudeDir, binDir)) {
    return { ok: false, error: 'path containment violation', tools: [], tools_count: 0 };
  }
  let entries;
  try {
    entries = fs.readdirSync(binDir, { withFileTypes: true });
  } catch (err) {
    return { ok: true, tools: [], tools_count: 0, note: 'forge-bin directory not readable: ' + (err && err.message ? err.message : String(err)) };
  }
  const cjsNames = entries.filter((e) => e.isFile() && e.name.endsWith('.cjs')).map((e) => e.name);
  const testNames = new Set(cjsNames.filter((n) => n.endsWith('.test.cjs')));
  const toolNames = cjsNames.filter((n) => !n.endsWith('.test.cjs')).sort();

  const tools = toolNames.map((name) => {
    const filePath = path.join(binDir, name);
    let size = null;
    let mtime = null;
    try {
      const stat = fs.statSync(filePath);
      size = stat.size;
      mtime = stat.mtime.toISOString();
    } catch { /* leave null, honest */ }
    const testName = name.replace(/\.cjs$/, '.test.cjs');
    return { name, has_test: testNames.has(testName), size, mtime };
  });

  return { ok: true, tools, tools_count: tools.length };
}

// Returns { ok, tools, tools_count, note?, captured_at, age_ms, provenance }. `provenance` is
// always 'DERIVED' (a fresh compute or a cache hit) — a plain fs read is cheap enough that this
// module never needs projects.mjs's fuller stale-while-revalidate machinery.
export function buildToolsInventory(projectPath, now = Date.now()) {
  const cached = cacheByProject.get(projectPath);
  if (cached && cached.expiresAt > now) {
    return { ...cached.data, age_ms: now - cached.capturedAtMs, provenance: 'DERIVED' };
  }
  const result = computeTools(projectPath);
  const capturedAtMs = Date.now();
  const data = { ...result, captured_at: new Date(capturedAtMs).toISOString(), age_ms: 0, provenance: 'DERIVED' };
  evictIfNeeded(projectPath);
  cacheByProject.set(projectPath, { data, capturedAtMs, expiresAt: capturedAtMs + CACHE_TTL_MS });
  return data;
}

export function _resetToolsCacheForTests() { cacheByProject.clear(); }
export function _toolsCacheSizeForTests() { return cacheByProject.size; }
export const _TOOLS_MAX_CACHE_ENTRIES_FOR_TESTS = MAX_CACHE_ENTRIES;
