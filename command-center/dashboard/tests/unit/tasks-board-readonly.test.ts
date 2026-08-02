/**
 * Tasks board — no write affordance (fix-views, forge-2026-07-29-cc-finish, P0-4).
 *
 * The kanban board used to be a fake write: dragging a card, or pressing its
 * per-card Move button, dispatched a local `tasks/move` column override and
 * toasted that nothing was actually saved — while the board kept showing the
 * override as if it were the real column, silently contradicting the real run.
 * That affordance was removed rather than kept as a lie. This test proves it
 * stays removed: no draggable card, no drop target, and no control whose
 * accessible name offers to move a task.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { render, cleanup } from '@testing-library/react';

import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import type { Agent, Task, TaskLayout, WorkPackage } from '@/prototype/types/prototype-types';
import TasksView from '@/views/tasks/TasksView';
import { collectRenderedText, scanForbidden } from './no-prototype-copy.test';

const AGENT = {
  id: 'agent-1',
  name: 'Build Boss',
} as unknown as Agent;

const WORK_PACKAGE = {
  id: 'wp-1',
  title: 'WP1',
  goal: 'Ship the read-only board fix.',
  status: 'running',
  ownerAgentId: 'agent-1',
  phase: 'build',
  taskIds: ['task-1'],
  acceptance: ['The board is read-only.'],
} as unknown as WorkPackage;

// proofCount/repairAttempts both > 0 so TaskStats renders both title-bearing
// spans this suite scans — a real task with real evidence attached, not a
// bare-minimum fixture that would silently skip that markup.
const TASK = {
  id: 'task-1',
  title: 'A real task',
  agentId: 'agent-1',
  workPackageId: 'wp-1',
  phase: 'build',
  column: 'running',
  status: 'running',
  progress: 40,
  dependencies: [],
  proofCount: 2,
  createdAt: '2026-07-29T00:00:00.000Z',
  updatedAt: '2026-07-29T00:00:00.000Z',
  repairAttempts: 1,
  detail: 'A real task for the read-only-board test.',
} as unknown as Task;

function buildStateWithOneTask(taskLayout: TaskLayout = 'kanban'): PrototypeState {
  return {
    data: { ...EMPTY_DATASET, agents: [AGENT], workPackages: [WORK_PACKAGE], tasks: [TASK] },
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
    taskLayout,
    taskColumnOverrides: {},
    extraMessages: {},
    stream: null,
    claudeCodeState: 'not-connected',
    toasts: [],
  };
}

function renderBoard(taskLayout: TaskLayout = 'kanban') {
  const value: StoreValue = { state: buildStateWithOneTask(taskLayout), dispatch: () => undefined };
  return render(createElement(PrototypeContext.Provider, { value }, createElement(TasksView)));
}

describe('the Tasks kanban board exposes no write affordance', () => {
  afterEach(() => cleanup());

  it('renders the real task (proves the board is not just empty)', () => {
    const { getByText } = renderBoard();
    expect(getByText('A real task')).toBeTruthy();
  });

  it('renders no draggable element', () => {
    const { container } = renderBoard();
    expect(container.querySelectorAll('[draggable="true"]').length).toBe(0);
  });

  it('renders no button whose accessible name offers to move a task', () => {
    const { container } = renderBoard();
    const buttons = Array.from(container.querySelectorAll<HTMLElement>('button, [role="button"]'));
    const moveControls = buttons.filter((el) => {
      const name = (el.getAttribute('aria-label') ?? el.getAttribute('title') ?? el.textContent ?? '').toLowerCase();
      return /\bmove\b/.test(name);
    });
    expect(moveControls).toEqual([]);
  });

  it('renders no "Move task" dialog', () => {
    const { queryByText } = renderBoard();
    expect(queryByText('Move task')).toBeNull();
  });
});

describe('Tasks board renders zero forbidden strings with a real, populated task', () => {
  afterEach(() => cleanup());

  // Populated (not empty-dataset) renders, one per layout — the empty-dataset
  // sweep in no-prototype-copy.test.ts never reaches the table/work-packages/
  // phases branches (the kanban empty state short-circuits first), so this is
  // the only coverage of their per-row markup (captions, stat tooltips, etc).
  const LAYOUTS: readonly TaskLayout[] = ['kanban', 'table', 'work-packages', 'phases'];

  for (const layout of LAYOUTS) {
    it(`layout=${layout}`, () => {
      const { container } = renderBoard(layout);
      const found = scanForbidden(collectRenderedText(container));
      expect(found, `TasksView (${layout}) rendered forbidden term(s): ${found.join(', ')}`).toEqual([]);
    });
  }
});
