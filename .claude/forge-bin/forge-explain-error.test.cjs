#!/usr/bin/env node
'use strict';
// forge-explain-error.test.cjs — real tests for the plain-language error explainer (Forge v2.9.0, WP-D).
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const EE = require('./forge-explain-error.cjs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

const CLI = path.join(__dirname, 'forge-explain-error.cjs');
function runCLI(argv) { return spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8' }); }

console.log('forge-explain-error tests (plain-language error explainer)');

// ---------------------------------------------------------------------------
// 1) shape / honesty — unrecognised input never fabricates a family
// ---------------------------------------------------------------------------
console.log('\n1) shape and honesty');

t('empty string is honestly unrecognised, never throws', () => {
  const r = EE.explainError('');
  assert.strictEqual(r.recognized, false);
  assert.strictEqual(r.family, null);
  assert.strictEqual(r.message, null);
  assert.strictEqual(r.nextStep, null);
});

t('null/undefined/non-string input never throws and is unrecognised', () => {
  for (const v of [null, undefined, 42, {}, []]) {
    const r = EE.explainError(v);
    assert.strictEqual(r.recognized, false);
    assert.strictEqual(typeof r.redactedInput, 'string');
  }
});

t('genuinely unknown text is unrecognised, not force-fit into a family', () => {
  const r = EE.explainError('something totally unrelated and made up xyz123');
  assert.strictEqual(r.recognized, false);
  assert.strictEqual(r.family, null);
  assert.strictEqual(r.category, null);
});

t('a recognised family always returns a bilingual message AND a bilingual next step', () => {
  const r = EE.explainError('spawn claude ENOENT');
  assert.strictEqual(r.recognized, true);
  assert.strictEqual(typeof r.message.nl, 'string');
  assert.strictEqual(typeof r.message.en, 'string');
  assert.strictEqual(typeof r.nextStep.nl, 'string');
  assert.strictEqual(typeof r.nextStep.en, 'string');
  assert.ok(r.message.nl.length > 0 && r.message.en.length > 0);
  assert.ok(r.nextStep.nl.length > 0 && r.nextStep.en.length > 0);
});

t('every declared family has non-empty bilingual message/nextStep text (no placeholder)', () => {
  for (const fam of EE.FAMILIES) {
    for (const field of ['message', 'nextStep']) {
      for (const lang of ['nl', 'en']) {
        const s = fam[field][lang];
        assert.strictEqual(typeof s, 'string', fam.id + '.' + field + '.' + lang + ' must be a string');
        assert.ok(s.trim().length >= 10, fam.id + '.' + field + '.' + lang + ' is too thin to be a real sentence');
      }
    }
  }
});

t('nextStep never reads like an instruction FOR THE USER to type a command (no imperative "run"/"type")', () => {
  const BAD_RE = /^(run |type |execute |use the following|please run)/i;
  for (const fam of EE.FAMILIES) {
    assert.ok(!BAD_RE.test(fam.nextStep.en.trim()), fam.id + ': nextStep.en reads like a user instruction: ' + fam.nextStep.en);
    assert.ok(/\bforge\b/i.test(fam.nextStep.en), fam.id + ': nextStep.en should name Forge as the actor');
  }
});

// ---------------------------------------------------------------------------
// 2) the ten required families (git counted once per shape) — one real, representative message each
// ---------------------------------------------------------------------------
console.log('\n2) the required error families');

const REQUIRED_FAMILY_CASES = [
  // [family id, a REAL representative message]
  ['command_not_found', "'claude' is not recognized as an internal or external command, operable program or batch file."],
  ['command_not_found', 'spawn claude ENOENT'],
  ['command_not_found', 'zsh: command not found: claude'],
  ['enoent_missing_file', "Error: ENOENT: no such file or directory, open 'C:\\proj\\x.json'"],
  ['permission_denied', "Error: EACCES: permission denied, open '.env'"],
  ['permission_denied', 'Access is denied.'],
  ['port_in_use', 'Error: listen EADDRINUSE: address already in use :::4100'],
  ['network_unreachable', 'Error: connect ECONNREFUSED 127.0.0.1:5432'],
  ['network_unreachable', 'Error: connect ETIMEDOUT'],
  ['npm_error', 'npm ERR! code ERESOLVE'],
  ['npm_error', "Error: Cannot find module 'lodash'"],
  ['git_not_a_repo', 'fatal: not a git repository (or any of the parent directories): .git'],
  ['git_merge_conflict', 'CONFLICT (content): Merge conflict in src/app.js'],
  ['git_merge_conflict', 'Automatic merge failed; fix conflicts and then commit the result.'],
  ['git_detached_head', "you are in 'detached HEAD' state"],
  ['git_detached_head', 'HEAD detached at a1b2c3d'],
  ['powershell_execution_policy', 'File C:\\x.ps1 cannot be loaded because running scripts is disabled on this system.'],
  ['usage_limit', 'Error: 429 Too Many Requests'],
  ['usage_limit', 'You have reached your usage limit for this period'],
  ['auth_invalid', 'Error: 401 Unauthorized'],
  ['auth_invalid', 'invalid_api_key: the key provided is not valid'],
];

for (const [family, text] of REQUIRED_FAMILY_CASES) {
  t('family [' + family + '] recognises: "' + text.slice(0, 50) + '"', () => {
    const r = EE.explainError(text);
    assert.strictEqual(r.recognized, true, 'expected a match, got unrecognised');
    assert.strictEqual(r.family, family);
  });
}

t('every family id used above is a real, declared family (no typo in the test itself)', () => {
  const known = new Set(EE.FAMILIES.map((f) => f.id));
  for (const [family] of REQUIRED_FAMILY_CASES) assert.ok(known.has(family), family + ' is not in FAMILIES');
});

t('all ten required categories from the work package are covered by at least one family', () => {
  const categories = new Set(EE.FAMILIES.map((f) => f.category));
  for (const c of ['path', 'filesystem', 'network', 'dependencies', 'git', 'shell', 'claude', 'auth']) {
    assert.ok(categories.has(c), 'missing category: ' + c);
  }
});

// ---------------------------------------------------------------------------
// 2b) priority — the most specific family wins when a message could plausibly match more than one
// ---------------------------------------------------------------------------
console.log('\n2b) family priority (most specific match wins)');

t('a spawn ENOENT for a missing PROGRAM is command_not_found, never generic enoent_missing_file', () => {
  const r = EE.explainError('Error: spawn git ENOENT');
  assert.strictEqual(r.family, 'command_not_found');
});

t('a plain file-path ENOENT (no "spawn") is enoent_missing_file', () => {
  const r = EE.explainError("Error: ENOENT: no such file or directory, open '/tmp/x.json'");
  assert.strictEqual(r.family, 'enoent_missing_file');
});

// ---------------------------------------------------------------------------
// 3) redaction — never echo secrets
// ---------------------------------------------------------------------------
console.log('\n3) redaction — token-shaped runs are masked before they are ever returned');

t('a Bearer token is redacted out of the returned text', () => {
  const r = EE.explainError('Error: 401 Unauthorized — Bearer sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF rejected');
  assert.ok(!r.redactedInput.includes('abcdefghijklmnopqrstuvwxyz'), 'the token body leaked into redactedInput');
  // v2.9.0 F10 follow-up (WP-L1): redact() now delegates to forge-store.cjs's redactText(), whose own marker
  // is '***REDACTED***' (store's SECRET_PATTERNS sk- rule catches this token before this file's own nets run).
  assert.ok(r.redactedInput.includes('***REDACTED***'));
  assert.strictEqual(r.inputRedacted, true);
});

t('a key=value secret pair keeps the field name but masks the value', () => {
  const r = EE.explainError('token=abcd1234efgh5678 invalid_token');
  assert.ok(r.redactedInput.startsWith('token=***REDACTED***'), r.redactedInput);
  assert.ok(!r.redactedInput.includes('abcd1234efgh5678'));
});

// v2.9.0 WP-K2 (Codex F10): `\b` never matched inside "client_secret" ("_" and "s" are both \w, so there is
// no boundary between them) — the redactor silently let the value through. Exact reported input: `401
// client_secret=abc123` (also exercises the auth_invalid family via the "401" text).
t('F10: "client_secret=abc123" is redacted (the "_" no longer breaks the key match)', () => {
  const r = EE.explainError('401 client_secret=abc123');
  assert.strictEqual(r.recognized, true);
  assert.strictEqual(r.family, 'auth_invalid');
  assert.ok(!r.redactedInput.includes('abc123'), r.redactedInput);
  assert.ok(r.redactedInput.includes('client_secret=***REDACTED***'), r.redactedInput);
});

t('F10: --json output also carries the fixed redaction (no raw secret in the CLI JSON payload)', () => {
  const r = runCLI(['401 client_secret=abc123', '--json']);
  assert.strictEqual(r.status, 0, 'stdout=' + r.stdout + ' stderr=' + r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.ok(!parsed.redactedInput.includes('abc123'), parsed.redactedInput);
  assert.ok(parsed.redactedInput.includes('client_secret=***REDACTED***'), parsed.redactedInput);
});

// v2.9.0 independent review F10 follow-up (WP-L1, 2026-09-27): the pre-fix regex stopped at the first
// whitespace/quote/comma, so a quoted MULTI-WORD value only had its first word masked — exact reported
// input: `client_secret="correct horse battery staple"` became
// `client_secret="[REDACTED] horse battery staple"`, leaking the rest of the passphrase. Without the fix
// (delegating to forge-store.cjs's redactText(), which redacts a quoted value in full) the assertion below
// fails because redactedInput still contains "horse battery staple".
t('F10 follow-up: a quoted MULTI-WORD value is redacted in full, not just its first word', () => {
  const r = EE.explainError('client_secret="correct horse battery staple"');
  assert.ok(!r.redactedInput.includes('correct'), r.redactedInput);
  assert.ok(!r.redactedInput.includes('horse battery staple'), r.redactedInput);
  assert.strictEqual(r.redactedInput, 'client_secret="***REDACTED***"', r.redactedInput);
});

// The zero-dependency fallback (used only when forge-store.cjs cannot be loaded) gets the same exact input,
// tested directly against fallbackKeyValueRedact() rather than by breaking the real require() — same reason
// this project exports internal helpers like hasUnresolvedVarLeadWord for direct unit testing elsewhere.
t('F10 follow-up: the zero-dependency fallback also redacts the same quoted multi-word value in full', () => {
  const out = EE.fallbackKeyValueRedact('client_secret="correct horse battery staple"');
  assert.ok(!out.includes('correct'), out);
  assert.ok(!out.includes('horse battery staple'), out);
  assert.strictEqual(out, 'client_secret="[REDACTED]"', out);
});
t('F10 follow-up: the fallback also handles a single-quoted multi-word value and an unterminated quote', () => {
  assert.strictEqual(EE.fallbackKeyValueRedact("password='correct horse battery staple'"), "password='[REDACTED]'");
  assert.strictEqual(EE.fallbackKeyValueRedact('password="unterminated value to end of line'), 'password="[REDACTED]');
});

t('a long token-safe run with no known prefix is still masked (defensive net)', () => {
  const r = EE.explainError('unexpected value: ' + 'Q'.repeat(40));
  assert.ok(!r.redactedInput.includes('Q'.repeat(40)));
  assert.ok(r.redactedInput.includes('[REDACTED]'));
});

t('ordinary text with no secret-shaped content is left byte-for-byte unchanged', () => {
  const s = 'plain text with no secrets at all, just a normal sentence';
  const r = EE.explainError(s);
  assert.strictEqual(r.redactedInput, s);
  assert.strictEqual(r.inputRedacted, false);
});

t('redactedInput is populated even for UNRECOGNISED input (never skipped)', () => {
  const r = EE.explainError('unknown error ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
  assert.strictEqual(r.recognized, false);
  assert.ok(!r.redactedInput.includes('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'));
});

t('redact() is exported directly and never throws on non-string input', () => {
  assert.strictEqual(EE.redact(null), '');
  assert.strictEqual(EE.redact(undefined), '');
  assert.strictEqual(typeof EE.redact('x'), 'string');
});

// ---------------------------------------------------------------------------
// 4) CLI — real spawned subprocess, exit codes and both output modes
// ---------------------------------------------------------------------------
console.log('\n4) CLI — exit codes and output modes (real spawned subprocess)');

t('CLI with no args prints usage and exits 2', () => {
  const r = runCLI([]);
  assert.strictEqual(r.status, 2);
  assert.ok(/Usage:/.test(r.stderr));
});

t('CLI recognised case exits 0 and prints both languages by default', () => {
  const r = runCLI(['spawn claude ENOENT']);
  assert.strictEqual(r.status, 0);
  assert.ok(r.stdout.includes('FORGE [command_not_found]:'));
  assert.ok(/PATH/.test(r.stdout) && /geïnstalleerd/.test(r.stdout), 'expected both an English and a Dutch line');
});

t('CLI --lang en prints only English', () => {
  const r = runCLI(['spawn claude ENOENT', '--lang', 'en']);
  assert.strictEqual(r.status, 0);
  assert.ok(!/geïnstalleerd/.test(r.stdout), 'a NL-only line leaked in with --lang en');
});

t('CLI --lang nl prints only Dutch', () => {
  const r = runCLI(['spawn claude ENOENT', '--lang', 'nl']);
  assert.strictEqual(r.status, 0);
  assert.ok(!/\bwas not found\b/.test(r.stdout), 'an EN-only phrase leaked in with --lang nl');
});

t('CLI --json prints a single parseable JSON object with the full shape', () => {
  const r = runCLI(['spawn claude ENOENT', '--json']);
  assert.strictEqual(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  assert.strictEqual(parsed.recognized, true);
  assert.strictEqual(parsed.family, 'command_not_found');
  assert.ok(parsed.message && parsed.nextStep);
});

t('CLI unrecognised input exits 1 (visible, not a tool crash) with a bilingual honest notice', () => {
  const r = runCLI(['totally unrecognised gibberish xyz']);
  assert.strictEqual(r.status, 1);
  assert.ok(/niet herkend/.test(r.stdout) && /not identified/.test(r.stdout));
});

t('CLI never crashes (exit code is always 0/1/2, never an uncaught exception)', () => {
  const r = runCLI(['Bearer sk-ant-oat01-' + 'x'.repeat(60)]);
  assert.ok([0, 1, 2].includes(r.status));
  assert.strictEqual(r.stderr, '');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
