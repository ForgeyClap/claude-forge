/**
 * The prototype store. Pure reducer, so these are plain state-in/state-out tests.
 */

import { beforeEach, describe, expect, it } from 'vitest';
// The reducer is exercised over the example dataset, which moved to
// prototype/fixtures/ when it was retired from the production path. Read it from
// there; the gate at '@/prototype/data' now returns empty collections by default.
import { FIXTURE_DATASET as PROTOTYPE_DATASET } from '@/prototype/fixtures';
import {
  SIMULATED_REPLY,
  reducer,
  resolveTheme,
  selectFilteredAgents,
  selectFilteredProjects,
  selectIsPinned,
  selectMessages,
  selectTaskColumn,
  type PrototypeState,
} from '@/prototype/state/prototype-store';

function makeState(overrides: Partial<PrototypeState> = {}): PrototypeState {
  return {
    data: PROTOTYPE_DATASET,
    appearance: 'system',
    resolvedTheme: 'dark',
    density: 'comfortable',
    reducedMotion: false,
    sidebarCollapsed: false,
    mobileDrawerOpen: false,
    inspectorOpen: false,
    dockOpen: false,
    dockTab: 'activity',
    paletteOpen: false,
    activeProjectId: PROTOTYPE_DATASET.projects[0].id,
    activeConversationId: PROTOTYPE_DATASET.conversations[0].id,
    selection: { kind: 'none' },
    pinnedProjectIds: [],
    projectQuery: '',
    agentFilter: 'all',
    agentLayout: 'list',
    taskLayout: 'kanban',
    taskColumnOverrides: {},
    extraMessages: {},
    stream: null,
    claudeCodeState: 'not-connected',
    toasts: [],
    ...overrides,
  };
}

describe('appearance', () => {
  beforeEach(() => localStorage.clear());

  it('switches to an explicit theme and resolves it', () => {
    const next = reducer(makeState(), { type: 'appearance/set', appearance: 'light' });
    expect(next.appearance).toBe('light');
    expect(next.resolvedTheme).toBe('light');
  });

  it('follows the system only while in system mode', () => {
    const inSystem = reducer(makeState({ appearance: 'system' }), {
      type: 'appearance/system-changed',
      resolved: 'light',
    });
    expect(inSystem.resolvedTheme).toBe('light');

    const pinnedDark = reducer(makeState({ appearance: 'dark', resolvedTheme: 'dark' }), {
      type: 'appearance/system-changed',
      resolved: 'light',
    });
    expect(pinnedDark.resolvedTheme).toBe('dark');
  });

  it('resolveTheme passes explicit modes through untouched', () => {
    expect(resolveTheme('dark')).toBe('dark');
    expect(resolveTheme('light')).toBe('light');
    expect(['dark', 'light']).toContain(resolveTheme('system'));
  });

  it('persists the choice so a reload keeps it', () => {
    reducer(makeState(), { type: 'appearance/set', appearance: 'light' });
    expect(localStorage.getItem('forge.prototype.appearance')).toBe('light');
  });
});

describe('shell', () => {
  it('toggles sidebar, inspector and dock independently', () => {
    let s = makeState();
    s = reducer(s, { type: 'sidebar/toggle' });
    s = reducer(s, { type: 'inspector/toggle' });
    expect(s.sidebarCollapsed).toBe(true);
    expect(s.inspectorOpen).toBe(true);
    expect(s.dockOpen).toBe(false);
  });

  it('opens the dock when a tab is chosen', () => {
    const s = reducer(makeState({ dockOpen: false }), { type: 'dock/tab', tab: 'proof' });
    expect(s.dockOpen).toBe(true);
    expect(s.dockTab).toBe('proof');
  });

  it('opens the inspector whenever something is selected', () => {
    const s = reducer(makeState(), { type: 'select', selection: { kind: 'agent', id: 'x' } });
    expect(s.inspectorOpen).toBe(true);
    expect(s.selection).toEqual({ kind: 'agent', id: 'x' });
  });

  it('does not force the inspector open when the selection is cleared', () => {
    const s = reducer(makeState({ inspectorOpen: false }), {
      type: 'select',
      selection: { kind: 'none' },
    });
    expect(s.inspectorOpen).toBe(false);
  });
});

