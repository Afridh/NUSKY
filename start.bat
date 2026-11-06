@echo off
title Nusky Jewellers POS
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed on this computer.
  echo Install the LTS version from https://nodejs.org and run this file again.
  pause
  exit /b 1
)
node --disable-warning=ExperimentalWarning server.js
pause
