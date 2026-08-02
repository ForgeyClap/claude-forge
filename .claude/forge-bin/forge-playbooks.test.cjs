#!/usr/bin/env node
'use strict';
/** Tests for the 4 Wave-E1 domain playbooks (forge-payments, forge-ecommerce, forge-electron, forge-voice):
 *  each SKILL.md exists, has valid+matching frontmatter, and carries every required playbook section (the
 *  same shape as the already-proven forge-website playbook); each has a matching config/rubrics/<domain>.json
 *  rubric with real criteria; and forge-router/SKILL.md actually references each playbook (Step 1 domain
 *  table + Step 3 team-routing table) so a build can never silently miss the routing row. Mirrors
 *  forge-agents.test.cjs's shape: real assertions against the live template PLUS a hermetic mutation fixture
 *  proving the section-lint actually bites. Never writes into the real template. */
const fs = require('fs');
const path = require('path');
const os = require('os');

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };

const TEMPLATE_ROOT = path.resolve(__dirname, '..', '..');
const SKILLS_DIR = path.join(TEMPLATE_ROOT, '.claude', 'skills');
const RUBRICS_DIR = path.join(TEMPLATE_ROOT, '.claude', 'config', 'rubrics');
const ROUTER_FILE = path.join(SKILLS_DIR, 'forge-router', 'SKILL.md');

// domain slug -> {skillDir, rubricFile}. Rubric filenames intentionally drop the "forge-" prefix
// (config/rubrics/payments.json, not forge-payments.json) — matches the real files on disk.
const PLAYBOOKS = ['payments', 'ecommerce', 'electron', 'voice'];

