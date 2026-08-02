#!/usr/bin/env node
/**
 * shots-complete — WP shots-complete (definition-of-done point 8).
 *
 * Drives the ALREADY-RUNNING gateway on :4100 (never starts/stops it) with a
 * REAL, VISIBLE, non-headless Chrome window over CDP (see cdp-driver.cjs —
 * Escape-only overlay dismissal, never a blind coordinate click; see that
 * file's and wpB-clicktest.cjs's fix notes). Screenshots all 13 routes at
 * 1440/768/375 in TWO real project states (a project with real runs, and a
 * project with zero runs) so the matrix is 13 x 3 x 2 = 78 real captures.
 *
 * Project selection is done through the REAL UI (a real click on the
 * `.fw-projects__body` row in /projects — never a URL param, because this
 * app's activeProjectId lives only in in-memory reducer state, not in the
 * URL or localStorage). Because a full Page.navigate() would remount the
 * whole app and reset activeProjectId back to the gateway's own
 * auto-select-first-project default, route changes AFTER the project is
 * selected use an in-app hash change (`window.location.hash = ...`) so the
 * HashRouter navigates without remounting the store.
 *
 * Usage: node scripts/shots-complete-capture.cjs   (run from command-center/dashboard)
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execSync } = require('node:child_process');
const driver = require('./cdp-driver.cjs');

const PORT = 9333;
const BASE = 'http://127.0.0.1:4100';
const EVIDENCE_DIR = path.resolve(__dirname, '../../mission/test-evidence');
const SHOT_DIR = path.join(EVIDENCE_DIR, 'shots-complete');
const RESULTS_PATH = path.join(EVIDENCE_DIR, 'shots-complete-results.json');

const ROUTES = [
  ['home', '/'],
  ['projects', '/projects'],
  ['project-overview', '/project'],
  ['chat', '/chat'],
  ['mission', '/mission'],
  ['agents', '/agents'],
  ['tasks', '/tasks'],
  ['artifacts', '/artifacts'],
  ['tests', '/tests'],
  ['files', '/files'],
  ['activity', '/activity'],
  ['settings', '/settings'],
  ['theme', '/theme'],
];

const VIEWPORTS = [
  ['1440', 1440, 900, false],
  ['768', 768, 1024, false],
  ['375', 375, 812, true],
];

// Chosen with live evidence (see PROJECT_EVIDENCE below), not on a hunch.
const STATES = [
  { key: 'gevuld', name: 'my-forge-project' },
  { key: 'leeg', name: 'forge-system-public' },
];

const OVERLAY_SELECTOR =
  '[role="dialog"], [role="menu"], .fw-command-palette, [cmdk-root], .fw-chat-menu__panel, .fw-account, .fw-topbar__appearance[data-open="true"]';

const results = {
  startedAt: new Date().toISOString(),
  base: BASE,
  states: STATES,
  projectEvidence: {},
  shots: [],
  overflow: [],
  extraShots: [],
  errors: [],
};

function log(...args) {
  console.log('[shots-complete]', ...args);
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

async function overlayOpen(session) {
  return driver
    .evaluate(session, `!!document.querySelector(${JSON.stringify(OVERLAY_SELECTOR)})`)
    .catch(() => false);
}

async function dismissOverlays(session) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!(await overlayOpen(session))) return true;
    await driver.pressKey(session, 'Escape');
    await new Promise((r) => setTimeout(r, 150));
  }
  return !(await overlayOpen(session));
}

async function hashNavigate(session, routePath) {
  await driver.evaluate(session, `window.location.hash = ${JSON.stringify('#' + routePath)}`);
  await new Promise((r) => setTimeout(r, 550));
}

async function freezeAnimations(session) {
  await driver
    .evaluate(
      session,
      `(() => {
        const s = document.createElement('style');
        s.id = 'shots-complete-freeze';
        s.textContent = '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important;caret-color:transparent!important;}';
        document.head.appendChild(s);
      })()`,
    )
    .catch(() => {});
}

async function selectProjectByName(session, name) {
  await hashNavigate(session, '/projects');
  const deadline = Date.now() + 15000;
  let count = 0;
  while (Date.now() < deadline) {
    count = await driver.evaluate(session, `document.querySelectorAll('.fw-projects__item').length`).catch(() => 0);
    if (count > 0) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (count === 0) throw new Error('no .fw-projects__item rendered within 15s');

  const rect = await driver.evaluate(
    session,
    `(() => {
      const items = Array.from(document.querySelectorAll('.fw-projects__item'));
      const target = items.find((li) => {
        const n = li.querySelector('.fw-projects__name');
        return n && n.textContent.trim() === ${JSON.stringify(name)};
      });
      if (!target) return null;
      const btn = target.querySelector('.fw-projects__body');
      const r = btn.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + Math.min(r.height / 2, r.height - 2) };
    })()`,
  );
  if (!rect) throw new Error(`project row not found for "${name}" among ${count} rendered rows`);

  await driver.clickXY(session, rect.x, rect.y);
  await new Promise((r) => setTimeout(r, 500));

  const activeInfo = await driver.evaluate(
    session,
    `(() => {
      const items = Array.from(document.querySelectorAll('.fw-projects__item'));
      const activeLi = items.find((li) => li.getAttribute('data-active') === 'true');
      if (!activeLi) return null;
      const name = activeLi.querySelector('.fw-projects__name')?.textContent.trim() ?? null;
      const counts = Array.from(activeLi.querySelectorAll('.fw-projects__count .fg-machine, .fw-projects__count')).map((el) => el.textContent.trim());
      return { name, counts };
    })()`,
  );
  return activeInfo;
}

async function measureOverflow(session) {
  return driver.evaluate(
    session,
    `(() => { const d = document.documentElement; return { scrollWidth: d.scrollWidth, clientWidth: d.clientWidth, overflowX: d.scrollWidth > d.clientWidth + 2 }; })()`,
  );
}

function shotPath(routeName, width, stateKey) {
  return path.join(SHOT_DIR, `${routeName}-${width}-${stateKey}.png`);
}

async function shot(session, file) {
  await driver.screenshot(session, file);
  return file;
}

/* ------------------------------------------------------------------- main */

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-complete-chrome-'));

  // Live evidence for the two-state choice, captured into the results file.
  for (const { key, name } of STATES) {
    const runs = await apiJson(`/api/runs?project=${encodeURIComponent(name)}`);
    results.projectEvidence[key] = {
      name,
      runsApiOk: runs.ok,
      runCount: Array.isArray(runs.body?.runs) ? runs.body.runs.length : null,
      runIds: Array.isArray(runs.body?.runs) ? runs.body.runs.map((r) => r.run_id) : [],
    };
    log('evidence', key, name, '-> runCount', results.projectEvidence[key].runCount);
  }

  log('Launching VISIBLE Chrome, remote-debugging-port', PORT, 'profile', profileDir);
  const chromeProc = driver.launchChrome({
    port: PORT,
    userDataDir: profileDir,
    startUrl: `${BASE}/#/`,
    width: 1440,
    height: 900,
  });

  try {
    await driver.waitForCdp(PORT, 20000);
    const session = await driver.connectToFirstPage(PORT, 20000);
    log('CDP session connected, pid=', chromeProc.pid);

    await session.send('Page.enable');
    await session.send('Runtime.enable');

    for (const { key: stateKey, name: projectName } of STATES) {
      log(`=== STATE ${stateKey} (${projectName}) ===`);

      // Full reload once per state: clean slate, avoids any bleed from the
      // previous state's in-memory selection.
      await driver.setViewport(session, { width: 1440, height: 900, mobile: false });
      await driver.navigate(session, `${BASE}/#/projects`);
      await freezeAnimations(session);
      await dismissOverlays(session);

      const activeInfo = await selectProjectByName(session, projectName);
      if (!activeInfo || activeInfo.name !== projectName) {
        results.errors.push({ state: stateKey, error: `selection verify failed: got ${JSON.stringify(activeInfo)}` });
        log('  !! selection verify FAILED for', projectName, activeInfo);
      } else {
        log('  selection verified active:', activeInfo.name, 'counts row:', activeInfo.counts);
        results.projectEvidence[stateKey].onScreenCountsRow = activeInfo.counts;
      }

      for (const [widthLabel, width, height, mobile] of VIEWPORTS) {
        await driver.setViewport(session, { width, height, mobile });
        for (const [routeName, routePath] of ROUTES) {
          await dismissOverlays(session);
          await hashNavigate(session, routePath);
          await freezeAnimations(session);
          await new Promise((r) => setTimeout(r, 250));

          const file = shotPath(routeName, widthLabel, stateKey);
          await shot(session, file);
          const overflow = await measureOverflow(session);
          results.shots.push({ route: routeName, width: widthLabel, state: stateKey, file });
          results.overflow.push({ route: routeName, width: widthLabel, state: stateKey, ...overflow });
          log(`  shot ${routeName} @ ${widthLabel} [${stateKey}]`, overflow.overflowX ? 'OVERFLOW-X!' : 'ok');
        }
      }

      // Bonus targeted capture: Settings default tab is "Appearance", not
      // "Capabilities" — the new Capabilities panel needs a real tab click to
      // become visible. Captured extra, NOT counted in the 78-shot matrix.
      await driver.setViewport(session, { width: 1440, height: 900, mobile: false });
      await hashNavigate(session, '/settings');
      await dismissOverlays(session);
      const tabRect = await driver.evaluate(
        session,
        `(() => {
          const tabs = Array.from(document.querySelectorAll('[role="tab"], button'));
          const target = tabs.find((el) => /capabilities/i.test(el.textContent || ''));
          if (!target) return null;
          const r = target.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        })()`,
      );
      if (tabRect) {
        await driver.clickXY(session, tabRect.x, tabRect.y);
        await new Promise((r) => setTimeout(r, 500));
        const file = path.join(SHOT_DIR, `EXTRA-settings-capabilities-tab-1440-${stateKey}.png`);
        await shot(session, file);
        results.extraShots.push({ label: 'settings-capabilities-tab', state: stateKey, file });
        log('  extra shot: settings capabilities tab,', stateKey);
      } else {
        results.errors.push({ state: stateKey, error: 'capabilities tab control not found for extra shot' });
        log('  !! capabilities tab control not found (extra shot skipped)');
      }
    }

    results.finishedAt = new Date().toISOString();
    fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
    log('Results written to', RESULTS_PATH);
    log('Total base shots:', results.shots.length, '/ 78. Extra shots:', results.extraShots.length);

    session.close();
  } finally {
    log('Killing Chrome (pid', chromeProc.pid, ') and its child processes...');
    try {
      execSync(`taskkill /PID ${chromeProc.pid} /T /F`, { stdio: 'ignore' });
    } catch (err) {
      log('taskkill warning:', err.message);
    }
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

main().catch((err) => {
  console.error('[shots-complete] FATAL:', err);
  fs.writeFileSync(
    RESULTS_PATH,
    JSON.stringify({ ...results, fatalError: String((err && err.stack) || err) }, null, 2),
  );
  process.exit(1);
});
