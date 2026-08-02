/**
 * Forge Workspace — local Claude Code link presentation copy.
 *
 * fix-cert-fixtures (forge-2026-07-29-cc-finish): this used to be a thin
 * re-export of `prototype/fixtures/claude-code.ts`. Both of this file's real
 * consumers — `Dock.tsx` and `views/chat/ClaudeCodeChip.tsx` — are reached
 * unconditionally from the app's production entry point (`main.tsx` -> `App.tsx`),
 * so importing anything physically under `prototype/fixtures/` from here meant
 * "no fixture module is imported by production-rendering code" (certification
 * finding #5) held only for the BIG dataset, not for this one. The records now
 * live here directly instead, and `prototype/fixtures/claude-code.ts` re-exports
 * FROM this file (the direction is reversed, not removed) so the fixture barrel
 * and anything reading it (`FIXTURE_DATASET`'s sibling exports, unit tests) keep
 * resolving unchanged. `tests/unit/fixture-import-graph.test.ts` proves no path
 * under `src/prototype/fixtures/` is statically reachable from `src/main.tsx`.
 *
 * These are presentation-only placeholders, not part of the gated workspace
 * dataset — each consumer still gates them behind `isFixtureMode()` /
 * `isProductionMode()` at the call site, so a real user never sees this copy.
 */

import type { ClaudeCodeLink, ClaudeCodeLinkState } from '@/prototype/types/prototype-types';

export const CLAUDE_CODE_LINKS: readonly ClaudeCodeLink[] = [
  {
    prototype: true,
    state: 'not-connected',
    title: 'Not connected',
    detail:
      'Nothing was looked for. This prototype does not probe your machine, so it has no opinion about whether Claude Code is installed — it simply has not asked.',
    hint: 'When the real link exists it will use the Claude Code session already signed in on this machine. Nothing is entered here.',
  },
  {
    prototype: true,
    state: 'detected',
    title: 'Local session available',
    detail:
      'Example state: a signed-in Claude Code session was found on this machine and the workspace could attach to it. The session stays where it is — the workspace borrows it rather than copying anything out of it.',
    hint: 'Attaching is explicit and per project. A detected session is never used until you say so.',
  },
  {
    prototype: true,
    state: 'vscode-available',
    title: 'Editor extension available',
    detail:
      'Example state: the VS Code extension is installed alongside the CLI, so the workspace could hand a task straight into the editor and follow the diff there instead of reproducing it here.',
    hint: 'The editor stays in charge of the files. The workspace shows the run, not a second copy of your project.',
  },
  {
    prototype: true,
    state: 'awaiting-bridge',
    title: 'Waiting for the local bridge',
    detail:
      'Example state: the workspace has asked to attach and is waiting for the local bridge to accept. Nothing is retried in the background and nothing leaves this machine while it waits.',
    hint: 'The bridge is started by you, on localhost. If it never starts, the workspace stays exactly as it is now.',
  },
  {
    prototype: true,
    state: 'busy',
    title: 'Session busy',
    detail:
      'Example state: the local session is mid-task. The workspace will not interrupt it or queue behind it silently — a busy session is shown as busy rather than as an empty screen with a spinner.',
    hint: 'You can watch the run here, or take it back in the terminal. The session is never taken over.',
  },
  {
    prototype: true,
    state: 'disconnected',
    title: 'Disconnected',
    detail:
      'Example state: the link was attached and is now gone — the terminal closed, the machine slept, or the bridge was stopped. Work already recorded stays visible; nothing new arrives.',
    hint: 'Reconnecting is a deliberate action. The workspace will not quietly re-attach to a session you walked away from.',
  },
];

/** Keyed lookup for the settings screen, which pages through the six states. */
export const CLAUDE_CODE_LINK_BY_STATE: Readonly<Record<ClaudeCodeLinkState, ClaudeCodeLink>> = {
  'not-connected': CLAUDE_CODE_LINKS[0],
  detected: CLAUDE_CODE_LINKS[1],
  'vscode-available': CLAUDE_CODE_LINKS[2],
  'awaiting-bridge': CLAUDE_CODE_LINKS[3],
  busy: CLAUDE_CODE_LINKS[4],
  disconnected: CLAUDE_CODE_LINKS[5],
};
