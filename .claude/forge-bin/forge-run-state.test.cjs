#!/usr/bin/env node
'use strict';
// forge-run-state.test.cjs — tests the durable-resume projector (2026-07-11). A completed agent is not
// resumed; an agent that started with no terminal is unfinished; a failed agent is queued for redo; a
// side-effecting last step raises an idempotency warning; a blocked gate makes the run resumable.
// Convention: prints "<N> passed, <M> failed"; exit non-zero on any failure.
const assert = require('assert');
const { projectRunState } = require('./forge-run-state.cjs');

let passed = 0, failed = 0;
function t(name, fn) { try { fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); } }

console.log('forge durable-resume projector tests');
const events = [
  { agent: 'Build Boss', event_type: 'subagent_started', timestamp: '2026-07-11T00:00:00Z' },
  { agent: 'Build Boss', event_type: 'subagent_completed', timestamp: '2026-07-11T00:00:10Z' },
  { agent: 'Test Boss', event_type: 'subagent_started', timestamp: '2026-07-11T00:00:05Z' }, // no terminal -> unfinished
  { agent: 'Integration Boss', event_type: 'subagent_started', task: 'send lead email', timestamp: '2026-07-11T00:00:06Z' },
  { agent: 'Integration Boss', event_type: 'subagent_failed', task: 'send lead email', timestamp: '2026-07-11T00:00:12Z' },
];
const st = projectRunState('r1', events);

t('completed agent is NOT resumed', () => assert.ok(!st.resume.includes('Build Boss')));
t('agent started with no terminal is unfinished + resumable', () => assert.ok(st.unfinished.includes('Test Boss') && st.resume.includes('Test Boss')));
t('failed agent is queued for redo', () => assert.ok(st.failed.includes('Integration Boss') && st.resume.includes('Integration Boss')));
t('side-effecting failed step raises an idempotency warning', () => assert.ok(st.side_effect_warnings.includes('Integration Boss')));
t('run is marked resumable when work remains', () => assert.strictEqual(st.resumable, true));

const clean = projectRunState('r2', [
  { agent: 'Build Boss', event_type: 'subagent_started', timestamp: '2026-07-11T00:00:00Z' },
  { agent: 'Build Boss', event_type: 'subagent_completed', timestamp: '2026-07-11T00:00:10Z' },
  { event_type: 'quality_gate_passed', gate: 'integration', command: 'npm test', exit_code: 0, evidence: 'x' },
]);
t('a fully-completed run with a passed gate is COMPLETE (nothing to resume)', () => assert.ok(clean.complete && !clean.resumable && clean.resume.length === 0));

const blocked = projectRunState('r3', [
  { agent: 'Build Boss', event_type: 'subagent_started', timestamp: '2026-07-11T00:00:00Z' },
  { agent: 'Build Boss', event_type: 'subagent_completed', timestamp: '2026-07-11T00:00:10Z' },
  { event_type: 'quality_gate_blocked', gate: 'integration', note: 'tests failed' },
]);
t('a blocked gate makes an otherwise-finished run resumable', () => assert.ok(blocked.blocked_gates.includes('integration') && blocked.resumable));

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
