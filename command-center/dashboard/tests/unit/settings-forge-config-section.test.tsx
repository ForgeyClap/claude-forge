/**
 * wp12 (forge-2026-09-24-config-v250) — Settings ▸ Forge settings, the
 * read-only view of the active project's own Forge settings (GET /api/config).
 *
 * Same minimal harness as `settings-mcp-counts-honesty.test.tsx`: `SettingsView`
 * against a hand-built `PrototypeState` with an active project, and a stubbed
 * `fetch` standing in for the gateway — so the real `useGatewayForgeConfig`
 * hook and its parser run unchanged. The payload is a trimmed copy of the
 * real response this project's forge-config.cjs produced.
 *
 * Locks in: the five columns, the tool's own groups, the copyable
 * `/forge config set` command per row (flip for on/off, current value
 * otherwise), the disclosure footnotes, the locked list, that nothing in the
 * section is an interactive control (read-only), and the honest unavailable
 * state that never renders a settings table.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
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

function setting(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    source: 'default',
    set_at: null,
    set_by: null,
    status: 'on',
    scope: 'project',
    unit: null,
    off_means: null,
    disclosure: null,
    flags: [],
    ...overrides,
  };
}

const CONFIG_PAYLOAD = {
  ok: true,
  available: true,
  state: 'OK',
  settings: [
    setting({
      key: 'usage-guard',
      value: true,
      default: true,
      display: 'on',
      scope: 'global',
      group: 'core',
      type: 'bool',
      desc: 'Pauses Forge automatically just before your Claude usage limit.',
      disclosure: 'Reads your Claude login token locally and sends it only to api.anthropic.com.',
      flags: ['C', 'N', 'U'],
    }),
    setting({
      key: 'usage-guard.pause-at',
      value: 98,
      default: 98,
      display: '98 %',
      scope: 'global',
      group: 'core',
      type: 'int',
      unit: '%',
      desc: 'Forge pauses at this percentage of your usage limit.',
    }),
    setting({
      key: 'autonomy',
      value: 'continue-within-mission',
      default: 'continue-within-mission',
      display: 'continue-within-mission',
      source: 'product-default',
      group: 'core',
      type: 'enum',
      desc: 'How far Forge goes on its own.',
    }),
    setting({
      key: 'paperclip',
      value: false,
      default: false,
      display: 'off',
      status: 'off',
      group: 'when-needed',
      type: 'bool',
      desc: 'Paperclip integration.',
      disclosure: 'Runs a background service.',
      flags: ['U', '$'],
    }),
    setting({
      key: 'cleanup',
      value: 'report',
      default: 'report',
      display: 'report',
      status: null,
      group: 'when-needed',
      type: 'enum',
      desc: 'What Forge does with leftovers.',
      flags: ['D'],
    }),
    setting({
      key: 'budget-usd',
      value: 5,
      default: 5,
      display: '5 USD',
      status: null,
      group: 'advanced',
      type: 'number',
      unit: 'USD',
      desc: 'Spending ceiling per run.',
    }),
  ],
  hidden: 0,
  locked: [
    { id: 'hard-gates', text: 'Deploy, git push, spending money — Forge ALWAYS asks first.', source: null },
    { id: 'honesty-core', text: 'Never claims a check that did not run.', source: null },
  ],
  files: {
    global: { path: '/home/me/.claude/FORGE_CONFIG.json', present: false, pretty: '~/.claude/FORGE_CONFIG.json' },
    project: { path: '/work/demo/.claude/FORGE_CONFIG.json', present: true, pretty: '.claude/FORGE_CONFIG.json' },
  },
  notes: ['Everything is at its default, that is normal.'],
  lang: 'en',
  groups: [
    { id: 'core', title: 'On by default — Forge uses this on every run' },
    { id: 'when-needed', title: 'Available when needed — Forge uses it without asking' },
    { id: 'advanced', title: 'Advanced — change only if you know why' },
  ],
  project: 'demo-project',
  captured_at: '2026-09-24T02:43:47.949Z',
  age_ms: 0,
  provenance: 'DERIVED',
};

const UNAVAILABLE_PAYLOAD = {
  ok: true,
  available: false,
  state: 'UNAVAILABLE',
  note: 'forge-config.cjs not found for this project',
  settings: [],
  locked: [],
  groups: [],
  files: null,
  notes: [],
  hidden: null,
  lang: null,
  project: null,
  captured_at: '2026-09-24T02:43:47.949Z',
  age_ms: 0,
  provenance: 'DERIVED',
};

function installFetchMock(configBody: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/api/config')) return jsonResponse(configBody);
    return jsonResponse({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function flush(ms = 20): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function openForgeSettings(): Promise<HTMLElement> {
  const value: StoreValue = { state: buildState(), dispatch: () => undefined };
  render(createElement(PrototypeContext.Provider, { value }, createElement(SettingsView)));
  await flush();
  const nav = screen.getByRole('navigation', { name: 'Settings sections' });
  fireEvent.click(within(nav).getByText('Forge settings'));
  await flush();
  const panels = document.querySelector('.fw-settings__panels');
  expect(panels).not.toBeNull();
  return panels as HTMLElement;
}

/* ========================================================================== */
/*  Tests                                                                      */
/* ========================================================================== */

