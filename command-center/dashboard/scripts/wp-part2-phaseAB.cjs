#!/usr/bin/env node
/**
 * WP fin-e2e-reality — PART 2, clean Phase A -> Phase B probe (no `claude -p` call).
 *
 * The main run's mission was correctly denied by the CLI's own permission sandbox, so
 * TARGET_DIR was never created by a real composer send, and the main run's whole-body-text UI
 * check was contaminated by the persistent conversation Dock echoing the real (but irrelevant)
 * assistant reply on every route. This script creates a SEPARATE, plain folder+README directly
 * (the tester's own filesystem action — never a second billed `claude -p` call), verifies it is
 * genuinely absent from a SCOPED UI read (`.fw-projects__name` only, not document.body) and the
 * raw API, then adds the same minimal marker and measures a clean, uncontaminated latency.
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

const targetFile = fs.readFileSync(path.join(EVIDENCE_DIR, 'phaseAB-target.txt'), 'utf8').trim().split('\n');
const NAME2 = targetFile[0].trim();
const DIR2 = targetFile[1].trim();
const README2 = path.join(DIR2, 'README.md');
const MARKER2 = path.join(DIR2, '.claude', 'forge-dashboard');

async function apiFetch(p) {
  try { const r = await fetch(`${BASE}${p}`); const b = await r.json().catch(() => null); return { ok: r.ok, status: r.status, body: b }; }
  catch (err) { return { ok: false, error: String(err) }; }
}

function log(...a) { console.log('[phaseAB]', new Date().toISOString(), ...a); }
function shot(session, name) { return driver.screenshot(session, path.join(EVIDENCE_DIR, `${name}.png`)).then(() => log('screenshot', name)); }
function scopedProjectNames(session) {
  return driver.evaluate(session, `Array.from(document.querySelectorAll('.fw-projects__name')).map(el => el.textContent.trim())`);
}

async function main() {
  const out = {};
  const readmeContent = `# Forge E2E Phase A/B probe\n\nCreated directly by the Test Boss (run forge-2026-07-29-cc-finish) to verify the project-registration marker rule in both directions, independent of the composer mission (which was correctly denied by the CLI's own permission sandbox). Not a real project.\n`;

  // Ground truth before anything: folder must not exist yet.
  out.existsBeforeAnything = fs.existsSync(DIR2);

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpPart2-phaseAB-'));
  const chromeProc = driver.launchChrome({ port: PORT, userDataDir: profileDir, startUrl: `${BASE}/#/`, width: 1440, height: 900 });
  try {
    await driver.waitForCdp(PORT, 20000);
    const session = await driver.connectToFirstPage(PORT, 20000);
    await session.send('Page.enable');
    await session.send('Runtime.enable');
    await driver.setViewport(session, { width: 1440, height: 900, mobile: false });
    await driver.navigate(session, `${BASE}/#/projects`);
    await new Promise((r) => setTimeout(r, 500));

    // ---- negative baseline (before creating anything) ----
    const namesBefore = await scopedProjectNames(session);
    const apiBefore = await apiFetch('/api/projects');
    out.negativeBaseline = {
      diskExists: fs.existsSync(DIR2),
      uiHasIt: namesBefore.includes(NAME2),
      apiHasIt: apiBefore.ok && apiBefore.body.projects.some((p) => p.name === NAME2),
      apiCount: apiBefore.body?.projects?.length ?? null,
    };
    await shot(session, 'phaseAB-0-negative-baseline');
    log('negative baseline', JSON.stringify(out.negativeBaseline));

    // ---- create folder + README directly (tester's own fs write, no claude call) ----
    fs.mkdirSync(DIR2, { recursive: true });
    fs.writeFileSync(README2, readmeContent);
    const createdAt = Date.now();
    out.created = { dir: DIR2, readme: README2, dirExists: fs.existsSync(DIR2), readmeExists: fs.existsSync(README2) };
    log('created folder+readme', JSON.stringify(out.created));

    // ---- Phase A: folder exists on disk, no marker yet -> must NOT appear in API/UI ----
    await new Promise((r) => setTimeout(r, 500));
    const namesPhaseA = await scopedProjectNames(session);
    const apiPhaseA = await apiFetch('/api/projects');
    out.phaseA = {
      capturedAt: new Date().toISOString(),
      diskExists: fs.existsSync(DIR2),
      uiHasIt: namesPhaseA.includes(NAME2),
      apiHasIt: apiPhaseA.ok && apiPhaseA.body.projects.some((p) => p.name === NAME2),
    };
    out.phaseA.pass = out.phaseA.diskExists && !out.phaseA.uiHasIt && !out.phaseA.apiHasIt;
    await shot(session, 'phaseAB-1-phaseA-disk-only');
    log('phase A (disk-only, no marker)', JSON.stringify(out.phaseA));

    // ---- Phase B: add the minimal real marker, measure clean latency ----
    fs.mkdirSync(MARKER2, { recursive: true });
    const markerCreatedAt = Date.now();
    log('marker created', MARKER2);

    const deadline = markerCreatedAt + 100000;
    let apiVisibleAt = null, uiVisibleAt = null;
    while (Date.now() < deadline && (apiVisibleAt === null || uiVisibleAt === null)) {
      if (apiVisibleAt === null) {
        const r = await apiFetch('/api/projects');
        if (r.ok && r.body.projects.some((p) => p.name === NAME2)) apiVisibleAt = Date.now();
      }
      if (uiVisibleAt === null) {
        const names = await scopedProjectNames(session);
        if (names.includes(NAME2)) uiVisibleAt = Date.now();
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    await shot(session, 'phaseAB-2-after-marker-visible-or-timeout');
    const apiLatencyMs = apiVisibleAt ? apiVisibleAt - markerCreatedAt : null;
    const uiLatencyMs = uiVisibleAt ? uiVisibleAt - markerCreatedAt : null;
    out.phaseB = {
      markerCreatedAt: new Date(markerCreatedAt).toISOString(),
      apiLatencyMs,
      uiLatencyMs,
      nielsenVerdict: uiLatencyMs === null ? 'NEVER (>100s) — DEFECT' : uiLatencyMs <= 1000 ? 'SMOOTH (<=1s)' : uiLatencyMs <= 10000 ? 'ACCEPTABLE (<=10s)' : 'DEFECT (>10s, no progress indicator)',
    };
    log('phase B latency (clean, scoped)', JSON.stringify(out.phaseB));

    fs.writeFileSync(path.join(EVIDENCE_DIR, 'phaseAB-results.json'), JSON.stringify(out, null, 2));
    session.close();
  } catch (err) {
    out.fatalError = String((err && err.stack) || err);
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'phaseAB-results.json'), JSON.stringify(out, null, 2));
    console.error('FATAL', err);
  } finally {
    try { execSync(`taskkill /PID ${chromeProc.pid} /T /F`, { stdio: 'ignore' }); } catch { /* ignore */ }
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
main();