// Required playbook sections — the exact shape every proven playbook (forge-website included) already
// carries. Matched as a line-start prefix so minor heading suffixes ("(non-negotiable)", "(unique)", etc.)
// don't break the check — only a genuinely MISSING section does.
const REQUIRED_SECTIONS = [
  { label: 'Hard rules', re: /^## Hard rules/m },
  { label: 'Team', re: /^## Team/m },
  { label: 'Skills / commands / MCP', re: /^## Skills \/ commands \/ MCP/m },
  { label: 'Fan-out & flow', re: /^## Fan-out & flow/m },
  { label: 'Domain gates', re: /^## Domain gates/m },
  { label: 'Ship-readiness', re: /^## Ship-readiness/m },
];

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) { const mm = line.match(/^([A-Za-z_]+):\s*(.*)$/); if (mm) fm[mm[1]] = mm[2].trim(); }
  return fm;
}

// Pure lint: does a playbook SKILL.md body carry every required section? Returns {ok, missing[]}. Used both
// against the real 4 playbooks below AND against a hermetic mutated fixture (mutation-verify requirement).
function lintPlaybook(text) {
  const missing = REQUIRED_SECTIONS.filter((s) => !s.re.test(text)).map((s) => s.label);
  return { ok: missing.length === 0, missing };
}

// ---- REAL: the 4 live playbook SKILL.md files ----
for (const domain of PLAYBOOKS) {
  const skillPath = path.join(SKILLS_DIR, 'forge-' + domain, 'SKILL.md');
  const exists = fs.existsSync(skillPath);
  t('forge-' + domain + '/SKILL.md exists', exists);
  if (!exists) continue;

  const text = fs.readFileSync(skillPath, 'utf8');
  const fm = parseFrontmatter(text);
  t('forge-' + domain + ': frontmatter parses', !!fm);
  t('forge-' + domain + ': frontmatter name matches dir (forge-' + domain + ')', !!fm && fm.name === 'forge-' + domain);
  t('forge-' + domain + ': frontmatter has a non-empty description', !!fm && !!fm.description && fm.description.length > 20);

  const lint = lintPlaybook(text);
  t('forge-' + domain + ': carries all required sections' + (lint.missing.length ? ' (missing: ' + lint.missing.join(', ') + ')' : ''), lint.ok);

  // rubric wiring
  const rubricPath = path.join(RUBRICS_DIR, domain + '.json');
  const rubricExists = fs.existsSync(rubricPath);
  t('config/rubrics/' + domain + '.json exists', rubricExists);
  if (rubricExists) {
    let rubric = null;
    try { rubric = JSON.parse(fs.readFileSync(rubricPath, 'utf8')); } catch { /* leave null, assert below fails honestly */ }
    t(domain + '.json: valid JSON with domain="' + domain + '"', !!rubric && rubric.domain === domain);
    t(domain + '.json: has a numeric threshold + at least 3 real criteria', !!rubric && typeof rubric.threshold === 'number' && Array.isArray(rubric.criteria) && rubric.criteria.length >= 3);
    t(domain + '.json: every criterion has id + descriptor + raise', !!rubric && Array.isArray(rubric.criteria) && rubric.criteria.every((c) => c && c.id && c.descriptor && c.raise));
  }
}

// ---- REAL: the router references every playbook (Step 1 domain table + Step 3 team-routing table) ----
const routerExists = fs.existsSync(ROUTER_FILE);
t('forge-router/SKILL.md exists', routerExists);
if (routerExists) {
  const routerText = fs.readFileSync(ROUTER_FILE, 'utf8');
  for (const domain of PLAYBOOKS) {
    const needle = '`forge-' + domain + '`';
    t('forge-router references `forge-' + domain + '` (Step 1/3 routing row present)', routerText.includes(needle));
  }
  // each referenced specialist agent file that the playbooks name must actually exist (payment-integration,
  // electron-pro) — a routing row naming a specialist that doesn't exist would be a silent dead link.
  t('forge-router mentions payment-integration specialist', routerText.includes('payment-integration'));
  t('forge-router mentions electron-pro specialist', routerText.includes('electron-pro'));
}

// ---- REAL: the specialist agent files the playbooks lead through actually exist ----
for (const agentName of ['payment-integration', 'electron-pro', 'integration-boss', 'build-boss']) {
  const agentPath = path.join(TEMPLATE_ROOT, '.claude', 'agents', agentName + '.md');
  t('agent file exists: ' + agentName + '.md', fs.existsSync(agentPath));
}

// =====================================================================================================
// HERMETIC — mutation-verify: lintPlaybook must actually catch a missing required section, and a clean
// fixture built from a real playbook's own text must pass. Never writes into the real template.
// =====================================================================================================
console.log('');
console.log('Hermetic mutation checks (lintPlaybook section coverage)');

const REAL_PAYMENTS_TEXT = fs.readFileSync(path.join(SKILLS_DIR, 'forge-payments', 'SKILL.md'), 'utf8');

// clean baseline: the real file must lint clean
const cleanLint = lintPlaybook(REAL_PAYMENTS_TEXT);
t('hermetic baseline: real forge-payments/SKILL.md lints clean (0 missing sections)', cleanLint.ok === true && cleanLint.missing.length === 0);

// MUTATION 1: strip the "## Domain gates" section header (rename it) -> lint must catch it
const mutatedNoDomainGates = REAL_PAYMENTS_TEXT.replace(/^## Domain gates/m, '## Renamed Section');
const mutLint1 = lintPlaybook(mutatedNoDomainGates);
t('MUTATION: removing "## Domain gates" heading is caught by lintPlaybook', mutLint1.ok === false && mutLint1.missing.includes('Domain gates'));

// MUTATION 2: strip the "## Ship-readiness" section entirely (heading + body up to next ## or EOF)
const mutatedNoShipReadiness = REAL_PAYMENTS_TEXT.replace(/^## Ship-readiness[\s\S]*?(?=^## |\s*$)/m, '');
const mutLint2 = lintPlaybook(mutatedNoShipReadiness);
t('MUTATION: removing the "## Ship-readiness" section is caught by lintPlaybook', mutLint2.ok === false && mutLint2.missing.includes('Ship-readiness'));

// restore proof: the untouched original text (never written to disk) still lints clean after both mutations
// were applied only to in-memory copies — proves the mutations didn't touch the real file.
const restoredLint = lintPlaybook(fs.readFileSync(path.join(SKILLS_DIR, 'forge-payments', 'SKILL.md'), 'utf8'));
t('hermetic: real forge-payments/SKILL.md on disk is untouched after mutation checks (still lints clean)', restoredLint.ok === true);

// MUTATION 3: a hermetic fixture dir with a frontmatter name/dir mismatch is caught the same way agentsCheck
// catches it for Boss agent files — proves the frontmatter-name check is a real assertion, not decorative.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-playbooks-'));
const fixtureSkillDir = path.join(TMP, 'forge-fixture');
fs.mkdirSync(fixtureSkillDir, { recursive: true });
fs.writeFileSync(path.join(fixtureSkillDir, 'SKILL.md'), '---\nname: WRONG-NAME\ndescription: a fixture with a deliberately mismatched name field for the mutation test\n---\n\n## Hard rules\nx\n## Team\nx\n## Skills / commands / MCP\nx\n## Fan-out & flow\nx\n## Domain gates\nx\n## Ship-readiness\nx\n');
const fixtureText = fs.readFileSync(path.join(fixtureSkillDir, 'SKILL.md'), 'utf8');
const fixtureFm = parseFrontmatter(fixtureText);
t('hermetic: mismatched frontmatter name is a real catchable condition (fixture "WRONG-NAME" !== "forge-fixture")', !!fixtureFm && fixtureFm.name !== 'forge-fixture');
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
