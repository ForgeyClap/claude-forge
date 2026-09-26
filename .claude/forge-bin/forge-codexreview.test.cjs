#!/usr/bin/env node
'use strict';
/**
 * forge-codexreview.test.cjs — the independent code review runs on the EFFECTIVE Codex config: the
 * SHIPPED, template-owned `codex-review.json` (portable default: no model/effort pin) merged with an
 * OPTIONAL, never-shipped, account-specific `codex-review.user.json` override.
 *
 * WP-S10 (2026-09-26, fresh-laptop re-audit N4/Part V-G, "the Codex pin"): the previous version of this
 * suite pinned the RAW shipped file's `review.model` to a literal string (first `gpt-5.6-sol`, then
 * `gpt-6-astra`) — that model was the MAINTAINER's own account-specific pin (chosen because an earlier
 * model returned HTTP 400 on that ChatGPT account), hard-baked into a file every fresh install ships.
 * A fresh account may reject that exact model too. This suite now tests the CONTRACT — the shipped
 * default is portable (no pin), an optional user file may override it, the merge behaves correctly, and
 * every consumer (`forge-codexreview-config.cjs`, the codex-reviewer agent, the forge-code-review skill)
 * reads/derives from the EFFECTIVE config rather than assuming a model — instead of a transcript pinned
 * to one account's history.
 *
 * Run: node forge-codexreview.test.cjs   (exit 0 = all pass)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..', '..');
const CONFIG_PATH = path.join(ROOT, '.claude', 'config', 'orchestration', 'codex-review.json');
const USER_CONFIG_PATH = path.join(ROOT, '.claude', 'config', 'orchestration', 'codex-review.user.json');
const AGENT_PATH = path.join(ROOT, '.claude', 'agents', 'codex-reviewer.md');
const SKILL_PATH = path.join(ROOT, '.claude', 'skills', 'forge-code-review', 'SKILL.md');
const CR = require(path.join(__dirname, 'forge-codexreview-config.cjs'));

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error('  FAIL ' + name + ' — ' + e.message); } };

console.log('forge codex-review pinning tests (effective config, WP-S10)');

const readCfg = () => JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

t('the single source of truth exists and is valid JSON', () => {
  assert.ok(fs.existsSync(CONFIG_PATH), 'missing ' + CONFIG_PATH);
  readCfg();
});

t('the SHIPPED default is portable: no model or effort pin at all', () => {
  const c = readCfg();
  assert.strictEqual(c.review.engine, 'codex');
  assert.strictEqual(c.review.model, null, 'the shipped file must not hard-pin a model — one account\'s pin belongs in codex-review.user.json, never here');
  assert.strictEqual(c.review.reasoning_effort, null, 'the shipped file must not hard-pin a reasoning effort — same reasoning as the model pin');
});

t('the shipped naming/fallback text is model-agnostic (no account-specific model name baked in)', () => {
  const c = readCfg();
  assert.ok(!/gpt-[0-9]/i.test(c.naming.step_label), 'the shipped step_label names a specific model: ' + c.naming.step_label);
  assert.ok(/codex/i.test(c.naming.step_label), 'the planned step should name Codex: ' + c.naming.step_label);
  assert.ok(!/ECC code-review/i.test(c.naming.step_label), 'the PLANNED step must not be named after the fallback');
});

// --- hermetic effective-config tests: an isolated temp root, its OWN shipped copy, and a synthetic
//     user override — so this suite never depends on whether a real codex-review.user.json exists here.
function freshRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codexcfg-'));
  fs.mkdirSync(path.join(root, '.claude', 'config', 'orchestration'), { recursive: true });
  fs.copyFileSync(CONFIG_PATH, path.join(root, '.claude', 'config', 'orchestration', 'codex-review.json'));
  return root;
}

t('UNPINNED (no user file at all): effectiveConfig resolves model/effort to null', () => {
  const root = freshRoot();
  const eff = CR.effectiveConfig(root);
  assert.ok(eff, 'effectiveConfig returned null on a hermetic root with a valid shipped file');
  assert.strictEqual(eff.review.model, null);
  assert.strictEqual(eff.review.reasoning_effort, null);
  assert.strictEqual(eff._source.user_present, false);
  fs.rmSync(root, { recursive: true, force: true });
});

t('UNPINNED: buildCommand() omits -m and -c model_reasoning_effort= entirely', () => {
  const root = freshRoot();
  const eff = CR.effectiveConfig(root);
  const cmd = CR.buildCommand(eff, { adversarial: false });
  assert.ok(!/ -m /.test(cmd), 'unpinned command still passes -m: ' + cmd);
  assert.ok(!/model_reasoning_effort=/.test(cmd), 'unpinned command still passes an effort: ' + cmd);
  assert.ok(/-s read-only/.test(cmd), 'unpinned command drops the read-only sandbox: ' + cmd);
  assert.strictEqual(CR.modelLabel(eff), 'Codex default model');
  assert.strictEqual(CR.effortLabel(eff), 'Codex default effort');
  assert.strictEqual(CR.isPinned(eff), false);
  fs.rmSync(root, { recursive: true, force: true });
});

t('PINNED (synthetic user override): effectiveConfig merges the override onto the shipped default', () => {
  const root = freshRoot();
  fs.writeFileSync(path.join(root, '.claude', 'config', 'orchestration', 'codex-review.user.json'), JSON.stringify({ review: { model: 'test-model-x', reasoning_effort: 'medium' } }));
  const eff = CR.effectiveConfig(root);
  assert.strictEqual(eff.review.model, 'test-model-x');
  assert.strictEqual(eff.review.reasoning_effort, 'medium');
  // fields NOT set in the override must survive from the shipped default untouched
  assert.strictEqual(eff.review.sandbox, 'read-only', 'a partial override wiped an un-overridden field');
  assert.strictEqual(eff.review.engine, 'codex', 'a partial override wiped an un-overridden field');
  assert.strictEqual(eff._source.user_present, true);
  fs.rmSync(root, { recursive: true, force: true });
});

t('PINNED: buildCommand() carries the overridden model AND effort (not just names them in prose)', () => {
  const root = freshRoot();
  fs.writeFileSync(path.join(root, '.claude', 'config', 'orchestration', 'codex-review.user.json'), JSON.stringify({ review: { model: 'test-model-x', reasoning_effort: 'medium' } }));
  const eff = CR.effectiveConfig(root);
  for (const opts of [{ adversarial: false }, { adversarial: true }]) {
    const cmd = CR.buildCommand(eff, opts);
    assert.ok(cmd.includes('test-model-x'), 'command does not pass the pinned model: ' + cmd);
    assert.ok(cmd.includes('model_reasoning_effort=medium'), 'command does not pass the pinned effort: ' + cmd);
    assert.ok(/-s read-only/.test(cmd), 'command does not enforce the read-only sandbox: ' + cmd);
  }
  assert.strictEqual(CR.modelLabel(eff), 'test-model-x');
  assert.strictEqual(CR.effortLabel(eff), 'medium');
  assert.strictEqual(CR.isPinned(eff), true);
  assert.ok(/ADVERSARIAL CODE REVIEW/.test(CR.buildCommand(eff, { adversarial: true })), 'adversarial command missing the adversarial prefix');
  fs.rmSync(root, { recursive: true, force: true });
});

t('a user file that overrides only ONE field leaves the other untouched', () => {
  const root = freshRoot();
  fs.writeFileSync(path.join(root, '.claude', 'config', 'orchestration', 'codex-review.user.json'), JSON.stringify({ review: { model: 'only-model-set' } }));
  const eff = CR.effectiveConfig(root);
  assert.strictEqual(eff.review.model, 'only-model-set');
  assert.strictEqual(eff.review.reasoning_effort, null, 'reasoning_effort should still be the shipped default (null) since the override did not set it');
  const cmd = CR.buildCommand(eff, {});
  assert.ok(cmd.includes('only-model-set'));
  assert.ok(!/model_reasoning_effort=/.test(cmd), 'a model-only override must not invent an effort flag: ' + cmd);
  fs.rmSync(root, { recursive: true, force: true });
});

t('a corrupt or missing user file degrades to the shipped default, never a crash', () => {
  const root = freshRoot();
  fs.writeFileSync(path.join(root, '.claude', 'config', 'orchestration', 'codex-review.user.json'), '{ this is not json');
  const eff = CR.effectiveConfig(root);
  assert.ok(eff, 'a corrupt user file must not take down effectiveConfig()');
  assert.strictEqual(eff.review.model, null);
  fs.rmSync(root, { recursive: true, force: true });
});

t('a missing SHIPPED file fails closed (returns null, never a fabricated default)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codexcfg-noshipped-'));
  const eff = CR.effectiveConfig(root);
  assert.strictEqual(eff, null);
  fs.rmSync(root, { recursive: true, force: true });
});

t('the review is read-only in the SHIPPED default (sandbox pin survives regardless of model)', () => {
  const c = readCfg();
  assert.strictEqual(c.review.sandbox, 'read-only');
});

t('the CLI floor is recorded and well-formed (a general CLI-compatibility floor, not tied to one model)', () => {
  const c = readCfg();
  assert.ok(/^\d+\.\d+\.\d+$/.test(String(c.review.min_cli_version)), 'min_cli_version missing/malformed');
  const [maj, min] = String(c.review.min_cli_version).split('.').map(Number);
  assert.ok(maj > 0 || min >= 146, 'min_cli_version is below the version historically needed to reach a pinned model (0.146.0)');
});

t('the fallback is fallback-shaped: labelled, non-independent, and never the planned step', () => {
  const c = readCfg();
  assert.strictEqual(c.fallback.engine, 'ecc');
  assert.ok(/FALLBACK/.test(c.fallback.label), 'the fallback label does not announce itself as a fallback');
  assert.ok(/non-independent/i.test(c.fallback.label), 'the fallback must be labelled non-independent');
});

t('honesty flag: a model that did not run may never be claimed', () => {
  const c = readCfg();
  assert.strictEqual(c.honesty.never_claim_model_that_did_not_run, true);
});

// --- the two invocation sites must describe the EFFECTIVE config, not assume/restate a model ---
t('the codex-reviewer agent points at BOTH the shipped config and the optional user override', () => {
  const md = fs.readFileSync(AGENT_PATH, 'utf8');
  assert.ok(md.includes('config/orchestration/codex-review.json'), 'the agent does not reference the shipped config path');
  assert.ok(md.includes('codex-review.user.json'), 'the agent does not reference the optional user-override path');
});

t('the codex-reviewer agent describes the unpinned (portable-default) case honestly', () => {
  const md = fs.readFileSync(AGENT_PATH, 'utf8');
  assert.ok(/Codex default model/.test(md), 'agent never names the honest "Codex default model" fallback label');
  assert.ok(/no.*pin|null/i.test(md), 'agent never describes the unpinned/portable-default case');
});

t('the agent warns that a bare /codex:review drops the effective flags', () => {
  const md = fs.readFileSync(AGENT_PATH, 'utf8');
  assert.ok(/never a bare .codex:review|never a bare `\/codex:review`/i.test(md.replace(/\s+/g, ' ')),
    'nothing warns that the bare slash command silently drops the effective model/effort');
});

t('the forge-code-review skill points at BOTH the shipped config and the optional user override', () => {
  const md = fs.readFileSync(SKILL_PATH, 'utf8');
  assert.ok(md.includes('config/orchestration/codex-review.json'), 'the skill does not reference the shipped config path');
  assert.ok(md.includes('codex-review.user.json'), 'the skill does not reference the optional user-override path');
});

t('the skill describes the unpinned (portable-default) case honestly', () => {
  const md = fs.readFileSync(SKILL_PATH, 'utf8');
  assert.ok(/Codex default model/.test(md), 'skill never names the honest "Codex default model" fallback label');
});

t('the skill forbids naming the planned work package after the ECC fallback', () => {
  const md = fs.readFileSync(SKILL_PATH, 'utf8').replace(/\s+/g, ' ');
  assert.ok(/not an "?ECC code-review"?/i.test(md) || /never planned/i.test(md),
    'nothing tells a planner to stop calling this step an "ECC code-review"');
});

t('the skill forbids attributing a review to a model that did not run', () => {
  const md = fs.readFileSync(SKILL_PATH, 'utf8').replace(/\s+/g, ' ');
  assert.ok(/never attribute a review to a model that did not run/i.test(md), 'the provenance rule is missing');
});

// --- if a REAL (maintainer) user override happens to exist in this tree, prove it actually resolves ---
t('if a real codex-review.user.json exists in this project, effectiveConfig() resolves it consistently', () => {
  if (!fs.existsSync(USER_CONFIG_PATH)) { console.log('      (skipped: no codex-review.user.json in this tree — the portable default applies)'); return; }
  const eff = CR.effectiveConfig(ROOT);
  const user = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, 'utf8'));
  if (user.review && typeof user.review.model === 'string') {
    assert.strictEqual(eff.review.model, user.review.model, 'effectiveConfig did not pick up the real user override\'s model');
    assert.ok(CR.buildCommand(eff, {}).includes(user.review.model), 'buildCommand() did not carry the real pinned model');
  }
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
