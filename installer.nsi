; cmd-remote Windows installer
; Build: makensis installer.nsi
; Produces: CmdRemote-Setup.exe

Unicode true
!include "MUI2.nsh"
!include "FileFunc.nsh"

; ---------- Metadata ----------
!define APPNAME "Cmd Remote"
!define COMPANY "CmdRemote"
!define VERSION "1.0.0"
!define REGKEY "Software\${COMPANY}\${APPNAME}"

Name "${APPNAME}"
OutFile "CmdRemote-Setup-${VERSION}.exe"
InstallDir "$LOCALAPPDATA\CmdRemote"
RequestExecutionLevel user
SetCompressor /SOLID lzma

; ---------- Modern UI ----------
!define MUI_ABORTWARNING
!define MUI_ICON "icon.ico"
!define MUI_UNICON "icon.ico"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; ---------- Sections ----------
Section "Install"
  SetOutPath "$INSTDIR"

  ; Core server files
  File "server.js"
  File "tty-server.mjs"
  File "setup.mjs"
  File "tls-setup.mjs"
  File "package.json"
  File "package-lock.json"
  File "start.bat"
  File "install.bat"
  File "url.cmd"
  File "AGENTS.md"
  File "README.md"
  File ".env.example"

  ; lib + public + scripts
  SetOutPath "$INSTDIR\lib"
  File "lib\util.mjs"

  SetOutPath "$INSTDIR\public"
  File /r "public\*.*"

  SetOutPath "$INSTDIR\scripts"
  File "scripts\make-icons.mjs"

  ; App icon
  File "icon.ico"

  ; ---------- Tailscale pre-check (warn only) ----------
  IfFileExists "C:\Program Files\Tailscale\tailscale.exe" tailscale_ok
  MessageBox MB_OK|MB_ICONINFORMATION "Tip: install Tailscale (https://tailscale.com/download) to access Cmd Remote from anywhere. Without it, the phone must be on the same Wi-Fi. Setup will continue either way."
  tailscale_ok:

  ; ---------- Node.js check / install ----------
  IfFileExists "$PROGRAMFILES64\nodejs\node.exe" node_found
  IfFileExists "$PROGRAMFILES32\nodejs\node.exe" node_found
  IfFileExists "$LOCALAPPDATA\Programs\nodejs\node.exe" node_found
  ; Also check PATH (via where) for portable installs
  nsExec::ExecToStack 'where node'
  Pop $0
  Pop $1
  StrCmp $0 0 node_found

  ; Node not found - try winget (best effort, then tell user)
  MessageBox MB_YESNO|MB_ICONEXCLAMATION "Node.js was not found. Cmd Remote needs Node.js 18+.$\n$\nInstall Node.js now (downloads from nodejs.org via winget)?$\n(If you already installed it, choose No and restart this installer.)" IDYES install_node IDNO node_missing
  install_node:
    nsExec::ExecToStack '"$SYSDIR\winget.exe" install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent'
    Pop $0
    ; Re-check after install
    IfFileExists "$PROGRAMFILES64\nodejs\node.exe" node_found
    IfFileExists "$LOCALAPPDATA\Programs\nodejs\node.exe" node_found
    nsExec::ExecToStack 'where node'
    Pop $0
    Pop $1
    StrCmp $0 0 node_found
    Goto node_still_missing

  node_missing:
  node_still_missing:
    MessageBox MB_OK|MB_ICONSTOP "Node.js is required. Please install it from https://nodejs.org (LTS), then run this installer again."
    Quit

  node_found:
    ; ---------- Run setup (installs deps, generates token, starts servers) ----------
    ; We run it via a hidden console window so the user sees progress.
    nsExec::ExecToLog '"$SYSDIR\cmd.exe" /c "cd /d ""$INSTDIR"" && node setup.mjs"'
    Pop $0

    ; ---------- Shortcuts ----------
    CreateDirectory "$SMPROGRAMS\Cmd Remote"
    CreateShortcut "$SMPROGRAMS\Cmd Remote\Start Cmd Remote.lnk" "$INSTDIR\start.bat" "" "$INSTDIR\start.bat" 0 SW_SHOWNORMAL "" "Start the Cmd Remote servers"
    CreateShortcut "$SMPROGRAMS\Cmd Remote\Show Phone URLs.lnk" "$INSTDIR\url.cmd" "" "$INSTDIR\url.cmd" 0 SW_SHOWNORMAL "" "Print all phone URLs"
    CreateShortcut "$SMPROGRAMS\Cmd Remote\Uninstall.lnk" "$INSTDIR\uninstall.exe"
    CreateShortcut "$DESKTOP\Cmd Remote.lnk" "$INSTDIR\start.bat" "" "$INSTDIR\start.bat" 0 SW_SHOWNORMAL "" "Start the Cmd Remote servers"

    ; ---------- Registry (uninstall entry) ----------
    WriteRegStr HKCU "${REGKEY}" "InstallDir" "$INSTDIR"
    WriteUninstaller "$INSTDIR\uninstall.exe"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CmdRemote" "DisplayName" "Cmd Remote"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CmdRemote" "DisplayVersion" "${VERSION}"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CmdRemote" "Publisher" "${COMPANY}"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CmdRemote" "UninstallString" '"$INSTDIR\uninstall.exe"'
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CmdRemote" "InstallLocation" "$INSTDIR"

    ; Open the folder + show the phone URL after install
    ExecShell "open" "$INSTDIR"
SectionEnd

Section "Uninstall"
  Delete "$INSTDIR\uninstall.exe"
  RMDir /r "$INSTDIR"
  Delete "$SMPROGRAMS\Cmd Remote\Start Cmd Remote.lnk"
  Delete "$SMPROGRAMS\Cmd Remote\Show Phone URLs.lnk"
  Delete "$SMPROGRAMS\Cmd Remote\Uninstall.lnk"
  RMDir "$SMPROGRAMS\Cmd Remote"
  Delete "$DESKTOP\Cmd Remote.lnk"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CmdRemote"
  DeleteRegKey HKCU "${REGKEY}"
SectionEnd
