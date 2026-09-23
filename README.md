<div align="center">

<img src="screenshots/banner.png" alt="claude-forge — a zero-dependency, multi-agent build system for Claude Code" width="820">

# claude-forge

Turn Claude Code into a coordinated **team of agents** that builds, automates, reviews and ships — with a live per-project dashboard. **59 skills, 19 agents, one command: `/forge`.**

[![Works with Claude Code](https://img.shields.io/badge/Works%20with-Claude%20Code-8A2BE2?style=for-the-badge)](https://claude.com/claude-code)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Zero dependencies](https://img.shields.io/badge/dependencies-zero-brightgreen)](#what-you-get)
[![Node >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](#requirements)
[![GitHub stars](https://img.shields.io/github/stars/ForgeyClap/claude-forge?style=social)](https://github.com/ForgeyClap/claude-forge/stargazers)

<sub>▶ `/forge build me a landing page` fans out a right-sized team while the localhost dashboard updates live</sub>

<br>

**[How it works](docs/HOW-IT-WORKS.md)**  ·  **[Quickstart](#-quickstart-60-second-setup)**  ·  **[Features](docs/FEATURES.md)**  ·  **[Agents](AGENTS.md)**  ·  **[Cost](docs/TOKEN-USAGE.md)**  ·  **[Commands](COMMANDS-QUICK-REF.md)**  ·  **[Troubleshooting](TROUBLESHOOTING.md)**

</div>

---

## 🤖 Letting Claude install it for you

Paste this repository's link into Claude Code and say **"install this"**.

Your assistant should read **[AI-INSTALL.md](AI-INSTALL.md)** — it contains the exact commands, the
pre-flight checks, the verification it must actually run before claiming success, and what it must
never do (no secrets in config, no touching your existing `.claude/`, no unverified "it works").

---

## 🚀 Quickstart (60-second setup)

Three ways in — **plugin is fastest**. Every path ends at the same first run: **`/setup-forge`**.

### Path A — Claude Code plugin *(fastest, ~60s try)*

Inside Claude Code:

```
/plugin marketplace add ForgeyClap/claude-forge
/plugin install forge@claude-forge
/forge:setup-forge
```

This gives you the commands, 18 agents and 31 curated skills (the plugin is the LITE bundle; see the table below). It runs read-only from the plugin cache — no dashboard and no key setup (see the [comparison table](#-plugin-vs-installer)).

### Path B — One-line installer *(full system)*

**macOS / Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/ForgeyClap/claude-forge/main/install.sh | bash
```

**Windows (PowerShell):**

```powershell
powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/ForgeyClap/claude-forge/main/install.ps1 | iex"
```

Then, inside your project, run `/setup-forge`. *(The `-ExecutionPolicy Bypass` prefix is required for `irm | iex`.)*

### Path C — Manual copy *(no scripts)*

<details>
<summary>Clone and copy the payload yourself</summary>

```bash
git clone https://github.com/ForgeyClap/claude-forge
# per-project system → your project
cp -r claude-forge/.claude your-project/.claude
# global core → your user config (makes /forge work everywhere)
cp -r claude-forge/global-install/.claude/* ~/.claude/
```

**Windows:**

```powershell
Copy-Item -Recurse claude-forge\.claude your-project\.claude
Copy-Item -Recurse claude-forge\global-install\.claude\* $HOME\.claude\
```

> Manual copy overwrites. Back up your own `~/.claude/skills` and `~/.claude/agents` first — the installer does timestamped, file-by-file backups automatically, so prefer Path B.

</details>

Then run `/setup-forge` once, and you are ready.

**Bam — you are ready.** ✨

---

> [!TIP]
> **New to Forge?** You do **not** need to learn 59 skills or 19 agents. Run `/setup-forge` once, then just say `/forge <what you want>` — Forge picks the smallest right-sized team and does it.

---

## 🔌 Plugin vs Installer

The plugin is **LITE**; the installer is **FULL**. This split is architectural, not a limitation we chose: a plugin lives in a read-only cache and cannot write your project or `~/.claude`.

| | 🔌 **Plugin** | 🛠️ **Installer / Manual** |
|---|---|---|
| **What you get** | Commands + 18 agents + 31 curated skills | The full system: 19 agents, 59 skills, 93 tools |
| **Files written** | None (read-only cache) | `./.claude` + `~/.claude` core |
| **Live dashboard** | No | ✅ Yes, localhost |
| **Key & `.env` setup** | No | ✅ Yes, via `/setup-forge` |
| **Commands** | Namespaced `/forge:forge` | Bare `/forge` |
| **Best for** | Quick trial | Real projects |

---

## 🆚 Claude Code alone vs Claude Code + Forge

Honest and non-adversarial — only rows that actually ship.

| Capability | Claude Code alone | + Forge |
|---|:---:|:---:|
| Multiple agents on one task | Manual | ✅ Automatic, right-sized |
| Coordination & task routing | — | ✅ `forge-router` |
| Automated review pass | On request | ✅ Optional, built in |
| Live progress dashboard | — | ✅ Per-project localhost |
| Project memory & task history | — | ✅ `FORGE_*` files |
| Domain playbooks (web / n8n / RAG / scraping) | — | ✅ Included |
| First-run onboarding wizard | — | ✅ `/setup-forge` |
| Runtime dependencies | — | ✅ **Zero** |

---

## 📦 What you get

| | |
|---|---|
| 🤖 **18 built-in agents** | 12 permanent Bosses (boss, head-chef, build, review, test, UI, SEO, search, security, integration, docs, skill) + 6 specialists — see [AGENTS.md](AGENTS.md) |
| 🧠 **59 skills** | routing, 7 domain playbooks, reporting, verification, ship-readiness — see [docs/FEATURES.md](docs/FEATURES.md) |
| 📊 **Command Center dashboard** | one localhost app (`:4100`) that auto-discovers your projects and shows *real* activity per project |
| ⌨️ **`/forge` + `/setup-forge`** | one command to work, one to onboard — see [COMMANDS-QUICK-REF.md](COMMANDS-QUICK-REF.md) |
| ✅ **Honest agent ledger** | every run records which agents *actually* ran, with evidence |
| 🪶 **Zero dependencies** | plain Node `.cjs` — no `npm install`, ever |

> [!NOTE]
> Forge **ships 19 agents** (12 permanent Bosses + 7 specialists; the LITE plugin carries 18) and drives them as real Claude Code Agent-tool subagents. It can also **route to your wider agent ecosystem** (any ECC / Claude Code agent types you have installed) when a task calls for it — but only these 18 come in the box, so that is the number we quote.

---

## 🆕 What's new — v2.4.0 (see [CHANGELOG.md](CHANGELOG.md) for every release)

<details>
<summary><b>The first public release of Forge V2</b> — click to expand</summary>

- **One command, a whole team.** `/forge <task>` classifies the work and assembles the smallest right-sized team of the 18 agents.
- **`/setup-forge` onboarding wizard** with a beginner-safe, gitignored-by-default API-key flow (temp file → you fill → Forge places it safely → temp deleted; values never committed or echoed).
- **Ships four ways:** Claude Code plugin, one-line installer (`sh`/`ps1`), first-run wizard, or manual copy.
- **Live per-project dashboard**, honest agent ledger, project memory — all **zero-dependency** Node.
- **Speaks your language:** replies and reports follow the language you write in (English default). The dashboard UI itself is English-only today — a translated dashboard was documented before it was built and is not shipped.
- **Hardened:** the key-flow was put through five adversarial break-swarm rounds; 31 real issues found and fixed, each mutation-verified. See [CHANGELOG.md](CHANGELOG.md).

</details>

---

## ⚙️ How it works

Normally Claude Code is **one assistant**. Forge turns it into a **coordinated team**: you give one instruction, Forge picks the right-sized team, does the work in parallel, checks its own work, and reports back — honestly.

```
You:  /forge build me a landing page for my bakery
          │
          ▼
  1. Classify   →  what kind of job is this?               (forge-router)
  2. Size team  →  the smallest team that fits (1–12+)      (fan-out L1–L4)
  3. Plan       →  split into exact work packages           (Boss → Head Chef)
  4. Build      →  specialists do the work, in parallel     (Build / UI / SEO / … Bosses)
  5. Check      →  real tests + review against YOUR goal    (Test Boss → Review Boss)
  6. Fix-loop   →  fail → report → fix → re-test (bounded)
          │
          ▼
You get:  the finished result + an honest report of what actually ran + a live dashboard.
```

**Nothing is called "done" until it's proven** — Forge never fabricates a passing test, a fake "done", or an agent that didn't run. Every run is **project-isolated** (only your target folder) and **zero-dependency**.

📖 **Want the full picture?** [**How Forge works — the complete walkthrough →**](docs/HOW-IT-WORKS.md) — a real bakery-landing-page example, the QA loop step by step, and exactly what you see.

---

## 💸 What does it cost?

Honest answer: **a team of agents uses more tokens than a single chat** — that's the price of a coordinated, self-checking team. Forge's job is to spend them **well**:

- **Tiered models** — Opus only for the hard/critical work, **Sonnet** for most of it, **Haiku** for trivial steps, and pure mechanical edits use **no model at all**.
- **Right-sized teams** — a one-line fix doesn't summon a swarm; over-spawning is treated as waste, not a feature.
- **Real cost visibility** — a live dashboard cost meter, plus a usage guard that reads the official `/usage` endpoint and **pauses at 95%** of your window, then resumes after the reset.

You pay through your existing Claude Code plan (no separate billing), and Forge **never invents a "savings" number**.

💸 **[Full token & cost guide →](docs/TOKEN-USAGE.md)**

---

## 🧭 The onboarding wizard

`/setup-forge` asks four friendly questions (name, goal, project type, language), auto-detecting what it can from your repo. Then comes the **beginner-safe key flow**:

1. Forge writes a temporary, **already-gitignored** fill-in file with labelled placeholders and where-to-get-each-key links.
2. You paste your keys, save, and say **"done"**.
3. Forge moves the values into a gitignored `.env`, writes a values-free `.env.example`, and **deletes the temp file** — nothing is ever committed, and secret values are never echoed back.

Keys are **optional** — Forge runs fine without any.

---

## 📊 The dashboard

The **Forge Command Center** is the dashboard — one local app on `http://127.0.0.1:4100` that auto-discovers your Forge projects and shows strictly per-project data. It ships in `command-center/`:

```bash
cd command-center/dashboard && npm install && npm run build   # build the SPA once
cd ../.. && node command-center/gateway/supervisor.mjs        # start it (restarts the gateway if it dies)
# then open http://127.0.0.1:4100 — GET /api/health must answer before you trust it
```

The gateway is zero-dependency Node and is the **only** layer allowed to spawn the real `claude` CLI. Run events stay per-project: every run writes `.claude/forge-runs/<run_id>/events.jsonl` via `.claude/forge-dashboard/log-event.cjs`, and the Command Center reads those **read-only**. It shows **real activity only** — never fabricated, never shared across projects.

> **The old per-project Control Center is retired.** `.claude/forge-dashboard/server.cjs` still exists and still works on an explicit `legacy dashboard` request, but nothing starts it automatically any more. Its `log-event.cjs` is *not* retired — that remains the run-event writer described above.

---

## 🍳 Examples & recipes

```
/forge build me a landing page for my bakery
/forge create an n8n automation that emails new leads to my inbox
/forge refactor the auth module and keep the tests green
/forge audit this codebase for security and dead code
/forge scrape public product listings into a CSV
```

---

## 🔐 Configuration & safe key setup

- **`.env.example`** ships with key *names* and comments only — never values. Prefer `/setup-forge` over hand-editing.
- **Gitignore invariant:** `.env`, `.env.*` (except `.env.example`) and the temp `.env.forge-setup` are ignored. If a `.env` is already tracked, Forge stops and warns you to `git rm --cached .env` and rotate.
- **Storage tier:** the honest default is a gitignored `.env` with `0600` perms. An OS keychain (macOS Keychain / Windows Credential Manager / libsecret) is an **optional advanced** upgrade — never required, never faked.
- **Model tiers** are configurable in `.claude/config/` — route routine work to cheaper models and escalate high-risk work.

---

## ❓ FAQ

**Do I need to install dependencies?** No. Forge is plain Node `.cjs` — nothing to `npm install`.

**Will it touch my other projects?** No. Forge is **project-isolated** and works only in the target folder.

**Is it safe with my API keys?** Yes. The temp `.env` is gitignored the moment it is created, keys are moved into place and the temp file is deleted, and values are never committed or printed back.

**Why is the command `/forge:forge` sometimes and `/forge` other times?** Plugin commands are always **namespaced** (`/forge:forge`, `/forge:setup-forge`). The installer copies the core into `~/.claude`, giving you the **bare** `/forge` and `/setup-forge`. Both do the same thing.

**Does it work on Windows?** Yes — Windows-first, and cross-platform (macOS/Linux) throughout.

---

## 🚫 What it does *not* do

- It does **not** run without Claude Code — Forge is a configuration layer on top of it.
- It does **not** deploy, push, or spend money on your behalf without you asking.
- It does **not** fabricate results — no fake "done", no invented tests, no imaginary agents.
- It does **not** ship a hosted/global dashboard — every dashboard is local and per-project.

**Roadmap:** deeper reviewer integrations and more domain playbooks. See the architecture decision record: [`docs/adr/0001-plugin-vs-installer-split.md`](docs/adr/0001-plugin-vs-installer-split.md).

---

## 🌍 Internationalization

**Forge speaks your language.** The onboarding wizard, replies and reports follow the language you pick in `/setup-forge`. **English is the default**; translations are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

---

## ⭐ Star history

If Forge saves you time, a star helps others find it.

[![GitHub stars](https://img.shields.io/github/stars/ForgeyClap/claude-forge?style=social)](https://github.com/ForgeyClap/claude-forge/stargazers)

[![Star History Chart](https://api.star-history.com/svg?repos=ForgeyClap/claude-forge&type=Date)](https://star-history.com/#ForgeyClap/claude-forge&Date)

<sub>No fabricated stars or testimonials — the counts above are live from GitHub.</sub>

---

## 📚 Documentation

| Doc | What's in it |
|---|---|
| [**docs/HOW-IT-WORKS.md**](docs/HOW-IT-WORKS.md) | **Start here.** Plain-language walkthrough of a task from your sentence to a checked result, with a real example and the QA loop. |
| [**docs/TOKEN-USAGE.md**](docs/TOKEN-USAGE.md) | Honest token & cost guide — model tiering, right-sized teams, the usage guard, and how to keep it cheap. |
| [**docs/FEATURES.md**](docs/FEATURES.md) | The complete catalogue — every skill, playbook, tool and guarantee, explained in depth. |
| [**AGENTS.md**](AGENTS.md) | All 19 agents (12 permanent Bosses + 7 specialists) — role, when-used, tools, and the QA fix-loop. |
| [**COMMANDS-QUICK-REF.md**](COMMANDS-QUICK-REF.md) | Every command and terminal tool with examples (namespaced plugin vs bare installer forms). |
| [**TROUBLESHOOTING.md**](TROUBLESHOOTING.md) | Symptom → cause → fix for common newcomer issues — run `/setup-forge doctor` first. |
| [**CONTRIBUTING.md**](CONTRIBUTING.md) · [**SECURITY.md**](SECURITY.md) · [**CHANGELOG.md**](CHANGELOG.md) | How to contribute · report a vulnerability · release history. |
| [**docs/adr/0001…**](docs/adr/0001-plugin-vs-installer-split.md) | Architecture decision: why the plugin is lite and the installer is full. |

---

## Requirements

- **[Claude Code](https://claude.com/claude-code)** — Forge is a configuration layer for it.
- **Node.js 18+** — for the `.cjs` tools and the dashboard (no packages to install).
- **Git** — recommended (leak-scan and safe key setup use it), not strictly required.

---

## 🤝 Contributing

Contributions welcome — new skills, agents, playbooks and translations. See [CONTRIBUTING.md](CONTRIBUTING.md) and our [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

**New to the internals?** Read the project-memory files in this order:
`FORGE_PROJECT_PROFILE.md` → `FORGE_MEMORY.md` → `FORGE_TASK_HISTORY.md` → `FORGE_AGENT_LEDGER.md`.

---

## 📄 License

[MIT](LICENSE) © ForgeyClap.

<div align="center">

**If Forge is useful, [give it a ⭐](https://github.com/ForgeyClap/claude-forge) — it genuinely helps.**

</div>
