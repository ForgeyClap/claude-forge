/**
 * The screenshot deliverables.
 *
 * Real captures of the running prototype, written to artifacts/screenshots/.
 * Run: npm run shots      (then: node scripts/build-gallery.cjs)
 *
 * WP7b: `open()` waits on `'domcontentloaded'`, not `'networkidle'` — the
 * gateway integration holds a genuinely long-lived `EventSource` open while a
 * run/conversation is selected, which `networkidle` never resolves against.
 * The explicit `#root` non-empty check plus `settle()`'s own wait already
 * guarantee the capture happens after real content has rendered.
 */

import { expect, test, type Page } from '@playwright/test';

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };
const OUT = 'artifacts/screenshots';

/** Freeze the interface so a capture is byte-stable between runs. */
async function settle(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        caret-color: transparent !important;
      }
      /* the streaming caret and any status pulse must not blink mid-capture */
      .fw-caret, .fw-pulse { opacity: 1 !important; animation: none !important; }
    `,
  });
  await page.evaluate(() => document.fonts?.ready);
  await page.waitForTimeout(350);
}

async function open(page: Page, route: string, theme: 'dark' | 'light'): Promise<void> {
  await page.addInitScript((t) => {
    localStorage.setItem('forge.prototype.appearance', t as string);
  }, theme);
  await page.goto(`/#${route}`);
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator('#root')).not.toBeEmpty();
  await settle(page);
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
}

/* ----------------------------------------------------------------- dark */

test.describe('dark theme', () => {
  test.use({ viewport: DESKTOP });

  const desktopShots: [string, string, string][] = [
    ['01', '/', 'home-desktop'],
    ['02', '/chat', 'chat-desktop'],
    ['03', '/project', 'project-overview-desktop'],
    ['04', '/mission', 'mission-control-desktop'],
    ['05', '/agents', 'agents-desktop'],
    ['06', '/tasks', 'tasks-desktop'],
    ['07', '/tests', 'tests-and-proof-desktop'],
    ['10', '/settings', 'settings-desktop'],
  ];

  for (const [n, route, name] of desktopShots) {
    test(`${n} ${name}`, async ({ page }) => {
      await open(page, route, 'dark');
      await shot(page, `${n}-dark-${name}`);
    });
  }

  test('11 local claude code status placeholder', async ({ page }) => {
    await open(page, '/settings', 'dark');
    // The Claude Code section is one of the settings sections; select it.
    await page
      .getByRole('navigation', { name: /settings sections/i })
      .getByRole('button', { name: /claude code/i })
      .click();
    await settle(page);
    await shot(page, '11-dark-claude-code-status');
  });
});

test.describe('dark theme, mobile', () => {
  test.use({ viewport: MOBILE, isMobile: true, hasTouch: true });

  test('08 chat mobile', async ({ page }) => {
    await open(page, '/chat', 'dark');
    await shot(page, '08-dark-chat-mobile');
  });

  test('09 mission control mobile', async ({ page }) => {
    await open(page, '/mission', 'dark');
    await shot(page, '09-dark-mission-control-mobile');
  });
});

/* ---------------------------------------------------------------- light */

test.describe('light theme', () => {
  test.use({ viewport: DESKTOP });

  const lightShots: [string, string, string][] = [
    ['12', '/', 'home-desktop'],
    ['13', '/chat', 'chat-desktop'],
    ['14', '/project', 'project-overview-desktop'],
    ['15', '/mission', 'mission-control-desktop'],
    ['16', '/agents', 'agents-desktop'],
    ['18', '/settings', 'settings-desktop'],
  ];

  for (const [n, route, name] of lightShots) {
    test(`${n} ${name}`, async ({ page }) => {
      await open(page, route, 'light');
      await shot(page, `${n}-light-${name}`);
    });
  }
});

test.describe('light theme, mobile', () => {
  test.use({ viewport: MOBILE, isMobile: true, hasTouch: true });

  test('17 chat mobile', async ({ page }) => {
    await open(page, '/chat', 'light');
    await shot(page, '17-light-chat-mobile');
  });
});

/* ------------------------------------------------------------- showcase */

test.describe('theme showcase', () => {
  test.use({ viewport: DESKTOP });

  test('19 theme showcase dark', async ({ page }) => {
    await open(page, '/theme', 'dark');
    await page.screenshot({ path: `${OUT}/19-dark-theme-showcase.png`, fullPage: true });
  });

  test('20 theme showcase light', async ({ page }) => {
    await open(page, '/theme', 'light');
    await page.screenshot({ path: `${OUT}/20-light-theme-showcase.png`, fullPage: true });
  });
});
