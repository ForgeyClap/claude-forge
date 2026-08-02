/**
 * Inspector — the task panel.
 *
 * refactor-inspector-split (forge-2026-07-29-cc-finish) — moved out of `Inspector.tsx`'s
 * `buildDetail` switch, `case 'task'`, unchanged (comments included verbatim). See that file's
 * own header for the full refactor rationale.
 */

import { Icon, Machine, Meter, StatusBadge } from '@/components/primitives';
import { selectAgent, selectTask } from '@/prototype/state/prototype-store';
import type { PrototypeState, Selection } from '@/prototype/state/prototype-store';
import { Fields, KIND_LABEL, LinkRow, Prose, Section, VERDICT_STATUS } from './inspector-shared';
import type { Detail, SelectFn } from './inspector-shared';

export function buildTaskDetail(
  state: PrototypeState,
  selection: Extract<Selection, { kind: 'task' }>,
  select: SelectFn,
  production: boolean,
): Detail | null {
  const { data } = state;
  const task = selectTask(state, selection.id);
  if (!task) return null;
  const agent = selectAgent(state, task.agentId);
  const workPackage = data.workPackages.find((wp) => wp.id === task.workPackageId);
  const proof = data.proof.filter((entry) => entry.taskId === task.id);
  return {
    eyebrow: KIND_LABEL.task,
    title: task.title,
    status: task.status,
    subtitle: <Machine muted>{task.id}</Machine>,
    body: (
      <>
        {task.status === 'running' ? (
          <div className="fw-inspector__block">
            <Meter value={task.progress} label="Progress" tone="accent" showValue />
          </div>
        ) : null}
        <Fields
          rows={[
            { label: 'Owner', value: agent ? agent.name : <Machine>{task.agentId}</Machine> },
            { label: 'Package', value: <Machine>{task.workPackageId}</Machine> },
            { label: 'Phase', value: <Machine>{task.phase}</Machine> },
            { label: 'Column', value: <Machine>{task.column}</Machine> },
            { label: 'Created', value: <Machine muted>{task.createdAt}</Machine> },
            { label: 'Updated', value: <Machine muted>{task.updatedAt}</Machine> },
            { label: 'Repairs', value: <Machine>{task.repairAttempts}</Machine> },
          ]}
        />
        <Section title="Detail" defaultOpen>
          <Prose>{task.detail}</Prose>
        </Section>
        <Section title="Dependencies" count={task.dependencies.length}>
          {task.dependencies.length === 0 ? (
            <p className="fw-inspector__none">Nothing blocks this task.</p>
          ) : (
            <div className="fw-inspector__links">
              {task.dependencies.map((id) => (
                <LinkRow key={id} icon="GitCommitHorizontal" id={id} onSelect={() => select({ kind: 'task', id })} />
              ))}
            </div>
          )}
        </Section>
        <Section title="Proof" count={task.proofCount}>
          {proof.length === 0 ? (
            <p className="fw-inspector__none">
              {production
                ? 'No proof entries have been recorded for this task.'
                : `${task.proofCount} recorded, none of them in the example ledger.`}
            </p>
          ) : (
            <div className="fw-inspector__links">
              {proof.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className="fw-inspector__link"
                  onClick={() => select({ kind: 'proof', id: entry.id })}
                >
                  <StatusBadge status={VERDICT_STATUS[entry.verdict]} size="sm" iconOnly />
                  <span className="fw-truncate">{entry.claim}</span>
                  <Icon name="ChevronRight" size="xs" className="fw-inspector__link-chevron" />
                </button>
              ))}
            </div>
          )}
        </Section>
        {workPackage ? (
          <Section title="Work package" count={workPackage.taskIds.length}>
            <Prose>{workPackage.goal}</Prose>
            <Fields
              rows={[
                { label: 'Package', value: <Machine>{workPackage.id}</Machine> },
                { label: 'Title', value: workPackage.title },
                { label: 'Phase', value: <Machine>{workPackage.phase}</Machine> },
              ]}
            />
            <ul className="fw-inspector__list">
              {workPackage.acceptance.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </Section>
        ) : null}
      </>
    ),
  };
}
