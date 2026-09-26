/**
 * Forge Workspace — shell-level gateway actions.
 *
 * `Sidebar`'s "New chat" and `CommandPalette`'s "New conversation" both start a
 * real conversation the same way `gateway-chat.ts`'s own send controller does:
 * a real `POST /api/conversations` through the existing `gwPost` transport
 * (`gateway-client.ts`). This module adds no new fetch/transport code — it only
 * shapes the one extra call site these two shell components share, so neither
 * one duplicates the parsing logic on its own.
 *
 * build-newproject adds `requestNewProject`: the same `gwPost` transport against
 * the new `POST /api/projects` route, used by `Sidebar`'s "New project" button
 * (via `NewProjectDialog`).
 *
 * build-async-install: the gateway's `POST /api/projects` no longer waits for the real Forge
 * installer (a real doctor run can take several minutes — see gateway/src/projects-create.mjs's
 * own header) and no longer reports its outcome in the 201 body at all. `pollProjectInstall` below
 * is the client half of that: it polls the new `GET /api/projects/install-status?name=<n>` route
 * every few seconds until the install reaches a real terminal state (or a generous timeout elapses)
 * and reports the outcome to the caller EXACTLY ONCE — never a fabricated success, never silently
 * dropped.
 */

import { EXEC_TOKEN_HEADER, gwDelete, gwGet, gwPost, pickRecord, pickString, readExecToken } from '@/prototype/state/gateway-client';

// N6 fix (WP-C1, 2026-09-26 laptop re-audit): the gateway now checks the exec token for EVERY
// non-GET route (server.mjs's requestListener), not just the routes that used to remember to add
// their own check — POST /api/conversations and POST /api/projects below never sent it at all
// before this fix. Same per-file `execHeaders()` helper convention gateway-discord.ts already uses.
function execHeaders(): Record<string, string> {
  const token = readExecToken();
  return token !== null ? { [EXEC_TOKEN_HEADER]: token } : {};
}

export interface NewConversationResult {
  readonly ok: boolean;
  readonly id: string | null;
  readonly error: string | null;
}

/**
 * Creates a new conversation in `projectId` through the real gateway route.
 * Mirrors `gateway-chat.ts`'s own `send()` create-path (same route, same
 * "no project selected" guard) so the two call sites behave identically. The
 * `title` field is omitted here rather than sent as `title: null` — no title
 * exists yet at creation time, and the gateway's schema validator now treats
 * an absent field and an explicit `null` the same way (both mean "no title
 * supplied"), so this stays correct regardless of which shape a caller sends.
 */
export async function requestNewConversation(projectId: string): Promise<NewConversationResult> {
  if (projectId === '') {
    return { ok: false, id: null, error: 'Select or create a project before starting a chat.' };
  }
  const result = await gwPost('/api/conversations', { project: projectId }, execHeaders());
  if (!result.ok) return { ok: false, id: null, error: result.error };
  const conversation = pickRecord(result.data, ['conversation']);
  const id = conversation !== null ? pickString(conversation, ['id']) : null;
  if (id === null) {
    return { ok: false, id: null, error: 'The gateway did not return a conversation to open.' };
  }
  return { ok: true, id, error: null };
}

export interface DeleteConversationResult {
  readonly ok: boolean;
  readonly error: string | null;
}

/**
 * Deletes a real conversation via `DELETE /api/conversations/:id` (feat-delete-conversation).
 * Mirrors `requestNewConversation`'s own shape: never throws, passes the gateway's real error text
 * straight through. The gateway requires the same per-boot exec token every real write route needs
 * (N6 fix, WP-C1: checked once for every non-GET request, no exceptions) — `readExecToken()`
 * degrades to an omitted header when the meta tag is absent (e.g. a test render), which the gateway
 * then honestly answers with a real 403, exactly like every other write route's own documented
 * degrade path.
 */
export async function requestDeleteConversation(conversationId: string): Promise<DeleteConversationResult> {
  const result = await gwDelete(`/api/conversations/${encodeURIComponent(conversationId)}`, execHeaders());
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, error: null };
}

export interface NewProjectResult {
  readonly ok: boolean;
  /** The created project's id — this gateway uses the folder name as the id (see `projects.mjs`). */
  readonly id: string | null;
  readonly error: string | null;
}

