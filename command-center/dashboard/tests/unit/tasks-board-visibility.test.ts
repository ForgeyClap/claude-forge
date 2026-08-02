/**
 * Tasks board visibility (fix-run-visibility, forge-2026-07-29-cc-finish, WP fix-run-visibility).
 *
 * Owner-reported symptom (screenshots): the Tasks tab subtitle said "2 tasks" while every VISIBLE
 * kanban column read "Nothing in this column" — both real tasks sat in the 'completed' column, the
 * eighth and LAST of eight fixed-width columns inside a horizontally-scrolling board (tasks.css's own
 * `.fw-tasks-board { overflow-x: auto }`), off the right edge with no visual cue to scroll there.
 *
 * Two independent, real fixes are proven here:
 *   1. DISCOVERABILITY — TasksView.tsx auto-scrolls the first non-empty column into view via
 *      `Element.prototype.scrollIntoView`, the exact mechanism this view's own code comment names
 *      (mirroring the ALREADY-established `CommandPalette.tsx` pattern).
 *   2. NO SILENT DISAPPEARANCE — a task whose real `column` value is not one of the eight known
 *      `TASK_COLUMNS` is caught under 'backlog' (never dropped by `byColumn`'s old
 *      `map.get(row.column)?.push(row)`) and carries a visible, honest "Unknown column" flag naming
 *      its real raw value.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { render, cleanup } from '@testing-library/react';

import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import type { Agent, Task, TaskColumn } from '@/prototype/types/prototype-types';
import TasksView from '@/views/tasks/TasksView';

const AGENT = { id: 'agent-1', name: 'Build Boss' } as unknown as Agent;

function buildTask(overrides: Partial<Task> & { id: string; title: string }): Task {
  return {
    agentId: 'agent-1',
    workPackageId: 'wp-1',
    phase: 'handoff',
    column: 'completed',
    status: 'completed',
    progress: 100,
    dependencies: [],
    proofCount: 0,
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
    repairAttempts: 0,
    detail: 'A real task for the tasks-board-visibility test.',
    ...overrides,
  } as unknown as Task;
}

function buildState(tasks: readonly Task[]): PrototypeState {
  return {
    data: { ...EMPTY_DATASET, agents: [AGENT], tasks },
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
  };
}

function renderWithState(state: PrototypeState) {
  const value: StoreValue = { state, dispatch: () => undefined };
  return render(createElement(PrototypeContext.Provider, { value }, createElement(TasksView)));
}

function findColumnSection(container: HTMLElement, labelPrefix: string): Element | undefined {
  return [...container.querySelectorAll('.fw-tasks-board__col')].find((section) =>
    (section.getAttribute('aria-label') ?? '').startsWith(labelPrefix),
  );
}

describe('Tasks kanban board — discoverability when every task sits in the same, off-screen column', () => {
  let scrollCalls: Element[];

  beforeEach(() => {
    scrollCalls = [];
    Element.prototype.scrollIntoView = vi.fn(function scrollIntoViewSpy(this: Element) {
      scrollCalls.push(this);
    });
  });

  afterEach(() => cleanup());

  it('scrolls the first non-empty column ("Completed") into view when every real task sits there', () => {
    const tasks = [
      buildTask({ id: 'task-1', title: 'Add live check line to NOTES.md' }),
      buildTask({ id: 'task-2', title: 'Report completion' }),
    ];
    const { container } = renderWithState(buildState(tasks));

    expect(scrollCalls.length).toBeGreaterThan(0);
    const scrolledSection = scrollCalls[scrollCalls.length - 1];
    expect(scrolledSection.getAttribute('aria-label')).toMatch(/^Completed —/);

    // Sanity: the completed column's own section really does contain both real cards — this proves
    // the scroll target is the POPULATED column, not an empty one.
    expect(scrolledSection.textContent).toContain('Add live check line to NOTES.md');
    expect(scrolledSection.textContent).toContain('Report completion');

    // Every OTHER column is still genuinely empty (the owner's original screenshot) — the fix is
    // that the one real column is brought into view, not that the empty ones are hidden or faked.
    const emptyNotices = container.querySelectorAll('.fw-tasks-board__empty');
    expect(emptyNotices.length).toBe(7); // 8 columns total, only 'completed' holds a task
  });

  it('does not re-fire the scroll for a routine data refresh that keeps the same first non-empty column', () => {
    const tasks = [buildTask({ id: 'task-1', title: 'Add live check line to NOTES.md' })];
    const { rerender } = render(
      createElement(
        PrototypeContext.Provider,
        { value: { state: buildState(tasks), dispatch: () => undefined } as StoreValue },
        createElement(TasksView),
      ),
    );
    const firstCallCount = scrollCalls.length;
    expect(firstCallCount).toBeGreaterThan(0);

    // A brand-new task array (as a real poll tick would produce) but the SAME first non-empty
    // column ('completed') — must not scroll again and fight a scroll position the owner moved.
    const sameShapeTasks = [buildTask({ id: 'task-1', title: 'Add live check line to NOTES.md' })];
    rerender(
      createElement(
        PrototypeContext.Provider,
        { value: { state: buildState(sameShapeTasks), dispatch: () => undefined } as StoreValue },
        createElement(TasksView),
      ),
    );
    expect(scrollCalls.length).toBe(firstCallCount);
  });

  it('never auto-scrolls when the layout is not kanban', () => {
    const state: PrototypeState = { ...buildState([buildTask({ id: 'task-1', title: 'A task' })]), taskLayout: 'table' };
    renderWithState(state);
    expect(scrollCalls.length).toBe(0);
  });
});

describe('Tasks board — a task with an unrecognized column never silently disappears', () => {
  afterEach(() => cleanup());

  it('is caught under Backlog and carries a visible, honest "Unknown column" flag naming the real raw value', () => {
    const oddTask = buildTask({
      id: 'task-odd',
      title: 'Task with a foreign column value',
      column: 'archived-somewhere' as unknown as TaskColumn,
      status: 'waiting',
    });
    const normalTask = buildTask({ id: 'task-2', title: 'A normal running task', column: 'running' as TaskColumn, status: 'running' });
    const { container, getByText, getByTitle } = renderWithState(buildState([oddTask, normalTask]));

    // 1. The header count is unaffected either way — it always counted every real task.
    expect(container.textContent).toContain('2 tasks');

    // 2. The odd task is genuinely rendered — never dropped.
    expect(getByText('Task with a foreign column value')).toBeTruthy();

    // 3. It renders inside the Backlog column's own section — caught, not lost off in a column that
    //    no longer matches any known key.
    const backlogSection = findColumnSection(container, 'Backlog —');
    expect(backlogSection, 'Backlog column section not found').toBeTruthy();
    expect(backlogSection!.textContent).toContain('Task with a foreign column value');

    // 4. A real, visible, honest notice exists naming the ACTUAL raw column value — never silently
    //    relabeled as if 'backlog' were the task's real column.
    const flag = getByTitle(/Unrecognized task column "archived-somewhere"/i);
    expect(flag).toBeTruthy();

    // 5. The normal task's own (real, recognized) column is completely unaffected by the odd one.
    const runningSection = findColumnSection(container, 'Running —');
    expect(runningSection!.textContent).toContain('A normal running task');
    expect(runningSection!.textContent).not.toContain('Unknown column');
  });

  it('renders no "Unknown column" flag at all for an ordinary task with a real, recognized column', () => {
    const normalTask = buildTask({ id: 'task-1', title: 'An ordinary task', column: 'verify' as TaskColumn, status: 'verify' });
    const { queryByText } = renderWithState(buildState([normalTask]));
    expect(queryByText('Unknown column')).toBeNull();
  });
});
