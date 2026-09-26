#!/usr/bin/env node
'use strict';
/**
 * forge-codexreview-config.test.cjs — unit tests for the shipped+user Codex-config merge itself
 * (WP-S10, 2026-09-26). forge-codexreview.test.cjs already exercises this module end-to-end against the
 * real shipped codex-review.json; this file covers the module's own merge/build/label functions in
 * isolation with fully synthetic fixtures, independent of the real shipped file's exact content.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const CR = require(path.join(__dirname, 'forge-codexreview-config.cjs'));

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error('  FAIL ' + name + ' — ' + e.message); } };

console.log('forge-codexreview-config unit tests');

function freshRoot(shipped, user) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codexcfg-unit-'));
  const dir = path.join(root, '.claude', 'config', 'orchestration');
  fs.mkdirSync(dir, { recursive: true });
  if (shipped !== undefined) fs.writeFileSync(path.join(dir, 'codex-review.json'), typeof shipped === 'string' ? shipped : JSON.stringify(shipped));
  if (user !== undefined) fs.writeFileSync(path.join(dir, 'codex-review.user.json'), typeof user === 'string' ? user : JSON.stringify(user));
  return root;
}

const MINIMAL_SHIPPED = { review: { engine: 'codex', model: null, reasoning_effort: null, sandbox: 'read-only' }, naming: { step_label: 'Codex code-review' }, fallback: { engine: 'ecc', label: 'FALLBACK (non-independent) review' }, honesty: { never_claim_model_that_did_not_run: true } };

t('shippedPathOf/userPathOf resolve under .claude/config/orchestration', () => {
  const root = freshRoot(MINIMAL_SHIPPED);
  assert.ok(CR.shippedPathOf(root).endsWith(path.join('.claude', 'config', 'orchestration', 'codex-review.json')));
  assert.ok(CR.userPathOf(root).endsWith(path.join('.claude', 'config', 'orchestration', 'codex-review.user.json')));
  fs.rmSync(root, { recursive: true, force: true });
});

t('effectiveConfig() with no shipped file at all returns null (fail-closed)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codexcfg-unit-empty-'));
  assert.strictEqual(CR.effectiveConfig(root), null);
  fs.rmSync(root, { recursive: true, force: true });
});

t('effectiveConfig() with a CORRUPT shipped file returns null (fail-closed, never a fabricated default)', () => {
  const root = freshRoot('{ not json');
  assert.strictEqual(CR.effectiveConfig(root), null);
  fs.rmSync(root, { recursive: true, force: true });
});

t('effectiveConfig() with only a shipped file: user_present is false, values are the shipped ones', () => {
  const root = freshRoot(MINIMAL_SHIPPED);
  const eff = CR.effectiveConfig(root);
  assert.strictEqual(eff._source.user_present, false);
  assert.strictEqual(eff.review.model, null);
  assert.strictEqual(eff.review.sandbox, 'read-only');
  assert.strictEqual(eff.naming.step_label, 'Codex code-review');
  fs.rmSync(root, { recursive: true, force: true });
});

t('effectiveConfig() merges a user override field-by-field WITHIN the review section', () => {
  const root = freshRoot(MINIMAL_SHIPPED, { review: { model: 'm1', reasoning_effort: 'high' } });
  const eff = CR.effectiveConfig(root);
  assert.strictEqual(eff.review.model, 'm1');
  assert.strictEqual(eff.review.reasoning_effort, 'high');
  assert.strictEqual(eff.review.sandbox, 'read-only', 'sandbox must survive from the shipped default');
  assert.strictEqual(eff.review.engine, 'codex', 'engine must survive from the shipped default');
  fs.rmSync(root, { recursive: true, force: true });
});

t('effectiveConfig() leaves OTHER sections (naming/fallback/honesty) untouched when the user file only sets review', () => {
  const root = freshRoot(MINIMAL_SHIPPED, { review: { model: 'm1' } });
  const eff = CR.effectiveConfig(root);
  assert.strictEqual(eff.naming.step_label, 'Codex code-review');
  assert.strictEqual(eff.fallback.engine, 'ecc');
  assert.strictEqual(eff.honesty.never_claim_model_that_did_not_run, true);
  fs.rmSync(root, { recursive: true, force: true });
});

t('effectiveConfig() lets a user file override a NON-review section too (naming)', () => {
  const root = freshRoot(MINIMAL_SHIPPED, { naming: { step_label: 'Custom label' } });
  const eff = CR.effectiveConfig(root);
  assert.strictEqual(eff.naming.step_label, 'Custom label');
  assert.strictEqual(eff.review.model, null, 'overriding naming must not affect review');
  fs.rmSync(root, { recursive: true, force: true });
});

t('a CORRUPT user file degrades to "no override" rather than crashing effectiveConfig()', () => {
  const root = freshRoot(MINIMAL_SHIPPED, '{ still not json');
  const eff = CR.effectiveConfig(root);
  assert.ok(eff);
  assert.strictEqual(eff.review.model, null);
  assert.strictEqual(eff._source.user_present, false, 'a corrupt user file must not count as present');
  fs.rmSync(root, { recursive: true, force: true });
});

t('a user file that is valid JSON but not an object degrades to "no override"', () => {
  const root = freshRoot(MINIMAL_SHIPPED, '[1,2,3]');
  const eff = CR.effectiveConfig(root);
  assert.strictEqual(eff.review.model, null);
  fs.rmSync(root, { recursive: true, force: true });
});

t('buildCommand(): fully unpinned omits -m and -c, keeps -s and the review prompt placeholder', () => {
  const eff = { review: { model: null, reasoning_effort: null, sandbox: 'read-only' } };
  const cmd = CR.buildCommand(eff, {});
  assert.strictEqual(cmd, 'codex exec -s read-only "<review prompt>"');
});

t('buildCommand(): model set, effort unset -> only -m, no -c', () => {
  const eff = { review: { model: 'm1', reasoning_effort: null, sandbox: 'read-only' } };
  const cmd = CR.buildCommand(eff, {});
  assert.strictEqual(cmd, 'codex exec -m m1 -s read-only "<review prompt>"');
});

t('buildCommand(): both set -> -m and -c in that order, sandbox after', () => {
  const eff = { review: { model: 'm1', reasoning_effort: 'xhigh', sandbox: 'read-only' } };
  const cmd = CR.buildCommand(eff, {});
  assert.strictEqual(cmd, 'codex exec -m m1 -c model_reasoning_effort=xhigh -s read-only "<review prompt>"');
});

t('buildCommand(): adversarial swaps the prompt placeholder, keeps the same flags', () => {
  const eff = { review: { model: 'm1', reasoning_effort: 'xhigh', sandbox: 'read-only' } };
  const cmd = CR.buildCommand(eff, { adversarial: true });
  assert.strictEqual(cmd, 'codex exec -m m1 -c model_reasoning_effort=xhigh -s read-only "ADVERSARIAL CODE REVIEW. <focus>"');
});

t('buildCommand(): missing sandbox in effective config falls back to read-only', () => {
  const eff = { review: { model: null, reasoning_effort: null } };
  const cmd = CR.buildCommand(eff, {});
  assert.ok(/-s read-only/.test(cmd));
});

t('buildCommand(): whitespace-only model/effort strings are treated as unset', () => {
  const eff = { review: { model: '   ', reasoning_effort: '\t', sandbox: 'read-only' } };
  const cmd = CR.buildCommand(eff, {});
  assert.strictEqual(cmd, 'codex exec -s read-only "<review prompt>"');
});

t('modelLabel/effortLabel/isPinned agree with buildCommand for both states', () => {
  const unpinned = { review: { model: null, reasoning_effort: null } };
  assert.strictEqual(CR.modelLabel(unpinned), 'Codex default model');
  assert.strictEqual(CR.effortLabel(unpinned), 'Codex default effort');
  assert.strictEqual(CR.isPinned(unpinned), false);
  const pinned = { review: { model: 'm1', reasoning_effort: 'low' } };
  assert.strictEqual(CR.modelLabel(pinned), 'm1');
  assert.strictEqual(CR.effortLabel(pinned), 'low');
  assert.strictEqual(CR.isPinned(pinned), true);
});

t('modelLabel/effortLabel/isPinned handle a completely empty/null effective object without throwing', () => {
  assert.strictEqual(CR.modelLabel(null), 'Codex default model');
  assert.strictEqual(CR.effortLabel(undefined), 'Codex default effort');
  assert.strictEqual(CR.isPinned({}), false);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
