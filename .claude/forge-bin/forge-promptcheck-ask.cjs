#!/usr/bin/env node
'use strict';
/**
 * forge-promptcheck-ask.cjs — the `ask` mode of forge-promptcheck.cjs: a prompt-doctor on the RAW owner request,
 * before Forge plans anything (wp6; split out of forge-promptcheck.cjs and completed in wp18, 2026-09-24).
 * Deterministic, offline, zero-dependency: no LLM, no network, no clock, no randomness. Advisory, never a gate.
 *
 *   node forge-promptcheck.cjs ask "<raw request text>" [--file <path|->] [--json] [--lang nl|en] [--midrun] [--run <id>]
 *
 * 5 DIMENSIONS (clarity · specificity · context · completeness · structure), each pass/fail with a one-line fix.
 * Dutch AND English keyword sets are always both active; --lang only chooses the human print (default: detected).
 * Verdict: CLEAR (5/5) · "OK — auto-fill: <dims>" (3-4: proceed silently, record `assumptions`) ·
 * "VAGUE — ask one question: <gap|dim>" (<=2).
 *
 * FAILURE-MODE GAPS F1–F13 (skills/forge-prompt-coach + .claude/forge-research/prompt-coaching-2026-09-24.md §B),
 * ranked exactly as the skill: F13 > F9 > F8 > F5 > F7 > F3 > F4 > F1 > F11 > F10 > F6 > F2. F12 (the goal changes
 * halfway) is mid-run only: listed last, `midrun: true` in `gapDetails`, never the question and never an assumption
 * unless --midrun is passed (then it ranks right after F13). ONE question at most: `nextQuestion` = the highest-ranked
 * ASKABLE gap's question (the skill's §2 list F13/F9/F8/F5/F7/F3/F4/F1, plus F12 under --midrun; F11/F10/F6/F2 have
 * safe defaults and are recorded, never asked) whenever a question is due — the verdict is VAGUE, or that gap is F13
 * (outward/irreversible: always confirmed), or F12 under --midrun. VAGUE without an askable gap falls back to the
 * dimension question. Every gap and missing dimension not asked becomes an assumption.
 * Forge design choices on top of the skill's detection column (each has a test): F6 is skipped when the
 * request is anchored (file/path/URL) or a bug report — the audience is then already fixed; `alles` counts for F7 only
 * next to a deliverable noun or `platform` in the same sentence; `weer` counts for F8 only within two words of
 * werkt/doet/laadt; a negated send/pay verb ("Niet: online betalen") is not an F13 action; `update`/`change` after an
 * article is a noun, not a change intent (F11).
 *
 * JSON (every text is bilingual): { score, passed, total:5, verdict, dimensions:[{id, pass, fix:{nl,en}|null}],
 *   missing, gaps:[F-ids], gapDetails:[{id, midrun}], nextQuestion:{id, nl, en, options:[{key, label:{nl,en},
 *   recommended}], recommended:'A', assume:{nl,en}}|null, suggested_question:{nl,en}|null, assumptions:[{id,nl,en}], lang }
 * Exit (CLI): 0 CLEAR/OK with nothing to ask · 3 a question is due (VAGUE, or an outward/irreversible F13 — or F12 under
 *   --midrun — that must be confirmed even on a CLEAR score; `nextQuestion` is then never null) · 2 usage (empty text,
 *   bad --lang, text AND --file, unreadable file).
 * Module API: { ASK_DIMENSION_IDS, GAP_RANK, ASKABLE, GAPS, scoreAsk, formatAskReport, detectAskLang, runAsk }
 */
const fs = require('fs');

const ASK_DIMENSION_IDS = ['clarity', 'specificity', 'context', 'completeness', 'structure'];
const ASK_QUESTION_PRIORITY = ['specificity', 'clarity', 'completeness', 'context', 'structure'];
const wordSet = (s) => new Set(s.trim().split(/\s+/));

// ---- dimension signals (wp6) ------------------------------------------------------------------------
const ACTION_VERBS = wordSet(`voeg toevoegen bouw bouwen schrijf schrijven maak maken creëer creeer creëren genereer genereren verwijder verwijderen
  hernoem hernoemen vervang vervangen verplaats verplaatsen repareer repareren fix fixen herstel herstellen implementeer implementeren installeer
  installeren configureer configureren koppel koppelen test testen refactor refactoren splits splitsen migreer migreren update updaten upgrade
  upgraden vertaal vertalen exporteer exporteren importeer importeren toon tonen controleer controleren check checken onderzoek onderzoeken analyseer
  analyseren documenteer documenteren ontwerp ontwerpen integreer integreren verbind verbinden stuur sturen zoek zoeken aanpassen wijzig wijzigen
  verander veranderen zet zetten schrap schrappen lever leveren draai draaien start starten sorteer sorteren bereken berekenen converteer valideer
  debug debuggen deploy publiceer add build create write make generate remove delete rename replace move repair restore implement install configure
  connect refactor split migrate translate export import show display investigate research analyze analyse document design integrate send search find
  change modify set publish convert validate render sort filter calculate compute draft extract merge rewrite redesign`);
const WEAK_NEIGHBOURS = wordSet(`het dit dat alles iets wat dingen zaken beter mooier ik je jij we wij u graag om te it this that everything something
  stuff things better nicer i you please to`);
