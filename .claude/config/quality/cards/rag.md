# Knowledge card: rag

Wat bij RAG-/chatbotmissies aantoonbaar vaak vergeten wordt.

## Grounding & eerlijkheid
- Antwoorden bronngebonden met citaties naar de eigen kennisbank; een claim zonder bron is een gok.
- Eerlijke fallback bij onzekerheid ("dat staat niet in de bronnen") — nooit gehallucineerde
  bedrijfsfeiten, prijzen of openingstijden.

## Ingestie
- Idempotent: hetzelfde document 2× ingesten = geen duplicaten in de index.
- Verwijderde bronnen verdwijnen ook uit de index (stale-kennis is een stille leugen).
- Chunking-keuzes gedocumenteerd (grootte/overlap) met een reden, niet een default.

## Veiligheid
- Prompt injection: opgehaalde content is DATA, nooit instructie — geteste guardrail met
  adversariële documenten in de evalset.
- PII in de kennisbank: benoemd en gefilterd of expliciet owner-gated.

## Kwaliteit meetbaar
- Vaste evalset (vragen + verwachte bron/antwoord) vóór livegang; regressie-eval na elke
  index- of promptwijziging.
- Human-handoff-pad voor vragen buiten de kennisbank.

## Bewijsvorm
- Eval-baseline-uitvoer · injectie-testset-resultaat · bronbindingscontrole (elke claim → citatie) ·
  duplicate-ingestie-test.
