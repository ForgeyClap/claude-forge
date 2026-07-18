#!/usr/bin/env node
'use strict';
// forge-agui.test.cjs — tests the AG-UI emit-bridge projection (2026-07-11).
const assert = require('assert');
const { toAguiEvents } = require('./forge-agui.cjs');

let passed = 0, failed = 0;
function t(name, fn) { try { fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); } }

console.log('forge AG-UI bridge tests');
const events = [
  { event_type: 'run_started', timestamp: '2026-07-11T00:00:00Z' },
  { agent: 'Build Boss', event_type: 'subagent_started', timestamp: '2026-07-11T00:00:01Z' },
  { agent: 'Test Boss', event_type: 'check_started', task: 'e2e', timestamp: '2026-07-11T00:00:02Z' },
  { agent: 'Test Boss', event_type: 'check_passed', task: 'e2e', timestamp: '2026-07-11T00:00:03Z' },
  { agent: 'Build Boss', event_type: 'file_changed', files_changed: ['src/app.ts'], timestamp: '2026-07-11T00:00:04Z' },
  { agent: 'Build Boss', event_type: 'subagent_completed', timestamp: '2026-07-11T00:00:05Z' },
  { event_type: 'run_completed', timestamp: '2026-07-11T00:00:06Z' },
];
const ag = toAguiEvents(events, { runId: 'r1' });
const types = ag.map((x) => x.type);

t('starts with RUN_STARTED', () => assert.strictEqual(ag[0].type, 'RUN_STARTED'));
t('ends with exactly one RUN_FINISHED', () => { assert.strictEqual(types.filter((x) => x === 'RUN_FINISHED').length, 1); assert.strictEqual(ag[ag.length - 1].type, 'RUN_FINISHED'); });
t('subagent_started -> STEP_STARTED (stepName = Boss)', () => { const s = ag.find((x) => x.type === 'STEP_STARTED'); assert.ok(s && s.stepName === 'Build Boss'); });
t('subagent_completed -> STEP_FINISHED', () => assert.ok(ag.some((x) => x.type === 'STEP_FINISHED' && x.stepName === 'Build Boss')));
t('check_started/passed -> paired TOOL_CALL_START/END with same id', () => { const s = ag.find((x) => x.type === 'TOOL_CALL_START'); const e = ag.find((x) => x.type === 'TOOL_CALL_END'); assert.ok(s && e && s.toolCallId === e.toolCallId); });
t('Forge-specific file_changed rides in a CUSTOM event', () => { const c = ag.find((x) => x.type === 'CUSTOM' && x.name === 'file_changed'); assert.ok(c && c.value.files_changed[0] === 'src/app.ts'); });
t('empty events still yield a valid RUN_STARTED..RUN_FINISHED envelope', () => { const e = toAguiEvents([], { runId: 'x' }); assert.ok(e[0].type === 'RUN_STARTED' && e[e.length - 1].type === 'RUN_FINISHED'); });

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
