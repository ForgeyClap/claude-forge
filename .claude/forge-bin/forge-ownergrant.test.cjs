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

t('OWNER-CREDENTIAL-PATH: the refusal names a project-relative label, never the absolute secret-file path', () => {
  const projectRoot = root(undefined);
  const r = G.verifyOwnerGrant({ token: 'x', projectRoot });
  assert.ok(!r.reason.includes(projectRoot), 'the refusal must not leak the absolute project root: ' + r.reason);
  assert.ok(/\.claude\/config\/forge-owner-grant\.txt/.test(r.reason), r.reason);
});

t('relativeSecretLabel: a path outside root (or a bare relative secretFile made absolute) falls back to the basename, never leaking an unrelated absolute path', () => {
  const outside = path.join(os.tmpdir(), 'somewhere-else', 'secret.txt');
  const label = G.relativeSecretLabel(outside, root(undefined));
  assert.strictEqual(label, 'secret.txt');
  assert.ok(!label.includes(os.tmpdir()));
});

// ---- V15 (FOURTH Codex recheck, 2026-09-24): the AUTHORITATIVE override-grant record ----
// See usage-guard-override.cjs's own header for WHY this exists: usage-guard.cjs's state.json cache is no
// longer trusted on its own for the pause/don't-pause decision — this record is.
t('readOverrideGrant: an ABSENT file reads as inactive', () => {
  const r = G.readOverrideGrant({ projectRoot: root(undefined) });
  assert.strictEqual(r.active, false);
});
t('writeOverrideGrant then readOverrideGrant: an active, unexpired grant with a real `until` round-trips', () => {
  const dir = root(undefined);
  const until = new Date(Date.now() + 3600000).toISOString();
  const ok = G.writeOverrideGrant({ active: true, at: '2026-09-24T00:00:00.000Z', until, reason: 'test' }, { projectRoot: dir });
  assert.strictEqual(ok, true);
  const r = G.readOverrideGrant({ projectRoot: dir });
  assert.strictEqual(r.active, true);
  assert.strictEqual(r.reason, 'test');
  assert.strictEqual(r.at, '2026-09-24T00:00:00.000Z');
  assert.strictEqual(r.until, until);
});
// ---- N12 (2026-09-24, Security Boss addendum reconfirmed): expiry is now MANDATORY — a missing or
// unparseable `until` reads as an INVALID grant, never as "unlimited". ----
t('N12: readOverrideGrant — a MISSING `until` (null, the old "unlimited" convention) now reads as INVALID, not active', () => {
  const dir = root(undefined);
  G.writeOverrideGrant({ active: true, at: new Date().toISOString(), until: null, reason: 'no expiry set' }, { projectRoot: dir });
  const r = G.readOverrideGrant({ projectRoot: dir });
  assert.strictEqual(r.active, false, 'a grant with no expiry at all must never read as active (unlimited): ' + JSON.stringify(r));
  assert.strictEqual(r.invalid, 'missing-expiry');
});
t('N12: readOverrideGrant — an UNPARSEABLE `until` (present but not a real date — corruption/typo) reads as INVALID, not active', () => {
  const dir = root(undefined);
  G.writeOverrideGrant({ active: true, at: new Date().toISOString(), until: 'not-a-real-date', reason: 'corrupted' }, { projectRoot: dir });
  const r = G.readOverrideGrant({ projectRoot: dir });
  assert.strictEqual(r.active, false, 'an unparseable expiry must never silently fall back to unlimited: ' + JSON.stringify(r));
  assert.strictEqual(r.invalid, 'unparseable-expiry');
});
t('readOverrideGrant: an EXPIRED `until` reads as inactive, even though the file itself still says active:true', () => {
  const dir = root(undefined);
  G.writeOverrideGrant({ active: true, at: new Date().toISOString(), until: '2020-01-01T00:00:00.000Z', reason: 'long expired' }, { projectRoot: dir });
  const r = G.readOverrideGrant({ projectRoot: dir });
  assert.strictEqual(r.active, false, 'an expired grant must never read as active');
  assert.strictEqual(r.expired, true);
});
t('readOverrideGrant: an UNEXPIRED `until` (in the future) still reads as active', () => {
  const dir = root(undefined);
  const future = new Date(Date.now() + 3600000).toISOString();
  G.writeOverrideGrant({ active: true, at: new Date().toISOString(), until: future, reason: 'still good' }, { projectRoot: dir });
  const r = G.readOverrideGrant({ projectRoot: dir });
  assert.strictEqual(r.active, true);
});
// ---- N10 (2026-09-24, Security Boss addendum reconfirmed): the grant record persists the opaque account
// identity label it is bound to (enforcement of the binding lives in usage-guard-override.cjs's
// resolveOwnerOverride; this function only ever reports what the file contains). ----
t('N10: writeOverrideGrant persists accountLabel; readOverrideGrant returns it back unchanged', () => {
  const dir = root(undefined);
  const until = new Date(Date.now() + 3600000).toISOString();
  G.writeOverrideGrant({ active: true, at: new Date().toISOString(), until, reason: 'test', accountLabel: 'account-abc123' }, { projectRoot: dir });
  const r = G.readOverrideGrant({ projectRoot: dir });
  assert.strictEqual(r.accountLabel, 'account-abc123');
});
t('N10: a grant written WITHOUT an accountLabel (a legacy/label-less record) reads back accountLabel: null', () => {
  const dir = root(undefined);
  const until = new Date(Date.now() + 3600000).toISOString();
  G.writeOverrideGrant({ active: true, at: new Date().toISOString(), until, reason: 'legacy' }, { projectRoot: dir });
  const r = G.readOverrideGrant({ projectRoot: dir });
  assert.strictEqual(r.accountLabel, null);
});
t('readOverrideGrant: a CORRUPT/unparseable grant file reads as inactive, never throws', () => {
  const dir = root(undefined);
  const file = G.overrideGrantFilePath({ projectRoot: dir });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not json');
  const r = G.readOverrideGrant({ projectRoot: dir });
  assert.strictEqual(r.active, false);
});
t('writeOverrideGrant({active:false}) removes an existing grant file; a second call on an already-absent file still reports success', () => {
  const dir = root(undefined);
  G.writeOverrideGrant({ active: true, at: new Date().toISOString() }, { projectRoot: dir });
  const file = G.overrideGrantFilePath({ projectRoot: dir });
  assert.ok(fs.existsSync(file));
  assert.strictEqual(G.writeOverrideGrant({ active: false }, { projectRoot: dir }), true);
  assert.ok(!fs.existsSync(file));
  assert.strictEqual(G.writeOverrideGrant({ active: false }, { projectRoot: dir }), true, 'clearing an already-absent grant is still a success');
});
// ---- N10 residual (2026-09-24, Codex p12 wave 7 finding N10): a non-secret credential-file generation
// stamp (mtime+size only, never content) persists alongside the account label — see usage-guard-override.cjs
// resolveOwnerOverride() for how a mismatch is used. ----
t('N10 residual: writeOverrideGrant persists credentialGeneration; readOverrideGrant returns it back unchanged', () => {
  const dir = root(undefined);
  const until = new Date(Date.now() + 3600000).toISOString();
  G.writeOverrideGrant({ active: true, at: new Date().toISOString(), until, reason: 'test', accountLabel: 'a', credentialGeneration: '12345:678' }, { projectRoot: dir });
  const r = G.readOverrideGrant({ projectRoot: dir });
  assert.strictEqual(r.credentialGeneration, '12345:678');
});
t('N10 residual: a grant written WITHOUT credentialGeneration (old-style/legacy record) reads back credentialGeneration: null', () => {
  const dir = root(undefined);
  const until = new Date(Date.now() + 3600000).toISOString();
  G.writeOverrideGrant({ active: true, at: new Date().toISOString(), until, reason: 'legacy', accountLabel: 'a' }, { projectRoot: dir });
  const r = G.readOverrideGrant({ projectRoot: dir });
  assert.strictEqual(r.credentialGeneration, null);
});
t('N10 residual: an ABSENT grant file also reports credentialGeneration: null (never throws, never a stale leftover)', () => {
  const r = G.readOverrideGrant({ projectRoot: root(undefined) });
  assert.strictEqual(r.credentialGeneration, null);
});
// ---- N10 residual, WAVE 9 (2026-09-24, Codex p14 out-p14 finding N10): a random, non-secret `issuanceId`
// binds the memory-proof check (usage-guard-override.cjs's resolveOwnerOverride) to THIS SPECIFIC grant
// write — never merely to the account label — so a REPLACED grant can never be authorized by a baseline a
// watcher established under an earlier, different issuance. This function persists whatever it is given
// verbatim; it does not itself generate or validate an issuanceId (usage-guard.cjs's runOverrideOn does,
// via crypto.randomUUID()). ----
t('N10 wave 9: writeOverrideGrant persists issuanceId; readOverrideGrant returns it back unchanged', () => {
  const dir = root(undefined);
  const until = new Date(Date.now() + 3600000).toISOString();
  G.writeOverrideGrant({ active: true, at: new Date().toISOString(), until, reason: 'test', accountLabel: 'a', credentialGeneration: 'G0', issuanceId: 'iss-abc-123' }, { projectRoot: dir });
  const r = G.readOverrideGrant({ projectRoot: dir });
  assert.strictEqual(r.issuanceId, 'iss-abc-123');
});
t('N10 wave 9: a grant written WITHOUT issuanceId (a pre-wave-9 legacy record) reads back issuanceId: null', () => {
  const dir = root(undefined);
  const until = new Date(Date.now() + 3600000).toISOString();
  G.writeOverrideGrant({ active: true, at: new Date().toISOString(), until, reason: 'legacy', accountLabel: 'a', credentialGeneration: 'G0' }, { projectRoot: dir });
  const r = G.readOverrideGrant({ projectRoot: dir });
  assert.strictEqual(r.issuanceId, null);
});
t('N10 wave 9: an ABSENT grant file also reports issuanceId: null (never throws, never a stale leftover)', () => {
  const r = G.readOverrideGrant({ projectRoot: root(undefined) });
  assert.strictEqual(r.issuanceId, null);
});
t('N10 wave 9: a REPLACED grant (a fresh writeOverrideGrant call for the SAME account) gets a genuinely DIFFERENT issuanceId when the caller supplies one — this function never reuses the prior file\'s own value on its own', () => {
  const dir = root(undefined);
  const until = new Date(Date.now() + 3600000).toISOString();
  G.writeOverrideGrant({ active: true, at: new Date().toISOString(), until, reason: 'grant 1', accountLabel: 'a', credentialGeneration: 'G1', issuanceId: 'iss-1' }, { projectRoot: dir });
  G.writeOverrideGrant({ active: true, at: new Date().toISOString(), until, reason: 'grant 2', accountLabel: 'a', credentialGeneration: 'G2', issuanceId: 'iss-2' }, { projectRoot: dir });
  const r = G.readOverrideGrant({ projectRoot: dir });
  assert.strictEqual(r.issuanceId, 'iss-2', 'the replacement write must fully take effect: ' + JSON.stringify(r));
});

t('overrideGrantFilePath: a DIFFERENT file from the plain owner-grant SECRET file — the two never collide', () => {
  const dir = root('SOME-SECRET');
  const secretFile = path.join(dir, '.claude', 'config', 'forge-owner-grant.txt');
  const grantFile = G.overrideGrantFilePath({ projectRoot: dir });
  assert.notStrictEqual(secretFile, grantFile);
  assert.ok(fs.existsSync(secretFile));
  assert.ok(!fs.existsSync(grantFile), 'writing the secret must never also create the override-grant record');
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
