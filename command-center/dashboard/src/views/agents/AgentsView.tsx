/**
 * Agents view — this project's agent roster.
 *
 * Four views: three persisted layouts (compact list / grid / grouped by
 * function, `state.agentLayout`) plus a fourth, local-only "Nodes" mode
 * (`AgentsGraph.tsx`) that draws the same filtered roster as a pan/zoomable
 * reporting-line graph. A status filter row bound to `state.agentFilter` with
 * live counts applies to all four.
 *
 * `state.data.agents` is real in production (this project's own registry, read
 * through the gateway) and fixture-labelled example data otherwise — the view
 * itself cannot tell which.
 *
 * Group identity is carried by the --forge-group-* luminance step plus a
 * distinct lucide glyph per group — never by hue, because the palette has none.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Avatar,
  Button,
  EmptyState,
  Eyebrow,
  ExampleTag,
  Icon,
  Machine,
  Meter,
  SegmentedControl,
  StatusBadge,
  Toolbar,
  statusPresentation,
} from '@/components/primitives';
import { STATUS_KEYS } from '@/prototype/types/prototype-types';
import type {
  Agent,
  AgentGroup,
  AgentLayout,
  EffortTier,
  PermissionLevel,
  StatusKey,
} from '@/prototype/types/prototype-types';
import { nextToastId, selectFilteredAgents, usePrototype } from '@/prototype/state/prototype-store';
import { gwGet } from '@/prototype/state/gateway-client';
import { parseAgentRows, type AgentRow } from '@/prototype/state/adapter/rows';
import { patchAgentModel, type AgentModelField } from '@/prototype/state/adapter/agent-model';
import { GROUPS, GROUP_BY_KEY } from './agent-groups';
import { AgentsGraph } from './AgentsGraph';
import { AgentModelPicker } from './agent-model-picker';
import { LiveAgentsStrip } from './LiveAgentsStrip';
import './agents.css';

/* ------------------------------------------------------------------ tables */

type AgentFilter = StatusKey | 'all';

interface FilterDef {
  readonly value: AgentFilter;
  readonly label: string;
  readonly icon: string;
}

/**
 * `active` is the running status under a friendlier name. `failed` is included
 * so a failed agent stays reachable from the filter row rather than only from
 * ALL — the example roster has one.
 */
const FILTERS: readonly FilterDef[] = [
  { value: 'all', label: 'ALL', icon: 'Users' },
  { value: 'running', label: 'ACTIVE', icon: statusPresentation('running').icon },
  { value: 'waiting', label: 'WAITING', icon: statusPresentation('waiting').icon },
  { value: 'verify', label: 'VERIFY', icon: statusPresentation('verify').icon },
  { value: 'review', label: 'REVIEW', icon: statusPresentation('review').icon },
  { value: 'blocked', label: 'BLOCKED', icon: statusPresentation('blocked').icon },
  { value: 'failed', label: 'FAILED', icon: statusPresentation('failed').icon },
  { value: 'completed', label: 'COMPLETED', icon: statusPresentation('completed').icon },
];

const LAYOUTS: readonly { value: AgentLayout; label: string; icon: string }[] = [
  { value: 'list', label: 'List', icon: 'Rows3' },
  { value: 'grid', label: 'Grid', icon: 'LayoutGrid' },
  { value: 'grouped', label: 'Grouped', icon: 'Group' },
];

/**
 * A local, view-only fourth mode layered on top of the persisted `AgentLayout`
 * (list/grid/grouped, `state.agentLayout`, owned by the shared prototype
 * store). "Nodes" is deliberately NOT added to that shared union — this view's
 * write scope is this directory only, and the shared reducer/type already has
 * other consumers (`SettingsView.tsx`'s own default-layout control). Selecting
 * "Nodes" flips local `nodesActive` state without touching the persisted
 * layout at all, so switching back to List/Grid/Grouped restores exactly what
 * was there before.
 */
type AgentViewMode = AgentLayout | 'nodes';

const VIEW_MODES: readonly { value: AgentViewMode; label: string; icon: string }[] = [
  ...LAYOUTS,
  { value: 'nodes', label: 'Nodes', icon: 'Network' },
];

