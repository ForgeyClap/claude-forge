# Forge dashboard

Design-token thema: één palet, één typeschaal, één set surfaces — gedeeld door het Forge-dashboard,
de chat en de registry home view. Zero dependencies: plain JSON in, plain CSS uit. Zie [THEME.md](THEME.md)
voor de volledige spec.

## Forge

- **Eigenaar:** YOU. **Taal: Nederlands** — antwoord, rapporteer en stel vragen in het Nederlands.
- **Projecttype:** website / frontend UI.
- **Doel:** een **visueel-only frontend prototype** van de toekomstige Forge Workspace — hoe de
  complete Forge-applicatie eruitziet, aanvoelt en zich gedraagt, vóórdat er iets echt wordt
  aangesloten. React 19 + TypeScript + Vite in `src/`, volledig token-gedreven vanuit `brand/`.
- **Forge-status:** V2 2.0.0 geïnstalleerd, onboarding afgerond op 2026-07-24. Geen API-keys ingesteld
  (bewuste keuze — niet nodig voor dit project). Toevoegen kan met `/setup-forge keys`.

### Regels van dit project (uit THEME.md)

- `forge-tokens.css` is **gegenereerd**. Nooit met de hand bewerken — het wordt overschreven.
  Wijzig `tokens.json` en draai `node build-theme.cjs` opnieuw.
- **Nooit een hex-waarde in een view-stylesheet.** Het ruwe `palette`-blok bereikt bewust nooit de CSS.
  Bestaat de semantische naam nog niet, dan ontbreekt er een token — voeg die toe, hardcode niet.
- Kleur heeft twee assen: **status** = verzadigd signaal, **agent-groepen** = gedempt metaal
  (temperkleuren in echte hittevolgorde). Die twee mogen nooit met elkaar vechten.
- Type markeert herkomst: **mono** = wat het systeem registreerde (run-ids, event-types, agentnamen,
  poorten, tokentellingen), **sans** = wat een mens schreef. Gebruik `.fg-machine` voor het eerste.
- `node build-theme.cjs --check` geeft exit 1 als de CSS is afgedreven van de JSON. Draai dit vóór
  elke commit en beschouw een failure als blokkerend.
- Migratievolgorde: eerst het dashboard, daarna de chat. Nooit andersom.

### Wetten van het prototype (fase 1 — visueel only)

Deze gelden totdat de eigenaar expliciet zegt dat fase 2 begint:

- **Niets is aangesloten.** Geen backend, geen API, geen Anthropic API, geen Claude Code, geen VS
  Code, geen CLI, geen MCP, geen database, geen SSE/WebSocket, geen filesystem-toegang vanuit de
  browser. `fetch`, `WebSocket`, `EventSource` en `XMLHttpRequest` zijn **ESLint-fouten**, geen stijl.
- **Nooit een Anthropic API-key.** De toekomstige koppeling gebruikt de *lokaal geauthenticeerde
  Claude Code-sessie*. Er mag nergens een key-veld staan, ook niet als placeholder.
- **Elk voorbeeldrecord draagt `prototype: true`.** `assertPrototype` gooit als dat ontbreekt.
  Voorbeelddata blijft strikt buiten `.claude/` — nooit in echte registries, ledgers of event-logs.
- **Tokens zijn de enige bron van waarde.** Geen rauwe hex, `rgb()` of `hsl()` in component-CSS.
  Ontbreekt een semantische waarde, dan komt er een token bij in `brand/tokens.json`.
- **Status nooit alleen door kleur.** Altijd icoon + label, plus de `-style`/`-width` border-tokens.
  Het palet is monochroom; ember is gerantsoeneerd tot focus, de actieve control en running-progress.

### Omgeving op deze machine (geverifieerd 2026-07-24)

- **Node** is portable geïnstalleerd op `%LOCALAPPDATA%\Programs\nodejs` (v24.18.0 LTS) en toegevoegd
  aan de gebruikers-PATH. Werkt in **nieuw geopende** terminals; in een al draaiende sessie eerst:
  `$env:PATH = "$env:LOCALAPPDATA\Programs\nodejs;$env:PATH"`
- **git is niet geïnstalleerd** en deze map is geen repository. Gevolg: de `envNotTracked`-check van
  `forge-setup doctor` kan niets verifiëren en meldt PASS zonder bewijs. Niet lezen als "veilig bevonden".
- **PowerShell execution policy is Restricted.** `.ps1`-wrappers in `.claude/forge-bin/` starten met
  `powershell -ExecutionPolicy Bypass -File <script>`. De `.cmd`-wrappers werken gewoon.

### Werkafspraken

- Rapporteer eerlijk: wat er echt draaide, wat er wijzigde, wat is overgeslagen en wat faalde — met
  de echte reden. Nooit een stap als uitgevoerd melden die niet uitgevoerd is.
- Blijf binnen deze projectmap. Raak andere projecten of globale config niet aan.
