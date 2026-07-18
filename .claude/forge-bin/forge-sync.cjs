#!/usr/bin/env node
'use strict';
/**
 * Forge installer / sync — SAFE SYNC (2026-07-14 hardening WP1 + 2026-07-14 FIX ROUND). Zero-dependency
 * (fs/path/crypto/child_process/os only), Windows-safe. Replaces the old "fs.copyFileSync straight over the
 * project file, no backup, no canary, no validation, no rollback" design that made this the highest-blast-radius
 * file in Forge (one bad template could break all 12 projects with no undo).
 *
 * FIX ROUND (2026-07-14, this pass) closed 7 blockers + 4 high findings + 11 medium findings found by an
 * adversarial review, independent QA (mutation-tested), and a 4-lens pre-mortem swarm:
 *   B1 cumulative drift baseline (receipt.knownHashes, not just filesChanged)      B2 receipt itself is now
 *   backed up/restored on rollback   B3 "unreadable" != "missing" (refuses instead of treating as new)
 *   B4 rollback-batch reaches the central backup + counts only real successes     B5 default central backup
 *   hub (<root>/.forge-backup-hub)   B6 no more ~/Documents default for multi-project commands   B7 rollback
 *   refuses to clobber content that diverged since this sync wrote it (--force-rollback-newer to override)
 *   H1 rollback never claims "restored" without a post-restore verify   H2 install exits 1 + prints BLOCKED
 *   when drift blocks (was silently exit 0)   H3 pre-sync validation baseline distinguishes a genuine
 *   regression from pre-existing red   H4 validation requires positive evidence (forge-doctor --json), a
 *   degraded (no-doctor) pass needs --allow-degraded   M1-M11 (see inline // M<n> markers).
 *
 * SAFE FLOW (default for `install` and `sync-all`):
 *   1. PREFLIGHT   — classify every system file per project into: unchanged / to-change / expected_override
 *                     (declared in <project>/.claude/config/forge-overrides.json) / unknown_drift (project
 *                     changed, template didn't, no matching receipt) / conflict (BOTH project and template
 *                     changed since the last receipt) / eol_only (raw bytes differ ONLY by line-ending style
 *                     — always safe to sync, classification-only, RAW bytes still backed up/copied verbatim).
 *                     unknown_drift/conflict are NEVER silently overwritten. An existing-but-UNREADABLE system
 *                     file REFUSES the whole project sync (never silently treated as "new").
 *   2. BACKUP      — before ANY write: copy every file about to change into BOTH
 *                     <project>/.claude/forge-backups/<batchId>/<rel> (per-project) AND, when a
 *                     --central-backup-root is given (defaulted to <root>/.forge-backup-hub unless
 *                     --no-central-backup), <centralRoot>/.claude/forge-backups/<batchId>/<projectId>/<rel>.
 *                     manifest.json records batchId/ts/runId/templateVersion/projectId/projectPath/
 *                     files[{rel,oldHash,newHash,existed}]/hadVersionFile/oldVersion/hadReceipt/oldReceipt.
 *                     Reusing a --batch-id that already backed up THIS project refuses (pass --resume-batch).
 *   3. DRY-RUN     — `--dry-run` prints the full plan and writes NOTHING (including no lock file).
 *   4. TWO-STAGE CANARY — `sync-all` ALWAYS syncs a dedicated, disposable, dot-prefixed canary project
 *      (`.forge-canary/`, wiped and recreated fresh on every canary-init/sync-all run) FIRST — a real project
 *      can never occupy that slot. Only if it validates does sync-all sync ONE representative real project,
 *      then a staged ladder (2 -> 3 -> --stage-size thereafter, default 3) over the rest. ANY validation
 *      failure OR any unresolved unknown_drift/conflict (without --force-overwrite) rolls back that project
 *      and STOPS the whole batch — later projects stay byte-untouched. `--force-overwrite` in sync-all
 *      requires the explicit `--force-all` co-flag and prints the exact per-project forced file list first.
 *   5. VALIDATE    — spawn forge-doctor.cjs BOTH before (baseline) and after writing, with --json, and
 *      require POSITIVE EVIDENCE (node_check.total >= files just synced, tests.suites>0, tests.passed>0) —
 *      a bare exit code is never trusted. A post-sync failure that was ALREADY present pre-sync (same
 *      checks red before and after, and the node_check hard gate on the just-synced files is clean) is
 *      reported as "already-red, not attributed to this sync" rather than blamed on the sync. Missing
 *      forge-doctor -> DEGRADED node --check fallback; a degraded pass never counts as synced unless
 *      --allow-degraded is passed. A doctor timeout is BLOCKED, not a confirmed failure.
 *   6. RECEIPT     — <project>/.claude/forge-sync-receipt.json: projectId/projectPath, batchId, runId,
 *      templateVersionFrom/To, backupRef, pre/post-sync manifest hashes, filesChanged, knownHashes (the
 *      CUMULATIVE per-file baseline — every system file's last-known-good hash, carried forward across
 *      syncs so an untouched file never "forgets" its baseline), overridesPreserved, validation +
 *      preValidation (both baselines persisted), rollbackStatus, syncedAt.
 *   7. ROLLBACK    — restores byte-for-byte from whichever backup (project-local, else central) passes an
 *      integrity check; refuses (never fabricates "restored") when: the backup is missing/corrupt, the
 *      on-disk content has diverged from what this sync wrote (pass --force-rollback-newer), or a NEWER
 *      batch already touched the same file for this project. Every restored file is RE-VERIFIED by hash
 *      after restore — a file that could not actually be restored/verified is never counted as restored;
 *      the result is PARTIAL — MANUAL RECOVERY REQUIRED instead. forge-sync-receipt.json and
 *      FORGE_VERSION.json are restored/removed in the same pass. Journaled (resumable/idempotent).
 *   8. --unsafe    — skips canary + validation only. It STILL takes a real backup (never "no undo"), STILL
 *      honors the forge-overrides.json allow-list, STILL respects the containment/symlink guard, and STILL
 *      refuses on an unreadable existing file rather than treating it as "new" (S2 fix).
 *
 * `adopt <projectDir>` establishes a baseline receipt from a project's CURRENT file hashes without writing
 * a single template/system file — prints which files differ from the template so a human can triage them
 * into forge-overrides.json. This replaces a blind --force-overwrite for a project's very first safe sync.
 * S5: adopt REFUSES to replace an already-adopted baseline unless --force is passed (a second adopt would
 * otherwise silently un-protect every previously-drifted file); --force snapshots the pre-adopt receipt first.
 *
 * NOT BUILT (honest gap, not silently ignored): forge-sync has never had a mechanism for the template to
 * DELETE/prune a project's system file (SYSTEM/SYSTEM_GLOB is purely additive). Out of scope here; rollback
 * already supports restoring an ADDED file back to non-existence (oldHash:null), the one deletion-shaped
 * case this tool can actually produce today.
 *
 * Usage:
 *   node forge-sync.cjs status [<projectDir>] [--verbose]
 *   node forge-sync.cjs install <projectDir> [--dry-run] [--force-overwrite] [--unsafe] [--batch-id <id>]
 *     [--central-backup-root <dir>] [--no-central-backup] [--run-id <id>] [--allow-degraded]
 *     [--doctor-timeout <ms>] [--resume-batch]
 *   node forge-sync.cjs adopt <projectDir> [--dry-run] [--force]
 *   node forge-sync.cjs list <rootDir>                                    # root REQUIRED (no ~/Documents default)
 *   node forge-sync.cjs canary-init <rootDir>                             # root REQUIRED; wipes+recreates the canary
 *   node forge-sync.cjs sync-all <rootDir> [--canary <projectName>] [--stage-size N] [--dry-run]
 *     [--force-overwrite --force-all] [--unsafe] [--batch-id <id>] [--central-backup-root <dir>]
 *     [--no-central-backup] [--run-id <id>] [--allow-degraded] [--doctor-timeout <ms>]
 *   node forge-sync.cjs doctor [<projectDir>]                             # alias for status
 *   node forge-sync.cjs rollback <projectDir> [--batch <batchId>] [--central-backup-root <dir>]
 *     [--force-rollback-newer]
 *   node forge-sync.cjs rollback-batch <batchId> <rootDir> [--central-backup-root <dir>] [--force-rollback-newer]
 *
 * Exit codes: 0 = all projects synced+validated (or a read-only command succeeded); 1 = batch aborted /
 * rolled back / operational refusal (bad path, missing backup, drift-blocked, etc.); 2 = usage error.
 *
 * Module API (for direct unit testing — every exported function takes its root/template dir as an explicit
 * argument; NONE of them call Date.now()/generate their own batchId — batchId/nowIso are always injected by
 * the caller so tests stay deterministic):
 *   listSystemFiles, sha256, sha256Normalized, fileStatus, templateVersion, claudeDirOf, safeJoin,
 *   isSymlinkPath, containmentSafe, projectId, receiptPath, readReceipt, writeReceipt,
 *   receiptLastTemplateHashMap, readOverrideAllowlist, preflight, buildPlan, fullFileManifest,
 *   aggregateManifestHash, backupDirFor, centralBackupDir, takeBackup, applyPlanSafely, runValidation,
 *   decideValidationOutcome, verifyBackupIntegrity, loadTrustedManifest, findNewerOverlappingBatches,
 *   restoreFromManifest, rollbackProject, rollbackBatch, acquireLock, releaseLock, safeSyncProject,
 *   adoptProject, rawInstall, status, findForgeProjects, dedicatedCanaryDir, canaryInit, runSyncAll,
 *   parseArgs, CANARY_DIR_NAME.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// SYSTEM files (synced). Anything not matched here is PROJECT-LOCAL and never overwritten.
const SYSTEM = [
  'commands/forge.md',
  'agents/codex-reviewer.md',
  'config/agents/agent-registry.json', 'config/agents/agent-model-map.json', 'config/agents/agent-skill-map.json',
  // WP2: the least-privilege tool policy MUST ship with the checker that reads it. forge-doctor's agents
  // check fails closed when this file is absent, and a red doctor is a batch-stopping event for sync — so
  // leaving it out of SYSTEM would make the checker reach all 12 projects while the rules it enforces did
  // not, wedging the first real rollout on its own safety gate. Pinned by a test in forge-sync.test.cjs.
  'config/agents/agent-tool-policy.json',
  'config/models/model-capability-matrix.json', 'config/skills/global-skills.json',
  'config/orchestration/forge-graph.json', 'config/forge-bench/baseline.json',
  'docs/model-routing.md', 'docs/agents-and-skills.md',
  'FORGE_MODEL_ROUTING.json', 'FORGE_PAPERCLIP_AGENTS.json',
  'skills/forge-deeplearn/SKILL.md', 'skills/forge-prd/SKILL.md', 'skills/forge-mindmap/SKILL.md',
  'skills/forge-registry/SKILL.md', 'skills/forge-doctor/SKILL.md',
  'skills/forge-verify/SKILL.md', 'skills/forge-agent-report/SKILL.md', 'skills/forge-heartbeat/SKILL.md',
  'skills/humanizer/SKILL.md',
  'skills/gsap/gsap-core/SKILL.md', 'skills/gsap/gsap-frameworks/SKILL.md',
  'skills/gsap/gsap-performance/SKILL.md', 'skills/gsap/gsap-plugins/SKILL.md',
  'skills/gsap/gsap-react/SKILL.md', 'skills/gsap/gsap-scrolltrigger/SKILL.md',
  'skills/gsap/gsap-timeline/SKILL.md', 'skills/gsap/gsap-utils/SKILL.md',
  'skills/gsap/llms.txt',
  'config/intake/question-bank.json', 'skills/forge-intake/SKILL.md',
  'skills/forge-router/SKILL.md',
  'skills/forge-scraping/SKILL.md', 'skills/forge-rag/SKILL.md', 'skills/forge-integration/SKILL.md',
  'skills/forge-graded-verify/SKILL.md', 'config/rubrics/rag.json', 'settings.model-tier.example.json',
];
const SYSTEM_GLOB = [ // whole-dir system files by extension (kept fresh), minus the protected names below
  { dir: 'forge-bin', ext: ['.cjs', '.ps1', '.cmd', '.sh', '.md', '.bat'] },
  { dir: 'forge-dashboard', ext: ['.js', '.cjs', '.html', '.css', '.bat', '.md'] },
  { dir: 'agents', ext: ['.md'] },
];
const PROTECT = new Set([ // NEVER overwrite these project-local files even inside a system dir
  'forge-dashboard/PORT', 'forge-dashboard/DASHBOARD_STATE.json',
]);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.turbo', 'graphify-out']);
const CANARY_DIR_NAME = '.forge-canary'; // dot-prefixed -> structurally excluded from findForgeProjects discovery
// M9: extensions treated as text for EOL-only classification (raw bytes ALWAYS backed up/copied/restored —
// normalization below is for CLASSIFICATION ONLY, never for the actual bytes on disk).
const TEXT_EXTS_FOR_EOL = new Set(['.md', '.json', '.cjs', '.js', '.css', '.html', '.ps1', '.sh', '.txt']);

function listSystemFiles(templateDir) {
  const files = new Set(SYSTEM);
  for (const g of SYSTEM_GLOB) {
    const d = path.join(templateDir, g.dir);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      const rel = g.dir + '/' + f;
      if (g.ext.includes(path.extname(f)) && !PROTECT.has(rel)) files.add(rel);
    }
  }
  return [...files];
}
function sha256(p) { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; } }
function sha256Str(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
// M9: normalized (CRLF/CR -> LF) hash, used ONLY to classify a raw-byte difference as "eol_only" — never used
// for the actual copy/backup/restore, which always operate on raw bytes.
/** normalizeEolBuffer — S7 FIX: normalize CRLF/CR -> LF on the raw BYTE buffer, never on a decoded string.
 *  The old code called `.toString('utf8')` before normalizing — that decode is LOSSY: any invalid/non-UTF8
 *  byte sequence gets replaced with the SAME U+FFFD replacement character, so two files holding genuinely
 *  DIFFERENT invalid byte sequences (e.g. two different binary corruptions) can decode to an IDENTICAL
 *  normalized string -> identical normalized hash -> a real drift gets misclassified as eol_only and bypasses
 *  the drift gate entirely. Operating byte-for-byte avoids any decode step, so only genuine \r/\r\n bytes are
 *  ever touched; every other byte (valid or not) passes through unchanged. */