const PERMISSION: Readonly<Record<PermissionLevel, { label: string; icon: string }>> = {
  'read-only': { label: 'READ-ONLY', icon: 'Eye' },
  standard: { label: 'STANDARD', icon: 'Shield' },
  elevated: { label: 'ELEVATED', icon: 'ShieldPlus' },
  lead: { label: 'LEAD', icon: 'ShieldCheck' },
};

/**
 * fix-cert-rest (item 2): keyed on `NonNullable<Agent['verification']>` — `null` (no verification
 * evidence exists for this agent in this run) is handled separately by `VerificationChip` below,
 * rendered as absent, never as a claim about the agent's role. `'not-required'` stays a real,
 * renderable state: fixture/example data may still genuinely assert it for a role.
 */
const VERIFICATION: Readonly<
  Record<NonNullable<Agent['verification']>, { label: string; icon: string; detail: string }>
> = {
  verified: {
    label: 'VERIFIED',
    icon: 'BadgeCheck',
    detail: 'Verification accepted the evidence attached to this agent’s last claim.',
  },
  pending: {
    label: 'PENDING',
    icon: 'Hourglass',
    detail: 'A claim is waiting on the verify loop — not yet accepted.',
  },
  rejected: {
    label: 'REJECTED',
    icon: 'Ban',
    detail: 'Verification rejected the last claim and reopened the work.',
  },
  'not-required': {
    label: 'NOT REQUIRED',
    icon: 'Minus',
    detail: 'This role produces no claim that the verify loop has to check.',
  },
};

/** fix-cert-rest (item 2): the honest state for "no verification evidence exists for this agent in
 *  this run" — never `'not-required'`, which is a claim about the ROLE this app has no live source
 *  for (see `Agent.verification`'s own doc comment in `prototype-types.ts`). */
const VERIFICATION_UNKNOWN = {
  label: '—',
  icon: 'Minus',
  detail: 'No verification evidence exists yet for this agent in the current run.',
} as const;

const EFFORT_ORDER: readonly EffortTier[] = ['low', 'medium', 'high', 'max'];

function isAgentLayout(value: string): value is AgentLayout {
  return value === 'list' || value === 'grid' || value === 'grouped';
}

/* --------------------------------------------------------- model editing */

/**
 * feat-agent-model-edit: the raw, per-agent `AgentRow` (real `claudeTier`/`claudeEffort` strings —
 * `Agent.effort`, the mapped `EffortTier`, is lossy for this: `toEffortTier` in mappers.ts folds
 * an unrecognised raw value like `'xhigh'` down to `'medium'`) plus the real allowed values for
 * each field, derived the SAME way `agents-write.mjs` derives them server-side: the distinct set
 * of values that genuinely already exist across every agent in the roster. Never hardcoded here —
 * see this module's own header comment on `deriveAllowedValues` for the identical server-side rule
 * this mirrors.
 */
interface AgentModelState {
  /**
   * WHICH project these rows were read for (MEDIUM finding, independent Codex review of dc8e30c,
   * 2026-07-30). Rows are keyed by agent slug alone, and the same slug exists in every Forge
   * project — so without this tag, switching projects kept showing (and offering to edit) the
   * PREVIOUS project's on-disk tier/effort until the new fetch resolved, and kept showing it
   * indefinitely if that fetch failed (the effect deliberately never blanks the roster on a
   * transient error). A wrong pick was already refused server-side by the new project's own
   * allowlist, so nothing incorrect was ever written — but the screen claimed a value that did not
   * belong to the project in view, which is the same class of dishonesty this run has been removing
   * everywhere else. Reading a row now requires the project to match.
   */
  readonly projectId: string;
  readonly rows: ReadonlyMap<string, AgentRow>;
  readonly allowedTiers: readonly string[];
  readonly allowedEfforts: readonly string[];
}

const EMPTY_MODEL_STATE: AgentModelState = { projectId: '', rows: new Map(), allowedTiers: [], allowedEfforts: [] };

