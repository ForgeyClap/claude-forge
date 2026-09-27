/**
 * WP-A (v2.9.0): the real, editable control for one Forge setting row in
 * Settings ▸ Forge settings — "we also want to be able to change the config
 * in the dashboard" (owner). Replaces wp12's read-only `setting.display` text
 * in the Value column with the matching primitive for the setting's real
 * type (`Switch` for bool, `SegmentedControl` for enum, a bounded number
 * input for int/number, a plain text input for int-or-auto), plus a
 * "Reset to default" `IconButton` (= `unset`).
 *
 * No new style language: every control here is one of this project's own
 * frozen primitives, used exactly the way `renderAppearance`/`renderLayout`
 * already use `Switch`/`SegmentedControl` elsewhere in this same view, and
 * the way `NewProjectDialog`/`ConfirmDeleteConversationDialog` already use
 * `Modal` + `Button` for a confirmed write.
 *
 * SAFETY: `gate-hook` can never be switched off from here — see
 * `renderGateHookControl`'s own comment. Every OTHER flagged setting (a
 * disclosure or a scope:"global" key) shows a confirm `Modal` first,
 * carrying the real disclosure/scope text, before the write is ever sent.
 */

import { useState } from 'react';
import type { ReactNode } from 'react';

import { Button, IconButton, Modal, SegmentedControl, Switch } from '@/components/primitives';
import type { GatewayForgeSetting } from '@/prototype/state/gateway-capabilities';
import { writeForgeConfig } from '@/prototype/state/adapter/config-write';
import { nextToastId, usePrototype } from '@/prototype/state/prototype-store';

const GATE_HOOK_KEY = 'gate-hook';

type PendingWrite =
  | { readonly action: 'set'; readonly value: string | number | boolean }
  | { readonly action: 'unset' };

export interface ForgeSettingControlProps {
  readonly projectName: string;
  readonly setting: GatewayForgeSetting;
  /** Called once, right after a write this component sent has actually succeeded — the caller
   *  re-fetches (`forgeConfig.refresh()`) rather than this component guessing the new value. */
  readonly onChanged: () => void;
}

export function ForgeSettingControl({ projectName, setting, onChanged }: ForgeSettingControlProps) {
  const { dispatch } = usePrototype();
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ readonly write: PendingWrite; readonly resolve: (ok: boolean) => void } | null>(null);

  // A disclosure flag (C/N/$/U/X/D) or a machine-wide scope both mean "this write does more than
  // change a number on screen" — confirmed first, every time, never just for `set`.
  const needsConfirm = setting.flags.length > 0 || setting.scope === 'global';
  const isDefault = setting.source === 'default';

  async function commit(write: PendingWrite): Promise<boolean> {
    setBusy(true);
    const result =
      write.action === 'set'
        ? await writeForgeConfig(projectName, 'set', setting.key, write.value)
        : await writeForgeConfig(projectName, 'unset', setting.key);
    setBusy(false);
    if (!result.ok) {
      dispatch({
        type: 'toast/push',
        toast: {
          id: nextToastId(),
          title: `${setting.key} not changed`,
          detail: result.error ?? 'The gateway refused this change.',
          icon: 'TriangleAlert',
        },
      });
      return false;
    }
    dispatch({
      type: 'toast/push',
      toast: {
        id: nextToastId(),
        title: `${setting.key} updated`,
        detail: write.action === 'unset' ? 'Back to its default value.' : `Now ${String(write.value)}.`,
        icon: 'CircleCheck',
      },
    });
    onChanged();
    return true;
  }

  /**
   * Codex finding K3-8: a numeric control used to fire-and-forget this call, so a REJECTED value
   * (the gateway refused it) stayed displayed in the input forever — `setting.value` (the
   * authoritative prop) never changed on failure, and the input's own `key={currentText}` remount
   * trick only resets the draft when that authoritative value actually moves. Returning whether the
   * write actually succeeded lets the calling control revert its own draft back to the authoritative
   * value on a `false`, instead of leaving the rejected text on screen looking like it was accepted.
   */
  function requestChange(write: PendingWrite): Promise<boolean> {
    if (busy) return Promise.resolve(false);
    if (needsConfirm) {
      return new Promise<boolean>((resolve) => {
        setPending({ write, resolve });
      });
    }
    return commit(write);
  }

  function confirmDescription(): ReactNode {
    const parts: string[] = [];
    if (setting.scope === 'global') parts.push('This changes every project on this computer.');
    if (setting.disclosure) parts.push(setting.disclosure);
    return parts.length > 0 ? parts.join(' ') : 'This setting affects more than just this project.';
  }

  const resetButton =
    setting.key === GATE_HOOK_KEY ? null : (
      <IconButton
        icon="RotateCcw"
        label={`Reset ${setting.key} to its default`}
        size="sm"
        disabled={busy || isDefault}
        onClick={() => void requestChange({ action: 'unset' })}
      />
    );

  // A dismissal (Cancel, or closing the modal without confirming) is a real "no" — the caller
  // awaiting requestChange()'s promise (a numeric input reverting its draft, say) must resolve to
  // `false` rather than hang forever.
  function dismissPending(): void {
    pending?.resolve(false);
    setPending(null);
  }

  return (
    <div className="fw-settings__forge-control">
      {renderControl({ setting, busy, requestChange })}
      {resetButton}
      {pending ? (
        <Modal
          open
          onClose={dismissPending}
          size="sm"
          title={`Change ${setting.key}?`}
          description={confirmDescription()}
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={dismissPending} disabled={busy}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={busy}
                onClick={() => {
                  const { write, resolve } = pending;
                  setPending(null);
                  void commit(write).then(resolve);
                }}
              >
                {busy ? 'Changing…' : 'Change it'}
              </Button>
            </>
          }
        />
      ) : null}
    </div>
  );
}

