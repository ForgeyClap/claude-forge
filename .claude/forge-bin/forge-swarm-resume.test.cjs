#!/usr/bin/env node
'use strict';
/**
 * Hermetic tests for forge-swarm-resume.cjs (WAVE D / D1, 2026-07-18). EVERY fixture lives under a fresh
 * os.tmpdir() directory — this file NEVER touches this repo's real .claude/forge-runs/, and never touches
 * the pre-existing, unrelated forge-resume.cjs (global cross-session to-do CLI) this piece deliberately
 * avoided colliding with (see forge-swarm-resume.cjs's own header NAMING NOTE). Exit 0 = all pass.
 *
 * Section map:
 *   1) resume() returns exactly the unfinished WPs (with narrowed_prompt) and excludes done ones
 *   2) resume() on a fully-done run returns unfinished:[] and resumable:false — never re-dispatches a done WP
 *   3) resume() throws when no manifest was ever armed for the run (never fabricates an empty resume plan)
 *   4) resume() surfaces failed WPs as resumable (unfinished), never silently dropped
 *   5) resume() on an all-armed (never-touched) run returns every WP as unfinished
 *   6) real spawned CLI: exit codes 0/2/3, --json output, human-readable plan line
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const mf = require('./forge-manifest.cjs');
const sr = require('./forge-swarm-resume.cjs');

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };

function freshDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-')); }
function writeEvents(root, runId, events) {
  const dir = path.join(root, '.claude', 'forge-runs', runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''), 'utf8');
}

const CLI = path.join(__dirname, 'forge-swarm-resume.cjs');
function runCLI(argv, env) { return spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8', env: env || process.env }); }

const fourWps = () => ([
  { wp_id: 'wp1', agent: 'Build Boss', narrowed_prompt: 'build the login form' },
  { wp_id: 'wp2', agent: 'Build Boss', narrowed_prompt: 'build the signup form' },
  { wp_id: 'wp3', agent: 'Test Boss', narrowed_prompt: 'write login tests' },
  { wp_id: 'wp4', agent: 'UI Boss', narrowed_prompt: 'style the auth pages' },
]);

console.log('1) resume() returns exactly the unfinished WPs (with narrowed_prompt), excludes done ones');
{
  const root = freshDir('sr-core');
  mf.arm({ run_id: 'run-a', wps: fourWps() }, { root });
  writeEvents(root, 'run-a', [
    { event_type: 'wp_completed', agent: 'Build Boss', wp_id: 'wp1', timestamp: '2026-07-18T10:00:00Z' },
    { event_type: 'check_passed', agent: 'Test Boss', wp_id: 'wp3', command: 'npm test', exit_code: 0, timestamp: '2026-07-18T10:01:00Z' },
  ]);
  const r = sr.resume({ run_id: 'run-a' }, { root });
  t('run_id echoed back', r.run_id === 'run-a');
  t('exactly 2 done (wp1, wp3)', r.done.length === 2 && r.done.map((w) => w.wp_id).sort().join(',') === 'wp1,wp3');
  t('exactly 2 unfinished (wp2, wp4)', r.unfinished.length === 2 && r.unfinished.map((w) => w.wp_id).sort().join(',') === 'wp2,wp4');
  t('every unfinished WP carries its original narrowed_prompt', r.unfinished.find((w) => w.wp_id === 'wp2').narrowed_prompt === 'build the signup form');
  t('unfinished WPs carry their agent', r.unfinished.find((w) => w.wp_id === 'wp4').agent === 'UI Boss');
  t('resumable is true', r.resumable === true);
  t('plan mentions both unfinished wp ids', /wp2/.test(r.plan) && /wp4/.test(r.plan));
  t('plan does not mention the done wp ids (wp1/wp3 excluded from the re-dispatch list)', !/wp1/.test(r.plan) && !/wp3/.test(r.plan));
}

console.log('2) resume() on a fully-done run — never re-dispatches a done WP');
{
  const root = freshDir('sr-done');
  mf.arm({ run_id: 'run-done', wps: [{ wp_id: 'solo', agent: 'Build Boss', narrowed_prompt: 'x' }] }, { root });
  writeEvents(root, 'run-done', [{ event_type: 'wp_completed', agent: 'Build Boss', wp_id: 'solo', timestamp: '2026-07-18T10:00:00Z' }]);
  const r = sr.resume({ run_id: 'run-done' }, { root });
  t('unfinished is empty', r.unfinished.length === 0);
  t('done has the one WP', r.done.length === 1 && r.done[0].wp_id === 'solo');
  t('resumable is false', r.resumable === false);
  t('plan says nothing to resume', /nothing to resume/.test(r.plan));
}

console.log('3) resume() throws honestly when no manifest was ever armed — never fabricates an empty plan');
{
  const root = freshDir('sr-noarm');
  t('resume() throws for a run that was never armed', (() => { try { sr.resume({ run_id: 'never-armed' }, { root }); return false; } catch (e) { return /no manifest found/.test(e.message); } })());
  t('resume() throws for an invalid run_id', (() => { try { sr.resume({ run_id: 'bad id!' }, { root }); return false; } catch (e) { return /valid run_id/.test(e.message); } })());
}

console.log('4) resume() surfaces a failed WP as unfinished — never silently dropped');
{
  const root = freshDir('sr-failed');
  mf.arm({ run_id: 'run-failed', wps: [{ wp_id: 'wpF', agent: 'Build Boss', narrowed_prompt: 'risky change' }] }, { root });
  writeEvents(root, 'run-failed', [{ event_type: 'wp_failed', agent: 'Build Boss', wp_id: 'wpF', timestamp: '2026-07-18T10:00:00Z' }]);
  const r = sr.resume({ run_id: 'run-failed' }, { root });
  t('a failed WP appears in unfinished', r.unfinished.length === 1 && r.unfinished[0].wp_id === 'wpF' && r.unfinished[0].status === 'failed');
  t('resumable is true', r.resumable === true);
}

console.log('5) resume() on an all-armed (never-touched) run returns every WP as unfinished');
{
  const root = freshDir('sr-allarmed');
  mf.arm({ run_id: 'run-allarmed', wps: fourWps() }, { root });
  const r = sr.resume({ run_id: 'run-allarmed' }, { root });
  t('all 4 WPs are unfinished', r.unfinished.length === 4);
  t('done is empty', r.done.length === 0);
  t('resumable is true', r.resumable === true);
}

console.log('6) real spawned CLI: exit codes, --json output, human-readable plan');
{
  const root = freshDir('sr-cli');
  const wpsFile = path.join(root, 'wps.json');
  fs.writeFileSync(wpsFile, JSON.stringify(fourWps()), 'utf8');
  const env = Object.assign({}, process.env, { FORGE_PROJECT_ROOT: root });

  spawnSync(process.execPath, [path.join(__dirname, 'forge-manifest.cjs'), 'arm', '--run', 'run-cli', '--wps', wpsFile], { env });
  writeEvents(root, 'run-cli', [{ event_type: 'wp_completed', agent: 'Build Boss', wp_id: 'wp1', timestamp: '2026-07-18T10:00:00Z' }]);

  const res = runCLI(['--run', 'run-cli', '--json'], env);
  t('CLI exits 3 (resumable — 3 of 4 unfinished)', res.status === 3);
  const rj = JSON.parse(res.stdout);
  t('CLI --json reports unfinished.length === 3', rj.unfinished.length === 3);
  t('CLI --json reports done.length === 1', rj.done.length === 1);

  const humanRes = runCLI(['--run', 'run-cli'], env);
  t('CLI human-readable output prints RESUMABLE', /RESUMABLE/.test(humanRes.stdout));
  t('CLI human-readable output lists an unfinished wp id with its narrowed_prompt', /wp2.*build the signup form/.test(humanRes.stdout));

  const missingRunRes = runCLI(['--run', 'never-armed-cli'], env);
  t('CLI on a never-armed run exits 2', missingRunRes.status === 2);
  t('CLI on a never-armed run prints the honest error', /no manifest found/.test(missingRunRes.stderr));

  const noArgsRes = runCLI([], env);
  t('CLI with no --run exits 2 and prints usage', noArgsRes.status === 2 && /Usage:/.test(noArgsRes.stderr));

  // fully resolve the run -> exit 0, COMPLETE
  writeEvents(root, 'run-cli', [
    { event_type: 'wp_completed', agent: 'Build Boss', wp_id: 'wp1', timestamp: '2026-07-18T10:00:00Z' },
    { event_type: 'wp_completed', agent: 'Build Boss', wp_id: 'wp2', timestamp: '2026-07-18T10:01:00Z' },
    { event_type: 'wp_completed', agent: 'Test Boss', wp_id: 'wp3', timestamp: '2026-07-18T10:02:00Z' },
    { event_type: 'wp_completed', agent: 'UI Boss', wp_id: 'wp4', timestamp: '2026-07-18T10:03:00Z' },
  ]);
  const completeRes = runCLI(['--run', 'run-cli'], env);
  t('CLI exits 0 once every WP is done (COMPLETE)', completeRes.status === 0);
  t('CLI prints COMPLETE and "nothing to resume"', /COMPLETE/.test(completeRes.stdout) && /nothing to resume/.test(completeRes.stdout));
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
