@echo off
chcp 65001 >nul 2>&1
setlocal
cd /d "%~dp0app"

set "PY=%USERPROFILE%\.workbuddy\binaries\python\versions\3.13.12\python.exe"

if not exist "%PY%" (
  echo.
  echo [ERROR] Python not found:
  echo   %PY%
  echo.
  pause
  exit /b 1
)

echo ============================================================
echo   Photo Gallery - starting
echo ============================================================
echo.

"%PY%" build.py
if errorlevel 1 (
  echo.
  echo [ERROR] Index build failed. Check messages above.
  pause
  exit /b 1
)

echo.
echo ------------------------------------------------------------
echo Launching local server, browser will open automatically.
echo Close this window to stop the server.
echo ------------------------------------------------------------
echo.

"%PY%" serve.py 8777 --open

echo.
echo Server stopped.
pause
