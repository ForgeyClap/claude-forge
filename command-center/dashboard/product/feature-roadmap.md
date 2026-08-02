# Forge Workspace — feature roadmap

Written 2026-07-24, against the code as it stands. The companion file
`product/feature-opportunity-matrix.json` holds one structured entry per candidate; this
document is the argument. Disagree with a specific decision — every one of them names
the file it came from, so you can check whether the premise is right before you argue
about the conclusion.

## The shape of the problem

Reading the codebase, the interesting finding is not that features are missing. It is
that **most of the next six months of work has already been designed and half-built, and
none of it reaches a screen.**

- `src/shared/protocol.ts` defines 39 operations, 23 operational statuses and 47 event
  types. The UI layer models 7 statuses. Nine of the 23 — `WAITING_FOR_PERMISSION`,
  `STOPPING`, `INTERRUPTED`, `DISCONNECTED`, `RECOVERING`, `RESUMABLE`, `ORPHANED`,
  `FAILED_RECOVERY`, `DEGRADED` — have no visual representation anywhere in the 13 views.
- `UsageSnapshot` carries 20 provenance-labelled fields and `src/bridge/usage/aggregator.ts`
  is 80 KB. Zero of those numbers are rendered.
- `listApprovals` / `approveAction` / `denyAction`, the whole `ApprovalRequest` record
  with its risk level and rollback plan, and the `approval.requested` event all exist.
  No view renders any of it.
- The bridge already writes an audit ledger on every request (`writeAudit` in
  `src/bridge/router.ts`) and already emits `bridge.degraded` when a line cannot be
  written. Nothing shows it.
- Home renders six project-template cards that fire a toast saying nothing was created,
  while `createProject` exists and `src/bridge/projects/create.ts` is 62 KB.

So the highest-value work is not inventing capability. It is connecting capability that
was built carefully and then left unattached. That is why the IMPLEMENT_NOW list is
weighted towards wiring rather than towards new surfaces, and why several fashionable
candidates are rejected outright: this product does not need more controls, it needs the
controls it has to be true.

---

## The five changes that would most improve daily use

### 1. Session health — replace the string literal in the topbar

`Topbar.tsx` has a component called `ClaudeCodeChip` with a comment above it that reads
*"Never derived from anything. A fixed label that says what is true."* That was the right
call for a visual prototype. The moment a run is real, it becomes the single most
dangerous element on the screen, because a quiet window and a dead session look identical.

`ClaudeCodeStatus` already carries availability, executable path, version, authenticated,
`supportedFlags` and a note. `BridgeHealth` already carries uptime, active runs, last
event time and a `degraded[]` list. Drive the chip from those, render the five loss-and-
recovery statuses as first-class states with icon + uppercase label + border treatment,
and offer exactly one action per state — `resumeSession` where the state permits it,
nothing where it does not.

**Against not building it:** a workspace whose stated first principle is *"a status is a
claim about reality"* would be shipping a status chip that is a hard-coded string. That
is not a gap, it is a contradiction.

### 2. The approval queue, and a Stop button that means it

These are two entries in the matrix (`approval-queue`, `run-control`) and one problem:
the workspace can currently see a run but not intervene in one.

A run that pauses for permission emits `approval.requested` and enters
`WAITING_FOR_PERMISSION`. There is nowhere in the product for that to appear, so to a
user it is indistinguishable from a hang. Add a seventh Dock panel — Approvals — with the
requesting agent, the action, the affected paths, the risk as icon + label, the rollback
plan and a live expiry countdown. Approve and Deny are the only buttons, and the row must
be expanded first so the rollback plan has been on screen before a decision is possible.

Alongside it: `stopRun`, `run.cancel.requested` and `run.cancelled` all exist, and the only
Stop button in the product is in the chat composer, where it stops a `setTimeout` that
reveals canned text. Put Stop wherever a run is visible, and make it two-state — pressing
it shows `STOPPING` and it only reads `CANCELLED` when the bridge confirms, so the button
never claims a kill it cannot prove.

**Against not building it:** every other item on this list is about seeing. This is the
only one about being able to act, and right now the brake is wired to a text-reveal timer.

### 3. Universal search

