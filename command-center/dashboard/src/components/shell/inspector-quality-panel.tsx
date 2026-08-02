/**
 * Inspector — the quality-gate + proof-ledger panels.
 *
 * refactor-inspector-split (forge-2026-07-29-cc-finish) — moved out of `Inspector.tsx`'s
 * `buildDetail` switch, `case 'gate'` and `case 'proof'`, unchanged (comments included
 * verbatim). Paired in one file because `TestsView.tsx`'s own header already treats them as one
 * surface ("Tests & proof — the quality-gate board and the proof ledger"); this file mirrors
 * that existing real grouping rather than inventing a new one. See `Inspector.tsx`'s own header
 * for the full refactor rationale.
 */

import { ExampleTag, Machine } from '@/components/primitives';
import type { PrototypeState, Selection } from '@/prototype/state/prototype-store';
import { Console, Fields, KIND_LABEL, LinkRow, Prose, Section, VERDICT_STATUS } from './inspector-shared';
import type { Detail, SelectFn } from './inspector-shared';

export function buildGateDetail(
  state: PrototypeState,
  selection: Extract<Selection, { kind: 'gate' }>,
): Detail | null {
  const { data } = state;
  const gate = data.gates.find((candidate) => candidate.id === selection.id);
  if (!gate) return null;
  return {
    eyebrow: KIND_LABEL.gate,
    title: gate.name,
    status: gate.status,
    subtitle: <Machine muted>{gate.id}</Machine>,
    body: (
      <>
        <Fields
          rows={[
            { label: 'Duration', value: <Machine muted>{gate.duration}</Machine> },
            { label: 'Last run', value: <Machine muted>{gate.lastRun}</Machine> },
            { label: 'Evidence', value: <Machine>{gate.evidenceCount}</Machine> },
          ]}
        />
        <Section title="Recorded output" defaultOpen count={<ExampleTag />}>
          <Console text={gate.output} />
        </Section>
      </>
    ),
  };
}

export function buildProofDetail(
  state: PrototypeState,
  selection: Extract<Selection, { kind: 'proof' }>,
  select: SelectFn,
  production: boolean,
): Detail | null {
  const { data } = state;
  const entry = data.proof.find((candidate) => candidate.id === selection.id);
  if (!entry) return null;
  const artifact = entry.artifact
    ? data.artifacts.find((candidate) => candidate.name === entry.artifact)
    : undefined;
  return {
    eyebrow: KIND_LABEL.proof,
    title: entry.claim,
    status: VERDICT_STATUS[entry.verdict],
    subtitle: (
      <Machine muted>
        {entry.id} · {entry.verdict}
      </Machine>
    ),
    body: (
      <>
        <Fields
          rows={[
            { label: 'Agent', value: entry.agent },
            { label: 'Task', value: <Machine>{entry.taskId}</Machine> },
            { label: 'Recorded', value: <Machine muted>{entry.timestamp}</Machine> },
            { label: 'Artifact', value: <Machine>{entry.artifact ?? 'none'}</Machine> },
          ]}
        />
        <Section title="Verdict reason" defaultOpen>
          <Prose>{entry.reason}</Prose>
        </Section>
        <Section title="Command" count={<ExampleTag />}>
          <Console text={`$ ${entry.command}`} />
          <p className="fw-inspector__hint">
            {production
              ? 'Recorded as text from the run that reported it. It is never executed from this panel.'
              : 'Recorded as text in the example ledger. It was never executed here.'}
          </p>
        </Section>
        <Section title="Linked">
          <div className="fw-inspector__links">
            <LinkRow
              icon="ListChecks"
              id={entry.taskId}
              onSelect={() => select({ kind: 'task', id: entry.taskId })}
            />
            {artifact ? (
              <LinkRow
                icon="Paperclip"
                id={artifact.name}
                onSelect={() => select({ kind: 'artifact', id: artifact.id })}
              />
            ) : null}
          </div>
        </Section>
      </>
    ),
  };
}
