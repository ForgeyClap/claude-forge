/**
 * Runtime proof that nothing leaves the machine.
 *
 * The static scan (tests/unit/no-runtime-contact.test.ts) proves the source
 * contains no vendor transport. This proves the running app reaches nothing but
 * LOOPBACK — whatever a dependency might try behind our back.
 *
 * The invariant changed with the connected build. The prototype talked to
 * nothing; the connected UI legitimately opens a WebSocket to the local bridge,
 * which runs on a DIFFERENT loopback port than the page. So the honest guarantee
 * is no longer "only the preview origin" but "only loopback, any port". A request
 * to any non-loopback host — the real thing this test defends against — still
 * fails. Nothing here permits the app to reach the internet.
 *
 * WP7b: `waitForLoadState('networkidle')` was replaced with `'domcontentloaded'`
 * throughout this file. The gateway integration opens a genuinely long-lived
 * `EventSource` (the real events/conversation SSE tail) whenever a run/
 * conversation is selected — a real, working connection, unlike the bridge's
 * WebSocket attempt this file's own header already anticipated. Playwright's
 * own docs name this exact case: `networkidle` never resolves while a
 * streamed response (SSE, or a WebSocket kept truly open) is in flight, so it
 * is "discouraged for tests with long-lived connections". Every assertion
 * below still runs after the DOM is ready; nothing about what is checked —
 * the loopback-only guarantee, the console-error check — changed.
 */

import { expect, test, type Request } from '@playwright/test';

/** Loopback only. The port is free to vary — the page and the bridge differ. */
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

const ROUTES = [
  '#/',
  '#/projects',
  '#/project',
  '#/chat',
  '#/mission',
  '#/agents',
  '#/tasks',
  '#/files',
  '#/artifacts',
  '#/tests',
  '#/activity',
  '#/settings',
  '#/theme',
];

function isExternal(request: Request): boolean {
  const url = request.url();
  if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('about:')) return false;
  if (url.startsWith('ws://') || url.startsWith('wss://')) {
    // A WebSocket to the bridge is expected and allowed — but only on loopback.
    try {
      return !LOOPBACK_HOST.test(new URL(url).host);
    } catch {
      return true;
    }
  }
  try {
    return !LOOPBACK_HOST.test(new URL(url).host);
  } catch {
    return false;
  }
}

test.describe('the prototype contacts nothing', () => {
  test('no request leaves the preview origin while walking every view', async ({ page }) => {
    const external: string[] = [];
    const consoleErrors: string[] = [];

    page.on('request', (request) => {
      if (isExternal(request)) external.push(`${request.method()} ${request.url()}`);
    });
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

    for (const route of ROUTES) {
      await page.goto(`/${route}`);
      await page.waitForLoadState('domcontentloaded');
      // Give any deferred effect (timers, observers) a chance to misbehave.
      await page.waitForTimeout(250);
    }

    expect(external, `the prototype tried to reach:\n${external.join('\n')}`).toEqual([]);
    expect(consoleErrors, `console errors:\n${consoleErrors.join('\n')}`).toEqual([]);
  });

  test('sending a chat message streams locally without any request', async ({ page }) => {
    const external: string[] = [];
    page.on('request', (request) => {
      if (isExternal(request)) external.push(request.url());
    });

    await page.goto('/#/chat');
    await page.waitForLoadState('domcontentloaded');

    const composer = page.getByRole('textbox').last();
    await composer.click();
    await composer.fill('Build a premium booking website for a barbershop.');
    await composer.press('Enter');

    // The reply is revealed from a local string; wait for visible progress.
    await page.waitForTimeout(1500);

    expect(external, `chat triggered network:\n${external.join('\n')}`).toEqual([]);
  });

  test('the built bundle embeds no runtime endpoint', async ({ page }) => {
    await page.goto('/#/');
    const scripts = await page.evaluate(() =>
      Array.from(document.querySelectorAll('script[src]')).map((s) => (s as HTMLScriptElement).src),
    );
    expect(scripts.length).toBeGreaterThan(0);

    for (const src of scripts) {
      const response = await page.request.get(src);
      const body = await response.text();
      for (const forbidden of [
        'api.anthropic.com',
        'api.openai.com',
        'integrate.api.nvidia.com',
        'ANTHROPIC_API_KEY',
      ]) {
        expect(body.includes(forbidden), `bundle ${src} contains ${forbidden}`).toBe(false);
      }
    }
  });

  test('no control anywhere asks for an API key', async ({ page }) => {
    for (const route of ['#/settings', '#/chat', '#/']) {
      await page.goto(`/${route}`);
      await page.waitForLoadState('domcontentloaded');

      await expect(page.locator('input[type="password"]')).toHaveCount(0);

      const text = (await page.locator('body').innerText()).toLowerCase();
      expect(text).not.toContain('enter anthropic api key');
      expect(text).not.toContain('anthropic api key');
    }
  });

  test('settings states the local-session model instead', async ({ page }) => {
    await page.goto('/#/settings');
    await page.waitForLoadState('domcontentloaded');

    // Settings shows one section at a time; the connection copy lives in its own.
    await page
      .getByRole('navigation', { name: /settings sections/i })
      .getByRole('button', { name: /claude code/i })
      .click();

    const text = (await page.locator('body').innerText()).toLowerCase();
    expect(text).toContain('locally authenticated claude code session');
    expect(text).not.toContain('api key');
  });
});
