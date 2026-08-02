/**
 * Every icon name the app actually asks for must exist in the map.
 *
 * Why this test exists: `X` — the close/dismiss/clear-filter icon — was referenced from eight
 * places (Modal's close button, Toasts' dismiss, Sidebar ×2, Inspector, ActivityView,
 * ArtifactsView, ProjectsView's clear-filter) and was **not** in the map. `Icon` degrades an
 * unknown name to a neutral Circle with a dev-only `console.warn`, so nothing crashed and no test
 * failed — every one of those buttons simply rendered a circle where a cross belonged, and the
 * warning scrolled past in test output for however long it had been that way.
 *
 * That is the failure mode this file closes: a graceful fallback plus a warning nobody reads is
 * indistinguishable from working software. The map is hand-maintained (icon-map.ts's own header
 * says so), so the only real guard is checking the call sites against it.
 *
 * The scan is deliberately literal-only — `icon="Foo"` / `name="Foo"` / `icon: 'Foo'`. Names built
 * at runtime from data (status → icon lookups, gateway-provided kinds) cannot be resolved
 * statically and are out of scope here; `Icon`'s fallback still covers those safely.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ICON_NAMES } from '@/components/primitives/icon-map';

const SRC = resolve(process.cwd(), 'src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

/**
 * Two precise patterns, not one loose one.
 *
 * A first draft matched any `name` key too, and promptly "found" 27 missing icons that were error
 * classes (`name: 'AdapterError'`), project-type labels (`name: 'Website'`) and check names
 * (`name: 'Typecheck'`). A test that cries wolf gets its assertion loosened until it proves
 * nothing, so the pattern is narrowed instead: only the `icon` prop, and `name` only when it sits
 * on an actual `<Icon>` element.
 */
const ICON_PROP = /\bicon\s*[=:]\s*["']([A-Z][A-Za-z0-9]*)["']/g;
const ICON_ELEMENT_NAME = /<Icon\b[^>]*?\bname=["']([A-Z][A-Za-z0-9]*)["']/g;

describe('icon map covers every literal icon name in the app', () => {
  it('has no unknown literal icon name', () => {
    const known = new Set<string>(ICON_NAMES);
    const missing: string[] = [];

    for (const file of walk(SRC)) {
      // The map itself documents names in prose; scanning it would report its own examples.
      if (file.endsWith('icon-map.ts')) continue;
      const source = readFileSync(file, 'utf8');
      for (const pattern of [ICON_PROP, ICON_ELEMENT_NAME]) {
        for (const match of source.matchAll(pattern)) {
          const iconName = match[1];
          if (!known.has(iconName)) {
            missing.push(`${file.slice(SRC.length + 1)} → "${iconName}"`);
          }
        }
      }
    }

    expect(missing, `Icon names used but absent from icon-map.ts:\n${missing.join('\n')}`).toEqual([]);
  });

  it('includes X — the close/dismiss/clear icon, the one this test was written for', () => {
    expect(ICON_NAMES).toContain('X');
  });
});
