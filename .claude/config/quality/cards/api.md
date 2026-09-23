# Knowledge card: api

Wat bij API-missies aantoonbaar vaak vergeten wordt.

## Contract eerst
- OpenAPI/schema vóór implementatie; versionering afgesproken (pad of header) vóór de eerste consumer.
- Foutsemantiek consistent: RFC 9457 problem+json óf een eigen envelop — maar één stijl, overal.

## Grensbewaking (elke route)
- AuthN/AuthZ server-side op ELKE beschermde route — nooit alleen client-side of alleen op de "belangrijke".
- Inputvalidatie op de grens (schema-based); interne fouten lekken nooit naar buiten (geen stacktraces,
  geen SQL-fragmenten, geen interne paden in responses).
- Rate limits op publieke endpoints; documenteer de limieten in het contract.

## Betrouwbaarheid
- Idempotency op elke mutatie die dubbel kan aankomen (retries bestaan; netwerken falen).
- Timeouts + retry-beleid gedocumenteerd voor uitgaande calls; een hangende downstream mag de API
  niet meetrekken.
- Paginatie op elke lijst-endpoint (unbounded queries zijn een latente productie-storing).

## Contextueel
- Publieke API → CORS-beleid expliciet; interne API → netwerk-scope gedocumenteerd.
- Webhooks uitgeven → signatuur + replay-bescherming aan de ontvangstkant documenteren.

## Bewijsvorm
- Contract-tests tegen het schema · statusmatrix-test (401/403/404/422/500 per route-klasse) ·
  idempotency-test (zelfde request 2× = zelfde effect, één mutatie) · rate-limit-test.
