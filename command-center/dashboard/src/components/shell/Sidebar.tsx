/**
 * Forge Workspace — the sidebar.
 *
 * Wordmark, the two creation actions, a search field that filters the lists
 * live, the primary destinations, then the three project/conversation sections.
 *
 * A row can open a project or pin/unpin it — both real. "New chat" drives a
 * real `POST /api/conversations` (see ./gateway-actions); "New project" opens
 * `NewProjectDialog`, which drives the real `POST /api/projects` (build-newproject).
 *
 * The nav model itself lives in ./nav-config, because the topbar reads the same
 * table to title the current view — and because a module that exports both a
 * component and a constant cannot be hot-reloaded.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
} from 'react';
import { NavLink, useNavigate } from 'react-router-dom';

import { Button, Eyebrow, Icon, IconButton, Machine, StatusDot } from '@/components/primitives';
import {
  nextToastId,
  selectFilteredProjects,
  selectIsPinned,
  usePrototype,
} from '@/prototype/state/prototype-store';
import type { Conversation, Project, ProjectType } from '@/prototype/types/prototype-types';

import { pollProjectInstall, requestNewConversation } from './gateway-actions';
import { ConfirmDeleteConversationDialog } from './ConfirmDeleteConversationDialog';
import { NewProjectDialog } from './NewProjectDialog';
import { PRIMARY_NAV, SECONDARY_NAV } from './nav-config';
import type { ShellNavItem } from './nav-config';
import { isProductionMode } from '@/config/mode';
// WP7b: the real gateway connection, not the intentionally-unused bridge one —
// see `gateway-adapter.ts`'s header. Same `ConnectionState` shape.
import { useGatewayConnection as useConnection } from '@/prototype/state/gateway-adapter';
import type { ConnectionStatus } from '@/prototype/state/bridge-client';
import './sidebar.css';

/* ---------------------------------------------------------------- icons */

const PROJECT_TYPE_ICON: Readonly<Record<ProjectType, string>> = {
  website: 'Globe',
  'full-stack': 'Layers',
  automation: 'Workflow',
  chatbot: 'Bot',
  scraping: 'Radar',
  prediction: 'Gauge',
  integration: 'Blocks',
  research: 'FlaskConical',
  // A project whose FORGE_PROJECT_PROFILE.md states no type Forge recognises. The dashed circle
  // is this app's existing "not determined yet" mark (TestsView uses it for pending) — deliberately
  // not one of the eight real type icons, so an unclassified project can never be mistaken on
  // sight for a classified one.
  unknown: 'CircleDashed',
};

/* --------------------------------------------------------- prototype state */

/*
 * The line at the foot of the sidebar. It is a placeholder for the real
 * connection indicator and is deliberately wired to nothing: three fixed
 * strings, read once, derived from no state and checked against no runtime.
 *
 * When a real indicator arrives, this object is the whole swap — the icon, the
 * short label and the long sentence become live values and the markup below
 * does not move. The short label is what fits on one line in a 264px sidebar;
 * the long sentence is the title, so the full statement survives any width.
 */
/** Fixture mode: the honest label for a workspace showing example data. */
const FOOT_STATE = {
  icon: 'Unplug',
  label: 'EXAMPLE · NOT CONNECTED',
  title: 'Visual prototype · example data · not connected to Forge, Claude Code or any API.',
} as const;

/** The moment the author anticipated: a real indicator, derived from the live
 * bridge connection. One swap, the markup does not move. */
function connectedFootState(status: ConnectionStatus): { icon: string; label: string; title: string } {
  switch (status) {
    case 'CONNECTED':
      return { icon: 'PlugZap', label: 'CONNECTED', title: 'Connected to the local Forge gateway on this machine.' };
    case 'CONNECTING':
      return { icon: 'Loader', label: 'CONNECTING…', title: 'Connecting to the local Forge gateway.' };
    case 'DEGRADED':
      return {
        icon: 'TriangleAlert',
        label: 'DEGRADED',
        title: 'Connected, but reconciling a gap in the event stream. State will catch up.',
      };
    case 'DISCONNECTED':
    default:
      return {
        icon: 'Unplug',
        label: 'DISCONNECTED',
        title: 'Not reaching the local Forge gateway. Start it on localhost, then it reconnects.',
      };
  }
}

