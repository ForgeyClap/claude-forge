/**
 * F4 (forge-2026-07-29-cc-finish, WP fix-cert-claims) — Settings' MCP panel
 * used to fall back to a fabricated `0` (`?? 0`) whenever the gateway did not
 * report `opted_in_count`/`installed_count`, in place of this same file's own
 * established convention everywhere else (`?? '—'`, see e.g. the Connection
 * and Routed models panels). A "0" reads as a real, verified count — this
 * suite locks in the honest `'—'` fallback instead.
 *
 * Renders `SettingsView` directly against a hand-built `PrototypeState` with
 * an active project, and a stubbed `fetch` whose `/api/mcp` response reports
 * `servers` + `servers_count` but omits `opted_in_count`/`installed_count` —
 * a legitimate partial-response shape `gateway-capabilities.ts`'s own
 * `pickNumber` already treats as `null` (never a plausible default; see that
 * file's header). No `AppShell`/`PrototypeProvider` needed: `SettingsView`
 * only reads `PrototypeContext` plus the gateway hooks, which read `fetch`
 * directly (mocked here) — the same minimal harness style already used by
 * `no-prototype-copy.test.ts`'s shell-chrome section and
 * `recovery-approvals-panels.test.tsx`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';

import SettingsView from '@/views/settings/SettingsView';

/* ========================================================================== */
/*  Harness                                                                    */
/* ========================================================================== */

function buildState(): PrototypeState {
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

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

/** One real-shaped dormant server row — enough for `mcp.data.servers.length`
 *  to be non-zero so the panel renders the counts note rather than the
 *  "No MCP servers registered" empty state. */
const MCP_SERVER_ROW = {
  id: 'sequential-thinking',
  purpose: 'Structured multi-step reasoning',
  tier: 1,
  network: 'none',
  credentials_needed: false,
  status: 'dormant',
  opted_in: false,
  notes: null,
};

function installFetchMock(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      // `servers_count` is reported; `opted_in_count`/`installed_count` are
      // deliberately absent — the exact partial-response shape F4 covers.
      if (url.includes('/api/mcp')) {
        return jsonResponse({ ok: true, servers: [MCP_SERVER_ROW], servers_count: 6 });
      }
      return jsonResponse({});
    }),
  );
}

function renderSettings() {
  const value: StoreValue = { state: buildState(), dispatch: () => undefined };
  return render(createElement(PrototypeContext.Provider, { value }, createElement(SettingsView)));
}

async function flush(ms = 20): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/* ========================================================================== */
/*  Test                                                                       */
/* ========================================================================== */

describe('F4 — Settings MCP panel never fabricates a 0 for an unreported count', () => {
  beforeEach(() => installFetchMock());

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders "—" for opted-in/installed counts the gateway did not report, not "0"', async () => {
    renderSettings();
    await flush();

    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    fireEvent.click(within(nav).getByText('Capabilities'));
    await flush();

    const text = document.body.textContent ?? '';

    // The honest fallback, matching this file's own `?? '—'` convention.
    expect(text).toContain('— of 6 servers opted in');
    expect(text).toContain('— installed.');

    // The fabricated zero this WP removes must never reappear.
    expect(text).not.toMatch(/\b0 of 6 servers opted in\b/);
    expect(text).not.toMatch(/;\s*0 installed\./);
  });
});
