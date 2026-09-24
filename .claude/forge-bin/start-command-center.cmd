@echo off
rem Start de Forge Command Center supervisor (gateway 127.0.0.1:4100). Gebruikt door de geplande taak
rem "ForgeCommandCenter-Supervisor" (bij inloggen).
rem
rem WAAROM DIT LOSKOPPELT (gemeten 2026-08-02/03). De vorige versie draaide node op de VOORGROND:
rem   "C:\Program Files\nodejs\node.exe" "command-center\gateway\supervisor.mjs" >> log 2>&1
rem Daardoor bleef cmd.exe wachten en hield de TAAK het proces vast. Op 02-08 om 01:16:41 vuurde de taak
rem netjes, de waakvlam startte gateway pid 10128 om 01:16:44 - en acht seconden later was alles weg, met
rem taakresultaat 3221225786 (STATUS_CONTROL_C_EXIT) en een ^C als laatste regel in supervisor-out.log.
rem De autostart STARTTE de dienst dus wel, maar hield hem niet in leven: zodra de console van de taak
rem verdween, kreeg de hele procesgroep CTRL_C.
rem
rem De reparatie: de waakvlam wordt LOSGEKOPPELD gestart en dit script eindigt meteen. De taak is daarmee
rem binnen een seconde "voltooid" en heeft geen console meer die de dienst kan meeslepen. De supervisor
rem heeft zelf een eerlijke EADDRINUSE-stop als er al een gateway draait, dus dubbel starten blijft veilig.
rem
rem LET OP: dit bestand moet PURE ASCII blijven - een em-dash of kaderteken in een rem-regel wordt in de
rem OEM-codepage van cmd.exe verminkt en breekt de regels erna (gemeten 2026-08-01).
setlocal
rem PROJECTROOT UIT EIGEN LOCATIE (fix 2026-08-03, zelfde reden als maand-sweep.cmd): dit bestand leeft
rem in <project>\.claude\forge-bin\, dus de root is twee mappen omhoog. De oude hardgecodeerde
rem owner-machine-cd pinde ELKE kopie (template-sync, ander project, publieke repo) op een pad dat daar
rem fout of onbestaand is - en lekte de gebruikersnaam naar de repo.
for %%I in ("%~dp0..\..") do set "ROOT=%%~fI"
set "NODE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE%" set "NODE=node"
cd /d "%ROOT%"

rem GEEN shell-redirect hier, en dat is een bewuste keuze (gemeten 2026-08-03). Met
rem -RedirectStandardOutput/-RedirectStandardError bleef powershell.exe zelf hangen op de doorgegeven
rem handles, waardoor cmd.exe bleef wachten en dit script alsnog niet terugkeerde - precies het probleem
rem dat het moest oplossen. Nodig is het ook niet: supervisor.mjs schrijft zijn EIGEN log
rem (command-center\gateway\gateway-runtime.log, append) en degradeert eerlijk naar console-logging als
rem dat bestand niet beschikbaar is. Zonder redirect keert Start-Process meteen terug.
rem
rem AUDIT 2026-09-24 (security review LOW #6): NODE en ROOT gingen voorheen als kaal geplakte tekst een
rem SINGLE-QUOTED PowerShell-string in ('%NODE%' / '%ROOT%'). Een aanhalingsteken in het projectpad
rem brak die string open, en een gemanipuleerde mapnaam kon zo PowerShell-code laten uitvoeren. Beide
rem waarden gaan nu via omgevingsvariabelen naar PowerShell; $env:FORGE_CC_NODE / $env:FORGE_CC_ROOT
rem worden als los token uitgelezen, dus spaties EN aanhalingstekens in het pad blijven veilig zonder
rem dat ze ooit als PowerShell-scripttekst worden herlezen.
set "FORGE_CC_NODE=%NODE%"
set "FORGE_CC_ROOT=%ROOT%"
powershell -NoProfile -NonInteractive -Command "Start-Process -FilePath $env:FORGE_CC_NODE -ArgumentList 'command-center\gateway\supervisor.mjs' -WorkingDirectory $env:FORGE_CC_ROOT -WindowStyle Hidden"
set "RC=%ERRORLEVEL%"
endlocal & exit /b %RC%
