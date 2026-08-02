/**
 * fix-status-honesty (2026-07-30) — MEASURED on the full-screenshot sweep after the owner said
 * "ik vind nog bugs in de ui": with STATUS_WHEN_UNKNOWN = 'waiting', all 23 project cards, all 19
 * idle roster agents and loose activity lines rendered a WAITING chip while the Home header honestly
 * said "Nothing is running right now" — a dashboard-wide false wait-claim. Unknown is the absence of
 * a status; it must render as the quiet IDLE and never as a fake queue position.
 */
import { describe, expect, it } from 'vitest';

import { STATUS_WHEN_UNKNOWN } from '@/prototype/state/adapter/shared';
import { STATUS_KEYS } from '@/prototype/types/prototype-types';
import { statusPresentation } from '@/components/primitives/status-presentation';

describe('status honesty — unknown is IDLE, never a fake WAITING', () => {
  it('the unknown fallback is idle, not waiting', () => {
    expect(STATUS_WHEN_UNKNOWN).toBe('idle');
    expect(STATUS_WHEN_UNKNOWN).not.toBe('waiting');
  });

  it('idle is a first-class status key with its own presentation (quietest treatment, honest wording)', () => {
    expect(STATUS_KEYS).toContain('idle');
    const p = statusPresentation('idle');
    expect(p.label).toBe('IDLE');
    expect(p.animated).toBe(false);
    // the description must describe absence, not a queue
    expect(p.description).toMatch(/nothing is running or recorded/i);
    expect(p.description).not.toMatch(/queued/i);
  });

  it('waiting keeps its real meaning (genuinely queued behind an earlier step)', () => {
    expect(statusPresentation('waiting').description).toMatch(/queued behind an earlier step/i);
  });
});
