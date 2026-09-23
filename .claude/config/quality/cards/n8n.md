# Knowledge card: n8n

Wat bij n8n-/automationmissies aantoonbaar vaak vergeten wordt.

## Webhook-ingang
- Methode + schema + auth valideren op de eerste node — een open webhook is een open deur.
- Replay/duplicate-events: idempotency vóór elke notificatie of mutatie (dubbele events KOMEN).

## Foutpaden (verplicht, geen optie)
- Error branch op elke workflow die iets muteert of verstuurt; retry met backoff waar zinvol.
- Een error-workflow die zelf faalt mag geen stille leegte zijn — log + alert-pad.

## Omgevingsdiscipline
- Prod/test gescheiden (aparte workflows of expliciete env-switch); import inactive-by-default.
- Credentials als metadata (naam/verwijzing), nooit secrets in workflow-JSON of files.
- Live-activatie is ALTIJD owner-gated — nooit automatisch activeren.

## Validatie
- validate_workflow draaien vóór elke "klaar"-claim; nooit "production-ready" zonder die uitvoer.

## Bewijsvorm
- validate_workflow-uitvoer · duplicate-event-test (zelfde event 2× = één effect) ·
  error-branch-test (geforceerde fout landt in het foutpad, niet in stilte).
