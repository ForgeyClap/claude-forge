/**
 * WP-S2 (v2.9.0) — plain-language presentation helpers for Settings ▸ Forge
 * settings, split out of SettingsView.tsx so they are unit-testable without
 * mounting the view: a beginner-friendly NAME per setting, a topical group
 * (safety / usage / working style / tools / advanced) instead of the tool's
 * own on-by-default/when-needed/advanced buckets, plain words for where a
 * value came from, and the exact CLI hint text used inside each row's
 * collapsed "For the command line" detail.
 *
 * Pure data in, pure data out — no React, no fetch, so `forge-setting-
 * presentation.test.ts` can assert every rule directly.
 *
 * NAMING SOURCE OF TRUTH: `labelForSetting` reuses the curated words from
 * `.claude/config/orchestration/FORGE_CONFIG_SCHEMA.json`'s own `aliases.en`
 * / `desc.en` phrasing (the same catalogue `forge-config.cjs` itself reads)
 * so this view never invents a second vocabulary for the same setting. A key
 * the curated map does not know yet (a newer schema entry, or a test fixture)
 * still gets a real, readable label from `humanizeSettingKey` — never a blank
 * or the raw dotted/dashed key — which is exactly what
 * `forge-setting-presentation.test.ts`'s "every key gets a label" test locks
 * in.
 */

import type { GatewayForgeSetting } from '@/prototype/state/gateway-capabilities';

/* ============================================================ plain names */

/** Curated plain-language names for every setting in the v2.7.0 schema. Keep
 *  this in sync with FORGE_CONFIG_SCHEMA.json's `settings` map when a new key
 *  is added — the fallback below keeps the view honest in the meantime. */
const FORGE_SETTING_LABELS: Readonly<Record<string, string>> = {
  'usage-guard': 'Usage guard',
  'usage-guard.pause-at': 'Pause at (% of your limit)',
  'usage-guard.week-pause-at': 'Weekly pause at (% of your weekly limit)',
  'usage-guard.resume-at': 'Resume at (% of your limit)',
  'usage-guard.interval': 'Check interval (seconds)',
  'usage-guard.nvidia-shift-at': 'Shift bulk work to NVIDIA at (%)',
  autonomy: 'Autonomy',
  'start-gate': 'Ask before starting',
  'gate-hook': 'Stop on risky commands',
  'git-checkpoint': 'Git safety checkpoint',
  intake: 'Answer setup questions itself',
  'prompt-doctor': 'Check your request for gaps',
  'explain-mode': 'Explain what it is doing',
  dashboard: 'Command Center dashboard',
  'discord-autostart': 'Start the Discord bot automatically',
  'codex-review': 'Second AI code review (Codex)',
  'model-tiering': 'Match the model to the task',
  nvidia: 'Use NVIDIA for bulk work',
  'agent-memory': 'Remember lessons between runs',
  snapshots: 'Save progress before summarizing',
  'tool-log': 'Log which files changed',
  'ui-quality': 'Require real screenshots for UI work',
  'real-file-testing': 'Test with your real files',
  'research-first': 'Research before building',
  council: 'Get a second opinion on risky choices',
  docdrift: 'Check docs still match the tools',
  language: 'Language',
  'team-max': 'Maximum agents at once',
  tournament: 'Build a few options and pick the best',
  'code-index': 'Keep a code index',
  portfolio: 'Learn from your other projects',
  'skill-proposals': 'Suggest new skills',
  nightshift: 'Resume overnight and brief you',
  mcp: 'Use your connected external tools',
  paperclip: 'Unattended background agents',
  cleanup: 'Old file cleanup',
  'ecc-full-test': 'Full diagnostic test mode',
  'budget-usd': 'Spending limit per run',
  vault: 'Write readable notes after each run',
};

/** `usage-guard.pause-at` -> `Usage Guard Pause At`. Only ever reached for a
 *  key the curated map above does not (yet) list — real Forge keys are short
 *  and dash/dot separated, so this is legible even unstyled. Never returns an
 *  empty string for a non-empty key. */
export function humanizeSettingKey(key: string): string {
  const words = key
    .split(/[.\-_]+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));
  return words.length > 0 ? words.join(' ') : key;
}

