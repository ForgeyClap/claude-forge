#!/usr/bin/env node
'use strict';
/**
 * Hermetic tests for forge-sync.cjs (WP1 safe-sync, 2026-07-14, + owner-approved addendum). EVERY fixture
 * (fake template, fake projects, fake dedicated canary, fake central backup hub) lives under a fresh
 * os.tmpdir() directory — this file NEVER touches this repo's real .claude/, the real 12 Forge projects, or
 * runs sync-all/install against anything real. Exit 0 = all pass.
 *
 * Section map (spec item -> test section):
 *   ORIGINAL SPEC 1-10                          -> sections 1-10
 *   ADDENDUM A (byte-manifest rollback proof)   -> sections 2, 6a/6b (fullFileManifest before/after)
 *   ADDENDUM B (two-stage canary + ladder)      -> sections 3, 4, 5, 11
 *   ADDENDUM C (central backup independence)    -> section 12
 *   ADDENDUM D (3-class override classification)-> section 13
 *   ADDENDUM E (extended receipt fields)         -> section 9
 *   ADDENDUM F1-F9 (9 failure cases)            -> sections 14-22
 *   ADDENDUM G (no global sync)                 -> structural (every fixture is os.tmpdir()-only; see grep note)
 *   M-B3 mutant kill (QA gate, hardening 2026-07-14) -> section 58 (58a: readFileSync EPERM catch branch;
 *                                                       58b: non-ENOENT lstatSync catch branch)
 *   MEDIUM FIX (adversarial break-swarm repro, 2026-07-15) -> section 61: regressionCheck no longer exempts
 *   a doctor check the sync itself just introduced (absent pre-sync) when that check is red post-sync.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
process.env.FORGE_SYNC_TEST_HOOKS = '1'; // M11: __throwAfter is gated behind this env var in production code
const sync = require('./forge-sync.cjs');

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };

const CLI = path.join(__dirname, 'forge-sync.cjs');
const ALL_FIXTURE_ROOTS = []; // addendum G proof: every fixture dir this suite ever creates, tracked for real
function freshDir(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); ALL_FIXTURE_ROOTS.push(d); return d; }
function runCLI(argv, opts) { return spawnSync(process.execPath, [CLI, ...argv], Object.assign({ encoding: 'utf8' }, opts || {})); }
// runCLIWithTemplate — for CLI commands that read system-file content (install/sync-all), FORGE_SYNC_TEMPLATE_DIR
// MUST be overridden to a fixture dir; otherwise the CLI falls back to the REAL global/repo template and a
// "hermetic" test would silently sync real production system files into a throwaway fixture project.
function runCLIWithTemplate(argv, tpl, opts) {
  return runCLI(argv, Object.assign({}, opts || {}, { env: Object.assign({}, process.env, { FORGE_SYNC_TEMPLATE_DIR: tpl }) }));
}

// writeDoctorStub — a fake forge-doctor.cjs that honors the REAL --json evidence CONTRACT (H4): it always
// emits a structured {ok, checks:{node_check,tests}} object on --json so runValidation()'s evidence gate
// (node_check.total>=synced-files, tests.suites>0, tests.passed>0) is satisfied by default. By DEFAULT the
// sub-checks mirror exitCode (a "failing" stub reports node_check.ok:false, simulating "the file(s) I just
// synced are themselves broken" — the unconditional hard gate), which is what every existing exitCode:1
// fixture in this suite actually means; opts lets a specific test override individual fields.
function writeDoctorStub(projectDir, exitCode, extraJs, opts) {
  opts = opts || {};
  const dir = path.join(projectDir, '.claude', 'forge-bin');
  fs.mkdirSync(dir, { recursive: true });
  const totalCjs = opts.totalCjs != null ? opts.totalCjs : 50;
  const suites = opts.suites != null ? opts.suites : 5;
  const passedTests = opts.passed != null ? opts.passed : 20;
  const nodeCheckOk = opts.nodeCheckOk != null ? opts.nodeCheckOk : (exitCode === 0);
  const testsOk = opts.testsOk != null ? opts.testsOk : (exitCode === 0);
  const jsonObj = {
    ok: exitCode === 0,
    checks: {
      node_check: { ok: nodeCheckOk, total: totalCjs, failed: nodeCheckOk ? 0 : 1 },
      tests: { ok: testsOk, suites, passed: passedTests, failed: testsOk ? 0 : 1 },
    },
  };
  const src = [
    '#!/usr/bin/env node',
    extraJs || '',
    'var __args = process.argv.slice(2);',
    'if (__args.indexOf("--json") !== -1) { console.log(' + JSON.stringify(JSON.stringify(jsonObj)) + '); }',
    'process.exit(' + exitCode + ');',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'forge-doctor.cjs'), src, 'utf8');
}
function makeProject(root, name, doctorExit) {
  const p = path.join(root, name);
  fs.mkdirSync(path.join(p, '.claude'), { recursive: true });
  if (doctorExit != null) writeDoctorStub(p, doctorExit);
  return p;
}

// ---- section 63 (wp4 canary fix) helpers ----
// writeStubLogEvent — a MINIMAL, fully hermetic stand-in for forge-dashboard/log-event.cjs: same CLI shape
// (<run_id> <event_type> [json]) and the same "resolve forge-runs/ relative to the SCRIPT'S OWN location, not
// cwd" contract seedCanaryRun's doc comment relies on, but WITHOUT the real file's strict-mode vocabulary
// machinery — this section is testing seedCanaryRun's OWN mechanics (does it spawn the right command, does it
// report ok based on the real exit code, does the resulting events.jsonl really land under the JUST-SYNCED
// project's own forge-runs/), not re-testing log-event.cjs itself (that has its own dedicated test file).
function writeStubLogEvent(dashboardDir) {
  fs.mkdirSync(dashboardDir, { recursive: true });
  const src = [
    '#!/usr/bin/env node',
    'var fs = require("fs"), path = require("path");',
    'var CLAUDE_DIR = path.resolve(__dirname, "..");',
    'var args = process.argv.slice(2);',
    'var runId = args[0], eventType = args[1];',
    'if (!runId || !eventType) { console.error("run_id/event_type required"); process.exit(1); }',
    'var extra = {};',
    'if (args[2]) { try { extra = JSON.parse(args[2]); } catch (e) { console.error("bad json"); process.exit(1); } }',
    'var ev = Object.assign({ run_id: runId, event_type: eventType, timestamp: new Date().toISOString() }, extra);',
    'var runDir = path.join(CLAUDE_DIR, "forge-runs", runId);',
    'fs.mkdirSync(runDir, { recursive: true });',
    'fs.appendFileSync(path.join(runDir, "events.jsonl"), JSON.stringify(ev) + "\\n");',
    'process.exit(0);',
  ].join('\n');
  fs.writeFileSync(path.join(dashboardDir, 'log-event.cjs'), src, 'utf8');
}
// writeRequiresRealRunDoctor — a small, deterministic repro of the EXACT real-world defect class (2026-07-26,
// forge-capabilities-panel.test.cjs's genuine "at least one real run with events.jsonl exists" precondition):
// reports tests.ok true ONLY when <root>/.claude/forge-runs/ contains at least one directory with a real
// events.jsonl file. opts.alsoBreakNodeCheck simulates a template that is ALSO genuinely broken for an
// unrelated reason, to prove seeding a run never masks a real regression.
function writeRequiresRealRunDoctor(dir, opts) {
  opts = opts || {};
  fs.mkdirSync(dir, { recursive: true });
  const src = [
    '#!/usr/bin/env node',
    'var fs = require("fs"), path = require("path");',
    'var args = process.argv.slice(2);',
    'var ri = args.indexOf("--root"); var root = ri !== -1 ? args[ri + 1] : process.cwd();',
    'var runsDir = path.join(root, ".claude", "forge-runs");',
    'var hasReal = false;',
    'try { var ents = fs.readdirSync(runsDir, { withFileTypes: true }); hasReal = ents.some(function (e) { return e.isDirectory() && fs.existsSync(path.join(runsDir, e.name, "events.jsonl")); }); } catch (e) {}',
    'var nodeCheckOk = ' + (opts.alsoBreakNodeCheck ? 'false' : 'true') + ';',
    'var testsOk = hasReal;',
    'var overallOk = nodeCheckOk && testsOk;',
    'if (args.indexOf("--json") !== -1) { console.log(JSON.stringify({ ok: overallOk, checks: { node_check: { ok: nodeCheckOk, total: 50, failed: nodeCheckOk ? 0 : 1 }, tests: { ok: testsOk, suites: 1, passed: hasReal ? 5 : 4, failed: testsOk ? 0 : 1 } } })); }',
    'process.exit(overallOk ? 0 : 1);',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'forge-doctor.cjs'), src, 'utf8');
}
function makeRealProjectMarker(projectDir) { // findForgeProjects() only counts a dir with .claude/forge-dashboard
  fs.mkdirSync(path.join(projectDir, '.claude', 'forge-dashboard'), { recursive: true });
}
function snapshotTree(dir) {
  const out = {};
  const walk = (d) => {
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else { try { out[p] = fs.readFileSync(p).toString('hex'); } catch { /* unreadable, skip */ } }
    }
  };
  walk(dir);
  return out;
}
function fakeReceiptMatchingCurrent(projectDir, relHashPairs) { // pretend "we last wrote exactly this" for each rel
  fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
  sync.writeReceipt(projectDir, { filesChanged: relHashPairs.map(([rel, newHash]) => ({ rel, oldHash: null, newHash })) });
}

console.log('forge-sync.cjs offline tests (hermetic — os.tmpdir() fixtures ONLY, never the real 12 projects)');

// =====================================================================================
// 1) DRY-RUN WRITES NOTHING
// =====================================================================================
console.log('\n1) dry-run writes nothing');
{
  const tpl = freshDir('t1-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'console.log("v1");\n');
  const root = freshDir('t1-root');
  const pA = makeProject(root, 'projA', 0);
  const pB = makeProject(root, 'projB', 0);
  makeRealProjectMarker(pA); makeRealProjectMarker(pB);
  const before = snapshotTree(root);
  const r = sync.runSyncAll(tpl, root, { projects: [pA, pB], dryRun: true, batchId: 'dry-b1', nowIso: '2026-01-01T00:00:00.000Z' });
  const after = snapshotTree(root);
  t('dry-run reports ok:true', r.ok === true && r.dryRun === true);
  t('dry-run dedicated-canary plan shows 1 file to change', r.dedicatedCanary.plan.toChange.length === 1);
  t('dry-run per-project plans show 1 file to change each', r.projects.every((p) => p.plan.toChange.length === 1));
  t('NOT ONE byte changed anywhere under the root (dry-run writes nothing)', JSON.stringify(before) === JSON.stringify(after));
  t('no forge-backups dir created anywhere', !Object.keys(after).some((k) => k.includes('forge-backups')));
  t('no receipt file created anywhere', !Object.keys(after).some((k) => k.includes('forge-sync-receipt.json')));
}

// =====================================================================================
// 2) BACKUP CREATED WITH CORRECT OLD HASHES BEFORE ANY OVERWRITE (+ full pre/post manifest, addendum A)
// =====================================================================================
console.log('\n2) backup created with correct old hashes before overwrite (full manifest proof)');
{
  const tpl = freshDir('t2-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'V2-CONTENT');
  const p = makeProject(freshDir('t2-root'), 'proj', 0);
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'V1-CONTENT');
  const v1Hash = sync.sha256(path.join(p, '.claude', 'forge-bin', 'tool.cjs'));
  fakeReceiptMatchingCurrent(p, [['forge-bin/tool.cjs', v1Hash]]); // legitimate prior sync baseline, not an override
  const preManifest = sync.fullFileManifest(tpl, p);
  const r = sync.safeSyncProject(tpl, p, { batchId: 'b2', nowIso: '2026-01-01T00:00:00.000Z' });
  t('sync succeeded', r.ok === true);
  t('manifest.files records the OLD hash (v1), not the new one', r.backup.manifest.files[0].oldHash === v1Hash);
  const backupBytes = fs.readFileSync(path.join(r.backup.backupDir, 'forge-bin', 'tool.cjs'), 'utf8');
  t('backup COPY on disk contains the OLD bytes (V1-CONTENT)', backupBytes === 'V1-CONTENT');
  t('project file now contains the NEW bytes (V2-CONTENT) — write happened after backup', fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'utf8') === 'V2-CONTENT');
  t('preManifest (returned) shows the OLD hash for this file', r.preManifest['forge-bin/tool.cjs'].hash === v1Hash);
  t('postManifest (returned) shows the NEW hash for this file', r.postManifest['forge-bin/tool.cjs'].hash === sync.sha256(path.join(tpl, 'forge-bin', 'tool.cjs')));
  // rollback + full-manifest byte-exact proof (addendum A: compare the FULL manifest, not just exit code)
  const rb = sync.rollbackProject(p, 'b2', {});
  t('rollback reports ok:true', rb.ok === true);
  const postRollbackManifest = sync.fullFileManifest(tpl, p);
  t('FULL manifest is byte-identical pre-sync vs post-rollback (not just "rollback exited ok")', JSON.stringify(preManifest) === JSON.stringify(postRollbackManifest));
}

