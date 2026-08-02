import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { hostOk, crossSiteOk, containmentOk, safeIdOk, getExecToken, execTokenOk, EXEC_TOKEN_HEADER } from '../src/security.mjs';

test('hostOk accepts localhost/127.0.0.1/no-host, rejects an attacker host', () => {
  assert.equal(hostOk({ headers: { host: 'localhost:4100' } }), true);
  assert.equal(hostOk({ headers: { host: '127.0.0.1:4100' } }), true);
  assert.equal(hostOk({ headers: {} }), true); // no Host header at all (e.g. HTTP/1.0-ish) -> allowed
  assert.equal(hostOk({ headers: { host: 'evil.com' } }), false);
  assert.equal(hostOk({ headers: { host: 'evil.com:4100' } }), false);
});

test('crossSiteOk rejects a cross-site Sec-Fetch-Site and a foreign Origin', () => {
  assert.equal(crossSiteOk({ headers: {} }), true);
  assert.equal(crossSiteOk({ headers: { 'sec-fetch-site': 'same-origin' } }), true);
  assert.equal(crossSiteOk({ headers: { 'sec-fetch-site': 'cross-site' } }), false);
  assert.equal(crossSiteOk({ headers: { origin: 'http://localhost:5173' } }), true);
  assert.equal(crossSiteOk({ headers: { origin: 'http://evil.com' } }), false);
});

test('containmentOk allows the base dir and real descendants, rejects escapes', () => {
  const base = path.resolve('C:/fake/base/dir');
  assert.equal(containmentOk(base, base), true);
  assert.equal(containmentOk(base, path.join(base, 'child', 'file.txt')), true);
  assert.equal(containmentOk(base, path.resolve(base, '..', 'sibling')), false);
  assert.equal(containmentOk(base, path.resolve(base, '..', '..')), false);
  // a sibling directory that merely SHARES a string prefix must not pass (naive startsWith bug)
  assert.equal(containmentOk(base, path.resolve(base + '-evil')), false);
});

test('safeIdOk rejects traversal-shaped ids and accepts real run-id shapes', () => {
  assert.equal(safeIdOk('forge-2026-07-26-command-center'), true);
  assert.equal(safeIdOk('..'), false);
  assert.equal(safeIdOk('../../etc/passwd'), false);
  assert.equal(safeIdOk('..%2F'), false); // literal percent-sign form also fails (not in charset)
  assert.equal(safeIdOk('foo/bar'), false);
  assert.equal(safeIdOk('foo\\bar'), false);
  assert.equal(safeIdOk(''), false);
  assert.equal(safeIdOk(null), false);
});

// fix-sec-round #1 (HIGH): the per-boot exec token.
test('getExecToken() returns a real, non-empty, stable-per-process string', () => {
  const a = getExecToken();
  const b = getExecToken();
  assert.equal(typeof a, 'string');
  assert.ok(a.length >= 32, 'the token should be a real random value, not a short placeholder');
  assert.equal(a, b, 'the token must stay stable across calls within the same process (per-boot, not per-request)');
});

test('execTokenOk() accepts only the exact real token, rejects a wrong/missing/empty one', () => {
  const real = getExecToken();
  assert.equal(execTokenOk({ headers: { [EXEC_TOKEN_HEADER]: real } }), true);
  assert.equal(execTokenOk({ headers: { [EXEC_TOKEN_HEADER]: 'wrong-value' } }), false);
  assert.equal(execTokenOk({ headers: { [EXEC_TOKEN_HEADER]: '' } }), false);
  assert.equal(execTokenOk({ headers: {} }), false);
  assert.equal(execTokenOk({ headers: { [EXEC_TOKEN_HEADER]: real + 'x' } }), false, 'a longer string sharing a prefix must not pass');
  assert.equal(execTokenOk({ headers: { [EXEC_TOKEN_HEADER]: real.slice(0, -1) } }), false, 'a shorter string sharing a prefix must not pass');
});
