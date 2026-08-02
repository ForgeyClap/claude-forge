/**
 * fix-ui-clutter (forge-2026-07-29-cc-finish) — one targeted test per owner-reported item.
 *
 * The owner's 7 complaints (screenshots, see the WP): (1) a wall of repeated
 * "UNAVAILABLE UNAVAILABLE" rows/paragraphs in the Live usage panel, (2) a Cost row / $ display
 * the owner (subscription user, not credits) does not want, (3) raw conversation ids
 * (`c-ms6e73oh-…`) shown as visible text instead of a title, (4) ChatView's "+ New" not driving
 * a real new conversation, (5) the Skills/@ picker growing unbounded and covering the thread,
 * (6) "TESTS 0 passed · 0 failed · 0 skipped" rendered for a project with no doctor verdict yet
 * (F3-class: not measured ≠ zero), (7) a Plan/Execute mode picker next to Send.
 *
 * This file does not re-prove the underlying data layer (already covered by
 * `gateway-usage-conversation-cost.test.ts`, `gateway-chat-crossproject.test.ts`, etc.) — it
 * proves the RENDER/WIRING fix for each item, reusing this suite's established harnesses
 * (`no-prototype-copy.test.ts`'s scan helpers, `gateway-chat-crossproject.test.ts`'s
 * body-recording fetch router) rather than forking them.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { collectRenderedText, scanForbidden } from './no-prototype-copy.test';

import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { ChatSendContext } from '@/prototype/state/chat-send';
import type { ChatSendController } from '@/prototype/state/chat-send';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import type { Project } from '@/prototype/types/prototype-types';

import { UsageDetails } from '@/components/usage/UsageDetails';
import { buildGatewayUsageState } from '@/prototype/state/gateway-usage';
import type { ConnectionState } from '@/prototype/state/bridge-client';
import type { GatewayLatency } from '@/prototype/state/gateway-adapter';

import ChatView from '@/views/chat/ChatView';
import { Composer } from '@/views/chat/Composer';
import Inspector from '@/components/shell/Inspector';
import { useGatewayConversations, useGatewayChatSendController } from '@/prototype/state/gateway-chat';

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

function renderWithState(ui: ReturnType<typeof createElement>, state: PrototypeState, dispatch = vi.fn()) {
  const value: StoreValue = { state, dispatch };
  return { ...render(createElement(PrototypeContext.Provider, { value }, ui)), dispatch };
}

const CONNECTION_STATE: ConnectionState = {
  status: 'CONNECTED',
  since: 0,
  bridgeInstanceId: null,
  reconnectAttempts: 0,
  nextRetryInMs: null,
  lastFrameAt: null,
  lastHeartbeatAt: null,
  reconciling: [],
  startCommand: '',
  endpoint: '',
  detail: null,
};

const LATENCY_STATE: GatewayLatency = {
  measured: false,
  p95Ms: null,
  sampleCount: 0,
  clockBasis: 'same-process',
};

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/* ========================================================================== */
/*  Item 1 + 2 — Live usage panel: no repeated UNAVAILABLE wall, no Cost/$     */
/* ========================================================================== */

describe('item 1 + 2 — UsageDetails collapses unmeasured rows and never renders Cost/$', () => {
  it('renders exactly ONE "not measured" summary line, zero "$" characters, and no Cost row', () => {
    // A real conversation with a real cost/duration total — the exact shape that used to also
    // render a "Cost (model-priced)" row alongside 16 other individually-labelled UNAVAILABLE
    // rows (each showing the literal word "UNAVAILABLE" twice: once as the value, once as its
    // accuracy chip).
    const usage = buildGatewayUsageState('conversation', 'c-1', { costUsd: 1.23, elapsedMs: 5000 });

    render(
      createElement(UsageDetails, {
        open: true,
        onClose: () => undefined,
        scope: 'conversation',
        scopeId: 'c-1',
        usage,
        run: null,
        connection: CONNECTION_STATE,
        clientLatency: LATENCY_STATE,
      }),
    );

    const text = document.body.textContent ?? '';

    // Owner preference (item 2): no dollar sign anywhere in this panel, and no row labelled Cost.
    expect(text).not.toContain('$');
    expect(text).not.toContain('Cost (model-priced)');

    // Item 1: the "wall" (repeated UNAVAILABLE rows) is gone — the literal word "UNAVAILABLE"
    // may still appear for genuinely distinct concepts elsewhere in the panel (Session id,
    // Rebuilt at — out of this item's scope), but the "Measured fields" section's collapse note
    // appears exactly ONCE, not once per unmeasured field.
    const occurrences = text.split('Not measured by this gateway').length - 1;
    expect(occurrences).toBe(1);

    // The one real field (Elapsed, since costUsd is intentionally hidden) still gets its own row.
    expect(text).toContain('Elapsed (observed)');
  });
});