// =====================================================================================
// 3) TWO-STAGE CANARY ORDERING: dedicated canary runs FIRST, before any real project write
// =====================================================================================
console.log('\n3) dedicated canary syncs first; real projects untouched at that moment (addendum B)');
{
  const tpl = freshDir('t3-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'NEW-TEMPLATE-CONTENT');
  const root = freshDir('t3-root');
  const real1 = makeProject(root, 'real1', 0);
  makeRealProjectMarker(real1);
  fs.mkdirSync(path.join(real1, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(real1, '.claude', 'forge-bin', 'tool.cjs'), 'OLD-REAL-CONTENT');
  const oldHash = sync.sha256(path.join(real1, '.claude', 'forge-bin', 'tool.cjs'));
  fakeReceiptMatchingCurrent(real1, [['forge-bin/tool.cjs', oldHash]]);
  // the dedicated canary's own doctor snapshots real1's file content AT THE MOMENT it validates
  const snapshotFile = path.join(root, 'snapshot-at-canary-validation.txt');
  const dedicated = sync.dedicatedCanaryDir(root);
  const canaryDoctorSrc = path.join(root, 'canary-doctor.cjs');
  const realFileTarget = path.join(real1, '.claude', 'forge-bin', 'tool.cjs');
  fs.writeFileSync(canaryDoctorSrc, [
    '#!/usr/bin/env node',
    'var fs = require("fs");',
    'var content; try { content = fs.readFileSync(' + JSON.stringify(realFileTarget) + ', "utf8"); } catch (e) { content = "<missing>"; }',
    'fs.writeFileSync(' + JSON.stringify(snapshotFile) + ', content);',
    'var __args = process.argv.slice(2);',
    'if (__args.indexOf("--json") !== -1) { console.log(JSON.stringify({ ok: true, checks: { node_check: { ok: true, total: 50, failed: 0 }, tests: { ok: true, suites: 5, passed: 20, failed: 0 } } })); }',
    'process.exit(0);',
  ].join('\n'));
  const r = sync.runSyncAll(tpl, root, { projects: [real1], canaryDoctorSource: canaryDoctorSrc, batchId: 'b3', nowIso: '2026-01-01T00:00:00.000Z' });
  t('overall batch ok', r.ok === true);
  t('dedicated canary directory exists and is dot-prefixed', fs.existsSync(dedicated) && path.basename(dedicated) === '.forge-canary');
  const snapshotContent = fs.readFileSync(snapshotFile, 'utf8');
  t('AT the moment the dedicated canary validated, real1 still had its OLD content (proves canary-first ordering)', snapshotContent === 'OLD-REAL-CONTENT');
  t('by the time the whole batch finished, real1 DID get synced to the new content', fs.readFileSync(realFileTarget, 'utf8') === 'NEW-TEMPLATE-CONTENT');
}

// =====================================================================================
// 4) DEDICATED CANARY VALIDATION FAILS -> canary rolled back, batch ABORTS, real projects byte-untouched
//    (this is the core proof required by both the original spec and addendum F4)
// =====================================================================================
console.log('\n4) dedicated canary fails validation -> rolled back + batch aborted + real projects untouched');
{
  const tpl = freshDir('t4-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'NEW-CONTENT');
  const root = freshDir('t4-root');
  const real1 = makeProject(root, 'real1', 0); makeRealProjectMarker(real1);
  const real2 = makeProject(root, 'real2', 0); makeRealProjectMarker(real2);
  const doctorNeverRanMarker = path.join(root, 'real-doctor-ran.marker');
  writeDoctorStub(real1, 0, 'require("fs").writeFileSync(' + JSON.stringify(doctorNeverRanMarker) + ', "ran");');
  const beforeReal1 = snapshotTree(real1);
  const beforeReal2 = snapshotTree(real2);
  const failDoctorSrc = path.join(root, 'fail-doctor.cjs');
  fs.writeFileSync(failDoctorSrc, '#!/usr/bin/env node\nvar __a=process.argv.slice(2);if(__a.indexOf("--json")!==-1){console.log(JSON.stringify({ok:false,checks:{node_check:{ok:false,total:50,failed:1},tests:{ok:true,suites:5,passed:20,failed:0}}}));}\nprocess.exit(1);\n');
  const r = sync.runSyncAll(tpl, root, { projects: [real1, real2], canaryDoctorSource: failDoctorSrc, batchId: 'b4', nowIso: '2026-01-01T00:00:00.000Z' });
  t('batch reports ok:false', r.ok === false);
  t('batch reports aborted:true at stage dedicated-canary', r.aborted === true && r.stage === 'dedicated-canary');
  t('dedicated canary result itself is not ok (validation failed)', r.dedicatedCanary.ok === false);
  t('dedicated canary was rolled back (no leftover half-applied file)', r.dedicatedCanary.rolledBack === true);
  t('real1 is COMPLETELY byte-untouched', JSON.stringify(snapshotTree(real1)) === JSON.stringify(beforeReal1));
  t('real2 is COMPLETELY byte-untouched', JSON.stringify(snapshotTree(real2)) === JSON.stringify(beforeReal2));
  t('real1 doctor was NEVER invoked (batch aborted before reaching any real project)', !fs.existsSync(doctorNeverRanMarker));
  t('no forge-backups dir was ever created for real1 (never started)', !fs.existsSync(path.join(sync.claudeDirOf(real1), 'forge-backups')));
}

// =====================================================================================
// 5) CANARY PASSES -> staged rollout; a MID-BATCH validation failure rolls that project back and STOPS
//    the batch (later projects untouched) — original spec item + addendum F5
// =====================================================================================
console.log('\n5) canary passes; representative passes; a later project fails -> rolled back + batch stops');
{
  const tpl = freshDir('t5-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'NEW-CONTENT');
  const root = freshDir('t5-root');
  const rep = makeProject(root, 'rep', 0); makeRealProjectMarker(rep);
  const bad = makeProject(root, 'bad', 1); makeRealProjectMarker(bad); // will FAIL validation
  const later = makeProject(root, 'later', 0); makeRealProjectMarker(later);
  const laterDoctorRanMarker = path.join(root, 'later-doctor-ran.marker');
  writeDoctorStub(later, 0, 'require("fs").writeFileSync(' + JSON.stringify(laterDoctorRanMarker) + ', "ran");');
  const beforeLater = snapshotTree(later);
  const r = sync.runSyncAll(tpl, root, { projects: [rep, bad, later], canaryName: 'rep', batchId: 'b5', nowIso: '2026-01-01T00:00:00.000Z' });
  t('batch reports ok:false, aborted:true', r.ok === false && r.aborted === true);
  t('dedicated canary + representative both succeeded', r.dedicatedCanary.ok === true && r.representative.ok === true);
  t('representative got a real FORGE_VERSION.json stamp', fs.existsSync(sync.versionFilePath(rep)));
  const badResult = r.projects.find((pr) => pr.projectDir === bad);
  t('the failing project reports ok:false', badResult && badResult.ok === false);
  t('the failing project was rolled back (file reverted, no FORGE_VERSION stamp)', badResult.rolledBack === true && !fs.existsSync(sync.versionFilePath(bad)));
  t('the failing project has no forge-sync-receipt.json (sync never counted as complete)', !fs.existsSync(sync.receiptPath(bad)));
  t('the LATER project (after the failure) is COMPLETELY byte-untouched', JSON.stringify(snapshotTree(later)) === JSON.stringify(beforeLater));
  t('the LATER project doctor was NEVER invoked (batch stopped before reaching it)', !fs.existsSync(laterDoctorRanMarker));
}

// =====================================================================================
// 6) ROLLBACK RESTORES EXACT PREVIOUS BYTES (hash-compare) + FORGE_VERSION.json restored/removed correctly
//    — via the REAL CLI command (must really work)
// =====================================================================================
console.log('\n6) rollback CLI restores exact bytes + FORGE_VERSION.json correctly (both had-version and no-version cases)');
{
  // 6a) project HAD a FORGE_VERSION.json before this sync -> rollback must restore it byte-exact
  const tpl = freshDir('t6a-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'V2');
  const p = makeProject(freshDir('t6a-root'), 'proj', 0);
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'V1');
  const v1Hash = sync.sha256(path.join(p, '.claude', 'forge-bin', 'tool.cjs'));
  fakeReceiptMatchingCurrent(p, [['forge-bin/tool.cjs', v1Hash]]);
  const priorVersionContent = JSON.stringify({ forge_version: 'PRIOR-VERSION-MARKER' }, null, 2) + '\n';
  fs.writeFileSync(sync.versionFilePath(p), priorVersionContent, 'utf8');
  const r = sync.safeSyncProject(tpl, p, { batchId: 'b6a', nowIso: '2026-01-01T00:00:00.000Z' });
  t('sync succeeded and overwrote FORGE_VERSION.json', r.ok === true && fs.readFileSync(sync.versionFilePath(p), 'utf8') !== priorVersionContent);
  const cliResult = runCLI(['rollback', p, '--batch', 'b6a']);
  t('rollback CLI exits 0', cliResult.status === 0);
  t('file content restored to exact original bytes (V1)', fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'utf8') === 'V1');
  t('FORGE_VERSION.json restored to the EXACT prior content (byte-for-byte)', fs.readFileSync(sync.versionFilePath(p), 'utf8') === priorVersionContent);

  // 6b) project had NO FORGE_VERSION.json before this sync -> rollback must REMOVE it entirely
  const tpl2 = freshDir('t6b-tpl');
  fs.mkdirSync(path.join(tpl2, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl2, 'forge-bin', 'tool.cjs'), 'V2');
  const p2 = makeProject(freshDir('t6b-root'), 'proj', 0);
  const r2 = sync.safeSyncProject(tpl2, p2, { batchId: 'b6b', nowIso: '2026-01-01T00:00:00.000Z' });
  t('sync succeeded and created a FORGE_VERSION.json (project had none before)', r2.ok === true && fs.existsSync(sync.versionFilePath(p2)));
  const rb2 = sync.rollbackProject(p2, 'b6b', {});
  t('rollback ok', rb2.ok === true);
  t('FORGE_VERSION.json REMOVED entirely (it never existed pre-sync)', !fs.existsSync(sync.versionFilePath(p2)));
  t('the added file is gone too (rolled back to pre-sync non-existence)', !fs.existsSync(path.join(p2, '.claude', 'forge-bin', 'tool.cjs')));
}

// =====================================================================================
// 7) ROLLBACK-BATCH restores ALL projects of that batch
// =====================================================================================
console.log('\n7) rollback-batch restores every project synced under that batchId');
{
  const tpl = freshDir('t7-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'V2');
  const root = freshDir('t7-root');
  const p1 = makeProject(root, 'p1', 0); makeRealProjectMarker(p1);
  const p2 = makeProject(root, 'p2', 0); makeRealProjectMarker(p2);
  sync.safeSyncProject(tpl, p1, { batchId: 'b7', nowIso: '2026-01-01T00:00:00.000Z' });
  sync.safeSyncProject(tpl, p2, { batchId: 'b7', nowIso: '2026-01-01T00:00:00.000Z' });
  t('both projects synced (added file present)', fs.existsSync(path.join(p1, '.claude', 'forge-bin', 'tool.cjs')) && fs.existsSync(path.join(p2, '.claude', 'forge-bin', 'tool.cjs')));
  const cliResult = runCLI(['rollback-batch', 'b7', root]);
  t('rollback-batch CLI exits 0', cliResult.status === 0);
  t('p1 rolled back (added file removed)', !fs.existsSync(path.join(p1, '.claude', 'forge-bin', 'tool.cjs')));
  t('p2 rolled back (added file removed)', !fs.existsSync(path.join(p2, '.claude', 'forge-bin', 'tool.cjs')));
  t('rollback-batch stdout mentions both projects', /p1/.test(cliResult.stdout) && /p2/.test(cliResult.stdout));
}

// =====================================================================================
// 8) LOCAL OVERRIDE (unknown_drift, no receipt yet) is NOT silently overwritten; --force-overwrite DOES
//    overwrite it, but still backs it up first
// =====================================================================================
console.log('\n8) drift/local-override not silently overwritten; --force-overwrite overwrites + still backs up');
{
  const tpl = freshDir('t8-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'TEMPLATE-V2');
  const p = makeProject(freshDir('t8-root'), 'proj', 0);
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'HAND-EDITED-LOCAL-CONTENT');
  // no receipt at all yet -> conservative default classifies this as unknown_drift, not a plain update.
  // H2: unresolved drift with nothing safe to change is BLOCKED (ok:false), not a silent "up to date" noop.
  const noForce = sync.safeSyncProject(tpl, p, { batchId: 'b8a', nowIso: '2026-01-01T00:00:00.000Z' });
  t('no-force sync reports ok:false, blocked:true (H2 — was wrongly ok:true/noop before the fix)', noForce.ok === false && noForce.blocked === true && noForce.noop !== true);
  t('the file is classified as unknownDrift, not toChange', noForce.plan.unknownDrift.includes('forge-bin/tool.cjs') && noForce.plan.toChange.length === 0);
  t('the hand-edited file is completely UNTOUCHED', fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'utf8') === 'HAND-EDITED-LOCAL-CONTENT');
  t('no backup/receipt created for a pure noop', !fs.existsSync(sync.receiptPath(p)));

  const forced = sync.safeSyncProject(tpl, p, { batchId: 'b8b', forceOverwrite: true, nowIso: '2026-01-01T00:00:00.000Z' });
  t('--force-overwrite sync succeeds', forced.ok === true);
  t('file now has the template content (overwritten)', fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'utf8') === 'TEMPLATE-V2');
  t('the forced entry is tagged overrideClass:unknown_drift for reporting', forced.plan.toChange[0].overrideClass === 'unknown_drift');
  const backupFile = path.join(forced.backup.backupDir, 'forge-bin', 'tool.cjs');
  t('the hand-edited bytes were BACKED UP before being overwritten', fs.existsSync(backupFile) && fs.readFileSync(backupFile, 'utf8') === 'HAND-EDITED-LOCAL-CONTENT');
  t('unknownDriftSkipped is empty in the resulting receipt (nothing left skipped — it was forced through)', forced.receipt.overridesPreserved.unknownDriftSkipped.length === 0);
}

// =====================================================================================
// 9) RECEIPT has the extended fields (addendum E); failed validation gets NO FORGE_VERSION stamp
// =====================================================================================
console.log('\n9) receipt has extended fields; failed validation gets no FORGE_VERSION + no receipt');
{
  const tpl = freshDir('t9-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'CONTENT');
  const pOk = makeProject(freshDir('t9-ok-root'), 'proj', 0);
  const rOk = sync.safeSyncProject(tpl, pOk, { batchId: 'b9ok', nowIso: '2026-01-01T00:00:00.000Z', runId: 'forge-2026-07-14-hardening', centralBackupRoot: freshDir('t9-hub') });
  t('success case: ok:true', rOk.ok === true);
  const receiptOnDisk = JSON.parse(fs.readFileSync(sync.receiptPath(pOk), 'utf8'));
  const requiredFields = ['projectId', 'projectPath', 'batchId', 'runId', 'templateVersionFrom', 'templateVersionTo', 'backupRef', 'preSyncManifestHash', 'postSyncManifestHash', 'filesChanged', 'overridesPreserved', 'validation', 'rollbackStatus', 'syncedAt'];
  t('receipt contains every extended field required by addendum E', requiredFields.every((k) => Object.prototype.hasOwnProperty.call(receiptOnDisk, k)));
  t('receipt validation sub-object records tool/exitCode/ok/commands', receiptOnDisk.validation.tool && typeof receiptOnDisk.validation.exitCode === 'number' && receiptOnDisk.validation.ok === true && Array.isArray(receiptOnDisk.validation.commands));
  t('receipt runId matches what was passed in', receiptOnDisk.runId === 'forge-2026-07-14-hardening');
  t('receipt backupRef.central is populated (centralBackupRoot was given)', !!receiptOnDisk.backupRef.central);

  const pFail = makeProject(freshDir('t9-fail-root'), 'proj', 1); // doctor exits 1
  const rFail = sync.safeSyncProject(tpl, pFail, { batchId: 'b9fail', nowIso: '2026-01-01T00:00:00.000Z' });
  t('failure case: ok:false', rFail.ok === false);
  t('failed validation -> NO FORGE_VERSION.json stamp', !fs.existsSync(sync.versionFilePath(pFail)));
  t('failed validation -> NO forge-sync-receipt.json written at all', !fs.existsSync(sync.receiptPath(pFail)));
  t('failed validation -> the added file was rolled back to non-existence', !fs.existsSync(path.join(pFail, '.claude', 'forge-bin', 'tool.cjs')));
}

// =====================================================================================
// 10) USAGE ERRORS -> exit 2; a dir without .claude/ is refused (never resolves to a real path by default)
// =====================================================================================
console.log('\n10) usage errors exit 2; missing .claude/ is refused; missing project path is refused');
{
  t('no subcommand args for install -> exit 2', runCLI(['install']).status === 2);
  t('rollback with no projectDir -> exit 2', runCLI(['rollback']).status === 2);
  t('rollback-batch with no batchId -> exit 2', runCLI(['rollback-batch']).status === 2);
  t('unknown command -> exit 2', runCLI(['bogus-command']).status === 2);

  const noClaudeDir = freshDir('t10-no-claude'); // exists on disk, but has no .claude/ subdir
  const cliInstall = runCLI(['install', noClaudeDir]);
  t('install against a dir with no .claude/ is refused (non-zero, not a crash)', cliInstall.status !== 0 && cliInstall.status !== null);
  t('refusal message names the missing .claude/', /\.claude missing/.test(cliInstall.stdout + cliInstall.stderr));

  const missingPath = path.join(os.tmpdir(), 'definitely-does-not-exist-' + Date.now());
  const r = sync.safeSyncProject(freshDir('t10-tpl'), missingPath, { batchId: 'x' });
  t('safeSyncProject on a wholly missing project path refuses honestly (addendum F3)', r.ok === false && r.refused === true && /project path missing/.test(r.reason));
  const rb = sync.rollbackProject(missingPath, 'x', {});
  t('rollbackProject on a wholly missing project path refuses honestly, not a crash', rb.ok === false && /project path missing/.test(rb.reason));
}

// =====================================================================================
// 11) canary-init CLI command creates the dedicated canary and it is excluded from discovery
// =====================================================================================
console.log('\n11) canary-init creates the dedicated canary; findForgeProjects never counts it');
{
  const root = freshDir('t11-root');
  const real1 = makeProject(root, 'real1', 0); makeRealProjectMarker(real1);
  const r = runCLI(['canary-init', root]);
  t('canary-init CLI exits 0', r.status === 0);
  const dedicated = sync.dedicatedCanaryDir(root);
  t('dedicated canary dir was created', fs.existsSync(dedicated));
  t('dedicated canary carries a FORGE_CANARY_MARKER.json', fs.existsSync(path.join(dedicated, '.claude', 'FORGE_CANARY_MARKER.json')));
  // give the (dot-prefixed) canary the discovery marker too, to prove exclusion is structural, not incidental
  makeRealProjectMarker(dedicated);
  const discovered = sync.findForgeProjects(root);
  t('findForgeProjects finds real1 but NEVER the dedicated canary (dot-prefix exclusion)', discovered.includes(real1) && !discovered.some((d) => path.resolve(d) === path.resolve(dedicated)));
}

// =====================================================================================
// 12) CENTRAL BACKUP INDEPENDENCE (addendum C): a valid restore even when the project's OWN backup dir is
//     gone/damaged, by falling back to the central backup; corrupt/missing backup REFUSES (not fabricated)
// =====================================================================================
console.log('\n12) central backup independence + damaged-project restore + refuse-on-corrupt (addendum C, F7)');
{
  const tpl = freshDir('t12-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'g.cjs'), 'NEW-CENTRAL-TEST');
  const p = makeProject(freshDir('t12-root'), 'proj', 0);
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'g.cjs'), 'OLD-CENTRAL-TEST');
  const oldHash = sync.sha256(path.join(p, '.claude', 'forge-bin', 'g.cjs'));
  fakeReceiptMatchingCurrent(p, [['forge-bin/g.cjs', oldHash]]);
  const hub = freshDir('t12-hub');
  const r = sync.safeSyncProject(tpl, p, { batchId: 'b12', nowIso: '2026-01-01T00:00:00.000Z', centralBackupRoot: hub, runId: 'forge-2026-07-14-hardening' });
  t('sync ok', r.ok === true);
  t('a central backup manifest was written, distinct from the per-project one', fs.existsSync(path.join(r.backup.centralDir, 'manifest.json')) && r.backup.centralDir !== r.backup.backupDir);
  t('central manifest carries projectId/projectPath/runId/templateVersion', JSON.parse(fs.readFileSync(path.join(r.backup.centralDir, 'manifest.json'), 'utf8')).projectId === sync.projectId(p));

  // simulate the project folder being PARTIALLY DAMAGED: delete its own forge-backups AND forge-bin dir entirely
  fs.rmSync(path.join(sync.claudeDirOf(p), 'forge-backups'), { recursive: true, force: true });
  fs.rmSync(path.join(sync.claudeDirOf(p), 'forge-bin'), { recursive: true, force: true });
  t('project is now partially damaged (both dirs gone)', !fs.existsSync(path.join(sync.claudeDirOf(p), 'forge-backups')) && !fs.existsSync(path.join(sync.claudeDirOf(p), 'forge-bin')));
  const rb = sync.rollbackProject(p, 'b12', { centralBackupRoot: hub });
  t('rollback still succeeds via the CENTRAL backup despite project damage', rb.ok === true && rb.source === 'central');
  t('the restored file has the exact pre-sync bytes', fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'g.cjs'), 'utf8') === 'OLD-CENTRAL-TEST');

  // corrupt BOTH project-local and central backups -> rollback must REFUSE, never fabricate "restored"
  const tpl2 = freshDir('t12b-tpl');
  fs.mkdirSync(path.join(tpl2, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl2, 'forge-bin', 'h.cjs'), 'NEW2');
  const p2 = makeProject(freshDir('t12b-root'), 'proj2', 0);
  fs.mkdirSync(path.join(p2, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p2, '.claude', 'forge-bin', 'h.cjs'), 'OLD2');
  const oldHash2 = sync.sha256(path.join(p2, '.claude', 'forge-bin', 'h.cjs'));
  fakeReceiptMatchingCurrent(p2, [['forge-bin/h.cjs', oldHash2]]);
  const hub2 = freshDir('t12b-hub');
  const r2 = sync.safeSyncProject(tpl2, p2, { batchId: 'b12b', nowIso: '2026-01-01T00:00:00.000Z', centralBackupRoot: hub2 });
  t('second sync ok', r2.ok === true);
  fs.writeFileSync(path.join(r2.backup.backupDir, 'forge-bin', 'h.cjs'), 'TAMPERED-PROJECT');
  fs.writeFileSync(path.join(r2.backup.centralDir, 'forge-bin', 'h.cjs'), 'TAMPERED-CENTRAL');
  const rbCorrupt = sync.rollbackProject(p2, 'b12b', { centralBackupRoot: hub2 });
  t('rollback REFUSES when BOTH backups are corrupt (never fabricates "restored")', rbCorrupt.ok === false && /corrupt|no valid/.test(rbCorrupt.reason));
  t('the project file is left exactly as it was (no partial/garbage restore attempted)', fs.readFileSync(path.join(p2, '.claude', 'forge-bin', 'h.cjs'), 'utf8') === 'NEW2');
}

// =====================================================================================
// 13) 3-CLASS OVERRIDE CLASSIFICATION (addendum D): expected_override / unknown_drift / conflict
// =====================================================================================
console.log('\n13) 3-class override classification: expected_override, unknown_drift, conflict');
{
  const tpl = freshDir('t13-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'conflict.cjs'), 'TEMPLATE_V2');
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'drift.cjs'), 'TEMPLATE_UNCHANGED');
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'override.cjs'), 'TEMPLATE_NEW');
  const p = makeProject(freshDir('t13-root'), 'proj', 0);
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
  fs.mkdirSync(path.join(p, '.claude', 'config'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'conflict.cjs'), 'PROJECT_CHANGED');
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'drift.cjs'), 'PROJECT_CHANGED_2');
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'override.cjs'), 'PROJECT_OWNED_FOREVER');
  fs.writeFileSync(path.join(p, '.claude', 'config', 'forge-overrides.json'), JSON.stringify({ overrides: ['forge-bin/override.cjs'] }));
  const crypto = require('crypto');
  const h = (s) => crypto.createHash('sha256').update(s).digest('hex');
  sync.writeReceipt(p, { filesChanged: [
    { rel: 'forge-bin/conflict.cjs', oldHash: null, newHash: h('TEMPLATE_V1') }, // template WAS V1, now V2 (changed) + project changed -> conflict
    { rel: 'forge-bin/drift.cjs', oldHash: null, newHash: sync.sha256(path.join(tpl, 'forge-bin', 'drift.cjs')) }, // template unchanged, project changed -> drift
  ] });
  const plan = sync.buildPlan(tpl, p, {});
  t('conflict.cjs correctly classified as a CONFLICT (both sides changed)', plan.conflicts.includes('forge-bin/conflict.cjs'));
  t('drift.cjs correctly classified as UNKNOWN_DRIFT (only project changed)', plan.unknownDrift.includes('forge-bin/drift.cjs'));
  t('override.cjs correctly classified as EXPECTED_OVERRIDE (declared in allow-list)', plan.expectedOverrides.includes('forge-bin/override.cjs'));
  t('none of the 3 land in toChange without --force-overwrite', plan.toChange.length === 0);

  const forced = sync.buildPlan(tpl, p, { forceOverwrite: true });
  t('--force-overwrite forces conflict + unknown_drift through', forced.toChange.some((e) => e.rel === 'forge-bin/conflict.cjs') && forced.toChange.some((e) => e.rel === 'forge-bin/drift.cjs'));
  t('--force-overwrite NEVER touches an expected_override (allow-list is stronger than force)', forced.expectedOverrides.includes('forge-bin/override.cjs') && !forced.toChange.some((e) => e.rel === 'forge-bin/override.cjs'));

  // sync-all must STOP the whole batch when an unresolved conflict/drift is present (without --force-overwrite)
  const root2 = freshDir('t13-batch-root');
  makeRealProjectMarker(p);
  const runAll = sync.runSyncAll(tpl, root2, { projects: [p], canaryName: 'proj', batchId: 'b13', nowIso: '2026-01-01T00:00:00.000Z' });
  t('sync-all reports ok:false when the representative project has unresolved drift/conflict', runAll.ok === false);
}

// =====================================================================================
// 14) FAILURE CASE F1: write aborts halfway through a batch (simulated throw mid-copy)
// =====================================================================================
console.log('\n14) F1: write aborts halfway (simulated throw mid-copy) -> rolled back, batch stopped');
{
  const tpl = freshDir('t14-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'a.cjs'), 'A-NEW');
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'b.cjs'), 'B-NEW');
  const p = makeProject(freshDir('t14-root'), 'proj', 0);
  let copyCount = 0;
  const throwingCopy = (src, dst) => { copyCount++; if (copyCount === 2) throw new Error('SIMULATED write failure (test injection)'); return fs.copyFileSync(src, dst); };
  const r = sync.safeSyncProject(tpl, p, { batchId: 'b14', nowIso: '2026-01-01T00:00:00.000Z', copyFileImpl: throwingCopy });
  t('sync reports ok:false', r.ok === false);
  t('the injected error message is surfaced', /SIMULATED write failure/.test(r.applyError));
  t('the project was rolled back (no leftover files from the partial apply)', r.rolledBack === true);
  t('neither file exists post-rollback (both were isNew; the one that DID apply got rolled back)', !fs.existsSync(path.join(p, '.claude', 'forge-bin', 'a.cjs')) && !fs.existsSync(path.join(p, '.claude', 'forge-bin', 'b.cjs')));
  t('no FORGE_VERSION.json / receipt was ever written', !fs.existsSync(sync.versionFilePath(p)) && !fs.existsSync(sync.receiptPath(p)));
}

