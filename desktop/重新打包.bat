@echo off
chcp 65001 >nul
title 书海 · 重新打包桌面版
echo 正在把 阅读\阅读 里的源码重新打包成 dist\书海 ...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1" %*
echo.
pause
