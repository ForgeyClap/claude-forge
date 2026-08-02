/**
 * ChatView — the real "Forge is asking" question box, now a click-wizard (feat-ask-owner →
 * feat-ask-ui, forge-2026-07-30-cc-finish).
 *
 * Mirrors `chat-delete-conversation.test.tsx`'s own render helper and `STUB_CHAT_CONTROLLER`.
 * Proves the box is wired correctly end-to-end THROUGH ChatView + the real gateway-poll hook: one
 * question at a time (with the pager reachable via `Next`), an ALWAYS-present free-text field
 * alongside chip options, stays visibly open (no close button) while genuinely unanswered, sends
 * the REAL position-correlated answers on submit once the review screen confirms them, and never
 * fabricates an answer when nothing was typed or selected. The wizard's own pager/digit-key/
 * skip/summary mechanics are covered in isolation by `ask-questions-wizard.test.tsx` — this file
 * stays focused on the gateway-integration contract (polling, submit, re-poll-to-close).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import type { ReactElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeAction, PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import { ChatSendContext } from '@/prototype/state/chat-send';
import type { ChatSendController } from '@/prototype/state/chat-send';
import type { Conversation, Project } from '@/prototype/types/prototype-types';
import ChatView from '@/views/chat/ChatView';

function buildProject(id: string, name: string): Project {
  return {
    prototype: true,
    id,
    name,
    description: '',
    type: 'unknown',
    status: 'waiting',
    lastActivity: '2026-07-30T00:00:00.000Z',
    path: `C:\\Users\\YOU\\Documents\\${id}`,
    templateVersion: 'v1',
    pinned: false,
    conversationCount: 0,
    missionCount: 0,
    taskCount: 0,
    agentCount: 0,
    skills: [],
    health: { tests: { passed: 0, failed: 0, skipped: 0 }, openTickets: 0, blockers: 0, score: 0 },
  };
}

const PROJECT_ONE = buildProject('proj-one', 'Project One');

const CONVERSATION_ONE: Conversation = {
  prototype: true,
  id: 'c-one',
  projectId: PROJECT_ONE.id,
  title: 'Ask flow conversation',
  updatedAt: '2 min ago',
  messageCount: 1,
  messages: [],
};

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
    activeProjectId: PROJECT_ONE.id,
    activeConversationId: CONVERSATION_ONE.id,
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

const STUB_CHAT_CONTROLLER: ChatSendController = {
  run: { runId: null, status: null, active: false },
  canSend: true,
  disabledReason: null,
  sending: false,
  stopping: false,
  send: async () => ({ ok: true, error: null }),
  stop: async () => ({ ok: true, error: null }),
};

function renderChatView(dispatch: (action: PrototypeAction) => void, state: PrototypeState) {
  const value: StoreValue = { state, dispatch };
  const tree: ReactElement = createElement(
    ChatSendContext.Provider,
    { value: STUB_CHAT_CONTROLLER },
    createElement(PrototypeContext.Provider, { value }, createElement(ChatView)),
  );
  return render(createElement(MemoryRouter, null, tree));
}

const ASK_QUESTIONS_EVENT = {
  kind: 'ask_questions',
  data: {
    id: 'ask-1',
    questions: [
      { header: 'Palette', question: 'Which color should the header use?', options: ['Ember', 'Slate'], multiSelect: false },
      { question: 'Any other pages needed?', options: ['Pricing', 'FAQ'], multiSelect: true },
    ],
  },
};

function conversationDetailResponse(events: readonly Record<string, unknown>[]) {
  return { ok: true, status: 200, json: async () => ({ ok: true, meta: { title: CONVERSATION_ONE.title }, turns: [], events }) };
}

describe('ChatView — "Forge is asking" question box', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders ONE question at a time (with its own options + an ALWAYS-present free-text field), pages to the next via "Review answers", and stays open with no close button', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes('/api/conversations/' + CONVERSATION_ONE.id) && !url.includes('/messages') && !url.includes('/stream')) {
          return conversationDetailResponse([ASK_QUESTIONS_EVENT]);
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }),
    );
    const state = buildState({ data: { ...EMPTY_DATASET, projects: [PROJECT_ONE], conversations: [CONVERSATION_ONE] } });
    renderChatView(vi.fn(), state);

    const dialog = await screen.findByRole('dialog', { name: 'Forge is asking' });
    expect(dialog).toHaveTextContent('Which color should the header use?');
    expect(screen.getByRole('button', { name: 'Ember' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Slate' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/something else/i)).toBeInTheDocument();
    // Question 2 is not on screen yet — one question at a time is the whole point of the wizard.
    expect(screen.queryByText('Any other pages needed?')).toBeNull();
    // hideClose: no "Close" icon-button on this specific modal.
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    expect(dialog).toHaveTextContent('Any other pages needed?');
    expect(screen.getByRole('button', { name: 'Pricing' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'FAQ' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/something else/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });

  it('Send (on the review screen) is disabled until every question has a real answer, then posts the REAL position-correlated answers', async () => {
    const answerCalls: { body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/api/ask/ask-1/answer')) {
          answerCalls.push({ body: init?.body !== undefined ? JSON.parse(String(init.body)) : undefined });
          return { ok: true, status: 200, json: async () => ({ ok: true, answered: true, id: 'ask-1' }) };
        }
        if (url.includes('/api/conversations/' + CONVERSATION_ONE.id) && !url.includes('/messages') && !url.includes('/stream')) {
          return conversationDetailResponse([ASK_QUESTIONS_EVENT]);
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }),
    );
    const state = buildState({ data: { ...EMPTY_DATASET, projects: [PROJECT_ONE], conversations: [CONVERSATION_ONE] } });
    renderChatView(vi.fn(), state);

    await screen.findByRole('dialog', { name: 'Forge is asking' });
    // Page straight to the review screen without answering anything.
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    fireEvent.click(screen.getByRole('button', { name: /review answers/i }));
    expect(screen.getByRole('button', { name: 'Send answers' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Send answers' }));
    // A disabled button's click must not have fired the submit handler at all.
    expect(answerCalls).toHaveLength(0);

    // Go back through both questions, answer them for real, then return to review. Every button
    // is re-queried (never a variable held across a footer-shape change) since Back/Next/Review
    // reuse the same footer position for genuinely different buttons.
    fireEvent.click(screen.getByRole('button', { name: /back/i })); // review -> question 2
    fireEvent.click(screen.getByRole('button', { name: /previous/i })); // question 2 -> question 1
    fireEvent.click(screen.getByRole('button', { name: 'Ember' }));
    fireEvent.click(screen.getByRole('button', { name: /^next$/i })); // question 1 -> question 2
    fireEvent.click(screen.getByRole('button', { name: 'Pricing' }));
    fireEvent.click(screen.getByRole('button', { name: /review answers/i })); // question 2 -> review

    await waitFor(() => expect(screen.getByRole('button', { name: 'Send answers' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Send answers' }));

    await waitFor(() => expect(answerCalls).toHaveLength(1));
    expect(answerCalls[0].body).toEqual({ answers: [{ answer: 'Ember' }, { answer: 'Pricing' }] });
  });

  it('typing in the free-text field for a multiSelect question is ADDED alongside a selected chip', async () => {
    const answerCalls: { body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/api/ask/ask-1/answer')) {
          answerCalls.push({ body: init?.body !== undefined ? JSON.parse(String(init.body)) : undefined });
          return { ok: true, status: 200, json: async () => ({ ok: true, answered: true, id: 'ask-1' }) };
        }
        if (url.includes('/api/conversations/' + CONVERSATION_ONE.id) && !url.includes('/messages') && !url.includes('/stream')) {
          return conversationDetailResponse([ASK_QUESTIONS_EVENT]);
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }),
    );
    const state = buildState({ data: { ...EMPTY_DATASET, projects: [PROJECT_ONE], conversations: [CONVERSATION_ONE] } });
    renderChatView(vi.fn(), state);

    await screen.findByRole('dialog', { name: 'Forge is asking' });
    fireEvent.click(screen.getByRole('button', { name: 'Ember' }));
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Pricing' }));
    fireEvent.change(screen.getByPlaceholderText(/something else/i), { target: { value: 'Blog' } });
    fireEvent.click(screen.getByRole('button', { name: /review answers/i }));

    const finalSend = screen.getByRole('button', { name: 'Send answers' });
    await waitFor(() => expect(finalSend).not.toBeDisabled());
    fireEvent.click(finalSend);

    await waitFor(() => expect(answerCalls).toHaveLength(1));
    expect(answerCalls[0].body).toEqual({ answers: [{ answer: 'Ember' }, { answer: 'Pricing, Blog' }] });
  });

  it('once the gateway records a real ask_answered event, the box disappears on the next poll — never lingers after a real answer', async () => {
    let answered = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes('/api/conversations/' + CONVERSATION_ONE.id) && !url.includes('/messages') && !url.includes('/stream')) {
          return conversationDetailResponse(answered ? [ASK_QUESTIONS_EVENT, { kind: 'ask_answered', data: { id: 'ask-1' } }] : [ASK_QUESTIONS_EVENT]);
        }
        if (url.includes('/api/ask/ask-1/answer')) {
          answered = true;
          return { ok: true, status: 200, json: async () => ({ ok: true, answered: true, id: 'ask-1' }) };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }),
    );
    const state = buildState({ data: { ...EMPTY_DATASET, projects: [PROJECT_ONE], conversations: [CONVERSATION_ONE] } });
    renderChatView(vi.fn(), state);

    await screen.findByRole('dialog', { name: 'Forge is asking' });
    fireEvent.click(screen.getByRole('button', { name: 'Ember' }));
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Pricing' }));
    fireEvent.click(screen.getByRole('button', { name: /review answers/i }));
    const sendButton = screen.getByRole('button', { name: 'Send answers' });
    await waitFor(() => expect(sendButton).not.toBeDisabled());
    fireEvent.click(sendButton);

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Forge is asking' })).toBeNull(), { timeout: 5000 });
  });

  it('fixtures (no production chat controller mounted): no box ever appears, and the conversation detail route is never polled for it', async () => {
    const fetchSpy = vi.fn(async (_input: unknown) => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchSpy);
    const state = buildState({ data: { ...EMPTY_DATASET, projects: [PROJECT_ONE], conversations: [CONVERSATION_ONE] } });
    const value: StoreValue = { state, dispatch: vi.fn() };
    render(
      createElement(
        MemoryRouter,
        null,
        createElement(PrototypeContext.Provider, { value }, createElement(ChatView)),
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('dialog', { name: 'Forge is asking' })).toBeNull();
    expect(fetchSpy.mock.calls.some((call) => String(call[0]).includes(CONVERSATION_ONE.id))).toBe(false);
  });
});
