@echo off
setlocal
title Update Gallery (incremental)

set "BASE=D:\work\workbuddy\2026-10-25-19-09-03"
set "PY=%USERPROFILE%\.workbuddy\binaries\python\versions\3.13.12\python.exe"
set "APP=%BASE%\app"

if not exist "%PY%" (
  echo [ERROR] Python not found: %PY%
  pause
  exit /b 1
)

cd /d "%APP%"

echo ============================================================
echo   Incremental gallery update
echo ============================================================
echo.
echo Scans E:\download\Telegram, adds only what is new:
echo   - new images  -> new thumbnails
echo   - new videos  -> indexed with a video cover
echo   - already-built items are skipped, so this is fast
echo.
echo The running server does NOT need to be restarted.
echo When this finishes, just refresh the page.
echo.
echo (For "thumbnails look wrong" run the full-rebuild script instead -
echo  that one forces a rebuild of every thumbnail.)
echo.
pause

"%PY%" build.py
if errorlevel 1 (
  echo.
  echo [ERROR] build failed. Read the messages above.
  pause
  exit /b 1
)

echo.
echo ============================================================
echo   Done. Refresh the gallery page in your browser / phone.
echo ============================================================
echo.
pause
