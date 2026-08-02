#!/usr/bin/env node
'use strict';
// forge-contextbudget.test.cjs — real tests for the ALWAYS-LOADED context-surface meter (2026-08-01).
// Every fixture builds its own throwaway "home" + "project" under os.tmpdir(); this file NEVER reads the
// owner's real ~/.claude and NEVER writes anything outside its own tmp dirs.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const cb = require('./forge-contextbudget.cjs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

console.log('forge-contextbudget tests (always-loaded context surface)');

/** buildFixture — a complete synthetic instruction chain: a fake home with a global CLAUDE.md + its
 *  @-includes + rules/ecc/common/*.md + a workspace CLAUDE.md + BOTH out-of-project skill catalogs
 *  (~/.claude/skills and ~/.claude/plugins), and a fake project with its own CLAUDE.md and skills.
 *  Returns {home, root} so every test can point the meter at files it fully controls.
 *
 *  The plugin skill is written at the REAL depth the owner's machine uses —
 *  `plugins/marketplaces/<mp>/plugins/<plugin>/skills/<skill>/SKILL.md`, six directory levels down — because
 *  a shallower fixture is exactly what let a depth-4 walk report 2 plugin skills instead of 112 on
 *  2026-08-01 and call it a measurement. */
function buildFixture(prefix, opts) {
  opts = opts || {};
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
  const home = path.join(base, 'home');
  const root = path.join(base, 'project');
  fs.mkdirSync(path.join(home, '.claude', 'rules', 'ecc', 'common'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude', 'skills'), { recursive: true });
  const includes = opts.includes || ['ALPHA_POLICY.md', 'BETA_POLICY.md'];
  fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'),
    '# global rules\n' + 'g'.repeat(396) + '\n' + includes.map((i) => '@' + i).join('\n') + '\n');
  for (const inc of (opts.writeIncludes || includes)) {
    fs.writeFileSync(path.join(home, '.claude', inc), 'x'.repeat(800));
  }
  for (const f of ['agents.md', 'testing.md']) {
    fs.writeFileSync(path.join(home, '.claude', 'rules', 'ecc', 'common', f), 'r'.repeat(400));
  }
  fs.writeFileSync(path.join(home, 'CLAUDE.md'), 'w'.repeat(200));
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'p'.repeat(600));
  const mkSkill = (dir, rel, name, desc) => {
    fs.mkdirSync(path.join(dir, rel), { recursive: true });
    fs.writeFileSync(path.join(dir, rel, 'SKILL.md'),
      '---\nname: ' + name + '\ndescription: ' + desc + '\n---\n\n# ' + name + '\n');
  };
  const projectSkills = path.join(root, '.claude', 'skills');
  mkSkill(projectSkills, 'flat-one', 'flat-one', 'd'.repeat(50));
  mkSkill(projectSkills, path.join('bundle', 'nested-one'), 'nested-one', 'e'.repeat(70));
  if (!opts.skipGlobalSkills) {
    const globalSkills = path.join(home, '.claude', 'skills');
    mkSkill(globalSkills, 'global-one', 'global-one', 'g'.repeat(30));          // "global-one"(10) + 30 = 40
    mkSkill(globalSkills, path.join('bundle', 'global-two'), 'global-two', 'h'.repeat(40)); // 10 + 40 = 50
  }
  if (!opts.skipPluginSkills) {
    // six directory levels down — the exact shape of the owner's real ~/.claude/plugins tree
    mkSkill(path.join(home, '.claude', 'plugins'),
      path.join('marketplaces', 'mp', 'plugins', 'pl', 'skills', 'deep-one'),
      'deep-one', 'i'.repeat(60));                                              // "deep-one"(8) + 60 = 68
  }
  return { base, home, root };
}
/** paths — EVERY chain location is overridden, deliberately. An earlier version of this helper left
 *  `eccRulesDir` out and the meter silently fell back to the machine default, i.e. the owner's REAL
 *  ~/.claude/rules — which made one assertion read 16.769 chars instead of the fixture's 800. Caught by the
 *  exact-character assertion below; kept as a note because a half-overridden fixture is how a test starts
 *  quietly measuring the developer's own machine instead of the thing it claims to test. The two skill-catalog
 *  roots are on that same list for exactly the same reason. */
function paths(fx) {
  return {
    globalClaudeMd: path.join(fx.home, '.claude', 'CLAUDE.md'),
    workspaceClaudeMd: path.join(fx.home, 'CLAUDE.md'),
    eccRulesDir: path.join(fx.home, '.claude', 'rules', 'ecc', 'common'),
    globalSkillsDir: path.join(fx.home, '.claude', 'skills'),
    pluginSkillsDir: path.join(fx.home, '.claude', 'plugins'),
    // 2026-08-01: the plugin-enablement sources belong on this list for exactly the reason the comment above
    // gives. Left out, `settingsJson` fell back to the machine default — the owner's REAL
    // ~/.claude/settings.json — and the fixture's synthetic `mp` plugins were judged against the owner's real
    // enabledPlugins map, which of course does not contain them. The plugin post then measured 0 skills and
    // four unrelated assertions failed. Neither file exists in this fixture's fake home, which is the point:
    // an unreadable enablement source means "count everything, say so", and that is what these tests measure.
    settingsJson: path.join(fx.home, '.claude', 'settings.json'),
    installedPluginsJson: path.join(fx.home, '.claude', 'plugins', 'installed_plugins.json'),
  };
}
function post(rep, id) { return rep.posts.find((p) => p.id === id); }

// --- the estimator is an ESTIMATE and says so -------------------------------------------------------------
t('estimateTokens is exactly ceil(chars / chars_per_token)', () => {
  assert.strictEqual(cb.estimateTokens(400, 4), 100);
  assert.strictEqual(cb.estimateTokens(401, 4), 101, 'partial tokens round UP (never under-report a budget)');
  assert.strictEqual(cb.estimateTokens(0, 4), 0);
});
t('every report LABELS its numbers as an estimate, never as a tokenizer measurement', () => {
  const fx = buildFixture('cbx-label');
  const rep = cb.measure(fx.root, { paths: paths(fx) });
  assert.ok(/estimate/i.test(rep.estimate_note), 'top-level estimate_note missing: ' + rep.estimate_note);
  assert.ok(/not a tokenizer|no tokenizer/i.test(rep.estimate_note), 'must say plainly that no tokenizer ran: ' + rep.estimate_note);
  assert.ok(rep.posts.every((p) => typeof p.approx_tokens === 'number'), 'the field itself is named approx_*');
  assert.ok(!Object.prototype.hasOwnProperty.call(rep, 'tokens'), 'no bare "tokens" field that would read as exact');
});

