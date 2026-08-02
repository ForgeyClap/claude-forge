#!/usr/bin/env node
'use strict';
// forge-newskills.test.cjs — real presence/lint tests for the H3 skill bundle (2026-07-19).
// Proves each of the 4 new project-local skills (forge-debug, forge-brainstorm, forge-code-review,
// forge-worktrees) really exists on disk, has valid frontmatter (a `name:` that matches its own folder
// name + a real, non-stub `description:`), and contains every section that skill's own playbook promises
// (so a future edit can't silently gut a required section while leaving the file "present"). The
// frontmatter/section parser is also proven directly against synthetic fixtures (missing frontmatter,
// mismatched name, stub description, missing section) so a pass here means the DETECTOR works, not just
// that today's 4 files happen to look right.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

console.log('forge-newskills tests (H3 skill bundle — presence + frontmatter + required-section lint)');

const SKILLS_DIR = path.join(__dirname, '..', 'skills');

// ---------------------------------------------------------------------------
// Parser under test (small + local — this file's only job is to prove the 4 skills are real)
// ---------------------------------------------------------------------------
function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const block = m[1];
  const nameMatch = block.match(/^name:\s*(.+)$/m);
  const descMatch = block.match(/^description:\s*(.+)$/m);
  return {
    name: nameMatch ? nameMatch[1].trim() : null,
    description: descMatch ? descMatch[1].trim() : null,
  };
}

function hasSection(content, heading) {
  // exact heading line match (not just a substring buried in prose)
  return content.split(/\r?\n/).some((line) => line.trim() === heading);
}

function lintSkill(skillPath, requiredSections, expectedName) {
  const issues = [];
  if (!fs.existsSync(skillPath)) {
    return { ok: false, issues: ['file does not exist: ' + skillPath] };
  }
  const content = fs.readFileSync(skillPath, 'utf8');
  const fm = parseFrontmatter(content);
  if (!fm) issues.push('no valid frontmatter block (--- ... ---)');
  else {
    if (!fm.name) issues.push('frontmatter missing name:');
    else if (fm.name !== expectedName) issues.push('frontmatter name "' + fm.name + '" does not match expected "' + expectedName + '"');
    if (!fm.description) issues.push('frontmatter missing description:');
    else if (fm.description.length < 40) issues.push('description too short to be real (stub?): "' + fm.description + '"');
  }
  for (const heading of requiredSections) {
    if (!hasSection(content, heading)) issues.push('missing required section: ' + heading);
  }
  if (content.length < 800) issues.push('file suspiciously short for a real playbook (' + content.length + ' chars)');
  return { ok: issues.length === 0, issues, content, frontmatter: fm };
}

// ---------------------------------------------------------------------------
// 1) The 4 real H3 skills — presence, frontmatter, required sections
// ---------------------------------------------------------------------------
console.log('\n1) real skill files — presence + frontmatter + required sections');

const SKILLS = [
  {
    name: 'forge-debug',
    requiredSections: [
      '## Hard rules',
      '## The loop (reproduce → isolate → root-cause → fix → regression test → verify)',
      '## Isolation techniques',
      '## When to escalate',
      '## Honesty gate',
    ],
  },
  {
    name: 'forge-brainstorm',
    requiredSections: [
      '## Hard rules',
      '## The loop (diverge → constraints → converge → smallest viable first)',
      '## Output',
      '## Feeds into',
    ],
  },
  {
    name: 'forge-code-review',
    requiredSections: [
      '## Hard rules',
      "## Review order (fixed sequence — don't skip ahead to style)",
      '## Severity levels',
      '## Codex handoff (optional, never a blocker)',
      '## Relationship to Review Boss',
    ],
  },
  {
    name: 'forge-worktrees',
    requiredSections: [
      '## Hard rules',
      '## When to isolate',
      '## Create & integrate',
      '## Lead is the integration layer',
      '## Cleanup',
    ],
  },
];

for (const skill of SKILLS) {
  const skillPath = path.join(SKILLS_DIR, skill.name, 'SKILL.md');

  t(skill.name + ': SKILL.md exists on disk', () => {
    assert.ok(fs.existsSync(skillPath), 'expected file at ' + skillPath);
  });

  t(skill.name + ': has a valid frontmatter block with name: and description:', () => {
    const content = fs.readFileSync(skillPath, 'utf8');
    const fm = parseFrontmatter(content);
    assert.ok(fm, 'no frontmatter block found');
    assert.ok(fm.name, 'frontmatter missing name:');
    assert.ok(fm.description, 'frontmatter missing description:');
  });

  t(skill.name + ': frontmatter name: matches the skill folder name', () => {
    const content = fs.readFileSync(skillPath, 'utf8');
    const fm = parseFrontmatter(content);
    assert.strictEqual(fm.name, skill.name);
  });

  t(skill.name + ': description is real content, not a stub (>= 40 chars)', () => {
    const content = fs.readFileSync(skillPath, 'utf8');
    const fm = parseFrontmatter(content);
    assert.ok(fm.description.length >= 40, 'description too short: "' + fm.description + '"');
  });

  t(skill.name + ': defers to its matching ECC skill (no duplicated methodology)', () => {
    const content = fs.readFileSync(skillPath, 'utf8');
    assert.ok(/Do not duplicate ECC skills — defer to:/.test(content), 'missing ECC-deference line');
  });

  for (const heading of skill.requiredSections) {
    t(skill.name + ': has required section "' + heading + '"', () => {
      const content = fs.readFileSync(skillPath, 'utf8');
      assert.ok(hasSection(content, heading), 'section not found: ' + heading);
    });
  }

  t(skill.name + ': overall lintSkill() reports ok (no issues)', () => {
    const result = lintSkill(skillPath, skill.requiredSections, skill.name);
    assert.strictEqual(result.ok, true, 'lint issues: ' + JSON.stringify(result.issues));
  });
}

