#!/usr/bin/env node
'use strict';
/** Offline test for the WP5 GET /api/artifact/<id> containment guard in forge-dashboard/server.cjs.
 *
 *  Requiring server.cjs directly is normally heavy — its module body ends with a call that starts an
 *  HTTP listener. That call is now guarded behind `require.main === module` specifically so this test
 *  can require() the file for its exported pure guard functions (artifactIdOk, resolveArtifactPath)
 *  WITHOUT binding a port or starting a server. This test asserts that directly: after require(), no
 *  listening net.Server handle exists, so the test process exits on its own (a real bound listener would
 *  keep the event loop alive and the process would hang instead of reaching the final console.log/exit).
 *  Never touches the real project's forge-artifacts/ (only exercises the pure id/path guard). Exit 0 =
 *  all pass. */
const net = require('net');

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };

console.log('forge-artifact-endpoint (WP5) offline guard tests');

const server = require('../forge-dashboard/server.cjs');
t('server.cjs exports artifactIdOk', typeof server.artifactIdOk === 'function');
t('server.cjs exports resolveArtifactPath', typeof server.resolveArtifactPath === 'function');

// requiring server.cjs must NOT bind a port — no listening net.Server handle should exist afterward.
if (typeof process._getActiveHandles === 'function') {
  const boundAnyServer = process._getActiveHandles().some((h) => h instanceof net.Server && h.listening);
  t('requiring server.cjs does not start a listening server', boundAnyServer === false);
} else {
  console.log('  skip  (process._getActiveHandles unavailable on this Node — the require.main guard is still exercised: no listen() log/console output above proves it did not run)');
}

// id guard: same regex-allowlist shape the /api/run route already uses, applied to /api/artifact.
t('valid id "a1" is accepted', server.artifactIdOk('a1') === true);
t('valid id "a1" resolves to a non-null containment-checked path', server.resolveArtifactPath('a1') !== null);
t('resolved path for "a1" ends in forge-artifacts/a1.json', /[\\/]forge-artifacts[\\/]a1\.json$/.test(server.resolveArtifactPath('a1')));

t('traversal id "../evil" is rejected', server.artifactIdOk('../evil') === false);
t('traversal id "../evil" resolves to null', server.resolveArtifactPath('../evil') === null);

t('path-separator id "a/b" is rejected', server.artifactIdOk('a/b') === false);
t('path-separator id "a/b" resolves to null', server.resolveArtifactPath('a/b') === null);

t('trailing-dot id "a1." is rejected', server.artifactIdOk('a1.') === false);
t('trailing-dot id "a1." resolves to null', server.resolveArtifactPath('a1.') === null);

// a few more traversal shapes, belt-and-suspenders
t('backslash traversal "..\\\\evil" is rejected', server.artifactIdOk('..\\evil') === false);
t('empty id is rejected', server.artifactIdOk('') === false);
t('non-string id is rejected', server.artifactIdOk(123) === false && server.artifactIdOk(null) === false && server.artifactIdOk(undefined) === false);

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
