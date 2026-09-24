# Claude Code basics — for people who are new to all of this

*Nederlandse versie verderop: [Nederlands](#nederlands).*

Forge runs **inside Claude Code**. This page explains the few things about Claude Code itself that trip up
almost every beginner, in plain words. You do not need to be good with computers.

> [!IMPORTANT]
> **You never have to run anything yourself — Forge does it.** The only step Forge cannot do for you is
> installing Claude Code, because Forge lives inside it. After that, Forge runs every command, script,
> install and build itself.

**On this page:** [What you need](#1-what-you-need) · [Installing Claude Code](#2-installing-claude-code) ·
[Permission prompts](#3-permission-prompts-and-trusting-a-folder) · [Undo](#4-undo-and-going-back) ·
[Usage limits](#5-usage-limits) · [`/clear`](#6-clear-between-unrelated-tasks) ·
[CLAUDE.md](#7-claudemd-is-the-project-notebook) · [Myths](#8-three-myths) ·
[If this happens](#9-if-this-happens)

---

## English

### 1. What you need

- **A paid Claude plan** (Pro, Max, Team or Enterprise). The free plan does not include Claude Code, so it
  installs and then refuses to work.
- **Log in** inside Claude Code with **`/login`**. If it says "Not logged in" or "Login expired", type
  `/login` again.
- **Careful with API keys:** if an `ANTHROPIC_API_KEY` is set on your computer, Claude Code bills that API
  key instead of your plan.

### 2. Installing Claude Code

Open a terminal (the black window) and paste **the one line for your shell**. The most common beginner
mistake is using the line for a different shell.

| Your computer | Which window | Install line |
|---|---|---|
| Windows | **PowerShell** (the prompt starts with `PS C:\...>`) | `irm https://claude.ai/install.ps1 \| iex` |
| Windows | **Command Prompt / CMD** (the prompt is `C:\...>`) | `curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd` |
| macOS, Linux, WSL | **Terminal** (bash or zsh) | `curl -fsSL https://claude.ai/install.sh \| bash` |

Anthropic's official Claude Code setup page always has the current line; use that one if a line above fails.

After installing:

1. **Close the terminal and open a new one.** A terminal that was open during the install does not know
   about `claude` yet.
2. Type `claude`. If you see "claude is not recognized" or "command not found" in a new terminal, the install
   folder is not on your PATH (the list of places your computer looks for programs). Reinstall, or ask
   someone to add it.
3. **Windows: install Git for Windows** too. Claude Code works better with it, and Forge uses git for its
   safety points.
4. **Do not** use `sudo npm install -g` to install Claude Code. The installer above needs no npm and no admin
   rights.
5. **WSL users:** keep your project inside your Linux home folder, not under `/mnt/c/...`. Files there are
   slow and file watching is incomplete.

**Do I need Node.js?** Not for Claude Code itself. **Forge's own tools do need Node 18 or newer.** Forge's
health check (the doctor) tells you when Node is missing.

**Then install Forge:** open Claude Code in your project folder, paste this repository's link and say
**"install this"**. Your assistant follows [AI-INSTALL.md](../AI-INSTALL.md).

### 3. Permission prompts and trusting a folder

- **Claude asks before risky actions.** Read the prompt before you approve it; approving everything blindly
  is how surprises happen.
- **Shift+Tab** switches between modes. One of them is **plan mode**: Claude only makes a plan and changes
  nothing until you approve it. Depending on your plan and settings, Claude Code either asks before each risky
  step or decides the safe ones itself.
- **Never use bypass mode** (`--dangerously-skip-permissions`, or `bypassPermissions` as a default) on your
  real computer. Every command then runs without asking. Forge's doctor warns when it finds it.
- **The folder-trust prompt.** The first time you open a folder, Claude Code asks if you trust it. Saying yes
  also loads that folder's `.claude/settings.json`: its hooks (small programs that run automatically) and its
  permission rules. Opening Claude Code from your home folder shows this prompt again on purpose — work in a
  project folder instead.

**What Forge's `.claude/settings.json` switches on** (all local, nothing phones home):

| Hook | When it runs | What it does |
|---|---|---|
| Snapshot (PreCompact, manual and auto) | Before Claude summarises a long conversation | Saves the mission so Forge does not forget what it was doing. |
| Re-inject (SessionStart after a summary) | Right after that summary | Puts the saved mission back into the conversation. |
| Tool log (PostToolUse) | After Claude writes, edits or runs a command | Notes which file or command was touched, in `.claude/forge-runs/_toollog/` (not in git). |
| Gate hook (PreToolUse, Bash and PowerShell) | Before every shell command | Blocks three dangerous kinds of command until you say yes — see below. |

The **gate hook** stops recursive deletes (such as `rm -rf`), killing programs by name (such as
`taskkill /IM node.exe`) and git commands that throw away work you have not committed (such as
`git reset --hard` or `git checkout .`). Cleanups inside temporary folders (`_scratch`, `node_modules`,
`dist`, the system temp folder) still pass. Turn it off with `/forge config set gate-hook off`.

The same file also has **deny rules**: Claude cannot read `.env`, `.env.local`, the other common `.env.*`
secret files or anything in `secrets/`. `.env.example` stays readable, because it only holds placeholders.

### 4. Undo and going back

- **Esc** stops Claude right away. Stop early when you see it going the wrong way.
- **Esc Esc** (press Esc twice) or **`/rewind`** takes Claude's own **file edits** back to an earlier point.
  It does **not** undo shell commands (a deleted folder or an installed package stays that way).
- **Git is the real backup.** A git commit is a saved point you can always return to. Forge makes a **local
  safety commit** before a bigger build (the `git-checkpoint` setting). It is never pushed anywhere.
- To pick up an earlier conversation: `claude --continue` (the last one) or `claude --resume` (choose one).

### 5. Usage limits

- **`/usage`** shows how much of your plan you have used.
- You have **two limits**: a **5-hour window** and a **weekly limit**. They are **shared** with the Claude
  app, claude.ai and the desktop app — chatting there uses the same allowance.
- **When you hit a limit, recent Claude Code versions (2.1.234 and later) wait and continue by themselves
  after the reset.** You do not lose your work.
- **Forge's usage guard** adds one thing on top: it pauses Forge at **98 %**, *before* the limit, so a task is
  never cut off halfway. It is on by default; change it with `/forge config set usage-guard.pause-at 95` or
  switch it off with `/forge config set usage-guard off`. What it reads and sends: [SETTINGS.md](SETTINGS.md#what-the-usage-guard-does-with-your-data).
- **Extra usage credits cost money.** Forge never turns them on for you — spending money is a hard gate.
- The strongest model (Opus) uses your allowance faster. For routine work, Sonnet is enough (`/model sonnet`).
  On a Pro plan, Forge's run report adds a one-line model tip; it cannot switch the model for you.

### 6. `/clear` between unrelated tasks

The conversation fills up as you work. When it is very full, answers get worse and every message costs more.
**Type `/clear` before you start a task that has nothing to do with the previous one.** Forge ends every
finished run with a one-line reminder (in Dutch: `Volgende taak ongerelateerd? Typ eerst /clear.`). Forge's
memory files keep what matters about your project, so clearing loses nothing important.

### 7. CLAUDE.md is the project notebook

- Claude starts **blank** in every new session. **`CLAUDE.md`** in your project folder is the notebook it
  reads first. Forge creates it if it is missing and only ever adds its own section.
- **Keep it short** — under about 200 lines. In long files, rules get ignored. Forge's doctor warns above 200.
  The `/revise-claude-md` command (ships with Forge) adds what a session learned, and the `claude-md-improver`
  skill helps check and trim it.
- **Written rules are advice, not locks.** "Never delete X" in CLAUDE.md can still be ignored. Hard rules need
  settings (hooks or deny rules) — which is exactly why Forge ships the gate hook and the `.env` deny rules.

### 8. Three myths

- **"Put secrets in `.claudeignore`."** `.claudeignore` is not a documented Claude Code feature. Deny rules
  such as `Read(./.env)` in `.claude/settings.json` are — Forge already ships them.
- **"You must install Node first."** Not for Claude Code itself. Only Forge's own tools need Node 18+.
- **"The weekly limit resets on Monday."** There is no fixed Monday reset. `/usage` shows your own reset time.

### 9. If this happens

| You see | What it means | What to do |
|---|---|---|
| "It forgets my project every session" | Claude starts blank each time. | Keep a short CLAUDE.md; Forge's memory files do the rest. |
| "You've hit your limit" | Your 5-hour or weekly allowance is used up. | Wait: Claude Code continues after the reset by itself. |
| "It got dumb halfway through" | The conversation is full. | Type `/clear` and start the next task fresh. |
| "It built the wrong thing" | The request was open to more than one reading. | Say what "done" looks like; see [HOW-TO-ASK.md](HOW-TO-ASK.md). |
| "'claude' is not recognized" | The terminal was open during the install, or PATH is missing the folder. | Close and reopen the terminal. |
| "It keeps asking permission" | The prompts protect you. | Read them; allow safe commands permanently when asked. |
| "My corrections make it worse" | Too many fixes pile up in one conversation. | After two failed tries, `/clear` and ask again more clearly. |
| "How do I undo this?" | — | Esc Esc for Claude's edits; git for everything else. |
| "It deleted my files" | A broad "clean up" in a broad folder. | Work in a project folder; Forge's gate hook blocks mass deletes. |
| "irm is not recognized" / "&& is not valid" | You used the install line for a different shell. | Use the line for your window (table in section 2). |

`claude doctor` in the terminal (or `/doctor` inside Claude Code) checks your Claude Code installation. Forge's
own doctor shows a short, read-only summary of it.

---

## Nederlands

Forge draait **binnen Claude Code**. Hier staat, in gewone woorden, wat bijna elke beginner over Claude Code
zelf moet weten. Je hoeft niet goed met computers te zijn.

> [!IMPORTANT]
> **Jij hoeft nooit zelf iets uit te voeren — Forge doet het.** Het enige wat Forge niet voor je kan doen, is
> Claude Code installeren, want Forge woont daarin. Daarna draait Forge elk commando, script, installatie en
> build zelf.

### 1. Wat je nodig hebt

- **Een betaald Claude-abonnement** (Pro, Max, Team of Enterprise). Het gratis plan heeft geen Claude Code:
  het installeert wel, maar werkt dan niet.
- **Log in** binnen Claude Code met **`/login`**. Staat er "Not logged in" of "Login expired", typ dan
  opnieuw `/login`.
- **Let op met API-sleutels:** staat er een `ANTHROPIC_API_KEY` op je computer, dan rekent Claude Code die
  sleutel af in plaats van je abonnement.

### 2. Claude Code installeren

Open een terminal (het zwarte venster) en plak **de ene regel voor jouw venster**. De bekendste beginnersfout
is de regel van een ander venster gebruiken.

| Jouw computer | Welk venster | Installatieregel |
|---|---|---|
| Windows | **PowerShell** (de regel begint met `PS C:\...>`) | `irm https://claude.ai/install.ps1 \| iex` |
| Windows | **Opdrachtprompt / CMD** (de regel is `C:\...>`) | `curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd` |
| macOS, Linux, WSL | **Terminal** (bash of zsh) | `curl -fsSL https://claude.ai/install.sh \| bash` |

De officiële setup-pagina van Anthropic voor Claude Code heeft altijd de actuele regel; gebruik die als een
regel hierboven niet werkt.

Na het installeren:

1. **Sluit de terminal en open een nieuwe.** Een terminal die openstond tijdens de installatie kent `claude`
   nog niet.
2. Typ `claude`. Zie je in een nieuwe terminal "claude is not recognized" of "command not found", dan staat de
   installatiemap niet in je PATH (de lijst plekken waar je computer programma's zoekt). Installeer opnieuw,
   of vraag iemand om hem toe te voegen.
3. **Windows: installeer ook Git for Windows.** Claude Code werkt er beter mee, en Forge gebruikt git voor
   zijn veiligheidspunten.
4. **Gebruik niet** `sudo npm install -g` om Claude Code te installeren. De regel hierboven heeft geen npm en
   geen beheerdersrechten nodig.
5. **WSL:** zet je project in je Linux-thuismap, niet onder `/mnt/c/...`. Daar zijn bestanden traag en werkt
   het volgen van wijzigingen niet goed.

**Heb ik Node.js nodig?** Niet voor Claude Code zelf. **De tools van Forge wel: Node 18 of nieuwer.** De
gezondheidscheck van Forge (de doctor) meldt het als Node ontbreekt.

**Daarna Forge installeren:** open Claude Code in je projectmap, plak de link van deze repository en zeg
**"installeer dit"**. Je assistent volgt [AI-INSTALL.md](../AI-INSTALL.md).

### 3. Toestemmingsvragen en een map vertrouwen

- **Claude vraagt vóór riskante acties.** Lees de vraag vóór je hem goedkeurt; alles blind goedkeuren geeft
  verrassingen.
- **Shift+Tab** wisselt tussen standen. Eén daarvan is de **planstand**: Claude maakt alleen een plan en
  verandert niets tot jij het goedkeurt. Afhankelijk van je abonnement en instellingen vraagt Claude Code bij
  elke riskante stap, of beslist het de veilige zelf.
- **Gebruik nooit de bypass-stand** (`--dangerously-skip-permissions`, of `bypassPermissions` als standaard)
  op je echte computer. Dan draait elk commando zonder te vragen. De doctor van Forge waarschuwt als hij die
  vindt.
- **De vraag "vertrouw je deze map?"** De eerste keer dat je een map opent, vraagt Claude Code of je hem
  vertrouwt. Ja zeggen laadt ook de `.claude/settings.json` van die map: de hooks (kleine programma's die
  vanzelf draaien) en de toestemmingsregels. Vanuit je thuismap komt die vraag bewust steeds terug — werk
  liever in een projectmap.

**Wat de `.claude/settings.json` van Forge aanzet** (alles lokaal, niets belt naar buiten): een
**snapshot**-hook (bewaart de missie voordat een lang gesprek wordt samengevat), een **terugzet**-hook (zet de
missie daarna terug), een **wijzigingslog** (noteert welk bestand of commando is aangeraakt, in
`.claude/forge-runs/_toollog/`, niet in git) en de **poort-hook**. Die poort-hook houdt drie gevaarlijke soorten
commando's tegen tot jij ja zegt: alles recursief verwijderen (zoals `rm -rf`), programma's op naam stoppen
(zoals `taskkill /IM node.exe`) en git-commando's die niet-vastgelegd werk weggooien (zoals `git reset --hard`
of `git checkout .`). Opruimen in tijdelijke mappen (`_scratch`, `node_modules`, `dist`, de tijdelijke map van
het systeem) mag gewoon. Uitzetten: `/forge config set gate-hook uit`.

Hetzelfde bestand heeft ook **weigerregels**: Claude kan `.env`, `.env.local`, de andere gangbare `.env.*`-
geheimbestanden en alles in `secrets/` niet lezen. `.env.example` blijft leesbaar, want daar staan alleen
voorbeeldwaarden in.

### 4. Ongedaan maken en teruggaan

- **Esc** stopt Claude meteen. Stop vroeg als je ziet dat het de verkeerde kant op gaat.
- **Esc Esc** (twee keer Esc) of **`/rewind`** zet Claudes eigen **bestandswijzigingen** terug naar een eerder
  punt. Het maakt shell-commando's **niet** ongedaan (een verwijderde map of een geïnstalleerd pakket blijft
  zo).
- **Git is de echte back-up.** Een git-commit is een opgeslagen punt waar je altijd naar terug kunt. Forge
  maakt vóór een grotere bouwklus een **lokale veiligheidscommit** (de instelling `git-checkpoint`). Die wordt
  nooit ergens heen gepusht.
- Een eerder gesprek oppakken: `claude --continue` (het laatste) of `claude --resume` (zelf kiezen).

### 5. Gebruikslimieten

- **`/usage`** laat zien hoeveel van je abonnement je hebt gebruikt.
- Je hebt **twee limieten**: een **venster van 5 uur** en een **weeklimiet**. Die deel je met de Claude-app,
  claude.ai en de desktop-app — chatten daar gaat van hetzelfde tegoed af.
- **Raak je een limiet, dan wachten recente versies van Claude Code (2.1.234 en nieuwer) en gaan ze na de
  reset vanzelf verder.** Je werk gaat niet verloren.
- **De usage guard van Forge** doet er één ding bij: hij pauzeert Forge op **98 %**, *vóór* de limiet, zodat
  een taak nooit halverwege wordt afgekapt. Hij staat standaard aan; wijzig hem met
  `/forge config set usage-guard.pause-at 95` of zet hem uit met `/forge config set usage-guard uit`. Wat hij
  leest en verstuurt: [SETTINGS.md](SETTINGS.md#what-the-usage-guard-does-with-your-data).
- **Extra gebruikstegoed kost geld.** Forge zet dat nooit voor je aan — geld uitgeven is een harde poort.
- Het sterkste model (Opus) gaat sneller door je tegoed heen. Voor gewoon werk volstaat Sonnet
  (`/model sonnet`). Op een Pro-abonnement zet Forge een modeltip van één regel in het runrapport; het kan het
  model niet voor je wisselen.

### 6. `/clear` tussen taken die niets met elkaar te maken hebben

Het gesprek loopt vol terwijl je werkt. Als het heel vol is, worden de antwoorden slechter en kost elk bericht
meer. **Typ `/clear` voordat je aan een taak begint die niets met de vorige te maken heeft.** Forge eindigt elke
afgeronde run met één herinnering: `Volgende taak ongerelateerd? Typ eerst /clear.` De geheugenbestanden van
Forge bewaren wat belangrijk is over je project, dus je verliest niets belangrijks.

### 7. CLAUDE.md is het notitieboek van je project

- Claude begint in elk nieuw gesprek **blanco**. **`CLAUDE.md`** in je projectmap is het notitieboek dat het
  als eerste leest. Forge maakt het aan als het ontbreekt en voegt alleen een eigen stukje toe.
- **Houd het kort** — onder de ongeveer 200 regels. In lange bestanden worden regels genegeerd. De doctor van
  Forge waarschuwt boven de 200. Het commando `/revise-claude-md` (zit bij Forge) voegt toe wat een sessie
  heeft geleerd, en de skill `claude-md-improver` helpt het na te kijken en in te korten.
- **Geschreven regels zijn advies, geen slot.** "Verwijder nooit X" in CLAUDE.md kan nog steeds genegeerd
  worden. Harde regels vragen instellingen (hooks of weigerregels) — precies daarom levert Forge de poort-hook
  en de `.env`-weigerregels mee.

### 8. Drie fabels

- **"Zet geheimen in `.claudeignore`."** `.claudeignore` is geen gedocumenteerde functie van Claude Code.
  Weigerregels zoals `Read(./.env)` in `.claude/settings.json` wel — Forge levert ze al mee.
- **"Je moet eerst Node installeren."** Niet voor Claude Code zelf. Alleen de tools van Forge hebben Node 18+
  nodig.
- **"De weeklimiet reset op maandag."** Er is geen vaste reset op maandag. `/usage` toont jouw eigen
  resetmoment.

### 9. Als dit gebeurt

| Je ziet | Wat het betekent | Wat je doet |
|---|---|---|
| "Het vergeet mijn project elke keer" | Claude begint elke keer blanco. | Houd CLAUDE.md kort; de geheugenbestanden van Forge doen de rest. |
| "You've hit your limit" | Je 5-uurs- of weektegoed is op. | Wacht: Claude Code gaat na de reset vanzelf verder. |
| "Het werd halverwege dom" | Het gesprek zit vol. | Typ `/clear` en begin de volgende taak schoon. |
| "Het bouwde het verkeerde" | De opdracht kon op meer manieren gelezen worden. | Zeg hoe "klaar" eruitziet; zie [HOW-TO-ASK.md](HOW-TO-ASK.md). |
| "'claude' is not recognized" | De terminal stond open tijdens de installatie, of de map mist in PATH. | Sluit de terminal en open een nieuwe. |
| "Het vraagt steeds toestemming" | Die vragen beschermen je. | Lees ze; sta veilige commando's vast toe als dat gevraagd wordt. |
| "Mijn correcties maken het erger" | Te veel reparaties in één gesprek. | Na twee mislukte pogingen: `/clear` en vraag het duidelijker opnieuw. |
| "Hoe maak ik dit ongedaan?" | — | Esc Esc voor Claudes wijzigingen; git voor de rest. |
| "Het heeft mijn bestanden verwijderd" | Een brede "ruim op" in een brede map. | Werk in een projectmap; de poort-hook van Forge houdt massaal verwijderen tegen. |
| "irm is not recognized" / "&& is not valid" | Je gebruikte de regel van een ander venster. | Gebruik de regel voor jouw venster (tabel in stap 2). |

`claude doctor` in de terminal (of `/doctor` binnen Claude Code) controleert je Claude Code-installatie. De
eigen doctor van Forge toont daar een korte samenvatting van (alleen lezen).

---

<sub>Based on Forge's internal beginner research of 2026-09-24 (a read-only review of 75 public sources:
Anthropic documentation and changelog, practitioner articles, community threads and GitHub issues; the
"must-knows", "setup traps" and "top stuck points" sections). Claude Code changes often; when this page and
Anthropic's official documentation disagree, the official documentation wins. Back to the
[README](../README.md) · [Settings](SETTINGS.md) · [How to ask](HOW-TO-ASK.md).</sub>
