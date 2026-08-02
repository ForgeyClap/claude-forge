/**
 * Forge Workspace — the shell nav model.
 *
 * The table of destinations lives in its own module because two components read
 * it: Sidebar renders it, and Topbar looks the current path up in it to title
 * the view. Keeping the table in one place keeps those two honest with each
 * other.
 *
 * It is a separate file rather than a section of Sidebar.tsx for a second,
 * mechanical reason: a module that exports both a component and a constant
 * cannot be hot-reloaded by React Fast Refresh, and the linter says so. Nothing
 * in this file is a component and nothing in it reads state — it is data.
 */

export interface ShellNavItem {
  readonly path: string;
  readonly label: string;
  /** lucide icon name. */
  readonly icon: string;
  /** One short line, used for the rail tooltip and the topbar title attribute. */
  readonly description: string;
}

/** The primary destinations, in the order they are worked through. */
export const PRIMARY_NAV: readonly ShellNavItem[] = [
  { path: '/', label: 'Home', icon: 'House', description: 'Workspace overview and recent work' },
  {
    path: '/projects',
    label: 'Projects',
    icon: 'FolderKanban',
    description: 'Every project in the registry',
  },
  {
    path: '/chat',
    label: 'Conversations',
    icon: 'MessagesSquare',
    description: 'Threads with Forge, per project',
  },
  {
    path: '/mission',
    label: 'Mission Control',
    icon: 'Network',
    description: 'The run graph: lanes, verification and feedback',
  },
  { path: '/agents', label: 'Agents', icon: 'Bot', description: 'The agent pool and what it is doing' },
  {
    path: '/tasks',
    label: 'Tasks',
    icon: 'ListChecks',
    description: 'Work packages, phases and the task board',
  },
  {
    path: '/artifacts',
    label: 'Artifacts',
    icon: 'FileStack',
    description: 'Reports, screenshots, diagrams and receipts',
  },
  {
    path: '/tests',
    label: 'Tests & proof',
    icon: 'FlaskConical',
    description: 'Quality gates and the proof ledger',
  },
  {
    path: '/activity',
    label: 'Activity',
    icon: 'Activity',
    description: 'The event stream for the current run',
  },
  {
    path: '/discord',
    label: 'Discord',
    icon: 'PlugZap',
    description: 'The Discord remote-control bot: on/off, status and health',
  },
  {
    path: '/settings',
    label: 'Settings',
    icon: 'Settings',
    description: 'Appearance, density and the Claude Code connection',
  },
];

/** Secondary destinations. Reachable, but not part of the daily path. */
export const SECONDARY_NAV: readonly ShellNavItem[] = [
  {
    path: '/project',
    label: 'Project overview',
    icon: 'FolderOpen',
    description: 'The active project in detail',
  },
  { path: '/files', label: 'Files & diffs', icon: 'FolderTree', description: 'The project file tree' },
  {
    path: '/theme',
    label: 'Design reference (internal)',
    icon: 'Palette',
    description: 'Internal reference for this team: every token, status and primitive on one page — not a product feature',
  },
];

export const ALL_NAV: readonly ShellNavItem[] = [...PRIMARY_NAV, ...SECONDARY_NAV];
