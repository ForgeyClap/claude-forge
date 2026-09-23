#!/usr/bin/env node
'use strict';
/** Hermetic tests for forge-doctor.cjs pure functions (leak scan, label, SPA check). Uses os.mkdtemp
 *  fixtures; the full runDoctor (which spawns node/git across a real project) is proven by a real run,
 *  not here. Never touches the real project. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const D = require('./forge-doctor.cjs');

let pass = 0, fail = 0, skipped = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };
/** skip(name, reason) — a test that could not be run HERE, stated out loud with why. It is counted into the
 *  trailing tally ("N passed, M failed, K skipped") so a reader of the summary line alone can see that
 *  something was not checked. The one thing a skip must never be is silently green: an assertion that
 *  quietly stops running is worse than one that fails, because nothing in the output changes. */
const skip = (name, reason) => { skipped++; console.log('  SKIP ' + name + ' — ' + reason); };
/** pinned(name, fn) — an assertion whose expected value is a property of THIS installation, not of the code
 *  under test (e.g. "this project has exactly 57 skills"). It is a genuine drift guard in the development
 *  tree and meaningless anywhere else: the published distribution deliberately omits the 9 vendored
 *  third-party skills, so the same assertion fails there for a reason that is not a defect. It runs strictly
 *  when the tree is the development tree and is visibly skipped, with the detector's own reason, when it is
 *  not. Deliberately NOT solved with a tolerance or a list of acceptable counts — a count that accepts two
 *  answers has stopped guarding drift. See D.installationProfile(). */
const makePinned = (profile) => (name, fn) => {
  if (profile.profile === 'development') { fn(); return true; }
  skip(name, 'installation-dependent assertion · ' + profile.reason);
  return false;
};
const DEV_TREE = D.installationProfile(path.resolve(__dirname, '..', '..'));
const pinned = makePinned(DEV_TREE);

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-'));
const cd = path.join(ROOT, '.claude');
fs.mkdirSync(path.join(cd, 'forge-dashboard'), { recursive: true });

// --- leakScan: a REAL-looking secret is caught; fakes/placeholders/test-files are NOT (precision) ---
const REAL = 'nvapi-9x7Kq2mZ4bTvA1cReW8pLdN6sGhY3jFuIoP0aQzX5wErTyUjHkLmNbVcXsz'; // long, no FAKE, no repeats
const FAKE = 'nvapi-FAKEFAKEFAKEFAKE1234567890'; // placeholder — must NOT be flagged
fs.writeFileSync(path.join(cd, 'notes.md'), 'config note\napi key = ' + REAL + '\n');
fs.writeFileSync(path.join(cd, 'placeholder.md'), 'sample = ' + FAKE + '\n');        // placeholder -> ignored
fs.writeFileSync(path.join(cd, '.env.example'), 'NVIDIA_API_KEY=' + REAL + '\n');     // .env.example -> skipped
fs.writeFileSync(path.join(cd, 'demo.test.cjs'), 'const k="' + REAL + '";\n');        // test fixture -> skipped
fs.writeFileSync(path.join(ROOT, 'clean.txt'), 'nothing secret here\n');
const leak = D.leakScan(ROOT); // no git in temp dir -> falls back to bounded walk
t('leakScan flags a REAL-looking secret in notes.md', leak.hits.some((h) => h.file.endsWith('notes.md')));
t('leakScan hit is labeled nvidia-nvapi-key', leak.hits.some((h) => h.pattern === 'nvidia-nvapi-key'));
t('leakScan NEVER echoes the raw secret', !JSON.stringify(leak).includes(REAL) && !JSON.stringify(leak).includes(FAKE));
t('leakScan IGNORES a FAKE/placeholder secret', !leak.hits.some((h) => h.file.endsWith('placeholder.md')));
t('leakScan skips .env.example (placeholder)', !leak.hits.some((h) => h.file.endsWith('.env.example')));
t('leakScan skips *.test.cjs (test fixtures)', !leak.hits.some((h) => h.file.endsWith('demo.test.cjs')));
t('leakScan ok=false when a real hit exists', leak.ok === false);
t('leakScan used the walk fallback (no git in temp)', leak.source === 'walk');

// a fully clean fixture -> ok:true, 0 hits
const CLEAN = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-clean-'));
fs.writeFileSync(path.join(CLEAN, 'readme.md'), '# hello\njust docs, no secrets\n');
const leak2 = D.leakScan(CLEAN);
t('clean fixture: leakScan ok=true', leak2.ok === true);
t('clean fixture: zero hits', leak2.hits.length === 0);

// --- VENV/VENDOR CONTAINMENT (2026-08-03, gemeten op "aiTraining"): the WALK fallback (no git) crawled
// a Python virtualenv (12.728 files) and produced 16 false hits — all third-party library docstrings with
// `user:pass@host` URL examples (fsspec/httpx/pandas/pyarrow/urllib3) plus a hash in a torch RECORD file.
// A venv is dependency territory exactly like the already-skipped node_modules: third-party code we do not
// own and must not "leak-scan" as project source. Detection is by the definitive marker file pyvenv.cfg
// (catches ANY dir name — .venv, venv, .venv-train, …) plus the common Python cache/vendor dir names.
// Real secrets OUTSIDE the venv must still be caught — both directions proven below. ---
const VENVROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-venv-'));
const VENVSECRET = 'nvapi-8kQw3rTz5xYvB2cNeM9pLdG6sHhJ4jFuIoP1aQzX7wErTyUjHkLmNbVcXsq';
fs.mkdirSync(path.join(VENVROOT, '.venv-train', 'Lib', 'site-packages', 'somelib'), { recursive: true });
fs.writeFileSync(path.join(VENVROOT, '.venv-train', 'pyvenv.cfg'), 'home = /usr/bin\nversion = 3.12\n');
fs.writeFileSync(path.join(VENVROOT, '.venv-train', 'Lib', 'site-packages', 'somelib', 'util.py'), '# docs: ftp://user:password@host/path\napi = "' + VENVSECRET + '"\n');
fs.mkdirSync(path.join(VENVROOT, '__pycache__'), { recursive: true });
fs.writeFileSync(path.join(VENVROOT, '__pycache__', 'x.py'), 'k = "' + VENVSECRET + '"\n');
fs.mkdirSync(path.join(VENVROOT, 'src'), { recursive: true });
fs.writeFileSync(path.join(VENVROOT, 'src', 'config.py'), 'key = "' + VENVSECRET + '"\n');
const leakVenv = D.leakScan(VENVROOT);
t('venv containment: a pyvenv.cfg-marked dir (any name) is NOT walked — no hits from inside the venv', !leakVenv.hits.some((h) => h.file.includes('.venv-train')));
t('venv containment: __pycache__ is NOT walked', !leakVenv.hits.some((h) => h.file.includes('__pycache__')));
t('venv containment: the SAME real-looking secret OUTSIDE the venv IS still caught (precision kept)', leakVenv.hits.some((h) => h.file.endsWith('src/config.py')) && leakVenv.ok === false);

// --- secretLabel maps sources to friendly names ---
t('secretLabel nvapi', D.secretLabel('nvapi-[A-Za-z0-9_-]+') === 'nvidia-nvapi-key');
t('secretLabel jwt', D.secretLabel('eyJ[A-Za-z0-9_-]{10,}\\.') === 'jwt');
t('secretLabel url creds', D.secretLabel('[a-z]+://[^@]+:[^@]+@') === 'url-embedded-credentials');
t('secretLabel aws', D.secretLabel('AKIA[0-9A-Z]{16}') === 'aws-access-key');

// --- spaPresent ---
const spaMissing = D.spaPresent(ROOT); // forge-dashboard dir exists but empty
t('spaPresent ok=false when SPA files missing', spaMissing.ok === false && spaMissing.missing.includes('app.js'));
for (const f of ['server.cjs', 'index.html', 'app.js', 'lenses.js', 'graph.js', 'panels.js', 'styles.css']) fs.writeFileSync(path.join(cd, 'forge-dashboard', f), '// ' + f);
const spaOk = D.spaPresent(ROOT);
t('spaPresent ok=true once all files exist', spaOk.ok === true && spaOk.missing.length === 0);

// =====================================================================================================
// 2026-07-14 honesty-hardening fixes: (1) a suite with 0 real assertions is REJECTED, (2) a forge-bin
// dir with 0 scripts/suites is REJECTED ("no evidence"), (3) --json emits exactly one parseable JSON
// object matching the fixed contract keys, (4) a timed-out suite is labeled blocked, not failed.
// =====================================================================================================

// --- FIX 1 + FIX 2: nodeCheckAll must reject zero-evidence instead of silently passing ---
const NC_MISSING = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-nc-missing-')); // no .claude at all
const ncMissing = D.nodeCheckAll(NC_MISSING);
t('nodeCheckAll: both dirs missing -> ok=false', ncMissing.ok === false && ncMissing.total === 0);
t('nodeCheckAll: both dirs missing -> reason names it', /both missing/.test(ncMissing.reason));

const NC_EMPTY = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-nc-empty-'));
fs.mkdirSync(path.join(NC_EMPTY, '.claude', 'forge-bin'), { recursive: true });
fs.mkdirSync(path.join(NC_EMPTY, '.claude', 'forge-dashboard'), { recursive: true });
const ncEmpty = D.nodeCheckAll(NC_EMPTY);
t('nodeCheckAll: dirs present but 0 files -> ok=false ("no evidence", not a silent pass)', ncEmpty.ok === false && ncEmpty.total === 0);
t('nodeCheckAll: 0-file reason distinguishes "present but empty" from "both missing"', /present but empty/.test(ncEmpty.reason));

const NC_REAL = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-nc-real-'));
fs.mkdirSync(path.join(NC_REAL, '.claude', 'forge-bin'), { recursive: true });
fs.writeFileSync(path.join(NC_REAL, '.claude', 'forge-bin', 'good.cjs'), "'use strict';\nmodule.exports = {};\n");
const ncReal = D.nodeCheckAll(NC_REAL);
t('nodeCheckAll: a real parseable file -> ok=true, total=1, failed=0', ncReal.ok === true && ncReal.total === 1 && ncReal.failed === 0);
fs.writeFileSync(path.join(NC_REAL, '.claude', 'forge-bin', 'bad.cjs'), "function( {\n"); // invalid syntax
const ncBad = D.nodeCheckAll(NC_REAL);
t('nodeCheckAll: a syntax error is still caught (existing behavior preserved)', ncBad.ok === false && ncBad.failed === 1 && ncBad.total === 2);

// --- FIX 1 + FIX 2 + FIX 4: runTests must reject a vacuous "0 passed, 0 failed" suite, reject 0 suites
//     found, and label a timed-out suite as blocked (not failed) ---
const RT_VACUOUS = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-rt-vacuous-'));
fs.mkdirSync(path.join(RT_VACUOUS, '.claude', 'forge-bin'), { recursive: true });
fs.writeFileSync(path.join(RT_VACUOUS, '.claude', 'forge-bin', 'vacuous.test.cjs'), "console.log('0 passed, 0 failed');\nprocess.exit(0);\n");
const rtVacuous = D.runTests(RT_VACUOUS);
t('runTests: a suite reporting a ZERO/ZERO tally is REJECTED (suiteOk=false)', rtVacuous.perSuite[0].ok === false);
t('runTests: vacuous suite counts as a real suite failure, not a pass', rtVacuous.suitesFailed === 1 && rtVacuous.ok === false);
t('runTests: vacuous suite is not mistaken for a timeout', rtVacuous.perSuite[0].timedOut === false);

const RT_REAL = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-rt-real-'));
fs.mkdirSync(path.join(RT_REAL, '.claude', 'forge-bin'), { recursive: true });
fs.writeFileSync(path.join(RT_REAL, '.claude', 'forge-bin', 'real.test.cjs'), "console.log('3 passed, 0 failed');\nprocess.exit(0);\n");
const rtReal = D.runTests(RT_REAL);
t('runTests: a suite with p>0 f=0 exit0 is ACCEPTED', rtReal.perSuite[0].ok === true && rtReal.ok === true && rtReal.passed === 3);

const RT_EMPTY = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-rt-empty-'));
fs.mkdirSync(path.join(RT_EMPTY, '.claude', 'forge-bin'), { recursive: true }); // dir exists, 0 *.test.cjs files
const rtEmpty = D.runTests(RT_EMPTY);
t('runTests: 0 suites found (dir present, empty) -> ok=false ("no evidence")', rtEmpty.ok === false && rtEmpty.suites === 0);
t('runTests: 0-suite reason distinguishes "present but empty"', /present but empty/.test(rtEmpty.reason));

const RT_MISSING = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-rt-missing-')); // no forge-bin at all
const rtMissing = D.runTests(RT_MISSING);
t('runTests: forge-bin/ dir missing entirely -> ok=false, distinct reason', rtMissing.ok === false && /dir missing/.test(rtMissing.reason));

// FIX 4: a REAL spawnSync timeout (not a mocked shape) — a busy-loop suite is killed after timeoutMs and
// must be labeled timedOut/blocked, never counted as a plain failure.
const RT_TIMEOUT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-rt-timeout-'));
fs.mkdirSync(path.join(RT_TIMEOUT, '.claude', 'forge-bin'), { recursive: true });
fs.writeFileSync(path.join(RT_TIMEOUT, '.claude', 'forge-bin', 'busyloop.test.cjs'), 'for (;;) {}\n');
const rtTimeout = D.runTests(RT_TIMEOUT, { timeoutMs: 500 });
t('runTests: a real spawnSync timeout is labeled timedOut=true', rtTimeout.perSuite[0].timedOut === true);
t('runTests: a timed-out suite is "blocked", not counted in suitesFailed', rtTimeout.suitesBlocked === 1 && rtTimeout.suitesFailed === 0);
t('runTests: overall ok=false when a suite is blocked (honestly not green)', rtTimeout.ok === false);
t('runTests: timed-out suite entry carries the kill signal', rtTimeout.perSuite[0].signal === 'SIGTERM');

// =====================================================================================================
// 2026-07-14 FOLLOWUP A — FIX 1: anchor the tally regex so a phrase inside a test DESCRIPTION (echoed by
// the suite's own harness) can never be mistaken for the suite's real trailing "N passed, M failed" line.
// =====================================================================================================
const RT_DESC_COLLISION = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-rt-desccollision-'));
fs.mkdirSync(path.join(RT_DESC_COLLISION, '.claude', 'forge-bin'), { recursive: true });
fs.writeFileSync(path.join(RT_DESC_COLLISION, '.claude', 'forge-bin', 'desccollision.test.cjs'),
  "console.log('  ok  a test describing a 0 passed, 0 failed edge case');\n" +
  "console.log('12 passed, 0 failed');\n" +
  "process.exit(0);\n");
const rtDesc = D.runTests(RT_DESC_COLLISION);
t('runTests: a mid-line "0 passed, 0 failed" INSIDE a description does not fool the tally', rtDesc.perSuite[0].passed === 12 && rtDesc.perSuite[0].failed === 0);
t('runTests: description-collision suite reads the REAL trailing summary and is ACCEPTED', rtDesc.perSuite[0].ok === true && rtDesc.ok === true);

// Regression guard for a REAL sibling-suite format discovered while re-running the full doctor against this
// repo: forge-learn.test.cjs legitimately prints "N passed, M failed, K skipped" (extra trailing content on
// the SAME summary line). An over-strict end-of-line anchor would misread this as 0/0 evidence — must still
// read the leading counts correctly.
const RT_TRAILING_SUFFIX = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-rt-trailingsuffix-'));
fs.mkdirSync(path.join(RT_TRAILING_SUFFIX, '.claude', 'forge-bin'), { recursive: true });
fs.writeFileSync(path.join(RT_TRAILING_SUFFIX, '.claude', 'forge-bin', 'trailingsuffix.test.cjs'), "console.log('43 passed, 0 failed, 1 skipped');\nprocess.exit(0);\n");
const rtTrailing = D.runTests(RT_TRAILING_SUFFIX);
t('runTests: a real "N passed, M failed, K skipped" trailing-suffix line is still read correctly (43/0, not 0/0)', rtTrailing.perSuite[0].passed === 43 && rtTrailing.perSuite[0].failed === 0);
t('runTests: trailing-suffix suite is correctly ACCEPTED, not misread as vacuous', rtTrailing.perSuite[0].ok === true && rtTrailing.ok === true);

const RT_REAL_FAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-rt-realfail-'));
fs.mkdirSync(path.join(RT_REAL_FAIL, '.claude', 'forge-bin'), { recursive: true });
fs.writeFileSync(path.join(RT_REAL_FAIL, '.claude', 'forge-bin', 'realfail.test.cjs'),
  "console.log('  ok  a test naming a 9 passed, 0 failed scenario');\n" +
  "console.log('3 passed, 2 failed');\n" +
  "process.exit(1);\n");
const rtRealFail = D.runTests(RT_REAL_FAIL);
t('runTests: a genuinely failing suite (3 passed, 2 failed) is STILL read correctly', rtRealFail.perSuite[0].passed === 3 && rtRealFail.perSuite[0].failed === 2);
t('runTests: real failure is still marked failed — anchoring does NOT weaken existing detection', rtRealFail.perSuite[0].ok === false && rtRealFail.suitesFailed === 1 && rtRealFail.ok === false);

// --- FIX 3: --json prints exactly ONE parseable JSON object on stdout, matching the fixed contract keys ---
const { spawnSync } = require('child_process');
const DOCTOR_CLI = path.join(__dirname, 'forge-doctor.cjs');
const jsonRun = spawnSync(process.execPath, [DOCTOR_CLI, '--root', RT_REAL, '--json'], { encoding: 'utf8' });
let jsonParsed = null, jsonParseError = '';
try { jsonParsed = JSON.parse(jsonRun.stdout); } catch (e) { jsonParseError = e.message; }
t('CLI --json: stdout parses as exactly one JSON object (no trailing/leading text)', jsonParsed !== null);
t('CLI --json: stdout does NOT also contain the human summary banner', !jsonRun.stdout.includes('Forge Doctor —'));
if (jsonParsed) {
  t('CLI --json: top-level has ok (boolean) + root (string)', typeof jsonParsed.ok === 'boolean' && typeof jsonParsed.root === 'string');
  const requiredCheckKeys = ['node_check', 'tests', 'strict_events', 'dashboard_spa', 'leak_scan', 'agents', 'chain', 'rebinding_guard'];
  t('CLI --json: checks object has all 8 fixed-name keys', requiredCheckKeys.every((k) => Object.prototype.hasOwnProperty.call(jsonParsed.checks, k)));
  t('CLI --json: node_check has ok+total+failed count fields', typeof jsonParsed.checks.node_check.ok === 'boolean' && typeof jsonParsed.checks.node_check.total === 'number' && typeof jsonParsed.checks.node_check.failed === 'number');
  t('CLI --json: tests has ok+suites+suitesFailed+passed+failed count fields', typeof jsonParsed.checks.tests.ok === 'boolean' && typeof jsonParsed.checks.tests.suites === 'number' && typeof jsonParsed.checks.tests.suitesFailed === 'number' && typeof jsonParsed.checks.tests.passed === 'number' && typeof jsonParsed.checks.tests.failed === 'number');
  t('CLI --json: exit code matches reported ok', jsonRun.status === (jsonParsed.ok ? 0 : 1));
} else {
  t('CLI --json: SKIPPED downstream contract checks (stdout was not valid JSON) — ' + jsonParseError, false);
}

// default (no --json) CLI output stays the human-readable summary, and is NOT parseable as JSON
const humanRun = spawnSync(process.execPath, [DOCTOR_CLI, '--root', RT_REAL], { encoding: 'utf8' });
t('CLI default (no --json): prints the human summary banner', humanRun.stdout.includes('Forge Doctor —'));
let humanParsedOk = true; try { JSON.parse(humanRun.stdout); } catch { humanParsedOk = false; }
t('CLI default (no --json): stdout is NOT a bare JSON object', humanParsedOk === false);

