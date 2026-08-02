/**
 * Projects — the browser over the workspace's project registry.
 *
 * Filtering is bound to the store (`projectQuery`) so the same query is visible
 * on Home; sort order and list/grid layout are local view preferences, because
 * the prototype store deliberately does not model them.
 *
 * `state.data.projects` is real in production (read from this project's own
 * gateway) and fixture-labelled example data otherwise — the view itself cannot
 * tell which, and reads neither a registry nor a path on disk directly.
 */

import './projects.css';

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button,
  EmptyState,
  Icon,
  IconButton,
  Machine,
  Meter,
  SegmentedControl,
  Spacer,
  StatusBadge,
  Toolbar,
  ToolbarGroup,
} from '@/components/primitives';
import { hasMeasuredProjectDetail } from '@/prototype/state/gateway-adapter';
import { selectFilteredProjects, selectIsPinned, usePrototype } from '@/prototype/state/prototype-store';
import type { Project, ProjectType } from '@/prototype/types/prototype-types';

/* ------------------------------------------------------------ local helpers */

const AGO_UNITS: Readonly<Record<string, number>> = {
  sec: 1 / 60,
  secs: 1 / 60,
  second: 1 / 60,
  seconds: 1 / 60,
  min: 1,
  mins: 1,
  minute: 1,
  minutes: 1,
  hr: 60,
  hrs: 60,
  hour: 60,
  hours: 60,
  day: 1440,
  days: 1440,
  week: 10080,
  weeks: 10080,
};

/**
 * Minutes since `label`, for ordering only.
 *
 * `Project.lastActivity` USED to arrive here as a raw ISO timestamp, which this comment described.
 * It no longer does: the adapter now formats it to a relative label at the source, because a
 * 24-character ISO string was being truncated to `2026-07-29T0…` inside a meta slot sized for
 * "4 min ago" — less information than the value it replaced. Both branches below therefore still
 * matter, and the relative branch is now the PRODUCTION path rather than a fixture-only fallback.
 * The adapter deliberately emits the exact "<number> <unit word>" shape this parser accepts, so
 * this sort keeps working untouched — but that is a contract between two files, so do not change
 * either format without checking the other.
 */
function agoMinutes(label: string): number {
  const parsed = Date.parse(label);
  if (!Number.isNaN(parsed)) return Math.max(0, (Date.now() - parsed) / 60000);
  const match = /^(\d+)\s+([a-z]+)/.exec(label.trim().toLowerCase());
  if (!match) return 0;
  return Number(match[1]) * (AGO_UNITS[match[2]] ?? 1);
}

const TYPE_ICON: Readonly<Record<ProjectType, string>> = {
  website: 'Globe',
  'full-stack': 'Layers',
  automation: 'Workflow',
  chatbot: 'MessagesSquare',
  scraping: 'Radar',
  prediction: 'TrendingUp',
  integration: 'Cable',
  research: 'FlaskConical',
  // Unclassified project — the dashed circle is this app's existing "not determined" mark, never
  // one of the eight real type icons (see Sidebar.tsx for the full reasoning).
  unknown: 'CircleDashed',
};

const TYPE_LABEL: Readonly<Record<ProjectType, string>> = {
  website: 'Website',
  'full-stack': 'Full-stack',
  automation: 'Automation',
  chatbot: 'Chatbot',
  scraping: 'Scraping',
  prediction: 'Prediction',
  integration: 'Integration',
  research: 'Research',
  // Reads as an honest absence, not as a category (see ProjectOverviewView.tsx).
  unknown: 'Unclassified',
};

const SORTS = [
  { value: 'recent', label: 'Recent' },
  { value: 'name', label: 'Name' },
  { value: 'health', label: 'Health' },
] as const;

const LAYOUTS = [
  { value: 'list', label: 'List view', icon: 'Rows3' },
  { value: 'grid', label: 'Grid view', icon: 'LayoutGrid' },
] as const;

type SortKey = (typeof SORTS)[number]['value'];
type LayoutKey = (typeof LAYOUTS)[number]['value'];

function isSortKey(value: string): value is SortKey {
  return SORTS.some((option) => option.value === value);
}

function isLayoutKey(value: string): value is LayoutKey {
  return LAYOUTS.some((option) => option.value === value);
}

/* --------------------------------------------------------------------- view */

