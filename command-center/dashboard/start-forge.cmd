@echo off
rem ============================================================================
rem  Forge Workspace launcher (Windows)
rem
rem  Double-click this file. It starts the bridge and the UI in two windows and
rem  opens the browser. A .cmd file is not subject to the PowerShell execution
rem  policy, so it runs even though `npm run ...` is blocked in PowerShell.
rem
rem  Nothing here leaves your machine: the bridge binds 127.0.0.1 only.
rem ============================================================================

setlocal

rem --- Put the portable Node and Git on PATH for these windows ---------------
set "PATH=%LOCALAPPDATA%\Programs\nodejs;%LOCALAPPDATA%\Programs\MinGit\cmd;%PATH%"

set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
set "NPX=%LOCALAPPDATA%\Programs\nodejs\npx.cmd"

if not exist "%NODE%" (
  echo.
  echo   Node was not found at %NODE%
  echo   Cannot start Forge. Re-run the setup that installed the portable Node.
  echo.
  pause
  exit /b 1
)

rem --- Work from the folder this script lives in -----------------------------
cd /d "%~dp0"

echo.
echo   Starting the Forge bridge on 127.0.0.1:4517 ...
start "Forge bridge" cmd /k ""%NODE%" src\bridge\main.ts"

echo   Starting the Forge UI on 127.0.0.1:5173 ...
start "Forge UI" cmd /k ""%NPX%" vite --port 5173"

rem --- Give the UI a moment, then open the browser --------------------------
echo   Waiting for the servers to come up ...
timeout /t 6 /nobreak >nul
start "" "http://127.0.0.1:5173"

echo.
echo   Forge is starting in two windows (Forge bridge / Forge UI).
echo   The browser will open at http://127.0.0.1:5173
echo.
echo   To stop Forge: close both of those windows.
echo.
endlocal
