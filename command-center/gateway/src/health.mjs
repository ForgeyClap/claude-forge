// GET /api/health composition: this gateway's own pulse + a live, honest probe of the existing
// Forge Control Center dashboard + the newest doctor receipt found on disk. Every sub-state uses
// the truthful-state vocabulary from masterprompt.txt §6 (UNKNOWN/UNAVAILABLE/NOT CONFIGURED/
// CONNECTING/DISCONNECTED/DEGRADED/RATE LIMITED/STALE/PARTIAL/BLOCKED/FAILED/UNVERIFIED/
// INSUFFICIENT EVIDENCE) — "CONNECTED" is this file's one added positive counterpart to
// DISCONNECTED, since the vocabulary lists failure states, not their opposites.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { PROJECT_ROOT, CLAUDE_DIR, FORGE_RUNS_DIR } from './paths.mjs';
// P2-12 fix, part (a) (cc-fix-gateway-perf, forge-2026-07-29-cc-finish): the dashboard's health-poll
// (every 5s) was calling the full GET /api/conversations endpoint a SECOND time purely to read the
// `execution` field (server.mjs already returns it on /api/conversations — see that route) —
// needlessly paying conversations.mjs's full listConversations() cost just for one small object that
// has nothing to do with conversations. executionAvailability() is cheap (the real CLI path is
// resolved once and cached for the process lifetime, see exec-bridge.mjs) so exposing it here too is
// free. Handoff: removing the dashboard's now-redundant second /api/conversations call is
// dashboard/-scoped and out of this WP's write scope — flagged in the forge-report.
import { executionAvailability } from './exec-bridge.mjs';

const CONTROL_CENTER_PROBE_TIMEOUT_MS = 2000;
// R3 fix (WP3 T3.1-T3.10, architecture-review risk): the Control Center probe was a real network
// call on EVERY /api/health request. A 5s micro-cache means a burst of health polls (dashboard
// refresh, multiple browser tabs) costs one real probe per 5s, not one per request — while still
// staying close to live (age_ms exposed so a caller can see exactly how fresh it is).
const CONTROL_CENTER_PROBE_TTL_MS = 5000;
let controlCenterCache = null; // { result, capturedAtMs, port }
let _probeCallCountForTests = 0; // test-only instrumentation — never read by production code

function readControlCenterPort() {
  const portFile = path.join(CLAUDE_DIR, 'forge-dashboard', 'PORT');
  try {
    const raw = fs.readFileSync(portFile, 'utf8').trim();
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : 3936; // documented fallback per this project's CLAUDE.md
  } catch {
    return 3936;
  }
}

function probeControlCenter(port) {
  _probeCallCountForTests += 1;
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/health', timeout: CONTROL_CENTER_PROBE_TIMEOUT_MS },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            resolve({ state: 'CONNECTED', port, dashboard_port: parsed.dashboard_port, project_name: parsed.project_name, latest_run_id: parsed.latest_run_id });
          } catch {
            resolve({ state: 'DEGRADED', port, note: 'reachable but response was not valid JSON' });
          }
        });
      },
    );
    req.on('timeout', () => { req.destroy(); resolve({ state: 'DISCONNECTED', port, note: 'probe timed out after ' + CONTROL_CENTER_PROBE_TIMEOUT_MS + 'ms' }); });
    req.on('error', (err) => { resolve({ state: 'DISCONNECTED', port, note: err && err.code ? err.code : 'connection failed' }); });
  });
}

function findNewestDoctorReceipt() {
  let entries;
  try {
    entries = fs.readdirSync(FORGE_RUNS_DIR, { withFileTypes: true });
  } catch {
    return { state: 'UNAVAILABLE', note: 'forge-runs directory not readable' };
  }
  let newest = null;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const doctorPath = path.join(FORGE_RUNS_DIR, entry.name, 'doctor.json');
    let stat;
    try { stat = fs.statSync(doctorPath); } catch { continue; }
    if (!newest || stat.mtimeMs > newest.mtimeMs) newest = { path: doctorPath, mtimeMs: stat.mtimeMs, runId: entry.name };
  }
  if (!newest) return { state: 'NOT CONFIGURED', note: 'no doctor.json found under any run' };
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(newest.path, 'utf8')); } catch {
    return { state: 'UNVERIFIED', note: 'doctor.json found but could not be parsed', run_id: newest.runId };
  }
  const ageMs = Date.now() - newest.mtimeMs;
  const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — advisory only, not a hard rule
  return {
    state: ageMs > STALE_AFTER_MS ? 'STALE' : (parsed.ok ? 'CONNECTED' : 'FAILED'),
    run_id: newest.runId,
    ok: !!parsed.ok,
    suites: parsed.checks && parsed.checks.tests ? parsed.checks.tests.suites : undefined,
    passed: parsed.checks && parsed.checks.tests ? parsed.checks.tests.passed : undefined,
    failed: parsed.checks && parsed.checks.tests ? parsed.checks.tests.failed : undefined,
    captured_at: new Date(newest.mtimeMs).toISOString(),
    age_ms: ageMs,
  };
}

async function probeControlCenterCached(port) {
  const now = Date.now();
  if (controlCenterCache && controlCenterCache.port === port && (now - controlCenterCache.capturedAtMs) < CONTROL_CENTER_PROBE_TTL_MS) {
    return { ...controlCenterCache.result, age_ms: now - controlCenterCache.capturedAtMs };
  }
  const result = await probeControlCenter(port);
  controlCenterCache = { result, capturedAtMs: Date.now(), port };
  return { ...result, age_ms: 0 };
}

import { getRuntimeState } from './runtime-state.mjs';

export async function buildHealth(startedAtMs) {
  const port = readControlCenterPort();
  const controlCenter = await probeControlCenterCached(port);
  const doctorLast = findNewestDoctorReceipt();
  const now = new Date();
  // AUDIT G8.1 (2026-08-06): health was onvoorwaardelijk ok:true — een DEGRADED runtime (uncaught
  // exception) bleef onzichtbaar. Nu is de runtime-staat onderdeel van het oordeel: readiness-rood.
  const runtime = getRuntimeState();
  return {
    ok: runtime.state === 'OK',
    runtime,
    gateway: {
      version: '0.1.0',
      uptime_s: Math.round((Date.now() - startedAtMs) / 1000),
      project_root: PROJECT_ROOT,
    },
    forge: {
      control_center: controlCenter,
      doctor_last: doctorLast,
    },
    // P2-12 fix, part (a): same shape/value as the `execution` field on GET /api/conversations
    // (server.mjs) — exposed here too so a caller that only needs execution availability (e.g. a
    // health-poll) never has to pay conversations.mjs's full listConversations() cost just to read it.
    execution: executionAvailability(),
    captured_at: now.toISOString(),
    age_ms: 0,
    provenance: 'LIVE',
  };
}

// Test-only hooks (R3 micro-cache verification): reset/expire the cache deterministically and
// observe how many REAL network probes actually happened, without a real 5s wait in the suite.
export function _resetHealthCacheForTests() { controlCenterCache = null; _probeCallCountForTests = 0; }
export function _expireHealthCacheForTests() { if (controlCenterCache) controlCenterCache.capturedAtMs = Date.now() - CONTROL_CENTER_PROBE_TTL_MS - 1; }
export function _getControlCenterProbeCallCountForTests() { return _probeCallCountForTests; }
