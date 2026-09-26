# Ten bad-to-good pairs

Ten constructed examples built from the patterns identified in Forge's internal UX research (dev-only, not
part of a fresh install — see `SKILL.md` "Evidence base"). They are illustrations, not real owner requests.
The Dutch text is the original research wording; the English line under each pair is a translation.
`{braces}` are details Forge fills in from the request or the project.

Each pair shows the same four steps: the weak request → the ONE question (option A recommended) → the
assumptions Forge fills in itself → the rewritten request that Forge confirms in one sentence
("Ik bouw dus: … Klopt dat?").

---

## 1. Website (F3, F1)
- **Slecht:** "maak een website voor mijn kapsalon"
- **Vraag:** "Wat moet de site vooral doen? A) afspraak via bellen/WhatsApp B) prijzen en foto's C) online
  boeken met agenda"
- **Aannames:** één pagina, Nederlands, mobiel eerst, echte conceptteksten, alleen voorbeeld.
- **Goed:** "Bouw een one-page site voor kapsalon {naam} in {plaats} voor buurtklanten, zodat ze makkelijk een
  afspraak maken via bellen/WhatsApp. Secties: diensten+prijzen, foto's, openingstijden, contact. Klaar als:
  preview werkt op mobiel en desktop en de belknop werkt. Stijl rustig en licht. Niet: online betalen of live
  zetten."
- *EN:* "Build a one-page site for hair salon {name} in {town} for local customers, so they can easily book by
  phone or WhatsApp. Sections: services and prices, photos, opening hours, contact. Done when: the preview
  works on mobile and desktop and the call button works. Calm, light style. Not: online payment or going
  live."

## 2. n8n automation (F1, F13)
- **Slecht:** "automatiseer mijn mails"
- **Vraag:** "Welke mails? A) nieuwe aanvragen opslaan + bevestiging klaarzetten B) facturen uit je mail
  bewaren C) iets anders"
- **Aanname:** inactief geïmporteerd, alleen concepten.
- **Goed:** "Maak een n8n-workflow: bij een nieuw contactformulier (webhook) opslaan in Google Sheet
  'Aanvragen' en een concept-bevestiging voor de klant maken. Klaar als: een testaanvraag in de sheet staat en
  het concept klaarstaat. Niet automatisch versturen; inactief tot mijn OK."
- *EN:* "Make an n8n workflow: when a new contact form arrives (webhook), save it in the Google Sheet
  'Requests' and create a draft confirmation for the customer. Done when: a test request is in the sheet and
  the draft is ready. Do not send automatically; inactive until my OK."

## 3. Bot (F3)
- **Slecht:** "ik wil een telegram bot"
- **Vraag:** "Waar helpt de bot mee? A) klantvragen (openingstijden, prijzen) B) jou meldingen sturen C)
  afspraken plannen"
- **Goed:** "Telegram-bot die klantvragen over openingstijden en prijzen beantwoordt uit {bestand}; onbekende
  vragen → 'Ik vraag het na' + melding aan mij. Klaar als: 10 testvragen goed of eerlijk doorgestuurd."
- *EN:* "A Telegram bot that answers customer questions about opening hours and prices from {file}; unknown
  questions get 'I'll check' plus a notification to me. Done when: 10 test questions are answered correctly or
  honestly passed on."

## 4. Scraper (F8)
- **Slecht:** "haal alle prijzen van concurrenten op"
- **Vraag:** "Van welke sites? A) ik plak 1–3 links B) zoek jij de 3 grootste in {plaats} C) iets anders"
- **Goed:** "Haal van {3 links} productnaam+prijs op (openbare pagina's, robots.txt respecteren) naar
  prijzen.csv. Klaar als: 1 voorbeeldrij per site klopt met de site."
- *EN:* "From {3 links}, collect product name and price (public pages only, respecting robots.txt) into
  prijzen.csv. Done when: one sample row per site matches the site."