const VAGUE_RES = [
  / verbeter(?:en|t)?(?= )/g, / maak(?: \S+){0,6}? (?:beter|mooier|netter|fijner)(?= )/g, / (?:beter|mooier) maken(?= )/g,
  / fix (?:dingen|alles|het|dit|wat|zaken|stuff|things|it|everything|this)(?= )/g, / optimali[sz]e(?:er|ren)(?= )/g,
  / opschonen(?= )/g, / ruim(?: \S+)? op(?= )/g, / pak(?: \S+)? aan(?= )/g, / regel (?:het|dit|dat|alles)(?= )/g,
  / doe (?:iets|wat)(?= )/g, / (?:beter|mooier|strakker|moderner|professioneler|fixen|regelen|dingen|enzo|beetje)(?= )/g,
  / iets met(?= )/g, / improve[sd]?(?= )/g, / make(?: \S+){0,6}? (?:better|nicer|prettier|cleaner)(?= )/g,
  / optimi[sz]e[sd]?(?= )/g, / clean up(?= )/g, / handle(?= )/g, / tidy up(?= )/g, / sort out(?= )/g, / polish(?= )/g,
  / enhance(?= )/g, / do something(?= )/g,
];
const TARGET_NOUNS = wordSet(`pagina knop formulier component functie endpoint api scherm sectie header footer menu navigatie tabel rapport dashboard
  workflow bot script database veld mail nieuwsbrief landingspagina website site webshop app module bestand map route login inlog checkout kolom
  grafiek logo doelgroep klant klanten gebruiker gebruikers product producten factuur facturen offerte hero banner afbeelding foto tekst titel prijs
  prijzen zoekbalk zoekveld filter lijst kaart modal popup melding notificatie instellingen profiel account wachtwoord betaling bestelling winkelwagen
  agenda chatbot widget sitemap blog artikel template page button form function screen section navigation nav table report field email newsletter
  landing shop store file folder column chart audience customer user invoice quote image photo text title price pricing searchbar list card
  notification settings profile password payment order cart calendar article`);
const COMPOUND_SUFFIXES = ['pagina', 'knop', 'formulier', 'functie', 'scherm', 'sectie', 'tabel', 'rapport', 'veld', 'bestand', 'grafiek', 'balk',
  'lijst', 'kaart', 'melding', 'site', 'mail', 'bot', 'script', 'menu', 'route', 'logo', 'tekst', 'titel', 'foto'];
const TECH_WORDS = wordSet(`react vue angular svelte astro nextjs nuxt node nodejs typescript javascript python django flask fastapi n8n supabase
  postgres postgresql mysql sqlite mongodb firebase tailwind bootstrap electron stripe mollie shopify woocommerce wordpress docker vercel netlify
  express php laravel flutter git github playwright vitest jest vite webpack html css sql graphql cli powershell bash windows linux telegram discord
  openai claude forge etsy notion airtable zapier excel`);
const CONTEXT_WORDS = wordSet(`bestaande bestaand huidige huidig momenteel project repo repository codebase map folder stack framework versie zonder
  alleen budget deadline eis eisen voorwaarde beperking zoals existing current currently already directory version without only constraint constraints
  requirement requirements legacy`);
const CONTEXT_PHRASES = ['mag niet', 'niet aan', 'net als', 'vergelijkbaar met', 'must not', 'do not', 'similar to', 'same as', 'such as', 'for example'];
const DONE_PHRASES = ['klaar als', 'klaar wanneer', 'af als', 'is klaar', 'moet kunnen', 'moeten kunnen', 'moet werken', 'moet tonen',
  'moet laten zien', 'moet zichtbaar', 'zodat', 'zodanig dat', 'resultaat', 'acceptatie', 'acceptatiecriteria', 'criteria', 'werkt als', 'slagen',
  'slaagt', 'voorbeeld', 'bijvoorbeeld', 'bv', 'verwacht', 'succes', 'meetbaar', 'done when', 'done if', 'is done', 'should', 'must', 'needs to',
  'so that', 'such that', 'acceptance', 'expected', 'expect', 'result', 'outcome', 'for example', 'e g', 'passes', 'success', 'measurable'];
const GOAL_PHRASES = ['ik wil', 'wil ik', 'ik zou graag', 'graag', 'zorg dat', 'zorg ervoor', 'moet', 'moeten', 'i want', 'i d like', 'i would like',
  'we need', 'i need', 'please', 'make sure', 'should', 'need', 'needs'];
