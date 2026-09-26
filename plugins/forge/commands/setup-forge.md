---
name: setup-forge
description: First-run onboarding — asks name/goal/project-type/language, then (if the full system is installed) beginner-safe API-key setup and scaffolding. Plugin variant detects it is plugin-only and offers to run the full installer to add the dashboard + key flow. User-invoked only.
argument-hint: "[ | doctor | keys | reset | --name X --goal \"…\" --type website --lang en --quick | --keys-from <path>]"
disable-model-invocation: true
---

# /forge:setup-forge — Forge onboarding wizard  (plugin variant)

Run the Forge onboarding for: **$ARGUMENTS**

You reached this through the **Claude Code plugin** (`forge@claude-forge`), so commands are
namespaced (`/forge:setup-forge`, `/forge:forge`). The plugin is **LITE**: it ships commands,
agents, and curated skills from a **read-only cache**. It **cannot** write `~/.claude`, scaffold the
per-project dashboard, or run the `.env` key-move flow on its own — those need the **FULL** system
(installer or manual copy), which ships the engine `node .claude/forge-bin/forge-setup.cjs`.

## Non-negotiable honesty & safety rules
- **Never print or echo a secret value** — names only.
- **Never claim a step ran if it didn't** — especially don't claim a dashboard/key flow the plugin
  can't perform.
- **Never write a secret to a git-tracked file.**
- Keys are **optional** — a newcomer can finish without them. Forge runs without keys.
- Work **only in this project folder.**

## Step 0 — Detect plugin-only vs full install
Check the current project for the engine: does **`.claude/forge-bin/forge-setup.cjs`** exist?

- **Yes (full system also installed here):** run the complete wizard below exactly like the bare
  `/setup-forge` — every mechanical/secure step goes through the engine. Skip the rest of this
  section.
- **No (plugin-only):** the dashboard and safe key-move flow aren't available yet. Be honest and
  offer to add them:
  > You're running the **LITE** Forge plugin — commands, agents, and skills work, but the live
  > dashboard and the safe API-key setup need the **full** system. Want me to add it? Run one of:
  > - macOS/Linux: `curl -fsSL https://raw.githubusercontent.com/ForgeyClap/claude-forge/main/install.sh | bash`
  > - Windows: `powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/ForgeyClap/claude-forge/main/install.ps1 | iex"`
  > - Or clone the repo and run `./install.sh` / `.\install.ps1`, or copy `.claude/` into this project.
  >
  > After that, re-run `/setup-forge` (bare) for the full wizard with the dashboard + key flow.

  You may still do a **light onboarding now** (ask the questions, capture the language) so `/forge`
  greets the user and replies in their language — but state clearly that the key flow and dashboard
  arrive with the full install. **Do not fabricate** a dashboard or a completed key setup.

## Language first (internationalization)
Determine the working language so the **entire** wizard and every confirmation run in it:
1. If the full engine exists: `node .claude/forge-bin/forge-setup.cjs lang` (prints `en` default).
2. A `--lang <code>` flag in $ARGUMENTS overrides.
3. On a fresh run, ask it as question 4 below. English is the default when unset.

From when the language is known, **speak it for the rest of the session.** Supported now:
**English (`en`)**, **Nederlands (`nl`)**. The "I'm done" signal is **"done"** (en) / **"klaar"** (nl),
or the natural equivalent in the chosen language.

## Mode dispatch (read $ARGUMENTS first)
| $ARGUMENTS contains | Do this |
|---|---|
| `doctor` | Run the **Doctor** section (needs the full engine). |
| `keys` | Run the **Key setup** section (needs the full engine). |
| `reset` | Run the **Reset** section, then the full wizard from the top. |
| `--quick` or all of `--name/--goal/--type/--lang` | Run **Non-interactive** mode (no questions). |
| `--keys-from <path>` | Import keys non-interactively (needs the full engine). |
| empty / anything else | Run the **full wizard** (detection → questions → keys → finish). |

---

