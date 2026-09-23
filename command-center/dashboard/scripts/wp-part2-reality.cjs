#!/usr/bin/env node
/**
 * WP fin-e2e-reality — PART 2, the reality test.
 *
 * Real, visible Chrome (CDP 9333, never headless) driving the ALREADY-RUNNING gateway at
 * http://127.0.0.1:4100 (never started/stopped by this script except the ONE deliberate
 * kill+restart in phase 6, which restores it before exiting). Does:
 *   0. negative baseline (target folder absent from disk/API/UI)
 *   1. ONE real composer send (a real `claude -p` turn) that creates the folder+README, plus a
 *      real "New chat" click test (separate, free — conversation creation never spawns a CLI)
 *   2. ground-truth filesystem check
 *   3. triple-source check at one moment (screen vs raw API JSON vs filesystem)
 *   4. add the minimal real project marker, measure real latency until the UI shows it
 *   5. freshness sanity (age_ms/timestamps never negative or future)
 *   6. SSE-liveness: kill+restart the gateway, verify an honest reconnect/disconnected state
 *      (never a silent freeze on stale data), then leave the gateway back up and healthy
 *   7. clean retest sweep of all 13 views + the WP-specific new-panel assertions
 *
 * Writes mission/test-evidence/part2/results.json (flushed after every phase) plus screenshots
 * into the same folder. Never leaves Chrome running at the end.
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execSync, spawn } = require('node:child_process');
const driver = require('./cdp-driver.cjs');

const PORT = 9333;
const BASE = 'http://127.0.0.1:4100';
const EVIDENCE_DIR = path.resolve(__dirname, '../../mission/test-evidence/part2');
const RESULTS_PATH = path.join(EVIDENCE_DIR, 'results.json');
const GATEWAY_CWD = 'c:\\Users\\YOU\\Documents\\my project (v2)!';
const GATEWAY_ENTRY = 'command-center/gateway/bin.mjs';

const TS = new Date().toISOString().replace(/[:.]/g, '-');
const TARGET_NAME = `Forge-e2e-${TS}`;
const DOCS_ROOT = 'C:\\Users\\YOU\\Documents';
const TARGET_DIR = path.join(DOCS_ROOT, TARGET_NAME);
const TARGET_README = path.join(TARGET_DIR, 'README.md');
const TARGET_DASHBOARD_DIR = path.join(TARGET_DIR, '.claude', 'forge-dashboard');

const FIXTURE_LANGUAGE = /example|prototype|placeholder|nothing (was|is) (created|generated|attached|changed|loaded|sent)|not (yet )?connected|not attached|no file behind|not implemented|simulated/i;

const VIEWS = [
  ['home', '/'], ['projects', '/projects'], ['project-overview', '/project'], ['chat', '/chat'],
  ['mission', '/mission'], ['agents', '/agents'], ['tasks', '/tasks'], ['artifacts', '/artifacts'],
  ['tests', '/tests'], ['files', '/files'], ['activity', '/activity'], ['settings', '/settings'], ['theme', '/theme'],
];

const results = {
  startedAt: new Date().toISOString(),
  targetName: TARGET_NAME,
  targetDir: TARGET_DIR,
  base: BASE,
  phases: {},
  consoleErrors: [],
  consoleWarnings: [],
  failedRequests: [],
  slowNavigations: [],
  screenshots: [],
  fixtureSurvivors: [],
};

function log(...args) { console.log('[wpPart2]', new Date().toISOString(), ...args); }
function flush() { fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2)); }

function shot(session, name) {
  const file = path.join(EVIDENCE_DIR, `${name}.png`);
  return driver.screenshot(session, file).then(() => {
    results.screenshots.push(file);
    log('screenshot', name);
    return file;
  });
}

async function apiFetch(pathAndQuery) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE}${pathAndQuery}`);
    const body = await res.json().catch(() => null);
    return { status: res.status, ok: res.ok, body, ms: Date.now() - t0 };
  } catch (err) {
    return { status: 0, ok: false, error: String(err), ms: Date.now() - t0 };
  }
}

async function timedNavigate(session, url, label) {
  const t0 = Date.now();
  await driver.navigate(session, url);
  const ms = Date.now() - t0;
  if (ms > 3000) {
    results.slowNavigations.push({ label, url, ms, severity: ms > 10000 ? 'HANG' : 'SLOW' });
    log('SLOW/HANG navigation', label, ms + 'ms');
  }
  return ms;
}

/* ---------------------------------------------------------------- DOM helpers */

