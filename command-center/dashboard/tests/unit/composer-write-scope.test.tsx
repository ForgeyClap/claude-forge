/**
 * Composer write-scope disclosure (fix-composer-truth, forge-2026-07-29-cc-finish).
 *
 * D1 from `mission/test-evidence/E2E-PART2-report.md` §3/§9: a real, paid `claude -p`
 * send was refused for a path outside the active project's folder — the CLI has no
 * permission-bypass and the composer said nothing about that boundary before the
 * message was sent. This suite locks in the fix: the composer's own production hint
 * (and the equivalent Settings ▸ "Claude Code connection" fact) must state the real
 * write scope, naming the real active project's path when one resolves in state and
 * falling back to an honest, non-fabricated phrase when it does not — and neither
 * surface may regress into forbidden fixture/prototype vocabulary while doing it.
 *
 * Reuses `no-prototype-copy.test.ts`'s exported scan helpers rather than forking
 * them (that file's own header asks extenders to do exactly this).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import type { ReactElement } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { FORBIDDEN_PATTERNS, collectRenderedText, scanForbidden } from './no-prototype-copy.test';
import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import type { Project } from '@/prototype/types/prototype-types';
import { Composer } from '@/views/chat/Composer';
import AppShell from '@/components/shell/AppShell';
import { PrototypeProvider } from '@/prototype/PrototypeProvider';
import SettingsView from '@/views/settings/SettingsView';

/* ========================================================================== */
/*  Shared fixtures                                                            */
/* ========================================================================== */

const REAL_PROJECT: Project = {
  prototype: true,
  id: 'proj-active',
  name: 'my project (v2)!',
  description: 'A real project row used only to assert the composer names its real path.',
  type: 'unknown',
  status: 'waiting',
  lastActivity: '2026-07-29T00:00:00.000Z',
  path: 'C:\\Users\\YOU\\Documents\\my project (v2)!',
  templateVersion: 'v1',
  pinned: false,
  conversationCount: 0,
  missionCount: 0,
  taskCount: 0,
  agentCount: 0,
  skills: [],
  health: { tests: { passed: 0, failed: 0, skipped: 0 }, openTickets: 0, blockers: 0, score: 0 },
};

/** The exact empty floor production starts from — mirrors `no-prototype-copy.test.ts`. */
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
  const value: StoreValue = { state, dispatch: () => undefined };
  return render(createElement(PrototypeContext.Provider, { value }, ui));
}

/* ========================================================================== */
/*  Composer                                                                   */
/* ========================================================================== */

describe('Composer write-scope disclosure', () => {
  afterEach(() => cleanup());

  it('names the real active project path when one resolves in state', () => {
    const state = buildState({
      data: { ...EMPTY_DATASET, projects: [REAL_PROJECT] },
      activeProjectId: REAL_PROJECT.id,
    });
    const { container } = renderWithState(
      createElement(Composer, {
        onSend: () => true,
        onStop: () => undefined,
        streaming: false,
        conversationTitle: 'Test conversation',
        production: true,
      }),
      state,
    );

    const text = collectRenderedText(container);
    expect(text).toContain(REAL_PROJECT.path);
    expect(text).toMatch(/refused/i);
    expect(scanForbidden(text)).toEqual([]);
  });

  it('states the real rule without fabricating a path when no active project resolves', () => {
    const state = buildState(); // activeProjectId: '', projects: []
    const { container } = renderWithState(
      createElement(Composer, {
        onSend: () => true,
        onStop: () => undefined,
        streaming: false,
        conversationTitle: 'Test conversation',
        production: true,
      }),
      state,
    );

    const text = collectRenderedText(container);
    expect(text).toContain("this project's folder");
    expect(text).toMatch(/refused/i);
    // No stray path text was invented for the missing-project case.
    expect(text).not.toContain(REAL_PROJECT.path);
    expect(scanForbidden(text)).toEqual([]);
  });

  it('leaves the fixtures-mode composer unchanged (no write-scope claim without production)', () => {
    const state = buildState();
    const { container } = renderWithState(
      createElement(Composer, {
        onSend: () => true,
        onStop: () => undefined,
        streaming: false,
        conversationTitle: 'Test conversation',
        production: false,
      }),
      state,
    );

    expect(collectRenderedText(container)).not.toMatch(/Claude Code session/i);
  });
});

/* ========================================================================== */
/*  Settings ▸ Claude Code connection — the same fact, reinforced               */
/* ========================================================================== */

const FAKE_PROJECT_ROW = { name: 'my project (v2)!', path: 'C:\\Users\\YOU\\Documents\\my project (v2)!', has_dashboard: false };

function installFetchMock(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/api/projects')) {
        return { ok: true, status: 200, json: async () => ({ projects: [FAKE_PROJECT_ROW] }) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }),
  );
}

async function flush(ms = 30): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Settings ▸ Claude Code connection write-scope fact', () => {
  beforeEach(() => installFetchMock());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('states the same no-permission-bypass write scope as the composer', async () => {
    render(
      createElement(
        MemoryRouter,
        null,
        createElement(PrototypeProvider, null, createElement(AppShell, null, createElement(SettingsView))),
      ),
    );
    await flush();

    const settingsNav = screen.getByRole('navigation', { name: 'Settings sections' });
    fireEvent.click(within(settingsNav).getByText('Claude Code connection'));
    await flush();

    const text = collectRenderedText(document.body);
    expect(text).toMatch(/no permission-bypass/i);
    expect(text).toMatch(/refused/i);
    expect(scanForbidden(text)).toEqual([]);
  });
});

/** Sanity: this suite reuses the shared forbidden-pattern list, not a private fork. */
describe('shared forbidden-pattern list is actually imported, not reimplemented', () => {
  it('exposes at least the documented terms', () => {
    expect(FORBIDDEN_PATTERNS.length).toBeGreaterThanOrEqual(5);
  });
});
