#!/usr/bin/env node
'use strict';
// forge-runwatch.test.cjs — tests the completion/stall predicate (2026-07-24). Pure core: feed synthetic
// event arrays + an injected clock, assert overall/complete/evidence. One file-path case via a temp events.jsonl.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const rw = require('./forge-runwatch.cjs');

let passed = 0, failed = 0;
function t(name, fn) { try { fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); } }

const T0 = 1000000000000; // fixed base epoch ms
const iso = (ms) => new Date(ms).toISOString();

console.log('forge-runwatch tests');

t('empty / no start events -> overall=empty, not complete', () => {
  const st = rw.projectRunWatch([], { now: T0 });
  assert.strictEqual(st.overall, 'empty');
  assert.strictEqual(st.complete, false);
});

t('all started agents terminated -> done + complete, evidence carries the terminal lines', () => {
  const ev = [
    { agent: 'build-boss', event_type: 'agent_started', timestamp: iso(T0) },
    { agent: 'test-boss', event_type: 'agent_started', timestamp: iso(T0) },
    { agent: 'build-boss', event_type: 'agent_completed', timestamp: iso(T0 + 1000) },
    { agent: 'test-boss', event_type: 'agent_completed', timestamp: iso(T0 + 2000) },
  ];
  const st = rw.projectRunWatch(ev, { now: T0 + 3000 });
  assert.strictEqual(st.overall, 'done');
  assert.strictEqual(st.complete, true);
  assert.strictEqual(st.evidence.length, 2, 'two terminal evidence lines');
  assert.ok(st.evidence.every((e) => e.event_type === 'agent_completed'));
});

t('a started-but-open agent within the window -> running, not complete', () => {
  const ev = [
    { agent: 'build-boss', event_type: 'agent_started', timestamp: iso(T0) },
    { agent: 'build-boss', event_type: 'progress', timestamp: iso(T0 + 60000) },
  ];
  const st = rw.projectRunWatch(ev, { now: T0 + 120000, stallMs: 15 * 60 * 1000 });
  assert.strictEqual(st.overall, 'running');
  assert.strictEqual(st.complete, false);
  assert.deepStrictEqual(st.runningAgents, ['build-boss']);
});

t('a started agent silent beyond stallMs -> stalled, with silent_ms', () => {
  const ev = [
    { agent: 'build-boss', event_type: 'agent_started', timestamp: iso(T0) },
    { agent: 'build-boss', event_type: 'progress', timestamp: iso(T0 + 60000) },
  ];
  const st = rw.projectRunWatch(ev, { now: T0 + 60000 + (16 * 60 * 1000), stallMs: 15 * 60 * 1000 });
  assert.strictEqual(st.overall, 'stalled');
  assert.strictEqual(st.stalledAgents.length, 1);
  assert.strictEqual(st.stalledAgents[0].agent, 'build-boss');
  assert.strictEqual(st.stalledAgents[0].silent_ms, 16 * 60 * 1000);
});

t('failure + abort count as terminal (a failed run is still "done" resolving, not stalled)', () => {
  const ev = [
    { agent: 'a', event_type: 'agent_started', timestamp: iso(T0) },
    { agent: 'b', event_type: 'subagent_started', timestamp: iso(T0) },
    { agent: 'a', event_type: 'agent_failed', timestamp: iso(T0 + 1000) },
    { agent: 'b', event_type: 'subagent_aborted', timestamp: iso(T0 + 1000) },
  ];
  const st = rw.projectRunWatch(ev, { now: T0 + 99999999 });
  assert.strictEqual(st.overall, 'done');
  assert.strictEqual(st.counts.failed, 2);
  assert.strictEqual(st.counts.stalled, 0);
});

t('mixed: one done + one genuinely stalled -> overall stalled (not done)', () => {
  const ev = [
    { agent: 'a', event_type: 'agent_started', timestamp: iso(T0) },
    { agent: 'a', event_type: 'agent_completed', timestamp: iso(T0 + 1000) },
    { agent: 'b', event_type: 'agent_started', timestamp: iso(T0) },
  ];
  const st = rw.projectRunWatch(ev, { now: T0 + (20 * 60 * 1000), stallMs: 15 * 60 * 1000 });
  assert.strictEqual(st.overall, 'stalled');
  assert.strictEqual(st.complete, false);
  assert.strictEqual(st.counts.done, 1);
  assert.strictEqual(st.counts.stalled, 1);
});

t('watch() reads a real events.jsonl file and projects it', () => {
  const dir = path.join(os.tmpdir(), 'forge-runwatch-test-' + process.pid);
  const runDir = path.join(dir, 'run-X');
  fs.mkdirSync(runDir, { recursive: true });
  const lines = [
    { agent: 'build-boss', event_type: 'agent_started', timestamp: iso(T0) },
    { agent: 'build-boss', event_type: 'agent_completed', timestamp: iso(T0 + 1000) },
  ].map((o) => JSON.stringify(o)).join('\n');
  fs.writeFileSync(path.join(runDir, 'events.jsonl'), lines + '\n');
  const st = rw.watch('run-X', { runsDir: dir, now: T0 + 2000 });
  assert.ok(st, 'watch should find the run');
  assert.strictEqual(st.complete, true);
  assert.strictEqual(rw.watch('nope', { runsDir: dir }), null, 'missing run -> null');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
});

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