/* ========================================================================== */
/*  Item 3 — a titleless conversation falls back to "New chat — <project>",   */
/*  never its own raw id                                                      */
/* ========================================================================== */

describe('item 3 — conversation title never falls back to the raw id', () => {
  it('a conversation with no real title reads as "New chat — <project>"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.endsWith('/api/conversations')) {
          return jsonResponse({
            conversations: [
              { id: 'c-ms6e73oh-568e55ec', title: null, project: 'demo-project', updated_at: '', turn_count: 0 },
            ],
          });
        }
        return jsonResponse({});
      }),
    );

    const { result } = renderHook(() => useGatewayConversations(''));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(result.current).toHaveLength(1);
    expect(result.current[0].title).toBe('New chat — demo-project');
    expect(result.current[0].title).not.toContain('c-ms6e73oh');
  });
});

/* ========================================================================== */
/*  Item 4 — ChatView's "+ New" drives the real requestNewConversation flow    */
/* ========================================================================== */

describe('item 4 — ChatView "+ New" starts a real conversation, no page reload', () => {
  it('POSTs /api/conversations and activates the returned id — never a local-only reset', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? 'GET').toUpperCase();
        if (method === 'POST' && url.endsWith('/api/conversations')) {
          return jsonResponse({ conversation: { id: 'c-brand-new', project: 'proj-1', title: null } });
        }
        return jsonResponse({});
      }),
    );

    const project: Project = {
      prototype: true,
      id: 'proj-1',
      name: 'Project One',
      description: '',
      type: 'unknown',
      status: 'waiting',
      lastActivity: '',
      path: '/workspace/proj-1',
      templateVersion: '',
      pinned: false,
      conversationCount: 1,
      missionCount: 0,
      taskCount: 0,
      agentCount: 0,
      skills: [],
      health: { tests: { passed: 0, failed: 0, skipped: 0 }, openTickets: 0, blockers: 0, score: 0 },
    };
    const state = buildState({
      data: {
        ...EMPTY_DATASET,
        projects: [project],
        conversations: [
          {
            prototype: true,
            id: 'c-1',
            projectId: 'proj-1',
            title: 'Existing chat',
            updatedAt: '',
            messageCount: 0,
            messages: [],
          },
        ],
      },
      activeProjectId: 'proj-1',
      activeConversationId: 'c-1',
    });

    const STUB_CHAT: ChatSendController = {
      run: { runId: null, status: null, active: false },
      canSend: true,
      disabledReason: null,
      sending: false,
      stopping: false,
      send: async () => ({ ok: true, error: null }),
      stop: async () => ({ ok: true, error: null }),
    };

    const dispatch = vi.fn();
    const value: StoreValue = { state, dispatch };
    render(
      createElement(
        PrototypeContext.Provider,
        { value },
        createElement(ChatSendContext.Provider, { value: STUB_CHAT }, createElement(ChatView)),
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: 'New' }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls as unknown as readonly [unknown, RequestInit | undefined][];
    const created = calls.some(
      (call) => String(call[0]).endsWith('/api/conversations') && (call[1]?.method ?? 'GET').toUpperCase() === 'POST',
    );
    expect(created).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({ type: 'conversation/activate', id: 'c-brand-new' });
  });
});

/* ========================================================================== */
/*  Item 5 — the Skills/@ picker is height-bounded and does not repeat a flat  */
/*  "No description recorded." line per empty-description item                */
/* ========================================================================== */

