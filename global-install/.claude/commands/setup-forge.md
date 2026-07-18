---
name: setup-forge
description: First-run onboarding — asks name/goal/project-type/language, then beginner-safe API-key setup, then scaffolds the per-project Forge system. User-invoked only. Run once per project. Subcommands: doctor · keys · reset.
argument-hint: "[ | doctor | keys | reset | --name X --goal \"…\" --type website --lang en --quick | --keys-from <path>]"
disable-model-invocation: true
---

# /setup-forge — Forge first-run onboarding wizard  (global core)

Run the Forge onboarding for: **$ARGUMENTS**

This is the **bare `/setup-forge`** installed into `~/.claude` by the Forge installer. It runs in
the **current project folder**. You (the Lead agent) drive a friendly, beginner-safe onboarding;
the mechanical and security-sensitive steps are done by a zero-dependency engine you call —
**`node .claude/forge-bin/forge-setup.cjs`** (resolved in the current project) — never by hand.

## Non-negotiable honesty & safety rules
- **Never print or echo a secret value** — names only, never "to confirm".
- **Never claim a step ran if it didn't.** Report exactly what the engine returned.
- **Never write a secret to a git-tracked file.** The engine enforces this; don't shortcut it.
- **Never delete or overwrite the user's own files** without saying so first.
- Keys are **optional** — a newcomer can skip and still finish. Forge runs without keys.
- Work **only in this project folder.** Don't touch other projects. The only global writes are the
  documented markers.

## Global route — locate the engine first
Because this command lives in `~/.claude`, the project may or may not have the full Forge payload
yet. Check before anything else:
- If `.claude/forge-bin/forge-setup.cjs` exists in the current project → use it (normal flow below).
- If it is **missing**, the per-project payload isn't installed here. Say so plainly and offer the
  fix: run the installer (`install.sh` on macOS/Linux, `install.ps1` on Windows) from the
  `claude-forge` repo, or copy `.claude/` into this project manually. Once present, re-run
  `/setup-forge`. Do **not** fabricate a key flow or dashboard that isn't installed.

## Language first (internationalization)
Determine the working language so the **entire** wizard and every confirmation run in it:
1. `node .claude/forge-bin/forge-setup.cjs lang` (prints `en` default) — if the engine is absent,
   fall back to English and to any `--lang` flag.
2. A `--lang <code>` flag in $ARGUMENTS overrides.
3. On a fresh run, ask it as question 4 below.

From when the language is known, **speak it for the rest of the session.** English is the default.
Supported now: **English (`en`)**, **Nederlands (`nl`)**. The "I'm done" signal is **"done"** (en) /
**"klaar"** (nl) — accept the natural equivalent in the chosen language.

## Mode dispatch (read $ARGUMENTS first)
| $ARGUMENTS contains | Do this |
|---|---|
| `doctor` | Run the **Doctor** section only. |
| `keys` | Run the **Key setup** section only (re-do / add keys). |
| `reset` | Run the **Reset** section, then the full wizard from the top. |
| `--quick` or all of `--name/--goal/--type/--lang` | Run **Non-interactive** mode (no questions). |
| `--keys-from <path>` | Import keys from that file non-interactively (see Non-interactive). |
| empty / anything else | Run the **full wizard** (detection → questions → keys → finish). |

---

## Step 1 — First-run detection (never re-ask needlessly)
Run: `node .claude/forge-bin/forge-setup.cjs status --json`

- **Onboarded** for this project → greet the user by their stored name in their language, say Forge
  is already set up here, and offer `/setup-forge keys`, `/setup-forge doctor`,
  `/setup-forge reset`. Then stop — don't re-ask.
- **Not onboarded** → continue to Step 2. A version-bump on an existing marker → gentle
  **self-heal** (Step 6), not a full re-ask.
- **Engine missing** → see "Global route — locate the engine first" above.

## Step 2 — The 4-question happy path
Auto-detect first so defaults are smart: `git config user.name`, `git remote -v`, `package.json`,
`next.config.*`, n8n / workflow `*.json`, `requirements.txt` (+ vector libs → RAG), an existing
`CLAUDE.md`/`AGENTS.md`.

Ask at most these four, each **leading with a recommended default in brackets** so Enter accepts:

1. **What should I call you?**  `[<git config user.name>]`
2. **What are you building here?**  (one line, e.g. "a landing page for my bakery")
3. **Project type?**  `[<auto-detected>]`
   `[1] Website  [2] Full-stack app  [3] Automation/n8n  [4] Chatbot/RAG  [5] Scraper  [6] Other/not sure`
4. **Main language?**  `[1] English  [2] Nederlands`  — apply immediately.

Then one confirmation: **"Happy with sensible defaults for everything else? (Y/n)"** Expand only if
they decline. Keep it to four questions on the happy path.

