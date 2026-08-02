/**
 * @-file mentions over the ACTIVE project's real working tree (test-e2e-composer,
 * forge-2026-07-29-cc-finish).
 *
 * Covers real, previously-unit-tested-only behaviour (`mention-files.ts`) end to end in a real
 * browser against the real gateway: typing `@query` fetches this project's real files via
 * `GET /api/files` (through `crawlProjectFiles`), ranks them, and inserting a suggestion writes the
 * file's real repo-relative path into the draft. No conversation is created and no message is ever
 * sent — the mention popover works from the composer's very first render, before any Send.
 */

import { expect, test } from '@playwright/test';
import { openSandboxProject } from './live-gateway-helpers';

test.describe('composer @-file mentions', () => {
  test.beforeEach(async ({ page }) => {
    await openSandboxProject(page);
    await page.goto('/#/chat');
    await page.waitForLoadState('domcontentloaded');
  });

  test('suggests a real project file for a matching query and inserts its real path', async ({ page }) => {
    const composer = page.getByRole('textbox').last();
    await composer.click();
    await composer.fill('@CLAUDE');

    const panel = page.locator('.fw-chat-composer__suggest-panel').first();
    await expect(panel).toBeVisible();
    const option = panel.getByRole('option', { name: /CLAUDE\.md/ }).first();
    await expect(option, 'the sandbox project\'s real CLAUDE.md was not offered as a mention suggestion').toBeVisible({
      timeout: 10_000,
    });

    await option.click();
    await expect(composer).toHaveValue(/^@CLAUDE\.md /);
    // The popover closes once a real selection is applied.
    await expect(panel).toHaveCount(0);
  });

  test('shows an honest no-match message for a query that matches no real file', async ({ page }) => {
    const composer = page.getByRole('textbox').last();
    await composer.click();
    await composer.fill('@zzzznotarealfile123');

    const panel = page.locator('.fw-chat-composer__suggest-panel').first();
    await expect(panel).toContainText('No files match "@zzzznotarealfile123".');
    // An honest empty result never fabricates an option row.
    await expect(panel.getByRole('option')).toHaveCount(0);
  });

  test('Escape closes the popover without altering or sending the draft', async ({ page }) => {
    const composer = page.getByRole('textbox').last();
    await composer.click();
    await composer.fill('@CLAUDE');
    await expect(page.locator('.fw-chat-composer__suggest-panel').first()).toBeVisible();

    await composer.press('Escape');
    await expect(page.locator('.fw-chat-composer__suggest-panel')).toHaveCount(0);
    // The raw, unfinished token is still sitting in the draft — Escape only closes the popover.
    await expect(composer).toHaveValue('@CLAUDE');
  });
});
