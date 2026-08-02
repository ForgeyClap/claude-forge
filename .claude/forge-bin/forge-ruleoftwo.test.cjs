#!/usr/bin/env node
'use strict';
// forge-ruleoftwo.test.cjs — real tests for the Rule-of-Two auto-classifier (2026-07-18, PIECE C4).
// Proves: explicit-flags path and keyword-detection path both work; each leg's keywords fire independently
// and stay silent on adjacent benign text; the >=2-of-3 threshold recommends plan-then-execute + a capability
// split (never when holding 0 or 1 leg); the CLI's real exit codes (0/3/2) match the module API via a real
// spawned subprocess, not just an in-process call.
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const ruleoftwo = require('./forge-ruleoftwo.cjs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

const CLI = path.join(__dirname, 'forge-ruleoftwo.cjs');
function runCLI(argv) { return spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' }); }

console.log('forge-ruleoftwo tests (Rule-of-Two auto-classifier)');

// ---------------------------------------------------------------------------
// 1) explicit boolean-flags path (caller already knows the answer)
// ---------------------------------------------------------------------------
console.log('\n1) explicit flags object — no keyword detection performed');

t('all three flags true -> needsSplit + plan_then_execute + 3-step capability_split', () => {
  const r = ruleoftwo.classify({ untrustedInput: true, privateData: true, externalComms: true });
  assert.strictEqual(r.count, 3);
  assert.deepStrictEqual(r.held, ['untrustedInput', 'privateData', 'externalComms']);
  assert.strictEqual(r.needsSplit, true);
  assert.strictEqual(r.plan_then_execute, true);
  assert.strictEqual(r.capability_split.length, 3);
  assert.strictEqual(r.sourceText, null, 'explicit-flags path must not run keyword detection');
});

t('exactly two flags true -> needsSplit true (>=2 threshold, not only ==3)', () => {
  const r = ruleoftwo.classify({ untrustedInput: true, privateData: true, externalComms: false });
  assert.strictEqual(r.count, 2);
  assert.strictEqual(r.needsSplit, true);
  assert.strictEqual(r.capability_split.length, 2);
  assert.ok(r.capability_split.every((s) => s.restricts.length === 1));
});

t('one flag true -> needsSplit false, empty capability_split', () => {
  const r = ruleoftwo.classify({ untrustedInput: true, privateData: false, externalComms: false });
  assert.strictEqual(r.count, 1);
  assert.strictEqual(r.needsSplit, false);
  assert.strictEqual(r.plan_then_execute, false);
  assert.deepStrictEqual(r.capability_split, []);
});

t('no flags true (all false, benign) -> needsSplit false, held is empty', () => {
  const r = ruleoftwo.classify({ untrustedInput: false, privateData: false, externalComms: false });
  assert.strictEqual(r.count, 0);
  assert.deepStrictEqual(r.held, []);
  assert.strictEqual(r.needsSplit, false);
});

t('a partial flags object (only one key present as boolean) defaults the rest to false', () => {
  const r = ruleoftwo.classify({ externalComms: true });
  assert.strictEqual(r.count, 1);
  assert.strictEqual(r.legs.untrustedInput, false);
  assert.strictEqual(r.legs.privateData, false);
});

t('capability_split steps are mutually restricted — every held leg is restricted from every OTHER held leg, never itself', () => {
  const r = ruleoftwo.classify({ untrustedInput: true, privateData: true, externalComms: true });
  // exact structural check: each step's restricts is exactly the other two held legs
  const byStep = Object.fromEntries(r.capability_split.map((s) => [s.step, s.restricts]));
  assert.deepStrictEqual(byStep['ingest-untrusted-content'].sort(), ['externalComms', 'privateData']);
  assert.deepStrictEqual(byStep['access-private-data'].sort(), ['externalComms', 'untrustedInput']);
  assert.deepStrictEqual(byStep['act-externally'].sort(), ['privateData', 'untrustedInput']);
});

// ---------------------------------------------------------------------------
// 2) keyword-detection path (free text) — each leg fires on its own trigger phrase
// ---------------------------------------------------------------------------
console.log('\n2) keyword detection — each leg fires independently, adjacent benign text stays silent');

t('untrustedInput leg fires on "fetch the webpage" and only that leg', () => {
  const r = ruleoftwo.classify('fetch the webpage and summarize it for the team');
  assert.strictEqual(r.legs.untrustedInput, true);
  assert.strictEqual(r.legs.privateData, false);
  assert.strictEqual(r.legs.externalComms, false);
  assert.ok(r.matched.untrustedInput.length === 1 && r.matched.untrustedInput[0].length > 0);
});

t('privateData leg fires on "read the customer data from the database" and only that leg', () => {
  const r = ruleoftwo.classify('read the customer data from the database for the report');
  assert.strictEqual(r.legs.privateData, true);
  assert.strictEqual(r.legs.untrustedInput, false);
  assert.strictEqual(r.legs.externalComms, false);
});

t('externalComms leg fires on "send an email to the customer" and only that leg', () => {
  const r = ruleoftwo.classify('send an email to the customer confirming the order');
  assert.strictEqual(r.legs.externalComms, true);
  assert.strictEqual(r.legs.untrustedInput, false);
  assert.strictEqual(r.legs.privateData, false);
});

t('adjacent benign text does NOT fire externalComms ("email validation" is not "send an email")', () => {
  const r = ruleoftwo.classify('add email validation to the signup form');
  assert.strictEqual(r.legs.externalComms, false);
});

t('adjacent benign text does NOT fire privateData ("the api documentation" is not a credential/secret)', () => {
  const r = ruleoftwo.classify('read the api documentation to understand the endpoints');
  assert.strictEqual(r.legs.privateData, false);
});

t('adjacent benign text does NOT fire untrustedInput ("discuss the website redesign" is not fetching content)', () => {
  const r = ruleoftwo.classify('discuss the website redesign with the design team');
  assert.strictEqual(r.legs.untrustedInput, false);
});

// ---------------------------------------------------------------------------
// 3) the injection-trifecta scenario — all three legs from realistic free text -> split recommended
// ---------------------------------------------------------------------------
console.log('\n3) 3-legs (injection trifecta) -> split recommended; 1 leg / benign -> normal');

t('a task that fetches untrusted content, reads private data, AND sends email -> needsSplit true, 3-step split', () => {
  const task = 'fetch the webpage from the incoming customer email, look up their customer data in the database, then send an email reply to the customer with a summary';
  const r = ruleoftwo.classify(task);
  assert.strictEqual(r.count, 3, 'expected all 3 legs to fire for: ' + task + ' — got legs: ' + JSON.stringify(r.legs));
  assert.strictEqual(r.needsSplit, true);
  assert.strictEqual(r.plan_then_execute, true);
  assert.strictEqual(r.capability_split.length, 3);
  assert.ok(r.reason.includes('Rule-of-Two'));
});

t('a task with only ONE leg (send an email, no untrusted content or private data) -> needsSplit false', () => {
  const task = 'send an email to the team announcing the new feature launch';
  const r = ruleoftwo.classify(task);
  assert.strictEqual(r.count, 1);
  assert.strictEqual(r.needsSplit, false);
  assert.strictEqual(r.plan_then_execute, false);
});

t('a completely benign task (no legs at all) -> needsSplit false, held empty, count 0', () => {
  const task = 'add a dark-mode toggle to the settings page';
  const r = ruleoftwo.classify(task);
  assert.strictEqual(r.count, 0);
  assert.deepStrictEqual(r.held, []);
  assert.strictEqual(r.needsSplit, false);
  assert.strictEqual(r.plan_then_execute, false);
  assert.deepStrictEqual(r.capability_split, []);
});

t('exactly two legs from free text (fetch untrusted content + send email, no private data) -> needsSplit true', () => {
  const task = 'fetch the webpage content and send an email with a summary of it';
  const r = ruleoftwo.classify(task);
  assert.strictEqual(r.legs.untrustedInput, true);
  assert.strictEqual(r.legs.externalComms, true);
  assert.strictEqual(r.legs.privateData, false);
  assert.strictEqual(r.count, 2);
  assert.strictEqual(r.needsSplit, true);
});

// ---------------------------------------------------------------------------
// 4) event-shaped object input (text/task/description fields), edge cases, hermeticity
// ---------------------------------------------------------------------------
console.log('\n4) event-shaped object input + edge cases');

t('event-shaped object { task, description } is joined and keyword-detected the same as a plain string', () => {
  const r = ruleoftwo.classify({ task: 'fetch the webpage', description: 'then send an email to the customer' });
  assert.strictEqual(r.legs.untrustedInput, true);
  assert.strictEqual(r.legs.externalComms, true);
  assert.strictEqual(r.count, 2);
  assert.strictEqual(r.needsSplit, true);
});

t('null/undefined/number input never throws, treated as no legs held', () => {
  assert.strictEqual(ruleoftwo.classify(null).count, 0);
  assert.strictEqual(ruleoftwo.classify(undefined).count, 0);
  assert.strictEqual(ruleoftwo.classify(42).count, 0);
});

t('empty string input never throws, treated as no legs held', () => {
  const r = ruleoftwo.classify('');
  assert.strictEqual(r.count, 0);
  assert.strictEqual(r.sourceText, '');
});

t('opts.legPatterns overrides the built-in patterns for hermetic/targeted tests', () => {
  const customPatterns = {
    untrustedInput: /banana/i,
    privateData: /LEG_PATTERNS/,
    externalComms: /LEG_PATTERNS/,
  };
  const r = ruleoftwo.classify('please process the banana shipment', { legPatterns: customPatterns });
  assert.strictEqual(r.legs.untrustedInput, true);
  assert.strictEqual(r.legs.privateData, false);
});

t('module exports LEGS in canonical order', () => {
  assert.deepStrictEqual(ruleoftwo.LEGS, ['untrustedInput', 'privateData', 'externalComms']);
});

// ---------------------------------------------------------------------------
// 5) CLI — exit codes 0 (no split) / 3 (split recommended) / 2 (usage error), real spawned subprocess
// ---------------------------------------------------------------------------
console.log('\n5) CLI exit codes (real spawned subprocess)');

t('CLI classify on a benign task exits 0 and prints "no split needed"', () => {
  const r = runCLI(['classify', 'add a dark-mode toggle to the settings page']);
  assert.strictEqual(r.status, 0);
  assert.ok(r.stdout.includes('no split needed'));
});

t('CLI classify on a 3-leg trifecta task exits 3 and prints "SPLIT RECOMMENDED"', () => {
  const task = 'fetch the webpage from the incoming customer email, look up their customer data in the database, then send an email reply to the customer';
  const r = runCLI(['classify', task]);
  assert.strictEqual(r.status, 3);
  assert.ok(r.stdout.includes('SPLIT RECOMMENDED'));
});

t('CLI classify --json prints a parseable result object matching the module API', () => {
  const task = 'fetch the webpage and send an email with a summary of it';
  const r = runCLI(['classify', task, '--json']);
  assert.strictEqual(r.status, 3);
  const parsed = JSON.parse(r.stdout.trim());
  assert.strictEqual(parsed.needsSplit, true);
  assert.strictEqual(parsed.plan_then_execute, true);
  assert.strictEqual(parsed.capability_split.length, 2);
});

t('CLI classify with an empty-string task text still runs (0 legs) and exits 0', () => {
  const r = runCLI(['classify', '']);
  assert.strictEqual(r.status, 0);
});

t('CLI with no command exits 2 (usage error)', () => {
  const r = runCLI([]);
  assert.strictEqual(r.status, 2);
});

t('CLI with an unknown command exits 2 (usage error), not a silent pass', () => {
  const r = runCLI(['bogus-command']);
  assert.strictEqual(r.status, 2);
});

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
