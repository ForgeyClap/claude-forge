/**
 * `ProductionProvider`'s conversation-reconciliation effect — fix-activation-race
 * (forge-2026-07-30-cc-finish), WP fix-activation-race.
 *
 * BUG THIS GUARDS AGAINST — hit independently by two agents, not theoretical:
 *   (a) delete-agent finding: the old effect auto-reselected `data.conversations[0].id`
 *       gateway-wide, unfiltered by project. `GET /api/conversations` did not yet honour
 *       its own `?project=` filter (fixed separately, in the gateway), so that first row
 *       could belong to an entirely different project than the one active here.
 *   (b) E2E-agent finding: mid-test, `activeConversationId` got silently reassigned to an
 *       UNRELATED conversation (from a different, concurrently active conversation) and
 *       never recovered. Root cause: deleting the active conversation makes
 *       `Sidebar.tsx` deliberately clear the selection (`conversation/activate` to `''`)
 *       to detach — but that shape is indistinguishable from "cold start, nothing chosen
 *       yet" (both are an empty `activeConversationId`), so the old effect fired again on
 *       the very next data tick and jumped to `data.conversations[0]`.
 *
 * THE FIX (`PrototypeProvider.tsx`'s conversation-reconciliation effect): candidates are
 * filtered to the ACTIVE project, and the effect settles AT MOST ONCE per project for the
 * life of the mount (see that effect's own header comment for why a bounded time grace,
 * unlike the project-side `activationGraceActive`, is the wrong tool here — an empty
 * conversation selection is a legitimate PERMANENT resting state, not a race).
 *
 * This suite mounts the REAL `<PrototypeProvider>` (production branch, `ProductionProvider`)
 * with the REAL reducer (`prototype-store.ts`'s `reducer`, untouched) — not a hand-built
 * context stub. Only the three gateway hooks that supply external data are replaced
 * (`useGatewayDataset`, `useGatewayFilesController`, `useGatewayChatSendController`), mirroring
 * `prototype-provider-fixture-mode.test.tsx`'s own "mount the real component" precedent. A
 * `Probe` reads `usePrototype()` and exposes the real `dispatch` so tests can drive the exact
 * actions `Sidebar.tsx` / the app itself would (`project/activate`, `conversation/activate`)
 * without needing to wait out the unrelated project-side grace window.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, useEffect } from 'react';
import type { MutableRefObject } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';

import { disallowFixtureData } from '@/config/mode';
import { PrototypeProvider } from '@/prototype/PrototypeProvider';
import { usePrototype } from '@/prototype/state/prototype-store';
import type { PrototypeAction, PrototypeDataset } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import type { Conversation, Project } from '@/prototype/types/prototype-types';

/* ========================================================================== */
/*  Mocks — the three gateway hooks `ProductionProvider` calls directly       */
/* ========================================================================== */

const gatewayMock = vi.hoisted(() => {
  let dataset: unknown = null;
  return {
    setDataset: (d: unknown) => {
      dataset = d;
    },
    getDataset: () => dataset,
  };
});

vi.mock('@/prototype/state/gateway-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/prototype/state/gateway-adapter')>();
  return { ...actual, useGatewayDataset: () => gatewayMock.getDataset() };
});

vi.mock('@/prototype/state/gateway-files', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/prototype/state/gateway-files')>();
  return {
    ...actual,
    useGatewayFilesController: () => ({ tree: [], ensureLoaded: () => undefined, preview: null }),
  };
});

vi.mock('@/prototype/state/gateway-chat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/prototype/state/gateway-chat')>();
  return {
    ...actual,
    useGatewayChatSendController: () => ({
      run: { runId: null, status: null, active: false },
      canSend: true,
      disabledReason: null,
      sending: false,
      stopping: false,
      send: async () => ({ ok: true, error: null }),
      stop: async () => ({ ok: true, error: null }),
    }),
  };
});

/* ========================================================================== */
/*  Fixtures                                                                   */
/* ========================================================================== */

function buildProject(id: string, name: string): Project {
  return {
    prototype: true,
    id,
    name,
    description: '',
    type: 'unknown',
    status: 'waiting',
    lastActivity: '2026-07-30T00:00:00.000Z',
    path: `C:\\Users\\YOU\\Documents\\${id}`,
    templateVersion: 'v1',
    pinned: false,
    conversationCount: 0,
    missionCount: 0,
    taskCount: 0,
    agentCount: 0,
    skills: [],
    health: { tests: { passed: 0, failed: 0, skipped: 0 }, openTickets: 0, blockers: 0, score: 0 },
  };
}

function buildConversation(id: string, projectId: string, title: string): Conversation {
  return {
    prototype: true,
    id,
    projectId,
    title,
    updatedAt: '2 min ago',
    messageCount: 0,
    messages: [],
  };
}

const PROJECT_A = buildProject('proj-a', 'Project A');
const PROJECT_B = buildProject('proj-b', 'Project B');

/* ========================================================================== */
/*  Harness                                                                    */
/* ========================================================================== */

interface ProbeHandle {
  readonly dispatch: (action: PrototypeAction) => void;
}

function Probe({ handleRef }: { handleRef: MutableRefObject<ProbeHandle | null> }) {
  const { state, dispatch } = usePrototype();
  useEffect(() => {
    handleRef.current = { dispatch };
  }, [handleRef, dispatch]);
  return createElement(
    'div',
    null,
    createElement('span', { 'data-testid': 'active-project' }, state.activeProjectId),
    createElement('span', { 'data-testid': 'active-conversation' }, state.activeConversationId),
  );
}