// =====================================================================================
// 15) FAILURE CASE F2: locked/unwritable file (real Windows EPERM via chmod 0o444)
// =====================================================================================
console.log('\n15) F2: locked/unwritable file (real EPERM) -> partial rollback, locked file left untouched');
{
  const tpl = freshDir('t15-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'a.cjs'), 'A-NEW');
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'locked.cjs'), 'LOCKED-NEW');
  const p = makeProject(freshDir('t15-root'), 'proj', 0);
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'a.cjs'), 'A-OLD');
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'locked.cjs'), 'LOCKED-OLD');
  fakeReceiptMatchingCurrent(p, [
    ['forge-bin/a.cjs', sync.sha256(path.join(p, '.claude', 'forge-bin', 'a.cjs'))],
    ['forge-bin/locked.cjs', sync.sha256(path.join(p, '.claude', 'forge-bin', 'locked.cjs'))],
  ]);
  const lockedPath = path.join(p, '.claude', 'forge-bin', 'locked.cjs');
  // real-OS probe: confirm chmod 0o444 actually reproduces EPERM on this host before relying on it
  let realLockWorks = false;
  const probe = freshDir('t15-probe');
  const probeFile = path.join(probe, 'x.txt');
  fs.writeFileSync(probeFile, 'orig'); fs.chmodSync(probeFile, 0o444);
  try { fs.writeFileSync(probeFile, 'new'); } catch { realLockWorks = true; }
  fs.chmodSync(probeFile, 0o666); fs.rmSync(probe, { recursive: true, force: true });

  let r;
  if (realLockWorks) {
    fs.chmodSync(lockedPath, 0o444);
    r = sync.safeSyncProject(tpl, p, { batchId: 'b15', nowIso: '2026-01-01T00:00:00.000Z' });
    fs.chmodSync(lockedPath, 0o666); // always release the lock before assertions/cleanup
  } else {
    // OS did not reproduce a real lock in this environment — inject the EPERM instead, per addendum F2
    const injectedCopy = (src, dst) => { if (dst === lockedPath) { const e = new Error('EPERM: operation not permitted (injected)'); e.code = 'EPERM'; throw e; } return fs.copyFileSync(src, dst); };
    r = sync.safeSyncProject(tpl, p, { batchId: 'b15', nowIso: '2026-01-01T00:00:00.000Z', copyFileImpl: injectedCopy });
  }
  console.log('     (F2 evidence source: ' + (realLockWorks ? 'REAL OS EPERM via chmod 0o444' : 'INJECTED — OS did not reproduce a real lock in this sandbox') + ')');
  t('sync reports ok:false', r.ok === false);
  t('EPERM is present in the reported error', /EPERM/.test(r.applyError || ''));
  t('rollback of the applied subset succeeded (rolledBack:true, no crash)', r.rolledBack === true);
  t('the free file (a.cjs) is restored to its OLD content', fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'a.cjs'), 'utf8') === 'A-OLD');
  t('the locked file itself was NEVER actually modified (still OLD content, correctly never "restored")', fs.readFileSync(lockedPath, 'utf8') === 'LOCKED-OLD');
}

// =====================================================================================
// 16) FAILURE CASE F3: project path missing entirely
// =====================================================================================
console.log('\n16) F3: project path missing entirely -> honest refusal (covered in depth in section 10)');
{
  const tpl = freshDir('t16-tpl');
  const missing = path.join(os.tmpdir(), 'forge-sync-f3-missing-' + process.pid);
  const r = sync.safeSyncProject(tpl, missing, { batchId: 'b16' });
  t('safeSyncProject refuses a missing project path (no crash)', r.ok === false && r.refused === true);
  const rb = sync.rollbackProject(missing, 'b16', {});
  t('rollbackProject refuses a missing project path (no crash)', rb.ok === false);
  const rbBatch = sync.rollbackBatch(os.tmpdir(), 'b16', { projects: [missing] });
  t('rollbackBatch silently skips a missing project (no backup dir found there, no crash)', Array.isArray(rbBatch) && rbBatch.length === 0);
}

// =====================================================================================
// 17) FAILURE CASE F4: canary validation fails -> covered in full in section 4 (cross-reference)
// =====================================================================================
console.log('\n17) F4: canary-fail-abort-rollback -> see section 4 (full proof already executed above)');
t('F4 is proven by section 4 (dedicatedCanary rolled back, batch aborted, real projects untouched)', true);

// =====================================================================================
// 18) FAILURE CASE F5: post-sync validation fails on a LATER project -> covered in full in section 5
// =====================================================================================
console.log('\n18) F5: later-project validation failure -> see section 5 (full proof already executed above)');
t('F5 is proven by section 5 (later project rolled back, batch stopped, still-later project untouched)', true);

// =====================================================================================
// 19) FAILURE CASE F6: unknown drift present -> not overwritten -> covered in section 8 + 13
// =====================================================================================
console.log('\n19) F6: unknown drift present -> not overwritten -> see sections 8 and 13');
t('F6 is proven by sections 8 (skip+force-overwrite) and 13 (3-class classification)', true);

// =====================================================================================
// 20) FAILURE CASE F7: backup missing or corrupt -> rollback REFUSES, never fakes "restored"
//     (also proven with central fallback in section 12; here: project-only, no central, backup DIR MISSING)
// =====================================================================================
console.log('\n20) F7: backup dir entirely MISSING (no central fallback configured) -> honest refusal');
{
  const tpl = freshDir('t20-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'x.cjs'), 'NEW');
  const p = makeProject(freshDir('t20-root'), 'proj', 0);
  const r = sync.safeSyncProject(tpl, p, { batchId: 'b20', nowIso: '2026-01-01T00:00:00.000Z' });
  t('sync ok', r.ok === true);
  fs.rmSync(path.join(sync.claudeDirOf(p), 'forge-backups'), { recursive: true, force: true }); // simulate the backup being wiped
  const rb = sync.rollbackProject(p, 'b20', {}); // no centralBackupRoot given -> nothing to fall back to
  t('rollback with NO backup and NO central fallback REFUSES (ok:false, honest reason)', rb.ok === false && /no valid|no backup batch/.test(rb.reason));
  t('the synced file is left exactly as it is (no fabricated partial restore)', fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'x.cjs'), 'utf8') === 'NEW');
}

// =====================================================================================
// 21) FAILURE CASE F8: rollback itself interrupted -> journal makes it resumable/idempotent
// =====================================================================================
console.log('\n21) F8: rollback interrupted mid-way -> resumable via journal -> end state byte-exact');
{
  const tpl = freshDir('t21-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'x1.cjs'), 'X1-NEW');
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'x2.cjs'), 'X2-NEW');
  const p = makeProject(freshDir('t21-root'), 'proj', 0);
  const preManifest = sync.fullFileManifest(tpl, p);
  const r = sync.safeSyncProject(tpl, p, { batchId: 'b21', nowIso: '2026-01-01T00:00:00.000Z' });
  t('sync ok, both files added', r.ok === true && r.plan.toChange.length === 2);
  const rb1 = sync.rollbackProject(p, 'b21', { __throwAfter: 1 });
  t('first rollback call reports interrupted:true (simulated)', rb1.ok === false && rb1.interrupted === true);
  const oneRestored = !fs.existsSync(path.join(p, '.claude', 'forge-bin', 'x1.cjs'));
  const oneStillPresent = fs.existsSync(path.join(p, '.claude', 'forge-bin', 'x2.cjs'));
  t('exactly one file was restored before the simulated interruption, the other is untouched so far', oneRestored && oneStillPresent);
  const rb2 = sync.rollbackProject(p, 'b21', {}); // resume, no throw this time
  t('second (resuming) rollback call succeeds', rb2.ok === true);
  const postManifest = sync.fullFileManifest(tpl, p);
  t('end state is BYTE-EXACT vs the original pre-sync manifest (resumable rollback proven)', JSON.stringify(preManifest) === JSON.stringify(postManifest));
  const journal = JSON.parse(fs.readFileSync(sync.journalPath(sync.backupDirFor(p, 'b21')), 'utf8'));
  t('journal ends in status:complete', journal.status === 'complete');
}

// =====================================================================================
// 22) FAILURE CASE F9: project with a deviating structure (no forge-bin dir at all; extra unrelated dirs)
// =====================================================================================
console.log('\n22) F9: deviating project structure (no forge-bin dir; extra unrelated dirs) -> handled, not crashed');
{
  const tpl = freshDir('t22-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'NEW');
  const p = makeProject(freshDir('t22-root'), 'proj', 0); // only .claude/ + doctor stub, NO forge-bin dir at all
  fs.mkdirSync(path.join(p, '.claude', 'some-totally-unrelated-dir'), { recursive: true }); // extra dir sync must ignore
  fs.writeFileSync(path.join(p, '.claude', 'some-totally-unrelated-dir', 'notes.txt'), 'do not touch me');
  fs.mkdirSync(path.join(p, 'src'), { recursive: true }); // extra dir OUTSIDE .claude entirely
  fs.writeFileSync(path.join(p, 'src', 'app.js'), 'console.log("real app code");');
  const r = sync.safeSyncProject(tpl, p, { batchId: 'b22', nowIso: '2026-01-01T00:00:00.000Z' });
  t('sync handles a project with no pre-existing forge-bin dir (creates it fresh)', r.ok === true);
  t('the new file was created correctly', fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'utf8') === 'NEW');
  t('the unrelated .claude subdir is completely untouched', fs.readFileSync(path.join(p, '.claude', 'some-totally-unrelated-dir', 'notes.txt'), 'utf8') === 'do not touch me');
  t('the unrelated top-level src/ dir is completely untouched', fs.readFileSync(path.join(p, 'src', 'app.js'), 'utf8') === 'console.log("real app code");');
}

// =====================================================================================
// 2026-07-14 FIX ROUND — sections 23-45 map 1:1 to the blockers/high/medium findings from the adversarial
// review + independent QA (mutation-tested) + 4-lens pre-mortem swarm. Every fixture stays os.tmpdir()-only.
// =====================================================================================

console.log('\n23) B1: cumulative drift baseline survives 3 consecutive template versions touching DIFFERENT files');
{
  const tpl = freshDir('t23-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'a.cjs'), 'A1');
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'b.cjs'), 'B1');
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'c.cjs'), 'C1');
  const p = makeProject(freshDir('t23-root'), 'proj', 0);
  const r1 = sync.safeSyncProject(tpl, p, { batchId: 'b23-1', nowIso: '2026-01-01T00:00:00.000Z' });
  t('sync 1 succeeds (all 3 files added)', r1.ok === true && r1.plan.toChange.length === 3);

  fs.writeFileSync(path.join(tpl, 'forge-bin', 'a.cjs'), 'A2'); // v2: only a.cjs changes
  const r2 = sync.safeSyncProject(tpl, p, { batchId: 'b23-2', nowIso: '2026-01-02T00:00:00.000Z' });
  t('sync 2 succeeds (only a.cjs changed)', r2.ok === true && r2.plan.toChange.length === 1 && r2.plan.toChange[0].rel === 'forge-bin/a.cjs');
  t('sync 2: b.cjs and c.cjs are NOT unknownDrift (never touched, still same)', r2.plan.unknownDrift.length === 0 && r2.plan.conflicts.length === 0);

  // v3: only b.cjs changes — the OLD bug erased b.cjs's baseline the moment a.cjs changed in sync 2
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'b.cjs'), 'B2');
  const r3 = sync.safeSyncProject(tpl, p, { batchId: 'b23-3', nowIso: '2026-01-03T00:00:00.000Z' });
  t('sync 3: b.cjs is classified as a SAFE update (toChange), NOT unknownDrift (kills B1)', r3.ok === true && r3.plan.toChange.some((e) => e.rel === 'forge-bin/b.cjs') && !r3.plan.unknownDrift.includes('forge-bin/b.cjs'));
  t('sync 3: c.cjs (never touched across all 3 versions) is still NOT drifted either', !r3.plan.unknownDrift.includes('forge-bin/c.cjs'));
  t('receipt.knownHashes carries a baseline for all 3 files after 3 cumulative syncs', ['forge-bin/a.cjs', 'forge-bin/b.cjs', 'forge-bin/c.cjs'].every((rel) => Object.prototype.hasOwnProperty.call(r3.receipt.knownHashes, rel)));
}

console.log('\n24) B2: forge-sync-receipt.json is backed up + restored on rollback (preflight sees no false drift)');
{
  const tpl = freshDir('t24-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'V2');
  const p = makeProject(freshDir('t24-root'), 'proj', 0);
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'V1');
  const v1Hash = sync.sha256(path.join(p, '.claude', 'forge-bin', 'tool.cjs'));
  fakeReceiptMatchingCurrent(p, [['forge-bin/tool.cjs', v1Hash]]);
  const receiptBeforeSync = fs.readFileSync(sync.receiptPath(p), 'utf8');
  const r = sync.safeSyncProject(tpl, p, { batchId: 'b24', nowIso: '2026-01-01T00:00:00.000Z' });
  t('sync succeeded', r.ok === true);
  t('receipt now describes THIS sync (different from the pre-sync one)', fs.readFileSync(sync.receiptPath(p), 'utf8') !== receiptBeforeSync);
  const rb = sync.rollbackProject(p, 'b24', {});
  t('rollback ok', rb.ok === true);
  t('rollback reports receiptAction:restored', rb.receiptAction === 'restored');
  t('the receipt on disk is restored to the EXACT pre-sync bytes', fs.readFileSync(sync.receiptPath(p), 'utf8') === receiptBeforeSync);
  const pf = sync.preflight(tpl, p);
  t('preflight() after rollback shows tool.cjs as safe toChange, NOT unknownDrift (kills B2 — QA reproduced this exact false positive)', pf.toChange.some((e) => e.rel === 'forge-bin/tool.cjs') && !pf.unknownDrift.includes('forge-bin/tool.cjs'));

  // no-prior-receipt case: rollback must REMOVE the receipt entirely (none existed pre-sync)
  const tpl2 = freshDir('t24b-tpl');
  fs.mkdirSync(path.join(tpl2, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl2, 'forge-bin', 'x.cjs'), 'NEW');
  const p2 = makeProject(freshDir('t24b-root'), 'proj', 0);
  const r2 = sync.safeSyncProject(tpl2, p2, { batchId: 'b24b', nowIso: '2026-01-01T00:00:00.000Z' });
  t('sync 2 ok, receipt now exists', r2.ok === true && fs.existsSync(sync.receiptPath(p2)));
  const rb2 = sync.rollbackProject(p2, 'b24b', {});
  t('rollback 2 ok, receiptAction is removed', rb2.ok === true && rb2.receiptAction === 'removed');
  t('receipt file is gone (none existed before this sync)', !fs.existsSync(sync.receiptPath(p2)));
}

console.log('\n25) B3: an EXISTING-BUT-UNREADABLE system file refuses the whole sync (never treated as "new")');
{
  const tpl = freshDir('t25-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'NEW-CONTENT');
  const p = makeProject(freshDir('t25-root'), 'proj', 0);
  // Portably simulate "exists but unreadable" (no chmod/OS-specific flakiness): put a DIRECTORY where the
  // system file is expected — fs.readFileSync on a directory reliably throws EISDIR on every OS.
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), { recursive: true });
  const pf = sync.preflight(tpl, p);
  t('preflight classifies it as unreadable, not missing/new', pf.unreadable.some((u) => u.rel === 'forge-bin/tool.cjs'));
  t('it never lands in toChange (never silently treated as "new")', !pf.toChange.some((e) => e.rel === 'forge-bin/tool.cjs'));
  const r = sync.safeSyncProject(tpl, p, { batchId: 'b25', nowIso: '2026-01-01T00:00:00.000Z' });
  t('the WHOLE project sync REFUSES (ok:false, refused:true)', r.ok === false && r.refused === true);
  t('refusal reason names the unreadable file', /tool\.cjs/.test(r.reason) && /unreadable/.test(r.reason));
  t('no backup was ever taken (refused before backup)', !fs.existsSync(path.join(sync.claudeDirOf(p), 'forge-backups')));
  t('the directory is still there, completely untouched (never overwritten/deleted)', fs.existsSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs')) && fs.lstatSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs')).isDirectory());
}

console.log('\n26) B4: rollback-batch reaches the CENTRAL backup when local is wiped; a failing project is not counted as rolled back');
{
  const tpl = freshDir('t26-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'NEW');
  const root = freshDir('t26-root');
  const hub = freshDir('t26-hub');
  const pA = makeProject(root, 'pA', 0); makeRealProjectMarker(pA);
  const pB = makeProject(root, 'pB', 0); makeRealProjectMarker(pB);
  // pre-existing content (not "new") so a REAL backup copy is taken for both -> there is something to tamper with
  for (const p of [pA, pB]) {
    fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
    fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'OLD');
    fakeReceiptMatchingCurrent(p, [['forge-bin/tool.cjs', sync.sha256(path.join(p, '.claude', 'forge-bin', 'tool.cjs'))]]);
  }
  sync.safeSyncProject(tpl, pA, { batchId: 'b26', nowIso: '2026-01-01T00:00:00.000Z', centralBackupRoot: hub });
  sync.safeSyncProject(tpl, pB, { batchId: 'b26', nowIso: '2026-01-01T00:00:00.000Z', centralBackupRoot: hub });
  t('both projects synced', fs.readFileSync(path.join(pA, '.claude', 'forge-bin', 'tool.cjs'), 'utf8') === 'NEW' && fs.readFileSync(path.join(pB, '.claude', 'forge-bin', 'tool.cjs'), 'utf8') === 'NEW');
  fs.rmSync(path.join(sync.claudeDirOf(pA), 'forge-backups'), { recursive: true, force: true }); // pA "damaged": local wiped, central intact
  fs.writeFileSync(path.join(sync.backupDirFor(pB, 'b26'), 'forge-bin', 'tool.cjs'), 'TAMPERED'); // pB: BOTH backups corrupt
  fs.writeFileSync(path.join(sync.centralBackupDir(hub, 'b26', sync.projectId(pB)), 'forge-bin', 'tool.cjs'), 'TAMPERED-CENTRAL');

  const results = sync.rollbackBatch(root, 'b26', { centralBackupRoot: hub });
  const rA = results.find((r) => r.projectDir === pA);
  const rB = results.find((r) => r.projectDir === pB);
  t('pA (local wiped) was STILL attempted and restored via the CENTRAL backup', !!rA && rA.ok === true && rA.source === 'central');
  t('pA file content is byte-exact restored to OLD', fs.readFileSync(path.join(pA, '.claude', 'forge-bin', 'tool.cjs'), 'utf8') === 'OLD');
  t('pB (both backups corrupt) correctly reports ok:false — NOT counted as a success', !!rB && rB.ok === false);
  t('exactly 1 of 2 results is ok:true (pA only)', results.filter((r) => r.ok).length === 1 && results.length === 2);
}

console.log('\n26b) B4 (CLI): rollback-batch prints "X of Y" honestly and exits 1 on partial failure');
{
  const tpl = freshDir('t26b-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'NEW');
  const root = freshDir('t26b-root');
  const pOk = makeProject(root, 'pOk', 0); makeRealProjectMarker(pOk);
  const pBad = makeProject(root, 'pBad', 0); makeRealProjectMarker(pBad);
  for (const p of [pOk, pBad]) {
    fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
    fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'OLD');
    fakeReceiptMatchingCurrent(p, [['forge-bin/tool.cjs', sync.sha256(path.join(p, '.claude', 'forge-bin', 'tool.cjs'))]]);
  }
  sync.safeSyncProject(tpl, pOk, { batchId: 'bcli', nowIso: '2026-01-01T00:00:00.000Z' });
  sync.safeSyncProject(tpl, pBad, { batchId: 'bcli', nowIso: '2026-01-01T00:00:00.000Z' });
  fs.writeFileSync(path.join(sync.backupDirFor(pBad, 'bcli'), 'forge-bin', 'tool.cjs'), 'TAMPERED'); // corrupt, not absent — still "part of the batch"
  const cliResult = runCLI(['rollback-batch', 'bcli', root]);
  t('CLI exits 1 (not everything succeeded)', cliResult.status === 1);
  t('CLI summary says "1 of 2 project(s) rolled back" (never conflates a failure into the count)', /1 of 2 project\(s\) rolled back/.test(cliResult.stdout));
}

