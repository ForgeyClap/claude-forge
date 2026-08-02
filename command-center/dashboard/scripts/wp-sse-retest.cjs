#!/usr/bin/env node
/**
 * D3 SSE RETEST — WP retest-sse (forge-2026-07-29-cc-finish, Test Boss).
 *
 * The ONE point E2E-PART2 left ONBESLIST (D3, §7): the previous tester's outage window (2s) was
 * shorter than the app's own HEALTH_POLL_MS (5000ms — gateway-adapter.ts:242), so the
 * `.fw-conn` reconnect banner literally could not have appeared yet. This script fixes that by
 * running a real gateway kill + a >=12s outage + a real restart, with real, visible Chrome (CDP
 * 9333, never headless) and the already-fixed cdp-driver.cjs (Escape-dismiss, no blind click).
 *
 * Targeted selectors ONLY (learned from E2E-PART2 §4's self-corrected false positive: scanning
 * `document.body.innerText` picks up the right "CONVERSATION" Dock, which is mounted on every
 * route and can contain unrelated text). This script reads exactly:
 *   - `.fw-cc__state`      the topbar Claude Code chip (global, every route) — real text: Connecting…
 *                          / Reconnecting / Disconnected — start the gateway / Connected.
 *   - `.fw-conn`           the portalled reconnect banner (renders null when healthy).
 *   - `.fw-activity__list .fw-event__message`  the Activity event feed — used ONLY to look for our
 *                          own unique injected marker string, so no collision with the Dock's text.
 *   - `window.__sseSnapshot()`  a real per-EventSource readyState/event log, injected BEFORE the
 *                          app's own scripts via `Page.addScriptToEvaluateOnNewDocument` (same
 *                          proven technique as wp-part2-reality.cjs's phase 6).
 *
 * Sequence: baseline (stable, connected) -> kill gateway -> >=12s outage, sampled every ~1.5s,
 * with ONE real `agent_note` event written mid-outage straight to events.jsonl (a filesystem
 * write, independent of the gateway process) to test Last-Event-ID catch-up -> restart gateway
 * (identical spawn pattern to the existing phase6 helper) -> measure real ms to readyState:1
 * (OPEN), real ms to the banner disappearing, and whether the catch-up marker surfaces in the
 * Activity feed. Leaves the gateway running and healthy at the end — verified, not assumed.
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execSync, spawn } = require('node:child_process');
const driver = require('./cdp-driver.cjs');

const PORT = 9333;
const BASE = 'http://127.0.0.1:4100';
const EVIDENCE_DIR = path.resolve(__dirname, '../../mission/test-evidence/d3');
const RESULTS_PATH = path.join(EVIDENCE_DIR, 'results.json');
const GATEWAY_CWD = 'c:\\Users\\YOU\\Documents\\my-forge-project';
const GATEWAY_ENTRY = 'command-center/gateway/bin.mjs';
const LOG_EVENT_CJS = path.join(GATEWAY_CWD, '.claude', 'forge-dashboard', 'log-event.cjs');
const RUN_ID = 'forge-2026-07-29-cc-finish';
const PROJECT_NAME = 'my-forge-project';

const OUTAGE_TARGET_MS = 14000; // required: strictly over the app's own 5000ms HEALTH_POLL_MS, with margin
const OUTAGE_SAMPLE_MS = 1500;
const MARKER = `D3-SSE-CATCHUP-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const MARKER_NOTE = `${MARKER} — honest test marker written to events.jsonl while the gateway was deliberately killed, to verify the EventSource Last-Event-ID catch-up after reconnect (WP retest-sse).`;

const results = {
  startedAt: new Date().toISOString(),
  marker: MARKER,
  runId: RUN_ID,
  project: PROJECT_NAME,
  timeline: [],
  screenshots: [],
};

function log(...a) { console.log('[d3-retest]', new Date().toISOString(), ...a); }
function flush() { fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2)); }
function shot(session, name) {
  const file = path.join(EVIDENCE_DIR, `${name}.png`);
  return driver.screenshot(session, file).then(() => { results.screenshots.push(file); log('screenshot', name); return file; });
}

async function apiFetch(pathAndQuery) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}${pathAndQuery}`, { signal: AbortSignal.timeout(3000) });
    const body = await res.json().catch(() => null);
    return { status: res.status, ok: res.ok, body, ms: Date.now() - t0 };
  } catch (err) {
    return { status: 0, ok: false, error: String(err), ms: Date.now() - t0 };
  }
}

function getGatewayPid() {
  try {
    const out = execSync(
      'powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort 4100 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)"',
      { encoding: 'utf8' },
    ).trim();
    return out ? Number(out) : null;
  } catch { return null; }
}

async function waitForHealth(timeoutMs, expectDown) {
  const start = Date.now();
  const deadline = start + timeoutMs;
  while (Date.now() < deadline) {
    const r = await apiFetch('/api/health').catch(() => ({ ok: false }));
    if (expectDown ? !r.ok : r.ok) return { ok: true, waitedMs: Date.now() - start };
    await new Promise((res) => setTimeout(res, 300));
  }
  return { ok: false, waitedMs: Date.now() - start };
}

/* --------------------------------------------------------- browser-side reads (targeted only) */

