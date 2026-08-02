/**
 * The import-graph test — certification finding #5 (fix-cert-fixtures,
 * forge-2026-07-29-cc-finish, run on the Forge Command Center dashboard).
 *
 * The certification found the runtime gate honest (`loadWorkspaceDataset()`
 * genuinely returns an empty dataset in production — see `production-mode.
 * test.ts`) but the STATIC import graph dishonest: `PrototypeProvider.tsx`,
 * `Dock.tsx` and `views/chat/ClaudeCodeChip.tsx` all imported from
 * `prototype/data` (or its `claude-code` submodule) at their top level, and
 * that gate module itself statically imported the full `prototype/fixtures`
 * barrel — so a production build's entry chunk carried the whole 18-agent
 * registry, every example conversation, task and artefact, regardless of the
 * fact that nothing ever rendered it. A grep for "is fixture data imported
 * anywhere" would be trivially true (fixtures exist and are legitimately used
 * by tests and, behind a lazy boundary, by fixture mode) and therefore
 * useless. What actually matters — and what this suite enforces — is whether a
 * fixture module is reachable via a STATIC import chain starting from the
 * app's real production entry point, `src/main.tsx`.
 *
 * WHY THE TYPESCRIPT COMPILER API, NOT A REGEX SCAN. This repo's other
 * source-scanning suites (`no-runtime-contact.test.ts`) use plain regex over
 * file text, which is fine for "does this literal substring appear". An import
 * GRAPH needs three things a regex cannot reliably give: (1) distinguishing a
 * real `import ... from '...'` / `export ... from '...'` declaration from a
 * DYNAMIC `import('...')` call — the latter is a deliberate Rollup/Vite
 * code-split boundary (the same mechanism `App.tsx` already uses for every
 * route) and must NOT count as a bundling edge, or this test could never be
 * satisfied without deleting fixtures outright; (2) ignoring `import type` /
 * `export type` declarations, which `verbatimModuleSyntax` (tsconfig.json)
 * guarantees are erased before bundling; (3) not being fooled by the word
 * "fixtures" appearing in a comment or a string. `typescript` is already a
 * devDependency, so `ts.createSourceFile` + a shallow top-level walk (import/
 * export declarations are always top-level in valid TS/JS) gives an exact
 * answer to all three with no new dependency.
 *
 * TDD proof this test has teeth: run BEFORE the fix (git stash of the fix
 * commits, source files only) it failed with 12 fixture files reachable from
 * `src/main.tsx`, every one through `PrototypeProvider.tsx -> prototype/data/
 * index.ts -> prototype/fixtures/index.ts -> *`. See the work package report
 * for the literal captured output.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');
const ENTRY = join(SRC, 'main.tsx');
const FIXTURE_PROVIDER = join(SRC, 'prototype', 'state', 'fixture-provider.tsx');
const FIXTURES_DIR_PREFIX = join(SRC, 'prototype', 'fixtures') + sep;

/** A resolved local project file candidate, in resolution-priority order. */
const CANDIDATE_SUFFIXES = ['.tsx', '.ts', `${sep}index.tsx`, `${sep}index.ts`];

/**
 * Resolves an import specifier the same way this project's own Vite config
 * does: `@/` -> `src/`, `.`/`..` -> relative to the importing file. A bare
 * specifier (a package name — `react`, `lucide-react`, `react-router-dom`, …)
 * resolves to `null`: this graph only follows the project's OWN modules, which
 * is exactly where a fixture-module edge could hide.
 */