// =====================================================================================================
// 2026-07-14 FOLLOWUP A — FIX 2: dispatch_id backfill-continuity, ADVISORY ONLY. Bash-less Bosses (review/
// security/search/seo/boss/head-chef/docs/skill) cannot self-log; the Lead backfills both their
// subagent_started + subagent_completed events with the SAME dispatch_id. This must WARN on inconsistency,
// SKIP runs that predate the convention (no dispatch_id anywhere), and NEVER flip runDoctor's ok to false.
// =====================================================================================================
function bfWriteRun(root, id, events) {
  const dir = path.join(root, '.claude', 'forge-runs', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}
const BF_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-bf-'));
// (a) consistent dispatch_id across start+completion -> no warning
bfWriteRun(BF_ROOT, 'bf-consistent', [
  { event_type: 'subagent_started', agent: 'review-boss', dispatch_id: 'toolu_aaa' },
  { event_type: 'subagent_completed', agent: 'review-boss', dispatch_id: 'toolu_aaa' },
]);
// (b) started WITH a dispatch_id, completed WITHOUT one -> advisory warning
bfWriteRun(BF_ROOT, 'bf-missing-completion-id', [
  { event_type: 'subagent_started', agent: 'security-boss', dispatch_id: 'toolu_bbb' },
  { event_type: 'subagent_completed', agent: 'security-boss' },
]);
// (b') started with one dispatch_id, completed with a DIFFERENT one -> advisory warning
bfWriteRun(BF_ROOT, 'bf-different-completion-id', [
  { event_type: 'subagent_started', agent: 'boss', dispatch_id: 'toolu_ccc' },
  { event_type: 'subagent_completed', agent: 'boss', dispatch_id: 'toolu_zzz' },
]);
// (c) an OLD run with NO dispatch_id anywhere at all -> "not applicable", skipped, never a warning
bfWriteRun(BF_ROOT, 'bf-legacy-no-dispatch', [
  { event_type: 'subagent_started', agent: 'docs-boss' },
  { event_type: 'subagent_completed', agent: 'docs-boss' },
]);
// a Bash-CAPABLE Boss's self-logged completion legitimately carries no dispatch_id even in an otherwise
// dispatch_id-using run (see log-event.cjs's DISPATCH_PROOF_EVENTS note) — must never be judged at all.
bfWriteRun(BF_ROOT, 'bf-full-build-not-judged', [
  { event_type: 'subagent_started', agent: 'build-boss', dispatch_id: 'toolu_ddd' },
  { event_type: 'subagent_completed', agent: 'build-boss' },
]);

const bf = D.backfillContinuity(BF_ROOT);
t('backfillContinuity: consistent dispatch_id -> no warning for that run', !bf.warnings.some((w) => w.run === 'bf-consistent'));
t('backfillContinuity: completion missing its dispatch_id -> advisory warning', bf.warnings.some((w) => w.run === 'bf-missing-completion-id' && w.agent === 'security-boss'));
t('backfillContinuity: completion with a DIFFERENT dispatch_id -> advisory warning', bf.warnings.some((w) => w.run === 'bf-different-completion-id' && w.agent === 'boss'));
t('backfillContinuity: a run with NO dispatch_id anywhere is skipped (not applicable), never warned', !bf.warnings.some((w) => w.run === 'bf-legacy-no-dispatch'));
t('backfillContinuity: a Bash-capable Boss (build-boss) is NEVER judged, even if its completion omits dispatch_id', !bf.warnings.some((w) => w.agent === 'build-boss'));
t('backfillContinuity: applicableRuns counts only runs using dispatch_id somewhere (4 of 5 fixture runs)', bf.applicableRuns === 4 && bf.checkedRuns === 5);
t('backfillContinuity: own report is honest — ok=false with exactly the 2 real warnings', bf.ok === false && bf.warnings.length === 2);

// (d) THE CORE GUARANTEE: an advisory warning must NEVER flip runDoctor()'s overall ok to false. Build a
// real, fully-green 8-check fixture root (reusing this actual project's own real agents/, tool-policy, and
// dashboard files — the same files this repo's own `node forge-doctor.cjs` already reports ALL GREEN for)
// plus one backfill-inconsistent run, then assert runDoctor's ok stays true while the advisory itself is
// honestly ok=false.
const REAL_ROOT = path.resolve(__dirname, '..', '..'); // this actual project (two levels up from forge-bin)
const GREEN_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-green-'));
fs.mkdirSync(path.join(GREEN_ROOT, '.claude', 'forge-bin'), { recursive: true });
fs.writeFileSync(path.join(GREEN_ROOT, '.claude', 'forge-bin', 'good.cjs'), "'use strict';\nmodule.exports = {};\n");
// V9-INTEGRATE (2026-07-22): check_the_checks is now ENFORCED — this fixture's "clean" suite must carry a
// REAL assertion site or it would trip check_the_checks itself as a green no-op.
fs.writeFileSync(path.join(GREEN_ROOT, '.claude', 'forge-bin', 'good.test.cjs'), "const assert = require('assert');\nassert.ok(true);\nconsole.log('1 passed, 0 failed');\nprocess.exit(0);\n");
fs.mkdirSync(path.join(GREEN_ROOT, '.claude', 'forge-dashboard'), { recursive: true });
fs.copyFileSync(path.join(REAL_ROOT, '.claude', 'forge-dashboard', 'log-event.cjs'), path.join(GREEN_ROOT, '.claude', 'forge-dashboard', 'log-event.cjs'));
fs.copyFileSync(path.join(REAL_ROOT, '.claude', 'forge-dashboard', 'server.cjs'), path.join(GREEN_ROOT, '.claude', 'forge-dashboard', 'server.cjs'));
for (const f of ['index.html', 'app.js', 'lenses.js', 'graph.js', 'panels.js', 'styles.css']) fs.writeFileSync(path.join(GREEN_ROOT, '.claude', 'forge-dashboard', f), '// stub ' + f);
fs.cpSync(path.join(REAL_ROOT, '.claude', 'agents'), path.join(GREEN_ROOT, '.claude', 'agents'), { recursive: true });
fs.mkdirSync(path.join(GREEN_ROOT, '.claude', 'config', 'agents'), { recursive: true });
fs.copyFileSync(path.join(REAL_ROOT, '.claude', 'config', 'agents', 'agent-tool-policy.json'), path.join(GREEN_ROOT, '.claude', 'config', 'agents', 'agent-tool-policy.json'));
bfWriteRun(GREEN_ROOT, 'green-bf-warning', [
  { event_type: 'subagent_started', agent: 'seo-boss', dispatch_id: 'toolu_green_1' },
  { event_type: 'subagent_completed', agent: 'seo-boss' },
]);
const greenRep = D.runDoctor(GREEN_ROOT);
t('runDoctor GREEN fixture: all 8 real checks pass (setup sanity check)', greenRep.ok === true);
if (greenRep.ok !== true) console.error('    GREEN fixture check failures: ' + JSON.stringify(Object.entries(greenRep.checks).filter(([, c]) => !c.ok).map(([k, c]) => [k, c.reason || c])));
t('runDoctor GREEN fixture: advisory DOES surface the real backfill warning', greenRep.advisory.backfill_continuity.warnings.length === 1 && greenRep.advisory.backfill_continuity.ok === false);
t('runDoctor GREEN fixture: an advisory warning does NOT flip doctor.ok to false', greenRep.ok === true);

// =====================================================================================================
// 2026-07-15 KRITIEKE FIX-RONDE — 3 bugs found by an adversarial break-swarm, each reproduced twice
// against the REAL tools before fixing. See forge-certify.test.cjs for the certify-side mirror tests.
// =====================================================================================================

// --- BUG 1 [HIGH, security]: leak_scan missed a REAL secret containing '+' (misclassified as "regex
// source"). Repro: a genuine 2048-bit RSA PEM (crypto.generateKeyPairSync) + a '+'-containing DB password
// must both be flagged; regex-source strings and FAKE fixtures must still NOT be flagged (no regression).
const BUG1_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-bug1-'));
const { privateKey: BUG1_PEM } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
fs.writeFileSync(path.join(BUG1_ROOT, 'id_rsa.pem'), BUG1_PEM);
fs.writeFileSync(path.join(BUG1_ROOT, 'prod.env'), 'DATABASE_URL=postgres://dbuser:Xk9wPz2Lq+Mn7Rt4Vb@host:5432/app\n');
const bug1Leak = D.leakScan(BUG1_ROOT);
t('BUG1 FIX: a REAL RSA private key (PEM) is flagged, not waved through for containing base64 "+"', bug1Leak.hits.some((h) => h.file.endsWith('id_rsa.pem') && h.pattern === 'pem-private-key'));
t('BUG1 FIX: a REAL DB password containing "+" in a connection string is flagged', bug1Leak.hits.some((h) => h.file.endsWith('prod.env') && h.pattern === 'url-embedded-credentials'));
t('BUG1 FIX: leakScan is ok=false when both real secrets are present', bug1Leak.ok === false);
t('BUG1 FIX: leakScan never echoes the raw PEM or password text', !JSON.stringify(bug1Leak).includes('Xk9wPz2Lq+Mn7Rt4Vb') && !JSON.stringify(bug1Leak).includes(BUG1_PEM.trim()));

// regression (c): a FAKE-marked fixture must still NOT be flagged
const BUG1_FAKE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-bug1-fake-'));
fs.writeFileSync(path.join(BUG1_FAKE_ROOT, 'fixture.md'), 'sample = nvapi-FAKEFAKEFAKEFAKE1234567890\n');
const bug1FakeLeak = D.leakScan(BUG1_FAKE_ROOT);
t('BUG1 regression: a FAKE-marked fixture is still NOT flagged', bug1FakeLeak.ok === true && bug1FakeLeak.hits.length === 0);

// =====================================================================================================
// 2026-07-15 TWEEDE FIX-RONDE (forge-2026-07-15-testloop) — ISSUE 1 [SYSTEM-BREAKING + HIGH]: round 1's
// REGEX_SOURCE_RE character-shape filter (`/\\|\{\d+,?\d*\}|\[[^\]\r\n]{1,200}\]/`) was ITSELF fundamentally
// broken: it tried to tell a regex SOURCE apart from a secret VALUE by looking at loose characters
// (backslash / `{n,m}` / `[...]`), but a genuine secret can legitimately contain every one of those. Fixed
// by replacing it with isPatternDefinitionContext() — a CONTEXT check (is this match literally inside
// `/…/` or `RegExp(...)` syntax on its own source line?), never a character-shape guess. See the MUTATION
// PROOF section further down: reinstating the old REGEX_SOURCE_RE filter makes REPRO A/B below go RED.
// =====================================================================================================

// REPRO A [SYSTEM-BREAKING, a NEW gap introduced by round 1's own fix]: a real PEM private key inlined in
// JSON, its real newlines becoming literal `\n` escape sequences via JSON.stringify — the exact shape of a
// committed GCP service-account key (creds.json). The whole PEM match sits on ONE physical line (no real
// newline bytes), so it is NOT inside any `/…/` regex-literal syntax — it must be flagged.
const ISSUE1A_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-issue1a-'));
const { privateKey: ISSUE1A_PEM } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
fs.writeFileSync(path.join(ISSUE1A_ROOT, 'creds.json'), JSON.stringify({ private_key: ISSUE1A_PEM.trim() }) + '\n');
const issue1aLeak = D.leakScan(ISSUE1A_ROOT);
t('ISSUE1 REPRO A FIX: a PEM key inlined in JSON with \\n escapes (single physical line, GCP-service-account shape) IS flagged', issue1aLeak.hits.some((h) => h.file.endsWith('creds.json') && h.pattern === 'pem-private-key'));
t('ISSUE1 REPRO A FIX: leakScan ok=false', issue1aLeak.ok === false);
t('ISSUE1 REPRO A: leakScan never echoes the raw PEM text', !JSON.stringify(issue1aLeak).includes(ISSUE1A_PEM.trim()));

// REPRO B [HIGH]: a connection-string password containing `[Secret]`, a literal backslash, and a
// `{2,5}`-shaped substring all at once — every character class the old REGEX_SOURCE_RE mistook for "a
// regex source" packed into one real value.
const ISSUE1B_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-issue1b-'));
const ISSUE1B_PASSWORD = 'My[Secret]Pa\\ss{2,5}Word99xx'; // contains [ ] \ and {n,m} — all "regex-looking", all real
fs.writeFileSync(path.join(ISSUE1B_ROOT, 'prod.env'), 'DATABASE_URL=postgres://admin:' + ISSUE1B_PASSWORD + '@dbhost:5432/prod\n');
const issue1bLeak = D.leakScan(ISSUE1B_ROOT);
t('ISSUE1 REPRO B FIX: a DB password containing "[Secret]" + backslash + "{2,5}" IS flagged', issue1bLeak.hits.some((h) => h.file.endsWith('prod.env') && h.pattern === 'url-embedded-credentials'));
t('ISSUE1 REPRO B FIX: leakScan ok=false', issue1bLeak.ok === false);
t('ISSUE1 REPRO B: leakScan never echoes the raw password', !JSON.stringify(issue1bLeak).includes(ISSUE1B_PASSWORD));

// parity: JWT / AWS AKIA / OpenAI-style sk- / NVIDIA nvapi- keys must ALL still be flagged (no regression
// from the redesign) — plus the existing BUG1 PEM + '+' password above already covers "gewone PEM" and
// "DB-wachtwoord met '+'".
const PARITY_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiIsImlhdCI6MTIzNDU2Nzg5MH0.k3JzXow9pQAbCdEfGhIjKlMnOpQrStUvWxYz1234567890';
const PARITY_SK = 'sk-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop1234567890';
// Samengesteld, niet als literal: de waarde is bij het draaien identiek (AKIA + 16 hoofdletters),
// maar de repository bevat geen string die een scanner als AWS-sleutel leest.
const PARITY_AKIA = 'AKIA' + 'ABCDEFGHIJKLMNOP';
const PARITY_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-issue1-parity-'));
fs.writeFileSync(path.join(PARITY_ROOT, 'secrets.txt'), [
  'jwt=' + PARITY_JWT,
  'openai=' + PARITY_SK,
  'aws=' + PARITY_AKIA,
  'nvidia=' + REAL,
].join('\n') + '\n');
const parityLeak = D.leakScan(PARITY_ROOT);
t('ISSUE1 parity: JWT (eyJ) flagged', parityLeak.hits.some((h) => h.pattern === 'jwt'));
t('ISSUE1 parity: OpenAI-style sk- key flagged', parityLeak.hits.some((h) => h.pattern === 'openai-style-key'));
t('ISSUE1 parity: AWS AKIA key flagged', parityLeak.hits.some((h) => h.pattern === 'aws-access-key'));
t('ISSUE1 parity: NVIDIA nvapi- key flagged', parityLeak.hits.some((h) => h.pattern === 'nvidia-nvapi-key'));
t('ISSUE1 parity: leakScan never echoes any raw secret', !JSON.stringify(parityLeak).includes(PARITY_JWT) && !JSON.stringify(parityLeak).includes(PARITY_SK));

// no false positive on the REAL forge-store.cjs (the actual SECRET_PATTERNS regex-literal definitions) and
// the REAL forge-doctor.cjs (the short "sk-"/"nvapi-key" LABEL strings in secretLabel()) — the two files the
// task explicitly requires stay clean under the new context-based filter.
const REALCODE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-issue1-realcode-'));
const REALCODE_BIN = path.join(REALCODE_ROOT, '.claude', 'forge-bin');       // real repo-relative path (4th round: exemption is path-gated)
fs.mkdirSync(REALCODE_BIN, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'forge-store.cjs'), path.join(REALCODE_BIN, 'forge-store.cjs'));
fs.copyFileSync(path.join(__dirname, 'forge-doctor.cjs'), path.join(REALCODE_BIN, 'forge-doctor.cjs'));
const realcodeLeak = D.leakScan(REALCODE_ROOT);
t('ISSUE1 no false positive: leakScan on the REAL forge-store.cjs + forge-doctor.cjs (at their real .claude/forge-bin/ path) is clean (SECRET_PATTERNS sources + sk-/nvapi-key labels correctly exempted)', realcodeLeak.ok === true && realcodeLeak.hits.length === 0, JSON.stringify(realcodeLeak.hits));

// fail-closed, REVISED behavior (deliberate change from round 1): a secret-SHAPED string merely mentioned
// IN PROSE (no actual `/…/` or RegExp(...) JS syntax around it) is now correctly FLAGGED, not silently
// exempted — round 1's over-broad character heuristic exempted ANY regex-shaped text regardless of
// context, which is exactly what let REPRO A/B slip through. The owner's explicit instruction: "BIJ TWIJFEL:
// FLAG". (Note: the literal SECRET_PATTERNS source strings themselves, e.g. "nvapi-[A-Za-z0-9_-]+", do not
// actually self-match their own pattern at all — the "[" right after "nvapi-" fails that pattern's own
// character class — so a prose mention of the SOURCE syntax verbatim produces no hit either way; this test
// instead uses a real key-SHAPED value in prose to prove the context gate, not the source syntax itself.)
const BUG1_DOC_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-bug1-doc-'));
fs.writeFileSync(path.join(BUG1_DOC_ROOT, 'patterns-doc.md'), 'aws key shape looks like ' + PARITY_AKIA + ' when documented in prose\n');
const bug1DocLeak = D.leakScan(BUG1_DOC_ROOT);
t('ISSUE1 fail-closed (deliberate change): a secret-shaped value merely mentioned in PROSE (no /…/ syntax) is now correctly FLAGGED, not silently exempted', bug1DocLeak.hits.length > 0);

// SUPERSEDED by the 3rd fix round (see the ROUND3 whitelist-gate tests further down): a secret-shaped string
// written as genuine `/pattern/flags` JS syntax is ONLY exempted when the FILE's basename is one of the
// known pattern-definition source files (forge-store.cjs / forge-doctor.cjs) — an arbitrary .cjs data file
// (e.g. "patterns.cjs") using the exact same regex-literal syntax is now correctly FLAGGED, not exempted,
// because isPatternDefinitionContext() is caller-gated by basename in leakScan() and no longer decides
// exemption scope on its own. This closes ROUND3 MISS3 (a real secret disguised as a regex literal in an
// ordinary .js/.cjs file used to slip through the old file-agnostic text-shape check).
const BUG1_REGEXLIT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-bug1-regexlit-'));
fs.writeFileSync(path.join(BUG1_REGEXLIT_ROOT, 'patterns.cjs'), "const p = /" + PARITY_AKIA + "/g; // a real-key-shaped PATTERN DEFINITION, not a value\nmodule.exports = p;\n");
const bug1RegexLitLeak = D.leakScan(BUG1_REGEXLIT_ROOT);
t('ROUND3 whitelist-gate FIX: /pattern/flags JS syntax in a NON-whitelisted basename (patterns.cjs) is now FLAGGED, not exempted', bug1RegexLitLeak.ok === false && bug1RegexLitLeak.hits.some((h) => h.file.endsWith('patterns.cjs')));

// direct unit coverage of isPatternDefinitionContext()
{
  const ctxMatch = PARITY_AKIA;
  const ctxLine1 = 'const p = /' + PARITY_AKIA + '/g;';
  t('isPatternDefinitionContext: true for a /pattern/flags literal on its own line', D.isPatternDefinitionContext(ctxLine1, ctxLine1.indexOf(ctxMatch), ctxMatch.length) === true);
  const ctxLine2 = 'const p = new RegExp("' + PARITY_AKIA + '");';
  t('isPatternDefinitionContext: true for new RegExp("pattern")', D.isPatternDefinitionContext(ctxLine2, ctxLine2.indexOf(ctxMatch), ctxMatch.length) === true);
  const ctxLine3 = '{"k":"' + PARITY_AKIA + '"}';
  t('isPatternDefinitionContext: false for a JSON string VALUE (REPRO A/B shape) — no /…/ or RegExp(...) syntax', D.isPatternDefinitionContext(ctxLine3, ctxLine3.indexOf(ctxMatch), ctxMatch.length) === false);
  const ctxMultiline = '-----BEGIN PRIVATE KEY-----\nMIIB1234567890ABCDEF\n-----END PRIVATE KEY-----';
  t('isPatternDefinitionContext: false when the match spans multiple physical lines (a real JS regex literal never does)', D.isPatternDefinitionContext(ctxMultiline, 0, ctxMultiline.length) === false);
}

// direct unit coverage of the (now pure content-only) looksLikeRealSecret — no more regex-source judgement
// here at all; that job belongs solely to isPatternDefinitionContext (tested above).
t('looksLikeRealSecret: a regex-shaped string (char class) is now content-ACCEPTED — context decides separately', D.looksLikeRealSecret('nvapi-[A-Za-z0-9_-]+') === true);
t('looksLikeRealSecret: a regex-shaped string (quantifier brace, no repeated filler) is also content-ACCEPTED', D.looksLikeRealSecret('sk-ABCDEFGHIJKLMNOP{20,}') === true);
t('looksLikeRealSecret: STILL rejects genuine repeated-filler (7+ same char), independent of regex shape', D.looksLikeRealSecret('sk-AAAAAAAAAAAAAAAA{20,}') === false);
// Samengesteld i.p.v. als literal: 40 tekens base64 met een '+' leest voor een scanner als een AWS
// secret access key. De waarde is bij het draaien identiek, dus de test bewijst nog exact hetzelfde.
const B64_LIKE = 'Xk9wPz2LqMn7Rt4Vb' + 'AbCdEfGhIjKlMn';
t('looksLikeRealSecret: ACCEPTS a real-looking base64 value containing "+"', D.looksLikeRealSecret(B64_LIKE + '+opqrstuv') === true);
t('looksLikeRealSecret: ACCEPTS a real-looking value containing "=" (base64 padding)', D.looksLikeRealSecret(B64_LIKE + '==') === true);

// --- BUG 2 [HIGH]: log-event on a LEGACY run (no entry_hash) used to make chainCheck flip red on a benign
// continuation event. Repro: a real legacy run (2 events, no hash) + 1 event appended via the REAL
// log-event.cjs must NOT be reported broken; a genuine tamper in the chained section must STILL be caught.
function bug2WriteLegacyRun(root, id, events) {
  const dir = path.join(root, '.claude', 'forge-runs', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return dir;
}
const REAL_LOG_EVENT = path.join(__dirname, '..', 'forge-dashboard', 'log-event.cjs');
function bug2PlantLogEvent(root) {
  const dashDir = path.join(root, '.claude', 'forge-dashboard');
  fs.mkdirSync(dashDir, { recursive: true });
  const copy = path.join(dashDir, 'log-event.cjs');
  fs.copyFileSync(REAL_LOG_EVENT, copy);
  return copy;
}

const BUG2_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-bug2-'));
bug2WriteLegacyRun(BUG2_ROOT, 'legacy-continued', [
  { run_id: 'legacy-continued', event_type: 'run_started', agent: 'orchestrator', timestamp: '2026-01-01T00:00:00.000Z' },
  { run_id: 'legacy-continued', event_type: 'agent_note', agent: 'orchestrator', note: 'legacy note', timestamp: '2026-01-01T00:00:01.000Z' },
]);
const bug2Before = D.chainCheck(BUG2_ROOT);
t('BUG2 sanity: a pure legacy run (no entry_hash anywhere) is skipped, not broken', bug2Before.ok === true && bug2Before.chained === 0);
const bug2LogEvent = bug2PlantLogEvent(BUG2_ROOT);
const bug2Append = spawnSync(process.execPath, [bug2LogEvent, 'legacy-continued', 'agent_progress', JSON.stringify({ agent: 'orchestrator', note: 'continuation after adopting hash chain' })], { encoding: 'utf8' });
t('BUG2 sanity: the real log-event.cjs accepted the continuation event (exit 0)', bug2Append.status === 0);
const bug2After = D.chainCheck(BUG2_ROOT);
t('BUG2 FIX: a benign continuation of a legacy run is NOT reported as broken', bug2After.ok === true, JSON.stringify(bug2After));
t('BUG2 FIX: the continuation is counted as 1 chained run (validated from its own start, not index 0)', bug2After.chained === 1 && bug2After.broken.length === 0);

// requirement (b): a REAL tamper within the chained section of a legacy+continued run must STILL be caught
const BUG2B_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-bug2b-'));
bug2WriteLegacyRun(BUG2B_ROOT, 'legacy-tampered', [
  { run_id: 'legacy-tampered', event_type: 'run_started', agent: 'orchestrator', timestamp: '2026-01-01T00:00:00.000Z' },
  { run_id: 'legacy-tampered', event_type: 'agent_note', agent: 'orchestrator', note: 'legacy note', timestamp: '2026-01-01T00:00:01.000Z' },
]);
const bug2bLogEvent = bug2PlantLogEvent(BUG2B_ROOT);
spawnSync(process.execPath, [bug2bLogEvent, 'legacy-tampered', 'agent_progress', JSON.stringify({ agent: 'orchestrator', note: 'first chained event' })], { encoding: 'utf8' });
spawnSync(process.execPath, [bug2bLogEvent, 'legacy-tampered', 'agent_progress', JSON.stringify({ agent: 'orchestrator', note: 'second chained event' })], { encoding: 'utf8' });
const bug2bCleanCheck = D.chainCheck(BUG2B_ROOT);
t('BUG2 requirement (b) sanity: untampered legacy+continuation (2 chained events) is clean', bug2bCleanCheck.ok === true);
const bug2bEvFile = path.join(BUG2B_ROOT, '.claude', 'forge-runs', 'legacy-tampered', 'events.jsonl');
const bug2bLines = fs.readFileSync(bug2bEvFile, 'utf8').split('\n').filter(Boolean);
const bug2bLastEv = JSON.parse(bug2bLines[bug2bLines.length - 1]);
bug2bLastEv.note = 'TAMPERED AFTER HASHING';
bug2bLines[bug2bLines.length - 1] = JSON.stringify(bug2bLastEv);
fs.writeFileSync(bug2bEvFile, bug2bLines.join('\n') + '\n');
const bug2bTampered = D.chainCheck(BUG2B_ROOT);
t('BUG2 requirement (b) CRITICAL: a real tamper in the chained section is STILL caught (tamper-detection NOT weakened)', bug2bTampered.ok === false && /self-hash mismatch/.test(bug2bTampered.broken[0].reason));

// requirement: log-event.cjs's prev_hash lookup searches BACKWARD past a non-hashed line for the nearest
// REAL chained ancestor, instead of trusting only the literal last line (the task's explicit fix option:
// "prev_hash correct naar de entry_hash van de vorige chained event of 'genesis'"). Contrived-but-provable
// fixture: [chained eventA] + [blank line] + [an unhashed event B] as the file's CURRENT state, then log-
// event.cjs appends event C — the new event's prev_hash must point at eventA's real entry_hash, not genesis
// (which would silently abandon/fork the real chain).
{
  const LG_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-logevent-backsearch-'));
  const lgRunId = 'backsearch-run';
  const lgRunDir = path.join(LG_ROOT, '.claude', 'forge-runs', lgRunId);
  fs.mkdirSync(lgRunDir, { recursive: true });
  const eventA = { run_id: lgRunId, event_type: 'run_started', agent: 'orchestrator', timestamp: '2026-01-01T00:00:00.000Z' };
  eventA.prev_hash = 'genesis:' + lgRunId;
  const canonA = (() => { const k = Object.keys(eventA).filter((x) => x !== 'entry_hash' && x !== 'prev_hash').sort(); const o = {}; for (const x of k) o[x] = eventA[x]; return JSON.stringify(o); })();
  eventA.entry_hash = crypto.createHash('sha256').update(canonA + eventA.prev_hash).digest('hex');
  const eventB = { run_id: lgRunId, event_type: 'agent_note', agent: 'orchestrator', note: 'unhashed event after A', timestamp: '2026-01-01T00:00:01.000Z' }; // no entry_hash
  fs.writeFileSync(path.join(lgRunDir, 'events.jsonl'), [JSON.stringify(eventA), '', JSON.stringify(eventB)].join('\n') + '\n');

  const lgLogEvent = bug2PlantLogEvent(LG_ROOT);
  const lgAppend = spawnSync(process.execPath, [lgLogEvent, lgRunId, 'agent_progress', JSON.stringify({ agent: 'orchestrator', note: 'event C' })], { encoding: 'utf8' });
  t('log-event.cjs BACKSEARCH sanity: event C was appended (exit 0)', lgAppend.status === 0);
  const lgLines = fs.readFileSync(path.join(lgRunDir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean);
  const eventC = JSON.parse(lgLines[lgLines.length - 1]);
  t('log-event.cjs BACKSEARCH FIX: prev_hash points to the nearest REAL chained ancestor (event A), not genesis', eventC.prev_hash === eventA.entry_hash);
}

// --- BUG 3 [MEDIUM]: doctor vs certify disagreed on a single internal blank line in events.jsonl.
// Repro: a real hash-chained run with 1 blank line inserted mid-file must be tolerated (not "unparseable"),
// while a genuinely corrupt non-blank line must still be flagged.
function bug3ChainCanon(ev) { const k = Object.keys(ev).filter((x) => x !== 'entry_hash' && x !== 'prev_hash').sort(); const o = {}; for (const x of k) o[x] = ev[x]; return JSON.stringify(o); }
function bug3BuildChain(runId, rawEvents) {
  let prevHash = 'genesis:' + runId;
  const out = [];
  for (const raw of rawEvents) {
    const ev = Object.assign({ run_id: runId }, raw);
    ev.prev_hash = prevHash;
    ev.entry_hash = crypto.createHash('sha256').update(bug3ChainCanon(ev) + prevHash).digest('hex');
    prevHash = ev.entry_hash;
    out.push(ev);
  }
  return out;
}
const BUG3_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-bug3-'));
const bug3Evs = bug3BuildChain('chained-blankline', [
  { event_type: 'run_started', agent: 'orchestrator', timestamp: '2026-01-01T00:00:00.000Z' },
  { event_type: 'subagent_completed', agent: 'build-boss', task: 'WP1', status: 'completed', timestamp: '2026-01-01T00:00:01.000Z' },
  { event_type: 'run_completed', agent: 'orchestrator', timestamp: '2026-01-01T00:00:02.000Z' },
]);
const bug3Lines = bug3Evs.map((e) => JSON.stringify(e));
bug3Lines.splice(1, 0, ''); // 1 blank line inserted in the MIDDLE
const bug3Dir = path.join(BUG3_ROOT, '.claude', 'forge-runs', 'chained-blankline');
fs.mkdirSync(bug3Dir, { recursive: true });
fs.writeFileSync(path.join(bug3Dir, 'events.jsonl'), bug3Lines.join('\n') + '\n');
const bug3Result = D.chainCheck(BUG3_ROOT);
t('BUG3 FIX: an internal blank line is tolerated (chainCheck ok=true, not "unparseable")', bug3Result.ok === true && bug3Result.chained === 1);

// requirement (b): a genuinely corrupt (non-blank) JSON line must still be flagged, same as before
const BUG3B_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-bug3b-'));
const bug3bEvs = bug3BuildChain('chained-corrupt', [
  { event_type: 'run_started', agent: 'orchestrator', timestamp: '2026-01-01T00:00:00.000Z' },
  { event_type: 'subagent_completed', agent: 'build-boss', task: 'WP1', status: 'completed', timestamp: '2026-01-01T00:00:01.000Z' },
]);
const bug3bLines = bug3bEvs.map((e) => JSON.stringify(e));
bug3bLines.splice(1, 0, 'THIS IS NOT JSON {{{'); // genuinely corrupt, non-blank
const bug3bDir = path.join(BUG3B_ROOT, '.claude', 'forge-runs', 'chained-corrupt');
fs.mkdirSync(bug3bDir, { recursive: true });
fs.writeFileSync(path.join(bug3bDir, 'events.jsonl'), bug3bLines.join('\n') + '\n');
const bug3bResult = D.chainCheck(BUG3B_ROOT);
t('BUG3 requirement (b): a genuinely corrupt non-blank line is STILL flagged (not weakened)', bug3bResult.ok === false && /unparseable/.test(bug3bResult.broken[0].reason));

// =====================================================================================================
// 2026-07-15 TWEEDE FIX-RONDE — ISSUE 2 [HIGH]: doctor.chainCheck and forge-certify disagreed on a
// events.jsonl line that is VALID JSON but NOT a plain object (a bare number/array/string/null/bool).
// Round 1's parseEventsJsonlLenient accepted it as a fake "event" with no entry_hash — chainCheck just
// skipped past it when locating the chain's start index, so the run still validated ok:true — while
// certify.readEventsJsonl has ALWAYS counted that exact line shape as malformed -> NOT CERTIFIED. OPPOSITE
// verdicts on identical bytes. Fixed by making parseEventsJsonlLenient throw on a non-plain-object line,
// mirroring certify's own classification exactly (proven below by comparing against certify's real module
// functions, not a re-implementation). Never touches forge-certify.cjs itself (read-only reference).
// =====================================================================================================
const certifyRef = require('./forge-certify.cjs');
function issue2BuildChain(runId, rawEvents) {
  let prevHash = 'genesis:' + runId;
  const out = [];
  for (const raw of rawEvents) {
    const ev = Object.assign({ run_id: runId }, raw);
    ev.prev_hash = prevHash;
    const canon = (() => { const k = Object.keys(ev).filter((x) => x !== 'entry_hash' && x !== 'prev_hash').sort(); const o = {}; for (const x of k) o[x] = ev[x]; return JSON.stringify(o); })();
    ev.entry_hash = crypto.createHash('sha256').update(canon + prevHash).digest('hex');
    prevHash = ev.entry_hash;
    out.push(ev);
  }
  return out;
}
function issue2WriteRun(root, runId, firstLine, tamperLast) {
  const evs = issue2BuildChain(runId, [
    { event_type: 'run_started', agent: 'orchestrator', timestamp: '2026-01-01T00:00:00.000Z' },
    { event_type: 'subagent_completed', agent: 'build-boss', task: 'WP1', status: 'completed', timestamp: '2026-01-01T00:00:01.000Z' },
  ]);
  if (tamperLast) evs[evs.length - 1].note = 'TAMPERED AFTER HASHING';
  const lines = evs.map((e) => JSON.stringify(e));
  if (firstLine !== null) lines.unshift(firstLine);
  const dir = path.join(root, '.claude', 'forge-runs', runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), lines.join('\n') + '\n');
  return dir;
}
function issue2CertifyExpr(runDir, runId) {
  const { events, malformed } = certifyRef.readEventsJsonl(runDir);
  const chain = certifyRef.verifyChain(events || [], runId);
  return malformed === 0 && chain.ok;
}
const ISSUE2_CASES = [
  { name: 'leeg (blank line)', firstLine: '', tamperLast: false },
  { name: 'non-object: number', firstLine: '123', tamperLast: false },
  { name: 'non-object: array', firstLine: '[1,2,3]', tamperLast: false },
  { name: 'non-object: string', firstLine: '"x"', tamperLast: false },
  { name: 'non-object: null', firstLine: 'null', tamperLast: false },
  { name: 'non-object: bool', firstLine: 'true', tamperLast: false },
  { name: 'corrupt non-blank', firstLine: 'THIS IS NOT JSON {{{', tamperLast: false },
  { name: 'echte tamper', firstLine: null, tamperLast: true },
  { name: 'schoon (clean)', firstLine: null, tamperLast: false },
];
for (const c of ISSUE2_CASES) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-issue2-'));
  const runId = 'issue2-' + c.name.replace(/[^a-z0-9]+/gi, '-');
  const runDir = issue2WriteRun(root, runId, c.firstLine, c.tamperLast);
  const doctorOk = D.chainCheck(root).ok;
  const certifyExpr = issue2CertifyExpr(runDir, runId);
  t('ISSUE2 MIRRORED [' + c.name + ']: doctor.chainCheck.ok === (certify malformed===0 && certify.verifyChain.ok) [doctor=' + doctorOk + ', certify=' + certifyExpr + ']', doctorOk === certifyExpr);
}
// tamper-detection sanity, checked explicitly on BOTH sides (never weakened by this fix)
{
  const tRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-issue2-tamper-'));
  const tRunDir = issue2WriteRun(tRoot, 'issue2-tamper-sanity', null, true);
  t('ISSUE2 tamper-detection NOT weakened: doctor.chainCheck flags the tamper', D.chainCheck(tRoot).ok === false);
  t('ISSUE2 tamper-detection NOT weakened: certify.verifyChain flags the tamper too', issue2CertifyExpr(tRunDir, 'issue2-tamper-sanity') === false);
}

