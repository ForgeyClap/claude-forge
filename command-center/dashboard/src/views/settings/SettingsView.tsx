/**
 * Settings — every workspace preference in one place.
 *
 * Two columns: a section nav (a horizontal scroller on a narrow viewport) and
 * the section body. Appearance, density, reduced motion, the shell layout
 * switches, the composer/reading/remembering preferences, the model-label
 * toggle and the reset in Data and privacy are all genuinely wired — they take
 * effect immediately and are remembered in this browser. Every remaining panel
 * either changes real (if unwired) local state honestly, or has been removed
 * rather than shipped as a control that lies about what it does.
 *
 * The Claude Code connection section reads the gateway's own live health check
 * (the same one the topbar's chip uses) — it is not a detector running in this
 * tab. Nothing here ever asks you to type a credential of any kind.
 */

import { useCallback, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import {
  Button,
  EmptyState,
  Eyebrow,
  ExampleTag,
  Icon,
  KeyHint,
  Machine,
  Panel,
  SegmentedControl,
  Spacer,
  Switch,
  Toolbar,
} from '@/components/primitives';
import { useGatewayClaudeCodeHealth, useGatewayConnection as useConnection } from '@/prototype/state/gateway-adapter';
import {
  useGatewayCapabilities,
  useGatewayMcp,
  useGatewayModels,
  useGatewayTools,
} from '@/prototype/state/gateway-capabilities';
import { nextToastId, selectActiveProject, usePrototype } from '@/prototype/state/prototype-store';
import type { DockTab } from '@/prototype/state/prototype-store';
import { liveChipState } from '@/components/shell/claude-code-chip';
import type { AgentLayout, Appearance, Density, TaskLayout } from '@/prototype/types/prototype-types';

import './settings.css';

/* ------------------------------------------------------------------ model */

type SectionId =
  | 'appearance'
  | 'layout'
  | 'chat'
  | 'connection'
  | 'models'
  | 'capabilities'
  | 'agents'
  | 'skills'
  | 'permissions'
  | 'privacy'
  | 'shortcuts';

interface SectionDef {
  readonly id: SectionId;
  readonly label: string;
  readonly icon: string;
  /** True when the controls in this section actually change the workspace. */
  readonly wired: boolean;
  readonly summary: string;
}

const SECTIONS: readonly SectionDef[] = [
  {
    id: 'appearance',
    label: 'Appearance',
    icon: 'Contrast',
    wired: true,
    summary: 'Theme, density and motion. These take effect immediately.',
  },
  {
    id: 'layout',
    label: 'Layout',
    icon: 'PanelsTopLeft',
    wired: true,
    summary: 'Which regions of the shell are open, and how the busiest views arrange themselves.',
  },
  {
    id: 'chat',
    label: 'Chat preferences',
    icon: 'MessageSquare',
    wired: true,
    summary: 'How a conversation reads and how the composer behaves. Saved in this browser.',
  },
  {
    id: 'connection',
    label: 'Claude Code connection',
    icon: 'Terminal',
    wired: true,
    summary: 'Live Claude Code and gateway connection status, read from the gateway itself.',
  },
  {
    id: 'models',
    label: 'Models',
    icon: 'Cpu',
    wired: true,
    summary: 'The runtime and tool labels that appear on agent cards, and whether the roster shows them.',
  },
  {
    id: 'capabilities',
    label: 'Capabilities',
    icon: 'Boxes',
    wired: true,
    summary: 'What this gateway can actually route to and call: models, tools, MCP servers and the Forge capability report.',
  },
  {
    id: 'agents',
    label: 'Agents',
    icon: 'Users',
    wired: false,
    summary: 'The current agent roster, grouped and counted.',
  },
  {
    id: 'skills',
    label: 'Skills',
    icon: 'Sparkles',
    wired: false,
    summary: 'The skill set the agent roster draws on.',
  },
  {
    id: 'permissions',
    label: 'Permissions',
    icon: 'ShieldCheck',
    wired: false,
    summary: 'What each permission level is allowed to do once there is a runtime to allow it in.',
  },
  {
    id: 'privacy',
    label: 'Data and privacy',
    icon: 'Database',
    wired: true,
    summary: 'Exactly what this workspace stores, and what it sends to the gateway.',
  },
  {
    id: 'shortcuts',
    label: 'Keyboard shortcuts',
    icon: 'Keyboard',
    wired: false,
    summary: 'The shortcut vocabulary the workspace is designed around.',
  },
];

/* ------------------------------------------------------------- shortcuts */

interface ShortcutGroup {
  readonly title: string;
  readonly rows: readonly { readonly keys: readonly string[]; readonly action: string }[];
}

const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    title: 'Global',
    rows: [
      { keys: ['Ctrl', 'K'], action: 'Open the command palette' },
      { keys: ['Ctrl', 'B'], action: 'Collapse or expand the sidebar' },
      { keys: ['Ctrl', 'I'], action: 'Show or hide the inspector' },
      { keys: ['Ctrl', 'J'], action: 'Show or hide the dock' },
      { keys: ['Ctrl', ','], action: 'Open settings' },
      { keys: ['Esc'], action: 'Close the palette, a dialog or the dock' },
    ],
  },
  {
    title: 'Navigation',
    rows: [
      { keys: ['G', 'H'], action: 'Go to home' },
      { keys: ['G', 'P'], action: 'Go to projects' },
      { keys: ['G', 'C'], action: 'Go to chat' },
      { keys: ['G', 'M'], action: 'Go to mission control' },
      { keys: ['G', 'A'], action: 'Go to agents' },
      { keys: ['G', 'T'], action: 'Go to tasks' },
    ],
  },
  {
    title: 'Chat',
    rows: [
      { keys: ['Ctrl', 'Enter'], action: 'Send the message' },
      { keys: ['Shift', 'Enter'], action: 'New line inside the composer' },
      { keys: ['Ctrl', 'Shift', 'A'], action: 'Attach a file to the message' },
      { keys: ['Ctrl', 'Shift', 'S'], action: 'Stop the running response' },
    ],
  },
  {
    title: 'Lists and boards',
    rows: [
      { keys: ['↑', '↓'], action: 'Move through rows' },
      { keys: ['Enter'], action: 'Open the selected row in the inspector' },
      { keys: ['Space'], action: 'Expand or collapse a group' },
      { keys: ['/'], action: 'Focus the filter field' },
    ],
  },
];

