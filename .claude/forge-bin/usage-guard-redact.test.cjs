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

// ---- GUARD-ACCOUNT-STABILITY (Codex recheck wp-f4 V14, 2026-09-24): a PERSISTENTLY failing map (read
// failure, write failure, rename failure) must return the SAME label on every call, never a fresh random
// one — usage-guard.cjs's tick() treats any label change as an account switch and discards its
// measurement, so a churning label under sustained failure could indefinitely suppress a real pause.
t('V14: a mapFile whose read AND write both fail (missing parent dir) still returns the SAME label across repeated calls', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-redact-v14-'));
  try {
    const mapFile = path.join(dir, 'does-not-exist', 'account-map.json'); // read: ENOENT; write: ENOENT (no parent)
    const a = R.resolveLocalAccountLabel('v14aaaa0000', { mapFile });
    const b = R.resolveLocalAccountLabel('v14aaaa0000', { mapFile });
    const c = R.resolveLocalAccountLabel('v14aaaa0000', { mapFile });
    assert.strictEqual(a.persisted, false);
    assert.strictEqual(a.label, b.label, 'label must not change between calls under a sustained read/write failure: ' + JSON.stringify([a, b]));
    assert.strictEqual(b.label, c.label);
    assert.ok(!/^account-\d/.test(a.label), 'a never-persisted label must not look like a real persisted "account-N-hex" label: ' + a.label);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
t('V14: a mapFile that IS a directory (read fails EISDIR; the tmp write succeeds but the publishing rename fails) still returns the SAME label across repeated calls', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-redact-v14b-'));
  try {
    const mapFile = path.join(dir, 'account-map.json');
    fs.mkdirSync(mapFile); // mapFile itself is a directory: read fails, and rename(tmp -> mapFile) fails too
    const a = R.resolveLocalAccountLabel('v14bbbb1111', { mapFile });
    const b = R.resolveLocalAccountLabel('v14bbbb1111', { mapFile });
    assert.strictEqual(a.persisted, false);
    assert.strictEqual(a.label, b.label, 'label must not change between calls when the map path is itself a directory: ' + JSON.stringify([a, b]));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
t('V14: without a mapFile at all, the SAME fp still returns the SAME label across repeated calls (deterministic, not random-per-call)', () => {
  const a = R.resolveLocalAccountLabel('v14nomapfile');
  const b = R.resolveLocalAccountLabel('v14nomapfile');
  assert.strictEqual(a.persisted, false);
  assert.strictEqual(a.label, b.label);
});
t('V14: two DIFFERENT fps under the SAME sustained-failure mapFile still get two DIFFERENT deterministic labels', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-redact-v14c-'));
  try {
    const mapFile = path.join(dir, 'does-not-exist', 'account-map.json');
    const a = R.resolveLocalAccountLabel('v14-fp-a', { mapFile });
    const b = R.resolveLocalAccountLabel('v14-fp-b', { mapFile });
    assert.notStrictEqual(a.label, b.label);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- V14, SECOND Codex recheck (2026-09-24): a map that IS readable-in-principle but is intercepted at
// exactly ONE fs step (read / write / rename) must still return a STABLE label across repeated calls —
// distinguishing "unreadable" from "absent" is the fix; these patch the real `fs` module (a require('fs')
// module-cache singleton, same technique this project already uses for forge-config-once.cjs's V09 tests)
// so each scenario is deterministic and Windows-safe (no chmod needed).
function withPatchedFs(patches, fn) {
  const orig = {};
  for (const k of Object.keys(patches)) orig[k] = fs[k];
  Object.assign(fs, patches);
  try { return fn(); } finally { Object.assign(fs, orig); }
}

t('V14 (second recheck): a map file that exists and parses fine, but whose READ is denied (EACCES) for a reason other than absence, still returns the SAME deterministic label across 3 calls even though a write+rename to it would succeed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-redact-v14d-'));
  try {
    const mapFile = path.join(dir, 'account-map.json');
    fs.writeFileSync(mapFile, JSON.stringify({})); // a real, valid, EMPTY map — write/rename to it work fine
    const origRead = fs.readFileSync;
    const a = withPatchedFs({
      readFileSync: (p, ...rest) => {
        if (p === mapFile) { const e = new Error('EACCES: permission denied, open \'' + mapFile + '\''); e.code = 'EACCES'; throw e; }
        return origRead.call(fs, p, ...rest);
      },
    }, () => R.resolveLocalAccountLabel('v14d-fp', { mapFile }));
    const b = withPatchedFs({
      readFileSync: (p, ...rest) => {
        if (p === mapFile) { const e = new Error('EACCES: permission denied, open \'' + mapFile + '\''); e.code = 'EACCES'; throw e; }
        return origRead.call(fs, p, ...rest);
      },
    }, () => R.resolveLocalAccountLabel('v14d-fp', { mapFile }));
    const c = withPatchedFs({
      readFileSync: (p, ...rest) => {
        if (p === mapFile) { const e = new Error('EACCES: permission denied, open \'' + mapFile + '\''); e.code = 'EACCES'; throw e; }
        return origRead.call(fs, p, ...rest);
      },
    }, () => R.resolveLocalAccountLabel('v14d-fp', { mapFile }));
    assert.strictEqual(a.persisted, false);
    assert.strictEqual(a.label, b.label, 'a read-denied map must return the SAME label every call, never a fresh random one: ' + JSON.stringify([a, b, c]));
    assert.strictEqual(b.label, c.label);
    assert.ok(!/^account-\d/.test(a.label), 'a never-persisted label must not look like a real persisted "account-N-hex" label: ' + a.label);
    // the map on disk must be UNCHANGED — a read failure must never attempt (and thereby risk corrupting) a write
    assert.strictEqual(fs.readFileSync(mapFile, 'utf8'), JSON.stringify({}));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

t('V14 (second recheck): a map file that reads fine (valid, fp absent) but whose WRITE is denied still returns the SAME deterministic label across 3 calls', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-redact-v14e-'));
  try {
    const mapFile = path.join(dir, 'account-map.json');
    fs.writeFileSync(mapFile, JSON.stringify({}));
    const origWrite = fs.writeFileSync;
    const patched = { writeFileSync: (p, ...rest) => {
      if (typeof p === 'string' && p.startsWith(mapFile) && p !== mapFile) { const e = new Error('EACCES: permission denied, open'); e.code = 'EACCES'; throw e; }
      return origWrite.call(fs, p, ...rest);
    } };
    const a = withPatchedFs(patched, () => R.resolveLocalAccountLabel('v14e-fp', { mapFile }));
    const b = withPatchedFs(patched, () => R.resolveLocalAccountLabel('v14e-fp', { mapFile }));
    const c = withPatchedFs(patched, () => R.resolveLocalAccountLabel('v14e-fp', { mapFile }));
    assert.strictEqual(a.persisted, false);
    assert.strictEqual(a.label, b.label, 'a write-denied map must return the SAME label every call: ' + JSON.stringify([a, b, c]));
    assert.strictEqual(b.label, c.label);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

t('V14 (second recheck): a map file that reads fine and whose tmp WRITE succeeds but whose publishing RENAME is denied still returns the SAME deterministic label across 3 calls', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-redact-v14f-'));
  try {
    const mapFile = path.join(dir, 'account-map.json');
    fs.writeFileSync(mapFile, JSON.stringify({}));
    const origRename = fs.renameSync;
    const patched = { renameSync: (from, to) => {
      if (to === mapFile) { const e = new Error('EPERM: operation not permitted, rename'); e.code = 'EPERM'; throw e; }
      return origRename.call(fs, from, to);
    } };
    const a = withPatchedFs(patched, () => R.resolveLocalAccountLabel('v14f-fp', { mapFile }));
    const b = withPatchedFs(patched, () => R.resolveLocalAccountLabel('v14f-fp', { mapFile }));
    const c = withPatchedFs(patched, () => R.resolveLocalAccountLabel('v14f-fp', { mapFile }));
    assert.strictEqual(a.persisted, false);
    assert.strictEqual(a.label, b.label, 'a rename-denied map must return the SAME label every call: ' + JSON.stringify([a, b, c]));
    assert.strictEqual(b.label, c.label);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- sanitizeReason (N10/N11/N12 Codex recheck, 2026-09-24: "reasons are stored without redaction") ----
t('sanitizeReason: a plain, short reason passes through unchanged', () => {
  assert.strictEqual(R.sanitizeReason('Eigenaar kocht usage credits'), 'Eigenaar kocht usage credits');
});
t('sanitizeReason: non-string / empty / whitespace-only input returns null', () => {
  assert.strictEqual(R.sanitizeReason(undefined), null);
  assert.strictEqual(R.sanitizeReason(null), null);
  assert.strictEqual(R.sanitizeReason(42), null);
  assert.strictEqual(R.sanitizeReason(''), null);
  assert.strictEqual(R.sanitizeReason('   '), null);
});
t('sanitizeReason: control characters (CR/LF/NUL — log/JSON injection shape) are stripped, never persisted verbatim', () => {
  const out = R.sanitizeReason('line one\nFAKE-LOG-LINE: pwned\r\nmore\x00text');
  assert.ok(!/[\n\r\x00]/.test(out), 'no raw control character may survive: ' + JSON.stringify(out));
});
t('sanitizeReason: a long token-shaped run (>=20 chars, no whitespace, token alphabet) is masked, never echoed', () => {
  const fakeToken = 'sk-ant-oat01-' + 'a'.repeat(40);
  const out = R.sanitizeReason('owner note: ' + fakeToken + ' pasted by mistake');
  assert.ok(!out.includes(fakeToken), 'the token-shaped run must be masked: ' + out);
  assert.ok(out.includes('[redacted-token-like-value]'), out);
});
t('sanitizeReason: ordinary short hyphenated/technical words are NOT masked (false-positive guard)', () => {
  const out = R.sanitizeReason('usage-guard-override-grant test');
  assert.strictEqual(out, 'usage-guard-override-grant test');
});
t('sanitizeReason: total length is capped', () => {
  const out = R.sanitizeReason('word '.repeat(200));
  assert.ok(out.length <= 501, 'must be capped to ~500 chars: ' + out.length);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
