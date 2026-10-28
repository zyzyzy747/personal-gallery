@echo off
setlocal
title Update Novel List

set "PY=%USERPROFILE%\.workbuddy\binaries\python\versions\3.13.12\python.exe"
set "APP=D:\work\workbuddy\2026-10-25-19-09-03\app"

if not exist "%PY%" (
  echo [ERROR] Python not found: %PY%
  pause
  exit /b 1
)

echo Updating novel list from E:\Download\novel_download ...
echo.
"%PY%" "%APP%\build.py" --novels
echo.
echo Done. Refresh the gallery page to see the changes.
echo.
timeout /t 4 >nul
