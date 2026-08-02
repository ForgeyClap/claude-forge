/**
 * Switch — a real role="switch" button, not a styled checkbox.
 *
 * State is carried by three things at once: aria-checked, the thumb position,
 * and a hard value inversion of the track (text value on, surface off). No hue
 * involved, so it reads the same in greyscale.
 */

import type { ReactNode } from 'react';

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Visible text and accessible name. */
  label: ReactNode;
  /** Hide the label visually, keeping it for assistive tech. */
  labelHidden?: boolean;
  disabled?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}

export function Switch({
  checked,
  onChange,
  label,
  labelHidden = false,
  disabled = false,
  size = 'md',
  className,
}: SwitchProps) {
  const classes = ['fw-switch', `fw-switch--${size}`];
  if (checked) classes.push('is-checked');
  if (className) classes.push(className);

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={classes.join(' ')}
      onClick={() => onChange(!checked)}
    >
      <span className="fw-switch__track" aria-hidden="true">
        <span className="fw-switch__thumb" />
      </span>
      <span className={labelHidden ? 'fw-visually-hidden' : 'fw-switch__label'}>{label}</span>
    </button>
  );
}
