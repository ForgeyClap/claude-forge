// WP-v290-B (beginner Discord onboarding) — a tiny merge-writer for THIS package's own `.env`,
// used by main.js to persist an auto-detected DISCORD_GUILD_ID/OWNER_USER_IDS so a restart never
// has to re-detect them. Deliberately NOT shared with gateway/src/discord-service.mjs's own
// (separate, small) merge-writer — the two packages stay black-box supervised, never entangled
// beyond spawn/health/kill (see discord-service.mjs's own header) — this file's read-side mirrors
// config.js's own parseEnvFile() shape closely enough to read the same file correctly, same
// "each module keeps its own tiny copy" convention gateway-client.ts's header already documents.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Merges `updates` into the raw text of an existing `.env` file (or an empty starting point when
 * it does not exist yet): every key already present as a `KEY=...` line is replaced in place
 * (preserving every OTHER line — comments, blanks, unrelated keys — untouched); every key in
 * `updates` not already present is appended at the end. Never touches whitespace-only/comment
 * lines as if they were keys. Pure string transform — exported separately from the disk-writing
 * function below so a test can assert the merge shape without touching the filesystem at all.
 * @param {string} raw
 * @param {Readonly<Record<string, string>>} updates
 * @returns {string}
 */
export function mergeEnvText(raw, updates) {
  const lines = raw.length > 0 ? raw.replace(/\r\n/g, '\n').split('\n') : [];
  const seen = new Set();
  const merged = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const eq = trimmed.indexOf('=');
    if (eq === -1) return line;
    const key = trimmed.slice(0, eq).trim();
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      seen.add(key);
      return `${key}=${updates[key]}`;
    }
    return line;
  });
  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) merged.push(`${key}=${value}`);
  }
  while (merged.length > 0 && merged[merged.length - 1] === '') merged.pop();
  return merged.length > 0 ? merged.join('\n') + '\n' : '';
}

// Codex finding K3-5: a plain writeFileSync(target, ...) truncates the REAL `.env` first and writes
// second — a crash between those two steps (this is exactly where main.js persists an
// auto-detected DISCORD_GUILD_ID/OWNER_USER_IDS, and where a beginner's real bot token already
// lives via the gateway's own write path) leaves a truncated or empty file behind. A same-directory
// temp file + atomic rename means the real file is only ever replaced in one indivisible step:
// either the OLD complete content survives, or the NEW complete content does — never a half-write.
// A simple exclusive lock file (with a stale-lock timeout) guards against this process and the
// gateway's OWN separate writer (gateway/src/discord-service.mjs — deliberately NOT shared code;
// see this file's header) racing on the same `.env` at once. Same shape as that gateway copy,
// intentionally duplicated rather than imported (the two packages stay black-box supervised).
const ENV_LOCK_STALE_MS = 5000;
const ENV_LOCK_RETRY_MS = 25;
const ENV_LOCK_TIMEOUT_MS = 2000;

function sleepSyncMs(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) { /* deliberate busy-wait fallback, bounded by `ms` */ }
  }
}

// WP-L2 finding 5/N3/N4 — same fix, same reasoning as gateway/src/discord-service.mjs's own copy of
// this exact lock shape (deliberately duplicated, not shared — see this file's own header). Age-only
// staleness had three real bugs: (1) a lock that cannot be removed (e.g. a DIRECTORY sitting at the
// lock path — `fs.rmSync(path, {force:true})` throws `ERR_FS_EISDIR` for that, and the old code's
// blanket `catch { continue; }` swallowed it and looped back with NO backoff — a genuine, permanent
// spin, not a bounded wait); (2) a lock older than ENV_LOCK_STALE_MS was reclaimed unconditionally
// even while its real owner was still alive and mid-write; (3) release deleted whatever sat at the
// lock path with no check that it was still OUR OWN lock. The lock file's content is now
// `{owner, pid, ts}`; a lock is reclaimed ONLY once it is BOTH past the timeout AND its owner is
// provably gone (unreadable content, or `process.kill(pid, 0)` throwing `ESRCH` specifically — any
// other outcome is treated as "still alive", never a guessed steal). Release deletes the file ONLY
// when it still shows OUR OWN owner id. Every retry path funnels through ONE deadline check before
// backing off — no path can spin without re-checking the clock.
function isEnvLockOwnerPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true; // no error: the process exists and we have permission to signal it
  } catch (err) {
    // ESRCH is the only outcome that proves the process is actually gone — anything else (e.g.
    // EPERM: it exists but belongs to another user) cannot prove that, so treat it as still alive.
    return !(err && err.code === 'ESRCH');
  }
}

/** Reads and parses the lock file's `{owner, pid, ts}` content. Returns `null` on ANY problem —
 *  missing file, a directory at that path, invalid JSON, or a foreign/older-format payload — all
 *  treated identically as "cannot prove who (if anyone) still owns this lock", never thrown. */
