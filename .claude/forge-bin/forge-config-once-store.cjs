#!/usr/bin/env node
'use strict';
/**
 * forge-config-once-store.cjs — the exactly-once PENDING/CONSUMED grant store for a `--once` approval
 * (V09 FIFTH fix, Codex recheck 2026-09-24, out-p11 + Security Boss addendum: "a delayed reclaimer
 * captured a newer live holder... two actual consumeOnce() calls return success for one approval").
 * Split out of forge-config-once.cjs to keep that file under this project's file-size guidance.
 *
 * WHY A SEPARATE FILE-BASED STORE: every earlier V09 fix hardened forge-config-once.cjs's cross-process
 * FILE LOCK (withLock) — but consumeOnce() itself never had any exclusivity of its own; it trusted that
 * lock completely. Out-p11 proved that trust misplaced: a lock reclaim/release race can still let two
 * callers both believe they hold exclusive access to FORGE_CONFIG.json at once, and the OLD consumeOnce()
 * (forge-config.cjs) had nothing else standing between that race and honouring the approval twice.
 *
 * THE FIX IS STRUCTURAL, NOT A TIGHTER LOCK: an armed `--once` grant is written to its OWN file —
 * `<configDir>/FORGE_CONFIG.once.<key>.pending.json` — and consuming it is exactly ONE
 * `fs.renameSync(pendingPath, consumedPath)`. `fs.renameSync` on a shared SOURCE name is atomic at the OS
 * level (POSIX `rename(2)`; Windows via libuv's `MoveFileExW`): of any number of callers racing to rename
 * the SAME source, at most one can find and move it — every other caller's rename throws ENOENT. This
 * holds REGARDLESS of what forge-config-once.cjs's own lock did or did not serialize around it — two
 * callers can enter this function in any interleaving whatsoever and still never both win the rename. The
 * FORGE_CONFIG.json mirror entry (consumed_at, consumed_command_sha256) stays for `list`/`explain`/`get`
 * display only; it is written by the caller (forge-config.cjs::consumeOnce) AFTER this store already
 * decided the real outcome, never before, and never as part of what makes the guarantee true.
 *
 * API  oncePendingPath, onceConsumedPath, readOnceEntryInPlace, writePendingOnceGrant,
 *      removePendingOnceGrant, consumeOnceGrant. Zero-dependency (fs/path/crypto).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { onceState } = require('./forge-config-once.cjs');

function oncePendingPath(configDir, key) {
  return path.join(configDir, 'FORGE_CONFIG.once.' + key + '.pending.json');
}

/** onceConsumedPath(configDir, key, commandSha256) -> a fresh, unique path that embeds the approved
 *  command's sha256 (evidence, per the design brief) plus this process's pid and a random suffix — the
 *  destination never needs to be predictable across racers: only ONE caller's rename onto ANY destination
 *  name can ever win the source-side race (see file header), so a unique destination per attempt simply
 *  avoids ever clobbering an older, already-consumed audit record. */
function onceConsumedPath(configDir, key, commandSha256) {
  const shaPart = typeof commandSha256 === 'string' && commandSha256 ? commandSha256.slice(0, 16) : 'nosha';
  return path.join(configDir, 'FORGE_CONFIG.once.' + key + '.consumed.' + shaPart + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.json');
}

/** readOnceEntryInPlace(filePath) -> parsed JSON object, or null (absent / unreadable / not an object) —
 *  one open+fstat+read+close on a single fd, the same non-destructive-inspection discipline
 *  forge-config-once.cjs's own readLockInPlace uses; never renames or removes anything. */
function readOnceEntryInPlace(filePath) {
  let fd;
  try { fd = fs.openSync(filePath, 'r'); }
  catch { return null; } // absent or unreadable — nothing to inspect, never guess
  try {
    const st = fs.fstatSync(fd);
    const buf = Buffer.alloc(st.size);
    if (st.size > 0) fs.readSync(fd, buf, 0, st.size, 0);
    const parsed = JSON.parse(buf.toString('utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; } // corrupt/partial content is never treated as a live grant
  finally { try { fs.closeSync(fd); } catch { /* already closed */ } }
}

/** writePendingOnceGrant(configDir, key, entry) -> the path written. Atomic create-or-replace (temp file
 *  in the same directory, fsynced, then renamed onto the fixed pending pathname) — overwrites any earlier
 *  pending file for this key, which is safe because forge-config.cjs::setOnce() only calls this AFTER its
 *  own mirror-based "already armed" check has already refused re-issuing over a live grant. Throws (writes
 *  nothing durable) on any I/O failure — the caller's whole setOnce() must then fail closed rather than
 *  leave a mirror entry with no matching pending file to ever consume. */
function writePendingOnceGrant(configDir, key, entry) {
  fs.mkdirSync(configDir, { recursive: true });
  const target = oncePendingPath(configDir, key);
  const tmp = target + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  let fd;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, JSON.stringify(entry, null, 2) + '\n');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, target);
  } catch (e) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } }
    try { fs.unlinkSync(tmp); } catch { /* never created, or already gone */ }
    throw e;
  }
  return target;
}

