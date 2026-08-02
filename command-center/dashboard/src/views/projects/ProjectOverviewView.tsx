/**
 * Project overview — the workspace for `state.activeProjectId`.
 *
 * The screen a returning user lands on most, so it is dense but calm: one
 * header, one tab strip, and a two-column body that answers "what is the state
 * of this project" without needing a second click.
 *
 * Only the Overview tab carries content. Every other tab is a signpost to the
 * main view that owns that section — duplicating those surfaces here would mean
 * two places to keep honest instead of one.
 */

import './project-overview.css';

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button,
  EmptyState,
  Eyebrow,
  ExampleTag,
  Icon,
  Machine,
  Meter,
  Panel,
  StatusBadge,
  StatusDot,
  TabPanel,
  Tabs,
} from '@/components/primitives';
import { selectActiveProject, selectProjectConversations, usePrototype } from '@/prototype/state/prototype-store';
import { TASK_COLUMNS } from '@/prototype/types/prototype-types';
import type { ProjectType } from '@/prototype/types/prototype-types';
import { isProductionMode } from '@/config/mode';

/* ------------------------------------------------------------ local helpers */

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
  // Reads as an honest absence, not as a category. "Unclassified" says the profile never stated a
  // type Forge recognises — it does NOT claim the project is of some "unknown kind".
  unknown: 'Unclassified',
};

const ARTIFACT_ICON: Readonly<Record<string, string>> = {
  screenshot: 'Image',
  report: 'FileText',
  diagram: 'GitBranch',
  markdown: 'FileText',
  log: 'ScrollText',
  receipt: 'ReceiptText',
  proof: 'ShieldCheck',
};

interface SectionTab {
  readonly value: string;
  readonly label: string;
  readonly route: string;
  readonly icon: string;
  readonly title: string;
  readonly detail: string;
  readonly action: string;
}

const SECTION_TABS: readonly SectionTab[] = [
  {
    value: 'chat',
    label: 'Chat',
    route: '/chat',
    icon: 'MessageSquare',
    title: 'Conversations live in the Chat view.',
    detail:
      'The thread, the composer and the collapsible step blocks are all rendered there against the same example conversations.',
    action: 'Open chat',
  },
  {
    value: 'missions',
    label: 'Missions',
    route: '/mission',
    icon: 'Workflow',
    title: 'Missions live in Mission Control.',
    detail:
      'The run graph, its parallel lanes and the verify loop are drawn there, node by node, for the example run.',
    action: 'Open mission control',
  },
  {
    value: 'tasks',
    label: 'Tasks',
    route: '/tasks',
    icon: 'ListChecks',
    title: 'The task board lives in the Tasks view.',
    detail:
      'Kanban, table, work-package and phase layouts all read the same example board. The summary on the Overview tab is a digest of it.',
    action: 'Open tasks',
  },
  {
    value: 'agents',
    label: 'Agents',
    route: '/agents',
    icon: 'Users',
    title: 'The agent roster lives in the Agents view.',
    detail:
      'Group, permission level, effort tier, current task and verification state are shown there for all eighteen example agents.',
    action: 'Open agents',
  },
  {
    value: 'files',
    label: 'Files',
    route: '/files',
    icon: 'FolderTree',
    title: 'The working tree lives in the Files view.',
    detail:
      'An example tree with read-only diffs. Nothing on this machine is read — the file records are local example data.',
    action: 'Open files',
  },
  {
    value: 'artifacts',
    label: 'Artifacts',
    route: '/artifacts',
    icon: 'Paperclip',
    title: 'Artifacts live in the Artifacts view.',
    detail:
      'Reports, screenshots, diagrams, logs and the proof ledger, each with an example preview and the agent that produced it.',
    action: 'Open artifacts',
  },
  {
    value: 'tests',
    label: 'Tests',
    route: '/tests',
    icon: 'FlaskConical',
    title: 'Quality gates live in the Tests & Proof view.',
    detail:
      'Every gate, its example console output, and the ledger of accepted and rejected claims behind it.',
    action: 'Open tests & proof',
  },
  {
    value: 'activity',
    label: 'Activity',
    route: '/activity',
    icon: 'Activity',
    title: 'The full feed lives in the Activity view.',
    detail:
      'Forty example events in reverse-chronological order, filterable by kind, agent and status.',
    action: 'Open activity',
  },
  {
    value: 'settings',
    label: 'Settings',
    route: '/settings',
    icon: 'Settings2',
    title: 'Settings live in the Settings view.',
    detail:
      'Appearance, density, motion and the presentation-only local Claude Code link state — all workspace-wide rather than per project.',
    action: 'Open settings',
  },
];

