#!/usr/bin/env node
'use strict';
/**
 * forge-otel.cjs — export a Forge run as OpenTelemetry GenAI spans in OTLP/HTTP-JSON (2026-07-11, NEXT tier).
 * Makes a Forge run viewable/scoreable in Langfuse / Phoenix / Grafana Tempo / any OTLP backend WITHOUT a
 * bespoke reader. events.jsonl stays the source of truth; this is a projection. Zero-dependency.
 *
 * Mapping: run → one trace (root span = the whole run). Each paired *_started → *_(passed|completed|failed)
 * becomes a child span (gen_ai.operation.name=invoke_agent), timed from real timestamps, status OK/ERROR.
 *
 * Usage:
 *   node forge-otel.cjs <run_id> [--out <file>]     # write OTLP JSON (default: stdout)
 *   node forge-otel.cjs <run_id> --post             # POST to $OTEL_EXPORTER_OTLP_ENDPOINT/v1/traces
 * Honesty: the OpenTelemetry GenAI semantic conventions are still "development"-stability — pin the version
 * and treat this as opt-in. Nothing is emitted unless you run it.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SEMCONV = '1.30.0'; // pinned OTel semconv version this mapping targets
const PROJECT_ROOT = process.env.FORGE_PROJECT_ROOT ? path.resolve(process.env.FORGE_PROJECT_ROOT) : path.resolve(__dirname, '..', '..');
const RUNS_DIR = path.join(PROJECT_ROOT, '.claude', 'forge-runs');

function safeRead(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function readEvents(id) { const raw = safeRead(path.join(RUNS_DIR, id, 'events.jsonl')); if (!raw) return []; const out = []; for (const l of raw.split(/\r?\n/)) { const t = l.trim(); if (!t) continue; try { const v = JSON.parse(t); if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v); } catch {} } return out; }
function traceIdFor(runId) { return crypto.createHash('sha256').update('forge-trace:' + runId).digest().slice(0, 16).toString('hex'); }
function spanIdFor(runId, key) { return crypto.createHash('sha256').update('forge-span:' + runId + ':' + key).digest().slice(0, 8).toString('hex'); }
function nanos(ms) { return Number.isFinite(ms) ? String(BigInt(Math.round(ms)) * 1000000n) : '0'; } // ms→ns (BigInt: avoids 2^53 precision loss)
function attr(key, value) { return typeof value === 'number' ? { key, value: { intValue: String(value) } } : { key, value: { stringValue: String(value) } }; }
function agentKeyOf(e) { return e.agent || 'system'; }

// Pair *_started → *_(passed|completed|failed) per agent into spans (same shape as the waterfall lens).
function buildSpans(runId, events) {
  const timed = events.map((e) => ({ e, t: Date.parse(e.timestamp), key: agentKeyOf(e) })).filter((x) => Number.isFinite(x.t));
  if (!timed.length) return { traceId: traceIdFor(runId), spans: [] };
  const traceId = traceIdFor(runId);
  let minT = Infinity, maxT = -Infinity;
  for (const x of timed) { if (x.t < minT) minT = x.t; if (x.t > maxT) maxT = x.t; }
  const rootId = spanIdFor(runId, 'root');
  const spans = [{ traceId, spanId: rootId, name: 'forge.run ' + runId, kind: 1, startTimeUnixNano: nanos(minT), endTimeUnixNano: nanos(maxT), attributes: [attr('forge.run_id', runId), attr('gen_ai.operation.name', 'run'), attr('forge.event_count', events.length)], status: { code: 1 } }];
  const byLane = new Map(); const laneOrder = [];
  for (const x of timed) { if (!byLane.has(x.key)) { byLane.set(x.key, []); laneOrder.push(x.key); } byLane.get(x.key).push(x); }
  const isStart = (t) => /_started$/.test(t);
  const isEnd = (t) => /_(passed|completed|failed)$/.test(t);
  let n = 0;
  for (const key of laneOrder) {
    const list = byLane.get(key).slice().sort((a, b) => a.t - b.t);
    const open = []; const done = [];
    for (const x of list) { const t = x.e.event_type; if (isStart(t)) open.push(x); else if (isEnd(t) && open.length) { const s = open.shift(); done.push({ from: s.t, to: x.t, failed: /_failed$/.test(t), label: x.e.task || s.e.task || t }); } }
    for (const s of open) done.push({ from: s.t, to: maxT, failed: false, label: s.e.task || s.e.event_type });
    for (const s of done) {
      spans.push({ traceId, spanId: spanIdFor(runId, key + ':' + (n++)), parentSpanId: rootId, name: key + ' · ' + s.label, kind: 1,
        startTimeUnixNano: nanos(s.from), endTimeUnixNano: nanos(s.to),
        attributes: [attr('gen_ai.operation.name', 'invoke_agent'), attr('gen_ai.agent.name', key), attr('forge.run_id', runId)],
        status: { code: s.failed ? 2 : 1 } });
    }
  }
  return { traceId, spans };
}

function toOtlp(runId, events) {
  const { spans } = buildSpans(runId, events);
  return { resourceSpans: [{ resource: { attributes: [attr('service.name', 'forge'), attr('telemetry.sdk.name', 'forge-otel'), attr('forge.semconv', SEMCONV)] }, scopeSpans: [{ scope: { name: 'forge', version: '1.0.0' }, spans }] }] };
}

function post(endpoint, body) {
  return new Promise((resolve) => {
    let url; try { url = new URL(endpoint.replace(/\/$/, '') + '/v1/traces'); } catch { return resolve({ ok: false, error: 'bad endpoint' }); }
    const lib = url.protocol === 'https:' ? require('https') : require('http');
    const data = Buffer.from(JSON.stringify(body));
    const req = lib.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, (res) => { res.resume(); res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode })); });
    req.on('error', (e) => resolve({ ok: false, error: e.message })); req.write(data); req.end();
  });
}

module.exports = { buildSpans, toOtlp, traceIdFor, spanIdFor, nanos };

if (require.main === module) {
  const args = process.argv.slice(2);
  const runId = args.find((a) => !a.startsWith('--'));
  const doPost = args.includes('--post');
  const outIdx = args.indexOf('--out');
  if (!runId || !/^[A-Za-z0-9_-]+$/.test(runId)) { console.error('usage: node forge-otel.cjs <run_id> [--out <file>] [--post]'); process.exit(2); }
  const events = readEvents(runId);
  if (!events.length) { console.error('no events for run ' + runId); process.exit(2); }
  const otlp = toOtlp(runId, events);
  if (doPost) {
    const ep = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    if (!ep) { console.error('--post needs OTEL_EXPORTER_OTLP_ENDPOINT'); process.exit(2); }
    post(ep, otlp).then((r) => { console.error('OTLP POST ' + (r.ok ? 'OK' : 'FAILED') + ' ' + (r.status || r.error || '') + ' · ' + otlp.resourceSpans[0].scopeSpans[0].spans.length + ' spans'); process.exit(r.ok ? 0 : 1); });
  } else {
    const json = JSON.stringify(otlp, null, 2);
    if (outIdx >= 0 && args[outIdx + 1]) { fs.writeFileSync(args[outIdx + 1], json, 'utf8'); console.error('wrote ' + otlp.resourceSpans[0].scopeSpans[0].spans.length + ' spans -> ' + args[outIdx + 1]); }
    else process.stdout.write(json + '\n');
  }
}
