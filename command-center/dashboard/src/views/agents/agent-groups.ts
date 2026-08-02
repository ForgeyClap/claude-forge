/**
 * Agents view — the seven agent groups, shared between the list/grid/grouped
 * layouts (`AgentsView.tsx`) and the Nodes graph (`AgentsGraph.tsx`).
 *
 * Pulled into its own module so both files can import the same table without
 * one importing the other — `AgentsGraph` reads group metadata but is itself
 * rendered BY `AgentsView`, so a direct `AgentsView -> AgentsGraph -> AgentsView`
 * import would be circular.
 */

import type { AgentGroup } from '@/prototype/types/prototype-types';

export interface GroupDef {
  readonly key: AgentGroup;
  readonly label: string;
  readonly glyph: string;
  readonly note: string;
}

export const GROUPS: readonly GroupDef[] = [
  {
    key: 'control',
    label: 'CONTROL',
    glyph: 'Crown',
    note: 'Owns the mission end to end and sets the bar for done.',
  },
  {
    key: 'context',
    label: 'CONTEXT',
    glyph: 'Telescope',
    note: 'Gathers what the rest of the team would otherwise guess at.',
  },
  {
    key: 'planning',
    label: 'PLANNING',
    glyph: 'Map',
    note: 'Turns a request into work packages with owners and edges.',
  },
  {
    key: 'domain',
    label: 'DOMAIN',
    glyph: 'Boxes',
    note: 'Specialists for one field of the build.',
  },
  {
    key: 'execution',
    label: 'EXECUTION',
    glyph: 'Hammer',
    note: 'Writes the implementation and the unglamorous edge cases.',
  },
  {
    key: 'review',
    label: 'REVIEW',
    glyph: 'Gavel',
    note: 'Checks the claim against the evidence attached to it.',
  },
  {
    key: 'memory',
    label: 'MEMORY',
    glyph: 'Archive',
    note: 'Keeps what worked so the next mission does not start cold.',
  },
];

export const GROUP_BY_KEY: Readonly<Record<AgentGroup, GroupDef>> = GROUPS.reduce(
  (acc, group) => ({ ...acc, [group.key]: group }),
  {} as Record<AgentGroup, GroupDef>,
);
