# Knowledge card: website

Wat bij websitemissies aantoonbaar vaak vergeten wordt — geen playbook-duplicaat (HOE bouwen staat
in forge-website), wel de WAT-checklist die de omission miner en de reviewer scherp houdt.

## Conversie & inhoud
- CTA boven de fold, ook op mobiel; USP zichtbaar vóór de eerste scroll; FAQ beantwoordt echte bezwaren.
- Echte content, nooit lorem/placeholder in oplevering; bedrijfsinfo alleen uit de missie of aangeleverd
  materiaal — nooit verzonnen adressen, reviews of teamleden.

## Formulier-submitflow (elke staat expliciet)
- Succes → thank-you-staat (pagina of inline) met bevestigingstekst.
- Fout → bruikbare melding (wat ging mis, wat kan de bezoeker doen), geen kale stacktrace.
- Loading-staat; dubbele submit voorkomen (disable + idempotente afhandeling).
- Server-side validatie naast client-side; spam-bescherming (honeypot/rate limit).
- Privacygrondslag bij het formulier (welke gegevens, waarvoor) — AVG-basis.

## Vindbaarheid & robuustheid
- robots.txt + sitemap.xml + canonicals; meta title/description per pagina; OG-image voor delen.
- Alt-teksten op betekenisvolle afbeeldingen; 404 met navigatie terug.
- Responsive aangetoond met echte screenshots op ≥3 breakpoints (mobiel/tablet/desktop), geen aanname.

## Core Web Vitals (meten, niet voelen)
- LCP ≤ 2.5s · INP ≤ 200ms · CLS ≤ 0.1 op p75 (bron: web.dev/articles/vitals, geraadpleegd 2026-08-12).

## Contextueel (nooit blind toepassen)
- Kaart/maps alleen bij fysieke locatie — anders NOT_APPLICABLE.
- Analytics/GA4 alleen bij expliciete vraag mét grondslag — anders OWNER_GATED, nooit stil toevoegen.
- Cookiebanner alleen als er echt tracking is; geen consent-theater zonder tracker.

## Bewijsvorm
- Screenshots per breakpoint · Lighthouse-run (of CWV-meting) · submitflow-test die succes/fout/dubbel
  aantoonbaar doorloopt · zero console errors op de kernpagina's.
