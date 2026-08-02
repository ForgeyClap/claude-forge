/**
 * ChatView project-mismatch disclosure (fix-chat-mismatch, forge-2026-07-29-cc-finish).
 *
 * BUG THIS GUARDS AGAINST: switch the sidebar's active project while a conversation
 * from a DIFFERENT project stays open. Three screen parts then disagreed about which
 * project is "active": the topbar (the real active project), this view's own
 * breadcrumb/title (`conversation.projectId` — the conversation's own project), and
 * the composer's write-scope hint (`selectActiveProject(state)` — the real active
 * project again). The send path itself was already safe before this fix
 * (`useGatewayChatSendController` in `gateway-chat.ts`, fix-crossproject: a
 * project-mismatched conversation is treated exactly like an unknown one — Send
 * creates a BRAND-NEW conversation in the active project rather than posting into
 * this one) — but nothing on screen said so, which read as a silent, unexplained
 * contradiction right where the write-scope sentence had just made a promise about
 * where a message goes.
 *
 * THE FIX (`ChatView.tsx`): an extra subtitle line, reusing the existing
 * `.fw-chat__subtitle` class (no new CSS, no new component), appears only when
 * `conversation.projectId !== state.activeProjectId` (both non-empty) AND the
 * production chat controller is mounted — the fixture reveal has no per-project
 * send guard at all, so the note would misdescribe what a fixture Send does.
 *
 * Reuses `no-prototype-copy.test.ts`'s exported scan helpers rather than forking
 * them (that file's own header asks extenders to do exactly this).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import type { ReactElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { collectRenderedText, scanForbidden } from './no-prototype-copy.test';
import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import { ChatSendContext } from '@/prototype/state/chat-send';
import type { ChatSendController } from '@/prototype/state/chat-send';
import type { Conversation, Project } from '@/prototype/types/prototype-types';
import ChatView from '@/views/chat/ChatView';
import { Composer } from '@/views/chat/Composer';

/* ========================================================================== */
/*  Fixtures                                                                   */
/* ========================================================================== */

