/**
 * Toolbar / ToolbarGroup / Spacer — the horizontal control strip.
 *
 * Toolbar only claims role="toolbar" when it is given a label, because the role
 * promises arrow-key navigation over a named group of controls. An unlabelled
 * strip stays a plain div, which is honest about what it is.
 */

import type { ReactNode } from 'react';

export interface ToolbarProps {
  /** Naming the toolbar opts it into role="toolbar". */
  label?: string;
  /** Draw a hairline under the strip. */
  bordered?: boolean;
  className?: string;
  children?: ReactNode;
}

export function Toolbar({ label, bordered = false, className, children }: ToolbarProps) {
  const classes = ['fw-toolbar'];
  if (bordered) classes.push('fw-toolbar--bordered');
  if (className) classes.push(className);

  return (
    <div
      className={classes.join(' ')}
      role={label ? 'toolbar' : undefined}
      aria-label={label}
      aria-orientation={label ? 'horizontal' : undefined}
    >
      {children}
    </div>
  );
}

export interface ToolbarGroupProps {
  /** Draw a hairline before the group. */
  divided?: boolean;
  className?: string;
  children?: ReactNode;
}

export function ToolbarGroup({ divided = false, className, children }: ToolbarGroupProps) {
  const classes = ['fw-toolbar__group'];
  if (divided) classes.push('fw-toolbar__group--divided');
  if (className) classes.push(className);
  return <div className={classes.join(' ')}>{children}</div>;
}

export interface SpacerProps {
  className?: string;
}

/** Eats the remaining space in a flex row. */
export function Spacer({ className }: SpacerProps) {
  return <span className={className ? `fw-spacer ${className}` : 'fw-spacer'} aria-hidden="true" />;
}