function buildModelState(projectId: string, agentRows: readonly AgentRow[]): AgentModelState {
  const rows = new Map(agentRows.map((row) => [row.slug, row] as const));
  const tiers = new Set<string>();
  const efforts = new Set<string>();
  for (const row of agentRows) {
    if (row.modelTier !== null) tiers.add(row.modelTier);
    if (row.claudeEffort !== null) efforts.add(row.claudeEffort);
  }
  return { projectId, rows, allowedTiers: [...tiers].sort(), allowedEfforts: [...efforts].sort() };
}

/* --------------------------------------------------------------- fragments */

function PermissionChip({ level }: { level: PermissionLevel }) {
  const meta = PERMISSION[level];
  return (
    <span className="fw-agents-chip" data-permission={level} title={`Permission level: ${meta.label}`}>
      <Icon name={meta.icon} size="xs" />
      <Machine>{meta.label}</Machine>
    </span>
  );
}

function VerificationChip({ state: verification }: { state: Agent['verification'] }) {
  // fix-cert-rest (item 2): `null` is a genuine absence of verification evidence, never the
  // 'not-required' claim — rendered with the same neutral "unknown" chip, never a role claim.
  const meta = verification === null ? VERIFICATION_UNKNOWN : VERIFICATION[verification];
  return (
    <span className="fw-agents-chip" data-verification={verification ?? 'unknown'} title={meta.detail}>
      <Icon name={meta.icon} size="xs" />
      <Machine>{meta.label}</Machine>
      <span className="fw-visually-hidden">{meta.detail}</span>
    </span>
  );
}

function EffortMark({ effort }: { effort: EffortTier }) {
  const level = EFFORT_ORDER.indexOf(effort) + 1;
  return (
    <span className="fw-agents-effort" title={`Effort tier: ${effort.toUpperCase()}`}>
      <span className="fw-agents-effort__bars" aria-hidden="true">
        {EFFORT_ORDER.map((tier, index) => (
          <span
            key={tier}
            className={index < level ? 'fw-agents-effort__bar is-on' : 'fw-agents-effort__bar'}
          />
        ))}
      </span>
      <Machine>{effort.toUpperCase()}</Machine>
    </span>
  );
}

function SkillChips({ skills }: { skills: readonly string[] }) {
  if (skills.length === 0) {
    return (
      <p className="fw-agents-skills__none">No skills attached to this agent.</p>
    );
  }
  return (
    <ul className="fw-agents-skills" aria-label="Attached skills">
      {skills.map((skill) => (
        <li key={skill} className="fw-agents-chip fw-agents-chip--skill">
          <Machine>{skill}</Machine>
        </li>
      ))}
    </ul>
  );
}

function ModelLine({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <div className="fw-agents-model">
      <dt className="fw-agents-model__key">
        <Icon name={icon} size="xs" />
        <Eyebrow>{label}</Eyebrow>
      </dt>
      <dd className="fw-agents-model__val">
        <Machine muted>{value}</Machine>
      </dd>
    </div>
  );
}

/**
 * feat-agent-model-edit: the editable twin of `ModelLine` above — same `dt`/`dd` shape, but the
 * value is a real `AgentModelPicker` rather than static text. Only ever rendered once a real
 * `modelRow` exists for this agent (see `AgentCard`/`AgentRow` below), so `value` here is always the
 * genuine current on-disk string, never a guess.
 */
function ModelEditLine({
  icon,
  label,
  field,
  slug,
  value,
  options,
  pendingModelKey,
  onModelPick,
}: {
  icon: string;
  label: string;
  field: AgentModelField;
  slug: string;
  value: string;
  options: readonly string[];
  pendingModelKey: string | null;
  onModelPick: (slug: string, field: AgentModelField, value: string) => void;
}) {
  const key = `${slug}:${field}`;
  return (
    <div className="fw-agents-model">
      <dt className="fw-agents-model__key">
        <Icon name={icon} size="xs" />
        <Eyebrow>{label}</Eyebrow>
      </dt>
      {/* fix-modelpick-clip (2026-07-30, owner: "als ik op agents de model wil veranderen dan zie
          ik niks!"): the base __val cell truncates its text with overflow:hidden — but this editable
          variant hosts the picker, whose absolutely-positioned panel is a CHILD of the cell and was
          therefore clipped to the cell's 26px (measured live: panel top 573 below cell bottom 569 →
          100% invisible while present in the DOM with 4 options; jsdom-based tests could not see
          this). The --editor modifier lifts the clip; the trigger truncates its own label already. */}
      <dd className="fw-agents-model__val fw-agents-model__val--editor">
        <AgentModelPicker
          label={label}
          icon={icon}
          value={value}
          options={options}
          pending={pendingModelKey === key}
          onPick={(next) => onModelPick(slug, field, next)}
        />
      </dd>
    </div>
  );
}

