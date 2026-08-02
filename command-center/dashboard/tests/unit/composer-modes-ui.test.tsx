/**
 * composer-modes-ui (forge-2026-07-29-cc-finish, WP composer-modes-ui): the widened send-mode
 * picker (Execute/Plan/Accept edits/Bypass), the compact Effort picker, the per-message mode/
 * effort chips, and the Auto-plan two-real-turn flow.
 *
 * Follows this suite's own established conventions: a local `buildState`/`renderWithState` pair
 * mirroring `composer-write-scope.test.tsx`'s exact shape, and `Message` rendered directly against
 * a real `PrototypeContext.Provider` the same way `no-prototype-copy.test.ts` does.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import type { ReactElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import type { ChatMessage, Conversation } from '@/prototype/types/prototype-types';
import { AUTO_PLAN_FOLLOWUP_MESSAGE, Composer, AUTO_PLAN_INTAKE_SUFFIX } from '@/views/chat/Composer';
import type { ComposerProps } from '@/views/chat/Composer';
import { RUN_PLAN_MESSAGE, sendArgsFor } from '@/views/chat/compose-args';
import { Message } from '@/views/chat/Message';

/* ========================================================================== */
/*  1. sendArgsFor — pure, no rendering                                       */
/* ========================================================================== */

describe('sendArgsFor', () => {
  it('omits both mode and effort for the defaults (execute, no effort)', () => {
    expect(sendArgsFor('hello', 'execute', undefined)).toEqual(['hello']);
  });

  it('includes a non-default mode, still omits effort when unset', () => {
    expect(sendArgsFor('hello', 'bypass', undefined)).toEqual(['hello', 'bypass']);
  });

  it('includes effort even when mode is the default execute (fills the mode position to reach it)', () => {
    expect(sendArgsFor('hello', 'execute', 'high')).toEqual(['hello', 'execute', 'high']);
  });

  it('includes both when both are non-default', () => {
    expect(sendArgsFor('hello', 'plan', 'max')).toEqual(['hello', 'plan', 'max']);
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
/*  2. Composer — the widened mode picker + compact Effort picker             */
/* ========================================================================== */

describe('Composer send-mode/effort picker (composer-modes-ui)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('sends mode="bypass" and shows the one honest bypass sentence once Bypass is selected', () => {
    const onSend = vi.fn(() => true);
    renderComposer(buildState({ activeProjectId: 'p1' }), onSend);

    fireEvent.click(screen.getByRole('radio', { name: 'Bypass' }));
    expect(screen.getByText(/voert uit zonder goedkeuringsvragen/i)).toBeInTheDocument();

    const field = screen.getByRole('textbox', { name: /Message Forge/ });
    fireEvent.change(field, { target: { value: 'Do it.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(onSend).toHaveBeenCalledWith('Do it.', 'bypass');
  });

  // feat-forge-preamble: a fresh project (never persisted a choice) now defaults to Bypass, not
  // Execute — see mode-storage.ts's own doc comment. "the default" below therefore means "once
  // Execute is explicitly chosen", not "on a brand-new project with nothing selected yet".
  it('never shows the bypass sentence once Execute is explicitly selected', () => {
    renderComposer(buildState({ activeProjectId: 'p1' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Execute' }));
    expect(screen.queryByText(/voert uit zonder goedkeuringsvragen/i)).toBeNull();
  });

  // feat-forge-preamble: a project with no persisted mode choice yet starts at Bypass — see
  // mode-storage.ts's own doc comment for the honest "a non-interactive session can never answer
  // an approval prompt" reason. The composer's own hint paragraph must reflect this immediately,
  // with no click needed.
  it('a brand-new project (never persisted a choice) defaults to Bypass and shows the honest bypass sentence immediately', () => {
    renderComposer(buildState({ activeProjectId: 'p-new' }));
    expect(screen.getByRole('radio', { name: 'Bypass' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(/voert uit zonder goedkeuringsvragen/i)).toBeInTheDocument();
  });

  it('an existing persisted Execute choice for a project is NOT silently upgraded to Bypass on a later remount', () => {
    const { unmount } = renderComposer(buildState({ activeProjectId: 'p1' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Execute' }));
    unmount();

    renderComposer(buildState({ activeProjectId: 'p1' }));
    expect(screen.getByRole('radio', { name: 'Execute' })).toHaveAttribute('aria-checked', 'true');
  });

  it('sends effort="high" via the compact Effort menu while mode stays the (explicitly chosen) execute', () => {
    const onSend = vi.fn(() => true);
    renderComposer(buildState({ activeProjectId: 'p1' }), onSend);
    fireEvent.click(screen.getByRole('radio', { name: 'Execute' }));

    // The trigger's own visible label IS the current choice — starts as "Default".
    fireEvent.click(screen.getByRole('button', { name: 'Default' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /High/ }));

    const field = screen.getByRole('textbox', { name: /Message Forge/ });
    fireEvent.change(field, { target: { value: 'Go' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(onSend).toHaveBeenCalledWith('Go', 'execute', 'high');
  });

  it('sends neither field for a plain Execute + Default send (byte-identical to before this picker)', () => {
    const onSend = vi.fn(() => true);
    renderComposer(buildState({ activeProjectId: 'p1' }), onSend);
    fireEvent.click(screen.getByRole('radio', { name: 'Execute' }));

    const field = screen.getByRole('textbox', { name: /Message Forge/ });
    fireEvent.change(field, { target: { value: 'Plain message' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(onSend).toHaveBeenCalledWith('Plain message');
  });

  // coordinator finding 2026-07-30: plan mode cannot call ANY tool at all (ask_owner included), so
  // the picker itself must say so plainly right where the owner chooses Plan — never leaving them
  // to rediscover this the hard way inside a stalled turn.
  it('shows an honest "plan mode has no tools" line once Plan is selected', () => {
    renderComposer(buildState({ activeProjectId: 'p1' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Plan' }));
    expect(screen.getByText(/geen enkele tool beschikbaar/i)).toBeInTheDocument();
  });

  it('never shows the plan-mode warning while a different mode is selected', () => {
    renderComposer(buildState({ activeProjectId: 'p1' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Execute' }));
    expect(screen.queryByText(/geen enkele tool beschikbaar/i)).toBeNull();
  });

  it('persists mode/effort/auto-plan choices across a remount via localStorage', () => {
    const state = buildState({ activeProjectId: 'p1' });
    const { unmount } = renderComposer(state);

    fireEvent.click(screen.getByRole('radio', { name: 'Bypass' }));
    fireEvent.click(screen.getByRole('button', { name: 'Default' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /High/ }));
    fireEvent.click(screen.getByRole('switch', { name: 'Auto-plan' }));
    unmount();

    renderComposer(state);
    expect(screen.getByRole('radio', { name: 'Bypass' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('button', { name: 'High' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Auto-plan' })).toHaveAttribute('aria-checked', 'true');
  });

  // fix-sec-round #2 (MEDIUM regression): a sticky mode choice must NOT bleed from one project
  // into a different one — the bug this round fixed was a single browser-global localStorage key
  // shared by every project, with no expiry. feat-forge-preamble: p1 is given a non-default,
  // non-bypass choice ('Accept edits') so this test still proves real isolation even though Bypass
  // is now ALSO every fresh project's own independent default (p2 landing on Bypass is its OWN
  // fresh default, not a leak of p1's pick).
  it('an Accept-edits choice made under one project does NOT carry over into a DIFFERENT project (remount with a different activeProjectId)', () => {
    const { unmount } = renderComposer(buildState({ activeProjectId: 'p1' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Accept edits' }));
    expect(screen.getByRole('radio', { name: 'Accept edits' })).toHaveAttribute('aria-checked', 'true');
    unmount();

    renderComposer(buildState({ activeProjectId: 'p2' }));
    expect(screen.getByRole('radio', { name: 'Bypass' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Accept edits' })).toHaveAttribute('aria-checked', 'false');
  });

  it('the SAME project still restores its own Bypass choice across a remount (per-project persistence still works)', () => {
    const { unmount } = renderComposer(buildState({ activeProjectId: 'p1' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Bypass' }));
    unmount();

    renderComposer(buildState({ activeProjectId: 'p1' }));
    expect(screen.getByRole('radio', { name: 'Bypass' })).toHaveAttribute('aria-checked', 'true');
  });

  it('no active project (empty id) always defaults to Execute, regardless of any other project\'s stored choice', () => {
    const { unmount } = renderComposer(buildState({ activeProjectId: 'p1' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Bypass' }));
    unmount();

    renderComposer(buildState({ activeProjectId: '' }));
    expect(screen.getByRole('radio', { name: 'Execute' })).toHaveAttribute('aria-checked', 'true');
  });

  // coordinator finding 2026-07-30 (supersedes the old fix-sec-round #5 test below it): Auto-plan
  // no longer forces the FIRST turn to 'plan' at all — plan mode cannot call ask_owner, so forcing
  // it would silently break the intake stage's whole purpose (see Composer.tsx's own header for
  // the full 3-stage redesign). The bypass write-scope warning therefore now shows whenever Bypass
  // is genuinely selected, REGARDLESS of Auto-plan.
  it('still shows the bypass warning when Bypass is selected, whether or not Auto-plan is also on (Auto-plan no longer forces the first turn to plan)', () => {
    renderComposer(buildState({ activeProjectId: 'p1' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Bypass' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Auto-plan' }));
    expect(screen.getByText(/voert uit zonder goedkeuringsvragen/i)).toBeInTheDocument();
    expect(screen.getByText(/full write access on this machine/i)).toBeInTheDocument();
  });

  it('still shows the bypass warning when Bypass is selected and Auto-plan is off (the next send really runs as bypass)', () => {
    renderComposer(buildState({ activeProjectId: 'p1' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Bypass' }));
    expect(screen.getByText(/voert uit zonder goedkeuringsvragen/i)).toBeInTheDocument();
    expect(screen.getByText(/full write access on this machine/i)).toBeInTheDocument();
  });
});

/* ========================================================================== */
/*  3. Message — mode/effort chips, only ever real                            */
/* ========================================================================== */

/**
 * fix-sec-round #3 (MEDIUM): the real gateway record shape (`conversations.mjs`'s
 * `appendUserTurn`) writes `mode`/`effort` onto the USER turn's own record — the assistant/forge
 * turn that follows never carries either field. `buildTurn` defaults to `author: 'user'` so every
 * test below asserts against that real shape rather than the previously-fabricated
 * `author: 'forge'` + mode/effort combination this test file used to use.
 */
function buildTurn(overrides: Record<string, unknown>): ChatMessage {
  return {
    id: 'msg-x',
    author: 'user',
    body: 'Do the thing.',
    timestamp: '2026-07-29T00:00:00.000Z',
    ...overrides,
  } as unknown as ChatMessage;
}

function renderMessage(message: ChatMessage) {
  return renderWithState(
    createElement(Message, { message, position: 1, total: 1 }),
    buildState(),
  );
}

describe('Message mode/effort chips (composer-modes-ui)', () => {
  afterEach(() => cleanup());

  it('shows an ACCEPT EDITS chip only when the turn really carries that mode', () => {
    const { container } = renderMessage(buildTurn({ mode: 'accept-edits' }));
    expect(container.textContent).toContain('ACCEPT EDITS');
  });

  it('shows a BYPASS chip when the turn really carries bypass mode', () => {
    const { container } = renderMessage(buildTurn({ mode: 'bypass' }));
    expect(container.textContent).toContain('BYPASS');
  });

  it('shows no mode chip for the default execute mode', () => {
    const { container } = renderMessage(buildTurn({ mode: 'execute' }));
    expect(container.textContent).not.toMatch(/\bPLAN\b|ACCEPT EDITS|BYPASS/);
  });

  it('shows an effort chip only when the turn really carries an effort level', () => {
    const { container } = renderMessage(buildTurn({ effort: 'xhigh' }));
    expect(container.textContent).toContain('EXTRA HIGH');
  });

  it('fabricates neither chip for a turn with no mode/effort fields at all', () => {
    const { container } = renderMessage(buildTurn({}));
    expect(container.textContent).not.toMatch(/\bPLAN\b|ACCEPT EDITS|BYPASS|\bLOW\b|MEDIUM|\bHIGH\b|EXTRA HIGH|\bMAX\b/);
  });

  // fix-sec-round #3 regression: the bug this round fixed was reading mode/effort ONLY for
  // non-user (forge) turns — exactly backwards from where the gateway actually writes them. This
  // asserts the fixed direction directly: a forge-authored record can never show a chip, even if
  // (hypothetically) it carried mode/effort fields, because the gateway never puts them there.
  it('never shows a chip on an assistant/forge turn, even one that (unrealistically) carries mode/effort fields itself', () => {
    const { container } = renderMessage(buildTurn({ author: 'forge', mode: 'bypass', effort: 'max' }));
    expect(container.textContent).not.toMatch(/BYPASS|\bMAX\b/);
  });
});

/* ========================================================================== */
/*  4. Auto-plan — two REAL turns, never a simulation                        */
/* ========================================================================== */

function buildConversation(messages: readonly ChatMessage[]): Conversation {
  return {
    prototype: true,
    id: 'conv-1',
    projectId: 'p1',
    title: 'Test chat',
    updatedAt: '2026-07-29T00:00:00.000Z',
    messageCount: messages.length,
    messages,
  } as unknown as Conversation;
}

// Renders the SAME Composer instance against a new `messages` snapshot (mirrors the previous
// single-inline-rerender pattern this suite already used, extracted here since the 3-stage flow
// below needs it twice per test).
function rerenderWithMessages(
  rerender: (ui: ReactElement) => void,
  onSend: ComposerProps['onSend'],
  messages: readonly ChatMessage[],
) {
  const settledState = buildState({
    activeProjectId: 'p1',
    activeConversationId: 'conv-1',
    data: { ...EMPTY_DATASET, conversations: [buildConversation(messages)] },
  });
  const value: StoreValue = { state: settledState, dispatch: vi.fn() };
  rerender(
    createElement(
      PrototypeContext.Provider,
      { value },
      createElement(Composer, {
        onSend,
        onStop: () => undefined,
        streaming: false,
        conversationTitle: 'Test conversation',
        production: true,
      }),
    ),
  );
}

describe('Composer Auto-plan flow — 3 stages: intake (tool-capable) -> plan -> execute (coordinator finding 2026-07-30)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  // The core bug this redesign fixes: plan mode cannot call ask_owner (or any tool) at all, so
  // forcing the FIRST turn into plan mode would silently make it impossible to ask a real
  // question there. Stage 1 must run in whatever mode is genuinely selected.
  it('stage 1 (intake) never forces plan mode — the owner-selected mode runs unchanged', () => {
    const onSend = vi.fn(() => true);
    const baseState = buildState({
      activeProjectId: 'p1',
      activeConversationId: 'conv-1',
      data: { ...EMPTY_DATASET, conversations: [buildConversation([])] },
    });
    renderComposer(baseState, onSend);

    fireEvent.click(screen.getByRole('switch', { name: 'Auto-plan' }));
    const field = screen.getByRole('textbox', { name: /Message Forge/ });
    fireEvent.change(field, { target: { value: 'Build the widget' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    // p1 has no persisted mode choice yet, so it defaults to Bypass (feat-forge-preamble) — the
    // real point of this test is that it is NOT 'plan'.
    expect(onSend).toHaveBeenNthCalledWith(1, `Build the widget

${AUTO_PLAN_INTAKE_SUFFIX}`, 'bypass');
  });

  /* MEASURED live (2026-07-30, real gateway run): with Auto-plan on and the small clear request
   * "maak een bestand notities.md met drie regels", stage 1 ran in bypass and simply BUILT the file —
   * stage 2 then asked for a plan of finished work. That makes the switch lie, since the owner turns
   * Auto-plan on precisely to see a plan BEFORE anything is built. Stage 1 must announce itself as
   * intake. The suffix is part of the visible body, never a hidden instruction. */
  it('stage 1 tells the session this is intake and that it must not build yet — but ONLY when Auto-plan is on', () => {
    const onSend = vi.fn(() => true);
    const baseState = buildState({
      activeProjectId: 'p1',
      activeConversationId: 'conv-1',
      data: { ...EMPTY_DATASET, conversations: [buildConversation([])] },
    });
    renderComposer(baseState, onSend);

    // Auto-plan OFF: the owner's text goes out untouched — no appended instruction whatsoever.
    const field = screen.getByRole('textbox', { name: /Message Forge/ });
    fireEvent.change(field, { target: { value: 'Build the widget' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenNthCalledWith(1, 'Build the widget', 'bypass');

    // Auto-plan ON: the same text now carries the intake framing, and it really says "build nothing yet".
    fireEvent.click(screen.getByRole('switch', { name: 'Auto-plan' }));
    fireEvent.change(field, { target: { value: 'Build the widget' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    // `vi.fn(() => true)` declares no parameters, so its recorded call args are typed as an empty
    // tuple — read the real recorded argument through a widened view rather than loosening the mock.
    const secondBody = String((onSend.mock.calls[1] as unknown as readonly unknown[])[0]);
    expect(secondBody).toContain('Build the widget');
    expect(secondBody).toContain(AUTO_PLAN_INTAKE_SUFFIX);
    expect(AUTO_PLAN_INTAKE_SUFFIX).toMatch(/bouw of wijzig nu nog NIETS/);
    expect(AUTO_PLAN_INTAKE_SUFFIX).toMatch(/ask_owner/);
  });

  it('the full 3-stage flow: the intake reply auto-fires a real PLAN turn, whose own reply then offers the existing "Voer dit plan uit" button for the real execute turn', () => {
    const onSend = vi.fn(() => true);
    const baseState = buildState({
      activeProjectId: 'p1',
      activeConversationId: 'conv-1',
      data: { ...EMPTY_DATASET, conversations: [buildConversation([])] },
    });
    const { rerender } = renderComposer(baseState, onSend);

    fireEvent.click(screen.getByRole('switch', { name: 'Auto-plan' }));
    const field = screen.getByRole('textbox', { name: /Message Forge/ });
    fireEvent.change(field, { target: { value: 'Build the widget' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    // Stage 1 (INTAKE): real mode (Bypass, the fresh-project default), never forced to plan.
    expect(onSend).toHaveBeenNthCalledWith(1, `Build the widget

${AUTO_PLAN_INTAKE_SUFFIX}`, 'bypass');
    expect(screen.queryByRole('button', { name: 'Voer dit plan uit' })).toBeNull();

    // Stage 1 -> 2: the real intake reply "arrives" — this must automatically fire the real PLAN
    // turn, with NO button click (Auto-plan's whole point is not making the owner do this by hand).
    const intakeUser = { id: 't1', author: 'user', body: 'Build the widget', timestamp: 't1' } as unknown as ChatMessage;
    const intakeReply = { id: 't2', author: 'forge', body: 'Sure, a few questions first...', timestamp: 't2' } as unknown as ChatMessage;
    rerenderWithMessages(rerender, onSend, [intakeUser, intakeReply]);

    expect(onSend).toHaveBeenCalledTimes(2);
    expect(onSend).toHaveBeenNthCalledWith(2, AUTO_PLAN_FOLLOWUP_MESSAGE, 'plan');
    expect(screen.queryByRole('button', { name: 'Voer dit plan uit' })).toBeNull();

    // Stage 2 -> 3: the real PLAN turn's own reply "arrives" — NOW the existing run-plan button
    // appears, exactly like the old flow's final step.
    const planUser = { id: 't3', author: 'user', body: AUTO_PLAN_FOLLOWUP_MESSAGE, timestamp: 't3' } as unknown as ChatMessage;
    const planReply = { id: 't4', author: 'forge', body: 'Here is the plan.', timestamp: 't4' } as unknown as ChatMessage;
    rerenderWithMessages(rerender, onSend, [intakeUser, intakeReply, planUser, planReply]);

    const runButton = screen.getByRole('button', { name: 'Voer dit plan uit' });
    fireEvent.click(runButton);

    // Stage 3 (EXECUTE): the real follow-up text, in whatever mode is CURRENTLY selected (still
    // Bypass here, since only Auto-plan was toggled).
    expect(onSend).toHaveBeenNthCalledWith(3, RUN_PLAN_MESSAGE, 'bypass');
    expect(onSend).toHaveBeenCalledTimes(3);

    // The banner is a one-shot prompt for THIS proposal — gone the moment it is acted on.
    expect(screen.queryByRole('button', { name: 'Voer dit plan uit' })).toBeNull();
  });

  // coordinator finding 2026-07-30: this REPLACES the old "never shows the run-plan button for a
  // manually selected Plan send" test — the owner explicitly wants the SAME stage-3 mechanism to
  // appear after a plain, manually chosen Plan turn too (no intake stage needed there, since the
  // owner picked Plan mode directly and the composer's own plan-mode hint already told them tools
  // are unavailable in it).
  it('a manually selected Plan send (Auto-plan off) still offers "Voer dit plan uit" directly once its own reply lands', () => {
    const onSend = vi.fn(() => true);
    const baseState = buildState({
      activeProjectId: 'p1',
      activeConversationId: 'conv-1',
      data: { ...EMPTY_DATASET, conversations: [buildConversation([])] },
    });
    const { rerender } = renderComposer(baseState, onSend);

    fireEvent.click(screen.getByRole('radio', { name: 'Plan' }));
    const field = screen.getByRole('textbox', { name: /Message Forge/ });
    fireEvent.change(field, { target: { value: 'Plan this manually' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(onSend).toHaveBeenCalledWith('Plan this manually', 'plan');
    expect(screen.queryByRole('button', { name: 'Voer dit plan uit' })).toBeNull();

    const userTurn = { id: 't1', author: 'user', body: 'Plan this manually', timestamp: 't1' } as unknown as ChatMessage;
    const assistantTurn = { id: 't2', author: 'forge', body: 'Here is the plan.', timestamp: 't2' } as unknown as ChatMessage;
    rerenderWithMessages(rerender, onSend, [userTurn, assistantTurn]);

    expect(screen.getByRole('button', { name: 'Voer dit plan uit' })).toBeInTheDocument();
  });
});