## Step 1 — First-run detection (never re-ask needlessly)
If the engine exists: `node .claude/forge-bin/forge-setup.cjs status --json`.
- **Onboarded** → greet by stored name in their language; offer `/setup-forge keys`,
  `/setup-forge doctor`, `/setup-forge reset`; stop.
- **Not onboarded** → continue to Step 2.
- **Plugin-only (no engine)** → you can still capture answers (Step 2) and language, but tell the
  user the marker/dashboard/keys land after the full install (Step 0).

## Step 2 — The 4-question happy path
Auto-detect first for smart defaults: `git config user.name`, `git remote -v`, `package.json`,
`next.config.*`, n8n / workflow `*.json`, `requirements.txt` (+ vector libs → RAG), existing
`CLAUDE.md`/`AGENTS.md`.

**Question cap (v2.7.0, `intake: silent`): fill every one of these from auto-detection + the name you already asked for a name; ask at most ONE actual question on the happy path** — the name (there is no reliable auto-detect for it), leading with a recommended default in brackets so Enter accepts:

1. **What should I call you?**  `[<git config user.name>]` — ask this one.
2. **What are you building here?**  — infer from the goal text if the user already said it; otherwise fold into the same turn as question 1 rather than a separate prompt.
3. **Project type?**  `[<auto-detected>]` — use the auto-detected value silently; only surface the `[1] Website [2] Full-stack app [3] Automation/n8n [4] Chatbot/RAG [5] Scraper [6] Other/not sure` menu if detection genuinely found nothing.
4. **Main language?**  — infer from the user's own message language; apply immediately, don't ask.

No `(Y/n)` confirmation step — proceed with sensible defaults and say what they were in one line; the user can correct anything afterward. `/setup-forge keys`/`doctor`/`reset` remain available for changes.

**Persist the answers** (via the engine's `mark` in Step 5 when the full system is present, plus the
human-readable profile): write/update `FORGE_PROJECT_PROFILE.md` and add or edit a single `## Forge`
block in whichever of `CLAUDE.md`/`AGENTS.md` exists (edit-in-place, never duplicate; if neither
exists, ask before creating one).

## Step 3 — Beginner-safe key setup (needs the full engine)
**Requires `.claude/forge-bin/forge-setup.cjs`.** If it's absent, skip this and point the user at
Step 0's installer — do **not** hand-roll a key move. When the engine is present, the flow is
**temp file → user fills it → user says "done"/"klaar" → Forge places valid keys safely, gitignored,
never committed, temp removed on success (kept if a key still needs fixing)**, driven entirely
through the engine:

1. **Guard:** `node .claude/forge-bin/forge-setup.cjs guard`
   - Exit `0` → continue.
   - Exit `3` → a `.env` is **already git-tracked**. Tell the user plainly, then run
     `node .claude/forge-bin/forge-setup.cjs guard --fix` yourself — this untracks the file with
     `git rm --cached -- .env` (the file and its content on disk are untouched). Report that you did
     it, then tell the user to rotate any keys that were exposed while it was tracked. Never hand the
     user the `git rm --cached` command to run themselves.