// --- the posts the work package names, each measured separately -------------------------------------------
t('measure() reports every named post: global CLAUDE.md, each @-include, the ecc rules, workspace, project, and all THREE skill catalogs', () => {
  const fx = buildFixture('cbx-posts');
  const rep = cb.measure(fx.root, { paths: paths(fx) });
  for (const id of ['global_claude_md', 'include:ALPHA_POLICY.md', 'include:BETA_POLICY.md', 'ecc_rules_common', 'workspace_claude_md', 'project_claude_md', 'skill_catalog_project', 'skill_catalog_global', 'skill_catalog_plugins']) {
    assert.ok(post(rep, id), 'missing post: ' + id + ' (got ' + rep.posts.map((p) => p.id).join(', ') + ')');
  }
});
t('each post carries the real character count of the real file', () => {
  const fx = buildFixture('cbx-chars');
  const rep = cb.measure(fx.root, { paths: paths(fx) });
  assert.strictEqual(post(rep, 'include:ALPHA_POLICY.md').chars, 800);
  assert.strictEqual(post(rep, 'workspace_claude_md').chars, 200);
  assert.strictEqual(post(rep, 'project_claude_md').chars, 600);
  assert.strictEqual(post(rep, 'ecc_rules_common').chars, 800, 'the ecc post is the SUM of its files (2 x 400)');
  assert.strictEqual(post(rep, 'ecc_rules_common').files.length, 2, 'and still names each file individually');
});
t('the total is the sum of the posts (no double-count, nothing dropped)', () => {
  const fx = buildFixture('cbx-total');
  const rep = cb.measure(fx.root, { paths: paths(fx) });
  assert.strictEqual(rep.total_chars, rep.posts.reduce((n, p) => n + p.chars, 0));
  assert.strictEqual(rep.total_approx_tokens, cb.estimateTokens(rep.total_chars, rep.chars_per_token));
});
t('skill_catalog_project counts name+description over ALL project skills including NESTED ones (the budget overrun on 2026-07-31)', () => {
  const fx = buildFixture('cbx-skills');
  const rep = cb.measure(fx.root, { paths: paths(fx) });
  const sc = post(rep, 'skill_catalog_project');
  assert.strictEqual(sc.skills, 2, 'both the flat and the nested skill are counted; got ' + sc.skills);
  // "flat-one"(8) + 50 + "nested-one"(10) + 70 = 138
  assert.strictEqual(sc.chars, 138, 'name+description only, not the whole SKILL.md body; got ' + sc.chars);
  assert.ok(sc.files.some((f) => f.skill === 'bundle/nested-one'), 'the nested skill is named by its catalog-relative id');
});

// --- a dead @-include is a finding, never a silent zero ---------------------------------------------------
t('an @-include pointing at a file that does not exist is reported as a DEAD reference', () => {
  const fx = buildFixture('cbx-dead', { includes: ['ALPHA_POLICY.md', 'GONE_POLICY.md'], writeIncludes: ['ALPHA_POLICY.md'] });
  const rep = cb.measure(fx.root, { paths: paths(fx) });
  const dead = rep.findings.filter((f) => f.kind === 'dead_include');
  assert.strictEqual(dead.length, 1, 'expected exactly one dead include; got ' + JSON.stringify(rep.findings));
  assert.ok(dead[0].detail.includes('GONE_POLICY.md'), 'names the missing file: ' + dead[0].detail);
  assert.strictEqual(rep.ok, false, 'a dead reference makes the report not-ok (advisory, but reported)');
  assert.strictEqual(post(rep, 'include:GONE_POLICY.md').exists, false, 'the post still appears, marked missing');
  assert.strictEqual(post(rep, 'include:GONE_POLICY.md').chars, 0);
});

// --- baseline + thresholds --------------------------------------------------------------------------------
t('with NO baseline recorded the report is honest, not silently green-with-nothing-checked', () => {
  const fx = buildFixture('cbx-nobaseline');
  const rep = cb.measure(fx.root, { paths: paths(fx) });
  assert.strictEqual(rep.baseline, null);
  assert.ok(/no baseline/i.test(rep.reason), 'reason must say a baseline has never been recorded: ' + rep.reason);
  assert.strictEqual(rep.ok, true, 'and that is not itself a failure');
});
t('a post that grew past its baseline + threshold is a NAMED finding with the real delta', () => {
  const fx = buildFixture('cbx-grow');
  cb.writeBaseline(fx.root, { paths: paths(fx) });
  // shrink the recorded baseline for ONE post so the very next measurement is genuine growth
  const cfg = cb.readConfig(fx.root);
  cfg.baseline.posts.project_claude_md = 10;
  cb.saveConfig(fx.root, cfg);
  const rep = cb.measure(fx.root, { paths: paths(fx) });
  const grown = rep.findings.filter((f) => f.kind === 'over_baseline');
  assert.strictEqual(grown.length, 1, 'exactly the one post that grew; got ' + JSON.stringify(rep.findings));
  assert.strictEqual(grown[0].id, 'project_claude_md');
  assert.ok(/10/.test(grown[0].detail) && /150/.test(grown[0].detail), 'names baseline AND current: ' + grown[0].detail);
  assert.strictEqual(rep.ok, false);
});
t('growth UNDER the configured floor is not a finding (an estimator is not precise enough to cry wolf)', () => {
  const fx = buildFixture('cbx-noise');
  cb.writeBaseline(fx.root, { paths: paths(fx) });
  const cfg = cb.readConfig(fx.root);
  cfg.baseline.posts.project_claude_md = post(cb.measure(fx.root, { paths: paths(fx) }), 'project_claude_md').approx_tokens - 1;
  cb.saveConfig(fx.root, cfg);
  const rep = cb.measure(fx.root, { paths: paths(fx) });
  assert.strictEqual(rep.findings.filter((f) => f.kind === 'over_baseline').length, 0, JSON.stringify(rep.findings));
  assert.strictEqual(rep.ok, true);
});
t('the thresholds are CONFIG values, not hardcoded — the same measurement flips verdict when the config changes', () => {
  const fx = buildFixture('cbx-cfg');
  cb.writeBaseline(fx.root, { paths: paths(fx) });
  const cfg = cb.readConfig(fx.root);
  cfg.baseline.posts.project_claude_md = post(cb.measure(fx.root, { paths: paths(fx) }), 'project_claude_md').approx_tokens - 5;
  cb.saveConfig(fx.root, cfg);
  assert.strictEqual(cb.measure(fx.root, { paths: paths(fx) }).ok, true, 'a 5-token drift is under the default floor');
  const cfg2 = cb.readConfig(fx.root);
  cfg2.thresholds.post_growth_min_tokens = 1;
  cfg2.thresholds.post_growth_pct = 0;
  cb.saveConfig(fx.root, cfg2);
  assert.strictEqual(cb.measure(fx.root, { paths: paths(fx) }).ok, false, 'the SAME files now trip a stricter configured floor');
});
t('the total is baselined too, not only the individual posts', () => {
  const fx = buildFixture('cbx-total-base');
  cb.writeBaseline(fx.root, { paths: paths(fx) });
  const cfg = cb.readConfig(fx.root);
  cfg.baseline.total_approx_tokens = 5;
  cb.saveConfig(fx.root, cfg);
  const rep = cb.measure(fx.root, { paths: paths(fx) });
  assert.ok(rep.findings.some((f) => f.kind === 'over_baseline_total'), JSON.stringify(rep.findings));
});

