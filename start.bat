@echo off
chcp 65001 >nul
title Local Judge
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install it from https://nodejs.org/
  pause
  exit /b 1
)

rem Open the browser 1 second later (after the server is up)
start "" /min cmd /c "timeout /t 1 /nobreak >nul & start "" http://localhost:2434"

echo Press Ctrl+C or close this window to stop the server.
echo.
node backend\server.js

echo.
echo Server stopped.
pause
