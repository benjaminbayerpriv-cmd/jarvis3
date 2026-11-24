@echo off
cd /d "%~dp0"
where py >nul 2>&1
if %errorlevel%==0 (
  py -3 tools\jarvis-manager\manager.py
) else (
  python tools\jarvis-manager\manager.py
)
if errorlevel 1 (
  echo Python 3 fehlt oder der Manager konnte nicht gestartet werden.
  pause
)
