/**
 * Forge Workspace — the data GATE.
 *
 * This module used to BE the example dataset. It is now the gate in front of it.
 * The example records live under `prototype/fixtures/`; this file decides whether
 * the running workspace may see them.
 *
 *   PRODUCTION (the default)  →  every collection is EMPTY. The views render
 *                                their real empty states instead of example
 *                                content, because there is no example content.
 *
 *   FIXTURES (opt-in only)    →  the full example dataset, but only after
 *                                `guardFixtureLoad` has confirmed both the build
 *                                flag and the runtime opt-in are set.
 *
 * Two invariants are enforced here, not merely declared:
 *
 *   1. A record carrying `prototype: true` reaching the PRODUCTION path is a hard
 *      error (`assertNoPrototypeRecords`). Example data cannot leak in silently.
 *   2. Fixtures cannot load in production at all — `guardFixtureLoad` throws
 *      because `PRODUCTION_MOCK_DATA_ALLOWED` is false.
 *
 * `mode` decides; this file obeys and proves. Nothing is fetched, and there is
 * no loading state — the answer is known synchronously at call time.
 *
 * fix-cert-fixtures (forge-2026-07-29-cc-finish): this module is now reached
 * ONLY through a dynamic `import()` (see `state/fixture-provider.tsx`) — nothing
 * under `src/prototype/fixtures/` is statically reachable from `src/main.tsx`
 * any more (`tests/unit/fixture-import-graph.test.ts` proves it). This module's
 * OWN top-level `FIXTURE_DATASET` import from `@/prototype/fixtures` is
 * therefore safe to keep static: it is bundled into the same lazily-loaded
 * chunk as everything else reached only from here. `CLAUDE_CODE_LINKS` /
 * `CLAUDE_CODE_LINK_BY_STATE` are the one exception worth calling out: `Dock.tsx`
 * and `ClaudeCodeChip.tsx` read them SYNCHRONOUSLY and unconditionally from the
 * production entry graph, so they are imported here from the sibling
 * `./claude-code` module (which does NOT live under `prototype/fixtures/`),
 * not from the fixture barrel — see that module's header for the full story.
 */

import { guardFixtureLoad, isFixtureMode, PRODUCTION_MOCK_DATA_ALLOWED } from '@/config/mode';
import type { PrototypeDataset } from '@/prototype/state/prototype-store';
import type { MissionGraph } from '@/prototype/types/prototype-types';

import { FIXTURE_DATASET } from '@/prototype/fixtures';
import { CLAUDE_CODE_LINKS, CLAUDE_CODE_LINK_BY_STATE } from './claude-code';

/*
 * Presentation-only placeholders for the settings / chat "Claude Code link"
 * surface. These are re-exported unchanged so the views that page through the
 * six link states keep resolving. They are NOT part of the gated workspace
 * dataset and carry no project/agent/task content — but see the report: the
 * views that render them do so unconditionally and belong to the UI work package.
 */
export { CLAUDE_CODE_LINKS, CLAUDE_CODE_LINK_BY_STATE };

/* ------------------------------------------------------------------ guards */

/**
 * Throws if ANY element carries `prototype: true`. The inverse of the fixture
 * guard: fixtures must carry the flag, production must never see it. Used to
 * prove the production dataset is genuinely clean, and callable directly so a
 * test can drive a single tainted record through it.
 */
export function assertNoPrototypeRecords(records: readonly unknown[], where: string): void {
  for (const record of records) {
    if ((record as { prototype?: unknown } | null)?.prototype === true) {
      throw new Error(
        `Forge: a record carrying prototype:true reached the production path at ${where}. ` +
          'Example/fixture data must never enter a production code path — this is a hard error, ' +
          'not a warning. Only the opt-in fixtures build may load prototype records.',
      );
    }
  }
}

/**
 * Verifies a dataset is safe for a production build: every collection empty, and
 * not one prototype record anywhere in it (including the graph's own arrays).
 * Returns the dataset so it can be used inline.
 */
export function assertProductionClean(dataset: PrototypeDataset): PrototypeDataset {
  assertNoPrototypeRecords(dataset.projects, 'production/projects');
  assertNoPrototypeRecords(dataset.conversations, 'production/conversations');
  assertNoPrototypeRecords(dataset.agents, 'production/agents');
  assertNoPrototypeRecords(dataset.tasks, 'production/tasks');
  assertNoPrototypeRecords(dataset.workPackages, 'production/work-packages');
  assertNoPrototypeRecords(dataset.runs, 'production/runs');
  assertNoPrototypeRecords(dataset.events, 'production/events');
  assertNoPrototypeRecords(dataset.artifacts, 'production/artifacts');
  assertNoPrototypeRecords(dataset.gates, 'production/gates');
  assertNoPrototypeRecords(dataset.proof, 'production/proof');
  assertNoPrototypeRecords(dataset.files, 'production/files');
  assertNoPrototypeRecords(dataset.graph.nodes, 'production/graph.nodes');
  assertNoPrototypeRecords(dataset.graph.edges, 'production/graph.edges');
  assertNoPrototypeRecords(dataset.graph.lanes, 'production/graph.lanes');
  return dataset;
}

/* -------------------------------------------------------- the empty dataset */

/**
 * The production mission graph: a genuinely empty structural placeholder. It
 * deliberately does NOT carry `prototype: true` — in production nothing is a
 * prototype record, and the cast documents that this shell is not example data.
 * The view reads its empty `nodes`/`lanes`/`edges` and draws its empty state.
 */
const EMPTY_GRAPH = {
  id: '',
  runId: '',
  lanes: [],
  nodes: [],
  edges: [],
} as unknown as MissionGraph;

/** What every collection is in production: nothing. */
const EMPTY_DATASET: PrototypeDataset = {
  projects: [],
  conversations: [],
  agents: [],
  tasks: [],
  workPackages: [],
  runs: [],
  events: [],
  artifacts: [],
  gates: [],
  proof: [],
  files: [],
  graph: EMPTY_GRAPH,
};

/* ---------------------------------------------------------------- the gate */

/**
 * Loads the full example dataset — but only where fixtures are permitted.
 * `guardFixtureLoad` throws in a production build before a single record is
 * returned, so this function cannot be used to smuggle fixtures past the gate.
 */
export function loadFixtureDataset(): PrototypeDataset {
  guardFixtureLoad('prototype/data/index.ts · loadFixtureDataset');
  return FIXTURE_DATASET;
}

/**
 * The workspace dataset the app should use. Reads the mode live:
 *
 *   fixtures mode → the guarded example dataset.
 *   production    → empty collections, proven free of any prototype record.
 */
export function loadWorkspaceDataset(): PrototypeDataset {
  if (isFixtureMode()) {
    return loadFixtureDataset();
  }
  return assertProductionClean(EMPTY_DATASET);
}

/**
 * The dataset as resolved at module load. Production by default, so this is the
 * empty dataset in every ordinary build. A fixtures build that has opted in
 * before this module first loads gets the example data instead.
 *
 * Prefer `loadWorkspaceDataset()` where the mode may change after load (tests,
 * the theme showcase toggling fixtures on); this constant is the load-time snapshot.
 */
export const PROTOTYPE_DATASET: PrototypeDataset = loadWorkspaceDataset();

export default PROTOTYPE_DATASET;

/* Re-export the policy constant so consumers of the gate can read it directly. */
export { PRODUCTION_MOCK_DATA_ALLOWED };
