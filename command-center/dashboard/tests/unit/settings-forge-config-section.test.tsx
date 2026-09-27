/**
 * wp12 (forge-2026-09-24-config-v250) + WP-A (v2.9.0) — Settings ▸ Forge
 * settings: reads the active project's own Forge settings (GET /api/config)
 * and, since WP-A, writes them back for real (POST /api/config) — "we also
 * want to be able to change the config in the dashboard" (owner).
 *
 * Same minimal harness as `settings-mcp-counts-honesty.test.tsx`: `SettingsView`
 * against a hand-built `PrototypeState` with an active project, and a stubbed
 * `fetch` standing in for the gateway — so the real `useGatewayForgeConfig`
 * hook, its parser, `ForgeSettingControl` and `writeForgeConfig` all run
 * unchanged. The payload is a trimmed copy of the real response this
 * project's forge-config.cjs produced, extended with `allowed`/`min`/`max`
 * (WP-A) and two settings this suite specifically exercises: `explain-mode`
 * (an ordinary, unflagged, project-scoped bool — no confirm needed) and
 * `gate-hook` (which must never offer an off control at all).
 *
 * Locks in: the five columns, the tool's own groups, the copyable
 * `/forge config set` command per row (flip for on/off, current value
 * otherwise), the disclosure footnotes, the locked list, the honest
 * unavailable state that never renders a settings table, a real editable
 * control per setting type, the confirm modal for a flagged/global-scope
 * write, the gate-hook row's permanent lack of an off control, and honest
 * success/error toasts wired through the (spied) prototype-store dispatch.
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

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
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
    allowed: null,
    min: null,
    max: null,
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
      min: 50,
      max: 99,
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
      allowed: ['continue-within-mission', 'ask-each-phase', 'full-auto-within-mission'],
      desc: 'How far Forge goes on its own.',
    }),
    setting({
      key: 'explain-mode',
      value: true,
      default: true,
      display: 'on',
      group: 'core',
      type: 'bool',
      desc: 'Forge explains each phase in one plain sentence.',
    }),
    setting({
      key: 'gate-hook',
      value: true,
      default: true,
      display: 'on',
      group: 'core',
      type: 'bool',
      desc: 'A real stop on dangerous commands.',
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
      allowed: ['report', 'auto'],
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
      min: 0.25,
      max: 25,
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

/**
 * `onPost`, when given, answers every `POST /api/config` call (the real write route, WP-A) with
 * whatever it returns — `{ok:true, ...}` or `{ok:false, error}` — so a test can drive a success or
 * a failure without a real gateway. Every OTHER `GET /api/config` call (the initial load, and the
 * refresh a successful write triggers) still answers with `configBody`, so a test can assert on
 * whether a refetch actually happened by counting GET calls.
 */
function installFetchMock(
  configBody: unknown,
  onPost?: (body: Record<string, unknown>) => unknown,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/config') && init?.method === 'POST') {
      const requestBody = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      const responseBody = (onPost ? onPost(requestBody) : { ok: true }) as { ok?: boolean };
      // Mirrors the real gateway's own convention (every route's `{ok:false,...}` rides a real
      // non-2xx status) — gwPost() decides success/failure from the HTTP status, not the body, so
      // a mock that always answered 200 could never actually exercise a failure path.
      return jsonResponse(responseBody, responseBody.ok === false ? 400 : 200);
    }
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
  const { panels } = await openForgeSettingsWithDispatch();
  return panels;
}

/** Same as `openForgeSettings`, but with a spy `dispatch` — needed for any test that asserts a
 * `toast/push` action fired, since `Toasts` itself is a separate shell component never mounted by
 * this harness (see this file's header: only `SettingsView` is rendered). Interacting with the
 * real Switch/SegmentedControl/Modal controls under test still works with a spy dispatch — their
 * open/checked/busy state lives in `ForgeSettingControl`'s own `useState`, never in the prototype
 * store. */
async function openForgeSettingsWithDispatch(): Promise<{
  panels: HTMLElement;
  dispatch: ReturnType<typeof vi.fn>;
}> {
  const dispatch = vi.fn();
  const value: StoreValue = { state: buildState(), dispatch };
  render(createElement(PrototypeContext.Provider, { value }, createElement(SettingsView)));
  await flush();
  const nav = screen.getByRole('navigation', { name: 'Settings sections' });
  fireEvent.click(within(nav).getByText('Forge settings'));
  await flush();
  const panels = document.querySelector('.fw-settings__panels');
  expect(panels).not.toBeNull();
  return { panels: panels as HTMLElement, dispatch };
}