console.log('\n27) B5: a default central backup hub is used automatically when --central-backup-root is not given');
{
  const tpl = freshDir('t27-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'NEW');
  const projectsRoot = freshDir('t27-root');
  const p = makeProject(projectsRoot, 'proj', 0); makeRealProjectMarker(p);
  const cliResult = runCLIWithTemplate(['install', p, '--batch-id', 'b27'], tpl);
  t('install CLI succeeds', cliResult.status === 0);
  const expectedHub = path.join(path.dirname(path.resolve(p)), '.forge-backup-hub');
  t('a default central backup hub was created OUTSIDE the project, next to it (<parent>/.forge-backup-hub)', fs.existsSync(expectedHub));
  const centralManifestPath = path.join(expectedHub, '.claude', 'forge-backups', 'b27', sync.projectId(p), 'manifest.json');
  t('the default hub actually contains this batch\'s manifest', fs.existsSync(centralManifestPath));

  const p2 = makeProject(projectsRoot, 'proj2', 0);
  const cliResult2 = runCLIWithTemplate(['install', p2, '--batch-id', 'b27b', '--no-central-backup'], tpl);
  t('install with --no-central-backup succeeds', cliResult2.status === 0);
  t('--no-central-backup did not create a central hub entry for THIS batch', !fs.existsSync(path.join(expectedHub, '.claude', 'forge-backups', 'b27b')));
}

console.log('\n28) B6: sync-all / list / canary-init / rollback-batch refuse a missing root (no ~/Documents default)');
{
  const savedEnv = process.env.FORGE_SYNC_ROOT;
  delete process.env.FORGE_SYNC_ROOT;
  t('list with no root -> exit 2, refuses (never defaults to ~/Documents)', runCLI(['list']).status === 2);
  t('canary-init with no root -> exit 2', runCLI(['canary-init']).status === 2);
  t('sync-all with no root -> exit 2', runCLI(['sync-all']).status === 2);
  t('rollback-batch with a batchId but no root -> exit 2 (previously silently treated the batchId string AS the root)', runCLI(['rollback-batch', 'some-batch']).status === 2);
  if (savedEnv !== undefined) process.env.FORGE_SYNC_ROOT = savedEnv;

  const root = freshDir('t28-root');
  const rListEnv = runCLI(['list'], { env: Object.assign({}, process.env, { FORGE_SYNC_ROOT: root }) });
  t('list honors FORGE_SYNC_ROOT when no positional root is given', rListEnv.status === 0 && rListEnv.stdout.includes(root));
}

console.log('\n29) B7: rollback refuses to clobber content that diverged since this sync wrote it (--force-rollback-newer overrides)');
{
  const tpl = freshDir('t29-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'V2');
  const p = makeProject(freshDir('t29-root'), 'proj', 0);
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'V1');
  const v1Hash = sync.sha256(path.join(p, '.claude', 'forge-bin', 'tool.cjs'));
  fakeReceiptMatchingCurrent(p, [['forge-bin/tool.cjs', v1Hash]]);
  const r = sync.safeSyncProject(tpl, p, { batchId: 'b29', nowIso: '2026-01-01T00:00:00.000Z' });
  t('sync ok', r.ok === true);
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'HAND-EDITED-AFTER-SYNC'); // changed AFTER the sync wrote V2
  const rb = sync.rollbackProject(p, 'b29', {});
  t('rollback REFUSES (content diverged since this sync wrote it)', rb.ok === false && Array.isArray(rb.diverged) && rb.diverged.some((d) => d.rel === 'forge-bin/tool.cjs'));
  t('the diverged content is left completely untouched', fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'utf8') === 'HAND-EDITED-AFTER-SYNC');
  const rbForced = sync.rollbackProject(p, 'b29', { forceRollbackNewer: true });
  t('--force-rollback-newer overrides the refusal and restores V1', rbForced.ok === true && fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'utf8') === 'V1');
}

console.log('\n29b) B7: rollback refuses when a NEWER batch already touched the same file for this project');
{
  const tpl = freshDir('t29b-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'V2');
  const p = makeProject(freshDir('t29b-root'), 'proj', 0);
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'V1');
  const v1Hash = sync.sha256(path.join(p, '.claude', 'forge-bin', 'tool.cjs'));
  fakeReceiptMatchingCurrent(p, [['forge-bin/tool.cjs', v1Hash]]);
  sync.safeSyncProject(tpl, p, { batchId: 'batch-old', nowIso: '2026-01-01T00:00:00.000Z' }); // V1 -> V2
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'V3');
  sync.safeSyncProject(tpl, p, { batchId: 'batch-new', nowIso: '2026-01-02T00:00:00.000Z' }); // V2 -> V3 (NEWER batch)
  t('project is now at V3', fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'utf8') === 'V3');
  const rb = sync.rollbackProject(p, 'batch-old', {});
  t('rolling back the OLDER batch REFUSES (a newer batch already touched the same file)', rb.ok === false && Array.isArray(rb.newerOverlaps) && rb.newerOverlaps.length > 0);
  t('the project is left at V3, untouched', fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'utf8') === 'V3');
  const rbNewest = sync.rollbackProject(p, 'batch-new', {});
  t('rolling back the NEWEST batch first succeeds (back to V2)', rbNewest.ok === true && fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'utf8') === 'V2');
}

console.log('\n29c) test pin: B7 divergence guard on an ADDED file (oldHash:null) — code was correct but UNTESTED');
{
  // an ADDED file (didn't exist pre-sync, oldHash:null) that is HAND-EDITED after the sync wrote it must
  // trip the SAME B7 "diverged since this sync wrote it" refusal as a pre-existing (oldHash non-null) file —
  // computeDivergence keys off newHash/current-content, not oldHash, but this exact combination (isNew +
  // post-sync hand-edit) had no dedicated test before this pass.
  const tpl = freshDir('t29c-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'new.cjs'), 'TEMPLATE-CONTENT');
  const p = makeProject(freshDir('t29c-root'), 'proj', 0);
  const r = sync.safeSyncProject(tpl, p, { batchId: 'b29c', nowIso: '2026-01-01T00:00:00.000Z' });
  t('sanity: new.cjs was ADDED by this sync (isNew, oldHash:null)', r.ok === true && r.plan.toChange[0].isNew === true && r.plan.toChange[0].oldHash === null);
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'new.cjs'), 'HAND-EDITED-AFTER-SYNC'); // changed AFTER the sync wrote it
  const rb = sync.rollbackProject(p, 'b29c', {});
  t('B7 PIN: rollback REFUSES on an ADDED file that diverged since this sync wrote it (same guard as a pre-existing file)', rb.ok === false && Array.isArray(rb.diverged) && rb.diverged.some((d) => d.rel === 'forge-bin/new.cjs'));
  t('B7 PIN: the hand-edited content is left completely untouched', fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'new.cjs'), 'utf8') === 'HAND-EDITED-AFTER-SYNC');
  const rbForced = sync.rollbackProject(p, 'b29c', { forceRollbackNewer: true });
  t('B7 PIN: --force-rollback-newer overrides the refusal and correctly DELETES the added file (rolled back to pre-sync non-existence)', rbForced.ok === true && !fs.existsSync(path.join(p, '.claude', 'forge-bin', 'new.cjs')));
}

console.log('\n30) H1: rollback never claims a file was "restored" without a real post-restore verification');
{
  const tpl = freshDir('t30-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'a.cjs'), 'A-NEW');
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'locked.cjs'), 'LOCKED-NEW');
  const p = makeProject(freshDir('t30-root'), 'proj', 0);
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'a.cjs'), 'A-OLD');
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'locked.cjs'), 'LOCKED-OLD');
  fakeReceiptMatchingCurrent(p, [
    ['forge-bin/a.cjs', sync.sha256(path.join(p, '.claude', 'forge-bin', 'a.cjs'))],
    ['forge-bin/locked.cjs', sync.sha256(path.join(p, '.claude', 'forge-bin', 'locked.cjs'))],
  ]);
  const r = sync.safeSyncProject(tpl, p, { batchId: 'b30', nowIso: '2026-01-01T00:00:00.000Z' });
  t('sync ok, both files updated', r.ok === true && r.plan.toChange.length === 2);
  const lockedPath = path.join(p, '.claude', 'forge-bin', 'locked.cjs');
  let realLockWorks = false;
  const probe = freshDir('t30-probe');
  const probeFile = path.join(probe, 'x.txt');
  fs.writeFileSync(probeFile, 'orig'); fs.chmodSync(probeFile, 0o444);
  try { fs.writeFileSync(probeFile, 'new'); } catch { realLockWorks = true; }
  fs.chmodSync(probeFile, 0o666); fs.rmSync(probe, { recursive: true, force: true });

  if (realLockWorks) {
    fs.chmodSync(lockedPath, 0o444);
    const rb = sync.rollbackProject(p, 'b30', {});
    fs.chmodSync(lockedPath, 0o666); // always release before assertions/cleanup
    console.log('     (H1 evidence source: REAL OS EPERM via chmod 0o444)');
    t('rollback reports ok:false, partial:true (never a bare "ok:true")', rb.ok === false && rb.partial === true);
    t('the free file (a.cjs) IS in the restored list', rb.restored.includes('forge-bin/a.cjs'));
    t('the locked file is NOT in the restored list (H1 — never claim a file was restored when it was not)', !rb.restored.includes('forge-bin/locked.cjs'));
    t('a.cjs really is back to its OLD content', fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'a.cjs'), 'utf8') === 'A-OLD');
    t('reason names PARTIAL / MANUAL RECOVERY', /PARTIAL/.test(rb.reason) && /MANUAL RECOVERY/.test(rb.reason));
  } else {
    console.log('     (H1 evidence source: OS did not reproduce a real lock in this sandbox — reporting the gap honestly, no fabricated pass)');
    t('(H1 EPERM half skipped honestly)', true);
  }
}

console.log('\n31) H2: install CLI exits 1 and prints BLOCKED when drift blocks (was silently exit 0)');
{
  const tpl = freshDir('t31-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'TEMPLATE-V2');
  const p = makeProject(freshDir('t31-root'), 'proj', 0);
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'HAND-EDITED');
  const cliResult = runCLIWithTemplate(['install', p], tpl);
  t('install CLI exits 1 when blocked by unresolved drift (was wrongly exit 0)', cliResult.status === 1);
  t('stderr says BLOCKED', /BLOCKED/.test(cliResult.stderr));
  t('the hand-edited file is untouched', fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'utf8') === 'HAND-EDITED');
}

console.log('\n32) H3: decideValidationOutcome — already-red vs genuine regression vs node_check hard gate');
{
  const clean = { ok: true, summary: { ok: true, node_check: { ok: true }, tests: { ok: true } } };
  const redBefore = { ok: false, summary: { ok: false, node_check: { ok: true }, tests: { ok: false } } };
  const redAfterSameReason = { ok: false, summary: { ok: false, node_check: { ok: true }, tests: { ok: false } } };
  const regressed = { ok: false, summary: { ok: false, node_check: { ok: true }, tests: { ok: false } } };
  const nodeCheckBroken = { ok: false, summary: { ok: false, node_check: { ok: false }, tests: { ok: true } } };

  const o1 = sync.decideValidationOutcome(clean, clean, {});
  t('clean pre + clean post -> ok:true', o1.ok === true);
  const o2 = sync.decideValidationOutcome(redBefore, redAfterSameReason, {});
  t('already-red pre (tests) + SAME red post + node_check clean -> ok:true, alreadyRedSkipped', o2.ok === true && o2.alreadyRedSkipped === true);
  const o3 = sync.decideValidationOutcome(clean, regressed, {});
  t('clean pre + red post (tests regressed from green) -> ok:false (genuine regression)', o3.ok === false);
  const o4 = sync.decideValidationOutcome(redBefore, nodeCheckBroken, {});
  t('already-red pre BUT node_check itself is broken post -> ok:false (unconditional hard gate, never bypassed by already-red)', o4.ok === false);
  const o5 = sync.decideValidationOutcome(null, { ok: false, noEvidence: true, reason: 'no evidence' }, {});
  t('no-evidence post -> ok:false regardless of pre state', o5.ok === false);
  const o6 = sync.decideValidationOutcome(null, { ok: true, degraded: true }, {});
  t('degraded pass WITHOUT --allow-degraded -> ok:false (H4)', o6.ok === false);
  const o7 = sync.decideValidationOutcome(null, { ok: true, degraded: true }, { allowDegraded: true });
  t('degraded pass WITH --allow-degraded -> ok:true, degradedAllowed', o7.ok === true && o7.degradedAllowed === true);
  const o8 = sync.decideValidationOutcome(null, { ok: false, degraded: true }, { allowDegraded: true });
  t('degraded FAILURE (real syntax error) is NEVER let through even with --allow-degraded', o8.ok === false);
  const o9 = sync.decideValidationOutcome(null, { timedOut: true, signal: 'SIGTERM' }, {});
  t('a doctor timeout is ok:false, timedOut:true (BLOCKED, not a confirmed failure)', o9.ok === false && o9.timedOut === true);
}

console.log('\n33) H4 / finding#6: the REAL forge-doctor.cjs is actually invoked (not a stub) + a 0-evidence pass is REJECTED');
{
  const realDoctorSrc = path.join(__dirname, 'forge-doctor.cjs'); // this repo's REAL, current doctor (read-only copy)
  const realStoreSrc = path.join(__dirname, 'forge-store.cjs'); // forge-doctor.cjs's one sibling dependency
  if (fs.existsSync(realDoctorSrc) && fs.existsSync(realStoreSrc)) {
    const p = makeProject(freshDir('t33-realdoctor-root'), 'proj', null); // no fake stub
    fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
    fs.copyFileSync(realDoctorSrc, path.join(p, '.claude', 'forge-bin', 'forge-doctor.cjs'));
    fs.copyFileSync(realStoreSrc, path.join(p, '.claude', 'forge-bin', 'forge-store.cjs'));
    const result = sync.runValidation(p, { toChange: [] });
    t('the REAL forge-doctor.cjs is actually invoked (tool:"forge-doctor", not the node-check-fallback)', result.tool === 'forge-doctor');
    t('its JSON output is parsed into a structured summary (real node_check + tests sub-objects, not a bare exit code)',
      result.summary && result.summary.node_check && typeof result.summary.node_check.total === 'number' &&
      result.summary.tests && typeof result.summary.tests.suites === 'number');
  } else {
    console.log('  (skipped: forge-doctor.cjs not found next to the test file in this environment)');
    t('(finding#6 real-doctor half skipped honestly — file not present)', true);
  }

  // the CORE H4 proof: an exit-0 doctor reporting 0 checks/0 suites must be REJECTED, not trusted
  const p2 = makeProject(freshDir('t33-zeroevidence-root'), 'proj', null);
  const zdir = path.join(p2, '.claude', 'forge-bin');
  fs.mkdirSync(zdir, { recursive: true });
  fs.writeFileSync(path.join(zdir, 'forge-doctor.cjs'),
    '#!/usr/bin/env node\nvar a=process.argv.slice(2);if(a.indexOf("--json")!==-1){console.log(JSON.stringify({ok:true,checks:{node_check:{ok:true,total:0,failed:0},tests:{ok:true,suites:0,passed:0,failed:0}}}));}\nprocess.exit(0);\n', 'utf8');
  const result2 = sync.runValidation(p2, { toChange: [] });
  t('a 0-evidence doctor PASS (exit 0, 0 checks/0 suites) is REJECTED, not trusted', result2.ok === false && result2.noEvidence === true);
}

console.log('\n34) M1: a value-taking flag followed by another flag (or nothing) refuses instead of eating it');
{
  const p = freshDir('t34-root');
  t('"install <p> --run-id --dry-run" exits 2 (refuses; does NOT silently swallow --dry-run as runId\'s value)', runCLI(['install', p, '--run-id', '--dry-run']).status === 2);
  t('a value-flag with nothing after it exits 2', runCLI(['install', p, '--batch-id']).status === 2);
  t('another value-flag case exits 2 too (generalizes beyond just --run-id)', runCLI(['install', p, '--central-backup-root', '--force-overwrite']).status === 2);
}

console.log('\n35) M2: a concurrent forge-sync run refuses while a fresh lock is held; dry-run never takes a lock');
{
  const tpl = freshDir('t35-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'NEW');
  const p = makeProject(freshDir('t35-root'), 'proj', 0);
  const claudeDir = sync.claudeDirOf(p);
  const lockPath = sync.lockPathFor(claudeDir);
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, ts: new Date().toISOString() }));
  const r = runCLIWithTemplate(['install', p], tpl);
  t('a concurrent install refuses while the lock is fresh (exit 1, not a crash)', r.status === 1);
  t('refusal message mentions "in progress"', /in progress/.test(r.stderr));
  t('the project was NOT touched while locked', !fs.existsSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs')));
  fs.rmSync(lockPath, { force: true });
  const r2 = runCLIWithTemplate(['install', p], tpl);
  t('after the lock is released, install succeeds normally', r2.status === 0);
  t('the lock file is cleaned up after a successful run (no leftover lock)', !fs.existsSync(lockPath));

  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, ts: new Date().toISOString() }));
  const rDry = runCLIWithTemplate(['install', p, '--dry-run'], tpl);
  t('--dry-run succeeds even while a lock is held (dry-run never locks)', rDry.status === 0);
  fs.rmSync(lockPath, { force: true });

  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, ts: '2020-01-01T00:00:00.000Z' }));
  const staleAcquire = sync.acquireLock(claudeDir, { staleMs: 1000 });
  t('a STALE lock (older than staleMs) is reclaimed rather than refused', staleAcquire.ok === true && staleAcquire.reclaimedStale === true);
  sync.releaseLock(staleAcquire);
}

console.log('\n36) M3: reusing a --batch-id for the SAME project refuses (unless --resume-batch)');
{
  const tpl = freshDir('t36-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'a.cjs'), 'A1');
  const p = makeProject(freshDir('t36-root'), 'proj', 0);
  const r1 = sync.safeSyncProject(tpl, p, { batchId: 'reused-batch', nowIso: '2026-01-01T00:00:00.000Z' });
  t('first sync with batchId "reused-batch" succeeds', r1.ok === true);
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'b.cjs'), 'B1');
  const r2 = sync.safeSyncProject(tpl, p, { batchId: 'reused-batch', nowIso: '2026-01-02T00:00:00.000Z' });
  t('reusing the SAME batchId for the SAME project refuses (would silently clobber the first manifest)', r2.ok === false && r2.refused === true);
  t('refusal names --resume-batch as the escape hatch', /--resume-batch/.test(r2.reason));
  t('b.cjs was NOT written (refused before any write)', !fs.existsSync(path.join(p, '.claude', 'forge-bin', 'b.cjs')));
  const r3 = sync.safeSyncProject(tpl, p, { batchId: 'reused-batch', nowIso: '2026-01-03T00:00:00.000Z', resumeBatch: true });
  t('--resume-batch (opts.resumeBatch) explicitly allows reusing the batch id', r3.ok === true);
  t('b.cjs now written', fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'b.cjs'), 'utf8') === 'B1');
}

console.log('\n37) M5: the dedicated canary is WIPED (not accumulated) on every canary-init');
{
  const root = freshDir('t37-root');
  const dedicated = sync.dedicatedCanaryDir(root);
  sync.canaryInit(freshDir('t37-tpl'), root, {});
  fs.writeFileSync(sync.versionFilePath(dedicated), JSON.stringify({ forge_version: 'stale' }));
  fs.writeFileSync(sync.receiptPath(dedicated), JSON.stringify({ stale: true }));
  fs.mkdirSync(path.join(dedicated, '.claude', 'forge-runs', 'old-run'), { recursive: true });
  t('accumulated canary state exists before re-init', fs.existsSync(sync.versionFilePath(dedicated)) && fs.existsSync(sync.receiptPath(dedicated)));
  sync.canaryInit(freshDir('t37-tpl2'), root, {});
  t('FORGE_VERSION.json is gone after re-init (wiped, not accumulated)', !fs.existsSync(sync.versionFilePath(dedicated)));
  t('the stale receipt is gone after re-init', !fs.existsSync(sync.receiptPath(dedicated)));
  t('the stale forge-runs dir is gone after re-init', !fs.existsSync(path.join(dedicated, '.claude', 'forge-runs', 'old-run')));
  t('a fresh FORGE_CANARY_MARKER.json exists', fs.existsSync(path.join(dedicated, '.claude', 'FORGE_CANARY_MARKER.json')));
}

console.log('\n38) M6: a symlinked/junctioned PARENT directory (not just the leaf) is caught by the containment guard');
{
  const tpl = freshDir('t38-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'NEW');
  const p = makeProject(freshDir('t38-root'), 'proj', 0);
  const outside = freshDir('t38-outside');
  const junctionTarget = path.join(p, '.claude', 'forge-bin');
  fs.rmSync(junctionTarget, { recursive: true, force: true }); // makeProject's doctor stub already created this dir; clear it first
  let junctionOk = false;
  try { fs.symlinkSync(outside, junctionTarget, 'junction'); junctionOk = true; }
  catch (e) { console.log('     (M6 evidence: could not create a junction in this environment — ' + e.message + ' — skipping honestly)'); }
  if (junctionOk) {
    const pf = sync.preflight(tpl, p);
    t('the file behind the junctioned forge-bin/ is SKIPPED (containment guard), never silently written through it', pf.skipped.some((s) => s.rel === 'forge-bin/tool.cjs'));
    t('nothing was written into the OUTSIDE (junction target) directory', !fs.existsSync(path.join(outside, 'tool.cjs')));
    const r = sync.safeSyncProject(tpl, p, { batchId: 'b38', nowIso: '2026-01-01T00:00:00.000Z' });
    t('sync reports noop (nothing safe to change; the only file is skipped)', r.noop === true || r.plan.toChange.length === 0);
  } else {
    t('(M6 skipped honestly — junction creation unavailable in this sandbox)', true);
  }
}

console.log('\n39) M7: --unsafe still takes a real, restorable backup (never "no undo")');
{
  const tpl = freshDir('t39-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'V2');
  const p = makeProject(freshDir('t39-root'), 'proj', 0);
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'V1');
  const r = sync.rawInstall(tpl, p, { batchId: 'b39', nowIso: '2026-01-01T00:00:00.000Z' });
  t('--unsafe (rawInstall) reports ok:true and a backup object', r.ok === true && !!r.backup);
  t('the file was overwritten to V2', fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'utf8') === 'V2');
  t('a REAL backup file with the OLD bytes exists on disk', fs.existsSync(path.join(r.backup.backupDir, 'forge-bin', 'tool.cjs')) && fs.readFileSync(path.join(r.backup.backupDir, 'forge-bin', 'tool.cjs'), 'utf8') === 'V1');
  const rb = sync.rollbackProject(p, 'b39', {});
  t('the --unsafe sync is fully restorable via the STANDARD rollback command', rb.ok === true);
  t('rollback restores the exact pre-unsafe-install bytes (V1)', fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'utf8') === 'V1');

  const p2 = makeProject(freshDir('t39b-root'), 'proj2', 0);
  const before = snapshotTree(p2);
  sync.rawInstall(tpl, p2, { dryRun: true });
  t('--unsafe --dry-run still writes NOTHING', JSON.stringify(snapshotTree(p2)) === JSON.stringify(before));
}