/* ------------------------------------------------------------------ atoms */

function Note({ children }: { children: ReactNode }) {
  return (
    <p className="fw-settings__note">
      <Icon name="Info" size="sm" className="fw-settings__note-icon" />
      <span>{children}</span>
    </p>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="fw-settings__row">
      <div className="fw-settings__row-text">
        <span className="fw-settings__row-label">{label}</span>
        {hint ? <span className="fw-settings__row-hint">{hint}</span> : null}
      </div>
      <div className="fw-settings__row-control">{children}</div>
    </div>
  );
}

const SURFACE_SWATCHES: readonly { readonly token: string; readonly name: string }[] = [
  { token: 'canvas', name: '--forge-color-canvas' },
  { token: 'bg', name: '--forge-color-bg' },
  { token: 'surface-1', name: '--forge-color-surface-1' },
  { token: 'surface-2', name: '--forge-color-surface-2' },
  { token: 'surface-3', name: '--forge-color-surface-3' },
  { token: 'line', name: '--forge-color-line' },
  { token: 'text-muted', name: '--forge-color-text-muted' },
  { token: 'accent', name: '--forge-color-accent' },
];

function unique(values: readonly string[]): readonly string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

/* -------------------------------------------------------- real preferences */

/**
 * The 11 controls that are genuinely local, client-side preferences (Layout ▸
 * Remembering, Chat ▸ Composer, Chat ▸ Reading, Models ▸ "Show model labels").
 * Persisted the same way `prototype-store.ts` persists appearance/density —
 * `localStorage`, guarded by a try/catch so private-mode/disabled storage
 * degrades to "does not persist" rather than throwing. Kept in its own key
 * (not `prototype-store.ts`'s own two keys) because this view owns these
 * preferences; nothing else in the workspace reads them yet — see this file's
 * handoff notes for Test Boss.
 */
const PREFERENCES_KEY = 'forge.workspace.preferences';

type PreferenceValue = boolean | string;

function readStoredPreferences(): Record<string, PreferenceValue> {
  try {
    const raw = localStorage.getItem(PREFERENCES_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, PreferenceValue>) : {};
  } catch {
    return {};
  }
}

function persistPreferences(next: Record<string, PreferenceValue>): void {
  try {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(next));
  } catch {
    /* Private mode or storage disabled — preferences simply do not persist. */
  }
}

function clearStoredPreferences(): void {
  try {
    localStorage.removeItem(PREFERENCES_KEY);
  } catch {
    /* Nothing to clear if storage was never available. */
  }
}

/* ------------------------------------------------------------------- view */

