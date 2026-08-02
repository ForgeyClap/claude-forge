/**
 * feat-model-picker (forge-2026-07-29-cc-finish, WP feat-model-picker) — the composer's model
 * picker, its per-project persistence, the real request body it produces, and the honest
 * "requested vs. actually ran" chip on the assistant reply.
 *
 * Follows this suite's own established conventions: a local `buildState`/`renderComposer` pair
 * mirroring `composer-modes-ui.test.tsx`'s exact shape, `Message`/`MessageList` rendered directly
 * against a real `PrototypeContext.Provider` the same way `no-prototype-copy.test.ts` does, and a
 * stubbed-`fetch` router for `useGatewayChatSendController` mirroring
 * `gateway-chat-crossproject.test.ts`'s own precedent for that seam.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import type { ReactElement } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';

import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import type { ChatMessage } from '@/prototype/types/prototype-types';
import { Composer } from '@/views/chat/Composer';
import type { ComposerProps } from '@/views/chat/Composer';
import { MODEL_VALUES, isChatSendModel, sendArgsFor } from '@/views/chat/compose-args';
import { Message } from '@/views/chat/Message';
import { MessageList } from '@/views/chat/MessageList';
import { toGatewayMessage, useGatewayChatSendController } from '@/prototype/state/gateway-chat';

/* ========================================================================== */
/*  1. sendArgsFor / isChatSendModel — pure, no rendering                    */
/* ========================================================================== */

describe('sendArgsFor — model (feat-model-picker)', () => {
  it('omits model entirely when not chosen (mirrors mode/effort omission exactly)', () => {
    expect(sendArgsFor('hello', 'execute', undefined)).toEqual(['hello']);
    expect(sendArgsFor('hello', 'execute', undefined, undefined)).toEqual(['hello']);
  });

  it('fills the mode+effort positions to reach a real model choice, even when both are default', () => {
    expect(sendArgsFor('hello', 'execute', undefined, 'claude-opus-5[1m]')).toEqual(['hello', 'execute', undefined, 'claude-opus-5[1m]']);
  });

  it('includes mode+effort+model together when all three are real, non-default choices', () => {
    expect(sendArgsFor('hello', 'bypass', 'max', 'claude-fable-5')).toEqual(['hello', 'bypass', 'max', 'claude-fable-5']);
  });
});

describe('isChatSendModel — the picker\'s own four-full-id allowlist (2026-07-30: Opus is the CLI-verified "[1m]" id)', () => {
  it('accepts exactly the four real full ids the picker offers', () => {
    for (const value of MODEL_VALUES) expect(isChatSendModel(value)).toBe(true);
    expect(isChatSendModel('claude-opus-5[1m]')).toBe(true);
  });

  it('rejects a short alias (the picker itself never sends one), a plain non-bracket Opus id (no longer a picker choice), and any unknown string', () => {
    expect(isChatSendModel('opus')).toBe(false);
    expect(isChatSendModel('gpt-5')).toBe(false);
    expect(isChatSendModel('claude-opus-5')).toBe(false);
  });
});

/* ========================================================================== */
/*  Shared fixtures                                                            */
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

function renderWithState(ui: ReactElement, state: PrototypeState) {
  const value: StoreValue = { state, dispatch: vi.fn() };
  return render(createElement(PrototypeContext.Provider, { value }, ui));
}

function renderComposer(state: PrototypeState, onSend: ComposerProps['onSend'] = vi.fn(() => true)) {
  const utils = renderWithState(
    createElement(Composer, {
      onSend,
      onStop: () => undefined,
      streaming: false,
      conversationTitle: 'Test conversation',
      production: true,
    }),
    state,
  );
  return { ...utils, onSend };
}

/* ========================================================================== */
/*  2. Composer — the model picker menu                                       */
/* ========================================================================== */

