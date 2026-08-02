/**
 * slash-commands — the composer's `/` command menu (feat-composer-power, forge-2026-07-29-cc-finish).
 *
 * Maps ONLY to actions that genuinely exist and do something real in this system today: the four
 * real send-mode choices (`ChatSendMode`), the six real effort choices (`ChatSendEffort` plus
 * "no effort"/default), the real Auto-plan toggle, and — where the caller actually wires them in —
 * the real "start a new conversation" / "delete this conversation" actions `ChatView.tsx` already
 * drives for its own toolbar buttons. No command here inserts placeholder text pretending to have
 * done something: every one calls the real setter/handler that performs it, and the composer
 * clears the typed `/command` text once it runs (see `Composer.tsx`) rather than leaving it
 * sitting in the draft as if it were about to be sent as a chat message.
 */

import type { ChatSendEffort, ChatSendMode } from '@/prototype/state/chat-send';

/** `'default'` stands for "omit --effort" — mirrors `Composer.tsx`'s own `EffortChoice` type. */
export type SlashEffortChoice = 'default' | ChatSendEffort;

export interface SlashCommandContext {
  readonly autoPlan: boolean;
  readonly setSendMode: (mode: ChatSendMode) => void;
  readonly setEffortChoice: (choice: SlashEffortChoice) => void;
  readonly setAutoPlan: (value: boolean) => void;
  /** Present only when `ChatView.tsx` actually wired a real "new conversation" action for the
   *  active composer instance (there is nothing real for `/new` to do before a project exists,
   *  or in a context with no such action at all). */
  readonly onNewChat?: () => void;
  /** Present only when a real conversation exists to delete. */
  readonly onRequestDelete?: () => void;
}

export interface SlashCommand {
  readonly id: string;
  /** Matched (case-insensitively, substring) against the text typed after `/`. */
  readonly trigger: string;
  /** Shown as `/label` in the menu. */
  readonly label: string;
  readonly icon: string;
  readonly detail: string;
  /** False hides the command entirely — e.g. `/new`/`/delete` before the caller wires a real
   *  handler in. Never rendered as a disabled-but-visible entry that "does nothing" either way. */
  readonly available: (ctx: SlashCommandContext) => boolean;
  readonly run: (ctx: SlashCommandContext) => void;
}

const ALWAYS_AVAILABLE = (): boolean => true;

const MODE_COMMANDS: readonly SlashCommand[] = [
  {
    id: 'mode-execute',
    trigger: 'execute',
    label: '/execute',
    icon: 'Play',
    detail: 'Set send mode to Execute — run and edit files immediately',
    available: ALWAYS_AVAILABLE,
    run: (ctx) => ctx.setSendMode('execute'),
  },
  {
    id: 'mode-plan',
    trigger: 'plan',
    label: '/plan',
    icon: 'Workflow',
    detail: 'Set send mode to Plan — propose a plan without writing files',
    available: ALWAYS_AVAILABLE,
    run: (ctx) => ctx.setSendMode('plan'),
  },
  {
    id: 'mode-accept-edits',
    trigger: 'accept-edits',
    label: '/accept-edits',
    icon: 'FileCheck',
    detail: 'Set send mode to Accept edits — run and auto-accept file edits',
    available: ALWAYS_AVAILABLE,
    run: (ctx) => ctx.setSendMode('accept-edits'),
  },
  {
    id: 'mode-bypass',
    trigger: 'bypass',
    label: '/bypass',
    icon: 'PlugZap',
    detail: 'Set send mode to Bypass — run without approval prompts',
    available: ALWAYS_AVAILABLE,
    run: (ctx) => ctx.setSendMode('bypass'),
  },
];

const EFFORT_TRIGGERS: readonly [id: string, value: SlashEffortChoice, detail: string][] = [
  ['effort-default', 'default', 'Omit --effort (the CLI’s own default)'],
  ['effort-low', 'low', 'Set --effort low'],
  ['effort-medium', 'medium', 'Set --effort medium'],
  ['effort-high', 'high', 'Set --effort high'],
  ['effort-xhigh', 'xhigh', 'Set --effort xhigh'],
  ['effort-max', 'max', 'Set --effort max'],
];

const EFFORT_COMMANDS: readonly SlashCommand[] = EFFORT_TRIGGERS.map(([id, value, detail]) => ({
  id,
  trigger: id,
  label: `/${id}`,
  icon: 'Gauge',
  detail,
  available: ALWAYS_AVAILABLE,
  run: (ctx: SlashCommandContext) => ctx.setEffortChoice(value),
}));

const AUTO_PLAN_COMMAND: SlashCommand = {
  id: 'auto-plan-toggle',
  trigger: 'auto-plan',
  label: '/auto-plan',
  icon: 'SlidersHorizontal',
  detail: 'Toggle Auto-plan on or off',
  available: ALWAYS_AVAILABLE,
  run: (ctx) => ctx.setAutoPlan(!ctx.autoPlan),
};

const NEW_CHAT_COMMAND: SlashCommand = {
  id: 'new-chat',
  trigger: 'new',
  label: '/new',
  icon: 'MessageSquarePlus',
  detail: 'Start a new conversation',
  available: (ctx) => ctx.onNewChat !== undefined,
  run: (ctx) => ctx.onNewChat?.(),
};

const DELETE_CHAT_COMMAND: SlashCommand = {
  id: 'delete-chat',
  trigger: 'delete',
  label: '/delete',
  icon: 'Trash2',
  detail: 'Delete this conversation',
  available: (ctx) => ctx.onRequestDelete !== undefined,
  run: (ctx) => ctx.onRequestDelete?.(),
};

/** Every real command this composer can offer. Availability (not just the query match) still
 *  gates what actually renders — see `filterSlashCommands`. */
export const ALL_SLASH_COMMANDS: readonly SlashCommand[] = [
  ...MODE_COMMANDS,
  ...EFFORT_COMMANDS,
  AUTO_PLAN_COMMAND,
  NEW_CHAT_COMMAND,
  DELETE_CHAT_COMMAND,
];

/**
 * The `/query` the caret currently sits inside, or null. Anchored to the very start of the draft —
 * a `/` typed elsewhere in a message is ordinary text, not a command (the same convention a real
 * slash-command surface like Discord/Notion uses: only the leading token can be a command).
 */
export function activeSlashQuery(value: string, caret: number): string | null {
  if (!value.startsWith('/')) return null;
  const spaceIndex = value.indexOf(' ');
  const tokenEnd = spaceIndex === -1 ? value.length : spaceIndex;
  if (caret > tokenEnd) return null;
  return value.slice(1, tokenEnd);
}

/** Commands that are both genuinely available in this context and match the typed query
 *  (case-insensitive substring on the trigger), capped at `limit`. */
export function filterSlashCommands(
  commands: readonly SlashCommand[],
  query: string,
  ctx: SlashCommandContext,
  limit = 20,
): readonly SlashCommand[] {
  const q = query.toLowerCase();
  return commands.filter((cmd) => cmd.available(ctx) && cmd.trigger.toLowerCase().includes(q)).slice(0, limit);
}
