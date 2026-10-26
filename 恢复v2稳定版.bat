@echo off
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\switch-version.ps1" -Target v2
if errorlevel 1 pause
