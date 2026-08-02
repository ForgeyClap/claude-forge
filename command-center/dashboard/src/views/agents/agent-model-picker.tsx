/**
 * AgentModelPicker — the Agents tab's own trigger+popover control for editing ONE field
 * (`claudeTier` or `claudeEffort`) on ONE agent.
 *
 * Same interaction shape as the composer's `MenuButton` (trigger button, popover list, click-
 * outside-to-close, a trailing check mark on the current choice) — a fresh, LOCAL implementation
 * rather than importing `views/chat/menu-button.tsx`, whose own header explicitly marks it "local
 * to the composer on purpose... not general enough to belong in the primitive layer".
 *
 * Purely controlled/presentational: every value and every side effect is a prop. `AgentsView.tsx`
 * owns the real gateway call, the pending/error state, and the "re-read from disk after success"
 * rule — this component only ever shows what it is told to show.
 */
import { useEffect, useRef, useState } from 'react';
import { Button, Icon, Machine } from '@/components/primitives';

export interface AgentModelPickerProps {
  readonly label: string;
  readonly icon: string;
  /** The current real value, or `null` when this field is not set for this agent at all. */
  readonly value: string | null;
  /** The real allowlist (derived from every agent's real current value) — see `AgentsView.tsx`. */
  readonly options: readonly string[];
  /** True while a real PATCH for THIS field on THIS agent is in flight. */
  readonly pending: boolean;
  readonly onPick: (value: string) => void;
}

export function AgentModelPicker({ label, icon, value, options, pending, onPick }: AgentModelPickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (root && event.target instanceof Node && !root.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const disabled = pending || options.length === 0;

  return (
    <div className="fw-agents-modelpick" ref={rootRef}>
      <Button
        variant="quiet"
        size="sm"
        icon={icon}
        iconRight={disabled ? undefined : 'ChevronDown'}
        className="fw-agents-modelpick__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Change ${label}`}
        title={`Change ${label.toLowerCase()} (currently ${value ?? 'unset'})`}
        disabled={disabled}
        onClick={() => setOpen((was) => !was)}
      >
        {pending ? 'Saving…' : (value ?? '—')}
      </Button>
      {open ? (
        <div className="fw-agents-modelpick__panel" role="menu" aria-label={`Choose ${label}`}>
          {options.map((option) => (
            <button
              key={option}
              type="button"
              role="menuitemradio"
              aria-checked={option === value}
              className="fw-agents-modelpick__item"
              onClick={() => {
                setOpen(false);
                if (option !== value) onPick(option);
              }}
            >
              <Machine>{option}</Machine>
              {option === value ? <Icon name="Check" size="xs" className="fw-agents-modelpick__check" /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