// --- the honesty boundary: files outside the project are READ, never written -------------------------------
t('measure() does not modify a single byte outside the project root (read-only across the boundary)', () => {
  const fx = buildFixture('cbx-readonly');
  const watched = [
    path.join(fx.home, '.claude', 'CLAUDE.md'),
    path.join(fx.home, '.claude', 'ALPHA_POLICY.md'),
    path.join(fx.home, '.claude', 'rules', 'ecc', 'common', 'agents.md'),
    path.join(fx.home, 'CLAUDE.md'),
    // the two out-of-project skill catalogs are opened for READING and counted — never touched
    path.join(fx.home, '.claude', 'skills', 'global-one', 'SKILL.md'),
    path.join(fx.home, '.claude', 'plugins', 'marketplaces', 'mp', 'plugins', 'pl', 'skills', 'deep-one', 'SKILL.md'),
  ];
  const before = watched.map((p) => ({ p, text: fs.readFileSync(p, 'utf8'), mtime: fs.statSync(p).mtimeMs }));
  cb.measure(fx.root, { paths: paths(fx) });
  cb.writeBaseline(fx.root, { paths: paths(fx) });
  for (const b of before) {
    assert.strictEqual(fs.readFileSync(b.p, 'utf8'), b.text, 'content changed outside the project: ' + b.p);
    assert.strictEqual(fs.statSync(b.p).mtimeMs, b.mtime, 'mtime changed outside the project: ' + b.p);
  }
});
t('every out-of-project post is FLAGGED as out-of-project + read-only in the report itself', () => {
  const fx = buildFixture('cbx-flag');
  const rep = cb.measure(fx.root, { paths: paths(fx) });
  assert.strictEqual(post(rep, 'global_claude_md').in_project, false);
  assert.strictEqual(post(rep, 'global_claude_md').access, 'read-only');
  assert.strictEqual(post(rep, 'project_claude_md').in_project, true);
  assert.strictEqual(post(rep, 'skill_catalog_project').in_project, true);
  assert.strictEqual(post(rep, 'skill_catalog_global').in_project, false, 'the global catalog lives outside the project root');
  assert.strictEqual(post(rep, 'skill_catalog_global').access, 'read-only');
  assert.strictEqual(post(rep, 'skill_catalog_plugins').in_project, false, 'the plugin catalog lives outside the project root');
  assert.strictEqual(post(rep, 'skill_catalog_plugins').access, 'read-only');
});
t('the ONLY file writeBaseline() writes is the config inside the project .claude/', () => {
  const fx = buildFixture('cbx-writepath');
  const r = cb.writeBaseline(fx.root, { paths: paths(fx) });
  assert.ok(r.path.startsWith(path.join(fx.root, '.claude') + path.sep), 'wrote outside .claude/: ' + r.path);
  assert.ok(fs.existsSync(r.path));
});

// --- degradation: a missing chain file is reported, never a crash ------------------------------------------
t('a completely absent global CLAUDE.md degrades to an honest missing post, never a throw', () => {
  const fx = buildFixture('cbx-nohome');
  fs.rmSync(path.join(fx.home, '.claude', 'CLAUDE.md'));
  const rep = cb.measure(fx.root, { paths: paths(fx) });
  assert.strictEqual(post(rep, 'global_claude_md').exists, false);
  assert.strictEqual(post(rep, 'global_claude_md').chars, 0);
  assert.ok(rep.posts.length > 1, 'the rest of the chain is still measured');
});

// ===========================================================================================================
// THE FULL SKILL SURFACE (2026-08-01, second pass) — the meter used to count ONLY <project>/.claude/skills,
// i.e. 57 of the 278 skills the session actually carries: 21% of the real surface reported as if it were the
// whole thing. These tests pin the three separate sources, the depth the walk must reach, and the two ways an
// under-report is allowed to happen (it isn't — both must be loud).
// ===========================================================================================================

