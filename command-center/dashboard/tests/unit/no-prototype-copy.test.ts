/**
 * No forbidden prototype/example copy renders in production — the render-level
 * backstop for `views/{projects,agents,tasks,files,artifacts,tests,activity,
 * mission,home,chat}` (fix-views, forge-2026-07-29-cc-finish).
 *
 * Grep alone is insufficient: a FIXTURE branch is allowed to say "example" — the
 * fixture path is opt-in only (`VITE_FORGE_FIXTURES=true` at build time AND an
 * explicit `allowFixtureData()` at run time, see `config/mode.ts`) and never
 * reaches a real user. What must never happen is a PRODUCTION render (the
 * default in every test in this repo — both fixture gates start closed) printing
 * any of `FORBIDDEN_PATTERNS` to the DOM: not in `textContent`, not in an
 * `aria-label`, not in a `title`, not in `data-label`, not in a `<caption>`.
 *
 * This suite renders each covered view/component directly against a REAL, empty
 * `PrototypeState` (the exact shape production starts from before any gateway
 * data has arrived — see `PrototypeProvider.tsx`'s `createInitialState` and
 * `store-adapter.ts`'s `EMPTY_DATASET`), WITHOUT mounting the real
 * `ProductionProvider` — that provider's hooks (`useGatewayDataset`,
 * `useGatewayFilesController`, `useGatewayChatSendController`) make real
 * `fetch`/`EventSource` calls against `127.0.0.1:4100`, which is exactly the kind
 * of live-process coupling a unit test must not have (this project's own real
 * gateway may legitimately be running on that port during a dev session). The
 * context values below are supplied directly instead: the real, empty
 * production-shaped state (the real production floor, not a shortcut), with a
 * hand-built stub `ChatSendController`/`FilesController` standing in for the
 * gateway-backed ones ChatView/FilesView read through context — never a real
 * network call.
 *
 * EXTEND this file's `VIEWS` list rather than duplicating `FORBIDDEN_PATTERNS`
 * or the scan helpers elsewhere.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import type { ReactElement, ComponentType } from 'react';
import { render, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { isProductionMode } from '@/config/mode';
import { PrototypeContext } from '@/prototype/state/prototype-store';
import type { PrototypeState, StoreValue } from '@/prototype/state/prototype-store';
import { EMPTY_DATASET } from '@/prototype/state/store-adapter';
import { ChatSendContext } from '@/prototype/state/chat-send';
import type { ChatSendController } from '@/prototype/state/chat-send';
import { FilesActionsContext } from '@/prototype/state/gateway-files';
import type { FilesController } from '@/prototype/state/gateway-files';
import type { Agent, ChatMessage, GraphLane, GraphNode, MissionGraph, Project, Run } from '@/prototype/types/prototype-types';

import ProjectsView from '@/views/projects/ProjectsView';
import AgentsView from '@/views/agents/AgentsView';
import TasksView from '@/views/tasks/TasksView';
import FilesView from '@/views/files/FilesView';
import ArtifactsView from '@/views/artifacts/ArtifactsView';
import TestsView from '@/views/tests/TestsView';
import ActivityView from '@/views/activity/ActivityView';
import MissionControlView from '@/views/mission/MissionControlView';
import HomeView from '@/views/home/HomeView';
import ProjectOverviewView from '@/views/projects/ProjectOverviewView';
import ChatView from '@/views/chat/ChatView';
import { Message } from '@/views/chat/Message';
import { Composer } from '@/views/chat/Composer';
import ThemeShowcaseView from '@/views/theme/ThemeShowcaseView';

/* ========================================================================== */
/*  1. Forbidden vocabulary + scan helpers (exported — extend, do not fork)   */
/* ========================================================================== */

/** Case-insensitive. A production render may contain NONE of these. */
export const FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /\bexample\b/i,
  /\bprototype\b/i,
  /\bplaceholder\b/i,
  /\bnot connected\b/i,
  /\bno backend\b/i,
  /\bnothing was generated\b/i,
  /\bsimulated\b/i,
];

