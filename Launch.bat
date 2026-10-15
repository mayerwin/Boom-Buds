@echo off
rem Boom Buds on this computer: double-click this file. It installs what the game needs (first launch only),
rem builds it, starts a small local server and opens your browser. Close the window to stop.
rem   Launch.bat dev        development server with live reload
rem   Launch.bat --rebuild  build again even if nothing changed
setlocal
cd /d "%~dp0"
title Boom Buds

where node >nul 2>nul
if errorlevel 1 goto nonode
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)"
if errorlevel 1 goto oldnode

set ARGS=%*
if /i "%~1"=="dev" set ARGS=--dev
node tools\launch.ts %ARGS%
if errorlevel 1 goto failed
exit /b 0

:nonode
echo Boom Buds needs Node.js 22.18 or newer. Install it from https://nodejs.org (the LTS version is fine),
echo then double-click Launch.bat again.
start "" https://nodejs.org/
pause
exit /b 1

:oldnode
for /f %%v in ('node -v') do set NODEV=%%v
echo Boom Buds needs Node.js 22.18 or newer; this computer has %NODEV%.
echo Install the current LTS version from https://nodejs.org, then double-click Launch.bat again.
start "" https://nodejs.org/
pause
exit /b 1

:failed
echo.
echo Boom Buds stopped with an error (see the messages above).
pause
exit /b 1