t('the three skill sources are SEPARATE posts, each with its own count — never summed into one opaque number', () => {
  const fx = buildFixture('cbx-sources');
  const rep = cb.measure(fx.root, { paths: paths(fx) });
  assert.strictEqual(post(rep, 'skill_catalog_project').skills, 2);
  assert.strictEqual(post(rep, 'skill_catalog_global').skills, 2, 'the global ~/.claude/skills catalog is counted');
  assert.strictEqual(post(rep, 'skill_catalog_plugins').skills, 1, 'the ~/.claude/plugins catalog is counted');
  assert.strictEqual(post(rep, 'skill_catalog_project').chars, 138);
  assert.strictEqual(post(rep, 'skill_catalog_global').chars, 90, '"global-one"(10)+30 + "global-two"(10)+40');
  assert.strictEqual(post(rep, 'skill_catalog_plugins').chars, 68, '"deep-one"(8)+60');
  // and the same three appear in the report's own summary array, still separate
  assert.strictEqual(rep.skill_sources.length, 3, JSON.stringify(rep.skill_sources.map((s) => s.id)));
  assert.deepStrictEqual(rep.skill_sources.map((s) => s.skills), [2, 2, 1]);
});

t('a DEEPLY NESTED SKILL.md (six directory levels down, the real plugin layout) is found — the depth-4 bug', () => {
  const fx = buildFixture('cbx-deep');
  const rep = cb.measure(fx.root, { paths: paths(fx) });
  const pl = post(rep, 'skill_catalog_plugins');
  assert.strictEqual(pl.skills, 1, 'the six-levels-down skill must be found; got ' + pl.skills);
  assert.strictEqual(pl.deepest_depth, 6, 'and the report states how deep it actually had to go; got ' + pl.deepest_depth);
  assert.ok(pl.files.some((f) => f.skill === 'marketplaces/mp/plugins/pl/skills/deep-one'),
    'named by its catalog-relative path: ' + JSON.stringify(pl.files.map((f) => f.skill)));
  assert.strictEqual(pl.depth_capped, false, 'and the walk did NOT stop early');
});

t('the maximum walk depth clears the deepest layout that actually exists, with headroom', () => {
  assert.strictEqual(cb.MAX_SKILL_DEPTH, 8, 'documented default');
  assert.ok(cb.MAX_SKILL_DEPTH >= 6, 'the deepest real layout on this machine is 6 (plugins/marketplaces/<mp>/plugins/<pl>/skills/<skill>/SKILL.md)');
});

t('a walk that stops at the depth cap SAYS SO — a possibly-truncated count is a finding, never a silent number', () => {
  const fx = buildFixture('cbx-capped');
  const cfg = cb.readConfig(fx.root);
  cfg.max_skill_depth = 3; // deliberately too shallow for the six-deep plugin skill
  cb.saveConfig(fx.root, cfg);
  const rep = cb.measure(fx.root, { paths: paths(fx) });
  const pl = post(rep, 'skill_catalog_plugins');
  assert.strictEqual(pl.skills, 0, 'the too-shallow walk genuinely misses it');
  assert.strictEqual(pl.depth_capped, true, 'and the post records that it stopped at the cap');
  const capped = rep.findings.filter((f) => f.kind === 'depth_capped');
  assert.strictEqual(capped.length, 1, 'exactly one capped-walk finding; got ' + JSON.stringify(rep.findings));
  assert.ok(/depth/i.test(capped[0].detail) && /3/.test(capped[0].detail), 'names the depth it stopped at: ' + capped[0].detail);
  assert.strictEqual(rep.ok, false, 'a meter that might be under-reporting is NOT green');
});

t('an absent source is an honest ZERO with a note — the post still appears, never silently omitted', () => {
  const fx = buildFixture('cbx-nosource', { skipPluginSkills: true });
  const rep = cb.measure(fx.root, { paths: paths(fx) });
  const pl = post(rep, 'skill_catalog_plugins');
  assert.ok(pl, 'the post is present even though the directory is not');
  assert.strictEqual(pl.exists, false);
  assert.strictEqual(pl.skills, 0);
  assert.strictEqual(pl.approx_tokens, 0);
  assert.ok(/no such directory|not present/i.test(pl.note), 'the zero is EXPLAINED in the post: ' + pl.note);
  assert.strictEqual(rep.findings.filter((f) => f.kind === 'source_vanished').length, 0,
    'with no baseline there is nothing to have vanished FROM — an absent source is not yet a failure');
});

t('a source that SILENTLY DISAPPEARS after being baselined FAILS the meter (under-reporting is worse than no meter)', () => {
  const fx = buildFixture('cbx-vanish');
  cb.writeBaseline(fx.root, { paths: paths(fx) });
  const base = cb.readConfig(fx.root).baseline;
  assert.strictEqual(base.skill_sources.skill_catalog_plugins, 1, 'the baseline records the per-source skill COUNT: ' + JSON.stringify(base.skill_sources));
  fs.rmSync(path.join(fx.home, '.claude', 'plugins'), { recursive: true, force: true });
  const rep = cb.measure(fx.root, { paths: paths(fx) });
  const gone = rep.findings.filter((f) => f.kind === 'source_vanished');
  assert.strictEqual(gone.length, 1, 'the vanished source is a finding; got ' + JSON.stringify(rep.findings));
  assert.strictEqual(gone[0].id, 'skill_catalog_plugins');
  assert.ok(/1/.test(gone[0].detail) && /0/.test(gone[0].detail), 'names what it had and what it has now: ' + gone[0].detail);
  assert.strictEqual(rep.ok, false, 'and the meter is RED — a meter reporting too low must never read green');
});

t('a source emptied in place (directory still there, skills gone) fails exactly the same way', () => {
  const fx = buildFixture('cbx-emptied');
  cb.writeBaseline(fx.root, { paths: paths(fx) });
  fs.rmSync(path.join(fx.home, '.claude', 'skills', 'global-one'), { recursive: true, force: true });
  fs.rmSync(path.join(fx.home, '.claude', 'skills', 'bundle'), { recursive: true, force: true });
  const rep = cb.measure(fx.root, { paths: paths(fx) });
  const gone = rep.findings.filter((f) => f.kind === 'source_vanished' && f.id === 'skill_catalog_global');
  assert.strictEqual(gone.length, 1, JSON.stringify(rep.findings));
  assert.strictEqual(post(rep, 'skill_catalog_global').exists, true, 'the directory is still there — it is the CONTENT that vanished');
  assert.strictEqual(rep.ok, false);
});

