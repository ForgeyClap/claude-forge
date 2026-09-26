#!/usr/bin/env node
'use strict';
/**
 * Forge Resume — resume checkpoint + to-do CLI (zero-dependency).
 *
 * Writes/reads ONE global checkpoint file so a new session (or the usage-guard hook, right after an
 * auto-resume) can remind exactly where work left off, without the owner re-explaining it.
 *
 * File: <home>/.claude/FORGE_RESUME_STATE.json
 *   { project, project_path, phase, last_done, next,
 *     todo: [{id, title, status, retry_count?, last_failure_reason?, retries?: [{ts,reason,narrowed}]}],
 *     updated }
 *
 * Commands:
 *   node forge-resume.cjs set --project X --path P --phase Y --last "..." --next "..."
 *   node forge-resume.cjs todo-add "title"
 *   node forge-resume.cjs todo-status <id> <pending|in_progress|done>
 *   node forge-resume.cjs retry <id> --reason "<why it failed>" [--narrowed "<what is narrower>"]
 *   node forge-resume.cjs show
 *
 * Honors USERPROFILE (Windows) / HOME (POSIX) env override instead of hardcoding os.homedir(), so
 * tests can point this CLI at a temp directory without touching the real global state file.
 *
 * TEST ISOLATION: set FORGE_RESUME_STATE to an absolute file path to redirect the state file entirely
 * (takes priority over the homedir-based path). This is a TEST-ONLY escape hatch (used by
 * forge-resume.test.cjs) — never point it at a real project's state file.
 *
 * GLOBAL, NOT PROJECT-LOCAL — BY DESIGN, DOCUMENTED HONESTLY (2026-09-26, external audit Part V-G /
 * 2.7.1 #matrix side effects). This is the one file in this tool pack that DELIBERATELY writes outside any
 * single project's .claude/ — it exists precisely because the reminder has to survive switching projects
 * and surviving a fresh session where no project has been opened yet (usage-guard's own auto-resume reads
 * it right after resuming a paused session). A per-project resume file cannot do that job. Every write
 * command below (set/todo-add/todo-status/retry) prints the exact GLOBAL path it just wrote, every time —
 * so this is a visible, named side effect, never a silent one, and the owner can always see the real path.
 * If this is ever exercised as part of a broader tool sweep, redirect it first (FORGE_RESUME_STATE / HOME /
 * USERPROFILE) so it does not touch the real machine's real reminder.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

function homeDir() {
  if (process.platform === 'win32') return process.env.USERPROFILE || os.homedir();
  return process.env.HOME || os.homedir();
}
function stateFile() {
  if (process.env.FORGE_RESUME_STATE) return path.resolve(process.env.FORGE_RESUME_STATE);
  return path.join(homeDir(), '.claude', 'FORGE_RESUME_STATE.json');
}

function readState() {
  try {
    const raw = fs.readFileSync(stateFile(), 'utf8');
    const j = JSON.parse(raw);
    if (j && typeof j === 'object') {
      if (!Array.isArray(j.todo)) j.todo = [];
      return j;
    }
  } catch {}
  return { project: '', project_path: '', phase: '', last_done: '', next: '', todo: [], updated: '' };
}
function writeState(s) {
  const dir = path.dirname(stateFile());
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  s.updated = new Date().toISOString();
  fs.writeFileSync(stateFile(), JSON.stringify(s, null, 2) + '\n');
}

const args = process.argv.slice(2);
const cmd = args[0];
function opt(name, dflt) { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt; }

function cmdSet() {
  const s = readState();
  const project = opt('project');
  const projectPath = opt('path');
  const phase = opt('phase');
  const last = opt('last');
  const next = opt('next');
  if (project !== undefined) s.project = project;
  if (projectPath !== undefined) s.project_path = projectPath;
  if (phase !== undefined) s.phase = phase;
  if (last !== undefined) s.last_done = last;
  if (next !== undefined) s.next = next;
  writeState(s);
  console.log('forge-resume: state updated (global state: ' + stateFile() + ')');
}
function cmdTodoAdd() {
  const title = args.slice(1).join(' ').trim();
  if (!title) { console.error('forge-resume todo-add: missing title'); process.exitCode = 1; return; }
  const s = readState();
  const nextId = s.todo.reduce((m, t) => Math.max(m, Number(t && t.id) || 0), 0) + 1;
  s.todo.push({ id: nextId, title, status: 'pending' });
  writeState(s);
  console.log('forge-resume: todo #' + nextId + ' added — ' + title + ' (global state: ' + stateFile() + ')');
}
function cmdTodoStatus() {
  const id = Number(args[1]);
  const status = args[2];
  const valid = ['pending', 'in_progress', 'done'];
  if (!Number.isFinite(id) || !valid.includes(status)) {
    console.error('forge-resume todo-status: usage: todo-status <id> <pending|in_progress|done>');
    process.exitCode = 1; return;
  }
  const s = readState();
  const t = s.todo.find((x) => x && Number(x.id) === id);
  if (!t) { console.error('forge-resume todo-status: no todo #' + id); process.exitCode = 1; return; }
  t.status = status;
  writeState(s);
  console.log('forge-resume: todo #' + id + ' -> ' + status + ' (global state: ' + stateFile() + ')');
}
// Bounded narrowed-scope retry. Research finding: blind same-scope re-dispatch mostly reproduces the
// same failure. Forge governance already says "max 2 loops (3 for high-end)" but nothing enforced it —
// this command is the enforcement. retry #1 just needs a reason; retry #2 must state what is actually
// narrower this time (fewer files / tighter scope / more failure context) or it is refused; retry #3+
// is refused outright and the todo is force-marked blocked so it surfaces instead of looping silently.
function cmdRetry() {
  const usage = 'forge-resume retry: usage: retry <todoId> --reason "<why it failed>" [--narrowed "<what is narrower this time>"]';
  const id = Number(args[1]);
  const reason = opt('reason');
  const narrowed = opt('narrowed');
  if (!Number.isFinite(id) || !reason || !String(reason).trim()) {
    console.error(usage);
    process.exitCode = 1; return;
  }
  const s = readState();
  const t = s.todo.find((x) => x && Number(x.id) === id);
  if (!t) { console.error('forge-resume retry: no todo #' + id); process.exitCode = 1; return; }

  const currentCount = Number(t.retry_count) || 0;
  const nextCount = currentCount + 1;

  if (nextCount >= 3) {
    // retry #3+: refused outright — do not increment retry_count further, force the todo to blocked
    // so it stops silently looping and gets surfaced for a human/Head Chef decision instead.
    t.status = 'blocked';
    writeState(s);
    console.error('forge-resume retry: max retries reached — mark BLOCKED and record the pattern in FORGE_FAILURE_PATTERNS.md');
    process.exitCode = 3; return;
  }

  if (nextCount === 2 && (!narrowed || !String(narrowed).trim())) {
    console.error('forge-resume retry: retry 2 requires --narrowed: state what is narrower (fewer files / tighter scope / failure context added). Blind re-dispatch is forbidden.');
    process.exitCode = 2; return;
  }

  t.retry_count = nextCount;
  t.last_failure_reason = reason;
  if (!Array.isArray(t.retries)) t.retries = [];
  t.retries.push({ ts: new Date().toISOString(), reason, narrowed: narrowed || '' });
  writeState(s);
  console.log('forge-resume: todo #' + id + ' retry ' + nextCount + ' recorded — ' + reason + ' (global state: ' + stateFile() + ')');
}
function cmdShow() {
  const s = readState();
  const open = s.todo.filter((t) => t && t.status !== 'done');
  console.log('📍 ' + (s.project || '(no project)') + ' · fase ' + (s.phase || '-') + ' · laatst: ' + (s.last_done || '-') + ' · nu: ' + (s.next || '-') + ' · open to-do: ' + open.length);
  for (const t of open) {
    const rc = Number(t.retry_count) || 0;
    const label = rc > 0 ? t.status + '·retry ' + rc : t.status;
    console.log('  [' + label + '] #' + t.id + ' ' + t.title);
  }
}

switch (cmd) {
  case 'set': cmdSet(); break;
  case 'todo-add': cmdTodoAdd(); break;
  case 'todo-status': cmdTodoStatus(); break;
  case 'retry': cmdRetry(); break;
  case 'show': cmdShow(); break;
  default:
    console.error('unknown command: ' + cmd + ' (use set|todo-add|todo-status|retry|show)');
    process.exitCode = 1;
}
