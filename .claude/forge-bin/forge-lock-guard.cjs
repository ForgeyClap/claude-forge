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

/** ATOMISCHE CLAIM MET CAS-TOKEN (audit G2, 2026-08-06 · Codex r4 #3/#4, 2026-08-07). acquire was
 *  read-then-write: twee gelijktijdige contenders kregen beide ok:true. Daarna bleef over: (a) refresh op
 *  run_id-gelijkheid — twee agents met DEZELFDE runId maar andere identiteit refreshten elkaars lock weg;
 *  (b) release/reap die na hun read een verse opvolger konden verwijderen; (c) een nascent/corrupt lock
 *  (crash tussen create en volledige write) die permanent onherstelbaar was. Nu:
 *  - iedere acquire krijgt een uniek CAS-token (crypto.randomUUID); refresh en release slagen UITSLUITEND
 *    met dat token — run_id-gelijkheid alleen is geen eigendom meer;
 *  - de claim is full-content-atomair: JSON naar een gefsyncte temp, dan linkSync (hardlink) naar de
 *    locknaam — EEXIST bij contention, en de naam draagt NOOIT een half geschreven record (#4);
 *  - steal/reap verplaatst het verlopen bestand ino-geverifieerd naar een uniek graveyard-pad (rename)
 *    i.p.v. unlink: raakt de rename per ongeluk toch een verse opvolger, dan detecteert die opvolger het
 *    verlies bij zijn eerstvolgende token-refresh (bestand weg ⇒ ok:false) — één schrijver, nooit twee;
 *  - een onparseerbaar lockbestand ouder dan NASCENT_MAX_MS is een crash-artefact en wordt gereapt;
 *    jonger wachten we af (de schrijver kan er nog mee bezig zijn);
 *  - een absurde expires_at wordt geklemd op acquired_at (of mtime) + TTL_CLAMP_MS zodat een
 *    vooruitlopende klok een hotspot niet dagenlang kan vastzetten (#4). */
const NASCENT_MAX_MS = 5000;
const TTL_CLAMP_MS = 24 * 60 * 60 * 1000; // 24h — geen enkele legitieme Boss-taak houdt een hotspot langer
function effectiveExpiry(rec, file) {
  // r5 #13: acquired_at komt van de (mogelijk vooruitgesprongen) klok van de claimer — na klokherstel
  // kon de klem zelf nog dagen in de toekomst liggen. De basis is nu het MINIMUM van acquired_at, de
  // bestands-mtime en NU: geen enkele component kan de bovengrens verder dan TTL_CLAMP vooruit duwen.
  let mtime = Infinity;
  try { mtime = fs.statSync(file).mtimeMs; } catch { }
  const base = Math.min(Number.isFinite(rec.acquired_at) ? rec.acquired_at : Infinity, mtime, Date.now());
  const claimed = Number.isFinite(rec.expires_at) ? rec.expires_at : 0;
  return Math.min(claimed, base + TTL_CLAMP_MS);
}
function tryCreateExclusive(file, rec) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.' + Math.random().toString(36).slice(2, 8) + '.tmp';
  try {
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, JSON.stringify(rec, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.linkSync(tmp, file);
    fs.unlinkSync(tmp);
    return true;
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { }
    if (e.code === 'EEXIST') return false;
    throw e;
  }
}
function replaceOwnAtomic(file, rec) {
  const tmp = file + '.' + process.pid + '.' + Math.random().toString(36).slice(2, 8) + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n'); fs.renameSync(tmp, file); return true; }
  catch (e) { try { fs.unlinkSync(tmp); } catch { } return false; }
}
/** reapToGraveyard — verwijder een verloren/verlopen lock zonder het gedeelde pad te unlinken: rename naar
 *  een uniek pad. Ino-geverifieerd; het restvenster (rename raakt een NET vervangen bestand) wordt door de
 *  token-refresh van de opvolger gedetecteerd (bestand weg ⇒ refresh faalt ⇒ opvolger stopt eerlijk). */