function normalizeEolBuffer(buf) {
  const out = Buffer.alloc(buf.length);
  let j = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0x0d) { // CR
      out[j++] = 0x0a; // normalize CR and CRLF alike to a single LF
      if (buf[i + 1] === 0x0a) i++; // consume the paired LF of a CRLF pair
    } else {
      out[j++] = b;
    }
  }
  return out.subarray(0, j);
}
function sha256Normalized(p) {
  try {
    return crypto.createHash('sha256').update(normalizeEolBuffer(fs.readFileSync(p))).digest('hex');
  } catch { return null; }
}
/** fileStatus — B3: distinguishes MISSING (legitimately "new" -> safe to write) from UNREADABLE (exists but
 *  can't be read — permission/lock/exotic error, or a directory sitting where a file is expected). An
 *  unreadable file must never be silently treated as "new" (which would skip backing it up and then delete
 *  it on rollback). */
function fileStatus(p) {
  let st;
  try { st = fs.lstatSync(p); } catch (e) { return e && e.code === 'ENOENT' ? { kind: 'missing' } : { kind: 'unreadable', error: e.message }; }
  if (st.isDirectory()) return { kind: 'unreadable', error: 'is a directory, not a file' };
  if (!st.isFile()) return { kind: 'unreadable', error: 'not a regular file' };
  try { return { kind: 'ok', hash: crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') }; }
  catch (e) { return { kind: 'unreadable', error: e.message }; }
}
function templateVersion(templateDir) { // deterministic hash of all system files -> the "version"
  const h = crypto.createHash('sha256');
  for (const rel of listSystemFiles(templateDir).sort()) h.update(rel + ':' + (sha256(path.join(templateDir, rel)) || '-'));
  return h.digest('hex').slice(0, 12);
}
function claudeDirOf(projectDir) { return path.join(projectDir, '.claude'); }

// ---- containment / symlink guards (never write outside a project's .claude/, never follow a symlink) ----
function safeJoin(baseDir, relPath) {
  const base = path.resolve(baseDir);
  const target = path.resolve(base, relPath);
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}
function isSymlinkPath(p) { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } }
/** containmentSafe — M6: a leaf-only symlink check misses a symlinked/junctioned INTERMEDIATE directory
 *  (e.g. .claude/forge-bin itself replaced with a junction pointing outside .claude). Resolves the REAL path
 *  of the longest existing ancestor (a not-yet-existing leaf can't itself be a reparse point) and confirms
 *  the resolved path still lives under the resolved base. */
function containmentSafe(baseDir, targetPath) {
  let realBase;
  try { realBase = fs.realpathSync.native(baseDir); } catch { realBase = path.resolve(baseDir); }
  let existingAncestor = targetPath;
  const tail = [];
  while (!fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break;
    tail.unshift(path.basename(existingAncestor));
    existingAncestor = parent;
  }
  let realExisting;
  try { realExisting = fs.realpathSync.native(existingAncestor); } catch { realExisting = path.resolve(existingAncestor); }
  const realTarget = tail.length ? path.join(realExisting, ...tail) : realExisting;
  return realTarget === realBase || realTarget.startsWith(realBase + path.sep);
}

function projectId(projectDir) {
  const abs = path.resolve(projectDir);
  return path.basename(abs) + '-' + sha256Str(abs).slice(0, 8);
}

// ---- receipt (records what THIS tool last wrote, so drift can be told apart from a hand-edit) ----
function receiptPath(projectDir) { return path.join(claudeDirOf(projectDir), 'forge-sync-receipt.json'); }
function readReceipt(projectDir) { try { return JSON.parse(fs.readFileSync(receiptPath(projectDir), 'utf8')); } catch { return null; } }
function readRawReceipt(projectDir) { // B2: raw bytes (for byte-exact backup/restore, mirrors readVersionFile)
  try { return { exists: true, content: fs.readFileSync(receiptPath(projectDir), 'utf8') }; } catch { return { exists: false, content: null }; }
}
function writeReceipt(projectDir, receipt) { fs.writeFileSync(receiptPath(projectDir), JSON.stringify(receipt, null, 2) + '\n', 'utf8'); }
/** receiptLastTemplateHashMap — B1: prefer the CUMULATIVE receipt.knownHashes (every system file's
 *  last-known-good hash, carried forward across every sync) over the old filesChanged-only map, which
 *  ERASED the baseline for any file that wasn't touched in the MOST RECENT sync (a same-since-last-sync file
 *  never appears in filesChanged, so its baseline vanished the moment any OTHER file changed — from the 3rd
 *  template version onward this falsely declared untouched files "drifted"). Falls back to the legacy
 *  filesChanged-derived map for a receipt written before this fix. */
function receiptLastTemplateHashMap(receipt) {
  if (receipt && receipt.knownHashes && typeof receipt.knownHashes === 'object') return Object.assign({}, receipt.knownHashes);
  const map = {};
  if (receipt && Array.isArray(receipt.filesChanged)) for (const f of receipt.filesChanged) if (f && f.rel) map[f.rel] = f.newHash;
  return map;
}

// ---- project-declared "I own this file on purpose" allow-list ----
function overridesAllowlistPath(projectDir) { return path.join(claudeDirOf(projectDir), 'config', 'forge-overrides.json'); }
function readOverrideAllowlist(projectDir) {
  try { const obj = JSON.parse(fs.readFileSync(overridesAllowlistPath(projectDir), 'utf8')); return new Set(Array.isArray(obj.overrides) ? obj.overrides : []); }
  catch { return new Set(); }
}

/**
 * preflight(templateDir, projectDir) -> classify every system file into exactly one bucket:
 *   toChange            — safe to sync (unchanged since our last write, brand new, or an eol_only diff)
 *   expectedOverrides    — declared in forge-overrides.json -> NEVER touched
 *   unknownDrift          — project differs from template; template unchanged since last receipt (or no
 *                           receipt at all -> conservative default); NOT overwritten unless --force-overwrite
 *   conflicts            — BOTH project and template changed since the last receipt; NOT overwritten unless
 *                           --force-overwrite
 *   skipped               — symlink/containment-guard trip; never touched, ever
 *   unreadable            — B3: exists but could not be read; the WHOLE project sync refuses on this
 */
function preflight(templateDir, projectDir) {
  const dst = claudeDirOf(projectDir);
  const receipt = readReceipt(projectDir);
  const lastTemplateHash = receiptLastTemplateHashMap(receipt);
  const allowlist = readOverrideAllowlist(projectDir);
  const toChange = [], expectedOverrides = [], unknownDrift = [], conflicts = [], skipped = [], unreadable = [];
  let same = 0;
  for (const rel of listSystemFiles(templateDir)) {
    const src = path.join(templateDir, rel);
    if (!fs.existsSync(src)) continue;
    const out = safeJoin(dst, rel);
    if (out == null) { skipped.push({ rel, reason: 'unsafe-path' }); continue; }
    if (isSymlinkPath(out)) { skipped.push({ rel, reason: 'symlink' }); continue; }
    if (!containmentSafe(dst, out)) { skipped.push({ rel, reason: 'symlink-parent-escape' }); continue; }
    const outStatus = fileStatus(out);
    if (outStatus.kind === 'unreadable') { unreadable.push({ rel, error: outStatus.error }); continue; }
    const templateHash = sha256(src);
    const outHash = outStatus.kind === 'ok' ? outStatus.hash : null;
    if (outHash === templateHash) { same++; continue; }
    if (allowlist.has(rel)) { expectedOverrides.push(rel); continue; }
    if (outHash === null) { toChange.push({ rel, oldHash: null, newHash: templateHash, isNew: true, overrideClass: null }); continue; }
    const ext = path.extname(rel).toLowerCase();
    if (TEXT_EXTS_FOR_EOL.has(ext)) { // M9: raw bytes differ, but ONLY by line-ending style -> always safe
      const normOut = sha256Normalized(out), normSrc = sha256Normalized(src);
      if (normOut !== null && normOut === normSrc) { toChange.push({ rel, oldHash: outHash, newHash: templateHash, isNew: false, overrideClass: 'eol_only' }); continue; }
    }
    if (Object.prototype.hasOwnProperty.call(lastTemplateHash, rel)) {
      const lastTplHash = lastTemplateHash[rel];
      if (outHash === lastTplHash) { toChange.push({ rel, oldHash: outHash, newHash: templateHash, isNew: false, overrideClass: null }); continue; }
      if (templateHash === lastTplHash) { unknownDrift.push(rel); continue; }
      conflicts.push(rel); continue;
    }
    unknownDrift.push(rel); // no receipt at all yet -> can't tell drift from conflict, be conservative
  }
  return { toChange, expectedOverrides, unknownDrift, conflicts, skipped, unreadable, same };
}

function buildPlan(templateDir, projectDir, opts) {
  opts = opts || {};
  const pf = preflight(templateDir, projectDir);
  if (!opts.forceOverwrite || (pf.unknownDrift.length === 0 && pf.conflicts.length === 0)) return pf;
  const dst = claudeDirOf(projectDir);
  const forceRel = (rel, cls) => {
    const src = path.join(templateDir, rel);
    const out = safeJoin(dst, rel);
    return { rel, oldHash: sha256(out), newHash: sha256(src), isNew: false, overrideClass: cls };
  };
  const forced = pf.unknownDrift.map((rel) => forceRel(rel, 'unknown_drift')).concat(pf.conflicts.map((rel) => forceRel(rel, 'conflict')));
  return { toChange: pf.toChange.concat(forced), expectedOverrides: pf.expectedOverrides, unknownDrift: [], conflicts: [], skipped: pf.skipped, unreadable: pf.unreadable, same: pf.same };
}

/** fullFileManifest — the FULL relevant-file hash manifest (rel -> {exists,hash,mode}), used for real
 *  before/after byte-exactness proof (not just "rollback exited 0"). */
function fullFileManifest(templateDir, projectDir) {
  const dst = claudeDirOf(projectDir);
  const out = {};
  for (const rel of listSystemFiles(templateDir)) {
    const p = safeJoin(dst, rel) || path.join(dst, rel);
    let exists = false, hash = null, mode = null;
    try { const st = fs.lstatSync(p); exists = true; mode = st.mode; if (st.isFile()) hash = sha256(p); } catch { exists = false; }
    out[rel] = { exists, hash, mode };
  }
  return out;
}
function aggregateManifestHash(manifestObj) {
  const keys = Object.keys(manifestObj).sort();
  const h = crypto.createHash('sha256');
  for (const k of keys) h.update(k + ':' + (manifestObj[k].hash || '-') + ':' + manifestObj[k].exists);
  return h.digest('hex');
}

function versionFilePath(projectDir) { return path.join(claudeDirOf(projectDir), 'FORGE_VERSION.json'); }
function readVersionFile(projectDir) {
  try { return { exists: true, content: fs.readFileSync(versionFilePath(projectDir), 'utf8') }; }
  catch { return { exists: false, content: null }; }
}

function backupDirFor(projectDir, batchId) { return path.join(claudeDirOf(projectDir), 'forge-backups', batchId); }
function centralBackupDir(centralRoot, batchId, pid) { return path.join(centralRoot, '.claude', 'forge-backups', batchId, pid); }

/** takeBackup — copies every about-to-change file's CURRENT bytes to the per-project backup dir (and, when
 *  centralBackupRoot is given, mirrors the same manifest+files to a central, project-independent location)
 *  BEFORE any write happens. B2: also snapshots the CURRENT forge-sync-receipt.json (raw bytes) so rollback
 *  can restore it exactly like FORGE_VERSION.json — without this, a rollback left the receipt describing a
 *  sync that was undone, causing false unknown_drift on the very next preflight. B7: each file entry now
 *  records BOTH oldHash and newHash (+existed) so rollback can tell "still what I wrote" from "changed since". */
function takeBackup(projectDir, batchId, plan, templateVer, nowIso, opts) {
  opts = opts || {};
  const dst = claudeDirOf(projectDir);
  const bdir = backupDirFor(projectDir, batchId);
  // S8 FIX: every fs write below used to be unguarded — an unwritable hub (permission denied, disk full, a
  // read-only central mount) threw an UNCAUGHT exception straight out of takeBackup, crashing the whole
  // install/sync-all process with a raw stack trace instead of the honest, clean refusal every other
  // failure mode in this tool already produces. The entire body is now one try/catch that returns
  // {ok:false, error, backupDir} on ANY I/O failure — callers must check backup.ok before proceeding to apply.
  try {
    return takeBackupUnsafe(projectDir, batchId, plan, templateVer, nowIso, opts, dst, bdir);
  } catch (e) {
    return { ok: false, error: 'failed to take backup: ' + e.message, backupDir: bdir };
  }
}
function takeBackupUnsafe(projectDir, batchId, plan, templateVer, nowIso, opts, dst, bdir) {
  fs.mkdirSync(bdir, { recursive: true });

  /** S1 FIX: a `--resume-batch` re-run calls takeBackup a SECOND time for the SAME batchId (the M3 guard that
   *  normally refuses batchId reuse is intentionally bypassed by opts.resumeBatch in safeSyncProject). The OLD
   *  code unconditionally re-copied CURRENT on-disk bytes over every already-backed-up file and recomputed its
   *  oldHash from preflight()'s plan — but after a crash mid-apply, "current on-disk" is the MIXED (half-
   *  applied) state, not the true pre-batch state. That silently clobbered the pristine backup with wrong
   *  bytes/wrong oldHash, so a later rollback of that batch restored the mixed state and reported ok. Fix:
   *  if this batch dir already has a manifest.json (a resume), reuse each already-recorded file entry AND its
   *  on-disk backup bytes VERBATIM — never re-copy, never recompute oldHash for a rel already backed up. Only
   *  a rel truly never reached by the prior attempt gets a fresh backup taken now. hadVersionFile/oldVersion/
   *  hadReceipt/oldReceipt are pinned to the FIRST attempt's recorded pre-batch values too, for the same reason. */
  let priorManifest = null;
  try { priorManifest = JSON.parse(fs.readFileSync(path.join(bdir, 'manifest.json'), 'utf8')); } catch { /* first attempt for this batch — normal case */ }
  const priorFilesByRel = {};
  if (priorManifest && Array.isArray(priorManifest.files)) for (const f of priorManifest.files) priorFilesByRel[f.rel] = f;

  const files = [];
  for (const entry of plan.toChange) {
    const already = priorFilesByRel[entry.rel];
    if (already) { files.push(already); continue; } // S1: never re-back-up / never recompute oldHash on resume
    if (entry.oldHash !== null) {
      const out = safeJoin(dst, entry.rel);
      const backupTarget = path.join(bdir, entry.rel);
      fs.mkdirSync(path.dirname(backupTarget), { recursive: true });
      fs.copyFileSync(out, backupTarget);
    }
    files.push({ rel: entry.rel, oldHash: entry.oldHash, newHash: entry.newHash, existed: entry.oldHash !== null });
  }
  const versionState = priorManifest ? { exists: priorManifest.hadVersionFile, content: priorManifest.oldVersion } : readVersionFile(projectDir);
  const receiptState = priorManifest ? { exists: priorManifest.hadReceipt, content: priorManifest.oldReceipt } : readRawReceipt(projectDir);
  const pid = projectId(projectDir);
  // S3: record the ACTUAL resolved central-hub path this batch used, so a later rollback can read it back
  // from here instead of re-deriving its own guess — install/rollback derive a default from dirname(project)
  // while sync-all/rollback-batch derive theirs from rootDir, which disagree for any project that is not a
  // direct child of root (the sync-all backup becomes unreachable by a per-project rollback). Preserved across
  // a resume (never overwritten by a differing value on a second takeBackup call for the same batch).
  const centralBackupRootResolved = priorManifest && Object.prototype.hasOwnProperty.call(priorManifest, 'centralBackupRoot')
    ? priorManifest.centralBackupRoot
    : (opts.centralBackupRoot ? path.resolve(opts.centralBackupRoot) : null);
  const manifest = {
    batchId, ts: priorManifest ? (priorManifest.ts || nowIso) : nowIso,
    runId: opts.runId || (priorManifest ? priorManifest.runId : null) || null, templateVersion: templateVer,
    projectId: pid, projectPath: path.resolve(projectDir), centralBackupRoot: centralBackupRootResolved,
    files, hadVersionFile: versionState.exists, oldVersion: versionState.exists ? versionState.content : null,
    hadReceipt: receiptState.exists, oldReceipt: receiptState.exists ? receiptState.content : null,
  };
  fs.writeFileSync(path.join(bdir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  let centralDir = null;
  if (opts.centralBackupRoot) {
    centralDir = centralBackupDir(opts.centralBackupRoot, batchId, pid);
    fs.mkdirSync(centralDir, { recursive: true });
    for (const f of files) {
      if (f.oldHash !== null) {
        const centralTarget = path.join(centralDir, f.rel);
        if (!fs.existsSync(centralTarget)) { // S1: same non-clobber protection for the central mirror on resume
          fs.mkdirSync(path.dirname(centralTarget), { recursive: true });
          fs.copyFileSync(path.join(bdir, f.rel), centralTarget);
        }
      }
    }
    fs.writeFileSync(path.join(centralDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  }
  return { ok: true, backupDir: bdir, centralDir, manifest };
}

/** applyPlanSafely — writes plan.toChange; STOPS at the first failure (never leaves it to throw uncaught) so
 *  the caller can roll back exactly what was actually applied. copyFileImpl is injectable (defaults to
 *  fs.copyFileSync) purely so a test can simulate a mid-batch write failure without monkey-patching the
 *  global fs module. */
function applyPlanSafely(templateDir, projectDir, plan, copyFileImpl) {
  const copy = copyFileImpl || fs.copyFileSync;
  const dst = claudeDirOf(projectDir);
  const applied = [];
  try {
    for (const entry of plan.toChange) {
      const src = path.join(templateDir, entry.rel);
      const out = safeJoin(dst, entry.rel);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      copy(src, out);
      applied.push(entry.rel);
    }
    return { ok: true, applied };
  } catch (e) {
    return { ok: false, applied, error: e.message };
  }
}

// ---- validation: H4 evidence-based gate + H3 pre/post baseline comparison ----
// M10: build a human-copy-pasteable command STRING from an argv array with proper quoting — naive string
// concatenation breaks on a project path containing a space and/or a "!" (e.g. "my project!").
function quoteArg(a) {
  const s = String(a);
  return /[\s"!]/.test(s) ? ('"' + s.replace(/"/g, '\\"') + '"') : s;
}
function cmdArrToString(execPath, argsArr) { return [execPath].concat(argsArr).map(quoteArg).join(' '); }

/** evidenceOk — H4: a forge-doctor --json report is only trusted when it shows POSITIVE evidence of having
 *  actually run real checks: node_check covered at least as many files as we just synced, AND at least one
 *  test suite ran with at least one passing assertion. A 0-files/0-suites "pass" is rejected outright. */
function evidenceOk(parsed, minCjsCount) {
  if (!parsed || typeof parsed !== 'object' || !parsed.checks) return false;
  const nc = parsed.checks.node_check, ts = parsed.checks.tests;
  if (!nc || typeof nc.total !== 'number' || nc.total < minCjsCount) return false;
  if (!ts || typeof ts.suites !== 'number' || ts.suites <= 0) return false;
  if (typeof ts.passed !== 'number' || ts.passed <= 0) return false;
  return true;
}
/** condenseDoctorSummary — B1 FIX: forge-doctor emits EIGHT checks (node_check, tests, strict_events,
 *  dashboard_spa, leak_scan, agents, chain, rebinding_guard) and its top-level `ok` is the AND of all eight.
 *  The OLD code only ever kept node_check + tests, so docCheckOkMap/regressionCheck could NEVER see a
 *  regression on any of the other 6 checks (e.g. a sync-caused break in dashboard_spa or rebinding_guard —
 *  both files THIS tool syncs — would be silently waved through as "already-red, not attributed to this
 *  sync"). Now carries {ok} for EVERY key actually present in parsed.checks, generically, plus the
 *  node_check/tests detail fields kept for existing consumers (evidenceOk, printSafeSyncResult, etc). */
function condenseDoctorSummary(parsed) {
  if (!parsed || !parsed.checks) return null;
  const c = parsed.checks;
  const pick = (obj, keys) => { if (!obj) return null; const o = {}; for (const k of keys) if (obj[k] !== undefined) o[k] = obj[k]; return o; };
  const checksOk = {};
  for (const k of Object.keys(c)) checksOk[k] = { ok: !!(c[k] && c[k].ok) };
  return {
    ok: parsed.ok,
    node_check: pick(c.node_check, ['ok', 'total', 'failed']),
    tests: pick(c.tests, ['ok', 'suites', 'passed', 'failed']),
    checksOk, // B1: EVERY doctor check's {ok}, not just node_check/tests -> regressionCheck can see all 8
  };
}
/** docCheckOkMap — B1 FIX: iterate ALL checks carried in summary.checksOk (every key forge-doctor emitted),
 *  not a hardcoded {node_check, tests} pair. Falls back to the legacy node_check/tests-only shape for a
 *  summary produced before this fix (e.g. a receipt persisted by an older sync run), so old receipts don't
 *  crash a later regressionCheck call. */
function docCheckOkMap(summary) {
  const out = {};
  if (summary && summary.checksOk && typeof summary.checksOk === 'object') {
    for (const k of Object.keys(summary.checksOk)) out[k] = !!summary.checksOk[k].ok;
  } else {
    if (summary && summary.node_check) out.node_check = !!summary.node_check.ok;
    if (summary && summary.tests) out.tests = !!summary.tests.ok;
  }
  if (summary) out.overall = summary.ok !== false;
  return out;
}
/** regressionCheck — H3/B1: a check that was RED before this sync and is STILL red after is not a new
 *  problem caused by the sync; a check that was GREEN before and is RED after on ANY of forge-doctor's
 *  checks (not just node_check/tests) is a genuine regression.
 *  MEDIUM FIX (2026-07-15, forge-2026-07-15-testloop): a check that did NOT EXIST in the pre-sync doctor
 *  at all (`pre[k] === undefined`) — i.e. a check the sync ITSELF just introduced, by writing a new
 *  forge-doctor.cjs that emits a check the old one never had — must ALSO count as a regression when it is
 *  red post-sync. The old condition (`pre[k] === true && post[k] === false`) only fired on a genuine
 *  green->red flip of a check present BOTH times; a check absent pre-sync could never satisfy `pre[k] ===
 *  true`, so a brand-new-and-already-red check was silently swallowed by the "already-red, not attributed
 *  to this sync" exemption below (decideValidationOutcome) even though nothing was ever green to compare
 *  against — "absent" must be treated as "was not red" (there is nothing yet to be already-red about), so a
 *  new+red check is exactly as much a regression as an old green check turning red. A check that already
 *  existed and was ALREADY red both before and after (`pre[k] === false && post[k] === false`) remains
 *  correctly exempted — this is the pre-existing-redness case the already-red logic exists to protect,
 *  and is intentionally NOT touched by this fix.
 *
 *  MEDIUM FIX (2026-07-15, forge-2026-07-15-testloop ROUND 2): the round-1 fix above only ever iterates
 *  `Object.keys(post)`, so it can only ever notice a check that is STILL PRESENT post-sync (red, new, or
 *  otherwise). A check that existed pre-sync and was GREEN, but is entirely ABSENT from post-sync's
 *  checksOk (the new forge-doctor.cjs simply stopped emitting that check-key at all — a sync deleting or
 *  silently degrading a check), can never be seen by that loop at all: it never appears in
 *  `Object.keys(post)`, so `post[k]` is never even evaluated for it. A validator quietly LOSING a check is
 *  exactly as dangerous as it flipping red — a sync must never be allowed to "fix" a regression by simply
 *  making the doctor stop reporting on it. Fix: a SECOND pass over `Object.keys(pre)` flags any key that was
 *  `true` pre-sync and is `undefined` (absent) post-sync. The full, precise truth table this function now
 *  implements: pre green + post absent = FAILURE (this fix); pre absent + post red = FAILURE (round-1 fix,
 *  unchanged above); pre red + post red (same key present both times) = already-red, exempted (unchanged);
 *  pre red + post green/absent = improvement, not a regression (unchanged — dropping an already-broken
 *  check, or fixing it, is never itself a new problem). */
function regressionCheck(preSummary, postSummary) {
  const pre = docCheckOkMap(preSummary), post = docCheckOkMap(postSummary);
  const regressed = [];
  for (const k of Object.keys(post)) {
    if (post[k] === false && (pre[k] === true || pre[k] === undefined)) regressed.push(k);
  }
  for (const k of Object.keys(pre)) {
    if (pre[k] === true && post[k] === undefined) regressed.push(k);
  }
  return regressed;
}
function runDoctorJson(projectDir, doctorPath, timeoutMs) {
  const argsArr = ['--root', projectDir, '--json'];
  const r = spawnSync(process.execPath, [doctorPath].concat(argsArr), { cwd: projectDir, encoding: 'utf8', timeout: timeoutMs });
  const exitCode = r.status == null ? 1 : r.status;
  // M4: spawnSync sets status:null + a kill signal (or r.error.code === 'ETIMEDOUT') when its timeout fires —
  // treat that as BLOCKED (couldn't confirm), never as a confirmed validation failure.
  const timedOut = r.status === null && (!!r.signal || (r.error && r.error.code === 'ETIMEDOUT'));
  let parsed = null; try { parsed = JSON.parse(r.stdout || ''); } catch { parsed = null; }
  return { exitCode, parsed, timedOut, signal: r.signal || null, cmdArgs: [doctorPath].concat(argsArr) };
}
/** runValidation — the gate for "did this sync leave the project provably OK". opts.doctorTimeoutMs
 *  overrides the default 180s (M4: `--doctor-timeout` makes this a real, settable flag). */
function runValidation(projectDir, plan, opts) {
  opts = opts || {};
  const timeoutMs = Number.isFinite(opts.doctorTimeoutMs) && opts.doctorTimeoutMs > 0 ? opts.doctorTimeoutMs : 180000;
  const doctorPath = path.join(claudeDirOf(projectDir), 'forge-bin', 'forge-doctor.cjs');
  const cjsRels = (plan.toChange || []).map((e) => e.rel).filter((rel) => rel.endsWith('.cjs'));
  if (fs.existsSync(doctorPath)) {
    const { exitCode, parsed, timedOut, signal, cmdArgs } = runDoctorJson(projectDir, doctorPath, timeoutMs);
    const commandStr = cmdArrToString(process.execPath, cmdArgs);
    if (timedOut) return { tool: 'forge-doctor', exitCode, ok: false, timedOut: true, signal, commands: [commandStr] };
    if (parsed && evidenceOk(parsed, cjsRels.length)) {
      return { tool: 'forge-doctor', exitCode, ok: exitCode === 0 && parsed.ok !== false, commands: [commandStr], summary: condenseDoctorSummary(parsed) };
    }
    return {
      tool: 'forge-doctor', exitCode, ok: false, noEvidence: true, commands: [commandStr], summary: condenseDoctorSummary(parsed),
      reason: 'forge-doctor gave no positive evidence (--json missing/unparsable/0-count) — refusing to trust a bare exit code',
    };
  }
  // DEGRADED fallback: no forge-doctor present -> node --check on every synced .cjs only.
  const failures = [], commands = [];
  for (const rel of cjsRels) {
    const out = safeJoin(claudeDirOf(projectDir), rel);
    const argsArr = ['--check', out];
    commands.push(cmdArrToString(process.execPath, argsArr));
    const r = spawnSync(process.execPath, argsArr, { encoding: 'utf8' });
    if (r.status !== 0) failures.push(rel);
  }
  return { tool: 'node-check-fallback', exitCode: failures.length ? 1 : 0, ok: failures.length === 0, degraded: true, checked: cjsRels.length, failures, commands };
}
/** decideValidationOutcome — H3+H4 gating decision, kept as a pure function so it's directly unit-testable.
 *  Priority: timeout -> blocked. Degraded (no doctor) -> requires --allow-degraded even when clean, and NEVER
 *  passes if the fallback itself found syntax failures. Evidence-backed pass -> ok, UNLESS a previously-green
 *  check silently vanished (see below). No-evidence -> rejected. Evidence-backed fail -> ok ONLY if it is
 *  provably the SAME pre-existing redness (no new regression) AND the node_check hard gate on the
 *  just-synced files is clean; otherwise a real failure.
 *
 *  MEDIUM FIX (2026-07-15, forge-2026-07-15-testloop ROUND 2, mirrors regressionCheck's own fix): a naive
 *  `validation.ok===true` from the POST-sync doctor is NOT sufficient proof that nothing regressed — the
 *  doctor's own top-level `ok` is only `Object.values(checks).every(c=>c.ok)` over whatever keys IT still
 *  emits, so a sync that replaces forge-doctor.cjs with a version that silently stopped emitting a
 *  previously-green check reports a happy `ok:true` with ZERO awareness that real coverage was lost — "a
 *  sync that removes a check passes" is exactly the bug this closes. Before trusting a naive `ok:true`,
 *  compare against the pre-sync baseline via the SAME regressionCheck used for the evidence-backed-fail path
 *  below; if it finds a previously-green check now entirely absent, that overrides the naive pass. A
 *  brand-new green check, or identical checks on both sides, are unaffected (regressionCheck returns []). */
function decideValidationOutcome(preValidation, validation, opts) {
  opts = opts || {};
  if (validation.timedOut) return { ok: false, timedOut: true, reason: 'forge-doctor timed out (' + (validation.signal || 'no signal') + ') — treating as BLOCKED, not a confirmed validation failure' };
  if (validation.degraded) {
    if (!validation.ok) return { ok: false, reason: 'degraded validator (node --check fallback, no forge-doctor present) found syntax failure(s) in synced file(s)' };
    if (!opts.allowDegraded) return { ok: false, degradedBlocked: true, reason: 'degraded validator (no forge-doctor present) cannot count as synced without --allow-degraded' };
    return { ok: true, degradedAllowed: true };
  }
  if (validation.ok) {
    const vanished = regressionCheck(preValidation && preValidation.summary, validation.summary);
    if (vanished.length > 0) {
      return { ok: false, reason: 'this sync\'s own doctor no longer reports previously-green check(s), even though it otherwise claims ok:true: ' + vanished.join(', ') + ' (a check must never silently disappear)' };
    }
    return { ok: true };
  }
  if (validation.noEvidence) return { ok: false, reason: validation.reason || 'forge-doctor gave no positive evidence' };
  const preHasEvidence = !!(preValidation && preValidation.summary && !preValidation.noEvidence && !preValidation.degraded);
  const preWasRed = preHasEvidence && preValidation.summary.ok === false;
  if (!preHasEvidence || !preWasRed) return { ok: false, reason: 'post-sync validation failed' };
  const regressed = regressionCheck(preValidation.summary, validation.summary);
  const postNodeCheckOk = validation.summary && validation.summary.node_check ? !!validation.summary.node_check.ok : true;
  if (regressed.length === 0 && postNodeCheckOk) {
    return { ok: true, alreadyRedSkipped: true, note: 'project was already red before this sync (pre-existing, unrelated failures) — no NEW regression and the synced file(s) pass node_check; not attributing pre-existing redness to this sync' };
  }
  return { ok: false, reason: regressed.length ? ('regression on: ' + regressed.join(', ') + ' (green->red, or a check newly introduced by this sync that is already red)') : 'node_check hard gate failed on synced file(s)' };
}

// ---- rollback: integrity-checked, journaled (resumable/idempotent), project-local-first then central ----
function verifyBackupIntegrity(manifestDir, manifest) {
  const problems = [];
  for (const f of manifest.files) {
    if (f.oldHash === null) continue; // nothing to check — this file didn't exist pre-sync
    const p = path.join(manifestDir, f.rel);
    if (!fs.existsSync(p)) { problems.push({ rel: f.rel, reason: 'backup file missing' }); continue; }
    if (sha256(p) !== f.oldHash) problems.push({ rel: f.rel, reason: 'backup file hash mismatch (corrupt)' });
  }
  return { ok: problems.length === 0, problems };
}
function loadTrustedManifest(projectDir, batchId, centralBackupRoot) {
  const pDir = backupDirFor(projectDir, batchId);
  let pManifest = null;
  try { pManifest = JSON.parse(fs.readFileSync(path.join(pDir, 'manifest.json'), 'utf8')); } catch { /* absent */ }
  if (pManifest && verifyBackupIntegrity(pDir, pManifest).ok) return { ok: true, source: 'project', manifestDir: pDir, manifest: pManifest };
  if (centralBackupRoot) {
    const pid = projectId(projectDir);
    const cDir = centralBackupDir(centralBackupRoot, batchId, pid);
    let cManifest = null;
    try { cManifest = JSON.parse(fs.readFileSync(path.join(cDir, 'manifest.json'), 'utf8')); } catch { /* absent */ }
    if (cManifest && verifyBackupIntegrity(cDir, cManifest).ok) return { ok: true, source: 'central', manifestDir: cDir, manifest: cManifest };
  }
  return { ok: false, reason: 'no valid (uncorrupted) backup manifest found for batch ' + batchId + ' (checked project-local' + (centralBackupRoot ? ' and central' : '') + ' locations) — REFUSING to restore rather than fabricate a result' };
}
/** findNewerOverlappingBatches — B7 (part 2). S4 FIX: the OLD code only ever inspected the PROJECT-LOCAL
 *  backups dir. In a central-only recovery (the project's own `.claude/forge-backups/` is damaged/wiped —
 *  exactly the scenario a central hub exists for), a genuinely newer batch that already touched the same
 *  file(s) went completely undetected here, so this function silently returned [] and the caller fell through
 *  to a LESS informative generic "content diverged" refusal (from computeDivergence) that never names WHICH
 *  batch caused it. Now also scans <centralBackupRoot>/.claude/forge-backups/<batchId>/<projectId>/
 *  manifest.json for every batch id found there, in addition to the local scan, de-duplicated by batchId
 *  (local checked first) so the SAME batch is never double-counted. */
function findNewerOverlappingBatches(projectDir, batchId, manifest, centralBackupRoot) {
  const targetRels = new Set((manifest.files || []).map((f) => f.rel));
  const seen = new Set();
  const overlaps = [];
  const consider = (id, m) => {
    if (id === batchId || seen.has(id)) return;
    seen.add(id);
    if (!m || !m.ts || !manifest.ts || !(m.ts > manifest.ts)) return; // only strictly-newer batches matter
    const overlapRels = (m.files || []).map((f) => f.rel).filter((rel) => targetRels.has(rel));
    if (overlapRels.length) overlaps.push({ batchId: id, ts: m.ts, rels: overlapRels });
  };

  const bdir = path.join(claudeDirOf(projectDir), 'forge-backups');
  let localEntries = [];
  try { localEntries = fs.readdirSync(bdir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* local backups dir gone/damaged */ }
  for (const id of localEntries) {
    let m; try { m = JSON.parse(fs.readFileSync(path.join(bdir, id, 'manifest.json'), 'utf8')); } catch { continue; }
    consider(id, m);
  }

  if (centralBackupRoot) { // S4: also scan the central hub — findable even when local is entirely gone
    const centralBatchesDir = path.join(centralBackupRoot, '.claude', 'forge-backups');
    const pid = projectId(projectDir);
    let centralBatchIds = [];
    try { centralBatchIds = fs.readdirSync(centralBatchesDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* no central hub / not created yet */ }
    for (const id of centralBatchIds) {
      let m; try { m = JSON.parse(fs.readFileSync(path.join(centralBatchesDir, id, pid, 'manifest.json'), 'utf8')); } catch { continue; }
      consider(id, m);
    }
  }
  return overlaps;
}
function journalPath(manifestDir) { return path.join(manifestDir, 'rollback-journal.json'); }
/** subsetManifest — a shallow copy of a backup manifest restricted to a subset of rels (used when only
 *  PART of a plan was actually applied before a failure, so rollback never touches an untouched file). */
function subsetManifest(manifest, rels) {
  const relSet = new Set(rels);
  return Object.assign({}, manifest, { files: manifest.files.filter((f) => relSet.has(f.rel)) });
}
/** computeDivergence — B7 (part 1): for every file NOT yet restored (per the journal), confirm the CURRENT
 *  on-disk content still matches what THIS sync wrote (newHash). A file that is simply ABSENT is not treated
 *  as diverged (nothing to protect — restoring/removing it is harmless); a file holding SOME OTHER content
 *  (neither newHash nor absent) means someone changed it since this sync, and rolling back would destroy
 *  that — refuse unless --force-rollback-newer. Legacy manifests (no newHash field) can't be checked and are
 *  allowed through unchanged (backward compatible with a pre-B7 backup). */
function computeDivergence(dst, manifest, doneSet) {
  const diverged = [];
  for (const f of manifest.files) {
    if (doneSet.has(f.rel)) continue;
    if (!Object.prototype.hasOwnProperty.call(f, 'newHash')) continue;
    const out = safeJoin(dst, f.rel);
    if (out == null) continue;
    const currentHash = sha256(out);
    if (currentHash === f.newHash) continue;
    if (currentHash === null) continue; // missing entirely -> nothing to protect
    diverged.push({ rel: f.rel, expected: f.newHash, current: currentHash });
  }
  return diverged;
}
/** restoreFromManifest — restores byte-for-byte from an already-TRUSTED manifest/manifestDir. Journaled: a
 *  thrown interruption (real or the __throwAfter test hook, gated behind FORGE_SYNC_TEST_HOOKS=1 — M11) leaves
 *  rollback-journal.json with the rels already restored; calling this again on the SAME manifestDir resumes
 *  from there (idempotent). H1: every restore step is verified — ENOENT-on-delete is tolerated, but any OTHER
 *  error (EPERM, an unsafe path) is recorded as a real failure, and every file is RE-HASHED after its restore
 *  attempt; a rel is only ever added to `restored` when that verification actually passed. If any file fails,
 *  the whole call returns {ok:false, partial:true, restored, failed} — never a false "restored" claim — and
 *  the journal is left in-progress so a later re-run (e.g. after fixing a lock) can retry just the failures.
 *  B7: refuses up front (before touching anything) if any not-yet-restored file has diverged from what this
 *  sync wrote, unless opts.forceRollbackNewer. B2: also restores/removes forge-sync-receipt.json, exactly
 *  like FORGE_VERSION.json, so a rolled-back project's next preflight() sees a receipt consistent with its
 *  actual (reverted) file contents instead of a stale receipt describing the undone sync. */
function restoreFromManifest(projectDir, manifestDir, manifest, opts) {
  opts = opts || {};
  const dst = claudeDirOf(projectDir);
  const jPath = journalPath(manifestDir);
  let journal;
  try { journal = JSON.parse(fs.readFileSync(jPath, 'utf8')); } catch { journal = null; }
  if (!journal || journal.status === 'complete') journal = { batchId: manifest.batchId, status: 'in-progress', doneRels: [], versionRestored: false, receiptRestored: false };
  const doneSet = new Set(journal.doneRels);

  if (!opts.forceRollbackNewer) {
    const diverged = computeDivergence(dst, manifest, doneSet);
    if (diverged.length) return { ok: false, refusedDivergence: true, diverged, restored: [] };
  }

  const testHooksEnabled = process.env.FORGE_SYNC_TEST_HOOKS === '1'; // M11: gate the test-only throw switch
  const restored = [], failed = [];
  for (const f of manifest.files) {
    if (doneSet.has(f.rel)) { restored.push(f.rel); continue; }
    if (testHooksEnabled && opts.__throwAfter != null && restored.length === opts.__throwAfter) {
      journal.doneRels = [...doneSet];
      fs.writeFileSync(jPath, JSON.stringify(journal, null, 2));
      throw new Error('SIMULATED rollback interruption after ' + restored.length + ' file(s) (test-only injection hook)');
    }
    const out = safeJoin(dst, f.rel);
    let ok = true, reason = null;
    if (out == null) { ok = false; reason = 'unsafe path (containment guard tripped)'; }
    else if (f.oldHash === null) {
      try { fs.rmSync(out, { force: true }); } catch (e) { if (e && e.code !== 'ENOENT') { ok = false; reason = e.message; } }
    } else {
      try { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.copyFileSync(path.join(manifestDir, f.rel), out); }
      catch (e) { ok = false; reason = e.message; }
    }
    if (ok && out != null) { // H1: post-step verification — never trust "no exception" alone
      if (f.oldHash === null) { if (fs.existsSync(out)) { ok = false; reason = 'file still present after delete attempt'; } }
      else { const h = sha256(out); if (h !== f.oldHash) { ok = false; reason = 'hash mismatch after restore (expected ' + f.oldHash + ', got ' + h + ')'; } }
    }
    if (ok) { restored.push(f.rel); doneSet.add(f.rel); } else failed.push({ rel: f.rel, reason });
    journal.doneRels = [...doneSet];
    fs.writeFileSync(jPath, JSON.stringify(journal, null, 2));
  }

  if (failed.length) return { ok: false, partial: true, restored, failed };

  if (!journal.versionRestored) {
    if (manifest.hadVersionFile) fs.writeFileSync(versionFilePath(projectDir), manifest.oldVersion, 'utf8');
    else { try { fs.rmSync(versionFilePath(projectDir), { force: true }); } catch { /* already gone */ } }
    journal.versionRestored = true;
    fs.writeFileSync(jPath, JSON.stringify(journal, null, 2));
  }
  if (!journal.receiptRestored) {
    if (Object.prototype.hasOwnProperty.call(manifest, 'hadReceipt')) {
      if (manifest.hadReceipt) fs.writeFileSync(receiptPath(projectDir), manifest.oldReceipt, 'utf8');
      else { try { fs.rmSync(receiptPath(projectDir), { force: true }); } catch { /* already gone */ } }
    }
    journal.receiptRestored = true;
    fs.writeFileSync(jPath, JSON.stringify(journal, null, 2));
  }
  journal.status = 'complete';
  fs.writeFileSync(jPath, JSON.stringify(journal, null, 2));
  return {
    ok: true, restored, versionAction: manifest.hadVersionFile ? 'restored' : 'removed',
    receiptAction: !('hadReceipt' in manifest) ? 'unknown (legacy manifest predates receipt backup)' : (manifest.hadReceipt ? 'restored' : 'removed'),
  };
}
function latestBatchId(projectDir) {
  const bdir = path.join(claudeDirOf(projectDir), 'forge-backups');
  let entries = [];
  try { entries = fs.readdirSync(bdir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return null; }
  let best = null, bestTs = '';
  for (const id of entries) {
    try { const m = JSON.parse(fs.readFileSync(path.join(bdir, id, 'manifest.json'), 'utf8')); if (!best || (m.ts || '') > bestTs) { best = id; bestTs = m.ts || ''; } } catch { /* skip unreadable */ }
  }
  return best;
}
/** rollbackProject — `node forge-sync.cjs rollback <projectDir> [--batch <batchId>]`. An interruption
 *  (thrown by restoreFromManifest) is caught and reported as ok:false, interrupted:true — the journal already
 *  on disk means a SECOND call to this function resumes and completes it. */
function rollbackProject(projectDir, batchId, opts) {
  opts = opts || {};
  if (!fs.existsSync(projectDir)) return { ok: false, reason: 'project path missing: ' + projectDir };
  const dst = claudeDirOf(projectDir);
  if (!fs.existsSync(dst)) return { ok: false, reason: 'not a project (.claude missing): ' + projectDir };
  const targetBatch = batchId || latestBatchId(projectDir);
  if (!targetBatch) return { ok: false, reason: 'no backup batch found for ' + projectDir };
  // S3: unless the caller EXPLICITLY chose a central hub (a real --central-backup-root / --no-central-backup
  // flag, signaled by opts.centralBackupRootExplicit), prefer whatever hub THIS BATCH itself recorded in its
  // own project-local manifest.json over a freshly re-derived guess — this is what makes a `rollback` command
  // able to find a `sync-all`-written central backup even when the project isn't a direct child of root.
  let centralBackupRoot = opts.centralBackupRoot;
  if (!opts.centralBackupRootExplicit) {
    try {
      const localManifest = JSON.parse(fs.readFileSync(path.join(backupDirFor(projectDir, targetBatch), 'manifest.json'), 'utf8'));
      if (localManifest && localManifest.centralBackupRoot) centralBackupRoot = localManifest.centralBackupRoot;
    } catch { /* no project-local manifest available (or none recorded pre-S3) -> keep the caller-supplied value */ }
  }
  const trusted = loadTrustedManifest(projectDir, targetBatch, centralBackupRoot);
  if (!trusted.ok) return { ok: false, reason: trusted.reason, batchId: targetBatch };
  if (!opts.forceRollbackNewer) {
    const overlaps = findNewerOverlappingBatches(projectDir, targetBatch, trusted.manifest, centralBackupRoot);
    if (overlaps.length) {
      return {
        ok: false, batchId: targetBatch, source: trusted.source, newerOverlaps: overlaps,
        reason: 'refusing to roll back batch ' + targetBatch + ': a NEWER batch (' + overlaps.map((o) => o.batchId).join(', ') + ') already touched the same file(s) for this project — this would destroy the newer sync (pass --force-rollback-newer to override; prefer rolling back the newest batch first)',
      };
    }
  }
  try {
    const result = restoreFromManifest(projectDir, trusted.manifestDir, trusted.manifest, { __throwAfter: opts.__throwAfter, forceRollbackNewer: opts.forceRollbackNewer });
    if (result.ok === false && result.refusedDivergence) {
      return {
        ok: false, batchId: targetBatch, source: trusted.source, diverged: result.diverged,
        reason: 'refusing to roll back: ' + result.diverged.length + ' file(s) diverged since this sync wrote them (newer content present) — pass --force-rollback-newer to override: ' + result.diverged.map((d) => d.rel).join(', '),
      };
    }
    if (result.ok === false && result.partial) {
      return {
        ok: false, partial: true, batchId: targetBatch, source: trusted.source, restored: result.restored, failed: result.failed,
        reason: 'PARTIAL — MANUAL RECOVERY REQUIRED: ' + result.failed.length + ' file(s) failed to restore/verify (backup at ' + trusted.manifestDir + '): ' + result.failed.map((f) => f.rel + ' (' + f.reason + ')').join('; '),
      };
    }
    return { ok: true, batchId: targetBatch, source: trusted.source, restored: result.restored, versionAction: result.versionAction, receiptAction: result.receiptAction };
  } catch (e) {
    return { ok: false, interrupted: true, batchId: targetBatch, reason: 'rollback interrupted: ' + e.message + ' (re-run rollback to resume/complete — journal is on disk)' };
  }
}
/** rollbackBatch — `node forge-sync.cjs rollback-batch <batchId> <rootDir>`. B4: a project whose LOCAL
 *  backup dir is gone (damaged/wiped) but whose CENTRAL backup is intact must still be attempted — gating on
 *  "local dir exists" alone silently skipped exactly the scenario the central hub exists for. Only projects
 *  with NO evidence anywhere (neither local nor a valid central manifest) are skipped as "not part of this
 *  batch". */
function rollbackBatch(rootDir, batchId, opts) {
  opts = opts || {};
  const projects = Array.isArray(opts.projects) ? opts.projects : findForgeProjects(rootDir);
  const results = [];
  for (const p of projects) {
    const hasLocal = fs.existsSync(path.join(claudeDirOf(p), 'forge-backups', batchId));
    const trusted = loadTrustedManifest(p, batchId, opts.centralBackupRoot);
    if (!hasLocal && !trusted.ok) continue;
    // S6: hold this project's OWN lock while restoring it (in addition to the CLI's root lock held for the
    // whole batch), so a concurrent single-project `install`/`rollback` on the SAME project cannot race this.
    const lock = acquireLock(claudeDirOf(p));
    if (!lock.ok) { results.push({ projectDir: p, ok: false, reason: 'S6: could not acquire project lock for ' + p + ': ' + lock.reason }); continue; }
    try { results.push(Object.assign({ projectDir: p }, rollbackProject(p, batchId, opts))); }
    finally { releaseLock(lock); }
  }
  return results;
}

// ---- M2: a lightweight, cooperative concurrency lock (CLI-layer only — library functions stay lock-free so
// direct unit tests remain deterministic and dry-run stays a true zero-write operation). ----
function lockPathFor(dir) { return path.join(dir, '.forge-sync.lock'); }
function acquireLock(dir, opts) {
  opts = opts || {};
  const lp = lockPathFor(dir);
  const staleMs = opts.staleMs != null ? opts.staleMs : 6 * 60 * 60 * 1000; // 6h freshness window
  try {
    const fd = fs.openSync(lp, 'wx');
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }));
    fs.closeSync(fd);
    return { ok: true, lockPath: lp };
  } catch (e) {
    // The lock target directory not existing yet (e.g. a project whose .claude/ is missing entirely) is NOT
    // a locking problem — never fs.mkdirSync it into existence as a side effect (that would silently mask the
    // "not a project" refusal safeSyncProject is about to report moments later). Just skip locking cleanly.
    if (e.code === 'ENOENT') return { ok: true, lockPath: null, skippedMissingDir: true };
    if (e.code !== 'EEXIST') return { ok: false, reason: 'could not create lock at ' + lp + ': ' + e.message };
    let info = null;
    try { info = JSON.parse(fs.readFileSync(lp, 'utf8')); } catch { /* corrupt/unreadable lock content */ }
    const ageMs = info && info.ts ? (Date.now() - new Date(info.ts).getTime()) : null;
    if (ageMs != null && ageMs > staleMs) {
      try {
        fs.rmSync(lp, { force: true });
        const fd = fs.openSync(lp, 'wx');
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }));
        fs.closeSync(fd);
        return { ok: true, lockPath: lp, reclaimedStale: true };
      } catch (e2) { return { ok: false, reason: 'stale lock reclaim failed: ' + e2.message }; }
    }
    return {
      ok: false, held: true,
      reason: 'another forge-sync run is in progress (lock held' + (info && info.pid ? (' by pid ' + info.pid) : '') + (info && info.ts ? (' since ' + info.ts) : '') + ') at ' + lp + ' — refusing to run concurrently',
    };
  }
}
function releaseLock(lockResult) { if (lockResult && lockResult.ok && lockResult.lockPath) { try { fs.rmSync(lockResult.lockPath, { force: true }); } catch { /* best-effort */ } } }

/**
 * safeSyncProject — the whole safe flow for ONE project. opts: { dryRun, forceOverwrite, batchId, nowIso,
 * centralBackupRoot, runId, copyFileImpl, allowDegraded, doctorTimeoutMs, resumeBatch }. NEVER calls
 * Date.now()/generates its own batchId — both must be supplied by the caller (CLI computes real ones; tests
 * inject fixed ones) so behavior stays deterministic.
 */
function safeSyncProject(templateDir, projectDir, opts) {
  opts = opts || {};
  if (!fs.existsSync(projectDir)) return { ok: false, refused: true, reason: 'project path missing: ' + projectDir, projectDir };
  const dst = claudeDirOf(projectDir);
  if (!fs.existsSync(dst)) return { ok: false, refused: true, reason: 'not a project (.claude missing): ' + projectDir, projectDir };

  const templateVer = templateVersion(templateDir);
  const plan = buildPlan(templateDir, projectDir, { forceOverwrite: !!opts.forceOverwrite });

  if (plan.unreadable && plan.unreadable.length) { // B3: never silently treat an unreadable file as "new"
    return {
      ok: false, refused: true, projectDir, plan, templateVersion: templateVer, dryRun: !!opts.dryRun,
      reason: 'refusing to sync: ' + plan.unreadable.length + ' existing system file(s) could not be read (exists but unreadable — permission/lock issue, NEVER treated as "new"): '
        + plan.unreadable.map((u) => u.rel + ' (' + u.error + ')').join('; '),
    };
  }

  if (opts.dryRun) return { ok: true, dryRun: true, projectDir, plan, templateVersion: templateVer };

  if (plan.toChange.length === 0) { // H2: distinguish a clean no-op from a project BLOCKED by unresolved drift
    const blocked = plan.unknownDrift.length > 0 || plan.conflicts.length > 0;
    return { ok: !blocked, noop: !blocked, blocked, projectDir, plan, templateVersion: templateVer };
  }

  const nowIso = opts.nowIso || new Date().toISOString();
  const batchId = opts.batchId;

  // M3: reusing a --batch-id already backed up for THIS project would silently overwrite that manifest.
  const existingBatchManifestPath = path.join(backupDirFor(projectDir, batchId), 'manifest.json');
  if (fs.existsSync(existingBatchManifestPath) && !opts.resumeBatch) {
    return {
      ok: false, refused: true, projectDir, plan, templateVersion: templateVer,
      reason: 'batch ' + batchId + ' already has a backup manifest for this project (' + existingBatchManifestPath + ') — refusing to silently overwrite it (pass --resume-batch to intentionally reuse this batch id)',
    };
  }

  const preManifest = fullFileManifest(templateDir, projectDir);
  const preValidation = runValidation(projectDir, { toChange: [] }, { doctorTimeoutMs: opts.doctorTimeoutMs }); // H3 baseline
  const backup = takeBackup(projectDir, batchId, plan, templateVer, nowIso, { centralBackupRoot: opts.centralBackupRoot, runId: opts.runId });
  if (!backup.ok) { // S8: a backup I/O failure is a clean refusal, never an uncaught crash — nothing was applied yet
    return { ok: false, refused: true, projectDir, plan, templateVersion: templateVer, preManifest, backup, reason: 'refusing to sync: ' + backup.error };
  }

  const apply = applyPlanSafely(templateDir, projectDir, plan, opts.copyFileImpl);
  if (!apply.ok) {
    // Only the subset that was ACTUALLY written needs restoring — a file applyPlanSafely never reached
    // (e.g. the one that threw, or anything after it) was never modified from its pre-sync state.
    const appliedManifest = subsetManifest(backup.manifest, apply.applied);
    let restored = null, rollbackError = null;
    try { restored = restoreFromManifest(projectDir, backup.backupDir, appliedManifest); }
    catch (e) { rollbackError = e.message; }
    const rolledBack = !rollbackError && !!(restored && restored.ok !== false); // H1: never trust "no throw" alone
    return { ok: false, projectDir, plan, backup, applyError: apply.error, rolledBack, rollbackError, restored, preManifest };
  }

  const validation = runValidation(projectDir, plan, { doctorTimeoutMs: opts.doctorTimeoutMs });
  const outcome = decideValidationOutcome(preValidation, validation, { allowDegraded: opts.allowDegraded });
  if (!outcome.ok) {
    let restored = null, rollbackError = null;
    try { restored = restoreFromManifest(projectDir, backup.backupDir, backup.manifest); }
    catch (e) { rollbackError = e.message; }
    const rolledBack = !rollbackError && !!(restored && restored.ok !== false);
    return { ok: false, projectDir, plan, backup, validation, preValidation, outcome, rolledBack, rollbackError, restored, preManifest };
  }

  /** B3 (Blocker 3) FIX: opts.refuseOnUnresolvedDrift (set ONLY by the single-project `install` CLI path —
   *  sync-all deliberately does NOT set it, since its staged-rollout M8 semantics already treat "this
   *  project's own partial sync succeeded, but the batch still stops" as an accepted, distinct outcome, proven
   *  by section 40b). Without this fix, a project with SOME safely-syncable files AND unresolved
   *  unknown_drift/conflict on OTHER files would fall through the `plan.toChange.length === 0` early-return
   *  above (which is the ONLY place H2's `blocked` classification is computed) and proceed to apply+validate+
   *  STAMP the template version as if the whole project were fully synced — silently hiding the drift. A
   *  direct `install` refuses that: it is all-or-nothing — either every system file resolves cleanly (or via
   *  --force-overwrite/forge-overrides.json/adopt), or NOTHING is stamped and whatever WAS just applied is
   *  rolled back, so the project never falsely claims templateVersionTo. */
  if (opts.refuseOnUnresolvedDrift && !opts.forceOverwrite && (plan.unknownDrift.length > 0 || plan.conflicts.length > 0)) {
    let restored = null, rollbackError = null;
    try { restored = restoreFromManifest(projectDir, backup.backupDir, backup.manifest); }
    catch (e) { rollbackError = e.message; }
    const rolledBack = !rollbackError && !!(restored && restored.ok !== false);
    return {
      ok: false, refusedPartialDrift: true, projectDir, plan, backup, validation, preValidation, rolledBack, rollbackError, restored, preManifest,
      reason: 'refusing to stamp templateVersionTo: ' + plan.unknownDrift.length + ' unresolved drift + ' + plan.conflicts.length
        + ' conflict file(s) remain (use --force-overwrite, or resolve via .claude/config/forge-overrides.json/adopt) — a partially-synced project must never claim the new template version',
    };
  }

  const priorReceipt = readReceipt(projectDir);
  const ver = { forge_version: templateVer, synced_at: nowIso, template: templateDir, system_files: listSystemFiles(templateDir).length };
  fs.writeFileSync(versionFilePath(projectDir), JSON.stringify(ver, null, 2) + '\n');

  const postManifest = fullFileManifest(templateDir, projectDir);
  // B1: rebuild the CUMULATIVE baseline — carry forward every prior known hash, then overlay this sync's
  // toChange/same rels (anything NOT excluded/skipped) with their post-sync hash. unknownDrift/conflicts left
  // unresolved this round keep whatever baseline they already had (or none), never silently adopted.
  const priorKnownHashes = receiptLastTemplateHashMap(priorReceipt);
  const excludedRels = new Set([].concat(plan.expectedOverrides, plan.unknownDrift, plan.conflicts));
  const skippedRels = new Set((plan.skipped || []).map((s) => s.rel));
  const knownHashes = Object.assign({}, priorKnownHashes);
  for (const rel of Object.keys(postManifest)) {
    if (excludedRels.has(rel) || skippedRels.has(rel)) continue;
    if (postManifest[rel].hash != null) knownHashes[rel] = postManifest[rel].hash;
  }

  const receipt = {
    projectId: projectId(projectDir), projectPath: path.resolve(projectDir),
    batchId, runId: opts.runId || null,
    templateVersionFrom: priorReceipt ? (priorReceipt.templateVersionTo || priorReceipt.forge_version || null) : null,
    templateVersionTo: templateVer,
    backupRef: { project: backup.backupDir, central: backup.centralDir || null },
    preSyncManifestHash: aggregateManifestHash(preManifest),
    postSyncManifestHash: aggregateManifestHash(postManifest),
    filesChanged: plan.toChange.map((e) => ({ rel: e.rel, oldHash: e.oldHash, newHash: e.newHash, overrideClass: e.overrideClass || null })),
    knownHashes,
    overridesPreserved: { expectedOverride: plan.expectedOverrides, unknownDriftSkipped: plan.unknownDrift, conflictSkipped: plan.conflicts },
    validation: {
      tool: validation.tool, exitCode: validation.exitCode, ok: validation.ok, commands: validation.commands || [],
      summary: validation.summary || null, degraded: !!validation.degraded, degradedAllowed: !!outcome.degradedAllowed,
      alreadyRedSkipped: !!outcome.alreadyRedSkipped,
    },
    preValidation: { ok: preValidation.ok, summary: preValidation.summary || null, degraded: !!preValidation.degraded },
    // S8: this field used to be a bare hardcoded 'n/a' in every path, which reads as "not tracked" rather
    // than a real status. It is honestly always this exact value AT THE MOMENT this receipt is written: a
    // receipt only ever gets written for a sync that just SUCCEEDED, so by construction nothing has been (or
    // needed to be) rolled back yet. If this sync IS rolled back later, this receipt is itself restored/
    // removed by restoreFromManifest (see its receiptAction handling) — a rolled-back sync's receipt does not
    // persist in this form to have its OWN rollbackStatus flipped. Named explicitly rather than a vague 'n/a'.
    rollbackStatus: 'not_rolled_back_as_of_this_write',
    syncedAt: nowIso,
  };
  writeReceipt(projectDir, receipt);
  return { ok: true, projectDir, plan, backup, validation, preValidation, outcome, receipt, preManifest, postManifest };
}

/** adoptProject — NEW COMMAND: `forge-sync adopt <projectDir>`. Establishes a baseline receipt from the
 *  project's CURRENT file hashes WITHOUT writing a single template/system file, and reports which files
 *  differ from the template so a human can triage them into forge-overrides.json. Replaces a blind
 *  --force-overwrite as the safe way to onboard a project's very first sync. */
function adoptProject(templateDir, projectDir, opts) {
  opts = opts || {};
  if (!fs.existsSync(projectDir)) return { ok: false, refused: true, reason: 'project path missing: ' + projectDir };
  const dst = claudeDirOf(projectDir);
  if (!fs.existsSync(dst)) return { ok: false, refused: true, reason: 'not a project (.claude missing): ' + projectDir };
  const priorReceipt = readReceipt(projectDir);
  const priorBaselineCount = priorReceipt && priorReceipt.knownHashes && typeof priorReceipt.knownHashes === 'object' ? Object.keys(priorReceipt.knownHashes).length : 0;
  /** S5 FIX: running adopt a SECOND time on an already-baselined project used to silently REPLACE the
   *  existing knownHashes baseline — every file that was previously a protected unknown_drift (because its
   *  current content differed from an earlier trusted baseline) instantly became a plain, safe-to-overwrite
   *  toChange the moment the new baseline adopted its CURRENT (possibly hand-edited) bytes, and the OLD
   *  receipt was never preserved anywhere, so the replacement could not be undone. Now: refuse unless the
   *  caller explicitly opts in via opts.force, and when forced, snapshot the pre-adopt receipt first. */
  if (priorBaselineCount > 0 && !opts.force) {
    return {
      ok: false, refused: true, existingBaseline: true, priorBaselineCount, projectDir,
      reason: 'refusing to adopt: an existing baseline of ' + priorBaselineCount + ' file(s) is already recorded in forge-sync-receipt.json — '
        + 'this replaces an existing baseline of ' + priorBaselineCount + ' file(s) — these WILL be overwritten by the next sync; '
        + 'pass --force to intentionally replace it (the current receipt is snapshotted first, so this can still be undone)',
    };
  }
  const nowIso = opts.nowIso || new Date().toISOString();
  const knownHashes = {};
  const differing = [];
  for (const rel of listSystemFiles(templateDir)) {
    const src = path.join(templateDir, rel);
    if (!fs.existsSync(src)) continue;
    const out = safeJoin(dst, rel);
    if (out == null || isSymlinkPath(out) || !containmentSafe(dst, out)) continue;
    const status = fileStatus(out);
    if (status.kind !== 'ok') continue; // missing or unreadable -> nothing to adopt for this rel
    knownHashes[rel] = status.hash; // adopt WHATEVER is currently there, verbatim, as the trusted baseline
    if (status.hash !== sha256(src)) differing.push(rel);
  }
  // S5: snapshot the OLD receipt BEFORE replacing it, whenever one existed, so a --force replace is undoable.
  let snapshotPath = null;
  if (priorReceipt && !opts.dryRun) {
    const snapDir = path.join(dst, 'forge-adopt-snapshots');
    fs.mkdirSync(snapDir, { recursive: true });
    snapshotPath = path.join(snapDir, 'pre-adopt-' + nowIso.replace(/[^0-9a-zA-Z]/g, '-') + '.json');
    fs.writeFileSync(snapshotPath, JSON.stringify(priorReceipt, null, 2) + '\n', 'utf8');
  }
  const receipt = Object.assign({}, priorReceipt || {}, {
    projectId: projectId(projectDir), projectPath: path.resolve(projectDir),
    adopted: true, adoptedAt: nowIso,
    knownHashes,
    filesChanged: priorReceipt && Array.isArray(priorReceipt.filesChanged) ? priorReceipt.filesChanged : [],
    rollbackStatus: priorReceipt ? (priorReceipt.rollbackStatus || 'not_rolled_back_as_of_this_write') : 'not_rolled_back_as_of_this_write', // S8
    priorBaselineSnapshot: snapshotPath, // S5: undo pointer (null when there was no prior receipt to replace)
  });
  if (!opts.dryRun) writeReceipt(projectDir, receipt);
  return { ok: true, projectDir, differing, knownHashesCount: Object.keys(knownHashes).length, receipt, dryRun: !!opts.dryRun, priorBaselineCount, snapshotPath };
}

/** rawInstall — the OLD unsafe behavior, available only behind --unsafe: skips canary + validation. M7: it
 *  STILL takes a real, restorable backup first — "no undo" is never acceptable by construction, even in
 *  --unsafe mode. Dry-run remains a true zero-write preview.
 *  S2 FIX: --unsafe means "no canary, no validation" — it must NEVER also mean "no override allow-list, no
 *  containment/symlink guard, no undo." Before this fix, rawInstall never called readOverrideAllowlist (so it
 *  overwrote a forge-overrides.json-declared file the docstring claims is NEVER touched), never called
 *  safeJoin/isSymlinkPath/containmentSafe (so it could write straight through a junctioned forge-bin/ to
 *  somewhere OUTSIDE .claude/), and never called fileStatus (so an unreadable existing file was treated as
 *  "new" — no backup taken, then DELETED on a later rollback). All three guards now match the safe path. */
function rawInstall(templateDir, projectDir, opts) {
  opts = opts || {};
  const dst = claudeDirOf(projectDir);
  if (!fs.existsSync(dst)) { console.error('not a project (.claude missing): ' + projectDir); return { ok: false, exitCode: 1, projectDir }; }
  const allowlist = readOverrideAllowlist(projectDir); // S2: --unsafe must ALSO never touch a declared override
  const toChange = [];
  const skippedOverrides = [];
  const unreadable = [];
  let same = 0;
  for (const rel of listSystemFiles(templateDir)) {
    const src = path.join(templateDir, rel);
    if (!fs.existsSync(src)) continue;
    const out = safeJoin(dst, rel); // S2: containment guard — never resolve outside .claude/
    if (out == null) continue;
    if (isSymlinkPath(out) || !containmentSafe(dst, out)) continue; // S2: symlink/junction guard
    if (allowlist.has(rel)) { skippedOverrides.push(rel); continue; } // S2: never touch a declared override
    const outStatus = fileStatus(out);
    if (outStatus.kind === 'unreadable') { unreadable.push({ rel, error: outStatus.error }); continue; }
    const oldHash = outStatus.kind === 'ok' ? outStatus.hash : null;
    const newHash = sha256(src);
    if (oldHash === newHash) { same++; continue; }
    toChange.push({ rel, oldHash, newHash, isNew: oldHash === null, overrideClass: null });
  }
  if (unreadable.length) { // S2: same B3-style policy — never silently treat "unreadable" as "new" (which would skip backup then DELETE it on rollback)
    const msg = 'refusing --unsafe install: ' + unreadable.length + ' existing system file(s) could not be read (never treated as "new"): ' + unreadable.map((u) => u.rel + ' (' + u.error + ')').join('; ');
    console.error(msg);
    return { ok: false, exitCode: 1, projectDir, reason: msg, unreadable };
  }
  if (opts.dryRun) {
    toChange.forEach((e) => console.log('  would update ' + e.rel));
    console.log('[dry] ' + path.basename(projectDir) + ': ' + toChange.length + ' would update, ' + same + ' current' + (skippedOverrides.length ? (', ' + skippedOverrides.length + ' expected override(s) preserved') : ''));
    return { ok: true, exitCode: 0, projectDir, copied: toChange.length, same, skippedOverrides };
  }
  const batchId = opts.batchId || ('unsafe-' + Date.now());
  const nowIso = opts.nowIso || new Date().toISOString();
  const plan = { toChange, expectedOverrides: skippedOverrides, unknownDrift: [], conflicts: [], skipped: [], unreadable: [], same };
  const backup = takeBackup(projectDir, batchId, plan, templateVersion(templateDir), nowIso, { centralBackupRoot: opts.centralBackupRoot, runId: opts.runId });
  if (!backup.ok) { // S8: clean refusal instead of an uncaught crash
    console.error(path.basename(projectDir) + ': --unsafe refused: backup could not be taken — ' + backup.error);
    return { ok: false, exitCode: 1, projectDir, reason: backup.error, backup };
  }
  const apply = applyPlanSafely(templateDir, projectDir, plan);
  if (!apply.ok) {
    const appliedManifest = subsetManifest(backup.manifest, apply.applied);
    try { restoreFromManifest(projectDir, backup.backupDir, appliedManifest); } catch { /* best-effort */ }
    console.error(path.basename(projectDir) + ': --unsafe write FAILED (' + apply.error + ') -> rolled back applied subset (backup at ' + backup.backupDir + ')');
    return { ok: false, exitCode: 1, projectDir, applyError: apply.error, backup };
  }
  const ver = { forge_version: templateVersion(templateDir), synced_at: nowIso, template: templateDir, system_files: listSystemFiles(templateDir).length };
  fs.writeFileSync(path.join(dst, 'FORGE_VERSION.json'), JSON.stringify(ver, null, 2) + '\n');
  console.log(path.basename(projectDir) + ': ' + toChange.length + ' updated (UNSAFE — no canary/no validation), ' + same + ' current' + (skippedOverrides.length ? (', ' + skippedOverrides.length + ' expected override(s) preserved') : '') + ' -> version ' + ver.forge_version + ' · backup at ' + backup.backupDir);
  return { ok: true, exitCode: 0, projectDir, copied: toChange.length, same, backup, skippedOverrides };
}

function status(templateDir, projectDir, verbose) {
  const dst = claudeDirOf(projectDir);
  const tv = templateVersion(templateDir);
  let vf = {}; try { vf = JSON.parse(fs.readFileSync(path.join(dst, 'FORGE_VERSION.json'), 'utf8')); } catch { /* none */ }
  const drift = listSystemFiles(templateDir).filter((rel) => fs.existsSync(path.join(templateDir, rel)) && sha256(path.join(templateDir, rel)) !== sha256(path.join(dst, rel)));
  console.log(path.basename(projectDir) + ': installed=' + (vf.forge_version || 'none') + ' · template=' + tv + ' · ' + (drift.length ? ('DRIFT (' + drift.length + ' files behind) — run: forge-sync install') : 'up to date ✓'));
  if (drift.length && verbose) drift.forEach((f) => console.log('    behind: ' + f));
  return drift.length ? 1 : 0;
}

// Bounded-depth recursive project scan. Skips heavy/irrelevant dirs AND any dot-prefixed directory (which is
// how the dedicated canary at .forge-canary/ stays structurally excluded from real-project discovery).
function findForgeProjects(root, maxDepth) {
  maxDepth = maxDepth == null ? 3 : maxDepth;
  const out = [];
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    if (fs.existsSync(path.join(dir, '.claude', 'forge-dashboard'))) { out.push(dir); return; }
    if (depth === maxDepth) return;
    let entries = []; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  }
  let top = []; try { top = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of top) { if (e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) walk(path.join(root, e.name), 1); }
  return out;
}

// ---- dedicated, disposable sync canary (never one of the real 12 projects) ----
function dedicatedCanaryDir(rootDir) { return path.join(rootDir, CANARY_DIR_NAME); }
/** canary-init — create/refresh the dedicated canary project scaffold. M5: WIPES any prior canary state
 *  first (a canary that accumulates its own receipt/FORGE_VERSION/forge-runs across calls is not a canary —
 *  it would eventually accumulate a false-drift baseline of its own and abort every batch at stage 0).
 *  opts.doctorSource lets a test/CLI point it at a specific forge-doctor.cjs (real or stub); without one, the
 *  canary has no doctor and validation falls back to node --check on synced .cjs files. */
function canaryInit(templateDir, rootDir, opts) {
  opts = opts || {};
  const dir = dedicatedCanaryDir(rootDir);
  if (path.basename(dir) === CANARY_DIR_NAME) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort wipe */ } }
  fs.mkdirSync(path.join(dir, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'FORGE_CANARY_MARKER.json'), JSON.stringify({
    canary: true, createdAt: opts.nowIso || new Date().toISOString(),
    purpose: 'disposable dedicated sync canary — never a real project, never counted by findForgeProjects, wiped fresh on every canary-init',
  }, null, 2) + '\n', 'utf8');
  if (opts.doctorSource && fs.existsSync(opts.doctorSource)) fs.copyFileSync(opts.doctorSource, path.join(dir, '.claude', 'forge-bin', 'forge-doctor.cjs'));
  return { dir, refreshed: true };
}

