---
name: setup-forge
description: First-run onboarding — asks name/goal/project-type/language, then beginner-safe API-key setup, then scaffolds the per-project Forge system. User-invoked only. Run once per project. Subcommands: doctor · keys · reset.
argument-hint: "[ | doctor | keys | reset | --name X --goal \"…\" --type website --lang en --quick | --keys-from <path>]"
disable-model-invocation: true
---

# /setup-forge — Forge first-run onboarding wizard

Run the Forge onboarding for: **$ARGUMENTS**

You (the Lead agent) are running a friendly, beginner-safe onboarding. The mechanical and
security-sensitive steps are done by a zero-dependency engine you call —
**`node .claude/forge-bin/forge-setup.cjs`** — never by hand. You handle the conversation;
the engine handles gitignore, key placement, temp-file cleanup, and markers.

## Non-negotiable honesty & safety rules
- **Never print or echo a secret value.** Not once, not "to confirm". Names only.
- **Never claim a step ran if it didn't.** Report exactly what the engine returned.
- **Never write a secret to a git-tracked file.** The engine enforces this; you do not shortcut it.
- **Never delete or overwrite the user's own files** without saying so first.
- Keys are **optional** — a newcomer must be able to skip and still finish. Forge runs without keys.
- Work **only in this project folder.** Don't touch other projects or global config beyond
  the documented markers.

## Language first (internationalization)
Before anything else, determine the working language so the **entire** wizard, every question,
and every confirmation runs in it:
1. Read the configured language: `node .claude/forge-bin/forge-setup.cjs lang` (prints `en` default).
2. If a `--lang <code>` flag is present in $ARGUMENTS, use it.
3. Otherwise, if this is a fresh run, you will ask it as question 4 below — until then use the
   engine's value (**English by default**).

From the moment the language is known, **speak that language for the rest of the session** —
questions, help text, and the final "Forge is ready" message. English is the default when unset.
Supported now: **English (`en`)** and **Nederlands (`nl`)**. The "I'm done" signal you wait for is
**"done"** in English and **"klaar"** in Dutch (accept the natural equivalent in the chosen language).

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

- If it reports **onboarded** for this project: greet the user by their stored name in their
  language, say Forge is already set up here, and offer the three quick actions:
  `/setup-forge keys` (add/redo keys), `/setup-forge doctor` (health check),
  `/setup-forge reset` (start over). Then stop — do **not** re-ask the questions.
- If **not onboarded** (marker absent/incomplete): continue to Step 2. A version-bump on an
  existing marker means a gentle **self-heal** (Step 6), not a full re-ask.

If the engine itself is missing (`forge-setup.cjs` not found), the per-project payload is not
installed here — jump to **Self-heal** (Step 6) to scaffold it, then resume.

## Step 2 — The 4-question happy path
Auto-detect first so the defaults are smart. Inspect repo signals (do this yourself with
targeted reads): `git config user.name`, `git remote -v`, `package.json`, `next.config.*`,
n8n / workflow `*.json`, `requirements.txt` (+ vector libs → RAG), an existing `CLAUDE.md`/`AGENTS.md`.

Ask at most these four, each **leading with a recommended default in brackets** so Enter accepts:

1. **What should I call you?**  `[<git config user.name>]`
2. **What are you building here?**  (one line, e.g. "a landing page for my bakery")
3. **Project type?**  `[<auto-detected>]`
   `[1] Website  [2] Full-stack app  [3] Automation/n8n  [4] Chatbot/RAG  [5] Scraper  [6] Other/not sure`
4. **Main language?**  `[1] English  [2] Nederlands`  — apply this immediately (see "Language first").

Then one confirmation: **"Happy with sensible defaults for everything else? (Y/n)"**
Only expand into more detail if they decline. Keep it to four questions on the happy path.

**Persist the answers** (do this after the key flow, in Step 5 via the engine's `mark`, and also
update the human-readable profile): write/update `FORGE_PROJECT_PROFILE.md` and add or edit a
single `## Forge` block in whichever of `CLAUDE.md` / `AGENTS.md` exists (edit-in-place, never
duplicate the block; if neither exists, ask before creating one).

## Step 3 — Beginner-safe key setup (the signature flow)
This is: **temp file → user fills it → user says "done"/"klaar" → Forge places valid keys safely,
gitignored, never committed, temp removed on success (kept if a key still needs fixing).** Drive it
entirely through the engine.

1. **Guard (hard invariant, before writing anything):**
   `node .claude/forge-bin/forge-setup.cjs guard`
   - Exit `0` → secrets are gitignored; continue.
   - Exit `3` → a `.env` is **already git-tracked**. **STOP.** Relay the engine's loud warning
     verbatim (run `git rm --cached .env`, then rotate any exposed keys) and do **not** proceed
     to write keys until it's resolved.
2. **Create the fill-in file for this project type:**
   `node .claude/forge-bin/forge-setup.cjs init-keys --type <chosen-type>`
   The engine writes `.env.forge-setup` (already gitignored by the guard) with a short hint comment
   and a blank `KEY=` line for each key you might need — paste your key after the `=`, leave blank
   any you don't have. It never overwrites a non-empty temp file. Relay the path and its plain
   instructions.
