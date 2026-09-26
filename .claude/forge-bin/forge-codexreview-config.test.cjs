#!/usr/bin/env node
'use strict';
/**
 * forge-codexreview-config.test.cjs — unit tests for the shipped+user Codex-config merge itself
 * (WP-S10, 2026-09-26; hardened WP-S14, 2026-09-26 independent review finding 3.1). forge-codexreview.
 * test.cjs already exercises this module end-to-end against the real shipped codex-review.json; this
 * file covers the module's own merge/build/label functions in isolation with fully synthetic fixtures,
 * independent of the real shipped file's exact content.
 *
 * WP-S14 3.1: the user file (`codex-review.user.json`, gitignored, never reviewed) used to win on EVERY
 * field of EVERY section. It may now override ONLY review.model and review.reasoning_effort, both
 * validated; the sandbox is hard-coded read-only in buildCommand(); buildCommand() returns an argv ARRAY,
 * never a shell string.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const CR = require(path.join(__dirname, 'forge-codexreview-config.cjs'));
const CLI = path.join(__dirname, 'forge-codexreview-config.cjs');

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

t('effectiveConfig() with only a shipped file: user_present is false, values are the shipped ones, no warnings', () => {
  const root = freshRoot(MINIMAL_SHIPPED);
  const eff = CR.effectiveConfig(root);
  assert.strictEqual(eff._source.user_present, false);
  assert.strictEqual(eff.review.model, null);
  assert.strictEqual(eff.review.sandbox, 'read-only');
  assert.strictEqual(eff.naming.step_label, 'Codex code-review');
  assert.deepStrictEqual(eff._warnings, []);
  fs.rmSync(root, { recursive: true, force: true });
});

t('effectiveConfig() merges a VALID user override field-by-field WITHIN the review section, no warnings', () => {
  const root = freshRoot(MINIMAL_SHIPPED, { review: { model: 'm1', reasoning_effort: 'high' } });
  const eff = CR.effectiveConfig(root);
  assert.strictEqual(eff.review.model, 'm1');
  assert.strictEqual(eff.review.reasoning_effort, 'high');
  assert.strictEqual(eff.review.sandbox, 'read-only', 'sandbox must survive from the shipped default');
  assert.strictEqual(eff.review.engine, 'codex', 'engine must survive from the shipped default');
  assert.deepStrictEqual(eff._warnings, []);
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

// --- WP-S14 3.1: the user file may ONLY override review.model / review.reasoning_effort ---

t('3.1: a user override of a NON-review section (naming) is IGNORED, with a warning — sections other than review can never be overridden', () => {
  const root = freshRoot(MINIMAL_SHIPPED, { naming: { step_label: 'Custom label' } });
  const eff = CR.effectiveConfig(root);
  assert.strictEqual(eff.naming.step_label, 'Codex code-review', 'the shipped naming must survive untouched');
  assert.ok(eff._warnings.some((w) => /naming/.test(w)), 'expected a visible warning naming the ignored section: ' + JSON.stringify(eff._warnings));
  fs.rmSync(root, { recursive: true, force: true });
});

t('3.1: honesty.never_claim_model_that_did_not_run can NEVER be overridden by the user file', () => {
  const root = freshRoot(MINIMAL_SHIPPED, { honesty: { never_claim_model_that_did_not_run: false } });
  const eff = CR.effectiveConfig(root);
  assert.strictEqual(eff.honesty.never_claim_model_that_did_not_run, true, 'the safety flag must survive from the shipped file, unweakened');
  assert.ok(eff._warnings.some((w) => /honesty/.test(w)));
  fs.rmSync(root, { recursive: true, force: true });
});

t('3.1: a user override of review.sandbox is IGNORED with a warning — the shipped sandbox value survives in the effective config', () => {
  const root = freshRoot(MINIMAL_SHIPPED, { review: { sandbox: 'danger-full-access' } });
  const eff = CR.effectiveConfig(root);
  assert.strictEqual(eff.review.sandbox, 'read-only', 'the effective config must keep the shipped sandbox, never the user override');
  assert.ok(eff._warnings.some((w) => /sandbox/.test(w)));
  fs.rmSync(root, { recursive: true, force: true });
});

t('3.1: buildCommand() is hard-coded read-only regardless of ANY config value — a "danger-full-access" user override still yields -s read-only', () => {
  const root = freshRoot(MINIMAL_SHIPPED, { review: { sandbox: 'danger-full-access', model: 'ok-model' } });
  const eff = CR.effectiveConfig(root);
  const argv = CR.buildCommand(eff, {});
  assert.strictEqual(argv[argv.indexOf('-s') + 1], 'read-only', 'the sandbox flag must always be read-only: ' + JSON.stringify(argv));
  assert.ok(argv.includes('ok-model'), 'the valid model override must still apply: ' + JSON.stringify(argv));
  fs.rmSync(root, { recursive: true, force: true });
});

t('3.1: a model string containing a space and an extra flag is REJECTED, not passed through', () => {
  const root = freshRoot(MINIMAL_SHIPPED, { review: { model: 'gpt-5 --dangerously-bypass-approvals-and-sandbox' } });
  const eff = CR.effectiveConfig(root);
  assert.strictEqual(eff.review.model, null, 'an invalid model must fall back to the shipped value (null here)');
  assert.ok(eff._warnings.some((w) => /review\.model/.test(w)));
  const argv = CR.buildCommand(eff, {});
  assert.ok(!argv.includes('-m'), 'no -m flag may be emitted for a rejected model: ' + JSON.stringify(argv));
  assert.ok(!argv.some((a) => /dangerously-bypass/.test(a)), 'the smuggled flag must never appear in argv: ' + JSON.stringify(argv));
  fs.rmSync(root, { recursive: true, force: true });
});

t('3.1: an invalid reasoning_effort is REJECTED and falls back to the shipped value', () => {
  const root = freshRoot(MINIMAL_SHIPPED, { review: { reasoning_effort: 'ultra-mega-plus' } });
  const eff = CR.effectiveConfig(root);
  assert.strictEqual(eff.review.reasoning_effort, null);
  assert.ok(eff._warnings.some((w) => /reasoning_effort/.test(w)));
  fs.rmSync(root, { recursive: true, force: true });
});

t('3.1: a VALID model+effort pin still applies (the override is not blanket-rejected, only invalid/out-of-scope pieces are)', () => {
  const root = freshRoot(MINIMAL_SHIPPED, { review: { model: 'gpt-6-astra', reasoning_effort: 'xhigh' } });
  const eff = CR.effectiveConfig(root);
  assert.strictEqual(eff.review.model, 'gpt-6-astra');
  assert.strictEqual(eff.review.reasoning_effort, 'xhigh');
  assert.deepStrictEqual(eff._warnings, [], 'a fully valid, in-scope override must not warn about anything');
  fs.rmSync(root, { recursive: true, force: true });
});

t('3.1: every allowed reasoning_effort value is accepted', () => {
  for (const effort of CR.ALLOWED_EFFORTS) {
    const root = freshRoot(MINIMAL_SHIPPED, { review: { reasoning_effort: effort } });
    const eff = CR.effectiveConfig(root);
    assert.strictEqual(eff.review.reasoning_effort, effort, 'expected ' + effort + ' to be accepted');
    fs.rmSync(root, { recursive: true, force: true });
  }
});

t('3.1: MODEL_PATTERN rejects whitespace and accepts the normal id alphabet', () => {
  assert.ok(CR.MODEL_PATTERN.test('gpt-6-astra'));
  assert.ok(CR.MODEL_PATTERN.test('claude-opus-4.8_v2:latest'));
  assert.ok(!CR.MODEL_PATTERN.test('has a space'));
  assert.ok(!CR.MODEL_PATTERN.test(''));
});

// --- N3 (2026-09-26 independent review, LOW): MODEL_PATTERN must reject a value starting with '-' — a
//     leading dash makes the "model" look like a CLI flag once it lands after -m in argv. ---

t('N3: MODEL_PATTERN rejects a value that starts with "-" (the exact review example)', () => {
  assert.ok(!CR.MODEL_PATTERN.test('--dangerously-bypass-approvals-and-sandbox'), 'a long dangerous flag string must never match');
  assert.ok(!CR.MODEL_PATTERN.test('-x'), 'a short leading-dash value must never match either');
  assert.ok(!CR.MODEL_PATTERN.test('-'), 'a bare dash must never match');
});

t('N3: MODEL_PATTERN still accepts every character the normal id alphabet uses, just not leading', () => {
  assert.ok(CR.MODEL_PATTERN.test('gpt-6-astra'), 'a leading letter followed by dashes must still match');
  assert.ok(CR.MODEL_PATTERN.test('4o-mini'), 'a leading digit must still match');
  assert.ok(CR.MODEL_PATTERN.test('claude-opus-4.8_v2:latest'));
});

t('N3: a user review.model override starting with "-" is rejected end-to-end by effectiveConfig(), never reaches argv', () => {
  const root = freshRoot(MINIMAL_SHIPPED, { review: { model: '--dangerously-bypass-approvals-and-sandbox' } });
  const eff = CR.effectiveConfig(root);
  assert.strictEqual(eff.review.model, null, 'the leading-dash override must fall back to the shipped value (null here)');
  assert.ok(eff._warnings.some((w) => /review\.model/.test(w)));
  const argv = CR.buildCommand(eff, {});
  assert.ok(!argv.includes('-m'), 'no -m flag may be emitted for a rejected model: ' + JSON.stringify(argv));
  assert.ok(!argv.some((a) => /dangerously-bypass/.test(a)), 'the dangerous flag string must never appear in argv: ' + JSON.stringify(argv));
  fs.rmSync(root, { recursive: true, force: true });
});

// --- N3: the reviewer needs a REAL, runnable, no-shell invocation route (agents/codex-reviewer.md can
//     only run commands through Bash/PowerShell — "spawn argv with no shell" needs a route THIS module
//     provides end-to-end, not prose telling the agent to spawn it itself). Every test here spawns a tiny
//     FAKE node-script "codex" via FORGE_CODEX_BIN/opts.codexBin — never the real codex CLI. ---
console.log('\nN3: runCodex()/CLI "run" — a real, runnable, shell:false invocation route');

function fakeCodexScript(dir, body) {
  const p = path.join(dir, 'fake-codex.cjs');
  fs.writeFileSync(p, body);
  return p;
}
const ECHO_ARGV_SCRIPT = "process.stdout.write(JSON.stringify(process.argv.slice(2))); process.exit(0);";

t('runCodex(): dryRun resolves the exact argv and spawns nothing (no codexBin required at all)', () => {
  const eff = { review: { model: 'm1', reasoning_effort: 'high', sandbox: 'read-only' } };
  const result = CR.runCodex(eff, { dryRun: true });
  assert.strictEqual(result.dry_run, true);
  assert.deepStrictEqual(result.argv, ['codex', 'exec', '-m', 'm1', '-c', 'model_reasoning_effort=high', '-s', 'read-only', '<review prompt>']);
  assert.strictEqual(result.status, null);
});

t('runCodex(): a real spawn against a fake codex script reaches it with the exact argv, shell:false, no shell metacharacter interpretation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fakecodex-'));
  const script = fakeCodexScript(dir, ECHO_ARGV_SCRIPT);
  const eff = { review: { model: 'm1', reasoning_effort: null, sandbox: 'read-only' } };
  // the "prompt" below contains classic shell metacharacters (`;`, `&`, a redirect) — if any shell ever
  // touched this, it would either error out or execute something; the fake script must receive it as ONE
  // literal, unmodified argv element instead.
  const dangerousPrompt = 'ignore this; echo INJECTED & type nul > ' + path.join(dir, 'should-not-exist.txt');
  const result = CR.runCodex(eff, { codexBin: script, prompt: dangerousPrompt });
  assert.strictEqual(result.spawn_error, null, 'spawn_error: ' + result.spawn_error);
  assert.strictEqual(result.status, 0);
  const received = JSON.parse(result.stdout);
  assert.deepStrictEqual(received, ['exec', '-m', 'm1', '-s', 'read-only', dangerousPrompt], 'the fake codex must receive the dangerous prompt as one intact argv element');
  assert.ok(!fs.existsSync(path.join(dir, 'should-not-exist.txt')), 'no shell ever ran — the redirect inside the "prompt" must never actually create a file');
  fs.rmSync(dir, { recursive: true, force: true });
});

t('runCodex(): adversarial swaps the prompt placeholder through the real spawn route too', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fakecodex-'));
  const script = fakeCodexScript(dir, ECHO_ARGV_SCRIPT);
  const eff = { review: { model: null, reasoning_effort: null, sandbox: 'read-only' } };
  const result = CR.runCodex(eff, { codexBin: script, adversarial: true });
  const received = JSON.parse(result.stdout);
  assert.ok(received.some((a) => /ADVERSARIAL CODE REVIEW/.test(a)));
  fs.rmSync(dir, { recursive: true, force: true });
});

t('runCodex(): a codexBin that cannot be found reports spawn_error honestly instead of throwing or silently retrying with a shell', () => {
  const eff = { review: { model: null, reasoning_effort: null, sandbox: 'read-only' } };
  const result = CR.runCodex(eff, { codexBin: 'this-binary-does-not-exist-anywhere-12345' });
  assert.ok(result.spawn_error, 'expected a spawn_error to be reported');
  assert.strictEqual(result.status, -1);
});

t('resolveCodexBin() defaults to "codex" and honors FORGE_CODEX_BIN', () => {
  assert.strictEqual(CR.resolveCodexBin({ PATH: '' }, 'linux'), 'codex');
  assert.strictEqual(CR.resolveCodexBin({ PATH: '' }, 'win32'), 'codex');
  assert.strictEqual(CR.resolveCodexBin({ PATH: '', FORGE_CODEX_BIN: '/some/fake/path' }, 'win32'), '/some/fake/path');
  const saved = process.env.FORGE_CODEX_BIN;
  try {
    process.env.FORGE_CODEX_BIN = '/some/fake/path';
    assert.strictEqual(CR.resolveCodexBin(), '/some/fake/path');
  } finally {
    if (saved === undefined) delete process.env.FORGE_CODEX_BIN; else process.env.FORGE_CODEX_BIN = saved;
  }
});

t('resolveCodexBin() on Windows finds the npm shim\'s own codex.js next to codex.cmd (a shell:false spawn cannot start a .cmd)', () => {
  const npmDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-npm-'));
  fs.writeFileSync(path.join(npmDir, 'codex.cmd'), '@echo off');
  const binDir = path.join(npmDir, 'node_modules', '@openai', 'codex', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'codex.js'), '');
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-empty-'));
  // a Windows env object spells the key "Path"; the lookup must not depend on its casing
  assert.strictEqual(CR.resolveCodexBin({ Path: emptyDir + ';"' + npmDir + '"' }, 'win32'), path.join(binDir, 'codex.js'));
  // a codex.cmd without the npm package next to it is not guessed at
  const shimOnly = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-shim-'));
  fs.writeFileSync(path.join(shimOnly, 'codex.cmd'), '@echo off');
  assert.strictEqual(CR.resolveCodexBin({ PATH: shimOnly }, 'win32'), 'codex');
  // a real codex.exe earlier on PATH wins
  const exeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-exe-'));
  fs.writeFileSync(path.join(exeDir, 'codex.exe'), '');
  assert.strictEqual(CR.resolveCodexBin({ PATH: exeDir + ';' + npmDir }, 'win32'), path.join(exeDir, 'codex.exe'));
  // never on another platform
  assert.strictEqual(CR.resolveCodexBin({ PATH: npmDir }, 'linux'), 'codex');
  for (const d of [npmDir, emptyDir, shimOnly, exeDir]) fs.rmSync(d, { recursive: true, force: true });
});

t('runCodex(): a prompt starting with "-" is refused before anything is spawned (it would reach codex as an option)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fakecodex-'));
  const marker = path.join(dir, 'spawned.txt');
  const script = fakeCodexScript(dir, "require('fs').writeFileSync(" + JSON.stringify(marker) + ", 'x');");
  const eff = { review: { model: null, reasoning_effort: null, sandbox: 'read-only' } };
  for (const p of ['--dangerously-bypass-approvals-and-sandbox', '-s danger-full-access', '-']) {
    const result = CR.runCodex(eff, { codexBin: script, prompt: p });
    assert.ok(result.refused, 'expected a refusal for ' + JSON.stringify(p));
    assert.strictEqual(result.status, -1);
  }
  assert.ok(!fs.existsSync(marker), 'the fake codex must never have been started');
  // a normal prompt that merely CONTAINS a dash still runs
  const ok = CR.runCodex(eff, { codexBin: script, prompt: 'review the diff -- focus on auth' });
  assert.ok(!ok.refused);
  assert.strictEqual(ok.spawn_error, null, String(ok.spawn_error));
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- F7 (2026-09-26 independent review, LOW): spawnSync had no timeout at all; resolveCodexBin() also
// searched non-absolute PATH entries (cwd-dependent, unpredictable). ---

t('F7: runCodex() with a tiny opts.timeoutMs against a fake codex that sleeps longer reports timed_out honestly, never as success', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fakecodex-sleep-'));
  const script = fakeCodexScript(dir, "setTimeout(() => {}, 5000);"); // sleeps far longer than the timeout below
  const eff = { review: { model: null, reasoning_effort: null, sandbox: 'read-only' } };
  const start = Date.now();
  const result = CR.runCodex(eff, { codexBin: script, timeoutMs: 300 });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 4000, 'must not wait for the full 5s sleep — elapsed ' + elapsed + 'ms');
  assert.strictEqual(result.timed_out, true);
  assert.ok(result.spawn_error && /ETIMEDOUT/.test(result.spawn_error), 'spawn_error: ' + result.spawn_error);
  assert.notStrictEqual(result.status, 0, 'a timeout must never be reported as a successful (status 0) run');
  fs.rmSync(dir, { recursive: true, force: true });
});

t('F7: runCodex() without opts.timeoutMs still completes normally for a fast fake codex (the default 30-minute timeout never fires here)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fakecodex-fast-'));
  const script = fakeCodexScript(dir, ECHO_ARGV_SCRIPT);
  const eff = { review: { model: null, reasoning_effort: null, sandbox: 'read-only' } };
  const result = CR.runCodex(eff, { codexBin: script });
  assert.strictEqual(result.timed_out, false);
  assert.strictEqual(result.spawn_error, null);
  assert.strictEqual(result.status, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

t('F7: resolveCodexTimeoutMs() honors a positive-integer FORGE_CODEX_TIMEOUT_MS and ignores invalid values', () => {
  assert.strictEqual(CR.resolveCodexTimeoutMs({}), CR.DEFAULT_CODEX_TIMEOUT_MS, 'missing env falls back to the default');
  assert.strictEqual(CR.resolveCodexTimeoutMs({ FORGE_CODEX_TIMEOUT_MS: '5000' }), 5000);
  for (const bad of ['', '0', '-100', 'abc', '3.5', '  ', 'NaN']) {
    assert.strictEqual(CR.resolveCodexTimeoutMs({ FORGE_CODEX_TIMEOUT_MS: bad }), CR.DEFAULT_CODEX_TIMEOUT_MS, 'bad value ' + JSON.stringify(bad) + ' must fall back to the default');
  }
});

t('F7: runCodex() picks up FORGE_CODEX_TIMEOUT_MS from process.env when opts.timeoutMs is not given', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fakecodex-envtimeout-'));
  const script = fakeCodexScript(dir, "setTimeout(() => {}, 5000);");
  const eff = { review: { model: null, reasoning_effort: null, sandbox: 'read-only' } };
  const saved = process.env.FORGE_CODEX_TIMEOUT_MS;
  try {
    process.env.FORGE_CODEX_TIMEOUT_MS = '300';
    const start = Date.now();
    const result = CR.runCodex(eff, { codexBin: script });
    assert.ok(Date.now() - start < 4000);
    assert.strictEqual(result.timed_out, true);
  } finally {
    if (saved === undefined) delete process.env.FORGE_CODEX_TIMEOUT_MS; else process.env.FORGE_CODEX_TIMEOUT_MS = saved;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

t('F7: resolveCodexBin() on Windows skips a non-absolute (relative) PATH entry instead of resolving it against the cwd', () => {
  // a relative PATH entry named "." (or any bare relative name) must never be treated as a real directory
  // to search — only an absolute directory is ever searched.
  assert.strictEqual(CR.resolveCodexBin({ PATH: '.;relative\\dir;another' }, 'win32'), 'codex');
  // an absolute entry among relative ones still works
  const absDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-abs-'));
  fs.writeFileSync(path.join(absDir, 'codex.exe'), '');
  assert.strictEqual(CR.resolveCodexBin({ PATH: '.;' + absDir + ';relative\\dir' }, 'win32'), path.join(absDir, 'codex.exe'));
  fs.rmSync(absDir, { recursive: true, force: true });
});

t('CLI "run" without --prompt (and without --dry-run) exits 2 and never starts codex with the placeholder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fakecodex-'));
  const marker = path.join(dir, 'spawned.txt');
  const script = fakeCodexScript(dir, "require('fs').writeFileSync(" + JSON.stringify(marker) + ", 'x');");
  const r = spawnSync(process.execPath, [path.join(__dirname, 'forge-codexreview-config.cjs'), 'run'],
    { encoding: 'utf8', env: Object.assign({}, process.env, { FORGE_CODEX_BIN: script }) });
  assert.strictEqual(r.status, 2, r.stdout + r.stderr);
  assert.ok(/needs --prompt/.test(r.stderr), r.stderr);
  assert.ok(!fs.existsSync(marker), 'codex must not have been started');
  const r2 = spawnSync(process.execPath, [path.join(__dirname, 'forge-codexreview-config.cjs'), 'run', '--prompt', '--dangerously-bypass-approvals-and-sandbox'],
    { encoding: 'utf8', env: Object.assign({}, process.env, { FORGE_CODEX_BIN: script }) });
  assert.strictEqual(r2.status, 2, r2.stdout + r2.stderr);
  assert.ok(/refused/.test(r2.stderr), r2.stderr);
  assert.ok(!fs.existsSync(marker), 'codex must not have been started');
  fs.rmSync(dir, { recursive: true, force: true });
});

t('CLI "run --dry-run --json" prints the resolved argv without spawning anything, against the real shipped config', () => {
  const r = spawnSync(process.execPath, [CLI, 'run', '--dry-run', '--json'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, 'stderr: ' + r.stderr);
  const parsed = JSON.parse(r.stdout.trim());
  assert.strictEqual(parsed.dry_run, true);
  assert.ok(Array.isArray(parsed.argv) && parsed.argv[0] === 'codex' && parsed.argv[1] === 'exec');
});

t('CLI "run --json --prompt" against a fake FORGE_CODEX_BIN script actually runs it end-to-end, no shell', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fakecodex-cli-'));
  const script = fakeCodexScript(dir, ECHO_ARGV_SCRIPT);
  const env = Object.assign({}, process.env, { FORGE_CODEX_BIN: script });
  const r = spawnSync(process.execPath, [CLI, 'run', '--json', '--prompt', 'a real review prompt with spaces'], { encoding: 'utf8', env });
  assert.strictEqual(r.status, 0, 'stderr: ' + r.stderr);
  const parsed = JSON.parse(r.stdout.trim());
  assert.strictEqual(parsed.dry_run, false);
  assert.strictEqual(parsed.spawn_error, null);
  const received = JSON.parse(parsed.stdout);
  assert.ok(received.includes('a real review prompt with spaces'));
  fs.rmSync(dir, { recursive: true, force: true });
});

t('CLI "run" with an unresolvable FORGE_CODEX_BIN exits 2 and reports spawn_error, never silently falls back to a shell', () => {
  const env = Object.assign({}, process.env, { FORGE_CODEX_BIN: 'this-binary-does-not-exist-anywhere-12345' });
  const r = spawnSync(process.execPath, [CLI, 'run', '--json', '--prompt', 'review the staged diff'], { encoding: 'utf8', env });
  assert.strictEqual(r.status, 2);
  const parsed = JSON.parse(r.stdout.trim());
  assert.ok(parsed.spawn_error);
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

// --- buildCommand(): argv ARRAY contract (WP-S14 3.1) ---

t('buildCommand(): fully unpinned omits -m and -c, keeps -s read-only and the review prompt placeholder', () => {
  const eff = { review: { model: null, reasoning_effort: null, sandbox: 'read-only' } };
  const argv = CR.buildCommand(eff, {});
  assert.deepStrictEqual(argv, ['codex', 'exec', '-s', 'read-only', '<review prompt>']);
});

t('buildCommand(): model set, effort unset -> only -m, no -c', () => {
  const eff = { review: { model: 'm1', reasoning_effort: null, sandbox: 'read-only' } };
  const argv = CR.buildCommand(eff, {});
  assert.deepStrictEqual(argv, ['codex', 'exec', '-m', 'm1', '-s', 'read-only', '<review prompt>']);
});

t('buildCommand(): both set -> -m and -c in that order, sandbox after', () => {
  const eff = { review: { model: 'm1', reasoning_effort: 'xhigh', sandbox: 'read-only' } };
  const argv = CR.buildCommand(eff, {});
  assert.deepStrictEqual(argv, ['codex', 'exec', '-m', 'm1', '-c', 'model_reasoning_effort=xhigh', '-s', 'read-only', '<review prompt>']);
});

t('buildCommand(): adversarial swaps the prompt placeholder, keeps the same flags', () => {
  const eff = { review: { model: 'm1', reasoning_effort: 'xhigh', sandbox: 'read-only' } };
  const argv = CR.buildCommand(eff, { adversarial: true });
  assert.deepStrictEqual(argv, ['codex', 'exec', '-m', 'm1', '-c', 'model_reasoning_effort=xhigh', '-s', 'read-only', 'ADVERSARIAL CODE REVIEW. <focus>']);
});

t('buildCommand(): sandbox is ALWAYS read-only, whatever effective.review.sandbox says (hard-coded, never read from config)', () => {
  for (const bogus of [undefined, null, 'workspace-write', 'danger-full-access']) {
    const eff = { review: { model: null, reasoning_effort: null, sandbox: bogus } };
    const argv = CR.buildCommand(eff, {});
    assert.strictEqual(argv[argv.indexOf('-s') + 1], 'read-only', 'sandbox=' + bogus + ' -> ' + JSON.stringify(argv));
  }
});

t('buildCommand(): whitespace-only model/effort strings are treated as unset', () => {
  const eff = { review: { model: '   ', reasoning_effort: '\t', sandbox: 'read-only' } };
  const argv = CR.buildCommand(eff, {});
  assert.deepStrictEqual(argv, ['codex', 'exec', '-s', 'read-only', '<review prompt>']);
});

// --- F3 (2026-09-26 independent review, LOW): buildCommand() must re-validate the FINAL model/effort
// against MODEL_PATTERN/ALLOWED_EFFORTS regardless of which file they came from — the shipped file's own
// review.model/reasoning_effort (or one selected via `run --root <dir>`) used to reach buildCommand()
// unvalidated, so a "shipped" file could smuggle a value MODEL_PATTERN/ALLOWED_EFFORTS were built to
// reject (e.g. a leading-dash flag string, or an undocumented effort tier). ---

t('F3: buildCommand() omits -m when effective.review.model is an invalid/dangerous string, even though it did not come from the user override', () => {
  const eff = { review: { model: '--dangerously-bypass-approvals-and-sandbox', reasoning_effort: null, sandbox: 'read-only' } };
  const argv = CR.buildCommand(eff, {});
  assert.deepStrictEqual(argv, ['codex', 'exec', '-s', 'read-only', '<review prompt>'], JSON.stringify(argv));
  assert.ok(argv.indexOf('-m') === -1, 'must never include -m for an invalid model');
});

t('F3: buildCommand() omits -c when effective.review.reasoning_effort is not one of ALLOWED_EFFORTS, even though it did not come from the user override', () => {
  const eff = { review: { model: null, reasoning_effort: 'ultra', sandbox: 'read-only' } };
  const argv = CR.buildCommand(eff, {});
  assert.deepStrictEqual(argv, ['codex', 'exec', '-s', 'read-only', '<review prompt>'], JSON.stringify(argv));
  assert.ok(argv.indexOf('-c') === -1, 'must never include -c for an invalid effort');
});

t('F3: buildCommand() still passes through a VALID model/effort regardless of source (no regression)', () => {
  const eff = { review: { model: 'gpt-6-astra', reasoning_effort: 'xhigh', sandbox: 'read-only' } };
  const argv = CR.buildCommand(eff, {});
  assert.deepStrictEqual(argv, ['codex', 'exec', '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort=xhigh', '-s', 'read-only', '<review prompt>']);
});

t('F3: end-to-end — a shipped codex-review.json with a dangerous model/invalid effort yields argv with no -m/-c, via effectiveConfig()+buildCommand()', () => {
  const shipped = { review: { engine: 'codex', model: '--dangerously-bypass-approvals-and-sandbox', reasoning_effort: 'ultra', sandbox: 'read-only' }, naming: {}, fallback: {}, honesty: {} };
  const root = freshRoot(shipped);
  const eff = CR.effectiveConfig(root);
  const argv = CR.buildCommand(eff, {});
  assert.ok(argv.indexOf('-m') === -1, 'must never include -m for an invalid shipped model: ' + JSON.stringify(argv));
  assert.ok(argv.indexOf('-c') === -1, 'must never include -c for an invalid shipped effort: ' + JSON.stringify(argv));
  fs.rmSync(root, { recursive: true, force: true });
});

t('commandToDisplayString(): renders the argv array as a human-readable, quoted string — never re-executed', () => {
  const argv = ['codex', 'exec', '-m', 'm1', '-c', 'model_reasoning_effort=xhigh', '-s', 'read-only', '<review prompt>'];
  assert.strictEqual(CR.commandToDisplayString(argv), 'codex exec -m m1 -c model_reasoning_effort=xhigh -s read-only "<review prompt>"');
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
