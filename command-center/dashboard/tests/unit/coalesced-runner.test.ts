/**
 * `createCoalescedRunner` — Codex F7 (2026-07-26). Pure-function tests, no React, no DOM, no
 * network, no fake timers needed: this is a plain in-flight-coalescing + trailing-refresh primitive
 * `gateway-adapter.ts`'s `useGatewayEvents` uses to make sure its poll interval and its SSE
 * `onmessage` trigger never run two overlapping real fetches — see that hook's own comment for the
 * race this closes (an older, slower-resolving fetch silently overwriting newer state).
 */

import { describe, expect, it, vi } from 'vitest';

import { createCoalescedRunner } from '@/prototype/state/gateway-adapter';

/** Resolves once any already-queued microtasks (promise `.then`/`.catch`/`.finally` chains) have
 *  run — a real macrotask tick is the simplest reliable way to let a `.finally()`-triggered
 *  synchronous re-`run()` (and the async function it calls) actually execute before asserting. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface Gate {
  readonly promise: Promise<void>;
  resolve: () => void;
}
function makeGate(): Gate {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

describe('createCoalescedRunner — REPORTED behavior only, never a fabricated call count', () => {
  it('a single trigger invokes fn exactly once', async () => {
    const fn = vi.fn(async () => {});
    const trigger = createCoalescedRunner(fn);
    trigger();
    await flush();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('two SEQUENTIAL triggers (each after the previous fully settles) invoke fn twice — no permanent lock', async () => {
    const fn = vi.fn(async () => {});
    const trigger = createCoalescedRunner(fn);
    trigger();
    await flush();
    trigger();
    await flush();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('a trigger that arrives WHILE fn is in flight does NOT start a second concurrent call', async () => {
    const gate = makeGate();
    const fn = vi.fn(async () => { await gate.promise; });
    const trigger = createCoalescedRunner(fn);

    trigger(); // call #1 starts, blocks on gate
    await flush();
    expect(fn).toHaveBeenCalledTimes(1);

    trigger(); // arrives mid-flight — must mark dirty, NOT start a second concurrent call
    await flush();
    expect(fn).toHaveBeenCalledTimes(1); // still just the one in-flight call

    gate.resolve();
    await flush();
  });

  it('MULTIPLE triggers that arrive while fn is in flight collapse into exactly ONE trailing re-run, not one per trigger', async () => {
    const gate1 = makeGate();
    const gate2 = makeGate();
    const gates = [gate1, gate2];
    let callIndex = 0;
    const fn = vi.fn(async () => {
      const g = gates[callIndex];
      callIndex += 1;
      await g.promise;
    });
    const trigger = createCoalescedRunner(fn);

    trigger(); // call #1 starts
    await flush();
    expect(fn).toHaveBeenCalledTimes(1);

    trigger(); // dirty triggers while call #1 is still in flight —
    trigger(); // — five of them must still collapse into exactly one trailing re-run
    trigger();
    trigger();
    trigger();
    await flush();
    expect(fn).toHaveBeenCalledTimes(1); // no concurrent second call started yet

    gate1.resolve(); // let call #1 settle
    await flush();
    await flush();
    expect(fn).toHaveBeenCalledTimes(2); // exactly ONE trailing re-run, despite 5 dirty triggers

    gate2.resolve(); // let the trailing re-run settle too (clean shutdown, no dangling promise)
    await flush();
    expect(fn).toHaveBeenCalledTimes(2); // and nothing beyond that — no runaway re-run loop
  });

  it('a rejecting fn does not break the coalescing chain — a trigger arriving DURING the rejection still produces exactly one trailing re-run', async () => {
    let callIndex = 0;
    const fn = vi.fn(async () => {
      callIndex += 1;
      if (callIndex === 1) throw new Error('simulated failure — the real refresh() already reports its own {ok:false}, but the wrapper must survive any rejection regardless');
    });
    const trigger = createCoalescedRunner(fn);

    trigger(); // call #1 starts (will reject); synchronously in-flight
    trigger(); // arrives before call #1's rejection has been processed — must mark dirty, NOT start a 2nd concurrent call
    await flush();
    expect(fn).toHaveBeenCalledTimes(2); // call #1 (rejected, caught) + exactly ONE trailing re-run, not more
  });
});
