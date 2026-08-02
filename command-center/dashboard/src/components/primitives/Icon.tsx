/**
 * Icon — the one place lucide is touched.
 *
 * Sizing comes from the --forge-icon-* tokens via CSS, not from lucide's
 * numeric `size` prop, so an icon can never drift off the scale. Stroke width
 * defaults to 1.5 (2 for emphasis, passed explicitly).
 *
 * Icons are decorative by default: aria-hidden, focusable=false. Pass `label`
 * only when the icon is the sole carrier of meaning — and prefer not to, since
 * the design law says an icon always travels with a text label.
 *
 * Resolution is a lookup in the static ICON_MAP, not `import * as Lucide`. The
 * namespace import defeated tree-shaking and dragged the entire icon library
 * into the bundle; naming each import in icon-map.ts is what lets Rollup drop
 * the ~1,400 icons this app never renders. The public API is deliberately
 * unchanged — `name` is still a plain string, so every existing call site,
 * including the ones that pass a value out of a lookup table, keeps working.
 */

import { createElement } from 'react';

import { FALLBACK_ICON, ICON_MAP } from './icon-map';

export type IconSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

export interface IconProps {
  /** Any icon name registered in icon-map.ts, e.g. "Play", "TriangleAlert". */
  name: string;
  size?: IconSize;
  /** 1.5 for most UI, 2 for emphasis. */
  strokeWidth?: number;
  /** Spins the icon. Suppressed under prefers-reduced-motion. */
  spin?: boolean;
  /** Give the icon an accessible name. Omit for decorative icons. */
  label?: string;
  className?: string;
}

// Vite substitutes a literal here, so the whole warning path is dead code in a
// production build and gets dropped. Read through a cast rather than a
// /// <reference types="vite/client" /> so this file stays free of
// program-wide ambient types.
const isDev = (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true;

/** One warning per unknown name, not one per render. */
const warned = new Set<string>();

function resolveIcon(name: string) {
  const found = ICON_MAP[name];
  if (found) return found;

  if (isDev && !warned.has(name)) {
    warned.add(name);
    console.warn(
      `[Icon] Unknown icon name "${name}" — rendering a Circle instead. ` +
        `Icons are resolved from a static map so the bundle only carries what it uses; ` +
        `add "${name}" to src/components/primitives/icon-map.ts to render it.`,
    );
  }
  // Unknown name: render a neutral mark rather than a hole in the layout.
  return FALLBACK_ICON;
}

export function Icon({
  name,
  size = 'md',
  strokeWidth = 1.5,
  spin = false,
  label,
  className,
}: IconProps) {
  // Looked up, never constructed — createElement keeps that unambiguous to the
  // linter and avoids a capitalised local that reads like a new component.
  const glyph = resolveIcon(name);
  const classes = ['fw-icon', `fw-icon--${size}`];
  if (spin) classes.push('fw-icon--spin');
  if (className) classes.push(className);

  return createElement(glyph, {
    className: classes.join(' '),
    strokeWidth,
    focusable: 'false',
    'aria-hidden': label ? undefined : true,
    role: label ? 'img' : undefined,
    'aria-label': label,
  });
}
