#!/usr/bin/env node
'use strict';
// forge-env-names.test.cjs — WP-K1 (2026-09-27). Unit + CLI coverage for the new forge-env-names.cjs helper:
// the sanctioned replacement for secret-print's removed grep -o/--only-matching exemption (see
// hard-gates.json's secret-print gate and forge-gate-secretprint.test.cjs for the gate-level proof that this
// helper's own command line never trips the gate). This file proves the PARSING logic in isolation: it must
// print variable NAMES only, never a value, even on a malformed or hostile line.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const envNames = require('./forge-env-names.cjs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); }
}

console.log('forge-env-names tests (WP-K1: names-only dotenv reader, secret-print\'s sanctioned safe variant)');

// ---------------------------------------------------------------------------
// 1) envNames() — parsing
// ---------------------------------------------------------------------------
console.log('\n1) envNames() parsing');

t('extracts plain KEY=value names, ignoring the values entirely', () => {
  const text = 'DATABASE_URL=postgres://user:pass@host/db\nAPI_KEY=sk-super-secret';
  assert.deepStrictEqual(envNames.envNames(text), ['DATABASE_URL', 'API_KEY']);
});
t('handles export KEY=value', () => {
  assert.deepStrictEqual(envNames.envNames('export FOO=bar'), ['FOO']);
});
t('skips comment lines and blank lines', () => {
  assert.deepStrictEqual(envNames.envNames('# a comment\n\nFOO=bar\n  # indented comment\n'), ['FOO']);
});
t('allows leading whitespace before a real assignment', () => {
  assert.deepStrictEqual(envNames.envNames('   SPACED = value with spaces'), ['SPACED']);
});
t('skips a line with no "=" entirely — nothing of it is printed', () => {
  assert.deepStrictEqual(envNames.envNames('not a valid line at all'), []);
});
t('skips a key that is not a valid identifier (leading digit, embedded dash) — no partial name leaks', () => {
  assert.deepStrictEqual(envNames.envNames('123BAD=nope\nKEY-WITH-DASH=nope'), []);
});
t('skips a line with no key before "="', () => {
  assert.deepStrictEqual(envNames.envNames('=novalue'), []);
});
t('never includes any character from the value side, even one that looks like a key', () => {
  const text = 'REAL_KEY=FAKE_KEY_LOOKALIKE=still-just-a-value';
  const names = envNames.envNames(text);
  assert.deepStrictEqual(names, ['REAL_KEY']);
  assert.ok(!names.includes('FAKE_KEY_LOOKALIKE'));
});
t('handles CRLF, LF and lone CR line endings the same way', () => {
  assert.deepStrictEqual(envNames.envNames('A=1\r\nB=2\nC=3\r'), ['A', 'B', 'C']);
});
t('duplicate keys are kept in order, not deduplicated or reordered', () => {
  assert.deepStrictEqual(envNames.envNames('A=1\nB=2\nA=3'), ['A', 'B', 'A']);
});
t('an empty file yields an empty list, not an error', () => {
  assert.deepStrictEqual(envNames.envNames(''), []);
});

// ---------------------------------------------------------------------------
// 1b) WP-M1 (2026-09-27, independent review R5) — a multi-line quoted value must never leak a
//     continuation-line fragment as if it were a second variable name.
// ---------------------------------------------------------------------------
console.log('\n1b) WP-M1 R5 — multi-line quoted value continuation lines are never read as new entries');

t('a multi-line double-quoted PEM-style value prints exactly the one real key, no fragment of the value', () => {
  const text = ['PRIVATE_KEY="-----BEGIN KEY-----', 'abc', 'Kx9Qp3==', '-----END KEY-----"'].join('\n');
  assert.deepStrictEqual(envNames.envNames(text), ['PRIVATE_KEY']);
});
t('a real entry AFTER the closing quote of a multi-line value is still read normally', () => {
  const text = ['PRIVATE_KEY="-----BEGIN KEY-----', 'Kx9Qp3==', '-----END KEY-----"', 'NEXT_ONE=value'].join('\n');
  assert.deepStrictEqual(envNames.envNames(text), ['PRIVATE_KEY', 'NEXT_ONE']);
});
t('a multi-line single-quoted value is tracked the same way as double-quoted', () => {
  const text = ["MULTI='line one", "AB12==", "line three'"].join('\n');
  assert.deepStrictEqual(envNames.envNames(text), ['MULTI']);
});
t('an UNTERMINATED multi-line quote prints nothing after the key name that opened it, and never crashes', () => {
  const text = ['FIRST=ok', 'BROKEN="unterminated value', 'API_KEY=fake-looking-line', 'ANOTHER_KEY=also-hidden'].join('\n');
  assert.deepStrictEqual(envNames.envNames(text), ['FIRST', 'BROKEN']);
});
t('a single-line quoted value that opens and closes on the same line is unaffected (no false multi-line state)', () => {
  assert.deepStrictEqual(envNames.envNames('FOO="bar"\nBAZ=qux'), ['FOO', 'BAZ']);
  assert.deepStrictEqual(envNames.envNames("FOO='bar'\nBAZ=qux"), ['FOO', 'BAZ']);
});

// ---------------------------------------------------------------------------
// 1c) WP-M2 (2026-09-27, Codex stop-gate review of WP-M1 finding 3) — quote tracking must be ESCAPE-AWARE: a
//     `\"` inside a double-quoted value is not a real closer, on EITHER the opening line or a continuation
//     line, and a single-quoted value still has no escape character at all (unaffected by this fix).
// ---------------------------------------------------------------------------
console.log('\n1c) WP-M2 — escape-aware quote tracking (an escaped \\" never closes a double-quoted value)');

