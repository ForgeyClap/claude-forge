---
name: forge-quality
description: Quality Intelligence Layer — missie → MissionProfile, 10 lenzen, omission mining, requirement cards, driftdetectie, contextcompiler en selectieve council-trigger. Router Stap 1 voor elke build.
---

# forge-quality — Quality Intelligence Layer

Laag-2-instructie (progressive disclosure): dit bestand is klein; domeinkennis leeft in laag 3
(`.claude/config/quality/cards/*.md`, 0 tokens tot geladen). De module is
`.claude/forge-bin/forge-quality.cjs`; de canonieke domeinlijst is
`.claude/config/orchestration/domain-catalog.json` — bij tegenspraak wint de CATALOGUS en wordt de
afwijkende seam gefixt, nooit een tweede lijst begonnen.

## Commands

```bash
node .claude/forge-bin/forge-quality.cjs analyze "<de missie>"  # HET entrypoint: profiel + playbook + lenzen + omissions + kaart-descriptors + council in één JSON (F-14)
node .claude/forge-bin/forge-quality.cjs profile "<de missie>"  # alleen het MissionProfile
node .claude/forge-bin/forge-quality.cjs card <slug>            # één knowledge card (laag 3, on-demand)
node .claude/forge-bin/forge-quality.cjs drift                  # catalogus vs 4 seams — elk verschil is een bevinding (exit 3 bij drift)
node .claude/forge-bin/forge-quality.cjs kernel                 # de vaste Quality Kernel (~600-800 tokens)
```

## Werkwijze (router Stap 1 — verplicht bij BUILD-taken)

1. `analyze` draaien; machine-uitvoer wint van elke mensentabel. `classification_confidence: none`
   betekent: de fallback is een AANNAME — los het type expliciet op (intake) vóór er wordt gebouwd.
2. Lenzen: elke lens heeft EXACT één disposition (RELEVANT/NOT_APPLICABLE/DEFERRED/OWNER_GATED)
   mét reden. Stil overslaan bestaat niet; stil toevoegen evenmin.
3. Omissions zijn kandidaat-eisen (vooraf gevalideerd; `omissions_valid` moet true zijn — een zelf
   bewerkte kaart opnieuw door `validateRequirementCard`). Een RESEARCH_HYPOTHESIS wordt nooit
   direct een harde eis — promotie eist `confirmed_by` {type: lokale-validatie|officiele-bron|
   experiment, ref}.
4. Knowledge cards: alleen descriptors met `exists: true` laden via `card <slug>` — max 6 kaarten,
   max 3 retrievalrondes. Een ontbrekende kaart is een eerlijke melding, nooit verzonnen inhoud.

## Council (selectief, nooit default)

`councilTrigger` beslist: NONE is de default; FULL alleen bij expliciete vraag of hoge impact +
hoge onzekerheid. Echte dispatch loopt via de Agent-tool; het CouncilDecisionRecord valideert met
`validateCouncilRecord` — die validatie is shape_only (labels bewijzen geen principal; echte
provenance is owner-gated, zie OWNER-GATED.md). Council-consensus is NOOIT bewijs — alleen
tests/metingen zijn dat.