function abortNote(result) { // M8: never say "(if applicable)" — say plainly whether anything was rolled back.
  // Three distinct shapes since H2: (1) blocked/refused before any write -> nothing to roll back; (2) ok:true
  // but STILL has unresolved drift on THIS project (some files synced fine, others left drifted) -> the
  // project's OWN sync succeeded and is stamped, nothing needs rolling back, but the batch still can't proceed
  // past it; (3) a genuine post-write failure -> rolled back (or not confirmed).
  if (result.blocked || result.refused) return 'nothing was written (blocked/refused before any write — never applied, so there was nothing to roll back)';
  if (result.ok) return 'this project\'s own sync succeeded (and is stamped) — but it still has unresolved drift/conflict blocking the batch from proceeding; nothing to roll back here';
  if (result.rolledBack) return 'rolled back';
  if (result.rollbackError) return 'ROLLBACK NOT CONFIRMED (' + result.rollbackError + ')';
  return 'rollback status unknown — see diagnostics';
}
function printRemediation(rootDir, batchId, centralBackupRoot, processedSoFar) {
  const alreadySynced = (processedSoFar || []).filter((pr) => pr.ok).map((pr) => path.basename(pr.projectDir));
  console.error('Already synced to the new version before this abort: ' + (alreadySynced.length ? alreadySynced.join(', ') : '(none)'));
  console.error('Remediation: node ' + quoteArg(__filename) + ' rollback-batch ' + batchId + ' ' + quoteArg(rootDir) + (centralBackupRoot ? (' --central-backup-root ' + quoteArg(centralBackupRoot)) : ''));
}

