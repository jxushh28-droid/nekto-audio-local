@echo off
REM nekto-audio — one-time local setup for Windows.
cd /d "%~dp0"
echo Installing Node dependencies...
call npm install
if errorlevel 1 ( echo npm install failed. Is Node 24+ installed? & pause & exit /b 1 )
echo Installing Chrome for Playwright (uses your system Chrome if present)...
call npx playwright install chrome
echo.
echo Done. Now copy .env.example to .env, fill in DISCORD_TOKEN, then run run.bat
pause