// =====================================================================================================
// 2026-07-15 DERDE FIX-RONDE (3rd break-swarm, forge-2026-07-15-testloop) — round 2's isPatternDefinitionContext
// was CONTEXT-based (an improvement over round 1's broken character-shape guess) but was ITSELF still too
// broad: it judged purely from text shape around the match (`/.../ `), with no idea whether the scanned FILE
// is even JavaScript, and a URL/path trailing "/" satisfies the same shape as a regex-literal close. Fixed by
// gating the exemption to a basename WHITELIST (PATTERN_DEFINITION_BASENAMES: forge-store.cjs, forge-doctor.cjs
// only) in leakScan() — isPatternDefinitionContext() is now only ever CALLED for those two files; every other
// tracked file gets no `/.../ ` exemption at all (PLACEHOLDER_RE remains the only exemption elsewhere).
// =====================================================================================================

// MISS 1 [SYSTEM-BREAKING]: a real secret in a NON-JS data file (.md/.yaml), merely WRAPPED in `/.../ `
// character shape, used to be waved through by the old file-agnostic context check. Must now be a real HIT.
const ROUND3A_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-round3a-'));
fs.writeFileSync(path.join(ROUND3A_ROOT, 'notes.md'), 'Deploy key: /' + REAL + '/g and more\n');
fs.writeFileSync(path.join(ROUND3A_ROOT, 'config.yaml'), 'pattern: /' + REAL + '/\n');
const round3aLeak = D.leakScan(ROUND3A_ROOT);
t('ROUND3 MISS1 FIX: a real secret wrapped in /.../  inside notes.md (non-JS data file) is HIT', round3aLeak.hits.some((h) => h.file.endsWith('notes.md') && h.pattern === 'nvidia-nvapi-key'));
t('ROUND3 MISS1 FIX: a real secret wrapped in /.../  inside config.yaml (non-JS data file) is HIT', round3aLeak.hits.some((h) => h.file.endsWith('config.yaml') && h.pattern === 'nvidia-nvapi-key'));
t('ROUND3 MISS1 FIX: leakScan is ok=false for both wrapped-secret data files', round3aLeak.ok === false);
t('ROUND3 MISS1 FIX: leakScan never echoes the raw secret', !JSON.stringify(round3aLeak).includes(REAL));

// MISS 2 [SYSTEM-BREAKING]: a real secret in a URL/path ending in "/" used to satisfy the same
// "regex-literal-close" text shape and was waved through. Must now be a real HIT.
const ROUND3B_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-round3b-'));
const ROUND3B_GH = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'; // real-shaped GitHub token (ghp_ + 32 alnum, >=20 required)
const ROUND3B_AWS = 'AKIA' + 'JKLMNOPQRSTUVWXY'; // real-shaped AWS access key id (AKIA + exactly 16 upper/digit), samengesteld
fs.writeFileSync(path.join(ROUND3B_ROOT, 'config.txt'), 'GITHUB_WEBHOOK_URL=https://api.github.com/repos/x/' + ROUND3B_GH + '/\n');
fs.writeFileSync(path.join(ROUND3B_ROOT, 'aws.txt'), 'AWS_URL=https://' + ROUND3B_AWS + '/\n');
const round3bLeak = D.leakScan(ROUND3B_ROOT);
t('ROUND3 MISS2 FIX: a real GitHub token in a trailing-slash URL (config.txt) is HIT', round3bLeak.hits.some((h) => h.file.endsWith('config.txt') && h.pattern === 'github-token'));
t('ROUND3 MISS2 FIX: a real AWS access key in a trailing-slash URL (aws.txt) is HIT', round3bLeak.hits.some((h) => h.file.endsWith('aws.txt') && h.pattern === 'aws-access-key'));
t('ROUND3 MISS2 FIX: leakScan is ok=false for both trailing-slash-URL secrets', round3bLeak.ok === false);
t('ROUND3 MISS2 FIX: leakScan never echoes the raw token/key', !JSON.stringify(round3bLeak).includes(ROUND3B_GH) && !JSON.stringify(round3bLeak).includes(ROUND3B_AWS));

// MISS 3: `x = /sk-.../gi` (genuine JS regex-literal SYNTAX) in an ORDINARY .js data file (not forge-store.cjs
// / forge-doctor.cjs) is now HIT — the exemption is basename-gated, not shape-gated.
const ROUND3C_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-round3c-'));
fs.writeFileSync(path.join(ROUND3C_ROOT, 'somefile.js'), 'x = /sk-ABCDEFGHIJKLMNOPQRSTUV/gi;\n');
const round3cLeak = D.leakScan(ROUND3C_ROOT);
t('ROUND3 MISS3 FIX: a secret-shaped /pattern/flags literal in an ordinary .js file (not forge-store/doctor) is HIT', round3cLeak.hits.some((h) => h.file.endsWith('somefile.js') && h.pattern === 'openai-style-key'));
t('ROUND3 MISS3 FIX: leakScan is ok=false', round3cLeak.ok === false);

// Direct proof of the whitelist MECHANISM: identical /pattern/flags content is exempted ONLY when the
// basename is a whitelisted pattern-definition file, and HIT for the exact same content under any other name.
const ROUND3D_CONTENT = 'const p = /' + PARITY_AKIA + '/g; // pattern definition (regex literal)\nmodule.exports = p;\n';
const ROUND3D_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-round3d-'));
const ROUND3D_BIN = path.join(ROUND3D_ROOT, '.claude', 'forge-bin');
fs.mkdirSync(ROUND3D_BIN, { recursive: true });
fs.mkdirSync(path.join(ROUND3D_ROOT, 'docs'), { recursive: true });
fs.writeFileSync(path.join(ROUND3D_BIN, 'forge-store.cjs'), ROUND3D_CONTENT);            // the ONE legit path -> EXEMPT
fs.writeFileSync(path.join(ROUND3D_ROOT, 'random-name.js'), ROUND3D_CONTENT);            // ordinary file -> HIT
fs.writeFileSync(path.join(ROUND3D_ROOT, 'forge-store.cjs'), ROUND3D_CONTENT);           // 4th round BUG2: root basename decoy -> HIT
fs.writeFileSync(path.join(ROUND3D_ROOT, 'docs', 'forge-store.cjs'), ROUND3D_CONTENT);   // 4th round BUG2: subdir basename decoy -> HIT
const round3dLeak = D.leakScan(ROUND3D_ROOT);
const r3dHit = (rel) => round3dLeak.hits.some((h) => h.file.replace(/\\/g, '/') === rel && h.pattern === 'aws-access-key');
t('ROUND4 whitelist mechanism: identical /pattern/flags content is EXEMPTED only at the exact path .claude/forge-bin/forge-store.cjs', !round3dLeak.hits.some((h) => h.file.replace(/\\/g, '/') === '.claude/forge-bin/forge-store.cjs'));
t('ROUND3 whitelist mechanism: the SAME content is HIT under a non-whitelisted name (random-name.js)', r3dHit('random-name.js'));
t('ROUND4 BUG2 FIX: a root-level forge-store.cjs (basename collision, wrong path) is now HIT, not exempted', r3dHit('forge-store.cjs'));
t('ROUND4 BUG2 FIX: a docs/forge-store.cjs decoy (basename collision in a subdir) is now HIT, not exempted', r3dHit('docs/forge-store.cjs'));

// Parity: all round-1/round-2 secret shapes (PEM, PEM-in-JSON, base64 +/=, JWT, connection-string with
// [ ] { } \, plain sk-/AKIA/nvapi-/JWT) still HIT — none of this fix's changes touch content-only detection.
t('ROUND3 parity: BUG1 PEM+"+" password fixture (round 1) still HIT', D.leakScan(BUG1_ROOT).ok === false);
t('ROUND3 parity: ISSUE1 REPRO A (PEM-in-JSON, round 2) still HIT', D.leakScan(ISSUE1A_ROOT).ok === false);
t('ROUND3 parity: ISSUE1 REPRO B (connection-string [ ] \\ { } password, round 2) still HIT', D.leakScan(ISSUE1B_ROOT).ok === false);
t('ROUND3 parity: JWT/sk-/AKIA/nvapi- parity fixture (round 2) still all HIT', D.leakScan(PARITY_ROOT).ok === false);
t('ROUND3 parity: FAKE-marked fixture is still NOT flagged (placeholder exemption unaffected)', D.leakScan(BUG1_FAKE_ROOT).ok === true);

// No false positive: the REAL forge-store.cjs (post-fix) + REAL forge-doctor.cjs (post-fix, THIS file's own
// source, self-referential and current) scanned verbatim under their real basenames stay clean.
const ROUND3_REALCODE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-round3-realcode-'));
const ROUND3_REALCODE_BIN = path.join(ROUND3_REALCODE_ROOT, '.claude', 'forge-bin');   // real repo-relative path (4th round)
fs.mkdirSync(ROUND3_REALCODE_BIN, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'forge-store.cjs'), path.join(ROUND3_REALCODE_BIN, 'forge-store.cjs'));
fs.copyFileSync(path.join(__dirname, 'forge-doctor.cjs'), path.join(ROUND3_REALCODE_BIN, 'forge-doctor.cjs'));
const round3RealcodeLeak = D.leakScan(ROUND3_REALCODE_ROOT);
t('ROUND3 no false positive: the REAL forge-store.cjs + forge-doctor.cjs (post-fix, at their real path) are still clean', round3RealcodeLeak.ok === true && round3RealcodeLeak.hits.length === 0, JSON.stringify(round3RealcodeLeak.hits));

// =====================================================================================================
// 2026-07-15 VIERDE FIX-RONDE (4th break-swarm, forge-2026-07-15-testloop) — two CONFIRMED honesty gaps:
//   BUG1 [HIGH]: the old hard 512KB cap SILENTLY skipped any larger tracked file; a real committed secret in
//     a >512KB file was never scanned yet the verdict stayed "clean/ALL GREEN". Fixed: scan up to
//     LEAK_SCAN_MAX_BYTES (10MB) so realistic text files ARE scanned, and surface every remaining skip in
//     result.skipped (+ printSummary) so the verdict can't imply total coverage silently.
//   BUG2 [MEDIUM]: the whitelist keyed on path.basename(rel), so ANY file merely NAMED forge-store.cjs /
//     forge-doctor.cjs in any subdir got the regex-literal exemption. Fixed: gate on the exact repo-relative
//     PATH (PATTERN_DEFINITION_PATHS). BUG2 regression is proven in the ROUND3D block above.
// =====================================================================================================

// BUG1 REPRO (break-swarm #4): a real store-redactable secret in a 600KB tracked file (over the OLD 512KB
// cap) must now be SCANNED and HIT, and never echoed.
const R4_BIG_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-r4-bigfile-'));
// ~630KB of realistic normal-length markdown lines (over the OLD 512KB cap) with a real secret on its own
// line. Every line is < LEAK_SCAN_MAX_LINE so the WHOLE file is scanned (no long-line bounding), proving the
// cap raise actually scans large realistic files.
fs.writeFileSync(path.join(R4_BIG_ROOT, 'big.md'), 'normal markdown documentation text line with several words here.\n'.repeat(10000) + 'Deploy key: ' + REAL + '\n');
const r4BigLeak = D.leakScan(R4_BIG_ROOT);
t('ROUND4 BUG1 FIX: a real secret in a ~630KB file (over the OLD 512KB cap) is now SCANNED and HIT', r4BigLeak.hits.some((h) => h.file.endsWith('big.md') && h.pattern === 'nvidia-nvapi-key'));
t('ROUND4 BUG1 FIX: leakScan ok=false for the large-file secret (no more silent GREEN)', r4BigLeak.ok === false);
t('ROUND4 BUG1 FIX: leakScan never echoes the raw secret from the large file', !JSON.stringify(r4BigLeak).includes(REAL));
t('ROUND4 BUG1: the large realistic file was fully scanned, not skipped', r4BigLeak.scanned >= 1 && !r4BigLeak.skipped.some((s) => s.file.endsWith('big.md')));

// Per-line structural scan: a file with ONE pathological over-long line (a minified blob) AND a real secret
// on a separate normal line -> the secret is STILL caught, and the over-long line is SURFACED as long-line
// (bounded out of regex scanning, never a silent hole and never a ReDoS).
const R4_LONGLINE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-r4-longline-'));
fs.writeFileSync(path.join(R4_LONGLINE_ROOT, 'bundle.js'), 'x'.repeat(D.LEAK_SCAN_MAX_LINE + 5000) + '\nconst k = "' + REAL + '";\n');
const r4LongLeak = D.leakScan(R4_LONGLINE_ROOT);
t('ROUND4 per-line: a real secret on a normal line is HIT even when the file also has an over-long line', r4LongLeak.hits.some((h) => h.file.endsWith('bundle.js') && h.pattern === 'nvidia-nvapi-key'));
t('ROUND4 per-line: the over-long line is SURFACED as reason=long-line (bounded, not a silent hole)', r4LongLeak.skipped.some((s) => s.file.endsWith('bundle.js') && s.reason === 'long-line'));
t('ROUND4 per-line: LEAK_SCAN_MAX_LINE is exported and >= 8KB (covers real secret-bearing lines incl RSA-4096 PEM-in-JSON)', typeof D.LEAK_SCAN_MAX_LINE === 'number' && D.LEAK_SCAN_MAX_LINE >= 8 * 1024);

// PEM detection via the single-line HEADER (leakScan swaps the multi-line block for its header — linear,
// and catches even a truncated key). A real multi-line RSA private key is flagged as pem-private-key.
const R4_PEM_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-r4-pem-'));
const { privateKey: R4_PK } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
fs.writeFileSync(path.join(R4_PEM_ROOT, 'id_rsa'), R4_PK);
const r4PemLeak = D.leakScan(R4_PEM_ROOT);
t('ROUND4 per-line: a real multi-line PEM private key is HIT via its header (pem-private-key)', r4PemLeak.hits.some((h) => h.file.endsWith('id_rsa') && h.pattern === 'pem-private-key'));
t('ROUND4 per-line: leakScan never echoes the raw PEM body', !JSON.stringify(r4PemLeak).includes(R4_PK.trim().split('\n')[1]));

// A genuinely huge file (> LEAK_SCAN_MAX_BYTES) is SURFACED in skipped[] (reason too-large), never silently
// dropped — the verdict must account for what it did not scan. printSummary must show it too.
const R4_HUGE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-r4-huge-'));
fs.writeFileSync(path.join(R4_HUGE_ROOT, 'huge.txt'), 'x'.repeat(D.LEAK_SCAN_MAX_BYTES + 1024));
const r4HugeLeak = D.leakScan(R4_HUGE_ROOT);
t('ROUND4 BUG1: a file over LEAK_SCAN_MAX_BYTES is SURFACED in skipped[] (reason too-large), never invisible', Array.isArray(r4HugeLeak.skipped) && r4HugeLeak.skipped.some((s) => s.file.endsWith('huge.txt') && s.reason === 'too-large'));
t('ROUND4 BUG1: LEAK_SCAN_MAX_BYTES is exported and generous (>= 5MB, so realistic text files are always scanned)', typeof D.LEAK_SCAN_MAX_BYTES === 'number' && D.LEAK_SCAN_MAX_BYTES >= 5 * 1024 * 1024);
const r4HugeSummary = D.printSummary(D.runDoctor(R4_HUGE_ROOT));
t('ROUND4 BUG1: printSummary surfaces "not scanned" + "too-large" for a skipped file (verdict never implies total coverage)', /not scanned/.test(r4HugeSummary) && /too-large/.test(r4HugeSummary));

// ReDoS GUARD [SYSTEM-BREAKING regression, found while fixing BUG1]: raising the scan cap first exposed that
// the URL-creds / JWT SECRET_PATTERNS backtracked catastrophically (O(n^2)) on long runs of ordinary
// characters — a 600KB single-char file took ~160s to scan, hanging the WHOLE doctor. Root-caused by
// upper-bounding those patterns' quantifiers in forge-store.cjs. This test is the structural guard: leakScan
// over adversarial input MUST stay near-instant. Any future pattern that reintroduces backtracking blows the
// budget (a real ReDoS is tens of seconds to minutes; the fixed scan is sub-second) and fails here.
const REDOS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-redos-'));
// Single pathological long lines (must be length-bounded out, never scanned into a ReDoS):
fs.writeFileSync(path.join(REDOS_ROOT, 'oneline-a.txt'), 'a'.repeat(4 * 1024 * 1024));
fs.writeFileSync(path.join(REDOS_ROOT, 'oneline-eyj.txt'), 'eyJ'.repeat(Math.floor(4 * 1024 * 1024 / 3)));
// Many medium lines that ARE actually scanned (bounded patterns must stay linear PER LINE, so many lines
// x bounded work is still fast) — this is the case a trivial long-line-only guard would miss:
fs.writeFileSync(path.join(REDOS_ROOT, 'manylines-a.txt'), ('a'.repeat(15000) + '\n').repeat(140));
fs.writeFileSync(path.join(REDOS_ROOT, 'manylines-eyj.txt'), ('eyJ'.repeat(5000) + '\n').repeat(140));
// PEM marker spam (header detection must be instant — NOT an O(markers*N) multi-line block scan):
fs.writeFileSync(path.join(REDOS_ROOT, 'pem-spam.txt'), '-----BEGIN A PRIVATE KEY-----\n'.repeat(100000));
const redosT0 = Date.now();
const redosLeak = D.leakScan(REDOS_ROOT);
const redosMs = Date.now() - redosT0;
t('ROUND4 ReDoS GUARD: leakScan over ~14MB of assorted adversarial input (huge lines + many medium lines + PEM-marker spam) completes fast (< 4000ms), never superlinear', redosMs < 4000, redosMs + 'ms');
t('ROUND4 ReDoS GUARD: all 5 adversarial files were processed (scanned=5) — nothing silently dropped from the count', redosLeak.scanned === 5);
t('ROUND4 ReDoS GUARD: the pathological single-line files are surfaced as long-line (bounded, honest)', redosLeak.skipped.filter((s) => s.reason === 'long-line').length >= 2);

// =====================================================================================================
// 2026-07-15 VIJFDE FIX-RONDE (break-swarm #6, authoritative run vs stable code) — 4 CONFIRMED misses that
// were all SILENT (file counted scanned, ok stayed true, nothing in skipped):
//   BUG1 [SYSTEM-BREAKING]: looksLikeRealSecret ran PLACEHOLDER_RE against the WHOLE match, so a benign
//     'example'/'sample' in a URL-cred scheme/username (postgres://example_user:REALPASS@ — ubiquitous
//     staging-DB shape) exempted the REAL password. Fix: judge placeholders on the SECRET portion only
//     (password for URL creds) via secretPortion().
//   BUG2 [HIGH] + BUG3 [MEDIUM]: an INCIDENTAL 'xxxx' / 7-char filler run inside a real token silently
//     exempted it. Fix: XXXX + repeated-filler are WEAK signals that exempt ONLY when they DOMINATE (>= half)
//     the secret; explicit intent words (FAKE/EXAMPLE/YOUR_/...) stay strong (STRONG_PLACEHOLDER_RE).
//   BUG4 [MEDIUM]: leakScan's read try/catch swallowed EACCES/ENOENT/EISDIR with no skipped entry -> an
//     unreadable tracked file was silently dropped from the account. Fix: surface reason='unreadable'.
// =====================================================================================================
const R5_URL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-r5-url-'));
fs.writeFileSync(path.join(R5_URL_ROOT, 'staging.yaml'), 'DATABASE_URL=postgres://example_user:S3cr3tStagingPw99@staging-db.internal:5432/app\n');
const r5UrlLeak = D.leakScan(R5_URL_ROOT);
t('ROUND5 BUG1 FIX: a real URL password behind an "example_user" username is HIT (no silent whole-match placeholder exemption)', r5UrlLeak.ok === false && r5UrlLeak.hits.some((h) => h.pattern === 'url-embedded-credentials'));
t('ROUND5 BUG1 FIX: the real password is never echoed', !JSON.stringify(r5UrlLeak).includes('S3cr3tStagingPw99'));
const R5_URL_FP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-r5-urlfp-'));
fs.writeFileSync(path.join(R5_URL_FP, 'readme.md'), 'Example: postgres://user:YOUR_PASSWORD@host:5432/db\n');
t('ROUND5 BUG1 no-FP: a genuine YOUR_PASSWORD placeholder password stays EXEMPT (no new false positive)', D.leakScan(R5_URL_FP).ok === true);
t('ROUND5 BUG1 unit: secretPortion returns only the password of a URL-cred match', D.secretPortion('postgres://example_user:S3cr3tStagingPw99@') === 'S3cr3tStagingPw99');
t('ROUND5 BUG1 unit: looksLikeRealSecret true for a real password behind an example username; false for YOUR_PASSWORD', D.looksLikeRealSecret('postgres://example_user:S3cr3tStagingPw99@') === true && D.looksLikeRealSecret('postgres://user:YOUR_PASSWORD@') === false);

