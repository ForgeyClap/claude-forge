/**
 * Forge Workspace — example quality gates and the proof ledger.
 *
 * Twelve gates, one per check Forge runs before a mission may close, plus the
 * ledger the Verify Agent appends a line to for every completion claim.
 *
 * Every console block below is hand-written example text. No command was run,
 * no browser was driven, and no duration was measured.
 */

import type { ProofEntry, QualityGate } from '@/prototype/types/prototype-types';

export const QUALITY_GATES: readonly QualityGate[] = [
  {
    prototype: true,
    id: 'gate-typecheck',
    name: 'Typecheck',
    status: 'completed',
    duration: '11.4s',
    lastRun: '2026-07-24 14:49',
    evidenceCount: 2,
    output: `EXAMPLE OUTPUT — hand-written, nothing was executed.

$ npm run typecheck
> tsc --noEmit

Found 0 errors in 148 files.

Strict mode on. noUnusedLocals and noUnusedParameters both enabled, which is
why the availability refactor cost four extra minutes and zero later bugs.`,
  },
  {
    prototype: true,
    id: 'gate-lint',
    name: 'Lint',
    status: 'completed',
    duration: '6.8s',
    lastRun: '2026-07-24 14:50',
    evidenceCount: 1,
    output: `EXAMPLE OUTPUT — hand-written, nothing was executed.

$ npm run lint
> eslint .

/src/booking/BookingForm.tsx
  71:9  warning  Unused eslint-disable directive (no problems reported)

1 problem (0 errors, 1 warning)

Directive removed. Re-run clean: 0 problems.`,
  },
  {
    prototype: true,
    id: 'gate-build',
    name: 'Build',
    status: 'completed',
    duration: '18.2s',
    lastRun: '2026-07-24 14:51',
    evidenceCount: 3,
    output: `EXAMPLE OUTPUT — hand-written, nothing was executed.

$ npm run build
vite v7.1.12 building for production...

  dist/index.html                    2.14 kB │ gzip:  0.91 kB
  dist/assets/index-9f2d07c.css     28.60 kB │ gzip:  6.44 kB
  dist/assets/index-9f2d07c.js     186.41 kB │ gzip: 61.22 kB

built in 18.2s   hash 9f2d07c

This hash is the reference every screenshot footer is checked against for the
rest of the run.`,
  },
  {
    prototype: true,
    id: 'gate-unit',
    name: 'Unit tests',
    status: 'completed',
    duration: '4.1s',
    lastRun: '2026-07-24 13:36',
    evidenceCount: 3,
    output: `EXAMPLE OUTPUT — hand-written, nothing was executed.

$ npm run test

 PASS  src/booking/slots.test.ts        (41 tests)  812ms
 PASS  src/booking/pricing.test.ts      (18 tests)  204ms
 PASS  src/booking/validation.test.ts   (23 tests)  341ms

 Test Files  3 passed (3)
      Tests  82 passed (82)
   Duration  4.10s

The three that took longest are the boundary cases: closing time, timezone
drift, and the daylight-saving Sunday.`,
  },
  {
    prototype: true,
    id: 'gate-integration',
    name: 'Integration tests',
    status: 'blocked',
    duration: '—',
    lastRun: '2026-07-24 12:47',
    evidenceCount: 0,
    output: `EXAMPLE OUTPUT — hand-written, nothing was executed.

$ npm run test:integration

 SKIP  payment/checkout.int.test.ts   no test credentials configured
 SKIP  mail/confirmation.int.test.ts  no sender configured

 Test Files  0 passed | 2 skipped (2)

Gate reports BLOCKED rather than PASSED. Two skipped suites are not a green
board, and reporting them as one would be the single most expensive lie
available here.`,
  },
  {
    prototype: true,
    id: 'gate-playwright',
    name: 'Playwright',
    status: 'failed',
    duration: '1m 12s',
    lastRun: '2026-07-24 14:02',
    evidenceCount: 4,
    output: `EXAMPLE OUTPUT — hand-written, nothing was executed.

$ npx playwright test

  ✓  booking.desktop.spec.ts:14  full journey at 1440x900   (6.4s)
  ✘  booking.mobile.spec.ts:14   full journey at 390x844   (21.8s)

  1) booking.mobile.spec.ts:14 — full journey at 390x844

     TimeoutError: locator.click: Timeout 15000ms exceeded.
     Call log:
       - waiting for getByRole('button', { name: 'Confirm booking' })
       -   locator resolved to <button class="bk-confirm">Confirm booking</button>
       -   element is not visible — intercepted by <div class="bk-summary-bar">

     attachment  trace.zip
     attachment  playwright-mobile.png

  1 passed, 1 failed`,
  },
  {
    prototype: true,
    id: 'gate-screenshot',
    name: 'Screenshot review',
    status: 'verify',
    duration: '38s',
    lastRun: '2026-07-24 15:12',
    evidenceCount: 3,
    output: `EXAMPLE OUTPUT — hand-written, nothing was executed.

$ forge shots --review

  hero-desktop.png         1440x900   hash 9f2d07c   ACCEPTED
  playwright-desktop.png   1440x900   hash 9f2d07c   ACCEPTED
  playwright-mobile.png     390x844   hash 4c1e9ab   HELD

  1 held: build hash does not match the tested build (expected 9f2d07c).

A held capture is not a failed capture. It is a capture that cannot be used as
evidence for anything, which is worse.`,
  },
  {
    prototype: true,
    id: 'gate-accessibility',
    name: 'Accessibility',
    status: 'completed',
    duration: '9.7s',
    lastRun: '2026-07-24 15:16',
    evidenceCount: 2,
    output: `EXAMPLE OUTPUT — hand-written, nothing was executed.

$ npx axe ./dist --exit

  serious   0
  moderate  1   landmark-unique  (two <nav> landmarks share a label)
  minor     3

  Previously open and now closed:
    button-name        slot buttons announced only a time
    aria-live-region   step indicator changed silently

Keyboard pass done by hand. Focus order was wrong in a way no automated rule
caught: the grid rendered after the fold and was inserted above its trigger.`,
  },
  {
    prototype: true,
    id: 'gate-security',
    name: 'Security',
    status: 'review',
    duration: '27.3s',
    lastRun: '2026-07-24 13:44',
    evidenceCount: 2,
    output: `EXAMPLE OUTPUT — hand-written, nothing was executed.

$ forge doctor --secrets --permissions

  scanned      214 tracked files
  live secrets 0
  near-miss    1   docs/setup.md:22  sample key shape in documentation

  write access granted this run:
    Build Boss          justified by WP3
    UI Boss             justified by WP2
    Integration Boss    granted for a send step that never executed

  findings:
    MEDIUM  booking endpoint accepted an unbounded notes field  (fixed)

Awaiting Review Boss sign-off on the permission recommendation.`,
  },
  {
    prototype: true,
    id: 'gate-markdown',
    name: 'Markdown',
    status: 'completed',
    duration: '2.4s',
    lastRun: '2026-07-24 15:22',
    evidenceCount: 1,
    output: `EXAMPLE OUTPUT — hand-written, nothing was executed.

$ npx markdownlint docs artifacts

  docs/setup.md:41    MD001  heading levels should increment by one (h2 → h4)
  docs/handoff.md:12  MD001  heading levels should increment by one (h1 → h3)

  11 files checked, 2 with findings

Both corrected. Re-check: 11 files, 0 findings. Skipped heading levels read
fine to a person and badly to a screen reader, which is the whole reason this
gate exists.`,
  },
  {
    prototype: true,
    id: 'gate-verify-agent',
    name: 'Verify Agent',
    status: 'running',
    duration: '—',
    lastRun: '2026-07-24 15:39',
    evidenceCount: 22,
    output: `EXAMPLE OUTPUT — hand-written, nothing was executed.

$ forge verify --run run-oac-0841

  claims checked   22
  accepted         19
  rejected          3
  pending           1   (mobile screenshot re-check, in progress)

  rejected:
    task-18  screenshot shows the previous build (4c1e9ab vs 9f2d07c)
    task-24  test summary attached with the failing case filtered out
    task-13  cited an artifact that had not been written yet

The check is narrow on purpose: does the evidence show the claim, on the build
the claim refers to. Nothing else is assessed.`,
  },
  {
    prototype: true,
    id: 'gate-review-boss',
    name: 'Review Boss',
    status: 'review',
    duration: '4m 02s',
    lastRun: '2026-07-24 15:31',
    evidenceCount: 5,
    output: `EXAMPLE OUTPUT — hand-written, nothing was executed.

$ forge review --run run-oac-0841

  WP1  intake and reference sweep       APPROVED
  WP2  interface and responsive         APPROVED
  WP3  booking engine and integrations  CHANGES REQUESTED
  WP4  tests and browser journeys       REOPENED
  WP5  security and permission review   IN REVIEW
  WP6  documentation and handoff        NOT SUBMITTED

  reopened WP4:
    the completion summary stated the mobile journey passed while the run
    attached to it showed a failure. that gap is not a rounding error.`,
  },
];

