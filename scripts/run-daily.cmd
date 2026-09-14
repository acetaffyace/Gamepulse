@echo off
REM GamePulse daily collection, called by Windows Task Scheduler.
REM
REM Comments here are ASCII on purpose: cmd.exe decodes .cmd files with the
REM system ANSI codepage (GBK on a Chinese Windows), so UTF-8 Chinese comments
REM come out mangled and cmd then tries to execute the garbage as a command.
REM The Chinese rationale lives in scripts/register-tasks.ps1 and README.md.
REM
REM Task Scheduler inherits neither your shell's cwd nor its env vars, so the
REM working directory is set explicitly and output is appended to a dated log.
REM Failures are not surfaced as popups; the exit code goes into the log and
REM the dashboard's freshness banner is what actually tells you something broke.

setlocal
cd /d "%~dp0.."

set LOGDIR=data\logs
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
for /f %%a in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set TODAY=%%a
set LOG=%LOGDIR%\daily-%TODAY%.log

echo. >> "%LOG%"
echo ================================================== >> "%LOG%"
powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss'" >> "%LOG%"
echo ================================================== >> "%LOG%"

python collect.py >> "%LOG%" 2>&1
set RC=%ERRORLEVEL%

python pipeline\build_dashboard_config.py >> "%LOG%" 2>&1

echo exit_code=%RC% >> "%LOG%"
endlocal & exit /b %RC%
