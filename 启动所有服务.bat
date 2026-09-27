@echo off
chcp 65001 >nul
title dylan-heartbeat 启动器
cd /d %~dp0

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没有检测到 Node.js
  echo 请先去 https://nodejs.org 下载安装 LTS 版本，装完再运行本脚本。
  pause
  exit /b 1
)

if not exist .env (
  echo [提示] 还没有 .env 配置文件，正在从 .env.example 创建...
  copy .env.example .env >nul
  echo.
  echo ============================================================
  echo   已创建 .env，马上会用记事本打开它，请填好这三项后保存：
  echo.
  echo   1. TARGET_API_URL   （DeepSeek 官方：
  echo                         https://api.deepseek.com/chat/completions）
  echo   2. TARGET_API_KEY   （你的 DeepSeek API Key）
  echo   3. MODEL_NAME       （deepseek-chat）
  echo   4. BARK_KEY         （你的 Bark 推送 Key）
  echo   5. ADMIN_PASSWORD   （管理页密码，随便设一个好记的）
  echo.
  echo   保存关闭记事本后，再双击本脚本启动。
  echo ============================================================
  notepad .env
  pause
  exit /b 0
)

if not exist node_modules (
  echo [首次运行] 正在安装依赖，大概一两分钟，请稍等...
  call npm install
  if errorlevel 1 (
    echo [错误] 依赖安装失败，请检查网络后重试
    pause
    exit /b 1
  )
)

echo 正在启动三个服务...
start "Gateway (端口3000)" cmd /k node server.js
timeout /t 2 /nobreak >nul
start "WakeUp 自动唤醒" cmd /k node wake_up.js
timeout /t 2 /nobreak >nul
start "WebChat (端口3001)" cmd /k node webchat-server.js

echo.
echo ============================================================
echo   全部启动完成！弹出的三个黑窗口请不要关闭。
echo.
echo   Gateway ：端口 3000，Kelivo 的 API 地址填这个
echo   WakeUp  ：自动唤醒，想你时 Bark 你的手机
echo   WebChat ：端口 3001，手机浏览器开网页对话
echo.
echo   管理页 ：http://localhost:3000/admin
echo   网页   ：http://localhost:3001/webchat
echo ============================================================
echo.
echo 本窗口现在可以关闭。想停掉所有服务时，关掉那三个黑窗口即可。
pause