console.log('\n40) M8: abort messaging branches on r.ok/blocked (never says a hedged "(if applicable)")');
{
  const tpl = freshDir('t40-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'TEMPLATE-V2');
  const root = freshDir('t40-root');
  const p = makeProject(root, 'proj', 0); makeRealProjectMarker(p);
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'HAND-EDITED'); // fully drifted -> blocked, ok:false
  const originalError = console.error;
  let captured = '';
  console.error = (...args) => { captured += args.join(' ') + '\n'; };
  let result;
  try { result = sync.runSyncAll(tpl, root, { projects: [p], canaryName: 'proj', batchId: 'b40', nowIso: '2026-01-01T00:00:00.000Z' }); }
  finally { console.error = originalError; }
  t('batch aborts due to unresolved drift', result.ok === false && result.aborted === true);
  t('never prints the old hedge "(if applicable)"', !/\(if applicable\)/.test(captured));
  t('plainly states nothing was written (blocked, not failed)', /nothing was written/.test(captured));
}

console.log('\n40b) M8: the "own sync succeeded but still has unresolved drift" case gets an accurate message');
{
  const tpl = freshDir('t40b-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'new.cjs'), 'NEW-FILE'); // safely addable
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'drifted.cjs'), 'TEMPLATE-V2'); // will be drifted
  const root = freshDir('t40b-root');
  const p = makeProject(root, 'proj', 0); makeRealProjectMarker(p);
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'drifted.cjs'), 'HAND-EDITED');
  const originalError = console.error;
  let captured = '';
  console.error = (...args) => { captured += args.join(' ') + '\n'; };
  let result;
  try { result = sync.runSyncAll(tpl, root, { projects: [p], canaryName: 'proj', batchId: 'b40b', nowIso: '2026-01-01T00:00:00.000Z' }); }
  finally { console.error = originalError; }
  const repResult = result.projects && result.projects[0];
  t('the representative project itself DID sync successfully (new.cjs added)', repResult && repResult.ok === true && fs.existsSync(path.join(p, '.claude', 'forge-bin', 'new.cjs')));
  t('the batch still aborts (unresolved drift on drifted.cjs)', result.ok === false && result.aborted === true);
  t('message reflects the ACCURATE mixed state (own sync succeeded) — never the old hedged "(if applicable)"', !/\(if applicable\)/.test(captured) && /own sync succeeded/.test(captured));
}

console.log('\n41) M9: an EOL-only difference (CRLF vs LF, otherwise identical text) syncs instead of blocking as drift');
{
  const tpl = freshDir('t41-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'line1\nline2\nline3\n');
  const p = makeProject(freshDir('t41-root'), 'proj', 0);
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'line1\r\nline2\r\nline3\r\n'); // same TEXT, CRLF
  const pf = sync.preflight(tpl, p);
  const entry = pf.toChange.find((e) => e.rel === 'forge-bin/tool.cjs');
  t('classified as eol_only (in toChange, not unknownDrift, despite NO receipt at all)', !!entry && entry.overrideClass === 'eol_only' && !pf.unknownDrift.includes('forge-bin/tool.cjs'));
  const oldRawHash = sync.sha256(path.join(p, '.claude', 'forge-bin', 'tool.cjs'));
  const r = sync.safeSyncProject(tpl, p, { batchId: 'b41', nowIso: '2026-01-01T00:00:00.000Z' });
  t('sync succeeds (eol_only is always safe to sync)', r.ok === true);
  t('the project file now has the template\'s RAW (LF) bytes', fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'utf8') === 'line1\nline2\nline3\n');
  const backupFile = path.join(r.backup.backupDir, 'forge-bin', 'tool.cjs');
  t('the OLD raw (CRLF) bytes were backed up before the overwrite', fs.existsSync(backupFile) && sync.sha256(backupFile) === oldRawHash);
  t('receipt records the eol_only overrideClass', r.receipt.filesChanged.some((f) => f.rel === 'forge-bin/tool.cjs' && f.overrideClass === 'eol_only'));

  const p2 = makeProject(freshDir('t41b-root'), 'proj2', 0);
  fs.mkdirSync(path.join(p2, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p2, '.claude', 'forge-bin', 'tool.cjs'), 'COMPLETELY-DIFFERENT-TEXT\r\n');
  const pf2 = sync.preflight(tpl, p2);
  t('a genuine content difference (not just EOL) is still unknownDrift, never eol_only', pf2.unknownDrift.includes('forge-bin/tool.cjs') && !pf2.toChange.some((e) => e.rel === 'forge-bin/tool.cjs'));
}

console.log('\n42) M10 + test#7: a project path containing a SPACE and "!" works end-to-end; validation.commands is properly quoted');
{
  const tpl = freshDir('t42-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'console.log(1);\n');
  const spaceRoot = freshDir('t42-root space test!');
  const p = makeProject(spaceRoot, 'proj', 0);
  const r = sync.safeSyncProject(tpl, p, { batchId: 'b42', nowIso: '2026-01-01T00:00:00.000Z' });
  t('sync succeeds against a path containing a space and "!"', r.ok === true);
  t('validation.commands is a properly quoted, non-empty string mentioning the doctor path', Array.isArray(r.validation.commands) && r.validation.commands.length > 0 && r.validation.commands[0].includes('forge-doctor.cjs'));
  t('the quoted command string wraps the space/!-containing path segment in quotes', r.validation.commands.some((c) => /"[^"]*!/.test(c) || /"[^"]* /.test(c)));
  const rb = sync.rollbackProject(p, 'b42', {});
  t('rollback also works fine against the space/!-containing path', rb.ok === true);
}

console.log('\n43) M11: __throwAfter is gated behind FORGE_SYNC_TEST_HOOKS=1 (inert in a normal production process)');
{
  const tpl = freshDir('t43-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'x1.cjs'), 'X1');
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'x2.cjs'), 'X2');
  const p = makeProject(freshDir('t43-root'), 'proj', 0);
  sync.safeSyncProject(tpl, p, { batchId: 'b43', nowIso: '2026-01-01T00:00:00.000Z' });
  const scriptDir = freshDir('t43-script');
  const scriptPath = path.join(scriptDir, 'probe.cjs');
  fs.writeFileSync(scriptPath, [
    'const s = require(' + JSON.stringify(CLI) + ');',
    'const r = s.rollbackProject(' + JSON.stringify(p) + ', ' + JSON.stringify('b43') + ', { __throwAfter: 1 });',
    'console.log(JSON.stringify({ ok: r.ok, interrupted: !!r.interrupted }));',
  ].join('\n'));
  const cleanEnv = Object.assign({}, process.env);
  delete cleanEnv.FORGE_SYNC_TEST_HOOKS; // this test file sets it at module load — the CHILD must NOT inherit it
  const probeResult = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8', env: cleanEnv });
  t('probe subprocess ran cleanly', probeResult.status === 0);
  let parsed = null; try { parsed = JSON.parse((probeResult.stdout || '').trim()); } catch { /* leave null, next assert fails honestly */ }
  t('__throwAfter is INERT without FORGE_SYNC_TEST_HOOKS=1 — rollback completes normally, not "interrupted"', !!parsed && parsed.ok === true && parsed.interrupted === false);
}

console.log('\n44) adopt: establishes a baseline receipt without writing any system file; reports differing files');
{
  const tpl = freshDir('t44-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'a.cjs'), 'TEMPLATE-A');
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'b.cjs'), 'TEMPLATE-B');
  const p = makeProject(freshDir('t44-root'), 'proj', 0);
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'a.cjs'), 'PROJECT-OWNED-A'); // differs from template
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'b.cjs'), 'TEMPLATE-B'); // matches template
  // test pin (per WP): "adopt writes-nothing-else" must be proven with a snapshotTree over the WHOLE project,
  // not just spot-checking the two files adopt is expected to READ — this catches any accidental extra write
  // anywhere else in the project tree that per-file spot checks would silently miss.
  const wholeTreeBefore = snapshotTree(p);
  const r = sync.adoptProject(tpl, p, { nowIso: '2026-01-01T00:00:00.000Z' });
  t('adopt reports ok:true', r.ok === true);
  t('adopt did NOT write any system file (a.cjs/b.cjs bytes are untouched)', fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'a.cjs'), 'utf8') === 'PROJECT-OWNED-A' && fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'b.cjs'), 'utf8') === 'TEMPLATE-B');
  const wholeTreeAfter = snapshotTree(p);
  const receiptKey = Object.keys(wholeTreeAfter).find((k) => k === sync.receiptPath(p));
  const changedOrAddedKeys = Object.keys(wholeTreeAfter).filter((k) => wholeTreeAfter[k] !== wholeTreeBefore[k]);
  t('WHOLE-PROJECT snapshotTree proof: the ONLY file adopt changed/added anywhere in the project is the receipt itself', changedOrAddedKeys.length === 1 && changedOrAddedKeys[0] === receiptKey);
  t('nothing was REMOVED anywhere in the project by adopt', Object.keys(wholeTreeBefore).every((k) => Object.prototype.hasOwnProperty.call(wholeTreeAfter, k)));
  t('adopt reports a.cjs as differing from the template', r.differing.includes('forge-bin/a.cjs') && !r.differing.includes('forge-bin/b.cjs'));
  t('receipt now exists with knownHashes for both files (the CURRENT project bytes, verbatim)', fs.existsSync(sync.receiptPath(p)) && r.receipt.knownHashes['forge-bin/a.cjs'] === sync.sha256(path.join(p, '.claude', 'forge-bin', 'a.cjs')));
  const pf = sync.preflight(tpl, p);
  t('after adopt, preflight sees a.cjs as a SAFE update, not unknownDrift (adopt replaces a blind --force-overwrite)', pf.toChange.some((e) => e.rel === 'forge-bin/a.cjs') && !pf.unknownDrift.includes('forge-bin/a.cjs'));

  const p2 = makeProject(freshDir('t44b-root'), 'proj2', 0);
  const before2 = snapshotTree(p2);
  const rDry = sync.adoptProject(tpl, p2, { dryRun: true });
  t('adopt --dry-run reports ok:true but writes nothing', rDry.ok === true && rDry.dryRun === true && JSON.stringify(snapshotTree(p2)) === JSON.stringify(before2));
}

console.log('\n45) M4: a forge-doctor TIMEOUT is BLOCKED, not a confirmed validation failure; --doctor-timeout is a real, settable value');
{
  const tpl = freshDir('t45-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'NEW');
  const p = makeProject(freshDir('t45-root'), 'proj', null);
  const dir = path.join(p, '.claude', 'forge-bin');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'forge-doctor.cjs'), '#!/usr/bin/env node\nvar start = Date.now(); while (Date.now() - start < 4000) {}\nprocess.exit(0);\n', 'utf8');
  const r = sync.safeSyncProject(tpl, p, { batchId: 'b45', nowIso: '2026-01-01T00:00:00.000Z', doctorTimeoutMs: 300 });
  t('sync reports ok:false (validator did not confirm in time)', r.ok === false);
  t('validation reports timedOut:true (BLOCKED classification, not a confirmed failure)', r.validation && r.validation.timedOut === true);
  t('outcome reflects timedOut, distinct from a genuine red result', r.outcome && r.outcome.timedOut === true);
  t('tool.cjs (the added file) was rolled back to non-existence after the confirmed-blocked sync', !fs.existsSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs')));
}

// =====================================================================================
// 2026-07-14 FINAL FIX ROUND — sections 46-56 map 1:1 to Blocker 1-3 + S1-S8 from the converged
// adversarial-review + mutation-testing QA. Every fixture stays os.tmpdir()-only.
// =====================================================================================

console.log('\n46) B1: regressionCheck/decideValidationOutcome sees ALL 8 doctor checks, not just node_check+tests');
{
  const mkSummary = (over) => Object.assign({
    ok: false, node_check: { ok: true }, tests: { ok: true },
    checksOk: Object.assign({
      node_check: { ok: true }, tests: { ok: true }, strict_events: { ok: true }, dashboard_spa: { ok: true },
      leak_scan: { ok: false }, agents: { ok: true }, chain: { ok: true }, rebinding_guard: { ok: true },
    }, over),
  }, {});
  const preSummary = mkSummary({}); // leak_scan already red pre-sync
  const postSummarySameRed = mkSummary({}); // still only leak_scan red, nothing else changed
  const postSummaryRegressed = mkSummary({ dashboard_spa: { ok: false } }); // dashboard_spa newly broken

  const regressedNone = sync.regressionCheck(preSummary, postSummarySameRed);
  t('regressionCheck: identical pre/post red -> no regression detected', regressedNone.length === 0);
  const regressedHit = sync.regressionCheck(preSummary, postSummaryRegressed);
  t('regressionCheck: dashboard_spa flips green->red -> DETECTED (the old 2-check condense could never see this)', regressedHit.includes('dashboard_spa'));

  const outcomeSame = sync.decideValidationOutcome({ ok: false, summary: preSummary }, { ok: false, summary: postSummarySameRed }, {});
  t('decideValidationOutcome: pre red + post IDENTICALLY red -> ok:true, alreadyRedSkipped (not blamed on this sync)', outcomeSame.ok === true && outcomeSame.alreadyRedSkipped === true);
  const outcomeRegressed = sync.decideValidationOutcome({ ok: false, summary: preSummary }, { ok: false, summary: postSummaryRegressed }, {});
  t('decideValidationOutcome: pre red (leak_scan) + post regressed on dashboard_spa -> ok:false, NOT alreadyRedSkipped (kills B1)', outcomeRegressed.ok === false && !outcomeRegressed.alreadyRedSkipped);

  // end-to-end proof: the receipt persists the FULL per-check pre/post map (checksOk with all 8 keys)
  const tpl = freshDir('t46-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'NEW');
  const p = makeProject(freshDir('t46-root'), 'proj', null);
  const dir46 = path.join(p, '.claude', 'forge-bin');
  fs.mkdirSync(dir46, { recursive: true });
  const fullChecks = {
    node_check: { ok: true, total: 50, failed: 0 }, tests: { ok: true, suites: 5, passed: 20, failed: 0 },
    strict_events: { ok: true }, dashboard_spa: { ok: true }, leak_scan: { ok: true }, agents: { ok: true }, chain: { ok: true }, rebinding_guard: { ok: true },
  };
  fs.writeFileSync(path.join(dir46, 'forge-doctor.cjs'),
    '#!/usr/bin/env node\nvar a=process.argv.slice(2);if(a.indexOf("--json")!==-1){console.log(' + JSON.stringify(JSON.stringify({ ok: true, checks: fullChecks })) + ');}\nprocess.exit(0);\n', 'utf8');
  const r46 = sync.safeSyncProject(tpl, p, { batchId: 'b46', nowIso: '2026-01-01T00:00:00.000Z' });
  t('sync ok (real 8-check doctor stub)', r46.ok === true);
  const allEightKeys = ['node_check', 'tests', 'strict_events', 'dashboard_spa', 'leak_scan', 'agents', 'chain', 'rebinding_guard'];
  t('B1: receipt.validation.summary.checksOk carries ALL 8 doctor checks, not just node_check+tests', allEightKeys.every((k) => r46.receipt.validation.summary.checksOk && Object.prototype.hasOwnProperty.call(r46.receipt.validation.summary.checksOk, k)));
}

console.log('\n47) H1: PINNED direct test — post-restore hash-verification block (previously a SURVIVING mutant, zero direct coverage)');
{
  const crypto47 = require('crypto');
  // (a) CORRUPT case: backup bytes on disk diverge from the manifest's recorded oldHash -> must be caught.
  // This is a DIRECT call to restoreFromManifest (bypassing loadTrustedManifest/verifyBackupIntegrity, which
  // would otherwise refuse earlier) so this test exercises ONLY the post-restore verification block itself.
  const pA = makeProject(freshDir('t47a-root'), 'proj', 0);
  fs.mkdirSync(path.join(pA, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(pA, '.claude', 'forge-bin', 'x.cjs'), 'CURRENT-CONTENT-BEFORE-RESTORE');
  const manifestDirA = freshDir('t47a-manifest');
  fs.mkdirSync(path.join(manifestDirA, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(manifestDirA, 'forge-bin', 'x.cjs'), 'CORRUPTED-BACKUP-BYTES-ON-DISK');
  const wrongOldHash = crypto47.createHash('sha256').update('THIS-IS-WHAT-THE-MANIFEST-CLAIMS-WAS-BACKED-UP').digest('hex');
  // newHash MUST match the file's CURRENT on-disk content (what "this sync" is recorded as having written) —
  // otherwise the UNRELATED B7 divergence guard refuses before ever reaching the H1 post-restore check this
  // test targets, and its refusedDivergence shape has no failed[]/partial field (a different code path).
  const currentHashA = sync.sha256(path.join(pA, '.claude', 'forge-bin', 'x.cjs'));
  const manifestA = { batchId: 'b47a', files: [{ rel: 'forge-bin/x.cjs', oldHash: wrongOldHash, newHash: currentHashA }] };
  const resultA = sync.restoreFromManifest(pA, manifestDirA, manifestA, {});
  t('H1 PIN: corrupt backup bytes vs recorded oldHash -> ok:false (never a false "restored")', resultA.ok === false);
  t('H1 PIN: rel is in failed[], NOT in restored[]', !resultA.restored.includes('forge-bin/x.cjs') && resultA.failed.some((f) => f.rel === 'forge-bin/x.cjs'));
  t('H1 PIN: failure reason literally cites "hash mismatch after restore"', resultA.failed.some((f) => /hash mismatch after restore/.test(f.reason)));
  t('H1 PIN: this is exactly the shape rollbackProject() reports as PARTIAL/MANUAL RECOVERY', resultA.partial === true);

  // (b) CONTROL case: backup bytes genuinely match the recorded oldHash -> restore succeeds normally. This
  // proves test (a) fails for the RIGHT reason (a real mismatch), not because restoreFromManifest is broken.
  const pB = makeProject(freshDir('t47b-root'), 'proj', 0);
  fs.mkdirSync(path.join(pB, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(pB, '.claude', 'forge-bin', 'x.cjs'), 'CURRENT-CONTENT-BEFORE-RESTORE');
  const manifestDirB = freshDir('t47b-manifest');
  fs.mkdirSync(path.join(manifestDirB, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(manifestDirB, 'forge-bin', 'x.cjs'), 'GENUINE-BACKUP-BYTES');
  const correctOldHash = sync.sha256(path.join(manifestDirB, 'forge-bin', 'x.cjs'));
  const currentHashB = sync.sha256(path.join(pB, '.claude', 'forge-bin', 'x.cjs')); // same "not diverged" reasoning as (a)
  const manifestB = { batchId: 'b47b', files: [{ rel: 'forge-bin/x.cjs', oldHash: correctOldHash, newHash: currentHashB }] };
  const resultB = sync.restoreFromManifest(pB, manifestDirB, manifestB, {});
  t('H1 CONTROL: matching backup bytes -> ok:true, rel genuinely restored', resultB.ok === true && resultB.restored.includes('forge-bin/x.cjs'));
  t('H1 CONTROL: on-disk file now holds the genuine backup bytes', fs.readFileSync(path.join(pB, '.claude', 'forge-bin', 'x.cjs'), 'utf8') === 'GENUINE-BACKUP-BYTES');
}

console.log('\n48) B3 (Blocker 3): install refuses to stamp a partial sync when unresolved drift/conflict remains');
{
  const tpl = freshDir('t48-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'new.cjs'), 'NEW-FILE-CONTENT'); // safely addable
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'drifted.cjs'), 'TEMPLATE-V2'); // will be drifted
  const p = makeProject(freshDir('t48-root'), 'proj', 0);
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'drifted.cjs'), 'HAND-EDITED'); // no receipt -> unknownDrift
  t('sanity: no FORGE_VERSION.json exists before this install', !fs.existsSync(sync.versionFilePath(p)));
  const cliResult = runCLIWithTemplate(['install', p, '--batch-id', 'b48'], tpl);
  t('install CLI exits non-zero (BLOCKER 3 — was wrongly exit 0)', cliResult.status !== 0);
  t('stderr explicitly names the drifted file', /drifted\.cjs/.test(cliResult.stderr));
  t('stderr says BLOCKED', /BLOCKED/.test(cliResult.stderr));
  t('FORGE_VERSION.json is still NOT written (a partially-synced project must not claim the new template version)', !fs.existsSync(sync.versionFilePath(p)));
  t('the safely-addable file (new.cjs) was ALSO rolled back, not left half-applied', !fs.existsSync(path.join(p, '.claude', 'forge-bin', 'new.cjs')));
  t('no forge-sync-receipt.json was written either', !fs.existsSync(sync.receiptPath(p)));
  t('the hand-edited drifted file is completely untouched', fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'drifted.cjs'), 'utf8') === 'HAND-EDITED');
}

