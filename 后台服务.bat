@echo off
rem ============================================================
rem  Photo Gallery - background service launcher
rem
rem  Starts BOTH the local server and the Cloudflare tunnel, so
rem  https://zyzyzy747.ccwu.cc keeps working without keeping any
rem  window open.
rem
rem  Uses ABSOLUTE paths on purpose: this file is meant to be
rem  copied into the Startup folder, where %~dp0 would point at
rem  the Startup directory instead of the project.
rem
rem  To disable auto-start: delete this .bat from
rem    %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
rem ============================================================
setlocal

set "BASE=D:\work\workbuddy\2026-10-25-19-09-03"
set "PY=C:\Users\Administrator\.workbuddy\binaries\python\versions\3.13.12\python.exe"
set "CFG=%USERPROFILE%\.cloudflared\config.yml"

if not exist "%PY%" (
  echo [ERROR] Python not found: %PY% >> "%BASE%\startup-error.log"
  exit /b 1
)
if not exist "%CFG%" (
  echo [ERROR] Tunnel config not found: %CFG% >> "%BASE%\startup-error.log"
  exit /b 1
)

cd /d "%BASE%"

rem --- 1. rebuild index, THEN serve ---
rem  Serial on purpose: if serve.py starts while build.py is still
rem  writing index.final.json, a visitor can read a half-written index.
start "" /min cmd /c ""%PY%" "%BASE%\app\build.py" > "%BASE%\last-build.log" 2>&1 && "%PY%" "%BASE%\app\serve.py" 8777 > "%BASE%\last-serve.log" 2>&1"

rem --- 2. tunnel starts in parallel; cloudflared keeps retrying until
rem        the origin answers, so it is fine that the server is still
rem        building at this point ---
timeout /t 3 /nobreak >nul
start "" /min "%BASE%\tools\cloudflared.exe" tunnel --config "%CFG%" run gallery

exit /b 0
