// Merges the SELECTED project's 5 real agent-config sources into one per-agent view:
// config/agents/agent-registry.json (the 12 permanent Bosses), agent-model-map.json (Claude tier
// + NVIDIA-as-tool routing + usage-policy bucket), agent-tool-policy.json (least-privilege class
// + real tool grants — all 19 agent-md files), agent-skill-map.json (the real per-agent CORE
// skill list — cc-fix-adapter T6a: previously read by nothing in this gateway even though it sits
// right next to the other 3 config files), and .claude/agents/*.md's own frontmatter (name,
// description, tools, model, memory). Frontmatter parsing is intentionally simple line-based
// `key: value` extraction (no yaml dependency, per this gateway's zero-dep rule) — every real
// agent-md file here uses single-line frontmatter values, verified by reading one before writing
// this parser.
import fs from 'node:fs';
import path from 'node:path';
import { containmentOk } from './security.mjs';
// WP-CC1 (item 6, live status): the run-log dispatch view (item 5) is the one real source of "is
// this agent working right now" — reused here rather than re-scanning run events a second time.
// Deliberately imported from agent-dispatches.mjs (not re-implemented) so there is exactly one
// place that decides what "running"/"stalled" means for a run-log dispatch.
import { listRunLogDispatches } from './agent-dispatches.mjs';
// Both this file and agent-dispatches.mjs need the same slug<->display-name mapping (registry
// `name` field vs the slug an agent-md frontmatter/API response uses) — factored into its own
// dependency-free module so importing it here never risks a circular import with
// agent-dispatches.mjs (which also imports it, for the opposite direction: display name -> slug).
import { buildAgentNameIndex, displayNameFor, aliasesFor } from './agent-names.mjs';

function readJsonSafe(filePath) {
  try { return { ok: true, data: JSON.parse(fs.readFileSync(filePath, 'utf8')) }; }
  catch (err) { return { ok: false, error: err && err.message ? err.message : String(err) }; }
}

function parseFrontmatter(mdText) {
  const lines = mdText.split(/\r?\n/);
  const fm = {};
  if (lines[0] !== '---') return fm;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') break;
    const idx = lines[i].indexOf(':');
    if (idx < 0) continue;
    fm[lines[i].slice(0, idx).trim()] = lines[i].slice(idx + 1).trim();
  }
  return fm;
}

function listAgentMdFiles(agentsDir) {
  let entries;
  try { entries = fs.readdirSync(agentsDir, { withFileTypes: true }); } catch { return []; }
  return entries.filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name).sort();
}

