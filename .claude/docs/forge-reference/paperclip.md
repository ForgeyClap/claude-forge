# Forge reference — Paperclip (opt-in plugin)

Moved out of `.claude/commands/forge.md` (v2.9.0, WP-C context trim) so the command file only carries a
one-line pointer for this opt-in, rarely-used plugin. This file is the full, unmodified rule — read it
before starting Paperclip. Nothing below was reworded from the original; it is the same rule that used to
sit inline.

## When this applies

Only when the owner explicitly asks for Paperclip (`gebruik paperclip`, `start paperclip`, `/forge paperclip
<goal>`), or when config `paperclip` is set to `on` for this project. Plain `gebruik forge` / `use Forge`
never starts Paperclip on its own.

## The rule (verbatim)

**PAPERCLIP — OPT-IN ONLY (decoupled from `gebruik forge`; user decision 2026-07-04, supersedes the
2026-07-02 auto-provision rule).** Config `paperclip` (default `off`) is this same rule, now enforced by the
bridge: while it is `off`, `forge-paperclip.cjs up` and `ensure` refuse with exit 3 — so when the owner
EXPLICITLY asks for Paperclip (`gebruik paperclip`, `start paperclip`, `/forge paperclip <goal>`), run
`up`/`ensure` with `--force` (the explicit ask is the consent), and otherwise never start it; `on` (`/forge
config set paperclip aan`) = the owner opted in for this project, so `up`/`ensure` run without `--force`
(same bridge, same guards). `gebruik forge` runs on the **Forge dashboard alone** — do **NOT** start the
Paperclip runtime, do **NOT** provision companies/agents/tickets, do **NOT** require Paperclip for any
project type (cashflow included). Paperclip remains available as a **separate plugin**, only when the user
explicitly asks (e.g. `gebruik paperclip`, `start paperclip`, `/forge paperclip <goal>`). When (and only when)
invoked, use the project-local bridge `.claude/forge-bin/forge-paperclip.cjs` with the existing flow
(`up`/`ensure` take `--force` while config `paperclip` is off — see above) — mapping: **1 Forge project = 1
Paperclip company** (nothing mixes):
1. `up` — start/reuse the loopback runtime (127.0.0.1:3100; isolated `PAPERCLIP_HOME`); report the real URL.
2. `ensure --run <run_id> --goal "<goal>" --agents .claude/FORGE_PAPERCLIP_AGENTS.json` — idempotent: company
   (= project name) · **goal** · project + **workspace bound to the exact project folder** · **agents from
   the role map** (role enum: ceo/cto/cmo/cfo/security/engineer/designer/pm/qa/devops/researcher/general;
   executing agents = `claude_local` with the durable standalone path; thinking roles = `process`) · per
   agent **instruction docs in `docs/agents/<slug>/AGENTS.md + SOUL.md + TOOLS.md`** · binding in
   `.claude/FORGE_PAPERCLIP_BINDING.json`.
3. `ticket --run <run_id> --title "WP-xx: …" --agent <slug>` per work package.
4. **Every step is auto-logged to the Forge dashboard** (`paperclip_*` events) — Paperclip and the Control
   Center stay ONE world; an empty dashboard while Paperclip works = blocker.
5. Guards stay on: loopback only · git-init before claude_local writes · no comment/self-wakes configured ·
   `pause` agents after proof (dashboard stays UP; `stop` only when fully done or the user asks) · no
   credentials · no Codex write.

If the runtime can't start, log `paperclip_runtime_blocked` + report honestly — never pretend the control
plane is active. **Never mark Paperclip BLOCKED/missing in reports when it simply wasn't requested — it is
opt-in, absence is normal.**
