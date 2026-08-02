/**
 * REAL-SEND — the one deliberately non-mocked chat round trip (WP7c).
 *
 * Lives OUTSIDE `tests/e2e/` on purpose: the default `playwright.config.ts`
 * only ever picks up `./tests/e2e`, so this spec is NEVER swept into the
 * always-mocked default suite by accident. It only runs via its own config:
 *
 *   npm run test:e2e:real-send
 *
 * That command WILL spend real, billable `claude` CLI usage if a real CLI is
 * resolvable on this machine — see `playwright.real-send.config.ts`'s header
 * for the full rationale and requirements. Do not wire this into any
 * automated hook, CI job, or the default `npm run test:e2e` script.
 */

import { expect, test } from '@playwright/test';

const MARKER_TEXT = 'Reply with exactly: WP7C-E2E-OK';

test.describe('one real claude round trip, run only on explicit opt-in', () => {
  test('sending the literal marker text produces a real assistant reply', async ({ page }) => {
    await page.goto('/#/chat');
    await page.waitForLoadState('domcontentloaded');

    const composer = page.getByRole('textbox').last();
    await composer.click();
    await composer.fill(MARKER_TEXT);
    await composer.press('Enter');

    // A real `claude -p` round trip takes real wall-clock time — generous,
    // deterministic wait rather than a tight timeout tuned for a mock.
    await expect(page.getByText(/WP7C-E2E-OK/i)).toBeVisible({ timeout: 45_000 });
  });
});
