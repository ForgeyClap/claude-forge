// T3.5 tests — buildAgentsRegistry() against THIS project's real 4 config sources.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentsRegistry } from '../src/agents.mjs';
import { PROJECT_ROOT } from '../src/paths.mjs';

test('buildAgentsRegistry finds the real 19 agent-md files and the 12 permanent Bosses', () => {
  const result = buildAgentsRegistry(PROJECT_ROOT);
  assert.equal(result.ok, true);
  assert.equal(result.total_agents, 19);
  assert.equal(result.permanent_boss_count, 12);
  assert.equal(result.sources.registry_present, true);
  assert.equal(result.sources.model_map_present, true);
  assert.equal(result.sources.tool_policy_present, true);
});

test('build-boss merges all 3 config sources correctly (full-build class, sonnet tier, nvidia-bulk-only)', () => {
  const result = buildAgentsRegistry(PROJECT_ROOT);
  const buildBoss = result.agents.find((a) => a.slug === 'build-boss');
  assert.ok(buildBoss);
  assert.equal(buildBoss.name, 'build-boss');
  assert.ok(buildBoss.tools.includes('Bash'));
  assert.equal(buildBoss.class, 'full-build');
  assert.equal(buildBoss.model_tier, 'sonnet');
  assert.equal(buildBoss.usage_policy_bucket, 'nvidia-bulk-only');
  assert.equal(buildBoss.is_permanent_boss, true);
  assert.equal(buildBoss.role, 'Implementation / coding');
});

test('review-boss is read-only-audit and claude-wins-skip-nvidia', () => {
  const result = buildAgentsRegistry(PROJECT_ROOT);
  const reviewBoss = result.agents.find((a) => a.slug === 'review-boss');
  assert.ok(reviewBoss);
  assert.equal(reviewBoss.class, 'read-only-audit');
  assert.ok(!reviewBoss.tools.includes('Write'));
  assert.equal(reviewBoss.usage_policy_bucket, 'claude-wins-skip-nvidia');
});

test('a non-Boss specialist agent (codex-reviewer) is correctly NOT a permanent Boss and not in the usage-policy map', () => {
  const result = buildAgentsRegistry(PROJECT_ROOT);
  const codexReviewer = result.agents.find((a) => a.slug === 'codex-reviewer');
  assert.ok(codexReviewer);
  assert.equal(codexReviewer.is_permanent_boss, false);
  assert.equal(codexReviewer.role, null);
  assert.equal(codexReviewer.class, 'exec-reviewer');
  assert.equal(codexReviewer.usage_policy_bucket, 'not-applicable');
});

// cc-fix-adapter T6a — real per-agent skills[] from agent-skill-map.json, previously read by
// nothing in this gateway even though agents.mjs already reads the other 3 sibling config files.
test('build-boss carries its real CORE skill list from agent-skill-map.json', () => {
  const result = buildAgentsRegistry(PROJECT_ROOT);
  assert.equal(result.sources.skill_map_present, true);
  const buildBoss = result.agents.find((a) => a.slug === 'build-boss');
  assert.ok(buildBoss);
  assert.deepEqual(buildBoss.skills, [
    'test-driven-development',
    'systematic-debugging',
    'code-review-excellence',
    'using-git-worktrees',
  ]);
});

test('an agent with no entry in agent-skill-map.json gets an honest empty list, never a guess', () => {
  const result = buildAgentsRegistry(PROJECT_ROOT);
  const unmapped = result.agents.find((a) => !Object.prototype.hasOwnProperty.call(
    { boss: 1, 'head-chef': 1, 'review-boss': 1, 'test-boss': 1, 'ui-boss': 1, 'seo-boss': 1, 'security-boss': 1, 'skill-boss': 1, 'search-boss': 1, 'build-boss': 1, 'integration-boss': 1, 'docs-boss': 1 },
    a.slug,
  ));
  assert.ok(unmapped, 'expected at least one non-Boss agent not present in agent-skill-map.json');
  assert.deepEqual(unmapped.skills, []);
});
