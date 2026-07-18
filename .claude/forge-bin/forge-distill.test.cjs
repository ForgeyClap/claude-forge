#!/usr/bin/env node
'use strict';
/** Offline, hermetic tests for forge-distill.cjs. Hermetic like forge-store.test.cjs: every case gets
 *  its own subdirectory under one os.tmpdir() root with a fake .claude/{config/agents/agent-registry.json,
 *  forge-runs/<run>/{events.jsonl,run.json}, agent-memory/}. The REAL log-event.cjs is copied into each
 *  fixture's forge-dashboard/ so the CLI's memory_updated self-logging can be exercised for real without
 *  ever touching this project's actual .claude/forge-runs/. Exit 0 = all pass. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-distill-test-'));
process.env.FORGE_PROJECT_ROOT = TMP;
const D = require('./forge-distill.cjs');

const REAL_LOG_EVENT = path.join(__dirname, '..', 'forge-dashboard', 'log-event.cjs');
const DISTILL_CLI = path.join(__dirname, 'forge-distill.cjs');

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.error('  FAIL ' + name); } };

console.log('forge-distill offline tests (hermetic root=' + TMP + ')');

const REGISTRY_FIXTURE = { agents: { 'build-boss': { name: 'Build Boss' }, 'test-boss': { name: 'Test Boss' } } };

/** One isolated fixture: <TMP>/<caseName>/.claude/{config/agents/agent-registry.json,
 *  forge-dashboard/log-event.cjs (real, copied), agent-memory/}. Returns the fixture root. */
function makeFixture(caseName) {
  const root = path.join(TMP, caseName);
  fs.mkdirSync(path.join(root, '.claude', 'config', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'config', 'agents', 'agent-registry.json'), JSON.stringify(REGISTRY_FIXTURE));
  fs.mkdirSync(path.join(root, '.claude', 'forge-dashboard'), { recursive: true });
  fs.copyFileSync(REAL_LOG_EVENT, path.join(root, '.claude', 'forge-dashboard', 'log-event.cjs'));
  fs.mkdirSync(path.join(root, '.claude', 'agent-memory'), { recursive: true });
  return root;
}

/** Writes <root>/.claude/forge-runs/<runId>/{run.json,events.jsonl}. `events` is an array of plain
 *  objects (run_id/timestamp auto-filled when absent) written one-per-line. */
