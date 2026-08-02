#!/usr/bin/env node
'use strict';
/**
 * forge-skill-evals.test.cjs — hermetic tests for the per-skill evals runner (wp-skill-evals,
 * 2026-07-31). Every fixture lives under a fresh os.tmpdir() mkdtemp root (see freshRoot()) — this file
 * NEVER touches this project's real `.claude/skills/`, never reads/writes a real evals.json, and makes
 * ZERO network calls (the module itself never touches the network either).
 *
 * Section map:
 *   1) listSkillDirs()      — empty skills/, mixed with/without evals.json, missing skills/ dir
 *   2) loadEvals()           — valid parse + every malformed-config rejection path
 *   3) runAssertion()        — each of the 7 assertion types, true AND false path, plus a missing
 *                               referenced file failing honestly (never throwing) for every file-based type
 *   4) runSkill()             — all-pass, one-fail, malformed evals.json degrades honestly (no throw)
 *   5) runAll()               — mixed multi-skill run, --skill filter, unknown --skill throws ECONFIG
 *   6) CLI (spawnSync)        — text + --json output, exit codes 0/1/2, --skill filter, usage errors,
 *                               a malformed evals.json exits 1 (not a crash)
 *   7) RED -> GREEN proof     — a real fixture is mutated to fail, proven red, restored, proven green
 *      again — this is the mechanism-level proof that a broken pin actually flips red (mirrors the
 *      build-report's own spot-proof against the 5 real skills, but exercised here on disposable fixtures)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const E = require('./forge-skill-evals.cjs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}
function throwsCode(fn, code) {
  try { fn(); return false; }
  catch (e) { return e && e.code === code; }
}

const CLI = path.join(__dirname, 'forge-skill-evals.cjs');
function runCLI(argv) { return spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' }); }

function freshRoot(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); }
function skillDir(root, name) { return path.join(root, '.claude', 'skills', name); }
/** writeSkill(root, name, {description, body}) -> creates a real SKILL.md with a valid frontmatter
 *  block, mirroring every real skill in this project. */
function writeSkill(root, name, opts) {
  opts = opts || {};
  const description = opts.description !== undefined ? opts.description : 'A test skill for hermetic fixtures.';
  const body = opts.body !== undefined ? opts.body : '# ' + name + '\n\nSome body text.\n';
  const dir = skillDir(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const fm = '---\nname: ' + name + '\ndescription: ' + description + '\n---\n\n';
  fs.writeFileSync(path.join(dir, 'SKILL.md'), fm + body, 'utf8');
}
function writeEvals(root, name, config) {
  const dir = skillDir(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'evals.json'), JSON.stringify(config), 'utf8');
}
function writeEvalsRaw(root, name, raw) {
  const dir = skillDir(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'evals.json'), raw, 'utf8');
}

console.log('forge-skill-evals tests (per-skill binary evals runner)');

// ---------------------------------------------------------------------------
console.log('\n1) listSkillDirs()');
// ---------------------------------------------------------------------------
t('a project with no .claude/skills/ dir at all -> [] (never throws)', () => {
  const root = freshRoot('sev-nosdir');
  assert.deepStrictEqual(E.listSkillDirs(root), []);
});
t('a skills/ dir with zero evals.json anywhere -> []', () => {
  const root = freshRoot('sev-noevals');
  writeSkill(root, 'alpha');
  writeSkill(root, 'beta');
  assert.deepStrictEqual(E.listSkillDirs(root), []);
});
t('only skills WITH an evals.json are listed, sorted by name, non-dir entries ignored', () => {
  const root = freshRoot('sev-mixed');
  writeSkill(root, 'zeta'); writeEvals(root, 'zeta', { skill: 'zeta', assertions: [{ id: 'x', type: 'file_exists', path: 'a' }] });
  writeSkill(root, 'alpha'); writeEvals(root, 'alpha', { skill: 'alpha', assertions: [{ id: 'x', type: 'file_exists', path: 'a' }] });
  writeSkill(root, 'beta'); // no evals.json for beta
  fs.writeFileSync(path.join(root, '.claude', 'skills', 'stray-file.txt'), 'not a dir', 'utf8');
  const dirs = E.listSkillDirs(root);
  assert.deepStrictEqual(dirs.map((d) => d.name), ['alpha', 'zeta']);
});

