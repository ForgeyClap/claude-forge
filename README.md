<div align="center">

<img src="screenshots/banner.png" alt="claude-forge — a zero-dependency, multi-agent build system for Claude Code" width="820">

# claude-forge

Turn Claude Code into a coordinated **team of agents** that builds, automates, reviews and ships — with a live per-project dashboard. **23 skills, 18 agents, one command: `/forge`.**

[![Works with Claude Code](https://img.shields.io/badge/Works%20with-Claude%20Code-8A2BE2?style=for-the-badge)](https://claude.com/claude-code)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Zero dependencies](https://img.shields.io/badge/dependencies-zero-brightgreen)](#what-you-get)
[![Node >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](#requirements)
[![GitHub stars](https://img.shields.io/github/stars/ForgeyClap/claude-forge?style=social)](https://github.com/ForgeyClap/claude-forge/stargazers)

<sub>▶ `/forge build me a landing page` fans out a right-sized team while the localhost dashboard updates live — *animated demo (`screenshots/demo.gif`) recorded before launch.*</sub>

<br>

**[Quickstart](#-quickstart-60-second-setup)**  ·  **[Features](docs/FEATURES.md)**  ·  **[Agents](AGENTS.md)**  ·  **[Commands](COMMANDS-QUICK-REF.md)**  ·  **[Troubleshooting](TROUBLESHOOTING.md)**  ·  **[Contributing](CONTRIBUTING.md)**

</div>

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

This gives you the commands, 18 agents and curated skills. It runs read-only from the plugin cache — no dashboard and no key setup (see the [comparison table](#-plugin-vs-installer)).

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
> **New to Forge?** You do **not** need to learn 23 skills or 18 agents. Run `/setup-forge` once, then just say `/forge <what you want>` — Forge picks the smallest right-sized team and does it.

---

## 🔌 Plugin vs Installer

The plugin is **LITE**; the installer is **FULL**. This split is architectural, not a limitation we chose: a plugin lives in a read-only cache and cannot write your project or `~/.claude`.

| | 🔌 **Plugin** | 🛠️ **Installer / Manual** |
|---|---|---|
| **What you get** | Commands + 18 agents + curated skills | The full system |
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
| 🧠 **23 skills** | routing, 7 domain playbooks, reporting, verification, ship-readiness — see [docs/FEATURES.md](docs/FEATURES.md) |
| 📊 **Per-project dashboard** | isolated, localhost-only, shows *real* activity |
| ⌨️ **`/forge` + `/setup-forge`** | one command to work, one to onboard — see [COMMANDS-QUICK-REF.md](COMMANDS-QUICK-REF.md) |
| ✅ **Honest agent ledger** | every run records which agents *actually* ran, with evidence |
| 🪶 **Zero dependencies** | plain Node `.cjs` — no `npm install`, ever |

> [!NOTE]
> Forge **ships 18 agents** and drives them as real Claude Code Agent-tool subagents. It can also **route to your wider agent ecosystem** (any ECC / Claude Code agent types you have installed) when a task calls for it — but only these 18 come in the box, so that is the number we quote.

---

## 🆕 What's new — v2.0.0

<details>
<summary><b>The first public release of Forge V2</b> — click to expand</summary>

- **One command, a whole team.** `/forge <task>` classifies the work and assembles the smallest right-sized team of the 18 agents.
- **`/setup-forge` onboarding wizard** with a beginner-safe, gitignored-by-default API-key flow (temp file → you fill → Forge places it safely → temp deleted; values never committed or echoed).
- **Ships four ways:** Claude Code plugin, one-line installer (`sh`/`ps1`), first-run wizard, or manual copy.
- **Live per-project dashboard**, honest agent ledger, project memory — all **zero-dependency** Node.
- **Internationalized:** wizard, replies, reports and dashboard adapt to your language (English default).
- **Hardened:** the key-flow was put through five adversarial break-swarm rounds; 31 real issues found and fixed, each mutation-verified. See [CHANGELOG.md](CHANGELOG.md).

</details>

---

## ⚙️ How it works

```
You (the orchestrator)
        │  /forge <task>
        ▼
  forge-router  ──►  dynamic agent pool  ──►  per-task specialists
                                                     │
                                          optional Codex review
                                                     │
                                                     ▼
                                          honest forge-report + dashboard
```

Forge classifies your task, assembles the **smallest relevant** team, runs it **in your project folder only**, optionally adds an independent review, and writes a truthful report. **Project-isolated. Zero dependencies.**

---

## 🧭 The onboarding wizard

`/setup-forge` asks four friendly questions (name, goal, project type, language), auto-detecting what it can from your repo. Then comes the **beginner-safe key flow**:

1. Forge writes a temporary, **already-gitignored** fill-in file with labelled placeholders and where-to-get-each-key links.
2. You paste your keys, save, and say **"done"**.
3. Forge moves the values into a gitignored `.env`, writes a values-free `.env.example`, and **deletes the temp file** — nothing is ever committed, and secret values are never echoed back.

Keys are **optional** — Forge runs fine without any.

<sub>*Screenshot of the `/setup-forge` Q&A + safe key flow added before launch → `screenshots/`.*</sub>

---

## 📊 The dashboard

Each project gets its **own** local Control Center on a deterministic port (3737–3999):

```bash
node .claude/forge-dashboard/server.cjs
# prints the real http://localhost:<port>, exposes GET /api/health
```

It reads each run's event log **read-only** and shows **real activity only** — never fabricated, never shared, never global. It never reads another project's `.claude/`.

<sub>*Dashboard screenshot added before launch → `screenshots/dashboard.png`.*</sub>

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

**Forge speaks your language.** The onboarding wizard, replies, reports and dashboard adapt to the language you pick in `/setup-forge`. **English is the default**; translations are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

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
| [**docs/FEATURES.md**](docs/FEATURES.md) | The complete catalogue — every skill, playbook, tool and guarantee, explained in depth. |
| [**AGENTS.md**](AGENTS.md) | All 18 agents (12 permanent Bosses + 6 specialists) — role, when-used, tools, and the QA fix-loop. |
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
