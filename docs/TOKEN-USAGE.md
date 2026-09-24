# Token usage & cost

*An honest look at what Forge costs to run, why, and how it keeps a multi-agent workflow efficient. No fake numbers — Forge never fabricates "savings".*

---

## The honest headline

Let's be straight up front:

> **A team of agents uses more tokens than a single chat.** Spawning sub-agents to work in parallel *costs* tokens — that's the price of getting a coordinated, self-checking team instead of one assistant.

Forge's job is **not** to be free. It's to spend those tokens **well**: put the expensive model only where it matters, use cheap models (or no model at all) for the rest, and never hire a bigger team than the task needs.

You pay for tokens through your **existing Claude Code / Anthropic plan** — Forge adds no separate billing. What you spend shows up in `/usage` and in Forge's own dashboard cost meter (both from **real** data, never estimates that Forge made up).

---

## Where the tokens go: tiered model routing

Forge routes each piece of work to the **cheapest model that can do it well**. This is the biggest lever on cost.

| Tier | Model | Used for |
|---|---|---|
| 🧠 **Lead / hardest** | **Opus** | Your main session, planning, architecture, security/auth, database migrations, the final "is this actually done?" verdict, adversarial review. |
| ⚙️ **Default work** | **Sonnet** | Most implementation, most reviews, tests, UI, research — the versatile workhorse. |
| 🪶 **Trivial** | **Haiku** | Classifying the task, short summaries, writing ledger/memory/dashboard events, formatting. |
| ✂️ **Mechanical** | **no model** | Pure find-and-replace / rename edits are done with the `Edit` tool directly — **zero LLM cost.** |

Rules that keep this honest (from `FORGE_MODEL_ROUTING.json`):

- **Hard work is always Opus** — architecture, security, migrations, final verdict, production gates. Never downgraded to save a few tokens.
- **High-risk work is never Haiku** — multi-file code, security, architecture.
- **Everything else defaults to Sonnet**, and a specific agent is escalated to Opus *only* when it's the highest-stakes step on that task, or dropped to Haiku when it's genuinely trivial.
- Forge **logs the actual model each agent ran on** in the agent ledger — so you can always see where your tokens went.

> [!NOTE]
> Forge **cannot switch your main session's model for you** — that's your choice (`/model opus`, `/model opusplan`, `/model sonnet`). It can only *recommend*. The recommended setup is **`opusplan`** (Opus plans, Sonnet executes) or Opus for the Lead, and let Forge tier the sub-agents from there.

---

## The other big lever: right-sized teams

The **#1 source of waste is over-spawning agents.** Forge is built to avoid it:

| Level | Team size | When |
|---|---|---|
| **L1** | 1–3 agents | small fix, single page, quick audit |
| **L2** | 3–6 agents | landing page, small automation |
| **L3** | 6–12 agents | full-stack feature, multi-part build |
| **L4** | phased | large system, built in stages |

Forge picks the **smallest level that fits**. A one-line fix does **not** summon a swarm. A big migration doesn't get crammed into three agents. Matching team size to the job is where most of the real savings come from.

---

## Effort tuning (often better than switching models)

Every model runs at an **effort level** — `low · medium · high · xhigh`. Forge uses:

- **low** for mechanical work,
- **high** by default,
- **xhigh** for the hardest reasoning.

Turning effort **down** on routine work often saves more than switching to a smaller model, while keeping the same model's quality where it counts. (For a one-off deep pass, adding `ultrathink` to a prompt raises the thinking budget without changing your session.)

---

## Built-in cost visibility & guard rails

Forge ships two zero-dependency tools so you're never guessing:

