/**
 * F8 (forge-2026-07-29-cc-finish, WP fix-cert-claims) — Settings' "Data and
 * privacy" panel used to claim every value shown is "never fabricated to
 * fill a gap". That absolute promise is not something this one file's own
 * render output can prove on its own (a sibling work package this same run
 * fixes a real fabricated "Health 0%" elsewhere in the workspace), and a
 * promise no test anywhere actually enforces is as misleading as a false
 * one. The corrected copy states only what this workspace's own honesty
 * convention actually guarantees and what this suite can verify directly:
 * a value it cannot read renders as an explicit absence marker, never an
 * invented number standing in for it — the same `?? '—'` / `EmptyState`
 * convention exercised throughout this same file (see e.g.
 * `settings-mcp-counts-honesty.test.tsx`).
 *
 * `FORBIDDEN_PATTERNS` is intentionally re-declared narrowly here rather than
 * imported from `no-prototype-copy.test.ts` — importing one vitest test file
 * from another would re-register that file's own `describe`/`it` blocks a
 * second time (see `recovery-approvals-panels.test.tsx`'s header for the
 * same precedent).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';

import SettingsView from '@/views/settings/SettingsView';

/* ========================================================================== */
/*  Forbidden vocabulary — narrow local copy, see file header                 */
/* ========================================================================== */

const FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /\bexample\b/i,
  /\bprototype\b/i,
  /\bplaceholder\b/i,
  /\bnot connected\b/i,
  /\bno backend\b/i,
  /\bnothing was generated\b/i,
  /\bsimulated\b/i,
];

/**
 * `forge.prototype.appearance` / `forge.prototype.density` are the REAL
 * localStorage key names this same Privacy panel's "What is stored" table
 * discloses a few rows above the claim this suite checks — real, accurate
 * identifiers that happen to contain "prototype" as a substring, not a
 * forbidden claim (same exact-match allowlist `no-prototype-copy.test.ts`'s
 * shell-chrome section already applies, re-declared narrowly here for the
 * same reason `FORBIDDEN_PATTERNS` is re-declared rather than imported).
 */
const ALLOWED_EXACT_STRINGS: readonly string[] = ['forge.prototype.appearance', 'forge.prototype.density'];

function scanForbidden(text: string): string[] {
  let sanitized = text;
  for (const allowed of ALLOWED_EXACT_STRINGS) {
    sanitized = sanitized.split(allowed).join('');
  }
  return FORBIDDEN_PATTERNS.filter((pattern) => pattern.test(sanitized)).map((pattern) => pattern.source);
}

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

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function installFetchMock(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => jsonResponse({})),
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

describe('F8 — the privacy panel makes only the claim this workspace actually enforces', () => {
  beforeEach(() => installFetchMock());

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('states the real/absence-marker guarantee, and drops the unverifiable "never fabricated" promise', async () => {
    renderSettings();
    await flush();

    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    fireEvent.click(within(nav).getByText('Data and privacy'));
    await flush();

    const text = document.body.textContent ?? '';

    // The corrected claim: real gateway data, or an explicit absence marker —
    // never an invented number filling the gap.
    expect(text).toContain('Every project, agent, run and ledger line you see is read from a real gateway');
    expect(text).toContain('record.');
    expect(text).toContain('renders as an absence marker');
    expect(text).toContain('never an invented number standing in for it');

    // The old, unfalsifiable absolute promise must not reappear.
    expect(text).not.toMatch(/never fabricated to fill a gap/i);

    expect(scanForbidden(text)).toEqual([]);
  });
});
