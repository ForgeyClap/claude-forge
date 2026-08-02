/**
 * cc-fix-adapter (fix round, WP-A) — the anti-fabrication regression gate this fix round's own
 * definition-of-done requires: for a raw gateway payload MISSING a field, every mapper below must
 * emit `null`/`undefined`/an honest empty value — NEVER a plausible-looking default (e.g. `0`,
 * `''` read as "measured zero", a guessed enum member, or a fabricated placeholder string). This
 * is the regression gate that stops a future edit from quietly reintroducing exactly the invented
 * scalars this fix round removed from `gateway-adapter.ts` (`ProjectsView`/`AgentsView`/etc audit,
 * see this file's own header for the full list).
 *
 * No network, no React, no timers — pure-function tests against representative gateway response
 * shapes, mirroring `account-usage.test.ts`'s own precedent for this seam.
 */

import { describe, expect, it } from 'vitest';

import {
  buildAgentProgressMap,
  buildAgentVerificationMap,
  buildGatewayRuns,
  EMPTY_ACTIVE_PROJECT_DETAIL,
  EMPTY_PROJECT_PROFILE,
  formatDurationMs,
  hasMeasuredProjectDetail,
  parseDoctorHealth,
  parseProjectProfile,
  resolveAgentVerification,
  toGatewayAgent,
  toGatewayArtifact,
  toGatewayGate,
  toGatewayProject,
  toGatewayTask,
  type ActiveProjectDetail,
  type MissionPayload,
} from '@/prototype/state/gateway-adapter';

// A minimal internal parser is not exported (agents/runs are parsed via the module-internal
// `parseAgentRows`/`parseRunRows` inside `useGatewayProjectAgents`/`useGatewayProjectRuns`), so
// these tests build the row shapes those parsers would have produced directly — the mapper
// functions under test (`toGatewayAgent`, `toGatewayProject`, etc.) are the real regression
// surface: they are what a future edit is most likely to touch again.

function baseAgentRow(overrides: Partial<Parameters<typeof toGatewayAgent>[0]> = {}): Parameters<typeof toGatewayAgent>[0] {
  return {
    slug: 'build-boss',
    name: 'build-boss',
    description: null,
    modelTier: null,
    claudeEffort: null,
    nvidiaRole: null,
    isPermanentBoss: true,
    role: null,
    tools: [],
    agentClass: null,
    nvidiaFallback: null,
    premium: null,
    usagePolicyBucket: null,
    memory: null,
    responsibilities: null,
    skills: [],
    ...overrides,
  };
}

describe('toGatewayAgent — never a fabricated skill list, verification, or progress', () => {
  it('a missing skills[]/class on the row yields an empty skills array and the safe "standard" permission — never a guessed skill or a lie', () => {
    const agent = toGatewayAgent(baseAgentRow(), 'waiting', null, 'not-required', 0);
    expect(agent.skills).toEqual([]);
    expect(agent.permission).toBe('standard');
    expect(agent.verification).toBe('not-required');
    expect(agent.progress).toBe(0);
  });

  it('a real skills[] and a real class flow straight through, unmodified', () => {
    const agent = toGatewayAgent(
      baseAgentRow({ skills: ['test-driven-development', 'systematic-debugging'], agentClass: 'full-build' }),
      'running',
      'wp3',
      'verified',
      67,
    );
    expect(agent.skills).toEqual(['test-driven-development', 'systematic-debugging']);
    expect(agent.permission).toBe('elevated');
    expect(agent.verification).toBe('verified');
    expect(agent.progress).toBe(67);
  });

  it('class "read-only-audit" maps to the real "read-only" permission tier, not the old boss-only "lead"', () => {
    const agent = toGatewayAgent(baseAgentRow({ agentClass: 'read-only-audit', isPermanentBoss: true }), 'waiting', null, 'not-required', 0);
    expect(agent.permission).toBe('read-only');
  });
});

