/**
 * wp12 (forge-2026-09-24-config-v250) + WP-A (v2.9.0) + WP-S2 (v2.9.0) —
 * Settings ▸ Forge settings: reads the active project's own Forge settings
 * (GET /api/config), writes them back for real (POST /api/config), and,
 * since WP-S2, presents every setting in plain language for a beginner
 * instead of a five-column table (Status / Setting / Value / From / What it
 * does) narrow enough for words to break mid-way — see this work package's
 * owner screenshot. `renderControl`'s actual controls, the confirm modal,
 * and the gate-hook lockout all live in ForgeSettingControl.tsx, unchanged
 * by WP-S2, and stay covered here end to end.
 *
 * Same minimal harness as `settings-mcp-counts-honesty.test.tsx`: `SettingsView`
 * against a hand-built `PrototypeState` with an active project, and a stubbed
 * `fetch` standing in for the gateway — so the real `useGatewayForgeConfig`
 * hook, its parser, `ForgeSettingControl`, `ForgeSettingRow`, the
 * `forge-setting-presentation` helpers and `writeForgeConfig` all run
 * unchanged.
 *
 * Locks in: a plain-language name plus the technical key and a source badge
 * per row, settings grouped by topic (not the tool's own core/when-needed/
 * advanced buckets), the free-text search box, the disclosure footnotes, the
 * locked list, the honest unavailable state that never renders a settings
 * row, a real editable control per setting type, the confirm modal for a
 * flagged/global-scope write, the gate-hook row's permanent lack of an off
 * control and its command staying inside a collapsed detail, and honest
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
      key: 'start-gate',
      value: 'off',
      default: 'off',
      display: 'off',
      group: 'core',
      type: 'enum',
      allowed: ['off', 'l4-only', 'always'],
      desc: 'Does not wait for a START before building.',
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
      value: 'auto',
      default: 'report',
      display: 'auto',
      status: null,
      // WP-S2: the one fixture setting that is genuinely person-changed, so the
      // "You changed this" badge wording and the changed-marker dot have something
      // real to assert against (every other fixture row is a Forge-chosen value).
      source: 'project',
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

/** WP-S2: finds a setting's own `.fw-fsetting` row from anywhere inside the panels — a row always
 *  shows its technical key at least once (in `.fw-fsetting__key`; a bool/Switch control repeats it
 *  a second time as the Switch's own visually-hidden accessible name), so the first match's nearest
 *  `.fw-fsetting` ancestor is always the right row, exactly the same shape the old table version of
 *  this file used with `.closest('tr')`. */
function rowFor(panels: HTMLElement, key: string): HTMLElement {
  const [first] = within(panels).getAllByText(key);
  const row = first.closest('.fw-fsetting');
  if (row == null) throw new Error(`expected a .fw-fsetting ancestor for "${key}"`);
  return row as HTMLElement;
}

/* ========================================================================== */
/*  Tests                                                                      */
/* ========================================================================== */

