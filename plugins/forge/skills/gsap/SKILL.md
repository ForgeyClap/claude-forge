---
name: gsap
description: "GSAP web-animation toolkit for Forge website/frontend work — timelines, ScrollTrigger, React integration, plugins, performance. Use when building advanced scroll, reveal, hover, or hero animations. Read the matching reference below when you need the detail (progressive disclosure)."
---

# GSAP animation skill (Forge)

Advanced, production-grade web animation with [GSAP](https://gsap.com) for Forge `forge-website` / frontend tasks.
This is a curated reference bundle (vendored from GreenSock's gsap-skills, MIT). Read the specific guide you need:

- `gsap-core/SKILL.md` — core tween/timeline API and fundamentals
- `gsap-timeline/SKILL.md` — sequencing with timelines
- `gsap-scrolltrigger/SKILL.md` — scroll-driven animation
- `gsap-react/SKILL.md` — using GSAP in React (useGSAP)
- `gsap-frameworks/SKILL.md` — framework integration patterns
- `gsap-plugins/SKILL.md` — official plugins
- `gsap-performance/SKILL.md` — compositor-friendly, jank-free motion
- `gsap-utils/SKILL.md` — utility methods and helpers
- `llms.txt` — full pinned reference index

Prefer compositor-friendly properties (transform/opacity), respect `prefers-reduced-motion`, and clean up
animations/ScrollTriggers on unmount. Keep motion purposeful — it should clarify flow, not distract.
