/**
 * Forge Workspace — example artifacts.
 *
 * Seventeen artifacts from the barbershop booking mission. Markdown documents
 * carry a real multi-paragraph preview; screenshots carry a written caption
 * describing what the frame would show.
 *
 * Nothing here was produced by a tool. No file was written, no browser was
 * driven, and no image exists behind the screenshot records.
 */

import type { Artifact } from '@/prototype/types/prototype-types';

export const ARTIFACTS: readonly Artifact[] = [
  {
    prototype: true,
    id: 'art-mission-blueprint',
    name: 'mission-blueprint.md',
    kind: 'markdown',
    producedBy: 'Head Chef',
    taskId: 'task-04',
    createdAt: '2026-07-24 10:22',
    size: '14.2 KB',
    preview: `# Mission blueprint — barbershop booking site

The request was one sentence: build a premium booking website for a barbershop. Everything below
is downstream of six intake answers, not of taste. "Premium" was defined by the shop as *calm,
fast and obviously trustworthy* — not as decoration.

## Shape of the build

A single-page site with a four-step booking flow: service, time, details, confirm. Availability is
shown before anything is asked of the visitor. No account, no redirect, no modal that hides the
price. Three barbers, seven services, a 20% deposit, closed Sundays.

## Work packages

Seven packages, six of which run in parallel after the plan lands. WP7 does not exist yet at
planning time — it is reserved for whatever the verify loop sends back, and it was used.

- **WP1** intake and reference sweep — Search Boss
- **WP2** interface, type and responsive behaviour — UI Boss
- **WP3** booking engine and integrations — Build Boss
- **WP4** test suite and browser journeys — Test Boss
- **WP5** security and permission review — Security Boss
- **WP6** documentation and handoff — Docs Boss

## Deliberate exclusions

Payment sits off the critical path. If the deposit integration stalls — and it did, on missing test
credentials — the booking flow still reaches a confirmed state and the shop can take the deposit in
the chair. A mission that cannot finish because of one unavailable key was planned badly.

## Definition of done

Every package closes on evidence, not on a report. A screenshot counts only when the build hash in
its footer matches the build the tests ran against, which is the check that reopened this mission.`,
  },
  {
    prototype: true,
    id: 'art-task-plan',
    name: 'task-plan.md',
    kind: 'markdown',
    producedBy: 'Head Chef',
    taskId: 'task-04',
    createdAt: '2026-07-24 10:23',
    size: '21.7 KB',
    preview: `# Task plan

Thirty tasks across seven work packages. The plan is written in dependency order rather than in
priority order, because priority is an opinion and a dependency is a fact.

## Critical path

Intake, reference sweep, data model, availability calculator, booking form, local checks, browser
journeys, verification. Eight tasks. Everything else — motion, structured data, the desktop shell,
the reusable skill — hangs off the side and can slip a day without moving the finish line.

## Parallelism

Six lanes start together at 10:24. Lane order was chosen so that no agent's *first* task depends on
another lane's output: Search Boss reports before Build Boss needs the patterns, UI Boss settles the
type scale before it needs the data model, Docs Boss starts on setup notes rather than the summary.

## Repair budget

Two repair attempts per task before the mission escalates to the owner instead of retrying. The
mobile capture used both of them. That budget exists so a failing lane cannot quietly loop while the
rest of the board looks healthy.

## Handoff ordering

The handoff pack is the last task in the plan and depends on the verification re-check. Writing it
earlier would guarantee rewriting it, and the first version would already have been sent.`,
  },
  {
    prototype: true,
    id: 'art-intake-answers',
    name: 'intake-answers.md',
    kind: 'markdown',
    producedBy: 'Boss',
    taskId: 'task-01',
    createdAt: '2026-07-24 08:52',
    size: '3.9 KB',
    preview: `# Intake answers

Six questions, one round, answered by the shop owner. Recorded verbatim where the wording matters.

## The answers

1. **Barbers** — three, each with their own hours. Deniz works Tuesday to Saturday, the other two
   work Monday to Friday.
2. **Services** — seven, from a 20-minute beard trim to a 75-minute cut and colour. Durations differ
   from the cleanup time between appointments, and the owner was specific about that.
3. **Deposit** — 20%, taken at booking. Kept on a no-show.
4. **Hours** — 09:00 to 18:00, Monday closes at 16:00, closed Sundays.
5. **Account required** — no, and stated firmly: *"nobody signs up to get a haircut."*
6. **What "premium" means** — the owner's own words: *"it should feel calm and expensive, and it
   should take fifteen seconds."*

## What this changed

Answer six killed the original hero concept before it was drawn. Answer five removed an entire
authentication work package from the plan.`,
  },
  {
    prototype: true,
    id: 'art-competitor-scan',
    name: 'competitor-scan.md',
    kind: 'markdown',
    producedBy: 'Search Boss',
    taskId: 'task-03',
    createdAt: '2026-07-24 09:58',
    size: '18.4 KB',
    preview: `# Reference sweep — twelve booking flows

Twelve published booking flows read end to end, nine of them on a 390px viewport. Each was recorded
by what it asks for and in which order, not by how it looks.

## Patterns worth keeping

- **Availability before identity.** The four flows that showed open times on the first screen were
  the only four that felt fast. Every flow that asked for an email first added a decision the
  visitor had no reason to make yet.
- **Barber choice optional.** Six flows forced a staff selection. Most people booking a trim do not
  have a preference, and forcing one turns a two-tap flow into four.
- **Confirmation in place.** Three flows redirected to a receipt page. The redirect reads as a
  handoff to something else, which is exactly the wrong feeling at the end of a booking.

## Patterns rejected

The account wall, present in five of twelve, loses the visitor at step one. The countdown timer on a
held slot, present in two, manufactures pressure that a barbershop does not have.

## Not found

None of the twelve stated a deposit policy before the payment screen. That is a gap this build can
use rather than copy.`,
  },
  {
    prototype: true,
    id: 'art-ui-review',
    name: 'ui-review.md',
    kind: 'report',
    producedBy: 'UI Boss',
    taskId: 'task-08',
    createdAt: '2026-07-24 15:12',
    size: '9.6 KB',
    preview: `# UI review — booking step

Reviewed against the desktop capture at 1440 x 900 and the mobile capture at 390 x 844. The mobile
capture is quarantined: its build hash does not match the tested build, so nothing in this document
draws a conclusion from it.

## What holds

The type scale survives contact with real content. Service names of wildly different lengths still
sit on one baseline, and the price column reads as a column rather than as seven separate numbers.
The step indicator is legible without colour, which was the whole point of building it from weight
and position instead.

## What changed during review

The display size came down twice. At the original size the headline was the loudest element on a
page whose only job is to get someone to pick a time — the hierarchy was pointing at the wrong
thing. The slot grid gained a visible focus ring after keyboard testing showed the selection was
invisible without a mouse.

## Open

The sticky summary bar overlaps the last two slot rows at 390px. That is a layout defect, tracked in
the test lane, and it is not softened here into a "minor spacing issue".`,
  },
  {
    prototype: true,
    id: 'art-security-report',
    name: 'security-report.md',
    kind: 'report',
    producedBy: 'Security Boss',
    taskId: 'task-21',
    createdAt: '2026-07-24 13:44',
    size: '11.3 KB',
    preview: `# Security report

Scope: the working tree at build 9f2d07c, the permissions granted during this run, and the one
endpoint that accepts input from the public internet.

## Secret scan

214 tracked files scanned. No live credential found. One near-miss is reported rather than silently
cleared: the setup notes contain a sample key shape used to illustrate the environment file. The
matching line is quoted in full below the summary so the judgement can be checked rather than
trusted.

## Permissions

Three agents held write access this run — Build Boss, UI Boss and Integration Boss. The first two
are justified by their work packages. Integration Boss was granted elevated permission for a mail
send that never executed; the recommendation is to drop it back to standard until a sender exists.

## Findings

One medium: the booking endpoint accepted an unbounded notes field, which is a cheap way to fill a
database. It is now capped at 500 characters and trimmed server-side, with the limit enforced on the
server rather than only in the form.

## Not assessed

The deposit payment surface. The code exists, has never been executed, and reviewing it now would
produce a report about intentions rather than behaviour.`,
  },
  {
    prototype: true,
    id: 'art-verification-report',
    name: 'verification-report.md',
    kind: 'report',
    producedBy: 'Verify Agent',
    taskId: 'task-28',
    createdAt: '2026-07-24 15:39',
    size: '7.8 KB',
    preview: `# Verification report

Twenty-two completion claims checked this run. Nineteen accepted, three rejected. The check is
narrow on purpose: does the attached evidence actually show the thing being claimed, on the build
the claim refers to.

## The rejection that mattered

A completion claim for the mobile booking step arrived with a single screenshot and no trace. The
build hash in the screenshot footer read 4c1e9ab; the journey it claimed to prove ran against
9f2d07c. The capture shows the previous build. It was rejected on that one comparison, and the
implementation was never examined — it did not need to be.

## The two smaller rejections

One claim attached a passing test summary with the failing case filtered out of the output. One
claim cited an artifact that had not been written yet.

## What this costs

Three rejections cost roughly forty minutes of rework across the run. The alternative was a handoff
document stating that the mobile flow passed, which would have been false and would have been
discovered by the shop rather than by us.`,
  },
  {
    prototype: true,
    id: 'art-accessibility-report',
    name: 'accessibility-report.md',
    kind: 'report',
    producedBy: 'Test Boss',
    taskId: 'task-19',
    createdAt: '2026-07-24 15:16',
    size: '6.1 KB',
    preview: `# Accessibility report

Automated sweep plus a keyboard-only pass over the four-step flow. Automated tooling found two of
the three real problems; the third only appeared when the mouse was put down.

## Serious findings — both closed

The slot buttons announced only a time, so a screen reader user heard "ten thirty, eleven, eleven
thirty" with no idea which barber or service they belonged to. Each button now carries an accessible
name with all three. The step indicator changed silently between steps and now announces on change.

## Found by hand

Focus order jumped from the service list straight to the footer, skipping the slot grid entirely,
because the grid was rendered after the fold and inserted above its trigger. Fixed by ordering the
DOM the way the page reads.

## Standing

Zero serious violations open. The sweep will be re-run after the responsive pass, since the fix for
the 390px overlap will move the very elements this checked.`,
  },
  {
    prototype: true,
    id: 'art-final-report',
    name: 'final-report.md',
    kind: 'report',
    producedBy: 'Docs Boss',
    taskId: 'task-26',
    createdAt: '2026-07-24 15:41',
    size: '13.5 KB',
    preview: `# Final report — DRAFT, held open

This document is not finished, and it is deliberately not being finished yet. The mobile journey is
still failing and the repair loop has not closed. A final report written now would have to be
rewritten within the hour, and the first version would already be in the owner's inbox.

## What is genuinely done

The booking engine models three barbers, seven services and separate buffer times, and it will not
double-book a slot. The desktop journey runs landing to confirmation in eleven steps. Forty-one unit
tests cover the boundaries that only bite twice a year. The secret scan is clean and the one medium
finding is fixed.

## What is not done, stated plainly

The mobile flow fails at 390px — the confirm button is unreachable behind the sticky summary bar.
The deposit payment has never been executed because no test credentials were provided. The
confirmation email renders but cannot be sent, as there is no configured sender.

## What the owner must decide

Whether to launch with deposits taken in the chair rather than online. That unblocks everything
except the mobile defect, which is not negotiable — most of this shop's visitors are on a phone.`,
  },
  {
    prototype: true,
    id: 'art-playwright-desktop',
    name: 'playwright-desktop.png',
    kind: 'screenshot',
    producedBy: 'Test Boss',
    taskId: 'task-17',
    createdAt: '2026-07-24 15:12',
    size: '412 KB',
    preview:
      'Example capture, described rather than rendered — no image file exists behind this record. The frame would show the confirmation step at 1440 x 900: the four-step indicator with step four filled, the chosen service and barber summarised on the left, and the confirm control resting alone in the lower right with generous space around it. The footer strip carries the build hash 9f2d07c, which is what makes this capture usable as evidence.',
  },
  {
    prototype: true,
    id: 'art-playwright-mobile',
    name: 'playwright-mobile.png',
    kind: 'screenshot',
    producedBy: 'Test Boss',
    taskId: 'task-18',
    createdAt: '2026-07-24 14:03',
    size: '286 KB',
    preview:
      'Example capture, described rather than rendered — no image file exists behind this record. The frame would show the failure state at 390 x 844: the time-slot grid scrolled to its last two rows, with the sticky summary bar sitting on top of them and the confirm button hidden underneath. Captured automatically at the moment of failure. The footer hash reads 4c1e9ab — the previous build — which is why the Verify Agent rejected the claim this image was attached to.',
  },
  {
    prototype: true,
    id: 'art-hero-desktop',
    name: 'hero-desktop.png',
    kind: 'screenshot',
    producedBy: 'UI Boss',
    taskId: 'task-06',
    createdAt: '2026-07-24 15:44',
    size: '523 KB',
    preview:
      'Example capture, described rather than rendered — no image file exists behind this record. The frame would show the hero at 1440 x 900 after the second size reduction: a short headline at the settled display size, one line of supporting text, and a single book-a-time control. The service menu begins just above the fold so the page reads as an invitation to scroll rather than a wall.',
  },
  {
    prototype: true,
    id: 'art-booking-flow-diagram',
    name: 'booking-flow.svg',
    kind: 'diagram',
    producedBy: 'Head Chef',
    taskId: 'task-10',
    createdAt: '2026-07-24 11:14',
    size: '38 KB',
    preview:
      'Example diagram, described rather than rendered. Four boxes left to right — service, time, details, confirm — with a back arrow under each and a single branch off the third box for the taken-slot case, which returns to the time step with the conflicting slot marked. One dashed box hangs below the confirm step for the deposit payment, drawn dashed because it is planned rather than working.',
  },
  {
    prototype: true,
    id: 'art-slot-coverage',
    name: 'slot-engine-coverage.log',
    kind: 'log',
    producedBy: 'Test Boss',
    taskId: 'task-16',
    createdAt: '2026-07-24 13:36',
    size: '4.4 KB',
    preview: `EXAMPLE OUTPUT — written by hand, nothing was executed.

 PASS  src/booking/slots.test.ts (41 tests) 812ms
   ✓ collapses overlapping windows for the same barber
   ✓ respects buffer time separately from service duration
   ✓ excludes staff leave from availability
   ✓ closes at 16:00 on Monday, 18:00 otherwise
   ✓ rejects a booking made in a different timezone that lands out of hours
   ✓ survives the daylight-saving jump without producing a 25-hour Sunday

 File            | % Stmts | % Branch | % Funcs | Uncovered lines
 slots.ts        |   96.4  |   91.2   |  100.0  | 184, 212-214
 availability.ts |   93.1  |   88.0   |   95.0  | 77, 140-143`,
  },
  {
    prototype: true,
    id: 'art-markdown-lint',
    name: 'markdown-lint.log',
    kind: 'log',
    producedBy: 'Docs Boss',
    taskId: 'task-25',
    createdAt: '2026-07-24 15:22',
    size: '2.1 KB',
    preview: `EXAMPLE OUTPUT — written by hand, nothing was executed.

 11 documents checked, 2 with findings

 docs/setup.md:41    MD001  heading levels should increment by one (h2 → h4)
 docs/handoff.md:12  MD001  heading levels should increment by one (h1 → h3)

 Both corrected in place. Re-check: 11 documents, 0 findings.`,
  },
  {
    prototype: true,
    id: 'art-build-receipt',
    name: 'build-receipt.txt',
    kind: 'receipt',
    producedBy: 'Build Boss',
    taskId: 'task-15',
    createdAt: '2026-07-24 14:51',
    size: '1.3 KB',
    preview: `EXAMPLE RECEIPT — written by hand, nothing was built.

 build   9f2d07c
 mode    production
 time    2026-07-24 14:51:07
 typecheck  clean
 lint       clean
 bundle     186.4 KB  (gzip 61.2 KB)

 This hash is the reference every screenshot footer is matched against for the
 remainder of the run. A capture that does not carry it proves nothing.`,
  },
  {
    prototype: true,
    id: 'art-proof-ledger',
    name: 'proof-ledger.jsonl',
    kind: 'proof',
    producedBy: 'Verify Agent',
    taskId: null,
    createdAt: '2026-07-24 15:39',
    size: '26.8 KB',
    preview: `EXAMPLE LEDGER — written by hand, no process appended to it.

 One line per claim, in the order it was checked. Each line carries the claim,
 the agent that made it, the command it rested on, the artifact attached, and
 the verdict with a reason.

 {"ts":"14:07:55","claim":"mobile booking step complete","agent":"Build Boss","verdict":"rejected","reason":"screenshot shows the previous build"}
 {"ts":"15:08:14","claim":"desktop journey passes","agent":"Test Boss","verdict":"accepted","reason":"trace and hash both match build 9f2d07c"}

 22 entries total. 19 accepted, 3 rejected, 0 pending at the time of writing.`,
  },
];