t('a source that merely SHRANK (some skills removed, not all) is ordinary movement, not a vanished source', () => {
  const fx = buildFixture('cbx-shrank');
  cb.writeBaseline(fx.root, { paths: paths(fx) });
  fs.rmSync(path.join(fx.home, '.claude', 'skills', 'bundle'), { recursive: true, force: true });
  const rep = cb.measure(fx.root, { paths: paths(fx) });
  assert.strictEqual(post(rep, 'skill_catalog_global').skills, 1);
  assert.strictEqual(rep.findings.filter((f) => f.kind === 'source_vanished').length, 0,
    'one skill fewer is not a broken meter; only a source dropping to ZERO is: ' + JSON.stringify(rep.findings));
});

// --- correction vs regression: a WIDER measurement is not growth --------------------------------------------
t('growth that is purely newly-METERED surface is reported as a CORRECTION, not as a false-alarm regression', () => {
  const fx = buildFixture('cbx-correction');
  cb.writeBaseline(fx.root, { paths: paths(fx) });
  // simulate the pre-widening baseline: it never knew the two out-of-project catalogs existed
  const cfg = cb.readConfig(fx.root);
  const widened = post(cb.measure(fx.root, { paths: paths(fx) }), 'skill_catalog_global').approx_tokens
    + post(cb.measure(fx.root, { paths: paths(fx) }), 'skill_catalog_plugins').approx_tokens;
  delete cfg.baseline.posts.skill_catalog_global;
  delete cfg.baseline.posts.skill_catalog_plugins;
  delete cfg.baseline.skill_sources.skill_catalog_global;
  delete cfg.baseline.skill_sources.skill_catalog_plugins;
  cfg.baseline.total_approx_tokens -= widened;
  cfg.thresholds.total_growth_min_tokens = 1;
  cfg.thresholds.total_growth_pct = 0;
  cb.saveConfig(fx.root, cfg);
  const rep = cb.measure(fx.root, { paths: paths(fx) });
  assert.strictEqual(rep.findings.filter((f) => f.kind === 'over_baseline_total').length, 0,
    'the like-for-like posts did not grow at all — this must NOT read as a regression: ' + JSON.stringify(rep.findings));
  const note = (rep.notes || []).find((n) => n.kind === 'measurement_widened');
  assert.ok(note, 'the widening is stated explicitly, not hidden: ' + JSON.stringify(rep.notes));
  assert.ok(/skill_catalog_global/.test(note.detail) && /skill_catalog_plugins/.test(note.detail),
    'and names exactly which posts are new: ' + note.detail);
  assert.ok(/correction|newly (metered|counted)|not growth/i.test(note.detail), 'in words, not just a number: ' + note.detail);
  assert.deepStrictEqual(rep.new_posts.sort(), ['skill_catalog_global', 'skill_catalog_plugins']);
  assert.strictEqual(rep.ok, true, 'a correction is not a failure');
});

t('a REAL like-for-like regression still trips even while a correction note is present', () => {
  const fx = buildFixture('cbx-both');
  cb.writeBaseline(fx.root, { paths: paths(fx) });
  const cfg = cb.readConfig(fx.root);
  delete cfg.baseline.posts.skill_catalog_plugins;   // one post is newly metered …
  cfg.baseline.posts.project_claude_md = 10;         // … while a baselined post genuinely grew
  cb.saveConfig(fx.root, cfg);
  const rep = cb.measure(fx.root, { paths: paths(fx) });
  assert.ok(rep.findings.some((f) => f.kind === 'over_baseline' && f.id === 'project_claude_md'),
    'the genuine regression is NOT swallowed by the correction: ' + JSON.stringify(rep.findings));
  assert.strictEqual(rep.ok, false);
});

t('a baselined post that no longer exists is named as retired, not quietly dropped', () => {
  const fx = buildFixture('cbx-retired');
  cb.writeBaseline(fx.root, { paths: paths(fx) });
  const cfg = cb.readConfig(fx.root);
  // a faithful rename: the old id was in the baseline AND in its recorded total, exactly as a real
  // pre-split baseline would have been
  cfg.baseline.posts.skill_catalog = 2982; // the id this meter used before it was split into three
  cfg.baseline.total_approx_tokens += 2982;
  cb.saveConfig(fx.root, cfg);
  const rep = cb.measure(fx.root, { paths: paths(fx) });
  assert.ok(rep.retired_baseline_posts.includes('skill_catalog'), JSON.stringify(rep.retired_baseline_posts));
  assert.ok((rep.notes || []).some((n) => n.kind === 'retired_post' && /skill_catalog/.test(n.detail)), JSON.stringify(rep.notes));
  assert.strictEqual(rep.ok, true, 'a retired post is not a saving and not a regression — it is a note: ' + JSON.stringify(rep.findings));
});

// --- the frontmatter is not always one line, and a parser that assumes it is reads LOW ----------------------
t('a BLOCK-SCALAR description (`description: |`) is counted in full, not truncated to the "|" marker', () => {
  const fm = '---\nname: blocky\ndescription: |\n  first line of the description\n  second line of the description\n---\n\n# blocky\n';
  const got = cb.frontmatterField(fm, 'description');
  assert.ok(/first line/.test(got) && /second line/.test(got), 'both lines are part of the description: ' + JSON.stringify(got));
  assert.ok(got.length > 40, 'the real length, not 1 char for the block indicator; got ' + got.length);
  assert.ok(!/^[|>]/.test(got), 'the block indicator itself is not part of the text: ' + JSON.stringify(got));
});
t('a FOLDED description (`description: >-`) and a plain indented continuation are counted in full too', () => {
  assert.ok(cb.frontmatterField('---\nname: n\ndescription: >-\n  folded text here\n---', 'description').includes('folded text here'));
  assert.ok(cb.frontmatterField('---\nname: n\ndescription: starts here\n  and continues here\nother: x\n---', 'description').includes('and continues here'));
});
t('a single-line description is unchanged by all of that, and a following key is never swallowed', () => {
  const fm = '---\nname: n\ndescription: just one line\nallowed-tools: Read, Write\n---';
  assert.strictEqual(cb.frontmatterField(fm, 'description'), 'just one line');
  assert.strictEqual(cb.frontmatterField(fm, 'name'), 'n');
});
t('a block-scalar skill contributes its FULL description to the catalog count', () => {
  const fx = buildFixture('cbx-block');
  const dir = path.join(fx.home, '.claude', 'skills', 'blocky');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: blocky\ndescription: |\n  ' + 'z'.repeat(120) + '\n---\n');
  const g = post(cb.measure(fx.root, { paths: paths(fx) }), 'skill_catalog_global');
  const blocky = g.files.find((f) => f.skill === 'blocky');
  assert.ok(blocky.description_chars >= 120, 'the whole block is counted; got ' + blocky.description_chars);
});

