/**
 * feat-composer-power (forge-2026-07-29-cc-finish) — message queueing.
 *
 * Locks in: a message typed/queued while a run is active is NEVER attempted against `onSend`
 * immediately (the gateway would 409 it); it shows in a visible, removable waiting list instead,
 * and is genuinely sent — through the exact same `onSend` path as a normal Send — once `streaming`
 * goes false. Mode/effort are frozen to what was selected at queue time. A failed flush keeps the
 * item with its real reason and is never silently retried.
 *
 * Follows this suite's own established conventions (`composer-modes-ui.test.tsx`): a local
 * `buildState`/`renderComposer` pair, `PrototypeContext.Provider` rendered directly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import type { ReactElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import { Composer } from '@/views/chat/Composer';
import type { ComposerProps } from '@/views/chat/Composer';
import {
  enqueueMessage,
  markQueuedMessageFailed,
  removeQueuedMessage,
  selectNextQueuedMessage,
} from '@/views/chat/message-queue';

/* ========================================================================== */
/*  1. Pure helpers — no rendering                                            */
/* ========================================================================== */

describe('message-queue pure helpers', () => {
  it('enqueues with a fresh id and no recorded error', () => {
    const queue = enqueueMessage([], { conversationId: 'c1', body: 'hi', mode: 'execute', effort: undefined, model: undefined });
    expect(queue).toHaveLength(1);
    expect(queue[0].conversationId).toBe('c1');
    expect(queue[0].body).toBe('hi');
    expect(queue[0].error).toBeNull();
  });

  it('selectNextQueuedMessage only offers an item for the given conversation with no error', () => {
    let queue = enqueueMessage([], { conversationId: 'c1', body: 'a', mode: 'execute', effort: undefined, model: undefined });
    queue = enqueueMessage(queue, { conversationId: 'c2', body: 'b', mode: 'execute', effort: undefined, model: undefined });
    expect(selectNextQueuedMessage(queue, 'c2')?.body).toBe('b');
    expect(selectNextQueuedMessage(queue, 'c3')).toBeNull();
  });

  it('a failed item is skipped by selectNextQueuedMessage — later items still flush', () => {
    let queue = enqueueMessage([], { conversationId: 'c1', body: 'first', mode: 'execute', effort: undefined, model: undefined });
    queue = enqueueMessage(queue, { conversationId: 'c1', body: 'second', mode: 'execute', effort: undefined, model: undefined });
    queue = markQueuedMessageFailed(queue, queue[0].id, 'refused');
    const next = selectNextQueuedMessage(queue, 'c1');
    expect(next?.body).toBe('second');
  });

  it('removeQueuedMessage drops exactly the targeted item', () => {
    let queue = enqueueMessage([], { conversationId: 'c1', body: 'a', mode: 'execute', effort: undefined, model: undefined });
    queue = enqueueMessage(queue, { conversationId: 'c1', body: 'b', mode: 'execute', effort: undefined, model: undefined });
    const removed = removeQueuedMessage(queue, queue[0].id);
    expect(removed).toHaveLength(1);
    expect(removed[0].body).toBe('b');
  });
});

/* ========================================================================== */
/*  2. Composer integration                                                    */
/* ========================================================================== */

function buildState(overrides: Partial<PrototypeState> = {}): PrototypeState {
  return {
    data: EMPTY_DATASET,
    appearance: 'dark',
    resolvedTheme: 'dark',
    density: 'comfortable',
    reducedMotion: false,
    sidebarCollapsed: false,
    mobileDrawerOpen: false,
    inspectorOpen: false,
    dockOpen: false,
    dockTab: 'activity',
    paletteOpen: false,
    activeProjectId: '',
    activeConversationId: '',
    selection: { kind: 'none' },
    pinnedProjectIds: [],
    projectQuery: '',
    agentFilter: 'all',
    agentLayout: 'grouped',
    taskLayout: 'kanban',
    taskColumnOverrides: {},
    extraMessages: {},
    stream: null,
    claudeCodeState: 'not-connected',
    toasts: [],
    ...overrides,
  };
}

function renderComposer(
  state: PrototypeState,
  onSend: ComposerProps['onSend'],
  streaming: boolean,
) {
  const value: StoreValue = { state, dispatch: vi.fn() };
  const utils = render(
    createElement(
      PrototypeContext.Provider,
      { value },
      createElement(Composer, {
        onSend,
        onStop: () => undefined,
        streaming,
        conversationTitle: 'Test conversation',
        production: true,
      }),
    ),
  );
  return { ...utils, value };
}

/** Rerenders the SAME tree with a new `streaming` value — the same component instance, so its
 *  queue/flushing state survives (mirrors a real conversation whose active run just finished). */
