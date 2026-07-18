#!/usr/bin/env node
'use strict';
/** Hermetic tests for forge-heartbeat.cjs. Uses os.mkdtemp fixtures with crafted events.jsonl + an
 *  injected opts.now so nothing depends on real wall-clock timing for the pure checkRun() tests. CLI
 *  smoke tests use real (but self-contained) past timestamps relative to Date.now() at test run time.
 *  Never touches the real project's .claude/forge-runs/. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const H = require('./forge-heartbeat.cjs');

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };

console.log('forge-heartbeat offline tests');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-heartbeat-test-'));
const RUNS_DIR = path.join(TMP, '.claude', 'forge-runs');

function writeEvents(runId, lines) {
  const dir = path.join(RUNS_DIR, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), lines.join('\n') + '\n', 'utf8');
  return dir;
}
const ev = (o) => JSON.stringify(o);

const NOW = Date.parse('2026-07-10T12:00:00.000Z');
const isoMinsAgo = (mins) => new Date(NOW - mins * 60000).toISOString();

// ---- fixture: recent progress, unfinished -> NOT stalled -------------------------------------------
const recentDir = writeEvents('run-recent', [
  ev({ event_type: 'agent_started', agent: 'Build Boss', timestamp: isoMinsAgo(5) }),
  ev({ event_type: 'agent_progress', agent: 'Build Boss', timestamp: isoMinsAgo(2), note: 'still working' }),
]);
const recent = H.checkRun(recentDir, { now: NOW });
t('recent progress agent is tracked', recent.agents.length === 1);
t('recent progress agent is NOT stalled', recent.agents[0].stalled === false);
t('recent progress agent minutesSilent ~= 2', recent.agents[0].minutesSilent === 2);
t('checkRun.ok is true when nothing stalled', recent.ok === true);
t('stalled list is empty', recent.stalled.length === 0);

// ---- fixture: started, last event 25min ago, no completion -> STALLED ------------------------------
const staleDir = writeEvents('run-stale', [
  ev({ event_type: 'agent_started', agent: 'Test Boss', timestamp: isoMinsAgo(30) }),
  ev({ event_type: 'agent_progress', agent: 'Test Boss', timestamp: isoMinsAgo(25), note: 'ran some checks' }),
]);
const stale = H.checkRun(staleDir, { now: NOW }); // default window 10 min
t('stale agent (25m silent) IS stalled', stale.agents[0].stalled === true);
t('checkRun.ok is false when something is stalled', stale.ok === false);
t('stalled list includes the stale agent', stale.stalled.length === 1 && stale.stalled[0].agent === 'Test Boss');
t('stale agent minutesSilent ~= 25', stale.agents[0].minutesSilent === 25);
t('stale agent lastEventType is agent_progress', stale.agents[0].lastEventType === 'agent_progress');
t('stale agent neverProgressed=false (it did log progress)', stale.agents[0].neverProgressed === false);

// ---- fixture: started + completed long ago -> NOT stalled (finished) -------------------------------
const finishedDir = writeEvents('run-finished', [
  ev({ event_type: 'agent_started', agent: 'Review Boss', timestamp: isoMinsAgo(300) }),
  ev({ event_type: 'agent_completed', agent: 'Review Boss', timestamp: isoMinsAgo(290) }),
]);
const finished = H.checkRun(finishedDir, { now: NOW });
t('finished agent (silent 290m but completed) is NOT stalled', finished.agents[0].stalled === false);
t('finished agent finished=true', finished.agents[0].finished === true);
t('checkRun.ok true for a run where the only agent finished', finished.ok === true);

// subagent_failed also counts as finished (never flagged, even if very old)
const failedDir = writeEvents('run-failed-finished', [
  ev({ event_type: 'subagent_started', agent: 'Security Boss', timestamp: isoMinsAgo(500) }),
  ev({ event_type: 'subagent_failed', agent: 'Security Boss', timestamp: isoMinsAgo(495) }),
]);
const failedFinished = H.checkRun(failedDir, { now: NOW });
t('subagent_failed counts as finished -> not stalled', failedFinished.agents[0].stalled === false && failedFinished.agents[0].finished === true);

// ---- never-progressed: only a start event, then silence past the window ----------------------------
const neverDir = writeEvents('run-never-progressed', [
  ev({ event_type: 'agent_started', agent: 'Ghost Boss', timestamp: isoMinsAgo(45) }),
]);
const never = H.checkRun(neverDir, { now: NOW });
t('never-progressed agent is stalled', never.agents[0].stalled === true);
t('never-progressed agent neverProgressed=true', never.agents[0].neverProgressed === true);

// ---- malformed line skipped, does not crash ---------------------------------------------------------
const malformedDir = writeEvents('run-malformed', [
  ev({ event_type: 'agent_started', agent: 'Build Boss', timestamp: isoMinsAgo(3) }),
  '{not valid json,,,',
  ev({ event_type: 'agent_progress', agent: 'Build Boss', timestamp: isoMinsAgo(1) }),
]);
const malformed = H.checkRun(malformedDir, { now: NOW });
t('malformed line was skipped, not thrown', malformed.malformed === 1);
t('malformed-line fixture still resolves the agent correctly', malformed.agents.length === 1 && malformed.agents[0].stalled === false);

// events with no agent field are skipped (no SYNTH fallback)
const noAgentDir = writeEvents('run-no-agent', [
  ev({ event_type: 'agent_note', note: 'no agent field on purpose' }),
  ev({ agent: '', event_type: 'agent_started', timestamp: isoMinsAgo(1) }), // empty agent — must be skipped too
]);
const noAgent = H.checkRun(noAgentDir, { now: NOW });
t('events without a usable agent field produce zero tracked agents', noAgent.agents.length === 0);
t('run with zero tracked agents is ok (nothing to flag)', noAgent.ok === true);

// events without a resolvable timestamp never crash and are simply not counted as "last seen"
const noTsDir = writeEvents('run-no-timestamp', [
  ev({ event_type: 'agent_started', agent: 'Timeless Boss' }), // no timestamp field at all
]);
const noTs = H.checkRun(noTsDir, { now: NOW });
t('agent with no resolvable timestamp is tracked but not crashed on', noTs.agents.length === 1);
t('agent with no timestamp has lastTs=null, minutesSilent=null, stalled=false', noTs.agents[0].lastTs === null && noTs.agents[0].minutesSilent === null && noTs.agents[0].stalled === false);

// ---- missing runDir -> clean, non-crashing error ------------------------------------------------------
let threw = null;
try { H.checkRun(path.join(RUNS_DIR, 'does-not-exist'), { now: NOW }); } catch (e) { threw = e; }
t('checkRun on missing dir throws', threw instanceof Error);
t('checkRun missing-dir error message is clean/informative', threw && /events\.jsonl/.test(threw.message));

// ---- window override works (same fixture, different window) ------------------------------------------
const windowTight = H.checkRun(staleDir, { now: NOW, windowMs: 60 * 60000 }); // 60 min window -> 25m silence is fine
t('window override (60min) makes the 25m-silent agent NOT stalled', windowTight.agents[0].stalled === false);
const windowLoose = H.checkRun(recentDir, { now: NOW, windowMs: 1 * 60000 }); // 1 min window -> 2m silence now stalls it
t('window override (1min) makes the 2m-silent agent stalled', windowLoose.agents[0].stalled === true);

// ---- DEFAULT_WINDOW_MS sanity ---------------------------------------------------------------------
t('DEFAULT_WINDOW_MS is 10 minutes', H.DEFAULT_WINDOW_MS === 10 * 60 * 1000);

// ---- CLI smoke tests (spawned child process, real timestamps relative to actual now) -----------------
const CLIROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-heartbeat-cli-'));
const cliRunsDir = path.join(CLIROOT, '.claude', 'forge-runs');
function writeCliEvents(runId, lines) {
  const dir = path.join(cliRunsDir, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), lines.join('\n') + '\n', 'utf8');
}
const realIsoMinsAgo = (mins) => new Date(Date.now() - mins * 60000).toISOString();

writeCliEvents('cli-stalled', [
  ev({ event_type: 'agent_started', agent: 'Build Boss', timestamp: realIsoMinsAgo(30) }),
  ev({ event_type: 'agent_progress', agent: 'Build Boss', timestamp: realIsoMinsAgo(25) }),
]);
writeCliEvents('cli-clean', [
  ev({ event_type: 'agent_started', agent: 'Test Boss', timestamp: realIsoMinsAgo(1) }),
  ev({ event_type: 'agent_completed', agent: 'Test Boss', timestamp: realIsoMinsAgo(1) }),
]);

const runCli = (...args) => spawnSync(process.execPath, [path.join(__dirname, 'forge-heartbeat.cjs'), ...args], { encoding: 'utf8' });

const cliStalled = runCli('check', 'cli-stalled', '--root', CLIROOT, '--json');
t('CLI exits 1 on the stalled fixture', cliStalled.status === 1);
t('CLI prints the STALLED marker', /STALLED: Build Boss/.test(cliStalled.stdout));
t('CLI --json output parses and reports one stalled agent', (() => {
  try { const j = JSON.parse(cliStalled.stdout.slice(cliStalled.stdout.indexOf('{'))); return j.stalled.length === 1; } catch { return false; }
})());

const cliClean = runCli('check', 'cli-clean', '--root', CLIROOT);
t('CLI exits 0 on the clean (finished) fixture', cliClean.status === 0);
t('CLI prints the no-stalled-agents line', /no stalled agents/.test(cliClean.stdout));

const cliWindowOverride = runCli('check', 'cli-stalled', '--root', CLIROOT, '--window', '60');
t('CLI --window override (60min) makes the 25m-silent fixture pass', cliWindowOverride.status === 0);

const cliBadRunId = runCli('check', '../evil', '--root', CLIROOT);
t('CLI rejects a traversal-looking run_id', cliBadRunId.status === 1);

const cliMissingRun = runCli('check', 'does-not-exist-run', '--root', CLIROOT);
t('CLI on a missing run prints a clean error and exits non-zero', cliMissingRun.status !== 0 && /forge-heartbeat:/.test(cliMissingRun.stderr));

const cliBadCmd = runCli('bogus', 'cli-clean', '--root', CLIROOT);
t('CLI rejects an unknown subcommand', cliBadCmd.status === 1);

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
