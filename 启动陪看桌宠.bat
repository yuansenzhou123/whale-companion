@echo off
chcp 65001 >nul 2>nul
cd /d "%~dp0"
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0scripts\start-companion.ps1"
if errorlevel 1 (
  echo.
  echo Companion startup failed. See data logs, or restart whale server first.
  pause
)