describe('Composer model picker (feat-model-picker)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('sends model="claude-opus-5[1m]" once Opus (1M context) is picked, filling mode/effort with their defaults', () => {
    const onSend = vi.fn(() => true);
    renderComposer(buildState({ activeProjectId: 'p1' }), onSend);
    // feat-forge-preamble: a fresh project defaults to Bypass, not Execute — explicitly select
    // Execute so this test still isolates the model picker's own contribution to the send args.
    fireEvent.click(screen.getByRole('radio', { name: 'Execute' }));

    // The trigger's own visible label IS the current choice — starts as "Model" (see
    // `mode-controls.tsx`'s own comment for why it is not "Default", unlike the Effort trigger).
    fireEvent.click(screen.getByRole('button', { name: 'Model' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Opus \(1M context\)/ }));

    const field = screen.getByRole('textbox', { name: /Message Forge/ });
    fireEvent.change(field, { target: { value: 'Go' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    // 2026-07-30 CORRECTION: real, non-mock CLI runs proved 'claude-opus-5[1m]' is accepted
    // `--model` INPUT — the picker sends this exact bracket-suffixed id for "Opus (1M context)".
    expect(onSend).toHaveBeenCalledWith('Go', 'execute', undefined, 'claude-opus-5[1m]');
  });

  it('sends neither mode, effort, nor model for a plain Execute + Default + Default send', () => {
    const onSend = vi.fn(() => true);
    renderComposer(buildState({ activeProjectId: 'p1' }), onSend);
    // feat-forge-preamble: a fresh project defaults to Bypass, not Execute — explicit Execute
    // selection keeps this test's own point (a truly byte-identical, field-less send) intact.
    fireEvent.click(screen.getByRole('radio', { name: 'Execute' }));

    const field = screen.getByRole('textbox', { name: /Message Forge/ });
    fireEvent.change(field, { target: { value: 'Plain message' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(onSend).toHaveBeenCalledWith('Plain message');
  });

  it('shows all five options with the owner-specified titles and descriptions, and marks the current choice', () => {
    renderComposer(buildState({ activeProjectId: 'p1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Model' }));

    expect(screen.getByText('Select a model')).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: /Default \(recommended\)/ })).toHaveAttribute('aria-checked', 'true');
    // "Default (recommended)" and "Opus (1M context)" share the EXACT SAME description line
    // (the owner's own literal spec) — two real matches, not a bug in this assertion.
    expect(screen.getAllByText('Opus 5 with 1M context · Best for everyday, complex tasks')).toHaveLength(2);
    expect(screen.getByText('Fable 5 · Most capable for your hardest and longest-running tasks')).toBeInTheDocument();
    expect(screen.getByText('Sonnet 5 · Efficient for routine tasks')).toBeInTheDocument();
    expect(screen.getByText('Haiku 4.5 · Fastest for quick answers')).toBeInTheDocument();
  });

  it('persists a model choice across a remount, scoped PER PROJECT (mirrors sendMode, not the global effort choice)', () => {
    const { unmount } = renderComposer(buildState({ activeProjectId: 'p1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Model' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^Fable/ }));
    expect(screen.getByRole('button', { name: 'Fable' })).toBeInTheDocument();
    unmount();

    renderComposer(buildState({ activeProjectId: 'p1' }));
    expect(screen.getByRole('button', { name: 'Fable' })).toBeInTheDocument();
  });

  it('a model choice made under one project does NOT carry over into a DIFFERENT project', () => {
    const { unmount } = renderComposer(buildState({ activeProjectId: 'p1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Model' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^Sonnet/ }));
    unmount();

    renderComposer(buildState({ activeProjectId: 'p2' }));
    expect(screen.getByRole('button', { name: 'Model' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sonnet' })).toBeNull();
  });

  it('no active project (empty id) always resolves to Default, regardless of another project\'s stored choice', () => {
    const { unmount } = renderComposer(buildState({ activeProjectId: 'p1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Model' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^Haiku/ }));
    unmount();

    renderComposer(buildState({ activeProjectId: '' }));
    expect(screen.getByRole('button', { name: 'Model' })).toBeInTheDocument();
  });
});

/* ========================================================================== */
/*  3. useGatewayChatSendController — model rides in the real POST body       */
/* ========================================================================== */

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

describe('useGatewayChatSendController — model rides in the real POST body (feat-model-picker)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('a chosen model is included in the real POST /messages body', async () => {
    const calls: { readonly url: string; readonly body: Record<string, unknown> | undefined }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
        calls.push({ url, body });
        if (/\/api\/conversations\/[^/]+\/messages$/.test(url)) {
          return jsonResponse({ ok: true, execution_started: false, turn_id: null });
        }
        return jsonResponse({ ok: true });
      }),
    );
    const { result } = renderHook(() =>
      useGatewayChatSendController({
        activeProjectId: 'p1',
        activeConversationId: 'c1',
        knownConversations: [{ id: 'c1', projectId: 'p1' }],
        dispatch: vi.fn(),
      }),
    );

    await act(async () => {
      const outcome = await result.current.send('hello', 'execute', undefined, 'claude-opus-5[1m]');
      expect(outcome.ok).toBe(true);
    });

    const post = calls.find((c) => c.url.includes('/api/conversations/c1/messages'));
    expect(post?.body).toEqual({ text: 'hello', model: 'claude-opus-5[1m]' });
  });

  it('omitting model omits the field entirely from the body — never a guessed default', async () => {
    const calls: { readonly url: string; readonly body: Record<string, unknown> | undefined }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
        calls.push({ url, body });
        if (/\/api\/conversations\/[^/]+\/messages$/.test(url)) {
          return jsonResponse({ ok: true, execution_started: false, turn_id: null });
        }
        return jsonResponse({ ok: true });
      }),
    );
    const { result } = renderHook(() =>
      useGatewayChatSendController({
        activeProjectId: 'p1',
        activeConversationId: 'c1',
        knownConversations: [{ id: 'c1', projectId: 'p1' }],
        dispatch: vi.fn(),
      }),
    );

    await act(async () => {
      await result.current.send('hello');
    });

    const post = calls.find((c) => c.url.includes('/api/conversations/c1/messages'));
    expect(post?.body).toEqual({ text: 'hello' });
    expect(post?.body).not.toHaveProperty('model');
  });
});

