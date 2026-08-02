/**
 * ask-questions.ts — the real "ask the owner" question/answer state layer (feat-ask-owner,
 * forge-2026-07-30-cc-finish).
 *
 * Two layers: `findPendingAsk` (pure event-scanning logic) and `useGatewayAskQuestions` (the real
 * poll + submit hook). No network for the pure-logic tests; a stubbed `fetch` for the hook tests,
 * mirroring `gateway-chat-crossproject.test.ts`'s own precedent for this exact seam.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';

import { findAbandonReason, findPendingAsk, submitAskAnswers, useGatewayAskQuestions } from '@/prototype/state/gateway-chat/ask-questions';
import { CONVERSATION_DETAIL_POLL_MS } from '@/prototype/state/gateway-chat/turn-parsers';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function askQuestionsEvent(id: string, questions: readonly Record<string, unknown>[]): Record<string, unknown> {
  return { kind: 'ask_questions', data: { id, questions } };
}

describe('findPendingAsk', () => {
  it('returns null when there are no events at all', () => {
    expect(findPendingAsk([])).toBeNull();
  });

  it('returns the real pending ask when an ask_questions event has no later resolving event', () => {
    const events = [askQuestionsEvent('ask-1', [{ header: 'Color', question: 'Which color?', options: ['red', 'blue'], multiSelect: false }])];
    const pending = findPendingAsk(events);
    expect(pending).toEqual({
      id: 'ask-1',
      questions: [{ header: 'Color', question: 'Which color?', options: ['red', 'blue'], multiSelect: false, recommended: null }],
    });
  });

  it('returns null once a matching ask_answered event follows it', () => {
    const events = [askQuestionsEvent('ask-1', [{ question: 'Q1' }]), { kind: 'ask_answered', data: { id: 'ask-1' } }];
    expect(findPendingAsk(events)).toBeNull();
  });

  it('returns null once a matching ask_timed_out event follows it', () => {
    const events = [askQuestionsEvent('ask-1', [{ question: 'Q1' }]), { kind: 'ask_timed_out', data: { id: 'ask-1' } }];
    expect(findPendingAsk(events)).toBeNull();
  });

  it('a resolving event for a DIFFERENT ask id never resolves this one', () => {
    const events = [askQuestionsEvent('ask-1', [{ question: 'Q1' }]), { kind: 'ask_answered', data: { id: 'ask-other' } }];
    expect(findPendingAsk(events)?.id).toBe('ask-1');
  });

  it('only the LATEST ask_questions event counts when several exist — an earlier resolved one never resurfaces', () => {
    const events = [
      askQuestionsEvent('ask-1', [{ question: 'first' }]),
      { kind: 'ask_answered', data: { id: 'ask-1' } },
      askQuestionsEvent('ask-2', [{ question: 'second' }]),
    ];
    const pending = findPendingAsk(events);
    expect(pending?.id).toBe('ask-2');
  });

  it('an ask_questions event with an empty questions array never counts as pending', () => {
    const events = [askQuestionsEvent('ask-1', [])];
    expect(findPendingAsk(events)).toBeNull();
  });

  it('reads header/options/multiSelect defensively — missing fields fall back honestly (null header, empty options, multiSelect false)', () => {
    const events = [askQuestionsEvent('ask-1', [{ question: 'Bare question' }])];
    expect(findPendingAsk(events)).toEqual({
      id: 'ask-1',
      questions: [{ header: null, question: 'Bare question', options: [], multiSelect: false, recommended: null }],
    });
  });

  // fix-ghost-asks (forge-2026-07-30-cc-finish, item 3): ask_abandoned is a THIRD resolving kind.
  it('returns null once a matching ask_abandoned event follows it — a wizard must never open for an already-abandoned ask', () => {
    const events = [askQuestionsEvent('ask-1', [{ question: 'Q1' }]), { kind: 'ask_abandoned', data: { id: 'ask-1', reason: 'execution_stopped' } }];
    expect(findPendingAsk(events)).toBeNull();
  });

  it('an ask_abandoned event for a DIFFERENT ask id never resolves this one', () => {
    const events = [askQuestionsEvent('ask-1', [{ question: 'Q1' }]), { kind: 'ask_abandoned', data: { id: 'ask-other' } }];
    expect(findPendingAsk(events)?.id).toBe('ask-1');
  });
});

describe('findAbandonReason', () => {
  it('returns the real reason string off a matching ask_abandoned event', () => {
    const events = [{ kind: 'ask_abandoned', data: { id: 'ask-1', reason: 'execution_stopped' } }];
    expect(findAbandonReason(events, 'ask-1')).toBe('execution_stopped');
  });

  it('returns undefined (not null, not a fabricated reason) when no ask_abandoned event exists for this id at all', () => {
    expect(findAbandonReason([], 'ask-1')).toBeUndefined();
    expect(findAbandonReason([{ kind: 'ask_answered', data: { id: 'ask-1' } }], 'ask-1')).toBeUndefined();
  });

  it('an ask_abandoned event for a DIFFERENT id is never matched', () => {
    const events = [{ kind: 'ask_abandoned', data: { id: 'ask-other', reason: 'execution_closed' } }];
    expect(findAbandonReason(events, 'ask-1')).toBeUndefined();
  });

  it('returns null (found the event, but no real reason string) rather than fabricating one', () => {
    const events = [{ kind: 'ask_abandoned', data: { id: 'ask-1' } }];
    expect(findAbandonReason(events, 'ask-1')).toBeNull();
  });
});

describe('submitAskAnswers', () => {
  it('POSTs the real answers array to /api/ask/:id/answer', async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        calls.push({ url: String(input), body: init?.body !== undefined ? JSON.parse(String(init.body)) : undefined });
        return { ok: true, status: 200, json: async () => ({ ok: true, answered: true, id: 'ask-1' }) };
      }),
    );
    const outcome = await submitAskAnswers('ask-1', ['blue', 'large']);
    expect(outcome.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/api/ask/ask-1/answer');
    expect(calls[0].body).toEqual({ answers: [{ answer: 'blue' }, { answer: 'large' }] });
  });

  it('surfaces the gateway\'s own real error text on failure, never a fabricated success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ ok: false, error: 'unknown ask id' }) })),
    );
    const outcome = await submitAskAnswers('ask-gone', ['x']);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe('unknown ask id');
  });
});

describe('useGatewayAskQuestions', () => {
  function jsonResponse(body: unknown): Response {
    return { ok: true, status: 200, json: async () => body } as Response;
  }

  it('polls GET /api/conversations/:id and derives the real pending ask from its events', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes('/api/conversations/c-1') && !url.includes('/messages')) {
          return jsonResponse({
            ok: true,
            turns: [],
            events: [askQuestionsEvent('ask-1', [{ question: 'Which color?', options: ['red', 'blue'] }])],
          });
        }
        return jsonResponse({ ok: true });
      }),
    );

    const { result } = renderHook(() => useGatewayAskQuestions('c-1'));
    await waitFor(() => expect(result.current.pending).not.toBeNull());
    expect(result.current.pending?.id).toBe('ask-1');
    expect(result.current.pending?.questions[0].question).toBe('Which color?');
  });

  it('conversationId === "" never fetches anything and pending stays null', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchSpy);

    const { result } = renderHook(() => useGatewayAskQuestions(''));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.pending).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('switching conversationId clears a stale pending ask from the previous conversation before the new fetch resolves', async () => {
    let resolveSecond: ((value: Response) => void) | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes('/api/conversations/c-a')) {
          return jsonResponse({ ok: true, turns: [], events: [askQuestionsEvent('ask-a', [{ question: 'Q-A' }])] });
        }
        if (url.includes('/api/conversations/c-b')) {
          return new Promise<Response>((resolve) => {
            resolveSecond = resolve;
          });
        }
        return jsonResponse({ ok: true });
      }),
    );

    const { result, rerender } = renderHook(({ id }: { id: string }) => useGatewayAskQuestions(id), { initialProps: { id: 'c-a' } });
    await waitFor(() => expect(result.current.pending?.id).toBe('ask-a'));

    rerender({ id: 'c-b' });
    // The stale ask-a must be cleared immediately, before c-b's own (still in-flight) fetch settles.
    expect(result.current.pending).toBeNull();

    await act(async () => {
      resolveSecond?.(jsonResponse({ ok: true, turns: [], events: [] }));
      await Promise.resolve();
    });
    expect(result.current.pending).toBeNull();
  });

  it('submit() calls the real answer route for the CURRENT pending ask id and reports the outcome', async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/answer')) {
          calls.push({ url, body: init?.body !== undefined ? JSON.parse(String(init.body)) : undefined });
          return jsonResponse({ ok: true, answered: true, id: 'ask-1' });
        }
        return jsonResponse({ ok: true, turns: [], events: [askQuestionsEvent('ask-1', [{ question: 'Q1' }, { question: 'Q2' }])] });
      }),
    );

    const { result } = renderHook(() => useGatewayAskQuestions('c-1'));
    await waitFor(() => expect(result.current.pending?.id).toBe('ask-1'));

    let outcome: { ok: boolean; error: string | null } | undefined;
    await act(async () => {
      outcome = await result.current.submit(['blue', 'large']);
    });

    expect(outcome?.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/api/ask/ask-1/answer');
    expect(calls[0].body).toEqual({ answers: [{ answer: 'blue' }, { answer: 'large' }] });
  });

  it('submit() with no pending ask is an honest no-op error, never a network call', async () => {
    const fetchSpy = vi.fn(async (_input: unknown) => jsonResponse({ ok: true, turns: [], events: [] }));
    vi.stubGlobal('fetch', fetchSpy);

    const { result } = renderHook(() => useGatewayAskQuestions('c-1'));
    await act(async () => {
      await Promise.resolve();
    });

    let outcome: { ok: boolean; error: string | null } | undefined;
    await act(async () => {
      outcome = await result.current.submit(['x']);
    });
    expect(outcome?.ok).toBe(false);
    expect(fetchSpy.mock.calls.every((call) => !String(call[0]).includes('/answer'))).toBe(true);
  });
});

// fix-ghost-asks (forge-2026-07-30-cc-finish, item 3): the abandoned-ask notice — a pending ask
// that closes via a real `ask_abandoned` event (execution ended / gateway restart) must surface
// as `abandoned`, distinct from the pre-existing silent close on a real `ask_answered`.
describe('useGatewayAskQuestions — abandoned ask notice (fix-ghost-asks item 3)', () => {
  function jsonResponse(body: unknown): Response {
    return { ok: true, status: 200, json: async () => body } as Response;
  }

  it('detects the pending -> abandoned transition on the NEXT poll, clears `pending`, and exposes the real id/reason via `abandoned`', async () => {
    vi.useFakeTimers();
    try {
      let abandoned = false;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: unknown) => {
          const url = String(input);
          if (!url.includes('/api/conversations/c-1') || url.includes('/messages')) return jsonResponse({ ok: true });
          const events = abandoned
            ? [askQuestionsEvent('ask-1', [{ question: 'Q1' }]), { kind: 'ask_abandoned', data: { id: 'ask-1', reason: 'execution_stopped' } }]
            : [askQuestionsEvent('ask-1', [{ question: 'Q1' }])];
          return jsonResponse({ ok: true, turns: [], events });
        }),
      );

      const { result } = renderHook(() => useGatewayAskQuestions('c-1'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0); // flush the initial mount-time check()
      });
      expect(result.current.pending?.id).toBe('ask-1');
      expect(result.current.abandoned).toBeNull();

      abandoned = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONVERSATION_DETAIL_POLL_MS); // trigger the next poll tick
      });

      expect(result.current.pending).toBeNull();
      expect(result.current.abandoned).toEqual({ id: 'ask-1', reason: 'execution_stopped' });

      act(() => result.current.dismissAbandoned());
      expect(result.current.abandoned).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a pending ask that closes via a REAL ask_answered event never sets `abandoned` — the pre-existing silent close is unchanged', async () => {
    vi.useFakeTimers();
    try {
      let answered = false;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: unknown) => {
          const url = String(input);
          if (!url.includes('/api/conversations/c-1') || url.includes('/messages')) return jsonResponse({ ok: true });
          const events = answered
            ? [askQuestionsEvent('ask-1', [{ question: 'Q1' }]), { kind: 'ask_answered', data: { id: 'ask-1' } }]
            : [askQuestionsEvent('ask-1', [{ question: 'Q1' }])];
          return jsonResponse({ ok: true, turns: [], events });
        }),
      );

      const { result } = renderHook(() => useGatewayAskQuestions('c-1'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.pending?.id).toBe('ask-1');

      answered = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONVERSATION_DETAIL_POLL_MS);
      });

      expect(result.current.pending).toBeNull();
      expect(result.current.abandoned).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('switching conversationId clears a stale `abandoned` notice from the PREVIOUS conversation, same as it already clears `pending`', async () => {
    vi.useFakeTimers();
    try {
      let abandonedOnA = false;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: unknown) => {
          const url = String(input);
          if (url.includes('/api/conversations/c-a')) {
            const events = abandonedOnA
              ? [askQuestionsEvent('ask-a', [{ question: 'Q' }]), { kind: 'ask_abandoned', data: { id: 'ask-a', reason: 'gateway_restart' } }]
              : [askQuestionsEvent('ask-a', [{ question: 'Q' }])];
            return jsonResponse({ ok: true, turns: [], events });
          }
          return jsonResponse({ ok: true, turns: [], events: [] });
        }),
      );

      // The ask must genuinely have been PENDING in this hook's own lifetime first — an ask that
      // was already dead before the hook ever loaded it correctly gets no notice at all (nobody
      // ever saw a wizard open for it), which is why this test builds up to the abandonment
      // rather than starting from it (see the two tests above for that already-covered case).
      const { result, rerender } = renderHook(({ id }: { id: string }) => useGatewayAskQuestions(id), { initialProps: { id: 'c-a' } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.pending?.id).toBe('ask-a');

      abandonedOnA = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONVERSATION_DETAIL_POLL_MS);
      });
      expect(result.current.abandoned).toEqual({ id: 'ask-a', reason: 'gateway_restart' });

      rerender({ id: 'c-b' });
      expect(result.current.abandoned).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