## 5. Bug fix (F9)
- **Slecht:** "het formulier doet het niet meer"
- **Vraag:** "Wat zie je? A) er gebeurt niks bij Verstuur B) een foutmelding (plak) C) de pagina laadt niet"
- **Goed:** "Op /contact gebeurt niets bij Verstuur, sinds de update van gisteren. Verwacht: bedankmelding +
  mail. Zoek de oorzaak, schrijf eerst een test die faalt, repareer, laat de testuitvoer zien. Ontwerp niet
  aanpassen."
- *EN:* "On /contact nothing happens when I press Send, since yesterday's update. Expected: a thank-you message
  and an e-mail. Find the cause, write a failing test first, fix it, show the test output. Do not change the
  design."

## 6. App feature (F6)
- **Slecht:** "voeg login toe"
- **Vraag:** "Wie moet inloggen? A) alleen jij (beheer) B) klanten met eigen account C) medewerkers met
  rechten"
- **Goed:** "Voeg beheer-login toe (alleen ik) voor /admin; bestaande pagina's blijven openbaar en ongewijzigd.
  Klaar als: /admin zonder login doorstuurt naar /login en de test slaagt."
- *EN:* "Add an admin login (only me) for /admin; existing pages stay public and unchanged. Done when: /admin
  without a login redirects to /login and the test passes."

## 7. "Make it nicer" (F10, F11)
- **Slecht:** "maak mijn site mooier"
- **Vraag:** the F10 style question ("rustig en licht / donker en strak / kleurrijk, of stuur een site die je
  mooi vindt").
- **Goed:** "Maak {url} rustiger en beter leesbaar, zoals {voorbeeldsite}: grotere tekst, meer witruimte.
  Teksten en logo blijven. Klaar als: voor/na-screenshots op mobiel en desktop."
- *EN:* "Make {url} calmer and easier to read, like {example site}: larger text, more white space. Texts and
  logo stay. Done when: before/after screenshots on mobile and desktop."

## 8. Megascope (F7)
- **Slecht:** "een app zoals Uber maar voor hondenuitlaters"
- **Vraag:** "Wat moet als eerste werken? A) baasjes vinden een uitlater en nemen contact op B) uitlaters tonen
  beschikbaarheid C) boeken + betalen"
- **Goed:** "Eerste versie: baasjes in {stad} zien een lijst uitlaters (naam, wijk, prijs) en sturen een
  contactverzoek. Niet: betalen, accounts, kaart. Klaar als: demo op mobiel met 5 echte-achtige profielen,
  duidelijk als demo gemarkeerd."
- *EN:* "First version: dog owners in {city} see a list of dog walkers (name, area, price) and send a contact
  request. Not: payments, accounts, a map. Done when: a mobile demo with 5 realistic profiles, clearly marked
  as a demo."

## 9. Chatbot / RAG (F3, F7)
- **Slecht:** "maak een chatbot voor mijn bedrijf"
- **Vraag:** "Waarover mag hij antwoorden? A) alleen jouw diensten, uit je eigen teksten B) ook afspraken
  maken C) alles"
- **Goed:** "Chatbot op {site} die alleen uit {docs} antwoordt, met bron; bij twijfel 'weet ik niet' +
  contactknop."
- *EN:* "A chatbot on {site} that answers only from {docs}, with the source shown; when unsure, 'I don't know'
  plus a contact button."

## 10. Dashboard (F1, F3)
- **Slecht:** "ik wil zien hoe mijn bedrijf gaat"
- **Vraag:** "Welke cijfers wil je elke week zien (max 3)? A) omzet B) nieuwe aanvragen C) openstaande
  facturen"
- **Goed:** "Dashboard met omzet/week en nieuwe aanvragen/week uit {bron}; lege staat als er geen data is.
  Klaar als: cijfers kloppen met {bron} voor vorige week."
- *EN:* "A dashboard with revenue per week and new requests per week from {source}; an empty state when there
  is no data. Done when: the figures match {source} for last week."
