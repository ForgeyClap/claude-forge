/**
 * Forge Workspace — prototype store.
 *
 * A plain reducer over the workspace's UI/preference state plus a `data` field of
 * view-facing records. No network, no persistence beyond a few UI preferences in
 * localStorage, no side effects that leave the tab — the reducer itself is pure.
 *
 * WHERE `state.data` COMES FROM is decided one level up, in `PrototypeProvider`:
 *
 *   - PRODUCTION (the default): `data` is fed from the shared LIVE store — real
 *     records folded from the bridge's event log, mapped to these view shapes by
 *     `state/store-adapter.ts`. The reducer never mutates `data`; it only manages
 *     UI state (selection, layout, toasts, the local chat reveal), so the live
 *     data can be spliced in from outside without fighting the reducer.
 *   - FIXTURES (opt-in only): `data` is the example dataset, and the selectors
 *     below run over it exactly as they always have. This is the path the unit
 *     tests exercise.
 *
 * The selectors are generic over `PrototypeState`, so a view cannot tell which
 * dataset it is reading — only whether the records it receives are real.
 */

import { createContext, useContext } from 'react';
import type {
  ActivityEvent,
  Agent,
  AgentLayout,
  Appearance,
  Artifact,
  ClaudeCodeLinkState,
  Conversation,
  Density,
  FileNode,
  MissionGraph,
  Project,
  ProofEntry,
  QualityGate,
  Run,
  StatusKey,
  Task,
  TaskColumn,
  TaskLayout,
  WorkPackage,
} from '../types/prototype-types';

/* ------------------------------------------------------------- selection */

/** What the right-hand inspector is currently describing. */
export type Selection =
  | { readonly kind: 'none' }
  | { readonly kind: 'project'; readonly id: string }
  | { readonly kind: 'conversation'; readonly id: string }
  | { readonly kind: 'agent'; readonly id: string }
  | { readonly kind: 'task'; readonly id: string }
  | { readonly kind: 'graph-node'; readonly id: string }
  | { readonly kind: 'artifact'; readonly id: string }
  | { readonly kind: 'gate'; readonly id: string }
  | { readonly kind: 'proof'; readonly id: string }
  | { readonly kind: 'file'; readonly id: string }
  | { readonly kind: 'event'; readonly id: string };

export type DockTab = 'activity' | 'terminal' | 'tests' | 'events' | 'proof' | 'notices';

export interface Toast {
  readonly id: string;
  readonly title: string;
  readonly detail?: string;
  readonly icon?: string;
}

/** A message being "typed" by the local simulator. Never a network stream. */
export interface StreamState {
  readonly conversationId: string;
  readonly messageId: string;
  /** Characters revealed so far of the target body. */
  readonly revealed: number;
  readonly target: string;
  readonly done: boolean;
}

/* ---------------------------------------------------------------- dataset */

/** The complete example dataset. Assembled once, then read-only. */
export interface PrototypeDataset {
  readonly projects: readonly Project[];
  readonly conversations: readonly Conversation[];
  readonly agents: readonly Agent[];
  readonly tasks: readonly Task[];
  readonly workPackages: readonly WorkPackage[];
  readonly runs: readonly Run[];
  readonly events: readonly ActivityEvent[];
  readonly artifacts: readonly Artifact[];
  readonly gates: readonly QualityGate[];
  readonly proof: readonly ProofEntry[];
  readonly files: readonly FileNode[];
  readonly graph: MissionGraph;
}

/* ------------------------------------------------------------------ state */

export interface PrototypeState {
  readonly data: PrototypeDataset;

  // appearance
  readonly appearance: Appearance;
  readonly resolvedTheme: 'dark' | 'light';
  readonly density: Density;
  readonly reducedMotion: boolean;

  // shell
  readonly sidebarCollapsed: boolean;
  readonly mobileDrawerOpen: boolean;
  readonly inspectorOpen: boolean;
  readonly dockOpen: boolean;
  readonly dockTab: DockTab;
  readonly paletteOpen: boolean;

