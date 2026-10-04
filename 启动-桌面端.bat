@echo off
setlocal
chcp 65001 >nul
title Bonfire 桌面端（开发运行）
cd /d "%~dp0"

curl -s -o nul --max-time 2 http://127.0.0.1:8787/api/auth/me
if errorlevel 1 (
  echo.
  echo   提示：http://127.0.0.1:8787 没有响应。
  echo   先启动云盘服务端，或在应用设置里改成你要连的地址。
  echo.
)

if not exist node_modules\electron (
  echo   首次运行：安装依赖
  call npm install
  if errorlevel 1 goto :fail
)

echo   启动桌面端…
npx electron .
goto :eof

:fail
echo   依赖安装失败，检查网络或手动执行 npm install
pause
