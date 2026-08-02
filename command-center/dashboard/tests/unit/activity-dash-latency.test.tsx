/**
 * ActivityView — cc-fix-dash-latency (forge-2026-07-29-cc-finish, WP fix-dash-latency) render
 * coverage for #3 (a run's `event_scan_error` shown in the run header) and the corrected
 * truncated-history wording (now honest for BOTH truncation causes, not just the original one).
 *
 * Mirrors `no-prototype-copy.test.ts`'s harness: a REAL `PrototypeContext` value built from the
 * real, production-shaped `EMPTY_DATASET` (never `ProductionProvider`, which would make real
 * `fetch`/`EventSource` calls against 127.0.0.1:4100), extended here with a real populated run +
 * event so BOTH the empty-render path (already covered by `no-prototype-copy.test.ts`) and the
 * populated-render path (this file) are exercised — a lesson this project's own memory already
 * flags: an empty-dataset-only render test can miss branches a populated one reaches.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { render, cleanup, waitFor } from '@testing-library/react';

import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import type { ActivityEvent, Run } from '@/prototype/types/prototype-types';

import ActivityView from '@/views/activity/ActivityView';

const RUN = {
  id: 'run-1',
  projectId: 'demo-project',
  goal: 'Ship the dashboard latency fix',
  status: 'completed',
  startedAt: '2026-07-29T09:00:00.000Z',
  duration: '2m 0s',
  workPackageIds: [],
  agentIds: [],
} as unknown as Run;

const EVENT = {
  id: 'evt-1',
  runId: 'run-1',
  timestamp: '2026-07-29T09:00:05.000Z',
  kind: 'system',
  agent: null,
  status: 'completed',
  message: 'Run started',
  detail: 'Run started for demo-project.',
} as unknown as ActivityEvent;

function buildPopulatedState(): PrototypeState {
  return {
    data: { ...EMPTY_DATASET, runs: [RUN], events: [EVENT] },
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
    activeProjectId: 'demo-project',
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

/** Answers `/api/events` and `/api/runs` with a caller-supplied shape; everything else (e.g.
 *  RecoveryPanel's `/api/recovery`/`/api/checkpoints`) gets an honest empty `{}`. */
function installFetchMock(opts: { eventsBody: unknown; runsBody: unknown }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/api/events') && !url.includes('/stream')) {
        return { ok: true, status: 200, json: async () => opts.eventsBody };
      }
      if (url.includes('/api/runs')) {
        return { ok: true, status: 200, json: async () => opts.runsBody };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }),
  );
}

function renderActivity() {
  const value: StoreValue = { state: buildPopulatedState(), dispatch: () => undefined };
  return render(createElement(PrototypeContext.Provider, { value }, createElement(ActivityView)));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ActivityView — event_scan_error shown in the run header (#3)', () => {
  it('shows the honest "event log unreadable" note, with the real gateway message in the title, for a run whose scan failed', async () => {
    installFetchMock({
      eventsBody: { events: [], truncated: false, malformed_lines: 0, next_after: 0 },
      runsBody: {
        runs: [
          {
            run_id: 'run-1',
            has_final_report: true,
            event_count: 0,
            mtime: '2026-07-29T09:00:00.000Z',
            duration_ms: null,
            duration_source: null,
            event_scan_error: "failed to read events.jsonl: EACCES: permission denied, open 'events.jsonl'",
          },
        ],
      },
    });

    const { container } = renderActivity();

    await waitFor(() => expect(container.textContent).toContain('Event log unreadable'));
    const note = container.querySelector('[title*="EACCES"]');
    expect(note).not.toBeNull();
    expect(note?.textContent).toBe('Event log unreadable — event count may be understated');
  });

  it('shows nothing extra for a run with no scan error (event_scan_error: null)', async () => {
    installFetchMock({
      eventsBody: { events: [], truncated: false, malformed_lines: 0, next_after: 0 },
      runsBody: {
        runs: [
          {
            run_id: 'run-1',
            has_final_report: true,
            event_count: 3,
            mtime: '2026-07-29T09:00:00.000Z',
            duration_ms: 60000,
            duration_source: 'derived-from-events',
            event_scan_error: null,
          },
        ],
      },
    });

    const { container } = renderActivity();

    // Let the /api/runs poll resolve before asserting a negative.
    await waitFor(() => expect(container.textContent).toContain('run-1'));
    expect(container.textContent).not.toContain('Event log unreadable');
  });
});

describe('ActivityView — truncated-history wording is honest for both truncation causes', () => {
  it('shows the corrected "no longer available" wording, not the old "were not loaded" claim', async () => {
    installFetchMock({
      eventsBody: { events: [], truncated: true, malformed_lines: 0, next_after: 0 },
      runsBody: { runs: [{ run_id: 'run-1', has_final_report: true, event_count: 0, mtime: 'x', duration_ms: null, duration_source: null, event_scan_error: null }] },
    });

    const { container } = renderActivity();

    await waitFor(() => expect(container.textContent).toContain('History truncated'));
    expect(container.textContent).toContain('History truncated — earlier events are no longer available');
    expect(container.textContent).not.toContain('were not loaded');
  });
});
