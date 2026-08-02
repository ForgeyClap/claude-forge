/**
 * Forge Workspace — the assembled example dataset (fixtures).
 *
 * This is the example data that used to live under `prototype/data/`. It stays
 * valuable — for unit tests, the theme showcase and load testing — but it is no
 * longer wired into the app unconditionally. The gate in `prototype/data/index.ts`
 * decides whether any of it may be handed to the workspace, and in a production
 * build the answer is no.
 *
 * Every record here carries `prototype: true`. That is not decoration: the
 * `assertAllPrototype` / `assertPrototype` guards below key off it, so an example
 * record that lost the flag throws at import time rather than rendering quietly
 * as if it were real. The production gate keys off the SAME flag in the opposite
 * direction — a record carrying it must never reach a production path.
 *
 * There is no loading state here and never will be: the dataset is a local
 * constant. Nothing is fetched, read from disk, or awaited.
 */

import type { PrototypeDataset } from '@/prototype/state/prototype-store';
import { assertAllPrototype, assertPrototype } from '@/prototype/types/prototype-types';

import { AGENTS } from './agents';
import { ARTIFACTS } from './artifacts';
import { CLAUDE_CODE_LINKS, CLAUDE_CODE_LINK_BY_STATE } from './claude-code';
import { CONVERSATIONS } from './conversations';
import { EVENTS } from './events';
import { FILE_TREE } from './files';
import { MISSION_GRAPH } from './graph';
import { PROJECTS } from './projects';
import { RUNS } from './runs';
import { TASKS } from './tasks';
import { PROOF_LEDGER, QUALITY_GATES } from './tests';
import { WORK_PACKAGES } from './work-packages';

export {
  AGENTS,
  ARTIFACTS,
  CLAUDE_CODE_LINKS,
  CLAUDE_CODE_LINK_BY_STATE,
  CONVERSATIONS,
  EVENTS,
  FILE_TREE,
  MISSION_GRAPH,
  PROJECTS,
  PROOF_LEDGER,
  QUALITY_GATES,
  RUNS,
  TASKS,
  WORK_PACKAGES,
};

/**
 * The complete example dataset, guarded at the boundary.
 *
 * The nested file tree is checked at its top level only; children are covered
 * by the same authoring rule and carry the flag throughout.
 */
export const FIXTURE_DATASET: PrototypeDataset = {
  projects: assertAllPrototype(PROJECTS, 'fixtures/projects'),
  conversations: assertAllPrototype(CONVERSATIONS, 'fixtures/conversations'),
  agents: assertAllPrototype(AGENTS, 'fixtures/agents'),
  tasks: assertAllPrototype(TASKS, 'fixtures/tasks'),
  workPackages: assertAllPrototype(WORK_PACKAGES, 'fixtures/work-packages'),
  runs: assertAllPrototype(RUNS, 'fixtures/runs'),
  events: assertAllPrototype(EVENTS, 'fixtures/events'),
  artifacts: assertAllPrototype(ARTIFACTS, 'fixtures/artifacts'),
  gates: assertAllPrototype(QUALITY_GATES, 'fixtures/tests · gates'),
  proof: assertAllPrototype(PROOF_LEDGER, 'fixtures/tests · proof'),
  files: assertAllPrototype(FILE_TREE, 'fixtures/files'),
  graph: assertPrototype(MISSION_GRAPH, 'fixtures/graph'),
};

export default FIXTURE_DATASET;
