#!/usr/bin/env node
'use strict';
/**
 * forge-lock-guard.cjs — mechanical HOTSPOT WRITE-LOCK (2026-07-24). Zero-dependency (fs/path/crypto only),
 * Windows-safe. The FIRST mechanical enforcement of the "one writer per hotspot at a time" HARD MUST that,
 * until now, lived ONLY as prose in the owner's global CLAUDE.md — hand-written there after a real
 * 2026-07-22 incident where a second workflow clobbered files a still-running first workflow was editing.
 *
 * WHAT IT IS (and is NOT): a plain, callable CJS module the Lead / forge-router invokes BEFORE dispatching a
 * Boss that will write a declared hotspot file (build/sync manifests, event registries, doctor/config,
 * dashboards, or a project's core files). It is NOT a settings.json hook and NEVER auto-fires — that keeps
 * Forge's security-light "no mandatory gates / no auto-hooks" posture fully intact. An owner who wants
 * belt-and-suspenders PreToolUse enforcement can wire the documented opt-in snippet themselves (see
 * config/orchestration/HOOKS_OPT_IN.md); this module remains the primary, in-session guard.
 *
 * HONEST LIMITATION: this is an ADVISORY, single-orchestrator lock. Separate Agent-tool subagents do not
 * share one process, so the guarantee is "the Lead, before it dispatches a second writer, is told a first
 * writer already holds the hotspot" — not a kernel-level concurrent mutex. That is exactly the failure mode
 * the 2026-07-22 incident was (one orchestrator launching an overlapping run), so an orchestrator-invoked
 * check closes the real risk. TTL-expiry keeps a crashed run from wedging a hotspot forever.
 *
 * STORAGE (project-local, honors isolation — never a global/shared dir): one JSON file per held hotspot under
 * .claude/forge-runs/.hotspot-locks/<sha1(hotspot)[..16]>.json. The record:
 *   { hotspot, run_id, owner, acquired_at, ttl_ms, expires_at, note }
 * A hotspot is HELD iff its lock file exists AND now < expires_at. Held-set is a projection over that dir.
 *
 * MODEL (pure except the explicit lock-file writes; every fn takes opts.dir / opts.now for hermetic tests):
 *   acquire({hotspot, runId, owner, note}, opts) -> {ok, lock?|conflict?, refreshed?, stolenFromExpired?, reason?}
 *     ok:true  — lock is now yours (fresh, refreshed by same run, or stolen from an EXPIRED holder).
 *     ok:false — a DIFFERENT run holds it and it has not expired; `conflict` names the owning run_id + remaining_ms.
 *   release({hotspot, runId}, opts) -> {ok, released, reason?}  (only the owning run may release; unknown lock = no-op ok)
 *   check({hotspot}, opts)          -> {held, expired?, lock?}
 *   heldLocks(opts)                 -> [{...lock, expired}]  every lock file currently on disk (expired flagged)
 *   reapStale(opts)                 -> {reaped, reapedList}   deletes only EXPIRED lock files (housekeeping)
 *   keyOf(hotspot) / normHotspot(hotspot) — deterministic key + normalization (case/sep-insensitive).
 *
 * CLI (exit codes mirror forge-mcp-gate/forge-actiongate: 0 ok · 3 conflict/denied · 2 usage/config error):
 *   node forge-lock-guard.cjs acquire <hotspot> --run <id> [--owner <name>] [--ttl <ms>] [--note "..."] [--json]
 *   node forge-lock-guard.cjs release <hotspot> --run <id> [--json]
 *   node forge-lock-guard.cjs check   <hotspot> [--json]
 *   node forge-lock-guard.cjs list    [--json]
 *   node forge-lock-guard.cjs reap    [--json]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROJECT_ROOT = process.env.FORGE_PROJECT_ROOT ? path.resolve(process.env.FORGE_PROJECT_ROOT) : path.resolve(__dirname, '..', '..');
const LOCK_DIR = path.join(PROJECT_ROOT, '.claude', 'forge-runs', '.hotspot-locks');
const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 min — long enough for a real Boss task, short enough to auto-heal a crash

function normHotspot(h) {
  return String(h || '').replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '').replace(/\/{2,}/g, '/').toLowerCase().trim();
}
function keyOf(h) { return crypto.createHash('sha1').update(normHotspot(h)).digest('hex').slice(0, 16); }
function dirOf(opts) { return (opts && opts.dir) || LOCK_DIR; }
function clock(opts) { return (opts && typeof opts.now === 'number') ? opts.now : Date.now(); }
function lockFile(dir, h) { return path.join(dir, keyOf(h) + '.json'); }
function readLock(file) { try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return (v && typeof v === 'object' && !Array.isArray(v)) ? v : null; } catch { return null; } }
function writeLock(file, rec) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(rec, null, 2) + '\n'); }

function acquire({ hotspot, runId, owner, note } = {}, opts = {}) {
  if (!hotspot || !runId) return { ok: false, reason: 'hotspot and runId are required' };
  const dir = dirOf(opts), t = clock(opts), ttl = (opts.ttlMs && opts.ttlMs > 0) ? opts.ttlMs : DEFAULT_TTL_MS;
  const file = lockFile(dir, hotspot);
  const rec = { hotspot: normHotspot(hotspot), run_id: runId, owner: owner || runId, acquired_at: t, ttl_ms: ttl, expires_at: t + ttl, note: note || '' };
  const existing = readLock(file);
  if (existing) {
    const expired = t >= (existing.expires_at || 0);
    if (existing.run_id === runId) { writeLock(file, rec); return { ok: true, lock: rec, refreshed: true }; }
    if (!expired) {
      return { ok: false, reason: 'hotspot locked by another run', conflict: {
        hotspot: existing.hotspot, held_by_run: existing.run_id, owner: existing.owner,
        acquired_at: existing.acquired_at, expires_at: existing.expires_at, remaining_ms: Math.max(0, (existing.expires_at || 0) - t) } };
    }
    writeLock(file, rec); return { ok: true, lock: rec, stolenFromExpired: existing.run_id };
  }
  writeLock(file, rec); return { ok: true, lock: rec };
}

function release({ hotspot, runId } = {}, opts = {}) {
  if (!hotspot) return { ok: false, reason: 'hotspot is required' };
  const file = lockFile(dirOf(opts), hotspot);
  const existing = readLock(file);
  if (!existing) return { ok: true, released: false, reason: 'no lock held' };
  if (runId && existing.run_id !== runId) return { ok: false, released: false, reason: 'lock owned by ' + existing.run_id + ', not ' + runId };
  try { fs.unlinkSync(file); } catch {}
  return { ok: true, released: true };
}

function check({ hotspot } = {}, opts = {}) {
  if (!hotspot) return { held: false, reason: 'hotspot is required' };
  const t = clock(opts);
  const existing = readLock(lockFile(dirOf(opts), hotspot));
  if (!existing) return { held: false };
  const expired = t >= (existing.expires_at || 0);
  return { held: !expired, expired, lock: existing };
}

function heldLocks(opts = {}) {
  const dir = dirOf(opts), t = clock(opts);
  let files = []; try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const f of files) { const rec = readLock(path.join(dir, f)); if (rec) out.push(Object.assign({}, rec, { expired: t >= (rec.expires_at || 0) })); }
  return out.sort((a, b) => (a.acquired_at || 0) - (b.acquired_at || 0));
}

function reapStale(opts = {}) {
  const dir = dirOf(opts), t = clock(opts);
  let files = []; try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return { reaped: 0, reapedList: [] }; }
  let reaped = 0; const list = [];
  for (const f of files) { const p = path.join(dir, f); const rec = readLock(p); if (rec && t >= (rec.expires_at || 0)) { try { fs.unlinkSync(p); reaped++; list.push(rec.hotspot); } catch {} } }
  return { reaped, reapedList: list };
}

module.exports = { acquire, release, check, heldLocks, reapStale, keyOf, normHotspot, LOCK_DIR, DEFAULT_TTL_MS };

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const json = args.includes('--json');
  const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const positional = args.slice(1).filter((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--run' && args[args.indexOf(a) - 1] !== '--owner' && args[args.indexOf(a) - 1] !== '--ttl' && args[args.indexOf(a) - 1] !== '--note');
  const hotspot = positional[0];
  const runId = flag('--run');
  const ttl = flag('--ttl') ? parseInt(flag('--ttl'), 10) : undefined;
  const out = (obj, code) => { if (json) console.log(JSON.stringify(obj, null, 2)); process.exit(code); };
  try {
    if (cmd === 'acquire') {
      if (!hotspot || !runId) { console.error('usage: acquire <hotspot> --run <id> [--owner <name>] [--ttl <ms>] [--note "..."]'); process.exit(2); }
      const r = acquire({ hotspot, runId, owner: flag('--owner'), note: flag('--note') }, { ttlMs: ttl });
      if (!json) console.log(r.ok ? ('LOCK acquired · ' + normHotspot(hotspot) + ' · run=' + runId + (r.refreshed ? ' (refreshed)' : r.stolenFromExpired ? ' (stolen from expired ' + r.stolenFromExpired + ')' : '')) : ('CONFLICT · ' + normHotspot(hotspot) + ' held by run=' + r.conflict.held_by_run + ' · ' + Math.round(r.conflict.remaining_ms / 1000) + 's remaining'));
      out(r, r.ok ? 0 : 3);
    } else if (cmd === 'release') {
      if (!hotspot) { console.error('usage: release <hotspot> --run <id>'); process.exit(2); }
      const r = release({ hotspot, runId });
      if (!json) console.log(r.ok ? ('RELEASED · ' + normHotspot(hotspot) + (r.released ? '' : ' (was not held)')) : ('DENIED · ' + r.reason));
      out(r, r.ok ? 0 : 3);
    } else if (cmd === 'check') {
      if (!hotspot) { console.error('usage: check <hotspot>'); process.exit(2); }
      const r = check({ hotspot });
      if (!json) console.log(r.held ? ('HELD · ' + normHotspot(hotspot) + ' · run=' + r.lock.run_id) : ('FREE · ' + normHotspot(hotspot) + (r.expired ? ' (expired lock present)' : '')));
      out(r, 0);
    } else if (cmd === 'list') {
      const r = heldLocks();
      if (!json) { const active = r.filter((x) => !x.expired); console.log('hotspot locks · ' + active.length + ' active / ' + r.length + ' total'); active.forEach((x) => console.log('  ' + x.hotspot + '  run=' + x.run_id + '  owner=' + x.owner)); }
      out({ locks: r }, 0);
    } else if (cmd === 'reap') {
      const r = reapStale();
      if (!json) console.log('reaped ' + r.reaped + ' stale lock(s)' + (r.reaped ? ': ' + r.reapedList.join(', ') : ''));
      out(r, 0);
    } else {
      console.error('usage: node forge-lock-guard.cjs <acquire|release|check|list|reap> ...  (see header)');
      process.exit(2);
    }
  } catch (e) { console.error('forge-lock-guard error: ' + e.message); process.exit(2); }
}