/* --------------------------------------------------------------------- view */

export default function ProjectOverviewView() {
  const { state, dispatch } = usePrototype();
  const navigate = useNavigate();
  const [tab, setTab] = useState('overview');

  const project = selectActiveProject(state);

  if (!project) {
    return (
      <div className="fw-project fw-project--empty">
        <EmptyState
          icon="FolderSearch"
          title="No project is active."
          detail="Pick one in the project browser and it will open here."
          action={
            <Button variant="primary" size="sm" icon="ArrowRight" onClick={() => navigate('/projects')}>
              Open the project browser
            </Button>
          }
        />
      </div>
    );
  }

  const { agents, artifacts, gates, runs, tasks } = state.data;

  // Production renders real values or honest empty states; fixture mode keeps the
  // example copy the theme showcase and tests depend on.
  const production = isProductionMode();

  const conversations = selectProjectConversations(state, project.id);
  const projectRuns = runs.filter((run) => run.projectId === project.id);
  const activeRun = projectRuns.find((run) => run.status === 'running') ?? projectRuns[0];

  const attachedAgents = activeRun
    ? agents.filter((agent) => activeRun.agentIds.includes(agent.id))
    : agents.slice(0, project.agentCount);

  const columnCounts = TASK_COLUMNS.map((column) => ({
    column,
    count: tasks.filter((task) => (state.taskColumnOverrides[task.id] ?? task.column) === column).length,
  })).filter((entry) => entry.count > 0);
  // Bars are scaled against the busiest column, not the board total: at eight
  // columns a share-of-total bar is a row of identical stubs.
  const columnPeak = columnCounts.reduce((peak, entry) => Math.max(peak, entry.count), 1);

  const { passed, failed, skipped } = project.health.tests;
  const totalTests = passed + failed + skipped;
  const passRate = totalTests > 0 ? Math.round((passed / totalTests) * 100) : 0;

  const tabItems = [
    { value: 'overview', label: 'Overview' },
    ...SECTION_TABS.map((section) => ({
      value: section.value,
      label: section.label,
      count:
        section.value === 'chat'
          ? project.conversationCount
          : section.value === 'missions'
            ? project.missionCount
            : section.value === 'tasks'
              ? // fix-cert-rest (item 3): taskCount is now `number | null` (prototype-types.ts);
                // `TabItem.count` only accepts a real `number` — the badge simply does not render
                // when unmeasured (`Tabs.tsx` already hides it for any non-number `count`), the
                // same absence-as-no-badge convention this tab strip already uses for `undefined`.
                (project.taskCount ?? undefined)
              : section.value === 'agents'
                ? project.agentCount
                : undefined,
    })),
  ];

  const activeSection = SECTION_TABS.find((section) => section.value === tab);

  return (
    <div className="fw-project">
      {/* ================================================================ header */}
      <header className="fw-project__header">
        <div className="fw-project__identity">
          <span className="fw-project__glyph">
            <Icon name={TYPE_ICON[project.type]} size="lg" />
          </span>
          <div className="fw-project__naming">
            <Eyebrow>{TYPE_LABEL[project.type]}</Eyebrow>
            <h1 className="fw-project__title">{project.name}</h1>
            {/* fix-placeholder: the gateway now returns an absent (empty) goal rather than
                unfilled scaffold text — the honest "—" fallback here matches this app's existing
                missing-value convention (see e.g. SettingsView, MissionControlView) instead of
                rendering blank space or template syntax. */}
            <p className="fw-project__description">{project.description.trim() !== '' ? project.description : '—'}</p>
          </div>
          <div className="fw-project__state">
            <StatusBadge status={project.status} />
            <span className="fw-project__activity">
              <Icon name="Clock" size="xs" />
              <Machine muted>{project.lastActivity}</Machine>
            </span>
          </div>
        </div>

        <dl className="fw-project__meta">
          <div className="fw-project__meta-item">
            <dt className="fw-project__meta-key">Local path</dt>
            <dd className="fw-project__meta-value">
              <Machine className="fw-truncate">{project.path}</Machine>
            </dd>
          </div>
          <div className="fw-project__meta-item">
            <dt className="fw-project__meta-key">Template</dt>
            <dd className="fw-project__meta-value">
              <Machine>{project.templateVersion}</Machine>
            </dd>
          </div>
          <div className="fw-project__meta-item">
            <dt className="fw-project__meta-key">Registry</dt>
            <dd className="fw-project__meta-value">
              <Machine muted>{project.id}</Machine>
              <ExampleTag detail="Example project record. No registry was read and no path on disk was touched." />
            </dd>
          </div>
        </dl>

        <Tabs
          items={tabItems}
          value={tab}
          onChange={setTab}
          ariaLabel="Project sections"
          idPrefix="fw-project"
          className="fw-project__tabs"
        />
      </header>

      {/* ============================================================== overview */}
      <div className="fw-project__scroll fw-scroll">
        <TabPanel idPrefix="fw-project" value="overview" active={tab === 'overview'}>
          <div className="fw-project__grid">
            {/* ------------------------------------------------------ main column */}
            <div className="fw-project__column">
              <Panel
                title="Conversations"
                subtitle={`${conversations.length} thread${conversations.length === 1 ? '' : 's'} in this project.`}
                actions={
                  <Button variant="quiet" size="sm" iconRight="ArrowRight" onClick={() => navigate('/chat')}>
                    Open chat
                  </Button>
                }
                padded={false}
              >
                {conversations.length === 0 ? (
                  <EmptyState
                    compact
                    icon="MessageSquareDashed"
                    title={production ? 'No conversations in this project yet.' : 'No example conversation for this project.'}
                    detail={
                      production
                        ? 'Start one in the chat view and it will appear here.'
                        : 'The example dataset only carries threads for some of the seven projects.'
                    }
                  />
                ) : (
                  <ul className="fw-project__rows">
                    {conversations.map((conversation) => (
                      <li key={conversation.id}>
                        <button
                          type="button"
                          className="fw-project__row"
                          onClick={() => {
                            dispatch({ type: 'conversation/activate', id: conversation.id });
                            navigate('/chat');
                          }}
                        >
                          <span className="fw-project__row-glyph">
                            <Icon name="MessageSquare" size="sm" />
                          </span>
                          <span className="fw-project__row-main">
                            <span className="fw-project__row-title fw-truncate">{conversation.title}</span>
                            <span className="fw-project__row-detail">
                              <Machine muted>{conversation.messageCount} messages</Machine>
                            </span>
                          </span>
                          <Machine muted>{conversation.updatedAt}</Machine>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>

              <Panel
                title="Missions"
                subtitle={
                  production
                    ? `${projectRuns.length} run${projectRuns.length === 1 ? '' : 's'} recorded for this project.`
                    : `${project.missionCount} example missions recorded, ${projectRuns.length} kept in full detail.`
                }
                actions={
                  <Button variant="quiet" size="sm" iconRight="ArrowRight" onClick={() => navigate('/mission')}>
                    Mission control
                  </Button>
                }
                padded={false}
              >
                {projectRuns.length === 0 ? (
                  <EmptyState
                    compact
                    icon="Workflow"
                    title={production ? 'No runs for this project yet.' : 'No run graph kept for this project.'}
                    detail={
                      production
                        ? 'Runs will appear here as they start.'
                        : 'Only four example runs carry a full graph; the rest exist as counts on the project record.'
                    }
                  />
                ) : (
                  <ul className="fw-project__rows">
                    {projectRuns.map((run) => (
                      <li key={run.id}>
                        <button
                          type="button"
                          className="fw-project__row fw-project__row--stacked"
                          onClick={() => navigate('/mission')}
                        >
                          <span className="fw-project__run-head">
                            <StatusBadge status={run.status} size="sm" />
                            <Machine muted>{run.id}</Machine>
                            <Machine muted>{run.startedAt}</Machine>
                          </span>
                          <span className="fw-project__run-goal">{run.goal}</span>
                          <span className="fw-project__run-meta">
                            <Machine muted>{run.duration}</Machine>
                            <Machine muted>{run.workPackageIds.length} work packages</Machine>
                            <Machine muted>{run.agentIds.length} agents</Machine>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>

              <Panel
                title="Task summary"
                subtitle={
                  production
                    ? 'Tasks by column, from the live board.'
                    : // fix-cert-rest (item 3): taskCount is now `number | null` — fixture data
                      // always carries a real number here, but the fallback keeps this honest
                      // even if that invariant is ever broken.
                      `${project.taskCount ?? '—'} tasks on this project. The breakdown below is the example mission board.`
                }
                actions={<ExampleTag detail="Column counts come from the shared example task board, not from a per-project board." />}
              >
                <ul className="fw-project__columns">
                  {columnCounts.map((entry) => (
                    <li key={entry.column} className="fw-project__column-row">
                      <span className="fw-project__column-name">{entry.column.replace('-', ' ')}</span>
                      <span className="fw-project__column-bar" aria-hidden="true">
                        <span
                          className="fw-project__column-fill"
                          style={{ inlineSize: `${Math.round((entry.count / columnPeak) * 100)}%` }}
                        />
                      </span>
                      <Machine muted>{entry.count}</Machine>
                    </li>
                  ))}
                </ul>
              </Panel>

              <Panel
                title="Recent artifacts"
                subtitle={production ? 'Evidence produced by runs in this project.' : 'Evidence produced by the example mission.'}
                actions={
                  <Button variant="quiet" size="sm" iconRight="ArrowRight" onClick={() => navigate('/artifacts')}>
                    All artifacts
                  </Button>
                }
                padded={false}
              >
                <ul className="fw-project__rows">
                  {artifacts.slice(0, 5).map((artifact) => (
                    <li key={artifact.id}>
                      <button
                        type="button"
                        className="fw-project__row"
                        onClick={() =>
                          dispatch({ type: 'select', selection: { kind: 'artifact', id: artifact.id } })
                        }
                      >
                        <span className="fw-project__row-glyph">
                          <Icon name={ARTIFACT_ICON[artifact.kind] ?? 'File'} size="sm" />
                        </span>
                        <span className="fw-project__row-main">
                          <Machine className="fw-project__row-title fw-truncate">{artifact.name}</Machine>
                          <span className="fw-project__row-detail fw-truncate">{artifact.producedBy}</span>
                        </span>
                        <Machine muted>{artifact.size}</Machine>
                      </button>
                    </li>
                  ))}
                </ul>
              </Panel>
            </div>

            {/* ------------------------------------------------------ side column */}
            <div className="fw-project__column">
              <Panel
                title="Health"
                subtitle={production ? 'A composite of the figures below.' : 'A composite of the example figures below.'}
              >
                <div className="fw-project__health">
                  {/* Neutral on purpose: the ember is reserved for progress that
                      is actually running, and a health score is not progress. fix-cert-rest
                      (item 3): health.score is now `number | null` — '—' when unmeasured. */}
                  {project.health.score !== null ? (
                    <Meter value={project.health.score} label="Health score" showValue />
                  ) : (
                    <Machine muted>—</Machine>
                  )}
                  <dl className="fw-project__figures">
                    <div className="fw-project__figure">
                      <dt>Open tickets</dt>
                      <dd>
                        <Machine>{project.health.openTickets}</Machine>
                      </dd>
                    </div>
                    <div className="fw-project__figure">
                      <dt>Blockers</dt>
                      <dd>
                        <Machine>{project.health.blockers}</Machine>
                      </dd>
                    </div>
                    <div className="fw-project__figure">
                      <dt>Failing tests</dt>
                      <dd>
                        <Machine>{failed}</Machine>
                      </dd>
                    </div>
                  </dl>
                </div>
              </Panel>

              <Panel
                title="Tests"
                subtitle={production ? 'Test suite result for this project.' : 'Example suite result for this project.'}
                actions={
                  <Button variant="quiet" size="sm" iconRight="ArrowRight" onClick={() => navigate('/tests')}>
                    Tests &amp; proof
                  </Button>
                }
              >
                <div className="fw-project__tests">
                  <ul className="fw-project__test-figures">
                    <li>
                      <Machine className="fw-project__test-value">{passed}</Machine>
                      <span>passed</span>
                    </li>
                    <li>
                      <Machine className="fw-project__test-value">{failed}</Machine>
                      <span>failed</span>
                    </li>
                    <li>
                      <Machine className="fw-project__test-value">{skipped}</Machine>
                      <span>skipped</span>
                    </li>
                  </ul>
                  <Meter value={passRate} label="Pass rate" showValue />
                  <ul className="fw-project__gates">
                    {gates.slice(0, 6).map((gate) => (
                      <li key={gate.id} className="fw-project__gate">
                        <StatusDot status={gate.status} />
                        <span className="fw-project__gate-name fw-truncate">{gate.name}</span>
                        <Machine muted>{gate.duration}</Machine>
                      </li>
                    ))}
                  </ul>
                </div>
              </Panel>

              <Panel
                title="Attached agents"
                subtitle={
                  activeRun
                    ? `Dispatched on ${activeRun.id}.`
                    : `${project.agentCount} agents recorded on this project.`
                }
                actions={
                  <Button variant="quiet" size="sm" iconRight="ArrowRight" onClick={() => navigate('/agents')}>
                    All agents
                  </Button>
                }
                padded={false}
              >
                <ul className="fw-project__rows">
                  {attachedAgents.slice(0, 8).map((agent) => (
                    <li key={agent.id}>
                      <button
                        type="button"
                        className="fw-project__row fw-project__row--tight"
                        onClick={() => dispatch({ type: 'select', selection: { kind: 'agent', id: agent.id } })}
                      >
                        <StatusDot status={agent.status} />
                        <span className="fw-project__row-main">
                          <Machine className="fw-project__row-title fw-truncate">{agent.name}</Machine>
                          <span className="fw-project__row-detail fw-truncate">
                            {agent.currentTask ?? (production ? 'No task assigned.' : 'Idle — no task assigned in the example run.')}
                          </span>
                        </span>
                        <span className="fw-project__agent-group fg-machine">{agent.group}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </Panel>

              <Panel title="Attached skills" subtitle="Playbooks this project is cut from.">
                {project.skills.length === 0 ? (
                  <EmptyState
                    compact
                    icon="BookOpen"
                    title="No skills attached"
                    detail="This project has no playbook skills recorded yet."
                  />
                ) : (
                  <ul className="fw-project__skills">
                    {project.skills.map((skill) => (
                      <li key={skill} className="fw-project__skill">
                        <Icon name="BookOpen" size="xs" />
                        <Machine>{skill}</Machine>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
            </div>
          </div>
        </TabPanel>

        {/* ----------------------------------------------------- signpost tabs */}
        {activeSection ? (
          <TabPanel idPrefix="fw-project" value={activeSection.value} active>
            <div className="fw-project__signpost">
              <Panel
                title={activeSection.label}
                subtitle="This section is rendered once, in the view that owns it."
              >
                <EmptyState
                  icon={activeSection.icon}
                  title={activeSection.title}
                  detail={production ? 'Open it to work with the live data for this project.' : activeSection.detail}
                  action={
                    <Button
                      variant="primary"
                      size="sm"
                      iconRight="ArrowRight"
                      onClick={() => navigate(activeSection.route)}
                    >
                      {activeSection.action}
                    </Button>
                  }
                />
              </Panel>
            </div>
          </TabPanel>
        ) : null}
      </div>
    </div>
  );
}
