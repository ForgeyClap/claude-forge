/**
 * `parseAccountUsage` — the account-wide usage-pressure parser (WP7c).
 *
 * No network, no React, no timers: pure-function tests against representative
 * `/api/usage` response shapes (mirroring `usage.mjs::buildUsage()`'s real,
 * already-tested field names 1:1). This is the first unit test to target
 * `gateway-adapter.ts` — no existing seam covered it before this change, so
 * the exported pure parser is the smallest new surface that makes it
 * testable without a live gateway or a DOM.
 */

import { describe, expect, it } from 'vitest';

import { parseAccountUsage } from '@/prototype/state/gateway-adapter';

describe('parseAccountUsage — REPORTED, with a real guard state', () => {
  it('reads every field straight off the response, never inventing one', () => {
    const result = parseAccountUsage({
      ok: true,
      provenance: 'REPORTED',
      level: 'nvidia-preferred',
      week: 94,
      nvidia_shift_at: 80,
      pause_at: 98,
      updated_at: '2026-07-26T13:41:16.136Z',
      age_ms: 12345,
      captured_at: '2026-07-26T13:41:28.481Z',
      guard: {
        available: true,
        mode: 'ok',
        pause_at: 98,
        resume_at: 0,
        paused_agent_count: null,
        last_check_at: '2026-07-26T13:41:16.137Z',
        age_ms: 12344,
        note: null,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.provenance).toBe('REPORTED');
    expect(result.level).toBe('nvidia-preferred');
    expect(result.week).toBe(94);
    expect(result.nvidiaShiftAt).toBe(80);
    expect(result.pauseAt).toBe(98);
    expect(result.ageMs).toBe(12345);
    expect(result.guard.available).toBe(true);
    expect(result.guard.mode).toBe('ok');
    expect(result.guard.pauseAt).toBe(98);
    expect(result.guard.pausedAgentCount).toBeNull();
  });

  it('reflects a real PAUSED guard state, including a real paused-agent count', () => {
    const result = parseAccountUsage({
      ok: true,
      provenance: 'REPORTED',
      level: 'nvidia-preferred',
      week: 99,
      nvidia_shift_at: 80,
      pause_at: 98,
      updated_at: '2026-07-26T13:41:16.136Z',
      age_ms: 500,
      captured_at: '2026-07-26T13:41:16.636Z',
      guard: {
        available: true,
        mode: 'paused',
        pause_at: 98,
        resume_at: 0,
        paused_agent_count: 3,
        last_check_at: '2026-07-26T13:41:16.137Z',
        age_ms: 499,
        note: null,
      },
    });

    expect(result.guard.mode).toBe('paused');
    expect(result.guard.pausedAgentCount).toBe(3);
  });
});

describe('parseAccountUsage — honest fallbacks', () => {
  it('NOT CONFIGURED: no pressure file — level/week/guard are all absent, never a guessed 0', () => {
    const result = parseAccountUsage({
      ok: true,
      provenance: 'NOT CONFIGURED',
      note: 'no FORGE_USAGE_PRESSURE.json found under the OS home .claude dir',
      captured_at: '2026-07-26T13:41:16.636Z',
      age_ms: 0,
      guard: { available: false, note: 'no FORGE_USAGE_GUARD_STATE.json found under the OS home .claude dir' },
    });

    expect(result.provenance).toBe('NOT CONFIGURED');
    expect(result.level).toBeNull();
    expect(result.week).toBeNull();
    expect(result.guard.available).toBe(false);
    expect(result.guard.note).toContain('no FORGE_USAGE_GUARD_STATE.json');
  });

  it('a missing "guard" key entirely resolves to the honest empty guard state, not a crash', () => {
    const result = parseAccountUsage({ ok: true, provenance: 'REPORTED', level: 'normal', week: 40 });

    expect(result.level).toBe('normal');
    expect(result.week).toBe(40);
    expect(result.guard.available).toBe(false);
    expect(result.guard.mode).toBeNull();
  });

  it('an empty object resolves to every field absent — never a fabricated default', () => {
    const result = parseAccountUsage({});

    expect(result.ok).toBe(false);
    expect(result.provenance).toBeNull();
    expect(result.level).toBeNull();
    expect(result.week).toBeNull();
    expect(result.guard.available).toBe(false);
  });
});
