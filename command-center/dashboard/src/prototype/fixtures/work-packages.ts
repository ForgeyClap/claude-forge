/**
 * Forge Workspace — example work packages.
 *
 * Seven packages cut from one example mission. Every `taskIds` entry exists in
 * `tasks.ts`; acceptance criteria are written so someone who was not present
 * could check them.
 */

import type { WorkPackage } from '@/prototype/types/prototype-types';

export const WORK_PACKAGES: readonly WorkPackage[] = [
  {
    prototype: true,
    id: 'wp-1',
    title: 'WP1 · Intake and reference sweep',
    goal: 'Understand what the shop actually needs before a single component is written, and learn from booking flows that already work rather than inventing one from taste.',
    status: 'completed',
    ownerAgentId: 'agent-search-boss',
    phase: 'intake',
    taskIds: ['task-01', 'task-02', 'task-03', 'task-04'],
    acceptance: [
      'Every intake question has an answer from the owner, not an assumption from an agent.',
      'At least ten booking flows reviewed, the majority of them on a phone-sized viewport.',
      'Each recommended pattern cites the flow it came from and the step it was observed at.',
      'The mission blueprint names an owner and an acceptance list for every work package.',
    ],
  },
  {
    prototype: true,
    id: 'wp-2',
    title: 'WP2 · Interface, type and responsive behaviour',
    goal: 'Make the page feel expensive without making it loud: one type scale, real spacing rhythm, and a booking step that reads clearly at 360px as well as 1440px.',
    status: 'running',
    ownerAgentId: 'agent-ui-boss',
    phase: 'build',
    taskIds: ['task-05', 'task-06', 'task-07', 'task-08', 'task-09', 'task-29'],
    acceptance: [
      'One type scale and one spacing grid across every section — no per-section exceptions.',
      'Layout holds at 360, 768 and 1440 with no horizontal scroll on the body.',
      'Every animation has a prefers-reduced-motion branch that fully disables it.',
      'Structured data validates, and no field is populated with an invented value.',
    ],
  },
  {
    prototype: true,
    id: 'wp-3',
    title: 'WP3 · Booking engine and integrations',
    goal: 'Build the part that has to be correct: slots that exist, slots that do not double-book, and a four-step form that survives a refresh and a back button.',
    status: 'running',
    ownerAgentId: 'agent-build-boss',
    phase: 'build',
    taskIds: ['task-10', 'task-11', 'task-12', 'task-13', 'task-14', 'task-15'],
    acceptance: [
      'A slot belongs to one barber and cannot be held by two bookings at once.',
      'Service duration and buffer time are modelled separately and both affect availability.',
      'Form state survives a page refresh; the back button steps backwards inside the flow.',
      'Typecheck, lint and build all pass locally, and the build hash is recorded for evidence matching.',
      'Payment and mail steps are reported as unfinished rather than stubbed and marked done.',
    ],
  },
  {
    prototype: true,
    id: 'wp-4',
    title: 'WP4 · Test suite and browser journeys',
    goal: 'Prove the flow works on a real viewport rather than in a screenshot, and describe any failure precisely enough that it can be fixed without a second investigation.',
    status: 'failed',
    ownerAgentId: 'agent-test-boss',
    phase: 'verify',
    taskIds: ['task-16', 'task-17', 'task-18', 'task-19'],
    acceptance: [
      'Slot engine unit tests cover the closing-time boundary, timezone drift and the daylight-saving jump.',
      'Desktop and mobile journeys both run landing to confirmation with no manual steps.',
      'Every failure ships with a trace and a named viewport, never the phrase "mobile is off".',
      'No serious accessibility violation remains open at the end of the package.',
    ],
  },
  {
    prototype: true,
    id: 'wp-5',
    title: 'WP5 · Security and permission review',
    goal: 'Check what was granted, what was written, and what a stranger could send to the booking endpoint — before the site is pointed at a real shop.',
    status: 'review',
    ownerAgentId: 'agent-security-boss',
    phase: 'review',
    taskIds: ['task-21', 'task-22', 'task-23'],
    acceptance: [
      'Secret scan runs across every tracked file and the result is quoted, not summarised.',
      'Each near-miss is either resolved or explained in the report with the offending line.',
      'Every agent that held write access this run is listed with the reason it was granted.',
      'All user-supplied fields are length-bounded and trimmed server-side.',
    ],
  },
  {
    prototype: true,
    id: 'wp-6',
    title: 'WP6 · Documentation and handoff',
    goal: 'Leave the owner able to run, change and hand off the project six weeks from now without asking anyone what the missing pieces were.',
    status: 'waiting',
    ownerAgentId: 'agent-docs-boss',
    phase: 'handoff',
    taskIds: ['task-24', 'task-25', 'task-26', 'task-30'],
    acceptance: [
      'Setup instructions work from a machine with nothing installed, in the order written.',
      'Unfinished work is named in the opening section, not buried under a closing note.',
      'Markdown lint passes on every generated document with no skipped heading levels.',
      'The handoff pack is only assembled after verification closes.',
    ],
  },
  {
    prototype: true,
    id: 'wp-7',
    title: 'WP7 · Repair loop: mobile evidence',
    goal: 'Close the gap the verify loop found — rebuild, recapture, re-run, and re-check — instead of arguing that the failure was environmental.',
    status: 'verify',
    ownerAgentId: 'agent-build-boss',
    phase: 'verify',
    taskIds: ['task-20', 'task-27', 'task-28'],
    acceptance: [
      'The capture is taken from a fresh production build, not a warm dev server.',
      'The build hash in the screenshot footer matches the hash the tests ran against.',
      'The mobile journey asserts the confirm button is visible and hit-testable, not merely present.',
      'The Verify Agent records an explicit accept or reject with the reason attached.',
    ],
  },
];
