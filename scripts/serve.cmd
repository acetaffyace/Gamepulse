@echo off
REM Start the GamePulse dashboard and open it in the browser.
REM
REM ASCII comments only -- cmd.exe decodes .cmd with the system ANSI codepage,
REM so UTF-8 Chinese comments come out mangled and get run as commands.
REM
REM Serves the release bundle in dist/ (built by "python -m store.build" or
REM "python collect.py"); the bundle is exactly what GitHub Pages serves.
REM
REM Just double-click this file. Close the window to stop the server.

setlocal
cd /d "%~dp0.."

set PORT=8770
if not "%~1"=="" set PORT=%~1

echo.
echo   GamePulse dashboard
echo   http://127.0.0.1:%PORT%/
echo.
echo   Close this window to stop the server.
echo.

REM Give the server a moment to bind before the browser hits it.
start "" /b cmd /c "timeout /t 2 /nobreak >nul && start http://127.0.0.1:%PORT%/"

if not exist dist\data\manifest.json python -m store.build --no-backup
python -m http.server %PORT% --bind 127.0.0.1 -d dist
endlocal
