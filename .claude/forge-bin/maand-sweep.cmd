@echo off
rem Maandelijkse Claude-nieuws-sweep (owner-besluit 2026-07-31) - draait headless claude -p met de
rem prompt uit maand-sweep-prompt.txt, schrijft het rapport in .claude/forge-research/ en logt naar
rem maand-sweep.log. Geregistreerd als geplande taak "ForgeMaandSweep" (1e van de maand, 09:00).
rem LET OP: dit bestand moet PURE ASCII blijven. Een em-dash of een kaderteken in een rem-regel wordt
rem in de OEM-codepage van cmd.exe verminkt en breekt de parsing van de regels erna (gemeten 2026-08-01:
rem de for/f-regel viel uiteen en FORGE_RUN_CAP bleef leeg zonder dat de guard aansloeg).
rem PROJECTROOT UIT EIGEN LOCATIE (fix 2026-08-03): dit bestand leeft in <project>\.claude\forge-bin\,
rem dus de projectroot is twee mappen omhoog. De oude hardgecodeerde owner-machine-cd pinde ELKE kopie
rem (template-sync, andere projecten, publieke repo) op een pad dat daar fout of onbestaand is.
cd /d "%~dp0..\.."
rem De eerste echte run (2026-08-01 09:00) is op 600 seconden AFGEKAPT voor het rapport: de zoek- en
rem filterbestanden stonden wel in .claude/forge-research/maand-sweep-2026-08/, MAAND-SWEEP-2026-08.md
rem niet. De log meldde letterlijk "Background tasks still running after 600s; terminating."
rem Deze knop laat de headless run op zijn eigen achtergrondtaken wachten in plaats van ze te doden.
set CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0
rem claude-binary: eerst de standaard user-locatie van DEZE machine, anders PATH (fix 2026-08-03:
rem geen hardgecodeerde owner-gebruikersnaam meer — %USERPROFILE% is machineneutraal).
set "CLAUDE_BIN=%USERPROFILE%\.local\bin\claude.exe"
if not exist "%CLAUDE_BIN%" set CLAUDE_BIN=claude
set "PATH=C:\Program Files\nodejs;%PATH%"
set "SWEEP_LOG=.claude\forge-bin\maand-sweep-last.log"
set "FULL_LOG=.claude\forge-bin\maand-sweep.log"

rem KOSTENPLAFOND (owner-besluit 2026-08-01, punt 3).
rem Dit is een ONBEWAAKTE run: niemand kijkt mee terwijl hij draait. forge-cost.cjs meet alleen achteraf
rem en usage-guard.cjs bewaakt het abonnementsvenster, niet deze ene run. Het plafond zelf staat NIET in
rem dit bestand maar in .claude/config/orchestration/FORGE_RUN_BUDGET.json - hier wordt het alleen
rem opgehaald en doorgegeven. De motivatie voor het getal staat in dat configbestand.
rem Eerst de herkomst/motivatie in de log (de tool schrijft die naar stderr), dan het getal zelf ophalen.
node ".claude\forge-bin\forge-run-budget.cjs" cap --wrapper maand-sweep >nul 2>> "%FULL_LOG%"
set "FORGE_RUN_CAP="
for /f "usebackq delims=" %%C in (`node ".claude\forge-bin\forge-run-budget.cjs" cap --wrapper maand-sweep 2^>nul`) do set "FORGE_RUN_CAP=%%C"
if not defined FORGE_RUN_CAP goto :geen_plafond

rem Runmap voor de eindstatus: dezelfde run_id die de prompt zelf gebruikt (forge-maand-sweep-<jjjj-mm>).
for /f "usebackq delims=" %%R in (`node -e "const d=new Date();process.stdout.write('.claude/forge-runs/forge-maand-sweep-'+d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0'))"`) do set "FORGE_RUN_DIR=%%R"

rem --output-format json (owner-besluit 2026-08-01, na de getuige-audit): hierdoor eindigt de run met een
rem JSON-envelope die zijn EIGEN total_cost_usd draagt. Zonder die envelope kon classify alleen op tekst
rem afgaan - en juist deze sweep is een Claude-NIEUWS-sweep, dus dat hij het woord --max-budget-usd in zijn
rem eigen rapport noemt is zijn werk, geen storing. Met de envelope wint de meting van het woord.
type ".claude\forge-bin\maand-sweep-prompt.txt" | "%CLAUDE_BIN%" -p --output-format json --permission-mode bypassPermissions --model sonnet --max-budget-usd %FORGE_RUN_CAP% > "%SWEEP_LOG%" 2>&1
set "SWEEP_EXIT=%ERRORLEVEL%"
type "%SWEEP_LOG%" >> "%FULL_LOG%"

rem EERLIJKE EINDSTATUS.
rem Een run die op zijn plafond stopte is NIET klaar. classify schrijft de uitspraak als regel in de
rem runmap (budget-verdicts.jsonl); forge-verify.cjs leest die en laat zo'n run nooit op 0 eindigen.
rem Alleen de log van DEZE run wordt gelezen, niet de cumulatieve log - anders zou een budgetstop van
rem vorige maand de classificatie van deze maand vervuilen.
rem De log gaat mee als envelope EN als tekst: is het JSON leesbaar, dan telt de meting; is de run halverwege
rem afgebroken en de JSON stuk, dan valt classify terug op de tekstmarker in datzelfde bestand.
node ".claude\forge-bin\forge-run-budget.cjs" classify --run "%FORGE_RUN_DIR%" --wrapper maand-sweep --cap %FORGE_RUN_CAP% --exit %SWEEP_EXIT% --envelope "%SWEEP_LOG%" --log "%SWEEP_LOG%" >> "%FULL_LOG%" 2>&1
set "CLASSIFY_EXIT=%ERRORLEVEL%"

rem EXITCODE VOOR DE TAAKPLANNER (getuige-audit 2026-08-01, punt 4). Hiervoor gaf dit bestand altijd de
rem exitcode van claude terug, dus een run die op zijn plafond stopte terwijl claude zelf 0 gaf, stond in
rem Windows Taakplanner als GESLAAGD. De eerlijke status leefde dan alleen in budget-verdicts.jsonl. Nu
rem wint het oordeel: is de run geen echte voltooiing, dan ziet ook de Taakplanner dat.
if not "%CLASSIFY_EXIT%"=="0" exit /b %CLASSIFY_EXIT%
exit /b %SWEEP_EXIT%

:geen_plafond
rem Geen plafond kunnen bepalen (config weg, kapot, of node onbereikbaar). Een onbewaakte run zonder rem
rem is precies wat dit besluit moest voorkomen, dus hij start niet. Dit is een uitgestelde sweep, geen
rem verloren sweep: de volgende geplande run probeert het opnieuw zodra de config weer leesbaar is.
echo ForgeMaandSweep NIET GESTART: geen kostenplafond kunnen bepalen via forge-run-budget.cjs. >> "%FULL_LOG%"
exit /b 1
