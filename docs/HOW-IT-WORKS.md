# How Forge works

*A plain-language walkthrough of what actually happens when you run `/forge` — from your one sentence to a finished, checked result.*

> [!TIP]
> **New here? Read this first.** In 5 minutes you'll understand exactly what Forge does, who does the work, what you see, and roughly what it costs.

---

## The 30-second mental model

Normally, Claude Code is **one assistant you chat with** — great at one thing at a time.

**Forge turns that into a small, coordinated company.** You give **one instruction**, and Forge:

1. figures out what kind of job it is,
2. assembles the **right-sized team** of specialist agents,
3. does the work (in parallel where it can),
4. **checks its own work** with a real QA loop,
5. and hands you a finished result **plus an honest report of what actually happened.**

You are the client. The **Lead agent** is your project manager. The **Bosses** are the department heads. You never manage 18 agents yourself — you just say what you want.

```
You:  /forge build me a landing page for my bakery
              │
              ▼
         ┌──────────┐   picks the right team, does the work,
         │  Forge   │   checks it, and reports back — honestly.
         └──────────┘
              │
              ▼
You get:  a finished landing page + a report of exactly what ran, and a live dashboard you can watch.
```

---

## What happens when you run `/forge <task>`

Every task flows through the same lifecycle. Small tasks skip the heavy steps; big tasks use all of them.

| # | Step | What happens | Who |
|---|------|--------------|-----|
| 1 | **Classify** | Forge reads your request and works out the *kind* of job (website, full-stack app, automation, RAG chatbot, scraper, refactor, audit, research…). | `forge-router` |
| 2 | **Route & size the team** | It picks the **smallest team that fits** the job and attaches the right domain playbook + skills. A tiny task gets 1–3 agents; a big one gets a larger swarm. | `forge-router` |
| 3 | **Understand the goal** *(bigger tasks)* | If the request is fuzzy, Forge asks a **short set of clarifying questions** and captures the real goal before building anything. | `forge-intake` |
| 4 | **Plan** | The **Lead (Boss)** splits the mission into *work packages*. **Head Chef** turns each into an exact, step-by-step task and checks nothing is vague, random, or duplicated. | Boss → Head Chef |
| 5 | **Dispatch** | Forge spawns **real Claude Code sub-agents** — the Bosses and specialists — as an actual team. Independent work runs **in parallel**, isolated in git worktrees so agents never overwrite each other. | Head Chef → Bosses |
| 6 | **Build** | **Build Boss** writes the code; domain Bosses (**UI**, **SEO**, **Security**, **Integration**…) do their part of the job. | Build + domain Bosses |
| 7 | **Check (the QA fix-loop)** | Nothing is called "done" until it's proven. See the loop below. | Test Boss → Review Boss |
| 8 | **Independent review** *(high-stakes, optional)* | For sensitive changes (auth, payments, migrations), an **optional** independent Codex review can be run. It never blocks a normal build. | `codex-reviewer` |
| 9 | **Deliver** | You get an **honest report** — what was built, which files changed, which agents *actually* ran, which checks *actually* passed, and what was **not** done. | Docs Boss / Lead |

Throughout, a **live per-project dashboard** shows the real activity, and an **agent ledger** records who did what — with evidence.

---

## A real walkthrough

Let's follow one concrete command end-to-end:

```
/forge build me a landing page for my bakery
```

1. **Classify** → *website / landing page.* Forge loads the `forge-website` playbook (responsive design, accessibility, SEO, performance, a screenshot review).
2. **Size the team** → this is a small, well-defined job → **L1 / small team** (a handful of agents, not a swarm).
3. **Plan** → the **Boss** defines the work: *hero, menu section, gallery, opening hours, contact form, mobile layout.* **Head Chef** turns these into exact tasks.
4. **Build** → **Build Boss** scaffolds the page and writes real content (no "lorem ipsum"). **UI Boss** makes it responsive and polished on desktop, tablet and mobile.
5. **Check** →
   - **Test Boss** runs real checks (the page loads, the form works, no console errors).
   - **UI Boss** does a **screenshot review** at phone/tablet/desktop widths and fixes anything that looks off.
   - **SEO Boss** checks titles, headings, metadata, image sizes.
   - **Review Boss** does the final pass against *your actual goal* — is this a landing page a bakery would be happy with? Any missing feature, weak spacing, oversized text, empty state?
