#!/usr/bin/env node
'use strict';
/** Offline, hermetic tests for forge-resume.cjs — writes ONLY to an os.mkdtemp temp dir via the
 *  FORGE_RESUME_STATE override (points directly at a throwaway state file path); never touches the
 *  real global <home>/.claude/FORGE_RESUME_STATE.json. The CLI has no module.exports (top-level
 *  switch on argv), so every command is exercised via spawnSync. Exit 0 = all pass. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-resume-test-'));
const STATE_FILE = path.join(TMP, 'FORGE_RESUME_STATE.json');
const CLI = path.join(__dirname, 'forge-resume.cjs');
const env = { ...process.env, FORGE_RESUME_STATE: STATE_FILE };

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };
const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { env, encoding: 'utf8' });
const readState = () => JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));

console.log('forge-resume offline tests (hermetic state=' + STATE_FILE + ')');

// 0) smoke: set / todo-add / todo-status still work exactly as before (backward compatibility)
const setRes = run('set', '--project', 'testproj', '--path', 'C:/proj', '--phase', 'build', '--last', 'wired X', '--next', 'wire Y');
t('set exits 0', setRes.status === 0);
t('set writes the state file at the FORGE_RESUME_STATE override path', fs.existsSync(STATE_FILE));
t('set persists project name', readState().project === 'testproj');

const addRes = run('todo-add', 'implement feature');
t('todo-add exits 0', addRes.status === 0);
t('todo-add creates todo #1 with default status pending', readState().todo.length === 1 && readState().todo[0].id === 1 && readState().todo[0].status === 'pending');

const statusRes = run('todo-status', '1', 'in_progress');
t('todo-status exits 0', statusRes.status === 0);
t('todo-status updates status', readState().todo[0].status === 'in_progress');

// 1) retry #1 — allowed with just --reason
const retry1 = run('retry', '1', '--reason', 'flaky test in CI');
t('retry #1 exits 0', retry1.status === 0);
let todo = readState().todo[0];
t('retry #1 sets retry_count to 1', todo.retry_count === 1);
t('retry #1 stores last_failure_reason', todo.last_failure_reason === 'flaky test in CI');
t('retry #1 appends a retries[] entry', Array.isArray(todo.retries) && todo.retries.length === 1 && todo.retries[0].reason === 'flaky test in CI');

// 2) retry #2 without --narrowed — refused, exit 2, nothing recorded
const retry2NoNarrow = run('retry', '1', '--reason', 'same failure again');
t('retry #2 without --narrowed exits 2', retry2NoNarrow.status === 2);
t('retry #2 without --narrowed does not increment retry_count', readState().todo[0].retry_count === 1);
t('retry #2 without --narrowed prints the blind-redispatch refusal message', /requires --narrowed/.test(retry2NoNarrow.stderr) && /Blind re-dispatch is forbidden/.test(retry2NoNarrow.stderr));

// 2b) retry #2 with --narrowed — allowed
const retry2 = run('retry', '1', '--reason', 'same failure again', '--narrowed', 'scoped to 1 file instead of 5');
t('retry #2 with --narrowed exits 0', retry2.status === 0);
todo = readState().todo[0];
t('retry #2 sets retry_count to 2', todo.retry_count === 2);
t('retry #2 records the narrowed scope', todo.retries.length === 2 && todo.retries[1].narrowed === 'scoped to 1 file instead of 5');

// 3) retry #3 — refused outright, exit 3, todo forced to blocked
const retry3 = run('retry', '1', '--reason', 'still failing', '--narrowed', 'even narrower');
t('retry #3 exits 3', retry3.status === 3);
todo = readState().todo[0];
t('retry #3 forces status to blocked', todo.status === 'blocked');
t('retry #3 does not increment retry_count past the cap', todo.retry_count === 2);
t('retry #3 prints the max-retries refusal message', /max retries reached/.test(retry3.stderr) && /FORGE_FAILURE_PATTERNS\.md/.test(retry3.stderr));

// 3b) retry on an unknown todo id fails cleanly
const retryMissing = run('retry', '999', '--reason', 'x');
t('retry on a missing todo id exits non-zero', retryMissing.status !== 0 && retryMissing.status !== 2 && retryMissing.status !== 3);
t('retry on a missing todo id reports "no todo"', /no todo/.test(retryMissing.stderr));

// 3c) retry without --reason at all is rejected (usage error)
const retryNoReason = run('retry', '1');
t('retry without --reason exits non-zero (usage error)', retryNoReason.status !== 0);

// 4) show renders retry info for the retried todo
const showRes = run('show');
t('show exits 0', showRes.status === 0);
t('show renders retry count for the todo (retry 2)', /retry 2/.test(showRes.stdout));
t('show still renders the todo id and title', /#1/.test(showRes.stdout) && /implement feature/.test(showRes.stdout));
t('show reflects the blocked status set by retry #3', /blocked/.test(showRes.stdout));

// 5) legacy state (no retry fields at all) still loads and works
const legacyState = {
  project: 'legacy', project_path: '', phase: '', last_done: '', next: '',
  todo: [{ id: 1, title: 'old style todo', status: 'pending' }],
  updated: '',
};
fs.writeFileSync(STATE_FILE, JSON.stringify(legacyState, null, 2) + '\n');
const legacyShow = run('show');
t('legacy state without retry fields still loads via show', legacyShow.status === 0 && /old style todo/.test(legacyShow.stdout));
const legacyLine = legacyShow.stdout.split('\n').find((l) => l.includes('old style todo')) || '';
t('legacy todo renders without a retry suffix (retry_count defaults to 0)', !/retry \d/.test(legacyLine));
const legacyStatusRes = run('todo-status', '1', 'done');
t('legacy state todo-status still works', legacyStatusRes.status === 0 && readState().todo[0].status === 'done');
const legacyRetry = run('retry', '1', '--reason', 'first retry on a legacy todo');
t('retry on a legacy todo (no prior retry_count) starts at retry_count 1', legacyRetry.status === 0 && readState().todo[0].retry_count === 1);

// 6) N4/Part V-G (2026-09-26, external audit) — the GLOBAL (not project-local) state file is a documented,
// visible side effect, never a silent one: every write command names the exact path it just wrote.
t('set names the exact (redirected) state file path it wrote, labelled "global state"', /global state: .*FORGE_RESUME_STATE\.json/.test(setRes.stdout));
t('todo-add names the exact state file path it wrote', addRes.stdout.includes(STATE_FILE));
t('todo-status names the exact state file path it wrote', statusRes.stdout.includes(STATE_FILE));
t('retry names the exact state file path it wrote', retry1.stdout.includes(STATE_FILE));

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
