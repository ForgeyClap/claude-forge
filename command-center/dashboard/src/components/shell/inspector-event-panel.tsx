/**
 * Inspector — the event panel.
 *
 * refactor-inspector-split (forge-2026-07-29-cc-finish) — moved out of `Inspector.tsx`'s
 * `buildDetail` switch, `case 'event'`, unchanged (comments included verbatim). See that file's
 * own header for the full refactor rationale.
 */

import { Machine } from '@/components/primitives';
import type { PrototypeState, Selection } from '@/prototype/state/prototype-store';
import { Fields, KIND_LABEL, LinkRow, Prose, Section } from './inspector-shared';
import type { Detail, SelectFn } from './inspector-shared';

export function buildEventDetail(
  state: PrototypeState,
  selection: Extract<Selection, { kind: 'event' }>,
  select: SelectFn,
): Detail | null {
  const { data } = state;
  const event = data.events.find((candidate) => candidate.id === selection.id);
  if (!event) return null;
  const run = data.runs.find((candidate) => candidate.id === event.runId);
  const agent = event.agent ? data.agents.find((candidate) => candidate.name === event.agent) : undefined;
  return {
    eyebrow: KIND_LABEL.event,
    title: event.message,
    status: event.status,
    subtitle: (
      <Machine muted>
        {event.id} · {event.timestamp}
      </Machine>
    ),
    body: (
      <>
        <Fields
          rows={[
            { label: 'Kind', value: <Machine>{event.kind}</Machine> },
            { label: 'Agent', value: event.agent ?? <Machine muted>system</Machine> },
            { label: 'Run', value: <Machine>{event.runId}</Machine> },
            { label: 'Recorded', value: <Machine muted>{event.timestamp}</Machine> },
          ]}
        />
        <Section title="Detail" defaultOpen>
          <Prose>{event.detail}</Prose>
        </Section>
        {run ? (
          <Section title="Run">
            <Prose>{run.goal}</Prose>
            <Fields
              rows={[
                { label: 'Started', value: <Machine muted>{run.startedAt}</Machine> },
                { label: 'Duration', value: <Machine muted>{run.duration}</Machine> },
              ]}
            />
          </Section>
        ) : null}
        {agent ? (
          <Section title="Reported by">
            <div className="fw-inspector__links">
              <LinkRow icon="Bot" id={agent.name} onSelect={() => select({ kind: 'agent', id: agent.id })} />
            </div>
          </Section>
        ) : null}
      </>
    ),
  };
}
