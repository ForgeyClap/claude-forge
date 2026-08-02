/**
 * Modal — focus-trapped dialog rendered into document.body.
 *
 * Contract:
 *   role="dialog", aria-modal="true", labelled by its own title
 *   Escape closes; clicking the scrim closes
 *   focus moves into the dialog on open and returns to the opener on close
 *   Tab and Shift+Tab cycle inside the dialog and nowhere else
 *
 * Rendered through a portal so the shell's overflow:hidden and stacking
 * contexts cannot clip it.
 */

import { useCallback, useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconButton } from './IconButton';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** Hide the close button when the dialog must be answered, not dismissed. */
  hideClose?: boolean;
  className?: string;
  children?: ReactNode;
}

export function Modal({
  open,
  onClose,
  title,
  description,
  footer,
  size = 'md',
  hideClose = false,
  className,
  children,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const titleId = useId();
  const descriptionId = useId();

  // Keeps the effect below keyed on `open` alone, so a re-rendered parent can
  // never yank focus back to the top of the dialog mid-interaction.
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  const focusables = useCallback((): HTMLElement[] => {
    const node = dialogRef.current;
    if (!node) return [];
    return Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE));
  }, []);

  useEffect(() => {
    if (!open) return undefined;

    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = focusables()[0];
    (first ?? dialogRef.current)?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const node = dialogRef.current;
      if (!node) return;

      const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) {
        event.preventDefault();
        node.focus();
        return;
      }

      const head = items[0];
      const tail = items[items.length - 1];
      const active = document.activeElement;

      if (!node.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? tail : head).focus();
        return;
      }
      if (event.shiftKey && active === head) {
        event.preventDefault();
        tail.focus();
      } else if (!event.shiftKey && active === tail) {
        event.preventDefault();
        head.focus();
      }
    }

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      opener?.focus();
    };
  }, [open, focusables]);

  if (!open) return null;

  const classes = ['fw-modal__dialog', `fw-modal__dialog--${size}`];
  if (className) classes.push(className);

  return createPortal(
    <div className="fw-modal">
      <div className="fw-modal__scrim" onClick={() => closeRef.current()} aria-hidden="true" />
      <div
        ref={dialogRef}
        className={classes.join(' ')}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description != null ? descriptionId : undefined}
        tabIndex={-1}
      >
        <header className="fw-modal__head">
          <div className="fw-modal__heading">
            <h2 id={titleId} className="fw-modal__title">
              {title}
            </h2>
            {description != null ? (
              <p id={descriptionId} className="fw-modal__description">
                {description}
              </p>
            ) : null}
          </div>
          {hideClose ? null : (
            <IconButton icon="X" label="Close" size="sm" onClick={() => closeRef.current()} />
          )}
        </header>
        <div className="fw-modal__body fw-scroll">{children}</div>
        {footer != null ? <footer className="fw-modal__foot">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}
