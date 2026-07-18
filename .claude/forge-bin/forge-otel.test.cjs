#!/usr/bin/env node
'use strict';
// forge-otel.test.cjs — tests the OpenTelemetry export mapping (2026-07-11). Validates OTLP/HTTP-JSON
// structure, deterministic trace/span id formats, BigInt-exact nanosecond timestamps (no 2^53 loss), and
// OK/ERROR status mapping. Convention: prints "<N> passed, <M> failed"; exit non-zero on any failure.
const assert = require('assert');
const otel = require('./forge-otel.cjs');

let passed = 0, failed = 0;
function t(name, fn) { try { fn(); passed++; console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + e.message); } }

console.log('forge OTel export tests (OTLP/HTTP-JSON, GenAI spans)');
const runId = 'otel-test-run';
const events = [
  { agent: 'Build Boss', event_type: 'agent_started', timestamp: '2026-07-11T00:00:00Z' },
  { agent: 'Build Boss', event_type: 'agent_completed', timestamp: '2026-07-11T00:00:10Z' },
  { agent: 'Test Boss', event_type: 'check_started', task: 'e2e', timestamp: '2026-07-11T00:00:05Z' },
  { agent: 'Test Boss', event_type: 'check_failed', task: 'e2e', timestamp: '2026-07-11T00:00:20Z' },
];

t('nanos() is BigInt-exact (no 2^53 precision loss)', () => {
  assert.strictEqual(otel.nanos(1000), '1000000000');
  assert.strictEqual(otel.nanos(1780000000000), '1780000000000000000');
});
t('traceId is 32 hex chars, spanId is 16 hex chars, deterministic', () => {
  assert.ok(/^[0-9a-f]{32}$/.test(otel.traceIdFor(runId)));
  assert.ok(/^[0-9a-f]{16}$/.test(otel.spanIdFor(runId, 'x')));
  assert.strictEqual(otel.traceIdFor(runId), otel.traceIdFor(runId)); // deterministic
});

const otlp = otel.toOtlp(runId, events);
const spans = otlp.resourceSpans[0].scopeSpans[0].spans;
t('OTLP shape: resourceSpans → scopeSpans → spans', () => {
  assert.strictEqual(otlp.resourceSpans.length, 1);
  assert.strictEqual(otlp.resourceSpans[0].scopeSpans.length, 1);
  assert.ok(Array.isArray(spans));
});
t('1 root span + 2 agent spans = 3 spans', () => assert.strictEqual(spans.length, 3));
t('root span has no parent; children reference it', () => {
  const root = spans[0];
  assert.ok(!root.parentSpanId);
  assert.ok(spans.slice(1).every((s) => s.parentSpanId === root.spanId));
});
t('all spans share the run trace id', () => { const tid = otel.traceIdFor(runId); assert.ok(spans.every((s) => s.traceId === tid)); });
t('a failed check maps to OTel status ERROR (code 2)', () => {
  const testSpan = spans.find((s) => /Test Boss/.test(s.name));
  assert.ok(testSpan && testSpan.status.code === 2);
});
t('a completed agent maps to status OK (code 1)', () => {
  const buildSpan = spans.find((s) => /Build Boss/.test(s.name));
  assert.ok(buildSpan && buildSpan.status.code === 1);
});
t('span timestamps are numeric nanosecond strings', () => {
  assert.ok(spans.every((s) => /^\d+$/.test(s.startTimeUnixNano) && /^\d+$/.test(s.endTimeUnixNano)));
});
t('gen_ai.agent.name attribute is set on agent spans', () => {
  const buildSpan = spans.find((s) => /Build Boss/.test(s.name));
  assert.ok(buildSpan.attributes.some((a) => a.key === 'gen_ai.agent.name' && a.value.stringValue === 'Build Boss'));
});
t('empty events -> no spans (no crash)', () => { const o = otel.toOtlp(runId, []); assert.strictEqual(o.resourceSpans[0].scopeSpans[0].spans.length, 0); });

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
