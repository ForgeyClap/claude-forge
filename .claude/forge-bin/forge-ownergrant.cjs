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

/** relativeSecretLabel(file, root) -> a project-relative label for an owner-authorisation secret file
 *  path (OWNER-CREDENTIAL-PATH, 2026-09-24) — never the resolved absolute path, which can carry a
 *  private machine username, home directory or project folder name into a refusal reason an agent
 *  might print to stderr. Falls back to the basename when the file is not actually under `root` (e.g.
 *  an explicit absolute --secret-file elsewhere). Pure, never throws. */
function relativeSecretLabel(file, root) {
  if (typeof file !== 'string' || !file) return '(unknown file)';
  try {
    const rel = path.relative(root || DEFAULT_ROOT, file);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  } catch { /* fall through to basename */ }
  return path.basename(file);
}

/** readOwnerSecret — file first (authoritative), env only when the caller explicitly opts in. */
function readOwnerSecret(opts) {
  opts = opts || {};
  const root = opts.projectRoot ? path.resolve(opts.projectRoot) : DEFAULT_ROOT;
  const rel = opts.secretFile || path.join('.claude', 'config', 'forge-owner-grant.txt');
  const file = path.isAbsolute(rel) ? rel : path.join(root, rel);
  const label = relativeSecretLabel(file, root);
  try {
    const v = fs.readFileSync(file, 'utf8').trim();
    if (v) return { value: v, source: 'file', file, label };
  } catch { /* absent/unreadable — reported as none below */ }
  if (opts.allowEnv === true && opts.envVar) {
    const env = opts.env || process.env;
    const v = typeof env[opts.envVar] === 'string' ? env[opts.envVar].trim() : '';
    if (v) return { value: v, source: 'env', file, label };
  }
  return { value: null, source: 'none', file, label };
}

