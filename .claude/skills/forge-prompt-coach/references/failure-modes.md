# Failure modes F1–F13 — full wording

Detection, the Dutch question and the safe assumption below are grounded in Forge's internal UX research
(dev-only, not part of a fresh install — see `SKILL.md` "Evidence base"). Ids in square brackets are internal
source labels kept for traceability; treat this file as self-contained.

How to read each entry:
- **Detection** is a text heuristic, not a verdict. Look up the answer yourself first (repo, project profile,
  `.forge-setup.json`) before treating a signal as a real gap [PBP].
- **The question** always has 2–3 options plus "iets anders / something else". Option A is the recommended
  one [G-Q]. Options describe what the owner GETS, never the technique [NNG-RR][ZAMANI]. `{braces}` are filled
  from the request or the project scan before asking.
- **Why A** is a one-line reason for the recommendation. It is Forge's reasoning (usually: A is the safe,
  reversible choice), not a quote from a source.
- **Safe assumption** is what Forge does when the question is not asked or not answered. It is recorded under
  *Assumptions (auto-filled)* in the PRD.
- **Bank questions** are the `.claude/config/intake/question-bank.json` questions whose `triggers` list this
  F-id. The `bugfix/*` and `bots/*` entries are regular `byType` intake packs (`forge-intake.cjs --type bugfix`,
  `--type bots`; live since 2026-09-24).
- The research gives the Dutch wording for all 13 modes and the English wording for F1. The English lines for
  F2–F13 are direct translations, not new content.

---

## F1 — Vague verb ("maak het beter")
- **Detection:** a vague word (beter, mooier, strakker, moderner, professioneler, fixen, regelen, optimaliseren,
  verbeteren, opschonen; improve, fix, clean up) with no object and no measure. Ingredient 1 missing.
- **NL:** "Wat moet er vooral beter? A) hoe het eruitziet B) hoe snel het laadt C) dat meer mensen contact
  opnemen — of iets anders?"
- **EN:** "What should mainly improve? A) the look B) speed C) more people getting in touch — or something
  else?"
- **Why A:** changing only the look is the smallest change that can be shown and undone with before/after
  screenshots.
- **Safe assumption:** NL "Alleen het uiterlijk; inhoud en structuur blijven ongemoeid; voor/na-screenshots."
  · EN "Only the look; content and structure untouched; before/after screenshots."
- **Bank questions:** universal/goal, universal/load-bearing, website/goal, dashboard/content.
- **Sources:** [CC-BP][PBP]; vague-word list from research §A.

## F2 — No "done" check
- **Detection:** no ingredient-4 signal: no "klaar als / is goed als / done when / moet kunnen", no number, no
  test, no "ik wil kunnen…".
- **NL:** "Hoe zie jij dat het gelukt is? A) ik kan een voorbeeld bekijken B) het werkt met mijn echte gegevens
  C) het staat online — of iets anders?"
- **EN:** "How will you see it worked? A) I can look at a preview B) it works with my real data C) it is
  online — or something else?"
- **Why A:** a preview can be judged without any risk; going online is a hard gate anyway.
- **Safe assumption:** NL "Een voorbeeld om te beoordelen, niet live." · EN "A preview to review, not live."
- **Bank questions:** universal/success, universal/deploy, universal/success-measure, website/success,
  fullstack/success, electron/success, n8n/success, integration/success, rag/success, voice/success,
  prediction/success, prediction/scope, scraping/success, dashboard/success, bugfix/expected.
- **Sources:** [CC-BP][DEF-SUCCESS].

## F3 — One word or a very short request ("webshop", "bot")
- **Detection:** fewer than 9 words [GOOG]; a bare deliverable noun.
- **NL:** "Wat moet het vooral doen? A) klanten laten bellen/aanvragen B) producten verkopen C) iets voor jezelf
  automatiseren — of iets anders?"
- **EN:** "What should it mainly do? A) let customers call or send a request B) sell products C) automate
  something for yourself — or something else?"
- **Why A:** a way for customers to get in touch is the smallest useful version of most small-business
  requests.
- **Safe assumption:** NL "De kleinste demo van de meest gangbare lezing, gelabeld als demo." · EN "The
  smallest demo of the most common reading, labelled as a demo."
- **Bank questions:** universal/goal, universal/load-bearing, website/goal, ecommerce/goal, n8n/tech,
  n8n/goal, integration/goal, rag/goal, voice/goal, prediction/goal, dashboard/content, bots/platform,
  bots/answers.
- **Sources:** [GOOG][JOHNNY][NNG-AB].

