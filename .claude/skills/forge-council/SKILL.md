---
name: forge-council
description: LLM Council (FULL) — 5 onafhankelijke adviseurs via de Agent-tool, anonieme peer review, chairman-synthese met minority report, gevalideerd record. Alleen via councilTrigger; nooit bewijs.
---

# forge-council — LLM Council (FULL-protocol)

Gebruik ALLEEN wanneer `councilTrigger()` (forge-quality.cjs) FULL zegt: expliciete owner-vraag om
tegenspraak, of hoge impact + hoge onzekerheid. Nooit standaard, nooit op simpele taken — de
verwachte informatiewinst moet latency, kosten en contextbelasting overstijgen. LIGHT bestaat als
uitkomst van de trigger maar heeft hier bewust GEEN protocol: eerst een benchmark die waarde
aantoont (anti-overengineering), tot die tijd valt LIGHT terug op één gerichte second opinion.

## Protocol (FULL)

**Stap 0 — neutrale framing.** Schrijf de beslisvraag NEUTRAAL op (geen voorkeursrichting, geen
"we neigen naar X"): context, opties, criteria, harde grenzen. Bereken `context_hash` =
sha256 van die framingtekst (forge-quality.cjs::sha256). De framing is een run-artefact.

**Stap 1 — 5 verse, onafhankelijke adviseurs, parallel.** Dispatch via de Agent-tool (echte
subagents, één bericht met 5 parallelle calls; GEEN gesimuleerde agents). Elke adviseur krijgt
ALLEEN de neutrale framing — geen zicht op elkaar. De vijf vaste lenzen:
- **Contrarian** — valt de populairste optie aan; zoekt wat iedereen mist.
- **First Principles** — herleidt naar grondbeginselen; negeert conventie.
- **Expansionist** — verbreedt de optieruimte; wat als de vraag zelf te smal is?
- **Outsider** — kijkt als buitenstaander/eindgebruiker; jargonvrij.
- **Executor** — beoordeelt uitvoerbaarheid, kosten, risico, rollback.

**Stap 2 — anonieme peer review.** Anonimiseer de vijf adviezen als A-E en stuur ze naar elke
adviseur terug (tweede dispatchronde): rangschik de andere vier en benoem de sterkste kritiek per
advies. Anonimiteit voorkomt autoriteits- en zelfvoorkeur.

**Stap 3 — chairman-synthese.** De orchestrator (of een aparte chairman-dispatch) weegt adviezen +
peer-rankings en schrijft het besluit MET expliciet **minority report**: afwijkende meningen
verdwijnen niet, ze staan erbij met reden.

**Record.** Vul een CouncilDecisionRecord: council_id, context_hash, participants (role + runtime +
dispatch_id uit de ECHTE Agent-dispatches + response_ref), responses, quorum, verdict,
minority_report, status. Valideer met `validateCouncilRecord` en persisteer via
`node .claude/forge-bin/forge-quality.cjs council-save <run_id> <record.json>` — een ongeldig
record wordt NIET geschreven (de weigering met reden is het eerlijke resultaat), en een council_id
wordt nooit overschreven.

## Grenzen (permanent)
- Validatie is **shape_only**: runtime/dispatch_id zijn niet cryptografisch gebonden; echte
  provenance vereist het owner-gated gateway-dispatchreceipt (OWNER-GATED.md).
- **Consensus is nooit bewijs.** Elk council-besluit dat code raakt, eist daarna gewone
  tests/metingen; het record verwijst ernaar, nooit andersom.
- Een INCOMPLETE quorum wordt eerlijk INCOMPLETE gemarkeerd — nooit opgevuld.