describe('buildAgentVerificationMap — real per-agent verdicts, never a blanket default', () => {
  const mission = (verdicts: MissionPayload['verdicts']): MissionPayload => ({
    runId: 'run-1',
    wps: [],
    tasks: [],
    orphanCompletions: [],
    verdicts,
  });

  // fix-cert-rest (item 2): the caller now applies an honest `null` (no verification evidence
  // exists), never the previous blanket `'not-required'` — see `resolveAgentVerification` below.
  it('a mission with no verdicts at all yields an empty map (caller applies the honest null fallback)', () => {
    expect(buildAgentVerificationMap(null).size).toBe(0);
    expect(buildAgentVerificationMap(mission([])).size).toBe(0);
  });

  it('a real check_passed for an agent maps to verified', () => {
    const map = buildAgentVerificationMap(mission([{ eventType: 'check_passed', agent: 'build-boss' }]));
    expect(map.get('build-boss')).toBe('verified');
  });

  it('a check_failed always wins over an earlier check_passed for the same agent — the worse real outcome is reported', () => {
    const map = buildAgentVerificationMap(
      mission([
        { eventType: 'check_passed', agent: 'build-boss' },
        { eventType: 'check_failed', agent: 'build-boss' },
      ]),
    );
    expect(map.get('build-boss')).toBe('rejected');
  });

  it('a verdict with no agent field is skipped, never attributed to a guessed agent', () => {
    const map = buildAgentVerificationMap(mission([{ eventType: 'check_passed', agent: null }]));
    expect(map.size).toBe(0);
  });
});

describe('resolveAgentVerification — an honest null, never the old blanket "not-required" (fix-cert-rest, item 2)', () => {
  it('an agent with no entry in the verification map resolves to null, not "not-required"', () => {
    const map = buildAgentVerificationMap(null);
    expect(resolveAgentVerification(map, 'build-boss')).toBe(null);
  });

  it('an agent with a real verdict resolves to that real verification, unchanged', () => {
    const map = buildAgentVerificationMap({
      runId: 'run-1',
      wps: [],
      tasks: [],
      orphanCompletions: [],
      verdicts: [{ eventType: 'check_passed', agent: 'build-boss' }],
    });
    expect(resolveAgentVerification(map, 'build-boss')).toBe('verified');
    // A different agent with no verdict in the SAME map still resolves to the honest null.
    expect(resolveAgentVerification(map, 'other-agent')).toBe(null);
  });
});

describe('buildAgentProgressMap — a real completed/total ratio, never a constant', () => {
  function taskRow(agent: string, status: string): MissionPayload['tasks'][number] {
    return {
      role: null,
      agent,
      dispatchId: null,
      wpGuess: null,
      wpGuessConfidence: null,
      task: null,
      startedAt: null,
      completedAt: null,
      status,
      notes: [],
      // Z1 pairing-ambiguity fields — an unambiguous row, so the honest not-ambiguous defaults.
      pairingAmbiguous: false,
      pairingAmbiguityReason: null,
      declinedCompletions: null,
      unmatchedReason: null,
    };
  }

  it('no mission yields an empty map', () => {
    expect(buildAgentProgressMap(null).size).toBe(0);
  });

  it('2 of 4 real tasks completed for an agent yields a real 50, not a guess', () => {
    const mission: MissionPayload = {
      runId: 'run-1',
      wps: [],
      tasks: [taskRow('build-boss', 'completed'), taskRow('build-boss', 'completed'), taskRow('build-boss', 'running'), taskRow('build-boss', 'failed')],
      orphanCompletions: [],
      verdicts: [],
    };
    expect(buildAgentProgressMap(mission).get('build-boss')).toBe(50);
  });
});

describe('toGatewayTask progress — a real status-derived signal, never a constant 0', () => {
  function taskRow(status: string): Parameters<typeof toGatewayTask>[0] {
    return { role: null, agent: null, dispatchId: 't1', wpGuess: null, wpGuessConfidence: null, task: null, startedAt: null, completedAt: null, status, notes: [], pairingAmbiguous: false, pairingAmbiguityReason: null, declinedCompletions: null, unmatchedReason: null };
  }

  it('a completed task reports the real 100, not the old constant 0', () => {
    expect(toGatewayTask(taskRow('completed'), 0).progress).toBe(100);
  });

  it('a running/waiting/failed task honestly reports 0 (no fractional signal exists — never a guess)', () => {
    expect(toGatewayTask(taskRow('running'), 0).progress).toBe(0);
    expect(toGatewayTask(taskRow('failed'), 0).progress).toBe(0);
  });
});