t('a continuation line that only MENTIONS an escaped quote does not end tracking early (real leak repro)', () => {
  const text = ['PRIVATE_KEY="-----BEGIN KEY-----', 'some \\"escaped\\" quote here', 'API_KEY=fake-looking-line', '-----END KEY-----"'].join('\n');
  const names = envNames.envNames(text);
  assert.deepStrictEqual(names, ['PRIVATE_KEY']);
  assert.ok(!names.includes('API_KEY'), 'a fragment of the still-open value leaked as a fake key name');
});
t('an escaped quote on the OPENING line does not make the value look already-closed (mirror-image repro)', () => {
  const text = ['KEY="a \\"b', 'FRAGMENT=c"', 'NAME=value'].join('\n');
  const names = envNames.envNames(text);
  assert.deepStrictEqual(names, ['KEY', 'NAME']);
  assert.ok(!names.includes('FRAGMENT'), 'a fragment of the still-open value leaked as a fake key name');
});
t('a real unescaped closer on the SAME line as an earlier escaped quote still closes normally', () => {
  assert.deepStrictEqual(envNames.envNames('KEY="say \\"hi\\" now"\nNEXT=ok'), ['KEY', 'NEXT']);
});
t('a real unescaped closer on a LATER line, after an earlier escaped quote on that same line, still closes', () => {
  const text = ['KEY="a \\"quoted\\" word, then', 'a real close"', 'NEXT=ok'].join('\n');
  assert.deepStrictEqual(envNames.envNames(text), ['KEY', 'NEXT']);
});
t('single-quoted values are unaffected — no escape character exists there at all, still plain non-escape-aware tracking', () => {
  const text = ["KEY='line one \\ backslash", "line two'", 'NEXT=ok'].join('\n');
  assert.deepStrictEqual(envNames.envNames(text), ['KEY', 'NEXT']);
});
t('hasUnescapedQuote() is exported and escape-aware for double quotes, plain (no escaping) for single quotes', () => {
  assert.strictEqual(envNames.hasUnescapedQuote('a \\"b', '"'), false, 'an escaped double quote is not a real closer');
  assert.strictEqual(envNames.hasUnescapedQuote('a \\\\"b', '"'), true, '\\\\ is a literal backslash, so the quote right after it IS real');
  assert.strictEqual(envNames.hasUnescapedQuote('a "b', '"'), true, 'an unescaped double quote is a real closer');
  assert.strictEqual(envNames.hasUnescapedQuote("a \\'b", "'"), true, 'single quotes have no escape character at all');
});

// ---------------------------------------------------------------------------
// 2) run() — in-process CLI behaviour
// ---------------------------------------------------------------------------
console.log('\n2) run() CLI behaviour (in-process, captured console output)');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-env-names-'));
const ENV_FILE = path.join(TMP, 'sample.env');
fs.writeFileSync(ENV_FILE, 'DATABASE_URL=postgres://user:pass@host/db\nexport API_KEY=sk-secret\n');

function captureRun(argv) {
  const outLines = [];
  const errLines = [];
  const origLog = console.log, origErr = console.error;
  console.log = (...a) => outLines.push(a.join(' '));
  console.error = (...a) => errLines.push(a.join(' '));
  let code;
  try { code = envNames.run(argv); } finally { console.log = origLog; console.error = origErr; }
  return { code, out: outLines, err: errLines };
}

t('prints one name per line for a real file', () => {
  const r = captureRun([ENV_FILE]);
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(r.out, ['DATABASE_URL', 'API_KEY']);
  for (const line of r.out) assert.ok(!/secret|pass|postgres/i.test(line), 'a value leaked: ' + line);
});
t('--json prints a single JSON array line, values never included', () => {
  const r = captureRun([ENV_FILE, '--json']);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.out.length, 1);
  assert.deepStrictEqual(JSON.parse(r.out[0]), ['DATABASE_URL', 'API_KEY']);
});
t('a missing file is reported honestly on stderr and exits non-zero, never throws', () => {
  const r = captureRun([path.join(TMP, 'does-not-exist.env')]);
  assert.strictEqual(r.code, 2);
  assert.ok(r.err.some((l) => l.includes('cannot read')), r.err.join('\n'));
});
t('no arguments prints usage and exits non-zero', () => {
  const r = captureRun([]);
  assert.strictEqual(r.code, 2);
  assert.ok(r.err.some((l) => l.includes('Usage')), r.err.join('\n'));
});
t('too many positional arguments is a usage error, not a silent pick-first', () => {
  const r = captureRun([ENV_FILE, 'extra-arg']);
  assert.strictEqual(r.code, 2);
});

// ---------------------------------------------------------------------------
// 3) real spawned CLI process — exit codes and stdout/stderr as an external caller would see them
// ---------------------------------------------------------------------------
console.log('\n3) real spawned CLI process');

const SCRIPT = path.join(__dirname, 'forge-env-names.cjs');
function spawnCli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 10000 });
}
t('spawned: prints names and exits 0', () => {
  const r = spawnCli([ENV_FILE]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), 'DATABASE_URL\nAPI_KEY');
});
t('spawned: --json exits 0 with a parseable array', () => {
  const r = spawnCli([ENV_FILE, '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), ['DATABASE_URL', 'API_KEY']);
});
t('spawned: a missing file exits non-zero with a message on stderr, not a stack trace', () => {
  const r = spawnCli([path.join(TMP, 'nope.env')]);
  assert.notStrictEqual(r.status, 0);
  assert.ok(r.stderr.includes('cannot read'), r.stderr);
  assert.ok(!r.stderr.includes('at Object.'), 'looks like a raw stack trace leaked: ' + r.stderr);
});

fs.rmSync(TMP, { recursive: true, force: true });

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
