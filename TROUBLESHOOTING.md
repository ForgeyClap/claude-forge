<div align="center">

# Troubleshooting claude-forge

**Practical fixes for the things newcomers actually hit.** Each entry is **Problem → Cause → Fix**, with the real command to run.

</div>

---

> [!TIP]
> **Start here:** almost every setup problem is diagnosed by one command inside your project:
>
> ```
> /setup-forge doctor
> ```
>
> It prints honest **PASS/FAIL** lines for Node version, the `.claude/` payload, whether `.env` is git-tracked, marker validity, and the skills/agents dirs. Exit `0` = all pass, `1` = something failed. Run it first — most of the sections below map directly to a FAIL line it shows you.

---

## Quick index

| Symptom | Jump to |
|---|---|
| `/forge` says command not found, but I installed the plugin | [Namespaced plugin commands](#1-plugin-commands-are-namespaced-forgeforge-not-forge) |
| Command not found right after install | [Reload plugins / restart](#2-command-not-found-immediately-after-install) |
| PowerShell blocks the one-line installer | [ExecutionPolicy on Windows](#3-windows-installer-blocked-by-executionpolicy) |
| Dashboard won't start / port already in use | [Dashboard port in use](#4-dashboard-port-already-in-use) |
| Errors about Node / `.cjs` won't run | [Node version too old](#5-node-is-older-than-18) |
| I pasted my keys but they don't save | [Keys not saving](#6-keys-arent-saving) |
| Warning: "could not verify .env is gitignored" | [Gitignore could not be verified](#7-could-not-verify-env-is-gitignored) |
| Hard stop: ".env is already tracked by git" | [.env already tracked](#8-env-is-already-tracked-by-git-hard-stop) |
| Doctor warns git isn't available | [Git not present](#9-git-not-installed) |
| I want to wipe onboarding and start clean | [Full reset](#10-full-reset) |

---

## 1. Plugin commands are namespaced (`/forge:forge`, not `/forge`)

**Problem** — You installed via the Claude Code plugin and typed `/forge` or `/setup-forge`, and Claude Code doesn't recognize it.

**Cause** — Claude Code **namespaces every plugin command by the plugin name**. The `forge` plugin therefore exposes `/forge:forge` and `/forge:setup-forge`. The **bare** `/forge` and `/setup-forge` only exist when you use the **installer** (or manual copy), because that route copies the core into `~/.claude`.

**Fix** — Use the form that matches how you installed:

| How you installed | Work command | Onboarding command |
|---|---|---|
| 🔌 Plugin | `/forge:forge` | `/forge:setup-forge` |
| 🛠️ Installer / manual | `/forge` | `/setup-forge` |

Both forms do exactly the same thing. If you want the bare commands everywhere, use the [one-line installer](README.md#-quickstart-60-second-setup) instead of the plugin.

---

## 2. "Command not found" immediately after install

**Problem** — You just ran `/plugin install forge@claude-forge` (or the installer), and the command still isn't found.

**Cause** — Claude Code loads plugins and user-level commands **at session start**. A freshly installed command isn't picked up until plugins are reloaded.

**Fix** — Reload without losing your session:

```
/reload-plugins
```

If that doesn't surface it, **fully restart Claude Code** and re-open the project. Then confirm the plugin is present:

```
/plugin
```

You should see `forge@claude-forge` listed. If you installed via the marketplace, make sure both steps ran:

```
/plugin marketplace add ForgeyClap/claude-forge
/plugin install forge@claude-forge
```

---

## 3. Windows installer blocked by ExecutionPolicy

**Problem** — On Windows, `irm … | iex` fails, or PowerShell refuses to run the install script (`running scripts is disabled on this system`).

**Cause** — The default PowerShell **ExecutionPolicy** blocks piping a remote script straight into `iex`. This is expected Windows behavior, not a Forge bug.

**Fix** — Use the `-ExecutionPolicy Bypass` prefix exactly as shown in the README. `Bypass` applies **only to that single command** — it does not permanently weaken your machine's policy:

```powershell
powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/ForgeyClap/claude-forge/main/install.ps1 | iex"
```

macOS / Linux users don't hit this — the `bash` one-liner works directly:

```bash
curl -fsSL https://raw.githubusercontent.com/ForgeyClap/claude-forge/main/install.sh | bash
```

> [!NOTE]
> Prefer not to pipe a remote script at all? Use [Path C — Manual copy](README.md#-quickstart-60-second-setup) and inspect the files first.

---

## 4. Dashboard port already in use

> **Since 2026-07-31 the dashboard is the Command Center on `http://127.0.0.1:4100`** — one app for every project. The per-project Control Center described here is **retired**: it never starts automatically and only runs on an explicit `legacy dashboard` request. Its `log-event.cjs` is *not* retired and remains the run-event writer.

**Problem** — Starting the dashboard fails, or you're unsure which URL to open.

**Cause** — Each project's dashboard binds to a **deterministic port derived from the project path**, in the range **3737–3999**. If that exact port is already taken (another app, or a second Forge project that happened to hash nearby), the bind would collide.

**Fix** — Forge handles this for you: on `EADDRINUSE` it **automatically walks forward to the next free port** in the 3737–3999 band (wrapping around if needed) and prints the real URL it actually bound to. Just start it and read the line it prints:

```bash
node .claude/forge-dashboard/server.cjs
# → prints the real http://localhost:<port>
```

Useful follow-ups:

```bash
# See the assigned port without starting the server:
node .claude/forge-dashboard/server.cjs --assign-only

# Health check the running dashboard:
node .claude/forge-dashboard/server.cjs --health   # or: GET /api/health
```

- The chosen port is remembered in `.claude/forge-dashboard/PORT`. Delete that file to let Forge re-pick, or set `FORGE_DASHBOARD_PORT` (must be within 3737–3999) to pin one.
- The dashboard is **localhost-only and per-project** — it never binds to a public interface and never reads another project's `.claude/`.

> [!TIP]
> **Never trust a "dashboard is running" claim without a health check.** If `/api/health` doesn't answer, it isn't up — restart it and read the printed URL.

---

## 5. Node is older than 18

**Problem** — The `.cjs` tools or the dashboard throw syntax/runtime errors, or `doctor` shows a **FAIL** on the Node line.

**Cause** — Forge's zero-dependency tooling requires **Node.js 18+**. Older Node is not supported.

**Fix** — Check your version and upgrade if needed:

```bash
node --version   # must print v18.x or newer
```

`doctor` reports this explicitly, e.g. *"Node v16.x is below the minimum supported v18"*. Install a current LTS from [nodejs.org](https://nodejs.org) (or via `nvm` / `nvm-windows`), then re-run `/setup-forge doctor`.

---

## 6. Keys aren't saving

**Problem** — You pasted API keys into the fill-in file, said "done", but they don't appear in `.env` — or `doctor`/`/forge` acts as though no keys are set.

**Cause** — Several honest, deliberate behaviors can look like "not saving":

- `.env` is **gitignored on purpose**, so you won't see it staged in git — that's correct, not a failure.
- The engine **validates** each pasted value and **silently skips** anything that looks like an unfilled placeholder (`REPLACE_ME`, `xxxx`, `<your key here>`, `changeme`, …), is implausibly short, or is missing the expected prefix (e.g. an Anthropic key must start with `sk-ant-`). Skipped values are **not** stored.
- If **any** pasted value was skipped/rejected, the temp fill-file `.env.forge-setup` is **retained** (still gitignored) so nothing you typed is lost — the engine tells you exactly which key needs fixing.

**Fix** — Re-run the key flow and read the names-only summary it prints:

```
/setup-forge keys
```

Steps:
1. Open **`.env.forge-setup`**, paste each real key after the `=`, leave unused ones blank, save.
2. Say **"done"** (or **"klaar"** in Dutch).
3. The engine moves valid values into the gitignored `.env`, writes a values-free `.env.example`, and reports **stored / skipped / missing by key name** (never the secret value).

If a key shows as *skipped*, fix that one line (check for a stray placeholder, correct prefix, full length), save, and say "done" again. Keys are **optional** — you can leave them blank and add them later; Forge runs fine without any.

> [!NOTE]
> The engine **never prints or echoes a secret value back**, not even "to confirm". Seeing only key *names* in the summary is expected and correct.

---

## 7. "Could not verify .env is gitignored"

**Problem** — Onboarding prints an honest **warning** that it could not confirm `.env` is git-ignored, instead of the usual "gitignored, never committed" assurance.

**Cause** — Forge refuses to *claim* your secret is safe unless git **positively confirms** it. It runs `git check-ignore` against `.env`. If that can't return a definitive answer — usually because **git isn't installed** or the folder **isn't a git repository** — Forge degrades honestly and warns rather than making a false safety promise.

**Fix** — Pick one:

- **Make it a git repo** so verification can run:
  ```bash
  git init
  /setup-forge doctor
  ```
- **Or accept the tradeoff knowingly:** without git, Forge can't verify ignore status, so **be careful not to commit `.env` yourself**. The `.gitignore` still lists `.env`, `.env.*` (except `.env.example`) and `.env.forge-setup` — that protection just can't be machine-verified without git.

If git **is** present and you still see this, a `!`-negation elsewhere in `.gitignore` may be overriding the `.env` rule. Forge reinforces the pattern at the end of the file automatically; if it still can't confirm, open `.gitignore` and remove the conflicting `!.env`-style line, then re-run `/setup-forge doctor`.

---

## 8. ".env is already tracked by git" (hard stop)

**Problem** — Key setup refuses to proceed with a loud warning that `.env` is already tracked by git (engine exit code `3`).

**Cause** — A `.env` was committed **before** it was gitignored. Git keeps tracking a file even after you add it to `.gitignore`, so any secret written there could be committed and pushed. Forge treats this as a **hard stop** — it will not write keys into an exposed file.

**Fix** — Untrack it (keeps the local file), then rotate anything that may have leaked:

```bash
git rm --cached .env
git commit -m "stop tracking .env"
```

Then **rotate any keys** that were ever committed (assume they're compromised — they may be in your git history), and re-run:

```
/setup-forge keys
```

`doctor` surfaces the same condition on its `.env NOT git-tracked` line.

---

## 9. Git not installed

**Problem** — `doctor` notes git isn't available, or the leak-scan / safe-key verification is skipped.

**Cause** — Git is **recommended but not strictly required**. Forge's safe-key flow and leak scan use git to *verify* ignore status; without it, those checks degrade to an honest "could not verify, treated as pass" rather than failing outright.

**Fix** — Install git from [git-scm.com](https://git-scm.com) for the strongest safety guarantees (verified gitignore, tracked-`.env` detection, leak scan). Forge still works without it — just with fewer machine-verified promises. See [section 7](#7-could-not-verify-env-is-gitignored) for the exact tradeoff.

---

## 10. Full reset

**Problem** — Onboarding got into a confusing state and you want to start clean.

**Cause** — Markers (`.claude/.forge-setup.json` and the global `~/.claude/.forge-global.json`) cache your answers so `/forge` never re-asks. Sometimes you just want to redo the wizard from the top.

**Fix** — Re-run onboarding from scratch:

```
/setup-forge reset
```

> [!IMPORTANT]
> **Reset does NOT delete your `.env` or your keys.** It only re-runs the onboarding questions. If you also want to clear secrets, edit `.env` yourself — Forge never prints or wipes its values for you.

If the per-project payload seems damaged (missing `.claude/` files), run the self-healing pass instead — it **creates only what's missing** and never clobbers your edits:

```bash
node .claude/forge-bin/forge-setup.cjs self-heal
```

If `forge-setup.cjs` itself is missing, the per-project system was never installed here — re-run the [installer](README.md#-quickstart-60-second-setup) (`install.sh` / `install.ps1`) or do a manual copy, then run `/setup-forge` once.

---

## Still stuck?

1. Run `/setup-forge doctor` and note the exact FAIL line.
2. Confirm **Node 18+** (`node --version`) and that you're in the right project folder.
3. Check the [FAQ in the README](README.md#-faq).
4. Open an issue at **[github.com/ForgeyClap/claude-forge/issues](https://github.com/ForgeyClap/claude-forge/issues)** with the doctor output (it never contains secret values — safe to paste).

---

<div align="center">

Forge reports honestly — no fake "done", no invented tests, no imaginary agents. If a check didn't run, it says so.

[MIT](LICENSE) © ForgeyClap.

</div>