describe('toGatewayArtifact size — a real byte count formatted, or honest absence', () => {
  it('a missing size_bytes yields an empty string, never a fabricated "0 B"', () => {
    expect(toGatewayArtifact({ id: 'a1', source: 'run-artifacts-dir' }, 0).size).toBe('');
  });

  it('a real size_bytes is formatted through the shared formatFileBytes helper', () => {
    expect(toGatewayArtifact({ id: 'a1', source: 'run-artifacts-dir', size_bytes: 2048 }, 0).size).toBe('2.0 KB');
  });
});

// cc-fix-artifacts-empty: an artifact from `buildProofAll`'s new `?run=all` aggregate carries a
// real `run_id` alongside the pre-existing `source` — this is the label that stops several runs'
// worth of artifacts from all reading as "the current run" once they are shown together.
describe('toGatewayArtifact producedBy — carries the real run label an aggregated artifact came from', () => {
  it('an artifact from an OLDER run than the one currently selected still comes through, labelled with its own real run id', () => {
    const olderRunArtifact = toGatewayArtifact(
      { id: 'wp0-audit-reports', source: 'forge-artifacts-index', run_id: 'forge-2026-07-25-full-audit' },
      0,
    );
    expect(olderRunArtifact.producedBy).toBe('forge-2026-07-25-full-audit');
  });

  it('a run_id of null (no run in the considered window references this artifact) falls back to the honest source label, never a fabricated run', () => {
    const unresolvedArtifact = toGatewayArtifact({ id: 'art-mc-report', source: 'forge-artifacts-index', run_id: null }, 0);
    expect(unresolvedArtifact.producedBy).toBe('forge-artifacts-index');
  });

  it('a row with no run_id field at all (the original single-run /api/proof path, untouched by this fix) keeps its prior source-only label', () => {
    const singleRunArtifact = toGatewayArtifact({ id: 'a1', source: 'run-artifacts-dir' }, 0);
    expect(singleRunArtifact.producedBy).toBe('run-artifacts-dir');
  });
});

describe('toGatewayGate output — the real event output/evidence field, never a fabricated placeholder', () => {
  it('an event verdict with neither output nor evidence yields an empty string', () => {
    const gate = toGatewayGate({ source: 'event', event_type: 'check_passed', command: 'npm test' }, 0);
    expect(gate.output).toBe('');
    expect(gate.duration).toBe('');
  });

  it('a real output field flows straight through', () => {
    const gate = toGatewayGate({ source: 'event', event_type: 'check_passed', output: '227/227 passing' }, 0);
    expect(gate.output).toBe('227/227 passing');
  });

  it('evidence is used only when output itself is absent', () => {
    const gate = toGatewayGate({ source: 'event', event_type: 'check_passed', evidence: 'doctor 94/4383/0' }, 0);
    expect(gate.output).toBe('doctor 94/4383/0');
  });
});

describe('parseDoctorHealth — real doctor.json numbers via /api/proof, or honest absence', () => {
  // recertify follow-up (Lead): both assertions below used to expect `score: 0`, while the first
  // one's own name promises "never a guessed score". A 0 IS a guessed score — it is the worst
  // possible health, rendered for a project whose health was never measured. The consumer at
  // `gateway-adapter.ts` never read the `present` flag, so that 0 reached the screen as
  // "Health 0%" for the ACTIVE project whenever no doctor verdict existed (the ordinary state
  // until a run with one is selected).
  //
  // This is the THIRD time in this run that an anti-fabrication test was found asserting the
  // fabrication rather than blocking it (see this file's own taskCount/score correction, and the
  // ProjectsView case). The pattern is worth naming: a test written from the implementation
  // inherits the implementation's assumptions, and its green tick then protects the defect. Assert
  // the CONTRACT — "an unmeasured value is absent" — not the value the code happens to return.
  it('no proof payload at all yields the empty summary, never a guessed score', () => {
    expect(parseDoctorHealth(null)).toEqual({ present: false, passed: 0, failed: 0, score: null });
  });

  it('a proof payload with no doctor-sourced verdict yields the empty summary', () => {
    expect(parseDoctorHealth({ verdicts: [{ source: 'event', event_type: 'check_passed' }] })).toEqual({
      present: false,
      passed: 0,
      failed: 0,
      score: null,
    });
  });

  it('a real doctor verdict with zero suites is a measured 0, not an absence', () => {
    // The distinction the null is for: this project HAS a doctor verdict, it just ran nothing.
    // That 0 is a measurement and must survive as a number.
    const result = parseDoctorHealth({ verdicts: [{ source: 'doctor', passed: 0, failed: 0 }] });
    expect(result.present).toBe(true);
    expect(result.score).toBe(0);
  });

  it('a real doctor verdict yields a real computed pass-rate score', () => {
    const result = parseDoctorHealth({ verdicts: [{ source: 'doctor', ok: true, suites: 94, passed: 4383, failed: 17 }] });
    expect(result.present).toBe(true);
    expect(result.passed).toBe(4383);
    expect(result.failed).toBe(17);
    expect(result.score).toBe(Math.round((4383 / (4383 + 17)) * 100));
  });
});

