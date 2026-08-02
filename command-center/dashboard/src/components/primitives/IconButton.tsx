/**
 * IconButton — a square control that is nothing but an icon, so `label` is
 * mandatory. It becomes the accessible name and the tooltip.
 *
 * Pass `active` only when the button is a toggle; it then reports aria-pressed.
 */

import type { ButtonHTMLAttributes } from 'react';
import { Icon } from './Icon';

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label'> {
  /** lucide icon name. */
  icon: string;
  /** Required. Accessible name and tooltip. */
  label: string;
  size?: 'sm' | 'md';
  /** Toggle state. Omit entirely for non-toggle buttons. */
  active?: boolean;
}

export function IconButton({
  icon,
  label,
  size = 'md',
  active,
  className,
  type = 'button',
  title,
  ...rest
}: IconButtonProps) {
  const classes = ['fw-control', 'fw-icon-button', `fw-icon-button--${size}`];
  if (active) classes.push('is-active');
  if (className) classes.push(className);

  return (
    <button
      {...rest}
      type={type}
      className={classes.join(' ')}
      aria-label={label}
      title={title ?? label}
      aria-pressed={typeof active === 'boolean' ? active : undefined}
    >
      <Icon name={icon} size={size === 'sm' ? 'sm' : 'md'} />
    </button>
  );
}
