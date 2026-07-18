# Internationalization (i18n)

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
| **Dashboard UI** (Forge Control Center) | Auto-detected from the browser, with a visible toggle | `.claude/forge-dashboard/` (self-contained) |

The first three share one stored preference. The dashboard is intentionally independent — it
runs in a browser, so it auto-detects from the browser and lets each viewer flip the language
without touching any file.

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

## 2. The dashboard (Forge Control Center)

The dashboard has its own lightweight, **zero-dependency** i18n layer. No framework, no build
step, no network calls — just a plain strings table served with the rest of the dashboard.

### How it behaves

1. **Auto-detect** — on first load it reads `navigator.language` (e.g. `nl-NL` → `nl`). If that
   language isn't available yet, it falls back to English.
2. **Visible toggle** — a small language button sits in the top bar (next to *Copy URL*). It
   shows the current language code (e.g. `EN` / `NL`) and cycles to the next language on click.
3. **Remembered** — your choice is saved in `localStorage` under `forge_lang`, so it sticks
   across reloads for that browser. Clearing it returns to auto-detect.
4. **English fallback** — every label is looked up as *current language → English → the literal
   English in the code*. A missing key can never blank out or break a label.

Only **UI chrome** is translated (stat labels, panel headings, tabs, filters, buttons,
tooltips, status words). **Real data is never translated** — agent names, file paths, event
text, PRDs, tickets, and reports are shown exactly as produced.

### Files involved

| File | Role |
|---|---|
| `.claude/forge-dashboard/i18n.js` | The whole i18n layer: strings table, detection, `t()`, `apply()`, the toggle, and the public `window.ForgeI18n` / `window.i18nt` API. |
| `.claude/forge-dashboard/index.html` | Static labels carry `data-i18n`, `data-i18n-title`, `data-i18n-aria` attributes; includes `i18n.js` before the other scripts; hosts the `#lang-toggle` button. |
| `.claude/forge-dashboard/app.js`, `panels.js`, `graph.js` | Dynamically rendered labels (tabs, filters, dock, status chips, run-state) call `window.i18nt('<key>', '<English fallback>')`. |
| `.claude/forge-dashboard/server.cjs` | Serves `i18n.js` as a static asset (presentation only — no data logic changed). |

The data the dashboard reads (from `.claude/forge-runs/`) is untouched by i18n. The layer is
purely presentation.

---

## 3. Adding a new language (dashboard)

Adding a locale is a small, self-contained edit to **one file**: `i18n.js`.

1. **Copy the `en` block** inside `STRINGS` and rename it to your language code (the short
   prefix `navigator.language` reports, e.g. `de`, `fr`, `es`, `pt`):

   ```js
   const STRINGS = {
     en: { /* ... authoritative keys ... */ },
     nl: { /* ... */ },
     de: {
       'stat.events': 'Ereignisse',
       'stat.agents': 'Agenten',
       // ...translate every key from the en block...
     }
   };
   ```

2. **Translate every value.** Keep the **keys identical** to `en` — keys are the contract; only
   the text on the right changes. Any key you leave out simply falls back to English, so partial
   translations are safe to ship and improve later.

3. **Register the locale** so the toggle can reach it:

   ```js
   const AVAILABLE = ['en', 'nl', 'de'];
   const LOCALE_NAMES = { en: 'English', nl: 'Nederlands', de: 'Deutsch' };
   ```

That's it. Reload the dashboard — browsers set to that language auto-detect it, and the toggle
cycles through it. No build, no dependencies.

### Key parity check

`en` is the authoritative key set. To confirm another locale has no missing/extra keys, run
this from `.claude/forge-dashboard/` (zero-dependency, Node's built-in `vm`):

```bash
node -e '
const fs=require("fs"),vm=require("vm");
const el={addEventListener(){},setAttribute(){},getAttribute:()=>"",textContent:"",appendChild(){},querySelectorAll:()=>[]};
const ctx={localStorage:{getItem:()=>null,setItem(){}},navigator:{language:"en"},window:{},
  document:{readyState:"complete",documentElement:{setAttribute(){}},getElementById:()=>null,querySelectorAll:()=>[],createElement:()=>el,head:el,addEventListener(){}}};
vm.createContext(ctx); vm.runInContext(fs.readFileSync("i18n.js","utf8"),ctx);
const S=ctx.window.ForgeI18n.STRINGS, en=Object.keys(S.en);
for(const loc of Object.keys(S)){ if(loc==="en")continue;
  const miss=en.filter(k=>!(k in S[loc])), extra=Object.keys(S[loc]).filter(k=>!(k in S.en));
  console.log(loc, "missing:", miss.length?miss:"none", "| extra:", extra.length?extra:"none"); }
'
```

Missing keys are fine (they fall back to English) but the report tells you what's left to
translate; extra keys usually mean a typo.

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

- **Dashboard:** add a locale block to `i18n.js` as shown above and open a PR. Even a partial
  translation is useful (English fills the gaps).
- **Wizard / replies / reports:** open an issue describing the language you'd like; we'll point
  you at the right rule/wizard hooks.

Please keep translations honest and neutral — translate the label, don't add claims. If you're
unsure of a term, leave the English key out (it falls back cleanly) and note it in the PR.
