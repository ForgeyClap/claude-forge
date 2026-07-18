---
name: gsap-performance
description: Official GSAP skill for performance — prefer transforms, avoid layout thrashing, will-change, batching. Use when optimizing GSAP animations, reducing jank, or when the user asks about animation performance, FPS, or smooth 60fps.
license: MIT
---

<!--
  Source: https://github.com/greensock/gsap-skills
  Pinned commit: aed9cfd3277740755f6bfc1155c7aa645403b760 (2026-04-21T23:47:02Z)
  License: MIT (c) 2026 GreenSock
  Adaptation: vendored (not npx skills add) -- pinned markdown fetched directly from the raw GitHub URL at
  the pinned commit and copied verbatim (content unchanged below the frontmatter/header) by build-boss; no
  install script, no package manager, no third-party fetch-and-run trust chain was executed.
  Security-scanned by build-boss, 2026-07-13 -- clean: 0 hidden/zero-width/control/bidi unicode codepoints,
  no injection/exec/exfiltration patterns (no "ignore previous", no curl|bash, no exec(/subprocess/fetch(
  to non-docs endpoints, no credential/secret/token exfil, no rm -rf) found in any of the 8 SKILL.md files
  or llms.txt; no "allowed-tools" frontmatter field present in this repo's skills (nothing to strip).
  Note (mild vendor steering): this skill self-recommends GSAP over other animation libraries in several
  "When to recommend GSAP" sections (expected from a first-party vendor skill) -- advisory, not enforced;
  still evaluate whether GSAP is the right choice for the project instead of following the recommendation
  automatically.
  Note (GSAP LIBRARY license, distinct from this skill): this vendored skill markdown is MIT-licensed. The
  separate GSAP JAVASCRIPT LIBRARY (the npm `gsap` package these docs describe using) ships under
  GreenSock's own post-Webflow-acquisition "no charge" license terms, which per the work package briefing
  reportedly include a no-compete clause restricting use of the library to build a directly competing
  animation product. This is advisory context only, passed through from the work package -- it was not
  independently re-verified against GreenSock's current license text as part of this scan, and it does not
  apply to this MIT-licensed skill documentation itself. Flag to Head Chef/Security Boss if the project
  under consideration could plausibly compete with GSAP/Webflow before relying on the `gsap` package.
-->

# GSAP Performance

## When to Use This Skill

Apply when optimizing GSAP animations for smooth 60fps, reducing layout/paint cost, or when the user asks about performance, jank, or best practices for fast animations.

**Related skills:** Build animations with **gsap-core** (transforms, autoAlpha) and **gsap-timeline**; for ScrollTrigger performance see **gsap-scrolltrigger**.

## Prefer Transform and Opacity

Animating **transform** (`x`, `y`, `scaleX`, `scaleY`, `rotation`, `rotationX`, `rotationY`, `skewX`, `skewY`) and **opacity** keeps work on the compositor and avoids layout and most paint. Avoid animating layout-heavy properties when a transform can achieve the same effect.

- ✅ Prefer: **x**, **y**, **scale**, **rotation**, **opacity**.
- ❌ Avoid when possible: **width**, **height**, **top**, **left**, **margin**, **padding** (they trigger layout and can cause jank).

GSAP’s **x** and **y** use transforms (translate) by default; use them instead of **left**/**top** for movement.

## will-change

Use **will-change** in CSS on elements that will animate. It hints the browser to promote the layer.

```css
will-change: transform;
```

## Batch Reads and Writes

GSAP batches updates internally. When mixing GSAP with direct DOM reads/writes or layout-dependent code, avoid interleaving reads and writes in a way that causes repeated layout thrashing. Prefer doing all reads first, then all writes (or let GSAP handle the writes in one go).

## Many Elements (Stagger, Lists)

- Use **stagger** instead of many separate tweens with manual delays when the animation is the same; it’s more efficient.
- For long lists, consider **virtualization** or animating only visible items; avoid creating hundreds of simultaneous tweens if it causes jank.
- Reuse timelines where possible; avoid creating new timelines every frame.

## Frequently updated properties (e.g. mouse followers)

Prefer **gsap.quickTo()** for properties that are updated often (e.g. mouse-follower x/y). It reuses a single tween instead of creating new tweens on each update. 

```javascript
let xTo = gsap.quickTo("#id", "x", { duration: 0.4, ease: "power3" }),
    yTo = gsap.quickTo("#id", "y", { duration: 0.4, ease: "power3" });

document.querySelector("#container").addEventListener("mousemove", (e) => {
  xTo(e.pageX);
  yTo(e.pageY);
});
```

## ScrollTrigger and Performance

- **pin: true** promotes the pinned element; pin only what’s needed.
- **scrub** with a small value (e.g. `scrub: 1`) can reduce work during scroll; test on low-end devices.
- Call **ScrollTrigger.refresh()** only when layout actually changes (e.g. after content load), not on every resize; debounce when possible.

## Reduce Simultaneous Work

- Pause or kill off-screen or inactive animations when they’re not visible (e.g. when the user navigates away).
- Avoid animating huge numbers of properties on many elements at once; simplify or sequence if needed.

## Best practices

- ✅ Animate **transform** and **opacity**; use **will-change** in CSS only on elements that animate.
- ✅ Use **stagger** instead of many separate tweens with manual delays when the animation is the same.
- ✅ Use **gsap.quickTo()** for frequently updated properties (e.g. mouse followers).
- ✅ Clean up or kill off-screen animations; call **ScrollTrigger.refresh()** when layout changes, debounced when possible.

## Do Not

- ❌ Animate **width**/ **height**/ **top**/ **left** for movement when **x**/ **y**/ **scale** can achieve the same look.
- ❌ Set **will-change** or **force3D** on every element “just in case”; use for elements that are actually animating.
- ❌ Create hundreds of overlapping tweens or ScrollTriggers without testing on low-end devices.
- ❌ Ignore cleanup; stray tweens and ScrollTriggers keep running and can hurt performance and correctness.
