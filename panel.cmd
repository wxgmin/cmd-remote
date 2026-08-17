@echo off
setlocal
cd /d "%~dp0"

REM Load token from .env
set "TOKEN="
for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
  if "%%a"=="CMD_REMOTE_TOKEN" set "TOKEN=%%b"
)
if not defined TOKEN (
  echo [ERROR] No CMD_REMOTE_TOKEN found in .env - run setup first.
  pause
  exit /b 1
)

start "" "http://localhost:8787/panel?token=%TOKEN%"