There are five search fields in the product — sidebar, Home, Files, Activity, command
palette — and not one of them can find a sentence inside a conversation, a proof reason,
an artifact preview or an event detail. Finding anything means first remembering which of
the 13 views owns it.

One index over what the bridge already returned; the existing `Ctrl+K` palette as the
single entry point; results grouped by kind with the owning view named on each row, and
Enter navigating there with the record already selected. The fuzzy scorer in
`CommandPalette.tsx` is already good enough — it just has nothing but command titles and
project names to chew on.

**Against not building it:** without it, every feature added from here makes the workspace
harder to navigate, because each one is a new place where the answer might be. That is
precisely the "many shallow controls" outcome we were told to avoid.

### 4. Projects that are real — create from a template, import a folder

Six template cards on the landing screen currently fire an inert toast. `createProject`,
`importProject`, `ProjectRecord.templateVersion`, a 62 KB creator and a 25 KB discoverer
all exist. The wire between them does not.

Import matters more than templates, and it should ship first: until the workspace can be
pointed at a folder that already exists, it can only manage work it invented, which makes
every other feature here a demo. Import runs discovery and shows what it found — git
branch, dirty count, remote, detected type, file count — *before* recording anything, and
it never writes into the folder it is importing.

**Against not building it:** the product cannot be used on real work. That is the whole
argument.

### 5. The usage bar, with its accuracy labels showing

Deliberately not the "usage dashboard" that was asked for. A full analytics page would be
a fourteenth destination opened twice and then never again.

What earns its space is one persistent strip under the composer and in the topbar: model,
context percent as a thin meter, turns, tool calls, elapsed, cost — each rendering its
`Accuracy`, so an `ESTIMATED` figure is visibly not an `EXACT` one and an `UNAVAILABLE`
field prints the honest absence instead of a zero. `planUsage` always prints
`PLAN_USAGE_UNAVAILABLE_MESSAGE`, because CLI 2.1.217 does not expose plan quota and a
plausible-looking remaining-percentage would be pure invention. When `stale` is true the
strip says so rather than showing an ageing number.

**Against not building it:** `Accuracy` is the most distinctive idea in the whole protocol
and it currently exists only in a type definition. This is the surface that makes it real
to a user.

### The rest of the IMPLEMENT_NOW list, briefly

Seven more, all small or all wiring:

- **Keyboard-first workflows.** Settings documents 20 shortcuts; the shell implements four
  globally; and the table says `Ctrl+Enter` sends a message while `Composer.tsx` sends on
  plain `Enter`. Either implement the rest or delete the rows — but derive the table and
  the registrations from one map so they can never drift again.
- **Export the evidence bundle.** Proof, test executions with exit codes and counts, and a
  manifest of every `EvidenceRef` with its hash. Gaps listed as gaps. Evidence that cannot
  leave the tab is evidence only its author can check.
- **Workspace preference persistence.** Two keys are persisted today. Pins, active project,
  shell state, dock tab and every filter die on reload. This is the smallest change on the
  list and it removes friction paid on every single open.
- **Surface the audit log.** Already written by the bridge; read-only view; no delete, no
  edit. The receipt for the security claim already exists — leaving it invisible means
  asking to be trusted on the one point where proof was already built.
- **Automatic conversation titles.** Deterministic: first sentence of the first user
  message, capped, editable, never overwritten once edited. No model call — see the
  rejected alternative below.
- **In-app notifications (opt-in)** and **OS notifications (opt-in)**, for three events
  only: approval requested, verification rejected, run finished.

---

## Deferred, with the condition that would reopen each one

These are not "no". They are "not until a specific thing is true". Each trigger is written
so it can be checked rather than argued about.

