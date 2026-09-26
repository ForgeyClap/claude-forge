# Internationalization (i18n)

> **Status (v2.8.0, following a fresh-laptop audit):** an earlier version of this page confidently described a
> dashboard-chrome translation layer (`i18n.js`, `data-i18n`, `#lang-toggle`) that was never actually built — 0
> matches anywhere in the dashboard code. §2 below now states plainly what's real today (dashboard chrome is
> English-only); §3 is a design sketch for a future contribution, not a feature that exists.

Forge is built to be used in any language. **English is the default and the guaranteed
fallback** everywhere — nothing breaks if a translation is missing; the English text is
always shown instead.

This page covers where language is set, how each part of Forge honors it, and how to add a
new language (contributions welcome).

---

## The four surfaces

| Surface | What language it uses | Where it's controlled |
|---|---|---|
| **Onboarding wizard** (`/setup-forge`) | The language you pick during onboarding | The wizard's language question |
| **`/forge` replies** | Your stored preference | Preference marker (below) |
| **Reports** (`final-report.md`, memory notes) | Your stored preference | Preference marker (below) |
| **Dashboard UI chrome** (Forge Command Center) | English only — no translation layer exists yet | n/a |

The first three share one stored preference. The dashboard's own UI chrome is a separate case —
see section 2 for its honest current status.

---

## 1. Setting your language (wizard + replies + reports)

During first-run onboarding, `/setup-forge` asks a simple question:

```
Main language?  [1] English  [2] Nederlands
```

Your answer is stored as a preference, **not** in an environment variable:

- **Global**, once per machine: `~/.claude/.forge-global.json`
  → `{ version, completedAt, name, defaultLanguage }`
- Per-project Forge preferences/session state carry the same choice forward.

Headless / CI escape hatch (interactive is the default; flags override):

```
/setup-forge --name X --goal "..." --type website --lang en --quick
```

After that, Forge **responds to you, writes reports, and runs the wizard in your language**.
When no preference is set, Forge uses **English**.

> Honesty note: a language preference changes the *language of the text Forge writes*. It never
> changes what Forge reports as done — the honest agent ledger, checks, and proofs are the same
> in every language.

---

## 2. The dashboard (Forge Command Center) — English-only today

**Honest status: the dashboard UI itself has no translation layer yet.** Its chrome (stat
labels, panel headings, tabs, filters, buttons, tooltips, status words) is English-only, hardcoded
in the source — there is no auto-detect, no visible language toggle, and no strings table shipped
today. Do not tell a user it will show their language; it won't.

What *is* already true, and covered in section 1: the **content** the dashboard displays — agent
names, file paths, event text, PRDs, tickets, and reports — is shown exactly as Forge produced it,
so if you set your preference to Dutch, the reports it renders will already be in Dutch. Only the
surrounding UI chrome (button labels, column headers) stays in English.

Translating the dashboard chrome itself is a welcome future contribution (see below) — it does not
exist yet, so there is nothing to configure or toggle.

---

## 3. Adding dashboard-chrome translation (open contribution, not yet built)

If you want to add this, a reasonable, zero-dependency starting point:

1. Add one small strings module the dashboard's server serves as a static asset, with an `en` block
   as the authoritative key set for every visible chrome label.
2. Look up each label through a helper with an explicit English fallback, so a missing key can
   never blank out or break a label — never translate real run data, only chrome.
3. Add a visible toggle (or `navigator.language` auto-detect) and persist the choice for that
   browser.

Open an issue or a draft PR first if you want to build this — it touches several dashboard source
files and is worth agreeing on the approach before writing the translations themselves.

---

## 4. Adding a language for wizard/replies/reports

Those surfaces are driven by the Forge behavioral rules and the onboarding wizard rather than a
strings table, so extending them means:

- adding the option to the wizard's language question (`/setup-forge`),
- allowing that language code in the stored preference (`defaultLanguage`),
- and letting `/forge` write its replies/reports in that language.

English remains the default and fallback for these surfaces too.

---

## Contributing translations

Translations are very welcome — they're one of the easiest first contributions.

- **Dashboard chrome:** not built yet — open an issue or draft PR first (see section 3) to agree
  on the approach before writing translations.
- **Wizard / replies / reports:** open an issue describing the language you'd like; we'll point
  you at the right rule/wizard hooks.

Please keep translations honest and neutral — translate the label, don't add claims. If you're
unsure of a term, leave the English key out (it falls back cleanly) and note it in the PR.
