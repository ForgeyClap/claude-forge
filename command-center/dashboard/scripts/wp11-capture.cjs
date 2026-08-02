#!/usr/bin/env node
/**
 * WP11 — pixel-equivalence capture.
 *
 * Drives the already-installed @playwright/test `chromium` directly against
 * the ALREADY-RUNNING gateway on :4100 (same convention as
 * scripts/wp11-a11y-audit.cjs — never starts its own server) and screenshots
 * the 9 principal views at dark 1440x900 and dark 375x812, using the same
 * animation-freeze technique as tests/e2e/screenshots.spec.ts's `settle()`,
 * so two captures of unchanged content are pixel-for-pixel reproducible.
 *
 * Usage: node scripts/wp11-capture.cjs <out-dir> <suffix>
 *   e.g. node scripts/wp11-capture.cjs ../mission/visual-review before
 */

'use strict';

const path = require('node:path');
const { chromium } = require('@playwright/test');

const BASE_URL = 'http://127.0.0.1:4100';

const VIEWS = [
  ['home', '/'],
  ['chat', '/chat'],
  ['projects', '/projects'],
  ['mission', '/mission'],
  ['agents', '/agents'],
  ['files', '/files'],
  ['tests', '/tests'],
  ['activity', '/activity'],
  ['settings', '/settings'],
];

const VIEWPORTS = [
  ['1440', { width: 1440, height: 900 }],
  ['375', { width: 375, height: 812 }],
];

async function settle(page) {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        caret-color: transparent !important;
      }
      .fw-caret, .fw-pulse { opacity: 1 !important; animation: none !important; }
    `,
  });
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await page.waitForTimeout(400);
}

async function main() {
  const outDir = process.argv[2];
  const suffix = process.argv[3];
  if (!outDir || !suffix) {
    console.error('usage: node scripts/wp11-capture.cjs <out-dir> <suffix>');
    process.exit(1);
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--hide-scrollbars', '--force-prefers-reduced-motion'],
  });

  try {
    for (const [vpName, viewport] of VIEWPORTS) {
      for (const [viewName, route] of VIEWS) {
        const page = await browser.newPage({ viewport });
        await page.addInitScript(() => {
          try {
            localStorage.setItem('forge.prototype.appearance', 'dark');
          } catch {
            /* ignore */
          }
        });
        await page.goto(`${BASE_URL}/#${route}`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#root:not(:empty)', { timeout: 10_000 });
        await settle(page);
        const file = path.join(outDir, `WP11-${viewName}-dark-${vpName}-${suffix}.png`);
        await page.screenshot({ path: file, fullPage: false });
        console.log('captured', file);
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('wp11-capture failed:', err);
  process.exit(1);
});
