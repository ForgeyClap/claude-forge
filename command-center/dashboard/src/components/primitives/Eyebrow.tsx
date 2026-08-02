/**
 * Eyebrow — the small uppercase tracking label that names a region.
 *
 * Uses the shared .fg-eyebrow class from brand/forge-base.css (mono, 2xs,
 * eyebrow tracking, muted). It is a label, not a heading — if the region needs
 * a heading, use <Panel title>.
 */

import type { HTMLAttributes, ReactNode } from 'react';

export interface EyebrowProps extends HTMLAttributes<HTMLSpanElement> {
  children?: ReactNode;
}

export function Eyebrow({ className, children, ...rest }: EyebrowProps) {
  const classes = ['fg-eyebrow', 'fw-eyebrow'];
  if (className) classes.push(className);
  return (
    <span {...rest} className={classes.join(' ')}>
      {children}
    </span>
  );
}