function mainText(session) {
  return driver.evaluate(session, `(() => { const el = document.querySelector('#fw-main'); return el ? el.innerText.slice(0, 6000) : ''; })()`);
}
function bodyText(session) {
  return driver.evaluate(session, `document.body.innerText.slice(0, 20000)`);
}
function currentPath(session) {
  return driver.evaluate(session, `(() => location.pathname + location.hash)()`);
}
async function collectAllTextSurfaces(session) {
  return driver.evaluate(session, `(() => {
    const out = [];
    out.push({ source: 'body.innerText', text: document.body.innerText || '' });
    document.querySelectorAll('[aria-label]').forEach((el) => { const v = el.getAttribute('aria-label'); if (v) out.push({ source: 'aria-label', text: v, tag: el.tagName.toLowerCase() }); });
    document.querySelectorAll('[title]').forEach((el) => { const v = el.getAttribute('title'); if (v) out.push({ source: 'title', text: v, tag: el.tagName.toLowerCase() }); });
    document.querySelectorAll('[data-label]').forEach((el) => { const v = el.getAttribute('data-label'); if (v) out.push({ source: 'data-label', text: v, tag: el.tagName.toLowerCase() }); });
    document.querySelectorAll('caption').forEach((el) => { out.push({ source: 'caption', text: el.textContent || '' }); });
    return out;
  })()`);
}
async function scanFixtureSurvivors(session, viewName) {
  const surfaces = await collectAllTextSurfaces(session).catch(() => []);
  const found = [];
  for (const surface of surfaces) {
    const text = surface.text || '';
    if (surface.source === 'body.innerText') {
      for (const line of text.split('\n')) {
        if (FIXTURE_LANGUAGE.test(line) && line.trim().length > 0) found.push({ view: viewName, source: surface.source, text: line.trim().slice(0, 200) });
      }
    } else if (FIXTURE_LANGUAGE.test(text)) {
      found.push({ view: viewName, source: surface.source, tag: surface.tag || '', text: text.slice(0, 200) });
    }
  }
  return found;
}

const OVERLAY_SELECTOR = '[role="dialog"], [role="menu"], .fw-command-palette, [cmdk-root], .fw-chat-menu__panel, .fw-account, .fw-topbar__appearance[data-open="true"]';
async function overlayOpen(session) { return driver.evaluate(session, `!!document.querySelector(${JSON.stringify(OVERLAY_SELECTOR)})`).catch(() => false); }
async function dismissOverlays(session) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!(await overlayOpen(session))) return true;
    await driver.pressKey(session, 'Escape');
    await new Promise((r) => setTimeout(r, 150));
  }
  return !(await overlayOpen(session));
}

/* -------------------------------------------------------------- gateway control */

function getGatewayPid() {
  try {
    const out = execSync('powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort 4100 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)"', { encoding: 'utf8' }).trim();
    return out ? Number(out) : null;
  } catch { return null; }
}

async function waitForHealth(timeoutMs, expectDown) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await apiFetch('/api/health').catch(() => ({ ok: false }));
    if (expectDown ? !r.ok : r.ok) return { ok: true, waitedMs: timeoutMs - (deadline - Date.now()) };
    await new Promise((res) => setTimeout(res, 400));
  }
  return { ok: false };
}

/* =================================================================== PHASES */