describe('toGatewayProject — real detail only for the active project, honest empty otherwise', () => {
  /**
   * cc-finish fix-cert-fabrication (F3) — UPDATED by fix-cert-rest (item 3): the OLD version of
   * this test asserted `taskCount`/`health.score` stayed `0` for `EMPTY_ACTIVE_PROJECT_DETAIL` and
   * stopped there, titled as if that were the whole, correct story ("stay a real, documented 0").
   * It was not: a bare `0` is exactly what a genuinely-measured empty project would ALSO produce —
   * that old assertion could never tell a fabricated zero from a real one, and the reviewer's
   * actual finding was that `ProjectsView.tsx` took this `0` at face value and rendered/sorted it
   * as a real "Health 0%" for every non-active project. `Project.taskCount` / `ProjectHealth.score`
   * are now WIDENED to `number | null` (the tracked follow-up this comment used to defer), so this
   * placeholder now emits a real, typed `null` directly — the assertions below check `null`, not
   * `0`, which is the actual fix, not a "repair back to the raw 0" this comment used to forbid.
   * `agentCount`/`missionCount` still stay a shared, non-nullable `number` (widening THEM is real,
   * tracked, OUT-OF-SCOPE follow-up work — see this fix round's own handoff notes), so
   * `hasMeasuredProjectDetail` remains the regression gate for those two, asserted below.
   */
  it('EMPTY_ACTIVE_PROJECT_DETAIL is a real, typed null — AND agentCount/missionCount are correctly flagged as UNMEASURED', () => {
    // fix-ui-clutter (item 6): `dirMtimeMs: null` is the honest "no real recency signal yet"
    // reading a `ProjectRow` literal in a test must now supply explicitly.
    const project = toGatewayProject({ name: 'p1', path: '/p1', hasDashboard: true, dirMtimeMs: null }, 'waiting', 0, 0, 0, EMPTY_ACTIVE_PROJECT_DETAIL);
    expect(project.taskCount).toBe(null);
    // fix-ui-clutter (item 6): `testsMeasured: false` is `EMPTY_ACTIVE_PROJECT_DETAIL`'s own real
    // value — no doctor verdict exists for a project this workspace has not measured.
    expect(project.health).toEqual({ tests: { passed: 0, failed: 0, skipped: 0 }, openTickets: 0, blockers: 0, score: null, testsMeasured: false });
    expect(project.description).toBe('');
    expect(project.templateVersion).toBe('');
    expect(project.lastActivity).toBe('');
    // agentCount/missionCount are NOT independently nullable — the actual honesty gate for THEM:
    // 'p1' is not the active project ('some-other-active-project'), so its 0s are unmeasured — a
    // consumer must show '—', never treat this as a measured zero.
    expect(hasMeasuredProjectDetail(project, 'some-other-active-project')).toBe(false);
  });

  it('a real ActiveProjectDetail flows straight through for the active project, and hasMeasuredProjectDetail confirms it', () => {
    const detail: ActiveProjectDetail = {
      taskCount: 12,
      tests: { passed: 100, failed: 2, skipped: 0 },
      score: 98,
      description: 'Develop and maintain the Forge system.',
      templateVersion: '66a10b6aec4c',
      lastActivity: '2026-07-28T09:00:00.000Z',
      // fix-ui-clutter (item 6): a real doctor verdict backs these counts in this fixture.
      testsMeasured: true,
    };
    const project = toGatewayProject({ name: 'p1', path: '/p1', hasDashboard: true, dirMtimeMs: null }, 'completed', 3, 5, 2, detail);
    expect(project.taskCount).toBe(12);
    expect(project.health.tests).toEqual({ passed: 100, failed: 2, skipped: 0 });
    expect(project.health.score).toBe(98);
    expect(project.description).toBe('Develop and maintain the Forge system.');
    expect(project.templateVersion).toBe('66a10b6aec4c');
    expect(project.lastActivity).toBe('2026-07-28T09:00:00.000Z');
    // 'p1' IS the active project here, so its real detail is correctly flagged as measured.
    expect(hasMeasuredProjectDetail(project, 'p1')).toBe(true);
  });

  it('hasMeasuredProjectDetail treats a fixture/prototype record as always measured, regardless of activeProjectId', () => {
    // Every fixture row (fixtures/projects.ts) carries a genuine per-field example value for every
    // project, not just the "active" one in demo mode — a fixture record must never be shown as
    // unmeasured just because it is not the currently-active project.
    const prototypeProject = { id: 'proj-fixture', prototype: true } as const;
    expect(hasMeasuredProjectDetail(prototypeProject, 'some-other-project')).toBe(true);
  });
});