function reapToGraveyard(file, st1) {
  const grave = file + '.reaped.' + Date.now() + '.' + Math.random().toString(36).slice(2, 8);
  try {
    const st2 = fs.statSync(file, { bigint: true });
    if (st2.ino !== st1.ino || st2.birthtimeMs !== st1.birthtimeMs) return false;
    fs.renameSync(file, grave);
    try { fs.unlinkSync(grave); } catch { /* opruimen is best-effort; het pad is vrij */ }
    return true;
  } catch { return false; }
}
function classifyLockFile(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return { state: 'missing' }; }
  try { const v = JSON.parse(raw); if (v && typeof v === 'object' && !Array.isArray(v)) return { state: 'valid', rec: v }; } catch { }
  let ageMs = 0;
  try { ageMs = Date.now() - fs.statSync(file).mtimeMs; } catch { return { state: 'missing' }; }
  return { state: ageMs > NASCENT_MAX_MS ? 'corrupt-old' : 'nascent', ageMs };
}
function acquire({ hotspot, runId, owner, note, token } = {}, opts = {}) {
  if (!hotspot || !runId) return { ok: false, reason: 'hotspot and runId are required' };
  const dir = dirOf(opts), t = clock(opts), ttl = (opts.ttlMs && opts.ttlMs > 0) ? opts.ttlMs : DEFAULT_TTL_MS;
  const file = lockFile(dir, hotspot);
  const myToken = token || crypto.randomUUID();
  const rec = { hotspot: normHotspot(hotspot), run_id: runId, owner: owner || runId, token: myToken, acquired_at: t, ttl_ms: ttl, expires_at: t + ttl, note: note || '' };
  let stolenFrom = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (tryCreateExclusive(file, rec)) return stolenFrom ? { ok: true, lock: rec, token: myToken, stolenFromExpired: stolenFrom } : { ok: true, lock: rec, token: myToken };
    const cls = classifyLockFile(file);
    if (cls.state === 'missing') continue; // verdween onder ons — opnieuw de exclusieve create proberen
    if (cls.state === 'nascent') { if (opts.sleep !== false) sleepBrief(); continue; } // schrijver kan nog bezig zijn
    if (cls.state === 'corrupt-old') {
      // crash-artefact (#4): ino-geverifieerd reapen, daarna beslist de create-lus
      try { const st1 = fs.statSync(file, { bigint: true }); reapToGraveyard(file, st1); } catch { }
      continue;
    }
    const existing = cls.rec;
    const expired = t >= effectiveExpiry(existing, file);
    if (!expired && existing.token && token && existing.token === token) {
      // CAS-refresh: alleen de houder van het exacte token mag zijn eigen, niet-verlopen lock verversen.
      if (replaceOwnAtomic(file, rec)) return { ok: true, lock: rec, token: myToken, refreshed: true };
      continue;
    }
    if (!expired) {
      return { ok: false, reason: 'hotspot locked by another holder', conflict: {
        hotspot: existing.hotspot, held_by_run: existing.run_id, owner: existing.owner,
        acquired_at: existing.acquired_at, expires_at: existing.expires_at, remaining_ms: Math.max(0, effectiveExpiry(existing, file) - t) } };
    }
    // expired (ook een eigen verlopen lock): ino-geverifieerde graveyard-rename, dan beslist de wx-create
    try {
      const st1 = fs.statSync(file, { bigint: true });
      const again = readLock(file);
      if (again && clock(opts) >= effectiveExpiry(again, file)) {
        if (reapToGraveyard(file, st1)) stolenFrom = again.run_id;
      }
    } catch { /* bestand weg — prima, de create-lus beslist */ }
  }
  return { ok: false, reason: 'lock kept changing under contention (4 attempts) — refusing to guess a winner' };
}
function sleepBrief() { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); } catch { } }

/** refresh — expliciete CAS-verlenging: slaagt uitsluitend wanneer het lockbestand nog bestaat, niet
 *  verlopen is en het exacte token draagt. Bestand weg of token anders = lock verloren ⇒ ok:false, zodat
 *  een houder die (onterecht) bestolen is dat DETECTEERT en stopt in plaats van door te schrijven. */
function refresh({ hotspot, runId, token } = {}, opts = {}) {
  if (!hotspot || !runId || !token) return { ok: false, reason: 'hotspot, runId and token are required' };
  const dir = dirOf(opts), t = clock(opts), ttl = (opts.ttlMs && opts.ttlMs > 0) ? opts.ttlMs : DEFAULT_TTL_MS;
  const file = lockFile(dir, hotspot);
  const existing = readLock(file);
  if (!existing) return { ok: false, reason: 'lock lost (file gone) — holder must stop writing this hotspot' };
  if (existing.token !== token) return { ok: false, reason: 'lock lost (token mismatch — taken over by ' + existing.run_id + ')' };
  if (t >= effectiveExpiry(existing, file)) return { ok: false, reason: 'lock already expired — re-acquire instead of refresh' };
  const rec = Object.assign({}, existing, { acquired_at: existing.acquired_at, ttl_ms: ttl, expires_at: t + ttl, refreshed_at: t });
  if (replaceOwnAtomic(file, rec)) return { ok: true, lock: rec };
  return { ok: false, reason: 'refresh write failed' };
}