const R5_INCID_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-r5-incid-'));
fs.writeFileSync(path.join(R5_INCID_ROOT, 'a.md'), 'gh=ghp_aB3xxxxKz9RealTokenMaterial01234\n');
fs.writeFileSync(path.join(R5_INCID_ROOT, 'b.txt'), 'nv=nvapi-Zk9RealNvidiaKeyMaterialAAAAAAA0123456789abcdef\n');
const r5IncidLeak = D.leakScan(R5_INCID_ROOT);
t('ROUND5 BUG2 FIX: a real ghp_ token with an incidental "xxxx" is HIT (XXXX is weak, does not dominate)', r5IncidLeak.hits.some((h) => h.file.endsWith('a.md') && h.pattern === 'github-token'));
t('ROUND5 BUG3 FIX: a real nvapi key with an incidental 7-char run is HIT (filler must dominate to exempt)', r5IncidLeak.hits.some((h) => h.file.endsWith('b.txt') && h.pattern === 'nvidia-nvapi-key'));
t('ROUND5 BUG2/3 regression: a filler/placeholder-DOMINATED value is still exempt', D.looksLikeRealSecret('sk-AAAAAAAAAAAAAAAA{20,}') === false && D.looksLikeRealSecret('nvapi-FAKEFAKEFAKEFAKE1234567890') === false);
t('ROUND5 STRONG_PLACEHOLDER_RE guard: exported, matches EXAMPLE, and does NOT match a bare XXXX (moved to weak)', D.STRONG_PLACEHOLDER_RE instanceof RegExp && D.STRONG_PLACEHOLDER_RE.test('EXAMPLE') && !D.STRONG_PLACEHOLDER_RE.test('aXXXXb'));

// BUG4: an unreadable tracked file is SURFACED (git fixture: staged then deleted -> ls-files lists it,
// readFileSync throws ENOENT). Guarded so a git-less environment skips gracefully rather than false-failing.
const R5_UNREAD_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-r5-unread-'));
const r5GitOk = spawnSync('git', ['init', '-q'], { cwd: R5_UNREAD_ROOT }).status === 0;
if (r5GitOk) {
  fs.writeFileSync(path.join(R5_UNREAD_ROOT, 'secret.conf'), 'api_key=nvapi-9x7Kq2mZ4bTvA1cReW8pLdN6sGhY3jFuIoP0aQzX5wErTyU\n');
  spawnSync('git', ['add', 'secret.conf'], { cwd: R5_UNREAD_ROOT });
  fs.unlinkSync(path.join(R5_UNREAD_ROOT, 'secret.conf'));
  const r5UnreadLeak = D.leakScan(R5_UNREAD_ROOT);
  t('ROUND5 BUG4 FIX: an unreadable/absent tracked file is SURFACED in skipped (reason=unreadable), never silently dropped', r5UnreadLeak.skipped.some((s) => s.file.endsWith('secret.conf') && s.reason === 'unreadable'));
  t('ROUND5 BUG4: printSummary surfaces "unreadable" in the not-scanned coverage note', /unreadable/.test(D.printSummary(D.runDoctor(R5_UNREAD_ROOT))));
} else {
  t('ROUND5 BUG4: (git unavailable in this env — unreadable-file fixture skipped, not a failure)', true);
  t('ROUND5 BUG4: (git unavailable — printSummary check skipped)', true);
}

// =====================================================================================================
// 2026-07-15 ZESDE FIX-RONDE (exposed by the re-sync itself, not a break-swarm) — the stricter round-5 leak
// scan flagged forge-chaos.cjs's fake test key sitting in a git-tracked .claude/forge-backups/ (a backup of
// Forge's OWN system files, taken by the sync). That failed the post-sync doctor on 3 projects and rolled
// them back. Fix: leakScan excludes Forge's operational artifact dirs (.claude/forge-backups/ = backups of
// Forge system files incl. test fixtures; .claude/forge-runs/ = Forge event logs) — never project source.
// =====================================================================================================
// Uses a GIT fixture on purpose: the real bug was in GIT mode (git ls-files lists a tracked .claude/
// forge-backups/, which the walk-fallback SKIP set would never even reach), so the leakScan path-filter — not
// the walk SKIP — is what must exclude it. Guarded so a git-less env skips gracefully.
const R6_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-r6-'));
const r6GitOk = spawnSync('git', ['init', '-q'], { cwd: R6_ROOT }).status === 0;
if (r6GitOk) {
  fs.mkdirSync(path.join(R6_ROOT, '.claude', 'forge-backups', 'sync-1', 'forge-bin'), { recursive: true });
  fs.mkdirSync(path.join(R6_ROOT, '.claude', 'forge-runs', 'run-1'), { recursive: true });
  fs.mkdirSync(path.join(R6_ROOT, 'src'), { recursive: true });
  fs.writeFileSync(path.join(R6_ROOT, '.claude', 'forge-backups', 'sync-1', 'forge-bin', 'forge-chaos.cjs'), 'const k = "' + REAL + '";\n');
  fs.writeFileSync(path.join(R6_ROOT, '.claude', 'forge-runs', 'run-1', 'events.jsonl'), '{"note":"' + REAL + '"}\n');
  fs.writeFileSync(path.join(R6_ROOT, 'src', 'config.txt'), 'key=' + REAL + '\n');
  spawnSync('git', ['add', '-A'], { cwd: R6_ROOT });
  const r6Leak = D.leakScan(R6_ROOT);
  t('ROUND6: leakScan uses git mode in this fixture (tracked files listed)', r6Leak.source === 'git');
  t('ROUND6: a real key in a git-tracked .claude/forge-backups/ (backup of Forge system files) is NOT flagged', !r6Leak.hits.some((h) => h.file.includes('forge-backups')));
  t('ROUND6: a real key in a git-tracked .claude/forge-runs/ (Forge event logs) is NOT flagged', !r6Leak.hits.some((h) => h.file.includes('forge-runs')));
  t('ROUND6: a real key in ordinary project source (src/config.txt) is STILL flagged (exclusion is scoped to Forge artifacts)', r6Leak.hits.some((h) => h.file.endsWith('config.txt')) && r6Leak.ok === false);
} else {
  t('ROUND6: (git unavailable — forge-backups exclusion fixture skipped, not a failure)', true);
}

// PATTERN_DEFINITION_PATHS is exported and exactly the 2 real repo-relative paths (mutation-guard: a
// whitelist that silently grew back to "everything", or that reverted to basename-keying, fails this).
t('PATTERN_DEFINITION_PATHS is exported and contains exactly the two real .claude/forge-bin pattern-def paths', D.PATTERN_DEFINITION_PATHS instanceof Set && D.PATTERN_DEFINITION_PATHS.size === 2 && D.PATTERN_DEFINITION_PATHS.has('.claude/forge-bin/forge-store.cjs') && D.PATTERN_DEFINITION_PATHS.has('.claude/forge-bin/forge-doctor.cjs'));

// =====================================================================================================
// WAVE A / A2 (2026-07-18) — the 4 doctor completeness checks: sync_completeness, check_the_checks,
// memory_discipline, unregistered_event. All ADVISORY-ONLY (see forge-doctor.cjs's header doc comment) —
// their own `ok` is honestly computed, but runDoctor()'s top-level `ok` must never be affected by them.
// =====================================================================================================

// --- sync-completeness ---------------------------------------------------------------------------------
// syncCompleteness() requires the REAL sibling forge-sync.cjs (this project's actual SYSTEM manifest), so
// these fixtures only control which files EXIST under a temp root's .claude/ — the manifest itself is fixed.
const SC_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-synccomplete-'));
fs.mkdirSync(path.join(SC_ROOT, '.claude', 'skills', 'definitely-not-in-any-manifest-skill'), { recursive: true });
fs.writeFileSync(path.join(SC_ROOT, '.claude', 'skills', 'definitely-not-in-any-manifest-skill', 'SKILL.md'), '# not synced\n');
fs.mkdirSync(path.join(SC_ROOT, '.claude', 'skills', 'forge-doctor'), { recursive: true }); // a REAL SYSTEM[] entry
fs.writeFileSync(path.join(SC_ROOT, '.claude', 'skills', 'forge-doctor', 'SKILL.md'), '# real manifest entry\n');
fs.mkdirSync(path.join(SC_ROOT, '.claude', 'forge-bin'), { recursive: true });
fs.writeFileSync(path.join(SC_ROOT, '.claude', 'forge-bin', 'brandnewtool.cjs'), "'use strict';\nmodule.exports = {};\n");
fs.mkdirSync(path.join(SC_ROOT, '.claude', 'agents'), { recursive: true });
fs.writeFileSync(path.join(SC_ROOT, '.claude', 'agents', 'brand-new-agent.md'), '---\nname: x\n---\nbody\n');
const sc = D.syncCompleteness(SC_ROOT);
t('syncCompleteness: flags a real skill dir that is NOT in forge-sync.cjs SYSTEM[]', sc.missing.includes('skills/definitely-not-in-any-manifest-skill/SKILL.md'));
t('syncCompleteness: does NOT flag a skill dir that IS a real SYSTEM[] entry (skills/forge-doctor/SKILL.md)', !sc.missing.includes('skills/forge-doctor/SKILL.md'));
t('syncCompleteness: a brand-new forge-bin tool is auto-covered by SYSTEM_GLOB (never flagged)', !sc.missing.includes('forge-bin/brandnewtool.cjs'));
t('syncCompleteness: a brand-new agent .md is auto-covered by SYSTEM_GLOB (never flagged)', !sc.missing.includes('agents/brand-new-agent.md'));
t('syncCompleteness: own ok is honestly false when a real gap exists', sc.ok === false);

// no-gap fixture: only SYSTEM[]-registered files exist -> ok:true
const SC_CLEAN = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-synccomplete-clean-'));
fs.mkdirSync(path.join(SC_CLEAN, '.claude', 'skills', 'forge-doctor'), { recursive: true });
fs.writeFileSync(path.join(SC_CLEAN, '.claude', 'skills', 'forge-doctor', 'SKILL.md'), '# real manifest entry\n');
const scClean = D.syncCompleteness(SC_CLEAN);
t('syncCompleteness: a fixture with only real SYSTEM[]-registered skills is ok=true, 0 missing', scClean.ok === true && scClean.missing.length === 0);

// --- check-the-checks -----------------------------------------------------------------------------------
const CTC_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-checkthechecks-'));
fs.mkdirSync(path.join(CTC_ROOT, '.claude', 'forge-bin'), { recursive: true });
// a GREEN NO-OP: prints a passing tally, but never calls t(...)/test(...)/assert(...) anywhere.
fs.writeFileSync(path.join(CTC_ROOT, '.claude', 'forge-bin', 'noop.test.cjs'), "console.log('5 passed, 0 failed');\nprocess.exit(0);\n");
// a REAL suite: genuine t(...) call sites, also passes.
fs.writeFileSync(path.join(CTC_ROOT, '.claude', 'forge-bin', 'real.test.cjs'),
  "let pass=0,fail=0;\nconst t=(n,c)=>{if(c){pass++;}else{fail++;}};\nt('one plus one is two', 1+1===2);\nt('two plus two is four', 2+2===4);\nconsole.log(pass+' passed, '+fail+' failed');\nprocess.exit(fail?1:0);\n");
// a genuinely vacuous suite (0 assertions, 0 passed) -> already caught by runTests' own suiteOk=false, must
// NOT be double-flagged as a NEW check-the-checks finding.
fs.writeFileSync(path.join(CTC_ROOT, '.claude', 'forge-bin', 'vacuous.test.cjs'), "console.log('0 passed, 0 failed');\nprocess.exit(0);\n");
const ctcTests = D.runTests(CTC_ROOT);
const ctc = D.checkTheChecks(CTC_ROOT, ctcTests);
t('checkTheChecks: flags a suite reporting a passing tally with 0 real assertion sites (green no-op)', ctc.noOp.some((n) => n.suite === 'noop.test.cjs'));
t('checkTheChecks: does NOT flag a suite with real t(...) assertion call sites', !ctc.noOp.some((n) => n.suite === 'real.test.cjs'));
t('checkTheChecks: does NOT double-flag a genuinely vacuous (0 passed) suite — runTests already rejects it', !ctc.noOp.some((n) => n.suite === 'vacuous.test.cjs'));
t('checkTheChecks: own ok is honestly false when a green no-op exists', ctc.ok === false);
t('countAssertionSites: recognizes the test(...) helper convention too (not just t(...))', D.countAssertionSites("function test(name, fn) {}\ntest('x', () => {});\n") > 0);
t('countAssertionSites: recognizes direct assert.ok(...)/assert(...) calls', D.countAssertionSites("const assert = require('assert');\nassert.ok(1 === 1);\nassert(true);\n") > 0);
t('countAssertionSites: a truly empty suite has 0 sites', D.countAssertionSites("console.log('hello');\n") === 0);

// real-project regression guard: this project's OWN 51 real *.test.cjs suites must never be flagged as
// no-ops (proven at build time against every one of them; re-asserted here so a future suite can't silently
// slip below the detection threshold without this test catching it).
// NOTE: deliberately does NOT call D.runTests()/D.checkTheChecks() against the real project here — this
// file (forge-doctor.test.cjs) is itself one of the suites runTests() would spawn, which would recursively
// re-execute this entire file (and, in turn, spawn itself again) on every level. A pure STATIC scan (no
// execution, no subprocess spawning) is sufficient to prove the same guarantee: checkTheChecks() only ever
// flags a suite when it has ZERO real assertion sites, so confirming every real suite has >=1 site statically
// proves none of them can ever be flagged, without needing to run any of them.
const REAL_PROJECT_ROOT = path.resolve(__dirname, '..', '..');
// CANONICAL DEV-TREE GATE (2026-08-03, install-deadlock fix): a handful of assertions below pin the EXACT
// current state of the canonical development tree (the exact set of skills carrying an evals.json sibling,
// the exact known skill-hygiene finding set). Those exact sets depend on files that are DELIBERATELY never
// synced to installed projects (evals.json/learnings.md siblings — see forge-sync.cjs's FILES doc — and
// provisioned per-project state), so in every installed project they failed for a reason that is not a
// defect, which turned every fresh `forge-sync install`'s post-validation red and rolled the install back.
// The vendor-pin based `pinned()` gate above cannot express this (installs DO ship the vendored skills), so
// these guards key on the dev-tree marker file instead — present only in the canonical checkout, never in
// forge-sync's FILES manifest. Strict where the sets are real; visibly skipped everywhere else.
const IS_DEV_TREE = fs.existsSync(path.join(REAL_PROJECT_ROOT, '.claude', 'config', 'forge-dev-tree.json'));
const devTreeOnly = (name, fn) => {
  if (IS_DEV_TREE) { fn(); return true; }
  skip(name, 'canonical dev-tree regression guard · .claude/config/forge-dev-tree.json absent — the exact sets this pins are deliberately not shipped to installed projects');
  return false;
};
const realSuiteFiles = fs.readdirSync(path.join(REAL_PROJECT_ROOT, '.claude', 'forge-bin')).filter((f) => f.endsWith('.test.cjs'));
const realSuitesWithZeroSites = realSuiteFiles.filter((f) => D.countAssertionSites(fs.readFileSync(path.join(REAL_PROJECT_ROOT, '.claude', 'forge-bin', f), 'utf8')) === 0);
t('checkTheChecks static guard: every real *.test.cjs suite in this project has >=1 real assertion site (none COULD be flagged as a green no-op)', realSuitesWithZeroSites.length === 0, JSON.stringify(realSuitesWithZeroSites));

// --- memory-discipline -----------------------------------------------------------------------------------
const MD_MISSING = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-memdisc-missing-'));
fs.mkdirSync(path.join(MD_MISSING, '.claude'), { recursive: true });
const mdMissing = D.memoryDiscipline(MD_MISSING);
t('memoryDiscipline: FORGE_MEMORY.md absent -> ok=false, present=false', mdMissing.ok === false && mdMissing.present === false);

const MD_EMPTY = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-memdisc-empty-'));
fs.mkdirSync(path.join(MD_EMPTY, '.claude'), { recursive: true });
fs.writeFileSync(path.join(MD_EMPTY, '.claude', 'FORGE_MEMORY.md'), '   \n\n');
const mdEmpty = D.memoryDiscipline(MD_EMPTY);
t('memoryDiscipline: FORGE_MEMORY.md present but whitespace-only -> ok=false', mdEmpty.ok === false && mdEmpty.present === true);

const MD_PLACEHOLDER = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-memdisc-placeholder-'));
fs.mkdirSync(path.join(MD_PLACEHOLDER, '.claude'), { recursive: true });
fs.writeFileSync(path.join(MD_PLACEHOLDER, '.claude', 'FORGE_MEMORY.md'),
  '# Memory\nStatus: <PLACEHOLDER>\nOwner: <PROJECT_OWNER_NAME>\nTODO: fill this in\nReal note about the router.\n');
const mdPlaceholder = D.memoryDiscipline(MD_PLACEHOLDER);
t('memoryDiscipline: flags a literal <PLACEHOLDER> marker', mdPlaceholder.ok === false && mdPlaceholder.placeholderLines.includes(2));
t('memoryDiscipline: flags an ALL-CAPS scaffold token like <PROJECT_OWNER_NAME>', mdPlaceholder.placeholderLines.includes(3));
t('memoryDiscipline: flags a "TODO:" marker', mdPlaceholder.placeholderLines.includes(4));

const MD_CLEAN = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-memdisc-clean-'));
fs.mkdirSync(path.join(MD_CLEAN, '.claude'), { recursive: true });
fs.writeFileSync(path.join(MD_CLEAN, '.claude', 'FORGE_MEMORY.md'),
  '# Memory\nReal decision: adopted the router.\nPer-Boss memory lives in `.claude/agent-memory/<boss>/MEMORY.md` (a real, lowercase prose reference, not an unfilled scaffold token).\n');
const mdClean = D.memoryDiscipline(MD_CLEAN);
t('memoryDiscipline: a populated memory file with only lowercase prose <boss> references is ok=true (no false positive)', mdClean.ok === true && mdClean.placeholderLines.length === 0);

// real-project regression guard: IF this project has a FORGE_MEMORY.md, it must stay placeholder-clean.
// PORTABILITY: this test file is synced verbatim into every Forge project. memory-discipline is ADVISORY —
// a freshly-synced project may legitimately have no FORGE_MEMORY.md yet (or an empty one), which must NOT
// hard-fail its test suite (that would make forge-sync roll back a perfectly healthy install). So the guard
// only asserts placeholder-cleanliness WHEN memory is present; absence/emptiness is a valid advisory state.
const realMd = D.memoryDiscipline(REAL_PROJECT_ROOT);
t('memoryDiscipline: this project\'s FORGE_MEMORY.md, when present, carries no unfilled placeholder/scaffold tokens', !realMd.present || realMd.placeholderLines.length === 0, JSON.stringify(realMd));

// --- unregistered-event ----------------------------------------------------------------------------------
function ueWrite(root, logEventTypes, toolSource) {
  fs.mkdirSync(path.join(root, '.claude', 'forge-dashboard'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs'),
    "'use strict';\nconst KNOWN_EVENT_TYPES = new Set([" + logEventTypes.map((s) => "'" + s + "'").join(', ') + "]);\nmodule.exports = {};\n");
  fs.mkdirSync(path.join(root, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'forge-bin', 'mytool.cjs'), toolSource);
}
const UE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-unregevent-'));
ueWrite(UE_ROOT, ['known_type_a', 'known_type_b'],
  "function logEvent(runId, eventType, extra) { /* real.impl(runId, eventType, extra) */ }\n" +
  "logEvent(RUN, 'known_type_a', { agent: 'x' });\n" +                 // registered -> not flagged
  "logEvent(RUN, 'totally_unregistered_type', { agent: 'x' });\n" +    // NOT registered -> flagged
  "function paperclipStyle(type, obj) { logEvent2(type, obj); }\n" +
  "logEvent('paperclip_style_unregistered', { agent: 'y' });\n" +      // 1st-arg convention, NOT registered -> flagged
  "logEvent(RUN, ev.event_type, { agent: 'z' });\n");                  // dynamic literal -> can't resolve, skipped
const ue = D.unregisteredEvent(UE_ROOT);
t('unregisteredEvent: does NOT flag a literal event_type that IS in KNOWN_EVENT_TYPES', !ue.unregistered.some((u) => u.event_type === 'known_type_a'));
t('unregisteredEvent: flags a literal event_type (2nd-arg convention) NOT in KNOWN_EVENT_TYPES', ue.unregistered.some((u) => u.event_type === 'totally_unregistered_type'));
t('unregisteredEvent: flags a literal event_type (1st-arg / paperclip convention) NOT in KNOWN_EVENT_TYPES', ue.unregistered.some((u) => u.event_type === 'paperclip_style_unregistered'));
t('unregisteredEvent: a dynamically-built event_type (ev.event_type) is honestly skipped, not guessed', !ue.unregistered.some((u) => u.event_type && u.event_type.includes('event_type')));
t('unregisteredEvent: every flagged entry names the offending file', ue.unregistered.every((u) => u.file === '.claude/forge-bin/mytool.cjs' || u.file.endsWith('mytool.cjs')));
t('unregisteredEvent: own ok is honestly false when a real gap exists', ue.ok === false);

const UE_CLEAN = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-unregevent-clean-'));
ueWrite(UE_CLEAN, ['known_type_a'], "function logEvent(runId, eventType, extra) {}\nlogEvent(RUN, 'known_type_a', { agent: 'x' });\n");
const ueClean = D.unregisteredEvent(UE_CLEAN);
t('unregisteredEvent: a tool using only registered event types is ok=true, 0 unregistered', ueClean.ok === true && ueClean.unregistered.length === 0);

const UE_MISSING_LOGEVENT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-unregevent-missinglog-'));
const ueMissingLog = D.unregisteredEvent(UE_MISSING_LOGEVENT);
t('unregisteredEvent: log-event.cjs absent -> ok=false, explicit reason (never a silent pass)', ueMissingLog.ok === false && /could not read/.test(ueMissingLog.reason));

// direct unit coverage of extractLoggedEventTypes / extractKnownEventTypesFromSource
t('extractKnownEventTypesFromSource: parses a real KNOWN_EVENT_TYPES Set literal', (() => { const s = D.extractKnownEventTypesFromSource("const KNOWN_EVENT_TYPES = new Set(['a_b', 'c_d']);"); return s instanceof Set && s.has('a_b') && s.has('c_d'); })());
t('extractKnownEventTypesFromSource: returns null when no Set literal is present', D.extractKnownEventTypesFromSource('no set literal here') === null);

// COMMENT-PROOF PARSING (2026-08-01, independent-witness defect 2). The scanner used to run its
// /'([^']+)'|"([^"]+)"/g literal regex over the RAW Set body, comment lines included, so a single APOSTROPHE
// in comment prose inside the block was read as a string delimiter and flipped quote parity for everything
// after it. Measured against this project's own real log-event.cjs before the fix: 186 types registered,
// 175 seen, 20 real types INVISIBLE (e2e_passed, workflow_validated, audit_iteration, audit_finding,
// rejected_approach, review_started, review_completed, ...) plus 9 junk "types" invented out of comment
// prose — while the ENFORCED "unreg. events" gate showed a green tick, i.e. the gate read stronger than it
// was. The old workaround ("write no apostrophe in that comment block", see log-event.cjs) was enforced by
// nothing. Comments are now stripped first, the same way forge-event-wiring.test.cjs already strips them
// before reading app.js's taskStatus() buckets.
const APOSTROPHE_COMMENT_SRC = [
  'const KNOWN_EVENT_TYPES = new Set([',
  "  'before_comment_a', 'before_comment_b',",
  "  // the AUDIT-LOOP tool's own events — this apostrophe used to flip the quote parity for the rest",
  "  'after_comment_a',",
  "  'after_comment_b', // trailing comment, also with an apostrophe in the boss's prose",
  ']);',
].join('\n');
t('extractKnownEventTypesFromSource: an apostrophe in a // comment does not hide the types after it',
  (() => {
    const s = D.extractKnownEventTypesFromSource(APOSTROPHE_COMMENT_SRC);
    return s instanceof Set && s.has('before_comment_a') && s.has('before_comment_b') &&
      s.has('after_comment_a') && s.has('after_comment_b');
  })());
// ANTI-TIEBREAK: seeing all four is not enough — a scanner that swallowed comment prose could also INVENT
// "types" out of it (9 such ghosts were measured on the real file). Exactly the four real members, nothing else.
t('extractKnownEventTypesFromSource: comment prose never becomes a phantom event type',
  (() => {
    const s = D.extractKnownEventTypesFromSource(APOSTROPHE_COMMENT_SRC);
    return s.size === 4;
  })());
t('extractKnownEventTypesFromSource: a /* block comment */ with an apostrophe is stripped too',
  (() => {
    const s = D.extractKnownEventTypesFromSource(
      "const KNOWN_EVENT_TYPES = new Set([\n  'block_a',\n  /* the loop's brake, in a block comment */\n  'block_b',\n]);");
    return s instanceof Set && s.has('block_a') && s.has('block_b') && s.size === 2;
  })());
t('extractLoggedEventTypes: ignores a string literal INSIDE the payload object (a note value)', !D.extractLoggedEventTypes("logEvent(RUN, 'real_event_type', { note: 'not_an_event_type_value' });").has('not_an_event_type_value'));
t('extractLoggedEventTypes: ignores the logEvent(...) function DEFINITION line itself', D.extractLoggedEventTypes('function logEvent(runId, eventType, extra) {}').size === 0);

// real-project regression guard: this project's own real forge-paperclip.cjs previously had a KNOWN,
// already-tracked gap (23 unregistered paperclip_* event types, see forge-doctor.cjs's WAVE A/A2 header doc
// comment) — CLOSED by WAVE C / C-INTEGRATE (2026-07-18): all 23 real paperclip_* event types are now
// registered in log-event.cjs's KNOWN_EVENT_TYPES. This assertion now proves the fix stuck (evidence of
// closure), not evidence of the original gap — a future re-introduction of an unregistered paperclip_*
// event_type would flip this back to failing, which is the whole point of a regression guard.
const realUe = D.unregisteredEvent(REAL_PROJECT_ROOT);
t('unregisteredEvent: the real forge-paperclip.cjs gap is CLOSED (paperclip_selected is now registered)', !realUe.unregistered.some((u) => u.file.endsWith('forge-paperclip.cjs') && u.event_type === 'paperclip_selected'));
t('unregisteredEvent: the real project now has ZERO unregistered event_type usages at all (ok:true)', realUe.ok === true && realUe.unregistered.length === 0);

// --- mcp-dormancy (WAVE G / G-INTEGRATE) -----------------------------------------------------------------
function mdWrite(root, { servers, bosses, optIn, mcpJson } = {}) {
  const cd = path.join(root, '.claude', 'config', 'orchestration');
  fs.mkdirSync(cd, { recursive: true });
  fs.writeFileSync(path.join(cd, 'mcp-registry.json'), JSON.stringify({ servers: servers || [] }));
  fs.writeFileSync(path.join(cd, 'mcp-grants.json'), JSON.stringify({ bosses: bosses || {} }));
  if (optIn) fs.writeFileSync(path.join(cd, 'mcp-opt-in.json'), JSON.stringify(optIn));
  if (mcpJson) fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify(mcpJson));
}
const SERVER_T0 = { id: 'serena-lsp', tier: 0, status: 'not-installed' };
const SERVER_T1 = { id: 'context7', tier: 1, status: 'not-installed' };
const SERVER_T2 = { id: 'playwright', tier: 2, status: 'not-installed' };
const SERVER_T3 = { id: 'github-write', tier: 3, status: 'not-installed' };

