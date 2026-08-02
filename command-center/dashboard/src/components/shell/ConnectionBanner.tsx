/**
 * Forge Workspace — the connection banner.
 *
 * A quiet, honest strip that appears ONLY when the connection to the gateway is
 * not healthy. When everything is whole it renders nothing at all — a connected
 * workspace should not carry a "connected!" chrome.
 *
 * It is never a full-screen blocker: a small floating strip at the top of the
 * viewport, portalled to <body> so the shell's overflow cannot clip it. The
 * three unhealthy states each say something a person can act on:
 *
 *   CONNECTING    reaching the gateway (first attempt, or reconnecting).
 *   DEGRADED      the socket is up but a stream has a gap being reconciled — the
 *                 strip names what is being replayed rather than hiding it.
 *   DISCONNECTED  no gateway. The strip prints the EXACT command that starts it
 *                 and the address it listens on, plus a live countdown to the
 *                 next automatic retry.
 *
 * Everything is greyscale plus a single hairline accent whose weight — never a
 * hue alone — carries the severity, in keeping with the workspace's monochrome
 * status treatment.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import { Icon } from '@/components/primitives';
// WP7b: reads the REAL gateway connection (127.0.0.1:4100) instead of the
// intentionally-unused bridge connection — see `gateway-adapter.ts`'s header
// and `live-store.ts`'s `getSharedLiveStore()` comment. Same `ConnectionState`
// shape, zero markup changes below.
import { useGatewayConnection as useConnection } from '@/prototype/state/gateway-adapter';

import './connection-banner.css';

interface BannerCopy {
  readonly icon: string;
  readonly spin: boolean;
  readonly title: string;
}

function copyFor(status: 'CONNECTING' | 'DEGRADED' | 'DISCONNECTED'): BannerCopy {
  switch (status) {
    case 'CONNECTING':
      return { icon: 'Loader', spin: true, title: 'Connecting to the Forge gateway' };
    case 'DEGRADED':
      return { icon: 'RefreshCw', spin: true, title: 'Live stream degraded — reconciling' };
    case 'DISCONNECTED':
      return { icon: 'Unplug', spin: false, title: 'Disconnected from the Forge gateway' };
  }
}

export function ConnectionBanner() {
  const connection = useConnection();
  const status = connection.status;

  const [copied, setCopied] = useState(false);

  const copyCommand = useCallback(() => {
    try {
      void navigator.clipboard?.writeText(connection.startCommand);
    } catch {
      // Clipboard access can be denied; the command is still shown to copy by hand.
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  }, [connection.startCommand]);

  // A live countdown to the next reconnect attempt. The remaining time lives in
  // state and is written ONLY from inside the interval callback — the effect
  // body starts no state and reads no clock during render, so the countdown ticks
  // without violating the render-purity rules. The absolute target instant is a
  // closure constant per attempt, so the number is honest rather than drifting.
  const attempt = connection.reconnectAttempts;
  const nextRetryInMs = connection.nextRetryInMs;
  const [remainingMs, setRemainingMs] = useState<number | null>(null);

  useEffect(() => {
    if (status !== 'DISCONNECTED' || nextRetryInMs === null) return undefined;
    const targetAt = Date.now() + nextRetryInMs;
    const id = window.setInterval(() => setRemainingMs(Math.max(0, targetAt - Date.now())), 500);
    return () => window.clearInterval(id);
  }, [status, nextRetryInMs, attempt]);

  // Before the first interval tick, fall back to the snapshot's own remaining
  // figure so the countdown never shows a blank; both are pure reads.
  const countdownMs = remainingMs ?? nextRetryInMs;
  const retryLabel =
    nextRetryInMs === null
      ? 'retrying automatically'
      : countdownMs !== null && countdownMs <= 0
        ? 'reconnecting…'
        : `next attempt in ${Math.ceil((countdownMs ?? 0) / 1000)}s`;

  const reconciling = connection.reconciling;
  const reconcilingLine = useMemo(() => {
    if (reconciling.length === 0) return null;
    const first = reconciling[0];
    const more = reconciling.length - 1;
    const tail = more > 0 ? ` (+${more} more stream${more === 1 ? '' : 's'})` : '';
    return `Replaying ${first.from}–${first.to} on ${first.streamKey}${tail}.`;
  }, [reconciling]);

  // The healthy state has no chrome.
  if (status === 'CONNECTED') return null;

  const { icon, spin, title } = copyFor(status);

  return createPortal(
    <div className="fw-conn" data-status={status} role="status" aria-live="polite">
      <span className="fw-conn__accent" aria-hidden="true" />
      <Icon name={icon} size="sm" spin={spin} className="fw-conn__icon" />

      <div className="fw-conn__body">
        <p className="fw-conn__title">{title}</p>

        {status === 'DISCONNECTED' ? (
          <>
            <p className="fw-conn__detail">
              The workspace can’t reach the local gateway. Start it and it will reconnect on its own.
            </p>
            <div className="fw-conn__command">
              <Icon name="Cable" size="xs" className="fw-conn__command-icon" />
              <code className="fw-conn__code">{connection.startCommand}</code>
              <button type="button" className="fw-conn__copy" onClick={copyCommand}>
                <Icon name="Copy" size="xs" />
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            {/*
              The command is relative, so it only resolves from the project root — one directory
              above `command-center`. Copying it into a terminal that happens to sit inside
              `command-center` fails with "Cannot find module", and the banner is exactly the moment
              a stuck reader has the least patience for a second puzzle. The working directory is
              stated here rather than folded into the copied string: a copy button should hand over
              something you can paste and run, not a compound `cd … && …` that moves the reader's
              shell somewhere they did not ask to be.
            */}
            <p className="fw-conn__meta">
              Run from the project root · Listens on{' '}
              <span className="fw-conn__endpoint">{connection.endpoint}</span>
              {' · '}
              {retryLabel}
            </p>
          </>
        ) : (
          <p className="fw-conn__detail">
            {connection.detail ?? 'Working on the connection…'}
            {reconcilingLine ? <span className="fw-conn__reconcile"> {reconcilingLine}</span> : null}
          </p>
        )}
      </div>
    </div>,
    document.body,
  );
}

export default ConnectionBanner;