/** Every visible/announced string a real user could encounter, joined for one scan. */
export function collectRenderedText(container: HTMLElement): string {
  const parts: string[] = [container.textContent ?? ''];
  for (const attribute of ['aria-label', 'title', 'data-label']) {
    container.querySelectorAll(`[${attribute}]`).forEach((el) => {
      const value = el.getAttribute(attribute);
      if (value) parts.push(value);
    });
  }
  container.querySelectorAll('caption').forEach((el) => parts.push(el.textContent ?? ''));
  return parts.join('\n');
}

/** The forbidden terms actually present in `text`, named for a readable failure. */
export function scanForbidden(text: string): string[] {
  return FORBIDDEN_PATTERNS.filter((pattern) => pattern.test(text)).map((pattern) => pattern.source);
}

/* ========================================================================== */
/*  2. A hermetic production harness — real empty state, zero network         */
/* ========================================================================== */

/** The exact empty floor production starts from — see file header. */
function buildEmptyState(): PrototypeState {
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

/** A no-op stand-in for the real, gateway-backed chat controller. Never calls fetch. */
const STUB_CHAT_CONTROLLER: ChatSendController = {
  run: { runId: null, status: null, active: false },
  canSend: true,
  disabledReason: null,
  sending: false,
  stopping: false,
  send: async () => ({ ok: true, error: null }),
  stop: async () => ({ ok: true, error: null }),
};

/** A no-op stand-in for the real, gateway-backed files controller. Never calls fetch. */
const STUB_FILES_CONTROLLER: FilesController = {
  tree: [],
  ensureLoaded: () => undefined,
  preview: null,
};

interface RenderOptions {
  readonly chat?: ChatSendController;
  readonly files?: FilesController;
  /** Defaults to the real, empty production floor (`buildEmptyState`) when omitted. */
  readonly state?: PrototypeState;
}

/** Wraps `ui` with exactly the context production would supply — no real network. */
function renderProduction(ui: ReactElement, options: RenderOptions = {}) {
  const value: StoreValue = { state: options.state ?? buildEmptyState(), dispatch: () => undefined };
  let tree: ReactElement = createElement(PrototypeContext.Provider, { value }, ui);
  if (options.chat) tree = createElement(ChatSendContext.Provider, { value: options.chat }, tree);
  if (options.files) tree = createElement(FilesActionsContext.Provider, { value: options.files }, tree);
  return render(createElement(MemoryRouter, null, tree));
}

/** A real (non-fixture) assistant turn — mirrors gateway-chat.ts's own cast. */
const REAL_ASSISTANT_MESSAGE = {
  id: 'msg-1',
  author: 'forge',
  body: 'A real streamed reply.',
  timestamp: '2026-07-29T00:00:00.000Z',
} as unknown as ChatMessage;

/* ========================================================================== */
/*  3. Coverage — this WP's 9 views + the 3 chat sub-components               */
/* ========================================================================== */

describe('no forbidden prototype/example copy renders in production mode', () => {
  afterEach(() => cleanup());

  it('confirms the default test mode really is production (the contrast this suite needs)', () => {
    expect(isProductionMode()).toBe(true);
  });

  const VIEWS: readonly { name: string; Component: ComponentType }[] = [
    { name: 'ProjectsView', Component: ProjectsView },
    { name: 'AgentsView', Component: AgentsView },
    { name: 'TasksView', Component: TasksView },
    { name: 'ArtifactsView', Component: ArtifactsView },
    { name: 'TestsView', Component: TestsView },
    { name: 'ActivityView', Component: ActivityView },
    { name: 'MissionControlView', Component: MissionControlView },
    { name: 'HomeView', Component: HomeView },
    // recertify follow-up (Lead): the verify pass found this view was routed at `/project` in
    // production but absent from this list, so the automatic guard never covered it — it had to be
    // checked by hand. A guard with a hole in it is worse than a known gap, because the green tick
    // implies coverage it does not have.
    { name: 'ProjectOverviewView', Component: ProjectOverviewView },
  ];

  for (const target of VIEWS) {
    it(`${target.name} renders zero forbidden strings against the real, empty production floor`, () => {
      const { container } = renderProduction(createElement(target.Component));
      const found = scanForbidden(collectRenderedText(container));
      expect(found, `${target.name} rendered forbidden term(s): ${found.join(', ')}`).toEqual([]);
    });
  }

  /**
   * cc-finish fix-cert-fabrication: `ThemeShowcaseView` was outside this scan's coverage until now
   * (it is routed for real at `/theme` in `App.tsx`, exactly like every other production view — not
   * dev-only). It is kept out of the uniform `VIEWS` loop above (rather than folded in unchanged)
   * because it has exactly one real, honest, non-fabrication hit: the focus-ring demo input's own
   * `aria-label="Focusable input example"` (an accurate description of a design-system SPECIMEN —
   * "here is an example of a focusable input" — not fabricated task/project data). Allowlisted below
   * via `scanForbiddenAllowlisted` (see its own header), the same exact-match idiom already used for
   * Settings' real `forge.prototype.*` storage keys — never a broader/fuzzy exclusion, so any OTHER
   * forbidden string this view might gain later still fails this test.
   */
  it('ThemeShowcaseView renders zero forbidden strings, aside from its one real, allowlisted focus-demo specimen label', () => {
    const { container } = renderProduction(createElement(ThemeShowcaseView));
    const found = scanForbiddenAllowlisted(collectRenderedText(container));
    expect(found, `ThemeShowcaseView rendered forbidden term(s): ${found.join(', ')}`).toEqual([]);
  });

  it('FilesView renders zero forbidden strings on the real (context-provided) production branch', () => {
    const { container } = renderProduction(createElement(FilesView), { files: STUB_FILES_CONTROLLER });
    const found = scanForbidden(collectRenderedText(container));
    expect(found, `FilesView rendered forbidden term(s): ${found.join(', ')}`).toEqual([]);
  });

  it('ChatView renders zero forbidden strings on the real (context-provided) production branch', () => {
    const { container } = renderProduction(createElement(ChatView), { chat: STUB_CHAT_CONTROLLER });
    const found = scanForbidden(collectRenderedText(container));
    expect(found, `ChatView rendered forbidden term(s): ${found.join(', ')}`).toEqual([]);
  });

  it('Composer renders zero forbidden strings (rendering alone never touches the network)', () => {
    const { container } = renderProduction(
      createElement(Composer, {
        onSend: () => true,
        onStop: () => undefined,
        streaming: false,
        conversationTitle: 'Test conversation',
        production: true,
      }),
    );
    const found = scanForbidden(collectRenderedText(container));
    expect(found, `Composer rendered forbidden term(s): ${found.join(', ')}`).toEqual([]);
  });

  it('Message renders zero forbidden strings for a real assistant turn with no regenerate target', () => {
    const { container } = renderProduction(
      createElement(Message, {
        message: REAL_ASSISTANT_MESSAGE,
        position: 1,
        total: 1,
        regenerate: null,
      }),
    );
    const found = scanForbidden(collectRenderedText(container));
    expect(found, `Message rendered forbidden term(s): ${found.join(', ')}`).toEqual([]);
  });
});

/* ========================================================================== */
/*  3b. A populated, one-running-run production state — catches F1 and F3     */
/*      TOGETHER (fix-cert-fabrication, forge-2026-07-29-cc-finish)           */
/* ========================================================================== */

/**
 * Every render test above uses `buildEmptyState()` (`EMPTY_DATASET` — zero projects, zero runs,
 * zero nodes). That empty floor structurally CANNOT reach either bug this section exists for:
 *
 *   - `MissionControlView` short-circuits into its own "No mission running" `EmptyState` the moment
 *     `graph.nodes.length === 0` (see its own header) — the running-node branch in `GraphNode.tsx`
 *     that used to render "…per cent through its example work" (F1) is simply never executed.
 *   - `ProjectsView` renders zero `<li>` rows against zero projects — there is no non-active row for
 *     a fabricated "Health 0%"/"0 tasks" placeholder (F3) to ever appear in.
 *
 * A real, non-fixture (`prototype` genuinely absent — see the `real()` cast below, mirroring
 * `gateway-adapter.ts`'s own `Omit<T, 'prototype'> as unknown as T` idiom) state with TWO projects
 * and ONE running run/agent/node reaches both branches at once, in one shared fixture.
 */

/** Mirrors `gateway-adapter.ts`'s own cast for every mapper (`toGatewayProject`/`toGatewayRun`/…):
 *  a real gateway record never carries `prototype: true` at runtime, even though the shared type
 *  (written for the fixture path) declares it as required. */
function real<T extends { readonly prototype: true }>(record: Omit<T, 'prototype'>): T {
  return record as unknown as T;
}

/** Two real (non-fixture) projects — one active with real detail, one not (the honest
 *  `EMPTY_ACTIVE_PROJECT_DETAIL` shape `gateway-adapter.ts` actually emits for every other project) —
 *  plus one real running run, agent and mission-graph node for that active project. */
function buildTwoProjectRunningState(): PrototypeState {
  const activeProject = real<Project>({
    id: 'proj-active',
    name: 'Active Project',
    description: 'The project with a real run in flight.',
    type: 'full-stack',
    status: 'running',
    lastActivity: '2 min ago',
    path: '/workspace/proj-active',
    templateVersion: 'forge-v2 · 2.7.0',
    pinned: false,
    conversationCount: 1,
    missionCount: 1,
    taskCount: 5,
    agentCount: 1,
    skills: [],
    health: { tests: { passed: 10, failed: 0, skipped: 0 }, openTickets: 0, blockers: 0, score: 80 },
  });

  // The exact shape gateway-adapter.ts's EMPTY_ACTIVE_PROJECT_DETAIL produces for every project
  // that is NOT the active one — real production data, never a fixture record. fix-cert-rest
  // (item 3): taskCount/health.score are now `number | null` and this placeholder now genuinely
  // emits `null` (not `0`) — updated here to keep mirroring gateway-adapter.ts's real shape.
  // missionCount/agentCount stay the un-widened `0` placeholder (fix-cert-rest, item 1: gated by
  // `hasMeasuredProjectDetail` at the view layer instead, since their type still cannot express
  // "unmeasured" directly).
  const otherProject = real<Project>({
    id: 'proj-other',
    name: 'Other Project',
    description: '',
    type: 'unknown',
    status: 'waiting',
    lastActivity: '',
    path: '/workspace/proj-other',
    templateVersion: '',
    pinned: false,
    conversationCount: 0,
    missionCount: 0,
    taskCount: null,
    agentCount: 0,
    skills: [],
    health: { tests: { passed: 0, failed: 0, skipped: 0 }, openTickets: 0, blockers: 0, score: null },
  });

  const agent = real<Agent>({
    id: 'build-boss',
    name: 'build-boss',
    role: 'Build Boss',
    group: 'execution',
    permission: 'standard',
    status: 'running',
    progress: 67,
    currentTask: 'Implement the fix',
    runtimeModel: '',
    toolModel: '',
    effort: 'medium',
    skills: [],
    lastActivity: '',
    verification: 'not-required',
    summary: '',
  });

  const run = real<Run>({
    id: 'run-1',
    projectId: 'proj-active',
    goal: 'Ship the fix',
    status: 'running',
    startedAt: '2026-07-29T00:00:00.000Z',
    duration: '4 min',
    workPackageIds: [],
    agentIds: ['build-boss'],
  });

  const lane = real<GraphLane>({ id: 'lane-1', label: 'build-boss', group: 'execution' });
  const node = real<GraphNode>({
    id: 'node-1',
    label: 'Implement the fix',
    kind: 'step',
    status: 'running',
    col: 2,
    row: 0,
    laneId: 'lane-1',
    agent: 'build-boss',
  });
  const graph = real<MissionGraph>({ id: 'run-1::graph', runId: 'run-1', lanes: [lane], nodes: [node], edges: [] });

  const base = buildEmptyState();
  return {
    ...base,
    activeProjectId: 'proj-active',
    data: {
      ...base.data,
      projects: [activeProject, otherProject],
      runs: [run],
      agents: [agent],
      graph,
    },
  };
}

describe('populated production render — catches F1 and F3 together (fix-cert-fabrication)', () => {
  afterEach(() => cleanup());

  it('MissionControlView never describes a running agent\'s real progress as "example work" (F1)', () => {
    const state = buildTwoProjectRunningState();
    const { container } = renderProduction(createElement(MissionControlView), { state });
    const found = scanForbidden(collectRenderedText(container));
    expect(
      found,
      `MissionControlView rendered forbidden term(s) against a real running node: ${found.join(', ')}`,
    ).toEqual([]);
  });

  it('ProjectsView shows "—", never a fabricated "0", for a non-active project\'s taskCount/health (F3)', () => {
    const state = buildTwoProjectRunningState();
    const { container } = renderProduction(createElement(ProjectsView), { state });

    const rows = container.querySelectorAll('.fw-projects__item');
    expect(rows.length).toBe(2);

    const activeRow = container.querySelector('.fw-projects__item[data-active="true"]');
    const otherRow = [...rows].find((row) => row.getAttribute('data-active') !== 'true');
    expect(activeRow, 'active project row not found').toBeTruthy();
    expect(otherRow, 'non-active project row not found').toBeTruthy();

    // The active project's detail is real — it must still show the real numbers, not '—'.
    const activeTasks = activeRow!.querySelector('[title="Tasks"] .fg-machine');
    expect(activeTasks?.textContent).toBe('5');
    // The Meter renders a label span ("Health") ahead of the value span — assert the value alone.
    const activeHealthValue = activeRow!.querySelector('.fw-projects__health .fw-meter__value');
    expect(activeHealthValue?.textContent).toBe('80%');
    // fix-cert-rest (item 1): the active project's missionCount/agentCount are ALSO real — must
    // still show the real numbers, not '—'.
    const activeMissions = activeRow!.querySelector('[title="Missions"] .fg-machine');
    expect(activeMissions?.textContent).toBe('1');
    const activeAgents = activeRow!.querySelector('[title="Agents"] .fg-machine');
    expect(activeAgents?.textContent).toBe('1');

    // The non-active project's detail was never measured — it must read as absent, never "0".
    const otherTasks = otherRow!.querySelector('[title="Tasks"] .fg-machine');
    expect(otherTasks?.textContent).toBe('—');
    // a11y-new: this used to assert the exact string '—'. That broke the moment a visually-hidden
    // "Health: not measured" label was added for screen readers — a change that makes the output
    // MORE honest, not less. Asserting the incidental rendered string is the same trap this run
    // found three times in the anti-fabrication tests, so the assertion now states the CONTRACT and
    // is strictly stronger than before: an absence marker must be present, AND no fabricated
    // measurement may appear. `0` and `%` would both be a claim about health that was never taken.
    const otherHealth = otherRow!.querySelector('.fw-projects__health');
    const otherHealthText = otherHealth?.textContent ?? '';
    expect(otherHealthText).toContain('—');
    expect(otherHealthText).not.toMatch(/\d/);
    expect(otherHealthText).not.toContain('%');
    // fix-cert-rest (item 1): missionCount/agentCount are the SAME F3-class fabrication as
    // taskCount/health above — the non-active project's 0s must read as absent, never "0".
    const otherMissions = otherRow!.querySelector('[title="Missions"] .fg-machine');
    expect(otherMissions?.textContent).toBe('—');
    const otherAgents = otherRow!.querySelector('[title="Agents"] .fg-machine');
    expect(otherAgents?.textContent).toBe('—');
  });
});

/* ========================================================================== */
/*  3c. AgentsView never renders "NOT REQUIRED" for an honest absence of      */
/*      verification evidence (fix-cert-rest, item 2)                        */
/* ========================================================================== */

/**
 * `verification: null` (an honest "no evidence exists for this agent in this run") must render as
 * absent, never as `'not-required'`'s "NOT REQUIRED" claim about the agent's role — the exact
 * conflation fix-cert-rest's item 2 closes. A real (non-fixture) two-agent state, one with a real
 * verdict and one without, reaches both `VerificationChip` branches at once.
 */
describe('AgentsView never renders "NOT REQUIRED" for a null (unmeasured) verification (fix-cert-rest, item 2)', () => {
  afterEach(() => cleanup());

  it('a verified agent keeps its real chip; an agent with no verdict shows an absent chip, never "NOT REQUIRED"', () => {
    const verifiedAgent = real<Agent>({
      id: 'build-boss',
      name: 'build-boss',
      role: 'Build Boss',
      group: 'execution',
      permission: 'standard',
      status: 'completed',
      progress: 100,
      currentTask: null,
      runtimeModel: '',
      toolModel: '',
      effort: 'medium',
      skills: [],
      lastActivity: '',
      verification: 'verified',
      summary: '',
    });
    const unmeasuredAgent = real<Agent>({
      id: 'docs-boss',
      name: 'docs-boss',
      role: 'Documentation & handoff',
      group: 'memory',
      permission: 'standard',
      status: 'waiting',
      progress: 0,
      currentTask: null,
      runtimeModel: '',
      toolModel: '',
      effort: 'medium',
      skills: [],
      lastActivity: '',
      verification: null,
      summary: '',
    });
    const state = { ...buildEmptyState(), data: { ...buildEmptyState().data, agents: [verifiedAgent, unmeasuredAgent] } };
    const { container } = renderProduction(createElement(AgentsView), { state });

    const found = scanForbidden(collectRenderedText(container));
    expect(found, `AgentsView rendered forbidden term(s): ${found.join(', ')}`).toEqual([]);

    const verifiedChip = container.querySelector('[data-verification="verified"]');
    expect(verifiedChip?.textContent).toContain('VERIFIED');

    const unmeasuredChip = container.querySelector('[data-verification="unknown"]');
    expect(unmeasuredChip, 'expected an absent-verification chip for the null agent').toBeTruthy();
    expect(unmeasuredChip?.textContent).not.toContain('NOT REQUIRED');

    // The literal claim this fix removes must never appear anywhere in the rendered DOM.
    expect(container.textContent).not.toContain('NOT REQUIRED');
  });
});

/* ========================================================================== */
/*  4. Shell chrome + Settings — fix-shell's work package                     */
/* ========================================================================== */

/**
 * Sidebar/Topbar/Dock/Inspector/ConnectionBanner/CommandPalette/SettingsView
 * read `useGatewayConnection()`/`useGatewayClaudeCodeHealth()` directly
 * (`gateway-adapter.ts`'s module-level polling singleton), not through a
 * swappable React Context the way `ChatView`/`FilesView` do above — there is
 * no context seam to stub for this subset. To keep section 2's "never touch a
 * live gateway" guarantee for these components too, `global.fetch` is stubbed
 * instead of the process being skipped: `gwGet`/`gwPost` (`gateway-client.ts`)
 * never throw on a failed/mocked fetch — they resolve to a typed
 * `{ok:false}`/`{ok:true,data}`, the exact same honest-failure shape a real
 * disconnected gateway would produce — so this still exercises the REAL
 * production code paths (the real `PrototypeProvider`, the real `AppShell`),
 * just against a fetch double instead of a live process on :4100.
 */

import { beforeEach, vi } from 'vitest';
import { act, fireEvent, screen, within } from '@testing-library/react';
import AppShell from '@/components/shell/AppShell';
import { PrototypeProvider } from '@/prototype/PrototypeProvider';
import SettingsView from '@/views/settings/SettingsView';

/**
 * Real, accurate strings that happen to contain a forbidden substring —
 * `forge.prototype.appearance` / `forge.prototype.density` are the REAL
 * localStorage key names `prototype-store.ts` persists under (unrenamed; out
 * of this work package's scope); `Focusable input example` is
 * `ThemeShowcaseView`'s own real `aria-label` for its keyboard focus-ring demo
 * input (an honest description of a design-system SPECIMEN, not fabricated
 * task/project data — see that view's own coverage test, above, for the full
 * reasoning; out of THIS fix round's write scope). Renaming/hiding any of
 * these would either fabricate a key/label that does not exist, or break the
 * page's own disclosure. Exact-match only, never a prefix/suffix escape hatch
 * — every other match is a real finding.
 */
const ALLOWED_EXACT_STRINGS: ReadonlySet<string> = new Set([
  'forge.prototype.appearance',
  'forge.prototype.density',
  'Focusable input example',
]);

/**
 * Same contract as `scanForbidden`, minus the two allowlisted exact strings.
 * `collectRenderedText` returns one joined blob (`container.textContent` is
 * itself already a single string with no natural separators around a given
 * substring), so the allowlist is applied as a literal substring strip —
 * removing exactly these two known-real key names before the pattern scan
 * runs, never a broader/fuzzy exclusion that could mask a real finding.
 */
function scanForbiddenAllowlisted(text: string): string[] {
  let sanitized = text;
  for (const allowed of ALLOWED_EXACT_STRINGS) {
    sanitized = sanitized.split(allowed).join('');
  }
  return scanForbidden(sanitized);
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

/** One seeded real-shaped project row so Sidebar/Inspector exercise a
 *  populated state too, not only the empty one. Every other route answers
 *  `{}` (parsed defensively to empty collections by gateway-client.ts's
 *  pick* helpers). */
const FAKE_PROJECT_ROW = { name: 'demo-project', path: '/workspace/demo-project', has_dashboard: false };

function installFetchMock(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/api/projects')) return jsonResponse({ projects: [FAKE_PROJECT_ROW] });
      return jsonResponse({});
    }),
  );
}