/** The plain-language name shown as the primary heading of a settings row —
 *  curated first, a readable humanization of the key otherwise. Always
 *  returns a non-empty string for a non-empty key, which is what lets the
 *  view promise every setting the gateway reports gets a real name, not just
 *  the ones this file's author thought of first. */
export function labelForSetting(key: string): string {
  if (key === '') return key;
  return FORGE_SETTING_LABELS[key] ?? humanizeSettingKey(key);
}

/* ============================================================== grouping */

export interface ForgeSettingCategory {
  readonly id: string;
  readonly title: string;
  readonly intro: string;
}

/** Topical groups a beginner can scan, replacing the tool's own
 *  core/when-needed/advanced buckets (which mix "how much quota you spend"
 *  with "which language it talks" under one 24-row wall — see this work
 *  package's owner screenshot). Order here is the order they render in. */
export const FORGE_SETTING_CATEGORIES: readonly ForgeSettingCategory[] = [
  {
    id: 'safety',
    title: 'Safety and quality',
    intro: 'Guardrails that stop risky actions and keep the work checked before it is called done.',
  },
  {
    id: 'usage',
    title: 'Usage and cost',
    intro: 'How closely Forge watches your Claude usage limit and any money it can spend.',
  },
  {
    id: 'working-style',
    title: 'Working style',
    intro: 'How Forge behaves while it works — how much it asks you, and how it talks to you.',
  },
  {
    id: 'tools',
    title: 'Dashboard and tools',
    intro: 'The dashboard, model choices, memory and outside tools Forge is allowed to use.',
  },
  {
    id: 'advanced',
    title: 'Advanced',
    intro: 'Rarely needed. Change these only if you know exactly why.',
  },
];

const FORGE_CATEGORY_BY_KEY: Readonly<Record<string, string>> = {
  'usage-guard': 'usage',
  'usage-guard.pause-at': 'usage',
  'usage-guard.week-pause-at': 'usage',
  'usage-guard.resume-at': 'usage',
  'usage-guard.interval': 'usage',
  'usage-guard.nvidia-shift-at': 'usage',
  'budget-usd': 'usage',
  'gate-hook': 'safety',
  'git-checkpoint': 'safety',
  'ui-quality': 'safety',
  'real-file-testing': 'safety',
  'research-first': 'safety',
  docdrift: 'safety',
  cleanup: 'safety',
  autonomy: 'working-style',
  'start-gate': 'working-style',
  intake: 'working-style',
  'prompt-doctor': 'working-style',
  'explain-mode': 'working-style',
  language: 'working-style',
  council: 'working-style',
  tournament: 'working-style',
  'team-max': 'working-style',
  dashboard: 'tools',
  'discord-autostart': 'tools',
  'codex-review': 'tools',
  'model-tiering': 'tools',
  nvidia: 'tools',
  mcp: 'tools',
  'code-index': 'tools',
  'skill-proposals': 'tools',
  nightshift: 'tools',
  portfolio: 'tools',
  'agent-memory': 'tools',
  snapshots: 'tools',
  vault: 'tools',
  'tool-log': 'tools',
  paperclip: 'advanced',
  'ecc-full-test': 'advanced',
};

/** A key this project has not categorised yet falls back on the API's own
 *  `group` field rather than disappearing — "never silently dropped" holds
 *  for the new grouping exactly as it held for the old table's groups. */
const FALLBACK_CATEGORY_BY_API_GROUP: Readonly<Record<string, string>> = {
  core: 'working-style',
  'when-needed': 'tools',
  advanced: 'advanced',
};

const DEFAULT_CATEGORY_ID = 'working-style';

export function categoryIdForSetting(key: string, apiGroup: string | null): string {
  return (
    FORGE_CATEGORY_BY_KEY[key] ??
    FALLBACK_CATEGORY_BY_API_GROUP[apiGroup ?? ''] ??
    DEFAULT_CATEGORY_ID
  );
}

export function categoryById(id: string): ForgeSettingCategory {
  return (
    FORGE_SETTING_CATEGORIES.find((category) => category.id === id) ?? {
      id,
      title: humanizeSettingKey(id),
      intro: '',
    }
  );
}

export interface ForgeSettingCategoryGroup {
  readonly category: ForgeSettingCategory;
  readonly settings: readonly GatewayForgeSetting[];
}

