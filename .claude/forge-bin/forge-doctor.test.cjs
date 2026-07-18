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

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-'));
const cd = path.join(ROOT, '.claude');
fs.mkdirSync(path.join(cd, 'forge-dashboard'), { recursive: true });

// --- leakScan: a REAL-looking secret is caught; fakes/placeholders/test-files are NOT (precision) ---
const REAL = '\x6Evapi-9x7Kq2mZ4bTvA1cReW8pLdN6sGhY3jFuIoP0aQzX5wErTyUjHkLmNbVcXsz'; // long, no FAKE, no repeats
const FAKE = '\x6Evapi-FAKEFAKEFAKEFAKE1234567890'; // placeholder — must NOT be flagged
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
fs.writeFileSync(path.join(GREEN_ROOT, '.claude', 'forge-bin', 'good.test.cjs'), "console.log('1 passed, 0 failed');\nprocess.exit(0);\n");
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
fs.writeFileSync(path.join(BUG1_FAKE_ROOT, 'fixture.md'), 'sample = \x6Evapi-FAKEFAKEFAKEFAKE1234567890\n');
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
const PARITY_SK = '\x73k-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop1234567890';
const PARITY_AKIA = '\x41KIAABCDEFGHIJKLMNOP';
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
fs.writeFileSync(path.join(BUG1_DOC_ROOT, 'patterns-doc.md'), 'aws key shape looks like \x41KIAABCDEFGHIJKLMNOP when documented in prose\n');
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
fs.writeFileSync(path.join(BUG1_REGEXLIT_ROOT, 'patterns.cjs'), "const p = /\x41KIAABCDEFGHIJKLMNOP/g; // a real-key-shaped PATTERN DEFINITION, not a value\nmodule.exports = p;\n");
const bug1RegexLitLeak = D.leakScan(BUG1_REGEXLIT_ROOT);
t('ROUND3 whitelist-gate FIX: /pattern/flags JS syntax in a NON-whitelisted basename (patterns.cjs) is now FLAGGED, not exempted', bug1RegexLitLeak.ok === false && bug1RegexLitLeak.hits.some((h) => h.file.endsWith('patterns.cjs')));

// direct unit coverage of isPatternDefinitionContext()
{
  const ctxMatch = '\x41KIAABCDEFGHIJKLMNOP';
  const ctxLine1 = 'const p = /\x41KIAABCDEFGHIJKLMNOP/g;';
  t('isPatternDefinitionContext: true for a /pattern/flags literal on its own line', D.isPatternDefinitionContext(ctxLine1, ctxLine1.indexOf(ctxMatch), ctxMatch.length) === true);
  const ctxLine2 = 'const p = new RegExp("\x41KIAABCDEFGHIJKLMNOP");';
  t('isPatternDefinitionContext: true for new RegExp("pattern")', D.isPatternDefinitionContext(ctxLine2, ctxLine2.indexOf(ctxMatch), ctxMatch.length) === true);
  const ctxLine3 = '{"k":"\x41KIAABCDEFGHIJKLMNOP"}';
  t('isPatternDefinitionContext: false for a JSON string VALUE (REPRO A/B shape) — no /…/ or RegExp(...) syntax', D.isPatternDefinitionContext(ctxLine3, ctxLine3.indexOf(ctxMatch), ctxMatch.length) === false);
  const ctxMultiline = '-----BEGIN PRIVATE KEY-----\nMIIB1234567890ABCDEF\n-----END PRIVATE KEY-----';
  t('isPatternDefinitionContext: false when the match spans multiple physical lines (a real JS regex literal never does)', D.isPatternDefinitionContext(ctxMultiline, 0, ctxMultiline.length) === false);
}

