/**
 * Button — four variants, two heights, both taken from the control tokens.
 *
 *   primary  the one accented control on a screen (accent fill)
 *   ghost    the neutral default: surface + hairline border
 *   quiet    transparent until hovered
 *   danger   heavier border treatment, still monochrome — danger is never red
 *            in this system, it is weight (--forge-status-failed tokens)
 */

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Icon } from './Icon';

export type ButtonVariant = 'primary' | 'ghost' | 'quiet' | 'danger';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  /** lucide icon name shown before the label. */
  icon?: string;
  /** lucide icon name shown after the label. */
  iconRight?: string;
  /** Stretch to the width of the container. */
  block?: boolean;
  children?: ReactNode;
}

export function Button({
  variant = 'ghost',
  size = 'md',
  icon,
  iconRight,
  block = false,
  className,
  type = 'button',
  children,
  ...rest
}: ButtonProps) {
  const classes = ['fw-control', 'fw-button', `fw-button--${variant}`, `fw-button--${size}`];
  if (block) classes.push('fw-button--block');
  if (className) classes.push(className);

  const iconSize = size === 'sm' ? 'xs' : 'sm';

  return (
    <button {...rest} type={type} className={classes.join(' ')}>
      {icon ? <Icon name={icon} size={iconSize} className="fw-button__icon" /> : null}
      {children != null ? <span className="fw-button__label">{children}</span> : null}
      {iconRight ? <Icon name={iconRight} size={iconSize} className="fw-button__icon" /> : null}
    </button>
  );
}
