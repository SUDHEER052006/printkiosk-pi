@echo off
REM Starts the print station agent: takes jobs from the cloud and prints them here.
REM   run-agent.bat                                     (reads CLOUD_URL + AGENT_TOKEN from .env)
REM   run-agent.bat https://your-app.onrender.com TOKEN
REM   run-agent.bat https://your-app.onrender.com TOKEN "Canon MF240"
setlocal
cd /d "%~dp0"

where node >nul 2>nul || (echo Node 18+ is required. Install it, then run this again. & pause & exit /b 1)

set ARGS=
if not "%~1"=="" set ARGS=%ARGS% --server %1
if not "%~2"=="" set ARGS=%ARGS% --token %2
if not "%~3"=="" set ARGS=%ARGS% --printer %3

echo Available print queues on this machine:
node scripts\list-printers.js
echo.

node agent.js%ARGS%
pause
