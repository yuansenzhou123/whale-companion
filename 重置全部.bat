@echo off
chcp 65001 >nul 2>nul
cd /d "%~dp0"
echo.
echo   ================================
echo     重置鲸鲸（服务 + 微信桥接）
echo   ================================
echo.
echo [1/4] 停止 8787 端口上的旧服务...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /r /c:":8787 .*LISTENING"') do taskkill /PID %%a /T /F >nul 2>&1
echo [2/4] 停止旧桥接（python）...
taskkill /IM python.exe /F >nul 2>&1
timeout /t 2 /nobreak >nul
echo [3/4] 启动鲸鲸服务...
start "鲸鲸服务" cmd /c powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1"
timeout /t 3 /nobreak >nul
echo [4/4] 启动微信桥接（带自动重启守护）...
start "鲸鲸桥接" cmd /c "%~dp0scripts\bridge_loop.bat"
echo.
echo 完成。浏览器打开 http://127.0.0.1:8787 看看。
timeout /t 3 /nobreak >nul