/**
 * runSyncAll — the safe multi-project orchestrator. opts: { projects (explicit override array, else
 * discovered from rootDir), canaryName (representative real project), stageSize, dryRun, forceOverwrite,
 * unsafe, batchId, nowIso, centralBackupRoot, runId, canaryDoctorSource, allowDegraded, doctorTimeoutMs }.
 * Flow: dedicated canary (ALWAYS first, never a real project) -> ONE representative real project ->
 * staged ladder (2 -> 3 -> stageSize thereafter). ANY validation failure OR unresolved unknown_drift/conflict
 * (without --force-overwrite) rolls back that project and STOPS the whole batch. H3c: prints a per-project
 * summary as each project is processed, and on any abort prints which projects are already on the new
 * version plus the literal rollback-batch remediation command.
 */
function runSyncAll(templateDir, rootDir, opts) {
  opts = opts || {};
  const nowIso = opts.nowIso || new Date().toISOString();
  const batchId = opts.batchId;
  const runId = opts.runId || null;
  const centralBackupRoot = opts.centralBackupRoot;
  const hasUnresolvedDrift = (r) => !opts.forceOverwrite && r && r.plan && (r.plan.unknownDrift.length > 0 || r.plan.conflicts.length > 0);
  const syncOpts = { forceOverwrite: opts.forceOverwrite, batchId, nowIso, centralBackupRoot, runId, allowDegraded: opts.allowDegraded, doctorTimeoutMs: opts.doctorTimeoutMs };
  // The dedicated canary is Forge's own disposable, synthetic smoke-test scaffold — in REAL production use it
  // always inherits the template's real forge-doctor.cjs (a SYSTEM file) on its very first sync, so the
  // degraded fallback essentially never triggers for it there. Only a template that genuinely lacks a doctor
  // (e.g. a minimal test fixture) hits the fallback for the canary specifically; treat that leniently
  // (allowDegraded) so the canary's job — proving the SYNC MECHANISM is safe — isn't blocked by the absence of
  // a doctor it doesn't own. Real projects (representative + staged) always respect the caller's actual
  // --allow-degraded flag (default strict) via plain `syncOpts`.
  const canarySyncOpts = Object.assign({}, syncOpts, { allowDegraded: true });
  /** S6 FIX: sync-all's CLI wrapper already holds the ROOT lock for the whole batch, but that alone doesn't
   *  stop a concurrent single-project `install <root>/proj` (which only locks THAT project's own
   *  `.claude/.forge-sync.lock`, a different path) from racing sync-all on the same files. Hold each
   *  project's OWN lock for exactly the duration this batch is writing to it, in addition to the root lock. */
  const lockedSync = (p, sOpts) => {
    const lock = acquireLock(claudeDirOf(p));
    if (!lock.ok) return { ok: false, refused: true, projectDir: p, reason: 'S6: could not acquire project lock for ' + p + ': ' + lock.reason };
    try { return safeSyncProject(templateDir, p, sOpts); }
    finally { releaseLock(lock); }
  };

  if (opts.unsafe) {
    console.warn('*** --unsafe: legacy-style sync (NO canary, NO validation) — a real backup is still taken per project (never "no undo") ***');
    const projects = Array.isArray(opts.projects) ? opts.projects : findForgeProjects(rootDir);
    let bad = 0; const results = [];
    for (const p of projects) { const r = rawInstall(templateDir, p, { dryRun: opts.dryRun, batchId, nowIso, centralBackupRoot, runId }); results.push(r); if (!r.ok) bad++; }
    return { ok: bad === 0, unsafe: true, batchId, projects: results };
  }

  if (opts.dryRun) {
    // True dry-run: ZERO filesystem writes, including scaffolding. buildPlan()/preflight() are fully
    // read-only and tolerate a project directory that doesn't exist yet -> the dedicated canary's plan can
    // be previewed WITHOUT ever calling canaryInit() (which would create real files on disk).
    const dedicatedPlan = buildPlan(templateDir, dedicatedCanaryDir(rootDir), { forceOverwrite: !!opts.forceOverwrite });
    const projects = Array.isArray(opts.projects) ? opts.projects : findForgeProjects(rootDir);
    const plans = projects.map((p) => ({ projectDir: p, plan: safeSyncProject(templateDir, p, Object.assign({}, syncOpts, { dryRun: true })).plan }));
    return { ok: true, dryRun: true, batchId, dedicatedCanary: { projectDir: dedicatedCanaryDir(rootDir), plan: dedicatedPlan }, projects: plans };
  }

  // Stage 0: dedicated canary — MANDATORY, always first, structurally never a real project.
  canaryInit(templateDir, rootDir, { nowIso, doctorSource: opts.canaryDoctorSource });
  const dedicatedDir = dedicatedCanaryDir(rootDir);
  console.log('stage 0 (dedicated canary): ' + dedicatedDir);
  const dedicatedResult = lockedSync(dedicatedDir, canarySyncOpts);
  printSafeSyncResult(dedicatedDir, dedicatedResult);
  if (!dedicatedResult.ok || hasUnresolvedDrift(dedicatedResult)) {
    console.error('DEDICATED CANARY ' + (dedicatedResult.ok ? 'HAS UNRESOLVED DRIFT' : 'FAILED') + ' -> ' + abortNote(dedicatedResult) + '. ABORTING before touching ANY real project.');
    printRemediation(rootDir, batchId, centralBackupRoot, []);
    return { ok: false, aborted: true, stage: 'dedicated-canary', batchId, dedicatedCanary: dedicatedResult, projects: [] };
  }

  const projects = Array.isArray(opts.projects) ? opts.projects : findForgeProjects(rootDir);
  if (!projects.length) { console.log('no real Forge project found under ' + rootDir); return { ok: true, batchId, dedicatedCanary: dedicatedResult, projects: [] }; }

  // Stage 1: ONE representative real project.
  let repIdx = 0;
  if (opts.canaryName) {
    const idx = projects.findIndex((p) => path.basename(p) === opts.canaryName || p === opts.canaryName);
    if (idx === -1) { console.error('forge-sync: --canary ' + opts.canaryName + ' not found among discovered projects'); return { ok: false, usageError: true, batchId, dedicatedCanary: dedicatedResult, projects: [] }; }
    repIdx = idx;
  }
  const repDir = projects[repIdx];
  const rest = projects.filter((_, i) => i !== repIdx);
  console.log('stage 1 (representative real project): ' + path.basename(repDir));
  const repResult = lockedSync(repDir, syncOpts);
  printSafeSyncResult(repDir, repResult);
  const processed = [repResult];
  if (!repResult.ok || hasUnresolvedDrift(repResult)) {
    console.error('REPRESENTATIVE PROJECT ' + (repResult.ok ? 'HAS UNRESOLVED DRIFT' : 'FAILED') + ' -> ' + abortNote(repResult) + '. ABORTING batch. Remaining ' + rest.length + ' project(s) untouched.');
    printRemediation(rootDir, batchId, centralBackupRoot, processed);
    return { ok: false, aborted: true, stage: 'representative', batchId, dedicatedCanary: dedicatedResult, projects: processed };
  }

  // Ladder: 2 -> 3 -> --stage-size (default 3) thereafter.
  const ladder = [2, 3];
  const stageSize = opts.stageSize > 0 ? opts.stageSize : 3;
  let idx2 = 0, stopped = false, stageNum = 2;
  while (idx2 < rest.length && !stopped) {
    const size = ladder.length ? ladder.shift() : stageSize;
    const stage = rest.slice(idx2, idx2 + size);
    console.log('stage ' + stageNum + ' (' + stage.length + ' project(s), ladder-size ' + size + ')');
    for (const p of stage) {
      const r = lockedSync(p, syncOpts);
      printSafeSyncResult(p, r);
      processed.push(r);
      if (!r.ok || hasUnresolvedDrift(r)) {
        console.error('VALIDATION/DRIFT FAILURE for ' + path.basename(p) + ' -> ' + abortNote(r) + '. STOPPING batch.');
        printRemediation(rootDir, batchId, centralBackupRoot, processed);
        stopped = true; break;
      }
    }
    idx2 += size; stageNum++;
  }
  const ok = processed.every((r) => r.ok && !hasUnresolvedDrift(r));
  return { ok, aborted: stopped, batchId, dedicatedCanary: dedicatedResult, representative: repResult, projects: processed };
}

