/**
 * Home — the landing surface of the Forge Workspace prototype.
 *
 * A place to resume from, not an analytics dashboard. In production every count
 * is read from the live store (projects, conversations, active runs, agents), or
 * shown as an honest empty state; in fixture mode the numbers come from the local
 * example dataset. The quick-start cards fire a toast and do nothing else.
 *
 * Navigation goes through the router the shell mounts (HashRouter, so a built
 * prototype opens from a file:// path). A view names a destination and nothing
 * more — it never imports the shell itself.
 */

import './home.css';

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button,
  EmptyState,
  Eyebrow,
  ExampleTag,
  Icon,
  IconButton,
  KeyHint,
  Machine,
  Meter,
  Panel,
  StatusBadge,
} from '@/components/primitives';
import { nextToastId, selectFilteredProjects, usePrototype } from '@/prototype/state/prototype-store';
import { pollProjectInstall } from '@/components/shell/gateway-actions';
import type { ProjectType, StatusKey } from '@/prototype/types/prototype-types';
import { isProductionMode } from '@/config/mode';
import { NewProjectDialog } from '@/components/shell/NewProjectDialog';

/* ------------------------------------------------------------------ local helpers */

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
 * `Conversation.updatedAt` is still a real ISO timestamp. `Project.lastActivity` is NOT any more —
 * the adapter now formats it to a relative label at the source, because a 24-character ISO string
 * was being truncated inside a meta slot sized for "4 min ago". So both branches below are real
 * production paths now, not "ISO in production, relative for fixtures". The adapter deliberately
 * emits the exact "<number> <unit word>" shape this parser accepts, keeping this sort correct
 * without an edit here — a contract between two files, so do not change either format alone.
 */
function agoMinutes(label: string): number {
  const parsed = Date.parse(label);
  if (!Number.isNaN(parsed)) return Math.max(0, (Date.now() - parsed) / 60000);
  const match = /^(\d+)\s+([a-z]+)/.exec(label.trim().toLowerCase());
  if (!match) return 0;
  return Number(match[1]) * (AGO_UNITS[match[2]] ?? 1);
}

