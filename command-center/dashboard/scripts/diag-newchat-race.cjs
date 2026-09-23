#!/usr/bin/env node
/**
 * diag-newchat-race — targeted follow-up diagnostic (Test Boss, run forge-2026-07-29-cc-finish).
 *
 * The main full-control-test.cjs run observed a real attachment landing in an OLD, pre-existing
 * conversation (c-ms62a09z-568e55ec, created over an hour earlier) instead of the brand-new
 * conversation "New chat" had just created — even though the app DID navigate to /chat and a fresh,
 * genuinely-empty conversation file was confirmed to exist on disk at the right timestamp. This
 * script isolates just the race: click New chat, then sample the visible active-conversation id
 * (the ChatView heading, `.fw-chat-title` or similar) every ~200ms for a few seconds to see whether
 * it starts as the new id and then flips to an old one.
 *
 * Never sends a message. Kills Chrome itself when done.
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execSync } = require('node:child_process');
const driver = require('./cdp-driver.cjs');

const PORT = 9334; // different port than full-control-test.cjs, in case of overlap
const BASE = 'http://127.0.0.1:4100';
const PROJECT = 'my project (v2)!';

function pause(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function hashNavigate(session, routePath) {
  await driver.evaluate(session, `window.location.hash = ${JSON.stringify('#' + routePath)}`);
  await pause(500);
}

async function main() {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-newchat-chrome-'));
  const chromeProc = driver.launchChrome({ port: PORT, userDataDir: profileDir, startUrl: `${BASE}/#/`, width: 1280, height: 800 });
  try {
    await driver.waitForCdp(PORT, 20000);
    const session = await driver.connectToFirstPage(PORT, 20000);
    await session.send('Page.enable');
    await session.send('Runtime.enable');
    await driver.navigate(session, `${BASE}/#/`);
    await pause(800);

    // select project via Projects view
    await hashNavigate(session, '/projects');
    const rect = await driver.evaluate(session, `(() => {
      const items = Array.from(document.querySelectorAll('.fw-projects__item'));
      const target = items.find((li) => li.querySelector('.fw-projects__name')?.textContent.trim() === ${JSON.stringify(PROJECT)});
      if (!target) return null;
      const btn = target.querySelector('.fw-projects__body');
      const r = btn.getBoundingClientRect();
      return { x: r.x + r.width/2, y: r.y + Math.min(r.height/2, r.height-2) };
    })()`);
    if (!rect) throw new Error('project row not found');
    await driver.clickXY(session, rect.x, rect.y);
    await pause(600);

    console.log('[diag] clicking New chat...');
    const clickAt = Date.now();
    const btnRect = await driver.evaluate(session, `(() => {
      const btn = document.querySelector('.fw-sidebar__actions .fw-button--ghost');
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      return { x: r.x + r.width/2, y: r.y + r.height/2 };
    })()`);
    if (!btnRect) throw new Error('New chat button not found');
    await driver.clickXY(session, btnRect.x, btnRect.y);

    const samples = [];
    for (let i = 0; i < 20; i++) {
      const info = await driver.evaluate(session, `(() => {
        const mainTitle = document.querySelector('.fw-chat__title')?.textContent.trim() ?? null;
        const inspectorId = document.querySelector('.fw-inspector, [class*="inspector"]')?.textContent.match(/c-ms[a-z0-9-]+/)?.[0] ?? null;
        return { hash: window.location.hash, mainTitle, inspectorId };
      })()`).catch(() => null);
      samples.push({ tMs: Date.now() - clickAt, hash: info?.hash, mainTitle: info?.mainTitle, inspectorId: info?.inspectorId });
      await pause(200);
    }

    console.log('[diag] samples:');
    for (const s of samples) console.log(`  t=+${s.tMs}ms hash=${s.hash} mainTitle=${s.mainTitle} inspectorId=${s.inspectorId}`);

    const titleBeforeAttach = await driver.evaluate(session, `document.querySelector('.fw-chat__title')?.textContent.trim() ?? null`);
    console.log('[diag] title right before attach:', titleBeforeAttach);

    const inputCountBefore = await driver.evaluate(session, `document.querySelectorAll('input[type=\"file\"]').length`);
    console.log('[diag] input[type=file] count in DOM:', inputCountBefore);

    // Mirror full-control-test.cjs's exact attach technique.
    const testFile = path.join(os.tmpdir(), 'diag-attach-test.txt');
    fs.writeFileSync(testFile, 'diag attach test file\n');
    const doc = await session.send('DOM.getDocument', { depth: -1, pierce: true });
    const { nodeId } = await session.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type="file"]' });
    console.log('[diag] resolved input nodeId:', nodeId);
    await session.send('DOM.setFileInputFiles', { files: [testFile], nodeId });
    await pause(1000);

    const titleAfterAttach = await driver.evaluate(session, `document.querySelector('.fw-chat__title')?.textContent.trim() ?? null`);
    const chipText = await driver.evaluate(session, `document.querySelector('.fw-chat-composer__attachment-name')?.textContent.trim() ?? null`);
    console.log('[diag] title after attach:', titleAfterAttach, '| chip:', chipText);

    // Check disk immediately.
    await pause(500);
    const attachmentsRoot = path.resolve(__dirname, '../.data/attachments');
    let landedIn = null;
    if (fs.existsSync(attachmentsRoot)) {
      for (const convDir of fs.readdirSync(attachmentsRoot)) {
        const convPath = path.join(attachmentsRoot, convDir);
        if (!fs.statSync(convPath).isDirectory()) continue;
        for (const f of fs.readdirSync(convPath)) {
          if (f.includes('diag-attach-test')) landedIn = convDir;
        }
      }
    }
    console.log('[diag] real upload landed in conversation folder:', landedIn);
    console.log('[diag] expected (main title conv id):', titleAfterAttach);
    console.log('[diag] MATCH:', landedIn === titleAfterAttach);

    fs.writeFileSync(
      path.resolve(__dirname, '../../mission/test-evidence/diag-newchat-race.json'),
      JSON.stringify({ project: PROJECT, samples, titleBeforeAttach, inputCountBefore, titleAfterAttach, chipText, landedIn, match: landedIn === titleAfterAttach }, null, 2),
    );

    session.close();
  } finally {
    try { execSync(`taskkill /PID ${chromeProc.pid} /T /F`, { stdio: 'ignore' }); } catch {}
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
  }
}

main().catch((err) => { console.error('[diag] FATAL', err); process.exitCode = 1; });