function renderShell(ui: ReactElement) {
  return render(
    createElement(MemoryRouter, null, createElement(PrototypeProvider, null, createElement(AppShell, null, ui))),
  );
}

/** Lets the gateway hooks' first (mocked, near-instant) fetch round-trip
 *  resolve and commit before assertions run. */
async function flush(ms = 30): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

describe('shell chrome + Settings — no forbidden copy in a real production mount', () => {
  beforeEach(() => {
    installFetchMock();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders the default shell (Sidebar, Topbar, Dock rail, Settings) cleanly', async () => {
    renderShell(createElement(SettingsView));
    await flush();
    const found = scanForbiddenAllowlisted(collectRenderedText(document.body));
    expect(found, `shell rendered forbidden term(s): ${found.join(', ')}`).toEqual([]);
  });

  it('shows no forbidden copy in any Settings section', async () => {
    renderShell(createElement(SettingsView));
    await flush();

    // Scoped to the Settings section nav — Sidebar's own primary nav also
    // renders an "Agents" link, so an unscoped getByText('Agents') is ambiguous.
    const settingsNav = screen.getByRole('navigation', { name: 'Settings sections' });

    const sectionLabels = [
      'Appearance',
      'Layout',
      'Chat preferences',
      'Claude Code connection',
      'Models',
      'Forge settings',
      'Agents',
      'Skills',
      'Permissions',
      'Data and privacy',
      'Keyboard shortcuts',
    ];
    for (const label of sectionLabels) {
      fireEvent.click(within(settingsNav).getByText(label));
      const found = scanForbiddenAllowlisted(collectRenderedText(document.body));
      expect(found, `Settings/${label} rendered forbidden term(s): ${found.join(', ')}`).toEqual([]);
    }
  });

  it('shows no forbidden copy in any Dock tab once opened', async () => {
    renderShell(createElement(SettingsView));
    await flush();

    fireEvent.click(screen.getByRole('button', { name: /Show dock/i }));
    const tabNames = ['Activity', 'Terminal', 'Tests', 'Events', 'Proof', 'Notices'];
    const tabs = screen.getAllByRole('tab');
    for (const name of tabNames) {
      const tab = tabs.find((candidate) => (candidate.textContent ?? '').startsWith(name));
      expect(tab, `dock tab not found: ${name}`).toBeTruthy();
      fireEvent.click(tab as HTMLElement);
      const found = scanForbiddenAllowlisted(collectRenderedText(document.body));
      expect(found, `Dock/${name} rendered forbidden term(s): ${found.join(', ')}`).toEqual([]);
    }
  });

  it('shows no forbidden copy in the Inspector once opened', async () => {
    renderShell(createElement(SettingsView));
    await flush();

    fireEvent.click(screen.getByRole('button', { name: /Show inspector/i }));
    await flush();
    const found = scanForbiddenAllowlisted(collectRenderedText(document.body));
    expect(found, `Inspector rendered forbidden term(s): ${found.join(', ')}`).toEqual([]);
  });

  it('shows no forbidden copy in the command palette', async () => {
    renderShell(createElement(SettingsView));
    await flush();

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    await screen.findByRole('dialog', { name: /Command palette/i });
    const found = scanForbiddenAllowlisted(collectRenderedText(document.body));
    expect(found, `CommandPalette rendered forbidden term(s): ${found.join(', ')}`).toEqual([]);
  });

  it('shows no forbidden copy in the account popover, and no "Prototype user" identity', async () => {
    renderShell(createElement(SettingsView));
    await flush();

    fireEvent.click(screen.getByRole('button', { name: 'Account and preferences' }));
    await screen.findByRole('dialog', { name: /Account and preferences/i });
    const found = scanForbiddenAllowlisted(collectRenderedText(document.body));
    expect(found, `account popover rendered forbidden term(s): ${found.join(', ')}`).toEqual([]);
    expect(screen.queryByText(/Prototype user/i)).toBeNull();
  });

  // build-newproject: this assertion used to pin the OPPOSITE state — button disabled, title
  // "no gateway route exists". That was honest then; the route exists now (POST /api/projects,
  // owner-approved), so the same honesty contract flips: the button must be ENABLED and must no
  // longer carry the stale excuse. A test asserting yesterday's reality is the same defect as
  // copy describing yesterday's backend.
  it('enables "New project" for real (the route exists now) and keeps the project menu to Open + Pin only', async () => {
    renderShell(createElement(SettingsView));
    await flush();

    const newProjectButtons = screen.getAllByRole('button', { name: 'New project' });
    expect(newProjectButtons.length).toBeGreaterThan(0);
    for (const button of newProjectButtons) {
      expect(button).not.toBeDisabled();
      expect(button.getAttribute('title') ?? '').not.toMatch(/no gateway route exists/i);
    }

    const moreButton = await screen.findByRole('button', { name: /More actions for demo-project/i });
    fireEvent.click(moreButton);
    const menu = await screen.findByRole('menu');
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((item) => item.textContent?.trim())).toEqual(['Open', 'Pin']);
    const found = scanForbiddenAllowlisted(collectRenderedText(document.body));
    expect(found, `project menu rendered forbidden term(s): ${found.join(', ')}`).toEqual([]);
  });
});
