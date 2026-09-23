#!/usr/bin/env node
/**
 * visible-install-test — RUN forge-2026-07-29-cc-finish, WP visible-install (Test Boss).
 *
 * Drives the ALREADY-RUNNING gateway on :4100 (never started/stopped/restarted here) with a REAL,
 * VISIBLE (never headless) Chrome window over CDP (see cdp-driver.cjs). Exercises the complete
 * "New project" experience end-to-end: click -> "Project created" toast -> background Forge
 * install -> exactly one terminal toast ("Forge installed"/"Forge install failed") -> triple
 * verification (disk, install-status API, UI list) -> opening the project and a light render
 * check on Files/Activity. Writes real screenshots + a JSON results dump under
 * mission/test-evidence/visible-install/ for VISIBLE-INSTALL-report.md to cite.
 *
 * Usage: node scripts/visible-install-test.cjs   (run from command-center/dashboard)
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const driver = require('./cdp-driver.cjs');

const CDP_PORT = 9333;
const BASE = 'http://127.0.0.1:4100';
// Same-origin on purpose: the gateway serves the built dashboard/dist SPA directly on :4100
// (server.mjs's own serveStatic()) so the app's fetches to /api/* stay same-origin — no CORS
// response headers are ever sent (verified by reading server.mjs), so a page loaded from a
// different origin (e.g. the separate Vite :5173 dev server) gets "Failed to fetch" on every
// API call. Matches the exact URL every existing test script in this folder navigates to
// (full-control-test.cjs, shots-complete-capture.cjs, wpB-clicktest.cjs: `${BASE}/#/`).
const APP_URL = `${BASE}/#/`;
const COMMAND_CENTER_DIR = path.resolve(__dirname, '../..');
const EVIDENCE_DIR = path.join(COMMAND_CENTER_DIR, 'mission', 'test-evidence', 'visible-install');
const RESULTS_PATH = path.join(COMMAND_CENTER_DIR, 'mission', 'test-evidence', 'visible-install-results.json');
const PROJECT_NAME = 'selftest-full';
const PROJECTS_ROOT = path.join(os.homedir(), 'Documents', 'ForgeProjects');
const PROJECT_PATH = path.join(PROJECTS_ROOT, PROJECT_NAME);
const DOCTOR_PATH = path.join(PROJECT_PATH, '.claude', 'forge-bin', 'forge-doctor.cjs');
const USER_DATA_DIR = path.join(os.tmpdir(), 'forge-visible-install-chrome-profile');

fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

let shotSeq = 0;
const consoleErrors = [];

function log(...args) {
  console.log('[visible-install]', ...args);
}

function pause(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function shot(session, label) {
  shotSeq += 1;
  const file = path.join(EVIDENCE_DIR, `${String(shotSeq).padStart(2, '0')}-${label}.png`);
  await driver.screenshot(session, file);
  log('  screenshot', path.basename(file));
  return file;
}

async function apiJson(pathAndQuery) {
  try {
    const res = await fetch(`${BASE}${pathAndQuery}`);
    const body = await res.json().catch(() => null);
    return { status: res.status, ok: res.ok, body };
  } catch (err) {
    return { status: 0, ok: false, error: String(err) };
  }
}

async function hashNavigate(session, routePath) {
  await driver.evaluate(session, `window.location.hash = ${JSON.stringify('#' + routePath)}`);
  await pause(700);
}

async function waitForCondition(evalFn, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evalFn()) return Date.now();
    await pause(intervalMs);
  }
  return null;
}

async function toastTitles(session) {
  return driver
    .evaluate(session, `Array.from(document.querySelectorAll('.fw-toast__title')).map((el) => el.textContent.trim())`)
    .catch(() => []);
}

async function clickSelectorUnique(session, selector, label) {
  const result = await driver.clickSelector(session, selector);
  if (!result.ok) throw new Error(`click failed for ${label} (${selector}): ${result.reason}`);
  return result;
}

async function main() {
  const results = {
    startedAt: new Date().toISOString(),
    project: PROJECT_NAME,
    base: BASE,
    evidenceDir: EVIDENCE_DIR,
    steps: {},
    toastTimeline: [],
    errors: [],
  };

  // Pre-flight: refuse to run if the target project name already exists (owner asked for a
  // clean "New project" click-through, not a reuse path).
  if (fs.existsSync(PROJECT_PATH)) {
    console.error(`refusing to run: ${PROJECT_PATH} already exists — this test needs a fresh name`);
    process.exit(1);
  }

  let chrome;
  try {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
    chrome = driver.launchChrome({ port: CDP_PORT, userDataDir: USER_DATA_DIR, startUrl: 'about:blank' });
    await driver.waitForCdp(CDP_PORT, 15000);
    const session = await driver.connectToFirstPage(CDP_PORT, 15000);
    await session.send('Runtime.enable', {});
    session.on('Runtime.consoleAPICalled', (params) => {
      if (params.type === 'error') {
        consoleErrors.push({ t: new Date().toISOString(), text: (params.args || []).map((a) => a.value ?? a.description ?? '').join(' ') });
      }
    });

    log('navigating to', APP_URL);
    await driver.navigate(session, APP_URL);
    await pause(500);

    // Make sure the sidebar is expanded so the labelled "New project" button is visible.
    const collapsed = await driver.evaluate(session, `document.querySelector('.fw-sidebar')?.getAttribute('data-collapsed') === 'true'`);
    if (collapsed) {
      await clickSelectorUnique(session, '.fw-sidebar__collapse', 'sidebar expand toggle');
      await pause(400);
    }

    await shot(session, 'initial-sidebar');

    // Baseline: confirm the target project is NOT yet in the live API list.
    const before = await apiJson('/api/projects');
    const baselinePresent = before.ok && Array.isArray(before.body?.projects) && before.body.projects.some((p) => p.name === PROJECT_NAME);
    results.steps.baseline = { apiOk: before.ok, baselinePresent };
    log('baseline: project present before creation?', baselinePresent);

    // ---- 1. New project ----
    await clickSelectorUnique(session, '.fw-sidebar__actions .fw-button--primary', 'New project button');
    const dialogOpenAt = await waitForCondition(
      async () => driver.evaluate(session, `!!document.querySelector('[role="dialog"] .fw-modal__title')`).catch(() => false),
      8000,
    );
    results.steps.dialogOpened = dialogOpenAt !== null;
    if (!results.steps.dialogOpened) throw new Error('New project dialog did not open');
    await shot(session, 'dialog-open');

    await clickSelectorUnique(session, '[role="dialog"] input', 'name field');
    await pause(150);
    await driver.typeText(session, PROJECT_NAME);
    await pause(300);
    const typedValue = await driver.evaluate(session, `document.querySelector('[role="dialog"] input')?.value`);
    results.steps.typedValueMatches = typedValue === PROJECT_NAME;
    log('typed value:', typedValue, '(matches:', results.steps.typedValueMatches, ')');
    await shot(session, 'name-typed');

    // ---- 2. Click Create, measure from here ----
    const t0 = Date.now();
    await clickSelectorUnique(session, '[role="dialog"] .fw-button--primary', 'Create button');

    // Watch for the "Project created" installing toast.
    const installingToastAt = await waitForCondition(
      async () => (await toastTitles(session)).includes('Project created'),
      8000,
      150,
    );
    results.steps.installingToastSeen = installingToastAt !== null;
    results.steps.installingToastLatencyMs = installingToastAt !== null ? installingToastAt - t0 : null;
    log('installing toast seen:', results.steps.installingToastSeen, 'after', results.steps.installingToastLatencyMs, 'ms');
    if (installingToastAt !== null) {
      results.toastTimeline.push({ t: new Date(installingToastAt).toISOString(), titles: await toastTitles(session) });
      await shot(session, 'toast-installing');
    }

    // Confirm the project shows up in the sidebar list.
    const uiListAt = await waitForCondition(
      async () =>
        driver.evaluate(
          session,
          `Array.from(document.querySelectorAll('.fw-prow__name')).some((el) => el.textContent.trim() === ${JSON.stringify(PROJECT_NAME)})`,
        ).catch(() => false),
      15000,
      300,
    );
    results.steps.projectInSidebarList = uiListAt !== null;
    results.steps.projectInSidebarListLatencyMs = uiListAt !== null ? uiListAt - t0 : null;
    log('project appears in sidebar list:', results.steps.projectInSidebarList, 'after', results.steps.projectInSidebarListLatencyMs, 'ms');
    await shot(session, 'project-in-list');

    // ---- 3. Wait (at deliberate pace) for the ONE terminal toast, screenshotting periodically ----
    const TERMINAL_TIMEOUT_MS = 4 * 60_000; // generous vs. the ~2min the mission expects
    const PERIODIC_SHOT_MS = 20_000;
    let lastPeriodicShot = Date.now();
    let terminalToastAt = null;
    let terminalToastTitle = null;
    const deadline = Date.now() + TERMINAL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const titles = await toastTitles(session);
      if (titles.length) results.toastTimeline.push({ t: new Date().toISOString(), titles });
      const terminal = titles.find((t) => t === 'Forge installed' || t === 'Forge install failed');
      if (terminal && terminalToastAt === null) {
        terminalToastAt = Date.now();
        terminalToastTitle = terminal;
        await shot(session, 'toast-terminal');
        log('TERMINAL TOAST:', terminal, 'after', ((terminalToastAt - t0) / 1000).toFixed(1), 's');
        break;
      }
      if (Date.now() - lastPeriodicShot >= PERIODIC_SHOT_MS) {
        lastPeriodicShot = Date.now();
        await shot(session, `waiting-${Math.round((Date.now() - t0) / 1000)}s`);
      }
      await pause(1000);
    }
    results.steps.terminalToastSeen = terminalToastAt !== null;
    results.steps.terminalToastTitle = terminalToastTitle;
    results.steps.durationSeconds = terminalToastAt !== null ? (terminalToastAt - t0) / 1000 : null;

    // Watch a further 10s to confirm the terminal toast does not fire a SECOND time (duplicate push).
    let duplicateTerminalToast = false;
    if (terminalToastAt !== null) {
      let sawGoneOnce = false;
      const extraDeadline = Date.now() + 10_000;
      while (Date.now() < extraDeadline) {
        const titles = await toastTitles(session);
        const present = titles.includes(terminalToastTitle);
        if (!present) sawGoneOnce = true;
        if (sawGoneOnce && present) { duplicateTerminalToast = true; break; }
        await pause(500);
      }
    }
    results.steps.duplicateTerminalToast = duplicateTerminalToast;

    if (!results.steps.terminalToastSeen) {
      await shot(session, 'terminal-toast-timeout');
    }

    // ---- 4. Triple verification ----
    const doctorExists = fs.existsSync(DOCTOR_PATH);
    const installStatus = await apiJson(`/api/projects/install-status?name=${encodeURIComponent(PROJECT_NAME)}`);
    await hashNavigate(session, '/projects');
    const uiListShowsProject = await driver.evaluate(
      session,
      `Array.from(document.querySelectorAll('.fw-projects__name')).some((el) => el.textContent.trim() === ${JSON.stringify(PROJECT_NAME)})`,
    ).catch(() => false);
    await shot(session, 'projects-view-list');

    results.steps.tripleCheck = {
      doctorFileExists: doctorExists,
      doctorPath: DOCTOR_PATH,
      installStatusApi: installStatus.ok ? installStatus.body : installStatus,
      installStatusIsInstalled: installStatus.ok && installStatus.body && installStatus.body.state === 'installed',
      uiListShowsProject,
    };
    log('triple check:', JSON.stringify(results.steps.tripleCheck));

    // ---- 5. Open the project + light render check on Files / Activity ----
    // The app already auto-activated + navigated to /project on creation; re-navigate explicitly
    // so this check is independent of that auto-navigate behaviour.
    await driver.evaluate(session, `window.location.hash = '#/'`).catch(() => {});
    await pause(300);
    const projectRowRect = await driver.evaluate(
      session,
      `(() => {
        const items = Array.from(document.querySelectorAll('.fw-prow'));
        const target = items.find((li) => {
          const n = li.querySelector('.fw-prow__name');
          return n && n.textContent.trim() === ${JSON.stringify(PROJECT_NAME)};
        });
        if (!target) return null;
        const link = target.querySelector('.fw-prow__main');
        const r = link.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + Math.min(r.height / 2, r.height - 2) };
      })()`,
    );
    let projectOverviewOpened = false;
    if (projectRowRect) {
      await driver.clickXY(session, projectRowRect.x, projectRowRect.y);
      await pause(600);
      projectOverviewOpened = await driver.evaluate(session, `window.location.hash.includes('/project')`).catch(() => false);
    }
    results.steps.projectOverviewOpened = projectOverviewOpened;
    await shot(session, 'project-overview');

    await hashNavigate(session, '/files');
    const filesRendered = await driver.evaluate(session, `document.getElementById('root')?.childElementCount > 0`).catch(() => false);
    const filesBodyLength = await driver.evaluate(session, `document.body.innerText.length`).catch(() => 0);
    await shot(session, 'files-view');

    await hashNavigate(session, '/activity');
    const activityRendered = await driver.evaluate(session, `document.getElementById('root')?.childElementCount > 0`).catch(() => false);
    const activityBodyLength = await driver.evaluate(session, `document.body.innerText.length`).catch(() => 0);
    await shot(session, 'activity-view');

    results.steps.viewsRenderCheck = {
      filesRendered,
      filesBodyLength,
      activityRendered,
      activityBodyLength,
    };
    log('views render check:', JSON.stringify(results.steps.viewsRenderCheck));

    results.consoleErrors = consoleErrors;
    results.finishedAt = new Date().toISOString();

    fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2), 'utf8');
    log('results written to', RESULTS_PATH);
  } catch (err) {
    results.errors.push(String(err && err.stack ? err.stack : err));
    results.consoleErrors = consoleErrors;
    fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2), 'utf8');
    console.error('[visible-install] FAILED:', err);
    process.exitCode = 1;
  } finally {
    if (chrome) {
      try { chrome.kill(); } catch { /* ignore */ }
    }
  }
}

main();
