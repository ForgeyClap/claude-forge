/**
 * cc-wire-usage handoff-fix regression gate — the two type-honesty defects
 * this round's Head Chef task named:
 *
 *   (a) `ProjectType` was a closed 8-value union forcing every project to be
 *       labelled `'full-stack'` — a fabricated measurement. Now widened with
 *       `'unknown'`; `classifyProjectType` maps real classification -> real
 *       type and everything else -> 'unknown', never a keyword guess.
 *   (b) `wp_guess_confidence` was parsed off the gateway payload and then
 *       silently dropped at `toGatewayTask`. Now it survives onto `Task`.
 *
 * No network, no React, no timers — mirrors `gateway-adapter-antifabrication.test.ts`'s
 * own precedent for this seam.
 */

import { describe, expect, it } from 'vitest';

import { classifyProjectType, toGatewayProject, toGatewayTask } from '@/prototype/state/gateway-adapter';
import { EMPTY_ACTIVE_PROJECT_DETAIL } from '@/prototype/state/gateway-adapter';
import type { ActiveProjectDetail } from '@/prototype/state/gateway-adapter';

/* ========================================================================== */
/*  classifyProjectType — real classification only, never a keyword guess    */
/* ========================================================================== */

describe('classifyProjectType — an exact match is real, everything else is honestly unknown', () => {
  it('an exact, known type word classifies for real', () => {
    expect(classifyProjectType('website')).toBe('website');
    expect(classifyProjectType('automation')).toBe('automation');
  });

  it('is case/whitespace tolerant for an otherwise exact match', () => {
    expect(classifyProjectType('  Chatbot  ')).toBe('chatbot');
  });

  it('a compound/free-text description is honestly unknown — never a keyword guess', () => {
    // This project's own real profile shape, verbatim from gateway-adapter.ts's header.
    expect(classifyProjectType('tooling / meta — ... Mixed.')).toBe('unknown');
    expect(classifyProjectType('a website with automation and a chatbot')).toBe('unknown');
  });

  it('no profile at all is honestly unknown, never a fabricated default', () => {
    expect(classifyProjectType(null)).toBe('unknown');
  });

  it('never returns the old hardcoded "full-stack" default for an unclassifiable string', () => {
    expect(classifyProjectType('something else entirely')).not.toBe('full-stack');
    expect(classifyProjectType('something else entirely')).toBe('unknown');
  });
});

describe('toGatewayProject — the real classified type flows through; the pre-existing 6-arg calls stay honest', () => {
  it('a real classified type is used when passed', () => {
    const project = toGatewayProject(
      { name: 'p1', path: '/p1', hasDashboard: true, dirMtimeMs: null },
      'waiting',
      0,
      0,
      0,
      EMPTY_ACTIVE_PROJECT_DETAIL,
      'website',
    );
    expect(project.type).toBe('website');
  });

  it('omitting the new parameter (the pre-existing test-suite call shape) defaults to "unknown", never a guess', () => {
    const detail: ActiveProjectDetail = { ...EMPTY_ACTIVE_PROJECT_DETAIL };
    const project = toGatewayProject({ name: 'p1', path: '/p1', hasDashboard: true, dirMtimeMs: null }, 'completed', 3, 5, 2, detail);
    expect(project.type).toBe('unknown');
  });
});

/* ========================================================================== */
/*  toGatewayTask.wpGuessConfidence — survives the mapping, explicitly       */
/* ========================================================================== */

describe('toGatewayTask — wp_guess_confidence survives onto Task, never silently dropped', () => {
  function taskRow(overrides: Partial<Parameters<typeof toGatewayTask>[0]> = {}): Parameters<typeof toGatewayTask>[0] {
    return {
      role: null,
      agent: null,
      dispatchId: 't1',
      wpGuess: 'wp3',
      wpGuessConfidence: null,
      task: null,
      startedAt: null,
      completedAt: null,
      status: 'completed',
      notes: [],
      // Z1 pairing-ambiguity fields — an unambiguous row, so the honest not-ambiguous defaults.
      pairingAmbiguous: false,
      pairingAmbiguityReason: null,
      declinedCompletions: null,
      unmatchedReason: null,
      ...overrides,
    };
  }

  it('a real confidence value flows straight through', () => {
    const task = toGatewayTask(taskRow({ wpGuessConfidence: 'explicit' }), 0);
    expect(task.wpGuessConfidence).toBe('explicit');
  });

  it('a missing confidence is honestly null, never a fabricated default', () => {
    const task = toGatewayTask(taskRow({ wpGuessConfidence: null }), 0);
    expect(task.wpGuessConfidence).toBeNull();
  });
});