interface EntryProps {
  agent: Agent;
  selected: boolean;
  onSelect: (id: string) => void;
  /** feat-agent-model-edit: `undefined` when the raw roster fetch has not resolved yet (or failed) —
   *  every consumer falls back to the existing read-only display in that case. */
  modelRow?: AgentRow;
  allowedTiers: readonly string[];
  allowedEfforts: readonly string[];
  /** `"<slug>:<field>"` of the one edit currently in flight, or `null`. */
  pendingModelKey: string | null;
  onModelPick: (slug: string, field: AgentModelField, value: string) => void;
}

/* ------------------------------------------------------------------- card */

function AgentCard({ agent, selected, onSelect, modelRow, allowedTiers, allowedEfforts, pendingModelKey, onModelPick }: EntryProps) {
  const group = GROUP_BY_KEY[agent.group];

  return (
    <li
      className={
        selected
          ? 'fw-agents-card fw-status fw-agents-group is-selected'
          : 'fw-agents-card fw-status fw-agents-group'
      }
      data-status={agent.status}
      data-group={agent.group}
      data-agent-id={agent.id}
    >
      <div className="fw-agents-card__top">
        <Avatar name={agent.name} group={agent.group} size="sm" decorative />
        <div className="fw-agents-card__ident">
          <button
            type="button"
            className="fw-agents-card__hit"
            aria-pressed={selected}
            onClick={() => onSelect(agent.id)}
          >
            {agent.name}
          </button>
          <Machine muted className="fw-agents-card__id">
            {agent.id}
          </Machine>
        </div>
        <StatusBadge status={agent.status} size="sm" />
      </div>

      <div className="fw-agents-card__group">
        <span className="fw-agents-card__glyph">
          <Icon name={group.glyph} size="xs" />
        </span>
        <Machine muted>{group.label}</Machine>
        <span className="fw-agents-card__divider" aria-hidden="true" />
        <PermissionChip level={agent.permission} />
      </div>

      <p className="fw-agents-card__role">{agent.role}</p>

      <div className="fw-agents-card__task">
        <Eyebrow>Current task</Eyebrow>
        <p className={agent.currentTask ? 'fw-agents-card__task-text' : 'fw-agents-card__task-text is-none'}>
          {agent.currentTask ?? 'No task assigned right now.'}
        </p>
      </div>

      {agent.status === 'running' ? (
        <Meter value={agent.progress} tone="accent" showValue />
      ) : null}

      <dl className="fw-agents-card__models">
        {modelRow !== undefined ? (
          <ModelEditLine
            icon="Cpu"
            label="Runtime"
            field="claudeTier"
            slug={modelRow.slug}
            value={modelRow.modelTier ?? agent.runtimeModel}
            options={allowedTiers}
            pendingModelKey={pendingModelKey}
            onModelPick={onModelPick}
          />
        ) : (
          <ModelLine icon="Cpu" label="Runtime" value={agent.runtimeModel} />
        )}
        <ModelLine icon="Boxes" label="Tool model" value={agent.toolModel} />
        {modelRow !== undefined && modelRow.claudeEffort !== null ? (
          <ModelEditLine
            icon="Gauge"
            label="Effort"
            field="claudeEffort"
            slug={modelRow.slug}
            value={modelRow.claudeEffort}
            options={allowedEfforts}
            pendingModelKey={pendingModelKey}
            onModelPick={onModelPick}
          />
        ) : null}
      </dl>

      <div className="fw-agents-card__skills">
        <Eyebrow>Skills</Eyebrow>
        <SkillChips skills={agent.skills} />
      </div>

      <div className="fw-agents-card__foot">
        <EffortMark effort={agent.effort} />
        <VerificationChip state={agent.verification} />
        <span className="fw-agents-card__activity">
          <Icon name="Clock" size="xs" />
          <Machine muted>{agent.lastActivity}</Machine>
        </span>
      </div>
    </li>
  );
}