  // navigation / selection
  readonly activeProjectId: string;
  readonly activeConversationId: string;
  readonly selection: Selection;

  // local overrides (never written back to any real registry)
  readonly pinnedProjectIds: readonly string[];
  readonly projectQuery: string;
  readonly agentFilter: StatusKey | 'all';
  readonly agentLayout: AgentLayout;
  readonly taskLayout: TaskLayout;
  /** Local drag-and-drop overrides: taskId -> column. Visual only. */
  readonly taskColumnOverrides: Readonly<Record<string, TaskColumn>>;

  // chat simulation
  readonly extraMessages: Readonly<Record<string, readonly import('../types/prototype-types').ChatMessage[]>>;
  readonly stream: StreamState | null;

  // presentation-only link fixture
  readonly claudeCodeState: ClaudeCodeLinkState;

  readonly toasts: readonly Toast[];
}

/* ---------------------------------------------------------------- actions */

export type PrototypeAction =
  | { type: 'appearance/set'; appearance: Appearance }
  | { type: 'appearance/system-changed'; resolved: 'dark' | 'light' }
  | { type: 'density/set'; density: Density }
  | { type: 'motion/set'; reduced: boolean }
  | { type: 'sidebar/toggle' }
  | { type: 'sidebar/set'; collapsed: boolean }
  | { type: 'drawer/set'; open: boolean }
  | { type: 'inspector/toggle' }
  | { type: 'inspector/set'; open: boolean }
  | { type: 'dock/toggle' }
  | { type: 'dock/set'; open: boolean }
  | { type: 'dock/tab'; tab: DockTab }
  | { type: 'palette/set'; open: boolean }
  | { type: 'project/activate'; id: string }
  | { type: 'project/pin-toggle'; id: string }
  | { type: 'project/query'; query: string }
  | { type: 'conversation/activate'; id: string }
  | { type: 'select'; selection: Selection }
  | { type: 'agents/filter'; filter: StatusKey | 'all' }
  | { type: 'agents/layout'; layout: AgentLayout }
  | { type: 'tasks/layout'; layout: TaskLayout }
  | { type: 'tasks/move'; taskId: string; column: TaskColumn }
  | { type: 'chat/send'; conversationId: string; body: string }
  | { type: 'chat/stream-tick'; revealed: number }
  | { type: 'chat/stream-stop' }
  | { type: 'claude-code/set'; state: ClaudeCodeLinkState }
  | { type: 'toast/push'; toast: Toast }
  | { type: 'toast/dismiss'; id: string };

/* ---------------------------------------------------------------- storage */

const STORAGE_KEY = 'forge.prototype.appearance';
const DENSITY_KEY = 'forge.prototype.density';

export function readStoredAppearance(): Appearance {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === 'dark' || raw === 'light' || raw === 'system' ? raw : 'system';
  } catch {
    return 'system';
  }
}

export function readStoredDensity(): Density {
  try {
    return localStorage.getItem(DENSITY_KEY) === 'compact' ? 'compact' : 'comfortable';
  } catch {
    return 'comfortable';
  }
}

function persist(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Private mode or storage disabled — preferences simply do not persist. */
  }
}

