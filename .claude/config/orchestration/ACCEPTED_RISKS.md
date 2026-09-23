# ACCEPTED RISKS — door de owner expliciet geaccepteerde restrisico's

> Owner-besluit 2026-08-07 (Optie C, hybride afronding). Dit register is de formele grens waartegen
> toekomstige reviews (Codex r6+) horen te toetsen: een bevinding die exact een hieronder geaccepteerd
> restrisico herbeschrijft is GEEN open actionable finding — een bevinding die aantoont dat de
> detectie/recovery hieronder NIET werkt zoals beschreven, is dat WEL. Acceptatie is voorwaardelijk:
> "mits alle recoverypaden fail-closed blijven" — de genoemde tests bewaken die voorwaarde permanent.

## AR-1 · Directory-fsync / write-all op Windows (Codex r5 #2-rest)
- **Risico:** Node exposeert geen directory-fsync op Windows; een power loss direct na een rename kan
  de directory-entry van een net-geschreven WAL/receipt verliezen terwijl de data-bytes al bestaan.
  `fs.writeSync` met een volledige buffer kan theoretisch short-writen.
- **Impact:** een verloren WAL-entry = de append is nooit gebeurd (log intact, caller ziet een fout of
  retry't); een verloren receipt-entry = de run leest als NOT_FINALIZED en kan bewust opnieuw worden
  gefinaliseerd. Nooit een corrupte of half-geloofde staat.
- **Detectie:** `readEventsClassified` (partial/corrupt), WAL-recovery bij de volgende lock-houder,
  `forge-finalize check` (NOT_FINALIZED/STALE) — allemaal fail-closed en getest
  (log-event-concurrency §6, forge-finalize.test §3/§5).
- **Recovery:** WAL-replay (truncate-naar-base + her-append) of bewuste herfinalizatie; nooit stil.
- **Rationale disproportionaliteit:** dir-fsync vergt native code; ENOSPC throwt (gevangen); het
  scenario vergt een power loss in een sub-ms-venster op een single-user-laptop met journaling-NTFS.
- **Voorwaarde:** elk recoverypad blijft fail-closed. Verandert een writer dit, dan VERVALT de acceptatie.

## AR-2 · Pauzeren blijft primair bij journal-falen (Codex r5 #18-rest)
- **Risico:** slaagt de pause-API maar faalt de (gefsyncte) journal-write, dan kan een crash daarna de
  compensatie-informatie voor die pauzeronde missen.
- **Impact:** een agent kan gepauzeerd achterblijven tot handmatige of state-gedreven resume.
- **Detectie:** de state-file (`pausedAgents`) is het tweede, onafhankelijke record; de log draagt de
  expliciete regel "paused-journal write failed (resume must then rely on state alone)"; de
  reconciliatiepass in elke ok-tick hervat alles wat state óf journal nog kent.
- **Recovery:** doResume unie(state, journal); tick-reconciliatie; handmatig `resume` via de CLI.
- **Rationale:** de pauze is de veiligheidsactie (usage-overrun voorkomen weegt zwaarder dan perfecte
  compensatie-administratie). Een guard die weigert te pauzeren omdat zijn logboek hapert, beschermt
  het verkeerde belang. Owner-akkoord: pauzeren blijft de primaire actie.

## AR-3 · Eén diagnostische logregel verlies bij rotatie (Codex r5 #23)
- **Risico:** een regel die tussen `copyFileSync` en `truncateSync` wordt geappend staat in geen van
  beide generaties.
- **Impact:** maximaal één regel diagnose-tekst; NOOIT bewijsdata (events lopen via de WAL-keten, niet
  via dit log).
- **Detectie:** n.v.t. (diagnoselog); de rotatie zelf is gelockt en getest (usage-guard H4 #20).
- **Recovery:** geen nodig — het actieve log blijft geldig en alle open fd's blijven erop schrijven.
- **Rationale:** elke `log()`-aanroep cross-proces locken introduceert contention op het hete pad van
  álle guard-processen om één diagnostische regel te redden — disproportioneel.

## AR-4 · `watch --once` niet achter de watcher-mutex (Codex r5 #19-rest)
- **Risico:** een `--once`-tick kan parallel aan de singleton-watcher draaien en state/journal-writes
  interleaven.
- **Impact:** begrensd door de reeds gebouwde ordes: journal-appends zijn gelockt+gefsynct,
  generatie-administratie is per pauseId (een oude resolve maskeert nooit een nieuwe pauze), de
  account-gate verwerpt inconsistente metingen.
- **Detectie:** journal-generaties + `lastError`-sporen in de state; de H4-suite test de
  generatie-semantiek expliciet.
- **Recovery:** tick-reconciliatie hervat elke onopgeloste generatie.
- **Rationale:** `--once` is het hook-/diagnosepad; het achter de watcher-mutex zetten laat een hook
  hangen op een wedged watcher — precies de silent-death-klasse die eerder is bestreden.

---
*Vastgelegd door Forge op owner-instructie (Optie C). Wijzigingen aan dit register zijn een
owner-besluit.*
