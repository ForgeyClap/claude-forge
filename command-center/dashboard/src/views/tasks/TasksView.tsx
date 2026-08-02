/**
 * Tasks view — the mission's work, seen four ways.
 *
 * Layouts are driven by `state.taskLayout`:
 *   kanban         the eight board columns, horizontally scrolling
 *   table          every task field as a sortable column
 *   work-packages  one panel per work package, tasks nested inside
 *   phases         the six phases as a vertical rhythm
 *
 * A card's column is always read through `selectTaskColumn`, so every layout
 * agrees about where a task sits.
 *
 * The board is READ-ONLY over the real run state: there is no drag-and-drop and
 * no move control. A local drag/move used to write a client-only column override
 * that silently contradicted the real run — removed rather than kept as a lie.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import {
  Button,
  EmptyState,
  Eyebrow,
  ExampleTag,
  Icon,
  Machine,
  Meter,
  Panel,
  SegmentedControl,
  StatusBadge,
  Toolbar,
} from '@/components/primitives';
import { TASK_COLUMNS } from '@/prototype/types/prototype-types';
import type {
  Task,
  TaskColumn,
  TaskLayout,
  TaskPhase,
  WorkPackage,
} from '@/prototype/types/prototype-types';
import { selectTaskColumn, usePrototype } from '@/prototype/state/prototype-store';
import './tasks.css';

/* ------------------------------------------------------------------ tables */

const LAYOUTS: readonly { value: TaskLayout; label: string; icon: string }[] = [
  { value: 'kanban', label: 'Kanban', icon: 'Columns3' },
  { value: 'table', label: 'Table', icon: 'Table' },
  { value: 'work-packages', label: 'Work packages', icon: 'Layers' },
  { value: 'phases', label: 'Phases', icon: 'ListChecks' },
];

const COLUMN_META: Readonly<Record<TaskColumn, { label: string; icon: string }>> = {
  backlog: { label: 'Backlog', icon: 'Inbox' },
  planned: { label: 'Planned', icon: 'CalendarClock' },
  running: { label: 'Running', icon: 'Loader' },
  'self-review': { label: 'Self-review', icon: 'Eye' },
  verify: { label: 'Verify', icon: 'SearchCheck' },
  review: { label: 'Review', icon: 'ClipboardCheck' },
  blocked: { label: 'Blocked', icon: 'Lock' },
  completed: { label: 'Completed', icon: 'Check' },
};

const PHASES: readonly TaskPhase[] = ['intake', 'plan', 'build', 'verify', 'review', 'handoff'];

const PHASE_META: Readonly<Record<TaskPhase, { label: string; icon: string; note: string }>> = {
  intake: { label: 'INTAKE', icon: 'Inbox', note: 'Understand the request before anything is written.' },
  plan: { label: 'PLAN', icon: 'Map', note: 'Cut the work into packages with owners and acceptance.' },
  build: { label: 'BUILD', icon: 'Hammer', note: 'Write the implementation and the edge cases.' },
  verify: { label: 'VERIFY', icon: 'SearchCheck', note: 'Check the claim against the evidence attached.' },
  review: { label: 'REVIEW', icon: 'Gavel', note: 'The last read before anything reaches the owner.' },
  handoff: { label: 'HANDOFF', icon: 'PackageCheck', note: 'Leave the owner able to run and change it.' },
};

type SortKey =
  | 'id'
  | 'title'
  | 'status'
  | 'column'
  | 'phase'
  | 'agent'
  | 'wp'
  | 'progress'
  | 'proof'
  | 'repairs'
  | 'deps'
  | 'created'
  | 'updated'
  | 'detail';

interface TableColumnDef {
  readonly key: SortKey;
  readonly label: string;
}