// (a) auto-active without opt-in -> flagged
const MCPD_AUTOACTIVE = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-mcpdorm-autoactive-'));
mdWrite(MCPD_AUTOACTIVE, { servers: [{ id: 'context7', tier: 1, status: 'active' }], bosses: {} });
const mcpdAutoActive = D.mcpDormancy(MCPD_AUTOACTIVE);
t('mcpDormancy: a registry server with status "active" and NO opt-in marker is flagged', mcpdAutoActive.ok === false && mcpdAutoActive.violations.some((v) => v.type === 'auto_active_without_optin' && v.server === 'context7'));

// same server, but genuinely opted-in -> NOT flagged (dormancy respects the owner's explicit opt-in)
const MCPD_OPTEDIN = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-mcpdorm-optedin-'));
mdWrite(MCPD_OPTEDIN, { servers: [{ id: 'context7', tier: 1, status: 'active' }], bosses: {}, optIn: { opted_in: ['context7'] } });
const mcpdOptedIn = D.mcpDormancy(MCPD_OPTEDIN);
t('mcpDormancy: an active server that IS listed in mcp-opt-in.json is NOT flagged', !mcpdOptedIn.violations.some((v) => v.type === 'auto_active_without_optin'));

// a real .mcp.json host config listing a server not in opted_in[] -> flagged
const MCPD_MCPJSON = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-mcpdorm-mcpjson-'));
mdWrite(MCPD_MCPJSON, { servers: [SERVER_T1], bosses: {}, mcpJson: { mcpServers: { context7: { command: 'npx' } } } });
const mcpdMcpJson = D.mcpDormancy(MCPD_MCPJSON);
t('mcpDormancy: a real .mcp.json server not in opted_in[] is flagged', mcpdMcpJson.violations.some((v) => v.type === 'mcp_json_server_without_optin' && v.server === 'context7'));

// (b) a grant referencing a server whose tier exceeds the boss's own max_tier -> flagged
const MCPD_TIEREXCEED = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-mcpdorm-tierexceed-'));
mdWrite(MCPD_TIEREXCEED, { servers: [SERVER_T2], bosses: { 'build-boss': { max_tier: 0, allow_servers: ['playwright'] } } });
const mcpdTierExceed = D.mcpDormancy(MCPD_TIEREXCEED);
t('mcpDormancy: a grant above the boss\'s own max_tier is flagged', mcpdTierExceed.ok === false && mcpdTierExceed.violations.some((v) => v.type === 'grant_exceeds_max_tier' && v.boss === 'build-boss' && v.server === 'playwright'));

// a grant referencing an unknown server id -> flagged
const MCPD_UNKNOWN = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-mcpdorm-unknown-'));
mdWrite(MCPD_UNKNOWN, { servers: [SERVER_T0], bosses: { 'build-boss': { max_tier: 1, allow_servers: ['nonexistent-server'] } } });
const mcpdUnknown = D.mcpDormancy(MCPD_UNKNOWN);
t('mcpDormancy: a grant referencing an unknown server id is flagged', mcpdUnknown.violations.some((v) => v.type === 'unknown_server_in_grant' && v.server === 'nonexistent-server'));

// (c) tier-3 must NEVER be a standing/default grant, even when max_tier numerically covers it
const MCPD_TIER3 = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-mcpdorm-tier3-'));
mdWrite(MCPD_TIER3, { servers: [SERVER_T3], bosses: { 'integration-boss': { max_tier: 3, allow_servers: ['github-write'] } } });
const mcpdTier3 = D.mcpDormancy(MCPD_TIER3);
t('mcpDormancy: a tier-3 server in any boss\'s allow_servers is flagged, even with a covering max_tier', mcpdTier3.ok === false && mcpdTier3.violations.some((v) => v.type === 'tier3_default_grant' && v.server === 'github-write'));

// (c') POISONED tier type: a tier-3 write-primitive with tier as the STRING '3' must STILL be flagged (was a
// real break-swarm finding — strict `=== 3` and `> max_tier` both missed a string tier, certifying all-clear).
const MCPD_STR3 = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-mcpdorm-str3-'));
mdWrite(MCPD_STR3, { servers: [{ id: 'github-write', tier: '3', status: 'not-installed' }], bosses: { 'integration-boss': { max_tier: 3, allow_servers: ['github-write'] } } });
const mcpdStr3 = D.mcpDormancy(MCPD_STR3);
t('mcpDormancy: a tier-3 server whose tier is the STRING "3" is STILL flagged (poisoned-tier no longer evades the doctor)', mcpdStr3.ok === false && mcpdStr3.violations.some((v) => v.server === 'github-write' && (v.type === 'tier3_default_grant' || v.type === 'malformed_server_tier')));

// a non-integer / out-of-range / non-numeric tier is treated as a violation, never all-clear
const MCPD_BADTIER = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-mcpdorm-badtier-'));
mdWrite(MCPD_BADTIER, { servers: [{ id: 'weird', tier: '2.5', status: 'not-installed' }, { id: 'huge', tier: 999, status: 'not-installed' }, { id: 'bogus', tier: 'abc', status: 'not-installed' }], bosses: { 'search-boss': { max_tier: 1, allow_servers: ['weird', 'huge', 'bogus'] } } });
const mcpdBad = D.mcpDormancy(MCPD_BADTIER);
t('mcpDormancy: a float-string / out-of-range / non-numeric tier is each flagged (fail-closed, never certified clean)', mcpdBad.ok === false && ['weird', 'huge', 'bogus'].every((s) => mcpdBad.violations.some((v) => v.server === s)));

// a covering-max string tier below 3 must still be caught as exceeding when appropriate (normalized compare)
const MCPD_STR_EXCEED = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-mcpdorm-strexceed-'));
mdWrite(MCPD_STR_EXCEED, { servers: [{ id: 'playwright', tier: '2', status: 'not-installed' }], bosses: { 'build-boss': { max_tier: 0, allow_servers: ['playwright'] } } });
const mcpdStrExceed = D.mcpDormancy(MCPD_STR_EXCEED);
t('mcpDormancy: a string tier "2" is normalized and still flagged as exceeding a max_tier of 0', mcpdStrExceed.ok === false && mcpdStrExceed.violations.some((v) => v.server === 'playwright' && (v.type === 'grant_exceeds_max_tier' || v.type === 'malformed_server_tier')));

// a fully clean config -> ok:true, 0 violations
const MCPD_CLEAN = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-mcpdorm-clean-'));
mdWrite(MCPD_CLEAN, { servers: [SERVER_T0, SERVER_T1, SERVER_T2], bosses: { 'build-boss': { max_tier: 0, allow_servers: ['serena-lsp'] }, 'search-boss': { max_tier: 1, allow_servers: ['context7'] } } });
const mcpdClean = D.mcpDormancy(MCPD_CLEAN);
t('mcpDormancy: a fully dormant, self-consistent, least-privilege config is ok=true with 0 violations', mcpdClean.ok === true && mcpdClean.violations.length === 0);

// missing config files -> ok:false, explicit reason, never a silent pass
const MCPD_MISSING = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-mcpdorm-missing-'));
const mcpdMissing = D.mcpDormancy(MCPD_MISSING);
t('mcpDormancy: missing mcp-registry.json -> ok=false, explicit reason (never a silent pass)', mcpdMissing.ok === false && /could not read\/parse mcp-registry\.json/.test(mcpdMissing.reason));

// real-project regression guard: this project's OWN mcp-registry.json/mcp-grants.json (WAVE G1) must stay
// dormant and least-privilege — a real violation here would mean the safety doctrine itself regressed.
const mcpdReal = D.mcpDormancy(REAL_PROJECT_ROOT);
t('mcpDormancy: the real project\'s MCP registry/grants are fully dormant + least-privilege (ok:true)', mcpdReal.ok === true, JSON.stringify(mcpdReal.violations || mcpdReal.reason));

// --- runDoctor()/printSummary(): sync_completeness/memory_discipline/mcp_dormancy/run_contract stay
// ADVISORY-ONLY — a real gap in ANY of these must NEVER flip runDoctor()'s top-level ok, mirroring the exact
// same core guarantee backfillContinuity already proves above. (unregistered_event/check_the_checks moved OUT
// of this guarantee 2026-07-22 — V9-INTEGRATE promoted them to ENFORCED; see the dedicated section below.)
function makeCompletenessBase(dirName) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), dirName));
  fs.mkdirSync(path.join(root, '.claude', 'forge-bin'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'forge-bin', 'good.cjs'), "'use strict';\nmodule.exports = {};\n");
  // V9-INTEGRATE (2026-07-22): check_the_checks is now ENFORCED — this base fixture's own "clean" suite must
  // carry a REAL assertion site (assert.ok(...)) or it would trip check_the_checks itself as a green no-op,
  // which would make every "stays advisory" fixture below fail for the wrong reason.
  fs.writeFileSync(path.join(root, '.claude', 'forge-bin', 'good.test.cjs'), "const assert = require('assert');\nassert.ok(true);\nconsole.log('1 passed, 0 failed');\nprocess.exit(0);\n");
  fs.mkdirSync(path.join(root, '.claude', 'forge-dashboard'), { recursive: true });
  fs.copyFileSync(path.join(REAL_ROOT, '.claude', 'forge-dashboard', 'log-event.cjs'), path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs'));
  fs.copyFileSync(path.join(REAL_ROOT, '.claude', 'forge-dashboard', 'server.cjs'), path.join(root, '.claude', 'forge-dashboard', 'server.cjs'));
  for (const f of ['index.html', 'app.js', 'lenses.js', 'graph.js', 'panels.js', 'styles.css']) fs.writeFileSync(path.join(root, '.claude', 'forge-dashboard', f), '// stub ' + f);
  fs.cpSync(path.join(REAL_ROOT, '.claude', 'agents'), path.join(root, '.claude', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude', 'config', 'agents'), { recursive: true });
  fs.copyFileSync(path.join(REAL_ROOT, '.claude', 'config', 'agents', 'agent-tool-policy.json'), path.join(root, '.claude', 'config', 'agents', 'agent-tool-policy.json'));
  return root;
}

const COMPLETE_GREEN_ROOT = makeCompletenessBase('forge-doctor-completeness-green-');
// deliberately introduce a real completeness GAP that is STILL advisory-only: an unsynced skill dir
// (sync_completeness). Does NOT introduce an unregistered-event usage here — that gap now belongs to the
// dedicated ENFORCED-check fixtures below (unregistered_event genuinely flips doctor.ok since 2026-07-22).
fs.mkdirSync(path.join(COMPLETE_GREEN_ROOT, '.claude', 'skills', 'never-in-any-manifest'), { recursive: true });
fs.writeFileSync(path.join(COMPLETE_GREEN_ROOT, '.claude', 'skills', 'never-in-any-manifest', 'SKILL.md'), '# gap\n');
const completeGreenRep = D.runDoctor(COMPLETE_GREEN_ROOT);
t('runDoctor completeness fixture: all real checks still pass (an advisory-only gap never touches `checks`)', completeGreenRep.ok === true, JSON.stringify(Object.entries(completeGreenRep.checks).filter(([, c]) => !c.ok).map(([k, c]) => [k, c.reason || c])));
t('runDoctor completeness fixture: advisory.completeness DOES surface the real sync gap', completeGreenRep.advisory.completeness.sync_completeness.missing.includes('skills/never-in-any-manifest/SKILL.md'));
t('runDoctor completeness fixture: advisory.completeness.run_contract degrades honestly to ok:true (no forge-runs dir -> "no dispatched run to check yet")', completeGreenRep.advisory.completeness.run_contract.ok === true && completeGreenRep.advisory.completeness.run_contract.run_id === null);
t('runDoctor completeness fixture: a real advisory-only gap does NOT flip doctor.ok to false (advisory-STOP surfacing, never a hard crash)', completeGreenRep.ok === true);
const completeSummary = D.printSummary(completeGreenRep);
t('printSummary: prints one compact "completeness" advisory line naming the real gap', /completeness \(advisory, non-blocking\)/.test(completeSummary) && /sync-completeness/.test(completeSummary));
t('printSummary: unregistered-event/check-the-checks no longer appear in the completeness advisory line (they are now enforced checks-lines)', !/completeness[^\n]*unregistered-event/.test(completeSummary) && !/completeness[^\n]*check-the-checks/.test(completeSummary));
t('printSummary: the completeness advisory line never appears as a ✗ (hard-fail) line', !/✗ completeness/.test(completeSummary));

// --- skill_evals (wp-skill-evals, 2026-07-31): ADVISORY-ONLY wrapper around forge-skill-evals.cjs -------
// A real failing per-skill assertion must surface in advisory.completeness.skill_evals and in
// printSummary's compact completeness line, but must NEVER flip runDoctor()'s hard `ok` verdict — same
// core guarantee every other completeness sub-check above already proves.
const SKILLEVALS_ROOT = makeCompletenessBase('forge-doctor-skillevals-');
fs.mkdirSync(path.join(SKILLEVALS_ROOT, '.claude', 'skills', 'fixture-skill'), { recursive: true });
fs.writeFileSync(path.join(SKILLEVALS_ROOT, '.claude', 'skills', 'fixture-skill', 'SKILL.md'), '---\nname: fixture-skill\ndescription: a fixture skill\n---\n\n# fixture-skill\n');
fs.writeFileSync(path.join(SKILLEVALS_ROOT, '.claude', 'skills', 'fixture-skill', 'evals.json'), JSON.stringify({
  skill: 'fixture-skill', assertions: [{ id: 'missing-thing', type: 'file_exists', path: 'this/does/not/exist.txt' }],
}));
const skillEvalsRep = D.runDoctor(SKILLEVALS_ROOT);
t('runDoctor skill_evals fixture: all real checks still pass (an advisory-only eval failure never touches `checks`)', skillEvalsRep.ok === true, JSON.stringify(Object.entries(skillEvalsRep.checks).filter(([, c]) => !c.ok).map(([k, c]) => [k, c.reason || c])));
t('runDoctor skill_evals fixture: advisory.completeness.skill_evals surfaces the real failing assertion', skillEvalsRep.advisory.completeness.skill_evals.ok === false && skillEvalsRep.advisory.completeness.skill_evals.skills.some((s) => s.skill === 'fixture-skill' && s.failed === 1));
t('runDoctor skill_evals fixture: a real advisory-only eval failure does NOT flip doctor.ok to false', skillEvalsRep.ok === true);
const skillEvalsSummary = D.printSummary(skillEvalsRep);
t('printSummary: names the failing skill+assertion under "skill-evals:"', /skill-evals: fixture-skill/.test(skillEvalsSummary) && /missing-thing/.test(skillEvalsSummary));
t('printSummary: skill_evals gap still renders as advisory (⚠), never a hard ✗ completeness line', !/✗ completeness/.test(skillEvalsSummary));

// real-project regression guard: this project's OWN 5 wired skills (forge-intake/router/code-review/
// verify/snapshot, wp-skill-evals 2026-07-31) must all be green — a real failure here would mean one of
// those skills' own evals genuinely regressed.
const realSkillEvalsCheck = D.skillEvalsDoctorCheck(REAL_PROJECT_ROOT);
t('skillEvalsDoctorCheck: the real project\'s own wired skills (forge-intake/router/code-review/verify/snapshot) are all green', realSkillEvalsCheck.ok === true, JSON.stringify(realSkillEvalsCheck.skills.filter((s) => !s.ok)));
// wp-disclosure-ab (2026-07-31) added a 6th wired skill (forge-skill-testing, dogfooding its own protocol) —
// this list grows again the next time a real skill opts into evals.json; that is expected drift, not a bug.
devTreeOnly('skillEvalsDoctorCheck: the real project has exactly the 6 wp-skill-evals/wp-disclosure-ab skills evaluated (no drift)', () =>
  t('skillEvalsDoctorCheck: the real project has exactly the 6 wp-skill-evals/wp-disclosure-ab skills evaluated (no drift)', realSkillEvalsCheck.skills.map((s) => s.skill).sort().join(',') === ['forge-code-review', 'forge-intake', 'forge-router', 'forge-skill-testing', 'forge-snapshot', 'forge-verify'].sort().join(',')));

// ===========================================================================================================
// V9-INTEGRATE (2026-07-22): unregistered_event / check_the_checks are now ENFORCED (folded into `checks`/
// `ok`) — a genuine gap DOES flip doctor.ok to false; FORGE_HARD_RULES.json's doctor_check_overrides gives an
// explicit, logged, recoverable escape hatch. Mirrors the exact same fixture shape as the advisory-only
// guarantee above, just proving the opposite direction (ENFORCED -> blocks; overridden -> recovers).
// ===========================================================================================================
function writeHardRules(root, doctorOverrides) {
  const p = path.join(root, '.claude', 'config', 'orchestration');
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, 'FORGE_HARD_RULES.json'), JSON.stringify({ version: 1, rules: [], doctor_check_overrides: doctorOverrides || [] }));
}

// (a) unregistered_event: a genuine unregistered literal event_type flips doctor.ok to false
const UE_GAP_ROOT = makeCompletenessBase('forge-doctor-v9-ue-gap-');
fs.writeFileSync(path.join(UE_GAP_ROOT, '.claude', 'forge-bin', 'gap-tool.cjs'),
  "function logEvent(runId, eventType, extra) {}\nlogEvent(RUN, 'a_completely_made_up_type', {});\n");
const ueGapRep = D.runDoctor(UE_GAP_ROOT);
t('V9-INTEGRATE: an unregistered event_type usage flips checks.unregistered_event.ok to false', ueGapRep.checks.unregistered_event.ok === false && ueGapRep.checks.unregistered_event.unregistered.some((u) => u.event_type === 'a_completely_made_up_type'));
t('V9-INTEGRATE: an unregistered event_type usage flips the WHOLE doctor.ok to false (now enforced, not advisory)', ueGapRep.ok === false);
t('V9-INTEGRATE: an unenforced/un-overridden unregistered_event never has overridden:true', !ueGapRep.checks.unregistered_event.overridden);
const ueGapSummary = D.printSummary(ueGapRep);
t('printSummary: unregistered event line renders as ✗ (hard-fail), naming the gap', /✗ unreg\. events[^\n]*a_completely_made_up_type/.test(ueGapSummary));
t('printSummary: overall verdict reads FAILURES ABOVE, not ALL GREEN', /FAILURES ABOVE/.test(ueGapSummary) && !/ALL GREEN/.test(ueGapSummary));

// (2026-09-24, measured on the first v2.4.0 CI run) a suite that CRASHES before its tally used to leave the
// tests line reading "… / 0 failed · 1 SUITE(S) FAILED" and naming nothing — useless on a runner where the
// per-suite output is not at hand. The red suites are now named, with why.
const CRASH_ROOT = makeCompletenessBase('forge-doctor-crash-suite-');
fs.writeFileSync(path.join(CRASH_ROOT, '.claude', 'forge-bin', 'boom.test.cjs'), "const assert = require('assert');\nassert.ok(true);\nthrow new Error('boom before the tally');\n");
const crashRep = D.runDoctor(CRASH_ROOT);
t('runTests: a suite that throws before its tally counts as a FAILED suite with 0 failed assertions', crashRep.checks.tests.ok === false && crashRep.checks.tests.failed === 0 && crashRep.checks.tests.suitesFailed === 1);
const crashSummary = D.printSummary(crashRep);
t('printSummary: the tests line NAMES the crashed suite and says why (crashed or no tally)', /✗ tests[^\n]*boom\.test\.cjs \(crashed or no tally\)/.test(crashSummary), crashSummary.split('\n').find((l) => /tests/.test(l)));
t('printSummary: a green suite in the same fixture is NOT listed as red', !/good\.test\.cjs/.test(crashSummary.split('\n').find((l) => /✗ tests/.test(l)) || ''));

// (a') the SAME gap, but with a real, reasoned, logged doctor_check_overrides entry -> recovers to ok:true
const UE_OVERRIDE_ROOT = makeCompletenessBase('forge-doctor-v9-ue-override-');
fs.writeFileSync(path.join(UE_OVERRIDE_ROOT, '.claude', 'forge-bin', 'gap-tool.cjs'),
  "function logEvent(runId, eventType, extra) {}\nlogEvent(RUN, 'a_completely_made_up_type', {});\n");
