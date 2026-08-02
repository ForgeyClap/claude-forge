/**
 * `gateway-actions.ts` — REGRESSION (forge-2026-07-29-cc-finish, fix-newchat).
 *
 * The real "New chat" button sent `POST /api/conversations` with a body that
 * included `title: null`. The gateway's schema validator (gateway/src/body.mjs
 * + gateway/src/server.mjs) used to treat a present-but-null `title` the same
 * as a genuinely wrong type (a number, object, array) and reject it with a
 * real 400 ("title must be a string") — so every click failed and created
 * nothing (see gateway/test/routes-wp4.test.mjs for the matching server-side
 * regression tests). The gateway is now fixed to accept `title: null` too, but
 * this test locks the CLIENT side of the fix independently: `title` must be
 * omitted from the request body entirely when there is no title yet, so this
 * call site stays correct even if a future refactor reintroduces a stricter
 * server-side schema.
 *
 * Stubs `globalThis.fetch` directly (no real network) — mirrors
 * `gateway-connection-store.test.ts`'s own `stubHealthyFetch()` precedent for
 * this exact seam.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { requestDeleteConversation, requestNewConversation } from '@/components/shell/gateway-actions';

function stubConversationCreateFetch(): { fetchMock: ReturnType<typeof vi.fn>; bodies: unknown[] } {
  const bodies: unknown[] = [];
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (typeof init?.body === 'string') bodies.push(JSON.parse(init.body));
    return {
      ok: true,
      status: 201,
      json: async () => ({ ok: true, conversation: { id: 'c-test-1', project: 'demo', title: null } }),
    };
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return { fetchMock, bodies };
}

describe('requestNewConversation — the real POST /api/conversations body it sends', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('never sets title: null in the request body (the exact shape that used to 400)', async () => {
    const { bodies } = stubConversationCreateFetch();

    const result = await requestNewConversation('demo');

    expect(result.ok).toBe(true);
    expect(bodies).toHaveLength(1);
    const body = bodies[0] as Record<string, unknown>;
    expect(body.project).toBe('demo');
    expect('title' in body).toBe(false);
  });

  it('omits title from the body rather than sending any explicit value for it', async () => {
    const { bodies } = stubConversationCreateFetch();

    await requestNewConversation('another-project');

    const body = bodies[0] as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['project']);
  });

  it('still short-circuits with no fetch call at all when no project is selected', async () => {
    const { fetchMock } = stubConversationCreateFetch();

    const result = await requestNewConversation('');

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/select or create a project/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * `requestDeleteConversation` — feat-delete-conversation.
 *
 * Mirrors `requestNewConversation`'s own fetch-stub precedent: no real network, just the exact
 * request shape (method + URL) and the gateway's real error text passed straight through on
 * failure (e.g. the real 409 "pending execution" case, never a guessed generic message).
 */
describe('requestDeleteConversation — the real DELETE /api/conversations/:id it sends', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends a real DELETE to /api/conversations/:id and reports ok:true on a real 200', async () => {
    const calls: { url: string; method: string | undefined }[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method });
      return { ok: true, status: 200, json: async () => ({ ok: true, deleted: true, id: 'c-test-1' }) };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const result = await requestDeleteConversation('c-test-1');

    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].url).toMatch(/\/api\/conversations\/c-test-1$/);
  });

  it('URL-encodes the conversation id in the request path', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => ({ ok: true, deleted: true }) };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await requestDeleteConversation('c/with slash');

    expect(calls[0]).toContain(encodeURIComponent('c/with slash'));
  });

  it('passes the gateway\'s real error text straight through on failure (e.g. a real 409 busy conversation)', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 409,
      json: async () => ({ ok: false, error: 'conversation has a pending execution — stop it before deleting' }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const result = await requestDeleteConversation('c-busy-1');

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/pending execution/);
  });

  it('never throws on a real network failure — reports an honest ok:false instead', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network unreachable');
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const result = await requestDeleteConversation('c-test-1');

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/network unreachable/);
  });
});