console.log('\n48b) B3: --force-overwrite still fully resolves drift for install (both files land, version stamped)');
{
  const tpl = freshDir('t48b-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'new.cjs'), 'NEW-FILE-CONTENT');
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'drifted.cjs'), 'TEMPLATE-V2');
  const p = makeProject(freshDir('t48b-root'), 'proj', 0);
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'drifted.cjs'), 'HAND-EDITED');
  const cliResult = runCLIWithTemplate(['install', p, '--batch-id', 'b48b', '--force-overwrite'], tpl);
  t('install --force-overwrite exits 0 (no unresolved drift remains)', cliResult.status === 0);
  t('both files landed', fs.existsSync(path.join(p, '.claude', 'forge-bin', 'new.cjs')) && fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'drifted.cjs'), 'utf8') === 'TEMPLATE-V2');
  t('FORGE_VERSION.json IS stamped (fully resolved this time)', fs.existsSync(sync.versionFilePath(p)));
}

console.log('\n49) S1: --resume-batch never re-backs-up an already-backed-up file or recomputes its oldHash from mixed state');
{
  const crypto49 = require('crypto');
  const tpl = freshDir('t49-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'a.cjs'), 'A-NEW');
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'b.cjs'), 'B-NEW');
  const p = makeProject(freshDir('t49-root'), 'proj', 0);
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'a.cjs'), 'A-OLD');
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'b.cjs'), 'B-OLD');
  const plan49 = { toChange: [
    { rel: 'forge-bin/a.cjs', oldHash: sync.sha256(path.join(p, '.claude', 'forge-bin', 'a.cjs')), newHash: sync.sha256(path.join(tpl, 'forge-bin', 'a.cjs')), isNew: false, overrideClass: null },
    { rel: 'forge-bin/b.cjs', oldHash: sync.sha256(path.join(p, '.claude', 'forge-bin', 'b.cjs')), newHash: sync.sha256(path.join(tpl, 'forge-bin', 'b.cjs')), isNew: false, overrideClass: null },
  ] };
  const backup1 = sync.takeBackup(p, 'batch-resume', plan49, 'v1', '2026-01-01T00:00:00.000Z', {});
  t('first takeBackup call succeeds and records a.cjs old hash as A-OLD', backup1.ok === true && backup1.manifest.files.find((f) => f.rel === 'forge-bin/a.cjs').oldHash === crypto49.createHash('sha256').update('A-OLD').digest('hex'));
  // simulate a CRASH mid-apply: a.cjs already got written to its NEW content, b.cjs never reached
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'a.cjs'), 'A-NEW'); // mixed state on disk now
  // resume: takeBackup is called again for the SAME batch (this is what --resume-batch triggers)
  const backup2 = sync.takeBackup(p, 'batch-resume', plan49, 'v1', '2026-01-02T00:00:00.000Z', {});
  const a2 = backup2.manifest.files.find((f) => f.rel === 'forge-bin/a.cjs');
  const trueOldHashOfA = crypto49.createHash('sha256').update('A-OLD').digest('hex');
  t('S1 FIX: resumed takeBackup does NOT recompute a.cjs oldHash from the mixed (already-applied) state', a2.oldHash === trueOldHashOfA);
  const backupBytesA = fs.readFileSync(path.join(backup2.backupDir, 'forge-bin', 'a.cjs'), 'utf8');
  t('S1 FIX: the PRISTINE backup bytes for a.cjs (A-OLD) were never overwritten by the resumed takeBackup call', backupBytesA === 'A-OLD');
  // Restore only the subset ACTUALLY applied before the simulated crash (a.cjs) — b.cjs was never reached by
  // the writer, so its current bytes still legitimately equal its PRE-sync value; restoring the full plan
  // would trip the (unrelated, correct) B7 divergence guard on b.cjs, which never received any write to
  // "diverge" from. This mirrors production: safeSyncProject always restores subsetManifest(backup.manifest,
  // apply.applied) — only the rels the writer actually reached — never the whole planned set.
  const appliedSubset = sync.subsetManifest(backup2.manifest, ['forge-bin/a.cjs']);
  const rb49 = sync.restoreFromManifest(p, backup2.backupDir, appliedSubset, {});
  t('rollback from the resumed manifest restores a.cjs to the TRUE original (A-OLD), not the mid-crash mixed content', rb49.ok === true && fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'a.cjs'), 'utf8') === 'A-OLD');
  t('b.cjs (never reached by the simulated crash) is untouched by this restore', fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'b.cjs'), 'utf8') === 'B-OLD');
}

console.log('\n50) S2: --unsafe (rawInstall) honors the override allow-list, containment/symlink guard, and unreadable-file refusal');
{
  // (a) override allow-list must be honored even in --unsafe mode
  const tplA = freshDir('t50a-tpl');
  fs.mkdirSync(path.join(tplA, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tplA, 'forge-bin', 'override.cjs'), 'TEMPLATE-NEW');
  const pA = makeProject(freshDir('t50a-root'), 'proj', null);
  fs.mkdirSync(path.join(pA, '.claude', 'forge-bin'), { recursive: true });
  fs.mkdirSync(path.join(pA, '.claude', 'config'), { recursive: true });
  fs.writeFileSync(path.join(pA, '.claude', 'forge-bin', 'override.cjs'), 'PROJECT-OWNED-FOREVER');
  fs.writeFileSync(path.join(pA, '.claude', 'config', 'forge-overrides.json'), JSON.stringify({ overrides: ['forge-bin/override.cjs'] }));
  const rA = sync.rawInstall(tplA, pA, { batchId: 'b50a', nowIso: '2026-01-01T00:00:00.000Z' });
  t('S2: rawInstall reports ok:true', rA.ok === true);
  t('S2: the override-declared file is NEVER touched, even by --unsafe', fs.readFileSync(path.join(pA, '.claude', 'forge-bin', 'override.cjs'), 'utf8') === 'PROJECT-OWNED-FOREVER');
  t('S2: rawInstall reports it as a skippedOverride', rA.skippedOverrides.includes('forge-bin/override.cjs'));

  // (b) containment/symlink guard must be honored even in --unsafe mode
  const tplB = freshDir('t50b-tpl');
  fs.mkdirSync(path.join(tplB, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tplB, 'forge-bin', 'tool.cjs'), 'NEW');
  const pB = makeProject(freshDir('t50b-root'), 'proj', null);
  const outsideB = freshDir('t50b-outside');
  const junctionTargetB = path.join(pB, '.claude', 'forge-bin');
  fs.rmSync(junctionTargetB, { recursive: true, force: true });
  let junctionOkB = false;
  try { fs.symlinkSync(outsideB, junctionTargetB, 'junction'); junctionOkB = true; }
  catch (e) { console.log('     (S2b evidence: could not create a junction in this environment — skipping honestly)'); }
  if (junctionOkB) {
    const rB = sync.rawInstall(tplB, pB, { batchId: 'b50b', nowIso: '2026-01-01T00:00:00.000Z' });
    t('S2: rawInstall reports ok:true (nothing safe to change; junctioned file skipped)', rB.ok === true);
    t('S2: nothing was written into the OUTSIDE (junction target) directory, even by --unsafe', !fs.existsSync(path.join(outsideB, 'tool.cjs')));
  } else {
    t('(S2b skipped honestly — junction creation unavailable in this sandbox)', true);
  }

  // (c) unreadable existing file refuses the WHOLE --unsafe install, never treated as "new"
  const tplC = freshDir('t50c-tpl');
  fs.mkdirSync(path.join(tplC, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tplC, 'forge-bin', 'tool.cjs'), 'NEW-CONTENT');
  const pC = makeProject(freshDir('t50c-root'), 'proj', null);
  fs.mkdirSync(path.join(pC, '.claude', 'forge-bin', 'tool.cjs'), { recursive: true }); // a DIRECTORY where a file is expected -> EISDIR
  const rC = sync.rawInstall(tplC, pC, { batchId: 'b50c', nowIso: '2026-01-01T00:00:00.000Z' });
  t('S2: rawInstall REFUSES on an unreadable existing file (ok:false), never treats it as "new"', rC.ok === false);
  t('S2: refusal reason names the unreadable file', /tool\.cjs/.test(rC.reason || ''));
  t('S2: no backup was taken (refused before backup)', !fs.existsSync(path.join(sync.claudeDirOf(pC), 'forge-backups')));
  t('S2: the directory is still there, untouched (never overwritten/deleted)', fs.existsSync(path.join(pC, '.claude', 'forge-bin', 'tool.cjs')) && fs.lstatSync(path.join(pC, '.claude', 'forge-bin', 'tool.cjs')).isDirectory());
}

console.log('\n51) S3: rollback (no --central-backup-root) finds a sync-all-recorded hub even when its OWN default guess would be WRONG for a nested project');
{
  const tpl = freshDir('t51-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'NEW');
  const root = freshDir('t51-root');
  const nestedParent = path.join(root, 'group'); // project is NOT a direct child of root
  fs.mkdirSync(nestedParent, { recursive: true });
  const p = makeProject(nestedParent, 'proj', 0);
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'OLD');
  fakeReceiptMatchingCurrent(p, [['forge-bin/tool.cjs', sync.sha256(path.join(p, '.claude', 'forge-bin', 'tool.cjs'))]]);
  const rootHub = path.join(root, '.forge-backup-hub'); // sync-all's OWN derivation: rootDir-based
  const rSync = sync.safeSyncProject(tpl, p, { batchId: 'b51', nowIso: '2026-01-01T00:00:00.000Z', centralBackupRoot: rootHub });
  t('sync ok, central backup recorded under the ROOT-derived hub', rSync.ok === true);

  // simulate a scenario where ONLY the central copy is trustworthy: corrupt the project-local backup FILE
  // bytes (not delete the dir) so loadTrustedManifest must fall through to central, while the project's own
  // manifest.json (which S3 now records centralBackupRoot into) is STILL present and readable.
  fs.writeFileSync(path.join(sync.backupDirFor(p, 'b51'), 'forge-bin', 'tool.cjs'), 'TAMPERED-LOCAL-BACKUP-BYTES');

  // rollback with a WRONG default guess (install/rollback's own dirname(project)-based default — for this
  // NESTED project that resolves to <nestedParent>/.forge-backup-hub, a DIFFERENT, EMPTY directory)
  const wrongGuessedHub = path.join(nestedParent, '.forge-backup-hub');
  t('sanity: the wrongly-guessed hub does not even exist', !fs.existsSync(wrongGuessedHub));
  const rb = sync.rollbackProject(p, 'b51', { centralBackupRoot: wrongGuessedHub }); // NOT marked explicit -> S3 fix should override it
  t('S3 FIX: rollback still succeeds via the CORRECT (recorded) central hub, ignoring the wrong default guess', rb.ok === true && rb.source === 'central');
  t('S3 FIX: the file is restored to the correct pre-sync bytes (OLD)', fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'utf8') === 'OLD');

  // CONTROL: an EXPLICIT (non-default) --central-backup-root must NOT be silently overridden
  const rbExplicitWrong = sync.rollbackProject(p, 'b51', { centralBackupRoot: wrongGuessedHub, centralBackupRootExplicit: true });
  t('CONTROL: marking the guess EXPLICIT means it is honored as-is (no self-healing) -> refuses since that dir has no valid backup', rbExplicitWrong.ok === false);
}

console.log('\n52) S4: findNewerOverlappingBatches also detects a newer batch recorded ONLY in the central hub (local evidence gone)');
{
  const tpl = freshDir('t52-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'V2');
  const p = makeProject(freshDir('t52-root'), 'proj', 0);
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'V1');
  const v1Hash = sync.sha256(path.join(p, '.claude', 'forge-bin', 'tool.cjs'));
  fakeReceiptMatchingCurrent(p, [['forge-bin/tool.cjs', v1Hash]]);
  const hub = freshDir('t52-hub');
  sync.safeSyncProject(tpl, p, { batchId: 'batch-old', nowIso: '2026-01-01T00:00:00.000Z', centralBackupRoot: hub }); // V1 -> V2
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'V3');
  sync.safeSyncProject(tpl, p, { batchId: 'batch-new', nowIso: '2026-01-02T00:00:00.000Z', centralBackupRoot: hub }); // V2 -> V3 (the NEWER batch)

  // simulate a central-only recovery: the project's OWN local backup dir for the NEWER batch is gone, so the
  // overlap can ONLY be discovered by scanning central.
  fs.rmSync(path.join(sync.claudeDirOf(p), 'forge-backups', 'batch-new'), { recursive: true, force: true });
  t('sanity: local evidence for the newer batch is now gone', !fs.existsSync(path.join(sync.claudeDirOf(p), 'forge-backups', 'batch-new')));
  t('sanity: central evidence for the newer batch still exists', fs.existsSync(path.join(sync.centralBackupDir(hub, 'batch-new', sync.projectId(p)), 'manifest.json')));

  const rb = sync.rollbackProject(p, 'batch-old', { centralBackupRoot: hub, centralBackupRootExplicit: true });
  t('S4 FIX: rolling back the OLDER batch REFUSES — the newer batch is found via the CENTRAL scan even though local evidence for it is gone', rb.ok === false && Array.isArray(rb.newerOverlaps) && rb.newerOverlaps.some((o) => o.batchId === 'batch-new'));
  t('the project is left at V3, untouched (refusal protected the newer content)', fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), 'utf8') === 'V3');
}

console.log('\n53) S5: adopt REFUSES to silently replace an existing baseline; --force replaces + snapshots the old receipt');
{
  const tpl = freshDir('t53-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'a.cjs'), 'TEMPLATE-A');
  const p = makeProject(freshDir('t53-root'), 'proj', 0);
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'a.cjs'), 'PROJECT-OWNED-A-V1');
  const r1 = sync.adoptProject(tpl, p, { nowIso: '2026-01-01T00:00:00.000Z' });
  t('first adopt succeeds (no prior baseline)', r1.ok === true && r1.priorBaselineCount === 0);
  const receiptAfterFirstAdopt = fs.readFileSync(sync.receiptPath(p), 'utf8');

  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'a.cjs'), 'PROJECT-OWNED-A-V2-DIFFERENT');
  const r2 = sync.adoptProject(tpl, p, { nowIso: '2026-01-02T00:00:00.000Z' });
  t('S5 FIX: second adopt WITHOUT --force REFUSES (ok:false, refused:true)', r2.ok === false && r2.refused === true);
  t('S5 FIX: refusal names the existing baseline count', r2.existingBaseline === true && r2.priorBaselineCount === 1);
  t('S5 FIX: the receipt on disk is UNCHANGED by the refused adopt', fs.readFileSync(sync.receiptPath(p), 'utf8') === receiptAfterFirstAdopt);

  const r3 = sync.adoptProject(tpl, p, { nowIso: '2026-01-03T00:00:00.000Z', force: true });
  t('S5 FIX: --force explicitly allows replacing the baseline', r3.ok === true);
  t('S5 FIX: the NEW baseline reflects the CURRENT (V2) bytes', r3.receipt.knownHashes['forge-bin/a.cjs'] === sync.sha256(path.join(p, '.claude', 'forge-bin', 'a.cjs')));
  t('S5 FIX: the OLD receipt was snapshotted before being replaced (undoable)', !!r3.snapshotPath && fs.existsSync(r3.snapshotPath));
  const snapshotContent = JSON.parse(fs.readFileSync(r3.snapshotPath, 'utf8'));
  t('S5 FIX: the snapshot genuinely holds the FIRST adopt\'s receipt content (undo point)', JSON.stringify(snapshotContent.knownHashes) === JSON.stringify(JSON.parse(receiptAfterFirstAdopt).knownHashes));

  const cliNoForce = runCLIWithTemplate(['adopt', p], tpl);
  t('CLI: adopt without --force exits non-zero on an existing baseline', cliNoForce.status !== 0);
  const cliForce = runCLIWithTemplate(['adopt', p, '--force'], tpl);
  t('CLI: adopt --force exits 0', cliForce.status === 0);
  t('CLI: adopt --force prints the "replaces an existing baseline of N file(s)" warning', /replaces an existing baseline of \d+ file\(s\)/.test(cliForce.stdout));
}

console.log('\n54) S6: rollback / rollback-batch / adopt all take a lock; sync-all holds each project\'s OWN lock too (not just root)');
{
  // (a) adopt refuses while a fresh lock is held on the project
  const tplA = freshDir('t54a-tpl');
  fs.mkdirSync(path.join(tplA, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tplA, 'forge-bin', 'a.cjs'), 'A');
  const pA = makeProject(freshDir('t54a-root'), 'proj', 0);
  const lockPathA = sync.lockPathFor(sync.claudeDirOf(pA));
  fs.writeFileSync(lockPathA, JSON.stringify({ pid: 999999, ts: new Date().toISOString() }));
  const cliAdopt = runCLIWithTemplate(['adopt', pA], tplA);
  t('S6: adopt refuses while a fresh lock is held (exit 1, not a crash)', cliAdopt.status === 1);
  fs.rmSync(lockPathA, { force: true });
  const cliAdopt2 = runCLIWithTemplate(['adopt', pA], tplA);
  t('S6: after the lock is released, adopt succeeds normally', cliAdopt2.status === 0);
  t('S6: adopt cleans up its own lock file (no leftover lock)', !fs.existsSync(lockPathA));

  // (b) rollback refuses while a fresh lock is held on the project
  const tplB = freshDir('t54b-tpl');
  fs.mkdirSync(path.join(tplB, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tplB, 'forge-bin', 'tool.cjs'), 'NEW');
  const pB = makeProject(freshDir('t54b-root'), 'proj', 0);
  const rSyncB = sync.safeSyncProject(tplB, pB, { batchId: 'b54b', nowIso: '2026-01-01T00:00:00.000Z' });
  t('sanity: sync succeeded for the rollback-lock test', rSyncB.ok === true);
  const lockPathB = sync.lockPathFor(sync.claudeDirOf(pB));
  fs.writeFileSync(lockPathB, JSON.stringify({ pid: 999999, ts: new Date().toISOString() }));
  const cliRollback = runCLI(['rollback', pB, '--batch', 'b54b']);
  t('S6: rollback refuses while a fresh lock is held (exit 1, not a crash)', cliRollback.status === 1);
  t('S6: the file was NOT rolled back while locked', fs.existsSync(path.join(pB, '.claude', 'forge-bin', 'tool.cjs')));
  fs.rmSync(lockPathB, { force: true });
  const cliRollback2 = runCLI(['rollback', pB, '--batch', 'b54b']);
  t('S6: after the lock is released, rollback succeeds normally', cliRollback2.status === 0);

  // (c) runSyncAll holds EACH project's own lock (not just root) — a pre-existing FRESH lock on one project
  // causes THAT project's own sync to be refused.
  const tplC = freshDir('t54c-tpl');
  fs.mkdirSync(path.join(tplC, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tplC, 'forge-bin', 'tool.cjs'), 'NEW');
  const rootC = freshDir('t54c-root');
  const repC = makeProject(rootC, 'rep', 0); makeRealProjectMarker(repC);
  const lockedProjC = makeProject(rootC, 'lockedProj', 0); makeRealProjectMarker(lockedProjC);
  fs.writeFileSync(sync.lockPathFor(sync.claudeDirOf(lockedProjC)), JSON.stringify({ pid: 999999, ts: new Date().toISOString() }));
  const resultC = sync.runSyncAll(tplC, rootC, { projects: [repC, lockedProjC], canaryName: 'rep', batchId: 'b54c', nowIso: '2026-01-01T00:00:00.000Z' });
  const lockedResult = resultC.projects.find((r) => r.projectDir === lockedProjC);
  t('S6 FIX: sync-all could not acquire the locked project\'s OWN lock -> that project\'s sync is refused', !!lockedResult && lockedResult.ok === false && /S6/.test(lockedResult.reason || ''));
  t('S6 FIX: the locked project was never actually written to (still no tool.cjs)', !fs.existsSync(path.join(lockedProjC, '.claude', 'forge-bin', 'tool.cjs')));
  fs.rmSync(sync.lockPathFor(sync.claudeDirOf(lockedProjC)), { force: true });
}