async function readConnState(session) {
  return driver.evaluate(
    session,
    `(() => {
      const chip = document.querySelector('.fw-cc__state');
      const banner = document.querySelector('.fw-conn');
      return {
        chipText: chip ? chip.textContent.trim() : null,
        bannerPresent: !!banner,
        bannerStatus: banner ? banner.getAttribute('data-status') : null,
        bannerTitle: banner ? (banner.querySelector('.fw-conn__title')?.textContent.trim() || null) : null,
        bannerDetail: banner ? (banner.querySelector('.fw-conn__detail')?.textContent.trim() || null) : null,
        bannerMeta: banner ? (banner.querySelector('.fw-conn__meta')?.textContent.trim() || null) : null,
      };
    })()`,
  ).catch((err) => ({ error: String(err) }));
}

async function readSseSnapshot(session) {
  return driver.evaluate(session, `(() => (window.__sseSnapshot ? window.__sseSnapshot() : 'NO_HOOK'))()`).catch((err) => `ERROR:${err}`);
}

async function readActivityHasMarker(session, marker) {
  return driver.evaluate(
    session,
    `(() => {
      const msgs = Array.from(document.querySelectorAll('.fw-activity__list .fw-event__message, .fw-activity__list--flat .fw-event__message'));
      const found = msgs.some((m) => (m.textContent || '').includes(${JSON.stringify(marker)}));
      return { found, rowCount: msgs.length };
    })()`,
  ).catch((err) => ({ error: String(err) }));
}

function sample(label, tRelMs, conn, sse, marker) {
  const entry = { label, tRelMs, iso: new Date().toISOString(), conn, sseEntries: Array.isArray(sse) ? sse.map((e) => ({ url: e.url, readyState: e.readyState, lastEvent: e.events[e.events.length - 1] || null })) : sse, marker };
  results.timeline.push(entry);
  log(label, `t=${tRelMs}ms`, 'chip=', conn.chipText, 'banner=', conn.bannerStatus, 'sse=', JSON.stringify((entry.sseEntries || []).map((e) => e.readyState)));
  flush();
  return entry;
}

function anyOpen(sseEntries) {
  return Array.isArray(sseEntries) && sseEntries.some((e) => e.url && e.url.includes('/events/stream') && e.readyState === 1);
}
function eventsStreamEntries(sseEntries) {
  return Array.isArray(sseEntries) ? sseEntries.filter((e) => e.url && e.url.includes('/events/stream')) : [];
}

/* ============================================================================================ main */

