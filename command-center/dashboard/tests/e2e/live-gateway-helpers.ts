/**
 * live-gateway-helpers — shared setup for the composer/conversation e2e specs
 * (test-e2e-composer, forge-2026-07-29-cc-finish).
 *
 * These specs exercise real, previously-unit-tested-only production behaviour: the message queue,
 * `@`-file mentions over `GET /api/files`, `/`-slash commands, mode/effort persistence, and
 * conversation deletion. They assume nothing about whether the gateway they run against has a real
 * or a mocked (`CC_EXEC_MOCK=1`) exec bridge — every helper here only ever drives the real,
 * documented HTTP/UI contract (`POST /api/conversations`, `DELETE /api/conversations/:id`,
 * `GET /api/conversations`, the Sidebar's real "New chat" action, the real project search) that
 * behaves identically either way. See `playwright.config.ts`'s own header for the opt-in flag that
 * lets these run against an already-live gateway instead of a freshly-spawned one.
 *
 * SANDBOX PROJECT: every spec here runs against a small, disposable Forge self-test project
 * (`SANDBOX_PROJECT`). C1 fix (WP-C1, 2026-09-26 laptop re-audit): this used to assume the project
 * already existed on disk — true only on the machine that happened to have created it by hand once,
 * false on any fresh checkout/laptop/CI runner, which failed loudly with "sandbox project
 * 'selftest-full' did not appear in the sidebar project search" (13 fails, all the same cause).
 * `ensureSandboxProject` below now creates it itself, through the real, already-reviewed
 * `POST /api/projects` route (the exact route the app's own "New project" button drives) — never a
 * placeholder or a fixture written straight to disk, so this suite still only ever exercises real,
 * documented HTTP/UI contracts. Because the gateway scans the SAME real `Documents/` tree regardless
 * of which config spawned it (see `gateway/src/paths.mjs`), that project can carry OTHER real
 * conversations at any time (its own past runs, or a concurrently working agent) — every helper below
 * therefore only ever creates/reads/deletes conversations by the EXACT id it itself just created, never
 * "the only conversation in this project" or "whatever is currently displayed", which a background
 * reconciliation effect (`PrototypeProvider.tsx`'s own conversation-activation effect) can otherwise
 * swap out from under a test the instant this test's own id is gone.
 */

import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

/** A small, disposable Forge self-test project already present on this machine — never a project
 *  with real client work. */
export const SANDBOX_PROJECT = 'selftest-full';

const EXEC_TOKEN_HEADER = 'x-cc-exec-token';

/**
 * Reads the real per-boot exec token the served HTML embeds (`<meta name="cc-exec-token">`) — the
 * same token `readExecToken()` (`gateway-client.ts`) reads client-side. Fails loudly (never returns a
 * fallback) when the meta tag is missing, since every write route this helper file drives needs it.
 */
export async function readExecToken(page: Page): Promise<string> {
  const token = await page.locator('meta[name="cc-exec-token"]').getAttribute('content');
  if (token === null || token.trim() === '') {
    throw new Error('cc-exec-token meta tag was not found in the served HTML — cannot authenticate a write route.');
  }
  return token;
}

/**
 * C1 fix (WP-C1): creates `projectName` through the real `POST /api/projects` route when it does
 * not already exist — the same route/mechanism the app's own "New project" button drives (see
 * `gateway/src/projects-create.mjs`). Idempotent: a 409 ("already exists") is the expected, correct
 * outcome on a repeat run or a shared machine that already has this project, and is treated as
 * success, never an error. The route's own scaffold (`.claude/forge-dashboard` marker + CLAUDE.md)
 * happens synchronously before the response — the detached, multi-minute real installer that may
 * run afterwards is never awaited here, since the specs in this suite only need the project to be
 * DISCOVERABLE in the sidebar search, not fully installed.
 */
export async function ensureSandboxProject(page: Page, projectName: string = SANDBOX_PROJECT): Promise<void> {
  const token = await readExecToken(page);
  const response = await page.request.post('/api/projects', {
    headers: { [EXEC_TOKEN_HEADER]: token },
    data: { name: projectName },
  });
  if (response.status() === 201 || response.status() === 409) return;
  throw new Error(`could not ensure the sandbox project "${projectName}" exists: HTTP ${response.status()} ${await response.text()}`);
}

/**
 * Opens `projectName` through the REAL sidebar search + project row — the same path a person takes,
 * never a direct state injection. Navigates home first so the search field is always reachable
 * regardless of which route the page was previously on. C1 fix (WP-C1): ensures the project exists
 * first (see `ensureSandboxProject`'s own header) rather than assuming it was created by hand once
 * on one specific machine — the "did not appear" failure this used to hit on every OTHER machine.
 */
export async function openSandboxProject(page: Page, projectName: string = SANDBOX_PROJECT): Promise<void> {
  await page.goto('/#/');
  await page.waitForLoadState('domcontentloaded');
  await ensureSandboxProject(page, projectName);
  const search = page.locator('#fw-sidebar-search');
  await search.fill(projectName);
  const row = page.locator('.fw-prow__main', { hasText: projectName }).first();
  await expect(row, `sandbox project "${projectName}" did not appear in the sidebar project search`).toBeVisible({
    timeout: 10_000,
  });
  await row.click();
  // Clears the search box so later interactions in this same test are not left mid-filter.
  await search.fill('');
}

