#!/usr/bin/env node
'use strict';
/*
 * assert-standing-migration.js -- used only by .github/workflows/fresh-install.yml's "owner-rule
 * migration on upgrade" steps (v2.8.1, WP-P3). Shared cross-OS assertion logic for the installer's
 * preflight call into migrateOwnerStandingRules() (forge-sync.cjs) -- see that function's own doc
 * comment for the full v2.7.x-owner-rule-loss migration contract this checks the OUTCOME of.
 *
 * Usage:
 *   node assert-standing-migration.js migrated <projectDir> <shippedTemplatePath> <ruleId>
 *     -- asserts the owner rule <ruleId> now lives in
 *        <projectDir>/.claude/config/orchestration/FORGE_STANDING_RULES.user.json (with its owner
 *        source intact), and that FORGE_STANDING_RULES.json in the project is now byte-identical to
 *        <shippedTemplatePath> (the owner rule is gone from the template-synced copy).
 *   node assert-standing-migration.js malformed-kept <projectDir> <ruleId>
 *     -- asserts FORGE_STANDING_RULES.json in the project STILL contains <ruleId> (the installer
 *        refused to replace it this run because the private user file could not be trusted).
 *
 * Exit 0 = the named outcome holds. Exit 1 = it does not (message on stderr explains which check
 * failed). Exit 2 = usage error / a required file could not be read at all.
 */

const fs = require('fs');
const path = require('path');

const OWNER_SOURCE = 'owner /forge remember';

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function templatePathFor(projectDir) {
  return path.join(projectDir, '.claude', 'config', 'orchestration', 'FORGE_STANDING_RULES.json');
}
function userPathFor(projectDir) {
  return path.join(projectDir, '.claude', 'config', 'orchestration', 'FORGE_STANDING_RULES.user.json');
}

const mode = process.argv[2];
const projectDir = process.argv[3];

if (mode === 'migrated') {
  const shippedTemplatePath = process.argv[4];
  const ruleId = process.argv[5];
  if (!projectDir || !shippedTemplatePath || !ruleId) {
    console.error('usage: node assert-standing-migration.js migrated <projectDir> <shippedTemplatePath> <ruleId>');
    process.exit(2);
  }

  let userDoc;
  try { userDoc = readJson(userPathFor(projectDir)); }
  catch (e) { console.error('could not read/parse ' + userPathFor(projectDir) + ': ' + e.message); process.exit(2); }
  const moved = Array.isArray(userDoc.rules) && userDoc.rules.some((r) => r && r.id === ruleId && r.source === OWNER_SOURCE);
  if (!moved) {
    console.error('MISSING: ' + ruleId + ' (with source "' + OWNER_SOURCE + '") is not present in ' + userPathFor(projectDir));
    process.exit(1);
  }
  console.log('ok   ' + ruleId + ' was moved into FORGE_STANDING_RULES.user.json');

  let templateBuf, shippedBuf;
  try { templateBuf = fs.readFileSync(templatePathFor(projectDir)); }
  catch (e) { console.error('could not read ' + templatePathFor(projectDir) + ': ' + e.message); process.exit(2); }
  try { shippedBuf = fs.readFileSync(shippedTemplatePath); }
  catch (e) { console.error('could not read ' + shippedTemplatePath + ': ' + e.message); process.exit(2); }
  if (!templateBuf.equals(shippedBuf)) {
    console.error('NOT REPLACED: ' + templatePathFor(projectDir) + ' is not byte-identical to the shipped template ' + shippedTemplatePath);
    process.exit(1);
  }
  console.log('ok   FORGE_STANDING_RULES.json was replaced with the shipped, rule-free template');
  process.exit(0);
}

if (mode === 'malformed-kept') {
  const ruleId = process.argv[4];
  if (!projectDir || !ruleId) {
    console.error('usage: node assert-standing-migration.js malformed-kept <projectDir> <ruleId>');
    process.exit(2);
  }

  let templateDoc;
  try { templateDoc = readJson(templatePathFor(projectDir)); }
  catch (e) { console.error('could not read/parse ' + templatePathFor(projectDir) + ': ' + e.message); process.exit(2); }
  const stillThere = Array.isArray(templateDoc.rules) && templateDoc.rules.some((r) => r && r.id === ruleId);
  if (!stillThere) {
    console.error('REPLACED: ' + ruleId + ' is gone from ' + templatePathFor(projectDir) + ' -- it should have been kept because the migration could not confirm the private user file');
    process.exit(1);
  }
  console.log('ok   FORGE_STANDING_RULES.json was left in place (owner rule ' + ruleId + ' still present) because the private user file could not be trusted');
  process.exit(0);
}

// F2 fix (2026-09-27, independent v2.8.1 review): a FORGE_STANDING_RULES.json that EXISTS but cannot
// itself be read or parsed (corrupt/locked/unreadable) used to be silently backed up and replaced --
// migrateOwnerStandingRules() cannot tell that case apart from "nothing to migrate" (see that
// function's own doc comment; not edited by this fix). This asserts the opposite of that bug: the
// corrupt file's bytes are untouched (never JSON.parse'd -- it is compared byte-for-byte against the
// exact corrupt fixture text the caller wrote), and no *.forge-bak-* backup exists next to it (the
// file was truly skipped, not backed-up-and-replaced).
if (mode === 'template-unreadable-kept') {
  const corruptFixturePath = process.argv[4];
  if (!projectDir || !corruptFixturePath) {
    console.error('usage: node assert-standing-migration.js template-unreadable-kept <projectDir> <corruptFixturePath>');
    process.exit(2);
  }

  const targetPath = templatePathFor(projectDir);
  let targetBuf, fixtureBuf;
  try { targetBuf = fs.readFileSync(targetPath); }
  catch (e) { console.error('could not read ' + targetPath + ': ' + e.message); process.exit(2); }
  try { fixtureBuf = fs.readFileSync(corruptFixturePath); }
  catch (e) { console.error('could not read ' + corruptFixturePath + ': ' + e.message); process.exit(2); }

  if (!targetBuf.equals(fixtureBuf)) {
    console.error('REPLACED OR MODIFIED: ' + targetPath + ' no longer matches the corrupt fixture it started as -- it should have been left exactly as-is');
    process.exit(1);
  }
  console.log('ok   the corrupt FORGE_STANDING_RULES.json is byte-for-byte untouched');

  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const backups = fs.readdirSync(dir).filter((f) => f.indexOf(base + '.forge-bak-') === 0);
  if (backups.length > 0) {
    console.error('UNEXPECTED BACKUP: ' + backups.length + ' backup(s) of ' + base + ' exist even though it was supposed to be skipped entirely, not backed-up-and-replaced: ' + JSON.stringify(backups));
    process.exit(1);
  }
  console.log('ok   no backup of the corrupt file was created (it was skipped, never touched)');
  process.exit(0);
}

console.error('usage: node assert-standing-migration.js <migrated|malformed-kept|template-unreadable-kept> <projectDir> ...');
process.exit(2);
