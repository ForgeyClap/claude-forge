---
name: forge-debug
description: Forge systematic-debugging playbook. Use for ANY bug, crash, stack trace, failing test, or regression — debug, root cause, bisect, flaky test — before proposing a fix.
---

# Forge playbook — Systematic debugging

**Do not duplicate ECC skills — defer to:** `systematic-debugging` (the deep methodology reference). This
file is the Forge-specific orchestration wrapper: it binds that methodology to the honesty core and to
which Boss does what.

## Hard rules
- **The Iron Law:** no fix without root-cause investigation first. A patch that only makes the symptom go
  away, without an explanation of *why* the bug happened, is not a fix — it is a guess.
- **Never claim "fixed" without proof.** Per the project honesty core (`CLAUDE.md` → Honesty), a bug is
  only "fixed" when there is a real regression test that failed **before** the change (RED) and passes
  **after** it (GREEN). A verbal claim of "should be fixed now" is not evidence.
- Do not silently patch around a failure (swallowed exception, widened try/catch, disabled test,
  loosened assertion) to make a check go green — that is a rework-flag, not a fix.
- If root cause can't be found within a reasonable number of attempts, say so honestly (`BLOCKED` /
  `needs owner input`) rather than shipping a guess dressed up as a fix.

## The loop (reproduce → isolate → root-cause → fix → regression test → verify)
1. **Reproduce.** Get a minimal, reliable repro (exact command, exact input, exact error). If it can't be
   reproduced, that itself is a finding — don't invent a story around a bug you haven't actually seen.
2. **Isolate** (bisect / binary-search). Narrow the surface: which commit introduced it (`git bisect`),
   which input triggers it (binary-search the input space), which layer owns it (add targeted logging /
   breakpoints, remove code paths until the symptom disappears). Prefer removing variables over adding
   theories.
3. **Root-cause, not symptom.** State the mechanism in one sentence: "X happens because Y does Z under
   condition W." If you can't state it that precisely, you don't have the root cause yet — keep isolating.
4. **Fix** at the root, matching the existing architecture and conventions (see `coding-style.md`) — not a
   parallel workaround bolted on beside the real cause.
5. **Regression test.** Write a test that fails on the pre-fix code and passes on the post-fix code. It
   stays in the suite permanently — it is the proof, and it prevents the same bug returning silently.
6. **Verify.** Re-run the full relevant suite (not just the new test) to confirm no other case regressed;
   quote the real command and its real output.

## Isolation techniques
- `git bisect` for "this used to work, now it doesn't" regressions.
- Binary-search the input space for input-dependent bugs (halve the input, see which half still fails).
- Minimal repro: strip the reproduction down to the smallest file/config/call that still triggers it.
- Targeted logging beats a debugger you can't attach in CI; remove it once root cause is found.
- For flaky/intermittent failures: run N times to get a real failure rate before touching anything — a
  "fix" for a race condition that was never actually reproduced is not credible.

## When to escalate
- Security-relevant bug (auth, secrets, data exposure) → also load `security-reviewer` per the project's
  security posture.
- High-risk / hard-to-reproduce bug after one reasonable attempt fails → optional `codex-reviewer`
  (Codex, read-only) as an independent second opinion, per `CODEX_GLOBAL_POLICY.md`. Not mandatory, never
  a blocker.
- Build Boss owns implementation fixes; Test Boss owns the regression-test proof; Debug work that touches
  both stays with Build Boss, who hands the RED→GREEN evidence to Test Boss for confirmation.

## Honesty gate
This skill is grounded in `CLAUDE.md`'s honesty core: no fabricated proof/output, `CLAIM=PROOF`. A
completion report for a debug task without a quoted failing-then-passing test run is incomplete —
report it as `blocked` or `partially complete`, not `fixed`.