function toastPushCalls(dispatch: ReturnType<typeof vi.fn>): Array<{ title: string; detail: string; icon: string }> {
  return dispatch.mock.calls
    .map(([action]) => action as { type: string; toast?: { title: string; detail: string; icon: string } })
    .filter((action) => action.type === 'toast/push' && action.toast != null)
    .map((action) => action.toast as { title: string; detail: string; icon: string });
}

/* ========================================================================== */
/*  Tests                                                                      */
/* ========================================================================== */

describe('Settings ▸ Forge settings (wp12 GET /api/config + WP-A POST /api/config)', () => {
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
    // WP-A: the Value column is now the real, editable number input (see the dedicated
    // ForgeSettingControl tests below for min/max/reset coverage) — "98 %" as plain read-only
    // text no longer exists, the input carries "98" as its value instead.
    expect((within(pauseRow).getByRole('spinbutton') as HTMLInputElement).value).toBe('98');
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

  it('WP-A: renders a real, editable control per setting type, plus a reset-to-default button', async () => {
    installFetchMock(CONFIG_PAYLOAD);
    const panels = await openForgeSettings();

    // getAllByText, never getByText: a Switch's own (visually hidden) accessible-name label
    // duplicates the Setting column's text — both matches sit in the SAME <tr>, so either works
    // for .closest('tr'), but only the *All* variant tolerates there being two.
    const explainRow = within(panels).getAllByText('explain-mode')[0].closest('tr') as HTMLElement;
    const explainSwitch = within(explainRow).getByRole('switch');
    expect(explainSwitch.getAttribute('aria-checked')).toBe('true');

    const autonomyRow = within(panels).getByText('autonomy').closest('tr') as HTMLElement;
    expect(within(autonomyRow).getByRole('radiogroup')).toBeTruthy();
    expect(within(autonomyRow).getAllByRole('radio')).toHaveLength(3);

    const pauseRow = within(panels).getByText('usage-guard.pause-at').closest('tr') as HTMLElement;
    const pauseInput = within(pauseRow).getByRole('spinbutton') as HTMLInputElement;
    expect(pauseInput.value).toBe('98');
    expect(pauseInput.min).toBe('50');
    expect(pauseInput.max).toBe('99');

    // Every editable row gets a reset-to-default button; a setting already at its default has it
    // disabled (nothing to reset) — autonomy's source is 'product-default', not 'default'.
    const resets = within(panels).getAllByRole('button', { name: /Reset .* to its default/ });
    expect(resets.length).toBeGreaterThan(0);
    const autonomyReset = within(autonomyRow).getByRole('button', { name: /Reset autonomy to its default/ });
    expect(autonomyReset).not.toBeDisabled();
    const explainReset = within(explainRow).getByRole('button', { name: /Reset explain-mode to its default/ });
    expect(explainReset).toBeDisabled(); // explain-mode's source is already 'default'
  });

  it('WP-A: a project-scoped setting with no disclosure flags writes immediately (no confirm) and refreshes on success', async () => {
    const fetchMock = installFetchMock(CONFIG_PAYLOAD, () => ({ ok: true }));
    const { panels, dispatch } = await openForgeSettingsWithDispatch();
    const getCallsBefore = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method !== 'POST').length;

    // getAllByText, never getByText: a Switch's own (visually hidden) accessible-name label
    // duplicates the Setting column's text — both matches sit in the SAME <tr>, so either works
    // for .closest('tr'), but only the *All* variant tolerates there being two.
    const explainRow = within(panels).getAllByText('explain-mode')[0].closest('tr') as HTMLElement;
    fireEvent.click(within(explainRow).getByRole('switch'));
    await flush();

    // No confirm modal for an unflagged, project-scoped setting.
    expect(screen.queryByRole('dialog')).toBeNull();

    const postCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
    expect(postCall).toBeTruthy();
    const [postUrl, postInit] = postCall as [string, RequestInit];
    expect(postUrl).toContain('/api/config?project=demo-project');
    expect(JSON.parse(String(postInit.body))).toEqual({ action: 'set', key: 'explain-mode', value: false });

    // Refresh happened: at least one more GET than before the click.
    const getCallsAfter = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method !== 'POST').length;
    expect(getCallsAfter).toBeGreaterThan(getCallsBefore);

    const toasts = toastPushCalls(dispatch);
    expect(toasts.some((toast) => toast.icon === 'CircleCheck' && toast.title.includes('explain-mode'))).toBe(true);
  });

  it('WP-A: a flagged or machine-wide setting shows a confirm modal first, and sends nothing until confirmed', async () => {
    const fetchMock = installFetchMock(CONFIG_PAYLOAD, () => ({ ok: true }));
    const { panels } = await openForgeSettingsWithDispatch();

    const usageGuardRow = within(panels).getAllByText('usage-guard')[0].closest('tr') as HTMLElement;
    fireEvent.click(within(usageGuardRow).getAllByRole('switch')[0]);
    await flush();

    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('Change usage-guard?');
    expect(dialog.textContent).toContain('This changes every project on this computer.');
    expect(dialog.textContent).toContain('Reads your Claude login token locally');
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toBe(false);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Change it' }));
    await flush();

    const postCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
    expect(postCall).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull(); // closed after confirming
  });

  it('SECURITY WP-A: the gate-hook row never offers an off control, only the plain "do it yourself" sentence', async () => {
    installFetchMock(CONFIG_PAYLOAD);
    const panels = await openForgeSettings();

    const gateHookRow = within(panels).getByText('gate-hook').closest('tr') as HTMLElement;
    expect(within(gateHookRow).queryAllByRole('switch')).toHaveLength(0);
    expect(within(gateHookRow).queryAllByRole('button')).toHaveLength(0); // no "reset" either — nothing to click at all
    expect(gateHookRow.textContent).toContain('node .claude/forge-bin/forge-config.cjs set gate-hook off');
  });

  it('WP-A: a failed write shows an error toast naming the real gateway reason, and never refreshes', async () => {
    const fetchMock = installFetchMock(CONFIG_PAYLOAD, () => ({
      ok: false,
      error: 'usage-guard.pause-at must be a whole number between 50 and 99 — you gave "banana".',
    }));
    const { panels, dispatch } = await openForgeSettingsWithDispatch();
    const getCallsBefore = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method !== 'POST').length;

    const pauseRow = within(panels).getByText('usage-guard.pause-at').closest('tr') as HTMLElement;
    const pauseInput = within(pauseRow).getByRole('spinbutton') as HTMLInputElement;
    fireEvent.change(pauseInput, { target: { value: '70' } });
    fireEvent.blur(pauseInput);
    await flush();

    // usage-guard.pause-at is global-scope -> confirm first, exactly like the bool case above.
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Change it' }));
    await flush();

    const toasts = toastPushCalls(dispatch);
    expect(toasts.some((toast) => toast.icon === 'TriangleAlert' && toast.detail.includes('must be a whole number'))).toBe(true);
    const getCallsAfter = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method !== 'POST').length;
    expect(getCallsAfter).toBe(getCallsBefore); // a failure never triggers the "refresh after success" refetch
  });

  it('Codex K3-8: a rejected numeric value snaps back to the authoritative value, not the failed draft', async () => {
    const fetchMock = installFetchMock(CONFIG_PAYLOAD, () => ({
      ok: false,
      error: 'usage-guard.pause-at must be a whole number between 50 and 99 — you gave "banana".',
    }));
    const { panels, dispatch } = await openForgeSettingsWithDispatch();

    const pauseRow = within(panels).getByText('usage-guard.pause-at').closest('tr') as HTMLElement;
    const pauseInput = within(pauseRow).getByRole('spinbutton') as HTMLInputElement;
    fireEvent.change(pauseInput, { target: { value: '70' } });
    fireEvent.blur(pauseInput);
    await flush();

    // usage-guard.pause-at is global-scope -> confirm first, same as the existing failed-write test.
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Change it' }));
    await flush();

    const toasts = toastPushCalls(dispatch);
    expect(toasts.some((toast) => toast.icon === 'TriangleAlert' && toast.detail.includes('must be a whole number'))).toBe(true);

    // The rejected "70" must NOT still be displayed — it must have snapped back to the real,
    // authoritative value ("98") the gateway actually holds.
    const pauseInputAfter = within(pauseRow).getByRole('spinbutton') as HTMLInputElement;
    expect(pauseInputAfter.value).toBe('98');
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toBe(true);
  });

  it('Codex K3-8: cancelling the confirm modal also reverts the draft (never leaves the unsent typed value on screen)', async () => {
    installFetchMock(CONFIG_PAYLOAD, () => ({ ok: true }));
    const { panels } = await openForgeSettingsWithDispatch();

    const pauseRow = within(panels).getByText('usage-guard.pause-at').closest('tr') as HTMLElement;
    const pauseInput = within(pauseRow).getByRole('spinbutton') as HTMLInputElement;
    fireEvent.change(pauseInput, { target: { value: '77' } });
    fireEvent.blur(pauseInput);
    await flush();

    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await flush();

    const pauseInputAfter = within(pauseRow).getByRole('spinbutton') as HTMLInputElement;
    expect(pauseInputAfter.value).toBe('98');
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
