// Lists the SELECTED project's .claude/skills/*/SKILL.md files (name + first description line,
// via the same simple line-based frontmatter parsing as agents.mjs — no yaml dependency) plus,
// when present, FORGE_SKILL_REGISTRY.md's own markdown table (parsed generically: header row +
// one row per real skill entry; a `|---|---|` separator row — with or without alignment colons —
// is recognized and skipped, never mistaken for data).
import fs from 'node:fs';
import path from 'node:path';
import { containmentOk } from './security.mjs';

function parseSkillFrontmatter(mdText) {
  const lines = mdText.split(/\r?\n/);
  const fm = { name: null, description: null };
  if (lines[0] !== '---') return fm;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') break;
    const idx = lines[i].indexOf(':');
    if (idx < 0) continue;
    const key = lines[i].slice(0, idx).trim();
    const value = lines[i].slice(idx + 1).trim();
    if (key === 'name') fm.name = value;
    if (key === 'description') fm.description = value;
  }
  return fm;
}

function listSkillDirs(skillsDir) {
  let entries;
  try { entries = fs.readdirSync(skillsDir, { withFileTypes: true }); } catch { return []; }
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

const SEPARATOR_CELL_RE = /^:?-+:?$/;

function parseRegistryTable(mdText) {
  const lines = mdText.split(/\r?\n/);
  const rows = [];
  let header = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = trimmed.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length === 0) continue;
    if (!header) { header = cells; continue; }
    if (cells.every((c) => SEPARATOR_CELL_RE.test(c))) continue; // the header/body separator row
    if (cells.length !== header.length) continue; // tolerate drift — an honest partial parse beats a crash
    const row = {};
    header.forEach((h, i) => { row[h] = cells[i]; });
    rows.push(row);
  }
  return rows;
}

export function buildSkillsRegistry(projectPath) {
  const claudeDir = path.join(projectPath, '.claude');
  const skillsDir = path.join(claudeDir, 'skills');
  const registryFile = path.join(claudeDir, 'FORGE_SKILL_REGISTRY.md');

  if (!containmentOk(claudeDir, skillsDir) || !containmentOk(claudeDir, registryFile)) {
    return { ok: false, error: 'path containment violation' };
  }

  const dirNames = listSkillDirs(skillsDir);
  const skills = dirNames.map((dirName) => {
    const skillMdPath = path.join(skillsDir, dirName, 'SKILL.md');
    let fm = { name: null, description: null };
    let hasSkillMd = false;
    try { fm = parseSkillFrontmatter(fs.readFileSync(skillMdPath, 'utf8')); hasSkillMd = true; } catch { hasSkillMd = false; }
    return { slug: dirName, name: fm.name || dirName, description: fm.description || null, has_skill_md: hasSkillMd };
  });

  let registryRows = [];
  let registryPresent = false;
  try {
    registryRows = parseRegistryTable(fs.readFileSync(registryFile, 'utf8'));
    registryPresent = true;
  } catch {
    registryPresent = false;
  }

  return {
    ok: true,
    skills,
    skills_count: skills.length,
    registry: registryRows,
    registry_present: registryPresent,
    captured_at: new Date().toISOString(),
    age_ms: 0,
    provenance: 'DERIVED',
  };
}