/** verifyOwnerGrant — the single decision. */
function verifyOwnerGrant(opts) {
  opts = opts || {};
  const secret = readOwnerSecret(opts);
  if (!secret.value) {
    return {
      ok: false, source: 'none',
      // OWNER-CREDENTIAL-PATH (2026-09-24): a project-relative LABEL, never secret.file's resolved
      // absolute path — see relativeSecretLabel() above.
      reason: 'no owner authorisation secret is configured — write one to ' + secret.label
        + ' (relative to the project root) so this can be VERIFIED instead of assumed (an environment variable does not count: the process asking for permission can set it)',
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

/** overrideGrantFilePath(opts) -> the path to the AUTHORITATIVE, expiry-aware record of whether the
 *  usage-guard credits override is currently granted (V15, FOURTH Codex recheck, 2026-09-24 — see
 *  usage-guard-override.cjs's own header for WHY this exists: an event-loop heartbeat can never prove a
 *  suspended lock-holder is truly gone, so usage-guard.cjs's state.json cache is no longer trusted for the
 *  pause/don't-pause DECISION on its own — this file is). `opts.projectRoot` must be the SAME trusted root
 *  every other owner-authorisation check in this repo anchors to (never an environment-selected root — see
 *  this file's own header on why an env var is never accepted for a security-relevant root/scope selector,
 *  exactly like the secret itself).
 *
 *  L5 (Security Boss addendum, 2026-09-24 — documented, not a regression): this file is a PLAIN, UNSIGNED
 *  JSON file protected only by ordinary filesystem permissions — any local process with write access to
 *  `.claude/config/` can create or edit it directly, bypassing verifyOwnerGrant()'s token check entirely.
 *  This is the SAME trust boundary usage-guard.cjs's pre-V15 `state.json`'s `ownerOverride` cache already
 *  had (any local writer could already flip that field before this file existed) — the V15 grant redesign
 *  moves the DECISION source, it does not narrow or widen who can write to the local filesystem. The real
 *  boundary remains OS-level file permissions / a single trusted local user account, exactly as before. The
 *  `credentialGeneration` stamp added for the N10 residual (2026-09-24, Codex p12 wave 7) sits on the SAME
 *  trust boundary — it is a plain, unsigned field in this same file, informative rather than a cryptographic
 *  proof; its purpose is to catch an ordinary STALE PROFILE (the normal cause of the account-label mismatch
 *  this whole file exists to prevent), not to resist a local writer who is willing to edit this file by hand,
 *  which is already outside what any file-permission-based design in this repo defends against. */
function overrideGrantFilePath(opts) {
  const root = (opts && opts.projectRoot) ? path.resolve(opts.projectRoot) : DEFAULT_ROOT;
  return path.join(root, '.claude', 'config', 'forge-usage-guard-override-grant.json');
}

/** readOverrideGrant(opts) -> { active, at, until, reason, accountLabel, credentialGeneration, expired?,
 *  invalid? }. ABSENT, UNPARSEABLE-JSON, or EXPIRED (`until` in the past) all read as `{active:false}` — a
 *  missing or lapsed grant is never treated as "on". This is the ONLY function usage-guard.cjs's tick() may
 *  trust for the actual suppress-pausing decision; state.json's own cached copy is a display/bookkeeping
 *  convenience, recomputed FROM this on every tick, never the other way around. `accountLabel` is the opaque
 *  local identity label (N10, 2026-09-24) the grant is bound to — usage-guard-override.cjs's
 *  resolveOwnerOverride is what actually ENFORCES the binding against the current identity; this function
 *  only ever reports what the file contains.
 *
 *  `credentialGeneration` (N10 residual, 2026-09-24, Codex p12 wave 7 finding N10) is a NON-SECRET stamp of
 *  the credentials FILE's own mtime+size — never its content, never anything token-derived — captured by
 *  `usage-guard.cjs`'s `override-on` at grant time. A stale profile file can keep reporting the SAME account
 *  label even after the underlying credential has actually rotated to a different account; `accountLabel`
 *  alone cannot see that, so `usage-guard-override.cjs`'s resolveOwnerOverride() also compares this stamp
 *  against the CURRENT credential file's generation before honouring an otherwise-matching grant. This
 *  function only ever reports whatever generation the file records; it does not itself compare it to
 *  anything.
 *
 *  EXPIRY SEMANTICS (N12, 2026-09-24 — Security Boss addendum reconfirmed): a PRESENT-BUT-UNPARSEABLE
 *  `until` (a non-empty string `Date.parse` cannot make sense of — a corrupted file, a hand-edit typo) reads
 *  as INVALID (`invalid:'unparseable-expiry'`), never as "unlimited" — silently treating corruption as
 *  unlimited would turn file damage into an unbounded suppression window. A genuinely ABSENT `until` (null/
 *  empty/omitted) also now reads as INVALID (`invalid:'missing-expiry'`) — every authoritative grant MUST
 *  carry a real expiry; `usage-guard.cjs`'s `override-on` fills one in automatically (a bounded backstop,
 *  and — Finding 5, 2026-09-24 — now also a MAXIMUM: an explicit later `--until` is clamped to it, never
 *  accepted verbatim) when the owner does not pass `--until` at all, so this is enforced at the point of
 *  use, not left as an owner chore. Never throws. */
function readOverrideGrant(opts) {
  const file = overrideGrantFilePath(opts);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { active: false, at: null, until: null, reason: null, accountLabel: null, credentialGeneration: null }; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { active: false, at: null, until: null, reason: null, accountLabel: null, credentialGeneration: null }; }
  const accountLabel = (parsed && typeof parsed.accountLabel === 'string' && parsed.accountLabel) ? parsed.accountLabel : null;
  const credentialGeneration = (parsed && typeof parsed.credentialGeneration === 'string' && parsed.credentialGeneration) ? parsed.credentialGeneration : null;
  if (!parsed || typeof parsed !== 'object' || parsed.active !== true) {
    return {
      active: false,
      at: (parsed && typeof parsed.at === 'string') ? parsed.at : null,
      until: (parsed && typeof parsed.until === 'string') ? parsed.until : null,
      reason: (parsed && typeof parsed.reason === 'string') ? parsed.reason : null,
      accountLabel, credentialGeneration,
    };
  }
  // N12: a genuinely absent `until` is INVALID, not unlimited (see the doc comment above).
  if (typeof parsed.until !== 'string' || !parsed.until) {
    return { active: false, at: parsed.at || null, until: null, reason: parsed.reason || null, accountLabel, credentialGeneration, invalid: 'missing-expiry' };
  }
  const untilMs = Date.parse(parsed.until);
  if (!Number.isFinite(untilMs)) {
    return { active: false, at: parsed.at || null, until: parsed.until, reason: parsed.reason || null, accountLabel, credentialGeneration, invalid: 'unparseable-expiry' };
  }
  if (Date.now() > untilMs) {
    return { active: false, at: parsed.at || null, until: parsed.until, reason: parsed.reason || null, accountLabel, credentialGeneration, expired: true };
  }
  return { active: true, at: parsed.at || null, until: parsed.until, reason: parsed.reason || null, accountLabel, credentialGeneration };
}

/** writeOverrideGrant(record, opts) -> boolean (true = the authoritative state on disk now matches the
 *  request; false = a real write/removal failure — the caller must decide whether that is safe to ignore).
 *  SINGLE WRITER in practice: only `usage-guard.cjs override-on`/`override-off` (owner-invoked CLI commands
 *  — override-on gated on verifyOwnerGrant() above) ever call this; the watcher's own tick() only ever
 *  READS via readOverrideGrant() — N12 (2026-09-24, Security Boss addendum) closed the one exception this
 *  used to have (credits exhaustion used to call this from inside tick() too; it no longer does — see
 *  usage-guard.cjs's own N12 history). `record.active !== true` removes the file outright (an absent file
 *  already reads as inactive — removing it keeps the directory clean rather than accumulating a growing
 *  history of "off" records). An atomic temp-file + rename write otherwise, the same shape as
 *  usage-guard.cjs's own writeStateTo. `record.accountLabel` (N10, 2026-09-24) is the opaque local identity
 *  label this grant is bound to — this function persists whatever it is given verbatim; it does not itself
 *  read or validate identity (the caller, usage-guard.cjs's override-on, is responsible for supplying the
 *  CURRENT account's label). This function also does not itself validate `record.until` (a well-formed vs.
 *  missing/unparseable expiry is a READ-time concern — see readOverrideGrant's own doc comment); it persists
 *  whatever string (or absence) it is given. `record.credentialGeneration` (N10 residual, 2026-09-24) is
 *  likewise persisted verbatim — see readOverrideGrant's own doc comment for what it is and why it exists;
 *  this function does not derive, validate or compare it. Never throws. */
function writeOverrideGrant(record, opts) {
  const file = overrideGrantFilePath(opts);
  if (!record || record.active !== true) {
    try { fs.unlinkSync(file); return true; }
    catch (e) { return !e || e.code === 'ENOENT'; }
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    const body = {
      active: true,
      at: (typeof record.at === 'string' && record.at) || new Date().toISOString(),
      until: (typeof record.until === 'string' && record.until) || null,
      reason: (typeof record.reason === 'string' && record.reason) || null,
      accountLabel: (typeof record.accountLabel === 'string' && record.accountLabel) || null,
      credentialGeneration: (typeof record.credentialGeneration === 'string' && record.credentialGeneration) || null,
    };
    fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n');
    fs.renameSync(tmp, file);
    return true;
  } catch { return false; }
}

module.exports = {
  verifyOwnerGrant, readOwnerSecret, relativeSecretLabel, DEFAULT_ROOT,
  overrideGrantFilePath, readOverrideGrant, writeOverrideGrant,
};

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
