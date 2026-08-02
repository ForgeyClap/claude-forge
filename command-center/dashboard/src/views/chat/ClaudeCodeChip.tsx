/**
 * ClaudeCodeChip — the local-session status chip above the chat thread.
 *
 * In PRODUCTION it reflects the REAL link: the live connection to the local
 * gateway (useConnection) and the Claude Code health the gateway reports. The chip
 * says whether the workspace is connected, and the popover explains the real
 * local-session link — it borrows the Claude Code session already signed in on
 * this machine, over localhost. No API key is ever entered here.
 *
 * In FIXTURES it keeps the fixed prototype placeholder: it detects nothing, reads
 * a presentation fixture, and states plainly that the prototype is not connected.
 * The theme showcase and unit tests rely on that copy, so it is left untouched.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Eyebrow, Icon, IconButton, Machine } from '@/components/primitives';
import { isFixtureMode } from '@/config/mode';
import { CLAUDE_CODE_LINK_BY_STATE } from '@/prototype/data/claude-code';
import { usePrototype } from '@/prototype/state/prototype-store';
// WP7b: the real gateway connection + Claude Code health, not the
// intentionally-unused bridge ones — see `gateway-adapter.ts`'s header.
import { useGatewayClaudeCodeHealth, useGatewayConnection as useConnection } from '@/prototype/state/gateway-adapter';
import type { ConnectionState } from '@/prototype/state/bridge-client';
import type { ClaudeCodeStatus } from '@/shared/protocol';
import type { ClaudeCodeLinkState } from '@/prototype/types/prototype-types';

/* --------------------------------------------------------------- chip copy */

interface ChipCopy {
  /** The single line shown in the chip button. */
  readonly chipText: string;
  readonly eyebrow: string;
  readonly lead: string;
  /** The machine-face state token on the popover's state line. */
  readonly stateCode: string;
  readonly stateTitle: string;
  readonly detail: string;
  readonly hint: string;
  readonly footer: string;
}

/** The unchanged fixture copy, read from the presentation link fixture. */
function fixtureCopy(linkState: ClaudeCodeLinkState): ChipCopy {
  const link = CLAUDE_CODE_LINK_BY_STATE[linkState];
  return {
    chipText: 'Claude Code · Local session · Not connected in prototype',
    eyebrow: 'Local session',
    lead:
      'This workspace is a visual prototype. It is not connected to Claude Code, to Forge or to ' +
      'anything else, and it has not looked: no process is probed and no session is read.',
    stateCode: linkState,
    stateTitle: link.title,
    detail: link.detail,
    hint: link.hint,
    footer:
      'When the link is real it will borrow the Claude Code session already signed in on this ' +
      'machine, on localhost, after you attach it per project. Nothing is entered here, and ' +
      'nothing is stored by this screen.',
  };
}

/**
 * The connection state, as a short human title for the popover state line.
 *
 * These say "gateway", not "bridge". The bridge was this workspace's original backend and it is
 * never connected any more — production talks to the gateway on 127.0.0.1:4100. Naming the wrong
 * component here was worse than a vague word: `connectionLabel` below told the reader to "start the
 * bridge" while handing them the command that starts the GATEWAY, so the one sentence meant to
 * unblock them sent them looking for something that does not exist. The topbar's own chip
 * (`Topbar.tsx`'s `liveChipState`) already said "gateway" — two chips, two names for one thing.
 */
function connectionTitle(status: ConnectionState['status']): string {
  switch (status) {
    case 'CONNECTING':
      return 'Connecting to the local gateway';
    case 'DEGRADED':
      return 'Reconciling the live stream';
    case 'DISCONNECTED':
      return 'Not connected to the local gateway';
    case 'CONNECTED':
      return 'Connected to the local gateway';
  }
}

/** The chip's short middle label, from the real connection state. */
function connectionLabel(status: ConnectionState['status']): string {
  switch (status) {
    case 'CONNECTING':
      return 'Connecting…';
    case 'DEGRADED':
      return 'Reconnecting';
    case 'DISCONNECTED':
      // Matches the topbar chip's wording exactly — the same state must not have two names.
      return 'Disconnected — start the gateway';
    case 'CONNECTED':
      return 'Connected';
  }
}