export function buildAgentsRegistry(projectPath, projectName = null) {
  const claudeDir = path.join(projectPath, '.claude');
  const registryFile = path.join(claudeDir, 'config', 'agents', 'agent-registry.json');
  const modelMapFile = path.join(claudeDir, 'config', 'agents', 'agent-model-map.json');
  const toolPolicyFile = path.join(claudeDir, 'config', 'agents', 'agent-tool-policy.json');
  const skillMapFile = path.join(claudeDir, 'config', 'agents', 'agent-skill-map.json');
  const agentsDir = path.join(claudeDir, 'agents');

  // Defense in depth: these are all internally constructed from a trusted registry entry's own
  // path, never request input, but every other module in this gateway re-checks containment too.
  if (
    !containmentOk(claudeDir, registryFile) || !containmentOk(claudeDir, modelMapFile) ||
    !containmentOk(claudeDir, toolPolicyFile) || !containmentOk(claudeDir, skillMapFile) ||
    !containmentOk(claudeDir, agentsDir)
  ) {
    return { ok: false, error: 'path containment violation' };
  }

  const registry = readJsonSafe(registryFile);
  const modelMap = readJsonSafe(modelMapFile);
  const toolPolicy = readJsonSafe(toolPolicyFile);
  const skillMap = readJsonSafe(skillMapFile);

  const bossAgents = registry.ok ? (registry.data.agents || {}) : {};
  const modelAgents = modelMap.ok ? (modelMap.data.agents || {}) : {};
  const toolAgents = toolPolicy.ok ? (toolPolicy.data.agents || {}) : {};
  const skillAgents = skillMap.ok ? (skillMap.data.agents || {}) : {};
  const usagePolicy = modelMap.ok ? (modelMap.data.usagePolicy || {}) : {};
  const claudeWinsRoles = new Set((usagePolicy.claudeWinsSkipNvidia && usagePolicy.claudeWinsSkipNvidia.roles) || []);
  const nvidiaBulkRoles = new Set((usagePolicy.nvidiaForBulkOnly && usagePolicy.nvidiaForBulkOnly.roles) || []);

  // WP-CC1 (item 6): the same registry data buildAgentsRegistry() already loaded above, indexed
  // for slug<->display-name lookups — see agent-names.mjs's own header for why this is a shared,
  // dependency-free module rather than inlined twice.
  const nameIndex = buildAgentNameIndex(projectPath);
  // WP-CC1 (item 6, live status): the SAME run-log dispatch rows /api/agent-dispatches now returns
  // (item 5) — grouped here by `agent_slug` so each agent row can honestly say whether it has an
  // open, currently-running dispatch right now. `projectName` is optional (server.mjs's other
  // caller sites that only need the static registry keep working with zero behavior change); when
  // omitted, every agent's live fields stay honestly `null`/`[]`, never a guess.
  const liveBySlug = new Map();
  if (typeof projectName === 'string' && projectName.length > 0) {
    for (const dispatch of listRunLogDispatches(projectPath)) {
      if (!liveBySlug.has(dispatch.agent_slug)) liveBySlug.set(dispatch.agent_slug, []);
      liveBySlug.get(dispatch.agent_slug).push(dispatch);
    }
  }

  const mdFiles = listAgentMdFiles(agentsDir);
  const agents = mdFiles.map((fileName) => {
    const slug = fileName.replace(/\.md$/, '');
    let fm = {};
    try { fm = parseFrontmatter(fs.readFileSync(path.join(agentsDir, fileName), 'utf8')); } catch { fm = {}; }
    const tp = toolAgents[slug] || null;
    const mm = modelAgents[slug] || null;
    const boss = bossAgents[slug] || null;
    const liveDispatches = liveBySlug.get(slug) || [];
    const runningNow = liveDispatches.filter((d) => d.running);
    return {
      slug,
      name: fm.name || slug,
      // WP-CC1 (item 6): the real human display name events actually log (e.g. "Build Boss"),
      // separate from `name` above (which stays the frontmatter/slug value — an existing field this
      // WP must not change the meaning of). Falls back to the slug itself when the registry has no
      // entry for it (the 7 ad-hoc specialists outside the 12 permanent Bosses).
      display_name: displayNameFor(nameIndex, slug),
      aliases: aliasesFor(nameIndex, slug),
      description: fm.description || null,
      tools: tp ? (tp.tools || []) : (fm.tools ? fm.tools.split(',').map((t) => t.trim()).filter(Boolean) : []),
      class: tp ? tp.class || null : null,
      model_tier: mm ? (mm.claudeTier || null) : (fm.model || (tp ? tp.model || null : null)),
      claude_effort: mm ? (mm.claudeEffort || null) : null,
      nvidia_role: mm ? (mm.nvidia || null) : null,
      nvidia_fallback: mm ? (mm.nvidiaFallback || null) : null,
      premium: mm ? (mm.premium || null) : null,
      usage_policy_bucket: claudeWinsRoles.has(slug) ? 'claude-wins-skip-nvidia' : (nvidiaBulkRoles.has(slug) ? 'nvidia-bulk-only' : 'not-applicable'),
      memory: fm.memory || null,
      is_permanent_boss: !!boss,
      role: boss ? boss.role || null : null,
      responsibilities: boss ? boss.responsibilities || null : null,
      // cc-fix-adapter T6a: the real per-agent CORE skill list (Skill Boss's own attach-time
      // source) — an agent with no entry in the map gets an honest empty list, never a guess.
      skills: Array.isArray(skillAgents[slug]) ? skillAgents[slug] : [],
      // WP-CC1 (item 6, live status) — real values only: `false`/`[]`/`null` when `projectName`
      // was not supplied, or when this agent genuinely has no open run-log dispatch right now.
      is_running: runningNow.length > 0,
      running_dispatch_count: runningNow.length,
      live_dispatches: liveDispatches,
    };
  });

  return {
    ok: true,
    agents,
    total_agents: agents.length,
    permanent_boss_count: agents.filter((a) => a.is_permanent_boss).length,
    sources: { registry_present: registry.ok, model_map_present: modelMap.ok, tool_policy_present: toolPolicy.ok, skill_map_present: skillMap.ok },
    captured_at: new Date().toISOString(),
    age_ms: 0,
    provenance: 'DERIVED',
  };
}