function buildProject(id: string, name: string): Project {
  return {
    prototype: true,
    id,
    name,
    description: '',
    type: 'unknown',
    status: 'waiting',
    lastActivity: '2026-07-29T00:00:00.000Z',
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

const PROJECT_ALPHA = buildProject('proj-alpha', 'Alpha Project');
const PROJECT_BETA = buildProject('proj-beta', 'Beta Project');

/** A real (non-fixture-shaped, for this test's purposes) conversation tagged to Alpha. */
const CONVERSATION_IN_ALPHA: Conversation = {
  prototype: true,
  id: 'conv-alpha-1',
  projectId: PROJECT_ALPHA.id,
  title: 'Alpha thread',
  updatedAt: '2 min ago',
  messageCount: 0,
  messages: [],
};

/** The exact empty floor production starts from — mirrors `no-prototype-copy.test.ts`. */
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

/** A no-op stand-in for the real, gateway-backed chat controller. Never calls fetch. */
const STUB_CHAT_CONTROLLER: ChatSendController = {
  run: { runId: null, status: null, active: false },
  canSend: true,
  disabledReason: null,
  sending: false,
  stopping: false,
  send: async () => ({ ok: true, error: null }),
  stop: async () => ({ ok: true, error: null }),
};

interface RenderOptions {
  /** Omit to mimic fixtures mode (no production chat controller mounted at all). */
  readonly chat?: ChatSendController;
}

function renderChatView(state: PrototypeState, options: RenderOptions = {}) {
  const value: StoreValue = { state, dispatch: () => undefined };
  let tree: ReactElement = createElement(PrototypeContext.Provider, { value }, createElement(ChatView));
  if (options.chat) tree = createElement(ChatSendContext.Provider, { value: options.chat }, tree);
  return render(createElement(MemoryRouter, null, tree));
}

/* ========================================================================== */
/*  Tests                                                                      */
/* ========================================================================== */

describe('ChatView project-mismatch disclosure', () => {
  afterEach(() => cleanup());

  it('states the real outcome, naming BOTH real projects, when the open conversation belongs to a different project than the active one', () => {
    const state = buildState({
      data: { ...EMPTY_DATASET, projects: [PROJECT_ALPHA, PROJECT_BETA], conversations: [CONVERSATION_IN_ALPHA] },
      activeProjectId: PROJECT_BETA.id,
      activeConversationId: CONVERSATION_IN_ALPHA.id,
    });

    const { container } = renderChatView(state, { chat: STUB_CHAT_CONTROLLER });
    const text = collectRenderedText(container);

    expect(text).toContain('This conversation belongs to');
    expect(text).toContain(PROJECT_ALPHA.name);
    expect(text).toContain('starts a new conversation in');
    expect(text).toContain(PROJECT_BETA.name);
    expect(scanForbidden(text)).toEqual([]);
  });

  it('shows nothing extra when the conversation already belongs to the active project (unaffected baseline)', () => {
    const state = buildState({
      data: { ...EMPTY_DATASET, projects: [PROJECT_ALPHA, PROJECT_BETA], conversations: [CONVERSATION_IN_ALPHA] },
      activeProjectId: PROJECT_ALPHA.id,
      activeConversationId: CONVERSATION_IN_ALPHA.id,
    });

    const { container } = renderChatView(state, { chat: STUB_CHAT_CONTROLLER });
    const text = collectRenderedText(container);

    expect(text).not.toContain('This conversation belongs to');
    expect(text).not.toContain('starts a new conversation in');
  });

  it('never shows the mismatch line in fixtures mode (no production chat controller mounted), even with mismatched project ids', () => {
    const state = buildState({
      data: { ...EMPTY_DATASET, projects: [PROJECT_ALPHA, PROJECT_BETA], conversations: [CONVERSATION_IN_ALPHA] },
      activeProjectId: PROJECT_BETA.id,
      activeConversationId: CONVERSATION_IN_ALPHA.id,
    });

    // No `chat` option — mirrors the fixture path, where `useChatSend()` resolves
    // to the context's default (null) because no `ChatSendContext.Provider` is mounted.
    // No `scanForbidden` assertion here: the fixture branch's own PRE-EXISTING,
    // honest "· example thread, not a live session" disclosure (unrelated to this
    // fix, untouched by it) legitimately contains "example" — exactly what
    // `no-prototype-copy.test.ts`'s own header says fixtures are allowed to say.
    // This test's own point is narrower: the mismatch line specifically must stay
    // gated to production, regardless of what else the fixture branch honestly shows.
    const { container } = renderChatView(state);
    const text = collectRenderedText(container);

    expect(text).not.toContain('This conversation belongs to');
    expect(text).not.toContain('starts a new conversation in');
  });
});

/* ========================================================================== */
/*  The composer's write-scope sentence stays correct through a mismatch too  */
/* ========================================================================== */

/**
 * `Composer.tsx`'s write-scope hint (fix-composer-truth, this same run) names
 * `selectActiveProject(state)` — the ACTIVE project — and says nothing about
 * "this conversation". It was never conversation-scoped in the first place, so
 * a project/conversation mismatch cannot make it say anything untrue: the real
 * send path (`gateway-chat.ts`) always ends up running inside the active
 * project's folder, mismatch or not (either by posting straight into a
 * same-project conversation, or by creating a brand-new one in the active
 * project when the open conversation belongs elsewhere). This test proves that
 * invariant directly rather than merely asserting it in prose: the composer,
 * rendered with the SAME mismatched two-project state used above, must still
 * name the ACTIVE project (Beta) and must never mention the conversation's own
 * project (Alpha) — Composer receives no conversation prop at all, so there is
 * nothing in its own props for a mismatch to corrupt.
 */
describe("Composer's write-scope sentence is unaffected by a project/conversation mismatch", () => {
  afterEach(() => cleanup());

  it('names the ACTIVE project only, never the unrelated conversation project, while a mismatch is showing elsewhere', () => {
    const state = buildState({
      data: { ...EMPTY_DATASET, projects: [PROJECT_ALPHA, PROJECT_BETA], conversations: [CONVERSATION_IN_ALPHA] },
      activeProjectId: PROJECT_BETA.id,
      activeConversationId: CONVERSATION_IN_ALPHA.id,
    });
    const value: StoreValue = { state, dispatch: () => undefined };

    const { container } = render(
      createElement(
        PrototypeContext.Provider,
        { value },
        createElement(Composer, {
          onSend: () => true,
          onStop: () => undefined,
          streaming: false,
          conversationTitle: CONVERSATION_IN_ALPHA.title,
          production: true,
        }),
      ),
    );

    const text = collectRenderedText(container);
    expect(text).toContain(PROJECT_BETA.path);
    expect(text).not.toContain(PROJECT_ALPHA.path);
    expect(scanForbidden(text)).toEqual([]);
  });
});