/* ------------------------------------------------------------- the mark */

/**
 * The Forge mark: an anvil struck by a spark, drawn as flat geometry in
 * currentColor. Original to this prototype — no third-party mark is referenced.
 */
function ForgeMark() {
  return (
    <svg className="fw-mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {/* face and horn */}
      <path
        fill="currentColor"
        d="M3.2 7.1h14.2l4 1.6-4 1.6H3.2a.7.7 0 0 1-.7-.7V7.8a.7.7 0 0 1 .7-.7Z"
      />
      {/* waist */}
      <path fill="currentColor" d="M9.5 11.3h5l-1.2 4.6h-2.6z" />
      {/* base */}
      <rect fill="currentColor" x="6" y="16.2" width="12" height="3" rx="0.8" />
      {/* spark */}
      <path
        fill="currentColor"
        opacity="0.8"
        d="M19.6 2.1l.72 1.95 1.95.72-1.95.72-.72 1.95-.72-1.95-1.95-.72 1.95-.72z"
      />
    </svg>
  );
}

/* --------------------------------------------------------- context menu */

interface MenuState {
  readonly projectId: string;
  readonly x: number;
  readonly y: number;
}

interface ProjectMenuProps {
  readonly project: Project;
  readonly pinned: boolean;
  readonly x: number;
  readonly y: number;
  readonly onClose: () => void;
  readonly onAction: (action: string, project: Project) => void;
}

const MENU_ACTIONS: readonly { readonly id: string; readonly label: string; readonly icon: string }[] = [
  { id: 'open', label: 'Open', icon: 'FolderOpen' },
  { id: 'pin', label: 'Pin', icon: 'Pin' },
];

/*
 * The popover is position:fixed, so its geometry has to be known to the script
 * that places it as well as to the stylesheet that paints it. These four numbers
 * are that geometry, declared once: MENU_WIDTH is handed to CSS as --fw-menu-w
 * rather than repeated there, so the width can never drift between the two.
 */

/** Popover width. Mirrored into sidebar.css as --fw-menu-w. */
const MENU_WIDTH = 180;
/** Height budget used only to keep the popover on screen — not a max-height. */
const MENU_HEIGHT = 210;
/** Smallest gap the popover may leave between itself and a viewport edge. */
const MENU_EDGE = 8;
/** Breathing room kept on the trailing edge before the popover is pulled back. */
const MENU_MARGIN = 16;
/** Gap between the trigger and the top of the popover. */
const MENU_OFFSET = 6;

/**
 * A small popover, positioned from the trigger's viewport rect so it can escape
 * the sidebar's own scroll container. Roving focus, Escape closes, Tab closes.
 */
