/**
 * feat-composer-power (forge-2026-07-29-cc-finish) — `/`-slash command menu.
 *
 * Locks in: only REAL, already-wired actions are ever offered (the four real send-mode choices,
 * the six real effort choices, the real Auto-plan toggle, and — only where `ChatView.tsx` wires
 * them in — the real "new conversation"/"delete conversation" actions), a command genuinely
 * performs its action (not a fabricated no-op), and the typed `/command` text is cleared once run
 * rather than left in the draft as though it were about to be sent as a chat message.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { ALL_SLASH_COMMANDS, activeSlashQuery, filterSlashCommands } from '@/views/chat/slash-commands';
import type { SlashCommandContext } from '@/views/chat/slash-commands';
import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import { Composer } from '@/views/chat/Composer';
import type { ComposerProps } from '@/views/chat/Composer';

/* ========================================================================== */
/*  1. Pure helpers — no rendering                                            */
/* ========================================================================== */

function stubContext(overrides: Partial<SlashCommandContext> = {}): SlashCommandContext {
  return {
    autoPlan: false,
    setSendMode: vi.fn(),
    setEffortChoice: vi.fn(),
    setAutoPlan: vi.fn(),
    ...overrides,
  };
}

describe('activeSlashQuery', () => {
  it('finds the command token when / is the very first character', () => {
    expect(activeSlashQuery('/plan', 5)).toBe('plan');
  });

  it('a / anywhere but the start of the draft is ordinary text, not a command', () => {
    expect(activeSlashQuery('please /plan this', 13)).toBeNull();
  });

  it('closes once the caret moves past the command token (a space was typed)', () => {
    expect(activeSlashQuery('/plan this', 10)).toBeNull();
  });

  it('an empty query right after typing "/" is a real, open token', () => {
    expect(activeSlashQuery('/', 1)).toBe('');
  });
});

