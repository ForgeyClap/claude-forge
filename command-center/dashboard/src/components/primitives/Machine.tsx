/**
 * Machine — the provenance marker.
 *
 * Wrap anything the system recorded rather than a person wrote: ids, agent
 * names, model labels, timestamps, paths, commands, hashes, ports, event names,
 * test output, ledger lines. It sets the monospace face via the shared
 * .fg-machine class defined in brand/forge-base.css.
 */

import type { HTMLAttributes, ReactNode } from 'react';

export interface MachineProps extends HTMLAttributes<HTMLSpanElement> {
  /** Dim it to the muted text value. */
  muted?: boolean;
  children?: ReactNode;
}

export function Machine({ muted = false, className, children, ...rest }: MachineProps) {
  const classes = ['fg-machine', 'fw-machine'];
  if (muted) classes.push('fw-machine--muted');
  if (className) classes.push(className);
  return (
    <span {...rest} className={classes.join(' ')}>
      {children}
    </span>
  );
}
