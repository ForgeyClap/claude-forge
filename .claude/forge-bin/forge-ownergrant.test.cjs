#!/usr/bin/env node
'use strict';
/**
 * forge-ownergrant.test.cjs — one verification for "did the owner really authorise this?".
 *
 * MEASURED DEFECTS this closes (broad Codex audit, 2026-08-05):
 *   #6  `usage-guard override-on` had no check at all — any local agent could switch the usage guard off.
 *   #8  forge-mcp-gate's tier-3 owner grant accepted a secret from an ENV VAR.
 *   #9  forge-genesis approve did the same.
 * An environment variable is set by the very process asking for permission, so "verified against the
 * owner's secret" quietly meant "verified against a value I chose myself". The file channel is the real
 * one; env is opt-in only and off everywhere in this repo.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const G = require('./forge-ownergrant.cjs');
const CLI = path.join(__dirname, 'forge-ownergrant.cjs');

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.error('  FAIL ' + name + ' — ' + e.message); } };

console.log('forge-ownergrant tests (one owner-authorisation check)');

function root(secret) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'ownergrant-'));
  if (secret !== undefined) {
    const p = path.join(r, '.claude', 'config', 'forge-owner-grant.txt');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, secret + '\n', 'utf8');
  }
  return r;
}

t('no secret configured -> REFUSED (a missing lock is not an open door)', () => {
  const r = G.verifyOwnerGrant({ token: 'anything', projectRoot: root(undefined) });
  assert.strictEqual(r.ok, false);
  assert.ok(/no owner authorisation secret is configured/.test(r.reason), r.reason);
});

t('the refusal explains WHY an env var does not count', () => {
  const r = G.verifyOwnerGrant({ token: 'x', projectRoot: root(undefined) });
  assert.ok(/environment variable does not count|can set it/i.test(r.reason), r.reason);
});

t('an env var ALONE never authorises — the caller controls its own environment', () => {
  const r = G.verifyOwnerGrant({ token: 'agent-chosen', projectRoot: root(undefined), env: { FORGE_OWNER_GRANT: 'agent-chosen' }, envVar: 'FORGE_OWNER_GRANT' });
  assert.strictEqual(r.ok, false, 'an env-only secret must not authorise');
});

t('the file secret authorises when the token matches', () => {
  const r = G.verifyOwnerGrant({ token: 'REAL-SECRET', projectRoot: root('REAL-SECRET') });
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(r.source, 'file');
});

t('a wrong token is refused and the expected secret is never echoed back', () => {
  const r = G.verifyOwnerGrant({ token: 'guess', projectRoot: root('REAL-SECRET') });
  assert.strictEqual(r.ok, false);
  assert.ok(!/REAL-SECRET/.test(JSON.stringify(r)), 'the refusal leaked the secret');
});

t('an empty or non-string token is refused even with a secret present', () => {
  const r1 = G.verifyOwnerGrant({ token: '   ', projectRoot: root('S') });
  const r2 = G.verifyOwnerGrant({ token: null, projectRoot: root('S') });
  assert.strictEqual(r1.ok, false);
  assert.strictEqual(r2.ok, false);
});

t('env is honoured ONLY when a caller explicitly opts in (test/owner-shell seam)', () => {
  const r = G.verifyOwnerGrant({ token: 'E', projectRoot: root(undefined), env: { X: 'E' }, envVar: 'X', allowEnv: true });
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(r.source, 'env');
});

t('the file beats the env when both are present (file is authoritative)', () => {
  const r = G.verifyOwnerGrant({ token: 'FROM-FILE', projectRoot: root('FROM-FILE'), env: { X: 'FROM-ENV' }, envVar: 'X', allowEnv: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.source, 'file');
});

t('CLI: exit 3 on refusal, 0 on a verified token, 2 on usage error', () => {
  const r1 = spawnSync(process.execPath, [CLI, 'check', '--token', 'nope', '--root', root('YES')], { encoding: 'utf8' });
  assert.strictEqual(r1.status, 3, r1.stdout + r1.stderr);
  const r2 = spawnSync(process.execPath, [CLI, 'check', '--token', 'YES', '--root', root('YES')], { encoding: 'utf8' });
  assert.strictEqual(r2.status, 0, r2.stdout + r2.stderr);
  const r3 = spawnSync(process.execPath, [CLI, 'bogus'], { encoding: 'utf8' });
  assert.strictEqual(r3.status, 2);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