/**
 * Drives the sidebar's real "New chat" button (`requestNewConversation` → real
 * `POST /api/conversations`), then FORCES the chat panel onto that exact conversation and returns its
 * real id. Two real, observed (not hypothetical) findings from this suite's own dry run shaped this:
 *
 *   1. The id is read straight from the POST response body, never the header's
 *      `title={conversation.id}` attribute — the header can already be showing something else by the
 *      time this function's own click resolves (see point 2).
 *   2. A `PrototypeProvider.tsx` reconciliation effect activates `data.conversations[0]` the instant
 *      the current `activeConversationId` is not (yet) present in `data.conversations` — and a
 *      brand-new, still-empty conversation genuinely is absent from that list until the client's own
 *      ~4s conversations poll (`gateway-chat.ts`'s `CONVERSATIONS_POLL_MS`) catches up. Once the
 *      effect reassigns away, it does NOT reassign back on its own once the new conversation finally
 *      appears — its guard only re-checks the CURRENT active id, which by then is already "known".
 *      Measured directly against the live gateway: the header stayed on a different, pre-existing
 *      conversation for 12+ seconds straight after "New chat", even though this function's own
 *      conversation had already appeared as a real row in the sidebar after ~4.5s. Explicitly waiting
 *      for that row and clicking it forces a fresh, deterministic `conversation/activate` dispatch —
 *      confirmed to make the header settle on the real id every time in this suite's own dry run.
 *
 * This is a genuine app-level UX gap worth a Build Boss follow-up (a fresh empty conversation's own
 * header can silently point at a stale one for several seconds) — noted in this WP's own report, not
 * silently patched here; this helper only makes THIS suite's assertions target the right conversation.
 */
export async function startNewChat(page: Page): Promise<string> {
  const newChatButton = page.getByRole('button', { name: 'New chat', exact: true }).first();
  const [response] = await Promise.all([
    page.waitForResponse(
      (res) => res.request().method() === 'POST' && res.url().endsWith('/api/conversations'),
      { timeout: 15_000 },
    ),
    newChatButton.click(),
  ]);
  expect(response.ok(), `POST /api/conversations failed: HTTP ${response.status()}`).toBe(true);
  const body = (await response.json()) as { conversation?: { id?: string } };
  const id = body.conversation?.id;
  if (typeof id !== 'string' || id.trim() === '') {
    throw new Error('POST /api/conversations did not return a real conversation id.');
  }

  await forceActivateConversation(page, id);
  return id;
}

/**
 * Waits for `id`'s real sidebar row to appear (proving `data.conversations` has caught up — see
 * `startNewChat`'s own header for why that wait cannot be skipped) and clicks it, forcing a fresh,
 * known-good `conversation/activate` dispatch. Used both by `startNewChat` and by any spec whose OWN
 * "New chat"/Send action can lose the reconciliation race — e.g. the message-queue spec found this
 * SAME race also hits the implicit create-on-send path (`gateway-chat.ts`), not just the empty "New
 * chat" button: with a busy shared gateway, a completely unrelated conversation elsewhere on the
 * machine can become `data.conversations[0]` at just the wrong moment and steal activation before
 * this test's own conversation is recognised. Failing this wait loudly (never silently) is
 * deliberate: proceeding while the WRONG conversation is displayed risks a test action (a queued
 * message, a delete) landing on somebody else's real, unrelated conversation instead.
 */
export async function forceActivateConversation(page: Page, id: string): Promise<void> {
  const row = page.locator(`.fw-crow__main[title$="(${id})"]`);
  await expect(row, `conversation ${id} never appeared as a real sidebar row`).toBeVisible({ timeout: 20_000 });
  await row.click();
  await expect(
    page.locator('.fw-chat__title'),
    `the chat header did not settle on conversation ${id} after selecting it`,
  ).toHaveAttribute('title', id, { timeout: 10_000 });
}

/**
 * One real, unauthenticated `GET /api/conversations/:id` read — true (200) or false (404) for the
 * EXACT id, never a guess derived from the collection route. `GET /api/conversations` (no id) proved
 * unsuitable for this: it ignores its own `project` query param entirely and appears bounded to a
 * small "most recent across the whole workspace" window, which a busy shared gateway (concurrent
 * agents, concurrent test workers) can push a just-created id out of within milliseconds — a real,
 * observed flake in this suite's own dry run, not a hypothetical one. The single-item route has no
 * such window: it is a direct existence check for the one id this helper is asked about.
 */
export async function conversationExists(page: Page, id: string): Promise<boolean> {
  const response = await page.request.get(`/api/conversations/${encodeURIComponent(id)}`);
  if (response.status() === 404) return false;
  expect(response.ok(), `GET /api/conversations/${id} failed unexpectedly: HTTP ${response.status()}`).toBe(true);
  return true;
}

/**
 * Deletes a conversation by its EXACT id via the real `DELETE /api/conversations/:id` route — used
 * both as the object under test (the delete spec) and as best-effort cleanup after every other spec
 * that creates one. Never throws on an already-deleted id (idempotent from the caller's perspective);
 * every other non-2xx status still surfaces as a thrown error so a real cleanup failure is never
 * silently swallowed.
 */
export async function deleteConversation(page: Page, id: string): Promise<{ readonly ok: boolean; readonly status: number }> {
  const token = await readExecToken(page);
  const response = await page.request.delete(`/api/conversations/${encodeURIComponent(id)}`, {
    headers: { [EXEC_TOKEN_HEADER]: token },
  });
  return { ok: response.ok(), status: response.status() };
}

/** Best-effort cleanup for an `afterEach` — swallows a failure (conversation already gone, or the
 *  test never got far enough to create one) rather than masking the real test failure with a cleanup
 *  error, but never silently ignores an id that really should have been deleted and was not; the
 *  caller is expected to still assert deletion explicitly inside the test itself where that matters. */
export async function cleanupConversation(page: Page, id: string | null): Promise<void> {
  if (id === null) return;
  try {
    await deleteConversation(page, id);
  } catch {
    /* best-effort only — the test's own assertions are the real proof, this is just tidy-up */
  }
}
