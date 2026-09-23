// fix-placeholder (forge-2026-07-29-cc-finish, P1) — proves buildProjectProfile() never returns
// unfilled scaffold text (e.g. "<one or two lines>") as if it were a real project field. Uses a
// real temp `.claude/FORGE_PROJECT_PROFILE.md` on disk (same pattern as project-profile.test.mjs),
// never the actual "100 apps"/"a cashflow project"/"an e-commerce project" project folders — those are a different
// project and stay untouched per this run's isolation rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildProjectProfile } from '../src/project-profile.mjs';

function makeProjectWithProfile(profileMarkdown) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gateway-placeholder-test-'));
  const claudeDir = path.join(root, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'FORGE_PROJECT_PROFILE.md'), profileMarkdown, 'utf8');
  return root;
}

test('a fully-unfilled scaffold (the real "100 apps"/"a cashflow project"/"an e-commerce project" shape) is reported as absent, never as template text', () => {
  const root = makeProjectWithProfile(
    [
      '- **Project name:** <name>',
      '- **Project type:** <website | landing | full-stack | n8n | chatbot/RAG | scraping | prediction | telegram | dashboard | business-automation | api-integration | mixed | unknown>',
      '- **Project goal:** <one or two lines>',
      '- **Maturity:** <new | existing | mid-project | mature>',
      '',
    ].join('\n'),
  );
  const result = buildProjectProfile(root);
  fs.rmSync(root, { recursive: true, force: true });

  assert.equal(result.ok, true);
  assert.equal(result.profile_present, true);
  assert.equal(result.project_name, null);
  assert.equal(result.project_type_raw, null);
  assert.equal(result.project_goal, null);
  assert.equal(result.maturity, null);
  assert.deepEqual(
    [...result.profile_unfilled_fields].sort(),
    ['maturity', 'project_goal', 'project_name', 'project_type_raw'],
  );
});

test('real prose that happens to contain a "<" character mid-sentence is passed through unchanged', () => {
  const goal = 'Ship a dashboard where health < 80 triggers an alert, and export the report.';
  const root = makeProjectWithProfile(`- **Project goal:** ${goal}\n`);
  const result = buildProjectProfile(root);
  fs.rmSync(root, { recursive: true, force: true });

  assert.equal(result.project_goal, goal);
  assert.deepEqual(result.profile_unfilled_fields, []);
});

test('the parenthetical scaffold variant (the real "forge-system-public" shape) is reported as absent, never as template text', () => {
  const root = makeProjectWithProfile(
    [
      '- **Project name:** (set on first `/forge` run)',
      '- **Project type:** (detected on first run — website / full-stack / n8n / RAG / scraping / prediction / integration / tooling / …)',
      '- **Project goal:** (from the user\'s first task)',
      '',
    ].join('\n'),
  );
  const result = buildProjectProfile(root);
  fs.rmSync(root, { recursive: true, force: true });

  assert.equal(result.project_name, null);
  assert.equal(result.project_type_raw, null);
  assert.equal(result.project_goal, null);
  assert.deepEqual(
    [...result.profile_unfilled_fields].sort(),
    ['project_goal', 'project_name', 'project_type_raw'],
  );
});

// The four real fleet shapes the parenthetical anchor must NOT touch. Each string below is a
// verbatim value read from a live `/api/projects/:name/profile` response before the rule was
// widened — this test exists so a future "just use .includes('(')" simplification fails loudly
// instead of quietly blanking four real projects' identities.
test('real prose containing parentheses mid-sentence is passed through unchanged (the anchor is end-to-end, not a contains-check)', () => {
  const realFleetValues = [
    'Forge V2 Hybrid Installer ("my-forge-project")',
    'new (greenfield)',
    'n8n / automation (booking + quotation backend)',
    'unknown (empty folder at install time — `needs verification` once first task lands)',
  ];

  for (const value of realFleetValues) {
    const root = makeProjectWithProfile(`- **Project goal:** ${value}\n`);
    const result = buildProjectProfile(root);
    fs.rmSync(root, { recursive: true, force: true });

    assert.equal(result.project_goal, value, `must not null real prose: ${value}`);
    assert.deepEqual(result.profile_unfilled_fields, []);
  }
});

test('a bullet with an empty value (nothing after the colon) is reported as absent, not as ""', () => {
  const root = makeProjectWithProfile('- **Project goal:**\n');
  const result = buildProjectProfile(root);
  fs.rmSync(root, { recursive: true, force: true });

  assert.equal(result.project_goal, null);
  assert.deepEqual(result.profile_unfilled_fields, ['project_goal']);
});

test('a missing bullet (field never in the file at all) is reported as absent and NOT counted as "unfilled" (it was never there to begin with)', () => {
  const root = makeProjectWithProfile('- **Project name:** Real Project\n');
  const result = buildProjectProfile(root);
  fs.rmSync(root, { recursive: true, force: true });

  assert.equal(result.project_name, 'Real Project');
  assert.equal(result.project_goal, null);
  assert.deepEqual(result.profile_unfilled_fields, []);
});

test('a sentence containing the word "TODO" (an already-honest generated disclosure, like the real demo-sandbox-automation profile) is left untouched, not nulled', () => {
  const goal = '`unknown` — PROJECT.md "Business purpose" is TODO. Needs verification from owner.';
  const root = makeProjectWithProfile(`- **Project goal:** ${goal}\n`);
  const result = buildProjectProfile(root);
  fs.rmSync(root, { recursive: true, force: true });

  assert.equal(result.project_goal, goal);
  assert.deepEqual(result.profile_unfilled_fields, []);
});

test('no profile file at all still reports honest absence with an empty unfilled-fields array', () => {
  const result = buildProjectProfile('/nonexistent/project/path/for-this-test');
  assert.equal(result.profile_present, false);
  assert.equal(result.project_goal, null);
  assert.deepEqual(result.profile_unfilled_fields, []);
});
