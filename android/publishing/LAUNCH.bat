@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0LAUNCH.ps1" %*
set "PWR_EXIT=%ERRORLEVEL%"
if not "%PWR_NO_PAUSE%"=="1" pause
exit /b %PWR_EXIT%
