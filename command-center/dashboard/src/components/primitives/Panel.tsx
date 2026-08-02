/**
 * Panel — a titled surface.
 *
 * `padded` (default true) controls the body inset.
 * `flush`  strips the chrome — border, background, radius, shadow — leaving a
 *          bare titled section for places where a second frame would be noise.
 */

import { useId } from 'react';
import type { ReactNode } from 'react';

export interface PanelProps {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** Inset the body. Default true. */
  padded?: boolean;
  /** Drop the surface chrome and keep only the heading rhythm. */
  flush?: boolean;
  className?: string;
  children?: ReactNode;
}

export function Panel({
  title,
  subtitle,
  actions,
  padded = true,
  flush = false,
  className,
  children,
}: PanelProps) {
  const headingId = useId();
  const hasHead = title != null || subtitle != null || actions != null;

  const classes = ['fw-panel'];
  if (flush) classes.push('fw-panel--flush');
  if (padded) classes.push('fw-panel--padded');
  if (className) classes.push(className);

  return (
    <section className={classes.join(' ')} aria-labelledby={title != null ? headingId : undefined}>
      {hasHead ? (
        <header className="fw-panel__head">
          <div className="fw-panel__heading">
            {title != null ? (
              <h2 id={headingId} className="fw-panel__title fw-truncate">
                {title}
              </h2>
            ) : null}
            {subtitle != null ? <p className="fw-panel__subtitle">{subtitle}</p> : null}
          </div>
          {actions != null ? <div className="fw-panel__actions">{actions}</div> : null}
        </header>
      ) : null}
      <div className="fw-panel__body">{children}</div>
    </section>
  );
}
