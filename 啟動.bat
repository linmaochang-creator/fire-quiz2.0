@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在啟動防火安全互動搶答...
node server.js
echo.
echo 程式已結束，按任意鍵關閉視窗。
pause >nul
