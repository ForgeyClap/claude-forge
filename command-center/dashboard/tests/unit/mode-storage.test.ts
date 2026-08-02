/**
 * mode-storage (feat-forge-preamble, forge-2026-07-30-cc-finish): `readStoredMode`'s new
 * bypass-by-default behavior for a project that has never persisted a send-mode choice — see
 * `mode-storage.ts`'s own doc comment for the honest reason (a non-interactive dashboard session
 * can never answer an interactive approval prompt, mirrors `exec-argv.mjs`'s own SECURITY FRAME
 * comment for 'bypass' mode itself). A previously PERSISTED choice — including an explicit
 * 'execute' — must never be silently upgraded.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { modeStorageKey, persist, readStoredMode } from '@/views/chat/mode-storage';

describe('readStoredMode (feat-forge-preamble bypass-by-default)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('defaults a brand-new project (never persisted a choice) to "bypass"', () => {
    expect(readStoredMode('p-new')).toBe('bypass');
  });

  it('an empty/unknown project id still defaults to "execute" — there is no real project to run anything in at all', () => {
    expect(readStoredMode('')).toBe('execute');
  });

  it('a previously persisted "execute" choice is NOT silently upgraded to "bypass"', () => {
    persist(modeStorageKey('p1'), 'execute');
    expect(readStoredMode('p1')).toBe('execute');
  });

  it('a previously persisted "accept-edits" choice round-trips unchanged', () => {
    persist(modeStorageKey('p1'), 'accept-edits');
    expect(readStoredMode('p1')).toBe('accept-edits');
  });

  it('a previously persisted "bypass" choice round-trips unchanged (indistinguishable from the default, but still a real persisted read)', () => {
    persist(modeStorageKey('p1'), 'bypass');
    expect(readStoredMode('p1')).toBe('bypass');
  });

  it('an invalid stored value falls back to the new default ("bypass"), never a crash', () => {
    localStorage.setItem(modeStorageKey('p1'), 'not-a-real-mode');
    expect(readStoredMode('p1')).toBe('bypass');
  });

  it('two different projects each get their own independent bypass default — never shared state', () => {
    persist(modeStorageKey('p1'), 'execute');
    expect(readStoredMode('p1')).toBe('execute');
    expect(readStoredMode('p2')).toBe('bypass');
  });
});
