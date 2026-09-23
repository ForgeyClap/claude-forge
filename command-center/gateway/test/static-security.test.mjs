// WP10 should-fix-now #9/#10 regression tests: a malformed static-path escape must never kill the
// gateway process (AP-4), and every static response must carry the anti-clickjacking headers
// (AP-13). Real HTTP requests against a real, ephemeral-port instance of the gateway's own request
// listener — same pattern as gateway.test.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.mjs';
import { request } from '../test-support/helpers.mjs';
import { getExecToken } from '../src/security.mjs';
import { needsBuiltDashboard } from './.real-data-guard.mjs';

// serveStatic() returns null before it reaches ANY of its own decode/containment/header logic when
// command-center/dashboard/dist is absent (src/static.mjs:55) — so without a build these tests do
// not exercise the code they are named after. Measured in that state: a malformed `/%` answers 200
// instead of 400, because the 400 branch is never reached. Guarding on the build is therefore not a
// convenience; running them unbuilt would assert against a code path that never executed.
const NEEDS_BUILD = needsBuiltDashboard();

let server;
let port;

before(async () => {
  server = createServer();
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('#9 SECURITY: a bare "/%" (malformed percent-escape) returns 400, never crashes the process', { skip: NEEDS_BUILD }, async () => {
  const res = await request(port, '/%');
  assert.equal(res.statusCode, 400);
});

test('#9 SECURITY: the gateway is still alive and serving after the malformed-path request', { skip: NEEDS_BUILD }, async () => {
  // This is the actual regression proof: AP-4 was a process-kill, not a bad status code — the real
  // bug was that decodeURIComponent's URIError propagated out of the request handler with no
  // uncaughtException handler in bin.mjs, so the WHOLE gateway process died. Proving the fix means
  // proving a NEXT request on the SAME server instance still succeeds.
  const first = await request(port, '/%');
  assert.equal(first.statusCode, 400);
  const second = await request(port, '/api/health');
  assert.equal(second.statusCode, 200);
  assert.equal(second.json.ok, true);
});

test('#9 SECURITY: other malformed-escape shapes (double-encoded, lone %, %-at-end) all degrade to 400, never throw', { skip: NEEDS_BUILD }, async () => {
  for (const badPath of ['/%%', '/%2', '/foo%', '/%zz']) {
    const res = await request(port, badPath);
    assert.equal(res.statusCode, 400, badPath + ' must return 400');
  }
  // Prove the server is still healthy after the whole batch.
  const health = await request(port, '/api/health');
  assert.equal(health.statusCode, 200);
});

test('#10 SECURITY: GET / carries the anti-clickjacking + no-sniff headers', async () => {
  const res = await request(port, '/');
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
});

test('#10 SECURITY: a real built asset (not just the index shell) carries the same security headers', { skip: NEEDS_BUILD }, async () => {
  const indexRes = await request(port, '/');
  const assetMatch = indexRes.body.match(/(?:src|href)="\.?(\/assets\/[^"]+)"/);
  assert.ok(assetMatch, 'the built index.html must reference at least one /assets/ file to make this test meaningful');
  const assetRes = await request(port, assetMatch[1]);
  assert.equal(assetRes.statusCode, 200);
  assert.equal(assetRes.headers['x-frame-options'], 'DENY');
  assert.match(assetRes.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(assetRes.headers['x-content-type-options'], 'nosniff');
});

test('#10 SECURITY: the 400 "bad path" response also carries the security headers (defense in depth)', { skip: NEEDS_BUILD }, async () => {
  const res = await request(port, '/%');
  assert.equal(res.statusCode, 400);
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
});

test('#11 SECURITY: a cross-site request to a static path is now blocked (root-cause fix)', async () => {
  const res = await request(port, '/', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(res.statusCode, 403);
});

test('#11 SECURITY: a same-origin / no-header static request still succeeds (real browsing must not break)', async () => {
  const noHeader = await request(port, '/');
  assert.equal(noHeader.statusCode, 200);
  const sameOrigin = await request(port, '/', { headers: { 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(sameOrigin.statusCode, 200);
  const none = await request(port, '/', { headers: { 'Sec-Fetch-Site': 'none' } }); // real top-level navigation shape
  assert.equal(none.statusCode, 200);
});

// fix-sec-round #1 (HIGH): the served SPA carries the real per-boot exec token so the dashboard
// can read it and send it back on every real write (see security.mjs + gateway-client.ts).
test('AUTH: GET / carries a <meta name="cc-exec-token"> tag with the REAL current-boot token', { skip: NEEDS_BUILD }, async () => {
  const res = await request(port, '/');
  assert.equal(res.statusCode, 200);
  const match = res.body.match(/<meta name="cc-exec-token" content="([^"]+)">/);
  assert.ok(match, 'the served index.html must carry the exec-token meta tag');
  assert.equal(match[1], getExecToken());
});

test('AUTH: the exec-token meta tag is only injected into HTML, never into a real built asset', { skip: NEEDS_BUILD }, async () => {
  const indexRes = await request(port, '/');
  const assetMatch = indexRes.body.match(/(?:src|href)="\.?(\/assets\/[^"]+)"/);
  assert.ok(assetMatch, 'the built index.html must reference at least one /assets/ file to make this test meaningful');
  const assetRes = await request(port, assetMatch[1]);
  assert.equal(assetRes.statusCode, 200);
  // The guarantee is that the gateway's injectExecToken() touches HTML responses ONLY — it must
  // never splice the meta TAG (nor, above all, the REAL per-boot token value) into a JS/CSS asset.
  // It is NOT that the literal string "cc-exec-token" is absent: the dashboard client legitimately
  // ships that meta-NAME as a source constant so it can READ the token from the DOM
  // (gateway-client.ts readExecToken()), so a built chunk that bundles that code contains the name
  // by design. Assert on the two things injection would actually leave behind — the real token and
  // the injected markup — not on the harmless name.
  assert.ok(!assetRes.body.includes(getExecToken()), 'the real per-boot token must never appear in a built asset');
  assert.doesNotMatch(assetRes.body, /<meta[^>]*cc-exec-token/, 'the injected meta tag must never appear in a built asset');
});