describe('projects', () => {
  it('filters by name, description and type', () => {
    const project = PROTOTYPE_DATASET.projects[0];
    const s = makeState({ projectQuery: project.name.slice(0, 6) });
    expect(selectFilteredProjects(s).map((p) => p.id)).toContain(project.id);
  });

  it('returns everything for an empty query', () => {
    expect(selectFilteredProjects(makeState())).toHaveLength(PROTOTYPE_DATASET.projects.length);
  });

  it('returns nothing for a query that matches nothing', () => {
    expect(selectFilteredProjects(makeState({ projectQuery: 'zzzzznope' }))).toHaveLength(0);
  });

  it('pin toggling inverts the example pin state without mutating the data', () => {
    const project = PROTOTYPE_DATASET.projects[0];
    const s = reducer(makeState(), { type: 'project/pin-toggle', id: project.id });
    expect(selectIsPinned(s, project.id)).toBe(!project.pinned);
    // the underlying example record is untouched
    expect(PROTOTYPE_DATASET.projects[0].pinned).toBe(project.pinned);
  });
});

describe('agents and tasks', () => {
  it('filters agents by status', () => {
    const s = makeState({ agentFilter: 'running' });
    expect(selectFilteredAgents(s).every((a) => a.status === 'running')).toBe(true);
  });

  it('a local drag-and-drop move overrides the column without touching the fixture', () => {
    const task = PROTOTYPE_DATASET.tasks[0];
    const s = reducer(makeState(), { type: 'tasks/move', taskId: task.id, column: 'completed' });
    expect(selectTaskColumn(s, task)).toBe('completed');
    expect(PROTOTYPE_DATASET.tasks[0].column).toBe(task.column);
  });
});

describe('the local chat simulation', () => {
  it('appends the user message and an empty reply, then starts a stream', () => {
    const conversationId = PROTOTYPE_DATASET.conversations[0].id;
    const s = reducer(makeState(), { type: 'chat/send', conversationId, body: 'Hello Forge' });
    const added = s.extraMessages[conversationId];
    expect(added).toHaveLength(2);
    expect(added[0].author).toBe('user');
    expect(added[0].body).toBe('Hello Forge');
    expect(added[1].author).toBe('forge');
    expect(added[1].body).toBe('');
    expect(s.stream?.target).toBe(SIMULATED_REPLY);
    expect(s.stream?.done).toBe(false);
  });

  it('reveals the canned reply progressively and finishes exactly at the end', () => {
    const conversationId = PROTOTYPE_DATASET.conversations[0].id;
    let s = reducer(makeState(), { type: 'chat/send', conversationId, body: 'hi' });
    s = reducer(s, { type: 'chat/stream-tick', revealed: 12 });
    expect(s.stream?.done).toBe(false);

    const streamed = s.extraMessages[conversationId][1].body;
    expect(streamed).toBe(SIMULATED_REPLY.slice(0, 12));

    s = reducer(s, { type: 'chat/stream-tick', revealed: SIMULATED_REPLY.length + 500 });
    expect(s.stream?.done).toBe(true);
    expect(s.extraMessages[conversationId][1].body).toBe(SIMULATED_REPLY);
  });

  it('stopping halts the reveal where it stands', () => {
    const conversationId = PROTOTYPE_DATASET.conversations[0].id;
    let s = reducer(makeState(), { type: 'chat/send', conversationId, body: 'hi' });
    s = reducer(s, { type: 'chat/stream-tick', revealed: 20 });
    s = reducer(s, { type: 'chat/stream-stop' });
    expect(s.stream?.done).toBe(true);
    expect(s.extraMessages[conversationId][1].body).toHaveLength(20);
  });

  it('merges example messages with locally sent ones in order', () => {
    const conversation = PROTOTYPE_DATASET.conversations.find((c) => c.messages.length > 0)!;
    const s = reducer(makeState(), {
      type: 'chat/send',
      conversationId: conversation.id,
      body: 'appended',
    });
    const merged = selectMessages(s, conversation.id);
    expect(merged).toHaveLength(conversation.messages.length + 2);
    expect(merged[conversation.messages.length].body).toBe('appended');
  });

  it('the canned reply says out loud that nothing was generated', () => {
    expect(SIMULATED_REPLY).toMatch(/local example text/i);
    expect(SIMULATED_REPLY).toMatch(/no session was contacted/i);
  });
});

describe('toasts', () => {
  it('stacks at most four', () => {
    let s = makeState();
    for (let i = 0; i < 7; i += 1) {
      s = reducer(s, { type: 'toast/push', toast: { id: `t${i}`, title: `Toast ${i}` } });
    }
    expect(s.toasts).toHaveLength(4);
    expect(s.toasts[0].id).toBe('t3');
  });

  it('dismisses by id', () => {
    let s = reducer(makeState(), { type: 'toast/push', toast: { id: 'a', title: 'A' } });
    s = reducer(s, { type: 'toast/push', toast: { id: 'b', title: 'B' } });
    s = reducer(s, { type: 'toast/dismiss', id: 'a' });
    expect(s.toasts.map((t) => t.id)).toEqual(['b']);
  });
});