function ProjectMenu({ project, pinned, x, y, onClose, onAction }: ProjectMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const items = ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    items?.[index]?.focus();
  }, [index]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [onClose]);

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setIndex((current) => (current + 1) % MENU_ACTIONS.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setIndex((current) => (current - 1 + MENU_ACTIONS.length) % MENU_ACTIONS.length);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setIndex(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setIndex(MENU_ACTIONS.length - 1);
    }
  }

  // Keep the popover inside the viewport without measuring twice.
  const top = Math.min(y, Math.max(MENU_EDGE, window.innerHeight - MENU_HEIGHT));
  const left = Math.min(x, Math.max(MENU_EDGE, window.innerWidth - MENU_WIDTH - MENU_MARGIN));

  const style = {
    top: `${top}px`,
    left: `${left}px`,
    '--fw-menu-w': `${MENU_WIDTH}px`,
  } as CSSProperties;

  return (
    <div
      ref={ref}
      className="fw-sidebar__menu"
      role="menu"
      aria-label={`Actions for ${project.name}`}
      style={style}
      onKeyDown={handleKeyDown}
    >
      <div className="fw-sidebar__menu-head">
        <Machine muted className="fw-sidebar__menu-id">
          {project.id}
        </Machine>
      </div>
      {MENU_ACTIONS.map((action) => (
        <button
          key={action.id}
          type="button"
          role="menuitem"
          tabIndex={-1}
          className="fw-sidebar__menu-item"
          onClick={() => onAction(action.id, project)}
        >
          <Icon
            name={action.id === 'pin' && pinned ? 'PinOff' : action.icon}
            size="sm"
            className="fw-sidebar__menu-icon"
          />
          <span>{action.id === 'pin' && pinned ? 'Unpin' : action.label}</span>
        </button>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- sidebar */

export default function Sidebar() {
  const { state, dispatch } = usePrototype();
  const navigate = useNavigate();

  // The foot indicator: the real gateway connection in production, the honest
  // example label in fixture mode. useConnection is safe in both — with no
  // gateway it simply reports DISCONNECTED.
  const connection = useConnection();
  const foot = isProductionMode() ? connectedFootState(connection.status) : FOOT_STATE;
  const searchRef = useRef<HTMLInputElement>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  // feat-delete-conversation: `deleteTarget` drives the confirm dialog; `hiddenConversationIds` is
  // a purely local, optimistic overlay — a real `DELETE` already succeeded server-side by the time
  // an id lands here (`ConfirmDeleteConversationDialog`'s own `onDeleted` contract), this just hides
  // the row immediately rather than waiting for the next 4s conversations poll to catch up.
  const [deleteTarget, setDeleteTarget] = useState<Conversation | null>(null);
  const [hiddenConversationIds, setHiddenConversationIds] = useState<ReadonlySet<string>>(new Set());

  const collapsed = state.sidebarCollapsed;
  const query = state.projectQuery;

  const toast = useCallback(
    (title: string, detail?: string, icon?: string) => {
      dispatch({ type: 'toast/push', toast: { id: nextToastId(), title, detail, icon } });
    },
    [dispatch],
  );

  const projects = selectFilteredProjects(state);

  const pinned = useMemo(
    () => projects.filter((project) => selectIsPinned(state, project.id)),
    [projects, state],
  );

  const recent = useMemo(() => {
    const unpinned = projects.filter((project) => !selectIsPinned(state, project.id));
    // fix-ui-clutter (item 6): `dir_mtime_ms` (the gateway's real project-directory mtime,
    // parsed via `?.` because it lands from a parallel, not-yet-merged gateway change — see
    // `ProjectRow.dirMtimeMs`'s own doc comment) is the one real recency signal a FRESHLY
    // created project has before it has any conversation/run activity of its own to sort by.
    // A project with no reading at all (`undefined`/`null`) sorts after every project that
    // does have one, rather than being pulled to either end by a fabricated timestamp — Array
    // sort is stable, so ties (including "both unknown") keep their original relative order.
    const sorted = [...unpinned].sort((a, b) => (b.dirMtimeMs ?? -Infinity) - (a.dirMtimeMs ?? -Infinity));
    return sorted.slice(0, 5);
  }, [projects, state]);

  const conversations = useMemo<readonly Conversation[]>(() => {
    const needle = query.trim().toLowerCase();
    const visible = state.data.conversations.filter((conversation) => !hiddenConversationIds.has(conversation.id));
    const list = needle
      ? visible.filter((conversation) => conversation.title.toLowerCase().includes(needle))
      : visible;
    return list.slice(0, 5);
  }, [state.data.conversations, query, hiddenConversationIds]);

  const projectById = useCallback(
    (id: string) => state.data.projects.find((project) => project.id === id),
    [state.data.projects],
  );

  /* -------------------------------------------------------- interactions */

  function openProject(project: Project) {
    dispatch({ type: 'project/activate', id: project.id });
    navigate('/project');
    dispatch({ type: 'drawer/set', open: false });
  }

  function openConversation(conversation: Conversation) {
    dispatch({ type: 'conversation/activate', id: conversation.id });
    dispatch({ type: 'project/activate', id: conversation.projectId });
    navigate('/chat');
    dispatch({ type: 'drawer/set', open: false });
  }

  function togglePin(project: Project) {
    const willPin = !selectIsPinned(state, project.id);
    dispatch({ type: 'project/pin-toggle', id: project.id });
    toast(
      willPin ? 'Pinned' : 'Unpinned',
      `${project.name} — local view preference only.`,
      willPin ? 'Pin' : 'PinOff',
    );
  }

  /** Starts a real conversation via `POST /api/conversations` and opens it. */
  const startNewChat = useCallback(async () => {
    const result = await requestNewConversation(state.activeProjectId);
    if (!result.ok || result.id === null) {
      toast('New chat failed', result.error ?? 'The gateway could not start a new chat.', 'TriangleAlert');
      return;
    }
    dispatch({ type: 'conversation/activate', id: result.id });
    navigate('/chat');
    dispatch({ type: 'drawer/set', open: false });
  }, [state.activeProjectId, dispatch, navigate, toast]);

  /**
   * Activates the just-created project (build-newproject) and opens it immediately — the gateway's
   * 201 no longer waits for the real Forge installer (build-async-install), so this toasts an honest
   * "installing" status right away, then polls `GET /api/projects/install-status` in the background
   * (`pollProjectInstall`, gateway-actions.ts) and toasts the REAL, terminal outcome exactly once —
   * never a fabricated "installed" when the installer actually failed, timed out, or never ran.
   */
  const handleProjectCreated = useCallback(
    (id: string) => {
      setNewProjectOpen(false);
      dispatch({ type: 'project/activate', id });
      navigate('/project');
      dispatch({ type: 'drawer/set', open: false });
      toast('Project created', 'Forge is being installed…', 'Loader');
      pollProjectInstall(id, (result) => {
        const installed = result.state === 'installed';
        toast(
          installed ? 'Forge installed' : 'Forge install failed',
          installed ? `Forge installed for ${id}.` : (result.reason ?? result.note ?? 'The Forge installer did not complete.'),
          installed ? 'CircleCheck' : 'TriangleAlert',
        );
      });
    },
    [dispatch, navigate, toast],
  );

  function handleMenuAction(action: string, project: Project) {
    setMenu(null);
    if (action === 'open') {
      openProject(project);
      return;
    }
    if (action === 'pin') {
      togglePin(project);
    }
  }

  function expandAndSearch() {
    dispatch({ type: 'sidebar/set', collapsed: false });
    window.setTimeout(() => searchRef.current?.focus(), 0);
  }

  /** Up/Down walk a nav list; Home/End jump. Tab still works normally. */
  function handleNavKeys(event: ReactKeyboardEvent<HTMLUListElement>) {
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    const links = Array.from(
      event.currentTarget.querySelectorAll<HTMLAnchorElement>('a.fw-nav__link'),
    );
    if (links.length === 0) return;
    const current = links.indexOf(document.activeElement as HTMLAnchorElement);
    let next = current;
    if (event.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % links.length;
    if (event.key === 'ArrowUp') next = current < 0 ? links.length - 1 : (current - 1 + links.length) % links.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = links.length - 1;
    event.preventDefault();
    links[next]?.focus();
  }

  const menuProject = menu ? projectById(menu.projectId) : undefined;

  /* -------------------------------------------------------------- render */

  function renderNav(items: readonly ShellNavItem[], label: string) {
    return (
      <nav className="fw-nav" aria-label={label}>
        <ul className="fw-nav__list" onKeyDown={handleNavKeys}>
          {items.map((item) => (
            <li key={item.path}>
              <NavLink
                to={item.path}
                end={item.path === '/'}
                className={({ isActive }) =>
                  isActive ? 'fw-nav__link is-active' : 'fw-nav__link'
                }
                title={collapsed ? `${item.label} — ${item.description}` : item.description}
                onClick={() => dispatch({ type: 'drawer/set', open: false })}
              >
                <Icon name={item.icon} size="sm" className="fw-nav__icon" />
                <span className="fw-sidebar__label">{item.label}</span>
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    );
  }

  function renderProjectRow(project: Project) {
    const isPinned = selectIsPinned(state, project.id);
    const isActive = project.id === state.activeProjectId;

    return (
      <li key={project.id} className="fw-prow" data-active={isActive ? 'true' : undefined}>
        <NavLink
          to="/project"
          className="fw-prow__main"
          title={`${project.name} — ${project.description.slice(0, 90)}…`}
          onClick={() => openProject(project)}
        >
          <Icon
            name={PROJECT_TYPE_ICON[project.type]}
            size="sm"
            className="fw-prow__icon"
          />
          <span className="fw-prow__text fw-sidebar__label">
            <span className="fw-prow__name fw-truncate">{project.name}</span>
            <Machine muted className="fw-prow__meta fw-truncate">
              {project.lastActivity}
            </Machine>
          </span>
        </NavLink>

        <span className="fw-prow__status fw-sidebar__label">
          <StatusDot status={project.status} />
        </span>

        <span className="fw-prow__tools fw-sidebar__label">
          <IconButton
            icon={isPinned ? 'PinOff' : 'Pin'}
            label={isPinned ? `Unpin ${project.name}` : `Pin ${project.name}`}
            size="sm"
            active={isPinned}
            onClick={() => togglePin(project)}
          />
          <IconButton
            icon="Ellipsis"
            label={`More actions for ${project.name}`}
            size="sm"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setMenu({
                projectId: project.id,
                x: rect.right - MENU_WIDTH,
                y: rect.bottom + MENU_OFFSET,
              });
            }}
          />
        </span>
      </li>
    );
  }

  function renderSection(title: string, count: number, children: ReactNode) {
    return (
      <section className="fw-sidebar__section">
        <div className="fw-sidebar__section-head fw-sidebar__label">
          <Eyebrow>{title}</Eyebrow>
          <Machine muted className="fw-sidebar__section-count">
            {count}
          </Machine>
        </div>
        {children}
      </section>
    );
  }

  return (
    <div className="fw-sidebar" data-collapsed={collapsed ? 'true' : 'false'}>
      {/* ------------------------------------------------------------ head */}
      <div className="fw-sidebar__head">
        <NavLink
          to="/"
          end
          className="fw-sidebar__brand"
          title="Forge Workspace"
          onClick={() => dispatch({ type: 'drawer/set', open: false })}
        >
          <span className="fw-sidebar__mark">
            <ForgeMark />
          </span>
          <span className="fw-sidebar__wordmark fw-sidebar__label">
            <span className="fw-sidebar__wordmark-name">FORGE</span>
            <span className="fw-sidebar__wordmark-sub fg-machine">WORKSPACE</span>
          </span>
        </NavLink>

        <span className="fw-sidebar__head-tools">
          <IconButton
            className="fw-sidebar__collapse"
            icon={collapsed ? 'ChevronsRight' : 'ChevronsLeft'}
            label={collapsed ? 'Expand from icon rail' : 'Collapse to icon rail'}
            title={
              collapsed
                ? 'Expand from icon rail (Ctrl + B)'
                : 'Collapse to icon rail (Ctrl + B)'
            }
            size="sm"
            onClick={() => dispatch({ type: 'sidebar/toggle' })}
          />
          <IconButton
            className="fw-sidebar__drawer-close"
            icon="X"
            label="Close drawer"
            size="sm"
            onClick={() => dispatch({ type: 'drawer/set', open: false })}
          />
        </span>
      </div>

      {/* --------------------------------------------------------- actions */}
      <div className="fw-sidebar__actions">
        <Button
          variant="primary"
          size="sm"
          icon="Plus"
          block
          className="fw-sidebar__action fw-sidebar__label"
          onClick={() => setNewProjectOpen(true)}
        >
          New project
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon="MessageSquarePlus"
          block
          className="fw-sidebar__action fw-sidebar__label"
          onClick={() => void startNewChat()}
        >
          New chat
        </Button>

        <span className="fw-sidebar__rail-actions">
          <IconButton
            icon="Plus"
            label="New project"
            size="sm"
            onClick={() => setNewProjectOpen(true)}
          />
          <IconButton
            icon="MessageSquarePlus"
            label="New chat"
            size="sm"
            onClick={() => void startNewChat()}
          />
          <IconButton icon="Search" label="Search projects" size="sm" onClick={expandAndSearch} />
        </span>
      </div>

      {/* ---------------------------------------------------------- search */}
      <div className="fw-sidebar__search fw-sidebar__label">
        <label className="fw-visually-hidden" htmlFor="fw-sidebar-search">
          Search projects and conversations
        </label>
        <span className="fw-sidebar__search-field">
          <Icon name="Search" size="sm" className="fw-sidebar__search-icon" />
          <input
            ref={searchRef}
            id="fw-sidebar-search"
            className="fw-sidebar__search-input"
            type="search"
            placeholder="Search projects…"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => dispatch({ type: 'project/query', query: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && query) {
                event.preventDefault();
                dispatch({ type: 'project/query', query: '' });
              }
            }}
          />
          {query ? (
            <IconButton
              icon="X"
              label="Clear search"
              size="sm"
              className="fw-sidebar__search-clear"
              onClick={() => {
                dispatch({ type: 'project/query', query: '' });
                searchRef.current?.focus();
              }}
            />
          ) : null}
        </span>
      </div>

      {/* ----------------------------------------------------------- lists */}
      <div className="fw-sidebar__scroll fw-scroll">
        {renderNav(PRIMARY_NAV, 'Primary')}

        <hr className="fw-divider fw-sidebar__rule" />

        {pinned.length > 0
          ? renderSection(
              'Pinned projects',
              pinned.length,
              <ul className="fw-sidebar__list">{pinned.map(renderProjectRow)}</ul>,
            )
          : null}

        {recent.length > 0
          ? renderSection(
              'Recent projects',
              recent.length,
              <ul className="fw-sidebar__list">{recent.map(renderProjectRow)}</ul>,
            )
          : null}

        {pinned.length === 0 && recent.length === 0 ? (
          <p className="fw-sidebar__none fw-sidebar__label">
            No project matches <Machine>{query}</Machine>.
          </p>
        ) : null}

        {conversations.length > 0
          ? renderSection(
              'Recent conversations',
              conversations.length,
              <ul className="fw-sidebar__list fw-sidebar__label">
                {conversations.map((conversation) => {
                  // fix-ui-clutter (item 3): title + project name, never the raw conversation id
                  // + a raw ISO timestamp — the id is still reachable, but only as a hover
                  // tooltip on the row.
                  const conversationProjectName = projectById(conversation.projectId)?.name ?? conversation.projectId;
                  return (
                    <li key={conversation.id} className="fw-crow">
                      <NavLink
                        to="/chat"
                        className={
                          conversation.id === state.activeConversationId
                            ? 'fw-crow__main is-active'
                            : 'fw-crow__main'
                        }
                        title={`${conversation.title} (${conversation.id})`}
                        onClick={() => openConversation(conversation)}
                      >
                        <Icon name="MessageSquare" size="sm" className="fw-crow__icon" />
                        <span className="fw-crow__text">
                          <span className="fw-crow__title fw-truncate">{conversation.title}</span>
                          <Machine muted className="fw-crow__meta fw-truncate">
                            {conversationProjectName} · {conversation.messageCount} msg
                          </Machine>
                        </span>
                      </NavLink>
                      <span className="fw-crow__tools fw-sidebar__label">
                        <IconButton
                          icon="Trash2"
                          label={`Delete ${conversation.title}`}
                          size="sm"
                          onClick={() => setDeleteTarget(conversation)}
                        />
                      </span>
                    </li>
                  );
                })}
              </ul>,
            )
          : null}

        <hr className="fw-divider fw-sidebar__rule fw-sidebar__label" />

        <div className="fw-sidebar__label">{renderNav(SECONDARY_NAV, 'More')}</div>
      </div>

      {/* ------------------------------------------------------------ foot */}
      {/*
        Icon plus UPPERCASE label, the same shape every other state in this
        workspace uses. The label carries fw-sidebar__label so the rail folds
        the words away and keeps the icon; the title stays on the row, so the
        full sentence is one hover away in either state.
      */}
      <div className="fw-sidebar__foot">
        <p className="fw-sidebar__foot-state" title={foot.title}>
          <Icon name={foot.icon} size="sm" className="fw-sidebar__foot-icon" />
          <Machine muted className="fw-sidebar__foot-text fw-sidebar__label fw-truncate">
            {foot.label}
          </Machine>
        </p>
      </div>

      {menu && menuProject ? (
        <ProjectMenu
          project={menuProject}
          pinned={selectIsPinned(state, menuProject.id)}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onAction={handleMenuAction}
        />
      ) : null}

      <NewProjectDialog
        open={newProjectOpen}
        onClose={() => setNewProjectOpen(false)}
        onCreated={handleProjectCreated}
      />

      <ConfirmDeleteConversationDialog
        open={deleteTarget !== null}
        conversationId={deleteTarget?.id ?? ''}
        conversationTitle={deleteTarget?.title ?? ''}
        onClose={() => setDeleteTarget(null)}
        onDeleted={(id) =>
          setHiddenConversationIds((prev) => {
            const next = new Set(prev);
            next.add(id);
            return next;
          })
        }
      />
    </div>
  );
}