function printPlanSummary(plan) {
  console.log('  to-change: ' + plan.toChange.length + (plan.toChange.length ? ' (' + plan.toChange.map((e) => e.rel).join(', ') + ')' : ''));
  if (plan.expectedOverrides && plan.expectedOverrides.length) console.log('  expected overrides (never touched): ' + plan.expectedOverrides.join(', '));
  if (plan.unknownDrift && plan.unknownDrift.length) console.log('  UNKNOWN DRIFT (blocked, use --force-overwrite): ' + plan.unknownDrift.join(', '));
  if (plan.conflicts && plan.conflicts.length) console.log('  CONFLICT — both changed (blocked, use --force-overwrite): ' + plan.conflicts.join(', '));
  if (plan.skipped && plan.skipped.length) console.log('  skipped (symlink/unsafe): ' + plan.skipped.map((s) => s.rel + ':' + s.reason).join(', '));
  if (plan.unreadable && plan.unreadable.length) console.log('  UNREADABLE (refuses the whole sync): ' + plan.unreadable.map((u) => u.rel).join(', '));
  console.log('  unchanged: ' + plan.same);
}
function printSafeSyncResult(projectDir, r) {
  const name = path.basename(projectDir);
  if (!r.ok && r.refused) { console.error(name + ': REFUSED — ' + r.reason); return; }
  if (r.dryRun) { console.log('[dry-run] ' + name + ':'); printPlanSummary(r.plan); return; }
  if (r.blocked) { console.error(name + ': BLOCKED: ' + r.plan.unknownDrift.length + ' drifted / ' + r.plan.conflicts.length + ' conflicted (use --force-overwrite or declare .claude/config/forge-overrides.json)'); return; }
  if (r.refusedPartialDrift) { // B3: never silently stamp a partially-synced project
    console.error(name + ': BLOCKED — ' + r.plan.unknownDrift.length + ' drifted / ' + r.plan.conflicts.length + ' conflicted file(s) prevent a full sync (use --force-overwrite or declare .claude/config/forge-overrides.json); safely-syncable file(s) were rolled back, NOT partially stamped');
    if (r.plan.unknownDrift.length) console.error('  UNKNOWN DRIFT: ' + r.plan.unknownDrift.join(', '));
    if (r.plan.conflicts.length) console.error('  CONFLICT: ' + r.plan.conflicts.join(', '));
    return;
  }
  if (r.noop) { console.log(name + ': up to date (' + r.plan.same + ' unchanged)'); if (r.plan.unknownDrift.length || r.plan.conflicts.length) printPlanSummary(r.plan); return; }
  if (r.ok) {
    const note = r.outcome && r.outcome.alreadyRedSkipped ? ' [pre-existing unrelated failure(s), not attributed to this sync]' : (r.outcome && r.outcome.degradedAllowed ? ' [DEGRADED validator, --allow-degraded]' : '');
    console.log(name + ': ' + r.plan.toChange.length + ' updated, ' + r.plan.same + ' current -> version ' + r.receipt.templateVersionTo + ' · validation: ' + r.validation.tool + ' OK' + note);
    if (r.plan.expectedOverrides.length) console.log('  expected overrides preserved: ' + r.plan.expectedOverrides.join(', '));
  } else {
    const failLabel = r.validation ? (r.validation.timedOut ? (r.validation.tool + ' TIMED OUT (blocked, not a confirmed failure)') : (r.validation.tool + ', exit ' + r.validation.exitCode)) : (r.applyError || 'unknown');
    let rbNote;
    if (r.rollbackError) rbNote = 'rollback ERROR: ' + r.rollbackError;
    else if (r.restored && r.restored.refusedDivergence) rbNote = 'rollback REFUSED (content diverged since this sync — see diagnostics)';
    else if (r.restored && r.restored.ok === false) rbNote = 'PARTIAL ROLLBACK — MANUAL RECOVERY REQUIRED (' + (r.restored.failed || []).length + ' file(s); backup at ' + (r.backup ? r.backup.backupDir : '?') + ')';
    else rbNote = 'rolled back ' + (r.restored ? r.restored.restored.length : 0) + ' file(s)';
    console.error(name + ': FAILED (' + failLabel + ') -> ' + rbNote);
  }
}