function readEnvLockHolder(lockPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    return parsed && typeof parsed.owner === 'string' && typeof parsed.pid === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

function acquireEnvLock(targetPath) {
  const lockPath = targetPath + '.lock';
  const ownerId = crypto.randomUUID();
  const deadline = Date.now() + ENV_LOCK_TIMEOUT_MS;
  // Every "not acquired yet" path funnels through this ONE deadline check + bounded sleep — never a
  // bare `continue` that skips it — so no path can spin without ever re-checking the clock.
  const waitOrThrow = (detail) => {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for the lock on ${path.basename(targetPath)} — another write is in progress` + (detail ? ` (${detail})` : ''));
    }
    sleepSyncMs(ENV_LOCK_RETRY_MS);
  };
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeSync(fd, JSON.stringify({ owner: ownerId, pid: process.pid, ts: Date.now() }));
      } finally {
        fs.closeSync(fd);
      }
      return { lockPath, ownerId };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }

    let st;
    try {
      st = fs.statSync(lockPath);
    } catch (statErr) {
      if (statErr.code === 'ENOENT') continue; // vanished between our failed open() and here — retry now
      waitOrThrow(`could not check the lock: ${statErr.message}`);
      continue;
    }

    if (Date.now() - st.mtimeMs > ENV_LOCK_STALE_MS) {
      const holder = readEnvLockHolder(lockPath);
      const holderAlive = holder !== null && isEnvLockOwnerPidAlive(holder.pid);
      if (!holderAlive) {
        try {
          fs.rmSync(lockPath, { force: true }); // force:true only ever swallows ENOENT; anything else really failed
          continue; // removed (or already gone) — retry the exclusive open immediately
        } catch (rmErr) {
          waitOrThrow(`could not remove the stale lock: ${rmErr.message}`);
          continue;
        }
      }
      // Past the staleness window but the owner is confirmed still alive (or we could not prove
      // otherwise) — a slow write, not a crash. Never steal it on age alone.
    }

    waitOrThrow();
  }
}

function releaseEnvLock(lock) {
  try {
    const holder = readEnvLockHolder(lock.lockPath);
    // Only delete a lock file that still proves it is OURS — if it is unreadable (already reclaimed
    // by someone else) or now shows a DIFFERENT owner id, deleting it would remove another writer's
    // real, live lock.
    if (holder === null || holder.owner !== lock.ownerId) return;
    fs.rmSync(lock.lockPath, { force: true });
  } catch {
    /* best-effort only — a leftover lock older than ENV_LOCK_STALE_MS self-heals on the next write */
  }
}

function atomicWriteFileSync(targetPath, content) {
  const dir = path.dirname(targetPath);
  const tmpPath = path.join(dir, `.${path.basename(targetPath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  let mode;
  try {
    mode = fs.statSync(targetPath).mode;
  } catch {
    mode = undefined;
  }
  const fd = fs.openSync(tmpPath, 'w', mode);
  try {
    fs.writeSync(fd, content, null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (mode !== undefined) {
    try {
      fs.chmodSync(tmpPath, mode);
    } catch {
      /* best-effort only */
    }
  }
  try {
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    // A REAL process crash right here would leave the temp file behind regardless — nothing can be
    // done about that case. But when the failure is a catchable JS exception (this process is still
    // alive to run the catch block), clean up the orphan rather than leaving debris in a directory
    // that is supposed to contain only `.env`.
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      /* best-effort cleanup only — the original error below is what matters */
    }
    throw err;
  }
}

/**
 * Reads the real `.env` (or treats a missing file as empty — never throws on ENOENT, matching
 * every other `.env` reader in this codebase), merges `updates` via `mergeEnvText`, and writes the
 * result back atomically (temp file + rename, guarded by a lock file). Never logs `updates` or the
 * resulting content — this is the one function in this module that touches disk, kept tiny and
 * separate from the pure merge above so nothing here ever needs to be mocked to unit-test the
 * actual merge behavior.
 * @param {string} cwd
 * @param {Readonly<Record<string, string>>} updates
 * @param {string} [envFile]
 */
export function writeEnvValues(cwd, updates, envFile = '.env') {
  const target = path.join(cwd, envFile);
  const lock = acquireEnvLock(target);
  try {
    let raw = '';
    try {
      raw = fs.readFileSync(target, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    atomicWriteFileSync(target, mergeEnvText(raw, updates));
  } finally {
    releaseEnvLock(lock);
  }
}

// Test-only seam (same convention as gateway/src/discord-service.mjs's own
// _acquireEnvLockForTests/_releaseEnvLockForTests): gives a unit test direct, precise access to the
// lock primitives themselves, without needing to race the full writeEnvValues() path to exercise a
// specific lock-contention scenario.
export function _acquireEnvLockForTests(targetPath) {
  return acquireEnvLock(targetPath);
}
export function _releaseEnvLockForTests(lock) {
  return releaseEnvLock(lock);
}
