/**
 * Inspector — the project panel.
 *
 * refactor-inspector-split (forge-2026-07-29-cc-finish) — moved out of `Inspector.tsx`'s
 * `buildDetail` switch, `case 'project'`, unchanged (comments included verbatim). See that
 * file's own header for the full refactor rationale.
 */

import { Icon, Machine, Meter } from '@/components/primitives';
import { hasMeasuredProjectDetail } from '@/prototype/state/gateway-adapter';
import { selectProject } from '@/prototype/state/prototype-store';
import type { PrototypeState, Selection } from '@/prototype/state/prototype-store';
import { Chips, Fields, KIND_LABEL, Prose, Section } from './inspector-shared';
import type { Detail, SelectFn } from './inspector-shared';

export function buildProjectDetail(
  state: PrototypeState,
  selection: Extract<Selection, { kind: 'project' }>,
  select: SelectFn,
): Detail | null {
  const { data } = state;
  const project = selectProject(state, selection.id);
  if (!project) return null;
  const run = data.runs.find((candidate) => candidate.projectId === project.id);
  const conversations = data.conversations.filter((c) => c.projectId === project.id);
  const { tests } = project.health;
  // fix-cert-rest follow-up (Lead): the same gate ProjectsView uses. `taskCount` and
  // `health.score` are typed `number | null` and already render '—' on their own, but the
  // remaining counters below are plain `number`s that the adapter fills with a placeholder 0
  // for every project this workspace is not currently focused on. Rendered bare, "0 missions ·
  // 0 agents · 0 passed · 0 failed" reads as a measured, empty project — a worse lie than a
  // blank, because it looks like a finding. Everything that is not measured says so.
  const measured = hasMeasuredProjectDetail(project, state.activeProjectId);
  // fix-ui-clutter (item 6): `measured` alone only answers "is this the active project (or
  // a fixture)" — it says nothing about whether a doctor verdict actually exists for it.
  // Without this second gate, a freshly created active project with no doctor run yet
  // rendered "0 passed · 0 failed · 0 skipped" as though that were a real, empty
  // measurement (the exact F3-class bug this item closes). `undefined` (fixtures/bridge
  // records) means "trust it" — only an explicit `false` counts as unmeasured.
  const testsMeasured = measured && project.health.testsMeasured !== false;
  const orDash = (value: number): string | number => (measured ? value : '—');
  return {
    eyebrow: KIND_LABEL.project,
    title: project.name,
    status: project.status,
    subtitle: <Machine muted>{project.id}</Machine>,
    body: (
      <>
        <Prose>{project.description}</Prose>
        <Fields
          rows={[
            { label: 'Type', value: <Machine>{project.type}</Machine> },
            { label: 'Path', value: <Machine>{project.path}</Machine> },
            { label: 'Template', value: <Machine>{project.templateVersion}</Machine> },
            { label: 'Last activity', value: <Machine muted>{project.lastActivity}</Machine> },
            { label: 'Pinned', value: <Machine muted>{project.pinned ? 'yes' : 'no'}</Machine> },
          ]}
        />
        {/* fix-cert-rest (item 3): health.score is now `number | null` (prototype-types.ts) —
            a genuine absence (this project has never been measured) renders '—', never a
            fabricated "null%"/a `Meter` fed a non-numeric value. */}
        <Section title="Health" defaultOpen count={project.health.score !== null ? `${project.health.score}%` : '—'}>
          {/* Neutral on purpose: the ember is rationed to running progress,
              and a health score is a measurement, not a run. */}
          {project.health.score !== null ? (
            <Meter value={project.health.score} label="Score" showValue />
          ) : (
            <Machine muted>—</Machine>
          )}
          <Fields
            rows={[
              {
                label: 'Tests',
                value: (
                  <Machine>
                    {testsMeasured
                      ? `${tests.passed} passed · ${tests.failed} failed · ${tests.skipped} skipped`
                      : '—'}
                  </Machine>
                ),
              },
              { label: 'Open tickets', value: <Machine>{orDash(project.health.openTickets)}</Machine> },
              { label: 'Blockers', value: <Machine>{orDash(project.health.blockers)}</Machine> },
            ]}
          />
        </Section>
        {/* fix-cert-rest (item 3): taskCount is now `number | null` — '—' when unmeasured. */}
        <Section title="Counts" count={project.taskCount ?? '—'}>
          <Fields
            rows={[
              { label: 'Conversations', value: <Machine>{project.conversationCount}</Machine> },
              { label: 'Missions', value: <Machine>{orDash(project.missionCount)}</Machine> },
              { label: 'Tasks', value: <Machine>{project.taskCount ?? '—'}</Machine> },
              { label: 'Agents', value: <Machine>{orDash(project.agentCount)}</Machine> },
            ]}
          />
        </Section>
        <Section title="Skills" count={project.skills.length}>
          <Chips items={project.skills} label="Project skills" />
        </Section>
        {run ? (
          <Section title="Latest run" count={run.workPackageIds.length}>
            <Prose>{run.goal}</Prose>
            <Fields
              rows={[
                { label: 'Run', value: <Machine>{run.id}</Machine> },
                { label: 'Started', value: <Machine muted>{run.startedAt}</Machine> },
                { label: 'Duration', value: <Machine muted>{run.duration}</Machine> },
                { label: 'Agents', value: <Machine>{run.agentIds.length}</Machine> },
              ]}
            />
          </Section>
        ) : null}
        {conversations.length > 0 ? (
          <Section title="Conversations" count={conversations.length}>
            <div className="fw-inspector__links">
              {conversations.map((conversation) => (
                <button
                  key={conversation.id}
                  type="button"
                  className="fw-inspector__link"
                  onClick={() => select({ kind: 'conversation', id: conversation.id })}
                >
                  <Icon name="MessageSquare" size="xs" className="fw-inspector__link-icon" />
                  <span className="fw-truncate">{conversation.title}</span>
                  <Icon name="ChevronRight" size="xs" className="fw-inspector__link-chevron" />
                </button>
              ))}
            </div>
          </Section>
        ) : null}
      </>
    ),
  };
}
