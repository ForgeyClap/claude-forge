# LEAN DISPATCH — tokenregels voor Lead + alle subagents (owner-opdracht 2026-07-29)

Herkomst: PATTERN_ADAPTED van github.com/DietrichGebert/ponytail ("laziest senior dev": ~54% minder
code door gedragsregels, geen tooling). Geen code overgenomen; het gedragsmodel wel.

## Beslisladder — VÓÓR je iets bouwt of schrijft
1. Moet dit bestaan? (YAGNI — zo nee: stop)
2. Bestaat het al in deze codebase? (hergebruik, bouw niet opnieuw)
3. Doet de stdlib/het platform het al? (geen dependency erbij)
4. Kan het in één regel / minimale diff? (dan dát)
5. Pas daarna: het minimum dat werkt.

## Dispatch-regels (Lead)
- Prompts kort: doel + scope + verboden + bewijs-eis. Geen herhaalde context die de agent zelf kan lezen.
- Kleinste team: 1 agent tenzij paden echt onafhankelijk zijn.
- Mechanisch werk → laag effort; alleen verify/judge hoog.

## Werk-regels (elke subagent)
- Lees gericht (grep/regelbereik), nooit hele repo's.
- Minimale diff; geen speculatieve abstracties of extra's.
- Tests: alleen geraakte tests draaien; de volledige suite draait de Lead éénmaal per ronde centraal.
- Rapport compact: status · bestanden · bewijs (letterlijke slotregels) · not_run. Geen proza-herhaling.
- Geen `npm run build`, geen gateway-herstart (Lead doet dat centraal — voorkomt ook dubbel werk).