function resolveModule(specifier: string, fromFile: string): string | null {
  let base: string;
  if (specifier.startsWith('@/')) {
    base = join(SRC, specifier.slice(2));
  } else if (specifier.startsWith('.')) {
    base = resolve(dirname(fromFile), specifier);
  } else {
    return null;
  }
  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = base + suffix;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

interface StaticEdge {
  readonly specifier: string;
  readonly isTypeOnly: boolean;
}

/**
 * Every STATIC `import`/`export ... from` edge this file declares, read via
 * the real TypeScript AST — never a dynamic `import()` call (those are
 * nested inside expressions, not top-level declarations, so a shallow
 * `forEachChild` walk cannot see them even by accident; that asymmetry is
 * exactly the point).
 */
function staticEdgesOf(file: string): StaticEdge[] {
  const text = readFileSync(file, 'utf8');
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const edges: StaticEdge[] = [];

  sourceFile.forEachChild((node) => {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      edges.push({ specifier: node.moduleSpecifier.text, isTypeOnly: node.importClause?.isTypeOnly === true });
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      edges.push({ specifier: node.moduleSpecifier.text, isTypeOnly: node.isTypeOnly === true });
    }
  });

  return edges;
}

interface ReachedGraph {
  readonly parentOf: ReadonlyMap<string, string | null>;
}

/** BFS over static edges only, starting from `entry`. Records a parent pointer per file so a violation can print its real import chain. */
function walkStatic(entry: string): ReachedGraph {
  const parentOf = new Map<string, string | null>();
  parentOf.set(entry, null);
  const queue: string[] = [entry];

  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const edge of staticEdgesOf(current)) {
      if (edge.isTypeOnly) continue; // erased before bundling — not a real edge
      const resolved = resolveModule(edge.specifier, current);
      if (!resolved || parentOf.has(resolved)) continue;
      parentOf.set(resolved, current);
      queue.push(resolved);
    }
  }

  return { parentOf };
}

function chainTo(graph: ReachedGraph, target: string): string {
  const parts: string[] = [];
  let cursor: string | null = target;
  while (cursor !== null) {
    parts.unshift(relative(ROOT, cursor).split(sep).join('/'));
    cursor = graph.parentOf.get(cursor) ?? null;
  }
  return parts.join(' -> ');
}

/* ========================================================================== */

describe('the import-graph walk is real, not a placeholder that would pass vacuously', () => {
  it('the production entry point exists', () => {
    expect(existsSync(ENTRY)).toBe(true);
  });

  it('reaches a substantial, real portion of the source tree from src/main.tsx', () => {
    const graph = walkStatic(ENTRY);
    // Measured directly at 65 files on the fixed tree (2026-07-29). A floor well
    // below that catches a broken resolver (which would silently reach almost
    // nothing) without being brittle to ordinary future file additions.
    expect(graph.parentOf.size).toBeGreaterThan(45);
  });
});

describe('5 · no fixture module is imported by production-rendering code', () => {
  it('no file under src/prototype/fixtures/ is statically reachable from src/main.tsx', () => {
    const graph = walkStatic(ENTRY);
    const offenders = [...graph.parentOf.keys()].filter((file) => file.startsWith(FIXTURES_DIR_PREFIX));
    const detail = offenders.map((file) => chainTo(graph, file));
    expect(
      offenders,
      `fixture module(s) reachable via a STATIC import chain from src/main.tsx:\n${detail.join('\n')}`,
    ).toEqual([]);
  });

  it('the lazy-loaded fixture provider module still reaches prototype/fixtures itself (the boundary is a deliberate code-split, not an orphaned/broken import)', () => {
    expect(existsSync(FIXTURE_PROVIDER)).toBe(true);
    const graph = walkStatic(FIXTURE_PROVIDER);
    const reachesFixtures = [...graph.parentOf.keys()].some((file) => file.startsWith(FIXTURES_DIR_PREFIX));
    expect(reachesFixtures).toBe(true);
  });

  it('PrototypeProvider.tsx reaches the fixture provider only through a dynamic import(), never a static one', () => {
    const providerFile = join(SRC, 'prototype', 'PrototypeProvider.tsx');
    const graph = walkStatic(providerFile);
    // A static walk from PrototypeProvider.tsx itself must NOT reach
    // fixture-provider.tsx (that edge is a lazy() + dynamic import() only).
    expect(graph.parentOf.has(FIXTURE_PROVIDER)).toBe(false);
    const text = readFileSync(providerFile, 'utf8');
    expect(text).toMatch(/lazy\(\s*\(\)\s*=>\s*import\(\s*['"]@\/prototype\/state\/fixture-provider['"]\s*\)\s*\)/);
  });
});