function release({ hotspot, runId, token } = {}, opts = {}) {
  if (!hotspot || !runId) return { ok: false, reason: 'hotspot and runId are required' };
  const file = lockFile(dirOf(opts), hotspot);
  const existing = readLock(file);
  if (!existing) return { ok: true, released: false, reason: 'no lock held' };
  if (existing.run_id !== runId) return { ok: false, released: false, reason: 'lock owned by ' + existing.run_id + ', not ' + runId };
  // CAS: een lock MET token vereist het token (r4 #3); legacy-locks zonder token vallen terug op run_id.
  if (existing.token && token !== existing.token) return { ok: false, released: false, reason: 'token mismatch — only the exact acquirer may release' };
  try {
    const st1 = fs.statSync(file, { bigint: true });
    if (!reapToGraveyard(file, st1)) return { ok: false, released: false, reason: 'lock changed under release — refusing' };
  } catch { return { ok: true, released: false, reason: 'no lock held' }; }
  return { ok: true, released: true };
}

function check({ hotspot } = {}, opts = {}) {
  if (!hotspot) return { held: false, reason: 'hotspot is required' };
  const t = clock(opts);
  const file = lockFile(dirOf(opts), hotspot);
  const cls = classifyLockFile(file);
  if (cls.state === 'missing') return { held: false };
  if (cls.state === 'nascent' || cls.state === 'corrupt-old') return { held: false, corrupt: true, state: cls.state };
  const expired = t >= effectiveExpiry(cls.rec, file);
  return { held: !expired, expired, lock: cls.rec };
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
  for (const f of files) {
    const p = path.join(dir, f);
    const cls = classifyLockFile(p);
    // verlopen locks EN oude crash-artefacten (#4) — beide ino-geverifieerd via de graveyard-rename,
    // zodat een verse opvolger nooit per unlink verdwijnt.
    const reapIt = (cls.state === 'valid' && t >= effectiveExpiry(cls.rec, p)) || cls.state === 'corrupt-old';
    if (!reapIt) continue;
    try { const st1 = fs.statSync(p, { bigint: true }); if (reapToGraveyard(p, st1)) { reaped++; list.push(cls.rec ? cls.rec.hotspot : f); } } catch { }
  }
  return { reaped, reapedList: list };
}

module.exports = { acquire, refresh, release, check, heldLocks, reapStale, keyOf, normHotspot, classifyLockFile, LOCK_DIR, DEFAULT_TTL_MS, NASCENT_MAX_MS, TTL_CLAMP_MS };

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
      if (!hotspot || !runId) { console.error('usage: acquire <hotspot> --run <id> [--owner <name>] [--ttl <ms>] [--token <cas-token>] [--note "..."]'); process.exit(2); }
      const r = acquire({ hotspot, runId, owner: flag('--owner'), note: flag('--note'), token: flag('--token') }, { ttlMs: ttl });
      if (!json) console.log(r.ok ? ('LOCK acquired · ' + normHotspot(hotspot) + ' · run=' + runId + ' · token=' + r.token + (r.refreshed ? ' (refreshed)' : r.stolenFromExpired ? ' (stolen from expired ' + r.stolenFromExpired + ')' : '')) : (r.conflict ? ('CONFLICT · ' + normHotspot(hotspot) + ' held by run=' + r.conflict.held_by_run + ' · ' + Math.round(r.conflict.remaining_ms / 1000) + 's remaining') : ('DENIED · ' + r.reason)));
      out(r, r.ok ? 0 : 3);
    } else if (cmd === 'refresh') {
      const token = flag('--token');
      if (!hotspot || !runId || !token) { console.error('usage: refresh <hotspot> --run <id> --token <cas-token> [--ttl <ms>]'); process.exit(2); }
      const r = refresh({ hotspot, runId, token }, { ttlMs: ttl });
      if (!json) console.log(r.ok ? ('REFRESHED · ' + normHotspot(hotspot) + ' · verloopt over ' + Math.round((r.lock.expires_at - Date.now()) / 1000) + 's') : ('LOST · ' + r.reason));
      out(r, r.ok ? 0 : 3);
    } else if (cmd === 'release') {
      // r4 #3: release VEREIST --run (en bij een token-dragende lock ook --token) — een release zonder
      // eigenaarsbewijs kon de lock van een ander stilletjes vrijgeven.
      if (!hotspot || !runId) { console.error('usage: release <hotspot> --run <id> [--token <cas-token>]'); process.exit(2); }
      const r = release({ hotspot, runId, token: flag('--token') });
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
