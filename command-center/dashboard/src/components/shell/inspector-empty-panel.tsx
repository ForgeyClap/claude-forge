/**
 * Inspector — the "nothing selected" landing panel.
 *
 * refactor-inspector-split (forge-2026-07-29-cc-finish) — moved out of `Inspector.tsx`'s
 * `buildDetail` switch, `case 'none'`, unchanged. See that file's own header for the full
 * refactor rationale.
 */

import { Button, EmptyState, Eyebrow } from '@/components/primitives';
import { selectActiveProject } from '@/prototype/state/prototype-store';
import type { PrototypeState } from '@/prototype/state/prototype-store';
import { KIND_LABEL } from './inspector-shared';
import type { Detail, SelectFn } from './inspector-shared';

export function buildNoneDetail(state: PrototypeState, select: SelectFn): Detail | null {
  const { data } = state;
  const project = selectActiveProject(state);
  const event = data.events[0];
  const agent = data.agents.find((candidate) => candidate.status === 'running');
  return {
    eyebrow: KIND_LABEL.none,
    title: 'Nothing selected',
    subtitle: 'Select anything in the workspace and its record opens here.',
    body: (
      <>
        <EmptyState
          icon="SquareDashedMousePointer"
          title="No record open"
          detail="Projects, agents, tasks, graph nodes, artifacts, gates, proof lines, files and events all resolve into this panel."
          compact
        />
        <div className="fw-inspector__block">
          <Eyebrow>START FROM</Eyebrow>
          <div className="fw-inspector__starts">
            {project ? (
              <Button
                size="sm"
                icon="FolderGit2"
                block
                onClick={() => select({ kind: 'project', id: project.id })}
              >
                {project.name}
              </Button>
            ) : null}
            {agent ? (
              <Button
                size="sm"
                icon="Bot"
                block
                onClick={() => select({ kind: 'agent', id: agent.id })}
              >
                {agent.name}
              </Button>
            ) : null}
            {event ? (
              <Button
                size="sm"
                icon="Activity"
                block
                onClick={() => select({ kind: 'event', id: event.id })}
              >
                Most recent event
              </Button>
            ) : null}
          </div>
          <p className="fw-inspector__hint">
            The panel adapts to what is selected — it never shows the same shape twice.
          </p>
        </div>
      </>
    ),
  };
}
