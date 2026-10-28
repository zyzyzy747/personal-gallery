@echo off
setlocal
title Gallery Server - KEEP THIS WINDOW OPEN

set "BASE=D:\work\workbuddy\2026-10-25-19-09-03"
set "PY=C:\Users\Administrator\.workbuddy\binaries\python\versions\3.13.12\python.exe"
set "APP=%BASE%\app"
set "CF=%BASE%\tools\cloudflared.exe"
set "CFG=C:\Users\Administrator\.cloudflared\config.yml"

if not exist "%PY%" (
  echo [ERROR] Python not found: %PY%
  pause
  exit /b 1
)
if not exist "%CF%" (
  echo [ERROR] cloudflared not found: %CF%
  pause
  exit /b 1
)

echo ============================================================
echo   Restart gallery  (server + cloudflare tunnel)
echo ============================================================
echo.

rem ---------------------------------------------------------------
rem  Two things must run: serve.py on 8777, and cloudflared tunnel.
rem
rem  The server runs in THIS window (foreground) on purpose:
rem  the earlier "start "" /min "python.exe" ..." form let cmd treat
rem  the quoted exe as the window TITLE, so nothing started and no
rem  error appeared. Foreground makes every failure visible.
rem
rem  The tunnel is started with start, but with an explicit title
rem  and an UNQUOTED exe path (it has no spaces) -- that form does
rem  not have the title-vs-program ambiguity.
rem ---------------------------------------------------------------

echo [1/4] Stopping old server...
set "FOUND="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8777" ^| findstr "LISTENING"') do (
  echo       kill PID %%a
  taskkill /F /PID %%a >nul 2>&1
  set "FOUND=1"
)
if not defined FOUND echo       nothing running

echo [2/4] Stopping old tunnel...
taskkill /F /IM cloudflared.exe >nul 2>&1
timeout /t 2 >nul

echo [3/4] Starting tunnel...
start "gallery-tunnel" /min %CF% tunnel --config "%CFG%" run gallery
timeout /t 5 >nul
tasklist /FI "IMAGENAME eq cloudflared.exe" | findstr /I cloudflared >nul
if errorlevel 1 (
  echo       [WARN] tunnel did NOT start - phone access will fail
  echo              check %BASE%\tools\service.log
) else (
  echo       tunnel OK
)

echo [4/4] Starting server in this window...
echo.
echo   ==========================================================
echo    MINIMIZE THIS WINDOW - DO NOT CLOSE IT
echo    Closing it stops the gallery server.
echo    A second window "gallery-tunnel" is also minimized.
echo   ==========================================================
echo.

"%PY%" "%APP%\serve.py" 8777

echo.
echo Server stopped. Tunnel may still be running.
echo.
pause
