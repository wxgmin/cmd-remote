@echo off
setlocal
cd /d "%~dp0"

REM Load token from .env
set "TOKEN="
for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
  if "%%a"=="CMD_REMOTE_TOKEN" set "TOKEN=%%b"
)
if not defined TOKEN (
  echo [ERROR] No CMD_REMOTE_TOKEN found in .env
  pause
  exit /b 1
)

echo cmd-remote URLs
echo ================
echo.
echo ON THIS PC:
echo   Chat:      http://localhost:8787/?token=%TOKEN%
echo   Terminal:  http://localhost:8788/?token=%TOKEN%
echo.
echo ON YOUR HOME WIFI (LAN):
for /f "tokens=2 delims=:" %%i in ('ipconfig ^| findstr /c:"IPv4"') do (
  set "IP=%%i"
  call :printlan
)
echo.
echo FROM ANYWHERE (Tailscale):
set "CMDREMOTE_TOKEN=%TOKEN%"
powershell -NoProfile -Command "$ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -like '100.*' } | Select-Object -First 1).IPAddress; if ($ip) { Write-Output ('  Chat:      http://' + $ip + ':8787/?token=' + $env:CMDREMOTE_TOKEN); Write-Output ('  Terminal:  http://' + $ip + ':8788/?token=' + $env:CMDREMOTE_TOKEN) } else { Write-Output '  Tailscale not detected. Make sure the Tailscale app is running and logged in.' }"
echo.
pause
exit /b 0

:printlan
REM Skip Tailscale IPs (100.x) and blank lines; strip any leading space
set "IP=%IP: =%"
if "%IP%"=="" exit /b 0
if "%IP:~0,4%"=="100." exit /b 0
echo   Chat:      http://%IP%:8787/?token=%TOKEN%
echo   Terminal:  http://%IP%:8788/?token=%TOKEN%
exit /b 0
