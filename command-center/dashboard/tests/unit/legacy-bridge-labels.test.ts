/**
 * The `legacy-bridge*` suite labels must keep telling the truth.
 *
 * Why this file exists: a system-checkup (2026-07-30) found that five test
 * directories exercise only `src/bridge/**` — the 39-op WebSocket bridge the
 * shipped product never runs — while carrying names (`bridge`, `security`) that
 * made their green result read as evidence about the LIVE gateway path. The fix
 * was to rename the vitest projects to `legacy-bridge` / `legacy-bridge-paths`,
 * not to delete or skip anything.
 *
 * A rename is only honest while it stays accurate. Two ways it could rot:
 *
 *   1. Someone adds a test for LIVE code (gateway adapter, a view, a shared
 *      module) into one of the legacy directories. Its result would then be
 *      filed under a label that says "this is about dead code" — real coverage
 *      hidden behind a dismissive name, the mirror image of the original bug.
 *   2. Someone moves a bridge test into `tests/property/**`, which is
 *      deliberately labelled `shared` because it tests `@/shared/**` — code the
 *      live path really does import.
 *
 * So: every file in a legacy directory must import `@/bridge`, and no file in
 * `tests/property` may. This reads the real files off disk — it cannot pass by
 * agreeing with a fixture.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// fileURLToPath, not URL.pathname — this project's path contains a space.
const testsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every `*.test.ts(x)` directly inside `tests/<name>`, as absolute paths. */
function testFilesIn(dirName: string): string[] {
  const dir = path.join(testsDir, dirName);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => /\.test\.tsx?$/.test(f))
    .map((f) => path.join(dir, f))
    .filter((f) => statSync(f).isFile());
}

/**
 * Does this test target the dead bridge — directly, or through a sibling helper?
 *
 * `tests/integration` deliberately imports NO bridge module: it spawns the real
 * `node src/bridge/main.ts` as a child process from its own `helpers.ts`, which
 * is exactly as much "a bridge test" as a direct import is. So the check reads
 * the file plus any helper it imports from its own directory, and looks for a
 * bridge module path in either.
 */
const BRIDGE_PATH_RE = /(@\/bridge\/|src\/bridge\/)/;

function targetsBridge(file: string): boolean {
  const source = readFileSync(file, 'utf8');
  if (BRIDGE_PATH_RE.test(source)) return true;
  const dir = path.dirname(file);
  for (const [, spec] of source.matchAll(/from\s+['"](\.\/[^'"]+)['"]/g)) {
    const base = spec.replace(/^\.\//, '').replace(/\.(ts|tsx|js|mjs)$/, '');
    for (const ext of ['.ts', '.tsx', '.mjs', '.js']) {
      try {
        if (BRIDGE_PATH_RE.test(readFileSync(path.join(dir, base + ext), 'utf8'))) return true;
      } catch {
        /* not this extension — try the next */
      }
    }
  }
  return false;
}

const LEGACY_DIRS = ['chaos', 'idempotency', 'negative', 'security', 'integration'];

describe('legacy-bridge suite labels stay accurate', () => {
  for (const dirName of LEGACY_DIRS) {
    it(`every test in tests/${dirName} really does target the dead bridge`, () => {
      const files = testFilesIn(dirName);
      // A directory that has been emptied is not a failure — but an empty list
      // must not silently make this assertion vacuous, so state it either way.
      if (files.length === 0) {
        expect(files).toEqual([]);
        return;
      }
      const live = files.filter((f) => !targetsBridge(f)).map((f) => path.basename(f));
      expect(
        live,
        `these files sit in the legacy-bridge-labelled tests/${dirName} but do not import @/bridge — ` +
          'if they test live code, move them to tests/unit (jsdom) or tests/property (node) so their ' +
          'coverage is not filed under a label that says "dead code"',
      ).toEqual([]);
    });
  }

  it('tests/property stays about live @/shared code, not the bridge', () => {
    const files = testFilesIn('property');
    expect(files.length).toBeGreaterThan(0);
    const bridgey = files.filter(targetsBridge).map((f) => path.basename(f));
    expect(
      bridgey,
      'tests/property runs under the `shared` project label because it targets @/shared/** — ' +
        'a bridge test here would be mislabelled as live coverage',
    ).toEqual([]);
  });
});
