@echo off
chcp 65001 >nul 2>&1
setlocal
cd /d "%~dp0"

set "PY=%USERPROFILE%\.workbuddy\binaries\python\versions\3.13.12\python.exe"

if not exist "tools\cloudflared.exe" (
  echo.
  echo [ERROR] tools\cloudflared.exe not found.
  echo Download it from:
  echo   https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
  echo and put it into the tools\ folder.
  echo.
  pause
  exit /b 1
)

echo ============================================================
echo   Phone access - secure tunnel
echo ============================================================
echo.
echo 1. Make sure the gallery server is running
echo    (double-click the gallery startup .bat in another window).
echo 2. A https://xxxx.trycloudflare.com URL will appear below.
echo 3. On your phone open:  URL + /?t=TOKEN
echo    TOKEN is in .gallery-token.txt (also printed by the server).
echo.
echo    The token is remembered by the phone after the first visit,
echo    so later you can just open the bare URL.
echo.
echo Keep THIS window open - closing it kills the tunnel.
echo ------------------------------------------------------------
echo.

tools\cloudflared.exe tunnel --url http://127.0.0.1:8777 --no-autoupdate

echo.
echo Tunnel stopped.
pause
