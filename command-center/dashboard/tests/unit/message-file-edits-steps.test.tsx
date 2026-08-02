/**
 * `views/chat/Message.tsx` — real per-turn file edits (checkup #6, diff view) and task progress
 * (checkup #5) render as two collapsible blocks, reusing the existing `.fw-chat-steps` chrome.
 * Both render ONLY when the real gateway record actually carries the data — never a placeholder,
 * never "0 files changed" for a turn that measured nothing.
 *
 * Follows this suite's own established convention (`composer-modes-ui.test.tsx`): a local
 * `buildState`/`renderWithState`/`renderMessage`/`buildTurn` set, `Message` rendered directly
 * against a real `PrototypeContext.Provider`. New file — this WP's own new capability, not an
 * edit piled onto `composer-modes-ui.test.tsx`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import { vi } from 'vitest';

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
    timestamp: '2026-07-29T00:00:00.000Z',
    ...overrides,
  } as unknown as ChatMessage;
}

function renderMessage(message: ChatMessage) {
  return renderWithState(createElement(Message, { message, position: 1, total: 1 }), buildState());
}

afterEach(() => cleanup());

describe('Message — real file_edits render as a collapsible "files changed" block (checkup #6)', () => {
  it('shows the real file path and a real diff for an Edit entry (old lines "-", new lines "+")', () => {
    const message = buildTurn({
      fileEdits: [
        { tool: 'Edit', filePath: 'C:\\proj\\serve.mjs', oldString: "location.replace('/');", newString: "location.replace('/'+location.hash);", content: null },
      ],
    });
    const { container } = renderMessage(message);
    expect(container.textContent).toContain('1 file changed');
    expect(container.textContent).toContain('C:\\proj\\serve.mjs');
    expect(container.textContent).toContain('Edit');
    expect(container.textContent).toContain("- location.replace('/');");
    expect(container.textContent).toContain("+ location.replace('/'+location.hash);");
  });

  it('shows the real file path for a Write entry WITHOUT fabricating a diff (Write has no "before")', () => {
    const message = buildTurn({
      fileEdits: [{ tool: 'Write', filePath: 'C:\\proj\\index.html', oldString: null, newString: null, content: '<!doctype html>\n<title>Hi</title>\n' }],
    });
    const { container } = renderMessage(message);
    expect(container.textContent).toContain('C:\\proj\\index.html');
    expect(container.textContent).toContain('Write');
    // No "-"/"+" diff markers at all — a Write never gets a fabricated added/removed view.
    expect(container.textContent).not.toMatch(/^- |\n- /);
  });

  it('pluralizes correctly for 2+ files', () => {
    const message = buildTurn({
      fileEdits: [
        { tool: 'Write', filePath: '/a.txt', oldString: null, newString: null, content: 'a' },
        { tool: 'Write', filePath: '/b.txt', oldString: null, newString: null, content: 'b' },
      ],
    });
    const { container } = renderMessage(message);
    expect(container.textContent).toContain('2 files changed');
  });

  it('renders NOTHING (no placeholder, no "0 files changed") when the message carries no fileEdits at all', () => {
    const { container } = renderMessage(buildTurn({}));
    expect(container.textContent).not.toMatch(/files? changed/);
  });
});

describe('Message — real todos render as the EXISTING steps progress block (checkup #5)', () => {
  it('shows the real task label/detail/status for a real todo snapshot', () => {
    const message = buildTurn({
      steps: [
        { id: 't-1-todo-0', label: 'Exploring project context', status: 'running', detail: 'Explore project context (files, docs, recent commits)' },
        { id: 't-1-todo-1', label: 'Writing design doc', status: 'waiting', detail: 'Write design doc to docs/superpowers/specs/ and commit' },
      ],
    });
    const { container } = renderMessage(message);
    expect(container.textContent).toContain('2 steps');
    expect(container.textContent).toContain('Exploring project context');
    expect(container.textContent).toContain('Explore project context (files, docs, recent commits)');
  });

  it('renders NOTHING (no placeholder progress block) when the message carries no steps at all', () => {
    const { container } = renderMessage(buildTurn({}));
    expect(container.textContent).not.toMatch(/\d+ steps? ·/);
  });
});