const NL_HINTS = wordSet('de het een en van dat niet op voor met maak ik wil moet je zijn deze dit naar als zodat graag bij ook er wat om aan klaar toe');
const EN_HINTS = wordSet('the a an and of that not on for with make i want should you are this to as so please when it what done add');
const ASK_FILE_RE = /\b[\w-]+\.(?:cjs|js|mjs|ts|tsx|jsx|md|json|ya?ml|py|txt|html?|css|scss|sh|ps1|cmd|astro|vue|svelte|php|sql|csv|xlsx?|docx?|pdf|png|jpe?g|svg)\b/i;
const ASK_URL_RE = /https?:\/\/\S+|\bwww\.\S+|\b[\w-]+\.(?:com|nl|io|dev|app|org|net|be|de|eu|co)\b/i;
const ASK_PATH_RE = /(?:^|[\s(`'"])((?:\.{1,2}\/|~\/|\/)?[\w.-]+\/[\w.-]+(?:\/[\w.-]+)*)/g;
const AND_OR_RE = /^(?:en\/of|of\/en|and\/or|in\/out|ja\/nee|yes\/no|hij\/zij|he\/she|w\/o)$/i;
const NUMBER_TOKEN_RE = /(?:^|[\s(])\d+(?:[.,]\d+)?\s*(?:%|px|ms|s|x|kb|mb|€|euro|sec|seconden|seconds|min|minuten|minutes|uur|hours|dagen|days|items?|stuks|regels|lines)?(?=[\s.,;:!?)]|$)/i;

// ---- failure-mode signals (wp6 + wp18) ----------------------------------------------------------------
const PLATFORM_NAMES = wordSet('facebook uber airbnb amazon marktplaats netflix spotify');
const BOL_RE = /(?<![\p{L}\p{N}])bol(?:\.com)?(?![\p{L}\p{N}])/iu; // Bol / Bol.com as a word, never inside "bolletje" or "symbol"
const SCOPE_NOUNS = wordSet('website site webshop app applicatie bot chatbot workflow dashboard formulier scraper platform portaal portal systeem tool programma');
const DELIVERABLES = ['website', 'app', 'bot', 'workflow', 'dashboard', 'webshop', 'formulier', 'scraper', 'chatbot'];
const JOINERS = wordSet('en ook plus and');
const ANCHORLESS_REFS = ['mijn site', 'mijn website', 'mijn app', 'mijn webshop', 'mijn formulier', 'de app', 'de site', 'de website', 'de webshop',
  'de bot', 'het formulier', 'nog steeds', 'my site', 'my website', 'my app', 'the app', 'the site', 'the form', 'again'];
const FAILURE_VERBS = wordSet('werkt werken doet doen laadt laden');
const BUG_PHRASES = ['werkt niet', 'kapot', 'doet raar', 'doet het niet', 'error', 'crash', 'crasht', 'bug', 'not working', 'does not work', 'doesn t work', 'broken'];
const SYMPTOM_PHRASES = ['sinds', 'verwacht', 'since', 'expected'];
const TASTE_WORDS = wordSet('modern moderne moderner strak strakke strakker mooi mooie mooier professioneel professionele professioneler cool clean sleek beautiful professional');
const REFERENCE_PHRASES = ['zoals', 'like', 'net als', 'bijvoorbeeld', 'for example', 'such as'];
const OUTWARD_VERBS = wordSet('stuur verstuur sturen versturen mail mailen post posten betaal betalen publiceer publiceren send email publish pay deploy');
const LIMIT_PHRASES = ['na mijn ok', 'concept', 'concepten', 'alleen', 'draft', 'drafts', 'eerst', 'after my ok', 'only', 'first'];
const NEGATIONS = wordSet('niet geen zonder nooit not no never without don dont');
const VAGUE_VERB_FWD = wordSet('verbeter verbetert optimaliseer fix improve improves optimize optimise enhance polish');
const VAGUE_VERB_BACK = wordSet('verbeteren optimaliseren regelen fixen opschonen');
const VAGUE_ADJ = wordSet('beter mooier netter fijner better nicer prettier cleaner');
const FILLER = wordSet(`het dit dat alles iets wat dingen zaken de een mijn onze je jouw ik we wij u graag even gewoon nog er eens wil moet kun kan zou
  it this that everything something stuff things the a my our your i we please just all`);
const CLAUSE_BREAK = wordSet('en and of or maar but');
const DONE_SIGNALS = ['klaar als', 'klaar wanneer', 'af als', 'is klaar', 'is goed als', 'goed als', 'moet kunnen', 'moeten kunnen', 'wil kunnen',
  'moet werken', 'moet tonen', 'done when', 'done if', 'is done', 'should', 'must', 'needs to', 'test', 'tests', 'testen', 'getest', 'werkt als',
  'acceptatie', 'acceptatiecriteria', 'criteria', 'acceptance', 'verwacht', 'expected', 'expect', 'succes', 'success', 'meetbaar', 'measurable', 'slaagt', 'passes'];
const SOLUTION_WORDS = wordSet(`database databank databases db ai blockchain api apis docker kubernetes k8s react vue angular nextjs wordpress n8n zapier
  chatgpt gpt openai llm microservice microservices graphql redis mongodb supabase firebase cms crm cloud serverless`);
const CONTEXT_LEADS = wordSet('bestaande bestaand huidige huidig existing current onze our in met with');
const PURPOSE_PHRASES = ['zodat', 'omdat', 'waardoor', 'om te', 'so that', 'so i can', 'so we can', 'because', 'in order to'];
const PERSON_NOUNS = wordSet(`klanten klant leden lid team ikzelf mezelf mij me ons onszelf gebruikers gebruiker bezoekers bezoeker medewerkers personeel
  collega collegas studenten leerlingen ouders patiënten patienten cliënten clienten kinderen deelnemers kopers volgers fans publiek doelgroep
  customers customer users user myself us members member staff employees clients students patients parents visitors visitor buyers followers audience`);
const PERSON_SUFFIXES = ['klanten', 'gebruikers', 'bezoekers', 'medewerkers', 'leden', 'customers', 'users', 'visitors'];
const AUDIENCE_LEADS = wordSet('voor for zodat naar to');
const CHANGE_VERBS = wordSet('verander veranderen verandert wijzig wijzigen wijzigt update updaten herschrijf herschrijven aanpassen ombouwen edit change modify refactor refactoren rewrite');
const DETERMINERS = wordSet('de het een die deze the a an this that last laatste recente recent vorige');
const BOUNDARY_WORDS = wordSet('niet geen zonder alleen blijft blijven behalve nooit only keep without not never except');
const MIDRUN_PHRASES = ['laat maar', 'eigenlijk', 'toch liever', 'never mind', 'nevermind', 'actually', 'instead'];

// ---- bilingual wording ---------------------------------------------------------------------------------
const ASK_TEXT = {
  nl: {
    label: { clarity: 'duidelijkheid', specificity: 'specificiteit', context: 'context', completeness: 'volledigheid', structure: 'structuur' },
    fix: {
      clarity: "Begin met een concreet werkwoord + wat: bv. 'voeg een zoekveld toe aan …' in plaats van 'maak het beter'.",
      specificity: 'Noem het doel: een bestand, pagina, component, URL of naam.',
      context: "Zeg in welk project of welke stack het zit of wat er al bestaat (bv. 'in de bestaande Astro-site', 'zonder nieuwe dependencies').",
      completeness: "Zeg wanneer het klaar is: 'klaar als …', 'moet kunnen …', een voorbeeld of een meetbaar getal.",
      structure: 'Schrijf minstens één volledige doelzin — geen 1-3 losse woorden en geen lap tekst zonder leestekens.',
    },
    question: {
      specificity: 'Om welk onderdeel gaat het precies — welke pagina, functie, welk bestand of scherm?',
      clarity: 'Wat moet er concreet gebeuren: iets toevoegen, aanpassen, verwijderen of iets nieuws bouwen?',
      completeness: 'Waaraan zie je dat het klaar is — wat moet er na afloop werken of te zien zijn?',
      context: 'In welk project of welke bestaande code moet dit, en is er iets dat niet mag veranderen?',
      structure: 'Kun je in één zin zeggen wat het doel is?',
    },
    assumption: {
      clarity: 'Aanname: het verzoek betekent de meest voor de hand liggende concrete wijziging aan het genoemde onderdeel; Forge noemt die keuze in het rapport.',
      specificity: 'Aanname: Forge kiest het meest voor de hand liggende onderdeel in dit project en noemt die keuze in het rapport.',
      context: 'Aanname: het werk gebeurt in het huidige project, met de bestaande stack en conventies, zonder nieuwe afhankelijkheden.',
      completeness: 'Aanname: klaar = het gevraagde werkt aantoonbaar (build/tests groen, zichtbaar resultaat) zonder bestaande functionaliteit te breken.',
      structure: 'Aanname: het verzoek is gelezen als één doel; bij twijfel kiest Forge de veiligste lezing en benoemt die.',
    },
    verdict: { CLEAR: 'HELDER', OK: 'OK — automatisch aanvullen: ', VAGUE: 'VAAG — stel één vraag over: ' },
    questionLine: 'Vraag aan de eigenaar: ', assumptionsLine: 'Aannames om vast te leggen bij stil doorwerken:', midrun: 'tijdens een run',
  },
  en: {
    label: { clarity: 'clarity', specificity: 'specificity', context: 'context', completeness: 'completeness', structure: 'structure' },
    fix: {
      clarity: "Start with a concrete verb + object, e.g. 'add a search field to …' instead of 'make it better'.",
      specificity: 'Name the target: a file, page, component, URL or name.',
      context: "Say which project or stack it lives in or what already exists (e.g. 'in the existing Astro site', 'no new dependencies').",
      completeness: "Say when it is done: 'done when …', 'should …', an example or a measurable number.",
      structure: 'Write at least one full goal sentence — not 1-3 loose words and not a wall of text without punctuation.',
    },
    question: {
      specificity: 'Which part exactly — which page, feature, file or screen?',
      clarity: 'What should concretely happen: add something, change it, remove it, or build something new?',
      completeness: 'How will you know it is done — what should work or be visible afterwards?',
      context: 'In which project or existing code does this go, and is there anything that must not change?',
      structure: 'Can you say in one sentence what the goal is?',
    },
    assumption: {
      clarity: 'Assumption: the request means the most obvious concrete change to the named part; Forge states that choice in the report.',
      specificity: 'Assumption: Forge picks the most obvious part of this project and states that choice in the report.',
      context: 'Assumption: the work happens in the current project, with the existing stack and conventions, without new dependencies.',
      completeness: 'Assumption: done = the requested thing demonstrably works (build/tests green, visible result) without breaking existing behaviour.',
      structure: 'Assumption: the request is read as one goal; when in doubt Forge picks the safest reading and names it.',
    },
    verdict: { CLEAR: 'CLEAR', OK: 'OK — auto-fill: ', VAGUE: 'VAGUE — ask one question: ' },
    questionLine: 'Question for the owner: ', assumptionsLine: 'Assumptions to record when proceeding silently:', midrun: 'mid-run',
  },
};

// The ONE question per failure mode — skills/forge-prompt-coach/references/failure-modes.md (NL = research §B, EN =
// the skill's translation; {placeholders} filled deterministically). Option A is always the recommended one; every
// question ends with "iets anders / something else" except F8, whose B already is the way out.
const GAP_RANK = ['F13', 'F9', 'F8', 'F5', 'F7', 'F3', 'F4', 'F1', 'F11', 'F10', 'F6', 'F2'];
// The skill's §2 "which gap to ask about" list: F11/F10/F6/F2 have safe defaults and are recorded, never asked.
const ASKABLE = new Set(['F13', 'F9', 'F8', 'F5', 'F7', 'F3', 'F4', 'F1']);
const T2 = (nl, en) => ({ nl, en });
const ELSE_LABEL = T2('iets anders', 'something else');
const GAPS = {
  F1: { q: T2('Wat moet er vooral beter?', 'What should mainly improve?'),
    options: [T2('hoe het eruitziet', 'the look'), T2('hoe snel het laadt', 'speed'), T2('dat meer mensen contact opnemen', 'more people getting in touch')],
    assume: T2('Alleen het uiterlijk; inhoud en structuur blijven ongemoeid; voor/na-screenshots.', 'Only the look; content and structure untouched; before/after screenshots.') },
  F2: { q: T2('Hoe zie jij dat het gelukt is?', 'How will you see it worked?'),
    options: [T2('ik kan een voorbeeld bekijken', 'I can look at a preview'), T2('het werkt met mijn echte gegevens', 'it works with my real data'), T2('het staat online', 'it is online')],
    assume: T2('Een voorbeeld om te beoordelen, niet live.', 'A preview to review, not live.') },
  F3: { q: T2('Wat moet het vooral doen?', 'What should it mainly do?'),
    options: [T2('klanten laten bellen/aanvragen', 'let customers call or send a request'), T2('producten verkopen', 'sell products'), T2('iets voor jezelf automatiseren', 'automate something for yourself')],
    assume: T2('De kleinste demo van de meest gangbare lezing, gelabeld als demo.', 'The smallest demo of the most common reading, labelled as a demo.') },
  F4: { q: T2('Wat moet dit voor jou oplossen?', 'What should this solve for you?'),
    options: [T2('gegevens bewaren die nu kwijtraken', 'keep data that now gets lost'), T2('werk dat je nu met de hand doet', 'work you now do by hand'), T2('klanten sneller helpen', 'help customers faster')],
    assume: T2('Het genoemde hulpmiddel alleen gebruiken als het past; anders een alternatief op basis van de uitkomst voorstellen.', 'Use the named tool only if it fits; otherwise propose an outcome-based alternative.') },
  F5: { q: T2('Waar beginnen we mee? De rest zet ik op de lijst voor later.', "Where do we start? I'll put the rest on the list for later."), options: null,
    assume: T2('Beginnen met het item waar de rest van afhangt, anders het eerstgenoemde; de rest parkeren.', 'Start with the item the rest depends on, else the first one named; park the rest.') },
  F6: { q: T2('Voor wie is het?', 'Who is it for?'),
    options: [T2('je klanten', 'your customers'), T2('alleen jij', 'only you'), T2('je team', 'your team')],
    assume: T2('Publiek werk = klanten, interne tools = de eigenaar; Nederlands, mobiel eerst.', 'Public work = customers, internal tools = the owner; Dutch, mobile first.') },
  F7: { q: T2('Wat is het ÉÉN ding dat als eerste moet werken?', 'What is the ONE thing that must work first?'),
    options: [T2('mensen vinden wat ze zoeken en nemen contact op', 'people find what they need and get in touch'), T2('aanbieders laten zien wat ze bieden', 'providers show what they offer'), T2('boeken en betalen', 'booking and paying')],
    assume: T2('Een klikbare eerste versie met één functie; de rest later.', 'A clickable first version with one function; the rest later.') },
  F8: { q: T2('Bedoel je het huidige project?', 'Do you mean the current project?'), noElse: true,
    options: [T2('ja', 'yes'), T2('iets anders: plak de link', 'something else: paste the link'), T2('nieuw beginnen', 'start fresh')],
    assume: T2('Eén kandidaat in de scan: die gebruiken (de bestaande forge-intake-regel).', 'One scan candidate: use it (the existing forge-intake rule).') },
  F9: { q: T2('Wat zie je gebeuren?', 'What do you see happening?'),
    options: [T2('een foutmelding (plak of screenshot)', 'an error message (paste or screenshot)'), T2('er gebeurt niks als ik klik', 'nothing happens when I click'), T2('het ziet er verkeerd uit', 'it looks wrong')],
    assume: T2('Forge start de app zelf, doet de fout na en bekijkt recente wijzigingen; geen herontwerp.', 'Forge runs the app itself, reproduces the problem and looks at recent changes; no redesign.') },
  F10: { q: T2('Welke stijl past het best? Of stuur een site die je mooi vindt.', 'Which style fits best? Or send a site you like.'),
    options: [T2('rustig en licht', 'calm and light'), T2('donker en strak', 'dark and sleek'), T2('kleurrijk', 'colourful')],
    assume: T2('Een rustige, leesbare standaard plus twee varianten.', 'A calm, readable default plus two variants.') },
  F11: { q: T2('Wat moet zeker hetzelfde blijven?', 'What must definitely stay the same?'),
    options: [T2('teksten en logo', 'texts and logo'), T2('hoe bestellen/inloggen werkt', 'how ordering/logging in works'), T2('niks, alles mag', 'nothing, anything may change')],
    assume: T2('Alleen het genoemde wijzigen; de rest blijft bevroren; eerst een herstelpunt.', 'Change only what was named; the rest is frozen; checkpoint first.') },
  F12: { q: T2('Stoppen met het huidige werk en naar het nieuwe verzoek, of het nieuwe verzoek na het huidige werk?', 'Stop the current work and switch to the new request, or the new request after the current work?'),
    options: [T2('eerst het huidige werk afmaken', 'finish the current work first'), T2('nu naar het nieuwe verzoek', 'switch to the new request now'), T2('het nieuwe verzoek op de lijst', 'put the new request on the list')],
    assume: T2('De huidige run parkeren op een veilig herstelpunt; nooit de twee mengen.', 'Park the current run at a safe checkpoint; never mix the two.') },
  F13: { q: T2('Moet Forge echt versturen, of eerst klaarzetten?', 'Should Forge really send, or prepare it first?'),
    options: [T2('alleen klaarzetten', 'only prepare it'), T2('versturen na mijn OK', 'send after my OK'), T2('automatisch', 'automatically')],
    assume: T2('Alleen concepten; niets onomkeerbaars zonder expliciete bevestiging.', 'Drafts only; nothing irreversible without explicit confirmation.') },
};

// ---- helpers -------------------------------------------------------------------------------------------
function askTokens(text) { return String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []; }
const sentencesOf = (text) => String(text).split(/[.!?\n]+/).map(askTokens);
const isPerson = (w) => PERSON_NOUNS.has(w) || PERSON_SUFFIXES.some((x) => w.length > x.length + 2 && w.endsWith(x));

/** detectAskLang(text) -> 'nl' | 'en' — stop-word vote; a tie goes to Dutch (the owner's language). */
function detectAskLang(text) {
  let nl = 0, en = 0;
  for (const w of askTokens(text)) { if (NL_HINTS.has(w)) nl++; if (EN_HINTS.has(w)) en++; }
  return en > nl ? 'en' : 'nl';
}

function askSignals(text) {
  const tokens = askTokens(text);
  const norm = ' ' + tokens.join(' ') + ' ';
  const has = (p) => norm.includes(' ' + p + ' ');
  let remainder = norm, vagueHits = 0;
  for (const re of VAGUE_RES) remainder = remainder.replace(re, () => { vagueHits++; return ''; });
  const rest = remainder.split(' ').filter(Boolean);
  const concreteVerb = rest.some((w, i) => ACTION_VERBS.has(w) && [rest[i + 1], rest[i - 1]].some((n) => n && !WEAK_NEIGHBOURS.has(n)));
  const paths = [];
  let m;
  ASK_PATH_RE.lastIndex = 0;
  while ((m = ASK_PATH_RE.exec(text)) !== null) if (!AND_OR_RE.test(m[1])) paths.push(m[1]);
  const named = String(text).split(/[.!?\n]+/).some((sentence) => sentence.trim().split(/\s+/).slice(1)
    .map((w) => w.replace(/^[^\p{L}]+|[^\p{L}\p{N}]+$/gu, ''))
    .some((w) => /^[A-Z][a-zÀ-ɏ]/.test(w) && !/^(?:Ik|Je|Jij|We|Wij|I|The|De|Het|Een)$/.test(w)))
    || /\b[A-Z]?[a-z]+[A-Z][A-Za-z]+\b/.test(text) || /["“”`][^"“”`\n]{2,60}["“”`]/.test(text);
  const targetNoun = tokens.some((w) => TARGET_NOUNS.has(w) || (w.endsWith('s') && TARGET_NOUNS.has(w.slice(0, -1)))
    || COMPOUND_SUFFIXES.some((s) => w.length > s.length + 2 && w.endsWith(s)));
  const hasRef = ASK_FILE_RE.test(text) || ASK_URL_RE.test(text) || paths.length > 0;
  const listItems = (String(text).match(/^\s*(?:[-*•]|\d+[.)])\s+\S/gm) || []).length;
  const wordCount = String(text).trim().split(/\s+/).length;
  // gap phrases never match across a sentence end: "…de belknop werkt. Niet: online betalen" is not "werkt niet"
  const sentNorm = ' ' + sentencesOf(text).map((t) => t.join(' ')).filter(Boolean).join(' | ') + ' ';
  return {
    tokens, norm, has, sentNorm, hasS: (p) => sentNorm.includes(' ' + p + ' '), vagueHits, concreteVerb, hasRef, wordCount, listItems,
    target: hasRef || named || targetNoun,
    context: paths.length > 0 || ASK_URL_RE.test(text) || /next\.js|node\.js/i.test(text)
      || tokens.some((w) => TECH_WORDS.has(w) || CONTEXT_WORDS.has(w)) || CONTEXT_PHRASES.some(has),
    done: DONE_PHRASES.some(has) || NUMBER_TOKEN_RE.test(text) || listItems >= 2,
    punctuated: /[.,!?;:](?=\s|$)/.test(text) || /\n/.test(String(text).trim()),
    goal: concreteVerb || vagueHits > 0 || rest.some((w) => ACTION_VERBS.has(w)) || GOAL_PHRASES.some(has),
  };
}

/** F1 "no object, no measure": a vague verb whose own clause names nothing concrete ("maak het beter", "improve it",
 *  "ik wil het verbeteren") — "verbeter de checkout" or "de site beter maken" name an object and do not fire. */
function objectlessVague(tk) {
  const clause = (from, step, max) => {
    const out = [];
    for (let j = from; j >= 0 && j < tk.length && out.length < max; j += step) { if (CLAUSE_BREAK.has(tk[j])) break; out.push(tk[j]); }
    return out;
  };
  return tk.some((w, i) => {
    if (w === 'maak' || w === 'make') {
      const span = clause(i + 1, 1, 7);
      const k = span.findIndex((x) => VAGUE_ADJ.has(x));
      return k >= 0 && span.slice(0, k).every((x) => FILLER.has(x));
    }
    if (VAGUE_VERB_FWD.has(w)) return clause(i + 1, 1, 2).every((x) => FILLER.has(x) || VAGUE_ADJ.has(x));
    if (VAGUE_VERB_BACK.has(w) || (VAGUE_ADJ.has(w) && tk[i + 1] === 'maken')) return clause(i - 1, -1, 3).every((x) => FILLER.has(x));
    return false;
  });
}

function megascope(text, s) {
  if (s.tokens.some((w) => PLATFORM_NAMES.has(w) || w === 'platform') || BOL_RE.test(text) || / net als [^ |]+ maar /.test(s.sentNorm)) return true;
  return sentencesOf(text).some((st) => st.includes('alles') && st.some((w) => SCOPE_NOUNS.has(w)));
}

/** detectGaps(text, signals) -> { found:Set<F-id>, deliverables:[first-mentioned order] } — deterministic. Phrase
 *  checks use the sentence-bounded `hasS`; the dimension signals keep wp6's whole-text `has`. */
function detectGaps(text, s) {
  const tk = s.tokens, has = s.hasS, found = new Set();
  const bug = BUG_PHRASES.some(has);
  if (s.wordCount < 9) found.add('F3');
  if ((s.vagueHits > 0 && !s.concreteVerb && !s.target) || objectlessVague(tk)) found.add('F1');
  if (megascope(text, s)) found.add('F7');
  const deliverables = [];
  tk.forEach((w, i) => { if (DELIVERABLES.includes(w) && !deliverables.some((d) => d.w === w)) deliverables.push({ w, i }); });
  if (deliverables.length >= 2 && tk.slice(deliverables[0].i + 1, deliverables[1].i).some((w) => JOINERS.has(w))) found.add('F5');
  const weerFailure = tk.some((w, i) => w === 'weer' && tk.slice(Math.max(0, i - 2), i + 3).some((x) => FAILURE_VERBS.has(x)));
  if ((ANCHORLESS_REFS.some(has) || weerFailure) && !s.hasRef) found.add('F8');
  const errorText = /\b\w*(?:Error|Exception)\b|["“`][^"”`\n]{4,}["”`]|\bat \S+:\d+/.test(text);
  if (bug && !errorText && !/\b(?:als ik|when i)\b[\s\S]*\b(?:dan|then)\b/i.test(text) && !SYMPTOM_PHRASES.some(has)) found.add('F9');
  if (tk.some((w) => TASTE_WORDS.has(w)) && !REFERENCE_PHRASES.some(has) && !ASK_URL_RE.test(text)) found.add('F10');
  const outward = tk.some((w, i) => OUTWARD_VERBS.has(w) && tk[i - 1] !== 'e' && !tk.slice(Math.max(0, i - 3), i).some((x) => NEGATIONS.has(x)));
  if (outward && !LIMIT_PHRASES.some(has)) found.add('F13');
  if (!(DONE_SIGNALS.some(has) || NUMBER_TOKEN_RE.test(text) || s.listItems >= 2)) found.add('F2');
  const solution = tk.some((w, i) => SOLUTION_WORDS.has(w) && !tk.slice(Math.max(0, i - 2), i).some((x) => CONTEXT_LEADS.has(x)));
  if (solution && !PURPOSE_PHRASES.some(has) && !/ om (?:[^ |]+ ){1,4}te /.test(s.sentNorm)) found.add('F4');
  const audience = tk.some((w, i) => (AUDIENCE_LEADS.has(w) || (w === 'so' && tk[i + 1] === 'that')) && tk.slice(i + 1, i + 5).some(isPerson));
  if (!audience && !s.hasRef && !bug) found.add('F6');
  const change = tk.some((w, i) => CHANGE_VERBS.has(w) && !DETERMINERS.has(tk[i - 1])) || / pas (?:[^ |]+ ){0,5}aan /.test(s.sentNorm);
  const boundary = tk.some((w) => BOUNDARY_WORDS.has(w)) || / laat (?:[^ |]+ ){0,4}staan /.test(s.sentNorm) || has('don t') || has('do not');
  if (change && !boundary) found.add('F11');
  if (MIDRUN_PHRASES.some(has)) found.add('F12');
  return { found, deliverables: deliverables.map((d) => d.w) };
}

function gapQuestion(id, deliverables) {
  const g = GAPS[id];
  const labels = id === 'F5' ? deliverables.slice(0, 3).map((d) => T2(d, d)) : g.options;
  const all = g.noElse ? labels : labels.concat([ELSE_LABEL]);
  return {
    id, nl: g.q.nl, en: g.q.en,
    options: all.map((label, i) => ({ key: 'ABCD'[i], label: T2(label.nl, label.en), recommended: i === 0 })),
    recommended: 'A', assume: T2(g.assume.nl, g.assume.en),
  };
}

/** scoreAsk(text, {lang, midrun}) -> the JSON documented in the header. Pure and deterministic (no clock, no
 *  randomness, no I/O). Throws (err.code EMPTY_REQUEST / BAD_LANG) on an empty request or an unknown lang. The exit
 *  code follows the score verdict only (an F13 question on a CLEAR ask still exits 0). */
function scoreAsk(rawText, opts) {
  const text = String(rawText == null ? '' : rawText);
  const lang = (opts && opts.lang) || detectAskLang(text);
  const midrun = !!(opts && opts.midrun);
  if (!text.trim()) throw Object.assign(new Error('empty request — nothing to score'), { code: 'EMPTY_REQUEST' });
  if (!ASK_TEXT[lang]) throw Object.assign(new Error('unknown --lang "' + lang + '" (use nl or en)'), { code: 'BAD_LANG' });
  const s = askSignals(text);
  const pass = {
    clarity: s.concreteVerb || (s.vagueHits > 0 && s.target),
    specificity: s.target,
    context: s.context,
    completeness: s.done,
    structure: s.wordCount >= 4 && s.goal && !(text.length > 4000 && !/\n/.test(text.trim()) && s.listItems === 0)
      && !(s.wordCount > 40 && !s.punctuated),
  };
  const both = (key, id) => T2(ASK_TEXT.nl[key][id], ASK_TEXT.en[key][id]);
  const dimensions = ASK_DIMENSION_IDS.map((id) => ({ id, pass: pass[id], fix: pass[id] ? null : both('fix', id) }));
  const missing = ASK_DIMENSION_IDS.filter((id) => !pass[id]);
  const passed = ASK_DIMENSION_IDS.length - missing.length;
  const vague = passed <= 2;
  const scan = detectGaps(text, s);
  const rank = midrun ? ['F13', 'F12'].concat(GAP_RANK.slice(1)) : GAP_RANK.concat(['F12']);
  const gaps = rank.filter((id) => scan.found.has(id));
  const top = gaps.find((id) => ASKABLE.has(id) || (id === 'F12' && midrun));
  const nextQuestion = top && (vague || top === 'F13' || top === 'F12') ? gapQuestion(top, scan.deliverables) : null;
  const askAbout = vague && !nextQuestion ? ASK_QUESTION_PRIORITY.find((id) => !pass[id]) : null;
  const verdict = passed === 5 ? 'CLEAR' : vague ? 'VAGUE — ask one question: ' + (nextQuestion ? nextQuestion.id : askAbout)
    : 'OK — auto-fill: ' + missing.join(', ');
  const assumptions = gaps.filter((id) => (id !== 'F12' || midrun) && (!nextQuestion || id !== nextQuestion.id))
    .map((id) => Object.assign({ id }, T2(GAPS[id].assume.nl, GAPS[id].assume.en)))
    .concat(missing.filter((id) => id !== askAbout).map((id) => Object.assign({ id }, both('assumption', id))));
  return {
    score: passed, passed, total: 5, verdict, dimensions, missing, gaps,
    gapDetails: gaps.map((id) => ({ id, midrun: id === 'F12' })), nextQuestion,
    suggested_question: nextQuestion ? T2(nextQuestion.nl, nextQuestion.en) : askAbout ? both('question', askAbout) : null,
    assumptions, lang,
  };
}

function formatAskReport(r) {
  const L = r.lang, T = ASK_TEXT[L];
  const kind = r.verdict === 'CLEAR' ? 'CLEAR' : /^VAGUE/.test(r.verdict) ? 'VAGUE' : 'OK';
  const about = r.verdict.split(': ')[1];
  const tail = kind === 'CLEAR' ? '' : kind === 'VAGUE' ? (T.label[about] || about) : r.missing.map((id) => T.label[id]).join(', ');
  const gapList = r.gaps.map((id) => (id === 'F12' ? id + ' (' + T.midrun + ')' : id)).join(', ');
  const lines = ['forge-promptcheck ask: ' + r.passed + '/' + r.total + ' — ' + T.verdict[kind] + tail + (r.gaps.length ? ' · gaps: ' + gapList : '')];
  for (const d of r.dimensions) lines.push('  ' + (d.pass ? '✓' : '✗') + ' ' + T.label[d.id] + (d.pass ? '' : ' -- ' + d.fix[L]));
  if (r.suggested_question) lines.push(T.questionLine + r.suggested_question[L]);
  if (r.nextQuestion) for (const o of r.nextQuestion.options) lines.push('  ' + o.key + ') ' + o.label[L] + (o.recommended ? ' *' : ''));
  if (r.assumptions.length) { // a gap assumption names its failure mode (skill §5); a dimension one starts with "Aanname:"
    lines.push(T.assumptionsLine);
    for (const a of r.assumptions) lines.push('  - ' + (GAPS[a.id] ? a.id + ': ' : '') + a[L]);
  }
  return lines.join('\n');
}

/** `ask` CLI: exit 0 CLEAR/OK · 3 VAGUE · 2 usage. deps.logRunNote(runId, note, evidence) logs the ONE agent_note. */
function runAsk(argv, deps) {
  const o = { text: [], file: null, json: false, lang: undefined, run: null, midrun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--midrun') o.midrun = true;
    else if (a === '--file') o.file = argv[++i] == null ? '' : argv[i];
    else if (a === '--lang') o.lang = argv[++i] == null ? '' : argv[i];
    else if (a === '--run') o.run = argv[++i];
    else o.text.push(a);
  }
  const usage = (msg) => {
    console.error('forge-promptcheck ask: ' + msg);
    console.error('Usage: node forge-promptcheck.cjs ask "<raw request text>" [--file <path|->] [--json] [--lang nl|en] [--midrun] [--run <run_id>]');
    process.exitCode = 2;
  };
  if (o.file !== null && o.text.length) return usage('give the request inline OR via --file, not both');
  if (o.file === '') return usage('--file needs a path (or - for stdin)');
  if (o.lang !== undefined && o.lang !== 'nl' && o.lang !== 'en') return usage('unknown --lang "' + o.lang + '" (use nl or en)');
  let text = o.text.join(' ');
  if (o.file !== null) {
    try { text = o.file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(o.file, 'utf8'); }
    catch (e) { return usage('could not read --file (' + o.file + '): ' + e.message); }
  }
  let result;
  try { result = scoreAsk(text, { lang: o.lang, midrun: o.midrun }); }
  catch (e) {
    if (e.code === 'EMPTY_REQUEST' || e.code === 'BAD_LANG') return usage(e.message);
    console.error('forge-promptcheck ask: ' + e.message); process.exitCode = 1; return; // a bug, not a usage error — same as the dispatch mode
  }
  console.log(o.json ? JSON.stringify(result) : formatAskReport(result));
  if (o.run && deps && typeof deps.logRunNote === 'function') {
    deps.logRunNote(o.run, 'forge-promptcheck ask: ' + result.passed + '/' + result.total + ' ' + result.verdict, 'raw-request prompt-doctor (deterministic, offline)');
  }
  // review-boss M2 (2026-09-24): exit 3 means "a question is due" — VAGUE, OR an outward/irreversible action (F13) or a
  // mid-run goal change (F12 under --midrun) that must be confirmed even when the request scores CLEAR. forge.md and
  // forge-intake key the ONE allowed owner question on this exit code, so a nextQuestion with exit 0 was never asked.
  process.exitCode = (/^VAGUE/.test(result.verdict) || result.nextQuestion) ? 3 : 0;
}

module.exports = { ASK_DIMENSION_IDS, GAP_RANK, ASKABLE, GAPS, scoreAsk, formatAskReport, detectAskLang, runAsk };
