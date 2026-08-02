/**
 * Responsive behaviour across the required review sizes.
 *
 * The rule that actually catches broken layout is simple and unforgiving: the
 * page itself must never scroll horizontally. Wide content (tables, boards, the
 * mission graph, code blocks) has to scroll inside its own container instead.
 *
 * WP7b: waits on `'domcontentloaded'` rather than `'networkidle'` — the
 * gateway integration holds a genuinely long-lived `EventSource` open while a
 * run/conversation is selected, which `networkidle` never resolves against
 * (a documented Playwright limitation for apps with persistent connections).
 * The metrics/visibility checks below still run against the settled DOM.
 */

import { expect, test } from '@playwright/test';

const SIZES = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1280x800', width: 1280, height: 800 },
  { name: '1024x768', width: 1024, height: 768 },
  { name: '768x1024', width: 768, height: 1024 },
  { name: '430x932', width: 430, height: 932 },
  { name: '390x844', width: 390, height: 844 },
  { name: '360x800', width: 360, height: 800 },
];

const ROUTES = [
  '/',
  '/projects',
  '/project',
  '/chat',
  '/mission',
  '/agents',
  '/tasks',
  '/files',
  '/artifacts',
  '/tests',
  '/activity',
  '/settings',
  '/theme',
];

for (const size of SIZES) {
  test.describe(`at ${size.name}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    test('no route overflows the page horizontally', async ({ page }) => {
      const overflowing: string[] = [];

      for (const route of ROUTES) {
        await page.goto(`/#${route}`);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(120);

        const metrics = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          bodyScroll: document.body.scrollWidth,
        }));

        // 1px of rounding slack; anything more is a real layout break.
        if (metrics.scrollWidth > metrics.clientWidth + 1) {
          overflowing.push(
            `${route}: scrollWidth ${metrics.scrollWidth} > clientWidth ${metrics.clientWidth}`,
          );
        }
      }

      expect(overflowing, `horizontal page overflow:\n${overflowing.join('\n')}`).toEqual([]);
    });

    test('the shell renders something on every route', async ({ page }) => {
      for (const route of ROUTES) {
        await page.goto(`/#${route}`);
        await page.waitForLoadState('domcontentloaded');
        await expect(page.locator('#root')).not.toBeEmpty();
        const text = await page.locator('#root').innerText();
        expect(text.trim().length, `${route} rendered an empty shell`).toBeGreaterThan(20);
      }
    });
  });
}

test.describe('mobile navigation', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('the sidebar is reachable as a drawer', async ({ page }) => {
    await page.goto('/#/');
    await page.waitForLoadState('domcontentloaded');

    // Some control must open navigation on mobile; find it by accessible name.
    const opener = page
      .getByRole('button', { name: /menu|navigation|sidebar|open nav/i })
      .first();
    await expect(opener).toBeVisible();
    await opener.click();
    await page.waitForTimeout(250);

    // Once open, the primary destinations must be reachable.
    await expect(page.getByRole('link', { name: /mission control/i }).first()).toBeVisible();
  });
});
