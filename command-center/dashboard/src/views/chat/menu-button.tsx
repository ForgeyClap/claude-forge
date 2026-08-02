/**
 * menu-button — the composer's shared trigger-plus-popover-menu building block.
 *
 * refactor-chat-split (forge-2026-07-30-cc-finish): split out of `Composer.tsx` itself, which had
 * grown well past this project's own file-size guidance. Used by THREE menus across the composer:
 * Context and Skills (still defined directly in `Composer.tsx`) and Effort (`mode-controls.tsx`) —
 * centralizing it here is what makes all three share one popover implementation rather than three
 * near-duplicates. Pure structural move: no behavior changed, no class name changed.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

import { Button, Icon, IconButton, Machine } from '@/components/primitives';

export interface MenuOption {
  readonly id: string;
  readonly icon: string;
  readonly label: string;
  /**
   * fix-ui-clutter (item 5): optional. A skill with no recorded description
   * used to fall back to the flat placeholder text "No description
   * recorded." repeated once per empty-description item — now the caller
   * simply omits `detail` instead, and the item renders just its (smaller)
   * name with no second line.
   */
  readonly detail?: string;
}

export interface MenuButtonProps {
  readonly icon: string;
  readonly label: string;
  readonly title: string;
  readonly options: readonly MenuOption[];
  /** Shown at the foot of the panel — honest, mode/state-specific copy. */
  readonly footer: string;
  readonly onPick: (option: MenuOption) => void;
  /** Fires the moment the panel opens. Used to fetch options lazily. */
  readonly onOpen?: () => void;
  /**
   * composer-modes-ui: when set, the trigger renders as a labelled `Button` (icon + this text)
   * instead of an icon-only `IconButton` — for a picker whose CURRENT choice should stay visible
   * on screen (the effort selector), unlike Context/Skills, which insert into the draft and have
   * no persistent "current value" of their own to show.
   */
  readonly triggerLabel?: string;
  /**
   * composer-modes-ui: the id of the option that is the CURRENT choice, if any. Marks that one
   * item `role="menuitemradio"`/`aria-checked` with a trailing check mark instead of a plain
   * one-shot `role="menuitem"` action — this menu is a single-select group, not a list of actions.
   */
  readonly selectedId?: string;
}

/**
 * A trigger plus a small popover menu. Local to the composer on purpose — it is
 * not general enough to belong in the primitive layer.
 */
export function MenuButton({ icon, label, title, options, footer, onPick, onOpen, triggerLabel, selectedId }: MenuButtonProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const focusTrigger = useCallback(() => {
    rootRef.current?.querySelector<HTMLButtonElement>('.fw-chat-menu__trigger')?.focus();
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (root && event.target instanceof Node && !root.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    rootRef.current?.querySelector<HTMLButtonElement>('.fw-chat-menu__item')?.focus();
  }, [open]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!open) return;
    if (event.key === 'Escape') {
      event.stopPropagation();
      setOpen(false);
      focusTrigger();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = Array.from(
      rootRef.current?.querySelectorAll<HTMLButtonElement>('.fw-chat-menu__item') ?? [],
    );
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    const next = (current + delta + items.length) % items.length;
    event.preventDefault();
    items[next].focus();
  };

  const toggle = () =>
    setOpen((value) => {
      const next = !value;
      if (next) onOpen?.();
      return next;
    });

  return (
    <div className="fw-chat-menu" ref={rootRef} onKeyDown={handleKeyDown}>
      {triggerLabel !== undefined ? (
        <Button
          variant="ghost"
          size="sm"
          icon={icon}
          iconRight="ChevronDown"
          className="fw-chat-menu__trigger fw-chat-composer__labelled-trigger"
          aria-haspopup="menu"
          aria-expanded={open}
          title={title}
          onClick={toggle}
        >
          {triggerLabel}
        </Button>
      ) : (
        <IconButton
          icon={icon}
          label={label}
          title={title}
          size="sm"
          className="fw-chat-menu__trigger"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={toggle}
        />
      )}
      {open ? (
        <div className="fw-chat-menu__panel" role="menu" aria-label={label}>
          <p className="fg-eyebrow fw-chat-menu__title">{title}</p>
          {options.map((option) => {
            const selected = selectedId !== undefined && option.id === selectedId;
            return (
              <button
                key={option.id}
                type="button"
                role={selectedId !== undefined ? 'menuitemradio' : 'menuitem'}
                aria-checked={selectedId !== undefined ? selected : undefined}
                className="fw-chat-menu__item"
                onClick={() => {
                  setOpen(false);
                  focusTrigger();
                  onPick(option);
                }}
              >
                <Icon name={option.icon} size="sm" />
                <span className="fw-chat-menu__item-text">
                  <Machine
                    className={
                      option.detail
                        ? 'fw-chat-menu__item-label'
                        : 'fw-chat-menu__item-label fw-chat-menu__item-label--solo'
                    }
                  >
                    {option.label}
                  </Machine>
                  {option.detail ? <span className="fw-chat-menu__item-detail">{option.detail}</span> : null}
                </span>
                {selected ? <Icon name="Check" size="xs" className="fw-chat-menu__item-check" /> : null}
              </button>
            );
          })}
          <p className="fw-chat-menu__note">{footer}</p>
        </div>
      ) : null}
    </div>
  );
}
