/**
 * `GatewayConnectionStore` — Codex F8 (2026-07-26): ref-counted subscribers. Before this fix, the
 * module-level singleton (`getSharedConnectionStore()`) polled forever once created, even after
 * every real subscriber had unmounted. These tests instantiate a FRESH `GatewayConnectionStore`
 * directly (never the shared singleton, which stays untouched by this file) with a stubbed
 * `globalThis.fetch` and fake timers, so the only thing under test is start/stop ref-counting — no
 * real network, no real 5s wait.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GatewayConnectionStore, HEALTH_POLL_MS } from '@/prototype/state/gateway-adapter';

function stubHealthyFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({}),
  }));
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return fetchMock;
}

describe('GatewayConnectionStore — ref-counted start/stop (never a real 5s wait; fake timers throughout)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not poll at all before any subscriber attaches', () => {
    const fetchMock = stubHealthyFetch();
    void new GatewayConnectionStore(); // constructing alone must never start the timer (see F8 comment)
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('starts polling on the first subscriber and stops (clearInterval, no further fetches) once the LAST one unsubscribes', async () => {
    const fetchMock = stubHealthyFetch();
    const store = new GatewayConnectionStore();

    const unsubA = store.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0); // let the first-subscribe immediate poll() resolve
    const callsAfterFirstSubscribe = fetchMock.mock.calls.length;
    expect(callsAfterFirstSubscribe).toBeGreaterThan(0);

    const unsubB = store.subscribe(() => {}); // a second, concurrent subscriber
    await vi.advanceTimersByTimeAsync(0);

    unsubA(); // ONE subscriber remains — polling must keep going
    await vi.advanceTimersByTimeAsync(HEALTH_POLL_MS);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFirstSubscribe);

    const callsBeforeLastUnsub = fetchMock.mock.calls.length;
    unsubB(); // the LAST subscriber — the interval must be cleared now
    await vi.advanceTimersByTimeAsync(HEALTH_POLL_MS * 3);
    expect(fetchMock.mock.calls.length).toBe(callsBeforeLastUnsub); // no further polls after the last unsubscribe
  });

  it('resumes polling (a fresh immediate poll) if a new subscriber attaches after the store went fully idle', async () => {
    const fetchMock = stubHealthyFetch();
    const store = new GatewayConnectionStore();

    const unsub1 = store.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    unsub1();

    await vi.advanceTimersByTimeAsync(HEALTH_POLL_MS * 2); // fully idle — no timer should be running
    const callsWhileIdle = fetchMock.mock.calls.length;

    const unsub2 = store.subscribe(() => {}); // re-subscribe after idle
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsWhileIdle); // a fresh immediate poll fired
    unsub2();
  });

  it('a second subscriber joining an ALREADY-polling store does not restart or duplicate the timer', async () => {
    const fetchMock = stubHealthyFetch();
    const store = new GatewayConnectionStore();

    const unsubA = store.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    const callsAfterA = fetchMock.mock.calls.length;

    const unsubB = store.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    // joining does not itself trigger an extra immediate poll — only the FIRST subscribe does
    expect(fetchMock.mock.calls.length).toBe(callsAfterA);

    unsubA();
    unsubB();
  });
});