- **`forge-cost.cjs`** — samples **real** token/cost data (it can read Claude Code's own `--output-format json` cost envelope) and feeds the dashboard's **Cost / Token meter**. It **never fabricates a dollar figure** — if it doesn't have a real number, it says so.
- **`usage-guard.cjs`** — a real subscription watchdog, **on by default since 2.7.0**. It reads the **official Anthropic usage endpoint** (the same source as `/usage` — no estimates). When your 5-hour session window *or* your weekly window reaches **98 %**, it marks your account as paused: Forge checks that mark before every new phase and stops there (and pauses any unattended Paperclip agents; the dashboard stays up). It **resumes after the reset**. On any error it does nothing (fail-safe), and it never logs your token.

So you can watch spend live on the dashboard, and Forge won't blow past your plan's limits without stopping.

### What the guard adds on top of Claude Code

Recent Claude Code versions (2.1.234 and later) **already wait at a limit and continue by themselves after the reset** — you do not lose your work when you hit a limit. Forge's guard is therefore about the moment *before* the limit: it pauses at 98 %, between phases, so the next session does not start from a half-finished change. This is best effort: the guard measures every 2 minutes (`usage-guard.interval`), so a step can still cross the limit between two samples — it is a pause before the limit, not a guaranteed instant block.

| Setting | Default | Change it |
|---|---|---|
| `usage-guard` | on | `/forge config set usage-guard off` switches it off (the tool then refuses to start). |
| `usage-guard.pause-at` | 98 % | `/forge config set usage-guard.pause-at 90` — any whole number from 50 to 99. |
| `usage-guard.resume-at` | 0 % (= after the reset) | advanced — `/forge config list --all` |
| `usage-guard.interval` | 120 s | advanced — how often it measures |
| `usage-guard.nvidia-shift-at` | 80 % weekly | advanced — from here Forge *prefers* NVIDIA for bulk work (a hint only; it pauses nothing) |

Or just say it in chat: *"pause at 95 percent"*, *"zet de usage guard uit"*. Forge restarts the running guard itself so a new value takes effect.

**Why it is on by default (a change from 2.4.0).** In 2.4.0 the guard was opt-in, because it reads a credential. In 2.7.0 the maintainer made it default-on so beginners are protected without having to know it exists — and made it say exactly what it does instead: when it really starts a new watcher, it prints that it reads your Claude login token **locally** from `~/.claude/.credentials.json` and sends it **only** to `api.anthropic.com`, followed by the one command that switches it off. Full details: [SETTINGS.md](SETTINGS.md#what-the-usage-guard-does-with-your-data).

**Extra usage credits cost money.** If your plan offers paid extra usage, Forge never turns it on for you — spending money is a hard gate that always asks first.

---

## How *you* keep it cheap

A practical checklist (these are the habits Forge itself follows):

- **Keep tasks focused.** One clear job per `/forge` run beats one giant vague request.
- **Use `/clear` between unrelated tasks** so you're not paying to re-read old context. Forge reminds you at the end of every finished run.
- **Your limits are shared.** The 5-hour window and the weekly limit also count chats in the Claude app, claude.ai and the desktop app. `/usage` shows where you stand. (More in [CLAUDE-CODE-BASICS.md](CLAUDE-CODE-BASICS.md).)
- **Let Forge pick the team** — don't force a big swarm for a small job.
- **Reference files by path**, don't paste whole files into the prompt.
- **Set your session model deliberately** — `opusplan` or Sonnet for routine work; Opus for the high-stakes runs.
- **Watch the dashboard cost meter** and `/usage` — real numbers, in real time.
- *(Advanced, optional)* **Offload heavy build work to NVIDIA models.** Forge can call NVIDIA NIM models via `nvidia-provider.cjs` for the bulk implementation while your Lead stays on Claude — useful for large jobs where you want to spare Claude quota. The `nvidia` setting is on, but **nothing happens until you put an `NVIDIA_API_KEY` in `.env`** (or `~/.claude/nvidia.env`); `/forge config set nvidia off` keeps it off even with a key. A mock is never presented as a real result, and keys live only in `.env` / a global key file (never in code).

---

## Honest expectations

We won't quote you a fake "it costs X tokens" number, because the real answer is **"it depends on the task"** — a one-page fix is cheap; a full-stack build with a QA loop and adversarial review is not. What we *can* promise:

- Forge **shows you the real cost** (dashboard + `/usage`), never an invented one.
- It **spends on the expensive model only where quality genuinely needs it**.
- It **pauses before you hit your limit** (98 % by default) and resumes after the reset.
- It **logs the actual model** every agent used, so nothing is hidden.

If you want the cheapest possible run: keep the task small, keep the session on Sonnet, and let Forge size the team. If you want the highest quality on something critical: put the Lead on Opus and let the fix-loop and review do their thing.

---

## See also

- 🔧 **[How Forge works →](HOW-IT-WORKS.md)** — the full task lifecycle.
- 🤖 **[The agents →](../AGENTS.md)** — and which model tier each tends to run on.
- 🧩 **[Everything Forge can do →](FEATURES.md)**
- ⚙️ **[Every setting and its default →](SETTINGS.md)**
- 🧭 **[Claude Code basics for beginners →](CLAUDE-CODE-BASICS.md)**
