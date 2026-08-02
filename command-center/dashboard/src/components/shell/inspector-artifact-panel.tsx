/**
 * Inspector — the artifact panel.
 *
 * refactor-inspector-split (forge-2026-07-29-cc-finish) — moved out of `Inspector.tsx`'s
 * `buildDetail` switch, `case 'artifact'`, unchanged (comments included verbatim). See that
 * file's own header for the full refactor rationale.
 */

import { ExampleTag, Machine } from '@/components/primitives';
import { readChatRunArtifactDiff } from '@/prototype/state/gateway-adapter';
import type { ChatRunArtifactDiff } from '@/prototype/state/gateway-adapter';
import type { PrototypeState, Selection } from '@/prototype/state/prototype-store';
import { Console, Diff, Excerpt, Fields, KIND_LABEL, LinkRow, Section } from './inspector-shared';
import type { Detail, SelectFn } from './inspector-shared';

/**
 * feat-chatrun-diff — the section that closes "a reviewer has to take the agent's word for it".
 *
 * A chat-run file change (`toGatewayChatRunArtifacts`) now carries the before/after text the
 * gateway had recorded all along; every other artifact carries none and renders exactly as before
 * (`readChatRunArtifactDiff` returns null and this is never called).
 *
 * All three branches are honest statements, and the two non-diff ones exist precisely so that a
 * missing diff can never be mistaken for an empty one:
 *   present        — the real recorded text, in the EXISTING `Diff` component.
 *   none           — no before/after text was ever recorded (typically a run from before the
 *                    gateway captured diffs). Said in words; NO diff element is rendered at all.
 *   omitted_budget — text exists but this response's diff budget was spent. Said in words, with
 *                    the real budget number the gateway itself reported.
 *
 * A JSX-returning helper, not a component — the same shape `buildArtifactDetail` itself uses, so
 * this file keeps exporting exactly one thing and stays a builder module.
 */
function chatRunDiffSection(diff: ChatRunArtifactDiff, fileName: string) {
  if (diff.state === 'present' && diff.text !== null) {
    return (
      <Section title="Change" defaultOpen>
        <Diff text={diff.text} label={`Recorded change to ${fileName}`} />
        <p className="fw-inspector__hint">
          The exact strings the CLI reported for this edit — what it replaced, and what it replaced
          it with. No diff algorithm was run and nothing was read from disk. Long text is capped by
          the gateway at capture time.
        </p>
      </Section>
    );
  }

  if (diff.state === 'omitted_budget') {
    return (
      <Section title="Change" defaultOpen>
        <p className="fw-inspector__none">
          This edit is real, but its before/after text was left out of this response: the diff
          budget
          {diff.budgetChars === null ? '' : ` (${diff.budgetChars} characters)`} was already spent
          by earlier edits. Nothing was truncated — the text is absent, not shortened.
        </p>
      </Section>
    );
  }

  return (
    <Section title="Change" defaultOpen>
      <p className="fw-inspector__none">
        No diff was recorded for this edit — the change is real, but no before/after text was
        captured for it (runs recorded before diff capture existed have none). This is an absence of
        evidence, not evidence that nothing changed.
      </p>
    </Section>
  );
}

export function buildArtifactDetail(
  state: PrototypeState,
  selection: Extract<Selection, { kind: 'artifact' }>,
  select: SelectFn,
  production: boolean,
): Detail | null {
  const { data } = state;
  const artifact = data.artifacts.find((candidate) => candidate.id === selection.id);
  if (!artifact) return null;
  const machineFace = artifact.kind === 'log' || artifact.kind === 'receipt' || artifact.kind === 'proof';
  const chatRunDiff = readChatRunArtifactDiff(artifact);
  return {
    eyebrow: KIND_LABEL.artifact,
    title: artifact.name,
    subtitle: <Machine muted>{artifact.id}</Machine>,
    body: (
      <>
        <Fields
          rows={[
            { label: 'Kind', value: <Machine>{artifact.kind}</Machine> },
            { label: 'Produced by', value: artifact.producedBy },
            { label: 'Created', value: <Machine muted>{artifact.createdAt}</Machine> },
            { label: 'Size', value: <Machine muted>{artifact.size}</Machine> },
          ]}
        />
        <Section title="Preview" defaultOpen count={<ExampleTag />}>
          {machineFace ? <Console text={artifact.preview} /> : <Excerpt text={artifact.preview} />}
          <p className="fw-inspector__hint">
            {production
              ? 'A summary recorded with this artifact by the run that produced it — not a live file read.'
              : 'Written example content. No file was produced and nothing was rendered.'}
          </p>
        </Section>
        {chatRunDiff !== null ? chatRunDiffSection(chatRunDiff, artifact.name) : null}
        {artifact.taskId ? (
          <Section title="Produced for">
            <div className="fw-inspector__links">
              <LinkRow
                icon="ListChecks"
                id={artifact.taskId}
                onSelect={() => select({ kind: 'task', id: artifact.taskId as string })}
              />
            </div>
          </Section>
        ) : null}
      </>
    ),
  };
}