/* -------------------------------------------------------------------- row */

function AgentRow({ agent, selected, onSelect, modelRow, allowedTiers, allowedEfforts, pendingModelKey, onModelPick }: EntryProps) {
  const group = GROUP_BY_KEY[agent.group];

  return (
    <li
      className={
        selected
          ? 'fw-agents-row fw-status fw-agents-group is-selected'
          : 'fw-agents-row fw-status fw-agents-group'
      }
      data-status={agent.status}
      data-group={agent.group}
      data-agent-id={agent.id}
    >
      <span className="fw-agents-row__glyph" title={`${group.label} group`}>
        <Icon name={group.glyph} size="sm" />
        <span className="fw-visually-hidden">{group.label} group</span>
      </span>

      <div className="fw-agents-row__body">
        <div className="fw-agents-row__line">
          <button
            type="button"
            className="fw-agents-row__hit"
            aria-pressed={selected}
            onClick={() => onSelect(agent.id)}
          >
            {agent.name}
          </button>
          <Machine muted className="fw-agents-row__id">
            {agent.id}
          </Machine>
          <StatusBadge status={agent.status} size="sm" />
          <PermissionChip level={agent.permission} />
          <EffortMark effort={agent.effort} />
          <VerificationChip state={agent.verification} />
        </div>

        <p className="fw-agents-row__role">{agent.role}</p>

        <p className={agent.currentTask ? 'fw-agents-row__task' : 'fw-agents-row__task is-none'}>
          <Icon name="CornerDownRight" size="xs" />
          {agent.currentTask ?? 'No task assigned right now.'}
        </p>

        <div className="fw-agents-row__meta">
          <span className="fw-agents-row__meta-item">
            {modelRow !== undefined ? (
              <AgentModelPicker
                label="Runtime"
                icon="Cpu"
                value={modelRow.modelTier ?? agent.runtimeModel}
                options={allowedTiers}
                pending={pendingModelKey === `${modelRow.slug}:claudeTier`}
                onPick={(value) => onModelPick(modelRow.slug, 'claudeTier', value)}
              />
            ) : (
              <>
                <Icon name="Cpu" size="xs" />
                <Machine muted>{agent.runtimeModel}</Machine>
              </>
            )}
          </span>
          <span className="fw-agents-row__meta-item">
            <Icon name="Boxes" size="xs" />
            <Machine muted>{agent.toolModel}</Machine>
          </span>
          {modelRow !== undefined && modelRow.claudeEffort !== null ? (
            <span className="fw-agents-row__meta-item">
              <AgentModelPicker
                label="Effort"
                icon="Gauge"
                value={modelRow.claudeEffort}
                options={allowedEfforts}
                pending={pendingModelKey === `${modelRow.slug}:claudeEffort`}
                onPick={(value) => onModelPick(modelRow.slug, 'claudeEffort', value)}
              />
            </span>
          ) : null}
          <span className="fw-agents-row__meta-item">
            <Icon name="Clock" size="xs" />
            <Machine muted>{agent.lastActivity}</Machine>
          </span>
          <SkillChips skills={agent.skills} />
        </div>
      </div>

      <div className="fw-agents-row__progress">
        {agent.status === 'running' ? (
          <Meter value={agent.progress} tone="accent" showValue />
        ) : (
          <span className="fw-agents-row__progress-idle">
            <Machine muted>—</Machine>
          </span>
        )}
      </div>
    </li>
  );
}

/* ------------------------------------------------------------------- view */