export default function ProjectsView() {
  const { state, dispatch } = usePrototype();
  const navigate = useNavigate();
  const [sort, setSort] = useState<SortKey>('recent');
  const [layout, setLayout] = useState<LayoutKey>('list');

  const query = state.projectQuery.trim();
  const filtered = selectFilteredProjects(state);

  const ordered = [...filtered].sort((a, b) => {
    const pinned = Number(selectIsPinned(state, b.id)) - Number(selectIsPinned(state, a.id));
    if (pinned !== 0) return pinned;
    if (sort === 'name') return a.name.localeCompare(b.name);
    if (sort === 'health') {
      // fix-cert-fabrication (F3) — UPDATED by fix-cert-rest (item 3): `health.score` is now
      // `number | null` (prototype-types.ts), so a project whose health was never measured carries
      // its own real `null` — checked directly here instead of the `hasMeasuredProjectDetail`
      // proxy this comparator used before the type could express it. `null` is UNKNOWN, not "the
      // worst score in the list": known-health projects sort by score as before, unknown ones are
      // grouped after them, never ranked against each other (stable: comparator returns 0).
      const aScore = a.health.score;
      const bScore = b.health.score;
      if ((aScore === null) !== (bScore === null)) return aScore !== null ? -1 : 1;
      if (aScore === null || bScore === null) return 0;
      return bScore - aScore;
    }
    return agoMinutes(a.lastActivity) - agoMinutes(b.lastActivity);
  });

  function selectProject(project: Project): void {
    dispatch({ type: 'project/activate', id: project.id });
    dispatch({ type: 'select', selection: { kind: 'project', id: project.id } });
  }

  function openProject(project: Project): void {
    selectProject(project);
    navigate('/project');
  }

  return (
    <div className="fw-projects">
      <header className="fw-projects__header">
        <div className="fw-projects__heading">
          <h1 className="fw-projects__title">Projects</h1>
          <p className="fw-projects__subtitle">
            {state.data.projects.length} project{state.data.projects.length === 1 ? '' : 's'}. Pinned ones
            stay on top, whatever the sort.
          </p>
        </div>

        <Toolbar label="Project filters" className="fw-projects__toolbar">
          <div className="fw-projects__search">
            <Icon name="Search" size="sm" className="fw-projects__search-icon" />
            <input
              id="fw-projects-search"
              className="fw-projects__search-input"
              type="text"
              autoComplete="off"
              spellCheck={false}
              aria-label="Filter projects by name, description or type"
              placeholder="Filter projects…"
              value={state.projectQuery}
              onChange={(event) => dispatch({ type: 'project/query', query: event.target.value })}
            />
            {query ? (
              <IconButton
                icon="X"
                label="Clear the filter"
                size="sm"
                onClick={() => dispatch({ type: 'project/query', query: '' })}
              />
            ) : null}
          </div>

          <ToolbarGroup divided>
            <SegmentedControl
              label="Sort projects"
              size="sm"
              options={SORTS}
              value={sort}
              onChange={(value) => {
                if (isSortKey(value)) setSort(value);
              }}
            />
          </ToolbarGroup>

          <ToolbarGroup divided>
            <SegmentedControl
              label="Project layout"
              size="sm"
              iconOnly
              options={LAYOUTS}
              value={layout}
              onChange={(value) => {
                if (isLayoutKey(value)) setLayout(value);
              }}
            />
          </ToolbarGroup>

          <Spacer />

          <Machine muted>
            {ordered.length} of {state.data.projects.length}
          </Machine>
        </Toolbar>
      </header>

      <div className="fw-projects__scroll fw-scroll">
        {ordered.length === 0 ? (
          <div className="fw-projects__empty">
            <EmptyState
              icon="SearchX"
              title="No project matches that filter."
              detail={`No project answers to “${query}”. Try a different name, description or type.`}
              action={
                <Button
                  variant="ghost"
                  size="sm"
                  icon="RotateCcw"
                  onClick={() => dispatch({ type: 'project/query', query: '' })}
                >
                  Clear the filter
                </Button>
              }
            />
          </div>
        ) : (
          <ul className={`fw-projects__list fw-projects__list--${layout}`}>
            {ordered.map((project) => {
              const pinned = selectIsPinned(state, project.id);
              const active = project.id === state.activeProjectId;
              // fix-cert-rest (item 1): agentCount/missionCount stay a shared, non-nullable
              // `number` (see prototype-types.ts's own handoff note), so hasMeasuredProjectDetail
              // is still the only signal for whether THEY are a real measurement or the
              // EMPTY_ACTIVE_PROJECT_DETAIL placeholder for a non-active, non-fixture project.
              // taskCount/health.score carry their own real `null` now (fix-cert-rest, item 3) and
              // are checked directly below instead.
              const detailKnown = hasMeasuredProjectDetail(project, state.activeProjectId);
              return (
                <li
                  key={project.id}
                  className="fw-projects__item"
                  data-active={active ? 'true' : undefined}
                >
                  <button
                    type="button"
                    className="fw-projects__body"
                    aria-current={active ? 'true' : undefined}
                    onClick={() => selectProject(project)}
                    onDoubleClick={() => openProject(project)}
                  >
                    <span className="fw-projects__glyph">
                      <Icon name={TYPE_ICON[project.type]} size="sm" />
                    </span>

                    <span className="fw-projects__main">
                      <span className="fw-projects__name fw-truncate">{project.name}</span>
                      {/* fix-placeholder: honest "—" fallback (this app's existing missing-value
                          convention) instead of blank space or leaked template syntax. */}
                      <span className="fw-projects__description">
                        {project.description.trim() !== '' ? project.description : '—'}
                      </span>
                    </span>

                    {/*
                      a11y-new: each count carried its meaning ONLY in `title`, which is a
                      mouse-hover affordance. Sighted users read the icon; a screen reader got a
                      bare number. That was tolerable while every number was a number — but several
                      of these now render `—` by design, so the reading became a row of unexplained
                      dashes. The labels below are visually hidden, so the frozen layout is
                      untouched and the icons stay the visual language.
                    */}
                    <span className="fw-projects__counts">
                      <span className="fw-projects__count" title="Conversations">
                        <Icon name="MessageSquare" size="xs" />
                        <span className="fw-visually-hidden">Conversations: </span>
                        <Machine muted>{project.conversationCount}</Machine>
                      </span>
                      <span className="fw-projects__count" title="Missions">
                        <Icon name="Flag" size="xs" />
                        <span className="fw-visually-hidden">Missions: </span>
                        {/* fix-cert-rest (item 1): same F3-class fabrication as taskCount/health
                            below — missionCount is the EMPTY_ACTIVE_PROJECT_DETAIL-adjacent `0`
                            placeholder for every non-active, non-fixture project. */}
                        <Machine muted>{detailKnown ? project.missionCount : '—'}</Machine>
                      </span>
                      <span className="fw-projects__count" title="Tasks">
                        <Icon name="ListChecks" size="xs" />
                        <span className="fw-visually-hidden">Tasks: </span>
                        {/* fix-cert-fabrication (F3) — UPDATED by fix-cert-rest (item 3): taskCount
                            is now `number | null` and carries its own honest signal directly. */}
                        <Machine muted>{project.taskCount ?? '—'}</Machine>
                      </span>
                      <span className="fw-projects__count" title="Agents">
                        <Icon name="Users" size="xs" />
                        <span className="fw-visually-hidden">Agents: </span>
                        {/* fix-cert-rest (item 1): same F3-class fabrication as missionCount above. */}
                        <Machine muted>{detailKnown ? project.agentCount : '—'}</Machine>
                      </span>
                    </span>

                    <span className="fw-projects__health">
                      {/* Neutral: the ember belongs to running progress, and a
                          health score is a standing figure, not progress. fix-cert-fabrication (F3)
                          — UPDATED by fix-cert-rest (item 3): health.score is now `number | null` and
                          carries its own honest signal directly, never a fabricated "Health 0%" meter. */}
                      {project.health.score !== null ? (
                        <Meter value={project.health.score} label="Health" showValue />
                      ) : (
                        <>
                          {/* a11y-new: the Meter branch carries its own "Health" label; this branch
                              was a bare dash with nothing naming it. */}
                          <span className="fw-visually-hidden">Health: not measured</span>
                          <Machine muted aria-hidden="true">
                            —
                          </Machine>
                        </>
                      )}
                    </span>

                    <span className="fw-projects__state">
                      <StatusBadge status={project.status} size="sm" />
                      <Machine muted>{project.lastActivity}</Machine>
                    </span>

                    <span className="fw-projects__type fg-machine">{TYPE_LABEL[project.type]}</span>
                  </button>

                  <div className="fw-projects__aside">
                    {/* One glyph, two states: a crossed-out pin would read as
                        "not pinned" at a glance, which is the opposite of true. */}
                    <IconButton
                      icon="Pin"
                      label={pinned ? `Unpin ${project.name}` : `Pin ${project.name}`}
                      size="sm"
                      active={pinned}
                      aria-pressed={pinned}
                      onClick={() => dispatch({ type: 'project/pin-toggle', id: project.id })}
                    />
                    <IconButton
                      icon="ArrowRight"
                      label={`Open ${project.name}`}
                      size="sm"
                      onClick={() => openProject(project)}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
