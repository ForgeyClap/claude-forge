/**
 * Production mode — the retirement of the fixtures, proven.
 *
 * The prototype used to ship thirteen files of example data that loaded
 * unconditionally. In a production build that is forbidden. This suite proves
 * the gate that forbids it actually holds, along five lines:
 *
 *   1. A production build loads ZERO fixture records.
 *   2. The fixture flag is OFF by default — and BOTH gates are required.
 *   3. A prototype:true record entering the production path THROWS.
 *   4. PRODUCTION_MOCK_DATA_ALLOWED is false and is ENFORCED, not just declared.
 *   5. EXAMPLE labels do not render in production mode.
 *
 * The mode is read live, so each test controls it explicitly: `vi.stubEnv` arms
 * the build-time gate and `allowFixtureData()` arms the runtime one. `afterEach`
 * closes both again so no test can leak fixture mode into the next.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { render, screen } from '@testing-library/react';

import {
  FIXTURE_ENV_KEY,
  FIXTURE_ENV_ON,
  PRODUCTION_MOCK_DATA_ALLOWED,
  ProductionFixtureError,
  allowFixtureData,
  disallowFixtureData,
  fixtureBuildFlag,
  guardFixtureLoad,
  isFixtureDataAllowed,
  isFixtureMode,
  isProductionMode,
  resolveMode,
} from '@/config/mode';
import {
  PRODUCTION_MOCK_DATA_ALLOWED as GATE_MOCK_ALLOWED,
  PROTOTYPE_DATASET,
  assertNoPrototypeRecords,
  assertProductionClean,
  loadFixtureDataset,
  loadWorkspaceDataset,
} from '@/prototype/data';
import { FIXTURE_DATASET } from '@/prototype/fixtures';
import type { PrototypeDataset } from '@/prototype/state/prototype-store';
import type { Project } from '@/prototype/types/prototype-types';
import { ExampleTag } from '@/components/primitives';

/* ------------------------------------------------------------------ helpers */

/** Total records across every collection, including the mission graph's arrays. */
function countRecords(d: PrototypeDataset): number {
  return (
    d.projects.length +
    d.conversations.length +
    d.agents.length +
    d.tasks.length +
    d.workPackages.length +
    d.runs.length +
    d.events.length +
    d.artifacts.length +
    d.gates.length +
    d.proof.length +
    d.files.length +
    d.graph.nodes.length +
    d.graph.edges.length +
    d.graph.lanes.length
  );
}

/** Opens BOTH gates — the only way fixtures are permitted. */
function enableFixturesFully(): void {
  vi.stubEnv(FIXTURE_ENV_KEY, FIXTURE_ENV_ON);
  allowFixtureData();
}

/** Renders one <ExampleTag/> per project in the given dataset. */
function renderExampleTagsFor(d: PrototypeDataset) {
  return render(
    createElement(
      'div',
      null,
      d.projects.map((p) => createElement('div', { key: p.id }, p.name, createElement(ExampleTag))),
    ),
  );
}

beforeEach(() => {
  // Baseline every test starts from: production, both gates closed.
  disallowFixtureData();
  vi.unstubAllEnvs();
});

afterEach(() => {
  disallowFixtureData();
  vi.unstubAllEnvs();
});

/* ============================================================== the fixtures */

describe('the fixtures still exist and are worth gating', () => {
  it('the moved fixture dataset is genuinely non-empty', () => {
    // If this were empty, "production loads zero records" would be trivially and
    // meaninglessly true. It is the contrast that gives the rest of the suite teeth.
    expect(countRecords(FIXTURE_DATASET)).toBeGreaterThan(50);
    expect(FIXTURE_DATASET.projects.length).toBeGreaterThan(0);
  });
});

/* ============================================ 1. production loads zero records */

describe('1 · a production build loads zero fixture records', () => {
  it('the load-time snapshot is empty in a default (production) build', () => {
    expect(isProductionMode()).toBe(true);
    expect(countRecords(PROTOTYPE_DATASET)).toBe(0);
  });

  it('every collection is empty and the mission graph carries nothing', () => {
    const d = loadWorkspaceDataset();
    expect(d.projects).toEqual([]);
    expect(d.conversations).toEqual([]);
    expect(d.agents).toEqual([]);
    expect(d.tasks).toEqual([]);
    expect(d.workPackages).toEqual([]);
    expect(d.runs).toEqual([]);
    expect(d.events).toEqual([]);
    expect(d.artifacts).toEqual([]);
    expect(d.gates).toEqual([]);
    expect(d.proof).toEqual([]);
    expect(d.files).toEqual([]);
    expect(d.graph.nodes).toEqual([]);
    expect(d.graph.edges).toEqual([]);
    expect(d.graph.lanes).toEqual([]);
    expect(countRecords(d)).toBe(0);
  });

  it('the empty production graph is not itself a prototype record', () => {
    const graph = loadWorkspaceDataset().graph as { prototype?: unknown };
    expect(graph.prototype).not.toBe(true);
  });

  it('brings the fixtures back only when fixtures are explicitly enabled', () => {
    // Proves the emptiness above is the GATE at work, not an empty source file.
    enableFixturesFully();
    expect(isFixtureMode()).toBe(true);
    expect(countRecords(loadWorkspaceDataset())).toBe(countRecords(FIXTURE_DATASET));
  });
});

/* ============================================= 2. the flag is off by default */

