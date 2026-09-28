// T3.5 tests — buildAgentsRegistry() against THIS project's real 4 config sources.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildAgentsRegistry } from '../src/agents.mjs';
import { PROJECT_ROOT, COMMAND_CENTER_DATA_DIR } from '../src/paths.mjs';
import { writeEventsFile } from '../test-support/helpers.mjs';

// WP-CC1 (item 6) fixtures — isolated, nested under COMMAND_CENTER_DATA_DIR (a real descendant of
// PROJECT_ROOT/SYNC_SCAN_ROOTS; listRunLogDispatches()'s own anyContainmentOk() check, reached via
// buildAgentsRegistry()'s live-status merge, would reject a plain os.tmpdir() fixture — same
// reasoning as runs.test.mjs's own header comment).
const FIXTURE_PARENT = path.join(COMMAND_CENTER_DATA_DIR, 'gateway-test-tmp-agents');
const tempRoots = [];
function freshRoot() {
  fs.mkdirSync(FIXTURE_PARENT, { recursive: true });
  const root = fs.mkdtempSync(path.join(FIXTURE_PARENT, 'fixture-'));
  tempRoots.push(root);
  return root;
}
function writeAgentMd(root, slug, frontmatter) {
  const dir = path.join(root, '.claude', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  const lines = ['---', ...Object.entries(frontmatter).map(([k, v]) => k + ': ' + v), '---', 'body'];
  fs.writeFileSync(path.join(dir, slug + '.md'), lines.join('\n'), 'utf8');
}
function writeRegistry(root, agents) {
  const dir = path.join(root, '.claude', 'config', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent-registry.json'), JSON.stringify({ agents }), 'utf8');
}

after(() => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(FIXTURE_PARENT, { recursive: true, force: true });
});

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
  // 2026-09-23 (external audit II-D): the map used to name four skills that exist only in the author's global
  // ~/.claude; they were remapped to the shipped Forge equivalents. This pin follows the real file.
  // 2026-09-24 (v2.7.0, wp6b/wp13b): two vendored public skills (mattpocock/skills, MIT) now ship with Forge and
  // are attached to build-boss; setup-pre-commit is user-invoked only (see agent-skill-map.json invocationNotes).
  assert.deepEqual(buildBoss.skills, [
    'forge-skill-testing',
    'forge-debug',
    'forge-code-review',
    'forge-worktrees',
    'resolving-merge-conflicts',
    'setup-pre-commit',
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

// WP-CC1 (item 6) — display_name/aliases, and live status merged from the run-log dispatch view.
test('display_name comes from the registry (e.g. "Build Boss"), separate from the unchanged slug `name`', () => {
  const root = freshRoot();
  writeAgentMd(root, 'build-boss', { name: 'build-boss', description: 'x' });
  writeRegistry(root, { 'build-boss': { name: 'Build Boss', role: 'Implementation / coding' } });

  const result = buildAgentsRegistry(root);
  const bb = result.agents.find((a) => a.slug === 'build-boss');
  assert.equal(bb.name, 'build-boss', 'the existing `name` field must stay the slug, unchanged');
  assert.equal(bb.display_name, 'Build Boss');
  assert.deepEqual(bb.aliases, ['build-boss', 'Build Boss']);
});

test('an agent outside the registry (a specialist) falls back to its own slug for display_name/aliases, never a guess', () => {
  const root = freshRoot();
  writeAgentMd(root, 'codex-reviewer', { name: 'codex-reviewer', description: 'x' });
  writeRegistry(root, {});

  const result = buildAgentsRegistry(root);
  const cr = result.agents.find((a) => a.slug === 'codex-reviewer');
  assert.equal(cr.display_name, 'codex-reviewer');
  assert.deepEqual(cr.aliases, ['codex-reviewer']);
});

test('is_running/live_dispatches merge real run-log liveness when a projectName is given', () => {
  const root = freshRoot();
  writeAgentMd(root, 'build-boss', { name: 'build-boss', description: 'x' });
  writeRegistry(root, { 'build-boss': { name: 'Build Boss' } });
  const nowIso = new Date().toISOString();
  writeEventsFile(root, 'forge-live-run', [
    { event_type: 'run_started', timestamp: nowIso },
    { event_type: 'subagent_started', agent: 'Build Boss', dispatch_id: 'd1', timestamp: nowIso },
  ]);

  const withName = buildAgentsRegistry(root, 'some-project-name');
  const bb = withName.agents.find((a) => a.slug === 'build-boss');
  assert.equal(bb.is_running, true);
  assert.equal(bb.running_dispatch_count, 1);
  assert.equal(bb.live_dispatches.length, 1);
  assert.equal(bb.live_dispatches[0].source, 'run-log');

  // Omitting projectName (every OTHER existing call site) keeps the static registry behavior
  // exactly as before — honest false/empty, never a guess.
  const withoutName = buildAgentsRegistry(root);
  const bb2 = withoutName.agents.find((a) => a.slug === 'build-boss');
  assert.equal(bb2.is_running, false);
  assert.deepEqual(bb2.live_dispatches, []);
});
