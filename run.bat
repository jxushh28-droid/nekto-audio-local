@echo off
REM nekto-audio — local Windows launcher.
REM First time only: run  setup.bat  (installs deps + Chrome).
cd /d "%~dp0"
if not exist ".env" (
  echo No .env found. Copy .env.example to .env and fill in DISCORD_TOKEN first.
  pause
  exit /b 1
)
echo Starting nekto-audio locally... control panel at http://localhost:3000
call npm run start:local
pause
