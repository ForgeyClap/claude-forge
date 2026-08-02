/**
 * Forge Workspace — the live Claude Code / gateway chip presentation.
 *
 * A plain function, not a component, in its own module — same reason
 * `nav-config.ts` is separate from `Sidebar.tsx`: a module that exports both a
 * component and a constant/function cannot be hot-reloaded by React Fast
 * Refresh, and the linter says so.
 *
 * `Topbar.tsx`'s chip and `SettingsView.tsx`'s "Claude Code connection"
 * section both call this — one presentation, reused rather than reinvented
 * (P0-3).
 */

import type { ConnectionStatus } from '@/prototype/state/bridge-client';
import type { ClaudeCodeStatus } from '@/shared/protocol';

export interface ChipState {
  readonly state: string;
  readonly title: string;
}

/**
 * The REAL connection + Claude Code health, projected onto the chip's middle
 * label. Nothing is invented: every branch reflects a value the gateway
 * actually reported, and an as-yet-unknown Claude status resolves to the plain
 * connection label rather than a guess.
 */
export function liveChipState(status: ConnectionStatus, claude: ClaudeCodeStatus | null): ChipState {
  switch (status) {
    case 'CONNECTING':
      return { state: 'Connecting…', title: 'Reaching the local Forge gateway on this machine.' };
    case 'DEGRADED':
      return {
        state: 'Reconnecting',
        title: 'The gateway is reachable but the live stream is being reconciled.',
      };
    case 'DISCONNECTED':
      return {
        state: 'Disconnected — start the gateway',
        title:
          'The local Forge gateway is not reachable. Start it and the workspace reconnects on its own.',
      };
    case 'CONNECTED':
      if (claude === null) {
        return { state: 'Connected', title: 'Connected to the local Forge gateway.' };
      }
      if (!claude.available) {
        return {
          state: 'Connected · Claude Code not detected',
          title: claude.note ?? 'The gateway is connected, but Claude Code was not found on this machine.',
        };
      }
      if (!claude.authenticated) {
        return {
          state: 'Connected · not signed in',
          title: 'Connected to the gateway, but the local Claude Code session is not signed in.',
        };
      }
      return {
        state: 'Connected',
        title: claude.version
          ? `Connected to the local Forge gateway · Claude Code ${claude.version}.`
          : 'Connected to the local Forge gateway and the local Claude Code session.',
      };
  }
}