export default function SettingsView() {
  const { state, dispatch } = usePrototype();
  const [section, setSection] = useState<SectionId>('appearance');
  // Skills toggles are the one remaining group with no real effect behind
  // them yet (see renderSkills) — kept in plain React state, unlike the real
  // preferences below.
  const [flags, setFlags] = useState<Record<string, boolean>>({});
  const [preferences, setPreferences] = useState<Record<string, PreferenceValue>>(() =>
    readStoredPreferences(),
  );

  const announce = useCallback(
    (label: string) => {
      dispatch({
        type: 'toast/push',
        toast: {
          id: nextToastId(),
          title: `${label} — not wired yet`,
          detail: 'This control is not wired to anything. Toggling it changes nothing.',
          icon: 'FlaskConical',
        },
      });
    },
    [dispatch],
  );

  const inertSwitch = useCallback(
    (key: string, label: string, fallback: boolean) => ({
      checked: flags[key] ?? fallback,
      label,
      labelHidden: true,
      onChange: (next: boolean) => {
        setFlags((current) => ({ ...current, [key]: next }));
        announce(label);
      },
    }),
    [announce, flags],
  );

  /** A genuinely persisted preference — saved to `localStorage`, no toast. */
  const realSwitch = useCallback(
    (key: string, label: string, fallback: boolean) => ({
      checked: (preferences[key] as boolean | undefined) ?? fallback,
      label,
      labelHidden: true,
      onChange: (next: boolean) => {
        const updated = { ...preferences, [key]: next };
        setPreferences(updated);
        persistPreferences(updated);
      },
    }),
    [preferences],
  );

  const realChoice = useCallback(
    (key: string, label: string, fallback: string) => ({
      value: (preferences[key] as string | undefined) ?? fallback,
      label,
      onChange: (next: string) => {
        const updated = { ...preferences, [key]: next };
        setPreferences(updated);
        persistPreferences(updated);
      },
    }),
    [preferences],
  );

  const resetPreferences = useCallback(() => {
    dispatch({ type: 'appearance/set', appearance: 'system' });
    dispatch({ type: 'density/set', density: 'comfortable' });
    setFlags({});
    setPreferences({});
    clearStoredPreferences();
    dispatch({
      type: 'toast/push',
      toast: {
        id: nextToastId(),
        title: 'Preferences reset',
        detail: 'Appearance is back on system, density on comfortable, and the saved workspace preferences were cleared.',
        icon: 'RotateCcw',
      },
    });
  }, [dispatch]);

  const agents = state.data.agents;
  const runtimeModels = useMemo(() => unique(agents.map((a) => a.runtimeModel)), [agents]);
  const toolModels = useMemo(() => unique(agents.map((a) => a.toolModel)), [agents]);
  const skills = useMemo(() => unique(agents.flatMap((a) => a.skills)), [agents]);

  // P0-3: the live Claude Code + gateway health, read the same way the
  // topbar's chip reads it — never a new detector, never a fixture.
  const connection = useConnection();
  const claudeCode = useGatewayClaudeCodeHealth()?.claudeCode ?? null;
  const chip = liveChipState(connection.status, claudeCode);
  // fix-composer-truth: same active-project source the composer's own write-scope
  // line reads (`state.activeProjectId` via `selectActiveProject`) — named here too
  // so this section states the real write boundary, not just the CLI's identity.
  const activeProject = selectActiveProject(state);

  // wire-capabilities: the 4 real gateway routes this section renders.
  // `useGatewayModels()` carries no `?project=` (it reports this gateway's
  // own install); the other three read the active project, honestly empty
  // until one is selected — see gateway-capabilities.ts's header.
  const models = useGatewayModels();
  const tools = useGatewayTools(state.activeProjectId);
  const mcp = useGatewayMcp(state.activeProjectId);
  const capabilities = useGatewayCapabilities(state.activeProjectId);

  const active = SECTIONS.find((entry) => entry.id === section) ?? SECTIONS[0];

  /* ---------------------------------------------------------- sections */

  function renderAppearance(): ReactNode {
    return (
      <>
        <Panel
          title="Theme"
          subtitle="Applied immediately and remembered in this browser only."
        >
          <div className="fw-settings__rows">
            <Row label="Appearance" hint="System follows your operating system setting.">
              <SegmentedControl
                label="Appearance"
                value={state.appearance}
                onChange={(next) =>
                  dispatch({ type: 'appearance/set', appearance: next as Appearance })
                }
                options={[
                  { value: 'dark', label: 'Dark', icon: 'Moon' },
                  { value: 'light', label: 'Light', icon: 'Sun' },
                  { value: 'system', label: 'System', icon: 'Monitor' },
                ]}
              />
            </Row>
            <Row label="Resolved theme" hint="What the workspace is drawing at this moment.">
              <Machine>{state.resolvedTheme}</Machine>
            </Row>
            <Row
              label="Reduced motion"
              hint="Stops the workspace's own motion, like the composer's reveal effect. Your system setting is honoured either way."
            >
              <Switch
                checked={state.reducedMotion}
                onChange={(next) => dispatch({ type: 'motion/set', reduced: next })}
                label="Reduced motion"
                labelHidden
              />
            </Row>
          </div>
        </Panel>

        <Panel
          title="Preview"
          subtitle="Live values from the current theme. Flip the control above and watch the ramp move."
        >
          <ul className="fw-settings__swatches">
            {SURFACE_SWATCHES.map((swatch) => (
              <li key={swatch.token} className="fw-settings__swatch">
                <span className="fw-settings__swatch-chip" data-token={swatch.token} />
                <Machine muted className="fw-settings__swatch-name">
                  {swatch.name}
                </Machine>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="Density" subtitle="Retunes control heights, row heights and gutters at once.">
          <div className="fw-settings__rows">
            <Row label="Density" hint="Compact suits a laptop screen and a long task board.">
              <SegmentedControl
                label="Density"
                value={state.density}
                onChange={(next) => dispatch({ type: 'density/set', density: next as Density })}
                options={[
                  { value: 'comfortable', label: 'Comfortable', icon: 'Rows3' },
                  { value: 'compact', label: 'Compact', icon: 'Rows4' },
                ]}
              />
            </Row>
            <Row label="Current value" hint="Written on the document root as data-density.">
              <Machine>{state.density}</Machine>
            </Row>
          </div>
        </Panel>
      </>
    );
  }

  function renderLayout(): ReactNode {
    return (
      <>
        <Panel title="Shell regions" subtitle="These switches move the real shell around you.">
          <div className="fw-settings__rows">
            <Row label="Sidebar" hint="Collapsed keeps the icons and drops the labels.">
              <Switch
                checked={!state.sidebarCollapsed}
                onChange={(next) => dispatch({ type: 'sidebar/set', collapsed: !next })}
                label="Sidebar expanded"
                labelHidden
              />
            </Row>
            <Row label="Inspector" hint="The right-hand detail column.">
              <Switch
                checked={state.inspectorOpen}
                onChange={(next) => dispatch({ type: 'inspector/set', open: next })}
                label="Inspector open"
                labelHidden
              />
            </Row>
            <Row label="Dock" hint="The bottom drawer that holds activity, tests and the proof ledger.">
              <Switch
                checked={state.dockOpen}
                onChange={(next) => dispatch({ type: 'dock/set', open: next })}
                label="Dock open"
                labelHidden
              />
            </Row>
            <Row label="Dock tab" hint="Selecting a tab also opens the dock.">
              <SegmentedControl
                label="Dock tab"
                size="sm"
                value={state.dockTab}
                onChange={(next) => dispatch({ type: 'dock/tab', tab: next as DockTab })}
                options={[
                  { value: 'activity', label: 'Activity' },
                  { value: 'terminal', label: 'Terminal' },
                  { value: 'tests', label: 'Tests' },
                  { value: 'events', label: 'Events' },
                  { value: 'proof', label: 'Proof' },
                  { value: 'notices', label: 'Notices' },
                ]}
              />
            </Row>
          </div>
        </Panel>

        <Panel title="View defaults" subtitle="How the two densest views arrange themselves.">
          <div className="fw-settings__rows">
            <Row label="Agents view" hint="Grouped stacks the roster by agent group.">
              <SegmentedControl
                label="Agent layout"
                size="sm"
                value={state.agentLayout}
                onChange={(next) => dispatch({ type: 'agents/layout', layout: next as AgentLayout })}
                options={[
                  { value: 'list', label: 'List' },
                  { value: 'grid', label: 'Grid' },
                  { value: 'grouped', label: 'Grouped' },
                ]}
              />
            </Row>
            <Row label="Tasks view" hint="The board, the table, or the plan behind them.">
              <SegmentedControl
                label="Task layout"
                size="sm"
                value={state.taskLayout}
                onChange={(next) => dispatch({ type: 'tasks/layout', layout: next as TaskLayout })}
                options={[
                  { value: 'kanban', label: 'Kanban' },
                  { value: 'table', label: 'Table' },
                  { value: 'work-packages', label: 'Packages' },
                  { value: 'phases', label: 'Phases' },
                ]}
              />
            </Row>
          </div>
        </Panel>

        <Panel title="Remembering" subtitle="Saved in this browser.">
          <Note>Saved automatically, and remembered the next time you open the workspace.</Note>
          <div className="fw-settings__rows">
            <Row label="Remember layout per project" hint="Each project reopens the way you left it.">
              <Switch {...realSwitch('layout.per-project', 'Remember layout per project', true)} />
            </Row>
            <Row label="Reopen the last conversation" hint="Land back in the thread you were reading.">
              <Switch {...realSwitch('layout.last-conversation', 'Reopen the last conversation', true)} />
            </Row>
            <Row label="Open the dock when a run starts" hint="Activity comes to you rather than waiting.">
              <Switch {...realSwitch('layout.dock-on-run', 'Open the dock when a run starts', false)} />
            </Row>
          </div>
        </Panel>
      </>
    );
  }

  function renderChat(): ReactNode {
    return (
      <>
        <Panel title="Composer" subtitle="Saved in this browser.">
          <Note>These preferences change how the composer behaves and are remembered here.</Note>
          <div className="fw-settings__rows">
            <Row label="Send with" hint="Which key commits the message.">
              <SegmentedControl
                size="sm"
                {...realChoice('chat.send', 'Send with', 'ctrl-enter')}
                options={[
                  { value: 'enter', label: 'Enter' },
                  { value: 'ctrl-enter', label: 'Ctrl + Enter' },
                ]}
              />
            </Row>
            <Row label="Spell check the composer" hint="Browser spell checking inside the input.">
              <Switch {...realSwitch('chat.spellcheck', 'Spell check the composer', true)} />
            </Row>
            <Row label="Keep drafts per conversation" hint="An unsent message survives a view change.">
              <Switch {...realSwitch('chat.drafts', 'Keep drafts per conversation', true)} />
            </Row>
          </div>
        </Panel>

        <Panel title="Reading" subtitle="Saved in this browser.">
          <div className="fw-settings__rows">
            <Row label="Show step blocks" hint="The collapsible progress list inside a response.">
              <Switch {...realSwitch('chat.steps', 'Show step blocks', true)} />
            </Row>
            <Row label="Show the model label" hint="The machine-set line under a Forge response.">
              <Switch {...realSwitch('chat.model-label', 'Show the model label', true)} />
            </Row>
            <Row label="Show timestamps" hint="Absolute time rather than 'just now'.">
              <Switch {...realSwitch('chat.timestamps', 'Show timestamps', false)} />
            </Row>
            <Row label="Reading width" hint="How wide a message is allowed to run.">
              <SegmentedControl
                size="sm"
                {...realChoice('chat.width', 'Reading width', 'reading')}
                options={[
                  { value: 'reading', label: 'Reading' },
                  { value: 'wide', label: 'Wide' },
                  { value: 'full', label: 'Full' },
                ]}
              />
            </Row>
          </div>
        </Panel>
      </>
    );
  }

  function renderConnection(): ReactNode {
    return (
      <>
        <Panel title="Local session link" subtitle="Uses your locally authenticated Claude Code session.">
          <p className="fw-link-callout">
            <Icon name="ShieldCheck" size="sm" className="fw-link-callout__icon" />
            <span>
              There is nothing to enter here: the gateway resolves the <Machine>claude</Machine> CLI
              already signed in on this machine and spawns it when you send a message — no separate
              credential is ever requested by this workspace.
            </span>
          </p>
        </Panel>

        <Panel
          title="Live status"
          subtitle="Read from the gateway's own health check — the same reading the topbar's chip shows."
        >
          <div className="fw-settings__rows">
            <Row label="Gateway connection" hint="Whether this browser can currently reach the gateway.">
              <Machine>{connection.status}</Machine>
            </Row>
            <Row label="Claude Code" hint={chip.title}>
              <span>{chip.state}</span>
            </Row>
            <Row label="Executable" hint="The resolved claude CLI path, or absent if none was found.">
              <Machine muted>{claudeCode?.executablePath ?? '—'}</Machine>
            </Row>
            <Row label="Last checked" hint="When the gateway last reported this state.">
              <Machine muted>{claudeCode?.lastCheckedAt ?? '—'}</Machine>
            </Row>
          </div>
        </Panel>

        <Panel title="What this connection uses" subtitle="Stated plainly, because it matters.">
          <ul className="fw-settings__facts">
            <li>
              <Icon name="Minus" size="sm" className="fw-settings__facts-mark" />
              <span>
                Sending a message spawns the <Machine>claude</Machine> CLI already signed in on this
                machine — the gateway process does this, never this browser tab.
              </span>
            </li>
            <li>
              <Icon name="Minus" size="sm" className="fw-settings__facts-mark" />
              <span>
                That CLI run has no permission-bypass: it can create or edit files only inside{' '}
                {activeProject ? (
                  <Machine muted>{activeProject.path}</Machine>
                ) : (
                  "the active project's folder"
                )}
                . A request for any other path is refused by the CLI itself, not attempted.
              </span>
            </li>
            <li>
              <Icon name="Minus" size="sm" className="fw-settings__facts-mark" />
              <span>No editor is opened from this screen, and no VS Code integration exists yet.</span>
            </li>
            <li>
              <Icon name="Minus" size="sm" className="fw-settings__facts-mark" />
              <span>
                The gateway only ever reaches <Machine muted>127.0.0.1:4100</Machine> on this machine —
                never a remote address.
              </span>
            </li>
            <li>
              <Icon name="Minus" size="sm" className="fw-settings__facts-mark" />
              <span>Nothing is ever typed in here. There is no credential field anywhere in the workspace.</span>
            </li>
          </ul>
        </Panel>
      </>
    );
  }

  function renderModels(): ReactNode {
    return (
      <>
        <Panel title="Runtime labels" subtitle="What an agent card prints under its name.">
          <Note>
            Display strings taken from the agent roster. Nothing here contacts a model or routes a
            request.
          </Note>
          <ul className="fw-settings__machine-list">
            {runtimeModels.map((model) => (
              <li key={model}>
                <Machine>{model}</Machine>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="Tool labels" subtitle="The tool-side label shown on the same card.">
          <ul className="fw-settings__machine-list">
            {toolModels.map((model) => (
              <li key={model}>
                <Machine muted>{model}</Machine>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="Display" subtitle="Saved in this browser.">
          <div className="fw-settings__rows">
            <Row label="Show model labels in the roster" hint="Hide them for a quieter card.">
              <Switch {...realSwitch('models.show-labels', 'Show model labels in the roster', true)} />
            </Row>
          </div>
        </Panel>
      </>
    );
  }

  function renderCapabilities(): ReactNode {
    const nvidia = models.data.nvidia;
    const rolesRows = models.data.roles;
    const catalogRows = models.data.catalog;

    return (
      <>
        <Panel
          title="Routed models"
          subtitle="This gateway's own model-routing matrix, read straight from GET /api/models."
        >
          {models.error ? (
            <EmptyState icon="Unplug" title="Model routing unavailable" detail={models.error} />
          ) : models.loading ? (
            <Note>Reading the live model-routing matrix…</Note>
          ) : rolesRows.length === 0 && catalogRows.length === 0 ? (
            <EmptyState
              icon="Cpu"
              title="No routed models reported"
              detail="The model-capability matrix returned no roles or catalog entries."
            />
          ) : (
            <>
              <div className="fw-settings__rows">
                <Row label="NVIDIA connection" hint="The gateway's own live health probe.">
                  <Machine>{nvidia?.state ?? '—'}</Machine>
                </Row>
                <Row label="Models available" hint="Reported by the live probe, not this workspace.">
                  <Machine muted>{nvidia?.models ?? '—'}</Machine>
                </Row>
                <Row label="Broken or unavailable" hint="Entries in the matrix marked not usable right now.">
                  <Machine muted>{models.data.brokenCount ?? '—'}</Machine>
                </Row>
                <Row label="Latest verified" hint="The newest live-probe date across the catalog.">
                  <Machine muted>{models.data.latestVerifiedDate ?? '—'}</Machine>
                </Row>
              </div>
              {rolesRows.length > 0 ? (
                <div className="fw-settings__table-scroll">
                  <table className="fw-settings__table">
                    <thead>
                      <tr>
                        <th scope="col">Role</th>
                        <th scope="col">Model</th>
                        <th scope="col">Env override</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rolesRows.map((role) => (
                        <tr key={role.role}>
                          <td>
                            <Machine>{role.role}</Machine>
                          </td>
                          <td>
                            <Machine muted>{role.model ?? '—'}</Machine>
                          </td>
                          <td>
                            <Machine muted>{role.envOverride ?? '—'}</Machine>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </>
          )}
        </Panel>

        {catalogRows.length > 0 ? (
          <Panel title="Model catalog" subtitle="Every model this gateway can address, with its own live probe result.">
            <div className="fw-settings__table-scroll">
              <table className="fw-settings__table">
                <thead>
                  <tr>
                    <th scope="col">Model ID</th>
                    <th scope="col">Tier</th>
                    <th scope="col">Context</th>
                    <th scope="col">Verified</th>
                  </tr>
                </thead>
                <tbody>
                  {catalogRows.map((entry) => (
                    <tr key={entry.id}>
                      <td>
                        <Machine>{entry.id}</Machine>
                      </td>
                      <td>
                        <Machine muted>{entry.tier ?? '—'}</Machine>
                      </td>
                      <td>
                        <Machine muted>{entry.ctx ?? '—'}</Machine>
                      </td>
                      <td>
                        <Machine muted>{entry.verified ?? '—'}</Machine>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        ) : null}

        <Panel title="Tools" subtitle="The active project's own .claude/forge-bin inventory, read straight from GET /api/tools.">
          {tools.error ? (
            <EmptyState icon="Unplug" title="Tool inventory unavailable" detail={tools.error} />
          ) : tools.loading ? (
            <Note>Reading the tool inventory…</Note>
          ) : tools.data.tools.length === 0 ? (
            <EmptyState
              icon="Wrench"
              title="No tools reported"
              detail={tools.data.note ?? "This project's forge-bin inventory is empty."}
            />
          ) : (
            <>
              <Note>{tools.data.toolsCount ?? tools.data.tools.length} tools, read from this project's own forge-bin directory.</Note>
              <div className="fw-settings__table-scroll">
                <table className="fw-settings__table">
                  <thead>
                    <tr>
                      <th scope="col">Tool</th>
                      <th scope="col">Has test</th>
                      <th scope="col">Size</th>
                      <th scope="col">Modified</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tools.data.tools.map((tool) => (
                      <tr key={tool.name}>
                        <td>
                          <Machine>{tool.name}</Machine>
                        </td>
                        <td>
                          <Machine muted>{tool.hasTest ? 'yes' : 'no'}</Machine>
                        </td>
                        <td>
                          <Machine muted>{tool.size ?? '—'}</Machine>
                        </td>
                        <td>
                          <Machine muted>{tool.mtime ?? '—'}</Machine>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Panel>

        <Panel title="MCP servers" subtitle="The dormant server catalog and per-Boss grant matrix, read straight from GET /api/mcp.">
          {mcp.error ? (
            <EmptyState icon="Unplug" title="MCP registry unavailable" detail={mcp.error} />
          ) : mcp.loading ? (
            <Note>Reading the MCP registry…</Note>
          ) : mcp.data.servers.length === 0 ? (
            <EmptyState icon="Cable" title="No MCP servers registered" detail="This project's mcp-registry.json has no server entries." />
          ) : (
            <>
              <Note>
                {mcp.data.optedInCount ?? '—'} of {mcp.data.serversCount ?? mcp.data.servers.length} servers opted in;{' '}
                {mcp.data.installedCount ?? '—'} installed.
              </Note>
              <div className="fw-settings__table-scroll">
                <table className="fw-settings__table">
                  <thead>
                    <tr>
                      <th scope="col">Server</th>
                      <th scope="col">Tier</th>
                      <th scope="col">Network</th>
                      <th scope="col">Status</th>
                      <th scope="col">Opted in</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mcp.data.servers.map((server) => (
                      <tr key={server.id}>
                        <td>
                          <Machine>{server.id}</Machine>
                        </td>
                        <td>
                          <Machine muted>{server.tier ?? '—'}</Machine>
                        </td>
                        <td>
                          <Machine muted>{server.network ?? '—'}</Machine>
                        </td>
                        <td>
                          <Machine muted>{server.status ?? '—'}</Machine>
                        </td>
                        <td>
                          <Machine muted>{server.optedIn ? 'yes' : 'no'}</Machine>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Panel>

        <Panel
          title="Claude install capabilities"
          subtitle="The active project's own forge-capabilities report, read straight from GET /api/capabilities."
        >
          {capabilities.error ? (
            <EmptyState icon="Unplug" title="Capability report unavailable" detail={capabilities.error} />
          ) : capabilities.loading ? (
            <Note>Reading the capability report…</Note>
          ) : !capabilities.data.available ? (
            <EmptyState
              icon="PackageOpen"
              title="No capability report available"
              detail={capabilities.data.note ?? capabilities.data.state ?? undefined}
            />
          ) : capabilities.data.capabilities.length === 0 ? (
            <EmptyState icon="PackageOpen" title="No capabilities reported" detail="The capability report returned an empty list." />
          ) : (
            <>
              {capabilities.data.summary ? (
                <ul className="fw-settings__facts">
                  <li>
                    <Icon name="PackageCheck" size="sm" className="fw-settings__facts-mark" />
                    <span>
                      <Machine>{capabilities.data.summary.total ?? '—'}</Machine> capabilities tracked —{' '}
                      <Machine muted>{capabilities.data.summary.active ?? '—'}</Machine> active,{' '}
                      <Machine muted>{capabilities.data.summary.dormant ?? '—'}</Machine> dormant,{' '}
                      <Machine muted>{capabilities.data.summary.neverUsed ?? '—'}</Machine> never used.
                    </span>
                  </li>
                </ul>
              ) : null}
              <div className="fw-settings__table-scroll">
                <table className="fw-settings__table">
                  <thead>
                    <tr>
                      <th scope="col">Capability</th>
                      <th scope="col">Kind</th>
                      <th scope="col">Status</th>
                      <th scope="col">Times used</th>
                      <th scope="col">Last run</th>
                    </tr>
                  </thead>
                  <tbody>
                    {capabilities.data.capabilities.map((entry) => (
                      <tr key={entry.capability}>
                        <td>
                          <Machine>{entry.name ?? entry.capability}</Machine>
                        </td>
                        <td>
                          <Machine muted>{entry.kind ?? '—'}</Machine>
                        </td>
                        <td>
                          <Machine muted>{entry.status ?? '—'}</Machine>
                        </td>
                        <td>
                          <Machine muted>{entry.timesUsed ?? '—'}</Machine>
                        </td>
                        <td>
                          <Machine muted>{entry.lastUsedRun ?? '—'}</Machine>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Panel>
      </>
    );
  }

  function renderAgents(): ReactNode {
    return (
      <Panel title="Roster" subtitle="The team this workspace renders.">
        <ul className="fw-settings__facts">
          <li>
            <Icon name="Users" size="sm" className="fw-settings__facts-mark" />
            <span>
              <Machine>{agents.length}</Machine> agents across seven groups, each drawn with the
              group luminance step rather than a colour.
            </span>
          </li>
        </ul>
      </Panel>
    );
  }

  function renderSkills(): ReactNode {
    return (
      <Panel
        title="Skills"
        subtitle={`${skills.length} skills referenced by the agent roster.`}
        actions={<ExampleTag />}
      >
        <Note>
          Toggling a skill here changes nothing yet — there is no gateway route that starts or stops
          a skill from this screen.
        </Note>
        <ul className="fw-settings__skill-grid">
          {skills.map((skill) => (
            <li key={skill} className="fw-settings__skill">
              <Machine className="fw-settings__skill-name">{skill}</Machine>
              <Switch size="sm" {...inertSwitch(`skill.${skill}`, skill, true)} />
            </li>
          ))}
        </ul>
      </Panel>
    );
  }

  function renderPermissions(): ReactNode {
    const levels: readonly { readonly level: string; readonly reach: string }[] = [
      { level: 'read-only', reach: 'Reads the tree and reports. Writes nothing, ever.' },
      { level: 'standard', reach: 'Writes inside its own work package and its own artifacts.' },
      { level: 'elevated', reach: 'Writes across packages and may run the project toolchain.' },
      { level: 'lead', reach: 'Dispatches other agents and closes work packages.' },
    ];

    return (
      <>
        <Panel title="Levels" subtitle="What each level would be allowed to do.">
          <div className="fw-settings__table-scroll">
            <table className="fw-settings__table">
              <thead>
                <tr>
                  <th scope="col">Level</th>
                  <th scope="col">Reach</th>
                </tr>
              </thead>
              <tbody>
                {levels.map((row) => (
                  <tr key={row.level}>
                    <td>
                      <Machine>{row.level}</Machine>
                    </td>
                    <td>{row.reach}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </>
    );
  }

  function renderPrivacy(): ReactNode {
    return (
      <>
        <Panel title="What is stored" subtitle="Three keys in this browser's localStorage. That is the whole list.">
          <div className="fw-settings__table-scroll">
            <table className="fw-settings__table">
              <thead>
                <tr>
                  <th scope="col">Key</th>
                  <th scope="col">Value</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <Machine>forge.prototype.appearance</Machine>
                  </td>
                  <td>
                    <Machine muted>dark | light | system</Machine>
                  </td>
                </tr>
                <tr>
                  <td>
                    <Machine>forge.prototype.density</Machine>
                  </td>
                  <td>
                    <Machine muted>comfortable | compact</Machine>
                  </td>
                </tr>
                <tr>
                  <td>
                    <Machine>forge.workspace.preferences</Machine>
                  </td>
                  <td>
                    <Machine muted>the composer, reading and layout-remembering preferences above</Machine>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel title="What is not stored, and what is sent" subtitle="No exceptions and no small print.">
          <ul className="fw-settings__facts">
            <li>
              <Icon name="Minus" size="sm" className="fw-settings__facts-mark" />
              <span>
                Sending a chat message reaches the gateway at <Machine>127.0.0.1:4100</Machine> on
                this machine only — this workspace never calls a remote server.
              </span>
            </li>
            <li>
              <Icon name="Minus" size="sm" className="fw-settings__facts-mark" />
              <span>No account, no cookie, no session identifier, no analytics, no telemetry.</span>
            </li>
            <li>
              <Icon name="Minus" size="sm" className="fw-settings__facts-mark" />
              <span>
                Every project, agent, run and ledger line you see is read from a real gateway
                record. A value this workspace cannot read renders as an absence marker — a dash,
                a named empty state — never an invented number standing in for it.
              </span>
            </li>
            <li>
              <Icon name="Minus" size="sm" className="fw-settings__facts-mark" />
              <span>
                Everything you change outside those three keys — selections, filters, pinned
                projects, the shell layout toggles above — lives in memory and disappears on reload.
              </span>
            </li>
          </ul>
        </Panel>

        <Panel title="Reset" subtitle="Puts every stored preference back to its default.">
          <Button icon="RotateCcw" onClick={resetPreferences}>
            Reset stored preferences
          </Button>
        </Panel>
      </>
    );
  }

  function renderShortcuts(): ReactNode {
    return (
      <>
        <Panel title="Reference" subtitle="The vocabulary the workspace is designed around.">
          <Note>
            A reference table. The shell implements the subset it needs; the rest describes the
            intended design.
          </Note>
        </Panel>
        {SHORTCUT_GROUPS.map((group) => (
          <Panel key={group.title} title={group.title}>
            <div className="fw-settings__table-scroll">
              <table className="fw-settings__table fw-settings__table--shortcuts">
                <thead>
                  <tr>
                    <th scope="col">Shortcut</th>
                    <th scope="col">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {group.rows.map((row) => (
                    <tr key={row.action}>
                      <td>
                        <KeyHint keys={row.keys} />
                      </td>
                      <td>{row.action}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        ))}
      </>
    );
  }

  function renderSection(): ReactNode {
    switch (section) {
      case 'appearance':
        return renderAppearance();
      case 'layout':
        return renderLayout();
      case 'chat':
        return renderChat();
      case 'connection':
        return renderConnection();
      case 'models':
        return renderModels();
      case 'capabilities':
        return renderCapabilities();
      case 'agents':
        return renderAgents();
      case 'skills':
        return renderSkills();
      case 'permissions':
        return renderPermissions();
      case 'privacy':
        return renderPrivacy();
      case 'shortcuts':
        return renderShortcuts();
      default:
        return null;
    }
  }

  /* ------------------------------------------------------------ render */

  return (
    <div className="fw-settings">
      <header className="fw-settings__head">
        <div className="fw-settings__headings">
          <Eyebrow>SETTINGS</Eyebrow>
          <h1 className="fw-settings__title">Workspace settings</h1>
          <p className="fw-settings__lede">
            Appearance, density, motion, the shell layout and the preferences below are wired to the
            workspace and take effect as you touch them. Anything without real behaviour behind it
            has been removed rather than left to pretend.
          </p>
        </div>
        <Toolbar label="Settings actions" className="fw-settings__head-toolbar">
          <ExampleTag detail="A visual prototype. Not connected to Forge, Claude Code or any API." />
          <Spacer />
          <Button size="sm" icon="RotateCcw" onClick={resetPreferences}>
            Reset stored preferences
          </Button>
        </Toolbar>
      </header>

      <div className="fw-settings__body">
        <nav className="fw-settings__nav" aria-label="Settings sections">
          <ul className="fw-settings__nav-list">
            {SECTIONS.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  className={
                    entry.id === section
                      ? 'fw-settings__nav-item is-selected'
                      : 'fw-settings__nav-item'
                  }
                  aria-current={entry.id === section ? 'true' : undefined}
                  onClick={() => setSection(entry.id)}
                >
                  <Icon name={entry.icon} size="sm" className="fw-settings__nav-icon" />
                  <span className="fw-settings__nav-label fw-truncate">{entry.label}</span>
                  {entry.wired ? (
                    <>
                      <span className="fw-settings__nav-mark" aria-hidden="true" />
                      <span className="fw-visually-hidden">wired to the workspace</span>
                    </>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
          <p className="fw-settings__nav-legend">
            <span className="fw-settings__nav-mark" aria-hidden="true" />
            <span>Marked sections genuinely change the workspace.</span>
          </p>
        </nav>

        <div className="fw-settings__content fw-scroll">
          <div className="fw-settings__section">
            <header className="fw-settings__section-head">
              <div className="fw-settings__section-heading">
                <Eyebrow>{active.wired ? 'WIRED' : 'PRESENTATION ONLY'}</Eyebrow>
                <h2 className="fw-settings__section-title">{active.label}</h2>
              </div>
              <p className="fw-settings__section-sub">{active.summary}</p>
            </header>
            <div className="fw-settings__panels">{renderSection()}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
