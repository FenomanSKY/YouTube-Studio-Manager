@echo off
rem YouTube Studio Manager: local multi-channel YouTube dashboard -> http://127.0.0.1:8765
setlocal
cd /d "%~dp0"
set "VENV=%~dp0Tools\youtube\.venv"
set "PY=%VENV%\Scripts\python.exe"
if exist "%VENV%\.installed" goto run

echo Setting up YouTube Studio Manager for the first time (1-3 minutes)...
if not exist "%PY%" (
  where py >nul 2>nul && py -3 -m venv "%VENV%"
  if not exist "%PY%" python -m venv "%VENV%"
)
if not exist "%PY%" (
  echo.
  echo Python 3.10 or newer is not installed.
  echo Install it from https://www.python.org/downloads/ ^(tick "Add python.exe to PATH"^), then run this file again.
  pause
  exit /b 1
)
"%PY%" -m pip install --disable-pip-version-check -q -r "%~dp0requirements.txt"
if errorlevel 1 (
  echo.
  echo Installing the dependencies failed. Check your internet connection, then run this file again.
  pause
  exit /b 1
)
echo ok> "%VENV%\.installed"

:run
echo YouTube Studio Manager (C) 2026 FenomanSKY - MIT License, WITHOUT ANY WARRANTY. See LICENSE.
echo YouTube Studio Manager is running. Keep this window open; close it to stop the dashboard.
"%PY%" -I "%~dp0Tools\dashboard\server.py" %*
if errorlevel 1 pause