/* ========================================================================== */
/*  4. Message — the requested-vs-actually-ran chip, never fabricated         */
/* ========================================================================== */

function buildTurn(overrides: Record<string, unknown>): ChatMessage {
  return {
    id: 'msg-x',
    author: 'forge',
    body: 'Here is the answer.',
    timestamp: '2026-07-29T00:00:00.000Z',
    ...overrides,
  } as unknown as ChatMessage;
}

function renderMessageWithRequested(message: ChatMessage, requestedModel: string | null) {
  return renderWithState(
    createElement(Message, { message, position: 1, total: 1, requestedModel }),
    buildState(),
  );
}

describe('Message — model chip built from real, gateway-carried fields (feat-model-picker)', () => {
  afterEach(() => cleanup());

  it('shows the real actually-run model alone when nothing was requested', () => {
    // A real assistant turn, produced through the ACTUAL production mapping (`toGatewayMessage`) —
    // never a hand-rolled ChatMessage stand-in (mirrors gateway-usage-token-model-capture.test.ts's
    // own precedent for this seam).
    const message = toGatewayMessage(
      { type: 'turn', turn_id: 't-1', role: 'assistant', text: 'ok', model: 'claude-fable-5' },
      0,
    );
    const { container } = renderMessageWithRequested(message, null);
    expect(container.textContent).toContain('claude-fable-5');
    expect(container.textContent).not.toContain('gevraagd');
  });

  it('shows a plain model chip (no "gevraagd/gedraaid" split) when the requested and actually-run model match', () => {
    const message = toGatewayMessage(
      { type: 'turn', turn_id: 't-1', role: 'assistant', text: 'ok', model: 'claude-opus-5' },
      0,
    );
    const { container } = renderMessageWithRequested(message, 'claude-opus-5');
    expect(container.textContent).toContain('claude-opus-5');
    expect(container.textContent).not.toContain('gevraagd');
  });

  // 2026-07-30 CORRECTION: requesting the real "Opus (1M context)" pick sends
  // 'claude-opus-5[1m]', but the CLI's own real modelUsage report always strips this back to the
  // canonical 'claude-opus-5' (`exec-stream-parse.mjs`'s own `canonicalModel` preference) — a
  // fully-honored request must NOT read as a mismatch just because of this cosmetic suffix.
  it('treats "claude-opus-5[1m]" requested + "claude-opus-5" actually-run as a MATCH, not a mismatch (context-window suffix is cosmetic)', () => {
    const message = toGatewayMessage(
      { type: 'turn', turn_id: 't-1', role: 'assistant', text: 'ok', model: 'claude-opus-5' },
      0,
    );
    const { container } = renderMessageWithRequested(message, 'claude-opus-5[1m]');
    expect(container.textContent).toContain('claude-opus-5');
    expect(container.textContent).not.toContain('gevraagd');
  });

  it('shows BOTH the requested and the actually-run model when they genuinely differ', () => {
    const message = toGatewayMessage(
      { type: 'turn', turn_id: 't-1', role: 'assistant', text: 'ok', model: 'claude-fable-5' },
      0,
    );
    const { container } = renderMessageWithRequested(message, 'claude-opus-5');
    expect(container.textContent).toContain('gevraagd: claude-opus-5');
    expect(container.textContent).toContain('gedraaid: claude-fable-5');
  });

  it('shows NOTHING when the run never reported a real model — never shows the requested value as though it were the truth', () => {
    // A turn the gateway recorded no usage for (mock mode / spawn error): `model` is genuinely null.
    const message = toGatewayMessage(
      { type: 'turn', turn_id: 't-1', role: 'assistant', text: 'ok', model: null },
      0,
    );
    const { container } = renderMessageWithRequested(message, 'claude-opus-5');
    expect(container.textContent).not.toContain('gevraagd');
    expect(container.textContent).not.toContain('claude-opus-5');
    expect(container.textContent).not.toContain('Cpu');
  });

  it('a user-authored turn never shows a model chip, even if it somehow carried usage-shaped fields', () => {
    const message = buildTurn({ author: 'user', model: 'claude-opus-5' });
    const { container } = renderMessageWithRequested(message, null);
    expect(container.textContent).not.toContain('claude-opus-5');
  });
});

