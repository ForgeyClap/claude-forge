/**
 * WP-S2 (v2.9.0) — pure-logic coverage for the plain-language Settings ▸
 * Forge settings helpers: every setting the gateway can report resolves to a
 * real name (never blank, never the raw dotted/dashed key), every setting
 * lands in exactly one topical group, a free-text search matches on the
 * words a beginner would actually type, and a technical `source` string
 * becomes an honest plain-language badge. No React here — SettingsView's own
 * rendering of these helpers is covered separately in
 * settings-forge-config-section.test.tsx.
 */

import { describe, expect, it } from 'vitest';

import {
  FORGE_SETTING_CATEGORIES,
  categoryIdForSetting,
  categorizeForgeSettings,
  forgeSetCommand,
  forgeSettingMatchesQuery,
  forgeSourceBadge,
  humanizeSettingKey,
  labelForSetting,
} from '@/views/settings/forge-setting-presentation';
import type { GatewayForgeSetting } from '@/prototype/state/gateway-capabilities';

/* ========================================================================== */
/*  Harness                                                                    */
/* ========================================================================== */

const REAL_SCHEMA_KEYS = [
  'usage-guard',
  'usage-guard.pause-at',
  'usage-guard.resume-at',
  'usage-guard.interval',
  'usage-guard.nvidia-shift-at',
  'autonomy',
  'start-gate',
  'gate-hook',
  'git-checkpoint',
  'intake',
  'prompt-doctor',
  'explain-mode',
  'dashboard',
  'codex-review',
  'model-tiering',
  'nvidia',
  'agent-memory',
  'snapshots',
  'tool-log',
  'ui-quality',
  'real-file-testing',
  'research-first',
  'council',
  'docdrift',
  'language',
  'team-max',
  'tournament',
  'code-index',
  'portfolio',
  'skill-proposals',
  'nightshift',
  'mcp',
  'paperclip',
  'cleanup',
  'ecc-full-test',
  'budget-usd',
];

function setting(overrides: Partial<GatewayForgeSetting> & { key: string }): GatewayForgeSetting {
  return {
    value: null,
    defaultValue: null,
    display: null,
    status: null,
    source: 'default',
    scope: 'project',
    group: 'core',
    type: 'bool',
    unit: null,
    desc: null,
    offMeans: null,
    disclosure: null,
    flags: [],
    setAt: null,
    setBy: null,
    allowed: [],
    min: null,
    max: null,
    ...overrides,
  };
}

/* ========================================================================== */
/*  Labels                                                                     */
/* ========================================================================== */

describe('labelForSetting / humanizeSettingKey', () => {
  it('matches the exact plain names this work package promised the owner', () => {
    // The owner's own four worked examples for this work package, verbatim.
    expect(labelForSetting('usage-guard')).toBe('Usage guard');
    expect(labelForSetting('usage-guard.pause-at')).toBe('Pause at (% of your limit)');
    expect(labelForSetting('autonomy')).toBe('Autonomy');
    expect(labelForSetting('start-gate')).toBe('Ask before starting');
  });

  it('gives every real schema key a non-empty, human label with no raw separators', () => {
    for (const key of REAL_SCHEMA_KEYS) {
      const label = labelForSetting(key);
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toBe(key);
      expect(label).not.toMatch(/[.\-_]/);
    }
  });

  it('humanizes a key the curated map has never seen, instead of leaving it blank or raw', () => {
    // Simulates a brand-new schema key this file's curated map has not been updated for yet, and a
    // key a test fixture invents that will never appear in the real schema — both must still work.
    expect(labelForSetting('a-future.unseen_key')).toBe('A Future Unseen Key');
    expect(humanizeSettingKey('single')).toBe('Single');
    expect(humanizeSettingKey('')).toBe('');
  });

  it('the gate-hook and git-checkpoint labels read as plain safety language, not jargon', () => {
    expect(labelForSetting('gate-hook').toLowerCase()).toContain('risky');
    expect(labelForSetting('git-checkpoint').toLowerCase()).toContain('checkpoint');
  });
});

/* ========================================================================== */
/*  Grouping                                                                   */
/* ========================================================================== */

describe('categorizeForgeSettings / categoryIdForSetting', () => {
  it('never drops a setting: every input key appears in exactly one output group', () => {
    const settings = REAL_SCHEMA_KEYS.map((key) => setting({ key }));
    const groups = categorizeForgeSettings(settings);
    const seen = groups.flatMap((group) => group.settings.map((s) => s.key));
    expect(seen).toHaveLength(REAL_SCHEMA_KEYS.length);
    expect(new Set(seen).size).toBe(REAL_SCHEMA_KEYS.length); // no key counted twice
    for (const key of REAL_SCHEMA_KEYS) expect(seen).toContain(key);
  });

  it('only renders categories that actually have a matching setting', () => {
    const groups = categorizeForgeSettings([setting({ key: 'usage-guard' })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].category.id).toBe('usage');
    expect(groups[0].category.title.length).toBeGreaterThan(0);
    expect(groups[0].category.intro.length).toBeGreaterThan(0);
  });

  it('falls back to the API-reported group for a key this project has not categorised yet', () => {
    expect(categoryIdForSetting('brand-new-setting', 'when-needed')).toBe('tools');
    expect(categoryIdForSetting('brand-new-setting', 'advanced')).toBe('advanced');
    expect(categoryIdForSetting('brand-new-setting', 'core')).toBe('working-style');
    expect(categoryIdForSetting('brand-new-setting', null)).toBe('working-style');
  });

  it('every declared category has a real title and intro sentence', () => {
    for (const category of FORGE_SETTING_CATEGORIES) {
      expect(category.title.length).toBeGreaterThan(0);
      expect(category.intro.length).toBeGreaterThan(0);
    }
  });
});