/** parseArgs — M1: a value-taking flag (e.g. --run-id) that is followed by ANOTHER flag or nothing at all
 *  (e.g. `--run-id --dry-run`) must be refused, not silently swallow the next flag as its value (which would
 *  leave --dry-run's own flag unset while a real, non-dry-run sync proceeds). Returns argError (non-null on
 *  a bad value) for the caller to turn into a usage exit(2). */
function parseArgs(argv) {
  const flags = {};
  const pos = [];
  let argError = null;
  const takeValue = (i, name) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) { if (!argError) argError = 'missing value for ' + name; return { value: null, consumed: 0 }; }
    return { value: v, consumed: 1 };
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--force-overwrite') flags.forceOverwrite = true;
    else if (a === '--force-all') flags.forceAll = true;
    else if (a === '--force') flags.force = true; // S5: adopt's explicit opt-in to replace an existing baseline
    else if (a === '--unsafe') flags.unsafe = true;
    else if (a === '--verbose') flags.verbose = true;
    else if (a === '--json') flags.json = true;
    else if (a === '--allow-degraded') flags.allowDegraded = true;
    else if (a === '--no-central-backup') flags.noCentralBackup = true;
    else if (a === '--force-rollback-newer') flags.forceRollbackNewer = true;
    else if (a === '--resume-batch') flags.resumeBatch = true;
    else if (a === '--canary') { const r = takeValue(i, '--canary'); flags.canary = r.value; i += r.consumed; }
    else if (a === '--stage-size') { // S8: a non-numeric value must be a usage error, not a silent NaN-fallback-to-default
      const r = takeValue(i, '--stage-size'); i += r.consumed;
      if (r.value != null) { const n = Number(r.value); if (!Number.isFinite(n)) { if (!argError) argError = '--stage-size must be a number, got: ' + r.value; } else flags.stageSize = n; }
    }
    else if (a === '--batch-id' || a === '--batch') { const r = takeValue(i, '--batch-id'); flags.batchId = r.value; i += r.consumed; }
    else if (a === '--central-backup-root') { const r = takeValue(i, '--central-backup-root'); flags.centralBackupRoot = r.value; i += r.consumed; }
    else if (a === '--run-id') { const r = takeValue(i, '--run-id'); flags.runId = r.value; i += r.consumed; }
    else if (a === '--doctor-timeout') { // S8: same numeric-validation treatment as --stage-size
      const r = takeValue(i, '--doctor-timeout'); i += r.consumed;
      if (r.value != null) { const n = Number(r.value); if (!Number.isFinite(n)) { if (!argError) argError = '--doctor-timeout must be a number, got: ' + r.value; } else flags.doctorTimeout = n; }
    }
    else if (!a.startsWith('--')) pos.push(a);
  }
  return { flags, pos, argError };
}