/** Buckets settings into the topical categories above, in category order,
 *  dropping only categories that end up with zero matching settings (e.g.
 *  after a search filter narrows the list). Every input setting lands in
 *  exactly one group — round-tripping the total count is the exact
 *  no-setting-goes-missing guarantee `forge-setting-presentation.test.ts`
 *  checks for. */
export function categorizeForgeSettings(
  settings: readonly GatewayForgeSetting[],
): readonly ForgeSettingCategoryGroup[] {
  return FORGE_SETTING_CATEGORIES.map((category) => ({
    category,
    settings: settings.filter((setting) => categoryIdForSetting(setting.key, setting.group) === category.id),
  })).filter((group) => group.settings.length > 0);
}

/* ================================================================ search */

/** True when `setting` matches a free-text query against its plain name,
 *  technical key, or description — an empty query always matches, so the
 *  caller never needs a separate "no query" branch. */
export function forgeSettingMatchesQuery(setting: GatewayForgeSetting, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  const haystack = [labelForSetting(setting.key), setting.key, setting.desc ?? '']
    .join(' ')
    .toLowerCase();
  return haystack.includes(needle);
}

/* ============================================================== source */

export interface ForgeSourceBadge {
  /** Short text — safe to show in a small badge, never breaks mid-word. */
  readonly text: string;
  /** True when a person (not Forge itself) set this value. */
  readonly changed: boolean;
  /** The fuller sentence, meant for a tooltip/title attribute. */
  readonly title: string;
}

const UNKNOWN_SOURCE_BADGE: ForgeSourceBadge = {
  text: 'Unknown',
  changed: false,
  title: 'Forge did not report where this value comes from.',
};

/** Turns `GatewayForgeSetting.source` (a tool-internal word: default,
 *  product-default, project, global, flag, safe-fallback) into a short,
 *  plain badge plus a fuller tooltip sentence — never the raw source word
 *  itself, which a beginner has no way to interpret. */
export function forgeSourceBadge(source: string | null): ForgeSourceBadge {
  switch (source) {
    case 'default':
      return {
        text: 'Forge default',
        changed: false,
        title: 'This is the built-in Forge default. Nobody has changed it.',
      };
    case 'product-default':
      return {
        text: 'Forge default',
        changed: false,
        title: 'The recommended default for your setup. Nobody has changed it by hand.',
      };
    case 'project':
      return {
        text: 'You changed this — this project',
        changed: true,
        title: 'You set this value yourself. It is saved for this project only.',
      };
    case 'global':
      return {
        text: 'You changed this — all projects',
        changed: true,
        title: 'You set this value yourself. It is saved for every project on this computer.',
      };
    case 'flag':
      return {
        text: 'You changed this — this run only',
        changed: true,
        title: 'Set only for the current run. It is never saved to a file.',
      };
    case 'safe-fallback':
      return {
        text: 'Using a safe fallback',
        changed: false,
        title: 'Forge could not read the saved value, so it is using a safe fallback instead.',
      };
    default:
      return UNKNOWN_SOURCE_BADGE;
  }
}

/* ========================================================== CLI command */

const GATE_HOOK_KEY = 'gate-hook';
/** The exact sentence `ForgeSettingControl`'s gate-hook branch used to show
 *  inline before WP-S2 moved it into the row's own collapsed detail — kept
 *  word-for-word here so the "for the command line" hint never claims a
 *  command this project has not actually verified. */
const GATE_HOOK_OFF_COMMAND = 'node .claude/forge-bin/forge-config.cjs set gate-hook off';

/** The exact command that changes a setting: an on/off setting shows the
 *  command that flips it; any other shows its current value, ready to edit.
 *  gate-hook is special-cased to the one command that can ever turn it off
 *  (see this file's header) rather than the generic `/forge config set`
 *  form, which is not the command CLAUDE.md documents for this one key. */
export function forgeSetCommand(setting: GatewayForgeSetting): string {
  if (setting.key === GATE_HOOK_KEY && setting.status === 'on') return GATE_HOOK_OFF_COMMAND;
  let next = '<value>';
  if (typeof setting.value === 'boolean') next = setting.value ? 'off' : 'on';
  else if (setting.value !== null) next = String(setting.value);
  return `/forge config set ${setting.key} ${next}`;
}