describe('2 · the fixture flag is off by default and needs both gates', () => {
  it('the build flag and runtime opt-in are both off with no configuration', () => {
    expect(fixtureBuildFlag()).toBe(false);
    expect(isFixtureDataAllowed()).toBe(false);
    expect(resolveMode()).toBe('production');
  });

  it('the build flag alone does not open fixtures', () => {
    vi.stubEnv(FIXTURE_ENV_KEY, FIXTURE_ENV_ON);
    expect(fixtureBuildFlag()).toBe(true);
    expect(isFixtureDataAllowed()).toBe(false);
    expect(resolveMode()).toBe('production');
    expect(countRecords(loadWorkspaceDataset())).toBe(0);
  });

  it('the runtime opt-in alone does not open fixtures', () => {
    allowFixtureData();
    expect(isFixtureDataAllowed()).toBe(true);
    expect(fixtureBuildFlag()).toBe(false);
    expect(resolveMode()).toBe('production');
    expect(countRecords(loadWorkspaceDataset())).toBe(0);
  });

  it('a non-"true" env value does not count as on', () => {
    for (const value of ['1', 'yes', 'TRUE', 'on', '']) {
      vi.stubEnv(FIXTURE_ENV_KEY, value);
      expect(fixtureBuildFlag(), `"${value}" must not arm the build gate`).toBe(false);
      vi.unstubAllEnvs();
    }
  });

  it('opens fixtures only when BOTH gates are set', () => {
    enableFixturesFully();
    expect(fixtureBuildFlag()).toBe(true);
    expect(isFixtureDataAllowed()).toBe(true);
    expect(resolveMode()).toBe('fixtures');
  });
});

/* =================================== 3. a prototype record cannot enter prod */

describe('3 · a prototype:true record entering the production path throws', () => {
  it('assertNoPrototypeRecords rejects a tainted record', () => {
    expect(() => assertNoPrototypeRecords([{ prototype: true }], 'test')).toThrow(/prototype:true/);
  });

  it('assertNoPrototypeRecords passes clean records and empty lists', () => {
    expect(() => assertNoPrototypeRecords([], 'test')).not.toThrow();
    expect(() => assertNoPrototypeRecords([{ prototype: false }, {}, null], 'test')).not.toThrow();
  });

  it('assertProductionClean rejects a dataset with a leaked fixture record', () => {
    const tainted = { prototype: true, id: 'leak', name: 'leaked example' } as unknown as Project;
    const leaked: PrototypeDataset = { ...loadWorkspaceDataset(), projects: [tainted] };
    expect(() => assertProductionClean(leaked)).toThrow(/prototype:true/);
  });

  it('the real production dataset passes the clean assertion', () => {
    expect(() => assertProductionClean(loadWorkspaceDataset())).not.toThrow();
  });

  it('not one fixture record carries through — every real fixture record does carry the flag', () => {
    // The two halves of the same invariant: fixtures ARE flagged (so the gate can
    // spot them), and the production dataset carries NONE of them.
    expect(FIXTURE_DATASET.projects.every((p) => p.prototype === true)).toBe(true);
    expect(loadWorkspaceDataset().projects.some((p) => (p as { prototype?: unknown }).prototype === true)).toBe(
      false,
    );
  });
});

/* ============================ 4. PRODUCTION_MOCK_DATA_ALLOWED is enforced */

describe('4 · PRODUCTION_MOCK_DATA_ALLOWED is false and actually enforced', () => {
  it('the policy constant is false, and the gate re-exports the same value', () => {
    expect(PRODUCTION_MOCK_DATA_ALLOWED).toBe(false);
    expect(GATE_MOCK_ALLOWED).toBe(false);
    expect(GATE_MOCK_ALLOWED).toBe(PRODUCTION_MOCK_DATA_ALLOWED);
  });

  it('guardFixtureLoad FAILS LOUDLY in production, naming the policy', () => {
    expect(isProductionMode()).toBe(true);
    let thrown: unknown;
    try {
      guardFixtureLoad('test');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProductionFixtureError);
    expect((thrown as Error).message).toMatch(/PRODUCTION_MOCK_DATA_ALLOWED/);
  });

  it('loadFixtureDataset refuses to hand back fixtures in a production build', () => {
    // The enforcement that matters: even the function whose whole job is to load
    // the example data is stopped by the policy while the build is production.
    expect(() => loadFixtureDataset()).toThrow(ProductionFixtureError);
  });

  it('lifts the refusal only when fixtures are explicitly enabled', () => {
    enableFixturesFully();
    expect(() => guardFixtureLoad('test')).not.toThrow();
    expect(loadFixtureDataset().projects.length).toBeGreaterThan(0);
  });
});

/* ================================= 5. no EXAMPLE labels in production mode */

describe('5 · EXAMPLE labels do not render in production mode', () => {
  it('renders no EXAMPLE label when the gate is in production mode', () => {
    renderExampleTagsFor(loadWorkspaceDataset());
    expect(screen.queryAllByText('EXAMPLE')).toHaveLength(0);
  });

  it('does render EXAMPLE labels once fixtures are explicitly enabled', () => {
    // The contrast: the absence above is the empty production dataset, not a
    // broken query. With fixtures on, an EXAMPLE label appears per example record.
    enableFixturesFully();
    const data = loadWorkspaceDataset();
    renderExampleTagsFor(data);
    expect(screen.queryAllByText('EXAMPLE').length).toBe(data.projects.length);
    expect(screen.queryAllByText('EXAMPLE').length).toBeGreaterThan(0);
  });
});