// ---------------------------------------------------------------------------
console.log('\n2) loadEvals() — valid parse + every malformed-config rejection path');
// ---------------------------------------------------------------------------
t('valid evals.json parses cleanly', () => {
  const root = freshRoot('sev-load-ok');
  writeEvals(root, 'gamma', { skill: 'gamma', assertions: [{ id: 'a1', type: 'file_exists', path: 'x' }] });
  const cfg = E.loadEvals(path.join(skillDir(root, 'gamma'), 'evals.json'), 'gamma');
  assert.strictEqual(cfg.skill, 'gamma');
  assert.strictEqual(cfg.assertions.length, 1);
});
t('missing file -> ECONFIG (not a crash)', () => {
  assert.ok(throwsCode(() => E.loadEvals(path.join(freshRoot('sev-nofile'), 'nope.json')), 'ECONFIG'));
});
t('invalid JSON -> ECONFIG', () => {
  const root = freshRoot('sev-badjson');
  writeEvalsRaw(root, 'x', '{ not json');
  assert.ok(throwsCode(() => E.loadEvals(path.join(skillDir(root, 'x'), 'evals.json'), 'x'), 'ECONFIG'));
});
t('a JSON array (not object) -> ECONFIG', () => {
  const root = freshRoot('sev-arr');
  writeEvalsRaw(root, 'x', '[1,2,3]');
  assert.ok(throwsCode(() => E.loadEvals(path.join(skillDir(root, 'x'), 'evals.json'), 'x'), 'ECONFIG'));
});
t('missing "skill" field -> ECONFIG', () => {
  const root = freshRoot('sev-noskillfield');
  writeEvals(root, 'x', { assertions: [{ id: 'a', type: 'file_exists', path: 'y' }] });
  assert.ok(throwsCode(() => E.loadEvals(path.join(skillDir(root, 'x'), 'evals.json'), 'x'), 'ECONFIG'));
});
t('"skill" field mismatched with its own directory -> ECONFIG (copy/paste-drift guard)', () => {
  const root = freshRoot('sev-mismatch');
  writeEvals(root, 'x', { skill: 'y', assertions: [{ id: 'a', type: 'file_exists', path: 'z' }] });
  assert.ok(throwsCode(() => E.loadEvals(path.join(skillDir(root, 'x'), 'evals.json'), 'x'), 'ECONFIG'));
});
t('missing "assertions" array -> ECONFIG', () => {
  const root = freshRoot('sev-noassertions');
  writeEvals(root, 'x', { skill: 'x' });
  assert.ok(throwsCode(() => E.loadEvals(path.join(skillDir(root, 'x'), 'evals.json'), 'x'), 'ECONFIG'));
});
t('empty "assertions" array -> ECONFIG', () => {
  const root = freshRoot('sev-emptyassertions');
  writeEvals(root, 'x', { skill: 'x', assertions: [] });
  assert.ok(throwsCode(() => E.loadEvals(path.join(skillDir(root, 'x'), 'evals.json'), 'x'), 'ECONFIG'));
});
t('an assertion missing "id" -> ECONFIG', () => {
  const root = freshRoot('sev-noid');
  writeEvals(root, 'x', { skill: 'x', assertions: [{ type: 'file_exists', path: 'y' }] });
  assert.ok(throwsCode(() => E.loadEvals(path.join(skillDir(root, 'x'), 'evals.json'), 'x'), 'ECONFIG'));
});
t('duplicate assertion "id" -> ECONFIG', () => {
  const root = freshRoot('sev-dupid');
  writeEvals(root, 'x', { skill: 'x', assertions: [{ id: 'a', type: 'file_exists', path: 'y' }, { id: 'a', type: 'file_exists', path: 'z' }] });
  assert.ok(throwsCode(() => E.loadEvals(path.join(skillDir(root, 'x'), 'evals.json'), 'x'), 'ECONFIG'));
});
t('an unknown assertion "type" -> ECONFIG', () => {
  const root = freshRoot('sev-badtype');
  writeEvals(root, 'x', { skill: 'x', assertions: [{ id: 'a', type: 'llm_vibe_check', path: 'y' }] });
  assert.ok(throwsCode(() => E.loadEvals(path.join(skillDir(root, 'x'), 'evals.json'), 'x'), 'ECONFIG'));
});
t('file_exists/file_absent/json_valid missing "path" -> ECONFIG', () => {
  const root = freshRoot('sev-nopath');
  writeEvals(root, 'x', { skill: 'x', assertions: [{ id: 'a', type: 'file_exists' }] });
  assert.ok(throwsCode(() => E.loadEvals(path.join(skillDir(root, 'x'), 'evals.json'), 'x'), 'ECONFIG'));
});
t('max_lines missing/bad "n" -> ECONFIG', () => {
  const root = freshRoot('sev-badn');
  writeEvals(root, 'x', { skill: 'x', assertions: [{ id: 'a', type: 'max_lines', path: 'y', n: 0 }] });
  assert.ok(throwsCode(() => E.loadEvals(path.join(skillDir(root, 'x'), 'evals.json'), 'x'), 'ECONFIG'));
});
t('contains/not_contains missing "needle" -> ECONFIG', () => {
  const root = freshRoot('sev-noneedle');
  writeEvals(root, 'x', { skill: 'x', assertions: [{ id: 'a', type: 'contains', path: 'y' }] });
  assert.ok(throwsCode(() => E.loadEvals(path.join(skillDir(root, 'x'), 'evals.json'), 'x'), 'ECONFIG'));
});
t('frontmatter_field missing "field" -> ECONFIG', () => {
  const root = freshRoot('sev-nofield');
  writeEvals(root, 'x', { skill: 'x', assertions: [{ id: 'a', type: 'frontmatter_field' }] });
  assert.ok(throwsCode(() => E.loadEvals(path.join(skillDir(root, 'x'), 'evals.json'), 'x'), 'ECONFIG'));
});
t('frontmatter_field with a non-positive-integer "max_length" -> ECONFIG', () => {
  const root = freshRoot('sev-badmaxlen');
  writeEvals(root, 'x', { skill: 'x', assertions: [{ id: 'a', type: 'frontmatter_field', field: 'description', max_length: -1 }] });
  assert.ok(throwsCode(() => E.loadEvals(path.join(skillDir(root, 'x'), 'evals.json'), 'x'), 'ECONFIG'));
});