function renderControl(args: {
  readonly setting: GatewayForgeSetting;
  readonly busy: boolean;
  readonly requestChange: (write: PendingWrite) => Promise<boolean>;
}): ReactNode {
  const { setting, busy, requestChange } = args;

  if (setting.key === GATE_HOOK_KEY) {
    return renderGateHookControl(setting, busy, requestChange);
  }
  if (setting.type === 'bool') {
    return (
      <Switch
        checked={setting.status === 'on'}
        onChange={(next) => void requestChange({ action: 'set', value: next })}
        label={setting.key}
        labelHidden
        disabled={busy}
      />
    );
  }
  if (setting.type === 'enum' && setting.allowed.length > 0) {
    return (
      <SegmentedControl
        label={setting.key}
        size="sm"
        value={typeof setting.value === 'string' ? setting.value : setting.allowed[0]}
        onChange={(next) => void requestChange({ action: 'set', value: next })}
        options={setting.allowed.map((word) => ({ value: word, label: word }))}
      />
    );
  }
  if (setting.type === 'int' || setting.type === 'number') {
    return <BoundedNumberInput setting={setting} busy={busy} requestChange={requestChange} />;
  }
  if (setting.type === 'int-or-auto') {
    return <IntOrAutoInput setting={setting} busy={busy} requestChange={requestChange} />;
  }
  // An unrecognised type never invents a control — the read-only display value stands alone,
  // exactly as wp12 already rendered it, rather than guessing at an editor for it.
  return <span className="fw-settings__forge-control-fallback">{setting.display ?? '—'}</span>;
}

/**
 * gate-hook can only be turned ON from the dashboard, never off — see this project's own
 * exec-token comment in security.mjs/config-write.mjs's header: the token cannot meaningfully
 * gate "the dashboard" from "any other local process", so the refusal lives server-side too (this
 * is belt-and-suspenders, not the only guard). Currently ON: no toggle at all, just the plain
 * sentence for how the owner does it themselves. Currently OFF (set via the CLI/chat): a single
 * "Turn on" button — turning it back ON is always allowed and needs no confirmation.
 */
function renderGateHookControl(
  setting: GatewayForgeSetting,
  busy: boolean,
  requestChange: (write: PendingWrite) => Promise<boolean>,
): ReactNode {
  if (setting.status === 'on') {
    return (
      <span className="fw-settings__forge-gate-hook-note">
        Always on from here. To turn it off yourself: node .claude/forge-bin/forge-config.cjs set gate-hook off
      </span>
    );
  }
  return (
    <Button
      variant="primary"
      size="sm"
      icon="ShieldCheck"
      disabled={busy}
      onClick={() => void requestChange({ action: 'set', value: 'on' })}
    >
      Turn on
    </Button>
  );
}

function BoundedNumberInput({
  setting,
  busy,
  requestChange,
}: {
  readonly setting: GatewayForgeSetting;
  readonly busy: boolean;
  readonly requestChange: (write: PendingWrite) => Promise<boolean>;
}) {
  const currentText = setting.value != null ? String(setting.value) : '';
  const [draft, setDraft] = useState(currentText);

  // Codex finding K3-8: a REJECTED value used to stay displayed forever — `requestChange` now
  // reports back whether the gateway actually accepted it, so a `false` snaps the draft back to
  // the authoritative `currentText` instead of leaving the rejected text on screen looking
  // accepted. A success needs no explicit reset here: `setting.value` changing (via `onChanged()`'s
  // refetch) changes `currentText`, which changes this input's own `key`, which remounts it fresh.
  async function submit(): Promise<void> {
    const trimmed = draft.trim();
    if (trimmed === '' || trimmed === currentText) {
      setDraft(currentText); // empty or unchanged — nothing to send, snap back to the real value
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      setDraft(currentText);
      return;
    }
    const ok = await requestChange({ action: 'set', value: parsed });
    if (!ok) setDraft(currentText);
  }

  return (
    <span className="fw-sidebar__search-field fw-settings__forge-number-field">
      <input
        key={currentText}
        type="number"
        className="fw-sidebar__search-input fw-settings__forge-number"
        value={draft}
        min={setting.min ?? undefined}
        max={setting.max ?? undefined}
        step="1"
        disabled={busy}
        aria-label={setting.key}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void submit()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void submit();
        }}
      />
    </span>
  );
}

function IntOrAutoInput({
  setting,
  busy,
  requestChange,
}: {
  readonly setting: GatewayForgeSetting;
  readonly busy: boolean;
  readonly requestChange: (write: PendingWrite) => Promise<boolean>;
}) {
  const currentText = setting.value != null ? String(setting.value) : 'auto';
  const [draft, setDraft] = useState(currentText);

  // Same K3-8 revert-on-failure shape as BoundedNumberInput above.
  async function submit(): Promise<void> {
    const trimmed = draft.trim();
    if (trimmed === '' || trimmed === currentText) {
      setDraft(currentText);
      return;
    }
    const ok = await requestChange({ action: 'set', value: trimmed });
    if (!ok) setDraft(currentText);
  }

  return (
    <span className="fw-sidebar__search-field fw-settings__forge-number-field">
      <input
        key={currentText}
        type="text"
        className="fw-sidebar__search-input fw-settings__forge-number"
        value={draft}
        disabled={busy}
        aria-label={setting.key}
        placeholder="auto"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void submit()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void submit();
        }}
      />
    </span>
  );
}
