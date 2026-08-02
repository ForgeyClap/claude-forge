/**
 * fix-placeholder (forge-2026-07-29-cc-finish, P1) — the render-level backstop for the Projects
 * browser + Project overview: an absent project goal (the gateway now returns `null` for a
 * profile field that was only ever unfilled scaffold text, e.g. "<one or two lines>") must render
 * as this app's existing honest empty-value convention ("—"), never as blank space and never as
 * leaked template syntax.
 *
 * Reuses `collectRenderedText`/`scanForbidden` from `no-prototype-copy.test.ts` per that file's
 * own instruction to extend rather than duplicate the scan helpers — this suite adds a project
 * with REAL (non-empty) data whose `description` is empty, a scenario the empty-dataset sweep in
 * that file never exercises (there are no projects at all in `EMPTY_DATASET`).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { render, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import type { Project } from '@/prototype/types/prototype-types';
import ProjectsView from '@/views/projects/ProjectsView';
import ProjectOverviewView from '@/views/projects/ProjectOverviewView';
import { collectRenderedText, scanForbidden } from './no-prototype-copy.test';

/** A real-shaped project whose goal was never filled in — exactly what
 *  `toGatewayProject` now produces once `project-profile.mjs` nulls an
 *  unfilled `<...>` scaffold field (`description: profile.projectGoal ?? ''`
 *  collapses `null` to `''`). Built the same way the rest of this app's
 *  gateway-derived records are: `Omit<Project, 'prototype'>` cast, never a
 *  fixture `prototype: true` marker. */
const PROJECT_WITH_NO_GOAL = {
  id: '100 apps',
  name: '100 apps',
  description: '',
  type: 'full-stack',
  status: 'idle',
  lastActivity: '',
  path: 'C:\\Users\\YOU\\Documents\\100 apps',
  templateVersion: '',
  pinned: false,
  conversationCount: 0,
  missionCount: 0,
  taskCount: 0,
  agentCount: 0,
  skills: [],
  health: { tests: { passed: 0, failed: 0, skipped: 0 }, openTickets: 0, blockers: 0, score: 0 },
} as unknown as Project;

// Defense-in-depth: proves the OLD defect class (a raw scaffold token reaching the DOM) cannot
// happen even if some future change ever let a placeholder string slip past the gateway filter.
// Deliberately generic (not just "<one or two lines>") — matches any "<...>" bracket token.
const RAW_TEMPLATE_TOKEN_RE = /<[a-z0-9 /_-]+>/i;

function buildState(project: Project, activeProjectId: string): PrototypeState {
  return {
    data: { ...EMPTY_DATASET, projects: [project] },
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
    activeProjectId,
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

function renderWithState(ui: ReturnType<typeof createElement>, state: PrototypeState) {
  const value: StoreValue = { state, dispatch: () => undefined };
  return render(
    createElement(MemoryRouter, null, createElement(PrototypeContext.Provider, { value }, ui)),
  );
}

describe('an absent project goal renders the honest empty-value convention, never leaked template syntax', () => {
  afterEach(() => cleanup());

  it('ProjectsView shows "—" for the description, not blank space', () => {
    const { container } = renderWithState(
      createElement(ProjectsView),
      buildState(PROJECT_WITH_NO_GOAL, ''),
    );
    const description = container.querySelector('.fw-projects__description');
    expect(description?.textContent).toBe('—');
  });

  it('ProjectOverviewView shows "—" for the description, not blank space', () => {
    const { container } = renderWithState(
      createElement(ProjectOverviewView),
      buildState(PROJECT_WITH_NO_GOAL, '100 apps'),
    );
    const description = container.querySelector('.fw-project__description');
    expect(description?.textContent).toBe('—');
  });

  it('ProjectsView renders zero forbidden strings and no raw "<...>" template token', () => {
    const { container } = renderWithState(
      createElement(ProjectsView),
      buildState(PROJECT_WITH_NO_GOAL, ''),
    );
    const text = collectRenderedText(container);
    expect(scanForbidden(text)).toEqual([]);
    expect(RAW_TEMPLATE_TOKEN_RE.test(text)).toBe(false);
  });

  it('ProjectOverviewView renders zero forbidden strings and no raw "<...>" template token', () => {
    const { container } = renderWithState(
      createElement(ProjectOverviewView),
      buildState(PROJECT_WITH_NO_GOAL, '100 apps'),
    );
    const text = collectRenderedText(container);
    expect(scanForbidden(text)).toEqual([]);
    expect(RAW_TEMPLATE_TOKEN_RE.test(text)).toBe(false);
  });

  it('a real, non-empty description still renders verbatim (the fallback never masks real content)', () => {
    const withGoal = { ...PROJECT_WITH_NO_GOAL, description: 'A real, filled-in project goal.' } as Project;
    const { container } = renderWithState(
      createElement(ProjectsView),
      buildState(withGoal, ''),
    );
    const description = container.querySelector('.fw-projects__description');
    expect(description?.textContent).toBe('A real, filled-in project goal.');
  });
});
