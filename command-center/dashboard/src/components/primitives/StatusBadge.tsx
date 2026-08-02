/**
 * StatusBadge — icon + UPPERCASE label + border treatment.
 *
 * Three independent signals, so the state survives greyscale, colour blindness
 * and a screenshot printed on a laser printer:
 *   1. the lucide icon
 *   2. the uppercase machine-set label
 *   3. the border style and width from --forge-status-<key>-style / -width
 */

import { Icon } from './Icon';
import { statusPresentation } from './status-presentation';
import type { StatusKey } from '@/prototype/types/prototype-types';

export interface StatusBadgeProps {
  status: StatusKey;
  size?: 'sm' | 'md';
  /** Hide the text label, keeping the icon plus an accessible name. */
  iconOnly?: boolean;
  className?: string;
}

export function StatusBadge({ status, size = 'md', iconOnly = false, className }: StatusBadgeProps) {
  const presentation = statusPresentation(status);
  const classes = ['fw-status', 'fw-status-badge', `fw-status-badge--${size}`];
  if (iconOnly) classes.push('fw-status-badge--icon-only');
  if (className) classes.push(className);

  return (
    <span className={classes.join(' ')} data-status={status} title={presentation.description}>
      <Icon
        name={presentation.icon}
        size={size === 'sm' ? 'xs' : 'sm'}
        spin={presentation.animated}
        className="fw-status-badge__icon"
      />
      {iconOnly ? null : (
        <span className="fw-status-badge__label fg-machine" aria-hidden="true">
          {presentation.label}
        </span>
      )}
      <span className="fw-visually-hidden">{presentation.description}</span>
    </span>
  );
}
