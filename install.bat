@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ============================================================
echo  cmd-remote installer
echo  Runs Command Code from your phone, anywhere.
echo ============================================================
echo.

REM --- Check Node.js ---
where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js is not installed.
  echo Install it from https://nodejs.org (LTS), then re-run this.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node --version') do set NODE_V=%%v
echo [OK] Node.js %NODE_V%

REM --- Check Tailscale ---
if exist "C:\Program Files\Tailscale\tailscale.exe" (
  echo [OK] Tailscale installed
) else (
  echo [WARN] Tailscale not found in Program Files.
  echo   cmd-remote works on your local Wi-Fi without it, but for
  echo   anywhere-access you need Tailscale: https://tailscale.com/download
  echo   Install it, log in, then re-run this installer.
)

REM --- Install dependencies ---
echo.
echo [1/4] Installing dependencies...
call npm install
if errorlevel 1 (
  echo [ERROR] npm install failed.
  pause
  exit /b 1
)
echo [OK] Dependencies installed.

REM --- Create .env with a fresh random token ---
echo.
echo [2/4] Generating access token...
if not exist .env (
  for /f "delims=" %%t in ('node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"') do set TOKEN=%%t
  (
    echo # cmd-remote configuration
    echo CMD_REMOTE_TOKEN=!TOKEN!
  ) > .env
  echo [OK] Token generated and saved to .env
  echo   Your phone URL will include this token - treat it like a password.
) else (
  echo [OK] .env already exists - keeping your existing token.
)

REM --- Fetch Tailscale TLS cert (enables HTTPS + installable app) ---
echo.
echo [3/4] Setting up HTTPS via Tailscale (optional)...
if exist "C:\Program Files\Tailscale\tailscale.exe" (
  node tls-setup.mjs
  if errorlevel 1 (
    echo [WARN] Could not fetch TLS cert. Continuing without HTTPS (LAN-only).
  ) else (
    echo [OK] HTTPS cert ready.
  )
) else (
  echo [SKIP] Tailscale not installed - HTTPS setup skipped.
)

REM --- Firewall (optional, admin) ---
echo.
echo [4/4] Checking Windows Firewall...
netsh advfirewall firewall show rule name="cmd-remote" >nul 2>&1
if errorlevel 1 (
  echo Adding firewall rule for ports 8787/8788 (may ask for admin)...
  powershell -NoProfile -Command "Start-Process -Verb RunAs -Wait -FilePath 'netsh' -ArgumentList 'advfirewall','firewall','add','rule','name=cmd-remote','dir=in','action=allow','protocol=TCP','localport=8787,8788'" 2>nul
)

echo.
echo ============================================================
echo  Installation complete!
echo.
echo  Start the servers with:   start.bat
echo  See your phone URLs with: url.cmd
echo ============================================================
pause
