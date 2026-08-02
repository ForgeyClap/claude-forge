/**
 * CommandPalette — Ctrl+K / Cmd+K.
 *
 * Most commands move you somewhere in the workspace or dispatch a local store
 * action. "New conversation" is the one command that reaches the network: it
 * drives a real `POST /api/conversations` (see ./gateway-actions), the same
 * route Sidebar's "New chat" uses.
 *
 * Keyboard contract:
 *   Ctrl+K / Cmd+K  open            Escape  close
 *   /               open and focus  ↑ ↓     move        Enter  run
 *   Tab             held inside the dialog (focus stays on the search field)
 *
 * The global shortcut listener lives on the outer component and is removed on
 * unmount. The dialog itself only exists while the palette is open, so its
 * query and its cursor start clean every time it is raised.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Icon, KeyHint, Machine, Spacer } from '@/components/primitives';
import { nextToastId, usePrototype } from '@/prototype/state/prototype-store';
import type { Appearance } from '@/prototype/types/prototype-types';
import { requestNewConversation } from './gateway-actions';
import './command-palette.css';

/* ----------------------------------------------------------------- fuzzy */

/** Subsequence match with bonuses for word starts and consecutive hits. */
function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  const t = text.toLowerCase();
  if (q.length === 0) return 0;

  let score = 0;
  let cursor = 0;
  let streak = 0;

  for (const char of q) {
    if (char === ' ') {
      streak = 0;
      continue;
    }
    const found = t.indexOf(char, cursor);
    if (found === -1) return -1;

    const previous = found > 0 ? t[found - 1] : ' ';
    const wordStart = found === 0 || previous === ' ' || previous === '-' || previous === '·';

    score += 10;
    if (wordStart) score += 8;
    if (found === cursor) {
      streak += 1;
      score += 4 + streak;
    } else {
      streak = 0;
      score -= Math.min(found - cursor, 6);
    }
    cursor = found + 1;
  }

  return score;
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/* --------------------------------------------------------------- commands */

interface Command {
  readonly id: string;
  readonly group: string;
  readonly title: string;
  readonly detail?: string;
  readonly icon: string;
  /** Rendered as a KeyHint when the command has a real global shortcut. */
  readonly keys?: readonly string[];
  /** Detail is machine-recorded (an id), not prose. */
  readonly machineDetail?: boolean;
  readonly run: () => void;
}

interface Group {
  readonly name: string;
  readonly commands: readonly Command[];
}

/** Groups a ranked list, keeping the order the ranking produced. */
function groupCommands(commands: readonly Command[]): readonly Group[] {
  const order: string[] = [];
  const buckets = new Map<string, Command[]>();
  for (const command of commands) {
    const bucket = buckets.get(command.group);
    if (bucket) {
      bucket.push(command);
    } else {
      order.push(command.group);
      buckets.set(command.group, [command]);
    }
  }
  return order.map((name) => ({ name, commands: buckets.get(name) ?? [] }));
}

/* ----------------------------------------------------------------- dialog */

