#!/usr/bin/env node
/**
 * WP fin-e2e-reality — PART 2 follow-up (targeted, no real claude call).
 *
 * The main wp-part2-reality.cjs run navigated Settings via URL hash only, which lands on the
 * default "Appearance" tab — it never clicked into the "Capabilities" sub-tab, so the 78/134/8/7
 * assertions were never actually exercised. It also read Activity/Recovery while the active
 * project defaulted to "100 apps" (a project with no recovery ledger), not "my project (v2)!"
 * (the project the retest's expected numbers — 3 attempts, 11 docdrift/0 drifted — belong to).
 * This is a pure UI-navigation + screenshot follow-up: switches the active project, clicks real
 * tabs, screenshots. Zero `claude -p` calls (none of this touches the composer).
 */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execSync } = require('node:child_process');
const driver = require('./cdp-driver.cjs');

const PORT = 9333;
const BASE = 'http://127.0.0.1:4100';
const EVIDENCE_DIR = path.resolve(__dirname, '../../mission/test-evidence/part2');

function log(...a) { console.log('[followup]', new Date().toISOString(), ...a); }
function shot(session, name) {
  const file = path.join(EVIDENCE_DIR, `${name}.png`);
  return driver.screenshot(session, file).then(() => { log('screenshot', name); return file; });
}
function mainText(session) {
  return driver.evaluate(session, `(() => { const el = document.querySelector('#fw-main'); return el ? el.innerText.slice(0, 6000) : ''; })()`);
}

async function main() {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpPart2-followup-chrome-'));
  const chromeProc = driver.launchChrome({ port: PORT, userDataDir: profileDir, startUrl: `${BASE}/#/`, width: 1440, height: 900 });
  const out = {};
  try {
    await driver.waitForCdp(PORT, 20000);
    const session = await driver.connectToFirstPage(PORT, 20000);
    await session.send('Page.enable');
    await session.send('Runtime.enable');
    await driver.setViewport(session, { width: 1440, height: 900, mobile: false });
    await driver.navigate(session, `${BASE}/#/`);
    await new Promise((r) => setTimeout(r, 500));

    // Switch active project to "my project (v2)!" via the sidebar's Recent Projects row.
    const pt = await driver.evaluate(session, `(() => { const items = Array.from(document.querySelectorAll('.fw-sidebar__recent-item, .fw-sidebar [data-project-name], .fw-sidebar a, .fw-sidebar button')); const el = items.find(x => (x.textContent||'').includes('my project (v2)!')); if(!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`);
    if (pt) {
      await driver.clickXY(session, pt.x, pt.y);
      await new Promise((r) => setTimeout(r, 500));
    }
    const breadcrumbAfterSwitch = await driver.evaluate(session, `(() => { const b = document.querySelector('.fw-topbar, header'); return b ? b.innerText.slice(0,150) : ''; })()`).catch(() => '');
    out.projectSwitchClickFound = !!pt;
    out.breadcrumbAfterSwitch = breadcrumbAfterSwitch;
    await shot(session, 'followup-0-after-project-switch');

    // Settings -> Capabilities tab (real click, not just the hash route).
    await driver.navigate(session, `${BASE}/#/settings`);
    await new Promise((r) => setTimeout(r, 400));
    const capPt = await driver.evaluate(session, `(() => { const items = Array.from(document.querySelectorAll('.fw-settings__nav-item')); const el = items.find(x => (x.textContent||'').includes('Capabilities')); if(!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`);
    if (capPt) {
      await driver.clickXY(session, capPt.x, capPt.y);
      await new Promise((r) => setTimeout(r, 500));
    }
    out.capabilitiesTabFound = !!capPt;
    const capText = await mainText(session);
    out.capabilitiesText = capText;
    out.has78Tools = /\b78\b/.test(capText);
    out.has134Capabilities = /\b134\b/.test(capText);
    out.has8Servers = /\b8\b/.test(capText);
    out.has7Roles = (capText.match(/role/gi) || []).length;
    await shot(session, 'followup-1-settings-capabilities-tab');

    // Activity, now scoped to "my project (v2)!".
    await driver.navigate(session, `${BASE}/#/activity`);
    await new Promise((r) => setTimeout(r, 500));
    const activityText = await mainText(session);
    out.activityText = activityText;
    out.hasThreeAttempts = /\b3\b.*attempt|recovery/i.test(activityText);
    out.hasElevenDocdrift = /\b11\b/.test(activityText);
    await shot(session, 'followup-2-activity-recovery-correct-project');

    fs.writeFileSync(path.join(EVIDENCE_DIR, 'followup-results.json'), JSON.stringify(out, null, 2));
    log('done');
    session.close();
  } catch (err) {
    console.error('FATAL', err);
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'followup-results.json'), JSON.stringify({ ...out, fatalError: String(err && err.stack || err) }, null, 2));
  } finally {
    try { execSync(`taskkill /PID ${chromeProc.pid} /T /F`, { stdio: 'ignore' }); } catch { /* ignore */ }
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
main();