// ---------------------------------------------------------------------------
console.log('\n3) runAssertion() — every type, true AND false path, missing-file honesty');
// ---------------------------------------------------------------------------
t('file_exists: true when the file is really there, false when not, NEVER throws either way', () => {
  const root = freshRoot('sev-fe');
  fs.writeFileSync(path.join(root, 'present.txt'), 'x', 'utf8');
  const ok = E.runAssertion(root, 'x', { id: 'a', type: 'file_exists', path: 'present.txt' });
  const bad = E.runAssertion(root, 'x', { id: 'a', type: 'file_exists', path: 'ghost.txt' });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(bad.ok, false);
  assert.ok(/missing/.test(bad.detail));
});
t('file_exists: a directory (not a file) at that path is NOT a pass', () => {
  const root = freshRoot('sev-fedir');
  fs.mkdirSync(path.join(root, 'adir'));
  const r = E.runAssertion(root, 'x', { id: 'a', type: 'file_exists', path: 'adir' });
  assert.strictEqual(r.ok, false);
});
t('file_absent: true when truly absent, false when present', () => {
  const root = freshRoot('sev-fa');
  fs.writeFileSync(path.join(root, 'here.txt'), 'x', 'utf8');
  const okAbsent = E.runAssertion(root, 'x', { id: 'a', type: 'file_absent', path: 'not-here.txt' });
  const failPresent = E.runAssertion(root, 'x', { id: 'a', type: 'file_absent', path: 'here.txt' });
  assert.strictEqual(okAbsent.ok, true);
  assert.strictEqual(failPresent.ok, false);
});
t('json_valid: true for real JSON, false for malformed JSON, false (not thrown) for a missing file', () => {
  const root = freshRoot('sev-jv');
  fs.writeFileSync(path.join(root, 'good.json'), '{"a":1}', 'utf8');
  fs.writeFileSync(path.join(root, 'bad.json'), '{not json', 'utf8');
  const good = E.runAssertion(root, 'x', { id: 'a', type: 'json_valid', path: 'good.json' });
  const bad = E.runAssertion(root, 'x', { id: 'a', type: 'json_valid', path: 'bad.json' });
  const missing = E.runAssertion(root, 'x', { id: 'a', type: 'json_valid', path: 'ghost.json' });
  assert.strictEqual(good.ok, true);
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(missing.ok, false);
});
t('max_lines: true at/under the cap, false over it', () => {
  const root = freshRoot('sev-ml');
  fs.writeFileSync(path.join(root, 'three.txt'), 'a\nb\nc', 'utf8'); // 3 lines
  const okAt = E.runAssertion(root, 'x', { id: 'a', type: 'max_lines', path: 'three.txt', n: 3 });
  const failOver = E.runAssertion(root, 'x', { id: 'a', type: 'max_lines', path: 'three.txt', n: 2 });
  assert.strictEqual(okAt.ok, true);
  assert.strictEqual(failOver.ok, false);
});
t('contains / not_contains: correct true/false, and a missing file fails honestly (never throws)', () => {
  const root = freshRoot('sev-contains');
  fs.writeFileSync(path.join(root, 'doc.md'), 'hello world', 'utf8');
  const found = E.runAssertion(root, 'x', { id: 'a', type: 'contains', path: 'doc.md', needle: 'world' });
  const notFound = E.runAssertion(root, 'x', { id: 'a', type: 'contains', path: 'doc.md', needle: 'goodbye' });
  const notContainsOk = E.runAssertion(root, 'x', { id: 'a', type: 'not_contains', path: 'doc.md', needle: 'goodbye' });
  const notContainsFail = E.runAssertion(root, 'x', { id: 'a', type: 'not_contains', path: 'doc.md', needle: 'world' });
  const missing = E.runAssertion(root, 'x', { id: 'a', type: 'contains', path: 'ghost.md', needle: 'x' });
  assert.strictEqual(found.ok, true);
  assert.strictEqual(notFound.ok, false);
  assert.strictEqual(notContainsOk.ok, true);
  assert.strictEqual(notContainsFail.ok, false);
  assert.strictEqual(missing.ok, false);
});
t('frontmatter_field: present+under budget passes, over max_length fails, missing field fails, missing SKILL.md fails honestly', () => {
  const root = freshRoot('sev-fm');
  writeSkill(root, 'described', { description: 'short and sweet' });
  writeSkill(root, 'long-one', { description: 'x'.repeat(250) });
  const ok = E.runAssertion(root, 'described', { id: 'a', type: 'frontmatter_field', field: 'description', max_length: 200 });
  const tooLong = E.runAssertion(root, 'long-one', { id: 'a', type: 'frontmatter_field', field: 'description', max_length: 200 });
  const missingField = E.runAssertion(root, 'described', { id: 'a', type: 'frontmatter_field', field: 'nonexistent_field' });
  const missingSkill = E.runAssertion(root, 'ghost-skill', { id: 'a', type: 'frontmatter_field', field: 'description' });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(tooLong.ok, false);
  assert.strictEqual(missingField.ok, false);
  assert.strictEqual(missingSkill.ok, false);
});
t('frontmatter_field: an explicit "skill" override checks a DIFFERENT skill\'s own SKILL.md, not the caller\'s', () => {
  const root = freshRoot('sev-fmoverride');
  writeSkill(root, 'caller-skill', { description: 'irrelevant here' });
  writeSkill(root, 'target-skill', { description: 'this is the one being checked' });
  const r = E.runAssertion(root, 'caller-skill', { id: 'a', type: 'frontmatter_field', field: 'description', skill: 'target-skill' });
  assert.strictEqual(r.ok, true);
  assert.ok(/target-skill/.test(r.detail));
});
t('an assertion whose implementation somehow throws is still caught and returned as ok:false (defense in depth)', () => {
  const root = freshRoot('sev-throwguard');
  // max_lines with a non-string path triggers path.resolve() to throw internally if not guarded;
  // this proves runAssertion's own try/catch net, independent of loadEvals's validation layer.
  const r = E.runAssertion(root, 'x', { id: 'a', type: 'max_lines', path: 123, n: 1 });
  assert.strictEqual(r.ok, false);
});