/* ========================================================================== */
/*  5. MessageList — correlates the PRECEDING user turn's requested model      */
/* ========================================================================== */

describe('MessageList — requestedModel correlation (feat-model-picker)', () => {
  afterEach(() => cleanup());

  it('reads the requested model off the immediately preceding real user turn and shows the mismatch chip on the assistant reply', () => {
    const userTurn = toGatewayMessage(
      { type: 'turn', turn_id: 't-0', role: 'user', text: 'use opus please', model: 'claude-opus-5' },
      0,
    );
    const assistantTurn = toGatewayMessage(
      { type: 'turn', turn_id: 't-1', role: 'assistant', text: 'ok', model: 'claude-fable-5' },
      1,
    );
    const { container } = renderWithState(
      createElement(MessageList, {
        messages: [userTurn, assistantTurn],
        streamingId: null,
        conversationTitle: 'Test',
      }),
      buildState(),
    );
    expect(container.textContent).toContain('gevraagd: claude-opus-5');
    expect(container.textContent).toContain('gedraaid: claude-fable-5');
  });

  it('never attaches a requested model to a reply with no real preceding user turn (first message, or two assistant turns in a row)', () => {
    const assistantOnly = toGatewayMessage(
      { type: 'turn', turn_id: 't-0', role: 'assistant', text: 'ok', model: 'claude-fable-5' },
      0,
    );
    const { container } = renderWithState(
      createElement(MessageList, {
        messages: [assistantOnly],
        streamingId: null,
        conversationTitle: 'Test',
      }),
      buildState(),
    );
    expect(container.textContent).toContain('claude-fable-5');
    expect(container.textContent).not.toContain('gevraagd');
  });

  it('a preceding user turn that requested nothing (Default) shows no requested/actual split — just the real actually-run model', () => {
    const userTurn = toGatewayMessage(
      { type: 'turn', turn_id: 't-0', role: 'user', text: 'go', model: null },
      0,
    );
    const assistantTurn = toGatewayMessage(
      { type: 'turn', turn_id: 't-1', role: 'assistant', text: 'ok', model: 'claude-opus-5' },
      1,
    );
    const { container } = renderWithState(
      createElement(MessageList, {
        messages: [userTurn, assistantTurn],
        streamingId: null,
        conversationTitle: 'Test',
      }),
      buildState(),
    );
    expect(container.textContent).toContain('claude-opus-5');
    expect(container.textContent).not.toContain('gevraagd');
  });
});
