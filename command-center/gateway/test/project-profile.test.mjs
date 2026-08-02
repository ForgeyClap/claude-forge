// cc-fix-adapter T6d tests — buildProjectProfile() against THIS project's own real
// FORGE_PROJECT_PROFILE.md + FORGE_VERSION.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProjectProfile } from '../src/project-profile.mjs';
import { PROJECT_ROOT } from '../src/paths.mjs';

test('buildProjectProfile reads this real project profile + version file', () => {
  const result = buildProjectProfile(PROJECT_ROOT);
  assert.equal(result.ok, true);
  assert.equal(result.profile_present, true);
  assert.match(result.project_name, /Forge V2/);
  // The real profile line is free text ("tooling / meta — ... Mixed.") — never forced into a
  // ProjectType bucket, returned verbatim so a consumer can show the real sentence.
  assert.match(result.project_type_raw, /tooling \/ meta/);
  assert.ok(result.project_goal && result.project_goal.length > 0);
  assert.equal(result.version_present, true);
  assert.equal(typeof result.forge_version, 'string');
  assert.ok(result.forge_version.length > 0);
});

test('a project with no profile/version files reports honest absence, never a guess', () => {
  const result = buildProjectProfile('/nonexistent/project/path/for-this-test');
  assert.equal(result.ok, true);
  assert.equal(result.profile_present, false);
  assert.equal(result.project_name, null);
  assert.equal(result.project_type_raw, null);
  assert.equal(result.version_present, false);
  assert.equal(result.forge_version, null);
});