// ---------------------------------------------------------------------------
console.log('\n4) runSkill() — all-pass, one-fail, malformed config degrades honestly');
// ---------------------------------------------------------------------------
t('all assertions passing -> ok:true, passed===total, failed===0', () => {
  const root = freshRoot('sev-rs-allpass');
  writeSkill(root, 'good', { description: 'fine' });
  writeEvals(root, 'good', { skill: 'good', assertions: [
    { id: 'a1', type: 'file_exists', path: '.claude/skills/good/SKILL.md' },
    { id: 'a2', type: 'frontmatter_field', field: 'description', max_length: 200 },
  ] });
  const r = E.runSkill(root, 'good');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.error, null);
  assert.strictEqual(r.total, 2);
  assert.strictEqual(r.passed, 2);
  assert.strictEqual(r.failed, 0);
});
t('one failing assertion among several -> ok:false, exactly that one flagged', () => {
  const root = freshRoot('sev-rs-onefail');
  writeSkill(root, 'partial', { description: 'fine' });
  writeEvals(root, 'partial', { skill: 'partial', assertions: [
    { id: 'a1', type: 'file_exists', path: '.claude/skills/partial/SKILL.md' },
    { id: 'a2', type: 'file_exists', path: 'this/does/not/exist.txt' },
  ] });
  const r = E.runSkill(root, 'partial');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.total, 2);
  assert.strictEqual(r.passed, 1);
  assert.strictEqual(r.failed, 1);
  assert.strictEqual(r.results.find((x) => x.id === 'a2').ok, false);
  assert.strictEqual(r.results.find((x) => x.id === 'a1').ok, true);
});
t('a malformed evals.json degrades to {ok:false, error:<message>} — runSkill NEVER throws', () => {
  const root = freshRoot('sev-rs-malformed');
  writeSkill(root, 'broken');
  writeEvalsRaw(root, 'broken', '{ this is not json');
  let threw = false;
  let r;
  try { r = E.runSkill(root, 'broken'); } catch { threw = true; }
  assert.strictEqual(threw, false);
  assert.strictEqual(r.ok, false);
  assert.ok(typeof r.error === 'string' && r.error.length > 0);
  assert.deepStrictEqual(r.results, []);
});

