/**
 * `/`-slash commands really change the composer's send-mode/effort/auto-plan state
 * (test-e2e-composer, forge-2026-07-29-cc-finish).
 *
 * Covers `slash-commands.ts` end to end: every command here calls a REAL setter (`setSendMode`,
 * `setEffortChoice`, `setAutoPlan`) — this spec proves the visible, real result (the mode
 * radiogroup's `aria-checked`, the effort trigger's label, the Auto-plan switch, the Bypass warning
 * copy), not just that the popover renders. No conversation is created and no message is ever sent.
 */

import { expect, test } from '@playwright/test';
import { openSandboxProject } from './live-gateway-helpers';

test.describe('composer /-slash commands', () => {
  test.beforeEach(async ({ page }) => {
    await openSandboxProject(page);
    await page.goto('/#/chat');
    await page.waitForLoadState('domcontentloaded');
    // Every test starts from a fresh browser context (Playwright's default), so localStorage — and
    // therefore the mode/effort picker — is genuinely at its documented default here: Bypass
    // (feat-forge-preamble — a project with no persisted choice yet defaults to full permission,
    // see `mode-storage.ts`'s own doc comment), no effort, Auto-plan off. Asserted once so a future
    // change to that default is caught honestly rather than this spec silently assuming it.
    await expect(page.locator('.fw-chat-composer__mode').getByRole('radio', { name: 'Bypass' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  test('/plan really switches the send mode to Plan', async ({ page }) => {
    const composer = page.getByRole('textbox').last();
    const modeGroup = page.locator('.fw-chat-composer__mode');

    await composer.click();
    await composer.fill('/pla');
    const panel = page.locator('.fw-chat-composer__suggest-panel').first();
    await expect(panel.getByRole('option', { name: '/plan' })).toBeVisible();
    await composer.press('Enter');

    await expect(modeGroup.getByRole('radio', { name: 'Plan' })).toHaveAttribute('aria-checked', 'true');
    // The fresh-context default (Bypass, feat-forge-preamble) is really no longer selected.
    await expect(modeGroup.getByRole('radio', { name: 'Bypass' })).toHaveAttribute('aria-checked', 'false');
    // The command's own trigger text never lingers in the draft as though it were about to be sent.
    await expect(composer).toHaveValue('');
  });

  test('/bypass really switches to Bypass mode and shows the real write-access warning', async ({ page }) => {
    const composer = page.getByRole('textbox').last();
    const modeGroup = page.locator('.fw-chat-composer__mode');

    await composer.click();
    await composer.fill('/bypass');
    await composer.press('Enter');

    await expect(modeGroup.getByRole('radio', { name: 'Bypass' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByText(/skips the approval prompts/i)).toBeVisible();
    await expect(page.getByText(/voert uit zonder goedkeuringsvragen/i)).toBeVisible();

    // /execute switches straight back and the warning copy really disappears with it.
    await composer.fill('/execute');
    await composer.press('Enter');
    await expect(modeGroup.getByRole('radio', { name: 'Execute' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByText(/voert uit zonder goedkeuringsvragen/i)).toHaveCount(0);
  });

  test('/effort-high really changes the effort trigger label', async ({ page }) => {
    const composer = page.getByRole('textbox').last();
    const effortTrigger = page.locator('.fw-chat-composer__labelled-trigger');

    await expect(effortTrigger).toHaveText('Default');
    await composer.click();
    await composer.fill('/effort-high');
    await composer.press('Enter');

    await expect(effortTrigger).toHaveText('High');
  });

  test('/auto-plan really toggles the Auto-plan switch', async ({ page }) => {
    const composer = page.getByRole('textbox').last();
    const autoPlanSwitch = page.getByRole('switch', { name: 'Auto-plan' });

    await expect(autoPlanSwitch).toHaveAttribute('aria-checked', 'false');
    await composer.click();
    await composer.fill('/auto-plan');
    await composer.press('Enter');
    await expect(autoPlanSwitch).toHaveAttribute('aria-checked', 'true');

    await composer.click();
    await composer.fill('/auto-plan');
    await composer.press('Enter');
    await expect(autoPlanSwitch).toHaveAttribute('aria-checked', 'false');
  });

  test('an unmatched slash query shows an honest no-match message', async ({ page }) => {
    const composer = page.getByRole('textbox').last();
    await composer.click();
    await composer.fill('/zzznotacommand');

    const panel = page.locator('.fw-chat-composer__suggest-panel').first();
    await expect(panel).toContainText('No matching command.');
    await expect(panel.getByRole('option')).toHaveCount(0);
  });
});
