# Vendored skills — wat Forge meelevert en wat bewust niet

Forge's eigen skills (`forge-brainstorm`, `forge-debug`, `forge-code-review`, `forge-fullstack`,
`forge-migration`, `forge-website`, …) verwijzen naar algemene werkwijze-skills zoals `brainstorming`,
`systematic-debugging` en `test-driven-development`. Zodat die verwijzingen ook in een verse installatie
werken, levert Forge een kleine, gecontroleerde set **derdepartij-skills** (en twee commands) mee. Elke
meegeleverde skill:

- staat op een **vastgelegde upstream-commit** (geen "latest"), in `.claude/skills/<naam>/`;
- heeft zijn **eigen licentiebestand** naast de `SKILL.md` (`LICENSE` voor MIT, `LICENSE.txt` voor Apache-2.0);
- draagt bovenin de `SKILL.md` een herkomstblok met `Source:`, `Pinned commit:`, `License:` en
  `Forge vendor note:` — die eerste twee regels zijn wat `forge-doctor.cjs` (`detectVendorPin`) als bewijs
  van vendoring herkent;
- is vóór het kopiëren gecontroleerd: elk upstream-bestand uit het pinned-commit-manifest is op sha256
  geverifieerd (ronde 1: 50 van 50 overeenkomend; ronde 2: 31 van 31, 0 afwijkend) en gescand op
  verborgen/zero-width unicode en prompt-injectiepatronen (schoon).

Wijzigingen ten opzichte van upstream zijn beperkt tot wat de licenties toestaan en wat nodig is om in een
Forge-installatie te werken; elke wijziging staat in de `Forge vendor note` van de skill zelf en hieronder.

## Meegeleverd — ronde 1 (14 skills, wp6)

Bron superpowers: https://github.com/obra/superpowers @ `5bf4e78011075bcfc0dc295f0724994cd123ee71`
(2026-09-19), MIT, (c) 2025 Jesse Vincent. Bron frontend-design: https://github.com/anthropics/skills @
`34040c9c568585f6929bedeaad110ad08f079624` (2026-09-10), Apache-2.0.

Wijziging **H** (alle 14): herkomstblok toegevoegd; bij de 13 superpowers-skills ook de frontmatter-sleutel
`license: MIT`. Wijziging **N**: plugin-namespaced verwijzingen (`superpowers:` + skillnaam) herschreven naar de
kale skillnaam, zodat `Skill(<naam>)` in een Forge-installatie resolvet — het getal is het aantal herschreven
verwijzingen in die skill-map.