async function main() {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'd3-sse-retest-chrome-'));
  log('Launching VISIBLE Chrome, CDP port', PORT, 'profile', profileDir);
  const chromeProc = driver.launchChrome({ port: PORT, userDataDir: profileDir, startUrl: 'about:blank', width: 1440, height: 900 });

  let verdicts = {};

  try {
    // Pre-flight: gateway must already be healthy before we touch anything.
    const preHealth = await apiFetch('/api/health');
    results.preflightHealth = { ok: preHealth.ok, status: preHealth.status };
    log('preflight gateway health:', JSON.stringify(results.preflightHealth));
    if (!preHealth.ok) {
      log('gateway not healthy before test — starting it once via the mandated command.');
      const child = spawn('node', [GATEWAY_ENTRY], { cwd: GATEWAY_CWD, detached: true, stdio: 'ignore', shell: true });
      child.unref();
      const up = await waitForHealth(20000, false);
      results.preflightStarted = up;
      if (!up.ok) throw new Error('gateway would not come up before the test even started');
    }

    await driver.waitForCdp(PORT, 20000);
    const session = await driver.connectToFirstPage(PORT, 20000);
    log('CDP session connected. chrome pid=', chromeProc.pid);

    await session.send('Page.enable');
    await session.send('Runtime.enable');

    // Same proven SSE-observability hook as wp-part2-reality.cjs phase 6, injected BEFORE the
    // app's own scripts run so every EventSource the app opens (including reconnects, which
    // reuse the SAME object per spec) is tracked from readyState 0 through open/error/message.
    const SSE_HOOK = `
      (function(){
        try {
          window.__sseLog = [];
          var OrigES = window.EventSource;
          function WrappedES(url, opts) {
            var es = new OrigES(url, opts);
            var rec = { url: String(url), events: [], createdAt: Date.now(), _es: es };
            window.__sseLog.push(rec);
            es.addEventListener('open', function(){ rec.events.push({ t: Date.now(), type: 'open', readyState: es.readyState }); });
            es.addEventListener('error', function(){ rec.events.push({ t: Date.now(), type: 'error', readyState: es.readyState }); });
            es.addEventListener('message', function(e){ rec.events.push({ t: Date.now(), type: 'message', dataLen: (e.data||'').length, lastEventId: e.lastEventId }); });
            return es;
          }
          WrappedES.prototype = OrigES.prototype;
          WrappedES.CONNECTING = OrigES.CONNECTING; WrappedES.OPEN = OrigES.OPEN; WrappedES.CLOSED = OrigES.CLOSED;
          window.EventSource = WrappedES;
          window.__sseSnapshot = function() { return window.__sseLog.map(function(r){ return { url: r.url, readyState: r._es.readyState, events: r.events.slice(-12) }; }); };
        } catch (e) { /* best-effort observability hook only */ }
      })();
    `;
    await session.send('Page.addScriptToEvaluateOnNewDocument', { source: SSE_HOOK });

    await driver.setViewport(session, { width: 1440, height: 900, mobile: false });

    // 1. Load, switch active project to "my-forge-project" (this run lives there), go to Activity
    //    (opens the exact /api/events/stream?project=...&run=... the mission targets).
    await driver.navigate(session, `${BASE}/#/`);
    await new Promise((r) => setTimeout(r, 700));
    const switchPt = await driver.evaluate(
      session,
      `(() => { const items = Array.from(document.querySelectorAll('.fw-prow__name')); const el = items.find(x => (x.textContent||'').includes(${JSON.stringify(PROJECT_NAME)})); if(!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`,
    );
    if (switchPt) { await driver.clickXY(session, switchPt.x, switchPt.y); await new Promise((r) => setTimeout(r, 600)); }
    const activeProjectName = await driver.evaluate(
      session,
      `(() => { const row = document.querySelector('.fw-prow[data-active="true"] .fw-prow__name'); return row ? row.textContent.trim() : null; })()`,
    ).catch(() => null);
    results.projectSwitch = { clickFound: !!switchPt, activeProjectName, matches: activeProjectName === PROJECT_NAME };
    log('project switch result:', JSON.stringify(results.projectSwitch));
    flush();

    await driver.navigate(session, `${BASE}/#/activity`);
    await new Promise((r) => setTimeout(r, 1000));

    // 2. BASELINE — wait (bounded) for a genuinely stable, connected state before trusting it.
    let baseline = null;
    const baselineDeadline = Date.now() + 15000;
    while (Date.now() < baselineDeadline) {
      const conn = await readConnState(session);
      const sse = await readSseSnapshot(session);
      if (conn.bannerPresent === false && conn.chipText === 'Connected' && anyOpen(sse)) { baseline = { conn, sse }; break; }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!baseline) { baseline = { conn: await readConnState(session), sse: await readSseSnapshot(session) }; }
    sample('baseline', 0, baseline.conn, baseline.sse, null);
    await shot(session, 'd3-0-baseline');
    results.baselineStable = baseline.conn.bannerPresent === false && baseline.conn.chipText === 'Connected' && anyOpen(baseline.sse);
    results.baselineReadyStates = eventsStreamEntries(baseline.sse).map((e) => e.readyState);
    flush();

    // 3. KILL the gateway — real taskkill, not a simulated one.
    const pidBefore = getGatewayPid();
    results.pidBefore = pidBefore;
    if (!pidBefore) throw new Error('could not resolve gateway PID before kill — refusing to proceed blind');
    log('killing gateway pid', pidBefore);
    try { execSync(`taskkill /PID ${pidBefore} /T /F`, { stdio: 'ignore' }); } catch (err) { log('taskkill warning:', err.message); }
    const killAt = Date.now();
    const downCheck = await waitForHealth(10000, true);
    results.downConfirmed = downCheck;
    log('gateway confirmed down:', JSON.stringify(downCheck));

    // 4. OUTAGE — sampled every ~1.5s for >= OUTAGE_TARGET_MS (>= 12s required, we use 14s).
    //    Mid-outage: write ONE real agent_note event straight to events.jsonl (filesystem write,
    //    independent of the dead gateway process) to test Last-Event-ID catch-up.
    let markerWrittenAt = null;
    let firstBannerDuringOutageAt = null;
    let firstBannerDuringOutage = null;
    while (Date.now() - killAt < OUTAGE_TARGET_MS) {
      const tRel = Date.now() - killAt;
      const conn = await readConnState(session);
      const sse = await readSseSnapshot(session);
      sample('outage', tRel, conn, sse, null);
      if (conn.bannerPresent && firstBannerDuringOutageAt === null) {
        firstBannerDuringOutageAt = tRel;
        firstBannerDuringOutage = conn;
      }
      if (markerWrittenAt === null && tRel >= 6000) {
        const cmd = `node "${LOG_EVENT_CJS}" ${RUN_ID} agent_note ${JSON.stringify(JSON.stringify({ agent: 'Test Boss', role: 'retest-sse', note: MARKER_NOTE }))}`;
        try {
          const out = execSync(cmd, { encoding: 'utf8', cwd: GATEWAY_CWD });
          markerWrittenAt = Date.now();
          results.markerWrite = { ok: true, cmdOutput: out.trim(), writtenAtRelMs: markerWrittenAt - killAt, writtenAtIso: new Date(markerWrittenAt).toISOString() };
          log('marker event written mid-outage:', out.trim());
        } catch (err) {
          results.markerWrite = { ok: false, error: String(err.stdout || err.message || err) };
          log('MARKER WRITE FAILED:', results.markerWrite.error);
        }
        flush();
      }
      if (tRel > 7000 && tRel < 9000) await shot(session, 'd3-1-during-outage');
      await new Promise((r) => setTimeout(r, OUTAGE_SAMPLE_MS));
    }
    const outageDurationMs = Date.now() - killAt;
    results.outageDurationMs = outageDurationMs;
    results.firstBannerDuringOutage = { atRelMs: firstBannerDuringOutageAt, conn: firstBannerDuringOutage };
    flush();

    // 5. RESTART — identical spawn pattern to the existing phase6 SSE helper (proven to work).
    log('restarting gateway...');
    const restartAt = Date.now();
    const child = spawn('node', [GATEWAY_ENTRY], { cwd: GATEWAY_CWD, detached: true, stdio: 'ignore', shell: true });
    child.unref();
    const apiUp = await waitForHealth(20000, false);
    const apiRecoveredAt = Date.now();
    const pidAfter = getGatewayPid();
    results.restart = { apiUp, apiRecoveredMsAfterRestartCall: apiRecoveredAt - restartAt, pidAfter };
    log('gateway back up (API):', JSON.stringify(results.restart));
    flush();

    // 6. RECOVERY — poll the BROWSER-side signals (not just the API) until readyState:1, the
    //    banner disappears, and the catch-up marker shows up in the Activity feed, or a 40s cap.
    let readyStateRecoveredAtMs = null;
    let bannerGoneAtMs = null;
    let markerCaughtUpAtMs = null;
    const recoveryDeadline = Date.now() + 40000;
    while (Date.now() < recoveryDeadline && (readyStateRecoveredAtMs === null || bannerGoneAtMs === null || (markerWrittenAt && markerCaughtUpAtMs === null))) {
      const tRel = Date.now() - restartAt;
      const conn = await readConnState(session);
      const sse = await readSseSnapshot(session);
      const markerCheck = await readActivityHasMarker(session, MARKER);
      sample('recovery', tRel, conn, sse, markerCheck);
      if (readyStateRecoveredAtMs === null && anyOpen(sse)) readyStateRecoveredAtMs = Date.now() - restartAt;
      if (bannerGoneAtMs === null && conn.bannerPresent === false && conn.chipText === 'Connected') bannerGoneAtMs = Date.now() - restartAt;
      if (markerWrittenAt && markerCaughtUpAtMs === null && markerCheck && markerCheck.found) markerCaughtUpAtMs = Date.now() - restartAt;
      await new Promise((r) => setTimeout(r, 800));
    }
    await shot(session, 'd3-2-after-recovery');
    const finalMarkerCheck = await readActivityHasMarker(session, MARKER);

    results.recovery = {
      readyStateRecoveredAtMs,
      bannerGoneAtMs,
      markerCaughtUpAtMs,
      finalMarkerCheck,
      markerFoundEventually: !!(finalMarkerCheck && finalMarkerCheck.found),
    };
    log('recovery result:', JSON.stringify(results.recovery));
    flush();

    // ---------------------------------------------------------------------------- verdicts
    verdicts = {
      baseline_readyState_open: results.baselineStable ? 'PASS' : (results.baselineReadyStates.length ? 'FAIL — baseline readyState not 1' : 'FAIL — no events/stream connection observed at baseline'),
      banner_appears_during_real_outage: firstBannerDuringOutageAt !== null ? 'PASS' : 'FAIL — banner never appeared during a 14s outage (> the app\'s own 5s health-poll)',
      readyState_recovers_to_open: readyStateRecoveredAtMs !== null ? 'PASS' : 'FAIL — EventSource never returned to readyState 1 within 40s of restart',
      banner_disappears_after_recovery: bannerGoneAtMs !== null ? 'PASS' : 'FAIL — banner/chip never returned to healthy within 40s of restart',
      missed_event_caught_up: results.recovery.markerFoundEventually ? 'PASS' : 'FAIL — the mid-outage agent_note never appeared in the Activity feed after reconnect',
    };
    results.verdicts = verdicts;
    results.d3Closed = Object.values(verdicts).every((v) => v === 'PASS');
    flush();

    session.close();
  } catch (err) {
    results.fatalError = String((err && err.stack) || err);
    flush();
    log('FATAL:', err);
  } finally {
    log('Killing Chrome (pid', chromeProc.pid, ') and its child processes...');
    try { execSync(`taskkill /PID ${chromeProc.pid} /T /F`, { stdio: 'ignore' }); } catch (err) { log('taskkill warning:', err.message); }
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ }
    // Non-negotiable: leave the gateway healthy, restarting once more if needed.
    const finalHealth = await waitForHealth(5000, false).catch(() => ({ ok: false }));
    if (!finalHealth.ok) {
      log('Gateway not healthy at script end — starting it one more time.');
      const child = spawn('node', [GATEWAY_ENTRY], { cwd: GATEWAY_CWD, detached: true, stdio: 'ignore', shell: true });
      child.unref();
      const recovered = await waitForHealth(20000, false);
      results.finalGatewayRecovery = recovered;
    } else {
      results.finalGatewayHealth = finalHealth;
    }
    results.finishedAt = new Date().toISOString();
    flush();
    log('DONE. results at', RESULTS_PATH, 'verdicts:', JSON.stringify(verdicts));
  }
}

main();
