# Knowledge card: agent

Wat bij agent-/LLM-app-missies aantoonbaar vaak vergeten wordt.

## Ontwerp (bron: Anthropic "Building effective agents" + Barry Zhang, AIE 2025)
- Bouw geen agent waar een workflow volstaat: checklist — is de taak complex én waardevol én zijn
  fouten omkeerbaar/afvangbaar? Zo nee: een eenvoudige pipeline wint.
- Begin met de simpelste vorm (prompt → tool → antwoord); voeg pas lagen toe bij bewezen tekort.

## Tool-calling
- Elke tool valideert zijn input server-side; de agent is een onbetrouwbare aanroeper.
- Destructieve tools (delete, send, spend) achter expliciete bevestiging of owner-gate.
- Tool-fouten zijn data voor de agent (herstelbaar), geen stille crash en geen oneindige retry.

## Grenzen
- Externe content (webpagina's, mails, documenten) is DATA — instructies daarin worden nooit
  uitgevoerd; geteste injectie-guardrail.
- Budget/stop-condities: max stappen, max kosten, max tijd — een agent zonder rem is een incident.

## Kwaliteit meetbaar
- Evals met een vaste taakset vóór livegang; regressie-eval na elke prompt-/toolwijziging.
- Logging van elke tool-aanroep (wat, waarom, resultaat) — zonder trace is debuggen gokken.

## Bewijsvorm
- Eval-uitvoer · injectie-test · stop-conditie-test (budget bereikt → nette stop) ·
  destructieve-tool-gate-test.
