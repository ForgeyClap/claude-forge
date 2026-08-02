/**
 * Inspector — the mission graph node panel.
 *
 * refactor-inspector-split (forge-2026-07-29-cc-finish) — moved out of `Inspector.tsx`'s
 * `buildDetail` switch, `case 'graph-node'`, unchanged (comments included verbatim). See that
 * file's own header for the full refactor rationale.
 */

import { Machine } from '@/components/primitives';
import type { PrototypeState, Selection } from '@/prototype/state/prototype-store';
import { Chips, Fields, KIND_LABEL, LinkRow, Prose, Section } from './inspector-shared';
import type { Detail, SelectFn } from './inspector-shared';

export function buildGraphNodeDetail(
  state: PrototypeState,
  selection: Extract<Selection, { kind: 'graph-node' }>,
  select: SelectFn,
): Detail | null {
  const { data } = state;
  const node = data.graph.nodes.find((candidate) => candidate.id === selection.id);
  if (!node) return null;
  const lane = data.graph.lanes.find((candidate) => candidate.id === node.laneId);
  const edgesIn = data.graph.edges.filter((edge) => edge.to === node.id);
  const edgesOut = data.graph.edges.filter((edge) => edge.from === node.id);
  return {
    eyebrow: KIND_LABEL['graph-node'],
    title: node.label,
    status: node.status,
    subtitle: <Machine muted>{node.id}</Machine>,
    body: (
      <>
        <Fields
          rows={[
            { label: 'Kind', value: <Machine>{node.kind}</Machine> },
            { label: 'Lane', value: lane ? lane.label : <Machine muted>spine</Machine> },
            { label: 'Agent', value: node.agent ?? <Machine muted>—</Machine> },
            { label: 'Duration', value: <Machine muted>{node.duration ?? '—'}</Machine> },
            { label: 'Model', value: <Machine>{node.model ?? '—'}</Machine> },
            {
              label: 'Position',
              value: (
                <Machine muted>
                  col {node.col} · row {node.row}
                </Machine>
              ),
            },
          ]}
        />
        {node.detail ? (
          <Section title="What happened here" defaultOpen>
            <Prose>{node.detail}</Prose>
          </Section>
        ) : null}
        {node.skills && node.skills.length > 0 ? (
          <Section title="Skills" count={node.skills.length}>
            <Chips items={node.skills} label="Node skills" />
          </Section>
        ) : null}
        <Section title="Edges" count={edgesIn.length + edgesOut.length}>
          <div className="fw-inspector__links">
            {edgesIn.map((edge) => (
              <LinkRow
                key={edge.id}
                icon="ArrowRightToLine"
                id={edge.from}
                onSelect={() => select({ kind: 'graph-node', id: edge.from })}
              />
            ))}
            {edgesOut.map((edge) => (
              <LinkRow
                key={edge.id}
                icon="ArrowRightFromLine"
                id={edge.to}
                onSelect={() => select({ kind: 'graph-node', id: edge.to })}
              />
            ))}
          </div>
        </Section>
      </>
    ),
  };
}