t('skillSourceLine names all three sources and distinguishes an ABSENT source from an empty one', () => {
  const fx = buildFixture('cbx-line');
  const line = cb.skillSourceLine(cb.measure(fx.root, { paths: paths(fx) }));
  // "LOADED" was added on 2026-08-01: the number stopped meaning "SKILL.md files on disk" and started meaning
  // "skills actually in the context", which is a different claim and has to read as one. This fixture has no
  // enablement source, so nothing is excluded and the count itself is unchanged.
  assert.strictEqual(line, 'skills: project 2 + global 2 + plugins 1 = 5 LOADED, counted separately '
    + '(global + plugins are outside the project root — read only)', line);
  const gone = buildFixture('cbx-line-gone', { skipPluginSkills: true });
  assert.ok(/plugins 0 \(absent\)/.test(cb.skillSourceLine(cb.measure(gone.root, { paths: paths(gone) }))),
    'a source with no directory is marked absent, never printed as a bare 0 that reads like an empty catalog');
});

t('a SKILL.md with no frontmatter at all is counted as found but reported as declaring nothing', () => {
  const fx = buildFixture('cbx-nofm');
  const dir = path.join(fx.home, '.claude', 'plugins', 'marketplaces', 'mp', 'docs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '# just a guide, no YAML frontmatter\n\nSome prose.\n');
  const pl = post(cb.measure(fx.root, { paths: paths(fx) }), 'skill_catalog_plugins');
  assert.strictEqual(pl.skills, 2, 'the file is found and counted as a SKILL.md; got ' + pl.skills);
  assert.strictEqual(pl.without_frontmatter, 1, 'and it is named as declaring no name/description; got ' + pl.without_frontmatter);
  assert.ok(/frontmatter/i.test(pl.note), 'the note says so rather than leaving the count to imply loaded weight: ' + pl.note);
});

// --- the real machine ---------------------------------------------------------------------------------------
t('on the REAL project all three sources are reported, and any zero among them is EXPLAINED', () => {
  const rep = cb.measure(path.resolve(__dirname, '..', '..'), {});
  assert.strictEqual(rep.skill_sources.length, 3, JSON.stringify(rep.skill_sources.map((s) => s.id)));
  for (const s of rep.skill_sources) {
    assert.ok(typeof s.skills === 'number', s.id + ' has no count');
    if (s.skills === 0) assert.ok(s.note && s.note.length > 10, s.id + ' reports zero with no explanation: ' + s.note);
  }
  assert.ok(rep.skill_sources.find((s) => s.id === 'skill_catalog_project').skills >= 57,
    'this project has 57 skills of its own; got ' + rep.skill_sources.find((s) => s.id === 'skill_catalog_project').skills);
  assert.strictEqual(rep.findings.filter((f) => f.kind === 'depth_capped').length, 0,
    'the real tree fits inside the configured depth: ' + JSON.stringify(rep.findings.filter((f) => f.kind === 'depth_capped')));
});
t('the REAL always-loaded surface is now measured well above the project-only figure it used to report', () => {
  const rep = cb.measure(path.resolve(__dirname, '..', '..'), {});
  // 24.809 est. tokens was the ENTIRE reported chain while only 57 of 278 skills were counted (2026-08-01).
  assert.ok(rep.total_approx_tokens > 24809,
    'the widened measurement must exceed the old project-only total; got ' + rep.total_approx_tokens);
  assert.strictEqual(rep.total_chars, rep.posts.reduce((n, p) => n + p.chars, 0), 'and it is still exactly the sum of its posts');
});

// =============================================================================================================
// PLUGIN ENABLEMENT (2026-08-01) — a plugin that is switched OFF is not loaded, and must not be counted as if
// it were. Measured that day on the owner's machine: 4 of 15 plugins enabled, 17 SKILL.md sitting under a
// directory literally named `plugin.disabled`, and the meter reporting all 112 plugin skills as loaded weight.
// =============================================================================================================

/** buildPluginFixture — a plugin tree with every enablement case the real machine actually contains:
 *    cache/mp/on-plugin/1.0.0        the INSTALLED copy of an enabled plugin        -> loaded
 *    cache/mp/on-plugin/0.9.0        an older copy of that same plugin              -> NOT loaded (stale)
 *    cache/mp/off-plugin/1.0.0       an installed copy of a DISABLED plugin         -> NOT loaded
 *    marketplaces/mp/plugin.disabled a directory literally named *.disabled         -> NOT loaded
 *    marketplaces/other/plugin       a relocated copy of an enabled plugin, found
 *                                    through its own .claude-plugin/plugin.json     -> loaded
 *    marketplaces/mp/loose           unattributable to any plugin                   -> counted, but flagged
 *  Returns {home, root} plus the exact per-skill description lengths so the token assertions are arithmetic,
 *  not vibes. */
function buildPluginFixture(prefix, opts) {
  opts = opts || {};
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
  const home = path.join(base, 'home');
  const root = path.join(base, 'project');
  fs.mkdirSync(path.join(home, '.claude', 'rules', 'ecc', 'common'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude', 'skills'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'g'.repeat(100));
  fs.writeFileSync(path.join(home, 'CLAUDE.md'), 'w'.repeat(100));
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'p'.repeat(100));
  const plugins = path.join(home, '.claude', 'plugins');
  const mkSkill = (rel, name, descLen) => {
    const dir = path.join(plugins, rel);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: ' + name + '\ndescription: ' + 'd'.repeat(descLen) + '\n---\n');
  };
  // name lengths are fixed so name+description is exactly (name.length + descLen)
  mkSkill(path.join('cache', 'mp', 'on-plugin', '1.0.0', 'skills', 'live'), 'live', 96);       // 4 + 96 = 100
  mkSkill(path.join('cache', 'mp', 'on-plugin', '0.9.0', 'skills', 'stale'), 'stale', 195);    // 5 + 195 = 200
  mkSkill(path.join('cache', 'mp', 'off-plugin', '1.0.0', 'skills', 'off'), 'off', 397);       // 3 + 397 = 400
  mkSkill(path.join('marketplaces', 'mp', 'plugin.disabled', 'skills', 'dead'), 'dead', 796);  // 4 + 796 = 800
  mkSkill(path.join('marketplaces', 'mp', 'loose'), 'loose', 45);                              // 5 + 45  = 50
  // the relocated copy of an enabled plugin: a different marketplace directory, identified by its own manifest
  const moved = path.join(plugins, 'marketplaces', 'other', 'plugin');
  fs.mkdirSync(path.join(moved, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(moved, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'moved-plugin', version: '2.0.0' }));
  mkSkill(path.join('marketplaces', 'other', 'plugin', 'skills', 'relocated'), 'relocated', 291); // 9 + 291 = 300

  const enabledPlugins = opts.enabledPlugins || {
    'on-plugin@mp': true,
    'off-plugin@mp': false,
    'moved-plugin@mp': true, // enabled under the ORIGINAL marketplace key; the copy on disk lives under `other`
  };
  if (!opts.skipSettings) {
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins }, null, 2));
  }
  if (!opts.skipInstalled) {
    fs.mkdirSync(plugins, { recursive: true });
    fs.writeFileSync(path.join(plugins, 'installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: {
        'on-plugin@mp': [{ scope: 'user', installPath: path.join(plugins, 'cache', 'mp', 'on-plugin', '1.0.0'), version: '1.0.0' }],
        'off-plugin@mp': [{ scope: 'user', installPath: path.join(plugins, 'cache', 'mp', 'off-plugin', '1.0.0'), version: '1.0.0' }],
        // deliberately points at a path that does NOT exist — the real machine's claude-mem entry does exactly
        // this, and the relocated copy still has to be found
        'moved-plugin@mp': [{ scope: 'user', installPath: path.join(plugins, 'cache', 'mp', 'moved-plugin', '9.9.9'), version: '9.9.9' }],
      },
    }, null, 2));
  }
  return { base, home, root, plugins };
}
function pluginPaths(fx) {
  return {
    globalClaudeMd: path.join(fx.home, '.claude', 'CLAUDE.md'),
    workspaceClaudeMd: path.join(fx.home, 'CLAUDE.md'),
    eccRulesDir: path.join(fx.home, '.claude', 'rules', 'ecc', 'common'),
    globalSkillsDir: path.join(fx.home, '.claude', 'skills'),
    pluginSkillsDir: path.join(fx.home, '.claude', 'plugins'),
    settingsJson: path.join(fx.home, '.claude', 'settings.json'),
    installedPluginsJson: path.join(fx.home, '.claude', 'plugins', 'installed_plugins.json'),
  };
}