function activeConversationText(): string {
  return screen.getByTestId('active-conversation').textContent ?? '';
}

function renderWorkspace(dataset: PrototypeDataset): {
  readonly handleRef: MutableRefObject<ProbeHandle | null>;
  readonly rerenderWithDataset: (next: PrototypeDataset) => void;
} {
  gatewayMock.setDataset(dataset);
  const handleRef: MutableRefObject<ProbeHandle | null> = { current: null };
  const { rerender } = render(createElement(PrototypeProvider, null, createElement(Probe, { handleRef })));

  function rerenderWithDataset(next: PrototypeDataset): void {
    gatewayMock.setDataset(next);
    rerender(createElement(PrototypeProvider, null, createElement(Probe, { handleRef })));
  }

  return { handleRef, rerenderWithDataset };
}

function activateProject(handleRef: MutableRefObject<ProbeHandle | null>, id: string): void {
  act(() => {
    handleRef.current?.dispatch({ type: 'project/activate', id });
  });
}

function activateConversation(handleRef: MutableRefObject<ProbeHandle | null>, id: string): void {
  act(() => {
    handleRef.current?.dispatch({ type: 'conversation/activate', id });
  });
}

beforeEach(() => {
  disallowFixtureData();
});

afterEach(() => {
  cleanup();
  disallowFixtureData();
  vi.unstubAllGlobals();
});

/* ========================================================================== */
/*  Tests                                                                      */
/* ========================================================================== */

describe('conversation reconciliation — cold start', () => {
  it('selects a conversation belonging to the ACTIVE project (never the gateway-wide first row)', async () => {
    // Deliberately ordered so the foreign-project row is FIRST — the exact shape the old
    // "data.conversations[0]" code would have picked.
    const dataset: PrototypeDataset = {
      ...EMPTY_DATASET,
      projects: [PROJECT_A, PROJECT_B],
      conversations: [
        buildConversation('conv-b1', PROJECT_B.id, 'Beta thread'),
        buildConversation('conv-a1', PROJECT_A.id, 'Alpha thread one'),
        buildConversation('conv-a2', PROJECT_A.id, 'Alpha thread two'),
      ],
    };
    const { handleRef } = renderWorkspace(dataset);
    activateProject(handleRef, PROJECT_A.id);

    await waitFor(() => expect(activeConversationText()).toBe('conv-a1'));
    expect(activeConversationText()).not.toBe('conv-b1');
  });
});

describe('conversation reconciliation — never crosses project boundaries', () => {
  it('never activates a conversation from a different project, even when it is the only row available', async () => {
    const dataset: PrototypeDataset = {
      ...EMPTY_DATASET,
      projects: [PROJECT_A, PROJECT_B],
      conversations: [buildConversation('conv-b1', PROJECT_B.id, 'Beta thread')],
    };
    const { handleRef } = renderWorkspace(dataset);
    activateProject(handleRef, PROJECT_A.id);

    // No candidate exists for project A — the empty state must be left alone, not
    // filled in with the only (foreign) row that happens to exist.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(activeConversationText()).toBe('');
    expect(activeConversationText()).not.toBe('conv-b1');
  });

  it('a mixed-project list never cross-contaminates, regardless of row order', async () => {
    const dataset: PrototypeDataset = {
      ...EMPTY_DATASET,
      projects: [PROJECT_A, PROJECT_B],
      conversations: [
        buildConversation('conv-b1', PROJECT_B.id, 'Beta one'),
        buildConversation('conv-b2', PROJECT_B.id, 'Beta two'),
        buildConversation('conv-a1', PROJECT_A.id, 'Alpha one'),
      ],
    };
    const { handleRef } = renderWorkspace(dataset);
    activateProject(handleRef, PROJECT_A.id);

    await waitFor(() => expect(activeConversationText()).toBe('conv-a1'));
    expect(activeConversationText()).not.toBe('conv-b1');
    expect(activeConversationText()).not.toBe('conv-b2');
  });
});

describe('conversation reconciliation — a cleared selection stays cleared (the delete-detach case)', () => {
  it('after deleting the active conversation, the empty state stays stable — no jump to an unrelated conversation', async () => {
    const dataset: PrototypeDataset = {
      ...EMPTY_DATASET,
      projects: [PROJECT_A, PROJECT_B],
      conversations: [
        buildConversation('conv-a1', PROJECT_A.id, 'Alpha one'),
        buildConversation('conv-a2', PROJECT_A.id, 'Alpha two'),
      ],
    };
    const { handleRef, rerenderWithDataset } = renderWorkspace(dataset);
    activateProject(handleRef, PROJECT_A.id);

    // Cold start settles on the first same-project conversation, exactly as intended.
    await waitFor(() => expect(activeConversationText()).toBe('conv-a1'));

    // Mirrors Sidebar.tsx's real delete-detach: clear the selection explicitly.
    activateConversation(handleRef, '');
    expect(activeConversationText()).toBe('');

    // A later poll tick removes the deleted conversation from the gateway's own list —
    // a NEW dataset reference, so the effect's dependency array changes and it re-runs.
    rerenderWithDataset({
      ...EMPTY_DATASET,
      projects: [PROJECT_A, PROJECT_B],
      conversations: [buildConversation('conv-a2', PROJECT_A.id, 'Alpha two')],
    });

    // Must stay empty — the reconciliation already settled for this project once and
    // must never resurrect a substitute after an explicit clear.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(activeConversationText()).toBe('');
    expect(activeConversationText()).not.toBe('conv-a2');
  });
});
