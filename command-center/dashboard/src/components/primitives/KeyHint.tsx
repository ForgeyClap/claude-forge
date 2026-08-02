/**
 * KeyHint — a keyboard shortcut rendered as real <kbd> elements.
 *
 * The separator stays visible rather than aria-hidden so the shortcut reads as
 * "Ctrl + K" to a screen reader instead of "Ctrl K".
 */

import { Fragment } from 'react';

export interface KeyHintProps {
  keys: readonly string[];
  size?: 'sm' | 'md';
  className?: string;
}

export function KeyHint({ keys, size = 'sm', className }: KeyHintProps) {
  const classes = ['fw-keyhint', `fw-keyhint--${size}`];
  if (className) classes.push(className);

  return (
    <kbd className={classes.join(' ')}>
      {keys.map((key, index) => (
        <Fragment key={`${key}-${index}`}>
          {index > 0 ? <span className="fw-keyhint__sep">+</span> : null}
          <kbd className="fw-keyhint__key fg-machine">{key}</kbd>
        </Fragment>
      ))}
    </kbd>
  );
}
