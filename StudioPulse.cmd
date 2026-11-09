@echo off
rem StudioPulse: dasbor YouTube multi-channel lokal -> http://127.0.0.1:8765
setlocal
cd /d "%~dp0"
set "VENV=%~dp0Tools\youtube\.venv"
set "PY=%VENV%\Scripts\python.exe"
if exist "%VENV%\.installed" goto run

echo Menyiapkan StudioPulse untuk pertama kali (1-3 menit)...
if not exist "%PY%" (
  where py >nul 2>nul && py -3 -m venv "%VENV%"
  if not exist "%PY%" python -m venv "%VENV%"
)
if not exist "%PY%" (
  echo.
  echo Python 3.10 atau lebih baru belum terpasang.
  echo Pasang dari https://www.python.org/downloads/ ^(centang "Add python.exe to PATH"^), lalu jalankan file ini lagi.
  pause
  exit /b 1
)
"%PY%" -m pip install --disable-pip-version-check -q -r "%~dp0requirements.txt"
if errorlevel 1 (
  echo.
  echo Gagal memasang dependensi. Periksa koneksi internet, lalu jalankan file ini lagi.
  pause
  exit /b 1
)
echo ok> "%VENV%\.installed"

:run
echo StudioPulse (C) 2026 FenomanSKY - perangkat lunak bebas, lisensi GNU GPL v3, TANPA JAMINAN. Lihat file LICENSE.
echo StudioPulse berjalan. Biarkan jendela ini terbuka; tutup jendela ini untuk menghentikan dasbor.
"%PY%" -I "%~dp0Tools\dashboard\server.py" %*
if errorlevel 1 pause