| skill | bron | pinned commit | licentie | wijzigingen | scripts meegeleverd / uitgesloten |
|---|---|---|---|---|---|
| `brainstorming` | obra/superpowers | `5bf4e78` | MIT | H · stap 2 (Architectural) en de sectie "Visual Companion" herschreven: de browser-companion wordt niet meegeleverd | **uitgesloten:** `scripts/server.cjs`, `scripts/start-server.sh`, `scripts/stop-server.sh`, `scripts/helper.js`, `scripts/frame-template.html` en de gids `visual-companion.md` — zie "Scriptbesluiten" |
| `dispatching-parallel-agents` | obra/superpowers | `5bf4e78` | MIT | H | geen scripts upstream |
| `executing-plans` | obra/superpowers | `5bf4e78` | MIT | H · N=14 · verwijzing naar de niet-meegeleverde `using-superpowers`-referenties vervangen door een verwijzing naar `forge-router` | **meegeleverd:** `scripts/task-start`, `scripts/task-done` |
| `finishing-a-development-branch` | obra/superpowers | `5bf4e78` | MIT | H | geen scripts upstream |
| `receiving-code-review` | obra/superpowers | `5bf4e78` | MIT | H | geen scripts upstream |
| `requesting-code-review` | obra/superpowers | `5bf4e78` | MIT | H | geen scripts upstream |
| `subagent-driven-development` | obra/superpowers | `5bf4e78` | MIT | H · N=6 | **meegeleverd:** `scripts/review-package`, `scripts/sdd-workspace`, `scripts/task-brief` |
| `systematic-debugging` | obra/superpowers | `5bf4e78` | MIT | H · N=2 | **meegeleverd:** `find-polluter.sh`, `condition-based-waiting-example.ts` (voorbeeldcode, niet uitvoerbaar op zichzelf) |
| `test-driven-development` | obra/superpowers | `5bf4e78` | MIT | H · N=1 (in `writing-good-tests.md`) | geen scripts upstream |
| `using-git-worktrees` | obra/superpowers | `5bf4e78` | MIT | H | geen scripts upstream |
| `verification-before-completion` | obra/superpowers | `5bf4e78` | MIT | H | geen scripts upstream |
| `writing-plans` | obra/superpowers | `5bf4e78` | MIT | H · N=5 | geen scripts upstream |
| `writing-skills` | obra/superpowers | `5bf4e78` | MIT | H · N=5 · twee links naar de niet-meegeleverde `using-superpowers`-referenties geschrapt · één voorbeeldpad geschreven als `./scripts/tool.sh` (was zonder `./`) zodat de skill-hygiëne-check het voorbeeld niet als ontbrekend bestand leest | **meegeleverd:** `render-graphs.js`, `graphviz-conventions.dot` (data) |
| `frontend-design` | anthropics/skills | `34040c9` | Apache-2.0 | H (dit is tevens de wijzigingsvermelding die Apache-2.0 §4(b) vraagt); frontmatter en tekst verder ongewijzigd; `LICENSE.txt` ongewijzigd meegeleverd; de gepinde upstream-map bevat geen apart NOTICE-bestand | geen scripts upstream |

