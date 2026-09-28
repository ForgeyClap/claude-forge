import{r as n,j as d}from"./react-BuQOX7bh.js";import{Z as l,av as c,aw as p,ax as h,ay as u}from"./index-CseSttw7.js";import{a as g,b as a}from"./prototype-types-CAn9fc4J.js";import"./icons-CzFtYAGw.js";import"./router-68d_K6t8.js";const m=[{prototype:!0,id:"agent-boss",name:"Boss",role:"Owns the mission end to end — reads the request, sets the bar for done, and refuses to let a work package close on a promise instead of evidence.",group:"control",permission:"lead",status:"running",progress:62,currentTask:"Hold the barbershop mission open until the mobile screenshot is genuine",runtimeModel:"forge-runtime · max effort",toolModel:"nvidia/llama-3.3-nemotron-super-49b · tools",effort:"max",skills:["forge-router","forge-intake","forge-report"],lastActivity:"40 sec ago",verification:"not-required",summary:"Dispatched six lanes off one intake round. Rejected the first completion claim from WP4 because the evidence attached to it was a screenshot of the previous build."},{prototype:!0,id:"agent-head-chef",name:"Head Chef",role:"Turns a sentence from the owner into a plan with edges — work packages, ownership, acceptance criteria, and the order that stops agents from waiting on each other.",group:"planning",permission:"elevated",status:"running",progress:44,currentTask:"Re-cut WP7 after Review Boss sent the mobile capture back",runtimeModel:"forge-runtime · high effort",toolModel:"nvidia/llama-3.1-nemotron-70b-instruct · tools",effort:"high",skills:["forge-prd","forge-mindmap","forge-deeplearn"],lastActivity:"2 min ago",verification:"pending",summary:"Seven work packages, thirty tasks, six parallel lanes. Held the payment task out of the critical path so a missing test key could not stall the booking flow."},{prototype:!0,id:"agent-build-boss",name:"Build Boss",role:"Writes the implementation. Owns the schema, the state, and the unglamorous edge cases — the double-booked slot, the barber who takes Tuesdays off, the browser that is an hour behind.",group:"execution",permission:"elevated",status:"running",progress:71,currentTask:"Availability calculator: collapse overlapping slots per barber",runtimeModel:"forge-runtime · high effort",toolModel:"nvidia/llama-3.3-nemotron-super-49b · tools",effort:"high",skills:["forge-fullstack","forge-website","forge-verify"],lastActivity:"1 min ago",verification:"pending",summary:"Slot engine handles staff leave, service duration and buffer time. Two repair attempts on the rebuild step after the test lane proved the bundle on disk was stale."},{prototype:!0,id:"agent-test-boss",name:"Test Boss",role:'Tries to break what was just built, then writes down exactly how. Unit tests for logic, browser journeys for the flow, and a bug report that names the viewport rather than saying "mobile is off".',group:"review",permission:"standard",status:"failed",progress:100,currentTask:"Playwright mobile journey — step 3 fails at 390px",runtimeModel:"forge-runtime · high effort",toolModel:"nvidia/llama-3.1-nemotron-70b-instruct · tools",effort:"high",skills:["forge-verify","forge-evals","ship-readiness"],lastActivity:"6 min ago",verification:"verified",summary:"Reported one reproducible failure: at 390 x 844 the time-slot grid overlaps the sticky summary bar and the confirm button cannot be reached. Attached a trace, not an opinion."},{prototype:!0,id:"agent-review-boss",name:"Review Boss",role:"The last reader before anything reaches the owner. Judges whether the work answers the request that was actually made, and sends it back when the answer is close but not honest.",group:"review",permission:"elevated",status:"review",progress:0,currentTask:"Second pass on WP5 permissions review",runtimeModel:"forge-runtime · max effort",toolModel:"nvidia/nemotron-4-340b-instruct · tools",effort:"max",skills:["forge-graded-verify","forge-report","humanizer"],lastActivity:"9 min ago",verification:"pending",summary:"Approved the design and copy pass. Reopened the mission once: the summary claimed a passing mobile journey while the attached run showed a failure, and that gap is not a rounding error."},{prototype:!0,id:"agent-security-boss",name:"Security Boss",role:"Reads everything and writes nothing. Scans the working tree for secrets, audits which agent was granted write access this run, and puts a number on the payment surface risk.",group:"review",permission:"read-only",status:"review",progress:0,currentTask:"Risk report on the deposit payment surface",runtimeModel:"forge-runtime · high effort",toolModel:"nvidia/llama-3.1-nemoguard-8b-content-safety · tools",effort:"high",skills:["security-review","forge-doctor","forge-integration"],lastActivity:"14 min ago",verification:"verified",summary:"Secret scan clean across 214 tracked files. Flagged one medium finding: the booking endpoint accepted an unbounded notes field, which is now capped and trimmed server-side."},{prototype:!0,id:"agent-ui-boss",name:"UI Boss",role:"Owns what the visitor actually feels — the type scale, the spacing rhythm, the moment the booking form stops looking like a form. Reviews its own screenshots before anyone else has to.",group:"execution",permission:"standard",status:"running",progress:55,currentTask:"Hero and service menu: settle the vertical rhythm at 1440",runtimeModel:"forge-runtime · high effort",toolModel:"nvidia/nemoretriever-graphic-elements-v1 · tools",effort:"high",skills:["forge-website","gsap","artifact-design"],lastActivity:"3 min ago",verification:"pending",summary:"Three sections done at desktop width. Cut the original headline animation to a 180ms fade after the reduced-motion pass showed it fighting the scroll on a mid-range phone."},{prototype:!0,id:"agent-seo-boss",name:"SEO Boss",role:"Makes the site legible to machines without letting that distort it for people. Structured data, honest titles, real headings, and page weight kept where a phone on 4G can carry it.",group:"domain",permission:"standard",status:"waiting",progress:0,currentTask:"LocalBusiness and Service schema — waiting on final opening hours",runtimeModel:"forge-runtime · medium effort",toolModel:"nvidia/mistral-nemo-minitron-8b-instruct · tools",effort:"medium",skills:["forge-website","ship-readiness"],lastActivity:"31 min ago",verification:"not-required",summary:"Draft schema is written and validates, but three fields are still placeholders. Refused to ship invented opening hours as structured data — that is a wrong answer with a machine-readable wrapper."},{prototype:!0,id:"agent-search-boss",name:"Search Boss",role:"Gathers the context the rest of the team would otherwise guess at. Reads sources, keeps the citation, and reports what it could not find as clearly as what it could.",group:"context",permission:"read-only",status:"completed",progress:100,currentTask:null,runtimeModel:"forge-runtime · medium effort",toolModel:"nvidia/nv-embedqa-e5-v5 · retrieval",effort:"medium",skills:["forge-deeplearn","forge-scraping","forge-rag"],lastActivity:"52 min ago",verification:"verified",summary:"Twelve booking flows read end to end, nine of them on a phone. Finding that changed the plan: every flow that asked for an account before showing availability lost the visitor at step one."},{prototype:!0,id:"agent-skill-boss",name:"Skill Boss",role:"Remembers so the next mission does not start cold. Turns a pattern that worked into a reusable skill, and retires the ones that quietly stopped being true.",group:"memory",permission:"standard",status:"waiting",progress:0,currentTask:"Queued: record the four-step booking flow as a reusable pattern",runtimeModel:"forge-runtime · medium effort",toolModel:"nvidia/nemotron-mini-4b-instruct · tools",effort:"medium",skills:["forge-registry","forge-report","forge-prd"],lastActivity:"1 hr ago",verification:"not-required",summary:"Holding until the mission closes — a pattern is not worth storing before verification agrees it worked. Two candidate skills staged, neither written."},{prototype:!0,id:"agent-integration-boss",name:"Integration Boss",role:"Connects the build to the outside world it depends on — calendars, mail, webhooks, CRMs — and treats every one of those boundaries as a place that will eventually fail.",group:"domain",permission:"elevated",status:"blocked",progress:30,currentTask:"Confirmation email and calendar invite — no mail sender configured",runtimeModel:"forge-runtime · high effort",toolModel:"nvidia/llama-3.1-nemotron-70b-instruct · tools",effort:"high",skills:["forge-integration","forge-n8n","forge-verify"],lastActivity:"27 min ago",verification:"pending",summary:"Confirmation template and ICS attachment are built and render correctly. Blocked at the send step: there is no configured sender, and inventing one would produce a green task that mails nothing."},{prototype:!0,id:"agent-docs-boss",name:"Docs Boss",role:"Writes down what was actually built, including the parts that are unfinished. Owns the README, the setup notes and the handoff pack the owner reads six weeks later.",group:"domain",permission:"standard",status:"waiting",progress:0,currentTask:"Handoff pack — blocked behind the open mobile defect",runtimeModel:"forge-runtime · medium effort",toolModel:"nvidia/mistral-nemo-minitron-8b-instruct · tools",effort:"medium",skills:["forge-report","humanizer","ship-readiness"],lastActivity:"18 min ago",verification:"pending",summary:"README and setup notes updated and markdown-linted. Will not write the handoff summary while a known defect is open — a handoff that omits it is worse than no handoff."},{prototype:!0,id:"agent-verify-agent",name:"Verify Agent",role:'Checks the claim against the evidence and nothing else. Does not care how hard the work was, only whether the artifact attached to "done" actually shows it.',group:"review",permission:"read-only",status:"verify",progress:48,currentTask:"Re-checking the mobile screenshot against the current build hash",runtimeModel:"forge-runtime · high effort",toolModel:"nvidia/llama-3.1-nemotron-nano-8b · tools",effort:"high",skills:["forge-verify","forge-graded-verify","forge-heartbeat"],lastActivity:"5 min ago",verification:"not-required",summary:"Twenty-two claims checked this run, three rejected. The rejection that mattered: a completion claim whose screenshot carried the previous build hash in the footer."},{prototype:!0,id:"agent-data-scientist",name:"Data Scientist",role:"Specialist. Turns a pile of rows into a number someone can act on, and attaches the uncertainty rather than rounding it away.",group:"domain",permission:"read-only",status:"completed",progress:100,currentTask:null,runtimeModel:"forge-runtime · high effort",toolModel:"nvidia/llama-3.1-nemotron-70b-instruct · tools",effort:"high",skills:["forge-prediction","forge-graded-verify"],lastActivity:"4 hr ago",verification:"verified",summary:"Backtested the value model over 1,842 fixtures against closing odds. Reported a thinner edge than the previous run claimed, and showed exactly which two leagues carried it."},{prototype:!0,id:"agent-payment-integration",name:"Payment Integration",role:"Specialist. Owns money movement — checkout sessions, deposits, refunds, webhook signatures — and assumes every callback is hostile until proven otherwise.",group:"domain",permission:"elevated",status:"blocked",progress:15,currentTask:"Deposit via Stripe Checkout — no test keys provided",runtimeModel:"forge-runtime · high effort",toolModel:"nvidia/llama-3.3-nemotron-super-49b · tools",effort:"high",skills:["forge-integration","security-review"],lastActivity:"35 min ago",verification:"rejected",summary:"Checkout session shape and webhook verification are written against the documented contract. Blocked without test credentials — a payment path nobody exercised is not an implemented payment path."},{prototype:!0,id:"agent-mcp-developer",name:"MCP Developer",role:"Specialist. Builds and hardens Model Context Protocol servers — tool schemas, argument validation, and error messages a calling agent can actually recover from.",group:"execution",permission:"standard",status:"completed",progress:100,currentTask:null,runtimeModel:"forge-runtime · high effort",toolModel:"nvidia/usdcode-llama-3.1-70b-instruct · tools",effort:"high",skills:["forge-integration","forge-doctor"],lastActivity:"2 days ago",verification:"verified",summary:"Shipped the availability MCP server with seven tools, each with a typed schema and a rejection path. Three tools were removed as duplicated surface rather than kept for completeness."},{prototype:!0,id:"agent-electron-pro",name:"Electron Pro",role:"Specialist. Packages a web build into a desktop app without letting it become a browser in a costume — real window state, real updates, a real quit.",group:"execution",permission:"standard",status:"waiting",progress:0,currentTask:"Queued: desktop shell for the studio dashboard",runtimeModel:"forge-runtime · medium effort",toolModel:"nvidia/usdcode-llama-3.1-70b-instruct · tools",effort:"medium",skills:["forge-fullstack","ship-readiness"],lastActivity:"6 days ago",verification:"not-required",summary:"Not dispatched on this mission. Last run produced a signed Windows build with auto-update disabled until an update host exists to point it at."},{prototype:!0,id:"agent-ml-engineer",name:"ML Engineer",role:"Specialist. Owns retrieval quality and evaluation — chunking, embeddings, reranking, and the eval set that decides whether a change was an improvement or a mood.",group:"domain",permission:"standard",status:"verify",progress:80,currentTask:"Graded eval sweep on the grounding fallback",runtimeModel:"forge-runtime · max effort",toolModel:"nvidia/nv-embedqa-e5-v5 · retrieval",effort:"max",skills:["forge-rag","forge-graded-verify","forge-evals"],lastActivity:"3 hr ago",verification:"pending",summary:"Reranking lifted answer grounding from 0.71 to 0.86 on the held-out set. Two of the twelve failures were the model answering confidently from a near-miss document — the exact case the gate exists for."}],f=[{prototype:!0,id:"art-mission-blueprint",name:"mission-blueprint.md",kind:"markdown",producedBy:"Head Chef",taskId:"task-04",createdAt:"2026-07-24 10:22",size:"14.2 KB",preview:`# Mission blueprint — barbershop booking site

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
its footer matches the build the tests ran against, which is the check that reopened this mission.`},{prototype:!0,id:"art-task-plan",name:"task-plan.md",kind:"markdown",producedBy:"Head Chef",taskId:"task-04",createdAt:"2026-07-24 10:23",size:"21.7 KB",preview:`# Task plan

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
earlier would guarantee rewriting it, and the first version would already have been sent.`},{prototype:!0,id:"art-intake-answers",name:"intake-answers.md",kind:"markdown",producedBy:"Boss",taskId:"task-01",createdAt:"2026-07-24 08:52",size:"3.9 KB",preview:`# Intake answers

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
authentication work package from the plan.`},{prototype:!0,id:"art-competitor-scan",name:"competitor-scan.md",kind:"markdown",producedBy:"Search Boss",taskId:"task-03",createdAt:"2026-07-24 09:58",size:"18.4 KB",preview:`# Reference sweep — twelve booking flows

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
use rather than copy.`},{prototype:!0,id:"art-ui-review",name:"ui-review.md",kind:"report",producedBy:"UI Boss",taskId:"task-08",createdAt:"2026-07-24 15:12",size:"9.6 KB",preview:`# UI review — booking step

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
the test lane, and it is not softened here into a "minor spacing issue".`},{prototype:!0,id:"art-security-report",name:"security-report.md",kind:"report",producedBy:"Security Boss",taskId:"task-21",createdAt:"2026-07-24 13:44",size:"11.3 KB",preview:`# Security report

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
produce a report about intentions rather than behaviour.`},{prototype:!0,id:"art-verification-report",name:"verification-report.md",kind:"report",producedBy:"Verify Agent",taskId:"task-28",createdAt:"2026-07-24 15:39",size:"7.8 KB",preview:`# Verification report

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
discovered by the shop rather than by us.`},{prototype:!0,id:"art-accessibility-report",name:"accessibility-report.md",kind:"report",producedBy:"Test Boss",taskId:"task-19",createdAt:"2026-07-24 15:16",size:"6.1 KB",preview:`# Accessibility report

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
the 390px overlap will move the very elements this checked.`},{prototype:!0,id:"art-final-report",name:"final-report.md",kind:"report",producedBy:"Docs Boss",taskId:"task-26",createdAt:"2026-07-24 15:41",size:"13.5 KB",preview:`# Final report — DRAFT, held open

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
except the mobile defect, which is not negotiable — most of this shop's visitors are on a phone.`},{prototype:!0,id:"art-playwright-desktop",name:"playwright-desktop.png",kind:"screenshot",producedBy:"Test Boss",taskId:"task-17",createdAt:"2026-07-24 15:12",size:"412 KB",preview:"Example capture, described rather than rendered — no image file exists behind this record. The frame would show the confirmation step at 1440 x 900: the four-step indicator with step four filled, the chosen service and barber summarised on the left, and the confirm control resting alone in the lower right with generous space around it. The footer strip carries the build hash 9f2d07c, which is what makes this capture usable as evidence."},{prototype:!0,id:"art-playwright-mobile",name:"playwright-mobile.png",kind:"screenshot",producedBy:"Test Boss",taskId:"task-18",createdAt:"2026-07-24 14:03",size:"286 KB",preview:"Example capture, described rather than rendered — no image file exists behind this record. The frame would show the failure state at 390 x 844: the time-slot grid scrolled to its last two rows, with the sticky summary bar sitting on top of them and the confirm button hidden underneath. Captured automatically at the moment of failure. The footer hash reads 4c1e9ab — the previous build — which is why the Verify Agent rejected the claim this image was attached to."},{prototype:!0,id:"art-hero-desktop",name:"hero-desktop.png",kind:"screenshot",producedBy:"UI Boss",taskId:"task-06",createdAt:"2026-07-24 15:44",size:"523 KB",preview:"Example capture, described rather than rendered — no image file exists behind this record. The frame would show the hero at 1440 x 900 after the second size reduction: a short headline at the settled display size, one line of supporting text, and a single book-a-time control. The service menu begins just above the fold so the page reads as an invitation to scroll rather than a wall."},{prototype:!0,id:"art-booking-flow-diagram",name:"booking-flow.svg",kind:"diagram",producedBy:"Head Chef",taskId:"task-10",createdAt:"2026-07-24 11:14",size:"38 KB",preview:"Example diagram, described rather than rendered. Four boxes left to right — service, time, details, confirm — with a back arrow under each and a single branch off the third box for the taken-slot case, which returns to the time step with the conflicting slot marked. One dashed box hangs below the confirm step for the deposit payment, drawn dashed because it is planned rather than working."},{prototype:!0,id:"art-slot-coverage",name:"slot-engine-coverage.log",kind:"log",producedBy:"Test Boss",taskId:"task-16",createdAt:"2026-07-24 13:36",size:"4.4 KB",preview:`EXAMPLE OUTPUT — written by hand, nothing was executed.

 PASS  src/booking/slots.test.ts (41 tests) 812ms
   ✓ collapses overlapping windows for the same barber
   ✓ respects buffer time separately from service duration
   ✓ excludes staff leave from availability
   ✓ closes at 16:00 on Monday, 18:00 otherwise
   ✓ rejects a booking made in a different timezone that lands out of hours
   ✓ survives the daylight-saving jump without producing a 25-hour Sunday

 File            | % Stmts | % Branch | % Funcs | Uncovered lines
 slots.ts        |   96.4  |   91.2   |  100.0  | 184, 212-214
 availability.ts |   93.1  |   88.0   |   95.0  | 77, 140-143`},{prototype:!0,id:"art-markdown-lint",name:"markdown-lint.log",kind:"log",producedBy:"Docs Boss",taskId:"task-25",createdAt:"2026-07-24 15:22",size:"2.1 KB",preview:`EXAMPLE OUTPUT — written by hand, nothing was executed.

 11 documents checked, 2 with findings

 docs/setup.md:41    MD001  heading levels should increment by one (h2 → h4)
 docs/handoff.md:12  MD001  heading levels should increment by one (h1 → h3)

 Both corrected in place. Re-check: 11 documents, 0 findings.`},{prototype:!0,id:"art-build-receipt",name:"build-receipt.txt",kind:"receipt",producedBy:"Build Boss",taskId:"task-15",createdAt:"2026-07-24 14:51",size:"1.3 KB",preview:`EXAMPLE RECEIPT — written by hand, nothing was built.

 build   9f2d07c
 mode    production
 time    2026-07-24 14:51:07
 typecheck  clean
 lint       clean
 bundle     186.4 KB  (gzip 61.2 KB)

 This hash is the reference every screenshot footer is matched against for the
 remainder of the run. A capture that does not carry it proves nothing.`},{prototype:!0,id:"art-proof-ledger",name:"proof-ledger.jsonl",kind:"proof",producedBy:"Verify Agent",taskId:null,createdAt:"2026-07-24 15:39",size:"26.8 KB",preview:`EXAMPLE LEDGER — written by hand, no process appended to it.

 One line per claim, in the order it was checked. Each line carries the claim,
 the agent that made it, the command it rested on, the artifact attached, and
 the verdict with a reason.

 {"ts":"14:07:55","claim":"mobile booking step complete","agent":"Build Boss","verdict":"rejected","reason":"screenshot shows the previous build"}
 {"ts":"15:08:14","claim":"desktop journey passes","agent":"Test Boss","verdict":"accepted","reason":"trace and hash both match build 9f2d07c"}

 22 entries total. 19 accepted, 3 rejected, 0 pending at the time of writing.`}],b=[{prototype:!0,id:"conv-oac-booking",projectId:"proj-oac",title:"Premium booking website for a barbershop",updatedAt:"4 min ago",messageCount:9,messages:[{prototype:!0,id:"msg-book-01",author:"user",body:"Build a premium booking website for a barbershop.",timestamp:"08:41"},{prototype:!0,id:"msg-book-02",author:"forge",timestamp:"08:41",model:"forge-runtime · max effort",skills:["forge-router","forge-intake"],body:`## What I understand

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
one I invented a value for.`,steps:[{id:"step-book-02-a",label:"Classify the request",status:"completed",detail:"Website build at complexity L3. Routed to the website playbook rather than the full-stack one — there is no account system in this request.",agent:"Boss"},{id:"step-book-02-b",label:"Read the project context",status:"completed",detail:"Existing front-end kit found in this project. The booking flow can inherit the type scale instead of inventing a second one.",agent:"Search Boss"},{id:"step-book-02-c",label:"Open the intake round",status:"completed",detail:"Six questions, deliberately answerable in a single message. Planning does not start until they come back.",agent:"Boss"}]},{prototype:!0,id:"msg-book-03",author:"user",timestamp:"08:52",body:`Three barbers. Deniz works Tuesday to Saturday, the other two Monday to Friday.

Seven services. Twenty minutes for a beard trim up to seventy-five for cut and colour. Cleanup is ten minutes on top of every one of them, always.

Twenty percent deposit at booking, we keep it on a no-show. Nine to six, Monday we close at four, closed Sundays.

No account. Nobody signs up to get a haircut.

Premium means calm and expensive-looking, and the whole thing should take fifteen seconds.`},{prototype:!0,id:"msg-book-04",author:"forge",timestamp:"08:53",model:"forge-runtime · max effort",skills:["forge-website","forge-prd","forge-verify"],body:`## The mission

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
deposit in the chair. A mission that cannot finish because of one unavailable key was planned badly.`,steps:[{id:"step-book-04-a",label:"Reference sweep",status:"completed",detail:"Twelve published booking flows read end to end, nine of them at 390px. Three patterns kept, two rejected — including the account wall, which loses the visitor at step one.",agent:"Search Boss"},{id:"step-book-04-b",label:"Cut the work packages",status:"completed",detail:"Six packages with named owners and acceptance criteria a stranger could check. Payment deliberately kept off the critical path.",agent:"Head Chef"},{id:"step-book-04-c",label:"Select skills",status:"completed",detail:"Website playbook plus the verify loop. Motion tooling loaded but not enabled until the reduced-motion pass says it earns its place.",agent:"Skill Boss"},{id:"step-book-04-d",label:"Dispatch six lanes",status:"running",detail:"All six started at 10:24. Search, Build, UI, Test, Security and Docs, each with a first task that depends on nothing outside its own lane.",agent:"Head Chef"}],attachments:[{id:"att-book-blueprint",name:"mission-blueprint.md",kind:"markdown",size:"14.2 KB"},{id:"att-book-taskplan",name:"task-plan.md",kind:"markdown",size:"21.7 KB"}]},{prototype:!0,id:"msg-book-05",author:"user",timestamp:"08:54",body:"Go. Don’t come back to me unless something is actually blocked."},{prototype:!0,id:"msg-book-06",author:"forge",timestamp:"13:40",model:"forge-runtime · high effort",skills:["forge-website","forge-verify"],body:`## Progress

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

Browser journeys are running now. Nothing is blocked, so I am not asking you anything.`,steps:[{id:"step-book-06-a",label:"Search lane",status:"completed",detail:"Reference sweep closed at 09:31 with the report attached. The lane is finished and released.",agent:"Search Boss"},{id:"step-book-06-b",label:"Build lane",status:"running",detail:"Slot engine and form complete. Collapsing duplicate slots by barber instead of by service is the current change.",agent:"Build Boss"},{id:"step-book-06-c",label:"UI lane",status:"running",detail:"Hero and service menu done at 1440. Responsive pass queued behind the menu baseline alignment.",agent:"UI Boss"},{id:"step-book-06-d",label:"Test lane",status:"running",detail:"82 unit tests green. Desktop and mobile browser journeys starting now.",agent:"Test Boss"},{id:"step-book-06-e",label:"Security lane",status:"completed",detail:"Secret scan clean across 214 files, with the single near-miss quoted rather than cleared silently.",agent:"Security Boss"},{id:"step-book-06-f",label:"Docs lane",status:"running",detail:"Setup notes rewritten. Handoff summary deliberately not started — it would only be rewritten later.",agent:"Docs Boss"}]},{prototype:!0,id:"msg-book-07",author:"forge",timestamp:"14:08",model:"forge-runtime · high effort",skills:["forge-verify"],body:`## Verification rejected a claim

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
repair attempts budgeted. If it needs a third, you hear from me — that was the deal.`,steps:[{id:"step-book-07-a",label:"Completion claim received",status:"review",detail:"One screenshot, no trace. Forwarded to the Verify Agent unchanged.",agent:"Build Boss"},{id:"step-book-07-b",label:"Compare evidence to build",status:"failed",detail:"Footer hash 4c1e9ab against tested build 9f2d07c. One comparison, one rejection, no interpretation.",agent:"Verify Agent"},{id:"step-book-07-c",label:"Reopen the work package",status:"running",detail:"WP4 reopened and WP7 created. The repair task exists because the evidence was stale, not because the implementation was wrong.",agent:"Head Chef"}],attachments:[{id:"att-book-verify",name:"verification-report.md",kind:"markdown",size:"7.8 KB"},{id:"att-book-trace",name:"trace.zip",kind:"archive",size:"2.4 MB"}]},{prototype:!0,id:"msg-book-08",author:"user",timestamp:"14:12",body:"So the mobile flow is broken. How bad?"},{prototype:!0,id:"msg-book-09",author:"forge",timestamp:"15:41",model:"forge-runtime · max effort",skills:["forge-report","ship-readiness"],body:`## Where this actually stands

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
in front of me.`,steps:[{id:"step-book-09-a",label:"Rebuild from a clean tree",status:"running",detail:"Attempt 2. The output directory is cleared first, because attempt 1 captured against a warm dev server and reproduced the same stale hash.",agent:"Build Boss"},{id:"step-book-09-b",label:"Re-run the mobile journey",status:"waiting",detail:"Same eleven steps, plus an explicit assertion that the confirm button is visible and hit-testable rather than merely present.",agent:"Test Boss"},{id:"step-book-09-c",label:"Re-check the evidence",status:"review",detail:"Hash comparison only. Accept or reject, with the reason recorded either way.",agent:"Verify Agent"},{id:"step-book-09-d",label:"Assemble the handoff",status:"blocked",detail:"Blocked on the re-check by design. Writing it now would guarantee rewriting it.",agent:"Docs Boss"}],attachments:[{id:"att-book-final",name:"final-report.md",kind:"markdown",size:"13.5 KB"},{id:"att-book-mobile",name:"playwright-mobile.png",kind:"image",size:"286 KB"}]}]},{prototype:!0,id:"conv-acf-importer",projectId:"proj-acf",title:"Supplier feed importer is dropping variants",updatedAt:"22 min ago",messageCount:7,messages:[{prototype:!0,id:"msg-imp-01",author:"user",timestamp:"22:11",body:"The overnight import ran and we lost 218 variants. Catalogue looks fine at product level so nobody noticed until a customer asked for a size we should have."},{prototype:!0,id:"msg-imp-02",author:"forge",timestamp:"22:13",model:"forge-runtime · high effort",skills:["forge-integration","forge-deeplearn"],body:`## First read

"Fine at product level, wrong at variant level" is the shape of a schema change upstream, not a bug
in your logic. The importer is finding the product and failing to find what hangs off it, then
treating an empty result as a legitimate empty result.

I am going to check three things before changing anything:

1. What the feed looked like on the last successful run versus tonight.
2. Whether the importer distinguishes *no variants* from *could not read variants*.
3. Whether anything downstream already deleted rows based on that empty set.

Point 3 is the urgent one. A dropped read is recoverable; a propagated delete is not.`,steps:[{id:"step-imp-02-a",label:"Diff the feed shape",status:"running",detail:"Comparing tonight’s payload against the last known-good sample stored with the previous run.",agent:"Search Boss"},{id:"step-imp-02-b",label:"Check for propagated deletes",status:"running",detail:"Looking for any job that treats an empty variant array as authoritative rather than as a failed read.",agent:"Build Boss"}]},{prototype:!0,id:"msg-imp-03",author:"forge",timestamp:"22:29",model:"forge-runtime · high effort",skills:["forge-integration"],body:`## Found it

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
reads, so the rows are dormant rather than deleted.`,attachments:[{id:"att-imp-diff",name:"importer-shape.diff",kind:"code",size:"3.1 KB"}]},{prototype:!0,id:"msg-imp-04",author:"user",timestamp:"22:34",body:"Fix it, and make sure it screams next time instead of quietly returning nothing."},{prototype:!0,id:"msg-imp-05",author:"forge",timestamp:"23:02",model:"forge-runtime · high effort",skills:["forge-integration","forge-verify"],body:`## Done, with one thing still failing

Both paths are supported now — new shape first, old shape as a fallback — and an unmatched shape
raises instead of returning empty. The importer fails loudly on 1 product rather than silently on
218.

Re-ran against tonight's payload: **1,904 products, 6,211 variants, 0 dropped.**

Still red: the integration suite. Two tests assert the old empty-list behaviour, which is exactly the
behaviour we just deleted. They are wrong now, not the code — but I am not rewriting a test to match
a change in the same pass that made the change. That is how a suite stops meaning anything.

I have left them failing and opened a task with the reasoning attached.`,steps:[{id:"step-imp-05-a",label:"Support both feed shapes",status:"completed",detail:"New nested path read first, legacy attribute path kept as a fallback for suppliers who have not migrated.",agent:"Build Boss"},{id:"step-imp-05-b",label:"Fail loudly on an unknown shape",status:"completed",detail:"An unmatched variant path now raises FeedShapeError with the SKU, instead of returning an empty array.",agent:"Build Boss"},{id:"step-imp-05-c",label:"Re-run the import",status:"completed",detail:"1,904 products, 6,211 variants, nothing dropped. Compared against the last good run rather than against zero.",agent:"Test Boss"},{id:"step-imp-05-d",label:"Integration suite",status:"failed",detail:"Two tests assert the removed behaviour. Left failing on purpose and raised as its own task.",agent:"Test Boss"}]},{prototype:!0,id:"msg-imp-06",author:"user",timestamp:"23:05",body:"Good call on not touching the tests. Update them tomorrow with fresh eyes."},{prototype:!0,id:"msg-imp-07",author:"forge",timestamp:"23:07",model:"forge-runtime · medium effort",skills:["forge-report"],body:`Queued for tomorrow. The task carries the reason so whoever picks it up is not guessing why two
green tests went red overnight.

One thing worth doing at the same time: the supplier gave no notice of this change, and we only
caught it because a customer asked for a size. A shape check on ingest — compare tonight's field
paths against the last accepted set, warn on drift — would have caught it at 22:13 instead of at
09:40 the next morning.

That is a separate mission, not a line in this one.`}]},{prototype:!0,id:"conv-fei-backtest",projectId:"proj-fei",title:"Backtest the value model against closing odds",updatedAt:"1 hr ago",messageCount:6,messages:[{prototype:!0,id:"msg-bt-01",author:"user",timestamp:"04:18",body:"Run the 2025/26 season through the value model and tell me whether the edge is real. Do not round it in my favour."},{prototype:!0,id:"msg-bt-02",author:"forge",timestamp:"04:19",model:"forge-runtime · high effort",skills:["forge-prediction"],body:`## How I will measure it

Against **closing odds**, not the price at the time of the tip. Closing line is the honest benchmark
because it contains everything the market learned after we spoke.

Method:

- 1,842 fixtures with complete closing data. Anything incomplete is excluded and counted, not filled in.
- Flat stake throughout. Variable staking would let a good run flatter a mediocre model.
- Report by league as well as overall, because an edge that lives in two leagues is a different
  finding from an edge spread across ten.

This takes a while. I will come back with a number and the shape underneath it.`,steps:[{id:"step-bt-02-a",label:"Assemble the fixture set",status:"running",detail:"1,842 fixtures with complete closing odds; 96 excluded for missing data and listed rather than dropped silently.",agent:"Data Scientist"}]},{prototype:!0,id:"msg-bt-03",author:"forge",timestamp:"07:46",model:"forge-runtime · high effort",skills:["forge-prediction","forge-graded-verify"],body:`## Result

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
Championship, and nothing yet elsewhere.*`,steps:[{id:"step-bt-03-a",label:"Backtest at flat stake",status:"completed",detail:"1,842 fixtures, closing odds, no variable staking. Excluded fixtures listed by reason in the appendix.",agent:"Data Scientist"},{id:"step-bt-03-b",label:"Break out by league",status:"completed",detail:"Per-league split requested up front, because a concentrated edge and a spread edge lead to opposite decisions.",agent:"Data Scientist"},{id:"step-bt-03-c",label:"Graded review of the conclusion",status:"review",detail:"Checking that the summary does not claim more certainty than 1,842 observations can support.",agent:"Review Boss"}],attachments:[{id:"att-bt-report",name:"backtest-2025-26.md",kind:"markdown",size:"31.4 KB"}]},{prototype:!0,id:"msg-bt-04",author:"user",timestamp:"07:52",body:"So we cut the other three leagues from the tips?"},{prototype:!0,id:"msg-bt-05",author:"forge",timestamp:"07:55",model:"forge-runtime · high effort",skills:["forge-prediction"],body:`Not on this evidence alone. Cutting three leagues on one season is a decision with the same
weakness as trusting the 4.1%: it treats a single sample as settled.

What I would do instead:

1. Keep publishing all five, with the confidence band visible per league rather than a single number
   at the top.
2. Mark Eredivisie and Championship tips as the ones the model actually has a record on.
3. Re-measure after 400 more fixtures. If La Liga and Serie A are still flat, that is two samples
   saying the same thing, which is worth acting on.

The bot copy needs a change either way. Right now every tip reads with the same confidence, and the
model does not have the same confidence.`},{prototype:!0,id:"msg-bt-06",author:"user",timestamp:"08:01",body:"Agreed. Put the per-league confidence in the tip format and we will look again in a month."}]},{prototype:!0,id:"conv-oac-seo",projectId:"proj-oac",title:"Structured data without inventing opening hours",updatedAt:"31 min ago",messageCount:2,messages:[{prototype:!0,id:"msg-seo-01",author:"user",timestamp:"13:02",body:"Add LocalBusiness and Service schema to the booking site so it shows up properly in search."},{prototype:!0,id:"msg-seo-02",author:"forge",timestamp:"13:05",model:"forge-runtime · medium effort",skills:["forge-website"],body:`Drafted and validating, with three fields deliberately left empty: \`openingHours\`,
\`priceRange\` and \`telephone\`.

I have the hours from intake for the *booking engine*, but not confirmed for publication, and those
two are not the same thing. Structured data is read by machines and repeated without context — an
invented opening hour becomes a customer standing outside a closed shop.

Send me the three values and this closes in ten minutes. Until then the schema ships with the fields
absent rather than guessed, which search engines handle gracefully and a wrong value does not.`,steps:[{id:"step-seo-02-a",label:"Draft the schema",status:"completed",detail:"LocalBusiness with a nested Service list, validating against the vocabulary.",agent:"SEO Boss"},{id:"step-seo-02-b",label:"Fill the required fields",status:"waiting",detail:"Three fields held empty pending confirmed values. Blank is recoverable; wrong is not.",agent:"SEO Boss"}]}]},{prototype:!0,id:"conv-acf-repricing",projectId:"proj-acf",title:"Repricing must skip an active promo window",updatedAt:"3 hr ago",messageCount:2,messages:[{prototype:!0,id:"msg-rep-01",author:"user",timestamp:"12:40",body:"The overnight repricing job walked straight over the weekend promo and put 340 products back to full margin. Make it stop doing that."},{prototype:!0,id:"msg-rep-02",author:"forge",timestamp:"12:44",model:"forge-runtime · high effort",skills:["forge-fullstack","forge-verify"],body:`The job has no concept of a promo window — it reads margin bands and writes prices, and a
promotional price looks exactly like a mispriced product from that angle.

Two changes, and only the first is urgent:

1. **Skip products inside an active promo window.** Not "reprice and restore" — skip. A restore
   step is a second chance to get it wrong.
2. **Refuse to move more than 5% of the catalogue in one run** without an explicit override. Last
   night's run touched 340 products and nothing stopped it, which is the more interesting failure.

The second one would have caught this even without the promo logic. I would rather have both.`}]},{prototype:!0,id:"conv-fei-telegram",projectId:"proj-fei",title:"Tip format for the Telegram bot",updatedAt:"2 hr ago",messageCount:2,messages:[{prototype:!0,id:"msg-tg-01",author:"user",timestamp:"09:20",body:"Rewrite the tip message. Right now every tip looks equally confident and that is not true."},{prototype:!0,id:"msg-tg-02",author:"forge",timestamp:"09:24",model:"forge-runtime · medium effort",skills:["forge-prediction","humanizer"],body:`Proposed format — confidence sits next to the pick rather than in a footer nobody reads:

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
because a bot that sounds certain will be read as certain.`}]},{prototype:!0,id:"conv-chatbot-grounding",projectId:"proj-chatbot",title:"Stop it answering from a near-miss document",updatedAt:"3 days ago",messageCount:2,messages:[{prototype:!0,id:"msg-gr-01",author:"user",timestamp:"11:12",body:"It answered a pricing question using the wrong product page and sounded completely sure. That is worse than saying it does not know."},{prototype:!0,id:"msg-gr-02",author:"forge",timestamp:"11:18",model:"forge-runtime · max effort",skills:["forge-rag","forge-graded-verify"],body:`Agreed, and this is the specific failure the grounding gate exists for — not "no document
found", but "a document that is *nearly* right, retrieved confidently".

Three changes, measured on the held-out set:

- Reranking after retrieval. Grounding score moved from **0.71 to 0.86**.
- A similarity floor below which the assistant declines rather than reaches. Two of the twelve
  remaining failures were exactly this case.
- Citations render as the source *title plus section*, not a bare link. A wrong answer with a
  plausible link attached is harder to catch than a wrong answer without one.

The fallback is now a first-class answer. It reads as a decision rather than as a shrug.`}]},{prototype:!0,id:"conv-lab-graded",projectId:"proj-forge-lab",title:"Does graded verification catch a plausible wrong answer?",updatedAt:"2 days ago",messageCount:2,messages:[{prototype:!0,id:"msg-lab-01",author:"user",timestamp:"16:40",body:"Set up a proper test. I want to know whether graded verification catches things the structural gate waves through, or whether we are just adding a second opinion that agrees with the first."},{prototype:!0,id:"msg-lab-02",author:"forge",timestamp:"16:51",model:"forge-runtime · max effort",skills:["forge-graded-verify","forge-prd"],body:`## Experiment design

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
not a rule, and it does not become a playbook line today.`}]},{prototype:!0,id:"conv-helpdesk-session",projectId:"proj-helpdesk",title:"Agents logged out mid-ticket, drafts lost",updatedAt:"5 hr ago",messageCount:2,messages:[{prototype:!0,id:"msg-nd-01",author:"user",timestamp:"10:31",body:"Support is furious. They write a long reply, the session expires, and the draft is gone. Three people today."},{prototype:!0,id:"msg-nd-02",author:"forge",timestamp:"10:38",model:"forge-runtime · high effort",skills:["forge-fullstack","security-review"],body:`Two problems wearing one coat, and they need opposite fixes.

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
lives in browser storage and Security Boss will want to scope that.`,steps:[{id:"step-nd-02-a",label:"Reproduce the loss",status:"completed",detail:"Draft is held in component state only. Expiry unmounts the composer and the text goes with it.",agent:"Build Boss"},{id:"step-nd-02-b",label:"Scope local draft storage",status:"blocked",detail:"Needs a decision from the owner: an unsent customer reply persisted in browser storage is a new surface, however small.",agent:"Security Boss"}]}]},{prototype:!0,id:"conv-n8n-error-branch",projectId:"proj-n8n",title:"Nine workflows have retries but no error branch",updatedAt:"38 min ago",messageCount:2,messages:[{prototype:!0,id:"msg-n8n-01",author:"user",timestamp:"09:10",body:"Validate the whole suite before I hand it to the team. If something is not production-ready I want to know now, not in three weeks."},{prototype:!0,id:"msg-n8n-02",author:"forge",timestamp:"09:13",model:"forge-runtime · high effort",skills:["forge-n8n","forge-verify"],body:`**22 of 31 pass. Nine do not, and they fail the same way.**

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
person trust it.`,attachments:[{id:"att-n8n-report",name:"workflow-validation.md",kind:"markdown",size:"12.6 KB"}]}]}],w=[{prototype:!0,id:"evt-01",runId:"run-oac-0841",timestamp:"2026-07-24 15:47:12",kind:"system",agent:null,status:"running",message:"Heartbeat: every dispatched agent reported within the window",detail:"Fourteen agents dispatched, fourteen seen in the last ten minutes. No lane is silent, so nothing is being waited on by accident."},{prototype:!0,id:"evt-02",runId:"run-oac-0841",timestamp:"2026-07-24 15:46:50",kind:"task",agent:"Build Boss",status:"running",message:"Repair attempt 2 started with a cleared output directory",detail:"The first attempt captured against a warm dev server and reproduced the same stale hash. This one deletes dist/ first and captures from a fresh production build."},{prototype:!0,id:"evt-03",runId:"run-oac-0841",timestamp:"2026-07-24 15:45:33",kind:"task",agent:"Build Boss",status:"running",message:"Availability calculator: duplicate slot edge case open",detail:"Two barbers offering the same service in overlapping windows currently emit the slot twice. Collapsing by barber rather than by service is the fix in progress."},{prototype:!0,id:"evt-04",runId:"run-oac-0841",timestamp:"2026-07-24 15:44:19",kind:"task",agent:"UI Boss",status:"running",message:"Service menu aligned to a shared baseline",detail:"Price and duration now sit on one optical column so the menu can be scanned instead of read row by row."},{prototype:!0,id:"evt-05",runId:"run-oac-0841",timestamp:"2026-07-24 15:39:27",kind:"verify",agent:"Verify Agent",status:"verify",message:"Screenshot re-check in progress",detail:"Comparing the build hash in the capture footer against the hash the mobile journey ran on. One comparison, no interpretation."},{prototype:!0,id:"evt-06",runId:"run-oac-0841",timestamp:"2026-07-24 15:31:05",kind:"review",agent:"Security Boss",status:"review",message:"Permission audit submitted for review",detail:"Three agents held write access this run. Recommendation attached: drop Integration Boss to standard, since elevated was granted for a send step that never executed."},{prototype:!0,id:"evt-07",runId:"run-oac-0841",timestamp:"2026-07-24 15:29:11",kind:"review",agent:"Review Boss",status:"completed",message:"Review Boss approved the WP2 interface pass",detail:"Type scale, spacing rhythm and copy accepted without changes. Approval is scoped to the interface package — the mobile defect is tracked separately and does not inherit this pass."},{prototype:!0,id:"evt-08",runId:"run-oac-0841",timestamp:"2026-07-24 15:22:48",kind:"test",agent:"Docs Boss",status:"completed",message:"Markdown lint passed on eleven documents",detail:"Nine were clean on the first pass. Two skipped a heading level, which reads fine to a person and badly to a screen reader; both corrected."},{prototype:!0,id:"evt-09",runId:"run-oac-0841",timestamp:"2026-07-24 15:16:02",kind:"test",agent:"Test Boss",status:"completed",message:"Accessibility re-run passed — both serious findings closed",detail:"Slot buttons now carry an accessible name including the barber and service, and the step indicator announces on change. Zero serious violations remain."},{prototype:!0,id:"evt-10",runId:"run-oac-0841",timestamp:"2026-07-24 15:12:36",kind:"artifact",agent:"Test Boss",status:"completed",message:"Screenshot added: playwright-desktop.png",detail:"Confirmation step at 1440 x 900, captured from the production build. Footer hash matches the build the journey ran against."},{prototype:!0,id:"evt-11",runId:"run-oac-0841",timestamp:"2026-07-24 15:08:14",kind:"test",agent:"Test Boss",status:"completed",message:"Retest passed: desktop journey clean on the current build",detail:"Eleven steps from landing to confirmation, 6.4s. Re-run was required because the earlier pass predated the form state fix."},{prototype:!0,id:"evt-12",runId:"run-oac-0841",timestamp:"2026-07-24 14:57:40",kind:"task",agent:"Docs Boss",status:"review",message:"README and setup notes rewritten",detail:"Ordered for a machine with nothing installed. Payment and mail are named as unfinished in the opening section rather than in a closing note."},{prototype:!0,id:"evt-13",runId:"run-oac-0841",timestamp:"2026-07-24 14:51:07",kind:"test",agent:"Build Boss",status:"completed",message:"Local checks clean: typecheck, lint, build",detail:"Build hash 9f2d07c recorded as the reference every screenshot footer is matched against for the rest of this run."},{prototype:!0,id:"evt-14",runId:"run-oac-0841",timestamp:"2026-07-24 14:38:22",kind:"task",agent:"Build Boss",status:"review",message:"Four-step booking form entered self-review",detail:"State survives a refresh and the back button steps backwards inside the flow. Self-review raised one issue: the taken-slot error names the slot but offers no alternative."},{prototype:!0,id:"evt-15",runId:"run-oac-0841",timestamp:"2026-07-24 14:09:30",kind:"work-package",agent:"Head Chef",status:"verify",message:"WP7 created — Repair loop: mobile evidence",detail:"Opened by the verify loop rather than by a person. Three tasks: rebuild, recapture and re-check, with the hash comparison as the acceptance criterion."},{prototype:!0,id:"evt-16",runId:"run-oac-0841",timestamp:"2026-07-24 14:09:12",kind:"task",agent:"Head Chef",status:"running",message:"Repair task created: rebuild before capturing mobile evidence",detail:"task-20 assigned to Build Boss. The task exists because the evidence was stale, not because the implementation was wrong."},{prototype:!0,id:"evt-17",runId:"run-oac-0841",timestamp:"2026-07-24 14:07:55",kind:"verify",agent:"Verify Agent",status:"failed",message:"Claim rejected — evidence does not show the current build",detail:"The attached screenshot carries build hash 4c1e9ab in its footer; the journey ran against 9f2d07c. The capture shows the previous build, so it cannot support the claim."},{prototype:!0,id:"evt-18",runId:"run-oac-0841",timestamp:"2026-07-24 14:05:31",kind:"task",agent:"Build Boss",status:"review",message:"Completion claimed for the mobile booking step",detail:"Claim submitted with one screenshot and no trace. Sent straight to the Verify Agent, which is where it stopped."},{prototype:!0,id:"evt-19",runId:"run-oac-0841",timestamp:"2026-07-24 14:03:02",kind:"artifact",agent:"Test Boss",status:"failed",message:"Screenshot added: playwright-mobile.png",detail:"Failure state at 390 x 844 — the sticky summary bar sits over the last two slot rows. Captured automatically at the point of failure, with the trace beside it."},{prototype:!0,id:"evt-20",runId:"run-oac-0841",timestamp:"2026-07-24 14:02:16",kind:"test",agent:"Test Boss",status:"failed",message:"Playwright mobile journey failed at step 3",detail:"At 390 x 844 the confirm button is present in the DOM but never hit-testable. Reproduced three times out of three, so this is a defect and not a flaky selector."},{prototype:!0,id:"evt-21",runId:"run-oac-0841",timestamp:"2026-07-24 13:44:09",kind:"review",agent:"Security Boss",status:"completed",message:"Secret scan clean across 214 tracked files",detail:"One near-miss reported rather than silently cleared: a sample key shape in the setup notes. The matching line is quoted in the report so the judgement can be checked."},{prototype:!0,id:"evt-22",runId:"run-oac-0841",timestamp:"2026-07-24 13:36:41",kind:"test",agent:"Test Boss",status:"completed",message:"Slot engine unit tests passed — 41 cases",detail:"Includes the closing-time boundary, a booking made from another timezone, and the daylight-saving jump that used to create a 25-hour Sunday."},{prototype:!0,id:"evt-23",runId:"run-oac-0841",timestamp:"2026-07-24 13:05:18",kind:"task",agent:"SEO Boss",status:"waiting",message:"Structured data drafted, three fields left empty",detail:"Opening hours, price range and telephone are unknown. Publishing invented values as structured data would make a wrong answer machine-readable, so the fields stay blank."},{prototype:!0,id:"evt-24",runId:"run-oac-0841",timestamp:"2026-07-24 12:47:03",kind:"task",agent:"Payment Integration",status:"blocked",message:"Deposit payment blocked — no test credentials",detail:"Checkout session and webhook signature verification are written and unexercised. The task stays blocked rather than green: nobody has run this code path once."},{prototype:!0,id:"evt-25",runId:"run-oac-0841",timestamp:"2026-07-24 12:10:44",kind:"task",agent:"Integration Boss",status:"waiting",message:"Confirmation mail parked at the send step",detail:"Template renders and the ICS attachment opens in three calendar clients. There is no configured sender, and inventing one would produce a passing task that mails nobody."},{prototype:!0,id:"evt-26",runId:"run-oac-0841",timestamp:"2026-07-24 11:20:00",kind:"work-package",agent:"Head Chef",status:"running",message:"WP4 opened — test suite and browser journeys",detail:"Four tasks handed to Test Boss with one standing instruction: every failure ships with a trace and a named viewport."},{prototype:!0,id:"evt-27",runId:"run-oac-0841",timestamp:"2026-07-24 11:14:52",kind:"task",agent:"Build Boss",status:"completed",message:"Data model approved — slots belong to a barber",detail:"Four tables. Service duration and buffer time are separate fields, because a beard trim and a full cut do not clean up in the same ten minutes."},{prototype:!0,id:"evt-28",runId:"run-oac-0841",timestamp:"2026-07-24 10:58:33",kind:"task",agent:"UI Boss",status:"completed",message:"Type scale and spacing rhythm settled",detail:"Five steps on a 4px grid. The display size came down twice — at the original size the headline outshouted the one control the page exists for."},{prototype:!0,id:"evt-29",runId:"run-oac-0841",timestamp:"2026-07-24 10:24:05",kind:"agent",agent:"Head Chef",status:"running",message:"Six lanes activated in parallel",detail:"Search, Build, UI, Test, Security and Docs dispatched together off one plan. Lane order was chosen so no agent waits on another lane for its first task."},{prototype:!0,id:"evt-30",runId:"run-oac-0841",timestamp:"2026-07-24 10:23:10",kind:"work-package",agent:"Head Chef",status:"running",message:"WP2 through WP6 created",detail:"Interface, booking engine, tests, security and documentation. Each carries a named owner and an acceptance list that a stranger could check."},{prototype:!0,id:"evt-31",runId:"run-oac-0841",timestamp:"2026-07-24 10:22:44",kind:"artifact",agent:"Head Chef",status:"completed",message:"Artifact added: mission-blueprint.md",detail:"Seven work packages, thirty tasks, the dependency order and the reasoning behind keeping payment off the critical path."},{prototype:!0,id:"evt-32",runId:"run-oac-0841",timestamp:"2026-07-24 10:22:19",kind:"mission",agent:"Head Chef",status:"completed",message:"Mission blueprint written",detail:"The plan answers the request that was made rather than the more interesting one nearby: this is a booking site, not a salon platform."},{prototype:!0,id:"evt-33",runId:"run-oac-0841",timestamp:"2026-07-24 09:58:07",kind:"artifact",agent:"Search Boss",status:"completed",message:"Artifact added: competitor-scan.md",detail:"Twelve flows, each with the step it lost the visitor at. Three patterns recommended, two rejected — including the account wall before availability."},{prototype:!0,id:"evt-34",runId:"run-oac-0841",timestamp:"2026-07-24 09:31:48",kind:"task",agent:"Search Boss",status:"completed",message:"Reference sweep completed — twelve flows read",detail:"Nine of the twelve were walked on a phone-sized viewport, because that is where the traffic is and where the flows tend to break."},{prototype:!0,id:"evt-35",runId:"run-n8n-0715",timestamp:"2026-07-24 09:13:22",kind:"verify",agent:"Integration Boss",status:"verify",message:"Nine workflows missing an error branch",detail:"Twenty-two of thirty-one validate cleanly. The remaining nine have a retry policy but nothing downstream of a permanent failure, so a dead run disappears silently."},{prototype:!0,id:"evt-36",runId:"run-oac-0841",timestamp:"2026-07-24 08:53:20",kind:"task",agent:"Search Boss",status:"running",message:"Research started: twelve barbershop booking flows",detail:"Public, published pages only. The brief was to record what each flow asks for and in which order, not to copy a layout."},{prototype:!0,id:"evt-37",runId:"run-oac-0841",timestamp:"2026-07-24 08:53:02",kind:"agent",agent:"Search Boss",status:"running",message:"Search Boss dispatched with read-only permission",detail:"Context gathering never needs write access. The lane can read the tree and the web and can change neither."},{prototype:!0,id:"evt-38",runId:"run-oac-0841",timestamp:"2026-07-24 08:52:35",kind:"work-package",agent:"Head Chef",status:"running",message:"WP1 created — Intake and reference sweep",detail:"First package of the mission. Nothing is designed or written until the intake answers and the reference sweep are both on the table."},{prototype:!0,id:"evt-39",runId:"run-oac-0841",timestamp:"2026-07-24 08:52:11",kind:"mission",agent:"Boss",status:"completed",message:"Intake answers recorded — six of six",detail:"Three barbers, seven services, a 20% deposit, closed Sundays, no account required, and a no-show policy that keeps the deposit."},{prototype:!0,id:"evt-40",runId:"run-oac-0841",timestamp:"2026-07-24 08:41:02",kind:"mission",agent:"Boss",status:"running",message:"Mission created: premium booking website for a barbershop",detail:'Routed to the website playbook at complexity L3. Intake first — the word "premium" means nothing until the shop says what it means to them.'},{prototype:!0,id:"evt-41",runId:"run-fei-1902",timestamp:"2026-07-24 07:46:33",kind:"review",agent:"Data Scientist",status:"review",message:"Backtest complete — edge thinner than the previous run claimed",detail:"1,842 fixtures against closing odds. The measured edge is 1.8%, not the 4.1% reported in June, and two leagues carry almost all of it."},{prototype:!0,id:"evt-42",runId:"run-acf-2213",timestamp:"2026-07-23 22:41:19",kind:"test",agent:"Integration Boss",status:"failed",message:"Importer run failed — 218 variants dropped",detail:"The upstream feed moved size and colour from attributes into a nested options array. The importer read the old path, found nothing, and treated a full variant set as an empty one."}],y=[{prototype:!0,id:"fn-src",name:"src",path:"src",kind:"dir",updatedAt:"2026-07-24 15:45",children:[{prototype:!0,id:"fn-src-booking",name:"booking",path:"src/booking",kind:"dir",updatedAt:"2026-07-24 15:45",children:[{prototype:!0,id:"fn-slots-ts",name:"slots.ts",path:"src/booking/slots.ts",kind:"file",changed:"modified",size:"8.4 KB",updatedAt:"2026-07-24 15:45",diff:`--- a/src/booking/slots.ts
+++ b/src/booking/slots.ts
@@ -142,11 +142,19 @@ export function slotsForDay(
-  // Collapse by service. Two barbers offering the same service used to
-  // produce the same slot twice.
-  const seen = new Set<string>();
-  return raw.filter((slot) => {
-    const key = slot.startsAt + ':' + slot.serviceId;
-    if (seen.has(key)) return false;
-    seen.add(key);
-    return true;
-  });
+  // Collapse by barber, not by service. A slot belongs to a person: two
+  // barbers free at 14:00 are two bookable slots, not one duplicate.
+  const seen = new Set<string>();
+  return raw.filter((slot) => {
+    const key = slot.startsAt + ':' + slot.barberId;
+    if (seen.has(key)) return false;
+    seen.add(key);
+    return true;
+  });
 }`},{prototype:!0,id:"fn-availability-ts",name:"availability.ts",path:"src/booking/availability.ts",kind:"file",changed:"modified",size:"6.1 KB",updatedAt:"2026-07-24 15:31",diff:`--- a/src/booking/availability.ts
+++ b/src/booking/availability.ts
@@ -71,8 +71,12 @@ function fits(service: Service, window: Window): boolean {
-  return service.durationMinutes <= window.lengthMinutes;
+  // Buffer time is not part of the service duration. A 20-minute trim still
+  // needs the chair swept before the next person sits in it.
+  const needed = service.durationMinutes + service.bufferMinutes;
+  return needed <= window.lengthMinutes;
 }`},{prototype:!0,id:"fn-booking-form",name:"BookingForm.tsx",path:"src/booking/BookingForm.tsx",kind:"file",changed:"modified",size:"11.7 KB",updatedAt:"2026-07-24 14:38"},{prototype:!0,id:"fn-slot-grid",name:"SlotGrid.tsx",path:"src/booking/SlotGrid.tsx",kind:"file",changed:"added",size:"5.3 KB",updatedAt:"2026-07-24 15:16"},{prototype:!0,id:"fn-pricing-ts",name:"pricing.ts",path:"src/booking/pricing.ts",kind:"file",size:"3.2 KB",updatedAt:"2026-07-24 12:04"},{prototype:!0,id:"fn-validation-ts",name:"validation.ts",path:"src/booking/validation.ts",kind:"file",changed:"modified",size:"4.0 KB",updatedAt:"2026-07-24 13:52"}]},{prototype:!0,id:"fn-src-components",name:"components",path:"src/components",kind:"dir",updatedAt:"2026-07-24 15:44",children:[{prototype:!0,id:"fn-hero-tsx",name:"Hero.tsx",path:"src/components/Hero.tsx",kind:"file",changed:"added",size:"4.6 KB",updatedAt:"2026-07-24 15:44"},{prototype:!0,id:"fn-service-menu",name:"ServiceMenu.tsx",path:"src/components/ServiceMenu.tsx",kind:"file",changed:"added",size:"6.9 KB",updatedAt:"2026-07-24 15:44"},{prototype:!0,id:"fn-summary-bar",name:"SummaryBar.tsx",path:"src/components/SummaryBar.tsx",kind:"file",changed:"modified",size:"3.8 KB",updatedAt:"2026-07-24 15:46",diff:`--- a/src/components/SummaryBar.tsx
+++ b/src/components/SummaryBar.tsx
@@ -18,7 +18,7 @@ export function SummaryBar({ booking }: Props) {
   return (
-    <div className="bk-summary-bar" role="status">
+    <div className="bk-summary-bar" role="status" data-sticky="true">
       <span className="bk-summary-bar__service">{booking.serviceName}</span>
       <span className="bk-summary-bar__time">{booking.startsAtLabel}</span>
     </div>
   );
 }`},{prototype:!0,id:"fn-step-indicator",name:"StepIndicator.tsx",path:"src/components/StepIndicator.tsx",kind:"file",changed:"modified",size:"2.7 KB",updatedAt:"2026-07-24 15:16"}]},{prototype:!0,id:"fn-src-styles",name:"styles",path:"src/styles",kind:"dir",updatedAt:"2026-07-24 15:46",children:[{prototype:!0,id:"fn-booking-css",name:"booking.css",path:"src/styles/booking.css",kind:"file",changed:"modified",size:"9.2 KB",updatedAt:"2026-07-24 15:46",diff:`--- a/src/styles/booking.css
+++ b/src/styles/booking.css
@@ -204,6 +204,15 @@
 .bk-summary-bar[data-sticky='true'] {
   position: sticky;
   bottom: 0;
 }
+
+/* The slot grid scrolled under the sticky bar and took the confirm button
+   with it. Reserve the bar's height so the last two rows stay reachable. */
+.bk-slot-grid {
+  padding-block-end: calc(var(--bk-summary-bar-height) + 1rem);
+}
+
+@media (prefers-reduced-motion: reduce) {
+  .bk-slot-grid { scroll-behavior: auto; }
+}`},{prototype:!0,id:"fn-hero-css",name:"hero.css",path:"src/styles/hero.css",kind:"file",changed:"added",size:"3.4 KB",updatedAt:"2026-07-24 15:44"},{prototype:!0,id:"fn-type-css",name:"type.css",path:"src/styles/type.css",kind:"file",changed:"modified",size:"2.2 KB",updatedAt:"2026-07-24 10:58"}]},{prototype:!0,id:"fn-app-tsx",name:"App.tsx",path:"src/App.tsx",kind:"file",changed:"modified",size:"2.9 KB",updatedAt:"2026-07-24 14:38"},{prototype:!0,id:"fn-main-tsx",name:"main.tsx",path:"src/main.tsx",kind:"file",size:"0.6 KB",updatedAt:"2026-07-24 10:31"}]},{prototype:!0,id:"fn-tests",name:"tests",path:"tests",kind:"dir",updatedAt:"2026-07-24 14:02",children:[{prototype:!0,id:"fn-tests-e2e",name:"e2e",path:"tests/e2e",kind:"dir",updatedAt:"2026-07-24 14:02",children:[{prototype:!0,id:"fn-e2e-desktop",name:"booking.desktop.spec.ts",path:"tests/e2e/booking.desktop.spec.ts",kind:"file",changed:"modified",size:"5.8 KB",updatedAt:"2026-07-24 15:08"},{prototype:!0,id:"fn-e2e-mobile",name:"booking.mobile.spec.ts",path:"tests/e2e/booking.mobile.spec.ts",kind:"file",changed:"added",size:"6.2 KB",updatedAt:"2026-07-24 14:02",diff:`--- a/tests/e2e/booking.mobile.spec.ts
+++ b/tests/e2e/booking.mobile.spec.ts
@@ -48,6 +48,11 @@ test('full journey at 390x844', async ({ page }) => {
-  await page.getByRole('button', { name: 'Confirm booking' }).click();
+  // "Present in the DOM" is not the same as "a thumb can reach it". Assert
+  // both before clicking, so the failure names the real problem.
+  const confirm = page.getByRole('button', { name: 'Confirm booking' });
+  await expect(confirm).toBeVisible();
+  await expect(confirm).toBeInViewport();
+  await confirm.click();

   await expect(page.getByText('Booking confirmed')).toBeVisible();
 });`},{prototype:!0,id:"fn-e2e-shots",name:"screenshots.spec.ts",path:"tests/e2e/screenshots.spec.ts",kind:"file",size:"2.4 KB",updatedAt:"2026-07-24 15:12"}]},{prototype:!0,id:"fn-tests-unit",name:"unit",path:"tests/unit",kind:"dir",updatedAt:"2026-07-24 13:36",children:[{prototype:!0,id:"fn-unit-slots",name:"slots.test.ts",path:"tests/unit/slots.test.ts",kind:"file",changed:"modified",size:"12.9 KB",updatedAt:"2026-07-24 13:36"},{prototype:!0,id:"fn-unit-pricing",name:"pricing.test.ts",path:"tests/unit/pricing.test.ts",kind:"file",size:"4.1 KB",updatedAt:"2026-07-24 12:18"},{prototype:!0,id:"fn-unit-legacy",name:"legacy-slots.test.ts",path:"tests/unit/legacy-slots.test.ts",kind:"file",changed:"deleted",size:"—",updatedAt:"2026-07-24 11:47"}]}]},{prototype:!0,id:"fn-docs",name:"docs",path:"docs",kind:"dir",updatedAt:"2026-07-24 15:22",children:[{prototype:!0,id:"fn-docs-setup",name:"setup.md",path:"docs/setup.md",kind:"file",changed:"modified",size:"7.3 KB",updatedAt:"2026-07-24 15:22"},{prototype:!0,id:"fn-docs-handoff",name:"handoff.md",path:"docs/handoff.md",kind:"file",changed:"added",size:"4.8 KB",updatedAt:"2026-07-24 15:22"},{prototype:!0,id:"fn-docs-decisions",name:"decisions.md",path:"docs/decisions.md",kind:"file",changed:"modified",size:"5.5 KB",updatedAt:"2026-07-24 14:09"}]},{prototype:!0,id:"fn-artifacts",name:"artifacts",path:"artifacts",kind:"dir",updatedAt:"2026-07-24 15:12",children:[{prototype:!0,id:"fn-art-desktop-png",name:"playwright-desktop.png",path:"artifacts/playwright-desktop.png",kind:"file",changed:"added",size:"412 KB",updatedAt:"2026-07-24 15:12"},{prototype:!0,id:"fn-art-mobile-png",name:"playwright-mobile.png",path:"artifacts/playwright-mobile.png",kind:"file",changed:"added",size:"286 KB",updatedAt:"2026-07-24 14:03"},{prototype:!0,id:"fn-art-receipt",name:"build-receipt.txt",path:"artifacts/build-receipt.txt",kind:"file",changed:"added",size:"1.3 KB",updatedAt:"2026-07-24 14:51"}]},{prototype:!0,id:"fn-public",name:"public",path:"public",kind:"dir",updatedAt:"2026-07-24 10:31",children:[{prototype:!0,id:"fn-public-fonts",name:"fonts",path:"public/fonts",kind:"dir",updatedAt:"2026-07-24 10:31",children:[{prototype:!0,id:"fn-font-display",name:"display-var.woff2",path:"public/fonts/display-var.woff2",kind:"file",changed:"added",size:"68 KB",updatedAt:"2026-07-24 10:31"},{prototype:!0,id:"fn-font-text",name:"text-var.woff2",path:"public/fonts/text-var.woff2",kind:"file",changed:"added",size:"74 KB",updatedAt:"2026-07-24 10:31"}]},{prototype:!0,id:"fn-favicon",name:"favicon.svg",path:"public/favicon.svg",kind:"file",changed:"added",size:"1.1 KB",updatedAt:"2026-07-24 10:44"}]},{prototype:!0,id:"fn-readme",name:"README.md",path:"README.md",kind:"file",changed:"modified",size:"6.7 KB",updatedAt:"2026-07-24 14:57",diff:`--- a/README.md
+++ b/README.md
@@ -1,10 +1,16 @@
 # Barbershop booking

-A booking site for a barbershop.
+A booking site for a three-chair barbershop: pick a service, pick a time,
+leave a name, done. No account, no redirect, no countdown timer.
+
+## Not finished yet
+
+Two things do not work, and they are named here rather than at the bottom:
+
+- **Deposit payment** — written against the documented contract, never once
+  executed, because no test credentials were provided.
+- **Confirmation email** — renders correctly and cannot be sent; there is no
+  configured sender.

 ## Running it locally`},{prototype:!0,id:"fn-package-json",name:"package.json",path:"package.json",kind:"file",changed:"modified",size:"1.8 KB",updatedAt:"2026-07-24 13:20"},{prototype:!0,id:"fn-env-example",name:".env.example",path:".env.example",kind:"file",changed:"modified",size:"0.4 KB",updatedAt:"2026-07-24 12:47"}],o=2.5,k=[{prototype:!0,id:"lane-search",label:"Search Boss",group:"context"},{prototype:!0,id:"lane-build",label:"Build Boss",group:"execution"},{prototype:!0,id:"lane-ui",label:"UI Boss",group:"execution"},{prototype:!0,id:"lane-test",label:"Test Boss",group:"review"},{prototype:!0,id:"lane-security",label:"Security Boss",group:"review"},{prototype:!0,id:"lane-docs",label:"Docs Boss",group:"domain"}],v=[{prototype:!0,id:"gn-request",label:"User Request",kind:"request",status:"completed",col:0,row:o,laneId:null,duration:"—",detail:'One sentence from the owner: "Build a premium booking website for a barbershop." Everything to the right of this node is an interpretation of it, which is why intake came before planning.'},{prototype:!0,id:"gn-boss",label:"Boss",kind:"boss",status:"running",col:1,row:o,laneId:null,agent:"Boss",duration:"7h 06m",model:"forge-runtime · max effort",skills:["forge-router","forge-intake"],detail:"Classified the request as a website build at complexity L3 and opened a single intake round. Holds the mission open until the evidence matches the claims — it has already refused one completion."},{prototype:!0,id:"gn-head-chef",label:"Head Chef",kind:"head-chef",status:"running",col:2,row:o,laneId:null,agent:"Head Chef",duration:"24m",model:"forge-runtime · high effort",skills:["forge-prd","forge-mindmap"],detail:"Cut the mission into seven work packages and six parallel lanes, ordered so no lane waits on another for its first task. Re-cut the plan once after review sent WP4 back."},{prototype:!0,id:"gn-search-1",label:"Gather context",kind:"lane-agent",status:"completed",col:3,row:0,laneId:"lane-search",agent:"Search Boss",duration:"18m",model:"forge-runtime · medium effort",skills:["forge-deeplearn"],detail:"Read the intake answers and the existing front-end kit before looking outward, so the reference sweep knew what already existed and did not recommend rebuilding it."},{prototype:!0,id:"gn-search-2",label:"Inspect sources",kind:"step",status:"completed",col:4,row:0,laneId:"lane-search",agent:"Search Boss",duration:"39m",model:"forge-runtime · medium effort",skills:["forge-scraping"],detail:"Twelve published booking flows walked end to end, nine of them at 390px. Public pages only, recorded by what each flow asks for and in which order."},{prototype:!0,id:"gn-search-3",label:"Research report",kind:"step",status:"completed",col:5,row:0,laneId:"lane-search",agent:"Search Boss",duration:"27m",model:"forge-runtime · medium effort",skills:["forge-rag"],detail:"Three patterns recommended, two rejected, and one gap reported: none of the twelve stated a deposit policy before the payment screen."},{prototype:!0,id:"gn-build-1",label:"Architecture",kind:"lane-agent",status:"completed",col:3,row:1,laneId:"lane-build",agent:"Build Boss",duration:"50m",model:"forge-runtime · high effort",skills:["forge-fullstack"],detail:"Four tables and one rule that decided the rest: a slot belongs to a barber, never to the shop. Service duration and buffer time modelled separately."},{prototype:!0,id:"gn-build-2",label:"Implementation",kind:"step",status:"running",col:4,row:1,laneId:"lane-build",agent:"Build Boss",duration:"4h 31m",model:"forge-runtime · high effort",skills:["forge-fullstack","forge-website"],detail:"Availability calculator and the four-step form. Currently collapsing duplicate slots by barber instead of by service — the fix loop routes back into this node."},{prototype:!0,id:"gn-build-3",label:"Local checks",kind:"step",status:"verify",col:5,row:1,laneId:"lane-build",agent:"Build Boss",duration:"36s",model:"forge-runtime · high effort",skills:["forge-verify"],detail:"Typecheck, lint and build, clean on all three. Emits the build hash that every screenshot footer is matched against downstream."},{prototype:!0,id:"gn-ui-1",label:"Design pass",kind:"lane-agent",status:"completed",col:3,row:2,laneId:"lane-ui",agent:"UI Boss",duration:"34m",model:"forge-runtime · high effort",skills:["forge-website","artifact-design"],detail:"One type scale, five steps, a 4px grid. The display size came down twice so the headline stopped competing with the only control that matters."},{prototype:!0,id:"gn-ui-2",label:"Responsive pass",kind:"step",status:"running",col:4,row:2,laneId:"lane-ui",agent:"UI Boss",duration:"1h 12m",model:"forge-runtime · high effort",skills:["forge-website","gsap"],detail:"360, 768 and 1440. The known risk is the slot grid, which is the section the mobile journey already broke on."},{prototype:!0,id:"gn-ui-3",label:"Screenshot review",kind:"step",status:"verify",col:5,row:2,laneId:"lane-ui",agent:"UI Boss",duration:"38s",model:"forge-runtime · high effort",skills:["artifact-design"],detail:"Desktop capture accepted. The mobile capture is held rather than failed: its build hash does not match the tested build, so it supports no conclusion at all."},{prototype:!0,id:"gn-test-1",label:"Unit tests",kind:"lane-agent",status:"completed",col:3,row:3,laneId:"lane-test",agent:"Test Boss",duration:"4.1s",model:"forge-runtime · high effort",skills:["forge-verify"],detail:"Eighty-two cases across slots, pricing and validation. The expensive ones are the boundaries: closing time, timezone drift, the daylight-saving Sunday."},{prototype:!0,id:"gn-test-2",label:"Browser tests",kind:"step",status:"failed",col:4,row:3,laneId:"lane-test",agent:"Test Boss",duration:"1m 12s",model:"forge-runtime · high effort",skills:["forge-verify","ship-readiness"],detail:"Desktop passes in 6.4s. Mobile fails at step 3 on 390 x 844 — the confirm button is present in the DOM and never hit-testable. Reproduced three times out of three."},{prototype:!0,id:"gn-test-3",label:"Bug report",kind:"step",status:"completed",col:5,row:3,laneId:"lane-test",agent:"Test Boss",duration:"11m",model:"forge-runtime · high effort",skills:["forge-report"],detail:'Names the viewport, the intercepting element and the exact locator, with a trace and a video attached. No sentence in it contains the phrase "mobile is off".'},{prototype:!0,id:"gn-sec-1",label:"Secret scan",kind:"lane-agent",status:"completed",col:3,row:4,laneId:"lane-security",agent:"Security Boss",duration:"27.3s",model:"forge-runtime · high effort",skills:["security-review","forge-doctor"],detail:"214 tracked files, zero live credentials. One near-miss quoted in full with its line number instead of being silently cleared."},{prototype:!0,id:"gn-sec-2",label:"Permissions review",kind:"step",status:"review",col:4,row:4,laneId:"lane-security",agent:"Security Boss",duration:"14m",model:"forge-runtime · high effort",skills:["security-review"],detail:"Three agents held write access. Integration Boss was granted elevated permission for a send step that never executed, and the recommendation is to take it back."},{prototype:!0,id:"gn-sec-3",label:"Risk report",kind:"step",status:"waiting",col:5,row:4,laneId:"lane-security",agent:"Security Boss",duration:"—",model:"forge-runtime · high effort",skills:["security-review","forge-integration"],detail:"Waiting on the payment surface. Reviewing code that has never been executed would produce a report about intentions rather than behaviour."},{prototype:!0,id:"gn-docs-1",label:"Update docs",kind:"lane-agent",status:"review",col:3,row:5,laneId:"lane-docs",agent:"Docs Boss",duration:"48m",model:"forge-runtime · medium effort",skills:["forge-report","humanizer"],detail:"README and setup notes rewritten for a machine with nothing installed. The two unfinished areas are named in the opening section, not the closing one."},{prototype:!0,id:"gn-docs-2",label:"Markdown validation",kind:"step",status:"completed",col:4,row:5,laneId:"lane-docs",agent:"Docs Boss",duration:"2.4s",model:"forge-runtime · medium effort",skills:["forge-report"],detail:"Eleven documents, two with skipped heading levels. Both corrected — that pattern reads fine to a person and badly to a screen reader."},{prototype:!0,id:"gn-docs-3",label:"Handoff",kind:"step",status:"waiting",col:5,row:5,laneId:"lane-docs",agent:"Docs Boss",duration:"—",model:"forge-runtime · medium effort",skills:["ship-readiness","forge-report"],detail:"Deliberately last. A handoff written before verification closes would be rewritten within the hour, and the first version would already have been sent."},{prototype:!0,id:"gn-verify",label:"Verify Agent",kind:"verify",status:"verify",col:6,row:o,laneId:null,agent:"Verify Agent",duration:"22 claims",model:"forge-runtime · high effort",skills:["forge-verify","forge-graded-verify"],detail:"Nineteen claims accepted, three rejected, one open. Checks one thing: does the attached evidence show the claim, on the build the claim refers to."},{prototype:!0,id:"gn-review",label:"Review Boss",kind:"review",status:"review",col:7,row:o,laneId:null,agent:"Review Boss",duration:"4m 02s",model:"forge-runtime · max effort",skills:["forge-graded-verify","forge-report"],detail:"Approved WP1 and WP2, requested changes on WP3, reopened WP4. The reopen was not stylistic: the summary claimed a passing mobile journey while the attached run showed a failure."},{prototype:!0,id:"gn-fix",label:"Fix Loop",kind:"fix",status:"running",col:8,row:o,laneId:null,agent:"Head Chef",duration:"1h 37m",model:"forge-runtime · high effort",skills:["forge-verify"],detail:"WP7, opened by the loop rather than by a person: rebuild, recapture, re-run, re-check. Two repair attempts spent, which is the whole budget before the mission escalates to the owner."},{prototype:!0,id:"gn-output",label:"Final Output",kind:"output",status:"waiting",col:9,row:o,laneId:null,duration:"—",detail:"Not reached. The mission cannot close while the mobile journey fails, and the draft final report says so in its second paragraph rather than its last."}],A=[{prototype:!0,id:"ge-req-boss",from:"gn-request",to:"gn-boss",kind:"flow"},{prototype:!0,id:"ge-boss-chef",from:"gn-boss",to:"gn-head-chef",kind:"flow",label:"intake complete"},{prototype:!0,id:"ge-chef-search",from:"gn-head-chef",to:"gn-search-1",kind:"flow"},{prototype:!0,id:"ge-chef-build",from:"gn-head-chef",to:"gn-build-1",kind:"flow"},{prototype:!0,id:"ge-chef-ui",from:"gn-head-chef",to:"gn-ui-1",kind:"flow"},{prototype:!0,id:"ge-chef-test",from:"gn-head-chef",to:"gn-test-1",kind:"flow"},{prototype:!0,id:"ge-chef-sec",from:"gn-head-chef",to:"gn-sec-1",kind:"flow"},{prototype:!0,id:"ge-chef-docs",from:"gn-head-chef",to:"gn-docs-1",kind:"flow"},{prototype:!0,id:"ge-search-1-2",from:"gn-search-1",to:"gn-search-2",kind:"flow"},{prototype:!0,id:"ge-search-2-3",from:"gn-search-2",to:"gn-search-3",kind:"flow"},{prototype:!0,id:"ge-build-1-2",from:"gn-build-1",to:"gn-build-2",kind:"flow"},{prototype:!0,id:"ge-build-2-3",from:"gn-build-2",to:"gn-build-3",kind:"flow"},{prototype:!0,id:"ge-ui-1-2",from:"gn-ui-1",to:"gn-ui-2",kind:"flow"},{prototype:!0,id:"ge-ui-2-3",from:"gn-ui-2",to:"gn-ui-3",kind:"flow"},{prototype:!0,id:"ge-test-1-2",from:"gn-test-1",to:"gn-test-2",kind:"flow"},{prototype:!0,id:"ge-test-2-3",from:"gn-test-2",to:"gn-test-3",kind:"flow"},{prototype:!0,id:"ge-sec-1-2",from:"gn-sec-1",to:"gn-sec-2",kind:"flow"},{prototype:!0,id:"ge-sec-2-3",from:"gn-sec-2",to:"gn-sec-3",kind:"flow"},{prototype:!0,id:"ge-docs-1-2",from:"gn-docs-1",to:"gn-docs-2",kind:"flow"},{prototype:!0,id:"ge-docs-2-3",from:"gn-docs-2",to:"gn-docs-3",kind:"flow"},{prototype:!0,id:"ge-search-verify",from:"gn-search-3",to:"gn-verify",kind:"flow"},{prototype:!0,id:"ge-build-verify",from:"gn-build-3",to:"gn-verify",kind:"flow"},{prototype:!0,id:"ge-ui-verify",from:"gn-ui-3",to:"gn-verify",kind:"flow"},{prototype:!0,id:"ge-test-verify",from:"gn-test-3",to:"gn-verify",kind:"flow"},{prototype:!0,id:"ge-sec-verify",from:"gn-sec-3",to:"gn-verify",kind:"flow"},{prototype:!0,id:"ge-docs-verify",from:"gn-docs-3",to:"gn-verify",kind:"flow"},{prototype:!0,id:"ge-verify-review",from:"gn-verify",to:"gn-review",kind:"flow",label:"19 accepted"},{prototype:!0,id:"ge-review-fix",from:"gn-review",to:"gn-fix",kind:"flow",label:"changes requested"},{prototype:!0,id:"ge-fix-output",from:"gn-fix",to:"gn-output",kind:"flow"},{prototype:!0,id:"ge-review-chef",from:"gn-review",to:"gn-head-chef",kind:"feedback",label:"reopen mission"},{prototype:!0,id:"ge-fix-build",from:"gn-fix",to:"gn-build-2",kind:"feedback",label:"rebuild and recapture"},{prototype:!0,id:"ge-dep-search-build",from:"gn-search-3",to:"gn-build-1",kind:"dependency",label:"patterns"},{prototype:!0,id:"ge-dep-build-ui",from:"gn-build-2",to:"gn-ui-2",kind:"dependency",label:"markup"},{prototype:!0,id:"ge-dep-build-test",from:"gn-build-3",to:"gn-test-2",kind:"dependency",label:"build hash"},{prototype:!0,id:"ge-dep-test-fix",from:"gn-test-3",to:"gn-fix",kind:"dependency",label:"open defect"},{prototype:!0,id:"ge-dep-sec-review",from:"gn-sec-3",to:"gn-review",kind:"dependency",label:"risk sign-off"}],T={prototype:!0,id:"graph-oac-booking",runId:"run-oac-0841",lanes:k,nodes:v,edges:A},B=[{prototype:!0,id:"proj-oac",name:"Acme Bakery Website",description:"The studio site, and the front-end kit every client build is cut from. Monochrome by rule, one type scale, one set of surfaces. Client work starts here as a branch before it earns its own project.",type:"website",status:"running",lastActivity:"4 min ago",path:"C:\\Users\\YOU\\Projects\\acme-bakery-website",templateVersion:"forge-v2 · 2.7.0",pinned:!0,conversationCount:2,missionCount:6,taskCount:30,agentCount:11,skills:["forge-website","forge-verify","gsap","ship-readiness"],health:{tests:{passed:118,failed:1,skipped:4},openTickets:7,blockers:1,score:82}},{prototype:!0,id:"proj-acf",name:"Autonomous Commerce Factory",description:"A storefront that restocks itself. Supplier feeds land every hour, get normalised into one catalogue shape, and a repricing job walks the margin bands overnight. The hard part is never the selling — it is the feeds disagreeing about what a product is.",type:"full-stack",status:"running",lastActivity:"22 min ago",path:"C:\\Users\\YOU\\Projects\\autonomous-commerce-factory",templateVersion:"forge-v2 · 2.7.0",pinned:!0,conversationCount:2,missionCount:14,taskCount:96,agentCount:13,skills:["forge-fullstack","forge-integration","forge-scraping","forge-verify"],health:{tests:{passed:341,failed:6,skipped:12},openTickets:19,blockers:2,score:71}},{prototype:!0,id:"proj-fei",name:"Football Edge Intelligence",description:"Odds ingestion, a value model, and a Telegram bot that refuses to sound more certain than the data allows. Every tip carries a confidence band and the closing-line number it was measured against. Nothing places a bet — the system stops at the recommendation.",type:"prediction",status:"review",lastActivity:"1 hr ago",path:"C:\\Users\\YOU\\Projects\\football-edge-intelligence",templateVersion:"forge-v2 · 2.7.0",pinned:!1,conversationCount:2,missionCount:9,taskCount:58,agentCount:8,skills:["forge-prediction","forge-scraping","forge-graded-verify"],health:{tests:{passed:204,failed:0,skipped:9},openTickets:11,blockers:0,score:88}},{prototype:!0,id:"proj-chatbot",name:"AI Chatbot",description:"A source-aware assistant over a 2,400-document knowledge base. It answers with citations or it says it does not know — the fallback is treated as a feature, not a failure state. Lead capture only fires after a genuinely grounded answer.",type:"chatbot",status:"completed",lastActivity:"3 days ago",path:"C:\\Users\\YOU\\Projects\\ai-chatbot",templateVersion:"forge-v2 · 1.9.4",pinned:!1,conversationCount:1,missionCount:7,taskCount:44,agentCount:7,skills:["forge-rag","forge-graded-verify","forge-evals"],health:{tests:{passed:156,failed:0,skipped:2},openTickets:2,blockers:0,score:95}},{prototype:!0,id:"proj-forge-lab",name:"Forge Research Lab",description:"Where a Forge idea gets tested before it becomes a rule. Current question: does graded verification catch a weak-but-plausible RAG answer that the structural gate waves through? Findings here are provisional by design and are never shipped straight into a playbook.",type:"research",status:"waiting",lastActivity:"2 days ago",path:"C:\\Users\\YOU\\Projects\\forge-research-lab",templateVersion:"forge-v2 · 2.7.0-rc.3",pinned:!1,conversationCount:1,missionCount:4,taskCount:21,agentCount:5,skills:["forge-graded-verify","forge-deeplearn","forge-prd"],health:{tests:{passed:47,failed:2,skipped:18},openTickets:6,blockers:0,score:64}},{prototype:!0,id:"proj-helpdesk",name:"Helpdesk Assistant",description:"An internal helpdesk that drafts ticket replies from the team knowledge base and never sends one unattended. Blocked on the session layer: agents get logged out mid-ticket and the draft goes with them, which is the one failure users will not forgive.",type:"full-stack",status:"blocked",lastActivity:"5 hr ago",path:"C:\\Users\\YOU\\Projects\\helpdesk-ai",templateVersion:"forge-v2 · 2.7.0",pinned:!1,conversationCount:1,missionCount:5,taskCount:37,agentCount:9,skills:["forge-fullstack","forge-rag","forge-integration"],health:{tests:{passed:89,failed:11,skipped:3},openTickets:14,blockers:3,score:48}},{prototype:!0,id:"proj-n8n",name:"n8n Automation Suite",description:"Thirty-one workflows that keep the business running while nobody watches: intake routing, invoice chasing, calendar sync, the nightly digest. Every workflow must carry a retry policy and an error branch before it counts as finished.",type:"automation",status:"verify",lastActivity:"38 min ago",path:"C:\\Users\\YOU\\Projects\\n8n-automation-suite",templateVersion:"forge-v2 · 2.7.0",pinned:!1,conversationCount:1,missionCount:12,taskCount:63,agentCount:6,skills:["forge-n8n","forge-integration","forge-verify"],health:{tests:{passed:127,failed:0,skipped:5},openTickets:9,blockers:0,score:79}}],x=[{prototype:!0,id:"run-oac-0841",projectId:"proj-oac",goal:"Build a premium booking website for a barbershop.",status:"running",startedAt:"2026-07-24 08:41",duration:"7h 06m",workPackageIds:["wp-1","wp-2","wp-3","wp-4","wp-5","wp-6","wp-7"],agentIds:["agent-boss","agent-head-chef","agent-search-boss","agent-ui-boss","agent-build-boss","agent-test-boss","agent-security-boss","agent-docs-boss","agent-seo-boss","agent-integration-boss","agent-payment-integration","agent-verify-agent","agent-review-boss","agent-skill-boss"]},{prototype:!0,id:"run-acf-2213",projectId:"proj-acf",goal:"Recover the supplier feed importer after the upstream schema change dropped product variants.",status:"failed",startedAt:"2026-07-23 22:13",duration:"2h 41m",workPackageIds:["wp-3","wp-4"],agentIds:["agent-boss","agent-head-chef","agent-build-boss","agent-integration-boss","agent-test-boss","agent-verify-agent"]},{prototype:!0,id:"run-fei-1902",projectId:"proj-fei",goal:"Backtest the value model over the 2025/26 season against closing odds and report the honest edge.",status:"review",startedAt:"2026-07-24 04:19",duration:"3h 27m",workPackageIds:["wp-1","wp-4","wp-5"],agentIds:["agent-boss","agent-data-scientist","agent-ml-engineer","agent-test-boss","agent-review-boss"]},{prototype:!0,id:"run-n8n-0715",projectId:"proj-n8n",goal:"Validate every workflow against the node schema and reject any without a retry policy and an error branch.",status:"verify",startedAt:"2026-07-24 07:15",duration:"1h 58m",workPackageIds:["wp-4","wp-5","wp-6"],agentIds:["agent-head-chef","agent-integration-boss","agent-security-boss","agent-docs-boss","agent-verify-agent"]}],I=[{prototype:!0,id:"task-01",title:"Capture the intake answers from the owner",agentId:"agent-boss",workPackageId:"wp-1",phase:"intake",column:"completed",status:"completed",progress:100,dependencies:[],proofCount:2,createdAt:"2026-07-24 08:41",updatedAt:"2026-07-24 08:52",repairAttempts:0,detail:"Six questions, one round: number of barbers, service list and durations, deposit policy, opening hours, whether an account is required, and what happens to a no-show. The answers set the acceptance criteria for every later work package."},{prototype:!0,id:"task-02",title:"Read twelve barbershop booking flows end to end",agentId:"agent-search-boss",workPackageId:"wp-1",phase:"intake",column:"completed",status:"completed",progress:100,dependencies:["task-01"],proofCount:3,createdAt:"2026-07-24 08:52",updatedAt:"2026-07-24 09:31",repairAttempts:0,detail:"Nine of the twelve were walked on a 390px viewport rather than a desktop window, because that is where the real traffic is. Every flow that demanded an account before showing availability was noted with the step it lost the visitor at."},{prototype:!0,id:"task-03",title:"Summarise the booking patterns worth keeping",agentId:"agent-search-boss",workPackageId:"wp-1",phase:"plan",column:"completed",status:"completed",progress:100,dependencies:["task-02"],proofCount:2,createdAt:"2026-07-24 09:31",updatedAt:"2026-07-24 09:58",repairAttempts:0,detail:"Three patterns survived: show availability before asking for anything, keep the barber choice optional, and confirm on the same screen instead of a redirect. Two common patterns were rejected outright, including the account wall."},{prototype:!0,id:"task-04",title:"Write the mission blueprint",agentId:"agent-head-chef",workPackageId:"wp-1",phase:"plan",column:"completed",status:"completed",progress:100,dependencies:["task-03"],proofCount:1,createdAt:"2026-07-24 09:58",updatedAt:"2026-07-24 10:22",repairAttempts:0,detail:"Seven work packages with named owners and acceptance criteria that can be checked by someone who was not in the room. The payment task was deliberately kept off the critical path."},{prototype:!0,id:"task-05",title:"Settle the type scale and spacing rhythm",agentId:"agent-ui-boss",workPackageId:"wp-2",phase:"plan",column:"completed",status:"completed",progress:100,dependencies:["task-04"],proofCount:2,createdAt:"2026-07-24 10:24",updatedAt:"2026-07-24 10:58",repairAttempts:0,detail:"One scale, five steps, a 4px spacing grid. The display size was pulled down twice: at the original size the headline was the loudest thing on a page whose job is to get someone to pick a time."},{prototype:!0,id:"task-06",title:"Build the hero and service menu sections",agentId:"agent-ui-boss",workPackageId:"wp-2",phase:"build",column:"running",status:"running",progress:55,dependencies:["task-05"],proofCount:1,createdAt:"2026-07-24 10:24",updatedAt:"2026-07-24 15:44",repairAttempts:0,detail:"Hero is settled. The service menu is mid-pass: prices and durations are aligned on a shared baseline so the eye can scan the column rather than read every row."},{prototype:!0,id:"task-07",title:"Responsive pass at 360, 768 and 1440",agentId:"agent-ui-boss",workPackageId:"wp-2",phase:"build",column:"planned",status:"waiting",progress:0,dependencies:["task-06"],proofCount:0,createdAt:"2026-07-24 10:24",updatedAt:"2026-07-24 11:02",repairAttempts:0,detail:"Queued behind the service menu. The known risk is the time-slot grid, which is already the section that broke in the mobile journey at 390px."},{prototype:!0,id:"task-08",title:"Screenshot review of the booking step",agentId:"agent-ui-boss",workPackageId:"wp-2",phase:"verify",column:"verify",status:"verify",progress:60,dependencies:["task-06"],proofCount:2,createdAt:"2026-07-24 10:24",updatedAt:"2026-07-24 15:12",repairAttempts:0,detail:"Desktop capture reviewed and accepted. The mobile capture is held: the build hash in its footer does not match the bundle currently on disk, so it proves nothing about the current code."},{prototype:!0,id:"task-09",title:"Motion pass with a reduced-motion fallback",agentId:"agent-ui-boss",workPackageId:"wp-2",phase:"build",column:"backlog",status:"waiting",progress:0,dependencies:["task-07"],proofCount:0,createdAt:"2026-07-24 10:24",updatedAt:"2026-07-24 10:24",repairAttempts:0,detail:"Scope is deliberately small: a fade on section entry and a 120ms slot-selection response. Every rule ships with a prefers-reduced-motion branch or it does not ship."},{prototype:!0,id:"task-10",title:"Model barbers, services and slots",agentId:"agent-build-boss",workPackageId:"wp-3",phase:"plan",column:"completed",status:"completed",progress:100,dependencies:["task-04"],proofCount:2,createdAt:"2026-07-24 10:24",updatedAt:"2026-07-24 11:14",repairAttempts:0,detail:"Four tables and one hard rule: a slot belongs to a barber, never to the shop. Service duration and buffer time are separate fields, because a beard trim and a full cut do not clean up in the same ten minutes."},{prototype:!0,id:"task-11",title:"Implement the availability calculator",agentId:"agent-build-boss",workPackageId:"wp-3",phase:"build",column:"running",status:"running",progress:71,dependencies:["task-10"],proofCount:1,createdAt:"2026-07-24 11:14",updatedAt:"2026-07-24 15:45",repairAttempts:0,detail:"Handles staff leave, service duration, buffer time and the shop closing earlier on Monday. Open edge case: two barbers offering the same service in overlapping windows currently produce duplicate slots."},{prototype:!0,id:"task-12",title:"Wire the four-step booking form",agentId:"agent-build-boss",workPackageId:"wp-3",phase:"build",column:"self-review",status:"review",progress:100,dependencies:["task-11","task-06"],proofCount:3,createdAt:"2026-07-24 11:16",updatedAt:"2026-07-24 14:38",repairAttempts:0,detail:"Service, time, details, confirm. State survives a refresh and the back button steps backwards rather than leaving the flow. Self-review flagged one thing: the error message on a taken slot names the slot but not the alternative."},{prototype:!0,id:"task-13",title:"Deposit payment via Stripe Checkout",agentId:"agent-payment-integration",workPackageId:"wp-3",phase:"build",column:"blocked",status:"blocked",progress:15,dependencies:["task-12"],proofCount:0,createdAt:"2026-07-24 11:16",updatedAt:"2026-07-24 12:47",repairAttempts:1,detail:"Session creation and webhook signature verification are written against the documented contract, and neither has been run. Blocked on test credentials — marking this done without exercising it would be a lie with a green badge."},{prototype:!0,id:"task-14",title:"Confirmation email and calendar invite",agentId:"agent-integration-boss",workPackageId:"wp-3",phase:"build",column:"planned",status:"waiting",progress:30,dependencies:["task-12"],proofCount:0,createdAt:"2026-07-24 11:16",updatedAt:"2026-07-24 12:10",repairAttempts:0,detail:"Template renders and the ICS attachment opens correctly in three calendar clients. The send step is parked: there is no configured sender, and a fake one would produce a passing task that mails nobody."},{prototype:!0,id:"task-15",title:"Local checks: typecheck, lint and build",agentId:"agent-build-boss",workPackageId:"wp-3",phase:"verify",column:"completed",status:"completed",progress:100,dependencies:["task-12"],proofCount:4,createdAt:"2026-07-24 11:16",updatedAt:"2026-07-24 14:51",repairAttempts:0,detail:"Clean on all three. The build hash from this run is what the verify step compares every screenshot footer against — which is how the stale mobile capture was caught."},{prototype:!0,id:"task-16",title:"Unit tests for the slot engine",agentId:"agent-test-boss",workPackageId:"wp-4",phase:"verify",column:"completed",status:"completed",progress:100,dependencies:["task-11"],proofCount:3,createdAt:"2026-07-24 11:20",updatedAt:"2026-07-24 13:36",repairAttempts:0,detail:"Forty-one cases, including the ones that only happen twice a year: the closing-time boundary, a booking made in a different timezone, and the daylight-saving jump that silently created a 25-hour Sunday."},{prototype:!0,id:"task-17",title:"Playwright desktop journey",agentId:"agent-test-boss",workPackageId:"wp-4",phase:"verify",column:"verify",status:"verify",progress:100,dependencies:["task-15"],proofCount:2,createdAt:"2026-07-24 11:20",updatedAt:"2026-07-24 15:08",repairAttempts:0,detail:"Landing to confirmation in eleven steps at 1440 x 900, passing. Waiting on the Verify Agent to match the trace against the build hash before it counts as evidence."},{prototype:!0,id:"task-18",title:"Playwright mobile journey",agentId:"agent-test-boss",workPackageId:"wp-4",phase:"verify",column:"blocked",status:"failed",progress:100,dependencies:["task-15"],proofCount:2,createdAt:"2026-07-24 11:20",updatedAt:"2026-07-24 14:02",repairAttempts:1,detail:"Fails reproducibly at step 3 on 390 x 844: the time-slot grid overlaps the sticky summary bar and the confirm button never becomes clickable. Trace and video attached — this is a real defect, not a flaky selector."},{prototype:!0,id:"task-19",title:"Accessibility sweep with axe",agentId:"agent-test-boss",workPackageId:"wp-4",phase:"verify",column:"verify",status:"verify",progress:90,dependencies:["task-15"],proofCount:1,createdAt:"2026-07-24 11:20",updatedAt:"2026-07-24 15:16",repairAttempts:0,detail:"Two serious findings, both fixed: the slot buttons had no accessible name beyond the time, and the step indicator was not announced on change. Re-run is queued behind the rebuild."},{prototype:!0,id:"task-20",title:"Repair: rebuild before capturing mobile evidence",agentId:"agent-build-boss",workPackageId:"wp-7",phase:"build",column:"running",status:"running",progress:40,dependencies:["task-18"],proofCount:1,createdAt:"2026-07-24 14:09",updatedAt:"2026-07-24 15:46",repairAttempts:2,detail:"Opened by the verify loop, not by a human. First attempt captured against a warm dev server and produced the same stale hash; second attempt clears the output directory first and pins the capture to a fresh production build."},{prototype:!0,id:"task-21",title:"Secret scan across the working tree",agentId:"agent-security-boss",workPackageId:"wp-5",phase:"review",column:"completed",status:"completed",progress:100,dependencies:["task-15"],proofCount:2,createdAt:"2026-07-24 11:22",updatedAt:"2026-07-24 13:44",repairAttempts:0,detail:"Clean across 214 files. One near-miss reported honestly: a sample key shape in the setup notes was matched and then cleared by hand as documentation, and the line is quoted in the report so the judgement can be checked."},{prototype:!0,id:"task-22",title:"Audit the write permissions granted this run",agentId:"agent-security-boss",workPackageId:"wp-5",phase:"review",column:"review",status:"review",progress:100,dependencies:["task-21"],proofCount:1,createdAt:"2026-07-24 11:22",updatedAt:"2026-07-24 15:31",repairAttempts:0,detail:"Three agents held write access this run, two of them read-only by design. Recommendation on the desk: drop Integration Boss to standard once the mail sender exists, because elevated was granted for a step that never ran."},{prototype:!0,id:"task-23",title:"Risk report on the deposit payment surface",agentId:"agent-security-boss",workPackageId:"wp-5",phase:"review",column:"planned",status:"waiting",progress:0,dependencies:["task-13"],proofCount:0,createdAt:"2026-07-24 11:22",updatedAt:"2026-07-24 12:58",repairAttempts:0,detail:"Cannot start meaningfully while the payment task is blocked. Reviewing code that has never been executed would produce a report about intentions rather than behaviour."},{prototype:!0,id:"task-24",title:"Update the README and setup notes",agentId:"agent-docs-boss",workPackageId:"wp-6",phase:"handoff",column:"self-review",status:"review",progress:100,dependencies:["task-15"],proofCount:1,createdAt:"2026-07-24 11:24",updatedAt:"2026-07-24 14:57",repairAttempts:0,detail:"Rewritten around what the owner actually has to do, in order, on a machine with nothing installed. The two unfinished areas — payment and mail — are named in the second paragraph rather than buried at the end."},{prototype:!0,id:"task-25",title:"Markdown lint every generated document",agentId:"agent-docs-boss",workPackageId:"wp-6",phase:"handoff",column:"verify",status:"verify",progress:100,dependencies:["task-24"],proofCount:2,createdAt:"2026-07-24 11:24",updatedAt:"2026-07-24 15:22",repairAttempts:0,detail:"Eleven documents, nine clean on the first pass. Two had heading levels that skipped a step, which reads fine to a person and badly to a screen reader."},{prototype:!0,id:"task-26",title:"Assemble the handoff pack for the owner",agentId:"agent-docs-boss",workPackageId:"wp-6",phase:"handoff",column:"backlog",status:"waiting",progress:0,dependencies:["task-25","task-28"],proofCount:0,createdAt:"2026-07-24 11:24",updatedAt:"2026-07-24 11:24",repairAttempts:0,detail:"Deliberately last. A handoff written before verification closes would have to be rewritten the moment the mobile defect resolves, and the first version would already be in the owner’s inbox."},{prototype:!0,id:"task-27",title:"Re-run the mobile journey on the fresh build",agentId:"agent-test-boss",workPackageId:"wp-7",phase:"verify",column:"planned",status:"waiting",progress:0,dependencies:["task-20"],proofCount:0,createdAt:"2026-07-24 14:09",updatedAt:"2026-07-24 14:09",repairAttempts:0,detail:"Same eleven steps at 390 x 844, plus an explicit assertion that the confirm button is both visible and hit-testable rather than merely present in the DOM."},{prototype:!0,id:"task-28",title:"Verify Agent re-check of the screenshot evidence",agentId:"agent-verify-agent",workPackageId:"wp-7",phase:"review",column:"review",status:"review",progress:50,dependencies:["task-27"],proofCount:1,createdAt:"2026-07-24 14:09",updatedAt:"2026-07-24 15:39",repairAttempts:0,detail:"The check is narrow on purpose: does the hash in the screenshot footer match the build the tests ran against. The first submission failed that single comparison and everything downstream of it stopped."},{prototype:!0,id:"task-29",title:"Structured data for LocalBusiness and Service",agentId:"agent-seo-boss",workPackageId:"wp-2",phase:"build",column:"planned",status:"waiting",progress:20,dependencies:["task-06"],proofCount:0,createdAt:"2026-07-24 10:26",updatedAt:"2026-07-24 13:05",repairAttempts:0,detail:"Schema is drafted and validates against the vocabulary. Three fields are still placeholders and will stay that way: publishing invented opening hours as structured data is a wrong answer machines will repeat."},{prototype:!0,id:"task-30",title:"Record the booking flow as a reusable skill",agentId:"agent-skill-boss",workPackageId:"wp-6",phase:"handoff",column:"backlog",status:"waiting",progress:0,dependencies:["task-26"],proofCount:0,createdAt:"2026-07-24 11:24",updatedAt:"2026-07-24 11:24",repairAttempts:0,detail:"Candidate pattern: availability first, identity last, confirmation on the same screen. It is not worth storing until verification agrees the flow actually worked on a phone."}],S=[{prototype:!0,id:"gate-typecheck",name:"Typecheck",status:"completed",duration:"11.4s",lastRun:"2026-07-24 14:49",evidenceCount:2,output:`EXAMPLE OUTPUT — hand-written, nothing was executed.

$ npm run typecheck
> tsc --noEmit

Found 0 errors in 148 files.

Strict mode on. noUnusedLocals and noUnusedParameters both enabled, which is
why the availability refactor cost four extra minutes and zero later bugs.`},{prototype:!0,id:"gate-lint",name:"Lint",status:"completed",duration:"6.8s",lastRun:"2026-07-24 14:50",evidenceCount:1,output:`EXAMPLE OUTPUT — hand-written, nothing was executed.

$ npm run lint
> eslint .

/src/booking/BookingForm.tsx
  71:9  warning  Unused eslint-disable directive (no problems reported)

1 problem (0 errors, 1 warning)

Directive removed. Re-run clean: 0 problems.`},{prototype:!0,id:"gate-build",name:"Build",status:"completed",duration:"18.2s",lastRun:"2026-07-24 14:51",evidenceCount:3,output:`EXAMPLE OUTPUT — hand-written, nothing was executed.

$ npm run build
vite v7.1.12 building for production...

  dist/index.html                    2.14 kB │ gzip:  0.91 kB
  dist/assets/index-9f2d07c.css     28.60 kB │ gzip:  6.44 kB
  dist/assets/index-9f2d07c.js     186.41 kB │ gzip: 61.22 kB

built in 18.2s   hash 9f2d07c

This hash is the reference every screenshot footer is checked against for the
rest of the run.`},{prototype:!0,id:"gate-unit",name:"Unit tests",status:"completed",duration:"4.1s",lastRun:"2026-07-24 13:36",evidenceCount:3,output:`EXAMPLE OUTPUT — hand-written, nothing was executed.

$ npm run test

 PASS  src/booking/slots.test.ts        (41 tests)  812ms
 PASS  src/booking/pricing.test.ts      (18 tests)  204ms
 PASS  src/booking/validation.test.ts   (23 tests)  341ms

 Test Files  3 passed (3)
      Tests  82 passed (82)
   Duration  4.10s

The three that took longest are the boundary cases: closing time, timezone
drift, and the daylight-saving Sunday.`},{prototype:!0,id:"gate-integration",name:"Integration tests",status:"blocked",duration:"—",lastRun:"2026-07-24 12:47",evidenceCount:0,output:`EXAMPLE OUTPUT — hand-written, nothing was executed.

$ npm run test:integration

 SKIP  payment/checkout.int.test.ts   no test credentials configured
 SKIP  mail/confirmation.int.test.ts  no sender configured

 Test Files  0 passed | 2 skipped (2)

Gate reports BLOCKED rather than PASSED. Two skipped suites are not a green
board, and reporting them as one would be the single most expensive lie
available here.`},{prototype:!0,id:"gate-playwright",name:"Playwright",status:"failed",duration:"1m 12s",lastRun:"2026-07-24 14:02",evidenceCount:4,output:`EXAMPLE OUTPUT — hand-written, nothing was executed.

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

  1 passed, 1 failed`},{prototype:!0,id:"gate-screenshot",name:"Screenshot review",status:"verify",duration:"38s",lastRun:"2026-07-24 15:12",evidenceCount:3,output:`EXAMPLE OUTPUT — hand-written, nothing was executed.

$ forge shots --review

  hero-desktop.png         1440x900   hash 9f2d07c   ACCEPTED
  playwright-desktop.png   1440x900   hash 9f2d07c   ACCEPTED
  playwright-mobile.png     390x844   hash 4c1e9ab   HELD

  1 held: build hash does not match the tested build (expected 9f2d07c).

A held capture is not a failed capture. It is a capture that cannot be used as
evidence for anything, which is worse.`},{prototype:!0,id:"gate-accessibility",name:"Accessibility",status:"completed",duration:"9.7s",lastRun:"2026-07-24 15:16",evidenceCount:2,output:`EXAMPLE OUTPUT — hand-written, nothing was executed.

$ npx axe ./dist --exit

  serious   0
  moderate  1   landmark-unique  (two <nav> landmarks share a label)
  minor     3

  Previously open and now closed:
    button-name        slot buttons announced only a time
    aria-live-region   step indicator changed silently

Keyboard pass done by hand. Focus order was wrong in a way no automated rule
caught: the grid rendered after the fold and was inserted above its trigger.`},{prototype:!0,id:"gate-security",name:"Security",status:"review",duration:"27.3s",lastRun:"2026-07-24 13:44",evidenceCount:2,output:`EXAMPLE OUTPUT — hand-written, nothing was executed.

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

Awaiting Review Boss sign-off on the permission recommendation.`},{prototype:!0,id:"gate-markdown",name:"Markdown",status:"completed",duration:"2.4s",lastRun:"2026-07-24 15:22",evidenceCount:1,output:`EXAMPLE OUTPUT — hand-written, nothing was executed.

$ npx markdownlint docs artifacts

  docs/setup.md:41    MD001  heading levels should increment by one (h2 → h4)
  docs/handoff.md:12  MD001  heading levels should increment by one (h1 → h3)

  11 files checked, 2 with findings

Both corrected. Re-check: 11 files, 0 findings. Skipped heading levels read
fine to a person and badly to a screen reader, which is the whole reason this
gate exists.`},{prototype:!0,id:"gate-verify-agent",name:"Verify Agent",status:"running",duration:"—",lastRun:"2026-07-24 15:39",evidenceCount:22,output:`EXAMPLE OUTPUT — hand-written, nothing was executed.

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
the claim refers to. Nothing else is assessed.`},{prototype:!0,id:"gate-review-boss",name:"Review Boss",status:"review",duration:"4m 02s",lastRun:"2026-07-24 15:31",evidenceCount:5,output:`EXAMPLE OUTPUT — hand-written, nothing was executed.

$ forge review --run run-oac-0841

  WP1  intake and reference sweep       APPROVED
  WP2  interface and responsive         APPROVED
  WP3  booking engine and integrations  CHANGES REQUESTED
  WP4  tests and browser journeys       REOPENED
  WP5  security and permission review   IN REVIEW
  WP6  documentation and handoff        NOT SUBMITTED

  reopened WP4:
    the completion summary stated the mobile journey passed while the run
    attached to it showed a failure. that gap is not a rounding error.`}],P=[{prototype:!0,id:"proof-14",timestamp:"2026-07-24 15:39:27",claim:"Mobile screenshot evidence now matches the tested build",agent:"Verify Agent",taskId:"task-28",command:"forge verify --artifact playwright-mobile.png --expect-hash 9f2d07c",artifact:"playwright-mobile.png",verdict:"pending",reason:"Re-check is open. The rebuild has not finished, so there is nothing new to compare and a verdict now would be a guess."},{prototype:!0,id:"proof-13",timestamp:"2026-07-24 15:31:05",claim:"Only justified agents held write access during this run",agent:"Security Boss",taskId:"task-22",command:"forge doctor --permissions --run run-oac-0841",artifact:"security-report.md",verdict:"pending",reason:"Accurate as a list, but it contains a recommendation rather than a fact. Review Boss decides whether elevated permission for an unexecuted send step counts as justified."},{prototype:!0,id:"proof-12",timestamp:"2026-07-24 15:22:48",claim:"Every generated document passes markdown lint",agent:"Docs Boss",taskId:"task-25",command:"npx markdownlint docs artifacts",artifact:"markdown-lint.log",verdict:"accepted",reason:"Log shows two findings, both fixed, and a clean re-check across all eleven documents. The failing first pass was included rather than hidden."},{prototype:!0,id:"proof-11",timestamp:"2026-07-24 15:16:02",claim:"No serious accessibility violations remain open",agent:"Test Boss",taskId:"task-19",command:"npx axe ./dist --exit",artifact:"accessibility-report.md",verdict:"accepted",reason:"Serious count is zero and both previously open rules are named with the fix. The remaining moderate finding is listed, not rounded away."},{prototype:!0,id:"proof-10",timestamp:"2026-07-24 15:12:36",claim:"Desktop confirmation step renders correctly at 1440 x 900",agent:"UI Boss",taskId:"task-08",command:"npx playwright test booking.desktop.spec.ts --update-snapshots",artifact:"playwright-desktop.png",verdict:"accepted",reason:"Footer hash 9f2d07c matches the build the journey ran against, and the capture shows the step the claim describes."},{prototype:!0,id:"proof-09",timestamp:"2026-07-24 15:08:14",claim:"Desktop booking journey passes end to end",agent:"Test Boss",taskId:"task-17",command:"npx playwright test booking.desktop.spec.ts --project=chromium",artifact:"playwright-desktop.png",verdict:"accepted",reason:"Eleven steps, 6.4s, trace attached. Re-run after the form state fix, so the pass describes the current code rather than an older one."},{prototype:!0,id:"proof-08",timestamp:"2026-07-24 14:57:40",claim:"Setup instructions work from a clean machine",agent:"Docs Boss",taskId:"task-24",command:"forge report --section setup --check-order",artifact:"final-report.md",verdict:"rejected",reason:"The first submission attached a test summary with the failing integration suites filtered out of the output. Evidence that removes the inconvenient lines is not evidence."},{prototype:!0,id:"proof-07",timestamp:"2026-07-24 14:51:07",claim:"Typecheck, lint and build are all clean",agent:"Build Boss",taskId:"task-15",command:"npm run typecheck && npm run lint && npm run build",artifact:"build-receipt.txt",verdict:"accepted",reason:"Three commands, three clean exits, and a receipt carrying the resulting build hash. That hash is what made the next rejection possible."},{prototype:!0,id:"proof-06",timestamp:"2026-07-24 14:07:55",claim:"Mobile booking step is complete",agent:"Build Boss",taskId:"task-18",command:"npx playwright test booking.mobile.spec.ts --project=mobile-safari",artifact:"playwright-mobile.png",verdict:"rejected",reason:"The screenshot shows the previous build — its footer reads 4c1e9ab while the journey ran against 9f2d07c. The implementation was not examined, because the evidence could not support any claim about it."},{prototype:!0,id:"proof-05",timestamp:"2026-07-24 13:44:09",claim:"No live credentials exist in the working tree",agent:"Security Boss",taskId:"task-21",command:"forge doctor --secrets",artifact:"security-report.md",verdict:"accepted",reason:"214 files scanned, zero live secrets, and the single near-miss is quoted in full with the line number rather than declared harmless."},{prototype:!0,id:"proof-04",timestamp:"2026-07-24 13:36:41",claim:"Slot engine handles every boundary case",agent:"Test Boss",taskId:"task-16",command:"npm run test -- src/booking/slots.test.ts",artifact:"slot-engine-coverage.log",verdict:"accepted",reason:"Forty-one passing cases including closing time, timezone drift and the daylight-saving Sunday. Uncovered lines are listed rather than omitted from the report."},{prototype:!0,id:"proof-03",timestamp:"2026-07-24 12:47:03",claim:"Deposit payment integration is implemented",agent:"Payment Integration",taskId:"task-13",command:"npm run test:integration -- payment/checkout.int.test.ts",artifact:null,verdict:"rejected",reason:"The cited artifact does not exist and the suite was skipped for missing credentials. Code that has never once been executed is written, not implemented."},{prototype:!0,id:"proof-02",timestamp:"2026-07-24 11:14:52",claim:"Data model prevents double-booking",agent:"Build Boss",taskId:"task-10",command:'npm run test -- src/booking/slots.test.ts -t "double book"',artifact:"booking-flow.svg",verdict:"accepted",reason:"A slot is owned by a barber and guarded by a unique constraint. The test that proves it fails correctly when the constraint is removed, which is the part that matters."},{prototype:!0,id:"proof-01",timestamp:"2026-07-24 09:31:48",claim:"Twelve booking flows reviewed, nine on mobile",agent:"Search Boss",taskId:"task-02",command:"forge research --sources 12 --record-steps",artifact:"competitor-scan.md",verdict:"accepted",reason:"Each flow is listed with the step it lost the visitor at, and what could not be found is stated as clearly as what could."}],C=[{prototype:!0,id:"wp-1",title:"WP1 · Intake and reference sweep",goal:"Understand what the shop actually needs before a single component is written, and learn from booking flows that already work rather than inventing one from taste.",status:"completed",ownerAgentId:"agent-search-boss",phase:"intake",taskIds:["task-01","task-02","task-03","task-04"],acceptance:["Every intake question has an answer from the owner, not an assumption from an agent.","At least ten booking flows reviewed, the majority of them on a phone-sized viewport.","Each recommended pattern cites the flow it came from and the step it was observed at.","The mission blueprint names an owner and an acceptance list for every work package."]},{prototype:!0,id:"wp-2",title:"WP2 · Interface, type and responsive behaviour",goal:"Make the page feel expensive without making it loud: one type scale, real spacing rhythm, and a booking step that reads clearly at 360px as well as 1440px.",status:"running",ownerAgentId:"agent-ui-boss",phase:"build",taskIds:["task-05","task-06","task-07","task-08","task-09","task-29"],acceptance:["One type scale and one spacing grid across every section — no per-section exceptions.","Layout holds at 360, 768 and 1440 with no horizontal scroll on the body.","Every animation has a prefers-reduced-motion branch that fully disables it.","Structured data validates, and no field is populated with an invented value."]},{prototype:!0,id:"wp-3",title:"WP3 · Booking engine and integrations",goal:"Build the part that has to be correct: slots that exist, slots that do not double-book, and a four-step form that survives a refresh and a back button.",status:"running",ownerAgentId:"agent-build-boss",phase:"build",taskIds:["task-10","task-11","task-12","task-13","task-14","task-15"],acceptance:["A slot belongs to one barber and cannot be held by two bookings at once.","Service duration and buffer time are modelled separately and both affect availability.","Form state survives a page refresh; the back button steps backwards inside the flow.","Typecheck, lint and build all pass locally, and the build hash is recorded for evidence matching.","Payment and mail steps are reported as unfinished rather than stubbed and marked done."]},{prototype:!0,id:"wp-4",title:"WP4 · Test suite and browser journeys",goal:"Prove the flow works on a real viewport rather than in a screenshot, and describe any failure precisely enough that it can be fixed without a second investigation.",status:"failed",ownerAgentId:"agent-test-boss",phase:"verify",taskIds:["task-16","task-17","task-18","task-19"],acceptance:["Slot engine unit tests cover the closing-time boundary, timezone drift and the daylight-saving jump.","Desktop and mobile journeys both run landing to confirmation with no manual steps.",'Every failure ships with a trace and a named viewport, never the phrase "mobile is off".',"No serious accessibility violation remains open at the end of the package."]},{prototype:!0,id:"wp-5",title:"WP5 · Security and permission review",goal:"Check what was granted, what was written, and what a stranger could send to the booking endpoint — before the site is pointed at a real shop.",status:"review",ownerAgentId:"agent-security-boss",phase:"review",taskIds:["task-21","task-22","task-23"],acceptance:["Secret scan runs across every tracked file and the result is quoted, not summarised.","Each near-miss is either resolved or explained in the report with the offending line.","Every agent that held write access this run is listed with the reason it was granted.","All user-supplied fields are length-bounded and trimmed server-side."]},{prototype:!0,id:"wp-6",title:"WP6 · Documentation and handoff",goal:"Leave the owner able to run, change and hand off the project six weeks from now without asking anyone what the missing pieces were.",status:"waiting",ownerAgentId:"agent-docs-boss",phase:"handoff",taskIds:["task-24","task-25","task-26","task-30"],acceptance:["Setup instructions work from a machine with nothing installed, in the order written.","Unfinished work is named in the opening section, not buried under a closing note.","Markdown lint passes on every generated document with no skipped heading levels.","The handoff pack is only assembled after verification closes."]},{prototype:!0,id:"wp-7",title:"WP7 · Repair loop: mobile evidence",goal:"Close the gap the verify loop found — rebuild, recapture, re-run, and re-check — instead of arguing that the failure was environmental.",status:"verify",ownerAgentId:"agent-build-boss",phase:"verify",taskIds:["task-20","task-27","task-28"],acceptance:["The capture is taken from a fresh production build, not a warm dev server.","The build hash in the screenshot footer matches the hash the tests ran against.","The mobile journey asserts the confirm button is visible and hit-testable, not merely present.","The Verify Agent records an explicit accept or reject with the reason attached."]}];a(B,"fixtures/projects"),a(b,"fixtures/conversations"),a(m,"fixtures/agents"),a(I,"fixtures/tasks"),a(C,"fixtures/work-packages"),a(x,"fixtures/runs"),a(w,"fixtures/events"),a(f,"fixtures/artifacts"),a(S,"fixtures/tests · gates"),a(P,"fixtures/tests · proof"),a(y,"fixtures/files"),g(T,"fixtures/graph");function t(e,s){for(const i of e)if(i?.prototype===!0)throw new Error(`Forge: a record carrying prototype:true reached the production path at ${s}. Example/fixture data must never enter a production code path — this is a hard error, not a warning. Only the opt-in fixtures build may load prototype records.`)}function j(e){return t(e.projects,"production/projects"),t(e.conversations,"production/conversations"),t(e.agents,"production/agents"),t(e.tasks,"production/tasks"),t(e.workPackages,"production/work-packages"),t(e.runs,"production/runs"),t(e.events,"production/events"),t(e.artifacts,"production/artifacts"),t(e.gates,"production/gates"),t(e.proof,"production/proof"),t(e.files,"production/files"),t(e.graph.nodes,"production/graph.nodes"),t(e.graph.edges,"production/graph.edges"),t(e.graph.lanes,"production/graph.lanes"),e}const E={id:"",runId:"",lanes:[],nodes:[],edges:[]},R={projects:[],conversations:[],agents:[],tasks:[],workPackages:[],runs:[],events:[],artifacts:[],gates:[],proof:[],files:[],graph:E};function M(){return l(),j(R)}const D=M();function F({children:e}){const[s,i]=n.useReducer(c,void 0,()=>p(D));h(s,i);const r=n.useMemo(()=>({state:s,dispatch:i}),[s]);return d.jsx(u.Provider,{value:r,children:e})}export{F as default};
