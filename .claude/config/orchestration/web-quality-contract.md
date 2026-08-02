# Forge V2 — Auto Web-Quality Contract (WAVE C / C3, 2026-07-18)

The default quality bar for every website/full-stack/landing/SPA build — auto-prepended to the
builder's dispatch prompt by `forge-router` (Step 3 domain routing) so the owner never has to
re-ask for "fix the UI" / "make it responsive" / "better animations" after the fact. Grounded in
`~/.claude/rules/ecc/web/design-quality.md`, `~/.claude/rules/ecc/web/performance.md`, and
`~/.claude/rules/ecc/web/coding-style.md` — this file does not re-derive those rules, it is the
crisp checklist a builder actually runs through before calling the work done.

## Non-negotiable checklist

1. **Real content.** No Lorem Ipsum, no `TODO`/placeholder copy, no fake stock-photo filler
   headed for prod. Every string a real user would read is real copy for this product.
2. **Responsive — desktop + tablet + mobile.** Verified at minimum ~360/768/1280 (mobile/tablet/
   desktop). No horizontal overflow, no clipped/overlapping content, touch targets usable on
   mobile.
3. **Working nav/forms/search with real states.** Every interactive surface (nav, form, search,
   filter) has a **loading** state, an **empty** state, and an **error** state — not just the
   happy path. Forms validate input client- and server-side and submit to a real endpoint.
4. **Zero console errors.** No uncaught exceptions, no failed network requests logged to console,
   no React/Vue hydration warnings on the pages actually shipped.
5. **Accessibility basics.** Semantic HTML (`<header>`/`<nav>`/`<main>`/`<footer>`, not a div
   stack), labeled form inputs, sufficient color contrast, keyboard-reachable interactive
   elements, meaningful alt text.
6. **Intentional, non-template design (Rams discipline).** No default Tailwind/shadcn look-alike
   shipped unmodified. Demonstrate real hierarchy (scale contrast), intentional spacing rhythm,
   designed hover/focus/active states, and a deliberate palette + type pairing — see
   `~/.claude/rules/ecc/web/design-quality.md`'s "Required Qualities" and "Banned Patterns" for
   the full anti-template list. Ten words: less, but better.
7. **Tasteful, purposeful motion.** Motion clarifies flow, it does not decorate for its own sake.
   Animate only compositor-friendly properties (`transform`, `opacity`, `clip-path`, sparingly
   `filter`) — never `width`/`height`/`top`/`left`/`margin`/`padding`. Use GSAP/ScrollTrigger for
   scroll-driven or complex sequenced motion (see `~/.claude/rules/ecc/web/performance.md`
   "Animation Performance"); honor `prefers-reduced-motion`.
8. **Screenshot check before "done."** Capture desktop + mobile screenshots of the real, running
   build (not a mock) before the work package is marked complete. A claim of "responsive" or
   "done" without an actual screenshot is not evidence — see this project's honesty core.

## Scope

Applies to `forge-website`, `forge-fullstack` (frontend surfaces), landing pages, and SPA builds.
Does not apply to pure backend/API-only work packages, n8n workflows, or CLI/tooling changes —
those have their own domain gates.

## How this is invoked

`forge-router` (Step 3, domain → team routing) auto-prepends this file's full text to the builder
dispatch prompt whenever the classified domain is `website`, `fullstack`, `landing`, or `spa`, and
requires the matching evidence set for the work package's `evidence_required` field alongside it
(the required-evidence catalog is a separate, evidence-schema piece — reference it by name in the
dispatch, do not restate it here). This file is the checklist content; the router SKILL owns the
wiring rule that makes attaching it automatic instead of something that has to be re-requested
every time.
