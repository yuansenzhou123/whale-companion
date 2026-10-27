@echo off
chcp 65001 >nul 2>nul
cd /d "%~dp0.."
set "PY=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if not exist "%PY%" set "PY=python"
:loop
if exist "data\WECHAT_STOPPED" exit /b 0
if exist "data\PAUSED" (
  timeout /t 5 /nobreak >nul
  goto loop
)
echo.
echo [%date% %time%] 启动微信桥接…
"%PY%" -u "examples\wechatauto_bridge.py"
echo [%date% %time%] 桥接退出（code=%ERRORLEVEL%），3 秒后自动重启…
timeout /t 3 /nobreak >nul
goto loop