function rerenderStreaming(
  rerender: (ui: ReactElement) => void,
  state: PrototypeState,
  onSend: ComposerProps['onSend'],
  streaming: boolean,
) {
  const value: StoreValue = { state, dispatch: vi.fn() };
  rerender(
    createElement(
      PrototypeContext.Provider,
      { value },
      createElement(Composer, {
        onSend,
        onStop: () => undefined,
        streaming,
        conversationTitle: 'Test conversation',
        production: true,
      }),
    ),
  );
}

describe('Composer message queue (feat-composer-power)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('queues instead of sending while a run is active, and shows it in a visible waiting list', () => {
    const onSend = vi.fn(() => true);
    const state = buildState({ activeProjectId: 'p1', activeConversationId: 'conv-1' });
    renderComposer(state, onSend, true);

    const field = screen.getByRole('textbox', { name: /Message Forge/ });
    fireEvent.change(field, { target: { value: 'Keep working while busy' } });
    fireEvent.click(screen.getByRole('button', { name: 'Queue message' }));

    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByText('Keep working while busy')).toBeInTheDocument();
    expect(screen.getByText('Waiting')).toBeInTheDocument();
    // The field is cleared — the draft "moved" into the queue.
    expect((screen.getByRole('textbox', { name: /Message Forge/ }) as HTMLTextAreaElement).value).toBe('');
  });

  it('flushes the queued message for real, through the exact onSend path, once streaming goes false', async () => {
    const onSend = vi.fn(() => true);
    const state = buildState({ activeProjectId: 'p1', activeConversationId: 'conv-1' });
    const { rerender } = renderComposer(state, onSend, true);

    // feat-forge-preamble: a fresh project defaults to Bypass, not Execute — explicit Execute
    // selection keeps this test's own point (a byte-identical, field-less flushed send) intact.
    fireEvent.click(screen.getByRole('radio', { name: 'Execute' }));
    const field = screen.getByRole('textbox', { name: /Message Forge/ });
    fireEvent.change(field, { target: { value: 'Send me later' } });
    fireEvent.click(screen.getByRole('button', { name: 'Queue message' }));
    expect(onSend).not.toHaveBeenCalled();

    rerenderStreaming(rerender, state, onSend, false);

    await waitFor(() => expect(onSend).toHaveBeenCalledWith('Send me later'));
    await waitFor(() => expect(screen.queryByText('Send me later')).toBeNull());
  });

  it('freezes mode/effort to the choice at queue time, not a later picker change', async () => {
    const onSend = vi.fn(() => true);
    const state = buildState({ activeProjectId: 'p1', activeConversationId: 'conv-1' });
    const { rerender } = renderComposer(state, onSend, true);

    fireEvent.click(screen.getByRole('radio', { name: 'Bypass' }));
    const field = screen.getByRole('textbox', { name: /Message Forge/ });
    fireEvent.change(field, { target: { value: 'Frozen mode' } });
    fireEvent.click(screen.getByRole('button', { name: 'Queue message' }));

    // The picker changes AFTER queueing — must not affect the already-queued item.
    fireEvent.click(screen.getByRole('radio', { name: 'Execute' }));

    rerenderStreaming(rerender, state, onSend, false);

    await waitFor(() => expect(onSend).toHaveBeenCalledWith('Frozen mode', 'bypass'));
  });

  it('a queued message can be removed before it ever sends', async () => {
    const onSend = vi.fn(() => true);
    const state = buildState({ activeProjectId: 'p1', activeConversationId: 'conv-1' });
    const { rerender } = renderComposer(state, onSend, true);

    const field = screen.getByRole('textbox', { name: /Message Forge/ });
    fireEvent.change(field, { target: { value: 'Never mind' } });
    fireEvent.click(screen.getByRole('button', { name: 'Queue message' }));
    expect(screen.getByText('Never mind')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove queued message' }));
    expect(screen.queryByText('Never mind')).toBeNull();

    rerenderStreaming(rerender, state, onSend, false);
    // Give the flush effect a tick to (not) fire.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('a failed flush keeps the item with its real reason and never auto-retries', async () => {
    const onSend = vi.fn(async () => ({ ok: false, error: 'A run is already in progress in this conversation.' }));
    const state = buildState({ activeProjectId: 'p1', activeConversationId: 'conv-1' });
    const { rerender } = renderComposer(state, onSend, true);

    const field = screen.getByRole('textbox', { name: /Message Forge/ });
    fireEvent.change(field, { target: { value: 'Will fail' } });
    fireEvent.click(screen.getByRole('button', { name: 'Queue message' }));

    rerenderStreaming(rerender, state, onSend, false);

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText('A run is already in progress in this conversation.')).toBeInTheDocument());
    // The message itself is still visible — a real refusal, never silently dropped.
    expect(screen.getByText('Will fail')).toBeInTheDocument();

    // A further, unrelated rerender must not trigger a second attempt (no retry loop).
    rerenderStreaming(rerender, state, onSend, false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onSend).toHaveBeenCalledTimes(1);
  });
});