module.exports = {
  listSystemFiles, sha256, sha256Normalized, normalizeEolBuffer, fileStatus, templateVersion, claudeDirOf, safeJoin, isSymlinkPath,
  containmentSafe, projectId, receiptPath, readReceipt, writeReceipt, receiptLastTemplateHashMap,
  overridesAllowlistPath, readOverrideAllowlist,
  preflight, buildPlan, fullFileManifest, aggregateManifestHash,
  versionFilePath, readVersionFile, backupDirFor, centralBackupDir, takeBackup, applyPlanSafely, runValidation,
  decideValidationOutcome, evidenceOk, condenseDoctorSummary, regressionCheck,
  verifyBackupIntegrity, loadTrustedManifest, findNewerOverlappingBatches, restoreFromManifest, subsetManifest,
  journalPath, latestBatchId, acquireLock, releaseLock, lockPathFor,
  rollbackProject, rollbackBatch, safeSyncProject, adoptProject, rawInstall, status, findForgeProjects,
  dedicatedCanaryDir, canaryInit, runSyncAll, parseArgs, CANARY_DIR_NAME,
};

// ---- CLI ----
if (require.main === module) {
  const GLOBAL_TEMPLATE = path.join(os.homedir(), '.claude', 'forge', 'template', '.claude');
  const TEMPLATE = process.env.FORGE_SYNC_TEMPLATE_DIR
    ? path.resolve(process.env.FORGE_SYNC_TEMPLATE_DIR)
    : (fs.existsSync(GLOBAL_TEMPLATE) ? GLOBAL_TEMPLATE : path.resolve(__dirname, '..'));

  const argv = process.argv.slice(2);
  const cmd = argv[0] || 'status';
  const { flags, pos, argError } = parseArgs(argv.slice(1));

  function exitUsage(msg) { console.error(msg); process.exit(2); }

  if (argError) exitUsage('forge-sync: ' + argError); // M1

  const defaultProject = pos[0] || path.resolve(__dirname, '..', '..'); // status/doctor only: read-only, low risk
  const batchId = flags.batchId || ('sync-' + Date.now());

  if (cmd === 'status' || cmd === 'doctor') {
    process.exit(status(TEMPLATE, defaultProject, flags.verbose));
  } else if (cmd === 'install') {
    if (!pos[0]) exitUsage('usage: forge-sync install <projectDir> [--dry-run] [--force-overwrite] [--unsafe] [--batch-id <id>] [--central-backup-root <dir>] [--no-central-backup] [--run-id <id>] [--allow-degraded] [--doctor-timeout <ms>] [--resume-batch]');
    // B5: default central backup hub lives OUTSIDE the project (its parent dir), never inside it.
    const centralBackupRoot = flags.noCentralBackup ? null : (flags.centralBackupRoot || path.join(path.dirname(path.resolve(pos[0])), '.forge-backup-hub'));
    const lock = flags.dryRun ? { ok: true, lockPath: null } : acquireLock(claudeDirOf(pos[0])); // M2
    if (!lock.ok) { console.error('forge-sync: ' + lock.reason); process.exit(1); }
    let exitCode = 1;
    try {
      if (flags.unsafe) {
        console.warn('*** --unsafe: legacy-style install for ' + pos[0] + ' — NO canary, NO validation; a real backup is still taken (never "no undo") ***');
        const r = rawInstall(TEMPLATE, pos[0], { dryRun: flags.dryRun, batchId, centralBackupRoot, runId: flags.runId });
        exitCode = r.ok ? 0 : 1;
      } else {
        const r = safeSyncProject(TEMPLATE, pos[0], {
          dryRun: flags.dryRun, forceOverwrite: flags.forceOverwrite, batchId, centralBackupRoot, runId: flags.runId,
          allowDegraded: flags.allowDegraded, doctorTimeoutMs: flags.doctorTimeout, resumeBatch: flags.resumeBatch,
          refuseOnUnresolvedDrift: true, // B3: a direct single-project install is all-or-nothing (sync-all is not)
        });
        printSafeSyncResult(pos[0], r);
        exitCode = (r.ok || r.dryRun || r.noop) ? 0 : 1;
      }
    } finally { releaseLock(lock); }
    process.exit(exitCode);
  } else if (cmd === 'adopt') {
    if (!pos[0]) exitUsage('usage: forge-sync adopt <projectDir> [--dry-run] [--force]');
    const lock = flags.dryRun ? { ok: true, lockPath: null } : acquireLock(claudeDirOf(pos[0])); // S6: adopt writes the receipt — must lock like install does
    if (!lock.ok) { console.error('forge-sync: ' + lock.reason); process.exit(1); }
    let r;
    try { r = adoptProject(TEMPLATE, pos[0], { dryRun: flags.dryRun, force: flags.force }); }
    finally { releaseLock(lock); }
    if (!r.ok) {
      console.error(r.reason);
      process.exit(1);
    }
    if (r.priorBaselineCount > 0) console.log('  NOTE: this replaces an existing baseline of ' + r.priorBaselineCount + ' file(s) — these WILL be overwritten by the next sync' + (r.snapshotPath ? (' (pre-adopt receipt snapshotted to ' + r.snapshotPath + ')') : ''));
    console.log((r.dryRun ? '[dry-run] ' : '') + 'adopted baseline for ' + path.basename(path.resolve(pos[0])) + ': ' + r.knownHashesCount + ' file(s) baselined' + (r.dryRun ? ' (NOT written)' : ''));
    if (r.differing.length) {
      console.log('  ' + r.differing.length + ' file(s) differ from the template — triage into .claude/config/forge-overrides.json if intentionally project-owned:');
      r.differing.forEach((rel) => console.log('    ' + rel));
    } else console.log('  no files differ from the template.');
    process.exit(0);
  } else if (cmd === 'list') {
    const rootDir = pos[0] || process.env.FORGE_SYNC_ROOT; // B6: no ~/Documents default
    if (!rootDir) exitUsage('usage: forge-sync list <rootDir> (root required — pass a positional root or set FORGE_SYNC_ROOT; no home-dir default)');
    const ps = findForgeProjects(rootDir);
    console.log(ps.length + ' Forge project(s) under ' + rootDir + ':');
    ps.forEach((p) => console.log('  ' + p));
    process.exit(0);
  } else if (cmd === 'canary-init') {
    const rootDir = pos[0] || process.env.FORGE_SYNC_ROOT; // B6
    if (!rootDir) exitUsage('usage: forge-sync canary-init <rootDir> (root required — pass a positional root or set FORGE_SYNC_ROOT; no home-dir default)');
    const r = canaryInit(TEMPLATE, rootDir, {});
    console.log('dedicated canary ready at ' + r.dir);
    process.exit(0);
  } else if (cmd === 'sync-all') {
    const rootDir = pos[0] || process.env.FORGE_SYNC_ROOT; // B6
    if (!rootDir) exitUsage('usage: forge-sync sync-all <rootDir> [...] (root required — pass a positional root or set FORGE_SYNC_ROOT; no home-dir default)');
    if (flags.forceOverwrite && !flags.forceAll) exitUsage('forge-sync: --force-overwrite in sync-all requires the explicit --force-all co-flag (prevents an accidental blanket override across every discovered project)');
    const centralBackupRoot = flags.noCentralBackup ? null : (flags.centralBackupRoot || path.join(rootDir, '.forge-backup-hub')); // B5
    if (flags.unsafe) console.warn('*** --unsafe: legacy-style sync-all — NO canary, NO validation; a real backup is still taken per project (never "no undo") ***');
    if (flags.forceOverwrite && flags.forceAll && !flags.dryRun) { // print the exact per-project file list BEFORE writing
      const previewProjects = findForgeProjects(rootDir);
      console.log('--force-overwrite --force-all: the following file(s) will be forced through per project (backed up first):');
      for (const p of previewProjects) {
        const pf = preflight(TEMPLATE, p);
        const forced = pf.unknownDrift.concat(pf.conflicts);
        if (forced.length) console.log('  ' + path.basename(p) + ': ' + forced.join(', '));
      }
    }
    const lock = flags.dryRun ? { ok: true, lockPath: null } : acquireLock(rootDir); // M2
    if (!lock.ok) { console.error('forge-sync: ' + lock.reason); process.exit(1); }
    let exitCode = 1;
    try {
      const result = runSyncAll(TEMPLATE, rootDir, {
        canaryName: flags.canary, stageSize: flags.stageSize, dryRun: flags.dryRun,
        forceOverwrite: flags.forceOverwrite, unsafe: flags.unsafe, batchId,
        centralBackupRoot, runId: flags.runId, allowDegraded: flags.allowDegraded, doctorTimeoutMs: flags.doctorTimeout,
      });
      // A dry-run computes the full per-project plan but writes nothing — SHOW it, otherwise the preview is
      // useless (the operator cannot see what would change before authorising a real 12-project sync).
      if (result.dryRun) {
        if (flags.json) { console.log(JSON.stringify(result, null, 2)); }
        else {
          console.log('[DRY-RUN] sync-all plan for ' + (result.projects ? result.projects.length : 0) + ' project(s) under ' + rootDir + ' — WRITES NOTHING:');
          if (result.dedicatedCanary && result.dedicatedCanary.plan) { console.log('\ndedicated canary (' + path.basename(result.dedicatedCanary.projectDir) + '):'); printPlanSummary(result.dedicatedCanary.plan); }
          for (const p of (result.projects || [])) { console.log('\n' + path.basename(p.projectDir) + ':'); if (p.plan) printPlanSummary(p.plan); else console.log('  (no plan — ' + (p.reason || 'unavailable') + ')'); }
        }
      }
      exitCode = result.ok ? 0 : 1;
    } finally { releaseLock(lock); }
    process.exit(exitCode);
  } else if (cmd === 'rollback') {
    if (!pos[0]) exitUsage('usage: forge-sync rollback <projectDir> [--batch <batchId>] [--central-backup-root <dir>] [--no-central-backup] [--force-rollback-newer]');
    const centralBackupRoot = flags.noCentralBackup ? null : (flags.centralBackupRoot || path.join(path.dirname(path.resolve(pos[0])), '.forge-backup-hub'));
    const centralBackupRootExplicit = !!(flags.centralBackupRoot || flags.noCentralBackup); // S3
    const lock = acquireLock(claudeDirOf(pos[0])); // S6: rollback writes to the project — must lock like install does
    if (!lock.ok) { console.error('forge-sync: ' + lock.reason); process.exit(1); }
    let r;
    try { r = rollbackProject(pos[0], flags.batchId || null, { centralBackupRoot, centralBackupRootExplicit, forceRollbackNewer: flags.forceRollbackNewer }); }
    finally { releaseLock(lock); }
    if (!r.ok) { console.error('rollback failed: ' + r.reason); process.exit(1); }
    console.log('rolled back ' + pos[0] + ' (batch ' + r.batchId + ', source ' + r.source + '): ' + r.restored.length + ' file(s) restored, version ' + r.versionAction + ', receipt ' + r.receiptAction);
    process.exit(0);
  } else if (cmd === 'rollback-batch') {
    if (!pos[0]) exitUsage('usage: forge-sync rollback-batch <batchId> <rootDir> [--central-backup-root <dir>] [--no-central-backup] [--force-rollback-newer]');
    const bId = pos[0];
    const rootDir = pos[1] || process.env.FORGE_SYNC_ROOT; // B6
    if (!rootDir) exitUsage('usage: forge-sync rollback-batch <batchId> <rootDir> (root required — no home-dir default)');
    const centralBackupRoot = flags.noCentralBackup ? null : (flags.centralBackupRoot || path.join(rootDir, '.forge-backup-hub'));
    const centralBackupRootExplicit = !!(flags.centralBackupRoot || flags.noCentralBackup); // S3
    const rootLock = acquireLock(rootDir); // S6: mirrors sync-all's root lock
    if (!rootLock.ok) { console.error('forge-sync: ' + rootLock.reason); process.exit(1); }
    let results;
    try { results = rollbackBatch(rootDir, bId, { centralBackupRoot, centralBackupRootExplicit, forceRollbackNewer: flags.forceRollbackNewer }); }
    finally { releaseLock(rootLock); }
    results.forEach((r) => console.log((r.ok ? 'rolled back ' : 'FAILED ') + r.projectDir + (r.ok ? (': ' + r.restored.length + ' file(s)') : (': ' + r.reason))));
    const okCount = results.filter((r) => r.ok).length; // B4: count only real successes, never results.length
    console.log(okCount + ' of ' + results.length + ' project(s) rolled back for batch ' + bId);
    process.exit(results.length > 0 && okCount === results.length ? 0 : 1);
  } else {
    exitUsage('unknown command: ' + cmd + ' (use status|install|adopt|list|canary-init|sync-all|doctor|rollback|rollback-batch)');
  }
}