## F4 — A solution instead of an outcome (XY problem: "zet er een database in")
- **Detection:** a tool or technology name without a goal sentence ("zodat / so that / om te").
- **NL:** "Wat moet dit voor jou oplossen? A) gegevens bewaren die nu kwijtraken B) werk dat je nu met de hand
  doet C) klanten sneller helpen — of iets anders?"
- **EN:** "What should this solve for you? A) keep data that now gets lost B) work you now do by hand C) help
  customers faster — or something else?"
- **Why A:** losing data is the most common reason people name a database; the option names the outcome, so
  the tool can still be chosen freely.
- **Safe assumption:** NL "Het genoemde hulpmiddel alleen gebruiken als het past; anders een alternatief op
  basis van de uitkomst voorstellen." · EN "Use the named tool only if it fits; otherwise propose an
  outcome-based alternative."
- **Bank questions:** universal/goal, universal/tech, universal/why, website/tech, ecommerce/tech,
  fullstack/tech, electron/tech, voice/tech, prediction/tech, dashboard/tech.
- **Sources:** [XY].

## F5 — Several projects in one request
- **Detection:** two or more deliverable types joined by `en / ook / plus / and`.
- **NL:** "Waar beginnen we mee? A) {eerste} B) {tweede} C) {derde}. De rest zet ik op de lijst voor later."
- **EN:** "Where do we start? A) {first} B) {second} C) {third}. I'll put the rest on the list for later."
- **Why A:** fill A with the item the others depend on (else the first one named) — that order never blocks
  the rest.
- **Safe assumption:** NL "Beginnen met het item waar de rest van afhangt, anders het eerstgenoemde; de rest
  parkeren." · EN "Start with the item the rest depends on, else the first one named; park the rest."
- **Bank questions:** universal/scope, website/scope.
- **Sources:** research §B; [SHAPEUP] for "smallest first".

## F6 — No audience
- **Detection:** no `voor / for` + a person (customers, members, team, me).
- **NL:** "Voor wie is het? A) je klanten B) alleen jij C) je team — of iets anders?"
- **EN:** "Who is it for? A) your customers B) only you C) your team — or something else?"
- **Why A:** most beginner requests are for the owner's customers; the other two are easy to recognise.
- **Safe assumption:** NL "Publiek werk = klanten, interne tools = de eigenaar; Nederlands, mobiel eerst." ·
  EN "Public work = customers, internal tools = the owner; Dutch, mobile first."
- **Bank questions:** universal/audience, universal/why, universal/language, website/audience,
  fullstack/tech, fullstack/scope, fullstack/audience, rag/audience, voice/audience, dashboard/audience,
  dashboard/design, bots/audience.
- **Sources:** [CONST][CARE].

## F7 — Megascope ("zoals Facebook")
- **Detection:** a platform name (Facebook, Uber, Airbnb, Amazon, Bol, Marktplaats), `alles`, `platform`,
  `net als X maar`.
- **NL:** "Wat is het ÉÉN ding dat als eerste moet werken? A) {kernactie 1} B) {kernactie 2} C) {kernactie 3}
  — of iets anders?"
- **EN:** "What is the ONE thing that must work first? A) {core action 1} B) {core action 2} C) {core action 3}
  — or something else?"
- **Why A:** fill A with the core action every other feature needs (for a marketplace: finding and contacting
  a provider), so the first version is already useful.
- **Safe assumption:** NL "Een klikbare eerste versie met één functie; de rest later." · EN "A clickable first
  version with one function; the rest later."
- **Bank questions:** universal/scope, universal/non-goals, website/scope, website/non-goals,
  ecommerce/scope, ecommerce/content, ecommerce/non-goals, fullstack/scope, fullstack/audience, fullstack/tech,
  fullstack/content, fullstack/non-goals, electron/tech, rag/goal, rag/non-goals, scraping/scope,
  dashboard/scope, bots/answers.
- **Sources:** [SHAPEUP][LOV].

## F8 — Points at something existing without saying where
- **Detection:** "mijn site / de app / weer / nog steeds" without a URL, path or project name.
- **NL:** "Bedoel je {project uit scan}? A) ja B) iets anders: plak de link C) nieuw beginnen"
- **EN:** "Do you mean {project from scan}? A) yes B) something else: paste the link C) start fresh"
- **Why A:** the scan candidate is the most likely meaning; asking only makes sense when the scan found it.
- **Safe assumption:** NL "Eén kandidaat in de scan: die gebruiken (de bestaande `forge-intake`-regel)." · EN
  "One scan candidate: use it (the existing `forge-intake` rule)." Two equally plausible candidates → this is
  the one question to ask.
- **Bank questions:** universal/existing-state, website/tech, ecommerce/data, fullstack/data, n8n/data,
  n8n/content, n8n/tech, integration/goal, rag/data, scraping/data, dashboard/data, dashboard/tech,
  bugfix/steps.
