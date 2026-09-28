// T3.5b tests — buildSkillsRegistry() against THIS project's real 45 SKILL.md files and the real
// FORGE_SKILL_REGISTRY.md table.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildSkillsRegistry } from '../src/skills.mjs';
import { PROJECT_ROOT } from '../src/paths.mjs';
import { makeTempProjectRoot } from '../test-support/helpers.mjs';

const tempRoots = [];
after(() => { for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true }); });

test('buildSkillsRegistry finds the real skill directories with parsed frontmatter', () => {
  const result = buildSkillsRegistry(PROJECT_ROOT);
  assert.equal(result.ok, true);
  assert.ok(result.skills_count >= 40, 'at least the known ~45 real forge-* skills');
  const router = result.skills.find((s) => s.slug === 'forge-router');
  assert.ok(router);
  assert.equal(router.name, 'forge-router');
  assert.equal(router.has_skill_md, true);
  assert.ok(router.description && router.description.length > 10);
});

test('the real FORGE_SKILL_REGISTRY.md markdown table is parsed into real rows', () => {
  const result = buildSkillsRegistry(PROJECT_ROOT);
  assert.equal(result.registry_present, true);
  assert.ok(result.registry.length >= 10);
  const row = result.registry.find((r) => r.Skill === 'forge-router');
  assert.ok(row, 'the header-keyed row for forge-router must be present');
  assert.equal(row.Status, 'active');
});

// WP-CC1 (item 15): `.claude/skills/.claude-flow` is a real directory this fleet has (the
// Ruflo/claude-flow coordination cache) — it must never be listed as a nameless "skill" row.
// Isolated fixture (not PROJECT_ROOT) so this is verified independent of whichever real project
// this gateway happens to be checked out under.
test('a .claude-flow directory under .claude/skills is excluded, never listed as a skill', () => {
  const root = makeTempProjectRoot();
  tempRoots.push(root);
  const skillsDir = path.join(root, '.claude', 'skills');
  fs.mkdirSync(path.join(skillsDir, '.claude-flow'), { recursive: true });
  fs.mkdirSync(path.join(skillsDir, 'a-real-skill'), { recursive: true });
  fs.writeFileSync(
    path.join(skillsDir, 'a-real-skill', 'SKILL.md'),
    '---\nname: a-real-skill\ndescription: a real test skill\n---\nbody',
    'utf8',
  );

  const result = buildSkillsRegistry(root);
  assert.equal(result.ok, true);
  assert.equal(result.skills_count, 1);
  assert.equal(result.skills[0].slug, 'a-real-skill');
  assert.ok(!result.skills.some((s) => s.slug === '.claude-flow'));
});