/** removePendingOnceGrant(configDir, key) -> void, never throws. Hygiene only: called when an ordinary
 *  `set <key> on` (or unset) explicitly ends a still-pending grant early, so no orphaned pending file is
 *  left for a later run to trip over. Consumption safety never depends on this running — a missing pending
 *  file is simply reason:'absent' to consumeOnceGrant(). */
function removePendingOnceGrant(configDir, key) {
  try { fs.unlinkSync(oncePendingPath(configDir, key)); } catch { /* already gone, or never existed — fine */ }
}

/** consumeOnceGrant(configDir, key, nowMs, commandSha256) -> { ok:true, entry } |
 *  { ok:false, reason:'absent'|'clock'|'expired'|'consumed' }. THE single atomic use, independent of any
 *  lock (see file header). Validates the pending file's own content with the EXACT SAME clock-rollback /
 *  tampered-expiry / real-expiry rules onceState() already applies to the mirror (forge-config-once.cjs),
 *  so a hand-edited or backdated pending file can never extend its own window. Only when still armed does
 *  it attempt ONE `fs.renameSync(pendingPath, consumedPath)`; ENOENT there means a DIFFERENT caller's
 *  rename already won (reason:'consumed'); any other failure is reported as 'absent' — never as an
 *  approval. The post-rename content update on the now-exclusively-owned consumedPath is best effort: the
 *  single use already happened via the rename itself and cannot be undone by a failed follow-up write. */
function consumeOnceGrant(configDir, key, nowMs, commandSha256) {
  const pendingPath = oncePendingPath(configDir, key);
  const ent = readOnceEntryInPlace(pendingPath);
  if (!ent || typeof ent.expires_at !== 'string') return { ok: false, reason: 'absent' };
  const setAtMs = typeof ent.set_at === 'string' ? Date.parse(ent.set_at) : NaN;
  if (!Number.isFinite(setAtMs) || nowMs < setAtMs) return { ok: false, reason: 'clock' };
  const st = onceState(ent, nowMs);
  if (!st || st.expired) return { ok: false, reason: 'expired' };
  const consumedPath = onceConsumedPath(configDir, key, commandSha256);
  try {
    fs.renameSync(pendingPath, consumedPath);
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: false, reason: 'consumed' }; // someone else's rename won first
    return { ok: false, reason: 'absent' }; // an unexpected I/O problem is never treated as an approval
  }
  try {
    const updated = Object.assign({}, ent, {
      consumed_at: new Date(nowMs).toISOString(),
      consumed_command_sha256: typeof commandSha256 === 'string' && commandSha256 ? commandSha256 : null,
    });
    fs.writeFileSync(consumedPath, JSON.stringify(updated, null, 2) + '\n');
  } catch { /* the rename above already committed the single use; a failed content update never undoes it */ }
  return { ok: true, entry: ent };
}

module.exports = {
  oncePendingPath, onceConsumedPath, readOnceEntryInPlace,
  writePendingOnceGrant, removePendingOnceGrant, consumeOnceGrant,
};