/** One honest sentence about the connection, for the popover lead. */
function connectionLead(status: ConnectionState['status']): string {
  switch (status) {
    case 'CONNECTING':
      return 'This workspace is reaching the local Forge gateway on this machine.';
    case 'DEGRADED':
      return 'This workspace is connected to the local Forge gateway and is reconciling a gap in the live stream.';
    case 'DISCONNECTED':
      return 'This workspace is not reaching the local Forge gateway right now. Start it on localhost and it will reconnect on its own.';
    case 'CONNECTED':
      return 'This workspace is connected to the local Forge gateway on this machine and reads its live event stream. Everything here stays on localhost.';
  }
}

/** The Claude Code health line, or a neutral note when it has not been reported. */
function claudeHint(claude: ClaudeCodeStatus | null): string {
  if (claude === null) return 'Claude Code health has not been reported yet.';
  if (!claude.available) return claude.note ?? 'Claude Code was not detected on this machine.';
  if (!claude.authenticated) {
    return 'Claude Code is installed but not signed in. Sign in from the terminal, and the link uses that session.';
  }
  return claude.version
    ? `Claude Code ${claude.version} is signed in on this machine.`
    : 'The local Claude Code session is signed in on this machine.';
}

/** The connected copy: the real gateway connection and Claude Code health. */
function liveCopy(connection: ConnectionState, claude: ClaudeCodeStatus | null): ChipCopy {
  const status = connection.status;
  const detail =
    status === 'DISCONNECTED'
      ? `Start the local gateway with ${connection.startCommand} and the workspace reconnects on its own.`
      : status === 'CONNECTED'
        ? `Reading the live event stream from ${connection.endpoint}.`
        : connection.detail ?? `Reaching the gateway at ${connection.endpoint}.`;

  return {
    chipText: `Claude Code · ${connectionLabel(status)}`,
    eyebrow: 'Local session',
    lead: connectionLead(status),
    stateCode: status,
    stateTitle: connectionTitle(status),
    detail,
    hint: claudeHint(claude),
    footer:
      'This link uses the Claude Code session already signed in on this machine, over localhost. ' +
      'No API key is entered here, and nothing is stored by this screen.',
  };
}

/* ------------------------------------------------------------- component */

export function ClaudeCodeChip() {
  const { state } = usePrototype();
  const connection = useConnection();
  const health = useGatewayClaudeCodeHealth();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  const copy = isFixtureMode()
    ? fixtureCopy(state.claudeCodeState)
    : liveCopy(connection, health?.claudeCode ?? null);

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) {
      rootRef.current?.querySelector<HTMLButtonElement>('.fw-chat-cc__chip')?.focus();
    }
  }, []);

  // Outside pointer press closes the panel. No listener exists while it is shut.
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (root && event.target instanceof Node && !root.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  // Move focus into the panel when it opens, so Escape has somewhere to return
  // from. IconButton is a plain function component, so the button is found in
  // the DOM rather than held by a ref it does not accept.
  useEffect(() => {
    if (!open) return;
    rootRef.current?.querySelector<HTMLButtonElement>('.fw-chat-cc__close')?.focus();
  }, [open]);

  return (
    <div
      className="fw-chat-cc"
      ref={rootRef}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          close(true);
        }
      }}
    >
      <button
        type="button"
        className="fw-chat-cc__chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="SquareTerminal" size="sm" className="fw-chat-cc__glyph" />
        <Machine muted className="fw-chat-cc__text">
          {copy.chipText}
        </Machine>
        <Icon name="ChevronDown" size="xs" className="fw-chat-cc__caret" />
      </button>

      {open ? (
        <div className="fw-chat-cc__panel" id={panelId} role="dialog" aria-label="Claude Code link">
          <div className="fw-chat-cc__panel-head">
            <Eyebrow>{copy.eyebrow}</Eyebrow>
            <span className="fw-spacer" aria-hidden="true" />
            <IconButton
              icon="X"
              label="Close"
              size="sm"
              className="fw-chat-cc__close"
              onClick={() => close(true)}
            />
          </div>

          <p className="fw-chat-cc__lead">{copy.lead}</p>

          <hr className="fw-divider" />

          <p className="fw-chat-cc__state">
            <Machine muted>{copy.stateCode}</Machine>
            <span className="fw-chat-cc__state-title">{copy.stateTitle}</span>
          </p>
          <p className="fw-chat-cc__detail">{copy.detail}</p>
          <p className="fw-chat-cc__hint">{copy.hint}</p>

          <hr className="fw-divider" />

          <p className="fw-chat-cc__detail">{copy.footer}</p>
        </div>
      ) : null}
    </div>
  );
}