describe('Settings ▸ Forge settings (wp12, read-only GET /api/config)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('asks the gateway for the active project and renders every group with the five columns', async () => {
    const fetchMock = installFetchMock(CONFIG_PAYLOAD);
    const panels = await openForgeSettings();

    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/config?project=demo-project'))).toBe(true);
    expect(screen.getByRole('heading', { name: 'Forge settings' })).toBeTruthy();

    const tables = within(panels).getAllByRole('table');
    expect(tables).toHaveLength(3); // core · when-needed · advanced
    for (const table of tables) {
      const headers = within(table).getAllByRole('columnheader').map((th) => th.textContent);
      expect(headers).toEqual(['Status', 'Setting', 'Value', 'From', 'What it does']);
    }
    const text = panels.textContent ?? '';
    expect(text).toContain('On by default — Forge uses this on every run');
    expect(text).toContain('Available when needed — Forge uses it without asking');
    expect(text).toContain('Advanced — change only if you know why');
    expect(text).toContain('or just say it in chat');
  });

  it('shows value, source and the exact /forge config set command on each row', async () => {
    installFetchMock(CONFIG_PAYLOAD);
    const panels = await openForgeSettings();

    const pauseRow = within(panels).getByText('usage-guard.pause-at').closest('tr') as HTMLElement;
    expect(within(pauseRow).getByText('98 %')).toBeTruthy();
    expect(within(pauseRow).getByText('default')).toBeTruthy();
    expect(within(pauseRow).getByText('ON')).toBeTruthy();
    expect(within(pauseRow).getByText('/forge config set usage-guard.pause-at 98')).toBeTruthy();

    const text = panels.textContent ?? '';
    // On/off settings show the command that flips them.
    expect(text).toContain('/forge config set usage-guard off');
    expect(text).toContain('/forge config set paperclip on');
    // Every other setting shows its current value, ready to edit.
    expect(text).toContain('/forge config set autonomy continue-within-mission');
    expect(text).toContain('/forge config set budget-usd 5');
    expect(within(panels).getByText('product-default')).toBeTruthy();
  });

  it('renders the disclosure footnotes, the flag legend, the settings files and the locked list', async () => {
    installFetchMock(CONFIG_PAYLOAD);
    const panels = await openForgeSettings();
    const text = panels.textContent ?? '';

    // Numbered in settings order: usage-guard [1], paperclip [2], cleanup [3].
    expect(text).toContain('Pauses Forge automatically just before your Claude usage limit. [1]');
    expect(text).toContain('[1] usage-guard (C N U): Reads your Claude login token locally');
    expect(text).toContain('[2] paperclip (U $): Runs a background service.');
    // No disclosure text: the flag words stand in, never an empty footnote.
    expect(text).toContain('[3] cleanup (D): deletes files');
    expect(text).toContain('Flags: C = reads credentials · N = uses the network · $ = costs quota or money · U = runs unattended · D = deletes files');

    expect(text).toContain('.claude/FORGE_CONFIG.json · saved');
    expect(text).toContain('~/.claude/FORGE_CONFIG.json · not created, defaults apply');
    expect(text).toContain('Everything is at its default, that is normal.');

    expect(text).toContain('hard-gates — Deploy, git push, spending money — Forge ALWAYS asks first.');
    expect(text).toContain('honesty-core — Never claims a check that did not run.');
  });

  it('is read-only: the section renders no button, switch or input of any kind', async () => {
    installFetchMock(CONFIG_PAYLOAD);
    const panels = await openForgeSettings();

    expect(within(panels).queryAllByRole('button')).toHaveLength(0);
    expect(within(panels).queryAllByRole('switch')).toHaveLength(0);
    expect(within(panels).queryAllByRole('textbox')).toHaveLength(0);
    expect(panels.querySelectorAll('input, select, textarea')).toHaveLength(0);
  });

  it('a project without forge-config.cjs shows the honest unavailable state and never a settings table', async () => {
    installFetchMock(UNAVAILABLE_PAYLOAD);
    const panels = await openForgeSettings();
    const text = panels.textContent ?? '';

    expect(text).toContain('Settings unavailable');
    expect(text).toContain('forge-config.cjs not found for this project');
    expect(within(panels).queryAllByRole('table')).toHaveLength(0);
    expect(text).not.toContain('/forge config set');
    expect(text).not.toContain('Locked');
  });
});