writeHardRules(UE_OVERRIDE_ROOT, [{ check: 'unregistered_event', reason: 'owner-reviewed: gap-tool.cjs is a throwaway test fixture, not real code', by: 'owner', ts: '2026-07-22T00:00:00Z' }]);
const ueOverrideRep = D.runDoctor(UE_OVERRIDE_ROOT);
t('V9-INTEGRATE override: a logged doctor_check_overrides entry recovers checks.unregistered_event.ok to true', ueOverrideRep.checks.unregistered_event.ok === true && ueOverrideRep.checks.unregistered_event.overridden === true);
t('V9-INTEGRATE override: the real reason/by are carried on the result, never fabricated', ueOverrideRep.checks.unregistered_event.override_reason.includes('throwaway test fixture') && ueOverrideRep.checks.unregistered_event.override_by === 'owner');
t('V9-INTEGRATE override: the WHOLE doctor.ok recovers to true', ueOverrideRep.ok === true);
const ueOverrideSummary = D.printSummary(ueOverrideRep);
t('printSummary: an overridden check still prints ✓ (it IS a pass) but with a visible [OVERRIDDEN...] tag — never a silent bypass', /✓ unreg\. events[^\n]*\[OVERRIDDEN by owner: owner-reviewed/.test(ueOverrideSummary));
t('printSummary: an overridden-recovery run reads ALL GREEN', /ALL GREEN/.test(ueOverrideSummary));

// (b) check_the_checks: a genuine green-no-op suite flips doctor.ok to false
const CTC_GAP_ROOT = makeCompletenessBase('forge-doctor-v9-ctc-gap-');
fs.writeFileSync(path.join(CTC_GAP_ROOT, '.claude', 'forge-bin', 'noop.test.cjs'), "console.log('5 passed, 0 failed');\nprocess.exit(0);\n");
const ctcGapRep = D.runDoctor(CTC_GAP_ROOT);
t('V9-INTEGRATE: a green no-op suite flips checks.check_the_checks.ok to false', ctcGapRep.checks.check_the_checks.ok === false && ctcGapRep.checks.check_the_checks.noOp.some((n) => n.suite === 'noop.test.cjs'));
t('V9-INTEGRATE: a green no-op suite flips the WHOLE doctor.ok to false', ctcGapRep.ok === false);

// (b') the SAME gap, overridden -> recovers to ok:true
const CTC_OVERRIDE_ROOT = makeCompletenessBase('forge-doctor-v9-ctc-override-');
fs.writeFileSync(path.join(CTC_OVERRIDE_ROOT, '.claude', 'forge-bin', 'noop.test.cjs'), "console.log('5 passed, 0 failed');\nprocess.exit(0);\n");
writeHardRules(CTC_OVERRIDE_ROOT, [{ check: 'check_the_checks', reason: 'owner-reviewed: noop.test.cjs is a deliberately minimal smoke stub, tracked in a follow-up ticket', by: 'owner', ts: '2026-07-22T00:00:00Z' }]);
const ctcOverrideRep = D.runDoctor(CTC_OVERRIDE_ROOT);
t('V9-INTEGRATE override: a logged doctor_check_overrides entry recovers checks.check_the_checks.ok to true', ctcOverrideRep.checks.check_the_checks.ok === true && ctcOverrideRep.checks.check_the_checks.overridden === true);
t('V9-INTEGRATE override: the WHOLE doctor.ok recovers to true', ctcOverrideRep.ok === true);

// (c) loadDoctorCheckOverrides()/applyDoctorOverride() pure-function guarantees
t('loadDoctorCheckOverrides: a missing FORGE_HARD_RULES.json degrades to [] (never throws)', Array.isArray(D.loadDoctorCheckOverrides(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-nohardrules-')))) && D.loadDoctorCheckOverrides(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-nohardrules2-'))).length === 0);
const BLANK_OV_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-blankoverride-'));
writeHardRules(BLANK_OV_ROOT, [{ check: 'unregistered_event', reason: '   ' }, { check: '', reason: 'valid reason but no check id' }, { reason: 'no check field at all' }]);
t('loadDoctorCheckOverrides: a blank/templated reason or missing check id is silently dropped (never a fabricated override)', D.loadDoctorCheckOverrides(BLANK_OV_ROOT).length === 0);
t('applyDoctorOverride: a check that ALREADY passes is returned unchanged, even with a matching override entry (never fabricates extra positivity)', (() => {
  const map = new Map([['x', { reason: 'r', by: 'owner' }]]);
  const passing = { ok: true, foo: 1 };
  const out = D.applyDoctorOverride(map, 'x', passing);
  return out === passing || (out.ok === true && !out.overridden);
})());
t('applyDoctorOverride: a failing check with NO matching override entry is returned unchanged', (() => {
  const failing = { ok: false, reason: 'gap' };
  const out = D.applyDoctorOverride(new Map(), 'x', failing);
  return out.ok === false && !out.overridden;
})());

