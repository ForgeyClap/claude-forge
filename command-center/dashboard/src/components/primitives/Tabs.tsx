/**
 * Tabs — a real tablist with arrow-key navigation.
 *
 * The component renders the tab strip only; panels stay with the view that owns
 * the content. Pass the same `idPrefix` to <Tabs> and to each <TabPanel> and
 * the aria-controls / aria-labelledby pair is wired for you. Leave it out and
 * the strip degrades to a labelled tablist without panel association.
 *
 * Activation is automatic (arrow key selects), which is the expected behaviour
 * for cheap, already-rendered panels.
 */

import { useId, useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

export interface TabItem {
  value: string;
  label: string;
  /** Optional count rendered in the machine face. */
  count?: number;
}

export interface TabsProps {
  items: readonly TabItem[];
  value: string;
  onChange: (value: string) => void;
  /** Accessible name for the tablist. Required. */
  ariaLabel: string;
  /** Share this with <TabPanel> to wire aria-controls / aria-labelledby. */
  idPrefix?: string;
  size?: 'sm' | 'md';
  className?: string;
}

export function Tabs({
  items,
  value,
  onChange,
  ariaLabel,
  idPrefix,
  size = 'md',
  className,
}: TabsProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const fallbackPrefix = useId();
  const prefix = idPrefix ?? fallbackPrefix;
  const wired = idPrefix != null;

  function focusAt(index: number) {
    listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[index]?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (items.length === 0) return;
    const current = items.findIndex((item) => item.value === value);
    let next = -1;

    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      next = (current + 1 + items.length) % items.length;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      next = (current - 1 + items.length) % items.length;
    } else if (event.key === 'Home') {
      next = 0;
    } else if (event.key === 'End') {
      next = items.length - 1;
    }

    if (next < 0) return;
    event.preventDefault();
    onChange(items[next].value);
    focusAt(next);
  }

  const classes = ['fw-tabs', `fw-tabs--${size}`];
  if (className) classes.push(className);

  return (
    <div
      ref={listRef}
      className={classes.join(' ')}
      role="tablist"
      aria-label={ariaLabel}
      aria-orientation="horizontal"
      onKeyDown={handleKeyDown}
    >
      {items.map((item) => {
        const selected = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            id={`${prefix}-tab-${item.value}`}
            aria-selected={selected}
            aria-controls={wired ? `${prefix}-panel-${item.value}` : undefined}
            tabIndex={selected ? 0 : -1}
            className={selected ? 'fw-tabs__tab is-selected' : 'fw-tabs__tab'}
            onClick={() => onChange(item.value)}
          >
            <span className="fw-tabs__label">{item.label}</span>
            {typeof item.count === 'number' ? (
              <span className="fw-tabs__count fg-machine">{item.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export interface TabPanelProps {
  /** Must match the idPrefix given to <Tabs>. */
  idPrefix: string;
  value: string;
  active: boolean;
  className?: string;
  children?: ReactNode;
}

/** The panel half of the tab contract. Renders nothing when inactive. */
export function TabPanel({ idPrefix, value, active, className, children }: TabPanelProps) {
  if (!active) return null;
  const classes = ['fw-tabpanel'];
  if (className) classes.push(className);
  return (
    <div
      className={classes.join(' ')}
      role="tabpanel"
      id={`${idPrefix}-panel-${value}`}
      aria-labelledby={`${idPrefix}-tab-${value}`}
      tabIndex={0}
    >
      {children}
    </div>
  );
}