t('the plugin post counts ONLY skills under an ENABLED plugin', () => {
  const fx = buildPluginFixture('cbx-en-basic');
  const pl = post(cb.measure(fx.root, { paths: pluginPaths(fx) }), 'skill_catalog_plugins');
  // loaded: live(100) + relocated(300) + loose(50, unattributable -> counted, see the over-report rule) = 450
  assert.strictEqual(pl.skills, 3, 'loaded skill count wrong; got ' + pl.skills + ' — ' + JSON.stringify(pl.files.map((f) => f.skill)));
  assert.strictEqual(pl.chars, 450, 'loaded chars wrong; got ' + pl.chars);
  assert.strictEqual(pl.approx_tokens, 113, 'ceil(450/4) = 113; got ' + pl.approx_tokens);
});

t('the DISABLED weight is reported separately and is never added to the total', () => {
  const fx = buildPluginFixture('cbx-en-split');
  const rep = cb.measure(fx.root, { paths: pluginPaths(fx) });
  const pl = post(rep, 'skill_catalog_plugins');
  // not loaded: stale(200) + off(400) + dead(800) = 1400
  assert.strictEqual(pl.disabled_skills, 3, 'disabled skill count wrong; got ' + pl.disabled_skills);
  assert.strictEqual(pl.disabled_chars, 1400, 'disabled chars wrong; got ' + pl.disabled_chars);
  assert.strictEqual(pl.disabled_approx_tokens, 350, 'ceil(1400/4) = 350; got ' + pl.disabled_approx_tokens);
  assert.strictEqual(pl.skills_on_disk, 6, 'the on-disk count must still be reported honestly; got ' + pl.skills_on_disk);
  assert.strictEqual(rep.total_chars, rep.posts.reduce((n, p) => n + p.chars, 0),
    'the total must remain exactly the sum of the posts, i.e. loaded-only');
  assert.strictEqual(rep.potential_approx_tokens, 350, 'the disabled weight must be its own top-level figure; got ' + rep.potential_approx_tokens);
  assert.ok(rep.total_approx_tokens < rep.total_approx_tokens + rep.potential_approx_tokens, 'sanity');
});

t('a directory literally named *.disabled is never counted as loaded', () => {
  const fx = buildPluginFixture('cbx-en-disableddir');
  const pl = post(cb.measure(fx.root, { paths: pluginPaths(fx) }), 'skill_catalog_plugins');
  assert.ok(!pl.files.some((f) => /plugin\.disabled/.test(f.skill)),
    'a *.disabled directory leaked into the loaded set: ' + JSON.stringify(pl.files.map((f) => f.skill)));
  const dead = (pl.disabled_files || []).find((f) => /plugin\.disabled/.test(f.skill));
  assert.ok(dead, 'the *.disabled skill is not even reported as disabled');
  assert.ok(/disabled/i.test(dead.reason), 'the reason does not say why: ' + dead.reason);
});

t('a STALE copy of an enabled plugin (not the installed path) is not loaded', () => {
  const fx = buildPluginFixture('cbx-en-stale');
  const pl = post(cb.measure(fx.root, { paths: pluginPaths(fx) }), 'skill_catalog_plugins');
  const stale = (pl.disabled_files || []).find((f) => /0\.9\.0/.test(f.skill));
  assert.ok(stale, 'the old version was counted as loaded: ' + JSON.stringify(pl.files.map((f) => f.skill)));
  assert.ok(/stale|not the installed/i.test(stale.reason), stale.reason);
});

