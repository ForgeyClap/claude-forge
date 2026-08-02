/**
 * The message queue really sends a second message once the first run finishes
 * (test-e2e-composer, forge-2026-07-29-cc-finish).
 *
 * This is the ONE spec in the added coverage that requires a genuinely active run (a message typed
 * while a run is active must be QUEUED, not attempted — see `message-queue.ts`'s own header), so it
 * is also the one spec that can spend a real, billable `claude` CLI round trip when it runs against a
 * real (non-mocked) gateway — TWO, in fact: the queue only proves anything once the queued message is
 * seen to really flush and really produce its own real reply. Both turns run in Plan mode (no file
 * writes possible) with a minimal, single-sentence instruction, exactly as this WP's own governance
 * asks for. Against a MOCKED gateway (`CC_EXEC_MOCK=1`, the default `playwright.config.ts` suite) this
 * spends nothing and the mock's own echo still exercises the identical queue mechanics.
 *
 * Every wait below is a real, polled Playwright expectation tied to a genuine signal (the Stop/Send
 * button swap, the queue list's own content, the assistant reply's own marker text) — never a fixed
 * sleep standing in for "probably done by now".
 *
 * REAL FINDING from this WP's own dry run: the SAME reconciliation race `startNewChat` already
 * guards against (`live-gateway-helpers.ts`'s own header) also hits this implicit create-on-send
 * path — with real, concurrent activity elsewhere on this shared gateway (an unrelated conversation
 * in another project getting its own real run started at nearly the same moment), the chat panel
 * silently swapped to that UNRELATED conversation right after Send, and the composer's own local
 * queue state kept rendering underneath it. This spec therefore captures the real id from the
 * `POST /api/conversations` response (never the DOM) and explicitly force-activates it
 * (`forceActivateConversation`) before doing anything that could otherwise land on the wrong
 * conversation — queuing a message, or reading a reply.
 */

import { expect, test } from '@playwright/test';
import { cleanupConversation, forceActivateConversation, openSandboxProject } from './live-gateway-helpers';

// Two real, sequential model round trips (plus real process/network latency) comfortably exceed the
// project's default 30s per-test timeout.
test.setTimeout(180_000);

const MARKER_1 = 'FORGE-E2E-QUEUE-1';
const MARKER_2 = 'FORGE-E2E-QUEUE-2';
const PROMPT_1 = `Do not read or write any files. Simply reply with exactly this text and nothing else: ${MARKER_1}`;
const PROMPT_2 = `Do not read or write any files. Simply reply with exactly this text and nothing else: ${MARKER_2}`;

test.describe('composer message queue (real run)', () => {
  let createdId: string | null = null;

  test.afterEach(async ({ page }) => {
    await cleanupConversation(page, createdId);
  });

  test('a message sent while a run is active is queued, then really sent once the run finishes', async ({ page }) => {
    await openSandboxProject(page);
    await page.goto('/#/chat');
    await page.waitForLoadState('domcontentloaded');

    // Plan mode for BOTH turns: the gateway's own exec bridge structurally refuses file writes in
    // this mode, regardless of what either prompt asks for — the real safety net this spec leans on
    // rather than trusting the prompt text alone.
    await page.locator('.fw-chat-composer__mode').getByRole('radio', { name: 'Plan' }).click();

    const composer = page.getByRole('textbox').last();
    const sendButton = page.getByRole('button', { name: 'Send', exact: true });
    const queueButton = page.getByRole('button', { name: 'Queue message' });
    const stopButton = page.getByRole('button', { name: 'Stop', exact: true });

    await composer.click();
    await composer.fill(PROMPT_1);

    // The real id straight from the create response — never the DOM (see this file's own header).
    const [createResponse] = await Promise.all([
      page.waitForResponse(
        (res) => res.request().method() === 'POST' && res.url().endsWith('/api/conversations'),
        { timeout: 15_000 },
      ),
      sendButton.click(),
    ]);
    expect(createResponse.ok(), `POST /api/conversations failed: HTTP ${createResponse.status()}`).toBe(true);
    const createBody = (await createResponse.json()) as { conversation?: { id?: string } };
    const conversationId = createBody.conversation?.id;
    expect(conversationId, 'POST /api/conversations did not return a real conversation id').toBeTruthy();
    createdId = conversationId as string;

    // Real signal that a run is now active — never a fixed sleep. Checked BEFORE force-activating
    // below: the run itself starts immediately on the real conversation id regardless of which
    // conversation the panel is currently (possibly wrongly) displaying.
    await expect(queueButton, 'the composer never switched to its streaming (Queue/Stop) state after Send').toBeVisible({
      timeout: 30_000,
    });
    await expect(stopButton).toBeVisible();

    // Force the panel onto the conversation THIS test actually created — see this file's own header
    // for the real race (a concurrent, unrelated conversation elsewhere stealing activation) this
    // guards against before message 2 is ever typed or queued.
    await forceActivateConversation(page, createdId);

    // Message 2, typed and queued WHILE the first run is still active.
    await composer.fill(PROMPT_2);
    await queueButton.click();

    const queueList = page.locator('.fw-chat-composer__queue');
    await expect(queueList, 'the second message never appeared in the visible queue').toBeVisible();
    await expect(queueList).toContainText(MARKER_2);
    await expect(queueList.locator('.fw-chat-composer__queue-status')).toHaveText('Waiting');
    // Queuing must never attempt (and silently swallow) a send — the field is cleared, but nothing
    // pretends the message went out yet.
    await expect(composer).toHaveValue('');

    // The first turn's REAL reply — proof this was a genuine round trip, not a fabricated local echo.
    // Scoped to an assistant ("from Forge") turn specifically: the user's OWN prompt text also
    // contains the marker (it is quoted inside the instruction itself), so an unscoped text search
    // is ambiguous — a real strict-mode violation this suite's own dry run hit and fixed here.
    await expect(
      page.getByLabel(/from Forge/).filter({ hasText: MARKER_1 }),
      'the real assistant reply for message 1 never arrived',
    ).toBeVisible({ timeout: 120_000 });

    // Once the run genuinely finishes, the composer reverts to Send — the real signal the queue's own
    // flush effect (`Composer.tsx`) is waiting on too.
    await expect(sendButton, 'the composer never reverted to Send after the first run finished').toBeVisible({
      timeout: 30_000,
    });

    // The queue really flushes on its own — no manual Send click for message 2.
    await expect(queueList, 'the queued message was never auto-flushed once the run finished').toHaveCount(0, {
      timeout: 10_000,
    });

    // And the SECOND turn's real reply proves it was genuinely sent, not merely removed from the list.
    await expect(
      page.getByLabel(/from Forge/).filter({ hasText: MARKER_2 }),
      "the queued message's real reply never arrived",
    ).toBeVisible({ timeout: 120_000 });
  });
});