**Persist the answers** (via the engine's `mark` in Step 5, plus the human-readable profile): write
/update `FORGE_PROJECT_PROFILE.md` and add or edit a single `## Forge` block in whichever of
`CLAUDE.md`/`AGENTS.md` exists (edit-in-place, never duplicate; if neither exists, ask before
creating one).

## Step 3 — Beginner-safe key setup (the signature flow)
**Temp file → user fills it → user says "done"/"klaar" → Forge places valid keys safely, gitignored,
never committed, temp removed on success (kept if a key still needs fixing).** Drive it entirely
through the engine.

1. **Guard first:** `node .claude/forge-bin/forge-setup.cjs guard`
   - Exit `0` → continue.
   - Exit `3` → a `.env` is **already git-tracked**. **STOP.** Relay the engine's loud warning
     verbatim (`git rm --cached .env`, then rotate exposed keys) and don't proceed until resolved.
2. **Create the fill-in file:** `node .claude/forge-bin/forge-setup.cjs init-keys --type <chosen-type>`
   The engine writes `.env.forge-setup` (already gitignored) with a short hint comment and a blank
   `KEY=` line for each key you might need — paste your key after the `=`, leave blank any you don't
   have. Never overwrites a non-empty temp. Relay the path and plain instructions.
3. **Tell the user plainly** (their language):
   > I created a fill-in file: **`.env.forge-setup`**. Open it, paste each key after the `=`, save,
   > then say **"done"**. I'll move them somewhere safe — nothing here is ever committed to git.
   > Once every key checks out I'll delete the temp file; if one still needs fixing I'll keep it
   > (still hidden from git) and tell you which. No key yet? Leave it blank and say "done" — add it
   > later with `/setup-forge keys`.
4. **Pause and wait** for **"done"** / **"klaar"** (or the chosen-language equivalent), or **"skip"**.
   Re-read the file fresh at that moment.
5. **Place the keys:** `node .claude/forge-bin/forge-setup.cjs place-keys`
   The engine validates each non-blank value (rejects `REPLACE_ME`/`xxxx`/`<…>`), **moves** valid
   values into the gitignored `.env`, best-effort `chmod 600`, and writes a values-free
   `.env.example` (**names + comments only**). It **deletes** the temp on a clean success (every
   pasted value stored) or if you pasted nothing yet; it **keeps** the temp (still gitignored, still
   holding your values) when some keys couldn't be validated — telling you which to fix so you
   re-run place-keys / say "done" again after fixing. It prints a truthful **names-only** summary
   (stored / skipped / missing); secret values are never echoed back and nothing is ever committed
   to git. **Relay it as-is — never add or infer a value.**

If the user skips: create no keys; tell them `/setup-forge keys` is there anytime.

## Step 4 — (nothing extra)
The key work is fully in Step 3. Never re-echo values or "verify" by printing them.

## Step 5 — Write the markers (cache the onboarding)
`node .claude/forge-bin/forge-setup.cjs mark --name "<name>" --lang <code> --goal "<goal>" --type <type>`
Writes/merges the project marker (`.claude/.forge-setup.json`) and global marker
(`~/.claude/.forge-global.json`) so `/forge` never re-asks and replies in the user's language.
Idempotent.

## Step 6 — Self-heal (make sure nothing is missing)
`node .claude/forge-bin/forge-setup.cjs self-heal` — creates missing `.claude/` dirs/files, appends
missing `.gitignore` lines once each, **reports only what CHANGED**, never clobbers edits. Relay the
change list. If the engine binary itself is missing, the payload isn't installed — point the user at
the installer (`install.sh` / `install.ps1`) or a manual copy, then re-run `/setup-forge`.

## Doctor  (`/setup-forge doctor`)
`node .claude/forge-bin/forge-setup.cjs doctor` (add `--json` to parse). Relay the PASS/FAIL lines
as-is: Node present, `.claude/` intact, `.env` **not** git-tracked, markers valid, skills/agents dir
present. Exit `0` = all pass, `1` = a failure. Don't soften a FAIL — state the failing line + fix.

## Keys  (`/setup-forge keys`)
Re-run **Step 3** only (guard → init-keys → wait for "done"/"klaar" → place-keys). Same rules: names
only, nothing committed, temp deleted on a clean success (or kept, still gitignored, if a key needs
fixing).

## Reset  (`/setup-forge reset`)
Confirm first (their language). Reset re-runs onboarding from the top — it does **not** delete their
`.env` or keys. Then run the full wizard (Step 1 onward). If they want keys cleared, tell them to
edit `.env` themselves; you never print its values.

## Non-interactive (CI / headless)
When `--quick` or the full flag set is present, skip all questions:
1. `node .claude/forge-bin/forge-setup.cjs guard` (stop on exit 3).
2. If `--keys-from <path>`: `node .claude/forge-bin/forge-setup.cjs place-keys --tmp <path>` — the
   engine validates each value, moves valid keys into the gitignored `.env`, and writes a values-free
   `.env.example`; a custom `--tmp` inside this project is gitignored too. It deletes the standard
   temp on a clean success (or if nothing was pasted) but keeps the fill-file (still gitignored) when
   a key needs fixing, and leaves a user-pointed custom path in place. Nothing is committed to git —
   relay its names-only summary.
3. `node .claude/forge-bin/forge-setup.cjs mark --name "<--name>" --lang <--lang> --goal "<--goal>" --type <--type>`
4. `node .claude/forge-bin/forge-setup.cjs self-heal`
Print a compact, truthful summary. Never prompt in this mode.

## Finish
End with a short, celebratory line **in the user's language**, and state clearly that keys are optional:

> **Forge is ready** — try `/forge <your goal>` (e.g. `/forge build me a landing page for my bakery`).
> Keys are optional; Forge runs without them. Add/change keys anytime with `/setup-forge keys`, check
> health with `/setup-forge doctor`.

Report honestly: which engine commands actually ran, what changed, what was skipped, and anything
that failed with its real reason and next step.