/**
 * Creates a new project directory through the real `POST /api/projects` route.
 * `name` is sent as-is (trimmed) — the gateway owns the strict name validation
 * (`^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$`) and returns a real 400/409/500 error
 * this function passes straight through rather than guessing at one client-side.
 *
 * build-async-install: the gateway no longer waits for the real Forge installer before answering
 * this request (see this file's own header) — a successful result here means the project directory
 * itself was scaffolded, nothing about the installer's outcome yet. Call `pollProjectInstall` with
 * the returned `id` to learn that, once it's known.
 */
export async function requestNewProject(name: string): Promise<NewProjectResult> {
  const trimmed = name.trim();
  if (trimmed === '') {
    return { ok: false, id: null, error: 'Enter a project name.' };
  }
  const result = await gwPost('/api/projects', { name: trimmed }, execHeaders());
  if (!result.ok) return { ok: false, id: null, error: result.error };
  const project = pickRecord(result.data, ['project']);
  const id = project !== null ? pickString(project, ['name']) : null;
  if (id === null) {
    return { ok: false, id: null, error: 'The gateway did not return the created project.' };
  }
  return { ok: true, id, error: null };
}

/** A single real, honest reading of `GET /api/projects/install-status?name=<n>`. */
export interface InstallStatusResult {
  readonly state: 'installing' | 'installed' | 'failed' | 'unknown';
  /** The installer's own real, redacted failure reason — `null` unless `state` is `'failed'`. */
  readonly reason: string | null;
  /** An honesty note the gateway attaches to a `'unknown'` reading (e.g. after its own restart),
   *  or the transport-level error when the request itself failed — `null` otherwise. */
  readonly note: string | null;
}

function toInstallState(value: string | null): InstallStatusResult['state'] {
  return value === 'installing' || value === 'installed' || value === 'failed' ? value : 'unknown';
}

/** One real GET of the install-status route — never throws, never fabricates a terminal state. */
export async function requestInstallStatus(name: string): Promise<InstallStatusResult> {
  const result = await gwGet(`/api/projects/install-status?name=${encodeURIComponent(name)}`);
  if (!result.ok) return { state: 'unknown', reason: null, note: result.error };
  return {
    state: toInstallState(pickString(result.data, ['state'])),
    reason: pickString(result.data, ['reason']),
    note: pickString(result.data, ['note']),
  };
}

const INSTALL_POLL_INTERVAL_MS = 5_000;
const INSTALL_POLL_TIMEOUT_MS = 8 * 60_000;

/**
 * Polls `GET /api/projects/install-status?name=<name>` every `intervalMs` until the real installer
 * reaches a terminal state (`'installed'`/`'failed'`) or `timeoutMs` elapses, then calls `onSettled`
 * EXACTLY ONCE with the real outcome — never a fabricated success, never called more than once, and
 * never left uncalled. A non-terminal `'unknown'` reading (e.g. right after a gateway restart) keeps
 * polling rather than immediately reporting failure, since the install may genuinely still be
 * running elsewhere; only the timeout itself turns a still-`'unknown'`/`'installing'` reading into a
 * final, honestly-worded `'failed'` report. Fire-and-forget by design (the caller does not await
 * this) — it never blocks the UI thread; each tick is a single real fetch.
 */
export function pollProjectInstall(
  name: string,
  onSettled: (result: InstallStatusResult) => void,
  options?: { readonly intervalMs?: number; readonly timeoutMs?: number },
): void {
  const intervalMs = options?.intervalMs ?? INSTALL_POLL_INTERVAL_MS;
  const timeoutMs = options?.timeoutMs ?? INSTALL_POLL_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  async function tick(): Promise<void> {
    const result = await requestInstallStatus(name);
    if (result.state === 'installed' || result.state === 'failed') {
      onSettled(result);
      return;
    }
    if (Date.now() >= deadline) {
      onSettled({
        state: 'failed',
        reason: `Forge install status is still "${result.state}" after ${Math.round(timeoutMs / 60_000)} minutes — check the project manually.`,
        note: null,
      });
      return;
    }
    globalThis.setTimeout(() => { void tick(); }, intervalMs);
  }

  void tick();
}
