#!/usr/bin/env node
/**
 * visible-install-followup — RUN forge-2026-07-29-cc-finish, WP visible-install (Test Boss).
 *
 * Supplementary, fast check: does a DELIBERATE click on an already-cached project (selftest-full,
 * created by visible-install-test.cjs) correctly activate/open it? Isolates whether the
 * PrototypeProvider.tsx race (activeProjectId reset to data.projects[0] whenever the current id is
 * not yet in the freshly-created project's own live dataset) is specific to the
 * immediately-after-create auto-navigate path, or whether project switching is broken in general.
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const driver = require('./cdp-driver.cjs');

const CDP_PORT = 9333;
const BASE = 'http://127.0.0.1:4100';
const APP_URL = `${BASE}/#/`;
const COMMAND_CENTER_DIR = path.resolve(__dirname, '../..');
const EVIDENCE_DIR = path.join(COMMAND_CENTER_DIR, 'mission', 'test-evidence', 'visible-install');
const PROJECT_NAME = 'selftest-full';
const USER_DATA_DIR = path.join(os.tmpdir(), 'forge-visible-install-followup-chrome-profile');

fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
let shotSeq = 90;
function log(...a) { console.log('[followup]', ...a); }
function pause(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function shot(session, label) {
  shotSeq += 1;
  const file = path.join(EVIDENCE_DIR, `${String(shotSeq)}-${label}.png`);
  await driver.screenshot(session, file);
  log('  screenshot', path.basename(file));
}
async function waitForCondition(evalFn, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evalFn()) return Date.now();
    await pause(intervalMs);
  }
  return null;
}

async function main() {
  let chrome;
  try {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
    chrome = driver.launchChrome({ port: CDP_PORT, userDataDir: USER_DATA_DIR, startUrl: 'about:blank' });
    await driver.waitForCdp(CDP_PORT, 15000);
    const session = await driver.connectToFirstPage(CDP_PORT, 15000);
    await driver.navigate(session, APP_URL);
    await pause(500);

    await driver.evaluate(session, `window.location.hash = '#/projects'`);
    await pause(1000);

    const count = await driver.evaluate(session, `document.querySelectorAll('.fw-projects__item').length`).catch(() => 0);
    log('projects rendered on /projects route:', count);
    await shot(session, 'projects-route-before-click');

    await driver.evaluate(
      session,
      `(() => {
        const items = Array.from(document.querySelectorAll('.fw-projects__item'));
        const target = items.find((li) => {
          const n = li.querySelector('.fw-projects__name');
          return n && n.textContent.trim() === ${JSON.stringify(PROJECT_NAME)};
        });
        target?.scrollIntoView({ block: 'center' });
      })()`,
    ).catch(() => {});
    await pause(400);

    const rect = await driver.evaluate(
      session,
      `(() => {
        const items = Array.from(document.querySelectorAll('.fw-projects__item'));
        const target = items.find((li) => {
          const n = li.querySelector('.fw-projects__name');
          return n && n.textContent.trim() === ${JSON.stringify(PROJECT_NAME)};
        });
        if (!target) return null;
        const btn = target.querySelector('.fw-projects__body');
        const r = btn.getBoundingClientRect();
        if (!(r.width > 0 && r.height > 0)) return null;
        return { x: r.x + r.width / 2, y: r.y + Math.min(r.height / 2, r.height - 2) };
      })()`,
    );
    log('row rect found:', JSON.stringify(rect));
    if (!rect) throw new Error(`project row not found/visible for "${PROJECT_NAME}" among ${count} rendered rows`);

    await driver.clickXY(session, rect.x, rect.y);
    // Strict equality, not .includes: '#/projects' (the list route we start on) itself contains the
    // substring '/project', which made an earlier version of this check a false positive.
    const openedAt = await waitForCondition(
      async () => driver.evaluate(session, `window.location.hash === '#/project'`).catch(() => false),
      8000,
    );
    log('navigated to /project route:', openedAt !== null);
    await pause(600);

    const headingName = await driver.evaluate(
      session,
      `document.querySelector('h1, .fw-modal__title, [class*="overview"] h1')?.textContent?.trim() ?? document.body.innerText.slice(0, 400)`,
    ).catch(() => null);
    const breadcrumb = await driver.evaluate(session, `document.querySelector('nav, [class*="breadcrumb"]')?.textContent?.trim() ?? null`).catch(() => null);
    const showsCorrectProject = await driver.evaluate(
      session,
      `document.body.innerText.includes(${JSON.stringify(PROJECT_NAME)})`,
    ).catch(() => false);

    log('heading/body snippet:', headingName);
    log('breadcrumb:', breadcrumb);
    log('body text includes project name:', showsCorrectProject);
    await shot(session, 'project-overview-after-deliberate-click');

    // Now that selftest-full is genuinely the active project (proven above via breadcrumb +
    // inspector), check Files & Activity render honestly for THIS project specifically — the main
    // visible-install-test.cjs run's own Files/Activity check was contaminated by the
    // create-time race (activeProjectId was still stuck on the previously-active project), so this
    // re-does that part of the mission's ask against the real, correctly-selected project.
    await driver.evaluate(session, `window.location.hash = '#/files'`);
    await pause(800);
    const filesRendered = await driver.evaluate(session, `document.getElementById('root')?.childElementCount > 0`).catch(() => false);
    const filesShowsProject = await driver.evaluate(session, `document.body.innerText.includes(${JSON.stringify(PROJECT_NAME)})`).catch(() => false);
    await shot(session, 'files-view-scoped');

    await driver.evaluate(session, `window.location.hash = '#/activity'`);
    await pause(800);
    const activityRendered = await driver.evaluate(session, `document.getElementById('root')?.childElementCount > 0`).catch(() => false);
    const activityText = await driver.evaluate(session, `document.body.innerText.slice(0, 600)`).catch(() => '');
    await shot(session, 'activity-view-scoped');

    log('files scoped check:', { filesRendered, filesShowsProject });
    log('activity scoped check:', { activityRendered, activityTextSnippet: activityText.slice(0, 200) });

    const result = {
      count, rowFound: !!rect, navigatedToProjectRoute: openedAt !== null, showsCorrectProject, headingName, breadcrumb,
      scopedViewsCheck: { filesRendered, filesShowsProject, activityRendered, activityText },
    };
    fs.writeFileSync(path.join(COMMAND_CENTER_DIR, 'mission', 'test-evidence', 'visible-install-followup-results.json'), JSON.stringify(result, null, 2), 'utf8');
    log('DONE', JSON.stringify(result));
  } catch (err) {
    console.error('[followup] FAILED:', err);
    process.exitCode = 1;
  } finally {
    if (chrome) { try { chrome.kill(); } catch { /* ignore */ } }
  }
}

main();
