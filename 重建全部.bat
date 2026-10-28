@echo off
chcp 65001 >nul 2>&1
setlocal
cd /d "%~dp0app"

set "PY=C:\Users\Administrator\.workbuddy\binaries\python\versions\3.13.12\python.exe"

if not exist "%PY%" (
  echo.
  echo [ERROR] Python not found:
  echo   %PY%
  echo.
  pause
  exit /b 1
)

echo ============================================================
echo   Full rebuild - regenerates ALL thumbnails and shards
echo   Takes about 3-4 minutes for 5292 sets.
echo   Only needed if thumbnails look wrong or you changed
echo   the generation settings. For daily use, run the normal
echo   startup script instead (it updates incrementally).
echo ============================================================
echo.

"%PY%" build.py --force

echo.
echo Done.
pause
