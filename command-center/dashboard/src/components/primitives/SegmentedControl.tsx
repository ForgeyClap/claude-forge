/**
 * SegmentedControl — a small set of mutually exclusive options.
 *
 * Real radiogroup semantics: roving tabindex, arrow keys move and select,
 * Home/End jump to the ends. The selected segment is the one control on screen
 * allowed to carry the ember accent, and it does so as a 2px underline rather
 * than a fill.
 */

import { useRef } from 'react';
import type { KeyboardEvent } from 'react';
import { Icon } from './Icon';

export interface SegmentedOption {
  value: string;
  label: string;
  /** lucide icon name. */
  icon?: string;
}

export interface SegmentedControlProps {
  options: readonly SegmentedOption[];
  value: string;
  onChange: (value: string) => void;
  /** Accessible name for the group. Required. */
  label: string;
  size?: 'sm' | 'md';
  /** Show icons only, with the label as the accessible name. */
  iconOnly?: boolean;
  className?: string;
}

export function SegmentedControl({
  options,
  value,
  onChange,
  label,
  size = 'md',
  iconOnly = false,
  className,
}: SegmentedControlProps) {
  const groupRef = useRef<HTMLDivElement>(null);

  function focusAt(index: number) {
    const buttons = groupRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    buttons?.[index]?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (options.length === 0) return;
    const current = options.findIndex((option) => option.value === value);
    let next = -1;

    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      next = (current + 1 + options.length) % options.length;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      next = (current - 1 + options.length) % options.length;
    } else if (event.key === 'Home') {
      next = 0;
    } else if (event.key === 'End') {
      next = options.length - 1;
    }

    if (next < 0) return;
    event.preventDefault();
    onChange(options[next].value);
    focusAt(next);
  }

  const classes = ['fw-segmented', `fw-segmented--${size}`];
  if (iconOnly) classes.push('fw-segmented--icon-only');
  if (className) classes.push(className);

  return (
    <div
      ref={groupRef}
      className={classes.join(' ')}
      role="radiogroup"
      aria-label={label}
      onKeyDown={handleKeyDown}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={iconOnly ? option.label : undefined}
            title={iconOnly ? option.label : undefined}
            tabIndex={selected ? 0 : -1}
            className={selected ? 'fw-segmented__option is-selected' : 'fw-segmented__option'}
            onClick={() => onChange(option.value)}
          >
            {option.icon ? (
              <Icon name={option.icon} size={size === 'sm' ? 'xs' : 'sm'} />
            ) : null}
            {iconOnly && option.icon ? null : (
              <span className="fw-segmented__label">{option.label}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