2. **Create the fill-in file:** `node .claude/forge-bin/forge-setup.cjs init-keys --type <chosen-type>`
   — writes `.env.forge-setup` (already gitignored) with a short hint comment and a blank `KEY=` line
   for each key you might need (paste your key after the `=`, leave blank any you don't have); never
   overwrites a non-empty temp. Relay the path and instructions.
3. **Tell the user plainly** (their language):
   > I created a fill-in file: **`.env.forge-setup`**. Open it, paste each key after the `=`, save,
   > then say **"done"**. I'll move them somewhere safe — nothing here is ever committed to git.
   > Once every key checks out I'll delete the temp file; if one still needs fixing I'll keep it
   > (still hidden from git) and tell you which. No key yet? Leave it blank and say "done".
4. **Pause and wait** for **"done"** / **"klaar"** (or the chosen-language equivalent), or **"skip"**.
   Re-read the file fresh.
5. **Place the keys:** `node .claude/forge-bin/forge-setup.cjs place-keys` — validates (rejects
   `REPLACE_ME`/`xxxx`/`<…>`), **moves** valid values into gitignored `.env`, best-effort `chmod 600`,
   writes a values-free `.env.example` (**names + comments only**), then **deletes** the temp on a
   clean success (every pasted value stored) or if you pasted nothing yet — but **keeps** it (still
   gitignored, still holding your values) when some keys couldn't be validated, telling you which to
   fix so you re-run place-keys / say "done" again after fixing. It prints a truthful **names-only**
   summary (stored / skipped / missing); secret values are never echoed back and nothing is ever
   committed to git. **Relay it as-is — never add or infer a value.**

## Step 4 — (nothing extra)
Never re-echo values or "verify" by printing them.

## Step 5 — Write the markers (full engine only)
`node .claude/forge-bin/forge-setup.cjs mark --name "<name>" --lang <code> --goal "<goal>" --type <type>`
— writes/merges the project + global markers so `/forge` never re-asks and replies in the user's
language. Idempotent. (Plugin-only: this lands after the full install.)

## Step 6 — Self-heal / add the full system
- Full engine present: `node .claude/forge-bin/forge-setup.cjs self-heal` — creates missing
  `.claude/` dirs/files, appends missing `.gitignore` lines once each, **reports only what CHANGED**.
- Plugin-only: run the installer from Step 0 (that's the real "add everything" path), then re-run
  `/setup-forge`.

## Doctor  (`/setup-forge doctor`)
Needs the full engine: `node .claude/forge-bin/forge-setup.cjs doctor` (add `--json`). Relay PASS/FAIL
lines as-is: Node present, `.claude/` intact, `.env` **not** git-tracked, markers valid, skills/agents
present. Exit `0` = pass, `1` = fail. Don't soften a FAIL. Plugin-only: say the doctor needs the full
install first.

## Keys  (`/setup-forge keys`)
Re-run **Step 3** (needs the full engine). Same rules: names only, nothing committed, temp deleted on
a clean success (or kept, still gitignored, if a key needs fixing). Plugin-only: point at the
installer first.

## Reset  (`/setup-forge reset`)
Confirm first (their language). Reset re-runs onboarding from the top; it does **not** delete `.env`
or keys. Then run the full wizard. If they want keys cleared, tell them to edit `.env` themselves —
you never print its values.

## Non-interactive (CI / headless, needs the full engine)
When `--quick` or the full flag set is present, skip all questions:
1. `node .claude/forge-bin/forge-setup.cjs guard` (stop on exit 3).
2. `--keys-from <path>` → `node .claude/forge-bin/forge-setup.cjs place-keys --tmp <path>` — the
   engine validates each value, moves valid keys into the gitignored `.env`, and writes a values-free
   `.env.example`; a custom `--tmp` inside this project is gitignored too. It deletes the standard
   temp on a clean success (or if nothing was pasted) but keeps the fill-file (still gitignored) when
   a key needs fixing, and leaves a user-pointed custom path in place. Nothing is committed to git —
   relay its names-only summary.
3. `node .claude/forge-bin/forge-setup.cjs mark --name "<--name>" --lang <--lang> --goal "<--goal>" --type <--type>`
4. `node .claude/forge-bin/forge-setup.cjs self-heal`
Print a compact, truthful summary. If plugin-only, state the engine is required and point at the
installer. Never prompt in this mode.

## Finish
End with a short, celebratory line **in the user's language**, and state clearly that keys are optional:

> **Forge is ready** — try `/forge:forge <your goal>` (e.g.
> `/forge:forge build me a landing page for my bakery`). Keys are optional; Forge runs without them.
> Add the dashboard + safe key flow anytime with the installer, then use bare `/setup-forge keys` /
> `/setup-forge doctor`.

Report honestly: which engine commands actually ran (if any), whether this was plugin-only or full,
what changed, what was skipped, and anything that failed with its real reason and next step.
