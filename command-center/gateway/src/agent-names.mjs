// WP-CC1 (items 5 & 6): the ONE place that resolves an agent's slug ("build-boss", what /api/agents
// keys rows by) against its real display name ("Build Boss", what run-log events actually log in
// their `agent` field — verified live against this project's own events.jsonl). Both agents.mjs
// (adds `display_name`/`aliases` to the registry, item 6) and agent-dispatches.mjs (needs the
// display-name -> slug direction for its new run-log dispatch rows, item 5) need this same mapping;
// factored out here, dependency-free, so importing it from either side can never create a circular
// import between those two files (each of which also imports the OTHER for a different reason).
//
// Source of the display name: `.claude/config/agents/agent-registry.json`'s own `agents[slug].name`
// field (e.g. `{"build-boss": {"name": "Build Boss", ...}}`) — the 12 permanent Bosses only, by that
// file's own documented scope (see agents.mjs's header). An agent outside that registry (one of the
// 7 ad-hoc specialists in agent-tool-policy.json) has no known display name here; callers fall back
// to the slug itself, never a guess.
import fs from 'node:fs';
import path from 'node:path';
import { containmentOk } from './security.mjs';

function readJsonSafe(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}

/**
 * buildAgentNameIndex(projectPath) -> { slugToDisplay: Map<slug, displayName>,
 * displayToSlug: Map<normalizedDisplayNameOrSlug, slug> }. `displayToSlug` is keyed by the
 * LOWERCASED form of every real name variant seen for a slug (the slug itself, and the registry's
 * display name when different) — a lookup normalizes its own input the same way, so "Build Boss",
 * "build boss" and "build-boss" all resolve to the one real slug. Never throws; a missing/unreadable
 * registry degrades to two empty maps (every lookup then honestly falls back to the raw input).
 */
export function buildAgentNameIndex(projectPath) {
  const slugToDisplay = new Map();
  const displayToSlug = new Map();
  const claudeDir = path.join(projectPath, '.claude');
  const registryFile = path.join(claudeDir, 'config', 'agents', 'agent-registry.json');
  if (!containmentOk(claudeDir, registryFile)) return { slugToDisplay, displayToSlug };
  const registry = readJsonSafe(registryFile);
  const bossAgents = registry && registry.agents && typeof registry.agents === 'object' ? registry.agents : {};
  for (const [slug, entry] of Object.entries(bossAgents)) {
    const displayName = entry && typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : null;
    slugToDisplay.set(slug, displayName);
    displayToSlug.set(slug.toLowerCase(), slug);
    if (displayName) displayToSlug.set(displayName.toLowerCase(), slug);
  }
  return { slugToDisplay, displayToSlug };
}

/** slugFor(index, rawAgentName) -> the real slug for a raw `agent` string off an event (e.g. "Build
 * Boss"), or the ORIGINAL string, lowercased-and-hyphenated as an honest best-effort guess, when no
 * registry entry matches — never null, so a caller always has something stable to key rows by. */
export function slugFor(index, rawAgentName) {
  if (typeof rawAgentName !== 'string' || rawAgentName.trim() === '') return null;
  const trimmed = rawAgentName.trim();
  const known = index.displayToSlug.get(trimmed.toLowerCase());
  if (known) return known;
  return trimmed.toLowerCase().replace(/\s+/g, '-');
}

/** displayNameFor(index, slug) -> the real registry display name for `slug`, or `slug` itself when
 * unknown — never null, so a caller always has something to show. */
export function displayNameFor(index, slug) {
  if (typeof slug !== 'string' || slug === '') return slug || null;
  const known = index.slugToDisplay.get(slug);
  return known || slug;
}

/** aliasesFor(index, slug) -> a de-duplicated array of every real name variant known for `slug`
 * (the slug itself, plus the registry display name when it differs) — the set of strings that
 * could plausibly appear as an event's own `agent` field and mean this one agent. */
export function aliasesFor(index, slug) {
  const out = [slug];
  const display = index.slugToDisplay.get(slug);
  if (display && display !== slug && !out.includes(display)) out.push(display);
  return out;
}