const TABLE_COLUMNS: readonly TableColumnDef[] = [
  { key: 'id', label: 'ID' },
  { key: 'title', label: 'Task' },
  { key: 'status', label: 'Status' },
  { key: 'column', label: 'Column' },
  { key: 'phase', label: 'Phase' },
  { key: 'agent', label: 'Agent' },
  { key: 'wp', label: 'WP' },
  { key: 'progress', label: 'Progress' },
  { key: 'proof', label: 'Proof' },
  { key: 'repairs', label: 'Repairs' },
  { key: 'deps', label: 'Depends on' },
  { key: 'created', label: 'Created' },
  { key: 'updated', label: 'Updated' },
  { key: 'detail', label: 'Detail' },
];

const SORT_KEYS: ReadonlySet<string> = new Set(TABLE_COLUMNS.map((column) => column.key));

function isSortKey(value: string): value is SortKey {
  return SORT_KEYS.has(value);
}

function isTaskLayout(value: string): value is TaskLayout {
  return (
    value === 'kanban' || value === 'table' || value === 'work-packages' || value === 'phases'
  );
}

/** `wp-1` reads as `WP1` on a card. The full title stays on the work-package panel. */
function shortWorkPackage(id: string): string {
  return id.replace(/-/g, '').toUpperCase();
}

/* --------------------------------------------------------------------- row */

// fix-run-visibility item 3 (silent disappearance): `Row.column` is typed as `TaskColumn`, but a
// real task can arrive with a `column` value the compiler never sees at runtime (any of this
// codebase's several `record as unknown as Task` construction sites — see mappers.ts/chat-runs.ts —
// bypasses the type check on purpose to build a `Task` from an untyped gateway payload). Before this
// fix, `byColumn`'s `map.get(row.column)?.push(row)` silently dropped such a task: `map` only ever
// has the eight real `TASK_COLUMNS` keys, so an unrecognized column meant `.get()` returned
// `undefined` and the optional-chained `.push` quietly did nothing — the task still counted in the
// header's "N tasks" subtitle but never rendered anywhere on the board. Catching it HERE (in `rows`,
// the one place every layout ultimately reads `row.column` from) means every consumer — kanban,
// table, work-packages, phases — is fixed at once, and the sum of every column's list length can
// never again drift from `rows.length`.
const KNOWN_TASK_COLUMNS: ReadonlySet<TaskColumn> = new Set(TASK_COLUMNS);

// 'backlog' is the safest catch bucket: unlike 'blocked' or 'completed' it asserts nothing false
// about the task's real progress — it is simply "not yet placed", which is the honest truth here.
const FALLBACK_TASK_COLUMN: TaskColumn = 'backlog';

function isKnownTaskColumn(column: TaskColumn): boolean {
  return KNOWN_TASK_COLUMNS.has(column);
}

interface Row {
  readonly task: Task;
  readonly agentName: string;
  readonly wpLabel: string;
  /** Always one of the eight real `TASK_COLUMNS` — redirected to `FALLBACK_TASK_COLUMN` below when
   *  the task's own real column was not recognized, so every map keyed by `TASK_COLUMNS` can trust
   *  this field without a defensive `?? []` at every call site. */
  readonly column: TaskColumn;
  /** True when `column` above is a redirect, not the task's real value — see `rawColumn`. */
  readonly columnIsFallback: boolean;
  /** The task's own real column value, always as a string — even when it was not one of the eight
   *  known columns (a plain `TaskColumn` cast could not hold that at the type level, but the actual
   *  runtime string is worth showing honestly rather than discarding). */
  readonly rawColumn: string;
}

function sortValue(row: Row, key: SortKey): string | number {
  switch (key) {
    case 'id':
      return row.task.id;
    case 'title':
      return row.task.title.toLowerCase();
    case 'status':
      return row.task.status;
    case 'column':
      return TASK_COLUMNS.indexOf(row.column);
    case 'phase':
      return PHASES.indexOf(row.task.phase);
    case 'agent':
      return row.agentName.toLowerCase();
    case 'wp':
      return row.wpLabel;
    case 'progress':
      return row.task.progress;
    case 'proof':
      return row.task.proofCount;
    case 'repairs':
      return row.task.repairAttempts;
    case 'deps':
      return row.task.dependencies.join(' ');
    case 'created':
      return row.task.createdAt;
    case 'updated':
      return row.task.updatedAt;
    case 'detail':
      return row.task.detail.toLowerCase();
    default:
      return row.task.id;
  }
}