| Item | Reopen when |
| --- | --- |
| Conversation branches | `ClaudeCodeStatus.supportedFlags` shows the installed CLI can fork or seed a session while keeping its cache. Today a branch means replaying the whole transcript into a fresh session — real tokens, real time, and a result that only looks like a continuation. |
| Context manager | `claude.usage` carries a per-item context breakdown. Right now a "manager" would be controls over an inventory the workspace cannot see. |
| Project health | `createProject` and `importProject` are wired. A health score over zero real projects measures nothing. |
| Project archive | The registry holds more projects than fit in the sidebar without scrolling. |
| Conversation archive | Roughly forty conversations in one project. Before that, universal search finds an old thread faster than an archive filter. |
| Backup and restore | The store holds anything the owner could not reconstruct — realistically the first real run. Build the export half before the restore half. |
| Export a conversation | The evidence bundle has proven the redaction path. Exporting free-form prose that may contain pasted credentials is the harder half and should not go first. |
| Markdown and code preview | `getFileDiff` is proven end to end. The diff answers the question you actually have mid-run, at a fraction of the read volume of streaming arbitrary file contents. |
| Large-file warnings | Attachments are wired at all. The composer's paperclip is currently three hard-coded example menus; you cannot warn about a file in a flow that does not exist. |
| Recent attachment library | The same file is observed being staged into a second conversation. `AttachmentRecord.conversationId` is required, so this is a schema change, not a UI change. |
| Offline / degraded mode (per-view) | The shell connection banner — already in flight in a parallel work package — has been live long enough to show which failures actually happen. Per-view treatment should follow observed failures, not imagined ones. |
| Event gap surface | Alongside the degraded-mode work. `ForgeEvent.sequence` exists specifically so the client can prove it missed something, and nothing renders a gap; but a gap indicator and a connection state are one story at two scales and should share a vocabulary. |
| Accessibility profiles | A real need appears that the current tokens cannot meet. The shell already does the hard parts — skip link, focus trapping, roving focus, `aria-activedescendant`, a polite additions-only log, status never carried by colour, reduced motion honoured two ways. |
| Per-project model defaults | `supportedFlags` reports a model flag the installed CLI accepts. The workspace does not route models — `USES_ANTHROPIC_API` is false and the CLI chooses — so a default it cannot enforce would be a setting that lies. |
| Composer command / skill completion | `sendMessage` is wired for real. Completing a composer that cannot send is decoration. |
| Static icon map | Packaging, or any non-localhost delivery. `Icon.tsx` resolving by runtime name costs 343 KB gzipped; on a machine reading its own disk that is nothing, and the fix touches every view. |

## Two decisions that are not mine to make

**Checkpoint and rewind.** Half of this is built: `createCheckpoint`, `listCheckpoints`
and a `CheckpointRecord` schema. But the schema comment is explicit — *"A checkpoint is a
set of references, not a copy."* It records where every record was, not what every file
contained. So there are two possible products:

- **(A)** Rewind restores Forge's own records only, and the screen says plainly that the
  working tree was not touched and git is where you undo files. Small, honest, ships soon.
- **(B)** Rewind restores files too, which means a `restoreCheckpoint` operation, a content
  store with a retention policy, and giving the bridge write access to the working tree.

Shipping (A) with a button labelled "Rewind" and no sentence would be exactly the
half-true status the state machines exist to prevent. Which of these it is depends on
whether the workspace is allowed to overwrite your source files — a decision about what
this product *is*.

**Per-project permissions.** Settings already draws a four-level model (read-only /
standard / elevated / lead) and three guard switches, all inert; the contract has
`PERMISSION_REQUIRED`, `PERMISSION_DENIED`, `approveAction`, `denyAction`. Joining them
means defining the authority model: deny by default or inherit, whether a project can ever
be granted "allow shell commands", and whether a grant can be widened without an audit
line. Getting the default wrong undermines every other guarantee in the bridge, so the
policy has to precede the implementation.

---

## What I rejected, and why

Fifteen candidates. The reasoning falls into four groups.

### It already exists

**Theme density** is shipped, wired to `data-density` on the document root and persisted —
there is nothing to build, and reopening it would only add options nobody asked for.
**Recent and pinned items** exists in three places (sidebar, Home "Continue working",
Files recent chips); the real gap is that pins die on reload, which is a persistence item,
not a feature.

### It is a second copy of something already in the product

**Agent timeline** would be a third rendering of one event stream — ActivityView already
groups by run with a per-agent filter and an agent column, and Mission Control already
draws the same run as a lane graph. Three representations of one truth is how they start
disagreeing.

