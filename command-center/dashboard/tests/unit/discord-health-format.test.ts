/**
 * health-format — v2.9.0 (Command Center audit finding 31): the Discord view's "Bot health" panel
 * used to print nested values as raw JSON. These pin the readable replacements, using the real
 * field names the bot's health server reports today.
 */
import { describe, expect, it } from 'vitest';

import { formatHealthValue, formatSeconds, healthKeyLabel } from '@/views/discord/health-format';

describe('formatHealthValue', () => {
  it('a state-count object reads as "STATE: n" pairs, never as JSON', () => {
    const out = formatHealthValue('queueDepth', { COMPLETED: 29, CANCELLED: 2 });
    expect(out).toBe('COMPLETED: 29 · CANCELLED: 2');
    expect(out).not.toContain('{');
  });

  it('a list of named objects reads as their names; a long list is shortened with a count', () => {
    expect(formatHealthValue('guilds', [{ id: '1', name: 'Forge Server' }])).toBe('Forge Server');
    const projects = Array.from({ length: 14 }, (_, i) => ({ projectId: `project-${i + 1}`, channelId: '9', forgeMode: true, archived: false }));
    expect(formatHealthValue('projects', projects)).toBe('14 — project-1, project-2, project-3, project-4, project-5 and 9 more');
  });

  it('a list without usable names falls back to an honest count', () => {
    expect(formatHealthValue('things', [{ a: 1 }, { b: 2 }])).toBe('2 items');
    expect(formatHealthValue('things', [])).toBe('none');
  });

  it('booleans read yes/no, null reads as a dash, strings pass through', () => {
    expect(formatHealthValue('connected', true)).toBe('yes');
    expect(formatHealthValue('busy', false)).toBe('no');
    expect(formatHealthValue('loginError', null)).toBe('—');
    expect(formatHealthValue('phase', 'ready')).toBe('ready');
  });

  it('an epoch timestamp under an "...At" or "ts" key becomes a date, other numbers stay numbers', () => {
    const started = Date.UTC(2026, 8, 27, 12, 0, 0);
    const out = formatHealthValue('startedAt', started);
    expect(out).not.toBe(String(started));
    expect(out).toContain('2026');
    expect(formatHealthValue('ts', started)).toContain('2026');
    expect(formatHealthValue('pid', 53948)).toBe('53948');
    expect(formatHealthValue('activeRuns', 0)).toBe('0');
  });

  it('seconds under a "...Sec" key become a readable duration', () => {
    expect(formatHealthValue('uptimeSec', 3725)).toBe('1 h 2 min');
  });
});

describe('formatSeconds', () => {
  it('covers seconds, minutes, hours and days', () => {
    expect(formatSeconds(45)).toBe('45 s');
    expect(formatSeconds(720)).toBe('12 min');
    expect(formatSeconds(3600)).toBe('1 h');
    expect(formatSeconds(2 * 86400 + 4 * 3600)).toBe('2 d 4 h');
  });
});

describe('healthKeyLabel', () => {
  it('known fields get plain names', () => {
    expect(healthKeyLabel('queueDepth')).toBe('Jobs by state');
    expect(healthKeyLabel('uptimeSec')).toBe('Uptime');
    expect(healthKeyLabel('inviteUrl')).toBe('Invite link');
  });

  it('an unknown field is humanized, never dropped', () => {
    expect(healthKeyLabel('someNewField')).toBe('Some new field');
    expect(healthKeyLabel('snake_case_field')).toBe('Snake case field');
  });
});
