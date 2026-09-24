@echo off
REM Weekly full review reconciliation and dashboard rebuild.
setlocal
cd /d "%~dp0.."

set LOGDIR=data\logs
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
for /f %%a in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set TODAY=%%a
set LOG=%LOGDIR%\review-full-%TODAY%.log

echo. >> "%LOG%"
echo ================================================== >> "%LOG%"
powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'" >> "%LOG%"
echo ================================================== >> "%LOG%"

python collect.py --only review_backfill >> "%LOG%" 2>&1
set RC=%ERRORLEVEL%

echo exit_code=%RC% >> "%LOG%"
endlocal & exit /b %RC%
