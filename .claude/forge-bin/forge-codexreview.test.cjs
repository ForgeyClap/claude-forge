#!/usr/bin/env node
'use strict';
/**
 * forge-codexreview.test.cjs — the independent code review runs on the model the OWNER pinned.
 *
 * OWNER DIRECTIVE, current: gpt-5.6-sol at reasoning effort `xhigh` (2026-08-04 pinned the model at
 * effort `max`; on 2026-08-09 the owner adjusted the effort to `xhigh` — "kan je efforct naar extra
 * high doen inplaats max?" — validated live against the CLI with --strict-config).
 *
 * MEASURED DEFECT (owner directive 2026-08-04: "dat moet codex op gpt 5.6 sol effort:max doen"):
 * nothing in this system pinned a review model at all. Both the `codex-reviewer` agent and the
 * `forge-code-review` skill said "run /codex:review" and let the plugin use whatever default it
 * carried — so a review the owner asked for on their strongest reasoning model could silently run on
 * something weaker, and no artifact would ever show the difference. Reaching `gpt-5.6-sol` also needs
 * a Codex CLI >= 0.146.0: on 0.142.3 the API answers HTTP 400 "requires a newer version of Codex"
 * (measured live 2026-08-03), which looks exactly like "model unavailable" if you don't check.
 *
 * These tests pin the CONTRACT, not a transcript: one config file is the single source of truth, the
 * two places that invoke a review point AT it instead of restating the model from memory, and the
 * fallback can never be presented as the planned step.
 *
 * Run: node forge-codexreview.test.cjs   (exit 0 = all pass)
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..', '..');
const CONFIG_PATH = path.join(ROOT, '.claude', 'config', 'orchestration', 'codex-review.json');
const AGENT_PATH = path.join(ROOT, '.claude', 'agents', 'codex-reviewer.md');
const SKILL_PATH = path.join(ROOT, '.claude', 'skills', 'forge-code-review', 'SKILL.md');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error('  FAIL ' + name + ' — ' + e.message); } };

console.log('forge codex-review pinning tests');

const readCfg = () => JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

t('the single source of truth exists and is valid JSON', () => {
  assert.ok(fs.existsSync(CONFIG_PATH), 'missing ' + CONFIG_PATH);
  readCfg();
});

t('the owner-pinned model and effort are exactly what was asked for', () => {
  const c = readCfg();
  assert.strictEqual(c.review.engine, 'codex');
  assert.strictEqual(c.review.model, 'gpt-5.6-sol', 'the review model drifted from the owner directive');
  // The ONE place that holds the owner's literal pinned effort. Everything else in this suite derives
  // from c.review.reasoning_effort instead of restating it, so a future owner change is a one-line edit
  // here + the config — not a scavenger hunt through three hardcoded regexes (which is exactly how this
  // suite went red on 2026-08-09: the owner moved max -> xhigh, the config/agent/skill followed, and the
  // three hardcoded 'max' assertions did not).
  assert.strictEqual(c.review.reasoning_effort, 'xhigh', 'the reasoning effort drifted from the owner directive');
});

t('the recorded command actually carries the model AND the effort (not just names them in prose)', () => {
  const c = readCfg();
  for (const key of ['command', 'adversarial_command']) {
    const cmd = c.review[key];
    assert.ok(typeof cmd === 'string' && cmd.length, key + ' missing');
    assert.ok(cmd.includes(c.review.model), key + ' does not pass the pinned model: ' + cmd);
    assert.ok(cmd.includes('model_reasoning_effort=' + c.review.reasoning_effort),
      key + ' does not pass effort=' + c.review.reasoning_effort + ': ' + cmd);
  }
});

t('the review is read-only — an independent reviewer does not get write access', () => {
  const c = readCfg();
  assert.strictEqual(c.review.sandbox, 'read-only');
  assert.ok(/-s read-only/.test(c.review.command), 'the command does not enforce the read-only sandbox');
});

t('the CLI floor that makes this model reachable is recorded (an old CLI is not a missing model)', () => {
  const c = readCfg();
  assert.ok(/^\d+\.\d+\.\d+$/.test(String(c.review.min_cli_version)), 'min_cli_version missing/malformed');
  const [maj, min] = String(c.review.min_cli_version).split('.').map(Number);
  assert.ok(maj > 0 || min >= 146, 'min_cli_version is below the version proven to accept this model (0.146.0)');
});

t('the fallback is fallback-shaped: labelled, non-independent, and never the planned step', () => {
  const c = readCfg();
  assert.strictEqual(c.fallback.engine, 'ecc');
  assert.ok(/FALLBACK/.test(c.fallback.label), 'the fallback label does not announce itself as a fallback');
  assert.ok(/non-independent/i.test(c.fallback.label), 'the fallback must be labelled non-independent');
  assert.ok(!/ECC code-review/i.test(c.naming.step_label), 'the PLANNED step must not be named after the fallback');
  assert.ok(/codex/i.test(c.naming.step_label), 'the planned step should name Codex: ' + c.naming.step_label);
});

t('honesty flag: a model that did not run may never be claimed', () => {
  const c = readCfg();
  assert.strictEqual(c.honesty.never_claim_model_that_did_not_run, true);
});

// --- the two invocation sites must POINT AT the config, not restate the model from memory ---
t('the codex-reviewer agent points at the config file by path', () => {
  const md = fs.readFileSync(AGENT_PATH, 'utf8');
  assert.ok(md.includes('config/orchestration/codex-review.json'), 'the agent does not reference the pinned-config path');
});

t('the codex-reviewer agent names the pinned model and effort', () => {
  const md = fs.readFileSync(AGENT_PATH, 'utf8');
  const c = readCfg();
  assert.ok(md.includes(c.review.model), 'agent never names the pinned model');
  assert.ok(md.includes('model_reasoning_effort=' + c.review.reasoning_effort),
    'agent never passes effort=' + c.review.reasoning_effort);
});

t('the agent warns that a bare /codex:review drops the model and effort', () => {
  const md = fs.readFileSync(AGENT_PATH, 'utf8');
  assert.ok(/never a bare .codex:review|never a bare `\/codex:review`/i.test(md.replace(/\s+/g, ' ')),
    'nothing warns that the bare slash command silently drops the pinning');
});

t('the forge-code-review skill points at the config and names the model', () => {
  const md = fs.readFileSync(SKILL_PATH, 'utf8');
  const c = readCfg();
  assert.ok(md.includes('config/orchestration/codex-review.json'), 'the skill does not reference the pinned-config path');
  assert.ok(md.includes(c.review.model), 'the skill never names the pinned model');
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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
