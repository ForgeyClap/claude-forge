// T3.5b tests — buildSkillsRegistry() against THIS project's real 45 SKILL.md files and the real
// FORGE_SKILL_REGISTRY.md table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSkillsRegistry } from '../src/skills.mjs';
import { PROJECT_ROOT } from '../src/paths.mjs';

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
