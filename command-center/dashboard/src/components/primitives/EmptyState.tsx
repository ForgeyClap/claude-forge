/**
 * EmptyState — what a region says when it has nothing to show.
 *
 * Quiet by design: a bordered glyph, one line of title, one line of detail, and
 * at most one action. No illustration, no oversized heading.
 */

import type { ReactNode } from 'react';
import { Icon } from './Icon';

export interface EmptyStateProps {
  /** lucide icon name. */
  icon: string;
  title: string;
  detail?: string;
  action?: ReactNode;
  /** Tighten for use inside a narrow column or a dock panel. */
  compact?: boolean;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  detail,
  action,
  compact = false,
  className,
}: EmptyStateProps) {
  const classes = ['fw-empty'];
  if (compact) classes.push('fw-empty--compact');
  if (className) classes.push(className);

  return (
    <div className={classes.join(' ')}>
      <span className="fw-empty__glyph">
        <Icon name={icon} size={compact ? 'md' : 'lg'} />
      </span>
      <p className="fw-empty__title">{title}</p>
      {detail ? <p className="fw-empty__detail">{detail}</p> : null}
      {action ? <div className="fw-empty__action">{action}</div> : null}
    </div>
  );
}