describe('item 5 — the composer menu popover is height-bounded and skill items degrade gracefully', () => {
  const CHAT_CSS = readFileSync(resolve(process.cwd(), 'src/views/chat/chat.css'), 'utf8');

  it('.fw-chat-menu__panel is capped to a bounded max-height and scrolls internally', () => {
    const panelBlock = CHAT_CSS.slice(CHAT_CSS.indexOf('.fw-chat-menu__panel {'));
    expect(panelBlock).toMatch(/max-block-size:\s*40vh/);
    expect(panelBlock).toMatch(/overflow-y:\s*auto/);
  });

  it('a skill with no recorded description renders only its name, never "No description recorded."', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ skills: [{ slug: 'bare-skill', name: 'Bare Skill', description: '' }] }),
      ),
    );

    const project: Project = {
      prototype: true,
      id: 'proj-1',
      name: 'Project One',
      description: '',
      type: 'unknown',
      status: 'waiting',
      lastActivity: '',
      path: '/workspace/proj-1',
      templateVersion: '',
      pinned: false,
      conversationCount: 0,
      missionCount: 0,
      taskCount: 0,
      agentCount: 0,
      skills: [],
      health: { tests: { passed: 0, failed: 0, skipped: 0 }, openTickets: 0, blockers: 0, score: 0 },
    };
    const state = buildState({ data: { ...EMPTY_DATASET, projects: [project] }, activeProjectId: 'proj-1' });

    renderWithState(
      createElement(Composer, {
        onSend: () => true,
        onStop: () => undefined,
        streaming: false,
        conversationTitle: 'Test conversation',
        production: true,
      }),
      state,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Choose a skill' }));
    expect(await screen.findByText('Bare Skill')).toBeInTheDocument();
    expect(screen.queryByText(/No description recorded/i)).toBeNull();
  });
});

/* ========================================================================== */
/*  Item 6 — "TESTS 0 passed · 0 failed · 0 skipped" must read as absent when  */
/*  no doctor verdict exists yet (present:false)                              */
/* ========================================================================== */

describe('item 6 — Inspector never claims a measured "0 passed / 0 failed / 0 skipped"', () => {
  it('a fresh active project with testsMeasured:false shows "—" for Tests, not three zeros', () => {
    const project: Project = {
      prototype: true,
      id: 'proj-fresh',
      name: 'test',
      description: '',
      type: 'unknown',
      status: 'waiting',
      lastActivity: '',
      path: '/workspace/test',
      templateVersion: '',
      pinned: false,
      conversationCount: 0,
      missionCount: 0,
      taskCount: null,
      agentCount: 0,
      skills: [],
      health: { tests: { passed: 0, failed: 0, skipped: 0 }, openTickets: 0, blockers: 0, score: null, testsMeasured: false },
    };
    const state = buildState({
      data: { ...EMPTY_DATASET, projects: [project] },
      activeProjectId: 'proj-fresh',
      selection: { kind: 'project', id: 'proj-fresh' },
      inspectorOpen: true,
    });

    renderWithState(createElement(Inspector), state);

    const found = scanForbidden(collectRenderedText(document.body));
    expect(found).toEqual([]);

    const text = document.body.textContent ?? '';
    expect(text).not.toContain('0 passed');
    expect(text).not.toContain('0 failed');
    expect(text).not.toContain('0 skipped');
    expect(text).toContain('—');
  });
});

/* ========================================================================== */
/*  Item 7 — a real Plan send carries mode:'plan'; a bare Execute send does not */
/* ========================================================================== */

describe('item 7 — send() only carries mode when Plan was actually chosen', () => {
  function stubMessagesRouter() {
    const calls: { url: string; body: Record<string, unknown> | undefined }[] = [];
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
    return calls;
  }

  it('a Plan send includes mode:"plan" in the POST body', async () => {
    const calls = stubMessagesRouter();
    const dispatch = vi.fn();
    const { result } = renderHook(() =>
      useGatewayChatSendController({
        activeProjectId: 'proj-a',
        activeConversationId: 'c-a1',
        knownConversations: [{ id: 'c-a1', projectId: 'proj-a' }],
        dispatch,
      }),
    );

    await act(async () => {
      await result.current.send('plan this', 'plan');
    });

    const messagePost = calls.find((c) => c.url.includes('/api/conversations/c-a1/messages'));
    expect(messagePost?.body).toEqual({ text: 'plan this', mode: 'plan' });
  });

  it('a default (Execute) send omits mode entirely — byte-identical to the pre-existing behaviour', async () => {
    const calls = stubMessagesRouter();
    const dispatch = vi.fn();
    const { result } = renderHook(() =>
      useGatewayChatSendController({
        activeProjectId: 'proj-a',
        activeConversationId: 'c-a1',
        knownConversations: [{ id: 'c-a1', projectId: 'proj-a' }],
        dispatch,
      }),
    );

    await act(async () => {
      await result.current.send('just execute');
    });

    const messagePost = calls.find((c) => c.url.includes('/api/conversations/c-a1/messages'));
    expect(messagePost?.body).toEqual({ text: 'just execute' });
  });
});
