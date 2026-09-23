#!/usr/bin/env node
'use strict';
/**
 * forge-ownergrant.cjs — ONE verification for "did the owner really authorise this?".
 *
 * WHY THIS EXISTS (broad Codex audit, 2026-08-05, findings #6/#8/#9). Three separate gates each grew
 * their own version of the same check, and each version was weaker than it looked:
 *   - `usage-guard override-on` had NO check at all: any local agent could run it and switch the usage
 *     guard off for the rest of the window.
 *   - `forge-genesis approve` and `forge-mcp-gate` tier-3 both compared the supplied token against a
 *     secret that could come from an ENVIRONMENT VARIABLE — and the environment is set by the same
 *     process that is asking for permission. An agent that can call the gate can also export the var,
 *     so "verified against the owner's secret" degraded to "verified against a value I just chose".
 *
 * The rule this module enforces:
 *   1. The secret lives in a FILE the owner writes: <project>/.claude/config/<name>.txt.
 *      A file is outside the caller's process; an env var is not.
 *   2. An env var may still be used, but ONLY as a *pointer/alias* for the same file value — never as
 *      the secret itself. (`allowEnv` exists for tests and for a deliberate owner-run shell; it is off
 *      by default and every caller in this repo leaves it off.)
 *   3. No secret configured => REFUSE. A missing lock is not an open door.
 *   4. Comparison is over SHA-256 digests with timingSafeEqual, and the expected value is never echoed
 *      back in any reason string.
 *
 * verifyOwnerGrant({ token, secretFile, projectRoot, env, allowEnv, envVar }) -> { ok, reason, source }
 * Zero dependencies. Never throws.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_ROOT = path.resolve(__dirname, '..', '..');

/** readOwnerSecret — file first (authoritative), env only when the caller explicitly opts in. */
function readOwnerSecret(opts) {
  opts = opts || {};
  const root = opts.projectRoot ? path.resolve(opts.projectRoot) : DEFAULT_ROOT;
  const rel = opts.secretFile || path.join('.claude', 'config', 'forge-owner-grant.txt');
  const file = path.isAbsolute(rel) ? rel : path.join(root, rel);
  try {
    const v = fs.readFileSync(file, 'utf8').trim();
    if (v) return { value: v, source: 'file', file };
  } catch { /* absent/unreadable — reported as none below */ }
  if (opts.allowEnv === true && opts.envVar) {
    const env = opts.env || process.env;
    const v = typeof env[opts.envVar] === 'string' ? env[opts.envVar].trim() : '';
    if (v) return { value: v, source: 'env', file };
  }
  return { value: null, source: 'none', file };
}

/** verifyOwnerGrant — the single decision. */
function verifyOwnerGrant(opts) {
  opts = opts || {};
  const secret = readOwnerSecret(opts);
  if (!secret.value) {
    return {
      ok: false, source: 'none',
      reason: 'no owner authorisation secret is configured — write one to ' + secret.file
        + ' so this can be VERIFIED instead of assumed (an environment variable does not count: the process asking for permission can set it)',
    };
  }
  const token = opts.token;
  if (typeof token !== 'string' || !token.trim()) {
    return { ok: false, source: secret.source, reason: 'an explicit, non-empty owner authorisation token is required' };
  }
  const a = crypto.createHash('sha256').update(String(token)).digest();
  const b = crypto.createHash('sha256').update(String(secret.value)).digest();
  if (!crypto.timingSafeEqual(a, b)) {
    return { ok: false, source: secret.source, reason: 'the supplied owner authorisation token does not match the configured secret' };
  }
  return { ok: true, source: secret.source, reason: 'owner authorisation verified (' + secret.source + ')' };
}

module.exports = { verifyOwnerGrant, readOwnerSecret, DEFAULT_ROOT };

// ---- CLI: `node forge-ownergrant.cjs check --token <t> [--secret-file <rel>] [--root <dir>]` ----
if (require.main === module) {
  const argv = process.argv.slice(2);
  const arg = (n) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : null; };
  if (argv[0] !== 'check') {
    console.error('usage: node forge-ownergrant.cjs check --token <token> [--secret-file <relpath>] [--root <projectRoot>] [--json]');
    process.exit(2);
  }
  const res = verifyOwnerGrant({ token: arg('token'), secretFile: arg('secret-file'), projectRoot: arg('root') });
  if (argv.includes('--json')) console.log(JSON.stringify(res, null, 2));
  else console.log((res.ok ? 'OK — ' : 'REFUSED — ') + res.reason);
  process.exit(res.ok ? 0 : 3);
}