// direct unit coverage of the (now pure content-only) looksLikeRealSecret — no more regex-source judgement
// here at all; that job belongs solely to isPatternDefinitionContext (tested above).
t('looksLikeRealSecret: a regex-shaped string (char class) is now content-ACCEPTED — context decides separately', D.looksLikeRealSecret('nvapi-[A-Za-z0-9_-]+') === true);
t('looksLikeRealSecret: a regex-shaped string (quantifier brace, no repeated filler) is also content-ACCEPTED', D.looksLikeRealSecret('sk-ABCDEFGHIJKLMNOP{20,}') === true);
t('looksLikeRealSecret: STILL rejects genuine repeated-filler (7+ same char), independent of regex shape', D.looksLikeRealSecret('sk-AAAAAAAAAAAAAAAA{20,}') === false);
t('looksLikeRealSecret: ACCEPTS a real-looking base64 value containing "+"', D.looksLikeRealSecret('\x58k9wPz2LqMn7Rt4VbAbCdEfGhIjKlMn+opqrstuv') === true);
t('looksLikeRealSecret: ACCEPTS a real-looking value containing "=" (base64 padding)', D.looksLikeRealSecret('\x58k9wPz2LqMn7Rt4VbAbCdEfGhIjKlMn==') === true);

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
const ROUND3B_GH = '\x67hp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'; // real-shaped GitHub token (ghp_ + 32 alnum, >=20 required)
const ROUND3B_AWS = '\x41KIAJKLMNOPQRSTUVWXY'; // real-shaped AWS access key id (AKIA + exactly 16 upper/digit)
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
const ROUND3D_CONTENT = 'const p = /\x41KIAABCDEFGHIJKLMNOP/g; // pattern definition (regex literal)\nmodule.exports = p;\n';
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
fs.writeFileSync(path.join(R5_INCID_ROOT, 'a.md'), 'gh=\x67hp_aB3xxxxKz9RealTokenMaterial01234\n');
fs.writeFileSync(path.join(R5_INCID_ROOT, 'b.txt'), 'nv=\x6Evapi-Zk9RealNvidiaKeyMaterialAAAAAAA0123456789abcdef\n');
const r5IncidLeak = D.leakScan(R5_INCID_ROOT);
t('ROUND5 BUG2 FIX: a real ghp_ token with an incidental "xxxx" is HIT (XXXX is weak, does not dominate)', r5IncidLeak.hits.some((h) => h.file.endsWith('a.md') && h.pattern === 'github-token'));
t('ROUND5 BUG3 FIX: a real nvapi key with an incidental 7-char run is HIT (filler must dominate to exempt)', r5IncidLeak.hits.some((h) => h.file.endsWith('b.txt') && h.pattern === 'nvidia-nvapi-key'));
t('ROUND5 BUG2/3 regression: a filler/placeholder-DOMINATED value is still exempt', D.looksLikeRealSecret('sk-AAAAAAAAAAAAAAAA{20,}') === false && D.looksLikeRealSecret('\x6Evapi-FAKEFAKEFAKEFAKE1234567890') === false);
t('ROUND5 STRONG_PLACEHOLDER_RE guard: exported, matches EXAMPLE, and does NOT match a bare XXXX (moved to weak)', D.STRONG_PLACEHOLDER_RE instanceof RegExp && D.STRONG_PLACEHOLDER_RE.test('EXAMPLE') && !D.STRONG_PLACEHOLDER_RE.test('aXXXXb'));

// BUG4: an unreadable tracked file is SURFACED (git fixture: staged then deleted -> ls-files lists it,
// readFileSync throws ENOENT). Guarded so a git-less environment skips gracefully rather than false-failing.
const R5_UNREAD_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doctor-r5-unread-'));
const r5GitOk = spawnSync('git', ['init', '-q'], { cwd: R5_UNREAD_ROOT }).status === 0;
if (r5GitOk) {
  fs.writeFileSync(path.join(R5_UNREAD_ROOT, 'secret.conf'), 'api_key=\x6Evapi-9x7Kq2mZ4bTvA1cReW8pLdN6sGhY3jFuIoP0aQzX5wErTyU\n');
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

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
