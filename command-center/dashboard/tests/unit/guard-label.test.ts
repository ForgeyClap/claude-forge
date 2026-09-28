/**
 * The usage pill's guard label (found live 2026-09-28): a guard state that says "ok" while its watcher is
 * not running is not an active guard, and the pill must say so instead of "Active".
 */
import { describe, expect, it } from 'vitest';

import { guardLabel, guardStateAttr, isGuardWatcherDown } from '@/prototype/state/guard-label';

describe('guardLabel', () => {
  it('a dead watcher is "Not running", even when the saved mode still says ok', () => {
    const g = { available: true, mode: 'ok', watcher: 'not-running' };
    expect(guardLabel(g)).toBe('Not running');
    expect(isGuardWatcherDown(g)).toBe(true);
    expect(guardStateAttr(g)).toBe('not-running');
  });

  it('a hanging watcher (alive, no heartbeat for three intervals) is "Not checking"', () => {
    const g = { available: true, mode: 'paused', watcher: 'stale' };
    expect(guardLabel(g)).toBe('Not checking');
    expect(guardStateAttr(g)).toBe('stale');
  });

  it('a running watcher shows the real mode', () => {
    expect(guardLabel({ available: true, mode: 'ok', watcher: 'running' })).toBe('Active');
    expect(guardLabel({ available: true, mode: 'paused', watcher: 'running' })).toBe('Paused');
    expect(guardStateAttr({ available: true, mode: 'paused', watcher: 'running' })).toBe('paused');
  });

  it('an older gateway without the watcher field, or an "unknown" watcher, keeps the mode as before', () => {
    expect(guardLabel({ available: true, mode: 'ok', watcher: null })).toBe('Active');
    expect(guardLabel({ available: true, mode: 'ok', watcher: 'unknown' })).toBe('Active');
    expect(isGuardWatcherDown({ available: true, mode: 'ok', watcher: 'unknown' })).toBe(false);
  });

  it('no guard state at all is n/a, never "Not running"', () => {
    const g = { available: false, mode: null, watcher: 'not-running' };
    expect(guardLabel(g)).toBe('n/a');
    expect(isGuardWatcherDown(g)).toBe(false);
    expect(guardStateAttr(g)).toBe('unknown');
  });
});
