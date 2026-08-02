/**
 * `views/chat/Message.tsx` — feat-live-stream item 3 (real per-turn shell commands render as a
 * collapsible "commands run" block, mirroring `message-file-edits-steps.test.tsx`'s own
 * established `.fw-chat-steps`-chrome-reuse convention) and item 1 (a live-running placeholder
 * message shows a visible "running" indicator).
 *
 * New file — this WP's own new capability, not an edit piled onto
 * `message-file-edits-steps.test.tsx` (matches that file's own header note on this convention).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';

import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import type { ChatMessage } from '@/prototype/types/prototype-types';
import { Message } from '@/views/chat/Message';

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

function renderWithState(ui: ReturnType<typeof createElement>, state: PrototypeState) {
  const value: StoreValue = { state, dispatch: vi.fn() };
  return render(createElement(PrototypeContext.Provider, { value }, ui));
}

function buildTurn(overrides: Record<string, unknown>): ChatMessage {
  return {
    id: 'msg-x',
    author: 'forge',
    body: 'Done.',
    timestamp: '2026-07-30T00:00:00.000Z',
    ...overrides,
  } as unknown as ChatMessage;
}

function renderMessage(message: ChatMessage) {
  return renderWithState(createElement(Message, { message, position: 1, total: 1 }), buildState());
}

afterEach(() => cleanup());

describe('Message — real shell_commands render as a collapsible "commands run" block (feat-live-stream item 3)', () => {
  it('shows the real command, description, and result for a completed Bash command', () => {
    const message = buildTurn({
      shellCommands: [
        { id: 'toolu_1', command: 'echo mock-command', description: 'Run a mock shell command', result: 'mock-command\n', isError: false },
      ],
    });
    const { container } = renderMessage(message);
    expect(container.textContent).toContain('1 command run');
    expect(container.textContent).toContain('echo mock-command');
    expect(container.textContent).toContain('Run a mock shell command');
    expect(container.textContent).toContain('mock-command');
  });

  it('pluralizes correctly for 2+ commands', () => {
    const message = buildTurn({
      shellCommands: [
        { id: 'toolu_1', command: 'echo a', description: null, result: null, isError: null },
        { id: 'toolu_2', command: 'echo b', description: null, result: null, isError: null },
      ],
    });
    const { container } = renderMessage(message);
    expect(container.textContent).toContain('2 commands run');
  });

  it('a command with no result yet (still running) shows the command with no fabricated result text', () => {
    const message = buildTurn({
      shellCommands: [{ id: 'toolu_1', command: 'echo hi', description: 'Say hi', result: null, isError: null }],
    });
    const { container } = renderMessage(message);
    expect(container.textContent).toContain('echo hi');
    expect(container.textContent).not.toContain('error');
    expect(container.textContent).not.toContain(' ok');
  });

  it('renders NOTHING (no placeholder, no "0 commands run") when the message carries no shellCommands at all', () => {
    const { container } = renderMessage(buildTurn({}));
    expect(container.textContent).not.toMatch(/commands? run/);
  });
});

describe('Message — the live-running placeholder shows a visible indicator (feat-live-stream item 1)', () => {
  it('a message marked isLiveActivity renders a "RUNNING" status badge and aria-busy', () => {
    const message = buildTurn({ isLiveActivity: true, body: '' });
    const { container } = renderMessage(message);
    const article = container.querySelector('[data-chat-message]');
    expect(article?.getAttribute('aria-busy')).toBe('true');
    expect(container.textContent).toContain('RUNNING');
  });

  it('an ordinary (non-live) message never shows the "RUNNING" badge', () => {
    const { container } = renderMessage(buildTurn({}));
    expect(container.textContent).not.toContain('RUNNING');
  });
});