/* --------------------------------------------------------------- fragments */

function TaskStats({ task }: { task: Task }) {
  if (task.proofCount === 0 && task.repairAttempts === 0) return null;
  return (
    <span className="fw-tasks-stats">
      {task.proofCount > 0 ? (
        <span className="fw-tasks-stat" title={`${task.proofCount} proof entries attached`}>
          <Icon name="FileCheck" size="xs" />
          <Machine>{task.proofCount}</Machine>
          <span className="fw-tasks-stat__word">proof</span>
        </span>
      ) : null}
      {task.repairAttempts > 0 ? (
        <span
          className="fw-tasks-stat is-repair"
          title={`${task.repairAttempts} repair attempts opened by the verify loop`}
        >
          <Icon name="Wrench" size="xs" />
          <Machine>{task.repairAttempts}</Machine>
          <span className="fw-tasks-stat__word">repairs</span>
        </span>
      ) : null}
    </span>
  );
}

// fix-run-visibility item 3: the one visible, honest notice for a task caught by the
// `FALLBACK_TASK_COLUMN` redirect above — renders nothing for every ordinary task (`columnIsFallback`
// is the overwhelmingly common `false` case), so this never adds noise to a normal board.
function ColumnFallbackFlag({ row }: { row: Row }) {
  if (!row.columnIsFallback) return null;
  return (
    <span
      className="fw-tasks-stat is-unknown-column"
      title={`Unrecognized task column "${row.rawColumn}" — shown here under Backlog so it is never lost.`}
    >
      <Icon name="CircleAlert" size="xs" />
      <span className="fw-tasks-stat__word">Unknown column</span>
    </span>
  );
}

interface EntryProps {
  row: Row;
  selected: boolean;
  onSelect: (id: string) => void;
}

function TaskCard({ row, selected, onSelect }: EntryProps) {
  const { task } = row;
  const classes = ['fw-tasks-card', 'fw-status'];
  if (selected) classes.push('is-selected');

  return (
    <li className={classes.join(' ')} data-status={task.status}>
      <div className="fw-tasks-card__top">
        <Machine muted className="fw-tasks-card__id">
          {task.id}
        </Machine>
        <StatusBadge status={task.status} size="sm" />
      </div>

      <button
        type="button"
        className="fw-tasks-card__hit"
        aria-pressed={selected}
        onClick={() => onSelect(task.id)}
        title={task.detail}
      >
        {task.title}
      </button>

      <div className="fw-tasks-card__meta">
        <span className="fw-tasks-card__meta-item">
          <Icon name="UserRound" size="xs" />
          <Machine muted>{row.agentName}</Machine>
        </span>
        <span className="fw-tasks-card__meta-item">
          <Icon name="Layers" size="xs" />
          <Machine muted>{row.wpLabel}</Machine>
        </span>
      </div>

      <Meter
        value={task.progress}
        tone={task.status === 'running' ? 'accent' : 'default'}
        showValue
      />

      <div className="fw-tasks-card__foot">
        <TaskStats task={task} />
        <ColumnFallbackFlag row={row} />
      </div>
    </li>
  );
}

interface RowProps {
  row: Row;
  selected: boolean;
  onSelect: (id: string) => void;
}

function TaskRow({ row, selected, onSelect }: RowProps) {
  const { task } = row;
  return (
    <li
      className={selected ? 'fw-tasks-row fw-status is-selected' : 'fw-tasks-row fw-status'}
      data-status={task.status}
    >
      <Machine muted className="fw-tasks-row__id">
        {task.id}
      </Machine>

      <button
        type="button"
        className="fw-tasks-row__hit"
        aria-pressed={selected}
        onClick={() => onSelect(task.id)}
        title={task.detail}
      >
        {task.title}
      </button>

      <StatusBadge status={task.status} size="sm" />

      <span className="fw-tasks-row__column">
        <Icon name={COLUMN_META[row.column].icon} size="xs" />
        <Machine muted>{COLUMN_META[row.column].label.toUpperCase()}</Machine>
      </span>

      <span className="fw-tasks-row__agent">
        <Icon name="UserRound" size="xs" />
        <Machine muted>{row.agentName}</Machine>
      </span>

      <span className="fw-tasks-row__meter">
        <Meter
          value={task.progress}
          tone={task.status === 'running' ? 'accent' : 'default'}
          showValue
        />
      </span>

      <TaskStats task={task} />
      <ColumnFallbackFlag row={row} />
    </li>
  );
}