function PaletteDialog() {
  const { state, dispatch } = usePrototype();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const baseId = useId();

  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const close = useCallback(() => dispatch({ type: 'palette/set', open: false }), [dispatch]);

  /** Local navigation only — HashRouter, same document, no request. */
  const go = useCallback((path: string) => navigate(path), [navigate]);

  const toast = useCallback(
    (title: string, detail: string, icon: string) => {
      dispatch({ type: 'toast/push', toast: { id: nextToastId(), title, detail, icon } });
    },
    [dispatch],
  );

  const setAppearance = useCallback(
    (appearance: Appearance) => {
      dispatch({ type: 'appearance/set', appearance });
      toast(
        `Theme set to ${appearance}`,
        'Stored as a local preference. Nothing else changed.',
        appearance === 'light' ? 'Sun' : appearance === 'dark' ? 'Moon' : 'Monitor',
      );
    },
    [dispatch, toast],
  );

  const projects = state.data.projects;
  const activeProjectId = state.activeProjectId;

  const commands = useMemo<readonly Command[]>(() => {
    const list: Command[] = [];

    for (const project of projects) {
      list.push({
        id: `open-project-${project.id}`,
        group: 'Projects',
        title: `Open project — ${project.name}`,
        detail: project.id,
        machineDetail: true,
        icon: 'FolderGit2',
        run: () => {
          dispatch({ type: 'project/activate', id: project.id });
          go('/project');
        },
      });
    }

    list.push({
      id: 'search-projects',
      group: 'Projects',
      title: 'Search projects',
      detail: 'Open the project list and clear the filter',
      icon: 'Search',
      run: () => {
        dispatch({ type: 'project/query', query: '' });
        go('/projects');
      },
    });

    list.push({
      id: 'new-conversation',
      group: 'Go to',
      title: 'New conversation',
      detail: 'Starts a new conversation in the active project',
      icon: 'MessageSquarePlus',
      run: () => {
        void (async () => {
          const result = await requestNewConversation(activeProjectId);
          if (!result.ok || result.id === null) {
            toast('New chat failed', result.error ?? 'The gateway could not start a new chat.', 'TriangleAlert');
            return;
          }
          dispatch({ type: 'conversation/activate', id: result.id });
          go('/chat');
        })();
      },
    });

    list.push({
      id: 'go-mission',
      group: 'Go to',
      title: 'Go to Mission Control',
      detail: 'The run graph, lanes and the verify loop',
      icon: 'Waypoints',
      run: () => go('/mission'),
    });

    list.push({
      id: 'view-agents',
      group: 'Go to',
      title: 'View agents',
      detail: 'The current agent roster',
      icon: 'Bot',
      run: () => go('/agents'),
    });

    list.push({
      id: 'view-tasks',
      group: 'Go to',
      title: 'View tasks',
      detail: 'Board, table, work packages and phases',
      icon: 'ListChecks',
      run: () => go('/tasks'),
    });

    list.push({
      id: 'view-tests',
      group: 'Go to',
      title: 'View tests',
      detail: 'Quality gates and the proof ledger',
      icon: 'ShieldCheck',
      run: () => go('/tests'),
    });

    list.push({
      id: 'open-settings',
      group: 'Go to',
      title: 'Open settings',
      detail: 'Appearance, density and the Claude Code connection',
      icon: 'Settings',
      run: () => go('/settings'),
    });

    list.push({
      id: 'open-theme',
      group: 'Go to',
      title: 'Open theme showcase',
      detail: 'Every token, status and primitive on one page',
      icon: 'Palette',
      run: () => go('/theme'),
    });

    list.push({
      id: 'theme-dark',
      group: 'Appearance',
      title: 'Switch theme — Dark',
      detail: 'The forge is a dark room',
      icon: 'Moon',
      run: () => setAppearance('dark'),
    });

    list.push({
      id: 'theme-light',
      group: 'Appearance',
      title: 'Switch theme — Light',
      detail: 'The same tokens, inverted values',
      icon: 'Sun',
      run: () => setAppearance('light'),
    });

    list.push({
      id: 'theme-system',
      group: 'Appearance',
      title: 'Switch theme — System',
      detail: 'Follow the operating system',
      icon: 'Monitor',
      run: () => setAppearance('system'),
    });

    list.push({
      id: 'toggle-sidebar',
      group: 'Layout',
      title: 'Toggle sidebar',
      detail: 'Fold the navigation down to its rail',
      icon: 'PanelLeft',
      keys: ['Ctrl', 'B'],
      run: () => dispatch({ type: 'sidebar/toggle' }),
    });

    list.push({
      id: 'toggle-inspector',
      group: 'Layout',
      title: 'Toggle inspector',
      detail: 'The right-hand detail panel',
      icon: 'PanelRight',
      run: () => dispatch({ type: 'inspector/toggle' }),
    });

    list.push({
      id: 'toggle-dock',
      group: 'Layout',
      title: 'Toggle dock',
      detail: 'Activity, terminal, tests, events, proof, notices',
      icon: 'PanelBottomOpen',
      run: () => dispatch({ type: 'dock/toggle' }),
    });

    return list;
  }, [projects, activeProjectId, dispatch, go, toast, setAppearance]);

  const results = useMemo(() => {
    if (query.trim() === '') return commands;
    const scored = commands
      .map((command, index) => ({
        command,
        index,
        score: fuzzyScore(query, `${command.title} ${command.detail ?? ''} ${command.group}`),
      }))
      .filter((entry) => entry.score >= 0);
    scored.sort((a, b) => (b.score === a.score ? a.index - b.index : b.score - a.score));
    return scored.map((entry) => entry.command);
  }, [commands, query]);

  const groups = useMemo(() => groupCommands(results), [results]);

  const runAt = useCallback(
    (index: number) => {
      const command = results[index];
      if (!command) return;
      close();
      command.run();
    },
    [results, close],
  );

  /* Escape closes from anywhere, even if focus slipped out of the dialog. */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [close]);

  /* Focus enters the field on open and returns to the opener on close. */
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      opener?.focus();
    };
  }, []);

  /* Keep the active option in view while arrowing through a long list. */
  useEffect(() => {
    const options = listRef.current?.querySelectorAll<HTMLElement>('[role="option"]');
    options?.[active]?.scrollIntoView({ block: 'nearest' });
  }, [active, results.length]);

  function onDialogKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Tab') {
      // A single-field dialog: Tab must not walk out of it.
      event.preventDefault();
      inputRef.current?.focus();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => (results.length === 0 ? 0 : (index + 1) % results.length));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => (results.length === 0 ? 0 : (index - 1 + results.length) % results.length));
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      setActive(0);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      setActive(Math.max(0, results.length - 1));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      runAt(active);
    }
  }

  const listId = `${baseId}-list`;
  const activeId = results.length > 0 ? `${baseId}-option-${active}` : undefined;
  let cursor = -1;

  return (
    <div className="fw-palette">
      <div className="fw-palette__scrim" onClick={close} aria-hidden="true" />

      <div
        className="fw-palette__dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={onDialogKeyDown}
      >
        <div className="fw-palette__field">
          <Icon name="Command" size="sm" className="fw-palette__field-icon" />
          <input
            ref={inputRef}
            className="fw-palette__input"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            aria-label="Search commands"
            placeholder="Search commands, projects and destinations"
            value={query}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
          />
          <KeyHint keys={['Esc']} />
        </div>

        <div className="fw-palette__list fw-scroll" id={listId} role="listbox" aria-label="Commands" ref={listRef}>
          {results.length === 0 ? (
            <p className="fw-palette__empty">
              No command matches <Machine>{query}</Machine>
            </p>
          ) : (
            groups.map((group) => {
              const headingId = `${baseId}-group-${group.name.replace(/\s+/g, '-').toLowerCase()}`;
              return (
                <div className="fw-palette__group" role="group" aria-labelledby={headingId} key={group.name}>
                  <div className="fw-palette__group-name fg-eyebrow" id={headingId}>
                    {group.name}
                  </div>
                  {group.commands.map((command) => {
                    cursor += 1;
                    const index = cursor;
                    const selected = index === active;
                    return (
                      <div
                        key={command.id}
                        id={`${baseId}-option-${index}`}
                        role="option"
                        aria-selected={selected}
                        className={selected ? 'fw-palette__option is-active' : 'fw-palette__option'}
                        onMouseMove={() => {
                          if (index !== active) setActive(index);
                        }}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => runAt(index)}
                      >
                        <Icon name={command.icon} size="sm" className="fw-palette__option-icon" />
                        <span className="fw-palette__option-title fw-truncate">{command.title}</span>
                        {command.detail ? (
                          command.machineDetail ? (
                            <Machine muted className="fw-palette__option-detail fw-truncate">
                              {command.detail}
                            </Machine>
                          ) : (
                            <span className="fw-palette__option-detail fw-truncate">{command.detail}</span>
                          )
                        ) : null}
                        {command.keys ? <KeyHint keys={command.keys} /> : null}
                      </div>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>

        <footer className="fw-palette__foot">
          <span className="fw-palette__hint">
            <KeyHint keys={['↑', '↓']} /> move
          </span>
          <span className="fw-palette__hint">
            <KeyHint keys={['Enter']} /> run
          </span>
          <span className="fw-palette__hint">
            <KeyHint keys={['Esc']} /> close
          </span>
          <Spacer />
          <span className="fw-palette__honesty">Mostly navigation and local state — "New conversation" is the one command that reaches the gateway.</span>
        </footer>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- component */

export function CommandPalette() {
  const { state, dispatch } = usePrototype();
  const open = state.paletteOpen;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && (event.key === 'k' || event.key === 'K')) {
        event.preventDefault();
        // 'set open', never 'toggle': the shell listens for the same chord, and
        // two handlers agreeing on "open" is harmless where two toggles cancel.
        dispatch({ type: 'palette/set', open: true });
        return;
      }
      // '/' only reaches here when focus is not already in a text field, so it
      // still types normally inside the palette's own search input.
      if (event.key === '/' && !isEditable(event.target)) {
        event.preventDefault();
        dispatch({ type: 'palette/set', open: true });
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dispatch]);

  if (!open) return null;

  return createPortal(<PaletteDialog />, document.body);
}

export default CommandPalette;
