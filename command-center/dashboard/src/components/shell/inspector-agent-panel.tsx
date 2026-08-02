/**
 * Inspector — the agent panel.
 *
 * refactor-inspector-split (forge-2026-07-29-cc-finish) — moved out of `Inspector.tsx`'s
 * `buildDetail` switch, `case 'agent'`, unchanged (comments included verbatim). See that file's
 * own header for the full refactor rationale.
 */

import { Icon, Machine, Meter } from '@/components/primitives';
import { selectAgent } from '@/prototype/state/prototype-store';
import type { PrototypeState, Selection } from '@/prototype/state/prototype-store';
import { Chips, Fields, KIND_LABEL, Prose, Section } from './inspector-shared';
import type { Detail, SelectFn } from './inspector-shared';

export function buildAgentDetail(
  state: PrototypeState,
  selection: Extract<Selection, { kind: 'agent' }>,
  select: SelectFn,
  production: boolean,
): Detail | null {
  const { data } = state;
  const agent = selectAgent(state, selection.id);
  if (!agent) return null;
  const tasks = data.tasks.filter((task) => task.agentId === agent.id);
  return {
    eyebrow: KIND_LABEL.agent,
    title: agent.name,
    status: agent.status,
    subtitle: <Machine muted>{agent.id}</Machine>,
    body: (
      <>
        <Prose>{agent.role}</Prose>
        {agent.status === 'running' ? (
          <div className="fw-inspector__block">
            <Meter value={agent.progress} label="Progress" tone="accent" showValue />
          </div>
        ) : null}
        <Fields
          rows={[
            { label: 'Group', value: <Machine>{agent.group}</Machine> },
            { label: 'Permission', value: <Machine>{agent.permission}</Machine> },
            { label: 'Effort', value: <Machine>{agent.effort}</Machine> },
            { label: 'Runtime', value: <Machine>{agent.runtimeModel}</Machine> },
            { label: 'Tool model', value: <Machine>{agent.toolModel}</Machine> },
            // fix-cert-rest (item 2): verification is now `null` (an honest absence of
            // evidence) rather than a fabricated 'not-required' — '—' when so.
            { label: 'Verification', value: <Machine>{agent.verification ?? '—'}</Machine> },
            { label: 'Last activity', value: <Machine muted>{agent.lastActivity}</Machine> },
          ]}
        />
        <Section title="Current task" defaultOpen>
          {agent.currentTask ? (
            <Prose>{agent.currentTask}</Prose>
          ) : (
            <p className="fw-inspector__none">
              {production ? 'No task assigned.' : 'No task assigned in the example data.'}
            </p>
          )}
        </Section>
        <Section title="Summary">
          <Prose>{agent.summary}</Prose>
        </Section>
        <Section title="Skills" count={agent.skills.length}>
          <Chips items={agent.skills} label="Agent skills" />
        </Section>
        {tasks.length > 0 ? (
          <Section title="Tasks" count={tasks.length}>
            <div className="fw-inspector__links">
              {tasks.slice(0, 8).map((task) => (
                <button
                  key={task.id}
                  type="button"
                  className="fw-inspector__link"
                  onClick={() => select({ kind: 'task', id: task.id })}
                >
                  <Machine muted className="fw-inspector__link-id">
                    {task.id}
                  </Machine>
                  <span className="fw-truncate">{task.title}</span>
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