export default function AgentsView() {
  const { state, dispatch } = usePrototype();
  const agents = state.data.agents;
  const visible = selectFilteredAgents(state);
  const layout = state.agentLayout;
  const selectedId = state.selection.kind === 'agent' ? state.selection.id : null;

  // Local-only: see `AgentViewMode`'s doc comment above. Not persisted, not
  // dispatched to the shared store — a pure UI toggle scoped to this view.
  const [nodesActive, setNodesActive] = useState(false);
  const viewMode: AgentViewMode = nodesActive ? 'nodes' : layout;

  // feat-agent-model-edit: an INDEPENDENT, view-local fetch of the raw `/api/agents` roster —
  // deliberately not sharing `useGatewayProjectAgents` (the shared 2.5s-poll hook `useGatewayDataset`
  // already calls to build `state.data.agents`), since that hook only ever exposes `Agent.effort`,
  // the LOSSY mapped `EffortTier` (`toEffortTier` in mappers.ts folds an unrecognised raw value like
  // `'xhigh'` down to `'medium'`) — editing needs the real raw string. This also gives a real,
  // on-demand "read again from the gateway" step right after a successful PATCH (see
  // `refreshModelRows`/`handleModelPick` below), rather than waiting on the shared hook's own poll
  // interval.
  const [modelState, setModelState] = useState<AgentModelState>(EMPTY_MODEL_STATE);
  const [pendingModelKey, setPendingModelKey] = useState<string | null>(null);
  // Bumped after a successful PATCH to trigger a fresh re-fetch below — mirrors the shape every
  // other polling hook in this codebase uses (an inline async fetch declared INSIDE the effect,
  // never an outer memoized function called FROM the effect), so a real re-read never overlaps a
  // stale in-flight one and never fires synchronously from the effect body itself.
  const [modelRefreshTick, setModelRefreshTick] = useState(0);
  // Alleen rijen van het ACTIEVE project mogen de picker voeden (zie AgentModelState.projectId).
  const modelRowsForProject = modelState.projectId === state.activeProjectId ? modelState.rows : EMPTY_MODEL_STATE.rows;
  const allowedTiersForProject = modelState.projectId === state.activeProjectId ? modelState.allowedTiers : EMPTY_MODEL_STATE.allowedTiers;
  const allowedEffortsForProject = modelState.projectId === state.activeProjectId ? modelState.allowedEfforts : EMPTY_MODEL_STATE.allowedEfforts;

  useEffect(() => {
    if (state.activeProjectId === '') return undefined;
    let cancelled = false;
    async function load(): Promise<void> {
      const result = await gwGet(`/api/agents?project=${encodeURIComponent(state.activeProjectId)}`);
      if (cancelled || !result.ok) return; // keep whatever was last known — never blank the roster on a transient failure
      setModelState(buildModelState(state.activeProjectId, parseAgentRows(result.data)));
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [state.activeProjectId, modelRefreshTick]);

  async function handleModelPick(slug: string, field: AgentModelField, value: string): Promise<void> {
    const key = `${slug}:${field}`;
    setPendingModelKey(key);
    const result = await patchAgentModel(state.activeProjectId, slug, field, value);
    setPendingModelKey(null);
    if (!result.ok) {
      dispatch({
        type: 'toast/push',
        toast: {
          id: nextToastId(),
          title: 'Model change failed',
          detail: result.error ?? 'The gateway rejected this change.',
          icon: 'TriangleAlert',
        },
      });
      return; // the old value is still on screen — nothing was ever set optimistically
    }
    // Honesty rule (work package): show the value read FRESH from the gateway/disk after success,
    // never the merely-requested one — a real re-fetch (the effect above), not the PATCH response
    // trusted blindly.
    setModelRefreshTick((tick) => tick + 1);
  }

  const counts = useMemo(() => {
    const map: Record<string, number> = { all: agents.length };
    for (const key of STATUS_KEYS) {
      map[key] = agents.filter((agent) => agent.status === key).length;
    }
    return map;
  }, [agents]);

  const banded = useMemo(() => {
    const map = new Map<AgentGroup, Agent[]>();
    for (const group of GROUPS) map.set(group.key, []);
    for (const agent of visible) map.get(agent.group)?.push(agent);
    return map;
  }, [visible]);

  function select(id: string) {
    dispatch({ type: 'select', selection: { kind: 'agent', id } });
  }

  const cards = (list: readonly Agent[]) => (
    <ul className="fw-agents-grid">
      {list.map((agent) => (
        <AgentCard
          key={agent.id}
          agent={agent}
          selected={agent.id === selectedId}
          onSelect={select}
          modelRow={modelRowsForProject.get(agent.id)}
          allowedTiers={allowedTiersForProject}
          allowedEfforts={allowedEffortsForProject}
          pendingModelKey={pendingModelKey}
          onModelPick={(slug, field, value) => void handleModelPick(slug, field, value)}
        />
      ))}
    </ul>
  );

  const empty = (
    <EmptyState
      icon="UserRoundSearch"
      title="No agents in this state"
      detail="No agent in this roster has that status right now. Clear the filter to see the full team."
      action={
        <Button size="sm" icon="RotateCcw" onClick={() => dispatch({ type: 'agents/filter', filter: 'all' })}>
          Show all agents
        </Button>
      }
    />
  );

  return (
    <div className="fw-agents">
      <header className="fw-agents__head">
        <div className="fw-agents__heading">
          <Eyebrow>Roster</Eyebrow>
          <h1 className="fw-agents__title">Agents</h1>
          <p className="fw-agents__subtitle">
            The team assigned to this project — who owns what, what they are holding, and whether
            verification has agreed with them yet. <ExampleTag />
          </p>
        </div>

        <Toolbar label="Agent view controls" className="fw-agents__toolbar">
          <SegmentedControl
            className="fw-agents__layout"
            label="Agent layout"
            size="sm"
            value={viewMode}
            options={VIEW_MODES.map((option) => ({
              value: option.value,
              label: option.label,
              icon: option.icon,
            }))}
            onChange={(value) => {
              if (value === 'nodes') {
                setNodesActive(true);
                return;
              }
              if (isAgentLayout(value)) {
                setNodesActive(false);
                dispatch({ type: 'agents/layout', layout: value });
              }
            }}
          />
        </Toolbar>
      </header>

      <LiveAgentsStrip agentCount={agents.length} projectId={state.activeProjectId} />

      <div className="fw-agents__filters" role="group" aria-label="Filter agents by state">
        {FILTERS.map((filter) => {
          const active = state.agentFilter === filter.value;
          return (
            <Button
              key={filter.value}
              size="sm"
              variant={active ? 'ghost' : 'quiet'}
              icon={filter.icon}
              aria-pressed={active}
              className={active ? 'fw-agents__filter is-active' : 'fw-agents__filter'}
              onClick={() => dispatch({ type: 'agents/filter', filter: filter.value })}
            >
              <span className="fw-agents__filter-label fg-machine">{filter.label}</span>
              <span className="fw-agents__filter-count fg-machine">{counts[filter.value] ?? 0}</span>
            </Button>
          );
        })}
      </div>

      <div className="fw-agents__body fw-scroll">
        {visible.length === 0 ? (
          empty
        ) : viewMode === 'nodes' ? (
          <AgentsGraph agents={visible} selectedId={selectedId} onSelect={select} />
        ) : layout === 'list' ? (
          <ul className="fw-agents-list">
            {visible.map((agent) => (
              <AgentRow
                key={agent.id}
                agent={agent}
                selected={agent.id === selectedId}
                onSelect={select}
                modelRow={modelRowsForProject.get(agent.id)}
                allowedTiers={allowedTiersForProject}
                allowedEfforts={allowedEffortsForProject}
                pendingModelKey={pendingModelKey}
                onModelPick={(slug, field, value) => void handleModelPick(slug, field, value)}
              />
            ))}
          </ul>
        ) : layout === 'grid' ? (
          cards(visible)
        ) : (
          <div className="fw-agents__bands">
            {GROUPS.map((group) => {
              const list = banded.get(group.key) ?? [];
              return (
                <section
                  key={group.key}
                  className="fw-agents__band fw-agents-group"
                  data-group={group.key}
                  aria-labelledby={`agents-band-${group.key}`}
                >
                  <header className="fw-agents__band-head">
                    <span className="fw-agents__band-glyph">
                      <Icon name={group.glyph} size="sm" />
                    </span>
                    <h2 id={`agents-band-${group.key}`} className="fw-agents__band-title fg-machine">
                      {group.label}
                    </h2>
                    <span className="fw-agents__band-count fg-machine">{list.length}</span>
                    <p className="fw-agents__band-note">{group.note}</p>
                  </header>
                  {list.length === 0 ? (
                    <p className="fw-agents__band-empty">
                      No agent in this group matches the current filter.
                    </p>
                  ) : (
                    cards(list)
                  )}
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