describe('filterSlashCommands', () => {
  it('never offers /new or /delete when no real handler is wired in', () => {
    const results = filterSlashCommands(ALL_SLASH_COMMANDS, '', stubContext());
    expect(results.some((c) => c.id === 'new-chat')).toBe(false);
    expect(results.some((c) => c.id === 'delete-chat')).toBe(false);
  });

  it('offers /new and /delete once the caller wires real handlers in', () => {
    const results = filterSlashCommands(
      ALL_SLASH_COMMANDS,
      '',
      stubContext({ onNewChat: () => undefined, onRequestDelete: () => undefined }),
    );
    expect(results.some((c) => c.id === 'new-chat')).toBe(true);
    expect(results.some((c) => c.id === 'delete-chat')).toBe(true);
  });

  it('matches the typed query against the trigger', () => {
    const results = filterSlashCommands(ALL_SLASH_COMMANDS, 'byp', stubContext());
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('mode-bypass');
  });

  it('every real mode/effort/auto-plan command genuinely performs its own action, not a placeholder', () => {
    const setSendMode = vi.fn();
    const setEffortChoice = vi.fn();
    const setAutoPlan = vi.fn();
    const ctx = stubContext({ setSendMode, setEffortChoice, setAutoPlan, autoPlan: false });

    ALL_SLASH_COMMANDS.find((c) => c.id === 'mode-plan')?.run(ctx);
    expect(setSendMode).toHaveBeenCalledWith('plan');

    ALL_SLASH_COMMANDS.find((c) => c.id === 'effort-high')?.run(ctx);
    expect(setEffortChoice).toHaveBeenCalledWith('high');

    ALL_SLASH_COMMANDS.find((c) => c.id === 'auto-plan-toggle')?.run(ctx);
    expect(setAutoPlan).toHaveBeenCalledWith(true); // toggles from the stubbed autoPlan:false
  });

  it('/new and /delete call the real caller-provided handlers, not a no-op', () => {
    const onNewChat = vi.fn();
    const onRequestDelete = vi.fn();
    const ctx = stubContext({ onNewChat, onRequestDelete });

    ALL_SLASH_COMMANDS.find((c) => c.id === 'new-chat')?.run(ctx);
    ALL_SLASH_COMMANDS.find((c) => c.id === 'delete-chat')?.run(ctx);
    expect(onNewChat).toHaveBeenCalledTimes(1);
    expect(onRequestDelete).toHaveBeenCalledTimes(1);
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

function renderComposer(state: PrototypeState, extraProps: Partial<ComposerProps> = {}) {
  const value: StoreValue = { state, dispatch: vi.fn() };
  return render(
    createElement(
      PrototypeContext.Provider,
      { value },
      createElement(Composer, {
        onSend: vi.fn(() => true),
        onStop: () => undefined,
        streaming: false,
        conversationTitle: 'Test conversation',
        production: true,
        ...extraProps,
      }),
    ),
  );
}

describe('Composer /-slash command menu (feat-composer-power)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('typing /plan and picking it really sets the mode picker to Plan, and clears the draft', () => {
    renderComposer(buildState({ activeProjectId: 'p1' }));

    const field = screen.getByRole('textbox', { name: /Message Forge/ }) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: '/plan' } });

    fireEvent.click(screen.getByRole('option', { name: /\/plan/ }));

    expect(screen.getByRole('radio', { name: 'Plan' })).toHaveAttribute('aria-checked', 'true');
    expect(field.value).toBe('');
  });

  it('typing /bypass really sets the mode picker to Bypass', () => {
    renderComposer(buildState({ activeProjectId: 'p1' }));
    const field = screen.getByRole('textbox', { name: /Message Forge/ }) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: '/bypass' } });
    fireEvent.click(screen.getByRole('option', { name: /\/bypass/ }));
    expect(screen.getByRole('radio', { name: 'Bypass' })).toHaveAttribute('aria-checked', 'true');
  });

  it('/new is not offered when the Composer instance has no real onNewChat handler wired in', () => {
    renderComposer(buildState({ activeProjectId: 'p1' }));
    const field = screen.getByRole('textbox', { name: /Message Forge/ });
    fireEvent.change(field, { target: { value: '/new' } });
    expect(screen.queryByRole('option', { name: /\/new/ })).toBeNull();
    expect(screen.getByText(/No matching command/i)).toBeInTheDocument();
  });

  it('/new calls the real onNewChat handler once wired in, and clears the draft', () => {
    const onNewChat = vi.fn();
    renderComposer(buildState({ activeProjectId: 'p1' }), { onNewChat });
    const field = screen.getByRole('textbox', { name: /Message Forge/ }) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: '/new' } });
    fireEvent.click(screen.getByRole('option', { name: /\/new/ }));
    expect(onNewChat).toHaveBeenCalledTimes(1);
    expect(field.value).toBe('');
  });

  it('/delete calls the real onRequestDelete handler once wired in', () => {
    const onRequestDelete = vi.fn();
    renderComposer(buildState({ activeProjectId: 'p1' }), { onRequestDelete });
    const field = screen.getByRole('textbox', { name: /Message Forge/ });
    fireEvent.change(field, { target: { value: '/delete' } });
    fireEvent.click(screen.getByRole('option', { name: /\/delete/ }));
    expect(onRequestDelete).toHaveBeenCalledTimes(1);
  });

  it('Enter picks the top matching command instead of sending the raw "/plan" text', () => {
    const onSend = vi.fn(() => true);
    renderComposer(buildState({ activeProjectId: 'p1' }), { onSend });
    const field = screen.getByRole('textbox', { name: /Message Forge/ }) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: '/plan' } });
    fireEvent.keyDown(field, { key: 'Enter' });

    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole('radio', { name: 'Plan' })).toHaveAttribute('aria-checked', 'true');
    expect(field.value).toBe('');
  });

  it('Escape closes the command menu without running anything', () => {
    renderComposer(buildState({ activeProjectId: 'p1' }));
    const field = screen.getByRole('textbox', { name: /Message Forge/ }) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: '/plan' } });
    fireEvent.keyDown(field, { key: 'Escape' });

    expect(screen.queryByRole('option', { name: /\/plan/ })).toBeNull();
    // feat-forge-preamble: a fresh project's own untouched default is now Bypass, not Execute —
    // the real point here is that the mode picker is UNCHANGED by Escape, whatever it started at.
    expect(screen.getByRole('radio', { name: 'Bypass' })).toHaveAttribute('aria-checked', 'true');
    expect(field.value).toBe('/plan');
  });
});
