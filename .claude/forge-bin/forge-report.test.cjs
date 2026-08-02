#!/usr/bin/env node
'use strict';
/** Hermetic tests for forge-report.cjs. Pure parse/validate/build tests need no filesystem at all.
 *  The one CLI ingest smoke test copies the REAL log-event.cjs into an os.mkdtemp fixture's own
 *  .claude/forge-dashboard/ so it resolves its CLAUDE_DIR to the fixture (log-event.cjs derives
 *  CLAUDE_DIR from its own __dirname, not from an argument) — this never touches the real project's
 *  .claude/forge-runs/. agent_output/agent_evidence_added need no agent-registry.json (they are not
 *  in log-event.cjs's WORKING_AGENT_EVENTS/PROOF_EVENTS sets), so strict mode accepts them with zero
 *  extra fixture setup — confirmed by reading log-event.cjs before writing this test. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const R = require('./forge-report.cjs');

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };

console.log('forge-report offline tests');

// ---- fixture reports -----------------------------------------------------------------------------
const validCompleted = {
  status: 'completed',
  work_package: 'WP-1',
  files_changed: ['src/a.js'],
  tests_run: 'npm test -> 12 passed',
  evidence: ['test output shows 12/12 passed'],
  blockers: [],
  next_action: 'none',
};
const blockText = (obj) => '```forge-report\n' + JSON.stringify(obj, null, 2) + '\n```';

// ---- parseReport: happy path --------------------------------------------------------------------
const r1 = R.parseReport('Some preamble.\n\n' + blockText(validCompleted) + '\n\nTrailing text.');
t('valid block parses ok=true', r1.ok === true);
t('valid block parses work_package', r1.ok && r1.report.work_package === 'WP-1');
t('valid block parses status', r1.ok && r1.report.status === 'completed');

// ---- parseReport: last-of-multiple blocks wins ---------------------------------------------------
const draft = { status: 'failed', work_package: 'WP-DRAFT', files_changed: [], tests_run: 'none', evidence: [], next_action: 'discard this draft' };
const multi = 'Thinking out loud:\n' + blockText(draft) + '\n\nActually, final answer:\n' + blockText(validCompleted);
const r2 = R.parseReport(multi);
t('last-of-multiple blocks wins (ok)', r2.ok === true);
t('last-of-multiple blocks wins (work_package)', r2.ok && r2.report.work_package === 'WP-1');
t('last-of-multiple blocks wins (not the draft status)', r2.ok && r2.report.status === 'completed');

// ---- parseReport: completed WITHOUT evidence -> invalid ------------------------------------------
const noEvidence = Object.assign({}, validCompleted, { evidence: [] });
const r3 = R.parseReport(blockText(noEvidence));
t('completed without evidence -> invalid', r3.ok === false);
t('completed without evidence -> error mentions evidence', r3.ok === false && r3.errors.some((e) => /evidence/i.test(e)));

const noEvidenceField = { status: 'completed', work_package: 'WP-2', files_changed: [], tests_run: 'none', next_action: 'x' };
const r3b = R.parseReport(blockText(noEvidenceField));
t('completed with evidence field entirely missing -> invalid', r3b.ok === false);

// ---- parseReport: blocked without blockers -> invalid ---------------------------------------------
const blockedNoBlockers = { status: 'blocked', work_package: 'WP-3', files_changed: [], tests_run: 'none', evidence: ['tried X'], blockers: [], next_action: 'wait for owner' };
const r4 = R.parseReport(blockText(blockedNoBlockers));
t('blocked without blockers -> invalid', r4.ok === false);
t('blocked without blockers -> error mentions blockers', r4.ok === false && r4.errors.some((e) => /blockers/i.test(e)));

const blockedWithBlockers = Object.assign({}, blockedNoBlockers, { blockers: ['missing API key'] });
const r4b = R.parseReport(blockText(blockedWithBlockers));
t('blocked WITH blockers -> valid', r4b.ok === true);

// ---- parseReport: malformed JSON -> clear error ---------------------------------------------------
const r5 = R.parseReport('```forge-report\n{ this is not json,,, \n```');
t('malformed JSON -> ok=false', r5.ok === false);
t('malformed JSON -> clear error message', r5.ok === false && r5.errors.some((e) => /malformed JSON/i.test(e)));

// ---- parseReport: text without a block -> clear error ---------------------------------------------
const r6 = R.parseReport('Just a normal message with no fenced block at all.');
t('no block -> ok=false', r6.ok === false);
t('no block -> clear error message', r6.ok === false && r6.errors.some((e) => /no ```forge-report/i.test(e)));

// ---- other required-field validation spot checks ---------------------------------------------------
const badStatus = Object.assign({}, validCompleted, { status: 'done' });
t('unknown status rejected', R.parseReport(blockText(badStatus)).ok === false);
const noWp = Object.assign({}, validCompleted, { work_package: '' });
t('empty work_package rejected', R.parseReport(blockText(noWp)).ok === false);
const badFilesChanged = Object.assign({}, validCompleted, { files_changed: 'not-an-array' });
t('non-array files_changed rejected', R.parseReport(blockText(badFilesChanged)).ok === false);
const badTestsRun = Object.assign({}, validCompleted, { tests_run: 42 });
t('non-string/array tests_run rejected', R.parseReport(blockText(badTestsRun)).ok === false);
const testsRunArray = Object.assign({}, validCompleted, { tests_run: ['npm test -> ok', 'npm run lint -> ok'] });
t('array tests_run accepted', R.parseReport(blockText(testsRunArray)).ok === true);
const noNextAction = Object.assign({}, validCompleted, { next_action: '' });
t('empty next_action rejected', R.parseReport(blockText(noNextAction)).ok === false);
const partialFixture = { status: 'partial', work_package: 'WP-4', files_changed: ['x.js'], tests_run: 'none', evidence: ['partial evidence'], next_action: 'continue next session' };
t('partial status with no blockers field is fine (blockers only required when blocked)', R.parseReport(blockText(partialFixture)).ok === true);

// ---- buildIngestEvents: redaction of a real-looking secret ------------------------------------------
const SECRET = 'nvapi-FAKEFAKEFAKEFAKE1234567890';
const secretReport = Object.assign({}, validCompleted, { evidence: ['key used: ' + SECRET], tests_run: 'curl with ' + SECRET + ' -> 200' });
const events = R.buildIngestEvents(secretReport, 'Build Boss');
const serialized = JSON.stringify(events);
t('buildIngestEvents returns exactly 2 events', events.length === 2);
t('buildIngestEvents event_types are agent_output + agent_evidence_added', events[0].event_type === 'agent_output' && events[1].event_type === 'agent_evidence_added');
t('buildIngestEvents redacts the raw secret (absent from serialized events)', !serialized.includes(SECRET));
t('buildIngestEvents redaction marker present', serialized.includes('***REDACTED***'));
t('agent_output carries the agent name', events[0].extra.agent === 'Build Boss');
t('agent_output.output is a compact one-line summary with status/WP/files/tests', /completed/.test(events[0].extra.output) && /WP-1/.test(events[0].extra.output) && /1 file\(s\)/.test(events[0].extra.output) && /tests:/.test(events[0].extra.output));
t('agent_output carries the full (redacted) report object', events[0].extra.report.work_package === 'WP-1' && !JSON.stringify(events[0].extra.report).includes(SECRET));
t('agent_evidence_added carries the joined, redacted evidence', typeof events[1].extra.evidence === 'string' && events[1].extra.evidence.includes('***REDACTED***') && !events[1].extra.evidence.includes(SECRET));

// ---- CLI: validate -------------------------------------------------------------------------------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-report-test-'));
const validFile = path.join(TMP, 'valid.txt');
fs.writeFileSync(validFile, blockText(validCompleted), 'utf8');
const invalidFile = path.join(TMP, 'invalid.txt');
fs.writeFileSync(invalidFile, blockText(noEvidence), 'utf8');

const runCli = (args, opts) => spawnSync(process.execPath, [path.join(__dirname, 'forge-report.cjs'), ...args], Object.assign({ encoding: 'utf8' }, opts || {}));

const cliValidateOk = runCli(['validate', validFile]);
t('CLI validate exits 0 on a valid report', cliValidateOk.status === 0);
t('CLI validate prints VALID', /VALID/.test(cliValidateOk.stdout));

const cliValidateBad = runCli(['validate', invalidFile]);
t('CLI validate exits 2 on an invalid report', cliValidateBad.status === 2);
t('CLI validate prints the error', /evidence/i.test(cliValidateBad.stderr));

const cliValidateStdin = runCli(['validate', '-'], { input: blockText(validCompleted) });
t('CLI validate reads from stdin ("-") and exits 0', cliValidateStdin.status === 0);

const cliValidateMissingArg = runCli(['validate']);
t('CLI validate with no file arg exits 1 (usage error)', cliValidateMissingArg.status === 1);

const cliUnknownCmd = runCli(['bogus']);
t('CLI unknown subcommand exits 1', cliUnknownCmd.status === 1);

// ---- CLI: ingest — hermetic fixture with a REAL copy of log-event.cjs -----------------------------
const FIXROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-report-ingest-'));
const dashDir = path.join(FIXROOT, '.claude', 'forge-dashboard');
fs.mkdirSync(dashDir, { recursive: true });
fs.copyFileSync(path.join(__dirname, '..', 'forge-dashboard', 'log-event.cjs'), path.join(dashDir, 'log-event.cjs'));

const cliIngestOk = runCli(['ingest', 'run-fixture-1', validFile, '--agent', 'Build Boss', '--root', FIXROOT]);
t('CLI ingest exits 0 on a valid report', cliIngestOk.status === 0);
t('CLI ingest prints INGESTED', /INGESTED/.test(cliIngestOk.stdout));

const eventsFile = path.join(FIXROOT, '.claude', 'forge-runs', 'run-fixture-1', 'events.jsonl');
t('CLI ingest wrote events.jsonl', fs.existsSync(eventsFile));
const lines = fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
t('CLI ingest logged exactly 2 events', lines.length === 2);
t('CLI ingest logged agent_output then agent_evidence_added', lines[0] && lines[0].event_type === 'agent_output' && lines[1] && lines[1].event_type === 'agent_evidence_added');
t('CLI ingest agent_output carries the agent name', lines[0] && lines[0].agent === 'Build Boss');
t('CLI ingest events were NOT rejected by strict mode', !lines.some((l) => l._forge_verify && (l._forge_verify.event_type_unknown || l._forge_verify.agent_registered === false)));

const cliIngestInvalid = runCli(['ingest', 'run-fixture-2', invalidFile, '--agent', 'Build Boss', '--root', FIXROOT]);
t('CLI ingest exits 2 on an invalid report', cliIngestInvalid.status === 2);
const eventsFile2 = path.join(FIXROOT, '.claude', 'forge-runs', 'run-fixture-2', 'events.jsonl');
t('CLI ingest logs NOTHING when the report is invalid', !fs.existsSync(eventsFile2));

const cliIngestBadRunId = runCli(['ingest', '../evil', validFile, '--agent', 'Build Boss', '--root', FIXROOT]);
t('CLI ingest rejects a traversal-looking run_id', cliIngestBadRunId.status === 1);

const cliIngestMissingAgent = runCli(['ingest', 'run-fixture-3', validFile, '--root', FIXROOT]);
t('CLI ingest requires --agent (usage error)', cliIngestMissingAgent.status === 1);

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