console.log('\n55) S7: EOL normalization operates on RAW BYTES, never a lossy UTF-8 string decode (two different invalid byte sequences must NOT collide)');
{
  // two GENUINELY different byte sequences that a NAIVE .toString('utf8')-based normalizer collapses to the
  // IDENTICAL decoded string (both single invalid bytes -> the SAME U+FFFD replacement char) — confirmed by
  // direct Node probe before writing this test: a.toString('utf8') === b.toString('utf8') is true, yet
  // a.equals(b) is false.
  const bufA = Buffer.concat([Buffer.from('hello '), Buffer.from([0xff]), Buffer.from(' world\n')]);
  const bufB = Buffer.concat([Buffer.from('hello '), Buffer.from([0xc0]), Buffer.from(' world\n')]);
  t('sanity: the two buffers really do have different raw bytes', !bufA.equals(bufB));
  t('sanity: a naive .toString(\'utf8\') decode of both WOULD collide (proves the bug is real, not theoretical)', bufA.toString('utf8') === bufB.toString('utf8'));

  const tpl = freshDir('t55-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), bufA);
  const p = makeProject(freshDir('t55-root'), 'proj', 0);
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'tool.cjs'), bufB);

  const normA = sync.sha256Normalized(path.join(tpl, 'forge-bin', 'tool.cjs'));
  const normB = sync.sha256Normalized(path.join(p, '.claude', 'forge-bin', 'tool.cjs'));
  t('S7 FIX: byte-level normalization produces DIFFERENT hashes for genuinely different invalid-byte content (the OLD lossy decode would have made these MATCH)', normA !== normB);

  const pf = sync.preflight(tpl, p);
  t('S7 FIX: this genuine content difference is classified as unknownDrift, NEVER eol_only (never bypasses the drift gate)', pf.unknownDrift.includes('forge-bin/tool.cjs') && !pf.toChange.some((e) => e.rel === 'forge-bin/tool.cjs' && e.overrideClass === 'eol_only'));

  // CONTROL: normalizeEolBuffer still correctly collapses a GENUINE CRLF-vs-LF difference
  const crlfBuf = Buffer.from('line1\r\nline2\r\n');
  const lfBuf = Buffer.from('line1\nline2\n');
  t('CONTROL: normalizeEolBuffer(CRLF) equals normalizeEolBuffer(LF) for genuinely EOL-only-differing content', sync.normalizeEolBuffer(crlfBuf).equals(sync.normalizeEolBuffer(lfBuf)));
  const crOnlyBuf = Buffer.from('line1\rline2\r');
  t('CONTROL: a lone CR (no paired LF) also normalizes to LF, matching the LF version', sync.normalizeEolBuffer(crOnlyBuf).equals(sync.normalizeEolBuffer(lfBuf)));
}

console.log('\n56) S8: numeric flag validation exits 2; rollbackStatus is a genuinely honest constant; a backup I/O failure refuses cleanly (no crash)');
{
  const p0 = freshDir('t56-flags-root');
  t('S8: --stage-size with a non-numeric value exits 2 (usage error), not a silent NaN-fallback', runCLI(['sync-all', p0, '--stage-size', 'abc']).status === 2);
  t('S8: --doctor-timeout with a non-numeric value exits 2', runCLI(['install', p0, '--doctor-timeout', 'notanumber']).status === 2);
  const validFlagsResult = runCLI(['sync-all', p0, '--stage-size', '5', '--dry-run']);
  t('S8: a VALID numeric --stage-size never triggers the usage-error path (exit code is not 2)', validFlagsResult.status !== 2);

  const tpl = freshDir('t56-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'NEW');
  const p = makeProject(freshDir('t56-root'), 'proj', 0);
  const r = sync.safeSyncProject(tpl, p, { batchId: 'b56', nowIso: '2026-01-01T00:00:00.000Z' });
  t('S8: rollbackStatus is a genuinely self-descriptive constant, not a bare vague "n/a"', r.receipt.rollbackStatus === 'not_rolled_back_as_of_this_write');

  const tpl2 = freshDir('t56b-tpl');
  fs.mkdirSync(path.join(tpl2, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl2, 'forge-bin', 'tool.cjs'), 'NEW');
  const p2 = makeProject(freshDir('t56b-root'), 'proj', 0);
  const unwritableHubParent = freshDir('t56b-hubparent');
  const fakeHubPath = path.join(unwritableHubParent, 'not-a-directory.txt');
  fs.writeFileSync(fakeHubPath, 'this is a FILE, not a directory — mkdirSync through it must fail'); // ENOTDIR trap
  let threw = false, r2 = null;
  try { r2 = sync.safeSyncProject(tpl2, p2, { batchId: 'b56b', nowIso: '2026-01-01T00:00:00.000Z', centralBackupRoot: fakeHubPath }); }
  catch (e) { threw = true; }
  t('S8: an unwritable/invalid central backup hub NEVER throws an uncaught exception out of safeSyncProject', threw === false);
  t('S8: it is instead reported as a clean, honest refusal (ok:false)', !!r2 && r2.ok === false);
  t('S8: nothing was applied to the project (refused before any real write)', !fs.existsSync(path.join(p2, '.claude', 'forge-bin', 'tool.cjs')));

  const backupResult = sync.takeBackup(p2, 'b56c', { toChange: [{ rel: 'forge-bin/tool.cjs', oldHash: null, newHash: 'x', isNew: true, overrideClass: null }] }, 'v1', '2026-01-01T00:00:00.000Z', { centralBackupRoot: fakeHubPath });
  t('S8: takeBackup itself returns {ok:false, error} instead of throwing', backupResult.ok === false && typeof backupResult.error === 'string');
}

console.log('\n57) test pin: --force-all — sync-all refuses --force-overwrite without the explicit co-flag (previously ZERO test references; deleting the gate left 249/249 green)');
{
  const root57 = freshDir('t57-root');
  t('sync-all --force-overwrite WITHOUT --force-all exits 2 (usage error)', runCLI(['sync-all', root57, '--force-overwrite']).status === 2);
  t('sync-all --force-overwrite WITHOUT --force-all names --force-all in the usage message', /--force-all/.test(runCLI(['sync-all', root57, '--force-overwrite']).stderr));
  t('sync-all --force-overwrite WITH --force-all does NOT exit 2 (usage gate satisfied)', runCLI(['sync-all', root57, '--force-overwrite', '--force-all', '--dry-run']).status !== 2);
  t('sync-all --force-all alone (no --force-overwrite) is not a usage error either', runCLI(['sync-all', root57, '--force-all', '--dry-run']).status !== 2);
}

// =====================================================================================
// 58) M-B3 mutant kill (QA-reported SURVIVOR): fileStatus()'s TWO catch branches must each return
//     kind:'unreadable', NEVER kind:'missing' — (a) readFileSync throws on an existing regular file
//     (lstatSync succeeds), (b) lstatSync itself throws a non-ENOENT error. Section 25 only exercises the
//     st.isDirectory() branch and never reaches either catch block, which is exactly why M-B3 survived the
//     full suite with production code that was already correct. Both sub-tests PROBE the real OS first and
//     report which evidence source they actually used (REAL vs INJECTED), same honesty pattern as F2 (section 15).
// =====================================================================================
console.log('\n58) M-B3: fileStatus() catch branches -> kind:"unreadable" (never "missing"); preflight/safeSyncProject refuse end-to-end');
{
  // ---- 58a: readFileSync throws on an EXISTING regular file while lstatSync still succeeds ----
  {
    const tpl = freshDir('t58a-tpl');
    fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
    fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'NEW-CONTENT');
    const p = makeProject(freshDir('t58a-root'), 'proj', 0);
    fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
    const targetPath = path.join(p, '.claude', 'forge-bin', 'tool.cjs');
    fs.writeFileSync(targetPath, 'OLD-CONTENT');
    fakeReceiptMatchingCurrent(p, [['forge-bin/tool.cjs', sync.sha256(targetPath)]]);

    // real-OS probe (own scratch fixture, never the actual target): confirm chmodSync does NOT reproduce a
    // read failure on this OS (per addendum note — do not build the test on it), then confirm icacls does.
    const probeDir = freshDir('t58a-probe');
    const probeFile = path.join(probeDir, 'probe.txt');
    fs.writeFileSync(probeFile, 'x'); fs.chmodSync(probeFile, 0o444);
    let chmodBlocks = false;
    try { fs.readFileSync(probeFile); } catch { chmodBlocks = true; }
    fs.chmodSync(probeFile, 0o666);
    t('58a sanity: chmodSync 0o444 alone does NOT block reads on this OS (documented non-repro, not relied upon)', chmodBlocks === false);

    const user = (process.env.USERDOMAIN ? process.env.USERDOMAIN + '\\' : '') + (process.env.USERNAME || '');
    let realDenyWorks = false;
    if (process.env.USERNAME) {
      fs.writeFileSync(probeFile, 'x');
      const denyProbe = spawnSync('icacls', [probeFile, '/deny', user + ':(R)']);
      if (denyProbe.status === 0) {
        try { fs.readFileSync(probeFile); } catch (e) { if (e.code === 'EPERM') realDenyWorks = true; }
        spawnSync('icacls', [probeFile, '/remove:d', user]);
      }
    }

    const usedInjection = !realDenyWorks;
    if (realDenyWorks) {
      const deny = spawnSync('icacls', [targetPath, '/deny', user + ':(R)']);
      t('58a setup: icacls deny actually applied to the fixture file', deny.status === 0);
      try {
        const status = sync.fileStatus(targetPath);
        t('58a REAL EPERM: fileStatus reports kind:"unreadable" (never "missing")', status.kind === 'unreadable');
        const pf = sync.preflight(tpl, p);
        t('58a: preflight classifies it unreadable, NEVER toChange/new', pf.unreadable.some((u) => u.rel === 'forge-bin/tool.cjs') && !pf.toChange.some((e) => e.rel === 'forge-bin/tool.cjs'));
        const r = sync.safeSyncProject(tpl, p, { batchId: 'b58a', nowIso: '2026-01-01T00:00:00.000Z' });
        t('58a: safeSyncProject REFUSES the whole project (ok:false, refused:true) instead of overwriting it unbacked', r.ok === false && r.refused === true);
      } finally {
        spawnSync('icacls', [targetPath, '/remove:d', user]); // always release the deny ACL, even if an assertion above threw
      }
    } else {
      const origRead = fs.readFileSync;
      fs.readFileSync = function (fp, opts) {
        if (path.resolve(String(fp)) === path.resolve(targetPath)) { const e = new Error('EPERM: operation not permitted (injected)'); e.code = 'EPERM'; throw e; }
        return origRead.call(fs, fp, opts);
      };
      try {
        const status = sync.fileStatus(targetPath);
        t('58a INJECTED EPERM: fileStatus reports kind:"unreadable" (never "missing")', status.kind === 'unreadable');
        const pf = sync.preflight(tpl, p);
        t('58a: preflight classifies it unreadable, NEVER toChange/new', pf.unreadable.some((u) => u.rel === 'forge-bin/tool.cjs') && !pf.toChange.some((e) => e.rel === 'forge-bin/tool.cjs'));
        const r = sync.safeSyncProject(tpl, p, { batchId: 'b58a', nowIso: '2026-01-01T00:00:00.000Z' });
        t('58a: safeSyncProject REFUSES the whole project (ok:false, refused:true) instead of overwriting it unbacked', r.ok === false && r.refused === true);
      } finally {
        fs.readFileSync = origRead; // always restore the shared fs singleton before any other section runs
      }
    }
    console.log('     (58a evidence source: ' + (usedInjection ? 'INJECTED — OS icacls deny did not reproduce a real read-EPERM in this sandbox' : 'REAL OS EPERM via icacls') + ')');
    t('58a: the fixture file itself was never overwritten/deleted (still OLD-CONTENT, no unbacked write happened)', fs.existsSync(targetPath) && fs.readFileSync(targetPath, 'utf8') === 'OLD-CONTENT');
  }

  // ---- 58b: lstatSync itself throws a non-ENOENT error ----
  {
    const tpl2 = freshDir('t58b-tpl');
    fs.mkdirSync(path.join(tpl2, 'forge-bin'), { recursive: true });
    fs.writeFileSync(path.join(tpl2, 'forge-bin', 'tool.cjs'), 'NEW-CONTENT');
    const p2 = makeProject(freshDir('t58b-root'), 'proj', 0);

    // real-OS probe (own scratch fixture): a REGULAR FILE sitting where a DIRECTORY is expected mid-path makes
    // lstatSync throw a non-ENOENT error (e.g. ENOTDIR) on some OSes. Probe directly rather than assume — on
    // this Windows/Node combination it was independently confirmed to yield ENOENT instead, so this correctly
    // falls back to injection here; the same test would use the REAL branch on an OS where it yields ENOTDIR.
    const probeDir2 = freshDir('t58b-probe');
    const fileAsParent = path.join(probeDir2, 'forge-bin');
    fs.writeFileSync(fileAsParent, 'FILE-NOT-DIR');
    let probeCode = null;
    try { fs.lstatSync(path.join(fileAsParent, 'tool.cjs')); } catch (e) { probeCode = e.code; }
    const realNonEnoentLstatWorks = probeCode !== null && probeCode !== 'ENOENT';

    let targetPath2, origLstat = null;
    const usedInjection2 = !realNonEnoentLstatWorks;
    if (realNonEnoentLstatWorks) {
      fs.mkdirSync(path.join(p2, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(p2, '.claude', 'forge-bin'), 'FILE-NOT-DIR'); // forge-bin is a FILE, not a dir, here
      targetPath2 = path.join(p2, '.claude', 'forge-bin', 'tool.cjs');
    } else {
      fs.mkdirSync(path.join(p2, '.claude', 'forge-bin'), { recursive: true });
      targetPath2 = path.join(p2, '.claude', 'forge-bin', 'tool.cjs');
      fs.writeFileSync(targetPath2, 'OLD-CONTENT');
      origLstat = fs.lstatSync;
      fs.lstatSync = function (fp, opts) {
        if (path.resolve(String(fp)) === path.resolve(targetPath2)) { const e = new Error('EIO: injected non-ENOENT lstat error (test injection)'); e.code = 'EIO'; throw e; }
        return origLstat.call(fs, fp, opts);
      };
    }
    try {
      const status2 = sync.fileStatus(targetPath2);
      t('58b ' + (usedInjection2 ? 'INJECTED' : 'REAL OS') + ' non-ENOENT lstat error: fileStatus reports kind:"unreadable" (never "missing")', status2.kind === 'unreadable');
      const pf2 = sync.preflight(tpl2, p2);
      t('58b: preflight classifies it unreadable, NEVER toChange/new', pf2.unreadable.some((u) => u.rel === 'forge-bin/tool.cjs') && !pf2.toChange.some((e) => e.rel === 'forge-bin/tool.cjs'));
      const r2 = sync.safeSyncProject(tpl2, p2, { batchId: 'b58b', nowIso: '2026-01-01T00:00:00.000Z' });
      t('58b: safeSyncProject REFUSES the whole project (ok:false, refused:true) instead of overwriting it unbacked', r2.ok === false && r2.refused === true);
    } finally {
      if (origLstat) fs.lstatSync = origLstat; // always restore the shared fs singleton before any other section runs
    }
    console.log('     (58b evidence source: ' + (usedInjection2 ? 'INJECTED — this OS\'s file-as-parent-dir probe produced code=' + probeCode + ', not a genuine non-ENOENT error' : 'REAL OS non-ENOENT lstat error via file-as-parent-dir, code=' + probeCode) + ')');
    if (realNonEnoentLstatWorks) {
      t('58b: the "forge-bin"-as-file fixture was never overwritten/deleted', fs.existsSync(path.join(p2, '.claude', 'forge-bin')) && fs.readFileSync(path.join(p2, '.claude', 'forge-bin'), 'utf8') === 'FILE-NOT-DIR');
    } else {
      t('58b: the fixture file itself was never overwritten/deleted (still OLD-CONTENT, no unbacked write happened)', fs.existsSync(targetPath2) && fs.readFileSync(targetPath2, 'utf8') === 'OLD-CONTENT');
    }
  }
}

// =====================================================================================
// ADDENDUM G proof ("no global sync"): every fixture directory this suite EVER created (tracked live by
// freshDir(), not asserted after the fact) is actually rooted under os.tmpdir() — real, not just claimed.
// =====================================================================================
console.log('\nG) no-global-sync structural proof');
{
  const tmpRoot = path.resolve(os.tmpdir());
  t('every one of the ' + ALL_FIXTURE_ROOTS.length + ' fixture dirs created this run is under os.tmpdir()', ALL_FIXTURE_ROOTS.length > 0 && ALL_FIXTURE_ROOTS.every((d) => path.resolve(d).startsWith(tmpRoot)));
  t('the real project root (this repo) was never used as a fixture dir', !ALL_FIXTURE_ROOTS.some((d) => path.resolve(d) === path.resolve(__dirname, '..', '..')));
}

// 59) WP2 — the enforcer and the rules it enforces must ship TOGETHER. forge-doctor's agents check fails
// closed when agent-tool-policy.json is missing, and a red doctor is batch-stopping for sync. If the policy
// were left out of SYSTEM, every project would receive the checker without the rules and the first real
// rollout would wedge on its own safety gate. This pins the payload so that can never happen silently.
console.log('\n59) WP2 payload completeness (the checker never ships without its policy)');
{
  const tplDir = path.resolve(__dirname, '..');
  const files = sync.listSystemFiles(tplDir);
  t('agent-tool-policy.json is in the synced SYSTEM file list', files.includes('config/agents/agent-tool-policy.json'));
  t('the checker that reads it (forge-policy.cjs) is synced too', files.includes('forge-bin/forge-policy.cjs'));
  t('the validator that enforces it (forge-doctor.cjs) is synced too', files.includes('forge-bin/forge-doctor.cjs'));
  t('every agent .md the policy governs is synced too', files.filter((f) => f.startsWith('agents/') && f.endsWith('.md')).length >= 18);
}

// =====================================================================================
// 60) CLI sync-all --dry-run PRINTS the plan (regression: it computed the plan but printed nothing,
//     making the preview useless for authorising a real 12-project sync).
// =====================================================================================
console.log('\n60) sync-all --dry-run prints the per-project plan and writes nothing');
{
  const tpl = freshDir('t60-tpl');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'tool.cjs'), 'console.log("v1");\n');
  const root = freshDir('t60-root');
  const p = makeProject(root, 'projA', 0);
  makeRealProjectMarker(p);
  const before = snapshotTree(root);
  const r = runCLIWithTemplate(['sync-all', root, '--dry-run'], tpl);
  const after = snapshotTree(root);
  t('60a: sync-all --dry-run exits 0', r.status === 0);
  t('60b: it PRINTS the dry-run plan (not silent)', /DRY-RUN/.test(r.stdout || '') && /to-change/.test(r.stdout || ''));
  t('60c: it names the discovered project in the plan', (r.stdout || '').includes('projA'));
  t('60d: dry-run wrote nothing to the root tree', JSON.stringify(before) === JSON.stringify(after));
  t('60e: --json dry-run emits parseable JSON', (() => { const rj = runCLIWithTemplate(['sync-all', root, '--dry-run', '--json'], tpl); try { const o = JSON.parse(rj.stdout); return o.dryRun === true && Array.isArray(o.projects); } catch { return false; } })());
}