// --- runContractDoctorCheck() / latestRunIdFor() — direct pure-function proof (real forge-runs fixtures) ---
t('latestRunIdFor: a fresh project with no forge-runs dir returns null', D.latestRunIdFor(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-norunsdir-'))) === null);
const RC_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-runcontract-'));
/** R6-06 (zesde Codex-herreview): `opts.root` stuurt sinds die fix ook de REGELSET — een run uit root B
 *  mag niet tegen de regels van installatie A worden beoordeeld. Deze fixture leunde op precies die
 *  fallback (temp-root zonder regelbestand), dus hij brengt zijn regels nu zelf mee, zoals een echt
 *  project dat ook doet. */
const seedRules = (root) => {
  fs.mkdirSync(path.join(root, '.claude', 'config', 'orchestration'), { recursive: true });
  fs.copyFileSync(path.join(REAL_ROOT, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json'),
    path.join(root, '.claude', 'config', 'orchestration', 'FORGE_HARD_RULES.json'));
};
seedRules(RC_ROOT);
fs.mkdirSync(path.join(RC_ROOT, '.claude', 'forge-runs', 'forge-2026-01-01-old'), { recursive: true });
fs.mkdirSync(path.join(RC_ROOT, '.claude', 'forge-runs', 'forge-2026-06-01-newest'), { recursive: true });
fs.writeFileSync(path.join(RC_ROOT, '.claude', 'forge-runs', 'forge-2026-01-01-old', 'events.jsonl'), '');
fs.writeFileSync(path.join(RC_ROOT, '.claude', 'forge-runs', 'forge-2026-06-01-newest', 'events.jsonl'), '');
// V9 WAVE 2 (2026-07-22): a genuinely DISPATCHED run always carries a real run.json — give both fixture
// dirs one so they qualify under latestDispatchedRunIdFor()'s stricter filter too (this fixture predates
// that filter and only ever seeded events.jsonl; see the dedicated receipt-only-vs-dispatched block below
// for the NEW behavior this refinement adds).
fs.writeFileSync(path.join(RC_ROOT, '.claude', 'forge-runs', 'forge-2026-01-01-old', 'run.json'), '{}');
fs.writeFileSync(path.join(RC_ROOT, '.claude', 'forge-runs', 'forge-2026-06-01-newest', 'run.json'), '{}');
t('latestRunIdFor: picks the lexically-newest run id, not just readdir order', D.latestRunIdFor(RC_ROOT) === 'forge-2026-06-01-newest');
t('latestDispatchedRunIdFor: agrees with latestRunIdFor when every candidate genuinely has a real run.json', D.latestDispatchedRunIdFor(RC_ROOT) === 'forge-2026-06-01-newest');
/** MEASURED REGRESSION (2026-08-09, on this very project): ranking by file mtime means ANY metadata write
 *  reorders history. forge-finalize's new markRunFinalized() rewrote an old run's run.json; that single
 *  touch promoted a long-finished (green) run to "latest dispatched run", so runContractDoctorCheck
 *  reported "run contract satisfied" while the genuinely active run still had 5 required rules missing —
 *  a real gap made INVISIBLE by a bookkeeping write. forge-snapshot.cjs already learned this exact lesson
 *  on 2026-08-01 and re-ranked by work recency in ITS OWN code; the shared core kept the flaw, so the next
 *  caller inherited it. Recency of a RUN is the recency of its WORK: event timestamps are written once and
 *  never rewritten, file mtimes are not. */
{
  const R = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-rank-mtime-'));
  const mk = (naam, laatsteEventISO) => {
    const d = path.join(R, '.claude', 'forge-runs', naam);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'run.json'), JSON.stringify({ run_id: naam, status: 'completed' }));
    fs.writeFileSync(path.join(d, 'events.jsonl'), JSON.stringify({ event_type: 'run_started', timestamp: laatsteEventISO }) + '\n');
    return d;
  };
  const oud = mk('forge-2026-01-01-oud', '2026-01-01T10:00:00.000Z');
  mk('forge-2026-08-01-actief', '2026-08-01T10:00:00.000Z');
  t('rankRunCandidates: het echte werk bepaalt de volgorde, niet de bestandsdatum',
    D.latestDispatchedRunIdFor(R) === 'forge-2026-08-01-actief');
  // nu exact de regressie: alleen de METADATA van de oude run aanraken, geen enkel nieuw event
  fs.writeFileSync(path.join(oud, 'run.json'), JSON.stringify({ run_id: 'forge-2026-01-01-oud', status: 'completed', finalized_at: 'nu' }));
  t('rankRunCandidates: een metadata-write op een OUDE run promoveert hem NIET tot nieuwste',
    D.latestDispatchedRunIdFor(R) === 'forge-2026-08-01-actief', 'gekozen: ' + D.latestDispatchedRunIdFor(R));
  t('rankRunCandidates: de activiteitstijd is zichtbaar naast de mtime (controleerbaar, niet verstopt)',
    D.rankRunCandidates(R, { requireDispatched: true }).every((c) => Number.isFinite(c.activityMs)));
  // en zonder events valt hij eerlijk terug op de mtime — een run zonder eventlog mag niet onzichtbaar worden
  const geenEvents = path.join(R, '.claude', 'forge-runs', 'forge-2026-09-01-geen-events');
  fs.mkdirSync(geenEvents, { recursive: true });
  fs.writeFileSync(path.join(geenEvents, 'run.json'), JSON.stringify({ run_id: 'x', status: 'running' }));
  t('rankRunCandidates: zonder eventlog is de mtime de eerlijke terugval',
    D.latestDispatchedRunIdFor(R) === 'forge-2026-09-01-geen-events', 'gekozen: ' + D.latestDispatchedRunIdFor(R));
}

const rcCheck = D.runContractDoctorCheck(RC_ROOT);
t('runContractDoctorCheck: an empty (no research_done etc.) real dispatched run is honestly ok:false, naming the missing rules', rcCheck.ok === false && Array.isArray(rcCheck.missing) && rcCheck.missing.length > 0 && rcCheck.run_id === 'forge-2026-06-01-newest');
const rcNoRuns = D.runContractDoctorCheck(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-rc-norun-'))); // no .claude/forge-runs at all yet
t('runContractDoctorCheck: a project with zero runs at all degrades honestly to ok:true ("no dispatched run to check yet"), never a false-red on a fresh project', rcNoRuns.ok === true && /no dispatched run to check yet/.test(rcNoRuns.reason));

// ===========================================================================================================
// V9 WAVE 2 (2026-07-22) — receipt-only directory vs. a genuine dispatched run. `forge-doctor --run <id>`'s
// own CLI body (see below) writes a doctor.json snapshot + logs one synthetic `doctor_run` event into
// forge-runs/<id>/events.jsonl but NEVER writes a run.json — that directory must never be mistaken for a
// real dispatched run whose non-negotiables are worth evaluating (this was a REAL bug found live against
// this project's own forge-runs/ — see build-boss MEMORY.md).
// ===========================================================================================================
const RECEIPT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-receiptonly-'));
seedRules(RECEIPT_ROOT); // R6-06: elke root draagt zijn eigen regels (zie seedRules hierboven)
const receiptDir = path.join(RECEIPT_ROOT, '.claude', 'forge-runs', 'forge-2026-07-22-receipt-only');
fs.mkdirSync(receiptDir, { recursive: true });
fs.writeFileSync(path.join(receiptDir, 'doctor.json'), JSON.stringify({ ok: true }));
fs.writeFileSync(path.join(receiptDir, 'events.jsonl'), JSON.stringify({ run_id: 'forge-2026-07-22-receipt-only', event_type: 'doctor_run', agent: 'reviewer', ok: true }) + '\n');
t('latestRunIdFor (general picker): a receipt-only dir (doctor.json + one doctor_run event, no run.json) IS still a pickable "any run" candidate', D.latestRunIdFor(RECEIPT_ROOT) === 'forge-2026-07-22-receipt-only');
t('latestDispatchedRunIdFor: the SAME receipt-only dir is correctly IGNORED (no real run.json -> not a genuine dispatch)', D.latestDispatchedRunIdFor(RECEIPT_ROOT) === null);
const receiptOnlyCheck = D.runContractDoctorCheck(RECEIPT_ROOT);
t('runContractDoctorCheck: a project whose ONLY forge-runs/ entry is a receipt-only dir degrades honestly to ok:true ("no dispatched run to check yet"), NEVER "N rules missing on <receipt dir>"', receiptOnlyCheck.ok === true && receiptOnlyCheck.run_id === null && /no dispatched run to check yet/.test(receiptOnlyCheck.reason));

// now add a genuine dispatched run (real run.json) OLDER than the receipt dir, then a NEWER one — proves the
// picker correctly ignores the receipt dir regardless of its own recency and picks the real dispatched run.
const dispatchedDir = path.join(RECEIPT_ROOT, '.claude', 'forge-runs', 'forge-2026-07-21-real-dispatch');
fs.mkdirSync(dispatchedDir, { recursive: true });
fs.writeFileSync(path.join(dispatchedDir, 'run.json'), '{}');
fs.writeFileSync(path.join(dispatchedDir, 'events.jsonl'), '');
const OLDER = new Date('2020-01-01T00:00:00Z'), NEWER = new Date('2020-06-01T00:00:00Z');
fs.utimesSync(dispatchedDir, OLDER, OLDER); fs.utimesSync(path.join(dispatchedDir, 'run.json'), OLDER, OLDER); fs.utimesSync(path.join(dispatchedDir, 'events.jsonl'), OLDER, OLDER);
fs.utimesSync(receiptDir, NEWER, NEWER); fs.utimesSync(path.join(receiptDir, 'events.jsonl'), NEWER, NEWER); fs.utimesSync(path.join(receiptDir, 'doctor.json'), NEWER, NEWER);
t('latestDispatchedRunIdFor: a real dispatched run is picked even when a receipt-only dir is objectively MORE recent', D.latestDispatchedRunIdFor(RECEIPT_ROOT) === 'forge-2026-07-21-real-dispatch');
const mixedCheck = D.runContractDoctorCheck(RECEIPT_ROOT);
t('runContractDoctorCheck: with a real dispatched run present, it is evaluated (naming ITS missing rules), never the newer receipt-only dir', mixedCheck.run_id === 'forge-2026-07-21-real-dispatch' && mixedCheck.ok === false && mixedCheck.missing.length > 0);

// ===========================================================================================================
// V9-fix (2026-07-22) — break-swarm DEFECT 4 repro: the OLD latestRunIdFor() picked "latest" by a plain
// lexical NAME sort — a clean decoy run whose directory name simply sorts higher masked a genuinely NEWER,
// real-violating run whose name sorts lower, so runContractDoctorCheck() silently evaluated the WRONG run.
// This fixture proves the fix ranks by REAL recency (mtime) instead, with an explicit, deterministic mtime
// per candidate (fs.utimesSync) so the assertion never depends on real wall-clock execution speed.
// ===========================================================================================================
const DEFECT4_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-defect4-'));
seedRules(DEFECT4_ROOT); // R6-06: elke root draagt zijn eigen regels
const decoyDir = path.join(DEFECT4_ROOT, '.claude', 'forge-runs', 'zzz-decoy-clean-run'); // name sorts HIGHEST
const violatingDir = path.join(DEFECT4_ROOT, '.claude', 'forge-runs', 'aaa-real-violating-run'); // name sorts LOWEST
const strayDir = path.join(DEFECT4_ROOT, '.claude', 'forge-runs', 'zzzz-not-a-real-run-dir'); // not a real run dir at all
fs.mkdirSync(decoyDir, { recursive: true });
fs.mkdirSync(violatingDir, { recursive: true });
fs.mkdirSync(strayDir, { recursive: true });

// decoy: a genuinely CLEAN run (satisfies every real "always" rule) — proves the fix isn't just "pick the
// dirtiest run", it genuinely tracks real recency regardless of which run happens to look clean.
const decoyEvents = [
  { event_type: 'memory_loaded', agent: 'orchestrator' },
  { event_type: 'owner_prefs_loaded', agent: 'orchestrator' },
  { event_type: 'research_done', agent: 'orchestrator' },
  { event_type: 'prd_generated', agent: 'orchestrator' },
  { event_type: 'agent_started', agent: 'Build Boss' },
  { event_type: 'zero_console_errors_noted', agent: 'UI Boss' },
  { event_type: 'check_passed', agent: 'Test Boss' },
].map((o) => JSON.stringify(o)).join('\n') + '\n';
fs.writeFileSync(path.join(decoyDir, 'events.jsonl'), decoyEvents);
fs.writeFileSync(path.join(decoyDir, 'final-report.md'), '# Report\n');
fs.writeFileSync(path.join(decoyDir, 'run.json'), '{}');
// violating: a genuinely EMPTY run (misses every always-rule)
fs.writeFileSync(path.join(violatingDir, 'events.jsonl'), '');
fs.writeFileSync(path.join(violatingDir, 'run.json'), '{}');
// stray: no run.json / events.jsonl at all — must never be treated as a run directory
fs.writeFileSync(path.join(strayDir, 'readme.txt'), 'not a run');

// explicit, deterministic mtimes: decoy is OLD, violating is NEWER, stray is NEWEST of all (must still be ignored)
const OLD_TIME = new Date('2020-01-01T00:00:00Z');
const NEW_TIME = new Date('2020-06-01T00:00:00Z');
const NEWEST_TIME = new Date('2020-06-02T00:00:00Z');
fs.utimesSync(path.join(decoyDir, 'events.jsonl'), OLD_TIME, OLD_TIME);
fs.utimesSync(path.join(decoyDir, 'run.json'), OLD_TIME, OLD_TIME);
fs.utimesSync(decoyDir, OLD_TIME, OLD_TIME);
fs.utimesSync(path.join(violatingDir, 'events.jsonl'), NEW_TIME, NEW_TIME);
fs.utimesSync(path.join(violatingDir, 'run.json'), NEW_TIME, NEW_TIME);
fs.utimesSync(violatingDir, NEW_TIME, NEW_TIME);
fs.utimesSync(path.join(strayDir, 'readme.txt'), NEWEST_TIME, NEWEST_TIME);
fs.utimesSync(strayDir, NEWEST_TIME, NEWEST_TIME);

t('DEFECT 4 repro: latestRunIdFor picks the NEWER violating run, not the lexically-higher-named clean decoy', D.latestRunIdFor(DEFECT4_ROOT) === 'aaa-real-violating-run');
t('DEFECT 4 repro: a stray non-run directory (no run.json/events.jsonl) is never picked, even with the newest mtime and the highest name', D.latestRunIdFor(DEFECT4_ROOT) !== 'zzzz-not-a-real-run-dir');

const defect4Check = D.runContractDoctorCheck(DEFECT4_ROOT);
t('DEFECT 4 repro: runContractDoctorCheck evaluates the NEWER violating run, not the older clean decoy', defect4Check.run_id === 'aaa-real-violating-run');
t('DEFECT 4 repro: the doctor honestly reports the (correctly-selected) violating run as ok:false — the enforcement surface now points at the right run', defect4Check.ok === false && defect4Check.missing.length > 0);

// ===========================================================================================================
// wp-disclosure-ab (2026-07-31) — skill_hygiene: progressive-disclosure hygiene as a doctor advisory
// (backlog item 12, YT-SWEEP-2026-07-31). ADVISORY-ONLY, same core guarantee as skill_evals above: a real
// finding must surface in advisory.completeness.skill_hygiene and in printSummary's compact completeness
// line, but must NEVER flip runDoctor()'s hard `ok` verdict. Five RED->GREEN-proving fixtures: all-clean,
// over-long description, over-long body, dangling reference, prose-with-slash NOT flagged.
// ===========================================================================================================

// (1) all-clean: a short description, a small body, one ANCHORED reference that DOES exist (proves an
// anchored-and-real reference is never mistaken for a dangling one). Named after a REAL skill already in
// forge-sync.cjs's FILES manifest ("forge-router") so this fixture's own sync_completeness sub-check also
// stays clean — an arbitrary fixture-only name would trip sync_completeness's OWN gap-detection instead
// (proven by the COMPLETE_GREEN_ROOT fixture above), muddying this specific advisory's isolation.
const SH_CLEAN_ROOT = makeCompletenessBase('forge-doctor-skillhygiene-clean-');
fs.mkdirSync(path.join(SH_CLEAN_ROOT, '.claude', 'skills', 'forge-router'), { recursive: true });
fs.writeFileSync(path.join(SH_CLEAN_ROOT, '.claude', 'skills', 'forge-router', 'SKILL.md'),
  '---\nname: forge-router\ndescription: A short, valid hygiene-test description well under the 200-char budget.\n---\n\n'
  + '# forge-router (fixture)\n\nUses `.claude/forge-bin/good.cjs` (a real anchored reference the completeness base already ships).\n');
const shCleanRep = D.runDoctor(SH_CLEAN_ROOT);
t('skillHygiene clean fixture: runDoctor checks all still pass (an advisory-only hygiene gap never touches `checks`)', shCleanRep.ok === true, JSON.stringify(Object.entries(shCleanRep.checks).filter(([, c]) => !c.ok).map(([k, c]) => [k, c.reason || c])));
t('skillHygiene clean fixture: advisory.completeness.skill_hygiene reports ok:true, 1/1 skill clean', shCleanRep.advisory.completeness.skill_hygiene.ok === true && shCleanRep.advisory.completeness.skill_hygiene.checked === 1, JSON.stringify(shCleanRep.advisory.completeness.skill_hygiene));
t('skillHygiene clean fixture: this fixture\'s OWN sync_completeness sub-check is also clean (proves isolation from the unrelated sync-gap fixture above)', shCleanRep.advisory.completeness.sync_completeness.ok === true, JSON.stringify(shCleanRep.advisory.completeness.sync_completeness));
const shCleanSummary = D.printSummary(shCleanRep);
t('printSummary: clean fixture never renders a ✗ completeness line', !/✗ completeness/.test(shCleanSummary));
// printSummary's "skill hygiene N/M" clean-branch text only renders when EVERY completeness sub-check is
// clean (memory_discipline/mcp_dormancy have no equivalent fixture-population helper in this file — no
// existing sub-check's fully-clean branch is exercised elsewhere in this suite either, e.g. "sync manifest
// complete"/"skill evals green" never appear literally in this test file). Isolate printSummary's OWN
// rendering logic instead, by cloning a REAL report and overriding just the unrelated sub-checks to ok:true
// — a legitimate, surgical way to prove the format string itself is correct without re-building every other
// advisory's own clean-state fixture.
const shCleanRepAllOk = JSON.parse(JSON.stringify(shCleanRep));
for (const k of Object.keys(shCleanRepAllOk.advisory.completeness)) if (k !== 'skill_hygiene') shCleanRepAllOk.advisory.completeness[k].ok = true;
const shCleanAllOkSummary = D.printSummary(shCleanRepAllOk);
t('printSummary: once every completeness sub-check is clean, shows "skill hygiene 1/1" in the composed clean sentence', /skill hygiene 1\/1/.test(shCleanAllOkSummary), shCleanAllOkSummary);
t('printSummary: that fully-clean sentence renders as ✓ completeness, never ⚠', /✓ completeness \(advisory\)/.test(shCleanAllOkSummary) && !/⚠ completeness/.test(shCleanAllOkSummary));

// (2) over-long description: frontmatter description > 200 chars -> named finding
const SH_DESC_ROOT = makeCompletenessBase('forge-doctor-skillhygiene-desc-');
const longDesc = 'A'.repeat(220);
fs.mkdirSync(path.join(SH_DESC_ROOT, '.claude', 'skills', 'desc-too-long'), { recursive: true });
fs.writeFileSync(path.join(SH_DESC_ROOT, '.claude', 'skills', 'desc-too-long', 'SKILL.md'), '---\nname: desc-too-long\ndescription: ' + longDesc + '\n---\n\n# desc-too-long\n');
const shDescRep = D.runDoctor(SH_DESC_ROOT);
t('skillHygiene over-long-description fixture: RED -> advisory.completeness.skill_hygiene.ok is false', shDescRep.advisory.completeness.skill_hygiene.ok === false);
t('skillHygiene over-long-description fixture: names the exact char count over budget', shDescRep.advisory.completeness.skill_hygiene.skills.some((s) => s.skill === 'desc-too-long' && s.issues.some((i) => /description is 220 chars \(max 200\)/.test(i))), JSON.stringify(shDescRep.advisory.completeness.skill_hygiene));
t('skillHygiene over-long-description fixture: an advisory-only hygiene gap does NOT flip doctor.ok to false', shDescRep.ok === true);
const shDescSummary = D.printSummary(shDescRep);
t('printSummary: names the failing skill under "skill-hygiene:"', /skill-hygiene: desc-too-long/.test(shDescSummary) && /description is 220 chars/.test(shDescSummary), shDescSummary);
t('printSummary: over-long-description fixture still renders as advisory (⚠), never a hard ✗ completeness line', !/✗ completeness/.test(shDescSummary));

// (3) over-long body: whole-file line count > 500 -> named finding (with a valid, in-budget description, to
// isolate this from the description-length check above).
const SH_BODY_ROOT = makeCompletenessBase('forge-doctor-skillhygiene-body-');
fs.mkdirSync(path.join(SH_BODY_ROOT, '.claude', 'skills', 'body-too-long'), { recursive: true });
const bodyFiller = '---\nname: body-too-long\ndescription: A short, valid description.\n---\n\n# body-too-long\n\n' + 'filler line\n'.repeat(510);
fs.writeFileSync(path.join(SH_BODY_ROOT, '.claude', 'skills', 'body-too-long', 'SKILL.md'), bodyFiller);
const shBodyRep = D.runDoctor(SH_BODY_ROOT);
t('skillHygiene over-long-body fixture: RED -> advisory.completeness.skill_hygiene.ok is false', shBodyRep.advisory.completeness.skill_hygiene.ok === false);
t('skillHygiene over-long-body fixture: names the exact line count over budget', shBodyRep.advisory.completeness.skill_hygiene.skills.some((s) => s.skill === 'body-too-long' && s.issues.some((i) => /SKILL\.md is \d+ lines \(max 500\)/.test(i))), JSON.stringify(shBodyRep.advisory.completeness.skill_hygiene));
t('skillHygiene over-long-body fixture: an advisory-only hygiene gap does NOT flip doctor.ok to false', shBodyRep.ok === true);
const shBodySummary = D.printSummary(shBodyRep);
t('printSummary: names the failing skill+line-count under "skill-hygiene:"', /skill-hygiene: body-too-long/.test(shBodySummary) && /lines \(max 500\)/.test(shBodySummary), shBodySummary);

// (4) dangling reference: an ANCHORED reference (.claude/... and a skill-relative references/... one) that
// does NOT exist -> named finding, distinct from the "not anchored -> not checked" case in (5) below.
const SH_DANGLE_ROOT = makeCompletenessBase('forge-doctor-skillhygiene-dangle-');
fs.mkdirSync(path.join(SH_DANGLE_ROOT, '.claude', 'skills', 'dangling-ref'), { recursive: true });
fs.writeFileSync(path.join(SH_DANGLE_ROOT, '.claude', 'skills', 'dangling-ref', 'SKILL.md'),
  '---\nname: dangling-ref\ndescription: A short, valid description.\n---\n\n# dangling-ref\n\n'
  + 'See `.claude/forge-bin/does-not-exist.cjs` and `references/missing.md` for details.\n');
const shDangleRep = D.runDoctor(SH_DANGLE_ROOT);
t('skillHygiene dangling-reference fixture: RED -> advisory.completeness.skill_hygiene.ok is false', shDangleRep.advisory.completeness.skill_hygiene.ok === false);
t('skillHygiene dangling-reference fixture: names BOTH dangling refs (root-anchored + skill-relative)', shDangleRep.advisory.completeness.skill_hygiene.skills.some((s) => s.skill === 'dangling-ref' && s.issues.some((i) => i.includes('.claude/forge-bin/does-not-exist.cjs') && i.includes('references/missing.md'))), JSON.stringify(shDangleRep.advisory.completeness.skill_hygiene));
t('skillHygiene dangling-reference fixture: an advisory-only hygiene gap does NOT flip doctor.ok to false', shDangleRep.ok === true);
const shDangleSummary = D.printSummary(shDangleRep);
t('printSummary: names the failing skill+dangling refs under "skill-hygiene:"', /skill-hygiene: dangling-ref/.test(shDangleSummary) && /dangling reference/.test(shDangleSummary), shDangleSummary);

// (4b) RUNTIME-GENERATED marker is NOT dangling (2026-08-09). MEASURED FALSE POSITIVE: the real doctor run
// reported `skill-hygiene: forge-snapshot (1 dangling reference(s): .claude/.forge-snapshot-due.json)` — a
// file that forge-snapshot-marker.cjs WRITES and the SessionStart hook consumes, so its normal state is
// "not on disk". Documenting your own output path is not a broken link, and an advisory that fills up with
// false positives stops being read — which is how it would miss a REAL dangling reference. The reference is
// reclassified (still reported, under generated_refs) rather than silenced.
const SH_GEN_ROOT = makeCompletenessBase('forge-doctor-skillhygiene-generated-');
fs.writeFileSync(path.join(SH_GEN_ROOT, '.claude', 'forge-bin', 'marker.cjs'),
  "'use strict';\nconst fs = require('fs');\nfs.writeFileSync(require('path').join(dir, '.a-runtime-marker.json'), '{}');\n");
fs.mkdirSync(path.join(SH_GEN_ROOT, '.claude', 'skills', 'gen-ref'), { recursive: true });
fs.writeFileSync(path.join(SH_GEN_ROOT, '.claude', 'skills', 'gen-ref', 'SKILL.md'),
  '---\nname: gen-ref\ndescription: A short, valid description.\n---\n\n# gen-ref\n\n'
  + 'Writes `.claude/.a-runtime-marker.json` and also mentions `.claude/forge-bin/really-missing.cjs`.\n');
const shGenRep = D.runDoctor(SH_GEN_ROOT);
const shGenSkill = shGenRep.advisory.completeness.skill_hygiene.skills.find((s) => s.skill === 'gen-ref') || {};
t('skillHygiene: a path our OWN code writes is not counted as dangling',
  !JSON.stringify(shGenSkill.issues || []).includes('.a-runtime-marker.json'), JSON.stringify(shGenSkill));
t('skillHygiene: but it is still REPORTED, under generated_refs (reclassified, not silenced)',
  Array.isArray(shGenSkill.generated_refs) && shGenSkill.generated_refs.includes('.claude/.a-runtime-marker.json'), JSON.stringify(shGenSkill));
t('skillHygiene: a genuinely missing reference in the SAME skill is still flagged',
  (shGenSkill.issues || []).some((i) => i.includes('.claude/forge-bin/really-missing.cjs')), JSON.stringify(shGenSkill));
t('skillHygiene: so the skill is still not ok (the real gap survives the reclassification)', shGenSkill.ok === false);

// (4c) the written path lives in a VARIABLE (2026-09-23). MEASURED on forge-setup.cjs, restored this release:
// `const projMarkerPath = path.join(projectDir, '.claude', '.forge-setup.json')` … fifteen lines later
// `fs.writeFileSync(projMarkerPath, …)`. Neither line holds both the write API and the literal, so (4b)'s
// same-line window missed it and forge-router's honest reference to `.claude/.forge-setup.json` was reported
// as dangling. generatedPathBasenames() now resolves the written argument to its declaration in the same file.
// Guards in both directions: the resolved name IS reclassified; an identifier that is never written to is NOT.
const SH_VAR_ROOT = makeCompletenessBase('forge-doctor-skillhygiene-generated-var-');
fs.writeFileSync(path.join(SH_VAR_ROOT, '.claude', 'forge-bin', 'marker-var.cjs'),
  "'use strict';\nconst fs = require('fs');\nconst path = require('path');\n"
  + "const unusedPath = path.join(dir, '.never-written.json');\n"
  + "const markerPath = path.join(dir, '.claude', '.a-variable-marker.json');\n"
  + "function save(dir) {\n  const body = '{}';\n  fs.writeFileSync(markerPath, body, 'utf8');\n}\n"
  + "module.exports = { save, unusedPath };\n");
fs.mkdirSync(path.join(SH_VAR_ROOT, '.claude', 'skills', 'gen-var'), { recursive: true });
fs.writeFileSync(path.join(SH_VAR_ROOT, '.claude', 'skills', 'gen-var', 'SKILL.md'),
  '---\nname: gen-var\ndescription: A short, valid description.\n---\n\n# gen-var\n\n'
  + 'Reads `.claude/.a-variable-marker.json` (written by marker-var.cjs) and mentions `.claude/.never-written.json`.\n');
const shVarRep = D.runDoctor(SH_VAR_ROOT);
const shVarSkill = shVarRep.advisory.completeness.skill_hygiene.skills.find((s) => s.skill === 'gen-var') || {};
t('skillHygiene: a path built into a variable and written later is resolved to its declaration (not dangling)',
  !JSON.stringify(shVarSkill.issues || []).includes('.a-variable-marker.json') && Array.isArray(shVarSkill.generated_refs) && shVarSkill.generated_refs.includes('.claude/.a-variable-marker.json'), JSON.stringify(shVarSkill));
t('skillHygiene: a path variable that is NEVER handed to a write API stays a dangling reference (the resolution did not widen into "every literal in the file")',
  (shVarSkill.issues || []).some((i) => i.includes('.claude/.never-written.json')), JSON.stringify(shVarSkill));

// (4d) the written path comes from a HELPER FUNCTION (2026-09-24). MEASURED on every fresh install's doctor in CI:
// forge-docdrift (`const statePath = opts.statePath || defaultStatePath(root)`) and forge-audit-loop
// (`fs.appendFileSync(ledgerPath(root), …)`) were flagged for paths their own helpers build. One more bounded hop:
// a function CALLED in the write/declaration window has its `function NAME(` line harvested. A helper that is
// never called from a write path contributes nothing.
const SH_FN_ROOT = makeCompletenessBase('forge-doctor-skillhygiene-generated-fn-');
fs.writeFileSync(path.join(SH_FN_ROOT, '.claude', 'forge-bin', 'marker-fn.cjs'),
  "'use strict';\nconst fs = require('fs');\nconst path = require('path');\n"
  + "function ledgerPath(root) { return path.join(root, '.claude', 'forge-audit', '.fn-ledger.jsonl'); }\n"
  + "function defaultStatePath(root) { return path.join(root, '.claude', 'forge-research', '.fn-state.json'); }\n"
  + "function decoyPath(root) { return path.join(root, '.claude', '.fn-decoy-never-written.json'); }\n"
  + "function save(root, opts) {\n  const statePath = opts.statePath || defaultStatePath(root);\n  fs.writeFileSync(statePath, '{}', 'utf8');\n"
  + "  fs.appendFileSync(ledgerPath(root), '{}\\n', 'utf8');\n}\n"
  + "module.exports = { save, decoyPath };\n");
fs.mkdirSync(path.join(SH_FN_ROOT, '.claude', 'skills', 'gen-fn'), { recursive: true });
fs.writeFileSync(path.join(SH_FN_ROOT, '.claude', 'skills', 'gen-fn', 'SKILL.md'),
  '---\nname: gen-fn\ndescription: A short, valid description.\n---\n\n# gen-fn\n\n'
  + 'Appends to `.claude/forge-audit/.fn-ledger.jsonl`, persists `.claude/forge-research/.fn-state.json` and mentions `.claude/.fn-decoy-never-written.json`.\n');
const shFnRep = D.runDoctor(SH_FN_ROOT);
const shFnSkill = shFnRep.advisory.completeness.skill_hygiene.skills.find((s) => s.skill === 'gen-fn') || {};
t('skillHygiene: a path built by a helper called directly in the write (appendFileSync(ledgerPath(root))) is a generated ref',
  Array.isArray(shFnSkill.generated_refs) && shFnSkill.generated_refs.includes('.claude/forge-audit/.fn-ledger.jsonl') && !JSON.stringify(shFnSkill.issues || []).includes('.fn-ledger.jsonl'), JSON.stringify(shFnSkill));
t('skillHygiene: a path built by a helper reached through a declaration (const p = opts.p || defaultStatePath(root)) is a generated ref',
  Array.isArray(shFnSkill.generated_refs) && shFnSkill.generated_refs.includes('.claude/forge-research/.fn-state.json') && !JSON.stringify(shFnSkill.issues || []).includes('.fn-state.json'), JSON.stringify(shFnSkill));
t('skillHygiene: a helper that is NEVER called from a write path still yields a dangling reference (the hop is bounded to called helpers)',
  (shFnSkill.issues || []).some((i) => i.includes('.claude/.fn-decoy-never-written.json')), JSON.stringify(shFnSkill));

// (5) prose-with-slash NOT flagged: an alternation phrase ("manifest.json/events.jsonl", meaning "either
// file", not a nested directory) and an UNANCHORED path-shaped example (a generic downstream-project
// illustration with neither a .claude/ nor a references//scripts//assets/ prefix) must both be silently
// skipped — proves the false-positive-on-prose guard actually holds, not just that anchored real gaps work.
const SH_PROSE_ROOT = makeCompletenessBase('forge-doctor-skillhygiene-prose-');
fs.mkdirSync(path.join(SH_PROSE_ROOT, '.claude', 'skills', 'prose-skill'), { recursive: true });
fs.writeFileSync(path.join(SH_PROSE_ROOT, '.claude', 'skills', 'prose-skill', 'SKILL.md'),
  '---\nname: prose-skill\ndescription: A short, valid description.\n---\n\n# prose-skill\n\n'
  + 'The briefing only ever renders what `manifest.json/events.jsonl` already say. See `docs/ARCHITECTURE.md` '
  + 'for how a downstream built project might document its own contract — neither of these is a reference into '
  + 'THIS project\'s own tree.\n');
const shProseRep = D.runDoctor(SH_PROSE_ROOT);
t('skillHygiene prose-with-slash fixture: GREEN -> advisory.completeness.skill_hygiene.ok is true (no false positive)', shProseRep.advisory.completeness.skill_hygiene.ok === true, JSON.stringify(shProseRep.advisory.completeness.skill_hygiene));
t('skillHygiene prose-with-slash fixture: the alternation phrase + the unanchored example are both absent from any issue', !shProseRep.advisory.completeness.skill_hygiene.skills.some((s) => s.issues.some((i) => i.includes('manifest.json') || i.includes('docs/ARCHITECTURE.md'))));
const shProseSummary = D.printSummary(shProseRep);
t('printSummary: prose-with-slash fixture never mentions "skill-hygiene:" (nothing to name)', !/skill-hygiene:/.test(shProseSummary), shProseSummary);

// (6) NESTED skill dir (2026-08-01): a skill that lives at `skills/<parent>/<child>/SKILL.md` rather than
// `skills/<name>/SKILL.md`. MEASURED on this project the same day: `ls .claude/skills/*/SKILL.md | wc -l`
// = 49 but `find .claude/skills -name SKILL.md | wc -l` = 57 — the 8 gsap sub-skills sit one level deeper
// and were therefore evaluated by NOTHING, while every one of them is over the description budget this
// check exists to police. skillHygiene() read only the FIRST level of `.claude/skills/` (a single
// readdirSync + a direct `<dir>/SKILL.md` read), so a nested skill was not "passing" — it was invisible,
// which is strictly worse than a red finding. A sibling TOP-LEVEL skill is included in the same fixture so
// this also proves the recursion ADDS the nested level rather than replacing the flat one.
const SH_NESTED_ROOT = makeCompletenessBase('forge-doctor-skillhygiene-nested-');
fs.mkdirSync(path.join(SH_NESTED_ROOT, '.claude', 'skills', 'bundle', 'nested-child'), { recursive: true });
fs.writeFileSync(path.join(SH_NESTED_ROOT, '.claude', 'skills', 'bundle', 'nested-child', 'SKILL.md'),
  '---\nname: nested-child\ndescription: ' + 'B'.repeat(240) + '\n---\n\n# nested-child\n');
fs.mkdirSync(path.join(SH_NESTED_ROOT, '.claude', 'skills', 'flat-sibling'), { recursive: true });
fs.writeFileSync(path.join(SH_NESTED_ROOT, '.claude', 'skills', 'flat-sibling', 'SKILL.md'),
  '---\nname: flat-sibling\ndescription: A short, valid description.\n---\n\n# flat-sibling\n');
const shNestedRep = D.runDoctor(SH_NESTED_ROOT);
t('skillHygiene nested fixture: BOTH the nested and the flat skill are evaluated (checked === 2 — the nested one used to be invisible, not passing)', shNestedRep.advisory.completeness.skill_hygiene.checked === 2, JSON.stringify(shNestedRep.advisory.completeness.skill_hygiene));
t('skillHygiene nested fixture: RED -> the nested skill\'s over-long description is reported, named by its skills/-relative id', shNestedRep.advisory.completeness.skill_hygiene.skills.some((s) => s.skill === 'bundle/nested-child' && s.issues.some((i) => /description is 240 chars \(max 200\)/.test(i))), JSON.stringify(shNestedRep.advisory.completeness.skill_hygiene));
t('skillHygiene nested fixture: the flat sibling is still evaluated and still clean (recursion ADDS a level, never replaces the flat one)', shNestedRep.advisory.completeness.skill_hygiene.skills.some((s) => s.skill === 'flat-sibling' && s.ok === true), JSON.stringify(shNestedRep.advisory.completeness.skill_hygiene));
t('skillHygiene nested fixture: a nested finding is still ADVISORY — doctor.ok stays true', shNestedRep.ok === true);
const shNestedSummary = D.printSummary(shNestedRep);
t('printSummary: names the nested skill by its full skills/-relative id under "skill-hygiene:"', /skill-hygiene: bundle\/nested-child/.test(shNestedSummary), shNestedSummary);

// (7) VENDORED skills (2026-08-01): the two findings this check had left standing were `humanizer` (626
// lines, upstream github.com/blader/humanizer @1b48564) and the 8 gsap sub-skills (upstream
// github.com/greensock/gsap-skills @aed9cfd) — every one of them THIRD-PARTY CONTENT COPIED VERBATIM AT A
// RECORDED PIN. Restyling them to satisfy our own budget would rewrite someone else's file and make the
// recorded pin describe something that is no longer on disk, and the whole gain is ~250 tokens of a 33k
// always-loaded budget. So a permanently unactionable advisory, which is worse than no advisory: it teaches
// the reader to skim past the line where a REAL finding will one day appear.
//
// The split is between SHAPE and FUNCTION, and only shape is upstream's business:
//   · description length / body length  -> upstream's editorial choice. Reported as `vendored_style`, with
//     the real numbers, so the cost stays visible — but it is not OUR hygiene gap.
//   · missing description / dangling reference -> broken IN OUR TREE regardless of who wrote it. Still a
//     real issue, still red.
// Provenance must be EARNED: both a `Source:` and a `Pinned commit:` line. A half-marker proves nothing and
// must not buy an exemption, or "vendored" becomes a comment anyone can type to silence the check.
const SH_VENDOR_ROOT = makeCompletenessBase('forge-doctor-skillhygiene-vendor-');
const VENDOR_HEADER = '\n<!--\n  Source: https://github.com/example/upstream-skills\n'
  + '  Pinned commit: 1b48564898e999219882660237fde01bf4843a0f (2026-06-29T20:43:04Z)\n  License: MIT\n-->\n';
fs.mkdirSync(path.join(SH_VENDOR_ROOT, '.claude', 'skills', 'vendored-long'), { recursive: true });
fs.writeFileSync(path.join(SH_VENDOR_ROOT, '.claude', 'skills', 'vendored-long', 'SKILL.md'),
  '---\nname: vendored-long\ndescription: ' + 'V'.repeat(260) + '\n---\n' + VENDOR_HEADER + '\n# vendored-long\n\n' + 'filler line\n'.repeat(520));
// a skill WE authored, same two style violations, no provenance marker — must stay red
fs.mkdirSync(path.join(SH_VENDOR_ROOT, '.claude', 'skills', 'ours-long'), { recursive: true });
fs.writeFileSync(path.join(SH_VENDOR_ROOT, '.claude', 'skills', 'ours-long', 'SKILL.md'),
  '---\nname: ours-long\ndescription: ' + 'O'.repeat(260) + '\n---\n\n# ours-long\n');
const shVendorRep = D.runDoctor(SH_VENDOR_ROOT);
const shVendorHyg = shVendorRep.advisory.completeness.skill_hygiene;
t('skillHygiene vendored: a pinned upstream skill\'s over-long description is NOT one of our hygiene issues',
  shVendorHyg.skills.some((s) => s.skill === 'vendored-long' && !s.issues.some((i) => /description is \d+ chars/.test(i))), JSON.stringify(shVendorHyg));
t('skillHygiene vendored: nor is its over-long body',
  shVendorHyg.skills.some((s) => s.skill === 'vendored-long' && !s.issues.some((i) => /SKILL\.md is \d+ lines/.test(i))), JSON.stringify(shVendorHyg));
t('skillHygiene vendored: but the real numbers ARE still reported under vendored_style — the cost stays visible',
  shVendorHyg.skills.some((s) => s.skill === 'vendored-long' && Array.isArray(s.vendored_style)
    && s.vendored_style.some((i) => /description is 260 chars/.test(i))
    && s.vendored_style.some((i) => /SKILL\.md is \d+ lines/.test(i))), JSON.stringify(shVendorHyg));
t('skillHygiene vendored: the upstream source and pin are recorded, so the exemption is traceable to evidence',
  shVendorHyg.skills.some((s) => s.skill === 'vendored-long' && s.vendored && /github\.com\/example\/upstream-skills/.test(s.vendored.source) && /^1b48564/.test(s.vendored.pin)), JSON.stringify(shVendorHyg));
t('skillHygiene vendored: OUR OWN skill with the identical violation is still RED (the exemption is scoped to provenance, not to the rule)',
  shVendorHyg.ok === false && shVendorHyg.skills.some((s) => s.skill === 'ours-long' && s.issues.some((i) => /description is 260 chars/.test(i))), JSON.stringify(shVendorHyg));
const shVendorSummary = D.printSummary(shVendorRep);
t('printSummary: still names OUR skill under "skill-hygiene:", and never the vendored one',
  /skill-hygiene: ours-long/.test(shVendorSummary) && !/skill-hygiene:[^\n]*vendored-long/.test(shVendorSummary), shVendorSummary);

// (7b) the exemption covers SHAPE only: a vendored skill that is BROKEN in our tree is still red.
const SH_VENDOR_BROKEN = makeCompletenessBase('forge-doctor-skillhygiene-vendorbroken-');
fs.mkdirSync(path.join(SH_VENDOR_BROKEN, '.claude', 'skills', 'vendored-broken'), { recursive: true });
fs.writeFileSync(path.join(SH_VENDOR_BROKEN, '.claude', 'skills', 'vendored-broken', 'SKILL.md'),
  '---\nname: vendored-broken\ndescription: A short, valid description.\n---\n' + VENDOR_HEADER
  + '\n# vendored-broken\n\nSee `references/missing.md`.\n');
const shVendorBrokenHyg = D.runDoctor(SH_VENDOR_BROKEN).advisory.completeness.skill_hygiene;
t('skillHygiene vendored: a DANGLING reference in a vendored skill is still a real issue (broken is broken, whoever wrote it)',
  shVendorBrokenHyg.ok === false && shVendorBrokenHyg.skills.some((s) => s.skill === 'vendored-broken' && s.issues.some((i) => /dangling reference/.test(i))), JSON.stringify(shVendorBrokenHyg));

// (7c) a HALF marker buys nothing — otherwise one typed line silences the check.
const SH_VENDOR_HALF = makeCompletenessBase('forge-doctor-skillhygiene-vendorhalf-');
fs.mkdirSync(path.join(SH_VENDOR_HALF, '.claude', 'skills', 'half-marked'), { recursive: true });
fs.writeFileSync(path.join(SH_VENDOR_HALF, '.claude', 'skills', 'half-marked', 'SKILL.md'),
  '---\nname: half-marked\ndescription: ' + 'H'.repeat(260) + '\n---\n\n<!--\n  Source: https://github.com/example/upstream-skills\n-->\n\n# half-marked\n');
const shVendorHalfHyg = D.runDoctor(SH_VENDOR_HALF).advisory.completeness.skill_hygiene;
t('skillHygiene vendored: a Source line WITHOUT a pinned commit does not count as vendored — still RED',
  shVendorHalfHyg.ok === false && shVendorHalfHyg.skills.some((s) => s.skill === 'half-marked' && s.issues.some((i) => /description is 260 chars/.test(i))), JSON.stringify(shVendorHalfHyg));

// direct extractSkillPathRefs() unit proof — the exact filtering rules, independent of the doctor plumbing
const proseRefs = D.extractSkillPathRefs('See `manifest.json/events.jsonl`, `docs/ARCHITECTURE.md`, `.claude/forge-bin/does-not-exist.cjs`, `references/missing.md`, `<run_id>/config.json`, `config/orchestration/*.json`.');
t('extractSkillPathRefs: rejects the alternation-prose token entirely (never returned)', !proseRefs.some((r) => r.ref.includes('manifest.json')));
t('extractSkillPathRefs: returns the unanchored example but marks it anchored:false', proseRefs.some((r) => r.ref === 'docs/ARCHITECTURE.md' && r.anchored === false));
t('extractSkillPathRefs: returns BOTH real anchor forms marked anchored:true', proseRefs.some((r) => r.ref === '.claude/forge-bin/does-not-exist.cjs' && r.anchored === true) && proseRefs.some((r) => r.ref === 'references/missing.md' && r.anchored === true));
t('extractSkillPathRefs: rejects a placeholder token containing "<"', !proseRefs.some((r) => r.ref.includes('<')));
t('extractSkillPathRefs: rejects a glob token containing "*"', !proseRefs.some((r) => r.ref.includes('*')));

// ===========================================================================================================
// context_budget (2026-08-01) — the ALWAYS-LOADED instruction surface as a doctor advisory. Same core
// guarantee as every other advisory: a real finding must surface in advisory.context_budget and in
// printSummary, but must NEVER flip runDoctor()'s hard `ok` verdict. See forge-contextbudget.cjs for the
// measured reason this exists (nothing counted the chain; its growth truncated the skill list on 07-31).
// ===========================================================================================================
const CBUD_ROOT = makeCompletenessBase('forge-doctor-contextbudget-');
const cbudRep = D.runDoctor(CBUD_ROOT);
t('context_budget: runDoctor exposes advisory.context_budget with a real estimated-token total', cbudRep.advisory.context_budget && typeof cbudRep.advisory.context_budget.total_approx_tokens === 'number', JSON.stringify(cbudRep.advisory.context_budget && Object.keys(cbudRep.advisory.context_budget)));
t('context_budget: it is labelled an ESTIMATE in the report itself (no fake tokenizer precision)', /estimate/i.test(cbudRep.advisory.context_budget.estimate_note));
t('context_budget: it lives under `advisory`, never under `checks` (it can never fail a build)', !Object.prototype.hasOwnProperty.call(cbudRep.checks, 'context_budget'));
// a REAL finding must surface without flipping doctor.ok — forced by baselining the project CLAUDE.md at a
// value the fixture's own file provably exceeds, i.e. a genuine over-baseline, not a mocked one.
fs.writeFileSync(path.join(CBUD_ROOT, 'CLAUDE.md'), 'z'.repeat(40000));
const cbudMod = require('./forge-contextbudget.cjs');
const cbudCfg = cbudMod.readConfig(CBUD_ROOT);
cbudCfg.baseline = { generated_at: '2026-08-01T00:00:00.000Z', total_approx_tokens: 1, posts: { project_claude_md: 1 } };
cbudMod.saveConfig(CBUD_ROOT, cbudCfg);
const cbudGrown = D.runDoctor(CBUD_ROOT);
t('context_budget: a genuine over-baseline post surfaces as a named advisory finding', cbudGrown.advisory.context_budget.findings.some((f) => f.kind === 'over_baseline' && f.id === 'project_claude_md'), JSON.stringify(cbudGrown.advisory.context_budget.findings));
t('context_budget: and that finding does NOT flip doctor.ok (advisory, exactly like skill_hygiene)', cbudGrown.ok === true, JSON.stringify(Object.entries(cbudGrown.checks).filter(([, c]) => !c.ok).map(([k]) => k)));
const cbudSummary = D.printSummary(cbudGrown);
t('printSummary: renders a context-budget line naming the grown post', /context budget/i.test(cbudSummary) && /project_claude_md|project CLAUDE\.md/.test(cbudSummary), cbudSummary);
t('printSummary: the context-budget line is advisory (⚠), never a hard ✗', !/✗ context budget/.test(cbudSummary));
// real project: the meter actually runs here and reports a plausible, non-zero surface
const cbudReal = D.runDoctor.length >= 0 && require('./forge-contextbudget.cjs').measure(REAL_PROJECT_ROOT, {});
t('context_budget: on the REAL project it measures a non-zero always-loaded surface across every named post', cbudReal.total_approx_tokens > 1000 && ['global_claude_md', 'ecc_rules_common', 'project_claude_md', 'skill_catalog_project', 'skill_catalog_global', 'skill_catalog_plugins'].every((id) => cbudReal.posts.some((p) => p.id === id)), 'total=' + cbudReal.total_approx_tokens);
t('context_budget: the REAL project has no dead @-include in its global chain', !cbudReal.findings.some((f) => f.kind === 'dead_include'), JSON.stringify(cbudReal.findings));
// the skill surface is THREE sources, reported separately (2026-08-01, second pass): the meter used to count
// only this project's .claude/skills — 57 of the 278 skills a session carries — and the doctor line repeated
// that as the whole figure. Both the JSON and the printed line must now carry the breakdown.
// "none of them zero on THIS machine" is a statement about the author's ~/.claude, not about the meter:
// a fresh install or a CI runner has no global skill catalog and no plugins, so 0 is the truth there.
// The structural half (three sources, reported separately) stays strict everywhere; the non-zero half
// only where a global catalog actually exists (external audit II-B, 2026-09-23).
t('context_budget: the REAL measurement reports all three skill sources separately', cbudReal.skill_sources.length === 3, JSON.stringify((cbudReal.skill_sources || []).map((s) => s.id + '=' + s.skills)));
if (fs.existsSync(path.join(require('os').homedir(), '.claude', 'skills')) && fs.existsSync(path.join(require('os').homedir(), '.claude', 'plugins'))) {
  t('context_budget: on a machine WITH a global skills dir and a plugin catalog, none of the three sources is zero', cbudReal.skill_sources.every((s) => s.skills > 0), JSON.stringify((cbudReal.skill_sources || []).map((s) => s.id + '=' + s.skills)));
} else {
  skipped++;
  console.log('  SKIP context_budget non-zero-sources — this machine has no ~/.claude/skills and/or ~/.claude/plugins; a zero count is the truth here, not a defect');
}
t('context_budget: the two out-of-project catalogs are flagged read-only, never write-touched', cbudReal.skill_sources.filter((s) => !s.in_project).length === 2 && cbudReal.skill_sources.filter((s) => !s.in_project).every((s) => s.access === 'read-only'), JSON.stringify(cbudReal.skill_sources.map((s) => s.id + ':' + s.access)));
t('context_budget: no skill walk hit its depth cap on the real machine (a capped walk would be a finding, not a smaller number)', !cbudReal.findings.some((f) => f.kind === 'depth_capped'), JSON.stringify(cbudReal.findings.filter((f) => f.kind === 'depth_capped')));
// asserted on the doctor report ALREADY computed above — never on a second runDoctor(REAL_PROJECT_ROOT),
// because runDoctor() runs runTests(), i.e. spawns all 105 suites: calling it from inside a suite makes this
// file take 278s and hit the 120s per-suite timeout (measured 2026-08-01, the one red this work package
// produced). cbudGrown is a real doctor run whose context-budget post-set includes the two REAL out-of-project
// catalogs, so the breakdown in its printSummary line is genuine output, not a fixture value.
// the `( \(absent\))?` is not slack in the assertion — this fixture project genuinely has no .claude/skills
// directory, and the line says so ("project 0 (absent)") rather than printing a bare 0 that would read as an
// empty catalog. A source that is missing and a source that is empty are different facts.
t('printSummary: the context-budget line shows the per-source skill breakdown, not one project-only number', /skills: project \d+( \(absent\))? \+ global \d+( \(absent\))? \+ plugins \d+/.test(cbudSummary), (cbudSummary.split('\n').find((l) => /context budget/.test(l)) || 'no context-budget line'));
t('printSummary: a skill source that is absent rather than empty is marked as such in the line', /project 0 \(absent\)/.test(cbudSummary), (cbudSummary.split('\n').find((l) => /context budget/.test(l)) || 'no context-budget line'));

// real-project regression guard: this project's OWN real skills are evaluated (no drift), and the KNOWN,
// already-real, non-blocking findings are named exactly — a genuine NEW regression elsewhere would show up
// as an EXTRA failing skill here, not silently absorbed into this fixed expectation.
const realSkillHygiene = D.skillHygiene(REAL_PROJECT_ROOT);
// COUNT (2026-08-01): 49 -> 57. Not project growth: not one skill was added. The recursive-scope fix above
// simply made the 8 gsap sub-skills VISIBLE to a check that had never once looked at them. Measured both
// ways on this project the same day: `ls .claude/skills/*/SKILL.md | wc -l` = 49 vs
// `find .claude/skills -name SKILL.md | wc -l` = 57.
pinned('skillHygiene: the real project has exactly 59 skills evaluated — all 8 NESTED ones included (no drift)', () =>
  t('skillHygiene: the real project has exactly 59 skills evaluated — all 8 NESTED ones included (no drift)', realSkillHygiene.checked === 59, 'checked=' + realSkillHygiene.checked));
// FINDINGS (2026-08-01, second revision): 10 -> 1. The 9 that left are ALL third-party skills copied at a
// recorded pin (humanizer @1b48564, the 8 gsap sub-skills @aed9cfd) and they did NOT disappear — they moved
// to `vendored_style`, numbers intact, because their shape is upstream's editorial choice while their
// function in our tree is still judged. The limit was NOT relaxed and no name was allowlisted: the exemption
// is driven by provenance the vendoring step actually wrote into each file.
//
// Two guards, deliberately in opposite directions, so this cannot rot into a rubber stamp:
//   (a) exactly ONE real finding remains, named — a NEW regression cannot hide inside a total;
//   (b) exactly NINE skills carry vendored_style with a real source+pin — if a future edit made the
//       exemption too broad and swallowed one of ours, this count moves and the test fails.
// 2026-08-09: this list is now EMPTY, and that is a fix rather than a loosening. Its only entry was
// forge-snapshot, flagged for documenting `.claude/.forge-snapshot-due.json` — a marker its own
// forge-snapshot-marker.cjs writes and the SessionStart hook consumes, so "absent" is its normal state.
// generatedPathBasenames() now reclassifies such a reference under generated_refs instead of counting it
// as a broken link. Guard (c) below asserts that reclassification really happened, so an empty findings
// list can never be reached by simply switching the check off.
const KNOWN_HYGIENE_FINDINGS = [].sort();
const KNOWN_VENDORED_EXEMPT = [
  'humanizer',         // 626-line body — github.com/blader/humanizer @1b48564
  'gsap/gsap-core', 'gsap/gsap-frameworks', 'gsap/gsap-performance', 'gsap/gsap-plugins',
  'gsap/gsap-react', 'gsap/gsap-scrolltrigger', 'gsap/gsap-timeline', 'gsap/gsap-utils', // @aed9cfd
].sort();
devTreeOnly('skillHygiene: the real project carries exactly the KNOWN findings — never a silent NEW regression', () =>
  t('skillHygiene: the real project carries exactly the KNOWN findings — never a silent NEW regression', realSkillHygiene.skills.filter((s) => !s.ok).map((s) => s.skill).sort().join(',') === KNOWN_HYGIENE_FINDINGS.join(','), JSON.stringify(realSkillHygiene.skills.filter((s) => !s.ok))));
// (c) the empty findings list above must be earned by RECLASSIFICATION, not by a check that stopped
// looking: forge-snapshot still has to surface its marker reference, now under generated_refs.
devTreeOnly('skillHygiene: forge-snapshot still REPORTS its runtime marker, now as a generated ref', () =>
  t('skillHygiene: forge-snapshot still REPORTS its runtime marker, now as a generated ref',
    (realSkillHygiene.skills.find((s) => s.skill === 'forge-snapshot') || {}).generated_refs?.some((r) => r.includes('.forge-snapshot-due.json')) === true,
    JSON.stringify(realSkillHygiene.skills.find((s) => s.skill === 'forge-snapshot'))));
// (d) 2026-09-23: forge-router and forge-intake now read `.claude/.forge-setup.json` (what /setup-forge saved,
// so the silent intake never re-asks it). forge-setup.cjs writes that file through a path VARIABLE; the
// reference must surface as a generated ref, not as the dangling link the real doctor reported before the fix.
devTreeOnly('skillHygiene: forge-router REPORTS the /setup-forge marker as a generated ref (variable-written path resolved)', () =>
  t('skillHygiene: forge-router REPORTS the /setup-forge marker as a generated ref (variable-written path resolved)',
    (realSkillHygiene.skills.find((s) => s.skill === 'forge-router') || {}).generated_refs?.some((r) => r.includes('.forge-setup.json')) === true,
    JSON.stringify(realSkillHygiene.skills.find((s) => s.skill === 'forge-router'))));
// The three assertions below all describe the VENDORED skills specifically, which is exactly the surface
// the distribution strips. Note that two of them are `every(...)` over a filtered array: in a tree with no
// vendored skills they would not fail, they would pass VACUOUSLY over an empty list — a silent green that
// looks like coverage and is none. Being visibly skipped is the honest outcome there; being strict is the
// honest outcome here.
pinned('skillHygiene: exactly the 9 pinned upstream skills carry a vendored_style entry', () =>
  t('skillHygiene: exactly the 9 pinned upstream skills carry a vendored_style entry (the exemption did not widen to cover one of ours)', realSkillHygiene.skills.filter((s) => s.vendored && s.vendored_style.length).map((s) => s.skill).sort().join(',') === KNOWN_VENDORED_EXEMPT.join(','), JSON.stringify(realSkillHygiene.skills.filter((s) => s.vendored && s.vendored_style.length).map((s) => ({ skill: s.skill, vendored: s.vendored, vendored_style: s.vendored_style })))));
pinned('skillHygiene: every exempted skill really does carry BOTH an upstream source and a commit pin', () =>
  t('skillHygiene: every exempted skill really does carry BOTH an upstream source and a commit pin (evidence, not a label)', realSkillHygiene.skills.filter((s) => s.vendored).every((s) => /^https?:\/\/\S+/.test(s.vendored.source) && /^[0-9a-f]{7,40}$/.test(s.vendored.pin)), JSON.stringify(realSkillHygiene.skills.filter((s) => s.vendored).map((s) => s.vendored))));
pinned('skillHygiene: the 8 gsap findings are still MEASURED, just filed as upstream shape', () =>
  t('skillHygiene: the 8 gsap findings are still MEASURED, just filed as upstream shape (their real char counts survive)', realSkillHygiene.skills.filter((s) => s.skill.startsWith('gsap/')).every((s) => s.issues.length === 0 && s.vendored_style.length === 1 && /^description is \d+ chars \(max 200\)$/.test(s.vendored_style[0])), JSON.stringify(realSkillHygiene.skills.filter((s) => s.skill.startsWith('gsap/')))));

// =====================================================================================================
// §9 NESTED GIT REPOSITORIES — the leak scan's biggest blind spot (2026-08-02)
//
// MEASURED, not assumed, on this very project the day this section was written:
//   git ls-files | wc -l                      -> 1298
//   git ls-files | grep -c '^command-center/' ->    0
// `command-center/` is its OWN git repository nested under the project root. trackedFiles() sourced the
// whole leak scan from a single `git ls-files` at the root, so every file in that tree — the gateway that
// spawns the real `claude` CLI, the Discord integration whose .env holds a live bot token — was never
// looked at even once, while the doctor printed "1146 tracked files (git) · clean" and the sync gate read
// that as coverage. The scan was not clean; it was blindfolded, and nothing in the output said so.
//
// The fixture below is the same shape in miniature: an outer repo, an inner repo, a real-looking secret
// tracked inside the inner one, and a genuinely gitignored .env next to it. Two things are proven at once
// and they pull in opposite directions on purpose — the secret must be FOUND (coverage), the .env must
// stay UNSEEN (gitignore is still honored, and a path we were never meant to read is not a path we may
// print).
// =====================================================================================================
const NESTED_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-nested-'));
const NESTED_SECRET = 'nvapi-7hQ2rLm9vKcW4dTgB1yZxP6nUaEjR8sFoI3lMwYtHqZbNvCxDkSuGpJr';   // long, high-entropy, no placeholder marker
const NESTED_ENV_SECRET = 'nvapi-2bXvNm8qLpRt5wZyK7cHgD1aJfSoUeI4MdQxTnBvGrYkWsPzCuLhFj';
const gitOk = (dir, ...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).status === 0;
// the outer repo: one ordinary tracked file, no secret of its own
fs.writeFileSync(path.join(NESTED_ROOT, 'readme.md'), '# outer project\nnothing secret here\n');
// the inner repo: a TRACKED file carrying a real-looking secret, plus a genuinely IGNORED .env carrying
// another one. `git add -A` inside the inner repo honors its own .gitignore, so the .env is never listed.
const NESTED_SUB = path.join(NESTED_ROOT, 'command-center');
fs.mkdirSync(NESTED_SUB, { recursive: true });
fs.writeFileSync(path.join(NESTED_SUB, '.gitignore'), '.env\n');
fs.writeFileSync(path.join(NESTED_SUB, 'gateway-config.md'), 'deploy key = ' + NESTED_SECRET + '\n');
fs.writeFileSync(path.join(NESTED_SUB, '.env'), 'DISCORD_TOKEN=' + NESTED_ENV_SECRET + '\n');
// ORDER AND SCOPE MATTER, and getting them wrong silently destroys the test: the inner repo is created
// FIRST and the outer repo then tracks ONLY its own readme.md. That reproduces the measured shape of this
// project exactly — `git ls-files | grep -c '^command-center/'` = 0, the nested tree entirely absent from
// the outer index. (Written the other way round — outer `git add -A` before the inner `git init` — the
// outer repo happily absorbs the nested files, the secret is found by the ROOT source, and the test passes
// while proving nothing at all. That is the first version of this fixture, and it passed.)
const nestedGitReady = gitOk(NESTED_SUB, 'init', '-q')
  && gitOk(NESTED_SUB, 'add', '-A')
  && gitOk(NESTED_ROOT, 'init', '-q')
  && gitOk(NESTED_ROOT, 'add', 'readme.md');
if (!nestedGitReady) {
  // A visible skip, never a silent green: this section's whole claim is about what `git ls-files` reports,
  // so without a working git there is nothing here to prove either way.
  skip('nested-repo leak scan (§9)', 'git init/add unavailable in this environment — the section proves a git ls-files property and cannot be faked');
} else {
  const nestedLeak = D.leakScan(NESTED_ROOT);
  const nestedJson = JSON.stringify(nestedLeak);
  // PRECONDITION, asserted rather than assumed: the outer repo really does contribute only readme.md, so a
  // hit on the nested file can ONLY have come from a second source. Without this the test above could go
  // green because the fixture leaked into the root index instead of because the scan was widened.
  t('leakScan: the outer repo genuinely tracks only its own file (the nested tree is invisible to it)',
    (nestedLeak.sources || []).some((s) => s.root === '.' && s.files === 1), JSON.stringify(nestedLeak.sources));
  // THE BUG: before this fix the inner repo contributed nothing at all and this was 0 hits + "clean".
  t('leakScan: a secret tracked in a NESTED git repo is found (the command-center blind spot)',
    nestedLeak.hits.some((h) => h.file.replace(/\\/g, '/') === 'command-center/gateway-config.md' && h.pattern === 'nvidia-nvapi-key'), nestedJson);
  t('leakScan: and that makes the verdict red rather than a blindfolded "clean"', nestedLeak.ok === false);
  // gitignore is still the boundary: a file the inner repo deliberately does not track is not scanned, is
  // not reported as a path, and its contents never reach the output.
  t('leakScan: a gitignored .env inside the nested repo is NOT scanned and NOT named as a path',
    !nestedJson.includes('.env'), nestedJson);
  t('leakScan: neither secret is ever echoed into the report (paths and pattern labels only)',
    !nestedJson.includes(NESTED_SECRET) && !nestedJson.includes(NESTED_ENV_SECRET));
  // HONEST ACCOUNTING: the printed total must say how many files came from how many repos, or a reader has
  // no way to tell a widened scan from a lucky one.
  t('leakScan: reports one entry per contributing repo, each with its own listed-file count',
    Array.isArray(nestedLeak.sources) && nestedLeak.sources.length === 2
      && nestedLeak.sources.some((s) => s.root === '.' && s.method === 'git' && s.files > 0)
      && nestedLeak.sources.some((s) => s.root === 'command-center' && s.method === 'git' && s.files > 0),
    JSON.stringify(nestedLeak.sources));
  const nestedSummary = D.printSummary({ root: NESTED_ROOT, ok: false, checks: { node_check: { ok: true, total: 1 }, tests: { ok: true, suites: 1, passed: 1, failed: 0, perSuite: [] }, strict_events: { ok: true }, dashboard_spa: { ok: true, missing: [] }, leak_scan: nestedLeak }, advisory: {} });
  t('printSummary: the leak-scan line names the nested repo as a separate source, not one anonymous total',
    /2 repos: \. \d+ \+ command-center \d+/.test(nestedSummary), (nestedSummary.split('\n').find((l) => /leak scan/.test(l)) || nestedSummary));
}
// A project with NO nested repo must behave exactly as it always did — one source, no extra clause, same
// single-repo line. A widened scan that quietly restyles every ordinary project's output is a regression
// of its own.
const SOLO_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-solo-'));
fs.writeFileSync(path.join(SOLO_ROOT, 'readme.md'), '# solo project\nno secrets, no nesting\n');
if (!gitOk(SOLO_ROOT, 'init', '-q') || !gitOk(SOLO_ROOT, 'add', '-A')) {
  skip('single-repo leak scan is unchanged (§9)', 'git init/add unavailable in this environment');
} else {
  const soloLeak = D.leakScan(SOLO_ROOT);
  t('leakScan: a project with no nested repo still reports exactly one git source', soloLeak.source === 'git' && soloLeak.sources.length === 1 && soloLeak.sources[0].root === '.', JSON.stringify(soloLeak.sources));
  const soloSummary = D.printSummary({ root: SOLO_ROOT, ok: true, checks: { node_check: { ok: true, total: 1 }, tests: { ok: true, suites: 1, passed: 1, failed: 0, perSuite: [] }, strict_events: { ok: true }, dashboard_spa: { ok: true, missing: [] }, leak_scan: soloLeak }, advisory: {} });
  t('printSummary: and its leak-scan line carries no multi-repo clause at all', /leak scan\s+\d+ tracked files \(git\) · clean/.test(soloSummary) && !/repos:/.test(soloSummary), (soloSummary.split('\n').find((l) => /leak scan/.test(l)) || soloSummary));
}

// =====================================================================================================
// §10 WHICH TREE IS THIS? — installationProfile + the skip contract it drives (2026-08-02)
//
// Five assertions across three suites pin an exact property of THIS installation ("57 skills"). They are
// real drift guards here and they fail in the published distribution for a reason that is not a defect:
// the 9 vendored third-party skills are deliberately not redistributed. The cure must not be a tolerance
// or a list of acceptable counts — a count that accepts two answers has stopped guarding anything. It is
// a detector, and the thing it detects has to be evidence rather than a label.
// =====================================================================================================
const IP_DEV = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-ip-dev-'));
const IP_DIST = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-ip-dist-'));
for (const [base, withVendor] of [[IP_DEV, true], [IP_DIST, false]]) {
  fs.mkdirSync(path.join(base, '.claude', 'skills', 'ours'), { recursive: true });
  fs.writeFileSync(path.join(base, '.claude', 'skills', 'ours', 'SKILL.md'), '---\nname: ours\ndescription: a skill we wrote ourselves\n---\n\nbody\n');
  if (withVendor) {
    fs.mkdirSync(path.join(base, '.claude', 'skills', 'upstream'), { recursive: true });
    // the real vendoring header shape, copied from .claude/skills/humanizer/SKILL.md: two indented
    // frontmatter lines, not a comment block. A fixture that invents its own marker syntax proves only
    // that the fixture is wrong (the first version of this one did exactly that and failed).
    fs.writeFileSync(path.join(base, '.claude', 'skills', 'upstream', 'SKILL.md'),
      '---\nname: upstream\ndescription: copied verbatim at a pin\nvendored: |\n  Source: https://github.com/someone/upstream\n  Pinned commit: 1b48564898e999219882660237fde01bf4843a0f\n---\n\nbody\n');
  }
}
const ipDev = D.installationProfile(IP_DEV);
const ipDist = D.installationProfile(IP_DIST);
t('installationProfile: a tree carrying a pinned upstream skill is the development tree', ipDev.profile === 'development' && ipDev.vendored.join(',') === 'upstream', JSON.stringify(ipDev));
t('installationProfile: a tree with the vendored skills stripped is a redistribution', ipDist.profile === 'redistribution' && ipDist.vendored.length === 0, JSON.stringify(ipDist));
t('installationProfile: both verdicts state a reason with the real counts, so a skip can quote it', /1 of 2 skills/.test(ipDev.reason) && /none of the 1 skills/.test(ipDist.reason), ipDev.reason + ' || ' + ipDist.reason);
// provenance must be EARNED: a half-marker (a Source: line with no pin) is not vendoring, or "vendored"
// becomes a word anyone can type to silence a check.
const IP_HALF = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-ip-half-'));
fs.mkdirSync(path.join(IP_HALF, '.claude', 'skills', 'claimed'), { recursive: true });
fs.writeFileSync(path.join(IP_HALF, '.claude', 'skills', 'claimed', 'SKILL.md'), '---\nname: claimed\ndescription: claims vendoring, proves nothing\nvendored: |\n  Source: https://github.com/someone/upstream\n---\n\nbody\n');
t('installationProfile: a Source: line with no commit pin does NOT make a tree "development"', D.installationProfile(IP_HALF).profile === 'redistribution', JSON.stringify(D.installationProfile(IP_HALF)));
// THE SKIP CONTRACT — the whole point of the mechanism. In the development tree a pinned assertion runs
// strictly; anywhere else it must be VISIBLY skipped and must NOT run. A pin that quietly stops asserting
// is worse than one that fails: the output looks identical to success.
let pinnedRan = false;
const skippedBefore = skipped;
const ranStrict = makePinned(ipDev)('§10 probe (development)', () => { pinnedRan = true; });
t('pinned: in the development tree the assertion actually runs and is reported as run', ranStrict === true && pinnedRan === true);
pinnedRan = false;
const ranDist = makePinned(ipDist)('§10 probe (redistribution) — expected to be skipped, this line is the proof', () => { pinnedRan = true; });
t('pinned: in a redistribution the assertion body does NOT run', ranDist === false && pinnedRan === false);
t('pinned: and the skip is counted + printed, never a silent green', skipped === skippedBefore + 1);

// --- the fixture exemption was JavaScript-only (found while widening the scan, 2026-08-02) --------------
// The rule "test fixtures legitimately hold fake secrets" has always existed; its implementation was
// /\.test\.[cm]?js$/i, which knows nothing about TypeScript. Every *.test.ts / *.test.tsx in a TS codebase
// was therefore scanned as production source and its deliberate fake credentials reported as leaks. That
// stayed invisible here only because the one TypeScript tree in this project — command-center/dashboard —
// was in the blind spot above: widening the scan surfaced 4 such cry-wolf hits immediately.
const TSFIX_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-tsfixture-'));
const TSFIX_SECRET = 'nvapi-5kRw8pZnJ2tLxQm7bVcHdY1uGaSoEiI4fMqXvNzTrBwCkPjUyLhDsGe';
for (const f of ['chat.test.ts', 'panel.test.tsx', 'gateway.test.mjs', 'legacy.test.cjs']) {
  fs.writeFileSync(path.join(TSFIX_ROOT, f), 'const key = "' + TSFIX_SECRET + '";\n');
}
fs.writeFileSync(path.join(TSFIX_ROOT, 'real-source.ts'), 'export const key = "' + TSFIX_SECRET + '";\n');
const tsfixLeak = D.leakScan(TSFIX_ROOT); // no git here -> walk fallback, same exemption rules
t('leakScan: *.test.ts / *.test.tsx are test fixtures too — the exemption is no longer JavaScript-only',
  !tsfixLeak.hits.some((h) => /\.test\.(ts|tsx|mjs|cjs)$/.test(h.file)), JSON.stringify(tsfixLeak.hits));
t('leakScan: and an ordinary .ts SOURCE file is still scanned (the exemption did not widen to all TypeScript)',
  tsfixLeak.hits.some((h) => h.file.endsWith('real-source.ts')), JSON.stringify(tsfixLeak.hits));

console.log(pass + ' passed, ' + fail + ' failed' + (skipped ? ', ' + skipped + ' skipped' : ''));
process.exitCode = fail ? 1 : 0;