/* -------------------------------------------------------------------- view */

export default function TasksView() {
  const { state, dispatch } = usePrototype();
  const layout = state.taskLayout;

  const [sortKey, setSortKey] = useState<SortKey>('id');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const selectedId = state.selection.kind === 'task' ? state.selection.id : null;

  const agentNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of state.data.agents) map.set(agent.id, agent.name);
    return map;
  }, [state.data.agents]);

  const rows = useMemo<Row[]>(
    () =>
      state.data.tasks.map((task) => {
        const realColumn = selectTaskColumn(state, task);
        const knownColumn = isKnownTaskColumn(realColumn);
        return {
          task,
          agentName: agentNames.get(task.agentId) ?? task.agentId,
          wpLabel: shortWorkPackage(task.workPackageId),
          column: knownColumn ? realColumn : FALLBACK_TASK_COLUMN,
          columnIsFallback: !knownColumn,
          rawColumn: String(realColumn),
        };
      }),
    [state, agentNames],
  );

  const rowById = useMemo(() => {
    const map = new Map<string, Row>();
    for (const row of rows) map.set(row.task.id, row);
    return map;
  }, [rows]);

  const byColumn = useMemo(() => {
    const map = new Map<TaskColumn, Row[]>();
    for (const column of TASK_COLUMNS) map.set(column, []);
    // `row.column` is guaranteed to be one of the eight keys already set above (the fallback
    // redirect happened when `rows` was built) — this `?.` stays only as ordinary defensive style,
    // never as the silent-drop path it used to be.
    for (const row of rows) map.get(row.column)?.push(row);
    return map;
  }, [rows]);

  // fix-run-visibility item 2 (owner screenshot: the Tasks tab said "2 tasks" but every VISIBLE
  // column read "Nothing in this column") — the first column (in board order) that actually holds a
  // task, or null when the board is genuinely empty. A primitive (a `TaskColumn` string, not the
  // `byColumn` Map/`rows` array themselves) is what the scroll effect below depends on, on purpose —
  // see that effect's own comment for why.
  const firstNonEmptyColumn = useMemo<TaskColumn | null>(() => {
    for (const column of TASK_COLUMNS) {
      if ((byColumn.get(column)?.length ?? 0) > 0) return column;
    }
    return null;
  }, [byColumn]);

  const columnSectionRefs = useRef(new Map<TaskColumn, HTMLElement>());
  function registerColumnSection(column: TaskColumn) {
    return (node: HTMLElement | null) => {
      if (node) columnSectionRefs.current.set(column, node);
      else columnSectionRefs.current.delete(column);
    };
  }

  // Of the three mechanisms this WP named (auto-scroll / collapse-empty-columns-to-a-strip / a text
  // banner), auto-scroll-to-the-first-non-empty-column is the smallest honest fix: it needs no CSS
  // change (this view's frozen `tasks.css` layout — fixed-width columns inside a horizontally-
  // scrolling `.fw-tasks-board` — stays exactly as designed), and it mirrors an ALREADY-established
  // pattern one file over (`CommandPalette.tsx`'s own `options?.[active]?.scrollIntoView({ block:
  // 'nearest' })` effect for keeping the active option in view while arrowing through a long list).
  // Depending on `firstNonEmptyColumn` (a primitive string, not `byColumn`/`rows` themselves) is what
  // keeps this SAFE for a live dashboard: a routine poll tick that returns the identical task set
  // produces a new `rows` array/`byColumn` Map every time (this view's `state` is the whole,
  // immutably-replaced prototype store), but the SAME string for `firstNonEmptyColumn` — so this
  // effect only re-fires, and only re-scrolls, when which column holds the first real task actually
  // changes, never on every poll. It never fires outside the kanban layout (the other three layouts
  // do not have this scroll problem at all — they stack vertically, already showing everything).
  useEffect(() => {
    if (layout !== 'kanban' || firstNonEmptyColumn === null) return;
    columnSectionRefs.current.get(firstNonEmptyColumn)?.scrollIntoView({ inline: 'start', block: 'nearest' });
  }, [layout, firstNonEmptyColumn]);

  const byPhase = useMemo(() => {
    const map = new Map<TaskPhase, Row[]>();
    for (const phase of PHASES) map.set(phase, []);
    for (const row of rows) map.get(row.task.phase)?.push(row);
    return map;
  }, [rows]);

  const sortedRows = useMemo(() => {
    const list = [...rows];
    list.sort((a, b) => {
      const left = sortValue(a, sortKey);
      const right = sortValue(b, sortKey);
      let result =
        typeof left === 'number' && typeof right === 'number'
          ? left - right
          : String(left).localeCompare(String(right));
      if (result === 0) result = a.task.id.localeCompare(b.task.id);
      return sortDir === 'asc' ? result : -result;
    });
    return list;
  }, [rows, sortKey, sortDir]);

  function select(id: string) {
    dispatch({ type: 'select', selection: { kind: 'task', id } });
  }

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
      return;
    }
    setSortKey(key);
    setSortDir('asc');
  }

  function handleSortSelect(event: ChangeEvent<HTMLSelectElement>) {
    const value = event.target.value;
    if (isSortKey(value)) setSortKey(value);
  }

  function workPackageRows(pkg: WorkPackage): Row[] {
    return pkg.taskIds.flatMap((id) => {
      const row = rowById.get(id);
      return row ? [row] : [];
    });
  }

  const cardProps = (row: Row) => ({
    row,
    selected: row.task.id === selectedId,
    onSelect: select,
  });

  const rowProps = (row: Row) => ({
    row,
    selected: row.task.id === selectedId,
    onSelect: select,
  });

  return (
    <div className="fw-tasks">
      <header className="fw-tasks__head">
        <div className="fw-tasks__heading">
          <Eyebrow>Mission work</Eyebrow>
          <h1 className="fw-tasks__title">Tasks</h1>
          <p className="fw-tasks__subtitle">
            {state.data.tasks.length} task{state.data.tasks.length === 1 ? '' : 's'} across{' '}
            {state.data.workPackages.length} work package{state.data.workPackages.length === 1 ? '' : 's'} and
            six phases. <ExampleTag />
          </p>
        </div>

        <Toolbar label="Task view controls" className="fw-tasks__toolbar">
          <SegmentedControl
            className="fw-tasks__layout"
            label="Task layout"
            size="sm"
            value={layout}
            options={LAYOUTS.map((option) => ({
              value: option.value,
              label: option.label,
              icon: option.icon,
            }))}
            onChange={(value) => {
              if (isTaskLayout(value)) dispatch({ type: 'tasks/layout', layout: value });
            }}
          />
        </Toolbar>
      </header>

      {layout === 'kanban' ? (
        <p className="fw-tasks__note">
          <Icon name="Info" size="xs" />
          This board mirrors the real run state. Select a card to see its detail — moving a card
          between columns is not available here.
        </p>
      ) : null}

      <div className="fw-tasks__body fw-scroll">
        {rows.length === 0 ? (
          <EmptyState
            icon="Inbox"
            title="No tasks yet"
            detail="No tasks are recorded for this project yet."
          />
        ) : layout === 'kanban' ? (
          <div className="fw-tasks-board" aria-label="Task board">
            {TASK_COLUMNS.map((column) => {
              const list = byColumn.get(column) ?? [];
              const meta = COLUMN_META[column];
              return (
                <section
                  key={column}
                  ref={registerColumnSection(column)}
                  className="fw-tasks-board__col"
                  aria-label={`${meta.label} — ${list.length} tasks`}
                >
                  <header className="fw-tasks-board__head">
                    <Icon name={meta.icon} size="sm" />
                    <h2 className="fw-tasks-board__title fg-machine">{meta.label}</h2>
                    <span className="fw-tasks-board__count fg-machine">{list.length}</span>
                  </header>

                  <ul className="fw-tasks-board__cards fw-scroll">
                    {list.map((row) => (
                      <TaskCard key={row.task.id} {...cardProps(row)} />
                    ))}
                    {list.length === 0 ? (
                      <li className="fw-tasks-board__empty">Nothing in this column.</li>
                    ) : null}
                  </ul>
                </section>
              );
            })}
          </div>
        ) : layout === 'table' ? (
          <div className="fw-tasks-table-shell">
            <div className="fw-tasks-table__mobile-sort">
              <label className="fw-tasks-table__sort-label" htmlFor="fw-tasks-sort">
                Sort by
              </label>
              <select
                id="fw-tasks-sort"
                className="fw-tasks-table__select"
                value={sortKey}
                onChange={handleSortSelect}
              >
                {TABLE_COLUMNS.map((column) => (
                  <option key={column.key} value={column.key}>
                    {column.label}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                icon={sortDir === 'asc' ? 'ArrowUp' : 'ArrowDown'}
                onClick={() => setSortDir(sortDir === 'asc' ? 'desc' : 'asc')}
              >
                {sortDir === 'asc' ? 'Ascending' : 'Descending'}
              </Button>
            </div>

            <div className="fw-tasks-table-wrap">
              <table className="fw-tasks-table">
                <caption className="fw-visually-hidden">
                  Every task on this board, one row per task.
                </caption>
                <thead>
                  <tr>
                    {TABLE_COLUMNS.map((column) => (
                      <th
                        key={column.key}
                        scope="col"
                        aria-sort={
                          sortKey === column.key
                            ? sortDir === 'asc'
                              ? 'ascending'
                              : 'descending'
                            : 'none'
                        }
                      >
                        <button
                          type="button"
                          className="fw-tasks-table__sort"
                          onClick={() => toggleSort(column.key)}
                        >
                          <span>{column.label}</span>
                          <Icon
                            name={
                              sortKey === column.key
                                ? sortDir === 'asc'
                                  ? 'ArrowUp'
                                  : 'ArrowDown'
                                : 'ChevronsUpDown'
                            }
                            size="xs"
                          />
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map((row) => {
                    const { task } = row;
                    const selected = task.id === selectedId;
                    return (
                      <tr key={task.id} className={selected ? 'is-selected' : undefined}>
                        <td data-label="ID">
                          <Machine muted>{task.id}</Machine>
                        </td>
                        <td data-label="Task">
                          <button
                            type="button"
                            className="fw-tasks-table__hit"
                            aria-pressed={selected}
                            onClick={() => select(task.id)}
                          >
                            {task.title}
                          </button>
                        </td>
                        <td data-label="Status">
                          <StatusBadge status={task.status} size="sm" />
                        </td>
                        <td data-label="Column">
                          <Machine muted>{COLUMN_META[row.column].label.toUpperCase()}</Machine>
                          <ColumnFallbackFlag row={row} />
                        </td>
                        <td data-label="Phase">
                          <Machine muted>{PHASE_META[task.phase].label}</Machine>
                        </td>
                        <td data-label="Agent">
                          <Machine muted>{row.agentName}</Machine>
                        </td>
                        <td data-label="WP">
                          <Machine muted>{row.wpLabel}</Machine>
                        </td>
                        <td data-label="Progress">
                          <Meter
                            value={task.progress}
                            tone={task.status === 'running' ? 'accent' : 'default'}
                            showValue
                          />
                        </td>
                        <td data-label="Proof" className="fw-tasks-table__num">
                          <Machine muted>{task.proofCount}</Machine>
                        </td>
                        <td data-label="Repairs" className="fw-tasks-table__num">
                          <Machine muted>{task.repairAttempts}</Machine>
                        </td>
                        <td data-label="Depends on">
                          <Machine muted>
                            {task.dependencies.length > 0 ? task.dependencies.join(', ') : '—'}
                          </Machine>
                        </td>
                        <td data-label="Created">
                          <Machine muted>{task.createdAt}</Machine>
                        </td>
                        <td data-label="Updated">
                          <Machine muted>{task.updatedAt}</Machine>
                        </td>
                        <td data-label="Detail" className="fw-tasks-table__detail">
                          <span title={task.detail}>{task.detail}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : layout === 'work-packages' ? (
          <div className="fw-tasks-wps">
            {state.data.workPackages.map((pkg) => {
              const list = workPackageRows(pkg);
              const owner = agentNames.get(pkg.ownerAgentId) ?? pkg.ownerAgentId;
              return (
                <Panel
                  key={pkg.id}
                  className="fw-tasks-wp"
                  title={pkg.title}
                  subtitle={pkg.goal}
                  actions={<StatusBadge status={pkg.status} size="sm" />}
                >
                  <div className="fw-tasks-wp__facts">
                    <span className="fw-tasks-wp__fact">
                      <Eyebrow>Owner</Eyebrow>
                      <Machine>{owner}</Machine>
                    </span>
                    <span className="fw-tasks-wp__fact">
                      <Eyebrow>Phase</Eyebrow>
                      <Machine>{PHASE_META[pkg.phase].label}</Machine>
                    </span>
                    <span className="fw-tasks-wp__fact">
                      <Eyebrow>Tasks</Eyebrow>
                      <Machine>{list.length}</Machine>
                    </span>
                    <span className="fw-tasks-wp__fact">
                      <Eyebrow>Id</Eyebrow>
                      <Machine muted>{pkg.id}</Machine>
                    </span>
                  </div>

                  <section className="fw-tasks-wp__section">
                    <header className="fw-tasks-wp__section-head">
                      <Eyebrow>Acceptance criteria</Eyebrow>
                      <ExampleTag detail="Example acceptance criteria. Nothing was evaluated — the marks follow the work package's example status." />
                    </header>
                    <ul className="fw-tasks-wp__acceptance">
                      {pkg.acceptance.map((line) => (
                        <li key={line} className="fw-tasks-wp__criterion">
                          <Icon
                            name={pkg.status === 'completed' ? 'CircleCheck' : 'Circle'}
                            size="xs"
                          />
                          <span>{line}</span>
                        </li>
                      ))}
                    </ul>
                  </section>

                  <section className="fw-tasks-wp__section">
                    <header className="fw-tasks-wp__section-head">
                      <Eyebrow>Tasks</Eyebrow>
                    </header>
                    {list.length === 0 ? (
                      <p className="fw-tasks-empty-line">This package owns no tasks yet.</p>
                    ) : (
                      <ul className="fw-tasks-rows">
                        {list.map((row) => (
                          <TaskRow key={row.task.id} {...rowProps(row)} />
                        ))}
                      </ul>
                    )}
                  </section>
                </Panel>
              );
            })}
          </div>
        ) : (
          <div className="fw-tasks-phases">
            {PHASES.map((phase) => {
              const list = byPhase.get(phase) ?? [];
              const meta = PHASE_META[phase];
              return (
                <section
                  key={phase}
                  className="fw-tasks-phase"
                  aria-labelledby={`tasks-phase-${phase}`}
                >
                  <header className="fw-tasks-phase__head">
                    <span className="fw-tasks-phase__glyph">
                      <Icon name={meta.icon} size="sm" />
                    </span>
                    <h2 id={`tasks-phase-${phase}`} className="fw-tasks-phase__title fg-machine">
                      {meta.label}
                    </h2>
                    <span className="fw-tasks-phase__count fg-machine">{list.length}</span>
                    <p className="fw-tasks-phase__note">{meta.note}</p>
                  </header>
                  {list.length === 0 ? (
                    <p className="fw-tasks-empty-line">No task sits in this phase.</p>
                  ) : (
                    <ul className="fw-tasks-rows">
                      {list.map((row) => (
                        <TaskRow key={row.task.id} {...rowProps(row)} />
                      ))}
                    </ul>
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
