/**
 * mode-storage — persisted send-mode/effort/auto-plan choices for the composer.
 *
 * refactor-chat-split (forge-2026-07-30-cc-finish): split out of `Composer.tsx` — a plain function
 * export sitting alongside a component export in the same file trips
 * `react-refresh/only-export-components` (mirrors this directory's own `compose-args.ts` precedent
 * for the exact same warning class). Pure structural move: no behavior changed, no storage key
 * changed.
 */

import type { ChatSendEffort } from '@/prototype/state/chat-send';
import type { ChatSendMode } from '@/prototype/state/chat-send';
import type { ChatSendModel } from '@/prototype/state/chat-send';

import { isChatSendEffort, isChatSendMode, isChatSendModel } from './compose-args';

/** `'default'` stands for "omit the field" — the one choice that is not itself a `ChatSendEffort`. */
export type EffortChoice = 'default' | ChatSendEffort;

/** feat-model-picker: `'default'` stands for "omit --model" (the CLI's own current default) — the
 *  one choice that is not itself a `ChatSendModel`. Mirrors `EffortChoice`'s own shape exactly. */
export type ModelChoice = 'default' | ChatSendModel;

/**
 * composer-modes-ui: the effort/auto-plan choices persist per browser (not per project or
 * conversation — a simple, honest global "how I like to send messages" preference), mirroring
 * `prototype-store.ts`'s own `forge.prototype.*` localStorage convention exactly (same
 * try/catch-and-fall-back-to-a-safe-default read, same tolerant-write `persist` helper).
 *
 * fix-sec-round #2 (MEDIUM): the send-MODE choice does NOT stay global — a sticky "bypass" choice
 * silently carried over from one project into a completely different one (browser-wide, never
 * expiring) is a real footgun: the next message in an unrelated project would run with
 * `--permission-mode bypassPermissions` with no further confirmation. The mode is therefore keyed
 * per project id; an unknown/empty project id (no real project to run anything in at all) never
 * reads (or writes) any stored value and always resolves to `'execute'`.
 *
 * feat-forge-preamble (owner directive "fully permission", 2026-07-30-cc-finish): a project that
 * has never had a choice persisted for it yet — its FIRST ever send — now resolves to `'bypass'`
 * instead of `'execute'`. This is the honest reason: a non-interactive dashboard session can never
 * answer an interactive approval prompt (there is no human sitting at a terminal to click
 * "allow"), so an `'execute'` default would silently refuse most real write work on a brand-new
 * project. Composer.tsx's own bypass hint paragraph states this plainly the moment Bypass becomes
 * the active mode. A choice the owner (or a prior session) has ALREADY persisted — including an
 * explicit `'execute'` — is never overridden; this only changes what a never-before-seen project
 * starts at.
 */
const MODE_STORAGE_PREFIX = 'forge.prototype.chatSendMode';
export const EFFORT_STORAGE_KEY = 'forge.prototype.chatEffort';
export const AUTO_PLAN_STORAGE_KEY = 'forge.prototype.chatAutoPlan';
// feat-model-picker: unlike effort (global, see the doc comment above), the model choice persists
// PER PROJECT — same rationale fix-sec-round #2 already established for `mode`: a browser-wide
// sticky pick that silently carried into an unrelated project would be a real footgun (spending a
// heavier/pricier model in a project the user never chose it for), so it is keyed per project id
// exactly like `MODE_STORAGE_PREFIX` above, with the same "unknown/empty project id never reads or
// writes" fallback to `'default'`.
const MODEL_STORAGE_PREFIX = 'forge.prototype.chatSendModel';

export function modeStorageKey(projectId: string): string {
  return `${MODE_STORAGE_PREFIX}.${projectId}`;
}

export function readStoredMode(projectId: string): ChatSendMode {
  if (projectId === '') return 'execute';
  try {
    const raw = localStorage.getItem(modeStorageKey(projectId));
    // 'bypass', not 'execute': see this file's own doc comment above for why a project with no
    // persisted choice yet defaults to full permission rather than a mode that can never actually
    // answer its own approval prompts in a non-interactive session.
    return raw !== null && isChatSendMode(raw) ? raw : 'bypass';
  } catch {
    return 'bypass';
  }
}

export function modelStorageKey(projectId: string): string {
  return `${MODEL_STORAGE_PREFIX}.${projectId}`;
}

export function readStoredModel(projectId: string): ModelChoice {
  if (projectId === '') return 'default';
  try {
    const raw = localStorage.getItem(modelStorageKey(projectId));
    return raw !== null && isChatSendModel(raw) ? raw : 'default';
  } catch {
    return 'default';
  }
}

export function readStoredEffort(): EffortChoice {
  try {
    const raw = localStorage.getItem(EFFORT_STORAGE_KEY);
    return raw !== null && isChatSendEffort(raw) ? raw : 'default';
  } catch {
    return 'default';
  }
}

export function readStoredAutoPlan(): boolean {
  try {
    return localStorage.getItem(AUTO_PLAN_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function persist(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Private mode or storage disabled — the choice simply does not persist across reloads. */
  }
}
