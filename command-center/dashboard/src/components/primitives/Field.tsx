/**
 * Field — label + control + optional hint, with consistent vertical rhythm.
 *
 * Pass `htmlFor` whenever the control has an id: the label is then a real
 * <label for>. Without it the field falls back to role="group" with the label
 * as the group name, which is honest rather than pretending an association
 * that does not exist. It deliberately does not wrap the control in the label,
 * because that breaks composite controls such as Switch and SegmentedControl.
 *
 * If the control needs aria-describedby pointing at the hint, give the hint an
 * id via `hintId` and set the attribute on the control yourself.
 */

import type { ReactNode } from 'react';

export interface FieldProps {
  label: string;
  hint?: string;
  /** id of the control this field labels. */
  htmlFor?: string;
  /** id to place on the hint, so a control can reference it. */
  hintId?: string;
  className?: string;
  children?: ReactNode;
}

export function Field({ label, hint, htmlFor, hintId, className, children }: FieldProps) {
  const classes = ['fw-field'];
  if (className) classes.push(className);

  const body = (
    <>
      {htmlFor ? (
        <label className="fw-field__label" htmlFor={htmlFor}>
          {label}
        </label>
      ) : (
        <span className="fw-field__label">{label}</span>
      )}
      <div className="fw-field__control">{children}</div>
      {hint ? (
        <p className="fw-field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
    </>
  );

  if (htmlFor) {
    return <div className={classes.join(' ')}>{body}</div>;
  }

  return (
    <div className={classes.join(' ')} role="group" aria-label={label}>
      {body}
    </div>
  );
}