// =====================================================================================
// 61) MEDIUM FIX (adversarial break-swarm repro, 2026-07-15): regressionCheck used to EXEMPT any doctor
//     check the sync itself introduced (absent in the pre-sync doctor's checksOk) as "already red", because
//     `pre[k] === true && post[k] === false` can never be satisfied when pre[k] is undefined. A template
//     shipping a NEW forge-doctor.cjs with a brand-new, already-red check therefore sailed through as
//     alreadyRedSkipped even though nothing was ever green to compare it against. Fixed: `pre[k] ===
//     undefined` (a check the sync just introduced) now counts the same as a green->red flip. The legitimate
//     case — a check that existed in BOTH doctors and was ALREADY red for an unrelated, pre-existing reason —
//     remains correctly exempted (control case below).
// =====================================================================================
console.log('\n61) MEDIUM FIX: a NEW doctor-check the sync itself introduces must NOT be exempted as "already red"');
{
  const crypto61 = require('crypto');

  const oldDoctorSrc = [
    '#!/usr/bin/env node',
    'var a = process.argv.slice(2);',
    'if (a.indexOf("--json") !== -1) { console.log(JSON.stringify({ok:false,checks:{node_check:{ok:true,total:1,failed:0},tests:{ok:false,suites:1,passed:1,failed:1}}})); }',
    'process.exit(1);',
  ].join('\n');
  // the template's NEW doctor: same shape PLUS a brand-new, already-red check ("newcheck") — exactly the
  // repro from the adversarial break-swarm finding.
  const newDoctorSrcWithNewCheck = [
    '#!/usr/bin/env node',
    'var a = process.argv.slice(2);',
    'if (a.indexOf("--json") !== -1) { console.log(JSON.stringify({ok:false,checks:{node_check:{ok:true,total:1,failed:0},tests:{ok:false,suites:1,passed:1,failed:1},newcheck:{ok:false}}})); }',
    'process.exit(1);',
  ].join('\n');

  // ---- repro: NEW-and-red check introduced by this sync -> must be a real failure, never alreadyRedSkipped ----
  const tpl = freshDir('t61-tpl-repro');
  fs.mkdirSync(path.join(tpl, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'forge-bin', 'forge-doctor.cjs'), newDoctorSrcWithNewCheck, 'utf8');

  const root = freshDir('t61-root-repro');
  const p = makeProject(root, 'proj', null); // no auto-stub — this test controls the doctor content directly
  fs.mkdirSync(path.join(p, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'forge-bin', 'forge-doctor.cjs'), oldDoctorSrc, 'utf8');
  const oldDoctorHash = crypto61.createHash('sha256').update(fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'forge-doctor.cjs'))).digest('hex');
  // receipt says "the OLD doctor's current bytes ARE what I last wrote here" -> classifies as a clean
  // toChange (not unknown_drift), matching the repro's "receipt's knownHashes bevat de oude doctor-hash".
  fakeReceiptMatchingCurrent(p, [['forge-bin/forge-doctor.cjs', oldDoctorHash]]);

  const r = sync.safeSyncProject(tpl, p, { batchId: 'b61-repro', nowIso: '2026-07-15T00:00:00.000Z', centralBackupRoot: null });
  t('61a: NEW-and-red check introduced by the sync -> safeSyncProject ok:false (was silently ok:true, alreadyRedSkipped, before the fix)', r.ok === false);
  t('61b: rolled back', r.rolledBack === true);
  t('61c: NOT misreported as alreadyRedSkipped', !(r.outcome && r.outcome.alreadyRedSkipped));
  t('61d: regressionCheck itself flags "newcheck" as a regression', sync.regressionCheck(r.preValidation.summary, r.validation.summary).includes('newcheck'));
  t('61e: FORGE_VERSION.json was NEVER stamped (project must never claim the new template version)', !fs.existsSync(path.join(p, '.claude', 'FORGE_VERSION.json')));
  t('61f: the project doctor file is back to the OLD content (rolled back, not left mid-synced)', fs.readFileSync(path.join(p, '.claude', 'forge-bin', 'forge-doctor.cjs'), 'utf8') === oldDoctorSrc);

  // ---- control: a check that existed in BOTH doctors, already red for an unrelated reason -> still exempted ----
  const newDoctorSrcNoNewCheck = [
    '#!/usr/bin/env node',
    '// v2 bytes differ from oldDoctorSrc so this file is a real toChange, but the check SHAPE is identical',
    'var a = process.argv.slice(2);',
    'if (a.indexOf("--json") !== -1) { console.log(JSON.stringify({ok:false,checks:{node_check:{ok:true,total:1,failed:0},tests:{ok:false,suites:1,passed:1,failed:1}}})); }',
    'process.exit(1);',
  ].join('\n');
  const tpl2 = freshDir('t61-tpl-control');
  fs.mkdirSync(path.join(tpl2, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl2, 'forge-bin', 'forge-doctor.cjs'), newDoctorSrcNoNewCheck, 'utf8');

  const root2 = freshDir('t61-root-control');
  const p2 = makeProject(root2, 'proj', null);
  fs.mkdirSync(path.join(p2, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p2, '.claude', 'forge-bin', 'forge-doctor.cjs'), oldDoctorSrc, 'utf8');
  const oldDoctorHash2 = crypto61.createHash('sha256').update(fs.readFileSync(path.join(p2, '.claude', 'forge-bin', 'forge-doctor.cjs'))).digest('hex');
  fakeReceiptMatchingCurrent(p2, [['forge-bin/forge-doctor.cjs', oldDoctorHash2]]);

  const r2 = sync.safeSyncProject(tpl2, p2, { batchId: 'b61-control', nowIso: '2026-07-15T00:00:00.000Z', centralBackupRoot: null });
  t('61g CONTROL: no new check introduced, same check already red both times -> still ok:true (NOT regressed by this fix)', r2.ok === true);
  t('61h CONTROL: correctly reported alreadyRedSkipped', !!(r2.outcome && r2.outcome.alreadyRedSkipped));
  t('61i CONTROL: FORGE_VERSION.json WAS stamped (legitimate sync completed, not blocked)', fs.existsSync(path.join(p2, '.claude', 'FORGE_VERSION.json')));
}

// =====================================================================================
// 62) MEDIUM FIX (2026-07-15, forge-2026-07-15-testloop ROUND 2): regressionCheck (and
//     decideValidationOutcome) must ALSO flag a check that existed and was GREEN pre-sync but is entirely
//     ABSENT post-sync — round 1's fix (section 61) only ever iterated Object.keys(post), so a vanished
//     check could never be seen at all (it never appears in `post`). "A sync that removes a check passes"
//     was the exact bug: a new doctor that silently drops a previously-green check still self-reports a
//     naive ok:true (nothing IT still checks is red), so decideValidationOutcome also needed a second gate
//     on the naive-ok:true path, not just the already-red evidence-backed-fail path section 61 covers.
// =====================================================================================
console.log('\n62) MEDIUM FIX ROUND 2: regressionCheck flags a previously-green check that VANISHED post-sync');
{
  const crypto62 = require('crypto');

  // direct unit coverage exactly as specified: pre {a:true} + post {} (a verdwenen) -> regressie
  const preDirect = { ok: true, checksOk: { a: { ok: true }, node_check: { ok: true } } };
  const postDirect = { ok: true, checksOk: { node_check: { ok: true } } }; // 'a' vanished
  const regressedDirect = sync.regressionCheck(preDirect, postDirect);
  t('62a: regressionCheck flags a vanished-but-was-green check ("a")', regressedDirect.includes('a'));

  // full control matrix from the spec — all pre-existing cases stay correct
  t('62b CONTROL: pre red + post red (same key) -> NOT a regression (already-red)', sync.regressionCheck(
    { ok: false, checksOk: { a: { ok: false } } }, { ok: false, checksOk: { a: { ok: false } } },
  ).length === 0);
  t('62c CONTROL: pre absent + post red -> IS a regression (round-1 behavior preserved)', sync.regressionCheck(
    { ok: true, checksOk: {} }, { ok: false, checksOk: { a: { ok: false } } },
  ).includes('a'));
  t('62d CONTROL: pre red + post absent -> improvement, NOT a regression', sync.regressionCheck(
    { ok: false, checksOk: { a: { ok: false } } }, { ok: true, checksOk: {} },
  ).length === 0);
  t('62e CONTROL: pre red + post green -> improvement, NOT a regression', sync.regressionCheck(
    { ok: false, checksOk: { a: { ok: false } } }, { ok: true, checksOk: { a: { ok: true } } },
  ).length === 0);

  // end-to-end repro: a sync's OWN new doctor silently drops a previously-green check ("special_check") but
  // otherwise reports ok:true (nothing it still checks is red) -> must NOT be waved through as a naive pass.
  const oldDoctorSrc62 = [
    '#!/usr/bin/env node',
    'var a = process.argv.slice(2);',
    'if (a.indexOf("--json") !== -1) { console.log(JSON.stringify({ok:true,checks:{node_check:{ok:true,total:1,failed:0},tests:{ok:true,suites:1,passed:1,failed:0},special_check:{ok:true}}})); }',
    'process.exit(0);',
  ].join('\n');
  const newDoctorSrc62VanishedCheck = [
    '#!/usr/bin/env node',
    'var a = process.argv.slice(2);',
    'if (a.indexOf("--json") !== -1) { console.log(JSON.stringify({ok:true,checks:{node_check:{ok:true,total:1,failed:0},tests:{ok:true,suites:1,passed:1,failed:0}}})); }',
    'process.exit(0);',
  ].join('\n');

  const tpl62 = freshDir('t62-tpl-repro');
  fs.mkdirSync(path.join(tpl62, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl62, 'forge-bin', 'forge-doctor.cjs'), newDoctorSrc62VanishedCheck, 'utf8');

  const root62 = freshDir('t62-root-repro');
  const p62 = makeProject(root62, 'proj', null);
  fs.mkdirSync(path.join(p62, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p62, '.claude', 'forge-bin', 'forge-doctor.cjs'), oldDoctorSrc62, 'utf8');
  const oldDoctorHash62 = crypto62.createHash('sha256').update(fs.readFileSync(path.join(p62, '.claude', 'forge-bin', 'forge-doctor.cjs'))).digest('hex');
  fakeReceiptMatchingCurrent(p62, [['forge-bin/forge-doctor.cjs', oldDoctorHash62]]);

  const r62 = sync.safeSyncProject(tpl62, p62, { batchId: 'b62-repro', nowIso: '2026-07-15T00:00:00.000Z', centralBackupRoot: null });
  t('62f: a sync whose own new doctor silently drops a previously-green check -> safeSyncProject ok:false (was silently ok:true before this fix)', r62.ok === false);
  t('62g: rolled back', r62.rolledBack === true);
  t('62h: outcome reason names the vanished check', !!(r62.outcome && /special_check/.test(r62.outcome.reason || '')));
  t('62i: FORGE_VERSION.json was NEVER stamped (project must never claim the new template version)', !fs.existsSync(path.join(p62, '.claude', 'FORGE_VERSION.json')));
  t('62j: the project doctor file is back to the OLD content (rolled back, not left mid-synced)', fs.readFileSync(path.join(p62, '.claude', 'forge-bin', 'forge-doctor.cjs'), 'utf8') === oldDoctorSrc62);

  // control: identical check shape on both sides (nothing vanished) -> sync still succeeds normally, proving
  // this fix does NOT introduce a false positive on an ordinary clean sync.
  const newDoctorSrc62Identical = [
    '#!/usr/bin/env node',
    '// v2 bytes differ so this is a real toChange, but the check SHAPE is identical to oldDoctorSrc62',
    'var a = process.argv.slice(2);',
    'if (a.indexOf("--json") !== -1) { console.log(JSON.stringify({ok:true,checks:{node_check:{ok:true,total:1,failed:0},tests:{ok:true,suites:1,passed:1,failed:0},special_check:{ok:true}}})); }',
    'process.exit(0);',
  ].join('\n');
  const tpl62b = freshDir('t62-tpl-control');
  fs.mkdirSync(path.join(tpl62b, 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(tpl62b, 'forge-bin', 'forge-doctor.cjs'), newDoctorSrc62Identical, 'utf8');

  const root62b = freshDir('t62-root-control');
  const p62b = makeProject(root62b, 'proj', null);
  fs.mkdirSync(path.join(p62b, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(p62b, '.claude', 'forge-bin', 'forge-doctor.cjs'), oldDoctorSrc62, 'utf8');
  const oldDoctorHash62b = crypto62.createHash('sha256').update(fs.readFileSync(path.join(p62b, '.claude', 'forge-bin', 'forge-doctor.cjs'))).digest('hex');
  fakeReceiptMatchingCurrent(p62b, [['forge-bin/forge-doctor.cjs', oldDoctorHash62b]]);

  const r62b = sync.safeSyncProject(tpl62b, p62b, { batchId: 'b62-control', nowIso: '2026-07-15T00:00:00.000Z', centralBackupRoot: null });
  t('62k CONTROL: no check vanished (identical check shape both times) -> sync still ok:true (NOT a false positive from this fix)', r62b.ok === true);
  t('62l CONTROL: FORGE_VERSION.json WAS stamped (legitimate sync completed, not blocked)', fs.existsSync(path.join(p62b, '.claude', 'FORGE_VERSION.json')));
}

// =====================================================================================
// 63) WP4 FIX (2026-07-26): the dedicated canary was aborting stage 0 on EVERY sync-all run, regardless of
//     template health. Real repro (see forge-sync.cjs's own 2026-07-26 header note): one genuine, non-
//     fabricated doctor test has a real precondition of "at least one real run with events.jsonl exists in
//     this project" — true for every actual Forge project, structurally impossible for a canary that is
//     wiped and recreated empty on every single canary-init/sync-all run. seedCanaryRun (canary-only, opt-in
//     via opts.seedRunForValidation) logs one honest run_started event into the canary's own just-synced
//     forge-runs/ before validation runs. This section proves: (a) the mechanism itself, (b) the exact bug
//     reproduces without the fix, (c) the fix resolves it, (d) the gate still bites a genuinely broken
//     template even with the fix active, (e) end-to-end via runSyncAll's real stage-0 flow, and (f) real
//     (non-canary) projects are completely unaffected — the same doctor requirement still fails them exactly
//     as before, since they never receive opts.seedRunForValidation.
// =====================================================================================
console.log('\n63) WP4 FIX: dedicated canary seeds one real run before validation (forge-capabilities-panel-class precondition)');
{
  // 63a: no forge-dashboard/log-event.cjs synced at all -> clean, silent no-op (never crashes, never fabricates)
  const p63a = makeProject(freshDir('t63a-root'), 'proj', null);
  const r63a = sync.seedCanaryRun(p63a, 'b63a', '2026-01-01T00:00:00.000Z');
  t('63a: ok:false, skipped:true when the project has no log-event.cjs', r63a.ok === false && r63a.skipped === true);
  t('63a: no forge-runs dir was fabricated', !fs.existsSync(path.join(p63a, '.claude', 'forge-runs')));

  // 63b: a real (stubbed but contract-faithful) log-event.cjs present -> seedCanaryRun writes ONE honest,
  // real run_started event through it (never a hand-crafted events.jsonl line bypassing the tool itself).
  const p63b = makeProject(freshDir('t63b-root'), 'proj', null);
  writeStubLogEvent(path.join(p63b, '.claude', 'forge-dashboard'));
  const r63b = sync.seedCanaryRun(p63b, 'b63b', '2026-01-01T00:00:00.000Z');
  t('63b: seedCanaryRun reports ok:true', r63b.ok === true);
  t('63b: exitCode 0 (log-event.cjs accepted the event)', r63b.exitCode === 0);
  t('63b: runId is derived from batchId and sanitized to the allowed run_id charset', /^canary-init-b63b$/.test(r63b.runId));
  const runsDir63b = path.join(p63b, '.claude', 'forge-runs');
  const realRunIds63b = fs.existsSync(runsDir63b)
    ? fs.readdirSync(runsDir63b, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(runsDir63b, e.name, 'events.jsonl'))).map((e) => e.name)
    : [];
  t('63b: a real run directory with a real events.jsonl now exists, matching the returned runId', realRunIds63b.length === 1 && realRunIds63b[0] === r63b.runId);
  const ev63b = JSON.parse(fs.readFileSync(path.join(runsDir63b, r63b.runId, 'events.jsonl'), 'utf8').trim());
  t('63b: the logged event is a real, honest run_started event (never a fabricated pass-claiming type)', ev63b.event_type === 'run_started' && ev63b.run_id === r63b.runId && ev63b.canary === true);

  // 63c: REPRO — a canary-shaped fresh project (no prior forge-runs/ at all), synced WITHOUT
  // opts.seedRunForValidation (mirrors the pre-fix code path / a real project's own syncOpts), against a
  // doctor that has forge-capabilities-panel.test.cjs's exact real precondition -> validation genuinely
  // fails, exactly matching the observed real-world "DEDICATED CANARY FAILED" symptom.
  const tpl63 = freshDir('t63-tpl');
  writeRequiresRealRunDoctor(path.join(tpl63, 'forge-bin'));
  writeStubLogEvent(path.join(tpl63, 'forge-dashboard'));
  const root63c = freshDir('t63c-root');
  const p63c = makeProject(root63c, 'proj', null);
  const r63c = sync.safeSyncProject(tpl63, p63c, { batchId: 'b63c', nowIso: '2026-01-01T00:00:00.000Z', allowDegraded: true });
  t('63c REPRO: without seedRunForValidation, a fresh project with this real precondition doctor FAILS validation (the exact pre-fix bug)', r63c.ok === false);
  t('63c REPRO: rolled back cleanly (no half-applied canary left behind)', r63c.rolledBack === true);
  t('63c REPRO: no run was ever seeded (forge-runs stays absent — proves the failure is genuinely the missing precondition, not something else)', !fs.existsSync(path.join(p63c, '.claude', 'forge-runs')));

  // 63d: FIX — the exact SAME setup, but WITH opts.seedRunForValidation:true (mirrors canarySyncOpts) -> the
  // precondition is now honestly satisfied and validation PASSES unconditionally (not merely "exempted as
  // pre-existing" — a real, evidence-backed green).
  const root63d = freshDir('t63d-root');
  const p63d = makeProject(root63d, 'proj', null);
  const r63d = sync.safeSyncProject(tpl63, p63d, { batchId: 'b63d', nowIso: '2026-01-01T00:00:00.000Z', allowDegraded: true, seedRunForValidation: true });
  t('63d FIX: WITH seedRunForValidation, the same doctor now PASSES validation', r63d.ok === true);
  t('63d FIX: canarySeed reports ok:true', !!(r63d.canarySeed && r63d.canarySeed.ok === true));
  t('63d FIX: validation.ok is a genuine, unconditional pass (not an alreadyRedSkipped exemption)', r63d.validation.ok === true && !r63d.outcome.alreadyRedSkipped);
  t('63d FIX: FORGE_VERSION.json was stamped (the project is genuinely considered synced)', fs.existsSync(sync.versionFilePath(p63d)));

  // 63e: GATE STILL BITES — WITH seedRunForValidation:true, a template that is ALSO genuinely broken for an
  // unrelated reason (node_check hard-fails) still FAILS. Seeding a run must never become a blanket bypass.
  const tpl63e = freshDir('t63e-tpl-broken');
  writeRequiresRealRunDoctor(path.join(tpl63e, 'forge-bin'), { alsoBreakNodeCheck: true });
  writeStubLogEvent(path.join(tpl63e, 'forge-dashboard'));
  const root63e = freshDir('t63e-root');
  const p63e = makeProject(root63e, 'proj', null);
  const r63e = sync.safeSyncProject(tpl63e, p63e, { batchId: 'b63e', nowIso: '2026-01-01T00:00:00.000Z', allowDegraded: true, seedRunForValidation: true });
  t('63e GATE STILL BITES: a genuinely broken template (unrelated node_check failure) still FAILS even with the run seeded', r63e.ok === false);
  t('63e GATE STILL BITES: rolled back cleanly', r63e.rolledBack === true);
  t('63e GATE STILL BITES: the run WAS seeded (proves this is a real regression, not the precondition gap)', !!(r63e.canarySeed && r63e.canarySeed.ok === true));

  // 63f: END-TO-END via runSyncAll's REAL stage-0 (dedicated canary) flow — projects:[] so only stage 0 runs
  // (no real project touched), proving the fix works through the actual production call path, not just
  // safeSyncProject in isolation.
  const root63f = freshDir('t63f-root');
  const r63f = sync.runSyncAll(tpl63, root63f, { projects: [], batchId: 'b63f', nowIso: '2026-01-01T00:00:00.000Z' });
  t('63f END-TO-END: overall batch ok:true (stage 0 no longer aborts)', r63f.ok === true);
  t('63f END-TO-END: dedicated canary itself is ok:true', r63f.dedicatedCanary.ok === true);
  t('63f END-TO-END: dedicated canary carries a successful canarySeed', !!(r63f.dedicatedCanary.canarySeed && r63f.dedicatedCanary.canarySeed.ok === true));
  t('63f END-TO-END: dedicated canary validation.ok is true', r63f.dedicatedCanary.validation.ok === true);

  // 63g: REGRESSION SAFETY — a REAL (non-canary) project, synced through runSyncAll's own representative
  // stage (plain syncOpts, no seedRunForValidation), is completely unaffected by this fix: the exact same
  // "requires a real run" doctor still fails it exactly as it always would have, proving the seed is
  // canary-exclusive and real projects' forge-runs/ history is never touched by this tool.
  const root63g = freshDir('t63g-root');
  const rep63g = makeProject(root63g, 'rep', null);
  makeRealProjectMarker(rep63g);
  const r63g = sync.runSyncAll(tpl63, root63g, { projects: [rep63g], batchId: 'b63g', nowIso: '2026-01-01T00:00:00.000Z' });
  t('63g REGRESSION SAFETY: dedicated canary still passes (seeded)', r63g.dedicatedCanary.ok === true);
  t('63g REGRESSION SAFETY: batch aborts at the REPRESENTATIVE stage (real project never seeded, doctor genuinely fails it)', r63g.ok === false && r63g.aborted === true && r63g.stage === 'representative');
  t('63g REGRESSION SAFETY: the representative result itself is not ok', r63g.projects.length === 1 && r63g.projects[0].ok === false);
  t('63g REGRESSION SAFETY: the real project never had a run seeded into it', !fs.existsSync(path.join(rep63g, '.claude', 'forge-runs')));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
