@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo  cmd-remote - Command Code from your phone
echo ============================================
echo.

REM --- Ensure deps are installed ---
if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo npm install failed. Make sure Node.js is installed.
    pause
    exit /b 1
  )
)

REM --- Ensure .env exists ---
if not exist .env (
  echo No .env found. Copying template...
  copy .env.example .env >nul
)

REM --- Try to open the firewall ports (needs admin; may prompt UAC) ---
echo Checking firewall rules...
netsh advfirewall firewall show rule name="cmd-remote" >nul 2>&1
if errorlevel 1 (
  echo Adding firewall rule for ports 8787/8788 (may ask for admin permission)...
  powershell -NoProfile -Command "Start-Process -Verb RunAs -Wait -FilePath 'netsh' -ArgumentList 'advfirewall','firewall','add','rule','name=cmd-remote','dir=in','action=allow','protocol=TCP','localport=8787,8788'" 2>nul
  if not errorlevel 1 (
    echo Firewall rule added.
  ) else (
    echo WARNING: Could not add firewall rule. Run start.bat as Administrator once if your phone cannot connect.
  )
) else (
  echo Firewall rule already exists.
)

echo.
echo Starting servers...
echo  - Chat proxy on port 8787
echo  - Full terminal on port 8788
echo.
echo Open the URLs shown below on your phone (same Wi-Fi).
echo Press Ctrl+C to stop both.
echo.

start "cmd-remote-chat" cmd /c node server.js
start "cmd-remote-tty" cmd /c node tty-server.mjs

echo Both servers started in separate windows.
echo Chat:      http://localhost:8787
echo Terminal:  http://localhost:8788
echo.
echo Keep this window open, or close it - servers run independently.
pause