Alle overige upstream-bestanden in deze mappen (prompts, referentie-`.md`'s, voorbeelden) zijn ongewijzigd
op de namespace-herschrijving N na.

### Scriptbesluiten

Een hulpscript gaat alleen mee als het (a) geen netwerk-listener/socket opent en geen uitgaand verzoek doet,
(b) niets buiten zijn eigen werkbestanden verwijdert, (c) geen `curl|bash`/`wget|sh`/eval-van-remote bevat en
(d) onder ~300 regels blijft. Elk script is volledig gelezen; het HTML-sjabloon `frame-template.html` is
doorzocht op script-, link- en netwerkverwijzingen (alleen CSS en twee placeholder-commentaren).

| script | besluit | reden |
|---|---|---|
| `brainstorming/scripts/server.cjs` | uitgesloten | 723 regels; start een HTTP/WebSocket-server (`http.createServer` + `listen`), laadt een remote brand-afbeelding (telemetrie-achtig), kan via `BRAINSTORM_OPEN_CMD` een willekeurig commando uitvoeren — faalt (a) en (d) |
| `brainstorming/scripts/start-server.sh` | uitgesloten | start die server (nohup/achtergrond), doodt een oude PID uit een pid-bestand — faalt (a) |
| `brainstorming/scripts/stop-server.sh` | uitgesloten | hoort alleen bij die server; `rm -rf` van de sessiemap onder `/tmp` |
| `brainstorming/scripts/helper.js` | uitgesloten | browser-script dat alleen door `server.cjs` wordt geïnjecteerd; opent een WebSocket |
| `brainstorming/scripts/frame-template.html` | uitgesloten | HTML-sjabloon dat alleen `server.cjs` gebruikt |
| `brainstorming/visual-companion.md` | uitgesloten | handleiding voor die server; zonder server een dode verwijzing |
| `executing-plans/scripts/task-start` | meegeleverd | 28 regels bash; roept `task-brief` aan en print `git rev-parse HEAD`; geen netwerk, geen verwijderingen |
| `executing-plans/scripts/task-done` | meegeleverd | 52 regels; draait het testcommando dat de agent zelf opgeeft, schrijft log + ledger in de eigen werkmap; geen netwerk, geen verwijderingen |
| `subagent-driven-development/scripts/sdd-workspace` | meegeleverd | 82 regels; maakt alleen de eigen werkmap `.superpowers/sdd/<plan>/` + een zelf-negerende `.gitignore`; geen verwijderingen |
| `subagent-driven-development/scripts/task-brief` | meegeleverd | 43 regels; `awk`-extractie van één taak uit het plan naar de werkmap |
| `subagent-driven-development/scripts/review-package` | meegeleverd | 53 regels; `git log`/`git diff` naar een bestand in de werkmap |
| `systematic-debugging/find-polluter.sh` | meegeleverd | 72 regels; draait per testbestand lokaal `npm test` en controleert of een pad verschijnt; niets verwijderd |
| `writing-skills/render-graphs.js` | meegeleverd | 169 regels; roept de lokale graphviz `dot` aan via `execFileSync` (geen shell) en schrijft SVG's naar `diagrams/` in de opgegeven skill-map; ESM-syntax, dus draai het met een Node-versie die ESM in `.js` herkent |

De extensieloze bash-scripts worden in de skill-tekst via `bash <pad>` aangeroepen. Git op Windows bewaart
geen uitvoerbit; wie ze direct wil uitvoeren gebruikt dus `bash`.

## Meegeleverd — ronde 2 (7 skills + 2 commands, wp6b)

Beginnersskills uit het onderzoek `.claude/forge-research/beginner-sweep-2026-09-24/web-track-b.md` (sectie A, T10).
Bron mattpocock: https://github.com/mattpocock/skills @ `c55ee46073ed923f86ce59a5eb3b6d895095d1b7`
(2026-09-18), MIT, (c) 2026 Matt Pocock. Bron claude-plugins-official:
https://github.com/anthropics/claude-plugins-official @ `6bfd4e0c6d3da6050984fa5ed8281d915fa7ed69` (2026-09-23),
Apache-2.0; de gepinde plugin-mappen en de repo-root bevatten geen NOTICE-bestand.

Controle vóór het kopiëren: 31 van 31 manifestbestanden op sha256 overeenkomend (0 afwijkend, 0 niet in het
manifest); alle 29 tekstbestanden gescand: 0 verborgen/zero-width/bidi/control-tekens, 0 prompt-injectiepatronen.
Elke regel met netwerkgebruik of verwijderen is gelezen: het zijn verboden (resolving-merge-conflicts verbiedt
`--abort`, teach schrijft "rather than deleting"), voorbeeldinhoud, de licentie-URL's, of beschrijvingen van de
hieronder niet meegeleverde commands. De enige niet-ASCII-tekens zijn zichtbare leestekens en emoji (❓, ➡️ met
zijn standaard variation selector U+FE0F, een en-dash, een beletselteken). Geen van deze skills bevat hulpscripts.

Wijziging **H** (alle 9): herkomstblok toegevoegd (bij Apache-2.0 tevens de wijzigingsvermelding van §4(b)); bij de
7 skills ook de frontmatter-sleutel `license:`. Wijziging **O** (de 6 mattpocock-skills): `agents/openai.yaml`
niet meegeleverd — Codex-UI-metadata die in Claude Code niets doet. Namespace-herschrijvingen: 0 — upstream
verwees al met kale skillnamen en gebruikte geen plugin-relatieve paden.

| naam | soort | bron | pinned commit | licentie | wijzigingen | uitgesloten bestanden |
|---|---|---|---|---|---|---|
| `grill-me` | skill | mattpocock/skills | `c55ee46` | MIT | H · O · roept `grilling` aan met de kale naam (upstream al zo); beide meegeleverd; upstream staat al op `disable-model-invocation: true` | `agents/openai.yaml` |
| `grilling` | skill | mattpocock/skills | `c55ee46` | MIT | H · O | `agents/openai.yaml` |
| `teach` | skill | mattpocock/skills | `c55ee46` | MIT | H · O · de leer-werkmap is `docs/lessons/` van het gebruikersproject in plaats van de huidige map, en lessen komen direct in `docs/lessons/` (drie zinnen aangepast) zodat lessen, `MISSION.md`, `NOTES.md` enz. nooit in de projectroot belanden; de vier `*-FORMAT.md`-bestanden ongewijzigd | `agents/openai.yaml` |
| `wait-what` | skill | mattpocock/skills | `c55ee46` | MIT | H · O | `agents/openai.yaml` |
| `resolving-merge-conflicts` | skill | mattpocock/skills | `c55ee46` | MIT | H · O · veiligheidscheck: geen destructieve git — verbiedt `--abort` en eindigt met een gewone lokale commit of `rebase --continue`; geen push, reset, clean of branch-verwijdering | `agents/openai.yaml` |
| `setup-pre-commit` | skill | mattpocock/skills | `c55ee46` | MIT | H · O · frontmatter `disable-model-invocation: true` toegevoegd (upstream miste hem): de skill draait `npm install`/`npx` en commit, dus alleen de gebruiker roept hem aan | `agents/openai.yaml` |
| `claude-md-improver` | skill | anthropics/claude-plugins-official | `6bfd4e0` | Apache-2.0 | H · de drie `references/`-bestanden ongewijzigd · `LICENSE.txt` is de ongewijzigde LICENSE uit de plugin-root | `README.md` (plugin-installatie, embedt de screenshots), `claude-md-improver-example.png`, `revise-claude-md-example.png`, `.claude-plugin/plugin.json` |
| `/commit` (`.claude/commands/commit.md`) | command | anthropics/claude-plugins-official | `6bfd4e0` | Apache-2.0 | H (HTML-commentaar direct na de frontmatter); frontmatter en tekst verder ongewijzigd, inclusief de read-only inline git-contextregels (een gedocumenteerde slash-command-functie) | uit `commit-commands` alleen `commit.md`: **niet** `commit-push-pr.md` (pusht en opent PR's) en **niet** `clean_gone.md` (verwijdert branches en worktrees), allebei Scout hard-pass; ook niet de `README.md` die die twee beschrijft, noch `.claude-plugin/plugin.json` |
| `/revise-claude-md` (`.claude/commands/revise-claude-md.md`) | command | anthropics/claude-plugins-official | `6bfd4e0` | Apache-2.0 | H; verder ongewijzigd. Upstream roept `claude-md-improver` niet aan en gebruikt geen plugin-relatief pad, dus er viel niets te herschrijven; de audit-tegenhanger is de skill `claude-md-improver` | — (plugin-README: zie `claude-md-improver`) |

**Licentie van de twee commands.** `.claude/commands/` bevat alleen commanddefinities, dus de Apache-2.0-tekst
voor beide commands staat één keer in `.claude/skills/claude-md-improver/LICENSE.txt`. Die is byte-identiek aan
de LICENSE van beide plugins (sha256 `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`). Lever de
commands dus nooit mee zonder die skill-map.

**Goed om te weten bij gebruik** (upstream-tekst bewust ongewijzigd):

- `wait-what` noemt `CONTEXT.md` en `CONTEXT-MAP.md`, een conventie uit andere mattpocock-skills. Een project
  zonder die bestanden krijgt gewoon de eenvoudige herformulering.
- `revise-claude-md` en `claude-md-improver` noemen `.claude.local.md` als persoonlijk, niet-gedeeld bestand.
  Claude Code documenteert die naam zelf als `CLAUDE.local.md`.
- `/commit` maakt zonder tussenvraag één commit van de wijzigingen die het ziet. Controleer vooraf `git status`
  als er bestanden openstaan die niet in die commit horen.

## Bewust NIET meegeleverd

De skills hieronder zijn derdepartij-inhoud die dit project intern gebruikt op een vastgelegde commit, of die
bewust buiten Forge blijft. Ze worden niet mee-gedistribueerd; haal ze zelf op bij de bron als je ze wilt, dan
houd je hun licentie en herkomst intact.

| skill | bron | pinned commit | reden |
|---|---|---|---|
| `gsap/gsap-core` | https://github.com/greensock/gsap-skills | `aed9cfd3277740755f6bfc1155c7aa645403b760` | geen open licentie — alleen intern gebruikt |
| `gsap/gsap-frameworks` | https://github.com/greensock/gsap-skills | `aed9cfd3277740755f6bfc1155c7aa645403b760` | idem |
| `gsap/gsap-performance` | https://github.com/greensock/gsap-skills | `aed9cfd3277740755f6bfc1155c7aa645403b760` | idem |
| `gsap/gsap-plugins` | https://github.com/greensock/gsap-skills | `aed9cfd3277740755f6bfc1155c7aa645403b760` | idem |
| `gsap/gsap-react` | https://github.com/greensock/gsap-skills | `aed9cfd3277740755f6bfc1155c7aa645403b760` | idem |
| `gsap/gsap-scrolltrigger` | https://github.com/greensock/gsap-skills | `aed9cfd3277740755f6bfc1155c7aa645403b760` | idem |
| `gsap/gsap-timeline` | https://github.com/greensock/gsap-skills | `aed9cfd3277740755f6bfc1155c7aa645403b760` | idem |
| `gsap/gsap-utils` | https://github.com/greensock/gsap-skills | `aed9cfd3277740755f6bfc1155c7aa645403b760` | idem |
| `humanizer` | https://github.com/blader/humanizer | `1b48564898e999219882660237fde01bf4843a0f` | intern gebruikt op deze pin; niet in de publieke distributie opgenomen (staat daar in `.gitignore`) |
| `docx`, `pdf`, `pptx`, `xlsx` (anthropics document-skills) | https://github.com/anthropics/skills | — | source-available, geen herdistributierecht — niet gevendord |
| `using-superpowers`, `diagnosing-superpowers` | https://github.com/obra/superpowers | — | plugin-bootstrap/-diagnose van superpowers zelf; in Forge doen `forge-router` en `forge-debug` dat werk. De enige verwijzingen ernaar (in `executing-plans` en `writing-skills`) zijn herschreven of geschrapt |
| `commit-push-pr` (command uit `commit-commands`) | https://github.com/anthropics/claude-plugins-official | `6bfd4e0` (niet gedownload) | maakt een branch, pusht en opent een PR — push en publicatie zijn in Forge owner-gated; Scout hard-pass |
| `clean_gone` (command uit `commit-commands`) | https://github.com/anthropics/claude-plugins-official | `6bfd4e0` (niet gedownload) | verwijdert lokale branches en hun worktrees — destructief; Scout hard-pass |
| `101-skills/superpowers`, `qu-skills/superpowers` | skills.sh-vermeldingen | — | naamkopieën van obra/superpowers zonder licentie, weken oud, met opgeblazen installatietellingen en een verplichte login bij een betaalde CLI; Scout hard-pass. De echte obra/superpowers-skills staan in ronde 1 |

Plaats een opgehaalde skill onder `.claude/skills/<naam>/SKILL.md`; Forge pikt hem daarna vanzelf op.

## Alleen als patroon overgenomen (niets gevendord)

Deze bronnen zijn beoordeeld en in de Scout-ledger (`.claude/config/orchestration/FORGE_SCOUT_VETTING.json`)
vastgelegd, maar er is geen code of tekst van overgenomen:

- **hookify** (Claude Code-plugin) — hard-pass op automatisch installeren: hooks zijn in Forge owner-gated.
  Alleen het idee (regels als hooks formuleren) is genoteerd.
- **explanatory / learning output styles** — als patroon goedgekeurd; wordt een Forge-eigen
  `explain-mode`-configsleutel.
- **ckelsoe/prompt-architect** — als patroon goedgekeurd; Forge-eigen uitwerking is
  `forge-promptcheck.cjs ask` (vaagheidscheck op het ruwe verzoek).
- **skills.sh** (vercel-labs/skills, `npx skills search`) — alleen als **ongecureerde** zoekbron; de ranking
  is installatietelemetrie zonder inhoudelijke review en is nooit een vertrouwenssignaal. Scout's
  APPROVE/HARD-PASS blijft gelden voor alles wat daar gevonden wordt.