/* ========================================================================== */
/*  Search                                                                     */
/* ========================================================================== */

describe('forgeSettingMatchesQuery', () => {
  const usageGuard = setting({ key: 'usage-guard', desc: 'Pauses Forge automatically near the limit.' });

  it('an empty (or whitespace-only) query matches everything', () => {
    expect(forgeSettingMatchesQuery(usageGuard, '')).toBe(true);
    expect(forgeSettingMatchesQuery(usageGuard, '   ')).toBe(true);
  });

  it('matches the plain name, case-insensitively', () => {
    expect(forgeSettingMatchesQuery(usageGuard, 'usage guard')).toBe(true);
    expect(forgeSettingMatchesQuery(usageGuard, 'USAGE')).toBe(true);
  });

  it('matches the technical key', () => {
    expect(forgeSettingMatchesQuery(usageGuard, 'usage-guard')).toBe(true);
  });

  it('matches the description', () => {
    expect(forgeSettingMatchesQuery(usageGuard, 'near the limit')).toBe(true);
  });

  it('does not match an unrelated word', () => {
    expect(forgeSettingMatchesQuery(usageGuard, 'zzz-nomatch')).toBe(false);
  });

  it('never throws on a null description', () => {
    expect(() => forgeSettingMatchesQuery(setting({ key: 'x', desc: null }), 'x')).not.toThrow();
  });
});

/* ========================================================================== */
/*  Source wording                                                             */
/* ========================================================================== */

describe('forgeSourceBadge', () => {
  it('a Forge-chosen value (default or product-default) is never described as "changed"', () => {
    expect(forgeSourceBadge('default')).toMatchObject({ text: 'Forge default', changed: false });
    expect(forgeSourceBadge('product-default')).toMatchObject({ text: 'Forge default', changed: false });
  });

  it('a person-set value says so, and names the scope in plain words', () => {
    expect(forgeSourceBadge('project')).toMatchObject({ changed: true, text: 'You changed this — this project' });
    expect(forgeSourceBadge('global')).toMatchObject({ changed: true, text: 'You changed this — all projects' });
    expect(forgeSourceBadge('flag')).toMatchObject({ changed: true, text: 'You changed this — this run only' });
  });

  it('never surfaces the raw tool-internal source word as the badge text', () => {
    for (const source of ['default', 'product-default', 'project', 'global', 'flag', 'safe-fallback']) {
      const badge = forgeSourceBadge(source);
      expect(badge.text).not.toBe(source);
      expect(badge.text.length).toBeGreaterThan(0);
      expect(badge.title.length).toBeGreaterThan(0);
    }
  });

  it('degrades honestly for null or an unrecognised source, instead of throwing or going blank', () => {
    expect(forgeSourceBadge(null).text.length).toBeGreaterThan(0);
    expect(forgeSourceBadge('something-new').text.length).toBeGreaterThan(0);
    expect(forgeSourceBadge(null).changed).toBe(false);
  });
});

/* ========================================================================== */
/*  Command text                                                               */
/* ========================================================================== */

describe('forgeSetCommand', () => {
  it('an on/off setting shows the command that flips it', () => {
    expect(forgeSetCommand(setting({ key: 'explain-mode', type: 'bool', value: true }))).toBe(
      '/forge config set explain-mode off',
    );
    expect(forgeSetCommand(setting({ key: 'paperclip', type: 'bool', value: false }))).toBe(
      '/forge config set paperclip on',
    );
  });

  it('any other setting shows its current value, ready to edit', () => {
    expect(forgeSetCommand(setting({ key: 'autonomy', type: 'enum', value: 'continue-within-mission' }))).toBe(
      '/forge config set autonomy continue-within-mission',
    );
    expect(forgeSetCommand(setting({ key: 'budget-usd', type: 'number', value: 5 }))).toBe(
      '/forge config set budget-usd 5',
    );
  });

  it('gate-hook, while on, always shows the one real command that can turn it off — never the generic form', () => {
    const gateHookOn = setting({ key: 'gate-hook', type: 'bool', value: true, status: 'on' });
    expect(forgeSetCommand(gateHookOn)).toBe('node .claude/forge-bin/forge-config.cjs set gate-hook off');
  });

  it('gate-hook while off falls back to the generic flip command (turning it back on is unrestricted)', () => {
    const gateHookOff = setting({ key: 'gate-hook', type: 'bool', value: false, status: 'off' });
    expect(forgeSetCommand(gateHookOff)).toBe('/forge config set gate-hook on');
  });
});