// ---------------------------------------------------------------------------
// 2) parser self-test — proves the DETECTOR itself catches real problems, not just that
//    today's 4 files happen to pass. Uses synthetic in-memory content, touches no real files.
// ---------------------------------------------------------------------------
console.log('\n2) parser self-test (synthetic fixtures — proves the detector actually detects)');

t('parseFrontmatter() returns null when there is no frontmatter block', () => {
  assert.strictEqual(parseFrontmatter('# just a heading\n\nno frontmatter here'), null);
});

t('parseFrontmatter() extracts name and description from a real block', () => {
  const fm = parseFrontmatter('---\nname: example-skill\ndescription: a real description here that is long enough\n---\n\n# body');
  assert.strictEqual(fm.name, 'example-skill');
  assert.strictEqual(fm.description, 'a real description here that is long enough');
});

t('hasSection() finds an exact heading line', () => {
  assert.strictEqual(hasSection('# Title\n\n## Hard rules\ncontent', '## Hard rules'), true);
});

t('hasSection() does NOT match a heading only present as prose substring', () => {
  assert.strictEqual(hasSection('this text mentions ## Hard rules inline, not as a heading line prefix match test', '## Hard rules'), false);
});

t('lintSkill() flags a missing file honestly instead of throwing or silently passing', () => {
  const result = lintSkill(path.join(SKILLS_DIR, '__does-not-exist__', 'SKILL.md'), ['## Hard rules'], 'x');
  assert.strictEqual(result.ok, false);
  assert.ok(result.issues[0].includes('does not exist'));
});

t('lintSkill() flags a mismatched frontmatter name', () => {
  const tmp = path.join(require('os').tmpdir(), 'forge-newskills-fixture-badname.md');
  fs.writeFileSync(tmp, '---\nname: wrong-name\ndescription: a real description here that is long enough to pass\n---\n\n## Hard rules\nbody');
  try {
    const result = lintSkill(tmp, ['## Hard rules'], 'expected-name');
    assert.strictEqual(result.ok, false);
    assert.ok(result.issues.some((i) => i.includes('does not match expected')));
  } finally { fs.unlinkSync(tmp); }
});

t('lintSkill() flags a stub description under 40 chars', () => {
  const tmp = path.join(require('os').tmpdir(), 'forge-newskills-fixture-stub.md');
  fs.writeFileSync(tmp, '---\nname: stub-skill\ndescription: too short\n---\n\n## Hard rules\nbody');
  try {
    const result = lintSkill(tmp, ['## Hard rules'], 'stub-skill');
    assert.strictEqual(result.ok, false);
    assert.ok(result.issues.some((i) => i.includes('too short')));
  } finally { fs.unlinkSync(tmp); }
});

t('lintSkill() flags a missing required section', () => {
  const tmp = path.join(require('os').tmpdir(), 'forge-newskills-fixture-missing-section.md');
  fs.writeFileSync(tmp, '---\nname: section-skill\ndescription: a real description here that is long enough to pass\n---\n\n## Only Section\nbody but padded to be long enough to clear the 800 char minimum so only the missing-section issue fires in this fixture test. '.padEnd(850, 'x'));
  try {
    const result = lintSkill(tmp, ['## Hard rules', '## Only Section'], 'section-skill');
    assert.strictEqual(result.ok, false);
    assert.ok(result.issues.some((i) => i.includes('missing required section: ## Hard rules')));
  } finally { fs.unlinkSync(tmp); }
});

t('lintSkill() passes a well-formed synthetic fixture with all sections present', () => {
  const tmp = path.join(require('os').tmpdir(), 'forge-newskills-fixture-good.md');
  const body = '---\nname: good-skill\ndescription: a real description here that is long enough to pass the stub check\n---\n\n## Hard rules\nreal content padded out. '.padEnd(850, 'x') + '\n\n## Second Section\nmore real content.';
  fs.writeFileSync(tmp, body);
  try {
    const result = lintSkill(tmp, ['## Hard rules', '## Second Section'], 'good-skill');
    assert.strictEqual(result.ok, true, 'lint issues: ' + JSON.stringify(result.issues));
  } finally { fs.unlinkSync(tmp); }
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
