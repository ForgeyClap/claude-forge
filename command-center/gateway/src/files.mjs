// GET /api/files + GET /api/files/read sources: a secure, read-only, project-scoped working-tree
// browser. This is the first gateway endpoint that can serve arbitrary project FILE CONTENT to a
// browser — security is the point of this module, not an afterthought.
//
// Two operations:
//   listDirectory(projectPath, relPath)   -> one directory level (name/type/size/mtime per entry)
//   readFilePreview(projectPath, relPath) -> a single text file's content, capped, with binary
//                                            detection and a hard denylist that NEVER serves bytes
//
// Containment model (defense in depth, same shape as runs.mjs/proof.mjs/events.mjs):
//   1. `projectPath` must already be a value from the trusted project registry (checked again here
//      via containmentOk(SYNC_SCAN_ROOT, projectPath) — never trust a single check point).
//   2. The caller-supplied `relPath` is rejected outright if it LOOKS absolute (drive letter, UNC,
//      POSIX leading slash) — belt-and-suspenders on top of point 3, since path.join() alone already
//      cannot be redirected by an absolute-looking later segment (that is path.resolve()'s behavior,
//      not path.join()'s).
//   3. The joined path is containment-checked as a STRING against projectPath (catches `../../`
///     traversal — path.resolve() collapses `..` lexically, so an escaping string never starts with
//      projectPath + sep).
//   4. The REAL path (fs.realpathSync, following symlinks) is containment-checked AGAIN. A symlink
//      that physically lives inside the project but POINTS outside it would pass check 3 (the
//      string never changes) but fails here — this is what actually stops a symlink escape.
//
// Denylist (readFilePreview only — listing metadata is not "serving content"):
//   - `.env`-prefixed names, `*.key`/`*.pem`, `id_rsa*`, `.git/config` — classic credential-shaped
//     files, blocked by name alone before any byte is read.
//   - `node_modules/**` content is blocked from READING (a vendored dependency's file content is
//     high-volume, low-value to preview, and occasionally carries a vendored token/example secret);
//     LISTING node_modules directories is still allowed — a name-only listing ("is package X
//     installed") leaks no content and is a normal, low-risk dev-workflow question. This is the
//     explicit "your call, justify" design decision the work package asked for.
//   - Content-based: after reading (and only if not name-denylisted, not binary), the bytes are
//     scanned against a small, REIMPLEMENTED set of secret-shaped patterns (mirrors
//     `.claude/forge-bin/forge-store.cjs`'s SECRET_PATTERNS in spirit — read for reference, not
//     imported across the gateway/`.claude` boundary). A match blocks the ENTIRE file rather than
//     attempting partial redaction: this is a one-shot preview endpoint, not a data store, so "never
//     serve" is simpler and safer than "serve a redacted copy."
import fs from 'node:fs';
import path from 'node:path';
import { containmentOk } from './security.mjs';
import { SYNC_SCAN_ROOT } from './paths.mjs';

// 256KB cap on any single file preview read — bounded regardless of the real file size.
export const MAX_PREVIEW_BYTES = 256 * 1024;

// Reimplemented minimal secret-shape scan (see file header). Every quantifier is upper-bounded —
// same ReDoS-safety discipline as the original forge-store.cjs patterns this mirrors.
const SECRET_PATTERNS = [
  /nvapi-[A-Za-z0-9_-]{10,80}/, // NVIDIA Build/NIM key
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,80}/, // OpenAI-style secret key, boundary-anchored
  /sk_(?:live|test)_[A-Za-z0-9]{10,80}/, // Stripe secret key
  /rk_(?:live|test)_[A-Za-z0-9]{10,80}/, // Stripe restricted key
  /gh[oprsu]_[A-Za-z0-9]{20,80}/, // GitHub tokens
  /AKIA[0-9A-Z]{16}/, // AWS access key id
  /AIza[0-9A-Za-z_-]{35}/, // Google API key
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM private key header alone is enough to block
  /eyJ[A-Za-z0-9_-]{10,256}\.[A-Za-z0-9_-]{1,512}\.[A-Za-z0-9_-]{1,512}/, // JWT shape
];

