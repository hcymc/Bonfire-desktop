@echo off
setlocal
chcp 65001 >nul
title 打包 Bonfire 桌面端 exe
cd /d "%~dp0"

if not exist node_modules\electron (
  echo   首次运行：安装依赖
  call npm install
  if errorlevel 1 goto :fail
)

echo   跑单元测试
call npm test
if errorlevel 1 goto :fail

echo.
echo   打包 Windows x64 + ARM64（安装包 + 免安装 zip）
call npm run dist
if errorlevel 1 goto :fail

echo.
echo   产物在 dist\ 目录：
dir /b dist\*.exe dist\*-portable.zip
goto :eof

:fail
echo   失败，见上面的报错。
pause
