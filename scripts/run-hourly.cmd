@echo off
REM GamePulse hourly CCU sampling, called by Windows Task Scheduler.
REM
REM ASCII comments only -- see the note in run-daily.cmd.
REM
REM Deliberately separate from run-daily.cmd: this runs 24x a day and must stay
REM light. Three JSON requests, a few seconds; it never touches reviews, news
REM or video stats.

setlocal
cd /d "%~dp0.."

set LOGDIR=data\logs
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
for /f %%a in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM"') do set MONTH=%%a

python collectors\steam_online.py >> "%LOGDIR%\online-%MONTH%.log" 2>&1
endlocal & exit /b %ERRORLEVEL%