export const PROOF_LEDGER: readonly ProofEntry[] = [
  {
    prototype: true,
    id: 'proof-14',
    timestamp: '2026-07-24 15:39:27',
    claim: 'Mobile screenshot evidence now matches the tested build',
    agent: 'Verify Agent',
    taskId: 'task-28',
    command: 'forge verify --artifact playwright-mobile.png --expect-hash 9f2d07c',
    artifact: 'playwright-mobile.png',
    verdict: 'pending',
    reason:
      'Re-check is open. The rebuild has not finished, so there is nothing new to compare and a verdict now would be a guess.',
  },
  {
    prototype: true,
    id: 'proof-13',
    timestamp: '2026-07-24 15:31:05',
    claim: 'Only justified agents held write access during this run',
    agent: 'Security Boss',
    taskId: 'task-22',
    command: 'forge doctor --permissions --run run-oac-0841',
    artifact: 'security-report.md',
    verdict: 'pending',
    reason:
      'Accurate as a list, but it contains a recommendation rather than a fact. Review Boss decides whether elevated permission for an unexecuted send step counts as justified.',
  },
  {
    prototype: true,
    id: 'proof-12',
    timestamp: '2026-07-24 15:22:48',
    claim: 'Every generated document passes markdown lint',
    agent: 'Docs Boss',
    taskId: 'task-25',
    command: 'npx markdownlint docs artifacts',
    artifact: 'markdown-lint.log',
    verdict: 'accepted',
    reason:
      'Log shows two findings, both fixed, and a clean re-check across all eleven documents. The failing first pass was included rather than hidden.',
  },
  {
    prototype: true,
    id: 'proof-11',
    timestamp: '2026-07-24 15:16:02',
    claim: 'No serious accessibility violations remain open',
    agent: 'Test Boss',
    taskId: 'task-19',
    command: 'npx axe ./dist --exit',
    artifact: 'accessibility-report.md',
    verdict: 'accepted',
    reason:
      'Serious count is zero and both previously open rules are named with the fix. The remaining moderate finding is listed, not rounded away.',
  },
  {
    prototype: true,
    id: 'proof-10',
    timestamp: '2026-07-24 15:12:36',
    claim: 'Desktop confirmation step renders correctly at 1440 x 900',
    agent: 'UI Boss',
    taskId: 'task-08',
    command: 'npx playwright test booking.desktop.spec.ts --update-snapshots',
    artifact: 'playwright-desktop.png',
    verdict: 'accepted',
    reason:
      'Footer hash 9f2d07c matches the build the journey ran against, and the capture shows the step the claim describes.',
  },
  {
    prototype: true,
    id: 'proof-09',
    timestamp: '2026-07-24 15:08:14',
    claim: 'Desktop booking journey passes end to end',
    agent: 'Test Boss',
    taskId: 'task-17',
    command: 'npx playwright test booking.desktop.spec.ts --project=chromium',
    artifact: 'playwright-desktop.png',
    verdict: 'accepted',
    reason:
      'Eleven steps, 6.4s, trace attached. Re-run after the form state fix, so the pass describes the current code rather than an older one.',
  },
  {
    prototype: true,
    id: 'proof-08',
    timestamp: '2026-07-24 14:57:40',
    claim: 'Setup instructions work from a clean machine',
    agent: 'Docs Boss',
    taskId: 'task-24',
    command: 'forge report --section setup --check-order',
    artifact: 'final-report.md',
    verdict: 'rejected',
    reason:
      'The first submission attached a test summary with the failing integration suites filtered out of the output. Evidence that removes the inconvenient lines is not evidence.',
  },
  {
    prototype: true,
    id: 'proof-07',
    timestamp: '2026-07-24 14:51:07',
    claim: 'Typecheck, lint and build are all clean',
    agent: 'Build Boss',
    taskId: 'task-15',
    command: 'npm run typecheck && npm run lint && npm run build',
    artifact: 'build-receipt.txt',
    verdict: 'accepted',
    reason:
      'Three commands, three clean exits, and a receipt carrying the resulting build hash. That hash is what made the next rejection possible.',
  },
  {
    prototype: true,
    id: 'proof-06',
    timestamp: '2026-07-24 14:07:55',
    claim: 'Mobile booking step is complete',
    agent: 'Build Boss',
    taskId: 'task-18',
    command: 'npx playwright test booking.mobile.spec.ts --project=mobile-safari',
    artifact: 'playwright-mobile.png',
    verdict: 'rejected',
    reason:
      'The screenshot shows the previous build — its footer reads 4c1e9ab while the journey ran against 9f2d07c. The implementation was not examined, because the evidence could not support any claim about it.',
  },
  {
    prototype: true,
    id: 'proof-05',
    timestamp: '2026-07-24 13:44:09',
    claim: 'No live credentials exist in the working tree',
    agent: 'Security Boss',
    taskId: 'task-21',
    command: 'forge doctor --secrets',
    artifact: 'security-report.md',
    verdict: 'accepted',
    reason:
      '214 files scanned, zero live secrets, and the single near-miss is quoted in full with the line number rather than declared harmless.',
  },
  {
    prototype: true,
    id: 'proof-04',
    timestamp: '2026-07-24 13:36:41',
    claim: 'Slot engine handles every boundary case',
    agent: 'Test Boss',
    taskId: 'task-16',
    command: 'npm run test -- src/booking/slots.test.ts',
    artifact: 'slot-engine-coverage.log',
    verdict: 'accepted',
    reason:
      'Forty-one passing cases including closing time, timezone drift and the daylight-saving Sunday. Uncovered lines are listed rather than omitted from the report.',
  },
  {
    prototype: true,
    id: 'proof-03',
    timestamp: '2026-07-24 12:47:03',
    claim: 'Deposit payment integration is implemented',
    agent: 'Payment Integration',
    taskId: 'task-13',
    command: 'npm run test:integration -- payment/checkout.int.test.ts',
    artifact: null,
    verdict: 'rejected',
    reason:
      'The cited artifact does not exist and the suite was skipped for missing credentials. Code that has never once been executed is written, not implemented.',
  },
  {
    prototype: true,
    id: 'proof-02',
    timestamp: '2026-07-24 11:14:52',
    claim: 'Data model prevents double-booking',
    agent: 'Build Boss',
    taskId: 'task-10',
    command: 'npm run test -- src/booking/slots.test.ts -t "double book"',
    artifact: 'booking-flow.svg',
    verdict: 'accepted',
    reason:
      'A slot is owned by a barber and guarded by a unique constraint. The test that proves it fails correctly when the constraint is removed, which is the part that matters.',
  },
  {
    prototype: true,
    id: 'proof-01',
    timestamp: '2026-07-24 09:31:48',
    claim: 'Twelve booking flows reviewed, nine on mobile',
    agent: 'Search Boss',
    taskId: 'task-02',
    command: 'forge research --sources 12 --record-steps',
    artifact: 'competitor-scan.md',
    verdict: 'accepted',
    reason:
      'Each flow is listed with the step it lost the visitor at, and what could not be found is stated as clearly as what could.',
  },
];
