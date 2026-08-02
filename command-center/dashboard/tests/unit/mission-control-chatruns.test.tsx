/**
 * MissionControlView — feat-chatruns-tabs: the "no active Forge mission" branch now shows real
 * dashboard-CHAT activity instead of a blanket "No mission running" whenever the active project's
 * most recent recorded activity came from a chat run rather than a `/forge` mission.
 *
 * `MissionControlView` mounts `useGatewayChatRuns` (and the pre-existing `useGatewayApprovals`)
 * directly — both real gateway hooks — so `fetch` is stubbed here the same way
 * `recovery-approvals-panels.test.tsx` already does for `RecoveryPanel`. State is a hand-built,
 * production-shaped `PrototypeState` with an empty graph/no runs (mirrors
 * `artifacts-download.test.tsx`'s harness shape) — no gateway/network involved beyond the stub.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';

import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';

import MissionControlView from '@/views/mission/MissionControlView';

function buildState(activeProjectId: string): PrototypeState {
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

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function renderView(activeProjectId: string) {
  const value: StoreValue = { state: buildState(activeProjectId), dispatch: () => undefined };
  return render(createElement(PrototypeContext.Provider, { value }, createElement(MissionControlView)));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('MissionControlView — real chat-run activity in the empty-mission branch', () => {
  it('shows the real chat-run title/status/id instead of "No mission running" when one exists', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes('/api/chat-runs')) {
          return jsonResponse({
            ok: true,
            chat_runs: [
              {
                run_id: 'chat-c-abc123-t-xyz789',
                title: 'Build a landing page for LittleBazzar',
                status: 'completed',
                started_at: '2026-07-30T09:00:00.000Z',
                ended_at: '2026-07-30T09:04:00.000Z',
                duration_ms: 240000,
                stop_reason: 'end_turn',
                model: 'claude-opus-5',
                input_tokens: 500,
                output_tokens: 900,
                todos: [],
                file_edits: [],
              },
            ],
          });
        }
        return jsonResponse({});
      }),
    );

    const { container, findByText } = renderView('littlebazzar');

    expect(await findByText('Build a landing page for LittleBazzar')).toBeTruthy();
    expect(await findByText('chat-c-abc123-t-xyz789')).toBeTruthy();
    expect(container.textContent).not.toContain('No mission running');
    expect(await findByText('No multi-agent Forge mission is running')).toBeTruthy();
  });

  it('a project with no chat activity at all still shows the plain "No mission running" state (empty stays empty)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes('/api/chat-runs')) return jsonResponse({ ok: true, chat_runs: [] });
        return jsonResponse({});
      }),
    );

    const { findByText, container } = renderView('a-quiet-project');

    expect(await findByText('No mission running')).toBeTruthy();
    await waitFor(() => expect(container.textContent).not.toContain('No multi-agent Forge mission is running'));
  });

  it('a gateway/network error for chat-runs falls back to the plain empty state, never a crash', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );

    const { findByText } = renderView('a-project-during-an-outage');

    expect(await findByText('No mission running')).toBeTruthy();
  });
});
