@echo off
setlocal
cd /d "%~dp0"

REM Load token from .env
for /f "tokens=1,* delims==" %%a in (.env) do (
  if "%%a"=="CMD_REMOTE_TOKEN" set TOKEN=%%b
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
  echo   Chat:      http://%%i:8787/?token=%TOKEN%
  echo   Terminal:  http://%%i:8788/?token=%TOKEN%
)
echo.
echo FROM ANYWHERE (Tailscale):
for /f "tokens=2 delims=:" %%i in ('ipconfig ^| findstr /c:"IPv4"') do (
  if "%%i"=="100." echo   (Tailscale IP found)
)
powershell -NoProfile -Command "$ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -like '100.*' } | Select-Object -First 1).IPAddress; if ($ip) { Write-Output ('  Chat:      http://' + $ip + ':8787/?token=' + $env:TOKEN); Write-Output ('  Terminal:  http://' + $ip + ':8788/?token=' + $env:TOKEN) } else { Write-Output '  Tailscale not detected. Make sure the Tailscale app is running.' }"
echo.
pause