/** First readable prose line of an example markdown body, trimmed for a card. */
function plainSnippet(markdown: string, max = 150): string {
  const line = markdown
    .split('\n')
    .map((raw) => raw.trim())
    .find(
      (raw) =>
        raw.length > 0 &&
        !raw.startsWith('#') &&
        !raw.startsWith('|') &&
        !raw.startsWith('```') &&
        !raw.startsWith('- ') &&
        !raw.startsWith('> '),
    );
  const text = (line ?? '').replace(/[*`_]/g, '');
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
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

const ARTIFACT_ICON: Readonly<Record<string, string>> = {
  screenshot: 'Image',
  report: 'FileText',
  diagram: 'GitBranch',
  markdown: 'FileText',
  log: 'ScrollText',
  receipt: 'ReceiptText',
  proof: 'ShieldCheck',
};

const EVENT_ICON: Readonly<Record<string, string>> = {
  mission: 'Flag',
  'work-package': 'Package',
  agent: 'Bot',
  task: 'ListChecks',
  artifact: 'Paperclip',
  test: 'FlaskConical',
  verify: 'ShieldCheck',
  review: 'Eye',
  system: 'Activity',
};

interface Template {
  readonly id: string;
  readonly name: string;
  readonly icon: string;
  readonly detail: string;
}

const TEMPLATES: readonly Template[] = [
  { id: 'website', name: 'Website', icon: 'Globe', detail: 'Landing page or studio site, cut from the monochrome kit.' },
  { id: 'full-stack', name: 'Full-stack app', icon: 'Layers', detail: 'Frontend, API, database and auth planned as one mission.' },
  { id: 'automation', name: 'Automation', icon: 'Workflow', detail: 'Scheduled jobs and webhooks, retry policy required.' },
  { id: 'chatbot', name: 'Chatbot', icon: 'MessagesSquare', detail: 'Source-aware answers, or an honest "I do not know".' },
  { id: 'scraper', name: 'Scraper', icon: 'Radar', detail: 'Public sources only, rate limited, draft-only output.' },
  { id: 'research', name: 'Research', icon: 'FlaskConical', detail: 'A question, a method, and findings marked provisional.' },
];

/**
 * A cell of the workspace overview strip. In production the strip carries only
 * counts with a real source in the live data (projects, conversations, active
 * runs, agents); figures with no real source are omitted rather than invented. In
 * fixture mode it keeps the original example strip.
 */
interface OverviewCell {
  readonly value: string;
  readonly label: string;
}

/**
 * A calm, honest greeting subtitle built from real counts only. No invented
 * mission narrative: with no projects it is an orientation line; otherwise it
 * states the project count and whether anything is actually running.
 */
function productionGreetingLead(projectCount: number, activeRuns: number): string {
  if (projectCount === 0) {
    return 'No projects in the workspace yet. Start your first one from a template below.';
  }
  const projectWord = projectCount === 1 ? 'project' : 'projects';
  if (activeRuns === 0) {
    return `${projectCount} ${projectWord} in the workspace. Nothing is running right now.`;
  }
  const runWord = activeRuns === 1 ? 'run' : 'runs';
  return `${projectCount} ${projectWord} in the workspace, ${activeRuns} ${runWord} active right now.`;
}

/* --------------------------------------------------------------------- view */

export default function HomeView() {
  const { state, dispatch } = usePrototype();
  const navigate = useNavigate();
  const { projects, conversations, runs, artifacts, events, agents, gates, proof, tasks } = state.data;

  // In production the view renders real values or honest empty states; in fixture
  // mode it keeps the example chrome the theme showcase and tests depend on.
  const production = isProductionMode();
  const activeRunCount = runs.filter((run) => run.status === 'running').length;

  // build-lastdemos: the "Start something" template cards open the SAME real
  // `NewProjectDialog` `Sidebar` uses (never a duplicate), seeded with the
  // template's own name as a starting suggestion — see NewProjectDialog's
  // header for exactly what "the template only names the project" means.
  const [templateDialog, setTemplateDialog] = useState<{ readonly open: boolean; readonly name: string }>({
    open: false,
    name: '',
  });

  const query = state.projectQuery.trim();
  const matchedProjects = query ? selectFilteredProjects(state).slice(0, 4) : [];
  const matchedConversations = query
    ? conversations.filter((c) => c.title.toLowerCase().includes(query.toLowerCase())).slice(0, 3)
    : [];

  const recentConversations = [...conversations].sort(
    (a, b) => agoMinutes(a.updatedAt) - agoMinutes(b.updatedAt),
  );
  const recentProjects = [...projects].sort((a, b) => {
    const pinned = Number(b.pinned) - Number(a.pinned);
    return pinned !== 0 ? pinned : agoMinutes(a.lastActivity) - agoMinutes(b.lastActivity);
  });

  const resumeConversation = recentConversations[0];
  const resumeRun = runs.find((r) => r.status === 'running') ?? runs[0];
  const resumeProject = projects.find((p) => p.id === resumeConversation?.projectId);
  const resumeRunProject = projects.find((p) => p.id === resumeRun?.projectId);

  const runTasks = resumeRun ? tasks.filter((t) => resumeRun.workPackageIds.includes(t.workPackageId)) : [];
  const runProgress =
    runTasks.length > 0
      ? Math.round(runTasks.reduce((sum, t) => sum + t.progress, 0) / runTasks.length)
      : 0;

  const lastMessage = resumeConversation?.messages[resumeConversation.messages.length - 1];

  const pending = [
    ...proof
      .filter((entry) => entry.verdict === 'pending')
      .map((entry) => ({
        id: entry.id,
        status: 'verify' as StatusKey,
        claim: entry.claim,
        who: entry.agent,
        machine: entry.command,
      })),
    ...gates
      .filter((gate) => gate.status === 'verify')
      .map((gate) => ({
        id: gate.id,
        status: gate.status,
        claim: `${gate.name} is holding ${gate.evidenceCount} artifacts for a second look`,
        who: 'Verify Agent',
        machine: `${gate.id} · last run ${gate.lastRun}`,
      })),
  ].slice(0, 4);

  const trouble = [
    ...agents
      .filter((a) => a.status === 'failed' || a.status === 'blocked')
      .map((a) => ({
        id: a.id,
        status: a.status,
        title: a.name,
        detail: a.currentTask ?? a.summary,
        origin: a.id,
      })),
    ...projects
      .filter((p) => p.status === 'failed' || p.status === 'blocked')
      .map((p) => ({ id: p.id, status: p.status, title: p.name, detail: p.description, origin: p.id })),
    ...gates
      .filter((g) => g.status === 'failed' || g.status === 'blocked')
      .map((g) => ({
        id: g.id,
        status: g.status,
        title: g.name,
        detail: `Quality gate has not produced a passing result since ${g.lastRun}.`,
        origin: g.id,
      })),
  ].slice(0, 5);

  // Production: only counts with a real source in the live data this view already
  // receives. Metrics with no real source in this build (skills available, tests
  // passed, pending reviews — their backing operations are UNAVAILABLE) are
  // omitted rather than fabricated. A real 0 beats a fake 1,185.
  const overview: readonly OverviewCell[] = production
    ? [
        { value: String(projects.length), label: projects.length === 1 ? 'project' : 'projects' },
        {
          value: String(conversations.length),
          label: conversations.length === 1 ? 'conversation' : 'conversations',
        },
        { value: String(activeRunCount), label: activeRunCount === 1 ? 'active run' : 'active runs' },
        { value: String(agents.length), label: agents.length === 1 ? 'agent' : 'agents' },
      ]
    : [
        { value: String(projects.length), label: 'projects' },
        { value: '2', label: 'running missions' },
        { value: String(agents.length), label: 'agents available' },
        { value: '22', label: 'skills available' },
        { value: '1,185', label: 'example tests passed' },
        { value: '3', label: 'pending reviews' },
      ];

  function openProject(id: string): void {
    dispatch({ type: 'project/activate', id });
    dispatch({ type: 'select', selection: { kind: 'project', id } });
    navigate('/project');
  }

  function openConversation(id: string): void {
    dispatch({ type: 'conversation/activate', id });
    navigate('/chat');
  }

  /** Opens the real "New project" dialog seeded with one template's name. */
  function openTemplateDialog(template: Template): void {
    setTemplateDialog({ open: true, name: template.name });
  }

  /** The dialog created a real project — close it, then reuse the same open/activate flow the
   *  sidebar's own "New project" button already uses (openProject above). Install feedback mirrors
   *  Sidebar's handleProjectCreated exactly: without it, a template-created project would install
   *  Forge in the background with no outcome ever reported — the same silent gap the sidebar path
   *  just closed, alive on the second entrance to the identical flow. */
  function handleTemplateProjectCreated(id: string): void {
    setTemplateDialog((current) => ({ ...current, open: false }));
    openProject(id);
    dispatch({
      type: 'toast/push',
      toast: { id: nextToastId(), title: 'Project created', detail: 'Forge is being installed…', icon: 'Loader' },
    });
    pollProjectInstall(id, (result) => {
      const installed = result.state === 'installed';
      dispatch({
        type: 'toast/push',
        toast: {
          id: nextToastId(),
          title: installed ? 'Forge installed' : 'Forge install failed',
          detail: installed ? `Forge installed for ${id}.` : (result.reason ?? result.note ?? 'The Forge installer did not complete.'),
          icon: installed ? 'CircleCheck' : 'TriangleAlert',
        },
      });
    });
  }

  return (
    <div className="fw-home">
      <div className="fw-home__scroll fw-scroll">
        <div className="fw-home__inner">
          {/* ------------------------------------------------------ greeting */}
          <header className="fw-home__greeting">
            <h1 className="fw-home__title">Good to see you back.</h1>
            {production ? (
              <p className="fw-home__lead">{productionGreetingLead(projects.length, activeRunCount)}</p>
            ) : (
              <>
                <p className="fw-home__lead">
                  Two missions are running, three reviews are waiting, and the barbershop booking build is
                  one honest screenshot away from closing.
                </p>
                <p className="fw-home__disclosure">
                  <ExampleTag detail="Everything on this screen is local example data. No runtime, session or registry is attached." />
                  <span>Everything below is local example data — nothing is connected.</span>
                </p>
              </>
            )}
          </header>

          {/* -------------------------------------------------------- search */}
          <section className="fw-home__search" role="search" aria-label="Search the workspace">
            <div className="fw-home__search-field">
              <Icon name="Search" size="sm" className="fw-home__search-icon" />
              <input
                id="fw-home-search"
                className="fw-home__search-input"
                type="text"
                autoComplete="off"
                spellCheck={false}
                aria-label="Search projects, conversations and missions"
                placeholder="Search projects, conversations and missions"
                value={state.projectQuery}
                onChange={(event) => dispatch({ type: 'project/query', query: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') navigate('/projects');
                }}
              />
              {query ? (
                <IconButton
                  icon="X"
                  label="Clear the search"
                  size="sm"
                  onClick={() => dispatch({ type: 'project/query', query: '' })}
                />
              ) : (
                <KeyHint keys={['Ctrl', 'K']} />
              )}
            </div>

            {query ? (
              <div className="fw-home__matches">
                <p className="fw-home__matches-head">
                  <Machine muted>
                    {matchedProjects.length + matchedConversations.length} match
                    {matchedProjects.length + matchedConversations.length === 1 ? '' : 'es'}
                  </Machine>
                  <span>Press Enter to open the project browser.</span>
                </p>
                {matchedProjects.length + matchedConversations.length === 0 ? (
                  <p className="fw-home__matches-empty">
                    {production ? 'Nothing matches that.' : 'Nothing in the example dataset matches that.'}
                  </p>
                ) : (
                  <ul className="fw-home__matches-list">
                    {matchedProjects.map((project) => (
                      <li key={project.id}>
                        <button
                          type="button"
                          className="fw-home__match"
                          onClick={() => openProject(project.id)}
                        >
                          <Icon name={TYPE_ICON[project.type]} size="sm" />
                          <span className="fw-home__match-label fw-truncate">{project.name}</span>
                          <Machine muted>project</Machine>
                        </button>
                      </li>
                    ))}
                    {matchedConversations.map((conversation) => (
                      <li key={conversation.id}>
                        <button
                          type="button"
                          className="fw-home__match"
                          onClick={() => openConversation(conversation.id)}
                        >
                          <Icon name="MessageSquare" size="sm" />
                          <span className="fw-home__match-label fw-truncate">{conversation.title}</span>
                          <Machine muted>conversation</Machine>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : null}
          </section>

          {/* ----------------------------------------------- system overview */}
          <section className="fw-home__system" aria-label="Workspace overview">
            <ul className="fw-home__system-list">
              {overview.map((cell) => (
                <li key={cell.label} className="fw-home__system-cell">
                  <Machine className="fw-home__system-value">{cell.value}</Machine>
                  <span className="fw-home__system-label">{cell.label}</span>
                </li>
              ))}
            </ul>
          </section>

          {/* ---------------------------------------------- continue working */}
          <Panel
            flush
            padded={false}
            title="Continue working"
            subtitle="Where you left the workspace last."
            className="fw-home__section"
          >
            <div className="fw-home__resume">
              {resumeConversation ? (
                <article className="fw-home__resume-card">
                  <header className="fw-home__resume-head">
                    <Eyebrow>Last conversation</Eyebrow>
                    <Machine muted>{resumeConversation.updatedAt}</Machine>
                  </header>
                  <h3 className="fw-home__resume-title">{resumeConversation.title}</h3>
                  {lastMessage ? (
                    <p className="fw-home__resume-body">{plainSnippet(lastMessage.body)}</p>
                  ) : null}
                  <footer className="fw-home__resume-foot">
                    <span className="fw-home__resume-meta">
                      <Icon name="MessageSquare" size="xs" />
                      <Machine muted>{resumeConversation.messageCount} messages</Machine>
                    </span>
                    {resumeProject ? (
                      <span className="fw-home__resume-meta">
                        <Icon name={TYPE_ICON[resumeProject.type]} size="xs" />
                        <span className="fw-truncate">{resumeProject.name}</span>
                      </span>
                    ) : null}
                    <Button
                      variant="primary"
                      size="sm"
                      icon="CornerDownLeft"
                      onClick={() => openConversation(resumeConversation.id)}
                    >
                      Resume
                    </Button>
                  </footer>
                </article>
              ) : null}

              {resumeRun ? (
                <article className="fw-home__resume-card">
                  <header className="fw-home__resume-head">
                    <Eyebrow>Active mission</Eyebrow>
                    <StatusBadge status={resumeRun.status} size="sm" />
                  </header>
                  <h3 className="fw-home__resume-title">{resumeRun.goal}</h3>
                  <div className="fw-home__resume-meter">
                    <Meter
                      value={runProgress}
                      label={production ? 'Task progress' : 'Example task progress'}
                      tone={resumeRun.status === 'running' ? 'accent' : 'default'}
                      showValue
                    />
                  </div>
                  <footer className="fw-home__resume-foot">
                    <Machine muted>{resumeRun.id}</Machine>
                    <span className="fw-home__resume-meta">
                      <Icon name="Timer" size="xs" />
                      <Machine muted>{resumeRun.duration}</Machine>
                    </span>
                    <span className="fw-home__resume-meta">
                      <Icon name="Users" size="xs" />
                      <Machine muted>{resumeRun.agentIds.length} agents</Machine>
                    </span>
                    {resumeRunProject ? (
                      <span className="fw-home__resume-meta fw-truncate">{resumeRunProject.name}</span>
                    ) : null}
                    <Button size="sm" icon="Workflow" onClick={() => navigate('/mission')}>
                      Open mission control
                    </Button>
                  </footer>
                </article>
              ) : null}
            </div>
          </Panel>

          {/* ------------------------------------------- projects + convos */}
          <div className="fw-home__pair">
            <Panel
              flush
              padded={false}
              title="Recent projects"
              subtitle="Pinned first, then by last activity."
              actions={
                <Button variant="quiet" size="sm" iconRight="ArrowRight" onClick={() => navigate('/projects')}>
                  All projects
                </Button>
              }
              className="fw-home__section"
            >
              {recentProjects.length === 0 ? (
                <EmptyState
                  compact
                  icon="FolderSearch"
                  title="No projects yet"
                  detail="Projects will appear here once the workspace has one."
                />
              ) : (
              <ul className="fw-home__list">
                {recentProjects.slice(0, 4).map((project) => (
                  <li key={project.id}>
                    <button
                      type="button"
                      className="fw-home__row fw-home__row--project"
                      onClick={() => openProject(project.id)}
                    >
                      <span className="fw-home__row-glyph">
                        <Icon name={TYPE_ICON[project.type]} size="sm" />
                      </span>
                      <span className="fw-home__row-main">
                        <span className="fw-home__row-title fw-truncate">{project.name}</span>
                        <span className="fw-home__row-detail fw-truncate">{project.description}</span>
                      </span>
                      <span className="fw-home__row-side">
                        {project.pinned ? (
                          <Icon name="Pin" size="xs" className="fw-home__row-pin" label="Pinned" />
                        ) : null}
                        <StatusBadge status={project.status} size="sm" />
                        <Machine muted>{project.lastActivity}</Machine>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              )}
            </Panel>

            <Panel
              flush
              padded={false}
              title="Recent conversations"
              subtitle="The threads still warm."
              actions={
                <Button variant="quiet" size="sm" iconRight="ArrowRight" onClick={() => navigate('/chat')}>
                  Open chat
                </Button>
              }
              className="fw-home__section"
            >
              {recentConversations.length === 0 ? (
                <EmptyState
                  compact
                  icon="MessageSquareDashed"
                  title="No conversations yet"
                  detail="Start one from the chat view and it will appear here."
                />
              ) : (
              <ul className="fw-home__list">
                {recentConversations.slice(0, 5).map((conversation) => {
                  const owner = projects.find((p) => p.id === conversation.projectId);
                  return (
                    <li key={conversation.id}>
                      <button
                        type="button"
                        className="fw-home__row"
                        onClick={() => openConversation(conversation.id)}
                      >
                        <span className="fw-home__row-glyph">
                          <Icon name="MessageSquare" size="sm" />
                        </span>
                        <span className="fw-home__row-main">
                          <span className="fw-home__row-title fw-truncate">{conversation.title}</span>
                          <span className="fw-home__row-detail fw-truncate">
                            {owner ? owner.name : production ? 'No project' : 'Example project'}
                          </span>
                        </span>
                        <span className="fw-home__row-side">
                          <Machine muted>{conversation.messageCount} msg</Machine>
                          <Machine muted>{conversation.updatedAt}</Machine>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              )}
            </Panel>
          </div>

          {/* ------------------------------------------------ active missions */}
          <Panel
            flush
            padded={false}
            title="Active missions"
            subtitle={production ? 'Runs across the workspace.' : 'Example runs across the workspace.'}
            actions={
              <Button variant="quiet" size="sm" iconRight="ArrowRight" onClick={() => navigate('/mission')}>
                Mission control
              </Button>
            }
            className="fw-home__section"
          >
            {runs.length === 0 ? (
              <EmptyState
                compact
                icon="Workflow"
                title="No runs yet"
                detail="Runs will appear here as they start."
              />
            ) : (
            <ul className="fw-home__missions">
              {runs.map((run) => {
                const owner = projects.find((p) => p.id === run.projectId);
                const own = tasks.filter((t) => run.workPackageIds.includes(t.workPackageId));
                const progress =
                  own.length > 0 ? Math.round(own.reduce((sum, t) => sum + t.progress, 0) / own.length) : 0;
                return (
                  <li key={run.id} className="fw-home__mission">
                    <div className="fw-home__mission-head">
                      <StatusBadge status={run.status} size="sm" />
                      <Machine muted>{run.id}</Machine>
                      <span className="fw-home__mission-project fw-truncate">
                        {owner ? owner.name : production ? 'No project' : 'Example project'}
                      </span>
                    </div>
                    <p className="fw-home__mission-goal">{run.goal}</p>
                    <div className="fw-home__mission-foot">
                      <Meter
                        value={progress}
                        label={production ? 'Task progress' : 'Example task progress'}
                        tone={run.status === 'running' ? 'accent' : 'default'}
                        showValue
                      />
                      <span className="fw-home__mission-meta">
                        <Machine muted>{run.duration}</Machine>
                        <Machine muted>{run.workPackageIds.length} WP</Machine>
                        <Machine muted>{run.agentIds.length} agents</Machine>
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
            )}
          </Panel>

          {/* --------------------------------------------------- quick start */}
          <Panel
            flush
            padded={false}
            title="Start something"
            subtitle="Six shapes Forge already knows how to plan."
            className="fw-home__section"
          >
            <ul className="fw-home__templates">
              {TEMPLATES.map((template) => (
                <li key={template.id}>
                  <button
                    type="button"
                    className="fw-home__template"
                    onClick={() => openTemplateDialog(template)}
                    title={`Suggests "${template.name}" as the new project's name — no template content or scaffolding is created yet.`}
                  >
                    <span className="fw-home__template-glyph">
                      <Icon name={template.icon} size="md" />
                    </span>
                    <span className="fw-home__template-name">{template.name}</span>
                    <span className="fw-home__template-detail">{template.detail}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Panel>

          {/* ------------------------------------- verification + failures */}
          <div className="fw-home__pair">
            <Panel
              flush
              padded={false}
              title="Pending verification"
              subtitle="Claims still waiting on evidence."
              actions={<ExampleTag />}
              className="fw-home__section"
            >
              {pending.length === 0 ? (
                <EmptyState
                  compact
                  icon="ShieldCheck"
                  title="Nothing pending"
                  detail="No claim is waiting on evidence right now."
                />
              ) : (
              <ul className="fw-home__list">
                {pending.map((item) => (
                  <li key={item.id} className="fw-home__stack-row">
                    <div className="fw-home__stack-head">
                      <StatusBadge status={item.status} size="sm" />
                      <Machine muted>{item.who}</Machine>
                    </div>
                    <p className="fw-home__stack-claim">{item.claim}</p>
                    <Machine muted className="fw-home__stack-machine fw-truncate">
                      {item.machine}
                    </Machine>
                  </li>
                ))}
              </ul>
              )}
            </Panel>

            <Panel
              flush
              padded={false}
              title="Failures and blockers"
              subtitle="What is not moving, and why."
              actions={
                <Button variant="quiet" size="sm" iconRight="ArrowRight" onClick={() => navigate('/tests')}>
                  Tests &amp; proof
                </Button>
              }
              className="fw-home__section"
            >
              {trouble.length === 0 ? (
                <EmptyState
                  compact
                  icon="CircleCheck"
                  title="Nothing blocked"
                  detail="No agent, project or gate is failing or blocked right now."
                />
              ) : (
              <ul className="fw-home__list">
                {trouble.map((item) => (
                  <li key={item.id} className="fw-home__stack-row" data-status={item.status}>
                    <div className="fw-home__stack-head">
                      <StatusBadge status={item.status} size="sm" />
                      <span className="fw-home__stack-title fw-truncate">{item.title}</span>
                    </div>
                    <p className="fw-home__stack-claim fw-home__stack-claim--clamp">{item.detail}</p>
                    <Machine muted className="fw-home__stack-machine">
                      {item.origin}
                    </Machine>
                  </li>
                ))}
              </ul>
              )}
            </Panel>
          </div>

          {/* ------------------------------------- artifacts + activity feed */}
          <div className="fw-home__pair">
            <Panel
              flush
              padded={false}
              title="Recent artifacts"
              subtitle={production ? 'Evidence produced by your runs.' : 'Produced by the example mission.'}
              actions={
                <Button variant="quiet" size="sm" iconRight="ArrowRight" onClick={() => navigate('/artifacts')}>
                  All artifacts
                </Button>
              }
              className="fw-home__section"
            >
              {artifacts.length === 0 ? (
                <EmptyState
                  compact
                  icon="PackageOpen"
                  title="No artifacts yet"
                  detail="Evidence produced by your runs will appear here."
                />
              ) : (
              <ul className="fw-home__list">
                {artifacts.slice(0, 5).map((artifact) => (
                  <li key={artifact.id}>
                    <button
                      type="button"
                      className="fw-home__row"
                      onClick={() => dispatch({ type: 'select', selection: { kind: 'artifact', id: artifact.id } })}
                    >
                      <span className="fw-home__row-glyph">
                        <Icon name={ARTIFACT_ICON[artifact.kind] ?? 'File'} size="sm" />
                      </span>
                      <span className="fw-home__row-main">
                        <Machine className="fw-home__row-title fw-truncate">{artifact.name}</Machine>
                        <span className="fw-home__row-detail fw-truncate">
                          {artifact.producedBy}
                        </span>
                      </span>
                      <span className="fw-home__row-side">
                        <Machine muted>{artifact.size}</Machine>
                        <Machine muted>{artifact.createdAt}</Machine>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              )}
            </Panel>

            <Panel
              flush
              padded={false}
              title="Activity"
              subtitle={production ? 'The last six entries of the activity feed.' : 'The last six entries of the example feed.'}
              actions={
                <Button variant="quiet" size="sm" iconRight="ArrowRight" onClick={() => navigate('/activity')}>
                  Full timeline
                </Button>
              }
              className="fw-home__section"
            >
              {events.length === 0 ? (
                <EmptyState
                  compact
                  icon="Activity"
                  title="No activity yet"
                  detail="Steps from your runs will appear here as they happen."
                />
              ) : (
              <ol className="fw-home__timeline">
                {events.slice(0, 6).map((event) => (
                  <li key={event.id} className="fw-home__event">
                    <span className="fw-home__event-rail" aria-hidden="true">
                      <Icon name={EVENT_ICON[event.kind] ?? 'Activity'} size="xs" />
                    </span>
                    <div className="fw-home__event-body">
                      <p className="fw-home__event-message">{event.message}</p>
                      <p className="fw-home__event-meta">
                        <Machine muted>{event.timestamp}</Machine>
                        <Machine muted>{event.kind}</Machine>
                        {event.agent ? <Machine muted>{event.agent}</Machine> : null}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
              )}
            </Panel>
          </div>
        </div>
      </div>

      <NewProjectDialog
        open={templateDialog.open}
        initialName={templateDialog.name}
        onClose={() => setTemplateDialog((current) => ({ ...current, open: false }))}
        onCreated={handleTemplateProjectCreated}
      />
    </div>
  );
}
