/**
 * Toasts — the transient notice stack.
 *
 * Bottom-right on desktop, bottom-centre on narrow screens, at most four at a
 * time (the reducer already caps the list; this component does not assume it).
 *
 * Each toast dismisses itself after ~4s. Hovering or focusing it pauses that
 * clock — including the hairline countdown under it — so a notice can never
 * vanish while it is being read. The region is aria-live="polite", so a toast
 * is announced without interrupting.
 *
 * A toast reports something that happened inside this prototype. Nothing here
 * is a response from a server, because there is no server.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon, IconButton } from '@/components/primitives';
import { usePrototype } from '@/prototype/state/prototype-store';
import type { Toast } from '@/prototype/state/prototype-store';
import './toasts.css';

/** Mirrors --fw-toast-life in toasts.css. Keep the two in step. */
const LIFETIME_MS = 4200;
const MIN_REMAINING_MS = 600;
const MAX_STACK = 4;

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: string) => void }) {
  const [paused, setPaused] = useState(false);
  const remaining = useRef(LIFETIME_MS);
  const startedAt = useRef(0);

  const dismiss = useCallback(() => onDismiss(toast.id), [onDismiss, toast.id]);

  useEffect(() => {
    if (paused) return undefined;

    startedAt.current = Date.now();
    const timer = window.setTimeout(dismiss, remaining.current);

    return () => {
      window.clearTimeout(timer);
      const spent = Date.now() - startedAt.current;
      remaining.current = Math.max(MIN_REMAINING_MS, remaining.current - spent);
    };
  }, [paused, dismiss]);

  return (
    <div
      className="fw-toast"
      data-paused={paused ? 'true' : undefined}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <Icon name={toast.icon ?? 'Info'} size="sm" className="fw-toast__icon" />
      <div className="fw-toast__text">
        <p className="fw-toast__title">{toast.title}</p>
        {toast.detail ? <p className="fw-toast__detail">{toast.detail}</p> : null}
      </div>
      <IconButton icon="X" label="Dismiss notification" size="sm" onClick={dismiss} />
      <span className="fw-toast__timer" aria-hidden="true" />
    </div>
  );
}

export function Toasts() {
  const { state, dispatch } = usePrototype();

  const dismiss = useCallback(
    (id: string) => dispatch({ type: 'toast/dismiss', id }),
    [dispatch],
  );

  const visible = state.toasts.slice(-MAX_STACK);

  return createPortal(
    <div className="fw-toasts" role="region" aria-label="Notifications" aria-live="polite">
      {visible.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
      ))}
    </div>,
    document.body,
  );
}

export default Toasts;
