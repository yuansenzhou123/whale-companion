@echo off
chcp 65001 >nul 2>nul
cd /d "%~dp0"
rem 优先用包里自带的 Python（解压即用，不需要用户装）
set "PY=%~dp0runtime\python\python.exe"
if not exist "%PY%" set "PY=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if not exist "%PY%" set "PY=python"

where python >nul 2>nul
if errorlevel 1 if /i "%PY%"=="python" (
  echo   [!] 没找到 Python，也没有 Python 运行环境。
  echo       装一下 Python 3.12: https://www.python.org/downloads/  （安装时勾选 Add to PATH）
  echo       装完再双击这个文件。
  pause
  exit /b 1
)

rem 本机代理没开时，残留的 HTTPS_PROXY 会让语音/识别请求连不上；模型和国内站点不需要代理
set "HTTP_PROXY="
set "HTTPS_PROXY="
set "ALL_PROXY="
set "http_proxy="
set "https_proxy="
set "all_proxy="

rem 手动启动 = 明确要跑，清掉「一键终止」留下的暂停标记
if exist "data\PAUSED" del /q "data\PAUSED" >nul 2>&1

echo.
echo   ==========================================
echo     Jingjing - WeChat 4.x bridge
echo   ==========================================
echo.
echo   Need: WeChat 4.x is running AND logged in.
echo   Need: whale server is running (launch the other bat first).
echo.
echo   Press Ctrl+C to stop.
echo.
echo   Python: %PY%
echo.

set "CRASH_RETRIES=0"
:run_bridge
if exist "data\PAUSED" goto bridge_paused
"%PY%" -u "%~dp0examples\wechatauto_bridge.py"
set "CODE=%ERRORLEVEL%"
echo.
echo Bridge exited with code %CODE%.
echo Log file: data\wechat-bridge-4x.log
rem 访问冲突及发送看门狗退出可恢复；普通退出和 Ctrl+C 不重新启动。
if "%CODE%"=="-1073741819" goto bridge_crashed
if "%CODE%"=="2" goto bridge_crashed
if "%CODE%"=="0" exit /b 0
pause >nul
exit /b %CODE%

:bridge_crashed
if exist "data\PAUSED" goto bridge_paused
if %CRASH_RETRIES% GEQ 3 (
  echo Automatic recovery limit reached. Please check the crash log.
  pause >nul
  exit /b %CODE%
)
set /a CRASH_RETRIES+=1 >nul
set /a RETRY_SECONDS=CRASH_RETRIES*5 >nul
echo Recovering bridge in %RETRY_SECONDS% seconds. Retry %CRASH_RETRIES%/3.
timeout /t %RETRY_SECONDS% /nobreak >nul
goto run_bridge

:bridge_paused
echo Bridge is paused. Automatic recovery stopped.
exit /b 0