function containsSecret(text) {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

// First-8KB-sample NUL-byte heuristic — the same signal `git` itself uses for binary detection.
function isBinaryBuffer(buf) {
  const sampleLen = Math.min(buf.length, 8000);
  for (let i = 0; i < sampleLen; i++) {
    if (buf[i] === 0x00) return true;
  }
  return false;
}

const ABSOLUTE_LOOKING_RE = /^[A-Za-z]:|^\\\\|^\/|^\\/;

// Resolves `relPathRaw` against `projectPath`, applying every containment/escape check described in
// this file's header. Returns { ok:true, target, real } or { ok:false, error }.
function resolveSafePath(projectPath, relPathRaw) {
  const relPath = typeof relPathRaw === 'string' ? relPathRaw : '';
  if (relPath.includes('\0')) return { ok: false, error: 'invalid path' };
  if (ABSOLUTE_LOOKING_RE.test(relPath)) return { ok: false, error: 'absolute paths are not allowed' };

  const target = path.join(projectPath, relPath);
  if (!containmentOk(projectPath, target)) return { ok: false, error: 'path containment violation' };

  // Symlink-escape defense: resolve the REAL path (if it exists) and re-check containment against
  // it. A path that does not exist yet (e.g. a typo) simply has no real path to diverge — nothing
  // to defend against there, so `target` is used as its own "real" value in that case.
  let real = target;
  try {
    real = fs.realpathSync(target);
  } catch {
    /* does not exist — real === target, checked again below for consistency */
  }
  if (!containmentOk(projectPath, real)) return { ok: false, error: 'symlink escapes project root' };

  return { ok: true, target, real };
}

function toRelPosix(projectPath, targetPath) {
  const rel = path.relative(projectPath, targetPath).split(path.sep).join('/');
  return rel === '' ? '.' : rel;
}

// Returns the denylist reason string, or null if the file is readable. Checked BEFORE any byte is
// read — a name-denylisted file is never opened at all.
function denylistedReason(targetPath, projectPath) {
  const basename = path.basename(targetPath);
  const relPosixLower = toRelPosix(projectPath, targetPath).toLowerCase();
  const segments = relPosixLower.split('/');

  if (/^\.env/i.test(basename)) return 'env-file';
  if (/\.(key|pem)$/i.test(basename)) return 'key-or-pem-file';
  if (/^id_rsa/i.test(basename)) return 'ssh-private-key';
  if (relPosixLower === '.git/config' || relPosixLower.endsWith('/.git/config')) return 'git-config';
  if (segments.includes('node_modules')) return 'node-modules-content'; // listing allowed, reading not
  return null;
}

// GET /api/files: one directory level. `relPathRaw` empty/undefined means the project root.
export function listDirectory(projectPath, relPathRaw) {
  if (!containmentOk(SYNC_SCAN_ROOT, projectPath)) {
    return { ok: false, error: 'project path outside allowed scan root' };
  }
  const resolved = resolveSafePath(projectPath, relPathRaw);
  if (!resolved.ok) return resolved;

  const capturedAt = new Date();
  let stat;
  try {
    stat = fs.statSync(resolved.real);
  } catch (err) {
    return { ok: false, error: 'path not found: ' + err.message };
  }
  if (!stat.isDirectory()) return { ok: false, error: 'not a directory' };

  let dirEntries;
  try {
    dirEntries = fs.readdirSync(resolved.target, { withFileTypes: true });
  } catch (err) {
    return { ok: false, error: 'failed to read directory: ' + err.message };
  }

  const entries = [];
  for (const dirent of dirEntries) {
    const entryPath = path.join(resolved.target, dirent.name);
    if (!containmentOk(resolved.target, entryPath)) continue; // should be impossible, kept as a hard guard
    let entryStat = null;
    try {
      entryStat = fs.statSync(entryPath);
    } catch {
      /* broken symlink or a race with a concurrent delete — list the name, stat fields stay null */
    }
    entries.push({
      name: dirent.name,
      type: entryStat ? (entryStat.isDirectory() ? 'dir' : 'file') : dirent.isDirectory() ? 'dir' : 'file',
      size: entryStat && entryStat.isFile() ? entryStat.size : null,
      mtime: entryStat ? entryStat.mtime.toISOString() : null,
    });
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));

  return {
    ok: true,
    path: toRelPosix(projectPath, resolved.target),
    entries,
    entries_count: entries.length,
    captured_at: capturedAt.toISOString(),
    age_ms: 0,
    provenance: 'LIVE',
  };
}

// GET /api/files/read: a single text file preview, capped at MAX_PREVIEW_BYTES, with binary
// detection and the denylist described in this file's header.
export function readFilePreview(projectPath, relPathRaw) {
  if (!containmentOk(SYNC_SCAN_ROOT, projectPath)) {
    return { ok: false, error: 'project path outside allowed scan root' };
  }
  const resolved = resolveSafePath(projectPath, relPathRaw);
  if (!resolved.ok) return resolved;

  const capturedAt = new Date();
  const relPosix = toRelPosix(projectPath, resolved.target);

  const denyReason = denylistedReason(resolved.target, projectPath);
  if (denyReason) {
    return {
      ok: true,
      blocked: true,
      reason: denyReason,
      path: relPosix,
      captured_at: capturedAt.toISOString(),
      age_ms: 0,
      provenance: 'LIVE',
    };
  }

  let stat;
  try {
    stat = fs.statSync(resolved.real);
  } catch (err) {
    return { ok: false, error: 'file not found: ' + err.message };
  }
  if (!stat.isFile()) return { ok: false, error: 'not a regular file' };

  const readLen = Math.min(stat.size, MAX_PREVIEW_BYTES);
  let buf;
  try {
    const fd = fs.openSync(resolved.target, 'r');
    try {
      buf = Buffer.alloc(readLen);
      if (readLen > 0) fs.readSync(fd, buf, 0, readLen, 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    return { ok: false, error: 'failed to read file: ' + err.message };
  }

  if (isBinaryBuffer(buf)) {
    return {
      ok: true,
      binary: true,
      path: relPosix,
      size: stat.size,
      captured_at: capturedAt.toISOString(),
      age_ms: 0,
      provenance: 'LIVE',
    };
  }

  const text = buf.toString('utf8');
  if (containsSecret(text)) {
    return {
      ok: true,
      blocked: true,
      reason: 'secret-pattern-detected',
      path: relPosix,
      captured_at: capturedAt.toISOString(),
      age_ms: 0,
      provenance: 'LIVE',
    };
  }

  return {
    ok: true,
    binary: false,
    blocked: false,
    path: relPosix,
    size: stat.size,
    truncated: stat.size > MAX_PREVIEW_BYTES,
    content: text,
    captured_at: capturedAt.toISOString(),
    age_ms: 0,
    provenance: 'LIVE',
  };
}