// ---------------------------------------------------------------------------
console.log('\n5) runAll() — mixed multi-skill run, --skill filter, unknown --skill');
// ---------------------------------------------------------------------------
function buildMixedFixture() {
  const root = freshRoot('sev-runall');
  writeSkill(root, 'skill-pass', { description: 'ok' });
  writeEvals(root, 'skill-pass', { skill: 'skill-pass', assertions: [{ id: 'a1', type: 'file_exists', path: '.claude/skills/skill-pass/SKILL.md' }] });
  writeSkill(root, 'skill-fail', { description: 'ok' });
  writeEvals(root, 'skill-fail', { skill: 'skill-fail', assertions: [{ id: 'a1', type: 'file_exists', path: 'ghost.txt' }] });
  writeSkill(root, 'skill-no-evals', { description: 'ok' }); // no evals.json -> not evaluated at all
  return root;
}
t('runAll(): every evals.json-bearing skill is included, ok reflects the AND of all skills', () => {
  const root = buildMixedFixture();
  const out = E.runAll({ root });
  assert.strictEqual(out.skills.length, 2); // skill-no-evals is correctly excluded
  assert.strictEqual(out.ok, false); // skill-fail drags the overall verdict down
  assert.strictEqual(out.summary.totalSkills, 2);
  assert.strictEqual(out.summary.passedSkills, 1);
  assert.strictEqual(out.summary.failedSkills, 1);
});
t('runAll({skill}) filters to exactly one skill', () => {
  const root = buildMixedFixture();
  const out = E.runAll({ root, skill: 'skill-pass' });
  assert.strictEqual(out.skills.length, 1);
  assert.strictEqual(out.skills[0].skill, 'skill-pass');
  assert.strictEqual(out.ok, true);
});
t('runAll({skill: <unknown>}) throws ECONFIG rather than silently returning an empty report', () => {
  const root = buildMixedFixture();
  assert.ok(throwsCode(() => E.runAll({ root, skill: 'does-not-exist' }), 'ECONFIG'));
});
t('runAll() on a project with zero skills carrying evals.json -> ok:true, empty report (vacuously fine, never a crash)', () => {
  const root = freshRoot('sev-runall-empty');
  const out = E.runAll({ root });
  assert.strictEqual(out.skills.length, 0);
  assert.strictEqual(out.ok, true);
});