function writeRun(root, runId, events, runExtra) {
  const runDir = path.join(root, '.claude', 'forge-runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(Object.assign({ run_id: runId, project_type: 'forge-system/tooling' }, runExtra || {})));
  const t0 = Date.parse('2026-07-12T00:00:00.000Z');
  const lines = events.map((e, i) => JSON.stringify(Object.assign({ run_id: runId, timestamp: new Date(t0 + i * 1000).toISOString() }, e)));
  fs.writeFileSync(path.join(runDir, 'events.jsonl'), lines.join('\n') + '\n');
  return runDir;
}

function lessonsFor(root, slug) {
  try { return fs.readFileSync(path.join(root, '.claude', 'agent-memory', slug, 'lessons.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
}
function eventsOf(root, runId) {
  return fs.readFileSync(path.join(root, '.claude', 'forge-runs', runId, 'events.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}
function runCli(args, root) {
  return spawnSync(process.execPath, [DISTILL_CLI, ...args], { env: Object.assign({}, process.env, { FORGE_PROJECT_ROOT: root }), encoding: 'utf8' });
}

// ---- 1) failure event -> episodic guard-rail lesson written with evidence {run_id, ts, event_type} ----
{
  const root = makeFixture('case1');
  const runId = 'run-case1';
  writeRun(root, runId, [{ event_type: 'subagent_failed', agent: 'Build Boss', task: 'implement widget', issue: 'missing null check', required_fix: 'add guard clause' }]);
  const summary = D.distillRun(runId, { max: 3, dryRun: false, root });
  t('case1: 1 lesson written', summary.written === 1);
  t('case1: it is a guard-rail (episodic)', summary.guardRails === 1 && summary.strategies === 0);
  const lessons = lessonsFor(root, 'build-boss');
  t('case1: lessons.jsonl has exactly 1 line', lessons.length === 1);
  t('case1: type is episodic', lessons[0] && lessons[0].type === 'episodic');
  t('case1: text carries GUARD-RAIL + issue + fix', lessons.length === 1 && /GUARD-RAIL/.test(lessons[0].text) && /missing null check/.test(lessons[0].text) && /add guard clause/.test(lessons[0].text));
  let evidence = null; try { evidence = JSON.parse(lessons[0].evidence); } catch { /* fail below */ }
  t('case1: evidence is a parseable {run_id, ts, event_type}', !!evidence && evidence.run_id === runId && !!evidence.ts && evidence.event_type === 'subagent_failed');
}

// ---- 2) success event with substance -> semantic strategy lesson ----
{
  const root = makeFixture('case2');
  const runId = 'run-case2';
  writeRun(root, runId, [{ event_type: 'subagent_completed', agent: 'Test Boss', task: 'run test suite', note: 'all green 42/42' }]);
  const summary = D.distillRun(runId, { max: 3, dryRun: false, root });
  t('case2: 1 lesson written', summary.written === 1);
  t('case2: it is a strategy (semantic)', summary.strategies === 1 && summary.guardRails === 0);
  const lessons = lessonsFor(root, 'test-boss');
  t('case2: type is semantic', lessons[0] && lessons[0].type === 'semantic');
  t('case2: text carries STRATEGY + summary', lessons.length === 1 && /STRATEGY/.test(lessons[0].text) && /42\/42/.test(lessons[0].text));
}

// ---- 3) success event with NO substance -> skipped ----
{
  const root = makeFixture('case3');
  const runId = 'run-case3';
  writeRun(root, runId, [{ event_type: 'agent_completed', agent: 'Build Boss' }]);
  const summary = D.distillRun(runId, { max: 3, dryRun: false, root });
  t('case3: nothing written for a substance-free success event', summary.written === 0);
  t('case3: counted as skipped (exactly 1)', summary.skipped === 1);
  t('case3: no lessons file created', lessonsFor(root, 'build-boss').length === 0);
}

// ---- 4) event from an unregistered/generic agent -> skipped, counted ----
{
  const root = makeFixture('case4');
  const runId = 'run-case4';
  writeRun(root, runId, [{ event_type: 'subagent_failed', agent: 'orchestrator', task: 'x', issue: 'y' }]);
  const summary = D.distillRun(runId, { max: 3, dryRun: false, root });
  t('case4: unregistered/generic agent writes nothing', summary.written === 0);
  t('case4: counted as skipped (exactly 1)', summary.skipped === 1);
}

// ---- 5) dedupe: distilling the same run twice writes 0 the second time ----
{
  const root = makeFixture('case5');
  const runId = 'run-case5';
  writeRun(root, runId, [{ event_type: 'subagent_failed', agent: 'Build Boss', task: 'implement widget', issue: 'missing null check', required_fix: 'add guard clause' }]);
  const first = D.distillRun(runId, { max: 3, dryRun: false, root });
  const second = D.distillRun(runId, { max: 3, dryRun: false, root });
  t('case5: first distill writes 1', first.written === 1);
  t('case5: second distill of the same run writes 0 (dedupe)', second.written === 0);
  t('case5: second distill counts the dup as skipped', second.skipped === 1);
  t('case5: lessons.jsonl still has exactly 1 line (no duplicate persisted)', lessonsFor(root, 'build-boss').length === 1);
}

// ---- 6) cap: many events -> max N per boss, failures prioritized over successes ----
{
  const root = makeFixture('case6');
  const runId = 'run-case6';
  writeRun(root, runId, [
    { event_type: 'subagent_completed', agent: 'Build Boss', task: 's1', note: 'ok one' },
    { event_type: 'subagent_failed', agent: 'Build Boss', task: 'f1', issue: 'issue one', required_fix: 'fix one' },
    { event_type: 'subagent_completed', agent: 'Build Boss', task: 's2', note: 'ok two' },
    { event_type: 'subagent_failed', agent: 'Build Boss', task: 'f2', issue: 'issue two', required_fix: 'fix two' },
    { event_type: 'subagent_failed', agent: 'Build Boss', task: 'f3', issue: 'issue three', required_fix: 'fix three' },
  ]);
  const summary = D.distillRun(runId, { max: 2, dryRun: false, root });
  t('case6: capped to exactly 2 written', summary.written === 2);
  t('case6: both written are guard-rails (failures prioritized over successes)', summary.guardRails === 2 && summary.strategies === 0);
  t('case6: perBoss reflects the cap', summary.perBoss['build-boss'] && summary.perBoss['build-boss'].written === 2);
  t('case6: the other 3 candidates (1 failure + 2 successes) are skipped, not written', summary.skipped === 3);
  t('case6: lessons.jsonl has exactly 2 lines on disk', lessonsFor(root, 'build-boss').length === 2);
}

// ---- 7) secret in event note -> lesson text is redacted, never the raw secret ----
{
  const root = makeFixture('case7');
  const runId = 'run-case7';
  const secret = '\x73k_live_abc123456789012345';
  writeRun(root, runId, [{ event_type: 'subagent_completed', agent: 'Build Boss', task: 'add API key handling', note: `tested with ${secret} successfully` }]);
  D.distillRun(runId, { max: 3, dryRun: false, root });
  const lessons = lessonsFor(root, 'build-boss');
  t('case7: lesson written', lessons.length === 1);
  t('case7: raw secret never persisted in the lesson text', !lessons.some((l) => l.text.includes(secret)));
  // forge-memory.cjs's own redactor is authoritative (this file never reimplements it) — it currently
  // emits "***REDACTED***" via forge-store.cjs's first-layer redactValue() when that module is present,
  // falling back to its own local "[REDACTED]" otherwise. Assert on the redaction OUTCOME (some marker
  // replaced the secret), not on a marker string owned by another file.
  t('case7: a redaction marker replaced the secret', lessons.length === 1 && /REDACTED/i.test(lessons[0].text));
}

// ---- 8) --recall returns the written lesson in ADVISORY format; unknown boss -> honest empty, exit 0 ----
{
  const root = makeFixture('case8');
  const runId = 'run-case8';
  writeRun(root, runId, [{ event_type: 'subagent_failed', agent: 'Build Boss', task: 'implement widget', issue: 'missing null check', required_fix: 'add guard clause' }]);
  D.distillRun(runId, { max: 3, dryRun: false, root });

  const recalled = runCli(['--recall', 'build-boss', 'implement', 'widget'], root);
  t('case8: recall CLI exits 0', recalled.status === 0);
  t('case8: recall prints the ADVISORY header', /ADVISORY LESSONS for build-boss/.test(recalled.stdout));
  t('case8: recall labels the lesson [guard-rail]', /\[guard-rail\]/.test(recalled.stdout));
  t('case8: recall shows the evidence run_id', recalled.stdout.includes(runId));

  const emptyRecall = runCli(['--recall', 'unknown-boss'], root);
  t('case8b: recall for an unknown boss exits 0', emptyRecall.status === 0);
  t('case8b: recall for an unknown boss is an honest empty state', /no distilled lessons yet for unknown-boss/.test(emptyRecall.stdout));
}

// ---- 9) missing run -> exit 1 with a clear error ----
{
  const root = makeFixture('case9');
  const missing = runCli(['--run', 'this-run-does-not-exist'], root);
  t('case9: missing run exits 1', missing.status === 1);
  t('case9: missing run prints a clear error naming the run + "not found"', /this-run-does-not-exist/.test(missing.stderr) && /not found/.test(missing.stderr));
}

// ---- 10) --dry-run writes nothing (no lessons file, no self-log event) ----
{
  const root = makeFixture('case10');
  const runId = 'run-case10';
  writeRun(root, runId, [{ event_type: 'subagent_failed', agent: 'Build Boss', task: 'implement widget', issue: 'missing null check', required_fix: 'add guard clause' }]);
  const dry = runCli(['--run', runId, '--dry-run', '--json'], root);
  t('case10: dry-run CLI exits 0', dry.status === 0);
  let parsed = null; try { parsed = JSON.parse(dry.stdout); } catch { /* fail below */ }
  t('case10: dry-run reports dryRun:true and the would-be written count', !!parsed && parsed.dryRun === true && parsed.written === 1);
  t('case10: no lessons file created on disk', lessonsFor(root, 'build-boss').length === 0);
  t('case10: no memory_updated event logged either (dry-run never self-logs)', !eventsOf(root, runId).some((e) => e.event_type === 'memory_updated'));
}

// ---- 11) (bonus, verifying the SELF-LOGGING requirement) a real distill logs one memory_updated event ----
{
  const root = makeFixture('case11');
  const runId = 'run-case11';
  writeRun(root, runId, [{ event_type: 'subagent_failed', agent: 'Build Boss', task: 'implement widget', issue: 'missing null check', required_fix: 'add guard clause' }]);
  const real = runCli(['--run', runId, '--json'], root);
  t('case11: real (non-dry-run) distill CLI exits 0', real.status === 0);
  const memEvent = eventsOf(root, runId).find((e) => e.event_type === 'memory_updated');
  t('case11: a real memory_updated event was appended via log-event.cjs', !!memEvent);
  t('case11: memory_updated note mentions the boss + lesson count', !!memEvent && /build-boss/.test(memEvent.note) && /1 lessons/.test(memEvent.note));
}

// ---- 12) (bonus) usage errors: no args, and --run with a missing run_id value, both exit 2 ----
{
  const root = makeFixture('case12');
  const noArgs = runCli([], root);
  t('case12: no arguments at all -> usage error exit 2', noArgs.status === 2);
  const noRunId = runCli(['--run'], root);
  t('case12: --run with no run_id value -> usage error exit 2', noRunId.status === 2);
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
