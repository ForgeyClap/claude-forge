// GET /api/mcp source: reads the SELECTED project's own .claude/config/orchestration/
// mcp-registry.json (the dormant server catalog) + mcp-grants.json (the per-Boss least-privilege
// matrix) — read-only, never touches forge-mcp-gate.cjs's runtime. Per the registry's own `_doc`,
// EVERY server's `status` MUST be 'not-installed' until the owner opts in; this endpoint reads
// that field verbatim rather than inferring "installed" from anything else. A server is only ever
// reported `opted_in:true` when a real config/orchestration/mcp-opt-in.json (owner-authored, not
// shipped by Forge) lists its id — its absence is the expected, honest default (every server
// opted_in:false), never invented. This endpoint never claims a server is active/installed beyond
// what these two-to-three real config files literally say.
import fs from 'node:fs';
import path from 'node:path';
import { containmentOk } from './security.mjs';

function readJsonSafe(filePath) {
  try { return { ok: true, data: JSON.parse(fs.readFileSync(filePath, 'utf8')) }; }
  catch (err) { return { ok: false, error: err && err.message ? err.message : String(err) }; }
}

export function buildMcpView(projectPath) {
  const claudeDir = path.join(projectPath, '.claude');
  const orchestrationDir = path.join(claudeDir, 'config', 'orchestration');
  const registryFile = path.join(orchestrationDir, 'mcp-registry.json');
  const grantsFile = path.join(orchestrationDir, 'mcp-grants.json');
  const optInFile = path.join(orchestrationDir, 'mcp-opt-in.json');

  if (!containmentOk(claudeDir, registryFile) || !containmentOk(claudeDir, grantsFile) || !containmentOk(claudeDir, optInFile)) {
    return { ok: false, error: 'path containment violation' };
  }

  const registry = readJsonSafe(registryFile);
  const grants = readJsonSafe(grantsFile);
  const optIn = readJsonSafe(optInFile); // absence is expected/honest — see header comment

  const optedInIds = new Set(optIn.ok && Array.isArray(optIn.data.servers) ? optIn.data.servers : []);
  const rawServers = registry.ok && Array.isArray(registry.data.servers) ? registry.data.servers : [];
  const servers = rawServers.map((s) => ({
    id: s.id,
    purpose: s.purpose || null,
    tier: typeof s.tier === 'number' ? s.tier : null,
    network: s.network || null,
    credentials_needed: !!s.credentials_needed,
    status: s.status || 'not-installed',
    opted_in: optedInIds.has(s.id),
    notes: s.notes || null,
  }));

  const bossesRaw = grants.ok && grants.data.bosses ? grants.data.bosses : {};
  const boss_grants = Object.entries(bossesRaw).map(([slug, g]) => ({
    slug,
    max_tier: typeof g.max_tier === 'number' ? g.max_tier : 0,
    allow_servers: Array.isArray(g.allow_servers) ? g.allow_servers : [],
    why: g.why || null,
  }));

  return {
    ok: true,
    servers,
    servers_count: servers.length,
    installed_count: servers.filter((s) => s.status === 'installed' || s.status === 'active').length,
    opted_in_count: servers.filter((s) => s.opted_in).length,
    boss_grants,
    registry_present: registry.ok,
    grants_present: grants.ok,
    opt_in_file_present: optIn.ok,
    captured_at: new Date().toISOString(),
    age_ms: 0,
    provenance: 'DERIVED',
  };
}
