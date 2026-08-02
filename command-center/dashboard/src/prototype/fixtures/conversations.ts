/**
 * Forge Workspace — example conversations.
 *
 * Ten threads across the seven example projects. Three carry full message
 * histories; the rest are opening exchanges, the way a real workspace looks
 * when most conversations are short and a few are not.
 *
 * Every Forge response is hand-written example prose. Nothing was generated,
 * no model was contacted, and the `model` label under a response is a display
 * string rather than a record of anything that ran.
 */

import type { Conversation } from '@/prototype/types/prototype-types';

export const CONVERSATIONS: readonly Conversation[] = [
  /* ------------------------------------------------------------- flagship */
  {
    prototype: true,
    id: 'conv-oac-booking',
    projectId: 'proj-oac',
    title: 'Premium booking website for a barbershop',
    updatedAt: '4 min ago',
    messageCount: 9,
    messages: [
      {
        prototype: true,
        id: 'msg-book-01',
        author: 'user',
        body: 'Build a premium booking website for a barbershop.',
        timestamp: '08:41',
      },
      {
        prototype: true,
        id: 'msg-book-02',
        author: 'forge',
        timestamp: '08:41',
        model: 'forge-runtime · max effort',
        skills: ['forge-router', 'forge-intake'],
        body: `## What I understand

A booking site for a barbershop — and the word doing the most work in that sentence is **premium**.
It means nothing until you tell me what it means to you, and I would rather ask than design against
my own taste.

Three things I am already confident about:

- The visitor's goal is to pick a time, not to browse.
- Most of them will arrive on a phone.
- Whatever "premium" turns out to mean, it will not survive a slow, chatty booking flow.

## Six questions, one round

1. How many barbers, and do they keep different hours?
2. What are the services, and how long does each take — separately from the cleanup time between
   appointments?
3. Is there a deposit? What happens on a no-show?
4. Opening hours, including any day you close early?
5. Should a visitor need an account to book?
6. In your words: what does "premium" feel like for this shop?

If an answer is genuinely *I don't know*, say that. I would rather build around a gap I can see than
one I invented a value for.`,
        steps: [
          {
            id: 'step-book-02-a',
            label: 'Classify the request',
            status: 'completed',
            detail: 'Website build at complexity L3. Routed to the website playbook rather than the full-stack one — there is no account system in this request.',
            agent: 'Boss',
          },
          {
            id: 'step-book-02-b',
            label: 'Read the project context',
            status: 'completed',
            detail: 'Existing front-end kit found in this project. The booking flow can inherit the type scale instead of inventing a second one.',
            agent: 'Search Boss',
          },
          {
            id: 'step-book-02-c',
            label: 'Open the intake round',
            status: 'completed',
            detail: 'Six questions, deliberately answerable in a single message. Planning does not start until they come back.',
            agent: 'Boss',
          },
        ],
      },
      {
        prototype: true,
        id: 'msg-book-03',
        author: 'user',
        timestamp: '08:52',
        body: `Three barbers. Deniz works Tuesday to Saturday, the other two Monday to Friday.

Seven services. Twenty minutes for a beard trim up to seventy-five for cut and colour. Cleanup is ten minutes on top of every one of them, always.

Twenty percent deposit at booking, we keep it on a no-show. Nine to six, Monday we close at four, closed Sundays.

No account. Nobody signs up to get a haircut.

Premium means calm and expensive-looking, and the whole thing should take fifteen seconds.`,
      },
      {
        prototype: true,
        id: 'msg-book-04',
        author: 'forge',
        timestamp: '08:53',
        model: 'forge-runtime · max effort',
        skills: ['forge-website', 'forge-prd', 'forge-verify'],
        body: `## The mission

Your last answer set the bar: **fifteen seconds**. Everything below is arranged around that number.
The reference sweep agrees with you — the four flows we read that actually felt fast were the four
that showed open times before asking for anything.

**Shape:** one page, four steps — service, time, details, confirm. No account, no redirect, no
countdown timer manufacturing pressure a barbershop does not have.

## Work packages

| # | Package | Owner | Closes when |
| --- | --- | --- | --- |
| WP1 | Intake and reference sweep | Search Boss | Twelve flows read, each pattern cited with the step it came from |
| WP2 | Interface and responsive | UI Boss | One type scale holds at 360, 768 and 1440 |
| WP3 | Booking engine | Build Boss | A slot cannot be double-booked; the form survives a refresh |
| WP4 | Tests and browser journeys | Test Boss | Desktop *and* mobile run landing to confirmation |
| WP5 | Security review | Security Boss | Secret scan quoted, every input bounded server-side |
| WP6 | Docs and handoff | Docs Boss | Setup works from a clean machine, in the order written |

WP7 does not exist yet. It is held in reserve for whatever verification sends back.

## Team activated

Six lanes in parallel, ordered so that no lane waits on another for its first task:

- **Search Boss** — context, read-only
- **Build Boss** — engine, schema, the four-step form
- **UI Boss** — type, layout, responsive behaviour
- **Test Boss** — unit tests and browser journeys
- **Security Boss** — read-only scan and permission audit
- **Docs Boss** — setup notes from the start, the summary last

Skills selected: \`forge-website\`, \`forge-verify\`, \`ship-readiness\`. \`gsap\` is loaded but held —
motion is the last thing added, if it survives the reduced-motion pass at all.

## One deliberate decision

The deposit sits **off** the critical path.

\`\`\`bash
# example only — nothing is executed in this prototype
forge run --mission "barbershop booking" --parallel 6 --verify strict
\`\`\`

If the payment integration stalls, the booking flow still reaches a confirmed state and you take the
deposit in the chair. A mission that cannot finish because of one unavailable key was planned badly.`,
        steps: [
          {
            id: 'step-book-04-a',
            label: 'Reference sweep',
            status: 'completed',
            detail: 'Twelve published booking flows read end to end, nine of them at 390px. Three patterns kept, two rejected — including the account wall, which loses the visitor at step one.',
            agent: 'Search Boss',
          },
          {
            id: 'step-book-04-b',
            label: 'Cut the work packages',
            status: 'completed',
            detail: 'Six packages with named owners and acceptance criteria a stranger could check. Payment deliberately kept off the critical path.',
            agent: 'Head Chef',
          },
          {
            id: 'step-book-04-c',
            label: 'Select skills',
            status: 'completed',
            detail: 'Website playbook plus the verify loop. Motion tooling loaded but not enabled until the reduced-motion pass says it earns its place.',
            agent: 'Skill Boss',
          },
          {
            id: 'step-book-04-d',
            label: 'Dispatch six lanes',
            status: 'running',
            detail: 'All six started at 10:24. Search, Build, UI, Test, Security and Docs, each with a first task that depends on nothing outside its own lane.',
            agent: 'Head Chef',
          },
        ],
        attachments: [
          { id: 'att-book-blueprint', name: 'mission-blueprint.md', kind: 'markdown', size: '14.2 KB' },
          { id: 'att-book-taskplan', name: 'task-plan.md', kind: 'markdown', size: '21.7 KB' },
        ],
      },
      {
        prototype: true,
        id: 'msg-book-05',
        author: 'user',
        timestamp: '08:54',
        body: 'Go. Don’t come back to me unless something is actually blocked.',
      },
      {
        prototype: true,
        id: 'msg-book-06',
        author: 'forge',
        timestamp: '13:40',
        model: 'forge-runtime · high effort',
        skills: ['forge-website', 'forge-verify'],
        body: `## Progress

Five hours in. Six lanes ran in parallel and four have closed their first pass.

- **Search Boss** — done. Twelve flows, nine of them read on a phone.
- **Build Boss** — availability calculator and the four-step form are in. One open edge case: two
  barbers free at the same time currently produce a duplicate slot.
- **UI Boss** — hero and service menu settled at desktop width. The display size came down twice;
  at the original size the headline was louder than the one control the page exists for.
- **Test Boss** — 82 unit tests passing.
- **Security Boss** — 214 files scanned, no live credentials.
- **Docs Boss** — setup notes rewritten for a machine with nothing installed.

The unit run in full, including the boundaries that only bite twice a year:

\`\`\`text
 PASS  src/booking/slots.test.ts        (41 tests)  812ms
 PASS  src/booking/pricing.test.ts      (18 tests)  204ms
 PASS  src/booking/validation.test.ts   (23 tests)  341ms

 Test Files  3 passed (3)
      Tests  82 passed (82)
   Duration  4.10s
\`\`\`

Browser journeys are running now. Nothing is blocked, so I am not asking you anything.`,
        steps: [
          {
            id: 'step-book-06-a',
            label: 'Search lane',
            status: 'completed',
            detail: 'Reference sweep closed at 09:31 with the report attached. The lane is finished and released.',
            agent: 'Search Boss',
          },
          {
            id: 'step-book-06-b',
            label: 'Build lane',
            status: 'running',
            detail: 'Slot engine and form complete. Collapsing duplicate slots by barber instead of by service is the current change.',
            agent: 'Build Boss',
          },
          {
            id: 'step-book-06-c',
            label: 'UI lane',
            status: 'running',
            detail: 'Hero and service menu done at 1440. Responsive pass queued behind the menu baseline alignment.',
            agent: 'UI Boss',
          },
          {
            id: 'step-book-06-d',
            label: 'Test lane',
            status: 'running',
            detail: '82 unit tests green. Desktop and mobile browser journeys starting now.',
            agent: 'Test Boss',
          },
          {
            id: 'step-book-06-e',
            label: 'Security lane',
            status: 'completed',
            detail: 'Secret scan clean across 214 files, with the single near-miss quoted rather than cleared silently.',
            agent: 'Security Boss',
          },
          {
            id: 'step-book-06-f',
            label: 'Docs lane',
            status: 'running',
            detail: 'Setup notes rewritten. Handoff summary deliberately not started — it would only be rewritten later.',
            agent: 'Docs Boss',
          },
        ],
      },
      {
        prototype: true,
        id: 'msg-book-07',
        author: 'forge',
        timestamp: '14:08',
        model: 'forge-runtime · high effort',
        skills: ['forge-verify'],
        body: `## Verification rejected a claim

Build Boss submitted the mobile booking step as complete. The Verify Agent refused it, and it was
right to.

The check is deliberately narrow — does the attached evidence show the claim, on the build the claim
refers to:

\`\`\`text
claim      mobile booking step complete
artifact   playwright-mobile.png   footer hash 4c1e9ab
tested     build 9f2d07c
verdict    REJECTED — screenshot shows the previous build
\`\`\`

That screenshot proves something about code that is no longer on disk. The implementation was never
examined, because it did not need to be: evidence that cannot support a claim ends the conversation
before the code becomes relevant.

Underneath it there is a real defect too. \`booking.mobile.spec.ts\` fails reproducibly at step 3 on
390 x 844 — the confirm button is present in the DOM and never hit-testable, because the sticky
summary bar sits on top of the last two slot rows.

I have opened **WP7**: rebuild from a cleared output directory, recapture, re-run, re-check. Two
repair attempts budgeted. If it needs a third, you hear from me — that was the deal.`,
        steps: [
          {
            id: 'step-book-07-a',
            label: 'Completion claim received',
            status: 'review',
            detail: 'One screenshot, no trace. Forwarded to the Verify Agent unchanged.',
            agent: 'Build Boss',
          },
          {
            id: 'step-book-07-b',
            label: 'Compare evidence to build',
            status: 'failed',
            detail: 'Footer hash 4c1e9ab against tested build 9f2d07c. One comparison, one rejection, no interpretation.',
            agent: 'Verify Agent',
          },
          {
            id: 'step-book-07-c',
            label: 'Reopen the work package',
            status: 'running',
            detail: 'WP4 reopened and WP7 created. The repair task exists because the evidence was stale, not because the implementation was wrong.',
            agent: 'Head Chef',
          },
        ],
        attachments: [
          { id: 'att-book-verify', name: 'verification-report.md', kind: 'markdown', size: '7.8 KB' },
          { id: 'att-book-trace', name: 'trace.zip', kind: 'archive', size: '2.4 MB' },
        ],
      },
      {
        prototype: true,
        id: 'msg-book-08',
        author: 'user',
        timestamp: '14:12',
        body: 'So the mobile flow is broken. How bad?',
      },
      {
        prototype: true,
        id: 'msg-book-09',
        author: 'forge',
        timestamp: '15:41',
        model: 'forge-runtime · max effort',
        skills: ['forge-report', 'ship-readiness'],
        body: `## Where this actually stands

Bad enough to hold the launch. Most of your visitors arrive on a phone, and on a phone the flow
currently cannot be completed. It is one layout defect rather than a design failure — the slot grid
scrolls under a sticky bar that never reserved room for itself.

| Package | State | Note |
| --- | --- | --- |
| WP1 Intake and references | Approved | Twelve flows, three patterns kept |
| WP2 Interface | Approved | Type scale holds; responsive pass still running |
| WP3 Booking engine | Changes requested | Duplicate-slot edge case open |
| WP4 Tests and journeys | Reopened | Mobile journey failing at step 3 |
| WP5 Security | In review | One medium finding, already fixed |
| WP6 Docs and handoff | Not submitted | Held until verification closes |
| WP7 Repair loop | Running | Attempt 2 of 2 |

## Working today

Three barbers with separate hours. Seven services with buffer time modelled apart from duration —
your ten minutes of cleanup is its own field, not padding inside the service. No double-booking.
Desktop journey passing in 6.4s. 82 unit tests green. Zero serious accessibility violations.

## Not working, plainly

- **Mobile confirm button unreachable at 390px.** Being repaired now.
- **Deposit payment** written against the documented contract and never once executed, because no
  test credentials were provided. Written is not implemented.
- **Confirmation email** renders correctly and cannot be sent; there is no configured sender.

The repair is one rule on the slot grid, plus the re-run that proves it:

\`\`\`css
.bk-slot-grid {
  padding-block-end: calc(var(--bk-summary-bar-height) + 1rem);
}
\`\`\`

I will not write the handoff pack until the mobile journey passes on a fresh build. A handoff that
omits an open defect is worse than no handoff — you would find it in front of a customer instead of
in front of me.`,
        steps: [
          {
            id: 'step-book-09-a',
            label: 'Rebuild from a clean tree',
            status: 'running',
            detail: 'Attempt 2. The output directory is cleared first, because attempt 1 captured against a warm dev server and reproduced the same stale hash.',
            agent: 'Build Boss',
          },
          {
            id: 'step-book-09-b',
            label: 'Re-run the mobile journey',
            status: 'waiting',
            detail: 'Same eleven steps, plus an explicit assertion that the confirm button is visible and hit-testable rather than merely present.',
            agent: 'Test Boss',
          },
          {
            id: 'step-book-09-c',
            label: 'Re-check the evidence',
            status: 'review',
            detail: 'Hash comparison only. Accept or reject, with the reason recorded either way.',
            agent: 'Verify Agent',
          },
          {
            id: 'step-book-09-d',
            label: 'Assemble the handoff',
            status: 'blocked',
            detail: 'Blocked on the re-check by design. Writing it now would guarantee rewriting it.',
            agent: 'Docs Boss',
          },
        ],
        attachments: [
          { id: 'att-book-final', name: 'final-report.md', kind: 'markdown', size: '13.5 KB' },
          { id: 'att-book-mobile', name: 'playwright-mobile.png', kind: 'image', size: '286 KB' },
        ],
      },
    ],
  },

  /* --------------------------------------------------- second long thread */
  {
    prototype: true,
    id: 'conv-acf-importer',
    projectId: 'proj-acf',
    title: 'Supplier feed importer is dropping variants',
    updatedAt: '22 min ago',
    messageCount: 7,
    messages: [
      {
        prototype: true,
        id: 'msg-imp-01',
        author: 'user',
        timestamp: '22:11',
        body: 'The overnight import ran and we lost 218 variants. Catalogue looks fine at product level so nobody noticed until a customer asked for a size we should have.',
      },
      {
        prototype: true,
        id: 'msg-imp-02',
        author: 'forge',
        timestamp: '22:13',
        model: 'forge-runtime · high effort',
        skills: ['forge-integration', 'forge-deeplearn'],
        body: `## First read

"Fine at product level, wrong at variant level" is the shape of a schema change upstream, not a bug
in your logic. The importer is finding the product and failing to find what hangs off it, then
treating an empty result as a legitimate empty result.

I am going to check three things before changing anything:

1. What the feed looked like on the last successful run versus tonight.
2. Whether the importer distinguishes *no variants* from *could not read variants*.
3. Whether anything downstream already deleted rows based on that empty set.

Point 3 is the urgent one. A dropped read is recoverable; a propagated delete is not.`,
        steps: [
          {
            id: 'step-imp-02-a',
            label: 'Diff the feed shape',
            status: 'running',
            detail: 'Comparing tonight’s payload against the last known-good sample stored with the previous run.',
            agent: 'Search Boss',
          },
          {
            id: 'step-imp-02-b',
            label: 'Check for propagated deletes',
            status: 'running',
            detail: 'Looking for any job that treats an empty variant array as authoritative rather than as a failed read.',
            agent: 'Build Boss',
          },
        ],
      },
      {
        prototype: true,
        id: 'msg-imp-03',
        author: 'forge',
        timestamp: '22:29',
        model: 'forge-runtime · high effort',
        skills: ['forge-integration'],
        body: `## Found it

The supplier moved size and colour out of top-level attributes and into a nested \`options\` array.
Your importer reads the old path, finds nothing, and returns an empty list — which it then treats as
the truth.

\`\`\`diff
- const variants = product.attributes?.variants ?? [];
+ const variants = product.options?.flatMap(readVariant) ?? null;
+ if (variants === null) {
+   throw new FeedShapeError(product.sku, 'no variant path matched');
+ }
\`\`\`

The second half matters more than the first. An importer that cannot tell *this product has no
variants* from *I could not find the variants* will do this again on the next schema change, and it
will do it just as quietly.

**Good news:** nothing propagated. The nightly deactivation job requires two consecutive empty
reads, so the rows are dormant rather than deleted.`,
        attachments: [{ id: 'att-imp-diff', name: 'importer-shape.diff', kind: 'code', size: '3.1 KB' }],
      },
      {
        prototype: true,
        id: 'msg-imp-04',
        author: 'user',
        timestamp: '22:34',
        body: 'Fix it, and make sure it screams next time instead of quietly returning nothing.',
      },
      {
        prototype: true,
        id: 'msg-imp-05',
        author: 'forge',
        timestamp: '23:02',
        model: 'forge-runtime · high effort',
        skills: ['forge-integration', 'forge-verify'],
        body: `## Done, with one thing still failing

Both paths are supported now — new shape first, old shape as a fallback — and an unmatched shape
raises instead of returning empty. The importer fails loudly on 1 product rather than silently on
218.

Re-ran against tonight's payload: **1,904 products, 6,211 variants, 0 dropped.**

Still red: the integration suite. Two tests assert the old empty-list behaviour, which is exactly the
behaviour we just deleted. They are wrong now, not the code — but I am not rewriting a test to match
a change in the same pass that made the change. That is how a suite stops meaning anything.

I have left them failing and opened a task with the reasoning attached.`,
        steps: [
          {
            id: 'step-imp-05-a',
            label: 'Support both feed shapes',
            status: 'completed',
            detail: 'New nested path read first, legacy attribute path kept as a fallback for suppliers who have not migrated.',
            agent: 'Build Boss',
          },
          {
            id: 'step-imp-05-b',
            label: 'Fail loudly on an unknown shape',
            status: 'completed',
            detail: 'An unmatched variant path now raises FeedShapeError with the SKU, instead of returning an empty array.',
            agent: 'Build Boss',
          },
          {
            id: 'step-imp-05-c',
            label: 'Re-run the import',
            status: 'completed',
            detail: '1,904 products, 6,211 variants, nothing dropped. Compared against the last good run rather than against zero.',
            agent: 'Test Boss',
          },
          {
            id: 'step-imp-05-d',
            label: 'Integration suite',
            status: 'failed',
            detail: 'Two tests assert the removed behaviour. Left failing on purpose and raised as its own task.',
            agent: 'Test Boss',
          },
        ],
      },
      {
        prototype: true,
        id: 'msg-imp-06',
        author: 'user',
        timestamp: '23:05',
        body: 'Good call on not touching the tests. Update them tomorrow with fresh eyes.',
      },
      {
        prototype: true,
        id: 'msg-imp-07',
        author: 'forge',
        timestamp: '23:07',
        model: 'forge-runtime · medium effort',
        skills: ['forge-report'],
        body: `Queued for tomorrow. The task carries the reason so whoever picks it up is not guessing why two
green tests went red overnight.

One thing worth doing at the same time: the supplier gave no notice of this change, and we only
caught it because a customer asked for a size. A shape check on ingest — compare tonight's field
paths against the last accepted set, warn on drift — would have caught it at 22:13 instead of at
09:40 the next morning.

That is a separate mission, not a line in this one.`,
      },
    ],
  },

  /* ---------------------------------------------------- third long thread */
  {
    prototype: true,
    id: 'conv-fei-backtest',
    projectId: 'proj-fei',
    title: 'Backtest the value model against closing odds',
    updatedAt: '1 hr ago',
    messageCount: 6,
    messages: [
      {
        prototype: true,
        id: 'msg-bt-01',
        author: 'user',
        timestamp: '04:18',
        body: 'Run the 2025/26 season through the value model and tell me whether the edge is real. Do not round it in my favour.',
      },
      {
        prototype: true,
        id: 'msg-bt-02',
        author: 'forge',
        timestamp: '04:19',
        model: 'forge-runtime · high effort',
        skills: ['forge-prediction'],
        body: `## How I will measure it

Against **closing odds**, not the price at the time of the tip. Closing line is the honest benchmark
because it contains everything the market learned after we spoke.

Method:

- 1,842 fixtures with complete closing data. Anything incomplete is excluded and counted, not filled in.
- Flat stake throughout. Variable staking would let a good run flatter a mediocre model.
- Report by league as well as overall, because an edge that lives in two leagues is a different
  finding from an edge spread across ten.

This takes a while. I will come back with a number and the shape underneath it.`,
        steps: [
          {
            id: 'step-bt-02-a',
            label: 'Assemble the fixture set',
            status: 'running',
            detail: '1,842 fixtures with complete closing odds; 96 excluded for missing data and listed rather than dropped silently.',
            agent: 'Data Scientist',
          },
        ],
      },
      {
        prototype: true,
        id: 'msg-bt-03',
        author: 'forge',
        timestamp: '07:46',
        model: 'forge-runtime · high effort',
        skills: ['forge-prediction', 'forge-graded-verify'],
        body: `## Result

**Measured edge: 1.8% over closing.** The June run reported 4.1%. That number was not wrong so much
as differently measured — it used the price at tip time, which flatters every model that moves with
the market.

| League | Fixtures | Edge vs close | Note |
| --- | --- | --- | --- |
| Eredivisie | 306 | +4.9% | Carries most of the total |
| Championship | 552 | +2.6% | Consistent across the season |
| Premier League | 380 | +0.2% | Inside noise |
| La Liga | 342 | −0.4% | No edge found |
| Serie A | 262 | −0.9% | No edge found |

Two leagues carry it. Three do not, and two are slightly negative.

## What I would not conclude

That the model is 1.8% profitable going forward. One season is roughly 1,800 observations against a
market that reprices continuously, and the confidence interval on that 1.8% comfortably includes
zero for three of the five leagues.

The defensible statement is narrower: *the model has found something in the Eredivisie and the
Championship, and nothing yet elsewhere.*`,
        steps: [
          {
            id: 'step-bt-03-a',
            label: 'Backtest at flat stake',
            status: 'completed',
            detail: '1,842 fixtures, closing odds, no variable staking. Excluded fixtures listed by reason in the appendix.',
            agent: 'Data Scientist',
          },
          {
            id: 'step-bt-03-b',
            label: 'Break out by league',
            status: 'completed',
            detail: 'Per-league split requested up front, because a concentrated edge and a spread edge lead to opposite decisions.',
            agent: 'Data Scientist',
          },
          {
            id: 'step-bt-03-c',
            label: 'Graded review of the conclusion',
            status: 'review',
            detail: 'Checking that the summary does not claim more certainty than 1,842 observations can support.',
            agent: 'Review Boss',
          },
        ],
        attachments: [{ id: 'att-bt-report', name: 'backtest-2025-26.md', kind: 'markdown', size: '31.4 KB' }],
      },
      {
        prototype: true,
        id: 'msg-bt-04',
        author: 'user',
        timestamp: '07:52',
        body: 'So we cut the other three leagues from the tips?',
      },
      {
        prototype: true,
        id: 'msg-bt-05',
        author: 'forge',
        timestamp: '07:55',
        model: 'forge-runtime · high effort',
        skills: ['forge-prediction'],
        body: `Not on this evidence alone. Cutting three leagues on one season is a decision with the same
weakness as trusting the 4.1%: it treats a single sample as settled.

What I would do instead:

1. Keep publishing all five, with the confidence band visible per league rather than a single number
   at the top.
2. Mark Eredivisie and Championship tips as the ones the model actually has a record on.
3. Re-measure after 400 more fixtures. If La Liga and Serie A are still flat, that is two samples
   saying the same thing, which is worth acting on.

The bot copy needs a change either way. Right now every tip reads with the same confidence, and the
model does not have the same confidence.`,
      },
      {
        prototype: true,
        id: 'msg-bt-06',
        author: 'user',
        timestamp: '08:01',
        body: 'Agreed. Put the per-league confidence in the tip format and we will look again in a month.',
      },
    ],
  },

  /* ------------------------------------------------------- shorter threads */
  {
    prototype: true,
    id: 'conv-oac-seo',
    projectId: 'proj-oac',
    title: 'Structured data without inventing opening hours',
    updatedAt: '31 min ago',
    messageCount: 2,
    messages: [
      {
        prototype: true,
        id: 'msg-seo-01',
        author: 'user',
        timestamp: '13:02',
        body: 'Add LocalBusiness and Service schema to the booking site so it shows up properly in search.',
      },
      {
        prototype: true,
        id: 'msg-seo-02',
        author: 'forge',
        timestamp: '13:05',
        model: 'forge-runtime · medium effort',
        skills: ['forge-website'],
        body: `Drafted and validating, with three fields deliberately left empty: \`openingHours\`,
\`priceRange\` and \`telephone\`.

I have the hours from intake for the *booking engine*, but not confirmed for publication, and those
two are not the same thing. Structured data is read by machines and repeated without context — an
invented opening hour becomes a customer standing outside a closed shop.

Send me the three values and this closes in ten minutes. Until then the schema ships with the fields
absent rather than guessed, which search engines handle gracefully and a wrong value does not.`,
        steps: [
          {
            id: 'step-seo-02-a',
            label: 'Draft the schema',
            status: 'completed',
            detail: 'LocalBusiness with a nested Service list, validating against the vocabulary.',
            agent: 'SEO Boss',
          },
          {
            id: 'step-seo-02-b',
            label: 'Fill the required fields',
            status: 'waiting',
            detail: 'Three fields held empty pending confirmed values. Blank is recoverable; wrong is not.',
            agent: 'SEO Boss',
          },
        ],
      },
    ],
  },
  {
    prototype: true,
    id: 'conv-acf-repricing',
    projectId: 'proj-acf',
    title: 'Repricing must skip an active promo window',
    updatedAt: '3 hr ago',
    messageCount: 2,
    messages: [
      {
        prototype: true,
        id: 'msg-rep-01',
        author: 'user',
        timestamp: '12:40',
        body: 'The overnight repricing job walked straight over the weekend promo and put 340 products back to full margin. Make it stop doing that.',
      },
      {
        prototype: true,
        id: 'msg-rep-02',
        author: 'forge',
        timestamp: '12:44',
        model: 'forge-runtime · high effort',
        skills: ['forge-fullstack', 'forge-verify'],
        body: `The job has no concept of a promo window — it reads margin bands and writes prices, and a
promotional price looks exactly like a mispriced product from that angle.

Two changes, and only the first is urgent:

1. **Skip products inside an active promo window.** Not "reprice and restore" — skip. A restore
   step is a second chance to get it wrong.
2. **Refuse to move more than 5% of the catalogue in one run** without an explicit override. Last
   night's run touched 340 products and nothing stopped it, which is the more interesting failure.

The second one would have caught this even without the promo logic. I would rather have both.`,
      },
    ],
  },
  {
    prototype: true,
    id: 'conv-fei-telegram',
    projectId: 'proj-fei',
    title: 'Tip format for the Telegram bot',
    updatedAt: '2 hr ago',
    messageCount: 2,
    messages: [
      {
        prototype: true,
        id: 'msg-tg-01',
        author: 'user',
        timestamp: '09:20',
        body: 'Rewrite the tip message. Right now every tip looks equally confident and that is not true.',
      },
      {
        prototype: true,
        id: 'msg-tg-02',
        author: 'forge',
        timestamp: '09:24',
        model: 'forge-runtime · medium effort',
        skills: ['forge-prediction', 'humanizer'],
        body: `Proposed format — confidence sits next to the pick rather than in a footer nobody reads:

\`\`\`text
Eredivisie · Twente vs Utrecht
Pick    Over 2.5   @ 1.91
Edge    +5.2% vs closing estimate
Record  Eredivisie: 306 fixtures measured, +4.9%
Basis   xG trend, both sides, last 8

This is an estimate. It is not advice and nothing is staked automatically.
\`\`\`

Three deliberate choices. **Record** shows the sample the confidence rests on, so a league we have
barely measured cannot borrow authority from one we have. **Edge** is stated against closing, which
is the honest benchmark. And the last line stays on every message — not as a legal reflex, but
because a bot that sounds certain will be read as certain.`,
      },
    ],
  },
  {
    prototype: true,
    id: 'conv-chatbot-grounding',
    projectId: 'proj-chatbot',
    title: 'Stop it answering from a near-miss document',
    updatedAt: '3 days ago',
    messageCount: 2,
    messages: [
      {
        prototype: true,
        id: 'msg-gr-01',
        author: 'user',
        timestamp: '11:12',
        body: 'It answered a pricing question using the wrong product page and sounded completely sure. That is worse than saying it does not know.',
      },
      {
        prototype: true,
        id: 'msg-gr-02',
        author: 'forge',
        timestamp: '11:18',
        model: 'forge-runtime · max effort',
        skills: ['forge-rag', 'forge-graded-verify'],
        body: `Agreed, and this is the specific failure the grounding gate exists for — not "no document
found", but "a document that is *nearly* right, retrieved confidently".

Three changes, measured on the held-out set:

- Reranking after retrieval. Grounding score moved from **0.71 to 0.86**.
- A similarity floor below which the assistant declines rather than reaches. Two of the twelve
  remaining failures were exactly this case.
- Citations render as the source *title plus section*, not a bare link. A wrong answer with a
  plausible link attached is harder to catch than a wrong answer without one.

The fallback is now a first-class answer. It reads as a decision rather than as a shrug.`,
      },
    ],
  },
  {
    prototype: true,
    id: 'conv-lab-graded',
    projectId: 'proj-forge-lab',
    title: 'Does graded verification catch a plausible wrong answer?',
    updatedAt: '2 days ago',
    messageCount: 2,
    messages: [
      {
        prototype: true,
        id: 'msg-lab-01',
        author: 'user',
        timestamp: '16:40',
        body: 'Set up a proper test. I want to know whether graded verification catches things the structural gate waves through, or whether we are just adding a second opinion that agrees with the first.',
      },
      {
        prototype: true,
        id: 'msg-lab-02',
        author: 'forge',
        timestamp: '16:51',
        model: 'forge-runtime · max effort',
        skills: ['forge-graded-verify', 'forge-prd'],
        body: `## Experiment design

Sixty answers, three buckets of twenty: correct and well-sourced, correct but weakly sourced, and
**plausible but wrong**. The third bucket is the whole point — the structural gate passes those,
because they have a citation and a shape.

Success criterion, set before running: graded verification must reject at least 15 of the 20
plausible-wrong answers while rejecting no more than 2 of the 20 good ones. A gate that catches
everything by rejecting everything is not a gate.

Result so far: **17 of 20 caught, 3 false rejections.** That is above the bar on catches and above
it on false positives too, which is the uncomfortable half of the finding and gets reported at the
same volume.

This stays a provisional result until it is repeated on a second answer set. One run is a signal,
not a rule, and it does not become a playbook line today.`,
      },
    ],
  },
  {
    prototype: true,
    id: 'conv-novadesk-session',
    projectId: 'proj-novadesk',
    title: 'Agents logged out mid-ticket, drafts lost',
    updatedAt: '5 hr ago',
    messageCount: 2,
    messages: [
      {
        prototype: true,
        id: 'msg-nd-01',
        author: 'user',
        timestamp: '10:31',
        body: 'Support is furious. They write a long reply, the session expires, and the draft is gone. Three people today.',
      },
      {
        prototype: true,
        id: 'msg-nd-02',
        author: 'forge',
        timestamp: '10:38',
        model: 'forge-runtime · high effort',
        skills: ['forge-fullstack', 'security-review'],
        body: `Two problems wearing one coat, and they need opposite fixes.

**The session expiry is arguably correct.** A helpdesk holding customer data should time out. Making
the window longer trades a real security property for a comfort one.

**Losing the draft is not correct, ever.** That is a data-loss bug wearing a session bug's clothes.
A draft should survive expiry, a refresh, a crashed tab and a closed laptop.

Order I would take them in:

1. Persist drafts locally as they are typed, keyed to the ticket. Ship today — it stops the bleeding
   without touching auth.
2. Warn at 2 minutes remaining with a one-click extend, so expiry stops being an ambush.
3. Only then look at the window itself, with the security review in the room.

Marking this blocked until you confirm step 1 is acceptable, because it does mean an unsent reply
lives in browser storage and Security Boss will want to scope that.`,
        steps: [
          {
            id: 'step-nd-02-a',
            label: 'Reproduce the loss',
            status: 'completed',
            detail: 'Draft is held in component state only. Expiry unmounts the composer and the text goes with it.',
            agent: 'Build Boss',
          },
          {
            id: 'step-nd-02-b',
            label: 'Scope local draft storage',
            status: 'blocked',
            detail: 'Needs a decision from the owner: an unsent customer reply persisted in browser storage is a new surface, however small.',
            agent: 'Security Boss',
          },
        ],
      },
    ],
  },
  {
    prototype: true,
    id: 'conv-n8n-error-branch',
    projectId: 'proj-n8n',
    title: 'Nine workflows have retries but no error branch',
    updatedAt: '38 min ago',
    messageCount: 2,
    messages: [
      {
        prototype: true,
        id: 'msg-n8n-01',
        author: 'user',
        timestamp: '09:10',
        body: 'Validate the whole suite before I hand it to the team. If something is not production-ready I want to know now, not in three weeks.',
      },
      {
        prototype: true,
        id: 'msg-n8n-02',
        author: 'forge',
        timestamp: '09:13',
        model: 'forge-runtime · high effort',
        skills: ['forge-n8n', 'forge-verify'],
        body: `**22 of 31 pass. Nine do not, and they fail the same way.**

Each of the nine has a retry policy and nothing downstream of a permanent failure. The retries run,
the run dies, and the workflow reports nothing — a silent failure is worse than a loud one because
you find it by noticing the consequence weeks later.

The nine, by what they do when they die:

| Workflow | Failure today | Needed |
| --- | --- | --- |
| Invoice chase | Dies silently after 3 retries | Error branch to the digest |
| Calendar sync | Same | Error branch plus a stale-token check |
| Intake routing | Dies, lead is lost | Error branch to a manual queue |

The other six follow the same pattern and are listed in the report.

I am holding the suite at **verify** rather than marking it ready. Twenty-two green workflows and
nine that can vanish quietly is not a production-ready suite, and calling it one would make the next
person trust it.`,
        attachments: [{ id: 'att-n8n-report', name: 'workflow-validation.md', kind: 'markdown', size: '12.6 KB' }],
      },
    ],
  },
];