describe('Settings ▸ Forge settings (wp12 GET /api/config + WP-A POST /api/config + WP-S2 redesign)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('asks the gateway for the active project, and never renders a table (WP-S2 replaced the old five-column layout)', async () => {
    const fetchMock = installFetchMock(CONFIG_PAYLOAD);
    const panels = await openForgeSettings();

    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/config?project=demo-project'))).toBe(true);
    expect(screen.getByRole('heading', { name: 'Forge settings' })).toBeTruthy();
    expect(within(panels).queryAllByRole('table')).toHaveLength(0);
    expect(within(panels).queryAllByRole('columnheader')).toHaveLength(0);

    const text = panels.textContent ?? '';
    expect(text).toContain('or just say it in chat');
  });

  // WP-RB-CC (review finding L-2): the "Forge settings" nav entry's own section-sub line (a
  // SEPARATE text region from the in-panel Note above — see SettingsView.tsx's `SECTIONS`
  // array / `fw-settings__section-sub`) used to say "Change it in chat or with /forge config",
  // which reads as the ONLY two ways in — but this same section's own panel (asserted just above)
  // edits a setting right in place. Both texts must describe the same real capability.
  it('L-2: the section-sub line names editing right in this view, not only chat/the command line', async () => {
    installFetchMock(CONFIG_PAYLOAD);
    await openForgeSettings();

    const sectionSub = document.querySelector('.fw-settings__section-sub');
    expect(sectionSub).not.toBeNull();
    const subText = sectionSub?.textContent ?? '';
    expect(subText).toMatch(/change a setting right in this view/i);
    expect(subText).not.toMatch(/change it in chat or with \/forge config/i);
  });

  it('WP-S2: groups settings by topic instead of the tool\'s own core/when-needed/advanced buckets', async () => {
    installFetchMock(CONFIG_PAYLOAD);
    const panels = await openForgeSettings();

    // The fixture's 9 settings land across exactly these four topical groups — "Dashboard and
    // tools" has no matching fixture row, so it must not render an empty panel.
    expect(screen.getByRole('heading', { name: 'Safety and quality' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Usage and cost' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Working style' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Advanced' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Dashboard and tools' })).toBeNull();

    // The tool's own bucket titles are gone from the main flow (still available via
    // `/forge config list` in a terminal — this view just no longer duplicates them).
    expect(panels.textContent ?? '').not.toContain('On by default — Forge uses this on every run');

    const totalRows = panels.querySelectorAll('.fw-fsetting').length;
    expect(totalRows).toBe(CONFIG_PAYLOAD.settings.length);
  });

  it('WP-S2: every row shows a plain-language name plus the technical key as small secondary detail', async () => {
    installFetchMock(CONFIG_PAYLOAD);
    const panels = await openForgeSettings();

    // The owner's own four worked examples for this work package.
    expect(within(panels).getByText('Usage guard')).toBeTruthy();
    expect(within(panels).getByText('Pause at (% of your limit)')).toBeTruthy();
    expect(within(panels).getByText('Autonomy')).toBeTruthy();
    expect(within(panels).getByText('Ask before starting')).toBeTruthy();

    const usageGuardRow = rowFor(panels, 'usage-guard');
    // getAllByText, never getByText: the Switch's own (visually hidden) accessible-name label
    // repeats the same key text a second time inside this same row — the FIRST match is always the
    // row's own `.fw-fsetting__key`, since it renders before the control section.
    const [key] = within(usageGuardRow).getAllByText('usage-guard');
    expect(key.className).toContain('fw-fsetting__key');

    // The description (the schema's own text, straight from the API) is still the one-line
    // explanation — unchanged content, just no longer sitting under a raw command.
    expect(usageGuardRow.textContent).toContain('Pauses Forge automatically just before your Claude usage limit.');
  });

  it('WP-S2: no raw /forge config set command sits in the main flow — only inside a collapsed "for the command line" detail', async () => {
    installFetchMock(CONFIG_PAYLOAD);
    const panels = await openForgeSettings();

    const pauseRow = rowFor(panels, 'usage-guard.pause-at');
    // The description paragraph itself never carries the raw command any more.
    const desc = pauseRow.querySelector('.fw-fsetting__desc');
    expect(desc?.textContent ?? '').not.toContain('/forge config set');

    const summary = within(pauseRow).getByText('For the command line');
    expect(summary.tagName.toLowerCase()).toBe('summary');
    const details = summary.closest('details');
    expect(details).not.toBeNull();
    expect(details?.hasAttribute('open')).toBe(false); // collapsed by default

    const command = within(pauseRow).getByText('/forge config set usage-guard.pause-at 98');
    expect(command.closest('details')).toBe(details); // the command lives INSIDE that same detail
  });

  it('WP-S2: source becomes a plain badge — a Forge default is never called "changed", a real edit is', async () => {
    installFetchMock(CONFIG_PAYLOAD);
    const panels = await openForgeSettings();

    // usage-guard: source 'default'. autonomy: source 'product-default'. Both read "Forge default".
    const usageGuardRow = rowFor(panels, 'usage-guard');
    expect(within(usageGuardRow).getByText('Forge default')).toBeTruthy();
    const autonomyRow = rowFor(panels, 'autonomy');
    expect(within(autonomyRow).getByText('Forge default')).toBeTruthy();

    // cleanup: source 'project' in this fixture — the one setting a person actually changed.
    const cleanupRow = rowFor(panels, 'cleanup');
    const badge = within(cleanupRow).getByText('You changed this — this project');
    expect(badge.className).toContain('is-changed');

    // The raw tool-internal source word 'product-default' never appears anywhere as visible text —
    // 'default' alone is not asserted absent here, since the kept honest note ("Everything is at
    // its default, that is normal.") legitimately uses the plain English word.
    expect((panels.textContent ?? '')).not.toContain('product-default');
  });

  it('WP-S2: the search box filters by name, key and description, and an empty result offers a way back', async () => {
    installFetchMock(CONFIG_PAYLOAD);
    const panels = await openForgeSettings();

    // "usage-guard" is a substring of both settings' technical keys (and nothing else's name, key
    // or description) — an exact, unambiguous way to prove the search matches on the key.
    const search = within(panels).getByPlaceholderText('Find a setting…') as HTMLInputElement;
    fireEvent.change(search, { target: { value: 'usage-guard' } });
    await flush();

    expect(screen.getByRole('heading', { name: 'Usage and cost' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Safety and quality' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Working style' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Advanced' })).toBeNull();
    expect(panels.querySelectorAll('.fw-fsetting').length).toBe(2); // usage-guard, usage-guard.pause-at

    fireEvent.change(search, { target: { value: 'zzz-nomatch-anywhere' } });
    await flush();

    expect(panels.querySelectorAll('.fw-fsetting').length).toBe(0);
    expect(within(panels).getByText(/No settings match/)).toBeTruthy();

    fireEvent.click(within(panels).getByRole('button', { name: 'Show every setting again' }));
    await flush();

    expect((within(panels).getByPlaceholderText('Find a setting…') as HTMLInputElement).value).toBe('');
    expect(panels.querySelectorAll('.fw-fsetting').length).toBe(CONFIG_PAYLOAD.settings.length);
  });

  it('WP-S2: every rendered row carries the class its own phone-card media query targets', async () => {
    installFetchMock(CONFIG_PAYLOAD);
    const panels = await openForgeSettings();

    const rows = Array.from(panels.querySelectorAll('.fw-fsetting'));
    expect(rows.length).toBe(CONFIG_PAYLOAD.settings.length);
    for (const row of rows) expect(row.classList.contains('fw-fsetting')).toBe(true);
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

    const explainRow = rowFor(panels, 'explain-mode');
    const explainSwitch = within(explainRow).getByRole('switch');
    expect(explainSwitch.getAttribute('aria-checked')).toBe('true');

    const autonomyRow = rowFor(panels, 'autonomy');
    expect(within(autonomyRow).getByRole('radiogroup')).toBeTruthy();
    expect(within(autonomyRow).getAllByRole('radio')).toHaveLength(3);

    const pauseRow = rowFor(panels, 'usage-guard.pause-at');
    const pauseInput = within(pauseRow).getByRole('spinbutton') as HTMLInputElement;
    expect(pauseInput.value).toBe('98');
    expect(pauseInput.min).toBe('50');
    expect(pauseInput.max).toBe('99');

    // Every editable row gets a reset-to-default button; a setting already at its default has it
    // disabled (nothing to reset) — autonomy's source is 'product-default', not 'default'. The
    // reset action always carries a real accessible name (never a bare, unexplained icon).
    const resets = within(panels).getAllByRole('button', { name: /Reset .* to its default/ });
    expect(resets.length).toBeGreaterThan(0);
    const autonomyReset = within(autonomyRow).getByRole('button', { name: /Reset autonomy to its default/ });
    expect(autonomyReset).not.toBeDisabled();
    const explainReset = within(explainRow).getByRole('button', { name: /Reset explain-mode to its default/ });
    expect(explainReset).toBeDisabled(); // explain-mode's source is already 'default'

    // WP-S2: the changed badge and the reset button agree with each other — cleanup was person-set
    // (source 'project'), so unlike explain-mode above, its reset is enabled.
    const cleanupRow = rowFor(panels, 'cleanup');
    const cleanupReset = within(cleanupRow).getByRole('button', { name: /Reset cleanup to its default/ });
    expect(cleanupReset).not.toBeDisabled();
  });

  it('WP-A: a project-scoped setting with no disclosure flags writes immediately (no confirm) and refreshes on success', async () => {
    const fetchMock = installFetchMock(CONFIG_PAYLOAD, () => ({ ok: true }));
    const { panels, dispatch } = await openForgeSettingsWithDispatch();
    const getCallsBefore = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method !== 'POST').length;

    const explainRow = rowFor(panels, 'explain-mode');
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

    const usageGuardRow = rowFor(panels, 'usage-guard');
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

  it('SECURITY WP-S2: the gate-hook row never offers an off control, explains itself in plain words, and keeps the exact command only inside the collapsed detail', async () => {
    installFetchMock(CONFIG_PAYLOAD);
    const panels = await openForgeSettings();

    const gateHookRow = rowFor(panels, 'gate-hook');
    expect(within(gateHookRow).queryAllByRole('switch')).toHaveLength(0);
    expect(within(gateHookRow).queryAllByRole('button')).toHaveLength(0); // no "reset" either — nothing to click at all

    // The plain-language sentence ForgeSettingControl renders inline...
    const note = gateHookRow.querySelector('.fw-settings__forge-gate-hook-note');
    expect(note).not.toBeNull();
    expect(note?.textContent).toContain('Always on here');
    expect(note?.textContent).toContain('never from this dashboard');
    // ...never contains the raw command any more (WP-S2 moved it out of the main flow).
    expect(note?.textContent ?? '').not.toContain('node .claude/forge-bin/forge-config.cjs');

    // The exact command that used to sit inline lives only inside this row's own collapsed detail.
    const command = within(gateHookRow).getByText('node .claude/forge-bin/forge-config.cjs set gate-hook off');
    const details = command.closest('details.fw-fsetting__cli');
    expect(details).not.toBeNull();
    expect(details?.hasAttribute('open')).toBe(false);
  });

  it('WP-A: a failed write shows an error toast naming the real gateway reason, and never refreshes', async () => {
    const fetchMock = installFetchMock(CONFIG_PAYLOAD, () => ({
      ok: false,
      error: 'usage-guard.pause-at must be a whole number between 50 and 99 — you gave "banana".',
    }));
    const { panels, dispatch } = await openForgeSettingsWithDispatch();
    const getCallsBefore = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method !== 'POST').length;

    const pauseRow = rowFor(panels, 'usage-guard.pause-at');
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

    const pauseRow = rowFor(panels, 'usage-guard.pause-at');
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
    const pauseInputAfter = within(rowFor(panels, 'usage-guard.pause-at')).getByRole('spinbutton') as HTMLInputElement;
    expect(pauseInputAfter.value).toBe('98');
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toBe(true);
  });

  it('Codex K3-8: cancelling the confirm modal also reverts the draft (never leaves the unsent typed value on screen)', async () => {
    installFetchMock(CONFIG_PAYLOAD, () => ({ ok: true }));
    const { panels } = await openForgeSettingsWithDispatch();

    const pauseRow = rowFor(panels, 'usage-guard.pause-at');
    const pauseInput = within(pauseRow).getByRole('spinbutton') as HTMLInputElement;
    fireEvent.change(pauseInput, { target: { value: '77' } });
    fireEvent.blur(pauseInput);
    await flush();

    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await flush();

    const pauseInputAfter = within(rowFor(panels, 'usage-guard.pause-at')).getByRole('spinbutton') as HTMLInputElement;
    expect(pauseInputAfter.value).toBe('98');
  });

  it('a project without forge-config.cjs shows the honest unavailable state and never a settings row or search box', async () => {
    installFetchMock(UNAVAILABLE_PAYLOAD);
    const panels = await openForgeSettings();
    const text = panels.textContent ?? '';

    expect(text).toContain('Settings unavailable');
    expect(text).toContain('forge-config.cjs not found for this project');
    expect(within(panels).queryAllByRole('table')).toHaveLength(0);
    expect(panels.querySelectorAll('.fw-fsetting')).toHaveLength(0);
    expect(within(panels).queryByPlaceholderText('Find a setting…')).toBeNull();
    expect(text).not.toContain('/forge config set');
    expect(text).not.toContain('Locked');
  });
});