export function systemTheme(): 'dark' | 'light' {
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function resolveTheme(appearance: Appearance): 'dark' | 'light' {
  return appearance === 'system' ? systemTheme() : appearance;
}

/* ---------------------------------------------------------------- reducer */

let toastSeq = 0;
export function nextToastId(): string {
  toastSeq += 1;
  return `toast-${toastSeq}`;
}

let messageSeq = 0;
function nextMessageId(): string {
  messageSeq += 1;
  return `msg-local-${messageSeq}`;
}

export function reducer(state: PrototypeState, action: PrototypeAction): PrototypeState {
  switch (action.type) {
    case 'appearance/set':
      persist(STORAGE_KEY, action.appearance);
      return { ...state, appearance: action.appearance, resolvedTheme: resolveTheme(action.appearance) };

    case 'appearance/system-changed':
      return state.appearance === 'system' ? { ...state, resolvedTheme: action.resolved } : state;

    case 'density/set':
      persist(DENSITY_KEY, action.density);
      return { ...state, density: action.density };

    case 'motion/set':
      return { ...state, reducedMotion: action.reduced };

    case 'sidebar/toggle':
      return { ...state, sidebarCollapsed: !state.sidebarCollapsed };

    case 'sidebar/set':
      return { ...state, sidebarCollapsed: action.collapsed };

    case 'drawer/set':
      return { ...state, mobileDrawerOpen: action.open };

    case 'inspector/toggle':
      return { ...state, inspectorOpen: !state.inspectorOpen };

    case 'inspector/set':
      return { ...state, inspectorOpen: action.open };

    case 'dock/toggle':
      return { ...state, dockOpen: !state.dockOpen };

    case 'dock/set':
      return { ...state, dockOpen: action.open };

    case 'dock/tab':
      return { ...state, dockTab: action.tab, dockOpen: true };

    case 'palette/set':
      return { ...state, paletteOpen: action.open };

    case 'project/activate':
      return { ...state, activeProjectId: action.id, selection: { kind: 'project', id: action.id } };

    case 'project/pin-toggle': {
      const pinned = state.pinnedProjectIds.includes(action.id)
        ? state.pinnedProjectIds.filter((id) => id !== action.id)
        : [...state.pinnedProjectIds, action.id];
      return { ...state, pinnedProjectIds: pinned };
    }

    case 'project/query':
      return { ...state, projectQuery: action.query };

    case 'conversation/activate':
      return {
        ...state,
        activeConversationId: action.id,
        selection: { kind: 'conversation', id: action.id },
      };

    case 'select':
      return {
        ...state,
        selection: action.selection,
        inspectorOpen: action.selection.kind === 'none' ? state.inspectorOpen : true,
      };

    case 'agents/filter':
      return { ...state, agentFilter: action.filter };

    case 'agents/layout':
      return { ...state, agentLayout: action.layout };

    case 'tasks/layout':
      return { ...state, taskLayout: action.layout };

    case 'tasks/move':
      return {
        ...state,
        taskColumnOverrides: { ...state.taskColumnOverrides, [action.taskId]: action.column },
      };

    case 'chat/send': {
      const userMessage = {
        prototype: true as const,
        id: nextMessageId(),
        author: 'user' as const,
        body: action.body,
        timestamp: 'just now',
      };
      const replyId = nextMessageId();
      const reply = {
        prototype: true as const,
        id: replyId,
        author: 'forge' as const,
        body: '',
        timestamp: 'just now',
        model: 'example-runtime · local',
      };
      const existing = state.extraMessages[action.conversationId] ?? [];
      return {
        ...state,
        extraMessages: {
          ...state.extraMessages,
          [action.conversationId]: [...existing, userMessage, reply],
        },
        stream: {
          conversationId: action.conversationId,
          messageId: replyId,
          revealed: 0,
          target: SIMULATED_REPLY,
          done: false,
        },
      };
    }

    case 'chat/stream-tick': {
      if (!state.stream) return state;
      const revealed = Math.min(action.revealed, state.stream.target.length);
      const done = revealed >= state.stream.target.length;
      const list = state.extraMessages[state.stream.conversationId] ?? [];
      return {
        ...state,
        stream: { ...state.stream, revealed, done },
        extraMessages: {
          ...state.extraMessages,
          [state.stream.conversationId]: list.map((m) =>
            m.id === state.stream!.messageId ? { ...m, body: state.stream!.target.slice(0, revealed) } : m,
          ),
        },
      };
    }

    case 'chat/stream-stop': {
      if (!state.stream) return state;
      return { ...state, stream: { ...state.stream, done: true } };
    }

    case 'claude-code/set':
      return { ...state, claudeCodeState: action.state };

    case 'toast/push':
      return { ...state, toasts: [...state.toasts, action.toast].slice(-4) };

    case 'toast/dismiss':
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) };

    default:
      return state;
  }
}

