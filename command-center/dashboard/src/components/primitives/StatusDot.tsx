/**
 * StatusDot — the compact form of StatusBadge, for dense rows and graph nodes.
 *
 * Still not a coloured circle: it carries the status icon inside a ring whose
 * style and width come from the status tokens, and it always exposes an
 * accessible name.
 */

import { Icon } from './Icon';
import { statusPresentation } from './status-presentation';
import type { StatusKey } from '@/prototype/types/prototype-types';

export interface StatusDotProps {
  status: StatusKey;
  className?: string;
}

export function StatusDot({ status, className }: StatusDotProps) {
  const presentation = statusPresentation(status);
  const classes = ['fw-status', 'fw-status-dot'];
  if (className) classes.push(className);

  return (
    <span
      className={classes.join(' ')}
      data-status={status}
      role="img"
      aria-label={presentation.description}
      title={presentation.description}
    >
      <Icon
        name={presentation.icon}
        size="xs"
        spin={presentation.animated}
        className="fw-status-dot__icon"
      />
    </span>
  );
}
