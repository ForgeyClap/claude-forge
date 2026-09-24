#!/usr/bin/env node
'use strict';
/** Offline tests for usage-guard-redact.cjs — the credential/redaction boundary split out of
 *  usage-guard.cjs (wp-f4, 2026-09-24). No network, no real credential files. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const R = require('./usage-guard-redact.cjs');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error('  FAIL ' + name + ' — ' + e.message); } };

console.log('usage-guard-redact tests');

// ---- validateTokenShape ----
t('validateTokenShape: a plausible OAuth token passes', () => {
  assert.strictEqual(R.validateTokenShape('sk-ant-oat01-' + 'a'.repeat(40)), true);
});
t('validateTokenShape: an embedded newline (header-injection shape) is rejected', () => {
  assert.strictEqual(R.validateTokenShape('SYNTHETIC-OAUTH\nINJECTED'), false);
});
t('validateTokenShape: an embedded carriage return / tab / null byte is rejected', () => {
  assert.strictEqual(R.validateTokenShape('a\rb'), false);
  assert.strictEqual(R.validateTokenShape('a\tb'), false);
  assert.strictEqual(R.validateTokenShape('a\0b'), false);
});
t('validateTokenShape: non-string / empty / too-short / too-long values are rejected', () => {
  assert.strictEqual(R.validateTokenShape(undefined), false);
  assert.strictEqual(R.validateTokenShape(null), false);
  assert.strictEqual(R.validateTokenShape(42), false);
  assert.strictEqual(R.validateTokenShape(''), false);
  assert.strictEqual(R.validateTokenShape('short'), false);
  assert.strictEqual(R.validateTokenShape('x'.repeat(4097)), false);
});
t('validateTokenShape: a space (never a valid bearer token byte) is rejected', () => {
  assert.strictEqual(R.validateTokenShape('has a space in it 1234567890'), false);
});

// ---- transportErrorCode ----
t('transportErrorCode: a real Node error code wins and the message is never read', () => {
  const e = new Error('ECONNRESET: leaked-secret-fragment-should-never-appear');
  e.code = 'ECONNRESET';
  assert.strictEqual(R.transportErrorCode(e), 'ECONNRESET');
});
t('transportErrorCode: falls back to error name when there is no usable code', () => {
  const e = new TypeError('Headers.append: "Bearer SYNTHETIC-OAUTH\\nINJECTED" is an invalid header value.');
  assert.strictEqual(R.transportErrorCode(e), 'TypeError');
});
t('transportErrorCode: an unrecognizable error shape degrades to the fixed literal "Error"', () => {
  assert.strictEqual(R.transportErrorCode({}), 'Error');
  assert.strictEqual(R.transportErrorCode(null), 'Error');
  assert.strictEqual(R.transportErrorCode(undefined), 'Error');
  assert.strictEqual(R.transportErrorCode({ code: 'not shaped like a code!' }), 'Error');
  assert.strictEqual(R.transportErrorCode({ name: 'also not-shaped!' }), 'Error');
});
t('transportErrorCode: never returns e.message even when code/name are also present', () => {
  const e = new Error('sk-ant-oat01-REALSECRETSHOULDNEVERLEAK');
  e.code = 'EBADTOKEN';
  const out = R.transportErrorCode(e);
  assert.strictEqual(out, 'EBADTOKEN');
  assert.ok(!/sk-ant/.test(out));
});

// ---- resolveLocalAccountLabel ----
t('resolveLocalAccountLabel: a falsy/non-string fp returns null', () => {
  assert.strictEqual(R.resolveLocalAccountLabel(null), null);
  assert.strictEqual(R.resolveLocalAccountLabel(''), null);
  assert.strictEqual(R.resolveLocalAccountLabel(undefined), null);
  assert.strictEqual(R.resolveLocalAccountLabel(42), null);
});
t('resolveLocalAccountLabel: without a mapFile, returns a usable (unpersisted) opaque label', () => {
  const r = R.resolveLocalAccountLabel('deadbeefcafe');
  assert.ok(typeof r.label === 'string' && r.label.length > 0);
  assert.strictEqual(r.persisted, false);
  assert.ok(!r.label.includes('deadbeefcafe'), 'the label must not embed the raw fp');
});
t('resolveLocalAccountLabel: the SAME fp maps to the SAME label across calls (persisted mapping)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-redact-'));
  const mapFile = path.join(dir, 'account-map.json');
  try {
    const a1 = R.resolveLocalAccountLabel('aaaa11112222', { mapFile });
    const a2 = R.resolveLocalAccountLabel('aaaa11112222', { mapFile });
    assert.strictEqual(a1.label, a2.label);
    assert.strictEqual(a1.isNew, true);
    assert.strictEqual(a2.isNew, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
t('resolveLocalAccountLabel: two DIFFERENT fps map to two DIFFERENT labels', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-redact-'));
  const mapFile = path.join(dir, 'account-map.json');
  try {
    const a = R.resolveLocalAccountLabel('aaaa11112222', { mapFile });
    const b = R.resolveLocalAccountLabel('bbbb33334444', { mapFile });
    assert.notStrictEqual(a.label, b.label);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
t('resolveLocalAccountLabel: the label never contains the raw fp, and the mapping file DOES carry the fp (local-only, by design)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-redact-'));
  const mapFile = path.join(dir, 'account-map.json');
  try {
    const r = R.resolveLocalAccountLabel('cccc55556666', { mapFile });
    assert.ok(!r.label.includes('cccc55556666'));
    assert.ok(fs.readFileSync(mapFile, 'utf8').includes('cccc55556666'), 'the LOCAL mapping file is the one sanctioned place the fp may live');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
t('resolveLocalAccountLabel: an unwritable mapping file still returns a usable label (fail-safe, never throws)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-redact-'));
  try {
    // point mapFile at a path whose parent directory does not exist -> every write attempt fails
    const mapFile = path.join(dir, 'does-not-exist', 'account-map.json');
    const r = R.resolveLocalAccountLabel('dddd77778888', { mapFile });
    assert.ok(typeof r.label === 'string' && r.label.length > 0);
    assert.strictEqual(r.persisted, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
t('resolveLocalAccountLabel: a corrupt mapping file degrades to a fresh mapping rather than throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-redact-'));
  const mapFile = path.join(dir, 'account-map.json');
  try {
    fs.writeFileSync(mapFile, '{ not json');
    const r = R.resolveLocalAccountLabel('eeee99990000', { mapFile });
    assert.ok(typeof r.label === 'string' && r.label.length > 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