3. **Tell the user in plain language** (in their language), e.g.:
   > I created a fill-in file: **`.env.forge-setup`**. Open it, paste each key after the `=`,
   > save it, then just say **"done"**. I'll move them somewhere safe — nothing here is ever
   > committed to git. Once every key checks out I'll delete the temp file; if one still needs
   > fixing I'll keep it (still hidden from git) and tell you which. Don't have a key yet? Leave it
   > blank and say "done" — you can add it later with `/setup-forge keys`.
4. **Pause and wait** for the user to say **"done"** (or **"klaar"**, or the equivalent in their
   chosen language), or **"skip"** to move on with no keys. Re-read the file fresh at that moment —
   do not assume its contents.
5. **Place the keys:**
   `node .claude/forge-bin/forge-setup.cjs place-keys`
   The engine validates each non-blank value (rejects placeholders like `REPLACE_ME`/`xxxx`/`<…>`),
   **moves** valid values into the gitignored `.env`, best-effort `chmod 600`, and writes a
   values-free `.env.example` (**names + comments only**). It **deletes** `.env.forge-setup` on a
   clean success (every pasted value stored) or if you pasted nothing yet; it **keeps** the temp
   file (still gitignored, still holding your values) when some keys couldn't be validated —
   telling you which to fix so you re-run place-keys / say "done" again after fixing. It prints a
   truthful **names-only** summary (stored / skipped / missing); secret values are never echoed
   back and nothing is ever committed to git. **Relay that summary as-is — never add or infer a
   value.**

If the user skips: don't create keys; tell them they can run `/setup-forge keys` anytime.

## Step 4 — (nothing extra) 
The key work is fully in Step 3. Do not re-echo values or "verify" by printing them.

## Step 5 — Write the markers (cache the onboarding)
`node .claude/forge-bin/forge-setup.cjs mark --name "<name>" --lang <code> --goal "<goal>" --type <type>`

This writes/merges the project marker (`.claude/.forge-setup.json`) and the global marker
(`~/.claude/.forge-global.json`) so `/forge` never re-asks and always replies in the user's
language. Idempotent — safe to re-run.

## Step 6 — Self-heal (make sure nothing is missing)
Run: `node .claude/forge-bin/forge-setup.cjs self-heal`
It creates any missing `.claude/` dirs/files (create-if-absent), appends any missing `.gitignore`
lines once each, and **reports only what CHANGED** — it never clobbers your edits. Relay the
change list. If the engine binary itself was missing, tell the user the per-project payload isn't
installed and point them at the installer (`install.sh` / `install.ps1`) or a manual copy, then
re-run `/setup-forge` once it's present.

## Doctor  (`/setup-forge doctor`)
Run: `node .claude/forge-bin/forge-setup.cjs doctor`  (add `--json` if you want to parse it).
Relay the PASS/FAIL lines as-is: Node present, `.claude/` intact, `.env` **not** git-tracked,
markers valid, skills/agents dir present. Exit `0` = all pass, `1` = something failed. Don't
soften a FAIL — state the real failing line and the fix.

## Keys  (`/setup-forge keys`)
Re-run **Step 3** only (guard → init-keys → wait for "done"/"klaar" → place-keys). Use this to add
a key you skipped or rotate one. Same rules: names only, nothing committed, temp deleted on a clean
success (or kept, still gitignored, if a key needs fixing).

## Reset  (`/setup-forge reset`)
Confirm with the user first (their language). Reset re-runs onboarding from the top — it does
**not** delete their `.env` or their keys. Then run the full wizard (Step 1 onward). If they
explicitly want keys cleared too, tell them to edit `.env` themselves; you never print its values.

## Non-interactive (CI / headless)
When `--quick` or the full flag set is present, skip all questions:
1. `node .claude/forge-bin/forge-setup.cjs guard` (stop on exit 3).
2. If `--keys-from <path>` is given: `node .claude/forge-bin/forge-setup.cjs place-keys --tmp <path>`
   (the engine validates each value, moves valid keys into the gitignored `.env`, and writes a
   values-free `.env.example`; a custom `--tmp` file inside this project is gitignored too. It
   deletes the standard temp on a clean success — or if nothing was pasted — but keeps the fill-file
   (still gitignored) when a key needs fixing, and leaves a user-pointed custom path in place.
   Nothing is committed to git — relay its names-only summary).
3. `node .claude/forge-bin/forge-setup.cjs mark --name "<--name>" --lang <--lang> --goal "<--goal>" --type <--type>`
4. `node .claude/forge-bin/forge-setup.cjs self-heal`
Print a compact, truthful summary. Never prompt in this mode.

## Finish
End with a short, celebratory line **in the user's language**, and state clearly that keys are optional:

> **Forge is ready** — try `/forge <your goal>` (e.g. `/forge build me a landing page for my bakery`).
> Keys are optional; Forge runs without them. Add or change keys anytime with `/setup-forge keys`,
> check health with `/setup-forge doctor`.

Report honestly: which engine commands actually ran, what changed, what was skipped, and anything
that failed with its real reason and next step.
