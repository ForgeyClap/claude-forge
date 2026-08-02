/**
 * compose-args — pure send-mode/effort helpers for the Composer.
 *
 * Split out of `Composer.tsx` itself (not a component, so it never belongs there): a plain
 * function export sitting alongside a component export in the same file trips
 * `react-refresh/only-export-components` (fast refresh can only hot-swap a module that exports
 * components only) — the fix is relocation, not a lint-disable, mirroring this project's own prior
 * fix for the exact same warning class.
 */

import type { ChatSendEffort, ChatSendMode, ChatSendModel } from '@/prototype/state/chat-send';

/** Every real `ChatSendMode` value — mirrors the type exactly. */
export function isChatSendMode(value: string): value is ChatSendMode {
  return value === 'execute' || value === 'plan' || value === 'accept-edits' || value === 'bypass';
}

/** Every real `ChatSendEffort` value — mirrors the type exactly. */
export const EFFORT_VALUES: readonly ChatSendEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export function isChatSendEffort(value: string): value is ChatSendEffort {
  return (EFFORT_VALUES as readonly string[]).includes(value);
}

/** feat-model-picker: every real `ChatSendModel` value — mirrors the type exactly (the four full
 *  ids the picker itself offers, `claude-opus-5[1m]` being the real, CLI-verified 1M-context
 *  variant since the 2026-07-30 correction; see `ChatSendModel`'s own doc comment for why the
 *  gateway's additional short aliases are never a picker choice). */
export const MODEL_VALUES: readonly ChatSendModel[] = ['claude-fable-5', 'claude-opus-5[1m]', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'];

export function isChatSendModel(value: string): value is ChatSendModel {
  return (MODEL_VALUES as readonly string[]).includes(value);
}

/**
 * Builds the exact positional arguments for `ComposerProps['onSend']`, holding this file's
 * long-standing convention that a default value is OMITTED rather than passed explicitly:
 * `'execute'` (the default mode), "no effort chosen" and "no model chosen" are never sent unless
 * a later, real position also needs filling.
 */
export function sendArgsFor(
  body: string,
  mode: ChatSendMode,
  effort: ChatSendEffort | undefined,
  model?: ChatSendModel,
):
  | readonly [string]
  | readonly [string, ChatSendMode]
  | readonly [string, ChatSendMode, ChatSendEffort]
  | readonly [string, ChatSendMode, ChatSendEffort | undefined, ChatSendModel] {
  if (model !== undefined) return [body, mode, effort, model];
  if (effort !== undefined) return mode === 'execute' ? [body, 'execute', effort] : [body, mode, effort];
  return mode === 'execute' ? [body] : [body, mode];
}

/** The exact follow-up turn the "Run this plan" button (composer-modes-ui) sends. */
export const RUN_PLAN_MESSAGE = 'Voer het zojuist voorgestelde plan uit.';