6. **Fix-loop** → if Review Boss finds a real gap, it files a **failure report** → back to Boss → Head Chef assigns a fix → re-tested. This repeats (bounded) until it genuinely passes.
7. **Deliver** → you get the finished page **plus** a report: *"Built: hero, menu, gallery, hours, contact form. Responsive verified at 375/768/1440 via screenshots. SEO metadata added. Tests: form submit + no console errors — passed. Not done: no backend for the form yet (static only) — say the word and I'll wire it up."*

That last line is the point: **Forge tells you the truth**, including what it *didn't* do.

---

## The QA fix-loop (why "done" means done)

The single most important thing Forge does differently: **it does not trust its own first draft.**

```
 subagent self-review
        │
        ▼
   Test Boss  ── real automated tests (e.g. Playwright for web)
        │
        ▼
 domain Bosses ── UI / SEO / Security / Integration checks
        │
        ▼
   Review Boss ── final QA against YOUR actual goal
        │
   pass? ──yes──►  deliver + honest report
        │
        no
        ▼
 failure report ─► Boss ─► Head Chef ─► fix ─► back to Test Boss  (bounded loop)
```

If a check *didn't* run, the report says so. If a test failed, you see the real output. Forge **never** fabricates a passing test, a fake "done", or an agent that didn't actually run — that honesty is enforced by the **agent ledger** (every agent's real status + evidence) and the dashboard (which shows **real activity only**).

---

## The team

You don't hire them — Forge does, per task. See [AGENTS.md](../AGENTS.md) for the full roster. In short:

- **Boss** — the Lead / project manager. Owns the mission, decides the fix strategy.
- **Head Chef** — turns the mission into exact work packages; prevents vague or duplicate work.
- **12 permanent Bosses** — Build, Review, Test, UI, SEO, Search, Security, Integration, Docs, Skill (+ Boss + Head Chef).
- **6 specialists** — Codex-reviewer, Data-scientist, Electron-pro, MCP-developer, ML-engineer, Payment-integration — pulled in only when a task needs them.

**How big is the team?** Forge picks the smallest that fits:

| Level | Size | Example |
|---|---|---|
| **L1** | 1–3 agents | a small fix, a single page, a quick audit |
| **L2** | 3–6 agents | a landing page, a small automation |
| **L3** | 6–12 agents | a full-stack feature, a multi-part build |
| **L4** | phased | a large system, built in stages |

> Over-spawning agents to "look impressive" is treated as waste, not a feature — smaller is better when it fits.

---

## What you actually see

- **A live dashboard** (the *Forge Control Center*) on `http://localhost:<port>` — real-time activity for the current run, per project, local-only. It shows *real* events, never fabricated progress.
- **An honest final report** — status, changed files, which agents ran, which checks passed, blockers, and the next safe step.
- **The agent ledger** (`FORGE_AGENT_LEDGER.md`) — proof of which agents actually worked, with evidence.
- **Project memory** (`FORGE_*` files) — Forge reads it before a task and updates it after, so it remembers your project.

---

## What it will and won't do

- ✅ Works **only in your target project folder** (project-isolated — never touches your other projects).
- ✅ Tells you the **truth** — no fake results, no invented tests, no imaginary agents.
- 🚫 Won't **deploy, push, or spend money** on your behalf without you asking.
- 🚫 Won't run without **Claude Code** — Forge is a layer on top of it.

---

## Next

- 💸 **[Token usage & cost →](TOKEN-USAGE.md)** — how much this costs and how Forge keeps it efficient (honest, no fake numbers).
- 🧩 **[Everything Forge can do →](FEATURES.md)** — the full catalogue of skills, playbooks and tools.
- 🤖 **[The agents →](../AGENTS.md)** — every Boss and specialist.
- ⌨️ **[Commands →](../COMMANDS-QUICK-REF.md)** — every command and terminal tool.