**Task dependency graph** would be a fifth TasksView layout drawing edges Mission Control
already draws. `Task.dependencies` is on every task; render it as an inline list on the
card and in the inspector, each entry linking to its task with its status. Dozens of
lines, inside a layout that exists, and it answers the actual question ("why is this
blocked").

**Focus mode** is a fourth control whose only job is to press the three that already
exist — sidebar (`Ctrl+B`), inspector and dock all toggle independently.

**Reduced-detail mode** is a second "less" axis next to density. Two of them means every
view has to decide what counts as detail, and two views will decide differently.

**Prompt library** would be a fourteenth destination and a second store for text that is
already on disk in a better format — 2 files in `.claude/commands/` and 30 `SKILL.md`
files under `.claude/skills/` (counted, not estimated). The
need is real; the answer is reaching them from the composer, which is tracked as
`composer-command-completion`.

### It contradicts a rule this product is built on

**Advanced operator mode.** The central rule is that a screen may only render what the
bridge could prove. A mode whose purpose is to render less of the proof is in direct
conflict with it, and it doubles the surface every future feature must be designed against.

**Project scratchpad.** A pane of unversioned, unverified free text sitting beside a proof
ledger dilutes the one thing that makes this workspace different. `.claude/FORGE_MEMORY.md`
and `FORGE_DECISIONS.md` already exist for this, in files that can be diffed.

**Duplicate detection.** There is no definition of "duplicate" over this data that survives
contact with it — two threads with similar titles are usually two different attempts. A
workspace that claims things are duplicates and is wrong spends credibility its
evidence-backed claims are earning elsewhere.

### The cost is real and the alternative is better

**Diff review with per-hunk approval.** Diff *review* already exists — `FilesView` parses
and renders a unified diff with a numbered gutter — and `getFileDiff` is in the contract.
Per-hunk *approval* means writing to the working tree: it turns the bridge from an observer
into a mutator, and an applied hunk against a file that changed underneath produces a
corrupted source file with no record of what happened. Git already does per-hunk staging
correctly, and the workspace already reads `GitState`. This would be a weaker version of a
tool the owner has open in the next window, bought with the largest authority expansion on
the board.

**Safe folder upload.** Every file goes through detection, hashing and a 63 KB policy. One
dropped `node_modules` is thousands of files hashed and scanned on a fanless box, plus a
duplicate copy of a tree that is already on the same disk. `listProjectFiles` and
`readProjectFile` let Claude Code be pointed at the folder where it lives.

**Attachment content search.** An index over attachment contents is a second, unauditable
copy of exactly the data `policy.ts` spent 63 KB deciding not to trust — including files
it marked `QUARANTINE`. The part with genuine value, finding an attachment by name, falls
out of universal search for free.

**Multi-panel workspace** and **customizable layout.** The shell is four regions on one CSS
grid with two documented breakpoints, and `tests/e2e/responsive.spec.ts` covers seven fixed
viewport sizes. User-splittable panes mean all 13 views must work at arbitrary widths,
multiplying that matrix, in exchange for an arrangement the design already considered.

### One rejection that is really a redesign

**Usage dashboard** is in the IMPLEMENT_NOW list, but not as a dashboard. The rejection is
of the page; the acceptance is of the bar. Same for **notifications**: no notification
centre, no history, no per-event configuration — three events, two switches, a title-bar
count and a dock badge.

---

## A note on the Mac mini

Three constraints shaped several rows above, and they are worth stating once.

`RUNTIME_DECLARATIONS` says `LAN_MODE: false`, `REMOTE_ACCESS: false`,
`BIND_ADDRESS: '127.0.0.1'`. A headless always-on box is therefore reachable only by
screen-sharing into it. Any candidate whose value depends on reaching the workspace from a
second device is out of scope until that posture changes — and that posture is the reason
the workspace has never had to ask the browser for a single permission.

An unattended box is also where a session dies at 3am and nobody notices, which is why
session health and the event gap surface matter more there than on a workstation, and why
OS-level notifications are the one place a browser permission is worth trading.

And a fanless machine with one internal SSD argues for bounded work throughout: lazy
search indexing rather than eager, discovery bounded by depth and entry count, audit log
read from the tail, usage history capped, and any content store content-addressed and
pruned *before* it is written rather than after.
