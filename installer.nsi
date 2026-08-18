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

; Shortcut options page (custom)
!define MUI_PAGE_CUSTOMFUNCTION_SHOW shortcuts_show
Page custom shortcuts_create shortcuts_leave

!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\CmdRemoteApp.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Open Cmd Remote now"
!define MUI_FINISHPAGE_RUN_CHECKED
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

Var ShortcutsDesktop
Var ShortcutsStartMenu
Var ShortcutsAutostart

Function shortcuts_create
  !insertmacro MUI_HEADER_TEXT "Create shortcuts" "Choose where Cmd Remote shortcuts appear."
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 24u "Choose where to create shortcuts for Cmd Remote:"
  ${NSD_CreateCheckBox} 0 40u 100% 14u "&Desktop shortcut"
    Pop $ShortcutsDesktop
    ${NSD_Check} $ShortcutsDesktop
  ${NSD_CreateCheckBox} 0 62u 100% 14u "&Start Menu shortcut"
    Pop $ShortcutsStartMenu
    ${NSD_Check} $ShortcutsStartMenu
  ${NSD_CreateCheckBox} 0 84u 100% 14u "&Start automatically when I log in"
    Pop $ShortcutsAutostart
  ${NSD_CreateLabel} 0 110u 100% 30u "The desktop app lets you start/stop the servers, open the Control Panel (QR code, token) and copy the phone URL."
  nsDialogs::Show
FunctionEnd

Function shortcuts_show
  ${NSD_Uncheck} $ShortcutsAutostart
FunctionEnd

Function shortcuts_leave
FunctionEnd

; ---------- Sections ----------
Section "Install"
  SetOutPath "$INSTDIR"

  ; Core server files
  File "server.js"
  File "tty-server.mjs"
  File "browser-server.mjs"
  File "setup.mjs"
  File "tls-setup.mjs"
  File "package.json"
  File "package-lock.json"
  File "start.bat"
  File "install.bat"
  File "url.cmd"
  File "panel.cmd"
  File "AGENTS.md"
  File "README.md"
  File ".env.example"
  File "CmdRemoteApp.exe"

  ; lib + public + scripts
  SetOutPath "$INSTDIR\lib"
  File "lib\util.mjs"
  File "lib\fs-api.mjs"

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

    ; ---------- Shortcuts (from the options page) ----------
    ${If} $ShortcutsStartMenu == ${BST_CHECKED}
      CreateDirectory "$SMPROGRAMS\Cmd Remote"
      CreateShortcut "$SMPROGRAMS\Cmd Remote\Cmd Remote.lnk" "$INSTDIR\CmdRemoteApp.exe" "" "$INSTDIR\CmdRemoteApp.exe" 0 SW_SHOWNORMAL "" "Open the Cmd Remote app"
      CreateShortcut "$SMPROGRAMS\Cmd Remote\Cmd Remote Control Panel.lnk" "$INSTDIR\panel.cmd" "" "$INSTDIR\panel.cmd" 0 SW_SHOWNORMAL "" "Open the control panel with server address, token and QR"
      CreateShortcut "$SMPROGRAMS\Cmd Remote\Uninstall.lnk" "$INSTDIR\uninstall.exe"
    ${EndIf}
    ${If} $ShortcutsDesktop == ${BST_CHECKED}
      CreateShortcut "$DESKTOP\Cmd Remote.lnk" "$INSTDIR\CmdRemoteApp.exe" "" "$INSTDIR\CmdRemoteApp.exe" 0 SW_SHOWNORMAL "" "Open the Cmd Remote app"
      CreateShortcut "$DESKTOP\Cmd Remote Control Panel.lnk" "$INSTDIR\panel.cmd" "" "$INSTDIR\panel.cmd" 0 SW_SHOWNORMAL "" "Open the control panel with server address, token and QR"
    ${EndIf}
    ${If} $ShortcutsAutostart == ${BST_CHECKED}
      CreateDirectory "$SMPROGRAMS\Cmd Remote"
      CreateShortcut "$SMSTARTUP\Cmd Remote.lnk" "$INSTDIR\CmdRemoteApp.exe" "" "$INSTDIR\CmdRemoteApp.exe" 0 SW_SHOWNORMAL "" "Open the Cmd Remote app"
    ${EndIf}

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
  Delete "$SMPROGRAMS\Cmd Remote\Cmd Remote.lnk"
  Delete "$SMPROGRAMS\Cmd Remote\Cmd Remote Control Panel.lnk"
  Delete "$SMPROGRAMS\Cmd Remote\Uninstall.lnk"
  RMDir "$SMPROGRAMS\Cmd Remote"
  Delete "$SMSTARTUP\Cmd Remote.lnk"
  Delete "$DESKTOP\Cmd Remote.lnk"
  Delete "$DESKTOP\Cmd Remote Control Panel.lnk"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CmdRemote"
  DeleteRegKey HKCU "${REGKEY}"
SectionEnd
