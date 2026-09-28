/**
 * ActivityView — Codex verification NEW-2 (2026-09-28): a run picked in one project must not carry over
 * to another project. Before the fix the picked run id stayed selected after a project switch, and the
 * view asked the NEW project's /api/events for a run it does not have (an empty timeline).
 *
 * Same harness as activity-dash-latency.test.tsx: a real PrototypeContext value built from the real
 * EMPTY_DATASET, fetch stubbed (never a real gateway).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import type { Run } from '@/prototype/types/prototype-types';

import ActivityView from '@/views/activity/ActivityView';

function run(id: string, projectId: string, startedAt: string): Run {
  return { id, projectId, goal: 'g', status: 'completed', startedAt, duration: '1m', workPackageIds: [], agentIds: [] } as unknown as Run;
}

function stateFor(projectId: string, runs: readonly Run[]): PrototypeState {
  return {
    data: { ...EMPTY_DATASET, runs: [...runs], events: [] },
    appearance: 'dark', resolvedTheme: 'dark', density: 'comfortable', reducedMotion: false,
    sidebarCollapsed: false, mobileDrawerOpen: false, inspectorOpen: false, dockOpen: false, dockTab: 'activity',
    paletteOpen: false, activeProjectId: projectId, activeConversationId: '', selection: { kind: 'none' },
    pinnedProjectIds: [], projectQuery: '', agentFilter: 'all', agentLayout: 'grouped', taskLayout: 'kanban',
    taskColumnOverrides: {}, extraMessages: {}, stream: null, claudeCodeState: 'not-connected', toasts: [],
  };
}

const requested: string[] = [];

function installFetchMock(): void {
  requested.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input);
    requested.push(url);
    if (url.includes('/api/events') && !url.includes('/stream')) {
      return { ok: true, status: 200, json: async () => ({ events: [], truncated: false, malformed_lines: 0, next_after: 0 }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  }));
}

function view(state: PrototypeState) {
  const value: StoreValue = { state, dispatch: () => undefined };
  return createElement(PrototypeContext.Provider, { value }, createElement(ActivityView));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ActivityView — the run pick belongs to its project (NEW-2)', () => {
  it('goes back to the current run after a project switch and never asks the new project for the old run', async () => {
    installFetchMock();
    const alpha = [run('alpha-new', 'alpha', '2026-09-28T10:00:00.000Z'), run('alpha-old', 'alpha', '2026-09-27T10:00:00.000Z')];
    const { rerender } = render(view(stateFor('alpha', alpha)));
    const picker = screen.getByLabelText('Run') as HTMLSelectElement;
    fireEvent.change(picker, { target: { value: 'alpha-old' } });
    expect((screen.getByLabelText('Run') as HTMLSelectElement).value).toBe('alpha-old');

    const beta = [run('beta-new', 'beta', '2026-09-28T11:00:00.000Z')];
    requested.length = 0;
    rerender(view(stateFor('beta', beta)));
    expect((screen.getByLabelText('Run') as HTMLSelectElement).value).toBe('');
    await new Promise((r) => setTimeout(r, 50));
    const asksBetaForAlphaRun = requested.some((u) => u.includes('project=beta') && u.includes('alpha-old'));
    expect(asksBetaForAlphaRun).toBe(false);
  });
});