// ---------------------------------------------------------------------------
console.log('\n6) CLI (spawnSync) — text/--json, exit codes, --skill filter, usage errors');
// ---------------------------------------------------------------------------
t('CLI "run" on an all-pass fixture prints PASS and exits 0', () => {
  const root = freshRoot('sev-cli-pass');
  writeSkill(root, 'ok-skill', { description: 'fine' });
  writeEvals(root, 'ok-skill', { skill: 'ok-skill', assertions: [{ id: 'a1', type: 'file_exists', path: '.claude/skills/ok-skill/SKILL.md' }] });
  const r = runCLI(['run', '--root', root]);
  assert.strictEqual(r.status, 0);
  assert.ok(/\[PASS\] ok-skill/.test(r.stdout));
});
t('CLI "run" on a fixture with a real failure exits 1 and names the failing assertion', () => {
  const root = freshRoot('sev-cli-fail');
  writeSkill(root, 'bad-skill', { description: 'fine' });
  writeEvals(root, 'bad-skill', { skill: 'bad-skill', assertions: [{ id: 'missing-thing', type: 'file_exists', path: 'ghost.txt' }] });
  const r = runCLI(['run', '--root', root]);
  assert.strictEqual(r.status, 1);
  assert.ok(/\[FAIL\] bad-skill/.test(r.stdout));
  assert.ok(/missing-thing/.test(r.stdout));
});
t('CLI "run --json" emits parseable JSON matching the module API shape', () => {
  const root = freshRoot('sev-cli-json');
  writeSkill(root, 'j-skill', { description: 'fine' });
  writeEvals(root, 'j-skill', { skill: 'j-skill', assertions: [{ id: 'a1', type: 'file_exists', path: '.claude/skills/j-skill/SKILL.md' }] });
  const r = runCLI(['run', '--root', root, '--json']);
  assert.strictEqual(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.skills[0].skill, 'j-skill');
});
t('CLI "--skill <name>" filters to one skill via the real CLI path too', () => {
  const root = buildMixedFixture();
  const r = runCLI(['run', '--root', root, '--skill', 'skill-pass', '--json']);
  assert.strictEqual(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  assert.strictEqual(parsed.skills.length, 1);
  assert.strictEqual(parsed.skills[0].skill, 'skill-pass');
});
t('CLI with an unknown --skill name exits 2 (config/usage error, not a silent empty pass)', () => {
  const root = buildMixedFixture();
  const r = runCLI(['run', '--root', root, '--skill', 'totally-unknown']);
  assert.strictEqual(r.status, 2);
});
t('CLI with no subcommand prints usage and exits 2', () => {
  const r = runCLI([]);
  assert.strictEqual(r.status, 2);
  assert.ok(/Usage:/.test(r.stderr));
});
t('CLI with an unknown flag exits 2 with a usage error, not a silent ignore', () => {
  const r = runCLI(['run', '--bogus-flag']);
  assert.strictEqual(r.status, 2);
});
t('CLI "--root" with no value is a usage error (exit 2), never a crash', () => {
  const r = runCLI(['run', '--root']);
  assert.strictEqual(r.status, 2);
});
t('a malformed evals.json surfaces as an [ERROR] line via the real CLI and exits 1, never crashes', () => {
  const root = freshRoot('sev-cli-malformed');
  writeSkill(root, 'broken');
  writeEvalsRaw(root, 'broken', 'not { valid json at all');
  const r = runCLI(['run', '--root', root]);
  assert.strictEqual(r.status, 1);
  assert.ok(/\[ERROR\] broken/.test(r.stdout));
});

// ---------------------------------------------------------------------------
console.log('\n7) RED -> GREEN proof — a disposable fixture is mutated to fail, proven red, restored, proven green');
// ---------------------------------------------------------------------------
t('a "contains" pin: green on the real heading, RED once the heading is mutated away, GREEN again once restored', () => {
  const root = freshRoot('sev-redgreen');
  writeSkill(root, 'redgreen-skill', { description: 'fine', body: '# redgreen-skill\n\n## Real Section\n\nbody text.\n' });
  writeEvals(root, 'redgreen-skill', { skill: 'redgreen-skill', assertions: [
    { id: 'section-present', type: 'contains', path: '.claude/skills/redgreen-skill/SKILL.md', needle: '## Real Section' },
  ] });
  const skillMdPath = path.join(skillDir(root, 'redgreen-skill'), 'SKILL.md');

  const green1 = E.runSkill(root, 'redgreen-skill');
  assert.strictEqual(green1.ok, true, 'expected GREEN before mutation');

  const original = fs.readFileSync(skillMdPath, 'utf8');
  fs.writeFileSync(skillMdPath, original.replace('## Real Section', '## MUTATED Section'), 'utf8');
  const red = E.runSkill(root, 'redgreen-skill');
  assert.strictEqual(red.ok, false, 'expected RED after mutating the pinned heading away');
  assert.strictEqual(red.results[0].ok, false);

  fs.writeFileSync(skillMdPath, original, 'utf8'); // restore verbatim
  const green2 = E.runSkill(root, 'redgreen-skill');
  assert.strictEqual(green2.ok, true, 'expected GREEN again after restoring the original content');
});
t('a "frontmatter_field max_length" pin: green under budget, RED once over budget, GREEN again once restored', () => {
  const root = freshRoot('sev-redgreen-fm');
  writeSkill(root, 'budget-skill', { description: 'a short description' });
  writeEvals(root, 'budget-skill', { skill: 'budget-skill', assertions: [
    { id: 'desc-budget', type: 'frontmatter_field', field: 'description', max_length: 30 },
  ] });
  const skillMdPath = path.join(skillDir(root, 'budget-skill'), 'SKILL.md');

  const green1 = E.runSkill(root, 'budget-skill');
  assert.strictEqual(green1.ok, true, 'expected GREEN under budget');

  const original = fs.readFileSync(skillMdPath, 'utf8');
  fs.writeFileSync(skillMdPath, original.replace('a short description', 'a much, much longer description that blows the budget'), 'utf8');
  const red = E.runSkill(root, 'budget-skill');
  assert.strictEqual(red.ok, false, 'expected RED once the description exceeds max_length');

  fs.writeFileSync(skillMdPath, original, 'utf8'); // restore verbatim
  const green2 = E.runSkill(root, 'budget-skill');
  assert.strictEqual(green2.ok, true, 'expected GREEN again after restoring the original description');
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
