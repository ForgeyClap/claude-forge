/**
 * Deleting a conversation, with real confirmation (test-e2e-composer, forge-2026-07-29-cc-finish).
 *
 * `ConfirmDeleteConversationDialog` is shared by the chat header's Trash2 button and the sidebar's
 * per-row Trash2 button — this spec drives it from the chat header (`ChatView.tsx`'s own
 * `handleDeleteClick`) and proves the REAL round trip: Cancel truly keeps the conversation, Delete
 * truly removes it server-side via `DELETE /api/conversations/:id`.
 *
 * Every assertion here checks the conversation's existence through a direct, unauthenticated
 * `GET /api/conversations/:id` read (`conversationExists`) rather than trusting what the UI happens
 * to display next — see `startNewChat`'s own header (`live-gateway-helpers.ts`) for the real
 * reconciliation-effect race this suite's dry run found and worked around: it already forces the
 * header onto the exact conversation this test creates before returning, but every later existence
 * check still goes straight to the gateway rather than re-trusting the DOM a second time.
 *
 * SERIAL, NOT PARALLEL: both tests here create+delete a real conversation against the SAME shared,
 * externally-live sandbox project — serializing them removes any chance of one test's row search
 * (top-5-by-recency in the sidebar) losing a race to the other's concurrent creation.
 */

import { expect, test } from '@playwright/test';
import { cleanupConversation, conversationExists, openSandboxProject, startNewChat } from './live-gateway-helpers';

test.describe.configure({ mode: 'serial' });

test.describe('deleting a conversation', () => {
  let createdId: string | null = null;

  test.beforeEach(async ({ page }) => {
    createdId = null;
    await openSandboxProject(page);
  });

  test.afterEach(async ({ page }) => {
    await cleanupConversation(page, createdId);
  });

  test('opening the confirm dialog and cancelling keeps the conversation for real', async ({ page }) => {
    createdId = await startNewChat(page);

    await page.getByRole('button', { name: 'Delete conversation' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Permanently deletes');
    await expect(dialog).toContainText('This cannot be undone.');

    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);

    expect(
      await conversationExists(page, createdId),
      'the conversation was gone from the gateway after Cancel — Cancel must never delete anything',
    ).toBe(true);
  });

  test('confirming delete really removes the conversation server-side', async ({ page }) => {
    createdId = await startNewChat(page);
    const idToDelete = createdId;

    expect(await conversationExists(page, idToDelete)).toBe(true);

    await page.getByRole('button', { name: 'Delete conversation' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // No failure toast — a real refusal would surface as "Delete failed" (see
    // `ConfirmDeleteConversationDialog.tsx`'s own `handleConfirm`).
    await expect(page.getByText('Delete failed')).toHaveCount(0);

    await expect
      .poll(async () => conversationExists(page, idToDelete), {
        message: 'GET /api/conversations/:id still resolved the deleted conversation',
        timeout: 10_000,
      })
      .toBe(false);

    // A second delete of the same, already-gone id is refused rather than silently "succeeding"
    // again — real proof this was a genuine removal, not a client-side-only hide.
    const secondDelete = await page.request.delete(`/api/conversations/${encodeURIComponent(idToDelete)}`, {
      headers: { 'x-cc-exec-token': (await page.locator('meta[name="cc-exec-token"]').getAttribute('content')) ?? '' },
    });
    expect(secondDelete.ok(), 'deleting an already-deleted conversation id unexpectedly succeeded again').toBe(false);

    createdId = null; // already gone — afterEach cleanup has nothing left to do
  });
});