/**
 * The canned reply the composer "streams". Written once here so the chat view
 * stays free of content, and so it is obvious there is no generation involved.
 */
export const SIMULATED_REPLY = `Understood. Here is how Forge would approach that.

**Proposed mission** — I would open an intake round first, then split the work across a small team rather than one large pass.

| Work package | Owner | Focus |
| --- | --- | --- |
| WP1 | Search Boss | Reference gathering and competitor scan |
| WP2 | UI Boss | Layout, type scale, responsive behaviour |
| WP3 | Build Boss | Implementation against the agreed structure |
| WP4 | Test Boss | Browser tests and screenshot review |

Verification runs after every work package — the Verify Agent rejects a claim that arrives without evidence, and Head Chef reopens the task rather than letting it pass.

\`\`\`bash
# example only — nothing is executed in this prototype
forge run --mission "booking site" --verify strict
\`\`\`

This response is local example text. Nothing was generated, and no session was contacted.`;

/* ------------------------------------------------------------------ context */

export interface StoreValue {
  readonly state: PrototypeState;
  readonly dispatch: React.Dispatch<PrototypeAction>;
}

export const PrototypeContext = createContext<StoreValue | null>(null);

export function usePrototype(): StoreValue {
  const value = useContext(PrototypeContext);
  if (!value) throw new Error('usePrototype must be used inside <PrototypeProvider>.');
  return value;
}

/* ---------------------------------------------------------------- selectors */

export function selectProject(state: PrototypeState, id: string): Project | undefined {
  return state.data.projects.find((p) => p.id === id);
}

export function selectActiveProject(state: PrototypeState): Project | undefined {
  return selectProject(state, state.activeProjectId);
}

export function selectAgent(state: PrototypeState, id: string): Agent | undefined {
  return state.data.agents.find((a) => a.id === id);
}

export function selectTask(state: PrototypeState, id: string): Task | undefined {
  return state.data.tasks.find((t) => t.id === id);
}

/** Applies local pin overrides on top of the example data. */
export function selectIsPinned(state: PrototypeState, id: string): boolean {
  const base = selectProject(state, id)?.pinned ?? false;
  const toggled = state.pinnedProjectIds.includes(id);
  return toggled ? !base : base;
}

export function selectFilteredProjects(state: PrototypeState): readonly Project[] {
  const q = state.projectQuery.trim().toLowerCase();
  if (!q) return state.data.projects;
  return state.data.projects.filter(
    (p) =>
      p.name.toLowerCase().includes(q) ||
      p.description.toLowerCase().includes(q) ||
      p.type.toLowerCase().includes(q),
  );
}

export function selectFilteredAgents(state: PrototypeState): readonly Agent[] {
  return state.agentFilter === 'all'
    ? state.data.agents
    : state.data.agents.filter((a) => a.status === state.agentFilter);
}

/** Task column with the local drag-and-drop override applied. */
export function selectTaskColumn(state: PrototypeState, task: Task): TaskColumn {
  return state.taskColumnOverrides[task.id] ?? task.column;
}

export function selectConversation(state: PrototypeState, id: string): Conversation | undefined {
  return state.data.conversations.find((c) => c.id === id);
}

/** Base messages plus anything the local composer appended this session. */
export function selectMessages(
  state: PrototypeState,
  conversationId: string,
): readonly import('../types/prototype-types').ChatMessage[] {
  const base = selectConversation(state, conversationId)?.messages ?? [];
  const extra = state.extraMessages[conversationId] ?? [];
  return [...base, ...extra];
}

export function selectProjectConversations(state: PrototypeState, projectId: string): readonly Conversation[] {
  return state.data.conversations.filter((c) => c.projectId === projectId);
}