describe('buildGatewayRuns — ALL real runs mapped, not just the newest', () => {
  it('maps every run row, giving mission-derived detail only to the current run', () => {
    const runRows = [
      { runId: 'run-newest', hasFinalReport: true, eventCount: 10, mtime: '2026-07-28T10:00:00.000Z', durationMs: 60000, durationSource: 'derived-from-events', eventScanError: null },
      { runId: 'run-older', hasFinalReport: true, eventCount: 4, mtime: '2026-07-27T10:00:00.000Z', durationMs: null, durationSource: null, eventScanError: null },
    ];
    const mission: MissionPayload = {
      runId: 'run-newest',
      wps: [{ id: 'WP1', note: null, agent: null }],
      tasks: [],
      orphanCompletions: [],
      verdicts: [],
    };
    const runs = buildGatewayRuns(runRows, 'proj-1', 'run-newest', mission, ['build-boss'], 'Fix the adapter');

    expect(runs).toHaveLength(2);
    const newest = runs.find((r) => r.id === 'run-newest')!;
    const older = runs.find((r) => r.id === 'run-older')!;

    expect(newest.goal).toBe('Fix the adapter');
    expect(newest.agentIds).toEqual(['build-boss']);
    expect(newest.workPackageIds).toEqual(['WP1']);
    // cc-fix-events-honesty (P1-6): a 'derived-from-events' duration now carries an honest
    // qualifier so it never renders identically to a real 'run-completed-event' measurement.
    expect(newest.duration).toBe('1m 0s (from events)');

    // The older run genuinely had no mission fetched for it — never fabricated as if it had.
    expect(older.goal).toBe('');
    expect(older.agentIds).toEqual([]);
    expect(older.workPackageIds).toEqual([]);
    expect(older.duration).toBe('');
    // Status still derives from THIS run's own real hasFinalReport, even with mission:null.
    expect(older.status).toBe('completed');
  });
});

describe('formatDurationMs — a real value formatted, or honest absence', () => {
  it('null never renders as a fabricated "0s"', () => {
    expect(formatDurationMs(null)).toBe('');
  });

  it('a real duration is formatted', () => {
    expect(formatDurationMs(5000)).toBe('5s');
    expect(formatDurationMs(65000)).toBe('1m 5s');
    expect(formatDurationMs(3_665_000)).toBe('1h 1m');
  });
});

describe('parseProjectProfile — real profile fields, or honest absence (never forced into ProjectType)', () => {
  it('an empty object resolves to the module constant shape', () => {
    expect(parseProjectProfile({})).toEqual(EMPTY_PROJECT_PROFILE);
  });

  it('reads real fields straight off the response, keeping the free-text type raw rather than guessing a bucket', () => {
    const result = parseProjectProfile({
      ok: true,
      profile_present: true,
      project_name: 'Forge V2 Hybrid Installer',
      project_type_raw: 'tooling / meta — this project *is* the Forge V2 system. Mixed.',
      project_goal: 'Develop and maintain the universal hybrid Forge V2 system.',
      maturity: 'mature / actively developed.',
      version_present: true,
      forge_version: '66a10b6aec4c',
      synced_at: '2026-07-13T12:10:08.055Z',
    });
    expect(result.profilePresent).toBe(true);
    expect(result.projectTypeRaw).toContain('tooling / meta');
    expect(result.forgeVersion).toBe('66a10b6aec4c');
  });
});