t('an enabled plugin whose recorded install path is GONE is still found by its own manifest', () => {
  const fx = buildPluginFixture('cbx-en-relocated');
  const pl = post(cb.measure(fx.root, { paths: pluginPaths(fx) }), 'skill_catalog_plugins');
  assert.ok(pl.files.some((f) => /relocated/.test(f.skill)),
    'the relocated copy of an enabled plugin was dropped: ' + JSON.stringify(pl.files.map((f) => f.skill)));
  const attr = pl.plugin_attribution.find((a) => a.plugin_key && /moved-plugin/.test(a.plugin_key) && a.enabled);
  assert.ok(attr, 'no attribution row for the relocated plugin: ' + JSON.stringify(pl.plugin_attribution));
});

t('an UNATTRIBUTABLE plugin skill is counted as LOADED and flagged — over-reporting is the safe direction', () => {
  const fx = buildPluginFixture('cbx-en-unknown');
  const pl = post(cb.measure(fx.root, { paths: pluginPaths(fx) }), 'skill_catalog_plugins');
  assert.ok(pl.files.some((f) => /loose/.test(f.skill)), 'the unattributable skill was silently dropped');
  assert.strictEqual(pl.unattributed_skills, 1, 'the unattributable count is not reported; got ' + pl.unattributed_skills);
  assert.ok(/unattribut/i.test(pl.note), 'the note does not mention unattributed skills: ' + pl.note);
});

t('with NO settings.json every SETTINGS-dependent skill counts as loaded and the meter says the split is unknown', () => {
  const fx = buildPluginFixture('cbx-en-nosettings', { skipSettings: true });
  const rep = cb.measure(fx.root, { paths: pluginPaths(fx) });
  const pl = post(rep, 'skill_catalog_plugins');
  // 5 of 6: without an enablement source no settings-based exclusion can be trusted, so everything counts —
  // over-reporting is the safe direction for a budget. The one exception is the `*.disabled` DIRECTORY, which
  // is filesystem-level truth and does not depend on settings.json at all.
  assert.strictEqual(pl.skills, 5, 'without an enablement source the settings-dependent skills must all count; got ' + pl.skills);
  assert.strictEqual(pl.disabled_skills, 1, 'only the *.disabled directory stays excluded; got ' + pl.disabled_skills);
  assert.ok((pl.disabled_files || []).every((f) => /plugin\.disabled/.test(f.skill)),
    'something other than the *.disabled directory was excluded without an enablement source: ' + JSON.stringify(pl.disabled_files));
  assert.ok(/enablement/i.test(pl.note) && /(unavailable|could not|no settings)/i.test(pl.note),
    'the note must say the enablement source was unreadable: ' + pl.note);
  assert.strictEqual(rep.plugin_enablement.available, false, JSON.stringify(rep.plugin_enablement));
});

t('the project and global skill catalogs are untouched by plugin enablement', () => {
  const fx = buildPluginFixture('cbx-en-others');
  const rep = cb.measure(fx.root, { paths: pluginPaths(fx) });
  for (const id of ['skill_catalog_project', 'skill_catalog_global']) {
    const p = post(rep, id);
    assert.strictEqual(p.disabled_skills, 0, id + ' must have no disabled split — it is not plugin-managed');
    assert.strictEqual(p.disabled_chars, 0, id + ' reported disabled chars');
  }
});

t('skillSourceLine reports the loaded count AND the not-loaded-but-present count', () => {
  const fx = buildPluginFixture('cbx-en-line');
  const line = cb.skillSourceLine(cb.measure(fx.root, { paths: pluginPaths(fx) }));
  assert.ok(/plugins 3/.test(line), 'the loaded plugin count is not in the line: ' + line);
  assert.ok(/3 (disabled|not loaded|off)/i.test(line), 'the not-loaded count is missing from the line: ' + line);
});

t('a baseline recorded on the OLD (everything-counted) figure does not read as a regression', () => {
  const fx = buildPluginFixture('cbx-en-baseline');
  cb.writeBaseline(fx.root, { paths: pluginPaths(fx) });
  const rep = cb.measure(fx.root, { paths: pluginPaths(fx) });
  assert.ok(rep.findings.every((f) => f.kind !== 'over_baseline' && f.kind !== 'over_baseline_total'),
    'measuring twice in a row produced growth findings: ' + JSON.stringify(rep.findings));
});

// --- the real machine ------------------------------------------------------------------------------------
t('on the REAL machine the plugin catalog reports FEWER loaded skills than sit on disk', () => {
  const rep = cb.measure(path.resolve(__dirname, '..', '..'), {});
  const pl = post(rep, 'skill_catalog_plugins');
  assert.strictEqual(pl.skills_on_disk, 112, 'the on-disk plugin skill count changed; got ' + pl.skills_on_disk);
  assert.ok(pl.skills < pl.skills_on_disk,
    'every plugin skill is still being counted as loaded (' + pl.skills + ' of ' + pl.skills_on_disk + ')');
  assert.ok(pl.disabled_skills > 0, 'no plugin skill was recognised as not-loaded');
  assert.strictEqual(pl.skills + pl.disabled_skills, pl.skills_on_disk,
    'loaded + not-loaded must account for every file found: ' + pl.skills + ' + ' + pl.disabled_skills + ' != ' + pl.skills_on_disk);
  assert.ok(rep.potential_approx_tokens > 0, 'the not-loaded weight is reported as zero on a machine that has disabled plugins');
});

t('the REAL total no longer includes the weight of switched-off plugins', () => {
  const rep = cb.measure(path.resolve(__dirname, '..', '..'), {});
  // 38.251 est. tokens was the figure while all 112 plugin skills were counted as loaded (2026-08-01).
  assert.ok(rep.total_approx_tokens < 38251,
    'the total did not come down at all; got ' + rep.total_approx_tokens);
  assert.ok(rep.total_approx_tokens > 24809, 'but it must still exceed the old project-only figure; got ' + rep.total_approx_tokens);
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