async function phase0_negativeBaseline(session) {
  log('=== PHASE 0: negative baseline ===');
  const diskExists = fs.existsSync(TARGET_DIR);
  const apiResult = await apiFetch('/api/projects');
  const apiHasIt = apiResult.ok && Array.isArray(apiResult.body?.projects) && apiResult.body.projects.some((p) => p.name === TARGET_NAME);

  await timedNavigate(session, `${BASE}/#/projects`, 'baseline-projects');
  await new Promise((r) => setTimeout(r, 300));
  const uiText = await bodyText(session);
  const uiHasIt = uiText.includes(TARGET_NAME);
  await shot(session, 'phase0-negative-baseline-projects');

  const pass = !diskExists && !apiHasIt && !uiHasIt;
  results.phases.phase0_negativeBaseline = { diskExists, apiHasIt, uiHasIt, pass, apiCount: apiResult.body?.projects?.length ?? null };
  log('phase0 result:', JSON.stringify(results.phases.phase0_negativeBaseline));
  flush();
  return pass;
}

async function phase1_missionViaComposer(session) {
  log('=== PHASE 1: New-chat click test + THE ONE real composer send ===');

  // 1a. Confirm NOT mock mode.
  const convBefore1 = await apiFetch('/api/conversations');
  const execAvail = convBefore1.body?.execution ?? null;
  const mockExcluded = !!execAvail && execAvail.available === true && !/mock/i.test(execAvail.note || '');
  log('execution availability:', JSON.stringify(execAvail), 'mockExcluded:', mockExcluded);

  // 1b. Real "New chat" button click, counted via /api/conversations before/after.
  await timedNavigate(session, `${BASE}/#/`, 'shell-for-new-chat');
  await new Promise((r) => setTimeout(r, 300));
  const countBefore = convBefore1.ok ? convBefore1.body.conversations.length : null;
  const pt = await driver.evaluate(session, `(() => { const b = Array.from(document.querySelectorAll('.fw-sidebar__action')).find(x=>x.textContent.includes('New chat')); if(!b) return null; const r=b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  let newChatToast = null;
  if (pt) {
    await driver.clickXY(session, pt.x, pt.y);
    await new Promise((r) => setTimeout(r, 500));
    newChatToast = await driver.evaluate(session, `(() => { const n=document.querySelectorAll('.fw-toast'); if(!n.length) return null; const l=n[n.length-1]; return {title:l.querySelector('.fw-toast__title')?.textContent?.trim()||'', detail:l.querySelector('.fw-toast__detail')?.textContent?.trim()||''}; })()`);
  }
  await new Promise((r) => setTimeout(r, 400));
  const convAfter1 = await apiFetch('/api/conversations');
  const countAfter = convAfter1.ok ? convAfter1.body.conversations.length : null;
  const urlAfterNewChat = await currentPath(session);
  const newChatReallyCreated = countBefore !== null && countAfter !== null && countAfter === countBefore + 1;
  await shot(session, 'phase1-new-chat-clicked');
  results.phases.phase1_newChatButton = { countBefore, countAfter, newChatReallyCreated, urlAfterNewChat, toast: newChatToast, buttonFound: !!pt };
  log('New chat button:', JSON.stringify(results.phases.phase1_newChatButton));
  flush();

  // 1c. THE ONE real send: type the mission prompt into the now-active conversation's composer.
  const prompt = `Create a new directory at the absolute path ${TARGET_DIR.split('\\').join('/')} if it does not already exist, then inside it create exactly one file named README.md whose plain-English content states that this folder is an automated Forge Command Center end-to-end reality-test artifact (not a real project), created on ${new Date().toISOString().slice(0, 10)} by an automated test. Do not create, modify, or delete any other file or directory.`;

  await timedNavigate(session, `${BASE}/#/chat`, 'chat-for-real-send');
  await new Promise((r) => setTimeout(r, 400));
  const fieldRect = await driver.getRect(session, '.fw-chat-composer__field');
  if (!fieldRect || !fieldRect.visible) {
    results.phases.phase1_realSend = { sent: false, reason: 'composer field not visible' };
    flush();
    return { mockExcluded, sent: false };
  }
  await driver.clickXY(session, fieldRect.x + fieldRect.width / 2, fieldRect.y + fieldRect.height / 2);
  await driver.typeText(session, prompt);
  await new Promise((r) => setTimeout(r, 200));
  const typedValue = await driver.evaluate(session, `document.querySelector('.fw-chat-composer__field')?.value ?? ''`);
  await shot(session, 'phase1-prompt-typed');

  const activeConvId = await driver.evaluate(session, `(() => { try { return window.__ccActiveConversationId || null; } catch(e){ return null; } })()`).catch(() => null);
  log('typed value matches prompt:', typedValue === prompt, 'len', typedValue.length);

  const sendClickAt = Date.now();
  await driver.pressKey(session, 'Enter');
  await new Promise((r) => setTimeout(r, 600));
  const afterSendToast = await driver.evaluate(session, `(() => { const n=document.querySelectorAll('.fw-toast'); if(!n.length) return null; const l=n[n.length-1]; return {title:l.querySelector('.fw-toast__title')?.textContent?.trim()||'', detail:l.querySelector('.fw-toast__detail')?.textContent?.trim()||''}; })()`);
  await shot(session, 'phase1-after-send');

  // Poll GET /api/conversations for the just-updated conversation (most-recently-updated one),
  // then poll its detail for an assistant turn to resolve the pending send.
  let convId = null;
  const listResult = await apiFetch('/api/conversations');
  if (listResult.ok && listResult.body.conversations.length > 0) convId = listResult.body.conversations[0].id; // sorted updated_at desc

  let resolvedTurn = null;
  const deadline = Date.now() + 180000; // 180s cap for the one real claude -p call
  while (Date.now() < deadline && convId) {
    const detail = await apiFetch(`/api/conversations/${encodeURIComponent(convId)}`);
    if (detail.ok && Array.isArray(detail.body.turns)) {
      const assistantTurn = detail.body.turns.slice().reverse().find((t) => t.role === 'assistant');
      if (assistantTurn) { resolvedTurn = assistantTurn; break; }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  const turnWaitMs = Date.now() - sendClickAt;
  await shot(session, 'phase1-mission-resolved-or-timeout');

  results.phases.phase1_realSend = {
    mockExcluded,
    convId,
    typedValueMatches: typedValue === prompt,
    afterSendToast,
    turnWaitMs,
    resolved: !!resolvedTurn,
    assistantTurn: resolvedTurn ? { text: (resolvedTurn.text || '').slice(0, 2000), cost_usd: resolvedTurn.cost_usd, duration_ms: resolvedTurn.duration_ms, stop_reason: resolvedTurn.stop_reason, exit_code: resolvedTurn.exit_code, error: resolvedTurn.error || null } : null,
  };
  log('phase1 real send result:', JSON.stringify(results.phases.phase1_realSend).slice(0, 1200));
  flush();
  return { mockExcluded, sent: true, resolvedTurn, convId };
}

function phase2_groundTruth() {
  log('=== PHASE 2: filesystem ground truth ===');
  const dirExists = fs.existsSync(TARGET_DIR);
  const readmeExists = fs.existsSync(TARGET_README);
  let dirStat = null, readmeStat = null, readmeContent = null;
  if (dirExists) { const s = fs.statSync(TARGET_DIR); dirStat = { mtime: s.mtime.toISOString(), birthtime: s.birthtime.toISOString() }; }
  if (readmeExists) {
    const s = fs.statSync(TARGET_README);
    readmeStat = { mtime: s.mtime.toISOString(), birthtime: s.birthtime.toISOString(), size: s.size };
    readmeContent = fs.readFileSync(TARGET_README, 'utf8').slice(0, 1000);
  }
  let extraEntries = [];
  if (dirExists) { try { extraEntries = fs.readdirSync(TARGET_DIR); } catch { /* ignore */ } }

  results.phases.phase2_groundTruth = { dirExists, readmeExists, dirStat, readmeStat, readmeContentSample: readmeContent, entriesInDir: extraEntries };
  log('phase2 result:', JSON.stringify(results.phases.phase2_groundTruth).slice(0, 800));
  flush();
  return { dirExists, readmeExists };
}

async function phase3_tripleSource(session) {
  log('=== PHASE 3: triple-source at one moment (Phase A expectation: disk YES, API/UI NO) ===');
  const diskExists = fs.existsSync(TARGET_DIR);
  const apiResult = await apiFetch('/api/projects');
  const apiHasIt = apiResult.ok && apiResult.body.projects.some((p) => p.name === TARGET_NAME);
  await timedNavigate(session, `${BASE}/#/projects`, 'triple-source-projects');
  await new Promise((r) => setTimeout(r, 300));
  const uiText = await bodyText(session);
  const uiHasIt = uiText.includes(TARGET_NAME);
  await shot(session, 'phase3-triple-source-projects');

  const expectedPhaseA = diskExists && !apiHasIt && !uiHasIt;
  results.phases.phase3_tripleSource = { capturedAt: new Date().toISOString(), diskExists, apiHasIt, uiHasIt, matchesPhaseAExpectation: expectedPhaseA };
  log('phase3 result:', JSON.stringify(results.phases.phase3_tripleSource));
  flush();
  return expectedPhaseA;
}

async function phase4_addMarkerAndLatency(session) {
  log('=== PHASE 4: add real marker + measure latency to visibility ===');
  fs.mkdirSync(TARGET_DASHBOARD_DIR, { recursive: true });
  const markerCreatedAt = Date.now();
  log('created marker dir:', TARGET_DASHBOARD_DIR);

  await timedNavigate(session, `${BASE}/#/projects`, 'phase4-wait-start');
  const deadline = markerCreatedAt + 100000; // 100s hard cap
  let apiVisibleAt = null, uiVisibleAt = null;
  let lastApiCount = null;
  while (Date.now() < deadline && (apiVisibleAt === null || uiVisibleAt === null)) {
    if (apiVisibleAt === null) {
      const r = await apiFetch('/api/projects');
      lastApiCount = r.body?.projects?.length ?? null;
      if (r.ok && r.body.projects.some((p) => p.name === TARGET_NAME)) apiVisibleAt = Date.now();
    }
    if (uiVisibleAt === null) {
      await driver.evaluate(session, `void 0`).catch(() => {}); // keep session alive
      const uiText = await bodyText(session);
      if (uiText.includes(TARGET_NAME)) uiVisibleAt = Date.now();
      else {
        // force a re-render nudge: re-navigate to the same hash forces the poll's next tick to be observed sooner in some builds, but is otherwise a no-op; skip forcing, just re-check after refresh navigation on final loop only.
      }
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  await shot(session, 'phase4-after-marker-wait');

  const apiLatencyMs = apiVisibleAt ? apiVisibleAt - markerCreatedAt : null;
  const uiLatencyMs = uiVisibleAt ? uiVisibleAt - markerCreatedAt : null;
  const nielsen = uiLatencyMs === null ? 'NEVER (>100s) — DEFECT' : uiLatencyMs <= 1000 ? 'SMOOTH (<=1s)' : uiLatencyMs <= 10000 ? 'ACCEPTABLE (<=10s)' : 'DEFECT (>10s, no progress indicator shown)';

  results.phases.phase4_latency = { markerCreatedAt: new Date(markerCreatedAt).toISOString(), apiLatencyMs, uiLatencyMs, nielsenVerdict: nielsen, lastApiCountSeen: lastApiCount };
  log('phase4 latency result:', JSON.stringify(results.phases.phase4_latency));
  flush();
  return results.phases.phase4_latency;
}

async function phase5_freshness() {
  log('=== PHASE 5: freshness sanity ===');
  const now = Date.now();
  const checks = [];
  for (const [label, p] of [['health', '/api/health'], ['projects', '/api/projects']]) {
    const r = await apiFetch(p);
    if (r.ok && r.body.captured_at) {
      const capturedMs = new Date(r.body.captured_at).getTime();
      const skewMs = capturedMs - now;
      checks.push({ label, captured_at: r.body.captured_at, age_ms: r.body.age_ms, skewMs, futureClock: skewMs > 5000, negativeAge: typeof r.body.age_ms === 'number' && r.body.age_ms < 0 });
    }
  }
  const projectEntry = (await apiFetch('/api/projects')).body?.projects?.find((p) => p.name === TARGET_NAME) ?? null;
  const dirStat = fs.existsSync(TARGET_DIR) ? fs.statSync(TARGET_DIR) : null;
  const allOk = checks.every((c) => !c.futureClock && !c.negativeAge);
  results.phases.phase5_freshness = { checks, allOk, newProjectFoundInRegistry: !!projectEntry, dirMtime: dirStat ? dirStat.mtime.toISOString() : null };
  log('phase5 result:', JSON.stringify(results.phases.phase5_freshness));
  flush();
  return allOk;
}

async function phase6_sseLiveness(session) {
  log('=== PHASE 6: SSE liveness across a real gateway restart ===');
  const pidBefore = getGatewayPid();
  await timedNavigate(session, `${BASE}/#/chat`, 'phase6-chat-before-restart');
  await new Promise((r) => setTimeout(r, 500));
  const sseSnapshotBefore = await driver.evaluate(session, `(() => (window.__sseSnapshot ? window.__sseSnapshot() : 'NO_HOOK'))()`).catch(() => 'ERROR');
  const bannerBefore = await driver.evaluate(session, `(() => { const b = document.querySelector('.fw-conn'); return b ? { status: b.getAttribute('data-status'), text: b.textContent.slice(0,200) } : null; })()`);
  await shot(session, 'phase6-before-restart');

  log('pid before restart:', pidBefore);
  if (!pidBefore) {
    results.phases.phase6_sse = { ok: false, reason: 'could not resolve gateway PID before restart' };
    flush();
    return results.phases.phase6_sse;
  }

  try { execSync(`taskkill /PID ${pidBefore} /T /F`, { stdio: 'ignore' }); } catch (err) { log('taskkill warning:', err.message); }
  const downCheck = await waitForHealth(10000, true);
  log('gateway confirmed down within 10s:', downCheck.ok);

  await new Promise((r) => setTimeout(r, 2000));
  const bannerDuringOutage = await driver.evaluate(session, `(() => { const b = document.querySelector('.fw-conn'); return b ? { status: b.getAttribute('data-status'), text: b.textContent.slice(0,200) } : null; })()`).catch(() => null);
  await shot(session, 'phase6-during-outage');

  // Restart exactly as the process was originally started.
  const child = spawn('node', [GATEWAY_ENTRY], { cwd: GATEWAY_CWD, detached: true, stdio: 'ignore', shell: true });
  child.unref();
  const upCheck = await waitForHealth(20000, false);
  const pidAfter = getGatewayPid();
  log('gateway back up:', upCheck.ok, 'new pid:', pidAfter);

  await new Promise((r) => setTimeout(r, 6000)); // let the health-poll / SSE auto-reconnect cycle observe recovery
  const bannerAfter = await driver.evaluate(session, `(() => { const b = document.querySelector('.fw-conn'); return b ? { status: b.getAttribute('data-status'), text: b.textContent.slice(0,200) } : null; })()`).catch(() => null);
  const sseSnapshotAfter = await driver.evaluate(session, `(() => (window.__sseSnapshot ? window.__sseSnapshot() : 'NO_HOOK'))()`).catch(() => 'ERROR');
  await shot(session, 'phase6-after-restart-recovered');

  const honestOutageShown = bannerDuringOutage !== null && ['DISCONNECTED', 'CONNECTING', 'DEGRADED'].includes(bannerDuringOutage.status);
  const recovered = upCheck.ok && (bannerAfter === null || bannerAfter.status === 'CONNECTING');

  results.phases.phase6_sse = {
    pidBefore, pidAfter, downConfirmed: downCheck.ok, backUpConfirmed: upCheck.ok,
    bannerBefore, bannerDuringOutage, bannerAfter, honestOutageShown, recovered,
    sseSnapshotBefore, sseSnapshotAfter,
  };
  log('phase6 result:', JSON.stringify(results.phases.phase6_sse).slice(0, 1500));
  flush();
  return results.phases.phase6_sse;
}

async function phase7_retestSweep(session) {
  log('=== PHASE 7: clean retest sweep, 13 views + WP-specific checks ===');
  const projectName = 'my project (v2)!';
  for (const [name, route] of VIEWS) {
    const navMs = await timedNavigate(session, `${BASE}/#${route}`, `view-${name}`);
    await new Promise((r) => setTimeout(r, 300));
    const survivors = await scanFixtureSurvivors(session, name);
    if (survivors.length > 0) results.fixtureSurvivors.push(...survivors);
    await shot(session, `view-${name}`);
    log(name, 'navMs', navMs, 'fixtureSurvivors', survivors.length);
  }

  // Settings -> Capabilities: 4 panels (tools/capabilities/mcp/models) with expected real counts.
  await timedNavigate(session, `${BASE}/#/settings`, 'settings-capabilities');
  await new Promise((r) => setTimeout(r, 400));
  const settingsText = await mainText(session);
  await shot(session, 'phase7-settings-capabilities');
  const capCheck = {
    has78Tools: /78/.test(settingsText),
    has134Capabilities: /134/.test(settingsText),
    has8Mcp: /\b8\b/.test(settingsText),
    has7ModelRoles: /\b7\b/.test(settingsText),
    sample: settingsText.slice(0, 1500),
  };

  // Mission Control -> approvals row (10 gates, 0 evaluations, honest not fabricated).
  await timedNavigate(session, `${BASE}/#/mission`, 'mission-approvals');
  await new Promise((r) => setTimeout(r, 400));
  const missionText = await mainText(session);
  await shot(session, 'phase7-mission-approvals');

  // Activity -> recovery panel (3 attempts, 11 docdrift/0 drifted) + checkpoints honest-empty.
  await timedNavigate(session, `${BASE}/#/activity`, 'activity-recovery');
  await new Promise((r) => setTimeout(r, 400));
  const activityText = await mainText(session);
  await shot(session, 'phase7-activity-recovery');

  // Chat -> usage bar honesty.
  await timedNavigate(session, `${BASE}/#/chat`, 'chat-usage-bar');
  await new Promise((r) => setTimeout(r, 400));
  const usageBarText = await driver.evaluate(session, `(() => { const el = document.querySelector('.fw-usage'); return el ? el.innerText.slice(0, 1500) : 'NOT FOUND'; })()`);
  await shot(session, 'phase7-chat-usage-bar');

  // Project overview (default active project = "100 apps") -> placeholder gone, Unclassified honest.
  await timedNavigate(session, `${BASE}/#/project`, 'project-overview-placeholder');
  await new Promise((r) => setTimeout(r, 400));
  const overviewText = await mainText(session);
  await shot(session, 'phase7-project-overview');
  const placeholderGone = !/<one or two lines>/i.test(overviewText);
  const showsUnclassified = /unclassified/i.test(overviewText);

  results.phases.phase7_retest = {
    viewsSwept: VIEWS.length,
    fixtureSurvivorCount: results.fixtureSurvivors.length,
    capabilitiesPanel: capCheck,
    missionApprovalsSample: missionText.slice(0, 1200),
    activityRecoverySample: activityText.slice(0, 1200),
    usageBarText,
    projectOverview: { placeholderGone, showsUnclassified, sample: overviewText.slice(0, 800) },
  };
  log('phase7 result summary:', JSON.stringify({ fixtureSurvivorCount: results.fixtureSurvivors.length, capCheck, placeholderGone, showsUnclassified }));
  flush();
}

/* ========================================================================= main */

async function main() {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpPart2-chrome-'));
  log('TARGET_DIR =', TARGET_DIR);

  log('Launching VISIBLE Chrome, remote-debugging-port', PORT, 'profile', profileDir);
  const chromeProc = driver.launchChrome({ port: PORT, userDataDir: profileDir, startUrl: 'about:blank', width: 1440, height: 900 });

  try {
    await driver.waitForCdp(PORT, 20000);
    const session = await driver.connectToFirstPage(PORT, 20000);
    log('CDP session connected. pid=', chromeProc.pid);

    await session.send('Page.enable');
    await session.send('Runtime.enable');
    await session.send('Network.enable');
    await session.send('Log.enable');

    // Inject the SSE-observability hook + dark-mode pref BEFORE the app's own scripts ever run.
    const SSE_HOOK = `
      (function(){
        try {
          window.__sseLog = [];
          var OrigES = window.EventSource;
          function WrappedES(url, opts) {
            var es = new OrigES(url, opts);
            var rec = { url: String(url), events: [], createdAt: Date.now(), _es: es };
            window.__sseLog.push(rec);
            es.addEventListener('open', function(){ rec.events.push({ t: Date.now(), type: 'open' }); });
            es.addEventListener('error', function(){ rec.events.push({ t: Date.now(), type: 'error', readyState: es.readyState }); });
            es.addEventListener('message', function(e){ rec.events.push({ t: Date.now(), type: 'message', dataLen: (e.data||'').length }); });
            return es;
          }
          WrappedES.prototype = OrigES.prototype;
          WrappedES.CONNECTING = OrigES.CONNECTING; WrappedES.OPEN = OrigES.OPEN; WrappedES.CLOSED = OrigES.CLOSED;
          window.EventSource = WrappedES;
          window.__sseSnapshot = function() { return window.__sseLog.map(function(r){ return { url: r.url, readyState: r._es.readyState, events: r.events.slice(-10) }; }); };
        } catch (e) { /* best-effort observability hook only */ }
      })();
      try { localStorage.setItem('forge.prototype.appearance','dark'); } catch(e) {}
    `;
    await session.send('Page.addScriptToEvaluateOnNewDocument', { source: SSE_HOOK });

    session.on('Runtime.consoleAPICalled', (params) => {
      if (params.type === 'error') results.consoleErrors.push({ text: (params.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 400), ts: Date.now() });
      else if (params.type === 'warning') results.consoleWarnings.push({ text: (params.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300), ts: Date.now() });
    });
    session.on('Log.entryAdded', (params) => { if (params.entry && params.entry.level === 'error') results.consoleErrors.push({ text: `[Log] ${params.entry.text}`.slice(0, 400), ts: Date.now() }); });
    session.on('Network.responseReceived', (params) => { if (params.response.status >= 400) results.failedRequests.push({ url: params.response.url, status: params.response.status, ts: Date.now() }); });
    session.on('Network.loadingFailed', (params) => { results.failedRequests.push({ url: params.requestId, errorText: params.errorText, ts: Date.now() }); });

    await driver.setViewport(session, { width: 1440, height: 900, mobile: false });
    await timedNavigate(session, `${BASE}/#/`, 'initial-load');
    await new Promise((r) => setTimeout(r, 500));

    await phase0_negativeBaseline(session);
    await phase1_missionViaComposer(session);
    phase2_groundTruth();
    await phase3_tripleSource(session);
    await phase4_addMarkerAndLatency(session);
    await phase5_freshness();
    await phase6_sseLiveness(session);
    await dismissOverlays(session).catch(() => {});
    await phase7_retestSweep(session);

    results.finishedAt = new Date().toISOString();
    flush();
    log('ALL PHASES DONE. Results at', RESULTS_PATH);

    session.close();
  } catch (err) {
    results.fatalError = String((err && err.stack) || err);
    flush();
    log('FATAL:', err);
  } finally {
    log('Killing Chrome (pid', chromeProc.pid, ') and its child processes...');
    try { execSync(`taskkill /PID ${chromeProc.pid} /T /F`, { stdio: 'ignore' }); } catch (err) { log('taskkill warning:', err.message); }
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ }
    // Final honesty check: gateway must be left healthy, restarting once more if phase 6 somehow left it down.
    const finalHealth = await waitForHealth(5000, false).catch(() => ({ ok: false }));
    if (!finalHealth.ok) {
      log('Gateway not healthy at script end — starting it one more time.');
      const child = spawn('node', [GATEWAY_ENTRY], { cwd: GATEWAY_CWD, detached: true, stdio: 'ignore', shell: true });
      child.unref();
      const recovered = await waitForHealth(20000, false);
      results.finalGatewayRecovery = recovered;
      flush();
    }
  }
}

main();