- **Sources:** [CC-BP][SUPA].

## F9 — Bug without a symptom
- **Detection:** "werkt niet / kapot / error / doet raar" without an error text, steps or "since".
- **NL:** "Wat zie je gebeuren? A) een foutmelding (plak of screenshot) B) er gebeurt niks als ik klik C) het
  ziet er verkeerd uit — of iets anders?"
- **EN:** "What do you see happening? A) an error message (paste or screenshot) B) nothing happens when I
  click C) it looks wrong — or something else?"
- **Why A:** the exact error text usually points straight at the cause.
- **Safe assumption:** NL "Forge start de app zelf, doet de fout na en bekijkt recente wijzigingen; geen
  herontwerp." · EN "Forge runs the app itself, reproduces the problem and looks at recent changes; no
  redesign."
- **Bank questions:** universal/existing-state, bugfix/symptom, bugfix/steps,
  bugfix/error-text, bugfix/since-when, bugfix/expected.
- **Sources:** [CC-BP][CODEX].

## F10 — Taste words without a reference
- **Detection:** modern, strak, mooi, professioneel, cool — with no URL, "zoals / like", or example.
- **NL:** "Welke stijl past het best? A) rustig en licht B) donker en strak C) kleurrijk. Of stuur een site die
  je mooi vindt."
- **EN:** "Which style fits best? A) calm and light B) dark and sleek C) colourful. Or send a site you like."
- **Why A:** calm and light is the most readable default; one real example beats any adjective [PBP][LOV].
- **Safe assumption:** NL "Een rustige, leesbare standaard plus twee varianten." · EN "A calm, readable
  default plus two variants."
- **Bank questions:** universal/references, website/design, ecommerce/design, dashboard/design.
- **Sources:** [PBP][LOV][EXMAP].

## F11 — Changing existing work without a limit
- **Detection:** a change intent on existing work without ingredient 6 (`niet / geen / zonder / alleen /
  blijft / laat…staan / don't / only / keep`).
- **NL:** "Wat moet zeker hetzelfde blijven? A) teksten en logo B) hoe bestellen/inloggen werkt C) niks, alles
  mag"
- **EN:** "What must definitely stay the same? A) texts and logo B) how ordering/logging in works C) nothing,
  anything may change"
- **Why A:** texts and logo are what owners most often expect to keep; freezing them is always reversible.
- **Safe assumption:** NL "Alleen het genoemde wijzigen; de rest blijft bevroren; eerst een herstelpunt." · EN
  "Change only what was named; the rest is frozen; checkpoint first."
- **Bank questions:** universal/existing-state, universal/must-not-break, fullstack/data.
- **Sources:** [LOV][CODEX].

## F12 — The goal changes halfway
- **Detection:** new deliverables in a follow-up message, "laat maar / eigenlijk / toch liever".
- **NL:** "Stoppen met {X} en naar {Y}, of {Y} na {X}? A) eerst {X} afmaken B) nu naar {Y} C) {Y} op de lijst"
- **EN:** "Stop {X} and switch to {Y}, or {Y} after {X}? A) finish {X} first B) switch to {Y} now C) put {Y}
  on the list"
- **Why A:** finishing the current step leaves a working, checkpointed state before anything new starts.
- **Safe assumption:** NL "De huidige run parkeren op een veilig herstelpunt; nooit de twee mengen." · EN
  "Park the current run at a safe checkpoint; never mix the two."
- **Bank questions:** none — this happens mid-run, not at intake.
- **Sources:** research §B.

## F13 — Sending or paying without a consent limit
- **Detection:** stuur / mail / post / betaal / publiceer (send, e-mail, post, pay, publish) without who, when
  or a limit.
- **NL:** "Moet Forge echt versturen, of eerst klaarzetten? A) alleen klaarzetten B) versturen na mijn OK C)
  automatisch"
- **EN:** "Should Forge really send, or prepare it first? A) only prepare it B) send after my OK C)
  automatically"
- **Why A:** sending and paying cannot be undone; preparing can always be sent later.
- **Safe assumption:** NL "Alleen concepten." · EN "Drafts only." Irreversible actions need explicit
  confirmation [G-CONF]; this matches the hard gates (`.claude/config/orchestration/hard-gates.json`), which
  stay in force even when the owner picks C.
- **Bank questions:** universal/deploy, universal/budget, universal/outward-action, ecommerce/data,
  ecommerce/deploy, electron/deploy, n8n/deploy, n8n/scope, integration/scope, integration/data, rag/content,
  rag/deploy, voice/scope, voice/tech, voice/data, voice/non-goals, voice/success, prediction/data,
  prediction/non-goals, prediction/deploy, scraping/goal, dashboard/scope.
- **Sources:** [G-CONF][PBP].
